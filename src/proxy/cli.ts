#!/usr/bin/env node

import { serve } from '@hono/node-server';
import { createProxyApp } from './server.js';
import { createProviderClient, type Provider } from './handler.js';
import { DEFAULT_MODELS, BEDROCK_MODELS, VERTEX_MODELS } from '../models.js';
import type { ModelPricing, Tier } from '../types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

// ── Constants ──────────────────────────────────────────────────────────────

const PLIST_LABEL = 'com.claude-router.proxy';
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);
const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const CONFIG_PATH = path.join(os.homedir(), '.claude-router', 'config.json');
const ZSHRC_PATH = path.join(os.homedir(), '.zshrc');
const ZSHRC_MARKER = '# claude-router';

// ── Config file ──────────────────────────────────────────────────────────────

/** Shape of ~/.claude-router/config.json. Every field optional; CLI flags win. */
interface FileConfig {
  port?: number;
  verbose?: boolean;
  classifier?: 'heuristic' | 'ai' | 'hybrid';
  provider?: Provider;
  region?: string;
  forceRoute?: boolean;
  /** Override the model ID used for each tier. */
  tiers?: Partial<Record<Tier, string>>;
  /** Override pricing ($/1M tokens) for savings math, keyed by model ID. */
  pricing?: Record<string, ModelPricing>;
}

let configFileLoaded = false;

function loadFileConfig(): FileConfig {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as FileConfig;
    configFileLoaded = true;
    return cfg;
  } catch (err) {
    console.error(`[claude-router] Ignoring invalid config at ${CONFIG_PATH}: ${String(err)}`);
    return {};
  }
}
const STATUSLINE_CMD =
  `curl -sf --max-time 0.3 http://localhost:4000/health | ` +
  `python3 -c "import sys,json; d=json.load(sys.stdin); t=d.get('lastTier') or 'ready'; r=d.get('requests',0); print(f'[auto:{t} #{r}]')" 2>/dev/null || echo '[auto:off]'`;

// ── Server options ─────────────────────────────────────────────────────────

interface ServeOptions {
  port: number;
  verbose: boolean;
  classifier: 'heuristic' | 'ai' | 'hybrid';
  provider: Provider;
  region: string;
  forceRoute: boolean;
  tiers?: Partial<Record<Tier, string>>;
  pricing?: Record<string, ModelPricing>;
}

function parseServeArgs(args: string[]): ServeOptions {
  // File config supplies defaults; any CLI flag below overrides it.
  const file = loadFileConfig();
  let port = file.port ?? 4000;
  let verbose = file.verbose ?? false;
  let classifier: 'heuristic' | 'ai' | 'hybrid' = file.classifier ?? 'hybrid';
  let provider: Provider = file.provider ?? 'anthropic';
  let region = file.region ?? '';
  let forceRoute = file.forceRoute ?? false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--port' || arg === '-p') && args[i + 1]) {
      const parsed = parseInt(args[i + 1]!, 10);
      if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
        console.error(`Invalid port: ${args[i + 1]}. Must be 1-65535.`);
        process.exit(1);
      }
      port = parsed;
      i++;
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true;
    } else if (arg === '--classifier' && args[i + 1]) {
      const val = args[i + 1]!;
      if (val === 'heuristic' || val === 'ai' || val === 'hybrid') {
        classifier = val;
        i++;
      }
    } else if (arg === '--provider' && args[i + 1]) {
      const val = args[i + 1]!;
      if (val === 'anthropic' || val === 'bedrock' || val === 'vertex') {
        provider = val as Provider;
      } else {
        console.error(`Invalid provider: ${val}. Must be anthropic | bedrock | vertex.`);
        process.exit(1);
      }
      i++;
    } else if (arg === '--region' && args[i + 1]) {
      region = args[i + 1]!;
      i++;
    } else if (arg === '--force-route') {
      forceRoute = true;
    }
  }

  if (region) {
    if (provider === 'bedrock' && !process.env['AWS_REGION']) {
      process.env['AWS_REGION'] = region;
    } else if (provider === 'vertex' && !process.env['ANTHROPIC_VERTEX_REGION']) {
      process.env['ANTHROPIC_VERTEX_REGION'] = region;
    }
  }

  return { port, verbose, classifier, provider, region, forceRoute, tiers: file.tiers, pricing: file.pricing };
}

function modelsForProvider(provider: Provider): Record<Tier, string> {
  if (provider === 'bedrock') return BEDROCK_MODELS;
  if (provider === 'vertex') return VERTEX_MODELS;
  return DEFAULT_MODELS;
}

// ── Install helpers ────────────────────────────────────────────────────────

function writePlist(port: number, forceRoute: boolean): void {
  const nodePath = process.execPath;
  const cliPath = process.argv[1]!;

  const args = ['--port', String(port)];
  if (forceRoute) args.push('--force-route');

  const argXml = args
    .map((a) => `    <string>${a}</string>`)
    .join('\n');

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${cliPath}</string>
    <string>start</string>
${argXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/claude-router.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/claude-router.log</string>
</dict>
</plist>`;

  fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
  fs.writeFileSync(PLIST_PATH, plist, 'utf8');
}

function loadLaunchAgent(): void {
  try {
    execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null || true`);
    execSync(`launchctl load "${PLIST_PATH}"`);
  } catch {
    // non-fatal — user can start manually
  }
}

function unloadLaunchAgent(): void {
  try {
    execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null || true`);
  } catch { /* ignore */ }
}

function addZshrcLine(port: number): void {
  const line = `export ANTHROPIC_BASE_URL=http://localhost:${port}`;
  if (fs.existsSync(ZSHRC_PATH)) {
    const content = fs.readFileSync(ZSHRC_PATH, 'utf8');
    if (content.includes(ZSHRC_MARKER)) return; // already installed
    fs.appendFileSync(ZSHRC_PATH, `\n${ZSHRC_MARKER}\n${line}\n`);
  } else {
    fs.writeFileSync(ZSHRC_PATH, `${ZSHRC_MARKER}\n${line}\n`);
  }
}

function removeZshrcLines(): void {
  if (!fs.existsSync(ZSHRC_PATH)) return;
  const lines = fs.readFileSync(ZSHRC_PATH, 'utf8').split('\n');
  const filtered = lines.filter(
    (l) => !l.startsWith(ZSHRC_MARKER) && !l.includes('ANTHROPIC_BASE_URL=http://localhost:4000'),
  );
  fs.writeFileSync(ZSHRC_PATH, filtered.join('\n'));
}

function addStatusline(): void {
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
    try {
      settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
    } catch { /* start fresh */ }
  }
  if (!settings['statusLine']) {
    settings['statusLine'] = { type: 'command', command: STATUSLINE_CMD };
    fs.mkdirSync(path.dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
  }
}

function removeStatusline(): void {
  if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) return;
  try {
    const settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
    if (
      settings['statusLine'] &&
      typeof settings['statusLine'] === 'object' &&
      (settings['statusLine'] as Record<string, unknown>)['command'] === STATUSLINE_CMD
    ) {
      delete settings['statusLine'];
      fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
    }
  } catch { /* ignore */ }
}

// ── Subcommands ────────────────────────────────────────────────────────────

function cmdInstall(args: string[]): void {
  const { port, forceRoute } = parseServeArgs(args);

  console.log('Installing claude-router...\n');

  writePlist(port, forceRoute);
  console.log(`  ✓ LaunchAgent written → ${PLIST_PATH}`);

  loadLaunchAgent();
  console.log('  ✓ LaunchAgent loaded (auto-starts on login)');

  addZshrcLine(port);
  console.log(`  ✓ ANTHROPIC_BASE_URL added to ~/.zshrc`);

  addStatusline();
  console.log('  ✓ Statusline configured in ~/.claude/settings.json');

  console.log(`
Done. Proxy is running on http://localhost:${port}.

  → Restart your terminal (or run: source ~/.zshrc)
  → Use \`claude\` normally — all calls auto-routed

Logs: tail -f /tmp/claude-router.log
`);
}

function cmdUninstall(): void {
  unloadLaunchAgent();
  if (fs.existsSync(PLIST_PATH)) {
    fs.unlinkSync(PLIST_PATH);
  }
  removeZshrcLines();
  removeStatusline();
  console.log('claude-router uninstalled.');
}

function cmdStatus(): void {
  try {
    const result = execSync(
      'curl -sf --max-time 1 http://localhost:4000/health',
      { encoding: 'utf8' },
    );
    const data = JSON.parse(result) as Record<string, unknown>;
    const lastTier = data['lastTier'] ?? 'none';
    const requests = data['requests'] ?? 0;
    const forceRoute = data['forceRoute'] ?? false;
    console.log(`Status:     running`);
    console.log(`Force-route: ${forceRoute}`);
    console.log(`Requests:   ${requests}`);
    console.log(`Last tier:  ${lastTier}`);
  } catch {
    console.log('Status: not running');
    console.log('Start with: claude-router install  (or)  claude-router start');
  }
}

function cmdStop(): void {
  try {
    execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null || true`);
    console.log('Proxy stopped.');
  } catch {
    // Try pkill fallback
    try {
      execSync("pkill -f 'claude-router.*start'");
      console.log('Proxy stopped.');
    } catch {
      console.log('Proxy not running.');
    }
  }
}

async function cmdStart(args: string[]): Promise<void> {
  const { port, verbose, classifier, provider, region, forceRoute, tiers, pricing } = parseServeArgs(args);
  // Provider defaults, with per-tier overrides from the config file layered on top.
  const models = { ...modelsForProvider(provider), ...(tiers ?? {}) };

  let providerClient;
  try {
    providerClient = await createProviderClient(provider);
  } catch (err) {
    console.error(`\n[claude-router] Provider init failed:\n${String(err)}\n`);
    process.exit(1);
  }

  const app = createProxyApp({
    classifier,
    defaultModel: models.sonnet,
    verbose,
    provider,
    models,
    forceRoute,
    pricing,
  }, providerClient);

  const regionDisplay = region ||
    (provider === 'bedrock' ? process.env['AWS_REGION'] ?? 'us-east-1' :
     provider === 'vertex' ? process.env['ANTHROPIC_VERTEX_REGION'] ?? 'us-east5' : '');

  console.log(`
┌──────────────────────────────────────────────┐
│  claude-router proxy                         │
├──────────────────────────────────────────────┤
│  URL:         http://localhost:${String(port).padEnd(5)}         │
│  Provider:    ${provider.padEnd(32)}│
│  Classifier:  ${classifier.padEnd(32)}│
│  Force-route: ${String(forceRoute).padEnd(32)}│${regionDisplay ? `\n│  Region:      ${regionDisplay.padEnd(32)}│` : ''}${configFileLoaded ? `\n│  Config:      ${'~/.claude-router/config.json'.padEnd(32)}│` : ''}
└──────────────────────────────────────────────┘
`);

  process.on('unhandledRejection', (err) => {
    console.error(`\n[claude-router] Fatal error:\n${String(err)}`);
    if (provider === 'vertex') {
      console.error('\nVertex auth failed. Run: gcloud auth application-default login');
    } else if (provider === 'bedrock') {
      console.error('\nBedrock auth failed. Check: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION');
    }
    process.exit(1);
  });

  serve({ fetch: app.fetch, port });
}

function printHelp(): void {
  console.log(`
claude-router — auto-route Claude API calls by prompt complexity

Usage:
  claude-router install [options]    One-time setup (LaunchAgent + env + statusline)
  claude-router uninstall            Remove all installed components
  claude-router start [options]      Start proxy in foreground
  claude-router stop                 Stop the background proxy
  claude-router status               Show proxy health

Options (install / start):
  --port, -p <number>      Port (default: 4000)
  --force-route            Override model field — required for Claude Code
  --verbose, -v            Log routing decisions
  --classifier <mode>      heuristic | ai | hybrid (default: hybrid)
  --provider <mode>        anthropic | bedrock | vertex (default: anthropic)
  --region <string>        AWS/GCP region

Config file (optional):
  ~/.claude-router/config.json supplies defaults for any option above plus
  per-tier model overrides ("tiers") and custom pricing ("pricing").
  CLI flags always override the file. Example:
    { "classifier": "heuristic", "forceRoute": true,
      "tiers": { "opus": "claude-opus-4-8" } }

Quick start:
  claude-router install --force-route
  # restart terminal, then use \`claude\` normally
`);
}

// ── Entry ──────────────────────────────────────────────────────────────────

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    printHelp();
    process.exit(0);
  }

  switch (subcommand) {
    case 'install':
      cmdInstall(rest);
      break;
    case 'uninstall':
      cmdUninstall();
      break;
    case 'status':
      cmdStatus();
      break;
    case 'stop':
      cmdStop();
      break;
    case 'start':
      await cmdStart(rest);
      break;
    default:
      // Legacy: no subcommand → treat all args as start options
      await cmdStart(process.argv.slice(2));
  }
}

main();
