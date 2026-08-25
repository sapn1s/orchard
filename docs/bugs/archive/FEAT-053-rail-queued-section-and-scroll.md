# FEAT-053 — Needs-You rail: add a "Queued" (todo) section + per-section height caps with own scroll

- **Status:** VERIFIED (2026-08-11) — Queued section + per-section caps + full-ticket modal (reuses FEAT-058 renderer); BUG-032 constraint honored.
- **Area:** claude-station UI — Needs-You rail (FEAT-018 lineage)
- **Reported:** 2026-08-09 by user ("this section is good, but let's add another one which is like
  todo? basically feat/bug tickets which are created for later — and each section must be limited
  height before they get their independent scroll, so they can't take full height")

## Goal
1. **New "Queued" section** in the rail: board tickets that are OPEN but NOT in flight and NOT
   done — i.e. the todo backlog (owner `—`/queued, no 🤖). Read-only rows in the same visual
   language as the existing In-flight / Done-today lists (BUG-025 semantics: no answer boxes —
   these ask nothing). Show id + short title; severity if it fits without noise.
   Server: `src/server/board.ts` already derives needsYou/inflight/doneToday from INDEX.md —
   add `queued` the same way (single source, no new parsing path).
2. **Per-section height caps**: each rail section (Needs-you cards, Queued, In-flight,
   Done-today) gets its own `max-height` + `overflow-y: auto`, so no single section can eat the
   rail. Sensible caps (e.g. ~30-35vh for cards, less for the read-only lists); sections shrink
   to content when short. Keep the rail itself scrollable as the outer fallback.

## HARD CONSTRAINT (learned the hard way — BUG-032)
Do **NOT** put `overscroll-behavior: contain` on the new capped scroll areas. That exact property
on `.kids` caused BUG-032 (wheel events swallowed at the inner boundary, sidebar unscrollable).
Cap with `max-height` + `overflow-y:auto` only, and the verification MUST assert wheel-chaining
still works: wheel over each capped section scrolls that section while it has room, then chains
to the rail/page — and the sidebar/transcript remain unaffected.

## Verification (REQUIRED, user-observable)
Seed a project with: several 👤 question cards, several queued tickets, in-flight rows, done-today
rows. Assert: Queued section renders exactly the open-not-inflight-not-done set (and is absent
when empty — no empty-header clutter); each section caps and scrolls independently; wheel chaining
per the constraint above (regression guard for BUG-032); narrow viewport / rail-badge overlay
unaffected; FEAT-047 finding rows still render read-only. Must FAIL pre-change. Playwright +
verify:needs-you-rail 17/17 + verify:feat-047-findings-rail 18/18 + verify:bug-032-sidebar-wheel
+ typecheck. Screenshots docs/bugs/assets/FEAT-053-*.png.

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
