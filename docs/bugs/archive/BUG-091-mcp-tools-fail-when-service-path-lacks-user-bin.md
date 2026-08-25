# BUG-091 — MCP servers silently fail to start when the service PATH lacks the user's local bin (post cold-boot)

- **Status:** VERIFIED (2026-08-14) — root fix landed: the server augments its OWN `process.env.PATH` ONCE at boot (src/server/index.ts) so EVERY host-side descendant spawn (session-host broker, codex-runtime, the Claude SDK's `claude` child) inherits `~/.local/bin`; the two defects the reopen named are fixed (runtime host-spawn sites covered by the boot augmentation; POSIX empty PATH entries now preserved). Independent clean-room re-verify HOLDS. — Verified-by: dispatch anthropic run 466d25a9-7400-4906-9e14-0aadbdc31235 (clean-room, scripts/independent-verify.mjs) VERDICT: HOLDS
- **Prior status (history):** REOPENED (2026-08-14) — independent clean-room verify returned **BROKEN** (the first fix only covered session-host.mjs, MISSED the runtime host-spawn sites, and `.filter(Boolean)` dropped POSIX empty entries). — dispatch anthropic run bfc2d932-c5d3-4d87-bcd9-f2883582b381 VERDICT: BROKEN
- **Area:** src/server/session-host.mjs (engine spawn `env`) + wherever engine/MCP child env is built (runtime)
- **Reported:** 2026-08-14 by user (serena MCP failed to start after a force restart)

## Symptom
After a machine force-restart, sessions launched with `"could not start MCP server: serena"` —
> uvx --from git+https://github.com/oraios/serena serena start-mcp-server … (status: failed)

## Root cause (PROVEN)
`uvx` is installed at `~/.local/bin/uvx` and serena is cached (`~/.cache/uv`, builds+launches fine).
The claude-station systemd unit set only `Environment=PORT=4317` (no PATH), so a **cold boot started
it with systemd's minimal PATH** (`/usr/local/bin:/usr/bin`), which omits `~/.local/bin`. The engine
is spawned with the service env verbatim — `session-host.mjs:184`
`spawn(command, args, { …, env: process.env })` — so every MCP server the engine launches inherits
that minimal PATH and `uvx` is `command not found`.

Proof (§C, both directions): the exact failing command run with `~/.local/bin` prepended to PATH
reaches "Initializing Serena MCP server"; without it, `uvx: command not found`. So PATH is the entire
cause. **Not serena-specific** — any tool in `~/.local/bin` (or a version-manager shim) fails the
same way on any minimal-PATH service start.

## Already applied (environment, out of band — not this ticket's code)
A systemd drop-in (`~/.config/systemd/user/claude-station.service.d/10-path.conf`) now puts
`~/.local/bin` on the service PATH; effective on next restart. That fixes THIS install but not fresh
installs and relies on the unit — hence the portable code fix below.

## Wanted (portable code fix)
When Orchard spawns the engine (host / `direct` + `sandbox` isolation), **augment the child env PATH**
to include the user's local tool dirs (`~/.local/bin`, and `~/.cargo/bin` if present) so
user-installed MCP tools resolve regardless of how the service was started. Requirements:
- **Prepend, don't clobber** — keep the inherited PATH; add the missing user bin dirs in front,
  de-duplicated. Never drop entries the engine needs (node, etc.).
- **Isolation-aware.** For `container` isolation the engine execs INTO the container, where host
  `~/.local/bin` is meaningless (serena there must be in the image) — do NOT inject host paths into the
  container command's in-container PATH. Apply the host augmentation only to host-side spawns
  (direct/sandbox). Confirm how the container path builds env before touching it.
- Central helper (e.g. `augmentedPathEnv(baseEnv)`) so the one rule is testable and reused if there is
  more than one host spawn site.

## Verification (§C)
- **Portable + synthetic (no dependence on uvx):** create a scratch bin dir with a stub executable,
  build a base env whose PATH does NOT contain it → assert the stub is unresolvable; run the base env
  through `augmentedPathEnv` after symlinking/placing the stub in a dir the helper adds (drive the
  helper with a fake HOME) → assert the dir is now on PATH and the stub resolves. Must-FAIL pre-fix:
  the spawn env equals `process.env` with no augmentation.
- Assert **prepend + de-dupe + no dropped entries** (base PATH members all still present).
- Isolation: assert a `direct` host spawn env carries the user bin dir; assert the `container` path
  does NOT inject host `~/.local/bin` into the in-container command.
- Anti-regressions: verify:sessions, verify:mcp-attach (if present), typecheck, leak-gate. Do NOT hard-
  code the home path — derive from `os.homedir()`; keep real paths out of tests (leak-gate).
- **Risk bucket:** session-lifecycle / spawn env (every launch) — HIGH-STAKES per §N. Flag an
  independent clean-room verify pass.

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
