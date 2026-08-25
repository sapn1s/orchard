# BUG-105 — an agent that is still working is recorded as dead, because the agent that dispatched it works in the background

- **Status:** RE-FIXED (7th time) 2026-08-19 — the 7th independent clean-room verdict came back **BROKEN**:
  the 6th-verdict fix DEMOTED the teardown blanket only where it had no row to land on. With the row
  already present it still converted `task_notification status:"stopped"` into a per-task `killed` — the row
  was settled, removed from the live set and written dead, including for a foreground subagent whose
  ancestor was still LIVE on the engine's background level (`ended=["killed"], rows=0`, measured live
  through the real server and bridge). "Demoted" is not the same as "not a verdict". Reproduced from the
  verdict's own script first, then fixed by making it ONE rule with no row-state arm: a blanket never
  establishes or writes a per-task outcome, row or no row; what happens at a genuine teardown falls out of
  the ordinary inference path, which records honestly and exactly once. See the 2026-08-19 7th-verdict
  entry (**95/95 exit 0**; nine checks must-FAIL on `08ecda4`, two of them in a real headless browser).
  Still awaiting an EIGHTH independent clean-room verify and a `:4317` restart before VERIFIED.
- **Previously:** RE-FIXED (6th time) 2026-08-19 — the 6th independent clean-room verdict came back **BROKEN**:
  a row-less `task_notification status:"completed"` — the ONLY terminal frame a tool task ever gets —
  established no outcome, so a later `task_started` RESURRECTED a task the engine had positively reported
  finished (`snap2.running = ['bashDone','bashChild']`), and every row-less per-task FAILURE a notification
  carried was discarded too. Reproduced live from the verdict's own script first, then fixed by moving the
  line from the frame's TYPE to what it SAYS: a self-reached ending (`completed`/`failed`) is the engine's
  per-task verdict and settles; an outside-imposed one (`stopped`/`killed`) stays the withdrawable blanket;
  and a row-less notification is refused once `#establishedOutcomes` holds a verdict, which keeps the two
  orderings' ledgers identical. See the 2026-08-19 6th-verdict entry (**84/84 exit 0**; five new checks
  fail on a synthesized `59c50d0` predicate). Still awaiting a SEVENTH independent clean-room verify and a
  `:4317` restart before VERIFIED.
- **Previously:** RE-FIXED (5th time) 2026-08-19 — the 5th independent clean-room verdict came back **BROKEN**:
  a row-less teardown blanket wrote a PERMANENT liveness veto, so a task the engine later RE-ANNOUNCED as
  live background work was starved of its level entry — recorded dead while working (`reann:unknown`,
  `reannChild:unknown`), its foreground subagent with it, and, detached, the starved level made
  `workLifetime()` answer "no" so the drop took the CLOSE branch on top of live work. Reproduced LIVE first
  (the verdict itself only simulated the consequence), then fixed by an asymmetry: an established per-task
  outcome is never withdrawn, a blanket-only veto is withdrawn by the task's own `task_started`, and
  `#backgroundTasks` became a DERIVATION of (raw level − veto) so frame order cannot change the answer. See
  the 2026-08-19 5th-verdict entry (**73/73 exit 0**; eight new checks fail live on unmodified `991ac79`).
  Still awaiting a SIXTH independent clean-room verify and a `:4317` restart before VERIFIED.
  Earlier header: RE-FIXED (4th time) 2026-08-19 — the 4th independent clean-room verdict came back **BROKEN** on
  property (c) again: a teardown `task_notification status:"stopped"` arriving as the FIRST frame for a task,
  before its row exists, was promoted into an engine-reported `killed` death — the one report type the 3rd
  fix's parity rule could not reach, because it was written as a comparison between two reports. Reproduced
  as must-FAIL first with the verifier's own script, then made STRUCTURAL: one settle predicate, asked by
  both handlers, with "no row" passed in as a state. See the 2026-08-19 4th-verdict entry (**56/56 exit 0**;
  six new checks fail on an unmodified worktree at `cf6c97e`).
  Earlier header: RE-FIXED (3rd time) 2026-08-18 — the 3rd independent clean-room verdict came back **BROKEN** on
  property (c): two terminal reports that DISAGREE, both landing before the row exists, collapsed to the
  first, so an engine-reported failure left no ledger row at all. Reproduced DYNAMICALLY first (the
  verdict's own probe was a static source reading), then fixed by a stated rule — the row-less path must
  produce the ledger the row-present path would have produced — with the disagreement itself now surfaced
  instead of swallowed. See the 2026-08-18 3rd-verdict entry (**40/40 exit 0**, must-FAIL **35/40 exit 1**
  on unmodified `0fc87c7`, mutation proof kept working). Still awaiting a FOURTH independent clean-room
  verify and a `:4317` restart before VERIFIED.
  Earlier header: RE-FIXED (2nd time) 2026-08-18 — the 2nd independent clean-room verdict came back **BROKEN**,
  and a follow-up investigation established by BASELINE that `b0dfaf6` (this ticket's own previous fix)
  introduced a REGRESSION: a task that positively reported `task_updated completed` before its row existed
  was recorded as an `unknown` death, because the terminal report's STATUS was dropped at `if (!a) return`.
  Fixed so a terminal report marks the eventual row terminal in either order — see the 2026-08-18
  regression-fix-lane entry (**28/28 exit 0**, must-FAIL 27/28 exit 1 reproduced first, parent baselined).
  Still awaiting an INDEPENDENT clean-room verify and a `:4317` restart before VERIFIED.
  Earlier header: RE-FIXED 2026-08-18 after the 1st independent clean-room verdict came back **BROKEN** on
  property (a) (stale background-level membership kept sparing a RETIRED owner's child forever). The
  staleness is now unrepresentable rather than guarded — see the 2026-08-18 clean-room-fix entry. Awaiting a
  SECOND independent clean-room verify and a `:4317` restart before VERIFIED.
  Earlier header (the fix the clean room broke): FIXED 2026-08-18, awaiting an INDEPENDENT clean-room verify and a `:4317` restart before VERIFIED. Must-FAIL reproduced on unmodified `cb2ceb2` through the real server and real bridge (**6/9, exit 1**, `allEnded=["gcBash:unknown","mainOrphan2:unknown","fgSub:unknown","mainOrphan:unknown","fgSub3:failed"]`) → **9/9, exit 0** after the fix. The sweep's ownership rule was restricted to `kind:'tool'` rows; ownership liveness is a fact about the CHAIN, not about the row's kind, and that restriction was the bug. Genuine agent deaths are still reported — proved four ways (its own terminal frame under a live owner; a main-thread subagent with no chain; a subagent that outlives its owner, recorded at the next boundary; a main-thread lane that re-issues a subagent's tool_use id). BUG-096 17/17, all ARCH-003 guards, full anti-regression and `npm run gate` green.
- **Severity:** high — this is the "live work reported dead" class that has already cost this project real work (BUG-037), and it is the most reachable instance of it left.
- **Area:** src/server/agent-bridge.ts (turn-end `result` sweep + the ARCH-003 ownership predicates)
- **Reported:** 2026-08-18, by the ARCH-003 6th-verdict lane, which found it while answering a different question, probed it live, and deliberately left it unfixed as its own lane
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED (session-lifecycle / ledger honesty; the surface with six BROKEN clean-room verdicts behind it)

## Symptom

An agent that is still working is written into the record as having died for no known reason.

Concretely: you dispatch a worker in the background — the normal pattern here. That worker dispatches a
helper of its own and waits for it. The moment your own turn ends, the station writes down that the helper
"ended, reason unknown", removes it from the live list, and briefs that to the orchestrator at the start of
its next turn. The helper is, at that instant, still working; it goes on to finish and land its work.

Probed live on the real bridge while the ARCH-003 lane was working: `allEnded=["fgSub:unknown", …]`, where
`fgSub` was a running foreground subagent of a background worker that the engine still listed as live.

## Why this is a different bug from ARCH-003, not another instance of it

ARCH-003 is about a *tool call* — a Bash the worker ran — being wrongly recorded dead, and its whole
repair history is about how the system works out which agent owns that call. That machinery now works:
it reads the frames' own parentage and walks the whole ownership chain.

This bug is what that machinery was never pointed at. The rule it produced only ever protects one kind of
row — a bash lane. A dispatched *agent* was left outside it, because the original incident happened to be a
bash. So the fix is not another repair of the ownership machinery; the ownership answer here was already
right. It is the removal of a restriction on who is allowed to benefit from it.

The practical difference matters for how likely each is. ARCH-003's remaining case needs a background
worker to dispatch a *background* sub-worker — possible, but against the house style, which tells workers to
stay in the foreground. This one needs a background worker to dispatch a subagent *in the foreground*, which
is exactly what the house style asks for. It is the shape a normal day produces.

## What it costs

The same cost BUG-037 was named after, and the reason that ledger exists: the orchestrator is told a step
died, so it distrusts finished work or dispatches it again. Here it is worse than for a bash lane in one
respect — an agent row is the unit the orchestrator's briefing is *about*, so a false death here is read as
"a worker you dispatched failed", which is the sentence most likely to trigger a re-dispatch.

There is a second-order cost that only shows up a turn later. Recording the death also settles the row, and
the system treats a settled lane as evidence that the work it was doing is over. So the still-running
subagent's ownership record is thrown away, and the *next* command that subagent runs has its own death
fabricated too — for a completely different reason, one ARCH-003 thought it had closed.

## Repro

`node scripts/verify-bug-105-foreground-subagent-of-live-owner.mjs` — real server, real bridge, scripted
model frames. On unmodified `cb2ceb2`: **6/9, exit 1**, with the fabricated `fgSub:unknown` printed. Six of
the nine checks pass on the unfixed code, so the suite is isolating the missing half rather than restating a
strawman.

## Expected

A lane whose owner is still working is not contained by *this* turn, and this turn's end is not its
boundary — the same treatment the engine's own background lanes already get. And when nothing in its
ownership is live any more, its death is recorded honestly at the next boundary: deferred, never lost.

## Context pack

- Files/functions in play: `src/server/agent-bridge.ts` — the `case 'result'` sweep loop
  (`#backgroundTasks`/`#bgBornTasks` `continue`, then the per-row ownership guard), `#ownershipSpares`,
  `#ownerIsLiveBackgroundAgent`, `#ownerIsUntrackedSubagent`, the new `#chainHasLiveBackgroundAgent`;
  `src/server/open-tool-calls.ts` — `ownerChainOf` (read only; unchanged by this ticket).
- Related tickets: **ARCH-003** (the ownership machinery, and where this was found and recorded),
  **BUG-096** (the contract this sits inside), BUG-037 / BUG-041 / BUG-068 / BUG-030 (the same class and the
  carve-outs that must survive).
- Repro test: `node scripts/verify-bug-105-foreground-subagent-of-live-owner.mjs`
- Known dependencies / blockers: deploy needs a `:4317` restart (the bridge is in-process).

---

## Technical detail (reference — skip unless you are fixing this)

### The mechanism

`task_started` classifies a lane as `kind:'agent'` when it carries a `subagent_type` (or
`task_type === 'local_agent'`), else `kind:'tool'` (a `local_bash`). The turn-end sweep skips any row the
engine's background level lists (`#backgroundTasks`) or that was born from a `run_in_background` dispatch
(`#bgBornTasks`) — BUG-037/BUG-068. Everything else still `running` is settled and passed to
`outcomes.turnEndOutcome`, which with no completion evidence returns the honest `unknown` death.

A FOREGROUND subagent of a background worker is on neither list: it is not background work, it is a child of
work that is. So it is settled and recorded. ARCH-003's per-row ownership guard would have held the write —
it resolves the lane's whole ownership chain and asks whether any ancestor is a live background agent — but
it is gated on the row's kind:

```ts
const ownedByLiveBackground = a.kind === 'tool' && this.#ownershipSpares(ownerChain);
```

That `a.kind === 'tool'` is inherited from BUG-096, whose incident was a child *bash*. Nothing about
ownership liveness is kind-specific.

### What collides with the BUG-096 contract

BUG-096's contract, as its ticket and its 17-check suite state it, has four parts. This change touches
exactly one of them, and it is the one that was never argued for — it was the shape of the original
incident.

1. **Only `kind:'tool'` rows may have their death held.** — CHANGED, deliberately. BUG-096's own reasoning
   ("suppress the fabricated death ONLY where a background agent could plausibly be the parent, and no
   wider") is a statement about the OWNER, and it is untouched. The row-kind clause was never given a
   justification in that ticket; it is a description of the reported incident. An agent row can have a live
   background parent for exactly the same reason a bash row can, so the contract is wrong here and is
   changed rather than worked around.
2. **A background BASH (`kind:'tool'` owner) never licenses suppression.** — UNCHANGED. The new rule calls
   the same `#ownerIsLiveBackgroundAgent`, which requires the owner's kind to be `agent`. This is the
   over-suppression hole that produced BUG-096's first BROKEN verdict; it stays closed.
3. **A retired background agent never licenses suppression.** — UNCHANGED, and now also asserted for the new
   row class (check 6): a foreground subagent whose owner drops off the level records its honest death at
   the next boundary.
4. **The row still SETTLES; only the ledger write is held (BUG-030/BUG-068 anti-over-spare).** — UNCHANGED
   for `kind:'tool'` rows, which is what that clause is about and what its checks (3)(8)(11)(13)(15)(17)
   assert. NOT extended to agent rows: see below. BUG-096's suite passes 17/17 unmodified.

### Why a `continue` for agent rows rather than settle-and-hold-the-write

For a `local_bash` row, settling is right: BUG-030 found those rows spinning forever, and the engine closes
them with their own notification. For an AGENT row, settling is itself a report that live work ended — the
row leaves the live strip — and it has the second-order cost above: a settled lane is terminal evidence to
`reap()`, so the subagent's ownership record is dropped and the next bash it issues resolves on a truncated
chain and has its death fabricated (check 3, which fails on `cb2ceb2` for that separate reason).

So a `kind:'agent'` row with a live background ancestor is treated exactly like a background-listed row: left
alone, to its own terminal frame.

### Why this is not a blanket over agent deaths

Four properties, each asserted:

- A MAIN-THREAD subagent has an EMPTY ownership chain and can never be spared — property (a) is preserved
  *by construction*, not by a second rule, and the common case (the orchestrator's own foreground
  subagents) is untouched (check 5).
- The un-observed-owner DEGRADE (`#ownerIsUntrackedSubagent`) is deliberately NOT extended to agent rows.
  Its justification is kind-specific — the real-CLI capture that a subagent-issued bash only ever gets a task
  row from a *background* agent — and no equivalent fact licenses silencing a whole class of agent deaths on
  absence of knowledge. Agent rows are spared only on POSITIVE evidence that an ancestor is a live background
  agent (`#chainHasLiveBackgroundAgent`).
- The spare is LEVEL-triggered, re-asked at every boundary. The moment nothing in the chain is a live
  background agent, the next sweep settles the row and records its honest death (check 6). A death is
  deferred, never lost.
- A genuine death that has real evidence never comes through this path at all: the agent's own terminal
  frame records it via `#recordAgentEnd`, whatever its owner is doing (check 2).

### Unrepresentable vs merely guarded

- **UNREPRESENTABLE:** a main-thread lane (agent or tool) being spared by any arrangement of live agents. It
  has no ancestry, and both rules are `.some()` over the ancestry — there is nothing for them to find.
- **UNREPRESENTABLE:** an agent row spared on absence of knowledge. The predicate has no `false ⇒ spare`
  branch; every source it reads is a positive membership.
- **UNREPRESENTABLE:** a spared row's death being lost rather than deferred, *given that any further turn
  boundary occurs* — the spare is re-evaluated from scratch at every sweep and holds no memory of the
  previous answer.
- **GUARDED, not eliminated:** the ownership ANSWER under tool_use id REUSE. Unchanged from ARCH-003 (a
  main-thread re-issue always wins over a stale subagent record), and now asserted for the agent row class
  too (check 8a).
- **NOT ADDRESSED (stated, not fixed):** if a session never takes another turn, a spared row stays `running`
  and no death is ever recorded for it. That is the pre-existing posture for every background lane
  (BUG-037's fix) and is the stall detector's territory (BUG-046 / BUG-033), not the sweep's.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-18 — fix lane (filed + fixed + self-verified)

- **Understood:** the ARCH-003 6th-verdict entry's handoff item (i), filed here as its own ticket rather than
  smuggled into a regression fix. `regressed-from:` none — this is PRE-EXISTING and predates the ARCH-003
  work; it is the row class that ownership resolution was never pointed at, not a regression a prior fix
  introduced. It does, however, sit one step from the ARCH-003 6th verdict: check (3) shows the same
  fabricated-leaf shape re-entered through the settled-agent-row door.
- **PREMISE CHECKED BEFORE BUILDING.** The dispatch required stopping if the row turned out not to be settled,
  or the agent to have genuinely ended. Neither: on unmodified `cb2ceb2`, through the real server and real
  bridge, `fgSub` — a `kind:'agent'` lane whose owner `rootW` was still on the engine's background level in
  the same sweep — was settled off `/running` (`{"fgSubRunningRows":0,"running":["rootW"]}`) AND written to
  the ledger as `fgSub:unknown`. The hypothesis holds exactly as stated.
- **Changed** (commit `bc4d257`)**:** `src/server/agent-bridge.ts` only — two hunks. (1) In the `case 'result'` sweep loop, a
  `kind:'agent'` row whose ownership chain holds a live background agent is `continue`d, exactly like a
  background-listed row. (2) A new `#chainHasLiveBackgroundAgent(ownerChain)` — the strict half of
  `#ownershipSpares` (no un-observed-owner degrade). `open-tool-calls.ts` is UNCHANGED: `ownerChainOf` was
  already the right answer, it was simply not asked for this row class.
- **Verified — MUST-FAIL FIRST, on unmodified `cb2ceb2`, before a line was changed.**
  `scripts/verify-bug-105-foreground-subagent-of-live-owner.mjs` (NEW): **6/9, exit 1**. Three genuine
  failures, printing the ARCH-003 probe's finding through the real bridge:
  ```
  FAIL (1b) …  observed: {"fgSubDeaths":["unknown"],"allEnded":["gcBash:unknown","mainOrphan2:unknown","fgSub:unknown","mainOrphan:unknown","fgSub3:failed"]}
  FAIL (1c) …  observed: {"fgSubRunningRows":0,"running":["rootW"]}
  FAIL (3)  …  observed: {"gcBashDeaths":["gcBash"], …}
  ```
  Checks (2)(4a)(5)(6)(7a)(8a) PASSED on the old code — property (a), genuine-death reporting, the
  main-thread subagent, the outlives-its-owner case and id reuse — so the new assertions isolate the missing
  half. After the fix: **9/9, exit 0**, with both non-negotiables asserted in the same sweeps.
- **Runs, as printed, with exit codes.**
  - `verify-bug-105-foreground-subagent-of-live-owner.mjs` (NEW): OLD **6/9 exit 1** → NEW **9/9 exit 0**.
  - `verify-bug-096-bg-child-lane-no-fabricated-death.mjs`: **17/17 exit 0** (unmodified — the contract's
    other three clauses are untouched).
  - ARCH-003 guards: `verify-arch-003-open-tool-calls` **20/20**, `verify-arch-003-growth-bound` **23/23**,
    `verify-arch-003-owner-lifetime` **13/13**, `verify-arch-003-per-row-owner-sweep` **5/5**,
    `adversarial-arch-003-nested-terminal-owner` **7/7**, `adversarial-arch-003-boundary-between-signals`
    **6/6**, `adversarial-arch-003-result-before-open-growth` `{"resident":0,"bounded":true}` — all exit 0.
  - Anti-regression: `verify-bug-068-bash-background-visible` **5/5**, `verify-agent-outcomes` **45/45**,
    `verify-feat-064-drain-truth` **18/18**, `verify-bug-070-outcomes-rail` **22/22**,
    `verify-running-snapshot` **47/47**, `verify-stall-detector` **33/33** — all exit 0.
  - `npm run gate` (leak + typecheck): **PASS, exit 0**, read directly, unpiped.
- **PROVENANCE, honestly.** SCRIPTED model frames through the real server and real bridge — the unchanged
  limit on this surface for eight passes; no clean room here has ever had real-CLI access. **This fix depends
  on no property of real frames.** It removes a row-kind restriction from a rule that already reads the
  ancestry the frames carry, and it introduces no new frame, field or ordering assumption; the one real-CLI
  fact in the neighbourhood (a foreground subagent's bash gets no `local_bash` task row) is the reason the
  un-observed-owner degrade is NOT extended, i.e. it is used to make the change narrower, never wider.
- **Still open / handoff:** (a) an INDEPENDENT clean-room verify is warranted before VERIFIED — high-stakes,
  session-lifecycle, on the surface with six prior BROKEN verdicts; generation must not be its own only
  judge. The useful adversarial questions: can any arrangement give a MAIN-THREAD row a non-empty ownership
  chain (id reuse of a Task call's tool_use id is the only candidate, guarded by check 8a)? Can a spared
  agent row's death be lost rather than deferred, other than by the session never taking another turn? Does
  keeping a `kind:'agent'` row `running` past the main `result` break any consumer that assumed rows only
  ever spin for background-listed lanes (the running snapshot, the stall judgment and the drain truth all
  pass, but a consumer nobody ran is the gap)? (b) Deploy needs a `:4317` restart (in-process bridge).
- **Symptom of a deeper design flaw?** Already filed — ARCH-003 is that ticket, and this is its
  handoff item (i) discharged.

- **Verified-by:** dispatch openai run 01a015a7-c2a0-7603-82bc-2d08f9af0f15 (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN

### 2026-08-18 — clean-room-verdict fix lane (property (a): stale level membership)

- **Understood:** the 1st independent verdict, property (a). `regressed-from:` **BUG-096 / this ticket's own
  `bc4d257`** — the sparing rule those two built decides owner liveness from background-LEVEL membership,
  which is level-triggered and therefore a SNAPSHOT that goes stale. `bc4d257` widened who may benefit from
  that rule (agent rows), so it widened the staleness with it; the underlying reading of a level as liveness
  predates it. Reproduced verbatim before changing a line.
- **THE DEFECT.** When an owner retires by EMITTING A TERMINAL FRAME (`task_updated completed`), nothing
  withdraws its `background_tasks_changed` entry — the engine's next level frame would, but there may not be
  one, and the level is REPLACE-semantics, not an edge. So `#ownerIsLiveBackgroundAgent` went on reading the
  dead owner as live and `#chainHasLiveBackgroundAgent` spared its foreground subagent at boundary after
  boundary: the owed death was never reported and the lane sat running indefinitely.
- **WHY THE EXISTING SUITE MISSED IT — the more important half.** Check (6) covers ONE retirement path: an
  owner that retires with NO terminal frame, where the level entry disappears and the death defers correctly.
  The OTHER path — retiring WITH a terminal frame while the level entry lingers — was never asserted. Two
  different retirement paths, one tested. Both are now asserted, in the same suite, on the same row.
- **THE SECOND INSTANCE, found by looking rather than by a verdict.** `#ownerPositivelyNotLive` (the
  reclamation predicate behind the ARCH-003 growth bound) reads the SAME two maps the same way: a retired
  owner whose level entry lingers reads as "no evidence it is not live", so its children's open records were
  never reclaimed — the same staleness, costing an unbounded record leak instead of a false death. Fixing
  only the reader the verdict ran would have left it. `stallSignalFor` and `workLifetime` read them too.
- **Changed** (commit `b0dfaf6`)**:** `src/server/agent-bridge.ts` only. Not a guard at the predicate — an
  INVARIANT on the containers: **no task with observed terminal evidence is ever a member of
  `#backgroundTasks` or `#bgBornTasks`.** New `#terminallyReportedTasks` (positive terminal-frame evidence
  only) + `#retireTask()`, enforced at all three write sites: (1) the engine's terminal frames
  (`task_updated` terminal status, `task_notification` terminal status) withdraw membership — taken from the
  FRAME, before any row lookup, because a level-listed task with NO row here (the resume/re-attach and
  `skip_transcript` shapes the level mirror exists for) is exactly where a lingering entry has nothing else
  to correct it; (2) the level-frame rebuild FILTERS retired ids, so a later stale level frame cannot
  re-admit one; (3) the BUG-068 born-tagging refuses one.
- **UNREPRESENTABLE vs GUARDED, as the choice actually cuts.** UNREPRESENTABLE: *any* rule — the sparing
  rule, the reclamation predicate, the sweep's background `continue`, `stallSignalFor`, `workLifetime`, and
  any reader added later — mistaking a retired task's stale level membership for liveness. There is no
  container state in which it can be read. A reader-side guard would have made only the ONE reader correct
  and left the other three, which is precisely how this surface has accumulated repeat verdicts. GUARDED,
  not eliminated: the converse direction — only the ENGINE'S OWN terminal frame retires a task; the turn-end
  sweep's settle deliberately does not, because that settle is this bridge's INFERENCE and can be wrong
  about a lane that is genuinely working (the ARCH-003 6th verdict). That is the seam that keeps property
  (b) from being traded for property (a), and it is asserted, not asserted-about.
- **Verified — MUST-FAIL FIRST, on unmodified `a7f6ca2`, before a line was changed.** `verify-bug-105-…mjs`
  (extended, +6 checks, two new turn-driven scenarios): **14/17, exit 1**, check (9) printing the verdict's
  own output verbatim:
  ```
  FAIL (9)  observed: {"fgSubDeaths":[],"fgSubRunningRows":1,"running":["fgSub"],"allEnded":["mainOrphan2:unknown","mainOrphan:unknown"]}
  FAIL (11) observed: {"fgSubDeathsAtB3":0,"mainOrphan3":1}
  FAIL (15) observed: {"leafSubDeaths":[],"leafSubRows":1,"running":["leafSub"]}
  ```
  (15) is a THIRD instance the verdict did not name: a nested chain whose root retires with a terminal frame
  leaves its leaves spared forever too. After the fix: **18/18, exit 0**.
- **BOTH PROPERTIES PROVED TOGETHER, not one at a time.** The new scenarios are turn-driven (one user
  message per turn) so a snapshot is taken AT each boundary, not only after the last:
  - (10) the same `fgSub` that must die at boundary 2 must NOT die at boundary 1, while its owner was
    genuinely live — a fix that reported the death one boundary early fails here;
  - (13)(14) the nested hazard: a live background ROOT, an intermediate that emits its own terminal frame,
    and the intermediate's children (an agent lane and a bash lane) still in flight. Neither child may be
    recorded dead, at boundary 1 or at a repeated boundary 2 — liveness is a fact about the whole CHAIN, so
    tightening it on the owner must not fabricate one level down. Both PASS on the old code too, which is
    what makes them a guard rather than a restatement;
  - (16) every main-thread orphan of all three nested sweeps still records — direction (a) untraded.
- **The two questions the verdict left open, now covered.** (i) CONSUMER SIDE of a row persisting past a
  boundary — (12): at the boundary where the spared row persists, the running set is exactly the lanes
  genuinely working (the settled main-thread lane left, the spared row appears ONCE, no per-sweep
  duplication) and the session does not claim a turn is in flight; (11): when the death finally lands it is
  written ONCE, not once per boundary, and that sweep's own orphan records normally. `verify-running-snapshot`
  47/47, `verify-stall-detector` 33/33, `verify-feat-064-drain-truth` 18/18, `verify-agent-outcomes` 45/45
  all still pass. (ii) REPEATED-BOUNDARY DEFERRAL beyond two boundaries — (15): held over three boundaries
  and recorded the moment the last ancestor retires. Deferred, never lost. (15b) pins the DIFFERENT and
  pre-existing posture for a `kind:'tool'` row: it SETTLES at the first boundary (BUG-030) with only its
  ledger write held, so it is OMITTED rather than deferred — honesty-by-omission, BUG-096's clause 4. That
  asymmetry was previously implicit; it is now a named assertion that fails in either direction.
- **Runs, as printed, with exit codes.**
  - `verify-bug-105-foreground-subagent-of-live-owner.mjs`: OLD **14/17 exit 1** → NEW **18/18 exit 0**.
  - `verify-bug-096-bg-child-lane-no-fabricated-death` **17/17 exit 0** (unmodified).
  - ARCH-003 guards, all exit 0: `open-tool-calls` **20/20**, `growth-bound` **23/23**, `owner-lifetime`
    **13/13**, `per-row-owner-sweep` **5/5**, `adversarial-nested-terminal-owner` **7/7**,
    `adversarial-boundary-between-signals` **6/6**, `adversarial-result-before-open-growth`
    `{"resident":0,"bounded":true}`.
  - Anti-regression, all exit 0: `verify-running-snapshot` **47/47**, `verify-stall-detector` **33/33**,
    `verify-feat-064-drain-truth` **18/18**, `verify-agent-outcomes` **45/45**,
    `verify-bug-068-bash-background-visible` **5/5**, `verify-bug-070-outcomes-rail` **22/22**,
    `verify-liveness-conformance` **96/96**, `verify-stale-agent-cards` **12/12**.
  - LIFETIME-ADJACENT, run because `workLifetime`/`stallSignalFor` now see a retired task leave the level:
    `verify-close-background-detach` **27/27**, `verify-detach` **7/7**, `verify-bug-044-restart-background`
    **15/15** — all exit 0.
  - NOT GREEN, and NOT MINE: `verify-zombie-busy` **35/39 exit 1** — reproduced IDENTICALLY (same 4 checks)
    on the pre-fix parent `b0dfaf6~1` in a clean worktree, so it is pre-existing.
    `verify-reattach-agent-backfill` is a browser/DOM suite that loads `public/app.js`, which another lane
    has uncommitted in this tree; it FATALs ("sub-agents never started") on the pre-fix parent as well.
    Neither is attributable to this change, which touches no DOM and no `public/` file.
  - `npm run gate` (leak + nul + typecheck): **PASS, exit 0** — run unpiped, exit status read directly.
- **PROVENANCE, honestly.** SCRIPTED model frames through the real server and real bridge — the unchanged
  limit for nine passes; no clean room here has ever had real-CLI access. **This fix depends on ONE property
  of real frames, and it is the one already captured on real CLI 2.1.220 and relied on throughout this
  surface: that a terminal `task_updated` / `task_notification` for a task id means that task is over.**
  Everything else it does is subtraction — it removes membership rather than inferring anything new, and it
  introduces no frame, field or ordering assumption. What is NOT captured, and is stated rather than
  claimed: whether a real engine ever emits a level frame that still lists a task AFTER that task's terminal
  frame. If it does, this fix is exactly what is wanted (the terminal frame wins). If it never does, the
  filter at the level rebuild is belt-and-braces and costs nothing.
- **Still open / handoff:** (a) a SECOND independent clean-room verify is warranted — high-stakes,
  session-lifecycle, now nine verdicts deep on this surface, and generation must not judge its own
  correction. Useful attacks: does removing a retired task from the level change any CLOSE decision for the
  worse (`workLifetime` now answers "no background work" one frame earlier — argued safe because only the
  engine's own terminal frame gets it there, and asserted by the three lifetime suites, but a close that
  kills live work is the expensive direction on this surface); can the sweep's settle reach `#retireTask` by
  any path (it must not, and does not — the only two call sites are frame handlers); and the reclamation-side
  instance, which is fixed structurally by the same invariant but is measured only indirectly (record
  residency is not observable over HTTP, so the growth-bound guard exercises the predicate's logic given a
  liveness input, and it is that INPUT this fix corrected). (b) Deploy still needs a `:4317` restart.
- **Verified-by:** dispatch openai run 01a0163c-ad70-7fc1-972f-c787815d4085 (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN

### 2026-08-18 — regression fix lane (a terminal report that lost its status)

- **Understood:** the follow-up investigation's finding, worked as a REGRESSION. `regressed-from:`
  **`b0dfaf6`** — this ticket's own clean-room fix. That fix deliberately retires a task from the FRAME,
  before the row lookup, so a level-listed task with no row here still retires; the row-less path then
  kept only half the report.
- **THE DEFECT, established by BASELINE and not by argument.** A terminal report is TWO facts: *this task
  is over*, and *this is how it ended*. `#retireTask` recorded the first and `if (!a) return` dropped the
  second. When `task_started` later built the row it was `running`, nothing re-applied the report, and the
  turn-end sweep settled it `unknown`. **A task that positively reported `task_updated completed` was
  written into the ledger as an unexplained death** — wrong under any ordering, and the exact class this
  ticket exists to close, pointed at the row itself instead of its child.
- **BASELINE, run before a line was changed** (parent `a7f6ca2` in a scratch worktree, same suite file):
  the new check (17) **PASSES on the parent** and **FAILS on `b0dfaf6`** — so we introduced it. What the
  parent does instead is the OTHER half this ticket already fixed: (18)(19) fail there, because the stale
  level entry spares the finished row forever (it spins, and its child's owed death is never recorded).
  Neither commit was right; the fix has to satisfy (9)(17)(18)(19) together, and does.
- **REACHABILITY, stated so the scope is honest.** The exact repro — a terminal report strictly before its
  own `task_started` on ONE live stream — is SYNTHETIC; a real engine cannot report a task id it has not
  announced. It is used because it is the smallest driver of a REAL code path: the frame-first retirement
  exists for the re-attach and `skip_transcript` shapes, where a terminal frame genuinely arrives for a
  task this bridge has no row for. So the gap is fixed at the level it actually exists —
  **a terminal report marks the eventual row terminal, whenever that row appears** — not at the synthetic
  ordering.
- **Changed:** `src/server/agent-bridge.ts` only, three hunks, all subtraction-of-loss rather than new
  inference. (1) `#terminallyReportedTasks` becomes a Map id→reported status (the membership semantics
  every existing reader depends on are byte-identical; it now also carries the status). (2) `#retireTask`
  takes the status and keeps the FIRST report (a re-delivered terminal frame restates one ending, it does
  not reclassify it). (3) `task_started` applies a pending report the moment the row appears — status,
  `agent-completed`, `#recordAgentEnd` (`completed` is dropped by the store). It is the ENGINE'S evidence
  applied late; `#terminallyReportedTasks` is still written by the two terminal-frame handlers and by
  nothing else.
- **THE TEST-ARTIFACT HALF, NOT "FIXED".** The investigation's mutated run also failed checks (10) and
  (12). Those two assert "the owner is live at this boundary", which is true for the `ownerterminal`
  ordering they were written for and false under the mutation — making the code satisfy them as written
  would break correct behaviour. `ownerterminal` is therefore left exactly as it was, and the new stream
  gets its OWN assertion of the ordering it actually drives: (19) asserts `fgSub`'s death IS owed there,
  because its owner really did retire first.
- **THE SEAM THE WHOLE BALANCE RESTS ON, NOW ASSERTED RATHER THAN ARGUED — (23).** Only the engine's own
  terminal frame may retire a task; the sweep's settle is this bridge's INFERENCE and can be wrong. If a
  settle ever reached `#retireTask`, the id would be filtered out of every later level frame *permanently*,
  a genuinely live lane would become unhearable and its children's deaths fabricated at every boundary.
  Driven end-to-end: a lane the level has not caught up on is settled by sweep #1, the engine THEN declares
  it live background work, and its child must be spared at sweep #2. **Proved to bite:** with a one-line
  mutation adding `#retireTask` to the settle, (23) FAILS (**27/28, exit 1**) and every other check still
  passes — so it isolates that seam and nothing else. Mutation reverted; gate re-run after.
- **The other three ranked gaps, all previously untested by anyone.** (21) a terminal report for a task
  never seen (the reachable re-attach cousin): absorbed, no ledger row for a lane that never existed here,
  no phantom row, sweep unharmed. (22) a double terminal report: ONE death on the ledger — it holds, and
  honestly, the guard is the outcome store's per-agent dedupe (`outcomes.ts:179`, "the first, most specific
  observation stands"), not the bridge handler, which does emit twice. (25)(26) the lifetime query
  answering one frame earlier: a REAL detached session (socket dropped, close fuse re-checking) where one
  of two background roots retires with a terminal frame while the other is live with a foreground subagent
  in flight — the session stays open (`{"rootBRows":1,"fgSubBRows":1,"running":["rootB","fgSubB"]}`) and
  nothing is recorded dead. Retirement withdraws exactly the task the engine reported over.
- **Runs, as printed, with exit codes.**
  - `verify-bug-105-foreground-subagent-of-live-owner.mjs` (+11 checks, 4 new scenarios):
    HEAD `b0dfaf6` **27/28 exit 1** (`{"rootWEnded":["unknown"],"allEnded":["rootW:unknown","fgSub:unknown","mainOrphan:unknown"]}`)
    → after **28/28 exit 0**, twice (`{"rootWEnded":[],"allEnded":["fgSub:unknown","mainOrphan:unknown"]}`).
    Parent `a7f6ca2` baseline: **23/28 exit 1**, with (17) PASSING and (9)(18)(19) failing.
  - ARCH-003 guards, all exit 0: `open-tool-calls` **27/27**, `growth-bound` **25/25**, `owner-lifetime`
    **13/13**, `per-row-owner-sweep` **5/5**, `adversarial-nested-terminal-owner` **7/7**,
    `adversarial-boundary-between-signals` **6/6**, `adversarial-id-reuse-chain-truncation` **7/7**,
    `adversarial-result-before-open-growth` `{"resident":0,"bounded":true}`.
  - Anti-regression, all exit 0: `verify-bug-096-bg-child-lane-no-fabricated-death` **17/17**,
    `verify-running-snapshot` **47/47**, `verify-stall-detector` **33/33**, `verify-feat-064-drain-truth`
    **18/18**, `verify-agent-outcomes` **45/45**, `verify-liveness-conformance` **96/96**.
  - Lifetime-adjacent: `verify-detach` **7/7 exit 0**, `verify-bug-044-restart-background` **15/15 exit 0**.
    `verify-close-background-detach` was NOT re-run (3 runs × 240 beats); the membership semantics it
    exercises are unchanged from `b0dfaf6`, which it passed, and the detached fuse is driven directly by
    (25)(26).
  - NOT GREEN, NOT MINE, baselined: `verify-zombie-busy` **35/39 exit 1** — the same four needs-you checks
    the previous lane reproduced on `b0dfaf6~1`. `verify-reattach-agent-backfill` (documented as
    intermittently fatal) happened to pass this time: **15/15 exit 0**.
  - `npm run gate` (leak + nul + typecheck): **PASS, exit 0**, run unpiped, exit status read directly.
- **PROVENANCE, honestly.** SCRIPTED model frames through the real server and real bridge — the unchanged
  limit for ten passes. The fix depends on the same single real-frame property as `b0dfaf6` (a terminal
  `task_updated`/`task_notification` for a task id means that task is over) and adds no new frame, field or
  ordering assumption; it only stops discarding a fact the frame already carried. The synthetic ordering is
  labelled as such in the suite header and in check (17) itself.
- **Still open / handoff:** (a) an INDEPENDENT CLEAN-ROOM VERIFY IS STILL WARRANTED before VERIFIED — this
  is a session-lifecycle regression fix on the surface with two BROKEN verdicts and now a self-inflicted
  regression; generation must not be its own only judge. Useful attacks: does applying a terminal report at
  `task_started` mislead any consumer that assumes a row is `running` when it is first announced (the
  live-strip client gets `agent-started` then immediately `agent-completed`)? Can a task id be announced
  TWICE after a terminal report (ids are unique, so the second announcement would resurrect nothing — but
  it is unproved)? Is there any third place a terminal report's status can still be dropped? (b) Deploy
  still needs a `:4317` restart.
- **Verified-by:** dispatch openai run 01a01679-55fd-7070-bf2a-ba34c56f6750 (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN

## 2026-08-18 — 3rd clean-room verdict BROKEN on property (c): two disagreeing terminal reports collapsed to the first (fix lane)

- **regressed-from:** this ticket's own `b0dfaf6` → `0fc87c7` line. `0fc87c7` taught `#retireTask` to KEEP the
  reported status so a row-less report could still mark the eventual row terminal. It also chose, without
  stating a justification, that "the first report stands" — citing `outcomes.ts:179` first-wins. That
  citation was a misreading, and it lost real deaths.
- **The finding, as received.** `task_updated completed` then `task_updated failed`, both BEFORE the row
  exists, then `task_started`. `#retireTask`'s `if (!this.#terminallyReportedTasks.has(taskId))` keeps
  `completed`; `task_started` applies it; `#recordAgentEnd` DROPS a `completed` (the store records deaths
  only) — so the engine-reported FAILURE leaves **no ledger row at all**.
- **The verifier was honest that its probe was a STATIC READING** (it grepped for two source strings and
  exited 1). So the first thing this lane did was reproduce it DYNAMICALLY, through the real server and the
  real bridge, in the real suite. **IT HOLDS**, and worse than described: with the row ALREADY PRESENT the
  same two frames write a `failed` row (each patch is recorded as it arrives; a `completed` was never a row
  to begin with). So the two orderings disagreed about what the engine said — in a path whose entire stated
  purpose is "a terminal report marks the eventual row terminal, IN EITHER ORDER".
- **THE RULE, and its justification (the thing `0fc87c7` did not state).** Not first-wins, not last-wins:
  **the row-less path must produce the ledger the ROW-PRESENT path would have produced.** That path is the
  reference — it is where each of these decisions was already made and probe-checked. Applied in
  `#retireTask`, which now also takes the frame's AUTHORITY:
  - no report yet → store it;
  - a DEATH by `task_updated` over a stored `completed` → REPLACE (the row path would have written it);
  - anything else — a second death, any `completed`, ANY `task_notification` → keep what is stored.
  The `notification` demotion is inherited, not invented: the row-present notification handler has always
  applied only `if (a.status === 'running')`, because a SIGTERM'd CLI emits `status:"stopped"` for EVERY
  still-open task on its way out (probe note, v2.1.220) — a blanket about the session, not a verdict on a
  task. Check (30) is what makes plain "last wins" unadoptable: it would promote that blanket into a
  fabricated death for a task the engine said `completed`.
- **A disagreement is itself a signal, so it is no longer swallowed.** `#conflictingTerminalReports` keeps
  the sequence; every conflict is `console.warn`ed with both reports and the resolution, and any death
  written afterwards quotes the conflict in its `detail` — the text the orchestrator is actually briefed
  from. Honest limit: a row already on the ledger when the second, disagreeing report arrives is not
  rewritten (the ledger does not retract); that conflict is visible only in the warning. The warning matters
  most where the resolution correctly writes NOTHING (`completed` then a teardown blanket) — there it is the
  only place the signal exists, which check (31) asserts.
- **CAN A REAL ENGINE EMIT TWO DISAGREEING TERMINAL REPORTS ON ONE ORDERED STREAM? An evidenced read: NO
  OBSERVED INSTANCE, and no corpus to check it against.** `task_*` system frames are STREAM-ONLY — a sweep
  of every `.jsonl` under `~/.claude/projects` finds ZERO `"subtype": "task_updated"`/`task_notification`
  frames on disk (verified this lane), so there is no recorded real-frame corpus in which a conflicting pair
  could be looked for, here or by any previous lane. What IS recorded is the one shape that comes close: the
  teardown, where the CLI emits `task_notification stopped` AND `task_updated killed` for the same task —
  and those two AGREE (both map to `killed`). The reachable disagreement is therefore
  `completed`-then-teardown-blanket, which this fix resolves to "no death", i.e. to what already happened.
  **So the urgency is LOW and the change is close to behaviour-preserving on real streams.** It is still
  worth making: the previous rule was arbitrary, it made the two orderings contradict each other, and it
  discarded the engine's own word about a failure with no justification stated anywhere.
- **A fourth thing the finding did not name, found while testing it: the announcement lied.** `task_started`
  emitted `agent-started` (status `running`) FIRST and settled the row a few statements later, for a task
  this bridge already knew had finished. `app.js`'s `agent-started` handler hardcodes `th.status =
  'running'`, so the row genuinely entered the live strip as live and depended on the event behind it to
  correct it — a consumer that samples between them, or replays only starts, keeps a ghost. The report is
  now applied BEFORE anything is announced and exactly one event goes out: `agent-completed`. That is not a
  new convention — `replayAgents()` documents and uses the same one, and the client's handler is written to
  be replay-safe for an agent it has never seen. This answers, with a test, the "does it mislead a live-strip
  consumer?" question the previous lane left open (check 34).
- **The three other items the previous three passes never tested, now tested** (the standing work queue):
  (33) a DUPLICATE `task_started` delivered twice after a report — one ledger row, no row left spinning;
  (36)(37)(38) a terminal report landing across a **REAL PROCESS BOUNDARY** — server killed by pid, its
  brokers/CLIs killed by pid, a fresh server booted on the same dataDir + store, the session resumed onto a
  BRAND-NEW bridge (empty `#agents`, empty `#terminallyReportedTasks`, only the on-disk ledger crossing) and
  only there does the engine re-announce the subagent and report it `failed`: exactly one `failed` row, and
  a report for a task the new bridge never saw is still absorbed rather than fabricated. And
  `verify-close-background-detach`, skipped by the last two lanes for time, was RUN: **27/27 exit 0**.
- **Runs, as printed, with exit codes.**
  - `verify-bug-105-foreground-subagent-of-live-owner.mjs` (+12 checks, 2 new scenarios: `conflictreport`,
    `crossboundary`). **MUST-FAIL FIRST, dynamically, against unmodified `0fc87c7`: 35/40 exit 1** —
    (27) `{"confLateEnded":[],...}` (the engine's `failed` nowhere on the ledger), (28) parity broken
    (`completed→failed`: `[[],["failed"]]`), (31) no warning, (32) no conflict in `detail`, (34)
    `{"confLateStarted":1,...}`. After the fix: **40/40 exit 0** (twice; the pre-fix suite was 28/28).
  - MUTATION PROOF KEPT WORKING (the seam the whole property balance rests on): inserting
    `this.#retireTask(a.agentId, 'killed', 'patch')` into the turn-end sweep's settle drops the suite to
    **39/40 exit 1** on check (23) — this bridge's own inference still cannot retire a task.
  - ARCH-003 guards, all exit 0: `open-tool-calls` **31/31**, `growth-bound` **25/25**, `owner-lifetime`
    **13/13**, `per-row-owner-sweep` **5/5**, `adversarial-nested-terminal-owner` **7/7**,
    `adversarial-boundary-between-signals` **6/6**, `adversarial-id-reuse-chain-truncation` **7/7**,
    `adversarial-reservation-window` **9/9**, `adversarial-result-before-open-growth` exit 0.
  - Anti-regression, all exit 0: `verify-bug-096-bg-child-lane-no-fabricated-death` **17/17**,
    `verify-running-snapshot` **47/47**, `verify-stall-detector` **33/33**, `verify-feat-064-drain-truth`
    **18/18**, `verify-agent-outcomes` **45/45**, `verify-liveness-conformance` **96/96**,
    `verify-close-background-detach` **27/27**.
  - NOT GREEN, NOT MINE, baselined: `verify-zombie-busy` **35/39 exit 1** — the same four approval-card
    checks the last two lanes reproduced, unchanged. `verify-reattach-agent-backfill` (intermittently
    flaky) passed this time: **15/15 exit 0**.
  - `npm run gate` (leak + nul + typecheck): **PASS, exit 0**, run unpiped, status read directly. Other
    lanes had in-flight edits to `src/server/open-tool-calls.ts` and `public/*` in the same tree throughout;
    no gate leg failed, and nothing outside this lane's two files was staged.
- **PROVENANCE, honestly.** SCRIPTED model frames through the real server and real bridge — the unchanged
  limit for eleven passes; `verify-close-background-detach` is the exception and uses the real CLI. The
  conflicting-report ordering is SYNTHETIC and labelled as such in the scenario header (a report before its
  own `task_started` cannot happen on one live stream; it is the smallest driver of the REAL row-less path
  that re-attach and `skip_transcript` reach). The cross-boundary scenario has exactly one synthetic part —
  the transcript planted so the resume-from-disk lookup succeeds; the process death, the fresh server, the
  fresh bridge and the resumed CLI are all real.
- **Still open / handoff:** (a) **AN INDEPENDENT CLEAN-ROOM VERIFY IS STILL WARRANTED** — this is the third
  BROKEN verdict on the same surface and generation must not be its own only judge. Useful attacks for the
  next pass: does the `agent-completed`-without-`agent-started` announcement change leave the real browser
  strip/thread without a clickable row (asserted here at the EVENT level and via `/running`, NOT in a real
  browser — `public/*` was another lane's live file this lane could not touch)? Is a conflict that resolves
  to "no ledger row" discoverable by anyone who is not reading server stderr? Can `#conflictingTerminalReports`
  be made to grow by anything other than a genuine anomaly? (b) Deploy still needs a `:4317` restart.
- **Verified-by:** dispatch openai run 01a016a8-d945-7a12-bd9b-210573f60769 (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN

## 2026-08-19 — 4th clean-room verdict BROKEN on property (c) again: a teardown blanket arriving BEFORE the row was promoted into an engine-reported death (fix lane)

- **regressed-from:** this ticket's own `d2a56b5` (the 3rd-verdict fix). That fix stated the right rule —
  the row-less path must produce the ledger the row-present path would have produced — and then implemented
  it as a comparison between two REPORTS. A comparison can only demote a blanket that lands ON TOP of
  something, so the rule held for `task_updated` and not for `task_notification`: the parity was restated
  in prose, not made structural, and it drifted for the other report type inside one round.
- **The finding, as received** (`adversarial-blanket-first.mjs`, the verifier's own script, reusing this
  suite's harness): a teardown-style `task_notification status:"stopped"` as the FIRST frame for a task —
  before this bridge has a row — hit `prior === undefined`, was stored as that task's outcome, and was
  applied as a `killed` DEATH when the row appeared. Reproduced here as **must-FAIL first**:
  `ended:["killed"], running:0`, exit 1. With the row present the SAME frame writes nothing (the handler's
  `a.status === 'running'` demotion). Two orderings, two different ledgers — and the row-less one invented
  an engine-reported per-task verdict out of a session-wide teardown blanket.
- **THE FIX IS ONE DECISION, NOT A RESTATED RULE.** `#terminalFrameSettles(rowState, authority)` is the
  single predicate both terminal-frame handlers ask, with the row's absence passed in as a STATE
  (`'absent'`) rather than handled by a parallel branch:
  - `patch` (`task_updated`) — the engine's specific per-task word — settles whatever the row said, and
    settles an absent row too (this is what keeps "terminal in either order" true);
  - `notification` — the blanket frame — settles only a row this bridge is holding **running**; the row IS
    the evidence that the blanket is about live work of ours, and `'absent'` is not `'running'`.
  Only a frame that answered YES may write `#establishedOutcomes`, which is the ONLY map `task_started`
  settles the eventual row from. `#terminallyReportedTasks` is now purely EVIDENCE (any terminal frame),
  which is all its `.has()` readers — the level-rebuild filter and the bgBorn admission — ever needed.
- **UNREPRESENTABLE vs GUARDED, stated plainly** (four cases on this ticket family were once called
  "guarded, only an ambiguity" and turned out to be real corruptions, so the distinction is spelled out):
  - **UNREPRESENTABLE:** a blanket teardown becoming an engine-reported per-task death. There is one
    predicate, one call site, one writer of the settle map; a non-settling frame's status never reaches
    the place the row is settled from. Pinned by checks (45)/(46), which fail if a second write site or a
    third `#retireTask` caller ever appears.
  - **GUARDED (named, not hidden):** a genuine per-task ending carried by a `notification` for a task whose
    row this bridge does not hold. It establishes nothing — exactly as the row-present path establishes
    nothing from a notification about a row it is not holding live. That is parity, and it is not a lost
    death: the row that appears afterwards is judged like any row with no report (spared while its chain is
    live, honestly settled otherwise), which check (40) proves as an EQUIVALENCE — the `noblanket` control
    is the same stream with only the blanket frames removed and lands the identical ledger.
- **The opposite direction was the real risk, so it is proved, not asserted.** A blanket does mean the CLI
  is going away, so over-correcting into "a blanket never means anything" would lose real deaths. Check
  (41): `liveA`/`liveB` were rows held RUNNING when the teardown landed — both still record `killed`.
  Check (42): a genuine `task_updated failed` arriving during the same teardown with no row yet still
  records `failed`. Check (40): the blanket is not allowed to SUPPRESS the honest turn-end death either.
- **Also covered, being the three things the 4th pass said it could not reach:**
  - **Property (e) IN A REAL BROWSER** (checks 50–54) — `public/app.js` was free this round. Headless Brave
    over CDP, theme via `Emulation.setEmulatedMedia`, the real composer's Enter path, against a BUSY
    mid-turn state the scripted engine HOLDS OPEN until the harness drops a flag: a task reported finished
    before its row existed (`doneLate`) and one reported after (`doneEarly`) are neither ◐ rows in the strip
    nor `running` threads, while `liveOne` IS a running row and the server's snapshot agrees with the DOM.
  - **A second path from this bridge's own settling to retirement** (check 47) — an INTERRUPT settles every
    running row `killed`, the most terminal-looking status inference ever writes. The engine then declares
    that lane live background work and the level is still heard, so its child is spared. Plus the static
    (46): retirement has exactly two call sites, both engine terminal frames.
  - **Can a conflict that resolves to writing nothing lose an outcome silently?** (check 49) — the server
    warnings are read back and each is checked against the ledger: every conflict whose resolution IS a
    death also has that death on the ledger carrying the conflict note; the ones with no row resolve to a
    `completed`, where nothing was established to lose. **Decision: no new surfaced signal is warranted** —
    stderr is a diagnostic for an upstream anomaly, not the sole record of an outcome.
- **Numbers, as printed.** `verify-bug-105-foreground-subagent-of-live-owner.mjs` **56/56 exit 0** (was
  38 checks). MUST-FAIL first, on an unmodified detached worktree at `cf6c97e` with only the new suite
  copied in: **(39) (40) (44) (45) (46) (53) FAIL**, while (41) (42) (43) (47) (48) (49) (51) (52) (54)
  PASS pre-fix — the anti-regression and opposite-direction checks are not bought by the fix. The
  verifier's own `adversarial-blanket-first.mjs`: `ended:["killed"]` → `ended:["unknown"]`, i.e. the
  engine-reported death is gone and what remains is the ordinary turn-end inference the same stream
  produces with the blanket deleted. **Its predicate `ended.length === 0` therefore still exits 1**, and
  that is a deliberate, stated disagreement: satisfying it literally would mean letting a blanket SUPPRESS
  the honest death a report-free row gets — the over-correction direction — so the property is asserted
  here as the stronger equivalence (40) instead.
- **Anti-regression, all exit 0:** ARCH-003 `open-tool-calls` **35/35**, `growth-bound` **25/25**,
  `owner-lifetime` **13/13**, `per-row-owner-sweep` **5/5**, `adversarial-nested-terminal-owner` **7/7**,
  `adversarial-boundary-between-signals` **6/6**, `adversarial-id-reuse-chain-truncation` **7/7**,
  `adversarial-reservation-window` **9/9**, `adversarial-result-before-open-growth` exit 0;
  `verify-bug-096` **17/17**, `verify-running-snapshot` **47/47**, `verify-stall-detector` **33/33**,
  `verify-feat-064-drain-truth` **18/18**, `verify-agent-outcomes` **45/45**,
  `verify-liveness-conformance` **96/96**, `verify-close-background-detach` **27/27**.
- **NOT GREEN, NOT MINE, baselined:** `verify-zombie-busy` **35/39 exit 1** — the same four approval-card
  checks the previous lanes reproduced, unchanged. `npm run gate` (unpiped, status read directly): **FAIL,
  exit 1, on the leak-gate leg only, and the sole hits are in `.tmp-repro-html-overreach.mjs`, an UNTRACKED
  scratch file belonging to another live lane** (`[home path]`/`[username]` in an import line). Typecheck
  **PASS**, check-nul **PASS**, zero hits in either of this lane's files.
- **PROVENANCE, honestly.** SCRIPTED model frames through the real server and real bridge, as for every pass
  on this surface; the browser round is a REAL headless browser driving the real client over the real
  socket, but against that same scripted engine. A terminal frame arriving before its own `task_started` on
  one live stream is SYNTHETIC (labelled in the scenario header) — it is the smallest driver of the REAL
  row-less path that re-attach and `skip_transcript` shapes reach.
- **Still open / handoff:** (a) **AN INDEPENDENT CLEAN-ROOM VERIFY IS WARRANTED AGAIN** — fourth BROKEN
  verdict on this surface, session-lifecycle and regression-prone; generation must not be its own only
  judge. Useful attacks for the next pass: is there any OTHER frame type or ordering where "no row" is
  treated as a state the row-present rules were never asked about? A blanket retires the id from the level
  mirrors permanently (`#terminallyReportedTasks` is never cleared) — can a task that is legitimately
  RE-ANNOUNCED as live background work after a blanket be starved of its level entry, and does that reach
  the detached-close fuse? Does the conflict registry's "first seen vs latest" pairing still read correctly
  after three frames? (b) Deploy still needs a `:4317` restart.
- **Verified-by:** dispatch openai run 01a016ce-844f-7a11-b2c9-00a617973683 (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN

## 2026-08-19 — 5th independent clean-room verdict: BROKEN. A session-wide blanket permanently vetoed a later, real liveness signal (fixed)

**THE FINDING, AS RECEIVED.** The 4th-verdict fix removed the fabrication direction (a row-less teardown
blanket can no longer be promoted into a death) but left the blanket writing the id into
`#terminallyReportedTasks`, which is the veto BOTH liveness write sites read — the
`background_tasks_changed` rebuild and `task_started`'s background-birth tag — and which nothing ever
cleared. So a task the engine RE-ANNOUNCED as live background work afterwards could never regain its level
entry. The verdict's own script was explicit that it did not execute this: it regex-asserts four source
facts and hand-simulates the consequence.

**REPRODUCED LIVE FIRST, AND IT HOLDS.** Driven through the real server and real bridge (scripted engine
frames only), scenario `reannounce`: a blanket names `reann` with no row; the engine then announces `reann`
as live background work (level frame FIRST, `task_started` second — the SDK leaves that ordering
unspecified) with a foreground subagent of its own; the turn ends while both are genuinely working.
Measured on `991ac79`: `allEnded=["reann:unknown","reannChild:unknown", …]` — the starved task AND its
child recorded dead while the engine was still declaring the parent live. Not a simulation: those are the
ledger rows the real bridge wrote.

**THE DOWNSTREAM DIRECTION THE VERDICT COULD NOT TEST — IT IS WORSE THAN THE SPARING.** `workLifetime()`
IS the level mirror, and `releaseSocketSession` CLOSES a dropped-socket session on `outlivesTurn === 'no'`
(a close reaps the broker, whose SIGTERM kills the work). Scenario `reanndetach`, measured on `991ac79`:
the starved level answered "the engine reports no background task is running", the drop took the CLOSE
branch (no "detached instead of closed" line in the server log), and the ledger recorded
`reannD:unknown` + `reannDChild:unknown` — while the snapshot came back `source:"survivor"` with the lane
still listed, i.e. **the CLI's own broker was still declaring live the lane this bridge had just written
into the ledger as dead.** The engine contradicting our ledger, in the same payload.

**THE RULE, AND THE ASYMMETRY IT RESTS ON.** Terminal evidence exists so a stale level entry cannot
resurrect a task the engine said was finished (1st verdict) — that must not be undone. But evidence that
can never be withdrawn turns a session notice into a permanent veto. The 4th verdict already separates the
two kinds of terminal frame for ESTABLISHING outcomes; the same separation decides what may be WITHDRAWN:

> An **established per-task outcome** is the engine's verdict about THIS task and is never withdrawn — a
> finished task stays finished, and no level frame, however fresh, resurrects it. A veto with **no
> established outcome behind it** was written by a frame that could not settle a row — in practice a
> session-wide blanket that was never about this task — and is withdrawn by the task's own `task_started`,
> which is positive engine evidence that the task is live NOW and is strictly newer than the blanket.

**Made structural, because the last two rounds each stated a correct rule in prose and had it drift within
one round:**
- `#terminallyReportedTasks` is now a pure append-only OBSERVATION LOG (conflict arithmetic only).
  `#retiredTasks` is the LIVENESS VETO — the same evidence, made withdrawable — and is what both liveness
  sites read.
- The veto has exactly ONE deletion site, `#withdrawLivenessVeto()`, whose first act is
  `if (this.#establishedOutcomes.has(taskId)) return`. Check (70) pins that shape.
- The engine's level frame is kept RAW in `#levelRaw`, and `#backgroundTasks` is DERIVED as (raw − veto) by
  `#rebuildBackgroundLevel()` — the only assignment to it — recomputed whenever either input changes.
  Check (71) pins that. This is what makes the FRAME ORDER stop being a variable: "level before the
  announcement" and "level after" are the same computation over the same two inputs. (A withdrawal-on-
  `task_started`-only fix would have left the level-first ordering still starved, because a level frame
  also clears `#bgDispatchToolUseIds`, so the birth tag cannot rescue it either.)

**WHAT IS NOW UNREPRESENTABLE vs MERELY GUARDED.**
- *Unrepresentable:* a task with an engine-established outcome regaining level membership or a birth tag
  (one veto set, one guarded deletion); and the answer depending on which frame arrived first (one
  derivation over two inputs).
- *Guarded:* a stream that re-announces a task that is really dead and that the engine never gave a verdict
  on. The withdrawal grants no immunity — it restores the ORDINARY rules, under which the row is spared
  only while the engine's level actually lists it and is honestly settled at the first boundary it does
  not. The cost is a deferral; the cost of the veto standing was a fabricated death.

**BOTH DIRECTIONS PROVED, ON THE SAME ROW WHERE POSSIBLE.**
- (55)(56)(57) re-announced work is not recorded dead, its foreground subagent is not either, and the
  re-admission survives the next level frame and the next boundary.
- (58) the SAME row then really finishes (`task_updated completed`) with a stale level frame right behind
  it: it settles, is not re-admitted, and the child's owed death is recorded exactly once — the 1st
  verdict's invariant re-proved on a row that was legitimately re-admitted first.
- (60)(61) the over-permissive fix is ruled out by consequence: `done1` got a per-task verdict before its
  row, was then re-announced AND listed by a level frame; it stays settled (one `agent-completed`, never
  `agent-started`), and its foreground subagent's honest death IS recorded. A "any `task_started` clears
  the evidence" rule fails here.
- (59) direction (a) untraded across all four sweeps; every main-thread orphan records exactly once.

**ALSO COVERED, being the three things the 5th pass listed as untested:**
- **The close-on-detach consequence** (65)(66): with the fix the drop logs `detached instead of closed —
  work outlives the turn (yes: …)`, the session's own snapshot (not the survivor's) still holds both rows,
  and neither is on the ledger.
- **The real browser after a re-announcement** (67)(68)(69): headless Brave over CDP, the real composer's
  Enter path, a turn HELD OPEN so the display is read mid-flight and again after the boundary. After the
  turn ends `reannUI` is still a ◐ row in the real DOM and in the server snapshot, while the main-thread
  control `liveOne` is gone from the strip with its honest death on the ledger. Pre-fix the strip was EMPTY
  — the user watched live work vanish at the boundary.
- **The conflict registry after three or more frames** (62)(63)(64): `completed→failed→killed`,
  `completed→failed→failed` and `completed→failed→blanket`, each driven row-late AND row-present. The
  ledgers match pairwise, the death is the first one named, recorded once, never reclassified by the third
  frame, and the warning carries all three in arrival order identically in both orderings. **Honest limit,
  asserted as such:** the ledger `detail` quotes the conflict AS KNOWN WHEN THE ROW WAS WRITTEN (the second
  frame) — the ledger does not retract, so the third report is in the server warning only. No defect found
  in the pairing.

**AN OUT-OF-LANE FINDING, RECORDED NOT ASSERTED (worth its own ticket).** With the fix, the strip correctly
shows the re-announced background lane running after the turn ends, but the client's own BUG-030 turn-end
sweep (`settleCut()` in `public/app.js`, on the assumption that nothing from a turn can outlive its
`result`) settles that agent's CARD as **"cut by shutdown"** — measured `agents.reannUI === 'cut'` while the
strip says ◐. Strip and card therefore disagree for ANY live background work at ANY turn boundary; this is
not introduced here and `public/app.js` was another lane's live file this round, so it is reported rather
than fixed. The observation is carried in check (68)'s printed evidence so it cannot be lost.

**Numbers, as printed.** `verify-bug-105-foreground-subagent-of-live-owner.mjs` **73/73 exit 0** (was 56).
MUST-FAIL first, live on the unmodified tree at `991ac79`: **(55) (56) (57) (58) (63) (65) (66) (68) FAIL**
— `reann:unknown`, `reannChild:unknown`, `reannD:unknown`, `reannDChild:unknown`, empty strip — while
**(59) (60) (61) (62) (64) (67) (69) PASS pre-fix**, i.e. the anti-resurrection and direction-(a) checks are
not bought by the fix. ((63) failed pre-fix only because it was first written to expect the full three-frame
sequence on the ledger row; it now asserts the honest limit above and the log sequence, and passes.)

**Anti-regression, all exit 0:** ARCH-003 `open-tool-calls` **35/35**, `growth-bound` **25/25**,
`owner-lifetime` **13/13**, `per-row-owner-sweep` **5/5**, `adversarial-nested-terminal-owner` **7/7**,
`adversarial-boundary-between-signals` **6/6**, `adversarial-id-reuse-chain-truncation` **7/7**,
`adversarial-reservation-corpus` **6/6**, `adversarial-reservation-window` **9/9**,
`adversarial-result-before-open-growth` exit 0 (`resident:0, bounded:true`); `verify-bug-096` **17/17**,
`verify-running-snapshot` **47/47**, `verify-stall-detector` **33/33**, `verify-feat-064-drain-truth`
**18/18**, `verify-agent-outcomes` **45/45**, `verify-liveness-conformance` **96/96**,
`verify-close-background-detach` **27/27**. `npm run gate` (unpiped, status read directly): **PASS, exit 0**
(leak-gate, check-nul, typecheck).

**NOT GREEN, NOT MINE, BASELINED THIS ROUND:** `verify-zombie-busy` **35/39 exit 1** — the same four
approval-card checks. Baselined by running it against a pristine `git archive HEAD` export in `/tmp`:
**identical 35/39 with the identical four failures**, so it is untouched by this change.

**PROVENANCE, honestly.** SCRIPTED model frames through the real server and real bridge, as on every pass
on this surface; the browser round is a REAL headless browser driving the real client over the real socket
against that scripted engine. A terminal frame arriving before its own `task_started` on one live stream is
SYNTHETIC (labelled in the scenario headers) — it is the smallest driver of the REAL row-less path that
re-attach and `skip_transcript` shapes reach.

**Still open / handoff:** (a) **A SIXTH INDEPENDENT CLEAN-ROOM VERIFY IS WARRANTED** — fifth BROKEN verdict
on this surface, session-lifecycle and regression-prone; generation must not be its own only judge. Useful
attacks: with the veto now withdrawable, is there a stream where an id is re-announced, withdrawn, and then
the OLD blanket's conflict record makes a later honest death read wrong? Does a withdrawal interact with the
cross-process boundary (a resumed bridge has empty state — nothing to withdraw, but the ledger crosses)?
Can a `task_notification completed` for a `local_bash` task — which BUG-030 says is that task's ONLY
terminal frame — arrive with no row, establish nothing, and then be withdrawn by a re-announcement it
should not be? (b) The `public/app.js` `settleCut` vs live-background-work contradiction above. (c) Deploy
still needs a `:4317` restart.

**regressed-from:** BUG-105 `991ac79` (the 4th-verdict fix introduced the permanent veto's reach; the veto
itself dates to the 1st verdict).

- **Verified-by:** dispatch anthropic run 28c7b7da-927e-4c29-9850-9b62d84d8f5a (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN

---

## 2026-08-19 — 6th independent clean-room verdict: BROKEN, and the line was drawn on the wrong thing

**THE DEFECT, exactly as the 6th verdict found it** (its script,
`scripts/adv-bashcompleted-reannounce.mjs`, reproduced here first on the unmodified tree at `59c50d0`, live
through the real server and the real bridge):

```
snap2.running = [ 'bashDone', 'bashChild' ]
bashDone endedEver = []
bashDone running rows after re-announce = 1 (MUST be 0)
BROKEN: a task the engine positively reported COMPLETED was resurrected as live background work
exit 1
```

`#terminalFrameSettles` answered `rowState === 'running'` for a `notification` **regardless of its
status**. So a row-less `task_notification status:"completed"` — which BUG-030 records as the ONLY terminal
frame a `local_bash`/tool task ever gets — established no outcome, leaving only the WITHDRAWABLE liveness
veto; a later `task_started` withdrew it, re-admitted the finished task as live background work, and spared
its child. This is the attack this ticket's own previous handoff listed as (c). It also silently threw away
every row-less per-task FAILURE a notification carried: `notifFail` was settled by this bridge's own
turn-end inference as `notifFail:unknown` instead of the engine's `failed`.

**THE FIX — the line is what the frame SAYS, not which frame type carried it.** The 4th verdict drew it at
frame TYPE (patches establish outcomes, notifications never do). That is wrong in both directions. The real
distinction, checked against the SDK's own type rather than assumed
(`SDKTaskNotificationMessage.status` is exactly `'completed' | 'failed' | 'stopped'`; this bridge also maps
a defensive `'error'`→`failed` and `'killed'`→`killed`, and anything else is not terminal at all):

- **SELF-REACHED endings** (`completed`, `failed`) can only be produced by the one task that reached them,
  so they ARE the engine's per-task verdict and settle exactly like a `task_updated`.
- **ENDINGS IMPOSED FROM OUTSIDE** (everything this bridge maps to `killed`: raw `stopped`, `killed`) stay
  demoted. `stopped` is genuinely ambiguous AT THE FRAME — the SDK documents it both as the per-task answer
  to a `stop_task` request and as what a SIGTERM'd CLI emits for EVERY still-open task — so it is read as
  the blanket, which is the safe read and preserves the 5th verdict.
- **AND A ROW-LESS NOTIFICATION IS STILL REFUSED ONCE THE TASK IS SETTLED.** With a row present the
  `running` test already says this; `'absent'` needed the same question asked of the only place a row-less
  settlement is remembered, so `#terminalFrameSettles` consults `#establishedOutcomes` (before
  `#retireTask` writes to it). Without that clause the fix would have created a FRESH parity break:
  `task_updated completed` then `task_notification failed` writes no ledger row with the row present, and
  would have written a `failed` one with the row late.

**WHAT IS NOW UNREPRESENTABLE:** a blanket teardown becoming an engine-reported per-task death; a task the
engine positively reported finished being resurrected (the verdict is ESTABLISHED whichever frame carried
it, and `#withdrawLivenessVeto`'s single guard refuses to withdraw a veto an established outcome is
behind); a notification producing a second, disagreeing outcome (an established outcome makes it
non-settling, so it cannot reach the replacement clause). **WHAT REMAINS MERELY GUARDED:** a genuine
per-task `stop_task` result arriving row-less establishes nothing (indistinguishable from the blanket at
the frame — distinguishing it needs evidence the frame does not carry); the eventual row still records its
honest turn-end death, so no death is silently dropped. And a task id REUSED by the engine after a
completion verdict can never be admitted as live again — "finished stays finished" is a statement about the
id; task ids are per-session unique in every stream observed here, and this is the first trade to revisit
if that changes.

**BOTH DIRECTIONS, IN BOTH FRAME ORDERINGS, ON ONE RUN** (new scenario `notifverdict`, so they cannot be
traded for one another): (72)(73) a row-less per-task `completed` for `notifDone` (level-frame-first) and
`notifDoneB` (`task_started`-first) is NOT withdrawable — neither is live after the re-announcement, no
`agent-started` is emitted for the finished root, and `notifDoneChild`'s honest death is recorded exactly
once. (74) the SAME run's `notifBlanket` / `notifBlanketB` were named only by a `stopped` blanket in the
same two orderings and ARE still live, with their foreground subagent spared — the 5th verdict's property,
untraded. (75) `notifFail` reaches the ledger as the engine's own `failed`. (76) parity: `parityLate` and
`parityRow` land identical (empty) ledgers.

**WHAT THE 6th PASS COULD NOT COVER, COVERED HERE.**
- **The real-browser display of this specific resurrection** (it was confirmed only at the running-snapshot
  and ledger level). New scenario `notifui` + real headless Brave over CDP, driving the real composer's
  Enter path against a HELD-OPEN busy turn: (80) mid-turn, with other lanes genuinely running,
  `doneNotifUI` is NOT a ◐ row in the strip and the server snapshot agrees, while the control `liveOne` IS
  running; (81) `blanketNotifUI` — the other direction, in the same frame — IS a running row mid-turn and
  after the boundary; (82) after the held turn ends nothing is left spinning and `liveOne` is contained
  with its honest death. (80) and (82) FAIL live on the synthesized `59c50d0` predicate.
- **Does a genuine engine emit a row-less per-task completion and then re-announce the same id?** Evidenced
  read, calibrating urgency not necessity: the ROW-LESS COMPLETION half is REAL and routine — the CLI emits
  `task_notification status:"completed"` as a tool task's only terminal frame (BUG-030, probe-verified
  v2.1.220), and this bridge creates NO row for a `task_started` carrying `skip_transcript: true`, plus the
  documented re-attach shape where the level lists work that predates this bridge. The RE-ANNOUNCEMENT half
  is not attested for a task the engine already reported completed: no probe log on this surface shows an
  id re-announced after its own per-task completion, and the SDK gives task ids no documented reuse. So the
  live incident probability today is LOW; what is not low is the cost of the rule that caused it — every
  row-less per-task verdict a notification carries was being discarded, which (75) shows corrupting the
  ledger with no re-announcement involved at all.

**A NOTE ON THE 6th VERIFICATION'S OWN TRUST.** Its cross-provider attempt reached the harness but its
sandbox could not talk to the run recorder, so that answer was mechanically invalid and the pass fell back
to the author's provider — decorrelation was reduced. Judged on the REPRODUCTION, not the provider: the
script was re-run here on the unmodified tree and failed exactly as reported.

**Numbers, as printed.** `verify-bug-105-foreground-subagent-of-live-owner.mjs` **84/84 exit 0** (was
73/73). MUST-FAIL first against a SYNTHESIZED pre-fix predicate (the `59c50d0` body written back in place —
never `git show`, per CONVENTIONS): **79/84 exit 1, with (72) (73) (75) (80) (82) FAIL** and every other
check — including all of (55)–(71), the 5th verdict's own — PASSING pre-fix, i.e. this fix is not bought
with them. Honest limit of that anchor: structural check (78) passes on it too, because the synthesized
body leaves the new lines unreachable below an early `return`; (78) is a shape guard against future edits,
not a must-FAIL. The clean-room script itself: **exit 1 before, exit 0 after**
(`bashDone running rows after re-announce = 0`).

**Anti-regression, all exit 0:** ARCH-003 `open-tool-calls` **37/37**, `growth-bound` **25/25**,
`owner-lifetime` **13/13**, `per-row-owner-sweep` **5/5**, `adversarial-boundary-between-signals` **6/6**,
`adversarial-id-reuse-chain-truncation` **7/7**, `adversarial-nested-terminal-owner` **7/7**,
`adversarial-reservation-corpus` **12/12**, `adversarial-reservation-window` **9/9**,
`adversarial-result-before-open-growth` exit 0 (`resident:0, bounded:true`); `verify-bug-096` **17/17**,
`verify-running-snapshot` **47/47**, `verify-stall-detector` **33/33**, `verify-feat-064-drain-truth`
**18/18**, `verify-agent-outcomes` **45/45**, `verify-liveness-conformance` **96/96**,
`verify-close-background-detach` **27/27**, `verify-bug-068-bash-background-visible` **5/5**. Full
`tsc --noEmit` clean; `npm run gate` unpiped, exit status read directly.

**NOT GREEN, NOT MINE, BASELINED THIS ROUND:** `verify-zombie-busy` **35/39 exit 1** — the same four
approval-card checks the last round baselined, untouched here. `verify-stale-agent-cards` (BUG-030,
real-model + real systemd-cut, deploy-shaped) is **FLAKY on its "Cut by shutdown" caption check**: measured
this round at **11/12 exit 1 then 12/12 exit 0 twice from an IDENTICAL isolated worktree containing only
this change**, with HEAD-without-the-change also 12/12. Identical state flipping outcome is flakiness, not
attribution; recorded so the next round does not re-litigate it.

**PROVENANCE, honestly.** SCRIPTED model frames through the real server and real bridge, as on every pass
on this surface; the browser rounds drive the real client in a real headless browser over the real socket.
The clean-room reproduction script is the 6th verdict's own, unmodified except for its scratch root and
module resolution.

**Still open / handoff:** (a) **A SEVENTH INDEPENDENT CLEAN-ROOM VERIFY IS WARRANTED** — sixth BROKEN
verdict in a row on this surface, session-lifecycle and regression-prone; generation must not be its own
only judge. Useful attacks: with `#establishedOutcomes` now consulted INSIDE the settle predicate, is there
an ordering where the map is read before the frame that should have written it (a patch and a notification
for the same task in the same tick)? Does the id-reuse trade bite any real stream — an engine re-announcing
a `local_bash` id after its completion notification would now have its lane refused liveness, which is the
mirror-image failure of the one just fixed. Does a per-task `stop_task` `stopped` result for a row-less
task lose a death that matters? (b) BUG-113 (`public/app.js` `settleCut` vs live background work) is
unchanged and still visible in this suite's printed evidence. (c) Deploy still needs a `:4317` restart.

**regressed-from:** BUG-105 `991ac79` / `59c50d0` (the 4th-verdict fix introduced the frame-TYPE rule; the
5th-verdict fix made the veto withdrawable, which turned that rule into a resurrection).

- **Verified-by:** dispatch openai run 01a01738-b7a7-75a3-9278-8d153c0df8ca (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN

---

## 2026-08-19 — 7th independent clean-room verdict: BROKEN, and the fix

**THE VERDICT'S CASE** (`scripts/adversarial-blanket-live-row.mjs`, preserved in the clean room under the
configured scratch root as `cleanroom-verify-yiolVS`; it derives itself from this ticket's own verify
script, so it runs the real server and the real bridge):

```
node scripts/adversarial-blanket-live-row.mjs → exit 1
FAIL blanket stopped notice never becomes a per-task verdict when the row already exists
observed: {"ended":["killed"],"rows":0,"provenance":"SCRIPTED FAKE CLI through real server and real bridge"}
```

**REPRODUCED FIRST, UNMODIFIED, ON `08ecda4`** — exit 1 with exactly that line. After the fix, exit 0
(`{"ended":[],"rows":1}`). The script is now committed at `scripts/adversarial-blanket-live-row.mjs`.

**THE HOLE, precisely.** The 6th round wrote "a blanket establishes nothing" and implemented something
weaker. `#terminalFrameSettles` asked `rowState === 'running'` BEFORE it looked at the status, on the
reading that *a row this bridge holds running is itself the evidence that even a blanket is about live work
of ours*. That reading is false. At a real teardown EVERY still-open task gets this frame, so the tasks
with running rows are exactly the ones the blanket is LEAST specific about — including a foreground
subagent whose ancestor is still live on the engine's background level. **"Demoted" is not the same as
"not a verdict":** with no row the demotion correctly fabricated nothing; with a row it still wrote a
death, settled the row and removed it from the strip while the work continued. Every fixture only ever
expected an existing row to become `killed`, so nothing caught it.

**THE FIX — one rule, no row-state arm** (`src/server/agent-bridge.ts`, `#terminalFrameSettles`):

```ts
if (authority === 'patch') return true;
if (status === 'killed') return false;          // the BLANKET — before any rowState is read
if (rowState === 'running') return true;        // a SELF-REACHED ending: completed / failed
if (rowState !== 'absent') return false;
return !this.#establishedOutcomes.has(taskId);
```

`killed` is where the outside-imposed notification statuses (raw `"stopped"`, the defensive `"killed"`
alias) map. The blanket arm is now decided before `rowState` exists as a consideration, so there is no row
state, ordering or ancestor arrangement that lets a blanket reach either of the two places a per-task death
can be written (`#establishedOutcomes`, which `task_started` applies to a late row; and the two
terminal-frame handlers' row writes, both gated on `settles`). Check (78) pins the ORDER of the two arms,
not just their presence.

**WHAT THEN HAPPENS AT A GENUINE TEARDOWN** falls out of the ordinary inference path rather than from a
frame pretending to be a verdict: the liveness veto still retires the task from the level (that part IS
what the frame says), the row stays `running`, and it is settled and recorded by whichever inference
reaches it — the turn-end sweep (`unknown`, or `killed` on an interrupt) or `#recordSessionEnd` (`cut`).
`outcomes.record` is first-wins per `agentId`, so a teardown death is recorded **exactly once** by
construction, not by the frame path and the sweep agreeing. Measured: `liveA`/`liveB` (check 41) went from
`killed` to `unknown`, which is now IDENTICAL to the no-blanket control — the blanket's trace on the outcome
path is not merely absent-when-row-less, it is total.

**THE SDK'S DOUBLE MEANING, stated rather than left implicit.** `status:"stopped"` is documented BOTH as
the per-task result of a `stop_task` request AND as what a SIGTERM'd CLI emits for every still-open task
(probe-verified v2.1.220); nothing in the frame distinguishes them. This rule therefore silences the
genuine per-task stop too: a `stop_task`ed agent no longer records the engine's `killed`, it records the
inference's `unknown`/`cut` at the next boundary that contains it, and is spared while a live ancestor
holds it. **The trade is right because the errors are not symmetric** — reading a blanket as a stop kills
live work and hides it from the strip mid-flight (the reported incident, twice), while reading a stop as a
blanket costs a deferral and a less specific cause on work that really did end; no death is lost, only
named less precisely. Distinguishing them needs evidence the frame does not carry (a `tool_use_id`
correlation, or the CLI tagging the blanket).

**UNREPRESENTABLE vs MERELY GUARDED** (the word "guarded" has been the next defect on this ticket family
three rounds running, so the list is deliberately short):
- *Unrepresentable*: a blanket becoming a per-task death in ANY row state; a positively-reported-finished
  task being resurrected; a second disagreeing notification outcome; **and a teardown death going
  unrecorded as the price of the above** — nothing in this predicate can suppress a write, only decline to
  make one from this frame.
- *Merely guarded*: the genuine `stop_task` result (indistinguishable by policy — see the trade above);
  a task id REUSED after a per-task completion verdict.

**FOUR DIRECTIONS, PROVED TOGETHER** on one stream (`blanketrow`), because each has already been a verdict
here and they pull against each other:

| direction | checks | evidence |
|---|---|---|
| a blanket never fabricates a per-task death — record present or absent, ancestor live or retired | (83) (84) (85) (39) (43) | `fgLive` (row present, ancestor LIVE) `ended=[] rows=1` in both sweeps; zero `agent-completed` on the socket |
| a blanket never permanently starves a task the engine later declares live | (87) (74) | `bgRow` (row present when blanketed) is a running row again after turn two's re-declaration |
| a genuine per-task report still reaches the ledger with the engine's outcome, either frame order, record present or absent | (88) (42) (75) (76) | `verdictRowF`/`verdictLateF` → `failed`; `verdictRowC`/`verdictLateC` → nothing, no spinning row; `patchRow` → `failed` — all arriving in the SAME teardown burst as the blankets |
| a task that genuinely dies at teardown is still recorded, exactly once | (86) (41) (89) | `orphanRow` (no chain, nothing spares it) `unknown` once in sweep #1, still once after sweep #2, row gone; `liveA`/`liveB` one row each, equal to the no-blanket control |

**WHAT THE PREVIOUS PASS COULD NOT COVER, NOW COVERED: the DISPLAY.** The adversarial case was never
repeated in a browser. New scenario `blanketrowui` + checks (90)–(93) drive it in real headless Brave over
CDP (theme via `Emulation.setEmulatedMedia` `prefers-color-scheme`, never localStorage on `about:blank`),
through the real composer's Enter path, against a turn held open mid-flight. **On `08ecda4` the strip
mid-turn reads `["main:run","liveOne:run","rootUI:run"]` — the still-working subagent is simply gone, and
`endedAfter` carries `fgLiveUI:killed`.** After the fix it reads `["main:run","liveOne:run","rootUI:run",
"fgLiveUI:run"]` mid-turn and `["rootUI:run","fgLiveUI:run"]` after the boundary, with nothing in the
ledger. Check (93) is the control that stops (91)/(92) passing by making notifications inert: `doneUI`, a
per-task `completed` on its own existing row in the same burst, leaves the strip.

**A TEST-HARNESS DEFECT FOUND BY THE MUST-FAIL, AND FIXED.** `runTurns()` never published its socket frames
into `lastEvents`, so every `const xEvents = lastEvents` after a `runTurns(...)` was silently reading the
PREVIOUS scenario's stream. Caught because new check (85) — "no `agent-completed` for `fgLive` went out" —
PASSED on `08ecda4`, the very defect it was written to catch. Fixed; the must-FAIL count went 8 → 9.

**NUMBERS, as printed.**
- `scripts/verify-bug-105-foreground-subagent-of-live-owner.mjs`: **95/95 exit 0** (was 84/84; +11 checks).
- Same script against a tree built from `git archive 08ecda4` with only this script copied in:
  **86/95 exit 1**, failing exactly (41) (78) (83) (84) (85) (86) (87) (91) (92) — the nine new/revised
  checks, nothing else.
- `scripts/adversarial-blanket-live-row.mjs`: **exit 1 before → 1/1 exit 0 after.**

**Anti-regression, all exit 0:** ARCH-003 `open-tool-calls` **39/39**, `growth-bound` **25/25**,
`owner-lifetime` **13/13**, `per-row-owner-sweep` **5/5**, `adversarial-boundary-between-signals` **6/6**,
`adversarial-id-reuse-chain-truncation` **7/7**, `adversarial-nested-terminal-owner` **7/7**,
`adversarial-reservation-corpus` **12/12**, `adversarial-reservation-window` **9/9**,
`adversarial-result-before-open-growth` exit 0; `verify-bug-096` **17/17**, `verify-running-snapshot`
**47/47**, `verify-stall-detector` **33/33**, `verify-feat-064-drain-truth` **18/18**,
`verify-agent-outcomes` **45/45**, `verify-liveness-conformance` **96/96**,
`verify-close-background-detach` **27/27**. `npm run gate` **PASS, exit 0** (leak-gate + check-nul +
typecheck), unpiped, exit status read directly.

**NOT GREEN, NOT MINE, BASELINED BOTH SIDES OF THIS CHANGE:** `verify-zombie-busy` **35/39 exit 1** before
and after, the same four approval-card checks. `verify-stale-agent-cards` **12/12 exit 0** post-fix (a
second confirmation run exceeded this dispatch's wall clock; the known 11/12↔12/12 flake profile is
unchanged). A baseline gotcha worth recording: running these suites with `TMPDIR` under a DOTTED path
(`~/.cache/...`) makes the `crossboundary` scenario FATAL and `verify-close-background-detach` read 21/27 —
the CLI's directory encoding mangles the dot. Scratch under `/run/user/$UID` instead; all numbers above are
from there.

**PROVENANCE, honestly.** SCRIPTED model frames through the real server and real bridge, as on every pass
on this surface; the browser rounds drive the real client in a real headless browser over the real socket.
The verdict's reproduction script is unmodified.

**Still open / handoff:** (a) **AN EIGHTH INDEPENDENT CLEAN-ROOM VERIFY IS WARRANTED** — seventh BROKEN
verdict in a row on this surface; session-lifecycle, regression-prone, and this round's fix deliberately
changes what a real teardown RECORDS (`killed` → `unknown`/`cut`). Useful attacks: does any consumer of the
ledger (briefing, reporting, the `cut` cluster rendering) read the old `killed` kind for teardown rows and
degrade? Is there a shape where a blanketed row is spared by a live ancestor and then NOTHING ever settles
it — an ancestor that is live forever on a stale level entry — i.e. a leak of the deferral rather than of a
death? Does `#recordSessionEnd`'s `resultDelivered` skip drop a blanketed row's death when the Task
tool_result arrived for a DIFFERENT reason? (b) BUG-113 (`public/app.js` `settleCut` vs live background
work) is unchanged and still visible: check (92) records `clientCardStateForFgLiveUI: "cut"` while the strip
correctly keeps the lane — the identical value check (81) records. Not this lane's file. (c) Deploy still
needs a `:4317` restart.

**regressed-from:** BUG-105 `08ecda4` (the 6th-verdict fix drew the line at what the frame SAYS but kept a
`rowState === 'running'` arm in front of it, so the blanket stayed a verdict wherever a row existed).
