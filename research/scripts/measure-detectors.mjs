// Measurement pass 0: run the CURRENT detectors over real Claude Code traffic.
// Zero API calls, nothing leaves this machine. Answers:
//   (a) how often shouldRetry() fires on responses that were, in practice, fine
//   (b) how often the structural stop_reason:'refusal' signal actually occurs
//   (c) what tier the heuristic would pick for real agentic turns
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Import the SHIPPED detectors from dist/ — the point is to measure what runs,
// not a reimplementation. Run `npm run build` first.
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist');
const { shouldRetry } = await import(pathToFileURL(`${DIST}/retry.js`).href);
const { heuristicScoreDetailed, scoreToTier } = await import(pathToFileURL(`${DIST}/classifier.js`).href);

// Defaults to every local Claude Code transcript; pass a narrower path to scope it.
const ROOT = process.argv[2] ?? path.join(os.homedir(), '.claude', 'projects');
const files = [];
(function walk(d) {
  let ents;
  try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.jsonl')) files.push(p);
  }
})(ROOT);

const stats = {
  files: 0, records: 0,
  assistantResponses: 0,
  stopReason: {},
  structuralRefusals: 0,
  lexicalFires: 0,
  truncationFires: 0,
  modelUsed: {},
  userTurns: 0,
  tierPicked: { haiku: 0, sonnet: 0, opus: 0 },
  scoreHist: {},
};
const lexicalSamples = [];
const structuralSamples = [];

function textOf(content) {
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text').map((b) => b.text).join(' ');
}

for (const f of files) {
  let lines;
  try { lines = fs.readFileSync(f, 'utf8').split('\n'); } catch { continue; }
  stats.files++;
  const msgs = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    stats.records++;
    const m = o.message;
    if (!m) continue;

    if (o.type === 'assistant' && m.role === 'assistant') {
      // Only score completed responses (Claude Code writes partial records too)
      if (m.stop_reason === null || m.stop_reason === undefined) continue;
      stats.assistantResponses++;
      stats.stopReason[m.stop_reason] = (stats.stopReason[m.stop_reason] || 0) + 1;
      if (m.model) stats.modelUsed[m.model] = (stats.modelUsed[m.model] || 0) + 1;
      if (m.stop_reason === 'refusal') {
        stats.structuralRefusals++;
        if (structuralSamples.length < 10) {
          structuralSamples.push({ file: path.basename(f), model: m.model, details: m.stop_details, text: textOf(m.content).slice(0, 200) });
        }
      }
      // Run the shipped detector as the router would, from the sonnet entry tier
      const fake = { ...m, content: m.content, usage: m.usage };
      let d;
      try { d = shouldRetry(fake, 'sonnet'); } catch { continue; }
      if (d.retry && d.reason === 'refusal') {
        stats.lexicalFires++;
        if (lexicalSamples.length < 25) {
          lexicalSamples.push({ model: m.model, stop: m.stop_reason, text: textOf(m.content).slice(0, 240) });
        }
      }
      if (d.retry && d.reason === 'truncation') stats.truncationFires++;
    }

    if (o.type === 'user' && m.role === 'user') {
      msgs.push({ role: 'user', content: m.content });
      const t = textOf(m.content);
      if (!t.trim()) continue;
      stats.userTurns++;
      const det = heuristicScoreDetailed({ messages: [{ role: 'user', content: m.content }], system: undefined, tools: undefined });
      const tier = scoreToTier(det.score);
      stats.tierPicked[tier]++;
      const bucket = Math.min(100, Math.floor(det.score / 10) * 10);
      stats.scoreHist[bucket] = (stats.scoreHist[bucket] || 0) + 1;
    }
  }
}

console.log(JSON.stringify({ stats, lexicalSamples, structuralSamples }, null, 2));
