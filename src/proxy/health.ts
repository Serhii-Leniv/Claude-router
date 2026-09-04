import type { RouteEvent } from './route-event.js';

/**
 * The `/health` contract, defined once. `server.ts` produces it; `daemon.ts`
 * (`checkHealth`) and `cli.ts` (`status`) consume it. Keeping the shape and the
 * identity string in one module stops the three consumers from re-declaring a
 * contract that can silently drift from what the server actually emits.
 */

/** Identity marker distinguishing our proxy from any other service on the port. */
export const SERVICE_ID = 'claude-router-proxy';

export interface HealthInfo {
  status: string;
  service: string;
  classifier: string;
  provider: string;
  forceRoute: boolean;
  /** The coordinator pin, if any — the plugin's SessionStart hook reports it. */
  sessionModel: string | null;
  /** Whether subagents are routed by role. */
  roleRouting: boolean;
  version: string;
  requests: number;
  lastTier: string | null;
  lastModel: string | null;
}

/** Build the `/health` payload from the current config and route history. */
export function buildHealth(
  config: {
    classifier: string;
    provider: string;
    forceRoute: boolean;
    sessionModel?: string;
    roleRouting?: boolean;
    version?: string;
  },
  history: RouteEvent[],
  // The lifetime count for this process. `history` is a bounded window, so its
  // length stops being a count after MAX_HISTORY events; callers pass the
  // monotonic counter and the window only supplies the last route.
  requestsServed: number = history.length,
): HealthInfo {
  const last = history[history.length - 1] ?? null;
  return {
    status: 'ok',
    service: SERVICE_ID,
    classifier: config.classifier,
    provider: config.provider,
    forceRoute: config.forceRoute,
    sessionModel: config.sessionModel ?? null,
    roleRouting: config.roleRouting !== false,
    version: config.version ?? 'unknown',
    requests: requestsServed,
    lastTier: last ? String(last.tier) : null,
    lastModel: last?.model ?? null,
  };
}

/**
 * The Claude Code statusline text, e.g. `[auto:sonnet #42]`. Kept here so the
 * `/health` contract module stays the one owner of these fields — the shell
 * statusline fetches this preformatted string (via `GET /statusline`) instead
 * of parsing JSON, so the installed command is plain `curl`, no `jq`/`python`.
 */
export function formatStatusLine(info: HealthInfo): string {
  return `[auto:${info.lastTier ?? 'ready'} #${info.requests}]`;
}
