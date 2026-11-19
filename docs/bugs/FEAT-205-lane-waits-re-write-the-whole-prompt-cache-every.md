```orchard-ticket
{
  "id": "FEAT-205",
  "type": "feature",
  "title": "Lane waits re-write the whole prompt cache every ten minutes",
  "summary": "Dispatched lanes wait on background work with ten-minute blocking calls, longer than their five-minute prompt cache. Each wait re-writes about 200k tokens of context: 299 times in 30 days, costing $375. The Working Agreement and the park-guard refusal both prescribe the wait. Shortening each wait to 240 seconds keeps the cache warm.",
  "impact_if_we_wait": "About $210 to $290 of lane spend per 30 days keeps going to re-writing unchanged context.",
  "current_need": "Change the wait text in the canonical Working Agreement and park-guard, sync the mirror, then re-measure after a week.",
  "severity": "medium",
  "area": "lanes/cost",
  "reported": "2026-11-19",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-11-19",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Wait-shaped lane cache re-writes cost at most $40 per 30 days",
    "No wait instruction in src or the Working Agreement blocks longer than 240 seconds"
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "openai",
      "model": "codex-default",
      "run_id": "01a1f171-0517-7323-9a2d-0f04f9a7699d",
      "verdict": "invalid",
      "verdict_on": "2026-11-19",
      "recorded_at": "2026-11-19T01:38:40.613Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "8f90f242e6de99e4a08858b3004e0f33a2b96280a213ac572570ece6d8aa788f",
      "verify_mode": "mixed-state",
      "note": "Clean-room strips .claude/ (ambient), so the guard's worker.md emitter is always MISSING there -> BROKEN is a tool artifact, not a defect. Real-tree self-run: all 4 emitters use timeout 240 only; guard passes; must-FAIL holds; no other active emitter >240s. Claim holds in reality. See activity log."
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a1f188-bde6-7e51-bae6-d539379a9a1a",
      "verdict": "holds",
      "verdict_on": "2026-11-19",
      "recorded_at": "2026-11-19T02:01:43.470Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "afe5ab673cec36465eee8dcf278a6cc3f1d449329caa9c7f16798be5baa891ee",
      "verify_mode": "mixed-state"
    }
  ],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": false,
    "Evidence": false,
    "Implementation notes": false,
    "Verification plan": false,
    "Migration and rollback": false,
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": null,
    "sha256": null,
    "original_title": null,
    "migrated_on": null,
    "migrated_by": null,
    "confirmation": "Authored directly in the record format through scripts/board-tool.mjs. There is no legacy original.",
    "dropped": []
  }
}
```

# FEAT-205 — Lane waits re-write the whole prompt cache every ten minutes

Plan source: `~/.local/state/claude-station/scratch/orchestration-cost-2026-11-19/PLAN.md` (orchestration-cost planner lane, 2026-11-19). Measurement scripts are in that directory's `plan/`.

## Plan

### A — lanes use a 5-minute cache, and waits over 300 s cause the full re-writes: HOLDS

- Cache TTL, from `usage.cache_creation` in the window:
  - lanes: 102.1M tokens written at 5m, **0** at 1h, 0 lane files with any 1h write;
  - orchestrator: **0** at 5m, 21.2M at 1h, all 50 sessions 1h.
- The 5-minute boundary is sharp. Lane requests with ≥20k context, by gap to the previous request,
  share that re-wrote the prefix (cache read < 30% of context):

  | gap | n | full re-write |
  |---|---:|---:|
  | 180–240 s | 48 | 0% |
  | 240–300 s | 47 | 0% |
  | 300–320 s | 14 | 7% |
  | 320–360 s | 31 | 94% |
  | 360–600 s | 202 | 99% |
  | 600–3600 s | 70 | 99% |

- 299 full re-writes after 5–60 min gaps cost **$375**. The tool call before the gap:
  201 are wait idioms (`timeout 580/590/560 tail|sleep`, `until/while pgrep … sleep`, `for i in
  $(seq …) … sleep`) = $253; 85 are long foreground runs (test suites, `independent-verify.mjs`
  run in the foreground) = $100; the rest are model or permission time.
- The idiom has exactly two emitters: canonical WA `~/projects/methodology/WORKING_AGREEMENT.v4.md`
  lines 436–438 (mirrored to `docs/prompts/WORKING_AGREEMENT.v4.md`) and the refusal text in
  `src/server/park-guard.ts:241`. (`scripts/fixtures/bug-239/round1/park-guard.ts` is a frozen
  must-FAIL fixture and must not change.)
- Side finding: the CLI can set a lane TTL (`subagentPromptCacheTtl` setting,
  `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`, agent frontmatter `experimental.cacheTtl`). A 1h lane
  TTL saves about $190, against about $290 for short waits, because it doubles every lane write.
  Rejected.


## 2. Lever A — lane waits shorter than the 5-minute cache

- **Class:** fix. **Harm class:** docs/copy (instruction text and a refusal string), zero
  independent rounds per §I. It is user-visible lane behaviour, so it carries a measured canary.
- **Changes:**
  1. `~/projects/methodology/WORKING_AGREEMENT.v4.md` §I ("When you have nothing to overlap, WAIT
     IN THE FOREGROUND"). Replace `timeout 580 tail --pid=<PID> -f /dev/null; true` and the
     repeated `timeout 300 tail -f /dev/null; true` with **`timeout 240 …; true`, repeated**. Add
     one sentence: "No single foreground call may block longer than 240 s: a lane's prompt cache
     lives 5 minutes, so a longer block re-writes your whole context (measured: 299 re-writes,
     $375 in 30 days). Run anything longer (a suite, `independent-verify.mjs`) in the background
     and wait on it in 240 s chunks; hand-rolled `until … sleep` loops obey the same cap." Add a
     CHANGELOG entry in the methodology repo. Then run `npm run sync:methodology` in Orchard so
     `docs/prompts/WORKING_AGREEMENT.v4.md` follows. Caution: the methodology tree already has
     uncommitted edits to WA v4 (+96 lines); edit in place and do not revert them.
  2. `src/server/park-guard.ts:241` (`blockReason`): the same substitution in the refusal text
     (`timeout 240 tail -f /dev/null; true`, `timeout 240 tail --pid=<PID> -f /dev/null; true`) and
     "Repeat until …" kept.
  3. Do NOT touch `scripts/fixtures/bug-239/round1/park-guard.ts` (frozen old code for a must-FAIL).
- **Proof that nothing broke:** `npm run verify:bug-239-bound-hangs` (park-guard decisions and
  reason text), `npm run verify:wa-injected`, `npm run gate`. Must-FAIL check:
  `rg -n 'timeout (5[0-9]0|300) ' src docs/prompts ~/projects/methodology/WORKING_AGREEMENT.v4.md`
  returns nothing after (5 lines before: 2 canonical WA, 2 mirror, 1 park-guard).
- **Proof the saving is real:** re-run `plan/ttl.py` and `plan/gap.py` over ≥7 days after landing,
  scaled to 30 days. Before: 201 wait-shaped re-writes = $253; all 5–60 min lane re-writes = $375.
  **Pass:** wait-shaped re-writes ≤ $40/30d and all 5–60 min re-writes ≤ $150/30d.
- **Risk / failure metric:** lanes keep the old habit from memory or old charters (watch: share of
  lane `Bash` calls with an inner `timeout` > 280 s). Polling adds requests, modelled at $42/30d of
  reads. It failed if the wait-shaped re-write $ does not fall by ≥ 70%.
- **Expected:** ~$210/30d for waits alone; ~$290/30d if long foreground runs are moved to
  background + chunked waits too.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-11-19 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-11-19 — agent (fixing, round 1)
- **Hypothesis check (FIRST), premise CONFIRMED and plan corrected.** The plan's "exactly two
  emitters" is WRONG. `rg -n 'timeout 5[0-9]0|tail --pid|timeout 300'` across the orchard repo,
  `~/.claude/agents`, and `~/projects/methodology` found **four** ACTIVE emitters of the 580/300 s
  wait idiom, not two: (1) canonical WA `~/projects/methodology/WORKING_AGREEMENT.v4.md:437-438`;
  (2) mirror `docs/prompts/WORKING_AGREEMENT.v4.md:437-438` (synced from canonical); (3)
  `src/server/park-guard.ts:241` (SubagentStop refusal); (4) **`.claude/agents/worker.md:23-25`**
  — the worker standing rules injected into every worker lane, the agent type the companion ticket
  FEAT-206 shows carries ~100% of over-200k lane spend. The OpenAI pre-build review flagged exactly
  this: the plan's proposed `rg` scan excluded `.claude`, so it would have passed while workers kept
  the old instruction. `scripts/fixtures/bug-239/round1/park-guard.ts:238` is the frozen BUG-239
  must-FAIL fixture and was left unchanged. Historical ticket records (BUG-239 body, CHANGELOG old
  entries) are append-only records, not active instruction, and were left unchanged.
- **Change (wait-duration guidance only; interleave/don't-park policy untouched):** replaced the
  `timeout 580 tail --pid=<PID> …; true` / repeated `timeout 300 tail -f /dev/null; true` idiom with
  `timeout 240 …; true`, repeated, in all FOUR active emitters, and added one sentence to each: no
  single foreground wait may block longer than 240 s (5-minute cache), run anything longer in the
  background and wait in 240 s chunks; hand-rolled `until … sleep` loops obey the same cap. Canonical
  WA edited in `~/projects/methodology`, then `npm run sync:methodology` (output: `synced
  docs/prompts/WORKING_AGREEMENT.v4.md`). Added a 2026-11-19 methodology CHANGELOG entry.
- **Files:** `~/projects/methodology/WORKING_AGREEMENT.v4.md`, `~/projects/methodology/CHANGELOG.md`
  (repo: methodology); `docs/prompts/WORKING_AGREEMENT.v4.md` (synced), `src/server/park-guard.ts`,
  `.claude/agents/worker.md`, `scripts/verify-feat-205-wait-cap.mjs` (new), `package.json`
  (`verify:feat-205-wait-cap` script) (repo: orchard).
- **Must-FAIL check (new):** `scripts/verify-feat-205-wait-cap.mjs` scans every active emitter
  (incl. the `.claude` path) and flags any `timeout/sleep <N>` with 240 < N < 10000; frozen fixture
  excluded by name. Non-vacuity is anchored to a SYNTHESIZED pre-change snippet (not HEAD): it must
  flag the old 580/300/560/590 idioms. Proven against the REAL pre-change state too: scanning the
  pre-edit snapshots of all four emitters reddens (flags 580 & 300); scanning current passes.
  `node scripts/verify-feat-205-wait-cap.mjs` → `all checks passed` (exit 0).
- **Anti-regression:** `npm run verify:wa-injected` → `PASS — 10 passed, 0 failed`.
  `verify:bug-239-bound-hangs` (park-guard anti-regression): the full suite runs 4 live-server arms
  × up to 3 retry attempts with 40-60 s real-time approval-deadline sleeps and did not finish inside
  ~40 min; it was stopped by its own process group (pre-existing unrelated servers untouched). Ran
  its `--fast` logic arms instead — `pureArms` (P1-P8 decideSubagentStop + P7 refusal/expiry text
  generation) + `roundTwoArms` (R1/R2 ledger) → **31/31 passed** (exit 0). The edit is purely to the
  refusal STRING's wait idiom, not decision logic or hook timing (P7 regenerates and asserts the
  refusal text and does not assert the wait idiom), so the skipped live-server timing arms cannot be
  affected by it.
- **Gate:** `npm run gate` → `GATE: PASS — safe to commit. (exit 0)`.
- **Not done here (deferred to the measured canary, per plan §2):** the $ savings proof
  (`plan/ttl.py`/`plan/gap.py` after ≥7 days) and the OpenAI review's behavioural lifecycle /
  cache-reuse tests (run a child >580 s, confirm chunked waits keep it alive + require result
  consumption; capture request timestamps vs cache usage). These need live lanes over days and are
  the ticket's existing post-landing canary, not a pre-land check.

### 2026-11-19 — dispatch openai
- **Verification recorded:** dispatch openai/codex-default run 01a1f171-0517-7323-9a2d-0f04f9a7699d — VERDICT: INVALID — mixed-state candidate 8f90f242e6de — Clean-room strips .claude/ (ambient), so the guard's worker.md emitter is always MISSING there -> BROKEN is a tool artifact, not a defect. Real-tree self-run: all 4 emitters use timeout 240 only; guard passes; must-FAIL holds; no other active emitter >240s. Claim holds in reality. See activity log.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-11-19 — agent (fixing, round 2)
- **Hypothesis CONFIRMED first (deliverable is correct; this was a guard-design defect, not a
  deliverable defect).** On the real tree all four active emitters cap the foreground wait at
  `timeout 240`: `rg -n 'timeout (3[0-9][0-9]|[4-9][0-9][0-9])|timeout [0-9]+[smh]'` over
  park-guard.ts, both WAs and `.claude/agents/worker.md` returns nothing (exit 1); the guard passes
  (`node scripts/verify-feat-205-wait-cap.mjs` → exit 0). The round-1 INVALID (run 01a1f171) had two
  real causes, both in the GUARD, which this round fixes. No emitter was uncapped, so I did not stop.
- **Fix 1 — clean-room verifiability without weakening the real-tree scan.** `independent-verify.mjs`
  strips the whole `.claude/` ambient root from every clean room UNCONDITIONALLY (AMBIENT_DIR_NAMES;
  matched at any depth, independent-verify.mjs:425,588), and it explicitly REFUSES to re-admit an
  ambient path as `--allow-input` (dies at independent-verify.mjs:1265). So the two options the
  charter named are both unavailable by design: I did NOT copy worker.md's wait rule to a non-stripped
  path (a second home for one fact — ARCH-010 forbids it), and the harness cannot be told to include
  it. **Structural choice: the guard RECOGNISES the strip.** worker.md now carries an `ambientRoot`
  (`.claude`): if the file is absent AND the whole ambient root is gone → explicit `skip` line + a
  summary caveat, exit 0 (expected in a clean room); if the ambient root is PRESENT but worker.md is
  missing → `FAIL` (a real deletion, never vacuous); if present → scanned as before. Non-vacuity does
  NOT depend on worker.md — Part A reddens against synthesized text regardless — so a clean-room run
  still proves the scanner works and the three non-ambient emitters are clean, and worker.md is
  verified on the real tree where this guard is the project gate. Stripping behaviour unchanged.
- **Fix 2 — proper duration parsing (the four holes run 01a1f171 found).** Replaced the bare-integer
  regex with a tokenizing scanner + `parseDuration`: handles s/m/h/d suffixes (`timeout 300s`,
  `timeout 5m`, `timeout 1h`), walks past `timeout` options before the operand (`--signal=TERM`,
  `--signal TERM`, `-s TERM`, `-sTERM`, `-k 10`, `--kill-after`, bare flags like `--foreground`),
  tolerates hugging markdown/shell punctuation (a `timeout 300\`` closing a code span still reads
  300), and keeps the bare-`>=10000` exemption for the Bash tool's own `timeout 600000` ms ceiling
  (a SUFFIXED value is never exempt). New Part A2 "duration forms" check: 10 synthesized over-cap
  forms must all flag, 5 at/under-cap forms (incl. `4m`==240, `240s`, the bare ms ceiling) must not.
- **Files:** `scripts/verify-feat-205-wait-cap.mjs` (guard only — ONE file; no emitter changed, so the
  round-1 cap edits are untouched).
- **Proof — real tree:** `node scripts/verify-feat-205-wait-cap.mjs` →
  `all checks passed (all emitters scanned)` (exit 0); the two new lines read
  `must-FAIL proof: scanner flags 5 pre-change waits` and
  `duration forms: flags all 10 over-cap forms …, none of 5 at/under-cap`.
- **Proof — clean-room + tamper scenarios** (literal scratch copy of the four real files, under the
  claude-station scratch root; worker.md synthesized — no real clean room was dispatched):
  (1) NO `.claude` (the exact ambient-strip the clean room produces) →
  `skip worker agent standing rules: absent here — .claude/ is ambient-stripped …` + exit 0 (this
  removes the round-1 `MISSING` FAIL that caused the INVALID); (2) `.claude/` present but worker.md
  deleted → `FAIL … MISSING … (cannot pass vacuously)` exit 1; (3) worker.md present carrying
  `timeout 600 …` and `timeout 5m …` → `FAIL … 2 wait(s) over 240 s` (600 s and the 5m==300 s
  suffix both caught) exit 1.
- **Anti-regression + gate:** `npm run verify:wa-injected` → `PASS — 10 passed, 0 failed`;
  `npm run gate` → `GATE: PASS — safe to commit. (exit 0)`; `npm run board:check` → the only FAILs are
  pre-existing UNREACHABLE-TICKET drift on BUG-240 and FEAT-170 (unrelated to FEAT-205; no new drift).
- **Recommended next:** re-run the independent verify (`scripts/independent-verify.mjs --ticket
  FEAT-205`) — the clean room will now `skip` worker.md gracefully instead of erroring MISSING. This
  is a regression-prone guard file, so an independent clean-room pass is warranted before HOLDS.

### 2026-11-19 — dispatch openai
- **Verification recorded:** dispatch openai run 01a1f188-bde6-7e51-bae6-d539379a9a1a — VERDICT: HOLDS — mixed-state candidate afe5ab673cec. Typed entry in the record's verification[]; this line is an echo, not proof.
