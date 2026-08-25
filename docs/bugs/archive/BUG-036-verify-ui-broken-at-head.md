# BUG-036 — verify:ui --offline crashes at HEAD (the anti-regression harness is DOWN)

- **Status:** VERIFIED — harness repaired (2026-08-09): race root-caused (openSession's async tail outliving teardown; 25ae186 tipped it), waitForNetworkIdle + timer cancellation + loud FAILED banner on any throw + refuses to pass on zero checks; proven both directions.
- **Area:** verification harness (scripts/verify-ui.ts) vs public/app.js DOM assumptions
- **Reported:** 2026-08-09 (found by the FEAT-052 agent; confirmed by the orchestrator at HEAD)

## Symptom (confirmed)
`node scripts/verify-ui.ts --offline` throws before printing ANY check:
`paintQueue → $('#queueBox')` on an undefined/missing document, via
`openSession → resetTranscript → paintQueue` (app.js ~5407 / ~2011 / ~3129).
Reproduced by two independent runs, including a clean worktree at HEAD.

## Why this is high severity
`verify:ui --offline` is the anti-regression check nearly EVERY recent ticket ran and reported
as "3/3 PASS". If it now crashes before running a single check, then (a) the safety net is down,
and (b) any run that reported PASS after the breaking change was reporting on a harness that
never executed — a §C "green checkmark that can't fail" situation, the exact class the working
agreement exists to prevent.

## Investigate (ground truth)
1. **When did it break?** `git bisect`/`git log -p` over recent app.js + verify-ui.ts commits
   (FEAT-047 rail rows, FEAT-048 hover, FEAT-045 provider tray, BUG-032 CSS are the candidates)
   until the first commit where the harness throws. Name the commit.
2. **Why did every ticket after it still report 3/3?** Either those runs predate the break, or
   the harness's failure mode was mistaken for success by the reporting agents (check how the
   runs were invoked — e.g. `npm run verify:ui -- --offline` vs `node scripts/verify-ui.ts
   --offline`, exit code handling, output parsing). This half matters more than the crash: a
   harness that can appear to pass while dead must be made to fail loudly.
3. Root cause of the crash itself: the offline harness's DOM shim vs what `paintQueue` (and the
   newer paint paths) now require.

## Fix
Restore the harness AND harden it: it must exit non-zero and print an unmistakable FAILED banner
on any throw (no silent/ambiguous output), and assert it actually ran N>0 checks before claiming
success (§C: a check that can pass on empty input is worse than no check).

## Verification
Harness runs green at HEAD with N checks reported; deliberately break app.js → harness FAILS
loudly with non-zero exit (prove both directions); re-run the recent tickets' UI-touching specs
to confirm nothing real regressed while the net was down.

## Activity log (APPEND-ONLY)
### 2026-08-09 — orchestrator
- Filed after the FEAT-052 agent hit it and the orchestrator reproduced it at HEAD. Note: an
  untracked scratch probe `scripts/.b33-probe.mjs` from the in-flight BUG-033 lane currently
  also trips leak-gate; that is transient, not part of this bug.

### 2026-08-10 — agent (fix)
**Root cause — TWO real bugs, both timing-shaped, which is why "3/3 PASS" kept being reported:**

1. `openSession()`'s async tail (`liveRecordFor()` → `api.sessionSubagents()` → `fillViewport()`,
   all real network awaits) keeps running well PAST the point the harness's own checks are
   satisfied — the "clicking a session rendered its transcript" check passes on the FIRST await
   (`transcriptTail`), but the click's promise (fired as `void openSession(...)` in app.js, never
   awaited by anyone) is still mid-flight. The harness's `--offline` branch returned immediately
   after that check, and `main()`'s `finally` reset `document`/`window`/`fetch` to `undefined`
   after a fixed 300ms grace. When the tail's later awaits resolved after that grace, it hit
   `catch (err) { resetTranscript(); ... }` (public/app.js:3129-3130) with `document` already
   undefined → `paintQueue()` → `$('#queueBox')` throws on `undefined.querySelector`.
2. Separately, app.js starts its own background timers on boot (`startLivePolling()`'s 5s
   `setInterval`, line ~4291, and others) that the harness never stops — any run long enough
   risks a stray tick firing after teardown too, independent of bug #1.

**Why it could report "3/3 PASS" for a long stretch while genuinely broken:** this is a race, not
a parsing bug — `npm run verify:ui -- --offline` correctly propagates the underlying exit code
(verified directly: `echo ${PIPESTATUS[0]}` after the npm wrapper). Whichever finished first —
the click's stray async tail throwing (an unhandled rejection outside `main()`'s own
try/catch/`.finally()` chain, since the click handler never awaited it) vs. `main()`'s own
`.finally()` reaching `process.exit(fail ? 1 : 0)` with `fail === 0` from the checks that HAD
already passed — decided whether the process died loud, died silent, or exited clean. A run
against a small/fast neighbor fixture usually won that race (tail finishes inside the 300ms
grace); FEAT-049 changed which fixture that is.

**Named breaking commit: `25ae186` — "FEAT-049: public-release prep — leak scrub (276->0), leak
gate, security posture, rename + mirror scripts" (2026-08-06).** It replaced the small, fixed
`external-project-B` fixture project with `findNeighborProject()` — an alphabetical scan of `~/projects` for
ANY real project with recorded sessions. On this machine that now resolves to `Example-App`
(37 real sessions), whose `openSession()` tail (subagent lookup, viewport fill against a much
larger transcript) is slow enough to reliably lose the race the fixed-fixture version had been
reliably winning. I could not `git bisect` cleanly across this commit to confirm on the nose,
because `25ae186` is also the commit that DELETED the hardcoded `~/projects/<external-project-B>`
path — checking out an earlier revision throws a different, unrelated "precondition failed:
external-project-B missing" error on this machine rather than reproducing or disproving the crash. The
mechanism (fixture size/latency swap) and the timing (this is the only commit touching
`scripts/verify-ui.ts`'s fixture selection in the relevant window) are as far as I could pin it
without a machine that still has `external-project-B` checked out.

**Fix (a) — the crash**, `scripts/verify-ui.ts` only (no `public/app.js` change needed or made —
another agent has in-flight work there for ARCH-001 phase 2 / BUG-034 / FEAT-057, confirmed
unrelated to this bug and left untouched):
- Wrapped the `fetch` shim to count in-flight requests and added `waitForNetworkIdle()`, called
  right after the "clicking a session" check (covers both `--offline` and full runs) — gives
  `openSession()`'s real tail room to finish against a still-valid `document` before anything
  that assumes app.js has gone quiet.
- Wrapped `setInterval`/`setTimeout` while app.js is mounted, tracking every handle it creates;
  `stopAppTimers()` cancels all of them in the `finally`, BEFORE `document`/`window` are reset —
  closes the independent stray-timer leak.

**Fix (b) — harden (§C: a check that can pass on empty input is worse than no check)**:
- `process.on('uncaughtException', ...)` / `process.on('unhandledRejection', ...)` now print an
  unmistakable `FAILED` banner and `process.exit(1)` — no future regression of this exact class
  (an async tail throwing outside `main()`'s own try/catch) can die silently or race a clean exit
  again.
- The final summary line now says `PASSED`/`FAILED` explicitly, and refuses to report a pass when
  `pass + fail === 0` (zero checks executed).

**Verification:**
- `node scripts/verify-ui.ts --offline` and `npm run verify:ui -- --offline`: 5 consecutive green
  runs, `3 passed, 0 failed`, exit 0 each time.
- Deliberately threw inside `paintQueue()` (`public/app.js`, reverted after — `git diff` empty) →
  harness printed `FAILED (uncaughtException)` with the real stack and exited 1. Proves both
  directions.
- `npm run typecheck` clean.
- Re-ran `verify:bug-032-sidebar-wheel` and `verify:model-chip` (both UI-touching, both ran while
  the net was down) — both still pass. Nothing regressed.

**Closing assessment:** Both required halves are done — the crash is fixed (root-caused to a
race, not a missing DOM selector, so the shim was extended rather than `app.js` weakened) and the
harness is hardened to fail loudly and refuse a vacuous pass. The breaking commit is named with
the caveat above (mechanism confirmed, exact bisect blocked by an unrelated fixture-path
precondition on this machine). Verification checklist fully met. Ready to close.
