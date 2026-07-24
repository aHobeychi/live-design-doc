import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/daemon/store.js';
import type { Note } from '../src/types.js';

function tempStore(): { store: Store; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'livedoc-store-'));
  const store = new Store(join(dir, '.livedoc'));
  store.ensure();
  return { store, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const NOTE: Note = {
  id: 'n-1',
  state: 'sent',
  intent: 'change',
  body: 'b',
  quote: 'q',
  contextBefore: '',
  contextAfter: '',
  blockId: 'x',
  blockTextAtCreation: 'x text',
  createdAgainstRevision: 1,
  resolved: { blockId: 'x', fidelity: 'exact' },
  seenByAgent: false,
};

test('ensure() creates the directory split and its .gitignore', () => {
  const { store, cleanup } = tempStore();
  try {
    assert.ok(existsSync(join(store.dir, 'revisions')));
    const ignore = readFileSync(join(store.dir, '.gitignore'), 'utf8');
    for (const line of ['revisions/', 'session.json', 'pending.json']) {
      assert.ok(ignore.includes(line), line);
    }
  } finally {
    cleanup();
  }
});

test('comments round-trip and are written with sorted keys for stable diffs', () => {
  const { store, cleanup } = tempStore();
  try {
    store.saveComments([NOTE]);
    assert.deepEqual(store.loadComments(), [NOTE]);
    const raw = readFileSync(join(store.dir, 'comments.json'), 'utf8');
    const keys = [...raw.matchAll(/^ {6}"(\w+)"/gm)].map((m) => m[1]);
    assert.deepEqual(keys, [...keys].sort(), 'note keys must be alphabetical');
    assert.ok(raw.endsWith('\n'));
  } finally {
    cleanup();
  }
});

test('loadComments on a missing or corrupt file degrades to empty, not a crash', () => {
  const { store, cleanup } = tempStore();
  try {
    assert.deepEqual(store.loadComments(), []);
    assert.equal(store.loadAnswers(), null);
    assert.deepEqual(store.loadPending(), []);
  } finally {
    cleanup();
  }
});

test('revisions are zero-padded and maxRevision resumes the counter', () => {
  const { store, cleanup } = tempStore();
  try {
    assert.equal(store.maxRevision(), 0);
    store.saveRevision(1, 'one');
    store.saveRevision(12, 'twelve');
    assert.ok(existsSync(join(store.dir, 'revisions', '001.md')));
    assert.ok(existsSync(join(store.dir, 'revisions', '012.md')));
    assert.equal(store.maxRevision(), 12);
  } finally {
    cleanup();
  }
});

test('saveApproved returns a timestamped path holding the content', () => {
  const { store, cleanup } = tempStore();
  try {
    const path = store.saveApproved('# frozen\n');
    assert.match(path, /approved-.+\.md$/);
    assert.equal(readFileSync(path, 'utf8'), '# frozen\n');
  } finally {
    cleanup();
  }
});

test('session write/read/clear', () => {
  const { store, cleanup } = tempStore();
  try {
    const info = { pid: 1, port: 4317, url: 'http://127.0.0.1:4317', file: '/p.md', startedAt: 't' };
    store.writeSession(info);
    assert.deepEqual(store.readSession(), info);
    store.clearSession();
    assert.equal(store.readSession(), null);
    store.clearSession(); // idempotent
  } finally {
    cleanup();
  }
});

test('atomic writes leave no .tmp files behind', () => {
  const { store, cleanup } = tempStore();
  try {
    store.saveComments([NOTE]);
    store.savePending([]);
    assert.ok(readdirSync(store.dir).every((f) => !f.endsWith('.tmp')));
  } finally {
    cleanup();
  }
});
