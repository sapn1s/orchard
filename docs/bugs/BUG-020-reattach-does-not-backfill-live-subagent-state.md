```orchard-ticket
{
  "id": "BUG-020",
  "type": "bug",
  "title": "Reloaded dashboards lost completed sub-agent activity",
  "summary": "Reloaded dashboards now recover sub-agents that started or finished before reattachment. The backfill, approval reattachment, live summary, and interface suites passed, while type checking remained clean.",
  "impact_if_we_wait": "Without the fix, reloads silently hide running or completed sub-agents and make activity displays incomplete. Bounded: this affects display correctness, not execution or data; turns continue, transcripts remain intact, and sub-agent records stay on disk.",
  "current_need": "Treat the ticket as closed: reattachment and reload tests showed the corrected activity display, and standing type checks stayed clean.",
  "severity": "medium",
  "area": "Live sub-agent display",
  "reported": "2026-08-04",
  "reported_by": "diagnosis agent",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-04",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A freshly reattached client immediately receives every known running sub-agent",
    "Sub-agents completed before reload remain visible after reattachment",
    "Reloading does not interrupt the main turn or its sub-agents",
    "Approval reattachment and live summary behavior remain intact"
  ],
  "code_refs": [
    {
      "path": "src/server/agent-bridge.ts",
      "symbol": "liveAgents",
      "note": "Returns the in-memory sub-agent states that survive detach and attach."
    },
    {
      "path": "src/server/agent-bridge.ts",
      "symbol": "replayPending",
      "note": "Existing approval replay established the reattachment-backfill pattern."
    },
    {
      "path": "src/server/index.ts",
      "symbol": "running.attach",
      "note": "The reattachment branch previously sent session state and approvals without sub-agent state."
    },
    {
      "path": "public/app.js",
      "symbol": "resetTranscript",
      "note": "Clears the client sub-agent map whenever a session opens."
    },
    {
      "path": "public/app.js",
      "symbol": "state.agents",
      "note": "The live activity strip depends on server events repopulating this map."
    }
  ],
  "related": [
    {
      "id": "BUG-004",
      "relation": "see_also"
    },
    {
      "id": "BUG-008",
      "relation": "see_also"
    },
    {
      "id": "BUG-017",
      "relation": "see_also"
    },
    {
      "id": "BUG-018",
      "relation": "depends_on"
    },
    {
      "id": "BUG-022",
      "relation": "see_also"
    },
    {
      "id": "BUG-030",
      "relation": "see_also"
    },
    {
      "id": "BUG-034",
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
    "archived_path": "docs/bugs/archive/BUG-020-reattach-does-not-backfill-live-subagent-state.md",
    "sha256": "a123f95fd1b5a6760f01b650b47816c4479ee32c5a07e88262efca690c67e1bd",
    "bytes": 18179,
    "original_title": "reattach after a dashboard reload never tells the client about a sub-agent that already started/finished (live \"agents running\" strip goes silently blank)",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the archived ticket and extracted evidence; the symptom, display-only bound, timing cases, mechanism, fix direction, relationships, and executed results remain represented.",
    "dropped": [
      "Approximate source line numbers",
      "Step-by-step scratch-server setup details"
    ]
  }
}
```

# BUG-020 — Reloaded dashboards lost completed sub-agent activity

## Diagnosis

Opening or reattaching a session resets `state.agents`. The client rebuilt that map only from later `agent-started`, `agent-progress`, and `agent-completed` events. Meanwhile, detach and attach preserved the server's `#agents` map, but the reattachment handshake did not replay it. Completed agents therefore had no remaining event capable of restoring their display.

## Evidence

Three real-server reproductions used the browser's close sequence and reconnected with `resumeSessionId`. During two mid-flight reloads, no sub-agent snapshot arrived within 350ms; later visibility depended on a natural progress event. In the decisive completed-before-reload case, the new socket received no event for that agent before `turn-end`, although execution completed uninterrupted and its disk record remained.

After correction, `verify:reattach-agent-backfill` passed 15/15, `verify:reattach-approval` passed 11/11, `verify:reload-live-summary` passed 10/10, and `verify:ui` passed 3/3. Type checking was clean. `verify:close-busy-detach` and `verify:reattach-agents` were named without recorded run results.

## Implementation notes

Reattachment must seed the client from every entry retained by `liveAgents()`, including running and completed agents. This belongs beside the existing approval replay so visibility does not depend on incidental future events.

## Verification plan

Cover both timing cases with a fresh socket: an agent still running at reattachment and an agent completed before reattachment. Assert immediate visibility in both cases, then retain approval replay, live-summary, interface, and type checks as regression coverage.

## Risks

A test covering only a running agent can pass accidentally when a later progress event arrives. The completed-before-reload case is required to prove that reattachment performs deliberate backfill.

## Activity log (APPEND-ONLY)

### 2026-08-04 — agent (read-only diagnosis)
- **Understood:** dispatched to confirm/refute whether a dashboard reload
  during an in-flight sub-agent kills it (A) or just stops displaying it (B),
  building on BUG-018 (main-turn detach-not-close) and BUG-008
  (approval-replay-on-reattach precedent).
- **Verified:** traced `AgentSession.#agents` / `liveAgents()` / `detach()` /
  `attach()` / `replayPending()` in `agent-bridge.ts`, the reattach handshake
  in `index.ts` (~1777-1819), and the client's `state.agents` /
  `resetTranscript()` / `agent-started` handlers in `app.js`. Confirmed by
  static reading that `liveAgents()` exists and survives detach/attach
  untouched, but is never consulted by the reattach handshake — only
  `replayPending()` (approvals) runs there.
- **Confirmed live** with a real scratch server (three runs, real haiku
  sessions, real `Task`-tool sub-agents, the EXACT client
  `{type:'close'}`+`ws.close()` sequence): sub-agents are NEVER killed by a
  reload (turn always finishes, `interrupted:false`, marker files land on
  disk) — verdict is **(B), not (A)**. But: no immediate backfill on
  reattach in any run; a sub-agent that already fully completed before the
  reload is **never** mentioned to the reattached socket (case B, the
  decisive negative check) — a genuine, reproducible display/reattach gap,
  filed as this ticket.
- **Handoff:** fix direction above (extend `replayPending()`/sibling method
  to cover `#agents`, called from the same `index.ts` reattach site as
  BUG-008's fix). Did not touch `src/server/index.ts` (another agent was
  editing it per this ticket's constraints) or any other source; no commit
  made. Scratch verify script used to produce the Repro was deleted, not
  committed — the fixing agent should add a permanent one per the Repro
  test note above.

### 2026-08-04 — fix + verification (subagent)
- **Understood:** confirmed the diagnosis's own read: `AgentSession.#agents`
  (`src/server/agent-bridge.ts:315`) is populated at `task_started`/
  `task_progress`/`task_updated` (~1168-1216) and NEVER cleared for the life
  of the session (entries persist with their final `status` even after
  completion — this is also what already powers the disk-merged
  `liveAgents()` used by `/api/sessions/:id/subagents`). `detach()`/`attach()`
  (~712/718) only rewire `#emit`, so `#agents` survives a reload untouched.
  The reattach handshake (`src/server/index.ts` ~1777-1819) called only
  `running.replayPending()` (BUG-008, approvals) — nothing replayed agent
  state, exactly as diagnosed. Also learned mid-fix (not previously
  documented): the Task tool in this SDK/environment is ASYNCHRONOUS (tool
  result is "Async agent launched successfully") — the orchestrator's own
  turn does not block on a sub-agent finishing, so a session can go idle
  (`busy:false`) almost immediately after launching sub-agents that are
  still running in the background; only a session that is still genuinely
  `busy` detaches (rather than closes outright) on socket loss, so a valid
  repro needs the ORCHESTRATOR itself busy (e.g. its own Bash sleep) across
  the reload window, not just a busy-looking sub-agent.
- **Changed:**
  - `src/server/agent-bridge.ts` — added `replayAgents()` (sibling to
    `replayPending()`, same file, right after it): re-emits one event per
    `#agents` entry — `agent-started` for one still `running`,
    `agent-completed` for one already `completed`/`failed`/`killed`. Reuses
    the existing `LiveAgent` shape verbatim (`{ ...a }`), so it needs no new
    event type and the client's existing `agent-started`/`agent-completed`
    handlers (`public/app.js` ~4276-4309) apply unmodified — client-side
    required ZERO changes, since `state.agents`/`renderStrip()` were already
    correct consumers of these events, just never fed them on reattach.
  - `src/server/index.ts` — reattach branch (`cmd.resumeSessionId` /
    `running.attach(send)`, ~1777) calls `running.replayAgents()` right after
    `running.replayPending()`, same site BUG-008 already uses.
  - `scripts/verify-reattach-agent-backfill.mjs` + `package.json` script
    `verify:reattach-agent-backfill`.
- **Verified (§C rule — real browser, real DOM, real user path):**
  - `npm run verify:reattach-agent-backfill` → **PASS 15/15**, twice
    consecutively for stability. Real scratch server + real brave headless
    (CDP) + a real haiku session that launches two real Task-tool sub-agents
    (QUICK ~1s, SLOW ~10s) while the orchestrator itself sleeps ~25s to stay
    genuinely busy. Captures the exact split (QUICK settled, SLOW still
    running) atomically from `window.__station.state.agents`, confirms the
    strip shows it pre-reload (baseline sanity), then does a REAL
    `Page.reload()` (the literal action named in this bug), confirms
    `applyRoute` lands back on the same session and the client HONESTLY
    knows nothing yet (`state.agents` empty — the exact display gap), then
    drives the real recovery path a returning user takes: types a message
    and presses Enter (not `#go`.click() — while `state.busy` is true from
    the honest `liveRec`, `#go` is repainted as an INTERRUPT button per
    `node.go.dataset.mode`, so only Enter reliably submits, matching real
    keyboard use) — `submit()`'s existing resumeSessionId auto-supply drives
    the exact server reattach handshake this ticket fixes. Then asserts,
    from DOM queries against `#stripRows`, that: (Case A) the still-running
    sub-agent's row shows with the `.run` class IMMEDIATELY off the reattach
    ack (polled via raw CDP `Network.webSocketFrameReceived` frames, not a
    coarse sleep-then-check, to catch the true instant and rule out
    "eventually, by luck"); (Case B) the sub-agent that finished BEFORE the
    reload is also known to the client (`state.agents.has(doneId)`, not
    dropped); then that it genuinely finishes for real afterward and the
    strip DOM updates accordingly, and that BOTH real marker files the
    sub-agents wrote land on disk (proving neither was interrupted/killed by
    the reload/reattach).
  - **Regression checks (same-file tickets):**
    `npm run verify:reattach-approval` (BUG-008) → **PASS 11/11**.
    `npm run verify:reload-live-summary` (BUG-017) → **PASS 10/10**.
    `npm run verify:ui -- --offline` → **PASS 3/3**.
    `npm run typecheck` → **PASS** (tsc --noEmit clean).
  - Screenshot: `docs/bugs/assets/BUG-020-after.png` (captured mid-test, the
    reattached client's strip showing the still-running sub-agent).
- **Notes for reviewer:** the verify script's SLOW/QUICK sleep durations
  (10s/1s) and the orchestrator's own ~25s keep-busy sleep were tuned
  empirically against this environment's real LLM/tool latency — earlier
  attempts with a longer SLOW sleep (40s) intermittently raced against an
  apparent async-agent completion signal that can arrive before its
  underlying Bash call is provably done (marker file still absent), which is
  an existing SDK/harness quirk unrelated to this fix, not a regression
  introduced by it. If this test becomes flaky over time, widen the marker
  grace-poll (currently 50×200ms) or shorten SLOW further before suspecting
  the fix itself — the DOM assertions (Case A/B) are the load-bearing checks
  and were stable across every run once the reattach path was actually
  exercised (real Enter-key submit, not a busy-mode `#go` click).
- **Handoff:** none — fixed and verified. Orchestrator to review the diff
  (`src/server/agent-bridge.ts`, `src/server/index.ts`,
  `scripts/verify-reattach-agent-backfill.mjs`, `package.json`) and commit.
  Shares `src/server/agent-bridge.ts` and `src/server/index.ts` with BUG-008
  — serialize commits with any other in-flight ticket touching those files.
