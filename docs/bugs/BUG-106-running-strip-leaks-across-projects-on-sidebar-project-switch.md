```orchard-ticket
{
  "id": "BUG-106",
  "type": "bug",
  "title": "Live agents from one project showed under another project",
  "summary": "The dashboard's list of currently running agents stayed bound to whichever session was last opened. Selecting a different project in the sidebar left the previous project's live rows and its permission notice on screen, still ticking. Selecting a project now re-scopes that area, and the case that reproduced the leak fails before the fix and passes after it.",
  "impact_if_we_wait": "People trust a live view that attributes one project's work to another. Bounded: this is display-correctness only, no stored data is affected, and opening any session in the newly selected project already cleared it.",
  "current_need": "Nothing is outstanding. The leak case, the own-project case, an empty project and switching back all pass, and two clean-room findings raised against the first attempt were fixed.",
  "severity": "medium",
  "area": "Running agents view",
  "reported": "2026-08-18",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-08-18",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-18",
      "question": "Should a project switch hide the foreign session's live rows, or fully re-scope the dock?",
      "mode": "single",
      "options_keys": [
        "A",
        "B"
      ],
      "chosen": "A",
      "chosen_on": "2026-08-18",
      "chosen_by": "user",
      "note": "Gate the live rows and the permission notice on the open session belonging to the selected project, and stop refreshing while it is foreign. The heavier full-navigation option risked discarding a conversation the user may return to."
    }
  ],
  "success_criteria": [
    "Selecting a different project clears live rows belonging to the previously opened session",
    "A project's own running work still shows while that project is selected",
    "A project with nothing running shows an empty list, not stale rows",
    "Switching back to the owning project restores the real running rows",
    "The permission notice is re-scoped on the same boundary as the running rows"
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "symbol": "selectProject",
      "note": "the sidebar project-header action; mutated state.current.projectId without touching the transcript dock"
    },
    {
      "path": "public/app.js",
      "symbol": "resetTranscript",
      "note": "the only clearer of state.snap, and it was called only from openSession"
    },
    {
      "path": "public/app.js",
      "symbol": "pollRunning",
      "note": "re-fetched the open session's running set every 4s, so the foreign rows persisted rather than merely lagging"
    },
    {
      "path": "public/app.js",
      "symbol": "renderStrip",
      "note": "paints the running rows; the permission notice paints separately near the transcript dock header"
    },
    {
      "path": "public/index.html",
      "symbol": "#strip / #stripRows / #permLine",
      "note": "the running rows and permission notice live in the transcript dock, bound to the one open session"
    },
    {
      "path": "src/server/running-set.ts",
      "symbol": "snapshotOfSession",
      "note": "server side is correctly scoped per session and was deliberately not changed"
    }
  ],
  "related": [
    {
      "id": "ARCH-005",
      "relation": "recurrence_of"
    },
    {
      "id": "BUG-033",
      "relation": "see_also"
    },
    {
      "id": "BUG-034",
      "relation": "see_also"
    },
    {
      "id": "BUG-083",
      "relation": "see_also"
    },
    {
      "id": "BUG-112",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a01620-b941-7662-b99b-84edb0f50475",
      "verdict": "broken",
      "verdict_on": "2026-08-18",
      "harness": "scripts/independent-verify.mjs"
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a0164a-53e6-7942-b054-6943a596576a",
      "verdict": "broken",
      "verdict_on": "2026-08-18",
      "harness": "scripts/independent-verify.mjs"
    }
  ],
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
    "archived_path": "docs/bugs/archive/BUG-106-running-strip-leaks-across-projects-on-sidebar-project-switch.md",
    "sha256": "f45b23c9cb20ffe7e78199689c429de121aacc6ef5a5b61d1d37e039b556cb49",
    "bytes": 31655,
    "original_title": "the \"Running\" list keeps showing one project's live agents while you are looking at another project",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head: symptom, the client-versus-server analysis, the reproduction result, the chosen option, the four required cases and the executed suites are all present.",
    "dropped": [
      "the scratch reproduction script path under /tmp, since the suite was promoted",
      "approximate line numbers for each function, which drift"
    ]
  }
}
```

# BUG-106 — Live agents from one project showed under another project

## Diagnosis

### Client view-coherence, not a data leak

`selectProject(id)` sets `state.current.projectId`, repaints the crown and the right rail, and returns. It never touches `state.snap`, the strip DOM, the permission hairline, the driving socket, or the running-set poll — all of which stay bound to whatever session is OPEN. Only `resetTranscript()` clears `state.snap` and bumps `state.snapScope`, and it is called only from `openSession()`.

After a bare project-header click, `state.current` is internally inconsistent: `projectId` points at the newly selected project while `sessionId`/`encodedDir` still point at the old session. The strip and hairline read the open session; the sidebar, rail and crown read the selected project.

`pollRunning()` is what makes it persist rather than lag: it fetches `state.stationSessionId || state.sdkSessionId || state.current.sessionId` every `SNAP_POLL_MS` (4s), and `snapshotIsForCurrent()` accepts the result because the session ids still match.

### Why the server was left alone

`snapshotOfSession` builds one snapshot for one `AgentSession`; the `running-snapshot` push goes only on that session's own driving socket; `GET /api/sessions/:id/running` answers for one session id. Nothing broadcasts across projects. There is also no global "everything running everywhere" view to preserve — the strip is a single element in the transcript dock, with no per-project sidebar badge and no activity feed.

## Evidence

The scratch reproduction used the BUG-083 harness idiom — real server, real `app.js` in happy-dom, two real registered projects, the real sidebar project-header click. On unmodified `cb2ceb2` the preconditions passed and the leak assertion failed: `stripHidden=false worker=true rows=2 snap=set` while the selected project had already switched.

The user's verbatim report was a row reading "Running / 5:37 / worker / Test cheap-model claim checking / 5:37 / Permissions skipped · container is the boundary" persisting under an unrelated project.

After the fix: `verify:bug-106-crossproject-strip` 33/33 passing, `verify:msg-timestamp-hover` 24/24 passing, `verify:independent-verification` 10/10 passing, with must-FAIL cases for both clean-room defects. The hairline half of the original report was not reproduced in the first run only because the neighbour session was not a container skip-perms session, so the hairline was already hidden; the mechanism is the same paint path.

## Implementation notes

The open session's owning project is tracked separately from the sidebar-selected project — previously `selectProject` overwrote the single `state.current.projectId` and destroyed the distinction. When the two differ, the strip and permission hairline render as absent, the same end state `resetTranscript` produces, without closing the open session or clearing its transcript. The running-set poll is suppressed while the open session is foreign to the selected project.

BUG-083 fixed this same strip for the `openSession` and `startNew` boundaries using the `snapScope` token, and that fix is intact. Its suite does not cover the `selectProject` boundary, which never calls `resetTranscript`, so no scope token moved and nothing cleared. This ticket is that uncovered boundary; it is not a regression of the earlier fix.

`public/app.js` is a single large file edited by one lane at a time, so this coordinated with any other in-flight work on it. `src/server/agent-bridge.ts` was owned by a live lane and was not needed here.

## Verification plan

Four cases, all in the promoted suite: the leak direction (a foreign project's rows clear on project switch); the own direction (a project's own running work still shows); an empty project shows nothing; and switching back to the owning project restores the real rows. Because this is a scoping and observability-honesty fix — the regression-prone family BUG-083 already sits in — an independent clean-room dispatch was required in addition to the fixer's own suites.

## Risks

A fix that simply hides everything would be worse than the bug, so the own-project and switch-back directions carry as much weight as the leak direction.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-18 — investigation lane (worker, Opus 4.8)
- **Understood:** the running strip and permission hairline live in the transcript dock and are bound to the OPEN session. `selectProject` (sidebar project-header click) changes `state.current.projectId` and repaints only the crown + right rail; it never clears `state.snap` or re-scopes the strip, and the 4s running-set poll keeps re-fetching the open (foreign) session. So after a bare project switch the strip shows the previously-opened project's live agents under the newly-selected project. The reported guess (state served globally by the server) is disproven: the server's running set is correctly per-session (`running-set.ts`, per-session push socket, per-id poll route). This is a client view-coherence bug at the `selectProject` boundary — one of the exact "STOP and report" cases in the dispatch charter — so it is filed OPEN with a recommended fix rather than fixed here, because the intended behaviour (Option A vs B above) is a UX decision for the orchestrator to sequence.
- **Changed:** nothing in the product code. New ticket file only.
- **Verified (must-FAIL only — no fix to prove yet):** real reproduction via the BUG-083 harness idiom (real server + real `app.js` in happy-dom, two registered projects, the real sidebar project-header click). On `cb2ceb2`: `4/5` checks, the leak check `FAIL` — `stripHidden=false worker=true rows=2 snap=set` after `selectProject(B)`. Script: `/tmp/repro-crossproject-strip.mjs` (scratch, not committed).
- **Still open / handoff:** next agent should (1) get the orchestrator's Option A/B decision; (2) implement in `public/app.js` — separate the open-session's owning project from the sidebar-selected project so the strip/hairline can be gated on match, and stop/ignore `pollRunning` while the open session is foreign to the selection; (3) prove all four directions (leak clears / own shows / empty shows nothing / switch-back restores) in both themes with the brave-CDP visual gate + `shot-luma.mjs`; (4) extend `verify-bug-083-project-switch-state.mjs` (or add `verify-bug-106-*`) with the `selectProject` boundary; (5) add a clean-room `Verified-by:` dispatch line before VERIFIED.
- **Symptom of a deeper design flaw?** open — a candidate: `state.current` conflates "the project I am browsing in the sidebar" with "the project that owns the session on screen", and every surface reads whichever half it happens to want. BUG-083 patched one boundary of this same conflation; this is a second. If a third boundary appears, that is an ARCH ticket (a single owner for "what is on screen") rather than a third point-fix.

### 2026-08-18 — fix lane (worker, Opus 4.8) — Option A implemented (orchestrator's call)
- **Understood:** confirmed the investigation's root cause. `state.current` conflates "sidebar-selected project" with "project that owns the open session"; `selectProject` moved the former and left the strip / permission hairline / running poll bound to the latter.
- **Changed (`public/app.js`):**
  - New `state.openProjectId` — the project that OWNS the open transcript dock, set by `openSession` and `startNew`, deliberately NOT touched by `selectProject`. This restores the distinction `selectProject` used to destroy.
  - New predicate `dockIsForeign()` = an open session exists whose owner ≠ the sidebar selection.
  - Gated on it: `renderStrip()` (renders empty/hidden when foreign — same end-state `resetTranscript` gives, but `state.snap` + the socket are KEPT), `paintPerm()`'s composer hairline (hidden when foreign), `renderRailSummary()`'s FEAT-067 "live" count chip (omitted when foreign — same observability lie, closed too), and `pollRunning()` (early-returns while foreign, so the foreign session's running set is neither re-fetched nor re-applied; a push on its own socket still keeps `state.snap` warm for the switch-back).
  - `selectProject` now re-scopes the dock's session-bound surfaces on the boundary in BOTH directions (hide when foreign, restore via `paintPerm`/`renderStrip`/`renderRailSummary` when the selection returns to the owner) — only when a session is actually open. The open session is never closed (Option A: a look, not a navigation).
  - Also removed the raw NUL delimiter in `draftKey`'s composite key (runtime byte-identical `\x00`, proven equal; the key is an in-memory `state.drafts` Map key only, never persisted/compared against storage) so `public/app.js` is searchable by the Bash grep shim again; took it off `scripts/check-nul.mjs`'s allowlist (coordinator hand-off from the BUG-103 lane).
- **Verified:** `scripts/verify-bug-106-crossproject-strip.mjs` (committed) — REAL server + REAL `app.js` in happy-dom, TWO registered projects (A = neighbor with on-disk sessions, B = fresh empty dir), the REAL sidebar project-header CLICK. 16/16. All four required directions proven: (1) LEAK clears — strip/hairline/live-count gone after selecting B; (2) OWN shows — A's worker row present while A is selected; (3) EMPTY shows nothing — B has no live work; (4) SWITCH-BACK restores the real strip + hairline from the kept snapshot, session never discarded. Permission-hairline half covered explicitly (container skip-perms effective config → "permissions skipped · container is the boundary" hidden under B, restored under A). **Must-FAIL proven** by neutralising `dockIsForeign()` to `return false` (the single predicate the whole fix routes through): 5 leak checks flip to FAIL, restored on revert. Anti-regress: BUG-083 10/10 (its two boundaries intact), `npx tsc --noEmit` 0, `check:nul` 0. `regressed-from:` none — this boundary was simply never in BUG-083's scope.
- **Still owed:** INDEPENDENT clean-room verification (Verification-class requires it before VERIFIED). Flagged to the orchestrator. A second concern worth an independent eye: the fix keeps the open session's socket + `state.snap` live while viewing another project — correct for switch-back, but a reviewer should confirm no OTHER surface reads `state.snap`/the open session and paints it under the foreign selection (I audited the strip, the hairline and the FEAT-067 live chip; a fresh pass should re-sweep for a fourth).
- **Deeper-flaw note (carried forward):** this is the SECOND boundary of the `state.current` conflation (BUG-083 was the first). `openProjectId` now gives the dock an explicit owner, but the two concepts still share one `state.current` object. If a THIRD boundary appears, promote to an ARCH ticket (a single owner for "what is on screen") rather than a third point-fix.

### 2026-08-18 — independent clean-room verification (openai/codex, adversarial) — BROKEN
- **Verified-by:** dispatch openai run 01a01620-b941-7662-b99b-84edb0f50475 (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN
- Input was the requirement in plain terms, the diff (docs/bugs + docs/prompts reverted to base so no ticket/methodology prose reached the verifier), the run commands and the two committed test suites. Both author suites re-ran clean in the clean room (16/16 + 20/20).
- **FINDING (property A — cross-project bleed):** while project B is selected, project A's live model/provider crown chip is still rendered with `data-live=true` and A's effective model name — a surface the `dockIsForeign()` gating missed. Adversarial run `661cc16666ca`, exit 1, `node scripts/adversarial-crossproject-modelchip.mjs` (the committed 16 checks plus one new crown-chip check: 16/17, the new one FAILs).
- **FINDING (property B — hover timestamp):** `:focus-within` reveal is declared but neither the message bubble nor the `<time>` element is keyboard-focusable (no focus target), so keyboard/AT users cannot reveal or reach the timestamp. Adversarial run `260a786aa860`, exit 1, `node scripts/adversarial-timestamp-keyboard.mjs` → `{"focusRule":true,"timeFocusable":false,"bubbleFocusable":false,"stampCreatesTime":true}`.
- **Could not test (verifier's own words):** cross-project probing was done against the real server + real `app.js` under happy-dom, not a real browser; the keyboard defect probe was source-level, not a real Tab-key / accessibility-tree traversal (the supplied timestamp suite's hover, geometry, theme and width evidence DID come from a real Brave browser over CDP); rapid switching, mid-switch socket events, two simultaneously live projects, deletion of the selected project, and server-side request counting were not exercised.

### 2026-08-18 — clean-room remediation lane (worker, Opus 4.8) — both defects fixed, structurally

- **Reproduced both must-FAILs first (on unmodified source).** Defect A: a happy-dom repro over the real server (the BUG-083 idiom) primed A's full live report and switched to B — reproduced the verifier's exact line `hidden=false live=true text="◇ opus-A-only" title="…Model: claude-opus-A-only (effective config)…"`. Defect B: `verify-msg-timestamp-hover.mjs` with new real-browser AX checks, run against stashed source, FAILed 2/24 — the `<time>`'s computed accessible name was empty/terse (a11y name `""`), the `:focus-within` reveal dead.
- **Defect A — structural gating, not a sixth point-fix.** Root cause was the same `state.current` conflation, but the fix at each surface had been a growing list of `dockIsForeign()` call sites (strip, hairline, live-count, poll) — and the crown MODEL chip, the integrations strip, the permission SEAL chip, the launch provider control, `effectiveModel`/`resolveInheritedModelLabel` (the model NAME even when `data-live` was false), and the sidebar run-dot ALL still read the open session's live state directly. Introduced ONE gate the paint surfaces route through: `dockSnap()/dockLive()/dockEffective()/dockLiveTools()/dockLiveModel()` (each returns the live field, or ABSENT when `dockIsForeign()`), so a foreign dock falls back to the SELECTED project's predicted/planned view **by construction**. Semantically correct: when the dock is foreign there is no live session for the view, so every surface should show the selected project's own state. **Surfaces found and closed:** crown model chip (the reported defect), integrations MCP chips, permission tray + seal + composer hairline, launch provider control (`paintProvBtn`/`pickProvider`), `effectiveModel`/`resolveInheritedModelLabel` model-name resolution, and the sidebar run-dot (re-keyed from the sidebar SELECTION to the live session's OWNER, `state.openProjectId`). **Unrepresentable vs merely guarded:** any surface that reads live state THROUGH an accessor is covered by construction; a surface that reads `state.snap/live/effective/liveTools/liveWireModel` directly is NOT prevented at the type level (a full "by construction" would need those fields inaccessible except via accessors — an unsafe refactor of a 10k-line single-file surface with many non-paint readers), so `verify-bug-106-crossproject-strip.mjs` now ENUMERATES every live-reading surface under a rich foreign live-state and asserts each is blank — a newly added leak FAILs loudly rather than shipping silent.
- **Defect B — accessible name, no focus needed.** The `:focus-within` reveal could never fire (nothing focusable) and making every bubble/stamp tabbable would add one Tab stop PER message (a keyboard regression: hundreds of stops before the composer). Chosen fix: the `<time>` carries an `aria-label` with the FULL absolute datetime (weekday + full date + year + clock), announced in the normal reading order with NO focus and NO hover; the terse visible gutter text and pointer-hover reveal stay for sighted mouse users; `<time datetime>` stays machine-readable; the dead `:focus-within` CSS was removed. Justification: a screen-reader user reads the transcript linearly and now hears the unambiguous moment in place (strictly better than a reveal they must discover); a keyboard-only user is not forced through per-message stops; a roving-tabindex widget is disproportionate for a supplementary stamp when the accessible name already delivers the information to every AT user without interaction.
- **Verified (real browser + real DOM):** `verify-msg-timestamp-hover.mjs` 24/24 — the computed a11y name (via CDP `Accessibility.getPartialAXTree`) is `"sent Monday, August 17, 2026 at …"`, a real 40-Tab traversal never lands on a stamp or bubble, hover reveal + no-layout-shift + light/dark/narrow visual gate (shot-luma) all pass; must-FAIL on stashed source 22/24. `verify-bug-106-crossproject-strip.mjs` 33/33 — the original four directions PLUS the full surface enumeration (crown chip / integrations / seal / provider / dot / the single-gate blanks every accessor) PLUS the verifier's "could not test" work queue: **poll genuinely STOPS** (WIRE request-counted — five foreign poll cycles emit ZERO `/running` requests to the server, and a cycle after switch-back DOES reach it — stopped, not broken), a push event mid-switch does not repaint yet keeps the snapshot warm, rapid A→B→A→B stays coherent, unregistering the selected project mid-view does not crash or leak, and the dock re-scopes when the open-session owner changes. **Must-FAIL for the committed suite** proven by neutralising `dockIsForeign()` to `return false`: 15 leak/WQ checks (incl. defect A) flip to FAIL, restored on revert. Provenance caveat from the verdict is now addressed: both proofs are REAL brave over CDP (a11y) / real server + real app.js (cross-project); the a11y defect is proven by a real Tab + real AX tree, not source inspection.
- **Also fixed (verification-tooling blocker):** `scripts/independent-verify.mjs` died with `ERR_INVALID_ARG_VALUE` when the base commit's diff carried a raw NUL byte (the prompt travels by argv; a NUL is illegal in an argv string). This happened because `public/app.js` is large and the historical draftKey NUL sat DEEP in it, past git's ~8 KB binary-detection window, so plain `git diff` classified the file as text and carried the NUL straight into the prompt. Fixed at the single spawn choke point with `argvSafePrompt()` — renders any NUL as a visible sentinel (U+2400) so the payload is transmissible by either the argv or the stdin path and the verifier still SEES that a NUL was present; the module is now import-guarded so the transform is unit-testable. Proven in `verify-independent-verification.mjs` (new section E) on a REAL `git diff` over a synthetic base whose large file carries a deep NUL (this repo's own history was scrubbed of NULs in the public relocation): the raw payload throws `ERR_INVALID_ARG_VALUE`, the sanitised payload spawns cleanly. Folded into the existing independent-verification ticket's suite rather than a new ticket (it is a fix to that tool).
- **Changed:** `public/app.js` (dock accessors + routing the enumerated surfaces through them + owner-keyed sidebar dot + accessible-name timestamp + test exports), `public/styles.css` (removed dead `:focus-within` reveal), `scripts/verify-bug-106-crossproject-strip.mjs` (surface enumeration + work queue), `scripts/verify-msg-timestamp-hover.mjs` (real AX + Tab checks), `scripts/independent-verify.mjs` (`argvSafePrompt` + import guard), `scripts/verify-independent-verification.mjs` (NUL section E). Anti-regress: BUG-083 10/10, feat-083 digest 22/22, orchard-transcripts 15/0, `npm run gate` PASS (leak-gate + check:nul + typecheck, exit 0). `regressed-from:` none — this remediation extends the same fix; no prior ticket introduced the missed surfaces (they were simply never enumerated).
- **Still owed:** an INDEPENDENT clean-room re-verify over the remediation (Verification-class + high-stakes: observability + a11y). The enumeration test is the guard against a seventh surface, but generation must not be its own only verifier.

### 2026-08-18 — independent clean-room RE-verification over the remediation (openai/codex, adversarial) — BROKEN

- **Verified-by:** dispatch openai run 01a0164a-53e6-7942-b054-6943a596576a (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN
- **Range verified:** synthetic `3cedfb9^..refs/verify/bug-106-remediation` (= `51318cf..bcd39d5`). The remediation's six code files were swept into `3cedfb9` alongside an unrelated BUG-108 lane (`git commit -a`), so the range was rebuilt: `3cedfb9^` tree with `public/app.js`, `public/styles.css`, `scripts/independent-verify.mjs`, `scripts/verify-bug-106-crossproject-strip.mjs`, `scripts/verify-msg-timestamp-hover.mjs`, `scripts/verify-independent-verification.mjs` taken from `3cedfb9`. `docs/*` excluded entirely; history not rewritten.
- **FINDING (property A — cross-project bleed, a SEVENTH surface):** `paintComposerFor` computes an agent thread's running display from `th.status === 'running' && state.live` rather than `dockLive()`, so project A's agent "is working" live status stays displayed while project B is selected. Adversarial run `3f671678c1fc`, exit 1, `node scripts/adv-agent-thread-live-bleed.mjs` → `{"surface":"agentDoneText live working/finished status","readsStateLiveDirectly":true,"usesForeignDockGate":false}`.
- **Property B:** no defect found — the author suite re-ran 24/24 in the clean room (run `e8b1c4905bba`, exit 0), including the real-browser AX name (`"sent Monday, August 17, 2026 at 12:15 PM"`), the 40-Tab traversal landing on no stamp/bubble, hover reveal with zero layout shift, and the light/dark/narrow shot-luma gate.
- **Provenance:** timestamp evidence — REAL brave over CDP incl. the real accessibility tree. The agent-thread leak — an executable source-surface adversary, not a dynamic project-switch reproduction.
- **Could not test (verifier's own words):** no screen-reader-product audio output; the agent-thread leak was not reproduced dynamically in happy-dom or a real browser.
- **Two earlier dispatches this round were ruled INVALID on contract shape, but each independently found a DIFFERENT direct-read surface and should be treated as leads:** (i) `runningAgentCount()` reads `state.snap` directly, so an A status event arriving while B is selected paints "1 agent running" in B's footer; (ii) `paintAuto()` reads `state.live` directly, so `.auto-wrap` (the autonomous-session crown control) stays visible after selecting empty project B.
- **Read:** three independent adversaries found three distinct surfaces that read `state.snap`/`state.live` directly rather than through the accessors. The enumeration test does not close the class; this is the promotion trigger the Deeper-flaw note already named.

### 2026-08-18 — promotion to an ARCH decision (worker) — **ARCH-005**

- The class is promoted out of this ticket to **ARCH-005** (`docs/bugs/ARCH-005-live-session-state-is-globally-readable-so-any-surface-can-paint-a-foreign-project.md`): live session state lives in module-level fields any paint function can read directly, so a leak is the default and correctness depends on each reader remembering a gate. Eleven leaking surfaces across three adversarial rounds, ~3 new per round, no round finding zero — the accessors plus the enumeration test guard the surfaces someone listed and cannot prevent the next one.
- ARCH-005 carries the testable invariant, the options (encapsulate the fields / scope the view state by construction / a lint-ratchet on direct reads / keep patching, priced), a step-wise migration around the single-file constraint, and the proof bar. It is OPEN pending a HUMAN decision; **no build starts until an option is chosen.**
- **The three surfaces from the verdict above remain UNFIXED pending that decision** — `paintComposerFor` (`th.status === 'running' && state.live`), `runningAgentCount()` (`state.snap`), `paintAuto()` (`state.live`). Fixing them now would be the fourth round of exactly the patching ARCH-005 exists to decide about; if the decision is "keep patching", they become three ordinary point-fixes and should be filed as such.
- **Changed:** ticket prose only — no product code, no scripts.
