import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { routerPaths, type RouterPaths } from './cli-config.js';
import { unloadLaunchAgent } from './platform.js';

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

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface HealthInfo {
  status: string;
  service: string;
  classifier: string;
  provider: string;
  forceRoute: boolean;
  requests: number;
  lastTier: string | null;
  lastModel: string | null;
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
    return data.service === 'claude-router-proxy' ? data : null;
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
