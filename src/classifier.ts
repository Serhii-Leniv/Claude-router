import { createHash } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { LruCache } from './cache.js';
import type { ClassifyInput, ClassifyResult, Tier } from './types.js';

const SIMPLE_VERBS = [
  'translate', 'summarize', 'format', 'convert', 'list',
  'extract', 'define', 'count', 'repeat', 'spell',
];

const MEDIUM_VERBS = [
  'explain', 'compare', 'implement', 'write', 'generate',
  'analyze', 'debug', 'refactor', 'optimize', 'describe',
];

const COMPLEX_VERBS = [
  'architect', 'design', 'evaluate', 'critique', 'reason',
  'prove', 'strategize', 'synthesize', 'theorize', 'plan',
];

const EXPERT_KEYWORDS = [
  'expert', 'senior', 'architect', 'principal', 'staff',
  'advanced', 'comprehensive', 'thorough', 'detailed analysis',
];

// Math/science concepts that are inherently complex regardless of prompt length.
// Short queries like "P=NP?" or "prove Riemann Hypothesis" must not route to Haiku.
const MATH_SCIENCE_KEYWORDS = [
  // Proof and theorem concepts
  'theorem', 'conjecture', 'proof', 'lemma', 'corollary', 'hypothesis',
  'axiom', 'postulate', 'proposition',
  // Advanced math domains
  'eigenvalue', 'eigenvector', 'determinant', 'matrix', 'matrices', 'tensor',
  'derivative', 'integral', 'differential equation', 'gradient',
  'topology', 'manifold', 'homomorphism', 'isomorphism',
  'polynomial', 'prime', 'modular arithmetic', 'number theory',
  'fourier', 'laplace', 'stochastic', 'markov',
  // Complexity theory
  'p=np', 'np-hard', 'np-complete', 'turing', 'halting problem',
  // Physics concepts
  'quantum', 'entanglement', 'wave function', 'hamiltonian',
  'riemann', 'navier-stokes', 'euler equation',
];

/** Additive score weights. BASE starts in the sonnet band; signals move it. */
export const HEURISTIC_WEIGHTS = {
  BASE: 35,
  SIMPLE_VERB: -12,
  MEDIUM_VERB: 5,
  COMPLEX_VERB: 15,
  TINY_PROMPT: -10,
  LONG_PROMPT: 10,
  VERY_LONG_PROMPT: 20,
  LONG_SENTENCE: 10,
  CODE_BLOCK: 10,
  SYMBOL_DENSITY: 8,
  MATH_KEYWORD: 25,
  MATH_TINY_OFFSET: 13,
  MATH_NOTATION: 20,
  LONG_SYSTEM: 10,
  EXPERT_SYSTEM: 15,
  MULTI_TURN: 10,
  LONG_CONVERSATION: 20,
  TOOL_BLOCKS_PRESENT: 10,
  TOOLS_DEFINED: 8,
  MANY_TOOLS: 7,
  IMAGE_BLOCK: 10,
} as const;

export const DEFAULT_AI_TIMEOUT_MS = 1500;
export const DEFAULT_CLASSIFY_CACHE_SIZE = 500;
export const DEFAULT_HYBRID_BAND: [number, number] = [40, 60];

// Ceiling on the combined contribution of harness/scaffolding signals (long
// system prompt + tool definitions + in-flight tool blocks). These are constant
// and large for agentic clients like Claude Code, so uncapped they add ~+40 and
// force Opus on every request regardless of the task. Capped, they can nudge a
// borderline call toward Sonnet but never dominate. BASE (35) + this stays well
// inside the Sonnet band, so the harness alone can never reach Opus.
export const HARNESS_SIGNAL_CAP = 15;

const AI_SNIPPET_HEAD = 700;
const AI_SNIPPET_TAIL = 300;
const AI_SYSTEM_SNIPPET = 200;
// Signal-poor prompts at least this long get AI confirmation in hybrid mode
// (typical for non-English input, which the keyword lists cannot score).
const SIGNAL_POOR_MIN_TOKENS = 20;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word-boundary matching with optional plural: "list" must not match "listen",
// but "eigenvalue" must still match "eigenvalues".
function compileKeywords(words: string[]): RegExp[] {
  return words.map((w) => new RegExp(`\\b${escapeRegex(w)}s?\\b`, 'i'));
}

const SIMPLE_RE = compileKeywords(SIMPLE_VERBS);
const MEDIUM_RE = compileKeywords(MEDIUM_VERBS);
const COMPLEX_RE = compileKeywords(COMPLEX_VERBS);
const EXPERT_RE = compileKeywords(EXPERT_KEYWORDS);
const MATH_RE = compileKeywords(MATH_SCIENCE_KEYWORDS);

function countMatches(text: string, patterns: RegExp[]): number {
  let count = 0;
  for (const re of patterns) {
    if (re.test(text)) count++;
  }
  return count;
}

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

/**
 * Text of the LATEST user turn — the actual task. Routing on the whole payload
 * lets a big constant harness (system prompt + prior turns + tool output, as in
 * Claude Code) dominate the score; the discriminating task signal lives in the
 * newest user message. Falls back to the full joined text when there is no user
 * turn with text (e.g. a turn carrying only a tool_result block).
 */
function extractLatestUserText(messages: Anthropic.MessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') {
      if (msg.content.trim()) return msg.content;
      continue;
    }
    if (Array.isArray(msg.content)) {
      const parts: string[] = [];
      for (const block of msg.content) {
        if (
          (block as { type?: string }).type === 'text' &&
          'text' in block &&
          typeof block.text === 'string'
        ) {
          parts.push(block.text);
        }
      }
      if (parts.join(' ').trim()) return parts.join(' ');
    }
  }
  return '';
}

/** Any tool definitions or in-flight tool_use/tool_result blocks → agentic session. */
function isAgentic(input: ClassifyInput): boolean {
  if ((input.tools?.length ?? 0) > 0) return true;
  for (const msg of input.messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      const t = (block as { type?: string }).type;
      if (t === 'tool_use' || t === 'tool_result') return true;
    }
  }
  return false;
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

export interface HeuristicDetail {
  score: number;
  /** Total keyword/notation signals that fired — 0 means the text gave us nothing */
  keywordHits: number;
  estimatedTokens: number;
}

export function heuristicScoreDetailed(input: ClassifyInput): HeuristicDetail {
  const W = HEURISTIC_WEIGHTS;
  const { toolBlockCount, imageCount, extraChars } = extractSignals(input.messages);
  const systemText = extractSystemText(input.system);
  // Score the TASK — the latest user turn — not the whole harness payload.
  const taskText = extractLatestUserText(input.messages);

  let score = W.BASE;

  // --- Cognitive verb signals (task text only) ---
  const simpleHits = countMatches(taskText, SIMPLE_RE);
  const mediumHits = countMatches(taskText, MEDIUM_RE);
  const complexHits = countMatches(taskText, COMPLEX_RE);

  score += simpleHits * W.SIMPLE_VERB;
  score += mediumHits * W.MEDIUM_VERB;
  score += complexHits * W.COMPLEX_VERB;

  // --- Token estimate (chars / 4, including tool_result volume) ---
  const estimatedTokens = (taskText.length + extraChars) / 4;
  // Only penalize truly empty/trivial prompts (< 5 tokens ≈ "hi", "ok", "2+2")
  // Short but substantive questions like "Prove Fermat's Last Theorem" must not be penalized
  if (estimatedTokens < 5) score += W.TINY_PROMPT;
  else if (estimatedTokens > 2000) score += W.VERY_LONG_PROMPT;
  else if (estimatedTokens > 500) score += W.LONG_PROMPT;

  // --- Sentence complexity ---
  const sentences = taskText.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  const avgSentenceLen =
    sentences.length > 0
      ? sentences.reduce((sum, s) => sum + s.trim().split(/\s+/).length, 0) /
        sentences.length
      : 0;
  if (avgSentenceLen > 25) score += W.LONG_SENTENCE;

  // --- Code block presence ---
  if (taskText.includes('```')) score += W.CODE_BLOCK;

  // --- Non-alphanumeric density (code-like content) ---
  const nonAlpha = (taskText.match(/[^a-zA-Z0-9\s]/g) || []).length;
  const density = taskText.length > 0 ? nonAlpha / taskText.length : 0;
  if (density > 0.15) score += W.SYMBOL_DENSITY;

  // --- Math/science domain signals ---
  // These are complexity signals independent of prompt length.
  // "P=NP?" is 4 chars but inherently Opus-level.
  const mathHits = countMatches(taskText, MATH_RE);
  if (mathHits > 0) {
    score += mathHits * W.MATH_KEYWORD;
    // Cancel short-prompt penalty + small bonus: "P=NP?" must not be penalized for brevity.
    if (estimatedTokens < 5) score += W.MATH_TINY_OFFSET;
  }

  // Math notation: Greek letters, equation symbols, LaTeX-style operators
  const hasMathNotation = /[∫∑∂∇∈∉⊂⊃∪∩≤≥≠≈∞√∏∧∨∀∃α-ωΑ-Ω]/.test(taskText) ||
    /d[²³]?[xyz]\/d[xyz]|\\frac|\\int|\\sum|\\nabla|\^\{|\^2|\^3/.test(taskText);
  if (hasMathNotation) score += W.MATH_NOTATION;

  // --- Image signal (a genuine task signal — vision — so it is NOT capped) ---
  if (imageCount > 0) score += W.IMAGE_BLOCK;

  // --- Harness / scaffolding signals (CAPPED) ---
  // Tool definitions, in-flight tool blocks, and a long/expert system prompt are
  // constant scaffolding for agentic clients. Summed and capped so they nudge but
  // never dominate — this is the fix for Claude Code routing everything to Opus.
  const expertHits = countMatches(systemText, EXPERT_RE);
  const toolCount = input.tools?.length ?? 0;
  let harness = 0;
  if (toolBlockCount > 0) harness += W.TOOL_BLOCKS_PRESENT;
  if (toolCount > 0) harness += W.TOOLS_DEFINED;
  if (toolCount > 8) harness += W.MANY_TOOLS;
  if (systemText.length > 500) harness += W.LONG_SYSTEM;
  if (expertHits > 0) harness += W.EXPERT_SYSTEM;
  score += Math.min(harness, HARNESS_SIGNAL_CAP);

  // --- Multi-turn signals ---
  const messageCount = input.messages.length;
  if (messageCount > 15) score += W.LONG_CONVERSATION;
  else if (messageCount > 5) score += W.MULTI_TURN;

  const keywordHits =
    simpleHits + mediumHits + complexHits + mathHits + expertHits + (hasMathNotation ? 1 : 0);

  return {
    score: Math.max(0, Math.min(100, score)),
    keywordHits,
    estimatedTokens,
  };
}

export function heuristicScore(input: ClassifyInput): number {
  return heuristicScoreDetailed(input).score;
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

export function classifyHeuristic(
  input: ClassifyInput,
  thresholds?: TierThresholds,
): ClassifyResult {
  const start = performance.now();
  const score = heuristicScore(input);
  const ms = performance.now() - start;
  return {
    tier: scoreToTier(score, thresholds),
    score,
    method: 'heuristic',
    ms: Math.round(ms * 100) / 100,
    confidence: Math.round(scoreToConfidence(score) * 100) / 100,
  };
}

export interface ClassifyOptions {
  haikuMax?: number;
  opusMin?: number;
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

export async function classifyHybrid(
  client: Anthropic,
  input: ClassifyInput,
  haikuModel: string,
  opts?: ClassifyOptions,
): Promise<ClassifyResult> {
  const start = performance.now();
  const detail = heuristicScoreDetailed(input);
  const [bandLow, bandHigh] = opts?.hybridBand ?? DEFAULT_HYBRID_BAND;

  // Confirm with AI when the score is ambiguous, or when the text produced no
  // keyword signals at all (non-English or otherwise unscorable content).
  const ambiguous = detail.score >= bandLow && detail.score <= bandHigh;
  const signalPoor =
    detail.keywordHits === 0 && detail.estimatedTokens >= SIGNAL_POOR_MIN_TOKENS;

  if (ambiguous || signalPoor) {
    return classifyAICached(client, input, haikuModel, opts);
  }

  const ms = performance.now() - start;
  return {
    tier: scoreToTier(detail.score, opts),
    score: detail.score,
    method: 'heuristic',
    ms: Math.round(ms * 100) / 100,
    confidence: Math.round(scoreToConfidence(detail.score) * 100) / 100,
  };
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
