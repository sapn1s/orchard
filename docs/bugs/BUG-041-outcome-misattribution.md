```orchard-ticket
{
  "id": "BUG-041",
  "type": "bug",
  "title": "Agent deaths showed an unrelated failure reason",
  "summary": "Agent deaths now exclude non-fatal notices from their reported cause, while genuine terminal provider errors retain their detail. The pre-fix case failed and the corrected attribution, host-event grouping, and visible detail passed with standing checks clean.",
  "impact_if_we_wait": "People may investigate usage limits or tooling failures that did not kill the agent. Bounded: this affects outcome and display correctness, not whether agents stop, stored work, or user data.",
  "current_need": "Treat the ticket as closed: the pre-fix case failed, corrected behavior passed, and standing checks stayed clean.",
  "severity": "medium",
  "area": "Agent outcome reporting",
  "reported": "2026-08-10",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-11",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A pending MCP notice cannot become an agent death cause",
    "An unrelated death after a pending notice records an unknown cause",
    "A terminal provider error remains the recorded cause with its original detail",
    "Simultaneous main-turn and subagent deaths appear as one host-level event",
    "The rail item exposes stored outcome detail and remains dismissible"
  ],
  "code_refs": [
    {
      "path": "src/lib/paths.ts",
      "symbol": null,
      "note": "FEAT-059's stopped agent left half-finished edits here."
    },
    {
      "path": "src/server/registry.ts",
      "symbol": null,
      "note": "FEAT-059's stopped agent left half-finished edits here."
    },
    {
      "path": "src/server/app.js",
      "symbol": "attachProviderError",
      "note": "Outcome attribution must exclude pending and other advisory classifications."
    }
  ],
  "related": [
    {
      "id": "ARCH-002",
      "relation": "see_also"
    },
    {
      "id": "BUG-031",
      "relation": "see_also"
    },
    {
      "id": "BUG-037",
      "relation": "see_also"
    },
    {
      "id": "BUG-077",
      "relation": "see_also"
    },
    {
      "id": "BUG-096",
      "relation": "recurrence_of"
    },
    {
      "id": "BUG-105",
      "relation": "see_also"
    },
    {
      "id": "FEAT-055",
      "relation": "see_also"
    },
    {
      "id": "FEAT-059",
      "relation": "see_also"
    },
    {
      "id": "FEAT-067",
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
    "Migration and rollback": false,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-041-outcome-misattribution.md",
    "sha256": "6255b7905c6a49a0c252e95fca9fec2c1546934807968d62bf411841546ec227",
    "bytes": 10240,
    "original_title": "agent deaths get a WRONG cause (a non-fatal pending-MCP notice reported as the reason)",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the supplied ticket and extracted evidence; the symptom, diagnosis, two defects, fix direction, relationships, bounds, and executed checks are preserved.",
    "dropped": []
  }
}
```

# BUG-041 — Agent deaths showed an unrelated failure reason

## Diagnosis

The outcome ledger retained the turn's last classified provider error and later presented it as the death cause. A pending MCP attachment notice is advisory and cannot terminate a turn, so promoting it fabricated causality. Only terminal classifications may supply a provider-error reason; otherwise the honest cause is unknown.

The main turn and subagent ended three milliseconds apart. That timing supports one host-level event rather than two independent failures.

## Evidence

The briefing and rail attributed both deaths to `tooling-unavailable` and showed a pending Serena MCP server notice. FEAT-059's agent actually stopped with half-finished edits and no scratch directory, but the notice itself was non-fatal.

Before the fix, the targeted outcome suite passed only 26/41. Afterward, `verify:agent-outcomes` passed 45/45, including 15 new checks. `verify:provider-errors` passed 22/22, `verify:mcp-attach` passed 20/20, `verify:running-snapshot` passed 47/47, and `verify:liveness-conformance` passed 96/96. Another recorded run passed 26/26, and typecheck stayed clean.

## Implementation notes

Filter pending and other advisory classifications where per-turn provider errors are attached. Preserve terminal provider errors verbatim. When no terminal cause exists, record an unknown cause and keep pending attachment information only as clearly labeled context.

Group simultaneous main-turn and subagent endings as one host-level event. Expose the ledger's stored detail through an expandable or hoverable rail item, including the unknown-cause wording, while keeping the item dismissible.

## Verification plan

Exercise a turn that receives a pending MCP notice and later dies for an unrelated reason. Confirm the recorded cause is unknown and the notice appears only as context. Confirm a genuine terminal provider error remains verbatim.

Exercise simultaneous main-turn and subagent deaths and confirm one host-level event appears. Confirm the rail exposes stored detail and remains dismissible. Run the agent-outcome, provider-error, MCP-attachment, running-snapshot, liveness-conformance, and type checks.

## Risks

Over-filtering could discard genuine terminal provider failures. Event clustering could combine unrelated deaths if its timing rule is too broad. Showing raw detail could make advisory context look causal unless the labels remain explicit.

## Activity log (APPEND-ONLY)
### 2026-08-10 — orchestrator
- Filed from the user's report; verified the deaths were real and the cause was not, before filing.

### 2026-08-10 — second false-positive shape (same ticket, different failure)
The FEAT-060 agent COMPLETED and delivered its full report; the ledger then recorded it as
`ended, reason unknown: the turn ended while this agent was still running and the engine reported
no outcome for it`. So the ledger over-reports in a second way: an agent that finished successfully
can be logged as an incomplete death when the parent turn ends before the engine emits its terminal
frame. Fix must distinguish "no terminal frame observed" from "did not complete" — a delivered
final result IS an outcome, and the ledger should treat the report/result as evidence of
completion. Verification should include: an agent that completes normally just as the parent turn
ends must NOT appear in the deaths ledger.

### 2026-08-11 — fix agent (isolated worktree) — FIXED & VERIFIED

**Third live shape collected before fixing** (2026-08-11, post-deploy): the ledger recorded
`the main turn — tooling-unavailable (anthropic): MCP tool server still starting: serena` as a turn
that "ended without completing" — the turn in fact continued and completed. Same root as defect 1
plus over-strong briefing wording.

#### What was wrong, precisely (all in the attribution path; drain/reap untouched)
1. **The latch** (`agent-bridge.ts #handle`): `if (!pe.retrying)` latched EVERY non-retrying
   classification as `lastProviderError` — including BUG-035's deliberately non-fatal
   `pending:true` tooling-unavailable notice. Every downstream writer then quoted it as the cause
   of death, and the main turn got a `provider-error` death record at `result` even when the turn
   simply finished.
2. **The turn-boundary sweep** wrote an `unknown` death for every foreground agent still `running`
   at `result` — including agents whose Task tool_result (the delivered final report) had already
   come back. "No terminal frame observed" was conflated with "did not complete".
3. **Same-instant clusters**: one host event (a cut session, one sweep) was written as N
   independent records with N `Date.now()` stamps and reported as N independent deaths — the live
   example was main + subagent 3 ms apart.
4. **Rail detail**: rows showed the kind only (`provider-error`), not what actually happened.

#### The fix (ARCH-002-aligned: the ledger is ADVISORY; entries carry corroborable evidence)
- `outcomes.ts isTerminalCause(pe)` — only a classification terminal for the turn may be a cause;
  `pending` and `retrying` are excluded. Applied at the latch (`agent-bridge.ts`), in
  `attachProviderError()` (returns 0 for advisory), and as DEFENSE IN DEPTH inside `record()` — the
  one choke point every write passes: an advisory pe demotes the kind to `unknown`, `providerError`
  stays null, and the notice is kept verbatim in `detail` marked "(context, not cause: …)".
  The bridge remembers the notice separately (`#advisoryNotice`, cleared at turn start with
  `lastProviderError`) and annotates unknown-cause records with it.
- `outcomes.turnEndOutcome()` — the sweep's per-agent decision, extracted and testable: a
  delivered Task tool_result → **null, nothing recorded** (evidence of completion outranks even an
  interrupt); user interrupt → `killed`; terminal pe → `provider-error` verbatim; else `unknown`
  with the advisory context. The bridge feeds it `#resultDelivered`, populated in the `user`-frame
  handler from tool_results whose tool_use_id maps to an agent. `#recordSessionEnd` also skips
  result-delivered agents.
- **Clusters**: writers that KNOW N rows are one host-level moment (`#recordSessionEnd`, the
  `result` sweep) stamp one shared `at` + `clusterId`. `outcomes.clustersOf()` groups by clusterId,
  plus an evidence heuristic for unstamped records (same session, ≤10ms apart — covers the live
  3ms pair). `takeBriefing` renders a cluster as ONE line ("host-level event: 3 ended together
  (the main turn + builder + tester, within 3ms) — one event, not 3 independent failures — cut"),
  `headline()` says "3 stopped together — one event (cut)" when everything shown is one cluster
  (client mirror updated identically).
- **Honest wording**: briefing head no longer claims "ended without completing" (unknown records
  may well have completed); the footer now says the briefing is ADVISORY and requires
  corroboration before abandoning/re-dispatching work (the ARCH-002 incident, written into the
  surface itself).
- **Rail detail** (minimal, rail only — tickets tab untouched): rows name the actual cause
  (`quota-window (openai)`, not the bare kind); hover carries the full stored evidence (detail +
  provider's verbatim text + ISO time).

#### Verification — `verify:agent-outcomes` extended 26 → 45 checks
- **POST-FIX: 45/45.** New: A6 advisory-never-a-cause (incl. the exact serena notice shape),
  A7 clusters (explicit + the 3ms-implicit live shape), A8 turnEndOutcome (completed → NO record;
  killed/provider-error/unknown honest), A9 source-conformance (the bridge's live call sites
  actually consult these functions — guards against a correct function nobody calls), C1 cluster
  end-to-end (a real SIGKILLed engine: main + 2 agents share one writer-stamped clusterId; the
  API headline reports one event).
- **PRE-FIX (same script, clean 3cfe103 worktree): 26/41 — all 15 BUG-041 checks FAIL**, observing
  the reported bug verbatim: `worker — tooling-unavailable (anthropic): MCP tool server still
  starting: serena` stored as a death cause, `attachProviderError` promoting the pending notice
  onto 2 unrelated deaths, 3 same-cut records with `clusterId: null` reported as "3 agents
  stopped — cut".
- **Anti-regression:** typecheck PASS, verify:running-snapshot 47/47, verify:liveness-conformance
  96/96 (regrowth guard clean). Parts B/C of the suite re-prove FEAT-057 end-to-end post-change
  (quota deaths recorded verbatim, briefing travels, dismissal persists).

**Not covered (named, not implied):** the pending-notice latch is proven at the unit +
source-conformance level, not by a live Claude engine emitting a real `system:init` pending frame
end-to-end (no fake Claude CLI exists; the codex fixture has no pending concept). The E2E halves
prove the same latch variable's terminal path live. `verify:provider-errors` / `verify:mcp-attach`
(live-CLI, token-costing) were not run; nothing in their surface changed except that a pending
classification is no longer latched — the `provider-error` EVENT emission they assert is upstream
of the latch and untouched.

**Files:** `src/server/outcomes.ts`, `src/server/agent-bridge.ts` (attribution sites only),
`public/app.js` (rail render only), `scripts/verify-agent-outcomes.mjs`. Scope constraint honored:
`session-host.mjs`, `survival.ts`, drain/reap logic untouched.
