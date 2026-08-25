# FEAT-065 — deliver queued messages INTO the drain-held survivor (BUG-048 increment 2, "(c+)")

- **Status:** VERIFIED 2026-08-11 — verify:feat-065-delivery 35/35 (pre-fix FAIL proven: 11/35 — the message waited the WHOLE drain, zero frames reached the engine); all anti-regressions green. Needs a later DEPLOY — not deployed.
- **Area:** session-host broker stdin delivery + index resume path + BUG-045 client loop
- **Reported:** 2026-08-11, from BUG-048's explore (3f1da4e) + five live probes (50abb40): GO

## What lands
After a restart, a message for a session whose survivor is drain-held (foreground idle, background
work live) is DELIVERED by writing one SDK stream-json user frame into the survivor's held-open
stdin — a normal turn in the SAME CLI pid (probe 3: proven live, single writer preserved). The
user's wait collapses from "whole drain" to "next boundary". This is the input half of full
re-adopt (direction (a)) — a real increment toward it.

## Mandatory constraints (each probe-backed, none optional)
1. **commitDrain midTurn gate** must be in place first (FEAT-064; probes showed the survivor also
   runs AUTONOMOUS turns at background completion — the EOF hazard is live today).
2. **Permission handling in the same increment** (probe 4: an unanswered control_request hangs
   forever and wedges the drain): minimal broker stdio control_response relay (proven viable with
   one frame) routed to the dashboard's approval flow where possible; bounded deny-with-notice
   fallback; or gate delivery on the session's permission mode. The survivor runs with
   --permission-prompt-tool stdio (probe note).
3. **Exactly-once via the BUG-045 loop** (probe 5): delivery MUST ride the client's retry `start`
   — server injects then ACKs that start within the 15s ghost-release window; never out-of-band,
   or the client re-delivers.
4. The injected turn's output must reach the user: the station file-follows the transcript
   already; make sure the session view renders the injected turn live or on next open (say which).

## Verification (§C, real-shape)
Restart with foreground-idle + live background heartbeat survivor → send → message reaches the
model WITHOUT waiting for background completion (delivered into the survivor pid — transcript
proves same-pid write, no second claude spawned), reply visible, background completes, exactly
one delivery (client + on-disk + engine input log), permission-raising injected turn either
round-trips an approval or takes the bounded fallback (both proven). Anti-regressions:
verify:restart-reconnect-race (the invariant this must NOT relax), resume-refusal,
refusal-visible, bug-044-restart-background, restart-survives, hosts-cleanup, queue, ui,
typecheck, plus FEAT-064's suite.

## Activity log (APPEND-ONLY)
### 2026-08-11 — orchestrator
- Filed from the explore + probes; queued behind FEAT-064 (shared files: session-host.mjs,
  index.ts, app.js drain-wait code). Full re-adopt (a) remains the horizon ticket after this.

### 2026-08-11 — FIX + verification (fix agent, in-place on main)
- **THE FIX — the (c+) delivery, all four mandatory constraints honoured:**
  - `src/server/session-host.mjs` — `writeStatus` now also publishes **`midTurn`** (the
    delivery gate's foreground-idle evidence), refreshed on every turn-BOUNDARY transition
    (one write at turn open, one at close — never per-frame), so the reader's copy is at most
    one boundary old instead of up to a whole drain-recheck stale. No lifecycle change; the
    FEAT-064 commitDrain midTurn gate (constraint 1) is untouched and is what makes injection
    safe against the EOF (proven again below: EOF landed with the turn CLOSED in every run).
  - `src/server/survival.ts` — `HostStatus.midTurn?: boolean` (older brokers lack it; an
    ABSENT value is treated as "not provably idle" — never injected).
  - `src/server/survivor-delivery.ts` (NEW) — the delivery: connect to the survivor's broker
    socket (client-free post-restart; a 120ms accept-settle beat converts the broker's
    single-client destroy into a clean fallback-to-refusal instead of a silently lost frame),
    write ONE SDK stream-json user frame into the held-open stdin (probe 3's exact shape — a
    normal turn in the SAME CLI pid, single writer preserved), then stay attached to sniff the
    relayed stdout for `control_request` and the turn's `result`. **Constraint 2 (permissions,
    BOTH arms):** `can_use_tool` is relayed to the dashboard as the ORDINARY
    `approval-request` card over the ws that sent the start (answered via the existing
    `approval-response` command; same ack contract, so the card settles identically), and
    BOUNDED: unanswered for `CLAUDE_STATION_DELIVERY_APPROVAL_MS` (default 30s — deliberately
    inside FEAT-064's 90s midTurn commit bound, so an ignored approval can never push the
    drain into the bounded-truncation window) → deny with an honest notice
    (`permission-denied` to the client); no client attached → immediate deny-with-notice.
    Other control subtypes get an error response rather than a hang. On `result`:
    `survivor-delivery turn-done` to the client, socket closed, registry slot freed.
    One delivery per session at a time (`active` map); every establishment failure falls back
    to the ordinary retryable refusal — the message stays queued, never lost, never doubled.
    Kill-switch: `CLAUDE_STATION_SURVIVOR_DELIVERY=0` restores pure queue-and-wait.
  - `src/server/index.ts` — the BUG-022/038 refusal site now delivers-or-refuses.
    **Deliverable** iff: kill-switch off, prompt non-empty, `state==='draining'`,
    **`midTurn === false`** (a mid-FOREGROUND-drain survivor keeps today's queue-and-wait,
    per the spec), **`backgroundLifetime === 'yes'`**, and no delivery already in flight.
    **`unknown` = do NOT inject, wait** (ARCH-002): an unknown-held drain can commit at any
    moment (an empty level frame or the bounded window expiry flips it to 'no'), so an
    injected turn would RACE the stdin-EOF commit decision; with 'yes' the broker provably
    holds while the tasks live and the midTurn gate covers the injected turn. The unknown
    window is short (bounded, default 120s) so the wait is small anyway. **Constraint 3
    (exactly-once):** the injection rides THIS `start` and is ACKED to it
    (`{of:'start', deliveredVia:'survivor'}`) — never out-of-band — measured ack latency
    150ms, far inside the 15s ghost-release window; BUG-045's `settleDrainWaitDelivery`
    retires the row with zero changes to the client's exactly-once logic. `approval-response`
    with no session routes to the socket's delivery relay; ws close / explicit `close`
    detaches the relay (pending approvals then take the bounded deny). `/api/health` broker
    rows carry `midTurn`.
  - `src/server/events.ts` — new `survivor-delivery` (phase `turn-done`) event.
  - `public/app.js` — on the `deliveredVia:'survivor'` ack: retire the drain-wait row
    (exactly-once), remove the optimistic bubble (the transcript follow re-renders the real
    one), keep the socket open ONLY as the approval relay (`state.deliveryRelay`), re-arm the
    follow. **Constraint 4 — the injected turn renders LIVE**: the watch socket's existing
    transcript file-follow streams the user message + reply into the open session view as
    they land (proven in S5: reply visible in the DOM while the drain was still held) — not
    merely on next open. Guardrails: `flushQueue` and the composer never treat the relay as a
    session (a new message closes it and goes back through the start gate); `turn-done`
    closes the relay deliberately (routine close — never the "connection dropped" scare);
    relay state dies with its socket.
  - `scripts/verify-feat-065-delivery.mjs` (new) + package.json `verify:feat-065-delivery`.
  - `scripts/verify-feat-064-drain-truth.mjs` — one-line adaptation: its S3 plants exactly a
    DELIVERABLE survivor to verify the refusal truth surface, so it now pins
    `CLAUDE_STATION_SURVIVOR_DELIVERY=0` (the supported operator path); the refusal surface
    it verifies still fronts every non-deliverable hold. Without the pin it failed 13/18 —
    by DELIVERING, i.e. the feature working.
- **Verification (§C — scratch ports/dataDirs, real seed haiku session + real session-host
  brokers with a stream-json fake CLI that appends to the REAL transcript, kill by pid,
  :4317 untouched).**
  - **Pre-fix at HEAD (src+public stashed): FAILED as required — 11/35.** The load-bearing
    signature is the ticket's "today": every start refused retryably, ZERO user frames ever
    reached the engine, and S5's live app.js run shows the message queued behind the chip for
    50+ seconds of a held drain with zero deliveries ("waits the whole drain"). No approval
    relay exists at HEAD (S2/S3 all fail); `midTurn` absent from heartbeats.
  - **Post-fix: 35/35.** S1 (raw WS, restart-shaped: real seed session, planted REAL broker
    declaring the seed sdk id + live bg task, SIGTERM = boot re-adopt, drain HELD):
    `deliveredVia:'survivor'` ack in **150ms**; message + `ECHO` reply in the transcript
    WHILE the broker still `draining` with `backgroundLive:1` (no waiting for background
    completion); ENGINE input log exactly **1** user frame (the survivor's own stdin — same
    pid); store exactly **1** user line; **no `--resume <id>` process ever existed** (/proc
    scan at ack and after); `turn-done` reported; then the bg level emptied → drain committed
    and reaped cleanly with **EOF landing turn-CLOSED** (injection never fought commitDrain).
    S2 (arm A): the injected turn's `can_use_tool` rendered as the ordinary approval card,
    allow round-tripped (`matched:true` → control_response allow → `APPROVED-RAN` in the
    transcript). S3 (arm B): deliberately unanswered → bounded deny at **~2.97s** (3s knob)
    with the honest notice, client told via `permission-denied`, turn COMPLETED (drain never
    wedged), clean reap. S4: survivor with the foreground turn OPEN (`midTurn:true`
    published) → retryable refusal, ZERO injected frames. S5 (real app.js, the BUG-045
    integration): lifetime `unknown` → refusal + chip + ZERO frames (unknown honoured);
    the CLI's level frame landed → the client's OWN 7s retry start was delivered
    (**7.2s**, one boundary — not the whole drain), chip retired on the ack, reply rendered
    LIVE via the follow, exactly-once at all three levels (DOM 1 / store 1 / engine 1),
    relay closed routinely (`dropped:false`), clean reap after bg completion.
  - **Anti-regressions: ALL GREEN.** verify:restart-reconnect-race **10/10** (the invariant
    NOT relaxed — still no second CLI, transcript uncorrupted); resume-refusal **13/13**;
    refusal-visible **19/19**; bug-044-restart-background **15/15**; restart-survives
    **15/15**; hosts-cleanup **17/17**; queue **14/14**; ui **7/7**;
    feat-064-drain-truth **18/18** (after the kill-switch pin above); typecheck clean;
    leak-gate PASS (0 hits / 305 files).
- **Operational note: needs a later DEPLOY (service restart) to reach the running service —
  NOT deployed here.** Until then the live service keeps FEAT-064 behaviour (queue-and-wait
  with the truth chip). The env knobs ship inert defaults; no config change needed.
- **Residuals, named:** (a) a `control_request` raised AFTER the relay ws closed AND after
  delivery teardown (broker socket gone mid-turn) has no responder — the turn then rides
  FEAT-064's bounded midTurn commit window (the declared 90s truncation posture), same as any
  result-less turn; observed never in verification (the delivery holds its broker socket for
  the turn's whole life). (b) A theoretical loss window exists between the frame write
  succeeding locally and the broker relaying it if the socket dies in that same tick — the
  ack would still retire the row; comparable to a normal live send's semantics, and the
  120ms accept-settle beat closes the one systematic cause (single-client destroy).
  (c) Delivery requires the broker to have published `midTurn` — a survivor from a
  PRE-FEAT-065 broker (deployed-old code) is never injected, only refused as today: honest
  degradation, not a gap. (d) `unknown` lifetime still waits by design (rationale above);
  if the dispatch-window wait proves annoying in practice the horizon remains BUG-048
  direction (a). (e) The injected turn renders live only while the session view is open
  (the follow is per-view); a closed view shows it on next open — the store is the durable
  record either way.

### 2026-08-12 — orchestrator (flake note, no action)
- Post-BUG-074-deploy smoke: S5 (live DOM render / exactly-once) FAILED once, then 35/35 on an
  immediate re-run — browser-timing flake, same class as BUG-069's ratchet flake. If S5 flakes
  again, file it properly (BUG-036/039 family: a coin-flip check protects nothing).
