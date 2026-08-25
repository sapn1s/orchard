# BUG-087 — opening a session shows the PREVIOUSLY-viewed session's transcript, not the one opened (header/content mismatch)

- **Status:** VERIFIED — fixed 2026-08-13 (§C incl. must-FAIL-pre-fix proof + un-raced-open regression)
- **Area:** FE session open / transcript load (app.js openSession → renderMessages)
- **Reported:** 2026-08-13 by user:
  > "it brought me to one of last existing detected claude sessions as title of session indicated it
  > … but the content was actually our current orchard session's context, i assume it brought the
  > context of last viewed session instead of using the one selected/new — this is a bug part."

## Symptom
Selecting a project (add-project) opened a session whose HEADER/TITLE correctly showed the target
project's detected session, but the CONTENT pane still displayed the PREVIOUSLY-viewed session's
transcript (the current orchard session). So the header updated while the transcript did not — the
pane shows session Y's content under session X's title. Same class as BUG-083 (stale content on
switch): the transcript load for the newly-opened session didn't replace the prior one (a
transcript-load race or a missed reload on this open path).

## Wanted
1. Opening ANY session (via add-project, a sidebar row, or new-session) must show THAT session's
   transcript — never the previously-viewed one. The header, title, and content must always agree.
2. On open, clear the outgoing transcript immediately (BUG-083's `snapScope` pattern for the strip
   has a sibling here for the message pane) and load the target's; a stale in-flight transcript
   fetch from the prior session must not paint after the switch.
3. Reconcile with the add-project open path specifically (the reported trigger) — whatever session
   it opens, its content loads correctly.

## Verification (§C)
happy-dom/real-shape: open session A (content A shown) → open session B via add-project/selection →
content pane shows B's transcript, not A's (must FAIL pre-fix: A's content under B's header); a
slow/in-flight transcript fetch for A landing after the switch to B is dropped (scope guard).
Anti-regressions: verify:bug-083-project-switch-state, verify:reload-live, verify:session-switch-url,
verify:ui, typecheck, leak-gate.

## Activity log (APPEND-ONLY)
### 2026-08-13 — orchestrator
- Filed from user report. Client-only. Same stale-content class as BUG-083; likely a transcript
  load/scope issue on the open path. QUEUED behind the FEAT-073/BUG-086 app.js agent (same file).

### 2026-08-13 — worker (fix + §C)
- ROOT CAUSE (cited): the reported trigger is the add-project open path. `addProject`
  (public/app.js:8425) set the header/title to a New session (`state.current = {…}`, and
  `paintCrown()`/`renderTree()`) but — unlike `openSession`/`startNew` — NEVER reset the message
  pane. `resetTranscript()` is what does `clear(node.panes)` + a fresh `newThread('main')`; without
  it the pane kept the PREVIOUSLY-viewed session's transcript, so the header said "New session" while
  the content was the old session (exactly the "content of last viewed session" the user reported).
  The transcript panes are rebuilt per open (`newThread` at app.js:2351 creates a NEW `paneEl` each
  time), so the pure openSession→openSession fetch race is already self-protecting (a stale fetch
  paints into a now-detached pane) — the observable defect was the MISSING reset on the add-project
  path, plus the sibling scope guard the ticket asked for as belt-and-suspenders.
- FIX (public/app.js):
  1. Add-project now resets the pane. `addProject` saves the outgoing draft, `closeSocket()` +
     `followCurrent()` (drop the old session's live socket/watch), `resetTranscript()` (clear +
     rebuild the pane), and un-hides the composer — so header and content agree and the outgoing
     transcript clears immediately on this open path, like every other boundary.
  2. `state.txScope` — a monotonic token bumped in `resetTranscript()` alongside `snapScope`
     (BUG-083's running-strip sibling, now for the message pane). `openSession` captures it right
     after `resetTranscript()` and DROPS its transcript answer (`if (scope !== state.txScope) return;`)
     both at the fetch-resolved seam and in the catch — so a late transcript fetch from the prior
     session can never paint under the newly-opened session, even on a path that reuses the pane.
- §C — scripts/verify-bug-087-stale-transcript.mjs (npm `verify:bug-087-stale-transcript`): REAL
  app.js in happy-dom vs a REAL server; session A's transcript is stubbed with a unique marker and
  gated at the fetch seam so it can be left IN FLIGHT across a REAL `addProject` switch (a fresh temp
  dir the server registers).
  - POST-FIX: 6/6 PASS.
  - PRE-FIX (the addProject reset + the txScope guard stripped, the addProject export kept so the
    harness runs): the 2 must-FAIL assertions FAILED — after add-project the pane still showed A's
    transcript (stale content under the new header), and a late in-flight A fetch repainted it. The
    regression (a normal un-raced open still paints its own content) stayed green pre AND post.
- Anti-regressions all green: verify:bug-083-project-switch-state (10/10), verify:reload-live (3/0),
  verify:session-switch-url (7/0), verify:ui (7/0), typecheck (0), leak-gate (PASS).
- Status → VERIFIED. Commit: "BUG-087: transcript pane scoped to the opened session (stale fetch dropped)".
