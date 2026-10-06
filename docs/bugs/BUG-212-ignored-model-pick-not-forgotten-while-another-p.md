```orchard-ticket
{
  "id": "BUG-212",
  "type": "bug",
  "title": "Ignored model pick not forgotten while another project is selected",
  "summary": "The server declares that the open session's engine cannot run its armed model (effective-config.ignoredOverrides). The client skips forgetting that pick whenever the sidebar shows a different project (the dockIsForeign guard), so the ignored model stays saved for that session and rides its next start. It is a missed forget, not a write to the wrong session.",
  "impact_if_we_wait": "Low. The server ignores the pick every time and says so in a notice, so nothing runs on the wrong model. The pick lingers only until a start happens while the view is not foreign.",
  "current_need": "Gate the forget on the bag's declared owner (BUG-198), not on the sidebar view, then prove it with a routed-socket effective-config while the view is foreign.",
  "severity": "low",
  "area": "composer / per-session overrides — public/app.js",
  "reported": "2026-09-29",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-09-29",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Dock on A, sidebar on B: an effective-config naming A's model in ignoredOverrides removes it from memory and from A's stored entry.",
    "Must-FAIL on the current guard (dockIsForeign skips the forget).",
    "No other session's entry moves; the forget never writes under any key but the bag owner's."
  ],
  "code_refs": [],
  "related": [
    {
      "id": "BUG-198",
      "relation": "see_also"
    },
    {
      "id": "BUG-196",
      "relation": "see_also"
    },
    {
      "id": "BUG-106",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
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

# BUG-212 — Ignored model pick not forgotten while another project is selected

## Symptom
A session A is open in the dock and the sidebar shows a different project B (a "look at another
project" click; BUG-106's foreign dock). A turn starts for A — sent before the click, or sent from
B's view, since the composer acts on the dock's session. The server answers with
`effective-config.ignoredOverrides` naming A's armed model: the engine cannot run it. The client
shows "ignored: model (…)" but does NOT forget that pick. It stays armed in memory and in
`cs-overrides` under A's key, so it rides A's next start, and the server ignores it again.

## Repro
1. Open A with a model armed that A's engine cannot run.
2. Click project B's sidebar header. The dock still shows A.
3. Start a turn for A. The `effective-config` frame arrives with `ignoredOverrides:[{field:'model',…}]`.
4. `public/app.js` `case 'effective-config'`: the forget branch is gated `!dockIsForeign()`, so it is skipped.
   A's entry keeps the ignored model.

## Expected
The server has declared that A's engine cannot run the pick, so it is forgotten, from memory and
from A's stored entry, whichever project the sidebar shows. It heals itself today only at a later
start that happens while the view is not foreign.

## Context pack (grows — the "where to look", so no agent cold-starts)
- `public/app.js` `case 'effective-config'` (the BUG-196 round 6 forget) and `dockIsForeign()`.
- Why the guard exists, and why it is now over-conservative: before BUG-198 round 1,
  `selectProject` emptied the bag on a foreign view, so the bag might not be the dock session's.
  BUG-198 now declares the bag's owner (the dock's session, until a transition re-owns it and
  closes the socket), so `persistOverrides()` writes only under that owner. The view guard could
  become an owner check (a bag of kind `session` or `pending` is the socket's session's), but
  NOT a derivation from the view.
- NOT a mis-attribution. The BUG-198 round 2 lane checked this: `effective-config` carries no
  session id, it arrives only over the driving socket, and every owner transition closes that
  socket first. A closed WebSocket delivers no further frames, so the frame always concerns the
  bag's owner. This ticket covers a MISSED FORGET only, never a write to the wrong session.
- Related: BUG-198 (owner model), BUG-196 round 6 (the forget), BUG-106 (`dockIsForeign`).
- Repro test: none yet. Extend `scripts/verify-bug-198-overrides-survive-project-switch.mjs`: route the
  driving WebSocket and answer a held `start` with an `effective-config` carrying `ignoredOverrides`
  while the view is foreign.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-29 — agent
- **Filed:** through the board tool; the record was validated before it was written.
