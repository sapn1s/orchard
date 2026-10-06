```orchard-ticket
{
  "id": "BUG-140",
  "type": "bug",
  "title": "Agents waiting on work that already ended still look busy",
  "summary": "Five agents sat for over half an hour waiting on verification runs that had already been stopped. Each showed as running, so nothing told them apart from real work. The stall warning built for exactly this class never fired: a waiter's own sleeping process counts as proof that the work is alive.",
  "impact_if_we_wait": "One such wait is still sleeping now, more than forty minutes after the run it watched ended, and nothing will ever end it. Bounded: no result is falsified and no stored data is touched. The cost is a person's attention and the minutes spent proving the work is dead.",
  "current_need": "Choose between preventing a wait that outlives its work and surfacing one as stalled, then have the chosen guard built.",
  "severity": "medium",
  "area": "Waiting on long verification runs",
  "reported": "2026-08-22",
  "reported_by": "user",
  "owner": "you",
  "work_state": "open",
  "human_action": "decide",
  "updated": "2026-08-22",
  "decision": {
    "mode": "single",
    "question": "Should a wait that outlives the work it watches be made impossible, or made visible?",
    "options": [
      {
        "key": "A",
        "label": "Refuse a parked wait",
        "what_changes": "A background command whose only job is to sleep until something appears is refused before it starts.",
        "benefit": "The failure cannot be created at all, so nothing has to notice it afterwards.",
        "cost": "The refusal has to recognise the shape reliably, and the tool guidance every agent reads still recommends that shape.",
        "why_not_obvious": "A legitimate wait on something that outlives the session would be refused with no way through."
      },
      {
        "key": "B",
        "label": "Judge the watched work",
        "what_changes": "Whether a waiting row is progressing is judged from the work it watches rather than from the waiter's own process.",
        "benefit": "A wait on dead work becomes a visible warning without anyone probing processes by hand.",
        "cost": "Needs a per-row progress signal the engine does not supply today, plus a rule for what counts as movement.",
        "why_not_obvious": "A slow but healthy wait would be warned about, which is the false alarm this warning was designed to avoid."
      },
      {
        "key": "C",
        "label": "Bound every wait",
        "what_changes": "Every wait carries a deadline, exits at it, and reports what it last saw.",
        "benefit": "No wait can outlive the work it watches by more than that deadline.",
        "cost": "Nothing announces the failure, so an endless wait becomes only a late one.",
        "why_not_obvious": "Nothing would enforce the deadline, so the discipline lapses exactly when whoever writes the wait is in a hurry."
      },
      {
        "key": "D",
        "label": "Spot it by hand",
        "what_changes": "Nothing is built, and whoever notices a quiet agent checks the processes themselves.",
        "benefit": "No work, and this occurrence was caught and stopped by a person within the hour.",
        "cost": "The shape has recurred across ten separate days in this project, and each recurrence costs someone's attention.",
        "why_not_obvious": "The wait is invisible while nobody is looking, so a quiet stretch is not evidence that it stopped happening."
      }
    ],
    "recommendation": null,
    "recommendation_reason": null,
    "prerequisite": "Establish what the engine reports about a background task beyond the fact that it exists. Without a per-task progress signal, judging the watched work has nothing to read."
  },
  "decision_history": [],
  "success_criteria": [
    "A wait whose watched run has ended either stops within a bounded time or is shown as stalled",
    "A wait that is genuinely still progressing is never flagged, however quiet it is",
    "A case built from the wait that is still sleeping today fails before the change and passes after"
  ],
  "code_refs": [
    {
      "path": "src/server/stalls.ts",
      "symbol": "judgeStall",
      "note": "rung 2 — `if (input.signal?.live) return { stalled: false }`. The waiter is alive, so the row is never stalled, however long the work it watches has been dead."
    },
    {
      "path": "src/server/agent-bridge.ts",
      "symbol": "stallSignalFor",
      "note": "returns live:true for any id in #backgroundTasks or #bgBornTasks. A run_in_background bash poll loop qualifies by construction, so it vouches for itself."
    },
    {
      "path": "src/server/running-set.ts",
      "note": "the only caller of judgeStall; passes source.stallSignalFor(agentId) straight through as the live signal"
    },
    {
      "path": "docs/prompts/WORKING_AGREEMENT.v2.md",
      "symbol": "§I",
      "note": "lines 179-187 — 'Never park long-running work behind your own turn end' … 'stalls silently, indistinguishable from idle'. Nothing checks it; no file outside the doc mentions the rule."
    }
  ],
  "related": [
    {
      "id": "BUG-046",
      "relation": "recurrence_of"
    },
    {
      "id": "BUG-113",
      "relation": "see_also"
    },
    {
      "id": "BUG-115",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [
    "BUG-046"
  ],
  "verification": [],
  "verification_class": "plan+review",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": false,
    "Verification plan": false,
    "Migration and rollback": false,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": null,
    "sha256": null,
    "original_title": null,
    "migrated_on": null,
    "migrated_by": null,
    "confirmation": "Authored directly in the record format through scripts/board-tool.mjs.",
    "dropped": []
  }
}
```

# BUG-140 — Agents waiting on work that already ended still look busy

## Symptom
The user, looking at the dashboard:

> 6 agents running, each named wait for suite… are they all waiting and there isn't actually a
> thing that resolves

They were right. Each was a shell loop whose only live child was `sleep 15` or `sleep 20`, watching a
log file for a word that a killed run would never write. Two verification runs had been reported
killed, at 08:33 and 08:38. The loops had no way to tell "still running" from "never coming back",
so they slept. The user stopped five of them by process group.

**The sharpest part of this is the user's own observation, and it is what cost them the time:** from
outside, an agent waiting on something dead is indistinguishable from an agent doing work. The
wasted processes were nearly free. Not being able to tell was not.

## Diagnosis

### Why the wait never ends
The loop's exit condition is a property of a file — `until grep -q "passed\|FATAL" …; do sleep 15;
done`. When the process that would have written that word is killed, the condition becomes
permanently unsatisfiable, and the loop has no second condition to fall back on. Seven of the
thirteen waits written that morning were of this shape. The other six were written as `until ! pgrep
-f "node scripts/verify-git.mjs"` — those carry a liveness escape, and every one of them exited when
the run was killed. So the escape hatch works when it is written. Nothing requires it.

### Why nothing reaps them
Nothing does. There is no reaper for this class anywhere in the tree, and the evidence is not an
absence-of-grep argument: the wait started at 08:18Z was still sleeping when this ticket was
written, 44 minutes later, watching a file that no process holds open and that contains zero matches
for its condition. Left alone it would sleep until the machine reboots. The same directory carries
node processes from cleanroom verification runs that have been alive for over three days.

### Why the warning built for this did not fire — the real defect
BUG-046 built a stall judgment for precisely this incident ("four times in one day, a dispatched
agent registered as running work, launched its long run, the run died, and the agent idled awaiting
a notification that would never fire"). It cannot see this case, by construction:

- `judgeStall` rung 2: a live process signal means the row is never stalled, whatever the timer says.
- `stallSignalFor` returns `live: true` for any id the engine's background-task level lists.
- A `run_in_background` bash poll loop **is** such a task, and it is genuinely, truthfully alive.

So the waiter vouches for itself. The signal answers "is a process running?" while the user's
question is "is anything being produced?", and for a sleeping waiter those two answers point in
opposite directions. This is not a bug in the stall judgment's own terms — the comment above it is
explicit that a false warning on live work is the feature's own failure mode, and it is right to
rank the signal above the timer. It is a gap in what the signal is allowed to mean.

### Why the rule did not hold either
The working agreement already forbids this (§I, "Never park long-running work behind your own turn
end"), and names the exact consequence: the lane "stalls silently, indistinguishable from idle".
Nothing enforces it — no script, gate or hook in this repo mentions the rule. Meanwhile the harness's
own Bash tool description tells every agent the opposite: *"To wait for a condition, use Monitor with
an until-loop (e.g. `until <check>; do sleep 2; done`)"*. A rule written in one document and
contradicted by the tool description an agent reads on every call is a rule that will keep losing.

### What it costs while it waits
Measured, not assumed. It costs a sleeping process, and it costs a row in the running display that
the user has to reason about — that row is what they were asking about. It does **not** hold a
dispatch slot: these are background Bash tasks, not agents. The expensive part is the third cost:
while the row is listed, `stallSignalFor` vouches for it, so the one mechanism that exists to make a
stalled lane visible is actively suppressed by the stalled thing itself.

### Severity — argued, not defaulted
**Medium.** Not high: no verdict is falsified, no stored data is touched, nothing is killed or
misreported, and a person can confirm the truth in one `ps` call — this is unlike BUG-115, where a
green suite was recorded red. Not low: it has recurred across ten separate days in this project, it
cost roughly half an hour of six lanes plus the user's attention this morning, BUG-046 recorded ~1h
lost per stall, and the mitigation built for it does not cover this shape. The false assurance is
what lifts it above low. **Promote to high** if a case appears where the silent wait blocked a
verdict a person then acted on.

## Evidence

**The live one, at the time of writing.** PID 768839, elapsed 44:00:

    eval 'until grep -q "passed\|FATAL" ~/scratch/vg4.log 2>/dev/null; do sleep 15; done; echo finished'

- `grep -c "passed\|FATAL" vg4.log` → `0`
- `vg4.log` last written 11:18:38 local; no entry for it in any `/proc/*/fd` — the writer is gone.
- Condition unsatisfiable, writer dead, waiter alive. Nothing about that combination will change.

**How often.** A scan of every transcript under `~/.claude/projects` for Bash calls whose command
contains a `while`/`until` … `do sleep N` loop (`~/scratch/bug140-poll-loop-scan.mjs`, deduplicated by
timestamp+command). This project: **119 such calls across 10 distinct days** — 2026-08-04, 05, 09,
10, 11, 12, 18, 19, 20, 22. Across all projects on this machine: 1175 calls over 29 days. A regex
heuristic for a liveness or deadline guard (`kill -0`, `pgrep`, `timeout`, a clock) matched 50 of the
119 here, leaving ~69 with no escape at all; treat those two numbers as indicative, since the
heuristic cannot judge whether a guard is correct.

**Today, exactly.** 14 matches, one of which is this investigation's own grep. Of the remaining 13:
six were `pgrep`-guarded and all exited when the run was killed; seven were unguarded log-greps. Six
of those seven outlived their work — five stopped by the user, one still sleeping. That is the six
the user saw.

**Prior instances, same shape, before today.** 2026-08-12 sessions carry `until [ -s
/tmp/feat061-closing-verdict-attempt1.txt ]; do sleep 5; done`. The working agreement records
2026-08-11: two agents, two stalls each, ~1h per stall. BUG-046's header records four in one day.

**Ruled out.** This is not BUG-113 (a live background agent misreported as dead — the opposite
direction, and the row here is honestly reported as running). It is not BUG-115 (a suspend-inflated
timer producing a false red — no machine sleep is involved and no verdict was recorded).

## Risks
- Option B's risk is the one BUG-046 deliberately designed against: warning about work that is
  merely slow. Any per-row progress rule has to survive a legitimately silent ten-minute run.
- Option A refuses a shape the harness's own tool description recommends, so agents will meet a
  refusal that contradicts their instructions unless the guidance is addressed at the same time.
- Whatever is chosen must not kill anything. ARCH-002 makes stall handling advisory, and a wait that
  is wrongly judged dead and killed would be a strictly worse failure than the one being fixed.

## Not implemented
Nothing was changed. This ticket was filed on explicit instruction to file and not fix. No file
outside `docs/bugs/` was touched, and no process was killed or signalled during the investigation.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-22 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-09-29 — agent (FEAT-154 explore lane, round 7): recurrence + two corrections to the diagnosis
- **Recurrence:** 5 waiters in session 7f7e39a1 hung for 37h (details in FEAT-154's 2026-09-29 round-7
  entry). They have the same `until grep …; do sleep; done` shape with no liveness escape. The
  watched suite could never finish (BUG-204).
- **Correction to "Why nothing reaps them":** the CLI *has* a per-agent shell reaper
  (`killShellTasksForAgent` at subagent cleanup). It is deliberately **skipped for an async
  (e.g. `SendMessage`-resumed) agent that still owns a running backgrounded shell**, which keeps the
  agent resumable. That keepalive has no bound.
- **New fact for option C:** none of the 5 was `run_in_background`. They were foreground calls that
  the CLI *moved to the background when their tool `timeout` expired*. So the tool's `timeout`
  parameter does not bound a wait. A bound has to live inside the command (`timeout N`, or
  `kill -0 <pid>`).

### 2026-09-29 — agent (explore lane, finding round 1): reap-at-lane-end plan. The signal exists, and the rule as directed would have killed 2 real verdicts
- **The charter asked:** when a lane ends, stop the commands it never chose to background, and leave
  the ones it started with `run_in_background`. First verify that Orchard can tell the two apart
  from what the CLI declares.
- **Verdict: the signal exists and is owner-declared. `needs-you`, because real transcripts show the
  rule kills work that lanes rely on.** Details follow.

**1. The distinguishing signal: real-CLI capture (CLI 2.1.281, SDK 0.3.281, scratch cwd
`/tmp/bug140-probe`, frames in `frames.jsonl`)**
- Setup: one background subagent (`a641eb1a7a29eb56a`) ran one foreground Bash with `timeout:3000`
  (`bbmoqqrij`, which was auto-moved) and one `run_in_background:true` Bash (`b5innewzf`). The main
  thread ran one foreground Bash with `timeout:3000` (`biq85iyja`).
- **`task_started.is_backgrounded` does NOT distinguish them.** A foreground local_bash gets no
  `task_started` until it is moved. At the move it arrives as `is_backgrounded:true`, identical to a
  deliberate one. The sdk.d.ts claim that "a later move arrives as task_updated patch.is_backgrounded"
  did not happen for local_bash: no such patch was emitted. So nothing may read that field for this.
- **What does distinguish them is the dispatching `tool_use`.** The same `tool_use_id` is echoed by
  `task_started`. Deliberate: `input.run_in_background === true`. Auto-moved: the key is absent or
  false. That is the lane's own declaration, made at start. It is the same frame Orchard already
  parses (`#bgDispatchToolUseIds`, BUG-068).
- **The owner is on the same frame.** The `tool_use` carries `parent_tool_use_id` = the agent's
  Agent-call id, which `task_started(local_agent).tool_use_id` maps to the agent's task id.
  `task_started(local_bash)` also carries an undocumented `owned_by_subagent:true`, but not which
  agent.
- **Corroboration, main thread only:** the structured `tool_use_result` carries
  `backgroundTaskId` + `timedOutAfterMs:3000` for the auto-moved case. Sibling fields are
  `backgroundedByUser`, `backgroundedByTurnAbort` and `backgroundedToDeliverMessage`. **Subagent
  tool_result frames carry no `tool_use_result`** in the stream, only text. So this is not usable
  for lanes, and the text ("moved to the background (ID: x)") must not be parsed.
- **The CLI already declares "bound to its agent" for SYNC subagents:**
  `backgroundEndsWithFinalResponse: true` ("terminated when that agent gives its final response;
  absent when the command survives (main loop, async subagents)"). The gap is async and resumed
  agents only, as found in FEAT-154 round 7.
- **Real samples, both kinds in ONE lane:** subagent a852391c (7f7e39a1) made 8 auto-moved calls,
  none with `run_in_background`. The timeouts were default/120, 180, 200, 240, 300, 360 and 400s.
  These include the 5 hung pollers. The same lane made 3 deliberate calls: `b77fwbj9l`,
  `bm5p30e0f` and `bfy5j58hk` (`run_in_background:true`).
- **Probe also confirmed the async keepalive live.** The agent's `task_notification completed`
  (dt 25.2s) arrived while both of its shells were still running. Each shell's own completion then
  **revived the agent**: a fresh `task_started` with the same id and `is_backgrounded:true`, followed
  by another `completed`. So an agent's `completed` is not final.

**2. The blocking finding: "never chose to background" ≠ "not relying on it" (all 3177 subagent
transcripts on this machine; scan `/tmp/bug140-probe/scan.mjs`)**
- Totals: 434 auto-moved and 1541 deliberate background Bash calls.
- 393 auto-moved calls outlived their lane's `end_turn`. 386 of those never got a notification.
  These are unclassified: most likely sync lanes, whose CLI already kills them, but not proven.
- **7 were followed by a notification that revived the lane:**
  - **5** revived with a text-only acknowledgement. These are the incident pollers.
  - **2** revived and did real work. In both, the auto-moved command was a **clean-room
    independent-verify run**, and the lane ended its turn saying so outright:
    - `9bb51f6f…/agent-a31e305012e430433` `belihn8a5` (2026-09-29 07:34Z): *"I'll await the
      completion notification for belihn8a5"*. Revived at 07:42, read the verdict, ran 8 tool
      calls.
    - `f80d955f…/agent-a6a9d001211ef6230` `b8zoy1ul7` (2026-09-28 22:24Z): *"I'll await its
      completion notification"*. Revived at 22:31 and read a **BROKEN** verdict.
  - Reaping at lane end would have killed both runs and lost two independent verdicts.
- **At lane end, no declared data separates these 2 from the 5.** Both groups are auto-moved and
  owned by an async lane that ended its turn. The only difference is the lane's prose or the
  watched thing's liveness, which are exactly the heuristics the charter forbids. **Built as
  directed, the reap would kill work a lane started on purpose.** That is the concern the user set
  out to protect.

**3. The plan, if the user accepts that cost (option R below)**
- **Declaration at start, by its owner (ARCH-010/ARCH-002).**
  - When the bridge sees a `task_started(local_bash)` whose `tool_use_id` matches a tool_use it
    parsed, it records a lane-lifetime fact keyed by task id:
    `{ ownerAgent, bound: 'lane' | 'own' }`.
    - `bound:'own'` iff that tool_use's `input.run_in_background === true`. Otherwise `'lane'`.
    - `ownerAgent` = the agent task id resolved from the tool_use's `parent_tool_use_id`.
    - Main thread (`parent_tool_use_id` null) → no record, never reaped.
  - This must be a **new per-task record** (`#laneBoundTasks`). It must not reuse
    `#bgDispatchToolUseIds`, which any level frame clears wholesale (BUG-068). It is persisted
    through the same broker/host record that already carries `backgroundTasks` + `since` for
    adoption.
- **Reap point.**
  - Trigger: the owner agent's terminal edge, `task_notification` or `task_updated` with status
    `completed|failed|stopped|killed`, for `ownerAgent`.
  - At that edge, Orchard stops every still-live task with `bound:'lane'` and that owner. Liveness
    is read from the `background_tasks_changed` level, not guessed.
  - This fires on each end, including a resumed agent's second or later `completed`. A revival
    re-opens nothing: any shells it starts get their own records and are reaped at its next end.
- **Stop path.** Reuse FEAT-154 round 6's `AgentSession.stopTask()` → `runtime.stopTask()` →
  SDK `Query.stopTask` → the engine's `stop_task`. It is the same refusal-guarded path the strip's
  stop button uses. There is no pid kill and no new route. Each stop is logged to the agent-outcomes
  ledger as `stopped: lane ended`, so the row says why.
- **Failure modes.**
  - **(a) The lane is resumed later** (SendMessage, or its own shell's notification): the stop
    produces a notification that revives the lane for one turn. This is real: the a852391c
    transcript shows the 2026-09-29 11:03 kills each woke it for a one-line reply. The loop is
    bounded, since each killed shell wakes the lane once. A resumed lane that finds its command
    stopped can relaunch it with `run_in_background`, which is the recovery path for the 2
    verdict cases.
  - **(b) The orchestrator is itself a lane:**
    - Its own shells are main-thread (owner null), so they are never reaped here.
    - A `dispatch.mjs` CLI lane is a separate process whose end is its exit. That is out of scope
      and untested.
    - Nested subagents (spawn_depth 2) resolve to the inner agent through `parent_tool_use_id`.
  - **(c) Server restart between start and end:**
    - The record is persisted, so the post-adoption terminal edge still reaps.
    - Tasks born before the fix, or whose record was lost, have no declaration. They are treated as
      unknown and **never reaped** (the safe side). The FEAT-154 strip's manual stop covers them.
    - If the owner's terminal edge fired while the server was down, the edge is lost. The reap
      must also run on adoption, for records whose owner the level no longer lists.
    - **Untested: the CLI's own behaviour across a host restart.**
- **Proof bar.**
  - **Fixtures:** the captured real frame sequence (`frames.jsonl`, sanitised into
    `scripts/fixtures/bug-140/`) and a replay of a852391c's real ids (8 auto, 3 deliberate,
    owner a852391c416202db5).
  - **Harness:** each fixture is fed to a server on an isolated port and data dir, through the
    BUG-187 fake CLI.
  - **Must-FAIL, against a synthesized pre-fix state, not HEAD:** at the agent's `completed`,
    `stop_task` is sent for `bbmoqqrij` and for the 5 poller ids. Pre-fix nothing is sent, so the
    test is red.
  - **Controls that must stay green:**
    - `b5innewzf` and the 3 deliberate ids are never stopped.
    - Main-thread `biq85iyja` is never stopped.
    - A revived agent's new shell is reaped only at its next end.
    - A restart between shell start and agent end still reaps.
    - A pre-fix adopted lane with no record is never reaped.
    - The 2 verdict cases are replayed and their outcome is asserted as whatever the user decides,
      so it is documented rather than silent.
  - **Anti-regression:** `verify:feat-154-bg-shells`, `verify:feat-154-working` and BUG-068/096/105
  suites.
  - **Real-CLI check:** re-run this probe against an isolated scratch Orchard server. Assert by
    pid that the auto-moved shell is gone within a bounded time after `completed`, that the
    deliberate one is still alive, and that the revival turn occurs. **Classification: this is a
    session-lifecycle change that kills processes, so it needs an independent clean-room verify.**

**4. Decision for the user (why `needs-you`)**
- **R — reap as directed** and accept that an auto-moved command a lane is still waiting on gets
  killed. Pair it with a charter/WA rule: "a command you will wait on after ending your turn must be
  started with `run_in_background`". The reap then enforces the rule. The observed rate is 2 lost
  runs to 5 hung pollers, and a revived lane can relaunch its command.
- **K — keep, don't reap.** The FEAT-154 strip already shows and stops these shells, so the pollers
  stay a visible, manual cleanup.
- **R′ — R, but for dispatch-declared lanes only** (a charter with a `Dispatch:` line), leaving
  ad-hoc subagents alone. This narrows the blast radius without adding a heuristic.
- Nothing distinguishes the 2 from the 5 without a heuristic, so there is no option that keeps
  both.
- **Nothing changed in code. No git writes.** The only processes I started were the probe's CLI
  and its 3 shells, and all ended through their stop files. `pgrep` confirmed none left. `:4317`
  was not touched.
