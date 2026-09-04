'use strict';
// Shared by the two hooks. Zero dependencies, CommonJS, Node >= 20 — the hooks
// run under whatever `node` Claude Code finds, on every OS the proxy supports.
const http = require('node:http');

/** The proxy port: CLAUDE_ROUTER_PORT, else the port in ANTHROPIC_BASE_URL, else 4000. */
function proxyPort(env = process.env) {
  const explicit = Number(env.CLAUDE_ROUTER_PORT);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  try {
    const u = new URL(env.ANTHROPIC_BASE_URL || '');
    if ((u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.port) return Number(u.port);
  } catch { /* not a URL */ }
  return 4000;
}

/** Read all of stdin as JSON; `{}` on empty or malformed input (hooks must never fail on it). */
function readStdinJson() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (raw += chunk));
    process.stdin.on('end', () => {
      try { resolve(raw.trim() ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
    process.stdin.on('error', () => resolve({}));
    if (process.stdin.isTTY) resolve({});
  });
}

/** One short HTTP request to the proxy on loopback; resolves null on any failure or after `timeoutMs`. */
function request(port, method, path, body, timeoutMs = 300) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1', port, method, path,
        headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {},
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      },
    );
    const giveUp = () => { req.destroy(); resolve(null); };
    req.setTimeout(timeoutMs, giveUp);
    req.on('error', () => resolve(null));
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = { proxyPort, readStdinJson, request };
