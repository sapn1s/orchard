```orchard-ticket
{
  "id": "BUG-137",
  "type": "bug",
  "title": "the pinned row shouted instead of being scannable",
  "summary": "In the sidebar nav a pinned session read as bold and brighter than every row around it, while the pin marker itself was a nearly invisible --ink-4 glyph. The weight came from .row.named, which lands on the same rows, so emphasis was carried by the type rather than by a mark the eye can lock onto mid-scroll.",
  "impact_if_we_wait": "Scanning the sidebar stays a reading task rather than a spotting one. Pinning a session that has not been renamed produces almost no visible change at all, so the feature reads as not working; pinning one that has been renamed produces a shout.",
  "current_need": "Landed. CSS only.",
  "severity": "low",
  "area": "sidebar nav (session rows)",
  "reported": "2026-08-21",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-08-21",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A pinned row carries a small, distinctly coloured marker in a fixed column, visible at scrolling speed in both themes.",
    "A pinned row that has NOT been renamed is just as spottable as one that has -- the marker, not the type, carries the signal.",
    "The renamed treatment survives as a slight lift, at normal weight, no longer the loudest thing in the nav.",
    "The colour comes from the existing BUG-131 type tints, and is never moss (reserved for alive) nor the alarm/needs-you tints.",
    "BUG-086 still holds: the pin marker stays on the trailing edge and only aria-current keeps the active highlight."
  ],
  "code_refs": [
    {
      "path": "public/styles.css",
      "note": ".row .pin-mark -- the marker takes --st-prog; hover/aria-current lift within the same hue"
    },
    {
      "path": "public/styles.css",
      "note": ".row.named -- full ink + weight 500 becomes a slight ink lift at normal weight"
    }
  ],
  "related": [
    {
      "id": "BUG-086",
      "relation": "see_also"
    },
    {
      "id": "BUG-131",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "trivial",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": false,
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

# BUG-137 — the pinned row shouted instead of being scannable

## Diagnosis

The report was "a pinned row in the nav is bold and highlighted". At HEAD, `.row.pinned`
sets **no** weight and **no** background — so the report could not be taken at face value
and had to be measured rather than guessed at.

Measured against the user's REAL state (their `registry.json`, their real
`~/.claude/projects` transcript store — 13 projects, 31 rendered rows, the two genuinely
pinned sessions the store contains), the loud row is:

```
row pinned named fresh pin-last   font-weight: 500   color: rgb(230,233,229)   (= --ink)
row pinned fresh                  font-weight: 400   color: rgb(154,162,156)   (= --ink-2)
row  (plain)                      font-weight: 400   color: rgb(154,162,156)
```

So the weight and the brightness come from **`.row.named`**, not from `.pinned` — and they
land on the pinned row because a session worth pinning is a session worth naming. The two
pinned rows in the user's store show both halves of the same defect at once: the renamed
one shouts, and the un-renamed one is indistinguishable from every row around it apart
from a `--ink-4` bookmark at the far edge that you can only find once you have stopped to
look for it.

That is backwards for what a pin is for. Emphasis on the type competes with the row's own
title for the same channel; spotting a row mid-scroll wants a small mark in a fixed column
that the eye can lock onto while the list is moving.

## Evidence

Real running app, own server on a free ephemeral port, scratch `CLAUDE_STATION_DATA`
(a copy of the user's registry; the real transcript store read only), driven over CDP in
headless Brave at 2x, both themes, full 2060px sidebar height so both pinned rows are in
frame — screenshots read visually, not just asserted on.

Computed colours, after:

| | light | dark |
|---|---|---|
| `.pin-mark` | `rgb(78,119,168)` on rail `rgb(247,248,246)` | `rgb(127,166,206)` on rail `rgb(15,17,15)` |
| `.pin-mark`, open row / hover | `rgb(64,94,129)` (firmer) | `rgb(156,185,212)` (firmer) |
| `.row.named` | `rgb(58,62,60)` vs plain `rgb(83,87,85)` | `rgb(188,194,189)` vs plain `rgb(154,162,156)` |

The hover / `aria-current` lift is a mix toward `--ink`, so it darkens in light and
brightens in dark from one declaration — it never falls back to a grey, which is what the
old rules did and which would have faded the marker out exactly where the eye lands.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-21 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-08-21 — worker (dispatched lane)
- **Understood:** the reported "bold and highlighted" is real but its cause is `.row.named`,
  not `.row.pinned` — established by measuring the user's own two pinned sessions rather
  than a fixture, because a fixture would have encoded my guess about which class was
  responsible. A synthetic busy fixture (2 expanded projects, mixed pinned / renamed /
  running / open rows) was used alongside it to check the change does not turn a long list
  into a colour chart; it is synthetic and said so here.
- **Changed:** `public/styles.css` only, two rules.
  `.row .pin-mark` takes `--st-prog` — the slate blue of the BUG-131 type tints, chosen as
  the one tint in that set that is neither alarm (`--st-high`), nor needs-you
  (`--st-needs`), nor moss (reserved for "alive"). The `aria-current` / hover overrides
  stop resetting it to `--ink-2` / `--ink-3` and instead lift within the same hue.
  `.row.named` drops from `--ink` + weight 500 to a `color-mix` 45% of the way from
  `--ink-2` toward `--ink`, at normal weight: still legibly "someone chose this title",
  no longer the loudest thing in the nav.
- **Verified:** `npm run verify:bug-086-pin-style` 12/12 (the pin marker still rides the
  trailing edge; only `aria-current` keeps the active highlight; a pinned-not-open row is
  still visibly un-selected). `npm run verify:bug-101-contrast` ALL PASS both themes — the
  new `.row.named` mix sits between two tokens that already clear AA, and the marker is
  non-text ornament under WCAG 1.4.11 at ~4.3:1 in light, up from `--ink-4`.
  `npm run gate` → PASS, exit 0, read unpiped.
- **Not covered:** the reduced-motion and collapsed-sidebar variants were not re-shot;
  neither rule participates in either. No automated guard asserts the marker is *coloured*
  — `verify:bug-086-pin-style` asserts only that a glyph exists, so a future greyscale
  regression would pass it silently.
- **Symptom of a deeper design flaw?** Mild, and worth naming: two independent row
  signals (pinned, renamed) were both spent on the same channel — the row's own type —
  so they could not be read apart, and their combination read as a third thing that was
  never designed. The fix separates them: type carries "deliberately titled", the marker
  column carries "pinned".

### 2026-08-21 — worker
- **Landed:** Landed in 5328e3a. The reported symptom was real but misattributed to .row.pinned; measuring the user's own two pinned sessions put it on .row.named, and the un-renamed pinned row showed the mirror defect (no visible pin at all).
