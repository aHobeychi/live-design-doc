import { readFileSync } from 'node:fs';
import { validateQuestions } from '../types.js';
import { api, emit, fail } from './api.js';

export async function push(): Promise<void> {
  const result = await api('POST', '/api/reload');
  emit(result);
}

export async function progress(args: string[]): Promise<void> {
  const [blockId, state] = args;
  if (!blockId) fail('usage: livedoc progress <block-id> [done|todo]');
  const result = await api('POST', '/api/progress', { blockId, state: state ?? 'done' });
  emit(result);
}

export async function ask(args: string[]): Promise<void> {
  const [file] = args;
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
  const result = await api('POST', '/api/questions', parsed);
  emit(result);
}

export async function stop(): Promise<void> {
  const result = await api('POST', '/api/shutdown');
  emit(result);
}
