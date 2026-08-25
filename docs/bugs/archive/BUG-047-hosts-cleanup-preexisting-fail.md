# BUG-047 — verify:hosts-cleanup fails 3 checks at pristine HEAD (pre-existing, found during BUG-044)

- **Status:** VERIFIED 2026-08-11 — suite rot root-caused (engine backgrounds the survivor's `sleep`; BUG-043's close rightly holds), suite fixed without weakening assertions (planted-break FAIL proven); 17/17 at HEAD + all anti-regressions green
- **Area:** verification integrity (hosts-cleanup suite or the sweep it tests)
- **Reported:** 2026-08-11 by BUG-044's fix agent (anti-regression run)

## Finding
`npm run verify:hosts-cleanup` → **14/17, 3 FAIL** — reproduced identically at pristine HEAD in a
clean worktree, so it is NOT a BUG-044 regression (documented in BUG-044's ticket log). Unknown
whether the suite drifted (BUG-036/039 class: harness rot) or the session-hosts cleanup sweep
genuinely regressed at some earlier commit.

## Next step
Bisect-or-audit: run the suite at a few historical commits to find where 17/17 last held; then
decide suite-rot vs real regression and fix the true side. Must not be "fixed" by weakening the
three assertions.

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
