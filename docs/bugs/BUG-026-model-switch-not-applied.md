```orchard-ticket
{
  "id": "BUG-026",
  "type": "bug",
  "title": "Choosing a different model left the session on the old one",
  "summary": "Picking a different model from the model menu gave no acknowledgement, and re-opening the menu showed the original model still selected. The choice is now written to the session, applied to the running turn, and read back on reopen and after a page reload. The picker, override, new-session override and interface suites all pass, with typecheck clean.",
  "impact_if_we_wait": "People believe they switched model while the session keeps answering on the old one. Bounded: this affects which model serves a session and what the menu displays, not stored transcripts or project settings.",
  "current_need": "Nothing is outstanding. The picker, override, new-session override and interface suites all passed, with typecheck clean, and the change is live.",
  "severity": "high",
  "area": "Model picker",
  "reported": "2026-08-05",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-05",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Choosing a different model is acknowledged rather than silently closing the menu",
    "Re-opening the picker shows the newly chosen model",
    "The chosen model survives a page reload",
    "The session reports the newly chosen model as the one it is running"
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "symbol": null,
      "note": "model picker selection handler — whether the choice is sent at all"
    },
    {
      "path": "src/server/index.ts",
      "symbol": null,
      "note": "route that records a per-session model override"
    }
  ],
  "related": [
    {
      "id": "BUG-021",
      "relation": "see_also"
    },
    {
      "id": "BUG-084",
      "relation": "see_also"
    },
    {
      "id": "FEAT-042",
      "relation": "blocks"
    },
    {
      "id": "FEAT-045",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": false,
    "Verification plan": true,
    "Migration and rollback": false,
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-026-model-switch-not-applied.md",
    "sha256": "1b496586e470e6640da98d06d3236cc6c3864b545b6ed235ff2a97493c74ba89",
    "bytes": 6442,
    "original_title": "/model switch doesn't apply: menu closes, model unchanged on reopen",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head section by section: the symptom, the BUG-021 display-versus-write distinction, the four candidate failure points and the browser proof bar are all present.",
    "dropped": [
      "the ticket's file-by-file 'investigate, don't assume' phrasing, kept as code_refs notes"
    ]
  }
}
```

# BUG-026 — Choosing a different model left the session on the old one

## Diagnosis

BUG-021 fixed the display side of the model picker — the resolved model and the inherited tag. This ticket is the write path: a selection must persist as a per-session override, reach the running or next turn, and be read back when the picker reopens. The investigation had to separate four candidate failures: no request fired, a request that fired but was not persisted, a persisted value that was never applied to the session, or an applied value that the picker re-read stale.

## Evidence

Reported by the user: choosing another model gave no acknowledgement, the menu closed, and reopening showed the same model as before. After the fix, the model-picker suite passed 14/14, the overrides suite 5/5, the new-session-overrides suite 5/5 and the interface suite 3/3, with typecheck clean.

## Verification plan

In a real browser: open the model picker, choose a different model, confirm the choice is acknowledged, that it survives both a reopen of the picker and a page reload, and that the model the session reports as running actually changes. The check was required to fail on the pre-fix code, and to be carried by both a verify script and a browser spec.

## Activity log (APPEND-ONLY)
### 2026-08-05 — orchestrator
- Filed from a live user report. Queued behind FEAT-022 (holds app.js). Dispatch a fix+verify
  agent once app.js frees; root-cause which of the 4 stages above breaks before patching (§N).

### 2026-08-05 — fix agent (BUG-026)
**Root cause (§N — which of the 4 stages broke): (a) NO live request fired on select,
compounded by (d) the picker re-reads the live value on reopen.** This is the WRITE-path
sibling of the *permission-mode* live bug fixed earlier: the model picker only EVER had the
"arm for the next session" path. `paintModelPop`'s option click (public/app.js) wrote the
choice to CLIENT state only — `state.overrides.model` + `persistOverrides()` (localStorage) —
and its own `say()` even admitted "…applies to the NEXT session; the one running keeps X". No
`set-model` command was sent, the server had no handler and never called the SDK's live
`Query.setModel()`, so the running session never switched (stage c also unreachable). Then on
reopen `effectiveModel('model')` (app.js) correctly lets the LIVE value win over an armed
override, so the current row snapped back to the launch model — the user's exact symptom
("reopening I have same model"). Not persisted-but-unapplied, and not applied-but-stale-reread:
the write simply never left the browser for a live session.

**Fix (mirrors the setPermissionMode two-path design end to end):**
- Client — `public/app.js`:
  - picker click handler (app.js:5403): `if (field === 'model' && state.live) return setModelLive(o.v);`
    — a live model pick now goes through the server; effort + any pre-start change stay
    arm-for-next-session overrides (unchanged).
  - new `setModelLive()` / `finishModel()` (app.js ~1740) + `modelPending` guard: send
    `{type:'set-model', requestId, model}`, claim nothing until the server ACKs, 6s timeout,
    and on confirm mirror into `state.effective.effective.model` + `state.overrides.model` +
    `persistOverrides()` (so a reload RESUMES on the confirmed model). Ack handled at app.js:4392;
    a WS drop settles the pending change as failed (app.js:3741).
  - **deliberately no `paintCrown()` in `finishModel`** — `paintCrown` re-says the isolation
    line when idle and would instantly STOMP the "confirmed" message (this actually bit the
    first spec run: `#fine` flipped to "Direct · full access to this machine").
- Server:
  - `AgentSession.setModel()` + `#applyModel()` (src/server/agent-bridge.ts:772) — call the
    runtime, never optimistic (ok is the CLI's word), update `this.effective.model`, keep
    `overriddenFields` truthful, re-emit `effective-config`.
  - `ClaudeRuntime.setModel()` (src/server/runtime/claude-runtime.ts:147) → `Query.setModel()`
    (guards an old CLI without it with an honest error); `AgentRuntime` interface gains
    `setModel` (src/server/runtime/runtime.ts).
  - `set-model` WS command handler (src/server/index.ts:2121) — ack shape identical to
    `set-permission-mode`; new command type in `src/server/events.ts:298`.

**Verified (real browser, user-observable §C):**
- `npm run verify:model-switch` (new; `playwright test scripts/qa/BUG-026-model-switch.spec.ts`)
  — **PASS (25.8s)**. Real scratch server on a free OS-assigned port (never :4317, killed by
  pid), real driven haiku session. Asserts: (1) picking Sonnet on a running session shows
  "confirmed by the server … in force for this running session"; (2) the SESSION's effective
  model changes to sonnet; (3) it survives a picker reopen (Sonnet `aria-pressed=true`, haiku no
  longer current); (4) it survives a FULL page reload + reattach (session busy across the reload
  so it detaches & stays live — the reattach handshake still reports sonnet, picker still shows
  it). Screens: docs/bugs/assets/BUG-026-switched.png, BUG-026-after-reload.png.
- **Non-vacuity proven:** temporarily disabling only the client live-path branch → the spec
  **FAILS** at assertion (1) ("Expected /confirmed by the server/, Received 'Direct · full
  access to this machine'"), i.e. the pre-fix arm-only path. Fix restored.
- Anti-regression: `verify:model-picker` 14/14 (BUG-021 sibling, same picker), `verify:overrides`
  5/5, `verify:new-session-overrides` 5/5, `verify:ui --offline` 3/3, `npm run typecheck` clean
  (0), `node --check public/app.js` clean.

**package.json:** added `"verify:model-switch": "playwright test scripts/qa/BUG-026-model-switch.spec.ts"`.

**Open:** none for the stated scope. Note: EFFORT on a live session still only arms for the next
session (no clean live SDK setter for effort) — out of scope here, and its "applies to the NEXT
session" copy is honest. If a live effort setter lands, it should follow this same two-path shape.
