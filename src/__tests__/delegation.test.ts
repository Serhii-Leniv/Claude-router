import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DELEGATION_BLOCKERS,
  stripDelegationBlockers,
  describeStrip,
} from '../proxy/delegation.js';

const [AGENT_LINE, WORKFLOW_LINE] = DELEGATION_BLOCKERS as [string, string];

// The payload as Claude Code 2.1.220 actually renders it: two lines at the end
// of a long system prompt, not a standalone block.
const REAL_SYSTEM = [
  'You are Claude Code, Anthropic official CLI for Claude.',
  '',
  '# Delivering work',
  'Do ordinary work as asked, acting on the actual request.',
  '',
  AGENT_LINE,
  WORKFLOW_LINE,
].join('\n');

describe('stripDelegationBlockers — string system', () => {
  it('removes both injected lines and keeps everything else byte-identical', () => {
    const { system, removed } = stripDelegationBlockers(REAL_SYSTEM);
    assert.equal(removed, 2);
    assert.equal(
      system,
      [
        'You are Claude Code, Anthropic official CLI for Claude.',
        '',
        '# Delivering work',
        'Do ordinary work as asked, acting on the actual request.',
        '',
      ].join('\n'),
    );
  });

  it('is deterministic — the same input always yields the same output (cache stability)', () => {
    const a = stripDelegationBlockers(REAL_SYSTEM).system;
    const b = stripDelegationBlockers(REAL_SYSTEM).system;
    assert.equal(a, b);
  });

  it('returns the original reference untouched when the payload is absent', () => {
    const clean = 'You are a helpful assistant.';
    const { system, removed } = stripDelegationBlockers(clean);
    assert.equal(removed, 0);
    assert.equal(system, clean);
  });

  it('tolerates surrounding indentation on the injected line', () => {
    const { removed } = stripDelegationBlockers(`intro\n   ${AGENT_LINE}   \noutro`);
    assert.equal(removed, 1);
  });
});

describe('stripDelegationBlockers — block-array system', () => {
  it('edits only the block that carries the payload', () => {
    const system = [
      { type: 'text', text: 'stable preamble', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: `guidance\n${AGENT_LINE}` },
    ];
    const { system: out, removed } = stripDelegationBlockers(system) as {
      system: Array<Record<string, unknown>>;
      removed: number;
    };
    assert.equal(removed, 1);
    assert.deepEqual(out[0], system[0], 'untouched block must keep its cache_control');
    assert.equal(out[1]!['text'], 'guidance');
  });

  it('drops a block that becomes empty rather than forwarding one the API rejects', () => {
    const system = [
      { type: 'text', text: 'keep me' },
      { type: 'text', text: `${AGENT_LINE}\n${WORKFLOW_LINE}` },
    ];
    const { system: out, removed } = stripDelegationBlockers(system) as {
      system: unknown[];
      removed: number;
    };
    assert.equal(removed, 2);
    assert.equal(out.length, 1);
  });

  it('leaves non-text blocks alone', () => {
    const system = [{ type: 'image', source: { type: 'base64', data: 'x' } }];
    const { system: out, removed } = stripDelegationBlockers(system);
    assert.equal(removed, 0);
    assert.equal(out, system);
  });
});

// The regression this repo has already shipped twice in a different form (#34):
// a text rule that reaches into content it should not own.
describe('stripDelegationBlockers — does not damage content that merely mentions the payload', () => {
  it('keeps a line that quotes the payload inside a sentence', () => {
    const prose = `The docs say "${AGENT_LINE}" which is why delegation stopped.`;
    const { system, removed } = stripDelegationBlockers(prose);
    assert.equal(removed, 0, 'a quoted mention is discussion, not the injected directive');
    assert.equal(system, prose);
  });

  it('never touches messages or tools — it only ever receives `system`', () => {
    // Guards the call contract: the handler passes body.system, nothing else.
    const notASystemField = { messages: [{ role: 'user', content: AGENT_LINE }] };
    const { system, removed } = stripDelegationBlockers(notASystemField);
    assert.equal(removed, 0);
    assert.equal(system, notASystemField);
  });
});

describe('describeStrip', () => {
  it('reports the no-match case as clearly as the match case', () => {
    // A vendor payload change must not read as success.
    assert.match(describeStrip(0), /not present|nothing removed/i);
    assert.match(describeStrip(2), /removed 2/);
    assert.match(describeStrip(1), /removed 1 injected anti-delegation line\b/);
  });
});
