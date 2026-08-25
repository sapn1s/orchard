# BUG-066 — independent-verify citation contract rejects the CORRECT run when the harness-supplied command carries an env-var prefix

- **Status:** VERIFIED (2026-08-12 — canonicalized command identity; must-FAIL proven; suite 132/132)
- **Verification-class:** trivial (pure harness-logic predicate; deterministic unit must-FAIL + the
  forgery-hole negatives, then exercised live by the three FEAT-062 closing runs it unblocked)
- **Severity:** med — blocks closing runs; burns a whole clean-room verification per occurrence
- **Filed:** 2026-08-11 by the FEAT-062 fix/closing agent
- **Scope:** `scripts/lib/verdict-contract.mjs` (verdict-contract citation matching, used by
  `scripts/independent-verify.mjs`) — ADJACENT to FEAT-062

## Why this is ADJACENT, not FEAT-062's own scope

FEAT-062 builds `scripts/verify-fix-loop.mjs` (durable fixer / ephemeral verifier / staleness gate /
round cap). The defect here is in the **verification harness that judges tickets**
(`independent-verify.mjs`), which FEAT-062 merely *uses* to close. It affects every ticket closed
through a clean-room verdict, not the loop's behaviour. Under the bounded closing bar recorded in
FEAT-062 (2026-08-11 orchestrator decision), a finding on adjacent uncovered surface is filed as its
own ticket and does not block the parent.

## Finding (reproduced first-hand, 2026-08-11)

The verdict contract checks that the verifier's `=== FIXER-TEST ===` section cites a manifest run
whose **recorded command** is the harness-supplied fixer test command. The comparison is a string
match against the command as recorded by the verifier's shell.

When the harness-supplied `--run` string carries an environment-variable prefix, e.g.

```
--run "FEAT062_SKIP_REAL=1 node scripts/verify-feat-062-loop.mjs"
```

the verifier runs exactly that, but the run is **recorded as**
`env FEAT062_SKIP_REAL=1 node scripts/verify-feat-062-loop.mjs` — the shell/manifest normalizes the
assignment prefix into an explicit `env` invocation. The contract then refuses the citation:

```
VERDICT-CONTRACT: INVALID — the citations do not check out against the harness's own records.
  VIOLATION: `=== FIXER-TEST ===` cites run f750c95bda1d, whose recorded command (env FEAT062_SKIP_REAL=1 node scripts/verify-feat-062-loop.mjs) is not the harness-supplied fixer test command — "the fixer's own test" means THE fixer's test, not a stand-in
```

The verifier did **exactly the right thing** and is told it cited a "stand-in". The whole run is
burned. This is a harness defect, not verifier non-compliance.

Observed on closing run `a5afb7ed-b34e-456f-b94d-072789203b06` (anthropic/sonnet, clean room
/tmp/cleanroom-verify-DYgo4f, 6 recorded runs). It also explains, retroactively, the identically
shaped VIOLATION in FEAT-062's earlier run `5a26e968-d184-492d-b8e6-b492c13d7a59`, which was at the
time attributed to the model "prefixing its citations with `env`" — the model did not add the
prefix; the recording did.

**Workaround used to close around it:** export the variable into the harness process instead of
inlining it, and pass a bare command (`--run "node scripts/verify-feat-062-loop.mjs"`). The env var
propagates through independent-verify → dispatch → the verifier's shell, and the recorded command
then matches literally. Confirmed working on run `28ace6d5-6241-4591-b741-2a9a922cbb32` (that run
was INVALID for an unrelated, genuine compliance reason — it cited the loop instead of the suite —
but the `env`-prefix violation was gone).

## Fix sketch

Normalize both sides before comparing, rather than matching raw strings. Minimum:

- strip a leading `env ` and any leading `NAME=value` assignment tokens from the **recorded**
  command before comparison; and/or
- normalize the **harness-supplied** command the same way, so the two are compared in the same form;
- collapse whitespace.

Prefer normalization over instructing models to avoid env prefixes — the prefix is introduced by the
recording layer, so no amount of verifier compliance can avoid it.

## Verification sketch (must-FAIL first)

1. Add a suite check to the independent-verify suite (`scripts/verify-independent-verification.mjs`,
   currently 127/127) that feeds the contract checker a harness-supplied command
   `FOO=1 node t.mjs` and a manifest whose recorded command is `env FOO=1 node t.mjs`, with an
   otherwise-compliant reply citing that run.
2. **Must-FAIL pre-fix:** the contract returns INVALID with the "is not the harness-supplied fixer
   test command" violation.
3. Post-fix: the contract accepts the citation and the verdict is judged on its merits.
4. Add the negative case too — a citation of a genuinely *different* command (e.g. a stand-in test)
   must still be refused, so the normalization does not become a hole.

## 2026-08-12 — fix agent: FIXED with must-FAIL proof (+ the forgery-hole negatives). VERIFIED.

**Fix — command IDENTITY, canonicalized on BOTH sides** (`scripts/lib/verdict-contract.mjs`).
New `canonCmd()`/`sameCmd()` next to `normCmd`: leading `env` tokens are dropped and leading
`NAME=value` tokens collected and SORTED, so `FOO=1 node t.mjs` and `env FOO=1 node t.mjs` are the
same command in either direction. The assignments stay part of the identity, so this is
identity-preserving normalization, not a loosening. `env` with option flags (`env -i`, `env -u X`)
is left alone conservatively — nothing after a flag is treated as a prefix.

All five command-identity comparisons now go through `sameCmd()` instead of raw `normCmd()` string
equality: `manifestCheck`'s `RAN:`-vs-manifest check, the `FIXER-TEST` `RAN:`-vs-knownRuns pin
(validate path), the adversarial-re-runs-the-fixer's-command check (validate path), and both of the
same two checks on the `composeVerdict` path. Fixing only the composeVerdict site would have moved
the violation one layer down, since the composed `RAN:` line is re-validated against `knownRuns`.

**MUST-FAIL PROVEN FIRST** — five checks added to `scripts/verify-independent-verification.mjs`,
run with the checks in and the fix NOT applied. THREE failed, in the exact a5afb7ed shape:
```
FAIL  BUG-066: a FIXER-TEST citing the harness-supplied command as the RECORDER wrote it …
      observed: ["`=== FIXER-TEST ===` cites run f750c95bda1d, whose recorded command (env FEAT062_SKIP_REAL=1 node scripts/verify-feat-062-loop.mjs) is not the harness-supplied fixer test command — \"the fixer's own test\" means THE fixer's test, not a stand-in"]
FAIL    …and symmetrically: a supplied `env FOO=1 …` matches a recorded bare `FOO=1 …`
FAIL    …NEGATIVE: an ADVERSARIAL case citing the fixer command wearing the `env` prefix is still "the fixer's own command", not a novel case
      observed: []
```
The third failure is a finding this ticket did not predict: pre-fix, the raw string match was ALSO a
**bypass** in the other direction — a verifier could re-run the fixer's own command under an `env`
prefix and have it accepted as a *novel adversarial case* (`observed: []` = no violation raised).
The canonicalization closes the false-INVALID and that hole with one mechanism.

Post-fix all five PASS. The two negatives that (correctly) passed pre-fix still pass: a DIFFERENT
program under the same env prefix, and the same program with a different assignment VALUE
(`FEAT062_SKIP_REAL=0`), are both still refused — normalization is not a forgery hole.

**Counts:** `verify:independent-verification` **132/132 PASS** (was 127; +5). Adjacent gates green
on the same tree: `verify:feat-062-loop` **31/31** (full suite, real e2e round included),
`verify:dispatch` **24/24**, `npm run typecheck` clean (exit 0), `node scripts/leak-gate.mjs` PASS
(0 hits / 306 tracked text files).

**Confirmed live.** Three clean-room closing runs of FEAT-062 were executed on this fixed harness
with the documented `--run "FEAT062_SKIP_REAL=1 node scripts/verify-feat-062-loop.mjs"` — the exact
command shape that burned run a5afb7ed. The `env`-prefix violation did not appear in any of them,
and one run reached a contract-VALID verdict on the merits.

**Status: VERIFIED.** The defect is a pure harness-logic bug with a deterministic unit repro; the
must-FAIL was proven pre-fix, the fix is minimal, both directions and both bypass negatives are
ratcheted, and the fix was then exercised live on the very runs the bug was blocking.
