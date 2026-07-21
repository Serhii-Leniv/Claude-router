import type Anthropic from '@anthropic-ai/sdk';
import type { Tier } from './types.js';
import { ESCALATION_CEILING, TIER_ORDER } from './models.js';

// Fallback for what `stop_reason: 'refusal'` doesn't cover: older models that
// never set it, and soft refusals that arrive as `end_turn`. New languages only
// need to reach the soft-refusal case — the structural check handles the rest.
//
// Each pattern pairs the refusal modal with a refusal object/verb. Bare "i can't"
// / "i cannot" / "as an ai" over-matched benign openers ("I can't wait to help",
// "As an AI enthusiast, …") and caused needless, costly escalations, so the modals
// are anchored to what a refusal actually says next.
const REFUSAL_PATTERNS = [
  "i can't help",
  "i can't assist",
  "i can't provide",
  "i can't create",
  "i can't generate",
  "i can't write",
  "i can't do that",
  "i can't comply",
  "i can't fulfill",
  "i cannot help",
  "i cannot assist",
  "i cannot provide",
  "i cannot create",
  "i cannot generate",
  "i cannot write",
  "i cannot do that",
  "i cannot comply",
  "i cannot fulfill",
  "i'm unable to",
  "i am unable to",
  "i'm not able to",
  "i am not able to",
  "i don't have the ability",
  "i don't have access",
  "i apologize, but i can't",
  "i apologize but i'm not able",
  "as an ai language model",
  "as an ai, i can't",
  "as an ai, i cannot",

  // German — same anchoring rule: modal + refusal verb/object. "helfen"-anchored
  // variants cover the common separable word orders; broader forms like
  // "ich kann keine" or "das kann ich nicht" match benign sentences
  // ("Ich kann keine Fehler finden") and are deliberately excluded.
  "ich kann nicht helfen",
  "ich kann dabei nicht helfen",
  "ich kann dir dabei nicht helfen",
  "ich kann ihnen dabei nicht helfen",
  "ich kann ihnen nicht helfen",
  "ich kann dir nicht helfen",
  "dabei kann ich nicht helfen",
  "als ki kann ich nicht",
  "als ki-sprachmodell",
  "ich bin nicht in der lage",
];

// Refusals lead with the refusal — only scan the opening of the response,
// so a legitimate short answer that merely contains a pattern mid-sentence
// (e.g. quoting) doesn't trigger escalation.
const REFUSAL_SCAN_CHARS = 80;

export interface RetryDecision {
  retry: boolean;
  reason: 'truncation' | 'refusal' | null;
}

function extractResponseText(response: Anthropic.Message): string {
  // A routing proxy must never crash on an unexpected response shape: if `content`
  // is missing (some upstreams/edge responses omit it), skip retry inspection rather
  // than throwing — an uncaught TypeError here surfaces as a 500 to the client.
  if (!Array.isArray(response.content)) return '';
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join(' ');
}

export function shouldRetry(response: Anthropic.Message, tier: Tier): RetryDecision {
  const tierIndex = TIER_ORDER.indexOf(tier);

  // Nowhere to escalate. Gated on ESCALATION_CEILING, not on the end of
  // TIER_ORDER: adding fable above opus must not silently make opus retryable.
  if (tierIndex < 0 || tierIndex >= TIER_ORDER.indexOf(ESCALATION_CEILING)) {
    return { retry: false, reason: null };
  }

  // Truncation: hit max_tokens with substantive output (not empty)
  if (
    response.stop_reason === 'max_tokens' &&
    (response.usage?.output_tokens ?? 0) > 20
  ) {
    return { retry: true, reason: 'truncation' };
  }

  // Refusal (structural): the API reports classifier-fired refusals as
  // `stop_reason: 'refusal'` (Opus 4.7+, Sonnet 5, Fable 5). This is
  // language-independent — it covers every language the pattern list below
  // never will. Branch on `stop_reason` only: the companion `stop_details`
  // object is informational and can be null even on a genuine refusal.
  //
  // Escalation is uniform rather than per-`stop_details.category`. Opus already
  // returned above (no higher tier), so the only refusals reaching here are on
  // haiku/sonnet, where a stronger model is a reasonable bet — and `category`
  // is null for ordinary model refusals, which is exactly the case worth
  // retrying.
  //
  // Widened to string because the pinned SDK's `stop_reason` union predates the
  // value; a direct comparison is a no-overlap type error until it's added.
  const stopReason: string | null = response.stop_reason;
  if (stopReason === 'refusal') {
    return { retry: true, reason: 'refusal' };
  }

  // Refusal (lexical): still earns its place. Older models (Haiku 4.5 — our
  // default entry tier — and Sonnet 4.x) never set the structural flag, and
  // soft refusals, where the model declines conversationally rather than the
  // classifier firing, surface as `end_turn`. Very short output opening with a
  // refusal pattern. Normalize
  // typographic apostrophes (Claude output routinely uses U+2019, which the
  // straight-quote patterns would otherwise miss) and the spaced "can not"
  // form before scanning the opening.
  const text = extractResponseText(response);
  if (text.length < 200) {
    const lower = text
      .toLowerCase()
      .replace(/[‘’]/g, "'")
      .replace(/\bcan\s+not\b/g, 'cannot')
      .slice(0, REFUSAL_SCAN_CHARS);
    for (const pattern of REFUSAL_PATTERNS) {
      if (lower.includes(pattern)) {
        return { retry: true, reason: 'refusal' };
      }
    }
  }

  return { retry: false, reason: null };
}

/**
 * Next tier up for an automatic retry, or null when there is nowhere to go.
 *
 * Stops at `ESCALATION_CEILING` rather than the top of `TIER_ORDER`: fable is
 * 2x opus, and the triggers that would reach it have never fired on real
 * traffic. Reaching fable is a classification decision, not a retry decision.
 */
export function nextTier(tier: Tier): Tier | null {
  const idx = TIER_ORDER.indexOf(tier);
  const ceiling = TIER_ORDER.indexOf(ESCALATION_CEILING);
  if (idx < 0 || idx >= ceiling) return null;
  return TIER_ORDER[idx + 1]!;
}
