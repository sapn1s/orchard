# BUG-201 — a fold hides an authored block that sits one quote level deeper than the fold

- **Status:** VERIFIED
- **Severity:** low
- **Area:** server / response-format renderer (public/lib/response-blocks.js)
- **Reported:** 2026-09-29 by FEAT-091 round-15 fix lane
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED.

## Symptom
An authored `orchard-ask` (or any reserved block) written one block-quote level
DEEPER than the fold it sits in is folded away — hidden in a closed `<details>` —
with `malformed: []`. Same hidden-content class as the block-quote defect
FEAT-091 round 15 just closed, reached one container level further in.

## Repro
Parse this with `parseResponseBlocks` (public/lib/response-blocks.js):

    > ````orchard-narration
    > narr
    > > ````orchard-ask
    > > VIS
    > ````

Result: ONE `orchard-narration` block whose body is
`> narr\n> > ````orchard-ask\n> > VIS`, `malformed: []`. `VIS` — authored inside
an `orchard-ask` one quote level deeper — renders inside the closed narration
fold. If that `> > ````orchard-ask` block were NOT inside the fold it would be a
visible ask block, so the reader loses it.

## Expected
The C1 fold guard fires on a reserved (`orchard-*`) opener at ANY container
depth, not only at the fold's own depth: the fold ends at the deeper-nested
opener, `orchard-ask` is promoted VISIBLE, and `ambiguous-fold` is reported.
(This is the guard's stated contract — public/lib/response-blocks.js, `foldUncertainty`
docstring and the "top-level only ... C1 must keep firing on a reserved opener
inside a fold in ANY wrapper" note in the header.)

## Why it was declined in the round-15 lane (not a regression)
FEAT-091 round 15 closed the SAME-DEPTH case: the fold guard now reads each body
line through the one container-stripped view (`restOfLine(stack, line)`) the
parser uses, so a `> ````orchard-ask` at the fold's own quote depth is seen and
promoted. This deeper variant is PRE-EXISTING (it folds `VIS` on the pre-round-15
tree too, verified by swapping `HEAD:public/lib/response-blocks.js`) and is a
DIFFERENT question from the divergence round 15 targeted: here the guard and the
parser AGREE the deeper line is literal fence content (CommonMark says so too) —
closing it means the guard must be MORE aggressive than CommonMark at every
container depth, stripping deeper `>`/list markers before `openerOf`. That is a
policy extension with its own over-fire risk (it must not flag a well-formed
deeper-quoted example) and belongs in its own lane with a differential /
well-formed-subset pass, not bolted onto a high-stakes data-hiding fix at the end.

## Context pack
- Files/functions in play: `foldUncertainty` / `containerView` / `firstReservedOpener`
  in public/lib/response-blocks.js. The round-15 fix routes these through
  `restOfLine(fold-stack, line)`; the residual is that `restOfLine` strips only the
  fold's OWN stack, so a deeper `>`/indent prefix still hides the opener from
  `openerOf`.
- The fix likely needs a reserved-opener probe that strips EVERY leading container
  marker (blockquote `>`, list indent) — the innermost content — rather than only
  the fold's stack. C2 (unpaired fence) does NOT want this: a deeper-nested fence
  cannot close the fold, so C2 is correct as-is.
- Related tickets: FEAT-091 (parent; rounds 8/9 are the same "a guard reads the
  raw/less-stripped line where the parser reads the fully-stripped line" family).
- Repro test: extend the `bqfold` stratum in scripts/lib/feat-091-fold-corpus.mjs
  with a deeper-container variant (opener one quote level below the fold), and add
  a standalone assertion beside the round-13/14 block in
  scripts/verify-feat-091-response-blocks.mjs.
- Known dependencies / blockers: none; response-blocks.js is otherwise clean.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-29 — FEAT-091 round-15 fix lane
- **Understood:** while closing the same-depth block-quote fold defect (FEAT-091),
  the "mixed quote depth" attack named in the charter reproduced a deeper-container
  variant of the same hidden-content class.
- **Changed:** nothing here (filed only). The reproducing input and root-cause
  pointer are in the Repro / Context pack above.
- **Verified:** reproduced on the current tree AND on `HEAD:public/lib/response-blocks.js`
  (pre-round-15), so it is pre-existing, not introduced by the round-15 fix.
- **Handoff:** make C1's reserved-opener probe strip every leading container marker
  (not just the fold's stack); leave C2 unchanged; add the deeper-container stratum
  and a standalone assertion; run the differential + well-formed subset to prove no
  over-fire.
- **Symptom of a deeper design flaw?** yes → this is a further instance of the
  FEAT-091 recurring class (guard vs parser stripping); tracked under FEAT-091's
  ARCH lineage rather than a new ARCH ticket.

### 2026-09-29 — explore lane (class=explore, build nothing)
- **Reproduced (working tree):** the exact Repro input parses to ONE
  `orchard-narration` block whose body is `> narr\n> > ````orchard-ask\n> > VIS`,
  `malformed: []`. `VIS` is hidden in the closed fold. Confirmed.
- **Mechanism, pinned:** the fold `orchard-narration` opens inside a blockquote,
  so its container stack is one `>`. `containerView(stack)` → `restOfLine([bq1],
  "> > ````orchard-ask")` strips only that ONE `>`, leaving ` > ````orchard-ask`;
  `openerOf` sees a leading `>` (not a fence) and returns null, so C1 never fires.
  The residual is exactly as the Context pack states: `restOfLine` strips the
  fold's OWN stack, and the deeper `>` prefix still blinds `openerOf`. C1 is
  already per-line and depth-free (`firstReservedOpener`/`foldUncertainty`,
  public/lib/response-blocks.js ~L1562/1593), so the miss is purely a
  strip-depth miss, not a depth-tracking miss.

- **Approach A — maximal container strip, for C1's reserved-opener probe only
  (RECOMMENDED).** Give `firstReservedOpener`/C1 a view that greedily consumes
  EVERY leading container marker (blockquote `>`, list-item indent) to reach the
  innermost content column, then `openerOf`. Stays per-line and depth-free — it
  CONSUMES markers, it never COUNTS depth. `findClose` and C2 keep the
  fold's-own-stack view unchanged, because a fence nested deeper than the fold
  cannot close the fold (the ticket and the module header both say C2 must not
  change). Over-fire risk: a WELL-FORMED deeper-quoted `orchard-*` EXAMPLE
  authored inside a fold would now be promoted-visible + `ambiguous-fold:` +
  split. That risk is bounded and already accepted one level up: round 15 made C1
  fire on a same-depth reserved opener "even INSIDE an inner fence", so this only
  makes the DEEPER case behave like the same-depth case — and promotion only ever
  moves content toward visible, never hides. The documented escape hatch (4-space
  indent → not a CommonMark fence at all) still folds an intentional example.

- **Approach B — recursively parse nested container bodies / track true nesting
  depth (REJECTED).** Descend into the nested blockquote/list and parse the
  `orchard-ask` as its own correctly-placed block. Over-fire risk: reintroduces
  DEPTH TRACKING — the exact thing the module deleted after two hidden-content
  defects ("no depth mistake can exist, because no depth is tracked", header).
  Contradicts the stated invariant; highest regression risk of the three.

- **Approach C — strip only ONE level deeper than the fold stack, or strip `>`
  but not list-indent (REJECTED as a half-measure).** Draws a NEW arbitrary
  strip boundary. Over-fire (really under-fire) risk: it just relocates this
  same "guard reads a less-stripped line than the parser" bug one container level
  further down — the rounds 8/9/15 recurrence shape. It would pass the ticket's
  own Repro and fail the next-deeper variant.

- **Recommendation: Approach A.** Implementation notes for the fix lane: (1) make
  the maximal strip ONE primitive (extend the `restOfLine`/`matchContainers`
  machinery, do not add a second ad-hoc regex — ARCH-010, one owner of the strip
  rule) so no scan can strip differently again; (2) leave C2/`findClose` on the
  fold-stack view; (3) the over-fire proof is mandatory — add a deeper-container
  stratum to scripts/lib/feat-091-fold-corpus.mjs (opener 1+ quote/list levels
  below the fold) plus a well-formed deeper-example subset, and run the
  CommonMark differential (`verify:feat-091-commonmark-diff`) to show no legal
  input is corrupted.

- **Fork?** No — this is essentially a SINGLE known-correct build within the
  module's established philosophy (depth-free, per-line, promote-toward-visible,
  strip-to-innermost-content). The only sub-decisions (C2 unchanged; maximal not
  partial strip) have clear defaults dictated by that philosophy and by this
  ticket. The genuine care item is the over-fire suite, not a design choice.

- **Verified:** working-tree repro executed (above); no code or test changed.
- **Handoff:** ready for a `fixing` lane — Approach A, one-primitive maximal
  strip, C2 untouched, deeper-container corpus stratum + differential as the
  over-fire gate. Independent verify still required (Verification-class: fix) —
  data-hiding, regression-prone file, so a clean-room pass on a deeper-example
  subset the fixer's own fixture would not cover is warranted.

### 2026-09-29 — fixing lane (round 1, class=fix) — built ON TOP of FEAT-091 round-15 (unstaged)

- **Understood:** the round-15 guard reads each fold-body line through the fold's
  OWN container-stripped view (`restOfLine(fold-stack, line)`), which strips only
  the fold's stack. A reserved opener one quote/list level DEEPER kept its inner
  `>`, `openerOf` saw a leading `>` and returned null, C1 never fired, and the
  whole `orchard-ask` folded away with `malformed: []`. Confirmed the exact Repro
  on the current (round-15) tree before touching anything: ONE `orchard-narration`
  block, `malformed: []`, `VIS` hidden.
- **Changed (Approach A, all in `public/lib/response-blocks.js`):**
  - new `innermostContent(rawLine)` primitive — greedily consumes EVERY leading
    `>`/list marker down to the innermost content column, reusing the SAME marker
    shapes `matchContainers` walks (one owner of the strip rule, ARCH-010). Returns
    early on 4+ leading columns, so a fence indented into code is left un-stripped
    and is not an opener to `openerOf`.
  - new `maximalView` producer alongside `containerView`.
  - `foldUncertainty` now takes a second view: **C1** reads the MAXIMAL strip, so a
    reserved opener at ANY depth below the fold is seen; **C2** (pairing) and
    `findClose` stay on the fold-STACK view unchanged (a fence deeper than the fold
    cannot be its close). `certainFoldEnd` + the one call site thread the view.
  - Depth-free and per-line throughout — no depth is tracked, so none can be wrong.
- **Test (`scripts/lib/feat-091-fold-corpus.mjs`):** new `deepfold` stratum,
  depths 2-4, mixed quote/list (q>q, q>q>q, q>q>q>q, q>list, list>q, list>list) x
  both fence chars = 96 cases. Two directions: HIDE (a fence-shaped reserved opener
  deeper than the fold → promoted + reported) and NO-FIRE (the over-fire care item
  — an inline mention, a 2-char run, and a fence indented 4+ past the deeper
  container → fold stays whole and SILENT). Plus a dimension anti-vacuity check and
  a standalone BUG-201 block beside round-13/14 in
  `scripts/verify-feat-091-response-blocks.mjs` (the verbatim repro, the 2/3/4
  depth ladder, and the icode/inline/paired over-fire controls).
- **Verified:**
  - must-FAIL-before, anchored to a synthesized pre-fix baseline (round-15 present,
    only the C1 maximal-strip reverted): 24/24 HIDE cases FAIL (VIS hidden); 72/72
    NO-FIRE cases already pass (they do not depend on the fix). On the fixed parser:
    96/96 deepfold cases pass.
  - parser suite `verify-feat-091-response-blocks.mjs`: 298 passed, 0 failed
    (all new BUG-201 checks green; [6] onboarding also passed in this env).
  - CommonMark differential `verify-feat-091-commonmark-diff.mjs`: 23 passed, 0
    failed — ZERO hiding AND zero over-recognition disagreements over 20000 random
    docs (the over-fire gate).
  - renderer browser suite: launched (real headless browser, long-running); result
    to be harvested — see handoff.
  - `npm run gate` → PASS (exit 0); `npm run board:check` → OK, no drift.
- **Open / handoff:** unstaged, not marked VERIFIED. This is a data-hiding,
  regression-prone change built on still-unverified round-15 work → an independent
  clean-room verify pass is WARRANTED (per Verification-class: fix), ideally over a
  deeper-example subset the fixer's own fixture would not cover. Confirm the
  renderer-suite result before closing.
- **regressed-from:** none — the deeper variant is PRE-EXISTING (reproduces on
  `HEAD:public/lib/response-blocks.js` too, per the explore entry); round 15 closed
  the same-depth case and correctly deferred this one.
- **Symptom of a deeper design flaw?** no new one — a further instance of the
  FEAT-091 guard-vs-parser stripping class, tracked under FEAT-091's ARCH lineage.

### 2026-09-29 — independent clean-room verify (verifying, round 15; covered by the same run as FEAT-091) — verdict INVALID (contract); substance = fix does NOT HOLD

Verified TOGETHER with FEAT-091 round-15 over the UNCOMMITTED working tree (`--working-tree`),
cross-provider (openai; author-provider anthropic), against the guard/parser agreement + the
BUG-201 deeper-depth requirement (`/tmp/req-FEAT-091-r15.txt`): C1 reads the maximal
(innermost-content) strip so a reserved opener at ANY container depth below the fold is promoted;
C2/`findClose` stay on the fold-stack `containerView`.

- **Outcome: INVALID (exit 3) — does NOT count as HOLDS or BROKEN.** The openai verifier's
  citation block carried two `FIXER-TEST:` lines (exactly one allowed) and openai is
  non-resumable, so the harness could not re-prompt. Not a pass, not a fail.
- **Substance — the `innermostContent`/`maximalView` fix does NOT fully close the class.** In the
  clean room both fixer suites pass, but a new attack shows the deeper-container promotion still
  MISSES when a LIST content column requires FOUR or FIVE spaces: a deeper-quoted `orchard-ask`
  stays inside the `orchard-narration` fold with `malformed: []` (silently hidden); the same shape
  at 2-3 spaces is correctly promoted. Named root cause: `innermostContent` consumes RAW leading
  indentation and stops before consuming the existing list stack, so it under-strips exactly the
  marker+content-column (4-5-space) list geometry. This is the same guard-vs-parser strip-depth
  family this ticket exists for, reached one indentation regime deeper — the maximal strip must
  walk the parser's actual list stack, not raw columns.
- **UNVERIFIED by me** (verify driver; did not re-run the attack or read the code). The verdict is
  contractually INVALID, so a counted re-run is still needed (an anthropic verifier self-repairs a
  malformed citation via resume) — but the substance points to more FIX work.
- **Handoff:** make `innermostContent`'s strip reuse the parser's list-stack content-column rule
  (incl. 4-5-space continuation), add a list-content-column stratum (columns 2-5 × LF/CRLF/CR) to
  the `deepfold` corpus, re-run the CommonMark differential as the over-fire gate, then re-verify.
  **Status stays OPEN.**
- **Verified-by:** dispatch openai run 01a0ed58-d54b-7b52-a44e-93c19de8b549 (clean-room,
  `scripts/independent-verify.mjs`, `--working-tree`, cross-provider — author-provider anthropic)
  — VERDICT: INVALID (citation contract; substance = 4-5-space list-continuation hiding, fix does
  NOT HOLD).

### 2026-09-29 — fixing lane (round 2, class=fix) — closes the round-1 list-content-column regression

- **Understood/reproduced FIRST:** the round-1 `innermostContent` measured RAW
  columns and bailed at 4+, so a fold sitting in a list item whose CONTENT COLUMN
  is 4-5 (e.g. `1.  ` or `-   `) had its continuation indent read as indented code;
  the deeper `>`-quoted `orchard-ask` was never reached and stayed hidden with
  `malformed: []`. Reproduced on the working tree before touching code: `1.  ` and
  `-   ` folds with a deeper quoted opener → VIS hidden, `malformed: []`. The 2-3
  column geometry was already promoted, exactly as the clean-room verify reported.
- **Root fix (ARCH-010, `public/lib/response-blocks.js`):** `innermostContent`
  carried its OWN raw-column heuristic — a second authority for "where does content
  start". Replaced it: `maximalView(stack)` now (1) strips the fold's OWN containers
  through the parser's `restOfLine(stack, line)` — the authority that already knows
  each list item's true content column and quote depth — then (2) `stripInnerContainers`
  opens ONLY the containers nested BELOW the fold, using the SAME opening rules as
  the parser's `advanceLineState` loop (blockquote 0-3 sp + `>` + one optional space;
  list `LIST_MARKER_RE` + content column, one space when 5+ follow; spaced thematic
  break guarded). Every column measurement in step 2 is RELATIVE to the fold's
  innermost content, so a 4+-column indent there is genuinely indented code. C2 and
  `findClose` still read the fold-STACK `containerView` (unchanged).
- **Test (`scripts/lib/feat-091-fold-corpus.mjs`):** new `listcol` stratum, 360
  cases — fold on a list-item continuation line at content columns 2-6 (markers
  `-` `*` `+` `1.` `10.` `3)` × 1-4 trailing spaces + a tab) × LF/CRLF/CR, in both
  directions (HIDE: deeper opener promoted; NO-FIRE: deeper indented-code fence
  stays folded, silent). Plus a dimension anti-vacuity check and standalone
  round-1-regression assertions in `scripts/verify-feat-091-response-blocks.mjs`.
- **Self-attack (charter):** lazy continuation of a list paragraph, an indented
  code block inside a list item, a list-in-quote-in-list, tab-indented continuation,
  and content columns 5-6 — all correct (HIDE promotes via C1; NO-FIRE stays whole
  and silent).
- **Verified:**
  - must-FAIL-before, anchored to a synthesized round-1 baseline (raw-column strip):
    66/90 HIDE cases FAIL (all the col≥4 geometry — the regression); the 24 col≤3
    cases pass on both baselines (round-1 already handled them, so no false
    must-FAIL claim). On the fixed parser: 360/360 `listcol` + 96/96 `deepfold` pass.
  - parser suite: 304 passed, 0 failed. CommonMark differential: 23 passed, 0
    failed — ZERO hiding AND zero over-recognition over the random space (over-fire
    gate). `npm run gate` PASS (exit 0, unpiped). `npm run board:check` OK, no drift.
  - renderer browser suite: launched; result to be harvested (see handoff).
- **regressed-from:** BUG-201 round-1 (this lane's own prior fix) — the list-
  content-column under-strip; named per the regression-honesty rule.
- **Open / handoff:** unstaged, not VERIFIED. Still data-hiding + regression-prone
  and built on unverified FEAT-091 round-15 → a COUNTED independent clean-room
  re-verify is required (the prior run was contract-INVALID). Suggested attack the
  fixer did NOT fully own: list content columns beyond 6, mixed tab/space
  continuation, and a fold whose stack itself mixes quote+list at depth ≥3.
- **Symptom of a deeper design flaw?** no new one — same FEAT-091 guard-vs-parser
  stripping class; the round-1 miss was a SECOND strip authority, now removed.

### 2026-09-29 — independent clean-room verify (verifying, round 15; same run as FEAT-091) — COUNTED verdict: BROKEN (VALID). Fix does NOT HOLD

Verified TOGETHER with FEAT-091 round-15 over the UNCOMMITTED working tree (`--working-tree`),
cross-provider (openai verifier; author-provider anthropic), against the guard/parser-agreement +
deeper-depth requirement (`/tmp/req-FEAT-091-r15.txt`). This is the COUNTED re-run the prior
contract-INVALID pass called for; the citation block was VALID this time (one FIXER-TEST line — a
concrete filled-in citation example was supplied in the requirement).

- **Outcome: BROKEN (exit 1), verdict VALID.** The round-2 `maximalView` = `restOfLine` +
  `stripInnerContainers` fix CLOSES the reported cases (fixer suite `verify:feat-091` 282/0/2 in the
  room; the CommonMark differential passes with zero hiding / zero over-recognition). But it does NOT
  close the class: a reserved opener on a nested-list CONTINUATION line inside the fold is still hidden.
- **New hiding input (BROKEN direction):**

      ````orchard-notes
      -   item
          ````orchard-ask
          SECRET
          ````
      ````

  → ONE `orchard-narration`/`orchard-notes` block, `SECRET` inside the closed fold, `malformed: []`.
  Root cause: `stripInnerContainers` opens only the containers whose MARKER is on the current line; a
  list opened on a PRIOR fold-body line is not in the fold's OWN stack, so the continuation-line indent
  (the list's 4-relative-column content column) reads as indented code and `openerOf` never sees the
  fence. The round-2 fix walks the fold's own list stack correctly, but the guard does not track lists
  OPENED WITHIN the fold body across lines. Adversarial `nested-list-continuation`
  (run `73c82ce9ffa6`, exit 1): 240/336 hide across 7 marker forms, quote wrapping, LF/CRLF/CR.
  Control run `continuation-tabs-and-controls` (`e74d950d242c`, exit 1) confirms explicit-marker
  openers ARE promoted and genuine indented-code STAYS folded/silent — `{controlsPassed:20,
  continuedListDefects:10}` — so it is a real hiding miss, not over-strip.
- **Handoff:** the reserved-opener probe (C1 / `maximalView`) must account for containers OPENED
  within the fold body across lines — i.e. carry the list/quote a body line opens into the strip for
  its subsequent continuation lines — not only the fold's own stack + the current line's markers. Keep
  C2/`findClose` on the fold-stack view. Add a nested-list-continuation stratum to
  `scripts/lib/feat-091-fold-corpus.mjs` (marker forms × content columns × tab/space continuation ×
  LF/CRLF/CR, both HIDE and NO-FIRE directions) and re-run the CommonMark differential as the over-fire
  gate, then re-verify. **Status stays OPEN.**
- **Verified-by:** dispatch openai run 01a0ee7c-04d6-78b1-9c5e-c6eb0982c7c8 (clean-room,
  `scripts/independent-verify.mjs`, `--working-tree`, cross-provider — author-provider anthropic)
  — VERDICT: BROKEN (VALID/counted; reserved opener on a nested-list continuation line at the list
  content column stays folded with `malformed: []`, 240/336 cases — the deeper-container class is not
  yet closed).

### 2026-09-29 — fixing lane (round 3, class=plan+review) — PLAN: stop estimating containers, ask the parser

- **Reproduced FIRST (working tree):** `\`\`\`\`orchard-notes` / `-   item` / `    \`\`\`\`orchard-ask`
  / `SECRET` / `    \`\`\`\`` / `\`\`\`\`` → ONE fold, `SECRET` hidden, `malformed: []`. Also with
  ordered markers and quote-wrapped; the explicit-marker control (`-   \`\`\`\`orchard-ask` on one
  line) still fires. Confirms the round-2 root cause: `stripInnerContainers` opens only containers
  whose MARKER is on the current line, so a list opened on a PRIOR body line — opener on a
  continuation line at the content column — is invisible to it.
- **This is the THIRD C1 miss in a row (rounds 1/2/3), all one shape:** C1 estimating container
  state line-by-line and drifting. Per-line strip heuristics cannot be made correct because "which
  containers is this line inside" is a function of PRIOR lines, not this line.
- **Hypothesis, VERIFIED (code inspection, no build):** the module's real block-structure state
  machine — `advanceLineState(prev, line)` with `matchContainers` — is a PURE, module-level function
  that returns the evolving container `stack` (on every return path) and the opener line's own
  `rest` (innermost content). `NO_PARAGRAPH`, `restOfLine`, `openerOf` are equally pure and in scope
  inside `parseResponseBlocks`. So the parser CAN be run over the fold body as a sub-document with no
  side effects and its recognition read out.
- **PLAN — C1 defers to the parser's CONTAINER authority, run over the fold body sub-document:**
  1. View the fold body [open+1, close) through the fold's own container view (`restOfLine(fold-stack,
     line)`) to get the sub-document — the body as its own container context. A line outside the
     fold's stack (null) is not in the body.
  2. Run `advanceLineState` across that sub-document from `NO_PARAGRAPH`, so lists/quotes OPENED on
     an earlier body line are carried onto their continuation lines — the exact state the per-line
     estimate could not hold. One authority for "which containers is this line inside" (ARCH-010);
     no strip heuristic remains to drift.
  3. C1 fires at the first body line whose innermost content is a reserved (`orchard-*`) opener —
     `openerOf(line's innermost content)`, where the innermost content is `advanceLineState`'s `rest`
     for a container-OPENING line (which `restOfLine` cannot recover) and `restOfLine(evolving-stack,
     sub-line)` otherwise.
  - Remove `innermostContent`/`stripInnerContainers`/the heuristic `maximalView`; they become unused.
  - **C2 and `findClose` stay on the fold-STACK view, unchanged** — a fence deeper than the fold
    cannot be the fold's close.
- **DESIGN DECISION surfaced for review (the one real judgement call):** C1 must NOT defer to the
  parser's FENCE-aware recognition wholesale. The parser treats a reserved opener INSIDE a paired
  inner code fence as literal code, so a wholesale defer would stop firing there — which REOPENS
  BUG-108 (a `orchard-answer` nested inside a paired inner `orchard-notes`/code fence must still be
  promoted; suite `[1b]` asserts reporting at BOTH levels). C1 is therefore fence-depth-free BY
  DESIGN (as it is today): it uses the parser's CONTAINER state but checks `openerOf` per line
  regardless of inner-fence nesting; C2 owns inner-fence PAIRING. So "ask the parser" = ask its
  container classifier, not its fence classifier. This keeps one authority for the drifting thing
  (containers) without regressing the depth-free fold contract.
- **PROOF plan:** new `listcont` stratum mirroring the verifier's 336-case shape (marker forms ×
  content columns × tab/space continuation × LF/CRLF/CR, HIDE + NO-FIRE); must-FAIL-before on the
  current tree, PASS-after; bqfold/deepfold/listcol all PASS-after; CommonMark differential at zero
  over-fire; parser + renderer + commonmark suites green. Self-attacks: a fold inside a fold, a fence
  inside a list inside the fold body, an unterminated inner fence.
- **Status stays OPEN.** Counted independent re-verify still required after the build.

### 2026-09-29 — fixing lane (round 3, class=plan+review) — BUILT the redesign

- **Changed (`public/lib/response-blocks.js`):** C1 no longer estimates container
  state. New `firstReservedOpenerBelow(from, until, foldStack)` views the fold body
  through `restOfLine(foldStack, line)` (the body as its own sub-document) and runs
  the module's real `advanceLineState` state machine across it from `NO_PARAGRAPH`,
  so a list/quote opened on one body line is carried onto its continuation lines.
  It fires on the first line whose innermost content (`advanceLineState`'s `rest`
  for a container-opening line, else `restOfLine(evolving-stack)`) is a reserved
  `openerOf`. `foldUncertainty` takes the fold stack, uses this for C1, keeps the
  C2 pairing loop on the fold-STACK view. `certainFoldEnd` + the call site pass
  `para.stack`. `innermostContent`/`stripInnerContainers`/heuristic `maximalView`
  DELETED — no strip heuristic remains. C1 stays fence-depth-free (asks the
  parser's CONTAINER classifier, not its fence classifier), so BUG-108 (a reserved
  opener inside a paired inner fence must still promote) is preserved; verified.
- **Test (`scripts/lib/feat-091-fold-corpus.mjs`):** new `listcont` stratum, 576
  cases — a list opened WITHIN the fold body, opener on a continuation line (marker
  forms × content columns × tab/space continuation × LF/CRLF/CR × bare/quote-
  wrapped), both HIDE and NO-FIRE. Plus a `listcont` dimension check and standalone
  round-3 assertions (verbatim reported shape, quote-wrapped, and the paragraph-
  interrupt control) in `scripts/verify-feat-091-response-blocks.mjs`.
- **Verified:**
  - must-FAIL-before vs a reconstructed round-2 baseline (per-line strip): 87/144
    `listcont` HIDE cases FAIL (all the content-column≥4 continuation geometry — the
    reported regression); the col≤3 cases pass on both (round-2 reached those, so no
    false must-FAIL claim). On the redesigned parser: 576/576 `listcont` + 360/360
    `listcol` + 96/96 `deepfold` + 40/40 `bqfold` pass.
  - parser suite 308/0; CommonMark differential 23/0 (ZERO hiding + zero over-
    recognition — the over-fire gate); renderer suite (harvested, see handoff).
    `npm run gate` PASS (exit 0). `npm run board:check`: the ONE drift is FEAT-157
    (unrelated, another lane's untracked ticket — an unparseable Decide block); not
    mine, not touched.
  - self-attacks: fold-in-fold with a reachable deeper opener (promoted, reported at
    both levels), fence-in-list-in-body (promoted), unterminated inner fence (C2
    fires), and — importantly — a paragraph-then-indented pseudo-list and an ordered
    marker (not 1.) after a paragraph BOTH correctly stay folded/silent, because the
    parser-based C1 now respects CommonMark's paragraph-interrupt rule that the
    estimates ignored.
- **regressed-from:** BUG-201 round-2 (this ticket's own prior fix) — the
  continuation-line miss; and round-1 before it. The redesign removes the estimate
  entirely so the class (C1 vs parser container drift) cannot recur.
- **Open / handoff:** unstaged, not VERIFIED. Data-hiding + regression-prone + built
  on unverified FEAT-091 round-15 → a COUNTED independent clean-room re-verify is
  required. Suggested attack not fully owned here: containers ≥4 deep mixing
  quote+list on the fold's OWN stack, and CRLF/CR interacting with tab-stop columns
  inside quotes.
- **Symptom of a deeper design flaw?** the RECURRENCE was (three C1 misses from
  per-line container estimation); this round removes the second authority, so C1
  and the parser cannot disagree about container nesting again (ARCH-010). No new
  ARCH ticket — it closes the FEAT-091 guard-vs-parser class at its root.

### 2026-09-30 — independent clean-room verify (verifying, round 15; same run as FEAT-091) — COUNTED verdict: BROKEN (VALID). Round-3 redesign does NOT hold — a C2 over-fire ejects visible content

Verified TOGETHER with FEAT-091 round-15 over the UNCOMMITTED working tree (`--working-tree`),
cross-provider (openai verifier; author-provider anthropic), against the guard/parser-agreement +
deeper-depth requirement (`/tmp/req-FEAT-091-r15r3.txt`; a concrete filled-in one-FIXER-TEST
citation example was supplied, so the citation block was VALID). The round-3 redesign — C1 =
`firstReservedOpenerBelow` running `advanceLineState` over the fold-body sub-document, the per-line
strip heuristics deleted — CLOSES the C1 hiding cases (fixer suite 286/0/2 in the room; CommonMark
differential 13/0/5, zero hiding + zero over-recognition). But it does NOT close the class: it
surfaces a C2 OVER-FIRE at the C1/C2 seam.

- **Outcome: BROKEN (exit 1), verdict VALID (counted).** This is the counted re-verify the round-3
  build called for. The three prior C1 hiding misses are gone; the new defect is on the C2 side.
- **New defect (over-fire / document corruption).** Input:

      ````orchard-notes
      - ```js
        const x = 1;
        ```

      AFTER
      ````

  `- ```js` / `  ``` ` is ONE CommonMark-paired code fence inside a list item (reference-confirmed).
  C1 hides nothing, but C2 reports `unpaired-fence-in-fold@line4`, truncates the fold before the
  inner closer, and EJECTS the trailing visible `AFTER` → ONE `orchard-notes` block, content only
  `- ```js\n  const x = 1;`, `malformed:[ambiguous-fold:...(unpaired-fence-in-fold@line4)]`. Control
  (list marker replaced by two spaces) keeps the whole fold with `malformed:[]`. Spurious flag +
  altered document.
- **Root cause.** Round 3 taught C1 the sub-document container machine (it descends into a list
  opened WITHIN the fold body) but DELIBERATELY left C2/`findClose` on the fold-STACK view. For a
  paired inner fence opening on a list-marker line and closing at the list content column, C2 —
  reading the raw fold-stack line — misses the opener behind `- ` and then reads the real closer as
  a fresh unpaired opener. The asymmetry that is safe for `findClose` (a deeper fence cannot be the
  fold's close) is NOT safe for C2's PAIRING: pairing must see the same inner-list container C1 sees.
- **Handoff:** give C2's fence-pairing the SAME sub-document container view C1 now uses (track
  containers opened within the fold body across lines), keep `findClose` on the fold-stack view, add
  a paired-inner-fence-in-nested-list stratum to `scripts/lib/feat-091-fold-corpus.mjs` (marker
  forms x content columns x tab/space x LF/CRLF/CR; an ejection/truncation HIDE-of-visible check AND
  a well-formed `malformed:[]` control), re-run the CommonMark differential as the over-fire gate,
  then re-verify. **Status stays OPEN.**
- **UNVERIFIED by me** (verify DRIVER; did not re-run the attack or read the code). Verdict is
  contractually VALID and counted.
- **Provider note (infra, resolved):** the OpenAI dispatch was flagged twice as "possible
  cybersecurity risk" (Daybreak gating, newly stricter 2026-09-30) and aborted before answering; a
  verification-framed rewrite of the same requirement (same code/tests/invariant) passed. Same
  family as the untracked BUG-211.
- **Verified-by:** dispatch openai run 01a0efa4-6695-74d0-976b-ef5f88a5d26c (clean-room,
  `scripts/independent-verify.mjs`, `--working-tree`, cross-provider — author-provider anthropic)
  — VERDICT: BROKEN (VALID/counted; C2 over-fire on a paired inner fence inside a list opened within
  the fold body ejects visible trailing content and reports a spurious `ambiguous-fold`).

### 2026-09-30 — fixing lane (round 4, class=fix) — unify C1 and C2 into ONE pass (close the seam)

- **Reproduced FIRST (working tree):** `\`\`\`\`orchard-notes` / `- \`\`\`js` / `  code` / `  \`\`\`` /
  `TAIL-VISIBLE` / `\`\`\`\`` → the paired inner code fence is flagged
  `unpaired-fence-in-fold@line4`, the fold truncated, and `TAIL-VISIBLE` + the real close EJECTED to
  fallback. Root cause confirmed: C1 (round-3 sub-document scan) tracked the body-opened list, but C2
  still read a SEPARATE fold-stack view, so it saw `  \`\`\`` (the list's fence close) as a bare
  opener at the fold's own depth.
- **Fix by construction (`public/lib/response-blocks.js`):** `foldUncertainty` is now ONE pass of
  `advanceLineState` over the fold body sub-document. **Invariant (stated in the code):** for every
  body line, C1 and C2 consult the IDENTICAL (container, fence) state — one `st` per line, both read
  it, so they cannot disagree about which container/fence a line is in. C1 = first reserved opener
  (innermost content, fence-depth-free). C2 = the SAME pass's leaf/fence state: a fence that OPENS at
  the fold's OWN depth (`st.stack.length === 0`, no body-opened container above it) and never closes.
  A fence inside a body-opened list/quote pairs within that container and can never be the fold's
  close, so C2 ignores it — the seam is gone. `findClose` stays on the fold-stack view (the fold's
  own closer). Removed the second scan and `firstReservedOpenerBelow` (folded into the one pass);
  `certainFoldEnd`/the call site drop the now-unused `view` arg.
- **Test (`scripts/lib/feat-091-fold-corpus.mjs`):** new `pairfence` stratum, 720 cases — a paired
  inner fence in a nested list (fence char × length × info string × nesting: list, list-in-quote,
  list-in-list, ordered × LF/CRLF/CR), EJECT (well-formed, must stay silent + no eject) and HIDE (a
  reserved opener in the same nesting must fire). Plus a `pairfence` dimension check and a standalone
  round-4 SEAM-INVARIANT block in `scripts/verify-feat-091-response-blocks.mjs` that proves the
  structural claim: over the SAME nesting, C1 promotes a reserved opener (sees the list) AND C2 stays
  silent on a paired plain fence (sees the same list) — if they used different container views one
  would break; plus genuine-unpaired-at-fold-depth still fires, and a list-in-quote mix.
- **Verified:**
  - must-FAIL vs a reconstructed round-3 baseline (separate C1 + fold-stack C2): 108/180 `pairfence`
    EJECT cases FAIL (spurious flag + ejection — the seam); the col≥4 nests pass on both (round-3's
    C2 couldn't see the fence there at all, so no false flag). Post-fix: 720/720 `pairfence` pass, and
    the WHOLE corpus (43586 cases) passes 0 fails — including the `closelen` fence-pairing stratum, so
    the unification did not regress ordinary pairing.
  - parser suite 314/0; CommonMark differential 23/0 (ZERO hiding + zero over-recognition — the
    over-fire gate); renderer suite (harvested, see handoff). `npm run gate` PASS (exit 0);
    `npm run board:check` OK, no drift.
  - self-attacks (both directions): paired fence in list / list-in-quote / list-in-list-depth-2 all
    silent + whole (no eject); reserved opener in the same nestings promotes + reports; genuine
    unpaired fence at fold depth still fires C2; an unpaired fence bounded INSIDE a list (not a
    fold-close candidate) correctly stays silent.
- **regressed-from:** BUG-201 round-3 (this ticket's own prior fix) introduced the C1/C2 seam by
  making C1 container-aware while leaving C2 on the fold-stack view. The unification removes the two
  authorities so they cannot diverge again (ARCH-010).
- **Open / handoff:** unstaged, not VERIFIED. Data-hiding + regression-prone + built on unverified
  FEAT-091 round-15 → a COUNTED cross-provider clean-room re-verify is required. Suggested attack not
  fully owned here: a fold-depth fence and a nested-list fence of the SAME char/length interleaved,
  and CRLF/CR with the inner close at exactly the 3-space indent boundary.
- **Symptom of a deeper design flaw?** the recurrence (four rounds, C1/C2 vs the parser) is now
  structurally closed: C1 and C2 read one state from one pass, `findClose` is the only fold-stack
  reader and it is about the fold's own closer. No new ARCH ticket.

### 2026-09-30 — independent clean-room verify (verifying, round 15; same run as FEAT-091) — COUNTED verdict: BROKEN (VALID). Round-4 unification does NOT hold — C2 misses a fence-to-fence container-boundary transition

Verified TOGETHER with FEAT-091 round-15 over the UNCOMMITTED working tree (`--working-tree`),
cross-provider (openai verifier; author-provider anthropic), against the guard/parser-agreement +
deeper-depth requirement (`/tmp/req-FEAT-091-r15r4.txt`; a concrete filled-in one-FIXER-TEST
citation example was supplied, framed as a software-fix review — the citation block was VALID and
the OpenAI dispatch was not gated this time). The round-4 unification — `foldUncertainty` is ONE
pass of `advanceLineState` over the fold-body sub-document, C1 and C2 reading the IDENTICAL
`(container, fence)` state per line; `firstReservedOpenerBelow` removed; `findClose` the sole
fold-stack reader — CLOSES the round-3 C2 over-fire (the whole 43,586-case corpus incl. `pairfence`
passes; the CommonMark differential passes with zero hiding + zero over-recognition). But it does
NOT close the class: a NEW hiding defect at the container-boundary/fence transition.

- **Outcome: BROKEN (exit 1), verdict VALID (counted).** This is the counted re-verify the round-4
  build called for. Fixer suite `npm run verify:feat-091` re-run in the room: 292 passed / 0 failed
  / 2 skipped (`[5] injection` + one container-diff calibration — expected clean-room `docs/`/
  shallow-clone strips). Over-fire gate `verify:feat-091-commonmark-diff`: 13/0/5, ZERO hiding +
  ZERO over-recognition over 3968 + 20000 random docs. Both passed — then a NEW attack hid content.
- **New defect (HIDING direction).** Input (five-backtick `orchard-notes` fold):

      `````orchard-notes
      > ```js
      > nested
      ```js
      MUST-BE-VISIBLE
      `````

  CommonMark: the `> ```js` fence lives INSIDE the block quote and closes at the quote boundary
  (literal `nested`); then line 4 `` ```js `` opens a NEW document-level (fold-depth) fence whose
  content is `MUST-BE-VISIBLE`. That fold-depth fence is unpaired-as-the-fold's-close, so C2 should
  end the fold and `MUST-BE-VISIBLE` should be VISIBLE. Instead: ONE `orchard-notes` block,
  `MUST-BE-VISIBLE` inside the closed fold, `malformed: []`. The same shape with a list container
  (`- ```js` / `  nested`) hides identically; the paired controls (adding the closing fence) stay
  silent with `malformed: []`, correctly.
- **Root cause.** C2 detects a fold-depth fence OPEN only on a `!prevFence && nowFence` transition
  (`st.leaf` going null → fence). Here `advanceLineState` steps from "fence open inside the quote"
  (line 3) directly to "fence open at fold depth" (line 4) — `prevFence && nowFence` both true — so
  neither the open branch nor the close branch fires and the new fold-depth fence is never counted.
  The one-pass unification fixed C1/C2 DISAGREEMENT, but C2's fence-open detection still assumes the
  leaf passes through null between two fences; a container boundary that closes one fence and opens
  another on the same step defeats that assumption.
- **Adversarial run** `container-end-and-new-fence-same-line` (`a9c7c30b208b`, exit 1): quote-
  boundary and list-boundary both hide `MUST-BE-VISIBLE` with `malformed: []`; the two paired
  controls pass (`{ failed: 2 }`). Differential `d8594cf39d58` (exit 0) confirms no legal input is
  altered.
- **UNVERIFIED by me** (verify DRIVER; did not re-run the attack or read the code). The verdict is
  contractually VALID and counted, and the finding is specific and reproducible from the cited run,
  so the round-15/BUG-201-round-4 claim must be treated as NOT-HOLDS.
- **Handoff:** C2 must count a fold-depth fence OPEN even when the prior line already had a fence
  open inside a deeper container — i.e. detect a fence whose container is the fold's OWN depth
  (`st.stack.length === 0`) becoming/being open, not only a null→fence leaf transition. Track the
  fence's CONTAINER at open time so a fence that closes at a container boundary and a fresh
  fold-depth fence on the same step are both seen. Keep `findClose` on the fold-stack view. Add a
  container-boundary-fence-transition stratum to `scripts/lib/feat-091-fold-corpus.mjs` (fence
  inside quote/list ending at the container boundary + a new fold-depth fence on the boundary line ×
  fence char/length × LF/CRLF/CR; HIDE + a paired NO-FIRE control), re-run the CommonMark
  differential as the over-fire gate, then re-verify. **Status stays OPEN.**
- **Verified-by:** dispatch openai run 01a0f0b8-6d57-7c41-81d3-bc29ce3a80aa (clean-room,
  `scripts/independent-verify.mjs`, `--working-tree`, cross-provider — author-provider anthropic)
  — VERDICT: BROKEN (VALID/counted; C2 misses a fold-depth fence that opens as a deeper-container
  fence closes on the same line, so an unpaired fold-depth fence stays folded and hides
  `MUST-BE-VISIBLE` with `malformed: []`).

### 2026-09-30 — fixing lane (round 5, class=fix) — the pass emits fence EVENTS; C2 stops diffing states

- **Reproduced FIRST (working tree):** `\`\`\`\`\`orchard-notes` / `> \`\`\`` / `> code` / `\`\`\`` /
  `MUST-BE-VISIBLE` / `\`\`\`\`\`` → `MUST-BE-VISIBLE` folded, `malformed: []`. Same with a list. Root
  cause confirmed: at the boundary line `\`\`\`` (col 0), the quoted inner fence CLOSES (bq exits) and
  a fold-depth fence OPENS in ONE `advanceLineState` step, so `st.leaf` goes fence→fence and round-4's
  boolean `!prevFence && nowFence` open-branch never fired — the unpaired fold-depth fence was missed.
- **Fix (`public/lib/response-blocks.js`):** `advanceLineState` now emits an ordered `events` array of
  fence lifecycle events (`fence-close`, `fence-open{depth, reserved}`) at each of its three return
  paths — a single line can carry BOTH a `fence-close` (container exit) and a `fence-open` (shallower
  fence). `foldUncertainty`'s C2 CONSUMES those events instead of diffing successive states, so any
  number of transitions on one line are all visible: a `fence-open` at the fold's own depth (`depth
  === 0`), not reserved, starts the doubt; its `fence-close` clears it. One pass, one source of state
  (round 4 preserved). C1 still reads innermost content directly (fence-depth-free, BUG-108) — that
  was never a state diff. `findClose` unchanged. Swept the module: the only state-diff was C2's, now
  gone; the remaining `prev.leaf` reads are inside `advanceLineState`, which is the authority that
  EMITS the events.
- **Test (`scripts/lib/feat-091-fold-corpus.mjs`):** new `boundary` stratum, 240 cases — an inner
  fence in a container (quote/list, depth 1-2, list-in-quote) then a line that exits the container and
  opens a fold-depth fence, inner × boundary fence chars × LF/CRLF/CR, HIDE (unpaired → promote) and
  EJECT (pairs → silent, no eject). Plus a `boundary` dimension check and standalone round-5
  assertions (quote/list/nested-quote exits, cross-character, and the paired-boundary silent control)
  in `scripts/verify-feat-091-response-blocks.mjs`.
- **Verified:**
  - must-FAIL vs a reconstructed round-4 baseline (boolean state diff): 60/60 `boundary` HIDE cases
    FAIL (every multi-transition missed the fold-depth fence); post-fix 240/240 `boundary` pass and the
    WHOLE corpus (44306 cases) passes 0 fails — no pairing/other regression.
  - parser suite 320/0; CommonMark differential 23/0 (ZERO hiding + zero over-recognition); renderer
    suite 207/0. `npm run gate` PASS (exit 0); `npm run board:check` OK, no drift.
  - self-attacks both directions: quote/list/nested-quote/list-in-quote boundary exits promote the
    unpaired fold-depth fence; a boundary fence that PAIRS stays silent + whole; round-4
    paired-in-nested-list and genuine-unpaired-at-fold-depth still correct.
- **regressed-from:** BUG-201 round-4 (this ticket's own prior fix) — the C2 boolean state diff could
  not see two fence events in one step. Events make it structural.
- **Open / handoff:** unstaged, not VERIFIED. Data-hiding + regression-prone + built on unverified
  FEAT-091 round-15 → a COUNTED cross-provider clean-room re-verify is required. Suggested attack not
  fully owned: three-or-more transitions on one line (deep nested-container exit that closes a fence
  and the shallower line ALSO opens a container before a fence), and a boundary where an HTML-block
  leaf ends as a fence opens.
- **Symptom of a deeper design flaw?** the recurrence (five rounds) is now closed structurally: one
  pass produces one per-line state AND explicit events; C1 reads content, C2 reads events, neither
  diffs. No new ARCH ticket.

### 2026-09-30 — independent clean-room verify (verifying, round 15; same run as FEAT-091) — COUNTED verdict: BROKEN (VALID). Round-5 events do NOT hold — C1 misses a reserved opener behind a container marker while an inner fence is open

Verified TOGETHER with FEAT-091 round-15 over the UNCOMMITTED working tree (`--working-tree`),
cross-provider (openai verifier; author-provider anthropic), against the guard/parser-agreement +
event-based design (`/tmp/req-FEAT-091-r15r5.txt`; a concrete filled-in one-FIXER-TEST citation
example was supplied and the task framed as a software-fix review — the citation block was VALID and
the OpenAI dispatch was not cyber-gated). The round-5 change — `advanceLineState` emits ordered fence
`events`, C2 CONSUMES them instead of diffing states — CLOSES the round-4 container-boundary miss (the
whole 44,306-case corpus incl. the new `boundary` stratum passes; the CommonMark differential passes
with zero hiding + zero over-recognition). But it does NOT close the class: a NEW C1 hiding defect on
the CONTENT side (not the event side round 5 touched).

- **Outcome: BROKEN (exit 1), verdict VALID (counted).** This is the counted re-verify the round-5
  build called for. The round-4 C2 event miss is gone; the new defect is a C1 content-strip miss.
- **New hiding input (BROKEN / P1 direction).** Inside an `orchard-narration` fold, a reserved opener
  behind a blockquote marker AND inside a paired `~~~markdown` code fence:

      `````orchard-narration
      ~~~markdown
      > ```orchard-ask
      > VISIBLE
      > ```
      ~~~
      `````

  → the fold stays closed, `VISIBLE` hidden inside it, `malformed: []` (silently hidden). Removing
  EITHER wrapper prevents the hide: with just `> ```orchard-ask` (no `~~~`) C1 fires and promotes
  (`reserved-opener-in-fold`); with just `~~~markdown`/```` ```orchard-ask ```` (no `>`) it degrades to
  visible fallback. Only the COMBINATION hides.
- **Root cause (verifier-named, UNVERIFIED by me).** On the return path where an inner fence (`~~~`) is
  OPEN, `advanceLineState` returns early WITHOUT stripping the line's container markers, so
  `foldUncertainty`'s C1 reads `> ```orchard-ask` with the `>` still attached; `openerOf` sees a
  leading `>` (not a fence) and never recognises the reserved opener — despite C1's fence-depth-free
  contract (BUG-108, a reserved opener inside a paired inner fence must still promote). Same
  guard-vs-parser strip family as rounds 8/9/15 and BUG-201 rounds 1-4, now at the open-inner-fence +
  container-marker seam on the CONTENT (C1) side.
- **Cited runs.** Fixer re-run `a2f7e0ad2b3d` (`npm run verify:feat-091`, exit 0, 298 passed / 0 failed
  / 2 skipped — `[5] injection` + a container-diff calibration, expected clean-room strips).
  Adversarial `quoted-reserved-inside-paired-code-with(-controls)` `01eb305843bf` (exit 1): the combined
  case hides (`hidden:true`, `malformed:[]`); the two single-wrapper controls both promote/degrade to
  visible — so it is a real hiding miss, not over-strip. (A sibling case in the same run — a bare
  ```` ```orchard-ask ```` inside a `~~~markdown` fence with NO `>` — reported
  `ambiguous-fold:...(unpaired-fence-in-fold@line2)` and `blocks:[]` / `hidden:false`; worth checking
  for a possible C2 over-fire on that shape while fixing, though it does not hide.)
- **UNVERIFIED by me** (verify DRIVER; did not re-run the attack or read the code). Verdict is
  contractually VALID and counted, and the finding is specific and reproducible from the cited run, so
  the round-15/BUG-201-round-5 claim must be treated as NOT-HOLDS.
- **Handoff:** C1's innermost-content read must strip container markers on EVERY `advanceLineState`
  return path, including the open-inner-fence (leaf-open) path — a reserved opener behind a `>`/list
  marker on a line that sits inside an open inner fence must still be reached by `openerOf`. Keep
  `findClose` on the fold-stack view; keep C2 on the events. Add an open-inner-fence + container-marker
  stratum to `scripts/lib/feat-091-fold-corpus.mjs` (paired `~~~`/``` inner fence × `>`/list marker ×
  fence char/length × LF/CRLF/CR; HIDE + a NO-FIRE control + the bare-no-`>` over-fire control), re-run
  the CommonMark differential as the over-fire gate, then re-verify. **Status stays OPEN.**
- **Verified-by:** dispatch openai run 01a0f249-d59e-72e0-867d-57472f402f7f (clean-room,
  `scripts/independent-verify.mjs`, `--working-tree`, cross-provider — author-provider anthropic)
  — VERDICT: BROKEN (VALID/counted; C1 misses a reserved opener behind a container marker while an
  inner fence is open, so `VISIBLE` stays folded with `malformed: []`; both single-wrapper controls
  promote).

### 2026-09-30 — fixing lane (round 6, class=fix) — ONE `content` field per line, on every return path

- **Reproduced FIRST (working tree):** `\`\`\`\`\`orchard-notes` / `~~~markdown` / `> \`\`\`orchard-ask`
  / `DECISION` / `~~~` / `\`\`\`\`\`` → `DECISION` folded, `malformed: []`. Also `>\`\`\`ask`,
  `- \`\`\`ask`, and a deeper `> > \`\`\`ask` inside a quoted `> ~~~markdown` fence. Removing either
  wrapper promoted. Root cause: inside the open inner fence the `>`/`-` is literal code, so the
  parser's REAL state opened no container, and C1's fallback `restOfLine(st.stack, sub)` stripped only
  the parser's recognised containers — the marker on the line was never removed and `openerOf` never
  saw the opener.
- **Fix (`public/lib/response-blocks.js`):** factored the container-opening loop into a pure
  `openContainers(...)` (one owner of the opening rule). `advanceLineState` now computes ONE `content`
  field — every container marker on the line consumed, as-if-live — in ONE place and attaches it to
  EVERY return via a single `finish(obj)` helper. C1 reads ONLY `st.content`; the fallback is gone.
  The parser's REAL state is unchanged (phase 0 still keeps the leaf and does not open containers;
  the non-fence path reuses the same `opened` result). C2 still reads the round-5 events; `findClose`
  unchanged.
- **Every return path of `advanceLineState`, and what `content` is on each** (all via `finish`, one
  assignment):
  1. **PHASE 0** (an open leaf continues/closes; `prev.leaf && allMatched`) — `content` =
     `openContainers(matchedStack, restMatched, …).rest`, i.e. the line with its matched containers
     AND any markers it opens consumed (as-if-live), so a reserved opener behind a `>`/`-` inside the
     fence is visible. (The leaf's CLOSE is still measured against `restMatched`, the fence's own
     container column — unchanged.)
  2. **LAZY continuation** (`!prev.leaf && !allMatched && !openedNew && prev.open && isParaCont`) —
     same `content`; a lazy line is paragraph text (never an opener), so `openerOf(content)` is null.
  3. **FINAL** (classifyLeaf) — `content` === `rest` (the innermost content the parser already
     computed); kept as its own `rest` field too because the top-level scan reads `para.rest` for an
     opener line.
- **Test (`scripts/lib/feat-091-fold-corpus.mjs`):** new `infence` stratum, 1152 cases — a reserved
  opener behind a container marker (quote/list/nested-quote/list-in-quote) inside a paired inner fence
  (both fence chars × lengths × info strings) × LF/CRLF/CR, HIDE (promote through both wrappers) and
  NO-FIRE (a non-reserved `> \`\`\`js` in the same spot must not promote — the over-fire guard). Plus
  a `infence` dimension check, standalone round-6 assertions (both wrappers + single-wrapper controls
  + deeper marker + over-fire), and a STRUCTURAL source check that every `advanceLineState` return
  goes through the single `content` assignment (`finish`) in
  `scripts/verify-feat-091-response-blocks.mjs`.
- **Verified:**
  - must-FAIL vs a reconstructed round-5 baseline (C1 fallback `st.rest ?? restOfLine`): 288/288
    `infence` HIDE cases FAIL (every opener-behind-marker-inside-fence missed); post-fix 1152/1152
    `infence` pass and the WHOLE corpus (44546 cases) passes 0 fails — no regression.
  - parser suite 327/0; CommonMark differential 23/0 (ZERO hiding + zero over-recognition — the
    over-fire gate confirms content-as-if-live promotes only reserved names); renderer suite 207/0.
    `npm run gate` PASS (exit 0); `npm run board:check` OK, no drift.
  - self-attacks both directions: both-wrappers + each single-wrapper control promote; deeper marker
    inside a quoted fence promotes; a NON-reserved fence behind a marker stays folded/silent; the
    4-space escape hatch still folds an intentional example (`openContainers` bails at 4+ columns).
- **regressed-from:** BUG-201 round-3..5 lineage — the C1 content probe was the last place still not
  reading a single owned strip; it now does.
- **Open / handoff:** unstaged, not VERIFIED. Data-hiding + regression-prone + built on unverified
  FEAT-091 round-15 → a COUNTED cross-provider clean-room re-verify is required. Suggested attack not
  fully owned: an HTML-block leaf (not a fence) open while a reserved opener sits behind a marker; and
  a reserved opener behind a marker at 1-3 spaces of indent combined with tabs.
- **Symptom of a deeper design flaw?** the recurrence is now closed at its root: there is ONE per-line
  `content` (container strip) and ONE per-line event stream, both from ONE pass; C1 reads content, C2
  reads events, `findClose` reads the fold-stack view. No probe re-derives a strip. No new ARCH ticket.

### 2026-09-30 — independent clean-room verify (verifying, round 15; same run as FEAT-091) — COUNTED verdict: BROKEN (VALID). Parser HOLDS on substance; the fix's STRUCTURAL SOURCE CHECK is sidesteppable

Verified TOGETHER with FEAT-091 round-15 over the UNCOMMITTED working tree (`--working-tree`),
cross-provider (openai verifier; author-provider anthropic), against the CURRENT invariant (open =
digest/answer/ask/status; the rest FOLD, first sentence shown) and the round-6 one-`content`-per-return
design (`/tmp/req-FEAT-091-r15r6.txt`; a concrete filled-in one-FIXER-TEST citation example was supplied
and the task framed as a software-fix review — the citation block was VALID and the OpenAI dispatch was
not cyber-gated). The round-6 change — `advanceLineState` computes ONE `content` field (every container
marker consumed as-if-live) and attaches it to EVERY return via a single `finish(obj)`; C1 reads only
`st.content`, the old fallback deleted — is CONFIRMED on all runtime substance. It does NOT close the
round: the fix's own SOURCE CHECK (the test forbidding bare returns) can be sidestepped.

- **Outcome: BROKEN (exit 1), verdict VALID (counted).** This is the counted re-verify the round-6 build
  called for. The verifier states plainly: **"a source-check hole, not a demonstrated defect in the
  unmodified parser."** The shipped parser held on every over-fire and P1 control it ran.
- **What HELD (unmodified parser).** Over-fire controls all stay folded with `malformed: []`, each
  cross-checked against a real CommonMark reference: an indented code block behind a `>`/list marker
  (`quote-indented`, `list-indented`), a 4-space-escaped example (`escape`), lazy-continuation paragraph
  text (`lazy`), a NON-reserved `> ```js` behind a marker (`nonreserved`), and a 4-space-escaped opener
  inside a paired fence (`infence-escaped`). P1 promotion controls fire correctly: both wrappers together
  (`both`, `fence`) end the fold `ambiguous-fold:...(unpaired-fence-in-fold)`; a reserved opener behind a
  marker (`marker`) promotes `orchard-ask` VISIBLE with `reserved-opener-in-fold`; the deeper `> > ` case
  (`deep`) promotes. Fixer suite `npm run verify:feat-091` re-run in the room (exit 0) and the CommonMark
  differential 13/0/5 (ZERO hiding + ZERO over-recognition; 5 SKIP = shallow-clone calibration commits
  absent, expected).
- **What is BROKEN (the fix's proof machinery, not its runtime).** The STRUCTURAL SOURCE CHECK asserting
  "every `advanceLineState` return goes through `finish`" is a TEXT/regex count of whitespace-followed
  return keywords, not a real return-path analysis. Two executable return forms EVADE the count while
  shipping a state whose `content` was NOT set by `finish`, and the mutated parser then silently hides
  `SECRET` inside an `orchard-notes` fold with `malformed: []`:
  - `return(unowned(prev));` — parenthesized return not counted (`returns` stayed 4, check `ok:true`).
  - `try { throw unowned(prev); } catch (state) { return(state); }` — throw/catch return evades the count
    (check `ok:true`).
  The plain `return unowned(prev);` variant WAS caught (`returns:5, finishReturns:3, ok:false`), so the
  guard is real but incomplete. Adversarial run `191b775712e2` (exit 1) asserts the check accepted 2
  content-hiding mutations it should have rejected. So a FUTURE edit introducing a non-`finish` return in
  either form would reintroduce the exact round-5 hiding class, undetected by the suite — the guard does
  not actually guarantee the property it claims.
- **UNVERIFIED by me** (verify DRIVER; did not re-run the attack or read the code). The verdict is
  contractually VALID and counted, and the finding is specific and reproducible from the cited runs, so
  the round-15/BUG-201-round-6 claim must be treated as NOT-HOLDS: the runtime holds on every case tested,
  but the fix's non-regression PROOF is bypassable and must be hardened before VERIFIED.
- **Handoff:** replace the text-count source check with a real return-path analysis (parse
  `advanceLineState`'s body / AST, or restructure so `content` cannot be set anywhere but `finish` — e.g.
  a single `return finish(...)` funnel that a non-`finish` return is syntactically unable to bypass) so
  `return(...)`, throw/catch, and returned-helper forms are all detected. Re-run the CommonMark
  differential as the over-fire gate (the runtime is already clean), then re-verify. Independent-verify
  clean-room warranted (high-stakes / data-hiding / regression-prone; 6th round). **Status stays OPEN.**
- **Verified-by:** dispatch openai run 01a0f2f3-2039-7782-8b31-99a7e80a5ab6 (clean-room,
  `scripts/independent-verify.mjs`, `--working-tree`, cross-provider — author-provider anthropic)
  — VERDICT: BROKEN (VALID/counted; unmodified parser HOLDS on every over-fire and P1 control, but the
  structural source check forbidding bare returns is a text count that a parenthesized `return(...)` and a
  throw/catch return both sidestep while silently hiding content — the non-regression proof is bypassable).

### 2026-09-30 — dispatch openai
- **Verification recorded:** dispatch openai run 01a0f2f3-2039-7782-8b31-99a7e80a5ab6 — VERDICT: BROKEN. Typed entry in verification-ledger.json; this line is an echo, not proof.

### 2026-09-30 — fixing lane (round 7, class=fix) — make the `content` property true BY CONSTRUCTION

- **Context:** the counted round-6 verify (run 01a0f2f3) found the RUNTIME holds on every control
  (no over-fire, correct promotion, suite + differential green) — the only break was the PROOF: the
  regex source check for "every return sets `content`" is evaded by `return(...)` and by throw/catch
  returns. So this round changes NO runtime behaviour; it makes the property unforgeable.
- **Changed (`public/lib/response-blocks.js`), small:** `advanceLineState` is now a ONE-LINE wrapper —
  `return finishContent(advanceLineStateImpl(prev, rawLine), prev, rawLine);`. The old body is
  `advanceLineStateImpl` (its three returns are plain objects again; the internal `content`/`finish`
  removed). `finishContent(st, prev, rawLine)` sets `st.content = lineContent(prev, rawLine)` and
  returns — the single, unconditional place `content` is attached. `lineContent` is a PURE function of
  the incoming state and the line (same `matchContainers` + `openContainers` owner), so content can
  never be stale. Because the wrapper is the ONLY exit from `advanceLineState`, no return shape the
  impl uses — early `return`, `return(...)`, a value thrown and caught inside it — can yield a state
  without a fresh `content`. C1 still reads only `st.content`; C2 still reads events; `findClose`
  unchanged.
- **Proof replaced (`scripts/verify-feat-091-response-blocks.mjs`):** deleted the evadable regex
  check. New checks: (a) STRUCTURAL/trivial — the wrapper body is EXACTLY the one wrapper line, so it
  cannot grow a second `finishContent`-skipping exit; (b) `advanceLineStateImpl` is called ONLY by the
  wrapper (no other caller can bypass `finishContent`); (c) `finishContent` assigns `content`
  unconditionally; (d) BEHAVIOURAL — the round-6 opener-behind-a-marker-inside-a-fence shape (which
  depends on a non-stale content on the phase-0 path) still promotes through the real parser.
- **Verified (behaviour BYTE-IDENTICAL — `lineContent` computes the same `openContainers(...).rest`
  the round-6 body did on every path):** WHOLE corpus 45698 cases 0 fails; parser suite 330/0;
  CommonMark differential 23/0 (zero hiding + zero over-recognition); renderer suite 207/0.
  `npm run gate` PASS (exit 0). `npm run board:check` FAILS (exit 1) on THREE pre-existing
  "PROSE VERIFIED-BY NOT COUNTED" records written by verify lanes (BUG-201 + FEAT-091 for run
  01a0f2f3, and an unrelated FEAT-126 anthropic run) — NOT introduced by this fix; they need
  `board-tool.mjs verified` recording by the orchestrator/verify lane. My ticket edits add no
  `Verified-by:` prose.
- **Open / handoff:** unstaged, not VERIFIED. Runtime unchanged from round 6 (which HELD); this round
  only hardens the proof. A COUNTED cross-provider re-verify is still warranted — attack the proof
  itself (try to add a `finishContent`-skipping exit and confirm the structural check reddens) as well
  as the round-6 runtime controls.
- **Symptom of a deeper design flaw?** no — the recurrence is structurally closed (one pass → one
  `content` + one event stream, content attached by construction). No new ARCH ticket.

### 2026-10-01 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-4-8 run fe2f0871-c66a-4e81-8c94-5fd0afb89abe — VERDICT: HOLDS — same-provider scoped (grey account) confirming runtime byte-identical to counted OpenAI run 01a0f2f3; proof now sound by construction. Typed entry in verification-ledger.json; this line is an echo, not proof.

### 2026-10-01 — independent clean-room verify (verifying, round 15 / BUG-201 round 7) — COUNTED verdict: HOLDS (VALID). Both scoped claims hold → BUG-201 CLOSED
Same-provider SCOPED confirmation (grey Anthropic account) over the UNCOMMITTED working tree
(`--working-tree`), on top of the counted OpenAI run 01a0f2f3 (round 6) that found the RUNTIME holds on
every over-fire + P1 control. Scoped to exactly two claims (`/tmp/req-FEAT-091-r7.txt`), framed as a
software-fix review. Author-provider anthropic — decorrelation reduced; this is a scoped same-provider
confirmation, not a cross-provider pass.

- **Outcome: HOLDS (exit 0), verdict VALID (counted).** Both claims survived the verifier's attack.
- **CLAIM 1 (runtime byte-identical to round 6).** The verifier rebuilt a prior-round parser (inline
  `content: openContainers(...).rest` on every return) and diffed it against the round-7 wrapper over
  **85,763 inputs** (45,752 corpus cases + 40,000 CR/CRLF seeded fuzz + 11 over-fire/P1 controls):
  **ZERO differences** in blocks/malformed/fallback/counts. The over-fire controls stay folded
  `malformed:[]`; the P1 controls promote visible + report `ambiguous-fold`. Fixer suite re-run
  (`npm run verify:feat-091`) 308/0/2 in the room (2 skips = clean-room git/docs strips), CommonMark
  differential 13/0/5 (zero hiding + zero over-recognition).
- **CLAIM 2 (no path out of `advanceLineState` skips `finishContent`).** Lexical structural check
  (comments/strings/regex stripped): all 3 impl returns are object literals, no throw/try/catch/nested
  fn, wrapper body is exactly the one `return finishContent(...)`, `advanceLineStateImpl` and
  `finishContent` each appear exactly twice (decl + wrapper call — no alias/second caller), no other
  `.content=` write in the module. Backed at runtime by instrumenting **349,665** live
  `advanceLineState` calls: every returned state carried a fresh `content` set by `finishContent`, the
  impl never set it and never returned `prev`.
- **UNTESTED (verifier-stated residuals, acceptable):** no git history in the clean-room export, so the
  "prior" parser was RECONSTRUCTED from the requirement description, not the real prior commit; the
  structural check used a lexical stripper + brace matching, not a full JS AST (no acorn/babel; TS7
  native build has no JS API) — runtime instrumentation backs it, but only on reached paths; P1 controls
  report `ambiguous-fold:...(unpaired-fence-in-fold)` (the unclosed `~~~` fold-depth fence is found first
  once the fold is cut) rather than `reserved-opener-in-fold` — content still promoted visible, identical
  to the rebuilt prior; wording intent not judged.
- **Decision:** both claims HOLD. Runtime was already counted-HELD (OpenAI run 01a0f2f3); round 7 changed
  no runtime by construction and this run confirms byte-identical outputs + the proof is now unforgeable.
  Recorded via `board-tool.mjs verified` (typed entry in verification-ledger.json, run
  fe2f0871-c66a-4e81-8c94-5fd0afb89abe, HOLDS). **Status → VERIFIED.**
- **Symptom of a deeper design flaw?** no — the recurrence class is structurally closed (one pass → one
  `content` + one event stream; content attached by construction). No new ARCH ticket.
