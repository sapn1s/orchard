```orchard-ticket
{
  "id": "BUG-077",
  "type": "bug",
  "title": "Idle stops mislabel the next turn as interrupted",
  "summary": "Turn-start clearing now prevents an idle or delayed Stop from marking the next turn as interrupted. Previously, this created false killed-agent records and halted autonomous work. The pre-fix scenario failed, while corrected idle and genuine-interrupt cases passed.",
  "impact_if_we_wait": "Autonomous work can stop unexpectedly, and completed turns can receive dishonest interruption and death records. Bounded: this affects execution-state reporting and continuation, not user content, completed work, or persistent data loss.",
  "current_need": "Treat the ticket as closed: the pre-fix case failed, corrected idle and genuine-interrupt cases passed, and standing checks stayed clean.",
  "severity": "not_recorded",
  "area": "Turn and interrupt reporting",
  "reported": "2026-08-12",
  "reported_by": "area-review workflow",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-13",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-12",
      "question": "Should turn start clear stale interruption state, or should idle interrupts be ignored?",
      "mode": "single",
      "options_keys": [
        "A",
        "B"
      ],
      "chosen": "A",
      "chosen_on": "2026-08-13",
      "chosen_by": "agent",
      "note": "Clear-on-start was preferred because it also covers the result-then-interrupt race."
    }
  ],
  "success_criteria": [
    "An idle or delayed interrupt does not mark the next completed turn as interrupted",
    "The next turn creates no false killed-agent records",
    "Autonomous work continues after an idle or delayed interrupt",
    "A genuine mid-turn interrupt remains labeled as interrupted"
  ],
  "code_refs": [
    {
      "path": "src/server/agent-bridge.ts",
      "symbol": "interrupt",
      "note": "Previously set the interruption flag without checking whether a turn was active."
    },
    {
      "path": "src/server/agent-bridge.ts",
      "symbol": "send",
      "note": "Now clears stale interruption state when a turn starts."
    },
    {
      "path": "src/server/index.ts",
      "symbol": null,
      "note": "The socket command handler forwards Stop commands without a liveness check."
    }
  ],
  "related": [
    {
      "id": "BUG-041",
      "relation": "see_also"
    }
  ],
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
    "archived_path": "docs/bugs/archive/BUG-077-interrupt-idle-latch.md",
    "sha256": "1a0ec2cf6809c7555d1b7f11044859230fa09b0eefe6c3c49d03cdcdc50a194b",
    "bytes": 6749,
    "original_title": "interrupt() while idle latches #interruptRequested, mislabeling the NEXT turn as interrupted",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the supplied BUG-077 text; the race, observed effects, chosen fix, deployment, proof, regression coverage, and BUG-041 relationship are preserved.",
    "dropped": [
      "source line numbers that may drift after later edits"
    ]
  }
}
```

# BUG-077 — Idle stops mislabel the next turn as interrupted

## Diagnosis

`#interruptRequested` was set by `interrupt()` even when no turn was running and was cleared only when a result frame arrived. A stray Stop, duplicate Stop, or result-then-interrupt race could therefore leave the flag set. The next turn consumed that stale value, emitted `interrupted:true`, recorded open agents as killed, and halted autonomous continuation.

## Evidence

For BUG-077, `verify:bug-077-interrupt-latch` failed before the fix at 8/11 and passed afterward at 11/11. Anti-regression runs passed: `verify:agent-outcomes` 45/45, `verify:liveness-conformance` 96/96, `verify:restart-interrupt-label` 11/11, and `verify:feat-022` 1/1. Shared-fixture tallies were 54/54 and 17/17. Typecheck was clean.

## Implementation notes

Clear `#interruptRequested` at turn start through `send()` and the constructor turn-open path. This makes the flag describe only interruptions raised during the current turn and covers the result-then-interrupt race without weakening genuine mid-turn interruption handling.

## Verification plan

Exercise an idle interrupt and the result-then-interrupt race, then complete the next turn. Assert `interrupted:false`, no killed records, and continued autonomous work. Separately interrupt a running turn and assert `interrupted:true` with honest killed records. Re-run the listed anti-regression suites and typecheck.

## Migration and rollback

The server change was deployed on 2026-08-13. Rolling it back would restore stale interruption latching, false death records, and spurious autonomous stops.

## Risks

Clearing too late could preserve the stale flag. Clearing during a running turn could erase a genuine interruption. Turn-start placement avoids both cases while preserving restart-versus-interrupt labeling.

## Activity log (APPEND-ONLY)
### 2026-08-12 — orchestrator
- Filed from the area-review workflow. Server-side, needs a deploy (deferred). Fix in agent-bridge
  only (clear-on-turn-start) to stay disjoint from BUG-076's index.ts lane.

### 2026-08-12 — builder (fix + verify)
- FIX (agent-bridge.ts, lane-clean — index.ts untouched): added `this.#interruptRequested = false`
  at BOTH turn-open sites — `send()` (the follow-up/autonomous-nudge path, alongside the existing
  per-turn `lastProviderError`/`#advisoryNotice` resets) and the constructor's first-turn open
  (same invariant). The `result`-time clear at :2150 stays. Net: a turn's interrupt flag reflects
  ONLY interrupts raised during THAT turn; an idle/stray Stop or the result-then-interrupt race
  can no longer bleed into the next turn. Genuine mid-turn interrupts are unchanged (the flag is
  set during the live turn and read at its own result).
- VERIFY (§C, scratch bridge — real server + real AgentSession + schema-validated fake `codex
  app-server`, free ephemeral ports + scratch dataDirs, no API cost): new
  `scripts/verify-bug-077-interrupt-latch.mjs` (+ `verify:bug-077-interrupt-latch` in package.json).
  - PART A (idle Stop, interactive): first turn completes honestly → Stop sent while IDLE → next
    turn (agents held running, then a NATURAL completion) ends `interrupted:false`; no `killed`
    outcome records; non-vacuity: that turn genuinely spawned agents (sweep path live).
  - PART C (autonomous): idle Stop, autonomous armed (maxTurns 3), next turn → auto-continue FIRES
    (turnsDone advances to 3, halts `turns-reached`), NEVER halts with reason `interrupted`.
  - PART B (anti-regression, genuine mid-turn Stop): HOLD_AGENTS turn interrupted mid-flight still
    yields turn-end `interrupted:true` + `killed` records (thr_hold_agent_1/2).
  - Counts: 11/11 post-fix. MUST-FAIL PROOF — reverting the two clear lines → 8/11 pre-fix: the 3
    bridge-flag differentiators FAIL (A1 `interrupted:true`; C1 `turnsDone:0`/`stopReason:'interrupted'`);
    PART B still passes pre-fix (genuine interrupts always worked). Restored the fix; 11/11 again.
  - NOTE: the killed-record mislabel (ticket effect (a)) is the CLAUDE bridge-sweep path — the codex
    runtime settles its own agents by turn subtype (`success`→completed) in `#finishTurn`, so on a
    natural completion no death is written regardless of the bridge flag. Effects (b) turn-end
    `interrupted` and (c) autonomous halt ARE bridge-flag-owned and are the reproduced must-FAIL
    differentiators here; (a) is covered by construction (it reads the same `interrupted` variable
    A1 pins). PART B proves the genuine-interrupt killed path is intact.
- Fixture: additive `HOLD_AGENTS:<n>;COMPLETE` marker in codex-fake-app-server.mjs (spawn n running
  agents, then a natural `turn/completed status:'completed'`) — no existing marker path changes;
  shared-fixture consumers re-run clean (codex-runtime 54/54, provider-picker 17/17, agent-outcomes 45/45).
- Anti-regressions: typecheck clean; verify:agent-outcomes 45/45; verify:liveness-conformance 96/96;
  verify:restart-interrupt-label 11/11 (BUG-028 label intact); verify:feat-022 autonomous 1/1.
- SERVER change → needs a deploy; NOT deployed/restarted here (deferred to the deploy step).

### 2026-08-13 — board reconciliation
- Deploy has since happened (commit 5d91269 live; pid 1162138 runs the latest code). Status header
  relabeled FIXED→VERIFIED so board:gen moves this row out of Open (queued-count reconciliation).
