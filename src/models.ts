import type Anthropic from '@anthropic-ai/sdk';
import type { ModelPricing, Tier } from './types.js';

export const DEFAULT_MODELS: Record<Tier, string> = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-4-8',
};

// NOTE: Bedrock inference-profile IDs vary by account/region and Anthropic's
// snapshot naming — verify these against your Bedrock console if routing 400s.
// Pricing is unaffected (resolved by family in priceForModel).
export const BEDROCK_MODELS: Record<Tier, string> = {
  haiku:  'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  sonnet: 'us.anthropic.claude-sonnet-5-v1:0',
  opus:   'us.anthropic.claude-opus-4-8-v1:0',
};

export const VERTEX_MODELS: Record<Tier, string> = {
  haiku:  'claude-haiku-4-5',
  sonnet: 'claude-sonnet-5',
  opus:   'claude-opus-4-8',
};

/**
 * Current-generation Claude pricing ($ per 1M tokens), keyed by tier/family.
 * Verified against platform.claude.com pricing for the current generation:
 *   Haiku 4.5 — $1.00 / $5.00
 *   Sonnet 5  — $3.00 / $15.00 standard (intro $2.00 / $10.00 through 2026-08-31)
 *   Opus 4.6/4.7/4.8 — $5.00 / $25.00  (note: NOT the old $15/$75 of Opus 4.0/4.1)
 *
 * We price Sonnet at the standard rate so savings math stays stable when the
 * intro discount ends. Fable 5 ($10/$50) is intentionally not a tier here.
 *
 * Pricing drift here silently corrupts every `savedCents` figure the router
 * reports — keep this in sync when a new generation ships, and rely on the
 * family fallback in `priceForModel` to cover Bedrock/Vertex/dated IDs.
 */
export const FAMILY_PRICING: Record<Tier, ModelPricing> = {
  haiku:  { input: 1.00, output: 5.00 },
  sonnet: { input: 3.00, output: 15.00 },
  opus:   { input: 5.00, output: 25.00 },
};

/**
 * Pricing keyed by exact model ID. Built from FAMILY_PRICING so the two never
 * disagree. Any first-party, Bedrock, or Vertex ID not listed here is resolved
 * by family in `priceForModel` — so a newly-dated snapshot still prices right.
 */
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  'claude-haiku-4-5': FAMILY_PRICING.haiku,
  'claude-haiku-4-5-20251001': FAMILY_PRICING.haiku,
  'claude-sonnet-5': FAMILY_PRICING.sonnet,
  'claude-sonnet-4-6': FAMILY_PRICING.sonnet,
  'claude-opus-4-8': FAMILY_PRICING.opus,
  'claude-opus-4-7': FAMILY_PRICING.opus,
  'claude-opus-4-6': FAMILY_PRICING.opus,
};

export const TIER_ORDER: Tier[] = ['haiku', 'sonnet', 'opus'];

/**
 * Map any Claude model ID (first-party, Bedrock `us.anthropic.*`, Vertex,
 * dated snapshot, or `auto`) to its tier by family name. Returns undefined for
 * non-Claude IDs.
 */
export function familyForModel(model: string): Tier | undefined {
  const m = model.toLowerCase();
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('opus')) return 'opus';
  return undefined;
}

/**
 * Resolve pricing for a model: exact match first (so user overrides win), then
 * fall back to the model's family. This keeps savings math correct across
 * providers and across newly-released dated snapshots without a code change.
 */
export function priceForModel(
  model: string,
  pricing: Record<string, ModelPricing>,
): ModelPricing | undefined {
  if (pricing[model]) return pricing[model];
  const fam = familyForModel(model);
  if (!fam) return undefined;
  // Honor a user override that targets the family's default model ID, else the
  // canonical family price.
  return pricing[DEFAULT_MODELS[fam]] ?? FAMILY_PRICING[fam];
}

/**
 * Prompt-cache pricing multipliers (fractions of the model's input rate):
 * cache reads bill at 10%, cache writes (5-minute TTL) at 125%.
 * Claude Code uses caching heavily — ignoring these understates every cost.
 */
export const CACHE_READ_RATE = 0.1;
export const CACHE_WRITE_RATE = 1.25;

export interface CacheTokens {
  readTokens?: number;
  creationTokens?: number;
}

export function computeCostCents(
  model: string,
  inputTokens: number,
  outputTokens: number,
  pricing: Record<string, ModelPricing>,
  cache?: CacheTokens,
): number {
  const p = priceForModel(model, pricing);
  if (!p) return 0;
  const cacheCost =
    (cache?.readTokens ?? 0) * p.input * CACHE_READ_RATE +
    (cache?.creationTokens ?? 0) * p.input * CACHE_WRITE_RATE;
  return ((inputTokens * p.input + outputTokens * p.output + cacheCost) / 1_000_000) * 100;
}

export function tierForModel(
  model: string,
  tiers: Record<Tier, string>,
): Tier | undefined {
  for (const [tier, modelId] of Object.entries(tiers)) {
    if (modelId === model) return tier as Tier;
  }
  return undefined;
}

/** Cost of a routed call plus its savings vs a baseline model, rounded and cache-aware. */
export interface RouteCost {
  costCents: number;
  savedCents: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Cost + savings for a completed response, including prompt-cache tokens. Shared
 * by the library (`RouteMeta`) and the proxy (`RouteEvent`) so both price a call
 * the same way. `savedCents` is `baseline − actual` and can be negative.
 *
 * `usage` may be missing/partial on an unexpected response shape — guard every
 * field so a routing proxy never crashes on cost math. The resolved token counts
 * are returned so callers record the same guarded values they priced.
 */
export function computeRouteCost(
  model: string,
  usage: Anthropic.Usage | undefined,
  defaultModel: string,
  pricing: Record<string, ModelPricing>,
): RouteCost {
  const inputTokens = usage?.input_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;
  const cache = {
    readTokens: usage?.cache_read_input_tokens ?? 0,
    creationTokens: usage?.cache_creation_input_tokens ?? 0,
  };
  const cost = computeCostCents(model, inputTokens, outputTokens, pricing, cache);
  const baseline = computeCostCents(defaultModel, inputTokens, outputTokens, pricing, cache);
  return {
    costCents: Math.round(cost * 1000) / 1000,
    savedCents: Math.round((baseline - cost) * 1000) / 1000,
    cacheReadTokens: cache.readTokens,
    cacheCreationTokens: cache.creationTokens,
    inputTokens,
    outputTokens,
  };
}
