# BUG-194 — selecting a project in the search palette leaves the other project's session open

- **Status:** VERIFIED — independent clean-room dispatch (2026-09-28, round 1) confirms the fix HOLDS: fixer test re-run 9/9 + an independent adversarial run 14/14 (draft-leak / same-project / Back / two-project draft isolation). Cross-provider (OpenAI) was quota-exhausted, so the pass is a SAME-provider clean-room Claude dispatch (decorrelation reduced — see log).
- **Severity:** medium
- **Area:** sidebar / search palette / composer
- **Reported:** 2026-09-28 by user
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED.
  (Session/view-lifecycle + composer send-target; regression-prone surface.)

## Symptom
In the search palette (Projects / Recent / Sessions / Messages — e.g. typing a
few letters surfaces a matching project `#<name>`), selecting a PROJECT result changed
the selected-project header to that project, but the currently open session from
a DIFFERENT project stayed on screen in the transcript dock. The header said
project B while the transcript showed project A's session. User: "idk what will
even happen" — e.g. does the composer send to A or B?

Answer (measured, see log): in the broken state the composer targeted **A** —
`state.current.sessionId`/`encodedDir` still pointed at the foreign session — so
a sent message would have resumed project A's session despite the header showing
B. A real wrong-project send hazard, not just a cosmetic mismatch.

## Repro
1. Open a session belonging to project A (transcript on screen).
2. Open the finder, type part of project B's name, click the project result.
3. Wrong: header switches to B, but A's transcript stays open and the composer
   still targets A's session.

## Expected
Selecting a project result lands the view FULLY in that project: the foreign
session is closed/deselected and the view shows that project's fresh new-session
composer (the same state as clicking the sidebar "+ start a session"), WITHOUT
launching an agent until the user sends. The selected project and the open
session never disagree. Session/message results are unchanged.

## Context pack
- Files/functions in play: `public/app.js` — `projectHitRow()` (the palette
  project-result row; FEAT-147). Fix routes its click through the existing
  project-open transition `startNew(projectId)` instead of a bare
  `selectProject(id, { quiet })`. `openSession()` (session/message results)
  already sets the selected project — verified, unchanged.
- Related tickets: FEAT-147 (added `projectHitRow`; **regressed-from: FEAT-147**),
  ARCH-010 ("which project is this view showing" must have one owner), BUG-106
  (`openProjectId` vs sidebar selection), BUG-083 / FEAT-073 (startNew state).
- Repro test: `node scripts/verify-bug-194-palette-project-select.mjs`.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-28 — worker (fixing, round 1)
- **Understood:** hypothesis confirmed. `projectHitRow()`'s click handler called
  `selectProject(p.id, { quiet: true })`, which (per BUG-106) moves ONLY the
  sidebar `current.projectId` and deliberately does not touch the open session.
  So `state.openProjectId`, `state.current.sessionId`/`encodedDir` and the painted
  transcript all stayed on project A while the header read B — two independently
  held answers to "which project is this view showing" (the ARCH-010 defect).
- **Changed:** `public/app.js` — `projectHitRow()` click handler now calls
  `startNew(p.id)` (then `revealProject`) instead of the bare-select sequence.
  `startNew` is the single project-open transition already used by the sidebar
  "+"/pending-new row: it closes the foreign session (`resetTranscript`, socket
  close, `followCurrent`), sets `openProjectId`/`pendingNew` to the target, and
  opens a fresh new-session composer. It launches NO agent — the turn starts only
  when the user sends. This is the "go through the same state transition, not a
  palette special-case" fix ARCH-010 asks for.
  New test: `scripts/verify-bug-194-palette-project-select.mjs`.
- **Verified:** real app.js booted in happy-dom against a real server; project A =
  a real neighbour project with on-disk sessions (opened by a real row CLICK),
  project B = a second registered project; the palette driven through the REAL DOM
  (type B's name → click the real `projectHitRow` button).
  - POST-FIX: `node scripts/verify-bug-194-palette-project-select.mjs` → **9/9**.
    Observed after select: current.projectId=B, openProjectId=B, transcript
    bubbles=0, box visible, pendingNew=B, sessionId=null, encodedDir=null, no
    launch POST, 0 launch socket frames.
  - MUST-FAIL (pre-fix code restored, then reverted — no git writes): **5/9**;
    B2/B3/B4/B5 failed with openProjectId=A, 56 A-transcript bubbles still
    painted, composer target = A's real session id + A's own store `encodedDir`
    (both redacted here). This is the wrong-project-send hazard, measured.
  - Anti-regression: `npm run verify:search` → 12/12; `verify-bug-083` → 10/10;
    `verify-feat-073` → 12/12. Session/message result path (`openSession`)
    unchanged and still sets the selected project.
- **Verified-by:** PENDING — independent clean-room pass warranted (view-lifecycle
  + composer send-target; regression-prone). Suggested case the fixer's fixture
  does not cover: select a project result while a FOREIGN session with an UNSENT
  composer DRAFT is open, and while that session has a live/running agent — assert
  no cross-project draft/agent leak and no launch.
- **Symptom of a deeper design flaw?** yes → instance of ARCH-010 (already filed);
  the fix removes the second answer-holder rather than patching the palette in
  isolation. No new ARCH ticket needed.
- **Still open / handoff:** independent verify (above), then orchestrator flips
  INDEX status. No INDEX edit made by this lane.

### 2026-09-28 — independent clean-room verify (verifying, round 1)
- **Mechanism:** `scripts/independent-verify.mjs --working-tree` (WA §I clean room:
  tree exported to scratch, `docs/prompts` + `docs/bugs` stripped so the verifier
  cannot inherit our framing; verifier dispatched as a separate process, given ONLY
  the plain requirement + the diff + the fixer's test CODE — never the fixer's prose).
  Verifier ≠ fixer.
- **Provider:** OpenAI (the cross-provider default) was UNAVAILABLE — dispatch failed
  `[quota-window]` "hit your usage limit … try again Sep 29th 2:50 AM" (INVALID, exit 3,
  nothing verified). Per charter, fell back to a clean-room **Claude** dispatch. This is
  SAME-provider, so provider-level blind-spot decorrelation is REDUCED; it is still a
  separate clean-room process with none of the fixer's framing. A cross-provider re-run
  when OpenAI quota returns would strengthen it but is not required for this verdict.
- **Verdict: HOLDS** (VERDICT-CONTRACT: VALID, manifest-backed; 4 recorded runs).
  - Executed-evidence (i) — fixer test re-run: `node scripts/verify-bug-194-palette-project-select.mjs`
    → EXIT 0, **9/9** (manifest 603ba3d3f0cc). Observed after select: current.projectId=B,
    openProjectId=B, transcript bubbles=0, box visible, pendingNew=B, sessionId=null,
    encodedDir=null, launchPOST=none, launchSocketFrames=0.
  - Executed-evidence (ii) — adversarial NOT covered by the fixer's fixture
    (`draft-leak-reopen-same-project-back`, verifier-authored `adv-194.mjs`) → EXIT 0,
    **14/14** (manifest 125e059ce733): a foreign session with an UNSENT draft — no
    cross-project draft leak (composer empty for B, A2); view fully in B; only socket
    frames on select were unfollow/follow/unfollow, no non-GET request, no launch frame
    (A3/A4); A's draft preserved + restored on reopen (A5–A7); SAME-project select →
    fresh composer, session closed (A9); B→A→B draft isolation, each project's draft
    only (A10/A11); state coherent after Back (openProjectId === current.projectId, A12).
  - Executed-evidence (iii) — could not test, and why: a foreign session with a LIVE
    running agent (needs a real in-flight SDK turn — quota/real-action); keyboard ENTER
    on a focused project-hit button (happy-dom does not convert Enter→click; needs a real
    browser — note the finder's own Enter handler does not select project hits at all);
    that actually SENDING from the new composer reaches project B server-side (would
    launch a real turn). Session-result path covered indirectly by A6 (reopened A's
    session by sidebar-row click, A the open project, A's draft returned).
- **Verified-by:** dispatch anthropic run 7351e2e8-e031-43d4-943d-dbecef2b1659 (clean-room,
  `scripts/independent-verify.mjs`, `--working-tree` snapshot tree ae323a88533d) — VERDICT: HOLDS.
- **Residual (for the orchestrator):** the two uncovered cases both need a REAL browser /
  a REAL in-flight turn, which the sandbox cannot do without spending quota / taking a real
  action; a live-browser keyboard-Enter + live-agent pass is optional hardening, not a
  blocker for this verdict.

### 2026-09-28 — BUG-181/106 findings lane (Opus 4.8)
- **Note:** Latent-harness note (no code change here): scripts/verify-bug-194-palette-project-select.mjs registers a real neighbour project and locates its header by name (#tree button.proj, projName===NB) WITHOUT first revealing the inactive-projects group — the same latent pattern BUG-197 fixed in verify-bug-106-crossproject-strip.mjs (a >14d-inactive neighbour folded behind the '.inactive-l' toggle, so the by-name wait timed out). Not currently reported failing and not changed blind while other lanes are in flight; but if its neighbour ages past INACTIVE_AFTER_DAYS it will time out identically. Fix when touched: reveal the inactive group before the name-match wait. Pointer: BUG-197 Activity log, 2026-09-29 fixing-lane sweep.
