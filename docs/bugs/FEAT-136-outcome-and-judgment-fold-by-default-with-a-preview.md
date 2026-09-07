# FEAT-136 — outcome and judgment blocks bury the reply; fold them by default with a preview

- **Status:** IN VERIFICATION — implemented and self-verified in a real headless browser (folds outcome + judgment with a first-line preview; digest/ask/status stay expanded; both themes; must-FAIL against HEAD). Touches the shared certainty-guard list + the injected prompt, so an independent clean-room pass is warranted before VERIFIED.
- **Severity:** medium
- **Area:** Transcript reply display (public/lib) + injected response-format doc
- **Reported:** 2026-09-07 by user (recurring since 2026-08-14)
- **Verification-class:** fix (harm class: contained render — zero adversarial rounds per project rule; DOM + pixel proof over the real page in both themes)

## Symptom
The user asked across seven tickets since 2026-08-14 (FEAT-083, 085, 091, 093,
098, 125, 127) for their reply to be scannable, and was still scrolling past long
"here is what I did and why" prose to reach the parts addressed to them. Renderer
collapse landed in FEAT-093 but only for `finding`, `narration` and the legacy
`notes` alias; `outcome` and `judgment` — the two longest supporting-record
categories — still rendered fully expanded, so the ask and the status sat below a
wall of detail.

## Expected
- `orchard-outcome` and `orchard-judgment` fold by default, each with a one-line
  preview of their first sentence (the same treatment `orchard-finding` has), so a
  reader can triage whether to open them.
- `orchard-digest`, `orchard-ask` and `orchard-status` stay expanded, always —
  these are the things a reader must not have to click to see (the headline, what
  needs them, where it stands).
- Opening a fold reveals the full block text unchanged.
- The live streaming path and the re-read-after-reload path both behave: a block
  that is still streaming must not be mis-collapsed or double-rendered.

## Context pack
- Collapse is driven by ONE shared list, `COLLAPSED_BLOCKS`
  (`public/lib/response-blocks.js`), which is also the parser's certainty guard —
  so adding a name there is the documented extension point and gets the guard for
  free (a folded block whose body holds a reserved `orchard-*` opener or an
  unpaired inner fence ends its fold there and reports `ambiguous-fold`, same as
  findings). The renderer's single hiding branch (`renderFold`) is gated on this
  list in `public/lib/digest.js`; the preview machinery (`foldPreview`,
  `preview` presentation flag) already existed for findings and needed no new code.
- The injected agent-facing doc `docs/prompts/RESPONSE_FORMAT.md` documents which
  categories fold and is folded into every response-format-enabled session's
  system prompt (`responseFormatSection`, ≤5900-byte budget asserted by
  `verify-feat-084`). It had to move with the renderer or it would contradict the
  interface (FEAT-093 precedent). Trimmed back under budget (observed 5899).
- The live-vs-settled interaction (BUG-169) is orthogonal: streaming renders raw
  buffer via plain `prose()`; folds only appear after `finishStream` /
  turn-end / trailing-`text` settle routes through the fold-aware renderer, so a
  still-streaming outcome shows literal fence syntax (never a fold) until it
  settles — identical to how findings already behave.
- Related: FEAT-093 (the finding fold this extends), FEAT-091 (block grammar),
  FEAT-125/127 (brevity), BUG-169 (live-stream settle).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-07 — worker (fixing, round 1)
- **Understood:** the charter hypothesis ("data-only change to `COLLAPSED_BLOCKS`
  plus a preview flag per block type") was correct. No new rendering machinery was
  needed. The one out-of-charter necessity: `RESPONSE_FORMAT.md` is injected into
  every session and documents the fold set, so leaving it stale would contradict
  the interface (FEAT-093 established the doc and renderer move together).
- **Changed (unstaged):**
  - `public/lib/response-blocks.js` — `orchard-outcome`, `orchard-judgment` added
    to `COLLAPSED_BLOCKS`; the round-13 rule doc rewritten in place to round 14
    (what stays open narrowed to digest/ask/status; outcome/judgment now folded),
    with an honest note that the stated rule follows the reader's triage rather
    than deriving it.
  - `public/lib/digest.js` — `preview: true` on the `orchard-outcome` and
    `orchard-judgment` presentation rows.
  - `docs/prompts/RESPONSE_FORMAT.md` — the injected core and the non-injected
    rationale updated to the four-category fold set; trimmed to stay under the
    5900-byte inject budget (observed 5899).
  - `scripts/verify-feat-091-response-blocks.mjs`,
    `scripts/lib/feat-091-fold-corpus.mjs` — the design-decision oracles updated
    to round 14 (the "nothing the reader must see can fold" invariant now guards
    digest/ask/status; the corpus fold-name set now includes outcome/judgment).
- **Verified — unit oracles:**
  - `node scripts/verify-feat-091-response-blocks.mjs` → **277 passed, 0 failed**
    (was 272/5 before the oracles were updated — the 5 reds were the stale
    round-13 assertions, a must-FAIL against the old design).
  - `node scripts/verify-feat-084-response-format-inject.mjs` → **37 passed, 0
    failed** (inject core 5899 ≤ 5900).
- **Verified — real headless browser (Playwright MCP, not the stealth browser),
  real working-tree `public/`, real `styles.css`, a realistic reply exercising
  every block type (digest + finding + outcome + judgment + ask + status +
  narration):**
  - AFTER (working tree): outcome and judgment each render as
    `details.orchard-fold` — closed, body hidden, a visible `.orchard-notes-prev`
    first-line preview; finding still folds; narration folds with no preview;
    `orchard-ask` and `orchard-status` render as expanded `.orchard-blk` (NOT
    `<details>`); the digest rail is visible. Clicking an outcome summary opens it,
    reveals the full body text unchanged, and hides the preview.
  - **Must-FAIL against HEAD** (`git show HEAD:public/lib/*` served under a
    `/before` path in the same rig): outcome and judgment render as expanded
    `.orchard-blk` and NO `details.orchard-fold.ob-outcome/-judgment` exists —
    i.e. the collapse property is genuinely absent pre-change and present
    post-change, and the assertion would redden on the unfixed tree.
  - **Live vs re-read:** streaming path renders raw buffer via `prose()` (no
    fold, no double-render) and only the settle routes through the fold-aware
    renderer; confirmed by code path (BUG-169 settle handlers unchanged) and by
    the re-read render above going through the same `renderAssistantText` entry the
    transcript uses on reload.
  - Screenshots (git-ignored `docs/bugs/assets/`, local artifacts, regenerable):
    - `docs/bugs/assets/FEAT-136-outcome-judgment-fold-collapsed-dark.png`
    - `docs/bugs/assets/FEAT-136-outcome-judgment-fold-collapsed-light.png`
    - `docs/bugs/assets/FEAT-136-outcome-judgment-fold-expanded-light.png`
- **Cosmetic note (pre-existing, not introduced here):** the preview passes
  through `stripMarkupForPreview`, which strips `_` as an emphasis marker, so a
  preview containing `COLLAPSED_BLOCKS` shows as `COLLAPSEDBLOCKS`. The folded
  BODY is unchanged (`COLLAPSED_BLOCKS` intact). This is finding-preview behaviour
  that now also applies to outcome/judgment previews; left as is.
- **Independent verify:** routine low-risk render change, so not mandatory — but
  it did edit the shared certainty-guard list AND the injected system prompt every
  session reads, so a second clean-room pass is *warranted if the orchestrator
  wants belt-and-braces* (regenerate the same rig against `/before` and `/after`).
- **Not touched:** `src/server/*`, `scripts/hooks/*`,
  `scripts/lib/format-metrics.mjs`, `scripts/lib/leak-*`; FEAT-129/130/131/132
  rows. All work left unstaged.
