```orchard-ticket
{
  "id": "BUG-068",
  "type": "bug",
  "title": "Background shell work was missing from the running display",
  "summary": "Background shell work now appears while running and leaves the display when finished. Previously, two live process trees produced no running rows, although completed work reached the outcomes ledger.",
  "impact_if_we_wait": "People cannot see active background shell work and may mistake it for stalled or absent work. Bounded: this affects display-correctness and operational awareness, not task execution or data loss.",
  "current_need": "Treat the ticket as closed: the pre-fix case failed, the corrected behavior passed, and standing checks stayed clean.",
  "severity": "not_recorded",
  "area": "Background work display",
  "reported": "2026-08-12",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-13",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Background shell work appears in the running display while its process is alive",
    "A running row survives server restart and re-adoption",
    "The row disappears when work ends and the outcome remains accurate",
    "Existing liveness and false-death protections continue to pass"
  ],
  "code_refs": [],
  "related": [
    {
      "id": "BUG-034",
      "relation": "see_also"
    },
    {
      "id": "BUG-037",
      "relation": "see_also"
    },
    {
      "id": "BUG-072",
      "relation": "see_also"
    },
    {
      "id": "BUG-083",
      "relation": "see_also"
    },
    {
      "id": "BUG-096",
      "relation": "recurrence_of"
    },
    {
      "id": "BUG-105",
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
    "archived_path": "docs/bugs/archive/BUG-068-bash-background-lanes-invisible.md",
    "sha256": "605d74c7994f0cfd1a1e832e722a73d30364596fc4288465a4ae0a3e9599f723",
    "bytes": 9243,
    "original_title": "background BASH dispatch lanes are invisible in the running strip (rows:[] while two process trees live)",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the supplied original and extracted evidence; the symptom, live observations, hypotheses, constraints, deployment, and executed checks remain represented.",
    "dropped": []
  }
}
```

# BUG-068 — Background shell work was missing from the running display

## Diagnosis

At report time, two live background Bash process trees owned by the orchestrator session were absent from its running snapshot. Task-tool subagents remained visible, while completed `local_bash` work later reached the outcomes ledger. This isolated the fault to live tracking or snapshot reconstruction for Bash-dispatched work rather than process execution.

## Evidence

The live request returned `turn.running:false` and `running:[]` while process trees 580492/580499 and 601846/601853 were active. The pre-fix record says "pre-fix if hypothesis 1/3". After the change, `verify:running-snapshot` passed 47/47, `verify:liveness-conformance` 96/96, `verify:agent-outcomes` 45/45, `verify:stall-detector` 33/33, and `verify:ui` 7/7. Another matched tally was 5/5 without an adjacent suite name. The ticket is BUG-068.

## Implementation notes

Commit aabf45e contains the deployed fix. The implementation had to reuse the existing liveness authority, preserve the no-false-deaths invariant, and cover background Bash work without adding another liveness rung.

## Verification plan

Reproduce with a real background Bash child and confirm a descriptive running row appears. Restart the server and confirm re-adoption preserves the row. Let the child finish and confirm the row leaves while the ledger remains honest. The ticket also named `verify:bug-068-bash-background-visible`, `verify:bug-068-bash-background`, `verify:bug-044-restart-background`, and typecheck, but recorded no results for them.

## Migration and rollback

The fix was deployed on 2026-08-13, when pid 1162138 was recorded as running the latest code. Rollback instructions were not included.

## Risks

Incorrect reconstruction could show dead work as running or remove live work prematurely. Restart handling could also duplicate rows or separate display state from the established liveness authority.

## Activity log (APPEND-ONLY)
### 2026-08-12 — orchestrator
- Filed from the user's report + live evidence above. Note the meta-irony: BUG-046 built the
  stall detector so silent lanes surface — but a lane the running-set never SEES can neither
  render nor stall. Visibility must cover every lane type the orchestrator actually uses,
  including the new dispatch-CLI pipeline (model-tier rule made it the default for 4.8 work).

### 2026-08-12 — investigator (reproduce → root-cause → fix → verify)
ROOT CAUSE — a REFINEMENT of hypothesis 1 (NOT hyp 2/3). Evidence, not assumption:
- Ground truth of the frames a MAIN-THREAD `run_in_background:true` Bash emits (real `claude`
  v2.1.227, scratch dir): `assistant tool_use Bash(run_in_background=true, id=tu1)` →
  `background_tasks_changed [{task_id, task_type:"local_bash"}]` → `task_started {task_id,
  tool_use_id:tu1, task_type:"local_bash"}` → `user tool_result(tu1)` → `result`. So a
  `task_started` DOES fire and DOES create a `kind:'tool'` running row — hypothesis 1's literal
  claim ("bash never enters running rows") is FALSE, and a fresh-dispatch scratch repro (real
  server + real bridge + real haiku CLI) shows the `local_bash` row present in `/running` and
  PERSISTING after `turn-end`. Hypothesis 3 (snapshot id resolution) also FALSE — the dual
  station/sdk lookup resolved fine.
- The real defect: the turn-end SWEEP evicts the row. `background_tasks_changed` is a LEVEL that
  LAGS the dispatching turn's `result` (BUG-043 measured ~4s). In that window `#backgroundTasks`
  does not yet contain the task, so the sweep (agent-bridge.ts, the `result` branch) sees the
  `local_bash` row `running`, does NOT skip it, settles it terminal (removed from `running`) and
  — when the Bash ack also lagged past `result` — records a fabricated `unknown` death. The
  `#bgDispatchAt` pre-signal guard BUG-043 built for exactly this lag was wired ONLY into
  `workLifetime()` (the close decision), never into the sweep.
- CONFIRMED from the live incident ledger (read-only, agent-outcomes.json): 27 `local_bash`
  records, several the exact fabricated shape `kind:"unknown"` / "the turn ended while this
  agent was still running and the engine reported no outcome for it". That IS the sweep writing
  a death for a still-running background bash and evicting its row → the reported `rows:[]`.
- Why the user saw it on the dispatch-CLI pipeline specifically: those turns are heavier, so the
  level reliably lags `result`; a fast `sleep` dispatch (my first repro) had the level arrive
  BEFORE `result`, so the row survived — which is exactly why the bug read as intermittent.

FIX (src/server/agent-bridge.ts) — reuse the authority, add NO liveness rung (ARCH-001);
running-set stays a pure renderer of bridge evidence:
- The engine's `task_started` for a background lane echoes the SAME `tool_use_id` as the
  `run_in_background` dispatch (probe-verified: tu1 above). So: record dispatch tool_use ids in
  `#bgDispatchToolUseIds`; when a `task_started` carries one, tag its task_id `#bgBornTasks`
  (a background lane KNOWN by construction, before the level lists it).
- The turn-end sweep now skips `#backgroundTasks` ∪ `#bgBornTasks` — a background bash is never
  fabricated-dead / evicted in the pre-level window. BUG-041 invariant kept (no false deaths);
  a genuinely FOREGROUND `local_bash` (no run_in_background) is still settled at turn end
  (BUG-030 preserved — proven by the control check).
- Superseded correctly: any `background_tasks_changed` frame clears both hint sets (REPLACE
  semantics — a live lane is IN the authoritative level, thereafter carried by `#backgroundTasks`).
- Feeds the stall detector: `stallSignalFor()` now also vouches for `#bgBornTasks`, so the
  seconds-long pre-level window is not misjudged a silent death (covers Task AND bash lanes).
- Verification seam (src/server/runtime/claude-runtime.ts): `CLAUDE_STATION_CLAUDE_BIN` points a
  direct session's SDK at a scripted fake `claude` (mirrors the blessed `CLAUDE_STATION_CODEX_BIN`
  seam; prod-inert — the container's own path always wins).

FIX MAP (file:line, post-edit):
- src/server/agent-bridge.ts:486/501  `#bgDispatchToolUseIds` + `#bgBornTasks` fields (doc'd)
- src/server/agent-bridge.ts:2078      record dispatch tool_use id on `run_in_background` tool_use
- src/server/agent-bridge.ts:2407-2408 tag `#bgBornTasks` from the matching `task_started` tool_use_id
- src/server/agent-bridge.ts:2196      sweep skips `#backgroundTasks` ∪ `#bgBornTasks`
- src/server/agent-bridge.ts:2319      clear both hint sets on `background_tasks_changed`
- src/server/agent-bridge.ts:1730      `stallSignalFor()` vouches for `#bgBornTasks`
- src/server/runtime/claude-runtime.ts:194  `CLAUDE_STATION_CLAUDE_BIN` test seam

VERIFICATION (new: scripts/verify-bug-068-bash-background-visible.mjs + npm
`verify:bug-068-bash-background`; real server + real bridge + real ClaudeRuntime/SDK, scripted
fake `claude` emitting the adversarial ordering task_started-BEFORE-result, level-AFTER):
- MUST-FAIL PRE-FIX: revert only the bridge fix (keep the seam) → 1/5 (checks 1-4 FAIL: row
  evicted `rows:[]`, fabricated `unknown` death recorded, no level-recovery, dishonest end).
- POST-FIX: 5/5 — (1) pre-level visibility, (2) no fabricated death, (3) level-arrival keeps the
  row un-stalled, (4) honest end (terminal frame removes the row, ledger honest), (5) FOREGROUND
  control still settled at turn end.
- ANTI-REGRESSIONS: verify:running-snapshot 47/47, verify:liveness-conformance 96/96 (incl. L4
  "no ad-hoc liveness check outside the authority" — no new rung), verify:agent-outcomes 45/45,
  verify:stall-detector 33/33, verify:ui 7/7, typecheck 0. verify:bug-044-restart-background
  (real background bash SURVIVES a restart) run as the restart anti-regression.
- Restart nuance (honest): re-adopt REAPS the surviving broker (BUG-044) — no live bridge
  persists post-restart, so a rendered row cannot outlive the driving bridge for ANY lane type;
  the sweep fix is orthogonal to re-adopt (re-adopt does not sweep) and BUG-044 keeps the work
  alive. "Visible while running" holds for the entire life of the live bridge, which is the
  achievable and correct scope.
- NOTE: needs a later deploy to take effect on the running service (pid 438714). NOT deployed.

### 2026-08-13 — board reconciliation
- Deploy has since happened; pid 1162138 runs the latest code. Status header relabeled FIXED→VERIFIED
  so board:gen moves this row out of Open (it was inflating the FEAT-067 queued count). No code change.
