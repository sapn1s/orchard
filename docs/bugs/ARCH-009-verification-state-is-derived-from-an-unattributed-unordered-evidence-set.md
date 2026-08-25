```orchard-ticket
{
  "id": "ARCH-009",
  "type": "architecture",
  "title": "Ticket proof status could be silently misclassified",
  "summary": "Ticket records now carry attributed verdicts without a computed proof status. The one-time migration quarantines conflicting evidence instead of guessing. Four of 192 tickets are quarantined, and the targeted verification suite passed all 118 checks.",
  "impact_if_we_wait": "Before this change, migration could silently write incorrect proof classifications across the board. Bounded: this affected ticket display and filtering, not ticket content, user data, or executed verification evidence.",
  "current_need": "Treat the work as closed: the targeted checks exercised the contested-evidence gate and all 118 passed.",
  "severity": "high",
  "area": "Ticket migration",
  "reported": "2026-08-20",
  "reported_by": "bug-hunt workflow",
  "owner": "agent",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-08-20",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-20",
      "question": "Should migration quarantine ambiguity, define a whole-set rule, stop deriving proof status, or continue patching?",
      "mode": "single",
      "options_keys": [
        "A",
        "B",
        "C",
        "D"
      ],
      "chosen": "C, gated by A",
      "chosen_on": "2026-08-20",
      "chosen_by": "user",
      "note": "Stop deriving the field permanently. During the one-time migration, quarantine contested evidence for human resolution."
    }
  ],
  "success_criteria": [
    "Ticket records omit the retired computed proof field",
    "Contested migration evidence is quarantined before model dispatch",
    "Attributed verdict data remains available to consumers",
    "One whole-set rule identifies unresolved broken verdicts",
    "Quoted verdicts and non-resolving records cannot silently change migration output"
  ],
  "code_refs": [
    {
      "path": "scripts/migrate-tickets.mjs",
      "symbol": "contestedEvidence",
      "note": "Stops migration when authored status and verdict evidence conflict or verdict attribution differs between parsing strategies."
    },
    {
      "path": "scripts/migrate-tickets.mjs",
      "symbol": "deriveVerificationState",
      "note": "Deleted with verificationStateFrom."
    },
    {
      "path": "scripts/lib/ticket-schema.mjs",
      "symbol": "REQUIRED_KEYS",
      "note": "The computed field was removed from required keys, enum validation, and cross-field rules."
    },
    {
      "path": "public/lib/ticket-record.js",
      "symbol": "outstandingBroken",
      "note": "Defines the sole whole-set rule used by both migration and ticket view consumers."
    },
    {
      "path": "scripts/verify-bug-119-verification-evidence.mjs",
      "symbol": null,
      "note": "Exercises metamorphic and live-corpus quarantine checks."
    }
  ],
  "related": [
    {
      "id": "ARCH-008",
      "relation": "see_also"
    },
    {
      "id": "BUG-119",
      "relation": "blocks"
    },
    {
      "id": "BUG-122",
      "relation": "blocks"
    },
    {
      "id": "BUG-124",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [
    "BUG-119"
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
    "archived_path": "docs/bugs/archive/ARCH-009-verification-state-is-derived-from-an-unattributed-unordered-evidence-set.md",
    "sha256": "965541eb096935b7dadfdbcd9408512a5219745668c8ca647f530ac34c8f12fa",
    "bytes": 21387,
    "original_title": "a ticket's verification state is computed from text the pipeline cannot attribute and does not read whole",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the archived ticket; the recurrence, chosen C-with-A design, implementation, measured quarantine result, evidence, compromise, and remaining clean-room pass are preserved.",
    "dropped": []
  }
}
```

# ARCH-009 — Ticket proof status could be silently misclassified

## Diagnosis

The former `verification_state` was derived by precedence guards over verdict lines scraped from prose. The scraper could not distinguish asserted verdicts from quoted examples, while `verificationStateFrom` considered only the final record. Successive guards therefore corrected individual routes without establishing a coherent function over attributed evidence.

## Evidence

At revision `c0e4257`, `FEAT-061` and `FEAT-062` derived `holds` despite unresolved `broken` verdicts. Fence-aware parsing also excluded eight genuine `FEAT-091` records. After implementation, 4 of 192 tickets were classified as contested and quarantined. `verify:bug-119-verification-evidence` ran 118/118 successfully under harness run `01a01bda`. The recurrence investigation was prompted by dispatch run 01a01bda-0005-7a83-95d0-a7452f81eb92.

## Implementation notes

The computed field and its derivation were removed from migration, schema, prompt, and view code. Verdicts remain attributed data in `verification[]`. `contestedEvidence` runs before dispatch and quarantines disagreements without choosing a state. `outstandingBroken` supplies one shared rule: a `broken` remains outstanding unless a later `holds` resolves it. The retired key is tolerated only on existing records, never written or read, and removed on rewrite.

## Verification plan

The executed suite appends a quoted verdict, appends an `invalid` record, and reorders non-decisive records over the real corpus. It also confirms that every disagreement between the authored-status and whole-set readings enters quarantine. A future independent pass should attempt to find another route by which file text becomes an unattributed claim.

## Migration and rollback

The migration performs the contested-evidence gate before model dispatch. Contested tickets stop for human resolution; uncontested tickets retain attributed verdict records. The derivation removal and gate can be reverted independently, while existing retired fields remain readable only long enough for a normal rewrite to strip them.

## Risks

Consumers lose a cheap stored proof-status filter and must derive views from attributed verdicts. The temporary retired-key tolerance could conceal stale records if migration never rewrites them. A new proof rule outside `outstandingBroken` would recreate the fragmented design.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-20 — BUG-119 fix lane

- **Understood:** a third clean-room verdict found a third stop-everything defect
  in the same function and required the §N question answered before any further
  guard. The invariant above is statable in one sentence and all three rounds
  break it, so this is a class and the answer is an ARCH ticket, not a fourth fix.
- **Changed:** nothing in the derivation. This ticket is the deliverable; per §N
  and the template, no build starts until a human picks an option.
- **Verified:** the two live mis-derivations were reproduced in a clean checkout
  at `c0e4257` (`git worktree --detach`), with no uncommitted state involved:
  `FEAT-061` and `FEAT-062` both carry an outstanding `broken` and both derive
  `holds`. Defect 2 (a quoted `VERDICT: BROKEN` flipping real `ARCH-003` from
  `holds` to `broken`) reproduced against the same revision.
- **Still open / handoff:** a human picks A, B, C or D. Until then the migration
  must not be run to completion — sample runs are fine and are how the prose half
  of BUG-119 is being verified.

### 2026-08-20 — ARCH-009 build lane (C, gated by A)

- **Understood:** the user chose C gated by A. The charter's hypothesis — "the
  consumers reading `verification_state` are few" — was checked FIRST and holds,
  with one correction worth recording: there are TWO different things called
  `verification_state`, and only one of them is this class. The MIGRATED
  record's field was derived from scraped `Verified-by:` lines (this ticket).
  The LEGACY reader's field is `classifyLegacyStatus` transcribing one authored
  Status word by a fixed table, which is not a derivation over an evidence set
  and was deliberately left alone — the gate needs it to compare against. The
  actual consumers of the derived field were four: the migration's own
  prompt/compose/grade, the schema's enum + two coherence rules, one hero pill
  in `public/app.js` via `VERIFICATION_LABEL`, and `blockSummary` in
  `scripts/lib/ticket-schema.mjs` (added by the concurrent BUG-122 lane while
  this was in flight). No filter and no sort read it.
- **Changed:** see "What landed" above. The UI question the charter flagged —
  "if a consumer would silently show wrong or empty state rather than degrade
  honestly, STOP" — was answered rather than skipped: dropping the pill outright
  would have left a VERIFIED ticket with an unresolved BROKEN showing nothing.
  So the hero now draws ONE proof pill, the loud one, from the record's own
  `verification[]` via `outstandingBroken()`; the three quiet pills are gone
  because they restated the work-state pill beside them and were computed by the
  thing that was wrong. Absence of proof is still STATED in the plan's own
  words, on the Proof card, which prints "Not recorded" and lists every verdict
  with its provider, run id and date. All three of the user's acceptance
  criteria are served: the model can no longer emit a proof field at all, the
  hero drops three pills, and a reader holds three orthogonal state fields
  instead of four.
- **Verified:** `verify:bug-119-verification-evidence` rewritten into C's
  properties and green at **118/118** (was 98 checks asserting the old
  behaviour, including a §12 that deliberately pinned the two defects as
  PRESENT; that section is now the same two cases inverted, on the same
  runtime-discovered donors). Every must-FAIL is anchored to a SYNTHESIZED copy
  of round 3's rule, never to `HEAD`. Non-vacuity, from the run's own output:
  round 3 mis-derives `FEAT-061 [broken,broken,broken,invalid,invalid,invalid,invalid] -> holds`
  and `FEAT-062 [broken,broken,invalid,broken,invalid] -> holds`, and both are
  now quarantined; a quoted `VERDICT: BROKEN` flipped real `ARCH-003` from
  `holds` to `broken` under round 3 and now stops the file instead; one
  `invalid` appended to real `ARCH-004` made round 3 report `pending` over an
  outstanding `broken`. The gate is driven END TO END through the real driver
  with a dispatch responder that records being called: the contested ticket is
  not staged, lands in `failed/` with the conflict named, the original is
  byte-identical, and **the model was never asked**. Anti-regressions run:
  `verify:ticket-schema` (57 passed, 1 pre-existing failure), `verify:migrate-tickets`
  (52 passed, 1 pre-existing failure), `verify:ticket-view-redesign` (238 passed,
  5 pre-existing failures — the same 5 the pre-change baseline shows in a
  detached worktree at `HEAD`). `npm run gate` exits 0.
- **Still open / handoff:** (1) an independent clean-room pass — this is a
  regression-prone file with a three-round history and generation must not be
  its own verifier; the attack to commission is ARCH-009's own proof bar, "find
  a third route by which text in a file becomes a claim the ticket did not
  make". (2) The 4 contested tickets need a human: `BUG-109`, `FEAT-061`,
  `FEAT-062` each say VERIFIED over an unresolved BROKEN; `FEAT-091` needs
  someone to say which of its 12 `Verified-by:` lines it ASSERTS. (3) The
  vestigial `verification_state` line in `ARCH-005`'s record — out of this
  lane's scope to edit, harmless (tolerated and unread), and removed
  automatically by the queued full migration. (4) A summariser gap found while
  rewriting the suite and reported rather than hidden: `summariseSelfEvidence`
  has no line for the PASS-MARKER-only shape, so `FEAT-028` has
  `hasSelfEvidence` true and an empty summary, and its prompt carries no
  evidence block. That is silence, not the denial BUG-119 was about, and it
  predates this lane.
