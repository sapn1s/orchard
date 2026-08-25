```orchard-ticket
{
  "id": "BUG-048",
  "type": "bug",
  "title": "Restart survivors delay new messages",
  "summary": "After a restart, a message waits while a background helper finishes, although background work does not block messages during normal operation. Messages auto-deliver safely but silently after the drain. The proposed first stage explains the delay; a later stage would shorten it without introducing competing transcript writers.",
  "impact_if_we_wait": "Messages remain silently delayed for about a minute after some restarts. Bounded: this is temporary delivery latency, not message loss or conversation corruption, and normal operation is unaffected.",
  "current_need": "Approve showing an honest held status with automatic-delivery timing before attempting live delivery into surviving helpers.",
  "severity": "low",
  "area": "Restart message delivery",
  "reported": "2026-08-11",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "open",
  "human_action": "staged_decision",
  "updated": "2026-08-11",
  "decision": {
    "mode": "staged",
    "question": "Should we first explain the safe delay before attempting faster delivery?",
    "options": [
      {
        "key": "A",
        "label": "Show held status",
        "what_changes": "Queued messages display that background work is holding them and that they will deliver automatically.",
        "benefit": "The existing safe wait becomes understandable instead of appearing broken.",
        "cost": "The message still waits until the surviving helper reaches its boundary.",
        "why_not_obvious": "Improved status may reduce pressure to remove a delay that still contradicts normal behavior.",
        "stage": 1
      },
      {
        "key": "B",
        "label": "Keep silent waiting",
        "what_changes": "The current automatic queue and delivery behavior remains unchanged.",
        "benefit": "No interface work is required before pursuing the deeper delivery change.",
        "cost": "People continue seeing an unexplained delay after affected restarts.",
        "why_not_obvious": "Skipping temporary interface work avoids churn if faster delivery follows immediately.",
        "stage": 1
      },
      {
        "key": "C",
        "label": "Deliver into survivor",
        "what_changes": "Queued messages enter the surviving helper at its next safe boundary.",
        "benefit": "The wait shortens without starting a competing conversation writer.",
        "cost": "The broker needs new message routing and lifecycle handling across both runtimes.",
        "why_not_obvious": "Incorrect boundary handling could corrupt the conversation record or interrupt background completion.",
        "stage": 2
      },
      {
        "key": "D",
        "label": "Retain bounded drain",
        "what_changes": "Messages continue waiting for complete drain while the interface reports progress and timing.",
        "benefit": "The established single-writer guarantee remains simple.",
        "cost": "Restart-only latency remains part of normal product behavior.",
        "why_not_obvious": "The safer implementation preserves a user-visible inconsistency that can last about a minute.",
        "stage": 2
      }
    ],
    "recommendation": "A",
    "recommendation_reason": "It makes the current safe behavior honest while preserving a reversible path toward shorter waits.",
    "prerequisite": "Before stage two, establish how survivor and resumed work avoid concurrent transcript writes.",
    "stages": [
      {
        "stage": 1,
        "question": "Should affected messages show that they are held and will auto-deliver?",
        "unlocked_by": "Approval to expose drain state and automatic-delivery timing."
      },
      {
        "stage": 2,
        "question": "Should messages enter the survivor at its next safe boundary?",
        "unlocked_by": "A demonstrated single-writer design for broker delivery across both runtimes."
      }
    ]
  },
  "decision_history": [],
  "success_criteria": [
    "Held messages display why they are waiting and when automatic delivery is expected",
    "A post-restart message reaches the model without waiting for background work to finish",
    "Background work completes after a new message is accepted",
    "Only one writer updates the conversation transcript",
    "Restart, detach, queue, refusal, health, and interface checks remain clean"
  ],
  "code_refs": [],
  "related": [
    {
      "id": "ARCH-002",
      "relation": "depends_on"
    },
    {
      "id": "BUG-033",
      "relation": "see_also"
    },
    {
      "id": "FEAT-065",
      "relation": "blocks"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "plan+review",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": true,
    "Migration and rollback": true,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-048-background-only-survivor-blocks-messages.md",
    "sha256": "fd66e0186efd4a3dd2ad8bf46fb259f88bc2f277e1327f5e451128e2c78cd918",
    "bytes": 24420,
    "original_title": "after a restart, a background-only survivor blocks new messages for its whole drain",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the archived BUG-048 text; the symptom, safe bound, staged recommendation, alternatives, writer hazard, and proof bar remain represented.",
    "dropped": []
  }
}
```

# BUG-048 — Restart survivors delay new messages

## Diagnosis

After restart, a foreground-idle survivor with active background work is drained rather than restored as the live conversation bridge. The drain refuses new messages until completion. Starting another conversation process is unsafe because the survivor can still append background results, creating two transcript writers.

## Evidence

The live incident showed that only background work survived and the queued message auto-delivered after roughly one minute. Normal operation accepts messages in the same background-only state. A matched run recorded 240/240 passes without an adjacent suite name.

## Implementation notes

Stage one should expose a held status, the background cause, elapsed time, and expected automatic-delivery bound. Stage two may route queued messages through the broker at the survivor's next natural boundary. Any faster resume path must exclude or serialize survivor transcript writes.

## Verification plan

Restart with an idle foreground and a surviving background heartbeat. Send a new message and confirm timely model receipt, background completion, and a single transcript writer. The named restart, detach, reattach, refusal, health, cleanup, queue, and interface suites are planned checks; their mentions carry no recorded results.

## Migration and rollback

Land the status surface independently before changing delivery. It can be removed without changing queue behavior. Keep the existing bounded drain available if broker delivery fails its single-writer proof.

## Risks

Delivering into a survivor at the wrong boundary could create concurrent transcript writers or disrupt background completion. Keeping only the status change leaves restart-only latency in place.

## Activity log (APPEND-ONLY)
### 2026-08-11 — orchestrator
- Filed from the user's diagnosis of the live 1-minute queue wait after the 275407e deploy; the
  user's model of "subagents don't block messages" is the correct target state. Dispatching
  explore (WA §I class rules — multiple defensible approaches, high blast radius).

### 2026-08-11 — explore agent (READ-ONLY static analysis; no code changed, no probes run)

**1. The two-writers hazard, stated precisely.**

WHO can write a direct session's transcript (`~/.claude/projects/<enc-cwd>/<sdkSessionId>.jsonl`):
ONLY `claude` CLI processes. The station server never writes that file — `transcript.ts`/
`watcher.ts`/`jsonl.ts` are readers; Orchard-owned capture (`orchard-transcripts.ts`) exists only
for engines WITHOUT a persisted transcript, and survival is gated OFF for those
(`agent-bridge.ts:765` — `survivalEnabled() && capabilities.persistedTranscript`). The broker
never writes it either: `session-host.mjs` only relays bytes (`:272` client→stdin, `:206-210`
stdout→client) and sniffs them (`:148-200`). So "two writers" means, exactly: the surviving CLI
pid plus any freshly spawned `claude --resume=<same id>` (spawn site `agent-bridge.ts:768`
via `spawnSurvivable`, or the SDK default spawn).

WHEN the survivor writes, foreground-idle case: its Task subagents are IN-PROCESS threads
(FEAT-015 investigation §1 — no per-subagent pids), so their results can only ever land in the
store via THIS pid. BUG-022's captured transcript contains a `<task-notification>` line for a
still-running background task, i.e. background-related frames do reach the main transcript, not
only foreground turns. Whether the completion record is appended AT completion time while idle,
or only folded into the next turn, is NOT statically determinable (live-probe item 1 below) —
but either way the survivor remains a POTENTIAL writer at an unpredictable future moment for as
long as it lives, which is precisely what a write-exclusion scheme would have to disprove.

VERDICT: the hazard is REAL for a foreground-idle survivor, but it is EVENT-DRIVEN, not
continuous — with no foreground turn in flight the survivor writes only on background-task
events. That narrowness is not exploitable, for two reasons:
  (a) the write moments are unpredictable (a bg task can finish at any time), so there is no
      provably-safe window to let a second CLI in; and
  (b) byte interleave is not the only corruption class. Transcript lines form a parent-uuid
      chain; a second CLI resumes from its READ of the file, and any later survivor append forks
      the logical chain / diverges the second CLI's in-memory context from disk even if every
      line lands atomically. BUG-022's measured outcome (original turn's reply + marker LOST,
      not merely interleaved) is this class.

**2. The three directions against the real code.**

**(a) Full re-adopt as live bridge.** The seam half-exists: the broker allows exactly one socket
client (`session-host.mjs:266-279`) and post-restart there is none, so a fresh server CAN connect
to `<key>.sock` and both read stdout and write stdin — FEAT-015's own handoff note anticipates
this ("a future server could reconnect a relay", survival.ts FEAT-015 entry). The hard wall is
the SDK: `query()` owns the transport and always spawns via `spawnClaudeCodeProcess`
(survival.ts:24-34 honest-boundary comment) — it cannot adopt an initialized CLI stream. Full
re-adopt therefore means a server-side stream-json driver that bypasses `query()` for adopted
sessions: input frames, event parsing, AND the control protocol (`--permission-prompt-tool stdio`
approvals, interrupts, model switches), plus rebinding a synthetic `AgentSession` so
busy/liveness/approvals/queue all work (BUG-028/029/033 interplay). One correction to the
ticket's framing: "both runtimes" overstates it — only Claude-direct sessions are ever survivable
(the `persistedTranscript` gate), so (a) touches one runtime path, but it is still the largest
change in the restart lineage. Blast radius: agent-bridge, survival, session-host, index resume
path, liveness. Gating suites: verify:restart-survives, verify:restart-reconnect-race,
verify:bug-044-restart-background, verify:detach, verify:reattach-approval, verify:zombie-busy,
verify:health-survivor, verify:hosts-cleanup, verify:resume-refusal, verify:refusal-visible,
verify:queue, verify:ui, typecheck. Proof bar: new turn reaches the SURVIVOR pid (transcript
shows the turn written by that pid, no second `claude` ever spawned), approvals round-trip,
background completes, all above green. Feasible but weeks-class; not the first move.

**(b) Background-only fast-path with write exclusion.** INFEASIBLE as sketched, and the reason
is structural, not effort: the survivor's transcript writes are internal to the CLI — the server
mediates nothing (the broker sees stdio bytes, not file writes), so there is NO seam at which to
"exclude or serialize" or "spool to a side file" the survivor's appends. The ticket's spool idea
presupposes a mediator that does not exist. (b) therefore reduces to "prove the survivor will
never write the file again" — unprovable while its background threads live, since their results
are exactly what must eventually land in the store it owns; and even a probe-backed "idle CLIs
don't write until next turn" answer would be a version-dependent behavioral assumption
underwriting the CATASTROPHIC outcome. Additional defect even if exclusion existed: the second
CLI's context would permanently omit the background results, so the work survival protected would
be invisible to the continuing thread. Cost-of-mistake weighting rejects (b) outright.
verify:restart-reconnect-race exists specifically to assert the invariant (b) would relax.

**(c) Keep the block, shrink the wait + honest chip — upgraded to (c+): broker-boundary
delivery.** One inaccuracy in the ticket first: "the abandon-net machinery already writes control
frames" is not what the code shows — the broker never writes to child stdin except relaying
client bytes (`:272`) and `endStdin()` (`:125-129`); delivery is NEW code, but the byte path for
it (server → unix socket → stdin) already exists and is client-free after a restart. The CLI sits
foreground-idle in `--input-format stream-json` with stdin held OPEN by the BUG-044 drain hold
(`commitDrain` declining at `:364-376` while `backgroundOutlivesTurn() !== 'no'`, `:319-323`).
Writing one SDK-format user frame into that stdin starts a normal turn in the SAME CLI —
SINGLE WRITER PRESERVED, which is why this direction is categorically safer than (b): it removes
the wait without ever creating a second writer. The reply lands in the transcript the station
already file-follows; the session continues by resume-from-disk after the (now longer) drain.
This makes (c+) a genuine increment TOWARD (a) (the input half without the control-protocol
half), not a cosmetic patch. Known constraints found statically, all addressable:
  - `commitDrain()` re-checks ONLY background lifetime, not `state.midTurn` — if a turn is
    injected during the hold and bg then empties, the EOF at `:374` can land MID-turn and
    truncate it (the exact BUG-022 §3 failure). Any delivery change MUST also gate the commit on
    `midTurn`/a fresh `result`.
  - A headless injected turn that raises a permission request has no responder
    (`control_request` on stdout, nobody answering) — delivery must either be gated on the
    session's permission mode, bounded, or grow a minimal control-response relay (probe item 4).
  - Exactly-once vs BUG-045: the client's drain-wait retry loop (`app.js attemptDrainRetry`)
    re-sends the same text as a fresh `start`; if the server delivers via the broker AND the
    retry later succeeds, the message lands twice. The delivery path must retire the queued row
    (server-acknowledged "delivered via survivor") — BUG-045's `settleDrainWaitDelivery` seam is
    where that lands.
  - Gating suites: verify:resume-refusal, verify:refusal-visible (BUG-045's),
    verify:bug-044-restart-background, verify:restart-survives, verify:restart-reconnect-race
    (must STAY green — still no second CLI), typecheck.
Proof bar (matches the ticket's verification bar): restart with fg-idle + live bg heartbeat →
message reaches the model within one boundary (transcript gains the user turn + reply, written by
the SURVIVOR pid; `/proc` shows no second `claude` at any point), bg completes 240/240, drain
then commits and reaps, exactly-once delivery proven at the store level (1 user message), all
suites green.

**No better fourth direction found.** The only other shape considered — have the BROKER itself
queue the message and inject it (server hands it off and forgets) — is strictly worse than (c+):
same injection risks, plus the broker becomes a second place session state lives.

**3. RECOMMENDATION.** Staged (c) → (c+), rejecting (b) permanently; (a) stays the eventual
destination only if (c+) proves insufficient (e.g. approvals in injected turns turn out common).
Rationale, cost-weighted: transcript corruption is catastrophic and (b) is the only direction
that risks it; the stale block is merely annoying and BUG-045 already made it non-lossy; (c+)
removes the user-visible wait while keeping the single-writer invariant BY CONSTRUCTION, and
every line of it survives into (a) if (a) is ever built.

FIRST dispatchable fix-class increment (small, near-zero risk, independently shippable):
**truth surface.** The broker already heartbeats its status file while declining
(`writeStatus({})` at `:254`, `:370`) — extend those heartbeats with `backgroundLive`, the task
ids, and a `drainHeldSince` stamp; carry that through `livenessOfSurvivor`'s reason into the
index.ts:2620 refusal message and the BUG-045 chip, so the user sees "held by background task X,
elapsed Ns, message will auto-deliver when it settles" instead of a bare wait. Gated by
verify:resume-refusal, verify:refusal-visible, verify:bug-044-restart-background,
verify:restart-survives, verify:health-survivor, typecheck. It changes no lifecycle and produces
exactly the observability the delivery increment needs. SECOND increment (own ticket, after the
probes): broker-socket delivery per (c+), including the `commitDrain` midTurn gate and the
exactly-once retirement.

**4. NOT determinable statically — needs a live probe before the (c+) delivery ticket is cut**
(explicitly not guessed):
1. Whether an idle-with-background survivor CLI appends to the main transcript AT background-task
   completion time vs only at the next turn (decides (b) with finality; tells (c+) whether a
   delivered turn folds pending notifications in).
2. Whether the CURRENT CLI version's `--resume` appends to the same transcript file or forks a
   new session id (BUG-022 measured same-file on 2026-08-04; version drift possible).
3. Whether the CLI accepts and runs a stream-json user frame arriving on stdin AFTER
   `gracefulReap` was requested but BEFORE EOF (mid drain-hold) — the load-bearing assumption of
   (c+) delivery.
4. What a headless injected turn does on a `control_request` with no responder (block forever /
   timeout / deny) — determines the permission-mode gate vs control-relay choice.
5. End-to-end interaction of a server-side delivery with BUG-045's client retry loop (the
   exactly-once seam) — needs a UI-level run, not code reading.

### 2026-08-11 — investigation agent (LIVE PROBES; scratch sessions only, no product code changed)

CLI version probed: **2.1.227** (the currently installed `claude`). All probes in
`/tmp/bug048-probes/*` scratch cwds with fresh `--session-id` UUIDs, model haiku, FIFO-held
stdin (`-p --input-format stream-json --output-format stream-json --verbose`). Real station
(port 4317, pid 278147) never touched; all probe pids killed by pid at the end. Each probe:
hypothesis → setup → observation → conclusion.

**Probe 1 — idle-CLI write timing: writes AT completion, and MORE than a record — it runs a
whole autonomous turn.**
- Hypothesis: idle survivor either appends a completion record at bg-completion time or folds it
  into the next turn. Setup: turn 1 launched `sleep 40 && echo BG_DONE_MARKER` via background
  Bash, replied "LAUNCHED", went foreground-idle; transcript sampled every 2s.
- Observation: transcript flat at 12 lines/18834 bytes from 18:05:05 to 18:05:15; at 18:05:17
  (exactly bg completion, sleep started ~18:04:35) it jumped 12→15→17 lines / 25131 bytes while
  NO input was pending. Appended verbatim: a `queue-operation enqueue` line carrying a
  `<task-notification>` (task-id `bzx1dm6ow`, status completed), a `dequeue` line, a synthesized
  `user` message with that notification, then an `assistant` thinking + text turn ("Background
  task completed. Output available at …") and a `result` event on stdout — a full model turn,
  unprompted, tokens spent.
- Conclusion: the survivor does not merely append a record at completion time — it AUTONOMOUSLY
  RUNS A NEW TURN at an unpredictable moment. This closes (b) with finality (the "prove it won't
  write" bar is unmeetable: it writes multi-line turns on its own schedule) and tells (c+) that
  pending notifications fold themselves in; an injected turn does not need to trigger them.
- NEW HAZARD found in passing, independent of any delivery change: bg completion first drops the
  bg count to zero and THEN starts the auto-turn — a `commitDrain` re-check sampling
  `backgroundOutlivesTurn()==='no'` in that gap could EOF mid-auto-turn (the BUG-022 §3
  truncation class) even today. The midTurn gate the explore entry demanded for (c+) is needed
  regardless of (c+).

**Probe 2 — `--resume <same id>` at 2.1.227 while the original lives: same file, no lock, chain
forks.**
- Setup: with the probe-1 CLI alive (pid 288479, fg-idle), ran
  `claude -p --resume 65c6fdcc-… "Reply with exactly RESUME_MARKER"` in the same scratch cwd.
- Observation: rc=0, `result: RESUME_MARKER`, `session_id` UNCHANGED, transcript grew 17→24
  lines, NO new `.jsonl` created, no refusal/lock, original pid alive and unaware throughout.
  Parent-uuid chain afterwards shows the fork concretely: the resume-CLI's user turn (uuid
  `5b9c05ef`) and the survivor's next turn (uuid `cca0caa0`) BOTH have `parentUuid c7171b1b` —
  two children of one node; the survivor's in-memory context permanently omits the resume-CLI's
  lines.
- Conclusion: BUG-022's 2026-08-04 same-file measurement HOLDS at 2.1.227; there is no CLI-side
  guard. The two-writers hazard is current, and the logical-fork corruption class was observed
  directly. `verify:restart-reconnect-race`'s invariant stays load-bearing.

**Probe 3 — drain-held CLI accepts an injected stream-json user frame and runs a normal turn:
YES, including while background work is live.**
- Premise note: from the CLI's side, BUG-044's drain hold is indistinguishable from "stdin open,
  foreground idle" — gracefulReap is broker-internal state until the EOF byte; a plain held pipe
  is therefore the faithful reproduction.
- Observation: frame 1 injected while idle → normal turn, `result success INJECT_ACK_1`,
  transcript 24→34 lines. Frame 2 injected while a fresh `sleep 30` background task was STILL
  RUNNING → normal turn, `result success INJECT_ACK_2` (transcript →44), and the bg completion
  auto-turn still appended cleanly AFTER it. Single writer throughout (only pid 288479);
  parent-uuid chain linear along the survivor's branch.
- Conclusion: (c+)'s load-bearing assumption is TRUE at 2.1.227. Injection during the hold runs
  a real turn in the same CLI, coexists with live background work, and background notification
  folding still works afterwards.

**Probe 4 — unanswered `control_request`: hangs forever; a one-frame stdio responder works.**
- Setup: fresh CLI in the REAL survivor arg shape (verified live station cmdline uses the hidden
  `--permission-prompt-tool stdio` flag — still accepted at 2.1.227), no permission skip;
  injected a turn requiring Bash approval.
- Observation: stdout emitted `control_request` subtype `can_use_tool` (request_id, tool input,
  permission_suggestions, tool_use_id). With nobody answering: 100+ seconds sampled — no
  timeout, no auto-deny, no further output, process healthy, turn stalled, tool not run. Then a
  single hand-written stdin frame
  `{"type":"control_response","response":{"subtype":"success","request_id":…,"response":{"behavior":"allow","updatedInput":{…}}}}`
  unblocked it immediately: marker file created, `result success DONE`.
- Conclusion: an injected turn that raises a permission request HANGS INDEFINITELY — and since it
  holds `midTurn`, it would also extend the drain hold unboundedly. (c+) delivery MUST ship with
  either (i) gating on the session's permission mode (only inject when the mode cannot prompt) or
  (ii) the minimal control-response relay — which this probe shows is genuinely minimal (match
  `control_request` on stdout, write one response frame). Deny-with-message is the safe bounded
  default for un-relayable requests.

**Probe 5 — exactly-once vs BUG-045's retry loop (static, per ticket allowance).**
- `app.js`: the queued row lives ONLY in the client tab (`state.queue`, `drainWait` mark). It is
  retired exactly two ways: `settleDrainWaitDelivery()` — fired ONLY on the ack of the client's
  OWN retry `start` (`attemptDrainRetry` → `startTurn` → ack) — or `failDrainWaitAttempt` on a
  non-retryable refusal. There is no server-push path that can retire a row, and a ghost-release
  guard clears `drainWaitAttempt` after 15s without an ack, re-arming the 7s retry interval.
- Consequence: an out-of-band broker delivery (server injects on its own schedule) leaves the
  row queued; the next retry re-sends the same text as a fresh `start`, which post-drain
  succeeds → DOUBLE delivery. The client cannot "learn of it" out-of-band without new push
  machinery plus row identity.
- Conclusion: delivery must ride the EXISTING retry path — the server's gate
  (index.ts:2620 refusal site), on seeing a deliverable survivor, injects the frame and answers
  that same `start` with an ACK (flagged e.g. `deliveredVia:'survivor'`) instead of a retryable
  refusal; `settleDrainWaitDelivery` then retires the row with zero client changes to the
  exactly-once logic. Two sub-constraints: the ack must land within the 15s ghost-release
  window (bound the injection ack, not the turn), and the server must either relay the
  survivor's stdout events onto that socket for the live turn view or ack with a distinct
  subtype the client renders as "delivered — reply will appear from transcript".

**GO/NO-GO on (c+) delivery: GO**, with these now-evidence-backed constraints:
1. `commitDrain` midTurn gate is MANDATORY and is needed even before delivery ships (probe 1's
   auto-turn gap hazard).
2. Permission handling is not optional: unanswered `can_use_tool` = infinite hang + infinite
   drain hold (probe 4). Ship mode-gating or the (proven-minimal) control relay in the same
   increment; bounded deny as fallback.
3. Delivery must be ack-on-the-retry-`start`, never out-of-band (probe 5), acked within 15s.
4. The single-writer invariant is what makes all of this safe (probes 2+3): injection adds no
   writer; `--resume` while the survivor lives remains as corrupting as ever at 2.1.227, so
   `verify:restart-reconnect-race` stays a gate.
(b) is rejected on direct evidence now, not inference: the survivor writes full autonomous turns
at unpredictable times (probe 1) and the current CLI offers no same-file guard (probe 2).
