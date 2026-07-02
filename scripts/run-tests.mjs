// Version-proof test entry: `node --test <glob>` needs Node >= 21 and
// directory args behave differently across versions, so enumerate the
// compiled test files ourselves and pass them explicitly.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const dir = 'dist/__tests__';
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => join(dir, f));

if (files.length === 0) {
  console.error(`No test files found in ${dir} — did the build run?`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
