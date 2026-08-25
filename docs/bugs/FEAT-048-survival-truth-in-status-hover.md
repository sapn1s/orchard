```orchard-ticket
{
  "id": "FEAT-048",
  "type": "feature",
  "title": "Dashboard never showed whether a session survives a restart",
  "summary": "The status indicator now says whether a session is protected and will survive a server restart, and shows a quiet warning when survival is configured but not actually in force. Broker state appears for surviving sessions. Previously the dashboard showed none of this, so people had to run the command-line checker to find out.",
  "impact_if_we_wait": "People would keep assuming a session survives a restart when it does not, and only find out by losing one. Bounded: this is display of state the server already tracks, not a change to whether sessions actually survive.",
  "current_need": "Nothing is outstanding. The detail shipped with a matched four-of-four pass tally and clean standing checks.",
  "severity": "medium",
  "area": "Session status indicator",
  "reported": "2026-08-06",
  "reported_by": "agent",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-06",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A properly scoped session shows as protected and surviving a server restart",
    "A session with survival configured but not in force shows a quiet warning",
    "A surviving session shows its broker state",
    "The check fails before the change and passes after it"
  ],
  "code_refs": [
    {
      "path": "/api/health",
      "symbol": null,
      "note": "already knows protected/scoped status and broker state; the source for the detail"
    },
    {
      "path": "#sessStatus",
      "symbol": null,
      "note": "the status affordance that gained the hover and click detail"
    }
  ],
  "related": [
    {
      "id": "BUG-024",
      "relation": "see_also"
    },
    {
      "id": "BUG-027",
      "relation": "depends_on"
    },
    {
      "id": "BUG-036",
      "relation": "see_also"
    },
    {
      "id": "FEAT-040",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-046",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-046",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": true,
    "Migration and rollback": false,
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-048-survival-truth-in-status-hover.md",
    "sha256": "e306f86a5100d925048d3db72c46b86842527d2359f92ce15772592f93af2b74",
    "bytes": 7319,
    "original_title": "survival ground truth on the session-status affordance (hover/detail)",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head: the three display states, the health-endpoint source, the broker state, the doctor boundary and the must-fail-first bar are all present.",
    "dropped": [
      "the FEAT-046 ranking phrase 'top offender #2', kept as a see_also relation instead"
    ]
  }
}
```

# FEAT-048 — Dashboard never showed whether a session survives a restart

## Diagnosis

The health endpoint already distinguished a session that is survival-scoped and cgroup-verified from one that is merely configured for survival, and it already carried broker state. None of that reached `#sessStatus`, so the only way to see it was the `doctor` CLI tool. FEAT-046 listed this as its second-largest gap.

## Evidence

A four-of-four pass tally is recorded without an adjacent suite name, and typecheck was reported clean. `verify:ui` and `verify:health-survivor` are named in the plan but no result for either is recorded on the ticket.

## Implementation notes

The detail is fed from `/api/health` rather than from a second source. `doctor` remains the CLI tool; this ticket surfaces the same data at the point of need. Three display states: protected and surviving a restart; a survivor reported honestly when health shows `adopted:false`; and a quiet ⚠ for configured-but-unscoped, which makes the BUG-024 class visible to the user.

## Verification plan

On a scratch server: a scoped session hovers to show protected; a survivor with `adopted:false` is shown honestly; a configured-but-unscoped session shows the ⚠. The check must fail before the change. Playwright, `verify:ui` offline, typecheck, and the FEAT-040 spec anti-regression.

## Activity log (APPEND-ONLY)
### 2026-08-06 — orchestrator
- Filed from FEAT-046 audit (offender #2). Queued behind FEAT-045.

### 2026-08-06 — build + verify — VERIFIED

**Built** (client only; server untouched — `/api/health` already carries every
field needed: `stationSessionId`, `sdkSessionId`, `adopted`, `survivalConfigured`,
`survivalScoped`, `broker.state`, per FEAT-040/BUG-027):
- `public/lib/api.js`: added `export const health = () => optional('/api/health')`
  — the one export this file was missing, following the existing `optional()`
  convention (null on a missing/unreachable route, never thrown).
- `public/app.js`:
  - `state.sessSurvival = { key, entry, at }` (~line 121) — a short-lived cache
    of the last fetched `/api/health` entry for the CURRENT session, keyed by
    `state.stationSessionId || state.sdkSessionId` (the fallback matters: a
    `surviving-unadopted` broker entry carries no `stationSessionId`, only
    `sdkSessionId ?? resumeHint` — see the health route's join).
  - `sessSurvivalKey()`, `survivalHintLine(entry)` (~line 4477-4503) — renders
    the ground-truth line straight from a health entry, in the SAME vocabulary
    `scripts/station-doctor.mjs` already uses (`Protected — survives a server
    restart.` / `⚠ survival configured but NOT scoped — …` / `Not protected —
    survival is not configured for this session.` / for `adopted:false`,
    `Survived a restart — broker alive (<state>), not yet adopted by this
    server; resume to continue the thread.`).
  - `paintSessStatus()` (~4515) now appends the cached survival line (if its
    key matches the CURRENT session) to `#sessStatus`'s `title` attribute —
    the SAME lighter convention every other crown affordance already uses
    (git/proc/model/provider chips all set `.title`, not a custom popover).
    No layout shift: nothing new in the DOM, no new CSS.
  - `refreshSessSurvival()` (~4529) — the fetch, gated to fire ONLY on
    `mouseenter`/`focus` of `#sessStatus` (~4548), with a 15s in-memory cache
    so hover jitter doesn't refetch. **No hot poll was added** — survival
    state changes at most once per process spawn/restart, so a timer would
    burn a request cycle for information that is almost always unchanged;
    hover is the actual moment the data is wanted. `paintSessStatus()` itself
    still runs at its existing (event-driven, not timed) frequency — this
    ticket added zero new call sites to it, only a read of an already-cached
    value.
  - `computeSessState`/`paintSessStatus`/`refreshSessSurvival`/
    `survivalHintLine` exposed on `window.__station` for deterministic verify
    scripts (no re-deriving the priority/vocabulary rules from outside).

**Verified** (scratch servers only, OS-assigned free ports, never `:4317`,
killed by pid):
- NEW `scripts/qa/feat-048-survival-hover.spec.ts` — 4 journeys, real Brave via
  Playwright:
  1. **Protected** — a REAL driven direct-isolation session (survival on by
     default) hovered after its turn ends → title contains `Protected —
     survives a server restart.` (this dev box runs its OWN session inside a
     `claude-station-host-*.scope` already, confirmed via
     `cat /proc/self/cgroup`, so nested `systemd-run --scope` works here the
     same way it did for FEAT-040/BUG-027's specs — no deploy-service wrapping
     needed for a plain scoped verdict). Also asserts the title carries NO
     survival wording before the first hover (proves the fetch is genuinely
     lazy).
  2. **Unconfigured** — a REAL session on a scratch server started with
     `CLAUDE_STATION_SURVIVE=0` (survival.ts's own kill-switch) → `Not
     protected — survival is not configured for this session.`
  3. **Configured but NOT scoped** (BUG-024 class) — reproducing the actual
     scope-escape failure needs BUG-024/BUG-027's own deployed-`systemctl
     --user`-service harness (out of scope here: this ticket is about the
     CLIENT'S rendering of a verdict, not re-proving the server can detect
     one). Uses a Playwright `page.route` fixture that intercepts the real
     `/api/health` response for the real open session and flips
     `survivalScoped` to `false` — everything else in the payload real. →
     `⚠ survival configured but NOT scoped — not actually protected against a
     restart right now.`
  4. **Surviving-unadopted** (BUG-027 class) — same fixture rationale (needs
     BUG-027's restart harness to reproduce for real) → `Survived a restart —
     broker alive (draining), not yet adopted by this server; resume to
     continue the thread.`
  - **Non-vacuous, verified directly**: stashed `public/app.js` +
    `public/lib/api.js` and reran — all 4 FAILED (`refreshSessSurvival is not
    a function` / title stayed the bare per-state hint, e.g. `"Nothing is
    running."`) — restored the change, reran — 4/4 PASS.
- `npm run typecheck` — PASS (clean).
- `npm run verify:ui -- --offline` — PASS (3 passed, 0 failed).
- `npx playwright test scripts/qa/feat-040-session-status.spec.ts` (the
  ticket's own anti-regression ask, since this touches the same crown/
  `paintSessStatus` machinery) — PASS. One run timed out waiting for the
  post-"continue" turn to reach idle within the spec's 20s budget; reproduced
  the SAME timeout on the pre-change baseline (stashed app.js/api.js) twice in
  a row, then a clean PASS on both baseline and changed code afterward —
  confirmed environmental (real Anthropic API latency close to the spec's
  timeout), not a regression from this change.
- Screenshots: `docs/bugs/assets/FEAT-048-protected.png`,
  `docs/bugs/assets/FEAT-048-unconfigured.png`,
  `docs/bugs/assets/FEAT-048-not-scoped.png`,
  `docs/bugs/assets/FEAT-048-survivor.png`.

**Scope**: `public/app.js` + `public/lib/api.js` only. Server (`src/server/
index.ts`) NOT touched — `/api/health`'s existing `sessions[]` shape
(FEAT-040 + BUG-027) already carries every field this ticket needed;
`verify:health-survivor` was never run against this change since nothing it
covers changed, and there is no server diff to regress it.
`package.json` not edited — the new spec runs via the existing `playwright
test` glob (`testMatch: '**/*.spec.ts'` in `playwright.config.ts`) and
`npm run qa:sweep` picks it up with no new entry required.
