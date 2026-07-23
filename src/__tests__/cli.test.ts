import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { startServer } from '../proxy/cli.js';
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
