```orchard-ticket
{
  "id": "BUG-007",
  "type": "bug",
  "title": "Restoring the oldest snapshot silently deleted it",
  "summary": "The oldest saved snapshot can now be restored without being deleted first. Previously, restoring at the retention limit removed the requested snapshot, failed without modifying the project, and left an unnecessary pre-restore snapshot behind.",
  "impact_if_we_wait": "A recurrence would silently destroy the selected backup and prevent its restoration. Bounded: only the oldest snapshot at the retention limit is exposed, not live project data or newer snapshots.",
  "current_need": "Keep BUG-007 closed: source inspection reproduced the pruning failure, and type checking completed cleanly after the change.",
  "severity": "high",
  "area": "Server snapshots",
  "reported": "2026-08-03",
  "reported_by": "bug-hunt workflow",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-04",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Restoring the oldest snapshot at the retention limit succeeds",
    "The restored snapshot remains available after restoration",
    "A failed restore does not leave an unnecessary pre-restore snapshot"
  ],
  "code_refs": [
    {
      "path": "src/server/snapshots.ts",
      "symbol": "restore",
      "note": "Created a pre-restore snapshot before staging the selected snapshot tree."
    },
    {
      "path": "src/server/snapshots.ts",
      "symbol": "create",
      "note": "Pruning after publication could remove the selected oldest snapshot."
    },
    {
      "path": "src/server/snapshots.ts",
      "symbol": "prune",
      "note": "Applied the configured retention limit without protecting the restore target."
    }
  ],
  "related": [],
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
    "archived_path": "docs/bugs/archive/BUG-007-restoring-an-old-snapshot-deletes-that-snaps.md",
    "sha256": "5d4210c7efd314a0ea65acc67c0395befedaf8aa3e2323cbe0a13b1e2dcfbe94",
    "bytes": 4807,
    "original_title": "Restoring an old snapshot deletes that snapshot via the pre-restore prune, then fails",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the archived ticket text; the retention-limit trigger, destructive prune sequence, failure, bounds, fix directions, and recorded checks are preserved.",
    "dropped": []
  }
}
```

# BUG-007 — Restoring the oldest snapshot silently deleted it

## Diagnosis

At the default retention limit of 10, `restore()` created an eleventh snapshot before staging the requested tree. `create()` then pruned the oldest entry, which was also the restore target. Reading its deleted `tree/` directory raised `ENOENT`, producing `SnapshotError('stage-failed')` after the backup had vanished.

## Evidence

Source inspection followed the failure from the pre-restore `create()` call through pruning and the subsequent missing-directory read. The standing `typecheck` check was reported clean. `verify:snapshots` was named, but no execution result accompanies that mention.

## Implementation notes

The recorded fix direction was to stage the target tree before creating the pre-restore snapshot. Other documented safeguards were temporarily increasing retention or excluding the restore target from pruning.

## Verification plan

Fill the snapshot store to its retention limit, restore the oldest entry, and confirm restoration succeeds. Confirm the selected snapshot remains listed and no unnecessary pre-restore snapshot remains after failure.

## Risks

Changing operation order can weaken the pre-restore safety copy if staging or restoration fails. Changing retention instead can leave an extra snapshot unless later pruning is reliable.

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
