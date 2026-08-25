# BUG-033 — zombie `busy` bridge: session shows "Running" forever, messages queue into a black hole

- **Status:** VERIFIED (2026-08-09 — fix agent; real-shape repro proven to FAIL pre-fix 5/14 + 2/8, PASS 34/34 post-fix incl. the false-positive guard)
- **Area:** server (agent-bridge liveness) + UI (live-bridge override) — state honesty
- **Reported:** 2026-08-09 by user, with a detailed independent diagnosis (kitty session)

## Symptom (observed live, 3 days stale)
Opening this project's own session showed `main … Running · 1:08 ◐` while nothing was running.
Messages could be typed but never sent — they silently entered the queue and never drained.

## Root cause (diagnosed; re-verify before fixing)
- `AgentSession.busy` (`src/server/agent-bridge.ts` ~:370) is a plain in-memory bool: set on turn
  start (~:813), cleared ONLY when the runtime stream yields `result` (~:1543) or the stream
  terminates/throws (~:1392, ~:1411). **No PID check, no watchdog, no reaper on this path.** The
  CLI's stream half-died (agents killed mid-turn) without ending → `busy` stuck true for the
  server process's lifetime (server had been up 3 days).
- The mtime liveness (`watcher.ts` ~:290, 30s window) correctly said "dead", but `app.js`
  (~:4159-4165) deliberately lets a live bridge OVERRIDE stale mtime (the BUG-004 fix: "a bridge
  means it's running server-side, just idle on disk") → the zombie bridge wins the vote.
- `openSession()` (`app.js` ~:3092) does `if (liveRec.busy !== false) setBusy(true)` and stamps a
  fresh `turnStartedAt` → the "1:08" is how long the TAB believed it, not turn age (dishonest timer).
- Send path: reattach finds the zombie bridge; `index.ts` (~:2127-2132) sees `busy === true` and
  **silently discards the prompt** with only a status line ("deliver at the next pause"); client
  queues it. Queue drains only on a busy→false transition (`flushQueue` from `app.js` ~:4716)
  which can never arrive. `forceSend()` → `{type:'interrupt'}` against a dead stream: also never.

## Fix direction (all four; 3 is the keystone)
1. **Liveness gate before reattach** (`index.ts` ~:2082): verify the runtime's child/stream is
   genuinely alive (pid check / broker status) before treating a bridge as live; drop it if not.
2. **Bound `busy` by time**: track `lastFrameAt` on AgentSession (any inbound runtime frame);
   `busy` reported as false — or the bridge reaped outright — past a threshold with NO frames
   (pick a defensible window; a long legitimate tool call still emits frames, justify in ticket).
3. **Reaper**: periodic sweep that drops bridges whose child is dead / frameless past the window,
   emitting an honest event so the UI settles (pairs with BUG-030's ◐ invariant: nothing may
   render running without a live process behind it).
4. **Refuse, don't swallow** (`index.ts` ~:2127-2132): when the server cannot verify a turn is
   genuinely mid-flight, REFUSE the prompt (retryable, BUG-029 rollback path — user keeps their
   text) instead of accept-and-status. A silent swallow is what makes the queue a black hole.
5. Client: don't stamp a fresh `turnStartedAt` on reattach from a bridge whose turn start is
   unknown — show honest "unknown duration" rather than a fake timer.

## Verification (REQUIRED, non-vacuous)
Scratch server + a session driven to busy, then KILL the CLI child so the stream half-dies without
a terminal frame (the real shape): (a) within the window the UI settles to idle/error honestly,
(b) a sent message is delivered or honestly refused — never silently queued forever, (c) the queue
drains or the user gets their text back, (d) a LEGITIMATE long-running turn (real slow tool call,
frames flowing) is NOT reaped — the false-positive guard, prove it. Must FAIL pre-fix (reproduce
the stuck busy). Anti-regressions: BUG-004 (reload-live-summary, agent-summary), BUG-018 detach,
BUG-030 stale-agent-cards, restart-survives 15/15, health-survivor, ui offline, typecheck.

## Activity log (APPEND-ONLY)
### 2026-08-09 — orchestrator
- Filed from the user's report + an independent diagnosis they had run. Same class as BUG-024/027/
  030/031: a state asserted without ground truth. Dispatching fix+verify.

### 2026-08-09 — fix agent — ROOT CAUSE CONFIRMED + FIX — VERIFIED

**The inherited diagnosis, checked line by line against the code (not taken on trust).**

CONFIRMED, every claim:
- `AgentSession.busy` is a plain in-memory bool (`agent-bridge.ts:370`), set at turn start
  (`:769` start / `:813` send) and cleared ONLY on `result` (`:1543`), normal stream end (`:1392`)
  or a stream throw (`:1410`). No pid check, no watchdog, no reaper anywhere on that path — the
  only other clearing site is `close()` (`:1157`).
- mtime liveness is `LIVE_WINDOW_MS = 30_000` (`watcher.ts:276`, used by `liveSessions` `:290`),
  and `app.js:4159-4165` (`liveRecordFor`) deliberately lets a live BRIDGE override a stale mtime
  — the BUG-004 fix. So the zombie bridge wins the vote, exactly as diagnosed.
- `openSession` `app.js:3092` `if (liveRec.busy !== false) setBusy(true)`, and `setBusy` stamped
  `state.turnStartedAt = state.turnStartedAt || Date.now()` — the "1:08" was the TAB's own age.
- Send path `index.ts:2127-2132`: `if (running.busy)` → a `status` line only, prompt DISCARDED;
  the client's reattach-ack handler (`app.js:4872-4882`) pulls the bubble and `queueMessage`s it;
  `flushQueue` runs only off a busy→false transition (`setBusy`, `app.js:4716`) that can never
  arrive. Black hole confirmed.

CORRECTED / ADDED (the part the diagnosis could not see without running it):
- **The mechanism was reproduced live, not assumed.** Scratch server + real haiku turn holding a
  300s Bash call; `SIGKILL` the CLI pid from the broker's own status file. Result: `busy:true`,
  `liveBridges:1`, `state:"detached-running"` for 60s+ with NO `error`, NO `turn-end`, NO
  `session-closed`; a follow-up `send` answered `"a turn is already running — interrupt it first"`.
  That is the reported incident exactly, in 90 seconds.
- **Where the stream actually half-dies:** `survival.ts` `s.pipe(stdout, { end: false })` +
  `emitExit` — the broker exits and removes its own status/sock files (`session-host.mjs`
  `shutdown()`, BUG-023), the facade settles an exit, and yet the SDK's `messages()` iterator
  never returns, so `#run()`'s teardown (`:1392`/`:1410`) is never reached. The transport was NOT
  changed here: `FEAT-015` survival is 15/15-verified and the session-level reaper covers ALL
  isolations/runtimes (container + Codex included), not just this one transport.
- **Diagnosis point 2 as literally written would have been a regression.** "report busy false past
  a threshold with no frames" would reap a legitimate long silent tool call. Inverted: ground truth
  FIRST, timer only where no ground truth exists (see the window rationale below).

**The chosen frameless window: 10 minutes, `CLAUDE_STATION_FRAMELESS_MS` (sweep interval
`CLAUDE_STATION_REAP_SWEEP_MS`, default 10s). Why, and why it is almost never the deciding
signal.** A running turn is chatty by construction — token deltas, `tool-call`, `tool_progress`,
`tool_result`, subagent task frames — so the only legitimately silent stretch is the inside of ONE
long tool call on an engine that emits no progress (a test suite, a build, a sleep). 10 min is
comfortably past that class while being nothing like "the rest of the server's life", which is what
the window used to be. Erring long is deliberate: reaping a live turn is strictly worse than a few
extra stale minutes. Crucially the timer is the LAST rung: a session whose CLI pid is verified
alive is never reaped by it, however quiet (proven — scenario B below shrinks the window to 8s and
the turn survives 30 sweeps of a 27s silence and then completes normally). `<= 0` disables the
timer half, leaving the ground-truth half armed.

**Fix map.**
- `src/server/survival.ts:97` — `SurvivalProbe` + `SurvivalHandle.probe()` (`:117` declared, `:362` implemented):
  GROUND TRUTH in rungs — transport exit latch → status file absent AFTER a successful connect
  (the broker deletes it on the way out, so absence IS proof) → broker's own `state:'exited'` →
  live-pid checks on broker + CLI pids. `'unknown'` is a first-class answer, never coerced.
- `src/server/agent-bridge.ts:380/387` — `turnStartedAt` (honest turn clock, null when idle) and
  `lastFrameAt`; stamped at both busy-true sites (`:787-788` start, `:834-835` send), cleared at all
  four busy-false sites (`:812`, `:1262`, `:1498`, `:1517`, `:1658`); `lastFrameAt` stamped in
  `#handle()` (`:1538`) before any early return, so it counts every
  frame kind.
- `src/server/agent-bridge.ts:1174` `processProbe()`, `:1204` `livenessVerdict()` (the ordering that
  makes the fix safe: dead-process → reap now; alive → LIVE regardless of silence; unknown →
  frameless backstop), `:1231` `reapAsZombie()` (emits the honest fatal event FIRST, then `close()`, because
  `close()` awaits `#pump` and a half-dead pump may never settle; the synchronous
  `sessions.delete` is what makes the UI settle).
- `src/server/agent-bridge.ts:1951` `FRAMELESS_MS` / `:1952` `REAP_SWEEP_MS`, `:1961` `sweepZombieSessions()`
  (exported so verification can drive it deterministically), `:1978` `startZombieReaper()` (unref'd).
- `src/server/index.ts:2533` — reaper armed at boot, with its window logged.
- `src/server/index.ts:2113-2150` — **liveness gate before reattach**, with the disposition split
  that makes the refusal principled: `dead-process` (PROVEN dead) → drop the corpse and fall
  through to ordinary resume-from-disk, so the user's prompt starts a REAL turn instead of
  vanishing; `frameless` (`:2137`; silence, not proof) → drop the bridge but REFUSE the prompt
  `retryable:true` BEFORE any `ack:start`, so BUG-029's `rollBackPendingStart` hands the text back
  to the composer — refusing to race a second CLI onto a transcript we cannot prove is finished
  (BUG-022). The old "deliver at the next pause" branch (`:2212`) now runs only for a bridge whose
  liveness was just re-verified, and names the evidence in its own status line.
- `src/server/index.ts:259, 269-272` (`/api/health`), `:1040` (`/api/sessions/live`), `:1056`
  (`/api/sessions`) — `turnStartedAt`,
  `lastFrameAt`, `processAlive`, `liveness{live,kind,reason}` so health/doctor/UI cannot disagree.
- `public/app.js` — `state.turnStartUnknown` (`:69`), `turnClock()` (`:3527`) rendering
  `—` instead of a fabricated stopwatch, `setBusy` no longer stamps when the start is unknown
  (`:4747`), `openSession` (`:3106`) and the reattach ack (`:4929`) adopt the SERVER's
  `turnStartedAt`, `liveRecordFor` carries it through (`:4210`). Also: `renderStrip` now
  EMPTIES the strip when nothing runs instead of only hiding it — a hidden `◐ main · 3:07` row is
  still a running claim living in the document.
- `public/lib/api.js:467, 491` — `turnStartedAt` carried on both live routes, `null` on an
  older server (never defaulted to "now").

**Verification — `scripts/verify-zombie-busy.mjs` (new; package.json entry NOT added, see below).**
Real shape throughout: real haiku sessions on scratch servers (free ports, scratch dataDirs; :4317
and the real unit never touched), the CLI child KILLED BY PID mid-turn so the stream half-dies with
no terminal frame. No internal setter is ever called to fake `busy`.
- **A — ground truth + the user-visible path (brave/playwright DOM): 14/14.** UI settles honestly
  **2.7s** after the kill (no forever-◐, and far inside the 600s window, so it was ground truth and
  not the timer); the reattached tab's clock is the turn's REAL age (drift 0ms vs the server, not a
  reopen stopwatch); `/api/health` and `npm run doctor` agree; the reap is announced in the log; the
  message typed afterwards is **DELIVERED for real** (reply rendered, composer empty, queue empty).
- **B — FALSE-POSITIVE GUARD: 5/5.** Frameless window deliberately shrunk to 8s; a genuinely
  running turn sits SILENT inside one long tool call for 27s+ (measured from `lastFrameAt`) across
  30 sweeps and is NOT reaped — health says why (`processAlive:"alive"`) — then the turn COMPLETES
  normally with its marker, and a following streaming turn (50 frames) also completes untouched.
  This is the check that keeps the fix from being worse than the bug.
- **C — SDK-owned child (no pid knowable, `CLAUDE_STATION_SURVIVE=0`): 7/7.** Probe honestly says
  `unknown`; after the kill the UI still settles and the typed message is delivered, never queued.
- **D — the timer backstop + honest refusal: 8/8.** Built on the existing CodexRuntime fixture seam
  (`CLAUDE_STATION_CODEX_BIN` → the fake app-server's documented `HANG` turn): a real bridge whose
  stream WEDGES rather than dies, with no pid to check. Periodic sweep DISABLED so the refusal
  cannot be a background-timer artifact. Inside the window it is still judged live; past it health
  reports `liveness.kind:"frameless"`, and a message riding in is REFUSED `retryable:true,
  fatal:false` **before any start ack** (asserted) — never swallowed, never raced onto the
  transcript.
- **MUST-FAIL control (fix hunks stashed, same scripts):** A **5/14**, D **2/8** — the incident
  reproduced exactly: UI stuck ◐ for the full 90s poll, `turnStartedAt:0` with the tab's clock
  drifting a full epoch (the fake stamp), `/api/health` still reporting `detached-running`, and the
  typed message parked undelivered in the queue.
- Screenshots: `docs/bugs/assets/BUG-033-live-before-kill.png`, `BUG-033-settled-after-kill.png`,
  `BUG-033-message-delivered.png`, `BUG-033-refusal-keeps-message.png`.

**Anti-regressions.** `verify:detach` 7/7 · `verify:reload-live-summary` 10/10 (BUG-004 lineage) ·
`verify:agent-summary` 3/3 · `verify:restart-survives` **15/15** · `verify:health-survivor` 14/14 ·
`verify:stale-agent-cards` (BUG-030) 12/12 · `typecheck` clean.
Two PRE-EXISTING failures, each confirmed identical with my hunks stashed (NOT regressions):
`verify:ui --offline` crashes before any check — that is **BUG-036**, already filed and open; and
`verify:resume-refusal` 4/5, the "phantom optimistic bubble rolled back" check (`you-count
before=20 after=33`, byte-identical at baseline) — the message-kept, composer-released and
retryable-recognised halves all PASS, so BUG-029's contract itself is intact.

**package.json entry — reported, not edited by me (per instruction); the orchestrator added it in
the commit below:** `"verify:zombie-busy": "node scripts/verify-zombie-busy.mjs"` (scenario selectable:
`node scripts/verify-zombie-busy.mjs A|B|C|D`; full run ≈ 12 min, needs brave + `@playwright/test`).

**Go-live note.** Server + client. On :4317 it takes effect at the next deliberate deploy restart
(never mid-flight). The user's currently-wedged session, if any survives to then, is dropped
honestly at boot instead of showing ◐ forever.

**Post-cut note (same day).** This agent was cut mid-run by a host process exit; the work was
already in the tree and the orchestrator committed it as `72de912` (which also added the
package.json entry and the INDEX row). Nothing was lost, no stash was left outstanding, and the
scratch probe used to find the mechanism (`scripts/.b33-probe.mjs`) was deleted. The line
references in this entry were re-checked against the committed files afterwards and corrected.

**Handoff:** none for this symptom. Shares `agent-bridge.ts`/`index.ts`/`app.js` with the BUG-018/
020/029/030 lineage — serialize commits with anything else in flight on those files. Not committed
(per repo convention); orchestrator reviews the diff + this evidence.
