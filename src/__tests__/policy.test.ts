import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installPolicyPlugin, uninstallPolicyPlugin, policyPluginStatus, PLUGIN_ID, MARKETPLACE_SOURCE, type Exec } from '../proxy/policy.js';

/** A scripted `claude` CLI: answers each call from the queue, records what was asked. */
function scripted(answers: Array<{ ok: boolean; output?: string }>): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const queue = [...answers];
  const exec: Exec = (args) => {
    calls.push(args);
    const next = queue.shift() ?? { ok: true };
    return { ok: next.ok, output: next.output ?? '' };
  };
  return { exec, calls };
}

describe('installPolicyPlugin', () => {
  it('skips (not fails) when the claude CLI is absent, and says how to do it later', () => {
    const { exec } = scripted([{ ok: false, output: 'not found' }]);
    const r = installPolicyPlugin(exec);
    assert.equal(r.ok, false);
    assert.equal(r.skipped, true);
    assert.match(r.detail, new RegExp(`claude plugin install --scope user ${PLUGIN_ID}`));
  });

  it('adds the marketplace then installs, both at user scope', () => {
    const { exec, calls } = scripted([{ ok: true, output: '2.1.300' }, { ok: true }, { ok: true }]);
    const r = installPolicyPlugin(exec);
    assert.equal(r.ok, true);
    assert.deepEqual(calls[1], ['plugin', 'marketplace', 'add', '--scope', 'user', MARKETPLACE_SOURCE]);
    assert.deepEqual(calls[2], ['plugin', 'install', '--scope', 'user', PLUGIN_ID]);
    assert.match(r.detail, /restart Claude Code/);
  });

  it('treats an already-known marketplace or plugin as success', () => {
    const { exec } = scripted([{ ok: true }, { ok: false, output: 'Marketplace already exists' }, { ok: false, output: 'already installed' }]);
    assert.equal(installPolicyPlugin(exec).ok, true);
  });

  it('fails loudly on any other CLI error, quoting its first line', () => {
    const { exec } = scripted([{ ok: true }, { ok: false, output: '\nnetwork unreachable\nmore' }]);
    const r = installPolicyPlugin(exec);
    assert.equal(r.ok, false);
    assert.equal(r.skipped, undefined);
    assert.match(r.detail, /network unreachable/);
  });
});

describe('uninstallPolicyPlugin', () => {
  it('is fine with "not installed", skips without the CLI', () => {
    assert.equal(uninstallPolicyPlugin(scripted([{ ok: true }, { ok: false, output: 'plugin not installed' }]).exec).ok, true);
    assert.equal(uninstallPolicyPlugin(scripted([{ ok: false }]).exec).skipped, true);
  });
});

describe('policyPluginStatus', () => {
  it('reads Claude Code\'s installed_plugins.json without the CLI', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-plugins-'));
    fs.writeFileSync(path.join(dir, 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: { [PLUGIN_ID]: [{ scope: 'user', installPath: '/x', version: '0.3.3' }] },
    }));
    assert.deepEqual(policyPluginStatus(dir), { installed: true, version: '0.3.3', installPath: '/x' });
  });

  it('reports not installed for a missing or foreign registry', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-plugins-'));
    assert.equal(policyPluginStatus(dir).installed, false);
    fs.writeFileSync(path.join(dir, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'other@m': [{ version: '1' }] } }));
    assert.equal(policyPluginStatus(dir).installed, false);
    fs.writeFileSync(path.join(dir, 'installed_plugins.json'), '{');
    assert.equal(policyPluginStatus(dir).installed, false);
  });
});
