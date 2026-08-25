# FEAT-058 — ticket dashboard: search/browse/reopen tickets in a second tab (minimal Jira, file-backed)

- **Status:** VERIFIED 2026-08-09 — 30/30 (must-FAIL proven at a clean HEAD worktree); committed 0ddedb8
- **Area:** claude-station UI (new route) + server (board read/write) — human side of the board
- **Reported:** 2026-08-09 by user ("we have tickets on the right panel but it doesn't show all,
  nor should it. I'd want to SEARCH some feature we added, see the ticket, its status, to know if
  it's considered done — or if not, reopen it / add info so a later orchestrator sees it. A manual
  dashboard of tickets and their interactions, like Jira but minimalistic … probably a new tab, so
  I can view tickets AND ask the orchestrator about them while exploring")

## Placement decision (do not re-litigate without reason)
A **route in the same app**: `#/tickets` (list) and `#/tickets/<ID>` (detail), openable in a second
BROWSER TAB (and ctrl/cmd-click from the rail). Rationale: the session tab stays live so the user
can converse with the orchestrator while browsing; URLs are bookmarkable and shareable (the
orchestrator can hand the user a direct link to a ticket); no second stack, no modal that blocks
the conversation. The rail stays the "what needs you NOW" surface; this is the full archive.

## Scope
1. **List view**: every ticket of the selected project (and a way to see other projects with
   boards). Columns: id, title, status (Open/Done/decision), owner (🤖/👤/—), severity, last
   activity date. Sort + filter by status/owner/severity/area.
2. **Search**: id, title, AND full ticket body text (the activity logs are where the real content
   is). Server-side grep-ish over `docs/bugs/*.md` — reuse the existing ripgrep-backed content
   search plumbing if it fits; otherwise a small scoped reader. Show matching line context.
3. **Detail view**: the ticket's full markdown rendered (reuse the transcript markdown renderer),
   with the Activity log readable — this is the same content agents read (FEAT-053's modal should
   reuse this renderer rather than duplicating it).
4. **Interactions that WRITE (the point of the feature)**:
   - **Append a note** — dated, append-only, clearly attributed to the user (e.g.
     `### <date> — user (via dashboard)`), never rewriting prior entries (§K).
   - **Reopen a Done ticket** — flips its Status header back to an open state + appends a note
     saying why; the board index must then reflect it (invoke the board tool's own reconciliation —
     `board.mjs gen` semantics — rather than hand-editing INDEX, and preserve the curated Owner/
     Status/Commit columns it protects).
   - **Mark 👤 / needs-you** so it surfaces in the rail; and the reverse.
   - **File a new ticket** from the dashboard (id allocation via the board tool's rules, template
     from TEMPLATE.md / TEMPLATE-ARCH.md).
   - OPTIONAL if cheap: edit severity/area.
5. **Orchestrator visibility**: because everything is files, the next session's injected board
   snapshot + the rail pick changes up with no extra plumbing — verify this end-to-end rather than
   assuming it.

## Guards
- **Append-only discipline**: user notes append; existing log entries are never rewritten. A status
  header change is the only in-place edit permitted, and it is recorded in the log.
- **Concurrency**: an agent may be editing the same ticket. Write safely (read-modify-append with a
  freshness check; fail loudly rather than clobber) — never silently overwrite an agent's entry.
- **Board integrity**: after any write, the board must still pass `board:check`. If a write would
  cause drift, fix it via the tool's reconciliation, not by hand-editing INDEX.
- Read-only browsing must never mutate anything (no accidental status changes on open).

## Verification (REQUIRED, user-observable, must FAIL pre-change)
Real browser, scratch project with a seeded board: list renders all tickets with correct
status/owner; filters work; full-text search finds a phrase that exists ONLY in an activity log
(proves body search, not title search); detail renders the real file (assert an activity-log line);
appending a note writes an append-only dated entry to the file on disk and the prior entry survives
byte-identical; reopening a Done ticket moves it to Open in INDEX via the tool, `board:check` stays
green, and a NEW session for that project receives the reopened ticket in its injected board
snapshot (the end-to-end claim); marking 👤 makes it appear in the rail; a second tab can be open
on `#/tickets` while the session tab stays live and functional. Anti-regressions: verify:board-tool,
verify:needs-you-rail, verify:feat-047-findings-rail, typecheck. (`verify:ui --offline` is RED at
HEAD for an unrelated reason — BUG-036; don't chase it.)

## Activity log (APPEND-ONLY)
### 2026-08-09 — orchestrator
- Filed from user request; placement decided (route + second tab, not modal). Sequenced BEFORE
  FEAT-053's ticket modal so the modal reuses this detail renderer instead of duplicating it.

### 2026-08-09 — agent (build)
- **Understood:** the rail is the "needs you NOW" slice; this is the full archive behind it, and
  the whole point is that a human edit made here is READ BY THE NEXT SESSION with no extra
  plumbing — so the end-to-end claim (§5), not the UI, is the deliverable.
- **Changed:**
  - `src/server/tickets.ts` (new) — the read/write layer over `docs/bugs/`: `listTickets`,
    `searchTickets`, `readTicket`, `appendNote`, `reopenTicket`, `setNeedsYou`, `createTicket`,
    `nextTicketId`.
  - `src/server/index.ts` — ADDITIVE only: one import, `GET /api/boards`, and one route block
    `/api/projects/:id/tickets[...]` (list+search / create / detail / note / reopen / owner).
  - `scripts/board.d.mts` (new) — type surface so the server can call the board TOOL's own
    `genBoard`/`checkBoard` (same pattern as `onboard.d.mts`); the tool stays an executable .mjs.
  - `public/index.html`, `public/styles.css`, `public/lib/route.js` (`parseTicketsHash` /
    `formatTicketsHash`, kept OUT of `parseHash` so the session-restore contract is untouched),
    `public/lib/api.js`, `public/app.js` (the `#/tickets` view; `ticketDetailNode()` is the
    REUSABLE renderer FEAT-053's modal must call rather than duplicating).
  - `public/app.js` `needsStatusRow()` — the rail's "Open ticket" affordance now deep-links to
    `#/tickets/<ID>` (target=_blank ⇒ second tab) instead of `file://<path>`; the file path stays
    on the tooltip. `scripts/qa/BUG-025-needs-you-question.spec.ts` updated to assert the new,
    stronger contract (real deep link + second tab + file still named) — BUG-025's guarantee was
    "the affordance is real, not a decorative `#`", and that is now more true, not less.
  - `scripts/verify-ticket-dashboard.mjs` (new, 30 checks).
- **Concurrency approach (§Guards):** three layers, not one. (1) A user note is written with
  `fs.appendFileSync` — prior bytes are never read-and-rewritten, so an agent's entry cannot be
  lost by construction; the verify asserts the file is a byte-identical PREFIX after the write.
  (2) Every write carries the `rev` (`<mtimeMs>:<size>`) the client read; a mismatch is a 409
  carrying the current rev, and a write with NO rev is refused too (a check that can be skipped is
  no check). (3) The reopen's status-header edit — the ONLY in-place edit in the feature —
  re-checks freshness a SECOND time immediately before `writeFileSync`, and the logged reason is
  appended separately. INDEX.md is reconciled by `genBoard()` + `checkBoard()` from the board tool,
  never hand-rewritten; the one curated cell the tool cannot derive (Open.Owner) is set as a single
  cell edit and handed straight back to `genBoard`, which preserves it.
- **Design note worth inheriting:** reopening also sets Owner `👤`. Not cosmetic — `boardStateSection()`
  composes the injected snapshot from 👤/🤖 rows ONLY, so an owner-less reopened row would be
  invisible to the very agent it was reopened for, and the feature's headline claim would silently
  be false.
- **Verified:** `node scripts/verify-ticket-dashboard.mjs` → **30/30 PASS**, including:
  search finds a phrase that exists ONLY in an activity log (`:14`, `inActivityLog`);
  browsing mutates nothing (mtime+size of every ticket file unchanged);
  note append is byte-identical-prefix; a STALE rev is refused 409 with the agent's concurrent
  entry intact; reopen flips the header, logs why, moves the row Done→Open through the tool with
  the 🤖 row's curated columns preserved, `board:check` green after every write;
  **END-TO-END** — a REAL new haiku session for the scratch project replied
  `"FEAT-902, BUG-901"` when asked to read back the "Needs you" ids from its own injected Project
  state, i.e. the reopened ticket reached the model's context (plus the deterministic
  `boardStateSection` + `appendToSystemPrompt` fold);
  filing allocates BUG-903→BUG-904 from TEMPLATE.md with no placeholder log entry;
  two tabs — dashboard in one, live session view in the other.
  MUST-FAIL-PRE-CHANGE proved by running the same script against a clean `git worktree` at HEAD
  (`VERIFY_TICKETS_ROOT=…`): 7 FAIL then a fatal (no routes, no view). Screenshots:
  `docs/bugs/assets/FEAT-058-{list,search,detail,reopened,second-tab}.png`.
- **Anti-regressions:** `verify:board-tool` 13/13 PASS · `verify:needs-you-rail` 17/17 PASS ·
  `verify:bug-025-question` PASS · `typecheck` PASS · `verify:ui --offline` RED — **identical**
  failure at HEAD in a clean worktree (BUG-036, `paintQueue`), not chased.
  `verify:feat-047-findings-rail` 12/18 — and 12/18 AT HEAD too under the same conditions: the
  suite is order-dependent, because once `docs/bugs/.arch/findings.json` exists in the tree it runs
  against, FEAT-056's arch-recurrence rows also land on the methodology-home rail and the FEAT-047
  assertions (written before FEAT-056) count 7 findings where they expect 2. Proved by running it
  TWICE in a pristine HEAD worktree: 15/18 then 12/18, with none of this ticket's files present.
  Not a regression from FEAT-058; worth its own ticket.
- **Still open / handoff:** (a) the detail view shows the ticket title twice (once as the page
  title, once as the rendered file's own H1) — cosmetic, deliberately left rather than filtering
  the file's first line, since "this is the real file" is the point. (b) Filing does not let the
  user pick the Area from the project's existing areas. (c) FEAT-053 should call
  `window.__station.ticketDetailNode(ticket, {compact:true})` for its modal.
- **Symptom of a deeper design flaw?** no — this is new surface over an existing, healthy
  single-source-of-truth (files on disk, one board tool). The one structural pressure noticed is
  that "Owner" lives ONLY in INDEX.md while everything else about a ticket lives in the ticket
  file, which is why a WRITE has to touch two places and why reopen needs the gen→stamp→check
  dance; if a third writer of Owner ever appears, that split is the ARCH ticket to file.

### 2026-08-12 — board hygiene: closed to Done (verified + committed long ago)
- Status OPEN→VERIFIED (the board row said "verified, committing", stale — it was committed long
  ago). The 2026-08-09 build entry is the evidence: 30/30 (body-search over an activity log,
  byte-identical append, stale-rev 409, reopen→gen→check, END-TO-END new-session board injection),
  must-FAIL proven at a clean HEAD worktree. Committed `0ddedb8` ("ARCH-001 phase 1: single liveness
  authority + FEAT-058 ticket dashboard").
