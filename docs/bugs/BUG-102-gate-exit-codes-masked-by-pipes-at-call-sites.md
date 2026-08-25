```orchard-ticket
{
  "id": "BUG-102",
  "type": "bug",
  "title": "Safety checks could fail while commits continued",
  "summary": "The sanctioned pre-commit command now preserves every safety-check failure and prints a readable summary without piping. Before this change, formatting a check through another command could hide its failure and allow a commit. Failure and success paths were exercised by exit status, and standing checks stayed clean.",
  "impact_if_we_wait": "A failed safety check could appear successful, allowing sensitive text or invalid changes into local commits. Bounded: the observed exposure remained local because nothing was pushed; this affected guard reliability, not repository history integrity or user data.",
  "current_need": "Treat the ticket as closed: masked calls continued incorrectly, sanctioned calls stopped correctly, and standing checks stayed clean.",
  "severity": "high",
  "area": "Pre-commit safety checks",
  "reported": "2026-08-14",
  "reported_by": "agent",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-15",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-14",
      "question": "How should safety checks prevent shell pipelines from hiding failures?",
      "mode": "single",
      "options_keys": [
        "A",
        "B",
        "C",
        "D"
      ],
      "chosen": "D",
      "chosen_on": "2026-08-15",
      "chosen_by": "agent",
      "note": "Chose one sanctioned Node wrapper, supplemented by readable direct summaries, never-pipe guidance, and empirical checks of pipefail and PIPESTATUS[0]."
    }
  ],
  "success_criteria": [
    "The sanctioned pre-commit command returns failure when any constituent check fails",
    "Known leaks cannot pass through the sanctioned entry point",
    "Direct leak failures remain readable without shell pipelines",
    "Clean repositories complete the sanctioned checks without false alarms",
    "Worker guidance directs callers to the sanctioned command and forbids piping it"
  ],
  "code_refs": [
    {
      "path": "scripts/gate.mjs",
      "symbol": null,
      "note": "Sanctioned wrapper uses spawnSync status checks without a shell pipeline."
    },
    {
      "path": "scripts/leak-gate.mjs",
      "symbol": null,
      "note": "Adds --summary and --quiet output modes for readable unpiped failures."
    },
    {
      "path": ".claude/agents/worker.md",
      "symbol": null,
      "note": "Directs workers to npm run gate and records the never-pipe rule."
    },
    {
      "path": "docs/bugs/BUG-102.md",
      "symbol": null,
      "note": "The committed exposure associated with fd04c1c was contained before anything was pushed."
    }
  ],
  "related": [
    {
      "id": "FEAT-085",
      "relation": "see_also"
    },
    {
      "id": "BUG-097",
      "relation": "see_also"
    },
    {
      "id": "BUG-096",
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
    "Migration and rollback": true,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-102-gate-exit-codes-masked-by-pipes-at-call-sites.md",
    "sha256": "4fd4e6f3670e37ff7ccf328d32a3c67f14b8ba6492bc36e7f7708e66807dbaec",
    "bytes": 10596,
    "original_title": "safety-gate exit codes are masked when call sites pipe them; a FAIL can pass silently",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the supplied original; the masking mechanism, two live failures, selected wrapper, output flags, guidance changes, bounds, and executed evidence are preserved.",
    "dropped": []
  }
}
```

# BUG-102 — Safety checks could fail while commits continued

## Diagnosis

The leak check itself returned the correct non-zero status. Callers lost that status when they piped its output into commands such as `tail`, because the shell reported the final command's status. Guards built around the pipeline could therefore continue after a real failure.

## Evidence

This happened twice on 2026-08-14. One piped failure printed `LEAK GATE: FAIL — 2 hit(s)` but returned success to the guard. Separately, a private home path and username entered commit `fd04c1c` and remained until an unpiped check found them; nothing was pushed.

The fixer exercised masked and sanctioned known-leak cases in both directions and asserted their exit statuses. `verify:gatekeeper` completed 31/31 successfully. `leak-gate` and `board:check` were reported clean. Pipefail and `PIPESTATUS[0]` propagation were also exercised empirically.

`verify:bug-080`, `verify:feat-075-screenshots`, and `verify:bug-080-mirror-images` were named in the record without execution results.

## Implementation notes

`scripts/gate.mjs` became the sanctioned pre-commit entry point. It invokes checks through pure Node `spawnSync` status handling, avoiding shell pipelines, and emits a short summary. The leak check gained `--summary` and `--quiet` modes so callers do not need output-filtering pipes. Worker guidance now points to `npm run gate` and states that it must never be piped.

## Verification plan

Use a fixture containing a known leak. Confirm that the historically masked pipeline allows its guard to continue, while the sanctioned entry point returns non-zero and stops. Assert exit statuses rather than output text. Then run the sanctioned command on a clean tree and exercise gatekeeper, board, documentation-freshness, type checking, and leak-check paths.

## Migration and rollback

Call sites and worker instructions migrate to the single sanctioned command. The output flags remain available for direct readable use. Rollback would restore the previous invocations, but it would also restore the status-masking hazard; retain the wrapper until every load-bearing caller has an equivalent direct status check.

## Risks

A wrapper that inspects output instead of process status could recreate the defect. Shell callers can also bypass the guarantee by invoking constituent checks through their own pipelines. Documentation and hooks must therefore keep the sanctioned entry point as the only supported guard.

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
