import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { serve } from '@hono/node-server';
import { routerPaths } from '../proxy/cli-config.js';
import {
  checkHealth,
  clearDaemonState,
  isProcessAlive,
  readDaemonState,
  writeDaemonState,
} from '../proxy/daemon.js';
import { createProxyApp } from '../proxy/server.js';
import { DEFAULT_MODELS } from '../models.js';

function tempPaths() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crouter-daemon-'));
  return { home, paths: routerPaths(home) };
}

describe('daemon state file', () => {
  it('round-trips state', () => {
    const { home, paths } = tempPaths();
    const state = { pid: 12345, port: 4000, startedAt: '2026-07-02T00:00:00Z', args: ['--port', '4000'] };
    writeDaemonState(state, paths);
    assert.deepEqual(readDaemonState(paths), state);
    clearDaemonState(paths);
    assert.equal(readDaemonState(paths), null);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('returns null for missing or corrupt state', () => {
    const { home, paths } = tempPaths();
    assert.equal(readDaemonState(paths), null);
    fs.mkdirSync(paths.configDir, { recursive: true });
    fs.writeFileSync(paths.daemonStateFile, 'not json', 'utf8');
    assert.equal(readDaemonState(paths), null);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('isProcessAlive', () => {
  it('true for the current process', () => {
    assert.equal(isProcessAlive(process.pid), true);
  });

  it('false for a dead pid', () => {
    // PIDs near the max are vanishingly unlikely to be live in CI
    assert.equal(isProcessAlive(2 ** 22 - 7), false);
  });
});

describe('checkHealth', () => {
  it('returns health info from a live proxy and null otherwise', async () => {
    const app = createProxyApp({
      classifier: 'heuristic',
      defaultModel: DEFAULT_MODELS.sonnet,
      verbose: false,
      provider: 'anthropic',
      models: DEFAULT_MODELS,
      forceRoute: true,
    });

    const server = serve({ fetch: app.fetch, port: 0 });
    after(() => server.close());
    const port = (server.address() as { port: number }).port;

    const health = await checkHealth(port);
    assert.ok(health);
    assert.equal(health.service, 'claude-router-proxy');
    assert.equal(health.forceRoute, true);

    const dead = await checkHealth(port === 4999 ? 5001 : 4999, 300);
    assert.equal(dead, null);
  });
});
