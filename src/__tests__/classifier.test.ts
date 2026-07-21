import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  heuristicScore,
  heuristicScoreDetailed,
  scoreToTier,
  scoreToConfidence,
  classifyHeuristic,
  classifyAI,
  classifyHybrid,
  classify,
} from '../classifier.js';
import { LruCache } from '../cache.js';
import type { ClassifyInput, ClassifyResult } from '../types.js';
import type Anthropic from '@anthropic-ai/sdk';

function makeInput(content: string, opts?: { system?: string; messageCount?: number }): ClassifyInput {
  const messages: ClassifyInput['messages'] = [];

  if (opts?.messageCount) {
    for (let i = 0; i < opts.messageCount; i++) {
      messages.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: i === opts.messageCount - 1 ? content : 'filler message',
      });
    }
  } else {
    messages.push({ role: 'user', content });
  }

  return { messages, system: opts?.system };
}

describe('scoreToTier', () => {
  it('maps low scores to haiku', () => {
    assert.equal(scoreToTier(0), 'haiku');
    assert.equal(scoreToTier(15), 'haiku');
    assert.equal(scoreToTier(29), 'haiku');
  });

  it('maps mid scores to sonnet', () => {
    assert.equal(scoreToTier(30), 'sonnet');
    assert.equal(scoreToTier(50), 'sonnet');
    assert.equal(scoreToTier(70), 'sonnet');
  });

  it('maps high scores to opus', () => {
    assert.equal(scoreToTier(71), 'opus');
    assert.equal(scoreToTier(85), 'opus');
    assert.equal(scoreToTier(100), 'opus');
  });
});

describe('heuristicScore', () => {
  it('simple translation → haiku', () => {
    const score = heuristicScore(makeInput('translate hello to French'));
    assert.equal(scoreToTier(score), 'haiku');
  });

  it('explain React hooks → sonnet', () => {
    const score = heuristicScore(makeInput('explain how React hooks work and compare useState with useReducer'));
    assert.equal(scoreToTier(score), 'sonnet');
  });

  it('design distributed system → opus', () => {
    const score = heuristicScore(
      makeInput(
        'architect and design a distributed system for real-time event processing that can evaluate and strategize about scaling patterns across multiple regions with comprehensive fault tolerance',
      ),
    );
    assert.equal(scoreToTier(score), 'opus');
  });

  it('code block presence bumps score', () => {
    const without = heuristicScore(makeInput('fix this function'));
    const with_ = heuristicScore(makeInput('fix this function ```\nconst x = 1;\n```'));
    assert.ok(with_ > without, `with code (${with_}) should be higher than without (${without})`);
  });

  it('long system prompt bumps score', () => {
    const short = heuristicScore(makeInput('hello', { system: 'Be helpful.' }));
    const long = heuristicScore(
      makeInput('hello', { system: 'A'.repeat(600) }),
    );
    assert.ok(long > short, `long system (${long}) should be higher than short (${short})`);
  });

  it('multi-turn (>5 messages) bumps score', () => {
    const few = heuristicScore(makeInput('continue', { messageCount: 2 }));
    const many = heuristicScore(makeInput('continue', { messageCount: 8 }));
    assert.ok(many > few, `many turns (${many}) should be higher than few (${few})`);
  });

  it('multi-turn (>15 messages) bumps more', () => {
    const mid = heuristicScore(makeInput('continue', { messageCount: 8 }));
    const lots = heuristicScore(makeInput('continue', { messageCount: 18 }));
    assert.ok(lots > mid, `18 turns (${lots}) should be higher than 8 (${mid})`);
  });

  it('empty prompt → haiku (safe default)', () => {
    const score = heuristicScore(makeInput(''));
    assert.equal(scoreToTier(score), 'haiku');
  });

  it('score is clamped 0–100', () => {
    // Many simple verbs → should not go below 0
    const low = heuristicScore(
      makeInput('translate summarize format convert list extract define count repeat spell'),
    );
    assert.ok(low >= 0, `score should be >= 0, got ${low}`);
    assert.ok(low <= 100, `score should be <= 100, got ${low}`);
  });

  // --- Math/science domain: short queries must not route to haiku ---

  it('short math theorem query → opus', () => {
    const score = heuristicScore(makeInput('Prove Fermat Last Theorem'));
    assert.equal(scoreToTier(score), 'opus', `score=${score}`);
  });

  it('P=NP question → opus', () => {
    const score = heuristicScore(makeInput('P=NP?'));
    assert.equal(scoreToTier(score), 'opus', `score=${score}`);
  });

  it('Riemann Hypothesis → opus', () => {
    const score = heuristicScore(makeInput('Prove the Riemann Hypothesis'));
    assert.equal(scoreToTier(score), 'opus', `score=${score}`);
  });

  it('quantum entanglement question → opus', () => {
    const score = heuristicScore(makeInput('explain quantum entanglement and wave function collapse'));
    assert.equal(scoreToTier(score), 'opus', `score=${score}`);
  });

  it('NP-hard complexity → at least sonnet (not haiku)', () => {
    // "Is 3-SAT NP-hard?" is a factual yes/no question — sonnet is correct routing.
    // Key requirement: must NOT route to haiku.
    const score = heuristicScore(makeInput('Is 3-SAT NP-hard?'));
    assert.ok(scoreToTier(score) !== 'haiku', `NP-hard should not route to haiku, score=${score}`);
  });

  it('eigenvalue computation → opus', () => {
    const score = heuristicScore(makeInput('compute eigenvalues of this matrix'));
    assert.equal(scoreToTier(score), 'opus', `score=${score}`);
  });

  it('integral calculus → opus', () => {
    const score = heuristicScore(makeInput('solve this differential equation using integral transform'));
    assert.equal(scoreToTier(score), 'opus', `score=${score}`);
  });

  it('math notation (integral symbol) → high score', () => {
    const score = heuristicScore(makeInput('∫f(x)dx'));
    assert.ok(score >= 50, `integral symbol should bump score >= 50, got ${score}`);
  });

  it('LaTeX math → high score', () => {
    const score = heuristicScore(makeInput('compute \\int_0^\\infty e^{-x} dx using \\frac{1}{s}'));
    assert.ok(score >= 50, `LaTeX math should bump score >= 50, got ${score}`);
  });

  it('simple factual (no math) → still low', () => {
    const score = heuristicScore(makeInput('what is the capital of France'));
    assert.ok(score < 70, `non-math factual should not reach opus, got ${score}`);
  });
});

describe('scoreToConfidence', () => {
  it('extreme scores → high confidence', () => {
    assert.equal(scoreToConfidence(0), 1.0);
    assert.equal(scoreToConfidence(100), 1.0);
  });

  it('center score → low confidence', () => {
    assert.equal(scoreToConfidence(50), 0.5);
  });

  it('near-boundary scores → moderate confidence', () => {
    const conf40 = scoreToConfidence(40);
    const conf60 = scoreToConfidence(60);
    assert.ok(conf40 > 0.5 && conf40 < 1.0, `conf at 40: ${conf40}`);
    assert.ok(conf60 > 0.5 && conf60 < 1.0, `conf at 60: ${conf60}`);
    // Symmetric
    assert.equal(conf40, conf60);
  });

  it('confidence increases with distance from center', () => {
    assert.ok(scoreToConfidence(20) > scoreToConfidence(40));
    assert.ok(scoreToConfidence(80) > scoreToConfidence(60));
  });
});

describe('classifyHeuristic', () => {
  it('returns full ClassifyResult with confidence', () => {
    const result = classifyHeuristic(makeInput('translate hello'));
    assert.equal(result.method, 'heuristic');
    assert.equal(typeof result.score, 'number');
    assert.equal(typeof result.ms, 'number');
    assert.equal(typeof result.confidence, 'number');
    assert.ok(result.confidence >= 0 && result.confidence <= 1);
    assert.ok(result.ms >= 0);
    assert.ok(['haiku', 'sonnet', 'opus'].includes(result.tier));
  });
});

function mockClient(responseText: string) {
  return {
    messages: {
      create: mock.fn(async () => ({
        content: responseText ? [{ type: 'text', text: responseText }] : [],
      })),
    },
  } as unknown as Anthropic;
}

function mockClientEmpty() {
  return {
    messages: {
      create: mock.fn(async () => ({
        content: [],
      })),
    },
  } as unknown as Anthropic;
}

describe('classifyAI', () => {
  it('returns haiku for "1"', async () => {
    const result = await classifyAI(mockClient('1'), makeInput('test'), 'claude-haiku-4-5-20251001');
    assert.equal(result.tier, 'haiku');
    assert.equal(result.confidence, 0.9);
    assert.equal(result.method, 'ai');
  });

  it('returns sonnet for "2"', async () => {
    const result = await classifyAI(mockClient('2'), makeInput('test'), 'claude-haiku-4-5-20251001');
    assert.equal(result.tier, 'sonnet');
    assert.equal(result.confidence, 0.9);
  });

  it('returns opus for "3"', async () => {
    const result = await classifyAI(mockClient('3'), makeInput('test'), 'claude-haiku-4-5-20251001');
    assert.equal(result.tier, 'opus');
    assert.equal(result.confidence, 0.9);
  });

  it('defaults to sonnet on garbage response', async () => {
    const result = await classifyAI(mockClient('banana'), makeInput('test'), 'claude-haiku-4-5-20251001');
    assert.equal(result.tier, 'sonnet');
    assert.equal(result.confidence, 0.6);
  });

  it('defaults to sonnet on empty content', async () => {
    const result = await classifyAI(mockClientEmpty(), makeInput('test'), 'claude-haiku-4-5-20251001');
    assert.equal(result.tier, 'sonnet');
    assert.equal(result.confidence, 0.6);
  });
});

describe('classifyHybrid', () => {
  it('uses heuristic for clear haiku (score<40)', async () => {
    const client = mockClient('1');
    const result = await classifyHybrid(client, makeInput('translate hello'), 'claude-haiku-4-5-20251001');
    assert.equal(result.method, 'heuristic');
    // AI should NOT have been called
    assert.equal((client.messages.create as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 0);
  });

  it('uses heuristic for clear opus (score>60)', async () => {
    const client = mockClient('3');
    const input = makeInput(
      'architect and design a distributed system, evaluate tradeoffs, strategize about scaling and prove correctness',
    );
    const result = await classifyHybrid(client, input, 'claude-haiku-4-5-20251001');
    assert.equal(result.method, 'heuristic');
    assert.equal((client.messages.create as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 0);
  });

  it('calls AI for ambiguous zone (score 40-60)', async () => {
    const client = mockClient('2');
    // This prompt scores 45 — in the ambiguous 40-60 zone
    const input = makeInput('explain compare write generate describe this code');
    const score = heuristicScore(input);
    assert.ok(score >= 40 && score <= 60, `expected score 40-60, got ${score}`);

    const result = await classifyHybrid(client, input, 'claude-haiku-4-5-20251001');
    assert.equal(result.method, 'ai');
    assert.equal((client.messages.create as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  });

  it('calls AI for signal-poor non-English prompts outside the band', async () => {
    const client = mockClient('2');
    // No English keywords fire, but the text is substantive (>20 est. tokens)
    const input = makeInput(
      'напиши будь ласка довгий детальний огляд цієї архітектури і поясни компроміси між рішеннями',
    );
    const detail = heuristicScoreDetailed(input);
    assert.equal(detail.keywordHits, 0, 'expected no keyword hits');
    await classifyHybrid(client, input, 'claude-haiku-4-5-20251001');
    assert.equal((client.messages.create as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  });

  // The score band is gone: there is no score for a request to sit between two
  // thresholds. Hybrid now spends a Haiku call exactly when no gate fired on
  // positive evidence and routing fell through to the default tier.
  it('does not call the AI when a gate fired on positive evidence', async () => {
    const client = mockClient('2');
    // Short single-turn mechanical transform — the haiku gate fires outright.
    await classifyHybrid(client, makeInput('translate hello'), 'claude-haiku-4-5-20251001');
    assert.equal((client.messages.create as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 0);
  });

  it('calls the AI when every gate abstained and routing fell back to the default', async () => {
    const client = mockClient('2');
    // Neither simple enough to demote nor explicitly deep enough to promote.
    const r = await classifyHybrid(
      client,
      makeInput('take a look at the invoice module and tell me what you think'),
      'claude-haiku-4-5-20251001',
    );
    assert.equal((client.messages.create as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
    assert.equal(r.method, 'ai');
  });
});

describe('heuristicScore — word boundaries', () => {
  it('"listen" does not match simple verb "list"', () => {
    const withFalsePositive = heuristicScore(makeInput('listen to this song and name the tempo'));
    const withRealMatch = heuristicScore(makeInput('list to this song and name the tempo'));
    assert.ok(withFalsePositive > withRealMatch, 'listen must not get the simple-verb penalty');
  });

  it('"planets" does not match complex verb "plan"', () => {
    const withFalsePositive = heuristicScore(makeInput('the planets orbit the sun'));
    const withRealMatch = heuristicScore(makeInput('the plan orbit the sun'));
    assert.ok(withFalsePositive < withRealMatch, 'planets must not get the complex-verb bonus');
  });

  it('plural forms still match ("eigenvalues")', () => {
    const score = heuristicScore(makeInput('Compute the eigenvalues of A'));
    assert.ok(score > 50, `expected math signal to fire, got ${score}`);
  });
});

describe('heuristicScore — token branches', () => {
  it('very long prompts (>2000 tokens) score higher than long prompts (>500)', () => {
    const long = heuristicScore(makeInput('word '.repeat(500))); // ~625 tokens
    const veryLong = heuristicScore(makeInput('word '.repeat(2000))); // ~2500 tokens
    assert.ok(veryLong > long, `expected ${veryLong} > ${long}`);
  });
});

describe('heuristicScore — tool and image signals', () => {
  const base = makeInput('what is the weather');

  it('tool_use blocks raise the score', () => {
    const withTools: ClassifyInput = {
      messages: [
        { role: 'user', content: 'what is the weather' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'get_weather', input: {} }],
        },
      ],
    };
    assert.ok(heuristicScore(withTools) > heuristicScore(base));
  });

  it('tool_result content counts toward token estimate, not keywords', () => {
    const bigResult: ClassifyInput = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'translate list count '.repeat(500) },
          ],
        },
      ],
    };
    // 10500 chars of tool output → >2000 est. tokens, but the simple verbs
    // inside the tool output must NOT apply their -12 penalties
    const detail = heuristicScoreDetailed(bigResult);
    assert.ok(detail.estimatedTokens > 2000);
    assert.equal(detail.keywordHits, 0);
  });

  it('defined tools raise the score, many tools raise it more', () => {
    const fewTools: ClassifyInput = { ...base, tools: [{}, {}] };
    const manyTools: ClassifyInput = { ...base, tools: Array.from({ length: 10 }, () => ({})) };
    assert.ok(heuristicScore(fewTools) > heuristicScore(base));
    assert.ok(heuristicScore(manyTools) > heuristicScore(fewTools));
  });

  it('image blocks raise the score', () => {
    const withImage: ClassifyInput = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is the weather' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: '' },
            },
          ],
        },
      ],
    };
    assert.ok(heuristicScore(withImage) > heuristicScore(base));
  });
});

describe('scoreToTier — custom thresholds', () => {
  it('haikuMax override widens the haiku band', () => {
    assert.equal(scoreToTier(35), 'sonnet');
    assert.equal(scoreToTier(35, { haikuMax: 40 }), 'haiku');
  });

  it('opusMin override widens the opus band', () => {
    assert.equal(scoreToTier(65), 'sonnet');
    assert.equal(scoreToTier(65, { opusMin: 60 }), 'opus');
  });
});

describe('classifyAI — hardening', () => {
  it('falls back to heuristic when the API call rejects', async () => {
    const client = {
      messages: { create: mock.fn(async () => { throw new Error('network down'); }) },
    } as unknown as Anthropic;
    const result = await classifyAI(client, makeInput('translate hello'), 'claude-haiku-4-5-20251001');
    assert.equal(result.method, 'heuristic');
    assert.equal(result.tier, 'haiku');
  });

  it('falls back to heuristic on timeout', async () => {
    const client = {
      messages: {
        create: mock.fn(
          (_params: unknown, opts?: { signal?: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              // Ref'd timer keeps the event loop alive: AbortSignal.timeout's
              // internal timer is unref'd, so on Node 18/22 the loop would
              // otherwise drain before the abort ever fires.
              const failsafe = setTimeout(
                () => reject(new Error('abort never fired')),
                5000,
              );
              opts?.signal?.addEventListener('abort', () => {
                clearTimeout(failsafe);
                reject(opts.signal!.reason);
              });
            }),
        ),
      },
    } as unknown as Anthropic;
    const result = await classifyAI(client, makeInput('translate hello'), 'claude-haiku-4-5-20251001', {
      timeoutMs: 20,
    });
    assert.equal(result.method, 'heuristic');
  });

  it('parses the digit from any text block, not just the first', async () => {
    const client = {
      messages: {
        create: mock.fn(async () => ({
          content: [
            { type: 'tool_use', id: 'x', name: 'noop', input: {} },
            { type: 'text', text: 'complexity: 3' },
          ],
        })),
      },
    } as unknown as Anthropic;
    const result = await classifyAI(client, makeInput('test'), 'claude-haiku-4-5-20251001');
    assert.equal(result.tier, 'opus');
    assert.equal(result.confidence, 0.9);
  });

  it('sends system snippet and head+tail of long prompts', async () => {
    const client = mockClient('2');
    const longText = 'A'.repeat(800) + 'MIDDLE' + 'Z'.repeat(800);
    await classifyAI(client, makeInput(longText, { system: 'You are a legal expert' }), 'claude-haiku-4-5-20251001');
    const createMock = client.messages.create as unknown as ReturnType<typeof mock.fn>;
    const params = createMock.mock.calls[0]!.arguments[0] as Anthropic.MessageCreateParamsNonStreaming;
    const prompt = (params.messages[0]!.content as string);
    assert.ok(prompt.includes('System: You are a legal expert'));
    assert.ok(prompt.includes('AAA'), 'head of prompt missing');
    assert.ok(prompt.includes('ZZZ'), 'tail of prompt missing');
    assert.ok(!prompt.includes('MIDDLE'), 'middle should be elided');
  });
});

describe('classify — unified entry with cache', () => {
  it('identical inputs hit the cache, calling the API only once', async () => {
    const client = mockClient('3');
    const cache = new LruCache<string, ClassifyResult>(10);
    const input = makeInput('test prompt');

    const first = await classify(client, input, 'ai', 'claude-haiku-4-5-20251001', { cache });
    const second = await classify(client, input, 'ai', 'claude-haiku-4-5-20251001', { cache });

    assert.equal((client.messages.create as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
    assert.equal(first.tier, 'opus');
    assert.equal(second.tier, 'opus');
    assert.ok(!first.cached);
    assert.equal(second.cached, true);
  });

  it('different inputs are classified separately', async () => {
    const client = mockClient('2');
    const cache = new LruCache<string, ClassifyResult>(10);
    await classify(client, makeInput('first prompt'), 'ai', 'claude-haiku-4-5-20251001', { cache });
    await classify(client, makeInput('second prompt'), 'ai', 'claude-haiku-4-5-20251001', { cache });
    assert.equal((client.messages.create as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 2);
  });

  it('heuristic fallbacks are not cached', async () => {
    let failures = 0;
    const client = {
      messages: {
        create: mock.fn(async () => {
          failures++;
          throw new Error('down');
        }),
      },
    } as unknown as Anthropic;
    const cache = new LruCache<string, ClassifyResult>(10);
    const input = makeInput('test prompt');
    await classify(client, input, 'ai', 'claude-haiku-4-5-20251001', { cache });
    await classify(client, input, 'ai', 'claude-haiku-4-5-20251001', { cache });
    assert.equal(failures, 2, 'second call should retry the AI, not serve a cached fallback');
    assert.equal(cache.size, 0);
  });

  it('heuristic mode never touches the client', async () => {
    const client = mockClient('3');
    const result = await classify(client, makeInput('translate hello'), 'heuristic', 'claude-haiku-4-5-20251001');
    assert.equal(result.method, 'heuristic');
    assert.equal((client.messages.create as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 0);
  });
});

describe('classifier — custom thresholds honored in AI paths (G2/G3)', () => {
  it('AI verdict respects a custom haikuMax (G2)', async () => {
    // AI "1" → synthetic score 15. With haikuMax=10, 15 is above the haiku
    // cutoff, so the tier must be sonnet — the old hardcoded level→tier map
    // ignored the threshold and always returned haiku.
    const result = await classify(
      mockClient('1'),
      makeInput('test'),
      'ai',
      'claude-haiku-4-5-20251001',
      { haikuMax: 10 },
    );
    assert.equal(result.method, 'ai');
    assert.equal(result.tier, 'sonnet');
  });

  it('AI verdict respects a custom opusMin (G2)', async () => {
    // AI "3" → synthetic score 85. With opusMin=90, 85 is below the opus
    // cutoff → sonnet.
    const result = await classify(
      mockClient('3'),
      makeInput('test'),
      'ai',
      'claude-haiku-4-5-20251001',
      { opusMin: 90 },
    );
    assert.equal(result.tier, 'sonnet');
  });

  it('default thresholds keep the original level→tier mapping', async () => {
    assert.equal((await classify(mockClient('1'), makeInput('t'), 'ai', 'h')).tier, 'haiku');
    assert.equal((await classify(mockClient('2'), makeInput('t'), 'ai', 'h')).tier, 'sonnet');
    assert.equal((await classify(mockClient('3'), makeInput('t'), 'ai', 'h')).tier, 'opus');
  });

  it('AI-failure fallback lands on the gate verdict, not on a hardcoded tier', async () => {
    // `haikuMax`/`opusMin` were score thresholds and no longer have anything to
    // threshold — routing is gate-based. What still matters is that an AI outage
    // degrades to the same decision the heuristic path would have made, rather
    // than to a fixed default.
    const client = { messages: { create: mock.fn(async () => { throw new Error('down'); }) } } as unknown as Anthropic;

    const deep = await classify(
      client,
      makeInput('architect a payment system and prove correctness under partition'),
      'ai',
      'claude-haiku-4-5-20251001',
    );
    assert.equal(deep.method, 'heuristic', 'fell back');
    assert.equal(deep.tier, 'opus', 'an explicit depth request still promotes');

    const trivial = await classify(client, makeInput('translate hello to French'), 'ai', 'claude-haiku-4-5-20251001');
    assert.equal(trivial.method, 'heuristic');
    assert.equal(trivial.tier, 'haiku', 'a mechanical transform still demotes');
  });
});

describe('classifier — cache key uses full text, not a prefix (G4)', () => {
  it('prompts sharing a >500-char prefix but differing later do NOT collide', async () => {
    // Two distinct tasks share a long identical preamble (common in agentic /
    // Claude Code traffic). Hashing only the first 500 chars collided them, so
    // the second served a stale cheap-tier verdict. With full-text hashing the
    // second must be classified on its own merits.
    const prefix = 'context: '.repeat(80); // ~720 chars, identical for both
    const cache = new LruCache<string, ClassifyResult>(10);

    const a = await classify(
      mockClient('1'),
      makeInput(prefix + ' just say hi'),
      'ai',
      'claude-haiku-4-5-20251001',
      { cache },
    );
    const b = await classify(
      mockClient('3'),
      makeInput(prefix + ' architect a fault-tolerant distributed database'),
      'ai',
      'claude-haiku-4-5-20251001',
      { cache },
    );

    assert.equal(a.tier, 'haiku');
    assert.ok(!a.cached);
    assert.equal(b.tier, 'opus', 'second prompt must not be served the first prompt’s cached tier');
    assert.ok(!b.cached, 'second prompt must be a cache miss, not a collision hit');
  });

  it('genuinely identical inputs still hit the cache', async () => {
    const cache = new LruCache<string, ClassifyResult>(10);
    const input = makeInput('x'.repeat(700) + ' analyze this');
    const client = mockClient('2');
    const first = await classify(client, input, 'ai', 'claude-haiku-4-5-20251001', { cache });
    const second = await classify(client, input, 'ai', 'claude-haiku-4-5-20251001', { cache });
    assert.ok(!first.cached);
    assert.equal(second.cached, true);
    assert.equal((client.messages.create as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  });
});

describe('Strategy 1 — task-scored routing + capped harness + agentic floor', () => {
  // A Claude-Code-style harness: long system prompt with expert keywords + many tools.
  const bigSystem = 'You are an expert engineer. Be comprehensive, thorough, and detailed. '.repeat(20);
  const tools = Array.from({ length: 15 }, (_, i) => ({ name: 'tool' + i }));

  it('harness alone (big system + many tools) cannot push a trivial task to opus', () => {
    // This is the money bug: the harness used to add ~+40 → opus on "2+2".
    const score = heuristicScore({
      messages: [{ role: 'user', content: 'what is 2+2?' }],
      system: bigSystem,
      tools,
    });
    assert.notEqual(scoreToTier(score), 'opus', `trivial task must not reach opus, score=${score}`);
  });

  it('scores the LATEST user turn — an earlier hard turn does not inflate a trivial one', () => {
    const score = heuristicScore({
      messages: [
        { role: 'user', content: 'architect a distributed system and prove correctness' },
        { role: 'assistant', content: 'Here is a design ...' },
        { role: 'user', content: 'thanks, now what is 2+2?' },
      ],
    });
    assert.notEqual(scoreToTier(score), 'opus', `latest trivial turn must not inherit earlier complexity, score=${score}`);
  });

  it('floors an agentic trivial turn at sonnet (never haiku by default)', async () => {
    const r = await classify(
      null,
      { messages: [{ role: 'user', content: 'list the files' }], system: bigSystem, tools },
      'heuristic',
      'claude-haiku-4-5',
    );
    // Sonnet is now reached by the agentic gate itself rather than by flooring a
    // haiku verdict after the fact, so `floored` is no longer set on this path.
    // The guarantee that matters — an agentic turn never silently reaches haiku —
    // is unchanged, and the reason records which gate decided it.
    assert.equal(r.tier, 'sonnet');
    assert.equal(r.reason, 'agentic:default');
  });

  it('an in-flight tool_result (no request-level tools) marks the session agentic and floors haiku→sonnet', async () => {
    const r = await classify(
      null,
      {
        messages: [
          { role: 'user', content: 'summarize this' }, // trivial → haiku on its own
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] },
        ],
      },
      'heuristic',
      'claude-haiku-4-5',
    );
    // Last message is a tool_result, so this is the measured mid-loop case.
    assert.equal(r.tier, 'sonnet');
    assert.equal(r.reason, 'agentic:mid-loop');
  });

  it('allowHaikuInAgentic opts out of the floor', async () => {
    const r = await classify(
      null,
      { messages: [{ role: 'user', content: 'list the files' }], tools },
      'heuristic',
      'claude-haiku-4-5',
      { allowHaikuInAgentic: true },
    );
    assert.equal(r.tier, 'haiku');
    assert.ok(!r.floored);
  });

  it('a genuinely hard task still reaches opus despite the harness', async () => {
    const r = await classify(
      null,
      {
        messages: [{ role: 'user', content: 'architect a distributed system and prove correctness under partition' }],
        system: bigSystem,
        tools,
      },
      'heuristic',
      'claude-haiku-4-5',
    );
    assert.equal(r.tier, 'opus');
  });

  it('no tools → no floor; a plain trivial prompt still routes to haiku (API savings intact)', async () => {
    const r = await classify(
      null,
      { messages: [{ role: 'user', content: 'translate hello to French' }] },
      'heuristic',
      'claude-haiku-4-5',
    );
    assert.equal(r.tier, 'haiku');
    assert.ok(!r.floored);
  });
});
