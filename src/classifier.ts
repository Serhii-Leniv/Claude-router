import type Anthropic from '@anthropic-ai/sdk';
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

function extractText(messages: Anthropic.MessageParam[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      parts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if ('text' in block && typeof block.text === 'string') {
          parts.push(block.text);
        }
      }
    }
  }
  return parts.join(' ');
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

function countMatches(text: string, words: string[]): number {
  const lower = text.toLowerCase();
  let count = 0;
  for (const word of words) {
    if (lower.includes(word)) count++;
  }
  return count;
}

export function heuristicScore(input: ClassifyInput): number {
  const text = extractText(input.messages);
  const systemText = extractSystemText(input.system);
  const combined = text + ' ' + systemText;
  const lower = combined.toLowerCase();

  let score = 35; // start in sonnet range

  // --- Cognitive verb signals ---
  const simpleHits = countMatches(lower, SIMPLE_VERBS);
  const mediumHits = countMatches(lower, MEDIUM_VERBS);
  const complexHits = countMatches(lower, COMPLEX_VERBS);

  score -= simpleHits * 12;
  score += mediumHits * 5;
  score += complexHits * 15;

  // --- Token estimate (chars / 4) ---
  const estimatedTokens = text.length / 4;
  if (estimatedTokens < 20) score -= 10;
  else if (estimatedTokens > 500) score += 10;
  else if (estimatedTokens > 2000) score += 20;

  // --- Sentence complexity ---
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  const avgSentenceLen =
    sentences.length > 0
      ? sentences.reduce((sum, s) => sum + s.trim().split(/\s+/).length, 0) /
        sentences.length
      : 0;
  if (avgSentenceLen > 25) score += 10;
  if (avgSentenceLen < 8) score -= 5;

  // --- Code block presence ---
  if (text.includes('```')) score += 10;

  // --- Non-alphanumeric density (code-like content) ---
  const nonAlpha = (text.match(/[^a-zA-Z0-9\s]/g) || []).length;
  const density = text.length > 0 ? nonAlpha / text.length : 0;
  if (density > 0.15) score += 8;

  // --- System prompt signals ---
  if (systemText.length > 500) score += 10;
  if (countMatches(systemText.toLowerCase(), EXPERT_KEYWORDS) > 0) score += 15;

  // --- Multi-turn signals ---
  const messageCount = input.messages.length;
  if (messageCount > 15) score += 20;
  else if (messageCount > 5) score += 10;

  // Clamp 0–100
  return Math.max(0, Math.min(100, score));
}

export function scoreToTier(score: number): Tier {
  if (score < 30) return 'haiku';
  if (score > 70) return 'opus';
  return 'sonnet';
}

export function scoreToConfidence(score: number): number {
  // Distance from ambiguous center (50). Farther = more confident.
  // Score 0→1.0, 20→0.9, 40→0.7, 50→0.5, 60→0.7, 80→0.9, 100→1.0
  return Math.min(1, Math.abs(score - 50) / 50 + 0.5);
}

export function classifyHeuristic(input: ClassifyInput): ClassifyResult {
  const start = performance.now();
  const score = heuristicScore(input);
  const ms = performance.now() - start;
  return {
    tier: scoreToTier(score),
    score,
    method: 'heuristic',
    ms: Math.round(ms * 100) / 100,
    confidence: Math.round(scoreToConfidence(score) * 100) / 100,
  };
}

export async function classifyAI(
  client: Anthropic,
  input: ClassifyInput,
  haikuModel: string,
): Promise<ClassifyResult> {
  const text = extractText(input.messages);
  const snippet = text.slice(0, 200);

  const start = performance.now();
  const response = await client.messages.create({
    model: haikuModel,
    max_tokens: 4,
    messages: [
      {
        role: 'user',
        content: `Task complexity 1-3. 1=simple factual/translation/formatting. 2=reasoning/code/analysis. 3=architecture/creative/multi-step. Reply with ONLY the number.\n\nTask: ${snippet}`,
      },
    ],
  });
  const ms = performance.now() - start;

  let level = 2; // default sonnet
  let cleanParse = false;
  const responseText =
    response.content[0]?.type === 'text' ? response.content[0].text.trim() : '';
  const parsed = parseInt(responseText, 10);
  if (parsed >= 1 && parsed <= 3) {
    level = parsed;
    cleanParse = true;
  }

  const tierMap: Record<number, Tier> = { 1: 'haiku', 2: 'sonnet', 3: 'opus' };
  const score = level === 1 ? 15 : level === 2 ? 50 : 85;

  return {
    tier: tierMap[level]!,
    score,
    method: 'ai',
    ms: Math.round(ms * 100) / 100,
    confidence: cleanParse ? 0.9 : 0.6,
  };
}

export async function classifyHybrid(
  client: Anthropic,
  input: ClassifyInput,
  haikuModel: string,
): Promise<ClassifyResult> {
  const heuristic = classifyHeuristic(input);

  // Ambiguous zone — confirm with AI
  if (heuristic.score >= 40 && heuristic.score <= 60) {
    return classifyAI(client, input, haikuModel);
  }

  return heuristic;
}
