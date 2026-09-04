import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCostCents,
  computeRouteCost,
  resetUnpricedWarnings,
  tierForModel,
  priceForModel,
  familyForModel,
  DEFAULT_MODELS,
  DEFAULT_PRICING,
  DIVERGENT_PRICING,
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

  it('bills cache reads at 10% of the input rate', () => {
    // sonnet input $2/M → 1M cache-read tokens = $0.20 = 20 cents
    const base = computeCostCents('claude-sonnet-5', 0, 0, DEFAULT_PRICING);
    const withReads = computeCostCents('claude-sonnet-5', 0, 0, DEFAULT_PRICING, {
      readTokens: 1_000_000,
    });
    assert.equal(base, 0);
    assert.equal(Math.round(withReads * 100) / 100, 20);
  });

  it('bills Fable 5.1 cache reads at its own 2.5%, not the standard 10%', () => {
    // The 10% multiplier is a default, not a universal. Fable 5.1 / Mythos 5.1
    // read at $0.25/MTok against a $10/MTok input rate — on a cache-heavy client
    // the read line is most of the input bill, so the standard rate overstates a
    // fable route ~4x on that component.
    for (const id of ['claude-fable-5-1', 'claude-mythos-5-1']) {
      const cost = computeCostCents(id, 0, 0, DEFAULT_PRICING, { readTokens: 1_000_000 });
      assert.equal(Math.round(cost * 100) / 100, 25, id);
    }
    // Fable 5 keeps the standard rate: $10/M × 10% = $1.00 = 100 cents.
    const fable5 = computeCostCents('claude-fable-5', 0, 0, DEFAULT_PRICING, {
      readTokens: 1_000_000,
    });
    assert.equal(Math.round(fable5 * 100) / 100, 100);
  });

  it('bills cache writes at 125% of the input rate', () => {
    // sonnet input $2/M → 1M cache-creation tokens = $2.50 = 250 cents
    const cost = computeCostCents('claude-sonnet-5', 0, 0, DEFAULT_PRICING, {
      creationTokens: 1_000_000,
    });
    assert.equal(Math.round(cost * 100) / 100, 250);
  });

  it('combines regular, cache-read, and cache-write tokens', () => {
    // haiku $1/M in, $5/M out:
    // 1000 in = $0.001; 500 out = $0.0025; 10000 reads = $0.001; 2000 writes = $0.0025
    const cost = computeCostCents('claude-haiku-4-5', 1000, 500, DEFAULT_PRICING, {
      readTokens: 10_000,
      creationTokens: 2_000,
    });
    assert.equal(Math.round(cost * 100000) / 100000, 0.7);
  });

  it('omitting cache tokens matches the old behavior', () => {
    const without = computeCostCents('claude-sonnet-5', 1000, 500, DEFAULT_PRICING);
    const withEmpty = computeCostCents('claude-sonnet-5', 1000, 500, DEFAULT_PRICING, {});
    assert.equal(without, withEmpty);
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

  it('Sonnet 5 is $2/$10 per 1M — the standard rate, not an intro discount', () => {
    // Sonnet 5's $2/$10 launched as introductory pricing through 2026-08-31, and
    // this table used to hold the announced $3/$15 successor so savings figures
    // would not jump when it expired. It never expired — the increase was
    // cancelled and $2/$10 became standard. The sonnet tier is the savings
    // baseline, so pricing a rate that was never charged overstated every
    // reported win. Pin today's rate; do not pre-empt a scheduled change.
    assert.deepEqual(FAMILY_PRICING.sonnet, { input: 2.0, output: 10.0 });
    assert.deepEqual(priceForModel('claude-sonnet-5', DEFAULT_PRICING), {
      input: 2.0,
      output: 10.0,
    });
  });

  it('legacy Sonnet (4, 4.5, 4.6) keeps $3/$15 after the family rate dropped', () => {
    // These were free-riding on the family fallback while it said $3/$15. Sonnet
    // 5's price cut made the whole prior generation divergent in one move —
    // same shape as legacy Opus, one generation down.
    for (const id of [
      'claude-sonnet-4-6',
      'claude-sonnet-4-5',
      'claude-sonnet-4-5-20250929',
      'claude-sonnet-4-0',
      'claude-sonnet-4-20250514',
    ]) {
      assert.deepEqual(priceForModel(id, DEFAULT_PRICING), { input: 3.0, output: 15.0 }, id);
    }
  });

  it('Haiku is $1/$5 per 1M, not the old $0.80/$4', () => {
    assert.deepEqual(FAMILY_PRICING.haiku, { input: 1.0, output: 5.0 });
  });

  // The exclusion set is DERIVED from DIVERGENT_PRICING, not hand-listed. A
  // hand-maintained copy has to be updated every time a model's price diverges,
  // and forgetting is silent — which is how Fable 5 shipped at $0.
  it('every non-divergent DEFAULT_PRICING entry matches its family price', () => {
    for (const [model, price] of Object.entries(DEFAULT_PRICING)) {
      if (model in DIVERGENT_PRICING) continue;
      const fam = familyForModel(model);
      assert.ok(fam, `${model} should map to a family`);
      assert.deepEqual(price, FAMILY_PRICING[fam!], `${model} priced off-family`);
    }
  });

  it('every DIVERGENT_PRICING entry actually diverges from its family', () => {
    // Guards the other direction: an entry that matches its family is dead
    // weight, and a stale one silently pins a model to an outdated rate.
    for (const [model, price] of Object.entries(DIVERGENT_PRICING)) {
      const fam = familyForModel(model);
      if (!fam) continue; // no family at all — divergent by definition (Fable/Mythos)
      assert.notDeepEqual(
        price,
        FAMILY_PRICING[fam],
        `${model} matches its family price — drop it from DIVERGENT_PRICING`,
      );
    }
  });

  it('legacy Opus keeps its own $15/$75 rate, not the current family price', () => {
    for (const id of ['claude-opus-4-1', 'claude-opus-4-1-20250805', 'claude-opus-4-0', 'claude-opus-4-20250514']) {
      assert.deepEqual(priceForModel(id, DEFAULT_PRICING), { input: 15.0, output: 75.0 }, id);
    }
  });

  it('Fable 5 is a tier and prices by family; Mythos 5 still needs an exact entry', () => {
    // Fable became a routable tier, so the family fallback now covers it — and
    // covers future dated snapshots without a code change.
    assert.equal(familyForModel('claude-fable-5'), 'fable');
    // Mythos 5 is the same price but shares no substring with any family name,
    // so it stays in DIVERGENT_PRICING. Dropping that entry prices it at zero.
    assert.equal(familyForModel('claude-mythos-5'), undefined);
    for (const id of ['claude-fable-5', 'claude-mythos-5']) {
      assert.deepEqual(priceForModel(id, DEFAULT_PRICING), { input: 10.0, output: 50.0 }, id);
    }
  });

  it('the fable tier is Fable 5.1, and Mythos 5.1 is priced rather than unknown', () => {
    // Fable 5.1 (2026-09-01) supersedes Fable 5. The `fable` substring means 5.1
    // family-resolved at the right base price the day it shipped — the fallback
    // doing its job — but its cache-read rate still needed an exact entry.
    assert.equal(DEFAULT_MODELS.fable, 'claude-fable-5-1');
    assert.equal(familyForModel('claude-fable-5-1'), 'fable');
    // Mythos 5.1 matches no family, exactly like Mythos 5: without its own row it
    // prices at zero, which is the failure mode that shipped Fable 5 free.
    assert.equal(familyForModel('claude-mythos-5-1'), undefined);
    for (const id of ['claude-fable-5-1', 'claude-mythos-5-1']) {
      const price = priceForModel(id, DEFAULT_PRICING);
      assert.equal(price?.input, 10.0, id);
      assert.equal(price?.output, 50.0, id);
      assert.equal(price?.cacheRead, 0.025, id);
    }
  });
});

describe('unpriced models are loud, not free', () => {
  // The regression guard the suite was missing: asserting a specific price only
  // ever catches the model you already thought of. These assert that ANY model
  // with no exact entry and no family match produces an observable signal —
  // which is what makes the next claude-mythos-5 impossible to ship silently.
  function capturingWarnings<T>(fn: () => T): { result: T; warnings: string[] } {
    resetUnpricedWarnings();
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (msg: unknown) => void warnings.push(String(msg));
    try {
      return { result: fn(), warnings };
    } finally {
      console.warn = original;
      resetUnpricedWarnings();
    }
  }

  const usage = { input_tokens: 1000, output_tokens: 500 } as never;

  it('flags a model with no exact entry and no family match as unpriced', () => {
    const { result, warnings } = capturingWarnings(() =>
      computeRouteCost('some-future-model-5', usage, DEFAULT_MODELS.sonnet, DEFAULT_PRICING),
    );
    assert.equal(result.priced, false, 'must not claim these figures are measured');
    assert.equal(result.costCents, 0);
    assert.equal(warnings.length, 1, 'exactly one warning');
    assert.match(warnings[0]!, /some-future-model-5/);
  });

  it('flags an unpriced baseline too — savedCents is just as wrong', () => {
    const { result } = capturingWarnings(() =>
      computeRouteCost(DEFAULT_MODELS.haiku, usage, 'some-future-model-5', DEFAULT_PRICING),
    );
    assert.equal(result.priced, false);
  });

  it('warns once per model, not once per call', () => {
    const { warnings } = capturingWarnings(() => {
      for (let i = 0; i < 5; i++) {
        computeRouteCost('some-future-model-5', usage, DEFAULT_MODELS.sonnet, DEFAULT_PRICING);
      }
    });
    assert.equal(warnings.length, 1);
  });

  it('stays silent and priced for a fully-known route', () => {
    const { result, warnings } = capturingWarnings(() =>
      computeRouteCost(DEFAULT_MODELS.haiku, usage, DEFAULT_MODELS.sonnet, DEFAULT_PRICING),
    );
    assert.equal(result.priced, true);
    assert.deepEqual(warnings, []);
  });

  it('delivers warnings to an injected sink, not the console', () => {
    const custom: string[] = [];
    const { warnings } = capturingWarnings(() =>
      computeRouteCost(
        'some-future-model-5',
        usage,
        DEFAULT_MODELS.sonnet,
        DEFAULT_PRICING,
        (msg) => void custom.push(msg),
      ),
    );
    assert.equal(custom.length, 1);
    assert.match(custom[0]!, /some-future-model-5/);
    assert.deepEqual(warnings, [], 'console.warn must stay silent');
  });

  it('prices Mythos 5 and Fable 5 rather than flagging them', () => {
    // The two models the silent-$0 bug actually bit. Both must now be measured.
    for (const id of ['claude-mythos-5', 'claude-fable-5']) {
      const { result, warnings } = capturingWarnings(() =>
        computeRouteCost(id, usage, DEFAULT_MODELS.sonnet, DEFAULT_PRICING),
      );
      assert.equal(result.priced, true, id);
      assert.deepEqual(warnings, [], id);
      assert.ok(result.costCents > 0, `${id} must cost something`);
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
