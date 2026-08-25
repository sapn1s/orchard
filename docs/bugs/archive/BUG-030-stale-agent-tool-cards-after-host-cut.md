# BUG-030 — agent tool-call cards stay ◐ in-flight forever after a host CLI cut/resume

- **Status:** VERIFIED
- **Area:** claude-station UI — agents panel / reattach backfill (BUG-020 sibling)
- **Reported:** 2026-08-05 by user (showed a 16-row list of "agents and their work times": completed
  subagent Bash commands from two finished agents all still rendered ◐ in-flight, times 30:17→0:36)

## Symptom (observed live)
After the orchestrator's host CLI was cut (server restart / drain) and the session resumed in a
new CLI, the agents panel showed the PRIOR agents' individual tool calls (local_bash rows) as
still-running (◐) with ever-growing elapsed times — long after those agents completed. Two
misleads: (1) each tool call renders as if it were a separate "agent"; (2) completion state is
never settled for calls whose terminal event was lost with the cut CLI, so they spin forever.

## Root-cause direction (investigate, don't assume)
The backfill path (BUG-020) reconstructs sub-agent state from transcripts; a tool call whose
result/terminal frame was never written (CLI cut mid-flight) or whose completion event arrived
only on the dead socket has no "done" record. The union-liveness logic (BUG-004) may also treat
transcript-present tool calls as live. Determine where the ◐ state comes from and what ground
truth exists (BUG-028's interruptedByShutdown flag on the cut turn; the agent's own final result
frame; the session's turn boundary — after a turn's `result`, NOTHING from that turn can still be
running).

## Fix direction
On backfill/reattach (and at any turn boundary), settle every tool-call card from a no-longer-
running agent/turn to a terminal state: done (result present), or "cut by shutdown" (turn carries
interruptedByShutdown / agent never completed) — never leave ◐ spinning without a live process
behind it. Consider grouping rows per agent rather than a flat call list (secondary; the honesty
fix is primary).

## Verification (REQUIRED, user-observable)
Deploy-shaped scratch test (pattern of verify-restart-interrupt-label): drive a session that
spawns a subagent doing a long Bash call, cut the host CLI (scratch service stop), resume, and
assert the reattached UI shows the call settled (done or cut-by-shutdown caption) — NOT ◐.
A genuinely-running agent must still show ◐ (don't break the live case). Must FAIL pre-fix.
Playwright + verify:ui offline + typecheck; anti-regression BUG-020 backfill + BUG-004.

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
