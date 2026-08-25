# BUG-102 — safety-gate exit codes are masked when call sites pipe them; a FAIL can pass silently

- **Status:** VERIFIED (2026-08-15) — sanctioned wrapper `npm run gate` (scripts/gate.mjs) makes exit-status masking impossible at the pre-commit entry point (pure-node spawnSync status checks, no shell pipe, short self-summary so nobody pipes it); `--summary`/`--quiet` added to leak-gate.mjs so a direct FAIL is readable unpiped; worker.md guidance repointed to `npm run gate` with the never-pipe rule. Masked-vs-sanctioned must-FAIL proven BY EXIT STATUS both directions; pipefail + PIPESTATUS[0] propagation verified empirically.
- **Area:** every call site of `scripts/leak-gate.mjs` (and any other gate: board:check, docs:fresh, typecheck) — npm scripts, `scripts/gatekeeper.mjs`, hooks, worker charters, docs
- **Reported:** 2026-08-14 (found by the worker that scrubbed the FEAT-085 leak; the failure had already occurred live)

## Problem
The leak gate is sound: asked directly, it reports correctly and exits non-zero on failure. The hole is in
**when and how it is asked.**

A shell pipeline's exit status is the LAST command's, not the gate's. So:
```sh
node scripts/leak-gate.mjs 2>&1 | tail -1   # exit status = tail's = 0, ALWAYS
```
Any caller that guards on this — `gate && git commit`, a hook, a CI step — proceeds as if the gate passed,
**even on FAIL**.

**This already happened, twice, in one session:**
1. The orchestrator ran the gate piped into `tail -1` before a commit. The gate printed
   `LEAK GATE: FAIL — 2 hit(s)`, the pipeline exited 0, and the commit proceeded. (That commit turned out
   clean — the flagged file was an untracked scratch file — but the guard did not hold; it was luck.)
2. A private home path + username reached a committed ticket (`fd04c1c`) and sat there until the gate was
   next run unpiped. Contained only because nothing is pushed.

A gate that can be silently bypassed by a formatting habit is not a gate.

## Wanted
1. **Audit every call site** of `scripts/leak-gate.mjs` — npm scripts in package.json, `scripts/gatekeeper.mjs`,
   any hook under `scripts/hooks/`, verify scripts, worker charters and docs that instruct how to run it.
   Identify every one where the exit status can be masked (piped into `tail`/`head`/`grep`, inside a
   subshell, in a `$(...)` capture whose status is discarded, or `&&`-chained after a pipeline).
2. **Make masking impossible or loud.** Options to weigh and justify:
   - `set -o pipefail` in any shell wrapper (note: does not help `| tail` where tail succeeds — pipefail
     only propagates a FAILING pipeline member, which IS the gate here, so it does help; verify empirically).
   - Prefer `PIPESTATUS[0]` / capture-then-check patterns over pipes at guard sites.
   - Better: give the gate a `--quiet` / summary flag so callers never need to pipe it for readability.
   - Best: a single wrapper (e.g. `npm run gate`) that is THE sanctioned way to invoke it and cannot be
     mis-invoked; then make the docs/charters point only at that.
3. **Apply the same audit to the other gates** — `board:check`, `docs:fresh`, `typecheck`, the verify
   suites — anywhere a non-zero exit is load-bearing.
4. **Update the worker-charter guidance** (`.claude/agents/worker.md` and the standard charter language) so
   the sanctioned invocation is the one that cannot mask status.

## Verification (§C)
- Reproduce the bypass: a fixture with a known leak, invoked the masked way → the wrapper/guard proceeds
  (must-FAIL, this is the current behaviour); invoked the sanctioned way → it stops.
- After the fix: the same masked invocation either fails correctly or is impossible to express at the
  sanctioned entry point. Assert on the exit status, not on printed text.
- Assert the gate still passes normally on a clean tree (no false alarms).
- Anti-regress: gatekeeper, board:check, docs:fresh, typecheck, leak-gate itself.
- **Risk bucket:** verification-tooling integrity. A wrong fix here makes a safety gate look green while it
  is not — the same class as BUG-096 (fabricated ledger records) and BUG-097 (verdicts discarded on format).

## Activity log (APPEND-ONLY)
### 2026-08-14 — orchestrator
- Filed from the leak-scrub worker's upward flag. Notable that the gate itself needed no change: it caught
  the leak the moment it was asked properly. The defect is that callers can ask it in a way that discards
  its answer — and the orchestrator did exactly that earlier the same day.

### 2026-08-15 — worker (BUG-102 fix)
**Risk bucket:** verification-tooling integrity (safety-gate looks green while it is not — same class as
BUG-096/097). Flagging that an independent clean-room verify pass is warranted before this is relied on;
generation should not be its own only verifier here.

**Call-site inventory — where a gate's exit status CAN be masked.**
Audited every invocation of leak-gate + the load-bearing gates across package.json, scripts/gatekeeper.mjs,
scripts/publish-public-mirror.sh, scripts/hooks/*, the verify suites, `.claude/agents/worker.md`, and the
docs/charters. Findings:
- **In committed CODE: ZERO masked call sites.** Every programmatic caller already consumes the exit STATUS,
  not piped text:
  - `scripts/gatekeeper.mjs` mechanicalSteps() — `spawnSync(...).status === 0` (leak-gate + typecheck). Safe.
  - `scripts/publish-public-mirror.sh` — `if node "$LEAK_GATE" "$TREE_DIR"; then …`, plus `set -euo pipefail`
    at the top. Safe.
  - `scripts/gatekeeper.mjs` installed pre-push hook — `node "$SELF" … || status=1` (no pipe). Safe.
  - the verify suites (verify-gatekeeper, verify-bug-080, verify-feat-075-screenshots) — spawnSync status
    checks. Safe.
  - `scripts/hooks/response-format-gate.mjs` — a Stop-hook, does not invoke leak-gate/board/typecheck. N/A.
- **The masked call site is the HUMAN/AGENT invocation habit** — exactly the live incidents in the ticket:
  `node scripts/leak-gate.mjs 2>&1 | tail -1` at a terminal, and any `gate | tail && git commit` guard an
  agent types by hand. This is unfixable by patching one script because the masking is in the *ad-hoc shell
  pipe*, not in any file. The worker charter's old wording ("leak-gate must PASS before any commit") tacitly
  invited it: the FAIL output is long, so a human pipes it to `tail` to read it — and that pipe drops the
  status. A rule that depends on remembering not to pipe is exactly what failed.

**Design chosen (and why).** Make the READABLE invocation and the CORRECT-EXIT invocation the SAME
invocation, at a single sanctioned entry point:
- **`npm run gate` → `scripts/gate.mjs`** (new): the pre-commit safety gate. Runs leak-gate (REPO mode) +
  typecheck — the same deterministic fail-closed pair the FEAT-050 gatekeeper runs — via `spawnSync().status`
  (no shell pipe anywhere), prints its OWN one-line-per-gate summary, and exits with the true aggregate
  status. Masking is impossible here BY CONSTRUCTION: there is no pipe to mask, and the output is already
  short so nobody needs to pipe it for readability.
- **`--summary`/`--quiet` on leak-gate.mjs**: opt-in compact FAIL output (capped hit list + summary line)
  so a direct `node scripts/leak-gate.mjs --summary` is readable UNPIPED. Default output is byte-for-byte
  unchanged (verify-gatekeeper greps the verbatim `notes.md:1: [home path]` line — 31/31 still PASS), so
  gatekeeper.mjs and the verify suites are untouched.
- **worker.md** repointed: "Before any commit, run `npm run gate` and read its EXIT STATUS directly" +
  explicit never-pipe rule naming BUG-102.
Rejected: relying on `set -o pipefail` everywhere (depends on every author remembering it — same failure
mode as "don't pipe"). pipefail/PIPESTATUS are documented as the fallback for a forced pipe, not the primary.

**Empirical pipefail / PIPESTATUS finding (the ticket flagged this as needing proof, not assumption).**
With a known-leak fixture, `node scripts/leak-gate.mjs` returning exit 1:
- `node scripts/leak-gate.mjs 2>&1 | tail -1` → exit **0** (the bug; tail succeeds and masks it).
- `bash -c 'set -o pipefail; node scripts/leak-gate.mjs 2>&1 | tail -1'` → exit **1**. pipefail DOES
  propagate — confirmed: the gate is the FAILING pipeline member, which is exactly what pipefail surfaces.
- `node scripts/leak-gate.mjs 2>&1 | tail -1; echo ${PIPESTATUS[0]}` → **1**. PIPESTATUS[0] also captures
  the gate's true status. Both fallbacks work; the point of `npm run gate` is you never need them.

**Must-FAIL proof — asserted on EXIT STATUS, never on printed text.**
Fixture: untracked scratch file `__leak_fixture_bug102.txt` containing the private home-path token
`/home/` + the username (written split here so this ticket does not itself trip the gate — it matches both
the [home path] and [username] token classes); `git check-ignore` confirmed NOT ignored, so
`git ls-files -co` picks it up (faithful REPO
mode). NEVER committed; deleted after.
- MASKED pattern (reproduces the live bug): `node scripts/leak-gate.mjs 2>&1 | tail -1` → exit **0**; the
  guard `if <that>; then echo GUARD PROCEEDED` printed **GUARD PROCEEDED → git commit would run**. Bug
  reproduced.
- SANCTIONED entry point WITH the leak present: `npm run gate` → exit **1**; `npm run gate && git commit`
  → GUARD STOPPED, commit blocked. Correct.
- Fixture removed → `npm run gate` on the clean tree → exit **0** ("GATE: PASS — safe to commit"). No false
  alarm.

**Anti-regress (through the new/unchanged entry points).**
- `npm run gate` clean tree → exit 0.
- verify-gatekeeper **31 PASS / 0 FAIL** (default leak-gate output verbatim — the hit-line grep intact).
- verify-feat-075-screenshots exit 0 (leak-gate consumer).
- verify-bug-080-mirror-images leak-gate TREE-mode sections A/B/C all PASS. Its one [D] failure
  ("excluded-image count >0") is PRE-EXISTING and out of lane: this fresh-history repo tracks 0
  non-allowlisted images, so the publish-mirror has nothing to exclude — nothing to do with this change
  (my diff touches only leak-gate output formatting/flag parsing, the new gate.mjs, and package.json).
- `npm run board:check` exit 0; `npm run docs:fresh` exit 0; `npm run typecheck` exit 0.
- `node --check` clean on gate.mjs + leak-gate.mjs.

**Lane honored.** Only package.json (one script line), scripts/leak-gate.mjs (output/flag), new
scripts/gate.mjs, `.claude/agents/worker.md`, and this ticket. Did not touch public/styles.css.
Final leak-gate checked UNPIPED (exit 0) before staging. Foreground Bash only; no push/restart/deploy.
