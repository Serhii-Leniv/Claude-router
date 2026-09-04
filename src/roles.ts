import type Anthropic from '@anthropic-ai/sdk';
import { familyForModel, TIER_ORDER } from './models.js';
import type { Tier } from './types.js';

/**
 * Role routing for Claude Code subagents.
 *
 * A subagent request tells the proxy three structural things: it *is* a
 * subagent (the `x-claude-code-agent-id` header), what it is allowed to do
 * (the `tools` array is the agent definition's allowlist), and what it was
 * written to be (the agent definition's body arrives as the request's system
 * prompt). None of that is request *text* — no keyword is scored here, for the
 * reasons `routeByEvidence` documents. The one thing read from the prompt is a
 * marker we author ourselves, and it is read as a block prefix, never searched
 * for.
 *
 * Roles are the router's own vocabulary for the shapes of work a coordinator
 * hands off:
 *
 *   recon    read-only reconnaissance — find things, report facts       → haiku
 *   builder  scoped implementation that needs local judgement            → sonnet
 *   batch    same-shape edits across many files, fully specified          → sonnet
 *   gate     fresh-context readiness check before risky work is approved → opus
 *   audit    fresh-context falsification after risky work lands           → opus
 *
 * The shipped agent definitions (`plugin/agents/*.md`) open with the marker for
 * their role, so the proxy pins the tier deterministically and skips the
 * classifier. Roles also give the ledger a "by role" axis that no prompt-level
 * policy can produce, because a prompt never sees the bill.
 */

export type Role = 'recon' | 'builder' | 'batch' | 'gate' | 'audit';
export const ROLES: readonly Role[] = ['recon', 'builder', 'batch', 'gate', 'audit'];

export const DEFAULT_ROLE_TIERS: Readonly<Record<Role, Tier>> = {
  recon: 'haiku',
  builder: 'sonnet',
  batch: 'sonnet',
  gate: 'opus',
  audit: 'opus',
};

/**
 * The marker an agent definition opens with: `<!-- claude-router:role=recon -->`
 * on the first line of the body. An HTML comment renders as nothing in every
 * Markdown viewer, so it costs the agent no instruction text.
 */
export const ROLE_MARKER_PREFIX = '<!-- claude-router:role=';
const ROLE_MARKER_SUFFIX = '-->';
const ROLE_NAME = /^[a-z][a-z0-9-]{0,39}$/;

export function roleMarker(role: string): string {
  return `${ROLE_MARKER_PREFIX}${role} ${ROLE_MARKER_SUFFIX}`;
}

export type RoleSource = 'marker' | 'agent' | 'shape';

export interface RoleDecision {
  role: string;
  source: RoleSource;
  /** Present when the role decides the tier; absent when it is only a label. */
  tier?: Tier;
  /** What `x-router-reason` / `RouteEvent.reason` will carry when pinned. */
  reason: string;
  /** True when `tier` is set: the classifier is skipped. */
  pinned: boolean;
}

export interface RoleConfig {
  /** Override the tier a role routes to (`{ builder: 'opus' }`). */
  roles?: Partial<Record<string, Tier>>;
  /** Pin third-party agents by their Claude Code `agent_type` (`{ 'some-plugin:reviewer': 'opus' }`). */
  agents?: Record<string, Tier>;
}

export interface RoleInput {
  system: string | Anthropic.TextBlockParam[] | undefined;
  tools: unknown[] | undefined;
  /** The `model` the client asked for — used only to confirm a cheap choice, never to override one. */
  requestedModel: string | undefined;
  /** Claude Code's `agent_type` for this subagent, when the registry knows it. */
  agentType?: string;
}

/**
 * Read a role marker from the system prompt.
 *
 * Structural, like `isInjectedContext` in routing.ts: only the **first line of
 * a text block** is examined, and only as a prefix. A block that mentions the
 * marker mid-sentence (documentation quoting it, a user pasting it into a
 * question) cannot match, because content cannot move itself to a block
 * boundary. The block index is unconstrained on purpose — Claude Code prepends
 * its own attribution block ahead of the agent body — but nothing *inside* a
 * block is searched. If the client ever prepends text to the body itself, this
 * stops matching and returns null rather than guessing; the tool-shape rule
 * still applies.
 */
export function roleFromMarker(system: RoleInput['system']): string | null {
  if (!system) return null;
  const texts = typeof system === 'string'
    ? [system]
    : system.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text);
  for (const text of texts) {
    const firstLine = text.trimStart().split('\n', 1)[0]!.trimEnd();
    if (!firstLine.startsWith(ROLE_MARKER_PREFIX) || !firstLine.endsWith(ROLE_MARKER_SUFFIX)) continue;
    const role = firstLine.slice(ROLE_MARKER_PREFIX.length, -ROLE_MARKER_SUFFIX.length).trim();
    return ROLE_NAME.test(role) ? role : null;
  }
  return null;
}

/**
 * Tools that only observe. A subagent whose whole allowlist is drawn from here
 * cannot mutate anything, which is the shape of reconnaissance — and also of a
 * read-only reviewer, which is why shape alone never pins a tier *down*.
 */
const READ_ONLY_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'NotebookRead',
  'WebFetch', 'WebSearch', 'ToolSearch', 'TodoWrite', 'TodoRead', 'Skill',
]);
/** Tools that spawn more agents: a leaf that carries these is not a leaf. */
const DISPATCH_TOOLS = new Set(['Agent', 'Task', 'Workflow']);
/** Tools that change the world. */
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell']);

function toolNames(tools: unknown[] | undefined): string[] | null {
  if (!Array.isArray(tools) || tools.length === 0) return null;
  const names: string[] = [];
  for (const t of tools) {
    const name = (t as { name?: unknown } | null)?.name;
    if (typeof name !== 'string') return null;
    names.push(name);
  }
  return names;
}

/**
 * Infer a role from the tool set. Positive evidence only: every tool must be
 * in the read-only set for `recon` (an `mcp__*` tool is unknown, so it
 * disqualifies), and `builder` needs a write tool with no dispatch tool.
 *
 * The result **pins** only in the cheap direction: a read-only agent the
 * client already runs on haiku is confirmed at haiku (the agentic floor used
 * to lift the built-in Explore agent to sonnet — a live waste). A read-only
 * agent on opus is *not* demoted, because from one request `model: opus`
 * cannot be told apart as "the definition pins opus" (a reviewer) versus
 * "inherited from an opus coordinator" (a scout). Demotion needs a marker or
 * a name mapping — something the operator wrote.
 */
export function roleFromToolShape(
  tools: unknown[] | undefined,
  requestedModel: string | undefined,
): RoleDecision | null {
  const names = toolNames(tools);
  if (!names) return null;
  const readOnly = names.every((n) => READ_ONLY_TOOLS.has(n));
  if (readOnly) {
    const pin = requestedModel !== undefined && familyForModel(requestedModel) === 'haiku';
    return pin
      ? { role: 'recon', source: 'shape', tier: 'haiku', reason: 'subagent:readonly-tools', pinned: true }
      : { role: 'recon', source: 'shape', reason: 'subagent:readonly-tools', pinned: false };
  }
  const writes = names.some((n) => WRITE_TOOLS.has(n));
  const dispatches = names.some((n) => DISPATCH_TOOLS.has(n));
  if (writes && !dispatches) {
    return { role: 'builder', source: 'shape', reason: 'subagent:write-tools', pinned: false };
  }
  return null;
}

function isTier(value: unknown): value is Tier {
  return typeof value === 'string' && (TIER_ORDER as string[]).includes(value);
}

/**
 * Precedence: marker → agent-type mapping → tool shape. A marker or mapping
 * whose tier is not a real tier (a config typo) is skipped rather than sent to
 * the API as `model: undefined` — the same degrade rule `sessionModel` uses.
 */
export function resolveRole(input: RoleInput, config: RoleConfig = {}): RoleDecision | null {
  const marked = roleFromMarker(input.system);
  if (marked) {
    const tier = config.roles?.[marked] ?? (DEFAULT_ROLE_TIERS as Record<string, Tier | undefined>)[marked];
    if (isTier(tier)) {
      return { role: marked, source: 'marker', tier, reason: `role:${marked}`, pinned: true };
    }
  }
  if (input.agentType) {
    const tier = config.agents?.[input.agentType];
    if (isTier(tier)) {
      return { role: input.agentType, source: 'agent', tier, reason: `agent:${input.agentType}`, pinned: true };
    }
  }
  const shaped = roleFromToolShape(input.tools, input.requestedModel);
  if (shaped?.pinned && shaped.tier) {
    // `roles.recon` lets an operator move the shape-confirmed tier too.
    const override = config.roles?.recon;
    if (isTier(override)) return { ...shaped, tier: override };
  }
  return shaped;
}

/** Names in a `roles`/`agents` mapping whose value is not a tier — for a startup warning. */
export function invalidRoleMappings(mapping: Record<string, unknown> | undefined): string[] {
  if (!mapping) return [];
  return Object.entries(mapping)
    .filter(([, tier]) => !isTier(tier))
    .map(([name, tier]) => `${name}: ${String(tier)}`);
}
