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
        resolve((JSON.parse(out.slice(0, nl)) as { url: string }).url);
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
  const doc = await req<{ notes: Note[] }>('GET', '/api/doc');
  assert.equal(doc.notes[0].resolved.fidelity, 'exact');
  assert.equal(doc.notes[0].resolved.blockId, 'p-scope');
});

test('comments.json survives on disk with the sent note', () => {
  const file = JSON.parse(readFileSync(join(dir, '.livedoc', 'comments.json'), 'utf8'));
  assert.equal(file.notes.length, 1);
  assert.equal(file.notes[0].state, 'sent');
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

test('progress ticks blocks; all boxes done → status done', async () => {
  await req('POST', '/api/progress', { blockId: 't-limiter' });
  let doc = await req<{ status: string }>('GET', '/api/doc');
  assert.equal(doc.status, 'executing');
  await req('POST', '/api/progress', { blockId: 't-wire' });
  doc = await req<{ status: string }>('GET', '/api/doc');
  assert.equal(doc.status, 'done');
});

test('shutdown stops the daemon', async () => {
  await req('POST', '/api/shutdown');
  await new Promise((r) => setTimeout(r, 300));
  await assert.rejects(fetch(url + '/api/doc', { signal: AbortSignal.timeout(1000) }));
});
