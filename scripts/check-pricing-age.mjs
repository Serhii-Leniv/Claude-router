#!/usr/bin/env node
// Prints the age in days of the pricing table's last verification and exits 1
// when it is older than the threshold (default 60 days). Reads src/models.ts
// as text so it needs no build — the weekly pricing-check workflow runs it on a
// bare checkout. Usage: node scripts/check-pricing-age.mjs [maxDays]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, '..', 'src', 'models.ts'), 'utf8');
const match = source.match(/PRICING_LAST_CHECKED = '(\d{4}-\d{2}-\d{2})'/);
if (!match) {
  console.error('PRICING_LAST_CHECKED not found in src/models.ts');
  process.exit(2);
}
const maxDays = Number(process.argv[2] ?? 60);
const ageDays = Math.floor((Date.now() - Date.parse(`${match[1]}T00:00:00Z`)) / 86_400_000);
console.log(`pricing last checked ${match[1]} (${ageDays} days ago, limit ${maxDays})`);
process.exit(ageDays > maxDays ? 1 : 0);
