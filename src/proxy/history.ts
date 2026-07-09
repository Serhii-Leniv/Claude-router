import fs from 'node:fs';
import path from 'node:path';
import { emptyTotals, foldOutcome, type RouteTotals } from '../totals.js';
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

/** Lifetime figures are just accumulated {@link RouteTotals}. */
export type LifetimeStats = RouteTotals;

// Parsing and corrupt-line rejection are this module's concern (they belong to
// the file seam); the numeric folding is shared via foldOutcome.
function foldLine(stats: LifetimeStats, line: string): void {
  let event: RouteEvent;
  try {
    event = JSON.parse(line) as RouteEvent;
  } catch {
    return; // skip corrupt lines rather than losing the whole history
  }
  if (typeof event?.costCents !== 'number') return;
  foldOutcome(stats, event);
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
    return emptyTotals();
  }

  if (!cached || cached.file !== file || size < cached.offset) {
    cached = { file, offset: 0, stats: emptyTotals() };
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
          if (line.trim()) foldLine(cached.stats, line);
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
