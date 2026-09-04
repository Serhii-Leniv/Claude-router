import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { emptyTotals, foldOutcome, tierBreakdown, type RouteOutcomeLike } from '../totals.js';
import { counterfactualCents, DEFAULT_PRICING } from '../models.js';

function e(overrides: Partial<RouteOutcomeLike> = {}): RouteOutcomeLike {
  return { tier: 'sonnet', costCents: 1, savedCents: 0.5, timestamp: '2026-09-04T10:00:00.000Z', ...overrides };
}

describe('foldOutcome — orchestration figures', () => {
  it('buckets cost by role, with the coordinator as its own label', () => {
    const acc = emptyTotals();
    foldOutcome(acc, e({ role: 'recon', costCents: 0.1 }));
    foldOutcome(acc, e({ role: 'recon', costCents: 0.2 }));
    foldOutcome(acc, e({ role: 'audit', costCents: 5 }));
    foldOutcome(acc, e({ coordinator: true, costCents: 3 }));
    assert.deepEqual(acc.byRole, {
      recon: { requests: 2, costCents: 0.30000000000000004, savedCents: 1 },
      audit: { requests: 1, costCents: 5, savedCents: 0.5 },
      coordinator: { requests: 1, costCents: 3, savedCents: 0.5 },
    });
  });

  it('a subagent with a role keeps its role label even when marked coordinator-like', () => {
    const acc = emptyTotals();
    foldOutcome(acc, e({ role: 'builder', coordinator: true }));
    assert.deepEqual(Object.keys(acc.byRole), ['builder']);
  });

  it('counts dispatchable turns, dispatched turns and nested subagents separately', () => {
    const acc = emptyTotals();
    foldOutcome(acc, e({ coordinator: true, dispatchable: true, dispatched: true }));
    foldOutcome(acc, e({ coordinator: true, dispatchable: true }));
    foldOutcome(acc, e({ coordinator: true }));
    foldOutcome(acc, e({ role: 'recon', nested: true }));
    assert.deepEqual(acc.dispatch, { turns: 2, dispatched: 1, nested: 1 });
  });

  it('sums tokens so a counterfactual can be priced from the totals', () => {
    const acc = emptyTotals();
    foldOutcome(acc, e({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 1000, cacheCreationTokens: 50 }));
    foldOutcome(acc, e({ inputTokens: 1, outputTokens: 1 }));
    assert.deepEqual(acc.tokens, { input: 101, output: 11, cacheRead: 1000, cacheCreation: 50 });
    const cents = counterfactualCents(acc.tokens, 'claude-opus-5', DEFAULT_PRICING);
    // 101 in @ $5, 11 out @ $25, 1000 cache-read @ 10% of $5, 50 cache-write @ 125% of $5, per 1M tokens, in cents
    const expected = ((101 * 5 + 11 * 25 + 1000 * 0.5 + 50 * 6.25) / 1_000_000) * 100;
    assert.ok(Math.abs(cents - expected) < 1e-9);
  });

  it('a record without any of the new fields folds to no orchestration change', () => {
    const acc = emptyTotals();
    foldOutcome(acc, e());
    assert.deepEqual(acc.byRole, {});
    assert.deepEqual(acc.dispatch, { turns: 0, dispatched: 0, nested: 0 });
    assert.deepEqual(acc.tokens, { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
    assert.equal(acc.requests, 1);
  });

  it('an errored event touches nothing but errors — not even the role bucket', () => {
    const acc = emptyTotals();
    foldOutcome(acc, e({ error: 'boom', role: 'recon', coordinator: true, dispatchable: true, inputTokens: 5 }));
    assert.equal(acc.errors, 1);
    assert.equal(acc.requests, 0);
    assert.deepEqual(acc.byRole, {});
    assert.deepEqual(acc.dispatch, { turns: 0, dispatched: 0, nested: 0 });
    assert.equal(acc.tokens.input, 0);
  });

  it('tierBreakdown still zero-fills the requested labels', () => {
    const acc = emptyTotals();
    foldOutcome(acc, e({ tier: 'haiku' }));
    assert.deepEqual(tierBreakdown(acc, ['haiku', 'fable'] as const), { haiku: 1, fable: 0 });
  });
});

describe('counterfactualCents', () => {
  it('is 0 for an unpriced model — the caller decides how to render it', () => {
    assert.equal(counterfactualCents({ input: 100, output: 100, cacheRead: 0, cacheCreation: 0 }, 'gpt-9', DEFAULT_PRICING), 0);
  });
});
