# BUG-044 — server restart still kills a session's live BACKGROUND agents (re-adopt drain path)

- **Status:** VERIFIED 2026-08-11 — deploy-shaped test 15/15 (pre-fix FAIL proven: heartbeat cut, no DONE); anti-regressions green except hosts-cleanup 14/17 which fails IDENTICALLY at pristine HEAD (pre-existing, evidence in log). Fix requires a later DEPLOY — not deployed.
- **Area:** boot-time re-adopt / broker drain (restart path)
- **Reported:** 2026-08-11 (BUG-043's documented residual, promoted to its own ticket)

## The gap
BUG-043 made socket close/switch lifetime-aware, and guarded the broker's 120s abandon net. But the
RESTART path is untouched: on boot, `adoptSurvivingHosts()` drains a surviving broker — stdin EOF
after `result`, then the unconditional 150s SIGTERM in `gracefulReap()`'s escalation. A session
whose foreground turn ends during the drain but whose BACKGROUND agents are still working gets
SIGTERM'd 150s later, exactly like arm C before the fix.

## Operational consequence (why deploys are currently sequenced around it)
Deploy restarts must wait for a moment with NO live background work; the orchestrator is doing
this by hand. That is a footgun for any future operator who restarts casually.

## Fix direction
The broker already knows how to sniff the background level off stdout (BUG-043 gave it that for the
abandon net) — the DRAIN path must consult the same signal: after `result`, if background work is
live, hold the drain (bounded, with the same decline/re-arm loop) instead of escalating at a fixed
150s. Same unknown-case posture as BUG-043 (unknown holds, bounded by the dead-process probe).

## Verification (must FAIL pre-fix)
Deploy-shaped: session with a live background heartbeat agent → restart the scratch server → the
survivor drains its foreground turn, background agent RUNS TO COMPLETION (240/240 beats), then the
broker reaps cleanly; a survivor with no background work still drains+reaps on today's schedule.
Anti-regressions: restart-survives 15/15, health-survivor, restart-reconnect-race,
close-background-detach (BUG-043's suite), hosts-cleanup, typecheck.

## Activity log (APPEND-ONLY)
### 2026-08-11 — orchestrator
- Promoted from BUG-043's residual note so it cannot silently linger. Until fixed: never restart
  the service while background agents run.

### 2026-08-11 — FIX + verification (fix agent, in-place on main)
- **Root cause CONFIRMED, and the experiment found it is TWO killers, one earlier than filed:**
  1. *Shutdown half (NEW — found by the pre-fix run, not the ticket):* `closeAllSessions(signal,
     {handoff:true})` (agent-bridge.ts) hands off only `s.busy` survivable sessions — `busy` is
     TURN-scoped (ARCH-002's exact defect, at a third site). A session whose turn had ended but
     whose background agent was live was CLOSED at server shutdown → broker reaped → stdin EOF →
     the CLI exited ~4s later taking the background agent with it. Measured pre-fix: heartbeat cut
     at 14/240 beats, ~4s after server-1 SIGTERM, BEFORE boot re-adopt ever ran.
  2. *Boot half (as filed):* `adoptSurvivingHosts()` (survival.ts:473) → `reapHost()` → SIGTERM →
     broker `gracefulReap()` (session-host.mjs) EOF'd stdin after `result` and fired an
     UNCONDITIONAL SIGTERM at 150s / SIGKILL at 160s — reachable by any handed-off or
     crash-surviving broker.
- **Correction to BUG-043's record (measured, load-bearing):** arm C's "the CLI does not exit on
  EOF while a background agent works" held only inside the 150s window it observed. This ticket's
  pre-fix run shows the CLI DOES exit ~4s after an idle-EOF with a live background task, killing
  it. Therefore holding only the SIGTERM escalation is insufficient — the drain must hold the EOF
  itself. The fix does.
- **THE FIX (ARCH-002 option 1 — both restart halves consult the same declared lifetime):**
  - `src/server/session-host.mjs` — the broker's local lifetime answer
    `backgroundOutlivesTurn()` (:318-323): `yes` from the CLI's own `background_tasks_changed`
    level (BUG-043's existing sniff); `unknown` inside the observed-dispatch window
    (`state.bgDispatchAt` :109, set by an assistant `tool_use` with `run_in_background:true`
    :168-176, cleared by any level frame :166, bounded by `CLAUDE_STATION_HOST_BG_UNKNOWN_MS`
    default 120s — the broker-side mirror of the bridge's pre-signal-race guard); else `no`.
  - `gracefulReap()` (:391) now routes to a lifetime-gated `commitDrain()` (:364) once the
    foreground turn has drained (`result` landed :157-162, idle, or the 90s backstop): while the
    answer is `yes`/`unknown` it HOLDS — no EOF, no escalation — heartbeats the status file and
    re-checks (`CLAUDE_STATION_HOST_DRAIN_RECHECK_MS` default 15s); on `no` it EOFs and arms
    today's escalation (`CLAUDE_STATION_HOST_DRAIN_TERM_MS` 150s + KILL lag 10s, re-consulting at
    fire time :377-389). Bounded by the dead-process probe (child 'exit' → shutdown) and the
    unknown window; `unknown` is never coerced (holds).
  - The BUG-043 abandon net now consumes the SAME answer (:253) — one lifetime decision, two
    fuses; behaviour unchanged for a CLI that never reports background work.
  - `src/server/agent-bridge.ts:2649` — the shutdown handoff decision:
    `s.busy || s.workLifetime().outlivesTurn !== 'no'` hands off (minimal one-condition change);
    only a session with nothing running and nothing outliving the turn closes at shutdown.
  - `scripts/verify-bug-044-restart-background.mjs` (new) + package.json entry
    `verify:bug-044-restart-background` (entry was already present in HEAD from the filing).
- **Verification (§C, scratch ports/dataDirs, kill by pid, :4317 untouched).**
  - **Pre-fix at HEAD session-host.mjs: FAILED as required — 8/13.** Load-bearing check:
    `done:false, beats:14/240, brokerStatesSeen:[draining, no-status-file]` — background work
    killed on the restart path (via killer 1 above; killer 2's fixed 150s schedule shown by the
    broker-direct checks timing out at their 12s deadlines). Full log preserved in the run output.
  - **Post-fix: 15/15.** Broker-direct (fake CLI, tiny knobs): held (CLI alive after many
    windows), bounded (level empties → wedged CLI reaped), unknown holds then window-expires,
    today's-schedule control (`reapedAfterMs:2202` ≈ TERM 2000), clean-drain control. Deploy-shaped:
    real background heartbeat agent survives server SIGTERM → handoff → re-adopt → broker holds
    (`draining` for the whole window) → **241/240 beats + DONE** → broker reaps cleanly (status
    file gone, broker+CLI dead); graceful-restart idle control gone 2s after re-adopt; crash-shaped
    (SIGKILL) control: idle SURVIVOR re-adopted and reaped 1s after boot — today's schedule.
  - **Anti-regressions:** restart-survives 15/15; health-survivor 14/14; restart-reconnect-race
    10/10; close-background-detach 27/27 (BUG-043's suite — the shared-consult abandon net keeps
    its guarded/bounded/control behaviour); typecheck clean; leak-gate PASS.
    **hosts-cleanup 14/17: PRE-EXISTING** — the same three survivor-close checks fail IDENTICALLY
    at pristine HEAD in a clean worktree (run twice on the fix + once at HEAD, same signature:
    survivor broker never leaves `running`, so the session-level close/fuse never fired — a
    bridge-side path this change does not touch). Not caused, not masked, needs its own ticket.
- **Operational note: the fix requires a later DEPLOY (service restart). Do NOT deploy casually —
  until deployed, the running service still has both killers; keep sequencing restarts around
  live background work. The deploy that ships this is the last one needing that care.**
- **Residuals, named:** (a) hosts-cleanup's pre-existing survivor-close failure above (bridge
  close path, not broker); (b) the `result`-sweep pre-signal-window settle from BUG-037/BUG-043
  remains open, unchanged here; (c) an engine that NEVER emits a background level (and whose
  dispatches carry no `run_in_background`) gets pre-fix drain behaviour by design — that is the
  declared-lifetime contract, not a gap.
- **Closing assessment.** The ticket named the boot drain; the §C experiment found the shutdown
  half killed first, and killed by EOF, not SIGTERM — both corrections came from the deploy-shaped
  test failing in an unexpected WAY, which is exactly what §C's "must fail pre-fix" is for. The
  fix is ARCH-002 option 1 at both remaining sites: shutdown handoff and broker drain now consume
  the same declared answer the socket paths and both fuses consume; no site infers lifetime from
  `busy` anymore. Confidence: HIGH on the mechanism (deterministic broker-direct checks + one full
  deploy-shaped run each way); MEDIUM-HIGH end-to-end (single N for the 240s arm, but every
  intermediate state was sampled and matches the mechanism).
