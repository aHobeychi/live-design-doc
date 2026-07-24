import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Answer, Block, Note, Question, Status } from '../types.js';
import { validateQuestions } from '../types.js';
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
  progress: Record<string, 'done'>;
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
    rebuild(ctx, content);
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
          `- [rev ${n.createdAgainstRevision}, ${n.resolved.fidelity}, ` +
            `${n.resolved.blockId ?? 'unanchored'}] "${n.quote}" — ${n.body}\n`
        );
      }
    }
    return parts.join('');
  };

  const routes: Record<string, (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> | void> = {
    'GET /api/doc': (_req, res) => json(res, 200, snapshot(state)),

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
      const note: Note = {
        id: 'n-' + Date.now().toString(36) + '-' + randomUUID().slice(0, 8),
        state: 'new',
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
      bus.wakeAgent({ status: 'feedback', revision: state.revision, notes: batch });
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
      if (done) state.progress[blockId] = 'done';
      else delete state.progress[blockId];
      const boxes = state.blocks.filter((b) => b.checkbox);
      if (boxes.length > 0 && boxes.every((b) => state.progress[b.id] === 'done')) {
        setStatus(ctx, 'done');
      }
      bus.broadcast('progress', { blockId, done });
      json(res, 200, { status: 'ok', progress: state.progress });
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
          const text = String(body.body ?? '').trim();
          if (!text) throw new HttpError(400, 'note body is empty');
          state.notes[idx].body = text;
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
