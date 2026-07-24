import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { Bus } from './events.js';
import { Store } from './store.js';
import { createDaemonServer, rebuild, type Ctx, type DaemonState } from './server.js';

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

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      file: { type: 'string' },
      dir: { type: 'string' },
      port: { type: 'string' },
    },
  });
  if (!values.file) throw new Error('--file is required');
  const file = resolve(values.file);
  const dir = resolve(values.dir ?? '.livedoc');

  const store = new Store(dir);
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

  const ctx: Ctx = {
    state,
    bus,
    store,
    webDir: fileURLToPath(new URL('../web/', import.meta.url)),
    readDocFile,
    onShutdown: () => {
      bus.close();
      server.close();
      store.clearSession();
      process.exit(0);
    },
  };

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

  const server = createDaemonServer(ctx);
  const port = await listenWithScan(server, values.port !== undefined ? Number(values.port) : BASE_PORT);
  const url = `http://127.0.0.1:${port}`;

  store.writeSession({
    pid: process.pid,
    port,
    url,
    file,
    startedAt: new Date().toISOString(),
  });

  // The single readiness line the parent CLI waits for. Nothing else may be
  // written to stdout; the pipe closes when the parent exits.
  console.log(JSON.stringify({ port, url }));
  process.stdout.on('error', () => {});

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => ctx.onShutdown());
  }
}

main().catch((e: Error) => {
  console.error(`livedoc daemon failed to start: ${e.message}`);
  process.exit(1);
});
