import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DaemonInfo } from '../types.js';

export const LIVEDOC_DIR = '.livedoc';

export function livedocDir(cwd = process.cwd()): string {
  return join(resolve(cwd), LIVEDOC_DIR);
}

/** @deprecated The daemon pointer is .livedoc/daemon.json; kept for one release. */
export function sessionPath(cwd = process.cwd()): string {
  return join(livedocDir(cwd), 'session.json');
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** The running daemon, falling back to a pre-multi-session session.json. */
export function readDaemon(cwd = process.cwd()): DaemonInfo | null {
  return (
    readJson<DaemonInfo>(join(livedocDir(cwd), 'daemon.json')) ??
    readJson<DaemonInfo>(sessionPath(cwd))
  );
}

/** @deprecated Use readDaemon; the daemon is no longer tied to one plan file. */
export const readSession = readDaemon;

/**
 * Which session a command targets. The env var wins so a long-running agent
 * terminal can pin its session for life: two agents in one repo would otherwise
 * clobber each other's `.livedoc/current`. Falling through to null means "the
 * daemon's default session", which keeps single-session use working untouched.
 */
export function resolveSessionId(explicit?: string, cwd = process.cwd()): string | null {
  if (explicit) return explicit;
  const env = process.env.LIVEDOC_SESSION?.trim();
  if (env) return env;
  try {
    return readFileSync(join(livedocDir(cwd), 'current'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function writeCurrentSession(id: string, cwd = process.cwd()): void {
  try {
    writeFileSync(join(livedocDir(cwd), 'current'), id + '\n');
  } catch {
    /* the pointer is a convenience; --session and $LIVEDOC_SESSION still work */
  }
}

/**
 * Drop the pointer once its session is gone, so the next command falls back to
 * the daemon's default instead of naming a session that no longer exists.
 * With an id, only clears the pointer when it still names that session.
 */
export function clearCurrentSession(id?: string, cwd = process.cwd()): void {
  try {
    if (id && resolveSessionId(undefined, cwd) !== id) return;
    rmSync(join(livedocDir(cwd), 'current'));
  } catch {
    /* already gone */
  }
}

export class DaemonUnreachable extends Error {
  constructor() {
    super('livedoc daemon is not running here — run `livedoc start <plan.md>` first');
  }
}

/** Probe a daemon for liveness; a pid alone can be recycled, so probe HTTP. */
export async function probe(daemon: DaemonInfo): Promise<boolean> {
  try {
    // Session-independent, so this still answers with zero sessions open.
    const res = await fetch(`${daemon.url}/api/sessions`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Address one session: /api/foo -> /api/s/<id>/foo. */
export function sessionPathFor(path: string, id: string | null): string {
  if (!id || !path.startsWith('/api/')) return path;
  return `/api/s/${id}${path.slice(4)}`;
}

export async function api<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  opts: {
    timeoutMs?: number;
    session?: string;
    /** Route is about the daemon, not one session — never prefixed. */
    daemonLevel?: boolean;
    /** Session route, deliberately left to the daemon's default session. */
    unscoped?: boolean;
  } = {}
): Promise<T> {
  const daemon = readDaemon();
  if (!daemon) throw new DaemonUnreachable();
  // Rewriting here means every command targets a session without touching its
  // own call sites.
  const target =
    opts.daemonLevel || opts.unscoped ? path : sessionPathFor(path, resolveSessionId(opts.session));
  let res: Response;
  try {
    res = await fetch(daemon.url + target, {
      method,
      ...(body !== undefined
        ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
        : {}),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
  } catch {
    throw new DaemonUnreachable();
  }
  const text = (await res.text()).trim();
  const data = text ? (JSON.parse(text) as T) : ({} as T);
  if (!res.ok) {
    const err = (data as { error?: string }).error ?? `HTTP ${res.status}`;
    // A pointer left behind by a closed session should not strand the command:
    // retry once unprefixed, landing on the daemon's default exactly as an
    // absent pointer would. An explicit --session or $LIVEDOC_SESSION is the
    // caller's stated intent, so those still fail loudly.
    const fromPointer = !opts.session && !process.env.LIVEDOC_SESSION?.trim();
    if (res.status === 404 && /^no session /.test(err) && target !== path && fromPointer) {
      clearCurrentSession();
      return api<T>(method, path, body, { ...opts, unscoped: true });
    }
    throw new Error(err);
  }
  return data;
}

/** Machine-readable result on stdout, one line, nothing else. */
export function emit(data: unknown): void {
  console.log(JSON.stringify(data));
}

export function fail(message: string): never {
  console.error(`livedoc: ${message}`);
  process.exit(1);
}
