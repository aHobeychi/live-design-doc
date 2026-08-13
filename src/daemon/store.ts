import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent, Answer, Note, Question, SessionInfo } from '../types.js';

/** JSON.stringify with recursively sorted keys — committed files diff minimally. */
function stableStringify(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])])
      );
    }
    return v;
  };
  return JSON.stringify(sort(value), null, 2) + '\n';
}

export interface AnswersFile {
  questions: Question[];
  answers: Answer[];
  answeredAt: string;
}

/**
 * The .livedoc/ directory. comments.json, answers.json, and approved-*.md are
 * meant to be committed; revisions/, session.json, and pending.json are not —
 * a .gitignore written here enforces that split.
 */
export class Store {
  constructor(public readonly dir: string) {}

  ensure(): void {
    mkdirSync(join(this.dir, 'revisions'), { recursive: true });
    this.atomicWrite('.gitignore', 'revisions/\nsession.json\npending.json\n');
  }

  private atomicWrite(name: string, content: string): void {
    const target = join(this.dir, name);
    const tmp = target + '.tmp';
    writeFileSync(tmp, content);
    renameSync(tmp, target);
  }

  private readJson<T>(name: string): T | null {
    try {
      return JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as T;
    } catch {
      return null;
    }
  }

  saveComments(notes: Note[]): void {
    this.atomicWrite('comments.json', stableStringify({ version: 1, notes }));
  }

  loadComments(): Note[] {
    const notes = this.readJson<{ notes: Note[] }>('comments.json')?.notes ?? [];
    // Notes written before intents existed default to 'change'.
    return notes.map((n) => ({ ...n, intent: n.intent ?? 'change' }));
  }

  saveAnswers(file: AnswersFile): void {
    this.atomicWrite('answers.json', stableStringify(file));
  }

  loadAnswers(): AnswersFile | null {
    return this.readJson<AnswersFile>('answers.json');
  }

  savePending(events: AgentEvent[]): void {
    this.atomicWrite('pending.json', JSON.stringify(events));
  }

  loadPending(): AgentEvent[] {
    return this.readJson<AgentEvent[]>('pending.json') ?? [];
  }

  saveRevision(n: number, markdown: string): void {
    this.atomicWrite(join('revisions', String(n).padStart(3, '0') + '.md'), markdown);
  }

  /** Revision numbers present in revisions/, ascending. */
  listRevisions(): number[] {
    try {
      return readdirSync(join(this.dir, 'revisions'))
        .map((f) => Number(/^(\d{3})\.md$/.exec(f)?.[1] ?? NaN))
        .filter((n) => Number.isInteger(n) && n > 0)
        .sort((a, b) => a - b);
    } catch {
      return [];
    }
  }

  /** Highest NNN already in revisions/, so restarts keep counting upward. */
  maxRevision(): number {
    return this.listRevisions().at(-1) ?? 0;
  }

  loadRevision(n: number): string | null {
    try {
      return readFileSync(join(this.dir, 'revisions', String(n).padStart(3, '0') + '.md'), 'utf8');
    } catch {
      return null;
    }
  }

  saveApproved(content: string): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `approved-${stamp}.md`;
    this.atomicWrite(name, content);
    return join(this.dir, name);
  }

  writeSession(info: SessionInfo): void {
    this.atomicWrite('session.json', JSON.stringify(info, null, 2) + '\n');
  }

  readSession(): SessionInfo | null {
    return this.readJson<SessionInfo>('session.json');
  }

  clearSession(): void {
    try {
      rmSync(join(this.dir, 'session.json'));
    } catch {
      /* already gone */
    }
  }

  /** Drop all persisted review state for a fresh session in the same repo. */
  reset(): void {
    this.clearSession();
    for (const name of ['comments.json', 'answers.json', 'pending.json']) {
      try {
        rmSync(join(this.dir, name));
      } catch {
        /* already gone */
      }
    }
    try {
      rmSync(join(this.dir, 'revisions'), { recursive: true, force: true });
      mkdirSync(join(this.dir, 'revisions'), { recursive: true });
    } catch {
      /* if the directory is somehow unavailable */
    }
  }
}
