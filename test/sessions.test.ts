import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Registry,
  migrateFlatLayout,
  relFileFor,
  sessionDir,
  sessionIdFor,
} from '../src/daemon/sessions.js';
import { clearCurrentSession, resolveSessionId, writeCurrentSession } from '../src/commands/api.js';
import type { SessionRecord } from '../src/types.js';

function tempRoot(): { root: string; livedoc: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'livedoc-sessions-'));
  return {
    root,
    livedoc: join(root, '.livedoc'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('sessionIdFor is stable and shaped <slug>-<hash8>', () => {
  const id = sessionIdFor('/proj/PLAN.md', '/proj');
  assert.equal(id, sessionIdFor('/proj/PLAN.md', '/proj'));
  assert.match(id, /^plan-[0-9a-f]{8}$/);
});

test('sessionIdFor slugifies punctuation and case', () => {
  assert.match(sessionIdFor('/proj/My Plan (v2).md', '/proj'), /^my-plan-v2-[0-9a-f]{8}$/);
  assert.match(sessionIdFor('/proj/___.md', '/proj'), /^plan-[0-9a-f]{8}$/);
  const long = sessionIdFor('/proj/' + 'a'.repeat(80) + '.md', '/proj');
  assert.equal(long.split('-')[0].length, 32);
});

test('same basename in different directories yields different ids', () => {
  assert.notEqual(sessionIdFor('/proj/a/PLAN.md', '/proj'), sessionIdFor('/proj/b/PLAN.md', '/proj'));
});

test('ids hash the relative path, so a clone to another directory keeps them', () => {
  assert.equal(sessionIdFor('/one/PLAN.md', '/one'), sessionIdFor('/two/PLAN.md', '/two'));
  // Outside the root there is no stable relative path, so the absolute one is
  // hashed instead — which makes the id independent of the root, not tied to it.
  assert.equal(sessionIdFor('/elsewhere/PLAN.md', '/one'), sessionIdFor('/elsewhere/PLAN.md', '/two'));
  assert.notEqual(sessionIdFor('/elsewhere/PLAN.md', '/one'), sessionIdFor('/one/PLAN.md', '/one'));
});

test('relFileFor is relative inside the root and absolute outside it', () => {
  assert.equal(relFileFor('/proj/docs/PLAN.md', '/proj'), join('docs', 'PLAN.md'));
  assert.equal(relFileFor('/elsewhere/PLAN.md', '/proj'), '/elsewhere/PLAN.md');
});

test('registry round-trips with sorted keys and leaves no .tmp files', () => {
  const { livedoc, cleanup } = tempRoot();
  try {
    const registry = new Registry(livedoc);
    registry.ensure();
    assert.deepEqual(registry.load(), []);
    assert.ok(existsSync(join(livedoc, 'sessions')));

    const row: SessionRecord = {
      id: 'plan-aabbccdd',
      file: '/proj/PLAN.md',
      relFile: 'PLAN.md',
      createdAt: 't0',
      lastActiveAt: 't0',
    };
    registry.upsert(row);
    assert.deepEqual(registry.load(), [row]);

    const raw = readFileSync(join(livedoc, 'sessions.json'), 'utf8');
    const keys = [...raw.matchAll(/^ {6}"(\w+)"/gm)].map((m) => m[1]);
    assert.deepEqual(keys, [...keys].sort(), 'record keys must be alphabetical');
    assert.ok(raw.endsWith('\n'));
    assert.ok(readdirSync(livedoc).every((f) => !f.endsWith('.tmp')));
  } finally {
    cleanup();
  }
});

test('upsert replaces by id, touch bumps lastActiveAt, remove drops the row', () => {
  const { livedoc, cleanup } = tempRoot();
  try {
    const registry = new Registry(livedoc);
    registry.ensure();
    const row: SessionRecord = {
      id: 'a-1', file: '/p/a.md', relFile: 'a.md', createdAt: 't0', lastActiveAt: 't0',
    };
    registry.upsert(row);
    registry.upsert({ ...row, file: '/p/moved.md' });
    assert.equal(registry.load().length, 1);
    assert.equal(registry.load()[0].file, '/p/moved.md');

    registry.touch('a-1', 't9');
    assert.equal(registry.load()[0].lastActiveAt, 't9');
    registry.touch('nope', 't9'); // unknown id is a no-op, not a crash

    registry.remove('a-1');
    assert.deepEqual(registry.load(), []);
  } finally {
    cleanup();
  }
});

test('the in-memory registry stays coherent with what is on disk', () => {
  const { livedoc, cleanup } = tempRoot();
  try {
    const registry = new Registry(livedoc);
    registry.ensure();
    const row: SessionRecord = {
      id: 'a-1', file: '/p/a.md', relFile: 'a.md', createdAt: 't0', lastActiveAt: '2026-01-01T00:00:00.000Z',
    };
    registry.upsert(row);

    // A second reader (a fresh daemon) sees everything the first one wrote.
    assert.deepEqual(new Registry(livedoc).load(), registry.load());

    registry.touch('a-1', '2026-01-01T00:00:30.000Z');
    assert.deepEqual(new Registry(livedoc).load()[0].lastActiveAt, '2026-01-01T00:00:30.000Z');

    // Same second: skipped, so a polling browser cannot rewrite the file.
    registry.touch('a-1', '2026-01-01T00:00:30.400Z');
    assert.equal(registry.load()[0].lastActiveAt, '2026-01-01T00:00:30.000Z');

    registry.remove('a-1');
    assert.deepEqual(new Registry(livedoc).load(), []);
  } finally {
    cleanup();
  }
});

test('ensure() writes a .gitignore covering per-session ephemera and the legacy layout', () => {
  const { livedoc, cleanup } = tempRoot();
  try {
    new Registry(livedoc).ensure();
    const ignore = readFileSync(join(livedoc, '.gitignore'), 'utf8');
    for (const line of [
      'daemon.json',
      'current',
      'sessions/*/revisions/',
      'sessions/*/pending.json',
      'session.json',
      'pending.json',
      'revisions/',
    ]) {
      assert.ok(ignore.includes(line), line);
    }
  } finally {
    cleanup();
  }
});

test('daemon info write/read/clear, falling back to a legacy session.json', () => {
  const { livedoc, cleanup } = tempRoot();
  try {
    const registry = new Registry(livedoc);
    registry.ensure();
    assert.equal(registry.readDaemon(), null);

    const info = { pid: 1, port: 4317, url: 'http://127.0.0.1:4317', startedAt: 't' };
    registry.writeDaemon(info);
    assert.deepEqual(registry.readDaemon(), info);
    registry.clearDaemon();
    assert.equal(registry.readDaemon(), null);
    registry.clearDaemon(); // idempotent

    // A pre-migration checkout still resolves through the legacy pointer.
    writeFileSync(join(livedoc, 'session.json'), JSON.stringify({ ...info, file: '/p.md' }));
    assert.equal(registry.readDaemon()?.port, 4317);
  } finally {
    cleanup();
  }
});

test('migrateFlatLayout moves flat state under sessions/<id>/ and is idempotent', () => {
  const { root, livedoc, cleanup } = tempRoot();
  try {
    mkdirSync(join(livedoc, 'revisions'), { recursive: true });
    writeFileSync(join(livedoc, 'comments.json'), '{"version":1,"notes":[]}');
    writeFileSync(join(livedoc, 'answers.json'), '{}');
    writeFileSync(join(livedoc, 'pending.json'), '[]');
    writeFileSync(join(livedoc, 'revisions', '001.md'), '# old draft');
    writeFileSync(join(livedoc, 'approved-2026-01-01.md'), '# frozen');
    writeFileSync(join(livedoc, 'session.json'), '{"pid":1}');

    const plan = join(root, 'PLAN.md');
    writeFileSync(plan, '# plan');

    const id = migrateFlatLayout(livedoc, plan);
    assert.equal(id, sessionIdFor(plan, root));

    const dir = sessionDir(livedoc, id!);
    for (const name of ['comments.json', 'answers.json', 'pending.json', 'approved-2026-01-01.md']) {
      assert.ok(existsSync(join(dir, name)), name);
      assert.ok(!existsSync(join(livedoc, name)), `${name} left behind`);
    }
    assert.equal(readFileSync(join(dir, 'revisions', '001.md'), 'utf8'), '# old draft');
    assert.ok(!existsSync(join(livedoc, 'session.json')), 'legacy pointer must be dropped');

    const rows = new Registry(livedoc).load();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, id);
    assert.equal(rows[0].file, plan);
    assert.equal(rows[0].relFile, 'PLAN.md');

    // Second run finds sessions.json and does nothing.
    assert.equal(migrateFlatLayout(livedoc, plan), null);
    assert.equal(new Registry(livedoc).load().length, 1);
  } finally {
    cleanup();
  }
});

test('resolveSessionId prefers --session, then the env var, then the pointer', () => {
  const { root, livedoc, cleanup } = tempRoot();
  const saved = process.env.LIVEDOC_SESSION;
  try {
    mkdirSync(livedoc, { recursive: true });
    delete process.env.LIVEDOC_SESSION;
    assert.equal(resolveSessionId(undefined, root), null);

    writeCurrentSession('from-pointer', root);
    assert.equal(resolveSessionId(undefined, root), 'from-pointer');

    // The env var wins so two agents in one repo cannot clobber each other.
    process.env.LIVEDOC_SESSION = 'from-env';
    assert.equal(resolveSessionId(undefined, root), 'from-env');
    assert.equal(resolveSessionId('explicit', root), 'explicit');

    delete process.env.LIVEDOC_SESSION;
    clearCurrentSession('someone-else', root); // only clears its own id
    assert.equal(resolveSessionId(undefined, root), 'from-pointer');
    clearCurrentSession('from-pointer', root);
    assert.equal(resolveSessionId(undefined, root), null);
    clearCurrentSession(undefined, root); // idempotent
  } finally {
    if (saved === undefined) delete process.env.LIVEDOC_SESSION;
    else process.env.LIVEDOC_SESSION = saved;
    cleanup();
  }
});

test('migrateFlatLayout is a no-op with nothing to migrate or no plan file', () => {
  const { root, livedoc, cleanup } = tempRoot();
  try {
    mkdirSync(livedoc, { recursive: true });
    assert.equal(migrateFlatLayout(livedoc, join(root, 'PLAN.md')), null);

    // Flat state present but no plan file to derive an id from: leave it alone.
    writeFileSync(join(livedoc, 'comments.json'), '{"version":1,"notes":[]}');
    assert.equal(migrateFlatLayout(livedoc, null), null);
    assert.ok(existsSync(join(livedoc, 'comments.json')));
    assert.ok(!existsSync(join(livedoc, 'sessions.json')));
  } finally {
    cleanup();
  }
});
