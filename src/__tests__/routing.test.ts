import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { routeByEvidence, isMidLoop, latestUserText, warnDeadRoutingKeys, resetDeadRoutingWarnings } from '../routing.js';
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

describe('routing — dead config knobs are loud, not silent', () => {
  function capture(fn: () => void): string[] {
    resetDeadRoutingWarnings();
    const out: string[] = [];
    const orig = console.warn;
    console.warn = (m: string) => out.push(String(m));
    try { fn(); } finally { console.warn = orig; }
    return out;
  }

  it('warns for each obsolete key', () => {
    const w = capture(() => warnDeadRoutingKeys({ haikuMax: 30, opusMin: 70, hybridBand: [40, 60] }));
    assert.equal(w.length, 3);
    for (const k of ['haikuMax', 'opusMin', 'hybridBand']) {
      assert.ok(w.some((m) => m.includes(`routing.${k}`)), k);
    }
  });

  it('says the routing may have changed, not just that the key is ignored', () => {
    // The dangerous case is an upgrade silently routing differently, so the
    // message has to name that consequence — "ignored" alone understates it.
    const w = capture(() => warnDeadRoutingKeys({ opusMin: 70 }));
    assert.ok(w[0]!.includes('Routing may differ'));
  });

  it('warns once per key, not once per request', () => {
    const w = capture(() => {
      warnDeadRoutingKeys({ haikuMax: 30 });
      warnDeadRoutingKeys({ haikuMax: 30 });
      warnDeadRoutingKeys({ haikuMax: 30 });
    });
    assert.equal(w.length, 1);
  });

  it('stays quiet for a config that uses only live keys', () => {
    const w = capture(() => warnDeadRoutingKeys({ aiTimeoutMs: 2000, classifyCacheSize: 100 }));
    assert.deepEqual(w, []);
  });

  it('stays quiet when routing is absent', () => {
    assert.deepEqual(capture(() => warnDeadRoutingKeys(undefined)), []);
  });
});

describe('routing — harness injection must not decide the tier', () => {
  // Shapes captured from real Claude Code sessions by pointing
  // ANTHROPIC_BASE_URL at a recording upstream. The injected context is always
  // its own text block, ahead of the user's actual text.
  const injected = (userText: string, reminder: string): ClassifyInput => ({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: `<system-reminder>
${reminder}
</system-reminder>` },
          { type: 'text', text: userText },
        ],
      },
    ],
    tools: [{ name: 'Read', description: 'read a file', input_schema: { type: 'object' } }],
  });

  const CLAUDE_MD = 'Contents of CLAUDE.md: a few tests bind a port to exercise the proxy end-to-end.';

  it('does not route a greeting to opus because CLAUDE.md says "end-to-end"', () => {
    const d = routeByEvidence(injected('yo', CLAUDE_MD));
    assert.equal(d.tier, 'sonnet');
    assert.equal(d.reason, 'agentic:default');
  });

  it('drops the injected block out of the task text entirely', () => {
    assert.equal(latestUserText(injected('yo', CLAUDE_MD)), 'yo');
  });

  it('survives injected content that itself contains the closing tag', () => {
    // The regression that killed the first attempt at this fix. A non-greedy
    // regex ends at the FIRST </system-reminder>, and this project's own
    // CLAUDE.md documents the tag — so 13,519 characters of documentation
    // survived the strip and promoted the request to opus. Content cannot be
    // trusted to not mention the delimiter; block boundaries can.
    const selfReferential =
      'CLAUDE.md says: latestUserText strips <system-reminder>...</system-reminder> ' +
      'blocks. It must handle an end-to-end architecture rewrite from scratch.';
    const d = routeByEvidence(injected('yo', selfReferential));
    assert.equal(latestUserText(injected('yo', selfReferential)), 'yo');
    assert.equal(d.tier, 'sonnet');
  });

  it('still promotes when the user themselves asks for depth', () => {
    // The filter must not cost us the real signal: same injected noise, but now
    // the depth marker is in what the user typed.
    const d = routeByEvidence(injected('design a caching system end-to-end', CLAUDE_MD));
    assert.equal(d.tier, 'opus');
    assert.equal(d.reason, 'agentic:depth-requested');
  });

  it('falls back to an earlier turn when the newest carries only injected context', () => {
    const input: ClassifyInput = {
      messages: [
        { role: 'user', content: 'translate hello to French' },
        { role: 'assistant', content: 'Bonjour' },
        { role: 'user', content: [{ type: 'text', text: '<system-reminder>ignore me</system-reminder>' }] },
      ],
    };
    assert.equal(latestUserText(input), 'translate hello to French');
  });

  it('keeps a block that merely mentions the tag mid-sentence', () => {
    // Only a block that IS the injection is dropped. A user asking about the
    // tag is asking a real question.
    const input: ClassifyInput = {
      messages: [{ role: 'user', content: 'why does <system-reminder> appear in my logs?' }],
    };
    assert.ok(latestUserText(input).includes('why does'));
  });
});
