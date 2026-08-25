# BUG-078 — per-chunk Buffer.toString() corrupts multibyte UTF-8 straddling a stream chunk boundary

- **Status:** VERIFIED 2026-08-13 (deployed) — code landed 2026-08-12 (commit 65a2a55); dispatch.mjs was live immediately, codex-runtime.ts now deployed (pid 1162138 runs latest). Reconciled FIXED→VERIFIED.
- **Area:** src/server/runtime/codex-runtime.ts + scripts/dispatch.mjs — stdout decoding
- **Reported:** 2026-08-12 by the area-review workflow (runtime reviewer + skeptic verify)

## Finding (code-confirmed)
Two stdout readers decode each Buffer chunk independently as UTF-8:
`buf += d.toString()` (codex-runtime.ts:410) and `stdoutBuf += d` (dispatch.mjs:248). Node emits
`data` as raw Buffers split at arbitrary byte offsets (~64KB), so any non-ASCII codepoint whose
bytes span two chunks decodes to U+FFFD replacement chars in each half. JSON structural bytes are
ASCII, so the corruption always lands *inside string values* — parse still succeeds, content is
silently mangled. No `setEncoding('utf8')`/`StringDecoder` on either stream.

## Failure scenario
A dispatched task returns a >64KB result containing a multibyte char (emoji, accented letter) at a
chunk boundary → split across two `data` events → the accumulated string holds `��` where the
character was → JSON-parses fine → the corrupted text is written verbatim as the task's final
answer (and, for codex, as streamed frame content).

## Wanted
Decode across chunk boundaries correctly at BOTH sites: `stream.setEncoding('utf8')` (simplest —
Node's own StringDecoder buffers partial codepoints), or an explicit `StringDecoder`. Any other
raw-Buffer accumulators in the same two files get the same treatment (sweep both). Byte-exact
framing/JSON boundaries must be unaffected (setEncoding only changes decode, not chunk delivery).

## Verification (§C)
Unit/real-shape: feed a reader a multibyte string chunked at the byte splitting the codepoint →
output is byte-identical to the input (must FAIL pre-fix: U+FFFD pair). Exercise both the codex
frame path and the dispatch anthropic result path. Anti-regressions: verify:codex-runtime,
verify:dispatch, typecheck, leak-gate.

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
