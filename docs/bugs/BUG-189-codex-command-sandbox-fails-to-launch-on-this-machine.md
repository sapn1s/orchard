# BUG-189 — Codex command sandbox fails to launch on this machine

- **Status:** IN VERIFICATION — round-3 fix independently re-verified cross-provider (openai) clean-room, VERDICT **BROKEN** (2026-09-27, run 01a0e320): round-2's real finding-1 (SIGTERM-resistant probe defeating the *timeout*) is CONFIRMED FIXED, and findings 3 (--check both modes) + 4 (cwd-keyed probe) hold; but ONE NEW real gap surfaced — the process-group SIGKILL reaps only on the timeout path, so a probe launcher that exits 0 after forking a SIGTERM-ignoring detached child leaves an orphan while the preflight returns success (claim 4 "no orphan survives" violated on the SUCCESS path; practical impact bounded — see Activity). The central guarantee HELD (no quota on an unlaunchable sandbox; no danger-full-access fallback; forbidden/invalid modes rejected pre-API; mode-disagreement + missing-cwd fail safe; version-change cache-bust works). Orchestrator to adjudicate: fix the exit-path orphan reap (then re-verify) vs accept. Cosmetic finding: helper maps forbidden/unknown modes to read-only success internally (no user-facing bypass — dispatch rejects them first). The machine-level codex pin (0.158.0-alpha.15.2) stands: root cause is a codex 0.157.x btrfs bug (upstream #47968, no stable release yet).
- **Severity:** high
- **Area:** server (runtime / codex dispatch)
- **Reported:** 2026-09-27 by verify lane (dispatched, BUG-187 round 5)
- **Verification-class:** fix

## Symptom
Every OpenAI (codex) dispatch is blocked. The codex CLI cannot launch its OS
command sandbox at all:

```
$ codex sandbox -- echo ok
error building bubblewrap command: cannot establish app-server socket mount isolation
```

Because `dispatch.mjs --provider openai` runs through `CodexRuntime` with
`--sandbox workspace-write` (and read-only), which both use this bwrap sandbox,
no OpenAI dispatch — including the clean-room `independent-verify.mjs` route —
can execute a single command. Cross-provider (openai) verification is fully
blocked.

## Repro
Exact, deterministic, no API tokens spent:

1. `codex sandbox -- echo ok` → `error building bubblewrap command: cannot
   establish app-server socket mount isolation` (exit 1).
2. Same with `TMPDIR=/dev/shm` (tmpfs socket dir) → identical error (exit 1).
3. `codex sandbox -c sandbox_mode=danger-full-access -- echo ok` → `ok` (exit 0)
   — bypasses bwrap entirely.

Host: Arch Linux, kernel 7.1.5-arch1-2, btrfs subvol root
(`/dev/nvme1n1p6[/@]`, subvolid=256), bubblewrap 0.11.2, codex-cli **0.157.1**
(now matched to the app-server-daemon; see below).

## Expected
`codex sandbox -- echo ok` prints `ok`, so codex dispatches with
`workspace-write` / `read-only` run their commands and OpenAI verification works.

## Context pack (grows — the "where to look", so no agent cold-starts)
- Files/functions in play: `src/server/runtime/codex-runtime.ts` (assembles the
  codex invocation), `scripts/dispatch.mjs` (exposes only
  `--sandbox read-only|workspace-write`, no danger-full-access path),
  `scripts/independent-verify.mjs` (clean-room route that depends on this).
- The failure is codex-internal: at bwrap launch codex reads
  `/proc/self/mountinfo` to isolate a private app-server exec socket directory
  and rejects this host's mount as unsupported. Binary error strings in the
  codex executable: `cannot establish app-server socket mount isolation`,
  `app-server socket directory has an unsupported host mount at `,
  `app-server socket directory cannot be a sandbox mount root`,
  `mount identity is ambiguous`, `root mount identity is unavailable`,
  `invalid mountinfo path escape`. The relevant toggle
  (`use_linux_sandbox_bwrap`) has been *removed* in this codex line — bwrap is
  now unconditional for workspace-write and read-only.
- Not fixable from Orchard config: relocating TMPDIR / XDG_RUNTIME_DIR to tmpfs
  (`/dev/shm`, `/run/user/1000`), and disabling `code_mode_host` /
  `daemon_auto_start`, all still fail identically (recorded in BUG-187, and
  tmpfs reconfirmed under 0.157.1 here).
- Related tickets: BUG-187 (the verify this blocks; full history there),
  BUG-188 (openai default-model / codex 400).
- Repro test: the three commands under Repro (deterministic, zero API tokens).
- Known dependencies / blockers: this is an environmental / codex-side defect.
  A working but unadopted route exists: `-c sandbox_mode=danger-full-access`
  bypasses bwrap — but it removes the FS write-jail the clean room relies on
  (BUG-112 wall) and `dispatch.mjs` exposes no path to it. Adopting it is a
  decision above a courier's authority (see BUG-187 Decision).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-27 — verify lane (dispatched, BUG-187 round 5)
- **Understood:** BUG-187's round-5 cross-provider (openai) clean-room verify is
  blocked because codex cannot launch its OS sandbox. The standing hypothesis
  (charter-approved) was that the codex CLI/daemon version MISMATCH
  (CLI 0.157.0 vs daemon 0.157.1) caused it, and matching versions would fix it.
- **Changed:** upgraded the codex CLI 0.157.0 → 0.157.1 via codex's own
  standalone updater (`codex update`, which runs the official
  `https://chatgpt.com/codex/install.sh`, the same mechanism that installed the
  prior releases under `~/.codex/packages/standalone/releases/`). No repo files
  changed; no git write. Now matches the app-server-daemon at 0.157.1. Revert if
  needed: `ln -sfn
  ~/.codex/packages/standalone/releases/0.157.0-x86_64-unknown-linux-musl
  ~/.codex/packages/standalone/current` (CLI left at 0.157.1 because it
  now matches the daemon — matched is the coherent state and removes the
  mismatch, which was a real inconsistency regardless).
- **Verified:** must-fail proof: `codex sandbox -- echo ok` → `error building
  bubblewrap command: cannot establish app-server socket mount isolation`
  (exit 1) — BEFORE and AFTER the upgrade, identical. `TMPDIR=/dev/shm codex
  sandbox -- echo ok` → identical error (exit 1) under 0.157.1 (reconfirms the
  BUG-187 tmpfs note). `codex sandbox -c sandbox_mode=danger-full-access -- echo
  ok` → `ok` (exit 0) under 0.157.1.
- **Hypothesis result: REFUTED.** The version mismatch was NOT the cause.
  Matching CLI to the 0.157.1 daemon leaves the failure byte-for-byte identical.
  The root cause is codex's bwrap app-server-socket mount-isolation check
  rejecting this host's mount layout (btrfs subvol root, kernel 7.1.5) — and it
  rejects a tmpfs socket dir too, so it is not merely the btrfs subvol. This is
  environmental / codex-side, not an Orchard bug.
- **Still open / handoff:** OpenAI dispatch remains fully blocked. Next agent:
  do NOT re-test the version mismatch (settled here). The live options are the
  three in BUG-187's Decision: (a) authorize danger-full-access for the clean
  room with an added FS mitigation; (b) fix/downgrade codex so bwrap works on
  this host (try an older codex line where `use_linux_sandbox_bwrap` still
  toggles bwrap off, or report upstream); (c) accept the round-3 same-provider
  HOLDS as sufficient and retire the cross-provider requirement. This is a
  human/orchestrator decision.
- **Symptom of a deeper design flaw?** (open — not closing) The clean-room verify
  contract silently depends on codex's private sandbox being launchable on the
  host; a single environmental change (codex removing the bwrap toggle) took the
  entire OpenAI verify route offline with no fallback. Worth an ARCH look if it
  recurs.

### 2026-09-27 — fix lane (dispatched, BUG-189 round 1) — root cause found, fixed by codex upgrade; ready for independent verify

- **Understood:** codex refuses to start its command sandbox, so no OpenAI dispatch can run a command. The standing hypothesis was that something on this machine causes it: the socket path, a stale daemon, `config.toml`, or how Orchard launches codex. **That hypothesis is only half right.** The trigger is this machine's btrfs root, but the defect is in codex, and codex has since fixed it upstream.
- **Root cause (PROVEN, from the codex source and this machine's own mount data):**
  - The error string comes from `codex-rs/linux-sandbox/src/daemon_mounts.rs` → `check_mounts()` (openai/codex at tag `rust-v0.157.1`). It is called from `bwrap.rs` `create_filesystem_args()` on every read-only and workspace-write launch.
  - The socket directory it checks is **hard-coded** as `canonicalize("/tmp")/codex-daemon-<uid>`, which is `/tmp/codex-daemon-1000` here (`codex-rs/uds/src/daemon_directory.rs`). It ignores `TMPDIR` and `XDG_RUNTIME_DIR`.
  - `check_mounts` looks up the directory's mount id (`/proc/self/fdinfo` gives `mnt_id: 31`) in `/proc/self/mountinfo`. It then requires that mount's device to equal the directory's `st_dev`, and returns `invalid()` ("cannot establish app-server socket mount isolation") when they differ.
  - On this machine mount 31 is `/` = btrfs `subvol=/@`, which mountinfo lists as device **`0:28`**. `stat /tmp/codex-daemon-1000` gives **`dev=30`** (`0:30`), which is btrfs's per-subvolume anonymous device. `/`, `/tmp` and `/home` all give `dev=30`. They can never match, so the check fails on every launch. That fits every symptom: it is deterministic, it is independent of the dispatch, and it needs no model call.
  - Upstream fixed exactly this in commit `a708fc6839`, "Handle Btrfs device mismatches when masking daemon sockets (#47968)", 2026-09-24: "Btrfs subvolumes can report an `st_dev` that differs from the device in `/proc/self/mountinfo`, causing daemon socket mount validation to reject valid mounts." GitHub compare shows `rust-v0.157.1` **diverged** from that commit (so it lacks the fix), while `rust-v0.158.0-alpha.15.2` and `rust-v0.159.0-alpha.9` **contain** it. **No stable release has it yet**: the latest stable is 0.157.1.
  - Regression window, proven locally with the release binaries already installed: 0.153.2 → `ok`, 0.155.1 → `ok`, 0.157.0 → error, 0.157.1 → error. The feature arrived in #45984 (2026-09-16).
- **Corrections to earlier entries (PROVEN):**
  - The "tmpfs also fails" result (BUG-187 round 5, and this ticket's first entry) **did not test a tmpfs socket directory**. The path is fixed under `/tmp` and never reads `TMPDIR` or `XDG_RUNTIME_DIR`, so setting those changed nothing. The conclusion drawn from it — "not merely the btrfs subvol" — was wrong. It is the btrfs subvolume.
  - Nothing is stale: `/tmp/codex-daemon-1000` is empty, and the daemon pid recorded in `~/.codex/app-server-daemon/daemon.pid` (1355518) is no longer running.
  - `config.toml` holds only TUI settings, trust entries and one MCP server. None of it is involved.
  - Orchard's launch path is not involved: `dispatch.mjs` → `CodexRuntime` spawns `codex app-server`, and the bare `codex sandbox` fails the same way outside Orchard.
- **Workarounds rejected, with reasons:**
  - `danger-full-access`: the user rejected loosening the sandbox.
  - Downgrading to 0.155.1 (which works): it predates the app-server socket isolation, which is a security hardening, so it also loosens the sandbox.
  - Mounting tmpfs over `/tmp/codex-daemon-1000` or `/tmp`: needs root (there is no passwordless sudo), would change the machine-wide `/tmp` policy in CONVENTIONS, and would hide a live daemon's socket.
  - An Orchard-side `unshare` wrapper: a hack around a bug that is already fixed upstream.
- **Changed (machine-level, reversible; no repo code, no git write):**
  - Installed the official codex **0.158.0-alpha.15.2** with codex's own official installer (`https://chatgpt.com/codex/install.sh --release 0.158.0-alpha.15.2`, `CODEX_NON_INTERACTIVE=1`). This is the same mechanism as the 0.157.1 upgrade. Before running it I downloaded the same package from the GitHub release to scratch and checked its sha256 (`62397c62…b364`) against the digest the GitHub API reports for the asset. The two matched, and the installer verifies digests itself.
  - `~/.codex/packages/standalone/current` → `releases/0.158.0-alpha.15.2-x86_64-unknown-linux-musl`. The installer said PATH was already configured and made no profile edit.
  - **Side effect:** because this is a pinned `--release` install, the installer deleted `~/.codex/packages/standalone/auto-update-version` (it contained `0.157.1-x86_64-unknown-linux-musl`). Scheduled auto-updates will therefore not move codex. That is the right behaviour for now, because "latest" is still the broken 0.157.1. **Do not run `codex update` (latest) until a stable release of 0.158.0 or later exists.** An update to "latest" today would reinstall 0.157.1 and bring the bug back.
  - Backups are in `~/.local/state/claude-station/scratch/b189/backup/`: `auto-update-version` (a copy), `current.target`, `local-bin-codex.target`.
  - Live-process check before the switch: one live Orchard openai dispatch (pid 269667, spawned by the :4317 `claude-station.service`, with `codex app-server` pid 269681) was running at 14:51. I waited for it to exit and confirmed no codex process remained before installing. I restarted and signalled nothing, and the daemon was not running.
- **Revert:**
  - `ln -sfn ~/.codex/packages/standalone/releases/0.157.1-x86_64-unknown-linux-musl ~/.codex/packages/standalone/current && cp -a ~/.local/state/claude-station/scratch/b189/backup/auto-update-version ~/.codex/packages/standalone/`. This restores 0.157.1 and puts it back on the auto-update channel, and it brings the bug back.
  - To go forward instead: once a stable 0.158.0 or later ships, run `codex update`.
- **Verified (real output, this machine):**
  - Must-FAIL, anchored to a fixed binary rather than a moving baseline: `~/.codex/packages/standalone/releases/0.157.1-x86_64-unknown-linux-musl/bin/codex sandbox -- echo ok` → `error building bubblewrap command: cannot establish app-server socket mount isolation`, exit 1. I re-ran it after the fix and it still fails, so the proof stays reproducible.
  - After the fix: `codex --version` → `codex-cli 0.158.0-alpha.15.2`. `codex sandbox -- echo ok` → `ok`, exit 0. `codex sandbox -c sandbox_mode=read-only -- echo ok-ro` → `ok-ro`, exit 0.
  - Sandbox jail and mask intact (alpha run from scratch, before the install):
    - read-only: `touch ~/b189-probe` → `Read-only file system`.
    - workspace-write: writing inside cwd works, `touch` outside cwd → `Read-only file system`, and `ls /tmp/codex-daemon-1000` → `Permission denied` (the socket directory is masked).
    - The probe file does not exist afterwards.
  - Real Orchard dispatch, read-only: `node scripts/dispatch.mjs --provider openai --cwd <scratch ws> --sandbox read-only …` → `[dispatch] tool commandExecution: {"command":"/usr/bin/bash -lc 'echo ok-ro-189'"…}` then `tool result (ok)`, output `ok-ro-189`, exit 0. Thread `01a0e2b6-5436-7753-8b08-e69e738bb88c`, 15.2k tokens.
  - Real Orchard dispatch, workspace-write: the command ran, output `ok-ww-189`, and `ww.txt` was created in the workspace. `touch ~/b189-escape-probe` → `Read-only file system`, `outside=1`, so the jail holds.
  - Real `independent-verify.mjs` route: `--range 3e7a3f1 --provider openai --run "grep -n -i 'npm ci' CONTRIBUTING.md"` built a clean room and dispatched with `sandbox workspace-write`. It ran 3 manifest-recorded commands through `./vrun.mjs`. The one `tool result (error)` was the verifier's own grep quoting, which it said so itself and corrected. Result: `VERDICT-CONTRACT: VALID (verdict HOLDS …)`, exit 0, dispatch openai run `01a0e2b7-5bd3-7e01-8ca5-b19bf15720dc`, 22.9k tokens.
  - `rg 'bubblewrap|mount isolation'` over all three transcripts: 0 hits.
  - Everything above ran against the real machine and real codex, not a fixture. The clean-room target was a real committed revision.
- **No Orchard code change, so no `scripts/verify-*`.** The root cause is in codex and there is nothing in the dispatch path to fix.
- **Still open / handoff:**
  1. Independent clean-room verify owed. This is regression-prone and sits on the verify route itself; running the owed BUG-187 cross-provider (openai) round is a natural combined check.
  2. When a stable codex ≥ 0.158.0 ships, switch back to the stable channel (`codex update`) and re-run `codex sandbox -- echo ok`.
  3. Suggested, not built (orchestrator decision): a zero-token preflight in `dispatch.mjs --provider openai` that runs `codex sandbox -c sandbox_mode=<mode> -- true` and fails fast with the codex error. BUG-187 round 5 burned about 127k tokens discovering this through real dispatches.
- **Symptom of a deeper design flaw?** Open, and carried forward from the first entry: Orchard's verify route depends on the host codex version with no pinning and no preflight. One upstream regression took it offline silently. Worth an ARCH look if this recurs.

### 2026-09-27 — BUG-189 preflight, round 2 (dispatched, fixing/round 2/class fix)

- **Understood:** the machine-level fix (pin codex 0.158.0-alpha.15.2) is in place, but nothing stopped the SILENT-then-expensive failure mode from recurring — `codex update` reinstalls the broken 0.157.1 as "latest", and a broken sandbox surfaces only AFTER an API turn starts (BUG-187 round 5 burned ~127k tokens finding it). Built the round-1 handoff item #3: a zero-token sandbox preflight on the OpenAI dispatch path.
- **Changed (Orchard code; no git write):**
  - `scripts/lib/codex-sandbox-preflight.mjs` (new) — resolves the SAME codex binary dispatch.mjs's openai path spawns (imports `detectCodex` so the binary fact stays owned by codex-runtime.ts, ARCH-010), runs `codex sandbox -c sandbox_mode=<mode> -- true` (a real bwrap launch of `true` — no API call, zero tokens), and returns ok/version/binary/errorLine. Success is cached per binary-realpath + version + mode for the process (5-min TTL); a version change (the `codex update` recurrence) busts the cache. `formatPreflightFailure()` prints version, binary, the codex error line, the BUG-189 pointer, and the pin/`do-not-update` note. Never falls back to danger-full-access.
  - `scripts/dispatch.mjs` — `dispatchOpenai()` runs the preflight BEFORE creating the recorder / spawning CodexRuntime; on failure it prints `dispatch failed [sandbox-preflight] …` + the full block and exits 1 before any API call.
  - `src/server/dispatch-client.mjs` — `--check` (direct-checkout branch) now runs the same probe and reports `unavailable` + the codex sandbox reason instead of `available`; healthy prints `sandbox: ok (<version>, <mode>)`. Dynamic import guarded by the checkout-exists branch, so the broker-only deployed copy is unaffected.
  - `scripts/fixtures/codex-fake-app-server.mjs` — additive: the fake now answers `--version` and `codex sandbox … -- true` (healthy exit 0; `CODEX_FAKE_SANDBOX_BROKEN` reproduces the bwrap error; `CODEX_FAKE_EXEC_MARKER` records app-server entry; `CODEX_FAKE_SANDBOX_LOG` counts probes). The app-server readline path is untouched.
  - `scripts/verify-bug-189-sandbox-preflight.mjs` (new).
- **Verified (real commands, real output this machine):**
  - `node scripts/verify-bug-189-sandbox-preflight.mjs` → **25 passed, 0 failed**. Covers (a) broken→fast non-zero exit with the app-server exec marker NEVER written (no API call) + all message assertions; (a-must-fail) a SYNTHESIZED pre-fix dispatch.mjs (preflight block removed) DOES reach app-server on the same broken sandbox (marker written) — the degradation the fix removes, anchored to a constructed variant not a moving baseline; (b) healthy→proceeds (both read-only and workspace-write); (c) `--check` reports failure vs health; (d) caching probes once across two calls and a version change re-probes.
  - Real smoke, actual pinned codex: `ORCHARD_DISPATCH_SOCK= node src/server/dispatch-client.mjs --check` → `openai dispatch: available … sandbox: ok (codex-cli 0.158.0-alpha.15.2, read-only)`, exit 0.
  - Real fast-fail, actual BROKEN 0.157.1 binary via `CLAUDE_STATION_CODEX_BIN`: same `--check` → `openai dispatch: unavailable … reason: codex sandbox cannot launch (codex-cli 0.157.1): error building bubblewrap command: cannot establish app-server socket mount isolation … action: pin a fixed codex … do NOT \`codex update\``, exit 1.
  - Anti-regression: `node scripts/verify-dispatch.mjs` → **24/0** (openai tests [1]-[6] now pass THROUGH the new preflight against the fake); `node scripts/verify-codex-runtime.mjs` → **54/0**. `verify-provider-picker.mjs` → 14 pass / 2 fail, but the 2 are its pre-existing report-only real-codex E2 section (doc-noted P2c limitation, INFO "expected"), independent of this change (it drives app-server directly, not dispatch.mjs).
  - `npm run gate` → **PASS (exit 0)** (leak-gate + check-nul + typecheck).
- **Independent verify:** warranted — this touches the verify/dispatch route itself (regression-prone) and its own suite is generation-verified. A clean-room pass over case (a)/(a-must-fail) and the `--check` path is recommended.
- **Still open / handoff:** unchanged from round 1 — when a stable codex ≥ 0.158.0 ships, switch back to the stable channel (`codex update`); the preflight will keep catching a reinstalled 0.157.1 in the meantime. The zero-token preflight (round-1 handoff item #3) is now built.

### 2026-09-27 — independent cross-provider (openai) clean-room verify of the round-2 preflight — VERDICT: BROKEN (edge findings; core claim HELD)

- **Scope verified:** the round-2 zero-token sandbox preflight — `scripts/lib/codex-sandbox-preflight.mjs` (new), `scripts/dispatch.mjs` (dispatchOpenai preflight), `src/server/dispatch-client.mjs` (`--check` probe), `scripts/fixtures/codex-fake-app-server.mjs` (fixture), `scripts/verify-bug-189-sandbox-preflight.mjs` (new). The `dispatch.mjs`/`dispatch-client.mjs` working-tree diffs were confirmed to be BUG-189-only (no unrelated-lane hunks); all other dirty-tree files were declared out of scope to the verifier.
- **Route:** `scripts/independent-verify.mjs --working-tree --author-provider anthropic --provider openai` (cross-provider, decorrelated). The verifier drove the FAKE codex over the `CLAUDE_STATION_CODEX_BIN` seam for its own sub-runs, so zero API tokens were spent inside the sandbox; only the verifier's reasoning turn used quota (~53k tokens). Real codex on this host is the pinned 0.158.0-alpha.15.2 and its bwrap sandbox launches (`codex sandbox -c sandbox_mode=read-only -- true` → ok, exit 0), so the openai dispatch route is live again.
- **Evidence (contract-VALID, manifest-backed):**
  - (i) Fixer suite re-run once, clean-room: `node scripts/verify-bug-189-sandbox-preflight.mjs` → 25/25 (run c177c00c29c9). Also re-run on the live tree by the courier before dispatch → 25/25.
  - (ii) 5 adversarial runs executed, each its own command+output: `path-swap-cache` run 65157eaa6e75; `termination-resistant-hang` run 36619bbf778f; `workspace-check` run ecbe50c58cf6; `forbidden-modes` run c0bd981dee0d (**ATTACK SURVIVED**); `target-workspace-failure` run a5167dfc61ae (verifier's own invented attack).
  - (iii) Untested list: real codex / real bwrap / kernel sandbox behaviour / actual quota consumption were not exercised (verification restricted to fake binaries, no API calls). This is the standard clean-room limitation; the machine-level real-codex checks are in the round-1/round-2 entries above.
- **Findings — classified real defect vs cosmetic/by-design:**
  1. **REAL, medium (robustness) — timeout not enforced against a SIGTERM-resistant probe.** `preflightCodexSandbox` uses `execFile({ timeout })`, whose default kill signal is SIGTERM; a probe that ignores SIGTERM never resolves, so a 100 ms timeout was still pending after 904 ms and needed an external SIGKILL. The helper advertises a hard timeout and "fail fast"; a hung probe defeats both. Real codex normally dies on SIGTERM (so this rarely bites in practice), but a wedged bwrap could hang the dispatch indefinitely. Fix: `killSignal: 'SIGKILL'` (or a hard timer that SIGKILLs).
  2. **LOW / largely by-design — same-version binary swap within the 5-min TTL served from cache.** Cache key is realpath+version+mode; a bare/unresolvable command name keys on the string, so swapping the underlying binary to a broken one WITHOUT changing the version returns stale success until TTL. The REALISTIC recurrence (`codex update` → broken 0.157.1) changes the version and IS caught (fixer (d) proves it; the verifier's own "freshBroken" shows a cold cache detects it). A same-version different-binary swap is contrived for this bug.
  3. **LOW / by-design — `dispatch-client.mjs --check` probes read-only only.** If workspace-write were broken while read-only healthy, `--check` would still report available. The actual btrfs bug breaks BOTH modes identically, so read-only is a valid proxy; a mode-specific sandbox failure is hypothetical.
  4. **LOW / hypothetical — preflight runs in the dispatcher's cwd, not `--cwd`.** A sandbox that fails only for the target directory would pass the probe and reach app-server. The real bug is about the hard-coded `/tmp/codex-daemon-<uid>` socket dir and is cwd-independent, so this does not affect the failure the fix targets.
- **What HELD (confirmations):** the danger-full-access concern (attack c) SURVIVED — `--sandbox danger-full-access` and invalid modes are rejected with exit 2 BEFORE any app-server entry, and read-only + workspace-write both fail fast with `[sandbox-preflight]` and never reach the API on a broken sandbox; the failure block never offers danger-full-access as a remedy; version-change cache-bust works. So the central requirement — never burn quota when the sandbox can't launch, no danger-full-access fallback, healthy dispatches normally — holds for the real bug; the BROKEN verdict rests on the four edge findings, chiefly finding 1.
- **High-stakes note.** This is the verify/dispatch route itself (regression-prone) — this entry IS the owed independent skeptic pass. Findings 1–4 are edge cases the author's fixture did not model; only finding 1 is a genuine defect worth a code fix. Orchestrator decision owed: fix finding 1 (killSignal) and re-verify vs accept 2–4 by-design with a documented note.
- **Courier caveat (honesty):** the FIRST dispatch (run 01a0e310-1967-7d63-ba84-b4ba8b26441a) returned the same BROKEN substance but was marked contract-INVALID because the courier's `--run` for the fixer test was `node ./vrun.mjs node scripts/verify-…` while vrun records the inner command — the FIXER-TEST citation string then did not match the known-run. Re-run with the bare command string (this entry) validated cleanly. No change to the code or the findings.
- **Verified-by:** openai codex-default run 01a0e313-3920-75d2-b9b4-f7aa73de5cdc (clean-room, `scripts/independent-verify.mjs`, `--working-tree`, `--author-provider anthropic`) — VERDICT: BROKEN. Kept artifacts: clean room `~/.local/state/claude-station/scratch/cleanroom-verify-E1mGPH`, record dir `cleanroom-record-UHaexE` (manifest.jsonl + per-run `.out`).
- **Changed:** this ticket only (append + status header). No src change, no git write.

### 2026-09-27 — BUG-189 fix, round 3 (dispatched, fixing/round 3/class fix)

- **Understood:** round-2 verdict BROKEN on four edge findings. Fixed the one REAL defect (finding 1) and the two low-but-cheap correctness gaps (findings 3, 4); accepted finding 2 by-design with a note.
- **Changed (dispatch-path files only; no git write; Codex pin untouched):**
  - `scripts/lib/codex-sandbox-preflight.mjs` — **finding 1:** replaced `execFile({timeout})` (SIGTERM, uncatchable-hang risk) with a `spawn(detached:true)` + own hard timer that SIGKILLs the WHOLE process group on expiry (reaps a SIGTERM-ignoring bwrap and its children); a timed-out probe now returns `ok:false, timedOut:true` with a clear error line, never a hang, never a false success. **Finding 4:** `preflightCodexSandbox` takes `cwd` (default `process.cwd()`), runs the probe in it, includes it in the result, and keys the success cache by `realpath+version+mode+cwd`.
  - `scripts/dispatch.mjs` — passes `cwd: opts.cwd` to the preflight (finding 4: probe the dispatch's actual `--cwd`).
  - `src/server/dispatch-client.mjs` — **finding 3:** `--check` now probes BOTH read-only and workspace-write; any failing mode → `unavailable` naming that mode; healthy → `sandbox: ok (<ver>, read-only + workspace-write)`.
  - `scripts/fixtures/codex-fake-app-server.mjs` — additive test knobs: `CODEX_FAKE_SANDBOX_BROKEN_MODE` (break one mode only, finding 3) and cwd/mode logging (findings 3/4, caching).
  - `scripts/fixtures/codex-fake-sigterm-hang.mjs` (new) — a fake whose `sandbox` traps SIGTERM/SIGINT and hangs (finding-1 arm).
  - `scripts/verify-bug-189-sandbox-preflight.mjs` — added arms (e) finding-1 SIGKILL enforcement **with a must-FAIL** proving pre-fix `execFile(SIGTERM)` HANGS past the deadline; (f) `--check` catches a workspace-write-only failure + reports both modes; (g) probe runs in the requested cwd and the cache is keyed by cwd (different cwd = miss, same cwd = hit).
- **Finding 2 — ACCEPTED by-design (noted):** the success cache keys on binary realpath + version + mode + cwd within a 5-min TTL. A same-version swap of the underlying binary to a broken one within that window is served stale until the TTL expires. This is accepted: the realistic recurrence (`codex update` → broken 0.157.1) changes the version and IS caught (verify arm (d)); a same-version different-binary swap is contrived, and a 5-min staleness window on a zero-token health probe is a deliberate latency trade-off.
- **Verified (real commands, real output this machine):**
  - `node scripts/verify-bug-189-sandbox-preflight.mjs` → **36 passed, 0 failed** (was 25; +11 round-3 arms incl. the must-FAIL hang proof `(e-must-fail) … HANGS past the timeout` → observed `hung`, and post-fix `(e) resolved well within a bound (SIGKILL enforced)` → `elapsed=423ms`).
  - `node scripts/verify-dispatch.mjs` → **24/0**; `node scripts/verify-codex-runtime.mjs` → **54/0** (anti-regression).
  - Real smoke, pinned codex: `ORCHARD_DISPATCH_SOCK= node src/server/dispatch-client.mjs --check` → `openai dispatch: available … sandbox: ok (codex-cli 0.158.0-alpha.15.2, read-only + workspace-write)`, exit 0.
  - `npm run gate` → PASS (exit 0).
- **Independent verify:** a fresh clean-room pass over the finding-1 SIGKILL arm and the finding-3 `--check` both-modes path is warranted (still the verify/dispatch route).
- **Still open / handoff:** unchanged — switch back to the stable channel once codex ≥ 0.158.0 ships stable; the preflight keeps catching a reinstalled 0.157.1.

### 2026-09-27 — independent cross-provider (openai) clean-room re-verify of the round-3 fix — VERDICT: BROKEN (one NEW real gap; round-2 finding-1 confirmed fixed)

- **Scope verified:** the round-3 fix — `scripts/lib/codex-sandbox-preflight.mjs` (spawn(detached)+own SIGKILL-the-group timer; cwd param + cwd-keyed cache), `scripts/dispatch.mjs` (passes `cwd: opts.cwd` to the preflight), `src/server/dispatch-client.mjs` (`--check` probes BOTH read-only + workspace-write), `scripts/fixtures/codex-fake-app-server.mjs` + `scripts/fixtures/codex-fake-sigterm-hang.mjs` (fixtures), `scripts/verify-bug-189-sandbox-preflight.mjs` (fixer suite). In-scope diff (dispatch.mjs + dispatch-client.mjs) and the three new/changed files were handed to the verifier as `--test-file` bodies + an inlined in-scope diff; the working tree's unrelated concurrent-lane hunks were declared out of scope (the `--working-tree` snapshot diff was 1.58 MB, truncated to 3 KB and explicitly flagged as noise).
- **Route:** `scripts/independent-verify.mjs --working-tree --author-provider anthropic --provider openai` (cross-provider, decorrelated). The verifier drove FAKE codex binaries over the `CLAUDE_STATION_CODEX_BIN` seam / by importing the helper directly for its sub-runs — zero API tokens inside the sandbox; only the verifier's own reasoning turn used quota (~34.7k tokens). Real codex on this host is the pinned 0.158.0-alpha.15.2 and its bwrap sandbox launches, so the openai dispatch route is live (the outer dispatch's own preflight passed: `codex sandbox preflight ok (codex-cli 0.158.0-alpha.15.2, --sandbox workspace-write)`).
- **Evidence (contract VALID, manifest-backed, 8 recorded runs):**
  - (i) Fixer suite re-run EXACTLY ONCE (single FIXER-TEST section): `node scripts/verify-bug-189-sandbox-preflight.mjs` → 36/36 (run e5a925f1581d). Also re-run green on the live tree by the courier before dispatch → 36/36.
  - (ii) 6 adversarial runs, each its own command+output: `missing-cwd` (88bbe7461db6); `mode-disagreement` (842950329c8e); `broken-version-recurrence` (f8977ad2d94b); `ignoring-process-tree` (086e7ca42917); `launcher-exits-child-hangs` (46c263708ee9, **ATTACK SURVIVED — the verifier's own invented attack**); `forbidden-mode-inputs` (677a834c78e4).
  - (iii) Untested list: real codex / real bwrap-on-btrfs / actual API behaviour / real quota were not exercised (fake binaries + API-entry markers only — the standard clean-room limitation; real-codex checks live in the round-1/2/3 entries above).
- **Findings — classified real vs cosmetic/by-design:**
  1. **REAL (verifier: high; courier: robustness gap, practical impact bounded) — the process-group SIGKILL only reaps on the TIMEOUT path, not on a fast success.** `run()` in `codex-sandbox-preflight.mjs` clears its timer and resolves on the launcher's `exit` event without SIGKILLing the group. Attack `launcher-exits-child-hangs`: a probe launcher that forks a SIGTERM-ignoring **detached child** and then exits 0 → the helper returns `{ok:true, cached:false}` in 894 ms while the orphan (pid 718570) stays alive (state `S`, launcher pid 718557 `gone`). So claim 4's "no orphan survives" is violated on the SUCCESS path (round-2 finding 1 — the *timeout*-path hang — IS fixed: `ignoring-process-tree` confirmed both ignoring procs disappear after the deadline). Courier note on severity: against the REAL bug the survivor would be codex's own app-server-daemon (intended, not a leak) and the btrfs failure takes the error/timeout path, not this exit-0 path — so this is a literal-contract robustness gap more than a live token/quota risk. Candidate fix: SIGKILL the group on the exit path too (or only-reap after confirming the group is empty).
  2. **COSMETIC / API inconsistency — the helper silently maps forbidden/unknown sandbox modes to read-only success.** `forbidden-mode-inputs`: any mode ≠ `workspace-write` collapses to `read-only`. But `dispatch.mjs`/`--check` reject forbidden modes BEFORE app-server entry, so NO claim-3 (danger-full-access / invalid-mode) bypass was demonstrated — the user-facing guarantee holds; this is an internal helper-API smell only.
  3. **BY-DESIGN (accepted, as the round-3 note states) — same-version broken-binary swap within the 5-min TTL is served cached success.** Confirmed: switching to broken 0.157.1 changes the version and DOES invalidate the cache for both modes (`broken-version-recurrence`). The realistic `codex update` recurrence is caught; a same-version different-binary swap is contrived.
- **What HELD:** danger-full-access is never offered/reached; forbidden + invalid modes rejected pre-API (attack c held at the dispatch boundary); `--check` catches a mode-DISAGREEMENT (read-only broken while workspace-write healthy, and vice-versa) and names the broken mode; missing/unreadable cwd fails safe; version-change cache-bust works; a broken sandbox never reaches app-server (zero quota). The central requirement — never burn quota on an unlaunchable sandbox, no danger-full-access fallback, healthy dispatches proceed — stands. The BROKEN verdict rests on finding 1 (new, real) plus the cosmetic/by-design findings 2–3.
- **High-stakes note:** this IS the owed independent skeptic pass for round 3 (verify/dispatch route, regression-prone). If finding 1 is fixed, a further clean-room re-run over the exit-path-orphan arm is warranted before commit — generation must not be its own only verifier.
- **Verified-by:** openai codex-default run 01a0e320-8ce9-72b1-8bed-5929df1d4e54 (clean-room, `scripts/independent-verify.mjs`, `--working-tree`, `--author-provider anthropic`) — VERDICT: BROKEN. Kept artifacts: clean room `~/.local/state/claude-station/scratch/cleanroom-verify-flDNrw`, record dir `cleanroom-record-TeDKiz` (manifest.jsonl + per-run `.out`); verdict `~/.local/state/claude-station/scratch/b189-verify-r2/verdict.txt`.
- **Changed:** this ticket only (append + status header). No src change, no git write.

### 2026-09-27 — BUG-189 fix, round 4 (dispatched, fixing/round 4/class fix)

- **Understood:** round-3 verdict BROKEN on one NEW real gap (finding 1: orphan on the success path) plus a cosmetic API smell (finding 2). Fixed both; finding 3 stays accepted by-design.
- **Changed (dispatch-path files only; no git write; Codex pin untouched):**
  - `scripts/lib/codex-sandbox-preflight.mjs` — **finding 1:** `run()` now SIGKILLs the whole process group on the `exit` path too (not only on timeout), so a launcher that forks an in-group child and exits 0 leaves no survivor. **Residual documented in code + here:** a double-forked, `setsid`'d GRANDCHILD gets its own pgid and escapes a by-group kill; `prctl(PR_SET_PDEATHSIG)`/`pidfd`/cgroup reaping is not reachable from stock Node, so that narrow case is accepted, not covered. It does not arise for the real bug (a broken btrfs sandbox takes the error/timeout path; `codex sandbox -- true` on success spawns no daemon of its own — the dispatch's app-server is a separate process the runtime owns). **Finding 2:** the helper now REJECTS any mode other than `read-only`/`workspace-write` (returns `ok:false, exitCode:2`, no probe launched) instead of silently collapsing it to read-only.
  - `scripts/fixtures/codex-fake-orphan-launcher.mjs` (new) — a fake whose `sandbox` forks a SIGTERM-ignoring in-group child, records its pid, and exits 0 (finding-1 arm).
  - `scripts/verify-bug-189-sandbox-preflight.mjs` — added (h) success-path orphan reaping **with a must-FAIL** proving pre-fix leaves the child ALIVE (`process.kill(pid,0)` survival check), and (h) post-fix NO survivor; (i) forbidden/unknown modes (`danger-full-access`, `read-write`, `bogus`, `''`) are rejected and never launch a probe.
- **Verified (real commands, real output this machine):**
  - `node scripts/verify-bug-189-sandbox-preflight.mjs` → **44 passed, 0 failed** (was 36; +8 round-4 arms). Key lines: `(h-must-fail) pre-fix leaves the forked child orphaned but ALIVE` → `alive=true`; `(h) NO survivor — the orphan is reaped on the success path` → `alive=false`; all `(i)` forbidden-mode rejections + `probes=0`.
  - `node scripts/verify-dispatch.mjs` → **24/0**; `node scripts/verify-codex-runtime.mjs` → **54/0** (anti-regression).
  - Real smoke, pinned codex: `ORCHARD_DISPATCH_SOCK= node src/server/dispatch-client.mjs --check` → `openai dispatch: available … sandbox: ok (codex-cli 0.158.0-alpha.15.2, read-only + workspace-write)`, exit 0.
  - `npm run gate` → PASS (exit 0).
- **Independent verify:** a final clean-room re-run over the exit-path-orphan arm (h) and the forbidden-mode rejection (i) is warranted per the round-3 skeptic note.
- **Still open / handoff:** unchanged — switch back to the stable channel once codex ≥ 0.158.0 ships stable; the preflight keeps catching a reinstalled 0.157.1.

### 2026-09-30 — BUG-225 verify lane (transcription)
- **Verified-by:** dispatch openai run 01a0e313-3920-75d2-b9b4-f7aa73de5cdc (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN (transcribed by BUG-225 verify from this ticket's line 194, whose shape the shared reader cannot parse)

### 2026-09-30 — BUG-225 verify lane (transcription)
- **Verified-by:** dispatch openai run 01a0e320-8ce9-72b1-8bed-5929df1d4e54 (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN (transcribed by BUG-225 verify from this ticket's line 230, whose shape the shared reader cannot parse)
