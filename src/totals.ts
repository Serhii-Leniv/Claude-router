/**
 * Shared route-event aggregation.
 *
 * Three call sites accumulate the same route figures with different execution
 * models: `CostTracker` folds one event at a time into O(1) running totals,
 * `history` folds newly-appended file lines behind an offset cache, and the
 * dashboard reduces a live capped array on each render. They differ only in
 * *when* they fold — so the fold itself lives here, once, and each caller keeps
 * its own execution model and maps `RouteTotals` back to its own public shape.
 */

/** Running aggregate of route events. `tiers` holds only the tiers actually seen. */
export interface RouteTotals {
  requests: number;
  costCents: number;
  savedCents: number;
  retried: number;
  /**
   * Requests that failed mid-flight (e.g. a stream died after headers were
   * sent). Counted here and nowhere else: an errored event has no usable cost
   * or tier outcome, and folding its placeholder zeros into the money figures
   * would present a failure as a $0.00 success.
   */
  errors: number;
  /** Count per tier label (may include 'passthrough'); only seen labels appear. */
  tiers: Record<string, number>;
  /** Per-day aggregates keyed by YYYY-MM-DD; empty when events carry no timestamp. */
  byDay: Record<string, { requests: number; costCents: number; savedCents: number }>;
  /**
   * Request count per model that had no price, keyed by model ID; empty when
   * every event was priced. Non-empty means `costCents`/`savedCents` above are
   * an undercount, and by how many calls — render it, don't drop it.
   */
  unpricedModels: Record<string, number>;
  /**
   * Cost per role label — the subagent roles from src/roles.ts plus
   * `coordinator` for the main session's agent turns. Only labels seen appear.
   * This is the axis a prompt-level policy can never produce: what did
   * reconnaissance cost, what did review cost, what did the coordinator keep.
   */
  byRole: Record<string, { requests: number; costCents: number; savedCents: number }>;
  /**
   * Delegation, observed rather than promised. `turns` counts coordinator turns
   * that *could* dispatch (the Agent tool was offered); `dispatched` those whose
   * response actually called it; `nested` subagent requests that carried a
   * parent agent id — a leaf that delegated, which the policy forbids.
   */
  dispatch: { turns: number; dispatched: number; nested: number };
  /** Token totals across priced-or-not events; the counterfactual is linear in these. */
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
}

/**
 * The minimal shape `foldOutcome` reads. Both the library's `RouteMeta` and the
 * proxy's `RouteEvent` satisfy it structurally, so neither module has to adopt a
 * unified record type.
 */
export interface RouteOutcomeLike {
  tier: string;
  costCents: number;
  savedCents: number;
  retried?: boolean;
  /** ISO timestamp; when absent, the event is not bucketed by day. */
  timestamp?: string;
  /** Model ID, used to name unpriced models; only read when `priced === false`. */
  model?: string;
  /**
   * False when this event's cost figures are placeholder zeros. Absent means
   * priced — history lines written before this field existed carry no `priced`,
   * and treating them as unpriced would retroactively void every past total.
   */
  priced?: boolean;
  /** Set when the request failed mid-flight; the event counts only toward `errors`. */
  error?: string;
  /** Subagent role (pinned or inferred); see src/roles.ts. */
  role?: string;
  /** The main session's agent turn (no agent id, tools present). */
  coordinator?: true;
  /** A coordinator turn that was offered the Agent tool. */
  dispatchable?: true;
  /** A dispatchable turn whose response called the Agent tool. */
  dispatched?: true;
  /** A subagent request carrying a parent agent id — a leaf that delegated. */
  nested?: true;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export function emptyTotals(): RouteTotals {
  return {
    requests: 0,
    costCents: 0,
    savedCents: 0,
    retried: 0,
    errors: 0,
    tiers: {},
    byDay: {},
    unpricedModels: {},
    byRole: {},
    dispatch: { turns: 0, dispatched: 0, nested: 0 },
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  };
}

/**
 * Zero-filled per-label counts from a `RouteTotals`. `RouteTotals.tiers` holds
 * only labels actually seen; public shapes (RouterStats, the dashboard bars) want
 * a fixed set with unseen labels as 0. Keeping that rule here means adding or
 * renaming a tier is one edit, not a lockstep change across every consumer.
 */
export function tierBreakdown<L extends string>(
  totals: RouteTotals,
  labels: readonly L[],
): Record<L, number> {
  const out = {} as Record<L, number>;
  for (const label of labels) out[label] = totals.tiers[label] ?? 0;
  return out;
}

/** Fold one route outcome into a running total, in place. */
export function foldOutcome(acc: RouteTotals, e: RouteOutcomeLike): void {
  if (e.error) {
    acc.errors++;
    return;
  }
  acc.requests++;
  acc.costCents += e.costCents;
  acc.savedCents += e.savedCents;
  if (e.retried) acc.retried++;
  acc.tiers[e.tier] = (acc.tiers[e.tier] ?? 0) + 1;
  if (e.priced === false) {
    const model = e.model || 'unknown';
    acc.unpricedModels[model] = (acc.unpricedModels[model] ?? 0) + 1;
  }

  const day = String(e.timestamp ?? '').slice(0, 10);
  if (day) {
    const d = (acc.byDay[day] ??= { requests: 0, costCents: 0, savedCents: 0 });
    d.requests++;
    d.costCents += e.costCents;
    d.savedCents += e.savedCents;
  }

  // Orchestration figures. Every field is optional on the event, so a record
  // from before they existed (or the library's RouteMeta) folds to no change.
  const roleLabel = e.role ?? (e.coordinator ? 'coordinator' : undefined);
  if (roleLabel) {
    const r = (acc.byRole[roleLabel] ??= { requests: 0, costCents: 0, savedCents: 0 });
    r.requests++;
    r.costCents += e.costCents;
    r.savedCents += e.savedCents;
  }
  if (e.dispatchable) acc.dispatch.turns++;
  if (e.dispatched) acc.dispatch.dispatched++;
  if (e.nested) acc.dispatch.nested++;
  acc.tokens.input += e.inputTokens ?? 0;
  acc.tokens.output += e.outputTokens ?? 0;
  acc.tokens.cacheRead += e.cacheReadTokens ?? 0;
  acc.tokens.cacheCreation += e.cacheCreationTokens ?? 0;
}
