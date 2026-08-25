# FEAT-067 — orchestrator status rendered as structured cards in the "For You" rail, not prose in chat

- **Status:** VERIFIED — BUILT & VERIFIED (server-derived summary card + both fast-follows: a distinct live running-set count vs board.inflight, and a deploy-pending chip). Server change → needs deploy to serve `deployPending`; client is live on reload.
- **Area:** session→rail structured emission (FEAT-018/029 lineage) + orchestrator convention
- **Reported:** 2026-08-12 by user:
  > "instead of ['the board's actionable queue is empty again'] would maybe be nice [a] json ui
  > answer rendered as tickets or whatever in our 'for you' [section]"

## Intent
When the orchestrator summarizes state — "what's done / what needs you / what's queued / what's
running" — that high-signal status currently lives only as prose in the chat transcript, where it
scrolls away and isn't scannable. The user wants it as STRUCTURED content in the "For You" rail:
ticket-like cards / a rendered JSON summary, so the durable answer to "what's on my plate" is a
glanceable surface, not a paragraph.

## Open design questions (for the explore — build nothing)
1. **Channel:** does the orchestrator EMIT this (like FEAT-029 runtime-raised decision cards — a
   session emits structured content → rail), or does the SERVER derive it from the board +
   running-set + outcomes it already has (no orchestrator involvement)? The latter is more honest
   (single source of truth, can't drift from reality) and may already be 80% built — the rail
   already renders Needs-You (FEAT-018), Queued (FEAT-053), and the board API exists. Maybe this
   is mostly "render a richer status summary card at the top of the existing rail from data the
   server already has" rather than a new orchestrator→UI protocol.
2. **What's in it:** done-recently, needs-you (👤), queued, in-flight (live running-set), and the
   deploy-pending set — each a compact card linking into the ticket portal (FEAT-066) / drawer.
3. **Freshness:** server-derived → always live; orchestrator-emitted → a snapshot that can go
   stale (the exact class BUG-041/074 warned about — an observability surface must not lie).
4. **Relation to existing surfaces:** reconcile with the Needs-You rail, the Queued section, the
   running strip, and the outcomes rail so this is a SYNTHESIS/top-of-rail summary, not a fifth
   overlapping list.

Recommendation bias to test: prefer SERVER-DERIVED (from board + running-set + outcomes) over an
orchestrator-emitted snapshot — it can't drift, needs no new session protocol, and the data is
already there. The explore should confirm/refute against the code.

## Verification (whichever lands later)
The rail's status summary matches the board/running-set/outcomes ground truth (no drift), updates
live, links to the right ticket/drawer targets; must-FAIL a stale/fabricated summary.

## Activity log (APPEND-ONLY)
### 2026-08-12 — orchestrator
- Filed from the user's "render my status answers structured in the For-You rail" request.
  Dispatching an EXPLORE (server-derived vs orchestrator-emitted is a real fork with a
  drift/honesty cost) — returns approaches + a recommendation, builds nothing.

### 2026-08-12 — explore (read-only) → DECISION: server-derived
- **Verdict: server-derived, single source of truth, no orchestrator emission.** Every field is
  already served: board route returns merged `needsYou/queued/inflight/doneToday`
  (board.ts:59-68, index.ts:635-704); running-set + outcomes already fetched on the rail poll
  (app.js:3457,3470). `boardStateSection()` (board.ts:235-281) ALREADY computes the exact
  synthesis (Focus line + counts) — as injected prompt text, not a card.
- **Rejected orchestrator-emission (FEAT-029 `needs-you` channel):** an emitted card is a frozen
  snapshot that lies the moment a ticket/agent/queue changes — the BUG-041/074 + FEAT-057
  "observability must not lie" class. Derived recomputes every poll; cannot drift; less code.
- **Shape:** NOT a fifth list (rail already has stopped/needs/queued/inflight/done sections +
  FEAT-066 portal entry). A single compact SYNTHESIS card pinned at rail top: Focus line + a
  counts strip (done · needs · queued · running · stopped), each count a chip scrolling to its
  existing section; Focus links via existing `openTicketModal`/`navTickets`.
- **First increment (dispatched):** (1) board.ts `boardSummary(board)` → {focus, counts};
  (2) index.ts board GET attaches `b.summary` after all merges (:704); (3) index.html `#railSummary`
  atop `#railPanel`; (4) app.js renderRail paints it from `state.board.summary`, chips wired to
  sections; (5) styles.css greyscale + FEAT-066 tint tokens. Running "N live" count + deploy-pending
  (DEPLOY-*/done-not-deployed derived filter) are fast-follows.

### 2026-08-12 — build (first increment: server-derived summary card)
- Built exactly the explore's first increment — server-derived, single source of
  truth, NO orchestrator emission (the rejected snapshot design would lie the
  moment a ticket/agent/queue moved — BUG-041/074 class).
  - `src/server/board.ts` — pure `boardSummary(board)` → `{focus:{id,title}|null,
    counts:{needs,queued,inflight,doneToday}}`; `focus` reuses `boardStateSection`'s
    exact rule (first 👤 needs-you row, else first 🤖 inflight, else null). Added
    `BoardSummary` type + `Board.summary?`.
  - `src/server/index.ts` — board GET attaches `b.summary = board.boardSummary(b)`
    LAST, after every merge (decisions/findings/stalls folded into needsYou), so
    the card indexes exactly the rendered lists. Derived per GET; never stored.
  - `public/index.html` — `#railSummary` pinned at the top of `#railPanel`, above
    `#railStopped`.
  - `public/app.js` — `renderRailSummary()` (called from renderRail AND
    renderOutcomes, so both its inputs keep it live) paints a Focus line
    (openTicketModal for a real ticket; plain text for a decision/finding/stall
    focus with no file — no fake affordance) + a counts strip
    (done · needs · queued · running · stopped). done/needs/queued/running read
    from `state.board.summary`; "stopped" is computed client-side from the
    already-fetched `state.outcomes` (default recent view, matching railStopped).
    Each non-zero chip scrolls to its existing section; a fifth list was NOT added.
  - `public/styles.css` — greyscale card; the only colour is the restrained
    FEAT-066 `--st-*` tints on each chip's NUMBER (done=moss, needs=amber,
    running=slate, stopped=brick; queued stays neutral). No new colours.
- HONESTY invariant enforced: the card is DERIVED live every poll from
  board+outcomes; "stopped" with no outcomes shows 0 (omitted-not-faked).
- VERIFY §C — new `scripts/verify-feat-067-rail-summary.mjs`
  (`npm run verify:feat-067-rail-summary`): **14/14 PASS** — server `summary`
  matches merged board lengths; card Focus names + opens the top ticket; each
  chip's number equals ground-truth summary/outcomes; non-empty chips reach live
  sections. MUST-FAIL proven: freezing the summary as a stored snapshot made
  check (d) FAIL (card read stale "2" while the board moved to "3") — reverted;
  derived impl passes.
- Anti-regressions: verify:needs-you-rail **17/17**; verify:feat-053-rail **1
  passed**; verify:ui **7/7**; typecheck **clean**; leak-gate **PASS (0/441)**.
  verify:rail-refresh FATALs `Cannot read properties of null (reading 'focus')` —
  confirmed IDENTICAL at HEAD (pre-existing-broken, BUG-070), unaffected by this
  change.
- Deploy split: server (board.ts/index.ts) needs a deploy to serve `summary`;
  client (index.html/app.js/styles.css) is live on reload — NOT deployed here.

### 2026-08-12 — build (fast-follows: live running-set count + deploy-pending chip)
- Built BOTH remaining fast-follows named in the explore/status line, in one lane
  (board.ts + app.js + styles.css; no index.html change needed — the two new chips
  ride the existing `#railSummary`). Honesty invariant held for each: derived live
  every poll, never stored/fabricated.
  - **(1) Distinct live running-set count.** `public/app.js` renderRailSummary now
    reads `state.snap.running.length` — the SAME running-set snapshot the strip
    polls (`GET /api/sessions/:id/running`) — into a new `live` chip, rendered
    DISTINCT from the existing `running` chip (board `inflight` / 🤖 INDEX rows):
    live processes NOW vs tickets tagged in-flight, two different truths never
    conflated. HONESTY: with no snapshot (no session id in hand) the chip is
    OMITTED, never faked to 0 (which would read as "nothing running" when we just
    don't know). The card repaints on every snapshot change — added
    `renderRailSummary()` to `applySnapshot` (the sole `state.snap` writer) beside
    the existing `renderStrip()`, so the count stays live per poll. `live` chip
    jumps to the running strip; tint = the moss `--live` the strip uses.
  - **(2) Deploy-pending chip.** `src/server/board.ts` — `boardSummary` now derives
    `counts.deployPending` as a FILTER over the already-parsed OPEN rows
    (needsYou+inflight+queued) via new pure `isDeployPending(it)`: a `DEPLOY-*` id
    OR a status matching needs-deploy / deploy-pending / not-deployed / undeployed.
    No new stored field, no second disk read — an index over the same lists, can't
    drift. `public/app.js` paints it as a `deploy` chip on the summary card linking
    to the FEAT-066 board portal (the deploy-pending tickets are scattered across
    sections, so the chip opens the board where they're all listed); tint reuses
    the amber `--st-needs` (an actionable "still owes a deploy" state — no new hue).
- VERIFY §C — extended `scripts/verify-feat-067-rail-summary.mjs` with sections (e)
  live count + (f) deploy-pending: **23/23 PASS** (the original 14 a–d stayed green,
  +9 new). Ground truth: the live count matches the driven running-set snapshot and
  is asserted DISTINCT from `inflight` (2 vs 1); the deploy count EXACTLY equals an
  independently-derived filter over the board GET rows (3). MUST-FAILs PROVEN by
  breaking each impl: fabricating `deployPending=0` + dropping the snapshot repaint
  drove **16/23** — exactly the 9 fast-follow checks (both must-FAIL guards among
  them) FAIL, original 14 stay green; reverted → 23/23.
- Anti-regressions: verify:feat-067-rail-summary **23/23**; verify:needs-you-rail
  **17/17**; verify:feat-053-rail **1 passed**; verify:ui **7/7**; typecheck
  **clean**; leak-gate **PASS (0/441)**.
- Deploy split: `board.ts` change (the `deployPending` derivation) → server NEEDS a
  deploy to serve it; the client (`app.js`/`styles.css` — live chip + deploy chip +
  tints) is live on reload. index.ts was NOT touched this pass (the board GET
  already attaches `b.summary`). NOT deployed here.
