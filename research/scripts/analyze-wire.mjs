// Replay a wire corpus through the router's real decision function.
//
// The point is NOT to confirm the tier distribution looks nice. It is to hunt for
// the next variant of the bug that has now shipped twice: harness text reaching
// the gates and deciding the tier. So this reports leaks first and totals second.
//
// USAGE
//   npm run build && node research/scripts/analyze-wire.mjs [corpusDir]
import { readdirSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const DIR = process.argv[2] ?? path.join(os.homedir(), '.claude-router', 'wire');
const dist = pathToFileURL(path.resolve('dist/routing.js')).href;
const { routeByEvidence, latestUserText, isAgentic, isMidLoop } = await import(dist);

// Markers that should never survive into scored task text. Each is a distinct
// injection channel, so we can tell WHICH one leaked rather than just "something".
const LEAK_MARKERS = [
  ['system-reminder', /<system-reminder>/i],
  ['claudeMd', /#\s*claudeMd|Contents of .*CLAUDE\.md/i],
  ['skill roster', /The following skills are available/i],
  ['agent roster', /Available agent types for the Agent tool/i],
  ['tool result', /<tool_use_error>|<function_results>/i],
  // The wrapper, not the instruction that follows it. "Write the title …" IS the
  // task for a meta-call and must not be flagged, or the detector cries wolf.
  ['quoted session', /<session>|<\/session>/i],
];

const files = readdirSync(DIR).filter((f) => f.endsWith('.json.gz')).sort();
if (!files.length) {
  console.error(`no corpus in ${DIR} — run record-wire.mjs first`);
  process.exit(1);
}

const tiers = {}, reasons = {}, leaks = {};
const leakSamples = [];
const suspicious = [];
let agentic = 0, midLoop = 0, emptyTask = 0;
const taskLens = [];

for (const f of files) {
  let p;
  try { p = JSON.parse(JSON.parse(gunzipSync(readFileSync(path.join(DIR, f))).toString()).body); }
  catch { continue; }
  if (!Array.isArray(p.messages)) continue;

  const input = { messages: p.messages, system: p.system, tools: p.tools };
  const task = latestUserText(input);
  const d = routeByEvidence(input);

  tiers[d.tier] = (tiers[d.tier] ?? 0) + 1;
  reasons[d.reason] = (reasons[d.reason] ?? 0) + 1;
  if (isAgentic(input)) agentic++;
  if (isMidLoop(input)) midLoop++;
  if (!task) emptyTask++;
  taskLens.push(task.length);

  for (const [name, re] of LEAK_MARKERS) {
    if (re.test(task)) {
      leaks[name] = (leaks[name] ?? 0) + 1;
      if (leakSamples.length < 8) {
        leakSamples.push({ file: f, marker: name, tier: d.tier, reason: d.reason, head: task.slice(0, 200) });
      }
    }
  }

  // A promotion justified by text far longer than a human types is the shape
  // both shipped bugs had. Worth eyeballing even when no known marker matched.
  if (d.tier === 'opus' && task.length > 2000) {
    suspicious.push({ file: f, len: task.length, reason: d.reason, head: task.slice(0, 200) });
  }
}

const n = files.length;
const pct = (x) => `${((x / n) * 100).toFixed(1)}%`;
const sorted = [...taskLens].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)] ?? 0;

console.log(`\ncorpus: ${n} requests from ${DIR}\n`);

console.log('LEAKS — harness text that reached scored task text');
if (!Object.keys(leaks).length) {
  console.log('   none detected\n');
} else {
  for (const [k, v] of Object.entries(leaks).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${k.padEnd(16)} ${String(v).padStart(5)}  ${pct(v)}`);
  }
  console.log();
  for (const s of leakSamples) {
    console.log(`   ${s.file} [${s.marker}] -> ${s.tier}/${s.reason}`);
    console.log(`      ${JSON.stringify(s.head)}\n`);
  }
}

console.log('TIERS');
for (const [k, v] of Object.entries(tiers).sort((a, b) => b[1] - a[1])) {
  console.log(`   ${k.padEnd(10)} ${String(v).padStart(5)}  ${pct(v)}`);
}

console.log('\nREASONS');
for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
  console.log(`   ${k.padEnd(34)} ${String(v).padStart(5)}  ${pct(v)}`);
}

console.log('\nSHAPE');
console.log(`   agentic          ${String(agentic).padStart(5)}  ${pct(agentic)}`);
console.log(`   mid-loop         ${String(midLoop).padStart(5)}  ${pct(midLoop)}`);
console.log(`   empty task text  ${String(emptyTask).padStart(5)}  ${pct(emptyTask)}`);
console.log(`   median task len  ${String(median).padStart(5)} chars`);

if (suspicious.length) {
  console.log(`\nOPUS ON LONG TASK TEXT — ${suspicious.length} request(s), no known marker matched`);
  for (const s of suspicious.slice(0, 8)) {
    console.log(`   ${s.file} ${s.len}ch ${s.reason}`);
    console.log(`      ${JSON.stringify(s.head)}\n`);
  }
}
