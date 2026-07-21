// Extract real Claude Code turns that opus-4.8 actually served, so we can ask:
// would sonnet have sufficed? Two strata, because they are economically different.
//   A = mid-loop turns (stop_reason 'tool_use')  -> 92% of response volume
//   B = final answers   (stop_reason 'end_turn') -> 8%, easier to judge
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// UNLIKE measure-detectors.mjs, this extracts conversation CONTENT — source code,
// file paths, working notes. It is therefore scoped to this project's own
// transcripts by default. Widen it deliberately (argv[2]), never by habit, and
// never for a corpus you would not hand to a third party.
const ROOT = process.argv[2]
  ?? path.join(os.homedir(), '.claude', 'projects', 'D--IT-Projects-Claude-router');
const PER_STRATUM = 12;
const CTX_MESSAGES = 6;      // how many preceding messages to carry
const MAX_BLOCK = 1500;      // truncate any single block to keep prompts sane

const files = [];
(function walk(d) {
  let e; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const x of e) {
    const p = path.join(d, x.name);
    if (x.isDirectory()) walk(p);
    else if (x.name.endsWith('.jsonl')) files.push(p);
  }
})(ROOT);

function renderContent(content) {
  if (typeof content === 'string') return content.slice(0, MAX_BLOCK);
  if (!Array.isArray(content)) return '';
  const out = [];
  for (const b of content) {
    if (b?.type === 'text') out.push(b.text.slice(0, MAX_BLOCK));
    else if (b?.type === 'tool_use') out.push(`[tool_use ${b.name}: ${JSON.stringify(b.input).slice(0, MAX_BLOCK)}]`);
    else if (b?.type === 'tool_result') {
      const c = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
      out.push(`[tool_result: ${c.slice(0, MAX_BLOCK)}]`);
    } else if (b?.type === 'thinking') out.push('[thinking omitted]');
    else if (b?.type === 'image') out.push('[image]');
  }
  return out.join('\n');
}

const strata = { A: [], B: [] };
// Deterministic spread: walk files in order, take at most one sample per file so
// samples are not all from one long session.
for (const f of files) {
  if (strata.A.length >= PER_STRATUM && strata.B.length >= PER_STRATUM) break;
  let lines; try { lines = fs.readFileSync(f, 'utf8').split('\n'); } catch { continue; }
  const recs = [];
  for (const l of lines) { if (!l.trim()) continue; try { recs.push(JSON.parse(l)); } catch {} }

  let tookFromFile = false;
  for (let i = 0; i < recs.length && !tookFromFile; i++) {
    const r = recs[i];
    const m = r.message;
    if (r.type !== 'assistant' || m?.role !== 'assistant') continue;
    if (m.model !== 'claude-opus-4-8') continue;
    const stop = m.stop_reason;
    const stratum = stop === 'tool_use' ? 'A' : stop === 'end_turn' ? 'B' : null;
    if (!stratum || strata[stratum].length >= PER_STRATUM) continue;

    // Build the context the model saw: preceding messages, oldest first.
    const ctx = [];
    for (let j = Math.max(0, i - CTX_MESSAGES); j < i; j++) {
      const p = recs[j];
      if (!p.message?.role) continue;
      const body = renderContent(p.message.content);
      if (!body.trim()) continue;
      ctx.push(`### ${p.message.role.toUpperCase()}\n${body}`);
    }
    if (ctx.length < 2) continue;   // too little context to be a meaningful turn

    const actual = renderContent(m.content);
    if (!actual.trim()) continue;

    strata[stratum].push({
      id: `${stratum}${strata[stratum].length + 1}`,
      stratum,
      sourceFile: path.basename(f),
      project: path.basename(path.dirname(path.dirname(f))),
      stopReason: stop,
      context: ctx.join('\n\n'),
      opusActual: actual,
    });
    tookFromFile = true;
  }
}

const samples = [...strata.A, ...strata.B];
fs.writeFileSync('samples.json', JSON.stringify(samples, null, 2));
console.log(`stratum A (mid-loop tool_use): ${strata.A.length}`);
console.log(`stratum B (final end_turn):    ${strata.B.length}`);
console.log(`total samples: ${samples.length}`);
console.log(`avg context chars: ${Math.round(samples.reduce((s, x) => s + x.context.length, 0) / samples.length)}`);
console.log(`projects covered: ${new Set(samples.map((s) => s.project)).size}`);
