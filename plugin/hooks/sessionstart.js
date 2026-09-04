'use strict';
// SessionStart hook: prints the orchestration policy into the session context,
// then one line saying whether the proxy is actually enforcing it. Always exits
// 0 — a session must never fail to start because the proxy is down; the policy
// is then advisory and each agent's frontmatter model still applies.
const fs = require('node:fs');
const path = require('node:path');
const { proxyPort, readStdinJson, request } = require('./common.js');

async function main() {
  await readStdinJson(); // consumed, not needed — keeps the pipe drained
  const policy = fs.readFileSync(path.join(__dirname, '..', 'policy', 'policy.md'), 'utf8');
  const port = proxyPort();
  const health = await request(port, 'GET', '/health');

  let status;
  if (!health || health.status !== 200) {
    status = `claude-router: proxy not reachable on 127.0.0.1:${port} — role tiers below are advisory (each agent's own model setting still applies). Start it: claude-router start -d --force-route`;
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
      status = `claude-router: enforcing — ${session}, ${roles} (v${info.version || '?'}, port ${port}).`;
    }
  }
  process.stdout.write(`${policy.trimEnd()}\n\n${status}\n`);
}

main().catch(() => { /* never block a session */ }).finally(() => process.exit(0));
