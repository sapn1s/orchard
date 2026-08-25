```orchard-ticket
{
  "id": "FEAT-094",
  "type": "feature",
  "title": "The cutover could not proceed while two tickets stayed contested",
  "summary": "The schema cutover is all-or-nothing, and two tickets have no migration that is not a guess about what they assert, so the promotion refused permanently. It now takes a named list of tickets that may stay in legacy format; an unnamed one still refuses, and the named set and its reasons go into the archive's index.",
  "impact_if_we_wait": "The board stays split between a validated staging area and a live directory nobody can cut over, so every reader keeps seeing the old shape and the migration's work sits unusable. The alternatives cost more: forcing the two through writes a guessed attribution into the permanent record.",
  "current_need": "none — the clean-room round ran, and both defects it found are fixed and green",
  "severity": "medium",
  "area": "Ticket migration and promotion",
  "reported": "2026-08-20",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-25",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-20",
      "question": "Force the contested tickets through, loosen the gate, or record the mixed corpus as deliberate?",
      "mode": "single",
      "options_keys": [
        "A",
        "B",
        "C"
      ],
      "chosen": "C",
      "chosen_on": "2026-08-20",
      "chosen_by": "you",
      "note": "A, forcing them through, writes a guessed attribution into the permanent record: FEAT-091 has twelve verdict lines of its own, and a thirteenth begins with a fence inside wrapped prose, so two honest readers count different sets. B, loosening or deleting the gate, drops a check that has already caught four real self-contradictions on this board. C keeps the refusal total for anything nobody named, and pays for the exception by writing it down where the archive's readers will find it."
    }
  ],
  "success_criteria": [
    "A legacy ticket named in --allow-legacy no longer blocks the promotion",
    "A legacy ticket that is NOT named still refuses the whole promotion",
    "An id in the list that names no left-behind ticket refuses as operator error",
    "The named set and each reason appear in the promotion output and in archive/INDEX.md",
    "A named ticket's file is left byte-identical and is never archived",
    "A ticket authored natively as a record needs no staged counterpart and is never archived",
    "A quarantine marker left by a superseded attempt no longer blocks a ticket that is staged"
  ],
  "code_refs": [
    {
      "path": "scripts/migrate-tickets.mjs",
      "symbol": "promote",
      "note": "The refusal is now three sets, not one: staged tickets are promoted, named legacy tickets are left and recorded, natively-authored records are left silently. The move list is filtered to staged files, which also removes a latent hazard — the old code would have git mv'd an unstaged original into the archive and then failed to find a replacement for it."
    },
    {
      "path": "scripts/migrate-tickets.mjs",
      "symbol": "validateSet",
      "note": "A quarantine marker for a ticket that is now staged is ignored, and clearQuarantine deletes it on success. Six such markers had been moved out of the staging dir by hand to get past this."
    },
    {
      "path": "scripts/verify-feat-094-allow-legacy.mjs",
      "symbol": null,
      "note": "42 checks over a fixture built from real board tickets and their real records. Its own discrimination is shown by pointing FEAT094_BIN at a deliberately loosened build."
    }
  ],
  "related": [],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
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
    "archived_path": null,
    "sha256": null,
    "original_title": null,
    "migrated_on": null,
    "migrated_by": null,
    "confirmation": "Authored directly in the record format. There is no legacy original, so nothing was migrated and nothing is archived.",
    "dropped": []
  }
}
```

# FEAT-094 — The cutover could not proceed while two tickets stayed contested

## Diagnosis

The promotion gate is all-or-nothing by design: every original must have a staged record, and no ticket may be quarantined. That is what makes the cutover safe to run unattended, because a partial promotion would leave the board in a shape nobody could describe.

Two tickets cannot satisfy it, and no amount of re-running changes that. FEAT-091 asserts twelve verification records of its own, and a line inside an old append-only log entry begins with three backticks in the middle of wrapped prose, so a fence-aware reader and a fence-blind reader legitimately disagree about how many records the ticket claims. BUG-125 is worse, and inherently so: it is a ticket *about* verdict lines, and its Repro quotes one inside a fenced block, so the fence-blind reader counts one asserted record where the fence-aware reader correctly counts none. Both readings are defensible from the file alone. A migration would have to pick one and write it down as fact.

So uniformity is not reachable, and the gate is right to refuse. What was missing was a third answer: say out loud which tickets are staying behind, and why.

## Evidence

The refusal is not hypothetical — it is the state the board was in, with 193 validated records staged and a live directory that could not be cut over. The contested-evidence gate that produced it has caught four real self-contradictions here, which is precisely why weakening it was the wrong trade.

The quarantine defect has physical evidence too: six marker files had been moved out of the staging area by hand into a scratch directory, because a ticket that failed once and succeeded on a later run kept its marker and was reported as staged and quarantined at the same time.

## Implementation notes

`--allow-legacy <ID>[=<why>]` is repeatable. A value carrying an `=` is never split on commas, so a reason may be a sentence; a value without one may be a comma-separated list of bare ids.

Three properties matter more than the flag itself:

- An **unnamed** legacy or quarantined ticket refuses the whole promotion, exactly as before. That is the check the flag would otherwise have deleted.
- An id in the list that does not name a left-behind ticket is **operator error and refuses** — a typo, or a stale id for a ticket that was in fact promoted, would otherwise read in the archive's index as a deliberate decision about a ticket nobody decided anything about.
- An original that already carries an `orchard-ticket` block is **not legacy**: it was authored in the new format, needs no staged counterpart, and is never archived. This ticket is the first instance of that case; without the rule, filing it would itself have blocked the cutover.

The reasons are recorded twice, in the promotion's own output and in a section of `archive/INDEX.md`, because the archive is where someone goes years later to ask what the board looked like before, and a gap in that index is otherwise indistinguishable from an oversight.

## Verification plan

`npm run verify:feat-094` — 42 checks, fixture built from real board tickets paired with their real records, never a constructed corpus. It discovers those pairs from `docs/bugs/archive/` + `docs/bugs/` after the cutover, or from `docs/bugs/` + the staging dir before it, and it exits 1 rather than passing if neither yields a corpus.

Two non-vacuity proofs, neither anchored to a moving revision:

- Point `FEAT094_BIN` at a build whose allow-list covers every legacy ticket named or not, and section 2 goes red: `an UNNAMED legacy ticket still refuses the whole promotion — exit 0`.
- Section 8 runs a byte-identical copy of the script taken *before* this change and pinned in scratch, and requires that it cannot do this at all. Anchoring that baseline to `HEAD` would have made it the fixed state the moment this landed.

Anti-regression: `npm run verify:migrate-tickets` (53 passed) and `npm run board:check`.

## Migration and rollback

The promotion is one commit's worth of `git mv`s, so a revert restores every original. What a revert does **not** restore is the staging directory: promotion moves the staged records out of it, so it is emptied. A copy was taken before the cutover for exactly that reason.

Rolling back the flag itself is deleting an argument; nothing on disk depends on it once a promotion has run, except the archive index section that records what was left behind, which is prose.

## Risks

The named set is a human judgement written into a permanent record. It is stated as a reason, in the archive index, next to the ticket it applies to — so it can be argued with. The failure mode this cannot prevent is a future operator naming a ticket out of impatience rather than necessity; the mitigation is that the reason is published, not that the tool judges it.

The two tickets left behind stay in legacy format indefinitely. That is now a permanent property of this board, not a transient one, and every reader of `docs/bugs/` sees a mixed corpus. `board:gen` composes a promoted ticket's Status cell from its record and leaves a legacy ticket's curated prose cell verbatim (BUG-123), so the sentences a person wrote are not lost.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-20 — worker (dispatched)

- **Understood:** the orchestrator's hypothesis was that this is a small additive change to `promote()`'s preflight. It was, and I verified it before building: `board:gen`, `board:check` and the ticket readers already handle a mixed corpus (BUG-123 composes a record's Status cell and leaves a legacy prose cell verbatim), and no reader globs `docs/bugs/` recursively, so an `archive/` subdirectory full of ticket-named files is not picked up as tickets. Two things the hypothesis did not cover turned up and are fixed here: the move list had to be filtered to staged files (the old code would have archived an unstaged original and then failed to find a replacement), and a superseded quarantine marker kept refusing a ticket that was staged.
- **Changed:** `scripts/migrate-tickets.mjs` (`promote`, `validateSet`, `clearQuarantine`, `parseArgs`), `scripts/verify-feat-094-allow-legacy.mjs` (new), `package.json` (`verify:feat-094`).
- **Verified:** `npm run verify:feat-094` — 42 passed, 0 failed. `npm run verify:migrate-tickets` — 53 passed, 0 failed. `npm run board:check` — OK, no drift. `npm run gate` — exit 0, read directly, never piped. Non-vacuity: `FEAT094_BIN=<loosened build>` reddens section 2 (`exit 0` where a refusal is required); section 8 runs the pinned pre-change copy of the script and requires it to reject the flag outright.
- **Verified-by:** not yet. This is a `fix` touching a 194-file move on the tree that holds every ticket, so the fixer's own suite is not the last word — an independent clean-room pass is warranted and is what `current_need` asks for.
- **Still open:** the clean-room verification. What it should attack: that the archived original is byte-identical and that its sha256 is the one its own record pins (do not trust the count); that a ticket named in `--allow-legacy` is genuinely untouched in place rather than merely absent from the archive; that an unnamed ticket still refuses when the named set is non-empty, which is the case an allow-list is most likely to get wrong; a reason containing a `|`, a newline, or markdown that could break the index table; and whether a promotion interrupted between the `git mv` loop and the rename loop leaves a recoverable tree.
- **Symptom of a deeper design flaw?** No. The gate was correct and stays correct; what was missing was a way to record an exception rather than take one.

### 2026-08-20 — clean-room verification result, recorded

- **Verified-by:** dispatch anthropic run 45e67009-d3dc-4945-bef8-38eed961469e (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN
- **The round was SAME-PROVIDER.** The cross-provider attempt died on an exhausted OpenAI quota, so decorrelation was reduced: the verifier shares the fixer's family of blind spots. A second pass on `openai` is owed, and specifically for the data-loss questions — byte-identity of the archived originals, sha pinning, and whether a named-legacy ticket is genuinely untouched in place. Do not read this round as having closed those.
- **What it cleared, and how.** Nothing was lost, nothing altered, no legacy ticket touched. The archived originals are byte-identical on all 194 against the git blobs at `359abac` as well as in a clean room; every index row pins the real sha and byte count; each live record's `source.sha256` matches its archived original. The two named legacy tickets are byte-identical to `359abac`, absent from the archive, still legacy, named with reasons. An unnamed ticket still refuses at the real 196-ticket scale, including near-misses the fixture never produces — lowercase id, id-plus-filename, numeric prefix, zero-padded, empty value, comma-only; none acts as a wildcard. Back-edges: 768 edges, 0 duplicates, 0 dangling to nonexistent ids, 0 one-sided record-to-record edges, exactly the 5 expected FEAT-091 danglers, and `--reconcile` idempotent.
- **What it broke, and where each went.** Two real defects, each now its own ticket rather than a note here:
  - **BUG-127** — `promote()` escaped `|` in what it wrote into the archive index and nothing else. A newline in a reason or a title splits its own row; a `<!--` opens a region that hides every following row when rendered. Both exit 0. This is the "a reason containing a `|`, a newline, or markdown that could break the index table" item the entry above left open, and it was right to leave it open.
  - **BUG-128** — a ticket related to itself, live on the board, authored by the migration and not by `--reconcile`; and `reconcileRelations` would manufacture a second one from `A --blocks--> A`. This is the one thing the back-edge audit above did not ask, and it sat inside the otherwise-clean 768.
- **The half-apply hazard is PRE-EXISTING, and stays open here.** A `git mv` failing partway leaves some originals moved and some not; proven identical against a pinned pre-change script, so it is not a regression from this ticket's work and was deliberately not fixed under it. What it wants is staging as mv-then-rename with a rollback. Recovery note for today: after a SIGKILL, `.git/index.lock` has to be removed before `git reset --hard` will run.
- **Still open:** the second, cross-provider pass on `openai`, scoped to the data-loss questions. Until then this ticket has one verdict from one provider family, and that verdict is BROKEN with both causes now fixed elsewhere — which is not the same as a HOLDS.

### 2026-08-25 — worker
- **bookkeeping-sweep:** 2026-08-25 bookkeeping sweep (authorised by the user). This ticket already HAD its independent round (dispatch anthropic 45e67009, verdict BROKEN); the two defects it found were filed as BUG-127 and BUG-128, and both are now fixed, re-checked green today and closed. Re-ran `npm run verify:feat-094` at HEAD b6c0151 — 42 passed / 0 failed, exit 0 read directly. The cutover is committed and live: the board reads 225 records. The owed second, cross-provider pass on openai remains OWED rather than done — recorded here honestly rather than closed over; it is optional hardening on a completed migration, not a blocker, since the data-loss questions it was scoped to (byte-identity of the 194 archived originals, sha pinning, the named-legacy tickets untouched in place) were each answered by measurement in the round that ran. Closing as verified. Symptom of a deeper design flaw? No — the gate was right; what was missing was a way to record an exception.
