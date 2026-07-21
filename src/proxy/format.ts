import { term } from './term.js';

/**
 * Format a saved/extra dollar amount for `claude-router stats`.
 *
 * Sub-cent savings (e.g. one opus route against a sonnet baseline) round to
 * $0.00 but keep their sign, so they render as `-$0.00` / `extra $0.00`. Per
 * #38 they should read as a neutral zero instead, so whenever the displayed
 * value rounds to `$0.00` we drop the sign and the `extra` wording.
 *
 * @param cents   signed amount in cents (may be fractional)
 * @param withLabel when true, prefix the amount with `saved`/`extra`
 */
export function formatSavedCents(cents: number, withLabel = false): string {
  const dollars = cents / 100;
  if (Math.abs(dollars).toFixed(2) === '0.00') {
    return withLabel ? term.green('saved $0.00') : term.green('$0.00');
  }
  if (cents >= 0) {
    return withLabel ? term.green(`saved $${dollars.toFixed(2)}`) : term.green(`$${dollars.toFixed(2)}`);
  }
  return withLabel
    ? term.red(`extra $${Math.abs(dollars).toFixed(2)}`)
    : term.red(`-$${Math.abs(dollars).toFixed(2)}`);
}
