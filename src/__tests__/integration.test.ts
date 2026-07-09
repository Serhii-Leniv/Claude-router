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
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import Anthropic from '@anthropic-ai/sdk';
import { createProxyApp } from '../proxy/server.js';
import type { HandlerConfig } from '../proxy/handler.js';
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
 */
async function startFakeUpstream(opts: { truncateModels?: string[] } = {}): Promise<FakeUpstream> {
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
async function setup(opts: { truncateModels?: string[]; config?: Partial<HandlerConfig> } = {}): Promise<{ upstream: FakeUpstream; base: string }> {
  const upstream = await startFakeUpstream({ truncateModels: opts.truncateModels });
  after(() => upstream.close());
  const proxy = await startProxy(upstream, opts.config);
  after(() => proxy.close());
  return { upstream, base: proxy.base };
}

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

  it('routes a trivial prompt to haiku end-to-end', async () => {
    const { upstream, base } = await setup();

    const res = await post(base, {
      model: 'claude-opus-4-8', // client pins a model; forceRoute overrides it
      messages: [{ role: 'user', content: 'translate hello to French' }],
      max_tokens: 100,
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-router-tier'), 'haiku');
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
});
