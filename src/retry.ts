import type Anthropic from '@anthropic-ai/sdk';
import type { Tier } from './types.js';
import { TIER_ORDER } from './models.js';

const REFUSAL_PATTERNS = [
  "i can't",
  "i'm unable",
  "i cannot",
  "i apologize but i'm not able",
  "i don't have",
  "as an ai",
  "i'm not able to",
  "i am unable",
  "i am not able",
];

export interface RetryDecision {
  retry: boolean;
  reason: 'truncation' | 'refusal' | null;
}

function extractResponseText(response: Anthropic.Message): string {
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
    response.usage.output_tokens > 20
  ) {
    return { retry: true, reason: 'truncation' };
  }

  // Refusal: very short output matching refusal patterns
  const text = extractResponseText(response);
  if (text.length < 200) {
    const lower = text.toLowerCase();
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
