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
| `livedoc start <plan.md>` | Start (or reattach to) the review daemon, open the browser |
| `livedoc ask <questions.json>` | Post clarifying questions — before the first draft only |
| `livedoc wait [--timeout <sec>]` | Block until feedback / approval / answers, or the timeout sentinel |
| `livedoc push` | Reload the plan file as a new revision (re-anchors all notes) |
| `livedoc progress <block-id> [done]` | Tick off a block of the approved plan |
| `livedoc stop` | Shut the daemon down |

Every command prints one line of JSON on stdout; human-readable messages go to stderr.
`wait` exits 0 on `{"status":"timeout"}` (loop again) and non-zero only when the daemon
is unreachable (run `start` again).

## Layout

```
.livedoc/
  comments.json              every note ever left (committed)
  answers.json               clarify answers (committed)
  approved-<timestamp>.md    the frozen contract (committed)
  revisions/NNN.md           every pushed draft (ignored)
  session.json               pid, port, url (ignored)
```

## Development

```bash
npm test    # build + unit + e2e (spawns a real daemon)
npm run check
```
