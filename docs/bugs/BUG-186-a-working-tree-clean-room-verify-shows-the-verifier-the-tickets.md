# BUG-186 — a working-tree clean-room verify shows the verifier the ticket's own refutations

- **Status:** OPEN
- **Severity:** high
- **Area:** verification tooling (`scripts/independent-verify.mjs`)
- **Reported:** 2026-09-24 by FEAT-152 round-4 fixing lane (from the round-3 commissioner's note)
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED.

## Symptom
An independent verifier is meant to attack a change knowing only the requirement,
the change itself, the tests and how to run them. When it is run over the live
dirty tree (`--working-tree`), the change it is shown includes every uncommitted
ticket edit on the board — for the ticket under review, that is the fixer's own
reasoning and every earlier verifier's refutation. The verifier then reads the
plan and the prior attacks it is supposed to arrive at independently, so a
"clean-room" verdict is not clean, and nothing in the verdict says so.

Observed on FEAT-152 round 3 (2026-09-24): the commissioner found that a
`--working-tree` run on the live tree would have put the FEAT-152 ticket (rounds
1-2 refutations and the fixer's entries) plus eight other tickets' Activity logs
into the verifier's prompt. They worked around it by hand — a scratch repo whose
dirty tree held only the five FEAT-152 code files — and noted it in the FEAT-152
Activity log (round-3 REFUTED entry, "Commissioning note").

## Expected
The change shown to the verifier never carries board or methodology prose — the
same material the clean room already deletes from the verifier's working copy.
A verify over the live dirty tree must be as clean as one over a hand-built
scratch repo, without the commissioner having to build one.

## Repro
1. With any uncommitted edit under `docs/bugs/` (e.g. an appended Activity entry)
   plus a code change, run
   `node scripts/independent-verify.mjs --repo . --working-tree --print-prompt …`.
2. The printed prompt's diff section contains the `docs/bugs/…` hunks verbatim.

## Root cause (diagnosed from source, not fixed)
The room and the diff are built from two different lists. `buildCleanroom`
deletes the `CONTAMINATION` paths (`docs/prompts`, `docs/bugs`, …) from the
exported room, but the diff the prompt carries is
`gitOk(repo, 'diff', base, head)` (`scripts/independent-verify.mjs`, ~line 731)
with no pathspec, so it includes every path the room strip removed.
`--working-tree` (FEAT-134) makes this routine: the snapshot is the whole dirty
tree, and the board is almost always dirty. A committed range can carry the same
leak whenever a commit touches a ticket, so this is not only a `--working-tree`
defect; `--working-tree` just makes it happen every time.

## Context pack
- Files/functions in play: `scripts/independent-verify.mjs` — `CONTAMINATION`
  (~line 233), `buildCleanroom` (the strip), the `fullDiff` construction (~line
  731) and the `--working-tree` snapshot branch just above it (~line 715,
  FEAT-134).
- Related tickets: BUG-104 and BUG-120 (what the ROOM still leaks — different
  surface: those are files the verifier can read, this is the diff it is handed),
  FEAT-134 (`--working-tree`), FEAT-152 (where it was observed; round-3 entry).
  BUG-120's recorded direction applies here too: the owner of a check names its
  inputs, rather than keeping a second list of what to leave out.
- Repro test: none yet. A proof should run `--print-prompt` over a real dirty tree
  that includes a `docs/bugs` edit and assert no board/methodology path appears in
  the diff, with a must-FAIL against the current diff construction.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-24 — FEAT-152 round-4 fixing lane (filing)
- **Understood:** FEAT-152's round-3 verifier commissioner reported the leak and
  worked around it by hand. Searched the board for an existing ticket: BUG-104
  and BUG-120 cover what the clean ROOM leaks, and FEAT-134 added
  `--working-tree`; none covers the diff handed to the verifier. Filed this one.
- **Verified:** by source reading only — the room strip and the diff are built
  from different inputs, and the diff call takes no pathspec. Not executed here.
- **Changed:** filed this ticket and its INDEX row. No source touched (the
  dispatch said file, don't fix).
- **Still open / handoff:** fix so the diff excludes everything the room strips,
  derived from one declared input set rather than a second list; prove it with a
  must-FAIL `--print-prompt` run over a real dirty tree.
- **Symptom of a deeper design flaw?** (open — answered at close; candidate: the
  same BUG-120 shape — two readers each working out what is "safe" from separate
  lists.)
