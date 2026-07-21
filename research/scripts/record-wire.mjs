// Recording forward proxy: captures what Claude Code actually puts ON THE WIRE,
// then forwards untouched to the real API.
//
// WHY THIS EXISTS
// Two rounds of the same bug (#18, #34) shipped because nothing the project tests
// with looks like a real Claude Code request. Transcripts do not help: they store
// what the user typed, not what was sent — of 444 transcript files for this repo,
// 6 contain <system-reminder> and 2 contain the CLAUDE.md injection. That is why
// the 200-turn replay in research/2026-07-21-end-to-end-savings.md showed
// 197 sonnet / 3 opus and never surfaced #34. Only wire capture shows it.
//
// This proxy deliberately does NOT route. It records and forwards. Collecting the
// corpus must not change which model serves your real work.
//
// PRIVACY — READ BEFORE RUNNING
// Captured bodies contain your full prompts, source code, file paths and tool
// output. They are written unencrypted to OUT_DIR, which defaults OUTSIDE the
// repository so they cannot be committed by accident. Do not share the corpus,
// and delete it when the measurement is done.
//
// USAGE
//   node research/scripts/record-wire.mjs
//   # then, in the shell where you work:
//   export ANTHROPIC_BASE_URL=http://127.0.0.1:4200
//   claude
//
// ENV
//   PORT      default 4200
//   OUT_DIR   default ~/.claude-router/wire
//   UPSTREAM  default https://api.anthropic.com  (point elsewhere to test offline)
//   MAX_MB    default 500 — stop recording (but keep forwarding) past this
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = Number(process.env.PORT ?? 4200);
const OUT_DIR = process.env.OUT_DIR ?? path.join(os.homedir(), '.claude-router', 'wire');
const UPSTREAM = (process.env.UPSTREAM ?? 'https://api.anthropic.com').replace(/\/$/, '');
const MAX_BYTES = Number(process.env.MAX_MB ?? 500) * 1024 * 1024;

mkdirSync(OUT_DIR, { recursive: true });

function corpusBytes() {
  try {
    return readdirSync(OUT_DIR).reduce((n, f) => n + statSync(path.join(OUT_DIR, f)).size, 0);
  } catch { return 0; }
}

let seq = 0;
let recorded = 0;
let skipped = 0;
let bytes = corpusBytes();
if (bytes) console.log(`existing corpus: ${(bytes / 1e6).toFixed(1)} MB`);

// Hop-by-hop and length headers must not be replayed onto a body we re-encode.
const DROP_REQ = new Set(['host', 'connection', 'content-length', 'accept-encoding']);
// undici decompresses for us, so these would describe the wrong bytes downstream.
const DROP_RES = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const body = Buffer.concat(chunks);

    if (req.url.startsWith('/v1/messages') && body.length) {
      if (bytes < MAX_BYTES) {
        const n = String(++seq).padStart(5, '0');
        const file = path.join(OUT_DIR, `${n}.json.gz`);
        // Record the request only. Responses would multiply the corpus size and
        // routing never sees them.
        const gz = gzipSync(JSON.stringify({ seq, url: req.url, body: body.toString('utf8') }));
        writeFileSync(file, gz);
        bytes += gz.length;
        recorded++;
        if (recorded % 10 === 0) {
          process.stdout.write(`\rrecorded ${recorded} requests, ${(bytes / 1e6).toFixed(1)} MB   `);
        }
      } else {
        skipped++;
      }
    }

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!DROP_REQ.has(k.toLowerCase())) headers[k] = v;
    }

    try {
      const upstream = await fetch(UPSTREAM + req.url, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
      });

      const out = {};
      for (const [k, v] of upstream.headers.entries()) {
        if (!DROP_RES.has(k.toLowerCase())) out[k] = v;
      }
      res.writeHead(upstream.status, out);

      if (!upstream.body) return res.end();
      for await (const chunk of upstream.body) res.write(chunk);
      res.end();
    } catch (err) {
      // Never let a recorder failure break the user's actual work.
      console.error(`\n[record-wire] upstream error: ${err.message}`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(err.message) } }));
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`recording proxy  http://127.0.0.1:${PORT}  ->  ${UPSTREAM}`);
  console.log(`corpus           ${OUT_DIR}`);
  console.log(`\nexport ANTHROPIC_BASE_URL=http://127.0.0.1:${PORT}\n`);
});

process.on('SIGINT', () => {
  console.log(`\n\nrecorded ${recorded} requests, ${(bytes / 1e6).toFixed(1)} MB in ${OUT_DIR}`);
  if (skipped) console.log(`skipped ${skipped} past the ${MAX_BYTES / 1e6} MB cap`);
  console.log(`analyse with: node research/scripts/analyze-wire.mjs`);
  process.exit(0);
});
