/**
 * Restore subagent delegation that the client's own system prompt suppresses.
 *
 * WHY THIS EXISTS
 * Claude Code 2.1.219+ injects a system-prompt section (registered internally as
 * `heron_brook`) whose default payload is two lines telling the model not to
 * spawn subagents unless explicitly asked. Verified against the shipped 2.1.220
 * binary: the section is gated on a *model capability*, not on user config —
 *
 *     if (NN(lo(e), "opus_5_prompt_bundle") !== true) return false;
 *     return !Ke("tengu_fennel_godwit", false)      // killswitch, defaults false
 *
 * — and of every `capabilities:[…]` array in that binary exactly one carries
 * `opus_5_prompt_bundle`: `claude-opus-5`. So selecting Opus 5 silently turns
 * delegation off, and there is no settings key, CLI flag or env var to turn it
 * back on (anthropics/claude-code#80988).
 *
 * WHY THE ROUTER CARES
 * `sessionModel` pins the coordinator to one tier so *subagents* carry the
 * volume on cheaper tiers. With delegation suppressed no subagent requests are
 * ever made, so the pinned tier does every turn itself and the pin costs more
 * than not pinning. Worse, the loss cannot be recovered by routing: a Claude Code
 * coordinator carries a large cached prefix, prompt caches are model-scoped, and
 * a cache read bills at 10% of input against 125% for a cold write — so moving a
 * ~110K-token prefix to a cheaper tier costs several times what the cheaper tier
 * saves. Delegation into fresh, small subagent contexts is the only lever that
 * actually lowers the bill, which is exactly what the injection removes.
 *
 * WHY IT IS OPT-IN AND NARROW
 * This is the one place the proxy edits a prompt, so the rule is deliberately the
 * tightest one that can work: a line is removed only when its trimmed text is
 * **exactly equal** to a known payload line, and only inside `system`. No regex
 * over the prompt, no substring matching — content can always quote the
 * delimiter, and a substring rule would strip text out of a user's own
 * documentation that merely mentions it (the failure mode `latestUserText`
 * already documents for `<system-reminder>`). If the vendor rewrites the payload,
 * this stops matching and removes nothing rather than damaging the prompt — and
 * `describeStrip` reports that so the operator sees it instead of guessing.
 *
 * Removal is deterministic — the same input always yields the same output — so
 * the edited prefix pays one cache write and is warm from the second request on.
 */

/**
 * The `heron_brook` default payload, verbatim from Claude Code 2.1.220.
 * Matched per line, whole-line, after trimming.
 */
export const DELEGATION_BLOCKERS: readonly string[] = [
  'Do not call the AgentTool unless the user requested it',
  'Do not use workflows or deep-research unless the user requested it',
];

export interface StripResult {
  /** The system field with blocker lines removed. Same reference when nothing matched. */
  system: unknown;
  /** How many lines were removed. 0 means the payload was not present. */
  removed: number;
}

const BLOCKER_SET = new Set<string>(DELEGATION_BLOCKERS);

/**
 * Remove whole lines that exactly match a known blocker. Returns null if none
 * did. The count comes from the filter itself, never from re-splitting the
 * result: `''.split('\n')` has length 1, so differencing line counts undercounts
 * by one whenever every line is removed.
 */
function stripText(text: string): { text: string; removed: number } | null {
  if (!text.includes('Do not ')) return null; // cheap reject for the common case
  let removed = 0;
  const kept = text.split('\n').filter((line) => {
    if (!BLOCKER_SET.has(line.trim())) return true;
    removed++;
    return false;
  });
  return removed === 0 ? null : { text: kept.join('\n'), removed };
}

/**
 * Strip the injected anti-delegation lines from an Anthropic `system` field.
 *
 * Handles both shapes the API accepts: a bare string, or an array of content
 * blocks. A text block left empty (or whitespace-only) after the removal is
 * dropped, so we never forward a block the API would reject. `messages`,
 * `tools` and every other field are untouched — this function only ever sees
 * `system`.
 */
export function stripDelegationBlockers(system: unknown): StripResult {
  if (typeof system === 'string') {
    const stripped = stripText(system);
    return stripped === null ? { system, removed: 0 } : { system: stripped.text, removed: stripped.removed };
  }

  if (Array.isArray(system)) {
    let removed = 0;
    const out: unknown[] = [];
    for (const block of system) {
      if (
        block !== null &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        const stripped = stripText((block as { text: string }).text);
        if (stripped !== null) {
          removed += stripped.removed;
          if (stripped.text.trim() === '') continue; // block is now empty — drop it
          out.push({ ...(block as object), text: stripped.text });
          continue;
        }
      }
      out.push(block);
    }
    return removed > 0 ? { system: out, removed } : { system, removed: 0 };
  }

  return { system, removed: 0 };
}

/**
 * One-line operator-facing summary. The negative case matters as much as the
 * positive one: "enabled but matched nothing" is how a vendor payload change
 * surfaces, and it must not look like success.
 */
export function describeStrip(removed: number): string {
  return removed > 0
    ? `restored delegation — removed ${removed} injected anti-delegation line${removed === 1 ? '' : 's'} from system`
    : 'restore-delegation is on but the known injected lines were not present (nothing removed)';
}
