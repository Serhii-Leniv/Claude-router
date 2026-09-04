import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildHealth, formatStatusLine, SERVICE_ID } from '../proxy/health.js';
import { boundHistory, MAX_HISTORY } from '../proxy/handler.js';
import type { RouteEvent } from '../proxy/route-event.js';

function event(i: number): RouteEvent {
  return {
    timestamp: new Date(i).toISOString(),
    tier: 'sonnet',
    model: 'claude-sonnet-5',
    costCents: 1,
    savedCents: 0,
    confidence: 0.9,
    classifier: 'heuristic',
    retried: false,
    retryReason: null,
    inputTokens: 1,
    outputTokens: 1,
  };
}

const CONFIG = { classifier: 'hybrid', provider: 'anthropic', forceRoute: true };

describe('buildHealth', () => {
  it('reports the lifetime count, not the size of the bounded window', () => {
    // `/health.requests` and the statusline's `#N` read `routeHistory.length`,
    // which stops climbing at MAX_HISTORY and then oscillates as batches are
    // trimmed. A user's "how many requests" number was wrong after the first
    // busy hour.
    const history: RouteEvent[] = [];
    let recorded = 0;
    for (let i = 0; i < 1200; i++) {
      recorded++;
      history.push(event(i));
      boundHistory(history);
    }
    assert.ok(history.length < 1200 && history.length >= MAX_HISTORY, 'the window is bounded');

    const info = buildHealth(CONFIG, history, recorded);
    assert.equal(info.requests, 1200);
    assert.equal(info.service, SERVICE_ID);
    assert.equal(info.lastTier, 'sonnet', 'the window still supplies the last route');
    assert.equal(formatStatusLine(info), '[auto:sonnet #1200]');
  });

  it('falls back to the window length when no counter is given', () => {
    const history = [event(1), event(2)];
    assert.equal(buildHealth(CONFIG, history).requests, 2);
    assert.equal(formatStatusLine(buildHealth(CONFIG, [])), '[auto:ready #0]');
  });
});
