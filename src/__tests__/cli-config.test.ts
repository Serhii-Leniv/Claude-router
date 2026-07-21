import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  CliUsageError,
  getVersion,
  loadFileConfig,
  parseServeArgs,
  routerPaths,
  serveArgsFrom,
  suggestCommand,
} from '../proxy/cli-config.js';

describe('parseServeArgs', () => {
  it('applies defaults with no args and no file config', () => {
    const opts = parseServeArgs([]);
    assert.equal(opts.port, 4000);
    assert.equal(opts.host, '127.0.0.1', 'must bind local-only by default');
    assert.equal(opts.classifier, 'hybrid');
    assert.equal(opts.provider, 'anthropic');
    assert.equal(opts.forceRoute, false);
  });

  it('parses --host and file-config host', () => {
    assert.equal(parseServeArgs(['--host', '0.0.0.0']).host, '0.0.0.0');
    assert.equal(parseServeArgs([], { host: '0.0.0.0' }).host, '0.0.0.0');
    assert.equal(parseServeArgs(['--host', '127.0.0.1'], { host: '0.0.0.0' }).host, '127.0.0.1');
    assert.throws(() => parseServeArgs(['--host']), CliUsageError);
  });

  it('file config supplies defaults; flags override', () => {
    const file = { port: 5000, classifier: 'heuristic' as const, forceRoute: true };
    const fromFile = parseServeArgs([], file);
    assert.equal(fromFile.port, 5000);
    assert.equal(fromFile.classifier, 'heuristic');
    assert.equal(fromFile.forceRoute, true);

    const overridden = parseServeArgs(['--port', '6000', '--classifier', 'ai'], file);
    assert.equal(overridden.port, 6000);
    assert.equal(overridden.classifier, 'ai');
    assert.equal(overridden.forceRoute, true, 'un-overridden file values stay');
  });

  it('rejects invalid port', () => {
    assert.throws(() => parseServeArgs(['--port', 'abc']), CliUsageError);
    assert.throws(() => parseServeArgs(['--port', '0']), CliUsageError);
    assert.throws(() => parseServeArgs(['--port', '70000']), CliUsageError);
  });

  it('rejects invalid classifier (same as provider)', () => {
    assert.throws(() => parseServeArgs(['--classifier', 'bogus']), CliUsageError);
    assert.throws(() => parseServeArgs(['--provider', 'bogus']), CliUsageError);
  });

  it('rejects unknown flags', () => {
    assert.throws(() => parseServeArgs(['--nope']), CliUsageError);
  });

  it('parses all valid flags', () => {
    const opts = parseServeArgs([
      '--port', '4100', '--verbose', '--classifier', 'heuristic',
      '--provider', 'bedrock', '--region', 'eu-west-1', '--force-route',
    ]);
    assert.deepEqual(
      { ...opts, tiers: undefined, pricing: undefined, routing: undefined },
      {
        port: 4100, host: '127.0.0.1', verbose: true, classifier: 'heuristic', provider: 'bedrock',
        region: 'eu-west-1', forceRoute: true, upstream: 'https://api.anthropic.com',
        tiers: undefined, pricing: undefined, routing: undefined,
      },
    );
  });

  it('defaults upstream to the real API and never reads it from the environment', () => {
    // The 0.2.1 self-recursion bug was an inherited ANTHROPIC_BASE_URL. An
    // explicit flag is safe precisely because nothing can set it implicitly.
    const before = process.env['ANTHROPIC_BASE_URL'];
    process.env['ANTHROPIC_BASE_URL'] = 'http://127.0.0.1:4000';
    try {
      assert.equal(parseServeArgs([]).upstream, 'https://api.anthropic.com');
    } finally {
      if (before === undefined) delete process.env['ANTHROPIC_BASE_URL'];
      else process.env['ANTHROPIC_BASE_URL'] = before;
    }
  });

  it('accepts an explicit --upstream and round-trips it through spawn args', () => {
    const opts = parseServeArgs(['--upstream', 'http://127.0.0.1:9999']);
    assert.equal(opts.upstream, 'http://127.0.0.1:9999');
    assert.equal(parseServeArgs(serveArgsFrom(opts)).upstream, 'http://127.0.0.1:9999');
  });

  it('omits --upstream from spawn args when it is the default', () => {
    assert.ok(!serveArgsFrom(parseServeArgs([])).includes('--upstream'));
  });
});

describe('serveArgsFrom', () => {
  it('round-trips through parseServeArgs', () => {
    const original = parseServeArgs(['--port', '4200', '--force-route', '--classifier', 'ai', '--host', '0.0.0.0']);
    const rebuilt = parseServeArgs(serveArgsFrom(original));
    assert.equal(rebuilt.port, 4200);
    assert.equal(rebuilt.forceRoute, true);
    assert.equal(rebuilt.classifier, 'ai');
    assert.equal(rebuilt.host, '0.0.0.0');
  });

  it('omits --host for the default bind', () => {
    const args = serveArgsFrom(parseServeArgs([]));
    assert.ok(!args.includes('--host'));
  });
});

describe('loadFileConfig', () => {
  it('reports invalid JSON without throwing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crouter-'));
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, '{not json', 'utf8');
    const result = loadFileConfig(file);
    assert.equal(result.loaded, false);
    assert.ok(result.error);
    assert.deepEqual(result.config, {});
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('loads valid config', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crouter-'));
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ port: 4321 }), 'utf8');
    const result = loadFileConfig(file);
    assert.equal(result.loaded, true);
    assert.equal(result.config.port, 4321);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('missing file is not an error', () => {
    const result = loadFileConfig(path.join(os.tmpdir(), 'does-not-exist', 'config.json'));
    assert.equal(result.loaded, false);
    assert.equal(result.error, undefined);
  });
});

describe('suggestCommand', () => {
  const commands = ['start', 'stop', 'status', 'install', 'uninstall', 'doctor'];

  it('suggests for close typos', () => {
    assert.equal(suggestCommand('installl', commands), 'install');
    assert.equal(suggestCommand('statis', commands), 'status');
    assert.equal(suggestCommand('stpo', commands), 'stop');
  });

  it('returns null for distant input', () => {
    assert.equal(suggestCommand('frobnicate', commands), null);
  });
});

describe('getVersion', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { version: string };
    assert.equal(getVersion(), pkg.version);
  });
});

describe('routerPaths', () => {
  it('derives all paths from the home dir', () => {
    const p = routerPaths('/fake/home');
    assert.ok(p.configFile.includes('.claude-router'));
    assert.ok(p.daemonStateFile.endsWith('daemon.json'));
    assert.ok(p.logFile.endsWith('proxy.log'));
    assert.ok(p.plistFile.includes('LaunchAgents'));
  });
});
