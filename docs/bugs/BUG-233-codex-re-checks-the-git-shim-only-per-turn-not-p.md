```orchard-ticket
{
  "id": "BUG-233",
  "type": "bug",
  "title": "Codex re-checks the git shim only per turn, not per command",
  "summary": "CodexRuntime runs the BUG-230 shim ensure() only at #startTurn; Codex has no per-command hook. A Codex turn that deletes its own session shim directory mid-turn makes every later subprocess git in that same turn resolve to the real binary, ungated (no grant, no leak gate), until the next turn restores or refuses.",
  "impact_if_we_wait": "A Codex (openai) session can make ungated git writes within one turn by removing its own shim dir first. Known and accepted as a limitation in BUG-230 r3; the Claude runtime is not affected (its PreToolUse hook re-checks before every Bash call).",
  "current_need": "Decide whether a Codex mid-turn shim deletion must fail closed within the turn (e.g. a shim location the agent cannot remove, or a per-exec re-check), or stays an accepted limitation.",
  "severity": "medium",
  "area": "FEAT-135 git shim lifecycle (Codex)",
  "reported": "2026-10-05",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-10-05",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A Codex turn that deletes its own shim dir then commits gets that commit refused or the turn stopped.",
    "Must-FAIL: the BUG-230 r3 verifier's verify-active-turn.mjs sequence (refused commit, rmSync own shim dir, commit again) reproduces on the pre-change code."
  ],
  "code_refs": [
    {
      "path": "src/server/runtime/codex-runtime.ts",
      "symbol": "#startTurn",
      "note": "gitShim.ensure() runs once per turn, not per command"
    },
    {
      "path": "scripts/lib/git-shim.mjs",
      "symbol": "installGitShim",
      "note": "ensure() restores/refuses only when called"
    }
  ],
  "related": [
    {
      "id": "BUG-230",
      "relation": "see_also"
    },
    {
      "id": "FEAT-135",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": false,
    "Evidence": true,
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

# BUG-233 — Codex re-checks the git shim only per turn, not per command

## Symptom

Within a single Codex turn, a subprocess `git commit` is refused by the shim; the turn then `rmSync`s its own session shim directory and commits again, and the second commit runs on the real git binary, ungated.

## Evidence

- BUG-230 r3 independent verify, dispatch openai/default run 01a10dfb-5db0-73d1-8d22-c3923d35e3ed (verdict HOLDS for the FIFO fix; this gap was the pre-declared known limitation, probe cebfdafc2858 exit 1, verifier's verify-active-turn.mjs driving the real CodexRuntime with the fixture app-server).
- BUG-230 fixing log: "Codex has no per-command hook, so a shim deleted MID-turn is caught only at the next turn (limitation)."

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-06 — agent
- Filed (file only) from BUG-231/FEAT-164 fixing r5 at the orchestrator's request. Known limitation recorded in BUG-230 r3; not worked here.
