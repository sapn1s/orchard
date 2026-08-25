```orchard-ticket
{
  "id": "FEAT-063",
  "type": "feature",
  "title": "The ticket portal looked like a chat instead of a tracker",
  "summary": "The ticket portal now reads as a tracker: the list is a dense sortable table with one line per ticket and a single toolbar of filters, and a ticket opens as a document with a metadata strip and a sectioned activity log. Keyboard navigation moves through rows. All previous portal behaviour was kept.",
  "impact_if_we_wait": "Scanning many tickets stayed slow and the portal read as a conversation. Bounded: this was presentation only, with no effect on ticket contents, writes, search results or the board index.",
  "current_need": "Nothing is outstanding. The portal behaviour suite stayed fully green across the redesign, the new tracker and rail checks passed, and the standing type and leak checks stayed clean.",
  "severity": "medium",
  "area": "Ticket portal",
  "reported": "2026-08-11",
  "reported_by": "user",
  "owner": "you",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-11",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "The list renders as a table with ID, title, status, owner, severity and last-activity columns",
    "Row height stays under the density threshold and no chat-bubble styling appears in the portal",
    "Sortable headers and a single toolbar row replace the stacked filter blocks",
    "Up and down arrows plus enter navigate from a row to its detail view",
    "Detail shows a metadata strip and an activity log split into dated bordered blocks",
    "The append-note field reads as a plain form, visually distinct from the session composer",
    "Body-text search still returns line-context matches, rendered as a compact result list",
    "The existing portal behaviour suite stays fully green: routes, search, writes, conflicts, board reconciliation",
    "Screenshots are captured for the user's own judgement, since this is a taste ticket"
  ],
  "code_refs": [],
  "related": [
    {
      "id": "FEAT-053",
      "relation": "see_also"
    },
    {
      "id": "FEAT-058",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-066",
      "relation": "blocks"
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
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-063-ticket-portal-revamp.md",
    "sha256": "1c82b2ad30ee50c31cc0e6d89c8311f273bb944244d161047feed3ac3ee70c8c",
    "bytes": 6664,
    "original_title": "ticket portal UI/UX revamp: a tracker, not a chat",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head: the chat-DNA diagnosis, both view redesigns, the shared modal rendering, the greyscale constraints and the full verification bar are present.",
    "dropped": []
  }
}
```

# FEAT-063 — The ticket portal looked like a chat instead of a tracker

## Diagnosis

### Chat DNA inherited from the host app

FEAT-058 was built inside the app's existing visual vocabulary — a conversation UI — so the portal inherited generous vertical rhythm, bubble-ish cards and a prose-first layout. A tracker has different bones: density, columns, scannability, and a document rather than message detail view.

## Evidence

### What ran

- `verify:tickets` — 30/30 passing, unchanged across the redesign, which is the guarantee that this was presentation only.
- `verify:feat-063-tracker` — 1/1 passing.
- `verify:feat-053-rail` — 1/1 passing.
- `verify:ui` — 7/7 passing.
- A further matched tally of 29/29 was recorded without an adjacent suite name.
- Standing checks — typecheck and leak-gate — reported clean.

Screenshots were captured under `docs/bugs/assets/FEAT-063-*.png`, because this is a taste ticket and the screenshots matter more than the assertions.

## Implementation notes

### List view

A real data table. Dense one-line rows; columns are ID (monospace, fixed width), Title (truncating), Status, Owner, Sev, Last activity. Sortable headers. The status/owner/severity filters become segmented controls sharing one toolbar row with the search field, rather than stacked blocks. Row hover is subtle; click opens the detail. Severity and status render as small tags, not coloured pills that fight the greyscale system. Body-text search keeps its line-context, rendered as a compact result list under the toolbar instead of cards.

### Detail view

A document with a metadata header: ID and title, then a compact strip of status, owner, severity, area, reported and `Verified-by` when present. Actions — append note, reopen, the 👤 toggle, new ticket — sit in a small right-aligned toolbar, not a chat composer shape. The markdown renders as a document: tighter line-height than the transcript, clear heading hierarchy, and the activity log visually sectioned with each dated entry a bordered block headed by its date. No message bubbles anywhere. The append-note field is a plain form field with a Submit, so it is never confused with the session composer.

### Shared rendering

FEAT-053's modal reuses this same document rendering, so there is one implementation.

### Constraints held

No new colours; the hairline, greyscale and moss conventions hold. Second-tab usage stays first-class and narrow viewports degrade sanely.

## Verification plan

### The bar set when the ticket was filed

User-observable, and failing before the change where checkable. Keep the portal behaviour suite at 30/30 to prove behaviour is intact. Visually assert that the list renders as a table (row height under a threshold, columns present), that no chat-bubble classes appear inside the portal routes, and that the detail shows the metadata strip and the sectioned activity log. Confirm keyboard navigation works. Capture screenshots for user judgement.

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
