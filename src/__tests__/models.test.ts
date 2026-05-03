import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeCostCents, tierForModel, DEFAULT_MODELS, DEFAULT_PRICING } from '../models.js';

describe('computeCostCents', () => {
  it('calculates cost for known model', () => {
    // 1000 input tokens at $3/M + 500 output tokens at $15/M
    // = (1000 * 3 + 500 * 15) / 1_000_000 * 100
    // = (3000 + 7500) / 1_000_000 * 100
    // = 10500 / 1_000_000 * 100
    // = 10500 / 1_000_000 * 100 = 1.05 cents
    const cost = computeCostCents('claude-sonnet-4-6', 1000, 500, DEFAULT_PRICING);
    assert.equal(Math.round(cost * 10000) / 10000, 1.05);
  });

  it('returns 0 for unknown model', () => {
    const cost = computeCostCents('unknown-model', 1000, 500, DEFAULT_PRICING);
    assert.equal(cost, 0);
  });

  it('returns 0 for zero tokens', () => {
    const cost = computeCostCents('claude-sonnet-4-6', 0, 0, DEFAULT_PRICING);
    assert.equal(cost, 0);
  });

  it('handles large token counts', () => {
    const cost = computeCostCents('claude-opus-4-6', 1_000_000, 1_000_000, DEFAULT_PRICING);
    // (1M * 15 + 1M * 75) / 1M * 100 = 90 * 100 = 9000
    assert.equal(cost, 9000);
  });

  it('haiku is cheapest', () => {
    const haiku = computeCostCents(DEFAULT_MODELS.haiku, 1000, 500, DEFAULT_PRICING);
    const sonnet = computeCostCents(DEFAULT_MODELS.sonnet, 1000, 500, DEFAULT_PRICING);
    const opus = computeCostCents(DEFAULT_MODELS.opus, 1000, 500, DEFAULT_PRICING);
    assert.ok(haiku < sonnet);
    assert.ok(sonnet < opus);
  });

  it('uses custom pricing when provided', () => {
    const custom = { 'my-model': { input: 1.0, output: 2.0 } };
    const cost = computeCostCents('my-model', 1_000_000, 1_000_000, custom);
    // (1M * 1 + 1M * 2) / 1M * 100 = 300
    assert.equal(cost, 300);
  });

  it('handles very small token counts', () => {
    const cost = computeCostCents('claude-sonnet-4-6', 1, 1, DEFAULT_PRICING);
    assert.ok(cost > 0, `cost should be positive, got ${cost}`);
    assert.ok(Number.isFinite(cost), 'cost should be finite');
  });

  it('handles negative tokens without crashing', () => {
    const cost = computeCostCents('claude-sonnet-4-6', -100, -100, DEFAULT_PRICING);
    assert.equal(typeof cost, 'number');
    assert.ok(Number.isFinite(cost), 'cost should be finite');
  });
});

describe('tierForModel', () => {
  it('finds tier for known model', () => {
    assert.equal(tierForModel(DEFAULT_MODELS.haiku, DEFAULT_MODELS), 'haiku');
    assert.equal(tierForModel(DEFAULT_MODELS.sonnet, DEFAULT_MODELS), 'sonnet');
    assert.equal(tierForModel(DEFAULT_MODELS.opus, DEFAULT_MODELS), 'opus');
  });

  it('returns undefined for unknown model', () => {
    assert.equal(tierForModel('unknown', DEFAULT_MODELS), undefined);
  });
});
