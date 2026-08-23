# livedoc

A coding agent writes an implementation plan; the human annotates it live in a browser;
the agent revises until approved, then builds against the frozen file. This repo is the
CLI + local daemon that runs that loop. Full specs live in `docs/`:
`docs/prd.md` (product design) and `docs/technical-design.md` (implementation design,
section numbers referenced throughout the code as `design §x.y`).

## Ground rules

- **Human authors only on commits.** Never add AI/agent `Co-Authored-By:` trailers
  (e.g. Claude, Copilot, Codex) or any other agent attribution to commit messages.
  Human co-authors are fine.
- **Conventional commit subjects on `main`.** `.github/workflows/release.yml` derives the
  npm version bump from commit subjects since the last tag (`scripts/release.js`):
  `feat:` -> minor, `fix:`/`perf:` -> patch, a `!` after the type/scope (e.g. `feat!:`) or
  a `BREAKING CHANGE:` footer -> major. Other prefixes (`chore:`, `docs:`, `refactor:`,
  `test:`, `ci:`, ...) don't trigger a release. Commits that skip the prefix entirely are
  invisible to the bump logic — merges to `main` intended to ship should use one of
  `feat`/`fix`/`perf` (or `!`/`BREAKING CHANGE` for a major).
- **Zero runtime dependencies.** `scripts/no-deps-check.js` fails `npm run check` if
  `package.json` ever gains a `dependencies` entry. Node's stdlib only
  (`node:http`, `node:fs`, `node:crypto`, etc). Don't add a package to solve a problem
  that ~20 lines of stdlib code can solve.
- **Node >= 22**, ESM only (`"type": "module"`), TypeScript `strict: true`.
- Import compiled-relative paths with `.js` extensions in `.ts` source (NodeNext
  resolution), e.g. `import { Store } from './store.js'` inside `store.ts`.

## Architecture

```
src/cli.ts              entry point, dispatches to commands/
src/commands/           one file per CLI verb (start, ask, wait, misc, init, setup, skills)
src/daemon/main.ts      daemon process entry (spawned by `start`, detached); createSession()
src/daemon/server.ts    HTTP API + status machine + route table + session dispatch
src/daemon/events.ts    Bus: per-session SSE + long-poll queue; Hub: daemon-wide SSE
src/daemon/session.ts   status transition table (clarifying/drafting/review/approved/executing/done)
src/daemon/sessions.ts  session ids, the .livedoc/sessions.json registry, flat-layout migration
src/daemon/store.ts     one session's directory (comments, answers, revisions, approved)
src/doc/blocks.ts       markdown -> raw blocks, text normalization
src/doc/ids.ts          block id assignment (explicit {#id} or content hash)
src/doc/anchor.ts       note re-anchoring across revisions (five-tier fallback, design §7.1)
src/doc/render.ts       block -> HTML for the browser view
src/web/                static browser UI (vanilla JS/HTML, served by the daemon)
skill/SKILL.md          the agent-facing skill doc installed into Claude Code / Copilot / Codex
```

The CLI (`livedoc <cmd>`) is a thin client: it starts/talks to a background daemon
process over HTTP on `127.0.0.1`, one daemon per project (tracked via
`.livedoc/daemon.json`). That daemon holds **many sessions** — one per plan file, keyed
by an id derived from the plan's path — in `DaemonCtx.sessions`, a `Map<string,
SessionCtx>`. Each `SessionCtx` owns its own `DaemonState`, its own `Bus`, and its own
`Store` under `.livedoc/sessions/<id>/`; `DaemonCtx` owns what is not per-session (the
project root, the web dir, the registry, the `Hub`).

Requests address a session by path prefix — `/api/s/<id>/doc` — stripped once in the
dispatcher, so route handlers are written against a single `SessionCtx` and never think
about ids. An un-prefixed `/api/doc` falls back to the default session (the only one, or
the most recently active), which is what keeps single-session use — and every older
client — working unchanged.

Every CLI command prints exactly **one line of JSON to stdout** and nothing else;
human-readable text goes to stderr. Never break that contract when touching
`commands/*.ts` — other agents parse stdout.

## Key invariants (violating these breaks the design, not just style)

- **Status machine** (`session.ts`) is the source of truth for what's legal when.
  Illegal transitions throw `TransitionError` -> HTTP 409. Don't bypass
  `assertTransition`/`setStatus` by mutating `state.status` directly.
- **Notes are anchored, never rewritten by the agent.** The agent's only path to a
  human's note is reading it via `wait`; there's no API for the agent to edit or delete
  a `sent` note (`server.ts` explicitly 409s that).
- **`dismissed` is the human's view control, not a note state** (design §7.2). It is a
  separate boolean rather than a third `state` value precisely so it can't be confused
  with the send/immutability machinery. The one mutation a `sent` note accepts is a
  dismiss-only `PATCH`; any patch that also touches body/intent/suggestion still 409s.
  It must stay invisible to the agent — notes reach the agent only in the feedback batch
  at send time, which is before a note can be dismissed — or it becomes exactly the
  "note was addressed" channel §7.2 exists to prevent. Dismissed notes are collapsed in
  the margin but kept in `comments.json` and in `approved-*.md`.
- **Answers become synthesized blocks** (`a-*` ids in `answerBlocks`), not raw JSON —
  keeps clarify answers anchorable and diffable like everything else.
- **`.livedoc/` split**: per session, `comments.json`, `answers.json`, `approved-*.md` are
  meant to be committed (the record of what was agreed); `revisions/` and `pending.json`
  are local/ephemeral, as are the daemon-level `daemon.json` and `current`. Two
  `.gitignore` writes enforce this — `Store.ensure()` for a session directory and
  `Registry.ensure()` for the outer one. Don't remove either.
- **Sessions are per plan file and never destructive.** `sessionIdFor()` derives the id
  from the plan's path, so `POST /api/sessions` and `createSession()` are idempotent and
  `livedoc start` on a second plan *adds* a session. It must never reset another plan's
  state — that regression is what the feature exists to fix, and
  `test/e2e.test.ts` guards it.
- **One `Bus` per session, never shared.** An agent parked on `livedoc wait` for one plan
  must be untouched by activity on another; `Bus` has a single waiter slot, so sharing one
  would cross agent loops. Session-list changes go through the daemon-level `Hub` instead,
  which every tab receives regardless of the session it is viewing.
- **Closing a session keeps its files.** `DELETE /api/sessions/<id>` drops it from the
  daemon and the registry only; the committed record is the point of the tool, and
  `livedoc start` on the same plan rehydrates from it.
- **Question cap**: `QUESTION_CAP = 6` in `types.ts`, enforced in `validateQuestions` and
  again server-side (`/api/questions` also refuses if a draft already exists — forks
  after the first draft go in the document's Open Questions, not a new question round).
- Block ids must stay stable across revisions when the text they anchor is conceptually
  unchanged — this is what lets notes survive edits. Don't change id-assignment logic in
  `doc/ids.ts` without checking `test/anchor.test.ts`.

## Dev workflow

```bash
npm install
npm run build     # tsc + copy src/web/* into dist/src/web
npm test          # build, then `node --test dist/test/*.test.js` (unit + one real-daemon e2e test)
npm run check     # tsc --noEmit + the zero-deps gate
npm link          # try the CLI locally as `livedoc`/`live-design-doc`
```

Tests are plain `node:test` + `node:assert`, compiled like everything else — there is no
separate test runner or config. `test/e2e.test.ts` spawns an actual daemon process and
talks to it over real HTTP; if you change the API surface in `server.ts`, that test is
the one most likely to catch it.

CI (`.github/workflows/test.yml`) runs `npm ci && npm run check && npm test` on every
push and PR, Node 22.

## Conventions worth matching

- Comments in this codebase explain *why*, often citing a design section
  (`// design §7.2`) or a subtle invariant — match that style, don't add
  what-comments.
- `Store` writes are atomic (`writeFileSync` to `.tmp` + `renameSync`) and
  `stableStringify` sorts keys recursively so committed JSON diffs stay minimal — follow
  that pattern for any new persisted file.
- New HTTP routes go in the record `buildRoutes()` returns in `server.ts`, keyed by
  `"METHOD /path"` — written against the resolved `SessionCtx`, with no session id in the
  key. Routes about the *set* of sessions go in `daemonRoutes` instead. Errors are thrown
  as `HttpError(code, message)` and caught centrally.
- New files under `src/web/` must be added to the `staticFiles` allowlist in `server.ts`
  and stay at the top level: `npm run build` copies with `cp src/web/*`, no `-r`, so
  subdirectories are silently skipped.
