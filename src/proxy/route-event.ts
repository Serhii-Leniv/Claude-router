import { costFields, type RouteCost } from '../models.js';
import type { ClassifyResult, Tier } from '../types.js';
import type { RoleSource } from '../roles.js';

/**
 * The proxy's route outcome record — one line of `history.jsonl`, one row of the
 * dashboard, one fold into `RouteTotals`.
 *
 * It lives here rather than in `handler.ts` because four modules (`history`,
 * `dashboard`, `health`, `server`) need the shape and none of them needs the
 * request handler. With the type declared inside the handler, the 617-line file
 * that answers HTTP requests was also the type root for the whole proxy subtree.
 *
 * Construction goes through {@link buildRouteEvent} / {@link errorRouteEvent} so
 * the record is assembled once. The non-streaming path, the streaming success
 * path and the streaming error path each used to spell all fourteen fields out
 * inline, and they had already diverged: the streaming paths hardcoded
 * `retried: false` and none of the three carried the classifier timing that the
 * `x-router-classifier-ms` header reports.
 */
export interface RouteEvent {
  timestamp: string;
  tier: Tier | 'passthrough';
  model: string;
  costCents: number;
  savedCents: number;
  confidence: number;
  classifier: string;
  /** Classifier overhead in ms — the same figure `x-router-classifier-ms` reports. */
  classifierMs?: number;
  /**
   * Which gate (or pin, or AI verdict) decided the tier — `agentic:mid-loop`,
   * `session:coordinator-pinned`, `ai:level-2`. The same string the
   * `x-router-reason` header carries. Absent on lines written before 0.4.0.
   */
  reason?: string;
  /** Present on requests Claude Code sent from a subagent (`x-claude-code-agent-id`). */
  subagent?: true;
  /**
   * The subagent's role — pinned by a marker/agent mapping, or inferred from
   * its tool shape as a label only. `roleSource` says which. Gives the ledger a
   * per-role axis: what did reconnaissance cost, what did review cost.
   */
  role?: string;
  roleSource?: RoleSource;
  sessionId?: string;
  nested?: true;
  coordinator?: true;
  dispatchable?: true;
  /** A dispatchable turn whose response called the Agent tool — delegation observed, not promised. */
  dispatched?: true;
  retried: boolean;
  retryReason: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /**
   * Set to false when `costCents`/`savedCents` are placeholder zeros because the
   * model has no known price. Absent means priced — history.jsonl lines written
   * before this field existed must keep counting as measured.
   */
  priced?: boolean;
  /**
   * Set when the request failed mid-flight (stream died after headers were
   * sent). `foldOutcome` counts such events only toward `RouteTotals.errors` —
   * their zeros are placeholders, not measurements.
   */
  error?: string;
}

/** Request facts that are not a classification but belong on the record. Keys are set only when true/known. */
export interface RouteContext {
  /** Claude Code's `x-claude-code-session-id`, when sent. */
  sessionId?: string;
  subagent?: true;
  /** The subagent carried a parent agent id: a leaf that delegated. */
  nested?: true;
  /** The main session's agent turn (no agent id, tools present). */
  coordinator?: true;
  /** A coordinator turn that was offered the Agent tool. */
  dispatchable?: true;
  role?: string;
  roleSource?: RoleSource;
}

export interface RouteEventInput {
  tier: Tier;
  model: string;
  cost: RouteCost;
  classifyResult: ClassifyResult;
  context?: RouteContext;
  /** The response called the Agent tool. Recorded only on dispatchable turns. */
  dispatched?: boolean;
  retried?: boolean;
  retryReason?: string | null;
}

/** Record of one completed routed call. */
export function buildRouteEvent(input: RouteEventInput): RouteEvent {
  const { tier, model, cost, classifyResult, context, dispatched, retried = false, retryReason = null } = input;
  return {
    timestamp: new Date().toISOString(),
    tier,
    model,
    confidence: classifyResult.confidence,
    classifier: classifyResult.method,
    classifierMs: classifyResult.ms,
    ...(classifyResult.reason ? { reason: classifyResult.reason } : {}),
    ...(context ?? {}),
    ...(dispatched && context?.dispatchable ? { dispatched: true as const } : {}),
    retried,
    retryReason,
    ...costFields(cost),
  };
}

/**
 * Record of a request that died after its headers were committed. The money and
 * token figures are placeholder zeros, and `error` is what keeps them out of the
 * totals — `foldOutcome` counts this only toward `RouteTotals.errors`, so a
 * failure never reads as a $0.00 success.
 */
export function errorRouteEvent(input: {
  tier: Tier;
  model: string;
  classifyResult: ClassifyResult;
  context?: RouteContext;
  error: unknown;
}): RouteEvent {
  const { tier, model, classifyResult, context, error } = input;
  return {
    timestamp: new Date().toISOString(),
    tier,
    model,
    costCents: 0,
    savedCents: 0,
    confidence: classifyResult.confidence,
    classifier: classifyResult.method,
    classifierMs: classifyResult.ms,
    ...(classifyResult.reason ? { reason: classifyResult.reason } : {}),
    ...(context ?? {}),
    retried: false,
    retryReason: null,
    inputTokens: 0,
    outputTokens: 0,
    error: String(error).slice(0, 200),
  };
}
