```orchard-ticket
{
  "id": "FEAT-060",
  "type": "feature",
  "title": "Agents executed the orchestrator's reading instead of testing it",
  "summary": "Work was handed out as targeted fixes even when the framing behind them was untested, so a wrong reading propagated unchallenged through the whole chain. Charters now carry a required hypothesis block and an explicit dispatch class, and two new charter shapes cover exploration and plan review. Registering those two shapes as seeded templates was left undone on purpose.",
  "impact_if_we_wait": "A misread request keeps being built rather than checked, and the safeguard fires only when someone remembers to write it. Bounded: this shapes how work is framed and dispatched, not any stored data, and the existing charter path keeps working untouched.",
  "current_need": "Nothing is outstanding. Five template, sync, injection and read-through suites all passed, standing checks stayed clean, and the deferred seeding is recorded on the ticket.",
  "severity": "medium",
  "area": "Work dispatch and charters",
  "reported": "2026-08-09",
  "reported_by": "user",
  "owner": "you",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-10",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-09",
      "question": "Should exploration and plan review default to a different provider than the orchestrator?",
      "mode": "single",
      "options_keys": [
        "A",
        "B"
      ],
      "chosen": "A",
      "chosen_on": "2026-08-09",
      "chosen_by": "agent",
      "note": "Recorded in the original as a recommendation, not blocking the mechanical parts: a different provider by default for plan review, optional for exploration."
    }
  ],
  "success_criteria": [
    "Every charter records which dispatch class it was written as",
    "A charter missing the hypothesis block is visibly incomplete",
    "One exploration dispatch returns options with trade-offs and builds nothing",
    "The universal agreement and routing mirror stay in sync",
    "No existing charter path is auto-rewritten by the change"
  ],
  "code_refs": [
    {
      "path": "src/server/templates.ts",
      "symbol": null,
      "note": "seed-registration of the two new pattern templates was deferred here"
    }
  ],
  "related": [
    {
      "id": "ARCH-001",
      "relation": "see_also"
    },
    {
      "id": "BUG-024",
      "relation": "see_also"
    },
    {
      "id": "BUG-033",
      "relation": "see_also"
    },
    {
      "id": "FEAT-056",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-061",
      "relation": "blocks"
    },
    {
      "id": "FEAT-062",
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
    "Migration and rollback": false,
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-060-dispatch-discipline.md",
    "sha256": "4ec330079561f28c49a8b52d70df682956bbf27b21ae07f7fd674fb30f1c3087",
    "bytes": 10003,
    "original_title": "dispatch discipline: when a request needs planning/refutation, not a targeted fix",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared clause by clause against the original head: the five classes, the hypothesis block, plan review, the four cited cases, the rejected alternative and the deferred seeding are all present.",
    "dropped": []
  }
}
```

# FEAT-060 — Agents executed the orchestrator's reading instead of testing it

## Diagnosis

The orchestrator's context converges on one interpretation, and the charter it writes encodes that interpretation as settled. The dispatched agent then executes the framing instead of testing it, so a wrong reading is carried all the way to a build. The countermeasure that worked in practice — 'verify my claims before building on them' — only appeared when the orchestrator happened to type it, which is a habit rather than a system.

Running more orchestrators in parallel was explicitly rejected: it multiplies framings and supplies no resolver. The fix is to make the single framing falsifiable and to insert a real planning step where the answer is not already obvious.

## Evidence

Four cases from the board show the failure and the near-miss:

- BUG-024 — a bug filed from a single hand-check, which the dispatched agent proved to be a misdiagnosis; the feature worked.
- BUG-033 — an inherited diagnosis forwarded unchecked, where the agent found that point 2 as literally written would have been a regression.
- ARCH-001 — five targeted fixes over one class, because every dispatch asked to fix a symptom and none asked whether the subsystem should exist in that shape.
- FEAT-056 — exists because the recurrence trigger depended on the orchestrator remembering.

The built work was exercised by five suites: pattern templates 34/34, methodology sync 3/3, routing injection 18/18, template read-through 18/18, and self-maintenance of the working agreement 39/39. Typecheck was clean.

## Implementation notes

Five dispatch classes are chosen explicitly before a charter is written and recorded in the charter so the choice is auditable: trivial (just do it), fix (known cause, contained — today's shape), explore (cause or approach genuinely unknown; return two or three approaches with trade-offs and a recommendation, and build nothing), plan+review (high cost-of-mistake; explore first, then an independent reviewer critiques the plan before any build, on a different provider by default), and arch (a recurring class, filed invariant-first).

Every charter carries a falsifiable hypothesis block: the current reading is stated, the agent verifies it first, and stops and reports rather than building if it is wrong. It is a template field so omission is visible.

The classifier and the hypothesis rule live in the canonical working agreement so they reach every project's sessions. The explore and plan+review shapes live as entries in the existing workflow-pattern templates, so they are copy-pasteable charters.

Because the class is recorded, a later pass can ask how many dispatches sent as fix turned out to need explore — measurable drift rather than impression.

## Verification plan

Confirm the templates exist and are injected, that a charter missing the hypothesis block reads as incomplete, that at least one real exploration dispatch ran end to end and returned options rather than a build, that the agreement and routing mirror are in sync, and that nothing auto-refactors existing charters.

## Activity log (APPEND-ONLY)
### 2026-08-09 — orchestrator
- Filed from the user's question. Analysis + evidence recorded above; the "don't add more
  orchestrators" conclusion is stated explicitly so it is not re-proposed later.

### 2026-08-10 — builder (mechanical parts built)
**User decisions implemented (settled, not re-litigated):** (A) `plan+review` defaults to the
OTHER provider than the implementer; `explore` MAY be cross-provider (optional). (B) ROUTING's
budget guidance was INVERTED for this user and is corrected.

- **Dispatch classes → canonical WA §I** (`~/projects/methodology/WORKING_AGREEMENT.v2.md`), as a
  table with a one-line "how to choose" test each: `trivial` (you already know the exact edit),
  `fix` (you can name the cause AND blast radius in one sentence each), `explore` (you cannot name
  the cause, or >1 defensible approach → 2–3 options + trade-offs + a recommendation, builds
  nothing), `plan+review` (high cost-of-mistake §N → explore, then an INDEPENDENT agent critiques
  the plan before any build, cross-provider by default), `arch` (Nth bug in a class → ARCH-###,
  invariant first, no build until a human picks). The class MUST be recorded in the charter and
  the ticket — that is what makes the "how many `fix` dispatches should have been `explore`?"
  audit possible. Added a "default UP when torn" rule with the asymmetry spelled out.
- **Falsifiable-hypothesis rule → WA §I**, as a quoted block charters copy verbatim: "Hypothesis
  (verify FIRST): my current reading is X … if X is wrong, STOP and report — do not build on it."
  Cites the two real saves (the misdiagnosed bug where the feature actually worked; the inherited
  diagnosis whose "point 2 as literally written would have been a regression"). It is also a
  visible FIELD in both new pattern templates, so omission is obvious rather than silent.
- **WA §N** gained "Review the PLAN, not just the finished code" pointing at `plan+review`.
- **ROUTING.md budget correction** (canonical + mirror): a dated, clearly-marked **per-user
  capacity fact (2026-08-10) — configuration, not physics**, stating the correction from the
  inverse: Claude capacity is effectively ABUNDANT; the $20 ChatGPT Plus plan on rolling 5-hour
  windows is the SCARCE resource. GPT is spent on DECORRELATION (plan review, adversarial review
  of finished work, a contested second opinion), NOT bulk/parallel volume, which goes to the
  abundant Claude ladder. Skill-based findings left intact and explicitly flagged as independent
  of the budget layer; the raw-price note (Luna/Terra are cheaper per token) is kept but marked as
  not the binding constraint under subscriptions. The condensed injected core carries a short
  version of both the budget fact and the cross-provider `plan+review` default.
- **Two new workflow-pattern templates** in `docs/prompts/patterns/`, matching FEAT-024's shape and
  voice (When to use / When NOT to use / How to run it / Failure modes to avoid):
  `EXPLORE.md` (returns 2–3 approaches + trade-offs + one recommendation, BUILDS NOTHING — with an
  explicit no-edits charter constraint and a "say which approach you would NOT take") and
  `PLAN_REVIEW.md` (independent agent critiques the PLAN before any build, cross-provider by
  default, verdict GO / GO-WITH-CHANGES / NO-GO, NO-GO must be a real possible outcome).
- **Not done, deliberately (scope):** the two new patterns are NOT yet registered as seeded
  instruction templates — that requires `seedTemplates()` in `src/server/templates.ts`, which was
  explicitly out of scope for this build (another agent held the file). They are read-through-ready
  docs; adding two `DEFAULT_SEED_SOURCES` entries (ids `pattern-explore`, `pattern-plan-review`)
  plus their ids in `scripts/verify-pattern-templates.mjs` is the follow-up. `package.json` and
  claude-station git were not touched.
- **Verified (all PASS):** `sync:methodology` (WA v2 + ROUTING synced to the mirror) →
  `verify:methodology-sync --check` OK, 3/3 in sync. `verify:routing-inject` 18/18 — injected core
  measured at **2785 chars against the 4000 cap, so NOTHING had to be trimmed** (core grew
  1975 → 2417 raw). `verify:pattern-templates` 34/34. `verify:template-readthrough` 18/18.
  `verify:wa-selfmaintain` 39/39 — the consolidation loop handles the new sections and the real
  canonical repo was left byte-identical by the test. `npm run typecheck` clean.
  `node scripts/arch-watch.mjs` → exit 0, still question-only, no writes (it now clusters FEAT-060
  into [templat+work+workflow] alongside FEAT-024/026/027, which is correct).
- Canonical methodology repo committed (`0560910`); claude-station left uncommitted per scope.

**Closing assessment — symptom of a deeper design flaw? YES, and it is named in the ticket
itself:** the design flaw is that the orchestrator's framing was never falsifiable, and every
countermeasure depended on the orchestrator REMEMBERING to write it. This build converts two
remembered habits into recorded, auditable fields (the class, the hypothesis). No ARCH-### filed —
this ticket already IS the structural fix for that class, and the invariant it now enforces
("no charter without a recorded class and a falsifiable hypothesis") is stated in the WA rather
than in a new container. The honest residual risk: nothing MECHANICALLY rejects a charter missing
those fields — the enforcement is a template field plus a doc rule, so drift is possible and the
class-drift audit in point 5 is the detector. Also open: the two patterns are not yet selectable
in the UI (seed registration deferred above), so today they are documentation, not a click.
