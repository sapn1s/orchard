```orchard-ticket
{
  "id": "FEAT-046",
  "type": "feature",
  "title": "Shipped features were hard to find where people need them",
  "summary": "A provider switch shipped into the project-settings drawer, while people reach for it when starting a session. An audit checked every shipped user-facing capability against where someone would look for it, graded each one, and named the worst-placed ones with small relocation proposals. Three follow-up tickets carry the fixes.",
  "impact_if_we_wait": "Working features stay unfindable and get rebuilt or reported as missing. Bounded: this concerns where things appear, not whether they work, and every capability audited still functions and remains reachable today.",
  "current_need": "Nothing is outstanding. The audit produced a graded inventory plus a top-offenders list, and each finding it raised was handed to a follow-up ticket.",
  "severity": "medium",
  "area": "Feature discoverability",
  "reported": "2026-08-06",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-08-06",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Every shipped user-facing capability appears in the inventory with its current surface",
    "Each entry carries one grade: right-place, buried, invisible, or partial",
    "Worst-placed items have a concrete relocation proposal, preferring moving an existing control",
    "Capabilities that should stay command-line only are listed explicitly"
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "symbol": null,
      "note": "read at git HEAD so the in-flight working tree did not skew grading"
    },
    {
      "path": "public/drawer.js",
      "symbol": null,
      "note": "project-settings drawer, where the provider switch was found buried"
    },
    {
      "path": "public/index.html",
      "symbol": null,
      "note": "surface inventory read alongside the two scripts"
    },
    {
      "path": "docs/bugs/INDEX.md",
      "symbol": null,
      "note": "Done list plus the earlier-shipped section supplied the feature inventory"
    }
  ],
  "related": [
    {
      "id": "FEAT-038",
      "relation": "see_also"
    },
    {
      "id": "FEAT-045",
      "relation": "see_also"
    },
    {
      "id": "FEAT-047",
      "relation": "blocks"
    },
    {
      "id": "FEAT-047",
      "relation": "see_also"
    },
    {
      "id": "FEAT-048",
      "relation": "blocks"
    },
    {
      "id": "FEAT-048",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "docs-only",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": false,
    "Migration and rollback": false,
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-046-feature-surface-audit.md",
    "sha256": "c911c518ed3c185728da44cc8cf049b3f58780368ae0f23576a56ba5717df195",
    "bytes": 6166,
    "original_title": "Feature-surface audit: is every shipped feature where the user would look for it?",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "The trigger, the four grades, the HEAD-only reading method, the relocation and leave-alone deliverables, and the three follow-up tickets all appear above.",
    "dropped": [
      "the note that the board index row would be added by the orchestrator, a process detail the board itself records"
    ]
  }
}
```

# FEAT-046 — Shipped features were hard to find where people need them

## Diagnosis

The provider switch shipped in the project-settings drawer, but the moment of need is the new-session surface. The user asked whether other shipped features sit in the same position, so this ticket (FEAT-046) audited the whole surface rather than fixing the one instance.

## Evidence

The inventory was drawn from the board's Done list, the pre-tracker shipped-earlier list, and command-line-only capabilities, with individual tickets read wherever the surface was ambiguous. The user interface was read at git HEAD via `git show HEAD:public/app.js` and siblings, deliberately avoiding the working tree while a related fix was in flight. Grading was done from the user's seat: when would someone want this, and would they find it there?

## Implementation notes

Grades were fixed to four values — right-place, buried, invisible, partial — so entries could be compared. Relocation proposals preferred moving or duplicating an existing control over building a new surface, and an explicit leave-it-command-line-only list kept the audit from implying everything belongs in the interface. The audit itself was read-only: no interface code, package manifest, or board index edits.

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
