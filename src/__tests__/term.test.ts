import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTerm, stripAnsi } from '../proxy/term.js';

describe('term — color control', () => {
  it('forceColor: true emits ANSI codes', () => {
    const t = createTerm({ forceColor: true });
    assert.ok(t.enabled);
    assert.notEqual(t.red('x'), 'x');
    assert.ok(t.red('x').includes('\x1b['));
  });

  it('forceColor: false is identity for all styles', () => {
    const t = createTerm({ forceColor: false });
    assert.ok(!t.enabled);
    for (const fn of [t.accent, t.red, t.green, t.yellow, t.cyan, t.magenta, t.dim, t.bold]) {
      assert.equal(fn('hello'), 'hello');
    }
    assert.equal(t.ok(), '✓');
    assert.equal(t.fail(), '✗');
    assert.equal(t.warn(), '!');
  });

  it('tier maps each tier to a distinct color', () => {
    const t = createTerm({ forceColor: true });
    const rendered = [t.tier('haiku'), t.tier('sonnet'), t.tier('opus')];
    assert.equal(stripAnsi(rendered[0]!), 'haiku');
    assert.equal(stripAnsi(rendered[1]!), 'sonnet');
    assert.equal(stripAnsi(rendered[2]!), 'opus');
    assert.equal(new Set(rendered.map((r) => r.slice(0, 5))).size, 3);
  });

  it('tier passes through unknown values unstyled', () => {
    const t = createTerm({ forceColor: true });
    assert.equal(t.tier('pass'), 'pass');
  });
});

describe('term — stripAnsi', () => {
  it('removes SGR sequences', () => {
    assert.equal(stripAnsi('\x1b[31mred\x1b[39m plain \x1b[38;5;209maccent\x1b[39m'), 'red plain accent');
  });

  it('leaves plain text untouched', () => {
    assert.equal(stripAnsi('no codes here'), 'no codes here');
  });
});

describe('term — box', () => {
  it('all lines have equal visible width', () => {
    const t = createTerm({ forceColor: true });
    const out = t.box('claude-router', [
      ['URL', 'http://localhost:65535'],
      ['Provider', t.tier('sonnet')],
      ['Config', 'C:\\Users\\Someone With Long Name\\.claude-router\\config.json'],
    ]);
    const widths = out.split('\n').map((l) => stripAnsi(l).length);
    assert.ok(widths.length >= 4);
    assert.equal(new Set(widths).size, 1, `uneven box: ${JSON.stringify(widths)}`);
  });

  it('handles a 5-digit port and colored values without breaking alignment', () => {
    const t = createTerm({ forceColor: true });
    const out = t.box('T', [['Port', t.accent('12345')]]);
    const lines = out.split('\n').map((l) => stripAnsi(l));
    for (const line of lines.slice(1, -1)) {
      assert.ok(line.startsWith('│') && line.endsWith('│'), `bad row: ${line}`);
    }
    assert.equal(new Set(lines.map((l) => l.length)).size, 1);
  });

  it('works with colors disabled', () => {
    const t = createTerm({ forceColor: false });
    const out = t.box('Title', [['A', '1'], ['Longer label', '2']]);
    const widths = out.split('\n').map((l) => l.length);
    assert.equal(new Set(widths).size, 1);
  });
});
