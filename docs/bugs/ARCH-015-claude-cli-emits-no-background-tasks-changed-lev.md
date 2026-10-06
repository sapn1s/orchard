```orchard-ticket
{
  "id": "ARCH-015",
  "type": "architecture",
  "title": "Claude CLI emits no background_tasks_changed level; level-derived protections inert",
  "summary": "A real-CLI frame probe (a real background subagent across a turn boundary) captured ZERO background_tasks_changed frames: under Orchard's current options the engine never populates the background-task level. So #backgroundTasks is never filled and every level-derived guard in the BUG-043/074/105 lineage is inert for this CLI version. Only #bgBornTasks and running rows carry a dispatch; a foreground subagent has nothing.",
  "impact_if_we_wait": "Board reasoning still cites level-derived guards and BUG-074's self-heal as load-bearing when they never run on the current CLI, so future fixes get built on silently inert protection. If one SDK option would turn the level on, we keep writing bridge-side workarounds instead of the correct fix.",
  "current_need": "ANSWERED (2026-09-29): background_tasks_changed is native on CLI 2.1.284 under Orchard's current options and agent-bridge.ts consumes it, so the level-derived guards and BUG-074 self-heal are LIVE. The inert/0-frames finding was a pre-feature-CLI artifact; no product change needed. Foreground-auto-background fork: ARCH-019.",
  "severity": "medium",
  "area": "background-work protection (agent-bridge.ts, claude-runtime.ts)",
  "reported": "2026-08-27",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-09-28",
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

> **CORRECTION (2026-09-29, version-scoped) — the level EXISTS and is consumed on the current CLI. The "0 frames / inert" finding below is a PRE-FEATURE-CLI artifact.**
> The original probe ran 2026-08-27 on a CLI that predated the feature. On CLI `2.1.284`
> (SDK `@anthropic-ai/claude-agent-sdk@0.3.281`) `background_tasks_changed` is emitted
> NATIVELY under the exact options Orchard already passes — empirically **2 frames** for a
> `run_in_background` Bash task and **2** for a `run_in_background` subagent (start + empty
> completion, REPLACE semantics). `agent-bridge.ts` `#handleSystem` consumes it
> (`case 'background_tasks_changed'` at ~:4685 → `#levelRaw` → `#rebuildBackgroundLevel()`;
> reached from the `case 'system'` dispatch at :4175, re-confirmed by reading the code path).
> `sdk.d.ts` (`SDKBackgroundTasksChangedMessage`) states outright: **"CLIs that predate this
> send nothing there."** So every "inert" / "self-heal is false" claim below holds ONLY for
> pre-feature CLIs; on the current CLI the level-derived guards (BUG-043/074/105 lineage) and
> BUG-074's self-heal are **LIVE**. No product change is needed to "turn the level on" — it is on.
> The one genuine remaining gap — a **foreground** subagent never entering the level, by design
> — is split to its own decision ticket, **ARCH-019** (`CLAUDE_AUTO_BACKGROUND_TASKS`?). Full
> evidence and the reproducible re-probe recipe are in the Activity log below.

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

### 2026-09-29 — agent (finding, round 1, class=explore)
**Verdict: the level EXISTS and is emitted natively — NOT gated behind any option. The ticket's "0 frames / inert" premise was a STALE-CLI artifact.** The original probe ran 2026-08-27 on a CLI that predated the feature; the current CLI emits it under the exact options Orchard already passes.

**Static evidence.** Installed CLI `2.1.284` (`~/.local/share/claude/versions/2.1.284`, a bun-compiled binary); SDK `@anthropic-ai/claude-agent-sdk@0.3.281`. `rg -a -c background_tasks_changed` on the binary → **12** emit/handle sites (the Aug-27 probe measured 0). `sdk.d.ts` `SDKBackgroundTasksChangedMessage` (line 3557) documents the level as emitted "whenever membership changes (start, completion, kill, a foreground agent being backgrounded)" and — decisively for the old probe — "**CLIs that predate this send nothing there**." So the frame is a relatively new engine feature; the Aug-27 CLI simply didn't have it. New env knobs found in the binary: `CLAUDE_AUTO_BACKGROUND_TASKS`, `CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS`, `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`, `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`.

**Empirical proof (isolated scratch `CLAUDE_CONFIG_DIR` with copied `.credentials.json` + own `projects/`, cheapest model `claude-haiku-4-5`, options mirroring `claude-runtime.ts`: `includePartialMessages:true`, `permissionMode:'bypassPermissions'`, no auto-bg env).** Raw SDK `query()` stream, counted `background_tasks_changed`:
- **Bash `run_in_background`:** count **2** — start `[{task_id, task_type:"local_bash", description:"sleep 12"}]`, completion `[]` (REPLACE semantics).
- **Subagent `run_in_background` (the shape Orchard dispatches, and the shape the Aug-27 probe used):** count **2** — dispatch `[{task_id, task_type:"local_agent", description}]`, completion `[]`.
Both fired with NO extra option and auto-bg OFF. Scratch config dir + probe removed after the run (synthetic-but-real-auth harness; no real store touched).

**So the guards are LIVE, not inert, on the current CLI.** `agent-bridge.ts:4685` already handles `background_tasks_changed`, mapping `local_agent`→'agent' / `local_bash`→'tool' exactly as the frames arrive, into `#levelRaw`→`#rebuildBackgroundLevel()`→`#backgroundTasks`. Since the SDK passed the frames through to my consumer, the bridge receives them. `workLifetime()`'s first branch, `stallSignalFor()`, `#ownerIsLiveBackgroundAgent()` and **BUG-074's self-heal** are therefore receiving real level frames again — the "inert" and "self-heal is false" claims in this ticket's body hold ONLY for the pre-feature CLI and should be read as version-scoped, not current.

**Remaining genuine gap (unchanged by the above):** a *foreground* subagent/task (dispatched WITHOUT `run_in_background`) is not a background task and never appears in the level — by design. That is the BUG-157 incident shape, and BUG-157's row-based `#hasUnsettledWork()` backstop still carries it. The only engine lever that would fold foreground work into the level is `CLAUDE_AUTO_BACKGROUND_TASKS` (auto-backgrounds a long-running foreground task after ~120s, `CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS` overrides), which changes turn semantics (blocking tool calls return early with a "running in background" result) — not tested here.

**Classification for the orchestrator.**
- (a) **Single known-correct correction** for THIS ticket's question: no product-code change is required to "turn the level on" — it is on. The correct action is a docs/ticket correction: record that `background_tasks_changed` is emitted natively on CLI ≥ (the version that added it; confirmed present at 2.1.284, absent 2026-08-27), that the bridge already consumes it, that the level-derived guards + BUG-074 self-heal are LIVE on the current CLI, and pin the re-probe result to a CLI version so the "inert" finding cannot be re-cited as current. Retire BUG-157's empty-level "inert" framing as version-scoped.
- (b) **One genuine project-direction fork, worth its own ticket, NOT bundled here:** should Orchard set `CLAUDE_AUTO_BACKGROUND_TASKS` so long-running *foreground* subagents auto-background into the level (closing the BUG-157 foreground shape via the engine instead of the bridge backstop), accepting the changed turn semantics — or keep the bridge row-based backstop and leave foreground work out of the level?

**Re-probe recipe (reproducible):** isolated `CLAUDE_CONFIG_DIR` (copy `.credentials.json`, own `projects/`), `query()` with `includePartialMessages:true`, prompt a `run_in_background` Bash or Task, count `msg.type==='system' && msg.subtype==='background_tasks_changed'`. Re-run when the CLI updates.

### 2026-09-28 — agent
- **fixing, round 1, class=fix — record correction:** **Verdict: ANSWERED — closing DONE (docs/record correction, no product change).** The ticket asked whether an SDK/CLI option Orchard omits would turn the level on. It needs none: on CLI 2.1.284 background_tasks_changed is emitted NATIVELY under the options Orchard already passes (round-1 explore proved it empirically — 2 frames for a run_in_background Bash task, 2 for a run_in_background subagent). Re-confirmed the consumer myself: agent-bridge.ts `case 'system'` (:4175) dispatches to `#handleSystem`, whose `case 'background_tasks_changed'` (:4684) sets `#levelRaw` and calls `#rebuildBackgroundLevel()` — the level-derived guards (workLifetime first branch, stallSignalFor, `#ownerIsLiveBackgroundAgent`) and BUG-074 self-heal are LIVE on the current CLI. The body's "inert / 0 frames / self-heal is false" statements are a pre-feature-CLI artifact (probed 2026-08-27) and are now version-scoped by a CORRECTION banner at the top of the body; original prose left intact (append-only). sdk.d.ts confirms: "CLIs that predate this send nothing there." **Corrected files:** docs/bugs/ARCH-015-*.md (banner + this entry + record work_state/current_need), docs/bugs/BUG-157-*.md (cross-ref correction entry). **Split off:** the one genuine fork — whether to set CLAUDE_AUTO_BACKGROUND_TASKS so long-running FOREGROUND subagents auto-background into the level (changes turn semantics) vs. keeping the bridge row-based backstop — is filed as ARCH-019 (decision, needs the user). No product code edited; no independent verify required for a record correction (docs-only), though a cheap independent re-probe on the current CLI would corroborate the empirical count if wanted.
