# BUG-075 — "+ Add mount" chip shown for Direct sessions (container-only affordance leaks into all modes)

- **Status:** VERIFIED — fixed 2026-08-12 (§C incl. must-FAIL-pre-fix proof; chip-strip swept)
- **Area:** FE topbar chips (app.js) — isolation-mode-conditional affordances
- **Reported:** 2026-08-12 by user:
  > "this convo is direct, not in container, yet i see add mount option on top:
  > ○ Direct … + Add mount"

## Symptom
The topbar chip strip renders "+ Add mount" regardless of the session's isolation mode. Mounts
are a CONTAINER concept (bind-mounting extra paths into the container); a Direct session already
sees the whole filesystem — the affordance is inert-or-confusing there.

## Wanted
1. "+ Add mount" renders ONLY when the session's isolation is container (ground truth from the
   session-init/health payload the chips already consume — same source as the "Direct/Container"
   chip beside it, so the two can never disagree).
2. Sweep the chip strip for any OTHER mode-conditional affordance leaking across modes (e.g.
   container-only controls on direct/sandbox, direct-only ones in container) — fix in the same
   pass and list what was checked in the ticket.
3. If a mount is added in a container session and the user switches to a direct session, the chip
   updates on session switch (no stale render).

## Verification (§C)
Playwright/happy-dom: direct session → no Add-mount chip (must FAIL pre-fix: chip present);
container session → chip present and functional (anti-regression on the real add-mount flow);
session switch container→direct hides it. verify:ui, the FEAT-051 chips spec, typecheck,
leak-gate.

## Activity log (APPEND-ONLY)
### 2026-08-12 — orchestrator
- Filed from user report. Second chip-strip conditional-rendering issue class (FEAT-051 built the
  strip from session-init ground truth — the mount chip apparently bypassed that discipline).

### 2026-08-12 — worker (fix + §C)
- Root cause: `paintCrown()` (public/app.js) appended the mount pills + "+ Add mount" button
  UNCONDITIONALLY (line ~1587), so every isolation mode showed the container-only affordance.
- Fix: gated the whole mounts block on `p.isolation === 'container'` (`p = currentProject()`) — the
  SAME ground truth the Direct/Container chip (`isoN`, line ~1545) and the isolation `say()` line
  (~1595) already read, so the three can never disagree. Direct/sandbox now render neither the mount
  pills nor the Add-mount button. `paintCrown` already clears the prior `.mnt/.addm` at the top of
  every pass (line ~1540) and runs on every session switch (openSession → paintCrown), so a
  container→direct switch hides it with no stale render.
- Chip-strip SWEEP (item #2) — every affordance checked for isolation leakage:
  - "+ Add mount" + mount pills → container-only. WAS leaking. FIXED.
  - Direct/Container chip (`isoBtn`/`isoN`) → shows the mode itself; correct for all modes.
  - Instructions chip (`insBtn`) → CLAUDE.md/templates, isolation-independent. Correct (verified
    renders in both modes by the spec).
  - Permission chip (`paintPerm`) → permission mode applies to EVERY isolation (container just
    defaults to bypass); the mode-specific WORDING is correct per-mode messaging, not a leaked
    affordance. No change.
  - Integrations strip (`paintIntegrations`), model chip, git chip, proc chip → all
    isolation-independent. No change.
  - Conclusion: the mount affordance was the only mode-conditional control leaking across modes.
- §C — scripts/verify-bug-075-mount-chip.mjs (real app.js in happy-dom; real paintCrown driven
  against injected container vs direct projects; asserts the real rendered #seal):
  - PRE-FIX (guard neutralized, hook retained): the 2 must-FAIL assertions FAILED — a Direct
    session rendered `.addm` (count=1); a container→direct switch left it stale (`.addm`=1).
  - POST-FIX: 9/9 PASS — direct hides pills+chip; container shows the chip, renders the configured
    mount pill, and the chip is FUNCTIONAL (opens Settings › Mounts via drawer.open); the
    container→direct switch hides it; the sweep confirms the mode-independent instructions chip
    renders in both modes.
  - Anti-regressions green: verify:ui (7/0), verify:feat-051-chips (1 passed), typecheck (0),
    leak-gate (PASS). Also re-ran verify:bug-079-session-switch-state (10/10) — same file, no regression.
- Note: added a small `paintCrown` test hook to `window.__station` (like the existing
  `paintSessStatus`/`openSession` hooks) so the chip's ground truth can be asserted directly.
- Commit: BUG-075: Add-mount chip only for container sessions.
