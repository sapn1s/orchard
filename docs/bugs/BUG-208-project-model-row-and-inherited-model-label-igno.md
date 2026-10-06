```orchard-ticket
{
  "id": "BUG-208",
  "type": "bug",
  "title": "Project model row and inherited model label ignore the real engine",
  "summary": "The drawer's project-scope Model row cycles the Claude catalog even for an OpenAI project, so a Claude default can be stored and then silently dropped for every Codex session; and the model chip/button name the project's default model for a session whose engine cannot run it. Session scope was fixed by BUG-196 round 6.",
  "impact_if_we_wait": "Display dishonesty and a silent no-op project setting; no session is killed and no wrong engine runs. The BUG-196 matrix does not cover project scope.",
  "current_need": "fix",
  "severity": "medium",
  "area": "UI settings drawer + model chip",
  "reported": "2026-09-29",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-09-29",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Project-scope Model row offers only the project provider's catalog",
    "The inherited model label names the model the engine will really use, or says it is unknown, from a server declaration",
    "A must-FAIL browser case per engine over a busy-state fixture"
  ],
  "code_refs": [],
  "related": [],
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

# BUG-208 — Project model row and inherited model label ignore the real engine

## Symptom
1. Settings ▸ Model & spend, PROJECT scope, on a project whose provider is OpenAI: the Model row cycles Claude values. Picking one stores settings.model = a Claude id; every Codex session then resolves it to the engine default without a word (resolveModelForProvider, project-default path — only explicit session picks are announced).
2. The crown model chip and the model button label an OpenAI-pinned session under a Claude-default project with the project's Claude model (resolveInheritedModelLabel reads project settings.model regardless of engine), until a start reports the real model.

## Expected
The project-scope Model row offers the catalog of the project's own provider (the session scope already does since BUG-196 round 6: ctx.sessionModelCycle). The inherited label names the model the engine will really use, or says it is not known yet — declared by the server (it owns modelProviderOf), not re-derived in the client, which has no classifier since BUG-196 round 6.

Also considered and deliberately not folded into modelProviderOf: scripts/lib/cost-model.mjs providerOf, a second model-id prefix table used to PRICE recorded wire ids (tooling; it returns unknown/synthetic by design and never sees aliases). Worth a decision whether pricing should read the one classifier.

## Context pack
- public/lib/drawer.js modelPane (modelCycle, project scope); public/app.js resolveInheritedModelLabel, paintModelChip, paintModelBtn; src/server/global-settings.ts modelProviderOf / resolveModelForProvider; scripts/lib/cost-model.mjs providerOf.
- Related: BUG-196 (round 6 closed the session-scope twin), FEAT-118, FEAT-045, BUG-188.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-29 — BUG-196 round-6 fix lane (Opus 5.5) — filed
- **Understood:** found while attacking the round-6 matrix for paths it does not cover. Session scope was fixed in BUG-196 round 6; project scope and the inherited label were declined there as outside the per-session lock.
- **Verified:** by code read only (drawer.js modelPane project branch; app.js resolveInheritedModelLabel). Not reproduced in a browser.
- **Still open / handoff:** make the project-scope cycle follow the project provider; have the server declare the resolved model for an existing session (or show unknown) instead of the client guessing.
