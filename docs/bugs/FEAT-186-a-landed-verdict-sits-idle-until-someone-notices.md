```orchard-ticket
{
  "id": "FEAT-186",
  "type": "feature",
  "title": "A landed verdict sits idle until someone notices and redispatches",
  "summary": "A ticket's clock can sit idle with no lane running while a verdict (VERIFIED/BROKEN/HOLDS) waits for the orchestrator or the user to notice and start the next round. Measured on BUG-255: 7.9 of its 15.7 hours had no lane running, more than active work or the quota block combined.",
  "impact_if_we_wait": "Calendar time on multi-round tickets stays dominated by this gap on hot tickets, even though active lane-minutes are modest; three clean 1-round tickets in the same session show roughly zero cost when the gap never occurs.",
  "current_need": "A plan for the build lane: where a verdict becomes an observable event today, and a watcher/hook there that redispatches an open, idle, undecided ticket automatically. See Implementation notes.",
  "severity": "medium",
  "area": "dispatch governance",
  "reported": "2026-10-14",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-10-14",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A landed verdict on an open, idle, undecided ticket auto-dispatches the next round within minutes, measured on a real or realistic multi-round replay",
    "Auto-dispatch never races a concurrent lane on the same ticket or file under a must-FAIL two-ticket same-file case",
    "Every auto-dispatched round leaves an Activity-log entry naming the trigger and timestamp",
    "A flapping or repeatedly-BROKEN ticket does not auto-loop unbounded; a rate limit composes with FEAT-181's round ceiling",
    "Before/after on a real multi-round ticket: no-lane calendar time drops materially"
  ],
  "code_refs": [
    {
      "path": "scripts/board-tool.mjs"
    },
    {
      "path": "docs/bugs/README.md"
    }
  ],
  "related": [
    {
      "id": "FEAT-181",
      "relation": "see_also"
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
    "archived_path": null,
    "sha256": null,
    "original_title": null,
    "migrated_on": null,
    "migrated_by": null,
    "confirmation": "Authored directly in the record format through scripts/board-tool.mjs. There is no legacy original.",
    "dropped": []
  }
}
```

# FEAT-186 — A landed verdict sits idle until someone notices and redispatches

## Diagnosis

Measured in `docs/research/lane-time-2026-10-14.md` (this session's 4 tickets, N=311 lanes analyzed overall): BUG-255 ran 15.7 h on the clock, of which no lane was running for 7.9 h (one 472-minute overnight gap), 3 h was a quota block, and lane work itself was about 4.8 h over 4 rounds. The other three tickets in the same session (FEAT-181, BUG-256/257, FEAT-184) each finished in 1.0-1.2 h with essentially no no-lane gap. The pattern: the gap is not a fixed tax, it shows up specifically when a verdict lands and nobody is watching to dispatch the next round (overnight, between orchestrator turns, or while the user is away). Ranked #1 by the independent refuter in that doc's section 5 survivor table, estimated 'calendar: hours on long tickets ... 0 on 1-hour tickets'.

## Evidence

- `docs/research/lane-time-2026-10-14.md` section 0 ('Why a ticket takes hours') and section 2's per-ticket table: BUG-255 calendar 15.7 h vs some-lane-running 7.8 h (one 472-min overnight gap).
- Section 5 survivor table, rank 1: "Close the no-lane gap: auto-dispatch the next round when a verdict lands" — "calendar: hours on long tickets (BUG-255 had 7.9 h with no lane running); 0 on 1-hour tickets" — status: survives.
- The refutation that produced this ranking was Claude-only (a fresh-context Claude Opus worker lane, agent `ad28028ffcff8bdbc`, since the OpenAI cross-provider check hit a quota window mid-run). **A cross-provider review is owed at plan review** before this is relied on as the top-ranked lever.

## Implementation notes

Five-part plan for the engineer who builds this:
1. Identify where a verdict is recorded today (`node scripts/board-tool.mjs verified` / `board-tool decide` / a ticket's `work_state` transition) and what event fires, or could fire, at that moment.
2. Add a watcher or hook on that event that, for an OPEN ticket with no in-flight lane and no pending human decision, dispatches the next round via the existing dispatch path (the same one the orchestrator uses by hand) instead of waiting for a human/orchestrator turn.
3. Respect same-file serialization (`docs/bugs/README.md` 'Concurrency rules for the ORCHESTRATOR') and git-write-grant rules — auto-dispatch must not race a concurrent lane on the same ticket or file.
4. A visible audit trail: every auto-dispatched round is logged (trigger, timestamp) on the ticket's Activity log, so an auto-fired round is never silent.
5. A kill switch / rate limit so a flapping verdict (e.g. repeated BROKEN) cannot auto-dispatch an unbounded loop — compose with FEAT-181's round-ceiling escalation, which already detects absorbing tickets.

Open question for the build lane to state and justify: is "a verdict lands" a hook on the board-tool write path, or a poll loop over the board? The answer shapes the whole design and should not be assumed.

## Verification plan

Proof bar: a must-FAIL case first (a verdict landing today with a known lane at 0 running; confirm no dispatch fires), then the fix, then the same case firing a dispatch within minutes. Anti-regression: run the same-file serialization suite and a two-tickets-on-one-file race case; both must hold under auto-dispatch exactly as before it existed. Verify against a REAL multi-round ticket's history (or a realistic replay built from one), not a minimal single-event fixture — a busy board has several open tickets and in-flight lanes at once, and auto-dispatch must not misfire among them.

## Migration and rollback

Ship behind a flag or dry-run mode first (log what would have been dispatched, without dispatching), so a wrong trigger condition is caught before it fires real lanes. Rollback is disabling the hook/poll; no data migration implied.

## Risks

Auto-dispatch is dispatch governance touching concurrency and git-write timing — a wrong trigger could double-dispatch a ticket or race a file. This is a plan+review ticket: build only after a plan review, and flag at that review that the ranking behind this ticket was refuted by Claude only (no cross-provider check completed).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-14 — agent
- **Filed:** through the board tool; the record was validated before it was written.
