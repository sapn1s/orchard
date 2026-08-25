# BUG-082 — proc/port crown chip dumps the full port list inline, crowding out the other topbar chips

- **Status:** VERIFIED 2026-08-13 (client-only — reaches users on reload, no deploy) — proc chip now previews the first 3 ports inline (:4317 first, then ascending) + a "+N" overflow, keeps the "· N procs" summary, and opens a #procPop popover (reusing place()/closePops()) listing every port. scripts/verify-bug-082-proc-chip.mjs 16/16 (pre-fix 10 FAIL); anti-regress verify:ui 7/7, verify:processes 9/9, typecheck clean, leak-gate PASS.
- **Area:** FE crown chips (app.js paintCrown — the proc chip)
- **Reported:** 2026-08-12 by user:
  > "the port list is way too long it makes not enough space to fit all items comfortably. dont
  > need to show such long list, only some and then open for full view"
  > (example: "▸ :4317 :35873 :37129 :37825 :44173 :44677 :44913 · 11 procs")

## Symptom
The proc chip (▸) in the topbar crown renders EVERY listening port inline. With scratch verify
servers + agents running, that's 6-7+ ports, so the chip grows unbounded and pushes the other
crown chips (Board, isolation, CLAUDE.md, git, model, integrations) out of comfortable space.

## Wanted
1. Show only the first FEW ports inline (e.g. the primary :4317 + 1-2 others, or a small cap like
   3) followed by a "+N" overflow indicator; keep the "· N procs" summary.
2. Clicking the chip (or the +N) opens the FULL list — a small popover/drawer section, reusing the
   existing chip-popover pattern (like the provider/model chips), not an inline dump.
3. The primary station port (:4317) should always be shown; ephemeral scratch ports are the ones
   collapsed.
4. Stable ordering so the inline preview doesn't jitter between polls (e.g. :4317 first, then
   ascending).

## Verification (§C)
Playwright/happy-dom: with N>cap ports injected, the chip renders the cap + "+N" (must FAIL
pre-fix: all N inline); clicking opens a popover listing all ports; :4317 always present inline;
narrow-viewport the crown row no longer overflows. verify:ui, the FEAT-051 chips spec if relevant,
typecheck, leak-gate.

## Activity log (APPEND-ONLY)
### 2026-08-12 — orchestrator
- Filed from user report. Client-only (app.js/styles) → reaches users on reload, no deploy.

### 2026-08-13 — worker (fresh build on current main; prior worktree attempt discarded, stale base)
- **Fix (public/app.js + public/index.html + public/styles.css):**
  - `orderedPorts()` — dedupes + numeric-sorts, pulls `:4317` (STATION_PORT) to the front, then
    ascending. STABLE across polls, so the inline preview no longer jitters.
  - `paintProcChip()` — previews only the first `PROC_PORT_CAP` (3) ports inline with a `+N`
    overflow token; keeps the `· N procs` summary; single-port / no-port cases unchanged. `#procN`
    gets `white-space: nowrap` and the width is bounded by the cap.
  - New `#procPop` popover (index.html) + `paintProcPop()` — lists EVERY port in the same
    `:4317`-first order, `:4317` tagged `station`; footer "Running here ›" opens the drawer's
    Running-here list. Reuses the FEAT-051 `.pop`/`place()`/`closePops()` chip-popover chrome; the
    chip click now toggles the popover instead of jumping straight to the drawer.
  - Sidebar chip (`procChipText`) also routed through `orderedPorts`, so it too leads with `:4317`.
- **Verify:** new `scripts/verify-bug-082-proc-chip.mjs` (`npm run verify:proc-chip`) — real app.js
  in happy-dom against a real scratch server (free port, scratch dataDir, killed by pid). Injects
  N>cap ports and drives the real `paintProcChip` / real `#procBtn` click handler.
  - Fixed: **16/16**. PRE-FIX (client changes stashed): **10 FAIL / 6 PASS** — cap, `+N`,
    `:4317`-first, ascending, width-bounded, stable-order, popover open/full-list/order/tag all
    FAIL; the anti-regression checks (summary kept, single-port inline, no-port, zero-procs)
    correctly PASS pre-fix (not the bug).
- **Anti-regression:** `verify:ui` 7/7, `verify:processes` 9/9 (crown-chip assertion green; sidebar
  now reads `:4317 +9`), `typecheck` clean, `leak-gate` PASS.
