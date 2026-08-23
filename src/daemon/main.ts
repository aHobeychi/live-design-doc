import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { Bus, Hub } from './events.js';
import { Store } from './store.js';
import {
  Registry,
  migrateFlatLayout,
  relFileFor,
  sessionDir,
  sessionIdFor,
} from './sessions.js';
import {
  createDaemonServer,
  rebuild,
  type DaemonCtx,
  type DaemonState,
  type SessionCtx,
} from './server.js';

const BASE_PORT = 4317;
const PORT_TRIES = 25;

function listenWithScan(server: Server, startPort: number): Promise<number> {
  return new Promise((resolvePort, reject) => {
    let port = startPort;
    let tries = 0;
    const attempt = () => {
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && startPort !== 0 && ++tries < PORT_TRIES) {
          port += 1;
          attempt();
        } else {
          reject(err);
        }
      };
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onError);
        const addr = server.address();
        resolvePort(typeof addr === 'object' && addr ? addr.port : port);
      });
    };
    attempt();
  });
}

/**
 * Build (or return) the session for one plan file. Registry rows and live
 * sessions are both keyed by the id derived from the path, so this is
 * idempotent — which is what lets `livedoc start` be re-run safely.
 */
function createSession(daemon: DaemonCtx, planFile: string): SessionCtx {
  const file = resolve(planFile);
  let id = sessionIdFor(file, daemon.root);
  const rows = daemon.registry.load();

  const existing = daemon.sessions.get(id);
  if (existing) return existing;

  // A slug+hash collision between two different plans would silently merge
  // them; suffix instead so each keeps its own state.
  const clash = rows.find((r) => r.id === id && resolve(r.file) !== file);
  if (clash) {
    let n = 2;
    while (rows.some((r) => r.id === `${id}-${n}`) || daemon.sessions.has(`${id}-${n}`)) n += 1;
    id = `${id}-${n}`;
  }

  const store = new Store(sessionDir(daemon.livedocDir, id));
  store.ensure();

  const readDocFile = (): string | null => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  };

  const state: DaemonState = {
    file,
    status: 'drafting',
    revision: 0,
    blocks: [],
    notes: store.loadComments(),
    answersFile: store.loadAnswers(),
    questions: null,
    progress: {},
    lastChanged: { changed: [], added: [] },
  };

  const bus = new Bus();
  bus.seedPending(store.loadPending());
  bus.onPendingChange = (pending) => store.savePending(pending);

  const ctx: SessionCtx = { id, state, bus, store, readDocFile, daemon };

  // A file with content at boot is the current draft: pick up the revision
  // counter where a previous session left it (design: idempotent start).
  const content = readDocFile();
  if (content && content.trim()) {
    state.revision = store.maxRevision() + 1;
    state.status = 'review';
    rebuild(ctx, content);
    store.saveRevision(state.revision, content);
  } else if (state.answersFile) {
    rebuild(ctx, '');
  }

  daemon.sessions.set(id, ctx);
  const now = new Date().toISOString();
  const previous = rows.find((r) => r.id === id);
  daemon.registry.upsert({
    id,
    file,
    relFile: relFileFor(file, daemon.root),
    createdAt: previous?.createdAt ?? now,
    lastActiveAt: now,
  });
  daemon.hub.broadcast('sessions', { id, created: !previous });
  return ctx;
}

/** Close a session: drop it from the daemon, keep its files on disk. */
function deleteSession(daemon: DaemonCtx, id: string): void {
  const ctx = daemon.sessions.get(id);
  if (!ctx) return;
  // Wakes any agent parked in `livedoc wait` with the shutdown signal it
  // already knows how to handle.
  ctx.bus.close();
  daemon.sessions.delete(id);
  daemon.registry.remove(id);
  daemon.hub.broadcast('sessions', { id, removed: true });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      file: { type: 'string' },
      dir: { type: 'string' },
      port: { type: 'string' },
    },
  });
  const livedocDir = resolve(values.dir ?? '.livedoc');
  const root = resolve(dirname(livedocDir));
  const file = values.file ? resolve(values.file) : null;

  // Before any Store exists, so the move happens once in one process and can
  // never race two terminals.
  migrateFlatLayout(livedocDir, file);
  const registry = new Registry(livedocDir);
  registry.ensure();

  const daemon: DaemonCtx = {
    sessions: new Map(),
    root,
    livedocDir,
    webDir: fileURLToPath(new URL('../web/', import.meta.url)),
    hub: new Hub(),
    registry,
    createSession: (planFile) => createSession(daemon, planFile),
    deleteSession: (id) => deleteSession(daemon, id),
    onShutdown: () => {
      for (const s of daemon.sessions.values()) s.bus.close();
      daemon.hub.close();
      server.close();
      registry.clearDaemon();
      process.exit(0);
    },
  };

  // Rehydrate every known session, then ensure the one we were launched for.
  // Both go through createSession, so a restart and a runtime create are the
  // same code path.
  for (const record of registry.load()) daemon.createSession(record.file);
  const session = file ? daemon.createSession(file) : null;

  const server = createDaemonServer(daemon);
  const port = await listenWithScan(server, values.port !== undefined ? Number(values.port) : BASE_PORT);
  const url = `http://127.0.0.1:${port}`;

  registry.writeDaemon({ pid: process.pid, port, url, startedAt: new Date().toISOString() });

  // The single readiness line the parent CLI waits for. Nothing else may be
  // written to stdout; the pipe closes when the parent exits.
  console.log(JSON.stringify({ port, url, session: session?.id ?? null }));
  process.stdout.on('error', () => {});

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => daemon.onShutdown());
  }
}

main().catch((e: Error) => {
  console.error(`livedoc daemon failed to start: ${e.message}`);
  process.exit(1);
});
