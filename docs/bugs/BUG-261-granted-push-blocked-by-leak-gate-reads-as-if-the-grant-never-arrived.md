# BUG-261 — a granted push blocked by the leak gate reads as if the grant never arrived

- **Status:** VERIFIED
- **Severity:** medium
- **Area:** server (git-shim / git-write-policy)
- **Reported:** 2026-10-14 by orchestrator (dispatch)
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED.

## Symptom
An agent with a live git-push grant ran `git push`, the push was refused by the
leak gate, and the refusal it saw never said the grant was active, never said the
gate had failed, and never showed what the gate flagged. The agent — reading the
refusal through `git push … 2>&1 | tail -2`, which showed only the generic
footer — concluded the grant had not reached the session and told the user to
restart (a restart changes nothing: the grant is fine, the gate failed). 19
sessions received this same ambiguous message (`blocked-gate` entries in
the host git-write audit log; the reporting bot session 74cc4195, transcript
lines 6852/6907/6911 — session id and project name kept out of this published
ticket per the leak gate).

## Repro
1. User grants git writes (push) for a project.
2. The project's working tree carries a private token (home path / username / name).
3. An agent subprocess runs `git push`. The FEAT-135 PATH shim consults the host,
   which runs the mandatory leak gate; the gate fails; the write is refused.
4. The shim prints the GENERIC `gitShimRefusal` ("git write refused / disabled"),
   not the gate-specific message. Piping `2>&1 | tail -2` shows only the footer.

## Expected
The refusal states, on its FIRST line (and repeated as the LAST line, so both
`| head -1` and `| tail -1` carry it): the grant IS active, the leak gate FAILED,
a restart will NOT help, and `npm run gate` shows what it flagged. It names what
the gate flagged (labels + count) WITHOUT echoing the private values. The
ungranted refusal keeps its distinct meaning, also carrying its decisive fact
first and last.

## Root cause
The host returns a human refusal STRING in `reason`. The shim
(`scripts/lib/git-shim.mjs` `runGitShim`) passed the host's reason through
verbatim only when it started with `'orchard: '` (the FEAT-164 release-mode path);
everything else fell back to `gitShimRefusal`. `gitWriteGateFailedRefusal`
(`scripts/lib/git-write-policy.mjs`) and `gitWriteRefusal` do not start with
`'orchard: '`, and the decide route (`src/server/index.ts` `/api/git-shim/decide`)
never forwarded `decision.gateFailed`. So the shim had NO channel to tell
granted-but-gate-failed from ungranted, and the prefix sniff was its only
pass-through. (Hypothesis in the dispatch — confirmed.)

## Fix
One structural route: the host decision carries a TYPED `refusalKind`
('gate-failed' | 'ungranted' | 'policy' | 'error'); the shim renders by that type
instead of sniffing the prefix, and passes the real offender (not the whole
reason) to the generic fallback. `gitWriteGateFailedRefusal` and `gitWriteRefusal`
were rewritten so the decisive line is first AND last. `redactGateDetail` surfaces
only the gate's generic token labels + hit count (never the matched excerpts or
paths the gate echoes — `scripts/leak-gate.mjs` `emitHit`), closing the
leak-into-a-published-transcript risk on both the shim and the Bash-hook paths.

## Context pack
- Files/functions in play:
  - `scripts/lib/git-shim.mjs` — `runGitShim`, `resolveGitShim`, `askHostGrant`.
  - `scripts/lib/git-write-policy.mjs` — `gitWriteGateFailedRefusal`,
    `gitWriteRefusal`, new `redactGateDetail`.
  - `src/server/index.ts` — `POST /api/git-shim/decide` deny responses.
  - `scripts/lib/git-grant.mjs` — `evaluateGitWrite` returns `gateFailed`.
- Related tickets: FEAT-135 (PATH shim), BUG-173 (grant-aware shim), FEAT-108
  (git-write block + leak gate), FEAT-164 (target-repo guard / release mode).
- Repro test: `node scripts/verify-bug-261-gate-failed-refusal.mjs`
- Known dependencies: the fail-closed deny paths keep the generic shim refusal.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-14 — worker (BUG-261 fixing r1)
- **Understood:** the shim's only pass-through channel was the `'orchard: '`
  prefix; the decide route dropped `decision.gateFailed`; so a granted push
  blocked by the gate rendered as the generic `gitShimRefusal`, indistinguishable
  from ungranted, with its decisive fact absent from both ends of the output.
  Confirmed the dispatch hypothesis (the shim cannot tell the two apart).
- **Changed:**
  - `src/server/index.ts` — the decide route's deny responses now carry a typed
    `refusalKind` ('gate-failed' | 'ungranted' | 'policy' | 'error').
  - `scripts/lib/git-shim.mjs` — `askHostGrant`/`resolveGitShim` carry
    `refusalKind` + the classified offender; `runGitShim` renders by type, not by
    prefix, and hands the real offender to the generic fallback.
  - `scripts/lib/git-write-policy.mjs` — rewrote `gitWriteGateFailedRefusal` and
    `gitWriteRefusal` (decisive line first AND last); added `redactGateDetail`
    (labels + count only; no private values).
  - `scripts/verify-bug-261-gate-failed-refusal.mjs` — new verify.
- **Verified:** see return message for the command/PASS-FAIL lines. Must-FAIL
  proof runs against a synthesized pre-fix shim+host (prefix-sniff, no
  refusalKind), not HEAD.
- **Verified-by:** pending — independent clean-room verify owed
  (session-lifecycle / leak-adjacent, prior-regression-prone file; warrants it).
- **Still open / handoff:** independent verify.
- **Symptom of a deeper design flaw?** no — a missing typed field on one route;
  the structural fix (typed outcome, not a string-prefix special case) removes the
  class.

### 2026-10-14 — dispatch anthropic
- **Verification recorded:** dispatch anthropic run 01ffc7ee-eab3-4dd4-8ec5-178a6db97ad9 — VERDICT: HOLDS — mixed-state candidate 735ecb3437ad. Typed entry in verification-ledger.json; this line is an echo, not proof.

### 2026-10-14 — worker (BUG-261 fixing r2+r3, driven by the clean-room)
- **Understood:** two prior clean-room BROKEN verdicts drove two fixes.
- **r2 (run 748a4805, BROKEN → fixed):**
  - Finding 1 (tested): the host's own fail-closed `refusalKind: 'error'` (bad/stale
    secret, unreadable body) rendered the terse host line verbatim and dropped the
    generic refusal + offender — a regression on the fail-closed path. Fix: only the
    AGENT-FACING kinds (`gate-failed`/`ungranted`/`policy`) render verbatim; every other
    deny (`error`, unknown, unclassified) renders the generic FEAT-135 refusal naming the
    offender, with the host's `error` reason appended as context.
  - Finding 2 (inferred): the route maps EVERY non-gate-failed denial to `ungranted`,
    including the rare grant-active-but-write-not-covered cases (re-decided call id,
    offender outside the window slots, claim lost between gate and use — git-grant.mjs
    147/188/222/474). `gitWriteRefusal` no longer asserts "NO grant is active"; its
    decisive line now says "`<offender>` was REFUSED — no grant lifted it".
- **r3 (run 748a4805 follow-up, BROKEN → fixed):** `redactGateDetail`'s hit-line regex
  could capture a path/value fragment as a "label" when a flagged file name itself
  contains `:N: [ … ]`. The gate's interleaved text format is not safely parseable for
  labels, so redaction now surfaces ONLY the gate-authored FAIL-summary COUNTS (hit +
  file integers) and defers kinds + file:line to `npm run gate`. Adversarial colon-in-name
  case added to the verify.
- **Verified:** `node scripts/verify-bug-261-gate-failed-refusal.mjs` → 32/32 PASS
  (incl. the must-FAIL pre-fix leg, both r2 findings, and the r3 adversarial). Full
  suite: verify-feat-135 31/0, verify-bug-173 28/0, verify-feat-108-git-grant 71/0,
  verify-feat-108-git-write-block 241/0 (run with the parent session shim stripped from
  PATH — that env artifact only blocks the suites' own scratch `git init`, unrelated to
  this change). `npm run gate` exit 0 (leak-gate + typecheck).
- **Verified-by:** `dispatch anthropic run 01ffc7ee-eab3-4dd4-8ec5-178a6db97ad9
  (clean-room, scripts/independent-verify.mjs) — VERDICT: HOLDS` — its own adversarial
  case ran the REAL leak gate with many value-bearing hits and confirmed no leak.
- **Still open / handoff:** none. UNTESTED by the clean-room (acceptable residuals): the
  real index.ts decide route booted end-to-end (needs the full server) — its refusalKind
  mapping is covered by code-read + the typecheck gate; the `policy` refusal texts were
  not run through the shim (printed verbatim, same render path as the tested kinds).
- **Symptom of a deeper design flaw?** no.

### 2026-10-14 — worker (BUG-261 landing r1 — push BLOCKED, nothing committed)
- **Attempted:** land/push BUG-261 alone under a 30-min git-write window.
- **Blocker (not pushed):** the verified fix is ENTANGLED with in-verification
  FEAT-164 and FEAT-170 in shared hunks/files, so it cannot be isolated:
  - `scripts/lib/git-shim.mjs` — BUG-261's `refusalKind`/offender rendering lives in
    the SAME hunks that (a) add `import … from './git-target.mjs'` (FEAT-164, the
    untracked `scripts/lib/git-target.mjs`) and (b) remove the `./shadow-guard.mjs`
    import + shadow logic (FEAT-170, which DELETES shadow-guard.mjs/shadow-vcs.mjs/
    shadow.mjs). Committing BUG-261's shim as-is drags in both; a clean checkout of
    main would have a broken `git-target.mjs` import unless FEAT-164+FEAT-170 ship too.
  - `scripts/lib/git-shim.d.mts` — BUG-261's `refusalKind?`/`offender?` fields sit
    beside FEAT-164 (`target`) and FEAT-170 (`shadowRoot` removal) edits.
  - `src/server/index.ts` — BUG-261's decide-route `refusalKind` hunks are a few
    among ~1283 lines interleaving many in-verification/open tickets.
  - Only `scripts/lib/git-write-policy.mjs` is pure BUG-261, but it is useless
    without the shim/index wiring and the verify would fail on a partial tree.
- **Status checked:** FEAT-164, FEAT-170, BUG-240, BUG-231 all IN-VERIFICATION (not
  verified). BUG-261 itself was verified against a MIXED-STATE candidate that already
  contained FEAT-164/FEAT-170 — shipping it alone is an unverified artifact.
- **Action:** committed/pushed NOTHING. Whole tree left untouched (no staging).
- **Handoff / decision for orchestrator:** either verify+close FEAT-164 and FEAT-170
  and land the three together, or authorize a batch-style landing commit (cf. ed92aff).
