import type { ModelPricing, Tier } from './types.js';

export const DEFAULT_MODELS: Record<Tier, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
};

export const BEDROCK_MODELS: Record<Tier, string> = {
  haiku:  'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  sonnet: 'us.anthropic.claude-sonnet-4-6-20250514-v1:0',
  opus:   'us.anthropic.claude-opus-4-6-20250514-v1:0',
};

export const VERTEX_MODELS: Record<Tier, string> = {
  haiku:  'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus:   'claude-opus-4-6',
};

export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
  'claude-opus-4-6': { input: 15.00, output: 75.00 },
  // Bedrock model IDs — same pricing
  'us.anthropic.claude-haiku-4-5-20251001-v1:0': { input: 0.80, output: 4.00 },
  'us.anthropic.claude-sonnet-4-6-20250514-v1:0': { input: 3.00, output: 15.00 },
  'us.anthropic.claude-opus-4-6-20250514-v1:0': { input: 15.00, output: 75.00 },
};

export const TIER_ORDER: Tier[] = ['haiku', 'sonnet', 'opus'];

export function computeCostCents(
  model: string,
  inputTokens: number,
  outputTokens: number,
  pricing: Record<string, ModelPricing>,
): number {
  const p = pricing[model];
  if (!p) return 0;
  return ((inputTokens * p.input + outputTokens * p.output) / 1_000_000) * 100;
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
