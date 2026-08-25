```orchard-ticket
{
  "id": "BUG-025",
  "type": "bug",
  "title": "User-owned tickets showed response boxes without questions",
  "summary": "User-owned tickets without questions now appear as read-only attention items linking to the ticket. Question-bearing runtime decisions and tickets with explicit questions remain answerable. Interface, rail, and question regression suites passed, with type checking clean.",
  "impact_if_we_wait": "Without the fix, people cannot tell what response is expected and may submit meaningless answers. Bounded: this affects rail clarity and display-correctness, not ticket data or runtime decision delivery.",
  "current_need": "Treat the ticket as closed: interface, rail, and question regression suites passed, and type checking stayed clean.",
  "severity": "medium",
  "area": "Needs-You rail",
  "reported": "2026-08-04",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-04",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A user-owned ticket without a question shows a read-only attention item",
    "A runtime decision with a question shows a response field",
    "A ticket with an explicit question shows that question and a response field"
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "symbol": null,
      "note": "Renders answerable cards separately from read-only attention items"
    },
    {
      "path": "src/server/board.ts",
      "symbol": "readBoard",
      "note": "Marks board items as answerable only when they carry a question"
    }
  ],
  "related": [
    {
      "id": "FEAT-018",
      "relation": "see_also"
    },
    {
      "id": "FEAT-029",
      "relation": "see_also"
    },
    {
      "id": "FEAT-047",
      "relation": "see_also"
    },
    {
      "id": "FEAT-053",
      "relation": "see_also"
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
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-025-needs-you-card-lacks-question.md",
    "sha256": "e64d4335e2467c1a7b0357c4583e83928620275e2796ea3350e7c98ab25beaba",
    "bytes": 8362,
    "original_title": "Needs-You rail renders a contextless answerable card for a bare 👤 ticket (title only, no question)",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the supplied ticket text; the symptom, expected distinction, implemented direction, evidence, affected code, and related features are preserved.",
    "dropped": [
      "optional wording variations for opening the linked ticket",
      "orchestrator discipline reminder already corrected"
    ]
  }
}
```

# BUG-025 — User-owned tickets showed response boxes without questions

## Diagnosis

The rail treated every user-owned ticket as an answerable decision. Ownership is board status, not evidence of a question, so a title-only ticket received a blank response field with no understandable ask.

## Evidence

`verify:ui` passed 3/3, `verify:needs-you-rail` passed 17/17, and `verify:bug-025-question` passed 1/1. An additional 16/16 tally was recorded without an adjacent suite name. Type checking was reported clean. `verify:runtime-decision` was named without a recorded result.

## Implementation notes

Separate question-bearing decisions from user-owned status items. Only items carrying a question receive a response field. Status-only items render as read-only attention rows linking to their tickets. An explicit `## Question` block may supply a ticket question.

## Verification plan

In a real browser, confirm that a user-owned ticket without a question has no response box. Confirm that a runtime decision and a ticket with an explicit question each show their question and a response field.

## Risks

Question detection must not hide legitimate runtime decisions or turn ordinary ticket content into an answerable prompt.

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed from user. Root: FEAT-018 made every 👤 ticket answerable; a 👤 ticket has no
  question. Also un-marked FEAT-039's spurious 👤 owner (it was board-status, not an ask).

### 2026-08-04 — agent (fixed + verified)
- **Understood:** 👤 is board STATUS, not a question. Split "answerable" from
  "status" at the source (`readBoard`), so a bare 👤 ticket never reaches the rail
  with a fake response field.
- **Changed (working tree, uncommitted):**
  - `src/server/board.ts`: new `ticketQuestion(dir,id)` parses an explicit
    `## Question` section out of a ticket file — the prose becomes `question`,
    any `- bullet`/`* bullet` lines immediately under it become `options`
    (mirrors a FEAT-029 runtime decision's shape). `readBoard()` now sets
    `item.kind='ticket'` + `item.file` (absolute path to the ticket) for every
    👤 row, and only sets `item.question`/`item.options` when `ticketQuestion`
    finds a `## Question` section. A bare 👤 ticket (no such section) still
    enters `board.needsYou` (it's genuinely open/user-owned) but carries no
    `question` — that's the signal the rail uses to distinguish status from ask.
    `BoardItem` interface doc updated to state the contract explicitly.
  - `public/app.js`: `needsCard(it)` now branches on `!it.question` FIRST →
    `needsStatusRow(it)`, a new read-only render: `.needs-card.status` with
    `data-kind="status"`, the ticket id/sev/title, and a `file://`-linked
    "Open ticket" anchor (`it.file`) — no `<textarea>`, nothing to submit. For
    an answerable card (decision OR ticket-with-`## Question`), if the ticket's
    parsed `question` text differs from its H1 `title`, a new `.nc-question`
    line shows it explicitly (so the card visibly asks something, not just
    displays the ticket title). FEAT-029 decision cards are untouched — the
    server already sets `question`==`title` for those, so the new branch and
    the extra `.nc-question` line never fire for `kind:'decision'`.
  - No changes to `src/server/index.ts` / `agent-bridge.ts` / `templates.ts`
    (other agents' scope) — the merge of runtime decisions into `needsYou`
    (FEAT-029) already sets `kind:'decision'` + `question`, so it flows through
    the SAME `if (!it.question)` branch unaffected.
- **Verified (all real, no mocking):**
  - `npm run verify:needs-you-rail` (extended; CDP + real brave + real server) —
    **17/17 PASS**. Seeded BOTH a `## Question`-bearing 👤 ticket (BUG-701, 2
    bullet options) and a bare 👤 STATUS ticket (BUG-703, no `## Question`) in
    the same project. Checks: the bare ticket's board item carries no
    `question`; the questioned ticket's rail card has the response field +
    both option buttons + the parsed question text; the bare ticket's card is
    `data-kind="status"` with NO textarea and a real `<a>` "open ticket" href;
    answering the questioned ticket removes ONLY that card (status card
    untouched) and append-only writes the answer to disk; a no-board project
    still shows the quiet empty state; narrow-viewport collapse still works.
    **Proven NON-VACUOUS**: git-stashed `board.ts`+`app.js` → 5/17 FAIL
    (bare ticket rendered `kind:'ticket'` WITH a textarea — the exact bug;
    the questioned ticket showed no parsed question/options) — restored, all
    green. Also fixed a pre-existing false-positive in this script's "no
    board" check: a freshly-registered project has no `lastActivityAt` so the
    sidebar's recency split (`isActiveProject`) folds it under a collapsed
    "N inactive projects" row — `clickProj` now expands that row when a
    direct match isn't found, and the check now asserts the click actually
    landed (`state.current.projectId`) instead of just polling for an empty
    rail (which could accidentally read empty because the click silently
    failed and the PREVIOUS project's rail happened to be empty too).
  - NEW `scripts/qa/BUG-025-needs-you-question.spec.ts` (Playwright + real
    brave + real server, `npm run verify:bug-025-question`) — **1/1 PASS**,
    also proven non-vacuous (stash → fails at the exact `question`/read-only
    assertions, same failure mode as above). Covers the same (a)/(b) shape
    end-to-end via Playwright locators, plus append-only + "unrelated card
    untouched" checks. Screenshot: `docs/bugs/assets/BUG-025-status-row.png`
    (BUG-901 renders as a read-only "👤 board status — no question raised" row
    with an "Open ticket" link, no textarea, after BUG-902's `## Question`
    card was answered and removed).
  - `npm run verify:runtime-decision` (FEAT-029 anti-regression, real haiku
    session) — **16/16 PASS**, unaffected: a raised decision still surfaces
    with `kind:'decision'`+`question`+`options`, answers still route back to
    the raising session, still persist across reload.
  - `npm run verify:ui -- --offline` — **3/3 PASS**. `npm run typecheck` — clean.
  - `package.json`: added `verify:bug-025-question` (runs the new spec directly);
    it also runs under `npm run qa:sweep` since it lives in `scripts/qa/`.
- **Scope discipline:** touched only `src/server/board.ts`, `public/app.js`,
  `scripts/verify-needs-you-rail.mjs` (extended), `scripts/qa/BUG-025-needs-you-question.spec.ts`
  (new), `package.json`, and this ticket. Did not touch `survival.ts`/`index.ts`/
  `templates.ts`. Did not commit (working tree only). Did not edit `INDEX.md`.
- **Still open / deferred:** the status row's "Open ticket" link uses a
  `file://` href to the ticket's absolute path — some browsers block
  navigation from an `http:` page to `file:` for security, so it may not
  always open in-tab depending on browser/flags; it is still a real,
  inspectable affordance (visible href, correct path) and is not required to
  navigate for this ticket's fix (the bug was the phantom answer box, not
  ticket navigation). A future ticket could add a small server route to
  stream a ticket's markdown into a drawer instead, if that's wanted.
