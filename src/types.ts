import type Anthropic from '@anthropic-ai/sdk';

export type Tier = 'haiku' | 'sonnet' | 'opus' | 'fable';

export interface ModelPricing {
  /** $ per 1M input tokens */
  input: number;
  /** $ per 1M output tokens */
  output: number;
  /**
   * Prompt-cache read multiplier on {@link input}, when the model does not use
   * the standard 10% (`CACHE_READ_RATE`). Fable 5.1 / Mythos 5.1 read at 2.5%.
   * Optional so every existing entry and every user `pricing` override keeps
   * the default — absent means standard, never means free.
   */
  cacheRead?: number;
}

export interface RoutingTuning {
  /**
   * @deprecated No-op since 0.2.2. Routing is gate-based (see `routeByEvidence`)
   * and there is no score to threshold. Accepted so existing config files load;
   * the proxy warns once per key.
   */
  haikuMax?: number;
  /** @deprecated No-op since 0.2.2 — see `haikuMax`. */
  opusMin?: number;
  /** @deprecated No-op since 0.2.2. Hybrid defers to AI when no gate fired. */
  hybridBand?: [number, number];
  /** AI classifier timeout in ms; on timeout/error falls back to heuristic (default 1500) */
  aiTimeoutMs?: number;
  /** LRU size for the AI classification cache; 0 disables (default 500) */
  classifyCacheSize?: number;
  /**
   * Allow routing to haiku inside an agentic/tool-using session. Default false:
   * when tools (or tool_use/tool_result blocks) are present the tier is floored
   * at sonnet, because a trivial-LOOKING turn in a coding loop can be hard to
   * execute and a wrong cheap step can cascade into more work. Set true to let a
   * clearly-trivial turn drop to haiku for maximum savings.
   */
  allowHaikuInAgentic?: boolean;
  /**
   * Allow classification to reach the fable tier. Default false: fable is
   * $10/$50 and no measured signal predicts "super hard" from request text, so
   * promotion needs depth and long-horizon evidence together. Config-file
   * `routing.allowFable` maps here.
   */
  allowFable?: boolean;
}

export interface RouterConfig {
  apiKey: string;
  /** Model used as baseline for savings calculation (default: sonnet tier model) */
  defaultModel?: string;
  /** Classification strategy (default: 'hybrid') */
  classifier?: 'heuristic' | 'ai' | 'hybrid';
  /** Tune classifier thresholds, hybrid band, AI timeout, and cache size */
  routing?: RoutingTuning;
  /** Override default model IDs per tier */
  tiers?: Partial<Record<Tier, string>>;
  /** Override or extend pricing data */
  pricing?: Record<string, ModelPricing>;
  /** Auto-fallback to next tier on rate limit (default: true) */
  fallback?: boolean;
  /** Log routing decisions to console (default: false) */
  verbose?: boolean;
  /**
   * Sink for library warnings (unpriced models, dead config keys).
   * Pass `{ warn: () => {} }` to silence, or your own logger.
   * Default: `console`.
   */
  logger?: { warn(message: string): void };
}

export interface RouteMeta {
  tier: Tier;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Prompt-cache reads (billed at 10% of input rate) */
  cacheReadTokens?: number;
  /** Prompt-cache writes (billed at 125% of input rate) */
  cacheCreationTokens?: number;
  /** Cost of this call in cents */
  costCents: number;
  /** Savings vs defaultModel baseline in cents */
  savedCents: number;
  /**
   * Set to false when `costCents`/`savedCents` are placeholder zeros because
   * this call's model (or the baseline) has no known price. Absent means priced.
   */
  priced?: boolean;
  classifierMethod: 'heuristic' | 'ai' | 'pinned' | 'role';
  /** Routing overhead in milliseconds */
  classifierMs: number;
  /** Which gate, pin or AI verdict decided the tier (e.g. `agentic:mid-loop`) */
  reason?: string;
  /** True if original tier was rate-limited and a different tier was used */
  fallbackUsed: boolean;
  /** Classifier confidence 0–1 */
  confidence: number;
  /** True if response was retried on a higher tier */
  retried: boolean;
  /** Reason for retry: 'truncation' | 'refusal' | null */
  retryReason: string | null;
}

export interface RoutedMessage extends Anthropic.Message {
  meta: RouteMeta;
}

export interface RouterStats {
  totalCostCents: number;
  totalSavedCents: number;
  callCount: number;
  tierBreakdown: Record<Tier, number>;
  /**
   * Calls per model that had no price, keyed by model ID; `{}` when everything
   * was priced. Non-empty means the totals above are an undercount — surface it
   * rather than presenting them as complete.
   */
  unpricedModels: Record<string, number>;
}

export interface ClassifyInput {
  messages: Anthropic.MessageParam[];
  system?: string | Anthropic.TextBlockParam[];
  /** Request-level tool definitions; only the count is inspected */
  tools?: unknown[];
}

export interface ClassifyResult {
  tier: Tier;
  score: number;
  /**
   * How the tier was decided. `pinned` is not a classification at all — the
   * proxy short-circuits the classifier to honor a configured coordinator model
   * (see HandlerConfig.sessionModel); it rides this field so the existing
   * headers/log/history path records "why this tier" uniformly.
   */
  method: 'heuristic' | 'ai' | 'pinned' | 'role';
  ms: number;
  confidence: number;
  /** True when the result was served from the classification cache */
  cached?: boolean;
  /** True when an agentic session floored the tier up from haiku to sonnet */
  floored?: boolean;
  /**
   * Which gate produced this tier (e.g. `agentic:mid-loop`, `single-turn:default`).
   * Makes a routing decision auditable after the fact — with gates rather than a
   * summed score, "why this tier" has an answer worth recording.
   */
  reason?: string;
}
