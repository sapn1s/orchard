```orchard-ticket
{
  "id": "BUG-078",
  "type": "bug",
  "title": "Streamed text was silently corrupted at chunk boundaries",
  "summary": "Streamed text now preserves multibyte characters that cross chunk boundaries. Previously, affected characters became replacement symbols while the surrounding JSON still parsed. The correction is deployed across both affected output paths, and the pre-fix boundary case failed before corrected behavior passed.",
  "impact_if_we_wait": "Without the deployed correction, some large streamed responses could contain silently mangled characters. Bounded: this affected text display-correctness, not JSON structure, framing, or stored data outside the corrupted response.",
  "current_need": "Treat the ticket as closed: the boundary case failed before correction, both affected paths passed afterward, and standing checks stayed clean.",
  "severity": "not_recorded",
  "area": "Streamed output decoding",
  "reported": "2026-08-12",
  "reported_by": "area-review workflow",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-13",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Multibyte characters split across chunks remain byte-identical after decoding",
    "Codex frame content preserves characters crossing chunk boundaries",
    "Dispatched result text preserves characters crossing chunk boundaries",
    "JSON framing and structural parsing remain unchanged"
  ],
  "code_refs": [
    {
      "path": "src/server/runtime/codex-runtime.ts",
      "symbol": null,
      "note": "BUG-078 affected stdout accumulation near line 410."
    },
    {
      "path": "scripts/dispatch.mjs",
      "symbol": null,
      "note": "Affected stdout accumulation near line 248."
    }
  ],
  "related": [],
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
    "archived_path": "docs/bugs/archive/BUG-078-multibyte-chunk-boundary-corruption.md",
    "sha256": "0498b812287c55de64bec80cc2c9e0a9c94d06ffdb325813886ca2f4e7231e25",
    "bytes": 4444,
    "original_title": "per-chunk Buffer.toString() corrupts multibyte UTF-8 straddling a stream chunk boundary",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the archived ticket text; the symptom, mechanism, affected paths, required coverage, deployment details, and executed evidence are preserved.",
    "dropped": []
  }
}
```

# BUG-078 — Streamed text was silently corrupted at chunk boundaries

## Diagnosis

Both stdout readers decoded each raw Buffer independently. Stream chunks can split a multibyte UTF-8 codepoint at any byte boundary, causing each partial sequence to decode as U+FFFD. Because JSON structure uses ASCII bytes, parsing still succeeded while string content was silently corrupted.

## Evidence

The recorded pre-fix boundary case produced replacement characters when a multibyte codepoint was divided between chunks. After correction, `verify:codex-runtime` passed 54/54 and `verify:dispatch` passed 24/24. Typecheck and leak-gate were also reported clean.

## Implementation notes

Use stream-level UTF-8 decoding or `StringDecoder` so partial codepoints are buffered between data events. Both affected files and any equivalent raw-Buffer accumulators within them require consistent treatment. Decoding must not alter chunk delivery, framing, or JSON boundaries.

## Verification plan

Split a multibyte string at a byte inside one codepoint and feed the pieces separately through both the codex frame path and dispatched result path. Confirm the reconstructed output is byte-identical. The ticket named `verify:bug-078-multibyte`, but recorded no execution result for that suite.

## Migration and rollback

Commit 65a2a55 landed on 2026-08-12. `scripts/dispatch.mjs` became live immediately; `codex-runtime.ts` was later deployed, with pid 1162138 reported on the latest code.

## Risks

Changing decoding must preserve existing framing and JSON parsing behavior. Any remaining per-chunk UTF-8 decoder in these readers could retain the same silent corruption.

## Activity log (APPEND-ONLY)
### 2026-08-12 — orchestrator
- Filed from the area-review workflow. codex-runtime is server-side (needs deploy); dispatch.mjs
  is a script (no deploy). Disjoint lane from the others.

### 2026-08-12 — worker (fix)
- FIX at both sites via `stream.setEncoding('utf8')` (Node StringDecoder buffers partial codepoints
  across chunk boundaries — decode-only, framing/JSON boundaries untouched):
  - `src/server/runtime/codex-runtime.ts` — stdout frame reader (`buf += d.toString()` →
    `setEncoding('utf8')` + `buf += d`) AND the stderr-tail accumulator swept the same way
    (`(this.#stderrTail + d.toString())` → `setEncoding` + `+ d`).
  - `scripts/dispatch.mjs` — anthropic result reader (`stdoutBuf += d` → `setEncoding('utf8')`);
    the stderr accumulator/passthrough swept the same way. Sweep of both files found no other
    raw-Buffer accumulators.
- Both files swept; no other raw-Buffer accumulators remain.
- VERIFY (§C): new `scripts/verify-bug-078-multibyte.mjs` (+ `verify:bug-078-multibyte` in
  package.json) drives a multibyte string chunked at the byte splitting a 4-byte codepoint (U+1F389)
  through BOTH real paths — the codex frame reader (fake app-server child via the runtime's
  spawnProcess seam, PassThrough stdout, agentMessage pushed as two chunks straddling the emoji) and
  the dispatch anthropic result path (fake `claude` shim on PATH writing the JSON blob in two timed
  writes straddling the emoji).
  - PRE-FIX (must-FAIL proof): 1 passed, 4 failed — both paths observed `���` (U+FFFD run) where
    `🎉` was.
  - POST-FIX: 5 passed, 0 failed — both paths byte-identical, no U+FFFD.
  - Anti-regressions: verify:codex-runtime 54/54, verify:dispatch 24/24, typecheck clean (exit 0),
    leak-gate PASS (0 hits / 438 files).
- DEPLOY SPLIT: dispatch.mjs (a script) is live immediately; codex-runtime.ts is server-side and
  NEEDS DEPLOY to take effect. This worker did NOT deploy/restart (no :4317/systemd/host-scope
  touches).

### 2026-08-13 — board reconciliation
- Deploy has since happened (commit 65a2a55 live; pid 1162138 runs the latest code). Status header
  relabeled FIXED→VERIFIED so board:gen moves this row out of Open (queued-count reconciliation).
