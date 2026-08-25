```orchard-ticket
{
  "id": "FEAT-098",
  "type": "feature",
  "title": "Replies read as stories because blocks shape prose only from outside",
  "summary": "The format names six categories but says nothing about the shape of prose inside a block, so blocks came out as narrative paragraphs and a reader parsed a story to take one fact. The core now shapes the inside of a block: claim, evidence and consequence on separate lines, parallel slots when things are compared, decisions keeping their argument.",
  "impact_if_we_wait": "Every substantive reply on every project keeps costing the reader a paragraph parse per fact. Bounded: this is guidance inside a block, so nothing about the grammar, the parser, the fold or archived transcripts changes, and a reply written the old way still renders exactly as before.",
  "current_need": "Have someone outside the work read a handful of real replies written under the new shape and say whether facts are extractable without reading sentences to their end, and whether any decision lost its reasoning.",
  "severity": "medium",
  "area": "Reply readability, injected response format",
  "reported": "2026-08-21",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "in_progress",
  "human_action": "review",
  "updated": "2026-08-21",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A block with more than one fact leads with a standalone claim line, with its evidence and its consequence on their own lines",
    "Several compared things carry the same slots in the same order, one per line, so the cost of each is in the same position",
    "A decision block still prices every alternative it names",
    "A single-claim block stays a single sentence rather than gaining scaffolding",
    "The grammar, the parser, the certainty guard and archived transcripts are untouched",
    "The injected section stays inside its stated attention budget and is never truncated"
  ],
  "code_refs": [
    {
      "path": "docs/prompts/RESPONSE_FORMAT.md",
      "symbol": null,
      "note": "the injected core gained the in-block shape and one worked narrative-versus-shaped pair; the reasoning and the rewrites of real blocks live below the end marker, where they cost no tokens"
    },
    {
      "path": "scripts/verify-feat-084-response-format-inject.mjs",
      "symbol": null,
      "note": "the composed section's size assertion was the guard that caught the growth; raised from four thousand to five thousand five hundred characters with the reasoning recorded at the check"
    },
    {
      "path": "src/server/templates.ts",
      "symbol": "responseFormatSection",
      "note": "unchanged behaviour; its stale note about the size of the core was corrected"
    }
  ],
  "related": [
    {
      "id": "FEAT-091",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-093",
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
    "archived_path": null,
    "sha256": null,
    "original_title": null,
    "migrated_on": null,
    "migrated_by": null,
    "confirmation": "Authored directly in the record format through scripts/board-tool.mjs. There is no legacy original.",
    "dropped": []
  }
}
```

# FEAT-098 — Replies read as stories because blocks shape prose only from outside

## Diagnosis

The format defines what a passage IS and stops at the fence. Inside a block there was no shape at all, so blocks came out as news paragraphs: a bolded lead, then supporting sentences welded together by connectives whose only job is flow. To take one fact the reader had to parse a story.

The user's own words: the problem with responses is that they are full paragraphs, that is what is taking cognitive effort, the output should really be some kind of structured text, it seems almost like online news articles making a story.

This is a granularity defect, not a compliance one. Structure existed between blocks and never inside them.

## Evidence

Measured on this project's own main-thread transcript for the day, over the blocks a real session emitted: the mean finding was one thousand two hundred and seventeen characters and the mean judgment one thousand one hundred and seventy. One to three paragraphs each, several times a turn.

The design idea is taken from the one document a reader in this project preferred outright. The finding that recorded why says that every option ended with the same clause in the same position, and that the single repeated slot is what let the reader scan the catches vertically and compare them without re-reading. That generalises to the rule now in the core.

Three real blocks were rewritten in the proposed shape before it was written down: a self-correction about cost, the record-grammar decision whose alternatives were priced inside one semicolon chain, and a judgment whose value is its reasoning. None lost anything. The rewrites are kept in the spec below the end marker.

One unlooked-for confirmation came from the existing interface. A folded finding shows its own first sentence. The old narrative shape previewed as a wind-up sentence carrying no information, while the shaped version previews the claim itself, so the same change improves a surface that already shipped.

## Implementation notes

Guidance only. No new block name, no new syntax, no change to the fence grammar, the certainty guard, the collapsed set or the renderer, so the accumulated clean-room verdicts on the grammar carry over untouched.

Decisions were deliberately carved out. An ask or a judgment keeps its whole argument, because an option without its price is not a decision. The shape gives those blocks more lines, not fewer words.

## Verification plan

Parse a reply written in the new shape and confirm it yields the intended blocks with nothing reported as malformed and no fold reported as ambiguous, including a block that carries an inner code fence. Confirm the fold preview of a shaped finding reads as the claim. Run the three response-format suites and the pre-commit gate. Then have a reader outside the work judge real replies.

## Migration and rollback

Nothing is stored and nothing is migrated. Rollback is deleting the added section from the injected core and restoring the previous size assertion.

## Risks

The shape could degrade into fragments that drop the verb, which would be worse than the paragraphs it replaces. It could also be applied to blocks holding a single fact, where scaffolding is noise. Both are named as failure modes in the spec. The addition costs one and a half thousand characters of injected prompt on every turn of every project, which is the largest single addition the section has taken.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-21 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-08-21 — build lane (dispatched worker)
- **landed:** **Landed:** `9799b9a` — the in-block shape in the injected core, the worked narrative-versus-shaped pair, the raised size assertion and the corrected note in the injection helper.
  - **Must-FAIL first:** the composed section's size assertion was run before the bound was touched and failed at 5245 characters against its old 4000 cap, which is what proves the budget guard is real rather than decorative.
  - **Verified:** the three response-format suites pass (37, 23 and the digest suite, 0 failures). A reply written in the new shape was parsed by the real grammar module: two blocks, nothing malformed, no ambiguous fold, with blank lines, bullets and an inner code fence inside the blocks.
  - **Unlooked-for confirmation:** the fold preview of a shaped finding reads as the claim itself, where the same block in its original narrative form previewed as "Correcting myself first." — a wind-up carrying no information. The shape improves a surface that already shipped.
  - **Not done:** no reader outside the work has judged real replies written this way, and no independent clean-room pass has been run. This is guidance, not grammar, so the risk class is low, but the claim that nothing is lost from a decision block rests on three rewrites done by the author of the shape.
