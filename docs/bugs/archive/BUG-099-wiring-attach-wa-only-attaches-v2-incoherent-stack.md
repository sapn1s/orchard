# BUG-099 — the Wiring panel's "attach WA" applies ONLY v2, producing an incoherent instruction stack

- **Status:** VERIFIED
- **Area:** src/server/wiring.ts (`WA_TEMPLATE_IDS`) + src/server/index.ts (wiring apply `attach-wa`)
- **Reported:** 2026-08-14 (found while attaching the WA to this project)

## Problem
The FEAT-076 wiring panel's one-click **attach-WA** Apply attaches only `working-agreement-v2`
(`WA_TEMPLATE_IDS[0]`, wiring.ts:29, applied at index.ts:670). That produces an **incoherent stack**:

- v2's body opens with *"v1 (`WORKING_AGREEMENT.md`) is the stable base: read it first"* and
  `## Everything in v1, plus:` — v2 is an EXTENSION, not a standalone document.
- Heading-level diff shows **zero content overlap**. v1 carries the numbered core (definition of done,
  evidence over narrative, blocked ≠ stopped, decision authority, autonomy limits, parallelism/escalation,
  quality bar, the final report). v2 carries lettered sections A–N on entirely different topics. Grep
  confirms "verification is the deliverable" and "final report" appear **only** in v1 (0 hits in v2).
- So a v2-only attach injects a document that names a base which is never injected, and **drops the whole
  definition-of-done / evidence / final-report core**. The dangling "read it first" pointer resolves only
  by luck in THIS repo (the file happens to exist at that path); in any other project it resolves to
  nothing.

## Wanted
`attach-wa` should attach the COHERENT set — v1 (base) then v2 (living extension), both enabled, base
first — matching what a correct manual attach does. Alternatively, if a single-template attach is desired,
make v2 self-contained; but do NOT ship a one-click action that produces a stack with a dangling
dependency.
Also review the wiring CHECK side: `hasEnabledWaRef` treats any WA ref as satisfied, so a v2-only project
reports "Working Agreement ✅" while actually missing the core. The check should reflect coherence, not
mere presence.

## Verification (§C)
- Fresh fixture project with `instructions: []` → click/POST `attach-wa` → assert BOTH refs present and
  enabled, base first (must-FAIL pre-fix: only `working-agreement-v2` is attached).
- Compose the real system prompt for that project and assert v1-only markers (e.g. `### 2. Evidence over
  narrative`, "final report") ARE present — pre-fix they are absent, which is the actual harm.
- Wiring check: a v2-only project should NOT report a fully-satisfied Working Agreement.
- Anti-regress: verify:feat076 (36/36), verify:wa-injected, verify:local-conventions, verify:routing-inject,
  typecheck, leak-gate.
- Risk bucket: instruction-injection correctness (moderate) — a wrong attach silently ships a partial
  methodology, which is precisely the class of "assumed applied but wasn't" this panel exists to prevent.

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
