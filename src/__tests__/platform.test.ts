import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type { RouterPaths } from '../proxy/cli-config.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPlist,
  buildRcBlock,
  buildRunKeyCommand,
  buildStatuslineCommand,
  buildSystemdUnit,
  isOurStatusline,
  removeRcBlock,
  setClaudeCodeEnv,
  unsetClaudeCodeEnv,
  isClaudeCodeEnvSet
} from '../proxy/platform.js';

describe('buildPlist', () => {
  it('contains node path, cli path, and args as strings', () => {
    const plist = buildPlist('/usr/local/bin/node', '/opt/app/cli.js', ['--port', '4000'], '/home/u/.claude-router/proxy.log');
    assert.ok(plist.includes('<string>/usr/local/bin/node</string>'));
    assert.ok(plist.includes('<string>/opt/app/cli.js</string>'));
    assert.ok(plist.includes('<string>start</string>'));
    assert.ok(plist.includes('<string>--port</string>'));
    assert.ok(plist.includes('<string>4000</string>'));
    assert.ok(plist.includes('proxy.log'));
  });

  it('escapes XML-special characters in paths', () => {
    const plist = buildPlist('/node', '/path/with <weird> & "chars"/cli.js', [], '/log');
    assert.ok(plist.includes('&lt;weird&gt; &amp; &quot;chars&quot;'));
    assert.ok(!plist.includes('<weird>'));
  });
});

describe('buildRunKeyCommand', () => {
  it('quotes paths with spaces and includes --daemon', () => {
    const cmd = buildRunKeyCommand(
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Users\\Some User\\cli.js',
      ['--port', '4000', '--force-route'],
    );
    assert.ok(cmd.startsWith('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Some User\\cli.js" start --daemon'));
    assert.ok(cmd.includes('--port 4000'));
    assert.ok(cmd.includes('--force-route'));
  });
});

describe('buildSystemdUnit', () => {
  it('has a correct ExecStart line', () => {
    const unit = buildSystemdUnit('/usr/bin/node', '/opt/cli.js', ['--port', '4000']);
    assert.ok(unit.includes('ExecStart=/usr/bin/node /opt/cli.js start --port 4000'));
    assert.ok(unit.includes('WantedBy=default.target'));
  });

  it('quotes arguments containing spaces', () => {
    const unit = buildSystemdUnit('/usr/bin/node', '/opt/my app/cli.js', []);
    assert.ok(unit.includes('"/opt/my app/cli.js"'));
  });
});

describe('rc block', () => {
  it('is marker-delimited and removable', () => {
    const block = buildRcBlock(4000);
    assert.ok(block.includes('export ANTHROPIC_BASE_URL=http://localhost:4000'));
    const content = `# my stuff\nalias ll='ls -la'\n${block}\n# more`;
    const cleaned = removeRcBlock(content);
    assert.ok(!cleaned.includes('ANTHROPIC_BASE_URL'));
    assert.ok(!cleaned.includes('claude-router'));
    assert.ok(cleaned.includes("alias ll='ls -la'"));
    assert.ok(cleaned.includes('# more'));
  });

  it('removes blocks written for any port', () => {
    const content = `pre\n${buildRcBlock(9999)}\npost`;
    const cleaned = removeRcBlock(content);
    assert.ok(!cleaned.includes('9999'));
    assert.ok(cleaned.includes('pre') && cleaned.includes('post'));
  });

  it('removes the legacy single-marker format', () => {
    const content = `pre\n# claude-router\nexport ANTHROPIC_BASE_URL=http://localhost:4000\npost`;
    const cleaned = removeRcBlock(content);
    assert.ok(!cleaned.includes('ANTHROPIC_BASE_URL'));
    assert.ok(!cleaned.includes('# claude-router'));
    assert.ok(cleaned.includes('pre') && cleaned.includes('post'));
  });
});

describe('statusline', () => {
  it('uses a curl one-liner to 127.0.0.1 /statusline (no node/python/jq)', () => {
    const cmd = buildStatuslineCommand(4321);
    assert.ok(cmd.startsWith('curl'));
    assert.ok(cmd.includes('http://127.0.0.1:4321/statusline'));
    assert.ok(cmd.includes('[auto:off]')); // down-daemon fallback
    assert.ok(!cmd.includes('node'));
    assert.ok(!cmd.includes('python'));
    assert.ok(!cmd.includes('jq'));
  });

  it('is JSON-embedding safe (no double quotes, round-trips)', () => {
    const cmd = buildStatuslineCommand(4000);
    // No double quotes to escape when it lives in settings.json.
    assert.equal((cmd.match(/"/g) ?? []).length, 0);
    // Round-trips through JSON (as it will live in settings.json)
    assert.equal(JSON.parse(JSON.stringify(cmd)), cmd);
  });

  it('recognizes current and both legacy installed commands', () => {
    assert.ok(isOurStatusline(buildStatuslineCommand(4000)));
    // Legacy curl+python form (predates the node version).
    const legacyCurl =
      `curl -sf --max-time 0.3 http://localhost:4000/health | python3 -c "import sys,json; d=json.load(sys.stdin); t=d.get('lastTier') or 'ready'; r=d.get('requests',0); print(f'[auto:{t} #{r}]')" 2>/dev/null || echo '[auto:off]'`;
    assert.ok(isOurStatusline(legacyCurl));
    // Legacy node form — users who installed before the shell switch must still
    // be recognized so `uninstall` can remove it.
    const legacyNode =
      `node -e "fetch('http://127.0.0.1:4000/health',{signal:AbortSignal.timeout(300)}).then(r=>r.json()).then(d=>console.log('[auto:'+(d.lastTier??'ready')+' #'+d.requests+']')).catch(()=>console.log('[auto:off]'))"`;
    assert.ok(isOurStatusline(legacyNode));
    assert.ok(!isOurStatusline('my-custom-statusline --fancy'));
  });
});

describe('Claude Code settings env', () => {
  function tmpPaths() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-settings-'));
    return { paths: { claudeSettingsFile: path.join(dir, 'settings.json') } as RouterPaths, dir };
  }

  it('writes env.ANTHROPIC_BASE_URL and leaves everything else in settings.json alone', () => {
    const { paths } = tmpPaths();
    fs.writeFileSync(paths.claudeSettingsFile, JSON.stringify({ model: 'opus', env: { FOO: 'bar' }, statusLine: { type: 'command', command: 'x' } }));
    const r = setClaudeCodeEnv(4000, paths);
    assert.equal(r.ok, true);
    const s = JSON.parse(fs.readFileSync(paths.claudeSettingsFile, 'utf8')) as { model: string; env: Record<string, string>; statusLine: unknown };
    assert.equal(s.env['ANTHROPIC_BASE_URL'], 'http://127.0.0.1:4000');
    assert.equal(s.env['FOO'], 'bar');
    assert.equal(s.model, 'opus');
    assert.ok(s.statusLine);
    assert.equal(isClaudeCodeEnvSet(4000, paths), true);
    assert.equal(isClaudeCodeEnvSet(4100, paths), false);
  });

  it('creates settings.json when absent', () => {
    const { paths } = tmpPaths();
    assert.equal(setClaudeCodeEnv(4100, paths).ok, true);
    assert.equal(isClaudeCodeEnvSet(4100, paths), true);
  });

  it('never overwrites a base URL that points somewhere else', () => {
    const { paths } = tmpPaths();
    fs.writeFileSync(paths.claudeSettingsFile, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://gateway.example' } }));
    const r = setClaudeCodeEnv(4000, paths);
    assert.equal(r.skipped, true);
    assert.equal(isClaudeCodeEnvSet(4000, paths), false);
    assert.equal(unsetClaudeCodeEnv(paths).skipped, true, 'and does not remove it either');
  });

  it('unset removes only our entry, dropping an emptied env block', () => {
    const { paths } = tmpPaths();
    setClaudeCodeEnv(4000, paths);
    assert.equal(unsetClaudeCodeEnv(paths).ok, true);
    const s = JSON.parse(fs.readFileSync(paths.claudeSettingsFile, 'utf8')) as Record<string, unknown>;
    assert.ok(!('env' in s));
    fs.writeFileSync(paths.claudeSettingsFile, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://localhost:4000', KEEP: '1' } }));
    unsetClaudeCodeEnv(paths);
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.claudeSettingsFile, 'utf8')), { env: { KEEP: '1' } });
  });
});
