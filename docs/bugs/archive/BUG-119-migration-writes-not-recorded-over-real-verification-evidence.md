# BUG-119 — Migrated tickets say verification is "not recorded" on tickets whose own status says VERIFIED

- **Status:** FIXED — UNBLOCKED 2026-08-20. [[ARCH-009]] was decided (option C,
  gated by A) and built: `verification_state` no longer exists, so the field
  half of this bug is dissolved rather than fixed — there is nothing left to
  write "not_recorded" into. The PROSE half is what this ticket now owns and it
  is unchanged and still green: a finished ticket's own executed evidence is
  extracted from the whole file, log included, and put in front of the model, so
  the migrated `current_need` says what ran instead of "no further action is
  recorded". Independent verification of ARCH-009's build is outstanding, and a
  model-backed migration run is still the highest-value untaken item.
- **Verified-by:** dispatch openai run 01a01bb8-e94a-7db3-9cf4-9af31079fa6e (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN
- **Severity:** high
- **Area:** ticket migration (schema pipeline)
- **Reported:** 2026-08-19 by user (via a blind-graded prose review, n=4)
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED.
- **Dispatch class:** `fix` (cause and blast radius both nameable; the charter's
  hypothesis was tested first and held — see the 2026-08-19 log entry).

## Symptom

A migrated ticket reads:

```json
"work_state": "verified",
"verification_state": "not_recorded",
"current_need": "No further action is currently recorded; the fix is marked verified."
```

(`BUG-085`, from the migration's staged output under the scratch root.) The ticket's own
status line says `VERIFIED`, and its activity log records executed suites with pass
tallies. The migrated record says nothing was recorded, and the prose repeats the
denial. The user read this as the pipeline evading rather than reporting.

A writing contract was tested against the same output by another lane and made no
measurable difference (2–2 blind split), because the placeholder is not a writing
choice: the prompt ORDERS it.

## Repro

1. `node scripts/migrate-tickets.mjs --ids BUG-085` (or read the staged copy above).
2. The record carries `work_state: verified` with `verification_state: not_recorded`.
3. `scripts/migrate-tickets.mjs` `buildPrompt` hard-orders it:
   `verification_state must be "not_recorded" or "not_required" (there are NO verification records)`.

## Expected

A ticket whose own status line claims VERIFIED must not migrate to
`verification_state: "not_recorded"`. The migration transcribes a ticket; it does not
re-adjudicate it, so the status line the board already trusts for `work_state` must
also decide `verification_state`.

## Diagnosis

Three separate defects, one visible symptom.

**1. The state is derived from the wrong signal.** `extractGivens` sets
`verification_state` from `verificationStateFrom(records)`, where `records` are
`Verified-by:` lines only — independent clean-room dispatch verdicts. Only 21 files
on the board carry one. `classifyLegacyStatus` ALREADY returns a `verificationState`
per status token (`VERIFIED` → `holds`, `FIXED` → `pending`, `NOT-A-BUG` →
`not_required`), the pipeline already consumes that same call for `work_state`, and
it throws the verification half away. `ticket-schema.mjs`'s own header docstring
states the intended mapping — "`FIXED` is `work_state: done` + `verification_state:
pending`; `VERIFIED` is `work_state: verified` + `verification_state: holds`" — so
the validator rule at `validateTicket` contradicts the file it lives in.

**2. `validateTicket` then makes the correct answer unrepresentable.** "`verification`
is empty so `verification_state` must be `not_recorded` or `not_required`" rejects
`holds` for all 121 real tickets that say VERIFIED without an independent verdict.
The prompt's hard order is downstream of that rule, not the cause.

**3. The MUST APPEAR VERBATIM block is ~4x larger than provenance requires**, and
its per-token `date `/`ticket `/`run id ` labels are copied into the prose as
seams ("on date 2026-08-14", "ticket ARCH-006 was reported on date 2026-08-18").
653 of the 887 head-provenance tokens across the corpus already sit inside the
activity log, which is copied byte-for-byte and asserted as such by
`provenanceCheck`. Demanding the model re-place them buys nothing and costs a seam
each.

## Survey — how verification evidence is actually expressed (185 tickets, ARCH-005 excluded)

| Signal | tickets | of the 152 finished-with-no-record |
|---|---|---|
| `Verified-by:` dispatch line (what the extractor reads today) | 16 | 0 |
| status line classifies to `holds` (VERIFIED) | 128 | 121 |
| status line classifies to `pending` (FIXED/RE-FIXED) | 10 | 7 |
| names a `verify:<suite>` | 172 | 144 |
| a matched pass tally (`n/n`) | 150 | 127 |
| `npm run verify:…` | 83 | 70 |
| a pre-fix FAIL proof | 43 | 41 |
| `typecheck clean/PASS` | 38 | 33 |
| a `## Verification` section | 130 | 117 |
| bare hex run id | 20 | 4 |
| `VERDICT: HOLDS/BROKEN` | 18 | 2 |

Only **8** of the 152 have no verification evidence of any kind: `ARCH-002`,
`DEPLOY-003`, `FEAT-005`, `FEAT-017`, `FEAT-026`, `FEAT-028`, `FEAT-036`,
`FEAT-046` — every one a superseded, won't-do, audit-only or decision-only
closure, where `not_recorded` is the correct record.

## The approach, and the one I rejected

The corpus expresses **two different kinds** of evidence, and this board's whole
method rests on telling them apart: an independent clean-room verdict
(`Verified-by:`, 16 tickets) versus the fixer's own executed suite (`33/33`, 144
tickets). `README.md` rule 5 and `FEAT-061` exist to stop the second being
presented as the first.

**Rejected — widen `extractVerificationRecords` to emit `verification[]` entries
for suite runs.** It would take zero-record tickets from 169 to ~25 and satisfy the
literal ask, but `verification[]` is typed `{provider, run_id, verdict}`: a suite
run has neither a provider nor a run id, so both would have to be invented, and
`verification: []` would stop meaning "nobody independently verified this" — the
one signal the board's verification enforcement is built on.

**Built instead:** the status line decides `verification_state` (it already decides
`work_state`), and the extracted self-evidence is given to the model as GIVENS so
it writes what the proof WAS instead of denying there was any. `verification[]`
keeps its exact meaning and stays empty on 169 tickets, which is true.

## Context pack

- Files/functions in play: `scripts/migrate-tickets.mjs`
  (`extractGivens`, `buildPrompt`, `grade`, `compose`), `scripts/lib/ticket-schema.mjs`
  (`validateTicket`, `classifyLegacyStatus`), `scripts/lib/ticket-writing.mjs`
  (`WORKED_EXAMPLES[1].current_need`).
- Related tickets: [[ARCH-004]] (the enums this migration targets), [[FEAT-061]] and
  [[BUG-071]] (why independent verdicts must stay distinct from self-runs).
- Repro test: `npm run verify:migrate-tickets`, plus the new
  `scripts/verify-bug-119-verification-evidence.mjs`.
- Known dependencies / blockers: `public/app.js` and the ticket view are held by
  another lane, so no new rendered schema key may be added in this lane.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-19 — fix lane (dispatch class `fix`)

- **Understood / hypothesis test.** The charter's hypothesis was that verification
  evidence IS present in forms the extractor does not recognise. Measured before
  building anything, over the real 185 tickets (ARCH-005 excluded as a protected
  holdout): the extractor finds records on 16, misses 152 finished tickets, and
  144 of those 152 name an executed suite. The hypothesis holds. Table above.
- **Changed:**
  - `scripts/lib/ticket-schema.mjs` — `validateTicket`'s empty-`verification[]`
    rule re-cut against `work_state`. `holds` needs `verified`; `pending` needs
    `in_verification`/`verified`/`done`; `broken` still needs a real record,
    because "broken" is a verdict and only a verification that ran produces one.
  - `scripts/migrate-tickets.mjs` — `deriveVerificationState` (status line and
    verdicts, precedence documented in place), `extractSelfEvidence` +
    `summariseSelfEvidence` (suites, tallies, pre-fix FAIL proofs, standing
    checks, harness run ids, clean-room mentions), `headProvenance` now takes the
    log and drops tokens the verbatim copy already carries, `buildPrompt` states
    the decided state and groups MUST APPEAR by kind, `grade` compares against
    the derived value instead of firing only when a verdict exists.
  - `scripts/lib/ticket-writing.mjs` — worked example 2's `current_need` and its
    caption.
  - `scripts/verify-bug-119-verification-evidence.mjs` — new, `verify:bug-119`.
  - `scripts/verify-migrate-tickets.mjs`, `scripts/verify-ticket-schema.mjs` —
    followed the two changed rules; both kept their must-FAIL cases and gained
    one each.

- **Measured, before → after** (185 real tickets, holdout excluded):
  - finished tickets forced to write `not_recorded`: **152 → 24**. The 24 are
    tickets whose own status line says `DONE`, never `VERIFIED`; 8 of those have
    no verification evidence at all and 16 log a suite but never claimed
    verification. `not_recorded` is the honest record for a ticket that never
    claimed proof — the prose now says what ran instead of denying it did.
  - state distribution: `holds` 130, `pending` 7, `broken` 7, `not_recorded` 42
    (42 = 24 finished + 18 genuinely open/in-progress).
  - tickets with zero INDEPENDENT verification records: **170 → 170, unchanged
    and deliberately so.** See "The approach, and the one I rejected" above.
  - MUST APPEAR tokens the model must carry: **905 → 250** (−72%); 73 of 186
    tickets now need none.
  - self-evidence recovered on **153 of 161** finished tickets.

- **Verified (the FIXER's own run — necessary, never sufficient):**
  - `node scripts/verify-bug-119-verification-evidence.mjs` — **48/48**, run
    against the real corpus with the qualifying set DISCOVERED at runtime (100
    tickets qualify today) and a loud abort if none does.
  - Must-FAIL proofs, all anchored to pre-fix behaviour SYNTHESIZED in the suite
    rather than to `HEAD` (a HEAD baseline becomes the fixed state on commit):
    the old rule wrote `not_recorded` on **94 of the 100** qualifying tickets;
    the old prompt ordered it on the same 94; the old `grade()` was **inert** on
    those same 94 because it only fired when a verdict existed.
  - Truncation: the real BUG-098 cut at 11 points — never throws, never produces
    a state its own record contradicts, derives the claimed state as soon as the
    cut passes the status line, and claims nothing when cut before it.
  - Anti-regressions: `verify:migrate-tickets` 51/51, `verify:ticket-schema`
    53/53, `verify:board-tool` 34/34, `verify:ticket-writing-contract` all pass,
    `verify:ticket-view-redesign` 184/184, `npm run gate` PASS (exit 0, unpiped).
  - `verify:decisions` fails (17/18, harness timeout waiting for
    `session-closed`). Confirmed PRE-EXISTING by stashing all three source
    changes and re-running: identical failure, exit 1. Not caused here.

- **A defect this work introduced and the anti-regression run caught.** The
  first version of `headProvenance` used one case-folded coverage test for all
  four token kinds. `provenanceCheck` folds case only for run ids and shas, so
  `FEAT-082` — which cites `FEAT-067` in its head and carries only
  `verify:feat-067-rail-summary` in its log — had a genuine requirement dropped
  and would have failed the gate. `verify:migrate-tickets` failed on it; the
  predicates are now mirrored per kind and both suites assert the soundness
  property rather than an approximation of it. Recorded because my own new suite
  did NOT catch this: it had restated my own assumption rather than the
  downstream check's behaviour.

- **A second defect found while building, in the precedence.** Taking "the
  newest verdict" as the state reported the verification loop's worst moment as
  the ticket's state: `BUG-109`, `FEAT-061` and `FEAT-062` are all VERIFIED and
  closed, and all came out `broken` or `pending`, because verification here is
  iterative and a ticket's verdict list is mostly BROKEN by construction
  (`ARCH-003` carries nine BROKEN then one HOLDS). The status line now outranks
  the verdicts; all 16 record-carrying tickets derive coherently.

- **Still open / handoff.**
  - **This must not be graded by me.** I wrote the fix, the fixture and the
    invariants, so a blind spot that shaped the suite survives all 48 checks.
    An independent clean-room pass (`scripts/independent-verify.mjs`) is
    warranted: this is regression-prone, on the critical path, and touches the
    validator that gates every migrated ticket. Suggested attack: the
    `deriveVerificationState` precedence table against a ticket whose status
    line and verdicts disagree in a way the corpus does not currently contain,
    and whether `headProvenance`'s subtraction stays sound if the log copy ever
    becomes non-verbatim.
  - `migrate-tickets.mjs` still carries its OWN `WORKED_EXAMPLE` constant and
    does not import `ticket-writing.mjs`'s `WORKED_EXAMPLES`, although that
    module's docstring says it does. Two demonstrations of register, drifting
    silently. Not touched here — another lane was testing the writing contract
    against this pipeline — but it is why fixing example 2 alone does not
    change the migration's output. Worth its own ticket.
  - `severity: "not_recorded"` has the same shape as the bug fixed here
    (`compose` falls back to it whenever the ticket declares no Severity) and
    was out of scope. Not investigated.

- **Symptom of a deeper design flaw?** Yes, arguably — the same shape as
  [[ARCH-004]]: a value that exists in prose, is classified correctly by one
  code path, and is then re-derived from scratch (or forced to a placeholder) by
  another. Not filed as a new ARCH ticket because ARCH-004 already contains it;
  flagged here so the closer can decide.

### 2026-08-19 — fix lane, round 2 (acting on the clean-room BROKEN verdict)

- **Verdict recorded.** `dispatch openai run 01a01bb8-e94a-7db3-9cf4-9af31079fa6e`
  — **BROKEN, residual class only.** Both stop-everything classes came back clean
  and are not re-litigated here: no false "verified" (the status regexes are
  `^`-anchored, so `ARCH-002`'s incidental `BUG-044 (VERIFIED)` cannot win, and
  the two ambiguous statuses resolve conservatively), and no dilution of the
  independent signal.

- **The residual, fixed.** `not_recorded` was still written over **24 finished
  tickets whose evidence the pipeline had already extracted and was holding in
  `self_evidence`** — `ARCH-001` with ten named passing suites and `191/191`,
  `FEAT-028` whose status line literally reads `DONE — verified`. Two causes:
  1. **A rule I got wrong in round 1.** I wrote that self-evidence
     "deliberately does NOT move this value". Too blunt. The correct statement
     is narrower and is now in the code: self-evidence may never produce
     `holds`, because a fixer's own suite is not an independent verdict; it MAY
     lift `not_recorded` to `pending`, which is strictly weaker and means the
     true thing — proven by whoever fixed it, independent check outstanding.
  2. **An extraction gap.** `FEAT-028` records five hand-run checks marked
     `(PASS)` and "all verification PASSED", with no suite name and no tally at
     all. `extractSelfEvidence` now counts explicit PASS markers, and
     `hasSelfEvidence` requires **two** so one incidental "PASS" in prose cannot
     stand in for a record.

  **24 → 7.** The remaining 7 are `ARCH-002`, `DEPLOY-003`, `FEAT-005`,
  `FEAT-017`, `FEAT-026`, `FEAT-036`, `FEAT-046` — every one a superseded,
  won't-do, closed-without-build or audit-only closure holding no executed
  evidence of any kind. That is the honest floor, not a remaining defect.

- **Why `pending` and not a new enum value.** The verdict invited a sixth state
  meaning "self-verified, nobody independent checked". It is more precise and it
  is the better answer if the board ever needs to separate "closed with
  self-evidence" from "closed awaiting a verifier" — **recorded here as a
  proposal, not decided silently.** Not taken now because (a) `pending` already
  carries that meaning on this board: `classifyLegacyStatus` maps `FIXED` —
  fixed, self-tested, unverified — to `pending`, and that predates this ticket;
  and (b) a sixth value renders as a **missing label** until
  `VERIFICATION_LABEL` in `public/lib/ticket-record.js` learns it, and that file
  is held by another lane. Shipping a state that renders as nothing is worse
  than reusing one that is already true. The new value also makes the state
  agree with `board:check`'s existing NO INDEPENDENT VERIFICATION warning on
  exactly these tickets, instead of contradicting it.

- **Gap 1 closed — precedence ATTACKED, not just observed.** The verdict was
  right that "today's corpus has no counterexample" is not "the rule is right".
  Section 10 of the suite builds the shapes on real prose (only the status line
  and verdict sequence constructed, and labelled synthetic):
  - **A reopened ticket produced a FALSE VERIFIED in round 1.** Verdict HOLDS,
    then work resumes and the status line returns to OPEN: round 1 reported
    `holds` for code that has since changed. This is the stop-everything class
    and round 1 had it. Fixed: a `holds` verdict on an **unfinished** ticket now
    degrades to `pending` — it may report that a verdict exists, never that it
    holds.
  - **A QUOTED `Verified-by:` line** (a worked example or pasted excerpt) is
    extracted as a genuine record — `extractVerificationRecords` cannot tell
    quotation from assertion, and `provenance-check.mjs` mirrors that expression
    deliberately, so tightening the extractor would break "two readers, one
    contract" and could drop real verdicts. Guarded at the derivation instead,
    which closes the same route at no cost. Driven through the real extractor on
    real prose, not a stub. **Documented limit:** the record is still extracted;
    only the claim is refused.
  - Interleaved verdicts (`broken→holds→broken`, `holds→broken→holds`), a
    `BROKEN` verdict at every work state, and the legitimate finished-plus-holds
    case are all pinned so the guard cannot over-fire.
  - Corpus-wide safety property added: no ticket may claim `holds` unless its
    own status line says so, or it is finished and carries a holds verdict.
  - **False-positive correction, mine:** I first flagged 10 real
    `Verified-by:` lines as sitting inside fenced blocks. They are not — my
    fence scanner desynchronised on this corpus's nested/longer fences (FEAT-091
    is a ticket *about* nested fences). All 10 are genuine records in plain
    prose. No real ticket carries a quoted verdict today; the guard is written
    against a constructed shape and says so.

- **Gap 2 closed — a real model-backed end-to-end run now exists.** Round 1
  exercised only the deterministic paths. Ran the real pipeline
  (`openai/gpt-5.6-sol`) over **5 real tickets** chosen to hit each new path —
  `BUG-085` (the original complaint, VERIFIED→holds), `ARCH-001` and `FEAT-028`
  (upgraded to `pending`), `BUG-080` (pre-fix proof), `FEAT-026` (evidence-free,
  must stay `not_recorded`). ARCH-005 excluded. Output written to scratch, never
  the repo. **5/5 migrated on the first attempt, no retries, no quarantine,
  $0.78, 39s.** `provenance-check` **OK on all five**.
  - **Zero evasion shapes** ("no further action", "not recorded", "is verified
    and live") in any prose field, and **zero template seams** ("on date …",
    "ticket X was reported on date …") — the two things graders flagged.
  - The evidence reaches the prose, which was the half of the fix nothing had
    tested. `BUG-085` — the ticket the user complained about — went from *"No
    further action is currently recorded; the fix is marked verified"* to
    *"Treat the ticket as closed: the pre-fix case failed, the corrected cap and
    collapse behavior passed, and standing checks remained clean."*
    `BUG-080` names its tallies: *"its mirror-image suite passed 17/17, the
    gatekeeper suite passed 31/0, and typechecking was clean."* `FEAT-026`, with
    no evidence, correctly explains why there was no build rather than denying a
    record.

- **Verified (fixer's own run):** `verify:bug-119` **71/71** (was 48/48), with
  six must-FAIL sections, all anchored to round-1 behaviour synthesized in the
  suite rather than to `HEAD`. Two of them are new and both fire: round 1 denied
  evidence on **17** real finished tickets, and round 1 returned `holds` for the
  reopened-ticket shape. Anti-regressions: `verify:migrate-tickets` 51/51,
  `verify:ticket-schema` 53/53, `verify:board-tool` 34/34,
  `verify:ticket-writing-contract` pass, `npm run gate` PASS (exit 0, unpiped).

- **A number I could not reproduce, reported rather than adopted.** The verdict
  gives empty `verification[]` as **175 pre-fix and 175 post-fix** and asks that
  175 replace my 170. Measuring here now I get **171** (187 files, ARCH-005
  excluded) and **172** (188 files, ARCH-005 included) — the corpus has grown by
  two tickets since round 1, which explains my own 170→171 but not 175. Rather
  than quote a figure I cannot reproduce, both are recorded. **The invariant is
  unaffected and both measurements agree on it: the count is identical pre-fix
  and post-fix, necessarily, because `extractVerificationRecords` is not touched
  by this ticket at all.** Worth one line from whoever measured 175 to settle
  which file set it counted.

- **Untouched, deliberately.** `scripts/lib/ticket-writing.mjs` and
  `docs/TICKET-WRITING.md` (guidelines lane) — not edited this round.
  `migrate-tickets.mjs`'s own `WORKED_EXAMPLE` constant is left exactly as it
  was; the duplication is not deepened and collapsing it belongs to the lane
  that owns it.

- **Still open / handoff.** This round is again **self-graded** — I wrote the
  fix, the constructed shapes and the invariants, so a second independent pass
  is warranted before VERIFIED. Suggested attack, in priority order:
  1. the new `pending` upgrade — is there a finished ticket where two PASS
     markers are prose rather than a record, making `pending` an overclaim?
  2. the unfinished-ticket demotion — a ticket legitimately closed as
     `in_verification` with a holds verdict must still read `holds`;
  3. the model-backed run covered 5 tickets, not 187: the prose was verified on
     a sample, and a sample is not the corpus.

### 2026-08-20 — fix lane, round 3 (acting on the second clean-room BROKEN verdict)

- **Verdict recorded.** `dispatch openai run 01a01bc8-0d77-76d0-9a13-7ca98d195380`
  — **BROKEN, two stop-everything defects.** Both reproduced here before any
  change was made; the reproduction script is the first thing in this entry's
  work, not the last.

- **Defect 1 — a VERIFIED status line overran a newer BROKEN verdict.** Round 2
  returned `holds` from the status line *before* consulting the verdicts.
  **This was LIVE on the board, not one verdict away: `BUG-109`** — whose status
  line reads "VERIFIED (fixer's own run) — independent clean-room verify still
  required", whose single independent verdict is BROKEN — derived `holds` under
  round 2. Fixed: `broken` is now checked first, unconditionally. A found defect
  is a fact about the code; a status line is a claim about it, and the fact wins.

- **Defect 2 — a quoted verdict promoted to a real one, under a comment claiming
  otherwise.** Round 2's guard covered unfinished tickets only; every finished
  ticket was exposed, and the comment saying the route was closed was worse than
  the gap. **Fence-stripping the extractor was tried and rejected, with the
  measurement:** a CommonMark-correct scanner drops **eight genuine verdicts**
  from `FEAT-091`, because these documents are themselves ambiguous — FEAT-091
  nests ````-fenced examples inside a ```-fenced block and the longer inner fence
  CLOSES the outer one per spec, so hundreds of lines of ordinary prose fall
  inside a "code block". Narrowing the opener rule (an info string must be a
  language token, not a sentence — one real FEAT-091 prose line is
  ` ``` only, so a tilde-fenced region renders as…`) recovered three of the eight
  and no more. Deleting real verdicts to catch a hypothetical quoted one is the
  wrong trade, and it would break `provenance-check.mjs`'s deliberate mirror.
  **The guard is a property instead, and it is the whole safety story in one
  line: only the ticket's own status line can grant `holds`.** A record can raise
  `broken`, or show that something was checked (`pending`); it can never by
  itself produce a claim of proof, so quotation cannot manufacture one at any
  work state. Measured: **zero real tickets relied on a record-derived `holds`**,
  so the property costs the corpus nothing. The scanner was deleted rather than
  shipped unused.

- **Defect 3 — self-evidence accepted intentions.** `suites.length > 0` bypassed
  the marker threshold entirely, so "Next step: run verify:foo. The command
  verify:foo does not exist yet." counted as proof. Every clause of
  `hasSelfEvidence` is now a SCORE or a RAN-AND-REPORTED signal: a scored suite,
  or a named suite **and** a tally, or a pre-fix FAIL proof, or a reported
  standing check, or ≥2 PASS markers **under a `## Verification` section**. Of
  the verifier's four cases, three reproduced; the fourth ("all verification
  PASSED, but two checks crashed") was already rejected at one marker, and that
  is recorded rather than claimed as a fix.

- **Corpus effect: 7 → 8 finished tickets at `not_recorded`.** `FEAT-020` moved
  in, correctly: it is a SYNTHESIS ticket whose only suite mention is another
  ticket's `verify:container 13/…` while surveying what already exists. **All 8
  were then read by hand** (the verdict's carry-forward: their extractors had
  been audited, their prose never read). All 8 are right, and the read found the
  rule's own justification: `DEPLOY-003` and `FEAT-026` both HAVE a
  `## Verification` section, but each is a **plan in the future tense** — "After
  restart: `curl …` shows a new pid", "typecheck + a size assertion" — with no
  result reported. The section alone would have promoted both; requiring PASS
  markers *in addition* to it is what keeps them honest.

- **Carry-forward gaps closed.**
  - `grade()` had only ever been attacked with ONE wrong value on ONE ticket. It
    is now attacked with **every wrong enum value on a real ticket of every
    derived state present on the board** (4 states x 4 wrong values); all
    rejected.
  - The enum's downstream readers are **driven, not reasoned about**:
    `VERIFICATION_LABEL` is imported and asserted non-empty for every state the
    pipeline can emit AND for every value of `VERIFICATION_STATES`, and
    `board:check` is actually spawned — it still emits **75** NO INDEPENDENT
    VERIFICATION warnings, and the **23** tickets lifted to `pending` all keep an
    empty `verification[]`, so the warning still applies to exactly them. The
    `pending`-reuse argument is now measured rather than asserted.

- **A model-backed run for round 3, and it found a prose defect the state
  checks could not.** Five real tickets covering every changed path — `BUG-109`
  (now `broken`), `FEAT-028` (`pending` via PASS markers), `FEAT-020` (newly
  `not_recorded`), `BUG-085`, `ARCH-001`. 5/5 migrated, 1 retry, provenance OK on
  all five, zero evasions, zero seams. `BUG-109` came out
  `verified` / `broken` with *"treat the broken independent run as the
  controlling verification result"* — defect 1's fix landing end to end.
  **But `FEAT-020`'s prose still overclaimed**, saying two suites "exercised the
  completed synthesis" when the ticket only MENTIONS them. The state was right
  and the prose was not, which is exactly the half of this fix that only a model
  run can test. Fixed in the prompt: named-but-unscored suites are now labelled
  "a mention, not a run; do not write that these were executed", and when the
  pipeline judges there is no evidence at all it says so outright instead of
  presenting the mentions under an "executed evidence" heading. Re-ran
  `FEAT-020` + `BUG-012`: the overclaim is gone ("the synchronized working
  rules, four filed features, and the existing container tier as its completion
  evidence") and `BUG-012` correctly cites "the recorded 11/11 post-change
  tally".

- **Verified (fixer's own run):** `verify:bug-119` **98/98** (was 71/71), now
  with nine must-FAIL sections including two new ones that reproduce round 2's
  exact defects from a synthesized round-2 rule, plus a section that proves
  defect 1 was instantiated on the real board and fails loudly if it ever is not.
  `verify:migrate-tickets` 51/51, `verify:ticket-schema` 53/53,
  `verify:board-tool` 34/34, `verify:ticket-writing-contract` pass.

- **The count dispute is closed** per the coordinator's settlement: 175 at
  `40a8178`, 174 at `f05e247`, both over 187 files with ARCH-005 excluded; my
  171/172 came from a dirty working tree carrying other lanes' uncommitted
  `Verified-by:` additions. Quote the revision with the number. Not re-litigated.

- **Still open / handoff.** Self-graded again. Highest-value attacks for a third
  pass, in order: (1) the "only the status line grants holds" property — find a
  ticket that legitimately needs a record-derived `holds`; (2) `hasSelfEvidence`'s
  named-suite-plus-tally clause, where the tally may belong to something else
  entirely; (3) the model run is 7 tickets across two rounds, not 191.

### 2026-08-20 — fix lane, round 4: the recurrence question, answered

- **Verdict recorded.** `dispatch openai run 01a01bda-0005-7a83-95d0-a7452f81eb92`
  — **BROKEN**, two stop-everything defects plus a defect in this suite. All
  three reproduced here before anything was changed.

- **§N answered, in one line: the design is wrong, not the fixes.** The violated
  invariant is statable and testable — **`verification_state` must be a function
  of the evidence a ticket ASSERTS, taken whole; adding text the ticket does not
  assert, or a record that resolves nothing, must never change it** — and all
  three rounds are different ways of breaking that one sentence. So **no fourth
  guard was written.** Filed as **[[ARCH-009]]** with the invariant, the design
  that produces the class, a per-round table of what each patch left reachable,
  four options priced (including "keep patching"), a migration path and a proof
  bar. Per §N and TEMPLATE-ARCH, no build starts until a human picks.
  The class also has a signature that settles the question: round 3's two guards
  — "`broken` outranks every claim" and "only the status line grants `holds`" —
  are both absolute and now pull in opposite directions, which is why fixing one
  route opened the other. A fourth guard must weaken one of them.

- **Defect 1 is worse than reported: already live at the reviewed revision.** The
  verdict called it "one log line away" using constructed `ARCH-004`. Measured in
  a clean `git worktree` at `c0e4257`, with no uncommitted state: **`FEAT-061`
  (`broken,broken,broken,invalid,invalid,invalid,invalid`) and `FEAT-062`
  (`broken,broken,invalid,broken,invalid`) both carry an outstanding `broken` and
  both derive `holds`.** These are exactly the two tickets round 2 was told were
  "one verdict away" — they are not one verdict away, the trailing INVALIDs
  already suppress the BROKEN. 13 tickets carry records; 10 have an outstanding
  broken; 2 are mis-derived today. Numbers and method are in ARCH-009.

- **Defect 2 reproduced** against real `ARCH-003` at the same revision: appending
  a ` ```markdown ` fence under a "worked example, not a record of this ticket"
  heading, quoting a `VERDICT: BROKEN` line, flips it `holds` → `broken` on
  quoted text alone.

- **Defect 3 fixed — the suite no longer stands on another lane's uncommitted
  line.** Reproduced first: a clean checkout of `c0e4257` scored **96/98**, and
  the two failures were §10c and §10d — the very sections claiming to prove the
  round-2 stop-everything defects were real. (The verdict named them §9b/§10d;
  the actual sections are §10c/§10d, same two assertions.) Their only anchor was
  `BUG-109`'s uncommitted `Verified-by:` line, owned by another lane, so they
  proved nothing at the reviewed revision and would have reddened on a revert.
  Both are now built from a REAL donor's prose with a constructed appended
  verdict, the way the other constructed cases already were. The live board is
  still measured, but PRINTED as context and never asserted on.
  **Proof the anchor is now stable: the suite scores 102/102 in the dirty
  working tree AND 102/102 in a clean checkout of `c0e4257`** — the context line
  correctly reports 1 live instance in one tree and 0 in the other, and neither
  changes the result.

- **The two open defects are now PINNED as characterization tests (§12).** They
  assert the CURRENT, WRONG behaviour, deliberately the opposite shape to
  everything else in the suite: a known defect that no test mentions is one that
  gets forgotten, or silently "fixed" outside the decision ARCH-009 exists to
  make. The suite therefore goes RED the moment either behaviour changes, which
  is exactly when someone should be reading ARCH-009. The section says in place
  that it must be rewritten into ARCH-009's metamorphic properties once an option
  is built, not deleted. A first attempt at this section picked a donor whose
  last real verdict was `holds`, making the case vacuous; the assertion correctly
  refused to pass and the donor is now required to have an outstanding broken —
  recorded because it is the same vacuity trap this suite exists to avoid.

- **Settled and not re-opened:** the FEAT-091 fence rejection (independently
  confirmed: `plain=67, strict=59, language-token=62` over 195 tickets, only
  FEAT-091 affected, mechanism confirmed at line 1664/1669/1671/1672); that no
  real ticket today has a quoted verdict as its newest record; and the count
  dispute.

- **No model-backed run this round, deliberately.** It is the highest-value
  remaining item, but the derivation must change under ARCH-009, so a run now
  would be evidence about code that is going to be replaced — the same reason
  the independent verifier stopped. It runs after the decision.

- **Verified (fixer's own run):** `verify:bug-119` **102/102 in both a dirty and
  a clean tree**. `verify:migrate-tickets` 51/51, `verify:ticket-schema` 53/53,
  `verify:ticket-writing-contract` pass. `verify:board-tool` is **28/34 solely
  because ARCH-009 has no INDEX.md row yet** — confirmed by running it at
  `c0e4257` without that file, where it is 34/34. INDEX is orchestrator-owned;
  the row is requested, not written here.

- **Nothing in `deriveVerificationState` changed this round.** The only
  non-test change is this ticket and ARCH-009.

### 2026-08-20 — unblocked by ARCH-009's decision (C, gated by A)

- **Understood:** the block was "no fourth guard until a human picks an option".
  The user picked **C, gated by A**: stop deriving `verification_state` at all,
  and gate the one migration pass where verdicts must still be read out of prose
  on CONTESTED evidence. So this ticket's field half is not fixed, it is
  *removed* — which is the honest description and worth stating plainly, because
  "BUG-119 fixed" would otherwise imply the enum now holds a correct value.

- **What that does to this ticket's two halves.**
  - *The field half* ("the migration wrote `not_recorded` onto 121 tickets whose
    own status line says VERIFIED") is gone with the field. A migrated ticket
    carries `verification[]` — attributed `{provider, run_id, verdict}` data —
    and nothing else about proof. `outstandingBroken()` in
    `public/lib/ticket-record.js` is the one rule any consumer folds it with.
  - *The prose half* (the model writing "no further action is recorded" about
    work that had a named passing suite) is untouched and is what this ticket
    still owns. `extractSelfEvidence` / `summariseSelfEvidence` / the prompt's
    evidence block all survive ARCH-009 unchanged.

- **The suite was rewritten, not deleted.** `verify:bug-119-verification-evidence`
  now grades both halves and says which is which in its own header. §12 —
  written deliberately as characterization tests asserting the CURRENT, WRONG
  behaviour so it would go red the moment ARCH-009 was decided — is the same two
  defects on the same runtime-discovered real donors, inverted. **118/118.**

- **One gap found while rewriting, reported rather than hidden:**
  `summariseSelfEvidence` has no line for the PASS-MARKER-only shape (FEAT-028:
  five hand-run checks marked `(PASS)` under a `## Verification` heading, no
  suite name, no tally). `hasSelfEvidence` says yes, the summary comes back
  empty, and the prompt therefore carries no evidence block for it. That is
  SILENCE, not the denial this ticket is about — the prompt never tells the
  model nothing was found — but it is weaker than intended and it predates the
  ARCH-009 lane. The suite asserts the non-lying property and prints the
  unsummarised set rather than passing over it.

- **Still open:** the model-backed migration run. It was deferred last round
  because "the derivation must change under ARCH-009, so a run now would be
  evidence about code that is going to be replaced". The derivation has now
  changed, so that reason is spent and the run is unblocked — behind an
  independent clean-room pass over the ARCH-009 build.
