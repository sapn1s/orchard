```orchard-ticket
{
  "id": "FEAT-093",
  "type": "feature",
  "title": "Supporting detail buried the parts of a reply addressed to the reader",
  "summary": "Findings are the largest part of a reply and were always shown in full, so the ask and the outcome sat below a wall of supporting detail. Findings now fold by default and show their own first sentence, so a reader can tell at a glance whether to open one.",
  "impact_if_we_wait": "Readers keep scrolling past supporting detail to reach what is addressed to them. Bounded: this is display only. No reply content is lost, folded text stays one click away, and the other categories are untouched.",
  "current_need": "Have someone outside the work reproduce the folded and previewed rendering in a browser and confirm the other categories still open by default.",
  "severity": "low",
  "area": "Transcript reply display",
  "reported": "2026-08-19",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "in_progress",
  "human_action": "review",
  "updated": "2026-08-19",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-19",
      "question": "Should a folded finding show its first sentence, or only a bare category label?",
      "mode": "single",
      "options_keys": [
        "A",
        "B"
      ],
      "chosen": "A",
      "chosen_on": "2026-08-19",
      "chosen_by": "agent",
      "note": "Both versions were rendered from four real consecutive transcript replies and shown to an independent design reviewer twice. The reviewer called the bare-label stack pure debris that forces the reader to open a fold to learn whether they wanted it. The preview costs the same vertical space and supports the triage the user asked for. Narration deliberately keeps its bare label, because it is a small share of a reply and expires when the turn ends."
    }
  ],
  "success_criteria": [
    "A finding renders folded on first paint and shows its own first sentence",
    "Opening the fold reveals the full finding content unchanged",
    "Outcome, ask, judgment and status still render expanded",
    "The declared fallback still renders expanded",
    "A finding whose body breaks the fold is reported as ambiguous rather than silently truncated"
  ],
  "code_refs": [
    {
      "path": "public/lib/response-blocks.js",
      "symbol": "COLLAPSED_BLOCKS",
      "note": "Not purely presentational: the same list drives the parser's certainty guard, so adding finding also placed findings under it. A finding containing a reserved opener or an unpaired inner fence ends its fold there and reports ambiguous-fold, the same direction narration has always degraded in."
    },
    {
      "path": "public/lib/digest.js",
      "symbol": "BLOCK_PRESENTATION",
      "note": "new preview flag on the finding category, alongside new foldPreview() and renderFold()"
    },
    {
      "path": "public/styles.css",
      "symbol": ".orchard-notes-prev",
      "note": "preview text and the fold chrome"
    },
    {
      "path": "docs/prompts/RESPONSE_FORMAT.md",
      "symbol": null,
      "note": "carries both the agent-facing core and the human rationale, and is injected into every session, so it had to move with the code"
    }
  ],
  "related": [
    {
      "id": "FEAT-091",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-083",
      "relation": "see_also"
    },
    {
      "id": "FEAT-084",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": true,
    "Migration and rollback": true,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-093-findings-collapsed-by-default-with-a-preview.md",
    "sha256": "6ae0b0ebb120ee5b293e1a5379c6185d763f5ed43d3bc4db0932569efe793f27",
    "bytes": 11172,
    "original_title": "Findings collapse by default, showing their first sentence",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared clause by clause against the original head: the symptom, the preview-versus-label judgement and its review, the changed collapse rule, the shared-list consequence and the named files are all present.",
    "dropped": [
      "the ticket's own restatement of its verification class as a workflow gate",
      "the note that there are no known blockers"
    ]
  }
}
```

# FEAT-093 — Supporting detail buried the parts of a reply addressed to the reader

## Diagnosis

Findings were 34.7% of characters in the labelled sample that produced the category vocabulary — more than twice any other category — and were always expanded. The parts of a reply actually addressed to the reader, the ask and the outcome, therefore sat beneath a wall of supporting detail.

The user's own words while watching their transcript: *"lets make 'Finding' section collapsed by default tho in ui, as its not really useful for me to read unless i want to, i think"*. That is a triage need, not a space need.

## Evidence

Two rounds of independent design review, each on renderings taken from four real consecutive transcript replies. The bare-label variant renders as a full-width control carrying a single word, repeated down the transcript; the reviewer's verdict was that three stacked are pure debris and that the reader must open one to learn whether they wanted it, which defeats the purpose of the fold. The preview variant costs the same vertical space and carries the information the triage decision needs.

No clean-room run of the renderer suites is on record for this change.

## Implementation notes

The collapsed set is shared between presentation and the parser's certainty guard, so listing findings there is a behavioural change as well as a visual one: a finding whose body holds a reserved category opener or an unpaired inner fence now ends its fold at that line and reports an ambiguous fold. That is visible and flagged, and it is the documented extension point rather than a workaround.

The written rule had to change with the code. It previously said a category is collapsed if its value expires when the turn ends, which picked out exactly one member and was a description rather than a rule. It now reads: a category is collapsed if the reader does not have to read it to know where they stand. Ask, outcome, status and judgment are addressed to the reader; finding and narration are the supporting record behind them.

## Verification plan

Run the two renderer suites named in the ticket. Then, in a real browser, confirm a finding paints folded with its own first sentence, opens to its full text, and that outcome, ask, judgment, status and the declared fallback all paint expanded. Include a finding whose body contains a reserved opener and confirm it is flagged rather than silently cut.

## Migration and rollback

The injected response-format document and the renderer must move together, since a document that contradicts the interface is worse than none. Reverting means removing the finding category from the collapsed set and dropping the preview flag; nothing is stored, so no data migration is involved.

## Risks

Placing findings under the certainty guard widens the set of replies that can report an ambiguous fold. A first sentence that is uninformative would make the preview no better for triage than the bare label it replaced.

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
