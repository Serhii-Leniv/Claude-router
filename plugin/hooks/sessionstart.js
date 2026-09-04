'use strict';
// SessionStart hook: prints the orchestration policy into the session context,
// then one line saying whether the proxy is actually enforcing it. Always exits
// 0 — a session must never fail to start because the proxy is down; the policy
// is then advisory and each agent's frontmatter model still applies.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { proxyPort, readStdinJson, request } = require('./common.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Start the proxy daemon if it is not answering. `claude-router install` wrote
 * the effective options to config.json, so a bare `start -d` runs with the
 * same behaviour (force-route, session pin, delegation restore). Detached and
 * unreferenced: the hook must not wait on the daemon's lifetime, only poll
 * for its health. CLAUDE_ROUTER_BIN overrides the binary (tests, odd PATHs);
 * CLAUDE_ROUTER_NO_AUTOSTART=1 disables this entirely.
 */
async function ensureProxy(port) {
  let health = await request(port, 'GET', '/health');
  if (health || process.env.CLAUDE_ROUTER_NO_AUTOSTART) return { health, started: false };
  try {
    const win = process.platform === 'win32';
    const bin = process.env.CLAUDE_ROUTER_BIN || (win ? 'claude-router.cmd' : 'claude-router');
    const child = spawn(bin, ['start', '-d'], { detached: true, stdio: 'ignore', shell: win, windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    return { health: null, started: false };
  }
  for (let i = 0; i < 20 && !health; i++) {
    await sleep(150);
    health = await request(port, 'GET', '/health');
  }
  return { health, started: Boolean(health) };
}

async function main() {
  await readStdinJson(); // consumed, not needed — keeps the pipe drained
  const policy = fs.readFileSync(path.join(__dirname, '..', 'policy', 'policy.md'), 'utf8');
  const port = proxyPort();
  const { health, started } = await ensureProxy(port);

  let status;
  if (!health || health.status !== 200) {
    status = `claude-router: proxy not reachable on 127.0.0.1:${port} — role tiers below are advisory (each agent's own model setting still applies). Start it: claude-router start -d (or re-run claude-router install)`;
  } else {
    let info = {};
    try { info = JSON.parse(health.body); } catch { /* fall through to the generic line */ }
    if (info.service !== 'claude-router-proxy') {
      status = `claude-router: something else answers on port ${port}; role tiers below are advisory.`;
    } else if (!info.forceRoute) {
      status = `claude-router: proxy on port ${port} is up but not routing (start it with --force-route); role tiers below are advisory.`;
    } else {
      const session = info.sessionModel ? `session pinned to ${info.sessionModel}` : 'session classified per turn';
      const roles = info.roleRouting === false ? 'role routing off' : 'subagent roles routed by the proxy';
      status = `claude-router: enforcing — ${session}, ${roles} (v${info.version || '?'}, port ${port}${started ? ', started just now' : ''}).`;
    }
  }
  process.stdout.write(`${policy.trimEnd()}\n\n${status}\n`);
}

main().catch(() => { /* never block a session */ }).finally(() => process.exit(0));
