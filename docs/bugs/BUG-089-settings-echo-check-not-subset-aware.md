```orchard-ticket
{
  "id": "BUG-089",
  "type": "bug",
  "title": "Partial settings saves falsely report failure",
  "summary": "Partial settings saves now accept server-added defaults while still rejecting changed values the client sent. Previously, updates could persist correctly but display a failure when returned settings included extra defaults. Targeted regression suites passed, and standing type and leak checks stayed clean.",
  "impact_if_we_wait": "Until users reload, correctly persisted partial settings updates may show a false failure and prompt unnecessary retries. Bounded: this affects save-status display correctness, not data loss or failed persistence.",
  "current_need": "Treat the ticket as closed: partial-patch regressions passed, mismatch rejection remained covered, and standing checks stayed clean.",
  "severity": "not_recorded",
  "area": "Project settings saves",
  "reported": "2026-08-13",
  "reported_by": "agent",
  "owner": "agent",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-08-13",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Partial settings patches accept returned objects containing additional server defaults",
    "A returned value differing from a sent field still reports failure",
    "Older projects with absent or partial settings save successfully"
  ],
  "code_refs": [
    {
      "path": "public/lib/api.js",
      "symbol": "patchProject",
      "note": "Uses the corrected echo comparison for partial settings patches"
    },
    {
      "path": "public/lib/api.js",
      "symbol": "echoed",
      "note": "Checks sent fields against the server response"
    },
    {
      "path": "public/lib/api.js",
      "symbol": "same",
      "note": "Previously required equal key counts"
    }
  ],
  "related": [
    {
      "id": "BUG-088",
      "relation": "recurrence_of"
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
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-089-settings-echo-check-not-subset-aware.md",
    "sha256": "bfdd107105f80e0077e9cd1b6af8c214eacc2f9bfaf3c3211e141b3fdf222deb",
    "bytes": 5948,
    "original_title": "settings save echo-check is not subset-aware: partial patches falsely report \"did not persist\"",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the supplied original; the cause, affected settings paths, subset rule, mismatch safeguard, rollout, and executed evidence remain represented.",
    "dropped": []
  }
}
```

# BUG-089 — Partial settings saves falsely report failure

## Diagnosis

The client compared the complete sent object with the server echo using `same()`, which required equal key counts. The server legitimately adds default settings, so a partial patch could persist while the defaults-filled response triggered a false "settings did not persist" error. BUG-088 avoided this for `putTools` by sending a resolved object, but `putBrowser` and `putSnapshots` retained the underlying flaw.

## Evidence

`verify:tool-toggle` passed 13/13, `verify:bug088` passed 11/11, and `verify:bug089` passed 6/6. The standing `typecheck` and `leak-gate` checks were clean.

## Implementation notes

The client-side comparison in `public/lib/api.js` is subset-aware: every field sent must match the echo, while additional server default keys are ignored. Existing full-object workarounds remain defensive rather than required. Users receive the change after reloading.

## Verification plan

Drive the real `api.patchProject` against an older project with absent or partial browser, snapshot, and tool settings. Confirm a partial patch accepts added defaults, while an altered value for a sent field still fails. The ticket requested a clean-room independent pass.

## Risks

A comparison that ignores mismatches in fields actually sent would conceal failed persistence. The subset rule must ignore only additional response keys.

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
