# BUG-034 — agents strip shows no row for the MAIN session while it's working

- **Status:** VERIFIED (2026-08-10 — ARCH-001 phase 2: the strip renders a server-authored
  running-set snapshot; built with FEAT-057)
- **Area:** claude-station UI — agents strip / live-state honesty (BUG-030/BUG-033 family)
- **Reported:** 2026-08-09 by user ("when I submitted a message and you were likely in 'thinking'
  state, the list does not show any agent running, even now (should be main (you)) — whereas your
  response msgs do come through normally")

## Symptom
While the main session is genuinely working (thinking/streaming), the agents strip shows nothing
running — no row for the orchestrator itself. Responses stream normally, so the session IS alive;
only the strip is silent. Inverse of BUG-030 (which showed phantom running rows).

## Wrinkle to investigate FIRST (do not assume)
In the BUG-033 zombie report the user's screenshot DID show a `main · <project> ◐` row with a
(fake) timer — so a main row can render. Determine whether that row only appears via the
stale/zombie/reattach path (e.g. reconstructed from a live-bridge record) and never from the
normal turn lifecycle, or whether it renders and is immediately cleared. Establish the actual
render conditions before changing anything.

## Goal
The strip honestly represents the main session's own work: a `main` row while the session is
genuinely working (thinking/streaming/tool-running), settling at turn end — obeying BUG-030's
invariant (◐ only while a live process can be behind it) and never showing a fabricated duration
(BUG-033 point 5). If the deliberate design is "strip = subagents only", then the honest fix may
instead be that the crown state (FEAT-040) is the main-session indicator and the strip should
never show a main row at all — decide, justify, and make the two surfaces consistent.

## Verification (REQUIRED, user-observable)
Real browser + real cheap (haiku) session: during a genuinely long turn the main work is visibly
represented (strip row or the agreed surface) with an honest elapsed time; at turn end it settles;
a killed-mid-turn session settles honestly (no forever ◐ — BUG-033 lineage); subagent rows still
behave (BUG-020 backfill, BUG-030 settle). Must FAIL pre-fix. verify:ui offline + typecheck +
stale-agent-cards + reattach-agent-backfill.

## Activity log (APPEND-ONLY)
### 2026-08-09 — orchestrator
- Filed from live user report during the BUG-033 fix. Queued behind it (both hold app.js).

### 2026-08-09 — user observation (refines the symptom)
The main row **eventually appeared** during the same working session — so it is NOT absent, it is
DELAYED or conditionally triggered. That reframes the investigation: find the TRIGGER that makes
it render, and why it doesn't fire at turn start.

Leads to check (ground truth, not assumption):
- Does the row appear only once some OTHER event lands (first subagent `task_started`, the first
  `agent-*` event, a rail/poll tick, a reattach/`replayAgents`, or the 5s rail poll) rather than
  at the main turn's own start? i.e. the strip may only mount/render when the agents map becomes
  non-empty, with `main` synthesized as a side effect rather than emitted on its own.
- Is `main` emitted by the bridge at all at turn start, or is it a client-side synthetic row
  built during a later paint?
- Timing: measure the delay from send → row appearing on a real cheap session; a fixed ~N-second
  lag points at a poll, an event-shaped lag points at a missing emit at turn start.
Fix should make the main row appear AT turn start (or, per the ticket's alternative, decide the
crown owns main-state and remove the row entirely) — not "eventually".

### 2026-08-09 — orchestrator — ESCALATED: recurring class, root-cause redesign required (§N)
User: "the same bug of main, I'm pretty sure happens with any others — right now I see main
running but no subagents supposedly running, even though I assume you dispatched some; also this
was an issue already before, idk why it's having a hard time to resolve it."

**LIVE REPRO at time of writing:** three subagents were genuinely in flight (BUG-033 fix,
BUG-035 investigation, FEAT-052 README) and the strip showed NONE of them, while `main` showed
running. So the scope is not "the main row" — it is the whole strip's liveness.

**This is the 5th patch of the same subsystem** — BUG-004 (union-liveness), BUG-017 (live
self-owned session), BUG-020 (reattach backfill), BUG-030 (terminal-frame settle + cut sweeps),
BUG-033 (zombie busy). Per WA §N: a symptom fixed 3+ times means the DESIGN is wrong. No more
local patches.

**Root-cause hypothesis to test (not to assume):** there is no single authoritative answer to
"what is running right now". The client derives it from a union of: task_* event fragments it
happened to receive, `replayAgents()` on attach, mtime liveness, the live-bridge override, and
per-turn sweeps. Any dropped/missed/mis-ordered event, any attach that misses the window, or any
session whose events arrived while the tab was elsewhere → wrong render, in EITHER direction
(phantom rows = BUG-030; missing rows = this).

**Required approach when dispatched (top-tier model, §N):**
1. Establish the ground truth the SERVER already has (or can cheaply have): the live set of
   running agents/tool-calls per session, with start times — one authoritative structure.
2. Make the client a pure RENDERER of that snapshot (poll/push a full list, reconcile in place),
   instead of accumulating deltas it may have missed. Deltas may still drive smooth updates, but
   the snapshot must be the correcting authority — same shape that fixed BUG-027 for health.
3. Preserve the invariants already paid for: BUG-030 (◐ only with a live process), BUG-004
   (don't resurrect finished work), BUG-020 (reattach shows in-flight agents), BUG-033 (no
   zombie/fake timers).
4. Verification MUST include the exact live shape that fails today: dispatch 3 real subagents,
   observe the strip WITHOUT reloading, then WITH a reload mid-flight, then after a host cut —
   all three must be honest; and an adversarial pass hunting the next variant before the user does.

### 2026-08-09 — user observation (intermittency — verification implication)
"Sometimes they do appear, sometimes not." Confirms the race/fragment reading: correctness
depends on which events happened to arrive before the render (attach timing, tab focus, event
ordering), not on a stable source of truth. VERIFICATION IMPLICATION: a single green run proves
nothing — the repro must run N times (>=5) and/or with injected event drops + delayed attach, and
be green EVERY time. An intermittent bug that passes once is still broken.

### 2026-08-09 — post-restart evidence (client holds a picture the server denies)
After the BUG-033 deploy + server restart, the user's OPEN TAB still rendered running rows for a
killed agent's bash calls (`verify:zombie-busy`, timers 0:44-0:53 and counting) while the server
had no such state at all. A reload clears them — which is the whole indictment: client-side
accumulated state can outlive and contradict the server, in both directions, and only a manual
reload reconciles it. This is direct support for the snapshot-authority redesign: the strip must
render a server-authored running-set, and a reconnect/poll must be able to CORRECT (and empty) it
without a reload.

### 2026-08-10 — build agent — ARCH-001 PHASE 2: the strip renders a server-authored snapshot — FIXED & VERIFIED

**Charter.** BUG-034 built together with FEAT-057 (same structure answers "what runs" and "what
died"), on top of ARCH-001 phase 1's authority. Treated as a DESIGN change, not a sixth patch:
nothing new decides liveness anywhere — `src/server/liveness.ts` remains the only site that
answers it, and the regrowth guard (R-D) was re-run to prove no new check appeared.

#### 1. WHAT THE OLD DESIGN ACTUALLY WAS (the thing being replaced)

The strip DERIVED liveness client-side from a union of: `agent-*` event fragments it happened to
receive, `replayAgents()` on attach, `state.busy`, the mtime live list, a live-bridge override and
two client-side sweeps (`settleCutAgents`, `scheduleCutSweep`). Every input is lossy, so the answer
was wrong in BOTH directions and depended on when you looked — three dispatched subagents showing
as none; a tab that lived through a restart still counting a killed agent's timers to 0:53.

#### 2. THE SNAPSHOT CONTRACT (`src/server/running-set.ts`, new)

```
RunningSnapshot { v:1, at, stationSessionId, sdkSessionId,
                  turn:{running, since, state, kind, reason},
                  running:[ {id,row:'main'|'agent'|'tool',label,description,
                             startedAt,lastTool,toolUses,totalTokens} ],
                  ended:[ AgentOutcome… ],           // FEAT-057, same structure
                  source:'bridge'|'no-session' }
```
- **Derived from the authority, never beside it.** `snapshotOfSession()` calls `livenessOfBridge`
  and arranges the result; it implements no rung. Two gates, and only two: `!v.live` ⇒ `running`
  is EMPTY (a verdict the authority withdrew cannot leave rows standing — this is what lets the
  snapshot empty a client), and the `main` row exists iff `v.running` (the VERDICT, never the raw
  `busy` claim, which is BUG-033's zombie).
- **Honest times only.** `startedAt` / `turn.since` are the server's own (`turnStartedAt`, the
  frame the agent started on). `null` = not knowable and the client renders `—`.
- **EMPTY IS AN ANSWER.** `GET /api/sessions/:id/running` for a session this server does not drive
  answers 200 with an empty snapshot (`source:'no-session'`), never 404 — a client that cannot tell
  "no session" from "route failed" is how phantom rows survive.
- **Transport:** pushed as a new `running-snapshot` StationEvent whenever the answer CHANGES (turn
  start, agent start/progress/terminal, turn end, close/reap — forced at turn boundaries and at the
  reattach handshake, suppressed when identical), AND pollable on the route above. Deltas still
  flow and still drive threads/"ran" rows; they no longer decide what is alive.

#### 3. THE CLIENT IS NOW A RENDERER (`public/app.js`)

`state.snap` is the only input to `renderStrip()` (`stripModel()` maps it 1:1). `state.agents` is
still fed by `agent-*` (threads, "ran" rows, BUG-030's cut captions) but no longer decides anything
on the strip. The 1s ticker advances CLOCKS only — it can no longer add, revive or keep a row.
A 4s poll (`pollRunning`, plus an immediate poll at boot and on `visibilitychange`) is the
correcting backstop for anything push cannot guarantee.
- **BUG-030** preserved and strengthened: ◐ appears only for rows the SERVER vouches for right now.
- **BUG-020** preserved: the reattach handshake pushes a snapshot next to `replayAgents()` (15/15).
- **BUG-004** preserved: nothing on the strip reads history.
- **BUG-033** preserved: `—` wherever the start is unknown; this tab never stamps a start it did
  not observe. `turnClock()` was DELETED — its rule now lives in `rowElapsed()` over server times.

**MAIN ROW — DECIDED: the strip KEEPS a `main` row.** It is authored by the same snapshot as every
other row (`turn.running`/`turn.since`). Reasons: the strip answers "what work is in flight" and
the orchestrator's own turn IS work in flight; removing it would leave the original report ("should
be main (you)") unanswered and make the strip silent during the commonest case of all — a turn with
no subagents. The crown (FEAT-040 `#sessStatus`) keeps owning session STATE
(thinking/streaming/detached/reconnecting/idle), which is a different question. Consistency is by
construction, not by convention: `applySnapshot()` repaints the crown from the same answer, so if
the snapshot says no turn is running the strip has no main row AND the crown cannot say "Thinking…".

**One case the old design never had an honest answer for, decided here (§C):** when the SERVER
becomes unreachable (socket dropped / poll fails), the rows are neither deleted nor left claiming
◐ — deleting asserts the work stopped (false: a detached turn survives, BUG-018/020), and ◐ asserts
it is running (unprovable). They FREEZE at the last known elapsed, lose the ◐, and the summary says
`N agents — unverified, the server is unreachable (as of M:SS)`.

#### 4. VERIFICATION — the bar was ">=5 runs with injected drops + delayed attach, green EVERY time"

NEW `scripts/verify-running-snapshot.mjs` (real server, real bridge, real browser; engine = the
schema-validated fake `codex app-server` fixture, so the agent count is a parameter and there is no
API cost). Event drops are REAL: a `WebSocket` wrapper installed before app.js loads deletes frames
per run — `snapshot` (every `running-snapshot` push dropped, so only the poll can save it),
`agents` (every `agent-*` delta dropped), `random` (a seeded 60% of both). Attach delay varies
0/800/1200/2500/4000ms. Per run: main+3 subagents visible with NO reload → across a MID-FLIGHT
RELOAD → after a HOST CUT (engine SIGKILLed) the strip empties, rows AND summary.

| run | drops | delay | result |
|---|---|---|---|
| 1 | snapshot | 0ms | 9/9 |
| 2 | agents | 1200ms | 10/10 |
| 3 | random | 2500ms | 9/9 |
| 4 | snapshot | 4000ms | 9/9 |
| 5 | agents | 800ms | 10/10 |

**`--runs=5` → 47/47, twice consecutively.** Load-bearing detail: in the `agents` runs the client's
own `state.agents` is EMPTY (0 accumulated) while the strip correctly shows 4 rows — the strip is
provably not rendering accumulated events any more.

**PRE-CHANGE (same script, HEAD in a clean `git worktree`, only the script + fixture copied in):
7/19 — the bug reproduces exactly.** The server has no snapshot route at all (`observed: null`);
with the agent deltas dropped the strip shows ONLY `main` and the three dispatched subagents are
invisible (BUG-034's verbatim symptom); the reload does not recover them; after the host cut the
strip still claims `0 agents running · 1:26` in its summary.

**LIVE (real haiku session, real Task subagents, `--live`) — 4/4:**
three genuinely dispatched subagents visible in the strip with no reload; the strip's ids equal the
server snapshot's ids exactly; still correct across a mid-flight reload **with no re-send** (the
poll alone reconciles it — the old design needed the user to type something to force a reattach);
after the server is cut nothing keeps claiming ◐ (rows freeze, summary says "unverified").

**Anti-regressions** (scratch ports/dataDirs, killed by pid, `:4317` never touched):

| verify | result |
|---|---|
| `typecheck` | PASS |
| `verify:liveness-conformance` | **96/96** (incl. the R-D regrowth guard: clean) |
| `verify:stale-agent-cards` (BUG-030) | **12/12** — see the note below |
| `verify:reattach-agent-backfill` (BUG-020) | **15/15** |
| `verify:agent-summary` (BUG-004) | 3/3 |
| `verify:reload-live-summary` (BUG-004/017) | 10/10 |
| `verify:zombie-busy` (BUG-033) | 35/39 — **A–D 34/34**, E 4/4 red, byte-identical to the documented pre-existing state |
| `verify:refusal-visible` (BUG-038) | 16/16 |
| `verify:tickets` (FEAT-058) | 30/30 |
| `verify:agent-outcomes` (FEAT-057, new) | 26/26 |

- `verify:ui --offline` NOT run: known RED at HEAD (BUG-036, parallel lane) — not chased, not edited.
- **One assertion in `verify-stale-agent-cards.mjs` was rewritten, and it was a real behaviour
  change, not a test fudge.** Its PRECONDITION asserted "the cut call is STILL on screen at the
  moment of the cut". It now fails, because the shutting-down server PUSHES its final (empty)
  snapshot as it closes the session, so the tab has already corrected itself at the cut. That is
  strictly stronger than settling the rows afterwards. The check now accepts either shape and still
  requires that nothing spins unbacked; every downstream assertion (no ◐ after cut+resume, the
  "Cut by shutdown" caption, the live case intact, zero in-flight at rest) is untouched and green.
- `verify:reattach-agent-backfill` failed its first run at a REAL-CLI precondition ("sub-agents
  never started" — the haiku turn did not spawn them within 90s) and was 15/15 run alone; the
  failure is model behaviour on a documented-flaky harness, not an assertion about this change.

#### Closing assessment

**Symptom of a deeper design flaw? — YES, and this ticket is phase 2 of the answer (ARCH-001).**
The five prior patches were all correct locally and all insufficient, because they improved an
arithmetic that had no right to exist: the client cannot answer "what is running" and every attempt
to make it answer better just moved the failure. What changed is WHO ANSWERS. The residual risks I
would flag rather than paper over:
1. **The poll interval is the correction latency.** 4s is a deliberate trade; a dropped push is
   invisible for up to that long. If that ever matters, the fix is a sequence number on the
   snapshot and a re-request on a gap — not a shorter interval.
2. **`state.agents` still exists** and still drives threads and "ran" rows. It is no longer a
   liveness authority, but it is the same kind of accumulated structure, and a future change that
   quietly renders it on the strip again would re-open this class. There is no mechanical guard for
   that on the client side — the server-side regrowth guard has no client equivalent. That is the
   honest gap: if this recurs, the next step is extending the R-D guard to `public/`.
3. **The unreachable-server state is new surface.** It is honest today (freeze + "unverified"), but
   it is a third state the UI must keep getting right, and nothing tests it except one live check.

**Handoff:** none — fixed and verified. Shares `src/server/index.ts` / `public/app.js` with
in-flight FEAT-058/BUG-036 work; serialize commits. Nothing was committed by this agent.
`package.json` NOT edited — the two new entries to add are reported in FEAT-057's entry.
