import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { validateQuestions } from '../types.js';
import { api, clearCurrentSession, emit, fail, resolveSessionId } from './api.js';

/** Every verb takes --session to address a plan other than the current one. */
const SESSION_OPTION = { session: { type: 'string' } } as const;

export async function push(args: string[] = []): Promise<void> {
  const { values } = parseArgs({ args, options: SESSION_OPTION });
  const result = await api('POST', '/api/reload', undefined, { session: values.session });
  emit(result);
}

export async function progress(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      did: { type: 'string' },
      files: { type: 'string' },
      ...SESSION_OPTION,
    },
  });
  const [blockId, state] = positionals;
  if (!blockId) {
    fail('usage: livedoc progress <block-id> [done|todo] --did "what you did" [--files a.ts,b.ts]');
  }
  const files = (values.files ?? '')
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);
  const result = await api(
    'POST',
    '/api/progress',
    { blockId, state: state ?? 'done', did: values.did ?? '', files },
    { session: values.session }
  );
  emit(result);
}

/** Plan-vs-reality check; exits 1 when tasks lack ticks so agents notice. */
export async function verify(args: string[] = []): Promise<void> {
  const { values } = parseArgs({ args, options: SESSION_OPTION });
  const result = await api<{ complete: boolean }>('GET', '/api/verify', undefined, {
    session: values.session,
  });
  emit(result);
  if (!result.complete) process.exit(1);
}

export async function ask(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: SESSION_OPTION,
  });
  const [file] = positionals;
  if (!file) fail('usage: livedoc ask <questions.json>');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    fail(`cannot read ${file}: ${(e as Error).message}`);
  }
  // Validate locally first so schema errors carry context, not an HTTP 400.
  try {
    validateQuestions(parsed);
  } catch (e) {
    fail((e as Error).message);
  }
  const result = await api('POST', '/api/questions', parsed, { session: values.session });
  emit(result);
}

/** The list of open plans — how an agent discovers ids for --session. */
export async function sessions(): Promise<void> {
  const result = await api('GET', '/api/sessions', undefined, { daemonLevel: true });
  emit(result);
}

/**
 * Closes the current session, leaving other plans (and any agent parked on
 * them) running. `--all` stops the daemon outright. With a single session open
 * the two are the same thing, so this matches the old behaviour exactly.
 */
export async function stop(args: string[] = []): Promise<void> {
  const { values } = parseArgs({ args, options: { all: { type: 'boolean' }, ...SESSION_OPTION } });
  if (!values.all) {
    const list = await api<{ sessions: { id: string }[]; default: string | null }>(
      'GET',
      '/api/sessions',
      undefined,
      { daemonLevel: true }
    );
    const asked = resolveSessionId(values.session);
    // A pointer left behind by an already-closed session must not become an
    // error: fall back to the daemon's default the way an absent one does.
    const target = asked && list.sessions.some((s) => s.id === asked) ? asked : list.default;
    if (target) {
      try {
        const result = await api<{ removed: string }>('DELETE', `/api/sessions/${target}`, undefined, {
          daemonLevel: true,
        });
        clearCurrentSession(result.removed);
        emit({ status: 'ok', stopped: 'session', session: result.removed, daemonStopped: false });
        return;
      } catch (e) {
        // The last session cannot be closed on its own: stopping it means
        // stopping the daemon, so fall through rather than fail.
        if (!/only session/.test((e as Error).message)) throw e;
      }
    }
  }
  await api('POST', '/api/shutdown', undefined, { daemonLevel: true });
  clearCurrentSession();
  emit({ status: 'ok', stopped: 'daemon', daemonStopped: true });
}
