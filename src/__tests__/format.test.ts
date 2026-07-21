import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatSavedCents } from '../proxy/format.js';

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
