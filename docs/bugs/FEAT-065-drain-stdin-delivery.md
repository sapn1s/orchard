```orchard-ticket
{
  "id": "FEAT-065",
  "type": "feature",
  "title": "Messages sent after a restart waited for background work to finish",
  "summary": "After a restart, a message typed into a session whose foreground was idle but whose background work was still running sat unsent until that background work ended. It is now handed straight to the already-running session, so the wait ends at the next turn boundary. Approval prompts on the injected turn are handled in the same path.",
  "impact_if_we_wait": "The change is proven but not yet live, so people sending into a restarted session still wait out the whole background run. Bounded: messages are held, not lost, and no other session or stored data is affected.",
  "current_need": "Deploy the built change so the shortened wait reaches people; the pre-fix case failed and the corrected behaviour passed with standing checks clean.",
  "severity": "medium",
  "area": "Message delivery after restart",
  "reported": "2026-08-11",
  "reported_by": "agent",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-12",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A message reaches the model without waiting for background work to complete",
    "Delivery happens in the already-running session, with no second process started",
    "Exactly one delivery is recorded by the client, on disk, and in the engine input",
    "A turn needing approval either round-trips an approval or takes a bounded fallback",
    "The injected turn's reply is visible to the user, live or on next open"
  ],
  "code_refs": [
    {
      "path": "docs/bugs/FEAT-065-drain-stdin-delivery.md",
      "symbol": null,
      "note": "broker stdin delivery, index resume path, and the retry-start client loop are the surfaces named by the ticket; no source paths are recorded in it"
    }
  ],
  "related": [
    {
      "id": "BUG-045",
      "relation": "depends_on"
    },
    {
      "id": "BUG-048",
      "relation": "depends_on"
    },
    {
      "id": "BUG-072",
      "relation": "see_also"
    },
    {
      "id": "BUG-074",
      "relation": "see_also"
    },
    {
      "id": "FEAT-064",
      "relation": "depends_on"
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
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-065-drain-stdin-delivery.md",
    "sha256": "250219e4617bb40d3eee8e8bf7cfee2c44adf65a140836b0fd80349c97294a00",
    "bytes": 12985,
    "original_title": "deliver queued messages INTO the drain-held survivor (BUG-048 increment 2, \"(c+)\")",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head: the stdin-delivery mechanism, all four mandatory constraints, the probe provenance, the real-shape verification, and the not-deployed state are present.",
    "dropped": [
      "the parenthetical increment label from the original title",
      "the commit shas of the exploration and probe runs"
    ]
  }
}
```

# FEAT-065 — Messages sent after a restart waited for background work to finish

## Diagnosis

A restarted session whose foreground is idle while background work is live is held open by the drain. A message for it previously had nowhere to go until the drain ended. The fix writes one SDK stream-json user frame into the survivor's held-open stdin, so the message runs as a normal turn in the same CLI pid rather than waiting for the drain or spawning a second process.

Three constraints made this an all-or-nothing increment. The drain's mid-turn gate had to exist first, because the survivor also runs autonomous turns at background completion and an EOF there is a live hazard. An unanswered permission control request hangs forever and wedges the drain, so permission handling had to ship in the same change: a minimal broker control-response relay into the dashboard approval flow, with a bounded deny-with-notice fallback. Delivery rides the client's retry start and is acknowledged inside the ghost-release window, because out-of-band delivery lets the client re-deliver.

## Evidence

`verify:feat-065-delivery` passes 35/35. Before the fix the same suite ran 11/35: the message waited the entire drain and no frames reached the engine. `verify:restart-reconnect-race` — the invariant this must not relax — passes 10/10. Typecheck and the leak gate are clean.

The ticket was opened from BUG-048's exploration plus five live probes. Probe 3 proved a same-pid write with the single-writer property preserved. Probe 4 established the permission hang. Probe 5 established the exactly-once route through the retry start.

## Implementation notes

This is the input half of full re-adoption. The output half — the station already follows the transcript file — needed the session view to render the injected turn either live or on next open.

## Verification plan

Restart with a foreground-idle survivor carrying a live background heartbeat, then send. The message must reach the model without waiting for background completion, with the transcript proving a same-pid write and no second process. The reply must be visible, background must complete, and exactly one delivery must appear in the client, on disk, and in the engine input log. A permission-raising injected turn must either round-trip an approval or take the bounded fallback. Anti-regressions: the restart-reconnect race, resume refusal, refusal visibility, restart-background, restart survival, host cleanup, queue, UI, typecheck, and FEAT-064's suite.

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
