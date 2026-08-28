```orchard-ticket
{
  "id": "FEAT-107",
  "type": "feature",
  "title": "Measure diff size per lane and per ticket in the cost collector",
  "summary": "Orchard measures tokens, wall clock, cost, phase and model tier per lane, but nothing about the SIZE of the change produced, so no experiment aimed at reducing code volume has a baseline or instrument. This adds git-numstat diff size to cost-collect.mjs, sourced from commit shas recorded on tickets, per lane and per ticket, with a median added-lines-per-lane by class.",
  "impact_if_we_wait": "Any experiment intended to reduce code volume has no baseline to compare against and no instrument to detect an effect, so its result is unfalsifiable.",
  "current_need": "Build the instrument, prove it is non-vacuous (absent sha -> absent number, never a silent zero), and capture the last-20 fix-class baseline as the artifact a future experiment compares against.",
  "severity": "medium",
  "area": "Instrumentation / cost collector (scripts/cost-collect.mjs, scripts/lib)",
  "reported": "2026-08-26",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-08-26",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "git diff --numstat added/deleted/files reported per lane and aggregated per ticket, sourced from shas recorded on tickets",
    "A stated attribution rule for multi-lane commits, commit-less lanes, and multi-round tickets, unattributable work surfaced as its own bucket not dropped",
    "Median added-lines per lane segmented by dispatch class",
    "Retroactive over prior lanes and zero runtime cost, like the rest of the collector",
    "Non-vacuous: a ticket with no recorded sha reports absent, not zero; two lanes cross-checked by hand against git show --numstat",
    "Presented alongside verify-rounds and reopen signals, not as a standalone score"
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": false,
    "Evidence": false,
    "Implementation notes": false,
    "Verification plan": false,
    "Migration and rollback": false,
    "Risks": false,
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

# FEAT-107 — Measure diff size per lane and per ticket in the cost collector

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-26 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-08-26 — worker
- **Built: diff-size instrument in the cost collector:** Dispatch: ticket=FEAT-107 phase=fixing round=1 class=fix. Added scripts/lib/diff-size.mjs (pure attribution) + wired scripts/cost-collect.mjs to read commit shas from ticket Activity logs (BUG-154 convention), git-numstat each, attribute per lane + per ticket. Rule: a commit ties to at most one lane on its ticket — window if its author time is inside the lane, else preceding (latest lane started before it, since workers do not self-commit; a human commits after the lane); a commit older than any lane on its ticket is UNATTRIBUTED with a reason, never forced on. Per-ticket sums every recorded commit; unattributable + shared commits are their own buckets; presented next to verdicts. Found+fixed a real bug vs the BUG-154 ticket: the sha regex was case-sensitive and silently missed every capital-C Committed-as-X. Verified: verify-diff-size.mjs 29/29 (must-FAIL for case-sensitive regex and for a window-only rule; non-vacuity: no-sha ticket absent not zero, unresolved sha is missing_stats not zero). Hand cross-checks vs git show --numstat: BUG-154 303f851 +553/-3/4, FEAT-099 3e7bcf4 +1617/-48/15, exact. verify-cost-collect 62/62 unaffected. gate exit 0. Baseline: ideal last-20 fix-class-lane baseline is EMPTY (convention 1 ticket old); best-available baseline = the 20 lanes with attributable commits: median +640/-26.5/5 files, range +8..+2033, 6 BROKEN. Left unstaged.
