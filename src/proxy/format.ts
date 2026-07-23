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
 * The neutral collapse keys on the CHOSEN precision: an amount is neutral iff
 * it rounds away to zero at that many decimals. The default of 2 keeps every
 * existing caller byte-identical; the dashboard's Session Saved card passes 4
 * so a sub-cent figure stays visible and signed there (#47).
 *
 * @param cents   signed amount in cents (may be fractional)
 * @param withLabel when true, prefix the amount with `saved`/`extra`
 * @param precision number of decimals to render (default 2)
 */
export function savedCentsDisplay(cents: number, withLabel = false, precision = 2): SavedDisplay {
  const dollars = cents / 100;
  if (Math.abs(dollars).toFixed(precision) === (0).toFixed(precision)) {
    // A sub-cent loss is not a saving: neutral, never labelled.
    return { text: `$${(0).toFixed(precision)}`, tone: 'neutral' };
  }
  if (cents >= 0) {
    return {
      text: withLabel ? `saved $${dollars.toFixed(precision)}` : `$${dollars.toFixed(precision)}`,
      tone: 'positive',
    };
  }
  return {
    text: withLabel ? `extra $${Math.abs(dollars).toFixed(precision)}` : `-$${Math.abs(dollars).toFixed(precision)}`,
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
