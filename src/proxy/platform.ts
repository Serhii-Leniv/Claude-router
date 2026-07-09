import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { PLIST_LABEL, routerPaths, type RouterPaths } from './cli-config.js';

export type PlatformName = 'windows' | 'macos' | 'linux';

export function platformName(): PlatformName {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
}

const WIN_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const WIN_RUN_VALUE = 'claude-router';
const SYSTEMD_UNIT = 'claude-router.service';

function systemdUnitPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.config', 'systemd', 'user', SYSTEMD_UNIT);
}

export interface StepResult {
  ok: boolean;
  /** Human-readable detail — path written, or why the step failed/was skipped */
  detail: string;
  /** Step was intentionally skipped (unsupported/absent tool/conflict) rather than failed */
  skipped?: boolean;
}

// ── Pure builders (testable) ───────────────────────────────────────────────

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildPlist(nodePath: string, cliPath: string, serveArgs: string[], logFile: string): string {
  const argXml = [nodePath, cliPath, 'start', ...serveArgs]
    .map((a) => `    <string>${escapeXml(a)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logFile)}</string>
</dict>
</plist>`;
}

/** Command line stored in the HKCU Run key — quotes paths that may contain spaces. */
export function buildRunKeyCommand(nodePath: string, cliPath: string, serveArgs: string[]): string {
  return [`"${nodePath}"`, `"${cliPath}"`, 'start', '--daemon', ...serveArgs].join(' ');
}

export function buildSystemdUnit(nodePath: string, cliPath: string, serveArgs: string[]): string {
  const exec = [nodePath, cliPath, 'start', ...serveArgs]
    .map((a) => (a.includes(' ') ? `"${a}"` : a))
    .join(' ');
  return `[Unit]
Description=claude-router proxy

[Service]
ExecStart=${exec}
Restart=on-failure

[Install]
WantedBy=default.target
`;
}

const RC_BLOCK_START = '# >>> claude-router >>>';
const RC_BLOCK_END = '# <<< claude-router <<<';

export function buildRcBlock(port: number): string {
  return `${RC_BLOCK_START}\nexport ANTHROPIC_BASE_URL=http://localhost:${port}\n${RC_BLOCK_END}`;
}

/** Remove our marker-delimited block, plus the legacy single-marker format. */
export function removeRcBlock(content: string): string {
  const lines = content.split('\n');
  const out: string[] = [];
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === RC_BLOCK_START) {
      inBlock = true;
      continue;
    }
    if (line.trim() === RC_BLOCK_END) {
      inBlock = false;
      continue;
    }
    if (inBlock) continue;
    // Legacy pre-0.1 format: "# claude-router" marker followed by the export
    if (line.trim() === '# claude-router') {
      if (lines[i + 1]?.includes('ANTHROPIC_BASE_URL=')) i++;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** Statusline command for ~/.claude/settings.json — node is guaranteed present. */
export function buildStatuslineCommand(port: number): string {
  // 127.0.0.1, not localhost: localhost can resolve to ::1 first on Windows.
  // Outer double quotes + inner single quotes work under cmd, PowerShell, and sh.
  return (
    `node -e "fetch('http://127.0.0.1:${port}/health',{signal:AbortSignal.timeout(300)})` +
    `.then(r=>r.json()).then(d=>console.log('[auto:'+(d.lastTier??'ready')+' #'+d.requests+']'))` +
    `.catch(()=>console.log('[auto:off]'))"`
  );
}

/** Matches any statusline command this tool has ever installed. */
export function isOurStatusline(command: string): boolean {
  return command.includes('[auto:');
}

// ── Platform integration adapters ───────────────────────────────────────────
//
// Autostart and the ANTHROPIC_BASE_URL env var are the OS-specific work. Rather
// than repeat a three-way `platformName()` switch inside every verb, each OS
// gets one adapter that owns all of its behaviour — so "how Windows autostart
// works" lives in one place. The pure builders above and the cross-platform
// statusline below are shared and stay outside the adapters.

export interface PlatformIntegration {
  readonly name: PlatformName;
  installAutostart(serveArgs: string[], paths?: RouterPaths): StepResult;
  uninstallAutostart(paths?: RouterPaths): StepResult;
  isAutostartRegistered(paths?: RouterPaths): boolean;
  setEnvVar(port: number, paths?: RouterPaths): StepResult;
  unsetEnvVar(paths?: RouterPaths): StepResult;
  isEnvVarSet(port: number): boolean;
  /** Run before stopping the daemon — macOS must unload its KeepAlive agent. */
  onStop(paths?: RouterPaths): void;
}

// ── Shared helpers ───────────────────────────────────────────────────────────

function readWindowsUserEnv(name: string): string | null {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], {
      stdio: 'pipe',
      encoding: 'utf8',
    });
    const match = out.match(/REG_(?:EXPAND_)?SZ\s+(.+)/);
    return match ? match[1]!.trim() : null;
  } catch {
    return null;
  }
}

/** Write the marker-delimited ANTHROPIC_BASE_URL block into a shell rc file (macOS/Linux). */
function setEnvVarViaRc(rcFile: string, port: number): StepResult {
  try {
    let content = fs.existsSync(rcFile) ? fs.readFileSync(rcFile, 'utf8') : '';
    if (content.includes(RC_BLOCK_START)) {
      content = removeRcBlock(content);
    } else if (/^export ANTHROPIC_BASE_URL=/m.test(content)) {
      return {
        ok: false,
        skipped: true,
        detail: `${rcFile} already exports ANTHROPIC_BASE_URL — not overwriting`,
      };
    }
    fs.writeFileSync(rcFile, `${content.replace(/\n*$/, '\n')}${buildRcBlock(port)}\n`, 'utf8');
    return { ok: true, detail: `ANTHROPIC_BASE_URL added to ${rcFile}` };
  } catch (err) {
    return { ok: false, detail: `Could not update ${rcFile}: ${String(err)}` };
  }
}

/** Strip our block from both candidate rc files (macOS/Linux share this). */
function unsetEnvVarViaRc(paths: RouterPaths): StepResult {
  let removedAny = false;
  for (const rcFile of [paths.zshrcFile, paths.bashrcFile]) {
    if (!fs.existsSync(rcFile)) continue;
    const content = fs.readFileSync(rcFile, 'utf8');
    const cleaned = removeRcBlock(content);
    if (cleaned !== content) {
      fs.writeFileSync(rcFile, cleaned, 'utf8');
      removedAny = true;
    }
  }
  return removedAny
    ? { ok: true, detail: 'ANTHROPIC_BASE_URL block removed from shell rc' }
    : { ok: true, detail: 'No claude-router block found in shell rc', skipped: true };
}

function envMatchesProcess(port: number): boolean {
  const current = process.env['ANTHROPIC_BASE_URL'];
  return current === `http://localhost:${port}` || current === `http://127.0.0.1:${port}`;
}

// ── Windows ──────────────────────────────────────────────────────────────────

const windowsIntegration: PlatformIntegration = {
  name: 'windows',
  installAutostart(serveArgs) {
    try {
      execFileSync('reg', [
        'add', WIN_RUN_KEY, '/v', WIN_RUN_VALUE, '/t', 'REG_SZ',
        '/d', buildRunKeyCommand(process.execPath, process.argv[1]!, serveArgs), '/f',
      ], { stdio: 'pipe' });
      return { ok: true, detail: `Run key registered (${WIN_RUN_KEY}\\${WIN_RUN_VALUE})` };
    } catch (err) {
      return { ok: false, detail: `Could not write Run key: ${String(err)}` };
    }
  },
  uninstallAutostart() {
    try {
      execFileSync('reg', ['delete', WIN_RUN_KEY, '/v', WIN_RUN_VALUE, '/f'], { stdio: 'pipe' });
      return { ok: true, detail: 'Run key removed' };
    } catch {
      return { ok: true, detail: 'Run key was not present', skipped: true };
    }
  },
  isAutostartRegistered() {
    try {
      execFileSync('reg', ['query', WIN_RUN_KEY, '/v', WIN_RUN_VALUE], { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  },
  setEnvVar(port) {
    const target = `http://localhost:${port}`;
    const existing = readWindowsUserEnv('ANTHROPIC_BASE_URL');
    if (existing && existing !== target) {
      return {
        ok: false,
        skipped: true,
        detail: `ANTHROPIC_BASE_URL is already set to ${existing} — not overwriting. Set it manually: setx ANTHROPIC_BASE_URL ${target}`,
      };
    }
    try {
      execFileSync('setx', ['ANTHROPIC_BASE_URL', target], { stdio: 'pipe' });
      return { ok: true, detail: `ANTHROPIC_BASE_URL=${target} (new terminals only)` };
    } catch (err) {
      return { ok: false, detail: `setx failed: ${String(err)}` };
    }
  },
  unsetEnvVar() {
    const existing = readWindowsUserEnv('ANTHROPIC_BASE_URL');
    if (!existing) return { ok: true, detail: 'ANTHROPIC_BASE_URL was not set', skipped: true };
    if (!/https?:\/\/(localhost|127\.0\.0\.1):/.test(existing)) {
      return { ok: true, skipped: true, detail: `ANTHROPIC_BASE_URL points elsewhere (${existing}) — left in place` };
    }
    try {
      execFileSync('reg', ['delete', 'HKCU\\Environment', '/v', 'ANTHROPIC_BASE_URL', '/f'], { stdio: 'pipe' });
      return { ok: true, detail: 'ANTHROPIC_BASE_URL removed' };
    } catch (err) {
      return { ok: false, detail: `Could not remove env var: ${String(err)}` };
    }
  },
  isEnvVarSet(port) {
    const persisted = readWindowsUserEnv('ANTHROPIC_BASE_URL');
    if (persisted === `http://localhost:${port}` || persisted === `http://127.0.0.1:${port}`) return true;
    return envMatchesProcess(port);
  },
  onStop() {
    // No KeepAlive supervisor on Windows.
  },
};

// ── macOS ────────────────────────────────────────────────────────────────────

const macosIntegration: PlatformIntegration = {
  name: 'macos',
  installAutostart(serveArgs, paths = routerPaths()) {
    try {
      fs.mkdirSync(path.dirname(paths.plistFile), { recursive: true });
      fs.writeFileSync(paths.plistFile, buildPlist(process.execPath, process.argv[1]!, serveArgs, paths.logFile), 'utf8');
    } catch (err) {
      return { ok: false, detail: `Could not write LaunchAgent: ${String(err)}` };
    }
    try {
      execFileSync('launchctl', ['unload', paths.plistFile], { stdio: 'pipe' });
    } catch {
      // not loaded yet — fine
    }
    try {
      execFileSync('launchctl', ['load', paths.plistFile], { stdio: 'pipe' });
      return { ok: true, detail: `LaunchAgent loaded (${paths.plistFile})` };
    } catch (err) {
      return { ok: false, detail: `LaunchAgent written but launchctl load failed: ${String(err)}` };
    }
  },
  uninstallAutostart(paths = routerPaths()) {
    this.onStop(paths);
    if (fs.existsSync(paths.plistFile)) {
      try {
        fs.unlinkSync(paths.plistFile);
        return { ok: true, detail: 'LaunchAgent removed' };
      } catch (err) {
        return { ok: false, detail: `Could not remove LaunchAgent: ${String(err)}` };
      }
    }
    return { ok: true, detail: 'LaunchAgent was not present', skipped: true };
  },
  isAutostartRegistered(paths = routerPaths()) {
    return fs.existsSync(paths.plistFile);
  },
  setEnvVar(port, paths = routerPaths()) {
    const result = setEnvVarViaRc(paths.zshrcFile, port);
    if (!result.ok || result.skipped) return result;
    // GUI apps launched from Dock/Finder (VS Code, the Claude Code extension) don't
    // read shell rc, so the rc export alone never reaches them. launchctl setenv
    // injects it into the running GUI session — no relaunch-from-terminal needed.
    try {
      execFileSync('launchctl', ['setenv', 'ANTHROPIC_BASE_URL', `http://localhost:${port}`], { stdio: 'pipe' });
      return { ok: true, detail: `${result.detail} + GUI session (launchctl)` };
    } catch {
      return { ok: true, detail: `${result.detail} (launchctl setenv failed — restart GUI apps from a terminal)` };
    }
  },
  unsetEnvVar(paths = routerPaths()) {
    const result = unsetEnvVarViaRc(paths);
    try {
      execFileSync('launchctl', ['unsetenv', 'ANTHROPIC_BASE_URL'], { stdio: 'pipe' });
    } catch {
      // not set / launchctl absent — nothing to undo
    }
    return result;
  },
  isEnvVarSet(port) {
    return envMatchesProcess(port);
  },
  onStop(paths = routerPaths()) {
    if (!fs.existsSync(paths.plistFile)) return;
    try {
      execFileSync('launchctl', ['unload', paths.plistFile], { stdio: 'pipe' });
    } catch {
      // not loaded — fine
    }
  },
};

// ── Linux ────────────────────────────────────────────────────────────────────

const linuxIntegration: PlatformIntegration = {
  name: 'linux',
  installAutostart(serveArgs) {
    try {
      const unitPath = systemdUnitPath();
      fs.mkdirSync(path.dirname(unitPath), { recursive: true });
      fs.writeFileSync(unitPath, buildSystemdUnit(process.execPath, process.argv[1]!, serveArgs), 'utf8');
      execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' });
      execFileSync('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT], { stdio: 'pipe' });
      return { ok: true, detail: `systemd user unit enabled (${unitPath})` };
    } catch (err) {
      return {
        ok: false,
        detail: `systemd setup failed (${String(err)}). The daemon still runs; re-run 'claude-router start -d' after reboot.`,
      };
    }
  },
  uninstallAutostart() {
    const unitPath = systemdUnitPath();
    if (!fs.existsSync(unitPath)) return { ok: true, detail: 'systemd unit was not present', skipped: true };
    try {
      execFileSync('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT], { stdio: 'pipe' });
    } catch {
      // systemctl absent or unit not enabled — still remove the file
    }
    try {
      fs.unlinkSync(unitPath);
      return { ok: true, detail: 'systemd unit removed' };
    } catch (err) {
      return { ok: false, detail: `Could not remove systemd unit: ${String(err)}` };
    }
  },
  isAutostartRegistered() {
    return fs.existsSync(systemdUnitPath());
  },
  setEnvVar(port, paths = routerPaths()) {
    const rcFile = process.env['SHELL']?.includes('zsh') ? paths.zshrcFile : paths.bashrcFile;
    return setEnvVarViaRc(rcFile, port);
  },
  unsetEnvVar(paths = routerPaths()) {
    return unsetEnvVarViaRc(paths);
  },
  isEnvVarSet(port) {
    return envMatchesProcess(port);
  },
  onStop() {
    // systemd Restart=on-failure does not resurrect a clean stop.
  },
};

/** Select the adapter for the current OS. */
export function platformIntegration(): PlatformIntegration {
  const p = platformName();
  if (p === 'windows') return windowsIntegration;
  if (p === 'macos') return macosIntegration;
  return linuxIntegration;
}

// ── Public delegators ────────────────────────────────────────────────────────
// The interface stays a flat set of functions for callers; each one routes to
// the current OS's adapter.

export function installAutostart(serveArgs: string[], paths: RouterPaths = routerPaths()): StepResult {
  return platformIntegration().installAutostart(serveArgs, paths);
}

export function uninstallAutostart(paths: RouterPaths = routerPaths()): StepResult {
  return platformIntegration().uninstallAutostart(paths);
}

export function isAutostartRegistered(paths: RouterPaths = routerPaths()): boolean {
  return platformIntegration().isAutostartRegistered(paths);
}

export function setEnvVar(port: number, paths: RouterPaths = routerPaths()): StepResult {
  return platformIntegration().setEnvVar(port, paths);
}

export function unsetEnvVar(paths: RouterPaths = routerPaths()): StepResult {
  return platformIntegration().unsetEnvVar(paths);
}

export function isEnvVarSet(port: number): boolean {
  return platformIntegration().isEnvVarSet(port);
}

/** macOS unloads its KeepAlive LaunchAgent before a stop; a no-op elsewhere. */
export function unloadLaunchAgent(paths: RouterPaths = routerPaths()): void {
  platformIntegration().onStop(paths);
}

/**
 * PID of the proxy if the OS autostart supervisor (launchd / systemd) is
 * currently running it. Lets `install` record the supervised process in the
 * daemon state file instead of starting a redundant daemon that would race it
 * on the port. Returns null when no supervisor owns the process (e.g. Windows,
 * or a manually started daemon).
 */
export function supervisorPid(paths: RouterPaths = routerPaths()): number | null {
  void paths;
  const platform = platformName();
  try {
    if (platform === 'macos') {
      const out = execFileSync('launchctl', ['list'], { encoding: 'utf8', stdio: 'pipe' });
      for (const line of out.split('\n')) {
        // columns: "<pid>\t<last exit>\t<label>"; pid is '-' when not running
        const [pid, , label] = line.split('\t');
        if (label === PLIST_LABEL && pid && pid !== '-') {
          const n = parseInt(pid, 10);
          return Number.isNaN(n) ? null : n;
        }
      }
      return null;
    }
    if (platform === 'linux') {
      const out = execFileSync(
        'systemctl',
        ['--user', 'show', SYSTEMD_UNIT, '--property=MainPID', '--value'],
        { encoding: 'utf8', stdio: 'pipe' },
      );
      const n = parseInt(out.trim(), 10);
      return n > 0 ? n : null;
    }
  } catch {
    return null;
  }
  return null;
}

// ── Claude Code statusline ─────────────────────────────────────────────────

export function addStatusline(port: number, paths: RouterPaths = routerPaths()): StepResult {
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(paths.claudeSettingsFile)) {
    try {
      settings = JSON.parse(fs.readFileSync(paths.claudeSettingsFile, 'utf8'));
    } catch (err) {
      return { ok: false, detail: `~/.claude/settings.json is not valid JSON (${String(err)}) — skipping statusline` };
    }
  }

  const existing = settings['statusLine'] as { command?: string } | undefined;
  if (existing?.command && !isOurStatusline(existing.command)) {
    return { ok: false, skipped: true, detail: 'A custom statusline is already configured — not overwriting' };
  }

  try {
    settings['statusLine'] = { type: 'command', command: buildStatuslineCommand(port) };
    fs.mkdirSync(path.dirname(paths.claudeSettingsFile), { recursive: true });
    fs.writeFileSync(paths.claudeSettingsFile, JSON.stringify(settings, null, 2), 'utf8');
    return { ok: true, detail: 'Statusline configured in ~/.claude/settings.json' };
  } catch (err) {
    return { ok: false, detail: `Could not write ~/.claude/settings.json: ${String(err)}` };
  }
}

export function removeStatusline(paths: RouterPaths = routerPaths()): StepResult {
  if (!fs.existsSync(paths.claudeSettingsFile)) {
    return { ok: true, detail: 'No Claude settings file', skipped: true };
  }
  try {
    const settings = JSON.parse(fs.readFileSync(paths.claudeSettingsFile, 'utf8')) as Record<string, unknown>;
    const statusLine = settings['statusLine'] as { command?: string } | undefined;
    if (statusLine?.command && isOurStatusline(statusLine.command)) {
      delete settings['statusLine'];
      fs.writeFileSync(paths.claudeSettingsFile, JSON.stringify(settings, null, 2), 'utf8');
      return { ok: true, detail: 'Statusline removed' };
    }
    return { ok: true, detail: 'Statusline was not ours', skipped: true };
  } catch (err) {
    return { ok: false, detail: `Could not update ~/.claude/settings.json: ${String(err)}` };
  }
}

export function isStatuslineConfigured(paths: RouterPaths = routerPaths()): boolean {
  if (!fs.existsSync(paths.claudeSettingsFile)) return false;
  try {
    const settings = JSON.parse(fs.readFileSync(paths.claudeSettingsFile, 'utf8')) as Record<string, unknown>;
    const statusLine = settings['statusLine'] as { command?: string } | undefined;
    return Boolean(statusLine?.command && isOurStatusline(statusLine.command));
  } catch {
    return false;
  }
}
