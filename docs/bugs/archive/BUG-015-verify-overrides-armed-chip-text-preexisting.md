# BUG-015 — verify:overrides "armed-not-live … from next send" chip text assertion fails (pre-existing)

- **Status:** VERIFIED
- **Severity:** low
- **Area:** per-session overrides / armed-chip copy
- **Reported:** 2026-08-04 by orchestrator (surfaced independently by the BUG-006 and BUG-010 fix agents)

## Symptom
`npm run verify:overrides` → 4 passed, **1 failed**. The failing assertion concerns
the "armed-not-live … from next send" chip TEXT for a session that has overrides
armed but is not yet live. Two independent agents confirmed it reproduces on a
CLEAN working tree (drawer.js AND app.js reverted to last-committed) — so it
PREDATES all current backlog work and is unrelated to BUG-006 / BUG-010.

## Repro
`npm run verify:overrides` on committed main → the "armed-not-live … from next send"
chip-text check fails. (Exact expected-vs-actual string TBD by the fixing agent.)

## Expected
Either the chip copy or the test expectation is stale; reconcile so the assertion
reflects intended behavior. Determine which side is wrong (copy vs test) before editing.

## Context pack
- Suspect: the armed-chip text builder (public/app.js or public/lib/drawer.js) vs
  the expectation in scripts/verify-overrides.mjs.
- Touches: FRONTEND — serialize with other FE tickets.
- Repro test: already exists (verify:overrides) and currently RED; fixing agent
  must make it honestly green (fix the code if copy is wrong, or correct the test
  if the expectation is stale — with a note on why).

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
