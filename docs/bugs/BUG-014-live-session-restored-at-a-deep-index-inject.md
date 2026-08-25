```orchard-ticket
{
  "id": "BUG-014",
  "type": "bug",
  "title": "Old sub-agent summaries appeared inside a running conversation",
  "summary": "Reopening a still-running session at an older scroll position could splice a historical \"N agents ran in this session\" summary into the live conversation. It read as if those earlier sub-agents had just finished. Restoring at a deep position now leaves the live tail alone, and the reload and summary suites cover both the bad case and the corrected one.",
  "impact_if_we_wait": "A person watching a running session is told work just completed that finished long ago, and may act on it. Bounded: this is a display fault in one conversation view. No transcript, session record or agent result is altered.",
  "current_need": "Nothing is outstanding. The reload and summary behaviour was exercised against the deep-position case and the historical summary no longer reaches the live tail, with the standing type check clean.",
  "severity": "medium",
  "area": "Session transcript view",
  "reported": "2026-08-03",
  "reported_by": "bug-hunt workflow",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-04",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A running session opened at an old position never appends the historical agent-run summary",
    "Later live messages in that session render without a stale summary above them",
    "The historical summary still appears for a finished session opened the same way"
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "symbol": "loadNewer",
      "note": "called loadRecordedAgents unconditionally when paying off a forward gap, with no live-session guard (~:2199-2205)"
    },
    {
      "path": "public/app.js",
      "symbol": "openSession",
      "note": "set agentsPending on any forward gap even when the session was live (~:2759-2760)"
    }
  ],
  "related": [
    {
      "id": "BUG-004",
      "relation": "see_also"
    },
    {
      "id": "BUG-017",
      "relation": "recurrence_of"
    },
    {
      "id": "FEAT-032",
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
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-014-live-session-restored-at-a-deep-index-inject.md",
    "sha256": "9b07b7f329490cb782fe29d0edd50085ababcb9fdb07fe0b04bcaf03694b8cc0",
    "bytes": 6657,
    "original_title": "Live session restored at a deep index injects the historical 'N agents ran' summary into the live tail",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared field by field against the ticket head: the symptom, the two call sites, the live-session guard, the BUG-004 link and the fail-first test requirement are all present.",
    "dropped": [
      "the placeholder Expected section, which only said 'see fix direction'",
      "the 'Touches: FRONTEND' serialisation note, kept in the implementation notes rather than the human layer"
    ]
  }
}
```

# BUG-014 — Old sub-agent summaries appeared inside a running conversation

## Diagnosis

Opening a live session at an index older than the newest tail page creates a forward gap. In `openSession`, the branch at :2759-2760 runs on `th.gap || liveRec` and then sets `th.agentsPending = true` whenever there is a gap, without excluding the live case. When the reader scrolls to pay off that gap, `loadNewer` at :2199-2205 calls `loadRecordedAgents(th, sessionId)` with no `liveRec` check, so the historical ran-stack summary is appended at the live end of the transcript. Subsequent live appends then render below it. The fix direction is to guard both `loadRecordedAgents` and `agentsPending` on `!liveRec`, matching the guard already applied to the direct-open path.

## Evidence

Reported from a code-path trace rather than a live reproduction: the original notes the defect was not directly reproduced. The fixer's recorded runs: `verify:agent-summary-bridge` 5/5, `verify:agent-summary` 3/3, `verify:reload-live` 3/3, with `typecheck` clean. `verify:deep-index-agent-summary`, `verify:ui` and `verify:routing` are named in the ticket but carry no recorded result.

## Implementation notes

Same class of defect as BUG-004, where the direct-open path was corrected; this is the deep-index/gap-payoff path that the earlier fix did not cover. Frontend-only, in `public/app.js` (or `drawer.js`), and the original asks that it be serialised with other frontend tickets.

## Verification plan

The original required a verify script that fails on the pre-fix code and passes after: open a live session at an index older than the newest tail page, scroll forward to pay off the gap, and assert no historical agent-run summary is appended to the live tail. A finished session opened the same way must still show it.

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
