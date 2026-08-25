# BUG-110 — a GFM table body row with more cells than its header silently dropped the surplus cell

- **Status:** VERIFIED (fixer's own run) — prose() now sizes a table to its widest row; independent clean-room verify still required.
- **Severity:** high — silent content loss in rendered model/file text; a table is exactly the shape a model emits when summarising, so this is not a rare input
- **Area:** frontend — the shared markdown renderer `prose()` / `tryTable()` in `public/lib/dom.js`
- **Reported:** 2026-08-19, by the BUG-109 independent clean-room pass (dispatch openai run 01a016a6-a330-7e91-914d-71a46a0d3177, adversarial `lone-cr-overwide-table-row` run 3901fd8fa36b)
- **Verification-class:** fix ⟶ independent verification REQUIRED before this moves past VERIFIED

## Why a NEW ticket and not an append to BUG-109

The BUG-109 clean-room found this while probing lone-CR line endings, so it *looked* line-ending-related. It is not. `prose()` normalises CR/CRLF → LF as its very first act (BUG-109's fix), **before** `tryTable()` ever runs, so by the time the table renderer sees the block, all line endings are already LF. The scope control the original probe never ran — the identical over-wide table under **LF**, **CRLF** and **lone CR** — loses the cell in all three (`H1H2KEEP-AKEEP-B` every time; see verify section E). This is therefore an **independent table-rendering bug**, not a line-ending bug, so it gets its own ticket rather than an append to BUG-109 (the line-ending ticket).

## Symptom

A markdown table whose body row has MORE cells than its header loses the surplus cell entirely — it is in no `<tr>`/`<td>` and absent from reader-visible text. Clean-room repro:

```
input:    | H1 | H2 |\r| --- | --- |\r| KEEP-A | KEEP-B | LOST-SENTINEL |
rendered: H1H2KEEP-AKEEP-B          ← LOST-SENTINEL gone, no error, no gap
```

## Repro

Feed `prose()` (or any surface that renders model markdown) a pipe table whose header is N columns but a body row has N+1 cells. `tryTable()` set `cols = header.length` and rendered each body row with `for (i = 0; i < cols; i++)`, so `cells[cols], cells[cols+1] …` were never appended to a `<td>` and vanished. A model summarising in a table routinely emits a body cell that itself contains a pipe, producing exactly this shape.

## Expected

No reader-visible content is ever lost by rendering. Every cell of every row — including a body row wider than the header — renders somewhere the reader can see it.

## What changed (the fix)

`public/lib/dom.js` `tryTable()`: size the table to the **widest row**, not just the header:
`cols = Math.max(header.length, ...bodyRows.map(c => c.length))`. The header is padded with empty `<th>` for the unlabelled overflow column; short body rows pad with empty `<td>` (already safe — missing cells render empty, losing nothing). The rendered table stays rectangular and every cell lands in a real `<td>`.

**Why widen (not merge-into-last-cell, not degrade-to-plain-text):** widening is the only option that keeps each cell's boundary legible AND is local to the offending row — a reader looking at a real model table sees all content in its own column, with just an unlabelled extra header. Merging surplus into the last cell jams two cells' text together (misreadable); dropping the whole table to plain text over-punishes an otherwise-valid table for one stray pipe. Degradation only ever moves content toward visible.

## Sibling row-sizing cases checked (verify section E)

A rule that sizes rows from a header has more than one way to drop content. Each was tested against reader-visible text:

- **Body row with FEWER cells than header** — safe pre-fix (missing cells render as empty `<td>`; nothing lost).
- **Header with no separator row** — safe; `tryTable` returns null → degrades to plain text, all content kept.
- **Separator whose column count DISAGREES with the header** — was a SECOND instance of this defect: `| M1 | M2 |` / `| --- | --- | --- |` / `| MIS-a | MIS-b | MIS-c |` lost `MIS-c` pre-fix. Fixed by the same widest-row sizing.
- **Cell containing an escaped pipe (`\|`)** — safe; `tableCells()` keeps it as one cell containing a literal `|`.
- **Table with no body rows** — safe; header renders, no tbody, nothing lost.

Found+fixed: the over-wide body row and the mismatched-separator-width variant. The other three were confirmed non-lossy.

## Context pack (grows — the "where to look", so no agent cold-starts)
- Files/functions in play: `public/lib/dom.js` — `tryTable()` (~line 249); the fix is `cols = Math.max(header.length, …bodyRows.map(c=>c.length))` plus header/body loops running to `cols`. `tableCells()` (escaped-pipe split) unchanged.
- Repro test: `npm run verify:bug-109` **section E** (folded into the BUG-109 real-browser suite — same renderer, same content-loss guarantee; no `package.json` change was in this lane). Section E runs the LF/CRLF/lone-CR control, the five sibling cases, the transcript path, and light/dark captures (`docs/bugs/assets/BUG-110-{light,dark}.png`). Section F adds a synthetic truncated-stream replay of a CR-adjacent fence.
- Related tickets: BUG-109 (lone-CR fence content loss, same renderer; this was found by its clean-room); ARCH-006 (line-ending normalisation per-renderer); FEAT-081 (prose tables/links, `verify:feat-081`).
- Known dependencies / blockers: none.

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
