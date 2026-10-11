```orchard-ticket
{
  "id": "BUG-237",
  "type": "bug",
  "title": "Session list shows finished for a session with a revived subagent",
  "summary": "The session list paints a green finished dot, and an empty running strip, for a session whose main turn ended while a subagent it re-woke via SendMessage is still running. The live API reported running:false and working:false for a session with a live revived agent, and the agent was missing from the running list.",
  "impact_if_we_wait": "Any session that re-wakes a finished subagent with SendMessage reads as finished while real work runs, so the user cannot see or trust that the subagent is live, and the running strip hides it.",
  "current_need": "An unexpired revived agent makes the session read as working and appear in the running strip; it returns to finished when the revival ends or expires.",
  "severity": "high",
  "area": "server / agent-bridge / liveness",
  "reported": "2026-10-07",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-10-07",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "While a SendMessage-revived subagent runs, GET /api/health reports liveness.working=true for the session even though the main turn ended.",
    "The revived subagent appears in GET /api/sessions/:id/running as a background agent lane in state running.",
    "When the revival's terminal frame lands or its TTL expires, working returns to false and the agent leaves the strip.",
    "Must-FAIL: a synthesized pre-fix state reproduces working=false and an empty strip while the agent is live."
  ],
  "code_refs": [
    {
      "path": "src/server/agent-bridge.ts",
      "symbol": "hasLiveBackgroundAgent",
      "note": "now counts an unexpired revived agent-kind task via #liveRevivedTasks()"
    },
    {
      "path": "src/server/agent-bridge.ts",
      "symbol": "levelOnlyLanes",
      "note": "now surfaces each unexpired revived task with no live strip row, labelled from its settled #agents row"
    },
    {
      "path": "src/server/agent-bridge.ts",
      "symbol": "#revivedTasks",
      "note": "doc comment updated to name the two new readers (list working fact + running strip)"
    },
    {
      "path": "src/server/liveness.ts",
      "symbol": "working",
      "note": "unchanged: working = running || (live && hasLiveBackgroundAgent()); the live gate + TTL keep it bounded"
    }
  ],
  "related": [],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "3df210f1-514c-484c-bb91-cf877b6c3907",
      "verdict": "broken",
      "verdict_on": "2026-10-07",
      "recorded_at": "2026-10-07T01:11:46.313Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "non-agent-kind revival (local_bash) wrongly counted in hasLiveBackgroundAgent() + levelOnlyLanes() hardcodes kind:agent for revived rows, violating FEAT-154 shells-never-count"
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "f406be16-9867-49e8-bd6a-4eebf1b8ccb7",
      "verdict": "holds",
      "verdict_on": "2026-10-07",
      "recorded_at": "2026-10-07T01:46:38.630Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "round-2 independent verify, isolated clean-room range over exactly agent-bridge.ts + the new verify script. 32/32 checks (fixer's 8 + 21-check concurrency/TTL/cross-session adversarial + 3-check local_agent-typed adversarial). No break found."
    }
  ],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": false,
    "Implementation notes": true,
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
    "confirmation": "Authored directly in the record format through scripts/board-tool.mjs.",
    "dropped": []
  }
}
```

# PLACEHOLDER

## Symptom

In the session list, a session shows the green "finished" dot — and an empty running strip — while a subagent it re-woke via SendMessage is still running. Real instance: session a30b45b2 (the orchard project) woke a finished subagent (ac9ecb1, "Independent verify BUG-234 r4") ~5s before its main turn ended. The live API reported running:false, working:false — finished — while the agent was in fact running, and the woken agent was absent from the running list (only its bash wait loop showed up, marked stalled).

## Repro

1. A session dispatches a background subagent, which finishes (establishes an outcome and retires).
2. The session re-wakes that retired agent with SendMessage (the engine emits a fresh task_started for the already-settled id — a revival).
3. The main turn ends (result clears busy) while the revived agent keeps running.
4. The session list paints a green finished dot and the running strip is empty, for a session whose subagent is live.

## Expected

While the revived subagent is live, the session reads as working (the list's working fact), and the subagent appears in the running strip. When the revival emits its own terminal frame (or its TTL expires), the session drops back to finished — never "working forever".

## Diagnosis

A SendMessage-revived retired task is recorded ONLY in `#revivedTasks` (src/server/agent-bridge.ts). BUG-105 deliberately keeps the re-announced id OUT of `#backgroundTasks` and (via the `!#retiredTasks.has()` guard in the task_started handler) out of `#bgBornTasks` — it stays retired. The session-list "working" fact reads `hasLiveBackgroundAgent()`, which scanned only those two maps (liveness.ts: `working = running || (live && hasLiveAgent)`), so a revived agent never counted and the list said finished. The running strip (`levelOnlyLanes()`) iterated only `#backgroundTasks`, so the revived agent was absent there too. BUG-157 had already added `#revivedTasks` as a liveness signal, but wired it only into `workLifetime()` and the container-close quiet check (the CLOSE decision) — not into the two VISUAL readers.

## Implementation notes

src/server/agent-bridge.ts, two reads, both via the already-existing TTL-pruned `#liveRevivedTasks()`: `hasLiveBackgroundAgent()` now returns true when an unexpired revived task exists (a revival is always an agent — SendMessage targets an agent); `levelOnlyLanes()` now also surfaces each unexpired revived task that has no live strip row, labelled from its settled `#agents` row. Both are gated downstream by `live` (liveness.ts), so a dead process never resurrects the session, and the TTL bounds the signal — it cannot hold "working" forever. The `#revivedTasks` doc comment was updated to name the two new readers.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-07 — agent (fixing r1) — BUILT + SELF-VERIFIED (independent verify warranted)
- **Diagnosis confirmed** exactly as the dispatch hypothesis stated: `#revivedTasks` was read by the close decision (BUG-157) but not by `hasLiveBackgroundAgent()` (~2966) nor `levelOnlyLanes()` (~2980), so the list visual said finished and the strip was empty for a live revived subagent.
- **Fix (src/server/agent-bridge.ts):** (1) `hasLiveBackgroundAgent()` counts an unexpired revived agent-kind task; (2) `levelOnlyLanes()` surfaces each unexpired revived task with no live strip row; (3) updated the `#revivedTasks` doc comment. No other files changed. Left UNSTAGED (agent sessions do no git writes).
- **New test:** scripts/verify-bug-237-revived-agent-session-visual.mjs — a real scratch server (station-boot `isolatedServerEnv`/`isolatedStoreEnv`, free port, CLAUDE_STATION_SURVIVE=0 so no broker/systemd scope), a scripted fake `claude` driving the real revive-then-turn-end sequence, read over HTTP: GET /api/health (`liveness.working`) and GET /api/sessions/:id/running (the strip). Asserts working flips true while the revived agent runs, the agent appears in the strip, and both return to finished/empty once the revival's own terminal frame lands (process still alive — so the drop is the revival clearing, not the session dying).
- **Verified:**
  - New suite 6/6 PASS against the fix.
  - MUST-FAIL (synthesized pre-fix sentinel in-suite: the pre-fix verdict computed from the same observation is working=FALSE/strip-empty while the real server disagrees). CORROBORATED by temporarily removing the two fix reads from the REAL server: the three FIX checks went red — observed running:false, working:false, strip [] (the exact reported finished dot) — while the turn-1 sanity and cleared checks stayed green (non-vacuous). File restored byte-identical.
  - Anti-regression: verify-feat-154-working-fact.mjs 9/9 PASS; verify-bug-157-woken-turn-and-revival.mjs woken 4/4 + revival 4/4 PASS (run in isolation; concurrent-boot "server never healthy" is a PRE-EXISTING environmental flake, reproduced identically on HEAD agent-bridge.ts); verify-bug-068 lane checks 4/4 PASS (same pre-existing boot flake on a later phase, confirmed on HEAD).
- **Symptom of a deeper design flaw?** yes → same class as ARCH-010 (every reader re-derives a fact the owner should declare): `#revivedTasks` liveness had to be re-wired into each NEW reader (close decision, then the two visuals). Not filing a new ARCH; noted for the existing ARCH-010 cluster.
- **High-stakes:** session-lifecycle + regression-prone (agent-bridge.ts liveness) — an independent clean-room verify pass is warranted (the in-suite sentinel + manual-revert corroboration is self-verification).

### 2026-10-07 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run 3df210f1-514c-484c-bb91-cf877b6c3907 — VERDICT: BROKEN — non-agent-kind revival (local_bash) wrongly counted in hasLiveBackgroundAgent() + levelOnlyLanes() hardcodes kind:agent for revived rows, violating FEAT-154 shells-never-count. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-07 — agent (fixing r2) — FIXED the FEAT-154 regression the independent verify found
- **Can a non-agent task land in `#revivedTasks` in real use?** YES. The SOLE writer is `this.#revivedTasks.set(agent.agentId, Date.now())` in the `task_started` handler (src/server/agent-bridge.ts ~5206), inside `if (reported) { ... }` where `reported = #establishedOutcomes.get(agent.agentId)`. It fires for ANY established-outcome id that is re-announced, with **no kind check** — so a settled background `local_bash` (kind 'tool') that the engine re-announces lands there exactly like a re-woken agent. `#establishedOutcomes` is written by the two terminal-frame handlers for tasks of either kind, so a shell qualifies. (Whether SendMessage itself revives a shell is unlikely — it targets agents — but the code path does not restrict to agents, and the independent verifier demonstrated a local_bash revival counting.) The kind is NOT stored in `#revivedTasks`; each reader now looks it up from the id's `#agents` row, which is built (line 5110, `#agents.set`) in the SAME `task_started` frame BEFORE the `#revivedTasks.set`, carrying `agent.kind`.
- **Fix (src/server/agent-bridge.ts):** (1) `hasLiveBackgroundAgent()` now counts a live revived id only if `#agents.get(id)?.kind !== 'tool'` (agent-kind only) instead of the unconditional `#liveRevivedTasks().length > 0`; (2) `levelOnlyLanes()` labels each revived strip row with its REAL kind (`row?.kind ?? 'agent'`) instead of hardcoded `'agent'` — so a revived shell still appears in the running strip (FEAT-154: shells show in the strip) but as a tool/`background command`, never an agent; (3) updated the `#revivedTasks` + `hasLiveBackgroundAgent()` + `levelOnlyLanes()` doc comments. No other files changed. UNSTAGED (agents do no git writes).
- **Test (same file, scripts/verify-bug-237-revived-agent-session-visual.mjs):** parametrized the scripted fake `claude` with `REVIVE_KIND` (agent|tool) and added a second isolated scratch server/session (its own DATA2/CONFIG2 — concurrent boot on a shared data dir is the known "server never healthy" flake) driving the IDENTICAL revive-then-turn-end sequence as a SHELL. Two new checks over the real HTTP surfaces: a live revived shell leaves `working=FALSE` (while `live=true`, `running=false`, lane present in the strip — non-vacuous) and the strip row is labelled `row:'tool'`/`background command`.
- **Verified (all real scratch servers, no stubs):**
  - BUG-237 suite 8/8 PASS against the fix (6 agent-case + 2 new shell-case).
  - MUST-FAIL: reverted the two reads to r1's broken form (unconditional count + hardcoded `kind:'agent'`) → the two shell checks went RED (observed `working:true`, `row:'agent'`) while the 6 agent-case checks stayed green (non-vacuous). Source restored byte-identical (cp backup).
  - Anti-regression: verify-feat-154-working-fact.mjs 9/9 PASS.
  - `npm run gate` → PASS, exit 0 (leak-gate + check-nul + typecheck), confirmed unpiped.
- **regressed-from:** BUG-237 (fixing r1) — r1 asserted "a revival is always an agent" and counted all kinds; this r2 adds the kind filter r1's charter ("revived agent-kind only") had asked for.
- **High-stakes:** session-lifecycle + FEAT-154 shells-never-count (regression-prone agent-bridge.ts liveness). An independent clean-room verify pass is warranted — the must-FAIL revert + in-suite shell case is self-verification.

### 2026-10-07 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run f406be16-9867-49e8-bd6a-4eebf1b8ccb7 — VERDICT: HOLDS — round-2 independent verify, isolated clean-room range over exactly agent-bridge.ts + the new verify script. 32/32 checks (fixer's 8 + 21-check concurrency/TTL/cross-session adversarial + 3-check local_agent-typed adversarial). No break found.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-11 — landed in batch commit (orchestrator triage)
- Work landed in the 2026-10-11 whole-tree batch commit. Verified state unchanged; this entry records only the git landing. Full batch manifest is in the commit message.
