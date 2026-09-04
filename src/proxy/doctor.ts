import { term } from './term.js';
import { PRICING_LAST_CHECKED, pricingAgeDays } from '../models.js';
import { out, type OutputLine } from './command.js';
import type { HealthInfo } from './health.js';
import type { DaemonState } from './daemon.js';

/**
 * `doctor`'s diagnostics as data.
 *
 * The checks used to be a closure that printed a glyph and incremented a
 * `failures` counter in the same statement, then `process.exit(failures)`. The
 * exit code is the contract CI consumes and nothing pinned it — and the
 * print-as-you-decide shape had already let one check's predicate drift from
 * its own label: with `--provider bedrock` and no API key, a green ✓ appeared
 * beside the text "ANTHROPIC_API_KEY not set".
 *
 * Deciding and rendering are separate here, so both are assertable.
 */
export interface Diagnostic {
  ok: boolean;
  label: string;
  /** Remediation shown under a failing check. */
  hint?: string;
  /** A warning is reported but does not count toward the exit code. */
  warnOnly?: boolean;
}

/**
 * Everything `doctor` inspects about the machine. One member per probe, each
 * called exactly once per run — the inline version evaluated
 * `isProcessAlive`/`isAutostartRegistered`/`isStatuslineConfigured` twice apiece
 * (once for the verdict, once for the label), which on Windows meant shelling
 * out to `reg query` twice per check.
 */
export interface DoctorProbes {
  nodeVersion: string;
  platform: string;
  /** The current time — injected so the pricing-age check is testable. */
  now(): Date;
  loadConfig(): { loaded: boolean; error?: string };
  checkHealth(port: number): Promise<HealthInfo | null>;
  isEnvVarSet(port: number): boolean;
  /** Claude Code's own settings.json env points at the proxy (the install default). */
  isClaudeCodeEnvSet(port: number): boolean;
  apiKeySet(): boolean;
  daemonState(): DaemonState | null;
  isProcessAlive(pid: number): boolean;
  isAutostartRegistered(): boolean;
  isStatuslineConfigured(): boolean;
  policyPluginInstalled(): boolean;
}

export interface DoctorOptions {
  port: number;
  provider: string;
  configFile: string;
}

/** Past this many days the pricing table counts as unverified. */
export const PRICING_STALE_DAYS = 90;

export async function runDiagnostics(
  options: DoctorOptions,
  probes: DoctorProbes,
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];

  // Floor must track package.json `engines.node` — a green doctor on a Node the
  // package refuses to install on is worse than no check.
  const [major] = probes.nodeVersion.split('.').map(Number);
  diagnostics.push({
    ok: (major ?? 0) >= 20,
    label: `Node ${probes.nodeVersion} (need ≥ 20)`,
  });

  // Every savings figure is downstream of a hand-maintained pricing table, and
  // nothing else in the product notices when it goes stale. Warn-only: a stale
  // table is a reason to re-verify, not a broken install.
  const age = pricingAgeDays(probes.now());
  const fresh = age <= PRICING_STALE_DAYS;
  diagnostics.push({
    ok: fresh,
    label: fresh
      ? `Pricing table verified ${age} day${age === 1 ? '' : 's'} ago (${PRICING_LAST_CHECKED})`
      : `Pricing table last verified ${age} days ago (${PRICING_LAST_CHECKED}) — savings figures may be off`,
    hint: 'Verify src/models.ts against platform.claude.com pricing and bump PRICING_LAST_CHECKED',
    warnOnly: true,
  });

  const config = probes.loadConfig();
  diagnostics.push(
    config.error
      ? {
          ok: false,
          label: `Config file invalid: ${config.error}`,
          hint: 'Fix or regenerate: claude-router init --force',
        }
      : {
          ok: true,
          label: config.loaded
            ? `Config file loaded (${options.configFile})`
            : 'No config file (defaults in use)',
        },
  );

  const health = await probes.checkHealth(options.port);
  diagnostics.push({
    ok: health !== null,
    label: health
      ? `Proxy healthy on port ${options.port}`
      : `No proxy responding on port ${options.port}`,
    hint: 'Start it: claude-router start -d',
  });

  // Either route counts: Claude Code's settings.json env (what `install` writes)
  // or the shell variable (api-only installs and SDK apps).
  const claudeEnvOk = probes.isClaudeCodeEnvSet(options.port);
  const envOk = probes.isEnvVarSet(options.port);
  diagnostics.push({
    ok: claudeEnvOk || envOk,
    label: claudeEnvOk
      ? 'Claude Code routes through the proxy (settings.json env)'
      : envOk
        ? 'ANTHROPIC_BASE_URL points at the proxy'
        : `Nothing points at the proxy (no settings.json env, ANTHROPIC_BASE_URL is not http://localhost:${options.port})`,
    hint: 'Run: claude-router install',
  });


  // The key is only required for the anthropic provider, so the verdict has two
  // ways to pass — and the label has to say which one applied, or a green tick
  // sits next to a sentence reporting a problem.
  const apiKeySet = probes.apiKeySet();
  const providerNeedsKey = options.provider === 'anthropic';
  diagnostics.push({
    ok: apiKeySet || !providerNeedsKey,
    label: apiKeySet
      ? 'ANTHROPIC_API_KEY is set'
      : providerNeedsKey
        ? 'ANTHROPIC_API_KEY not set (fine if Claude Code sends its own auth)'
        : `ANTHROPIC_API_KEY not set (not needed for the ${options.provider} provider)`,
    warnOnly: true,
  });

  const state = probes.daemonState();
  if (state) {
    const alive = probes.isProcessAlive(state.pid);
    diagnostics.push({
      ok: alive,
      label: alive
        ? `Daemon state matches a live process (pid ${state.pid})`
        : `Stale daemon state (pid ${state.pid} is gone)`,
      hint: 'Clear it by restarting: claude-router restart',
      warnOnly: true,
    });
  }

  const autostart = probes.isAutostartRegistered();
  diagnostics.push({
    ok: autostart,
    label: autostart ? 'Autostart registered' : 'Autostart not registered',
    hint: 'Register it: claude-router install',
    warnOnly: true,
  });

  const statusline = probes.isStatuslineConfigured();
  diagnostics.push({
    ok: statusline,
    label: statusline ? 'Claude Code statusline configured' : 'Statusline not configured',
    hint: 'Add it: claude-router install',
    warnOnly: true,
  });

  const plugin = probes.policyPluginInstalled();
  diagnostics.push({
    ok: plugin,
    label: plugin ? 'Orchestration plugin installed' : 'Orchestration plugin not installed',
    hint: 'Add it: claude-router policy install',
    warnOnly: true,
  });

  return diagnostics;
}

/** The exit code: how many non-warning checks failed. Warnings never move it. */
export function failureCount(diagnostics: Diagnostic[]): number {
  return diagnostics.filter((d) => !d.ok && !d.warnOnly).length;
}

export function formatDiagnostics(diagnostics: Diagnostic[]): OutputLine[] {
  const lines: OutputLine[] = [];
  for (const d of diagnostics) {
    const glyph = d.ok ? term.ok() : d.warnOnly ? term.warn() : term.fail();
    lines.push(out(`  ${glyph} ${d.label}`));
    if (!d.ok && d.hint) lines.push(out(term.dim(`      ${d.hint}`)));
  }
  const failures = failureCount(diagnostics);
  lines.push(
    out(
      failures === 0
        ? `\n${term.ok()} Everything looks good.\n`
        : `\n${term.fail()} ${failures} problem(s) found.\n`,
    ),
  );
  return lines;
}
