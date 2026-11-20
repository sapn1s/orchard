```orchard-ticket
{
  "id": "BUG-283",
  "type": "bug",
  "title": "A refused mount save is invisible behind the settings drawer",
  "summary": "Saving a mount whose host path does not exist fails 400, but the server message only reaches the footer strip the open drawer covers, so the user sees nothing and the typed path is lost. Every drawer save (mounts, env, ports, services, container, global) swallows failures the same way.",
  "impact_if_we_wait": "A save silently fails: the user thinks a setting took effect when it did not, loses the value they typed, and only a console line records why.",
  "current_need": "Surface the server's refusal inline in the drawer and keep the unsaved input; sweep every drawer save path through the same visible error.",
  "severity": "medium",
  "area": "ui/settings-drawer",
  "reported": "2026-10-28",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-11-19",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A mount with a nonexistent host path shows the server message inline in the drawer, not only the footer/console",
    "The unsaved input is preserved so the user can correct it",
    "Every other drawer save path surfaces a failed request through the same visible inline error"
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": "claude-opus-4-8",
      "run_id": "visual-review-20261028-061725",
      "verdict": "holds",
      "verdict_on": "2026-10-28",
      "recorded_at": "2026-10-28T04:17:25.908Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs"
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "400dd7e4-8658-468c-b37a-fabfd45cfb8d",
      "verdict": "broken",
      "verdict_on": "2026-10-28",
      "recorded_at": "2026-10-28T09:18:11.452Z",
      "author": "dispatch anthropic (verify r1, property a)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Clean-room CDP attack: blur-commit rows (money/list/image/dockerfile) save half-typed text on a background repaintLive() and double-write garbled values via r3 focus carry-over; close() resends a just-refused unchanged add-form value (saveErr cleared before hide). Fixer suites still 18/18+14/14."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "b464b88b-bb60-4909-8fcc-79c56bc98937",
      "verdict": "broken",
      "verdict_on": "2026-10-28",
      "recorded_at": "2026-10-28T09:18:15.087Z",
      "author": "dispatch anthropic (verify r1, property b)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Refused-save banner (sticky, reserved space ignores pane 16px top padding) overlaps the refused input and controls after scroll, intercepting the click; a refused Enter's focus carry-over steals focus from a DIFFERENT open add-form under latency, typing lands in the wrong field."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "f17bc5f2-a513-4c0c-a6e6-ed86fca0acb3",
      "verdict": "broken",
      "verdict_on": "2026-10-28",
      "recorded_at": "2026-10-28T09:18:18.407Z",
      "author": "dispatch anthropic (verify r1, property c)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Regression: Dockerfile/Base-image blur-commit rows now SAVE a truncated value on background repaint with no banner (old drawer refused all container saves, so nothing stored); access-confirm card (d.accessConfirm) survives drawer close and still saves on reopen."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "357ccb6e-2216-44d9-a33b-5bfda3d4f132",
      "verdict": "holds",
      "verdict_on": "2026-10-28",
      "recorded_at": "2026-10-28T10:16:37.709Z",
      "author": "verify r4 property a",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Property (a) no unbounded/duplicate saves: 62 own CDP checks, 0 failed (Enter+blur, 4x Enter, close mid-save via X/Esc/Ctrl+,/backdrop, refusals, 500/reset PATCH, lens/category switches, window blur, IME, repaint storms); fixer suites 21/21, 18/18, 14/14."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "858d7fdb-66cb-4591-af44-bdace639a548",
      "verdict": "broken",
      "verdict_on": "2026-10-28",
      "recorded_at": "2026-10-28T10:16:58.928Z",
      "author": "verify r4 property b",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "x"
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "396c0b60-7cdf-48ff-8b53-3c2ebca7976c",
      "verdict": "broken",
      "verdict_on": "2026-10-28",
      "recorded_at": "2026-10-28T10:17:11.211Z",
      "author": "verify r4 property c",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "(c) two-break: custom global model id field is outside the edit model (repaint() empties it, drops focus); an add-form closes on a late successful save, losing text typed after Enter."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "87159495-bec6-468f-a5eb-fb2d5668a553",
      "verdict": "broken",
      "verdict_on": "2026-10-28",
      "recorded_at": "2026-10-28T10:17:22.783Z",
      "author": "verify r4 property d",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "(d) two-break: armed confirms other than accessConfirm (the repo-init card) survive X-close and reopen; a late refusal lands as a banner in the NEW category or lens after a switch (deliberate plan-review item 8 choice)."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "75aa1892-565a-4373-9614-e61e35803ee0",
      "verdict": "broken",
      "verdict_on": "2026-10-28",
      "recorded_at": "2026-10-28T11:00:43.356Z",
      "author": "verify r5 property b",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "(b) two-break: access-confirm 'Save and cancel' sends the env map frozen at arm time, deleting a var another writer added (class i, new with FEAT-200 card); a slow snapshot-list response reverts Keep, next exclude save stores stale keep (class iii, same on HEAD)."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "7e9349f9-c4a2-4e4f-b1dd-78387b60ed00",
      "verdict": "broken",
      "verdict_on": "2026-10-28",
      "recorded_at": "2026-10-28T11:00:46.701Z",
      "author": "verify r5 property c",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "(c) two-break: leaving an empty/client-refused add-form for another field repaints in the blur microtask and drops focus to BODY (class i; empty-form variant also on HEAD); repaint() swaps the container card for a loading stub, losing keystrokes in Base image (class ii, worse on HEAD)."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "5bfee31c-1b60-449b-b61d-438fdcc9a51e",
      "verdict": "broken",
      "verdict_on": "2026-10-28",
      "recorded_at": "2026-10-28T11:01:01.819Z",
      "author": "verify r5 property d",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "(d) two-break: late refusals of putTools/putBrowser and saveGlobal (no save ticket; their notify now reaches the inline banner since r1) appear in the reopened drawer after X/Esc/Ctrl+,/backdrop close (class ii)."
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "ba893293-2a39-4b5c-b784-a731b37370dc",
      "verdict": "holds",
      "verdict_on": "2026-11-19",
      "recorded_at": "2026-11-19T23:32:54.109Z",
      "author": "worker (fixing r6)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "e50fdd5effaf0016ea28766c6a1724d079db6d3d9fd9e69fd9869086f25f5153",
      "verify_mode": "mixed-state",
      "note": "Clean-room HOLDS (same provider, OpenAI quota out): fixer test plus 3 adversarial cases. After the freeze, only the fixture name in r6-user-journey changed (leak-gate rename); re-run 15/0."
    }
  ],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": false,
    "Evidence": false,
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

# BUG-283 — A refused mount save is invisible behind the settings drawer

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-28 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-28 — worker (BUG-283 fixing r1)
- **Note:** Fixed. Root cause: every drawer save routed a failure through ctx.notify -> say(), which writes the footer strip (#fine) + console.warn; the open settings drawer covers #fine, so a refused save (e.g. a mount whose host path does not exist -> server 400) reached the user as only a console line, and the add-forms tore down the typed input before the save resolved, losing it. Fix (public/lib/drawer.js, public/index.html, public/styles.css): a single drawer-local notify() chokepoint that still calls ctx.notify but also sets d.saveErr and paints a new sticky inline banner (#dSaveErr, .smerr) at the top of the pane, inside the drawer; put()/putContainer() now return success; the four add-forms (mounts/env/ports/services) keep a draft of the raw text and reopen with it on failure, and scroll the input into view so it sits below the pinned banner. All 50+ ctx.notify sites now route through the chokepoint (class sweep by construction, ARCH-010). saveErr/drafts cleared on category switch, open and close. Verified: scripts/verify-bug-283-saveerr-inline.mjs 13/13 against a REAL scratch server + real container project. PART A (current): a nonexistent mount path surfaces the SERVER message inline, inside #smodal and in-viewport (stricter than offsetParent), input preserved; sweep one check each for services/env-client/env-reserved-key-SERVER-400/ports. PART B must-FAIL (pre-fix public served from a temp repo copy): no #dSaveErr element, refusal text nowhere in the drawer, control confirms it only reached the footer. Screenshots both themes: docs/bugs/assets/BUG-283-mount-error-light.png and -dark.png (visual review caught a first cut where the top-of-pane banner scrolled above the fold; made it position:sticky). gate PASS (exit 0 unpiped); board:check single FAIL is pre-existing FEAT-170, unrelated. Anti-regression: FEAT-155 container-ui UI paths PASS (3 failures are docker image-ownership/cgroup infra, not client JS); FEAT-146 settings-rows 58/59, the 1 fail is a pre-existing FEAT-155 Dockerfile .set-why in the dirty baseline (byte-identical in my pre-fix snapshot, no .set-why touched). Skipped the optional server-side "suggest nearby mount points" enhancement: container-manager.ts and index.ts are mid-change in the working tree. Class contained-render/low-risk UI; independent clean-room verify available but not strictly required for this bucket.

### 2026-10-28 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-4-8 run visual-review-20261028-061725 — VERDICT: HOLDS. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-28 — worker (BUG-283 fixing r2)
- **Note:** Polish (visual review r1→r2): the sticky #dSaveErr .smerr banner overlaid the top of the Mounts type toggle. Root cause: the banner is position:sticky at top:0 inside the scroll host (#dBody), and the add-form input's scrollIntoView({block:'center'}) centred the input, scrolling the Sandbox|Host runtime toggle up UNDER the pinned banner. Fix (public/lib/drawer.js only; CSS unchanged): (1) paintSaveErr() now reserves space ONLY while an error is shown — sets #dBody scrollPaddingTop = banner.offsetHeight+12px when shown, clears it otherwise; (2) all four add-form inputs (mounts/env/ports/services) now scrollIntoView({block:'nearest'}) so the preserved input lands BELOW the sticky banner instead of centring content under it. Banner still position:sticky so it stays visible when the pane is scrolled, but now takes its own space and covers no control. Added check (A4b) to scripts/verify-bug-283-saveerr-inline.mjs: the banner's rect must not intersect the first interactive control under it. Observed (light, fixed): banner {top311,bottom363,left275,right701}; firstCtrl 'New mount' input {top399,bottom420}; intersects=false (36px gap). MUST-FAIL proof: temporarily restoring block:'center' + removing the scroll-padding reservation → A4b FAILS (13 passed, 1 failed); restored → 14 passed, 0 failed. Both theme screenshots re-taken (docs/bugs/assets/BUG-283-mount-error-{light,dark}.png) and reviewed: banner sits in its own strip, input clearly below it, no control covered, both themes. gate PASS exit 0 (unpiped). Class trivial/low-risk contained-render UI.

### 2026-10-28 — worker (BUG-283 fixing r3)
- **Note:** Fixed a request storm and focus loss in the drawer add-forms. regressed-from: BUG-283 r1. Root cause: paint() removes the focused add-form input, and Chrome fires `blur` on a focused node as it is removed. With commit-on-blur, and r1 re-rendering the refused draft into the rebuilt input, rendering itself caused a save. The loop was: refused PATCH → put() repaints → removal-blur → commit → PATCH → refused → … with no bound. The milder, older form (pre-BUG-283, filed separately as BUG-285): when the form was empty, any background repaint (the container-status response, a live-session repaintLive) closed it through the same removal-blur, so focus was lost; a second click worked because the status was cached by then. Fix (public/lib/drawer.js only): (1) a `painting` flag is set while paint() rebuilds the pane, and a blur during a paint, or on a disconnected node, never commits. (2) One shared wireAddInput() wires all four add-forms (mounts/env/ports/services). It keeps the draft on every keystroke, so a background repaint neither loses the typed text nor needs to save it. It allows one save in flight (d.addBusy). It takes focus ONCE, when the form opens or an Enter-save is refused (d.addFocus), not on every render. A blur on just-refused, unchanged text does not resend it and does not pull focus back; Enter still retries. (3) paint() moves focus to the rebuilt twin of the field the user was in (same aria-label, unique) and keeps the selection, so a background repaint doesn't drop focus. (4) put()/putContainer() take an optional settle(ok) that runs before their single repaint, so one state change is one render, not two. Repro (headless brave, real CDP mouse/keys, scratch server, container project mirroring a busy real one; synthetic): after typing a nonexistent path + Enter, the reconstructed r2 drawer sent 2497 PATCHes in ~4.3 s (another run: 1441 PATCH + 2046 form rebuilds in 3 s; the page wedged). The fixed drawer sends exactly 1 PATCH and 1 rebuild. Focus 200 ms after one click on "+ Add mount": r2 BODY in one run and INPUT in another; at 3 s it was BODY. Fixed: INPUT at 200 ms and at 3 s. New suite scripts/verify-bug-283-no-render-loop.mjs: current 18/18 PASS. MUST-FAIL --old r2 drawer: 5 passed / 5 failed + aborted (page unresponsive), with (3a) 1441 writes and (3b) 2046 renders. --old pre-BUG-283 drawer: 6 passed / 12 failed (2 PATCH per Enter from the old Enter+removal-blur double commit; the form closes on a background repaint). Class sweep: env (server 400), ports and services (client) each do ≤1 write and 1 render, show the banner, and keep the text and focus. None of the 12 drawer categories storms while idle (max 4 requests in 2 s). The other blur-commit rows (money, list, dockerfile, image, snapshot exclude, digest guidance) compare against the server value and are bounded at one request, so they were left as they are. /mnt/backup: the live unit has no Protect*/Private* directives, and its mount namespace equals the shell's (mnt:[4026531832]). /proc/<live pid>/mountinfo shows /mnt/backup on sda1 ext4. validateMounts(/mnt/backup) gives no errors; /mnt/backups gives "host path does not exist". Through the real save path a scratch server PATCHed /mnt/backup → 200 and /mnt/backups → 400, and the UI suite step (5) saved /mnt/backup with one PATCH and listed it. Anti-regression: verify-bug-283-saveerr-inline 14/14 (banner, A4b no-overlap, must-fail B); verify-bug-075-mount-chip 9/9; verify-feat-200-access-requests --only SHOTS6 7/7 (the access-confirm path through putContainer); verify-feat-146-settings-content 128 passed / 11 failed, identical to the r2-drawer baseline (128/11 git-fixture/account infra; one snapshot flake on the first run did not recur). Full verify-feat-200 was not completable here: docker container-apply failures, then a timeout, unrelated to drawer.js. gate PASS exit 0 (unpiped). The live Orchard serves public/ from disk, so the fix applies on a browser reload; no restart is needed or was done. Bucket: regression-prone (third round on this file region, live request storm), so an independent clean-room verify is warranted.

### 2026-10-28 — dispatch anthropic (verify r1, property a)
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 400dd7e4-8658-468c-b37a-fabfd45cfb8d — VERDICT: BROKEN — Clean-room CDP attack: blur-commit rows (money/list/image/dockerfile) save half-typed text on a background repaintLive() and double-write garbled values via r3 focus carry-over; close() resends a just-refused unchanged add-form value (saveErr cleared before hide). Fixer suites still 18/18+14/14.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-28 — dispatch anthropic (verify r1, property b)
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run b464b88b-bb60-4909-8fcc-79c56bc98937 — VERDICT: BROKEN — Refused-save banner (sticky, reserved space ignores pane 16px top padding) overlaps the refused input and controls after scroll, intercepting the click; a refused Enter's focus carry-over steals focus from a DIFFERENT open add-form under latency, typing lands in the wrong field.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-28 — dispatch anthropic (verify r1, property c)
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run f17bc5f2-a513-4c0c-a6e6-ed86fca0acb3 — VERDICT: BROKEN — Regression: Dockerfile/Base-image blur-commit rows now SAVE a truncated value on background repaint with no banner (old drawer refused all container saves, so nothing stored); access-confirm card (d.accessConfirm) survives drawer close and still saves on reopen.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-28 — dispatch anthropic (verify r1 — consolidated, BROKEN)
- **Verdict: BROKEN.** Three independent clean-room attackers (openai exhausted → anthropic claude-opus-5-5), one per property, each a separate `scripts/dispatch.mjs` process in its own stripped clean room (CLAUDE.md/AGENTS.md/.claude removed; the fixer's report withheld — tickets' Activity logs blanked), real headless-brave CDP input against a real scratch server + busy container project. The fixer's own suites both still pass as-is (verify-bug-283-no-render-loop 18/18, verify-bug-283-saveerr-inline 14/14) — the breaks live in paths those suites do not cover. Runs: property-a 400dd7e4-8658-468c-b37a-fabfd45cfb8d; property-b b464b88b-bb60-4909-8fcc-79c56bc98937; property-c f17bc5f2-a513-4c0c-a6e6-ed86fca0acb3. Five distinct reproducible defects:
  1. **Blur-commit rows save on a render-caused blur (data corruption). regressed-from: BUG-283 r3.** moneyControl (Spend cap), listRow (Allowed tools), imageRow (Base image), dockerfileRow (Dockerfile) do NOT check the new `painting` flag the add-forms got. One background `repaintLive()` while a field holds half-typed text sends a PATCH of that truncated value (e.g. `{"container":{"image":"ubu"}}`, `allowedTools:["Bas"]`, `maxBudgetUsd:1`); r3's focus carry-over then drops the caret into a stale rebuilt input and continued typing double-writes garbled values (`["ab"]` then `["cdefab"]`). The r3 note claimed these rows "compare against the server value and are bounded at one request, so they were left as they are" — the attackers disprove that: they store strings the user never typed. Old drawer (HEAD) refused all container saves so nothing persisted; the r3 change turned a latent harmless bug into active data corruption. Confirmed by runs a and c. (No banner on these saves either.)
  2. **close() resends a just-refused, unchanged add-form value. regressed-from: BUG-283 r1.** close() clears `d.saveErr` before hiding the modal; the hidden input's removal-blur then fails the "refused & unchanged" guard (which depends on saveErr) and re-runs the save — a refusal becomes 2 writes. Triggered by Ctrl+, (settings toggle) and by any close while a refused add-form is open; seen for mount/env/port/service. Run a.
  3. **Refused-save banner overlaps the refused input / controls after scroll.** The reserved space (banner height + 12px) ignores #dBody's own 16px top padding, so a refusal on a scrolled pane leaves the sticky #dSaveErr covering the input's top ~4–5px; probing the input's top edge returns #dSaveErr and a real click there lands on SECTION, not the input. Env refusal covers the "Remove PYTHONPATH" button. The fixer's A4b check only covers Enter on an UNSCROLLED pane. Run b.
  4. **A refused Enter steals focus from a DIFFERENT open add-form.** `d.addFocus` grabs focus on next render without checking the user has since moved to another form. Under latency: Enter-refuse the env form, click into the port form and type → focus yanks back to env, the user's "00" lands in env (`HOME=/tmp/x00`), port stays `3000:30`. Run b.
  5. **Access-confirm card survives drawer close.** `d.accessConfirm` is not cleared in open()/close() (only saveErr + drafts are); Escape-close then reopen shows the stale confirm card, and "Save and cancel the request" fires a PATCH that saves the pre-close edit and cancels the request. Run c (the approved-request list was injected via CDP Fetch.fulfillRequest; the state-leak is a real code defect on the real drawer/server).
- **Decision — NOT self-fixed; handed back for a fix round.** Finding 1 overturns a deliberate, stated design decision by the r3 fixer (a scope call the fixer/orchestrator should own, not a verify lane), and findings 1–2 are data-loss regressions this fix introduced. Per WA high-stakes rule, a regression-prone/data-loss change (now a 4th round on this file region) must not have generation be its own only verifier; me fixing + re-running my own attackers would reintroduce exactly that. Recommend a fixing round addressing all five, then a fresh independent verify.
- **Artifacts (not age-swept; cited by this verdict):** clean rooms and attacker scripts under `$XDG_STATE_HOME/claude-station/scratch/b283-verify/room-{a,b,c}/` (the claude-station scratch root; atk-*.mjs, rc-*.mjs); full dispatch logs log-{a,b,c}.txt and meta-{a,b,c}.json in that dir.

### 2026-10-28 — worker
- **BUG-283 fixing r4 (redesign):** Redesign (plan+review), regressed-from: BUG-283 r1 and r3 (verify r1 F1-F5). Two-break signal: 5 breaks via 5 paths after 3 rounds; shared cause = transient edit state scattered across DOM + ad-hoc flags (d.*Draft, addFocus/addTried/addBusy, saveErr, accessConfirm) and a removal-blur indistinguishable from a user blur at each handler. Design (public/lib/drawer.js only): (1) ONE edit model `edit` {drafts, per-render reg, busy/queued, focusKey, sel, epoch, openSeq}; every free-text field (Spend cap, Allowed/Disallowed tools, Base image, Dockerfile, Excluded dirs, Response guidance, and the 4 add-forms) is wired ONLY by bindField(), rendered FROM its draft; (2) ONE commitField() is the only save path: value from the model, no save if equal to stored (normalised) or to the last refused value (only an explicit Enter retries), one in flight per field + one queued re-run; a blur saves only if a microtask later the field is still connected, the drawer open and the window still has it focused (removal-, close- and window-blur never save); (3) paint() restores focus only to edit.focusKey (set by a delegated focusin, cleared by a user blur) with its caret — replaces d.addFocus; IME composition defers background paints; (4) resetEdit() is the one clearer (open/close/category/lens/project change) incl. saveErr, accessConfirm, add-form flags; closeModal judges the focused field BEFORE resetting (F2); results from an older epoch never touch drafts/confirm, from an older open never reach the banner (footer only); (5) saves are serialized per server resource and build their value when they RUN from fresh settings (× remove by identity, add-forms, env/ports patches), pinned to the project they were made in; (6) F3: scroll-padding = #dBody padding-top + banner height + 12. Plan review: anthropic claude-opus-5-5 run b31cbf1c-8e1b-4af7-b898-356a9badf20b APPROVE-WITH-CHANGES; items 1-6, 7 (project change), 9-11, 13-15 adopted; 8 adopted as openSeq vs epoch; 12 partly (grep covers blur/focusout; change listeners are selects only); 16 not done (background status errors can still overwrite the banner). Behaviour changes: a bad Spend cap keeps the typed text with the banner; Esc in an add-form closes only the form, Esc in an edited row reverts it (neither closes the drawer on that keypress); a typed or refused add-form counts as an uncommitted edit for the Esc/Ctrl+,/backdrop close guard (as before BUG-283 r1). New suite scripts/verify-bug-283-r4-edit-model.mjs (real CDP input, scratch server, busy container project; synthetic): current 21/21 PASS; MUST-FAIL --old r3 drawer: 7 passed / 14 failed — F1 x7 (e.g. Allowed tools stored ["adBash","Re"], guidance "se pleasebe ter", Spend cap 251), F2 (2 PATCH), F3c (reserved 64 < stuck banner bottom 68), F4 (focus yanked, env "HOME=/tmp/x00"), F5 (stale card), P1 (× during add drops C), P3 (late refusal banner after reopen), S (7 blur sites). F3 real-wheel paths and P2 (project switch mid access-check) did not reproduce on r3 (kept as anti-regressions). Anti-regression: verify-bug-283-no-render-loop 18/18, verify-bug-283-saveerr-inline 14/14 (needed takeLive(): an explicit commit reads the live connected field, so a value set without an input event still saves), verify-bug-075-mount-chip 9/9, verify-feat-200-access-requests --only SHOTS6 7/7, verify-feat-146-settings-content 128/11 (same 11 git-fixture/account infra failures as the r3 baseline). npm run gate exit 1: leak-gate hits only in other lanes' files (scripts/_f202-*.mjs, scripts/verify-feat-202-poll-cost.mjs); typecheck PASS; none of my files flagged. No restart; public/ served from disk. Bucket: regression-prone, independent verify dispatched (4 attackers, one per property).

### 2026-10-28 — verify r4 property a
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 357ccb6e-2216-44d9-a33b-5bfda3d4f132 — VERDICT: HOLDS — Property (a) no unbounded/duplicate saves: 62 own CDP checks, 0 failed (Enter+blur, 4x Enter, close mid-save via X/Esc/Ctrl+,/backdrop, refusals, 500/reset PATCH, lens/category switches, window blur, IME, repaint storms); fixer suites 21/21, 18/18, 14/14.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-28 — verify r4 property b
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 858d7fdb-66cb-4591-af44-bdace639a548 — VERDICT: BROKEN — x. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-28 — verify r4 property c
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 396c0b60-7cdf-48ff-8b53-3c2ebca7976c — VERDICT: BROKEN — (c) two-break: custom global model id field is outside the edit model (repaint() empties it, drops focus); an add-form closes on a late successful save, losing text typed after Enter.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-28 — verify r4 property d
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 87159495-bec6-468f-a5eb-fb2d5668a553 — VERDICT: BROKEN — (d) two-break: armed confirms other than accessConfirm (the repo-init card) survive X-close and reopen; a late refusal lands as a banner in the NEW category or lens after a switch (deliberate plan-review item 8 choice).. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-28 — worker (BUG-283 fixing r4)
- **verify r4 consolidated: 1 HOLDS, 3 BROKEN, two-break STOP:** Four concurrent clean-room attackers (anthropic claude-opus-5-5, separate scripts/dispatch.mjs processes, rooms under $XDG_STATE_HOME/claude-station/scratch/b283r4-verify/room-{a,b,c,d}, logs log-{a..d}.txt, meta-{a..d}.json), real CDP input, scratch servers, busy container project. All four first ran the fixer suites: 21/21, 18/18, 14/14. None re-broke F1-F5. (a) no unbounded/duplicate saves — HOLDS, run 357ccb6e-2216-44d9-a33b-5bfda3d4f132, 62 own checks 0 failed. (b) no uncommitted value saved — BROKEN, run 858d7fdb-66cb-4591-af44-bdace639a548 (its typed note was cut to "x" by a 300-char refusal on the first attempt; detail here): b1 IN-MODEL DEFECT: a row Enter, then its own blur while the PATCH is held, queues a re-run that commits the CURRENT draft, so text typed after committing is saved (Spend cap committed 3, stored 300; Allowed tools Read -> [Read,Bash]; Excluded dist -> [dist,src]; guidance "two UNCOMMITTED"); side: a queued Base-image save is dropped when its row is not rendered. b2 PRE-EXISTING (since HEAD): env add-form trims a trailing space off the value. (c) focus/text survive repaint — BROKEN, run 396c0b60-7cdf-48ff-8b53-3c2ebca7976c: c1 SCOPE GAP: the "Custom global default model id" field (machine Defaults, customEdit path) is not bound to the model; drawer.repaint() empties and hides it and drops focus. c2 IN-MODEL DEFECT: an add-form whose save succeeds late closes although the user typed new text after Enter (AAA=1 saved, BBB and focus lost). (d) close/reopen no stale state — BROKEN, run 87159495-bec6-468f-a5eb-fb2d5668a553: d1 SCOPE GAP (pre-existing): armed ceremonies other than accessConfirm (repo-init card gitArm; by code also procConfirm, memConfirm, acctConfirm) survive X-close and reopen; resetEdit clears only accessConfirm. d2 CONTRACT QUESTION: a late refusal from a held save lands as an inline banner in the NEW category or lens after a switch — deliberate (plan review item 8: the footer is covered, so hiding it loses the refusal), the attacker reads it as stale. TWO-BREAK STOP (charter): b, c and d each broke twice via different paths, so no further patch round was run. Classification for the design review: the redesign chokepoint held for F1-F5 and property (a); 2 breaks are defects INSIDE the one commit path (queued re-run reads the latest draft instead of the committed value; add-form close ignores a newer draft) — each a one-place fix in commitField/settle; 2 are membership gaps of the model (an unbound free-text field; armed ceremonies outside resetEdit); 1 pre-existing trim; 1 contract call. Recommendation (needs the orchestrator/design review): KEEP the redesign and approve ONE bounded patch round: queue the committed value (and its binding) instead of re-reading the draft; close an add-form on success only when no newer draft exists; fold every armed ceremony into resetEdit(true); bind the custom model id field(s) through bindField; keep the env value untrimmed; decide d2 (recommend: keep the banner but prefix it with the section it came from). Re-attack b, c, d only. Gate: npm run gate exit 1, leak-gate hits only in other lanes files (scripts/_f202-*.mjs, scripts/verify-feat-202-poll-cost.mjs), typecheck PASS.

### 2026-10-28 — orchestrator (relayed by worker)
- **decision after verify r4:** Decision (orchestrator): KEEP the r4 redesign and run ONE bounded, final round — the breaks are fields/cards not yet inside the edit model, not holes in its design. Build: (1) queue the committed value, never re-read the draft; (2) close an add-form on success only if no newer text exists; (3) clear EVERY confirm card in the one reset function; (4) bind the custom model id field to the model; (5) stop trimming the env value; (6) keep a late refusal visible, labelled with its section. Plus a static sweep in the suite asserting every input and confirm card in drawer.js is model-bound. Must-fail each new break; re-attack (b), (c), (d) only, concurrently, separate processes, two-break STOP. Last round: if anything breaks again, stop and report.

### 2026-10-28 — worker
- **BUG-283 fixing r5 (final bounded round):** Built the six decided items in public/lib/drawer.js. (1) A commit that arrives while the field is saving queues {value, binding} — the value committed THEN, never re-read from the draft; a queued value identical to the one in flight is dropped; the busy check now runs before the stored-value comparison (committing the old value back right after another commit is a real change); a queued run whose row is not rendered keeps its binding, and every row commit compares against FRESH settings, not its render. Root cause found on the way: edit.queued was still a Set while r4 code called .set/.get, so any queued commit threw silently — r4 "queued re-run" never actually ran; Spend cap 3->300 came from the close-flush instead. (2) Add-forms close on success only if no newer text than the saved value exists (newerThan). (3) resetEdit() is the ONE clearer of every confirm card / armed state: accessConfirm, acctConfirm, confirmDelete, memConfirm, procConfirm, gitArm, wiringArm, armSocket, restore, repoint.arm, customEdit, gModelCustomOpen, acctAdd (unless busy; a late failure no longer reopens it), the add-forms, composing. (4) New bindDraft(): explicit-Save fields keep their text in the model (rendered from it, focus+caret restored, no blur-save): Custom global default model id (row/select state kept in d.gModelCustomOpen), custom-value editors, repoint directory, repo name, restore confirmation, account label, sign-in code; the read-only sign-in URL is marked exempt. (5) The env value is no longer trimmed (only leading space before the KEY). (6) A refusal landing after a section/lens switch in the same open drawer stays on the banner labelled "<Section>[ · this session] — …"; after close/reopen it goes to the footer only. Static sweeps in scripts/verify-bug-283-r4-edit-model.mjs: (S2) all 18 text inputs/textareas built in drawer.js are bindField/bindDraft-bound or carry `// edit-model: exempt — <reason>` (1 exempt); (S3) every `d` key named *confirm*/*arm* plus restore, customEdit, add-forms, gModelCustomOpen, accessConfirm and repoint.arm is cleared in resetEdit. Suite now 31/31 on the current drawer; MUST-FAIL --old r4 drawer: 21 passed / 10 failed — S2, S3, V-b1 Spend cap + Allowed tools, V-b1b (second commit dropped), V-b2 (trailing space), V-c1 (custom model id), V-c2 (add-form closes over newer text), V-d1 (Init repository card survives X+reopen), V-d2 (unlabelled late refusal). Anti-regression: verify-bug-283-no-render-loop 18/18, verify-bug-283-saveerr-inline 14/14, verify-bug-075-mount-chip 9/9, verify-feat-200-access-requests --only SHOTS6 7/7, verify-feat-146-settings-content 128/11 with the identical 11 infra failures as before. npm run gate exit 0 (unpiped). Re-attack of (b), (c), (d) dispatched as three concurrent clean-room processes (final round).

### 2026-10-28 — verify r5 property b
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 75aa1892-565a-4373-9614-e61e35803ee0 — VERDICT: BROKEN — (b) two-break: access-confirm 'Save and cancel' sends the env map frozen at arm time, deleting a var another writer added (class i, new with FEAT-200 card); a slow snapshot-list response reverts Keep, next exclude save stores stale keep (class iii, same on HEAD).. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-28 — verify r5 property c
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 7e9349f9-c4a2-4e4f-b1dd-78387b60ed00 — VERDICT: BROKEN — (c) two-break: leaving an empty/client-refused add-form for another field repaints in the blur microtask and drops focus to BODY (class i; empty-form variant also on HEAD); repaint() swaps the container card for a loading stub, losing keystrokes in Base image (class ii, worse on HEAD).. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-28 — verify r5 property d
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 5bfee31c-1b60-449b-b61d-438fdcc9a51e — VERDICT: BROKEN — (d) two-break: late refusals of putTools/putBrowser and saveGlobal (no save ticket; their notify now reaches the inline banner since r1) appear in the reopened drawer after X/Esc/Ctrl+,/backdrop close (class ii).. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-28 — worker (BUG-283 fixing r5)
- **verify r5 consolidated: (b)(c)(d) BROKEN again, final-round STOP:** Re-attack of (b), (c), (d) only: three concurrent clean-room anthropic claude-opus-5-5 processes (rooms under the claude-station scratch dir b283r4-verify/r5room-{b,c,d}, logs r5-log-*.txt). All ran the fixer suites first: 31/31, 18/18, 14/14. All six r4 breaks re-attacked and HELD (queued commits store only committed values incl. 3/400/4000 and alpine->debian; env whitespace exact; custom model id, two add-forms, IME, caret, late refusals while typing; repo-init and access cards cleared on close). Each property broke twice AGAIN via new paths, so per the orchestrator decision (last round: if anything breaks again, stop and report) no further patching. (b) run 75aa1892-565a-4373-9614-e61e35803ee0: b1 new with the FEAT-200 card: Save and cancel the request sends the env map frozen when the card armed, so a var another writer added meanwhile is deleted; b2 pre-existing (identical on HEAD): a slow snapshot-list response reverts Keep 5->10 and the next Excluded-dirs save stores keep:10. (c) run 7e9349f9-c4a2-4e4f-b1dd-78387b60ed00: c1 commit path: leaving an EMPTY or client-refused add-form by click/Tab into another field repaints synchronously inside the blur microtask and focus falls to BODY (empty-form variant also fails on HEAD); c2 outside the model (worse on HEAD): drawer.repaint() sets d.container=undefined and swaps the container card (Base image, Dockerfile) for a loading stub, so keystrokes in that window are lost. (d) run 5bfee31c-1b60-449b-b61d-438fdcc9a51e: d1+d2 outside the model: putTools, putBrowser and saveGlobal take no save ticket; since r1 their failures use the drawer notify() (inline banner) instead of ctx.notify, so a late 500 lands as a banner in the REOPENED drawer; about 8 more un-ticketed notify-after-await sites listed by the attacker (repoint, repo/browser/container actions, snapshot actions, template save, account add). Pattern: the chokepoint covers free-text fields and their saves, but other save paths (toggles, selects, globals, actions) and other transient render state (container loading stub, snapshot cache) bypass it. Options: (1) RESCOPE - accept r5 for BUG-283/285 (F1-F5 and all r4 breaks fixed, suites + gate green) and file the remaining classes as one scoped follow-up; (2) REDESIGN further - every drawer write through serial()+ticket() with notify() refusing untagged late errors, commit-caused repaints deferred out of the blur microtask, bound fields kept while d.container reloads; (3) KEEP PATCHING - budget spent. Recommendation: (1) for these tickets + (2) as a new ticket. Owner decision needed. npm run gate exit 0. No restart.

### 2026-11-19 — worker (fixing r6)
- **Note:** r6. INTENT (verbatim, session 4ea3d0d2, 2026-10-28T03:45:35Z): "oh ok, but either way, i got this error from console, should appear nicely in ux as toast or smtn". Acceptance: the refusal is visible in the UI where the user is looking (not console-only), nicely. Hypothesis "a toast is required" REFUTED: "toast or smtn" admits the r1-r5 inline banner, so the banner was kept (no toast component reused). CHANGES (public/lib/drawer.js): (1) banner flush on the scrollport: top = -paddingTop, scrollPaddingTop = banner height + 12 (r5 left a 16px gap where content scrolled above it; regressed-from: BUG-283 r1/r4). (2) verify r5 d1/d2: new tell(ticket,msg,isErr) routes every post-await notify (about 25 handlers: tools, browser, git, terminal, snapshots, restore, container, templates, global, accounts, runtime, memory, process kill) by the ticket taken at handler start. A late result after close/reopen goes to the footer only, never the reopened banner (regressed-from: BUG-283 r1 notify routing). (3) verify r5 b1: "Save and cancel the request" re-builds the env/ports patch from refreshed settings when clicked; it no longer sends the map frozen when the card armed. TESTS: scripts/verify-bug-283-r4-edit-model.mjs gained S4 (a static sweep that fails on a bare notify after an await), V-d3/X, V-d3/Escape, V-d4 and V-b3. The new scripts/verify-bug-283-r6-user-journey.mjs runs Playwright over Brave, light and dark themes, on a synthetic busy project: the user journey Add mount, /backups, Enter, checking visible, on top, contrast (light 6.64, dark 6.13), flush, input kept and focused, 1 PATCH. MUST-FAIL: edit-model on the r5 drawer 32/3 (S4, V-d3 x2); V-b3 before the b1 fix 34/2 (V-b3: OTHER deleted; F1 a one-off timing flake, passed in every later run); user-journey on HEAD 1/14 (refusal console-only, input lost), on r5 13/2 (16px gap). AFTER: edit-model 36/0, user-journey 15/0, saveerr-inline 14/0, no-render-loop 18/0, bug-075 mount-chip 9/9, BUG-287 12/0, BUG-292 27/0, BUG-296 31/0, feat-200 SHOTS6 7/0 (run before the b1 change). Screenshots reviewed in both themes. NOT FIXED: b2 (a slow snapshot-list response reverts Keep) is pre-existing on HEAD, outside this ticket, not filed; c1 (focus to BODY) and c2 (container loading stub) are BUG-285 scope.

### 2026-11-19 — worker (fixing r6)
- **Verification recorded:** dispatch anthropic run ba893293-2a39-4b5c-b784-a731b37370dc — VERDICT: HOLDS — mixed-state candidate e50fdd5effaf — Clean-room HOLDS (same provider, OpenAI quota out): fixer test plus 3 adversarial cases. After the freeze, only the fixture name in r6-user-journey changed (leak-gate rename); re-run 15/0.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-11-19 — worker (verify r1)
- **Note:** Gate check (verify r1): npm run gate exits 0 (leak-gate, check-nul, unicode-separators, prompt-privacy, pre-push-hook, typecheck all PASS); the reported failure was npm run test:manifest:check (exit 1, STALE): the new scripts/verify-bug-283-r6-user-journey.mjs, scripts/verify-bug-287-foreign-lens.mjs and scripts/verify-arch-023-bug-272-r8.mjs were not registered. Fixed by regenerating scripts/test-manifest.json (node scripts/gen-test-manifest.mjs; check now exit 0). Test files unchanged. Re-ran anyway: edit-model 36/0, r6 user-journey 15/0, BUG-287 12/0, BUG-292 27/0, BUG-296 31/0.
