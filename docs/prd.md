# live-design-doc — design

**Status:** phases 2–4 built and working (v0.1.0). Phase 1, the clarify step, is designed
here and not yet implemented — every section describing it is marked *proposed*.

---

## 1. Summary

A coding agent writes an implementation plan. The plan opens in a browser tab. The human
highlights parts of it and leaves notes. The agent revises. When the plan is right the human
approves it, and the agent builds from the frozen document.

The tool is a globally installed CLI (`livedoc`) plus a skill file that teaches the agent
how to drive it. It works with Claude Code and GitHub Copilot CLI, which both read the same
`SKILL.md` format.

## 2. The problem

Agents are good at producing plans and bad at knowing which parts of a plan you disagree
with. The existing options for correcting them are all poor:

- **Reading the plan in the terminal.** Fine for ten lines, unworkable for a hundred. There
  is no way to point at a specific sentence, so feedback becomes "the third bullet under
  tasks — no, the other one".
- **Chatting corrections.** Every correction is a separate turn, the agent starts working
  after each one, and the plan and the conversation drift apart until nobody knows which is
  authoritative.
- **Letting it build and reviewing the diff.** The most expensive possible moment to
  discover the approach was wrong.

What is missing is the thing code review already solved for code: a document you can point
at, with your comment attached to the exact line it is about, and a clear moment of
approval.

## 3. Principles

These drove most of the decisions below, and are worth keeping if the design is revisited.

**The human annotates; the agent writes.** The document is read-only in the browser. Every
word comes from the agent. This is the single most load-bearing decision in the design —
it eliminates merge conflicts entirely, removes any ambiguity about who owns the text, and
means the agent never has to reconcile its intent with someone else's edit.

**The human's input is never editable by the agent.** The exact inverse. Notes and answers
are recorded verbatim and the agent has no write path to them. Together with the rule above,
this gives each side exactly one thing it owns.

**Batch, don't stream.** Notes accumulate until the human presses Send. If each note woke
the agent immediately, it would rewrite paragraphs while they were still being read.

**Nothing the human said is ever discarded.** Handled notes are marked handled, not deleted.
The record of why a plan came out the way it did is usually more valuable than the plan.

**Silence is an answer.** Every blocking point has a way past it. Questions can be skipped,
waits time out, and an unresponsive human results in a stated assumption rather than a hung
agent.

## 4. Lifecycle

```
   ┌──────────┐   answers   ┌──────────┐   push    ┌──────────┐
   │ clarify  │ ──────────▶ │  draft   │ ────────▶ │  review  │
   │(proposed)│             │          │           │          │
   └──────────┘             └──────────┘           └────┬─────┘
        │                        ▲                      │
        │ skipped                └──── feedback ────────┤
        └───────────────────────▶                       │ approved
                                                        ▼
                                                  ┌──────────┐
                                                  │  build   │
                                                  └──────────┘
```

One browser tab spans all four phases. It shows questions, then the document, then progress
against the approved document. The session, the port, and the note history are continuous
across the whole thing.

Session status values: `clarifying` *(proposed)*, `drafting`, `review`, `approved`,
`executing`, `done`.

---

## 5. Phase 1 — clarify *(proposed)*

### 5.1 What it is

Before writing anything, the agent may put a short set of questions in the browser and wait
for answers. This is the same idea as the elicitation step in Claude Design: a few tappable
choices are far cheaper for the human than reading a plan built on a wrong assumption and
explaining why it is wrong.

The agent calls:

```bash
livedoc ask questions.json
```

This opens the browser (this is usually the first thing the human sees), sets session status
to `clarifying`, and returns immediately. The agent then enters the same wait loop it uses
everywhere else:

```bash
livedoc wait --timeout 300
# {"status":"answers","answers":[{"id":"scope","value":"search endpoint only"}, ...]}
```

### 5.2 Why this is almost no new machinery

Deliberately, the clarify phase adds one command, one status, and one wait result. It reuses
the daemon, the session file, the SSE stream, the long-poll wait, and the timeout sentinel
exactly as they already exist. If it needed a second server or a second wait mechanism, that
would be a sign the design was wrong.

### 5.3 Question format

```json
{
  "questions": [
    {
      "id": "scope",
      "prompt": "Which endpoints should the limiter cover?",
      "kind": "choice",
      "options": [
        { "value": "search", "label": "Just /v1/search" },
        { "value": "reads",  "label": "All read endpoints" },
        { "value": "all",    "label": "Everything public" }
      ]
    },
    { "id": "store", "prompt": "Where should counters live?", "kind": "choice",
      "options": [{ "value": "redis", "label": "Redis" }, { "value": "memory", "label": "In-process" }] },
    { "id": "notes", "prompt": "Anything else I should know?", "kind": "text" }
  ]
}
```

Three kinds only: `choice` (pick one), `multi` (pick several), `text` (free entry). Adding
more kinds is how this becomes a form builder, which is not what it is for.

### 5.4 The discipline, which is the actual feature

The plumbing is easy. The thing that decides whether this feature is loved or hated is
whether the questions are worth answering. Two rules go in `SKILL.md`, and the second one is
enforced in code:

**Ask only if two different answers produce materially different documents.** If the plan
comes out the same either way, the question is decoration. This rules out most preference
questions and all politeness questions.

**Never ask what the repository can answer.** "Which test framework do you use" is a
question the agent should answer by looking. Asking it spends the human's attention on
something the agent was capable of doing itself, which is the fastest way to make people
stop reading the questions.

**Cap: four questions, six hard.** `livedoc ask` rejects more than six with an error that
says to prioritise. One screen, no scrolling. An agent with twelve questions does not
understand the task well enough to be asking; it should read more code first.

### 5.5 Skipping

Every question is skippable and the whole set has a **Just draft it** button. Skipping is a
first-class outcome, not an error.

When the agent receives no answer for a question, it must make an explicit assumption and
put it in the plan's *Open questions* section, anchored to the part of the plan it affects.
The question is not lost — it moves from a modal that costs attention up front to a line in
the document where answering it costs one highlight and one sentence, in full context. That
is usually the better place for it anyway, which is why the cap on questions is so tight.

### 5.6 Answers become part of the document

Once answered, the answers render as a section at the top of the document:

```
Before we started
  Scope    Just /v1/search
  Store    Redis
```

Two properties matter here:

- **The server renders this section from `answers.json`, not the agent.** The agent cannot
  restate, summarise, or quietly drift from what the human said. This is the same integrity
  rule that applies to notes.
- **Each answer is a normal block with an id** (`a-scope`, `a-store`). It gets highlighting,
  anchoring, and notes for free. Changing your mind mid-review — "I said Redis but we're
  actually on Memcached" — is just a note on the answer block, which lands in the agent's
  next feedback batch like anything else.

### 5.7 Asking is only allowed before the first draft

`livedoc ask` fails once a revision exists. If the agent discovers a genuine fork during
revision, it writes it into *Open questions* instead of interrupting with a new modal. This
keeps the state machine linear and keeps everything the human needs to respond to in one
surface.

---

## 6. Phase 2 — the document model

### 6.1 Blocks

The plan is markdown. The server splits it into **blocks**: a heading, a paragraph, a code
fence, a table, a blockquote, or a *single list item*. Blocks are the unit of everything —
addressing, anchoring, progress, and comment targets.

List items are individually addressable, which is not the obvious choice but is the correct
one: a task list is the part of a plan people most want to comment on line by line, and it
is what `livedoc progress <id>` ticks off. Consecutive items are styled to read as one list.

### 6.2 Ids

Each block has an id. The agent writes them explicitly:

```markdown
- [ ] Add `RateLimiter` backed by Redis, 100 req/min per key {#t-limiter}
```

The `{#id}` marker is stripped from the rendered output. Blocks without one get an id
derived from a hash of their normalised content — stable across revisions as long as the
text does not change, so a document with no ids at all still behaves reasonably. This is
why any markdown file can be reviewed with the tool, not just agent-authored ones.

The instruction that matters, in `SKILL.md`: **reuse the id when you keep a block, even if
you reword it.** An id is a claim of continuity, and it is the strongest signal the
re-anchorer has.

---

## 7. Phase 3 — review

### 7.1 Anchoring across revisions

The hard problem. The agent rewrites the document repeatedly and every note must stay
attached to the thing it was about. A note stores the block id, the quoted text, and ~40
characters of surrounding context.

On every revision the server re-resolves every note, in this order:

| # | Test | Result |
| --- | --- | --- |
| 1 | Quote still present in the original block | `exact` |
| 2 | Quote plus context found in another block | `moved` |
| 3 | Quote alone found in another block | `moved` |
| 4 | Best block by word-bigram similarity (Dice ≥ 0.35) | `approximate` |
| 5 | Nothing matches | `orphan` |

`approximate` and `orphan` are surfaced in the UI ("moved", "text is gone") rather than
hidden. A note that quietly reattaches to the wrong paragraph is worse than one that admits
it lost its anchor, because the human has no way to notice the first case.

Anchoring is deliberately conservative about degrading: it is allowed to say it does not
know. The failure mode this avoids is the one that erodes trust — a review tool that
silently drops feedback gets abandoned after the first time it happens.

### 7.2 The note lifecycle

`new` → (human presses Send) → `sent`. That is the whole lifecycle.

There is no reply thread and no resolve button. The agent's reply *is* the next revision of
the document — if a note did not land, that is visible by reading the block it was attached
to. Adding a second channel where the agent explains itself in prose would duplicate the
document and give the human two places to read instead of one.

Notes are never deleted once sent. Unsent notes can be deleted by their author.

### 7.3 The durable record

`.livedoc/comments.json` holds every note ever left on the plan: the quoted text, the body,
which revision it was written against, the resolved anchor, and whether the agent has seen
it. It is meant to be committed.

```
.livedoc/
  comments.json              every note (committed)
  answers.json               clarify answers (committed)   [proposed]
  approved-<timestamp>.md    the frozen contract (committed)
  revisions/NNN.md           every draft the agent pushed  (ignored)
  session.json               pid, port, url                (ignored)
```

## 8. Phase 4 — build

On approval the document is frozen to `.livedoc/approved-<timestamp>.md` with every note
appended, and (proposed) the answers prepended. That file, not the conversation, is the
contract. The distinction matters after a context compaction, when the agent's memory of
what was agreed is the least reliable thing available and a file on disk is the most.

The tab does not close. It switches to showing progress against the approved plan, ticked
off with `livedoc progress <block-id> done`. The human can follow along without watching a
terminal.

If the agent finds the approved plan is wrong mid-build — a dependency that does not exist,
an assumption that does not hold — it stops, revises, pushes, and returns to review for a
fresh approval. Improvising around an approved plan defeats the point of having approved it.

---

## 9. Process architecture

### 9.1 The core constraint

The agent's turn is synchronous. Human review is not. A foreground server that waits for a
human gets killed by the CLI's per-command timeout.

The resolution has two parts:

**A detached daemon owns the document.** `livedoc start` spawns it, waits for a single JSON
line on stdout confirming the port, then unrefs and exits. The daemon outlives every
individual command.

**`wait` long-polls with a timeout sentinel.** It blocks server-side until an event or until
its timeout, then returns `{"status":"timeout"}`. The agent calls it again. The tab never
notices, and no single command runs long enough to be killed.

This is the design decision most likely to be undone by someone who has not hit the problem,
so: the sentinel is not a workaround, it is the mechanism. A `wait` that blocks indefinitely
works in testing and fails in every real agent harness.

### 9.2 HTTP surface

Bound to `127.0.0.1` only.

| Route | Purpose |
| --- | --- |
| `GET /api/doc` | Snapshot: blocks, notes, revision, status |
| `GET /api/events` | SSE stream — revisions, notes, status, progress |
| `GET /api/wait?timeout=` | Long poll, the agent's only blocking call |
| `POST /api/comments` | Add a note |
| `DELETE /api/comments/:id` | Remove an unsent note |
| `POST /api/send` | Flush the batch, wake the agent |
| `POST /api/approve` | Freeze and wake the agent |
| `POST /api/reload` | New revision from disk |
| `POST /api/progress` | Tick off a block |
| `POST /api/questions` | Post a question set *(proposed)* |
| `POST /api/answers` | Submit answers, wake the agent *(proposed)* |
| `POST /api/shutdown` | Stop the daemon |

### 9.3 Zero dependencies

No runtime dependencies, including no markdown library — block splitting and rendering are
about 250 lines of the package. The reasoning: this installs globally on developer machines
and runs a local HTTP server, so the supply chain is worth keeping at zero, and block
boundaries need to be controlled precisely for anchoring anyway. A general markdown parser
would have to be wrapped to recover exactly the boundaries the anchorer needs.

Cost: the markdown subset is limited. Nested lists render flat past one level, and setext
headings and reference links are unsupported. Acceptable for plan documents; worth revisiting
if the tool is used for prose.

---

## 10. Interface

The document reads like a manuscript — serif, one 640px column — and the chrome reads like a
terminal: monospace, uppercase, hairline rules. The contrast is deliberate. The document is
the thing being considered; the chrome is the machine around it.

Notes live in a right-hand margin at the vertical position of the text they are about,
stacking downward when they collide, with a hairline curve connecting each note back to its
anchor. This is the one place the design spends any effort: the margin is what makes the
review feel like marking up a proof rather than filling in a form.

Below 1040px the margin collapses and notes stack under the document.

Selecting text raises a single **Add note** button. There is no toolbar and no formatting —
the only thing you can do to the document is talk about it.

## 11. Skill contract and portability

Both Claude Code and Copilot CLI load skills as a directory containing `SKILL.md`, and both
let the user invoke one by name with a leading slash. The directories differ:

| Agent | Project | Personal |
| --- | --- | --- |
| Claude Code | `.claude/skills/` | `~/.claude/skills/` |
| GitHub Copilot CLI | `.github/skills/` | `~/.copilot/skills/` |

`livedoc init` asks which agent and which scope, then copies the skill in. All behaviour
lives in the CLI and `SKILL.md` is only the loop, so one skill file serves both agents with
no conditionals. This is also why the frontmatter stays to `name` and `description` — the
portable core of the Agent Skills standard, with no tool-specific fields.

## 12. Failure modes

| Situation | Behaviour |
| --- | --- |
| Human walks away | `wait` times out; after ~4 timeouts the agent reports the URL and ends its turn |
| Daemon dies mid-wait | `wait` exits non-zero with a clear message; `start` is idempotent and reattaches |
| `start` called twice | Reuses the live session, reloads the file, returns the same URL |
| Port in use | Scans upward from 4317, up to 25 ports |
| Agent forgets block ids | Content-derived ids; anchoring falls back to quote matching |
| Agent renames every id | Anchors degrade to `moved` or `approximate`, flagged in the UI |
| Notes sent while agent is building | Delivered on the agent's next `wait`; it decides whether to stop |
| Human never answers questions *(proposed)* | Agent drafts with assumptions in *Open questions* |

## 13. Non-goals

- **Not a document editor.** No collaborative cursors, no rich text, no human edits.
- **Not multiplayer.** One local reviewer. Multiple tabs work but there is no identity model
  and last write wins.
- **Not a diff viewer.** Changed blocks flash on revision; there is no per-word diff. A plan
  is short enough to re-read, and diff noise would compete with the notes for attention.
- **Not remote.** Binds to loopback. Remote review needs an auth story this does not have.
- **Not a task tracker.** Progress display ends when the session ends.

## 14. Open questions

1. **Does the clarify phase survive contact with real use, or does it get skipped every
   time?** The honest risk is that it is a speed bump on the way to the plan. The mitigation
   is the tight cap and the "would the document differ" test, but this is an empirical
   question and the feature should be cut if the answer is no.
2. **Should approval be per-section?** Approving a long plan is currently all-or-nothing.
   Per-section sign-off would let the agent start on settled parts while the rest is debated,
   at the cost of a much more complex state machine.
3. **Should `comments.json` be per-plan rather than per-directory?** Today one `.livedoc`
   directory accumulates notes across successive plans. Fine for a feature branch, messy for
   a long-lived repository.
4. **Is the six-question cap the right number?** Guessed, not measured.

---

*This document is reviewable with the tool it describes: `livedoc start DESIGN.md`. It has
no explicit block ids, which is the case content-derived ids exist to handle.*
