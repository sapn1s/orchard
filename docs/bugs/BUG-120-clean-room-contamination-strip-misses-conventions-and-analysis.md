```orchard-ticket
{
  "id": "BUG-120",
  "type": "bug",
  "title": "Independent verifiers can read the plans they are meant to check",
  "summary": "The isolated workspace used for independent checks removes only two documentation folders. Conventions, architecture notes, in-flight analysis, the task list and handover notes all travel in. A checker meant to attack a change from outside can therefore read the plan the author worked from, and the verdict never says what it was allowed to read.",
  "impact_if_we_wait": "Independent verdicts are weaker than they appear, because a checker can grade work against the same expectations that produced it. Bounded: this is passive exposure, with no evidence that any past checker read those files or that any past verdict is wrong.",
  "current_need": "Build the inversion here: the clean room receives only what a check names as an input, and each verdict records what it was given.",
  "severity": "medium",
  "area": "Verification isolation",
  "reported": "2026-08-19",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-08-25",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-19",
      "question": "Should the isolation rule be inverted here, or folded into the earlier open ticket on the same boundary?",
      "mode": "single",
      "options_keys": [
        "A",
        "B"
      ],
      "chosen": "A",
      "chosen_on": "2026-08-25",
      "chosen_by": "user, through the ARCH-010 class decision",
      "note": "ARCH-010's third success criterion settles this without a separate session: a list that names what to leave out is a reader working out what is safe from a list that cannot know. The owner of a check names its inputs instead. B would fold the work into BUG-104, which stays open on a different question, and this ticket's own note is that naming the leaked folders is what failed twice already."
    }
  ],
  "success_criteria": [
    "A document not named as an input is absent from the isolated workspace",
    "Adding a new project document requires no change to the isolation rule",
    "Each verdict records the files the workspace was given"
  ],
  "code_refs": [
    {
      "path": "scripts/independent-verify.mjs",
      "symbol": "CONTAMINATION",
      "note": "strips docs/prompts and docs/bugs only; surfaced during a cross-provider round on commit 74e03e2 and filed as BUG-120"
    }
  ],
  "related": [
    {
      "id": "BUG-104",
      "relation": "recurrence_of"
    },
    {
      "id": "BUG-121",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [
    "BUG-104"
  ],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": true,
    "Migration and rollback": false,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-120-clean-room-contamination-strip-misses-conventions-and-analysis.md",
    "sha256": "80faae85c8d53a1eac6d254a615964b36bdeea6d0588daef4ea37073135d42ae",
    "bytes": 4146,
    "original_title": "the clean room strips only two doc dirs, so CONVENTIONS, TODO, HANDOVER and docs/analysis survive into every independent verification",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head: the five leaked paths, the deny-list-versus-allow-list argument, the input-recording requirement, the prior instance and the bound are all present.",
    "dropped": [
      "the note that the filing lane did not touch the verify script and attempted no fix",
      "the note that the ticket was not yet in the board index pending a board regeneration"
    ]
  }
}
```

# BUG-120 — Independent verifiers can read the plans they are meant to check

## Diagnosis

The clean room's `CONTAMINATION` strip is a deny-list naming `docs/prompts` and `docs/bugs`. Everything else under `docs/` and at the repo root survives, including at least `docs/CONVENTIONS.md`, `docs/ARCHITECTURE-REVIEW.md`, `docs/analysis/`, `TODO.md` and `HANDOVER.md`. These carry the project's methodology, its architectural conclusions, its in-flight plans and its handover notes — exactly the frame a clean-room verifier is supposed to work outside of.

A deny-list is wrong here by construction: it must be updated whenever the project grows a new document, and nothing fails when it is not. That is how these five entered. BUG-104 was the same defect one directory over, and it was answered by naming the two directories that had leaked rather than by inverting the rule.

Whether a deny-list guarding an isolation boundary warrants an architecture ticket of its own, or belongs inside BUG-104's scope, is for whoever picks this up.

## Evidence

Running `node scripts/independent-verify.mjs` for any ticket and inspecting the room's working tree shows `docs/CONVENTIONS.md`, `docs/ARCHITECTURE-REVIEW.md`, `docs/analysis/`, `TODO.md` and `HANDOVER.md` present. Nothing has been run to establish whether a past verifier actually read any of them; the room reports only PASS or BROKEN and never what it was allowed to read.

## Implementation notes

The strip becomes an allow-list: a file enters only because something named it as necessary input. The room should additionally record the set of files it was given, so a verdict can be read against its own inputs.

## Verification plan

Add a document under `docs/` that no input list names, run a clean-room pass, and assert it is absent from the room's tree. Assert the recorded input manifest matches the tree.

## Risks

An input list that omits a genuinely required file produces a verification failure that looks like a real defect.

## Activity log (APPEND-ONLY)

### 2026-08-19 — ticket-view content-loss lane

- **Understood:** an independent cross-provider round on `74e03e2` reported that
  the clean room's `CONTAMINATION` strip covers `docs/prompts` and `docs/bugs`
  only, so `docs/CONVENTIONS.md`, `docs/ARCHITECTURE-REVIEW.md`, `TODO.md`,
  `HANDOVER.md` and `docs/analysis/` reach every verifier. The coordinator ruled
  it out of that lane's scope and asked for it to be filed.
- **Changed:** nothing. This ticket only.
- **Verified:** nothing — not investigated in code. The finding is the verifying
  round's, reported second-hand and recorded verbatim rather than re-derived.
- **Still open:** all of it. Confirm the current strip list in
  `scripts/independent-verify.mjs`, decide allow-list vs deny-list, and decide
  whether this folds into BUG-104 or stands alone.
- **Handoff:** next agent should start by reading BUG-104 rather than this
  ticket's Expected section — that ticket already argued the boundary once, and
  the useful question is why the fix there did not generalise, not what to strip
  next.

### 2026-08-25 — settled by the class decision (ARCH-010 option A); no build in this lane

- **Understood:** this ticket's open question — invert the rule here, or fold it into BUG-104 — is
  answered by the class decision the user took on 2026-08-25, whose third success criterion is that
  exclusion lists naming what to leave out are replaced by lists naming what to let in. Folding it
  into BUG-104 was the alternative, and BUG-104 stays open on a genuinely different question (what
  to do about real methodology and ticket text quoted inside verify scripts), so folding would park
  this behind a decision that does not contain it.
- **Re-measured before recording it.** `scripts/independent-verify.mjs:218-222` still holds a
  `CONTAMINATION` array naming eleven paths to delete, applied by an `fs.rmSync` loop at `:352-355`.
  `HANDOVER.md`, `docs/CONVENTIONS.md` and `docs/analysis/` still travel into the room — the exact
  complaint above, unchanged since 2026-08-19. Of the three sites the class decision names, one is
  already inverted (`scripts/leak-gate.mjs:73`, `IMG_ALLOW`, which is what an inverted rule looks
  like here) and the third, `scripts/wa-consolidate.mjs:279` (`PROJECT_MARKERS`), is still a
  hand-written marker list and belongs to BUG-042 rather than to this ticket.
- **Changed:** this ticket's record only — decision moved to `decision_history` with A chosen,
  `human_action` → `none`, `current_need` states the build. No code, no scripts. `work_state` stays
  `open` because nothing has been built.
- **Verified:** `validateTicket` ok; `npm run board:check` exit 0, read directly.
- **Still open / handoff:** all of the build, and it is the one piece of this class that touches
  verification integrity — a room starved of a file it genuinely needed reports a false failure
  that looks exactly like a real one, so the named-inputs list has to be derived from what each
  check actually reads, and the verdict must record what it was given. Nothing here changes the
  archived corpus or any past verdict.
