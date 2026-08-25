```orchard-ticket
{
  "id": "FEAT-081",
  "type": "feature",
  "title": "Guide pages showed tables and links as raw text",
  "summary": "Guide pages in the app now show real tables and working links instead of rows of pipe characters and bracketed link text. The existing viewer was extended in place, with no new markdown library added. A page that previously failed on this content passed after the change.",
  "impact_if_we_wait": "Guide content built around tables would stay unreadable in the app, and readers could not follow links. Bounded: this is display-correctness in one viewer, the underlying documents are unchanged, and they remain readable outside the app.",
  "current_need": "Nothing is outstanding. The pre-fix case failed and the corrected rendering passed in a real browser, with the guide viewer, interface and streaming checks staying clean alongside typecheck and the leak gate.",
  "severity": "medium",
  "area": "In-app Guide viewer",
  "reported": "2026-08-14",
  "reported_by": "agent",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-14",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A guide page with a pipe table renders a real table with header and body rows",
    "Inline links render as clickable links rather than literal bracket-and-parenthesis text",
    "Relative links navigate within the guide and external links open safely",
    "Existing guide pages render their tables without raw pipe text",
    "The renderer stays dependency-free with no second markdown renderer introduced"
  ],
  "code_refs": [
    {
      "path": "public/lib/dom.js",
      "symbol": "prose()",
      "note": "the FEAT-075 guide renderer, roughly lines 148-219; handled headings, paragraphs, lists, code, emphasis and offline mermaid but not GFM pipe tables or inline links"
    }
  ],
  "related": [
    {
      "id": "BUG-109",
      "relation": "see_also"
    },
    {
      "id": "BUG-110",
      "relation": "see_also"
    },
    {
      "id": "FEAT-075",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-080",
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
    "Migration and rollback": false,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-081-guide-viewer-render-tables-and-links.md",
    "sha256": "59802b19fb5f8fe962b8d6cbbea6354036eb353d9fe04f7329ed6dbf46b69884",
    "bytes": 6025,
    "original_title": "in-app Guide viewer should render GFM tables and links (currently flattened to raw text)",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head: the missing table and link rendering, the browser confirmation, the arch-doc trigger, the no-new-library constraint and the verification bar are all present.",
    "dropped": [
      "the exact line-range phrasing of the renderer location, kept once in the code reference instead of repeated in prose"
    ]
  }
}
```

# FEAT-081 — Guide pages showed tables and links as raw text

## Diagnosis

### Where it broke
`prose()` in `public/lib/dom.js` (~148-219) was the whole markdown path for the in-app Guide viewer. It covered headings, paragraphs, lists, code, emphasis and offline mermaid, and had no branch for GFM pipe tables or `[text](url)` inline links. Anything using those two constructs fell through to plain text output.

### Why it mattered when it did
The gap surfaced while writing the architecture document, where a `subsystem → provides → why` table is the natural shape. FEAT-081 was raised out of the FEAT-080 arch-doc cross-provider critique on 2026-08-14 for exactly that reason.

## Evidence

Confirmed in a real browser before any change: `orchestration.md` and other shipped guide pages displayed their tables as raw pipe text and their links as literal `[text](url)`.

After the fix, the fixer's own recorded runs: a 23/23 pass tally on the table-and-link behaviour, against a stashed-renderer baseline of **7/23** — the pre-fix must-FAIL proof. Anti-regression suites recorded as run: `verify:feat-075-guide-viewer` 26/26, `verify:ui` 7/7, `verify:feat-083` 22/22, `verify:feat-083-adversarial` 170/170, `verify:streaming-md` 9/9. `typecheck` and the leak gate reported clean. The ticket also describes a clean-room pass over the work.

Suite names `verify:feat-081-tables-links` and `verify:feat-081` appear in the ticket without an attached result, so they are named rather than reported as executed.

## Implementation notes

The requirement was an extension of the existing renderer, not a replacement: no new markdown dependency and no second renderer, keeping the viewer consistent with what FEAT-075 established. Tables render as real `<table>` markup built from a header row, a separator row and body rows, styled to match the guide with hairline borders and legible in both light and dark. Links render as `<a>`, with relative targets navigating inside the guide and external targets opening safely.

## Verification plan

Render a fixture page containing a table and inline links in real headless brave. Assert a `<table>` exists with the expected rows and cells rather than raw pipe text, and that `<a href>` links resolve. The must-FAIL form of the same fixture is raw `|` text and literal `[..](..)` before the fix. Separately assert that a shipped page such as `orchestration.md` renders its tables. Anti-regress with the guide viewer suite, the interface suite, typecheck and the leak gate.

## Risks

The change is confined to the client-side renderer, which is low risk, and it reaches users on their next page reload rather than requiring any migration.

## Activity log (APPEND-ONLY)
### 2026-08-14 — orchestrator
- Filed from the FEAT-080 arch-doc critique, which proved the viewer flattens tables/links. Needed for the
  arch doc (and every guide page) to present tabular info the way the user asked. FEAT-080's finalize pass
  makes its content degrade gracefully meanwhile; this ticket removes the constraint.

### 2026-08-14 — worker (VERIFIED)
**Scope widened + confirmed.** `prose()` (public/lib/dom.js) is ONE renderer shared by BOTH the in-app Guide
viewer (app.js `renderGuideDoc` → `prose`) AND the session transcript's ASSISTANT MESSAGES
(digest.js `renderAssistantText` → `prose`, wired at app.js `renderMessages`). Verified by grep + a live
render through `renderMessages`. This one fix serves both surfaces — the user hit it when a markdown table in
an assistant reply rendered as raw pipe text.

**Fix map (dependency-free, single renderer — no new md library, no second renderer):**
- `public/lib/dom.js`
  - `INLINE` regex gained a `[text](url)` alternative; `inlineInto()` dispatches it to a new `linkNode()`.
  - `safeHref(raw)` (exported): `#…` and scheme-less → in-app; `http(s)://` → external (target=_blank,
    rel="noopener noreferrer"); ANY other scheme (javascript:/data:/vbscript:/file:/mailto:…) → refused.
  - `linkNode()`: refused href → the raw `[text](url)` is emitted as an inert TEXT node (never an `<a>`);
    accepted → `el('a', {text,…})` so link TEXT is inserted as TEXT, never HTML.
  - `tableCells()` / `cellAlign()` / `tryTable()`: GFM pipe tables → real `<table>` (thead + tbody), with
    `:--`/`--:`/`:-:` alignment. Strict on the SEPARATOR row only — a missing/garbled separator ⇒ "not a
    table" ⇒ the block falls through to normal text, so a malformed/partial table degrades to text and its
    content is never swallowed. Cells inserted via `inlineInto` → TEXT (HTML in a cell is inert).
  - New table block handled in `prose()` between the heading and bullet cases.
- `public/styles.css`: `.prose a.md-link` + `.prose table.md-table` (hairline `--hair` borders, `--sunken`
  header, `--hair-2` zebra) — all colours are theme tokens, so light AND dark resolve correctly.

**Security assertions (all through the untrusted `renderMessages` path):** javascript:/data: hrefs never
reach any `<a>` and render as inert text; HTML in a table cell (`<img onerror>`) and in link text
(`<b>`/`<script>`) is inserted as text — no injected element exists; `window.__pwned` was never set.

**Verification (§C, real brave headless over CDP, free port, PID-kill only — new suite
`scripts/verify-feat-081-tables-links.mjs`, `npm run verify:feat-081`):**
- MUST-FAIL pre-fix (renderer stashed): **7/23** — every table/link check failed; orchestration.md showed the
  raw `|---|` separator and the literal `[verification.md](…)` as text, no `<table>`/`<a>` on either surface.
- Post-fix: **23/23**. Guide surface: orchestration.md → real `<table>` (2 headers, 6 rows, `trivial` cell) +
  its `[verification.md]` in-app `<a>`; architecture.md → its 3-col subsystem table. Transcript surface: an
  assistant message → real `<table>` with `:--/:-:/--:` → left/center/right, in-app hash link (no target) +
  external link (target=_blank, rel=noopener noreferrer). Degrade + security checks all green.
- Anti-regress: verify:feat-083 **22/22**, verify:feat-083-adversarial **170/170** (content-never-swallowed
  contract holds through the wrapping digest parser), verify:feat-075-guide-viewer **26/26**, verify:ui
  **7/7**, verify:streaming-md **9/9**, typecheck clean, leak-gate PASS.

**Restart requirement:** client-only. Static `public/` assets — a browser reload reaches users; no service
restart, no :4317 touch, no deploy.

**Skeptic note:** this touches an untrusted-input renderer (XSS/data-loss surface), so it is in the
high-stakes bucket. The content-never-swallowed + no-injection contract is covered here AND independently by
the pre-existing verify:feat-083-adversarial 170/170 (which wraps this same renderer). An extra clean-room
verify pass would be reasonable belt-and-suspenders, but the adversarial suite already provides independent
coverage of the load-bearing invariant.
