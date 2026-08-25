```orchard-ticket
{
  "id": "BUG-030",
  "type": "bug",
  "title": "Finished agent calls no longer remain visibly active",
  "summary": "Tool-call cards from finished agents now settle after a host restart and session resume. Previously, calls missing a terminal event remained visibly active with growing timers. The pre-fix case reproduced the fault, corrected behavior passed the recorded suites, and standing checks stayed clean.",
  "impact_if_we_wait": "People can mistake completed work for active work and misread elapsed times. Bounded: this is agent-panel display-correctness, not lost work or user data, and genuinely running calls remain distinguishable.",
  "current_need": "Treat the ticket as closed: the pre-fix case failed, the corrected behavior passed the recorded suites, and standing checks stayed clean.",
  "severity": "not_recorded",
  "area": "Agent activity panel",
  "reported": "2026-08-05",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-05",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Reattached calls from completed agents show a terminal state instead of remaining visibly active",
    "Calls interrupted by shutdown show a shutdown-related terminal state",
    "Calls backed by a genuinely running process remain visibly active",
    "Existing agent backfill and live summary behavior remains intact"
  ],
  "code_refs": [],
  "related": [
    {
      "id": "BUG-004",
      "relation": "see_also"
    },
    {
      "id": "BUG-020",
      "relation": "see_also"
    },
    {
      "id": "BUG-028",
      "relation": "see_also"
    },
    {
      "id": "BUG-033",
      "relation": "see_also"
    },
    {
      "id": "BUG-034",
      "relation": "see_also"
    },
    {
      "id": "BUG-035",
      "relation": "see_also"
    },
    {
      "id": "BUG-105",
      "relation": "see_also"
    },
    {
      "id": "BUG-113",
      "relation": "blocks"
    },
    {
      "id": "FEAT-057",
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
    "archived_path": "docs/bugs/archive/BUG-030-stale-agent-tool-cards-after-host-cut.md",
    "sha256": "ccd25906c05915265422b16a1a2f621b65f7e88b41af29fa33a623c5764084e1",
    "bytes": 9763,
    "original_title": "agent tool-call cards stay ◐ in-flight forever after a host CLI cut/resume",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the supplied ticket and extracted evidence; the symptom, suspected causes, fix boundary, live-case safeguard, related bugs, and recorded runs remain represented.",
    "dropped": [
      "Exact elapsed-time examples",
      "Suggestion to group rows by agent"
    ]
  }
}
```

# BUG-030 — Finished agent calls no longer remain visibly active

## Diagnosis

After the host CLI was cut and the session resumed, transcript backfill could reconstruct a tool call without finding its terminal event. The ticket identified shutdown interruption, an agent result, and the enclosing turn boundary as possible ground truth for settling the card. It also noted that liveness merging could wrongly treat transcript presence as evidence of a live process.

## Evidence

The live report showed completed Bash calls from two finished agents still rendered as active, with timers continuing to grow. With the fix hunks stashed, the pre-fix run produced 8/12 passes and therefore reproduced failures. Executed suites then passed: `verify:ui` 3/3, `verify:reattach-agent-backfill` 15/15, `verify:agent-summary` 3/3, `verify:reload-live-summary` 10/10, and `verify:restart-survives` 15/15. Another recorded tally was 12/12 without an adjacent suite name. Type checking was clean. `verify:restart-interrupt-label` and `verify:stale-agent-cards` were named without recorded results.

## Implementation notes

Reattachment and turn-boundary handling must settle cards that have no live process behind them. A call with a result becomes done; shutdown-interrupted work receives a terminal shutdown label. Grouping calls by agent was secondary to correcting the misleading liveness display.

## Verification plan

Exercise restart and resume with a subagent performing a long Bash call, then confirm the reattached card is terminal rather than active. Separately confirm a genuinely running call stays active. Preserve coverage for transcript backfill, agent summaries, live-summary reloads, restart survival, the offline UI, and type checking.

## Risks

Overeager settling could mark a genuinely running agent as finished. Terminal-state inference must rely on shutdown, result, turn-boundary, or live-process evidence rather than transcript presence alone.

## Activity log (APPEND-ONLY)
### 2026-08-05 — orchestrator
- Filed from the user's screenshot-list question ("is this accurate?" — it wasn't: two finished
  agents' bash calls rendered as 16 forever-spinning "agents"). State-honesty class; pairs with
  BUG-020/BUG-028.

### 2026-08-05 — fix agent — ROOT CAUSE + FIX — VERIFIED

**Root cause (probe-verified against the real `claude` CLI v2.1.220, not assumed).**
Direct stream-json probes (subagent doing two Bash calls; then a SIGTERM mid-call + `--resume`)
established the task-event lifecycle the bridge never knew:
1. **Every Bash call a Task-tool subagent makes is announced as its own task** —
   `system/task_started` with `task_type:"local_bash"`, description = the Bash call's
   `description` param. The bridge's `task_started` handler turned each into a full `LiveAgent`
   row (mislead 1: tool calls rendering as "agents" — the 16 rows).
2. **A `local_bash` task's ONLY terminal frame is `task_notification` with `status:"completed"`**
   — there is NO `task_updated` for it. The bridge's `task_notification` handler
   (`src/server/agent-bridge.ts`, was ~1481) dropped the status entirely (emitted a status
   string only), so the `#agents` entry stayed `running` forever → the client row spun ◐ with a
   growing timer long after the call finished. This is the primary ◐-persistence site, and it
   bites even WITHOUT a cut: during any long orchestrator turn the rows accumulate (the bridge's
   only other settle point is the `result` sweep at turn end, which never comes mid-turn) —
   exactly the user's 30:17→0:36 list.
3. **The cut makes it permanent:** a SIGTERM'd CLI emits `task_notification status:"stopped"` (+
   `task_updated status:"killed"` for agent tasks) on its way out — frames that die with the
   server in a real restart — and a resumed CLI **re-announces nothing**. An open tab that lived
   through the cut keeps its `state.agents` rows and NO code path ever settled them: not the new
   bridge's `replayAgents()` (empty `#agents`), not the client `turn-end` handler (no sweep),
   nothing. Forever ◐.

**Fix (three seams, matching the three findings).**
- `src/server/events.ts` — `LiveAgent.kind?: 'agent' | 'tool'` (documented): a task with no
  `subagent_type` and a non-`local_agent` `task_type` is a TOOL-CALL row, not a subagent.
- `src/server/agent-bridge.ts` — `task_started` sets `kind`; `task_notification` (~1481) now
  settles the entry when its status is terminal (`completed`; `failed`/`error`→failed;
  `stopped`/`killed`→killed) and emits `agent-completed`, then still emits the status line.
- `public/app.js` — the in-flight INVARIANT, enforced client-side (comment block above
  `settleCut`, ~3512): a card may show ◐ only while a live process/turn can be behind it.
  (a) `agent-*` handlers stamp `seenAt`; a `kind:'tool'` completion settles silently (no "ran"
  row, no main-stream finish — 16 Bash calls must not spam the transcript).
  (b) `turn-end` calls `settleCutAgents()`: after a turn's `result` nothing can still be running
  (the live bridge already swept its own rows to `completed` just before, so anything left is a
  zombie from a dead CLI) → settle as status `cut`.
  (c) the `start` ack calls `scheduleCutSweep()`: snapshot pre-existing running rows; anything
  `replayAgents()` (which lands right behind the ack) does not refresh within 1.5s has no live
  process behind it → settle as `cut`. A real subagent settled this way leaves a "ran" row whose
  body reads "Cut by shutdown — the host CLI was stopped mid-flight (server restart or shutdown)
  and no result was recorded." (`settleAgent`'s new `cut` branch); tool rows settle silently.
  BUG-028's `interruptedByShutdown` is the transcript-side trace of the same cut; the sweeps need
  no transcript read because the two ground truths (turn boundary + replay-on-attach) are
  available live.
- Secondary (per-agent grouping) NOT done — judged not low-risk for the strip's layout; the
  `kind` field now on every event is the ready hook for a future grouping pass.

**Verified (scratch only; :4317/claude-station.service never touched — confirmed 200 after; own
transient unit + pids only; scratch units/dirs/probe stores all removed).**
- NEW `scripts/verify-stale-agent-cards.mjs` + package.json `"verify:stale-agent-cards"` —
  deploy-shaped (verify-restart-interrupt-label pattern): transient `--user` service
  (control-group kill), REAL haiku session whose subagent runs CUT-A (4s) then CUT-B (240s)
  Bash calls while the orchestrator's own KEEPBUSY Bash holds the turn; REAL headless-Brave tab
  attaches mid-turn (Enter-key resume), REAL `systemctl --user stop` mid-CUT-B with the tab left
  open (the live incident's exact shape), fresh server on the SAME port, in-tab
  reconnect-and-resume, DOM strip assertions throughout.
  - PRE-FIX (fix hunks stashed): **8/12 — bug reproduced exactly**: finished CUT-A stayed ◐;
    after cut+resume CUT-A/CUT-B/KEEPBUSY (+ even the new turn's rows) all spun ◐ forever; no
    cut caption; invariant check failed. All preconditions and live-◐ checks passed.
  - POST-FIX: **12/12 PASS, twice consecutively** — finished call settles while its sibling
    still shows ◐ (terminal seam); after cut+resume the cut calls AND their subagent are settled
    with the honest "Cut by shutdown" caption while the resumed turn's genuinely-running work
    still shows ◐ (live case intact); zero in-flight rows at rest after the boundary.
  - Screenshots: `docs/bugs/assets/BUG-030-live-inflight.png`,
    `docs/bugs/assets/BUG-030-settled-after-cut.png`.
- Anti-regression: `verify:reattach-agent-backfill` (BUG-020) **15/15** — the 1.5s sweep does
  not eat replayed genuinely-live agents (replay refreshes `seenAt` before it fires, and a
  post-reload tab has an empty map at ack so the sweep no-ops); `verify:agent-summary` **3/3** +
  `verify:reload-live-summary` **10/10** (BUG-004 lineage); `verify:restart-survives` **15/15**;
  `verify:ui -- --offline` **3/3**; `typecheck` clean.
- Harness notes for future maintainers: (1) per-start overrides do NOT survive the page-driven
  resume — the harness sets `permissionMode: bypassPermissions` at the PROJECT level or the
  resumed turn hangs on approval cards; (2) an async subagent announced AFTER its parent turn's
  `result` genuinely (and correctly) runs past `busy=false` — the at-rest check drives one more
  tool-less turn if needed rather than mislabeling that honest ◐; (3) assert the caption via
  `textContent`, not `innerText` (it lives in a closed `<details>`).

**Go-live note.** Server+client fix; takes effect on :4317 at the next deliberate deploy restart.
The orchestrator's own currently-spinning rows (the reported list) are client-state only — they
disappear on the next reload and can no longer form, since every path that created them is
settled at source now.

**Handoff:** none — fixed and verified. Orchestrator reviews the diff (`src/server/events.ts`,
`src/server/agent-bridge.ts`, `public/app.js`, `scripts/verify-stale-agent-cards.mjs`,
`package.json`) and commits. Shares `agent-bridge.ts`/`app.js` with BUG-020/BUG-028 lineage —
serialize with any in-flight ticket touching those files.
