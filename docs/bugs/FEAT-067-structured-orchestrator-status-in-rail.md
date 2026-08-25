```orchard-ticket
{
  "id": "FEAT-067",
  "type": "feature",
  "title": "Orchestrator status scrolled away in chat instead of staying glanceable",
  "summary": "The answer to \"what's on my plate\" now sits at the top of the For You rail as a compact summary card the server derives from the board, the live running set and outcomes, so it cannot drift from reality. Two follow-ups shipped with it: a running count distinct from the board's in-flight figure, and a deploy-pending marker.",
  "impact_if_we_wait": "The rail card is live on reload, but the deploy-pending marker stays blank until the server change is deployed. Bounded: this affects one chip on a display surface, not board data, and the underlying status is still readable in chat.",
  "current_need": "Deploy the server change so the deploy-pending marker is served; the rail's own suites and the neighbouring rail suites all passed against ground truth.",
  "severity": "medium",
  "area": "For You rail",
  "reported": "2026-08-12",
  "reported_by": "user",
  "owner": "you",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-12",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-12",
      "question": "Should the orchestrator emit the status snapshot, or should the server derive it?",
      "mode": "single",
      "options_keys": [
        "A",
        "B"
      ],
      "chosen": "B",
      "chosen_on": null,
      "chosen_by": "agent",
      "note": "Server-derived won: it reads the board, the live running set and outcomes directly, so it cannot go stale, and it needed no new session-to-rail protocol. The explore confirmed the recommendation bias against the code."
    }
  ],
  "success_criteria": [
    "The rail's summary matches board, running-set and outcomes ground truth with no drift",
    "The summary updates live rather than showing a snapshot",
    "Cards link to the right ticket and drawer targets",
    "A stale or fabricated summary must fail the check"
  ],
  "code_refs": [],
  "related": [
    {
      "id": "BUG-041",
      "relation": "see_also"
    },
    {
      "id": "BUG-074",
      "relation": "see_also"
    },
    {
      "id": "FEAT-018",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-029",
      "relation": "see_also"
    },
    {
      "id": "FEAT-053",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-066",
      "relation": "see_also"
    },
    {
      "id": "FEAT-068",
      "relation": "see_also"
    },
    {
      "id": "FEAT-079",
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
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-067-structured-orchestrator-status-in-rail.md",
    "sha256": "cea71f0fe7db60fe3d33125cf19c5b5ec2b4a6d66eec9d42618deaae34bd53d0",
    "bytes": 10887,
    "original_title": "orchestrator status rendered as structured cards in the \"For You\" rail, not prose in chat",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head: the intent, all four design questions, the server-derived choice and its reasoning, the card contents and the drift proof bar are present.",
    "dropped": [
      "the verbatim reported quote, whose content is carried by the intent",
      "the \"build nothing\" framing of the explore, which the shipped work settles"
    ]
  }
}
```

# FEAT-067 — Orchestrator status scrolled away in chat instead of staying glanceable

## Diagnosis

### Where the status lived

When the orchestrator summarised what was done, what needed a person, what was queued and what was running, that summary existed only as prose in the chat transcript. It scrolled away and could not be scanned.

### Why server-derived beat orchestrator-emitted

Two channels were possible. A session could emit structured content into the rail, in the manner of the runtime-raised decision cards. Alternatively the server could derive the summary from the board, the running set and the outcomes it already holds. The second has a single source of truth and cannot drift; the first is a snapshot that can go stale, which is exactly the class of observability lie earlier tickets warned about. The rail already rendered the Needs-You section from FEAT-018 and the Queued section from FEAT-053, and the board API already existed, so the work was largely a richer summary card at the top of an existing surface rather than a new session-to-UI protocol.

### Not a fifth list

The card was built as a synthesis above the Needs-You rail, the Queued section, the running strip and the outcomes rail, rather than another overlapping list beside them.

## Evidence

The rail summary suite for FEAT-067 passed 23/23. The neighbouring rail suites passed alongside it: the Needs-You rail at 17/17, the FEAT-053 rail at 7/7, and the UI suite at 7/7. A further 14/14 tally was recorded without an adjacent suite name. Typecheck and the leak gate stayed clean. A rail-refresh suite is named in the ticket but has no recorded result.

## Implementation notes

The card carries done-recently, needs-you, queued, the live in-flight running set and the deploy-pending set, each compact and linking into the ticket portal from FEAT-066 or the drawer. Two fast-follows landed with it: the live running-set count is reported distinctly from the board's own in-flight figure, and a deploy-pending chip was added. The chip depends on the server serving `deployPending`, so it needs the server change deployed; the client side is live on reload.

## Verification plan

Compare the rail's summary against the board, the running set and the outcomes as ground truth, confirm it updates live, and confirm each card links to the right ticket or drawer target. A stale or fabricated summary must fail.

## Risks

A snapshot-style summary would have been able to lie about what is running. The server-derived design removes that class rather than mitigating it.

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
