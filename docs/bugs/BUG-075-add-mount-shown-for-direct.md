```orchard-ticket
{
  "id": "BUG-075",
  "type": "bug",
  "title": "Direct sessions showed a container-only mount control",
  "summary": "The mount control now appears only for container sessions and disappears after switching to a direct session. It previously appeared in every mode despite being irrelevant outside containers. The surrounding session controls were also checked for similar mode leaks.",
  "impact_if_we_wait": "Direct-session users could mistake an irrelevant control for a usable filesystem feature. Bounded: this was interface display-correctness, not data loss or restricted filesystem access.",
  "current_need": "Treat the ticket as closed: the pre-fix cases failed, the corrected behavior passed, and standing checks stayed clean.",
  "severity": "low",
  "area": "Session topbar controls",
  "reported": "2026-08-12",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-12",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Direct sessions do not show the mount control",
    "Container sessions show a functional mount control",
    "Switching from container to direct hides the mount control",
    "Other mode-specific session controls do not leak across modes"
  ],
  "code_refs": [
    {
      "path": "app.js",
      "symbol": null,
      "note": "Topbar chip rendering and session isolation state"
    }
  ],
  "related": [],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": true,
    "Migration and rollback": false,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-075-add-mount-shown-for-direct.md",
    "sha256": "09fbc63f504e31bd8b595b71343992b353f4afba90bf6940660194391d73d677",
    "bytes": 4665,
    "original_title": "\"+ Add mount\" chip shown for Direct sessions (container-only affordance leaks into all modes)",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared field by field against the supplied original; the symptom, isolation rule, session-switch behavior, chip sweep, proof, and bounds are preserved above.",
    "dropped": []
  }
}
```

# BUG-075 — Direct sessions showed a container-only mount control

## Diagnosis

The topbar chip strip rendered the add-mount affordance without checking the session isolation mode. Mounts add filesystem paths to containers, while direct sessions already see the filesystem, making the control inert or misleading there.

## Evidence

The pre-fix proof retained the hook while neutralizing the guard, and both required failure cases failed. `verify:bug-079-session-switch-state` passed 10/10. A separate recorded tally passed 9/9 without an adjacent suite name, and the leak-gate was clean. `verify:ui`, `verify:bug-075-mount-chip`, and `verify:feat-051-chips` were named without recorded results.

## Implementation notes

Gate the mount control with the isolation mode from the session-init or health payload already used by the neighboring Direct or Container chip. Re-evaluate that state on session switches so a container mount control cannot remain visible in a direct session. The chip strip was also swept for other mode-specific leaks.

## Verification plan

Confirm that a direct session hides the mount control, a container session shows it and completes the real add-mount flow, and switching from container to direct hides it. Preserve the pre-fix failure proof and check the remaining mode-specific controls for cross-mode leakage.

## Risks

Using a different isolation source from the neighboring mode chip could let the two controls disagree. A stale session-switch render could also preserve the container-only control after entering a direct session.

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
