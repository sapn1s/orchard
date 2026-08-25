```orchard-ticket
{
  "id": "BUG-099",
  "type": "bug",
  "title": "Working Agreement attachment omitted its required base",
  "summary": "The Wiring panel now attaches the complete Working Agreement in dependency order and rejects extension-only setups as incomplete. Previously, one-click attachment supplied only the extension, leaving its required base instructions unavailable.",
  "impact_if_we_wait": "Projects could silently receive incomplete working instructions and appear correctly configured. Bounded: this affected instruction completeness and display-correctness, not project data or runtime execution.",
  "current_need": "Treat the work as closed: the incomplete case failed before correction, all targeted behavior passed afterward, and standing checks stayed clean.",
  "severity": "medium",
  "area": "Working Agreement wiring",
  "reported": "2026-08-14",
  "reported_by": "agent",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-14",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-14",
      "question": "Should attachment include both documents or make the extension self-contained?",
      "mode": "single",
      "options_keys": [
        "A",
        "B"
      ],
      "chosen": "A",
      "chosen_on": null,
      "chosen_by": "agent",
      "note": "The implemented path attaches the base first and then its living extension."
    }
  ],
  "success_criteria": [
    "Attachment adds both Working Agreement documents enabled and in dependency order",
    "Composed instructions contain markers supplied only by the base document",
    "An extension-only configuration does not appear fully satisfied"
  ],
  "code_refs": [
    {
      "path": "src/server/wiring.ts",
      "symbol": "WA_TEMPLATE_IDS",
      "note": "Defines the Working Agreement templates used by the panel."
    },
    {
      "path": "src/server/index.ts",
      "symbol": "attach-wa",
      "note": "Applies the coherent template set in base-first order."
    },
    {
      "path": "src/server/index.ts",
      "symbol": "hasEnabledWaRef",
      "note": "Checks coherent Working Agreement coverage rather than any single reference."
    }
  ],
  "related": [
    {
      "id": "FEAT-076",
      "relation": "see_also"
    },
    {
      "id": "FEAT-089",
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
    "Migration and rollback": true,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-099-wiring-attach-wa-only-attaches-v2-incoherent-stack.md",
    "sha256": "8ece09f23a040d5517af522c672741cdf7f4b4ac337fdadd03fc610bbaccbff9",
    "bytes": 6323,
    "original_title": "the Wiring panel's \"attach WA\" applies ONLY v2, producing an incoherent instruction stack",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the archived BUG-099 text; the omitted base, misleading check, selected remedy, affected code, risks, and executed evidence are preserved.",
    "dropped": []
  }
}
```

# BUG-099 — Working Agreement attachment omitted its required base

## Diagnosis

The one-click attachment selected only `working-agreement-v2`, although that document explicitly extends `WORKING_AGREEMENT.md` and directs readers to it first. The two documents have no heading-level content overlap, so omitting the base removed its definition-of-done, evidence, authority, and final-report guidance. The satisfaction check also accepted any enabled Working Agreement reference, masking the incomplete stack.

## Evidence

Before correction, reverting only the two source files produced 14/21 passing in `verify:bug-099-attach-wa-coherent`. After correction, that suite passed 21/21. `verify:feat076` passed 36/36, `verify:wa-injected` 15/15, `verify:local-conventions` 18/18, `verify:routing-inject` 18/18, and `verify:sessions` 52/52. Typecheck and leak-gate were clean.

## Implementation notes

Attach the base document before the living extension, with both enabled. Treat an extension-only project as incomplete in the Wiring panel. This preserves the manual attachment order and ensures the extension's dependency is available in every project.

## Verification plan

Starting from a fresh project with no instructions, apply `attach-wa` and assert both references are enabled with the base first. Compose the system prompt and assert base-only markers are present. Confirm an extension-only project does not show a satisfied Working Agreement check.

## Migration and rollback

Existing extension-only projects may require the base reference to be attached. The change is limited to attachment and satisfaction-check behavior; rollback restores the former partial attachment and permissive check.

## Risks

Incorrect ordering or duplicate attachment could alter instruction composition. The exposure is moderate and limited to instruction-injection correctness; project data is not modified.

## Activity log (APPEND-ONLY)
### 2026-08-14 — orchestrator
- Found while attaching the WA to this project: the worker deliberately bypassed the built-in Apply button
  (which would have produced the v2-only stack) and used the validated PATCH path with both refs. The
  built-in path is still wrong for the next user who clicks it. Note the irony worth recording: the panel
  built to show "assumed vs reality" would itself have produced a half-applied methodology reported as ✅.

### 2026-08-14 — worker (fix + verify)
- **Fix (attach side), src/server/index.ts (wiring `attach-wa` branch):** attach the COHERENT set
  through the validated PATCH path (validateProjectPatch + updateProject) — enable any existing WA
  refs in place, then guarantee `working-agreement` (v1 base) is present and ordered BEFORE
  `working-agreement-v2` (v2 extension). Idempotent (no dup refs on re-apply) and repairs a v2-only
  stack by splicing v1 immediately before v2 WITHOUT disturbing other refs. The branch now also
  accepts `check:"attach-wa"` (the ticket's spelling) in addition to `"working-agreement"`
  (the key the live client posts) — pre-fix `attach-wa` fell through to the 400 "nothing to apply".
- **Fix (check side), src/server/wiring.ts:** replaced presence-only `hasEnabledWaRef` with
  coherence. New `waRefState()` / `WaRefState`: coherent iff the base (v1) is enabled (v1 is
  self-contained; v1 or v1+v2 = coherent; v2 alone = `extensionOnly`). The WA row now reports
  `ok` when coherent, `warn` + repair Apply when v2-only (detail names the missing base and the
  dropped definition-of-done/evidence/final-report core), `missing` otherwise. The CLAUDE.md
  pointer stays the fallback ONLY when there is no usable ref — it can no longer mask a half-applied
  ref stack. Introduced `WA_BASE_ID`/`WA_EXT_ID`/`WA_COHERENT_IDS`; `WA_TEMPLATE_IDS` reordered
  base-first.
- **Verify (§C), real scratch server (free ephemeral port, scratch dataDir, NEVER :4317):**
  `scripts/verify-bug-099-attach-wa-coherent.mjs` — 21/21 PASS. Decisive assertion (2): the
  COMPOSED system prompt for the freshly-attached fresh fixture carries the v1-only markers
  "### 2. Evidence over narrative" and "The final report", with v1 ordered before v2. Also covers
  fresh-empty attach (both refs, base first), idempotency (double apply → 1+1), repair of a v2-only
  stack with an unrelated ref left intact, the check-side warn, and the pointer arm still passing.
- **MUST-FAIL pre-fix:** reverting only the two src files → 14/21 FAIL, including (1c) only v2 attached,
  (2a/2b) v1 core absent from the composed prompt (the actual harm), and (5a) v2-only reported `ok`.
  Post-fix 0 fail.
- **Anti-regress:** verify:feat076 36/36, verify:wa-injected 15/15, verify:local-conventions 18/18,
  verify:routing-inject 18/18, verify:sessions 52/52, typecheck clean, leak-gate PASS (0 hits).
- **Lane discipline:** touched only src/server/wiring.ts, src/server/index.ts (wiring branch +
  import), the ticket, and the new verify script. Did NOT touch public/app.js or public/styles.css
  (other worker's lane); the client renders `warn` already (board/drift-guard use it), so no client
  change was needed.
- **Risk bucket:** instruction-injection correctness (moderate/regression-prone — touches the WA
  compose path). An independent clean-room verify pass is warranted before this ships to users.
- **No restart required:** pure source change; no service/:4317 restart, no deploy.
