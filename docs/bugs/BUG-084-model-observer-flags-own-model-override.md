```orchard-ticket
{
  "id": "BUG-084",
  "type": "bug",
  "title": "Chosen model repeatedly appears as an unrequested change",
  "summary": "The model indicator now accepts the user's explicit selection and no longer reports it as an unrequested change after reconnecting. Genuine fallback and unexplained model changes still appear. The pre-fix cases failed, the corrected behavior passed, and standing checks remained clean.",
  "impact_if_we_wait": "Repeated false notices obscure genuine model changes and undermine trust in the transcript. Bounded: this affects display-correctness, not model selection, message delivery, or user data.",
  "current_need": "Treat the ticket as closed: the pre-fix cases failed, corrected behavior passed, and standing checks stayed clean.",
  "severity": "not_recorded",
  "area": "Model change notices",
  "reported": "2026-08-13",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-13",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A reported model matching the user's explicit selection produces no change notice",
    "Canonical and dated identifiers for the selected model are treated as equivalent",
    "Genuine silent switches and refusal fallbacks still produce notices",
    "Unexplained changes still produce notices when no explicit selection exists"
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "symbol": "model-observed handler",
      "note": "Compares the observed model with the persisted user override before flagging a silent switch."
    },
    {
      "path": "public/app.js",
      "symbol": "finishModel",
      "note": "Stores the user's explicit model selection used by the corrected comparison."
    },
    {
      "path": "src/server/agent-bridge.ts",
      "symbol": "model-observed emission",
      "note": "Correctly deduplicates main-thread wire-model changes and required no server change."
    },
    {
      "path": "scripts/verify-bug-084-model-selection.mjs",
      "symbol": null,
      "note": "Exercises the BUG-084 browser scenarios through the real dispatcher and rendered notice."
    }
  ],
  "related": [
    {
      "id": "FEAT-042",
      "relation": "see_also"
    },
    {
      "id": "BUG-026",
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
    "Migration and rollback": true,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-084-model-observer-flags-own-model-override.md",
    "sha256": "e0fc30f4862756ad89dfbdb17b114a6c3cb84aa1a49dcea30fbbb2d3a3bca833",
    "bytes": 5941,
    "original_title": "model-observer flags the user's OWN /model override as a per-turn \"silent switch\"",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared field by field with the archived original; the symptom, cause, client fix, preserved genuine notices, evidence, bounds, and regression coverage survive.",
    "dropped": []
  }
}
```

# BUG-084 — Chosen model repeatedly appears as an unrequested change

## Diagnosis

The server correctly emitted a report when the main-thread wire model changed. On each session initialization, the client seeded its expected model from the configured default rather than the user's persisted `/model` override. After reconnecting, the first response from the selected model therefore looked like an unrequested change. Separate refusal-fallback notices represented genuine safeguard events and were not defective.

## Evidence

The transcript showed the main-thread model changing from Fable to Opus 4.8 and then remaining on Opus 4.8 through the observed period. Despite that stability, reconnecting repeatedly produced the per-turn notice.

The browser-backed BUG-084 selection suite passed 5/5 after the fix and 3/5 with the fix stashed. The two pre-fix failures were the explicit-selection and canonical-versus-dated-identifier cases. The broader BUG-084 suite also passed 5/5. Anti-regression runs passed 14/14 for the earlier notice behavior, 1/1 for the model chip, 1/1 for model switching, and 7/7 for the interface. Type checking and the leak gate were clean.

## Implementation notes

The client now reads the persisted explicit model override and checks whether the observed model matches that choice. A match suppresses the notice and realigns the expected live model. Later deviations from both the selection and the last observed model still surface. Behavior is unchanged when the user made no explicit selection, and the server emission path remains untouched.

## Verification plan

Run the real browser and server scenarios in fresh pages. Confirm no notice for an exact selected-model match or an equivalent dated identifier. Confirm notices remain for a different observed model, a refusal fallback, and an unexplained change without an explicit override. Run the related model and interface regression suites plus type checking and the leak gate.

## Migration and rollback

The correction is client-only and becomes active on page reload through static serving. Rollback consists of reverting the client comparison; no stored data or server protocol requires migration.

## Risks

Over-broad model equivalence could hide a genuine deviation. Realigning the expected model only when the observation matches the persisted explicit choice keeps later deviations visible. Refusal-fallback notices use a separate event path and remain intact.

## Activity log (APPEND-ONLY)
### 2026-08-13 — investigate + fix (FE lane)
- Filed after confirming root cause from code + the live transcript jsonl (8 refusal-fallback frames;
  wire model stable opus-4-8 for a day). Root cause: `expectedLiveModel` seeded from the CLI's
  configured default (Fable) at `session-init`, not the user's `/model` override (opus) — Variant A.
- Fix in `public/app.js` `model-observed` handler (compare against the user's selection); Variant B
  (`model-changed` refusal-fallback) deliberately preserved.
- Verify `scripts/verify-bug-084-model-selection.mjs` (`npm run verify:bug-084`): post-fix 5/5,
  must-FAIL pre-fix 3/5 proven. Anti-regressions all green (see §C).
- **Reach:** client-only (`public/app.js`, statically served) — takes effect on the next page
  reload; **no server deploy needed** (the server-side `model-observed` emission was already correct).
