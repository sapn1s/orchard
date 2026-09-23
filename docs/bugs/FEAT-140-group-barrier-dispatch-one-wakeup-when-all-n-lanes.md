# FEAT-140 — Group (barrier/join) dispatch: one wakeup when all N lanes settle

- **Status:** OPEN — BUILD ticket for ARCH-017 step 2's group-settle drain, carved out as its own buildable slice. Plan below; no code written this round. BLOCKED-ON: ARCH-017 step 2's lane-runner (the non-blocking multi-member Claude dispatch primitive this rides on — does not exist yet). NOT blocked on ARCH-017's A/B scope decision: the barrier operates over grouped BACKGROUND lanes, which both options own (see the 2026-09-09 round-2 log entry). If we wait: an orchestrator that needs N lanes' results together keeps dispatching them as FOREGROUND `Agent` calls, which deaf the model for the whole batch (measured: a user message sat unsent for 20 min behind a "delivers at the next pause" chip), or as background lanes that wake the parent N times at a full context replay each (measured 390 turns / $312 of follow-on wakeups in one session). Bounded: nothing is broken today; this is the missing middle between foreground (one synthesis, deaf parent) and background (interjectable parent, N wakes).
- **Severity:** medium (a cost + control gap in a working system; the high-severity architecture parent is ARCH-017)
- **Area:** dispatch primitive / session lifecycle — `src/server/lanes.ts` (the built ledger), a new barrier module, the delivery seam (`agent-bridge` `send()` → `claude-runtime` InputQueue; `survivor-delivery`), boot reconciliation in `index.ts`
- **Reported:** 2026-09-09 by a dispatched plan+review lane (finding round 1), from the user's report of a 20-minute deaf window and the ARCH-017 wake-cost measurements
- **Verification-class:** plan+review (this round is design only) ⟶ the BUILD is session-lifecycle + concurrent-state + data-loss (a held result), so independent clean-room verification REQUIRED before VERIFIED, and it must run BUG-159's suite as an anti-regression (shared `send()`/InputQueue path).

## Symptom

An Orchard orchestrator that needs N lanes' results *together* — a fan-out whose
point is the combined synthesis — has only two shapes today, and both are wrong:

- **Foreground `Agent` calls.** A foreground subagent blocks the parent MODEL for
  its entire duration (verified empirically, SDK 0.3.220 / CLI 2.1.263), so a user
  message queued mid-flight is invisible to the model until the batch returns. Real
  incident: a user was deaf-ed for 20 minutes and their message sat unsent behind a
  chip reading "delivers at the next pause".
- **Background lanes.** They do not block, but the CLI wakes the parent once per
  lane, each wake a full-context replay producing a partial answer (measured 390
  turns / $312 of follow-on wakeups in one session). And the CLI owns that wakeup
  internally (`claude-runtime.ts:484-487` — Orchard only *observes*
  `background_tasks_changed`), so there is no suppression seam to build a barrier
  over the native `Agent` tool. See ARCH-015.

## The feature — the invariant, in one testable sentence

**For N lanes dispatched non-blocking under one `groupId` with `groupSize = N`,
exactly ONE message enters the parent session — stamped `deliveredBy:
'group-settle'`, carrying all N results — composed and sent once, when the last
member reaches a terminal state (or the group's timeout fires), never before and
never per-member.**

Testable form over the built ledger (`src/server/lanes.ts`): across all members of
a closed, complete group, `markDelivered(…, 'group-settle', …)` is called exactly
once per member and no member is delivered by any other reason; and the composed
message's lane-id join tokens appear in the parent transcript at-or-after those
`deliveredAt` stamps and nowhere before. Net: one synthesis and one wake
(foreground's benefit) with an interjectable parent throughout (background's).

## Why `group-settle` was designed and never produced — the honest finding

`LaneDeliveredBy` already includes `'group-settle'` (`lanes.ts:86`) and
`groupId`/`groupSize`/`groupClosed` are already carried on every record
(`lanes.ts:111-113`, written at `:527-529`). Nothing produces the reason: the only
delivery ever stamped is `'blocking-dispatch'` (`dispatch-broker.ts:175`). This is
not a bug someone left half-finished — it is **ARCH-017 step 2, unbuilt by
design**. ARCH-017 step 1 (the ledger) is built; step 2 (the lane runner + the
`drainLanes()` group-settle drain + the rail + the boundary hook) is the next step.
This ticket is the buildable carve-out of the **group-settle drain mechanism** from
that step. It does NOT wait on ARCH-017's A/B scope decision — the barrier operates
over grouped BACKGROUND lanes, which both option A and option B own; the A/B fork
decides only whether short FOREGROUND helpers are also Orchard-owned, which the
barrier never touches. See the 2026-09-09 round-2 log entry.

## Contradiction with a charter premise — stated bluntly (a wrong premise is worth more than a tidy plan)

The framing "dispatch N lanes NON-BLOCKING over the out-of-process path Orchard
already owns (`dispatch-broker.ts` → `scripts/dispatch.mjs`)" **does not hold**, and
the plan below is shaped by that:

1. **That path is BLOCKING and single-member.** `runDispatch()` holds the socket
   open until the child exits and records `groupId = laneId, groupSize = 1,
   groupClosed = true` — a group of one, closed at birth (`dispatch-broker.ts:216`).
   There is no non-blocking, multi-member dispatch primitive anywhere today. A
   group of N therefore needs a *new* non-blocking dispatch primitive first.
2. **That path is provider-locked to OpenAI, and reusing it for Claude lanes is a
   container escape** — ARCH-017's F1 finding, from an independent adversarial
   review: `validate()` refuses anything but `provider === 'openai'`;
   `runDispatch()` spawns on the HOST at `cwd: project.hostPath`, which for a
   container-isolated project means a session inside the container causes host-side
   execution. Safe for a read-only Codex run; a general-purpose "run agentic work
   outside my container" primitive if Claude `workspace-write` lanes cross it. So
   the barrier **must not** be built over the broker.

**Consequence for scope:** FEAT-140 owns only the *barrier* — the group-settle
evaluator, `drainLanes()`, the per-group timeout, and boot re-arm — over the
ledger that already exists. The *non-blocking multi-member dispatch primitive* it
needs (the lane runner that spawns through the project's own isolation routing, and
that accepts `groupId`/`groupSize`) is ARCH-017 step 2's largest item and is a
DEPENDENCY, not part of this ticket. FEAT-140 can be built and unit/integration
tested now against the ledger with synthesized non-blocking records; it cannot be
wired end-to-end until that primitive lands. This split keeps ARCH-010 honest (see
below): ARCH-017 owns the architecture and transport; FEAT-140 owns the
group-settle-delivery mechanism.

## ARCH-010 — one owner for "is this group complete and delivered?"

The rule (docs/CONVENTIONS.md): a fact a reader acts on is written once by its
owner and never re-derived. Applied here, the fact is **group completeness +
delivery**, and it has exactly one home: the ledger. "Is group G complete?" =
`groupClosed === true` AND every member's `state` is terminal
(`settled`/`failed`/`cut`). "Has G been delivered?" = every member carries
`deliveredAt != null` with `deliveredBy: 'group-settle'`. No second store, no
in-memory group table that could disagree with the ledger, and no derivation of
"last member" from the running set — that derivation is exactly the hole ARCH-017's
review caught (it fires N drains for N sequential settles, delivering nothing while
every individual drain looks well-formed). Cardinality is the dispatcher's declared
fact (`groupSize`), read, never reconstructed.

## Design — the exact call path from "orchestrator asks for a group dispatch" to "one group-settle wakeup lands"

1. **Dispatch (DEPENDENCY, ARCH-017 step 2).** The orchestrator issues one
   non-blocking group dispatch declaring `{ groupId, groupSize: N }`; the runner
   spawns N children through the project's isolation routing and, for each, calls
   `lanes.recordDispatch({ groupId, groupSize: N, groupClosed: true, parentSessionId, … })`.
   Each `op:'start'` returns a lane id immediately; the orchestrator's turn ends —
   the parent is now idle and interjectable.
2. **Settle.** As each child exits, the runner calls `lanes.settle(id, { state,
   resultText, usage })`. The record becomes HELD (`deliveredAt == null`); no
   `send()`, no wake — suppression-by-construction, because nobody calls the
   delivery function.
3. **Barrier evaluation.** Immediately after each `settle`, the runner calls
   `maybeSettleGroup(groupId)` (NEW). It reads the ledger and fires only when the
   group is closed and all `groupSize` members are terminal. This is the only place
   "the group is done" is computed, and it computes it from the ledger alone.
4. **Drain.** On fire, `drainLanes(parentSessionId, memberIds, 'group-settle')`
   (NEW — the sole producer of `group-settle`) reads the N settled records,
   composes ONE message (see Aggregation), and calls the parent session's `send()`.
5. **Delivery seam.** `send()` is the BUG-159 hold+push path: `agent-bridge`
   `send()` (`:1571`) → `ClaudeRuntime.send()` (`claude-runtime.ts:951`) →
   `InputQueue.push`. If the parent is idle the turn runs now; if busy it queues and
   runs at the next boundary; it is never refused. For a restart survivor the seam
   is `survivor-delivery.deliverIntoSurvivor()` instead — reuse the existing
   liveness branch that already chooses between them for a queued user message.
6. **Stamp — after `send()` returns, never before.** For each member,
   `markDelivered(id, 'group-settle', evidence)`. A member whose stamp write fails
   stays HELD (a duplicate delivery is a nuisance; a lost result is the failure this
   exists to prevent). One message = one turn in the live parent session.

## Aggregation — N results into ONE message (ARCH-016 contract)

`drainLanes()` composes a single string: a short header ("N lanes settled in group
G"), then per member a block carrying **the lane id as a literal token** (the join
key the proof greps for), the label, a one-line verdict (`settled` / `failed` +
`failureKind`), the reported `usage`, and the **durable `resultPointer`** path —
NOT the full result prose. This is ARCH-016's rule: the orchestrator gets pointers
+ verdicts it can synthesize from and can `readResult(id)` on demand, so the one
wake does not re-import N full payloads as live context. One `send()`, one turn.

## The three known failure modes — designed behaviour, not just the risk

**(a) A lane that never settles must not freeze the group.** Each group carries a
close/timeout deadline (`LANE_GROUP_TIMEOUT_MS`, a per-project setting). When it
fires, `maybeSettleGroup` resolves every still-`running` member against **ground
truth** — `liveWithToken(pid, argvToken)` / `reconcileBoot`'s discipline
(`lanes.ts:696`, `:737`), the pid-plus-argv-token authority the ledger already
owns: proven dead → `cut` with an honest reason, which lets the group settle and
drain what it has (the drain still fires exactly once); proven alive → the member
is genuinely still working, so the group extends once and re-arms rather than
cutting live work (never guess, never cut a live child). The bound guarantees the
worst case is *late*, never *never*.

**(b) The user interjects mid-batch and the model moves on before the join fires —
the barrier LATE-DELIVERS, it never drops.** The hold lives in the ledger, not in a
turn's control flow, so an interjection turn cannot consume or cancel it. When the
Nth member settles after the interjection, `drainLanes()` still calls `send()`,
which queues at the next boundary (BUG-159 hold+push) and delivers exactly once.
The group-settle message simply lands after the interjection's turn. Assert:
interject while the group is incomplete, let that turn complete, then settle the
last member → exactly one `group-settle` delivery, arriving after the interjection.

**(c) Server restart mid-group must re-arm the BARRIER, not only the lanes.**
ARCH-017 step 1 already reconciles individual `running` records at boot
(`reconcileBoot`, `lanes.ts:737`), but that alone leaves a *complete* group
undrained if the settle-then-drain sequence was interrupted, and leaves timers
un-armed for still-running groups. At boot, AFTER `reconcileBoot()`, a new
`rearmGroups()` pass: for every group with undelivered members, if it is now
complete → fire `drainLanes()` once; if it still has running members → re-arm its
`LANE_GROUP_TIMEOUT_MS` timer from `dispatchedAt`. This is the ARCH-010 payoff — the
barrier holds no state the ledger does not, so re-arming is a pure function of the
ledger and cannot disagree with it. Assert: kill the server with a group half
settled, restart → exactly one `group-settle`, no already-settled sibling stranded.

Plus the parent-dead case: if the parent session is gone when a drain fires,
`send()` throws (`agent-bridge.ts:1571`) → resume-then-deliver, or hold with an
honest notice; `deliveredAt` stays null and the result stays pullable after a
restart.

## Files the BUILD will touch

- **NEW `src/server/lane-barrier.ts`** — `maybeSettleGroup(groupId)`,
  `drainLanes(parentSessionId, laneIds, by)` (the ONLY producer of `group-settle`),
  the per-group timeout registry, and `rearmGroups()`. Holds no state the ledger
  does not. (Or folded into ARCH-017 step 2's `lane-runner.ts` — a naming call for
  the build lane; the mechanism is the deliverable either way.)
- **`src/server/lanes.ts`** — small read helpers if not already sufficient: a
  `groupTerminal(groupId)` predicate and `groupMembers(groupId)` over the existing
  `list({ groupId })`. No new stored field — every group field already exists.
- **`src/server/index.ts`** — boot: call `rearmGroups()` after `reconcileBoot()`.
- **`src/server/agent-bridge.ts`** — expose/route the `send()` seam `drainLanes()`
  uses; ensure a HELD group does not make the parent read as "main running" while
  idle (coordinate with BUG-159's honest-liveness fix — see Conflicts).
- **The non-blocking dispatch caller (ARCH-017 step 2, DEPENDENCY)** — calls
  `maybeSettleGroup(groupId)` after every `settle`.
- **Settings** — `LANE_GROUP_TIMEOUT_MS` project setting (default and the
  strict-accumulate high setting both stated).

## Conflicts and touch-points

- **ARCH-017 — this IS its step-2 group-settle drain.** No conflict; a deliberate
  carve-out. FEAT-140 does not re-open ARCH-017's architecture or its A/B scope
  decision, and does not build the lane runner, rail, or `PreToolUse` boundary
  hook. It depends on ARCH-017's non-blocking primitive and inherits its proof
  discipline. If ARCH-017 lands step 2 whole, fold this in rather than duplicating.
- **BUG-159 — the substrate, not a conflict.** Group-settle delivery USES BUG-159's
  hold+push `send()` (idle → now, busy → next boundary, never refused). Run
  BUG-159's suite as anti-regression; record `regressed-from: BUG-159` if anything
  there moves.
- **BUG-159 phantom-busy / BUG-171 / BUG-113 (honest liveness).** The whole value
  is that the parent stays idle and interjectable while the group is HELD — so
  liveness MUST read idle during the hold and only read running when the drain fires
  a real turn. If the phantom "main running" indicator lights up during the hold,
  the feature's benefit is lost. Verify against BUG-159's liveness assertions.

## Proof bar — what must be observed, and what would falsify it

1. **Must-FAIL first.** Against today (no `group-settle` producer), "exactly one
   `group-settle` delivery per closed, complete group" produces ZERO — the
   assertion must FAIL pre-build. Anchor the baseline to a synthesized pre-fix
   state, not to HEAD (docs/CONVENTIONS.md: a must-FAIL proof must not ride a moving
   baseline).
2. **Exactly-one-per-group, incl. the sequential case.** Dispatch N members in one
   declared group, each settling before the next starts → exactly ONE `drainLanes`
   / one `markDelivered('group-settle')` per member, at the Nth settle. Catches the
   per-member firing ARCH-017's review found (N wakes, delivering nothing).
3. **Interjection (failure b).** As designed above — one late delivery, never
   dropped.
4. **Never-settling member (failure a).** One member hangs past
   `LANE_GROUP_TIMEOUT_MS`; a genuinely-dead one is `cut` and the group drains once;
   a genuinely-alive one extends rather than being cut. Ground truth is
   `liveWithToken`, not a timer alone.
5. **Server restart mid-group (failure c).** Exactly one `group-settle` after boot;
   no already-settled sibling stranded; timers re-armed for still-running groups.
6. **Parent dead at drain.** `deliveredAt` stays null; result pullable after
   restart; never a stamp on a send that did not happen.
7. **Exactly-once under concurrency.** A drain racing a new dispatch for the same
   parent; and `send()` succeeds but the stamp write fails → one delivery, or a
   re-delivery of a still-HELD member, never a member marked delivered that was not
   sent.
8. **Truncated/partial reads.** The barrier writes the ledger while a reader reads
   it; grade reads truncated at several plausible points against the real record
   (WA / docs/CONVENTIONS.md — a race is a timing, not a shape).
9. **The user's reality, not the mechanism.** Drive a realistic busy-state fixture
   — several groups, some members running, some settled-undelivered, some delivered,
   some failed, one group frozen by a killed writer — over the real delivery path,
   not a clean single-group fixture.

**Falsifiers.** A closed, complete group producing ≠ 1 `group-settle` delivery; a
member delivered by two reasons; a restart double-delivering or stranding a
sibling; an interjection dropping the batch; or the parent reading as "main
running" while a group is merely HELD.

## Context pack (grows — the "where to look", so no agent cold-starts)

- **Owning design:** `docs/bugs/ARCH-017-…md` (whole ticket — step 2's
  `drainLanes()` group-settle drain, its F1 transport finding, its proof bar, and
  its A/B scope decision). Read it before this.
- **Built ledger:** `src/server/lanes.ts` — group fields `:111-113` (written
  `:527-529`), `LaneDeliveredBy` incl. `'group-settle'` `:86`, `markDelivered()`
  `:643` (the stamp seam), `settle()` `:599`, `isHeld()` `:414`, `list()` `:666`,
  `reconcileBoot()` `:737` + `liveWithToken()` `:696` (the ground-truth authority
  for failure a/c), the undelivered-exempt `prune()` `:431`.
- **Delivery seam:** `src/server/agent-bridge.ts:1571` (`send()` hold+push);
  `src/server/runtime/claude-runtime.ts:951` (`ClaudeRuntime.send()` → InputQueue),
  `:484-487` (why the CLI's own wake cannot be suppressed — ARCH-015);
  `src/server/survivor-delivery.ts:244-289` (`deliverIntoSurvivor`, the survivor
  branch of the seam).
- **The producer that exists today:** `src/server/dispatch-broker.ts:167-176`
  (`settleLane` → `'blocking-dispatch'`; the group-of-one, closed-at-birth path
  `:216`), and F1 (provider-lock + host-side spawn) `:189-274` — the path the
  barrier must NOT reuse.
- **Boot:** `src/server/index.ts` (where `reconcileBoot()` runs; add
  `rearmGroups()` after it).
- **Related tickets:** ARCH-017 (parent), BUG-159 (delivery substrate +
  anti-regression), ARCH-015 (CLI wake is not suppressible), ARCH-016 (payload
  contract for the composed message), BUG-171/BUG-113 (honest liveness during the
  hold), FEAT-100 (the `Dispatch:` declaration carried on each lane).
- **Repro test:** none exists. The build must add `npm run verify:lane-barrier`;
  the must-FAIL leg of proof item 1 is the first thing it should contain.
- **Known dependencies / blockers:** ARCH-017's non-blocking lane-runner
  (`op:'start'` with `groupId`/`groupSize`) — and ONLY that. This ticket is NOT
  blocked on ARCH-017's A/B scope decision (see the 2026-09-09 round-2 log entry).
  The lane-runner is substantially larger than the barrier itself. This ticket is
  buildable and testable against the ledger now; end-to-end wiring waits on the
  lane-runner.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-09 — dispatched plan+review lane (finding round 1)

- **Understood:** the user wants a barrier/join dispatch — N lanes non-blocking
  under one group, the parent idle and interjectable throughout, one combined wake
  stamped `group-settle` when all N settle. This is ARCH-017 step 2's group-settle
  drain, which is designed in full there and unbuilt; step 1 (the ledger) is built,
  so the `group-settle` enum value and the group fields already exist and nothing
  produces them.
- **Changed:** this ticket only. No source touched. INDEX regenerated via
  `board:gen`.
- **Verified (by reading the real code, not inherited):** `lanes.ts` carries the
  group fields and `'group-settle'` and only `'blocking-dispatch'` is ever produced
  (`dispatch-broker.ts:175`) — confirmed. The charter premise that the barrier can
  ride the existing owned out-of-process path is REFUTED: that path is blocking,
  single-member, provider-locked to OpenAI, and a container escape for agentic
  Claude lanes (ARCH-017 F1). The barrier therefore needs ARCH-017 step 2's
  non-blocking lane-runner as a dependency; it is not a thin layer over existing
  dispatch. The delivery half (`send()` hold+push, InputQueue, survivor path) is
  well-supported by existing seams and needs no new primitive.
- **Still open / handoff:** the build waits on ARCH-017's non-blocking primitive
  and its A/B scope decision (do NOT duplicate that decision here — ARCH-010). A
  build lane can start the barrier module + its unit/integration suite against the
  ledger with synthesized non-blocking records immediately; only end-to-end wiring
  blocks. This is high-stakes (session-lifecycle + data-loss); independent
  clean-room verify is required before VERIFIED, and BUG-159's suite is the
  anti-regression.
- **Symptom of a deeper design flaw?** No new one — this is ARCH-017's class
  (ARCH-010 applied to lane lifetime), and this ticket is a buildable slice of it,
  not a separate architecture question.

### 2026-09-09 — same lane, round 2 (correcting an overstated dependency)

- **Correction:** round 1 stated in several places that this ticket is blocked on
  ARCH-017's A/B scope decision. **That is wrong and is corrected in the body
  above.** FEAT-140 does NOT depend on the A/B decision being resolved. The barrier
  operates over grouped BACKGROUND lanes, and BOTH option A (background lanes only)
  and option B (all lanes Orchard-owned) own background lanes — so the barrier is
  agnostic to which is chosen. The A/B fork decides only whether short FOREGROUND
  helpers are also Orchard-owned, a population the barrier never touches.
- **What it DOES depend on:** ARCH-017 step 2's lane-runner — the non-blocking,
  multi-member Claude dispatch primitive that accepts `groupId`/`groupSize` and
  spawns through the project's own isolation routing. It does not exist yet. Per
  ARCH-017 it is that step's single largest item (isolation-routing spawn, its own
  caps, dispatcher-declared group membership, boot reconciliation), so it is
  **substantially larger than the barrier itself** — the barrier
  (`maybeSettleGroup`/`drainLanes`/timeout/`rearmGroups`) is small; the prerequisite
  dwarfs it. Any earlier "a day of work" characterisation of the end-to-end feature
  was wrong for this reason.
- **Changed:** this ticket only (Status header, the two body passages that implied
  the A/B block, and the context-pack dependencies line). No source. INDEX
  regenerated via `board:gen`.
