# BUG-077 — interrupt() while idle latches #interruptRequested, mislabeling the NEXT turn as interrupted

- **Status:** VERIFIED 2026-08-13 (deployed) — `#interruptRequested` now cleared at turn
  START (send() + the constructor turn-open), so an idle/stray Stop or the result-then-interrupt
  race cannot latch into the NEXT turn. `verify:bug-077-interrupt-latch` 11/11 post-fix; the SAME
  script must-FAILs pre-fix at 8/11 (the 3 bridge-flag differentiators: turn-end interrupted, and
  autonomous ×2). Anti-regressions all green (typecheck; agent-outcomes 45/45; liveness-conformance
  96/96; restart-interrupt-label 11/11; codex-runtime 54/54 + provider-picker 17/17 for the shared
  fixture; feat-022 autonomous 1/1). SERVER change → not yet deployed. Awaiting independent verification.
- **Area:** src/server/agent-bridge.ts — turn/interrupt state honesty
- **Reported:** 2026-08-12 by the area-review workflow (bridge reviewer + skeptic verify)

## Finding (code-confirmed)
`#interruptRequested` is set true in `interrupt()` (agent-bridge.ts:978, guarded only by `closed`,
no busy-guard) and cleared ONLY when a `result` frame arrives (:2150-2151). `send()` never resets
it, and the socket command handler calls `interrupt()` with no liveness check (index.ts:2934-2937).
So an interrupt processed while no turn runs — a stray/duplicate Stop, or the common race where a
turn hits its own `result` a beat before the queued interrupt command is dequeued — leaves the
flag stuck `true`. The next legitimate turn reads `interrupted = #interruptRequested===true` at its
`result` and produces three dishonest effects: (a) every still-open agent settled as `'killed'` +
interrupt deaths in the outcomes ledger (BUG-041's class); (b) `turn-end` emitted `interrupted:true`
for a turn nobody interrupted; (c) `#maybeAutoContinue(true)` halts autonomous mode with reason
`'interrupted'`.

## Failure scenario
Turn A busy; user clicks Stop. A reaches its natural `result` first (interrupted=false, busy=false);
the queued `interrupt` command then runs — sets `#interruptRequested=true`, runtime.interrupt() is
a no-op. User sends Turn B → B completes cleanly → its `result` reads the stale true → B's agents
logged as killed, autonomous mode halts "interrupted". A false death record + a spurious stop.

## Wanted
Clear `#interruptRequested` at turn START (in `send()`/the turn-open path), so a turn's interrupt
flag reflects only interrupts raised during THAT turn — and/or make `interrupt()` a no-op when no
turn is in flight (busy-guard). Prefer clear-on-start (robust to the result-then-interrupt race).
Keep genuine mid-turn interrupts working (BUG-028's restart-not-interrupt labeling intact).

## Verification (§C)
Scratch bridge: interrupt raised while idle (or result-then-interrupt race) → the NEXT turn ends
with interrupted=false, no killed records, autonomous continues (must FAIL pre-fix: stale true
mislabels turn B). A genuine mid-turn interrupt still yields interrupted=true + honest killed
records. Anti-regressions: verify:agent-outcomes, verify:liveness-conformance, verify:restart-interrupt-label,
verify:feat-022 (autonomous), typecheck.

## Activity log (APPEND-ONLY)
### 2026-08-12 — orchestrator
- Filed from the area-review workflow. Server-side, needs a deploy (deferred). Fix in agent-bridge
  only (clear-on-turn-start) to stay disjoint from BUG-076's index.ts lane.

### 2026-08-12 — builder (fix + verify)
- FIX (agent-bridge.ts, lane-clean — index.ts untouched): added `this.#interruptRequested = false`
  at BOTH turn-open sites — `send()` (the follow-up/autonomous-nudge path, alongside the existing
  per-turn `lastProviderError`/`#advisoryNotice` resets) and the constructor's first-turn open
  (same invariant). The `result`-time clear at :2150 stays. Net: a turn's interrupt flag reflects
  ONLY interrupts raised during THAT turn; an idle/stray Stop or the result-then-interrupt race
  can no longer bleed into the next turn. Genuine mid-turn interrupts are unchanged (the flag is
  set during the live turn and read at its own result).
- VERIFY (§C, scratch bridge — real server + real AgentSession + schema-validated fake `codex
  app-server`, free ephemeral ports + scratch dataDirs, no API cost): new
  `scripts/verify-bug-077-interrupt-latch.mjs` (+ `verify:bug-077-interrupt-latch` in package.json).
  - PART A (idle Stop, interactive): first turn completes honestly → Stop sent while IDLE → next
    turn (agents held running, then a NATURAL completion) ends `interrupted:false`; no `killed`
    outcome records; non-vacuity: that turn genuinely spawned agents (sweep path live).
  - PART C (autonomous): idle Stop, autonomous armed (maxTurns 3), next turn → auto-continue FIRES
    (turnsDone advances to 3, halts `turns-reached`), NEVER halts with reason `interrupted`.
  - PART B (anti-regression, genuine mid-turn Stop): HOLD_AGENTS turn interrupted mid-flight still
    yields turn-end `interrupted:true` + `killed` records (thr_hold_agent_1/2).
  - Counts: 11/11 post-fix. MUST-FAIL PROOF — reverting the two clear lines → 8/11 pre-fix: the 3
    bridge-flag differentiators FAIL (A1 `interrupted:true`; C1 `turnsDone:0`/`stopReason:'interrupted'`);
    PART B still passes pre-fix (genuine interrupts always worked). Restored the fix; 11/11 again.
  - NOTE: the killed-record mislabel (ticket effect (a)) is the CLAUDE bridge-sweep path — the codex
    runtime settles its own agents by turn subtype (`success`→completed) in `#finishTurn`, so on a
    natural completion no death is written regardless of the bridge flag. Effects (b) turn-end
    `interrupted` and (c) autonomous halt ARE bridge-flag-owned and are the reproduced must-FAIL
    differentiators here; (a) is covered by construction (it reads the same `interrupted` variable
    A1 pins). PART B proves the genuine-interrupt killed path is intact.
- Fixture: additive `HOLD_AGENTS:<n>;COMPLETE` marker in codex-fake-app-server.mjs (spawn n running
  agents, then a natural `turn/completed status:'completed'`) — no existing marker path changes;
  shared-fixture consumers re-run clean (codex-runtime 54/54, provider-picker 17/17, agent-outcomes 45/45).
- Anti-regressions: typecheck clean; verify:agent-outcomes 45/45; verify:liveness-conformance 96/96;
  verify:restart-interrupt-label 11/11 (BUG-028 label intact); verify:feat-022 autonomous 1/1.
- SERVER change → needs a deploy; NOT deployed/restarted here (deferred to the deploy step).

### 2026-08-13 — board reconciliation
- Deploy has since happened (commit 5d91269 live; pid 1162138 runs the latest code). Status header
  relabeled FIXED→VERIFIED so board:gen moves this row out of Open (queued-count reconciliation).
