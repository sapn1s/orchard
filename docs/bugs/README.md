# Bug tracker — accumulating-context tickets

> **Reading this in the public repository?** Ticket logs cite screenshot paths
> under `docs/bugs/assets/`. Those files are deliberately not published: they are
> raw captures of a working dashboard, and their pixels carry home paths,
> usernames and private session titles that no text scan can see. The citation
> lines are left in place rather than rewritten, because they are part of the
> honest record of what each agent actually looked at — a dead path here means
> "this evidence exists and was not published", not "this file is missing".

In-repo issue tracking where **each ticket is the issue's durable memory**. The
problem this solves: multi-agent fixing cold-starts every attempt, re-derives
context, and regresses — a bug gets "fixed" three times and stays broken because
each agent lost what the last one learned. Here, context accumulates on the
ticket, so attempt N inherits attempts 1..N-1 and does not repeat their misses.

## The core mechanism: the Activity log is APPEND-ONLY

Every ticket has an `## Activity log (append-only)` section. Every agent that
touches the issue MUST:

1. **Read the whole ticket first** — especially every prior log entry. You
   inherit all prior diagnosis, every approach tried, and why each fell short.
2. **Not repeat a failed approach** the log already records, unless you state
   precisely why it will differ this time.
3. **Append your own dated entry** (never edit or delete a prior one) with:
   what you understood, what you changed (files + commit sha once committed),
   what you **verified** (commands + PASS/FAIL lines + screenshot paths), what
   is still open, and — if not fully solved — a precise **handoff**: "next agent
   should try X because Y." A dead end with a handoff is a valid outcome; a
   silent "done" that wasn't is the failure this whole system exists to prevent.
4. **Run the FULL relevant verify suite**, not just your own new test, before
   claiming a fix — anti-regression. If your change touches a file another
   ticket also touches, run that ticket's test too.
5. **Do not verify your own fix into VERIFIED.** For anything above `trivial`/docs-only,
   the ticket needs a `Verified-by:` line naming a clean-room verification DISPATCH
   (`node scripts/independent-verify.mjs` → `dispatch <provider> run <id>`, never a Task
   subagent, which shares the fixer's context) that ran a case your own fixture does not
   cover — you wrote the fixture, so it can only test what you already thought of
   (`docs/prompts/patterns/VERIFY.md`; `npm run board:check` warns if it is missing).
6. **Answer the closing question when you close a ticket**: TEMPLATE.md's
   "**Symptom of a deeper design flaw?** (no / yes → ARCH-### filed)" — one line,
   required, so a structural suspicion is handed forward instead of dropped
   (WA §N; the mechanical half is `scripts/arch-watch.mjs`, see
   `docs/ARCHITECTURE-REVIEW.md`).

## Files

- `INDEX.md` — the board.
- `<ID>-<slug>.md` — one ticket. IDs: `BUG-NNN`, `FEAT-NNN`, `DEPLOY-NNN`,
  `ARCH-NNN`.
- `assets/` — screenshots, named `<ID>-*.png`.
- `TEMPLATE.md` — the shape, including the Context pack + Activity log.
- `TEMPLATE-ARCH.md` — an `ARCH-NNN` ticket: the container for a
  **re-architecture decision** (violated invariant, options + trade-offs,
  migration path, proof bar), filed by a human after the recurrence detector
  raises a question. Symptom framing is forbidden there — see
  `docs/ARCHITECTURE-REVIEW.md`.
- `.arch/` — derived, git-ignored: the recurrence detector's findings for this
  project's Needs-You rail. Never hand-edited.

## Status: OPEN → IN-PROGRESS → VERIFIED → DONE. Also BLOCKED, NOT-A-BUG.

## How to WRITE a field — `../TICKET-WRITING.md`

`TEMPLATE.md` and the schema say which fields exist and how long they may be.
They cannot say how to write them, and a 60-word summary can be written in
exactly the register that made this board hard to read. **`docs/TICKET-WRITING.md`
is the writing contract** — per field: what belongs in it, what does not, and a
good/bad pair drawn from real tickets on this board. It settles the four places
our tickets actually go wrong: log-line titles, summaries that lead with the
mechanism instead of what the user saw, symbol names in the layer a person
reads, and numbers kept for decoration.

Read it before writing a ticket. `node scripts/verify-ticket-writing-contract.mjs`
checks the mechanical half (title shape and length, identifiers in the human
layer, runaway sentences, decision-field shape); the rest is judgement and is
labelled as such rather than faked as a test.

## Tickets that need a human decision — the shape is ENFORCED, not conventional

A ticket blocked on a person is only really blocked on them if the person is
actually asked. Two things have to be true, and `npm run board:check` now FAILS
if either is missing:

1. **The options are machine-readable.** `ticketDecision()` (`src/server/board.ts`)
   parses exactly one shape, and that parse is what renders the Decide card on
   the dashboard's Needs-You rail:

   ```markdown
   ## Decision — should we encapsulate the fields, or just guard them?

   - **A — encapsulate.** What it costs, what it buys, what it gives up.
   - **B — add a lint guard.** The cheaper alternative, and its trade-off.
   ```

   The heading must contain the word **Decision** (a `## Question` section also
   works). At least **two** bullets. The key is a short token (`A`, `B`, `1`,
   `2` — max 6 chars), an em/en-dash or hyphen separates it from the label, and
   `KEY — label` sits inside **one** bold run; the rest of the bullet is the
   description and may wrap onto indented continuation lines.

2. **The ticket is marked as awaiting you** — Owner `👤` on its `INDEX.md` Open
   row. The rail reads only `👤` rows, so a perfectly-formed decision on a `—`
   row is still invisible. INDEX is orchestrator-owned (see the rule above): ask
   for the flip rather than editing it in a fix lane.

Optionally add `Recommended: <key>` to the `- **Status:**` line; it is validated
against the parsed keys and dropped if it matches none, so it can never badge an
option that does not exist.

**What does NOT parse, and this is deliberate:** numbered prose paragraphs, plain
bullets, and bold text anywhere other than the `KEY — label` head. Loosening the
grammar would let the rail fabricate choice buttons out of ordinary prose, which
is BUG-025. So the requirement is on the ticket, not the parser.

Why it is enforced rather than documented: ARCH-005 declared "NEEDS A HUMAN
DECISION", argued four options at length in numbered prose, and reached the user
as nothing at all — no card, no question, silently. Three other open tickets were
in the same state. Nothing failed, which is why it lasted. Keep your argument
prose; the bullets are a formatting requirement, not a rewrite.

## Hard rules for any agent on a ticket
- NEVER restart/kill the server on port 4317 (a live session depends on it).
  Verification spawns its own scratch server on a free port; kill by pid, never
  `pkill`.
- Verification is the deliverable, not the code. A check that passes on
  empty/missing input is worse than none (`docs/prompts/WORKING_AGREEMENT.v2.md`).
- Do NOT commit. Leave changes in the working tree.
- Edit ONLY your ticket file and the code for your fix. Do **NOT** edit
  `INDEX.md` — the orchestrator owns it and rebuilds it from ticket statuses
  (two agents editing INDEX clobber each other's rows).
- Two agents must not edit the same code file at once — the orchestrator
  serializes same-file tickets (frontend `app.js`/`drawer.js` especially).

## Concurrency rules for the ORCHESTRATOR
Git-safety and same-file serialization are **universal** rules — the single
source of truth is `docs/prompts/WORKING_AGREEMENT.v2.md` §I (orchestrate /
serialize same-file) and §J (never `git add -A` with agents in flight; commit
explicit file lists). They are not restated here to avoid the two copies drifting.

Board-operational specifics on top of those:
- Commit each agent's ticket as it lands, on files no in-flight agent touches.
  **Rebuild `INDEX.md` yourself from the ticket files** (authoritative); do not
  trust concurrent INDEX edits.
- If two tickets must touch the same file, serialize them, or give the agents
  `isolation: worktree` so their trees don't collide (see FEAT-005).
- The `git add -A` hazard is concrete here: it once swept BUG-004's uncommitted
  code into the unrelated triage commit 7f35195. Explicit file lists only.

## Why this generalizes (see FEAT-005)
This pattern — a per-issue append-only memory that every worker reads and
extends — is not app-specific. The durable form is a claude-station feature
(tickets attached to sessions, dispatching fix-sessions that read/append the
ticket). Tracked as FEAT-005.
