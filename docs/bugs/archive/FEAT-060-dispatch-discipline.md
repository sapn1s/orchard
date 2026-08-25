# FEAT-060 — dispatch discipline: when a request needs planning/refutation, not a targeted fix

- **Status:** VERIFIED (mechanical parts built 2026-08-10; seed-registration of the two new
  pattern templates in `src/server/templates.ts` deferred — see the closing activity entry)
- **Area:** methodology (universal WA + workflow templates) — how work is CHOSEN and framed
- **Reported:** 2026-08-09 by user ("is having one orchestrator even good enough? the problem is
  whatever your one-time context converges to gets passed down as a specific targeted task instead
  of e.g. more planning … we need a better system to know when to pass what, what needs another
  agent for planning or reviewing")

## The real failure mode (evidence from this session, not theory)
The orchestrator's context converges on an interpretation, and the charter it writes ENCODES that
interpretation. A dispatched agent then executes the framing rather than testing it. When the
framing is wrong, the whole chain is wrong. Observed:
- **BUG-024**: orchestrator filed a bug from a single hand-check; the dispatched agent proved it a
  MISDIAGNOSIS (the feature worked).
- **BUG-033**: the orchestrator forwarded an inherited diagnosis; the agent found "point 2 as
  literally written would have been a regression".
- **ARCH-001**: five targeted fixes over one class, because every dispatch asked "fix this
  symptom", never "should this subsystem exist in this shape?".
- **FEAT-056** exists precisely because the recurrence trigger depended on the orchestrator
  REMEMBERING.
The countermeasure that worked each time ("verify my claims before building on them") fires only
when the orchestrator happens to write it. That is not a system.

## What NOT to do (stated so it isn't re-proposed)
More orchestrators in parallel does not fix framing error — it multiplies framings with no
resolver. The fix is to make the single orchestrator's framing FALSIFIABLE and to insert a real
planning step where the answer isn't obvious.

## Proposal (mechanical parts first)
1. **Dispatch classes, chosen explicitly before writing a charter** — record the class IN the
   charter so it is auditable:
   - `trivial` — do it (orchestrator may still dispatch for traceability).
   - `fix` — known cause, contained: today's charter shape.
   - `explore` — cause/approach genuinely unknown: agent returns 2–3 approaches with trade-offs and
     a recommendation, and BUILDS NOTHING. (This class does not exist today; it is the gap.)
   - `plan+review` — high cost-of-mistake (§N): explore, then an independent reviewer critiques the
     PLAN before any build. Cross-provider by default (ROUTING rule).
   - `arch` — recurring class: ARCH ticket, invariant-first (FEAT-056).
2. **Every charter carries a falsifiable hypothesis block**: "My current reading is X. Verify it
   FIRST; if X is wrong, STOP and report — do not build on it." (Retroactively: this is what saved
   BUG-024 and BUG-033.) Make it a template field so omission is visible.
3. **Plan review** — for `plan+review`, a second agent reviews the PLAN (not the code). We already
   review finished code (gatekeeper, cross-provider); nothing reviews a plan today.
4. **Where it lives**: the classifier + hypothesis rule go into the canonical WA (§I/§N extension)
   so they reach every project's sessions; the `explore` and `plan+review` shapes become entries in
   the existing workflow-pattern templates (FEAT-024) so they are copy-pasteable charters.
5. **Cheap audit signal**: since the class is recorded in the charter/ticket, a later pass can ask
   "how many fixes were dispatched as `fix` that turned out to need `explore`?" — measurable drift,
   not vibes.

## Open question for the user (not blocking the mechanical parts)
Whether `explore` should default to the OTHER provider (decorrelated framing — a GPT planner
reviewing a Claude orchestrator's reading, or vice versa). Recommendation: yes for `plan+review`,
optional for `explore`.

## Verification
Templates exist and are injected; a charter missing the hypothesis block is visibly incomplete
(template field); at least one real `explore` dispatch performed end-to-end and its output shown to
be a set of options rather than a build; WA/ROUTING mirror synced; nothing auto-refactors.

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
