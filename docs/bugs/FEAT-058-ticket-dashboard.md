```orchard-ticket
{
  "id": "FEAT-058",
  "type": "feature",
  "title": "Tickets could only be browsed through the live session panel",
  "summary": "The board now has its own browsable page, opened in a second tab while a session stays live. People can search titles, ids and the full text of past activity, open a ticket, append a dated note, reopen a closed ticket, mark it as needing a person, or file a new one. The board's own reconciliation performs every write.",
  "impact_if_we_wait": "None outstanding. The browsing page shipped and the writes go through the board's own tooling, so the index cannot drift by hand-editing. Bounded: this was a missing reading and writing surface, never a risk to ticket files.",
  "current_need": "Nothing is outstanding. The dashboard suite proved the pre-change failure at a clean checkout and then passed in full, with the board and rail suites and the standing type check clean.",
  "severity": "medium",
  "area": "Ticket board",
  "reported": "2026-08-09",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-12",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-09",
      "question": "Should the ticket archive be a route in the existing app, or a separate surface?",
      "mode": "single",
      "options_keys": [
        "route",
        "separate"
      ],
      "chosen": "route",
      "chosen_on": "2026-08-09",
      "chosen_by": "user",
      "note": "A route in the same app, opened in a second browser tab, so the session tab stays live and ticket links are bookmarkable and shareable. Recorded as settled: do not re-litigate without reason."
    }
  ],
  "success_criteria": [
    "The list shows every ticket of a project with its status and owner",
    "Filtering by status, owner, severity and area narrows the list",
    "Searching a phrase that exists only in an activity log finds that ticket",
    "A ticket's full text renders, including its activity entries",
    "Appending a note adds a dated entry and leaves prior entries byte-identical",
    "Reopening a closed ticket moves it to open in the index and the board check stays clean",
    "A new session for that project receives the reopened ticket in its board snapshot",
    "Marking a ticket as needing a person makes it appear in the rail",
    "Browsing a ticket changes nothing on disk"
  ],
  "code_refs": [
    {
      "path": "docs/bugs",
      "symbol": null,
      "note": "the ticket files the page reads and appends to"
    },
    {
      "path": "docs/bugs/TEMPLATE.md",
      "symbol": null,
      "note": "template used when filing a new ticket from the page"
    },
    {
      "path": "docs/bugs/TEMPLATE-ARCH.md",
      "symbol": null,
      "note": "template for architecture tickets"
    }
  ],
  "related": [
    {
      "id": "BUG-036",
      "relation": "see_also"
    },
    {
      "id": "FEAT-053",
      "relation": "see_also"
    },
    {
      "id": "FEAT-063",
      "relation": "blocks"
    },
    {
      "id": "FEAT-082",
      "relation": "blocks"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": true,
    "Migration and rollback": false,
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-058-ticket-dashboard.md",
    "sha256": "5783be9219e1742fb31b23abfdf5211cf664120eb9db58d1e09e01b3ad7a4aae",
    "bytes": 11648,
    "original_title": "ticket dashboard: search/browse/reopen tickets in a second tab (minimal Jira, file-backed)",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head section by section: the placement rationale, all five scope items, the four guards and the full verification list are present in the fields and body above.",
    "dropped": [
      "the verbatim quotation of the user's original request, whose content is carried by the summary and scope",
      "the emoji shorthand used for the owner column"
    ]
  }
}
```

# FEAT-058 — Tickets could only be browsed through the live session panel

## Diagnosis

### What was missing
The rail beside a session shows only what needs attention now, and deliberately does not show everything. There was no way to look up a feature added weeks ago, read whether it was considered done, or add information for a later orchestrator. The board files themselves were readable only by agents.

## Evidence

### What ran
- `verify:ticket-dashboard` — 30/30 passing, with the must-FAIL case proven at a clean HEAD worktree.
- `verify:board-tool` — 13/13 passing.
- `verify:needs-you-rail` — 17/17 passing.
- `typecheck` — clean.

Committed as `0ddedb8`.

`verify:feat-047-findings-rail`, `verify:ui` and `verify:bug-025-question` are named in the ticket's anti-regression list; no result for them is recorded here. `verify:ui --offline` was RED at HEAD for an unrelated reason (BUG-036) and was not chased.

## Implementation notes

### Placement (settled, do not re-litigate without reason)
A route in the same app: `#/tickets` for the list and `#/tickets/<ID>` for the detail, openable in a second browser tab and via ctrl/cmd-click from the rail. The session tab stays live so the user can converse with the orchestrator while browsing. URLs are bookmarkable and shareable, so the orchestrator can hand over a direct link. No second stack and no modal that blocks the conversation.

### Scope as specified
1. List view over every ticket of the selected project, plus a way to reach other projects with boards. Columns: id, title, status, owner, severity, last activity date, with sort and filter by status, owner, severity and area.
2. Search across id, title and full body text — the activity logs hold the real content. Server-side, reusing the existing ripgrep-backed content search plumbing where it fits, showing matching line context.
3. Detail view rendering the ticket's markdown through the transcript markdown renderer, with the activity log readable. FEAT-053's modal should reuse this renderer rather than duplicating it.
4. Writes: append a dated, user-attributed note; reopen a closed ticket by flipping its status header and appending a reason; mark or unmark as needing a person; file a new ticket with id allocation and templates from the board tool's own rules. Editing severity and area was optional if cheap.
5. Because everything is files, the next session's injected board snapshot and the rail pick changes up with no extra plumbing — this was to be verified end to end rather than assumed.

### Guards
- Append-only: user notes append, existing entries are never rewritten. A status header change is the only permitted in-place edit and is itself recorded in the log.
- Concurrency: an agent may be editing the same ticket. Read-modify-append with a freshness check, failing loudly rather than clobbering an agent's entry.
- Board integrity: after any write the board must still pass its own check. Drift is fixed through the tool's reconciliation, preserving the curated owner, status and commit columns — never by hand-editing the index.
- Read-only browsing mutates nothing; opening a ticket cannot change its status.

## Verification plan

### As specified
Real browser against a scratch project with a seeded board, every case failing before the change:
- the list renders all tickets with correct status and owner, and filters work;
- full-text search finds a phrase present only in an activity log, proving body search rather than title search;
- the detail view renders the real file, asserted on an activity-log line;
- appending a note writes an append-only dated entry to the file on disk and the prior entry survives byte-identical;
- reopening a done ticket moves it to open in the index via the tool, the board check stays green, and a new session for that project receives the reopened ticket in its injected board snapshot;
- marking a ticket as needing a person makes it appear in the rail;
- a second tab can sit on the list while the session tab stays live and functional.

Anti-regressions: the board tool suite, the needs-you rail suite, the findings rail suite, and the type check.

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
