```orchard-ticket
{
  "id": "BUG-128",
  "type": "bug",
  "title": "A ticket listed itself among its own related tickets",
  "summary": "One ticket on the board named itself as a ticket to see also. A relation describes two tickets, so pointed at itself it says nothing. Nothing noticed it: not the validation gate, and not the pass that repairs relations, which would have built a second one from a ticket that blocks itself. Both now refuse; the live instance is repaired.",
  "impact_if_we_wait": "A reader following the relation graph is sent back to the page they are on, and the repair pass quietly doubles the fault instead of reporting it. Bounded: no ticket content is affected and one record on the whole board was wrong.",
  "current_need": "none — the self-edge gate and the repair pass were re-checked over the real board",
  "severity": "low",
  "area": "Ticket relations",
  "reported": "2026-08-20",
  "reported_by": "agent",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-25",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A ticket that names itself as related fails validation, and the failure names it",
    "The repair pass never writes a relation from a ticket to itself",
    "The repair pass reports a self-edge it finds rather than passing over it",
    "No record on the board is related to itself",
    "Every relation between two different tickets keeps working exactly as before"
  ],
  "code_refs": [
    {
      "path": "scripts/lib/ticket-schema.mjs",
      "symbol": "validateTicket",
      "note": "rejects a relation whose target is the record's own id; checked here rather than in the reconciler so it fires wherever a record is READ, not only where one is written"
    },
    {
      "path": "scripts/lib/ticket-schema.mjs",
      "symbol": "idsMatch",
      "note": "compares two ids on a normalised key, so the check cannot be walked around by writing the id in a different case or without its leading zero"
    },
    {
      "path": "scripts/migrate-tickets.mjs",
      "symbol": "reconcileRelations",
      "note": "reports a self-edge and skips it instead of looking up its inverse and writing a second one; the CLI now exits non-zero when it finds any"
    },
    {
      "path": "docs/bugs/FEAT-084-response-format-per-project-config-and-injection.md",
      "symbol": null,
      "note": "the one live instance, repaired: the see-also entry pointing at itself was removed from its record and the removal logged"
    },
    {
      "path": "scripts/verify-bug-128.mjs",
      "symbol": null,
      "note": "sweeps the real board, drives the case onto real records, and proves non-vacuity against pre-fix copies of both files"
    }
  ],
  "related": [
    {
      "id": "BUG-127",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
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
    "archived_path": null,
    "sha256": null,
    "original_title": null,
    "migrated_on": null,
    "migrated_by": null,
    "confirmation": "Authored directly in the record format from a clean-room finding against the cutover. There is no legacy original.",
    "dropped": []
  }
}
```

# BUG-128 — A ticket listed itself among its own related tickets

## Diagnosis

Every relation in the set is a claim about two tickets: one supersedes another, blocks another, is a duplicate of another. Pointed at itself each one is either empty — a see-also link to the page you are already on — or a contradiction, since a ticket that blocks itself can never start.

Two things let one through, and they are independent:

**The validation gate never asked.** It checked that a relation's target is a well-formed ticket id and that the relation is one of the seven names. It never checked that the target is a *different* ticket, so `FEAT-084 --see_also--> FEAT-084` was a valid record.

**The repair pass would build one.** Back-edge reconciliation reads each relation, looks up its inverse, and writes the inverse onto the target. Given `A --blocks--> A` the target *is* A, so it writes `A --depends_on--> A` — one defect manufacturing a second, inside the pass whose entire job is to make the graph consistent. It reported nothing, because a self-edge is not dangling: the target exists.

Reconciliation is also the wrong place to *fix* this, which is why the guard there only reports. The ticket it would have to correct is the ticket that is wrong, so there is no correct edge to write. It is named and left for a person, exactly as a dangling edge is named rather than invented away.

The comparison uses a normalised key rather than string equality. A check that only catches `FEAT-084 === FEAT-084` is walked around by writing `feat-084` or `FEAT-84`, which are the same ticket to every reader here.

## Evidence

**The live instance, and where it came from.** `FEAT-084`'s record carried `{"id":"FEAT-084","relation":"see_also"}`. It is present in the pre-reconciliation staging backup, so the migration authored it and `--reconcile` did not — the two halves of this ticket are one defect each, not one defect twice.

Reproduced against the real board before the fix: `npm run board:check` said nothing about it. With the check in place it names it:

```
FAIL  FEAT-084-…md: "related[1]" points at this ticket itself (FEAT-084 "see_also") — a relation describes two tickets
```

**A sweep, not an assumption.** All 197 records on the board — live and archived — were read and every one of their 768 edges compared. Exactly one self-edge existed. It is repaired; the sweep now returns none and runs on every suite invocation, so a second one cannot appear quietly.

**The manufacture, on the real corpus.** Adding `A --blocks--> A` to a real record in the promoted 194-record set and running the pre-fix reconciler over it produces `{"id":"ARCH-001","relation":"depends_on"}` on that same record, with nothing reported. The fixed pass leaves the injected edge alone, reports it, and adds none of its own.

**One thing worth stating plainly:** the corpus exactly as it was promoted would now be REFUSED, both by `--reconcile` and by the promotion gate, because of this one edge. That is the gate working, not a new problem — but it means the cutover as executed is not reproducible byte-for-byte through the current gate without repairing the record first.

## Implementation notes

The check lives in `validateTicket` rather than in the reconciler, so it fires wherever a record is read — the board check, the promotion gate, the migration's own grading — and not only in the one pass that writes relations. That is also why the live instance was caught the moment the check existed: it was already being read.

The reconciler's guard is deliberately a *report*, not a repair, and the CLI now exits non-zero when it finds one. A pass that reported a fault and then exited 0 is how this survived the cutover.

## Verification plan

`npm run verify:bug-128` — 43 assertions.

Three deliberate choices about what it reads:

- **the real board** for the sweep, asserted as an invariant (no record is related to itself) rather than as a count that legitimate use would change;
- **the real corpus pinned at the cutover commit** for the reconciler, because the live records keep being appended to and a suite that goes red when someone uses the product correctly is a suite everyone learns to ignore;
- **a record discovered at runtime**, not named, for the cases that need a ticket with relations — naming one couples the suite to a ticket that may be re-filed.

Non-vacuity is proved against synthesized pre-fix copies of both changed files, with the guard blocks cut back out. Each is gated on a CONTROL that must pass first: the pre-fix validator has to load, accept a real record and still reject a malformed id; the pre-fix reconciler has to load and reconcile the real 194-record corpus normally. Without that control, a red is indistinguishable from a copied module that never resolved its imports — a suite failing that way looks exactly like a suite catching a regression.

## Risks

The check is a new reason for an existing record to fail validation, and one record on the board failed it. That was the point, and it is repaired. The normalised comparison is deliberately lenient about how an id is spelled, so a ticket whose id is genuinely a prefix of another's is worth a thought — `FEAT-084` and `FEAT-0840` are asserted to be different, and are.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-20 — worker (dispatched)

- **Understood:** arrived as a reported finding from an independent clean-room pass, so both halves were reproduced against the real board first. Both held: the live self-edge on FEAT-084, and the manufacture of `depends_on` from `blocks`.
- **Changed:** `scripts/lib/ticket-schema.mjs` (new `idsMatch`; `validateTicket` rejects a self-edge), `scripts/migrate-tickets.mjs` (`reconcileRelations` reports and skips; `--reconcile` exits non-zero), `docs/bugs/FEAT-084-…md` (the one edge removed, with an appended log entry), `scripts/verify-bug-128.mjs` (new), `package.json`.
- **Verified:**
  - must-FAIL first, on the real artifact: `npm run board:check` named FEAT-084 with the new check in place and the record unrepaired.
  - `node scripts/verify-bug-128.mjs` — **43/43**, including the 768-edge sweep of all 197 records and the pre-fix must-FAIL group with its two controls.
  - Anti-regression: `npm run verify:migrate-tickets` 53/53, `npm run verify:feat-094` 42/42, `npm run verify:bug-127` 38/38, `npm run verify:bug-127-render` 9/9, `npm run verify:ticket-schema` 62 passed / 1 failed — that one failure was confirmed pre-existing by stashing the change and re-running.
- **regressed-from:** BUG-127, same session. The new check made the promotion gate refuse the pinned cutover corpus, which reddened `verify:bug-127` — correctly, since that corpus contains this defect. That suite now drops self-edges from the records it stages, with the reason recorded in it. Named rather than quietly fixed.
- **Still open / handoff:** the two ends of the BUG-127 ↔ BUG-128 pair are written on both tickets. The pair with BUG-126 is not: BUG-127 is its sibling, but BUG-126 is held by another lane and a fix lane must not edit another ticket's file, so that back-edge is owed.
- **Verified-by:** not yet — an independent clean-room pass is warranted. This touches the validator every reader of a record goes through, and the finding it closes was itself found by a clean-room pass.
- **Symptom of a deeper design flaw?** Not answered here — the ticket is not closed. The suspicion to hand forward: the relation set has never had a stated invariant, so each defect in it is found one at a time. Irreflexive is one. Symmetric under the inverse map is another, and it is enforced only inside a migration pass that no longer runs on the live board — nothing checks it for a ticket authored today. If a third relation defect appears, the ARCH question is who owns the graph's invariants, not another guard.

### 2026-08-25 — worker
- **bookkeeping-sweep:** 2026-08-25 bookkeeping sweep (authorised by the user). Rounds are spent by harm class now; this is a validator guard on one relation invariant, so it gets a re-check rather than a clean-room round. Re-ran `node scripts/verify-bug-128.mjs` at HEAD b6c0151 — 43 passed / 0 failed, exit 0 read directly, including the sweep of every edge on the live board and the pre-fix must-FAIL group with its two controls. Committed at f067257. Closing as verified. Symptom of a deeper design flaw? Handed forward as written: the relation set still has no stated invariant, and irreflexivity is the one this ticket added; a third relation defect makes it an ARCH question about who owns the graph.
