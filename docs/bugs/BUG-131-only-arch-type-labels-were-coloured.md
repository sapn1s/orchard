# BUG-131 — only ARCH type labels were coloured

- **Status:** FIXED — feat/bug/deploy now carry their own tint; verified in the real board, both themes.
- **Severity:** low
- **Area:** board dashboard (digest rows)
- **Reported:** 2026-08-20 by the user
- **Verification-class:** trivial (a CSS-only render change; no logic, no state, no data path)

## Symptom
On the main board, the type labels beside each ticket id should each be coloured by type.
Only `arch` was — the blue outlined ◆ chip. `feat`, `bug` and `deploy` all rendered as the
same flat grey tag, so the type column carried no information at a glance.

## Repro
Open `#/tickets?project=<id>`. Every row's type badge is the same `--sunken` grey except
ARCH.

## Expected
Each type reads as its own colour, quietly, without the row becoming a colour chart.

## Context pack
- Files/functions in play: `public/app.js` `typeBadge()` (emits `dg-tb tt-<type>`),
  `public/styles.css` `.dg-tb` block.
- The cause was a plain gap, not a bug in a rule: `typeBadge()` has always emitted
  `tt-feat` / `tt-bug` / `tt-deploy` class names, but **no CSS ever selected them** —
  `grep "tt-" public/styles.css` returned nothing. Only the separate `.arch` class was
  styled. The markup hook existed; the styling was never written.
- Related tickets: FEAT-066 (the `--st-*` status tints this reuses), FEAT-082 (the digest
  these rows belong to).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-20 — worker (dispatched lane)
- **Understood:** not a broken selector — three class names with no matching rule.
- **Changed:** `public/styles.css` only, three declarations under `.dg-tb`. Colours come
  from the existing four FEAT-066 status tints rather than a new palette: BUG takes
  `--st-high` (the brick red it already means at high severity), FEAT `--st-done` (moss),
  DEPLOY `--st-needs` (amber — the colour the rail summary already gives deploy chips).
  ARCH is untouched and keeps `--st-prog` plus its deliberately apart outlined ◆ chip.
  Each tag gets a ~12% wash of its own colour in place of the flat `--sunken`, so the type
  is legible at a glance while staying a quiet mono tag. Because the tokens are redefined
  per theme, dark automatically picks up the lifted variants with no second rule.
- **Verified:** real running board (own server, scratch `CLAUDE_STATION_DATA`, free port
  34767, the real `docs/bugs/` of this repo — 35 open tickets), driven over CDP in headless
  Brave. Computed styles on the first 14 live badges, both themes:
  light — FEAT `rgb(102,126,75)`, BUG `rgb(168,80,58)`, ARCH `rgb(78,119,168)`;
  dark — FEAT `rgb(143,164,112)`, BUG `rgb(204,123,96)`, ARCH `rgb(127,166,206)`.
  Three distinct colours in each theme, none falling back to `--ink-3`.
  Screenshots read visually, both themes: `<scratch>/tb/board-light.png`,
  `<scratch>/tb/board-dark.png`. (Paths redacted from absolute form by the
  BUG-129 worker — as written they tripped the repo-wide leak-gate, which
  blocked every commit in the tree; nothing else in this entry was touched.)
  `npm run gate` → PASS (leak-gate, check-nul, typecheck), exit 0, read unpiped.
- **Not covered:** no DEPLOY ticket exists on this board, so `tt-deploy` was verified by
  rule and token only, never seen rendered. First DEPLOY ticket filed is the real check.
- **Symptom of a deeper design flaw?** No. A single missing rule for class names the JS
  was already emitting — the kind of gap that is invisible to DOM assertions (the class
  is present and correct) and only shows up when someone looks at the screen.
