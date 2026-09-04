// Version-proof test entry: `node --test <glob>` needs Node >= 21 and
// directory args behave differently across versions, so enumerate the
// compiled test files ourselves and pass them explicitly.
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// `tsc` only writes files; it never removes them. A test file that existed on a
// branch you had checked out earlier stays compiled in dist/ and keeps running
// long after its source is gone — inflating the count and, worse, reporting on
// code that is no longer in the tree. Drop orphans before running.
function pruneOrphans(testDir) {
  for (const f of readdirSync(testDir)) {
    if (!f.endsWith('.test.js')) continue;
    if (!existsSync(join('src/__tests__', f.replace(/\.js$/, '.ts')))) {
      rmSync(join(testDir, f), { force: true });
    }
  }
}

const dir = 'dist/__tests__';
pruneOrphans(dir);
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => join(dir, f));

if (files.length === 0) {
  console.error(`No test files found in ${dir} — did the build run?`);
  process.exit(1);
}

// Colour off, always. `term` enables ANSI when stdout is a TTY or FORCE_COLOR is
// set, so any assertion on styled output passes or fails depending on whose
// terminal ran it — a contributor with FORCE_COLOR=1 in their profile gets a red
// build from green code. Tests that care about colour opt in explicitly via
// `createTerm({ forceColor: true })`, which reads no environment at all.
// COVERAGE=1 turns on node's built-in coverage (no dependency). Source maps
// are on in tsconfig, so the report is attributed to the .ts files.
const coverageFlags = process.env.COVERAGE ? ['--experimental-test-coverage', '--enable-source-maps'] : [];
const result = spawnSync(process.execPath, ['--test', ...coverageFlags, ...files], {
  stdio: 'inherit',
  env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
});
process.exit(result.status ?? 1);
