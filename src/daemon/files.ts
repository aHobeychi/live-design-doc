import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Directories that are never interesting as note references. */
const IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'vendor',
  'target',
  '__pycache__',
]);

/**
 * Relative paths of project files for @-mentions in notes. Hidden entries and
 * dependency/build directories are skipped, symlinks are not followed, and the
 * walk stops at `cap` files so a huge repository cannot stall the daemon.
 */
export function listProjectFiles(root: string, cap = 5000): string[] {
  const results: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (results.length >= cap) return;
      if (e.name.startsWith('.')) continue;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) walk(join(dir, e.name), relPath);
      } else if (e.isFile()) {
        results.push(relPath);
      }
    }
  };
  walk(root, '');
  return results;
}
