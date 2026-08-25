```orchard-ticket
{
  "id": "FEAT-101",
  "type": "feature",
  "title": "Dashboard panels slide in from the right",
  "summary": "Settings, board, and guide surfaces now enter and leave with one interruptible right-edge motion. Rapid reversals cancel stale completion work, reduced-motion users get instant state changes, and the live session remains visible beneath moving full-screen panels.",
  "impact_if_we_wait": "Right-side surfaces appear abruptly and closing settings looks broken. The issue is visual and interaction-level only; session data and server work remain unaffected.",
  "current_need": "none — the real Brave motion verifier was re-run by the harness owner and is green",
  "severity": "low",
  "area": "dashboard overlays",
  "reported": "2026-08-21",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-25",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Settings, board, and guide share one reusable slide-panel lifecycle and the established .22-second easing.",
    "Opening, closing, and interrupted reopening reverse smoothly without stale handlers hiding an open panel.",
    "The session window stays visible while a full-screen surface moves and hides only after the surface settles open.",
    "Reduced motion opens and closes instantly without waiting for transition events.",
    "A future right-hand surface can adopt the CSS class and JavaScript helper without bespoke timing code."
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": false,
    "Implementation notes": true,
    "Verification plan": true,
    "Migration and rollback": false,
    "Risks": true,
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

# FEAT-101 — Dashboard panels slide in from the right

## Diagnosis

The drawer already had the correct transform but its visibility changed immediately on close. Board and guide instead toggled hidden and their root classes synchronously, so neither had a paintable closed frame or exit interval. Their root classes also hid the session window before any entering motion could cover it.

## Implementation notes

Use one CSS class for the transform vocabulary and one small JavaScript controller for display, settled-underlay, interruption, event filtering, fallback, and reduced-motion timing. Keep route data requests after starting the open lifecycle so loading overlaps motion.

## Verification plan

Drive the real server in headless Brave over CDP. Sample computed transforms through open, close, and close-then-reopen; assert resting hidden/open/root-class states; repeat in light, dark, and emulated reduced motion.

## Risks

Another lane is editing the shared frontend files. Preserve its hunks and stage only this ticket's exact changes.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-21 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-08-21 — Codex
- **Built; environment blocked required verification:** Implemented the shared slide-panel CSS and createSlidePanel lifecycle across settings, board, and guide. Source checks and a Happy DOM lifecycle test passed, including descendant/property filtering, interrupted reopen cancellation, normal settle, and synchronous reduced motion. Real Brave verification could not start because the managed filesystem returned EROFS for the required scratch root; npm run gate also could not complete because leak-gate was denied spawnSync git with EPERM.

### 2026-08-21 — Codex
- **Harness follow-up; assertion and guide jank fixed:** Harness-owner real-browser run reported 28 passed / 3 failed. Check 3's tickets/guide failures were a verifier defect: CSS reversing-shortening can legitimately finish a young reversal before the 60 ms sample, making a hidden panel report transform none; the check now samples reversals at 35 ms + one frame, conditionally checks continuity only while displayed and mid-travel, checks every on-screen sample stays within [0,width], and always checks both settled endpoints. Check 1 exposed real guide jank: guide page/nav/markdown work could run synchronously during the 220 ms entry; requests now start immediately but DOM/prose work waits for the slide to settle, and Mermaid remains lazy and is also gated after settlement. The ticket path was inspected but left otherwise unchanged because its measured motion was already clean and delaying its request path would regress the data-arrival verifier.

### 2026-08-21 — Codex
- **Round 3; repaired the sampler and the guide-close regression:** Harness owner reported 27 passed / 4 failed. Two failures were measurement artefacts: the verifier issued one CDP evaluation per nominal sample, so a blocked main thread bunched several reads within ~2 ms at the same transform. Replaced that loop with one in-page requestAnimationFrame recorder that captures every requested state field for 350 ms and returns the dense series in one evaluation; motion now requires at least three distinct mid-travel positions, allows equal/dropped frames, checks monotonic direction and prints a compact summary plus raw frames. Interruption checks now reverse in-page only after crossing approximately mid-travel, compare the immediate before/after computed positions within 2 px, check post-reversal monotonic travel, bounds and both settled endpoints. The guide-close defect was introduced by my own round-2 fix: deferring the entire synchronous nav/markdown/Mermaid path until entry settled moved its long task into the close window. Guide markdown is now rendered in cancellable top-level-section slices across animation frames after entry; closing/navigation aborts stale slices via the existing gv.seq/gv.open guards. Mermaid loading/rendering remains offline but waits for a 500 ms quiet settled interval and cancels if the guide closes, keeping both entry and prompt exit clear. BUG-094 returnHash capture and gv.pages caching are unchanged; the shared slide lifecycle still removes guide-open synchronously at close, matching tickets so the session window becomes visible immediately. Static node syntax, git diff whitespace and npm run typecheck passed. The real-browser suite was not run in this sandbox; harness owner must re-run it.

### 2026-08-25 — worker
- **bookkeeping-sweep:** 2026-08-25 bookkeeping sweep (authorised by the user). This ticket was waiting on exactly one thing: the harness owner re-running the real-browser motion suite that the Codex lane could not run in its sandbox. Ran it here on the host: `node scripts/verify-feat-101-slide-panels.mjs` — 31 passed, 0 failed, exit 0 read directly, real headless Brave over a scratch server on a free port, screenshots in scratch/slide-shots. Settings, tickets and guide all reach a settled open endpoint (transform none, x=0, window hidden only after settle) in light and dark. The shipped code is committed at 57822ae. Closing as verified. Symptom of a deeper design flaw? No — three surfaces had each grown their own show/hide, and they now share one lifecycle.
