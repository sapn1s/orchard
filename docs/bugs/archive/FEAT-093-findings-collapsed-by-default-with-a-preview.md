# FEAT-093 — Findings collapse by default, showing their first sentence

- **Status:** IN-PROGRESS — built and self-verified; awaiting independent clean-room verification
- **Severity:** low
- **Area:** transcript renderer / response-format layer 2
- **Reported:** 2026-08-19 by the user
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED

## Symptom

The user, watching their own transcript: *"lets make 'Finding' section collapsed by
default tho in ui, as its not really useful for me to read unless i want to, i think"*.

Findings are the biggest thing in a reply — 34.7% of characters in the labelled
sample that produced the vocabulary, more than twice anything else — and they were
always expanded. So the parts of a reply that are actually addressed to the reader,
the ask and the outcome, were being scrolled past a wall of supporting detail to
reach.

## Expected

An `orchard-finding` block renders collapsed by default, the way `orchard-narration`
already does, and its content stays one click away rather than being lost. The other
four categories (`orchard-outcome`, `orchard-ask`, `orchard-judgment`,
`orchard-status`) stay expanded, as does the declared fallback.

## What was decided, and why (the judgement this ticket owns)

**A folded finding shows its own first sentence; a folded narration keeps its bare
label.** Both were rendered from four real consecutive transcript replies and put in
front of an independent design reviewer, twice.

The bare-label version renders as a full-width control carrying one word, repeated
down the transcript. The reviewer's words: *"three of them stacked down the
transcript are pure debris, and the user must open one to learn whether they wanted
it, which defeats the purpose of the fold"*. It costs the same vertical space as the
preview and carries none of the information. The user's need is TRIAGE — "not useful
unless I want to" is a decision they have to be able to make — and only the preview
supports making it.

Narration does not get one, and that asymmetry is the point that presentation follows
the CATEGORY: narration is 3.5% of characters and expires when the turn ends, so a
label is the whole story there.

**The rule in the spec had to change with it.** It said *"a category is collapsed if
its value expires when the turn ends"*, which picked exactly one member — a
description, not a rule. It is now: *a category is collapsed if the reader does not
have to read it to know where they stand*. The ask, outcome, status and judgment are
addressed to the reader; the finding and the narration are the supporting record
behind them.

## Context pack

- Files/functions in play:
  - `public/lib/response-blocks.js` — `COLLAPSED_BLOCKS`. This is NOT purely
    presentation: the same list drives the parser's certainty guard ("the fold is the
    only gate"), so adding `finding` also put findings under it. A finding whose body
    holds a reserved `orchard-*` opener, or an unpaired inner fence, now ends its fold
    at that line and reports `ambiguous-fold:` — visible and flagged, the direction
    narration has always degraded in. That is the documented extension point
    (RESPONSE_FORMAT.md, "adding a name"), not a workaround.
  - `public/lib/digest.js` — `BLOCK_PRESENTATION` (new `preview: true` flag on
    `orchard-finding`), new `foldPreview()`, `renderFold()`.
  - `public/styles.css` — `.orchard-notes-prev` and the fold chrome.
  - `docs/prompts/RESPONSE_FORMAT.md` — the injected agent core AND the human
    rationale. The doc is injected into every session, so a doc that contradicts the
    UI is worse than none.
- Related tickets: FEAT-091 (the block grammar and its twelve rounds), FEAT-083/084
  (layer 1, the digest).
- Repro test: `npm run verify:feat-091-renderer` and
  `npm run verify:feat-091-response-blocks`.
- Known dependencies / blockers: none.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-19 — build lane (dispatched worker)

- **Understood:** the charter's hypothesis was "presentation-layer only". It is
  *nearly* right and the one exception matters: the collapsed list lives in the shared
  grammar module and feeds the parser's certainty guard, so this changes parse
  behaviour for findings as well as their render. Not a blocker — the design names
  `COLLAPSED_BLOCKS` as the way to add a folding category — but it is recorded here
  because it is the part a reader of the diff would not expect.

- **Changed:** (commit `9c03a1a`)
  - `public/lib/response-blocks.js` — `orchard-finding` added to `COLLAPSED_BLOCKS`;
    the rule and its history rewritten in place.
  - `public/lib/digest.js` — `foldPreview()` (first sentence, skipping fenced code,
    stripping markup, one sentence, ≤170 chars, cut at a word boundary with an
    ellipsis); `preview: true` on the finding presentation row; `renderFold()` appends
    the preview span.
  - `public/styles.css` — `.orchard-notes-prev`, plus three fixes the design review
    forced (below).
  - `docs/prompts/RESPONSE_FORMAT.md` — injected core + rationale.
  - `scripts/verify-feat-091-response-blocks.mjs`,
    `scripts/verify-feat-091-renderer.mjs`, `scripts/lib/feat-091-fold-corpus.mjs` —
    oracles and assertions.

- **Verified:**
  - `node scripts/verify-feat-091-response-blocks.mjs` → **TOTAL: 277 passed, 0
    failed** (was 273/3 before the oracle was updated).
  - `node scripts/verify-feat-091-renderer.mjs` → **VERDICT: PASS — 207 passed, 0
    failed** (real Brave over CDP, real server, real stylesheet; includes the AX-tree
    reads and the light/dark shot ledger).
  - **Must-FAIL proof, anchored to a synthesized pre-fix state, not to HEAD**
    (`docs/CONVENTIONS.md`):
    - `finding` removed from `COLLAPSED_BLOCKS` → parser suite **275/2 FAIL**,
      renderer suite **199/8 FAIL**.
    - fold kept, preview branch disabled → renderer suite **203/4 FAIL**, and exactly
      the four preview checks are the ones that redden.
  - **Real content, not a fixture.** The visual capture rig renders four REAL
    consecutive assistant messages from this project's own CLI transcript
    (`87564f3e-….jsonl`, indices 17438 / 17386 / 17798 / 17483 — a long finding, a
    short one, findings beside an ask, an outcome and a judgment). Rig:
    a scratch rig outside the repo, `<scratch>/finding-fold/shots.mjs` (deliberately
    not committed — it hard-codes one machine's transcript path).
    Every capture graded by `scripts/lib/shot-luma.mjs`: a file labelled dark must
    measure dark, and no two captures in a run may be byte-identical. 12 shots
    (2 variants + the opened state × wide/narrow × light/dark), 0 bad, on every run.
  - Screenshots, kept:
    - `docs/bugs/assets/FEAT-093-finding-fold-collapsed-light.png`
    - `docs/bugs/assets/FEAT-093-finding-fold-collapsed-dark.png`
    - `docs/bugs/assets/FEAT-093-finding-fold-bare-label-rejected-light.png` — the
      variant that was NOT taken, kept because the argument for the preview is only
      legible next to it.

      (`docs/bugs/assets/` is git-ignored, as it is for every other ticket on this
      board, so these are local artifacts on the machine that produced them. The rig
      regenerates all twelve deterministically from the transcript.)

- **Commit provenance — part of this change is NOT in this ticket's commit.** A
  concurrent lane committed `public/styles.css` at 23:47 while this lane was mid-edit
  (commit `5c945e3`, whose subject is about ticket-record fences), sweeping the first
  round of the fold's CSS into it — the `.orchard-notes-prev` rule, the ink-mixed
  surface, the gutter-hung twisty and the label/preview tones. That commit's message
  does not mention any of it. This ticket's own commit therefore carries only the
  SECOND round of CSS (the two round-2 review fixes: twisty 9px → 12px, border mix
  14% → 11%). Recorded here because the board's audit trail is "the hash ties the row
  to the change", and for this file it does not. This is the `git add -A` hazard the
  Working Agreement §J names, observed live.

- **Design review (independent, twice, on the pixels — not by the builder):**
  - Round 1 chose the preview over the bare label and raised three blockers: the dark
    fold had a 3-level fill against the page (no perceptible surface); the twisty was
    a speck; the label and the preview were the same grey, so "FINDING" read as the
    first word of the sentence.
  - Fixes: surface and border derived by mixing ink into the window so the lift is
    equal in both palettes (hover was separately inverted in one palette and is now
    always more contrast); twisty enlarged and hung in the left gutter so the label
    sits on the same x as CHANGED / NEEDS YOU / MY CALL; label one tone quieter than
    the preview, direction preserved in both palettes.
  - Round 2, measuring the new pixels: fold fill contrast now **1.08:1 in both
    palettes** (was 3 levels in dark), label/preview separation correct both ways
    (light 4.93:1 vs 6.90:1; dark 4.67:1 vs 6.35:1), label column ragged by **<1.5 CSS
    px** across all block types. Verdict **SHIP**, with two one-value follow-ups —
    twisty to ~8 CSS px, and the dark fold border down from 49 so it stops out-edging
    the digest card at 36. **Both applied** (12px glyph; border mix 14% → 11%).

- **Still open / handoff:** three things this lane deliberately did not do.
  1. **Mid-word truncation at 420px** (`…better tha…`). CSS `text-overflow` cannot
     clip at a word boundary; doing so needs JS text measurement re-run on resize.
     Both reviewers agreed it is not worth the machinery. Left as is.
  2. **The open-state morph** — the preview vanishes from the summary and reappears as
     the first line of the body in a different face. Reviewers called it a real
     double-take and not a blocker; the summary keeps the preview's space reserved so
     the row does not jump. Left as is.
  3. **Open finding body contrast.** Round 2 noticed, outside the diff, that folded-block
     body text runs at 5.6:1 (light) / 5.0:1 (dark) where every other block's body runs
     at ~17:1 / ~14:1. It passes AA and the de-emphasis is pre-existing (`.orchard-notes-body
     .prose`), but it now applies to a THIRD of the reply rather than to 3.5% of it: someone
     who has deliberately opened a finding is trying to read it. Worth its own ticket.
  Also untested: a **narration** fold in the real running app. The four real messages
  contain none, so the chrome changes (twisty, colours, gutter) are proven for
  `ob-finding` in pixels and for `ob-narration` only in the DOM/AX assertions.

- **Symptom of a deeper design flaw?** No. The opposite: the change is one entry in
  `COLLAPSED_BLOCKS`, one presentation flag and one preview function, which is what the
  FEAT-091 extension contract promised and had never been exercised. The one thing worth
  watching is that the *stated rule* for what folds has now changed once; if it changes
  again, the rule is being fitted to the set rather than deriving it, and that is an ARCH
  question.
