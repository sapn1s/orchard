```orchard-ticket
{
  "id": "BUG-221",
  "type": "bug",
  "title": "A stop or refused delete tears down a queued launch's services",
  "summary": "When a session is stopped, or a project delete is refused because sessions are still live, the operation still tears down that project's service sidecars and their volumes. A launch that queued behind the operation then loses the databases and other services it was about to use, along with whatever those volumes held.",
  "impact_if_we_wait": "A launch that starts while a stop or a refused delete is running loses its service containers and the contents of their volumes. Bounded to projects that run service sidecars, and to the window where a launch overlaps a stop or a delete.",
  "current_need": "Scope service teardown under the per-project lifecycle lock, so a stop or a refused delete never removes sidecars or volumes a launch queued behind it has already claimed.",
  "severity": "high",
  "area": "Container service lifecycle",
  "reported": "2026-09-30",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-09-30",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "a stop or a 409 project delete never removes service sidecars or volumes a launch queued behind it has claimed",
    "service teardown is scoped to the operation that created the sidecars, verified by owner or label rather than by class",
    "a test overlaps a launch with a stop and a refused delete and proves the launch keeps its services and their volume contents"
  ],
  "code_refs": [
    {
      "path": "src/server/service-manager.ts"
    },
    {
      "path": "src/server/index.ts"
    }
  ],
  "related": [
    {
      "id": "ARCH-022",
      "relation": "superseded_by"
    },
    {
      "id": "BUG-214",
      "relation": "see_also"
    },
    {
      "id": "FEAT-112",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": false,
    "Evidence": true,
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

# BUG-221 — A stop or refused delete tears down a queued launch's services

## Evidence
BUG-214 verifying (2026-09-30) residual: "a Stop's / 409-DELETE's service teardown can remove sidecars/volumes of a launch that queued behind it." A Stop, or a project DELETE that returns 409 `live-sessions` because other sessions are live, runs its service teardown without checking whether a newer launch — queued behind it on the same project — has already taken those sidecars and volumes.

## Violated invariant
Never destroy resources a live or pending launch depends on. Service teardown must be scoped to the operation that owns those sidecars; a launch that overlaps a stop or delete is a distinct owner and its infra must not be swept.

## Fix design
Run service teardown inside the per-project lifecycle lock BUG-214/FEAT-157 introduces, and re-check immediately before removal: if a launch has registered on this project after the stop/delete began, do not remove its service sidecars or volumes. Prefer owner/label-scoped removal (the BUG-216 owner-key rule) over class removal, so teardown reaps only the infra of the operation that created it.

## Build queue
Build queued behind FEAT-157 (same files: container-manager.ts / index.ts; also service-manager.ts).

## Symptom of a deeper design flaw?
Same lifecycle-lock family as BUG-214 (a single per-project lock over admission plus destructive ops). Tracked there; no new ARCH filed.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-30 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-09-30 — worker
- **Note:** Folded into ARCH-022 (container lifecycle has no single owner): this is the same live-container class as BUG-214's 8 clean-room breaks. Build it as a step of ARCH-022's migration path, through the single lifecycle authority, not as a standalone guard.
