import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { listProjectFiles } from './files.js';
import { randomUUID } from 'node:crypto';
import type { Answer, Block, Note, NoteIntent, ProgressEntry, Question, Status } from '../types.js';
import { INTENT_PRIORITY, NOTE_INTENTS, validateQuestions } from '../types.js';
import { normalize } from '../doc/blocks.js';
import { parseDocument } from '../doc/ids.js';
import { reanchorAll } from '../doc/anchor.js';
import { renderBlock } from '../doc/render.js';
import { Bus } from './events.js';
import { Store, type AnswersFile } from './store.js';
import { assertTransition, TransitionError } from './session.js';

export interface DaemonState {
  file: string;
  status: Status;
  revision: number;
  blocks: Block[];
  notes: Note[];
  answersFile: AnswersFile | null;
  questions: Question[] | null;
  progress: Record<string, ProgressEntry>;
  /** Block ids the last push edited or introduced — the gentle diff. */
  lastChanged: { changed: string[]; added: string[] };
}

export interface Ctx {
  state: DaemonState;
  bus: Bus;
  store: Store;
  webDir: string;
  readDocFile: () => string | null;
  onShutdown: () => void;
}

class HttpError extends Error {
  constructor(
    public readonly code: number,
    message: string
  ) {
    super(message);
  }
}

/**
 * The clarify answers render as normal blocks with `a-` ids (design §5.6):
 * the server synthesizes them from answers.json, so the agent has no write
 * path to what the human said, and each answer gets anchoring and notes free.
 */
function answerBlocks(af: AnswersFile | null): Block[] {
  if (!af || af.answers.length === 0) return [];
  const mk = (id: string, text: string, extra: Partial<Block> = {}): Block => ({
    id,
    type: 'paragraph',
    text,
    normalized: normalize(text),
    ...extra,
  });
  const blocks: Block[] = [
    mk('a-before', '## Before we started', { type: 'heading', level: 2 }),
  ];
  for (const a of af.answers) {
    const q = af.questions.find((x) => x.id === a.id);
    const values = Array.isArray(a.value) ? a.value : [a.value];
    const labels = values.map(
      (v) => q?.options?.find((o) => o.value === v)?.label ?? v
    );
    blocks.push(mk(`a-${a.id}`, `**${q?.prompt ?? a.id}** — ${labels.join(', ')}`));
  }
  return blocks;
}

export function rebuild(ctx: Ctx, markdown: string): void {
  const { state } = ctx;
  state.blocks = [...answerBlocks(state.answersFile), ...parseDocument(markdown)];
  reanchorAll(state.notes, state.blocks);
}

function snapshot(state: DaemonState) {
  return {
    status: state.status,
    revision: state.revision,
    file: state.file,
    blocks: state.blocks.map((b) => ({ ...b, html: renderBlock(b) })),
    notes: state.notes,
    questions: state.questions,
    answers: state.answersFile?.answers ?? [],
    progress: state.progress,
    lastChanged: state.lastChanged,
  };
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

function json(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

function setStatus(ctx: Ctx, to: Status): void {
  if (ctx.state.status === to) return;
  assertTransition(ctx.state.status, to);
  ctx.state.status = to;
  ctx.bus.broadcast('status', { status: to });
}

/** DNS-rebinding guard: the one security measure a loopback tool needs. */
function hostAllowed(req: IncomingMessage): boolean {
  try {
    const host = new URL(`http://${req.headers.host ?? ''}`).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

export function createDaemonServer(ctx: Ctx): Server {
  const { state, bus, store } = ctx;

  const doReload = (): number => {
    const content = ctx.readDocFile();
    if (content === null) throw new HttpError(400, `cannot read ${state.file}`);
    if (!content.trim()) throw new HttpError(400, `${state.file} is empty`);
    setStatus(ctx, 'review');
    state.questions = null;
    state.revision += 1;
    const before = new Map(state.blocks.map((b) => [b.id, b.normalized]));
    rebuild(ctx, content);
    // The gentle diff: which blocks this push edited or introduced. No
    // per-word diffing (PRD non-goal) — just "the agent touched this".
    state.lastChanged = { changed: [], added: [] };
    for (const b of state.blocks) {
      if (!before.has(b.id)) state.lastChanged.added.push(b.id);
      else if (before.get(b.id) !== b.normalized) state.lastChanged.changed.push(b.id);
    }
    store.saveRevision(state.revision, content);
    store.saveComments(state.notes);
    bus.broadcast('revision', { revision: state.revision });
    return state.revision;
  };

  const composeApproved = (): string => {
    const content = ctx.readDocFile() ?? '';
    const parts: string[] = [];
    const af = state.answersFile;
    if (af && af.answers.length > 0) {
      parts.push('## Before we started\n');
      for (const b of answerBlocks(af).slice(1)) parts.push(b.text + '\n');
      parts.push('\n---\n');
    }
    parts.push(content.trimEnd() + '\n');
    if (state.notes.length > 0) {
      parts.push('\n---\n\n## Review notes\n');
      for (const n of state.notes) {
        parts.push(
          `- [rev ${n.createdAgainstRevision}, ${n.intent}, ${n.resolved.fidelity}, ` +
            `${n.resolved.blockId ?? 'unanchored'}] ${n.quote ? `"${n.quote}"` : '(whole block)'} — ${n.body}` +
            (n.suggestion ? ` (suggested: "${n.suggestion}")` : '') +
            '\n'
        );
      }
    }
    return parts.join('');
  };

  const routes: Record<string, (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> | void> = {
    'GET /api/doc': (_req, res) => json(res, 200, snapshot(state)),

    // Project file paths for @-mentions in notes. The project root is the
    // directory that owns .livedoc/.
    'GET /api/files': (_req, res) => json(res, 200, { files: listProjectFiles(dirname(store.dir)) }),

    // Timeline of every draft with the notes written against each — the
    // browsable record of why the plan ended up the way it did.
    'GET /api/history': (_req, res) => {
      const revisions = store.listRevisions().map((n) => ({
        revision: n,
        current: n === state.revision,
        notes: state.notes
          .filter((x) => x.createdAgainstRevision === n)
          .map(({ id, quote, body, intent, state: noteState, suggestion, blockId }) => ({
            id,
            quote,
            body,
            intent,
            state: noteState,
            suggestion,
            blockId,
          })),
      }));
      json(res, 200, { current: state.revision, revisions });
    },

    'GET /api/revision': (_req, res, url) => {
      const n = Number(url.searchParams.get('n'));
      const md = Number.isInteger(n) ? store.loadRevision(n) : null;
      if (md === null) throw new HttpError(404, `no revision ${url.searchParams.get('n')}`);
      json(res, 200, {
        revision: n,
        blocks: parseDocument(md).map((b) => ({ ...b, html: renderBlock(b) })),
      });
    },

    'GET /api/events': (_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      bus.addClient(res);
    },

    'GET /api/wait': async (req, res, url) => {
      const timeout = Math.min(600, Math.max(1, Number(url.searchParams.get('timeout')) || 300));
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      // Whitespace keepalive defeats intermediary/undici idle timeouts; leading
      // whitespace is valid JSON, callers parse text.trim().
      const keepalive = setInterval(() => res.write(' '), 20_000);
      keepalive.unref();
      const result = await bus.wait(timeout);
      clearInterval(keepalive);
      if ((res.destroyed || res.writableEnded) && result.status !== 'timeout') {
        bus.requeue(result);
        return;
      }
      if (result.status === 'feedback') {
        const ids = new Set(result.notes.map((n) => n.id));
        for (const n of state.notes) if (ids.has(n.id)) n.seenByAgent = true;
        store.saveComments(state.notes);
      }
      res.end(JSON.stringify(result));
    },

    'POST /api/comments': async (req, res) => {
      const body = await readBody(req);
      const blockId = String(body.blockId ?? '');
      const block = state.blocks.find((b) => b.id === blockId);
      if (!block) throw new HttpError(404, `no block with id "${blockId}"`);
      const text = String(body.body ?? '').trim();
      if (!text) throw new HttpError(400, 'note body is empty');
      const suggestion = String(body.suggestion ?? '').trim();
      const note: Note = {
        id: 'n-' + Date.now().toString(36) + '-' + randomUUID().slice(0, 8),
        state: 'new',
        intent: NOTE_INTENTS.includes(body.intent as NoteIntent) ? (body.intent as NoteIntent) : 'change',
        ...(suggestion ? { suggestion } : {}),
        body: text,
        quote: String(body.quote ?? ''),
        contextBefore: String(body.contextBefore ?? ''),
        contextAfter: String(body.contextAfter ?? ''),
        blockId,
        blockTextAtCreation: block.text,
        createdAgainstRevision: state.revision,
        resolved: { blockId, fidelity: 'exact' },
        seenByAgent: false,
      };
      state.notes.push(note);
      store.saveComments(state.notes);
      bus.broadcast('note', { id: note.id });
      json(res, 200, note);
    },

    'POST /api/send': (_req, res) => {
      const batch = state.notes.filter((n) => n.state === 'new');
      if (batch.length === 0) throw new HttpError(400, 'no unsent notes');
      for (const n of batch) n.state = 'sent';
      store.saveComments(state.notes);
      bus.broadcast('note', { sent: batch.length });
      // Blockers first, nits last — the agent addresses them in this order.
      const ordered = [...batch].sort((a, b) => INTENT_PRIORITY[a.intent] - INTENT_PRIORITY[b.intent]);
      bus.wakeAgent({ status: 'feedback', revision: state.revision, notes: ordered });
      json(res, 200, { status: 'ok', sent: batch.length });
    },

    'POST /api/approve': (_req, res) => {
      if (state.status !== 'review') {
        throw new HttpError(409, `cannot approve from status "${state.status}"`);
      }
      const approvedPath = store.saveApproved(composeApproved());
      setStatus(ctx, 'approved');
      bus.wakeAgent({ status: 'approved', approvedPath });
      json(res, 200, { status: 'ok', approvedPath });
    },

    'POST /api/reload': (_req, res) => {
      const revision = doReload();
      json(res, 200, { status: 'ok', revision });
    },

    'POST /api/progress': async (req, res) => {
      const body = await readBody(req);
      const blockId = String(body.blockId ?? '');
      const done = body.state !== 'todo';
      if (!state.blocks.some((b) => b.id === blockId)) {
        throw new HttpError(404, `no block with id "${blockId}"`);
      }
      if (state.status === 'approved') setStatus(ctx, 'executing');
      if (state.status !== 'executing') {
        throw new HttpError(409, `progress requires an approved plan (status is "${state.status}")`);
      }
      if (done) {
        // A tick is an auditable claim, not a checkbox: evidence is required.
        const did = String(body.did ?? '').trim();
        if (!did) {
          throw new HttpError(400, 'evidence required: pass --did "what you actually did" (and --files touched,paths)');
        }
        const files = Array.isArray(body.files) ? body.files.map(String).filter(Boolean) : [];
        state.progress[blockId] = { state: 'done', did, files, at: new Date().toISOString() };
      } else {
        delete state.progress[blockId];
      }
      const boxes = state.blocks.filter((b) => b.checkbox);
      if (boxes.length > 0 && boxes.every((b) => state.progress[b.id])) {
        setStatus(ctx, 'done');
      }
      bus.broadcast('progress', { blockId, done });
      json(res, 200, { status: 'ok', progress: state.progress });
    },

    // Plan-vs-reality: every task block with its tick and evidence. The
    // agent runs `livedoc verify` before calling the build finished.
    'GET /api/verify': (_req, res) => {
      const tasks = state.blocks
        .filter((b) => b.checkbox)
        .map((b) => ({
          id: b.id,
          text: b.text,
          done: Boolean(state.progress[b.id]) || b.checkbox === 'done',
          ...(state.progress[b.id] ?? {}),
        }));
      const undone = tasks.filter((t) => !t.done).map((t) => t.id);
      json(res, 200, {
        complete: tasks.length > 0 && undone.length === 0,
        total: tasks.length,
        undone,
        tasks,
      });
    },

    // Read-only peek at a project file for @-reference previews. Path must
    // resolve inside the project root — traversal is refused.
    'GET /api/file': (_req, res, url) => {
      const rel = url.searchParams.get('path') ?? '';
      const root = resolve(dirname(store.dir));
      const full = resolve(root, rel);
      if (!rel || !full.startsWith(root + sep)) throw new HttpError(400, 'path outside project');
      let content: string;
      try {
        if (statSync(full).size > 512_000) throw new Error('too large');
        content = readFileSync(full, 'utf8');
      } catch {
        throw new HttpError(404, `cannot read ${rel}`);
      }
      const lines = content.split('\n');
      const MAX = 160;
      json(res, 200, {
        path: rel,
        content: lines.slice(0, MAX).join('\n'),
        truncated: lines.length > MAX,
        lines: lines.length,
      });
    },

    'POST /api/questions': async (req, res) => {
      const body = await readBody(req);
      if (state.revision > 0) {
        throw new HttpError(409, 'a draft already exists — write forks into Open questions instead of asking (design §5.7)');
      }
      let questions: Question[];
      try {
        questions = validateQuestions(body);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      state.questions = questions;
      setStatus(ctx, 'clarifying');
      bus.broadcast('questions', { count: questions.length });
      json(res, 200, { status: 'ok', count: questions.length });
    },

    'POST /api/answers': async (req, res) => {
      const body = await readBody(req);
      if (state.status !== 'clarifying' || !state.questions) {
        throw new HttpError(409, 'no question set is open');
      }
      const raw = Array.isArray(body.answers) ? (body.answers as Answer[]) : [];
      const answers = raw.filter(
        (a) => a && typeof a.id === 'string' && state.questions!.some((q) => q.id === a.id)
      );
      state.answersFile = {
        questions: state.questions,
        answers,
        answeredAt: new Date().toISOString(),
      };
      store.saveAnswers(state.answersFile);
      state.questions = null;
      setStatus(ctx, 'drafting');
      bus.wakeAgent({ status: 'answers', answers });
      json(res, 200, { status: 'ok', answered: answers.length });
    },

    'DELETE /api/comments': () => {
      throw new HttpError(404, 'note id required');
    },

    'POST /api/shutdown': (_req, res) => {
      json(res, 200, { status: 'ok' });
      bus.wakeAgent({ status: 'shutdown' });
      setTimeout(() => ctx.onShutdown(), 50);
    },
  };

  const staticFiles: Record<string, { file: string; type: string }> = {
    '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
    '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
    '/margin.js': { file: 'margin.js', type: 'text/javascript; charset=utf-8' },
  };

  return createServer(async (req, res) => {
    try {
      if (!hostAllowed(req)) throw new HttpError(403, 'forbidden host');
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');

      const noteMatch = /^\/api\/comments\/([\w-]+)$/.exec(url.pathname);
      if (noteMatch && (req.method === 'DELETE' || req.method === 'PATCH')) {
        const idx = state.notes.findIndex((n) => n.id === noteMatch[1]);
        if (idx < 0) throw new HttpError(404, 'no such note');
        if (state.notes[idx].state !== 'new') {
          throw new HttpError(409, 'sent notes are never edited or deleted (design §7.2)');
        }
        if (req.method === 'DELETE') {
          state.notes.splice(idx, 1);
        } else {
          const body = await readBody(req);
          const note = state.notes[idx];
          if (body.body !== undefined) {
            const text = String(body.body).trim();
            if (!text) throw new HttpError(400, 'note body is empty');
            note.body = text;
          }
          if (body.intent !== undefined && NOTE_INTENTS.includes(body.intent as NoteIntent)) {
            note.intent = body.intent as NoteIntent;
          }
          if (body.suggestion !== undefined) {
            const s = String(body.suggestion).trim();
            if (s) note.suggestion = s;
            else delete note.suggestion;
          }
        }
        store.saveComments(state.notes);
        bus.broadcast('note', { [req.method === 'DELETE' ? 'deleted' : 'edited']: noteMatch[1] });
        return json(res, 200, req.method === 'DELETE' ? { status: 'ok' } : state.notes[idx]);
      }

      const fixed = staticFiles[url.pathname];
      if (req.method === 'GET' && fixed) {
        const content = readFileSync(join(ctx.webDir, fixed.file));
        res.writeHead(200, { 'content-type': fixed.type, 'cache-control': 'no-store' });
        return void res.end(content);
      }

      const handler = routes[`${req.method} ${url.pathname}`];
      if (!handler) throw new HttpError(404, `no route ${req.method} ${url.pathname}`);
      await handler(req, res, url);
    } catch (e) {
      const code = e instanceof HttpError ? e.code : e instanceof TransitionError ? 409 : 500;
      if (!res.headersSent) json(res, code, { error: (e as Error).message, status: state.status });
      else res.end();
    }
  });
}
