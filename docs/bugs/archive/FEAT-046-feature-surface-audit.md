# FEAT-046 — Feature-surface audit: is every shipped feature where the user would look for it?

- **Status:** DONE — audit complete (graded table + top offenders appended); fixes tracked as FEAT-047 (rail findings), FEAT-048 (survival hover), FEAT-038 follow-up (onboard routes)
- **Area:** whole UI surface (app.js / drawer.js / index.html) vs. shipped feature set
- **Reported:** 2026-08-06 by user (via orchestrator)
- **Related:** FEAT-045 (the instance that triggered this: provider switch lived only in the settings drawer while the point of need is the launch surface)

## Goal
The user found the provider switch (FEAT-037) hiding in the project-settings
drawer when the natural point of need is the new-session surface (FEAT-045 is
fixing that one). Their ask: *"map every feature and how it's added to UI and
whether that's the right location — there might be other things similar to
provider switch."*

Deliverable: an inventory of every SHIPPED user-facing feature (INDEX Done list
+ pre-tracker "Shipped earlier" + CLI-only capabilities), where each surfaces
today at git HEAD, where the user's point of need actually is, and a grade:

- **right-place** — surfaced where you'd look when you need it
- **buried** — exists, but not where you'd look at the moment of need
- **invisible** — works, but has no UI surface at all (a dashboard user would never find it)
- **partial** — surfaced for some states/paths, not others

Plus: top offenders with small concrete relocation proposals (prefer
moving/duplicating an affordance over building new surfaces), and an explicit
"leave it CLI-only" list (not everything belongs in the UI).

## Method
- Inventory from `docs/bugs/INDEX.md` Done + Shipped-earlier; tickets read where
  the surface was unclear.
- UI read at **git HEAD** (`git show HEAD:public/app.js` etc.) so the
  concurrently-edited working tree (FEAT-045 in flight) doesn't skew grading.
- Graded from the USER's seat: "when would I want this, and would I find it there?"

## Constraints
- Read-only: no UI code, package.json, or INDEX.md changes.
- INDEX row for this ticket to be added by the orchestrator.

## Activity log (APPEND-ONLY)
### 2026-08-06 — auditor (subagent)
- Ticket opened; audit in progress. Findings appended below when complete.

### 2026-08-06 — orchestrator — AGGREGATED FINDINGS (from three surface mappers: drawer.js, app.js, CLI)

#### Graded table (condensed; feature → today's surface → point of need → grade)

| Feature | Surface today | Point of need | Grade |
|---|---|---|---|
| Provider switch (FEAT-037) | drawer → Provider group (2 clicks deep) | new-session/launch surface | **buried** → FEAT-045 fixing |
| New-session options as a whole | NONE at creation — model/effort/perm/provider all chosen post-hoc on composer/crown | session creation moment | **partial** (works, but nothing offered when starting) |
| WA auto-consolidation results (FEAT-019) | server console only (boot pass); needs-human findings invisible | dashboard — Needs-You rail (they ARE needs-human items) | **invisible** — top offender |
| Survival/health ground truth (FEAT-040/BUG-027) | CLI `doctor` + /api/health; UI shows states but never survival-scoped/broker | session status affordance (hover/detail) | **invisible in UI** |
| Session actions (rename/pin/fork/delete) | right-click row menu only | row | buried-but-conventional (ok) |
| Onboard to Orchard (FEAT-038) | right-click project → single item | project row / add-project flow | **buried** (one hidden route) |
| Detach/close semantics | implicit only; prose in banners | Stop button / crown | **partial** (honest copy exists; no explicit control) |
| Autonomous mode (FEAT-022) | crown, only when live | crown | right-place |
| Model chip + change flag (FEAT-042) | crown, always | crown | right-place |
| Provider error cards / retry (BUG-031) | transcript + ticker | transcript | right-place |
| Needs-You rail (FEAT-018/025/029) | right rail, poll | rail | right-place |
| Queue controls (FEAT-031) | composer queue box | composer | right-place |
| Dispatch runs (FEAT-043) | no launcher; runs visible in history | orchestrator sessions (agent-invoked) | right-place as agent CLI; history visibility suffices |
| Tool toggles (FEAT-025), snapshots, mounts, git panel, memories | drawer sections | settings | right-place |
| Slash palette, finder, diff chips, decision cards | in situ | in situ | right-place |
| board:check/gen, sync-methodology, check-scope, station-open, doctor(CLI), wa:capture | terminal | maintainer/agent workflows | **leave CLI-only** (by design; doctor's DATA belongs in UI, tool itself stays CLI) |

#### Top offenders (concrete, small proposals)
1. **FEAT-019 consolidation findings → Needs-You rail.** Boot/post-capture passes emit needs-human items to console only. Proposal: write needs-human findings to a small JSON the board/rail reader includes (they are literally "needs you" items); zero new surface — reuse the rail.
2. **Survival truth → session status hover.** The state dot never says "protected (survives restart)" vs not, though /api/health knows. Proposal: tooltip/hover detail on #sessStatus fed by /api/health (adopted/scoped/broker), plus a quiet ⚠ when survival configured-but-not-scoped.
3. **New-session moment offers nothing.** FEAT-045 adds provider; consider the same row exposing model (already adjacent via #modelBtn) — mostly solved by FEAT-045 + existing popover proximity; monitor rather than build more.
4. **Onboard single hidden route.** Add the same action to the add-project flow's completion step + the empty-project explainer ("this project has no board — onboard it"). Reuses the existing API.
5. **Explicit detach affordance** — low priority; the honest banners cover it; skip unless it recurs.

#### Leave-CLI-only (deliberate)
`board:check/gen` (agent/orchestrator tooling), `sync-methodology`, `check:scope` (advisory gate), `station-open`/deploy (launches the UI), `wa:capture` (agent-invoked), `dispatch` as a launcher (agent-invoked; its RESULTS already render in history). `doctor` stays CLI but its data gains the UI hover (offender #2).
