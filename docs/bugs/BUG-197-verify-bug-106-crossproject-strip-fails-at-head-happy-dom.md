# BUG-197 — verify-bug-106-crossproject-strip fails at clean HEAD (neighbor-project header never renders in happy-dom)

- **Status:** OPEN — harness fix landed (fixing lane round 1, 2026-09-29); independent clean-room
  verify NOT-RUN (see 2026-09-29 verify-lane log): the fixer suite exits 1 BY DESIGN (the intentional
  SEAL product red), which the verdict-contract mechanically rejects under HOLDS, so the harness
  cannot emit a VALID+HOLDS verdict for this suite. Test-harness-only change (zero clean-room rounds
  per VERIFY.md's harm-class table) — needs an orchestrator decision on how to close.
- **Severity:** low (a broken/stale verify HARNESS, not a product defect — the BUG-106 product
  behaviour is not implicated by this failure)
- **Area:** test harness / verify script (`scripts/verify-bug-106-crossproject-strip.mjs`), happy-dom
- **Reported:** 2026-09-29 (surfaced by BUG-196 rounds 1 and 2)

## Symptom
`node scripts/verify-bug-106-crossproject-strip.mjs` fails before it exercises any BUG-106 assertion:

```
PASS  precondition: project A (neighbor) has at least one on-disk session
      observed: 5 session(s)
      (timed out waiting for both project headers after 20000ms)
FATAL: TypeError: Cannot read properties of undefined (reading 'click')
    at main (…/scripts/verify-bug-106-crossproject-strip.mjs:181:46)
1/1 checks passed
```

The precondition (project A has on-disk sessions, via the server API) passes, but the DOM wait
`waitFor('both project headers', …, 20000)` at line 179 times out: `headerFor(NB)` /`headerFor(PB)`
(`#tree button.proj` matched by project name) never both appear in the rendered tree. Line 181 then
calls `.click()` on the `undefined` neighbor header and throws.

## Why this is a harness bug, not a product bug
- **It fails identically at clean HEAD with NO uncommitted work.** This was established independently
  by the BUG-196 round-1 clean-room verify lane (see BUG-196 Activity log, entry
  "2026-09-29 — independent clean-room verify lane, round 1", the "BUG-106 attribution check"):
  the script fails with the SAME signature on the live dirty tree, on live-minus-BUG-196, on
  live-minus-BUG-194, and on clean HEAD. Because it fails at HEAD, it is attributable to no
  uncommitted ticket (not BUG-194, not BUG-196).
- Re-confirmed on 2026-09-29 by the BUG-196 round-2 lane on the current tree (same
  "timed out waiting for both project headers" → TypeError at :181).
- The failure is that a second project's header row does not render in this **happy-dom** boot of
  `app.js` — a rendering/timing gap in the test's DOM environment (or a drifted selector/data
  expectation), not a defect in the running product. No browser-real reproduction of a BUG-106
  regression is implied.

## What is NOT known yet (triage TODO)
- Whether the neighbor header genuinely never renders in happy-dom, or renders under a changed
  selector/class the script's `projName()` / `#tree button.proj` no longer matches (app.js tree
  markup may have drifted since the script was written).
- Whether the BUG-106 product invariant still holds — it must be re-proven under a working harness
  (e.g. ported to the real-browser Brave/Playwright harness the other verify scripts now use) before
  anyone trusts a green/red from this file again.

## Not to do here
- Do NOT "fix" it by loosening the wait or the assertion until it passes green — a check that goes
  green without exercising the BUG-106 re-scope invariant is worse than a red one (CONVENTIONS
  "don't buy green with vacuity").

## Activity log (APPEND-ONLY)

### 2026-09-29 — filed by BUG-196 round-2 fixing lane
- Filed so the pre-existing failure of `verify:bug-106` is tracked rather than lost, per the BUG-196
  round-2 charter (the INDEX row is authorised). Reproduced the failure on the current tree; did NOT
  attempt a fix (out of scope). Attribution to clean HEAD was proven by the BUG-196 round-1
  clean-room lane; this lane confirmed the signature still holds.

### 2026-09-29 — fixing lane (Opus 4.8), round 1 — harness fixed; hypothesis corrected; a REAL BUG-106 leak surfaced
- **Understood:** the wait `waitFor('both project headers', …)` at :179 timed out because one of the
  two registered projects was folded into the "N inactive projects" group (`.inactive-l`) and its
  header did not render. Confirmed empirically, not assumed.
- **Hypothesis correction (recorded honestly):** the charter guessed the FRESH project B would be
  inactive. It is the OTHER way round. Instrumented the timeout branch and observed:
  `inactive-l present=true text="▸1 inactive project…"`, `proj headers=["cs-bug106-projB-…"]`,
  `NB="<neighbor-project>"` (a real neighbor dir, name redacted). So the NEIGHBOR A (real on-disk
  sessions older than `INACTIVE_AFTER_DAYS`=14,
  `app.js:1265-1272`) is the inactive one; the fresh B renders active because its registration time
  is recent. Same root cause and same fix as the charter's mechanism (a project header hidden behind
  the inactive-group toggle) — only the identity of the folded project differed. Not a different
  cause, so did not STOP.
- **Changed (test-only):** `scripts/verify-bug-106-crossproject-strip.mjs` — before waiting for both
  headers, wait for the tree to render (either both headers OR the `.inactive-l` group), then drive
  the REAL `.inactive-l` toggle CLICK when present (the authentic user action; sets `showInactive` +
  `renderTree`). No assertion loosened; no product code touched. Once A is expanded further down it
  stays active regardless.
- **Before (must-FAIL):** `node scripts/verify-bug-106-crossproject-strip.mjs` →
  `(timed out waiting for both project headers after 20000ms)` then `FATAL: TypeError: Cannot read
  properties of undefined (reading 'click') at …:181`, `1/1 checks passed` (never reached a BUG-106
  assertion), exit 1.
- **After:** the suite runs to completion and exercises all real BUG-106 assertions: **32/33 PASS**.
  The one FAIL is a **genuine product finding, not a harness defect** and is deliberately left red
  (CONVENTIONS "don't buy green with vacuity"):
  `FAIL  LEAK: the permission SEAL chip does not assert A's "skips prompts" under B` —
  observed `seal="skips prompts"`. While project B is selected and A owns the open session
  (`dockIsForeign()===true`), the crown model chip, integrations strip, rail live-count, run-dot and
  dock accessors all correctly re-scope, but the permission SEAL chip (`#seal .perm`) still paints
  A's "skips prompts" posture — an UNGATED surface, exactly the "sixth silent leak" the suite's own
  header comment (:231-233) warns a new surface could be. This is a real BUG-106 (Option-A dock-gate)
  gap in the current working-tree `app.js`, which is dirty (BUG-196 lane + BUG-106 hunks). Handoff:
  route to the BUG-106/BUG-196 owner — the SEAL chip needs to read through the same dock gate.
- **Sweep (test-suite-only, per charter):** hunted sibling suites for the same two failure shapes.
  (1) Suites that register a real neighbor (`findNeighborProject`) and then locate its header by name
  via `#tree button.proj … projName===NB` WITHOUT first revealing the inactive group:
  `verify-bug-083-project-switch-state.mjs` (:152) and `verify-bug-194-palette-project-select.mjs`
  (:160) carry the identical latent pattern; `verify-bug-193-list-fold.mjs` and
  `verify-feat-070-sidebar.mjs` force `st.expanded` before rendering, which makes the neighbor active
  and side-steps the trap. I did NOT touch 083/194 because their behaviour depends on whether their
  chosen neighbor is currently >14d inactive (they are not reported failing), and each opens the
  neighbor immediately after — not "trivially identical" enough to change blind while other lanes are
  in-flight. Flagged for follow-up: they should reveal the inactive group before the name-match wait.
- **Verified:** reproduced before-state (timeout→TypeError, exit 1); after-state 32/33 with the one
  real product FAIL. Product code untouched; only the verify script changed. Not marking VERIFIED.
- **Symptom of a deeper design flaw?** no — the harness omission is local (it never revealed the
  inactive fold). The SEAL-chip leak it surfaced belongs to BUG-106's ungated-surface class, already
  tracked there.

### 2026-09-29 — clean-room verify lane, round 1 (driver): NOT-RUN (harness verdict-contract limitation)
- **Verify runs attempted (both grey account — same-provider fallback, openai exhausted; VERIFY.md
  #5):** dispatch anthropic run 00c96245-0209-446c-8a3a-e041ddd6355c, then 41faf171-bc81-4d81-a83f-1c5b8caca15e,
  via `scripts/independent-verify.mjs --working-tree` (`--run "node
  scripts/verify-bug-106-crossproject-strip.mjs"`). BOTH returned **verdict-contract INVALID** —
  NOT a BROKEN verdict, and NOT a fix defect.
- **Why not-run, precisely.** The independent verifier reached HOLDS both times (the fix works — the
  inactive-group reveal removes the timeout and the suite runs the full BUG-106 assertion set). But
  the harness `verdict-contract` (`scripts/lib/verdict-contract.mjs`) enforces two mechanical rules
  that are jointly unsatisfiable for THIS suite: (1) the FIXER-TEST citation must be the exact
  `--run` command, and (2) under HOLDS every cited run must exit 0. This suite exits **1 by design**
  — the intentional SEAL-chip product red (the "don't buy green with vacuity" red the fixing lane
  deliberately kept) makes the real, snapshotted, dirty `app.js` produce 32/33, exit 1. So the only
  possible FIXER-TEST citation exits 1, and the contract auto-rejects HOLDS on the exit code, never
  reaching the fix's merits. Note the exit code does not even distinguish fixed from broken here:
  pre-fix exited 1 (TypeError), post-fix exits 1 (SEAL red) — the real signal is the assertion count
  (1/1 aborted -> 33 run).
- **Why a wrapper could not rescue it here.** The clean expression would be a `--run` wrapper that
  exits 0 iff the suite reaches its full assertion set without the timeout/TypeError. But (a)
  `vrun` joins the command argv with spaces before the recorder runs `sh -c`, so a multi-token
  wrapper with internal quoting is mangled, and (b) a driver may only edit ticket files (no committed
  wrapper script). So no clean exit-0 fixer command exists for this suite in this harness.
- **Class note.** This is a **test-harness-only** change (only `scripts/verify-bug-106-crossproject-strip.mjs`;
  no product code), which VERIFY.md's harm-class table scores at **zero** clean-room verify rounds —
  so an independent clean-room verdict is not strictly required to close it.
- **Handoff / orchestrator decision needed:** either (i) accept the test-suite-only zero-round
  exemption and close on the fixing lane's own before/after evidence (timeout->TypeError->exit 1
  pre-fix; 32/33 full assertion set post-fix, the one red being the real SEAL leak); or (ii) commit a
  small exit-0 property wrapper (suite reached the full assertion set, no timeout/TypeError) and
  re-dispatch a clean-room verify against that wrapper as `--run`. The SEAL-chip product leak itself
  stays a real BUG-106/BUG-196 finding, routed there. INDEX untouched (orchestrator-owned).
