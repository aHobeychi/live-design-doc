import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { DaemonInfo, SessionRecord, SessionsFile } from '../types.js';
import { stableStringify } from './store.js';

/**
 * The .livedoc/ layout owned by the daemon rather than by one plan:
 *
 *   .livedoc/
 *     sessions.json          committed — the registry
 *     sessions/<id>/         one Store per plan (see store.ts for its split)
 *     daemon.json            ignored — pid/port of the running daemon
 *     current                ignored — cwd-scoped "which session am I on"
 */
export const SESSIONS_DIR = 'sessions';
export const REGISTRY_FILE = 'sessions.json';
export const DAEMON_FILE = 'daemon.json';
export const CURRENT_FILE = 'current';
/** Superseded by daemon.json; still read once so old checkouts migrate. */
export const LEGACY_DAEMON_FILE = 'session.json';

/**
 * The outer .gitignore. The legacy flat entries stay listed so a tree that is
 * only half-migrated never leaks ephemera into a commit.
 */
const GITIGNORE = [
  DAEMON_FILE,
  CURRENT_FILE,
  `${SESSIONS_DIR}/*/revisions/`,
  `${SESSIONS_DIR}/*/pending.json`,
  'session.json',
  'pending.json',
  'revisions/',
].join('\n') + '\n';

/** Path a session's Store lives at. */
export function sessionDir(livedocDir: string, id: string): string {
  return join(livedocDir, SESSIONS_DIR, id);
}

/**
 * The path a session id hashes: relative to the project root when the plan
 * lives inside it, so ids survive a clone to a different directory, and
 * absolute otherwise.
 */
function idPath(planPath: string, root: string): string {
  const rel = relative(resolve(root), resolve(planPath));
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : resolve(planPath);
}

/**
 * A session id is `<slug>-<hash8>`: the slug keeps `.livedoc/sessions/` and the
 * browser URL readable, the hash keeps two PLAN.md files in different
 * directories apart. Shaped to match the existing [\w-]+ route patterns.
 */
export function sessionIdFor(planPath: string, root: string): string {
  const target = idPath(planPath, root);
  const slug =
    basename(target, extname(target))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32)
      .replace(/-+$/, '') || 'plan';
  const hash = createHash('sha256').update(target).digest('hex').slice(0, 8);
  return `${slug}-${hash}`;
}

/** Display path for a plan: relative to the root when inside it, else absolute. */
export function relFileFor(planPath: string, root: string): string {
  return idPath(planPath, root);
}

/** sessions.json + daemon.json. Writes are atomic, like Store's. */
export class Registry {
  constructor(public readonly dir: string) {}

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

  ensure(): void {
    mkdirSync(join(this.dir, SESSIONS_DIR), { recursive: true });
    this.atomicWrite('.gitignore', GITIGNORE);
    if (!existsSync(join(this.dir, REGISTRY_FILE))) this.save([]);
  }

  /**
   * The rows, read from disk once. The daemon is the only writer, so holding
   * them in memory keeps `load()` off the hot path — it is called per row of
   * every session listing and on every request that touches lastActiveAt.
   */
  private cache: SessionRecord[] | null = null;

  load(): SessionRecord[] {
    this.cache ??= this.readJson<SessionsFile>(REGISTRY_FILE)?.sessions ?? [];
    return this.cache;
  }

  save(sessions: SessionRecord[]): void {
    this.cache = sessions;
    this.atomicWrite(REGISTRY_FILE, stableStringify({ version: 1, sessions }));
  }

  /** Insert or replace one row, keyed by id. */
  upsert(record: SessionRecord): void {
    const sessions = this.load().filter((s) => s.id !== record.id);
    sessions.push(record);
    this.save(sessions);
  }

  remove(id: string): void {
    this.save(this.load().filter((s) => s.id !== id));
  }

  /**
   * Bump a session's activity stamp. Only writes when the value actually
   * changes at second granularity, so a browser polling every 80ms does not
   * rewrite the registry on every request.
   */
  touch(id: string, at = new Date().toISOString()): void {
    const sessions = this.load();
    const row = sessions.find((s) => s.id === id);
    if (!row || row.lastActiveAt.slice(0, 19) === at.slice(0, 19)) return;
    row.lastActiveAt = at;
    this.save(sessions);
  }

  writeDaemon(info: DaemonInfo): void {
    this.atomicWrite(DAEMON_FILE, JSON.stringify(info, null, 2) + '\n');
  }

  readDaemon(): DaemonInfo | null {
    return this.readJson<DaemonInfo>(DAEMON_FILE) ?? this.readJson<DaemonInfo>(LEGACY_DAEMON_FILE);
  }

  clearDaemon(): void {
    for (const name of [DAEMON_FILE, LEGACY_DAEMON_FILE]) {
      try {
        rmSync(join(this.dir, name));
      } catch {
        /* already gone */
      }
    }
  }
}

/** Files the old flat layout kept directly under .livedoc/. */
const FLAT_FILES = ['comments.json', 'answers.json', 'pending.json'];

/**
 * One-time move from the single-session layout (.livedoc/comments.json, …) into
 * .livedoc/sessions/<id>/. Runs at daemon boot before any Store is built, so it
 * happens once in one process and cannot race two terminals.
 *
 * Returns the id the old state landed under, or null when there was nothing to
 * migrate. Without a plan file there is no id to derive, so the flat files are
 * left alone and migrate on the next `livedoc start`.
 */
export function migrateFlatLayout(livedocDir: string, planFile: string | null): string | null {
  if (existsSync(join(livedocDir, REGISTRY_FILE))) return null;
  const hasFlatState =
    FLAT_FILES.some((f) => existsSync(join(livedocDir, f))) ||
    existsSync(join(livedocDir, 'revisions'));
  if (!hasFlatState || !planFile) return null;

  const root = resolve(dirname(livedocDir));
  const id = sessionIdFor(planFile, root);
  const target = sessionDir(livedocDir, id);
  mkdirSync(target, { recursive: true });

  const approved = (() => {
    try {
      return readdirSync(livedocDir).filter((f) => /^approved-.*\.md$/.test(f));
    } catch {
      return [];
    }
  })();

  for (const name of [...FLAT_FILES, 'revisions', ...approved]) {
    try {
      renameSync(join(livedocDir, name), join(target, name));
    } catch {
      /* absent, or already moved */
    }
  }
  try {
    rmSync(join(livedocDir, LEGACY_DAEMON_FILE));
  } catch {
    /* already gone */
  }

  const now = new Date().toISOString();
  const registry = new Registry(livedocDir);
  registry.ensure();
  registry.save([
    {
      id,
      file: resolve(planFile),
      relFile: relFileFor(planFile, root),
      createdAt: now,
      lastActiveAt: now,
    },
  ]);
  return id;
}
