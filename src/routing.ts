import type Anthropic from '@anthropic-ai/sdk';
import type { ClassifyInput, Tier } from './types.js';

/**
 * Evidence-based tier selection.
 *
 * Replaces the additive 0-100 keyword score. That design let unrelated weak
 * signals sum into an expensive decision — "matrix" (+25) and "determinant"
 * (+25) reached the Opus threshold on a beginner numpy question, with neither
 * word being evidence of difficulty. Summing is the bug, not the weights.
 *
 * Three rules replace it:
 *
 *  1. **Sonnet is the default.** Leaving it requires positive evidence.
 *  2. **Gates are conjunctive.** Every condition must hold, so two coincidental
 *     matches cannot combine into a verdict.
 *  3. **The two traffic profiles are scored differently**, because they expose
 *     different signals. Agentic sessions carry loop position; single-turn API
 *     requests carry request shape. Neither signal exists in the other profile.
 *
 * Evidence and its limits — see `research/`:
 *  - Loop position is measured (`2026-07-21-tier-ceiling.md`): mid-loop tool
 *    selection is largely tier-insensitive (sonnet adequate 75%, never a clear
 *    loss), while final synthesis is not (opus won 10 of 11).
 *  - The single-turn boundary is **unmeasured** — the attempt to measure it
 *    failed (`2026-07-21-single-turn-failed.md`). That branch is therefore
 *    deliberately conservative rather than tuned, and the haiku gate is narrow
 *    by choice, not by calibration.
 *  - Nothing licenses automatic promotion to fable, which is why it is opt-in.
 */

/**
 * Knobs that thresholded the old additive score. Gate-based routing has no score
 * to threshold, so they do nothing — but they still parse, which is worse than
 * failing: a deployment that tuned them keeps loading and silently routes
 * differently after an upgrade. Say so, once per key per process.
 *
 * Warning rather than throwing is deliberate: an upgrade must not take a working
 * proxy down over a config key that is merely obsolete.
 */
const DEAD_ROUTING_KEYS = ['haikuMax', 'opusMin', 'hybridBand'] as const;
const warnedDeadKeys = new Set<string>();

/** @internal Test hook */
export function resetDeadRoutingWarnings(): void {
  warnedDeadKeys.clear();
}

export function warnDeadRoutingKeys(routing: Record<string, unknown> | undefined): void {
  if (!routing) return;
  for (const key of DEAD_ROUTING_KEYS) {
    if (routing[key] === undefined || warnedDeadKeys.has(key)) continue;
    warnedDeadKeys.add(key);
    console.warn(
      `[claude-router] config: routing.${key} no longer does anything and is ignored. ` +
        `It thresholded the 0-100 classifier score, which was replaced by evidence-based ` +
        `gates in 0.2.2 — there is no score to threshold. Routing may differ from what ` +
        `this config produced before. Remove the key to silence this.`,
    );
  }
}

export interface RouteDecision {
  tier: Tier;
  /** Why this tier — surfaced in logs and the dashboard so routing is auditable. */
  reason: string;
  /** Confidence 0-1. Defaults are low-confidence by construction. */
  confidence: number;
}

export interface RoutingOptions {
  /** Allow classification to reach fable. Off by default — see `promoteToFable`. */
  allowFable?: boolean;
  /** Let a clearly-trivial turn inside a tool session reach haiku. Default false. */
  allowHaikuInAgentic?: boolean;
}

/** Verbs whose object is a mechanical transformation rather than a judgement. */
const TRANSFORM_VERBS =
  /\b(translate|reformat|format|convert|rename|extract|list|count|spell|capitali[sz]e|lowercase|uppercase|sort)s?\b/i;

/** Explicit, unambiguous requests for depth. Not topic words — intent words. */
const DEPTH_MARKERS =
  /\b(architect|design\s+(a|an|the)\s+\w+\s+(system|architecture)|prove|derive|critique|trade[- ]?offs?|end[- ]to[- ]end|from\s+scratch|migrat(e|ion)\s+plan|threat\s+model)\b/i;

/** Signals that a request is a long-horizon build rather than a question. */
const LONG_HORIZON =
  /\b(refactor\s+the\s+(whole|entire)|rewrite\s+the\s+(whole|entire)|multi[- ]?step|step[- ]by[- ]step\s+plan|across\s+the\s+(codebase|repo|repository))\b/i;

const HAIKU_MAX_CHARS = 400;
const HAIKU_MAX_SYSTEM_CHARS = 400;

function blocksOf(msg: Anthropic.MessageParam): Array<Record<string, unknown>> {
  return Array.isArray(msg.content)
    ? (msg.content as unknown as Array<Record<string, unknown>>)
    : [];
}

function textOf(content: Anthropic.MessageParam['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => (b as { type?: string }).type === 'text')
    .map((b) => (b as { text?: string }).text ?? '')
    .join(' ');
}

function systemText(system: ClassifyInput['system']): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system
    .filter((b): b is Anthropic.TextBlockParam => b.type === 'text')
    .map((b) => b.text)
    .join(' ');
}

/** Tool definitions present, or tool traffic already in the conversation. */
export function isAgentic(input: ClassifyInput): boolean {
  if ((input.tools?.length ?? 0) > 0) return true;
  for (const msg of input.messages) {
    for (const b of blocksOf(msg)) {
      const t = b['type'];
      if (t === 'tool_use' || t === 'tool_result') return true;
    }
  }
  return false;
}

/**
 * True when the newest message is a tool result — the model is being asked to
 * pick the next action inside a loop, not to produce a final answer.
 *
 * This is the one routing signal in the codebase with a direct measurement
 * behind it, and it is purely structural: no keywords, no language dependence,
 * no verb-without-object failure mode.
 */
export function isMidLoop(input: ClassifyInput): boolean {
  const last = input.messages[input.messages.length - 1];
  if (!last || last.role !== 'user') return false;
  const blocks = blocksOf(last);
  if (blocks.length === 0) return false;
  return blocks.some((b) => b['type'] === 'tool_result');
}

/**
 * Harness context Claude Code injects into the user turn — CLAUDE.md, skill
 * listings, agent rosters, the date. Picking the newest user turn is not enough
 * to isolate the request, because the injection travels *inside* that turn.
 *
 * Measured, not assumed. Captured from a real session by pointing
 * ANTHROPIC_BASE_URL at a recording upstream: the opening request of
 * `claude -p "read package.json then tsconfig.json and tell me the build target"`
 * carries a 21,558-character injected block ahead of the user's 65 characters.
 * This project's own CLAUDE.md contains "end-to-end", a `DEPTH_MARKERS` hit, so
 * the gate promoted a mundane file-reading request to opus on the strength of
 * the repo's documentation. Any repo whose CLAUDE.md contains a depth word pays
 * opus rates on every turn.
 *
 * The test is **structural, not textual**: an injected block is its own text
 * block, opening and closing with the tag. We drop whole blocks and never parse
 * inside them.
 *
 * That distinction is the whole point, and it was learned the hard way. The
 * first attempt stripped `<system-reminder>[\s\S]*?</system-reminder>` with a
 * regex. It failed on this very repo, because the sentence you are reading
 * documents the tag — CLAUDE.md gets injected, so the literal closing tag in
 * this file terminated the non-greedy match 8,039 characters in and left 13,519
 * characters of documentation behind, still carrying the depth marker. Any
 * content that so much as mentions the tag defeats a regex; block boundaries
 * cannot be forged by content.
 */
function isInjectedContext(text: string): boolean {
  const t = text.trim();
  return t.startsWith('<system-reminder>') && t.endsWith('</system-reminder>');
}

/**
 * The task text: what the user actually asked for on the newest turn, with
 * harness injections dropped.
 *
 * Every path that scores request content goes through this — the gates in this
 * file and the AI classifier's snippet alike. Scoring the joined message array
 * is what let prior turns and tool_result payloads outvote the request (#18);
 * keeping the injected blocks is what let the project's own documentation do
 * the same (#34).
 *
 * A turn that is *only* injected context yields nothing, so we keep walking
 * back to the last turn that carried a real request.
 */
export function latestUserText(input: ClassifyInput): string {
  for (let i = input.messages.length - 1; i >= 0; i--) {
    const m = input.messages[i]!;
    if (m.role !== 'user') continue;
    const t = requestText(m.content);
    if (t) return t;
  }
  return '';
}

/**
 * Claude Code's own meta-calls quote the conversation they are asking about, then
 * state the actual instruction after it:
 *
 *     <session>
 *     architect a distributed cache from scratch and prove the invariants
 *     </session>
 *
 *     Write the title in the predominant language of the session — …
 *
 * The task is "write a title". The quoted prompt is the *subject*, and scoring it
 * charged opus to name a session. Measured on a 45-request wire corpus: these
 * meta-calls are 29% of all requests, and every session whose opening prompt
 * carries a depth word bought opus for a five-word title.
 *
 * Unlike the reminder blocks above, this arrives inline in the same text block,
 * so it has to be matched rather than dropped structurally — and the match is
 * **greedy on purpose**. The real closing tag is the last one, because the
 * instruction follows it, so quoted content containing the literal tag cannot
 * terminate the match early. That is precisely the failure that killed the
 * non-greedy attempt at the reminder strip; here the delimiter ordering rules it
 * out, and for reminders we do not rely on matching at all.
 */
const QUOTED_SESSION = /<session>[\s\S]*<\/session>/;

/** Text the user supplied, with injected blocks and quoted material removed. */
function requestText(content: Anthropic.MessageParam['content']): string {
  const clean = (t: string) => t.replace(QUOTED_SESSION, ' ').trim();
  if (typeof content === 'string') {
    return isInjectedContext(content) ? '' : clean(content);
  }
  if (!Array.isArray(content)) return '';
  return clean(
    content
      .filter((b) => (b as { type?: string }).type === 'text')
      .map((b) => (b as { text?: string }).text ?? '')
      .filter((t) => !isInjectedContext(t))
      .join(' '),
  );
}

/**
 * Demotion to haiku. Every condition must hold — this is the gate that the old
 * additive score could not express.
 *
 * Deliberately narrow. The single-turn boundary is unmeasured, and the one
 * signal that did survive the failed experiment is that haiku falls clearly
 * behind on open-ended developer requests (20 clear losses of 21). So this
 * fires only for short, self-contained, mechanical transformations.
 */
function demoteToHaiku(input: ClassifyInput, task: string, inAgentic = false): boolean {
  // Tool definitions normally disqualify outright. The agentic caller has
  // already opted in explicitly, so skip that check there — otherwise
  // `allowHaikuInAgentic` could never fire, since an agentic session has tools
  // by definition.
  if (!inAgentic && (input.tools?.length ?? 0) > 0) return false;
  if (input.messages.length > 1) return false;           // conversation implies carried context
  if (task.length > HAIKU_MAX_CHARS) return false;
  if (task.includes('```')) return false;                // code in, code out
  if (systemText(input.system).length > HAIKU_MAX_SYSTEM_CHARS) return false;
  for (const m of input.messages) {
    for (const b of blocksOf(m)) if (b['type'] === 'image') return false;
  }
  if (DEPTH_MARKERS.test(task)) return false;
  // Positive evidence, not merely absence of complexity signals.
  return TRANSFORM_VERBS.test(task);
}

/** Promotion to opus. Requires an explicit request for depth, not a topic word. */
function promoteToOpus(task: string): boolean {
  return DEPTH_MARKERS.test(task) || LONG_HORIZON.test(task);
}

/**
 * Promotion to fable. Opt-in only (`allowFable`), and never on heuristics alone.
 *
 * Fable is $10/$50 — 2x opus and 10x haiku, so a wrong promotion here is the
 * most expensive mistake the router can make. No measurement in `research/`
 * supports predicting "super hard" from request text, and the literature review
 * found every measured router collapsing off-distribution. Until there is
 * evidence, reaching fable requires the caller to ask for it.
 */
function promoteToFable(task: string, opts?: RoutingOptions): boolean {
  if (!opts?.allowFable) return false;
  return DEPTH_MARKERS.test(task) && LONG_HORIZON.test(task);
}

export function routeByEvidence(input: ClassifyInput, opts?: RoutingOptions): RouteDecision {
  const task = latestUserText(input);

  if (isAgentic(input)) {
    // Measured: mid-loop tool selection is largely tier-insensitive.
    if (isMidLoop(input)) {
      return { tier: 'sonnet', reason: 'agentic:mid-loop', confidence: 0.75 };
    }
    // A fresh instruction inside a tool session — this is where synthesis lives,
    // and where opus measurably earned its cost. Promote on explicit depth only.
    if (promoteToFable(task, opts)) {
      return { tier: 'fable', reason: 'agentic:depth+long-horizon', confidence: 0.5 };
    }
    if (promoteToOpus(task)) {
      return { tier: 'opus', reason: 'agentic:depth-requested', confidence: 0.6 };
    }
    if (opts?.allowHaikuInAgentic && demoteToHaiku(input, task, true)) {
      return { tier: 'haiku', reason: 'agentic:trivial (opt-in)', confidence: 0.4 };
    }
    return { tier: 'sonnet', reason: 'agentic:default', confidence: 0.6 };
  }

  // Single-turn. Boundary unmeasured — conservative by construction.
  if (promoteToFable(task, opts)) {
    return { tier: 'fable', reason: 'single-turn:depth+long-horizon', confidence: 0.5 };
  }
  if (promoteToOpus(task)) {
    return { tier: 'opus', reason: 'single-turn:depth-requested', confidence: 0.6 };
  }
  if (demoteToHaiku(input, task)) {
    return { tier: 'haiku', reason: 'single-turn:short mechanical transform', confidence: 0.6 };
  }
  return { tier: 'sonnet', reason: 'single-turn:default', confidence: 0.5 };
}
