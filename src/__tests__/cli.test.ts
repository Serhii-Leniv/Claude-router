import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { readLogTail, startServer } from '../proxy/cli.js';
import { createProxyApp } from '../proxy/server.js';
import { DEFAULT_MODELS } from '../models.js';

const config = {
  classifier: 'heuristic' as const,
  defaultModel: DEFAULT_MODELS.sonnet,
  verbose: false,
  provider: 'anthropic' as const,
  models: DEFAULT_MODELS,
  forceRoute: false,
};

describe('readLogTail', () => {
  function tempLog(content: string): string {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crouter-cli-')), 'proxy.log');
    fs.writeFileSync(file, content, 'utf8');
    return file;
  }

  it('reads only the last maxBytes of a large file', () => {
    const file = tempLog('a'.repeat(1000) + 'THE-TAIL');
    const { text, size } = readLogTail(file, null, 100);
    assert.equal(size, 1008);
    assert.equal(text.length, 100);
    assert.ok(text.endsWith('THE-TAIL'));
  });

  it('follow mode reads only the appended range', () => {
    const file = tempLog('first\n');
    const { size } = readLogTail(file, null);
    fs.appendFileSync(file, 'second\n', 'utf8');
    const next = readLogTail(file, size);
    assert.equal(next.text, 'second\n');
  });

  it('resets to a fresh tail when the file shrank (rotation)', () => {
    const file = tempLog('a long first generation of log content\n');
    const { size } = readLogTail(file, null);
    fs.writeFileSync(file, 'new\n', 'utf8'); // rotated/truncated under the follower
    const next = readLogTail(file, size);
    assert.equal(next.text, 'new\n', 'must re-tail instead of going silent');
    assert.equal(next.size, 4);
  });

  it('returns empty for a missing file', () => {
    assert.deepEqual(readLogTail(path.join(os.tmpdir(), 'nope', 'missing.log'), null), { text: '', size: 0 });
  });
});

describe('startServer', () => {
  it('reports EADDRINUSE through the fatal path instead of an uncaught stack', async () => {
    // Occupy a port with a plain http server…
    const blocker = http.createServer(() => {});
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    after(() => blocker.close());
    const port = (blocker.address() as AddressInfo).port;

    // …then bind the proxy to the same port and expect the clean failure path.
    const fatalCode = await new Promise<number>((resolve) => {
      const server = startServer(createProxyApp(config), port, '127.0.0.1', (code) => {
        server.close();
        resolve(code);
      });
    });

    assert.equal(fatalCode, 1);
  });

  it('binds, serves, and closes cleanly on a free port', async () => {
    const server = startServer(createProxyApp(config), 0, '127.0.0.1', () => {
      assert.fail('fatal path must not fire on a clean bind');
    });
    after(() => server.close());

    // serve() binds asynchronously; poll until the address is populated.
    while (!server.address()) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
  });
});
