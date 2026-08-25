# BUG-104 — the clean room strips `docs/prompts` and `docs/bugs`, but the same methodology and real tickets are still readable elsewhere in the tree it hands the verifier

- **Status:** OPEN — NEEDS A HUMAN DECISION. The leak surfaces are confirmed and reproduced; the fix has a genuine tension (verify scripts must stay readable) so a person must pick an option below rather than a lane auto-fixing it.
- **Severity:** medium — this WEAKENS a safety property that a lot of trust rests on; it is not proof that any past verdict was contaminated. See "How bad is it, honestly" — the ticket is deliberate about not overstating this in either direction.
- **Area:** verification integrity (`scripts/independent-verify.mjs` clean-room strip); the safety property behind every `Verified-by:` line
- **Reported:** 2026-08-18 by the boot-stub verification lane (found while confirming the clean room delivers what it promises)
- **Verification-class:** plan+review — the finding is a reproducible gap; the remedy is a design choice with trade-offs, not a one-liner.

## What the clean room promises vs. what it delivers

`independent-verify.mjs` builds a "clean room": it exports the reviewed revision into a temp dir and REMOVES a
`CONTAMINATION` list before the verifier starts — `docs/prompts` (the Working Agreement and methodology),
`docs/bugs` (the ticket board), the ambient-instruction files (`CLAUDE.md`, `.claude/`, `AGENTS.md`), etc. The
whole premise, stated in the script's own header, is that the verifier's input must be **only** the requirement,
the diff, the test code, and how to run things — because "the prose is what transmits the blind spot," and a
clean-room verdict is trusted precisely because the verifier never saw our methodology, our board, or who wrote
the code.

The strip is incomplete. The same prose it removes from `docs/prompts` and `docs/bugs` survives, in the same
tree, in files the strip does not touch. A verifier that greps the working copy it was handed can read our
methodology and at least one real ticket in full, rationale included.

## The two leak surfaces

1. **Quoted methodology text in `scripts/verify-*.mjs`.** These scripts embed verbatim Working-Agreement
   phrases as assertion fixtures — e.g. the phrase "build it to production confidence" is present in
   `scripts/verify-wa-injected.mjs`, `scripts/verify.ts`, and `scripts/verify-feat-089-method-auto.mjs`. The
   verify scripts are never stripped (only `docs/prompts` is), so the very sentence the strip is meant to hide
   is readable one directory over.

2. **Pinned snapshots of REAL tickets in `scripts/fixtures/feat-088/`.** That fixture set exists to hold real
   ticket prose as calibration data for the readability gate. It currently contains
   `ARCH-003-committed.md` and `ARCH-003-cleaned.md` — full snapshots of a real ARCH ticket, including its
   status line, its "DECISION NEEDED" framing, and its rationale. `docs/bugs` is stripped; this copy of a
   `docs/bugs` ticket is not.

## The leak is passive, not injected

Worth being precise about the mechanism, because it bounds the severity. Nothing here is placed into the
verifier's PROMPT — the composed prompt is still clean (that path has its own test). The leak requires the
verifier to go LOOKING: to grep or read the tree it was handed. It is a weakening of "the verifier COULD NOT
have known," not "the verifier WAS TOLD."

## How bad is it, honestly — in both directions

Do not let this ticket be read as either "every verdict is now invalid" or "cosmetic."

- It is NOT cosmetic. Today's verification discipline rests on an explicit claim: the verifier saw only the
  requirement, the diff, the test code, and how to run things. That claim is materially weaker than stated,
  and it is the claim that makes a clean-room verdict worth more than a same-context Task subagent. **Six
  independent verifications on ARCH-003 alone** have leaned on this property; that is why this is worth more
  than a footnote.
- It is NOT proof of contamination. No verifier is known to have actually read those files. The verify scripts
  are legitimately supplied to the verifier as `--test-file` input anyway (it is REQUIRED to re-run the
  builder's tests), so their content is not fully secret by design. And the fixtures are test data that happen
  to be ticket-shaped, not the live board. So: a safety property is weakened, not a past verdict falsified.

## The genuine tension in fixing it

The obvious fix — "add `scripts/` to `CONTAMINATION`" — is wrong. The clean room deliberately KEEPS the verify
scripts readable and even feeds them in, because the verifier's job is to re-run the builder's tests; strip the
scripts and you break the verification you are trying to protect. So the fix cannot be a blanket directory
strip. The leak is not "scripts exist"; it is "methodology/board PROSE sits inside files kept for a different
reason."

## Decision — how do we close the leak without breaking the verification the clean room exists to protect?

Trade-offs, not a single answer; 4 can be combined with any of 1-3.

- **1 — move the calibration snapshots out of the exported tree.** The `feat-088` fixtures are real tickets only
   because that is convenient; the readability gate could read them from a location not included in
   `git archive` (or the strip could remove `scripts/fixtures/feat-088/` specifically, since it is test DATA,
   not test CODE the verifier re-runs). Cheapest, closes leak #2 cleanly, leaves leak #1.
   - Trade-off: a targeted path strip is a denylist — the next real-ticket fixture added elsewhere reopens it.

- **2 — de-quote the methodology in verify scripts.** Replace verbatim WA sentences used as fixtures with
   synthetic stand-ins, or load the expected text from a fixture file that is itself stripped, so the assertion
   still runs but the script body carries no real methodology prose. Closes leak #1 without removing the
   scripts the verifier must re-run.
   - Trade-off: touches several verify scripts; a future script can re-introduce a quote, so it needs a guard
     to stay closed (see option 4).

- **3 — redact rather than strip.** Instead of only deleting whole paths, scan the exported tree for known
   methodology/board markers (distinctive WA phrases, ticket headers like `## Activity log`, `Verified-by:`)
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
