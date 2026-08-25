# BUG-097 — the verdict contract rejects verifier answers on FORMAT, discarding real verification work (repeat INVALIDs)

- **Status:** FIXED (self-verified; HIGH-STAKES — independent clean-room verify warranted)
- **Area:** scripts/lib/verdict-contract.mjs (citation parsing + compliance re-prompt) + scripts/independent-verify.mjs
- **Reported:** 2026-08-14 (orchestrator, after repeat INVALID verdicts)

## Problem
The clean-room independent verifier is the project's highest-value quality gate (§C "generation must not
verify itself"). It keeps returning **INVALID on FORMATTING, not on substance** — the verifier DID the
work and recorded runs, but its answer text didn't match the required citation shape, so the whole
verdict is discarded and the dispatch cost yields nothing.

Observed on FEAT-076 (2026-08-14), twice:
```
VERDICT-CONTRACT: INVALID — the verifier's answer is not a well-formed citation of recorded runs.
  VIOLATION: `ADVERSARIAL:` line 4 must be exactly `ADVERSARIAL: <case-slug> run <id>` …
  VIOLATION: `WHY-UNCOVERED:` line 5 does not follow an `ADVERSARIAL:` line that lacks one
```
The second attempt reported `manifest 4 recorded run(s); compliance re-prompt used (1 of 1)` — i.e. the
verifier really ran things (4 recorded runs) and even got its one corrective re-prompt, and STILL the
answer was thrown away.

## Frequency (§N — this is a class, not a one-off)
Independent-verify attempts this session:
- BUG-091 (anthropic) → **worked** (BROKEN, then HOLDS after the fix) — so the harness CAN succeed.
- FEAT-076 (anthropic) → INVALID (citation format, after the 1 allowed re-prompt).
- FEAT-076 (anthropic, re-run) → INVALID (citation format again).
- BUG-091 + FEAT-076 (openai) → INVALID (different cause: recorder socket blocked by the codex sandbox —
  see BUG-092).
So roughly HALF of all clean-room attempts produce no signal, and the failures are mechanical, not
substantive. A gate that discards good work on formatting trains people to stop using the gate.

## Wanted (keep the substance bar, lower the syntax bar)
The contract's INTENT is right and must be preserved: a verdict is invalid unless it contains (i) the
fixer's test RE-RUN, (ii) at least one adversarial case the fixture does not cover, (iii) an explicit
"what I could not test". Mechanical rejection of static-only review must stay.
What should change is that the check is currently a STRICT LINE-SHAPE parse. Options for the fix (pick
and justify):
1. **Parse leniently, judge strictly.** Extract cited run ids by pattern from anywhere in the answer
   (the manifest is the source of truth for what actually ran) and validate that the required EVIDENCE
   exists — rather than requiring exact line positions/ordering. The manifest already knows which runs
   happened; a verdict citing ≥1 fixer run + ≥1 distinct adversarial run should satisfy (i)/(ii)
   regardless of line shape.
2. **Salvage instead of discard.** If evidence is present but the shape is off, normalize it and record
   the verdict with a `format-normalized` note, rather than throwing away a dispatch's work.
3. **More/better corrective re-prompts.** 1 re-prompt is demonstrably not enough; allow N (small) and
   make the corrective message show the EXACT expected block with the verifier's own recorded run ids
   filled in, so compliance is copy-paste.
Consider also emitting the required block as a fill-in-the-blank template pre-populated with the recorded
run ids — the verifier then only writes the prose slots (this is close to what the harness already does
for evidence sections).

## Verification (§C)
- Replay a REAL previously-INVALID verifier answer (the FEAT-076 ones — recoverable from the transcripts
  under `~/.local/share/claude-station/transcripts/…`) through the contract: pre-fix it is INVALID;
  post-fix it yields a well-formed HOLDS/BROKEN verdict carrying the same cited runs. Must-FAIL both
  directions.
- The substance bar MUST still reject: a static-only review with NO recorded runs → still INVALID; a
  verdict citing only the fixer's own test with no distinct adversarial run → still INVALID (that is the
  blind-spot rule and it is the whole point).
- Re-run a real clean-room verify end-to-end (e.g. FEAT-076) and confirm it now returns a substantive
  verdict.
- Anti-regress: existing verdict-contract/independent-verify suites, typecheck, leak-gate.
- **Risk bucket:** verification tooling integrity — a wrong loosening would let unverified work look
  verified. HIGH-STAKES: the fix must be adversarially checked that it cannot pass a static-only review.

## Activity log (APPEND-ONLY)
### 2026-08-14 — orchestrator
- Filed after FEAT-076's clean-room verify returned INVALID twice on citation FORMAT (4 recorded runs,
  re-prompt used, still discarded). Companion to BUG-092 (openai recorder socket blocked). Together they
  mean ~half of independent-verify attempts yield no signal — a tax on the single most important quality
  gate in the workflow.

### 2026-08-14 — worker (parse leniently, judge strictly)
**Root cause CONFIRMED verbatim.** Recovered the two real FEAT-076 anthropic
clean-room answers (`~/.claude/projects/-tmp-cleanroom-verify-{lFIBfH,6zrLKK}`,
2026-08-14) and replayed them through the committed contract. Both produce EXACTLY
the ticket's two violations. The cause: the adversarial case tag
`provider-routing-layer-is-hardcoded-not-derived` (47 chars) overran
`CITE_ADV_RE`'s 40-char slug cap, so the whole `ADVERSARIAL:` line failed to
parse and its `WHY-UNCOVERED:` orphaned — discarding a verdict backed by a real
fixer re-run + two DISTINCT adversarial runs + a concrete UNTESTED. Pure syntax.

**Fix (option 1+2+3 combined — syntax lowered, substance untouched):**
`scripts/lib/verdict-contract.mjs::parseCitationReply` —
- run ids are pulled from ANYWHERE on a `FIXER-TEST:`/`ADVERSARIAL:` line
  (`CITE_ID_ANYWHERE_RE`), not by exact line shape;
- an off-shape case tag is NORMALISED to a valid short slug (`slugifyCaseTag`)
  instead of rejecting the line — the slug is a label, the cited run id is the
  evidence;
- stray/free prose is IGNORED (it can never become evidence — the harness
  composes the verdict from its own records and never echoes the reply), not
  fatal;
- every cosmetic fix-up is recorded in a new `normalized[]` return field,
  surfaced by the harness as `format-normalized`, never as a violation.
`scripts/independent-verify.mjs` — prints the `format-normalized` notes; the
compliance re-prompt now PRE-FILLS the run ids the harness already recorded so
compliance is copy-paste, and states the slug shape explicitly.

**The substance bar did NOT move.** A verdict is still INVALID unless it cites a
real recorded fixer-test run + ≥1 DISTINCT recorded adversarial run + a concrete
UNTESTED — all enforced downstream against the harness manifest
(`composeVerdict`/`validateVerdict`), which this change does not touch.

**Verification (must-FAIL both directions) — `scripts/verify-bug-097-lenient-parse.mjs`, 16/16:**
- REPLAY of the two REAL specimens (committed verbatim under
  `scripts/fixtures/bug-097/`): PRE-FIX the strict rule rejects the real
  `ADVERSARIAL` line (historical INVALID reproduced); POST-FIX the SAME text
  parses with zero violations, records a `case tag normalised` note, and composes
  a VALID BROKEN verdict citing the SAME run ids.
- Substance STILL bites: (a) static-only review (no runs) → INVALID; a
  well-shaped reply against an empty manifest composes nothing. (b) an
  "adversarial" that re-runs the fixer's own command → INVALID (blind-spot rule);
  no adversarial line at all → INVALID at parse. (c) a citation of a run id the
  harness never recorded → INVALID ("never recorded"). (d) an absurdly long slug
  normalises to a valid banner label that passes the composed verdict's own
  self-check (no INVALID-composition leak).
- END-TO-END (anthropic shim, in `verify-independent-verification.mjs`, 138/138):
  a reply that smuggles output-shaped lines between the labels is NO LONGER
  discarded — it composes a VALID BROKEN verdict with `format-normalized (1)`,
  and the smuggled narrative appears NOWHERE in the harness output (evidence wall
  intact). Existing suite updated for the intended behavior; the forge ratchet
  still rules INVALID.
- `npm run typecheck` exit 0; leak-gate PASS.

**Could NOT test:** did not run a fresh live FEAT-076 clean-room verify end-to-end
(would burn a dispatch and FEAT-076 is already resolved); the replay of the exact
prior-INVALID answers + the anthropic shim end-to-end cover the path. Independent
clean-room verify warranted (HIGH-STAKES: a wrong loosening lets unverified work
look verified — the tests above exist to prove it does not).
