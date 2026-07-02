import fs from 'node:fs';
import path from 'node:path';
import type { RouteEvent } from './handler.js';

/**
 * Persistent route history: one JSON line per event, append-only.
 * Powers `claude-router stats` and the dashboard's lifetime figures.
 */

export function appendEvent(file: string, event: RouteEvent): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(event) + '\n', 'utf8');
  } catch {
    // History is best-effort — never let persistence break a request.
  }
}

export interface LifetimeStats {
  requests: number;
  costCents: number;
  savedCents: number;
  retried: number;
  tiers: Record<string, number>;
  /** Per-day aggregates keyed by YYYY-MM-DD */
  byDay: Record<string, { requests: number; costCents: number; savedCents: number }>;
}

function emptyStats(): LifetimeStats {
  return { requests: 0, costCents: 0, savedCents: 0, retried: 0, tiers: {}, byDay: {} };
}

function fold(stats: LifetimeStats, line: string): void {
  let event: RouteEvent;
  try {
    event = JSON.parse(line) as RouteEvent;
  } catch {
    return; // skip corrupt lines rather than losing the whole history
  }
  if (typeof event?.costCents !== 'number') return;
  stats.requests++;
  stats.costCents += event.costCents;
  stats.savedCents += event.savedCents;
  if (event.retried) stats.retried++;
  stats.tiers[event.tier] = (stats.tiers[event.tier] ?? 0) + 1;
  const day = String(event.timestamp ?? '').slice(0, 10);
  if (day) {
    const d = (stats.byDay[day] ??= { requests: 0, costCents: 0, savedCents: 0 });
    d.requests++;
    d.costCents += event.costCents;
    d.savedCents += event.savedCents;
  }
}

// Incremental cache: the file is append-only, so once a prefix is folded we
// only ever need to read the newly-appended bytes.
let cached: { file: string; offset: number; stats: LifetimeStats } | null = null;

/** @internal Test hook */
export function resetHistoryCache(): void {
  cached = null;
}

export function readLifetimeStats(file: string): LifetimeStats {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return emptyStats();
  }

  if (!cached || cached.file !== file || size < cached.offset) {
    cached = { file, offset: 0, stats: emptyStats() };
  }
  if (size === cached.offset) return cached.stats;

  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - cached.offset);
      fs.readSync(fd, buf, 0, buf.length, cached.offset);
      const text = buf.toString('utf8');
      // Only fold complete lines; keep the offset at the last newline so a
      // partially-written trailing line is picked up next read.
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline >= 0) {
        for (const line of text.slice(0, lastNewline).split('\n')) {
          if (line.trim()) fold(cached.stats, line);
        }
        cached.offset += lastNewline + 1;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Unreadable — serve what we have
  }
  return cached.stats;
}
