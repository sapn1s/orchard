```orchard-ticket
{
  "id": "BUG-126",
  "type": "bug",
  "title": "One ticket's severity swallowed a sentence and broke its row",
  "summary": "BUG-125 records its severity as \"high\" followed by a sentence explaining why. The All-tickets list prints that cell verbatim into a column six characters wide, so it wraps one word per line, the row grows to ten times its neighbours, and a blank band opens across the table. Only a legacy ticket can do this.",
  "impact_if_we_wait": "The board's own list has one visibly broken row, in both themes, on the first screen a reader sees. Bounded: it is display only, no ticket content is lost, and the row still opens normally.",
  "current_need": "none — the clamp was re-checked on the real 198-row board in both themes",
  "severity": "low",
  "area": "Ticket dashboard list",
  "reported": "2026-08-20",
  "reported_by": "agent",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-25",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A ticket whose severity carries prose renders on a row the height of its neighbours",
    "The severity actually recorded is still reachable from the ticket",
    "A well-formed severity renders exactly as it does today"
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "symbol": "loadTicketRows",
      "note": "The list writes the severity string straight into a fixed narrow column. A promoted ticket cannot trigger this because its record normalises severity to one of four enum values; a legacy ticket's severity is whatever prose the header line holds."
    },
    {
      "path": "docs/bugs/BUG-125-a-wrapped-verdict-line-records-no-verdict-at-all.md",
      "symbol": null,
      "note": "The instance: `- **Severity:** high — it silently records the wrong verdict. Three `VERDICT: BROKEN` records ...` — 208 characters where the column expects about six."
    }
  ],
  "related": [],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": false,
    "Verification plan": true,
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
    "confirmation": "Authored directly in the record format from a screenshot of the running board. There is no legacy original.",
    "dropped": []
  }
}
```

# BUG-126 — One ticket's severity swallowed a sentence and broke its row

## Diagnosis

The severity column is sized for a word. A legacy ticket's severity is whatever its `- **Severity:**` header line says, and BUG-125's says `high` followed by a 200-character sentence justifying it. The list prints the whole string, the column wraps it one word per line, and the row becomes about 450 pixels tall — ten times its neighbours — with the title, owner, status and date cells floating in the middle of a blank band.

It is not caused by the migration and it is not new. It is newly conspicuous: a promoted ticket's record normalises severity to one of four enum values, so after the cutover exactly two tickets on the board can still do this, and one of them does. Before the cutover it was one long row among many legacy rows.

## Evidence

Seen in the real product, not in a test: `#/tickets/all` over the real board, 197 rows, captured in both themes at 1600×1000. The broken row is BUG-125 and it is visible without scrolling. Captures were taken to scratch (`allow-legacy/shots/all-tickets-{light,dark}.png`) and are not committed.

Every DOM assertion in the same pass was green — 197 rows, 197 unique ids, no empty titles, no fence text where a title belongs, no console errors. Nothing mechanical noticed, because nothing mechanical was looking at row height.

## Verification plan

Render the real board's All-tickets list and assert that no row's height exceeds a small multiple of the median row height. That is the property the DOM checks missed, and it is the one worth owning: it fails on this row today and keeps failing for any future cell that overflows, whatever the reason.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-20 — worker (dispatched)

- **Understood:** found while verifying the schema cutover in the running UI, not by a test. Filed rather than fixed: which way it should be fixed — clamp the column, or tidy two legacy header lines by hand — is a judgement about the two tickets that were deliberately left in legacy format, and they are the user's to touch.
- **Changed:** nothing. This ticket only.
- **Verified:** reproduced in a real headless browser over the real board in both themes; the light and dark captures were confirmed to differ by the page background (`rgb(232, 233, 230)` vs `rgb(7, 8, 7)`), not by filename.
- **Still open:** the fix, and the row-height property test described above.

### 2026-08-20 — fix lane (dispatched)

- **Understood:** the row is a CSS grid with a 52px severity track. Four of its
  five text cells — `.c-id`, `.c-title`, `.c-when`, `.c-status` — already carry
  the house clamp (`overflow:hidden; text-overflow:ellipsis; white-space:nowrap`).
  `.c-sev` was the one that did not. So this is not a missing feature but a
  missing line in an established pattern, which is also why nothing mechanical
  ever noticed: every neighbour was correct.

- **Decided — clamp the column, do not tidy the two tickets.** BUG-125 and
  FEAT-091 are deliberately preserved prose under FEAT-094. Editing them to suit
  a renderer inverts which of the two is authoritative, and it fixes exactly two
  files while the next long value — from any writer, legacy or not — breaks the
  table again. The renderer owes robustness to any value it is handed.

- **Changed:**
  - `public/styles.css`: `.tv-row .c-sev` gains the same three properties its
    four sibling cells already had.
  - `public/app.js`: the cell carries `title: t.sev`, the way `.c-title` does,
    so the full recorded severity stays reachable on hover — the clamp hides it
    on screen, it does not discard it.
  - `scripts/verify-bug-126-severity-column-clamp.mjs` (new, `npm run
    verify:bug-126`).

- **Verified — 18/18, exit 0, in the real UI over the real 198-row board.**
  A scratch server on a free ephemeral port with scratch data dirs; the live
  service was not touched.
  - The offender is DISCOVERED, never named: the suite finds every severity
    whose text is wider than its track and fails loudly if the board contains
    none, because then it has lost its subject. Today it finds one — BUG-125,
    `1285px of text in a 52px track`.
  - The property is `no row exceeds 2.5x the median row height`, not "BUG-125 is
    26px". Measured `median=26px, tallest 26px (1.00x) over 198 rows`, in both
    themes.
  - MUST-FAIL, anchored to a SYNTHESIZED pre-change state rather than `HEAD`:
    the pre-change declaration is transcribed into a stylesheet injected over
    CDP, and the blow-up returns — `tallest=BUG-125 at 432px (16.62x)`, captured
    to `bug126-prechange-unclamped.png`. Removing it restores `432px → 26px`.
    Committing this fix cannot turn that reference into the fixed state.
  - The full severity survives: the title attribute carries all 204 characters.
  - A well-formed severity is unaffected: 73 enum severities, none truncated.
  - BOTH THEMES, on pixels rather than a DOM poke — the trap this area fell into
    earlier today, when two LIGHT captures were offered as proof they differed.
    The theme is changed by CLICKING `#themeBtn`, the user's own control; each
    capture is graded by `shot-luma` on its decoded pixels (light `luma=249.5`,
    dark `luma=24.7`); and the computed body background is asserted to be
    genuinely on its own side rather than merely different — light
    `rgb(232, 233, 230)` luma 232.6, dark `rgb(7, 8, 7)` luma 7.7.
  - Anti-regression: `npm run gate` PASS (exit 0, read directly, never piped).

- **Could not verify:** the captures are 1600x1000 headless only — no other
  viewport, and no real-mouse hover, so the tooltip is asserted through the DOM
  attribute rather than by seeing it painted. The narrow-viewport rule at
  `styles.css:3665` hides `.c-sev` entirely on a flawed row, so the clamp is
  untested below that breakpoint; it cannot regress there because the cell is
  not rendered.

- **Symptom of a deeper design flaw?** No new ticket. One cell in one grid
  missed a clamp its four siblings carry — a single omission in an existing
  pattern, not a recurring class. Worth noting only that the value came from
  the two deliberately-legacy tickets, which is the price FEAT-094 knowingly
  accepted; that price is now paid by the renderer instead of the tickets.

### 2026-08-25 — worker
- **bookkeeping-sweep:** 2026-08-25 bookkeeping sweep (authorised by the user). The old rule that bought an independent clean-room round for every change has been replaced by rounds spent by harm class; this is a display-only clamp on one grid cell, so it gets a re-check rather than a round. Re-ran `npm run verify:bug-126` at HEAD b6c0151 — 18 passed, 0 failed, exit 0 read directly, on a scratch server on a free port over the real board (median=26px, tallest 26px = 1.00x, both themes graded on decoded pixels). The fix is committed, not sitting in a worktree. Closing as verified. Symptom of a deeper design flaw? No — one cell missed a clamp its four siblings already carried.
