```orchard-ticket
{
  "id": "FEAT-187",
  "type": "feature",
  "title": "A lane stays parked long after its quota window resets",
  "summary": "Resuming a lane after a provider usage-window limit resets depends today on a human or orchestrator noticing the reset happened. Measured reset-to-resume delays across 6 hits: 3, 3, 85, 85, 316, 735 minutes (sum 1,226) — most of all quota cost once the window itself is separated out.",
  "impact_if_we_wait": "Quota blocks recur (9 hits measured this session) and each one risks adding tens of minutes to hours of pure waste on top of the window itself, depending on whether anyone is watching when it resets.",
  "current_need": "A plan for the build lane: reuse FEAT-116's reset-time signal, add a scheduled resume keyed to it, and state explicitly what 'resume' means for a lane that was mid-turn. See Implementation notes.",
  "severity": "medium",
  "area": "dispatch governance / provider limits",
  "reported": "2026-10-14",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-10-14",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A parked lane resumes automatically once its provider's resetsAt time passes, with no required human turn, on a real or realistic replay",
    "Resume semantics (same-session continuation vs fresh round dispatch) are stated explicitly and verified to match",
    "Every auto-resume is logged on the ticket's Activity log with trigger and delay-from-reset",
    "Before/after: reset-to-resume delay drops from the measured 3-735 min range to single-digit minutes",
    "FEAT-116's reset-time display and FEAT-160/FEAT-120's manual failover keep working unchanged"
  ],
  "code_refs": [
    {
      "path": "docs/bugs/FEAT-116-provider-rate-limit-window.md"
    },
    {
      "path": "docs/bugs/FEAT-120-hitting-a-provider-limit-means-losing-the-conversa.md"
    },
    {
      "path": "docs/bugs/FEAT-160-switch-claude-account-on-a-running-session.md"
    }
  ],
  "related": [
    {
      "id": "FEAT-116",
      "relation": "see_also"
    },
    {
      "id": "FEAT-120",
      "relation": "see_also"
    },
    {
      "id": "FEAT-160",
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

# FEAT-187 — A lane stays parked long after its quota window resets

## Diagnosis

`docs/research/lane-time-2026-10-14.md` section 2 and section 5's survivor table split quota cost into two parts: the limit window itself (about 13% of all lane-minutes, unavoidable without a provider change) and waiting for someone to notice the reset and resume (about 12%, measured directly from reset-to-resume delays of 3, 3, 85, 85, 316 and 735 minutes across 6 hits, summing to 1,226 minutes). The second part is pure overhead this ticket targets. Ranked #2 by the independent refuter, re-split from the original doc's combined 25% estimate into the two components above — the refutation explicitly separated 'the limit itself' from 'waiting on a resume' and found the resume-wait the larger, more fixable share.

## Evidence

- `docs/research/lane-time-2026-10-14.md` section 2, bucket table: "quota block / provider checks" 542 min (fix, 12%) and 1023 min (verify, 28%).
- Section 5 refutation table: "quota block 25% — WEAKENED: ~1,220 of 2,553 min were after the reset, waiting on a resume, so the limit itself is ~13%", with the refuter's own measured reset→resume delays listed as 3, 3, 85, 85, 316, 735 min (sum 1,226), matching the doc author's own figures.
- Section 5 survivor table rank 2: "Quota continuity: auto-resume at the reset (FEAT-120), then account failover (FEAT-160)" — "~45 calendar min averaged; auto-resume alone recovers 1,226 min across 6 hits, more than failover's ~870" — status: survives, re-split.
- The refutation was Claude-only (fresh-context Claude Opus worker lane `ad28028ffcff8bdbc`; the OpenAI cross-provider check hit `[quota-window]` itself mid-run, thread `01a139a2-3bc6-7290-a2ff-2873240e8cce`). **A cross-provider review is owed at plan review** before this ranking is relied on.

## Implementation notes

1. Locate where a 'hit your session limit' / quota-block condition is currently detected and recorded — FEAT-116 already surfaces rate-limit window usage and reset time for dispatch-now-vs-park decisions; reuse that signal rather than re-deriving it.
2. Add a scheduled check or timer keyed to the provider's reported `resetsAt` that, when due, resumes the parked lane automatically, without requiring a coordinator/user message to land first.
3. Decide and document what 'resume' means for a lane that was mid-turn when it hit the limit — same-session continuation vs a fresh dispatch of the same round — as an explicit, stated choice, not an accident of whatever the resume code already does.
4. Record the resume (trigger, timestamp, delay from reset) on the ticket's Activity log so it is auditable.
5. This is explicitly separate from, and ranked ahead of, FEAT-160/FEAT-120's cross-account or cross-provider failover — those switch engines; this keeps the same lane on the same provider and only removes the human-noticing step. The survivor table frames auto-resume FIRST (recovers more minutes, 1,226 vs ~870, and is the simpler build — no cross-account credential logic) and failover SECOND.

## Verification plan

Proof bar: a must-FAIL case first (a parked lane with a passed resetsAt and nothing resuming it — confirm it stays parked today), then the fix, then the same case resuming within a tight window of the reset. Verify against a REAL recorded quota hit (one of this session's 6, or a fresh one) if available, or a realistic replay carrying the real resetsAt timestamp and a real parked-lane state — not a bare synthetic timer. Anti-regression: confirm FEAT-116's dispatch-now-vs-park UI and FEAT-160/FEAT-120's manual failover path still work unchanged.

## Migration and rollback

Ship as an additive timer/check; rollback is simply not scheduling it. No data migration.

## Risks

This is dispatch governance around session/provider state — getting the resume semantics wrong (e.g. resuming into a stale or half-written session) risks silent data loss, which is why the resume-semantics question above must be answered explicitly in the plan, not left to whatever code already exists. Flag at plan review that the ranking behind this ticket (and lever 1's) was refuted by Claude only; an independent cross-provider pass is owed before committing to the build order.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-14 — agent
- **Filed:** through the board tool; the record was validated before it was written.
