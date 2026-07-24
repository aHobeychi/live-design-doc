import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SessionInfo } from '../types.js';

export const LIVEDOC_DIR = '.livedoc';

export function sessionPath(cwd = process.cwd()): string {
  return join(resolve(cwd), LIVEDOC_DIR, 'session.json');
}

export function readSession(cwd = process.cwd()): SessionInfo | null {
  try {
    return JSON.parse(readFileSync(sessionPath(cwd), 'utf8')) as SessionInfo;
  } catch {
    return null;
  }
}

export class DaemonUnreachable extends Error {
  constructor() {
    super('livedoc daemon is not running here — run `livedoc start <plan.md>` first');
  }
}

/** Probe a session for liveness; a pid alone can be recycled, so probe HTTP. */
export async function probe(session: SessionInfo): Promise<boolean> {
  try {
    const res = await fetch(`${session.url}/api/doc`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function api<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  opts: { timeoutMs?: number } = {}
): Promise<T> {
  const session = readSession();
  if (!session) throw new DaemonUnreachable();
  let res: Response;
  try {
    res = await fetch(session.url + path, {
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
