import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { createProxyApp } from '../proxy/server.js';
import { clearAgentRegistry, knownAgentType } from '../proxy/handler.js';
import { DEFAULT_MODELS, TIER_ORDER } from '../models.js';
import { DEFAULT_ROLE_TIERS, ROLES, roleFromMarker } from '../roles.js';

// Compiled tests live at dist/__tests__/, so the repo root is two levels up.
const ROOT = path.join(__dirname, '..', '..');
const PLUGIN = path.join(ROOT, 'plugin');
const NODE = process.execPath;

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
}

/** Minimal frontmatter parser for the agent definitions: `key: value` lines between `---` fences. */
function parseAgent(file: string): { front: Record<string, string>; body: string } {
  // A Windows checkout with autocrlf hands us CRLF; the plugin is LF on disk
  // everywhere else (.gitattributes), and the parser must not care either way.
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(m, `${file} has frontmatter`);
  const front: Record<string, string> = {};
  for (const line of m![1]!.split('\n')) {
    const kv = line.match(/^([a-zA-Z]+):\s*(.*)$/);
    if (kv) front[kv[1]!] = kv[2]!;
  }
  return { front, body: m![2]! };
}

async function liveProxy(config: Parameters<typeof createProxyApp>[0]): Promise<{ port: number; close: () => void }> {
  const app = createProxyApp(config, null);
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
  });
  return { port: (server.address() as AddressInfo).port, close: () => server.close() };
}

// Async on purpose: the proxy under test runs in this process, and a
// synchronous spawn would block the event loop it needs to answer the hook.
function runHook(script: string, env: Record<string, string>, stdin = '{}'): Promise<{ stdout: string; status: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(NODE, [path.join(PLUGIN, 'hooks', script)], {
      env: { ...process.env, ANTHROPIC_BASE_URL: '', CLAUDE_ROUTER_PORT: '', ...env },
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (stdout += c));
    child.on('close', (status) => resolve({ stdout, status }));
    child.stdin.end(stdin);
  });
}

describe('plugin bundle — manifests', () => {
  it('marketplace and plugin manifests parse and agree on the plugin name', () => {
    const marketplace = readJson(path.join(ROOT, '.claude-plugin', 'marketplace.json'));
    const plugin = readJson(path.join(PLUGIN, '.claude-plugin', 'plugin.json'));
    const entries = marketplace['plugins'] as Array<{ name: string; source: string }>;
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.name, plugin['name']);
    assert.equal(entries[0]!.source, './plugin');
  });

  it('the plugin version tracks package.json', () => {
    const plugin = readJson(path.join(PLUGIN, '.claude-plugin', 'plugin.json'));
    const pkg = readJson(path.join(ROOT, 'package.json'));
    assert.equal(plugin['version'], pkg['version'], 'bump plugin/.claude-plugin/plugin.json with the release');
  });

  it('hooks.json points at scripts that exist and use node, not a shell', () => {
    const hooks = readJson(path.join(PLUGIN, 'hooks', 'hooks.json')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    const commands = Object.values(hooks.hooks).flatMap((group) => group.flatMap((g) => g.hooks.map((h) => h.command)));
    assert.equal(commands.length, 2);
    for (const cmd of commands) {
      assert.match(cmd, /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/[a-z-]+\.js"$/, cmd);
      const file = cmd.match(/hooks\/([a-z-]+\.js)/)![1]!;
      assert.ok(fs.existsSync(path.join(PLUGIN, 'hooks', file)), `${file} exists`);
    }
  });

  it('package.json ships the plugin', () => {
    const pkg = readJson(path.join(ROOT, 'package.json')) as { files: string[] };
    assert.ok(pkg.files.includes('plugin') && pkg.files.includes('.claude-plugin'));
  });
});

describe('plugin bundle — agents and policy', () => {
  const files = fs.readdirSync(path.join(PLUGIN, 'agents')).filter((f) => f.endsWith('.md'));

  it('ships exactly the five roles the proxy knows', () => {
    assert.deepEqual(files.map((f) => f.replace(/\.md$/, '')).sort(), [...ROLES].sort());
  });

  for (const file of files) {
    it(`${file}: marker, frontmatter model and DEFAULT_ROLE_TIERS agree`, () => {
      const { front, body } = parseAgent(path.join(PLUGIN, 'agents', file));
      const role = file.replace(/\.md$/, '');
      assert.equal(front['name'], role);
      assert.ok(front['description'], 'has a description');
      // The marker is the first body line — a block-prefix test in the proxy,
      // so anything ahead of it (a `memory:` preamble, a blank line is fine)
      // would silently turn the pin off.
      assert.equal(roleFromMarker(body), role, 'first body line is the role marker');
      // The frontmatter model is the belt-and-braces value when the proxy is
      // down; it must be the same tier the proxy would pin, or the two disagree
      // silently depending on whether the proxy is up.
      assert.ok((TIER_ORDER as string[]).includes(front['model']!), `${front['model']} is a tier`);
      assert.equal(front['model'], DEFAULT_ROLE_TIERS[role as keyof typeof DEFAULT_ROLE_TIERS]);
      assert.ok(body.trim().split('\n').length <= 40, 'body stays short');
    });
  }

  it('read-only roles are enforced by tool allowlist, leaves cannot delegate', () => {
    const recon = parseAgent(path.join(PLUGIN, 'agents', 'recon.md')).front;
    const gate = parseAgent(path.join(PLUGIN, 'agents', 'gate.md')).front;
    assert.equal(recon['tools'], 'Read, Glob, Grep');
    assert.equal(gate['tools'], 'Read, Glob, Grep');
    for (const leaf of ['builder', 'batch', 'audit']) {
      const front = parseAgent(path.join(PLUGIN, 'agents', `${leaf}.md`)).front;
      assert.match(front['disallowedTools'] ?? '', /Agent/, `${leaf} cannot dispatch`);
    }
    assert.match(parseAgent(path.join(PLUGIN, 'agents', 'audit.md')).front['disallowedTools']!, /Edit/, 'audit cannot edit');
  });

  it('the policy stays small — it loads into every session', () => {
    const bytes = fs.statSync(path.join(PLUGIN, 'policy', 'policy.md')).size;
    assert.ok(bytes <= 3000, `policy.md is ${bytes} bytes; cap is 3000`);
    const text = fs.readFileSync(path.join(PLUGIN, 'policy', 'policy.md'), 'utf8').replace(/\r\n/g, '\n');
    for (const role of ROLES) assert.ok(text.includes(`claude-router:${role}`), `policy names ${role}`);
    assert.match(text, /never pass `model`/);
  });
});

describe('plugin bundle — hooks', () => {
  it('sessionstart prints the policy and an "advisory" line when no proxy answers', async () => {
    const { stdout, status } = await runHook('sessionstart.js', { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' });
    assert.equal(status, 0, 'never blocks a session');
    assert.match(stdout, /# Orchestration mode/);
    assert.match(stdout, /claude-router: proxy not reachable on 127\.0\.0\.1:1/);
  });

  it('sessionstart reports "enforcing" against a live proxy with force-route and a pinned session', async () => {
    const proxy = await liveProxy({
      classifier: 'heuristic', defaultModel: DEFAULT_MODELS.sonnet, verbose: false,
      provider: 'anthropic', models: DEFAULT_MODELS, forceRoute: true, sessionModel: 'opus',
    });
    after(() => proxy.close());
    const { stdout, status } = await runHook('sessionstart.js', { CLAUDE_ROUTER_PORT: String(proxy.port) });
    assert.equal(status, 0);
    assert.match(stdout, /claude-router: enforcing — session pinned to opus, subagent roles routed by the proxy/);
  });

  it('sessionstart says so when the proxy is up but not routing', async () => {
    const proxy = await liveProxy({
      classifier: 'heuristic', defaultModel: DEFAULT_MODELS.sonnet, verbose: false,
      provider: 'anthropic', models: DEFAULT_MODELS, forceRoute: false,
    });
    after(() => proxy.close());
    const { stdout } = await runHook('sessionstart.js', { CLAUDE_ROUTER_PORT: String(proxy.port) });
    assert.match(stdout, /up but not routing \(start it with --force-route\)/);
  });

  it('sessionstart starts the proxy itself when nothing answers, then reports enforcing', async () => {
    // A stub `claude-router` binary: `start -d` brings up a /health server on
    // CLAUDE_ROUTER_PORT that looks like a force-routing proxy, detaches, and
    // lives long enough for the hook to see it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-stub-'));
    const stub = path.join(dir, 'stub.js');
    fs.writeFileSync(stub, `
      const http = require('node:http');
      if (process.argv[2] !== 'start' || process.argv[3] !== '-d') process.exit(2);
      const srv = http.createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: 'ok', service: 'claude-router-proxy', forceRoute: true, sessionModel: 'opus', roleRouting: true, version: 'stub' }));
      });
      srv.listen(Number(process.env.CLAUDE_ROUTER_PORT), '127.0.0.1');
      setTimeout(() => process.exit(0), 4000);
    `);
    // A launcher script so CLAUDE_ROUTER_BIN is a single executable path on every OS.
    const launcher = path.join(dir, process.platform === 'win32' ? 'claude-router.cmd' : 'claude-router');
    fs.writeFileSync(launcher, process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${stub}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${stub}" "$@"\n`, { mode: 0o755 });
    const port = await new Promise<number>((resolve) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); });
    });
    const { stdout, status } = await runHook('sessionstart.js', { CLAUDE_ROUTER_PORT: String(port), CLAUDE_ROUTER_BIN: launcher });
    assert.equal(status, 0);
    assert.match(stdout, /claude-router: enforcing — session pinned to opus.*started just now/);
  });

  it('sessionstart honours CLAUDE_ROUTER_NO_AUTOSTART', async () => {
    const { stdout } = await runHook('sessionstart.js', { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', CLAUDE_ROUTER_NO_AUTOSTART: '1', CLAUDE_ROUTER_BIN: '/nonexistent/claude-router' });
    assert.match(stdout, /proxy not reachable/);
  });

  it('subagent-start registers the agent type with the proxy', async () => {
    clearAgentRegistry();
    const proxy = await liveProxy({
      classifier: 'heuristic', defaultModel: DEFAULT_MODELS.sonnet, verbose: false,
      provider: 'anthropic', models: DEFAULT_MODELS, forceRoute: true,
    });
    after(() => proxy.close());
    const { status } = await runHook(
      'subagent-start.js',
      { CLAUDE_ROUTER_PORT: String(proxy.port) },
      JSON.stringify({ session_id: 'sess_9', agent_id: 'agent_9', agent_type: 'my-plugin:reviewer' }),
    );
    assert.equal(status, 0);
    assert.equal(knownAgentType('agent_9'), 'my-plugin:reviewer');
    assert.equal(knownAgentType('agent_unknown'), undefined);
  });

  it('subagent-start ignores malformed input and exits 0', async () => {
    const { status } = await runHook('subagent-start.js', { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' }, 'not json');
    assert.equal(status, 0);
  });
});

describe('POST /api/agents', () => {
  const app = createProxyApp({
    classifier: 'heuristic', defaultModel: DEFAULT_MODELS.sonnet, verbose: false,
    provider: 'anthropic', models: DEFAULT_MODELS, forceRoute: true,
  });

  it('rejects a body without both strings, and a non-POST method', async () => {
    const bad = await app.request('/api/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: 'x' }) });
    assert.equal(bad.status, 400);
    const notJson = await app.request('/api/agents', { method: 'POST', body: '{' });
    assert.equal(notJson.status, 400);
    const get = await app.request('/api/agents');
    assert.equal(get.status, 405, 'the router surface is reserved on every method');
  });

  it('records a well-formed registration', async () => {
    clearAgentRegistry();
    const res = await app.request('/api/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: 'agent_ok', agentType: 'x:y' }) });
    assert.equal(res.status, 204);
    assert.equal(knownAgentType('agent_ok'), 'x:y');
  });
});
