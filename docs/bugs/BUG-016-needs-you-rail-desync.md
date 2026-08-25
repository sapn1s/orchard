```orchard-ticket
{
  "id": "BUG-016",
  "type": "bug",
  "title": "Resolved decisions lingered in the Needs-You rail",
  "summary": "The Needs-You rail now reconciles decisions resolved through chat, board edits, or other clients without requiring a reload. Targeted rail and runtime suites passed, and type checking stayed clean.",
  "impact_if_we_wait": "A regression would leave resolved decisions visible and make the unresolved count unreliable. Bounded: this affects display-correctness, not data loss, and a page reload restores the current board state.",
  "current_need": "Keep the ticket closed because targeted rail and runtime checks passed and type checking stayed clean.",
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
    "Out-of-band resolutions disappear from every open rail within the refresh interval",
    "Out-of-band additions appear without a manual reload",
    "The displayed count equals the board's unresolved decision count",
    "Card answers, chat edits, board edits, and runtime resolutions converge on the same displayed state"
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "symbol": null,
      "note": "Rail rendering and refresh flow"
    },
    {
      "path": "src/server",
      "symbol": null,
      "note": "Possible server-side push channel identified in the original fix direction"
    }
  ],
  "related": [
    {
      "id": "BUG-019",
      "relation": "see_also"
    },
    {
      "id": "FEAT-018",
      "relation": "see_also"
    },
    {
      "id": "FEAT-029",
      "relation": "depends_on"
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
    "archived_path": "docs/bugs/archive/BUG-016-needs-you-rail-desync.md",
    "sha256": "6e7a05b2176451caef663976b563fb7722bd151a9c8596eb22291e59b1fb49dd",
    "bytes": 6901,
    "original_title": "Needs-You rail desyncs: doesn't live-refresh, so out-of-band resolutions linger",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared BUG-016 line by line against the archived original; its symptom, reproduction, live-mirror expectation, convergence requirement, proof plan, dependencies, and recorded run evidence are present.",
    "dropped": []
  }
}
```

# BUG-016 — Resolved decisions lingered in the Needs-You rail

## Diagnosis

The rail reconciled after its own response submission and during a full reload, but did not observe board changes made elsewhere. Decisions acknowledged through chat, direct board edits, another client, or runtime-decision handling therefore remained visible until reload.

## Evidence

The fault was observed after a server restart: a decision acknowledged in chat remained in the panel. `verify:ui` passed 3/3, `verify:needs-you-rail` passed 11/11, and `verify:runtime-decision` passed 16/16. Another matched tally recorded 9/9 without an adjacent suite name. Type checking was reported clean. `verify:rail-refresh` was named, but no result was recorded.

## Implementation notes

Reconcile rendered cards against the board's current unresolved set on an interval or through server-sent events or WebSockets. Add newly unresolved items and remove resolved items regardless of whether the change came from a card response, chat, a board edit, another client, or FEAT-029 runtime-decision handling. The rail flow shares `public/app.js` with FEAT-029 and was designated to serialize after that work.

## Verification plan

In a real browser, open a rail containing a person-owned decision. Resolve it server-side through an answer mark or board edit and confirm it disappears within the refresh interval without reloading. Add another decision out of band and confirm it appears. The original required this scenario to fail before the fix.

## Risks

Polling adds recurring board requests, while a push channel adds server lifecycle and connection complexity. Every resolution path must converge or open panels can still disagree.

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed from user report (ack'd-in-chat item lingered post-restart). Queue behind
  FEAT-029 (shared rail flow); consider solving both together if the FEAT-029 agent's
  resolution rework already adds a refresh channel.

### 2026-08-04 — agent (live poll + in-place reconcile)
- **Understood:** the rail (`public/app.js`) was optimistic on its OWN submit only
  and rebuilt (`clear()` + rebuild every `.needs-card`) purely in `renderRail()`,
  called just from `selectProject()` and after the client's own answer POST. No
  channel existed to notice an out-of-band resolution/addition (chat ack, an
  orchestrator INDEX edit, another client, or a FEAT-029 decision resolved
  elsewhere), so the panel drifted from the board until a manual reload — exactly
  the filed symptom. A naive fix (poll + always rebuild) would have traded that
  bug for a worse one: wiping a half-typed response out from under the user every
  ~5s, so the reconcile had to be in-place.
- **Changed (working tree, uncommitted), `public/app.js` only:**
  - Added `reconcileNeeds(needs)` (new, placed just above `needsCard`): diffs the
    fetched `needsYou` set against the currently-rendered `.needs-card` elements
    by `data-id` and moves/inserts/removes DOM nodes rather than clearing and
    rebuilding. A card whose id is still present is **never recreated** — it is
    repositioned via `insertBefore` within its live parent (never through a
    detached `DocumentFragment`, which would blur a focused textarea) — so a
    user's in-progress typed text and focus survive a background refresh. A card
    whose id disappeared (resolved out-of-band) is removed; a new id gets a fresh
    `needsCard()`. `renderRail()` now calls this instead of the old
    `clear()`+rebuild loop.
  - Added a poll loop: `RAIL_POLL_MS = 5000`, `scheduleRailPoll()` /
    `clearRailPoll()` / `pollRail()` (calls `refreshRail(true)` then
    re-schedules). Started from `selectProject()` (so switching projects also
    (re)arms it) and from the `visibilitychange` listener (which also fires an
    IMMEDIATE `refreshRail(true)` on becoming visible again — the exact
    "resolved during a server restart while the tab was away" case from the
    report — and calls `clearRailPoll()` while hidden, so a backgrounded tab does
    not poll). A `window.addEventListener('focus', …)` also forces an immediate
    refresh. Existing optimistic-on-own-submit behaviour in `needsCard()`'s
    `submit()` is untouched — it still drops the card at once and then calls
    `refreshRail(true)`, which now flows through the same safe reconcile.
  - Exposed `pollRail` and `RAIL_POLL_MS` on `window.__station` for the verify
    script (avoids a magic sleep constant duplicated in test code).
- **Verified:**
  - `node scripts/verify-rail-refresh.mjs` (NEW; `npm run verify:rail-refresh`;
    real brave + real server on a scratch free port) — **9/9 PASS**: (a) a ticket
    resolved out-of-band by `fs.appendFileSync`-ing the rail's own answer mark
    directly to the ticket file (simulating a chat ack), NOT via its Respond
    button, disappeared from the rail inside one poll cycle with no reload; (b) a
    brand-new 👤 ticket + INDEX.md row written out-of-band (simulating an
    orchestrator INDEX edit) appeared the same way; (c) a third card the user was
    mid-typing in (focused, partial text) kept BOTH its typed value and its focus
    across that same background poll — proving the reconcile doesn't clobber it.
    **Proven non-vacuous**: with `public/app.js` git-stashed back to the pre-fix
    version, the SAME script FAILED 4/9 — `RAIL_POLL_MS` was `undefined`/0 (no
    poll loop exists), the resolved card never left, the added card never
    appeared, and the wait-for condition timed out after 9s — while (c) still
    passed trivially (nothing had a chance to touch the DOM at all). Restoring
    the fix brought it back to 9/9.
  - `npm run verify:needs-you-rail` — **11/11 PASS** (no regression on the
    board-ticket rail: single-card render, submit-removes+append-only-write,
    no-board empty state, narrow-viewport collapse).
  - `npm run verify:runtime-decision` — **16/16 PASS** (no regression on FEAT-029
    runtime-raised decision cards: raise→card→option-answer routes back to the
    raising session, persistence across reload, gone-session recording).
  - `npm run verify:ui -- --offline` — **3/3 PASS**. `npm run typecheck` — clean.
- **Status → VERIFIED.** Did NOT touch `INDEX.md` (orchestrator-owned) and did
  not commit, per the ticket rules.
