import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ROLE_TIERS,
  ROLES,
  invalidRoleMappings,
  resolveRole,
  roleFromMarker,
  roleFromToolShape,
  roleMarker,
} from '../roles.js';

const ATTRIBUTION = { type: 'text' as const, text: 'x-anthropic-billing-header: claude-code; subagent' };
const tool = (name: string) => ({ name, description: name, input_schema: { type: 'object', properties: {} } });
const READ_ONLY = ['Read', 'Glob', 'Grep'].map(tool);
const WRITER = ['Read', 'Edit', 'Write', 'Bash'].map(tool);

describe('roleFromMarker', () => {
  it('reads the marker from the first line of any system block, after the attribution block', () => {
    const system = [ATTRIBUTION, { type: 'text' as const, text: `${roleMarker('recon')}\nYou are a scout.\n\nWorking directory: /tmp` }];
    assert.equal(roleFromMarker(system), 'recon');
  });

  it('accepts a string system prompt', () => {
    assert.equal(roleFromMarker(`${roleMarker('audit')}\nFalsify the claim.`), 'audit');
  });

  it('ignores a marker that is not at a block start — content cannot forge a boundary', () => {
    const system = [{ type: 'text' as const, text: `Our docs say agents open with ${roleMarker('recon')} on line one.` }];
    assert.equal(roleFromMarker(system), null);
    const later = [{ type: 'text' as const, text: `You are a builder.\n${roleMarker('recon')}` }];
    assert.equal(roleFromMarker(later), null);
  });

  it('returns null for a malformed or unnamed marker', () => {
    assert.equal(roleFromMarker('<!-- claude-router:role= -->\nx'), null);
    assert.equal(roleFromMarker('<!-- claude-router:role=Recon Agent -->\nx'), null);
    assert.equal(roleFromMarker('<!-- claude-router:role=recon\nx'), null, 'unterminated');
    assert.equal(roleFromMarker(undefined), null);
  });

  it('passes through an unknown role name for the config mapping to decide', () => {
    assert.equal(roleFromMarker(`${roleMarker('translator')}\nx`), 'translator');
  });
});

describe('roleFromToolShape', () => {
  it('confirms a read-only agent already on haiku — the cheap direction', () => {
    const d = roleFromToolShape(READ_ONLY, 'claude-haiku-4-5');
    assert.deepEqual(d, { role: 'recon', source: 'shape', tier: 'haiku', reason: 'subagent:readonly-tools', pinned: true });
  });

  it('never demotes a read-only agent on opus — a reviewer and a scout have the same shape', () => {
    const d = roleFromToolShape(READ_ONLY, 'claude-opus-4-8');
    assert.equal(d?.role, 'recon');
    assert.equal(d?.pinned, false);
    assert.equal(d?.tier, undefined);
  });

  it('an unknown (mcp) tool disqualifies the read-only shape', () => {
    assert.equal(roleFromToolShape([...READ_ONLY, tool('mcp__github__search')], 'claude-haiku-4-5'), null);
  });

  it('labels a writer as builder without pinning', () => {
    const d = roleFromToolShape(WRITER, 'claude-sonnet-5');
    assert.equal(d?.role, 'builder');
    assert.equal(d?.pinned, false);
  });

  it('a writer that can also dispatch is not a leaf, so it gets no label', () => {
    assert.equal(roleFromToolShape([...WRITER, tool('Agent')], 'claude-sonnet-5'), null);
  });

  it('needs a non-empty, well-formed tool list', () => {
    assert.equal(roleFromToolShape([], 'claude-haiku-4-5'), null);
    assert.equal(roleFromToolShape(undefined, 'claude-haiku-4-5'), null);
    assert.equal(roleFromToolShape([{ nope: 1 }], 'claude-haiku-4-5'), null);
  });
});

describe('resolveRole', () => {
  const marked = (role: string) => [ATTRIBUTION, { type: 'text' as const, text: `${roleMarker(role)}\nbody` }];

  it('marker wins and maps through DEFAULT_ROLE_TIERS', () => {
    for (const role of ROLES) {
      const d = resolveRole({ system: marked(role), tools: READ_ONLY, requestedModel: 'claude-opus-4-8' });
      assert.equal(d?.tier, DEFAULT_ROLE_TIERS[role], role);
      assert.equal(d?.reason, `role:${role}`);
      assert.equal(d?.source, 'marker');
      assert.equal(d?.pinned, true);
    }
  });

  it('a marked audit agent on opus stays on opus even though its tools are read-only', () => {
    const d = resolveRole({ system: marked('audit'), tools: READ_ONLY, requestedModel: 'claude-opus-4-8' });
    assert.equal(d?.tier, 'opus');
  });

  it('roles config overrides the default tier for a role', () => {
    const d = resolveRole({ system: marked('builder'), tools: WRITER, requestedModel: 'x' }, { roles: { builder: 'opus' } });
    assert.equal(d?.tier, 'opus');
    assert.equal(d?.reason, 'role:builder');
  });

  it('an unknown role with no mapping falls through to the shape rules instead of pinning nothing', () => {
    const d = resolveRole({ system: marked('translator'), tools: READ_ONLY, requestedModel: 'claude-haiku-4-5' });
    assert.equal(d?.source, 'shape');
    assert.equal(d?.tier, 'haiku');
  });

  it('a config typo (not a tier) is skipped, never sent as model: undefined', () => {
    const d = resolveRole({ system: marked('recon'), tools: READ_ONLY, requestedModel: 'claude-opus-4-8' }, { roles: { recon: 'gpt-4' as never } });
    assert.equal(d?.pinned, false, 'fell through to the unpinned shape label');
  });

  it('agent-type mapping pins a third-party agent by name', () => {
    const d = resolveRole(
      { system: 'You review code.', tools: READ_ONLY, requestedModel: 'claude-opus-4-8', agentType: 'some-plugin:reviewer' },
      { agents: { 'some-plugin:reviewer': 'sonnet' } },
    );
    assert.deepEqual(d, { role: 'some-plugin:reviewer', source: 'agent', tier: 'sonnet', reason: 'agent:some-plugin:reviewer', pinned: true });
  });

  it('roles.recon also moves the shape-confirmed tier', () => {
    const d = resolveRole({ system: undefined, tools: READ_ONLY, requestedModel: 'claude-haiku-4-5' }, { roles: { recon: 'sonnet' } });
    assert.equal(d?.tier, 'sonnet');
    assert.equal(d?.source, 'shape');
  });

  it('returns null when nothing structural applies', () => {
    assert.equal(resolveRole({ system: 'plain', tools: undefined, requestedModel: 'x' }), null);
  });
});

describe('invalidRoleMappings', () => {
  it('names the entries whose value is not a tier', () => {
    assert.deepEqual(invalidRoleMappings({ recon: 'haiku', builder: 'gpt-4', gate: 3 }), ['builder: gpt-4', 'gate: 3']);
    assert.deepEqual(invalidRoleMappings(undefined), []);
  });
});
