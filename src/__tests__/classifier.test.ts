import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import {




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

  it('scores the latest user turn, not the accumulated history', async () => {
    // Regression: buildAISnippet joined every message, so a 700/300-char window
    // over an agentic history handed the meta-classifier harness text instead of
    // the request. The trivial turn below must not be judged on the prior turn.
    const client = mockClient('2');
    const input: ClassifyInput = {
      messages: [
        { role: 'user', content: `HARNESS_NOISE ${'x'.repeat(900)} design a distributed system from scratch` },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: `TOOL_OUTPUT ${'y'.repeat(900)}` },
            { type: 'text', text: 'yo' },
          ],
        },
      ],
    };

    await classifyAI(client, input, 'claude-haiku-4-5-20251001');
    const createMock = client.messages.create as unknown as ReturnType<typeof mock.fn>;
    const params = createMock.mock.calls[0]!.arguments[0] as Anthropic.MessageCreateParamsNonStreaming;
    const prompt = params.messages[0]!.content as string;

    assert.ok(prompt.endsWith('Task: yo'), `expected only the latest turn, got: ${prompt.slice(-120)}`);
    assert.ok(!prompt.includes('HARNESS_NOISE'), 'prior user turn leaked into the snippet');
    assert.ok(!prompt.includes('TOOL_OUTPUT'), 'tool_result leaked into the snippet');
  });

  it('falls back to the joined text when no user turn carries text', async () => {
    const client = mockClient('2');
    const input: ClassifyInput = {
      messages: [
        { role: 'assistant', content: 'ASSISTANT_CONTEXT' },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'tool output' }],
        },
      ],
    };

    await classifyAI(client, input, 'claude-haiku-4-5-20251001');
    const createMock = client.messages.create as unknown as ReturnType<typeof mock.fn>;
    const params = createMock.mock.calls[0]!.arguments[0] as Anthropic.MessageCreateParamsNonStreaming;
    const prompt = params.messages[0]!.content as string;

    assert.ok(prompt.includes('ASSISTANT_CONTEXT'), 'expected the joined-text fallback');
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
    // Gates cannot reproduce it by construction — promotion needs an explicit
    // depth request in the task text, and harness size is not a task signal.
    const r = classifyHeuristic({
      messages: [{ role: 'user', content: 'what is 2+2?' }],
      system: bigSystem,
      tools: tools as never,
    });
    assert.notEqual(r.tier, 'opus', 'trivial task must not reach opus');
  });

  it('reads the LATEST user turn — an earlier hard turn does not inflate a trivial one', () => {
    const r = classifyHeuristic({
      messages: [
        { role: 'user', content: 'architect a distributed system and prove correctness' },
        { role: 'assistant', content: 'Here is a design ...' },
        { role: 'user', content: 'thanks, now what is 2+2?' },
      ],
    });
    assert.notEqual(r.tier, 'opus', 'latest trivial turn must not inherit earlier complexity');
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
