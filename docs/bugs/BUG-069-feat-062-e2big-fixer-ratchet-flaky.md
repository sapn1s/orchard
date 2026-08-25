```orchard-ticket
{
  "id": "BUG-069",
  "type": "bug",
  "title": "Oversized fixer relay check failed intermittently",
  "summary": "The oversized fixer relay check now produces consistent prompts and passes repeatedly. Previously, the verification harness sometimes captured a shorter prompt without its tail marker, causing intermittent failures even though the relay used standard input successfully.",
  "impact_if_we_wait": "Intermittent failures would weaken confidence in the loop regression suite and waste investigation time. Bounded: this affects tooling reliability, not production behavior, user data, or the fixer relay itself.",
  "current_need": "Treat the ticket as closed: the pre-fix case failed, corrected behavior passed repeatedly, and standing checks stayed clean.",
  "severity": "medium",
  "area": "Loop verification tooling",
  "reported": "2026-08-12",
  "reported_by": "hole-closer agent",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-12",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "The oversized fixer verdict consistently reaches the fixer through standard input",
    "The delivered prompt consistently contains the tail marker",
    "The regression case fails against the former argument-based relay",
    "Standing type and leak checks remain clean"
  ],
  "code_refs": [
    {
      "path": "scripts/verify-feat-062-loop.mjs",
      "symbol": null,
      "note": "Contains the oversized prompt fixture, tail marker, and fixer relay assertion"
    },
    {
      "path": "scripts/verify-fix-loop.mjs",
      "symbol": "verifyRound",
      "note": "Produces the verdict relayed verbatim to the fixer"
    },
    {
      "path": "scripts/verify-fix-loop.mjs",
      "symbol": "fixRound",
      "note": "Relays the fixer prompt through standard input"
    }
  ],
  "related": [
    {
      "id": "FEAT-061",
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
    "Migration and rollback": false,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-069-feat-062-e2big-fixer-ratchet-flaky.md",
    "sha256": "15e341212ad89f1ed2a590852b0f04d6fe1f8b4fe27acc5a12e7cf524de00ef8",
    "bytes": 8282,
    "original_title": "`verify:feat-062-loop` E2BIG-fixer-relay ratchet is flaky (~50% FAIL)",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the supplied ticket text; the symptom, diagnosis, clean-tree exclusion, relay guarantee, regression proof, executed evidence, and bounds remain represented.",
    "dropped": [
      "Repeated status evidence",
      "Shell formatting from the reproduction example",
      "Administrative filing context"
    ]
  }
}
```

# BUG-069 — Oversized fixer relay check failed intermittently

## Diagnosis

The intermittent failure came from the verification shim's stdout behavior, not from the loop's standard-input relay. Some runs captured a shorter first fixer prompt that omitted `E2BIG-FIXER-TAIL-SENTINEL-4423`, while `exit=0`, `e2big=false`, and `viaStdin=true` remained unchanged. The adjacent FEAT-061 change was excluded by reproducing the fault on a clean tree.

## Evidence

`verify:feat-062-loop` completed 32/32 checks across 10 consecutive runs. `promptBytes` remained deterministic at 170546, and the fixer relay hop passed every time. Before correction, the flake reproduced in 3 of 8 runs and prompt sizes varied, including a drop to 147059 that lost the sentinel. The former argument-based relay at `66e092c^` produced 31/32 with `e2big=true`, preserving the ratchet's failure proof. Typecheck and leak-gate were reported clean. Additional matched tallies of 10/10 and 12/12 were recorded without adjacent suite names.

## Implementation notes

Keep the fixer-relay assertion tied to the oversized verdict carrying the tail marker. Preserve verbatim delivery through `--prompt-stdin`; the relay path itself was not the source of the intermittent result.

## Verification plan

Run `verify:feat-062-loop` repeatedly in deterministic-debug mode and confirm stable prompt size, all 32 checks passing, and the tail marker reaching the fixer. Run the same ratchet against the former argument-based relay and require its E2BIG failure. Keep typecheck and leak-gate clean. `verify:fix-loop` and `verify:independent-verification` were named without recorded results.

## Risks

Changes to shim output or fixer-call capture order could reintroduce a false failure by selecting a prompt that does not contain the oversized first-round verdict.

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
