```orchard-ticket
{
  "id": "FEAT-180",
  "type": "feature",
  "title": "Property/differential corpus runner for independent clean-room verify",
  "summary": "Risky renderer/parser/store tickets rediscovered the same defect class across many serial verify rounds (FEAT-091 absorbed ~11 BROKEN verdicts on one hidden-content class via new input shapes). There is no reusable way to enumerate a class of adversarial inputs once, up front, so each round re-finds one case at a time.",
  "impact_if_we_wait": "The long-tail tickets (FEAT-091/BUG-201/ARCH-013) keep paying round-over-round for a defect class that could be proven once; rounds 2+ are already 56% of measured cost.",
  "current_need": "A planned, measured corpus runner: a chosen design and a go/no-go measurement gate before it is relied on, because cross-provider refutation rated it an experiment, not a proven lever.",
  "severity": "medium",
  "area": "verification tooling",
  "reported": "2026-10-13",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-10-13",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A reusable corpus runner in independent-verify.mjs enumerates input shapes per class (renderer/parser/store) and runs them against a diff",
    "Measurement gate recorded: corpus vs current practice on completion time, labor, corpus maintenance, and escaped defects, before any reliance",
    "At least one real class (FEAT-091 fold shapes, FEAT-129 mutation classes) reproduced from the corpus without a bespoke fixture"
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

# FEAT-180 — Property/differential corpus runner for independent clean-room verify

## Plan (FILED — large, build after review)

Front-load an adversarial property/differential corpus so a defect CLASS is enumerated once rather than rediscovered across serial rounds. Source: docs/research/ship-before-verify-2026-10-13.md sec 5(A) and sec 7.

### Why this is FILED as a plan, not built on faith
Cross-provider refutation (OpenAI, run 01a13647-a591-7932-8da6-1de03743628a) rated this an experiment, not an established latency lever. Named backfire modes to design against:
- longer round 1 on tickets that would otherwise finish immediately;
- maintenance / flaky-test cost;
- incorrect or incomplete encoded properties;
- shared blind spots between the implementation and a differential oracle that may share the bug;
- builders optimizing to a known corpus, so independent attacks lose diversity;
- fewer reported rounds (work bundled into round 1) with NO latency reduction.

### Design sketch
- Generalize the FEAT-091 fold corpus and the FEAT-129 mutation-classifier corpus into a reusable runner in scripts/independent-verify.mjs.
- Classes to seed: renderer (fence/nesting/markdown shapes), parser (truncated/partial reads, per the WA partial-read rule), store (mutation classifiers: move/sweep/reap).
- Keep the clean-room contract (WA sec I): the corpus is the verifier input, never shared with the builder as a target.

### Proof bar / measurement gate (the go/no-go)
Before the corpus is RELIED ON, measure it against current practice on: total completion time, total labor, corpus-maintenance cost, and escaped-defect rate. It earns adoption only if it cuts rounds WITHOUT raising escaped defects or net time.

### Related
- FEAT-148 (round-ceiling), FEAT-091/BUG-201 (fold corpus), FEAT-129 (mutation classifier), FEAT-086 (cost model).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-13 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-14 — agent (lane-time research, finding/explore round 1)
- **New evidence, ranking confirmed (survives, still unproven).** `docs/research/lane-time-2026-10-14.md` measured "fewer rounds" directly: rounds 2+ took 341 of 490 active lane-minutes this session (about 70%, holding at 61-64% once the refuter's correction for an undercounted round-1 lane is applied) — matching this ticket's own "rounds 2+ are already 56% of measured cost" from the prior doc. The doc's section 5 survivor table ranks "fewer rounds (property-first verification, this ticket + FEAT-181)" **#3** of 4 surviving levers, estimated 20-40 lane-min/ticket saved (rounds 2+ run about 85 lane-min/ticket in this session's sample), status **"survives, unproven"** — the same caveat this ticket's own plan already carries (measurement gate before reliance). The refutation behind that ranking was Claude-only (fresh-context Claude Opus worker lane `ad28028ffcff8bdbc`; OpenAI cross-provider check hit `[quota-window]` mid-run, thread `01a139a2-3bc6-7290-a2ff-2873240e8cce`) — **a cross-provider review is still owed** before this estimate is relied on, consistent with this ticket's existing requirement for a measurement gate. No code touched; filing-round finding only, cross-referenced from new tickets FEAT-186/187/188 (the other three surviving levers from the same doc).
