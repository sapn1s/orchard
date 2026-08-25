# BUG-089 — settings save echo-check is not subset-aware: partial patches falsely report "did not persist"

- **Status:** FIXED (client-side, public/lib/api.js; reaches users on reload) — see 2026-08-13 worker log
- **Area:** public/lib/api.js `patchProject` / `echoed()` / `same()`
- **Reported:** 2026-08-13 (follow-up from BUG-088)

## Root cause (from BUG-088)
The client's save verification compares the object it SENT to the object the server ECHOES with a
strict `same()` that requires equal key-count. But the server legitimately fills defaults, so a
PARTIAL patch (e.g. `{playwright:true}` when the stored object had no `tools`) is echoed back as a
defaults-filled SUPERSET (`{serena:true,playwright:true}`) → key-count mismatch → false
"settings did not persist". BUG-088 worked around this for `putTools` (send the full resolved
object), but `putBrowser` and `putSnapshots` share the identical latent flaw for older/partial
projects.

## Wanted
Make the echo compare SUBSET-aware: the save is "persisted" if every field the client SENT matches
the server's echo (the server MAY add default keys the client didn't send). Fix in
`api.js` `echoed()`/`same()` so all partial settings patches verify correctly — then the per-call
full-object workarounds (BUG-088's putTools) are belt-and-suspenders, not load-bearing.

## Verification (§C, realistic older-project fixture)
Drive the real api.patchProject against an older project with absent/partial `browser`/`snapshots`/
`tools`: a partial patch → save reported SUCCESS with only the sent field required to match, server
default-filled keys ignored (must FAIL pre-fix: strict key-count throws "did not persist"); a
genuinely-NOT-persisted value (server echoes a different value for a SENT field) still reports
failure. Anti-regress: verify:tool-toggle, verify:bug088, verify:overrides, verify:ui, typecheck,
leak-gate.

## Activity log (APPEND-ONLY)
### 2026-08-13 — orchestrator
- Filed from BUG-088's follow-up. The general fix for the echo false-negative class; client-only.

### 2026-08-13 — worker (BUG-089 lane)
**Fix (public/lib/api.js):** replaced the strict key-count `same(got, v)` in `echoed()` with a new
SUBSET-aware `covers(got, sent)`. The rule: a save is "persisted" iff every field the client SENT is
present-and-equal in the server's echo; extra sibling keys the server ADDED by default-filling (that
the client never sent) are ignored. It recurses into nested settings objects (tools / browser /
snapshots / container) with the same rule — only SENT leaf keys must match. Arrays are still compared
EXACTLY (a sent array is a whole leaf value, not a bag with optional extras). A genuine mismatch —
the server echoing a DIFFERENT value for a key the client actually sent, or a shape mismatch (sent
object vs echoed scalar/null) — is NOT a subset match and still returns false, so real "did not
persist" failures are still surfaced with the same error message. `same()` is unchanged (still used
by `covers()`'s fast path and for array equality).

**Effect on BUG-088:** the drawer's `putTools` full-object workaround (send the resolved object so
sent===echoed) is now belt-and-suspenders, not load-bearing — left intact, not regressed. The
identical latent false-negative for `putBrowser`/`putSnapshots` partial sends on older projects is
cured at the api.js layer by this change.

**Verification — new scripts/verify-bug-089-echo-subset.mjs (`npm run verify:bug089`):** boots a REAL
station server (free ephemeral port, scratch dataDir; never :4317) and drives the REAL
`api.patchProject`. REALISTIC-STATE fixture: an OLDER project rewritten in the registry to have NO
`tools` key, a PARTIAL `browser` (`{enabled:false}` only), and a PARTIAL `snapshots` (`{keep:3}`,
no `exclude`) — the state of any project predating FEAT-025 (the reporting user's state), not a full
stub. 6/6 with the fix:
- (A1) partial `{tools:{playwright:true}}` on a no-tools project → SUCCESS (server default-filled
  `serena` ignored). (A2) partial `{browser:{enabled:true}}` → SUCCESS (server-added `idleMs`
  ignored). (A3) partial `{snapshots:{keep:9}}` → SUCCESS (server default `exclude` array ignored).
- (A4) top-level `{name}` still verifies (non-settings path unaffected).
- (B1) WRONG-VALUE guard: a monkeypatched fetch rewrites the echoed `playwright` to `false` for a
  SENT `playwright:true` → still reports failure (`did not persist`); no false success.

**MUST-FAIL proof (both directions):** reverting `covers` → `same` in `echoed()` and re-running →
3/6, with A1+A2+A3 FAILing (the exact pre-fix false "did not persist" on partial sends), while A4 and
the B1 wrong-value guard still PASS (the fix did not turn the check into "accept anything"). Fix
restored, back to 6/6.

**regressed-from:** none — the strict key-count `same()` echo-check shipped this way in df2362a;
BUG-088 worked around one instance (`putTools`) at the drawer layer. This is the general cure.
Note: BUG-088's own verify script (`scripts/verify-bug-088-tool-settings.mjs`) case **C1** encoded the
PRE-089 buggy behaviour as an assertion (partial send MUST throw "did not persist"). Since api.js is
now subset-aware, that send correctly succeeds, so C1 was updated in place to assert the CURED
behaviour (with a comment pointing at verify-bug-089 A1 as the preserved historical repro). bug088 is
back to 11/11.

**Anti-regressions:** verify:bug089 6/6, verify:bug088 11/11, verify:tool-toggle 13/13,
verify:overrides 5/0, verify:ui 7/0 (PASSED full), typecheck exit 0, leak-gate PASS (0/388).

**Risk bucket:** UI save-verification (settings persist echo-check) — self-verify sufficient; not
security / session-lifecycle / data-loss. No independent clean-room pass required.

**Deploy:** client asset (public/lib/api.js) served by the station server → reaches users on reload
(no server restart needed for the logic, but the browser must fetch the updated asset).
