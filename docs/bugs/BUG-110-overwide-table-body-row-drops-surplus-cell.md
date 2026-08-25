```orchard-ticket
{
  "id": "BUG-110",
  "type": "bug",
  "title": "Tables silently dropped a cell from an over-wide row",
  "summary": "A rendered table is now sized to its widest row, so a body row carrying more cells than its header keeps every cell in a visible column. Previously the surplus cell disappeared with no gap and no error. A second variant, where the separator row disagreed with the header width, is fixed by the same change.",
  "impact_if_we_wait": "Content a model wrote was removed from what the reader sees, silently. Bounded: this is display-correctness in one renderer, not data loss — the underlying text is untouched, and reloading or viewing the raw source recovers it.",
  "current_need": "Nothing is outstanding. The case that lost a cell failed before the change and passed after, an independent clean-room pass reproduced that result, and the standing renderer checks stayed clean.",
  "severity": "high",
  "area": "Markdown table rendering",
  "reported": "2026-08-19",
  "reported_by": "agent",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-19",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A body row wider than its header renders every cell in a visible column",
    "A separator row wider than the header does not drop the extra body cell",
    "A body row narrower than its header still renders, padded with empty cells",
    "A table without a separator row degrades to plain text with all content kept",
    "A cell containing an escaped pipe stays one cell holding a literal pipe"
  ],
  "code_refs": [
    {
      "path": "public/lib/dom.js",
      "symbol": "tryTable",
      "note": "sized the table from the header alone (`cols = header.length`); now `cols = Math.max(header.length, ...bodyRows.map(c => c.length))`, with the header padded by empty `<th>` for the unlabelled overflow column (~line 249)"
    },
    {
      "path": "public/lib/dom.js",
      "symbol": "prose",
      "note": "normalises CR/CRLF to LF before `tryTable()` runs, which is why the loss reproduces identically under all three line endings"
    },
    {
      "path": "public/lib/dom.js",
      "symbol": "tableCells",
      "note": "escaped-pipe splitting, left unchanged"
    }
  ],
  "related": [
    {
      "id": "ARCH-006",
      "relation": "see_also"
    },
    {
      "id": "BUG-109",
      "relation": "see_also"
    },
    {
      "id": "BUG-111",
      "relation": "see_also"
    },
    {
      "id": "FEAT-081",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a016b7-064c-7931-8c10-79fee08594ba",
      "verdict": "holds",
      "verdict_on": "2026-08-19",
      "harness": "scripts/independent-verify.mjs"
    }
  ],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": true,
    "Migration and rollback": false,
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-110-overwide-table-body-row-drops-surplus-cell.md",
    "sha256": "e0c68f88950a9dd2a09da3d77e980cb8e864ef662a4292ef30a05b9059a844a8",
    "bytes": 10674,
    "original_title": "a GFM table body row with more cells than its header silently dropped the surplus cell",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Read against the original head section by section: the repro, the widen-versus-merge reasoning, all five sibling cases, the second separator-width instance and the context pack are present.",
    "dropped": [
      "the restatement of why this is a new ticket rather than an append, kept only as one clause of the diagnosis",
      "the 'Expected' section, which the success criteria now carry"
    ]
  }
}
```

# BUG-110 — Tables silently dropped a cell from an over-wide row

## Diagnosis

`tryTable()` took the column count from the header row and rendered each body row with `for (i = 0; i < cols; i++)`. Any cell at index `cols` or beyond was never appended to a `<td>`, so it appeared in no element and in no reader-visible text. A model summarising in a table routinely emits a body cell that itself contains a pipe, which produces exactly this shape.

This is not a line-ending defect, although it was found while probing one. `prose()` normalises CR and CRLF to LF as its first act, before the table renderer sees the block, and the same over-wide table loses the same cell under LF, CRLF and lone CR alike. That is why it was filed separately rather than appended to BUG-109.

### Why widen rather than merge or degrade
Widening keeps every cell boundary legible and is local to the offending row: the reader sees all the content in its own column, with one unlabelled extra header. Merging the surplus into the last cell jams two cells' text together. Dropping the whole table to plain text punishes an otherwise valid table for one stray pipe. Widening only ever moves content toward being visible.

## Evidence

Clean-room repro: header `| H1 | H2 |`, separator, body `| KEEP-A | KEEP-B | LOST-SENTINEL |` rendered as `H1H2KEEP-AKEEP-B` — the sentinel gone, with no error and no gap.

The defect was reported out of the BUG-109 independent clean-room pass on 2026-08-19, under dispatch run 01a016a6-a330-7e91-914d-71a46a0d3177 (adversarial probe `lone-cr-overwide-table-row`, 3901fd8fa36b); a later harness run is recorded as 01a016b7.

Pre-fix proof, with the renderer reverted to HEAD: `verify:bug-109` at 28/39. After the fix: `verify:bug-109` 43/43, `verify:feat-081` 23/23, `verify:feat-082` 52/52, `verify:streaming-md` 9/9, `verify:orchard-transcripts` 15/15, `verify:feat-075-guide-viewer` 26/26, `verify:ui` 7/7, plus a 2/2 pair recorded without an adjacent suite name.

### Sibling row-sizing cases
A body row with fewer cells than its header was already safe — the missing cells render empty. A header with no separator row is safe: the table parse returns null and the block degrades to plain text with everything kept. A table with no body rows is safe. An escaped pipe stays one cell containing a literal pipe. The one further loss found was a separator row whose column count disagreed with the header: `| M1 | M2 |` over a three-column separator dropped the third body cell, and the same widest-row sizing fixes it.

## Implementation notes

Header cells are padded with empty `<th>` up to the new width; short body rows pad with empty `<td>`, which was already non-lossy. The rendered table stays rectangular and every cell lands in a real `<td>`.

## Verification plan

Section E of the BUG-109 real-browser suite carries this case — the same renderer and the same content-loss guarantee, so no `package.json` change was made in this lane. It runs the LF/CRLF/lone-CR control, the five sibling row-sizing cases, the transcript path, and light and dark captures at `docs/bugs/assets/BUG-110-{light,dark}.png`. Section F adds a synthetic truncated-stream replay of a CR-adjacent fence.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-19 — worker (Opus 4.8)
- **Understood:** `tryTable()` sized body rows from the header column count, so a body row (or a body row matching an over-wide separator) with more cells than the header dropped the surplus cell from every `<tr>` and from reader-visible text. Independent of line ending: `prose()` normalises to LF before `tryTable` runs, so the clean-room's lone-CR framing was incidental — hence a new ticket, not a BUG-109 append.
- **Changed:** `public/lib/dom.js` — `tryTable()` sizes to the widest row (widen; header padded with empty `<th>`, body padded with empty `<td>`). `scripts/verify-bug-109-prose-lone-cr.mjs` — new section E (over-wide + siblings, LF/CRLF/CR control, transcript path, light/dark table captures) and section F (truncated-stream replay). Commit sha: <filled at commit>.
- **Verified (fixer's own run):**
  - MUST-FAIL PRE-FIX (dom.js reverted to HEAD): `verify:bug-109` **28/39, exit 1** — the over-wide cell `LOST-SENTINEL` absent under LF, CRLF **and** lone CR (all three render `H1H2KEEP-AKEEP-B`), and the mismatched-separator sibling lost `MIS-c`. Control proves the loss is NOT line-ending-specific.
  - POST-FIX: `verify:bug-109` **43/43, exit 0.** Over-wide cell lands in a real `<td>` under all three line endings (rows `[["H1","H2",""],["KEEP-A","KEEP-B","LOST-SENTINEL"]]`); all five siblings non-lossy; transcript (`renderMessages`) path keeps the surplus cell; light/dark table captures graded on their own pixels (`docs/bugs/assets/BUG-110-{light,dark}.png`) and eyeballed — clean rectangular 3-column table, surplus cell visible in its own column.
  - Anti-regression: `verify:feat-081` **23/23**, `verify:feat-082` **52/52**, `verify:streaming-md` **9/9** (first run flaked 7/9 on the timing-sensitive live mid-stream capture; 9/9 on re-run, and 9/9 identical on HEAD dom.js — not caused by this change, which is table-only), `verify:orchard-transcripts` **15/15**, `verify:feat-075-guide-viewer` **26/26**, `verify:ui` **7/7**, all exit 0. `npm run gate` **PASS, exit 0** (leak-gate, check-nul, typecheck) — read unpiped.
  - Truncated-stream gap (carried across BUG-109's three passes): no authenticated live model stream is reachable in this harness and no stored transcript with a CR-adjacent fence exists in-repo, so section F replays the exact BUG-109 CR-adjacent-fence shape truncated at EVERY byte offset through `prose()` (the function the live path re-renders the accumulating buffer with each frame) — SYNTHETIC stand-in, labelled as such. Result: prose() never throws and no offset drops a region whose complete bytes have arrived (**2/2 pass**). The genuine live-model-stream truncation remains untested (environment, not logic).
- **Verified-by:** dispatch openai run 01a016b7-064c-7931-8c10-79fee08594ba (clean-room, `scripts/independent-verify.mjs`) — VERDICT: HOLDS
- **Verified-by (superseded, kept for history):** PENDING — clean-room dispatch required (content-loss class, shared renderer). Suggested attack the fixture cannot self-confirm: an over-wide row where a surplus cell itself contains markup/inline formatting, and an over-wide row combined with per-column alignment beyond the header's declared columns.
- **Still open / handoff (tilde/fence-grammar — separate lane, coordinator to dispatch):** A neighbouring lane reported `prose()` recognises backtick fences but is blind to CommonMark **tilde** (`~~~`) fences, so the block parser (in `response-blocks.js`, out of this lane) and the renderer disagree. Real-browser evidence gathered this lane: `~~~js\n#…\n| a | b |\n~~~` renders as live prose (preCount 0 — the `#`/`|` would become a real heading/table); fences inside a blockquote/list leak their `>`/indent markers into the `<pre>`. Realistic cases keep content VISIBLE (divergence class, not hidden-content), though a contrived backtick-run inside a tilde block can reach content loss. Deliberately NOT folded into this content-loss hotfix: `prose()`'s fence model is `src.split(/```/)` — a char-run splitter, not line-based — so a correct tilde fix means replacing it with a line-based, char-parameterised scanner that matches `response-blocks.js`'s grammar, which also changes backtick edge-case behaviour (inline ``` currently splits) and thus perturbs every existing suite. That is a core-renderer rewrite with its own regression surface and a different, lower-severity defect class; per the coordinator's explicit offer it should be a separate ticket/dispatch, covering: parameterise the fence CHARACTER (not a second tilde branch), closer-length ≥ opener-length matching, info strings, indentation, and blockquote/list-item continuation.
- **Symptom of a deeper design flaw?** Candidate-yes — same class as ARCH-006 and the tilde finding above: two halves of the render pipeline (block parser vs `prose()`) hold independent, drifting models of the same grammar (line endings, fences, table column count), and each drift is a fresh content-loss or divergence bug. Flagging for the orchestrator to weigh whether the render pipeline needs a single shared grammar authority rather than per-stage re-derivation. Not filing an ARCH ticket from this fix lane.
