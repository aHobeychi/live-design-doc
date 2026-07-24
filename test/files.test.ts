import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listProjectFiles } from '../src/daemon/files.js';

function scaffold(paths: string[]): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'livedoc-files-'));
  for (const p of paths) {
    const full = join(root, ...p.split('/'));
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, 'x');
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('walks recursively, skipping hidden and dependency/build directories', () => {
  const { root, cleanup } = scaffold([
    'PLAN.md',
    'src/daemon/store.ts',
    'src/cli.ts',
    'node_modules/pkg/index.js',
    'dist/out.js',
    '.git/HEAD',
    '.livedoc/comments.json',
    '.env',
  ]);
  try {
    assert.deepEqual(listProjectFiles(root), ['PLAN.md', 'src/cli.ts', 'src/daemon/store.ts']);
  } finally {
    cleanup();
  }
});

test('the cap bounds the walk', () => {
  const { root, cleanup } = scaffold(['a.ts', 'b.ts', 'c.ts', 'd.ts']);
  try {
    assert.equal(listProjectFiles(root, 2).length, 2);
  } finally {
    cleanup();
  }
});

test('an unreadable root degrades to an empty list', () => {
  assert.deepEqual(listProjectFiles('/definitely/not/a/real/path'), []);
});
