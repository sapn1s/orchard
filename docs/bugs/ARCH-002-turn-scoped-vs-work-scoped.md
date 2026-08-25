```orchard-ticket
{
  "id": "ARCH-002",
  "type": "architecture",
  "title": "Background work was ended while still running",
  "summary": "Work now carries a declared lifetime, preventing background tasks from being ended when their starting turn finishes. Runtime signals are normalized, unknown lifetimes remain unknown, and advisory reports cannot alone trigger abandonment and redispatch.",
  "impact_if_we_wait": "Without the deployed rule, live background work could be falsely ended and dispatched again. Bounded: this affects work coordination and duplicate execution, not stored user data or process liveness.",
  "current_need": "Keep the ticket closed; the deployed implementation established declared lifetimes, preserved background work across turns, and prevented action on unknown lifetimes.",
  "severity": "high",
  "area": "Work lifetime",
  "reported": "2026-08-13",
  "reported_by": "bug-hunt workflow",
  "owner": "agent",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-08-13",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-10",
      "question": "How should work lifetime be determined across runtimes?",
      "mode": "single",
      "options_keys": [
        "1",
        "2",
        "3"
      ],
      "chosen": "1",
      "chosen_on": "2026-08-13",
      "chosen_by": "agent",
      "note": "ARCH-002 chose declared lifetime at dispatch over consumer-side guards or accepting runtime-specific relearning. Advisory reports require corroboration before driving action."
    }
  ],
  "success_criteria": [
    "No component ends work without receiving its declared lifetime",
    "Background work survives the turn that dispatched it without a false end record",
    "A runtime lacking a lifetime signal yields unknown and triggers no action",
    "The orchestrator corroborates advisory briefings before abandoning live work"
  ],
  "code_refs": [],
  "related": [
    {
      "id": "ARCH-001",
      "relation": "recurrence_of"
    },
    {
      "id": "BUG-041",
      "relation": "see_also"
    },
    {
      "id": "BUG-043",
      "relation": "see_also"
    },
    {
      "id": "BUG-046",
      "relation": "see_also"
    },
    {
      "id": "BUG-048",
      "relation": "blocks"
    },
    {
      "id": "BUG-074",
      "relation": "see_also"
    },
    {
      "id": "FEAT-080",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [
    "ARCH-001",
    "BUG-041"
  ],
  "verification": [],
  "verification_class": "arch",
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
    "archived_path": "docs/bugs/archive/ARCH-002-turn-scoped-vs-work-scoped.md",
    "sha256": "6c2a17594ba6e7799e78b503842c76ff03da361bf6a5803f4a7408505649e2d1",
    "bytes": 4677,
    "original_title": "nothing answers \"does this work outlive the turn that started it?\"",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the archived original; the invariant, failure chain, three alternatives, chosen dispatch model, proof bar, bounds, and corroborating tickets are preserved.",
    "dropped": []
  }
}
```

# ARCH-002 — Background work was ended while still running

## Diagnosis

Turn completion was treated as proof that every unit of work started during that turn had ended. The result handler therefore wrote death records for background agents that were still running. Those records reached `takeBriefing()`, where the orchestrator abandoned and redispatched live work.

## Evidence

BUG-037 exposed the false end record and left the cross-turn end-to-end case open. BUG-041 corroborated the lifetime ambiguity. The closing status records that BUG-044 and FEAT-062 implemented the decision, exercised their respective behavior, and were deployed.

## Implementation notes

Each dispatched unit carries `lifetime: turn | background`. Runtime-specific signals are normalized at the runtime seam, while runtimes without a usable signal produce `unknown`. Sweep, settlement, and reporting consumers use the declared value. Unknown values are never coerced. Briefings are advisory unless corroborated by ground truth.

## Verification plan

Run a background unit through the result of its dispatching turn and confirm that no end record is written. Exercise a runtime without a lifetime signal and confirm that it yields `unknown` without settlement. Confirm that an advisory briefing alone cannot cause abandonment or redispatch.

## Migration and rollback

Lifetime declarations were introduced at dispatch and normalized per runtime. Rolling back would restore implicit lifetime guesses and could again convert advisory observations into control flow.

## Risks

A runtime may map its signal incorrectly, or a consumer may bypass the normalized lifetime. Treating advisory reporting as actionable without corroboration could still abandon live work.

## Activity log (APPEND-ONLY)
### 2026-08-10 — orchestrator
- Filed from BUG-037's closing assessment. Second ARCH ticket; the FEAT-056 loop again produced it
  from a fixer's own structural suspicion rather than from anyone remembering to look.

### 2026-08-11 — orchestrator (decision taken)
- User standing instruction today: "do not wait for any further confirmation unless it's actually
  blocking". This decision had a clear recommendation with no counter-argument raised, so adopting
  **option 1: declared lifetime at dispatch** — `lifetime: turn | background | unknown` carried
  from creation, normalized at the runtime seam, `unknown` never coerced, plus the written
  advisory-vs-actionable rule (briefings/ledgers are ADVISORY; abandoning or re-dispatching live
  work requires ground-truth corroboration — the WA §C rule already captures the orchestrator half).
- BUG-043's WorkLifetime seam is the partial embodiment; the remaining implementation lands with
  BUG-044 (restart drain must consult lifetime) and FEAT-062 (verify→fix loop dispatches declare
  it). Proof bar unchanged. User can veto/reverse — nothing here is hard to unwind.

### 2026-08-13 — board reconciliation (status closed)
- The decision was taken (option 1) and its implementation has landed: BUG-043's WorkLifetime seam,
  BUG-044 (VERIFIED — restart drain consults lifetime) and FEAT-062 (VERIFIED — verify→fix dispatches
  declare lifetime), all deployed (pid 1162138 runs the latest code). Decision + implementation are
  both complete, so this ARCH ticket has no residual open work. Status header relabeled DECIDED→DONE
  so board:gen moves it out of the Open/queued list (it was inflating the FEAT-067 queued count).
  Reversible as noted; a runtime with no lifetime signal still yields `unknown` and nothing acts on it.
