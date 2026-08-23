import { parseArgs } from 'node:util';
import type { WaitResult } from '../types.js';
import { api, DaemonUnreachable, emit, fail } from './api.js';

/**
 * The agent's only blocking call. `{"status":"timeout"}` is a normal result
 * (exit 0) — the agent loops on it. Non-zero exit means the daemon is
 * unreachable, which is the signal to run `livedoc start` again.
 */
export async function wait(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { timeout: { type: 'string', default: '300' }, session: { type: 'string' } },
  });
  const timeout = Math.min(600, Math.max(1, Number(values.timeout) || 300));
  try {
    const result = await api<WaitResult>('GET', `/api/wait?timeout=${timeout}`, undefined, {
      timeoutMs: (timeout + 60) * 1000,
      session: values.session,
    });
    emit(result);
  } catch (e) {
    if (e instanceof DaemonUnreachable) fail(e.message);
    fail(`wait failed: ${(e as Error).message}`);
  }
}
