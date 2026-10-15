```orchard-ticket
{
  "id": "FEAT-174",
  "type": "feature",
  "title": "Verify suites have a runner and CI",
  "summary": "The project had 261 verify suites but no npm test, no runner and no CI, so nothing proved they still pass. A runner, a tiered manifest and a CI workflow were built and committed (ed92aff), plus a suite-health run. None of it is independently verified, and the health run surfaced failures still to be triaged.",
  "impact_if_we_wait": "Without an independent verify, the runner and CI are unproven, so a future regression in the verify suites can land uncaught. The ~10 real-candidate failures, the crashing orchestrator-enforcement test, the untriaged browser tier and the unpushed workflow stay open and drift further from the committed code.",
  "current_need": "An independent verify of the runner; confirm the ~10 real-candidate failures on committed main; fix the orchestrator-enforcement test that crashes on import; triage the browser tier; and push and exercise the CI workflow.",
  "severity": "medium",
  "area": "Test tooling / CI",
  "reported": "2026-10-10",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "in_verification",
  "human_action": "none",
  "updated": "2026-10-11",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "The runner has an independent clean-room HOLDS verdict on a case the author fixture does not cover.",
    "Each of the ~10 real-candidate failures is confirmed on committed main as a real regression or explained as environmental or stale.",
    "verify:orchestrator-enforcement no longer crashes on import and tests the current allow-list API.",
    "The browser tier is triaged against a warm server at concurrency one.",
    "The CI workflow is pushed and has run green at least once."
  ],
  "code_refs": [],
  "related": [
    {
      "id": "FEAT-033",
      "relation": "see_also"
    },
    {
      "id": "BUG-227",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": false,
    "Verification plan": false,
    "Migration and rollback": false,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": null,
    "sha256": null,
    "original_title": null,
    "migrated_on": null,
    "migrated_by": null,
    "confirmation": "Authored directly in the record format through scripts/board-tool.mjs. There is no legacy original.",
    "dropped": []
  }
}
```

# FEAT-174 — Verify suites have a runner and CI

## Diagnosis

### Why this ticket exists

The project had 261 `verify:*` suites and 298 npm scripts, but no `npm test`,
no runner, and no CI. `npm run gate` runs only leak/NUL/privacy/typecheck, so
nothing proved the verify suites still pass. A runner, a tiered manifest and a
CI workflow were built to close that gap, and a suite-health run measured the
true state of the suites. That work is committed (ed92aff) but was never
independently verified, and the health run left a set of failures to confirm.

This ticket exists because the work below was mis-filed on FEAT-033 (tool
adoption). Its substance is moved here; FEAT-033 carries a correction entry.

## Evidence

### Built (committed in ed92aff)

- `scripts/gen-test-manifest.mjs` + generated `scripts/test-manifest.json` — ONE
  owner (ARCH-010) of each suite's tier. 261 suites classified by static signal:
  pure 128, browser 90 (inline Brave/CDP or Playwright), scratch-server 23,
  host-live 13, docker-sandbox 7. 45 flagged `needsGit`. `--check` guards drift.
- `scripts/test-runner.mjs` = `npm test` — bounded parallelism, docker-sandbox
  serialized, per-suite timeout (`timeoutSec`; the global `--timeout` is the
  floor and only raises), logs to scratch, summary table, true aggregate exit.
  Refuses host-live without `--include-host-live`; FAILS LOUD on any unclassified
  `verify*` script; detects a git-write-blocked lane and SKIPs `needsGit` suites
  so a lane artifact is not scored as a regression.
- `.github/workflows/test.yml` — Node 23 / ubuntu, runs the PORTABLE (pure) tier
  + gate + manifest:check. CI cannot run browser, docker-sandbox, scratch-server
  or host-live (no browser / no standing sandbox / port-proc flakiness / no live
  service).

### Suite-health run (de-contaminated, round 2)

Method: pinned the current working tree to a reflink scratch copy, PRESERVED the
real `.git` with a synthetic identity, ran with the git-shim stripped from
`$PATH` so `needsGit` suites write fixture repos via real git. One runner per
tree (concurrent runners race the shared board). Full table + per-suite
classification: `~/.local/state/claude-station/scratch/feat-033-health/report.md`.

Counts (default = pure + scratch-server), real-history, fixed manifest: 91 pass
/ 57 fail-timeout of 148 (pure 81/44/2, scratch-server 10/6/5). Browser tier
(separate tree, Brave): 33 / 57 of 90 — dominated by scratch-server session-init
readiness under concurrency; NOT separately triaged (needs warm server / conc-1).

Classification of the 57: ENV ~34 (shim-PATH, scratch-server cold boot-probe
readiness ~16, flaky, docker/filesystem/git-history/registered-project). STALE
~13 (committed-API 4; board/corpus-coupled ~9, the class CONVENTIONS §Testing
already names). REAL candidate ~10 — all reddening against UNCOMMITTED
working-tree edits at the time, not committed main.

## What is still open

1. **Independent verify of the runner.** The runner + manifest + CI were
   self-verified by the builder only (synthesized failing suite made `npm test`
   exit 1; summary table real; `npm run gate` exit 0). No clean-room HOLDS
   verdict exists. This is regression-prone tooling and warrants
   `scripts/independent-verify.mjs` or a fresh-context agent.

2. **~10 REAL-candidate failures to confirm on committed main.** The health run
   measured these against the mid-change working tree, not committed main, so
   each must be re-confirmed as a real regression or explained as
   environmental/stale now that ed92aff has landed:
   - `verify:feat-085-independent`, `verify:feat-085-adversarial`,
     `verify:feat-083-adversarial` — flagged on committed main (a round-3 lane on
     BUG-227 found the FEAT-083/085 parse failures are PRE-EXISTING COMMITTED
     failures at HEAD, independent of the `.orchard/` cleanup; re-confirm).
   - `verify:session-provenance-fold` (live/open agent sessions not fold-exempt),
     `verify:feat-071-project-dir` (no Directory line in settings drawer),
     `verify:feat-145-usage` (paintUsageChip throws),
     `verify:feat-049-licence` (C9).
   - `verify:bug-138` (missing-dir repoint emits a fatal error, not a clean 400)
     and `verify:bug-138-ui`.

3. **`verify:orchestrator-enforcement` is an outdated test that crashes on
   import.** A HARD import crash on the removed export
   `ENFORCE_DENIED_GIT_SUBCOMMANDS` after the profile moved deny-list ->
   allow-list. Fix the test to the current allow-list API (STALE committed test,
   not a product regression).

4. **The browser tier has not been triaged.** 33 / 57 of 90, dominated by the
   scratch-server session-init readiness cause under concurrency. Needs a warm
   server at concurrency 1 before any browser suite is called a real regression.

5. **The CI workflow has not been pushed or exercised.** `.github/workflows/test.yml`
   has never run; it needs to be pushed and shown green at least once.

## Risks

- The runner's static tier signal under-detects session-lifecycle suites that
  spawn the server indirectly (verify:detach, :reattach-approval,
  :close-busy-detach, :bug-044-restart-background, :bug-123, :triage) — widen the
  signal or raise their timeout.
- The scratch-server tier is intrinsically flaky on this machine; the pure tier
  is stable. Treat scratch-server reds as suspect until re-run warm.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-11 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-11 — item 3 resolved: orchestrator-enforcement test rewritten (Opus 4.8 fix lane)
- **Success criterion 3 MET:** "verify:orchestrator-enforcement no longer crashes on
  import and tests the current allow-list API." The crash (removed export
  `ENFORCE_DENIED_GIT_SUBCOMMANDS`) is fixed; `scripts/verify-orchestrator-enforcement.mjs`
  now imports `GIT_ALLOWED_SUBCOMMANDS` + `resolveGitSubcommand` and tests the round-4
  allow-list, including a synthesized-broken-allow-list MUST-FAIL (non-vacuity). Full run:
  **PASS — 297 passed / 0 failed / 0 skipped**, exit 0; `npm run gate` exit 0. Details +
  regressed-from note on BUG-226's Activity log (2026-10-11, test rewrite). This was
  FEAT-174's EASY carve-out and is DISTINCT from BUG-185 (the oracle shape-robustness
  ticket on the same file), which was NOT touched.
- **Item 2 — the ~10 real-candidate failures: LISTED, NOT triaged (per this lane's charter).**
  Carried verbatim from the ticket body; this lane did not re-run or fix them (scope was
  item 3 only):
  1. `verify:feat-085-independent` — parse failure; flagged PRE-EXISTING committed failure
     at HEAD (BUG-227 round-3 lane), re-confirm.
  2. `verify:feat-085-adversarial` — same cluster, re-confirm on committed main.
  3. `verify:feat-083-adversarial` — same cluster, re-confirm on committed main.
  4. `verify:session-provenance-fold` — live/open agent sessions not fold-exempt.
  5. `verify:feat-071-project-dir` — no Directory line in the settings drawer.
  6. `verify:feat-145-usage` — paintUsageChip throws.
  7. `verify:feat-049-licence` — C9.
  8. `verify:bug-138` — missing-dir repoint emits a fatal error, not a clean 400.
  9. `verify:bug-138-ui` — companion UI suite to bug-138.
  Each still needs confirmation on committed main (real regression vs environmental/stale);
  the browser tier (item 4, 33/57 of 90) and CI push (item 5) remain untouched.
- **Verified-by:** (pending) — item 1 (runner independent clean-room HOLDS) still owed;
  items 2/4/5 still open. This entry closes only item 3.
