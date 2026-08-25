```orchard-ticket
{
  "id": "FEAT-053",
  "type": "feature",
  "title": "Rail sections could grow until one crowded out the rest",
  "summary": "The attention rail now shows a Queued section listing open tickets nobody has picked up, alongside the existing in-flight and done-today lists. Each section has its own height limit and scrolls on its own, so a long list can no longer take over the whole rail. Rows open the full ticket in a modal.",
  "impact_if_we_wait": "Bounded: this was rail layout and a missing read-only list, not data. Nothing was lost or mis-stored; a person could still reach every ticket through the board.",
  "current_need": "Nothing is outstanding. The rail suite, the findings-rail suite, the ticket suite and the browser checks all passed, with standing type checks clean.",
  "severity": "medium",
  "area": "Attention rail",
  "reported": "2026-08-09",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-11",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "The Queued list shows exactly the open tickets that are neither in flight nor done",
    "The Queued section is absent entirely when there is nothing queued",
    "Each rail section caps its height and scrolls independently",
    "A wheel over a capped section scrolls it, then chains to the rail and page",
    "The sidebar and transcript scroll unaffected by the new capped areas",
    "Read-only finding rows continue to render without answer boxes",
    "Narrow viewports and the rail badge overlay behave as before"
  ],
  "code_refs": [
    {
      "path": "src/server/board.ts",
      "symbol": null,
      "note": "already derives the needs-you, in-flight and done-today sets from the board index; the queued set is derived the same way rather than through a second parsing path"
    }
  ],
  "related": [
    {
      "id": "BUG-025",
      "relation": "see_also"
    },
    {
      "id": "BUG-032",
      "relation": "see_also"
    },
    {
      "id": "FEAT-018",
      "relation": "see_also"
    },
    {
      "id": "FEAT-047",
      "relation": "see_also"
    },
    {
      "id": "FEAT-058",
      "relation": "see_also"
    },
    {
      "id": "FEAT-063",
      "relation": "see_also"
    },
    {
      "id": "FEAT-066",
      "relation": "see_also"
    },
    {
      "id": "FEAT-067",
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
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-053-rail-queued-section-and-scroll.md",
    "sha256": "9a2124c8f557eb4d674bc5490017ecf9dafb7cb027592c9d9e7fc9a85cd3c09d",
    "bytes": 9155,
    "original_title": "Needs-You rail: add a \"Queued\" (todo) section + per-section height caps with own scroll",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Both goals, the queued derivation rule, the read-only row semantics, the scroll-containment prohibition and the full verification bar are present above.",
    "dropped": [
      "the verbatim wording of the user's original request, whose content is carried by the summary and goals"
    ]
  }
}
```

# FEAT-053 — Rail sections could grow until one crowded out the rest

## Diagnosis

### What was missing

The rail carried needs-you cards, in-flight rows and done-today rows, but nothing for the backlog: tickets that are open, unowned and not yet picked up. It also had no per-section bound, so one long list could consume the rail's full height and push the others out of view.

The queued set is the open-not-in-flight-not-done slice of the same board index the rail already reads, so it is derived where the other three sets are derived. No new parsing path was introduced.

## Evidence

Executed by the fixer: `verify:needs-you-rail` 17/17, `verify:feat-047-findings-rail` 18/18, `verify:tickets` 30/30, and `verify:ui` 3/3. `typecheck` was clean.

Named in the plan but with no recorded result: `verify:bug-032-sidebar-wheel`, `verify:bug-025-question`, `verify:feat-053-rail`.

Screenshots were to be captured under `docs/bugs/assets/FEAT-053-*.png`.

## Implementation notes

### Sections

Queued rows are read-only and use the same visual language as the in-flight and done-today lists — id plus short title, severity only where it does not add noise. They carry no answer box, matching the BUG-025 rule that a row which asks nothing must not offer an input.

Rows open the full ticket in a modal, reusing the FEAT-058 ticket renderer rather than adding a second one.

### Caps

Each section gets `max-height` plus `overflow-y: auto`. Cards get roughly 30–35vh; the read-only lists get less. Sections shrink to their content when short, and the rail itself stays scrollable as the outer fallback.

### The hard constraint

`overscroll-behavior: contain` must NOT be set on the new capped scroll areas. That exact property on the kid-session container caused the sidebar to become unscrollable, because wheel events were swallowed at the inner boundary. Cap with `max-height` and `overflow-y: auto` only.

## Verification plan

Seed a project with several question cards, several queued tickets, in-flight rows and done-today rows.

Assert the Queued section renders exactly the open-not-in-flight-not-done set, and is absent when that set is empty rather than leaving an empty header. Assert each section caps and scrolls independently. Assert wheel chaining: a wheel over each capped section scrolls it while it has room, then chains to the rail and page, with the sidebar and transcript unaffected — this is the regression guard for the earlier sidebar-wheel fault. Assert the narrow viewport and the rail badge overlay are unaffected, and that the read-only finding rows still render.

The suite had to fail before the change.

## Risks

The capped scroll areas are the same shape that previously produced a swallowed-wheel fault, so any future addition of scroll containment to them reintroduces it.

## Activity log (APPEND-ONLY)
### 2026-08-09 — orchestrator
- Filed from user request. Queued behind BUG-033 (app.js). Batch candidate with FEAT-051 (chips)
  and BUG-034 (strip redesign) — same file, one coherent UI pass may be cheaper than three.

### 2026-08-09 — user addition (scope item 3): click a row → ticket modal
"Clicking on each should ideally show a modal about the ticket / past attempts / all context that
also agents see."

3. **Ticket modal**: clicking ANY rail row (needs-you card title, queued, in-flight, done-today,
   and FEAT-047 finding rows where a ticket exists) opens a modal rendering that ticket's FULL
   markdown — the same file the dispatched agents read: goal, context pack, verification bar, and
   the append-only Activity log (past attempts, what was tried, what failed). This is the point:
   the human sees exactly the accumulated context the agents see, no summary layer in between.
   - Server: a read-only route returning the ticket file's raw markdown by project + id (reuse
     `board.ts`'s existing ticket-path resolution — do NOT add a second parsing/pathing path).
     Guard the path (id must match the known ticket set; no traversal).
   - Client: reuse the existing markdown renderer used for transcripts; modal is scrollable with
     a sane max-height, Esc closes (join the existing Esc ladder), and long Activity logs should
     be readable — consider newest-entry-first or a collapsed-older affordance ONLY if it does not
     hide content silently (if it collapses, state how many entries are hidden).
   - The rail row stays the affordance; no new nav. Keep the read-only rows read-only (BUG-025) —
     opening a ticket is not answering it.

Verification addition: clicking each row type opens the modal with that ticket's real content
(assert a known line from the file, incl. an Activity-log line — proving it is the full file, not
a summary); Esc closes; a row whose ticket is missing degrades honestly (message, no crash);
modal scrolls independently and does not break the rail's own scrolling (BUG-032 guard applies).

### 2026-08-11 — build agent (UI batch with FEAT-051 + FEAT-054) — built + verified
- **Changed:**
  - `src/server/board.ts` — `Board` gains `queued: BoardItem[]`; `readBoard()`'s existing
    Open-section walk pushes rows owned by neither 👤 nor 🤖 into it (same single INDEX.md
    parse, no second path). The board GET route spreads `readBoard()`'s object, so the field
    flowed through with ZERO `index.ts` change (that file is BUG-043's fixer's right now and
    was not touched).
  - `public/index.html` — `#railQueued` between the needs cards and In-flight; the
    `#ticketModal` shell (backdrop + box + close + `#ticketModalBody`).
  - `public/app.js` — `boardRow()` (one read-only row builder shared by Queued / In-flight /
    Done-today, `role=button` + keyboard, click → modal); `renderRail()` renders Queued
    (absent when empty); `openTicketModal()/closeTicketModal()/ticketModalOpen()` — fetches
    via the EXISTING FEAT-058 ticket route (`api.ticket`) and renders with
    `ticketDetailNode(t, {compact:true})`, the FEAT-058 renderer, NOT a duplicate; a fetch
    failure renders "Cannot open <ID> … the row may be stale" (honest degrade, no crash);
    `wireTitleModal()` makes a needs-card's TITLE the modal affordance for real tickets only
    (decisions/findings have no ticket file — no fake affordance); Esc closes the modal at
    the TOP of the existing Esc ladder; internals exposed on `window.__station`.
  - `public/styles.css` — `.needs` capped 34vh, `.rail-sub` capped 22vh, both
    `overflow-y:auto` ONLY — the BUG-032 HARD CONSTRAINT is honoured and stated in comments:
    NO `overscroll-behavior: contain` anywhere new (grep confirms only prose mentions);
    `.tmodal*` styles (body scrolls, same constraint); clickable-row affordances.
  - `scripts/qa/BUG-032-sidebar-scroll-wheel.spec.ts` part (3) updated to the new geometry:
    20 cards now overflow the CAPPED `.needs` section rather than the panel, so the spec
    asserts the same contract one level in (wheel over the rail lands in the section, is
    never swallowed, sidebar untouched) — same pattern as FEAT-058's BUG-025 spec update.
- **Verified (all real browser + real scratch server, never :4317, killed by pid):**
  - NEW `scripts/qa/FEAT-053-rail-queued-modal.spec.ts` — PASS. Queued renders EXACTLY the
    open-not-inflight-not-done set and is hidden for a project with none; saturated sections
    overflow internally and cap <0.4vh each; computed `overscroll-behavior` asserted `auto`
    on every new scroll area; wheel over Queued scrolls it then CHAINS to `#railPanel` at
    the boundary (panel proven scrollable first — the BUG-032 class of bug is the exact
    thing this asserts); modal shows an Activity-log-only marker line for queued / in-flight
    / done-today rows AND a needs-card title (full file, not a summary); modal body wheel
    does not move the rail; Esc closes; a row whose INDEX entry has NO ticket file shows
    "Cannot open FEAT-999" and the rail survives; narrow-viewport badge overlay unaffected.
  - **Proven MUST-FAIL-PRE-CHANGE:** with the five batch files `git stash`ed, the spec fails
    outright at the first assertion (`#railQueued` not found); restored → PASS.
  - Anti-regressions: `verify:needs-you-rail` 17/17 · `verify:feat-047-findings-rail` 18/18
    (finding rows still render read-only) · `verify:tickets` 30/30 ·
    `verify:bug-025-question` PASS · `verify:bug-032-sidebar-wheel` PASS (updated as above,
    green) · `verify:ui -- --offline` 3/3 · `typecheck` clean.
  - Screenshots: `docs/bugs/assets/FEAT-053-rail-sections.png`, `FEAT-053-modal.png`.
- **package.json entry for the orchestrator to add** (package.json off-limits to this lane):
  `"verify:feat-053-rail": "playwright test scripts/qa/FEAT-053-rail-queued-modal.spec.ts"`
  (it already runs under `qa:sweep` by living in `scripts/qa/`).
- **Closing assessment:** goal met in full (queued section, caps + own scroll with wheel
  chaining preserved, full-file modal reusing FEAT-058's renderer, Esc ladder, honest
  degrade). Not a symptom of a deeper flaw — this is presentation over the existing
  single-source board reader. One inherited wart, deliberate: findings/decision rows get no
  modal because they have no ticket file; if findings ever grow durable files, wire them in.
