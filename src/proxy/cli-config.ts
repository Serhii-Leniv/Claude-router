import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Provider } from './handler.js';
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
  tiers?: Partial<Record<Tier, string>>;
  pricing?: Record<string, ModelPricing>;
  routing?: RoutingTuning;
}

/** Thrown for user-facing argument errors; the CLI prints it red and exits 1. */
export class CliUsageError extends Error {}

/**
 * Parse start/install flags. File config supplies defaults; flags override.
 * Throws CliUsageError on invalid or unknown flags.
 */
export function parseServeArgs(args: string[], file: FileConfig = {}): ServeOptions {
  let port = file.port ?? 4000;
  let host = file.host ?? '127.0.0.1';
  let verbose = file.verbose ?? false;
  let classifier: 'heuristic' | 'ai' | 'hybrid' = file.classifier ?? 'hybrid';
  let provider: Provider = file.provider ?? 'anthropic';
  let region = file.region ?? '';
  let forceRoute = file.forceRoute ?? false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--port' || arg === '-p') {
      const raw = args[++i];
      const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
      if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
        throw new CliUsageError(`Invalid port: ${raw ?? '(missing)'}. Must be 1-65535.`);
      }
      port = parsed;
    } else if (arg === '--host') {
      const val = args[++i];
      if (!val) throw new CliUsageError('Missing value for --host.');
      host = val;
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true;
    } else if (arg === '--classifier') {
      const val = args[++i];
      if (val === 'heuristic' || val === 'ai' || val === 'hybrid') {
        classifier = val;
      } else {
        throw new CliUsageError(
          `Invalid classifier: ${val ?? '(missing)'}. Must be heuristic | ai | hybrid.`,
        );
      }
    } else if (arg === '--provider') {
      const val = args[++i];
      if (val === 'anthropic' || val === 'bedrock' || val === 'vertex') {
        provider = val;
      } else {
        throw new CliUsageError(
          `Invalid provider: ${val ?? '(missing)'}. Must be anthropic | bedrock | vertex.`,
        );
      }
    } else if (arg === '--region') {
      const val = args[++i];
      if (!val) throw new CliUsageError('Missing value for --region.');
      region = val;
    } else if (arg === '--force-route') {
      forceRoute = true;
    } else {
      throw new CliUsageError(`Unknown option '${arg}'. Run 'claude-router help' for usage.`);
    }
  }

  return { port, host, verbose, classifier, provider, region, forceRoute, tiers: file.tiers, pricing: file.pricing, routing: file.routing };
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
  const args = ['--port', String(options.port)];
  if (options.host !== '127.0.0.1') args.push('--host', options.host);
  if (options.forceRoute) args.push('--force-route');
  if (options.verbose) args.push('--verbose');
  if (options.classifier !== 'hybrid') args.push('--classifier', options.classifier);
  if (options.provider !== 'anthropic') args.push('--provider', options.provider);
  if (options.region) args.push('--region', options.region);
  return args;
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
