```orchard-ticket
{
  "id": "BUG-251",
  "type": "bug",
  "title": "Pipe table without a preceding blank line renders as a paragraph",
  "summary": "In the transcript reading view, a GFM pipe table whose header is not preceded by a blank line (a bold caption sits on the line directly above it) renders as one run-on paragraph with the Markdown pipes shown literally, instead of as a table.",
  "impact_if_we_wait": "Any assistant reply that puts a caption on the line right above a pipe table — a common shape — shows the raw table source in the reading view, so the user cannot read the data the agent delivered.",
  "current_need": "Recognise a pipe table anywhere inside a blank-line-split block, not only when its header is the first line.",
  "severity": "medium",
  "area": "transcript reading view (dom.js prose)",
  "reported": "2026-10-11",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "in_verification",
  "human_action": "none",
  "updated": "2026-10-11",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "The real reported message rendered through renderAssistantText produces exactly 3 <table> elements with the expected header cells and no literal pipe source leaked.",
    "Must-FAIL: a pre-fix renderer (live dom.js with the fix reverted) renders that message as 1 table plus literal pipe text.",
    "Anti-regression: a lone pipe in prose stays a <p>, and a pipe table inside a code fence stays a <pre>.",
    "Anti-regression: a blank-line-separated table still renders, and multiple captioned tables with trailing lines in one block each render correctly."
  ],
  "code_refs": [
    {
      "path": "public/lib/dom.js",
      "symbol": "prose / tryTable / findTableStart",
      "note": "block split on /\\n{2,}/ (~l367); tryTable only matched a header at lines[0] (~l273); new findTableStart finds a header+separator pair anywhere in the block"
    },
    {
      "path": "public/lib/digest.js",
      "symbol": "renderAssistantText / renderVisible",
      "note": "the real render path: an orchard-answer block body goes through prose(), so the fix in prose() covers it"
    }
  ],
  "related": [],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": false,
    "Implementation notes": true,
    "Verification plan": false,
    "Migration and rollback": false,
    "Risks": false,
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

# BUG-251 — Pipe table without a preceding blank line renders as a paragraph

## Symptom
A GFM pipe table that is NOT preceded by a blank line renders as a run-on paragraph with the Markdown pipes shown literally, instead of a table. Seen in the transcript reading view of an assistant reply whose model put a bold caption on the line directly above the table header, e.g. a caption line then `| Item | Product | € | Link |` then the `|---|---|` separator, with no blank line between the caption and the header.

## Repro
Open a session whose assistant reply contains, inside an `orchard-answer` block, a bold caption line immediately followed (no blank line) by a GFM pipe table header + separator + rows. The caption, header, separator and rows all share one block and render as one paragraph with literal `|` characters. Real instance: the last assistant message (uuid 86f4f7f8-29b0-4fcc-85ee-c0b6c4bd2855) of the facebook-marketplace session 4846de18-9f50-41d2-901d-564d93148b9a — two of its three tables carried a bold caption directly above the header and collapsed; the one table preceded by a blank line rendered fine.

## Expected
Each pipe table renders as a real `<table>`, the caption above it renders as its own paragraph, and no pipe source text leaks into the page — whether or not a blank line separates the caption from the table.

## Diagnosis
`prose()` (public/lib/dom.js) splits a message body into blocks on `/\n{2,}/` (blank lines) at line ~367, and `tryTable()` (line ~273, separator check ~275) only recognised a table when the header row was `lines[0]` of the block. A caption on the line above the header (no blank line) makes `lines[0]` a non-pipe line, so `tryTable` returned null and the whole block fell through to the paragraph path, which joins every line with a space.

## Implementation notes
Added `findTableStart(lines)` (public/lib/dom.js) that scans a block for the first line containing `|` immediately followed by a valid separator row (the same strict `cellAlign` test `tryTable` already uses, so a lone `|` in prose does not trip it). In the block loop, when a table starts at index `i`: render `lines[0..i-1]` through the normal prose path (recursion, preserving inline/line-break behaviour), bound the table body at the first line with no `|`, render `lines[i..end]` as the table, and re-run the remainder as prose — which re-enters the scan, handling multiple tables in one block and trailing non-table lines.

## Context pack (grows — the "where to look", so no agent cold-starts)
- Files/functions in play: public/lib/dom.js (`prose`, `tryTable`, new `findTableStart`); rendered end-to-end through public/lib/digest.js `renderAssistantText` → `renderVisible` → `prose`.
- Related tickets: BUG-234 (same reading view, different cause — server-side truncation losing a fence); BUG-167 (sibling: bulleted list after a lead-in line collapsed the same way).
- Repro test: `npm run verify:bug-251` (scripts/verify-bug-251-table-after-leadin.mjs).
- Known dependencies / blockers: none. Live service needs a restart to pick up the static-asset change (user does that).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-11 — fixing lane (agent)
- **Understood:** Confirmed the diagnosis against the real code and the real transcript. `prose()` splits on blank lines and `tryTable` only fired on `lines[0]`; the real message's two captioned tables collapsed, the one blank-line-preceded table rendered.
- **Changed:** public/lib/dom.js (added `findTableStart`, rewrote the in-block table branch to find/bound a table anywhere in the block and re-run the remainder as prose); scripts/verify-bug-251-table-after-leadin.mjs (new); package.json (added `verify:bug-251` — pending, file was lock-held at write time). No commit (agent does not git-write).
- **Verified:** `node scripts/verify-bug-251-table-after-leadin.mjs` — 17/17 PASS. Drives the REAL `renderAssistantText` over the REAL reported message in headless brave, both themes, with graded light/dark screenshots (docs/bugs/assets/BUG-251-light.png, BUG-251-dark.png). Must-FAIL baseline is the live dom.js with the fix string-reverted (a pre-fix digest.js imports it), NOT anchored to HEAD: pre-fix renders 1 table + literal "| Item | Product" pipe text; fixed renders exactly 3 tables (headers Item/Product/€/Link ×2, Date/What) with zero leaked pipes and the captions preserved. Edge/anti-regression PASS: lone `|` in prose stays a <p>; pipe table inside a code fence stays <pre>; blank-line-separated table still renders; two captioned tables in one block → two tables; trailing non-table line after a table → <p>; captioned table inside an orchard-answer block renders. `npm run gate` → PASS (exit 0).
- **Still open / handoff:** Independent clean-room verify warranted (renderer, regression-prone file shared with BUG-167/BUG-234): attack the table/paragraph boundary with inputs my fixture did not model (e.g. a separator-looking row that is not a real table, nested quote levels, a table whose body row has no pipe). work_state left in_verification.
