```orchard-ticket
{
  "id": "BUG-104",
  "type": "bug",
  "title": "Verifier can still read the methodology the clean room removes",
  "summary": "A verification pass is meant to see only the requirement, the change, the test code and how to run it. The isolated copy it receives removes the methodology documents and the ticket board, yet the same methodology sentences sit inside verify scripts, and two full copies of a real ticket sit in a test fixture folder.",
  "impact_if_we_wait": "A safety property a great deal of trust rests on is weaker than stated. Bounded: the exposure is passive and nothing reaches the prompt. No verifier is known to have read those files, and no past verdict is shown to be wrong.",
  "current_need": "Choose which of the four approaches to take to close the exposure without hiding the test code a verifier must re-run.",
  "severity": "medium",
  "area": "Verification integrity",
  "reported": "2026-08-18",
  "reported_by": "agent",
  "owner": "you",
  "work_state": "open",
  "human_action": "decide",
  "updated": "2026-08-18",
  "decision": {
    "mode": "multi",
    "question": "How should the leaked methodology and ticket text be closed without hiding the test code?",
    "options": [
      {
        "key": "1",
        "label": "Move ticket snapshots out of the export",
        "what_changes": "The two real-ticket calibration copies are read from a place the isolated copy never receives.",
        "benefit": "Closes the ticket-text exposure completely and costs the least of the four.",
        "cost": "Leaves the methodology sentences inside the verify scripts exactly as they are.",
        "why_not_obvious": "It names one path, so the next real-ticket fixture added somewhere else reopens the same hole unnoticed.",
        "combines_with": [
          "2",
          "3",
          "4"
        ]
      },
      {
        "key": "2",
        "label": "Replace quoted methodology with stand-ins",
        "what_changes": "Verify scripts assert against invented sentences, or load the real text from a file that is removed.",
        "benefit": "Removes the methodology text while keeping every script the verifier must re-run.",
        "cost": "Several verify scripts have to change, and each one is a live check.",
        "why_not_obvious": "A later script can quote the methodology again, so the fix does not stay closed on its own.",
        "combines_with": [
          "1",
          "3",
          "4"
        ]
      },
      {
        "key": "3",
        "label": "Redact the copy instead of deleting paths",
        "what_changes": "The isolated copy is scanned for known methodology and ticket markers and those passages are blanked.",
        "benefit": "Catches text wherever it sits rather than only where somebody listed it.",
        "cost": "A scanner over the whole copy can blank something a test depends on and break a run.",
        "why_not_obvious": "Marker matching misses any phrasing nobody thought to list, so it reads as complete while staying partial.",
        "combines_with": [
          "1",
          "2",
          "4"
        ]
      },
      {
        "key": "4",
        "label": "Add a standing guard",
        "what_changes": "A check refuses methodology or ticket text in the copy handed over, and it runs on every pass.",
        "benefit": "Whatever is closed stays closed instead of drifting back over time.",
        "cost": "On its own it closes nothing; it only reports what the other options fix.",
        "why_not_obvious": "A guard that fires on ordinary work gets switched off, and then it protects nothing.",
        "combines_with": [
          "1",
          "2",
          "3"
        ]
      }
    ],
    "recommendation": null,
    "recommendation_reason": null,
    "prerequisite": "Establish which verify scripts genuinely need the real methodology sentence to assert anything. If none do, the stand-in option stops being a trade-off."
  },
  "decision_history": [],
  "success_criteria": [
    "The isolated copy handed to a verifier contains no methodology sentences from the working agreement",
    "The isolated copy contains no full copy of a real ticket",
    "The verifier can still read and re-run every test script it is asked to run",
    "A standing check fails if methodology or ticket text reappears in the isolated copy"
  ],
  "code_refs": [
    {
      "path": "scripts/independent-verify.mjs",
      "symbol": "CONTAMINATION",
      "note": "path list removed from the exported tree; does not cover scripts/"
    },
    {
      "path": "scripts/verify-wa-injected.mjs",
      "symbol": null,
      "note": "embeds a verbatim Working Agreement phrase as an assertion fixture"
    },
    {
      "path": "scripts/verify.ts",
      "symbol": null,
      "note": "same verbatim phrase present"
    },
    {
      "path": "scripts/verify-feat-089-method-auto.mjs",
      "symbol": null,
      "note": "same verbatim phrase present"
    },
    {
      "path": "scripts/fixtures/feat-088/ARCH-003-committed.md",
      "symbol": null,
      "note": "full snapshot of a real board ticket, status line and rationale included"
    },
    {
      "path": "scripts/fixtures/feat-088/ARCH-003-cleaned.md",
      "symbol": null,
      "note": "second full snapshot of the same real ticket"
    }
  ],
  "related": [
    {
      "id": "ARCH-003",
      "relation": "see_also"
    },
    {
      "id": "BUG-112",
      "relation": "see_also"
    },
    {
      "id": "BUG-120",
      "relation": "recurrence_of"
    },
    {
      "id": "FEAT-088",
      "relation": "see_also"
    },
    {
      "id": "FEAT-089",
      "relation": "see_also"
    },
    {
      "id": "FEAT-092",
      "relation": "blocks"
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
    "archived_path": "docs/bugs/archive/BUG-104-cleanroom-strip-incomplete-methodology-and-real-tickets-still-readable.md",
    "sha256": "22e073507a454c76146caed7b78c7932d4698b92e4277d93f7731fcd774b881d",
    "bytes": 13479,
    "original_title": "the clean room strips `docs/prompts` and `docs/bugs`, but the same methodology and real tickets are still readable elsewhere in the tree it hands the verifier",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the ticket head section by section; both leak surfaces, the passive-not-injected bound, the both-directions severity reading, the tension, and all four options are present.",
    "dropped": [
      "the ticket's fourth option text was truncated in the source at option 3; its intent is carried as the standing guard the other options reference"
    ]
  }
}
```

# BUG-104 — Verifier can still read the methodology the clean room removes

## Diagnosis

### The promise

`scripts/independent-verify.mjs` exports the reviewed revision into a temp dir and deletes a `CONTAMINATION` list before the verifier starts: `docs/prompts` (Working Agreement and methodology), `docs/bugs` (the board), and the ambient-instruction files (`CLAUDE.md`, `.claude/`, `AGENTS.md`). The script's own header states the premise — the verifier's input must be only the requirement, the diff, the test code, and how to run things, because "the prose is what transmits the blind spot."

### The strip is incomplete

The same prose survives elsewhere in the same tree, in files the strip does not touch.

1. **Quoted methodology in `scripts/verify-*.mjs`.** These scripts embed verbatim Working-Agreement phrases as assertion fixtures — the phrase "build it to production confidence" appears in `scripts/verify-wa-injected.mjs`, `scripts/verify.ts` and `scripts/verify-feat-089-method-auto.mjs`. Only `docs/prompts` is stripped, so the sentence the strip exists to hide is readable one directory over.

2. **Pinned real-ticket snapshots in `scripts/fixtures/feat-088/`.** `ARCH-003-committed.md` and `ARCH-003-cleaned.md` are full snapshots of a real ARCH ticket, including its status line, its "DECISION NEEDED" framing and its rationale. `docs/bugs` is stripped; this copy of a `docs/bugs` ticket is not.

### Why the obvious fix is wrong

Adding `scripts/` to `CONTAMINATION` breaks the verification it is meant to protect: the clean room deliberately keeps the verify scripts readable and feeds them in, because re-running the builder's tests is the verifier's job. The leak is not that scripts exist; it is that methodology and board prose sits inside files kept for a different reason.

## Evidence

The leak surfaces were located and reproduced by grepping the exported tree. `verify:decision-shape` ran 25/25 passing, and the standing leak-gate check reported clean. `verify:wa-injected` and `verify:feat-089-method-auto` are named as carriers of the quoted phrase, not as runs.

The mechanism is passive. Nothing here enters the verifier's composed prompt — that path has its own test and is still clean. The leak requires the verifier to go looking: to grep or read the tree it was handed. It weakens "the verifier could not have known," not "the verifier was told."

Six independent verifications on ARCH-003 alone have leaned on this property, which is why it is more than a footnote. Against that: no verifier is known to have read those files; the verify scripts are legitimately supplied as `--test-file` input, so their content is not secret by design; and the fixtures are test data that happen to be ticket-shaped rather than the live board.

## Implementation notes

Option 1 has two shapes: relocate the `feat-088` fixtures outside what `git archive` exports, or add `scripts/fixtures/feat-088/` to the strip specifically, since it is test DATA rather than test CODE the verifier re-runs.

Option 2 has two shapes: replace the verbatim sentences with synthetic stand-ins, or load the expected text from a fixture file that is itself stripped, so the assertion still runs while the script body carries no real methodology prose.

Option 3 scans the exported tree for known methodology and board markers — distinctive Working Agreement phrases, ticket headers — and redacts them in place rather than deleting whole paths.

## Verification plan

Export a clean room and grep it for the known methodology phrase and for the ARCH-003 ticket markers; both must return nothing. Then run a full verification pass to confirm the verifier can still read and execute the test scripts it is handed.

## Activity log`, `Verified-by:`)
   and blank them wherever they appear — including inside kept files.
   - Trade-off: most thorough, but redaction inside code files risks corrupting a verify script the verifier
     then runs; and a marker list is itself a denylist.

- **4 — a leak GATE for the clean room.** After building the room, grep the exported tree for a small set of
   canary strings (a phrase unique to the WA, a real ticket id + its rationale line) and FAIL the build if any
   survive the strip — the same shape as the existing leak-gate. Turns "the strip is complete" from a hope into
   an asserted, regression-proof invariant.
   - Trade-off: canaries are a denylist too, but this is the only option that keeps whatever fix is chosen from
     silently rotting; pairs with 1/2/3 rather than replacing them.

## What would have to be true to call it fixed

- The clean room the verifier is handed contains NO verbatim Working-Agreement / methodology prose and NO real
  ticket body (rationale, status framing, activity log) in ANY file — not just under `docs/`.
- The verify scripts the verifier is required to re-run STILL run and still assert what they assert (the fix did
  not neuter the tests to hide the prose).
- There is an executable check (option 4 or equivalent) that FAILS if a future change re-introduces methodology
  or board prose into the exported tree, so the property cannot silently regress.

<!-- ===== technical detail below — reproduction, exact locations; not needed to grasp the problem above ===== -->

## Context pack (the "where to look")

- **The strip:** `scripts/independent-verify.mjs` — `CONTAMINATION` array (~line 194) lists `docs/prompts`,
  `docs/bugs`, `docs/DEPLOY-CONTEXT.md`, and the ambient-instruction files. `buildCleanroom()` (~line 234) does
  `git archive <rev> | tar -x` into a temp dir, then `fs.rmSync`s each `CONTAMINATION` entry. `scripts/` and
  `scripts/fixtures/` are NOT in the list and are NOT otherwise removed. Header rationale is at lines 20-28
  ("REMOVES that surface before the verifier starts", "the prose is what transmits the blind spot").
- **Leak #1 — methodology in verify scripts:**
  - `/usr/bin/grep -rln "build it to production confidence" scripts/` → `scripts/verify.ts`,
    `scripts/verify-wa-injected.mjs`, `scripts/verify-feat-089-method-auto.mjs`.
  - e.g. `scripts/verify-wa-injected.mjs:42` → `{ tpl: 'working-agreement', text: 'build it to production confidence' }`.
  - These are verbatim WA phrases; `docs/prompts/WORKING_AGREEMENT.v2.md` (the source) IS stripped, this quote
    of it is not.
- **Leak #2 — real tickets in fixtures:**
  - `ls scripts/fixtures/feat-088/` → `ARCH-003-committed.md`, `ARCH-003-cleaned.md` (172 lines each).
  - `sed -n '1,4p' scripts/fixtures/feat-088/ARCH-003-committed.md` shows the real `# ARCH-003 …` title,
    `Status: OPEN — DECISION NEEDED`, `Raised from: BUG-096`, and the rationale that follows.
  - `docs/bugs/ARCH-003-*.md` (the live ticket) IS stripped; this snapshot of it is not.
- **Confirm neither is stripped:** `--print-cleanroom-report` (`--print-prompt`) prints the `stripped:` list;
  `scripts/` and `scripts/fixtures/` never appear on it. A verifier with `Bash`/`Grep` (both granted —
  `--allow-tools 'Bash Read Write Edit Glob Grep'`, ~line 590) can `grep -r` the room and read both.
- **Why it is load-bearing:** the `Verified-by:` contract (`docs/bugs/README.md` rule 5, `TEMPLATE.md`) treats a
  clean-room DISPATCH verdict as trusted BECAUSE the verifier was decorrelated from our framing. ARCH-003's log
  records six independent verifications relying on that.
- **Related:** BUG-092 (clean-room transport under the codex sandbox — same script, adjacent surface),
  BUG-080/BUG-102/BUG-103 (leak-gate / silent-tool-lies family — option 4 mirrors the leak-gate shape),
  FEAT-061 (the clean-room verification feature this weakens), FEAT-088 (owns the `feat-088` fixtures behind
  leak #2), ARCH-003 (the six verifications that lean on the property).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-18 — boot-stub verification lane (filing)

- **Understood:** the clean room's whole value is that the verifier saw only the requirement/diff/tests/how-to-run,
  never our methodology or board. While verifying the boot-stub fix I checked whether the strip actually delivers
  that and found the same prose it removes still readable elsewhere in the exported tree.
- **Reproduced (read-only, no changes):** leak #1 — `/usr/bin/grep -rln "build it to production confidence"
  scripts/` returns three verify scripts, and the source phrase's home (`docs/prompts`) is stripped while these
  quotes are not. Leak #2 — `scripts/fixtures/feat-088/ARCH-003-committed.md` is a full 172-line snapshot of a
  real ARCH ticket (title, status, rationale), and `docs/bugs` is stripped while this copy is not. Confirmed
  `CONTAMINATION` (`independent-verify.mjs:194`) contains neither `scripts` nor `fixtures`.
- **Changed:** filed this ticket only. Did NOT touch `scripts/independent-verify.mjs`, any verify script, or the
  fixtures — the remedy is a design decision with a real tension (option list above) and the file is verification
  infrastructure other lanes depend on.
- **Severity, stated honestly:** medium. A weakening of a safety property, not proof of a contaminated verdict —
  the leak is passive (needs the verifier to go looking), no verifier is known to have read these files, and the
  verify scripts are supplied as input anyway. But six ARCH-003 verifications rest on this property, so it is not
  cosmetic.
- **Still open / handoff:** a human picks among options 1-4 (ideally a closing fix PLUS option 4 as the
  regression guard). Because this is a verification-integrity change, its own fix warrants an independent
  clean-room verify pass — and note the irony that the tool under test is the clean room itself, so the verify
  should confirm the exported tree is clean, not merely that the code changed.

### 2026-08-18 — ticket-format enforcement lane (worker)

- **Understood:** this ticket declared "NEEDS A HUMAN DECISION" but argued its four options as numbered prose,
  which `ticketDecision()` does not parse — so no Decide card rendered and the choice never reached the user.
  Same condition as ARCH-005; found by the new `board:check` decision-shape guard, not by hand.
- **Changed:** FORMATTING ONLY. `## Options (trade-offs, not a single answer)` became a `## Decision — …`
  heading (the parser only inspects headings containing "Decision"), the four numbered items became bold-lead
  bullets keyed `1`-`4` with their trade-off sub-bullets intact, and an INDEX.md Open row was added with
  Owner 👤 (the ticket had no row). No option text, trade-off or "what would have to be true" text changed.
- **Verified:** `ticketDecision()` now yields 4 options; `board:check` no longer reports UNPARSEABLE DECISION
  for BUG-104; `npm run verify:decision-shape` 25/25 PASS.
- **Still open / handoff:** unchanged — a human picks 1, 2, 3 and/or 4 (4 combines with any of 1-3).
