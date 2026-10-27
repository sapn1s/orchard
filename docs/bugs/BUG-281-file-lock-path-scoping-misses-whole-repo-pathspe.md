```orchard-ticket
{
  "id": "BUG-281",
  "type": "bug",
  "title": "File-lock path-scoping misses whole-repo pathspecs on simple git lines",
  "summary": "BUG-277 r9 IV (anthropic run 2c55fd7b) found gitMutationTarget keys whole-repo pathspecs narrow on a simple line: git magic :/ (restore/checkout/rm), paths normalizing to the repo root or above (src/.., $PWD), and globs (git checkout -- *). A real-git wipe passed a foreign lock. Pre-existing, independent of BUG-277 count logic.",
  "impact_if_we_wait": "A simple git command can wipe another lane uncommitted work despite the file lock.",
  "current_need": "in gitMutationTarget treat magic pathspecs, root-or-above normalizations and glob metacharacters as whole-tree; must-FAIL from current code; independent verify.",
  "severity": "high",
  "area": "lanes/file-lock",
  "reported": "2026-10-27",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-10-27",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "checkout/restore/rm with :/, a root-normalizing path or a glob is classified whole-tree under a foreign lock"
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "6c1f82b7-37d7-42d9-b104-8b2f79614e94",
      "verdict": "holds",
      "verdict_on": "2026-10-27",
      "recorded_at": "2026-10-27T19:14:35.241Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "749f68a11a78971c408fac5a58d5a6ccec6e62d6d96955cd265c1f10139c81c1",
      "verify_mode": "mixed-state",
      "note": "gitMutationTarget narrowness gate + deny-by-default on options + prefix-aware git check; IV found 5 false-ALLOWs across rounds (magic/glob/root, icase+bare-dir, option abbrevs, switch/ref verbs, brace/extglob/-C-escape) now closed. anthropic-only (openai quota/infra); high-stakes."
    }
  ],
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

# BUG-281 — File-lock path-scoping misses whole-repo pathspecs on simple git lines

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-27 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-27 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run 6c1f82b7-37d7-42d9-b104-8b2f79614e94 — VERDICT: HOLDS — mixed-state candidate 749f68a11a78 — gitMutationTarget narrowness gate + deny-by-default on options + prefix-aware git check; IV found 5 false-ALLOWs across rounds (magic/glob/root, icase+bare-dir, option abbrevs, switch/ref verbs, brace/extglob/-C-escape) now closed. anthropic-only (openai quota/infra); high-stakes.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-27 — worker (fixing r1)
- **Diagnosis + fix:** Chokepoint gitMutationTarget (scripts/lib/file-lock.mjs): a pathspec stays narrow only via isNarrowPathspec (plain in-repo literal: no leading :, no glob/brace, no $/~, not absolute, no trailing /./.. dir segment, not root-or-above). Options deny-by-default (SAFE_GIT_PATHSPEC_FLAGS only); post-`--` pathspec-scoping limited to checkout/restore/rm/checkout-index/reset, bare to restore/rm/checkout-index; any non-`-C` global → tree (catches --icase-pathspecs + abbrevs); -C-composed path re-validated; isSimpleLine rejects ()/extglob; read-tree→tree; evaluateFileLock checks git-mutation keys prefix-aware (checkScope) for bare dirs. Must-FAIL baseline captured pre-fix. 402-test suite PASS, gate exit 0. IV HOLDS run 6c1f82b7 after closing 5 IV-found false-ALLOWs.
