```orchard-ticket
{
  "id": "FEAT-182",
  "type": "feature",
  "title": "Should verification route by measured risk, with audited exemptions",
  "summary": "Research refutation left one question open across both providers: whether to adopt a risk-based verification-routing gate instead of todays uniform per-harm-class rule. The Claude skeptic called any routing gate circular; the OpenAI skeptic rejected that as over-claiming, since a routing pass can read observable change properties without knowing every defect. The two disagree, so a human must choose.",
  "impact_if_we_wait": "Nothing breaks: the current WA harm-class rule stays in force and keeps pre-ship verification mandatory for high-consequence classes. The only cost is that a possibly-cheaper routing policy stays unexplored.",
  "current_need": "A human decision on direction: keep the uniform rule, or pilot a measured risk-routing gate with randomized exemption audits. A class=triage build follows only a YES.",
  "severity": "low",
  "area": "verification policy",
  "reported": "2026-10-13",
  "reported_by": "agent",
  "owner": "you",
  "work_state": "blocked",
  "human_action": "decide",
  "updated": "2026-10-13",
  "decision": {
    "id": "eee97fff-d214-4ee4-bbc0-3f7896739669",
    "mode": "single",
    "question": "Keep the uniform harm-class verify rule, or pilot a measured risk-routing gate?",
    "options": [
      {
        "key": "A",
        "label": "Keep uniform rule",
        "what_changes": "no change; WA harm-class rounds table stays the sole gate",
        "benefit": "zero new overhead, no regression risk, already cross-provider endorsed as the floor",
        "cost": "leaves a possibly-cheaper routing policy unexplored",
        "why_not_obvious": "the refutation only reopened the question, it did not show routing wins"
      },
      {
        "key": "B",
        "label": "Pilot measured risk-routing",
        "what_changes": "add an independent pre-ship triage that routes by observable change properties, plus randomized audits of exempted tickets",
        "benefit": "could cut verify on low-risk work if audits show low escape",
        "cost": "adds triage + audit overhead that may exceed the saving; needs a class=triage build",
        "why_not_obvious": "severe-defect escape rate of exemptions is unmeasured, so safety is unproven until the pilot runs"
      }
    ],
    "recommendation": "A",
    "recommendation_reason": "Both providers agree the mandatory floor holds; routing is unproven and B only pays if audits later show a safe exempt class, so pilot is reversible but not yet justified",
    "prerequisite": null
  },
  "decision_history": [],
  "success_criteria": [
    "A recorded human decision between keeping the uniform harm-class rule and piloting a measured risk-routing gate",
    "If piloted: severe-defect escape rate of exempted tickets is measured via randomized audits before any reliance"
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "plan+review",
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

# FEAT-182 — Should verification route by measured risk, with audited exemptions

## Decision context

From docs/research/ship-before-verify-2026-10-13.md sec 4, sec 5(D), sec 7. The study rejected a harm-class ship-after-build gate as circular (to route you must know the worst credible failure in advance, but green self-suites misjudge their own worst case). A cross-provider OpenAI skeptic (run 01a13647-a591-7932-8da6-1de03743628a) rejected the blanket rejection: two hidden-harm counterexamples do not make ALL prospective risk routing circular; a routing pass can inspect write capabilities, migrations, authorization boundaries, session storage and reachable effects without enumerating every defect.

Both providers AGREE on the floor: pre-ship independent verification stays mandatory for high-consequence changes (WA sec I harm-class rounds table already encodes this). The open fork is only whether to ADD a measured routing layer on top. OpenAI single kept change: replace the blanket rejection with a prospectively-evaluated risk-based gate that randomly audits exemptions and measures severe-defect escapes alongside total delivery time.

This needs project-direction knowledge (how much measurement overhead the user will accept for a possible latency win), so it is filed as a decision, not built. See the Decision section below.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-13 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-13 — agent
- **Decision declared:** Keep the uniform harm-class verify rule, or pilot a measured risk-routing gate? Options: A — Keep uniform rule; B — Pilot measured risk-routing. Recommended: A — Both providers agree the mandatory floor holds; routing is unproven and B only pays if audits later show a safe exempt class, so pilot is reversible but not yet justified Written to the record with board-tool decide; the Decide card reads the record, not this line.

### 2026-10-13 — worker (FEAT-182 fixing r1)
- **Decision adopted:** Recommendation A (keep the uniform harm-class verify rule) ADOPTED under the user's standing delegation — not by forging a Decide-card answer. Standing instruction, user, 2026-10-13: "first gather data and do whatever u recc"; recorded memory rule: "Standing: do what you recommend — execute my recommendations without asking; ask only for breaking/irreversible/outward actions." This resolution is reversible and non-outward: no code changes, and the WA harm-class rounds floor already in force stays the sole gate, so it falls squarely under that delegation. A means "no change now"; option B (pilot a measured risk-routing gate with randomized exemption audits) stays available as a NEW class=triage ticket if later evidence shows a safe exempt class. The typed Decide-card answer is deliberately NOT written: only the server answer route may write decision.answers[] (FEAT-166), and a hand-forged one would be a violation. CLOSURE NOTE: the ticket is taken off BLOCKED/needs-you (work_state open, human_action none, owner unassigned) but NOT marked done, because the schema forbids work_state=done while a live decision is present and board-tool exposes no verb to withdraw/retire a decision (verbs: query|check|reconcile|file|update|verified|decide|commit; decide only SUPERSEDES an unanswered decision by writing a NEW one via --replace, it cannot remove one). Moving the decision into decision_history with chosen=null is the server Adopt action on the Needs-You rail (base-update route, src/server/board.ts), which only the user/server writes — an agent hand-editing the record to force it would be the same violation class as forging an answer. So the decision record is LEFT IN PLACE; final closure to DONE is the user clicking Adopt A on the rail. Symptom of a deeper design flaw? no.

### 2026-10-13 — worker (FEAT-182 fixing r1)
- **Adoption recorded; routed state restored:** CORRECTION to the entry immediately above: the open/human_action=none/owner-unassigned state it described is INVALID and was rolled back. board:check FAILs it as "DECISION NOT ROUTED" — the board enforces (ARCH-005) that a live decision MUST be 👤-routed so the user actually sees the Decide card; a live decision can never sit off the Needs-You rail. Net effect of this ticket's work: recommendation A (keep the uniform harm-class verify rule) is ADOPTED on the record via these log entries under the user's standing delegation ("first gather data and do whatever u recc"), BUT the mechanical closure — move the decision into decision_history (chosen A, or chosen=null) and set work_state=done — cannot be performed by any agent-available tool: the schema forbids work_state=done while a live decision is present, a live decision must stay 👤-routed, and board-tool has no verb to retire a decision (decide only supersedes by writing a NEW one). The ONE sanctioned path is the server Adopt/Defer/Skip base-update route behind the Needs-You rail (src/server/board.ts), written only by the user/server — the same reason this lane must not forge a decision.answers[] entry. So the ticket is LEFT BLOCKED/👤 with A recommended; closing it is one click ("Adopt A") for the user/orchestrator. Decision record left in place; nothing forged. Symptom of a deeper design flaw? Possibly — there is no agent/CLI path to adopt a recommendation under a standing delegation; worth a separate look, not filed here.

### 2026-10-14 — worker (FEAT-184 fixing r1)
- **Path to close via a delegation (FEAT-184):** FEAT-184 built the honest path. Chat words ("first gather data and do whatever u recc", 2026-10-13) are NOT treated as a delegation, because an agent can produce a user-shaped turn (BUG-258). So this ticket stays BLOCKED/👤 until the user records a delegation once. After a service restart (the routes are new): open FEAT-182, choose "Delegate to agents", enter your words, keep FEAT-182 in the ticket list, and press Record. An agent then runs `node scripts/board-tool.mjs adopt --id=FEAT-182 --delegation=<id> --author=…`, which records recommendation A as adopted under your delegation, never as your answer. Clicking A on the card yourself remains the one-step alternative. No answer was written by this lane.
