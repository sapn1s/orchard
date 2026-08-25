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
