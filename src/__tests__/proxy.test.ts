import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProxyApp } from '../proxy/server.js';
import { routeHistory } from '../proxy/handler.js';
import { renderDashboard } from '../proxy/dashboard.js';
import type { RouteEvent } from '../proxy/handler.js';

import { DEFAULT_MODELS } from '../models.js';

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

  it('GET /unknown returns 404', async () => {
    const res = await app.request('/unknown');
    assert.equal(res.status, 404);
  });
});

describe('renderDashboard', () => {
  it('renders empty state', () => {
    const html = renderDashboard([]);
    assert.ok(html.includes('No requests yet'));
    assert.ok(html.includes('Total Requests'));
    assert.ok(html.includes('0'));
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

  it('POST /v1/messages with explicit model and key passes through to Anthropic', async () => {
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
