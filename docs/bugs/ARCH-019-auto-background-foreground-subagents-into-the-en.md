```orchard-ticket
{
  "id": "ARCH-019",
  "type": "architecture",
  "title": "Auto-background foreground subagents into the engine level, or keep the bridge backstop?",
  "summary": "A subagent dispatched WITHOUT run_in_background never enters the engine's background_tasks_changed level — the level is background-only by design. So a long-running foreground subagent (the BUG-157 shape) is carried only by the bridge's row-based backstop. CLI 2.1.284 ships CLAUDE_AUTO_BACKGROUND_TASKS, which auto-backgrounds such a task into the level after a timeout, but changes turn semantics — a user call.",
  "impact_if_we_wait": "Nothing breaks: BUG-157 round-4 already carries the foreground shape via container /proc ground truth plus the row-based backstop, so this is an improvement decision, not an outage. Left unasked, the choice stays implicit (auto-background OFF) without anyone having decided it.",
  "current_need": "A user decision: should Orchard set CLAUDE_AUTO_BACKGROUND_TASKS on launched sessions (accepting that a blocking tool call returns early once a foreground task crosses the timeout), or keep foreground work out of the level and rely on the bridge's row-based backstop?",
  "severity": "low",
  "area": "background-work protection (agent-bridge.ts, claude-runtime.ts)",
  "reported": "2026-09-28",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "decide",
  "updated": "2026-09-28",
  "decision": {
    "mode": "single",
    "question": "Set CLAUDE_AUTO_BACKGROUND_TASKS so foreground subagents auto-background into the level, or keep foreground work on the bridge's row-based backstop?",
    "options": [
      {
        "key": "A",
        "label": "Keep the bridge backstop; do not set it",
        "what_changes": "Nothing changes: foreground subagents keep running inline to completion, exactly as today.",
        "benefit": "Costs nothing and changes no turn semantics; the row-based #hasUnsettledWork() plus container /proc ground truth already carry the BUG-157 shape.",
        "cost": "A foreground long-runner stays invisible to the level, so the level-derived guards never see it and the backstop stays load-bearing.",
        "why_not_obvious": "The bridge backstop is unproven under load, so leaning on it forever may be fragile — but the engine option changes turn semantics for every session."
      },
      {
        "key": "B",
        "label": "Set CLAUDE_AUTO_BACKGROUND_TASKS on launched sessions",
        "what_changes": "A long-running foreground task auto-backgrounds into the level after the default timeout, entering the level-derived protection lineage.",
        "benefit": "The level-derived lineage (BUG-043/074/105) protects foreground work natively and the bridge's row-based backstop becomes belt-and-suspenders.",
        "cost": "Turn semantics change for every launched session: a blocking call past the timeout returns early with a placeholder and the model proceeds without the result.",
        "why_not_obvious": "Auto-background looks like a clean engine-native fix, but the early-return semantics can surprise a session that assumed its subagent finished inline."
      },
      {
        "key": "C",
        "label": "Set the knob and pin the timeout",
        "what_changes": "Same as B, but pin CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS so only genuinely long foreground work backgrounds; short calls still complete inline.",
        "benefit": "Most of B's level coverage with a smaller semantic blast radius, since short foreground calls keep completing inline.",
        "cost": "A tuning parameter we now own and must justify, and the early-return semantics still apply above the threshold.",
        "why_not_obvious": "It softens B's blast radius, but we must own and defend a timeout value, and the early return still applies above it."
      }
    ],
    "recommendation": "A",
    "recommendation_reason": "The foreground shape is already carried by BUG-157 round-4's ground-truth close decision, so B and C change turn semantics for a gap that is not currently open.",
    "prerequisite": null
  },
  "decision_history": [],
  "success_criteria": [
    "A user picks A, B, or C on the Needs-You rail",
    "If B/C: an isolated real-CLI probe with the knob set shows a foreground subagent outliving the timeout enters the level (0 today)",
    "If B/C: Orchard's launched sessions handle the early-return turn semantics without lost results or double-dispatch",
    "If A: the decision is recorded so auto-background-OFF is an explicit choice, not an unexamined default"
  ],
  "code_refs": [],
  "related": [
    {
      "id": "ARCH-015",
      "relation": "see_also"
    },
    {
      "id": "BUG-157",
      "relation": "see_also"
    },
    {
      "id": "FEAT-109",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [
    "BUG-157"
  ],
  "verification": [],
  "verification_class": "arch",
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

# ARCH-019 — Auto-background foreground subagents into the engine level, or keep the bridge backstop?

## What the setting does (evidence)

On CLI `2.1.284` (verified against the installed bun-compiled binary at `~/.local/share/claude/versions/2.1.284` and `@anthropic-ai/claude-agent-sdk@0.3.281`):

- **`CLAUDE_AUTO_BACKGROUND_TASKS`** opts a session into auto-backgrounding: a long-running FOREGROUND task (the spawning tool call blocking on it) is moved to the background after a timeout, at which point it enters the `background_tasks_changed` level like any `run_in_background` task. The binary gates its worker check-in scheduler on `if (!defaultOn() && !env.CLAUDE_AUTO_BACKGROUND_TASKS) return;` — the knob force-enables the path even where the built-in default is off.
- **`CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS`** narrows the auto-background timeout: the binary computes the effective timeout as `min(requestedTimeoutMs, max(override, floor))` and only for the MAIN agent when auto-background is available (`if (!isMainAgent || !canAutoBackground) return requestedTimeoutMs`).
- **`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`** is the opposite lever (backgrounding off entirely); `sdk.d.ts` documents `backgroundTask()` returning false when it is set.
- The turn-semantics change: `sdk.d.ts` (`is_backgrounded`) records that a foreground task registers with `is_backgrounded:false` and "the spawning tool call blocking on it"; a later move to the background arrives as a `task_updated` patch. So once a foreground tool call crosses the timeout, it returns EARLY with a "running in the background" placeholder result and the model continues — the turn no longer blocks to completion. That is the behavioural cost, and it applies to real foreground subagents, not only Bash.

Orchard passes none of these today (`src/server/runtime/claude-runtime.ts`), so foreground subagents run to completion inline and never touch the level.

## Why this is a real fork, not an obvious yes

ARCH-015 established that the level itself is LIVE on the current CLI and the bridge consumes it — so `run_in_background` work is already protected by the level-derived guards. The ONLY residual gap is foreground work, which BUG-157 round-4 already carries two ways (container `/proc` ground truth + the row-based `#hasUnsettledWork()` backstop). So this is a choice between two working designs, and the engine option buys correctness at the price of changed turn semantics for every launched session.

## Decision — set CLAUDE_AUTO_BACKGROUND_TASKS, or keep the bridge's row-based backstop?

- **A — keep the bridge backstop; do not set the knob.** Foreground subagents keep running inline to completion; the row-based `#hasUnsettledWork()` + container `/proc` ground truth carry the BUG-157 shape, exactly as they do now. Costs nothing, changes no turn semantics, keeps one more protection bridge-side rather than in the engine. Price: a foreground long-runner is still invisible to the level, so the level-derived guards never see it and the backstop remains load-bearing (must keep being maintained and verified).
- **B — set `CLAUDE_AUTO_BACKGROUND_TASKS` on Orchard-launched sessions.** A long-running foreground task auto-backgrounds into the level after the default timeout, so the level-derived lineage (BUG-043/074/105) protects it natively and the bridge backstop becomes belt-and-suspenders. Price: turn semantics change for EVERY launched session — a blocking tool call that crosses the timeout returns early with a "running in the background" result and the model proceeds without the real result in hand, which can surprise a session that assumed its subagent finished inline.
- **C — set the knob AND pin `CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS`.** Same as B, but tune the timeout so only genuinely long foreground work backgrounds (short calls still complete inline). Buys most of B's coverage with a smaller semantic blast radius; costs a tuning parameter we now own and must justify, and the early-return semantics still apply above the threshold.

**Recommendation: A** for now. The foreground shape is already carried by BUG-157 round-4's ground-truth close decision, so B/C change turn semantics for a gap that is not currently open. Revisit if the row-based backstop proves fragile under load, or if we want to retire it in favour of an engine-native signal (which would fold into FEAT-109's "run the host inside the container" direction).

## Proof bar — what would have to be true to adopt B or C

1. An isolated real-CLI probe (the ARCH-015 recipe: isolated `CLAUDE_CONFIG_DIR`, `query()` with `includePartialMessages:true`) with `CLAUDE_AUTO_BACKGROUND_TASKS=1` set, dispatching a FOREGROUND subagent that outlives the timeout, and counting `background_tasks_changed` frames — must show the foreground task entering the level (count > 0) where it does not today.
2. A demonstration that the early-return turn semantics are acceptable in Orchard's launched sessions: a foreground tool call that crosses the timeout returns a placeholder and the session behaves correctly afterwards (no lost result, no double-dispatch).
3. Falsifier: if (1) shows the level still never lists the auto-backgrounded task under Orchard's container/socket transport, or (2) shows Orchard sessions mis-handle the early return, then B/C are the wrong call and A stands.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-28 — agent
- **Filed:** through the board tool; the record was validated before it was written.
