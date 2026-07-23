import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { rotateLogIfLarge, MAX_LOG_BYTES } from '../proxy/log-rotate.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'crouter-logrot-'));
}

describe('rotateLogIfLarge', () => {
  it('rotates a file over the cap to .1 and clears the primary path', () => {
    const dir = tempDir();
    const logPath = path.join(dir, 'proxy.log');
    fs.writeFileSync(logPath, 'x'.repeat(2048));

    const rotated = rotateLogIfLarge(logPath, 1024);

    assert.equal(rotated, true);
    assert.equal(fs.existsSync(logPath), false);
    assert.equal(fs.existsSync(`${logPath}.1`), true);
    assert.equal(fs.readFileSync(`${logPath}.1`, 'utf8').length, 2048);

    // A fresh log is created on the next append, bounded again.
    fs.appendFileSync(logPath, 'new');
    assert.equal(fs.readFileSync(logPath, 'utf8'), 'new');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('leaves an under-cap file untouched', () => {
    const dir = tempDir();
    const logPath = path.join(dir, 'proxy.log');
    fs.writeFileSync(logPath, 'small');

    const rotated = rotateLogIfLarge(logPath, 1024);

    assert.equal(rotated, false);
    assert.equal(fs.existsSync(logPath), true);
    assert.equal(fs.existsSync(`${logPath}.1`), false);
    assert.equal(fs.readFileSync(logPath, 'utf8'), 'small');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('replaces a previous .1 backup on the next rotation', () => {
    const dir = tempDir();
    const logPath = path.join(dir, 'proxy.log');
    fs.writeFileSync(`${logPath}.1`, 'old-backup');
    fs.writeFileSync(logPath, 'y'.repeat(2048));

    const rotated = rotateLogIfLarge(logPath, 1024);

    assert.equal(rotated, true);
    assert.equal(fs.readFileSync(`${logPath}.1`, 'utf8').length, 2048);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is a no-op when the log does not exist', () => {
    const dir = tempDir();
    const logPath = path.join(dir, 'proxy.log');

    assert.equal(rotateLogIfLarge(logPath, 1024), false);
    assert.equal(fs.existsSync(`${logPath}.1`), false);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('exposes a positive default cap', () => {
    assert.equal(MAX_LOG_BYTES, 5 * 1024 * 1024);
  });
});
