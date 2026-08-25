```orchard-ticket
{
  "id": "BUG-036",
  "type": "bug",
  "title": "The anti-regression check crashed before running anything",
  "summary": "The offline interface check stopped running entirely: it threw while opening a session and printed no results at all. It now completes, cancels its pending timers, waits for the page to settle, prints an unmistakable failure banner on any throw, and refuses to report success when zero checks ran.",
  "impact_if_we_wait": "The safety net nearly every recent ticket leaned on was down, and a dead run could be mistaken for a clean one. Bounded: this affects confidence in the checks, not the product itself, and no user-facing behaviour changed.",
  "current_need": "Nothing is outstanding. The repaired harness was proven in both directions: it ran clean, and a deliberately broken interface made it fail loudly with a non-zero exit.",
  "severity": "high",
  "area": "Interface check harness",
  "reported": "2026-08-09",
  "reported_by": "agent",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-10",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "The offline harness completes and reports a non-zero count of checks",
    "A deliberately broken interface makes the harness exit non-zero with a visible failure banner",
    "The harness refuses to report success when it ran zero checks",
    "Interface-touching checks from tickets landed while the net was down still pass"
  ],
  "code_refs": [
    {
      "path": "scripts/verify-ui.ts",
      "symbol": null,
      "note": "offline mode; hardened to print a FAILED banner on any throw, exit non-zero, and refuse to pass on zero checks"
    },
    {
      "path": "public/app.js",
      "symbol": "openSession",
      "note": "its async tail outlived teardown; fixed with waitForNetworkIdle plus timer cancellation"
    },
    {
      "path": "public/app.js",
      "symbol": "resetTranscript",
      "note": "around line 2011, on the path from openSession to paintQueue"
    },
    {
      "path": "public/app.js",
      "symbol": "paintQueue",
      "note": "around line 3129; the `$('#queueBox')` lookup that threw against a torn-down document"
    }
  ],
  "related": [
    {
      "id": "BUG-032",
      "relation": "see_also"
    },
    {
      "id": "BUG-039",
      "relation": "see_also"
    },
    {
      "id": "FEAT-045",
      "relation": "see_also"
    },
    {
      "id": "FEAT-047",
      "relation": "see_also"
    },
    {
      "id": "FEAT-048",
      "relation": "see_also"
    },
    {
      "id": "FEAT-054",
      "relation": "blocks"
    },
    {
      "id": "FEAT-058",
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
    "archived_path": "docs/bugs/archive/BUG-036-verify-ui-broken-at-head.md",
    "sha256": "67d605863cdd9bf59406084615c49b74d16269b991006c2e5d3190b6c07bd593",
    "bytes": 8663,
    "original_title": "verify:ui --offline crashes at HEAD (the anti-regression harness is DOWN)",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Checked field by field against the original head of BUG-036: the crash path, the two reproductions, the dead-harness-reads-as-green concern, the four suspect changes and the both-directions proof are all present.",
    "dropped": [
      "the working-agreement section reference used to classify the severity argument",
      "the bisect instructions, now superseded by the named root cause"
    ]
  }
}
```

# BUG-036 — The anti-regression check crashed before running anything

## Diagnosis

`openSession`'s asynchronous tail kept running after the harness had torn the page down. That tail reached `resetTranscript` and then `paintQueue`, which looks up `#queueBox` on a document that no longer exists, so the run threw before a single check printed. Commit 25ae186 tipped the timing that made the race fire every time; the rail rows of FEAT-047, the hover work of FEAT-048, the provider tray of FEAT-045 and the CSS change of BUG-032 were the candidates examined while narrowing it down.

The second half mattered more than the crash. A harness that can throw and still be read as passing is a check that cannot fail, so the repair covered the reporting path as well as the race.

## Evidence

The crash reproduced on two independent runs, including a clean worktree at HEAD, throwing at `paintQueue → $('#queueBox')` via `openSession → resetTranscript → paintQueue` (app.js ~5407 / ~2011 / ~3129). After the repair the harness was proven in both directions: a clean pass, and a deliberately broken app.js producing a loud FAILED banner with a non-zero exit. A 3/3 tally is recorded in the log, and typecheck stayed clean. verify:ui, verify:bug-032-sidebar-wheel and verify:model-chip are named in the ticket as the interface-touching suites to re-run; no result is recorded against those names.

## Implementation notes

Three changes together: wait for network idle before asserting, cancel outstanding timers at teardown so no async tail survives it, and make the reporting path unambiguous — any throw prints a FAILED banner and exits non-zero, and a run that executed zero checks is refused rather than reported as success.

## Verification plan

Run the harness offline at HEAD and confirm it reports a non-zero check count. Then break app.js on purpose and confirm the failure banner and non-zero exit. Re-run the interface-touching suites from tickets that landed while the net was down.

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
