# BUG-185 — the orchestrator-enforcement suite is red on a clean HEAD

- **Status:** OPEN
- **Severity:** medium
- **Area:** verification tooling (`scripts/verify-orchestrator-enforcement.mjs`)
- **Reported:** 2026-09-24 by FEAT-152 verifying lane (baseline check)
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED.

## Symptom
`npm run verify:orchestrator-enforcement` exits 1 on a clean HEAD: **119 passed,
3 failed** against the real transcript corpus. FEAT-096 recorded this same suite
at **122/122 PASS** when it closed (graded against 673→688 real tool calls); the
corpus has since grown to 1404 calls and three assertions now fail. A suite that
is permanently red on a clean tree trains every reader to skip past it, so a
genuine future regression can hide among the three fails nobody looks at — the
inverse of the "green check over a leak" hazard the board treats as serious.

The failing assertions:
- `every real gate/board command that does not also read a file is allowed
  (69/71)` — 2 refused.
- `every real file-read / tree-search command is refused (191/207)` — 16 allowed.

The third failure line is these two rolled up (the run prints both).

## Repro
1. Clean working tree at HEAD (no FEAT-152 changes needed — see below).
2. `npm run verify:orchestrator-enforcement` → `FAIL — 119 passed, 3 failed`.

Proven NOT caused by the uncommitted FEAT-152 changes: exported HEAD read-only
(`git archive HEAD | tar -x`), pointed its corpus-store path at the real orchard
store (the store path is derived from the repo dir, so a `/tmp` checkout skips the
corpus loudly), and ran the same script — identical `119 passed, 3 failed`,
byte-identical offender lines and corpus breakdown (1404 calls · 420 Bash · 200
allowed / 220 refused). The uncommitted change is only additive `ORCH-BYPASS`
code in `orchestrator-profile.mjs`; the verify script itself is unmodified vs HEAD.

## Expected
`npm run verify:orchestrator-enforcement` passes on a clean HEAD (or the three
known-and-explained corpus mismatches are acknowledged in the suite as reported
numbers, not asserted equalities), so a red run means a real regression.

## Root cause (diagnosed, not fixed)
Both failing assertions are the suite's OWN corpus-classification oracle
(`readsAFile` / `pureGate` / `realSearch`) misjudging newer real command shapes.
The policy decisions themselves are correct in every offender:

- **Offender A — 2 "pure gate/board" commands refused, and the policy is right.**
  e.g. `npx tsx scripts/verify-lane-ledger.mjs 2>&1 | tail -3; …; npm run gate …`
  and `npm run board:gen … && node -e "…" && npm run usage …`. These are compound
  commands whose other segments (`npx tsx`, `node -e`) are not on the allow list,
  so the policy correctly refuses. The test's `readsAFile` heuristic does not
  recognise `npx`/`node -e` as non-gate work, so `pureGate` wrongly includes them
  and asserts they should be allowed.

- **Offender B — 16 dispatch commands classified as file-reads, and the policy is
  right to allow them.** e.g. `node src/server/dispatch-client.mjs --provider
  openai … "You are an INDEPENDENT VERIFIER … BREAK the claim …"`. `readsAFile`
  splits the command on newlines (the multi-line clean-room prompt) and matches a
  read-verb word (find/diff/more/file/sed/…) sitting at the start of a prompt
  line, so `realSearch` wrongly classifies the dispatch as a tree-search and
  asserts it should be refused. The policy correctly allows dispatch.

Net: the product policy is behaving correctly on both offender classes; the
suite's oracle produces false expectations on multi-line dispatch prompts and on
`node`/`npx`-bearing compound commands that entered the corpus after FEAT-096.

## Context pack
- Files/functions in play:
  - `scripts/verify-orchestrator-enforcement.mjs` — section 7 ("THE REAL CORPUS"),
    the `readsAFile` / `stageOneHeads` / `READ_HEADS` classifier and the two
    failing `ok(...)` assertions (`pureGate`/`pureGateAllowed`,
    `realSearch`/`realSearchRefused`). The corpus store is
    `~/.claude/projects/<repo-path-flattened>` and grades calls since 2026-08-18.
  - `scripts/lib/orchestrator-profile.mjs` — `decideBashCommand()` (the policy
    under test; NOT implicated — its refusals/allows on the offenders are correct).
- Related tickets: FEAT-096 (the profile + this suite; closed it at 122/122),
  FEAT-152 (the ORCH-BYPASS escape hatch — its verifying lane found this and
  confirmed it is not FEAT-152's doing), ARCH-014 (cites this suite as "the
  measured corpus"), BUG-161 (fixed the e2e sibling suite's store leak).
- Repro test: `npm run verify:orchestrator-enforcement` (this suite is itself the
  artifact; the fix is to its oracle).
- Known dependencies: the corpus is live real data, so counts drift over time; a
  fix should make the oracle robust to command shape, not hard-code the current
  offenders.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-24 — FEAT-152 verifying lane (filing)
- **Understood:** Dispatched to verify FEAT-152's baseline claim that
  `verify:orchestrator-enforcement`'s 3 corpus FAILs are pre-existing at HEAD.
  Confirmed, then diagnosed the cause while I had the corpus loaded.
- **Verified (baseline claim):** working tree `119 passed, 3 failed`; HEAD export
  grading the SAME real corpus (symlinked store) `119 passed, 3 failed`, identical
  offender lines and corpus breakdown. The FEAT-152 diff is additive ORCH-BYPASS
  code only and the verify script is unmodified vs HEAD ⟹ the 3 FAILs are
  pre-existing, not FEAT-152's. Captured full offenders via a read-only harness
  reusing the real `decideBashCommand` and the suite's own filters (Offender A/B
  above).
- **Changed:** filed this ticket only. No source touched.
- **Still open / handoff:** fix the suite's corpus oracle so it stops
  misclassifying `node`/`npx`-bearing compound commands (Offender A) and
  multi-line dispatch prompts (Offender B), then re-run to a clean pass — OR
  demote the two brittle equalities to reported numbers with the reason recorded.
  Do NOT weaken `decideBashCommand`: its decisions on both offender classes are
  correct. Anti-regression: keep the two MUST-FAIL proofs (the `2>&1` tear and the
  `cd` prefix) passing.
- **Symptom of a deeper design flaw?** (open — answered at close; candidate: a
  corpus-graded assertion that asserts an equality it cannot guarantee as the
  corpus grows is structurally fragile.)

### 2026-09-24 — fixing lane, round 1 (oracle fix)
- **Understood:** Confirmed the filing lane's diagnosis against the real corpus
  before touching anything. Dumped the exact offenders with a read-only harness
  reusing the real `decideBashCommand`:
  - Offender A (2 cmds): `npx tsx …; …; npm run gate …` (offender `npx`) and
    `npm run board:gen … && node -e "…" && npm run usage …` (offender `node -e`).
    Policy REFUSES both, correctly — `npx`/`node -e` are not on the allow list.
    The oracle's `pureGate` wrongly included them because it only excluded reads,
    not other non-gate executables.
  - Offender B (16 cmds): `node src/server/dispatch-client.mjs … "<multi-line
    verifier prompt>"`. Policy ALLOWS (node script; prompt is an argument). The
    oracle split the RAW command on newlines and read prompt-line-start words as
    heads, and matched "git diff"/"git show" PROSE inside the prompt via
    `readsViaGit` — so it scored the dispatch as a tree-search.
  The product policy is correct on every offender; the SUITE's oracle was wrong.
- **Changed:** `scripts/verify-orchestrator-enforcement.mjs` ONLY (test-suite
  file; `orchestrator-profile.mjs` untouched). Hoisted the corpus oracle to
  module scope (section 6b) and made it model a command the way the shell does:
  `decidableForOracle()` strips DATA (heredoc body, redirections, substitutions,
  quoted spans, comments — porting the profile's own single-pass, honour-first-
  quote `stripQuotedAndComments`, since the profile does not export it) before
  classifying, so prose inside a quoted argument can no longer masquerade as a
  command (fixes Offender B). `readsViaGit` now runs on the stripped text.
  Redefined "pure gate work" (`isPureGateWork`): matches the gate regex, reads no
  file, AND every stage-one head is gate/board GLUE (`GATE_CONTEXT_HEADS` —
  npm/git/cd/echo/…, deliberately NOT npx/node/python), so a gate command that
  also runs an arbitrary executable is excluded and no longer expected to be
  allowed (fixes Offender A). The fix is by command SHAPE, not a hard-coded
  offender list. Updated the console narrative for honesty.
- **Verified:**
  - Before: `FAIL — 119 passed, 3 failed`. After: `PASS — 139 passed, 0 failed,
    0 skipped` (corpus loaded: 1407 calls · 420 Bash · 200 allowed / 220 refused;
    69 pure gate all allowed; 189 file-read/tree-search all refused).
  - Non-vacuity (section 6c, fixed synthetic inputs — no moving baseline):
    added proofs that the oracle STILL flags genuine reads (`cat`, `grep -rn`,
    `git show`, `git diff|head`, a read trailing/after a gate cmd) and STILL
    excludes genuine misclassifications from pure-gate (npx-compound, node -e-
    compound, read-after-gate), plus policy-agreement proofs on the synthetic
    offenders. Demonstrated they BITE: sabotaging `readsAFile→false` reddens the
    6 read-detection proofs; dropping the pure-gate glue check reddens both
    offender-A proofs.
  - Anti-regression: `npm run gate` PASS (leak-gate + typecheck, exit 0);
    siblings `verify-feat-096-read-escapes` PASS, `verify-feat-108-git-write-block`
    164/0, `verify-feat-152-orch-bypass` 43/0. Class sweep: `rg` for the oracle
    helpers (`stageOneHeads`/`READ_HEADS`/`readsAFile`/`pureGate`/`realSearch`)
    shows they exist ONLY in this suite — no sibling replicates the flaw. Other
    `decideBashCommand` consumers test the policy directly (correct), not an oracle.
- **Still open / handoff:** Independent clean-room verification per the
  Verification-class (`fix`). Suggested attack: this is a test-oracle change on a
  regression-prone verification file, so an independent verifier should (a) run
  the suite from a clean HEAD export against the REAL store and confirm 139/0,
  (b) attempt to REBREAK the oracle (a corpus command shape the strip mishandles
  — e.g. a heredoc-fed read, a `$(…)` read, an unbalanced quote) that the policy
  refuses but the oracle now passes over, and (c) confirm the section-6c proofs
  are not gameable. Independent verify warranted (regression-prone file).
- **Symptom of a deeper design flaw?** (still open — answered at close. The
  filing candidate stands: a corpus-graded check that pins an EQUALITY it cannot
  guarantee as live data grows is structurally fragile. This fix keeps the
  equality but makes the oracle model the shell faithfully; a future shape the
  oracle mis-models will redden it again. Consider whether these two should be
  reported numbers with a small tolerance rather than hard equalities — deferred
  to close.)

### 2026-09-29 — independent verification (BROKEN, VALID, reduced isolation)
- **Requirement (plain terms):** `npm run verify:orchestrator-enforcement` must
  pass green on a clean tree against the real corpus; the fix is to the suite's
  OWN oracle (`isPureGateWork`/`decidableForOracle`/`readsAFile`/`readsViaGit`),
  NOT to the policy `decideBashCommand` (which must stay unchanged); and the fix
  must be robust by command SHAPE, not a hard-coded offender list. Requirement
  written to a temp file, not the fixer's prose.
- **Strategy: OPTION-B (read-only dispatch on the live checkout), NOT a clean
  room.** The suite grades the REAL transcript corpus whose store path is derived
  from the repository directory (`~/.claude/projects/<flattened repo path>`); a
  stripped temp clean room resolves that to its own temp path, finds no corpus,
  and SKIPS the load-bearing 139/0 grade. So a clean room cannot verify the
  ticket's actual claim. Dispatched via `scripts/dispatch.mjs --sandbox read-only`
  cwd = the live repo so the real corpus is reachable. REDUCED ISOLATION: no
  clean-room strip, so the board/methodology are present on disk; the verifier was
  instructed not to read `docs/bugs`/`docs/prompts`/CLAUDE.md and self-reported it
  did not ("I haven't read the prohibited files") — mitigated, not architecturally
  enforced.
- **Command (tilde form):**
  `node scripts/dispatch.mjs --provider openai --cwd ~/projects/orchard --sandbox read-only --timeout-min 22 --ticket BUG-185 --phase verifying --round 1 --class verify --meta-out <meta-file> --prompt-stdin < <prompt-file>`
- **Verdict: BROKEN — VALID** (executed-evidence contract met by hand: fixer suite
  re-run 139/0, adversarial probes with real output, explicit UNTESTED list;
  dispatch.mjs has no auto contract-check, judged VALID on the reply's content).
- **Confirmed GOOD:** suite PASSES 139/0 on the current real corpus (grown to 1686
  calls · 494 Bash). `decideBashCommand` and every declaration before it are
  BYTE-IDENTICAL to the pre-fix baseline (`prefix through decideBashCommand
  identical: true`) — the policy was NOT weakened. The suite's non-vacuity proofs
  still BITE: sabotaging `readsAFile→false` reddens 6 proofs, `isPureGateWork→false`
  reddens 2.
- **FINDING (the oracle is still not shape-robust — the ticket's own deeper-flaw
  candidate, substantiated).** Three constructed shapes NOT yet in the corpus make
  the oracle and the policy disagree, each verified by calling the real
  `decideBashCommand` and the extracted oracle:
  - `npm run gate; echo "$(cat package.json)"` → oracle `pureGate:true` (expects
    ALLOW) but policy REFUSES (`offender:"cat"`). The oracle's data-strip removes
    the `$(…)` substitution before classifying, but the POLICY inspects inside
    `$(…)` and refuses — an asymmetry the Offender-B strip introduced.
  - `npm run gate | node -e "console.log(1)"` → oracle `pureGate:true` but policy
    REFUSES (`offender:"node -e"`). The Offender-A fix caught `&&`/`;`-chained
    `node -e` but NOT the PIPE form; a piped non-gate executable still reads as
    pure gate.
  - `npm run gate; echo git diff` → oracle `readsAFile:true` (expects REFUSE) but
    policy ALLOWS. Unquoted `git diff` PROSE as an `echo` argument is still read as
    a git-read command by the oracle.
  Net: the fix makes the current corpus green but does NOT make the oracle robust
  to command shape (the stated bar). Any of these shapes entering the corpus
  re-reddens the suite on a clean tree — exactly the structural fragility the
  filing/fixing lanes both flagged.
- **Could-not-test (verifier):** a genuinely clean tree (this live checkout had 80
  unrelated modified tracked files — the verify script itself is unmodified vs
  HEAD, established in the Repro, so 139/0 reflects the committed oracle);
  synthetic strings were classified, not executed as shell workloads; oracle
  mutations ran only the extracted proofs, not a full modified-corpus suite. Note:
  the verifier observed commit 561ad6b also changed
  `scripts/lib/orchestrator-profile.mjs` — that is the bundled FEAT-152 ORCH-BYPASS
  addition to `decide()`, NOT the BUG-185 fix, and it left `decideBashCommand`
  itself byte-identical.
- **Verified-by:** dispatch openai run 01a0ec14-e263-7e32-bf37-79707f7141eb
  (option-b read-only on live checkout, REDUCED isolation, `scripts/dispatch.mjs`)
  — VERDICT: BROKEN
- **Status:** stays OPEN. Handoff: the two brittle equalities are still shape-
  fragile. Either (a) fix the oracle for the three shapes (pipe-borne non-gate
  executables; substitution reads the policy honors; unquoted git-read prose as a
  command argument), OR (b) take the deferred deeper-flaw option and demote the two
  equalities to reported numbers with a tolerance, so the suite green-lights only
  on a genuine regression. The `Symptom of a deeper design flaw?` candidate now has
  independent evidence FOR it.
