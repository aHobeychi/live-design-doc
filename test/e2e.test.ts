import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Note, WaitResult } from '../src/types.js';

const daemonPath = fileURLToPath(new URL('../src/daemon/main.js', import.meta.url));

let dir: string;
let planPath: string;
let child: ChildProcess;
let url: string;
let sessionId: string;

const PLAN = `# Rate limiter plan

The limiter covers 100 req/min per key, backed by Redis. {#p-scope}

## Tasks

- [ ] Add RateLimiter class {#t-limiter}
- [ ] Wire into /v1/search {#t-wire}
`;

async function req<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(url + path, {
    method,
    ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
  const text = (await res.text()).trim();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'livedoc-e2e-'));
  planPath = join(dir, 'PLAN.md');
  writeFileSync(planPath, PLAN);
  child = spawn(process.execPath, [daemonPath, '--file', planPath, '--dir', join(dir, '.livedoc'), '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  url = await new Promise<string>((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(() => reject(new Error(`daemon boot timeout\n${err}`)), 5000);
    child.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      const nl = out.indexOf('\n');
      if (nl >= 0) {
        clearTimeout(timer);
        const boot = JSON.parse(out.slice(0, nl)) as { url: string; session: string };
        sessionId = boot.session;
        resolve(boot.url);
      }
    });
    child.stderr!.on('data', (d: Buffer) => (err += d.toString()));
    child.on('exit', (code) => reject(new Error(`daemon exited ${code}\n${err}`)));
  });
});

after(() => {
  child.kill();
  rmSync(dir, { recursive: true, force: true });
});

test('boot: file with content lands in review at revision 1', async () => {
  const doc = await req<{ status: string; revision: number; blocks: { id: string }[] }>('GET', '/api/doc');
  assert.equal(doc.status, 'review');
  assert.equal(doc.revision, 1);
  assert.ok(doc.blocks.some((b) => b.id === 't-limiter'));
});

test('file list for @-mentions includes the plan and hides .livedoc', async () => {
  const { files } = await req<{ files: string[] }>('GET', '/api/files');
  assert.ok(files.includes('PLAN.md'));
  assert.ok(files.every((f) => !f.startsWith('.livedoc')));
});

test('wait returns the timeout sentinel with a fast timeout', async () => {
  const t0 = Date.now();
  const result = await req<WaitResult>('GET', '/api/wait?timeout=1');
  assert.deepEqual(result, { status: 'timeout' });
  assert.ok(Date.now() - t0 < 3000);
});

test('ask is rejected once a revision exists', async () => {
  await assert.rejects(
    req('POST', '/api/questions', {
      questions: [{ id: 'q1', prompt: 'x?', kind: 'text' }],
    }),
    /draft already exists/
  );
});

test('unsent notes can be edited and deleted', async () => {
  const note = await req<Note>('POST', '/api/comments', {
    blockId: 't-wire',
    quote: 'Wire into',
    body: 'first draft of this note',
  });
  const edited = await req<Note>('PATCH', `/api/comments/${note.id}`, { body: 'reworded note' });
  assert.equal(edited.body, 'reworded note');
  const doc = await req<{ notes: Note[] }>('GET', '/api/doc');
  assert.equal(doc.notes.find((n) => n.id === note.id)?.body, 'reworded note');
  await req('DELETE', `/api/comments/${note.id}`);
});

test('comment → send → wait delivers the batch even though wait started later', async () => {
  const note = await req<Note>('POST', '/api/comments', {
    blockId: 'p-scope',
    quote: '100 req/min',
    contextBefore: 'covers ',
    contextAfter: ' per key',
    body: 'Should be 60, and per user not per key',
  });
  assert.equal(note.state, 'new');
  await req('POST', '/api/send');
  // The send happened before this wait: the event must be queued, not lost.
  const result = await req<WaitResult>('GET', '/api/wait?timeout=5');
  assert.equal(result.status, 'feedback');
  assert.equal((result as { notes: Note[] }).notes.length, 1);
  assert.equal((result as { notes: Note[] }).notes[0].body, 'Should be 60, and per user not per key');
});

test('sent notes are immutable: edit and delete both refuse', async () => {
  const doc = await req<{ notes: Note[] }>('GET', '/api/doc');
  const sent = doc.notes.find((n) => n.state === 'sent')!;
  await assert.rejects(req('PATCH', `/api/comments/${sent.id}`, { body: 'rewrite history' }), /never edited/);
  await assert.rejects(req('DELETE', `/api/comments/${sent.id}`), /never edited/);
});

test('reload re-anchors: kept id but reworded → exact via quote in same block', async () => {
  writeFileSync(
    planPath,
    PLAN.replace('covers 100 req/min per key, backed by Redis', 'now covers 100 req/min per user, backed by Redis')
  );
  const r = await req<{ revision: number }>('POST', '/api/reload');
  assert.equal(r.revision, 2);
  const doc = await req<{ notes: Note[]; lastChanged: { changed: string[]; added: string[] } }>(
    'GET',
    '/api/doc'
  );
  assert.equal(doc.notes[0].resolved.fidelity, 'exact');
  assert.equal(doc.notes[0].resolved.blockId, 'p-scope');
  // The gentle diff: exactly the reworded block is flagged, nothing else.
  assert.deepEqual(doc.lastChanged, { changed: ['p-scope'], added: [] });
});

test('file preview serves project files and refuses traversal', async () => {
  const f = await req<{ content: string; lines: number }>('GET', '/api/file?path=PLAN.md');
  assert.ok(f.content.includes('# Rate limiter plan'));
  await assert.rejects(req('GET', '/api/file?path=../../etc/passwd'), /outside project/);
  await assert.rejects(req('GET', '/api/file?path=nope.md'), /cannot read/);
});

test('intents order the feedback batch blockers-first; suggestions ride along', async () => {
  await req('POST', '/api/comments', {
    blockId: 't-wire',
    quote: 'Wire into',
    body: 'style nit on naming',
    intent: 'nit',
  });
  await req('POST', '/api/comments', {
    blockId: 't-limiter',
    quote: 'RateLimiter class',
    body: 'wrong store entirely',
    intent: 'blocker',
    suggestion: 'Add RateLimiter backed by Memcached',
  });
  const bad = await req<Note>('POST', '/api/comments', {
    blockId: 't-wire',
    quote: 'Wire',
    body: 'x',
    intent: 'not-a-real-intent',
  });
  assert.equal(bad.intent, 'change'); // unknown intents degrade to the default
  await req('DELETE', `/api/comments/${bad.id}`);

  await req('POST', '/api/send');
  const result = await req<WaitResult>('GET', '/api/wait?timeout=5');
  assert.equal(result.status, 'feedback');
  const notes = (result as { notes: Note[] }).notes;
  assert.deepEqual(
    notes.map((n) => n.intent),
    ['blocker', 'nit']
  );
  assert.equal(notes[0].suggestion, 'Add RateLimiter backed by Memcached');
});

test('history lists every revision with its notes; old revisions render read-only', async () => {
  const h = await req<{
    current: number;
    revisions: { revision: number; current: boolean; notes: { body: string }[] }[];
  }>('GET', '/api/history');
  assert.equal(h.current, 2);
  assert.deepEqual(h.revisions.map((r) => r.revision), [1, 2]);
  const rev2 = h.revisions.find((r) => r.revision === 2)!;
  assert.ok(rev2.current);
  assert.ok(rev2.notes.some((n) => n.body === 'wrong store entirely'));

  const old = await req<{ revision: number; blocks: { id: string; text: string }[] }>(
    'GET',
    '/api/revision?n=1'
  );
  // Revision 1 predates the rewording that produced revision 2.
  const scope = old.blocks.find((b) => b.id === 'p-scope')!;
  assert.ok(scope.text.includes('covers 100 req/min per key'));
  await assert.rejects(req('GET', '/api/revision?n=99'), /no revision/);
});

test('comments.json survives on disk under the session directory', () => {
  const file = JSON.parse(
    readFileSync(join(dir, '.livedoc', 'sessions', sessionId, 'comments.json'), 'utf8')
  );
  assert.equal(file.notes.length, 3);
  assert.ok(file.notes.every((n: Note) => n.state === 'sent'));
});

test('approve freezes the plan with notes appended and wakes the agent', async () => {
  const approve = await req<{ approvedPath: string }>('POST', '/api/approve');
  assert.ok(existsSync(approve.approvedPath));
  const frozen = readFileSync(approve.approvedPath, 'utf8');
  assert.ok(frozen.includes('Rate limiter plan'));
  assert.ok(frozen.includes('Should be 60'));
  const woke = await req<WaitResult>('GET', '/api/wait?timeout=5');
  assert.equal(woke.status, 'approved');
});

test('progress requires evidence; verify tracks plan-vs-reality to done', async () => {
  // A tick without evidence is refused — a checkbox is not a claim.
  await assert.rejects(req('POST', '/api/progress', { blockId: 't-limiter' }), /evidence required/);

  await req('POST', '/api/progress', {
    blockId: 't-limiter',
    did: 'Added RateLimiter with sliding window',
    files: ['src/limiter.ts', 'test/limiter.test.ts'],
  });
  let doc = await req<{ status: string }>('GET', '/api/doc');
  assert.equal(doc.status, 'executing');

  const mid = await req<{ complete: boolean; undone: string[]; tasks: { id: string; did?: string }[] }>(
    'GET',
    '/api/verify'
  );
  assert.equal(mid.complete, false);
  assert.deepEqual(mid.undone, ['t-wire']);
  assert.equal(mid.tasks.find((t) => t.id === 't-limiter')?.did, 'Added RateLimiter with sliding window');

  await req('POST', '/api/progress', { blockId: 't-wire', did: 'Wired into search route' });
  doc = await req<{ status: string }>('GET', '/api/doc');
  assert.equal(doc.status, 'done');
  const end = await req<{ complete: boolean }>('GET', '/api/verify');
  assert.equal(end.complete, true);
});

// ---- multiple sessions in one daemon ---------------------------------------

interface SessionRow {
  id: string;
  name: string;
  title: string | null;
  status: string;
  revision: number;
  unsentNotes: number;
  attention: boolean;
  missing: boolean;
}

let secondId: string;

test('a second plan becomes its own session without disturbing the first', async () => {
  const second = join(dir, 'PLAN2.md');
  writeFileSync(second, '# Second plan\n\nSomething else entirely. {#p-two}\n');
  const created = await req<SessionRow & { created: boolean }>('POST', '/api/sessions', { file: second });
  assert.equal(created.created, true);
  secondId = created.id;
  assert.notEqual(secondId, sessionId);

  const list = await req<{ sessions: SessionRow[] }>('GET', '/api/sessions');
  assert.equal(list.sessions.length, 2);
  const row = list.sessions.find((s) => s.id === secondId)!;
  assert.equal(row.name, 'PLAN2.md');
  assert.equal(row.title, 'Second plan', 'the H1 labels the session');
  assert.equal(row.missing, false);

  // The first session kept everything: this is the regression the whole
  // feature exists for — starting a second plan used to wipe the first.
  const first = list.sessions.find((s) => s.id === sessionId)!;
  assert.equal(first.status, 'done');
  assert.ok(first.revision >= 1);
});

test('POST /api/sessions is idempotent — the same plan returns the same session', async () => {
  const again = await req<SessionRow & { created: boolean }>('POST', '/api/sessions', {
    file: join(dir, 'PLAN2.md'),
  });
  assert.equal(again.created, false);
  assert.equal(again.id, secondId);
  const list = await req<{ sessions: SessionRow[] }>('GET', '/api/sessions');
  assert.equal(list.sessions.length, 2);
});

test('each session serves its own document, with no cross-contamination', async () => {
  const one = await req<{ blocks: { id: string }[] }>('GET', `/api/s/${sessionId}/doc`);
  const two = await req<{ blocks: { id: string }[] }>('GET', `/api/s/${secondId}/doc`);
  assert.ok(one.blocks.some((b) => b.id === 'p-scope'));
  assert.ok(!one.blocks.some((b) => b.id === 'p-two'));
  assert.ok(two.blocks.some((b) => b.id === 'p-two'));
  assert.ok(!two.blocks.some((b) => b.id === 'p-scope'));
});

test('an unknown session id is a 404 carrying a null status', async () => {
  const res = await fetch(url + '/api/s/no-such-session/doc');
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: string; status: null };
  assert.match(body.error, /no session "no-such-session"/);
  assert.equal(body.status, null);
});

// The acceptance test for independent agent loops: a browser switching to one
// plan must never disturb an agent parked on another.
test('a wait parked on one session is untouched by feedback sent on another', async () => {
  const parked = req<WaitResult>('GET', `/api/s/${secondId}/wait?timeout=2`);

  const doc = await req<{ blocks: { id: string }[] }>('GET', `/api/s/${sessionId}/doc`);
  await req('POST', `/api/s/${sessionId}/comments`, {
    blockId: doc.blocks[0].id,
    body: 'a note on the first plan',
    quote: '',
  });
  await req('POST', `/api/s/${sessionId}/send`);

  // Session two's agent stays asleep and times out...
  assert.deepEqual(await parked, { status: 'timeout' });
  // ...while session one's feedback was queued for its own agent all along.
  const own = await req<WaitResult>('GET', `/api/s/${sessionId}/wait?timeout=2`);
  assert.equal(own.status, 'feedback');
});

test('a deleted plan file is flagged missing but the session still opens', async () => {
  rmSync(join(dir, 'PLAN2.md'));
  const list = await req<{ sessions: SessionRow[] }>('GET', '/api/sessions');
  assert.equal(list.sessions.find((s) => s.id === secondId)?.missing, true);
  // The record outlives the file: blocks and notes are still served.
  const doc = await req<{ blocks: unknown[] }>('GET', `/api/s/${secondId}/doc`);
  assert.ok(doc.blocks.length > 0);
  await assert.rejects(req('POST', `/api/s/${secondId}/reload`), /cannot read/);
});

test('closing a session keeps its files; the last one refuses to close', async () => {
  const removed = await req<{ removed: string; filesKept: boolean }>(
    'DELETE',
    `/api/sessions/${secondId}`
  );
  assert.equal(removed.removed, secondId);
  assert.equal(removed.filesKept, true);
  assert.ok(
    existsSync(join(dir, '.livedoc', 'sessions', secondId)),
    'the committed record must outlive the live session'
  );

  const list = await req<{ sessions: SessionRow[] }>('GET', '/api/sessions');
  assert.equal(list.sessions.length, 1);
  await assert.rejects(req('DELETE', `/api/sessions/${sessionId}`), /only session/);
});

test('shutdown stops the daemon', async () => {
  await req('POST', '/api/shutdown');
  await new Promise((r) => setTimeout(r, 300));
  await assert.rejects(fetch(url + '/api/doc', { signal: AbortSignal.timeout(1000) }));
});
