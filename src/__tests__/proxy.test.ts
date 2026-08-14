import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { createProxyApp } from '../proxy/server.js';
import { routeHistory, boundHistory, MAX_HISTORY, getAnthropicClient, clearClientCache } from '../proxy/handler.js';
import { renderDashboard } from '../proxy/dashboard.js';
import type { RouteEvent } from '../proxy/handler.js';

import { DEFAULT_MODELS } from '../models.js';

// A couple of passthrough tests make real outbound calls to api.anthropic.com.
// They're skipped by default (flaky/offline-hostile in CI) and opt-in via
// RUN_NETWORK_TESTS=1. `skip` takes a reason string when the flag is unset.
const NETWORK_SKIP: string | false = process.env['RUN_NETWORK_TESTS'] === '1'
  ? false
  : 'network test — set RUN_NETWORK_TESTS=1 to run (reaches api.anthropic.com)';

function statuslineEvent(tier: RouteEvent['tier'], i = 0): RouteEvent {
  return {
    timestamp: `2026-07-25T10:00:0${i}.000Z`,
    tier,
    model: `m${i}`,
    costCents: 1,
    savedCents: 0,
    confidence: 1,
    classifier: 'heuristic',
    retried: false,
    retryReason: null,
    inputTokens: 10,
    outputTokens: 10,
  };
}

describe('boundHistory — amortized trim', () => {
  it('does not touch the array below the high-water mark', () => {
    const history: RouteEvent[] = [];
    for (let i = 0; i < MAX_HISTORY + 99; i++) {
      history.push(statuslineEvent('sonnet', i));
      boundHistory(history);
    }
    assert.equal(history.length, MAX_HISTORY + 99, 'trimming early would cost an O(n) move per event');
  });

  it('trims a whole batch at the mark, keeping the newest events last', () => {
    const history: RouteEvent[] = [];
    for (let i = 0; i < MAX_HISTORY + 100; i++) {
      history.push(statuslineEvent('sonnet', i));
      boundHistory(history);
    }
    assert.equal(history.length, MAX_HISTORY);
    assert.equal(history[0]!.model, 'm100', 'the oldest batch is the one dropped');
    assert.equal(history[history.length - 1]!.model, `m${MAX_HISTORY + 99}`, 'newest event stays last');
  });

  it('stays bounded under sustained traffic', () => {
    const history: RouteEvent[] = [];
    for (let i = 0; i < 5000; i++) {
      history.push(statuslineEvent('sonnet', i));
      boundHistory(history);
    }
    assert.ok(history.length >= MAX_HISTORY, 'never drops below the retention target');
    assert.ok(history.length < MAX_HISTORY + 100, 'overshoot is capped at one batch');
    assert.equal(history[history.length - 1]!.model, 'm4999');
  });
});

describe('getAnthropicClient — per-credential cache', () => {
  it('returns the same instance for the same api key', () => {
    clearClientCache();
    const a = getAnthropicClient('sk-test-1', null);
    const b = getAnthropicClient('sk-test-1', null);
    assert.equal(a, b);
  });

  it('returns different instances for different credentials', () => {
    clearClientCache();
    const a = getAnthropicClient('sk-test-1', null);
    const b = getAnthropicClient('sk-test-2', null);
    const c = getAnthropicClient(undefined, 'bearer-token');
    assert.notEqual(a, b);
    assert.notEqual(a, c);
  });

  it('evicts old clients past the cache cap', () => {
    clearClientCache();
    const first = getAnthropicClient('sk-evict-0', null);
    for (let i = 1; i <= 100; i++) {
      getAnthropicClient(`sk-evict-${i}`, null);
    }
    const firstAgain = getAnthropicClient('sk-evict-0', null);
    assert.notEqual(first, firstAgain, 'first client should have been evicted');
    clearClientCache();
  });

  it('pins the upstream to api.anthropic.com even when ANTHROPIC_BASE_URL points at the proxy', () => {
    // Otherwise the SDK inherits ANTHROPIC_BASE_URL (the proxy's own address) and
    // the proxy calls itself in an infinite loop.
    const prev = process.env['ANTHROPIC_BASE_URL'];
    process.env['ANTHROPIC_BASE_URL'] = 'http://localhost:4000';
    clearClientCache();
    const client = getAnthropicClient('sk-loop-test', null) as unknown as { baseURL: string };
    assert.equal(client.baseURL.replace(/\/$/, ''), 'https://api.anthropic.com');
    clearClientCache();
    if (prev === undefined) delete process.env['ANTHROPIC_BASE_URL'];
    else process.env['ANTHROPIC_BASE_URL'] = prev;
  });
});

describe('createProxyApp', () => {
  const app = createProxyApp({
    classifier: 'heuristic',
    defaultModel: 'claude-sonnet-4-6',
    verbose: false,
    provider: 'anthropic',
    models: DEFAULT_MODELS,
    forceRoute: false,
  });

  it('GET /health returns ok', async () => {
    const res = await app.request('/health');
    assert.equal(res.status, 200);
    const body = await res.json() as Record<string, unknown>;
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'claude-router-proxy');
    assert.equal(body.classifier, 'heuristic');
  });

  it('GET /statusline returns preformatted text/plain for the shell statusline', async () => {
    // Seeds the history rather than asserting a loose pattern: the original
    // version needed a non-null lastTier and got one only because an earlier
    // describe had already routed something into the module-global array.
    routeHistory.length = 0;
    try {
      const res = await app.request('/statusline');
      assert.equal(res.status, 200);
      assert.ok(res.headers.get('content-type')?.startsWith('text/plain'));
      assert.equal(await res.text(), '[auto:ready #0]', 'reads "ready" before any traffic');

      routeHistory.push(statuslineEvent('sonnet'));
      assert.equal(await (await app.request('/statusline')).text(), '[auto:sonnet #1]');
    } finally {
      routeHistory.length = 0;
    }
  });

  it('does not serve CORS headers — cross-origin browser reads stay blocked', async () => {
    // Pins the security posture: a wildcard CORS header would let any webpage
    // in the operator's browser read responses from this local proxy.
    const res = await app.request('/health', { headers: { origin: 'https://evil.example' } });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });

  it('GET /dashboard returns HTML', async () => {
    const res = await app.request('/dashboard');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('<!DOCTYPE html>'));
    assert.ok(html.includes('claude-router dashboard'));
  });

  it('POST /v1/messages without api key returns 401', async () => {
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 }),
    });
    assert.equal(res.status, 401);
    const body = await res.json() as { error: { type: string } };
    assert.equal(body.error.type, 'authentication_error');
  });

  // No unmatched-path test in this suite. Unmatched paths now forward to the
  // upstream, and nothing here stubs fetch — probing one would send a real
  // request to api.anthropic.com from every cell of the CI matrix. That
  // behaviour is covered in 'catch-all passthrough (hermetic — stubbed
  // upstream)', which stubs the fetch and pins the upstream at loopback.
});

describe('renderDashboard', () => {
  it('renders empty state', () => {
    const html = renderDashboard([]);
    assert.ok(html.includes('No requests yet'));
    assert.ok(html.includes('Session Requests'));
    assert.ok(html.includes('0'));
    assert.ok(!html.includes('Lifetime Saved'), 'no lifetime card without history');
  });

  it('renders lifetime stats when provided', () => {
    const html = renderDashboard([], {
      requests: 42,
      costCents: 100,
      savedCents: 4700,
      retried: 1,
      errors: 0,
      tiers: { haiku: 40, opus: 2 },
      byDay: {},
      unpricedModels: {},
    });
    assert.ok(html.includes('Lifetime Saved'));
    assert.ok(html.includes('$47.00'));
    assert.ok(html.includes('42'));
  });

  it('renders with data', () => {
    const events: RouteEvent[] = [
      {
        timestamp: '2026-05-01T12:00:00.000Z',
        tier: 'haiku',
        model: 'claude-haiku-4-5-20251001',
        costCents: 0.05,
        savedCents: 0.15,
        confidence: 0.9,
        classifier: 'heuristic',
        retried: false,
        retryReason: null,
        inputTokens: 100,
        outputTokens: 50,
      },
      {
        timestamp: '2026-05-01T12:01:00.000Z',
        tier: 'sonnet',
        model: 'claude-sonnet-4-6',
        costCents: 0.45,
        savedCents: 0,
        confidence: 0.7,
        classifier: 'heuristic',
        retried: true,
        retryReason: 'truncation',
        inputTokens: 500,
        outputTokens: 200,
      },
    ];
    const html = renderDashboard(events);
    assert.ok(html.includes('haiku'));
    assert.ok(html.includes('sonnet'));
    assert.ok(html.includes('truncation'));
    assert.ok(!html.includes('No requests yet'));
  });

  it('escapes HTML in model name', () => {
    const events: RouteEvent[] = [
      {
        timestamp: '2026-05-01T12:00:00.000Z',
        tier: 'haiku',
        model: '<script>alert(1)</script>',
        costCents: 0,
        savedCents: 0,
        confidence: 0.5,
        classifier: 'heuristic',
        retried: false,
        retryReason: null,
        inputTokens: 0,
        outputTokens: 0,
      },
    ];
    const html = renderDashboard(events);
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;'));
  });

  it('escapes HTML in retryReason', () => {
    const events: RouteEvent[] = [
      {
        timestamp: '2026-05-01T12:00:00.000Z',
        tier: 'sonnet',
        model: 'claude-sonnet-4-6',
        costCents: 0,
        savedCents: 0,
        confidence: 0.5,
        classifier: 'heuristic',
        retried: true,
        retryReason: '<img onerror=alert(1)>',
        inputTokens: 0,
        outputTokens: 0,
      },
    ];
    const html = renderDashboard(events);
    assert.ok(!html.includes('<img'));
    assert.ok(html.includes('&lt;img'));
  });

  it('renders with many events (shows last 50)', () => {
    const events: RouteEvent[] = Array.from({ length: 60 }, (_, i) => ({
      timestamp: `2026-05-01T12:${String(i).padStart(2, '0')}:00.000Z`,
      tier: 'haiku' as const,
      model: 'claude-haiku-4-5-20251001',
      costCents: 0.01,
      savedCents: 0.05,
      confidence: 0.9,
      classifier: 'heuristic',
      retried: false,
      retryReason: null,
      inputTokens: 10,
      outputTokens: 5,
    }));
    const html = renderDashboard(events);
    assert.ok(html.includes('60')); // total requests count
    assert.ok(html.includes('Showing last 50 of 60'));
    assert.ok(!html.includes('No requests yet'));
  });

  it('handles zero-cost events', () => {
    const events: RouteEvent[] = [
      {
        timestamp: '2026-05-01T12:00:00.000Z',
        tier: 'haiku',
        model: 'claude-haiku-4-5-20251001',
        costCents: 0,
        savedCents: 0,
        confidence: 0.9,
        classifier: 'heuristic',
        retried: false,
        retryReason: null,
        inputTokens: 0,
        outputTokens: 0,
      },
    ];
    const html = renderDashboard(events);
    assert.ok(html.includes('$0.0000'));
    assert.ok(!html.includes('NaN'));
  });

  it('handles negative savedCents', () => {
    const events: RouteEvent[] = [
      {
        timestamp: '2026-05-01T12:00:00.000Z',
        tier: 'opus',
        model: 'claude-opus-4-6',
        costCents: 5.0,
        savedCents: -3.0,
        confidence: 0.85,
        classifier: 'heuristic',
        retried: false,
        retryReason: null,
        inputTokens: 200,
        outputTokens: 100,
      },
    ];
    const html = renderDashboard(events);
    assert.ok(html.includes('negative'), 'should have negative class for negative savings');
  });

  it('handles passthrough tier', () => {
    const events: RouteEvent[] = [
      {
        timestamp: '2026-05-01T12:00:00.000Z',
        tier: 'passthrough',
        model: 'claude-sonnet-4-6',
        costCents: 0,
        savedCents: 0,
        confidence: 0,
        classifier: 'none',
        retried: false,
        retryReason: null,
        inputTokens: 0,
        outputTokens: 0,
      },
    ];
    const html = renderDashboard(events);
    assert.ok(html.includes('passthrough'));
  });
});

describe('proxy passthrough', () => {
  const app = createProxyApp({
    classifier: 'heuristic',
    defaultModel: 'claude-sonnet-4-6',
    verbose: false,
    provider: 'anthropic',
    models: DEFAULT_MODELS,
    forceRoute: false,
  });

  it('POST /v1/messages with model=auto without key returns 401', async () => {
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 }),
    });
    assert.equal(res.status, 401);
  });

  it('POST /v1/messages/count_tokens forwards to Anthropic instead of 404', { skip: NETWORK_SKIP }, async () => {
    // Claude Code / the VS Code extension call count_tokens; a 404 breaks them.
    const res = await app.request('/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test-fake' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.notEqual(res.status, 404, 'count_tokens must reach the origin, not 404 locally');
    assert.equal(res.headers.get('x-router-tier'), 'passthrough');
  });

  it('count_tokens on a non-anthropic provider 404s with a clear message', async () => {
    const bedrockApp = createProxyApp({
      classifier: 'heuristic',
      defaultModel: 'claude-sonnet-4-6',
      verbose: false,
      provider: 'bedrock',
      models: DEFAULT_MODELS,
      forceRoute: false,
    });
    const res = await bedrockApp.request('/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    assert.equal(res.status, 404);
    const body = await res.json() as { error: { type: string } };
    assert.equal(body.error.type, 'not_found_error');
  });

  it('POST /v1/messages with explicit model and key passes through to Anthropic', { skip: NETWORK_SKIP }, async () => {
    // With explicit model + key, passthrough forwards to real Anthropic API
    // Fake key → Anthropic returns 401 with its own error format (not ours)
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test-fake' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 }),
    });
    // Passthrough should set x-router-tier header
    assert.equal(res.headers.get('x-router-tier'), 'passthrough');
    // Anthropic rejects invalid key with 401
    assert.equal(res.status, 401);
  });
});

describe('proxy passthrough (hermetic — stubbed upstream)', () => {
  // The RUN_NETWORK_TESTS gate above keeps CI off api.anthropic.com, but the
  // *routing* guarantees it verified are still worth guarding in CI: count_tokens
  // must reach the passthrough route (not a local 404), and explicit-model
  // requests must forward with x-router-tier: passthrough. We assert both without
  // the network by stubbing the single upstream fetch the handler makes.
  const app = createProxyApp({
    classifier: 'heuristic',
    defaultModel: 'claude-sonnet-4-6',
    verbose: false,
    provider: 'anthropic',
    models: DEFAULT_MODELS,
    forceRoute: false,
  });

  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  function stubUpstream(status = 200, body: unknown = { ok: true }) {
    let seen: { url: string; method: string } | undefined;
    globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
      seen = { url: String(input), method: init?.method ?? 'GET' };
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    return () => seen;
  }

  it('count_tokens reaches the passthrough route (not a local 404) and tags the tier', async () => {
    const captured = stubUpstream(200, { input_tokens: 42 });
    const res = await app.request('/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test-fake' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.notEqual(res.status, 404, 'count_tokens must reach the origin, not 404 locally');
    assert.equal(res.headers.get('x-router-tier'), 'passthrough');
    assert.match(captured()!.url, /\/v1\/messages\/count_tokens$/, 'forwards to the count_tokens endpoint');
  });

  it('explicit model + key forwards with x-router-tier: passthrough (no routing)', async () => {
    const captured = stubUpstream(200, { id: 'msg', type: 'message' });
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test-fake' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-router-tier'), 'passthrough');
    assert.match(captured()!.url, /\/v1\/messages$/, 'forwards to the messages endpoint');
  });

  it('explicit-model passthrough relays the anthropic-beta header (regression: G1)', async () => {
    // proxyPassthrough previously built its own header set and dropped
    // anthropic-beta, so a beta-dependent request (context-management) 400s
    // upstream on the non-force-route path. It must forward it like the routed
    // path and handlePassthrough do.
    let seenHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_input: unknown, init?: { headers?: Record<string, string> }) => {
      seenHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ id: 'msg', type: 'message' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'sk-test-fake',
        'anthropic-beta': 'context-management-2025-06-27',
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-router-tier'), 'passthrough');
    assert.equal(seenHeaders['anthropic-beta'], 'context-management-2025-06-27');
  });
});

describe('catch-all passthrough (hermetic — stubbed upstream)', () => {
  // Everything the router does not serve itself belongs to the upstream API, not
  // only the paths under /v1: Claude Code probes `HEAD /api/hello` on startup and
  // also calls /api/organizations. Answering those with a local 404 invents a
  // failure the origin does not have.
  //
  // Hermetic twice over: `stubUpstream` replaces the single fetch the handler
  // makes, and the app is pinned to an unroutable loopback upstream, so a stub
  // that failed to install dies on connect instead of reaching a real vendor host.
  const app = createProxyApp({
    classifier: 'heuristic',
    defaultModel: 'claude-sonnet-4-6',
    verbose: false,
    provider: 'anthropic',
    models: DEFAULT_MODELS,
    forceRoute: false,
    upstream: 'http://127.0.0.1:1',
  });

  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  function stubUpstream(status = 200, body: unknown = { ok: true }) {
    let seen: { url: string; method: string; body?: string } | undefined;
    globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
      seen = { url: String(input), method: init?.method ?? 'GET', body: init?.body };
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    return () => seen;
  }

  it('HEAD /api/hello forwards upstream instead of 404ing locally', async () => {
    const captured = stubUpstream(200, {});
    const res = await app.request('/api/hello', { method: 'HEAD' });
    assert.notEqual(res.status, 404, 'Claude Code probes this on startup and the origin serves it');
    assert.equal(res.headers.get('x-router-tier'), 'passthrough');
    assert.equal(captured()!.method, 'HEAD', 'the method is forwarded verbatim, not coerced to GET');
    assert.match(captured()!.url, /\/api\/hello$/);
  });

  it('forwards any unrouted path, query string intact', async () => {
    const captured = stubUpstream(200, { ok: true });
    const res = await app.request('/some/unrouted/path?limit=1');
    assert.notEqual(res.status, 404, 'the invariant is every unmatched path, not just /api/hello');
    assert.equal(res.headers.get('x-router-tier'), 'passthrough');
    assert.match(captured()!.url, /\/some\/unrouted\/path\?limit=1$/);
  });

  it('forwards an unrouted POST with its body', async () => {
    const captured = stubUpstream(200, { ok: true });
    const res = await app.request('/api/organizations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    assert.notEqual(res.status, 404);
    assert.equal(captured()!.method, 'POST');
    assert.equal(captured()!.body, '{"hello":"world"}', 'the request body survives the hop');
  });

  it('answers the routers own endpoints locally — they win over the catch-all', async () => {
    const captured = stubUpstream(200, { ok: true });
    const res = await app.request('/health');
    assert.equal(res.status, 200);
    assert.equal((await res.json() as { service: string }).service, 'claude-router-proxy');
    assert.equal(captured(), undefined, '/health is answered here, never forwarded');
  });

  it('still 404s an unrouted path on a non-anthropic provider', async () => {
    // bedrock/vertex have no HTTP passthrough target, so the catch-all must not
    // turn an unknown path into an outbound call there.
    const bedrockApp = createProxyApp({
      classifier: 'heuristic',
      defaultModel: 'claude-sonnet-4-6',
      verbose: false,
      provider: 'bedrock',
      models: DEFAULT_MODELS,
      forceRoute: false,
      upstream: 'http://127.0.0.1:1',
    });
    const captured = stubUpstream(200, { ok: true });
    const res = await bedrockApp.request('/api/hello', { method: 'HEAD' });
    assert.equal(res.status, 404);
    assert.equal(captured(), undefined, 'no upstream to forward to');
  });
});
describe('the router surface is reserved on every method (hermetic — stubbed upstream)', () => {
  // Route ordering protects each of the router's own paths only for the method it
  // registers: `GET /dashboard` matches its route, `POST /dashboard` does not — it
  // falls through to the catch-all and handlePassthrough forwards it to the origin
  // with the operator's x-api-key attached. There is no CORS, so a webpage cannot
  // read the reply, but a cross-site form POST is a simple request and still
  // reaches the proxy. These paths are ours on every method: the wrong method is a
  // 405 from us, never a hop to the origin carrying the operator's credentials.
  //
  // Hermetic twice over, like the catch-all suite above: `stubUpstream` replaces
  // the single fetch the handler makes, and the app is pinned to an unroutable
  // loopback upstream, so a stub that failed to install dies on connect instead of
  // reaching a real vendor host.
  const ROUTER_SURFACE = ['/health', '/statusline', '/api/last-route', '/dashboard'];

  const app = createProxyApp({
    classifier: 'heuristic',
    defaultModel: 'claude-sonnet-4-6',
    verbose: false,
    provider: 'anthropic',
    models: DEFAULT_MODELS,
    forceRoute: false,
    upstream: 'http://127.0.0.1:1',
  });

  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  function stubUpstream() {
    let seen: { url: string; method: string } | undefined;
    globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
      seen = { url: String(input), method: init?.method ?? 'GET' };
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    return () => seen;
  }

  it('answers 405 to POST on every router path and forwards none of them', async () => {
    // One loop over the surface, not one case per path: the invariant is "these
    // paths are ours", not "this one path 405s on this one method".
    const observed: { path: string; status: number; forwardedUpstream: boolean }[] = [];
    for (const path of ROUTER_SURFACE) {
      const captured = stubUpstream();
      const res = await app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-OPERATOR-SECRET' },
        body: JSON.stringify({ hello: 'world' }),
      });
      observed.push({ path, status: res.status, forwardedUpstream: captured() !== undefined });
    }
    assert.deepEqual(
      observed,
      ROUTER_SURFACE.map((path) => ({ path, status: 405, forwardedUpstream: false })),
      'a router path reached by an unregistered method is a 405 here, never a forwarded request',
    );
  });

  it('still answers GET /dashboard locally', async () => {
    // The reservation must not cost the registered method its own route.
    const captured = stubUpstream();
    const res = await app.request('/dashboard');
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes('claude-router dashboard'));
    assert.equal(captured(), undefined, '/dashboard is answered here, never forwarded');
  });

  it('still forwards HEAD /api/hello, which is not ours', async () => {
    // The reservation covers the router's own paths only; everything else still
    // belongs to the origin, on every method.
    const captured = stubUpstream();
    const res = await app.request('/api/hello', { method: 'HEAD' });
    assert.notEqual(res.status, 404, 'Claude Code probes this on startup and the origin serves it');
    assert.equal(res.headers.get('x-router-tier'), 'passthrough');
    assert.equal(captured()!.method, 'HEAD');
    assert.match(captured()!.url, /\/api\/hello$/);
  });
});

describe('proxy parameter normalization', () => {
  // Inject a mock client via the provider path so we can inspect the exact params
  // that reach messages.create. A Claude-Code-style body (adaptive thinking +
  // effort) routed to Haiku 4.5 used to 400 — the router must strip those.
  it('strips adaptive thinking + effort when routing to haiku', async () => {
    let captured: Record<string, unknown> | undefined;
    const mockClient = {
      messages: {
        create: async (params: Record<string, unknown>) => {
          captured = params;
          return {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: params.model,
            content: [{ type: 'text', text: 'hello there' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 5, output_tokens: 3 },
          };
        },
      },
    };

    const app = createProxyApp(
      {
        classifier: 'heuristic',
        defaultModel: DEFAULT_MODELS.sonnet,
        verbose: false,
        provider: 'bedrock',
        models: DEFAULT_MODELS,
        forceRoute: true,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockClient as any,
    );

    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4-8', // client pins a model; --force-route overrides it
        // Short, single-turn, mechanical transform — the only shape that clears
        // the conjunctive haiku gate. ("hi" no longer does: absence of
        // complexity is not evidence of simplicity.)
        messages: [{ role: 'user', content: 'translate this to French: hello' }],
        max_tokens: 10,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
      }),
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-router-tier'), 'haiku');
    assert.ok(captured, 'messages.create should have been called');
    assert.equal(captured!.model, DEFAULT_MODELS.haiku);
    assert.ok(!('thinking' in captured!), 'adaptive thinking must be stripped for Haiku');
    assert.ok(!('output_config' in captured!), 'effort must be stripped for Haiku');
    assert.deepEqual(captured!.messages, [
      { role: 'user', content: 'translate this to French: hello' },
    ]);
  });
});

describe('proxy resilience to responses missing usage', () => {
  it('returns 200 (does not crash) when the response has no usage field', async () => {
    const app = createProxyApp(
      { classifier: 'heuristic', defaultModel: DEFAULT_MODELS.sonnet, verbose: false, provider: 'bedrock', models: DEFAULT_MODELS, forceRoute: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { messages: { create: async () => ({ id: 'm', type: 'message', role: 'assistant', model: 'x', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null }) } } as any,
    );
    const res = await app.request('/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 }),
    });
    assert.equal(res.status, 200);
  });
});

describe('proxy non-streaming timeout guard', () => {
  function appWithCreate(create: (p: Record<string, unknown>, o?: Record<string, unknown>) => unknown) {
    return createProxyApp(
      { classifier: 'heuristic', defaultModel: DEFAULT_MODELS.sonnet, verbose: false, provider: 'bedrock', models: DEFAULT_MODELS, forceRoute: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { messages: { create } } as any,
    );
  }

  it('gives the per-credential client a timeout above the SDK 10-min non-streaming ceiling', () => {
    clearClientCache();
    const client = getAnthropicClient('sk-timeout-test', null) as unknown as { timeout: number };
    assert.equal(typeof client.timeout, 'number');
    assert.ok(client.timeout > 10 * 60 * 1000, 'client timeout must exceed the 10-min guard ceiling');
    clearClientCache();
  });

  it('returns a clean error (not an uncaught 500) when the SDK throws a non-API AnthropicError', async () => {
    const app = appWithCreate(() => { throw new Anthropic.AnthropicError('Streaming is strongly recommended \u2026'); });
    const res = await app.request('/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 }),
    });
    assert.equal(res.status, 500);
    const body = await res.json() as { error?: { type?: string } };
    assert.ok(body.error?.type, 'error body must be structured JSON');
  });
});

describe('proxy forwards anthropic-beta on routed calls', () => {
  it('relays the anthropic-beta header to messages.create', async () => {
    let opts: { headers?: Record<string, string> } | undefined;
    const app = createProxyApp(
      { classifier: 'heuristic', defaultModel: DEFAULT_MODELS.sonnet, verbose: false, provider: 'bedrock', models: DEFAULT_MODELS, forceRoute: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { messages: { create: async (_p: Record<string, unknown>, o: { headers?: Record<string, string> }) => { opts = o; return { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }; } } } as any,
    );
    const res = await app.request('/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-beta': 'context-management-2025-06-27' },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 }),
    });
    assert.equal(res.status, 200);
    assert.equal(opts?.headers?.['anthropic-beta'], 'context-management-2025-06-27');
  });
});

describe('getAnthropicClient — upstream override', () => {
  it('defaults to the real API', () => {
    clearClientCache();
    const c = getAnthropicClient('sk-up-default', null) as unknown as { baseURL: string };
    assert.equal(c.baseURL, 'https://api.anthropic.com');
  });

  it('honours an explicit upstream', () => {
    clearClientCache();
    const c = getAnthropicClient('sk-up-stub', null, 'http://127.0.0.1:9999') as unknown as { baseURL: string };
    assert.equal(c.baseURL, 'http://127.0.0.1:9999');
  });

  it('keys the cache on upstream, not the credential alone', () => {
    // A cached client carries its baseURL. Keying on the credential alone would
    // hand back a client pointed at the wrong host for the same API key.
    clearClientCache();
    const stub = getAnthropicClient('sk-same', null, 'http://127.0.0.1:9999') as unknown as { baseURL: string };
    const real = getAnthropicClient('sk-same', null) as unknown as { baseURL: string };
    assert.equal(stub.baseURL, 'http://127.0.0.1:9999');
    assert.equal(real.baseURL, 'https://api.anthropic.com');
    assert.notEqual(stub, real);
  });
});
