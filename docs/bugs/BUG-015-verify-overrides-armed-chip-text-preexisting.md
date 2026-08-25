```orchard-ticket
{
  "id": "BUG-015",
  "type": "bug",
  "title": "Armed override chip showed inconsistent timing text",
  "summary": "The override chip’s timing text was reconciled with its intended behavior. Previously, the existing assertion failed when overrides were armed for a session that was not yet live.",
  "impact_if_we_wait": "People could see misleading timing text for an armed override. Bounded: this affected display-correctness for one session state, not override behavior, session data, or data loss.",
  "current_need": "Keep the ticket closed; the standing static type check completed cleanly after the chip-text reconciliation.",
  "severity": "low",
  "area": "Per-session override status",
  "reported": "2026-08-04",
  "reported_by": "orchestrator",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-04",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "The chip text reflects intended timing when overrides are armed but the session is not live",
    "The assertion and displayed copy agree for the armed but inactive state"
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "symbol": null,
      "note": "Possible location of the armed-chip text builder"
    },
    {
      "path": "public/lib/drawer.js",
      "symbol": null,
      "note": "Possible location of the armed-chip text builder"
    },
    {
      "path": "scripts/verify-overrides.mjs",
      "symbol": null,
      "note": "Contains the chip-text expectation"
    }
  ],
  "related": [
    {
      "id": "BUG-006",
      "relation": "see_also"
    },
    {
      "id": "BUG-010",
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
    "archived_path": "docs/bugs/archive/BUG-015-verify-overrides-armed-chip-text-preexisting.md",
    "sha256": "bc0f580382d65dd74685e2dc8cc04aebfd951a01accdb05ec127226b7d41a9c8",
    "bytes": 4878,
    "original_title": "verify:overrides \"armed-not-live … from next send\" chip text assertion fails (pre-existing)",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared with the archived BUG-015 text; the symptom, clean-tree reproduction, pre-existing scope, suspected locations, intended reconciliation, and recorded checks remain represented.",
    "dropped": []
  }
}
```

# BUG-015 — Armed override chip showed inconsistent timing text

## Diagnosis

The displayed copy and its assertion disagreed for a session with overrides armed before becoming live. The mismatch predated the related frontend work, so either the copy or the expectation had become stale.

## Evidence

The original `verify:overrides` run reported four passing checks and one failing chip-text assertion. Two agents reproduced that failure on a clean committed tree with `drawer.js` and `app.js` reverted. The standing `typecheck` later completed cleanly. `verify:overrides`, `verify:ui`, `verify:new-session-overrides`, and `verify:session-scope` were named without recorded results.

## Implementation notes

Determine the intended wording before changing either the armed-chip text builder or the expectation. Frontend changes should be serialized with other work touching the same files.

## Verification plan

Exercise the armed but inactive session state and compare the rendered timing text with the intended behavior. Then run the existing override check and relevant interface and session-scope checks.

## Risks

Changing only the assertion could preserve misleading copy. Changing only the copy without establishing intent could alter established product language.

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed. Surfaced as a side-observation by two fix agents; captured so it is not lost.

### 2026-08-04 — fix agent
- **Understood:** ran `npm run verify:overrides` on clean main → 4 passed, 1 FAILED.
  Failing assertion: `armed-not-live shows an explicit PENDING state (hollow mark,
  "from next send")`, expected `/from next send/` in the seal chip text, observed
  `{"btn":"true","chip":"skips prompts · if you take over"}`. Traced the chip text
  to `public/app.js` `paintPerm()` (~line 1558): `chipNote = pendingChip ? (external
  ? ' · if you take over' : ' · from next send') : ''`, where `external =
  !!state.followingExternal`. `followingExternal` is set true (app.js ~line 2848)
  when `openSession()` fetches the live-session record and finds `liveRec &&
  !liveRec.drivenByDashboard` — i.e. the session's `.jsonl` file is currently
  "live" by mtime (no dashboard bridge owns it, so it reads as an external
  terminal writer). Liveness itself is `isSessionLive()` /
  `src/server/watcher.ts` `LIVE_WINDOW_MS = 30_000` — pure mtime recency (deliberately,
  per the comment there: open-fd checks false-positive on the dashboard's own
  transcript readers). The test's fixture (`scripts/verify-overrides.mjs`) writes
  the session's `.jsonl` fixture file via `fs.writeFileSync` moments before
  navigating the browser to it, so the file's mtime is "now" — well inside the
  30s live window. The app therefore HONESTLY reports this fixture as an
  externally-live session (indistinguishable from a real terminal writing it
  right now) and correctly shows the "if you take over" wording instead of "from
  next send". **Diagnosis: the TEST fixture was stale/wrong, not the app.** The
  app's armed-chip copy is correct for both cases it's meant to distinguish
  (armed-while-idle vs armed-while-externally-live); the test just wasn't
  actually producing the idle case it claimed to test.
- **Changed:** `scripts/verify-overrides.mjs` only — after writing the fixture
  `.jsonl`, back-date its mtime 5 minutes into the past via `fs.utimesSync()` so
  it falls outside `LIVE_WINDOW_MS` and the app's mtime-liveness check correctly
  reads it as idle/not-live, exercising the "armed-not-live" path the assertion
  is actually named for. Added a comment explaining the mtime-liveness mechanism
  and why the old fixture was a false negative, not an app bug. Did NOT touch
  `public/app.js` or `public/lib/drawer.js` — no code was wrong.
- **Verified:**
  - `npm run verify:overrides` → PASS (5 passed, 0 failed); the target assertion
    now observes `{"btn":"true","chip":"skips prompts · from next send"}`.
  - Non-vacuousness check: temporarily changed the `' · from next send'` string
    in `public/app.js` to a sentinel value and reran `verify:overrides` → the
    assertion correctly FAILED (`chip":"skips prompts · BROKEN-SENTINEL"`),
    confirming it still meaningfully exercises the chip text. Reverted the
    sentinel; `git diff public/app.js` is empty (no net change to app.js).
  - `npm run verify:ui -- --offline` → PASS (3 passed, 0 failed).
  - `npm run typecheck` → PASS (no errors).
  - `npm run verify:new-session-overrides` → PASS (5 passed, 0 failed).
  - `npm run verify:session-scope` → PASS (10 passed, 0 failed).
- **Status → VERIFIED.**
