import { term } from './term.js';

export type SavedTone = 'positive' | 'negative' | 'neutral';

export interface SavedDisplay {
  text: string;
  tone: SavedTone;
}

/**
 * Presentation-agnostic saved/extra amount decision: rounding, sign and the
 * sub-cent → neutral rule, without any styling. Shared by the ANSI CLI
 * formatter and the HTML dashboard so both agree on when a figure is a saving,
 * a loss, or a neutral zero.
 *
 * Sub-cent amounts (e.g. one opus route against a sonnet baseline) round to
 * $0.00 but keep their sign; a sub-cent loss is not a saving, so it collapses
 * to a neutral, unlabelled `$0.00` (#38) instead of reading as one.
 *
 * @param cents   signed amount in cents (may be fractional)
 * @param withLabel when true, prefix the amount with `saved`/`extra`
 */
export function savedCentsDisplay(cents: number, withLabel = false): SavedDisplay {
  const dollars = cents / 100;
  if (Math.abs(dollars).toFixed(2) === '0.00') {
    // A sub-cent loss is not a saving: neutral, never labelled.
    return { text: '$0.00', tone: 'neutral' };
  }
  if (cents >= 0) {
    return { text: withLabel ? `saved $${dollars.toFixed(2)}` : `$${dollars.toFixed(2)}`, tone: 'positive' };
  }
  return {
    text: withLabel ? `extra $${Math.abs(dollars).toFixed(2)}` : `-$${Math.abs(dollars).toFixed(2)}`,
    tone: 'negative',
  };
}

/**
 * Format a saved/extra dollar amount for `claude-router stats`, applying the
 * shared {@link savedCentsDisplay} decision with ANSI styling: dim for a
 * neutral zero, green for a saving, red for a loss.
 *
 * @param cents   signed amount in cents (may be fractional)
 * @param withLabel when true, prefix the amount with `saved`/`extra`
 */
export function formatSavedCents(cents: number, withLabel = false): string {
  const { text, tone } = savedCentsDisplay(cents, withLabel);
  if (tone === 'neutral') return term.dim(text);
  if (tone === 'positive') return term.green(text);
  return term.red(text);
}
