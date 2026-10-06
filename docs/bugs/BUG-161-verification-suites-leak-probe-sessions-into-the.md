```orchard-ticket
{
  "id": "BUG-161",
  "type": "bug",
  "title": "Verification suites leak probe sessions into the user's real ~/.claude/projects store",
  "summary": "Verify suites isolate CLAUDE_STATION_DATA but not the CLI transcript store, so probe sessions (PONG, STATION-UI-OK, 391, a project-name) write into the user's real ~/.claude/projects — the largest source of session-list clutter. Fixed with a structural session-create guard plus fixes to 4 suites; verify.ts isolation is still open.",
  "impact_if_we_wait": "The real session store keeps accreting throwaway probes (already ~1100+ scratch sessions and 338 probes mixed into real project dirs), burying the user's real conversations and making the session list unusable.",
  "current_need": "Guard landed and proven; the user must authorise deletion of the inventoried junk, and verify.ts still needs its own store isolation + a live verification pass.",
  "severity": "high",
  "area": "server",
  "reported": "2026-08-28",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-08-28",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A verification suite that isolates CLAUDE_STATION_DATA but not the transcript store is REFUSED loudly at session-create, not silently allowed to write the real store",
    "A real session under the correct isolation writes only to a scratch store, with the user's ~/.claude/projects untouched and OAuth still working",
    "npm run gate exits 0; the guard-matrix suite passes; a fake-bin runtime suite still passes (no over-fire)"
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [],
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

# BUG-161 — Verification suites leak probe sessions into the user's real ~/.claude/projects store

## Symptom
Verification suites write throwaway probe sessions into the user's REAL Claude
session store (`~/.claude/projects/`) instead of a scratch store. Sampled probe
content: `PONG`, `STATION-UI-OK`, `Without using any tool … 17 multiplied by
23`, `SUB_BASH_OK`, `a project-name`. An audit of the real store found **767 project
dirs / 4041 jsonl (1890 primary sessions)**, of which a large fraction are test
probes — the single largest source of clutter in the user's session list.

## Root cause
`CLAUDE_STATION_DATA` isolates the STATION's own data dir, but a spawned
`claude` CLI writes its transcript to `<CLAUDE_CONFIG_DIR else ~/.claude>/
projects/<encoded-cwd>/`. A suite that isolates only `CLAUDE_STATION_DATA` looks
correct (its own state is scratch) while every session it drives pollutes the
real store. The transcript-store isolation knob is `CLAUDE_CONFIG_DIR` (the CLI
writer), NOT `CLAUDE_PROJECTS_DIR` (that only steers Orchard's reader) — a suite
that sets `CLAUDE_PROJECTS_DIR` alone believes it is isolated and is not. This is
the same class as the BUG-117 `STATION_DATA_DIR` fails-open-silently trap.

## Fix (structural guard, not a per-caller convention)
`assertSessionStoreIsolated()` in `src/lib/paths.ts` refuses at session-create
time any `ClaudeRuntime` real-store write unless it is the sanctioned production
server (`index.ts` calls `markSanctionedRealStoreWriter()` at boot) running in
normal shared-data mode. Two condemning signals: (1) `CLAUDE_STATION_DATA`
isolated but the store still real (half-isolated harness), and (2) not the
sanctioned server (an in-process harness that isolated nothing, e.g. an e2e
suite). Scoped in `claude-runtime.ts` to a REAL host CLI spawn only (a fake bin
via `CLAUDE_STATION_CLAUDE_BIN` or a container executable writes elsewhere, so
the guard would be a false positive there). Reusable helper
`isolatedStoreEnv(dir, {alsoReader})` in `scripts/lib/station-boot.mjs` returns
the correct env and symlinks (not copies) credentials so OAuth still resolves.

## Verification
- MUST-FAIL (before): `ClaudeRuntime` with isolated DATA + no config dir wrote a
  real transcript into `~/.claude/projects/<encoded-scratch-cwd>/`
  (a new `.jsonl` appeared). Proof script left in scratch.
- STOPS (guard fires): same pattern now throws loudly at start(), before query();
  no file created.
- FIXED pattern (after): a real session with `CLAUDE_CONFIG_DIR` isolated +
  symlinked creds wrote to the SCRATCH store, real store untouched, auth worked
  (model replied `FIXEDPROBE`).
- `npm run verify:leak-store-guard` (new, deterministic, gate-safe): 13/13 —
  covers store resolution, the wrong-var (`CLAUDE_PROJECTS_DIR`-only) trap, the
  e2e-shape (isolated-nothing) case, and the sanctioned-server allow.
- Anti-regression: `verify-bug-068` (fake-bin runtime suite, isolates DATA but
  not store) still PASSES 5/5 — the guard correctly does not over-fire.
- `npm run gate` → exit 0 (leak-gate + check-nul + typecheck).

## Junk inventory (real store — DELETE IS THE USER'S TO AUTHORISE; nothing deleted)
Read-only audit. Explicit review lists were written to the worker's scratch dir
(exact paths handed to the orchestrator out-of-band; kept out of this public-bound
ticket):
- **Bucket A — HIGH confidence, delete:** 709 obviously-scratch project dirs /
  1112 sessions (encoded-name tokens: `-tmp-`, `-run-user-`, scratch, verify,
  cleanroom-verify, snapverify, probe, fixture, e2e, `cs-*`, `bug<NNN>`,
  `feat<NNN>`, b105/b114/…).
- **Bucket B — HIGH confidence, delete (file-level):** 338 probe sessions sitting
  INSIDE real project dirs (298 in the orchard project dir), all tiny (8–25
  lines), `promptSource":"sdk"`, canned verify prompts.
- **Bucket C — LOW confidence, DO NOT delete:** 76 ambiguous orchard sessions;
  includes genuine user chats (`hi`, `hi bae hru`).
- **KEEP (not junk):** 228 orchard agent-dispatch/orchestrator records + real CLI
  chats + 1 agent worktree + all large real project sessions. One project-name
  marker was DROPPED — every hit was real work (a product rebrand), not a probe.
- Plus one probe I created for the must-FAIL proof (a single throwaway `.jsonl`
  under a scratch-cwd project dir; exact path handed to the orchestrator).

Removal commands are DRY-RUN-first: Bucket A = `rm -rf` over the reviewed dir
list, Bucket B = `rm -f` over the reviewed file list — AFTER the user reviews.

## Context pack
- Files/functions in play: `src/lib/paths.ts` (claudeStoreDir / realClaudeStoreDir
  / assertSessionStoreIsolated / markSanctionedRealStoreWriter),
  `src/server/runtime/claude-runtime.ts` (guard call, scoped to real host CLI),
  `src/server/index.ts` (boot marker), `scripts/lib/station-boot.mjs`
  (isolatedStoreEnv + .d.mts), `scripts/verify-leak-store-guard.mjs`.
- Suites fixed: verify-ui.ts, verify-orchestrator-enforcement-e2e.mts,
  verify-feat-096-live-sessions.mts, verify-agent-summary-bridge.mjs.
- Related tickets: BUG-117 (the sibling STATION_DATA_DIR fails-open trap).
- Repro test: `npm run verify:leak-store-guard` (add script alias).

## Still open / handoff
- **verify.ts is NOT yet isolated.** It genuinely READS real sessions as
  preconditions (sections 1-2) AND forks a real Windows session (section 8,
  fork.ts uses `defaultRoot()`=`CLAUDE_PROJECTS_DIR`), so a single store root
  can't be both real-for-fixtures and scratch-for-writes. Correct fix: SEED the
  handful of real fixtures into a scratch store, then run everything under
  `CLAUDE_CONFIG_DIR`+`CLAUDE_PROJECTS_DIR`=scratch — a real refactor that must be
  LIVE-verified (it costs money; sections 3-10 spawn many model sessions).
  `verify.ts --offline` still passes (no session creation). Until then the guard
  makes its live sections fail LOUDLY (case E) instead of leaking silently —
  which is the intended behaviour, not a new break.
- The 4 fixed suites and verify-ui were fixed by mechanism (proven via the real
  fixed-pattern run) but could not be LIVE-run here (real sessions + browser);
  a live pass on each is warranted before calling them green.

## Symptom of a deeper design flaw?
Arguably yes — "fixture pollutes reality" recurs (BUG-117 was the data-dir half;
this is the transcript-store half). The two-knob split (CLAUDE_STATION_DATA for
data, CLAUDE_CONFIG_DIR for the CLI store, CLAUDE_PROJECTS_DIR for the reader) is
the shape that keeps catching people. Left as a note for arch-watch rather than
filing ARCH now, since the guard now makes every instance fail loudly.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-28 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-09-29 — agent (fixing, round 1)
Isolated `scripts/verify.ts` (the last unisolated suite). **Only file changed:
`scripts/verify.ts`.** `npm run gate` → exit 0 (leak-gate + check-nul + typecheck).

**What I changed (all in verify.ts):**
- Redirect BOTH store knobs at a scratch config dir under `DATA` via the existing
  helper `isolatedStoreEnv(CONFIG_DIR, { alsoReader: true })` — `CLAUDE_CONFIG_DIR`
  (CLI writer) + `CLAUDE_PROJECTS_DIR` (Orchard reader + `fork.ts`), creds symlinked.
  Merged into the server spawn env. `SESS_STORE = CONFIG_DIR/projects`.
- New `seedFixtures()` runs before server boot: copies the handful of REAL sessions
  the suite selects (neighbor history; a Bash-tool_use session; a subagent-bearing
  session; a Windows-origin session; cross-dir duplicate ids) FROM the real store
  INTO scratch (read of real, write to scratch — real store never written). Best-
  effort: it only RELOCATES fixtures that exist; a missing one is not seeded and the
  owning section fails at its OWN precondition (same as HEAD).
- Repointed every direct real-store read (`os.homedir()/.claude/projects` in 1a, 2d,
  and section 8's module-level consts, now lazy inside `forkChecks()`) at `SESS_STORE`.
- **`isolation: 'direct'` on the projects verify.ts creates** — LOAD-BEARING (see
  finding below), restores the suite's historical behaviour.
- `Driver.start` retries on the transient `runtime-check-pending` block (direct
  sessions gate on the async bundled-runtime boot check; the refusal precedes any
  model call, so retry is free).
- 2d seed picks a SINGLE-agent session whose agent has ≥6 renderable messages, so
  the pagination check (offset=5) is satisfiable regardless of copied readdir order
  (graded through the real `listSubagents()` — not a re-derived count).

**KEY FINDING — the dispatch hypothesis was WRONG; `isolatedStoreEnv` alone is
INSUFFICIENT.** A one-turn LIVE session under the pre-change env (default isolation)
wrote its transcript to the REAL store at `~/.claude/projects/-workspace-diag`
(cwd `/workspace/diag`) — a SANDBOX session runs with the real HOME and a remapped
cwd, so `CLAUDE_CONFIG_DIR` is ignored and the write lands in the real store; the
guard is deliberately scoped to direct spawns so it did not fire. The machine
default isolation is now `container` (registry.NEW_PROJECT_DEFAULT_ISOLATION), so a
project created without `isolation` silently regressed verify's sessions from direct
to sandbox and re-opened this exact leak. verify.ts's own teardown note already
named the DIRECT cwd encoding (the repo path collapsed by the `[^a-zA-Z0-9]->-`
rule, i.e. NOT a `-workspace-*` sandbox dir), confirming it historically ran direct.
Fix required BOTH the store env AND forcing `isolation: 'direct'`.
(regressed-from: whatever flipped NEW_PROJECT_DEFAULT_ISOLATION to container.)

**Verification (commands + results):**
- must-FAIL / PASS guard proof (synthesized pre-fix env, not a moving baseline)
  — `/tmp/bug161-guard-proof.mjs`: pre-change env (`CLAUDE_STATION_DATA` only)
  → `claudeStoreDir` = REAL store + `assertSessionStoreIsolated` REFUSES; post-change
  env (+ `isolatedStoreEnv`) → store = scratch, guard ALLOWS, creds symlinked. ALL PASS.
- LIVE proof (ONE minimal single-turn paid session, twice for diagnosis): default
  isolation → transcript in REAL store (leak reproduced); `isolation:'direct'` +
  `CLAUDE_CONFIG_DIR` → transcript in SCRATCH (under `<CONFIG_DIR>/projects/<repo-encoded-dir>/<sid>.jsonl`),
  session id ABSENT from the real store, model replied (OAuth via symlinked creds works).
- `node scripts/verify.ts --offline` → **33 passed, 0 failed**; seeds 3 fixtures into
  scratch (a real neighbor project, a home Bash session, a subagent-bearing session)
  and reads them all from scratch. Real-store snapshot before/after (`find -printf`):
  **no new project dir created, no verify-attributable session** — the only churn was
  concurrent live lanes (session `6927511d` + a cleanroom tree).
- Anti-regression: I did NOT run `verify-leak-store-guard.mjs` again for verify.ts (it
  tests the guard, which I did not touch); the guard/helper are unchanged and gate's
  typecheck covers the import surface.

**Not done / handoff:**
- I did NOT run the FULL paid verify.ts (sections 3-10, ~15+ turns + a fork replay).
  Isolation is proven at the mechanism level (all live sessions share one server env
  + direct projects; one direct session isolating ⇒ all do) but a full green run is
  still warranted. HIGH-STAKES (session-lifecycle + regression-prone): flagging for an
  INDEPENDENT clean-room / fresh-context live pass (scripts/independent-verify.mjs).
- This machine's real store has NO Windows-origin session and NO cross-dir duplicate
  ids, so **sections 8/8b cannot run here regardless** (HEAD's section 8 also fails its
  precondition). A full green run needs a store that has those, or the pins
  (`STATION_VERIFY_WIN_DIR`/`_ID`, and a dup fixture).
- **Deeper flaw suspect (for arch-watch):** the store-isolation guard is scoped to
  direct host spawns, so a container/sandbox verify session that leaks to the real
  store is NOT caught by it — the guard gives false confidence for exactly the
  isolation mode that is now the DEFAULT. The other 4 "fixed" suites (verify-ui, etc.)
  should be re-checked for which isolation their sessions actually run under.

### 2026-09-29 — agent (verifying, round 1) — clean-room independent pass → INVALID (not-run)

Ran the warranted independent clean-room pass on the UNCOMMITTED `scripts/verify.ts`
fix (data-loss class). Status stays **open** — the pass did NOT validly conclude, so
nothing is flipped to VERIFIED.

- **Requirement under attack** (`/tmp/req-BUG-161.txt`, plain terms, not the fixer's
  prose): a full `verify.ts` run must leave the real Claude CLI transcript store
  (`$HOME/.claude/projects`) byte-unchanged and leak no probe sessions; isolation must
  hold on the **container/sandbox** path, not only direct spawns (the flagged gap);
  seedFixtures must only READ the real store and drive every consumed fixture from
  scratch. Adversarial cases must assert against a SCRATCH store, never the real one.
- **Command** (tilde form): `CLAUDE_CONFIG_DIR=~/.local/share/claude-station/claude-accounts/<grey-account-id>
  node scripts/independent-verify.mjs --repo ~/projects/orchard --working-tree
  --requirement @/tmp/req-BUG-161.txt --run "node scripts/verify.ts --offline"
  --test-file scripts/verify.ts --provider anthropic --timeout-min 25
  --verdict-out /tmp/verdict-BUG-161.txt`
  (working-tree snapshot: HEAD `a977e76b` → tree `b35d5abe`, dangling commit, real
  index untouched.)
- **Verdict: INVALID (exit 3)** — rejected mechanically by the verdict-contract, not a
  pass and not a fail. The verifier wrote `VERDICT: HOLDS` while citing two of its own
  break-attempt runs (`f4f16685`, `e9abbd5c`) that exited **1**; HOLDS requires every
  break attempt to exit 0, so the citation is self-inconsistent and the harness threw
  the verdict out. We therefore have NO valid independent conclusion about the fix.
- **Container/sandbox isolation gap: NOT validly exercised — remains UN-VERIFIED.** The
  data-loss-critical property (property 2 of the requirement — does a non-direct/sandbox
  verify session escape to the real store) was the whole point of this pass and is
  precisely what an INVALID verdict leaves unproven. The two exit-1 runs *may* have been
  genuine breaks on this path, but the verifier's own labelling is untrustworthy and its
  clean-room record dir was auto-reaped (no `--keep-cleanroom`), so their content cannot
  be salvaged. Treat this gap as open and adversary-relevant.
- **Un-runnable (not failures):** sections **8 / 8b** (Windows-origin fork replay +
  cross-dir duplicate ids) cannot run on this machine — the store has no such session
  (HEAD's section 8 fails the same precondition). The verifier was told to treat 8/8b as
  not-applicable, not as failures.
- **Handoff — re-run warranted.** Commission a fresh independent pass that (a) forces a
  consistent verdict label (or use `--keep-cleanroom` so the exit-1 runs can be read),
  ideally **cross-provider** for decorrelation (this pass was same-provider fallback),
  and (b) explicitly drives a container/sandbox-isolation session and byte-compares the
  scratch store before/after. Until a VALID+HOLDS pass covers the sandbox path, the fix
  is unverified for its highest-stakes property.

- **Verified-by:** dispatch anthropic (grey account) run `06590a2f-56f8-4cac-a621-a6c260f6b3f4`
  (clean-room, `scripts/independent-verify.mjs`, working-tree snapshot tree `b35d5abe`) —
  VERDICT: INVALID (verdict-contract rejection). **Same-provider fallback** (author-provider
  anthropic == verifier-provider anthropic — decorrelation reduced); a cross-provider re-run
  is preferable.

### 2026-09-30 — agent (verifying, round 2) — clean-room independent pass → BROKEN (VALID)

Re-ran the warranted independent clean-room pass on the UNCOMMITTED `scripts/verify.ts`
+ `scripts/lib/station-boot.mjs` fix (data-loss class). Round 1 was thrown out as
INVALID for a self-inconsistent HOLDS citation; this round the verifier structured
each adversarial case as an exit-0-on-hold assertion script and reached a consistent,
VALID verdict. Status stays **open** — the fix is BROKEN on the container path.

- **Requirement under attack** (`/tmp/req-BUG-161.txt`, plain terms): a full `verify.ts`
  run must leave the real Claude CLI transcript store (`$HOME/.claude/projects`)
  byte-unchanged and leak no probe session; isolation must hold on the
  **container/sandbox** path, not only direct spawns; `seedFixtures()` must only READ
  the real store and write copies to scratch. Assert against a SCRATCH mirror (remapped
  `HOME`), never the machine's real store.
- **Command** (tilde form): `CLAUDE_CONFIG_DIR=~/.local/share/claude-station/claude-accounts/<grey-account-id>
  node scripts/independent-verify.mjs --repo ~/projects/orchard --working-tree
  --requirement @/tmp/req-BUG-161.txt --run "node scripts/verify.ts --offline"
  --test-file scripts/verify.ts --provider anthropic --keep-cleanroom --timeout-min 25
  --verdict-out /tmp/verdict-BUG-161.txt`
  (working-tree snapshot: HEAD `a977e76b` → tree `952d9489`, dangling commit `b7fd54fe`,
  real index untouched. 7 manifest-backed runs, clean room kept.)
- **Verdict: BROKEN (exit 1), VERDICT-CONTRACT VALID.** Three adversarial cases, all
  cited consistently: (a) `offline-seed-readonly` EXIT 0 — mirror byte-identical, 3
  fixtures seeded into scratch, 0 non-seeded transcripts in the real mirror; (b)
  `live-direct-verify` EXIT 0 — the ONE paid full run (sections 3–7 live, 12 new
  transcripts, ALL in the scratch config store), mirror byte-identical (17 entries
  before and after); (c) `container-sandbox-drive` EXIT 1 — the leak.
- **Container path exercised: YES, and it LEAKS (this is the finding).** A real
  `isolation:container` session started under `CLAUDE_CONFIG_DIR`+`CLAUDE_PROJECTS_DIR`=scratch
  still wrote `-workspace-iso-container/<sid>.jsonl` (124774 B) and a `memory/` dir
  straight into the `$HOME/.claude/projects` mirror. Cause: `containerHistoryDir()`
  (`src/server/container-manager.ts:327-328`) hard-codes `os.homedir()/.claude/projects`
  as the host side of the session-history bind in `desiredBinds()`
  (`container-manager.ts:650-653`), ignoring BOTH store env vars. `verify.ts` avoids the
  leak ONLY by forcing `isolation:'direct'`; any project created with `isolation:container`
  — the machine DEFAULT when Docker is available (`registry.ts:643`) — leaks into the
  real store. This is exactly the flagged property-2 gap, now proven live.
- **Un-runnable / not-applicable (NOT failures):** sections **8 / 8b** (Windows-origin
  fork replay + cross-dir duplicate ids) — no such session on this machine (section 6
  timed out and aborted the harness before 8/9/10 ran anyway). **Sandbox (bubblewrap)
  isolation** could not be driven: the server refuses it — `isolation "sandbox"
  (bubblewrap) is modelled but not implemented`. So the container half of property 2 is
  proven BROKEN; the bubblewrap-sandbox half is un-runnable (no implementation to test).
  The clean-room fixer-test itself exits 1 on an unrelated env artifact (a placeholder
  `WORKING_AGREEMENT.md` fails the section-2c precondition), so the live case used a
  patched copy that skips only that precondition.
- **Handoff — fix is NOT complete.** `verify.ts`'s direct-only workaround protects
  `verify.ts` itself, but the requirement's property 2 (isolation holds on the
  container path) is FALSE: the real leak is structural in `container-manager.ts`, not
  in `verify.ts`. Next fixer should redirect the container session-history bind's host
  side at the scratch store when the store env vars are set (respect
  `CLAUDE_PROJECTS_DIR`/`CLAUDE_CONFIG_DIR` in `containerHistoryDir()`/`desiredBinds()`),
  or extend `assertSessionStoreIsolated` to cover the container spawn path so a
  container leak fails loudly instead of silently. Until then, any container-isolation
  session (the default) leaks probes into the real store.

- **Verified-by:** dispatch anthropic (grey account) run `af08b35a-f28d-4920-aba8-16ba399cc86e`
  (clean-room, `scripts/independent-verify.mjs`, working-tree snapshot tree `952d9489`) —
  VERDICT: BROKEN (VALID, 3 manifest-backed adversarial cases). **Same-provider fallback**
  (author-provider anthropic == verifier-provider anthropic — decorrelation reduced).

### 2026-09-30 — agent (fixing, round 3) — container-store leak root-caused; patch ready (bind-level proof)

Took the round-2 BROKEN finding: a real `isolation:container` session under a scratch
store still wrote `-workspace-<id>/<sid>.jsonl` into the user's REAL `~/.claude/projects`.

- **Hypothesis (charter) CONFIRMED — the authority already exists and container-manager
  did not read it.** The transcript-store LOCATION is declared once by its owner:
  `claudeStoreDir(env)` in `src/lib/paths.ts` (`<CLAUDE_CONFIG_DIR else ~/.claude>/projects`
  — the CLI-writer knob, NOT the reader-only `CLAUDE_PROJECTS_DIR`; its own docstring says
  so). `containerHistoryDir()` (`container-manager.ts:327-328`) instead hard-codes
  `os.homedir()/.claude/projects/…` — a SECOND place holding a different answer (ARCH-010
  violation). It is the host side of the `desiredBinds()` "session history" bind
  (line ~653), so every containerised session binds its host-side history into the real
  store regardless of an isolated `CLAUDE_CONFIG_DIR`. No new derivation needed; the fix
  is to READ the one authority.

- **Root cause (one line):** container session-history bind host path re-derives the store
  root from `os.homedir()` instead of reading `claudeStoreDir()`, so store isolation via
  `CLAUDE_CONFIG_DIR` is ignored on the container path.

- **Fix (patch, NOT applied to the shared working tree — container-manager.ts carries other
  lanes' uncommitted edits + a live FEAT-129 lock):**
  `/tmp/bug161-container-store-authority.patch` — 2 hunks: import `claudeStoreDir` from
  `../lib/paths.ts`, and `containerHistoryDir` returns `path.join(claudeStoreDir(),
  containerStoreDirName(project))`. Applies cleanly (`diff -u` of working-tree file vs
  patched; both anchor context lines present verbatim, count 1 each). FEAT-145 invariant
  preserved: only the HOST side of the bind moves; `CLAUDE_CONFIG_DIR` is NOT forwarded
  into the container (container path stays image-local). Named-account projects unaffected
  (server env has no `CLAUDE_CONFIG_DIR`; account overlays symlink `projects` to the real
  store anyway).

- **Proof (bind-computation level — host Docker daemon is the user's live one, off-limits
  per FEAT-158/BUG-216; round-2 already proved the leak LIVE). Proved in a scratch copy of
  the working tree (`/tmp/bug161-wt`: real working-tree `src`+`scripts`, unlocked copy of
  `container-manager.ts`, `node_modules` symlinked; equivalent to a HEAD worktree +
  working diff since `git worktree` is blocked for agents):**
  - must-FAIL (unfixed, `CLAUDE_CONFIG_DIR`+`CLAUDE_STATION_DATA` isolated):
    `containerHistoryDir` = `~/.claude/projects/-workspace-iso-container` → **LEAK**, exit 1.
    Reproduces the round-2 live path exactly.
  - PASS (fixed, same isolated env): host bind = `<scratch>/cfg/projects/-workspace-iso-container`
    → under the isolated store, not the real store, exit 0.
  - anti-regression (fixed, production env — `CLAUDE_CONFIG_DIR` unset): host path
    byte-identical to the legacy hard-coded path, and the full `desiredBinds()`
    session-history entry carries that same path (no OTHER hard-coded real-store path;
    no container drift), exit 0.
  Probes: `/tmp/bug161-wt/probe-bind.mjs`, `/tmp/bug161-wt/probe-prod.mjs`.

- **High-stakes (data-loss / session-lifecycle / regressed-from the isolation-default flip):
  an INDEPENDENT clean-room verify pass is warranted** — re-run the round-2 container-drive
  adversarial case against the patched tree (`live-direct` + `container-sandbox-drive`);
  ideally cross-provider. bubblewrap-sandbox half remains un-runnable (not implemented).

- **Alternative NOT taken (deliberately):** extending `assertSessionStoreIsolated` to the
  container spawn path (defense-in-depth) — the charter directs the ARCH-010 single-authority
  fix, which removes the second derivation at its source rather than adding a second guard.
  Worth considering as additional hardening later, not required for this fix.
