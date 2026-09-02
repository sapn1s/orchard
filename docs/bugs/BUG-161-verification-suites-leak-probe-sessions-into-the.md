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
