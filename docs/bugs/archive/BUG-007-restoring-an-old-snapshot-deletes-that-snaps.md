# BUG-007 — Restoring an old snapshot deletes that snapshot via the pre-restore prune, then fails

- **Status:** VERIFIED
- **Severity:** high
- **Area:** server-api / snapshots
- **Reported:** 2026-08-03 by bug-hunt workflow

## Symptom
Restoring one of the oldest snapshots (when the project is at its keep limit) returns a 'stage-failed' error saying the project was not modified — and the target snapshot silently vanishes from the list. A no-op restore destroys the backup it pointed at.

## Repro
Verified in source. Project at keep limit (default 10). POST restore of the OLDEST snapId. restore() (snapshots.ts:698) calls create({reason:'pre-restore', dedupe:false}) at :715 WITHOUT passing keep. Inside create, prune(project.id, keep=cfg.keep=10) runs at :535 after publishing the 11th snapshot; list() is newest-first so doomed=oldest=the restore target, whose whole dir (incl. tree/) is rmSync'd. Back in restore, fs.readdirSync(tree) at :741 throws ENOENT -> caught at :743 -> SnapshotError('stage-failed'). Target snapshot gone, useless pre-restore snapshot remains.

## Expected
Honest, correct behavior — see fix direction.

## Context pack
- Suspect file(s): src/server/snapshots.ts:715 (pre-restore create) + :535 (prune) + :741 (readdirSync of now-deleted tree)
- Fix direction: Stage the target tree BEFORE creating the pre-restore snapshot, or pass keep=cfg.keep+1 (or protect the restore target from prune) so the pre-restore create can never evict the snapshot being restored.
- Touches: SERVER — check file overlap before parallel dispatch
- Related: none
- Repro test: none yet — the fixing agent MUST add a verify script that FAILS on current code and passes after.

## Activity log (APPEND-ONLY)

### 2026-08-03 — bug-hunt (read-only hunter)
- **Understood:** Restoring one of the oldest snapshots (when the project is at its keep limit) returns a 'stage-failed' error saying the project was not modified — and the target snapshot silently vanishes from the list. A no-op restore destroys the backup it pointed at.
- **Verified:** diagnosis traced against source (see Repro); NOT yet reproduced with a running test.
- **Handoff:** Stage the target tree BEFORE creating the pre-restore snapshot, or pass keep=cfg.keep+1 (or protect the restore target from prune) so the pre-restore create can never evict the snapshot being restored.

### 2026-08-04 — fix + regression test (subagent)
- **Understood:** Confirmed the hunter's trace against a live repro. `restore()` takes a `pre-restore` `create()` first (snapshots.ts:715); `create()` publishes the new entry then `prune(project.id, keep)` (:535). `list()` is newest-first, so at the keep limit the OLDEST = the restore TARGET is `doomed=all.slice(k)[…]` and its whole dir (incl. `tree/`) is `rmSync`'d. Restore then `fs.readdirSync(tree)` (:741) → ENOENT → `stage-failed`. Net: a no-op restore silently destroys the very backup it pointed at.
- **Changed:** `src/server/snapshots.ts` — chose **protect-the-target** over `keep+1`, because `keep+1` still evicts an old target when the store is already OVER the limit (e.g. `keep` was lowered), whereas protection is unconditional and least-surprising (the operation restoring a snapshot can never delete it).
  - Added `CreateOptions.protect?: readonly string[]` and threaded it into the post-create prune: `prune(project.id, keep, opts.protect)`.
  - `prune(projectId, keep, protect = [])` now filters protected ids out of `doomed`, so they survive even outside `keep`.
  - `restore()`'s pre-restore `create()` passes `protect: [snapshotId]` (with a comment tying it to this ticket).
- **Verified:** Extended `scripts/verify-snapshots.ts` with **section 3b** — a project AT the keep limit (keep=3, 3 distinct snapshots), restoring the OLDEST. Asserts (a) restore SUCCEEDS, (b) target snapshot + tree still exist and are byte-identical, (c) all 3 originals survive and the project tree matches the restored snapshot.
  - `npm run typecheck` → PASS (tsc --noEmit, no output).
  - On UNFIXED code (`git stash` of snapshots.ts): section 3b FAILS as predicted — `(a)` throws `stage-failed`, `(b)` target `meta present: false, tree present: false`, `(c)` `2/3 originals survive; lost=[<target>]`. Proves the test bites.
  - `npm run verify:snapshots` with the fix → **72 passed, 0 failed, 72 checks** (WITHOUT --big/--live). Full suite, no regressions.
  - PASS  (a) restoring the oldest snapshot at the keep limit SUCCEEDS
  - PASS  (b) the target snapshot tree is byte-identical to before (not clobbered)
  - PASS  (c) every pre-existing snapshot survived the restore (none silently pruned away)
- **Open:** None. Left in the working tree (not committed) per tracker rules. Sections 2 (`--big`) and 6 (`--live`) not run (unrelated; require flags/model).
