import type { Status } from '../types.js';

/**
 * Legal status transitions (design §3.3). Illegal transitions surface as
 * HTTP 409 with the current status, so racing CLI commands fail loudly.
 *
 *   clarifying → drafting | review     (answers submitted, or push = implicit skip)
 *   drafting   → clarifying | review   (ask before the first draft, or first push)
 *   review     → review | approved
 *   approved   → executing | review    (progress starts, or agent revises pre-build)
 *   executing  → review | done         (mid-build revision needs fresh approval)
 */
const TRANSITIONS: Record<Status, Status[]> = {
  clarifying: ['drafting', 'review'],
  drafting: ['clarifying', 'review'],
  review: ['review', 'approved'],
  approved: ['executing', 'review'],
  executing: ['review', 'done'],
  done: [],
};

export function canTransition(from: Status, to: Status): boolean {
  return TRANSITIONS[from].includes(to);
}

export class TransitionError extends Error {
  constructor(
    public readonly from: Status,
    public readonly to: Status
  ) {
    super(`illegal status transition ${from} -> ${to}`);
  }
}

export function assertTransition(from: Status, to: Status): void {
  if (!canTransition(from, to)) throw new TransitionError(from, to);
}
