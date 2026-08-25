```orchard-ticket
{
  "id": "DEPLOY-003",
  "type": "deploy",
  "title": "Committed server fixes were not running on the live service",
  "summary": "Several server-side fixes were committed but the running service still had the old code, so testing mixed a new browser build with an old server. The service was restarted and the fixes are now live. The restart was blocked while a live session held the service's connection, because the automatic restart only fires when no connections remain.",
  "impact_if_we_wait": "Diagnosis is repeatedly misled, because a fix appears broken when only the old server is answering. Bounded: this is a staleness of the running process, not lost data or a defect in the committed code, and a restart at any pause clears it.",
  "current_need": "Nothing is outstanding. The service on :4317 was restarted, and the health endpoint reported a new process with the newer fields present on the wire.",
  "severity": "high",
  "area": "Deployment and restarts",
  "reported": "2026-08-03",
  "reported_by": "orchestrator",
  "owner": "you",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-08-03",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "The health endpoint reports a new process id after the restart",
    "A reload part-way through a turn no longer interrupts the running session",
    "Live session data carries the busy field",
    "Model rows carry the resolved model identifier"
  ],
  "code_refs": [
    {
      "path": "src/server/index.js",
      "symbol": null,
      "note": "the guarded restart fires only when liveBridges === 0, which never happens while the developing session is itself the bridge on 4317"
    },
    {
      "path": "src/server/api/sessions.js",
      "symbol": "/api/sessions/live",
      "note": "busy and detached fields absent from the pre-restart process"
    },
    {
      "path": "src/server/api/models.js",
      "symbol": "/api/models",
      "note": "resolvedModel, which the model-picker's current-match highlight depends on"
    }
  ],
  "related": [
    {
      "id": "BUG-004",
      "relation": "see_also"
    },
    {
      "id": "FEAT-016",
      "relation": "blocks"
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
    "Activity log": false
  },
  "source": {
    "archived_path": "docs/bugs/archive/DEPLOY-003-server-restart-pending.md",
    "sha256": "a4c35bf405711ad4dd425c386255d0282fa8bc03dd4c79e45749212c6f6583f4",
    "bytes": 1909,
    "original_title": "Server on 4317 not restarted; server-side fixes not live",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared clause by clause against the original head: the stale-process symptom, the four not-live fixes, the self-bridge blocker, the manual restart and the staged watcher are all present.",
    "dropped": [
      "the exact shell one-liner's ss/grep pipeline, kept in the implementation notes as its plain meaning"
    ]
  }
}
```

# DEPLOY-003 — Committed server fixes were not running on the live service

## Diagnosis

Static client assets reach the browser on reload, so client-side fixes appeared to land. Server-side fixes did not, because the process listening on `127.0.0.1:4317` predated the commits. The process could not be restarted on demand: the session doing the development was itself the bridge holding that port, and the guarded restart only fires when `liveBridges === 0`. That condition is unreachable from inside the session that needs it.

The result during testing was a mix of new client and old server. The model-picker's current-item highlight was the clearest case — it reads a field the old process never sends, so the client looked broken when it was not.

## Evidence

Fixes known to be committed but not running included detach/reattach (so a reload or switch no longer kills a running dashboard session), the busy and detached fields on `/api/sessions/live`, `resolvedModel` on `/api/models`, and — depending on the process's age — the out-of-memory reporting and the memories, git and processes routes.

DEPLOY-003 was raised on 2026-08-03 after this mixed state had muddied diagnosis more than once.

## Implementation notes

The restart was performed by hand from a terminal at a natural pause: kill the process listening on 4317, then `npm start` from the project directory.

An idle-watcher script that performs this automatically the moment the bridge count reaches zero was written to the session scratch directory. It was not installed as a durable helper; that remains available if hands-off restarts are wanted.

## Verification plan

After the restart: `curl -s 127.0.0.1:4317/api/health` shows a new pid; a mid-turn reload no longer interrupts the session; `/api/sessions/live` carries `busy`; `/api/models` rows carry `resolvedModel`.
