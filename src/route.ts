import Anthropic from '@anthropic-ai/sdk';
import { TIER_ORDER } from './models.js';
import { shouldRetry, nextTier } from './retry.js';
import { normalizeParamsForTier } from './params.js';
import type { Tier } from './types.js';

/**
 * The routing execution kernel, shared by the library (`ClaudeRouter.send`) and
 * the proxy (`handleNonStreaming`). Given a chosen start tier it normalizes the
 * request for that tier's model, calls the API, optionally walks up on rate
 * limits, and escalates once if the response is truncated or a refusal.
 *
 * Keeping this in one module is what makes retry/escalation semantics consistent
 * across both callers — before, each re-implemented the loop and they had already
 * drifted on the escalation condition.
 */

export interface RouteResult {
  response: Anthropic.Message;
  tier: Tier;
  model: string;
  /** True if the served tier differs from the classified one (rate-limit walk-up or escalation). */
  fallbackUsed: boolean;
  retried: boolean;
  retryReason: 'truncation' | 'refusal' | null;
}

export interface ExecuteRouteOptions {
  /** Walk up `TIER_ORDER` on a `RateLimitError` instead of throwing. */
  fallbackOnRateLimit: boolean;
  /** Per-request SDK options forwarded to every create call (e.g. the anthropic-beta header). */
  requestOptions?: { headers: Record<string, string> };
}

export async function executeRoute(
  client: Anthropic,
  apiParams: Record<string, unknown>,
  startTier: Tier,
  models: Record<Tier, string>,
  opts: ExecuteRouteOptions,
): Promise<RouteResult> {
  const startIndex = TIER_ORDER.indexOf(startTier);
  // A tier outside TIER_ORDER would start the loop at -1 and send the API a
  // request with `model: undefined` — fail loudly at the boundary instead.
  if (startIndex < 0) {
    throw new TypeError(
      `[claude-router] Unknown tier "${startTier}" — expected one of: ${TIER_ORDER.join(', ')}`,
    );
  }
  let lastError: unknown;

  for (let i = startIndex; i < TIER_ORDER.length; i++) {
    const tier = TIER_ORDER[i]!;
    const model = models[tier];
    const fallbackUsed = i !== startIndex;

    try {
      const response = await client.messages.create(
        normalizeParamsForTier({ ...apiParams, model }, tier) as Anthropic.MessageCreateParamsNonStreaming,
        opts.requestOptions,
      );

      // Escalate only on the originally-classified tier's first response — never
      // after a rate-limit walk-up, which has already moved us up a tier.
      const decision = shouldRetry(response, tier);
      if (decision.retry && !fallbackUsed) {
        const escalated = nextTier(tier);
        if (escalated) {
          const escalatedModel = models[escalated];
          // Escalation is best-effort: if the escalated call fails (e.g. its
          // tier is rate-limited), serve the truncated/refused-but-real original
          // rather than letting the error escape into the outer catch, where a
          // RateLimitError would discard the response we already have and
          // re-walk the tiers.
          try {
            const retryResponse = await client.messages.create(
              normalizeParamsForTier(
                { ...apiParams, model: escalatedModel },
                escalated,
              ) as Anthropic.MessageCreateParamsNonStreaming,
              opts.requestOptions,
            );
            return {
              response: retryResponse,
              tier: escalated,
              model: escalatedModel,
              fallbackUsed: true,
              retried: true,
              retryReason: decision.reason,
            };
          } catch {
            return { response, tier, model, fallbackUsed, retried: false, retryReason: null };
          }
        }
      }

      return { response, tier, model, fallbackUsed, retried: false, retryReason: null };
    } catch (err) {
      lastError = err;
      if (
        opts.fallbackOnRateLimit &&
        err instanceof Anthropic.RateLimitError &&
        i < TIER_ORDER.length - 1
      ) {
        continue;
      }
      throw err;
    }
  }

  throw lastError ?? new Error('[claude-router] executeRoute exhausted all tiers without a response');
}
