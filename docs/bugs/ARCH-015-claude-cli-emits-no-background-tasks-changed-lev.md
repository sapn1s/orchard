```orchard-ticket
{
  "id": "ARCH-015",
  "type": "architecture",
  "title": "Claude CLI emits no background_tasks_changed level; level-derived protections inert",
  "summary": "A real-CLI frame probe (a real background subagent across a turn boundary) captured ZERO background_tasks_changed frames: under Orchard's current options the engine never populates the background-task level. So #backgroundTasks is never filled and every level-derived guard in the BUG-043/074/105 lineage is inert for this CLI version. Only #bgBornTasks and running rows carry a dispatch; a foreground subagent has nothing.",
  "impact_if_we_wait": "Board reasoning still cites level-derived guards and BUG-074's self-heal as load-bearing when they never run on the current CLI, so future fixes get built on silently inert protection. If one SDK option would turn the level on, we keep writing bridge-side workarounds instead of the correct fix.",
  "current_need": "Establish whether an SDK/CLI option Orchard omits would make the engine emit background_tasks_changed. If one exists, passing it is likely the durable fix; if not, document the level as inert so no future fix relies on it.",
  "severity": "medium",
  "area": "background-work protection (agent-bridge.ts, claude-runtime.ts)",
  "reported": "2026-08-27",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-08-27",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "The open question is answered: whether any SDK/CLI option Orchard omits enables background_tasks_changed on the current engine",
    "If such an option exists: it is passed (or a decision recorded not to) and BUG-157's empty-level analysis is re-derived under it",
    "If none exists: the inert level-derived guards are documented as inert, and BUG-074's self-heal claim is retired for this CLI version",
    "The finding is reproducible: the real-CLI frame probe re-runs and background_tasks_changed count is re-measured"
  ],
  "code_refs": [],
  "related": [
    {
      "id": "BUG-157",
      "relation": "see_also"
    },
    {
      "id": "FEAT-109",
      "relation": "see_also"
    },
    {
      "id": "BUG-074",
      "relation": "see_also"
    },
    {
      "id": "BUG-105",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [
    "BUG-043",
    "BUG-074",
    "BUG-105",
    "BUG-157"
  ],
  "verification": [],
  "verification_class": "arch",
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

# The Claude CLI emits no `background_tasks_changed` level under Orchard's options — every level-derived background protection is inert

## Symptom / finding
During BUG-157's round-1 adversarial clean-room verify, an instrumented real-CLI frame probe captured the RAW frame stream a container session's bridge sees (a throwaway project whose container CLI was replaced by a `tee` wrapper around the real binary — no source edit, no bridge instrumentation). One real session, engine `claude-opus-4-8[1m]`, a real `run_in_background` Agent subagent that ran ~45s across a turn boundary and completed. **75 frames captured; `grep -c background_tasks_changed` → 0.** The engine emitted no level frame at all — not an empty one, none. The only `system` subtypes seen were `init`, `status`, `task_started`, `task_progress`, `task_updated`, `task_notification`, `thinking_tokens`.

So under the SDK/CLI options Orchard passes today, `#backgroundTasks` is **never populated in the first place**. It was never "wrongly emptied" by `#retiredTasks`/`#rebuildBackgroundLevel`, and the engine never "legitimately dropped" an id — the level simply does not exist on this engine version.

## Which protections are now inert, and what carries their weight
Every level-derived guard in the BUG-043 / BUG-074 / BUG-105 lineage keys off `#backgroundTasks` (`background_tasks_changed`, REPLACE semantics). With no level frame ever emitted:
- `workLifetime()`'s **first branch** ("the engine reports N background task(s) still running") never fires for a claude/container session — `#backgroundTasks.keys()` is always empty.
- `stallSignalFor()` and `#ownerIsLiveBackgroundAgent()`'s `#backgroundTasks` reads are dead code paths for this engine.
- **BUG-074's "the level self-heals within seconds"** — cited as a load-bearing assumption in reasoning elsewhere on the board — is **false for this CLI version**. It should no longer be relied on when arguing that a transient empty level is safe.

What actually carries a background dispatch now:
- `#bgBornTasks` — set from a `run_in_background` dispatch (BUG-068). It is **never cleared**, because only a level frame clears it, and there are no level frames. So it monotonically accumulates for the life of the session.
- The bridge's own `#agents` **running rows** — the only per-task liveness trace. As of BUG-157 round-3 these are bounded by `UNSETTLED_ROW_STALE_MS` in `#hasUnsettledWork()` so a stuck row cannot pin a container close forever.
- **A FOREGROUND subagent has nothing at all** — no `#bgBornTasks` entry (not a background dispatch) and no level entry — which is exactly the shape of the BUG-157 incident.

## THE OPEN QUESTION (answer this first)
**Does an SDK/CLI option Orchard does NOT currently pass turn the `background_tasks_changed` level on?** The probe establishes only that the engine emits none under *today's* options, from one container, one session, one CLI version. If such an option exists, the correct fix is very likely to **pass it** — restoring the whole level-derived protection lineage as designed — rather than to keep building bridge-side guards around the level's absence (which is what BUG-157's row-based backstop is).

What it would take to answer:
- Diff the SDK/CLI options Orchard passes (see the query construction in `src/server/runtime/claude-runtime.ts`) against the options the installed CLI/SDK version accepts, looking for anything gating background-task or task-level streaming (candidates to check by name: partial-message / task-level / background-task streaming toggles).
- Re-run the round-1 real-CLI frame probe (in scratch: `b157v/probe-real-cli-frames.mjs`, a `tee`-wrapped container CLI) with each candidate option toggled, and re-run `grep -c background_tasks_changed frames.jsonl`.
- If a toggle turns the level on, BUG-157's empty-level analysis and this ticket's "inert" list must be re-derived under that option, and passing it becomes the durable fix (folds into FEAT-109's direction).

## Evidence & caveats
- Probe + capture (scratch): `b157v/probe-real-cli-frames.mjs`, `b157v/frames.jsonl` (75 frames). `grep -c background_tasks_changed` → 0.
- One CLI version (`claude-opus-4-8[1m]`), one container, one session, one real background subagent. Not load/concurrency tested. A different engine version may behave differently — re-run the probe when the CLI updates.

## Related
- **BUG-157** — its round-1 adversarial verify surfaced this; its row-based backstop (`#hasUnsettledWork`) exists precisely because the level is inert.
- **BUG-043 / BUG-074 / BUG-105** — the level-derived lineage this finding declares inert for the current CLI.
- **FEAT-109** — the durable class fix (run `session-host.mjs` inside the container). If a level-enabling option exists, passing it belongs in that same durable direction.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-27 — agent
- **Filed:** through the board tool; the record was validated before it was written.
