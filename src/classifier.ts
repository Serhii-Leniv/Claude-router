import { createHash } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { LruCache } from './cache.js';
import { isAgentic, routeByEvidence } from './routing.js';
import type { ClassifyInput, ClassifyResult, Tier } from './types.js';

export const DEFAULT_AI_TIMEOUT_MS = 1500;
export const DEFAULT_CLASSIFY_CACHE_SIZE = 500;

const AI_SNIPPET_HEAD = 700;
const AI_SNIPPET_TAIL = 300;
const AI_SYSTEM_SNIPPET = 200;
interface ExtractedSignals {
  text: string;
  toolBlockCount: number;
  imageCount: number;
  /** Character volume inside tool_result blocks — context size only, not keyword-matched */
  extraChars: number;
}

function extractSignals(messages: Anthropic.MessageParam[]): ExtractedSignals {
  const parts: string[] = [];
  let toolBlockCount = 0;
  let imageCount = 0;
  let extraChars = 0;

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      parts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        const type = (block as { type?: string }).type;
        if (type === 'text' && 'text' in block && typeof block.text === 'string') {
          parts.push(block.text);
        } else if (type === 'tool_use') {
          toolBlockCount++;
        } else if (type === 'tool_result') {
          toolBlockCount++;
          const content = (block as { content?: unknown }).content;
          if (typeof content === 'string') {
            extraChars += content.length;
          } else if (content !== undefined) {
            try {
              extraChars += JSON.stringify(content).length;
            } catch {
              // circular or unserializable tool content — skip sizing
            }
          }
        } else if (type === 'image') {
          imageCount++;
        }
      }
    }
  }

  return { text: parts.join(' '), toolBlockCount, imageCount, extraChars };
}

function extractSystemText(
  system: string | Anthropic.TextBlockParam[] | undefined,
): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system
    .filter((b): b is Anthropic.TextBlockParam => b.type === 'text')
    .map((b) => b.text)
    .join(' ');
}

export interface TierThresholds {
  haikuMax?: number;
  opusMin?: number;
}

export function scoreToTier(score: number, thresholds?: TierThresholds): Tier {
  if (score < (thresholds?.haikuMax ?? 30)) return 'haiku';
  if (score > (thresholds?.opusMin ?? 70)) return 'opus';
  return 'sonnet';
}

export function scoreToConfidence(score: number): number {
  // Distance from ambiguous center (50). Farther = more confident.
  // Score 0→1.0, 20→0.9, 40→0.7, 50→0.5, 60→0.7, 80→0.9, 100→1.0
  return Math.min(1, Math.abs(score - 50) / 50 + 0.5);
}

/**
 * Nominal score per tier, kept only so `RouteMeta.score`, the dashboard, and the
 * `x-router-*` headers keep reporting a number. Routing no longer flows through
 * a score — see `routeByEvidence` for why summing signals was the bug.
 */
const NOMINAL_SCORE: Record<Tier, number> = {
  haiku: 15,
  sonnet: 50,
  opus: 80,
  fable: 95,
};

export function classifyHeuristic(
  input: ClassifyInput,
  opts?: ClassifyOptions,
): ClassifyResult {
  const start = performance.now();
  const decision = routeByEvidence(input, opts);
  const ms = performance.now() - start;
  return {
    tier: decision.tier,
    score: NOMINAL_SCORE[decision.tier],
    method: 'heuristic',
    ms: Math.round(ms * 100) / 100,
    confidence: decision.confidence,
    reason: decision.reason,
  };
}

export interface ClassifyOptions {
  /**
   * @deprecated No-op. These were score thresholds, and gate-based routing has
   * no score to threshold. Still accepted so existing config files load, but
   * they no longer influence any decision — see `routeByEvidence`. They are
   * kept rather than removed so a stale config fails loudly at review time
   * instead of silently changing behaviour on upgrade.
   */
  haikuMax?: number;
  /** @deprecated No-op — see `haikuMax`. */
  opusMin?: number;
  /** @deprecated No-op. Hybrid now defers to AI when no gate fired. */
  hybridBand?: [number, number];
  aiTimeoutMs?: number;
  /** Caller-owned cache for AI classification results; undefined = no caching */
  cache?: LruCache<string, ClassifyResult>;
  /** Allow haiku inside a tool-using session; default false floors it at sonnet */
  allowHaikuInAgentic?: boolean;
}

/**
 * Floor an agentic (tool-using) session at sonnet: a trivial-LOOKING turn in a
 * coding loop can be hard to execute, and a wrong cheap step cascades into more
 * work (and cost). Opt out with allowHaikuInAgentic to let clearly-trivial turns
 * reach haiku. No-op when tools are absent or the tier is already ≥ sonnet.
 */
function applyAgenticFloor(
  result: ClassifyResult,
  input: ClassifyInput,
  opts?: ClassifyOptions,
): ClassifyResult {
  if (result.tier !== 'haiku' || opts?.allowHaikuInAgentic || !isAgentic(input)) {
    return result;
  }
  const score = Math.max(result.score, opts?.haikuMax ?? 30);
  return {
    ...result,
    tier: 'sonnet',
    score,
    confidence: Math.round(scoreToConfidence(score) * 100) / 100,
    floored: true,
  };
}

function buildAISnippet(input: ClassifyInput): string {
  const { text } = extractSignals(input.messages);
  const snippet =
    text.length > AI_SNIPPET_HEAD + AI_SNIPPET_TAIL
      ? `${text.slice(0, AI_SNIPPET_HEAD)} … ${text.slice(-AI_SNIPPET_TAIL)}`
      : text;
  const sysSnippet = extractSystemText(input.system).slice(0, AI_SYSTEM_SNIPPET);
  return sysSnippet ? `System: ${sysSnippet}\nTask: ${snippet}` : `Task: ${snippet}`;
}

function cacheKey(input: ClassifyInput): string {
  const { text } = extractSignals(input.messages);
  const sys = extractSystemText(input.system);
  // Hash the FULL normalized text/system — a prefix slice (formerly 500/200
  // chars) collides for prompts that share a long preamble but diverge later
  // (common in agentic/Claude Code traffic), serving a stale tier for a
  // genuinely different task. SHA1 over a few KB is negligible next to an API call.
  return createHash('sha1')
    .update(text.trim().toLowerCase())
    .update('\0')
    .update(sys.trim().toLowerCase())
    .update('\0')
    .update(String(input.messages.length))
    .update('\0')
    .update(String(input.tools?.length ?? 0))
    .digest('hex');
}

export async function classifyAI(
  client: Anthropic,
  input: ClassifyInput,
  haikuModel: string,
  opts?: { timeoutMs?: number; haikuMax?: number; opusMin?: number },
): Promise<ClassifyResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS;
  const thresholds: TierThresholds = { haikuMax: opts?.haikuMax, opusMin: opts?.opusMin };
  const start = performance.now();

  let response: Anthropic.Message;
  try {
    response = await client.messages.create(
      {
        model: haikuModel,
        max_tokens: 4,
        messages: [
          {
            role: 'user',
            content: `Task complexity 1-3. 1=simple factual/translation/formatting. 2=reasoning/code/analysis. 3=architecture/creative/multi-step. Reply with ONLY the number.\n\n${buildAISnippet(input)}`,
          },
        ],
      },
      { signal: AbortSignal.timeout(timeoutMs) },
    );
  } catch {
    // Haiku timeout/outage must never break routing — fall back to heuristic,
    // preserving any custom thresholds so a transient outage doesn't silently
    // change routing for tuned deployments.
    return classifyHeuristic(input, thresholds);
  }
  const ms = performance.now() - start;

  let level = 2; // default sonnet
  let cleanParse = false;
  const responseText = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join(' ');
  const digit = responseText.match(/[1-3]/);
  if (digit) {
    level = parseInt(digit[0], 10);
    cleanParse = true;
  }

  const score = level === 1 ? 15 : level === 2 ? 50 : 85;

  return {
    // Map the synthetic score through scoreToTier so custom haikuMax/opusMin
    // apply here too — a hardcoded level→tier map silently ignored them (with
    // default thresholds this is identical to {1:haiku,2:sonnet,3:opus}).
    tier: scoreToTier(score, thresholds),
    score,
    method: 'ai',
    ms: Math.round(ms * 100) / 100,
    confidence: cleanParse ? 0.9 : 0.6,
  };
}

async function classifyAICached(
  client: Anthropic,
  input: ClassifyInput,
  haikuModel: string,
  opts?: ClassifyOptions,
): Promise<ClassifyResult> {
  const key = opts?.cache ? cacheKey(input) : null;
  if (key) {
    const hit = opts!.cache!.get(key);
    if (hit) return { ...hit, ms: 0, cached: true };
  }
  const result = await classifyAI(client, input, haikuModel, {
    timeoutMs: opts?.aiTimeoutMs,
    haikuMax: opts?.haikuMax,
    opusMin: opts?.opusMin,
  });
  // Only genuine AI verdicts are worth caching — heuristic fallbacks are free to recompute
  if (key && result.method === 'ai') {
    opts!.cache!.set(key, result);
  }
  return result;
}

/**
 * Confirm with AI only where the gates produced no verdict.
 *
 * The old band test ("score between 40 and 60") no longer exists, because there
 * is no score to sit between thresholds. Its replacement is more direct: a gate
 * either fired on positive evidence or it did not. When none fired we fell back
 * to the default tier, and *that* is the case worth spending a Haiku call on.
 *
 * This also drops the old `signalPoor` rule (zero keyword hits + enough tokens),
 * which existed to catch non-English text the keyword lists could not score.
 * Gates keyed on request shape rather than vocabulary do not have that blind
 * spot for the structural decisions; where they abstain, the default path below
 * already routes to AI confirmation.
 */
export async function classifyHybrid(
  client: Anthropic,
  input: ClassifyInput,
  haikuModel: string,
  opts?: ClassifyOptions,
): Promise<ClassifyResult> {
  const decision = routeByEvidence(input, opts);
  if (decision.reason.endsWith(':default')) {
    return classifyAICached(client, input, haikuModel, opts);
  }
  return classifyHeuristic(input, opts);
}

/**
 * Unified classification entry point used by both the library and the proxy.
 * Never throws: AI failures fall back to the heuristic result.
 */
export async function classify(
  client: Anthropic | null,
  input: ClassifyInput,
  mode: 'heuristic' | 'ai' | 'hybrid',
  haikuModel: string,
  opts?: ClassifyOptions,
): Promise<ClassifyResult> {
  const result = await (mode === 'heuristic' || !client
    ? classifyHeuristic(input, opts)
    : mode === 'ai'
      ? classifyAICached(client, input, haikuModel, opts)
      : classifyHybrid(client, input, haikuModel, opts));
  // Floor agentic sessions at sonnet (unless opted out) regardless of method.
  return applyAgenticFloor(result, input, opts);
}
