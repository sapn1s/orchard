# FEAT-081 — in-app Guide viewer should render GFM tables and links (currently flattened to raw text)

- **Status:** VERIFIED
- **Area:** public/lib/dom.js `prose()` (the FEAT-075 guide renderer) + styles
- **Reported:** 2026-08-14 (found by the FEAT-080 arch-doc cross-provider critique)

## Problem
The in-app Guide viewer renders markdown via `prose()` (public/lib/dom.js ~148-219): headings, paragraphs,
lists, code, emphasis, and offline mermaid — but NOT GFM tables (`| a | b |`) or `[text](url)` links.
Confirmed in a real browser: existing guide pages (e.g. orchestration.md) render their tables as raw pipe
text and links as literal `[text](url)`. This directly blocks the user's stated want for the architecture
doc — "tables/coloring where useful" — since a table is the natural shape for `subsystem → provides → why`
but renders as unreadable raw text in-app.

## Wanted
Extend `prose()` to render:
- GFM pipe tables → real `<table>` (header row + separator + body), styled to match the guide (hairline
  borders, readable, works light/dark).
- `[text](url)` inline links → `<a>` (in-app/relative links navigate within the guide; external open safely).
Keep it a minimal, dependency-free extension of the existing renderer (no new markdown library, no second
renderer) — consistent with FEAT-075.

## Verification (§C)
- Render a fixture page with a table + inline links in real headless brave: assert a `<table>` with the
  right rows/cells exists (not raw pipe text) and `<a href>` links resolve (must-FAIL pre-fix: raw
  `|`-text and literal `[..](..)`). Assert existing pages (orchestration.md) now render their tables too.
- Anti-regress: verify-feat-075-guide-viewer, verify:ui, typecheck, leak-gate.
- Risk: client renderer (low); reaches users on reload.

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
