```orchard-ticket
{
  "id": "BUG-094",
  "type": "bug",
  "title": "Back links opened a blank session",
  "summary": "Guide and Tickets back links now return people to their previously open session. They previously opened a new blank session because leaving either view navigated to the default sessions route.",
  "impact_if_we_wait": "The fault interrupted navigation and could make people think their session was lost. Bounded: this affected routing and display continuity, not session data or other stored information.",
  "current_need": "Treat the ticket as closed: the pre-fix route failed, corrected interface checks passed, and standing checks stayed clean.",
  "severity": "low",
  "area": "Guide and Tickets navigation",
  "reported": "2026-08-14",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-14",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Leaving Guide returns to the previously open session",
    "Leaving Tickets returns to the previously open session",
    "Opening Guide directly returns safely to the sessions view",
    "Browser Back continues working from Guide"
  ],
  "code_refs": [
    {
      "path": "public/index.html",
      "symbol": "gvHome",
      "note": "Guide back link previously targeted the default sessions route"
    },
    {
      "path": "public/index.html",
      "symbol": "tvHome",
      "note": "Tickets back link shared the same faulty destination"
    },
    {
      "path": "public/app.js",
      "symbol": "hideGuide",
      "note": "The click handler hid Guide while the link destination also changed the route"
    },
    {
      "path": "public/app.js",
      "symbol": "navGuide",
      "note": "Guide entry uses pushState, allowing browser Back to restore the prior session"
    },
    {
      "path": "public/app.js",
      "symbol": "formatHash",
      "note": "The ticket considered explicitly navigating to the current session"
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
    "archived_path": "docs/bugs/archive/BUG-094-guide-back-link-opens-new-session.md",
    "sha256": "8c6cfdabcf7ed65607dd1dbbf5387e8c7f57bfc575ddd7b2a109d7f20b2a9079",
    "bytes": 6264,
    "original_title": "\"← sessions\" back link from the Guide (and Tickets) opens a NEW session instead of the one you were on",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared field by field with the archived ticket; its symptom, routing cause, direct-link edge, alternatives, risk, and executed evidence remain represented.",
    "dropped": []
  }
}
```

# BUG-094 — Back links opened a blank session

## Diagnosis

The Guide and Tickets home links targeted `#/`. Their handlers hid the reader, but the session router interpreted that bare route as having no selected session and created a blank one. Browser Back behaved correctly because Guide navigation added a history entry.

## Evidence

Before the correction, the isolated reproduction produced 3 passes and **7 failures**. Afterwards, `verify:ui` passed 7/7 and `verify:feat-075-guide-viewer` passed 26/26. Type checking and the leak gate were clean. `verify:bug-094-guide-back-session` and `verify:tickets` were named without execution results.

## Implementation notes

BUG-094 allowed either returning through browser history after in-app entry or navigating explicitly to the open session. Direct Guide URLs required a fallback to the default sessions view because no prior session exists.

## Verification plan

Open a known session, enter Guide, use its back link, and confirm the same session remains active. Repeat through Tickets. Load Guide directly and confirm safe return to sessions. Confirm browser Back still restores the prior view. The ticket described these browser checks as a clean-room pass, but no independent dispatch verdict accompanies it.

## Risks

The change affects client-side routing. A routing regression could appear after reload, but the exposure is limited to navigation and does not alter stored sessions.

## Activity log (APPEND-ONLY)
### 2026-08-14 — orchestrator
- Filed from user report. Traced to `href="#/"` on #gvHome/#tvHome driving the session router to a new
  session; the pushState-based internal nav means browser-Back already works, so the fix is to make the
  in-app back link restore the prior session rather than hard-navigate to `#/`.

### 2026-08-14 — worker (VERIFIED)
**Root cause (confirmed, corrected from the trace):** the static `href="#/"` in the HTML was never the
live value — `showGuide()`/`showTickets()` OVERWROTE #gvHome/#tvHome to `formatHash({ projectId:
state.current.projectId })`, i.e. a bare `#/project/<id>` that DROPS the session id. Clicking it drove
the hash to bare-project, which `applyRoute()` reads as `!route.sessionId → startNew()` — so the user
landed on a brand-new blank session (reproduced: `state.current.sessionId` went from `87564f3e…` to
`null`, URL `#/project/orchard`). Not a `#/` literal and not a "nothing re-applies" no-op; the
bare-project hash was actively applied to a new session.

**Fix (public/app.js — client only, no server/schema change):**
- `gv` + `tv` objects each gained a `returnHash` field (default `'#/'`).
- On ENTER (the `if (!gv.open)` / `if (!tv.open)` block, BEFORE the pane is hidden), capture
  `const back = currentRoute(); X.returnHash = back ? formatHash(back) : '#/';` — the FULL open-session
  route (id + dir + scroll index), so a reload lands right too.
- The href line now reads `X.home.setAttribute('href', X.returnHash)` instead of the projectId-only hash.
- `currentRoute()` is null only when no project is open at all → falls back to `'#/'`, no crash (cold
  `#/guide` edge). Capturing at enter (not click) means the scroll index is read while the pane is still
  visible; capturing the session route (not a `history.back()`) is robust to the user having browsed
  several guide pages first (a single `back()` would strand them on a prior guide page).
- Did NOT change the click handlers (they still just `hideGuide()`/`hideTickets()` and let the anchor
  navigate to the now-correct href) and did NOT touch the pushState internal nav, so browser-Back is
  untouched.

**Fix map:** public/app.js — `gv` object (+returnHash), `showGuide()` enter block + href;
`tv` object (+returnHash), `showTickets()` enter block + href. Plus
scripts/verify-bug-094-guide-back-session.mjs (new) and a package.json script entry.

**Verification (§C, real brave --headless=new over raw CDP, free port, PID-kill only, never :4317):**
scripts/verify-bug-094-guide-back-session.mjs — REALISTIC fixture = this repo's OWN real ~/.claude
session store (a real working sidebar), open a real session, drive the real click-path.
- MUST-FAIL pre-fix (unmodified app.js): 3 passed, **7 FAILED** — guide/tickets `← sessions` href was
  `#/project/orchard` (no session), after click `state.current.sessionId === null` (new/blank session),
  URL bare `#/project/orchard`; Back cascaded to the already-lost session.
- POST-fix: **10 passed, 0 failed** — guide + tickets `← sessions` both keep the SAME session active
  (`87564f3e…`) and a reload-safe `#/project/orchard/session/<sid>?dir=…` URL; browser Back still closes
  the reader onto the same session; cold `#/guide` → `← sessions` closes onto the sessions view with no
  thrown page error.
- Anti-regress: `verify:ui` 7/7, `verify:feat-075-guide-viewer` 26/26 (internal guide nav + Back
  intact), `typecheck` clean, `leak-gate` PASS (0 hits). `verify:tickets` 29/30 — the one failure
  ("board TOOL moved the row Done→Open") is PRE-EXISTING and orthogonal (server board tool, not nav):
  reproduced identically with my change stashed.

**Restart requirement:** client-only. A browser reload picks it up; no server restart, no :4317 touch,
no deploy.

**Risk bucket:** client routing (low), but it is session-lifecycle-adjacent (a wrong hash silently
forks a new session) — an independent clean-room re-verify pass is reasonable before this is treated as
closed, though the must-FAIL→PASS delta is unambiguous.
