# BUG-192 — the response-format Stop hook blocks compliant replies (a read-during-write race) and force-regenerates over-length ones

- **Status:** FIXED (round 3). The three round-1 clean-room findings were closed in
  round 2 (length is NEVER part of a block reason; a BLOCK occurs only on
  proven-this-turn `blockSafe` text under EVERY env) — CONFIRMED by the OpenAI
  cross-provider clean-room (2026-09-28, run 01a0e4d8). Round 3 closes that round's
  one LOW-severity residual: `extractProse` now excludes tilde fences, pipeless GFM
  tables and relative-link targets, verified over a 3930-reply real-transcript
  readability sweep with ZERO verdict changes (no ALLOW→BLOCK). G5 / bug-118-C1 are
  pre-existing (not BUG-192 regressions). See the round-1/2/3 Activity entries.
- **Severity:** high
- **Area:** scripts/hooks (response-format-gate.mjs) / scripts/lib (format-metrics.mjs)
- **Reported:** 2026-09-27 by user (via orchestrator dispatch)
- **Verification-class:** behavioural (real Stop-hook subprocess, before/after) +
  anti-regression

## Symptom
On every Orchard-launched session the response-format Stop hook hard-blocked
replies unconditionally (not gated by `ORCHARD_STOP_HOOK_ENFORCE`). Each block
forces the model to REGENERATE the reply in the same turn: the user sees the
reply twice and each resend re-reads ~200k context tokens. In session `4846de18`
it fired **77 of 497** replies. Two distinct causes:

1. **A read-during-write RACE.** `lastAssistantText()` re-reads the transcript
   TAIL. When the Stop hook fires before the current reply's JSONL line is
   flushed, the tail is the PREVIOUS assistant message, so the hook grades the
   wrong reply — a compliant 113-word reply was blocked as **"453 words"** (the
   prior message). The code comment at `response-format-gate.mjs:499-503` claiming
   the race can only UNDER-count was wrong: a longer previous message OVER-counts.

2. **The length budget was a HARD BLOCK.** FEAT-138 wired the ≤120/≤250-word prose
   budget into the enforced `reviseTurn` path — active by default. An over-budget
   reply forced a second generation. FEAT-127's own numbers show 65% of turns over
   the budget, so this was the dominant cost, not a rare correction.

## Repro
`node scripts/verify-bug-192-stop-hook-race-and-length.mjs` — case [1] replays the
race (payload carries a compliant 113-word reply while the transcript tail is a
stale 453-word message). Against the pre-fix hook it emits
`{"decision":"block", ...453 words...}`.

## Expected
- Grade THIS turn's reply, never a stale earlier one.
- An over-budget reply is never force-regenerated.
- The prose count matches what the readability check counts.

## Was a hard block a recorded USER decision? No.
Checked FEAT-125/127/137/138, the git log and CONVENTIONS. The user's verbatim
request (FEAT-125) was *"they all talk too much for no reason"* — a request for
brevity. FEAT-138 ("enforce ... at the Stop hook") is an orchestrator-filed ticket
whose BLOCKING mechanism was a fix-lane design choice, justified in-ticket, not an
explicit user directive to regenerate replies. No recorded decision requires a
hard block, so the length budget is made advisory. (ask-ownership FEAT-137 and
completion-claim FEAT-150 keep blocking — unchanged.)

## Fix
1. **Race — `resolveGradedText(payload)`** (`response-format-gate.mjs`). Grades the
   Stop payload's `last_assistant_message` (this turn's final text, race-immune;
   verified as a live payload field). Falls back to the transcript tail only when
   the field is absent, and marks that path `blockSafe:false`: it may be a
   pre-current message, so nothing may BLOCK on it — advisory reporting still runs.
   Every check reading `text` (digest, emoji, readability, blocks, length) is fixed
   by this single source switch. The wrong `:499-503` comment is corrected.
2. **Length advisory** (`response-format-gate.mjs`). Removed length from the
   enforced set; it now joins the advisory bucket (systemMessage to the user +
   the `overLengthBudget` telemetry format-metrics already records). No Stop-hook
   output field reaches the model's NEXT turn without blocking THIS one (Claude
   Code's Stop contract offers only `decision:block`+reason, `continue`/`stopReason`,
   `systemMessage`, `suppressOutput`; `additionalContext` is a
   UserPromptSubmit/SessionStart/PostToolUse field, not a Stop one), and the
   brevity rule is already injected into every turn's RESPONSE_FORMAT.md core — so
   advisory + telemetry is the correct option. A BLOCK is now emitted only when
   `enforced && blockSafe`.
3. **Counter** (`format-metrics.mjs` `proseVolume`). Runs each block body and each
   fallback run through readability's `extractProse` before counting, so the length
   metric excludes markdown tables, blockquotes (quoted evidence), link targets and
   code — exactly what the readability grader excludes. Counting those penalised the
   budget's own DO-NOT-CUT list (before/after evidence, quoted output).

## Files
- `scripts/hooks/response-format-gate.mjs` — `resolveGradedText`, `blockSafe`
  gating, length → advisory, corrected race comment, `reviseTurn` docstring.
- `scripts/lib/format-metrics.mjs` — `proseVolume` strips via `extractProse`
  (imports `readability.mjs`, already co-located in every onboarded project).
- `scripts/verify-bug-192-stop-hook-race-and-length.mjs` — new behavioural suite.
- `scripts/verify-feat-137-138-enforcement.mjs` — length assertions flipped to
  advisory; harness replays `last_assistant_message` (regressed-from: FEAT-138).
- `scripts/verify-feat-150-completion-claim.mjs`,
  `scripts/verify-bug-118-orchard-only-stop-hook.mjs` — harnesses now carry
  `last_assistant_message` (matches real Claude Code payloads).

## Deployment
The hook is the ONLY method file always re-synced over existing copies
(onboard `RESYNCABLE_HOOK`; fleet-sync `SYNCED_TOOLS`). Fixes 1 & 2 (the
harm-stopping changes, entirely in the hook) deploy everywhere via:

- one project: `node scripts/onboard.mjs <project-dir>` (already run for one
  onboarded example project outside this repo — BUG-192 markers now present).
- fleet-wide: `node scripts/fleet-sync.mjs --apply` (reads the registry
  read-only, re-syncs the hook into every onboarded project).

**Gap (flagged, not closed here):** `scripts/lib/format-metrics.mjs` (fix 3) is in
onboard's never-clobber `METHOD_FILES`, so it has NO auto-resync path — a deployed
project keeps its old counter until it re-onboards into a fresh checkout or the
file is copied manually (`cp scripts/lib/format-metrics.mjs <project>/scripts/lib/`).
Because length is now advisory, a stale counter only over-reports an advisory; it
never blocks. Extending the resync set to the method closure is an onboard design
change left for the orchestrator.

## Honest limitations / could-not-test
- `last_assistant_message` is assumed to be the current turn's full final text.
  Verified as a present payload field (docstring + captured live payload in
  verify-bug-118); an SDK change to its content would fall back to the
  transcript (no-block) path, which is safe.
- Not run: a live end-to-end session (needs the running server; out of scope for
  a fix lane). The real-payload path is exercised by the subprocess suites.
- Pre-existing, NOT caused by this change (confirmed identical against HEAD):
  `verify-feat-085-adversarial` 77/2, `verify-bug-118` C1 (an env-PATH test).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-27 — dispatched fix lane (fixing, round 1)
- **Understood:** two independent causes of unconditional Stop-hook blocks — the
  read-during-write race grading a stale message, and the length budget being a
  hard block. Verified hypothesis (a): reproduced the race against the real HEAD
  hook (a compliant 113-word payload reply blocked as "453 words" from the stale
  453-word transcript tail). Verified hypothesis (b): no recorded USER decision
  mandates a hard block (see the section above).
- **Changed:** the files above. Race fixed at the text source (grade
  `last_assistant_message`, transcript fallback never blocks); length made
  advisory; counter aligned to readability's exclusions.
- **Must-FAIL proof (real hook subprocess):**
  - RACE — BEFORE (HEAD hook): stale 453-word tail + compliant 113-word payload →
    `{"decision":"block", ...453 words; the budget is 120...}`. AFTER: ALLOWED.
  - LENGTH — a 400-word reply: BEFORE blocked; AFTER not blocked, advisory
    systemMessage naming the budget.
  - ASK/COMPLETION still block on the block-safe (payload) path; both decline on
    the stale transcript fallback.
  - COUNTER — a reply of one short line + a big table/blockquote/links: proseWords
    11 vs a raw count of 66; stays under the 120 budget.
- **Verified (counts):** `verify-bug-192` 8/0; `verify-feat-137-138-enforcement`
  12/0 (updated); `verify-feat-150-completion-claim` 11/0 (updated);
  `verify-bug-118-orchard-only-stop-hook` 110/1 (the 1 is the pre-existing C1 env
  test, fails on HEAD too); `verify-feat-085-stop-hook` 61/61;
  `verify-feat-091-response-blocks` 278/0; `verify-feat-084` 37/0;
  `verify-bug-177-hook-errors` 18/18; `verify-feat-089-method-auto` 35/0;
  `verify-feat-085-adversarial` 77/2 (pre-existing, unchanged vs HEAD).
- **Gate:** `npm run gate` → PASS (exit 0) — leak-gate + check-nul + typecheck.
  No git commands run; all work left unstaged.
- **Deployed:** hook re-synced into one onboarded example project outside this
  repo (fixes 1+2); fleet-wide command reported above; format-metrics resync gap flagged.
- **Independent verify:** WARRANTED — this changes the Stop-hook decision on every
  turn of every session (session-lifecycle, regression-prone; touches a
  much-regressed file). A clean-room pass over the race fix (payload-vs-transcript,
  truncated transcripts) and the enforce/advisory split is recommended.
- **Symptom of a deeper design flaw?** Partly — yes, ARCH candidate. The recurring
  shape (FEAT-085 → 138 → BUG-192) is a Stop hook trying to correct the CURRENT
  turn from a source it cannot read atomically, and a "measurement" quietly
  promoted to a block without the user choosing it. Not filing an ARCH ticket in
  this lane; flagged for the orchestrator.

### 2026-09-27 — independent clean-room verify (verifying, round 1) — BROKEN
- **Verified-by:** dispatch anthropic/opus run
  768e2b04-edde-46a7-8d20-f54b03c1c79b (clean-room,
  `scripts/independent-verify.mjs`) — VERDICT: BROKEN. SAME-PROVIDER FALLBACK:
  OpenAI was exhausted (5h binding window 100% used at dispatch time), so this
  ran anthropic→anthropic with decorrelation reduced. **An OpenAI cross-provider
  round is still OWED** and should be run after the OpenAI window resets.
- **Inputs given to the verifier (clean-room, contamination stripped):** the
  requirement in plain terms (the 4 claims + the loop/feedback attacks), the
  scoped diff of ONLY the 6 BUG-192 files (dangling overlay commit
  `02a4c11`, `HEAD..overlay`), run instructions, and the two hermetic fixer
  suites (`verify-bug-192`, `verify-feat-137-138`) as test code. NOT given: this
  ticket's prose or the fixer's report.
- **Fixer suites re-run in the clean room:** `verify-bug-192` 8/0 and
  `verify-feat-137-138` 12/0 both PASS (matches the fixer's counts).
- **Adversarial break (manifest run cd54aba33ed1, exit 1):** three findings —
  1. (DEFAULT PATH, no env needed) When an ask-ownership / completion-claim block
     fires on a reply that is ALSO over-length, `reviseTurn` → `summarise(cats)`
     (`response-format-gate.mjs:512`) folds `lengthReasons` into the block reason,
     so the model is told "This reply is 420 words … Cut it …". Length feedback
     DOES reach the model's regeneration — contradicts claim (2) / the "length
     must not feed the model" property. This is the strongest finding: it needs no
     opt-in env.
  2. & 3. (ENFORCE-ONLY) With `ORCHARD_STOP_HOOK_ENFORCE=1`, an over-length-only
     reply blocks, and the `blockSafe:false` stale-transcript fallback blocks,
     both via `reportViolation` (`:449` no-ops only when the env is unset). Length
     now rides the advisory bucket, which is ENFORCE-gated — so under that opt-in
     switch length blocks again and a stale message can block. `ORCHARD_STOP_HOOK_
     ENFORCE` is documented as "set in no launch path", so these are unreachable in
     production; whether they still violate the literal "over-length must NEVER
     block" requirement is an orchestrator/user judgement.
- **Could not test:** claim (4) sync to other installed projects (writes outside
  the working copy); whether real Claude Code always populates
  `last_assistant_message` before Stop fires (needs a live CLI session);
  completion-claim block on the stale fallback (needs board state not built).
- **Recommendation:** finding 1 is a real default-path defect and should be fixed
  (drop `lengthReasons` from the enforced-block reason). Then re-run, and run the
  OWED OpenAI cross-provider round.

### 2026-09-28 — independent clean-room verify (verifying, round 2) — BROKEN (claim 3 only; round-1 breaks CLOSED)
- **Verified-by:** dispatch openai run 01a0e4d8-4043-7cf2-9c67-5711672ccf6f
  (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN. This is the
  CROSS-PROVIDER OpenAI round that was owed from round 1 (anthropic→openai);
  decorrelation restored. OpenAI's 5h window had reset before dispatch.
- **Inputs (clean-room, contamination stripped):** the requirement in plain terms
  (4 claims, claim 2 sharpened to "never blocks and never appears in any block
  reason under any env", claim 1 fallback "never blocks under any env"), the
  scoped diff of ONLY the 6 BUG-192 files (dangling overlay `86666de`,
  `HEAD..overlay`), run instructions, and the two hermetic fixer suites as test
  code. NOT given: this ticket's prose or the fixer's report.
- **Round-1 breaks re-attacked and CONFIRMED CLOSED (verifier's own runs):**
  attack1 unowned-ask + over-length → BLOCKED but the reason carries NO length
  feedback; attack2 over-length-only with `ORCHARD_STOP_HOOK_ENFORCE=1` → NOT
  blocked; attack3 stale-transcript fallback with `ENFORCE=1` → NOT blocked; guard
  ENFORCE=1 + blockSafe missing-digest still BLOCKS (opt-in path intact). Fixer
  suites re-ran green: `verify-bug-192` 12/0, `verify-feat-137-138` 12/0.
- **NEW break — claim 3, LOW severity (manifest run 63e7490d4614, exit 1):**
  `proseVolume` (via readability `extractProse`) does NOT exclude three markdown
  variants the readability grader also mishandles: (a) TILDE-fenced code (`~~~`)
  → 202 words counted; (b) tables written WITHOUT outer edge pipes → 204 vs 1 for
  the pipe-bordered equivalent; (c) RELATIVE markdown link targets → 204. So the
  counter over-counts for those shapes, violating claim 3's "exclude
  tables/links/quoted-evidence/code". BOUNDED IMPACT: length is advisory-only
  (round-1 finding closed), so an over-count can only over-report an advisory —
  it can NEVER block or force regeneration. Whether to widen `extractProse` (a
  readability.mjs change, outside the two hook files) is an orchestrator/user call.
- **Could not test:** deployment/sync to already-installed projects (no installed
  target in the room); length feedback on a completion-claim block (the probes
  produced no completion block).
- **Coordinator's HEAD-baseline check (run by this lane, not the clean room):** a
  read-only `git archive HEAD` export (BUG-192 changes are all uncommitted, so
  HEAD excludes them; node_modules symlinked, tests never write it) confirms both
  failures the fixer called pre-existing DO fail on HEAD without BUG-192:
  `verify-feat-085-adversarial` G5 ("digest NOT at top → got ALLOW, want BLOCK",
  part of the standing 77/2) and `verify-bug-118` C1 (the BUG-091 PATH-env
  anti-regression). Neither is a BUG-192 regression.

### 2026-09-28 — dispatched fix lane (fixing, round 2) — closed the 3 clean-room findings
- **Understood:** round 1 made length advisory in the DEFAULT path but left three
  holes: (1) when an ask/completion block fired, `reviseTurn` → `summarise(cats)`
  folded `lengthReasons` into the block reason, so length feedback DID reach the
  regeneration; (2) under `ORCHARD_STOP_HOOK_ENFORCE=1` an over-length-only reply
  still blocked via the advisory reporter's enforce branch; (3) same branch blocked
  on the `blockSafe:false` stale-transcript fallback.
- **Changed (both in `response-format-gate.mjs`):**
  - Replaced `makeViolationReporter`/`reportViolation` with `reportAdvisory` — a
    closure that CANNOT write `decision:block` under any env. The block decision now
    lives entirely in `main()`.
  - `main()` decision rewritten around three unconditional rules: length is advisory
    under every env and is NEVER passed into the block cats; a block happens only
    when `blockSafe` (payload text) is true; `ORCHARD_STOP_HOOK_ENFORCE` only widens
    WHICH advisory categories (format/readability/blocks) may block — it can never
    make length block nor make a non-blockSafe fallback block. `reviseTurn` is now
    called with `{formatReasons, readabilityReasons, blockReasons, askReasons,
    completionReasons}` — no `lengthReasons`.
- **Must-FAIL proof (real hook subprocess; reconstructed round-1 hook vs round-2):**
  - attack1 (DEFAULT): unowned-ask + over-length → round-1 block reason CONTAINED
    "…words of prose…"; round-2 BLOCKS but the reason has NO length text.
  - attack2 (ENFORCE=1): over-length-only → round-1 BLOCKED; round-2 NOT blocked.
  - attack3 (ENFORCE=1): stale transcript fallback → round-1 BLOCKED; round-2 NOT
    blocked. All three FAIL on the reconstructed round-1 hook, PASS on round-2.
  - guard: ENFORCE=1 + blockSafe missing-digest still BLOCKS (opt-in path intact).
- **Verified (counts):** `verify-bug-192` 12/0 (adds the 3 attacks + guard);
  `verify-feat-137-138-enforcement` 12/0; `verify-feat-150-completion-claim` 11/0;
  `verify-feat-085-stop-hook` 61/61; `verify-bug-118-orchard-only-stop-hook` 110/1
  (the 1 is the pre-existing C1 env-PATH test, fails on HEAD too);
  `verify-feat-085-adversarial` only G5 fails (pre-existing FEAT-143 short-reply
  exemption, fails on HEAD too); `verify-feat-091` 278/0; `verify-feat-084` 37/0;
  `verify-bug-177-hook-errors` 18/18; `verify-feat-089-method-auto` 35/0.
- **Test-harness fidelity (regressed-from: round 1):** the enforce/completion
  suites replay `last_assistant_message` = the transcript's final logical message
  (what real Claude Code sends), because the round-2 rule "no block on the
  transcript fallback" correctly stops them blocking on transcript-only payloads.
  Files: verify-feat-085-stop-hook.mjs, verify-feat-085-adversarial.mjs (+ the
  round-1 verify-feat-137-138 / verify-feat-150 / verify-bug-118 edits).
- **Gate:** `npm run gate` → PASS (exit 0). No git commands run; work left unstaged.
- **Deployed:** round-2 hook re-synced into the same onboarded example project
  outside this repo (markers present); fleet-wide via `fleet-sync.mjs --apply`.
- **Independent verify:** the OWED OpenAI cross-provider clean-room round should be
  run now the attacks are codified in `verify-bug-192`.

### 2026-09-28 — dispatched fix lane (fixing, round 3) — closed the OpenAI claim-3 gap
- **Understood:** the OpenAI round-2 clean-room (manifest 63e7490d4614) closed the
  three earlier breaks and found one low-severity residual: `extractProse` (shared
  by the length counter AND the readability check) did not exclude tilde (`~~~`)
  code fences, GFM tables written WITHOUT outer pipes, or relative-link targets, so
  their words were still counted.
- **Changed (`scripts/lib/readability.mjs`, `extractProse`):**
  - Tilde fences stripped as a SEPARATE pass (`FENCED_TILDE`) so backtick handling
    stays byte-identical (no readability change from that line).
  - Markdown links collapsed to their label (`MD_LINK`), dropping the target for
    ANY scheme — this is what the counter (extractProse-only, no stripMarkdown) was
    missing for relative targets; readability already dropped them via stripMarkdown.
  - GFM pipeless tables: a delimiter row (`:?-+:?` cells, ≥1 internal pipe, outer
    pipes optional) now marks a table; the delimiter, the header line directly above
    it and the contiguous piped body rows below it are dropped. A `---` horizontal
    rule (no pipe) is NOT treated as a table.
- **Must-FAIL (real):** `verify-bug-192` section [8] — tilde/pipeless/relative cases
  count full words on HEAD readability, excluded on round-3. Confirmed by swapping
  HEAD readability.mjs in: all three FAIL before, PASS after.
- **Readability regression sweep over REAL replies (mandated):** graded 3930 unique
  main-thread assistant replies from 1447 real transcripts under `~/.claude/projects`,
  BEFORE (HEAD readability.mjs) vs AFTER. **Verdicts changed: 0. ALLOW→BLOCK
  regressions: 0.** Only 4 replies had any `extractProse` output change (these
  constructs are rare in practice — tilde 0, pipeless-table 0, relative-link 1 across
  the sample — consistent with the low-severity rating). Synthetic worst-case for the
  one risky direction (removing comma-free table rows raises clauseDensity): the reply
  shrinks below the 40-word floor → `tooShort` → ALLOW, so it cannot flip to BLOCK.
- **Verified (counts):** `verify-bug-192` 15/0; `verify-feat-085-readability` 16/0
  (enforce-block harness now replays last_assistant_message — a round-2 blockSafe
  fidelity fix I had not re-run in round 2); `verify-feat-137-138` 12/0;
  `verify-feat-150` 11/0; `verify-feat-085-stop-hook` 61/61; `verify-bug-118` 110/1
  (pre-existing C1); `verify-feat-091` 278/0; `verify-feat-084` 37/0;
  `verify-bug-177-hook-errors` 18/18; `verify-feat-085-adversarial` only G5
  (pre-existing). Gate → PASS (exit 0).
- **Deployment:** the hook is unchanged this round (round-2 copy already deployed,
  reported identical). `readability.mjs` is a never-clobbered METHOD_FILE, so — like
  `format-metrics.mjs` — the extractProse fix reaches a deployed project only on
  re-onboard or manual copy. Both are advisory-only in production (readability blocks
  only under ORCHARD_STOP_HOOK_ENFORCE, set in no launch path; length is advisory),
  so the stale copy is cosmetic. Same gap already flagged; closing it (widen the
  resync set to the method closure) remains an orchestrator call.
- **Files:** scripts/lib/readability.mjs; scripts/verify-bug-192-*.mjs;
  scripts/verify-feat-085-readability.mjs. No git commands run; work left unstaged.
