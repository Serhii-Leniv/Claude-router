import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCostCents,
  tierForModel,
  priceForModel,
  familyForModel,
  DEFAULT_MODELS,
  DEFAULT_PRICING,
  FAMILY_PRICING,
} from '../models.js';

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
    const cost = computeCostCents('claude-opus-4-8', 1_000_000, 1_000_000, DEFAULT_PRICING);
    // Current-generation Opus pricing: $5/M input + $25/M output.
    // (1M * 5 + 1M * 25) / 1M * 100 = 30 * 100 = 3000
    assert.equal(cost, 3000);
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

describe('current-generation pricing (guards against drift)', () => {
  // These exact numbers are the product's whole value prop — every `savedCents`
  // figure depends on them. If a regression reintroduces old-generation pricing
  // (e.g. Opus $15/$75), these fail loudly.
  it('Opus is $5/$25 per 1M, not the old $15/$75', () => {
    assert.deepEqual(FAMILY_PRICING.opus, { input: 5.0, output: 25.0 });
  });

  it('Sonnet is $3/$15 per 1M', () => {
    assert.deepEqual(FAMILY_PRICING.sonnet, { input: 3.0, output: 15.0 });
  });

  it('Haiku is $1/$5 per 1M, not the old $0.80/$4', () => {
    assert.deepEqual(FAMILY_PRICING.haiku, { input: 1.0, output: 5.0 });
  });

  it('every DEFAULT_PRICING entry matches its family price', () => {
    for (const [model, price] of Object.entries(DEFAULT_PRICING)) {
      const fam = familyForModel(model);
      assert.ok(fam, `${model} should map to a family`);
      assert.deepEqual(price, FAMILY_PRICING[fam!], `${model} priced off-family`);
    }
  });
});

describe('familyForModel', () => {
  it('maps first-party IDs to families', () => {
    assert.equal(familyForModel('claude-haiku-4-5'), 'haiku');
    assert.equal(familyForModel('claude-sonnet-5'), 'sonnet');
    assert.equal(familyForModel('claude-sonnet-4-6'), 'sonnet');
    assert.equal(familyForModel('claude-opus-4-8'), 'opus');
  });

  it('maps Bedrock and Vertex IDs to families', () => {
    assert.equal(familyForModel('us.anthropic.claude-opus-4-8-v1:0'), 'opus');
    assert.equal(familyForModel('anthropic.claude-haiku-4-5'), 'haiku');
  });

  it('returns undefined for non-Claude IDs', () => {
    assert.equal(familyForModel('gpt-4o'), undefined);
  });
});

describe('priceForModel (drift resilience)', () => {
  it('prices an unlisted dated snapshot by family', () => {
    // A future snapshot ID not in DEFAULT_PRICING must still price correctly.
    const p = priceForModel('claude-opus-4-9-20991231', DEFAULT_PRICING);
    assert.deepEqual(p, FAMILY_PRICING.opus);
  });

  it('prices Bedrock/Vertex IDs by family with no explicit entry', () => {
    const cost = computeCostCents('us.anthropic.claude-opus-4-8-v1:0', 1_000_000, 1_000_000, DEFAULT_PRICING);
    assert.equal(cost, 3000); // same as first-party opus
  });

  it('exact override wins over family fallback', () => {
    const custom = { ...DEFAULT_PRICING, 'claude-opus-4-8': { input: 0.0, output: 0.0 } };
    assert.deepEqual(priceForModel('claude-opus-4-8', custom), { input: 0.0, output: 0.0 });
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
