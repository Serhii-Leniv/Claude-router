import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatSavedCents, savedCentsDisplay } from '../proxy/format.js';

describe('formatSavedCents', () => {
  it('renders a neutral zero for sub-cent amounts (no signed zero) — #38', () => {
    assert.equal(formatSavedCents(-0.2), '$0.00');
    assert.equal(formatSavedCents(0.2), '$0.00');
    assert.equal(formatSavedCents(0), '$0.00');
  });

  it('keeps the sign for amounts that round to a non-zero cent', () => {
    assert.equal(formatSavedCents(123), '$1.23');
    assert.equal(formatSavedCents(-123), '-$1.23');
    assert.equal(formatSavedCents(-1), '-$0.01');
  });

  it('supports the saved/extra label', () => {
    assert.equal(formatSavedCents(123, true), 'saved $1.23');
    assert.equal(formatSavedCents(-123, true), 'extra $1.23');
    assert.equal(formatSavedCents(-0.2, true), '$0.00');
  });
});

describe('savedCentsDisplay', () => {
  it('collapses sub-cent amounts to a neutral zero regardless of sign — #38', () => {
    assert.deepEqual(savedCentsDisplay(-0.2), { text: '$0.00', tone: 'neutral' });
    assert.deepEqual(savedCentsDisplay(0.2), { text: '$0.00', tone: 'neutral' });
    assert.deepEqual(savedCentsDisplay(0), { text: '$0.00', tone: 'neutral' });
  });

  it('reports a clear saving as positive', () => {
    assert.deepEqual(savedCentsDisplay(123), { text: '$1.23', tone: 'positive' });
  });

  it('reports a clear loss as negative with a signed amount', () => {
    assert.deepEqual(savedCentsDisplay(-123), { text: '-$1.23', tone: 'negative' });
    assert.deepEqual(savedCentsDisplay(-1), { text: '-$0.01', tone: 'negative' });
  });

  it('supports the saved/extra label', () => {
    assert.deepEqual(savedCentsDisplay(123, true), { text: 'saved $1.23', tone: 'positive' });
    assert.deepEqual(savedCentsDisplay(-123, true), { text: 'extra $1.23', tone: 'negative' });
    assert.deepEqual(savedCentsDisplay(-0.2, true), { text: '$0.00', tone: 'neutral' });
  });

  it('shows sub-cent figures signed at precision 4 (no neutral collapse) — #47', () => {
    assert.deepEqual(savedCentsDisplay(-0.43, false, 4), { text: '-$0.0043', tone: 'negative' });
    assert.deepEqual(savedCentsDisplay(0, false, 4), { text: '$0.0000', tone: 'neutral' });
    assert.deepEqual(savedCentsDisplay(4567, false, 4), { text: '$45.6700', tone: 'positive' });
  });
});
