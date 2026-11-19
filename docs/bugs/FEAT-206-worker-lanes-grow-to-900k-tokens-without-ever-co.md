```orchard-ticket
{
  "id": "FEAT-206",
  "type": "feature",
  "title": "Worker lanes grow to 900k tokens without ever compacting",
  "summary": "Worker lanes run with a one-million-token window, so nothing compacts before about 1M. Requests above 200k cost $1,038 in 30 days, 47% of lane spend; one lane alone cost $174. The CLI accepts a per-agent compaction window, and one line in the worker definition would compact lanes at 200k.",
  "impact_if_we_wait": "Roughly $200 to $330 per 30 days of lane spend keeps going to re-reading stale context.",
  "current_need": "Prove a sub-agent compacts at its configured window in a scratch probe, add the line to the worker definition, then watch verify outcomes for 14 days.",
  "severity": "medium",
  "area": "lanes/cost",
  "reported": "2026-11-19",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-11-19",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Worker lane spend above 200k context falls to at most 10% of lane spend",
    "First-pass HOLDS rate of tickets whose lanes compacted is no worse than the rest"
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": "claude-opus-4-8",
      "run_id": "38471cd4-1871-4223-9f50-d610b27dd288",
      "verdict": "holds",
      "verdict_on": "2026-11-19",
      "recorded_at": "2026-11-19T03:32:17.775Z",
      "author": "verify lane (round 1)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "verified, awaiting user switch. Clean-room (openai) BROKEN spurious: strips .claude + ran pre-restart 2.1.281 not 2.1.328. Decisive: real 0.3.328 install, fixer 42/0 on 2.1.328 (compaction 192034; cancel/resume/agent_id PASS) + own mid-tool-cancel attack: tool killed exit137, AbortError, no hang."
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

# FEAT-206 — Worker lanes grow to 900k tokens without ever compacting

Plan source: `~/.local/state/claude-station/scratch/orchestration-cost-2026-11-19/PLAN.md` (orchestration-cost planner lane, 2026-11-19). Measurement scripts are in that directory's `plan/`.

## Plan

### C — a real mechanism exists to cap lane context: HOLDS (stronger than assumed)

- CLI 2.1.327 agent files accept **`autoCompactWindow: <integer ≥ 100000>`** in frontmatter
  (validated in the agent loader; "Must be an integer of at least 100000"). Sub-agent
  auto-compaction is real: worker lane `4ea3d0d2…/agent-a6e9eda355583394b` (ARCH-022) compacted
  automatically on 2026-10-02 at 970,637 tokens and ran 420 more records to a coherent end.
- The 914k lane was a 1M-context choice: every compaction on record fires at ~1.0M (`preTokens`
  996k–1,010k), so the worker's model (`claude-opus-4-8`, pinned in `.claude/agents/worker.md`)
  runs with a 1M window and nothing compacts before ~1M.
- **100% of the over-200k lane spend is `worker` lanes:** worker 278 lanes, $2,183, $1,038 above
  200k, 63 lanes over 200k; every other agent type together is $26 and never passed 200k. One
  frontmatter line in `.claude/agents/worker.md` covers all of it.
- Side finding for the user: `~/.claude/settings.json` has a top-level key
  `"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "200000"` (set 2026-11-03). It does nothing: it is neither
  under `"env"` nor the real setting name `autoCompactWindow`. The CLI ignores unknown top-level
  keys, and no session in the window compacted below ~1M. This is the user's machine config, so it
  is reported and not changed. Fixing it would also cap the orchestrator at 200k, which is the
  user's call.


## 3. Lever C — compact worker lanes at 200k

- **Class:** fix (one config line), run as a measured pilot. **Harm class:** reversible config.
  A wrong result is degraded lane work, which the independent verify gate is there to catch;
  rollback is deleting one line.
- **Changes:**
  0. **Feasibility probe first (stop if it fails):** in a scratch project (`scripts/lib/scratch.mjs`,
     not `/tmp`), add `.claude/agents/probe.md` with `autoCompactWindow: 100000` and the worker
     model. Spawn it via `claude -p` and have it Read large files past 100k. Assert its subagent
     transcript has a `compact_boundary` with `preTokens` ≈ 100k and that it then finishes its task.
     Also record whether a global `autoCompactWindow` setting would override the frontmatter
     (needed for the user's settings finding above).
  1. `.claude/agents/worker.md` frontmatter: add `autoCompactWindow: 200000` below `model:`.
  2. `.claude/agents/worker.md` body: one bullet saying "If your context is compacted, re-read
     your ticket's Activity log and your charter's Dispatch line before continuing. The ticket,
     not your memory, is the state." The board is already the durable memory, so this re-points
     the lane at it.
- **Proof that nothing broke:** `node scripts/verify-arch-016.mjs` (parses worker.md; its B1
  contract must still be found), `npm run gate`, the probe above.
- **Proof the saving is real:** after ≥14 days, re-run `plan/lanes.py`. Before: worker $ at
  >200k context = $1,038 (47% of lane $), 0 compactions below 900k. **Pass:** >200k share ≤ 10%,
  compactions cluster at ~200k, lane $/request at the 100–200k bin unchanged.
- **Risk / failure metric:** the summary drops a constraint or the files in play. The lane then
  re-reads them (eating the saving) or makes a wrong change. Failure metrics, from typed
  `verification[]` on tickets whose lanes compacted vs those that did not: first-pass HOLDS rate
  falls, or fix lanes per ticket rise. Also, post-compaction Read/Bash-output tokens within
  20 requests exceed ~60k per compaction (rediscovery). If any trips, raise to 300k (modelled
  $262 standalone, 27 compactions) before reverting.
- **Expected:** ~$330/30d after A (upper bound); planning figure $200–330.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-11-19 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-11-19 — agent (fixing, round 1) — NOT SHIPPED: setting has no effect on the real worker launch path
- **Verdict: DO NOT SHIP.** The probe gate fails at its prerequisite. `autoCompactWindow:
  200000` in `.claude/agents/worker.md` frontmatter would be **dead config** on the real worker
  launch path, so the line was NOT added. No frontmatter was changed for this ticket (worker.md's
  only edit today is FEAT-205's wait-cap sentence).
- **Why — the REAL worker launch path runs CLI 2.1.281, not the 2.1.327 the plan validated.**
  Ground truth, not inference: this very lane is a `worker` subagent; its live process
  (`/proc/<pid>/exe`) is
  `node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`, the **SDK-bundled CLI 2.1.281**
  (the binary's max version string; corroborated by `scripts/fixtures/bug-159/real-cli-2.1.281-contract.json`).
  Orchard launches a worker as an in-process Agent-tool subagent of the orchestrator's `query()`.
  For a `direct` (host) project — orchard is `isolation: "direct"` in the registry —
  `ClaudeRuntime` sets `pathToClaudeCodeExecutable` ONLY in the container/openai branches
  (`src/server/agent-bridge.ts:1848`, `CONTAINER_CLAUDE_BIN`) or from `CLAUDE_STATION_CLAUDE_BIN`
  (unset). The host branch leaves it undefined, so the SDK (`@anthropic-ai/claude-agent-sdk@0.3.281`)
  spawns its **bundled** 2.1.281 binary. The 2.1.327/2.1.328 CLI on PATH
  (`~/.local/bin/claude` → `~/.local/share/claude/versions/2.1.328`) is NOT what host lanes run.
- **The bundled 2.1.281 binary does not support per-agent `autoCompactWindow`.** Observed numbers:
  - `rg -ac 'at least 100000|auto.{0,6}for the window tuned'` on the bundled binary → **0**; on the
    PATH 2.1.327 binary → present (`"...compact window for this model, in tokens (at least 100000),
    or \"auto\" for the window tuned for th..."`). This is the frontmatter-window feature the plan's
    hypothesis C quoted ("Must be an integer of at least 100000"); it exists ONLY in 2.1.327+.
  - In 2.1.281 the agent-frontmatter schema cluster (`whenToUse`/`tools`/`model`/
    `disableModelInvocation`/…) contains **no** `autoCompactWindow` field; the 34 `autoCompactWindow`
    occurrences are all SESSION-level (settings key, parent-window, cache). A subagent's window is
    derived from the PARENT session option, not a per-agent file:
    `autoCompactWindow: e.agentType===xj && Ma(e) ? n.options.autoCompactWindow :
    Tvn(n.options.autoCompactWindow)`. That is exactly why worker lanes run at ~1M and never compact
    below ~1M (the ARCH-022 lane compacted at 970k) — the model is `claude-opus-4-8` (1M window) and
    nothing sets a sub-1M window per agent.
- **Global-override question (review item):** moot on the real path — the bundled binary reads no
  per-agent window at all. The only lever it honours is the SESSION-level `autoCompactWindow`
  setting / `CLAUDE_CODE_AUTO_COMPACT_WINDOW` env, which caps the WHOLE session (orchestrator
  included) — the user's call, not a per-worker fix. The plan's side-finding stands: the user's
  `~/.claude/settings.json` top-level `"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "200000"` does nothing (not
  under `env`, not the real setting name) — and additionally it would reach the bundled CLI only as
  an env var, not a settings key.
- **No expensive model probe run (per "keep probes minimal").** The decisive probe of the real
  launch path is the ground-truth binary identity (`/proc`) plus the binary's feature inventory: a
  CLI whose code contains no sub-1M per-agent window path cannot compact a worker at 200k, so
  spending a long >200k-token lane to observe a compaction that cannot fire would cost real quota to
  confirm a statically-proven negative. The constraint-survival half of the gate is unreachable
  because no compaction is configurable in the first place.
- **To make this shippable (decision for the orchestrator/user, not this lane):** route host
  worker lanes to a CLI ≥ 2.1.327 (e.g. set `CLAUDE_STATION_CLAUDE_BIN` to the PATH binary, or bump
  the bundled SDK), THEN re-run the probe to confirm (a) the 2.1.327 agent loader actually APPLIES a
  frontmatter `autoCompactWindow` to a subagent's effective window (the 2.1.327 per-subagent branch
  was not located and must be verified, not assumed), (b) a global setting's precedence, and (c)
  constraint survival across a forced compaction. Until host lanes run ≥ 2.1.327, FEAT-206 is
  BLOCKED, not merely unbuilt.
- **High-stakes flag:** this is a ship/no-ship call resting on a binary-routing claim; an
  independent clean-room re-verify of "host `direct` lanes spawn the bundled 2.1.281, which lacks
  per-agent autoCompactWindow" is warranted before the ticket is closed.
- **Anti-regression (worker.md unchanged for this ticket, but edited for FEAT-205):**
  `node scripts/verify-arch-016.mjs` → `VERDICT: PASS — 38 passed, 0 failed` (B1 worker.md contract
  still parses). `npm run gate` → `GATE: PASS (exit 0)`.

### 2026-11-19 — agent (finding, round 2) — hypothesis CONFIRMED by a second route; mechanism+saving now BOTH measured; still BLOCKED on CLI routing (do NOT ship)
- **Round-1 block claim HOLDS, re-verified independently of its /proc read.** Second route, from
  the package graph and the binaries themselves (not the live process):
  - `node_modules/@anthropic-ai/claude-agent-sdk/package.json` → `@anthropic-ai/claude-agent-sdk
    @0.3.281`. Highest `2.1.x` version string in its bundled binary
    `node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude` (`strings | grep -oE '2\.1\.[0-9]{3}'
    | sort -u | tail`) → **2.1.281**. PATH `claude --version` → **2.1.328**
    (`~/.local/bin/claude` → `~/.local/share/claude/versions/2.1.328`).
  - Feature probe, per-agent window: `grep -ac 'at least 100000'` → bundled **0**, PATH 2.1.328 **2**.
  - Launch path: `src/server/runtime/claude-runtime.ts:1410-1416` — host/`direct` sessions set
    `pathToClaudeCodeExecutable` ONLY from `config.pathToExecutable` (wired at
    `agent-bridge.ts:1848` for container/openai branches only) or from `process.env
    .CLAUDE_STATION_CLAUDE_BIN` (unset). Host branch leaves it undefined → SDK spawns its bundled
    2.1.281. Confirms: host worker lanes cannot read a per-agent `autoCompactWindow`.
- **NEW, corrects the round-1/plan premise about WHERE the feature lives.** The plan's quoted
  "at least 100000" string is the per-**model** settings key, not frontmatter. But 2.1.328 ALSO has a
  genuine per-**agent** frontmatter field: schema
  `autoCompactWindow:Ge([v(),n(),jg()]).optional().describe(`Auto-compact window for this agent, in
  tokens, at least ${eH}. Overrides the window it would inherit.`)`. Unlike the adjacent
  `initialPrompt` ("Not read when spawned as a subagent"), it carries **no** subagent-exclusion
  caveat — static signal that it applies to subagents. 2.1.281 has neither field in its agent schema.
- **Item 1 — the routing knob and its blast radius.** The only existing knob is
  **`CLAUDE_STATION_CLAUDE_BIN`** (or bumping the bundled SDK to one shipping a CLI ≥2.1.328). It is
  read from the **server process env** (`claude-runtime.ts:1415`), shared by every session the one
  node process spawns. **Blast radius = process-global:** it reroutes EVERY host/`direct` session —
  the orchestrator's own live session included — to that binary, and the change needs a server
  restart (which interrupts the live turn). `pathToClaudeCodeExecutable` is per-config but is only
  plumbed for container/openai, never for host workers — **there is no seam to route only worker
  lanes.** (The compaction *behavior* change would still be worker-scoped, since only
  `worker.md` carries the frontmatter line; but the CLI swap underneath it is all-or-nothing.)
- **Item 2 — one real probe on 2.1.328, outside the live server (scratch, PATH 2.1.328 binary).**
  Scratch project `…/scratch/feat206-compact-probe-1795052356` with `.claude/agents/probe.md`
  (`model: claude-opus-4-8`, `autoCompactWindow: 200000`), driven by a cheap haiku main session that
  delegates ONCE to the `probe` subagent (mirrors the real worker = in-process subagent). Synthetic
  filler, disclosed as such. Three launches, one decisive:
  - run1 aborted: random word-salad filler tripped an API `[bio]` safety classifier on opus-4-8
    (environmental false-positive, not a result) → switched to benign repeated-English filler.
  - run2 under-shot: the Read tool caps each call at ~72 KB (~22k tokens; `File content … exceeds
    maximum allowed size (256KB)`), so 5 reads reached only ~116k — below the window, no compaction,
    secret survived trivially (not a real test).
  - **run3 decisive:** 12 benign sub-256 KB files, one full Read each (~22k tokens/read). Subagent
    transcript `…/94d4a015…/subagents/agent-a7734b1b798ac13ec.jsonl` shows context climbing
    4.8k→27k→50k→72k→94k→117k→139k→161k, then a `system/compact_boundary`:
    `{trigger:"auto", preTokens:179349, durationMs:41048}`. **Compaction OBSERVED at
    preTokens = 179,349** — i.e. ~0.90× the configured 200k window (the CLI fires with headroom
    below the window), collapsing ~179k → a ~27k summary. A default opus-4-8 (1M window) subagent
    would not compact until ~970k (ARCH-022). So the per-agent frontmatter `autoCompactWindow` **does
    take effect on a 2.1.328 subagent.** The subagent then read 4 more files post-compaction and
    returned the exact planted `SECRET=<token>` line (a fixed codeword given only in its first
    instruction) — the constraint planted in its FIRST instruction
    **SURVIVED** the compaction.
- **Item 3 — net $/lane (opus-4-8 rates $5/$25 per M in/out).** One compaction pass summarizes
  ~179k in → ~27k out: upper-bound (all-fresh input) ≈ 179.3k×$5/M + 27k×$25/M ≈ **$0.90 + $0.68 =
  ~$1.6 per compaction** (prompt caching makes the input cheaper in practice), plus ~41 s latency.
  It removes ~152k tokens (179k→27k) from the context carried on every subsequent request; a real
  worker lane runs many more turns, and without the cap grows to ~970k–1M. Against the ticket's
  measured aggregates (>200k worker spend $1,038/30d over 63 lanes; plan models ~$330 after),
  compaction overhead at ~1–2 events/long lane ≈ ~$1.6–3/lane (~$100–200/30d) is a small fraction
  of the saving. **Net per over-200k lane is clearly positive (~$8/lane; aggregate net ≈
  $500–600/30d), contingent on unblocking.**
- **Recommendation: the premise and mechanism are now MEASURED and real — but DO NOT SHIP the
  frontmatter line yet.** The one-line fix stays **BLOCKED** until host worker lanes run a CLI
  ≥2.1.328. The real cost of unblocking is NOT the line; it is that the only routing knob swaps the
  CLI for *every* host session (orchestrator included) and needs a restart — a bigger, less-tested
  change that is the user's call. Sequence if pursued: (1) route host lanes to ≥2.1.328
  (`CLAUDE_STATION_CLAUDE_BIN` or SDK bump) and accept/validate the global swap; (2) add
  `autoCompactWindow: 200000` + the re-read bullet to `worker.md`; (3) run the 14-day measurement in
  the plan. Until (1), the line is dead config (round 1).
- **High-stakes flag (unchanged):** this is a ship/no-ship call on a binary-routing claim plus a
  session-lifecycle CLI swap. An independent clean-room re-verify of "host `direct` lanes spawn
  bundled 2.1.281; 2.1.328 applies per-agent `autoCompactWindow` to a subagent" is warranted before
  closing. Probe artifacts (transcripts, logs, filler) kept under the scratch dir above.
- **Anti-regression:** no repo files changed by this round (ticket docs only); the probe lived
  entirely in a scratch dir and touched neither the live server, service, nor port 4317.

### 2026-11-19 — agent (fixing, round 3, plan+review) — unblock route chosen: bump the SDK (structural, ARCH-010), plan written
- **Chosen knob: bump `@anthropic-ai/claude-agent-sdk` `^0.3.281` → exact `0.3.328`** (bundled CLI
  2.1.328), pinned in `package.json` + `package-lock.json`. Rejected `CLAUDE_STATION_CLAUDE_BIN`: it
  points at the mutable `~/.local/bin/claude` symlink (silent drift on the next `claude` self-update),
  is a prod-inert *test* seam by its own code comment, and leaves the 0.3.281 SDK JS driving a
  2.1.328 binary — a mismatched pair the vendor never ships. The SDK bump keeps SDK JS + CLI a matched
  vendor pair and makes `package.json`/lockfile the single declared source of which binary host lanes
  spawn (ARCH-010). Verified on disk: SDK 0.3.X → bundled CLI 2.1.X 1:1 (installed 0.3.281 → 2.1.281;
  0.3.328's pinned platform pkg is 0.3.328). Blast radius identical to the env-var route (process-
  global, needs restart), so the SDK bump is strictly better.
- **Top risk surfaced:** the CLI-wire parsers (`park-guard.ts` LAUNCH_PATTERNS, `turn-state.mjs`,
  bug-159 turn-end, BUG-239 `queued_command` notice, `survival.ts`) are all pinned to REAL 2.1.281
  fixtures — a green legacy suite does NOT prove them on 2.1.328. Plan marks these **[recapture]** as
  the mandatory pre-ship step. BUG-174 tool-denial literals probed PRESENT in the 2.1.328 binary
  (low risk). Per-agent `autoCompactWindow` application already measured on 2.1.328 (round 2).
- **Plan:** `~/.local/state/claude-station/scratch/orchestration-cost-2026-11-19/PLAN-206.md` —
  exact change + lockfile, compatibility risks (incl. every 2.1.281-pinned behaviour), verify suites,
  user restart commands, rollback (two levers), and measurement (>200k share ≤10%; round-2 net
  ~$8/over-200k-lane, aggregate ≈ $500–600/30d). Still BLOCKED until the user installs + restarts;
  high-stakes independent clean-room re-verify still warranted. No repo files changed this round.

### 2026-11-19 — agent (fixing, round 4, plan+review) — APPLIED to the real tree as edits only (no install); waits on the user's restart (runbook below)
- **Verdict: applied.** Every check below passed on an isolated scratch copy that had the new pair
  installed. The same file changes were then copied into the real tree. `node_modules` in the real
  tree was NOT touched: it still executes `2.1.281 (Claude Code)`, sha256 `56fe3da8…dce1`. The
  live service is unaffected until the user runs the runbook. FEAT-151 admission reads only
  `node_modules/**/package.json`, not the root `package.json`, so it does not block anything
  before the restart either.
- **Scratch:** `~/.local/state/claude-station/scratch/feat206-sdk-6QS5fY/`. It holds the bumped
  copy `orchard/`, the untouched 0.3.281 copy `base/` used as the A/B baseline, the pre-edit
  `snapshots/` of every real file I edited, and `logs/`.
- **Pair proven by execution.** `npm view @anthropic-ai/claude-agent-sdk@0.3.328 claudeCodeVersion`
  → `2.1.328`. After `npm install --ignore-scripts` in the scratch copy, the lockfile diff is only
  the SDK and its 8 platform packages moving 0.3.281→0.3.328, plus `engines.node >=18.14.0`.
  `node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude --version` → **`2.1.328 (Claude
  Code)`**, sha256 **`a982d38030b97e750848add2cbb2df6d9a70d5544a22ca9b216a349ba25865e8`**. The
  scratch server's own session process was checked directly (`/proc/<pid>/exe` of the CLI whose
  environ carries that run's API URL): it is exactly that bundled path, with the same version and
  hash. This is the host `direct` path with SDK default resolution (review blocker 2).
- **Files changed in the real tree.** All were snapshotted first, and none had drifted since the
  scratch copy was taken:
  - `package.json`: one line, `"^0.3.281"` → exact `"0.3.328"`.
  - `package-lock.json`.
  - `.claude/agents/worker.md`: adds `autoCompactWindow: 200000` and the "re-read after compaction"
    bullet.
  - The 5 `scripts/verify-bug159-{turn-end,correlated-turn-end,declared-turn-state,unattributed-result,bridge-turn-end}.mjs`
    suites: a fixture-version knob `B159_CLI_FIXTURE` (default `2.1.281`).
  - `scripts/verify-survival-deployed.mjs` and `scripts/verify-bug-239-bound-hangs-no-park.mjs`:
    added the missing wait for the FEAT-151 boot check (see the stale-suite finding below).
  - New: `scripts/lib/b159-fixtures.mjs`, `scripts/lib/fake-messages-api.mjs`,
    `scripts/lib/cli-wire-env.mjs`, `scripts/capture-cli-wire.mjs` (a committed, re-runnable
    recapture driver; the 2.1.281 drivers had lived in /tmp and were lost),
    `scripts/verify-feat-206-cli-lifecycle.mjs`, and
    `scripts/fixtures/bug-159/real-cli-2.1.328-{contract,correlation-races,frames,input-races}.json`
    (139 real 2.1.328 runs, home paths scrubbed).
  - **No `src/` change was needed.** No 2.1.281-pinned parser broke on 2.1.328 frames.
- **Review blockers.** B = blocker number; "both pairs" means 2.1.328 plus the 2.1.281 rollback pair.
  - **B1 isolated build: done.** No install or test ever ran in the real tree.
  - **B2 executed `--version` + hash: done** (above).
  - **B3 production path: PASS.**
    - The new lifecycle suite runs a real scratch Orchard server (survival ON) with the real
      SDK/CLI and hooks; only the model is a fake API. It gives **42/0 on 2.1.328** and 39/2 on
      2.1.281 (the 2 = Monitor is disabled in the hermetic env on 2.1.281).
    - Real OAuth plus the real haiku model through the scratch server:
      `verify-bug-239 --only B` → **40/40**, `--only A` → **42/42** on 2.1.328.
  - **B4 every launch branch: PASS on 2.1.328.** The real lane transcript plus the real
    `scanTranscript` recognised:
    - `Command running in background with ID:`
    - `Command did not complete within its 3s timeout and was moved to the background (ID:`
    - `Monitor started (task`
    - `Async agent launched successfully.` for both an `Agent` call and a `Task`-named call. The
      result content was string for Bash/Monitor and blocks for Agent/Task. Every announcement was
      recognised.
    - PowerShell is not testable on Linux.
  - **B5 lifecycle: PASS on 2.1.328 frames.** The recapture covers:
    - auth, okthenauth, 429, 500 mid-turn;
    - background-bash woken turns;
    - interject during a tool, rapid and two outstanding inputs;
    - dup uuid;
    - interrupt before-read / mid / late / idle / queued;
    - /cost /context /compact and an unknown slash command;
    - runs without session states.

    Graded with the real `turn-state.mjs` via `B159_CLI_FIXTURE=2.1.328`:
    - `correlated` 24/0;
    - `declared` 40/0 ("131 real runs, 316 uuid inputs, 249 idles");
    - `unattributed` 25/0;
    - `turn-end` all pass, including the live `bridge` layer at 52/0.

    Driver fidelity: the same driver run against 2.1.281 grades 40/0 and 25/0. `correlated` gives
    23/1 there; the 1 is a specific-run race precondition (`message_stop-0-ok-0` ordering did not
    recur), not a false-free or stuck read. One shape change was seen: in 2.1.328, `task_updated`
    and `task_notification` now precede `background_tasks_changed`. The tracker is unaffected.
  - **B6 survival/control: PASS.**
    - Cards through `canUseTool` on the live pair: allow wrote the file; deny did not, and its
      text reached the model; the AskUserQuestion answer came back as `updatedInput`.
    - Cancel mid-stream ends the turn `interrupted`, and the next turn works.
    - A 500 error ends the turn `isError`, and the session recovers. `/api/health` reads busy=false.
    - `verify-survival-deployed` gives **11/12 on both pairs**. The one failure is identical on
      both: "NO LOST WORK" (pre-existing, not a regression). The broker and CLI do survive a
      control-group stop and are re-adopted.
  - **B7 FEAT-096 `agent_id`: PASS on both pairs.**
    - The orchestrator's `cat` was refused and wrote no file.
    - The lane's identical `cat` ran. The UI events carry `agentId`.
    - After a resume, the main thread is still refused.
    - After a lane compaction, the lane is still lane-attributed.
  - **B8 replay through the real consumers, with independent outcome measures: PASS.**
    - The park-guard really held the lane (9 blocks).
    - Every background child's completion file exists: shell, timeout-backgrounded, Monitor.
    - Notices arrive as `attachment/queued_command`, the shape `scanTranscript` reads.
    - The session is not left busy.
  - **B9 compaction on the real worker-loading path: PASS.**
    - The project's real `.claude/agents/worker.md` (with the line) loads, and the lane runs on its
      model `claude-opus-4-8`.
    - At ~192k reported context the lane auto-compacted: `compact_boundary {trigger:auto,
      preTokens:192034}` in its own transcript.
    - After compaction it is still lane-attributed, and park-guard still holds it for a child that
      then finishes.
    - **On 2.1.281 the line is INERT:** the lane loads and runs, nothing compacts, and the guard
      works. So the `worker.md` edit is safe before the restart.
  - **B10/B11 runbook + explicit rollback: written below.** Rollback was tested in a scratch copy.
    Old-version resume of new-version state was tested both ways (arm D):
    - 0.3.281→0.3.328 and 0.3.328→0.3.281 both pass 4/4;
    - this includes a session whose lane compacted under 2.1.328, resumed on 2.1.281.
  - **B12** is stated in the rollback section.
- **Regression runs on the bumped scratch tree:**
  - `typecheck` exit 0, with SDK 0.3.328 types. `agent_id` on the PreToolUse input keeps the same
    doc and position.
  - `verify-feat-151-runtime-update` 76/0; `-http` 9/0; `bug-174` PASS; `feat-096-read-escapes`
    PASS; `bug159-bridge-turn-end` 52/0.
  - `verify-feat-064-drain-truth` FAILS identically on base 2.1.281: a memory-symlink advisory
    error at start, pre-existing and not a regression.
  - `verify-arch-016` cannot pass in an unregistered scratch path; on the real tree it is **38/0**.
- **Real tree after applying:**
  - `npm run gate` → **GATE: PASS (exit 0)**.
  - The 3 pure BUG-159 suites ALL PASS on both the default (2.1.281) and the 2.1.328 fixtures.
- **Findings for the orchestrator (not fixed here):**
  1. **The park-guard misses a child when a lane ends instantly after launching it, on BOTH
     CLIs.** It reads the lane transcript before the CLI has flushed it. Measured with a 0 ms fake
     model:
     - 3/3 runs on 2.1.281 and 3/3 on 2.1.328 → guard allowed, child killed.
     - A dump of the hook input showed the on-disk transcript several records behind the stop.
     - With 600 ms model latency: 0/3 misses.

     This is pre-existing and not a regression, but it is a real race for a fast final reply. It
     is worth a ticket: the "If another process writes it" rule applies.
  2. **Two suites were stale against FEAT-151 admission.** `verify-bug-239` (real-CLI arms) and
     `verify-survival-deployed` sent `start` before the boot runtime check passed, got "runtime
     check pending", and never ran a session. This happened on 2.1.281 too. They are fixed here
     with `waitRuntimeReady`.
  3. **SDK 0.3.328 prints two new advisory warnings:**
     - `CLAUDE_SDK_MCP_SERVERS_ARGV_DEPRECATED`: set `mcpServersDelivery` before a future SDK
       makes 'initialize' the default.
     - `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` in bypassPermissions mode.
  4. **A stray `node_modules/node_modules` (312 MB, dated Aug) exists in the real tree.** Node
     never resolves through it. `npm ci` removes it; the scratch tree ran every check without it.
- **Not tested, and why:**
  - PowerShell (Linux host).
  - SDK 0.3.328 *re-attaching* to a surviving 2.1.281 CLI across the switch. Not built; the
    runbook therefore ends survivors so every session resumes on 2.1.328, which is tested.
  - Real-model compaction on the bundled binary. A fake model drove the window; round 2 measured
    a real 2.1.328 compaction at 179k.
  - The 14-day cost effect.
- **High-stakes (session lifecycle + CLI swap):** an independent clean-room verify is warranted.
  Run `scripts/independent-verify.mjs --ticket FEAT-206` with
  `node scripts/verify-feat-206-cli-lifecycle.mjs --root <bumped copy>`.

#### USER RESTART RUNBOOK (run from `~/projects/orchard`, between lanes)
```bash
cd ~/projects/orchard
# 0. DRAIN CHECK — must print DRAINED, and no lane dispatch may be in flight (board / Needs-You)
node scripts/http-get.mjs http://127.0.0.1:4317/api/health | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const b=JSON.parse(s).sessions.filter(x=>x.busy!==false);console.log(b.length?"NOT DRAINED":"DRAINED",JSON.stringify(b.map(x=>({id:x.stationSessionId,busy:x.busy,work:x.work}))))})'
# 1. STOP the service
systemctl --user stop claude-station
# 2. End surviving session hosts. Survival keeps idle sessions' 2.1.281 CLIs alive across a stop;
#    re-adopting them under SDK 0.3.328 was NOT tested. Ending them is safe: every session resumes
#    from its transcript, and cross-version resume was tested.
systemctl --user list-units 'claude-station-host-*.scope' --no-legend --plain
systemctl --user stop 'claude-station-host-*.scope'
pgrep -af 'claude-agent-sdk-linux-x64/claude'        # must print nothing
# 3. INSTALL exactly the committed lockfile (also removes the stray node_modules/node_modules)
npm ci
# 4. VERIFY the binary — both must match
node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude --version   # 2.1.328 (Claude Code)
sha256sum node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude   # a982d38030b97e750848add2cbb2df6d9a70d5544a22ca9b216a349ba25865e8
# 5. START
systemctl --user start claude-station
# 6. POST-SWITCH SMOKE
node scripts/http-get.mjs http://127.0.0.1:4317/api/runtime/version     # host restartPending:false, 0.3.328 / 2.1.328
#    open a NEW session, send "say ok", get a reply; then every live CLI must be the bundled one:
for p in $(pgrep -f 'claude-agent-sdk-linux-x64/claude'); do readlink /proc/$p/exe; done   # all .../orchard/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude
#    dispatch one small worker lane and confirm it ends and reports; then the free end-to-end check:
node scripts/verify-feat-206-cli-lifecycle.mjs      # scratch server + fake model, ~6 min: expect "42 passed, 0 failed"
```

#### ROLLBACK RUNBOOK (correctness) — to the known-good 0.3.281 / CLI 2.1.281
Trigger: a permission bypass, a turn shown idle while running (or stuck busy), a stranded or killed
child, or a failed resume. Roll back **immediately**. Correctness failures never go through "try
300k first".
```bash
cd ~/projects/orchard
systemctl --user stop claude-station
systemctl --user stop 'claude-station-host-*.scope'
npm install --save-exact @anthropic-ai/claude-agent-sdk@0.3.281
#   tested in scratch: the resulting lockfile is byte-identical to the pre-change lock except the exact pin
node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude --version   # 2.1.281 (Claude Code)
sha256sum node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude   # 56fe3da88458465fb27d7e9299dddb3fead55750fb9c2de795f233b5eea6dce1
#   then delete the `autoCompactWindow: 200000` line from .claude/agents/worker.md
#   (it is inert on 2.1.281, which was tested; remove it so a later bump does not silently re-enable it)
systemctl --user start claude-station
```
- **Saved known-good copies.** The pre-change `package.json` and `package-lock.json` are in
  `…/feat206-sdk-6QS5fY/snapshots/`. Note that the `package.json` copy also carries other lanes'
  uncommitted lines from that moment.
- **Session state.** Sessions written by 2.1.328 resume on 2.1.281 (tested). A compaction that
  already happened cannot be undone: a resumed lane continues from its summary.

#### The 14-day cost measurement is SEPARATE from correctness rollback
- It decides only the **compaction window**: keep 200k, raise to 300k, or delete the line while
  keeping 2.1.328. The criteria are the ticket's success criteria.
- Correct the plan's net formula: it must be dollars minus dollars, not dollars minus a share.
- Compare like workloads, not compacted against uncompacted lanes, because harder tickets compact
  more.
- Nothing in this measurement gates or delays a correctness rollback.

### 2026-11-19 — verify lane (round 1)
- **Verification recorded:** dispatch anthropic/claude-opus-4-8 run 38471cd4-1871-4223-9f50-d610b27dd288 — VERDICT: HOLDS — verified, awaiting user switch. Clean-room (openai) BROKEN spurious: strips .claude + ran pre-restart 2.1.281 not 2.1.328. Decisive: real 0.3.328 install, fixer 42/0 on 2.1.328 (compaction 192034; cancel/resume/agent_id PASS) + own mid-tool-cancel attack: tool killed exit137, AbortError, no hang.. Typed entry in the record's verification[]; this line is an echo, not proof.
