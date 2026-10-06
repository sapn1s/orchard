```orchard-ticket
{
  "id": "BUG-222",
  "type": "bug",
  "title": "A rebuild during a launch leaves the old image running",
  "summary": "When a rebuild is requested while a launch is already provisioning the same project's container, the rebuild joins that launch instead of forcing its own recreate. The freshly built image is not applied to the running container. It takes effect only at the next launch. Nothing is destroyed.",
  "impact_if_we_wait": "The rebuilt image simply waits for the next launch, so a user who rebuilds during a launch sees no effect until they launch again. No work, container or data is lost.",
  "current_need": "Make a rebuild that joins an in-progress launch still force its own recreate once that launch settles, or re-issue the recreate afterwards. Low priority.",
  "severity": "low",
  "area": "Container image lifecycle",
  "reported": "2026-09-30",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-09-30",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "a rebuild that joins an in-progress launch still applies the newly built image to the running container",
    "a test issues a rebuild during a concurrent launch of the same project and asserts the running container ends on the rebuilt image"
  ],
  "code_refs": [
    {
      "path": "src/server/container-manager.ts"
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
      "id": "FEAT-157",
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

# BUG-222 — A rebuild during a launch leaves the old image running

## Evidence
BUG-214 verifying (2026-09-30) residual, marked SAFE-FAIL: "a Rebuild that joins a launch's in-flight ensure loses forceRecreate." A Rebuild issued while a launch is mid-`ensureContainer` for the same project joins that in-flight ensure, which was not asked to recreate, so the `forceRecreate` intent is dropped and the newly built image is not applied to the running container.

## Violated invariant
A Rebuild must apply the new image. Joining a concurrent launch's ensure is correct for avoiding a double build, but it must not silently discard the recreate the Rebuild asked for.

## Fix design
When a Rebuild joins an in-flight ensure, carry its `forceRecreate` (and `deferImageSwap` / `refuseDestroyIfLive`) into that ensure, or re-issue the recreate once the joined launch settles and no session is live. Low severity: nothing is destroyed, the image just waits for the next launch.

## Build queue
Build queued behind FEAT-157 (same files: container-manager.ts / index.ts).

## Symptom of a deeper design flaw?
No — a missed intent on a join, not a structural gap. Same lifecycle-lock area as BUG-214.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-30 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-09-30 — worker
- **Note:** Folded into ARCH-022 (container lifecycle has no single owner): this is the same live-container class as BUG-214's 8 clean-room breaks. Build it as a step of ARCH-022's migration path, through the single lifecycle authority, not as a standalone guard.
