# Pattern — Clean-room verification (generation must not verify itself)

**Shape:** after a fix lands, a SEPARATE PROCESS — never one of your own
subagents — is given the requirement, the diff, how to run things and the
fixer's test code, and is told to BREAK the claim. It must paste real output
from a case the fixer's fixture never exercised, or its verdict is discarded.

The failure this exists for: the agent that writes the fix also writes the
fixture, runs it, and reports PASS — and we commit on that report. The
canonical shape is pagination "done and tested", CI green because the fixture
had ONE page, dead in staging after 100 records because the cursor never
advanced, with the author's own review approving the PR. Grading your own work
reproduces your own blind spots exactly.

Note what this is NOT protecting against: a lying agent. It is protecting
against an honest one that could only test what it already thought of.

## When to use
- Every `fix`, `plan+review` and `arch` build, once it is claimed done —
  before you mark the ticket VERIFIED and before you commit on the claim.
- Especially when the fix's own test is NEW. A fixer-authored fixture proves
  the fixer's hypothesis, not the requirement.
- Non-vacuity ("the test FAILS before the fix") does not substitute for this.
  It is necessary and insufficient: it proves the fixture discriminates the
  case the fixer already had in mind. The one-page fixture is non-vacuous too.

## When NOT to use
- `trivial` and docs-only work. The round trip costs more than the mistake,
  and applying it everywhere is how it gets eroded by exception until it means
  nothing. State the threshold; do not quietly extend it, and do not quietly
  skip it for a real `fix` because you are confident.
- As a substitute for the fixer running their own tests. This is the second
  check, not the first.

## How to run it
1. **Dispatch it out of process.** `node scripts/independent-verify.mjs
   --repo <dir> --range <A..B> --requirement @<file> --run "<test command>"
   --test-file <fixer's test>`. It wraps `scripts/dispatch.mjs`, so the
   verifier is a fresh CLI with its own context.
   **Not a Task subagent** — those are in-process and inherit this session's
   instructions, board snapshot and framing. Contaminated by construction; the
   convenience is exactly what makes them useless here.
2. **Clean room, not just a clean prompt.** The script exports the tree at the
   reviewed revision into a temp dir and removes the ambient-instruction
   surface agent CLIs auto-discover (`CLAUDE.md`, `AGENTS.md`, `.claude/`) plus
   `docs/prompts/` and `docs/bugs/`. The verifier should not know our board,
   our methodology, or who wrote the code. That is cheaper as well as less
   biased — the injected surface is the bulk of the tokens.
3. **Give it the test CODE, never the fixer's PROSE.** The contamination risk
   is the report, the rationale, the self-assessment — the narrative that
   explains why the fixture is the right fixture. The code has to go in: the
   verifier is required to re-run it.
4. **Charter it to break, not to check.** "Attempt to BREAK this claim."
   "Double-check this" invites agreement, and you will get it.
5. **Cross-provider by default.** Decorrelated blind spots, and the scarce
   provider's window is exactly for this (ROUTING.md). Same-provider is a
   fallback — say so in the report when you take it.
6. **Read the verdict as VALID / INVALID before reading it as pass / fail.**
   The script does this mechanically; `--check-only <file>` validates a verdict
   on its own.

## The executed-evidence contract (why it can't armchair it)
A verdict is INVALID — not a pass, not a fail; it simply does not count —
unless it contains all three:
1. the fixer's own test RE-RUN, with the command and its real output;
2. at least one ADVERSARIAL case the fixture does not cover — boundary, empty,
   second page, concurrent, injected failure — with its own command (which must
   not be the fixer's command again) and its real output;
3. an explicit **what I could not test and why**. "Nothing" is not accepted.

`VERDICT: BROKEN` requires at least one `FINDING:` line. `VERDICT: HOLDS` means
"I attempted to break it and failed", never "it looks right". Static-only review
is rejected mechanically rather than argued with, which is the only form of
rejection that survives a persuasive reviewer.

## Recording it
The ticket gets a `Verified-by:` line naming the DISPATCH RUN — provider, run
id, verdict — with fixer id ≠ verifier id:

```
- **Verified-by:** dispatch anthropic/haiku run 0f8c… (clean-room,
  `scripts/independent-verify.mjs`) — VERDICT: BROKEN
```

Naming a run is what makes this architectural rather than polite: an in-process
subagent has no run id to cite, so "I had a subagent check it" cannot satisfy
the line. `npm run board:check` warns when a ticket reaches VERIFIED without one.

## Failure modes to avoid
- **Verifying with a Task subagent because it is right there.** It shares your
  context, which is the single thing this pattern is buying its way out of.
- **Pasting the fixer's summary into the verifier's prompt** "for context". That
  is the blind spot, transmitted in one paste.
- **Accepting a confident static verdict** because it is well argued. Well
  argued is what a blind spot looks like from the inside. No evidence block, no
  verdict.
- **An "adversarial" case that re-runs the fixer's test with a new name.** The
  case must be one the fixture does not produce — a second page, an empty set, a
  boundary count, two callers at once, a dependency that fails.
- **Treating HOLDS as proof.** It is "an independent attempt to break this
  failed", which is worth a great deal more than the author's PASS and is still
  not a guarantee.
