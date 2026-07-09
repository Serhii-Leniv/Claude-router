import type Anthropic from '@anthropic-ai/sdk';
import type { Tier } from './types.js';
import { TIER_ORDER } from './models.js';

const REFUSAL_PATTERNS = [
  "i can't",
  "i'm unable",
  "i cannot",
  "i apologize but i'm not able",
  "i don't have the ability",
  "i don't have access",
  "as an ai",
  "i'm not able to",
  "i am unable",
  "i am not able",
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

  // Can't retry from opus — nowhere to escalate
  if (tierIndex >= TIER_ORDER.length - 1) {
    return { retry: false, reason: null };
  }

  // Truncation: hit max_tokens with substantive output (not empty)
  if (
    response.stop_reason === 'max_tokens' &&
    (response.usage?.output_tokens ?? 0) > 20
  ) {
    return { retry: true, reason: 'truncation' };
  }

  // Refusal: very short output opening with a refusal pattern
  const text = extractResponseText(response);
  if (text.length < 200) {
    const lower = text.toLowerCase().slice(0, REFUSAL_SCAN_CHARS);
    for (const pattern of REFUSAL_PATTERNS) {
      if (lower.includes(pattern)) {
        return { retry: true, reason: 'refusal' };
      }
    }
  }

  return { retry: false, reason: null };
}

export function nextTier(tier: Tier): Tier | null {
  const idx = TIER_ORDER.indexOf(tier);
  if (idx < 0 || idx >= TIER_ORDER.length - 1) return null;
  return TIER_ORDER[idx + 1]!;
}
