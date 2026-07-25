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
  resolveStatusPort,
  statusPid,
  stoppedStatusDetail,
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

describe('resolveStatusPort — #39', () => {
  it('falls back to the resolved default when there is no daemon state', () => {
    assert.deepEqual(resolveStatusPort(4000, false, null), { port: 4000, source: 'default' });
  });

  it('prefers the daemon-recorded port over a free default', () => {
    // The bug: a daemon on 4300 is invisible because status only probed 4000.
    assert.deepEqual(
      resolveStatusPort(4000, false, { port: 4300 }),
      { port: 4300, source: 'daemon' },
    );
  });

  it('stays on the resolved port when daemon.json agrees with it', () => {
    assert.deepEqual(
      resolveStatusPort(4300, false, { port: 4300 }),
      { port: 4300, source: 'default' },
    );
  });

  it('honours an explicit --port over the daemon-recorded port', () => {
    // Flags always win: the user asked about 5000, so probe 5000.
    assert.deepEqual(
      resolveStatusPort(5000, true, { port: 4300 }),
      { port: 5000, source: 'flag' },
    );
  });

  it('reports an explicit --port as its own source with no state', () => {
    assert.deepEqual(resolveStatusPort(5000, true, null), { port: 5000, source: 'flag' });
  });
});

describe('stoppedStatusDetail — #39', () => {
  it('names daemon.json as the source for a daemon-recorded port', () => {
    const detail = stoppedStatusDetail({ port: 4300, source: 'daemon' });
    assert.equal(detail, 'no proxy on port 4300 (from daemon.json)');
  });

  it('hints at --port when only the default was checked', () => {
    const detail = stoppedStatusDetail({ port: 4000, source: 'default' });
    assert.equal(detail, 'no proxy on port 4000 — pass --port if it is running elsewhere');
  });

  it('drops the hint when the user already named the port', () => {
    assert.equal(stoppedStatusDetail({ port: 5000, source: 'flag' }), 'no proxy on port 5000');
  });
});

describe('statusPid — #52', () => {
  it('names the pid when the daemon owns the port that answered', () => {
    assert.equal(statusPid({ port: 4300, source: 'daemon' }, { pid: 4242, port: 4300 }), 4242);
  });

  it('withholds the pid when another port was probed', () => {
    // The bug: `status --port 5000` credited the 4300 daemon's pid to whatever
    // answered on 5000.
    assert.equal(statusPid({ port: 5000, source: 'flag' }, { pid: 4242, port: 4300 }), null);
  });

  it('has no pid to name without daemon state', () => {
    assert.equal(statusPid({ port: 4000, source: 'default' }, null), null);
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
