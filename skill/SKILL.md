---
name: livedoc
description: Draft an implementation plan the human reviews live in a browser with anchored notes. Use when writing any plan the human should approve before you build — start the session, push drafts, loop on livedoc wait, revise until approved, then build against the frozen plan.
---

# livedoc — live plan review

You write the plan; the human annotates it in a browser; you revise until they approve.
The document is yours alone to write. Their notes and answers are theirs alone — never
restate or summarise them, respond by changing the document.

Every command prints one line of JSON on stdout. Parse that; ignore stderr.

## The loop

1. **Start the session** (safe to re-run; it reattaches):

   ```bash
   livedoc start PLAN.md --no-open   # omit --no-open the first time so the tab opens
   ```

2. **Optionally ask clarifying questions — only before your first draft.**
   Write `questions.json` (kinds: `choice`, `multi`, `text`; hard cap 6, aim for ≤4):

   ```bash
   livedoc ask questions.json
   livedoc wait --timeout 300
   # → {"status":"answers","answers":[{"id":"scope","value":"search"}]}
   ```

   Ask a question **only if different answers produce materially different plans**, and
   **never ask what the repository can answer** — read the code instead. A skipped
   question is an answer: state your assumption in the plan's *Open questions* section.

3. **Write the plan to PLAN.md, then push it:**

   ```bash
   livedoc push
   ```

   Give every block you may refer to again an explicit id: `{#t-limiter}` at the end of
   the line. **When you keep a block across revisions — even reworded — keep its id.**
   The id is how the human's notes stay attached to your text.

4. **Wait for the human:**

   ```bash
   livedoc wait --timeout 300
   ```

   - `{"status":"timeout"}` — call `wait` again. After **4 consecutive timeouts**, stop:
     report the review URL to the human and end your turn.
   - `{"status":"feedback","notes":[...]}` — address **every** note by revising PLAN.md,
     then `livedoc push` and return to waiting. Each note has the quoted text and the
     block it anchors to. If you disagree with a note, say so *in the document* (e.g. in
     a rationale line or Open questions) — there is no chat channel.
     A note may reference project files as `@relative/path` (e.g. `@src/daemon/store.ts`)
     — **read every referenced file before revising**; the human pointed at it for a
     reason.
     Notes arrive ordered by `intent`: `blocker` (the plan is wrong here — resolve it or
     the human won't approve), `change`, `question` (answer it in the document, usually
     in the block it anchors to or Open questions), `nit` (batch these; don't let them
     drive structure). Address blockers first.
     A note may carry a `suggestion` — the human's proposed wording for the quoted text.
     It is input, not an edit: adopt it, adapt it, or decline it, but if you decline,
     say why in the document. You still own every word.
   - `{"status":"approved","approvedPath":"..."}` — the plan is frozen. Go to step 5.
   - Non-zero exit — the daemon died. Run `livedoc start PLAN.md` and wait again.

5. **Build from the approved file** at `approvedPath` — that file, not your memory of
   the conversation, is the contract. As you complete each task block:

   ```bash
   livedoc progress t-limiter done
   ```

   If mid-build you find the approved plan is wrong — a dependency that doesn't exist,
   an assumption that doesn't hold — **stop building**, revise PLAN.md, `livedoc push`,
   and return to the wait loop for fresh approval. Never improvise around an approved
   plan.

## Discipline

- New forks discovered after the first draft go in *Open questions*, not new modals
  (`livedoc ask` will refuse anyway).
- Task lists: one item per line, each with a checkbox and an id —
  `- [ ] Add RateLimiter {#t-limiter}` — these are what you tick with `progress`.
- Keep the plan skimmable: a human reads all of it every revision.
