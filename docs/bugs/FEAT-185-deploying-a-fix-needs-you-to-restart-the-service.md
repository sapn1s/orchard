```orchard-ticket
{
  "id": "FEAT-185",
  "type": "feature",
  "title": "Deploying a fix needs you to restart the service by hand",
  "summary": "After a server change, sessions stop and ask you to restart the service, because a restart cuts the orchestrator's own turn. Restart hand-offs were 31 of 282 asks. The service should be able to restart itself between turns, once running work has drained, and resume the requester.",
  "impact_if_we_wait": "Every server fix ends in a hand-off and a wait for you. Fixes that are verified but not deployed pile up.",
  "current_need": "A plan review: draining, a durable checkpoint, idempotent resume, and recovery tests before any automatic restart.",
  "severity": "medium",
  "area": "service lifecycle",
  "reported": "2026-10-14",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-10-14",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "An agent can request a deploy restart, which the server runs only once the requesting turn ends and other work has drained.",
    "The requesting session gets a resume nudge after the restart, and nothing is duplicated or lost (an idempotent resume).",
    "A restart that cannot drain is reported, not forced."
  ],
  "code_refs": [],
  "related": [
    {
      "id": "FEAT-015",
      "relation": "see_also"
    },
    {
      "id": "DEPLOY-003",
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
    "confirmation": "Authored directly in the record format through scripts/board-tool.mjs. There is no legacy original.",
    "dropped": []
  }
}
```

# FEAT-185 — Deploying a fix needs you to restart the service by hand

## Diagnosis

FEAT-015 made sessions survive a restart, but the turn in flight is cut. So no orchestrator restarts the service itself, and every server change ends in an ask (WA hand-off).

## Evidence

docs/research/unnecessary-asks-2026-10-14.md: 31 of 282 asks were restart or live-service hand-offs. They are legitimate under the current design, but they are the largest structural stop after git hand-offs (45). OpenAI refutation run 01a13949: P6 MODIFY. It requires draining, durable checkpoints, idempotent resume and recovery tests before automatic restart, and ranks this separately from the unnecessary asks.

## Implementation notes (plan)

An on-disk deploy request, written by an agent through an allowed command. The server acts on it at the next quiescent point, reusing FEAT-015's survivor path. After the restart, a resume message goes to the requester via the existing outbox. This needs an ARCH-level review of the session-lifecycle path, which has a regression history.

## Risks

This is session-lifecycle code, so it has a high regression risk and needs independent verification.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-14 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-14 — finding lane (round 1)
- **Filed with plan:** Filed with a plan from the 2026-10-14 ask study (docs/research/unnecessary-asks-2026-10-14.md): 31 of 282 asks were restart/live hand-offs, legitimate under the current design (FEAT-015 survives sessions but cuts the turn in flight). OpenAI run 01a13949-5094-7161-bdee-4954fda87510: P6 MODIFY — require draining, durable checkpoints, idempotent resume and recovery tests before any automatic restart; ranked separately from unnecessary asks. Not built: session-lifecycle code with a regression history needs a reviewed plan first.
