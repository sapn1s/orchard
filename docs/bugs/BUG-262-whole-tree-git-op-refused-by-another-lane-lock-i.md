```orchard-ticket
{
  "id": "BUG-262",
  "type": "bug",
  "title": "Whole-tree git op refused by another lane lock in the same project",
  "summary": "A merge, rebase, pull or reset with no pathspec is refused busy when another live lane of the same project holds any per-file lock, because the file-lock keyspace is shared across every session and copy of one project. It is not self-blocking, but concurrent same-project lanes serialize whole-tree git ops, which can leave a merge stuck behind a sibling lane.",
  "impact_if_we_wait": "Concurrent lanes in one project can block each others merges and rebases with no clear signal; cross-project copies of one repo are not coordinated at all.",
  "current_need": "Decide whether whole-tree git ops should be gated by other lanes per-file locks, and whether cross-project repo copies should coordinate.",
  "severity": "low",
  "area": "file locks",
  "reported": "2026-10-14",
  "reported_by": "agent",
  "owner": "agent",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-10-14",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A whole-tree git op is not blocked by an unrelated concurrent lane in a way the user cannot see or resolve.",
    "The chosen policy for cross-project copies of one repo is documented and tested."
  ],
  "code_refs": [
    {
      "path": "scripts/lib/file-lock.mjs"
    }
  ],
  "related": [
    {
      "id": "FEAT-129",
      "relation": "see_also"
    },
    {
      "id": "FEAT-190",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": false,
    "Evidence": false,
    "Implementation notes": false,
    "Verification plan": false,
    "Migration and rollback": false,
    "Risks": false,
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

# BUG-262 — Whole-tree git op refused by another lane lock in the same project

## Symptom

A session's whole-tree git operation (merge / rebase / pull / reset) can be refused
"busy" by a per-file lock held by ANOTHER live lane of the SAME project, because the
file-lock keyspace is shared across every session, lane and container copy of one
project (`<dataDir>/file-locks/<projectKey>`, keyed by repo-relative path). Reported
during the FEAT-190 redesign as "file locks cover the whole project, every copy of
the repo," which kept a session's merge stuck.

## What is and is not true (investigated under FEAT-190)

- NOT self-blocking: `scripts/lib/file-lock.mjs` `checkTree` and `checkScope` SKIP
  `lock.owner === owner`, so a session's own locks never block its own tree op.
- Real effect: a tree-wide mutator (`GIT_TREE_MUTATORS`, no pathspec → `{tree:true}`
  via `gitMutationTarget`) is BUSY-refused if ANY path is held by a DIFFERENT live
  owner — another lane of the same project, or the host/container copy (paths are
  unaliased onto one keyspace by `pathAliases`).
- Across projects pointed at the same repo path: different `<projectKey>` lock dirs,
  so NOT coordinated (a separate gap).

## Expected / open question

Decide whether a whole-tree git op should be gated by other lanes' per-file locks at
all (a merge touches the whole tree, so it collides with any concurrent edit), and
whether cross-project copies of one repo should coordinate. Options include: queue
the tree op behind live per-file locks instead of refusing; scope tree ops to a repo
-level lock; or leave as-is (document that concurrent same-project lanes serialize).

## Context pack

- `scripts/lib/file-lock.mjs`: lock dir `<dataDir>/file-locks/<projectKey>`,
  `lockKeyFor`, `repoRelative`, `GIT_TREE_MUTATORS`, `gitMutationTarget`,
  `checkTree`, `checkScope`, `pathAliases`/`unalias` (FEAT-129).
- Split from FEAT-190 (the git-grant redesign) per the orchestrator — this is
  lane-concurrency, not the grant chokepoint.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-14 — agent
- **Filed:** through the board tool; the record was validated before it was written.
