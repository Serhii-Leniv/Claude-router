import fs from 'node:fs';

/** Cap the proxy log at 5 MiB before rolling it over to a single backup. */
export const MAX_LOG_BYTES = 5 * 1024 * 1024;

/**
 * Size-based log rotation. If the file at `logPath` is larger than `maxBytes`,
 * rename it to `logPath.1` (replacing any previous `.1`), so at most ~2 files
 * of bounded size exist. A fresh `logPath` is created on the next append.
 *
 * Returns true if a rotation happened. Missing or under-cap files are left
 * untouched; any I/O error is swallowed so logging never blocks startup.
 */
export function rotateLogIfLarge(logPath: string, maxBytes: number = MAX_LOG_BYTES): boolean {
  try {
    const { size } = fs.statSync(logPath);
    if (size <= maxBytes) return false;
    fs.renameSync(logPath, `${logPath}.1`);
    return true;
  } catch {
    // No file yet, or the rename raced another start — either way, don't block.
    return false;
  }
}
