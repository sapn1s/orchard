# BUG-086 — pinned sessions render like the ACTIVE/open session (highlighted), making it unclear which one is actually open

- **Status:** RESOLVED (2026-08-13)
- **Area:** FE sidebar row styling (styles.css `.row.pinned` vs `.row[aria-current]`)
- **Reported:** 2026-08-13 by user:
  > "we need to change how 'pinned' sessions appear, currently they seem like highlighted, which
  > makes it confusing for knowing which session i have actually open, cuz it always looks ACTIVE
  > instead of PINNED."

## Symptom
Pinned session rows carry a highlight (`.row.pinned::before` marker + the pinned rows read as
emphasized) that looks like the ACTIVE/open state (`aria-current="true"`). So a pinned session
looks "active" even when it isn't the one open, and the user can't tell at a glance which session
is actually open vs merely pinned.

## Wanted
1. **Distinct visual languages:** the OPEN/current session (`aria-current="true"`) keeps the
   active highlight (the "you are here" state); PINNED sessions get a different, quieter treatment
   that reads as "pinned" — e.g. a pin glyph / icon indicator, NOT a full active-style highlight.
   A pinned session that is NOT open should look clearly un-selected.
2. When a session is BOTH pinned AND open, the active/open state wins visually (it's where you
   are), with the pin indicator still shown as a secondary marker.
3. Keep it within the minimal greyscale palette; the distinction should be shape/marker/weight, not
   a loud new color (reuse existing tokens).

## Verification (§C)
Playwright/happy-dom: a pinned-but-not-open row and the open row have DISTINCT computed styling
(the open row has the active highlight; the pinned-not-open row does not — must FAIL pre-fix: they
read the same/both emphasized); a pinned-AND-open row shows the active state + a pin marker; an
unpinned-unopened row is plain. Anti-regressions: verify:ui, verify:attention (pin logic),
typecheck, leak-gate.

## Activity log (APPEND-ONLY)
### 2026-08-13 — orchestrator
- Filed from user report. Client-only (styles.css + maybe app.js class/marker). The pin should be
  a marker, not an active-style highlight; only aria-current=true is the "open" highlight.

### 2026-08-13 — worker (fix)
- Root cause: the pin indicator was a hairline `::before` bar down the row's LEADING edge
  (`.row.pinned::before`, `background: var(--ink-3)`). A leading-edge bar reads as a
  selection/active affordance, so a merely-pinned row looked like the open one.
- Fix (greyscale, reuses tokens):
  - `public/app.js` `sessionRow()` — pinned rows now append an explicit pin GLYPH element
    `<span class="pin-mark">` (the existing `MENU_ICON.pin` path via `svg()`), so the mark reads as
    "pinned" rather than "selected". Marker appears ONLY on pinned rows.
  - `public/styles.css` — removed `.row.pinned::before` (and its hover/current variants); added
    `.row .pin-mark` (trailing edge, `--ink-4`, quiet), `.row[aria-current="true"] .pin-mark`
    (`--ink-2`, secondary on the open row), `.row.pinned:hover .pin-mark` (`--ink-3`). The active
    highlight (`background: var(--hair); color: var(--ink)`) stays bound to `aria-current="true"`
    alone — the sole "you are here" state. The `.row.pin-last` group divider is unchanged.
- Behaviour: OPEN row keeps the active highlight; pinned-not-open reads exactly as un-selected as a
  plain row (same background + ink) plus a quiet pin glyph; pinned-AND-open shows the active
  highlight AND the pin glyph (active wins). Plain/open-unpinned rows carry no glyph.
- Verify (§C): new `scripts/verify-bug-086-pin-style.mjs` (npm `verify:bug-086-pin-style`) — boots
  the REAL app.js in happy-dom against a REAL server with the REAL styles.css injected, two render
  scenarios (open-unpinned; open-and-pinned). **12/12 PASS post-fix; 9/12 pre-fix (3 must-FAIL: the
  pin-marker reads — no marker element existed pre-fix).**
- Anti-regressions: `verify:ui` 7/0, `verify:attention` 4/0, `typecheck` clean, leak-gate PASS.
- Status → RESOLVED (verified).
