import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { routerPaths, type RouterPaths } from './cli-config.js';
import { unloadLaunchAgent } from './platform.js';
import { rotateLogIfLarge } from './log-rotate.js';
import { SERVICE_ID, type HealthInfo } from './health.js';

export interface DaemonState {
  pid: number;
  port: number;
  startedAt: string;
  args: string[];
}

export function readDaemonState(paths: RouterPaths = routerPaths()): DaemonState | null {
  if (!fs.existsSync(paths.daemonStateFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(paths.daemonStateFile, 'utf8')) as DaemonState;
  } catch {
    return null;
  }
}

export function writeDaemonState(state: DaemonState, paths: RouterPaths = routerPaths()): void {
  fs.mkdirSync(paths.configDir, { recursive: true });
  fs.writeFileSync(paths.daemonStateFile, JSON.stringify(state, null, 2), 'utf8');
}

export function clearDaemonState(paths: RouterPaths = routerPaths()): void {
  try {
    fs.unlinkSync(paths.daemonStateFile);
  } catch {
    // already gone
  }
}

export type StatusPortSource = 'flag' | 'daemon' | 'default';

export interface StatusPortCheck {
  port: number;
  source: StatusPortSource;
}

/**
 * Decide which port `status` should probe, and where that port came from.
 *
 * `status` used to check only the resolved port — a `--port` flag, else the
 * config value or the default 4000 — and report "stopped" from a free default
 * even while a daemon served traffic on another port recorded in daemon.json
 * (#39). When the user did not pin a port with `--port` and daemon.json records
 * a different one, prefer the daemon's recorded port so a running non-default
 * daemon is actually found. An explicit `--port` always wins, matching the
 * "flags always win" rule the rest of the CLI follows.
 */
export function resolveStatusPort(
  resolvedPort: number,
  portFromFlag: boolean,
  state: Pick<DaemonState, 'port'> | null,
): StatusPortCheck {
  if (!portFromFlag && state && state.port !== resolvedPort) {
    return { port: state.port, source: 'daemon' };
  }
  return { port: resolvedPort, source: portFromFlag ? 'flag' : 'default' };
}

/**
 * Plain-text account of what `status` actually checked when nothing responded,
 * so the report is a claim about a specific port rather than about the service
 * (#39). A daemon-recorded port names daemon.json as its source; a bare default
 * adds the `--port` hint, since the proxy may simply be listening elsewhere; an
 * explicit `--port` needs no hint — the user already named the port.
 */
export function stoppedStatusDetail(check: StatusPortCheck): string {
  switch (check.source) {
    case 'daemon':
      return `no proxy on port ${check.port} (from daemon.json)`;
    case 'flag':
      return `no proxy on port ${check.port}`;
    default:
      return `no proxy on port ${check.port} — pass --port if it is running elsewhere`;
  }
}

/**
 * The pid `status` may show next to `running`, or null when the response cannot
 * be attributed to the recorded daemon (#52). A live daemon.json is evidence
 * only about its own port: `status --port 5000` while the daemon runs on 4300
 * reached some other proxy, and printing the daemon's pid there names the wrong
 * process. Caller passes the same live-daemon value it fed `resolveStatusPort`,
 * so a stale record is already excluded.
 */
export function statusPid(
  check: StatusPortCheck,
  daemon: Pick<DaemonState, 'pid' | 'port'> | null,
): number | null {
  return daemon && daemon.port === check.port ? daemon.pid : null;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Fetch /health and verify it is actually our proxy (not some other service
 * on the port). Uses 127.0.0.1 — localhost can resolve to ::1 on Windows.
 */
export async function checkHealth(port: number, timeoutMs = 1000): Promise<HealthInfo | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as HealthInfo;
    return data.service === SERVICE_ID ? data : null;
  } catch {
    return null;
  }
}

export interface StartDaemonResult {
  ok: boolean;
  pid?: number;
  detail: string;
}

/**
 * Spawn the proxy as a detached background process and wait for /health to
 * pass before reporting success — no ✓ until the server is actually up.
 */
export async function startDaemon(
  serveArgs: string[],
  port: number,
  paths: RouterPaths = routerPaths(),
): Promise<StartDaemonResult> {
  const existing = await checkHealth(port);
  if (existing) {
    return { ok: false, detail: `A proxy is already running on port ${port}` };
  }

  fs.mkdirSync(paths.configDir, { recursive: true });
  // Keep proxy.log from growing without bound: roll it over to proxy.log.1
  // once it exceeds the size cap, before reopening for append.
  rotateLogIfLarge(paths.logFile);
  const logFd = fs.openSync(paths.logFile, 'a');

  const child = spawn(process.execPath, [process.argv[1]!, 'start', ...serveArgs], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(logFd);

  const pid = child.pid;
  if (!pid) return { ok: false, detail: 'Failed to spawn the proxy process' };

  // Poll health for up to ~3s
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const health = await checkHealth(port, 500);
    if (health) {
      writeDaemonState(
        { pid, port, startedAt: new Date().toISOString(), args: serveArgs },
        paths,
      );
      return { ok: true, pid, detail: `Proxy running on http://localhost:${port} (pid ${pid})` };
    }
    if (!isProcessAlive(pid)) break;
  }

  return {
    ok: false,
    pid,
    detail: `Proxy did not become healthy on port ${port}. Check logs: ${paths.logFile}`,
  };
}

export interface StopDaemonResult {
  ok: boolean;
  detail: string;
}

export async function stopDaemon(paths: RouterPaths = routerPaths()): Promise<StopDaemonResult> {
  // macOS: unload the LaunchAgent first — KeepAlive would resurrect a killed process
  unloadLaunchAgent(paths);

  const state = readDaemonState(paths);
  if (state && isProcessAlive(state.pid)) {
    try {
      process.kill(state.pid);
    } catch (err) {
      return { ok: false, detail: `Could not stop pid ${state.pid}: ${String(err)}` };
    }
    // Verify death for up to ~2s
    for (let i = 0; i < 10; i++) {
      if (!isProcessAlive(state.pid)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (isProcessAlive(state.pid)) {
      return { ok: false, detail: `Process ${state.pid} did not exit` };
    }
    clearDaemonState(paths);
    return { ok: true, detail: `Proxy stopped (pid ${state.pid})` };
  }

  clearDaemonState(paths);

  // No usable state file — maybe an older version or a manual start owns the port
  const health = await checkHealth(state?.port ?? 4000);
  if (health) {
    return {
      ok: false,
      detail:
        'A proxy is running but was not started by this version — stop it from its own terminal or restart it with: claude-router start -d',
    };
  }
  return { ok: true, detail: 'Proxy was not running' };
}
