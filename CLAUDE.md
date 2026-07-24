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
src/daemon/main.ts      daemon process entry (spawned by `start`, detached)
src/daemon/server.ts    HTTP API + status machine + route table
src/daemon/events.ts    Bus: SSE fan-out to browser tabs + single long-poll queue for the agent
src/daemon/session.ts   status transition table (clarifying/drafting/review/approved/executing/done)
src/daemon/store.ts     .livedoc/ persistence (comments, answers, revisions, approved, session)
src/doc/blocks.ts       markdown -> raw blocks, text normalization
src/doc/ids.ts          block id assignment (explicit {#id} or content hash)
src/doc/anchor.ts       note re-anchoring across revisions (five-tier fallback, design §7.1)
src/doc/render.ts       block -> HTML for the browser view
src/web/                static browser UI (vanilla JS/HTML, served by the daemon)
skill/SKILL.md          the agent-facing skill doc installed into Claude Code / Copilot / Codex
```

The CLI (`livedoc <cmd>`) is a thin client: it starts/talks to a background daemon
process over HTTP on `127.0.0.1`, one daemon per project (tracked via
`.livedoc/session.json`). The daemon holds all state in memory (`DaemonState` in
`server.ts`) and mirrors the parts that must survive a restart or be committed to
`.livedoc/` via `Store`.

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
- **Answers become synthesized blocks** (`a-*` ids in `answerBlocks`), not raw JSON —
  keeps clarify answers anchorable and diffable like everything else.
- **`.livedoc/` split**: `comments.json`, `answers.json`, `approved-*.md` are meant to be
  committed (the record of what was agreed); `revisions/`, `session.json`, `pending.json`
  are local/ephemeral (`Store.ensure()` writes a `.livedoc/.gitignore` enforcing this —
  don't remove that write).
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
- New HTTP routes go in the `routes` record in `server.ts` keyed by `"METHOD /path"`;
  errors are thrown as `HttpError(code, message)` and caught centrally.
