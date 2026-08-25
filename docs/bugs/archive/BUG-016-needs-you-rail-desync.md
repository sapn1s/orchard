# BUG-016 — Needs-You rail desyncs: doesn't live-refresh, so out-of-band resolutions linger

- **Status:** VERIFIED
- **Severity:** medium (undermines the rail's core promise — that its count = real unresolved decisions)
- **Area:** Needs-You rail (FEAT-018)
- **Reported:** 2026-08-04 by user
- **Related:** FEAT-018 (the rail), FEAT-029 (runtime cards — same rail data flow; serialize)

## Symptom
An item acknowledged/resolved OUT OF BAND (via chat, an INDEX edit by the
orchestrator, or another client) keeps showing in the rail until a manual page
reload — observed after a server restart: item was ack'd in chat but lingered in
the panel. The rail is optimistic on its OWN submit + reconciles on reload, but has
no live refresh, so the board (source of truth) and the panel drift.

## Repro
1. Have a 👤 item on the board so a card shows. 2. Resolve it out-of-band (edit
INDEX owner column / append the answer mark via chat, NOT via the card's Respond
button). 3. The card stays in the panel — no auto-update — until a full reload.

## Expected
The rail is a LIVE mirror of the board: when the board's 👤 set changes for any
reason, the panel reflects it within a short interval without a manual reload.
Its count must equal real unresolved decisions at all times (state honesty — the
rail's whole point).

## Fix direction
- Poll `GET /api/projects/:id/board` on an interval, OR push board changes (SSE/ws)
  when the board files change / an answer is recorded. Reconcile the rendered cards
  to the fetched set (add new, drop resolved) — not just on the client's own submit.
- Ensure the resolve paths ALL converge: card-answer, chat/INDEX edits, and
  FEAT-029 runtime-decision resolution must each make the item leave every open panel.

## Verification (REQUIRED)
Real browser: open the rail with a 👤 card; resolve it OUT OF BAND (server-side
append of the answer mark / INDEX change); assert the card disappears within the
refresh interval WITHOUT a manual reload. And a new 👤 item added out-of-band
appears. Must FAIL on current code. verify:ui offline + typecheck.

## Context pack
- Touches: `public/app.js` (rail render/refresh) — serialize AFTER FEAT-029 (same
  file/flow). Possibly `src/server` for a push channel.

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
