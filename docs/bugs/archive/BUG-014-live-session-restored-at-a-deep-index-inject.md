# BUG-014 — Live session restored at a deep index injects the historical 'N agents ran' summary into the live tail

- **Status:** VERIFIED
- **Severity:** medium
- **Area:** routing-transcript
- **Reported:** 2026-08-03 by bug-hunt workflow

## Symptom
A still-running session deep-linked/reloaded at an old scroll position splices the historical 'N agents ran in this session' summary into the live streaming conversation once the user scrolls down — reading as if those old sub-agents just finished. This is the same stale-summary-in-a-live-session lie the direct-open path was fixed to avoid.

## Repro
Open a live (dashboard-driven or external) session at an index older than the newest TAIL_PAGE so a forward gap forms. In openSession, :2759-2760 `if (th.gap || liveRec)` runs and `if (th.gap) th.agentsPending = true` even though liveRec is truthy. When the reader scrolls to pay off the gap, loadNewer at :2199-2205 unconditionally calls loadRecordedAgents(th, sessionId) with no liveRec check, appending the historical ran-stack summary at the live end; later live appends render after it. (Not directly reproduced; concrete code path.)

## Expected
Honest, correct behavior — see fix direction.

## Context pack
- Suspect file(s): public/app.js:2202 (loadNewer calls loadRecordedAgents with no liveRec guard) + :2759
- Fix direction: Guard loadRecordedAgents / agentsPending on !liveRec (skip the historical ran-stack summary for live sessions), matching the direct-open fix.
- Touches: FRONTEND (public/app.js or drawer.js) — serialize with other frontend tickets
- Related: BUG-004 (same summary-injection class)
- Repro test: none yet — the fixing agent MUST add a verify script that FAILS on current code and passes after.

## Activity log (APPEND-ONLY)

### 2026-08-03 — bug-hunt (read-only hunter)
- **Understood:** A still-running session deep-linked/reloaded at an old scroll position splices the historical 'N agents ran in this session' summary into the live streaming conversation once the user scrolls down — reading as if those old sub-agents just finished. This is the same stale-summary-in-a-live-session lie the direct-open path was fixed to avoid.
- **Verified:** diagnosis traced against source (see Repro); NOT yet reproduced with a running test.
- **Handoff:** Guard loadRecordedAgents / agentsPending on !liveRec (skip the historical ran-stack summary for live sessions), matching the direct-open fix.

### 2026-08-04 — fixed + VERIFIED
- **Understood:** confirmed the exact line: `openSession` (`public/app.js`, in the
  `if (th.gap || liveRec) { ... }` block right after `liveRec = await
  liveRecordFor(sess.sessionId)`) had `if (th.gap) th.agentsPending = true;`
  unconditionally — set even when `liveRec` was ALSO truthy. `loadNewer`
  (`public/app.js`) already gated its call to `loadRecordedAgents` behind
  `if (th.agentsPending)` — it was NOT unconditional as the original repro
  guessed (line numbers had drifted since the bug-hunt pass) — but since
  `agentsPending` got queued regardless of liveness, that gate did not help: a
  LIVE session with an outstanding gap still got the flag set, and once the
  reader scrolled to pay off the gap, `loadNewer` drained the queued flag into
  `loadRecordedAgents`, splicing the historical "N agents ran" stack at the
  live end — the same lie BUG-004 fixed for the direct-open path.
- **Changed (`public/app.js`, not committed):** `agentsPending` is now only
  queued when the gap belongs to a session that is NOT live —
  `if (th.gap && !liveRec) th.agentsPending = true;` — reusing the exact
  `liveRec` value from `liveRecordFor(sess.sessionId)` (BUG-004's helper,
  unioning mtime-liveness with an open live bridge), so a bridge-idle live
  session is excluded here exactly as it is in the direct-open branch just
  above it. A closed/historical session's real gap still queues the summary
  (unaffected) — paid off by `loadNewer` as before.
- **Added:** `scripts/verify-deep-index-agent-summary.mjs` (+ `package.json`
  `verify:deep-index-agent-summary`), modeled on
  `scripts/verify-agent-summary-bridge.mjs`/`verify-agent-summary.mjs`. Two
  fully-synthetic fixtures (280 messages each, padded past
  TAIL_PAGE(200)+RESTORE_AFTER(40) so opening at index 0 forces a real forward
  gap), each with one recorded sub-agent:
  - **LIVE** (mtime touched to now — the mtime half of `liveRecordFor`'s
    union; the bridge half is already covered by
    `verify-agent-summary-bridge.mjs` and reuses the SAME helper, so it is not
    re-proven here): deep-open at i=0 → gap recorded (`#history` shown) →
    scroll to pay it off (`#history` hides) → asserts `ranStacks === 0` (no
    summary spliced) and `followingExternal === true` (still framed live) →
    a further live append (file append + mtime touch, no summary
    materializing alongside it) lands cleanly via file-follow.
  - **CONTROL**: an identically-padded but genuinely CLOSED session (mtime
    left 1h stale, no live signal) pays off the same kind of real gap and
    STILL shows its recorded agent — proves the fix does not over-suppress
    the honest review-view case.
- **Verified:**
  - Confirmed the test FAILS on unpatched code: reverted `public/app.js` via
    `git stash` (package.json/app.js only — the new script and screenshot are
    untracked so they survived), ran
    `node scripts/verify-deep-index-agent-summary.mjs` directly →
    **9 passed, 2 failed**, both failures the exact repro (`ranStacks:1`
    spliced into the live tail after payoff, and again after the live
    append). `git stash pop` restored the fix.
  - `npm run verify:deep-index-agent-summary` (fixed code) → **11 passed, 0
    failed**.
  - `npm run verify:ui -- --offline` → **3 passed, 0 failed**.
  - `npm run verify:routing` → **11 passed, 0 failed**.
  - `npm run typecheck` → clean.
  - Anti-regression on the sibling BUG-004 tests (same `liveRecordFor`/
    `openSession` machinery): `npm run verify:agent-summary` → **3/3**,
    `npm run verify:agent-summary-bridge` → **5/5**,
    `npm run verify:reload-live` → **3/3**.
  - Screenshot: `docs/bugs/assets/BUG-014-after.png` — reopened live,
    deep-index-restored session showing the (padded) live tail with NO stray
    "agents ran" summary after the gap was paid off.
- **Still open / handoff:** none for this symptom. `public/app.js` changes and
  the new verify script are left uncommitted in the working tree per the
  ticket rules — orchestrator to commit with explicit file lists
  (`public/app.js`, `scripts/verify-deep-index-agent-summary.mjs`,
  `package.json`, this ticket file).
