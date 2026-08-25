# BUG-094 — "← sessions" back link from the Guide (and Tickets) opens a NEW session instead of the one you were on

- **Status:** VERIFIED
- **Area:** public/index.html (#gvHome, #tvHome) + public/app.js (guide/tickets exit nav)
- **Reported:** 2026-08-14 by user

## Symptom
On a session → click the **Guide** pill (navigates to `#/guide/...`) → click **"← sessions"** to go
back → lands on a **new/blank session** instead of the session that was open.

## Root cause (traced)
The back link is `<a class="gv-home" id="gvHome" href="#/" ...>← sessions</a>` (index.html:485). Its
click handler calls `hideGuide()` (app.js:8905), but the `href="#/"` also drives the hash to bare `#/`,
which the SESSION router interprets as "no session selected → new session" rather than "restore the
prior view." The Guide navigates internally with `pushState` (navGuide, app.js ~8897 — "Back works as
expected"), so the BROWSER back button returns correctly; only this in-app link is wrong. `#tvHome`
(tickets dashboard, index.html:441) uses the same `href="#/"` — same bug.

## Wanted
"← sessions" should return to the view the user was on before entering the Guide/Tickets — the
previously-open session — NOT bare `#/` (new session). Options (worker picks the clean one):
- `history.back()` when the reader was entered from an in-app navigation (pops the pushed `#/guide`
  entry → prior session hash), or
- navigate to the open session's hash explicitly (`formatHash(state.current)`) instead of `#/`.
Guard the edge where the Guide was opened directly by URL (no prior session) — then `#/` / the default
sessions view is correct.

## Verification (§C)
- Real headless brave: open a session (note its id) → click Guide pill → click "← sessions" → assert the
  SAME session is active (not a new/blank one). Must-FAIL pre-fix: lands on a new session.
- Same for the Tickets dashboard "← sessions" (#tvHome).
- Direct-URL edge: load `#/guide` cold (no prior session) → "← sessions" → sessions view, no crash.
- Anti-regress: browser Back still works from the guide; verify:ui, typecheck, leak-gate.
- Risk bucket: client routing (low); reaches users on reload.

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
