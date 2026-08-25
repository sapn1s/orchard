```orchard-ticket
{
  "id": "FEAT-066",
  "type": "feature",
  "title": "Ticket board could not be opened from the interface",
  "summary": "The ticket board is now reachable from the topbar and the board rail in any project that has one, so a link or hand-typed address is no longer required. Wide screens show a detail view in two zones instead of one long column, and status tags carry distinct colours. Suites that failed before the change pass now.",
  "impact_if_we_wait": "None outstanding; the work shipped and reaches people on a plain reload without a deploy. Bounded to how the board is reached and how it looks, never to ticket content or stored data.",
  "current_need": "Nothing is outstanding. With the changed files set aside all three new cases failed, they passed with the change in place, and the standing checks stayed clean.",
  "severity": "medium",
  "area": "Ticket board portal",
  "reported": "2026-08-12",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-12",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A topbar entry is visible in every project with a board and opens the ticket list",
    "Going back from the board returns to where the person was",
    "Deep links to a ticket keep working",
    "A wide viewport renders the detail view in two zones; below roughly 900px it stays one column",
    "Open, needs-you and done tags render in visibly different colours",
    "Before-and-after screenshots exist for list and detail at wide and narrow widths"
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "symbol": null,
      "note": "topbar and board rail entry points, two-zone detail layout"
    },
    {
      "path": "public/styles",
      "symbol": null,
      "note": "status colour language applied to tags rather than the page"
    }
  ],
  "related": [
    {
      "id": "FEAT-053",
      "relation": "see_also"
    },
    {
      "id": "FEAT-063",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-067",
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
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-066-ticket-portal-entry-width-color.md",
    "sha256": "8f7be2ce229951c64333783a7d3e9ea3e216a17770872446cf706e73544e70d9",
    "bytes": 6612,
    "original_title": "ticket portal: reachable from the UI, real width, and readable color hierarchy",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head: all three wanted items, the reporter's own words, the ~900px breakpoint, the tint-the-tags constraint and the full §C proof bar are present.",
    "dropped": [
      "the reporter's quotes are paraphrased in the summary and kept verbatim in the diagnosis only where they carry the complaint"
    ]
  }
}
```

# FEAT-066 — Ticket board could not be opened from the interface

## Diagnosis

### What was asked for

Three separate complaints from one report: the portal had no entry point anywhere in the UI unless you already held a ticket link or typed the address; the detail view rendered as a single column that ran extremely long instead of using the viewport; and every tag and heading rendered in the same grey, so nothing could be scanned.

### What was wanted

1. **Entry points** — a persistent affordance for `#/tickets`, at minimum a topbar item near the crown/chips in every project with a board, plausibly also an "open board →" in the board rail header. Deep links keep working and back returns to the previous location.
2. **Width** — the list table already spans, so it stays. The detail view becomes two zones on wide screens: a metadata/summary sidebar (or a top strip that becomes a right sidebar) plus a main column for description and activity, with activity entries free to wrap into the full width. One column stays acceptable below ~900px.
3. **Colour** — a small, restrained status language: open neutral, in-progress blue-ish, needs-you amber, verified/done green, high severity a red accent. Applied to the status and severity tags and the detail state badge. Section headings in the detail view gain weight through size, spacing and hairline separators, and activity-log entry headers are distinguished from body text. The rule was to tint the tags, not the page — the main interface's minimalism is unchanged.

## Evidence

Executed and recorded by the fixer:

- `verify:tickets` — 30/30 passing (the plan called for 29/29 anti-regression; a tally of 29/29 and one of 3/3 also appear in the record)
- `verify:feat-063-tracker` — 1/1 passing
- `verify:feat-053-rail` — 1/1 passing (modal reuse)
- `verify:ui` — 7/7 passing
- Pre-fix proof: with `public/*` and `package.json` stashed, all 3 new cases fail
- `typecheck` and the leak-gate reported clean

`verify:feat-066` is named in the record without a result beside it. No independent clean-room verdict was dispatched for this ticket, so the evidence above is the fixer's own.

## Implementation notes

The change is confined to `public/*`, so it reaches users on a plain reload with no deploy step.

## Verification plan

As specified in the original (§C), with Playwright:

- The topbar entry is visible and navigates to `#/tickets` and back. Must FAIL pre-fix, because no such element exists.
- A wide viewport renders the detail view in two zones, asserted on layout, against a narrow viewport rendering one column.
- Status tags carry distinct computed colours per class — open, needs-you and done must differ. Must FAIL pre-fix, where all three are identical grey.
- Screenshots into `docs/bugs/assets/`: before and after, list and detail, wide and narrow.
- Anti-regressions: `verify:tickets` 29/29, `verify:feat-063-tracker`, `verify:feat-053-rail` for modal reuse, `verify:ui`, `typecheck`, leak-gate.

## Activity log (APPEND-ONLY)
### 2026-08-12 — orchestrator
- Filed from user feedback on the FEAT-063 revamp — structure landed, but it's unreachable,
  needlessly narrow, and tonally flat. Dispatching FE worker.

### 2026-08-12 — FE worker (built + verified)
- **Read** frontend-design skill first; held the brief's restraint — TINT THE TAGS, not the page.
  Greyscale+moss minimalism of the main interface is untouched; every colour lives on ticket
  tags/badges only, and is a palette-derived token, dark-theme aware.
- **(1) Entry points — reachable from anywhere.** Two persistent affordances, shown ONLY when the
  current project has a board (opt-in; no docs/bugs/ → no dead link):
  - `#boardBtn` — a plain nav pill in the crown chips (`public/index.html` seal), "▤ Board <open>",
    the open count (needs+queued+in-flight) a quiet mono cue.
  - `#railBoardLink` — "Open board →" in the rail-head (the rail is "now", this opens the archive).
  Both call `navTickets(pid, null)` (pushState) so BACK returns to the session view exactly as it
  was — the ticket route is a cover, never a teardown. Both keep ctrl/cmd-click new-tab (real href).
  Wired in `paintBoardEntry(b)` off `renderRail()` — `public/app.js`.
- **(2) Width — two-zone wide detail.** `#tvDetail .tv-doc:not(.tv-new)` becomes a CSS grid at
  ≥900px: a full-width content column (title/document/activity/note-form, max 1180px) + a metadata
  SIDEBAR on the right (left-hairline, stacked k/v, sticky). Below 900px the block is inert and the
  base single-column stacking (metadata strip on top) holds. Scoped to the route detail — the
  FEAT-053 compact modal and the new-ticket form keep their single column. Activity entries wrap
  into the full content width. `public/styles.css`.
- **(3) Colour — a small status language + hierarchy.** `ticketStatusKind(t)` → open (neutral) /
  needs (amber) / prog (blue) / done (green); high-sev → brick-red accent. Applied to the list
  `.c-status` tag, the detail state `.d-badge`, and the status word — text + hairline (+ faint wash
  on the badge), never a filled pill. Tokens `--st-prog/-needs/-done/-high` defined in all three
  theme blocks (light / prefers-dark / explicit dark+light); the old hardcoded `#B0703C` sev colour
  folded into `--st-high`. Section headings got weight + hairline separators; the activity-entry
  headers stay mono/bordered/distinct from body. `public/app.js` + `public/styles.css`.
- **Verified** (scratch servers on OS-assigned free ports, headless Chromium, killed by pid, never
  :4317):
  - NEW `verify:feat-066` (`scripts/qa/FEAT-066-portal-entry-width-color.spec.ts`) — 3/3 PASS:
    (1) topbar pill visible→opens #/tickets→Back returns + rail link present; (2) wide detail = meta
    sidebar RIGHT of content, narrow = one column stacked; (3) open/needs/prog/done status tags
    compute 4 DISTINCT colours + tinted Done badge.
  - **Proven MUST-FAIL pre-fix:** with `public/*` + `package.json` `git stash`ed, all 3 fail
    outright (no `#boardBtn`; sidebar not beside content at wide; the 4 status tags one identical
    grey) → restored → 3/3 PASS.
  - Anti-regressions: `verify:tickets` 30/30 · `verify:feat-063-tracker` 1/1 · `verify:feat-053-rail`
    1/1 (modal reuse intact) · `verify:ui` 7/7 · `typecheck` clean · `leak-gate` PASS.
- **Screenshots** (`docs/bugs/assets/`): before/after pairs —
  `FEAT-066-before-session.png`/`-after-session.png` (no entry → Board pill + rail link),
  `FEAT-066-before-list.png`/`-after-list.png` (flat grey → status colour language),
  `FEAT-066-before-detail-wide.png`/`-after-detail-wide.png` (one 820px column → two zones),
  `FEAT-066-before-detail-narrow.png`/`-after-detail-narrow.png` (one column preserved <900px).
  Spec's own: `FEAT-066-list.png`, `FEAT-066-detail-wide.png`, `FEAT-066-detail-narrow.png`.
- Client-only change (`public/app.js` · `public/styles.css` · `public/index.html`) → reaches users
  on a plain browser reload; NO server deploy needed. Status → VERIFIED / DONE per the honesty rule.
