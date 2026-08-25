```orchard-ticket
{
  "id": "ARCH-013",
  "type": "architecture",
  "title": "Every project must run adversarial rounds; only one has the tool",
  "summary": "A trivial landing-page fix bought a verification round, and the verifier repeated the fixer's own check. The scoping half is fixed in the WA this lane. The duplication half is not text: independent-verify.mjs, the only adversarial verifier charter, exists in orchard alone, so a round dispatched elsewhere is an ad-hoc subagent that repeats the demonstration.",
  "impact_if_we_wait": "Every non-orchard project keeps paying clean-room prices for a round that cannot be a round. The expensive half is already closed by the shipped harm-class table, so what remains is duplication, not risk. No product behaviour is affected and no data is exposed.",
  "current_need": "A human picks an option. No build starts until then.",
  "severity": "medium",
  "area": "Verification tooling reach across projects",
  "reported": "2026-08-25",
  "reported_by": "user",
  "owner": "you",
  "work_state": "open",
  "human_action": "decide",
  "updated": "2026-08-25",
  "decision": {
    "mode": "single",
    "question": "How does an adversarial verification round become available outside orchard?",
    "options": [
      {
        "key": "A",
        "label": "Sweep the verifier into every onboarded project",
        "what_changes": "independent-verify.mjs and its vrun harness join SYNCED_TOOLS in fleet-sync.mjs, beside board.mjs and verdict-contract.mjs.",
        "benefit": "Uses machinery that exists and a path already proven for verdict-contract. Cheapest of the three builds.",
        "cost": "The sweep skips the 7 projects with no docs/bugs, and a swept copy goes stale in its target — the failure BUG-118 recorded for verdict-contract.",
        "why_not_obvious": "Copying a tool into 13 trees is how verdict-contract got the staleness bug this project already paid for once."
      },
      {
        "key": "B",
        "label": "Make the round a launcher capability",
        "what_changes": "The station offers a verify dispatch verb; the clean-room export and adversarial charter are owned centrally, with no copy in any target tree.",
        "benefit": "No staleness, no per-project onboarding, and it reaches projects with no board.",
        "cost": "New machinery in the subsystem where this project's defects concentrate. ARCH-011 declined a service-shaped answer to an adjacent question for exactly this reason.",
        "why_not_obvious": "It is the architecturally clean answer and the one this board has twice decided it cannot afford."
      },
      {
        "key": "C",
        "label": "Enforce at dispatch time, distribute nothing",
        "what_changes": "dispatch.mjs refuses a verify-phase dispatch that lacks a harm class scoring above zero and a NAMED attack distinct from the fixer's recorded command.",
        "benefit": "Turns 'if you cannot name the attack, do not commission it' into a refusal at the moment of spend, not after. No new copies anywhere.",
        "cost": "dispatch.mjs is orchard-local, so it enforces where the problem is least present. The class is self-declared, which is ARCH-011's own flaw.",
        "why_not_obvious": "The self-declaration flaw is inverted here: the cheap direction is to under-claim and skip a round, which the recorded class makes auditable afterwards."
      },
      {
        "key": "D",
        "label": "Accept the asymmetry and say so",
        "what_changes": "The WA states that a clean-room round exists only where the project provides a clean-room verifier; elsewhere the fixer's recorded demonstration plus the harm-class table is the whole proof.",
        "benefit": "Costs nothing and closes the duplication by deleting an instruction that cannot be honoured.",
        "cost": "Loses what rounds uniquely buy: hidden-content defects, a verifier's own suite being vacuous, and claims of proof about unproven work.",
        "why_not_obvious": "Deleting an unhonourable rule is usually right; here it is the one rule measured as catching what nothing else catches."
      }
    ],
    "recommendation": "C",
    "recommendation_reason": "The scoping fix already removes most rounds, so what remains is whether the survivors are real. C refuses an unnameable round where the spend happens, in a file that already records class and round."
  },
  "decision_history": [],
  "success_criteria": [
    "In any project, the command that runs an independent verification round can be named, and running it produces a run id the ticket can cite.",
    "A verification round's evidence contains at least one command that is not the fixer's recorded command.",
    "A round commissioned on a harm class scored at zero is refused or flagged, not merely discouraged.",
    "The share of rounds whose only finding was already on the fixer's handoff list falls below the measured one in three.",
    "More than a fifth of harm-class declarations under-claiming — a zero-round class that later produced a user-visible defect — falsifies option C."
  ],
  "code_refs": [
    {
      "path": "scripts/independent-verify.mjs",
      "symbol": null,
      "note": "Lines 572-577 and 611-617 carry the only genuinely adversarial verifier charter in the fleet ('ATTEMPT TO BREAK THAT CLAIM ... not to review it, not to double-check it, not to be fair to it'). Checked on disk across five other registered project trees (three with a board, two without): absent from all five, and none of them has vrun.mjs either."
    },
    {
      "path": "scripts/fleet-sync.mjs",
      "symbol": "SYNCED_TOOLS",
      "note": "Line 79 sweeps board.mjs, arch-watch.mjs, lib/verdict-contract.mjs, lib/ticket-schema.mjs and hooks/response-format-gate.mjs. independent-verify.mjs is not in the list, and the sweep skips any project without docs/bugs."
    },
    {
      "path": "scripts/lib/verdict-contract.mjs",
      "symbol": null,
      "note": "Already fleet-synced and already enforcing the RECORD shape: a Verified-by line must name a dispatch run id (line 1087) and a verdict needs a fixer-test run id plus a distinct ADVERSARIAL run id (line 843). Precedent that enforcement of this class works — but it bites at record time, after the spend, and only in the 5 projects with a board."
    },
    {
      "path": "docs/prompts/WORKING_AGREEMENT.v2.md",
      "symbol": "SS-I threshold, SS-N stopping rule, SS-C handoff",
      "note": "The scoping half, landed by this lane. composeInstructions reads it fresh from this checkout at every launch, so it reaches all 12 live registry projects with no re-seed and no per-project action."
    },
    {
      "path": "scripts/verify-verification-scoping-reach.mjs",
      "symbol": null,
      "note": "Fleet-wide reach guard over the REAL registry: composes every project's launch bundle through the real path and asserts the scoping rule lands and the superseded threshold does not. 176/176 after; must-FAIL baseline 85 passed / 91 failed."
    }
  ],
  "related": [
    {
      "id": "ARCH-011",
      "relation": "see_also"
    },
    {
      "id": "BUG-145",
      "relation": "see_also"
    },
    {
      "id": "FEAT-085",
      "relation": "see_also"
    },
    {
      "id": "FEAT-096",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [
    "BUG-145",
    "FEAT-085",
    "ARCH-011",
    "FEAT-096"
  ],
  "verification": [],
  "verification_class": "arch",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": false,
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
    "confirmation": "Delivery was traced through src/server/templates.ts and the real registry before any text was written; the absence of independent-verify.mjs and vrun.mjs in five other project trees was checked on disk, not inferred.",
    "dropped": []
  }
}
```

# ARCH-013 — Every project must run adversarial rounds; only one has the tool

## The invariant being broken

**An instruction that names a capability must not be issued to a place that does not have
it.** One testable sentence: for every project the Working Agreement reaches, the command
that performs an independent clean-room verification round can be named and run. Today the
answer is yes in one project and no in twelve, while the instruction is identical in all
thirteen.

## Diagnosis

The user watched a landing page that would not scroll to its form get fixed on another
project. The fixer launched a browser and confirmed the fix. It then dispatched a verifier,
which launched a browser and confirmed the fix. Two faults, and they have different causes.

**Fault 1 — a trivial change bought a round at all.** This was a missing rule, not an
ignored one. The measured decision — rounds are spent by harm class, and a contained render
or CSS change gets none — lived only in `docs/analysis/counterfactual-2026-08-20-minimum-path.md`,
which no prompt, script, hook or agent definition cites. What the WA actually said was
"required for `fix`, `plan+review` and `arch`", so the session did exactly what it was told.
**That half is fixed and is not what this ticket is for** — see *Migration and rollback*.

**Fault 2 — the round, once commissioned, duplicated the fixer's work.** This one the WA
already covered, twice: "**Adversarial objective:** 'attempt to BREAK this claim', never
'check this work'", and "**A separate agent PROCESS, never one of your own subagents.**"
Both were present, and both were not followed. That is the same shape as the inline-command
drift (BUG-145) and the overlong-reply drift (FEAT-085), and it means more text is not the
lever.

**Why it was not followed is mechanical, not attitudinal.** The adversarial charter is not
in the WA in any runnable form — it lives inside `scripts/independent-verify.mjs`, which
exports a clean room, strips the ambient instruction surface, dispatches cross-provider and
hands the verifier the fixer's test code with an explicit order to break it. That script
exists in orchard and nowhere else. `fleet-sync.mjs` sweeps five tools and this is not one
of them, and the sweep skips any project without `docs/bugs` — which is seven of thirteen.
So in another project there is no clean-room verifier to dispatch. What gets dispatched
instead is an in-process subagent with an ad-hoc prompt, inheriting the session's framing,
its board snapshot and its reading of the bug. Such a verifier repeats the demonstration by
construction: it is the same context, given the same target, with no instruction to attack
and no fixture it has not already seen.

**The asymmetry is the finding.** The obligation is universal and the capability is local.

## Evidence

- **`scripts/independent-verify.mjs:572-577`** — the only genuinely adversarial verifier
  charter in the fleet: *"You are an INDEPENDENT VERIFIER … Your job is to ATTEMPT TO BREAK
  THAT CLAIM by running things — not to review it, not to double-check it, not to be fair to
  it."* And `:611-617`: *"the defects that survive are the ones the FIXTURE does not
  exercise."*
- **Checked on disk, not inferred.** `scripts/independent-verify.mjs` is absent from
  five other registered project trees, sampled across the registry. None of them carries
  `vrun.mjs` either. Three of the five have a board; two do not.
- **`scripts/fleet-sync.mjs:79`** — `SYNCED_TOOLS = ['board.mjs', 'arch-watch.mjs',
  'lib/verdict-contract.mjs', 'lib/ticket-schema.mjs', 'hooks/response-format-gate.mjs']`.
  The verifier is not in it. The sweep also refuses any project lacking `docs/bugs`.
- **Delivery of the WA itself is not the problem, and was checked first.**
  `composeInstructions` (`src/server/templates.ts:501`) resolves both WA templates against
  the orchard checkout via `projectRoot()` and reads them from disk on every launch
  (`templates.ts:142-159`), so one edit reaches every project with no re-seed, no restart and
  no per-project action. Measured over the real registry: 12 of 13 rows compose a bundle
  containing the new text; the 13th is a dead registry row whose `hostPath` no longer exists
  on disk.
- **The WA v2 template is uncapped**, unlike conventions (4k), routing (4k), response format
  (6k) and the board snapshot (1.2k). The added rule cost 4,374 chars (~1.1k tokens) per
  session and none of it is truncated — the guard asserts the document's last line survives
  the fold.
- **Enforcement of this class already works here, once.** `scripts/lib/verdict-contract.mjs`
  is fleet-synced and already refuses a record whose `Verified-by:` does not name a dispatch
  run id (`:1087`), and requires a fixer-test run id plus a *distinct* adversarial run id
  (`:843`). It bites at record time, after the spend, and only where a board exists.
- **Measured yield, from the counterfactual analysis.** 23 of 26 rounds found a reproducing
  defect, but sorted by class the picture splits: one ticket's five rounds each found a
  different class and every round earned its place, while another's six alternated between
  two readings of one boundary and bought nothing after the second. A third of rounds in that
  window found only defects the fixer had already written down as open items.

## Verification plan

**The proof bar — what must be true to call the new shape right.**

1. Name the command that runs an independent round, in a project picked at random from the
   registry, and run it. It produces a run id. If the answer is "there isn't one", the
   invariant is not held.
2. Take a real verification record and diff the verifier's commands against the fixer's
   recorded command. At least one must differ. A record where they are identical is a
   duplicated round however it was labelled.
3. A dispatch commissioned on a zero-round harm class is visible as such — refused, or at
   minimum recorded so the count is auditable afterwards.
4. The share of rounds whose only finding was already on the fixer's handoff list is measured
   again over a later window and compared against the one-in-three baseline.

**What would falsify it.**

- More than a fifth of harm-class declarations under-claim — a change declared contained
  render or test-suite-only that later produces a user-visible defect. Then self-declared
  class is not safe to spend against and option C is wrong.
- The surviving rounds turn out to be rare enough that no project outside orchard commissions
  one in a month. Then options A and B are both machinery for a problem that does not recur,
  and D is the honest answer.
- A clean-room round run through a swept copy of the verifier disagrees with one run from
  orchard on the same diff. Then the copy is not equivalent and A is unsafe.

## Migration and rollback

**Already landed, and deliberately not part of this decision** — the scoping half of the
problem, in the canonical Working Agreement (`~/projects/methodology/WORKING_AGREEMENT.v2.md`,
mirrored to `docs/prompts/WORKING_AGREEMENT.v2.md` by `npm run sync:methodology`):

1. **§I** — the dispatch-class threshold is replaced by a harm-class table. Contained
   render / one cell / CSS / copy / a scroll target buys **zero** rounds, as does a
   test-suite-only change, `trivial` and docs-only. The landing-page case is named in the
   table so the class is recognisable rather than inferable.
2. **§I** — the fixer/verifier line: the fixer demonstrates and records the command and its
   real output; the verifier re-runs that command exactly once and everything after must be a
   case the fixture does not cover. A verifier that reproduces the demonstration and agrees
   has bought nothing.
3. **§N** — the stopping rule: the round number is not the test, the class changing between
   rounds is. Two consecutive wording-or-cosmetics rounds stop.
4. **§C** — the handoff list is a work queue, not a disclosure: no round is commissioned
   while the fixer can name an untested attack.

Rollback is `git revert` on the methodology commit plus `npm run sync:methodology`; the next
launch picks up the reverted text with no other action.

**Not landed, and the subject of the decision:** anything that makes a round adversarial
outside orchard. No build starts until an option is chosen.

## Risks

- **The zero-round classes will be over-claimed.** Skipping a round is the cheap direction
  for every party, so the pressure on the table runs one way. This is ARCH-011's flaw —
  whoever does the work chooses the check — arriving in a new place. It is bounded here: the
  class is recorded in the dispatch line, so over-claiming is auditable afterwards rather
  than invisible, and the harm ceiling of a wrongly-skipped contained-render round is a
  cosmetic defect the user reports.
- **The WA grew by ~1.1k tokens on every session in every project.** That is the price of
  putting the table where it is read. If the fleet's round count does not fall, the tokens
  bought nothing and the table should be cut back to the two zero-rows.
- **Two rules now sit next to each other that can be read as contradictory** — "generation
  must not verify itself" and "the fixer demonstrates". The new paragraph exists to state
  that they are not in tension, but the previous misreading produced exactly the duplication
  this ticket is about, so a second misreading is plausible.
- **Option A repeats a known failure.** verdict-contract was copied into every onboarded repo
  and went stale in the copies where the bug lived (BUG-118). Sweeping a second tool the same
  way invites the same outcome.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-25 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-08-25 — lane (verification scoping)
- **Understood:** the brief said to establish why the measured rule did not apply on another
  project *before* writing more rule, because "it never reached them" and "it reached them and
  was ignored" have different fixes. Delivery was checked first and is **not** the fault: both
  WA templates resolve against this checkout and are read from disk on every launch, so the
  fleet shares one file. The rule simply was never written down — the harm-class table, the
  stopping rule and the handoff rule existed only in `docs/analysis/counterfactual-2026-08-20-minimum-path.md`,
  cited by nothing. The WA in force said every `fix` gets a round; the session obeyed it.
  So fault 2 is a *correction of a wrong sentence*, which is exactly what text is for — and
  it pushes WITH the local incentive (skipping a round is cheaper for everyone), unlike the
  inline-command rule, which asks for restraint against convenience and therefore drifts.
  Fault 1 is the opposite: the WA already forbade in-process verifier subagents and already
  chartered verifiers to break rather than check, and both were ignored, because the artifact
  that makes a round adversarial exists in orchard alone. That half is this ticket.
- **Changed:** canonical `~/projects/methodology/WORKING_AGREEMENT.v2.md` — §I threshold
  replaced by the harm-class table, §I gained the fixer-demonstrates/verifier-attacks line,
  §N gained the stopping rule, §C gained the handoff-is-a-work-queue rule; synced to the
  injected mirror. `docs/prompts/patterns/VERIFY.md` re-pointed at the table so it stops
  contradicting the WA. New `scripts/verify-verification-scoping-reach.mjs`. This ticket.
- **Verified:** 176/176, exit 0. Must-FAIL was taken **before** any text was written and over
  the REAL registry, not a fixture: 85 passed / 91 failed, with all 12 live projects missing
  every marker and all 12 receiving the superseded threshold. After the edit and sync: 176/176,
  every marker present in every project's composed bundle, the superseded sentence absent
  everywhere, and the WA's last line still present (so nothing truncates v2). The CONTROL
  arm — the same fold with an EMPTY instruction stack — was green in BOTH runs, which is what
  proves the markers come from the WA and not from a project's own CONVENTIONS.md or board
  snapshot. `npm run gate` exits 0, read unpiped.
- **Still open / handoff:** the decision above. Two attacks are named and NOT run, because
  neither is testable before an option is picked: (i) whether a swept copy of
  `independent-verify.mjs` in a foreign tree produces the same verdict as the orchard original
  on the same diff — option A's whole premise; (ii) whether a self-declared harm class is
  under-claimed in practice, which needs a window of dispatches recorded under the new rule
  and cannot be simulated. `docs/analysis/counterfactual-2026-08-20-minimum-path.md` is now
  cited by an instruction surface for the first time and should stay cited. This is a
  docs-and-instruction change with no product behaviour, so by its own new table it is the
  zero-round class and does not warrant an independent round — but the *reach* claim is
  fleet-wide and asserted from one machine's registry, so if that claim is doubted, re-run
  `scripts/verify-verification-scoping-reach.mjs` rather than re-reading this entry.
