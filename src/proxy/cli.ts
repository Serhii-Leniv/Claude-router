#!/usr/bin/env node

import { serve } from '@hono/node-server';
import fs from 'node:fs';
import { createProxyApp } from './server.js';
import { createProviderClient, type Provider } from './handler.js';
import { DEFAULT_MODELS, BEDROCK_MODELS, VERTEX_MODELS } from '../models.js';
import type { Tier } from '../types.js';
import { term } from './term.js';
import { formatSavedCents } from './format.js';
import {
  CliUsageError,
  applyRegionEnv,
  configFromOptions,
  getVersion,
  loadFileConfig,
  parseServeArgs,
  routerPaths,
  serveArgsFrom,
  suggestCommand,
  type FileConfig,
  type ServeOptions,
} from './cli-config.js';
import {
  checkHealth,
  isProcessAlive,
  readDaemonState,
  startDaemon,
  stopDaemon,
  writeDaemonState,
} from './daemon.js';
import { readLifetimeStats } from './history.js';
import {
  addStatusline,
  installAutostart,
  isAutostartRegistered,
  isEnvVarSet,
  isStatuslineConfigured,
  platformName,
  removeStatusline,
  setEnvVar,
  supervisorPid,
  uninstallAutostart,
  unsetEnvVar,
  type StepResult,
} from './platform.js';

const COMMANDS = [
  'start', 'stop', 'restart', 'status', 'stats', 'logs',
  'install', 'uninstall', 'init', 'doctor', 'help',
];

const paths = routerPaths();

// ── Helpers ────────────────────────────────────────────────────────────────

function loadConfigWarned(): FileConfig {
  const { config, error } = loadFileConfig(paths.configFile);
  if (error) {
    console.error(term.warn() + ` Ignoring invalid config at ${paths.configFile}: ${error}`);
  }
  return config;
}

/** Split command-specific boolean flags out of an arg list before serve parsing. */
function extractFlags(args: string[], flags: string[]): { rest: string[]; found: Set<string> } {
  const found = new Set<string>();
  const rest = args.filter((a) => {
    if (flags.includes(a)) {
      found.add(a);
      return false;
    }
    return true;
  });
  return { rest, found };
}

function printStep(result: StepResult): void {
  const glyph = result.ok ? term.ok() : result.skipped ? term.warn() : term.fail();
  console.log(`  ${glyph} ${result.detail}`);
}

function modelsForProvider(provider: Provider): Record<Tier, string> {
  if (provider === 'bedrock') return BEDROCK_MODELS;
  if (provider === 'vertex') return VERTEX_MODELS;
  return DEFAULT_MODELS;
}

function resolveOptions(args: string[]): ServeOptions {
  return parseServeArgs(args, loadConfigWarned());
}

// ── start ──────────────────────────────────────────────────────────────────

async function cmdStart(args: string[]): Promise<void> {
  const { rest, found } = extractFlags(args, ['--daemon', '-d']);
  const options = resolveOptions(rest);

  if (found.size > 0) {
    const result = await startDaemon(serveArgsFrom(options), options.port, paths);
    if (result.ok) {
      console.log(`${term.ok()} ${result.detail}`);
      console.log(term.dim(`  logs: claude-router logs   stop: claude-router stop`));
    } else {
      term.errorLine(result.detail);
      process.exit(1);
    }
    return;
  }

  applyRegionEnv(options);
  const models = { ...modelsForProvider(options.provider), ...(options.tiers ?? {}) };

  let providerClient;
  try {
    providerClient = await createProviderClient(options.provider);
  } catch (err) {
    term.errorLine(`Provider init failed: ${String(err)}`);
    process.exit(1);
  }

  const app = createProxyApp({
    classifier: options.classifier,
    defaultModel: models.sonnet,
    verbose: options.verbose,
    provider: options.provider,
    models,
    forceRoute: options.forceRoute,
    pricing: options.pricing,
    routing: options.routing,
    historyFile: paths.historyFile,
  }, providerClient);

  const regionDisplay = options.region ||
    (options.provider === 'bedrock' ? process.env['AWS_REGION'] ?? 'us-east-1' :
     options.provider === 'vertex' ? process.env['ANTHROPIC_VERTEX_REGION'] ?? 'us-east5' : '');

  const exposed = options.host !== '127.0.0.1' && options.host !== 'localhost';
  if (exposed && (options.provider === 'bedrock' || options.provider === 'vertex')) {
    console.error(
      term.warn() +
        ` Binding to ${options.host} with the ${options.provider} provider exposes YOUR cloud credentials to the network — incoming requests are not authenticated.`,
    );
  }

  const displayHost = exposed ? options.host : 'localhost';
  const { loaded } = loadFileConfig(paths.configFile);
  const rows: Array<[string, string]> = [
    ['URL', term.accent(`http://${displayHost}:${options.port}`)],
    ['Dashboard', `http://${displayHost}:${options.port}/dashboard`],
    ['Provider', options.provider],
    ['Classifier', options.classifier],
    ['Force-route', options.forceRoute ? term.green('on') : term.dim('off')],
    ['Tiers', `${term.tier('haiku')} ${term.dim('→')} ${models.haiku}`],
    ['', `${term.tier('sonnet')} ${term.dim('→')} ${models.sonnet}`],
    ['', `${term.tier('opus')} ${term.dim('→')} ${models.opus}`],
  ];
  if (exposed) rows.push(['Bind', `${options.host} ${term.yellow('(network-exposed)')}`]);
  if (regionDisplay) rows.push(['Region', regionDisplay]);
  if (loaded) rows.push(['Config', paths.configFile]);

  console.log('\n' + term.box(`claude-router ${term.dim('v' + getVersion())}`, rows) + '\n');

  process.on('unhandledRejection', (err) => {
    term.errorLine(`Fatal error: ${String(err)}`);
    if (options.provider === 'vertex') {
      console.error('\nVertex auth failed. Run: gcloud auth application-default login');
    } else if (options.provider === 'bedrock') {
      console.error('\nBedrock auth failed. Check: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION');
    }
    process.exit(1);
  });

  serve({ fetch: app.fetch, port: options.port, hostname: options.host });
}

// ── stop / restart ─────────────────────────────────────────────────────────

async function cmdStop(): Promise<void> {
  const result = await stopDaemon(paths);
  if (result.ok) {
    console.log(`${term.ok()} ${result.detail}`);
  } else {
    term.errorLine(result.detail);
    process.exit(1);
  }
}

async function cmdRestart(args: string[]): Promise<void> {
  const state = readDaemonState(paths);
  const stop = await stopDaemon(paths);
  if (!stop.ok) {
    term.errorLine(stop.detail);
    process.exit(1);
  }
  // Reuse the previous daemon's args unless new flags were given
  const options = resolveOptions(args.length > 0 ? args : state?.args ?? []);
  const result = await startDaemon(serveArgsFrom(options), options.port, paths);
  if (result.ok) {
    console.log(`${term.ok()} ${result.detail}`);
  } else {
    term.errorLine(result.detail);
    process.exit(1);
  }
}

// ── status ─────────────────────────────────────────────────────────────────

async function cmdStatus(args: string[]): Promise<void> {
  const options = resolveOptions(args);
  const health = await checkHealth(options.port);
  const state = readDaemonState(paths);

  if (!health) {
    console.log(`${term.fail()} ${term.bold('stopped')} ${term.dim(`(no proxy on port ${options.port})`)}`);
    if (state && !isProcessAlive(state.pid)) {
      console.log(term.dim(`  stale daemon state found (pid ${state.pid} is gone)`));
    }
    console.log(`\nStart it:  ${term.accent('claude-router start -d')}  ${term.dim('(or claude-router install)')}`);
    process.exitCode = 1;
    return;
  }

  const rows: Array<[string, string]> = [
    ['Status', `${term.green('running')}${state ? term.dim(` (pid ${state.pid})`) : ''}`],
    ['URL', `http://localhost:${options.port}`],
    ['Dashboard', `http://localhost:${options.port}/dashboard`],
    ['Provider', health.provider],
    ['Classifier', health.classifier],
    ['Force-route', health.forceRoute ? term.green('on') : term.dim('off')],
    ['Requests', String(health.requests)],
    ['Last tier', health.lastTier ? term.tier(health.lastTier) : term.dim('none')],
    ['Autostart', isAutostartRegistered(paths) ? term.green('registered') : term.dim('not registered')],
    ['Env var', isEnvVarSet(options.port) ? term.green('set') : term.dim('not set')],
  ];
  console.log('\n' + term.box('claude-router status', rows) + '\n');
}

// ── stats ──────────────────────────────────────────────────────────────────

function cmdStats(args: string[]): void {
  const asJson = args.includes('--json');
  const stats = readLifetimeStats(paths.historyFile);

  if (asJson) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  if (stats.requests === 0) {
    console.log(term.dim('No routing history yet — savings are recorded once requests flow through the proxy.'));
    return;
  }

  const tierLine = ['haiku', 'sonnet', 'opus', 'passthrough']
    .filter((t) => stats.tiers[t])
    .map((t) => `${term.tier(t)} ${stats.tiers[t]}`)
    .join(term.dim('  ·  '));

  const rows: Array<[string, string]> = [
    ['Requests', String(stats.requests)],
    ['Total cost', `$${(stats.costCents / 100).toFixed(2)}`],
    ['Total saved', formatSavedCents(stats.savedCents)],
    ['Auto-retried', String(stats.retried)],
    ['Tiers', tierLine || term.dim('none')],
  ];

  // The totals above exclude every unpriced call. Saying so is the difference
  // between "we saved little" and "we can't tell you what we saved".
  const unpriced = Object.entries(stats.unpricedModels);
  if (unpriced.length > 0) {
    const calls = unpriced.reduce((n, [, c]) => n + c, 0);
    rows.push(['Unpriced', term.yellow(`${calls} call${calls === 1 ? '' : 's'} — ${unpriced.map(([m]) => m).join(', ')}`)]);
  }

  console.log('\n' + term.box('claude-router — lifetime savings', rows));

  if (unpriced.length > 0) {
    console.log(
      term.dim('\nUnpriced models are excluded from the cost and savings figures above.\n') +
      term.dim('Add a "pricing" entry for each in ') + paths.configFile,
    );
  }

  const days = Object.keys(stats.byDay).sort().slice(-7);
  if (days.length > 0) {
    console.log('\n' + term.bold('Last 7 days'));
    for (const day of days) {
      const d = stats.byDay[day]!;
      const saved = formatSavedCents(d.savedCents, true);
      console.log(`  ${day}  ${String(d.requests).padStart(5)} req   ${saved}`);
    }
  }
  console.log(term.dim(`\nHistory: ${paths.historyFile}`));
}

// ── logs ───────────────────────────────────────────────────────────────────

function cmdLogs(args: string[]): void {
  let lines = 50;
  let follow = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-f' || arg === '--follow') follow = true;
    else if ((arg === '-n' || arg === '--lines') && args[i + 1]) {
      lines = parseInt(args[++i]!, 10) || 50;
    } else {
      term.errorLine(`Unknown option '${arg}' for logs.`);
      process.exit(1);
    }
  }

  if (!fs.existsSync(paths.logFile)) {
    console.log(term.dim(`No log file yet (${paths.logFile}). Start the daemon: claude-router start -d`));
    return;
  }

  const printTail = (fromSize = 0): number => {
    const content = fs.readFileSync(paths.logFile, 'utf8');
    if (fromSize === 0) {
      const tail = content.split('\n').slice(-lines - 1).join('\n');
      process.stdout.write(tail.endsWith('\n') ? tail : tail + '\n');
    } else if (content.length > fromSize) {
      process.stdout.write(content.slice(fromSize));
    }
    return content.length;
  };

  let size = printTail();
  if (follow) {
    console.log(term.dim('— following (ctrl+c to exit) —'));
    fs.watchFile(paths.logFile, { interval: 500 }, () => {
      size = printTail(size);
    });
  }
}

// ── install / uninstall ────────────────────────────────────────────────────

async function cmdInstall(args: string[]): Promise<void> {
  const { rest, found } = extractFlags(args, ['--no-autostart', '--no-env', '--no-statusline']);
  const options = resolveOptions(rest);
  const serveArgs = serveArgsFrom(options);

  console.log(`\nInstalling claude-router ${term.dim(`(${platformName()})`)}\n`);
  let failures = 0;

  // 1. Autostart on login. On macOS/Linux the supervisor (launchd RunAtLoad /
  //    systemd --now) ALSO starts the proxy immediately, so this must run before
  //    we consider starting our own daemon — otherwise both bind the port and the
  //    supervisor's instance loops forever on EADDRINUSE.
  if (!found.has('--no-autostart')) {
    const result = installAutostart(serveArgs, paths);
    printStep(result);
    if (!result.ok && !result.skipped) failures++;
  }

  // 2. Ensure the proxy is running — but don't start a second one if the
  //    autostart supervisor already brought it up (that's the port race).
  let running = await checkHealth(options.port);
  // Only macOS/Linux supervisors start the proxy at install time; the Windows Run
  // key fires at next login, so there's nothing to wait for there.
  if (!running && !found.has('--no-autostart') && platformName() !== 'windows') {
    // Give the just-loaded supervisor a moment to bind the port before deciding.
    for (let i = 0; i < 15 && !running; i++) {
      await new Promise((r) => setTimeout(r, 200));
      running = await checkHealth(options.port);
    }
  }
  if (running) {
    // Record the supervised process so status/stop/restart keep working without
    // a redundant daemon of our own.
    const pid = supervisorPid(paths);
    if (pid) {
      writeDaemonState(
        { pid, port: options.port, startedAt: new Date().toISOString(), args: serveArgs },
        paths,
      );
    }
    printStep({
      ok: true,
      detail: pid
        ? `Proxy running on port ${options.port} (pid ${pid}, autostart-supervised)`
        : `Proxy already running on port ${options.port}`,
    });
  } else {
    const start = await startDaemon(serveArgs, options.port, paths);
    printStep({ ok: start.ok, detail: start.detail });
    if (!start.ok) failures++;
  }

  // 3. Environment variable
  if (!found.has('--no-env')) {
    const result = setEnvVar(options.port, paths);
    printStep(result);
    if (!result.ok && !result.skipped) failures++;
  }

  // 4. Claude Code statusline
  if (!found.has('--no-statusline')) {
    const result = addStatusline(options.port, paths);
    printStep(result);
    if (!result.ok && !result.skipped) failures++;
  }

  if (failures > 0) {
    console.log(`\n${term.fail()} Install finished with ${failures} failed step(s) — see above.`);
    process.exit(1);
  }

  const envNote = platformName() === 'windows'
    ? 'Open a new terminal (setx applies to new sessions only)'
    : 'Restart your terminal (or: source your shell rc file)';
  console.log(`
${term.ok()} Done. Requests to ${term.accent(`http://localhost:${options.port}`)} are auto-routed.

  ${term.dim('→')} ${envNote}
  ${term.dim('→')} Use ${term.accent('claude')} normally — calls route through the proxy
  ${term.dim('→')} Check anytime: ${term.accent('claude-router status')} · ${term.accent('claude-router doctor')}
`);
}

async function cmdUninstall(): Promise<void> {
  console.log(`\nUninstalling claude-router ${term.dim(`(${platformName()})`)}\n`);

  const stop = await stopDaemon(paths);
  printStep({ ok: stop.ok, detail: stop.detail, skipped: !stop.ok });
  printStep(uninstallAutostart(paths));
  printStep(unsetEnvVar(paths));
  printStep(removeStatusline(paths));

  console.log(`\n${term.ok()} claude-router uninstalled.\n`);
}

// ── init ───────────────────────────────────────────────────────────────────

function cmdInit(args: string[]): void {
  const { rest, found } = extractFlags(args, ['--force']);
  if (fs.existsSync(paths.configFile) && !found.has('--force')) {
    term.errorLine(`${paths.configFile} already exists. Use --force to overwrite.`);
    process.exit(1);
  }

  const options = parseServeArgs(rest, {});
  const config = configFromOptions(options);

  fs.mkdirSync(paths.configDir, { recursive: true });
  fs.writeFileSync(paths.configFile, JSON.stringify(config, null, 2) + '\n', 'utf8');
  console.log(`${term.ok()} Wrote ${paths.configFile}`);
  console.log(term.dim('  Edit it to add per-tier model overrides ("tiers") or pricing ("pricing").'));
}

// ── doctor ─────────────────────────────────────────────────────────────────

async function cmdDoctor(args: string[]): Promise<void> {
  const options = resolveOptions(args);
  console.log(`\n${term.bold('claude-router doctor')} ${term.dim(`(${platformName()})`)}\n`);
  let failures = 0;
  const check = (ok: boolean, label: string, hint?: string, warnOnly = false) => {
    const glyph = ok ? term.ok() : warnOnly ? term.warn() : term.fail();
    console.log(`  ${glyph} ${label}`);
    if (!ok && hint) console.log(term.dim(`      ${hint}`));
    if (!ok && !warnOnly) failures++;
  };

  const [major] = process.versions.node.split('.').map(Number);
  check(major! >= 18, `Node ${process.versions.node} (need ≥ 18)`);

  const { loaded, error } = loadFileConfig(paths.configFile);
  if (error) check(false, `Config file invalid: ${error}`, `Fix or regenerate: claude-router init --force`);
  else check(true, loaded ? `Config file loaded (${paths.configFile})` : 'No config file (defaults in use)');

  const health = await checkHealth(options.port);
  check(
    health !== null,
    health ? `Proxy healthy on port ${options.port}` : `No proxy responding on port ${options.port}`,
    'Start it: claude-router start -d',
  );

  const envOk = isEnvVarSet(options.port);
  check(
    envOk,
    envOk
      ? `ANTHROPIC_BASE_URL points at the proxy`
      : `ANTHROPIC_BASE_URL is not set to http://localhost:${options.port}`,
    platformName() === 'windows'
      ? `Set it: setx ANTHROPIC_BASE_URL http://localhost:${options.port} (then open a new terminal)`
      : `Add to your shell rc: export ANTHROPIC_BASE_URL=http://localhost:${options.port}`,
  );

  check(
    Boolean(process.env['ANTHROPIC_API_KEY']) || options.provider !== 'anthropic',
    process.env['ANTHROPIC_API_KEY']
      ? 'ANTHROPIC_API_KEY is set'
      : 'ANTHROPIC_API_KEY not set (fine if Claude Code sends its own auth)',
    undefined,
    true,
  );

  const state = readDaemonState(paths);
  if (state) {
    check(
      isProcessAlive(state.pid),
      isProcessAlive(state.pid)
        ? `Daemon state matches a live process (pid ${state.pid})`
        : `Stale daemon state (pid ${state.pid} is gone)`,
      'Clear it by restarting: claude-router restart',
      true,
    );
  }

  check(isAutostartRegistered(paths), isAutostartRegistered(paths) ? 'Autostart registered' : 'Autostart not registered', 'Register it: claude-router install', true);
  check(isStatuslineConfigured(paths), isStatuslineConfigured(paths) ? 'Claude Code statusline configured' : 'Statusline not configured', 'Add it: claude-router install', true);

  console.log(
    failures === 0
      ? `\n${term.ok()} Everything looks good.\n`
      : `\n${term.fail()} ${failures} problem(s) found.\n`,
  );
  process.exit(failures);
}

// ── help ───────────────────────────────────────────────────────────────────

function printHelp(): void {
  const a = (s: string) => term.accent(s);
  const d = (s: string) => term.dim(s);
  console.log(`
${term.bold('claude-router')} ${d('v' + getVersion())} — auto-route Claude API calls by prompt complexity

${term.bold('Usage')}
  ${a('claude-router install')} [options]     One-time setup: daemon + autostart + env + statusline
  ${a('claude-router uninstall')}             Remove everything install added
  ${a('claude-router start')} [options]       Run the proxy in the foreground
  ${a('claude-router start -d')}              Run it in the background (daemon)
  ${a('claude-router stop')}                  Stop the background proxy
  ${a('claude-router restart')} [options]     Restart the background proxy
  ${a('claude-router status')}                Health, routing stats, install state
  ${a('claude-router stats')} [--json]        Lifetime savings and per-day breakdown
  ${a('claude-router logs')} [-f] [-n N]      Show (or follow) the daemon log
  ${a('claude-router init')} [--force]        Scaffold ~/.claude-router/config.json
  ${a('claude-router doctor')}                Diagnose common setup problems

${term.bold('Options')} ${d('(install / start / restart / status / doctor)')}
  --port, -p <number>      Port (default: 4000)
  --host <address>         Bind address (default: 127.0.0.1 — local only; 0.0.0.0 exposes to the network)
  --force-route            Route even explicit model requests — required for Claude Code
  --verbose, -v            Log each routing decision
  --classifier <mode>      heuristic | ai | hybrid (default: hybrid)
  --provider <mode>        anthropic | bedrock | vertex (default: anthropic)
  --region <string>        AWS/GCP region
  --version, -V            Print version

${term.bold('Install-only options')}
  --no-autostart           Skip login autostart registration
  --no-env                 Skip setting ANTHROPIC_BASE_URL
  --no-statusline          Skip the Claude Code statusline

${term.bold('Config file')} ${d('(~/.claude-router/config.json — flags always win)')}
  Any option above, plus per-tier model overrides ("tiers"), pricing ("pricing"),
  and classifier tuning ("routing"). Scaffold with: ${a('claude-router init')}

${term.bold('Quick start')}
  ${a('claude-router install --force-route')}
  ${d('# open a new terminal, then use `claude` normally')}
`);
}

// ── Entry ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [subcommand, ...rest] = process.argv.slice(2);

  if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    printHelp();
    return;
  }

  if (subcommand === '--version' || subcommand === '-V') {
    console.log(getVersion());
    return;
  }

  // Legacy invocation: bare flags with no subcommand used to mean `start`
  if (subcommand.startsWith('-')) {
    console.error(term.warn() + ' Deprecated: bare flags now require the `start` subcommand — running `start` for you.');
    await cmdStart(process.argv.slice(2));
    return;
  }

  if (rest.includes('--help') || rest.includes('-h')) {
    printHelp();
    return;
  }

  switch (subcommand) {
    case 'start': return cmdStart(rest);
    case 'stop': return cmdStop();
    case 'restart': return cmdRestart(rest);
    case 'status': return cmdStatus(rest);
    case 'stats': return cmdStats(rest);
    case 'logs': return cmdLogs(rest);
    case 'install': return cmdInstall(rest);
    case 'uninstall': return cmdUninstall();
    case 'init': return cmdInit(rest);
    case 'doctor': return cmdDoctor(rest);
    default: {
      const suggestion = suggestCommand(subcommand, COMMANDS);
      term.errorLine(
        `Unknown command '${subcommand}'.` + (suggestion ? ` Did you mean '${suggestion}'?` : ''),
      );
      console.error(term.dim(`Run 'claude-router help' for usage.`));
      process.exit(1);
    }
  }
}

main().catch((err) => {
  if (err instanceof CliUsageError) {
    term.errorLine(err.message);
  } else {
    term.errorLine(String(err));
  }
  process.exit(1);
});
