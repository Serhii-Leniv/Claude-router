import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { heuristicScore, scoreToTier, scoreToConfidence, classifyHeuristic, classifyAI, classifyHybrid } from '../classifier.js';
import type { ClassifyInput } from '../types.js';
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
});
