import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeParamsForTier } from '../params.js';

describe('normalizeParamsForTier — haiku (Haiku 4.5)', () => {
  it('strips adaptive thinking (unsupported on Haiku 4.5)', () => {
    const out = normalizeParamsForTier(
      { max_tokens: 100, thinking: { type: 'adaptive' } },
      'haiku',
    );
    assert.ok(!('thinking' in out), 'thinking should be removed');
  });

  it('strips output_config.effort and drops output_config if now empty', () => {
    const out = normalizeParamsForTier(
      { max_tokens: 100, output_config: { effort: 'high' } },
      'haiku',
    );
    assert.ok(!('output_config' in out), 'empty output_config should be removed');
  });

  it('keeps other output_config keys while removing effort', () => {
    const out = normalizeParamsForTier(
      { max_tokens: 100, output_config: { effort: 'high', format: { type: 'json' } } },
      'haiku',
    ) as any;
    assert.deepEqual(out.output_config, { format: { type: 'json' } });
  });

  it('keeps sampling params (Haiku 4.5 accepts them)', () => {
    const out = normalizeParamsForTier(
      { max_tokens: 100, temperature: 0.5, top_p: 0.9 },
      'haiku',
    ) as any;
    assert.equal(out.temperature, 0.5);
    assert.equal(out.top_p, 0.9);
  });
});

describe('normalizeParamsForTier — sonnet/opus (Sonnet 5 / Opus 4.8)', () => {
  for (const tier of ['sonnet', 'opus'] as const) {
    it(`${tier}: strips temperature/top_p/top_k`, () => {
      const out = normalizeParamsForTier(
        { max_tokens: 100, temperature: 0.5, top_p: 0.9, top_k: 40 },
        tier,
      );
      assert.ok(!('temperature' in out));
      assert.ok(!('top_p' in out));
      assert.ok(!('top_k' in out));
    });

    it(`${tier}: converts enabled thinking budget to adaptive`, () => {
      const out = normalizeParamsForTier(
        { max_tokens: 100, thinking: { type: 'enabled', budget_tokens: 8000 } },
        tier,
      ) as any;
      assert.deepEqual(out.thinking, { type: 'adaptive' });
    });

    it(`${tier}: preserves thinking.display when converting`, () => {
      const out = normalizeParamsForTier(
        { max_tokens: 100, thinking: { type: 'enabled', budget_tokens: 8000, display: 'summarized' } },
        tier,
      ) as any;
      assert.deepEqual(out.thinking, { type: 'adaptive', display: 'summarized' });
    });

    it(`${tier}: leaves adaptive thinking and effort untouched`, () => {
      const out = normalizeParamsForTier(
        { max_tokens: 100, thinking: { type: 'adaptive' }, output_config: { effort: 'xhigh' } },
        tier,
      ) as any;
      assert.deepEqual(out.thinking, { type: 'adaptive' });
      assert.deepEqual(out.output_config, { effort: 'xhigh' });
    });
  }
});

describe('normalizeParamsForTier — invariants', () => {
  it('never mutates the input object', () => {
    const input = { max_tokens: 100, temperature: 0.5, thinking: { type: 'adaptive' } };
    normalizeParamsForTier(input, 'opus');
    assert.equal(input.temperature, 0.5, 'input must be untouched');
    assert.deepEqual(input.thinking, { type: 'adaptive' });
  });

  it('leaves messages/system/tools/max_tokens alone', () => {
    const input = {
      max_tokens: 512,
      messages: [{ role: 'user', content: 'hi' }],
      system: 'be brief',
      tools: [{ name: 't' }],
      temperature: 0.7,
    };
    const out = normalizeParamsForTier(input, 'opus') as any;
    assert.equal(out.max_tokens, 512);
    assert.deepEqual(out.messages, input.messages);
    assert.equal(out.system, 'be brief');
    assert.deepEqual(out.tools, input.tools);
    assert.ok(!('temperature' in out));
  });
});
