# BUG-069 — `verify:feat-062-loop` E2BIG-fixer-relay ratchet is flaky (~50% FAIL)

- **Status:** VERIFIED 2026-08-12 (independent — reproduced from scratch, did not trust builder's numbers): 10/10 consecutive `verify:feat-062-loop` 32/32, promptBytes DETERMINISTIC at 170546 every run, FIXER RELAY HOP PASS every run; ratchet teeth re-proven (fixed suite vs old argv-relay loop at `66e092c^` = 31/32, e2big=true). Root cause was the VERIFY_SHIM's stdout, not the loop's stdin relay. 10/10 consecutive `verify:feat-062-loop` 32/32 (promptBytes now DETERMINISTIC at 170546; pre-fix it fluctuated 170451/170546 and dropped to 147059 ~40% of runs → sentinel lost). Pre-fix flake reproduced 3/8; the E2BIG ratchet re-proven to must-FAIL against the pre-fix argv-relay loop (`66e092c^`, clean worktree, `e2big=true`). Awaiting independent verification.
- **Severity:** medium
- **Area:** tooling — `scripts/verify-feat-062-loop.mjs` / `scripts/verify-fix-loop.mjs` (FEAT-062 lane)
- **Reported:** 2026-08-12 by FEAT-061 hole-#18 closer agent (adjacent finding; filed per FEAT-061's bounded-scope rule — does NOT block FEAT-061)
- **Verification-class:** fix

## Symptom
`FEAT062_SKIP_REAL=1 node scripts/verify-feat-062-loop.mjs` intermittently reports **31/32**
instead of 32/32. The failing check is always the same one:

```
FAIL  FIXER RELAY HOP: an oversized composed verdict (>150KB) reaches the durable fixer over
      stdin — no spawn E2BIG at the fixer hop, tail sentinel present in the delivered prompt
      observed: exit=0 e2big=false viaStdin=true promptBytes=147059
```

## Repro
Run the suite several times back-to-back (deterministic-debug mode is enough):

```
for i in 1 2 3 4; do FEAT062_SKIP_REAL=1 node scripts/verify-feat-062-loop.mjs 2>&1 \
  | grep -E "verify:feat-062-loop —|promptBytes"; done
```

Observed across runs: `promptBytes` alternates between ~**147059** (FAIL) and ~**170451** (PASS).
The check (`scripts/verify-feat-062-loop.mjs:576`) passes only on the larger variant. `exit=0`,
`e2big=false`, `viaStdin=true` on both — so the failing sub-condition is the **sentinel presence**
(`p0.includes('E2BIG-FIXER-TAIL-SENTINEL-4423')` / `SENTINEL-ROUND-1:`), i.e. the first fixer-relay
prompt captured as `fc[0]` sometimes is not round 1's oversized BROKEN+BIG verdict.

## Confirmed NOT caused by the FEAT-061 hole-#18 change
Reproduced on a **clean tree** (`git stash` of the hole-#18 edits): 2 PASS / 2 FAIL across 4 runs.
The FEAT-061 change touches only `scripts/lib/verdict-contract.mjs` +
`scripts/verify-independent-verification.mjs`; neither `verify-feat-062-loop.mjs` nor
`verify-fix-loop.mjs` imports the changed code path in this test (the loop's verifier is the
`VERIFY_SHIM`, which prints the verdict directly and never calls `composeVerdict`/`excerptOutput`).

## Expected
Deterministic 32/32. The E2BIG-fixer-relay ratchet should pin `fc[0]` to round 1's oversized
BROKEN+BIG verdict every run (or assert against whichever fixer call carried the pad), so the
`>150KB` + tail-sentinel guarantee is checked reliably.

## Context pack
- Failing check: `scripts/verify-feat-062-loop.mjs:576` (block at :560–:580).
- Pad source: `scripts/verify-feat-062-loop.mjs:119` (2000 PAD-LINEs + `E2BIG-FIXER-TAIL-SENTINEL-4423`).
- Relay path: `scripts/verify-fix-loop.mjs` `verifyRound()` (:315) → `verdictText` (:332) →
  `fixRound()` (:342, VERBATIM relay via `--prompt-stdin`).
- Likely root cause (unconfirmed): nondeterministic first-fixer-call selection, or the conditional
  re-orientation preamble (`scripts/verify-fix-loop.mjs:427`) being present on the larger variant
  and absent on the smaller — i.e. `fc[0]` is not always round 1's relay.
- Repro test: the suite itself (above).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-12 — FEAT-061 hole-#18 closer agent
- **Understood:** pre-existing nondeterminism in the FEAT-062 E2BIG-fixer ratchet; surfaced while
  running `verify:feat-062-loop` as part of the FEAT-061 hole-#18 gate. Isolated to the FEAT-062
  lane and confirmed independent of the FEAT-061 change (clean-tree repro above).
- **Changed:** nothing — filed only (FEAT-061 bounded-scope: adjacent findings get their own ticket
  and do not block).

### 2026-08-12 — BUG-069 fix agent (in-place, scripts lane)
- **Reproduced:** ran the section 8× back-to-back → 5 PASS (promptBytes ~170451/170546) / 3 FAIL
  (promptBytes 147059). Confirmed both outcomes.
- **Root cause (NOT the loop's stdin relay, NOT dispatch.mjs):** instrumented `fc[0].prompt` on the
  failing runs — the prompt's own TAIL ("End your reply…") was intact but the pad was short
  (`padCount=1726` of 2000) and the tail sentinel was missing. So the truncation is in the MIDDLE of
  the relayed verdict = the END of `verdictText`, i.e. the VERIFY_SHIM's stdout. The shim did one
  ~160KB `console.log(...)` then `process.exit(1)` immediately; `console.log` to a pipe is
  async-buffered, and `process.exit()` drops the unflushed tail nondeterministically (depends on pipe
  drain timing). The loop then relayed a truncated (<150KB) verdict with no sentinel. The hypothesis
  in the ticket's Context pack ("fc[0] is not always round 1's relay") was wrong — with the
  `['BROKEN+BIG','HOLDS']` queue there is exactly one fixer call; `fc[0]` was always round 1, just
  truncated. Direct `readFileSync(0)` of a 170KB pipe read fully 12/12, ruling out the read side.
- **Changed:** `scripts/verify-feat-062-loop.mjs` — the VERIFY_SHIM now composes its entire stdout as
  ONE string and writes it SYNCHRONOUSLY via `fs.writeSync(1, …)` (looping past partial writes /
  EAGAIN), so every byte is in the OS pipe before `process.exit` (kernel-buffered pipe data survives
  the writer's exit). No `console.log` in the BROKEN branch → no interleave, no dropped tail. The
  ratchet's ASSERTION is unchanged; only the shim's delivery of the oversized verdict was made
  reliable.
- **Verified:** 10/10 consecutive `verify:feat-062-loop` = 32/32, promptBytes now DETERMINISTIC at
  170546 (>150KB, comfortably). Did NOT weaken the ratchet: in a clean worktree at the pre-fixer-hop
  commit `66e092c^` (fixRound relays via positional argv, not `--prompt-stdin`), running the FIXED
  suite still must-FAILs the fixer-relay-hop check with `e2big=true` (spawn E2BIG) — the ratchet
  still proves the loop must go over stdin. typecheck clean, leak-gate PASS.

### 2026-08-12 — independent verification agent (in-place, did NOT build the fix)
- **Regenerated the builder's numbers from scratch (did not trust them):** ran
  `FEAT062_SKIP_REAL=1 npm run verify:feat-062-loop` TEN consecutive times → **10/10 = 32/32**, the
  FIXER RELAY HOP check PASS on every run, `promptBytes=170546` DETERMINISTIC on all ten (no 147059
  variant, no dropped sentinel). Confirms the flake is gone.
- **Re-proved the ratchet's teeth myself:** `git worktree add` at `66e092c^` (fixRound relays via
  positional argv, NOT `--prompt-stdin`), copied the CURRENT (fixed) suite in over the old
  `verify-fix-loop.mjs` → **31/32**, the FIXER RELAY HOP check FAILs with
  `exit=1 e2big=true viaStdin=undefined promptBytes=0` (spawn E2BIG at the fixer hop). The shim fix
  did NOT weaken the ratchet — it still forces the loop over stdin.
- **Adversarial (asked: could the synchronous shim write MASK a real relay truncation?):** NO, with
  evidence. The shim's `writeAll`/`fs.writeSync(1,…)` only guarantees the VERIFIER shim's stdout
  leaves whole. The ratchet assertion (`:585-589`) reads `fc[0].prompt`, and `fc[0]` comes from
  `fixerCalls()` (`:223`) which parses `fixer-calls.jsonl` written by the FIXER shim itself at
  `:167` — the FIXER records the prompt it ACTUALLY received (from argv or stdin, `usesStdin` flag).
  So the assertion reads the far end of the relay, not what the shim emitted. A genuine truncation
  anywhere between shim-stdout → loop → fixer-stdin would still drop the tail sentinel / <150KB and
  FAIL the check. Proven by the `66e092c^` argv-relay run above, where the fixer captured
  `promptBytes=0` and the check FAILed. The fix cures a real writer-side flush race; it does not
  paper over a relay defect.
- typecheck clean, leak-gate PASS. **Independently VERIFIED.**
