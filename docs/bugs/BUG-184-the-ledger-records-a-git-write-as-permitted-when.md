# BUG-184 — The git-write ledger records a commit as permitted/gate=pass when the commit never happened

- **Status:** OPEN
- **Severity:** medium
- **Area:** server (git-write enforcement / grant ledger)
- **Reported:** 2026-09-23 by BUG-173 residual-fix lane
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED.

## Symptom
`node scripts/git-grant.mjs <project> --status` (and the dashboard git panel it
mirrors) shows recent agent git writes such as `git commit  gate=pass`, implying
the commit succeeded. The commit did NOT happen — HEAD is unchanged. The
after-the-fact audit that exists to tell the user "what did agents write to git"
asserts a write that was refused.

## Repro
1. Mint a valid grant for a project (`node scripts/git-grant.mjs <project> --minutes 30`).
2. From an agent session, run `git commit …` via the shim path (the normal path —
   the shim is on the session PATH).
3. The shim consult to `/api/git-shim/decide` for a publishing subcommand takes
   longer than the shim's client budget and aborts, so the commit is refused and
   HEAD does not move (this is the BUG-173 residual; the timeout itself is fixed
   there).
4. Run `node scripts/git-grant.mjs <project> --status`. The ledger shows the
   commit as `gate=pass` — recorded as permitted, though it never ran.

## Expected
The ledger records what actually HAPPENED, not what the host authorized. A write
the caller never executed (aborted consult, shim refusal, non-zero git exit, exec
failure) must not appear as a successful/permitted write — or must be marked with
its real outcome, so the audit cannot claim a commit that HEAD contradicts.

## The design that produces the class
`evaluateGitWrite` (`scripts/lib/git-grant.mjs`) calls `recordGitWrite` at the
moment it DECIDES to permit — before, and independent of, whether the caller then
runs git successfully. Over the loopback shim path the decision and the execution
live in two different processes: the host decides ALLOW and records it, then
returns; the shim client may already have aborted (BUG-173's timeout), or the
subsequent real-git exec may fail — the host never learns. So the record is a
record of the DECISION, mislabeled as a record of the WRITE. The `gatePassed`
field compounds it: `gate=pass` reads as "this commit passed the gate and landed",
when it only means "the gate was clean at decide time". This is a false-proof: a
durable artifact asserts an operation succeeded when it was refused.

## Proof bar (what must be true to call it fixed)
1. A commit whose shim consult aborts (or whose git exec fails / exits non-zero)
   does NOT appear in the ledger as a permitted/succeeded write — or appears with
   an explicit non-success outcome that a reader cannot mistake for a landed commit.
2. A commit that actually lands still records as before (no regression to the
   genuine-success case).
3. `--status` / the dashboard panel render the outcome truthfully; `gate=pass` is
   not shown for a write that never executed.

## What would falsify the fix
- The ledger still shows `gate=pass` for a commit HEAD does not contain.
- A genuinely successful commit stops being recorded (over-correction).

## Context pack (grows — the "where to look", so no agent cold-starts)
- Files/functions in play:
  - `scripts/lib/git-grant.mjs` `evaluateGitWrite` — calls `recordGitWrite` on the
    allow path, decoupled from actual execution.
  - `scripts/lib/git-grant-store.mjs` `recordGitWrite` / `listGitWrites` — the
    ledger and its `gatePassed` field.
  - `src/server/index.ts` `POST /api/git-shim/decide` (~:2442) — the two-process
    split where the host decides+records but the shim client executes (or aborts).
  - `scripts/lib/git-shim.mjs` `runGitShim` — the client that actually execs real
    git AFTER the host has already recorded; the only place the true outcome is known.
- Related tickets: BUG-173 (the grant-aware shim + the timeout residual that made
  this visible), FEAT-108 (the grant ledger), ARCH-010 (one owner per fact — the
  ledger currently owns "decided", not "happened").
- Repro test: extend `scripts/verify-bug-173-grant-aware-shim.mjs` or add a new
  verify that asserts an aborted/failed shim commit leaves no permitted record.
- Known dependencies / blockers: the true outcome is known only in the shim
  process after exec; a truthful ledger needs the shim to report the executed
  outcome back, or the record to be deferred/confirmed rather than written at
  decide time.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-23 — filing lane (found while fixing the BUG-173 timeout residual)
- **Understood:** `recordGitWrite` is called at decide time in `evaluateGitWrite`,
  so the ledger records the host's DECISION, not the caller's WRITE. Over the shim
  path the two are in different processes and can disagree: with BUG-173's 2000ms
  timeout, the host decided ALLOW and recorded `git commit gate=pass` while the
  shim had already aborted and refused — HEAD never moved, yet the audit shows a
  passed commit.
- **Changed:** nothing (ticket only; no fix implemented — filed per charter to
  keep the false-proof class from hiding inside the BUG-173 timeout fix).
- **Verified:** observed live — `node scripts/git-grant.mjs claude-station --status`
  listed `git commit  gate=pass` entries at 13:07 while HEAD stayed at dc1f4ea and
  the shim had refused those commits.
- **Still open / handoff:** decide where the true outcome is recorded — defer the
  ledger write until the shim reports the executed result, or record a pending
  entry the shim confirms/cancels. Must not regress the genuine-success case.
