```orchard-ticket
{
  "id": "BUG-210",
  "type": "bug",
  "title": "Verify lanes park at turn-end on a live background verifier",
  "summary": "A dispatched verify lane runs independent-verify.mjs, whose clean-room verifier child runs for many minutes — longer than the 10-minute foreground Bash cap. The lane backgrounds it, its turn ends while the child is alive, and it parks until nudged. Happened four times verifying one ticket; one park lasted about twelve hours.",
  "impact_if_we_wait": "Every high-stakes fix that needs clean-room verification risks stalling for hours between the verifier finishing and anyone reading its verdict, doubling wall-clock on the workflow's most important gate. Bounded: no data is lost and no wrong verdict is produced — the child completes correctly; the cost is stalled time.",
  "current_need": "A structural way for a verify lane to run independent-verify.mjs to completion within one turn, or to hand the long run off so its verdict is harvested without a manual nudge — the charter's foreground-only sentence alone has failed repeatedly.",
  "severity": "medium",
  "area": "clean-room verify orchestration",
  "reported": "2026-09-29",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-09-29",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A verify lane completes an independent-verify.mjs run and records the verdict without its turn ending on a live, un-harvested child.",
    "If the run exceeds one turn's foreground budget, a sanctioned mechanism resumes the lane or orchestrator and harvests the verdict automatically.",
    "Must-FAIL: the pre-change path reproduces a lane whose turn ends over a live verifier child with no automatic resume.",
    "No verifier clean-room, server, or container is orphaned or double-run when the lane's turn ends."
  ],
  "code_refs": [],
  "related": [],
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

# BUG-210 — Verify lanes park at turn-end on a live background verifier

## The invariant that broke

A dispatched lane must not end its turn with a live background child it will not
harvest (worker.md line 10; WA §I / BUG-046). A verify lane's whole job is to run
`node scripts/independent-verify.mjs …`, which builds a clean room and then
dispatches a `claude -p` verifier that runs for many minutes. That command cannot
fit in one foreground Bash call (the tool caps at 600000 ms = 10 min, and a real
verifier run is longer), so lanes background it — and then the turn ends with the
verifier child still alive. The lane parks until a human nudges it. The
foreground-only sentence in the worker charter has been unfollowable and has
failed four times.

## Evidence

- BUG-196 clean-room verification parked at turn-end on a live verifier child in
  rounds 2, 3, 5 and 6. Round 3 sat parked about 12 hours before someone nudged
  it. (Reported by the BUG-196 orchestrator; the parks are not in the ticket's
  own Activity log because each entry is written only after the lane resumed.)
- The SAME turn-end-over-a-live-child class is transcript-confirmed one level
  down, inside the dispatched verifier itself: both round-6 verifier sessions
  received `<task-notification> … <status>stopped</status> <summary>Background
  shell command didn't finish before the previous session ended</summary>`. See
  BUG-211 (they share this root). Transcripts:
  `~/.claude/projects/-home-…-cleanroom-verify-15cyn5/778cc092-….jsonl` and
  `…-cleanroom-verify-nCe8z9/a06ef03c-….jsonl`.

## Why a charter sentence alone keeps failing

The rule ("Foreground Bash only") is correct but conflicts with a hard limit: a
foreground Bash call is capped at 10 min, and `independent-verify.mjs` legitimately
runs longer. Faced with "foreground times out" vs "background parks", the lane has
no compliant option. This is a structural gap, not an attention lapse.

## Candidate designs (for the engineer to weigh — not decided here)

- **A — `independent-verify.mjs` foreground-completes within the tool budget.**
  Give it a mode that returns fast with a resumable handle, or ensure the whole
  run fits the foreground cap. Weakness: a real verifier legitimately exceeds
  10 min, so "just foreground it" cannot always hold.
- **B — hand the long run to the orchestrator as a top-level background job.** The
  sanctioned completion-notice pattern (a backgrounded command that re-invokes the
  agent on exit) works at the orchestrator level; the recurring mistake is nesting
  it inside a WORKER whose turn-end has no such re-invocation. Make the verify step
  a first-class dispatch the orchestrator backgrounds, not something a worker shells
  out to.
- **C — a sanctioned detach-and-harvest for a lane.** Extend FEAT-111
  (`scripts/harvest-agent.mjs`, which harvests a live *subagent*) to cover an
  `independent-verify.mjs` OS child: a bounded "is it done? give me the verdict"
  the lane runs on resume, so a parked turn has a cheap next step other than
  re-running.
- **D — worker agent definition change.** Make the rule concrete for this exact
  case (run it foreground with an adequate `--timeout-min`; if it would exceed the
  cap, return to the orchestrator with a "background this yourself" handoff rather
  than backgrounding it in-lane). A sentence has already failed, so this is weak
  on its own and probably a complement to A–C.

## Proof bar

- Must-FAIL: reproduce a verify lane whose turn ends over a live
  `independent-verify.mjs` child with no automatic resume (the current path).
- After the fix: a verify lane completes the run and records a verdict with no
  human nudge, OR a sanctioned mechanism resumes and harvests it automatically.
- Anti-regression: no verifier clean room, scratch server, or container is
  orphaned or double-run at the lane's turn end (see FEAT-111's 51.6-min
  double-run for the cost of getting this wrong).

## Related

FEAT-111 (harvest a live background child), BUG-046 (background children die at
turn-end), BUG-096/BUG-105/BUG-113 (turn-end sweep mislabels live children),
BUG-211 (the same root, one level down in the dispatched verifier), BUG-196
(where all four parks occurred).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-29 — agent
- **Filed:** through the board tool; the record was validated before it was written.
