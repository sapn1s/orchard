```orchard-ticket
{
  "id": "FEAT-188",
  "type": "feature",
  "title": "The full suite matrix re-runs after every edit inside one round",
  "summary": "A fix lane can re-run the same before/after/mutant suite matrix on every small edit inside one round instead of once when the round is believed done. One FEAT-164 lane ran the bug-244 suite about 8 times, costing roughly 136 minutes; suites+browser+gate are 23% of all fix-lane time (1,060 min).",
  "impact_if_we_wait": "Suite-heavy tickets keep paying the full matrix cost repeatedly inside one round for no added confidence over running it once at the end; tests+browser+gate are 23% of fix-lane time across the 89 fix lanes measured.",
  "current_need": "A plan for the build lane: find where a fix lane currently decides to re-run a suite mid-edit, and gate the full matrix to run once near the end without weakening the existing full-suite-before-VERIFIED rule. See Implementation notes.",
  "severity": "medium",
  "area": "verification tooling / dispatch governance",
  "reported": "2026-10-14",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-10-14",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "The full suite matrix runs once per round after the candidate is believed complete, not after each edit, on a real or realistic multi-edit round",
    "docs/bugs/README.md point 4 (full suite before claiming a fix) still holds exactly as before",
    "A must-FAIL case: a round re-running the full matrix per edit is detectable; a once-at-the-end round is not flagged",
    "Before/after on a suite-heavy ticket: suite+browser+gate minutes drop materially from the measured 23% share"
  ],
  "code_refs": [
    {
      "path": "docs/bugs/README.md"
    },
    {
      "path": "docs/prompts/patterns/VERIFY.md"
    }
  ],
  "related": [],
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

# FEAT-188 — The full suite matrix re-runs after every edit inside one round

## Diagnosis

`docs/research/lane-time-2026-10-14.md` section 2 shows suites, browser runs and gate at 1,060 min (851+125+84) inside fix lanes, 23% of fix-lane time there, versus 32+25+19=76 min (1%) inside verify lanes — the cost is concentrated in fix lanes that iterate. Section 5's refutation adds a new, specific finding not in the original ranked list: "one FEAT-164 lane ran bug-244 about 8 times, ≈136 min" — the SAME suite re-run many times inside a single round rather than once when the change was believed done. This is the fourth surviving lever, newly identified by the refuter rather than carried over from the original ranking.

## Evidence

- `docs/research/lane-time-2026-10-14.md` section 2 table: fix-lane "test suites" 851 min (18%), "playwright/browser" 125 min (3%), "gate" 84 min (2%) — sum 1,060 min, 23% of fix-lane time, versus negligible verify-lane cost.
- Section 3: named long-running suites repeated across many runs, e.g. "verify-bug-247-boot-starvation: 48 min over 50 runs", "verify-bug-244-container-git-readonly: 78 min over 47 runs", "verify-feat-170-shadow: 28 min over 45 runs".
- Section 5 survivor table rank 4: "Iterate on the fixed tree only (new, from the refuter): run the before/after/mutant suite matrix once at the end, not on every iteration (one FEAT-164 lane ran bug-244 about 8 times, ≈136 min)" — estimate "10-45 on suite-heavy tickets" — status: new.
- The refutation was Claude-only (fresh-context Claude Opus worker lane `ad28028ffcff8bdbc`), OpenAI cross-provider check unavailable (`[quota-window]`, thread `01a139a2-3bc6-7290-a2ff-2873240e8cce`). **A cross-provider review is owed at plan review.**

## Implementation notes

Likely a convention/instruction fix first (how a fix lane is told to iterate: edit, reason about correctness, run a cheap targeted check if any, THEN run the full matrix once near the end) rather than purely a script change — investigate whether any scripted loop runner exists before assuming this needs new code. If a loop exists, gate its full-matrix re-invocation; if not, this is a dispatch-prompt/WA-pattern change plus a detector for the old pattern (see success criteria's must-FAIL case). State clearly that this does NOT relax docs/bugs/README.md's requirement to run the FULL relevant suite before claiming VERIFIED — that still happens once, at the end, in full.

## Verification plan

Proof bar: reproduce the must-FAIL case first — replay or construct a round that re-runs a real suite (e.g. bug-244's) many times on an otherwise-unchanged tree, confirm today's convention doesn't flag or prevent it. Then apply the fix/convention and confirm a repeated-run round is flagged, or a single-run-at-the-end round is not. Anti-regression: confirm docs/bugs/README.md point 4's full-suite-before-VERIFIED requirement still fires and is unweakened — run the actual board:check and verify-ticket-writing-contract checks alongside.

## Migration and rollback

If implemented as a prompt/convention change, rollback is reverting the doc; if implemented as tooling, rollback is disabling the detector/gate. No data migration.

## Risks

The main risk is cutting a real signal: running the full matrix only once at the end could let an early-round regression go unnoticed until the final run, costing more time overall if it means re-diagnosing a late failure that an earlier full run would have caught sooner. The plan should weigh a cheap targeted subset between edits (touched-file-relevant tests) against running nothing until the end. Flag at plan review that this lever's ranking, like 1-3, was refuted by Claude only.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-14 — agent
- **Filed:** through the board tool; the record was validated before it was written.
