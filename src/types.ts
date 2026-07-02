import type Anthropic from '@anthropic-ai/sdk';

export type Tier = 'haiku' | 'sonnet' | 'opus';

export interface ModelPricing {
  /** $ per 1M input tokens */
  input: number;
  /** $ per 1M output tokens */
  output: number;
}

export interface RoutingTuning {
  /** Heuristic score below this routes to haiku (default 30) */
  haikuMax?: number;
  /** Heuristic score above this routes to opus (default 70) */
  opusMin?: number;
  /** Hybrid mode confirms with AI when score falls in this inclusive band (default [40, 60]) */
  hybridBand?: [number, number];
  /** AI classifier timeout in ms; on timeout/error falls back to heuristic (default 1500) */
  aiTimeoutMs?: number;
  /** LRU size for the AI classification cache; 0 disables (default 500) */
  classifyCacheSize?: number;
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
  tiers?: {
    haiku?: string;
    sonnet?: string;
    opus?: string;
  };
  /** Override or extend pricing data */
  pricing?: Record<string, ModelPricing>;
  /** Auto-fallback to next tier on rate limit (default: true) */
  fallback?: boolean;
  /** Log routing decisions to console (default: false) */
  verbose?: boolean;
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
  classifierMethod: 'heuristic' | 'ai';
  /** Routing overhead in milliseconds */
  classifierMs: number;
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
  method: 'heuristic' | 'ai';
  ms: number;
  confidence: number;
  /** True when the result was served from the classification cache */
  cached?: boolean;
}
