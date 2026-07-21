import { term } from './term.js';

/**
 * Format a saved/extra dollar amount for `claude-router stats`.
 *
 * Sub-cent amounts (e.g. one opus route against a sonnet baseline) round to
 * $0.00 but keep their sign, so they rendered as `-$0.00` / `extra $0.00`
 * (#38). Anything that rounds away is shown as a neutral, unlabelled `$0.00`:
 * a sub-cent loss is not a saving, so it must not read as one.
 *
 * @param cents   signed amount in cents (may be fractional)
 * @param withLabel when true, prefix the amount with `saved`/`extra`
 */
export function formatSavedCents(cents: number, withLabel = false): string {
  const dollars = cents / 100;
  if (Math.abs(dollars).toFixed(2) === '0.00') {
    // A sub-cent loss is not a saving: neutral, never green, never labelled.
    return term.dim('$0.00');
  }
  if (cents >= 0) {
    return withLabel ? term.green(`saved $${dollars.toFixed(2)}`) : term.green(`$${dollars.toFixed(2)}`);
  }
  return withLabel
    ? term.red(`extra $${Math.abs(dollars).toFixed(2)}`)
    : term.red(`-$${Math.abs(dollars).toFixed(2)}`);
}
