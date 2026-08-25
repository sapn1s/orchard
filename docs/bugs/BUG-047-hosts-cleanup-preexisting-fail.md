```orchard-ticket
{
  "id": "BUG-047",
  "type": "bug",
  "title": "Cleanup checks failed on an unchanged codebase",
  "summary": "The cleanup checks now preserve their original assertions while accounting for a backgrounded survivor process. A planted break still fails, both restart suites pass, and standing type and leak checks remain clean.",
  "impact_if_we_wait": "Without the correction, a healthy cleanup behavior appears broken and wastes investigation time. Bounded: this affects verification accuracy, not runtime behavior or user data.",
  "current_need": "Treat the ticket as closed: the original failure was reproduced, the harness cause was corrected, a planted break failed, and restart checks passed.",
  "severity": "medium",
  "area": "Cleanup verification",
  "reported": "2026-08-11",
  "reported_by": "bug-hunt workflow",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-11",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-11",
      "question": "Did the failures come from suite drift or a cleanup regression?",
      "mode": "single",
      "options_keys": [
        "A",
        "B"
      ],
      "chosen": "A",
      "chosen_on": "2026-08-11",
      "chosen_by": "agent",
      "note": "BUG-047 chose A, suite drift: the engine backgrounds the survivor process, while the existing close behavior remains correct."
    }
  ],
  "success_criteria": [
    "Cleanup assertions account for the backgrounded survivor without becoming weaker",
    "A planted behavioral break still causes the checks to fail",
    "Restart anti-regression suites pass and standing checks remain clean"
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": true,
    "Migration and rollback": true,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-047-hosts-cleanup-preexisting-fail.md",
    "sha256": "c26a0350f45ed36f1eddf62de61c304046fb0a143859ea5938fd8da1c1c7a8da",
    "bytes": 4493,
    "original_title": "verify:hosts-cleanup fails 3 checks at pristine HEAD (pre-existing, found during BUG-044)",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the supplied original and extracted evidence; the pristine failure, suite-drift diagnosis, preserved assertions, planted break, and executed checks remain represented.",
    "dropped": []
  }
}
```

# BUG-047 — Cleanup checks failed on an unchanged codebase

## Diagnosis

The three failures came from suite drift rather than a cleanup regression. The engine backgrounds the survivor's `sleep`, while the earlier close behavior correctly waits. The harness had retained an outdated process-lifecycle assumption.

## Evidence

The original `verify:hosts-cleanup` run produced 14/17 with three failures at pristine HEAD in a clean worktree. After the harness correction, an unnamed matched tally recorded 17/17 and another recorded 8/8. `verify:bug-044-restart-background` and `verify:restart-survives` each recorded 15/15 passing. A planted break failed as intended. Typecheck and leak-gate were clean.

## Implementation notes

Update the harness to reflect that the survivor process is backgrounded. Preserve the three behavioral assertions rather than weakening them.

## Verification plan

Retain the corrected cleanup checks and the planted-break test. Run both restart suites and the standing type and leak checks after changes affecting cleanup behavior.

## Migration and rollback

The change is confined to the verification harness. Reverting it restores the stale lifecycle assumption and the three false failures.

## Risks

Over-accommodating background execution could hide a real cleanup regression. The planted-break failure guards against that weakening.

## Activity log (APPEND-ONLY)
### 2026-08-11 — orchestrator
- Filed from BUG-044's honest anti-regression note. Same family as BUG-036/BUG-039 (the harness
  itself must stay trustworthy).

### 2026-08-11 — fix agent (root cause + fix, VERIFIED)
- **Repro at HEAD:** first run passed 17/17; forcing the survivor to still be mid-work at close
  time (`VERIFY_HOSTS_CLEANUP_N=1`) reproduced the exact 3-check signature deterministically:
  `[survivor] broker exited after its own genuine close`, `[survivor] no leftover files`,
  `[final] hostsDir() empty` — 14/17 at default N is a timing coin-flip, 17/17 when the 4 cycles
  happen to outlast the survivor's work.
- **Root cause (SUITE ROT, not a sweep regression), instrumented evidence:**
  - Instrumented runs (server stdout captured — the suite ignores it, which is why this was
    invisible) caught the server's own decision at close time:
    `client closed: session … detached instead of closed — work outlives the turn (yes: the
    engine reports 1 background task)`.
  - The modern engine **backgrounds** the survivor's `Bash sleep 45`: the turn ends immediately
    (turn-end lands seconds in) and the CLI's level frame truthfully reports a live background
    task. `releaseSocketSession` (BUG-018 busy→detach; BUG-043 lifetime-gate) then rightly
    DETACHES and HOLDS until the level empties — the broker stays `running` (never `draining`,
    exactly BUG-044's observation) until the sleep finishes and the detached-close fuse closes it.
    The suite waited only 30s, so it recorded the designed hold as a cleanup failure.
  - **Historical worktree runs** (git worktree at 77405a2, the commit that introduced this suite
    with BUG-023): the same mid-work close reaped the broker in ~5–20s and passed — because the
    pre-BUG-043 boundary fuse closed at turn-end with NO lifetime check, i.e. it KILLED the live
    backgrounded sleep. The old green was the very defect BUG-043 fixed. No commit "broke the
    sweep"; the suite's premise (`sleep 45` = turn in flight) rotted out from under it.
  - The BUG-023 sweep itself is intact at HEAD: every genuine close removes all 3 files (all
    cycle checks pass), sibling closes never sweep a live host, and the final dir empties.
- **Suite fix** (`scripts/verify-hosts-cleanup.mjs`, assertions untouched):
  1. Before closing the survivor, WAIT for its `turn-end` (hard precondition, FATAL on 180s
     timeout) so the close lands at a turn boundary instead of racing model/provider timing.
  2. Widen the survivor-exit wait 30s→120s to cover the DESIGNED bounded hold: sleep remainder
     (≤45s) + fuse recheck cadence (≤30s) + graceful reap.
- **Must-FAIL proof (teeth kept):** planted break in a scratch HEAD worktree — removed
  `shutdown()`'s status-file `rmSync` in `src/server/session-host.mjs` → fixed suite fails 4
  checks including all three of this ticket's assertions (leftover files after close, survivor
  leftovers, final dir non-empty). A genuinely-broken sweep still fails loudly.
- **Green at HEAD:** hosts-cleanup **17/17** (default N) and **8/8** at N=1 (the previously
  deterministic-failure path); anti-regressions: verify:bug-044-restart-background **15/15**,
  verify:restart-survives **15/15**; `npm run typecheck` clean; leak-gate **PASS** (0 hits /
  301 files). Historical worktrees removed; no other commits checked out in the main tree.
