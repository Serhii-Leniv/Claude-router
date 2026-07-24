import { warnDeadRoutingKeys } from '../routing.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_UPSTREAM, type Provider } from './handler.js';
import type { ModelPricing, RoutingTuning, Tier } from '../types.js';

// ── Paths ──────────────────────────────────────────────────────────────────

export interface RouterPaths {
  configDir: string;
  configFile: string;
  daemonStateFile: string;
  logFile: string;
  historyFile: string;
  plistFile: string;
  claudeSettingsFile: string;
  zshrcFile: string;
  bashrcFile: string;
}

export function routerPaths(homeDir: string = os.homedir()): RouterPaths {
  const configDir = path.join(homeDir, '.claude-router');
  return {
    configDir,
    configFile: path.join(configDir, 'config.json'),
    daemonStateFile: path.join(configDir, 'daemon.json'),
    logFile: path.join(configDir, 'proxy.log'),
    historyFile: path.join(configDir, 'history.jsonl'),
    plistFile: path.join(homeDir, 'Library', 'LaunchAgents', 'com.claude-router.proxy.plist'),
    claudeSettingsFile: path.join(homeDir, '.claude', 'settings.json'),
    zshrcFile: path.join(homeDir, '.zshrc'),
    bashrcFile: path.join(homeDir, '.bashrc'),
  };
}

export const PLIST_LABEL = 'com.claude-router.proxy';

// ── Config file ────────────────────────────────────────────────────────────

/** Shape of ~/.claude-router/config.json. Every field optional; CLI flags win. */
export interface FileConfig {
  port?: number;
  /** Bind address (default 127.0.0.1 — use 0.0.0.0 to expose on the network) */
  host?: string;
  verbose?: boolean;
  classifier?: 'heuristic' | 'ai' | 'hybrid';
  provider?: Provider;
  region?: string;
  forceRoute?: boolean;
  /**
   * Where requests actually go (default `https://api.anthropic.com`). Point it at
   * a stub to exercise the proxy without credentials or spend. Never inherited
   * from the environment — see `DEFAULT_UPSTREAM`.
   */
  upstream?: string;
  /**
   * Pin the Claude Code coordinator session (the main interactive session, which
   * sends no x-claude-code-agent-id header) to this tier, bypassing the classifier
   * for it. Subagents still route by evidence. Only takes effect under forceRoute.
   */
  sessionModel?: Tier;
  /** Override the model ID used for each tier. */
  tiers?: Partial<Record<Tier, string>>;
  /** Override pricing ($/1M tokens) for savings math, keyed by model ID. */
  pricing?: Record<string, ModelPricing>;
  /** Classifier thresholds/band/timeout/cache tuning. */
  routing?: RoutingTuning;
}

export interface LoadedFileConfig {
  config: FileConfig;
  loaded: boolean;
  error?: string;
}

export function loadFileConfig(configFile: string = routerPaths().configFile): LoadedFileConfig {
  if (!fs.existsSync(configFile)) return { config: {}, loaded: false };
  try {
    return { config: JSON.parse(fs.readFileSync(configFile, 'utf8')) as FileConfig, loaded: true };
  } catch (err) {
    return { config: {}, loaded: false, error: String(err) };
  }
}

// ── Serve options ──────────────────────────────────────────────────────────

export interface ServeOptions {
  port: number;
  host: string;
  verbose: boolean;
  classifier: 'heuristic' | 'ai' | 'hybrid';
  provider: Provider;
  region: string;
  forceRoute: boolean;
  upstream: string;
  /** '' = disabled (classify every request); a tier name pins the coordinator. */
  sessionModel: string;
  tiers?: Partial<Record<Tier, string>>;
  pricing?: Record<string, ModelPricing>;
  routing?: RoutingTuning;
}

/** Thrown for user-facing argument errors; the CLI prints it red and exits 1. */
export class CliUsageError extends Error {}

const DEFAULT_HOST = '127.0.0.1';

type OptionKind =
  | { type: 'number'; min: number; max: number }
  | { type: 'string' }
  | { type: 'enum'; values: readonly string[] }
  | { type: 'boolean' };

/**
 * One row per serve option. This single table drives parsing, re-serialization
 * (`serveArgsFrom`), and config scaffolding (`configFromOptions`) — so a new flag
 * is one row, not five parallel hand-written lists. `emit`/`config` predicates
 * key off `default`, so a value and "when to omit it" can never disagree.
 */
interface OptionSpec {
  /** Corresponding key on ServeOptions / FileConfig. */
  key: 'port' | 'host' | 'verbose' | 'classifier' | 'provider' | 'region' | 'forceRoute' | 'upstream' | 'sessionModel';
  flags: string[];
  kind: OptionKind;
  default: string | number | boolean;
  /** Always emit as a spawn arg (else only when non-default). */
  argAlways?: boolean;
  /** Always include in the scaffolded config.json (else only when non-default). */
  configAlways?: boolean;
}

const OPTIONS: OptionSpec[] = [
  { key: 'port',       flags: ['--port', '-p'],    kind: { type: 'number', min: 1, max: 65535 }, default: 4000, argAlways: true, configAlways: true },
  { key: 'host',       flags: ['--host'],          kind: { type: 'string' },                     default: DEFAULT_HOST },
  { key: 'forceRoute', flags: ['--force-route'],   kind: { type: 'boolean' },                    default: false, configAlways: true },
  { key: 'verbose',    flags: ['--verbose', '-v'], kind: { type: 'boolean' },                    default: false, configAlways: true },
  { key: 'classifier', flags: ['--classifier'],    kind: { type: 'enum', values: ['heuristic', 'ai', 'hybrid'] }, default: 'hybrid', configAlways: true },
  { key: 'provider',   flags: ['--provider'],      kind: { type: 'enum', values: ['anthropic', 'bedrock', 'vertex'] }, default: 'anthropic', configAlways: true },
  { key: 'region',     flags: ['--region'],        kind: { type: 'string' },                     default: '' },
  // Explicit only — never inherited from the environment. See DEFAULT_UPSTREAM.
  { key: 'upstream',   flags: ['--upstream'],      kind: { type: 'string' },                     default: DEFAULT_UPSTREAM },
  // Empty default = disabled. A tier name pins the Claude Code coordinator session.
  { key: 'sessionModel', flags: ['--session-model'], kind: { type: 'enum', values: ['haiku', 'sonnet', 'opus', 'fable'] }, default: '' },
];

/** Validate and convert a flag's raw argument per its declared kind. */
function coerce(spec: OptionSpec, raw: string | undefined): string | number | boolean {
  const k = spec.kind;
  if (k.type === 'number') {
    const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
    if (isNaN(parsed) || parsed < k.min || parsed > k.max) {
      throw new CliUsageError(`Invalid ${spec.key}: ${raw ?? '(missing)'}. Must be ${k.min}-${k.max}.`);
    }
    return parsed;
  }
  if (k.type === 'enum') {
    if (raw !== undefined && k.values.includes(raw)) return raw;
    throw new CliUsageError(`Invalid ${spec.key}: ${raw ?? '(missing)'}. Must be ${k.values.join(' | ')}.`);
  }
  // string
  if (!raw) throw new CliUsageError(`Missing value for ${spec.flags[0]}.`);
  return raw;
}

/**
 * Parse start/install flags. File config supplies defaults; flags override.
 * Throws CliUsageError on invalid or unknown flags.
 */
export function parseServeArgs(args: string[], file: FileConfig = {}): ServeOptions {
  const values: Record<string, string | number | boolean> = {};
  for (const spec of OPTIONS) {
    const fromFile = (file as Record<string, unknown>)[spec.key];
    values[spec.key] = (fromFile ?? spec.default) as string | number | boolean;
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const spec = OPTIONS.find((o) => o.flags.includes(arg));
    if (!spec) {
      throw new CliUsageError(`Unknown option '${arg}'. Run 'claude-router help' for usage.`);
    }
    if (spec.kind.type === 'boolean') {
      values[spec.key] = true;
    } else {
      values[spec.key] = coerce(spec, args[++i]);
    }
  }

  // The config file is where these keys actually live for most users, so this
  // is the call site that matters. Warn after parsing, before the proxy starts.
  warnDeadRoutingKeys(file.routing as Record<string, unknown> | undefined);

  return {
    ...(values as unknown as Omit<ServeOptions, 'tiers' | 'pricing' | 'routing'>),
    tiers: file.tiers,
    pricing: file.pricing,
    routing: file.routing,
  };
}

/** Region flags map onto the provider SDK env vars unless already set. */
export function applyRegionEnv(options: Pick<ServeOptions, 'provider' | 'region'>): void {
  if (!options.region) return;
  if (options.provider === 'bedrock' && !process.env['AWS_REGION']) {
    process.env['AWS_REGION'] = options.region;
  } else if (options.provider === 'vertex' && !process.env['ANTHROPIC_VERTEX_REGION']) {
    process.env['ANTHROPIC_VERTEX_REGION'] = options.region;
  }
}

/** Serve flags to re-create these options in a spawned/registered process. */
export function serveArgsFrom(options: ServeOptions): string[] {
  const args: string[] = [];
  for (const spec of OPTIONS) {
    const value = (options as unknown as Record<string, unknown>)[spec.key];
    if (!(spec.argAlways || value !== spec.default)) continue;
    if (spec.kind.type === 'boolean') args.push(spec.flags[0]!);
    else args.push(spec.flags[0]!, String(value));
  }
  return args;
}

/** Build a scaffolded config.json from resolved options (drives `init`). */
export function configFromOptions(options: ServeOptions): FileConfig {
  const config: Record<string, unknown> = {};
  for (const spec of OPTIONS) {
    const value = (options as unknown as Record<string, unknown>)[spec.key];
    if (spec.configAlways || value !== spec.default) config[spec.key] = value;
  }
  return config as FileConfig;
}

// ── Version ────────────────────────────────────────────────────────────────

export function getVersion(): string {
  // Compiled output lives at dist/proxy/, so package.json is two levels up.
  // The project compiles to CJS, so __dirname is available.
  const pkgPath = path.join(__dirname, '..', '..', 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// ── Command suggestion ─────────────────────────────────────────────────────

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length]![b.length]!;
}

/** Closest known command within edit distance 2, or null. */
export function suggestCommand(input: string, commands: string[]): string | null {
  let best: string | null = null;
  let bestDist = 3;
  for (const cmd of commands) {
    const d = levenshtein(input.toLowerCase(), cmd);
    if (d < bestDist) {
      bestDist = d;
      best = cmd;
    }
  }
  return best;
}
