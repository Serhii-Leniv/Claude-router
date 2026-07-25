import type { Tier } from './types.js';

/**
 * Reconcile model-specific request parameters with the tier we're about to route
 * to. The router chooses the model, so it must also strip or adapt any parameters
 * that model would reject — otherwise a request built for one model 400s the
 * moment it's routed to another (this is what breaks Claude Code behind the proxy:
 * it sends adaptive thinking + effort, which Haiku 4.5 rejects).
 *
 * Current-generation capability rules (per the Anthropic model docs):
 *  - Haiku 4.5: rejects `output_config.effort`, and does not support adaptive
 *    thinking (`thinking: {type: "adaptive"}`). Accepts sampling params.
 *  - Sonnet 5 / Opus 5: reject `temperature` / `top_p` / `top_k` and
 *    `thinking: {type: "enabled", budget_tokens}` — use adaptive thinking instead.
 *  - Opus 5: accepts `thinking: {type: "disabled"}` only at effort `high` or
 *    below — paired with `xhigh`/`max` it 400s. Opus 4.8 accepted the pair, so
 *    this rule arrived with the tier's promotion to Opus 5, not with the router.
 *  - Fable 5: as above, and additionally rejects `thinking: {type: "disabled"}`
 *    at any effort — thinking is always on, so the parameter must be omitted
 *    rather than switched off. A client that disables thinking (common) would
 *    otherwise 400 the moment it is routed here.
 *
 * Where a client asks for two things the routed model can't do at once
 * (disabled thinking at `xhigh`), we drop the `thinking` parameter rather than
 * quietly lowering the effort it asked for: thinking depth is the model's call,
 * effort is the caller's.
 *
 * Only model-coupled parameters are touched. `messages`, `system`, `tools`,
 * `max_tokens`, and everything else pass through unchanged.
 */
/** Effort levels above which Opus 5 refuses to have thinking switched off. */
const EFFORT_ABOVE_HIGH = new Set(['xhigh', 'max']);

/**
 * Can this tier's model take `thinking: {type: "disabled"}` as the request
 * stands? Sonnet always can; Fable never can; Opus 5 can only at effort `high`
 * or below.
 */
function acceptsDisabledThinking(tier: Tier, params: Record<string, any>): boolean {
  if (tier === 'fable') return false;
  if (tier !== 'opus') return true;
  const effort = params['output_config']?.effort;
  return !(typeof effort === 'string' && EFFORT_ABOVE_HIGH.has(effort));
}

export function normalizeParamsForTier<T extends Record<string, any>>(
  params: T,
  tier: Tier,
): T {
  const out: Record<string, any> = { ...params };

  if (tier === 'haiku') {
    // Haiku 4.5 predates adaptive thinking and the effort parameter.
    if ('thinking' in out) delete out['thinking'];
    if (out['output_config'] && typeof out['output_config'] === 'object') {
      const oc: Record<string, unknown> = { ...out['output_config'] };
      delete oc['effort'];
      if (Object.keys(oc).length === 0) delete out['output_config'];
      else out['output_config'] = oc;
    }
  } else {
    // Sonnet 5 / Opus 5 / Fable 5 reject sampling params and fixed budgets.
    delete out['temperature'];
    delete out['top_p'];
    delete out['top_k'];
    const thinking = out['thinking'];
    if (thinking && typeof thinking === 'object') {
      if (thinking.type === 'enabled') {
        const next: Record<string, unknown> = { type: 'adaptive' };
        if (thinking.display !== undefined) next['display'] = thinking.display;
        out['thinking'] = next;
      } else if (thinking.type === 'disabled' && !acceptsDisabledThinking(tier, out)) {
        // Omitting the parameter is the documented way to express "leave
        // thinking alone" — the models that reject `disabled` all default to
        // adaptive, so dropping it is the closest legal request.
        delete out['thinking'];
      }
    }
  }

  return out as T;
}
