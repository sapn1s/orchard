# FEAT-161 — maxed-out usage window shows a live reset countdown, and hover shows a styled limits popover

- **Status:** IN-PROGRESS
- **Severity:** low
- **Area:** composer / header crown (public/app.js, public/styles.css, public/index.html)
- **Reported:** 2026-10-01 by greyl33t
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED.

## Symptom
User request (verbatim): "new ux change: where we have showing circle filled based
on session usage remaining for provider > show countdown until reset next to it when
its maxed out. also, hovering should show better ui for limits, like a filled bar or
whatever is nice"

Two gaps in the FEAT-116/FEAT-139 provider-usage crown chip (`#usageBtn`):
1. When a provider's binding window is fully burned (100%), the ring just sits full —
   there is no indication of *when* it frees up.
2. Hover shows a plain native `title` tooltip (multi-line text) — functional but ugly;
   no filled bars, no design-token styling, same in both themes only by accident.

## Expected
1. When the binding window is maxed out (used ≥ 100%) AND its reset time is known,
   render a compact live countdown (`1h 23m`, `4m 10s`, `42s`) next to the ring that
   ticks without a full re-render and disappears/refreshes when it crosses zero. If
   the reset time is unknown, show nothing (never a wrong number).
2. Replace the native `title` tooltip with a styled popover (shared `.pop` chrome):
   per window a labelled horizontal filled bar with used %, binding tag, and reset
   (relative + absolute). Hover- and keyboard-focus-openable. Correct in light + dark.

## Context pack
- Files/functions in play:
  - `public/app.js` — `paintUsageChip()`, `paintUsageRing()`, `usageTitle()`,
    `usageResetShort()`/`usageResetAbs()`, `closePops()`, `place()`. Data arrives via
    `api.usage()` → server `/api/usage` → `getUsageSnapshots()`; each window already
    carries `resetsAt` (unix sec), so NO server plumbing is needed (ARCH-010 holds —
    the server owns the reset fact and the client reads it).
  - `public/index.html` — `#usageBtn`/`#usageRing` markup (~line 216).
  - `public/styles.css` — `.readout.usage`, `.usage-ring`, `.pop` chrome, design tokens.
  - `src/server/provider-usage.ts` — `UsageWindow { usedPercent, resetsAt }` (data source).
- Related tickets: FEAT-116 (provider usage), FEAT-139 (ring), FEAT-145 (per-account).
- Repro test: `npm run verify:feat-161` (added this ticket).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-01 — worker (fixing, round 1)
- **Understood:** The ring is the header crown `#usageBtn`. Server already sends
  `resetsAt` per window, so the countdown and popover are a pure client change.
  Hypothesis (ring is client-side, reset times already present) VERIFIED by reading
  `provider-usage.ts` + `paintUsageChip`.
- **Changed (uncommitted):**
  - `public/index.html` — `#usageCountdown` span inside `#usageBtn`; `#usagePop` popover.
  - `public/app.js` — `fmtCountdown()`, `usageMaxed()`, `usageCountdownAt` +
    `setUsageCountdown()`/`tickUsageCountdown()` (1s ticker in `startUsagePolling`);
    `paintUsageChip()` now drops the native `title`, drives the maxed-out countdown,
    and keeps an open popover fresh; `paintUsagePop()` + hover/focus/click wiring;
    `#usagePop` added to `closePops()`; new helpers exported on `window.__station`.
  - `public/styles.css` — `.usage-countdown` (tabular mono, danger ink) and the
    `.usage-pop`/`.usnap*`/`.uwin*`/`.ubar*`/`.usage-foot` block (design tokens only).
  - `scripts/verify-feat-161-usage-countdown-popover.mjs` + `package.json` (`verify:feat-161`).
  - `docs/bugs/INDEX.md` row is orchestrator-owned — not touched here.
- **Design decision:** reset timestamps were ALREADY client-side (each `UsageWindow`
  carries `resetsAt` from the server's `getUsageSnapshots()`), so this is a pure client
  change — no re-derivation, ARCH-010 holds. "Maxed" = `usedPercent >= 100` on the
  binding window; unknown reset (`resetsAt == null`) shows nothing.
- **Verified (fixer's own run — necessary, not sufficient):**
  `npm run verify:feat-161` → **21 passed, 0 failed** (real headless brave over the real
  app.js, isolated scratch server on a free port + throwaway `CLAUDE_STATION_DATA`).
  Covers: fmtCountdown format (1h 23m / 4m 10s / 42s / null-on-expiry); usageMaxed
  gating; maxed→countdown shown, not-maxed→hidden, unknown-reset→hidden; live
  zero-crossing (1s→hidden, text cleared); popover filled-bar widths == used %,
  binding tag, relative+absolute reset, honest "reset time unknown", unavailable note,
  footer; native `title` removed. Screenshots (both themes), inspected for ugliness —
  clean alignment/contrast, no overflow:
  `docs/bugs/assets/FEAT-161-{face,popover}-{light,dark}.png`.
  `npm run gate` → **PASS (exit 0)** (leak-gate + check-nul + typecheck).
- **Still open / handoff:** Independent clean-room verification still owed before
  VERIFIED (class=fix). A fresh verifier should exercise a case the fixture does not:
  e.g. the binding window being the model-scoped `weekly · <model>` variant when maxed,
  and the `providerView()==='openai'` face path (Codex `primary`/`secondary` snapshot)
  — confirm the countdown tracks the OpenAI binding window too, not only anthropic.

### 2026-10-01 — independent verifier (verifying, round 1) — VERDICT: HOLDS
- **Approach:** Independent review of the uncommitted diff; did NOT read the fixer's
  rationale beyond the requirement. Booted my own isolated scratch server (own
  CLAUDE_STATION_DATA, free port, never the live service) + headless Brave over the
  real app.js, with my own synthetic snapshots crafted for the cases the fixer's
  fixture did NOT cover.
- **Fixer suite re-run:** `npm run verify:feat-161` → **21 passed, 0 failed** (reproduced).
- **My independent attack (13 checks, 12 PASS):** the one handoff gap is closed —
  * OpenAI SELECTED provider (`state.overrides.provider='openai'`), binding window the
    model-scoped `weekly · gpt-5-codex` at 100% with a known reset → face countdown
    shows "2h 34m", `danger` class applied, aria-label collapses to "weekly window".
  * Popover lists the OpenAI snapshot FIRST (the selected provider), the full
    `weekly · gpt-5-codex` label is preserved, bar fill == 100%, binding tag + reset
    (relative · absolute) all correct; the 88% 5h window reads `warn`.
  * Zero-crossing on the OpenAI window: visible at 1s, hidden + text cleared after.
  * Narrow 420px viewport: popover stays fully on-screen (left 108 / right 408 of 420),
    no clipping of the model label or binding tag — `place()` clamps correctly.
  * Both themes screenshotted and eyeballed: alignment, contrast, no overflow; danger
    (red) / warn (amber) / neutral bars differentiate cleanly in light + dark.
- **The one non-PASS was a HEADLESS ARTIFACT, not a defect:** programmatic `.focus()`
  does not fire focus events in headless Brave unless focus emulation is on. Proven
  with `Emulation.setFocusEmulationEnabled` + `dispatchEvent('focus')` → the chip's
  focus listener opens the popover and sets `aria-expanded=true`; blur-away closes it.
  Keyboard open/close works.
- **One visual checked and cleared as NOT a regression:** at rest the maxed usage chip
  shows ring + countdown with no pill border/background — that is the pre-existing
  FEAT-116 `.readout` design (`border-color: transparent` until hover/focus), not
  introduced by FEAT-161. The fixer's screenshots show the border only because the
  popover was open (hover state).
- **Gate:** `npm run gate` → **PASS (exit 0)** (leak-gate + check-nul + typecheck).
- **No product changes made** (no CSS/markup defect found); all scratch scripts removed.
- **board-tool verified NOT recorded:** I do not have my dispatch run-id (required by
  `board-tool.mjs verified --run`), so I recorded the verdict here per the charter's
  "else omit and say so" instruction. Orchestrator should record it with the run-id.
</content>
</invoke>

### 2026-10-03 — worker (fixing, round 2) — visual redesign after user feedback
- **Trigger:** user on round 1: "its an improvement but still horrible … it needs to be
  visually pleasant, easy to navigate".
- **Round-1 critique (from before-shots, written before changing anything):** full 100%
  ring read as a hollow red "O" with a floating mono number beside it; three boxed
  uppercase-mono tags (MAX / PLUS / BINDING — jargon) competing; "as of" repeated per
  provider; reset line "resets in 1h" contradicted the face "1h 23m" and carried a full
  date + "02:08 AM"; three type textures per row, no hierarchy for the binding window;
  filler footer sentence; click-after-hover CLOSED the popover; a click inside it closed it
  (document click handler); no hover dwell (flashes when sweeping the header).
- **Changed (uncommitted, client only — reset times already on each UsageWindow):**
  - `public/app.js` — `paintUsagePop()` rewritten: one group per provider (face snapshot
    first; name + sentence-case plan; "Limit reached" only when blocked), plain window
    names (`5-hour session`, `Weekly`, `Weekly` + "Fable only"), binding row emphasised
    (full-ink label, 6px bar vs 4px), tiers via `usageTier()` (calm moss <75, ochre 75–99,
    brick at 100 — the face uses the same scale, so 90% is no longer red), reset lines
    "Resets in 2h 34m · 3:24 AM" (`fmtResetIn`/`fmtResetAt`) that tick live while open
    (`tickUsagePop`), one "Updated …" footer. `fmtCountdown` gains a day unit ("2d 4h",
    never "53h 0m"); relative + countdown both floor so they never disagree.
    `usageFaceSnap()` is now the single pick shared by face + popover ordering.
    Interaction: 120ms hover dwell, 220ms close grace + invisible bridge over the gap,
    click pins, click inside doesn't close, Escape closes (existing ladder), keyboard
    focus (`:focus-visible`) opens. Face gets a `maxed` class.
  - `public/styles.css` — FEAT-161 block replaced: maxed face = soft brick capsule
    (ring + tabular countdown as one object); popover 320px (max 100vw−16), app tokens only.
  - `scripts/verify-feat-161-usage-countdown-popover.mjs` — rewritten for the r2 markup;
    now boots via `isolatedServerEnv`, intercepts `/api/usage` (the scratch server can read
    real usage and would overwrite fixtures mid-run), drives real pointer/keys via CDP Input.
- **Verified (fixer's own run):** pre-change ground truth: round-1 suite passed 21/0 on
  2026-10-03 (the 2026-10-01 failed event did not reproduce). After: `npm run
  verify:feat-161` → **42 passed, 0 failed** — scenarios Claude-only, Claude+OpenAI one
  maxed, all maxed (OpenAI selected), unknown reset + unavailable account, 420px viewport
  (popover on-screen), both themes; hover dwell / gap crossing / pin / Escape / keyboard.
  `npm run gate` → PASS. Screenshots inspected in both themes:
  before `docs/bugs/assets/FEAT-161-r2-before-{face,popover}-{light,dark}.png`;
  after `docs/bugs/assets/FEAT-161-r2-{face,claudeOnly,oneMaxed,allMaxed,unknownReset,narrow}-{light,dark}.png`.
- **Still open:** independent verification of r2 owed (class=fix). Not verified: real
  pointer feel in a headed browser (headless CDP only); 12h vs 24h clock follows the
  browser locale (headless shows "3:24 AM").
