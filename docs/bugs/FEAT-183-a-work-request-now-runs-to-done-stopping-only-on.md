```orchard-ticket
{
  "id": "FEAT-183",
  "type": "feature",
  "title": "A work request now runs to done, stopping only on hard stops",
  "summary": "The Working Agreement defaulted to interactive mode and listed priority, spend and risk as reasons to ask, so sessions paused inside work you had already asked for. Now a work request runs to done. It stops only for something irreversible or outward, a live restart, git, access, money, a taste or direction fork, missing facts, or a block.",
  "impact_if_we_wait": "Instructions keep pushing sessions to ask about fixes, verification rounds and sequencing inside work you already authorised.",
  "current_need": "A later ask audit (`node scripts/ask-audit.mjs`) over sessions started after the change. The unnecessary share should fall from about 45% with no rise in actions you did not authorise.",
  "severity": "medium",
  "area": "working agreement",
  "reported": "2026-10-14",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "in_verification",
  "human_action": "none",
  "updated": "2026-10-14",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "WA §A uses the closed hard-stop list; agent effort, sequencing and a rule the agent wrote itself are never deciders.",
    "WA §M makes run-to-done the default for a work request, bounded by its acceptance criteria and budgets; interactive stays for exploration.",
    "Scope says in-request defect fixes and verification rounds are the asked task, and non-blocking hand-offs go in the final report.",
    "Edited in the canonical methodology copy and mirrored with `npm run sync:methodology`. Reconciled in place (§L), not stacked."
  ],
  "code_refs": [],
  "related": [
    {
      "id": "FEAT-022",
      "relation": "see_also"
    },
    {
      "id": "FEAT-137",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "docs-only",
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

# FEAT-183 — A work request now runs to done, stopping only on hard stops

## Diagnosis

Three instruction surfaces pushed toward asking. §M said 'Default to interactive'. §A listed 'priority, spend, risk appetite' as user-held deciders, and those words fit almost any question. The Scope section's 'Don't auto-chain — finish the asked task, then stop and report' read as 'stop at each step', and verification rounds and found defects were treated as new tasks. The user's goal, verbatim: 'ask feature and simply wait until it is done, unless a breaking change gets encountered or something is blocking'.

## Evidence

docs/research/unnecessary-asks-2026-10-14.md: of 126 unnecessary asks, 36 were file-or-fix questions about an in-scope problem, 29 were continue or one-more-round questions, 40 were implementation or sequencing choices, and 14 had already been answered or delegated. OpenAI refutation run 01a13949: P2 MODIFY, i.e. bounded acceptance criteria, discovered constraints kept apart from invented authority, and only non-blocking hand-offs batched.

## Implementation notes

The canonical file is `~/projects/methodology/WORKING_AGREEMENT.v4.md`, with a CHANGELOG entry, mirrored with `npm run sync:methodology`. §A, §M, the §N adjudication sentence and Scope are reworded in place.

## Verification plan

Re-measure with `node scripts/ask-audit.mjs --since <deploy date>` once at least 10 new orchestrator sessions exist. Hand-classify a random 40. Record any action the user says they did not authorise.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-14 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-14 — finding lane (round 1)
- **WA edited and synced; effect to be measured:** Edited the canonical ~/projects/methodology/WORKING_AGREEMENT.v4.md (CHANGELOG entry 2026-10-14) and mirrored it with npm run sync:methodology (docs/prompts/WORKING_AGREEMENT.v4.md synced). Reconciled in place per §L, nothing stacked: §A's open decider list replaced by the closed hard-stop list (irreversible, outward, live, git, access, money, taste, direction, info, blocked) with consequence; agent effort, 'another round?' and fixing/filing an in-request problem are never the user's; a self-written rule cannot create a hard stop, a discovered constraint is evidence. §M retitled and flipped: a work request runs to done by default within acceptance criteria and budgets; interactive for exploration or on request; standing delegation holds until revoked and is recorded (§B). §N: 'one more round?' is never the user's fork. Scope: in-request fixes and verification are the asked task; hand-offs are batched into the final report unless one blocks or stops ongoing harm. Refuted cross-provider: OpenAI run 01a13949-5094-7161-bdee-4954fda87510 (P2 MODIFY) — its three modifications applied; P5 (defer even taste/direction forks) REJECTED there and not adopted. verify-wa-injected 10/10, npm run gate PASS (prompt-privacy PASS). Effect NOT yet measured: re-run node scripts/ask-audit.mjs --since 2026-10-15 after 10+ new sessions and relabel a blind sample of 40; failure = unnecessary share above ~30%, or relabelling, or an unauthorised action.
