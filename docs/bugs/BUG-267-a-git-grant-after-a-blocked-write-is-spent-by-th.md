```orchard-ticket
{
  "id": "BUG-267",
  "type": "bug",
  "title": "A git grant after a blocked write is spent by the retry",
  "summary": "In a direct session where the git shim could not be installed, the PreToolUse hook blocks a git write before the grant store sees it. If the user then grants access, the blocked command's retry consumes that grant instead of the next command, so the next git write is refused and the user must grant again.",
  "impact_if_we_wait": "A once-grant issued right after a shim-missing block is wasted on the retry and the agent's next genuine git write is refused, so the user re-grants. Low frequency: it needs the shim to be missing (BUG-230) and the CLI to re-send a denied tool_use_id.",
  "current_need": "Fixed structurally at the one deny exit; needs an independent verify.",
  "severity": "low",
  "area": "agent git-write grant",
  "reported": "2026-10-20",
  "reported_by": "agent",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-10-20",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A git-write call denied before any claim is opened (shim-missing or other pre-claim deny) tombstones its call id, so its same-id retry is denied.",
    "A once-grant issued after such a denial stays available for the agent's next Bash call, not spent by the denied id's retry."
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "openai",
      "model": "default",
      "run_id": "01a15811-00af-7251-b420-e7bfcdbd2fe0",
      "verdict": "holds",
      "verdict_on": "2026-10-20",
      "recorded_at": "2026-10-20T06:52:06.074Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs"
    }
  ],
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

# BUG-267 — A git grant after a blocked write is spent by the retry

## Symptom

Found by the BUG-231/FEAT-164 round-6 independent clean-room verify (anthropic, run `9614f08f-719b-4b7d-be48-281f195ea49e`, VALID BROKEN, single break). This is a P3 (call-id tombstone) gap on a DIFFERENT deny path than the one BUG-231 r7 closed.

BUG-231 r7 made every terminal outcome for a Bash call id tombstone it, so a once-grant issued after a denial applies to the agent's NEXT call (a new id), not to the denied id's retry. r7's `denyCallClaim` was wired into the no-grant deny branch inside `prepareEvaluate`. But the PreToolUse hook has a SECOND pre-claim deny branch that r7 did not cover: the BUG-230 shim-missing branch.

## Evidence

- `src/server/runtime/claude-runtime.ts`, the `if (!ensured.ok)` branch (`gitShim.ensure()` failed): the hook returns a DENY before `evaluateGitWriteAsync` runs, so `denyCallClaim` is never called. The only cleanup, `endGitCall` -> `endCallClaims`, does nothing for a call id that has no record, so `callClaimState` stays `unknown`.
- Verifier probe `p3-shim-missing-deny.mjs` (manifest d9efa1ee82d1, exit 1), real store + git-grant functions: after the shim-missing deny leaves the id `unknown`, a once-grant is issued and the same tool_use_id's PreToolUse is re-sent; the retry is ALLOWED and spends the grant (`retryAllowed:true`), and the agent's next genuine call (new id) is REFUSED (`nextCallAllowed:false`). An in-run control confirms the no-grant deny path (r7) DOES tombstone.

## Direction (not built)

Route the shim-missing deny branch through `denyCallClaim({binding,toolUseId,agentKey,projectKey,data})` (git-grant-store.mjs), exactly as r7 routed the no-grant branch, so the id gets a `withdrawn` tombstone and the retry is denied while the grant stays for the next call. Audit for any OTHER pre-claim deny/early-return in the hook or codex-runtime that also skips `denyCallClaim` (the PreToolUse catch block returning `{}` was flagged untested by the verifier).

## Threat-model note

This is an over-grant / accounting edge, NOT a grant bypass: the retry runs only AFTER the user grants, and the write is still leak-gated. It does not let an autonomous agent commit or push without a grant, so under the user's stated threat model (stop autonomous careless commits, not deliberate evasion) it is low priority. It also rests on an UNVERIFIED assumption that the Claude Code CLI re-sends a PreToolUse with an already-denied tool_use_id (the verifier recorded this as untested; the same assumption underlies r7 BREAK 1). Confirm that retry shape before fixing.

## Related

- BUG-231 (the single grant decision / call-id tombstone model) — this is a new arm of the same P3 family.
- BUG-230 (the shim dir can be deleted mid-session) — the precondition for this branch firing.
- FEAT-164 (the grant feature) — shares the single-authority grant store.

**Symptom of a deeper design flaw?** yes -> the per-path tombstone model keeps leaking new pre-claim deny branches (r7 BREAK 1, now this). The structural fix is OS-level session isolation (ARCH-021 option D), already named as the real fix for this whole family; per-path patching is the losing game the FEAT-164 rescope acknowledged.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-20 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-20 — worker (fixing r1)
- **Note:** regressed-from: BUG-231 r7 (its tombstone was wired to one deny site, the no-grant branch). FIX (structural, no new call at the shim-missing site): scripts/lib/git-grant.mjs denyGitWriteToolCall(binding, id, agentKey) is THE deny exit. It tombstones an id with no record (denyCallClaim), withdraws an existing record, then ends it. src/server/runtime/claude-runtime.ts denyGitCall wraps it and is called from exactly the three ways a call is denied: (1) the PreToolUse wrapper settleGitCallOnDeny, which every deny of the hook passes through; (2) canUseTool deny; (3) the PermissionDenied hook, which used to share the plain end-settle with Post. ENUMERATION (rg permissionDecision deny, claude-runtime.ts): 8 returns inside the wrapped hook (BUG-230 shim-missing; git-write stage; branch-mode edit, hooks-path and bash; file lock; profile catch) and 4 in helpers called only from inside it (the evaluateOrchestratorProfileHook x3 and withProfileHelp paths via orchBypass), so all 12 go through settleGitCallOnDeny. Codex has no per-call window binding, so it is not applicable. PROOF: new scripts/verify-bug-267-deny-tombstone.mjs runs end to end on a real scratch server and a fake CLI driving the real hook. A group-writable shim dir makes ensure() refuse, then the user once-grants, then the same tool_use_id is re-sent, then a new call. Result 7/0: the retry is denied, the grant is untouched, the next call commits. MUST-FAIL: --mutant (deny exit only ends) gives 4/3, and the pinned pre-change bytes (claude-runtime.ts sha 3b1eaa54 + git-grant.mjs sha 3b0701d7) give 4/3. R3 retry ALLOWED, R4 grant spent, R5 next call refused: exactly verify 9614f08f's break. The CLI-resend assumption is still not confirmed against the real CLI; the fix is correct either way. Regressions: BUG-231 call-claims 21/0 and one-decision 50/0. Their variant loaders now link the store's sibling libs, because the 2026-10-16 reach-filter import of agent-git-policy.mjs had broken them with ERR_MODULE_NOT_FOUND. BUG-230 nested 23/0, FIFO 14/0 (its lib copy loop now skips the lib/seccomp dir). npm run gate PASS. Not restarted. Session-lifecycle/grant path: an independent verify is warranted.

### 2026-10-20 — dispatch openai
- **Verification recorded:** dispatch openai/default run 01a15811-00af-7251-b420-e7bfcdbd2fe0 — VERDICT: HOLDS. Typed entry in the record's verification[]; this line is an echo, not proof.
