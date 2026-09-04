// End-to-end integration tests: real sockets on both ends.
//
// A fake Anthropic upstream (node:http) serves every response, a real
// @anthropic-ai/sdk client is pointed at it, and the proxy is served on its own
// ephemeral port via @hono/node-server. Requests are driven with the global
// `fetch` over loopback — so the full path
//     fetch → proxy → classify → SDK → fake upstream → response
// (headers, SSE, retry) is exercised for real, with zero calls to the real API.
//
// The routed cases use the injected-client seam (provider:'bedrock'), because
// handleMessages only honors an injected providerClient for bedrock/vertex — the
// anthropic provider builds a per-request client pinned to api.anthropic.com that
// can't be redirected to a fake upstream. That anthropic-specific branch (missing
// x-api-key ⇒ 401 before any upstream call) is covered by its own real-socket test
// below so the auth path Claude Code actually hits isn't left untested.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import Anthropic from '@anthropic-ai/sdk';
import { createProxyApp } from '../proxy/server.js';
import type { HandlerConfig } from '../proxy/handler.js';
import { readLifetimeStats, resetHistoryCache } from '../proxy/history.js';
import { DEFAULT_MODELS } from '../models.js';

// ── Fake Anthropic upstream ──────────────────────────────────────────────────

interface UpstreamCall {
  model: string;
  stream: boolean;
}

interface FakeUpstream {
  url: string;
  calls: UpstreamCall[];
  close: () => Promise<void>;
}

/**
 * Start a fake Anthropic `/v1/messages` server on an ephemeral port.
 * `truncateModels` makes the given models answer with `stop_reason: 'max_tokens'`
 * (and > 20 output tokens) so the router's truncation-retry path fires.
 * `streamAuthFail` answers every streaming request with a 401 JSON error.
 * `dropMidStream` sends the opening SSE events then destroys the socket.
 */
async function startFakeUpstream(
  opts: { truncateModels?: string[]; streamAuthFail?: boolean; dropMidStream?: boolean } = {},
): Promise<FakeUpstream> {
  const truncate = new Set(opts.truncateModels ?? []);
  const calls: UpstreamCall[] = [];

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
      res.writeHead(404).end();
      return;
    }

    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { model: string; stream?: boolean };
      const model = body.model;
      const isStream = body.stream === true;
      calls.push({ model, stream: isStream });

      const truncated = truncate.has(model);
      const stopReason = truncated ? 'max_tokens' : 'end_turn';
      const outputTokens = truncated ? 50 : 3;
      const text = `hello from ${model}`;

      if (isStream && opts.streamAuthFail) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(
          JSON.stringify({ error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
        );
        return;
      }

      if (isStream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (type: string, data: unknown) =>
          res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
        send('message_start', {
          type: 'message_start',
          message: {
            id: 'msg_fake',
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 5, output_tokens: 0 },
          },
        });
        send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        if (opts.dropMidStream) {
          // Abrupt socket death after the stream is underway. The small delay
          // lets the opening events flush so the proxy's primed first event
          // succeeds and its 200 is committed — otherwise the drop races the
          // first read and lands in the pre-stream phase instead.
          setTimeout(() => res.destroy(), 100);
          return;
        }
        send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
        send('content_block_stop', { type: 'content_block_stop', index: 0 });
        send('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } });
        send('message_stop', { type: 'message_stop' });
        res.end();
        return;
      }

      const message = {
        id: 'msg_fake',
        type: 'message',
        role: 'assistant',
        model,
        content: [{ type: 'text', text }],
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: outputTokens },
      };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ── Proxy under test, served on a real port ──────────────────────────────────

interface RunningProxy {
  base: string;
  close: () => void;
}

async function startProxy(upstream: FakeUpstream, overrides: Partial<HandlerConfig> = {}): Promise<RunningProxy> {
  // A real SDK client pointed at the fake upstream → real HTTP + real SSE parsing.
  const client = new Anthropic({ apiKey: 'sk-fake', baseURL: upstream.url });

  const config: HandlerConfig = {
    classifier: 'heuristic',
    defaultModel: DEFAULT_MODELS.sonnet,
    verbose: false,
    // provider:'bedrock' + forceRoute makes handleMessages use the injected
    // client and route even when the body pins a model (Claude Code always does).
    provider: 'bedrock',
    models: DEFAULT_MODELS,
    forceRoute: true,
    ...overrides,
  };

  const app = createProxyApp(config, client);
  // serve() binds asynchronously — wait for the listening callback so
  // server.address() is populated (it is null before the socket is bound).
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;

  return {
    base: `http://127.0.0.1:${port}`,
    close: () => server.close(),
  };
}

/** Start a fake upstream + proxy, registering both for teardown. */
async function setup(
  opts: {
    truncateModels?: string[];
    streamAuthFail?: boolean;
    dropMidStream?: boolean;
    config?: Partial<HandlerConfig>;
  } = {},
): Promise<{ upstream: FakeUpstream; base: string }> {
  const upstream = await startFakeUpstream(opts);
  after(() => upstream.close());
  const proxy = await startProxy(upstream, opts.config);
  after(() => proxy.close());
  return { upstream, base: proxy.base };
}

/**
 * Stand-in for the tool set every real Claude Code turn ships (165–217 tools
 * observed on the wire). Presence — not contents — is what separates a
 * coordinator agent turn from a tool-less meta-call for the sessionModel pin.
 */
const CODER_TOOLS = [
  { name: 'Read', description: 'read a file', input_schema: { type: 'object', properties: {} } },
  { name: 'Bash', description: 'run a command', input_schema: { type: 'object', properties: {} } },
];

function post(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function readSse(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('proxy end-to-end (real sockets, fake upstream)', () => {
  it('GET /health is reachable over the socket', async () => {
    const { base } = await setup();

    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; service: string };
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'claude-router-proxy');
  });

  it('/health counts every routed request, not the bounded window', async () => {
    const { base } = await setup();
    const before = ((await (await fetch(`${base}/health`)).json()) as { requests: number }).requests;

    const res = await post(base, {
      model: 'claude-opus-4-8',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'translate hello to French' }],
    });
    assert.equal(res.status, 200);

    const after = ((await (await fetch(`${base}/health`)).json()) as { requests: number }).requests;
    assert.equal(after, before + 1, 'the counter is monotonic per recorded event');
    const line = await (await fetch(`${base}/statusline`)).text();
    assert.match(line, new RegExp(`#${after}\\]$`), 'the statusline shows the same count');
  });

  it('routes a trivial prompt to haiku end-to-end', async () => {
    const { upstream, base } = await setup();

    const res = await post(base, {
      model: 'claude-opus-4-8', // client pins a model; forceRoute overrides it
      messages: [{ role: 'user', content: 'translate hello to French' }],
      max_tokens: 100,
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-router-tier'), 'haiku');
    assert.match(res.headers.get('x-router-reason') ?? '', /^single-turn:/, 'the deciding gate rides a header');
    assert.equal(res.headers.get('x-router-model'), DEFAULT_MODELS.haiku);
    assert.ok(Number.isFinite(Number(res.headers.get('x-router-cost-cents'))));

    const body = (await res.json()) as { content: { text: string }[] };
    assert.equal(body.content[0]!.text, `hello from ${DEFAULT_MODELS.haiku}`);

    // The routed model actually reached the upstream over the wire.
    assert.equal(upstream.calls.length, 1);
    assert.equal(upstream.calls[0]!.model, DEFAULT_MODELS.haiku);
  });

  it('routes a complex prompt to opus end-to-end', async () => {
    const { upstream, base } = await setup();

    const res = await post(base, {
      model: 'claude-haiku-4-5',
      messages: [
        {
          role: 'user',
          content:
            'architect and design a distributed system, evaluate tradeoffs, strategize about scaling and prove correctness',
        },
      ],
      max_tokens: 1000,
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-router-tier'), 'opus');
    assert.equal(upstream.calls.at(-1)!.model, DEFAULT_MODELS.opus);
  });

  it('pins the coordinator session to sessionModel when no x-claude-code-agent-id header', async () => {
    // The Claude Code main session sends no agent-id header. A trivial prompt that
    // WOULD route to haiku must be pinned to opus instead — and skip the classifier.
    const { upstream, base } = await setup({ config: { sessionModel: 'opus' } });

    const res = await post(base, {
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content: 'translate hello to French' }],
      tools: CODER_TOOLS,
      max_tokens: 100,
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-router-tier'), 'opus', 'coordinator pinned, not routed to haiku');
    assert.equal(res.headers.get('x-router-model'), DEFAULT_MODELS.opus);
    assert.equal(res.headers.get('x-router-classifier'), 'pinned', 'classifier bypassed');
    assert.equal(res.headers.get('x-router-reason'), 'session:coordinator-pinned', 'the pin is auditable from the client side');
    assert.equal(upstream.calls.length, 1, 'no extra classifier call');
    assert.equal(upstream.calls[0]!.model, DEFAULT_MODELS.opus, 'pinned model reached the wire');
  });

  it('pins the coordinator session on a streaming request too (Claude Code streams)', async () => {
    // Real Claude Code main-session requests are stream:true; the pin sits before
    // the stream/non-stream branch, so it must apply there as well.
    const { upstream, base } = await setup({ config: { sessionModel: 'opus' } });

    const res = await post(base, {
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content: 'translate hello to French' }],
      tools: CODER_TOOLS,
      max_tokens: 100,
      stream: true,
    });

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.equal(res.headers.get('x-router-tier'), 'opus');
    assert.equal(res.headers.get('x-router-classifier'), 'pinned');

    const sse = await readSse(res);
    assert.match(sse, new RegExp(`hello from ${DEFAULT_MODELS.opus}`));
    assert.equal(upstream.calls.at(-1)!.model, DEFAULT_MODELS.opus);
    assert.equal(upstream.calls.at(-1)!.stream, true);
  });

  it('routes subagent requests by evidence even when sessionModel is set', async () => {
    // Subagents carry x-claude-code-agent-id — they must NOT be pinned; the same
    // trivial prompt routes to haiku by evidence.
    const { upstream, base } = await setup({ config: { sessionModel: 'opus' } });

    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claude-code-agent-id': 'agent_abc123' },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'translate hello to French' }],
        max_tokens: 100,
      }),
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-router-tier'), 'haiku', 'subagent routed, not pinned');
    assert.equal(res.headers.get('x-router-classifier'), 'heuristic');
    assert.equal(upstream.calls.at(-1)!.model, DEFAULT_MODELS.haiku);
  });

  it('falls back to classification when sessionModel names an unknown tier', async () => {
    // A typo'd config value has no models[tier] entry — degrade to routing rather
    // than send model: undefined to the API.
    const { upstream, base } = await setup({ config: { sessionModel: 'opus-typo' as unknown as 'opus' } });

    const res = await post(base, {
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content: 'translate hello to French' }],
      tools: CODER_TOOLS,
      max_tokens: 100,
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-router-tier'), 'sonnet', 'bad pin ignored, request still routed');
    assert.equal(upstream.calls.at(-1)!.model, DEFAULT_MODELS.sonnet);
  });

  it('does not pin a tool-less Claude Code meta-call (session title / summary)', async () => {
    // The regression this guards: "no agent-id header" is not the same as "the
    // coordinator's agent turn". Claude Code's title/summary calls also arrive
    // without the header, carry no tools, and quote the conversation in
    // <session>…</session> with the real instruction after it. Measured against
    // live Claude Code v2.1.220: with --session-model opus these went to opus,
    // charging the top tier to name a session (29% of requests on the wire
    // corpus). They must keep routing by evidence.
    const { upstream, base } = await setup({ config: { sessionModel: 'opus' } });

    const res = await post(base, {
      model: 'claude-opus-4-8',
      messages: [
        {
          role: 'user',
          content:
            '<session>\nUser: refactor the auth module and add retries\nAssistant: done\n</session>\n\n' +
            'Write a 5-word title for the conversation above.',
        },
      ],
      max_tokens: 100,
    });

    assert.equal(res.status, 200);
    // The invariant is "the classifier decided this, not the pin" — asserted
    // positively so it can't pass by the header being absent. Which tier the
    // evidence then picks is routing.ts's business, so only "not the pinned
    // tier" is pinned here.
    assert.equal(res.headers.get('x-router-classifier'), 'heuristic', 'classifier must still run');
    assert.notEqual(res.headers.get('x-router-tier'), 'opus', 'meta-call must not reach the pinned tier');
    assert.notEqual(upstream.calls.at(-1)!.model, DEFAULT_MODELS.opus);
  });

  it('still pins the coordinator when a subagent header is absent and tools are present', async () => {
    // The other side of the same boundary: a real coordinator turn mid-tool-loop
    // (tool_result last, tools defined) would route to sonnet by evidence — the
    // pin is what keeps it on opus.
    const { upstream, base } = await setup({ config: { sessionModel: 'opus' } });

    const res = await post(base, {
      model: 'claude-opus-4-8',
      messages: [
        { role: 'user', content: 'read hello.js' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] },
      ],
      tools: CODER_TOOLS,
      max_tokens: 100,
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-router-tier'), 'opus');
    assert.equal(res.headers.get('x-router-classifier'), 'pinned');
    assert.equal(upstream.calls.at(-1)!.model, DEFAULT_MODELS.opus);
  });

  it('escalates haiku→sonnet on truncation, end-to-end', async () => {
    const { upstream, base } = await setup({ truncateModels: [DEFAULT_MODELS.haiku] });

    const res = await post(base, {
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content: 'translate hello to French' }],
      max_tokens: 100,
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-router-retried'), 'true');
    assert.equal(res.headers.get('x-router-tier'), 'sonnet');

    // Two real upstream calls: haiku (truncated) then sonnet.
    assert.equal(upstream.calls.length, 2);
    assert.equal(upstream.calls[0]!.model, DEFAULT_MODELS.haiku);
    assert.equal(upstream.calls[1]!.model, DEFAULT_MODELS.sonnet);
  });

  it('streams a routed response as SSE through both hops', async () => {
    const { upstream, base } = await setup();

    const res = await post(base, {
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content: 'translate hello to French' }],
      max_tokens: 100,
      stream: true,
    });

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.equal(res.headers.get('x-router-tier'), 'haiku');

    const sse = await readSse(res);
    assert.match(sse, /event: message_stop/);
    assert.match(sse, new RegExp(`hello from ${DEFAULT_MODELS.haiku}`));

    assert.equal(upstream.calls.length, 1);
    assert.equal(upstream.calls[0]!.model, DEFAULT_MODELS.haiku);
    assert.equal(upstream.calls[0]!.stream, true);
  });

  it('a pre-stream auth failure returns HTTP 401, not a 200 SSE error frame', async () => {
    const { base } = await setup({ streamAuthFail: true });

    const res = await post(base, {
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content: 'translate hello to French' }],
      max_tokens: 100,
      stream: true,
    });

    // The first stream event is awaited before headers are committed, so the
    // upstream 401 maps to a real 401 — same contract as the non-streaming path.
    assert.equal(res.status, 401);
    assert.doesNotMatch(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const body = (await res.json()) as { error: { type: string } };
    assert.equal(body.error.type, 'api_error');
  });

  it('a mid-stream failure emits an SSE error frame and is recorded as an error', async () => {
    const historyFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'claude-router-test-')),
      'history.jsonl',
    );
    const { base } = await setup({ dropMidStream: true, config: { historyFile } });

    const res = await post(base, {
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content: 'translate hello to French' }],
      max_tokens: 100,
      stream: true,
    });

    // Headers were already committed when the upstream died — 200 is unavoidable;
    // the SSE error frame is the in-band signal.
    assert.equal(res.status, 200);
    const sse = await readSse(res);
    assert.match(sse, /event: error/);

    // The failure must not vanish from the proxy's books.
    resetHistoryCache();
    const stats = readLifetimeStats(historyFile);
    assert.equal(stats.errors, 1);
    assert.equal(stats.requests, 0, 'an errored stream is not a completed request');
  });

  it('anthropic provider without credentials returns 401 over the socket', async () => {
    // The anthropic provider builds a per-request client from x-api-key/Bearer —
    // the auth path Claude Code actually uses. With no injected client and no
    // credentials, handleMessages must 401 before touching any upstream. Driven
    // over a real socket so the whole request pipeline (not just app.request) runs.
    const app = createProxyApp(
      { classifier: 'heuristic', defaultModel: DEFAULT_MODELS.sonnet, verbose: false, provider: 'anthropic', models: DEFAULT_MODELS, forceRoute: false },
      null,
    );
    const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
    });
    after(() => server.close());
    const port = (server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 }),
    });

    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: { type: string } };
    assert.equal(body.error.type, 'authentication_error');
  });

  // ── Savings baseline ───────────────────────────────────────────────────────
  //
  // The baseline is what the request would have cost WITHOUT the router, so it
  // is the model the client pinned — not `defaultModel`. Claude Code pins a
  // model on every request, so a fixed sonnet baseline priced opus-pinned
  // traffic against sonnet and reported a loss on runs that actually saved.

  const savedCents = (res: Response) => Number(res.headers.get('x-router-saved-cents'));

  it('prices savings against the model the client pinned, not defaultModel', async () => {
    // Client asked for opus, evidence routed it to haiku: the saving is real and
    // must be positive. Against the old defaultModel (sonnet) baseline this same
    // call still showed a saving, so the assertion that separates the two is the
    // magnitude — it must exceed what a sonnet baseline could produce.
    const { base } = await setup();

    const res = await post(base, {
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content: 'translate hello to French' }],
      max_tokens: 100,
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-router-tier'), 'haiku');

    const cost = Number(res.headers.get('x-router-cost-cents'));
    // opus is 5x haiku on input and output, sonnet only 3x — a sonnet baseline
    // cannot produce a saving this large relative to the actual cost.
    assert.ok(savedCents(res) > cost * 3, `saving ${savedCents(res)} priced against opus, not sonnet`);
  });

  it('reports zero saved when the routed tier is the model the client asked for', async () => {
    // The coordinator pin sends opus for an opus-pinned request: nothing was
    // saved and nothing was lost. Previously this read as a *loss* against the
    // sonnet baseline, which is what made the dashboard show negative totals on
    // a session that was actually 21% cheaper than unrouted.
    const { base } = await setup({ config: { sessionModel: 'opus' } });

    const res = await post(base, {
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content: 'translate hello to French' }],
      tools: CODER_TOOLS,
      max_tokens: 100,
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-router-tier'), 'opus', 'pinned to the requested model');
    assert.equal(savedCents(res), 0, 'same model both sides — exactly zero, not negative');
  });

  it('reports a negative saving when routing lands above what the client asked for', async () => {
    // Honest in the other direction too: asked for haiku, escalated to opus.
    // A clamp to zero here would hide the router costing money.
    const { base } = await setup({ config: { sessionModel: 'opus' } });

    const res = await post(base, {
      model: DEFAULT_MODELS.haiku,
      messages: [{ role: 'user', content: 'translate hello to French' }],
      tools: CODER_TOOLS,
      max_tokens: 100,
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-router-tier'), 'opus');
    assert.ok(savedCents(res) < 0, `overspend must stay visible, got ${savedCents(res)}`);
  });

  it('falls back to defaultModel when the client pinned nothing usable', async () => {
    // "auto" is an explicit "you pick" — there is no client intent to price
    // against, so the configured baseline stands. Same for an unpriced model ID,
    // where a baseline would be invented rather than measured; the event must
    // still count as priced rather than being voided.
    const { base } = await setup();

    for (const model of ['auto', 'some-unlisted-model-v9']) {
      const res = await post(base, {
        model,
        messages: [{ role: 'user', content: 'translate hello to French' }],
        max_tokens: 100,
      });

      assert.equal(res.status, 200, model);
      assert.equal(res.headers.get('x-router-tier'), 'haiku', model);
      // haiku against the sonnet default: a saving, but a modest one — nothing
      // like the opus-baseline figure asserted above.
      assert.ok(savedCents(res) > 0, `${model}: baseline still applied`);
      assert.ok(
        savedCents(res) < Number(res.headers.get('x-router-cost-cents')) * 3,
        `${model}: priced against sonnet, not the unusable model`,
      );
    }
  });
});
