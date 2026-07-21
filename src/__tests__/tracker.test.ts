import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CostTracker } from '../tracker.js';
import type { RouteMeta } from '../types.js';

function makeMeta(overrides: Partial<RouteMeta> = {}): RouteMeta {
  return {
    tier: 'sonnet',
    model: 'claude-sonnet-4-6',
    inputTokens: 1000,
    outputTokens: 500,
    costCents: 0.45,
    savedCents: 0,
    classifierMethod: 'heuristic',
    classifierMs: 0.1,
    fallbackUsed: false,
    confidence: 0.8,
    retried: false,
    retryReason: null,
    ...overrides,
  };
}

describe('CostTracker', () => {
  it('starts with zero stats', () => {
    const tracker = new CostTracker();
    const stats = tracker.stats();
    assert.equal(stats.callCount, 0);
    assert.equal(stats.totalCostCents, 0);
    assert.equal(stats.totalSavedCents, 0);
    assert.deepEqual(stats.tierBreakdown, { haiku: 0, sonnet: 0, opus: 0 });
    assert.deepEqual(stats.unpricedModels, {});
  });

  it('surfaces unpriced calls by model instead of folding them into the totals', () => {
    const tracker = new CostTracker();
    tracker.record(makeMeta({ costCents: 1.5, savedCents: 3.2 }));
    tracker.record(makeMeta({ model: 'claude-mystery-9', costCents: 0, savedCents: 0, priced: false }));
    tracker.record(makeMeta({ model: 'claude-mystery-9', costCents: 0, savedCents: 0, priced: false }));

    const stats = tracker.stats();
    assert.equal(stats.callCount, 3);
    assert.equal(stats.totalSavedCents, 3.2, 'unpriced calls contribute nothing');
    assert.deepEqual(
      stats.unpricedModels,
      { 'claude-mystery-9': 2 },
      'and say so, by model and count',
    );
  });

  it('treats a meta with no priced field as priced (pre-existing records)', () => {
    const tracker = new CostTracker();
    tracker.record(makeMeta());
    assert.deepEqual(tracker.stats().unpricedModels, {});
  });

  it('records single call correctly', () => {
    const tracker = new CostTracker();
    tracker.record(makeMeta({ costCents: 1.5, savedCents: 3.2, tier: 'haiku' }));
    const stats = tracker.stats();
    assert.equal(stats.callCount, 1);
    assert.equal(stats.totalCostCents, 1.5);
    assert.equal(stats.totalSavedCents, 3.2);
    assert.equal(stats.tierBreakdown.haiku, 1);
  });

  it('accumulates across calls', () => {
    const tracker = new CostTracker();
    tracker.record(makeMeta({ costCents: 1.0, savedCents: 2.0, tier: 'haiku' }));
    tracker.record(makeMeta({ costCents: 3.0, savedCents: 0.0, tier: 'sonnet' }));
    tracker.record(makeMeta({ costCents: 10.0, savedCents: -5.0, tier: 'opus' }));

    const stats = tracker.stats();
    assert.equal(stats.callCount, 3);
    assert.equal(stats.totalCostCents, 14);
    assert.equal(stats.totalSavedCents, -3);
    assert.equal(stats.tierBreakdown.haiku, 1);
    assert.equal(stats.tierBreakdown.sonnet, 1);
    assert.equal(stats.tierBreakdown.opus, 1);
  });

  it('reset clears state', () => {
    const tracker = new CostTracker();
    tracker.record(makeMeta({ costCents: 5 }));
    tracker.reset();
    const stats = tracker.stats();
    assert.equal(stats.callCount, 0);
    assert.equal(stats.totalCostCents, 0);
  });

  it('savings = baseline - actual (can be negative)', () => {
    const tracker = new CostTracker();
    // Opus costs more than sonnet baseline → negative savings
    tracker.record(makeMeta({ savedCents: -7.5, tier: 'opus' }));
    assert.equal(tracker.stats().totalSavedCents, -7.5);
  });
});

describe('CostTracker — volume', () => {
  it('handles 10k records with O(1) stats and stable results', () => {
    const tracker = new CostTracker();
    for (let i = 0; i < 10_000; i++) {
      tracker.record(makeMeta({ costCents: 0.1, savedCents: 0.05, tier: i % 2 === 0 ? 'haiku' : 'opus' }));
    }
    const first = tracker.stats();
    const second = tracker.stats();
    assert.equal(first.callCount, 10_000);
    assert.equal(first.totalCostCents, 1000);
    assert.equal(first.totalSavedCents, 500);
    assert.deepEqual(first.tierBreakdown, { haiku: 5000, sonnet: 0, opus: 5000 });
    assert.deepEqual(second, first);
  });
});
