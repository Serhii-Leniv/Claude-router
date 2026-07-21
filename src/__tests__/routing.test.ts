import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { routeByEvidence, isMidLoop } from '../routing.js';
import type { ClassifyInput } from '../types.js';

const one = (text: string, extra: Partial<ClassifyInput> = {}): ClassifyInput => ({
  messages: [{ role: 'user', content: text }],
  ...extra,
});

describe('routing — the additive-score regression', () => {
  it('does not send a beginner numpy question to opus', () => {
    // Under the old additive score this was BASE 35 + matrix 25 + determinant 25
    // = 85 -> opus. Neither word is evidence of difficulty; summing them was.
    const r = routeByEvidence(one('How do I compute a determinant of a matrix in numpy?'));
    assert.notEqual(r.tier, 'opus');
    assert.equal(r.tier, 'sonnet');
  });

  it('does not promote on an incidental domain word', () => {
    for (const text of [
      'is Amazon Prime worth it for a small team',
      'write a blog post about quantum computing for beginners',
    ]) {
      assert.notEqual(routeByEvidence(one(text)).tier, 'opus', text);
    }
  });
});

describe('routing — haiku gate is conjunctive', () => {
  it('demotes a short mechanical transform', () => {
    const r = routeByEvidence(one('translate this to French: hello'));
    assert.equal(r.tier, 'haiku');
  });

  it('same verb, large object: stays on sonnet', () => {
    // The failure the old score could not express — "translate" scored the same
    // whether the object was a word or a contract.
    const r = routeByEvidence(one(`translate this contract into Japanese: ${'x'.repeat(500)}`));
    assert.equal(r.tier, 'sonnet');
  });

  it('absence of complexity is not evidence of simplicity', () => {
    // "hi" clears every negative condition but supplies no positive signal.
    assert.equal(routeByEvidence(one('hi')).tier, 'sonnet');
  });

  it('a conversation is never demoted, however short the last turn', () => {
    const r = routeByEvidence({
      messages: [
        { role: 'user', content: 'here is my architecture' },
        { role: 'assistant', content: 'noted' },
        { role: 'user', content: 'list the risks' },
      ],
    });
    assert.equal(r.tier, 'sonnet');
  });

  it('a code fence disqualifies', () => {
    assert.equal(routeByEvidence(one('reformat this\n```js\nconst a=1\n```')).tier, 'sonnet');
  });

  it('tool definitions disqualify outside the agentic opt-in', () => {
    const r = routeByEvidence(
      one('list the files', { tools: [{ name: 't', input_schema: { type: 'object' } }] as never }),
    );
    assert.notEqual(r.tier, 'haiku');
  });
});

describe('routing — agentic branch', () => {
  const withTools = { tools: [{ name: 't', input_schema: { type: 'object' } }] as never };

  it('detects mid-loop from a trailing tool_result', () => {
    const input: ClassifyInput = {
      messages: [
        { role: 'user', content: 'find the bug' },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] },
      ],
    };
    assert.equal(isMidLoop(input), true);
    const r = routeByEvidence(input);
    assert.equal(r.tier, 'sonnet');
    assert.equal(r.reason, 'agentic:mid-loop');
  });

  it('a fresh instruction in a tool session is not mid-loop', () => {
    const r = routeByEvidence(one('now summarise what you found', withTools));
    assert.equal(r.reason, 'agentic:default');
  });

  it('an explicit depth request still promotes despite the harness', () => {
    const r = routeByEvidence(one('architect a replacement and prove correctness', withTools));
    assert.equal(r.tier, 'opus');
  });
});

describe('routing — fable is opt-in', () => {
  const superHard = 'architect a replacement and rewrite the entire pipeline from scratch';

  it('never reached without allowFable, however strong the signal', () => {
    assert.notEqual(routeByEvidence(one(superHard)).tier, 'fable');
  });

  it('reachable once enabled, and only on depth AND long-horizon together', () => {
    assert.equal(routeByEvidence(one(superHard), { allowFable: true }).tier, 'fable');
    // Depth alone is opus, not fable — fable is 2x opus and needs both signals.
    assert.equal(
      routeByEvidence(one('prove this algorithm is correct'), { allowFable: true }).tier,
      'opus',
    );
  });
});
