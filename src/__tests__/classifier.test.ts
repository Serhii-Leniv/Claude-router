import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { heuristicScore, scoreToTier, classifyHeuristic } from '../classifier.js';
import type { ClassifyInput } from '../types.js';

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
});

describe('classifyHeuristic', () => {
  it('returns full ClassifyResult', () => {
    const result = classifyHeuristic(makeInput('translate hello'));
    assert.equal(result.method, 'heuristic');
    assert.equal(typeof result.score, 'number');
    assert.equal(typeof result.ms, 'number');
    assert.ok(result.ms >= 0);
    assert.ok(['haiku', 'sonnet', 'opus'].includes(result.tier));
  });
});
