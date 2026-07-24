# live-design-doc — technical design

**Companion to:** `prd.md` (v0.1.0 design). This document describes *how* to build what
that document specifies. Where the PRD marks something *proposed* (the clarify phase),
the corresponding sections here are marked the same way.

---

## 1. Stack decision

The PRD's §9.3 constraint — **zero runtime dependencies** — is load-bearing: the tool
installs globally and runs a local HTTP server, so the supply chain stays empty. "Modern
tech stack" therefore means leaning on the modern Node platform rather than frameworks:

| Concern | Choice | Why |
| --- | --- | --- |
| Runtime | **Node.js ≥ 22 (LTS)** | Stable `node:test`, `--watch`, native `fetch`, `structuredClone`, `AbortSignal.timeout` |
| Language | **TypeScript, compiled to ESM** | Dev-time only; ships plain `.js`. `tsc` with `erasableSyntaxOnly` so source stays runnable via `node --experimental-strip-types` during development |
| Module system | **ESM throughout** (`"type": "module"`) | No CJS interop burden; the package is new |
| HTTP server | **`node:http`** | The surface is 13 routes on loopback; a framework buys nothing |
| Markdown | **Hand-rolled block splitter (~250 lines)** | PRD §9.3 — block boundaries must exactly match what the anchorer needs |
| Persistence | **JSON files in `.livedoc/`** | Human-readable, diffable, committable — the PRD requires `comments.json` be committed. `node:sqlite` was considered and rejected: binary artifacts can't be code-reviewed in a PR |
| Frontend | **One HTML file, vanilla ES modules, no build step** | Served inline from the daemon; state is small (one doc, one note list); SSE + `EventSource` covers reactivity |
| Tests | **`node:test` + `node:assert/strict`** | Zero dev-dep test stack; `node --test --watch` for iteration |
| Lint/format | **Biome** (dev-dependency) | Single fast tool replacing eslint+prettier |
| Packaging | **npm, `bin` entry, published as `livedoc`** | Global install per the PRD |

Dev-dependencies allowed: `typescript`, `@types/node`, `@biomejs/biome`. Runtime
dependencies: none, enforced by a CI check that fails if `package.json` gains a
`dependencies` key.

## 2. Repository layout

```
livedoc/
  package.json
  tsconfig.json
  src/
    cli.ts               entry point; arg parsing (node:util parseArgs), command dispatch
    commands/
      start.ts           spawn/attach daemon, print URL
      ask.ts             validate + POST question set        (proposed)
      wait.ts            long-poll /api/wait, print result
      push.ts            POST /api/reload after agent rewrites the file
      progress.ts        POST /api/progress
      init.ts            copy SKILL.md into agent skill dir
      stop.ts            POST /api/shutdown
    daemon/
      main.ts            daemon entry; owns all state
      server.ts          node:http router, loopback bind, port scan
      session.ts         session.json read/write, pid liveness, status machine
      events.ts          in-process event bus → SSE fan-out + wait-queue wakeup
      store.ts           .livedoc/ file persistence (comments, answers, revisions, approved)
    doc/
      blocks.ts          markdown → Block[] splitter
      ids.ts             {#id} extraction, content-hash fallback ids
      anchor.ts          5-tier re-anchoring (exact/moved/moved/approximate/orphan)
      render.ts          Block[] → HTML (server-side, for the web UI)
    web/
      index.html         the whole UI: inline CSS + <script type="module">
      app.js             fetch snapshot, subscribe SSE, selection → note, margin layout
      margin.js          note positioning: anchor y-coords, collision stacking, leader curves
    skill/
      SKILL.md           the agent contract (name/description frontmatter only)
  test/
    blocks.test.ts  ids.test.ts  anchor.test.ts  session.test.ts
    e2e.test.ts          spawn real daemon, drive it over HTTP
    fixtures/            markdown documents + expected block/anchor outcomes
```

`src/web/` is copied verbatim into `dist/web/` at build time and served from disk by the
daemon (no bundler; the files *are* the artifacts).

## 3. Process architecture

### 3.1 CLI ↔ daemon split

Every CLI command except `start` and `init` is a thin HTTP client. `start` is the only
command that spawns anything:

```
livedoc start PLAN.md
  ├─ read .livedoc/session.json; if pid alive → POST /api/reload, print same URL, exit 0
  └─ else spawn: node dist/daemon/main.js --file PLAN.md --dir .livedoc
       stdio: ['ignore', 'pipe', 'inherit'], detached: true
     wait for one JSON line on child stdout: {"port":4317,"url":"http://127.0.0.1:4317"}
     child.unref(); write session.json; open browser; print URL; exit 0
```

Key mechanics:

- **Readiness handshake.** The parent resolves only after the daemon has bound its port
  and printed the JSON line. A 5-second `AbortSignal.timeout` guards against a daemon
  that dies during boot; the parent then surfaces the daemon's stderr.
- **Port scan.** `server.listen(4317)` → on `EADDRINUSE`, increment, up to 4341 (25
  ports, PRD §12). Bind host is hard-coded `127.0.0.1`; there is no flag to widen it
  (PRD non-goal: not remote).
- **Liveness.** `session.json` stores `{pid, port, url, startedAt, file}`. Liveness check
  is `process.kill(pid, 0)` in a try/catch **plus** a `GET /api/doc` probe — a pid alone
  can be recycled. Stale session files are overwritten silently.
- **Idempotent start.** Matches PRD §12: second `start` reuses the session and reloads.
- **Browser open.** `open`(mac)/`xdg-open`/`start` via `child_process.spawn`, failures
  ignored — the URL is always printed as fallback.

### 3.2 The wait loop

`livedoc wait --timeout 300` → `GET /api/wait?timeout=300`. Server-side:

```ts
// events.ts — single waiter queue; the agent is the only long-poll client
async function wait(timeoutSec: number): Promise<WaitResult> {
  const pending = drainPendingEvents();          // events that fired while agent was away
  if (pending) return pending;
  return Promise.race([
    onceAgentEvent(),                            // send / approve / answers / shutdown
    timer(timeoutSec).then(() => ({ status: 'timeout' })),
  ]);
}
```

Two details the PRD implies but doesn't spell out, resolved here:

- **Events outlast the poll.** If the human presses **Send** between two `wait` calls,
  the batch is queued in memory and delivered on the next `wait` (PRD §12, "notes sent
  while agent is building"). The queue is also flushed to `.livedoc/pending.json` on
  every enqueue so a daemon restart cannot lose an unsent batch.
- **The sentinel is exit code 0.** `{"status":"timeout"}` is a *normal* result — the
  agent loops on it. Non-zero exit is reserved for "daemon unreachable", which is the
  signal to run `start` again (PRD §12). `wait` results are single-line JSON on stdout,
  nothing else, so agents can parse them without scraping.

Wait result shapes (discriminated union on `status`):

```ts
type WaitResult =
  | { status: 'timeout' }
  | { status: 'feedback'; revision: number; notes: SentNote[] }
  | { status: 'approved'; approvedPath: string }
  | { status: 'answers'; answers: Answer[] }        // proposed
  | { status: 'shutdown' };
```

### 3.3 State machine

`session.ts` owns one enum and validates every transition; illegal transitions return
HTTP 409 with the current status in the body:

```
clarifying → drafting            (answers submitted or skipped)     [proposed]
drafting   → review              (first /api/reload)
review     → review              (subsequent reloads = new revisions)
review     → approved            (/api/approve)
approved   → executing           (first /api/progress)
executing  → review              (agent pushes a revision mid-build — PRD §8 re-approval)
executing  → done                (all blocks ticked, or explicit)
```

`livedoc ask` is rejected with a clear error once any revision exists (PRD §5.7) — this
check lives in the daemon, not the CLI, so it holds even if commands race.

## 4. Document model

### 4.1 Block splitter (`blocks.ts`)

A single-pass line scanner producing:

```ts
interface Block {
  id: string;             // explicit {#id} or content hash
  type: 'heading' | 'paragraph' | 'code' | 'table' | 'blockquote' | 'listItem';
  text: string;           // raw markdown, {#id} stripped
  normalized: string;     // lowercased, whitespace-collapsed — hashing + anchoring input
  listGroup?: number;     // consecutive items share a group for joined rendering
  checkbox?: 'todo' | 'done';   // task-list items, drives progress UI
}
```

Splitting rules, in priority order per line: fence open/close (``` or ~~~, fences are
atomic — never split inside), `#`-heading, `|`-table row (greedy: consecutive rows are
one block), `>`-quote (greedy), list-item marker (`-`/`*`/`+`/`\d+.` — **each item is its
own block**, per PRD §6.1; a nested item is folded into its parent item's block, which is
the documented "nested lists render flat past one level" limitation), blank line =
paragraph boundary. ~250 lines including the renderer, matching the PRD's estimate.

### 4.2 Ids (`ids.ts`)

- Explicit: trailing `{#[a-z0-9-]+}` on the block's last line; stripped from `text`.
- Derived: `b-` + first 8 hex chars of SHA-256 (`node:crypto`) of `normalized`. Stable
  across revisions iff the text is unchanged — exactly the guarantee the PRD claims.
- Collision (same text twice): suffix `-2`, `-3` by document order. Deterministic, so
  unchanged documents produce identical id sets.

### 4.3 Re-anchoring (`anchor.ts`)

Runs on every `/api/reload`, for every note, against the new `Block[]`. Direct
implementation of the PRD §7.1 table:

```ts
function reanchor(note: Note, blocks: Block[]): Resolution {
  const byId = blocks.find(b => b.id === note.blockId);
  if (byId?.normalized.includes(norm(note.quote))) return { blockId: byId.id, fidelity: 'exact' };

  const withCtx = blocks.find(b => b.normalized.includes(norm(note.contextBefore + note.quote + note.contextAfter)));
  if (withCtx) return { blockId: withCtx.id, fidelity: 'moved' };

  const quoteOnly = blocks.filter(b => b.normalized.includes(norm(note.quote)));
  if (quoteOnly.length === 1) return { blockId: quoteOnly[0].id, fidelity: 'moved' };
  // ambiguous quote (>1 match) deliberately falls through — guessing is the failure mode §7.1 forbids

  const best = maxBy(blocks, b => diceBigramSimilarity(note.blockTextAtCreation, b.normalized));
  if (best.score >= 0.35) return { blockId: best.block.id, fidelity: 'approximate' };

  return { blockId: null, fidelity: 'orphan' };
}
```

`diceBigramSimilarity` is word-bigram Dice over the *whole block text captured when the
note was created* (stored on the note for this purpose), not just the quote — a short
quote carries too little signal. O(notes × blocks) per reload is fine at plan scale
(≤ a few hundred blocks); no indexing needed.

Notes store, at creation time: `blockId`, `quote`, `contextBefore`/`contextAfter` (40
chars each, taken from the block's normalized text), and `blockTextAtCreation`.

## 5. HTTP surface and persistence

### 5.1 Router

`server.ts` is a hand-rolled router: method + pathname switch, JSON body limit 1 MB,
every response `application/json` except `/` (HTML), `/app.js`, `/margin.js`, and
`/api/events` (SSE). Because the bind is loopback-only, there is no auth; but the server
still sets `Cache-Control: no-store` everywhere and rejects non-loopback `Host` headers
as a DNS-rebinding guard — that is the one security measure a localhost tool genuinely
needs.

Routes are exactly the PRD §9.2 table. Additions of detail:

- `GET /api/doc` → `{ status, revision, blocks, notes, answers, progress }` — one
  snapshot shape, also used by the UI on load and reconnect.
- `GET /api/events` (SSE) → named events `revision`, `note`, `status`, `progress`, each
  carrying the same snapshot delta the UI needs; heartbeat comment every 25 s;
  `Last-Event-ID` ignored (clients refetch `/api/doc` on reconnect — simpler and always
  correct).
- `POST /api/reload` → re-read file from disk, split, re-anchor all notes, write
  `revisions/NNN.md`, bump revision, broadcast. This is what `livedoc push` calls.
- `POST /api/approve` → compose approved doc (answers prepended *(proposed)*, notes
  appended), write `approved-<ISO-timestamp>.md`, status → `approved`, wake agent.
- `POST /api/questions` *(proposed)* → validate schema, **reject > 6 questions with the
  "prioritise" error (PRD §5.4)**, reject if any revision exists, status → `clarifying`.
- `POST /api/answers` *(proposed)* → persist `answers.json`, synthesize `a-<id>` answer
  blocks, status → `drafting`, wake agent with `{status:'answers'}`.

### 5.2 Persistence (`store.ts`)

All writes are atomic: write to `<name>.tmp` in the same directory, `fs.rename` over the
target. `comments.json` and `answers.json` are pretty-printed (2-space) and key-sorted so
their committed diffs are minimal and reviewable.

```jsonc
// .livedoc/comments.json — append-only after send (PRD §7.2/§7.3)
{ "version": 1,
  "notes": [ {
      "id": "n-01J...",                 // ULID-style: sortable, no Date.now collisions
      "state": "sent",                  // 'new' | 'sent'
      "body": "This should be per-key, not global",
      "quote": "100 req/min",
      "contextBefore": "backed by Redis, ",
      "contextAfter": " per key",
      "blockId": "t-limiter",
      "blockTextAtCreation": "...",
      "createdAgainstRevision": 3,
      "resolved": { "blockId": "t-limiter", "fidelity": "exact" },
      "seenByAgent": true
  } ] }
```

The daemon holds everything in memory and treats the files as write-through; on boot it
rehydrates from them, which is what makes `start`-after-crash lossless.

## 6. Web UI

No framework and no build step, by the same supply-chain argument as the backend — and
because the state is one document plus one note list, well under the threshold where a
framework pays for itself.

- **Boot:** fetch `/api/doc`, render server-provided block HTML into the 640 px serif
  column; open `EventSource('/api/events')`. On any SSE gap, refetch the snapshot.
- **Selection → note:** `selectionchange` → if the selection lies within one block
  element (`data-block-id`), float the single **Add note** button (PRD §10). Composing a
  note POSTs `/api/comments` with quote + context computed client-side from the block's
  text content.
- **Margin (`margin.js`):** each note's ideal `y` is its anchor's `offsetTop`; a single
  top-down pass pushes colliding notes downward (classic Google-Docs stacking); leader
  lines are one `<svg>` overlay of cubic curves from note edge to anchor edge,
  recomputed on `ResizeObserver` and revision render. Below 1040 px a container query
  drops the margin and stacks notes beneath the document.
- **Revision arrival:** blocks whose id or text changed get a brief background flash
  (CSS transition, no diffing — PRD non-goal). Notes re-render with fidelity badges:
  nothing for `exact`, "moved" chip, or "text is gone" chip pinned to the document top
  for orphans.
- **Phases in one tab:** the UI renders from `status` alone — `clarifying` shows the
  question form *(proposed)*, `review` shows document + margin + Send/Approve bar,
  `executing` shows the frozen document with checkbox ticks driven by `progress` events.
  No routing; one tab spans the lifecycle (PRD §4).

## 7. CLI details

- Arg parsing via `node:util` `parseArgs` — no dependency.
- `livedoc init` prompts with `node:readline/promises` (agent: Claude Code / Copilot;
  scope: project / personal), then copies `skill/SKILL.md` into the right directory from
  the PRD §11 table. `--agent`/`--scope` flags skip the prompts for scripted installs.
- `livedoc ask questions.json` validates the question schema locally (hand-rolled
  validator, ~60 lines — three `kind`s only, per PRD §5.3) *before* POSTing, so schema
  errors surface with line context instead of an HTTP 400.
- All commands print machine-readable single-line JSON to stdout and human prose to
  stderr, so agent parsing and human debugging never conflict.

## 8. Testing

- **Unit** (`node:test`): splitter and ids are golden-file tests over `test/fixtures/`
  (markdown in → JSON blocks out); the anchorer gets a table-driven suite with one case
  per fidelity tier plus the two trap cases: ambiguous quote must *not* resolve to
  `moved`, and near-miss similarity (0.30) must orphan rather than approximate.
- **E2E:** spawn the real daemon on port 0 (test mode accepts an ephemeral port), drive
  the full loop over `fetch`: start → reload → comment → send → wait sees feedback →
  reload re-anchors → approve → wait sees approved → approved file content asserted.
  Runs in CI on macOS + Linux + Windows (the detach/unref path is the one OS-sensitive
  piece).
- **Timeout semantics:** a dedicated test asserting `wait --timeout 1` returns the
  sentinel with exit 0 in ~1 s — this pins the PRD §9.1 mechanism against the exact
  "helpful" refactor the PRD warns about.

## 9. Build and release

```jsonc
// package.json (relevant fields)
{ "name": "livedoc", "type": "module",
  "bin": { "livedoc": "dist/cli.js" },
  "engines": { "node": ">=22" },
  "files": ["dist", "skill"],
  "scripts": {
    "build": "tsc && cp -r src/web dist/web",
    "test": "node --test",
    "check": "biome check && tsc --noEmit && node scripts/no-deps-check.js"
  } }
```

CI (GitHub Actions): `check` + `test` on the three OSes; publish with `npm publish
--provenance` on tag. `scripts/no-deps-check.js` fails the build if `dependencies`
exists — turning the PRD's zero-dependency principle from a convention into a gate.

## 10. Implementation order

1. **Core doc model** — `blocks.ts`, `ids.ts`, `anchor.ts` with their test suites. Pure
   functions, no I/O; everything else consumes them.
2. **Daemon + start/wait/push** — the §3 machinery, e2e test proving the detach and the
   timeout sentinel on all three OSes. This is the highest-risk code; build it second,
   not last.
3. **Review UI** — snapshot render, selection → note, margin, Send/Approve.
4. **Build phase** — approve freeze, progress ticks, executing view.
5. **`init` + `SKILL.md`** — the agent contract, last, once the loop it describes is real.
6. **Clarify phase** *(proposed)* — gated on the PRD's own open question #1; everything
   above is designed so this lands as one command, one status, one wait result.

## 11. Risks

| Risk | Mitigation |
| --- | --- |
| Detached-daemon behavior differs on Windows (`detached`, signals) | E2E matrix from day one; Windows uses `windowsHide` and skips signal-based shutdown in favor of `/api/shutdown` (already the primary path) |
| Hand-rolled markdown drifts from user expectations | Documented subset in README; golden fixtures include the PRD itself (its own §14 footnote makes it the canonical test document) |
| Anchorer mis-attaches and erodes trust | The two trap tests in §8 are release-blocking; ambiguity always degrades, never guesses |
| Browser `EventSource` drops silently | Snapshot refetch on every reconnect; UI state is always rebuildable from `/api/doc` |
| `comments.json` merge conflicts across branches | Append-only, key-sorted, one-object-per-note formatting keeps conflicts mechanical; per-plan storage is PRD open question #3, deferred with it |
