export type Status =
  | 'clarifying'
  | 'drafting'
  | 'review'
  | 'approved'
  | 'executing'
  | 'done';

export type BlockType =
  | 'heading'
  | 'paragraph'
  | 'code'
  | 'table'
  | 'blockquote'
  | 'listItem';

export interface Block {
  id: string;
  type: BlockType;
  /** Raw markdown for the block, with any trailing {#id} marker stripped. */
  text: string;
  /** Lowercased, whitespace-collapsed text — input to hashing and anchoring. */
  normalized: string;
  /** Heading level, 1–6. */
  level?: number;
  /** Consecutive list items share a group so they render as one list. */
  listGroup?: number;
  /** Original list marker, e.g. "-" or "3." */
  marker?: string;
  /** Task-list checkbox state, if the item has one. */
  checkbox?: 'todo' | 'done';
}

export type Fidelity = 'exact' | 'moved' | 'approximate' | 'orphan';

export interface Resolution {
  blockId: string | null;
  fidelity: Fidelity;
}

export interface Note {
  id: string;
  state: 'new' | 'sent';
  body: string;
  quote: string;
  contextBefore: string;
  contextAfter: string;
  /** Block id the note was created against. */
  blockId: string;
  /** Full text of that block at creation time — similarity input for re-anchoring. */
  blockTextAtCreation: string;
  createdAgainstRevision: number;
  resolved: Resolution;
  seenByAgent: boolean;
}

export interface QuestionOption {
  value: string;
  label: string;
}

export interface Question {
  id: string;
  prompt: string;
  kind: 'choice' | 'multi' | 'text';
  options?: QuestionOption[];
}

export interface Answer {
  id: string;
  value: string | string[];
}

export type WaitResult =
  | { status: 'timeout' }
  | { status: 'feedback'; revision: number; notes: Note[] }
  | { status: 'approved'; approvedPath: string }
  | { status: 'answers'; answers: Answer[] }
  | { status: 'shutdown' };

export type AgentEvent = Exclude<WaitResult, { status: 'timeout' }>;

export interface SessionInfo {
  pid: number;
  port: number;
  url: string;
  file: string;
  startedAt: string;
}

/** The six-question hard cap from the design; `livedoc ask` rejects more. */
export const QUESTION_CAP = 6;

export function validateQuestions(input: unknown): Question[] {
  if (typeof input !== 'object' || input === null || !Array.isArray((input as { questions?: unknown }).questions)) {
    throw new Error('expected {"questions": [...]}');
  }
  const questions = (input as { questions: unknown[] }).questions;
  if (questions.length === 0) throw new Error('questions is empty');
  if (questions.length > QUESTION_CAP) {
    throw new Error(
      `too many questions (${questions.length}). The cap is ${QUESTION_CAP} — prioritise: ` +
        'ask only questions where different answers produce materially different documents.'
    );
  }
  const seen = new Set<string>();
  return questions.map((q, i) => {
    if (typeof q !== 'object' || q === null) throw new Error(`question ${i}: not an object`);
    const { id, prompt, kind, options } = q as Record<string, unknown>;
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      throw new Error(`question ${i}: id must be a lowercase slug`);
    }
    if (seen.has(id)) throw new Error(`question ${i}: duplicate id "${id}"`);
    seen.add(id);
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error(`question "${id}": missing prompt`);
    if (kind !== 'choice' && kind !== 'multi' && kind !== 'text') {
      throw new Error(`question "${id}": kind must be choice, multi, or text`);
    }
    let opts: QuestionOption[] | undefined;
    if (kind === 'choice' || kind === 'multi') {
      if (!Array.isArray(options) || options.length < 2) {
        throw new Error(`question "${id}": ${kind} needs at least 2 options`);
      }
      opts = options.map((o, j) => {
        const { value, label } = (o ?? {}) as Record<string, unknown>;
        if (typeof value !== 'string' || typeof label !== 'string') {
          throw new Error(`question "${id}" option ${j}: needs string value and label`);
        }
        return { value, label };
      });
    }
    return { id, prompt: prompt.trim(), kind, ...(opts ? { options: opts } : {}) };
  });
}
