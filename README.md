# livedoc

A coding agent writes an implementation plan. The plan opens in a browser tab. You
highlight parts of it and leave notes. The agent revises. When the plan is right you
approve it, and the agent builds from the frozen document.

See [`docs/prd.md`](docs/prd.md) (product design) and
[`docs/technical-design.md`](docs/technical-design.md) (implementation design).
Zero runtime dependencies, enforced by `scripts/no-deps-check.js`.

## Install

```bash
npm install -g live-design-doc
```

This puts both `live-design-doc` and the shorter `livedoc` on your PATH. The first time
you run it interactively, it offers to install the agent skill for Claude Code, GitHub
Copilot CLI, and/or OpenAI Codex CLI (personal scope). `livedoc init` does the same
per-project or non-interactively, any time. The prompt never appears when the CLI is
driven by an agent (no TTY).

From a checkout:

```bash
npm install && npm run build && npm link
```

## Commands

| Command | What it does |
| --- | --- |
| `livedoc start <plan.md>` | Start (or reattach to) a session for this plan, open the browser |
| `livedoc sessions` | List the open plans and their ids |
| `livedoc ask <questions.json>` | Post clarifying questions — before the first draft only |
| `livedoc wait [--timeout <sec>]` | Block until feedback / approval / answers, or the timeout sentinel |
| `livedoc push` | Reload the plan file as a new revision (re-anchors all notes) |
| `livedoc progress <block-id> [done]` | Tick off a block of the approved plan |
| `livedoc stop [--all]` | Close this session — `--all` shuts the daemon down |

Every command prints one line of JSON on stdout; human-readable messages go to stderr.
`wait` exits 0 on `{"status":"timeout"}` (loop again) and non-zero only when the daemon
is unreachable (run `start` again).

## Notes

Highlight text, leave a note, press Send — the agent picks the batch up on its next
`livedoc wait`. Once you're done with a note, the **✓** on it collapses it behind a
"N done notes" toggle so the margin doesn't accumulate across revisions. That's a view
control of your own: dismissed notes are never deleted, they stay in `comments.json` and
in the approved record, and the agent never sees the flag. Whether a note actually landed
is answered by reading the next revision, not by a checkbox.

## Sessions

Several plans can be under review at the same time — one session per plan file, all
served by one daemon on one port. `livedoc start` on a second plan adds a session; it
never disturbs the first one's notes, revisions, or an agent waiting on it. The
**sessions** button at the top left of the browser lists every open plan and switches
between them instantly.

Each command targets a session by, in order: `--session <id>`, the `LIVEDOC_SESSION`
environment variable, the session `livedoc start` last opened in this directory, or —
when none of those apply — the daemon's most recently active one. `start` returns the
id it opened:

```bash
livedoc start PLAN.md --no-open
# → {"status":"ok","url":"http://127.0.0.1:4317","session":"plan-1d972b4a",...}

export LIVEDOC_SESSION=plan-1d972b4a   # pin this terminal to that plan
```

An agent working a plan should pin it that way: the environment variable beats the
shared `current` pointer, so a second agent starting its own plan in the same
repository can never steal the first one's session.

`livedoc stop` closes the current session and leaves the rest running; closing the last
one stops the daemon too. Closing a session never deletes its files — `livedoc start`
on the same plan picks it back up.

## Layout

```
.livedoc/
  sessions.json                        the open plans (committed)
  sessions/<id>/
    comments.json                      every note ever left (committed)
    answers.json                       clarify answers (committed)
    approved-<timestamp>.md            the frozen contract (committed)
    revisions/NNN.md                   every pushed draft (ignored)
    pending.json                       undelivered agent events (ignored)
  daemon.json                          pid, port, url (ignored)
  current                              the session this directory is on (ignored)
```

A session id is `<plan-slug>-<hash>`, derived from the plan's path — so it is stable
across restarts and identical in a fresh clone. A pre-existing flat `.livedoc/` is
migrated into `sessions/<id>/` automatically on the next `livedoc start`.

## Development

```bash
npm test    # build + unit + e2e (spawns a real daemon)
npm run check
```
