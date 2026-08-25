```orchard-ticket
{
  "id": "FEAT-018",
  "type": "feature",
  "title": "Decisions raised in chat were easy to miss and hard to track",
  "summary": "Decisions that need a person now appear as cards in a right-hand rail, each with a response field, and answering one records the answer to its ticket and sends it back to the owning session. The rail also shows in-flight and done-today work per project. The interface suite passed and standing checks stayed clean.",
  "impact_if_we_wait": "None outstanding; the rail is built and running, with live refresh added later. Bounded: this was always a presentation and routing concern for decisions, and the ticket files remained the source of truth throughout.",
  "current_need": "Nothing is outstanding. The interface checks passed three of three with a clean standing check, and later work added live refresh on top.",
  "severity": "medium",
  "area": "Needs-you decision rail",
  "reported": "2026-08-04",
  "reported_by": "user",
  "owner": "you",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-08-04",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-04",
      "question": "Should the right rail be a read-only strip, or an interactive prompt surface?",
      "mode": "single",
      "options_keys": [
        "A",
        "B"
      ],
      "chosen": "B",
      "chosen_on": "2026-08-04",
      "chosen_by": "user",
      "note": "Upgraded on the day it was reported from a read-only strip to an interactive rail, which is what was built."
    }
  ],
  "success_criteria": [
    "An open decision renders as one unresolved card with a response field",
    "Answering removes the card and appends the answer to the source ticket",
    "The answer reaches the session that raised the decision",
    "A project with no open decisions shows an empty rail rather than an error",
    "A narrow viewport collapses the rail to a badge"
  ],
  "code_refs": [
    {
      "path": "src/server/index.ts",
      "symbol": null,
      "note": "board-parse route plus the answer POST that appends to the ticket and delivers to the session"
    },
    {
      "path": "public/app.js",
      "symbol": null,
      "note": "rail render and response submit; serialized against other front-end tickets"
    },
    {
      "path": "styles.css",
      "symbol": null,
      "note": "rail layout, collapse behaviour on narrow viewports"
    }
  ],
  "related": [
    {
      "id": "BUG-016",
      "relation": "see_also"
    },
    {
      "id": "BUG-019",
      "relation": "see_also"
    },
    {
      "id": "BUG-025",
      "relation": "see_also"
    },
    {
      "id": "FEAT-017",
      "relation": "blocks"
    },
    {
      "id": "FEAT-017",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-021",
      "relation": "see_also"
    },
    {
      "id": "FEAT-029",
      "relation": "blocks"
    },
    {
      "id": "FEAT-029",
      "relation": "see_also"
    },
    {
      "id": "FEAT-053",
      "relation": "see_also"
    },
    {
      "id": "FEAT-067",
      "relation": "blocks"
    },
    {
      "id": "FEAT-079",
      "relation": "see_also"
    },
    {
      "id": "FEAT-083",
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
    "archived_path": "docs/bugs/archive/FEAT-018-station-renders-project-board.md",
    "sha256": "06051248dd646f9910f8030c3dbcdbb4c8d872133d1b5b8f54dce3e5fc0326f7",
    "bytes": 8409,
    "original_title": "\"Needs You\" right-rail: decisions as interactive prompts (+ board surface)",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head section by section: the goal, the card design, both decision sources, the server contract, the browser proof bar and the paired ticket are all present.",
    "dropped": [
      "the parenthetical that a home directory has no board, kept only as the opt-in rule",
      "the working-agreement section reference behind \"nothing important lives only in chat\""
    ]
  }
}
```

# FEAT-018 — Decisions raised in chat were easy to miss and hard to track

## Diagnosis

### What the rail replaces

Every decision an orchestrator or agent raised arrived as prose in a transcript. The user had to skim it, judge whether it still mattered, and answer in chat, and an ephemeral modal ask did not survive a reload or a compaction. About twenty percent of the desktop width sat unused on the right.

The fix makes a decision a tracked object: it stays visibly unresolved until answered, and answering it records the answer durably.

## Evidence

The interface suite ran 3/3 passing, with a pass tally of 11/11 also recorded, and typecheck clean. A dedicated needs-you rail suite was named as part of the plan but has no recorded run.

FEAT-029 later added runtime cards on top of the first cut, and BUG-016 added live refresh to the rail.

## Implementation notes

### Where decisions come from

Two sources feed one render: a session or agent that hits a user-owned decision emits an item carrying the question and any options, and tickets already owned by a person on the board. The board files stay the source of truth; the rail is a view over them.

### The server side

For a project that has a ticket board, one endpoint parses the board index and ticket frontmatter into the open decisions, the in-flight work, and what finished today. Projects without a board simply have none — the surface is opt-in. The answer POST appends the response to the ticket and delivers it to the owning session, and never rewrites prior ticket content.

### Layout

Greyscale with a single moss accent and hairline rules. Below the decision cards sits the glanceable board — in-flight and done-today per project, read-only, with an optional cross-project rollup of everything waiting on a person.

### Paired work

FEAT-021 injects the same board snapshot into the session prompt, the machine-facing counterpart of this rail, and reuses the same answer routing so the two stay in agreement.

## Verification plan

In a real browser: seed a project with one decision waiting on a person, confirm the rail shows a single unresolved card with a response field, then answer it. The card should leave the rail, the answer should be written to the ticket, and it should reach the session. The rail then reads empty. A project with nothing waiting shows an empty rail rather than an error, and a narrow viewport collapses the rail. Offline interface suite plus typecheck alongside.

## Risks

### State honesty

The rail's count has to equal the real number of unresolved decisions. An empty rail must mean there is genuinely nothing waiting, otherwise the surface teaches people to distrust it.

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed as tier 3 of FEAT-017 (read-only board render). Files-as-source confirmed by
  user; station is a read-only viewer/aggregator of the opt-in per-project board.
### 2026-08-04 — orchestrator (user upgrade)
- User: use the free ~20% desktop right space as a Needs-You rail where decisions
  are interactive prompts with response fields, so unresolved items are truly
  tracked (state) instead of text to audit. Absorbed the old read-only "Needs-you"
  strip into this interactive design; bumped to HIGH. Human-facing half of the
  NEEDS-YOU contract; queue as the next FE build once app.js frees (after BUG-013).

### 2026-08-04 — agent (scoped first cut)
- **Understood:** build the interactive Needs-You right rail for the 👤 items that
  exist ON THE BOARD (INDEX.md owner column + ticket files). A session *raising* a
  new decision card at runtime is explicitly out of scope for this cut — noted as a
  handoff below. Files-as-source: the station is a read-only aggregator of the
  opt-in per-project `docs/bugs/`, plus one append-only write (the answer).
- **Changed (working tree, uncommitted):**
  - `src/server/board.ts` (new): `readBoard(hostPath)` parses `INDEX.md` (owner 👤 →
    needsYou, 🤖 → inflight; Done rows touched <24h → doneToday) enriched with each
    ticket's H1 title; returns `{hasBoard:false,…}` for a project with no
    `docs/bugs/` (opt-in, never an error). `appendAnswer()` writes a dated
    Activity-log entry with `fs.appendFileSync` (strictly append-only — prior
    content is never read-and-rewritten). A ticket carrying the rail's answer mark
    is treated as resolved so it leaves the rail even though INDEX still says 👤.
  - `src/server/index.ts` (+~40): `GET /api/projects/:id/board` and
    `POST /api/projects/:id/board/answer {id,answer}` — appends to the ticket, then
    delivers the answer to the first attached, idle session via the SAME
    `AgentSession.send()` path the composer uses; no session attached → just records
    (`delivered:false`). 400 on empty id/answer, honest error on unknown ticket.
  - `public/index.html` + `styles.css` (+~130) + `app.js` (+~150) + `lib/api.js`:
    a right rail using the free ~20% desktop column (greyscale + the single moss
    `--live` accent + hairlines, no new colour). Needs-you cards first (title +
    inline response field + Respond; ⌘/Ctrl-Enter submits), then read-only In-flight
    (🤖) and Done-today. Submit is optimistic (card removed at once) and reconciled
    on refresh; empty state is the quiet "✓ nothing needs you", not an error. Narrow
    viewport (<1040px) collapses the rail to a floating badge that opens it as an
    overlay.
- **Verified:**
  - `npm run verify:needs-you-rail` (new; real brave + real server, scratch project
    on a free port) — **11/11 PASS**. Proven non-vacuous: with the source changes
    git-stashed it FAILED (board route 404 → preconditions fail, no `.needs-card`,
    narrow check errors); restored → all green. PASS lines:
    (a) one unresolved card with a response field + submit for the seeded 👤 row;
    (b1) submit removes the card and the rail reconciles to empty; (b2) the answer is
    appended to the ticket file on disk as a dated entry; (b3) append-only — the
    prior log entry survives verbatim, before the new one; (c) a no-`docs/bugs/`
    project shows "✓ nothing needs you" with NO error; (d) narrow viewport →
    rail off-canvas + floating badge, and the badge re-opens it.
  - `npm run verify:ui -- --offline` — **3/3 PASS** (no rail regression on the main UI).
  - `npm run typecheck` — clean.
  - Screenshot: `docs/bugs/assets/FEAT-018-rail.png`.
- **Still open / handoff (runtime-raise decision cards):** this cut renders only
  👤 items already ON THE BOARD. The FEAT-018 design's other source — a live
  session/agent *emitting* a new 👤 decision at runtime (question + optional
  options) as a persistent object — is NOT built. Next agent: add a bridge event
  (e.g. `needs-you` / reuse the AskUserQuestion surface) that writes/updates a
  ticket (or a lightweight decision record) so it flows through the same
  `readBoard` → rail path, and route the rail's answer back over the live socket
  (this cut delivers via `AgentSession.send()` for an ATTACHED session only — a
  detached/among-many session is recorded but not yet delivered). Also: `options`
  buttons (design §Needs-You cards) and the cross-project 👤 rollup are deferred.
  Server shape already carries `owner/status/sev`; extend `BoardItem` with
  `question/options` when the raise path lands. Did NOT touch INDEX.md (orchestrator-owned).

- 2026-08-06 — privacy scrub for public release (FEAT-049, sanctioned append-only exception): private names/paths neutralized (project aliases, home paths → ~).
