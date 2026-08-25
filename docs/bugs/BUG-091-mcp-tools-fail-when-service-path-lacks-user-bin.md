```orchard-ticket
{
  "id": "BUG-091",
  "type": "bug",
  "title": "MCP servers failed after cold service starts",
  "summary": "The service now supplies user-installed tool locations to every host-side child process at boot. MCP servers previously failed after cold starts with a minimal service environment. Targeted path, host-spawn, runtime, and session suites passed, while leak checks stayed clean.",
  "impact_if_we_wait": "Services using a minimal environment cannot launch MCP tools installed in user directories. Bounded: this affects tool availability after service starts, not stored data, and a service-level path override remains a local workaround.",
  "current_need": "Close the ticket because path and host-spawn tests passed, runtime and session suites passed, and leak checks stayed clean.",
  "severity": "high",
  "area": "MCP server startup",
  "reported": "2026-08-14",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-14",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Host-side descendants can resolve tools installed in the user's local binary directory",
    "Inherited path entries remain ordered and intact, including empty POSIX entries",
    "User binary directories are prepended once without duplicates",
    "Container commands do not receive host-only user paths"
  ],
  "code_refs": [
    {
      "path": "src/server/index.ts",
      "symbol": null,
      "note": "Augments process.env.PATH once during boot so host-side descendant processes inherit user tool directories."
    },
    {
      "path": "src/server/session-host.mjs",
      "symbol": null,
      "note": "The engine spawn previously forwarded the minimal service environment unchanged."
    },
    {
      "path": "scripts/independent-verify.mjs",
      "symbol": null,
      "note": "Clean-room harness used to exercise the cold-start path behavior independently."
    }
  ],
  "related": [
    {
      "id": "BUG-097",
      "relation": "see_also"
    },
    {
      "id": "BUG-118",
      "relation": "blocks"
    },
    {
      "id": "FEAT-086",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "466d25a9-7400-4906-9e14-0aadbdc31235",
      "verdict": "holds",
      "verdict_on": "2026-08-14",
      "harness": null
    }
  ],
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
    "archived_path": "docs/bugs/archive/BUG-091-mcp-tools-fail-when-service-path-lacks-user-bin.md",
    "sha256": "2609ed0ef505b781f8c383c8b84f99a05a7c22d4ee24543f528b43421bff23d7",
    "bytes": 14672,
    "original_title": "MCP servers silently fail to start when the service PATH lacks the user's local bin (post cold-boot)",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the archived ticket; the symptom, root cause, portable fix, initial gaps, environment workaround, test evidence, isolation boundary, and rollback consequences remain.",
    "dropped": []
  }
}
```

# BUG-091 — MCP servers failed after cold service starts

## Diagnosis

A cold boot started the service with `/usr/local/bin:/usr/bin`, excluding `~/.local/bin`. Host-side engine processes inherited that environment unchanged, so MCP children could not resolve `uvx`. Adding `~/.local/bin` made the failing Serena command initialize; removing it produced `uvx: command not found`. The defect affected any user-installed tool or version-manager shim, not only Serena.

## Evidence

The first clean-room check, dispatch run bfc2d932-c5d3-4d87-bcd9-f2883582b381, exposed two gaps: runtime host-spawn sites were missed, and `.filter(Boolean)` removed valid empty POSIX path entries. After the boot-level correction, `verify:sessions` passed 52/52, `verify:bug-091-path-augment` passed 21/21, `verify:bug-091-host-spawn` passed 8/8, and `verify:codex-runtime` passed 54/54. Another recorded tally was 14/14 without an adjacent suite name. `leak-gate` was clean. `verify:mcp-attach` and `verify:bug-090-needs-fork` were mentioned without recorded results.

## Implementation notes

The server augments its own `process.env.PATH` once at boot. This covers the session-host broker, codex runtime, and the Claude SDK's `claude` child through normal environment inheritance. User directories are prepended and deduplicated without discarding inherited or empty entries. Host paths must not become an in-container path.

## Verification plan

Exercise a minimal base environment with a fake home and a stub executable. Confirm the stub is unresolved before augmentation and resolvable afterward. Check prepend order, deduplication, preservation of every base entry, host-spawn inheritance, and container isolation. Run the targeted path, host-spawn, runtime, session, and leak checks in a clean environment.

## Migration and rollback

The existing systemd drop-in remains a local fallback for this installation. Reverting the boot augmentation would restore dependence on service configuration and leave fresh installations exposed after cold starts.

## Risks

The boot environment reaches every host-side descendant, so incorrect ordering or filtering could change tool resolution across sessions. Injecting host directories into container commands would create invalid paths and weaken isolation boundaries.

## Activity log (APPEND-ONLY)
### 2026-08-14 — orchestrator
- Filed after proving the root cause live (uvx at ~/.local/bin; service PATH minimal post cold-boot;
  session-host.mjs:184 spawns engine with inherited env). Drop-in applied out of band for the immediate
  case; this ticket is the portable in-code fix. Dispatched after BUG-090 landed (shared-repo
  serialization); disjoint files (session-host.mjs vs BUG-090's fork.ts/app.js).

### 2026-08-14 — worker (implementation)
Hypothesis CONFIRMED before editing. Architecture verified end-to-end:
- `direct` isolation + survival ON (the deployed systemd path) → `spawnSurvivable` (survival.ts) launches
  `session-host.mjs` into its own scope; the broker spawns the engine at session-host.mjs:184 with
  `env: process.env` — the exact inherited-minimal-PATH site. This is where the fix goes.
- `container` isolation → `execInContainer` → `spawn(docker, execArgv(...))`. `execArgv` (container-manager.ts)
  builds the IN-container env from a FIXED passthrough list (`ENV_PASSTHROUGH` + HOME=/home/claude + exec tag +
  optional browser env) — it never forwards host PATH. So the container command is structurally unaffected by
  the host augmentation; left untouched, as the charter requires.
- `sandbox` → not implemented (throws); no spawn site.

Fix map:
- NEW `src/server/path-env.mjs` — central helper `augmentedPathEnv(baseEnv, homeDir=os.homedir())` +
  `userToolDirs(homeDir)`. PREPENDS `~/.local/bin` (always) and `~/.cargo/bin` (only if the dir exists) to
  PATH, de-duped, dropping NO existing entries; every non-PATH var passed through; base env not mutated. Home
  derived from `os.homedir()` — no hard-coded path (leak-gate PASS).
- `src/server/session-host.mjs` — import the helper; the engine spawn now uses
  `env: augmentedPathEnv(process.env)` (was `env: process.env`). Comment marks it HOST-ONLY.

Verification (`node scripts/verify-bug-091-path-augment.mjs`) — 14/14 PASS. Synthetic, no uvx dependence:
scratch HOME tree with a stub under `.local/bin`; minimal base PATH cannot resolve it (PRE), augmentedPathEnv
resolves it prepended (POST); de-dupe, no-drop, passthrough, cargo present/absent all asserted. Isolation:
direct host env carries the user bin dir; the real `execArgv` output injects no host PATH and never contains the
scratch `.local/bin` (HOME stays `/home/claude`). Must-FAIL proof: reverting the spawn to bare `env: process.env`
→ suite drops to 13/14 (the wiring assertion FAILS), restored to 14/14.

Anti-regressions: verify:sessions 52/52 PASS; leak-gate PASS (0 hits / 399 files); typecheck adds ZERO errors
from these changes (clean HEAD w/o the pre-existing UNTRACKED `scripts/verify-bug-090-needs-fork.ts` = 0 errors;
that untracked file — not mine, not staged — is the sole source of the 2 tsc errors). verify:mcp-attach part A
PASS; part B fails identically on clean HEAD ("no init frame from the CLI" — live-CLI env limitation in this
sandbox, NOT a regression).

Deploy note: takes effect only after a :4317 restart (the running broker/service still has the old code). NOT
restarted/pushed/deployed by this worker.

§N flag: session-lifecycle / spawn-env (every host launch) — HIGH-STAKES. Independent clean-room verify pass
RECOMMENDED (scripts/independent-verify.mjs or a fresh-context agent); generation should not be its own only
verifier.

### 2026-08-14 — orchestrator (independent verify → REOPENED)
Ran the flagged clean-room pass (anthropic verifier, run bfc2d932). Verdict **BROKEN** — the fix is
INCOMPLETE and has one edge bug. The verifier re-ran the fixer's suite (14/14) then broke it with two
adversarial cases it never covered:
- **Missed host spawn sites (root gap).** The first fix patched only `session-host.mjs:184` (the survival
  broker). When survival is OFF (`CLAUDE_STATION_SURVIVE=0` or `systemd-run` absent) or the engine is
  codex, the engine is spawned host-side by the RUNTIMES, which were never touched:
  `src/server/runtime/codex-runtime.ts:375,383` (`const env = { ...process.env }`) and
  `src/server/runtime/claude-runtime.ts` (SDK `query()` passes no env). Verifier proved LIVE: a real
  CodexRuntime host spawn (survival off) gave the child `PATH=/usr/local/bin:/usr/bin` — no `~/.local/bin`.
  So serena still fails in those configurations. The self-verify missed it because it only GREP'd
  session-host.mjs rather than driving a real host spawn.
- **POSIX empty-entry drop.** `src/server/path-env.mjs:59` `.filter(Boolean)` deletes empty PATH fields
  (leading/trailing/doubled `:` = current dir), so `"/usr/local/bin:/usr/bin:"` loses that entry —
  violates "drop no existing entries".

**Follow-up (root fix, §N — fix the design not another local patch):** augment the SERVER PROCESS's own
`process.env.PATH` ONCE at boot (via `augmentedPathEnv`) so EVERY descendant spawn — session-host, both
runtimes, the SDK, and any future site — inherits it, instead of per-site augmentation that misses sites.
Keep session-host's call (belt-and-suspenders) or remove as redundant. Fix `.filter(Boolean)` to preserve
empty entries (dedupe only the user dirs being added). Re-verify with the clean-room pass (now that the
augmented-PATH harness works) and require HOLDS.

### 2026-08-14 — worker (root-fix follow-up)
Fixed BOTH defects the reopen (bfc2d932) proved.

Fix map:
- `src/server/index.ts` — import `augmentedPathEnv` and, as early as practical (module top, right after
  imports, before any engine can spawn), run `process.env.PATH = augmentedPathEnv(process.env).PATH`. This
  is the ROOT-DESIGN fix: EVERY host-side descendant spawn inherits the corrected PATH from the server's own
  env — session-host broker, codex-runtime.ts (`{ ...process.env }`), and claude-runtime.ts's SDK `query()`
  `claude` child (which sets no env). VERIFIED the two sites the verifier broke are now covered by driving a
  REAL survival-off `CodexRuntime` host spawn AND a REAL fake-`claude` SDK spawn (below).
- `src/server/path-env.mjs` — `augmentedPathEnv` no longer `.filter(Boolean)`s the inherited PATH: it
  PRESERVES every existing entry (including POSIX empty fields from leading/trailing/doubled `:`) and
  de-dupes ONLY the user tool dirs it prepends. A genuinely absent/empty PATH still yields no phantom `""`.
- `src/server/path-env.d.mts` — NEW. TS type surface for the `.ts` boot import (mirrors onboard.d.mts /
  board.d.mts); without it `tsc` flags TS7016 on the `.mjs` import.
- session-host.mjs's existing `augmentedPathEnv(process.env)` spawn call — KEPT as harmless
  belt-and-suspenders (re-augments an already-augmented, de-duped PATH; the independent verifier proved the
  double application is byte-identical, empties intact).
- Container path (container-manager `execArgv`) — CONFIRMED untouched; it builds the in-container PATH from a
  fixed passthrough list and never forwards host PATH.

Verification (§C):
- `scripts/verify-bug-091-path-augment.mjs` — 21/21 PASS (was 14; +POSIX empty-entry cases asserting the
  trailing/leading empty survives, +empty-PATH-yields-no-phantom, +index.ts boot-augmentation grep,
  +reframed de-dupe: an already-present dir is not prepended again AND a pre-existing duplicate is preserved
  — dropping no existing entries).
- NEW `scripts/verify-bug-091-host-spawn.mjs` — 8/8 PASS. ADVERSARIAL: drives a REAL `CodexRuntime` host
  spawn with survival OFF (no `spawnProcess`) via a fake codex bin, capturing the child PATH. PRE (no boot
  augmentation) → child PATH LACKS the user bin dir (reproduces bfc2d932's BROKEN); POST (boot augmentation
  applied) → child PATH CARRIES it, at the front, dropping no minimal entry. Also drives a REAL fake-`claude`
  SDK spawn (best-effort — it FIRED here) and asserts the SDK child PATH carries the user bin dir; plus a
  structural check that claude-runtime sets no `env` override (so the SDK child inherits process.env).
- must-FAIL proofs: (a) reverting the index.ts boot line → main suite 20/21 and host-spawn suite 7/8 (the
  index.ts assertions FAIL); (b) restoring `.filter(Boolean)` → main suite 18/21 (the three empty-entry
  assertions FAIL). Both restored to green.
- Anti-regressions: typecheck 0 errors (added path-env.d.mts to clear TS7016); verify:sessions 52/52 PASS;
  verify:codex-runtime 54/54 PASS; verify:mcp-attach Part A PASS, Part B fails IDENTICALLY on clean HEAD
  (`no init frame from the CLI` — live-CLI/auth sandbox limitation, proven pre-existing by a `git stash -u`
  run, NOT a regression); leak-gate PASS (0 hits). New tests use os.tmpdir()/os.homedir() only — no
  hard-coded home.
- regressed-from: BUG-091 (first worker attempt) — the per-site session-host.mjs patch that this ticket
  reopened for missing the runtime host-spawn sites and dropping POSIX empty entries.

Independent clean-room re-verify (§N, high-stakes: session-lifecycle / spawn-env): **HOLDS**. The verifier
re-ran both suites and added its own adversarial cases — including a REAL session-host.mjs broker spawn on an
already-boot-augmented empty-field PATH (proving the double application is byte-identical, empties intact),
and reproduced the container+codex host-binary resolution IDENTICALLY with the boot augmentation removed
(pre-existing, not attributable to this diff). Untested-but-noted by the verifier: the live `claude` CLI's
own MCP-server launch (`env: {}` in tools.ts) was not exercised for lack of a real CLI/uvx — but the whole
root cause (proven at file time) is that MCP servers INHERIT the engine's PATH, so the augmented engine PATH
reaches them; this is the mechanism, not an untested gap.
Verified-by: dispatch anthropic run 466d25a9-7400-4906-9e14-0aadbdc31235 (clean-room, scripts/independent-verify.mjs) — VERDICT: HOLDS.

Deploy note: takes effect only after a **:4317 restart** (the running server still has the old code). NOT
restarted/pushed/deployed by this worker.
