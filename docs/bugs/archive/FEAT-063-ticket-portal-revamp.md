# FEAT-063 — ticket portal UI/UX revamp: a tracker, not a chat

- **Status:** VERIFIED / DONE
- **Area:** claude-station UI — the #/tickets views (FEAT-058)
- **Reported:** 2026-08-11 by user ("ticket portal needs ui/ux revamp — it currently seems to
  replicate this chat style instead of a ticket system")

## Diagnosis
FEAT-058 was built inside the app's existing visual vocabulary — a conversation UI — so the portal
inherited chat DNA: generous vertical rhythm, bubble-ish cards, prose-first layout. A tracker has
different bones: density, columns, scannability, and a document (not message) detail view.

## Direction (minimal-Jira/Linear-lite, still greyscale+moss+hairlines)
LIST VIEW = a real data table:
- Dense rows (one line each), columns: ID (monospace, fixed width), Title (truncating), Status,
  Owner, Sev, Last activity. Sortable headers; the current filters become compact controls in a
  single toolbar row (status/owner/sev segmented + the search field), not stacked chat-style blocks.
- Row hover = subtle; click = detail. Sev/status as small tags, not colored pills that fight the
  greyscale system. Keyboard: up/down + enter navigates.
- Keep body-text search with line-context, but render matches as a compact result list under the
  toolbar, not as cards.
DETAIL VIEW = a document with a metadata header:
- Header block: ID + title, then a compact metadata strip (status, owner, sev, area, reported,
  Verified-by if present). Actions (append note / reopen / 👤 toggle / new ticket) as a small
  toolbar, right-aligned — not chat-composer-shaped.
- The ticket markdown renders as a DOCUMENT: tighter line-height than the transcript, headings with
  clear hierarchy, the Activity log visually sectioned (each dated entry a bordered block with the
  date as a small header). No message bubbles anywhere.
- The append-note field is a plain form field with a Submit — visually distinct from the session
  composer so the two are never confused.
- FEAT-053's modal reuses this same document rendering (one implementation).

## Constraints
- No new colors; hairline/greyscale/moss conventions hold.
- All FEAT-058 behavior preserved exactly (routes, search, writes, concurrency 409s, board
  reconciliation) — this is presentation, verified by keeping verify:tickets 30/30 green.
- Second-tab usage stays first-class; narrow viewport degrades sanely.

## Verification (user-observable; must FAIL pre-change where checkable)
verify:tickets 30/30 unchanged (behavior intact); visual assertions: the list renders as a table
(row height under a threshold, columns present), no chat-bubble classes inside #/tickets, detail
shows the metadata strip + sectioned activity log; keyboard navigation works; screenshots
docs/bugs/assets/FEAT-063-*.png for user judgment (this is a taste ticket — screenshots matter more
than assertions).

## Activity log (APPEND-ONLY)
### 2026-08-11 — orchestrator
- Filed from user feedback. Queued behind the running UI batch (same files). Design direction
  stated so the builder doesn't re-derive taste; screenshots are the real acceptance artifact.

### 2026-08-11 — agent (FEAT-063 builder)
- **Built** the revamp per the direction above — presentation only, zero server changes.
  - LIST: one toolbar row (status/owner/sev selects + the search field now share `#tvFilters`);
    the `#tvSort` select is GONE — column headers sort (click toggles direction, `aria-sort`
    exposed, activity defaults newest-first, other columns ascending). Rows densified to one
    26px line; Status renders as a small hairline TAG (greyscale; sev keeps the existing
    high-only tint). Keyboard: ↑/↓ move a cursor row (inset moss hairline), Enter opens —
    list-only, never over form controls, the modal, or the detail.
  - DETAIL: a document. `← all tickets` + a small RIGHT-ALIGNED toolbar (Reopen / Mark 👤) on
    the top line; then mono-ID + title, then a compact horizontal metadata STRIP (state badge,
    status, owner, sev, area, reported, verified-by, activity, file — reported/verified-by read
    from the file itself, never invented). The file's own H1 (a verbatim repeat of that header)
    is folded away by CSS; the header bullet-list renders compact mono. The Activity log is
    SECTIONED — `sectionActivityLog()` re-parents prose() output so each dated entry becomes a
    bordered block with its date-heading as the block header (pure DOM moves, every node
    survives byte-identical). The append-note field is a plain labeled form UNDER the log
    ("Add to the Activity log" + right-aligned Append) — nothing composer-shaped remains.
  - FEAT-053 modal reuse intact: `ticketDetailNode(t, {compact})` is still the single renderer;
    both write surfaces carry `.tv-acts` so the compact/modal embed excludes all writes at once.
- **Files:** public/index.html (toolbar restructure), public/app.js (sort/keyboard/detail),
  public/styles.css (tv-* section), scripts/qa/FEAT-063-tracker-visual.spec.ts (new),
  package.json (verify:feat-063-tracker script only).
- **Verified** (all against scratch servers on OS-assigned ports, never :4317):
  - `verify:tickets --no-model` — 29/29 PASS pre-change (baseline) AND post-change: every
    FEAT-058 behavior (search/writes/409s/board reconciliation/second tab) survives untouched.
  - `verify:feat-053-rail` — 1/1 PASS (modal reuse, caps, wheel chaining).
  - `verify:ui` — 7/7 PASS. `typecheck` — clean.
  - NEW `verify:feat-063-tracker` — 1/1 PASS: row height < 34px with all six columns, no
    chat-bubble markup (`.you`/`.needs-card`/`.dock`) inside `#ticketsView`, search lives in the
    single toolbar + `#tvSort` gone, header sort asc/desc + severity ranking, keyboard cursor +
    Enter-opens, metadata strip carries the file-only facts, activity entries are bordered
    blocks, note form sits under the log. (Non-vacuous: 2–5 fail outright pre-change.)
  - `leak-gate` — PASS. (It was CRASHING on this tree: `git ls-files -co` emits directory
    entries for nested agent worktrees under `.claude/worktrees/`, and readFileSync EISDIR'd.
    One-line defensive fix included: skip non-regular-file entries. Pre-existing gate bug, not
    caused by this change.)
- **Screenshots** (acceptance artifacts): docs/bugs/assets/FEAT-063-before-list.png /
  FEAT-063-before-detail.png (chat DNA) vs FEAT-063-list.png / FEAT-063-detail.png (tracker).
  The regenerated FEAT-058-*.png show the new shape in the dark theme.
- Status → VERIFIED / DONE per the honesty rule: suites green, screenshots show tracker bones.
  This is a taste ticket — if the user's eye disagrees, reopen with the verdict.
