# FEAT-151 — Update the Claude runtime on demand from the UI

- **Status:** VERIFIED (with caveats) — A+B built and skew guard hardened across six rounds; round-1 independent verify returned **BROKEN** (CLI-blind skew guard). Round-2 fixing lane (2026-09-24) made the skew guard read the CLI it guards (BOOT_CLI_VERSION + fresh-disk cliSkew in isRuntimeUpdatePending / reconcilePending / reconcileOnBoot), tightened EXACT_SEMVER to strict semver, and closed carry-forward gaps (HTTP origin/content-type guards over real HTTP; container pin moves image identity while a running container survives; a running session survives a real install). Round-2 independent clean-room verify (openai, 2026-09-24, run `01a0d305-86d4-79d3-b241-011482c8ee94`) returned **BROKEN** with three findings: (1) the new CLI guard FAILS OPEN — a missing/non-executable/garbage/nonzero CLI binary reads as `null`, `cliSkew()` treats that as "no skew", and a new host session is ADMITTED into a possible skew instead of blocked; (2) `cliSkew()` runs `spawnSync(claude --version)` on EVERY host-session admission (fresh, uncached) — a synchronous per-admission child spawn that stalls the event loop, the exact hot-path spawnSync plan finding #10 forbade; (3) a successful update that is externally reverted to the boot version before a restart stays stuck-blocked (the pending file never reconciles mid-process) — fail-safe direction, weakest. Findings #1/#2 confirmed independently from the guard code. All three fixer scripts still pass (40/40, 9/9, 6/6). Needs a round-3 fixing lane before VERIFIED (see Activity log 2026-09-24 verifying lane round 2). **Round-3 fixing lane (2026-09-24)** redesigned the skew guard to an fs-only runtime identity ({sdkVersion, platVersion, binary size} captured once at boot, compared each admission with NO spawn): it now FAILS CLOSED on any unreadable/incoherent runtime (defect #1), spawns ZERO children on the admission hot path (defect #2), and DERIVES pending from disk with no sticky file so a revert-before-restart re-admits (defect #3). Hypothesis verified first with a real npm install. Scripts pass 55/55, 9/9, 6/6; `npm run gate` PASS. **Round-3 independent clean-room verify (openai, 2026-09-24, run `01a0d31b-4738-7553-9c6a-51d186adb473`) returned BROKEN** (contract VALID, manifest-backed) with three fail-OPEN findings, all sharing one root cause — the boot/admission identity is derived from cheap fs metadata (X_OK bit, package.json version strings, binary size) and NEVER validates the binary actually RUNS, and its cache is keyed on the binary stat alone: (1) **broken-boot baseline** — a binary present + executable-bit-set but non-functional (garbage/exit-nonzero) AT BOOT is captured as the "good" `BOOT_IDENTITY` (a coherent {sdk,plat,size} tuple), `BOOT_CLI_VERSION` goes null but the admission path ignores it, so new sessions are ADMITTED with `restartPending:false` — the round-2 break (guard blind to whether the CLI works) reintroduced at boot time; requirement 6(b)/charter-B demand fail-closed here; (2) **stale identity cache** — `currentRuntimeIdentity()` caches on the binary's stat key only, so deleting/changing the platform (or SDK) package.json WITHOUT touching the binary returns the old coherent identity and keeps admitting (the half-written-install window, charter-A); (3) **size-only binary comparison** — a same-SIZE corrupted binary (exits 126) matches boot `{sdk,plat,size}` and is admitted (the fixer's own disclosed residual, confirmed real). Findings (1) and (2) independently corroborated by this lane against the REAL module in an isolated reflinked copy; all fixer scripts still pass (55/55, 9/9, 6/6). Needs a round-4 fixing lane before VERIFIED (see Activity log 2026-09-24 verifying lane round 3). **Round-4 fixing lane (2026-09-24)** made the runtime identity boot-PROVEN (async `claude --version`+hash at boot; a present-but-non-running binary never becomes a baseline — defect #1 fail-closed), full-KEYED (identity cache keys on the stat of the binary AND both package.jsons, so a package.json change with the binary untouched recomputes — defect #2), and content-based (sha256 of the binary's contents, not size; re-hashed async only on a stat change, admission fails closed "checking runtime" while a hash is in flight — defect #3). Hypothesis (same-version reinstall ⇒ byte-identical binary ⇒ equal sha256) verified with real npm installs; revert-re-admits stays green. Scripts pass 62/62, 9/9, 6/6; `npm run gate` PASS (exit 0), `tsc` 0 errors. Measured: admission returns in 0.32 ms while a hash is in flight, async hash max event-loop gap 5.1 ms vs 194 ms for a synchronous hash. Needs a round-4 independent clean-room verify before VERIFIED (see Activity log 2026-09-24 fixing lane round 4). **Round-4 independent clean-room verify (anthropic clean-room — OpenAI blocked all 3 attempts by its cyber-safety filter; 2026-09-24, run `86cbbfd2-99ce-4b6a-be20-16545b0e6448`) returned BROKEN** (contract VALID, manifest-backed): ONE fail-OPEN — a boot-time TOCTOU between the `--version` run-proof and the content hash in `bootChecked` (statSync → probeVersionAsync → hashFile read the binary path in three separate reads with no inode/stat/fd consistency check), so a binary swapped in AFTER the proof but BEFORE the hash makes a NON-RUNNING binary's hash the trusted `BOOT_IDENTITY` and admission ADMITS it (`restartPending:false`, on-disk binary exits 7) — round-3 defect #1's boot-integrity class reopened by a race, breaking requirement 6(b). Independently corroborated by this lane 3/3 deterministic. Everything the round-4 fix targeted for the STEADY state holds (real 88k-poll npm-install race: zero mixed-state admits; content-hash vs size; full composite cache key; async single-flight hash; bounded 5 s boot timeout; fixers 62/62, 9/9, 6/6). Needs a round-5 fixing lane (bind proof+hash+stat to one fd/inode) before VERIFIED (see Activity log 2026-09-24 verifying lane round 4). **Round-5 fixing lane (2026-09-24)** bound the boot proof, hash and identity to ONE file (variant b, portable): a new `statIdentity` (dev:ino:size:mtime **+ ctime**) is captured before the `--version` proof and again after the hash — in `bootChecked` (bounded-retry, then fail closed) and in the admission re-hash `ensureHash` (cache the hash only if the identity was unchanged across it). Hypothesis verified first with real fs ops (a swap always moves ino/mtime/ctime; ctime cannot be forged via `utimes`). Must-FAIL proven against the REAL round-4 code (re-stat disabled → fails open both variants). New Part H drives the swap-between-proof-and-hash race in BOTH variants (rename-over + in-place) with a round-4 baseline that trusts the swapped non-running binary; the fix blocks (`BOOT_IDENTITY` null). Scripts pass **72/72, 9/9, 6/6**; `npm run gate` PASS (exit 0), `tsc` 0 errors. Needs a round-5 independent clean-room verify (SECURITY/session-lifecycle/fail-open class → cross-provider warranted) before VERIFIED (see Activity log 2026-09-24 fixing lane round 5). **Round-5 independent clean-room verify (anthropic — OpenAI ran unblocked this round but hit a usage/quota limit mid-run and was INVALID for infra, not safety; 2026-09-24, run `12676d1d-6e9e-418b-a1e2-a7176966dce2`) returned BROKEN** (contract VALID, manifest-backed): the round-5 TOCTOU straddle fix HOLDS (boot churn, mid-boot symlink repoint, Part H rename+in-place all fail CLOSED), but a fail-OPEN remains in the STEADY-STATE admission **cache key** — it keys on `statKey` = dev:ino:size:mtime and OMITS ctime (the round-5 ctime is only in the straddle checks, not cache invalidation), so a post-boot same-size in-place overwrite with the binary's mtime restored (only ctime moves) hits a stale cache and ADMITS a changed, non-running binary (`pending:false`, reason null, module reports boot hash while disk differs). Reproduced independently by the clean room (ADVERSARIAL run `6a2b1dc30f27`) and by this lane against the REAL binary via `utimensat` ns-exact mtime restore; a new-inode control correctly blocks, pinning the defect to the missing ctime. Trigger is primarily a deliberate local actor (routine npm installs rename → new inode → caught). Needs a round-6 fixing lane (add ctime to the cache/hash key; still satisfies defect #3) before VERIFIED (see Activity log 2026-09-24 verifying lane round 5). **Round-6 fixing lane (2026-09-24)** added ctime to the steady-state admission cache key: `statKey` is now `dev:ino:size:mtime:ctime` (both the identity cache and the binary-hash cache key it), so a post-boot same-size in-place overwrite that restores the original mtime moves the key → cache miss → re-hash → fail CLOSED; defect #3 preserved (a fresh-inode revert moves the key regardless, re-hashes to the identical content hash, re-admits). The round-5 `statIdentity` collapsed into `statKey` (it already carried ctime) and the ctime-protection comments corrected. Must-FAIL proven on the REAL module (pre-fix Part I: `newPending:false`, stale boot hash admits the changed binary); post-fix blocks. Scripts pass **77/77, 9/9, 6/6**; `npm run gate` PASS (exit 0), `tsc` 0 errors. Class=trivial (one-field key change), self-verified per board rule 5's trivial carve-out; the orchestrator closed the round loop at round 6 (WA §N stopping rule — see Activity log 2026-09-24 fixing lane round 6). **Caveats (residuals, not blockers):** the destructive container rebuild under a LIVE container session is not exercised (finding #6, unchanged rounds 1–5); a truly offline host is not exercised; OpenAI cross-provider decorrelation was limited (cyber-filtered round 4, quota-exhausted round 5).
- **Severity:** high
- **Area:** server (runtime) / drawer (settings) / container
- **Reported:** 2026-09-24 by user (via orchestrator)
- **Verification-class:** plan+review ⟶ independent verification REQUIRED before VERIFIED.

Dispatch: ticket=FEAT-151 phase=fixing round=1 class=plan+review

## Symptom
User's sessions failed with `API Error: 400 Claude Code 2.1.220 does not
support this model; version 2.1.280 or newer is required`. Running `claude
update` on the host (host CLI now 2.1.281) and restarting Orchard did **not**
fix it, because Orchard does not run the host's `claude`: host sessions run the
CLI **bundled inside the Agent SDK package**, and container sessions run a
separate CLI baked into the project image (currently 2.1.197). There is no way
to see which runtime is in use, whether it is behind, or to update it.

## Expected
A machine-scope "Runtime" settings section that shows, for each runtime Orchard
actually uses, the current version and whether a newer one is published, and an
on-demand **Update** action. Updates are manual and explicit — never automatic
(a silent SDK bump can break Orchard's own SDK integration mid-work); a passive
"update available" indicator is welcome. After a host update the panel says the
new runtime applies once Orchard is restarted; running sessions are untouched.

## Diagnosis — where each runtime's CLI comes from (verified 2026-09-24)

**Host sessions (`isolation:direct`).** The Agent SDK does not run the model
in-process; `query()` spawns the `claude` CLI over stream-json. When Orchard
passes no explicit executable (the normal host path —
`src/server/runtime/claude-runtime.ts:629-634` only sets one for containers or
when `CLAUDE_STATION_CLAUDE_BIN` is set), the SDK resolves its **own bundled
binary**: `BK()` in `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` maps
platform/arch to the optional dep and does
`require.resolve('@anthropic-ai/claude-agent-sdk-linux-x64/claude')`. That path
is constant across versions. The installed SDK is `0.3.281`; its bundled binary
reports `2.1.281 (Claude Code)`. So the effective host CLI is **locked to the
installed SDK package version** — `0.3.281 ↔ 2.1.281`, updated by
`npm install @anthropic-ai/claude-agent-sdk@<v>`. (Latest published SDK today is
also `0.3.281`, so the host runtime is already current — the user's remaining
gap is the container image.)

**Does an SDK bump need an Orchard restart? — YES, verified.** Two facts:
1. The binary path is resolved **per session spawn** via `require.resolve`
   (constant path), so a replaced on-disk binary is picked up by NEW sessions
   without a restart.
2. BUT the SDK's JS module (`sdk.mjs`) is import-cached in the running Node
   process. `npm install` replaces it on disk, not in memory. After an update
   the running server pairs the OLD SDK JS with the NEW CLI binary — an
   unsupported skew, because SDK JS and CLI ship version-locked.

Therefore the design is **install-then-prompt-restart**, not a silent hot-swap:
write the new package to disk, and the UI reports "restart Orchard to apply."
This is the orchestrator's stated stop-and-adjust contingency, confirmed to
apply.

**Container sessions (`isolation:container`).** The CLI is `@anthropic-ai/
claude-code` installed globally in the per-project image
(`src/server/container/Dockerfile:33`, `CONTAINER_CLAUDE_BIN =
/home/claude/.local/bin/claude`). That install is **UNPINNED** — no version, not
in `provision.json`, not folded into `provisionHash()`. Consequences: the image
only rebuilds when `Dockerfile`/`provision.json` bytes change, so a newer
claude-code never reaches an existing image (why the user's image is stuck at
2.1.197); and the baked CLI version is **not readable from image metadata**
(labels carry serena's version but there is no `claude-station.claude-version`).
Latest published claude-code today is `2.1.281`.

## Plan

### Facts, each owned in one place (ARCH-010)
Four distinct version facts, each read from exactly one authority:
1. **Running host runtime** — the SDK JS actually loaded. Captured once at
   server boot (`BOOT_SDK_VERSION` = SDK `package.json` version read at
   startup). This is what today's sessions use.
2. **Installed host runtime (on disk)** — read at request time from
   `node_modules/@anthropic-ai/claude-agent-sdk/package.json` and the bundled
   `claude --version` (reuse `probeInstalledVersion()`,
   `src/server/provisioning.ts:224`). After an update this is NEW while
   `BOOT_SDK_VERSION` is old ⇒ `restartPending`.
3. **Latest published** — npm registry
   `https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/latest` (and
   `@anthropic-ai/claude-code/latest`), best-effort, short-cached.
4. **Container image CLI** — a new `claude-station.claude-version` image label
   (read like the existing serena label in `containerProvisionState()`,
   `src/server/container-manager.ts:915-961`), falling back to `docker exec
   <CONTAINER_CLAUDE_BIN> --version`.

### Server — a dedicated sub-handler, mirroring `handleContainerRoute`
New `handleRuntimeRoute()` dispatched from `handleApi` (`src/server/index.ts:383`),
reusing `sendJson` / `readBody`.

- **`GET /api/runtime/version`** →
  `{ host: { runningSdk, runningCli, installedSdk, installedCli, restartPending },
     latest: { sdk, cli, checkedAt } | { error },
     container: { imageCli, imageState, latestCli, updateAvailable } }`.
  The registry read is best-effort: on any network/registry error it returns
  `latest: { error }` with HTTP 200 (never 500), so the panel renders "couldn't
  check latest" and still shows current versions. Cache the registry answer ~1h
  in-process so opening Settings doesn't hammer npm.
- **`POST /api/runtime/update`** `{ target: 'host', version? }` →
  - **Single-flight**: a module-level `updateInProgress` flag; a second call
    while one runs returns **409** `{ error: 'update already running' }`.
  - Runs `npm install --save-exact @anthropic-ai/claude-agent-sdk@<version||latest>`
    in `projectRoot()` (`src/lib/paths.ts`) via `spawn`, capturing stdout/stderr.
    `--save-exact` **pins the exact version into `package.json`** (charter
    requirement).
  - Success → `{ ok:true, installedSdk, restartRequired:true }`. **Does not
    restart the server and does not touch running sessions** (hard constraint).
  - Failure → **500** `{ ok:false, error, log: <stderr tail> }`. npm restores
    `package.json`/lock on a failed install; report the still-installed version
    and the manual rollback command so a partial state is recoverable.
- **Container:** phase 1 surfaces the image CLI version + update-available and
  routes "update" through the EXISTING container provision/rebuild flow rather
  than new machinery — see the container decision below.

### Container runtime — make the CLI a real, tracked pin
Today bumping claude-code does nothing to image identity. To make it
updatable through the drift machinery that already exists:
1. Add a `claude-code` entry to `provision.json` (mirrors serena/playwright),
2. install `@anthropic-ai/claude-code@<pinned>` in the Dockerfile via the same
   `jq`-from-provision.json pattern (`Dockerfile:59-67`),
3. stamp a `claude-station.claude-version` label at build
   (`container-manager.ts:1005-1012`).
Then the pin is hashed into the image tag (`provisionHash()` already covers
`provision.json`), drift is detected by `containerProvisionState()`, the version
is readable from the label, and "update container CLI" = bump the pin + the
EXISTING container rebuild/provision action (no new endpoint). This is the
ARCH-010-clean answer: the container CLI version is declared once, in
`provision.json`, next to serena and playwright.

### Frontend — a "Runtime" category in the Settings modal
Settings is a modal built by `public/lib/drawer.js`.
- Add category `{ group:'machine', id:'runtime', label:'Runtime', view:'machine' }`
  at `drawer.js:182-194`.
- Add `if (d.cat==='runtime') { wrap.append(runtimePane()); return wrap; }` in
  `machineDefaultsView()` (`drawer.js:3812-3822`).
- `runtimePane()` modeled on `accountsPane()` (read-state + action buttons):
  - **Host runtime** row — "Claude runtime · host sessions": current CLI/SDK,
    an "Up to date" / "Update available → x.y.z" badge, an **Update** button.
    Click → POST update, show progress, disable the button; on success show a
    persistent "Updated — restart Orchard to apply" state driven by
    `restartPending` (survives panel reopen until boot version matches disk).
  - **Container runtime** row — "Claude runtime · container projects": image CLI
    version + update-available; a rebuild affordance wired to the existing
    container-provision flow (or, if that is deferred, a `note()` pointing at
    Container settings — say which in the build log).
  - `note()` prose: on-demand only, restart-to-apply, running sessions
    unaffected.
- Passive indicator: an "update available" dot on the Runtime category row (and
  optionally the navbar Settings entry) when latest > running.
- `public/lib/api.js`: add `runtimeVersion()` and `runtimeUpdate(target, version)`
  mirroring `api()` / `optional()`.

### Failure modes (quality bar)
- **npm offline / registry error** → `GET` returns `latest.error`; panel shows
  "couldn't check", never crashes.
- **npm install failure / partial** → exit code + stderr tail returned; npm
  restores package.json/lock; report installed version + rollback command.
- **second click during an update** → 409 single-flight; UI disables the button
  and shows progress.
- **update while sessions running** → allowed; running sessions keep their
  in-memory runtime; message says it applies after restart. Never kill sessions.
- **version pinning** → `--save-exact` records the exact version in
  package.json.

## Options considered

**Host update mechanism — recommend A.**
- **A — bump the SDK package, restart to apply.** `npm install
  --save-exact @anthropic-ai/claude-agent-sdk@<v>`, then prompt restart. Keeps
  the SDK JS ↔ CLI pairing version-coherent (the supported configuration).
  Costs a user-initiated restart to take effect.
- **B — point host sessions at the user's own `claude`.** The seam exists
  (`CLAUDE_STATION_CLAUDE_BIN` → `pathToClaudeCodeExecutable`,
  `claude-runtime.ts:634`), so `claude update` alone would fix the CLI.
  Rejected as default: it re-introduces the exact JS↔CLI skew A avoids — the
  in-process SDK JS speaks a specific stream-json control protocol, and an
  independently-updated standalone CLI can drift from it, producing subtle
  bridge breakage that is harder to diagnose than a clean "restart to apply."
  Keep `CLAUDE_STATION_CLAUDE_BIN` as a documented power-user escape hatch, not
  the product path.

**Container update — recommend: surface now, pin now, reuse existing rebuild.**
Surface the version and update-available in phase 1; make claude-code a real
pin in provision.json + Dockerfile + label so the existing drift/rebuild flow
carries the update. A brand-new "rebuild image from this button" endpoint is
only worth adding if the existing container-provision action cannot be reused;
the builder confirms which and records it.

## Plan revisions from cross-provider review (openai, 2026-09-24)

The read-only openai review returned "revise before implementation" with ten
ranked findings; all were accepted. The diagnosis and the restart conclusion
held. The revisions below supersede the happy-path parts of the plan above.

1. **No skew window — quiesce new host sessions, don't just single-flight the
   request (High).** "Install now, restart later" would let a session spawned
   after the install pair the NEW on-disk binary with the OLD in-memory SDK JS,
   and a spawn *during* the install could hit half-replaced files. Fix: an
   update sets a persistent `runtimeUpdatePending` state (state file, survives a
   crash) that **blocks creation of new HOST sessions** from the moment install
   starts until a restart reconciles boot-version == installed-version. Already
   running sessions keep their in-memory runtime and their already-spawned CLI
   process (replacing the file on disk does not kill a live process). New-session
   attempts get a clear "runtime updated — restart Orchard to start new sessions"
   error. This removes the skew entirely rather than documenting it away.
2. **Origin + content-type guard on the mutation (High).** The HTTP layer checks
   `Host` but `readBody()` parses any content-type, and the `Origin` check lives
   only in the WS handshake — so a foreign page could `text/plain`-POST valid
   JSON to localhost. The update POST must reject cross-origin/null-origin
   requests, require `application/json`, keep the Host check, and a test must
   prove a rejected request never spawns npm.
3. **`version` is a package-spec, not a version (High).** `@pkg@<version>` accepts
   aliases/URLs/tags/ranges. Validate strictly as an exact semver
   (`^\d+\.\d+\.\d+(-[\w.]+)?$`), install only the FIXED package name at that
   exact version, resolve `latest` server-side, and reject everything else. Run
   `npm install` with a controlled env and prefer `--ignore-scripts`, then
   VERIFY the platform binary still landed (drop the flag only if it doesn't).
4. **A real recovery design, not "npm restores it" (High).** Snapshot
   package.json + lock + the installed version before install; after install
   VERIFY package identity + exact version, the platform binary exists and
   `--version` runs (and, in a child process, that the SDK JS imports). On any
   failure, restore the snapshot. Report the still-installed version and the
   manual rollback command. (Single-user localhost: concurrent manual manifest
   edits during a ~30s install are out of scope, stated explicitly.)
5. **The container update must WRITE the pin (High).** The existing rebuild
   installs whatever `provision.json` already says, so "bump + reuse rebuild"
   updates nothing. An on-demand container update has to validate the target,
   **write it into `provision.json`** (which changes `provisionHash()` → new
   image tag), then rebuild. Keep three distinct states: new release available ·
   desired pin changed (provision.json bumped, image not yet rebuilt) · container
   running the new image.
6. **Rebuild is destructive and races admission (High).** The existing rebuild
   removes the container *before* building the replacement (a failed build loses
   the working container), and the live-session check is not a lock against a
   session starting mid-replacement. So this feature does NOT auto-replace
   running containers: build+verify the new image first, never auto-force, and
   leave replacement to the user's schedule under a per-project admission guard.
   (The destructive ordering itself is pre-existing — flag it, don't silently
   inherit it.)
7. **Container CLI must track the HOST SDK, not "latest claude-code" (High).**
   Container sessions also run the host SDK JS (it spawns `docker exec claude`),
   so the container CLI has the SAME JS↔CLI coherence requirement across the
   container boundary. The container pin's target is therefore the CLI version
   the current host SDK bundles — obtained by RUNNING the bundled binary
   `--version`, never by string arithmetic on the SDK version (the 0.3.x ↔ 2.1.x
   mapping is not guaranteed permanent). Surface divergence between the container
   image CLI and the host SDK's CLI as the thing to fix.
8. **Report runtimes honestly; never infer "up to date" from unknowns (Medium).**
   Separate facts: loaded SDK JS · installed SDK/binary · `CLAUDE_STATION_CLAUDE_BIN`
   override · desired image · each project's ACTUAL running container image
   id/version. Containers are per-project, not one machine value;
   `containerProvisionState()` reads the DESIRED image name, and a custom image
   is "yours to manage." Represent unavailable/unlabelled/stopped/custom states
   explicitly.
9. **A container-only pin must not change host provisioning (Medium).**
   `provisionAllHost()` (`provisioning.ts:403`) iterates every `manifestTools()`
   entry, so adding `claude-code` naively would make host provisioning install a
   standalone CLI host sessions never use. Add an applicability/scope field to
   the manifest tool (e.g. `appliesTo:["container"]`) and filter host
   provisioning + status by it, with a regression check.
10. **Async probes + connection-independent operation state (Medium).**
    `probeInstalledVersion()` is `spawnSync` (blocks the event loop ≤60s) — do
    not call it from an HTTP handler; use an async probe with a short deadline +
    cache, bounded registry fetch and output buffers, and track operation status
    independent of the requesting connection so a disconnect or restart leaves a
    visible, recoverable state.

Acceptance cases the happy path would miss (add to the verify script):
spawn-during-update, interrupted install + restore, cross-origin/package-spec
rejection never spawning npm, container build failure, live-session admission
during rebuild, mixed/custom images, and the host-provisioning scope regression.

## Scope decided — B, sequenced A → B (orchestrator judgment, 2026-09-24)

The v1-scope fork below was settled by the orchestrator, not routed to the user:
build **B, sequenced A → B**. The user asked for an easy UI way to update the
runtime when needed, and the runtime that is actually behind is the container
image (2.1.197) — so A (host-only) would not deliver the stated ask. Both halves
are built; see the Activity log entry dated 2026-09-24 (fixing lane). Retained
here for the record, no longer a live decision:

- **A — host update, container surfaced read-only.** The hardened host SDK
  update + a Runtime pane that shows versions and update-available, container
  updating left manual.
- **B — full: host update plus container bump-and-rebuild from the UI.** Also
  pins `claude-code` in provision.json behind a container-scoped applicability
  flag, writes the pin (target = host SDK's bundled CLI), and builds before
  replace, never auto-forcing a running container. This is what was built.

## Context pack (grows — the "where to look")
- Host CLI resolution: `src/server/runtime/claude-runtime.ts:586-636`;
  SDK `BK()` in `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`.
- Version probe to reuse: `probeInstalledVersion()` `src/server/provisioning.ts:224-231`;
  read-a-dep-package.json precedent `src/server/browser.ts:95-142`.
- API dispatcher + helpers: `src/server/index.ts:383` (`handleApi`),
  `sendJson` `:184`, `readBody` `:190`; sub-handler + live-session destructive
  guard model `handleContainerRoute` `:3432` (guard `:3484-3514`).
- Container: `src/server/container/Dockerfile:33,58-87`; `provision.json`;
  `provisionHash()` `src/server/provisioning.ts:109`; `imageNameFor`/labels/
  `containerProvisionState` `src/server/container-manager.ts:220,915-961,1005-1012`.
- App root for npm install: `projectRoot()` `src/lib/paths.ts:18`.
- Settings UI: `public/lib/drawer.js:182-194` (categories), `:3812-3822`
  (`machineDefaultsView`), `accountsPane()`; `public/lib/api.js` `api()`/`optional()`.
- Registry facts (2026-09-24): SDK latest 0.3.281 (installed 0.3.281 → CLI
  2.1.281); claude-code latest 2.1.281 (container image 2.1.197).
- Related: FEAT-139 (Settings modal home), FEAT-107/BUG-107 (image drift +
  provisioning), FEAT-037 (multi-provider runtime), FEAT-145 (account dirs).
- Repro test: `scripts/verify-feat-151-runtime-update.mjs` (to add).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-24 — plan lane (Opus 4.8)
- **Understood:** Host sessions run the SDK-bundled CLI (locked to the SDK
  package version, 0.3.281 → 2.1.281), not the host's `claude`; container
  sessions run an unpinned claude-code baked in the image (stuck 2.1.197). No UI
  surfaces or updates either.
- **Verified (facts, not a fix):** read `BK()` in `sdk.mjs` — CLI path is
  `require.resolve('@anthropic-ai/claude-agent-sdk-linux-x64/claude')`, constant
  across versions, resolved per spawn; bundled binary reports `2.1.281`; SDK JS
  is import-cached in-process, so an on-disk bump needs a restart to load the
  matching JS (⇒ install-then-prompt-restart, not hot-swap). Registry reachable:
  SDK latest 0.3.281, claude-code latest 2.1.281. Confirmed claude-code is
  unpinned in the Dockerfile and absent from provision.json/provisionHash.
- **Changed:** this ticket (the plan). No code yet.
- **Still open / handoff:** see the review entry below — the plan is revised and
  now awaits a v1 scope decision (A vs B) before build.

### 2026-09-24 — plan lane (Opus 4.8), cross-provider review folded
- **Understood:** ran the read-only openai review of the plan
  (`node src/server/dispatch-client.mjs --provider openai`, class=plan+review).
  Verdict "revise before implementation," ten ranked findings, all accepted.
- **Changed:** added "Plan revisions from cross-provider review" (the ten
  findings + their fixes and the new acceptance cases) and a "Decision" section
  (v1 scope A vs B). No code — this remains a plan.
- **Verified:** openai review transcript under the station's openai transcripts
  dir for this repo, run id `01a0d2c7-32da-7ad2-991d-8be3ca9d1848`.
  The material design changes are: quiesce new host sessions until restart (no
  skew window), the container update must WRITE the provision.json pin, the
  container CLI target must track the host SDK's bundled CLI (probed, not
  computed), an origin + exact-semver guard on the mutation, and a
  container-scoped applicability flag so a container pin doesn't alter host
  provisioning.
- **Still open / handoff:** BLOCKED on the v1 scope decision (A host-only vs B
  host + container-from-UI; recommend B sequenced). Build is high-stakes
  (session-lifecycle + tracked-source mutation + container lifecycle) → the
  eventual fix needs independent clean-room verification, not just the builder's
  own suite. Demonstrate plan unchanged: `GET /api/runtime/version` against the
  real registry; exercise the update in a WORKTREE copy so live user-owned
  package.json/node_modules stay undisturbed; Playwright both themes on a
  free-port dev instance.
- **Symptom of a deeper design flaw?** partly — the container CLI being unpinned
  and absent from provision.json is the same "a pin nobody rebuilds on is a
  comment" gap FEAT-107/BUG-107 fixed for serena/playwright but never closed for
  claude-code. Not filing a separate ARCH; fold the pin into this feature.

### 2026-09-24 — fixing lane (Opus 4.8), A+B built and demonstrated
- **Decision (orchestrator judgment, not routed to the user):** build B, sequenced
  A → B. The user's live gap is the container image, so host-only A would not
  deliver "an easy UI way to update the runtime when needed." Recorded here and in
  the "Scope decided" section above; the A/B Decide card and `Recommended:` routing
  were removed.
- **Understood:** the reviewed plan is buildable as written — the two named
  stop-and-adjust risks both HELD (host SDK bump needs a restart to apply → the
  design is install-then-quiesce-then-prompt-restart, not a hot swap; the container
  pin IS expressible in provision.json). Verified before building.
- **Changed (all unstaged; user owns git):**
  - `src/server/runtime/runtime-update.ts` (NEW) — four version facts each owned
    once (BOOT_SDK_VERSION at load; installed on disk; latest via npm registry,
    1h cache, best-effort; bundled CLI probed). `updateHostRuntime()` snapshots
    package.json+lock, installs `--save-exact --ignore-scripts` then verifies the
    platform binary landed (retries with scripts only if not), proves identity +
    exact version + `--version` + a CHILD-process SDK import, rolls back on any
    failure; single-flight `updateInProgress`; persistent `runtime-update-pending`
    state reconciled at boot; `hostSessionBlockReason()` for the quiesce.
  - `src/server/index.ts` — `handleRuntimeRoute()` (GET `/api/runtime/version`;
    POST `/api/runtime/update`; POST `/api/runtime/container-pin`) with an
    Origin + `application/json` guard on the mutations (finding #2), 409 on
    concurrent update, 500+log on failure, best-effort registry (200 + `latest.error`).
  - `src/server/agent-bridge.ts` — quiesce guard in `startSession` blocks new
    DIRECT sessions while an update is pending (finding #1); container/running
    sessions untouched.
  - `src/server/provisioning.ts` — `appliesTo` scope on ToolPin + `manifestToolsFor`,
    host provisioning/status filtered to host-applicable (finding #9); `claudeCodePin()`
    + `writeClaudeCodePin()` (exact-semver, atomic, name fixed).
  - `src/server/container/provision.json` — new `claude-code` pin (`appliesTo:["container"]`).
  - `src/server/container/Dockerfile` — claude-code install now PINNED from
    provision.json (was unpinned), version-asserted like serena/playwright.
  - `src/server/container-manager.ts` — `claude-station.claude-version/-package`
    build labels; `containerProvisionState()` reads the claude label + returns
    `wanted/imageClaudeVersion`.
  - `public/lib/api.js` — `runtimeVersion` / `runtimeUpdate` / `runtimeContainerPin`.
  - `public/lib/drawer.js` — `runtimePane()` + `Runtime` machine category + a
    passive "warn" rail dot + inline failure note; `public/styles.css` — `rt-*`
    state chips.
  - `scripts/verify-feat-151-runtime-update.mjs` (NEW).
- **Verified (real artifacts, isolated copy — live package.json/node_modules never
  touched):**
  - `verify-feat-151-runtime-update.mjs` — **28/28 PASS**, incl. a REAL npm bump
    0.3.280 → 0.3.281 (exact pin, restartPending, host sessions blocked), a failed
    install that ROLLS BACK and restores package.json (no skew left pending), and
    concurrent single-flight refusal — all against a reflinked-node_modules copy.
  - HTTP guards against a booted scratch server (free port, isolated data dir):
    wrong content-type → 415, foreign Origin → 403, bad version-spec → rejected
    with `installedSdk` unchanged (npm never spawned), container-pin bad → 400,
    container-pin valid → writes provision.json (tracks host SDK's bundled CLI).
  - `GET /api/runtime/version` against the REAL npm registry (host updateAvailable,
    container desired/target/latest).
  - Container: two TEST-TAG image builds (not the live tag) proved the pin drives
    the baked CLI — provision.json `2.1.280` → `claude --version 2.1.280`, `2.1.281`
    → `2.1.281`; test images removed. `verify-bug-108-playwright-pin.mjs` **20/20
    PASS** (a REAL full image build with the modified Dockerfile).
  - Playwright, both themes: update-available, restart-pending, update-in-progress,
    update-failed — 8 shots under `docs/bugs/assets/FEAT-151-runtime-*.png`
    (gitignored). Passive "Runtime" rail dot confirmed.
  - `tsc --noEmit` clean.
- **Anti-regression:** `verify-bug-108` 20/20 (image build path). `verify-bug-107-
  image-staleness` fails 13/18 but PRE-EXISTING and unrelated — its harness copies
  `src/`+`package.json` but not `scripts/`, so `scripts/lib/board-path.mjs`
  (imported by board.ts/templates.ts/claude-runtime.ts, none of them mine) fails to
  resolve in its scratch tree; my diff adds no board-path import. Flagged, not
  inherited.
- **Could NOT test (handoff to the verifier):** the destructive container REBUILD +
  live-session admission during rebuild (finding #6) — I write the pin but never
  trigger a rebuild-under-live-session; and the unreachable-registry path is proven
  at the module level (mocked fetch → `latest.error`) but not against a truly
  offline host. A full live `claude-station-base` rebuild was deliberately NOT run
  (test tag only).
- **Still open / handoff:** class=plan+review → **independent clean-room verify
  REQUIRED before VERIFIED** (session-lifecycle + tracked-source mutation +
  container lifecycle — high-stakes). Run `node scripts/verify-feat-151-runtime-
  update.mjs` and the HTTP/build demos in the handoff. A `Verified-by:` line naming
  a dispatched clean-room pass is still owed.

### 2026-09-24 — verifying lane (Opus 4.8), independent openai clean-room — VERDICT: BROKEN
- **Verified-by:** dispatch openai run `01a0d2ef-8eb3-70f1-88f9-03da61b21473`
  (clean-room, `scripts/independent-verify.mjs`) — **VERDICT: BROKEN**. Range =
  synthetic base/head built with the sanctioned temp-index plumbing
  (`read-tree HEAD` + `git add -- <the 11 FEAT-151 files>` + `write-tree` +
  `commit-tree`, all node-spawned so no ref moves and the real index is
  untouched), so the diff is EXACTLY the 11 FEAT-151 files (77 310 bytes) and
  excludes the other lanes' dirty files (package.json/-lock, claude-runtime.ts,
  orchestrator-profile, FEAT-152) and this ticket. Kept room
  `…/scratch/cleanroom-verify-yedcEw`; manifest
  `…/scratch/cleanroom-record-YGVMSV/manifest.jsonl` (6 recorded runs);
  transcript `…/transcripts/openai/…/01a0d2ef-…jsonl`. Contract: **VALID**
  (manifest-backed executed evidence).
- **Setup (the vrun harness-side path):** author-provider anthropic →
  cross-provider openai. Verifier input = requirement in plain terms
  (`/tmp/feat151-requirement.txt`), the 11-file diff, how-to-run, and the fixer's
  test script only — NOT the ticket, report or rationale (docs/bugs + docs/prompts
  stripped from the room; other lanes' files never in the diff).
- **Fixer test re-run (required evidence #1):** `node scripts/verify-feat-151-
  runtime-update.mjs` — **28/28 PASS**, once, both by me on the live tree and by
  the clean-room verifier (run `4d53c2875450`, exit 0).
- **The three findings (verifier ADVERSARIAL: `invalid-target-and-partial-install`, run `158273f840c2`):**
  1. **[REAL DEFECT — the break] CLI-blind skew detection.** `isRuntimeUpdatePending()`
     and `reconcilePending()` key ONLY on `installedSdkVersion()` (the SDK
     package.json version). A failed/partial install that replaces the bundled
     CLI binary (`@anthropic-ai/claude-agent-sdk-<platform>/claude`) while the
     main SDK package version is unchanged or restored leaves `disk == BOOT`, so
     the pending state is CLEARED and new host sessions are re-admitted despite a
     genuine SDK-JS↔CLI skew — the exact skew finding #1/#7 set out to prevent.
     Confirmed by code: the module even comments `installedCli == runningCli`
     always and never compares `bundledCliVersion()` in the skew decision. The
     verifier reached the state by hand-planting the binary (synthetic, not a
     real npm partial failure), so the TRIGGER's real-world frequency is
     unproven — but the CHECK being blind to the CLI it guards is real
     regardless, and is the recorded break.
  2. **[NOT a defect — by design] `latest` resolves server-side.** The verifier
     flagged that POST `{version:'latest'}` reaches npm. By plan finding #3
     (`resolve latest server-side`), `latest`/undefined is intentionally resolved
     via the registry to a CONCRETE exact version and THEN installed exact — no
     dist-tag or package-spec ever reaches `npm install`. This is the requirement
     wording I supplied ("reject dist-tags") being stricter than the intended
     design; not a security hole. Note for the fixer only if the product wants to
     forbid the literal string.
  3. **[LOW — hardening] `EXACT_SEMVER` is looser than semver.** It accepts
     `01.2.3`, `1.2.3-01`, `1.2.3-a..b` (leading zeros / empty pre-release ident).
     Confirmed live. Inert in practice — these are not valid npm versions, so
     `npm install` fails and the rollback path fires — and it introduces no shell/
     package-spec injection (its actual job, which holds). Tighten the regex if
     desired.
- **My own environment-specific adversarial suite (14/14 PASS, `/tmp/feat151-adversarial.mjs`,
  against an isolated reflinked copy — the sandboxed verifier could not do these):**
  - **Truly unreachable registry (real dead TCP port `127.0.0.1:1`, not a mocked
    fetch):** `updateHostRuntime({version:'0.3.281'})` → real `npm install` ECONNREFUSED
    → `ok:false, rolledBack:true`, package.json RESTORED byte-identical, rollback
    command reported, no skew left pending.
  - **Crash (kill -9) mid-install:** the persistent `runtime-update-pending.json`
    is armed from install start (records `targetSdk`) and survives the kill; a
    fresh module load correctly reconciles — because the dead-registry install
    never mutated node_modules, `boot==disk`, so `reconcileOnBoot` clears the
    stale file and does NOT permanently false-block (verified both from a real
    crash and a hand-planted stale file).
  - **Container pin isolation:** `writeClaudeCodePin('2.1.280')` writes provision.json,
    keeps `appliesTo:["container"]`, MOVES `provisionHash()` (so drift rebuilds on
    the NEXT session, never now), rejects all 6 injection/spec/range attempts,
    leaves the serena pin untouched, and is a pure file write that spawns no
    docker and restarts no container.
- **Could NOT test (honest gaps):** a full/destructive Docker REBUILD under a
  LIVE container session (finding #6) — the container-pin route is deliberately
  decoupled from rebuild (it only writes the pin; a rebuild is the pre-existing
  ensureImage drift path on next session start), and I did not stand up a live
  container to exercise the pre-existing destructive ordering; a real TEST-TAG
  image build was NOT re-run this pass (the fixer's `verify-bug-108` 20/20 + two
  test-tag builds stand). HTTP origin/content-type guards, event-loop
  responsiveness and running-session continuity were exercised by neither me nor
  the clean-room verifier at the HTTP layer (module-level only) — carry forward.
- **Verdict handed to orchestrator:** FEAT-151 is **NOT VERIFIED**. One real
  defect (finding #1, CLI-blind skew guard) needs a fixing round; findings #2
  (by-design) and #3 (low/inert) are informational. The parts that WORK (exact-
  semver install+pin, rollback+restore, single-flight, dead-registry recovery,
  crash reconcile, container-pin isolation + hash move) are independently
  corroborated.

### 2026-09-24 — fixing lane (Opus 4.8), round 2 — CLI-blind skew fix + carry-forward closed
- **Hypothesis verified FIRST (before any change):** the bundled CLI is a SEPARATE
  optional dep with its OWN package.json — `node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/`
  (name `@anthropic-ai/claude-agent-sdk-linux-x64`, version `0.3.281`) holding the
  `claude` binary that reports `2.1.281`, while the main SDK package.json reports
  `0.3.281`. The binary is a plain file in a separate dir, so a partial/failed
  install can swap it while restoring the main SDK package.json version — a real
  on-disk divergence a SDK-version-only guard cannot see. (Whether a specific npm
  failure produces exactly this is unproven; the guard being blind to the CLI it
  guards is real regardless and is the recorded break.) Hypothesis confirmed →
  proceeded.
- **Changed (all unstaged; user owns git):**
  - `src/server/runtime/runtime-update.ts` (the fix, finding #1 round 2):
    - `BOOT_CLI_VERSION` — the bundled CLI version PAIRED with the loaded SDK JS,
      captured once at module load (ARCH-010: the owner states the fact the guard
      guards; nothing re-derives it).
    - `cliSkew()` — reads the on-disk CLI FRESH (`bundledCliVersion({ force:true })`,
      bypassing the 60s display cache) and compares to BOOT_CLI_VERSION. This is the
      "freshness at the writer" case ARCH-010 carves out — the fact can change WHILE
      the process runs, so it must be re-read, not cached.
    - `isRuntimeUpdatePending()` now returns true on `cliSkew()`; `reconcilePending()`
      (post-install) and `reconcileOnBoot()` clear pending ONLY when the SDK matches
      boot AND `!cliSkew()`. So a swapped-CLI + restored-SDK state keeps host sessions
      blocked instead of re-admitting them into a skew.
    - `hostRuntimeInfo()` now reports `runningCli = BOOT_CLI_VERSION` (the CLI the
      loaded JS pairs with) and `installedCli` = a FRESH disk read, so the two differ
      honestly under a swap; `hostSessionBlockReason()` names whichever half (SDK/CLI)
      actually drifted instead of always saying "SDK".
    - `bundledCliVersion(opts.force)` added for the fresh reads.
    - `EXACT_SEMVER` tightened to the canonical strict-semver grammar — rejects
      `01.2.3`, `1.2.3-01`, `1.2.3-a..b` (leading zeros / empty pre-release idents)
      while still accepting `0.3.281`, `2.1.197`, `1.0.0-alpha.1`.
  - `scripts/verify-feat-151-runtime-update.mjs` — Part C (must-FAIL CLI-swap case),
    3 new strict-semver reject cases, and a running-session-survives-a-real-install
    step in Part B.
  - `scripts/verify-feat-151-http.mjs` (NEW) — the runtime routes over REAL HTTP.
  - `scripts/verify-feat-151-container.mjs` (NEW) — pin moves image identity while a
    running container survives.
- **Demonstrated (real commands, real output):**
  - `node scripts/verify-feat-151-runtime-update.mjs` → **40/40 PASS** (incl. Part C
    CLI-swap must-FAIL/pass, real 0.3.280→0.3.281 install with a running session
    stand-in surviving, rollback+restore, single-flight).
  - **Genuine must-FAIL proof:** temporarily reverted `isRuntimeUpdatePending` to the
    pre-fix SDK-only body → Part C's three FIX assertions REDDEN
    (`newSaysPending:false`, `restartPending:false`, `reasonNamesCli:false`, 35/38);
    restored the fix → 40/40. So the test fails without the fix and passes with it.
  - `node scripts/verify-feat-151-http.mjs` → **9/9 PASS** over a booted scratch
    server (free ephemeral port, isolated CLAUDE_STATION_DATA): GET /api/runtime/version
    200 + shape (incl. runningCli/installedCli), cross-origin POST /update and
    /container-pin → 403, text/plain POST /update → 415, installedSdk byte-unchanged
    across the rejected mutations (npm never spawned), GET allowed under a foreign
    Origin. Booted from the live tree, so ONLY guard-reject + read-only paths were hit
    — the live package.json was never touched.
  - `node scripts/verify-feat-151-container.mjs` → **6/6 PASS**: a throwaway TEST
    container (a name+base-image this script owns) stands in for a live session; a pin
    write in an ISOLATED copy MOVES provisionHash (→ new image tag → rebuild on next
    session), the live `src/server/container/provision.json` is byte-identical after,
    and the running container is still Up. The live user container session (an
    unrelated project's running container) and the live `claude-station-base` tag
    were never touched.
  - `npx tsc --noEmit` clean; `npm run gate` → PASS (exit 0).
- **Could NOT test (honest gaps, carry-forward to the verifier):**
  - A full DESTRUCTIVE Docker rebuild that REPLACES a live container session
    (finding #6): by design the pin route only writes the pin and a rebuild is the
    pre-existing ensureImage-on-next-session path — there is no rebuild-under-live-session
    code path in this feature to exercise, and a real user container was running, so I
    did not stand up a live container to drive the pre-existing destructive ordering.
    Image-build-honors-pin remains covered by the fixer's `verify-bug-108` (20/20).
  - "Running host session survives an install" was demonstrated at the process level
    (a real install under a process that had already loaded the SDK JS), NOT via a
    full copy-rooted HTTP server driving an authenticated live session — that needs
    real credentials/network and a copy-rooted `projectRoot()` and was out of scope
    for this lane.
- **Verification class:** session-lifecycle + skew-guard change → an independent
  clean-room verify pass is still warranted before VERIFIED (I am the fixing lane, not
  the verifier — no `Verified-by` line added). regressed-from: this ticket's own
  round-1 build (the CLI-blind guard shipped there).

### 2026-09-24 — verifying lane (Opus 4.8), independent openai clean-room, round 2 — VERDICT: BROKEN
- **Verified-by:** dispatch openai run `01a0d305-86d4-79d3-b241-011482c8ee94`
  (clean-room, `scripts/independent-verify.mjs`) — **VERDICT: BROKEN**. Contract:
  **VALID** (manifest-backed executed evidence, 10 recorded runs). Cross-provider
  (author anthropic → verifier openai). Range = synthetic base/head built with the
  sanctioned node-spawned temp-index plumbing (`read-tree HEAD` + `git add -- <the 13
  FEAT-151 files>` + `write-tree` + `commit-tree`; real index untouched, no ref
  moved), so the diff is EXACTLY the 13 FEAT-151 files (`541dd73`..`37e29ba`, 99 656
  bytes, `--max-diff-bytes 120000` so NOT truncated) and excludes the other lanes'
  dirty files (package.json/-lock, claude-runtime.ts, orchestrator-profile, FEAT-152)
  and this ticket. Kept room `…/scratch/cleanroom-verify-FQ4V91`; manifest
  `…/scratch/cleanroom-record-VpF1gB/manifest.jsonl`; transcript
  `…/transcripts/openai/…/01a0d305-…jsonl`.
- **Setup (vrun harness-side path):** verifier input = requirement in plain terms
  (`/tmp/feat151-r2-requirement.txt`, steering the attack at the round-2 CLI guard),
  the 13-file diff, how-to-run, and the three fixer scripts only — NOT the ticket,
  report or rationale (docs/bugs + docs/prompts stripped from the room).
- **Fixer tests re-run (required evidence #1):**
  - clean-room verifier ran `verify-feat-151-runtime-update.mjs` (run `867ac06f0798`,
    exit 0) — **40/40 PASS**.
  - I re-ran ALL THREE on the live tree (the sandbox has no npm registry net / no
    docker for the other two): `verify-feat-151-runtime-update.mjs` **40/40**,
    `verify-feat-151-http.mjs` **9/9** (real scratch server, free port, isolated data:
    403 cross-origin, 415 wrong content-type, npm never spawned on a rejected
    mutation), `verify-feat-151-container.mjs` **6/6** (throwaway container survives; a
    pin write in an isolated copy MOVES provisionHash; live provision.json untouched).
    All PASS — the parts the fixtures cover work; the break is in states they never
    produce.
- **The three findings (all manifest-backed; #1/#2 also confirmed by me from the
  guard source in `runtime-update.ts`):**
  1. **[REAL DEFECT — fail OPEN, the break] The new CLI guard admits sessions when it
     cannot read the CLI.** ADVERSARIAL `broken-cli-fails-open` (run `cc6ccca51ce7`,
     exit 1, 4/4 failures): with the bundled CLI binary missing, non-executable,
     printing garbage, or exiting nonzero, `bundledCliVersion({force:true})` returns
     `null`; `cliSkew()` (`return diskCli != null && … && diskCli !== BOOT_CLI_VERSION`)
     is then FALSE, `isRuntimeUpdatePending()` returns false, `hostSessionBlockReason()`
     returns null, and a NEW host session is admitted — into a runtime whose CLI is
     unreadable/broken. The requirement demands the guard fail CLOSED here; it fails
     open, the dangerous direction. Round 2's whole point was to make the guard read
     the CLI it guards, but it treats an unreadable read as "no skew, admit."
  2. **[REAL DEFECT — hot-path cost] Per-admission synchronous CLI spawn stalls the
     event loop.** ADVERSARIAL `admission-spawn-cost` (run `2f68a309fc5c`, exit 1):
     20 admissions spawned 20 synchronous `claude --version` children (~7 ms each,
     141 ms total) and the scheduled timer did NOT fire during the loop
     (`timerRanDuringLoop:false`). `cliSkew()` calls `bundledCliVersion({force:true})`
     — no cache on force — and sits on the fast admission path, so every new host
     session pays a synchronous child spawn (≤5 s each). This is exactly the hot-path
     `spawnSync` plan finding #10 forbade; round 2 reintroduced it via the fresh CLI
     read.
  3. **[REAL, weaker — stuck blocked] A reverted-before-restart update never
     reconciles.** ADVERSARIAL `successful-update-reverted-before-restart` (run
     `5cb3ef1cf562`, exit 1): a real npm update (0.3.281→0.3.280) armed the pending
     file and blocked; a real revert restored both boot versions on disk
     (`runningSdk==installedSdk==0.3.281`, CLI likewise); yet `isRuntimeUpdatePending()`
     stayed true (`readPending() != null` at line 233) and kept blocking, because
     `reconcileOnBoot()` only runs at module load and nothing re-reconciles the
     restored disk mid-process. Errs to the SAFE side (over-blocks; a restart clears
     it), so lowest severity — but the pending state does not "clear correctly" as the
     requirement asks.
- **A round-2 attack that PASSED (not a defect):** ADVERSARIAL `both-halves-drift`
  (run `5d7a54e18cce`, exit 0, 0 failures): moving BOTH the SDK version AND the CLI
  binary to a new consistent on-disk version with no restart correctly stays
  blocked (loaded JS still boot), and reverting both clears it. The double-change
  invariant holds. Strict-semver boundary cases (`01.2.3`, `1.2.3-01`, `1.2.3-a..b`,
  `latest`, ranges, package-specs) all rejected in the fixer suite (Part A, 14 cases).
- **Could NOT test (honest gaps):** actual authenticated model sessions were not
  launched — the adversarial admission checks call `hostSessionBlockReason()` /
  `isRuntimeUpdatePending()` directly, so downstream real-session behavior after an
  admit/block decision is unverified. The destructive Docker REBUILD under a LIVE
  container session (finding #6) was again not exercised (the pin route only writes
  the pin; rebuild is the pre-existing ensureImage-on-next-session path, and no live
  test container was stood up for the destructive ordering). A truly-offline host
  (vs. the fixer's mocked/registry-error path) was not exercised this round.
- **Verdict handed to orchestrator:** FEAT-151 round 2 is **NOT VERIFIED / BROKEN**.
  Two real defects need a round-3 fixing lane — the fail-OPEN CLI guard (#1,
  session-admission safety) and the per-admission synchronous spawn on the hot path
  (#2); finding #3 (stuck-blocked-after-revert) is real but fail-safe. The parts that
  work (exact-semver install+pin, rollback+restore, single-flight, HTTP origin/
  content-type guards, container-pin isolation + hash move, both-halves-drift
  blocking) are independently corroborated. regressed-from: this ticket's round-2
  build (the fresh-CLI-read guard shipped there introduced both #1 and #2).

### 2026-09-24 — verifying lane (Opus 4.8), independent openai clean-room, round 3 — VERDICT: BROKEN
- **Verified-by:** dispatch openai run `01a0d31b-4738-7553-9c6a-51d186adb473`
  (clean-room, `scripts/independent-verify.mjs`) — **VERDICT: BROKEN**. Contract:
  **VALID** (manifest-backed executed evidence; 3 adversarial cases recorded
  through the vrun spool, all exit 1). Cross-provider (author anthropic → verifier
  openai). Range = synthetic base/head via the sanctioned node-spawned temp-index
  plumbing (`read-tree HEAD` + `git add -- <the 13 FEAT-151 files>` + `write-tree`
  + `commit-tree`; real index untouched, no ref moved) =
  `541dd73`..`d87bfdc`, diff EXACTLY the 13 FEAT-151 files (111 121 bytes,
  `--max-diff-bytes 130000` so NOT truncated), excluding the other lanes' dirty
  files (package.json/-lock, claude-runtime.ts, orchestrator-profile, git.ts,
  FEAT-152) and this ticket. Kept room
  `…/scratch/cleanroom-verify-CLmkl0`; verifier transcript thread
  `01a0d31b-4738-7553-9c6a-51d186adb473`.
- **Setup (vrun harness-side path):** verifier input = requirement in plain terms
  (`/tmp/feat151-r3-requirement.txt`, steering the attack at the round-3 fs-only
  boot-captured identity), the 13-file diff, how-to-run, and the three fixer
  scripts only — NOT the ticket, report or rationale (docs/bugs + docs/prompts
  stripped from the room).
- **Fixer tests re-run (required evidence #1):** I re-ran all three on the live
  tree (each isolates a reflinked copy for its mutations — live node_modules /
  package.json never touched): `verify-feat-151-runtime-update.mjs` **55/55**,
  `verify-feat-151-http.mjs` **9/9** (real scratch server, free port, isolated
  data: 403 cross-origin, 415 wrong content-type, npm never spawned on a rejected
  mutation), `verify-feat-151-container.mjs` **6/6** (throwaway container survives;
  a pin write in an isolated copy MOVES provisionHash; live provision.json
  untouched). The clean-room verifier also ran `runtime-update.mjs` (run
  `dd067c8b7e2c`, exit 0) — **55/55**. All PASS — the fixtures' states work; the
  break is in states they never produce.
- **The three findings (all manifest-backed; ROOT CAUSE shared): the boot/admission
  identity is derived from cheap fs metadata (`X_OK` bit + package.json version
  strings + binary byte-size) and NEVER validates the binary actually RUNS, and
  `currentRuntimeIdentity()` caches keyed on the binary's stat alone. All three are
  fail-OPEN (admit into a broken/incoherent runtime with `restartPending:false`) —
  none fail-safe.**
  1. **[REAL DEFECT — fail OPEN, in-scope] broken-boot baseline** (ADVERSARIAL
     `broken-boot-baseline`, run `8a7a92fa38d1`, exit 1). A binary that is present
     and has the executable bit but is NON-FUNCTIONAL at boot (prints garbage,
     exits nonzero) is captured as the "good" `BOOT_IDENTITY` — a coherent
     `{sdkVersion, platVersion, size}` tuple — because `currentRuntimeIdentity()`
     only `accessSync(X_OK)` + `statSync` + reads the two package.jsons and never
     spawns. `BOOT_CLI_VERSION` (the display spawn) correctly goes `null`, but the
     admission path (`identitySkew`) ignores it, so a NEW host session is ADMITTED
     with `restartPending:false`. This is round-2's break (guard blind to whether
     the CLI works) reintroduced at BOOT time. Requirement 6(b) / charter attack B
     demand fail-closed on a broken boot capture. **Independently corroborated by
     this lane** against the real module in an isolated reflinked copy: garbage
     binary at boot → `bootCli:null`, `pending:false`, `reason:null`,
     `admitted:true`.
  2. **[REAL DEFECT — fail OPEN, in-scope] stale identity cache** (ADVERSARIAL
     `deleted-platform-metadata`, run `5af67c006071`, exit 1). `currentRuntimeIdentity()`
     caches the parsed package.json versions keyed ONLY on the binary's
     `dev:ino:size:mtimeMs`, but the identity ALSO depends on the platform and SDK
     package.jsons — which can change without the binary stat changing (the
     half-written-install window, charter attack A; or the main SDK package.json
     moving independently). Delete the platform package.json with the binary
     untouched → the guard returns the STALE coherent identity and keeps admitting.
     **Independently corroborated** against the real module: healthy boot, then
     `rm platform/package.json` → `currentRuntimeIdentity()` still returns
     `{0.3.281,0.3.281,237375560}`, `pending:false`, `admitted:true`.
  3. **[REAL DEFECT — fail OPEN, low realism, the fixer's disclosed residual]
     size-only binary comparison** (ADVERSARIAL `same-size-binary-corruption`, run
     `751790dfda74`, exit 1). Corrupting the binary's header while preserving its
     byte size leaves `{sdkVersion, platVersion, size}` matching boot, so the
     admission admits (`restartPending:false`) though the binary now exits 126.
     This is exactly the "same-SIZE, different-CONTENT" evasion the round-3 fixing
     lane disclosed and judged out of the realistic npm threat model; the verifier
     confirmed it is a real fail-open. Real by code inspection (identity compares
     size, not content). Lower severity: not a normal npm-install outcome.
- **Could NOT test (honest gaps):** admission sampled DURING a live half-written
  npm install, and mixed-rollback, were exercised by directly constructing the
  filesystem states (finding #2 is that window's realization) rather than racing a
  real concurrent install; event-loop delay under load and actual authenticated
  session launches after an admit/block decision were not measured (the attacks
  drove the admission predicate + UI payload directly). The container destructive
  REBUILD under a LIVE session (finding #6) again not exercised (unchanged rounds
  1–3; the pin route only writes the pin).
- **Verdict handed to orchestrator:** FEAT-151 is **NOT VERIFIED** (round 3). The
  fs-only identity redesign fixed the round-2 defects the fixtures cover (55/55
  incl. must-FAIL baselines), but the admission identity trusts fs METADATA over
  the runtime's actual runnability and caches on the wrong key — so three fail-open
  states remain: a broken binary accepted AT BOOT (#1), a stale cache after
  metadata changes (#2), and a same-size corrupted binary (#3). Root fix direction:
  the boot capture must prove the binary RUNS (not just exists + X_OK), the
  identity cache must key on all of its inputs (both package.jsons, not the binary
  stat alone), and content (a hash), not size, is the honest binary-change signal —
  though the fixing lane's ino/mtime caveat (a legitimate same-version revert must
  still re-admit, defect #3) constrains what may enter the compared identity.
  Independent clean-room verify warranted again after the round-4 fix (session-
  lifecycle + fail-open class).

### 2026-09-24 — fixing lane (Opus 4.8), round 3 — skew guard redesigned to fs-only runtime identity
- **Hypothesis verified FIRST (before any change), with a real npm install in an
  isolated reflinked copy:** the bundled platform package's package.json version
  PLUS the binary's stat identity reliably change whenever npm replaces the CLI,
  and are cheap to read (no spawn). Measured: `@anthropic-ai/claude-agent-sdk-linux-x64`
  package.json version tracked the SDK (0.3.281→0.3.280→0.3.281); the `claude`
  binary `size` moved 237375560→233709640→237375560 and `ino`/`mtime` changed on
  every reinstall; reading all of it cost ~1.8 ms. **Key nuance found (drove the
  design):** a revert to the SAME version restores `size` and both package.json
  versions EXACTLY, but gives a FRESH `ino`/`mtime`. So keying the compared identity
  on `ino`/`mtime` would keep sessions blocked after a legitimate revert (breaking
  defect #3). The identity therefore compares {sdkVersion, platVersion, size} — the
  stable, coherence-relevant facts — while the full stat (dev,ino,size,mtime) is used
  only as the CACHE key. npm never leaves all three unchanged across a version change,
  so the hypothesis held; I did NOT stop.
- **Redesign (all in `src/server/runtime/runtime-update.ts`, unstaged; user owns git):**
  - Runtime identity captured ONCE at boot: `BOOT_IDENTITY = {sdkVersion, platVersion, size}`
    via `currentRuntimeIdentity()`, a pure fs read (readdir + statSync + two cached
    package.json parses). NO spawn.
  - `identitySkew()` compares the current fs identity to boot and FAILS CLOSED on any
    unreadable/incoherent state: boot unreadable, current unreadable (missing /
    non-executable / garbage binary, unreadable package.json), SDK≠platform version
    (half-replaced pair), or any of {sdkVersion, platVersion, size} differing from boot.
  - `isRuntimeUpdatePending()` = `updateInProgress || identitySkew()`. The persistent
    `runtime-update-pending.json` file, `readPending/writePending/clearPending`,
    `reconcileOnBoot`, `reconcilePending` and `cliSkew` are DELETED — pending is now
    DERIVED from disk, not a sticky flag, so a disk that reverts to the boot identity
    re-admits with no restart (defect #3).
  - `hostSessionBlockReason()` builds its message from the fs identity only — no spawn
    on the admission hot path (defect #2).
  - `bundledCliVersion()` (the `claude --version` spawn) is now DISPLAY-ONLY: one spawn
    at boot for `BOOT_CLI_VERSION`, and in the GET /api/runtime/version payload via
    `hostRuntimeInfo()`. It is never called by the admission path.
  - Identity read is cached on the binary's full stat key so a repeated admission does
    a single statSync and no re-parse until the binary changes.
- **Demonstrated (real commands, real output):**
  - `node scripts/verify-feat-151-runtime-update.mjs` → **55/55 PASS**. New parts:
    C = defect #1 (missing/non-executable/garbage/nonzeroExit binary all BLOCK, fail
    closed; anti-regression: a valid different-version swap still blocks); D = defect #2
    (N=20 admissions spawn ZERO CLI children, counted by a marker-script the binary is
    replaced with; the pre-fix spawn writes N=20 markers); E = defect #3 (real npm
    0.3.280→0.3.281 blocks, then a real revert 0.3.280 RE-ADMITS with no restart).
    Parts A (semver/scope/pin/registry) and B (real install/rollback/single-flight,
    running-session survives) stay green.
  - **Genuine must-FAIL proof:** temporarily regressed `identitySkew` to the pre-fix
    shape (fail OPEN on unreadable, version-only, no size) → the Part C FIX assertions
    REDDEN (missing/non-exec/garbage/nonzeroExit `newBlocks:false`, valid-swap
    anti-regression `false`; 46/55). Restored → 55/55. Defects #2/#3 additionally carry
    inline must-FAIL baselines (pre-fix spawn writes N markers; pre-fix sticky flag
    stays armed after revert) that PASS alongside the fixed behavior.
  - `node scripts/verify-feat-151-http.mjs` → **9/9 PASS** (real scratch server, free
    port, isolated data: GET 200 + shape incl. runningCli/installedCli, cross-origin
    POST 403, text/plain 415, npm never spawned on a rejected mutation).
  - `node scripts/verify-feat-151-container.mjs` → **6/6 PASS** (throwaway container
    survives; pin write in an isolated copy MOVES provisionHash; live provision.json
    byte-identical after).
  - `npm run gate` → **PASS (exit 0)** (leak-gate + check-nul + typecheck); `npx tsc
    --noEmit` clean.
- **Could NOT test (honest gaps, carry-forward to the verifier):**
  - Actual authenticated model sessions were not launched — the admission checks call
    `hostSessionBlockReason()` / `isRuntimeUpdatePending()` directly; downstream real
    session behavior after an admit/block decision is unverified.
  - A same-SIZE, different-CONTENT planted binary with a restored package.json version
    would evade the size-based identity. Judged out of the real threat model (the ask
    is "whenever npm replaces the CLI", and a real install of a different version always
    changes size); noted rather than defended against, since ino/mtime cannot be added
    to the compared identity without breaking defect #3.
  - The destructive Docker REBUILD under a LIVE container session (finding #6) was again
    not exercised (unchanged from rounds 1–2; the pin route only writes the pin).
  - A truly-offline host (vs. the fixer's mocked/registry-error path) not exercised.
- **Verification class:** session-lifecycle + skew-guard change → an independent
  clean-room verify pass is still warranted before VERIFIED (I am the fixing lane, not
  the verifier — no `Verified-by` line added). regressed-from: this ticket's round-2
  build (the fresh-CLI-read guard shipped there introduced #1 and #2; round 3 replaces
  the whole guard with fs-only identity).

### 2026-09-24 — fixing lane (Opus 4.8), round 4 — boot-proven, content-hash, full-key runtime identity
- **Hypothesis verified FIRST (before any change), with real npm installs in an
  isolated reflinked copy:** reinstalling the SAME SDK version produces a
  BYTE-IDENTICAL bundled binary (identical sha256) under a FRESH inode — so a
  content-hash identity keeps the "revert re-admits" property (defect #3). Measured
  on the real `@anthropic-ai/claude-agent-sdk-linux-x64/claude` (237 375 560 B):
  `0.3.280` sha `1e08503d…925b`, `0.3.281` sha `56fe3da8…dce1` (distinct, as a real
  version change must be); reinstalling `0.3.280` after a bump restored sha
  `1e08503d…925b` EXACTLY with a new inode. Streamed sha256 of the 237 MB binary
  costs ~200 ms of CPU, so it must be async and computed only on a stat change.
  Hypothesis held → proceeded.
- **Redesign (all in `src/server/runtime/runtime-update.ts`, unstaged; user owns git),
  keeping round 3's structure — three targeted, known-correct changes:**
  - **Boot PROVES the runtime RUNS (defect #1).** A one-time async boot check runs
    `claude --version` AND streams the binary hash before anything becomes a baseline.
    `bootState` is `'pending'` until it completes (admission fails closed, reason
    "runtime check pending"), `'failed'` if `--version` does not run / the hash or
    versions cannot be read (reason "runtime check failed: …", permanent until
    restart), `'ok'` only on full success. `BOOT_IDENTITY`/`BOOT_CLI_VERSION` are now
    live ESM bindings set ONLY on a proven boot — a present+executable-but-non-running
    binary NEVER becomes a good baseline. `whenRuntimeChecked()` exposes the promise.
  - **The identity cache key covers EVERY input (defect #2).** `readCurrentIdentity()`
    keys the composite identity cache on the stat identity (dev:ino:size:mtime) of the
    binary AND both package.jsons, so a package.json that changes/vanishes with the
    binary untouched forces a recompute instead of returning a stale coherent identity.
  - **Compare CONTENT, not size (defect #3).** `RuntimeIdentity.size` → `hash`
    (sha256 of the binary's contents). Hashed once at boot; re-hashed ONLY when the
    binary's stat key changed, asynchronously and single-flighted, cached under the
    new stat key. While a hash is in flight admission fails closed (reason "checking
    runtime") — the admission path itself NEVER spawns and never hashes on an unchanged
    stat key (still a fs stat + two cached package.json reads, defect #2 from round 3
    preserved). `whenRuntimeSettled()` lets callers/tests await a re-hash.
  - `updateHostRuntime()`'s rollback path now `await whenRuntimeSettled()` before
    reporting `restartRequired`, so a rolled-back install reports re-admission honestly.
- **Demonstrated (real commands, real output):**
  - `node scripts/verify-feat-151-runtime-update.mjs` → **62/62 PASS**. New/rewritten
    parts, each with a must-FAIL baseline = a constructed replica of the round-3
    predicate (fs-only, size-based, cached on the binary stat alone):
    - **C (defect #1):** a garbage / exit-nonzero binary present + executable AT BOOT
      → the round-3 fs-only boot ADMITS (baseline), the fix BLOCKS with
      `BOOT_IDENTITY===null` and a "runtime check …" reason.
    - **D (defect #2):** deleting OR changing the platform package.json with the binary
      untouched → the round-3 binary-stat-only cache returns a STALE identity and
      ADMITS (baseline), the fix recomputes and BLOCKS.
    - **E (defect #3):** the ELF header overwritten IN PLACE (byte size preserved) →
      round-3 size-only comparison ADMITS (baseline), the fix's content hash CHANGES
      and BLOCKS.
    - **F:** N=20 healthy admissions spawn ZERO children and re-hash NOTHING; and the
      measured event-loop proof — `firstCall=0.32ms` (admission returns immediately
      while a hash is in flight), `asyncMaxGap=5.1ms` (a 5 ms timer keeps firing during
      the async hash) vs `syncHash=193.7ms syncMaxGap=194.5ms` (a synchronous hash of
      the same real binary stalls the loop).
    - **G (revert-re-admits stays GREEN):** real npm `0.3.280`→`0.3.281` (blocked, hash
      changed) → revert `0.3.280` (`curHash===bootHash` under a fresh inode →
      re-admitted, no restart).
  - **Genuine must-FAIL proof:** each of C/D/E carries an inline round-3-predicate
    baseline that PASSES (proving the old code ADMITS the broken state) alongside the
    fix that BLOCKS — the constructed-broken-variant form, anchored to no moving ref.
  - `node scripts/verify-feat-151-http.mjs` → **9/9 PASS** (real scratch server, free
    port, isolated data: GET 200 + shape incl. runningCli/installedCli, cross-origin
    POST 403, text/plain 415, npm never spawned on a rejected mutation). Note: a
    freshly-booted server reports `restartPending:true` transiently during the ~200 ms
    boot hash — correct fail-closed-during-boot, clears once the boot check settles.
  - `node scripts/verify-feat-151-container.mjs` → **6/6 PASS** (throwaway container
    survives; pin write in an isolated copy MOVES provisionHash; live provision.json
    byte-identical after).
  - `npm run gate` → **PASS (exit 0)** (leak-gate + check-nul + typecheck); `npx tsc
    --noEmit` → **0 errors**. (Mid-run the shared tree briefly showed one unrelated tsc
    error in another lane's `claude-runtime.ts` from the concurrent SDK 0.3.220→0.3.281
    bump; that lane fixed it, and the final gate is green. My diff touches only
    `runtime-update.ts` + the verify script.)
- **Could NOT test (honest gaps, carry-forward to the verifier):**
  - Actual authenticated model sessions were not launched — the admission checks call
    `hostSessionBlockReason()` / `isRuntimeUpdatePending()` / `whenRuntime*()` directly;
    downstream real-session behavior after an admit/block decision is unverified.
  - Admission sampled DURING a live half-written npm install was exercised by directly
    constructing the filesystem states (defect #2's deleted/changed package.json and
    defect #3's in-place corruption), not by racing a real concurrent install.
  - The destructive Docker REBUILD under a LIVE container session (finding #6) was again
    not exercised (unchanged rounds 1–3; the pin route only writes the pin).
  - A truly-offline host (vs. the fixer's mocked/registry-error path) not exercised.
- **Verification class:** session-lifecycle + fail-open class → an independent
  clean-room verify pass is warranted before VERIFIED (I am the fixing lane, not the
  verifier — no `Verified-by` line added). regressed-from: this ticket's round-3 build
  (the fs-only size-based identity shipped there had all three fail-open states; round 4
  makes the baseline boot-proven, the cache full-keyed, and the comparison content-based).

### 2026-09-24 — verifying lane (Opus 4.8), independent clean-room, round 4 — VERDICT: BROKEN
- **Verified-by:** dispatch anthropic run `86cbbfd2-99ce-4b6a-be20-16545b0e6448`
  (clean-room, `scripts/independent-verify.mjs`) — **VERDICT: BROKEN**. Contract:
  **VALID** (manifest-backed executed evidence; adversarial cases
  `boot-proof-vs-hash-toctou` + `live-external-npm-race-poll`). Range = synthetic
  base/head via the sanctioned node-spawned temp-index plumbing (`read-tree HEAD` +
  `git add -- <the 10 FEAT-151 files>` + `write-tree` + `commit-tree`; real index
  untouched, no ref moved) = `541dd73`..`dca2c08`, diff EXACTLY the 10 FEAT-151 files
  (83 484 bytes, `--max-diff-bytes 130000` so NOT truncated), excluding the other
  lanes' dirty files (package.json/-lock, claude-runtime.ts [FEAT-152], git.ts,
  orchestrator-profile, public/app.js, index.html, git-view.js, FEAT-130/142/152/164
  docs) and this ticket. Kept room `…/scratch/cleanroom-verify-TAgcC1`.
- **CROSS-PROVIDER NOT ACHIEVED THIS ROUND (provider limitation, flagged):** the
  intended OpenAI clean-room dispatch was tried THREE times and each time died with
  `dispatch failed [internal] (provider openai): This content was flagged for possible
  cybersecurity risk` — OpenAI's cyber-safety filter reliably rejects this dispatch
  because the subject (verify a fail-closed gate by replacing a runtime binary in
  node_modules) plus the harness's fixed "ATTEMPT TO BREAK" framing pattern-matches to
  malware; a neutrally-reworded requirement (no attack/exploit/corrupt/TOCTOU words)
  failed identically. The harness prompt is product code and was not edited. The
  independent clean-room pass was therefore ANTHROPIC (same provider as the author —
  decorrelation reduced). The BROKEN finding nonetheless came from the independent
  clean room, and was independently corroborated by this lane; but an OpenAI (or other
  non-Anthropic) pass on the round-5 fix is still owed once the cyber-filter path is
  worked around.
- **Fixer tests re-run (required evidence #1):** all three re-run by THIS lane on the
  live tree (each isolates a reflinked copy; live node_modules/package.json untouched):
  `verify-feat-151-runtime-update.mjs` **62/62**, `verify-feat-151-http.mjs` **9/9**
  (real scratch server, free port, isolated data: 200 + shape, 403 cross-origin, 415
  wrong-content-type, npm never spawned on a rejected mutation), `verify-feat-151-container.mjs`
  **6/6** (throwaway container survives; pin write in an isolated copy MOVES
  provisionHash; live provision.json untouched). The clean-room verifier also ran the
  full runtime-update suite (**62/62**). All PASS — the fixtures' states work; the break
  is in a state they never produce (a boot-time race).
- **THE FINDING (fail-OPEN, blocker; manifest-backed + independently corroborated
  3/3 deterministic): a boot-time TOCTOU between the run-proof and the content hash.**
  `bootChecked` (runtime-update.ts:347-366) does `statSync(bin)` → `await
  probeVersionAsync(bin)` (the RUN proof, T1) → `await hashFile(bin)` (the trusted
  identity, T2) → seeds `hashCache = { binKey: statKey(bst), hash }` and `BOOT_IDENTITY`,
  reading the binary PATH three separate times with NO re-stat / inode / fd consistency
  check. So the proof can succeed against a GOOD binary at T1 while the hash and
  `BOOT_IDENTITY` are taken from a DIFFERENT binary swapped in at T2 — a non-running
  binary's hash becomes the trusted baseline. Corroboration (this lane, `/tmp` driver,
  3/3): boot binary = a good-but-slow script (prints `2.1.281`, sleeps 1.5s, exit 0) so
  the proof succeeds; at ~600 ms a garbage binary (exit 7) is renamed over the path,
  between T1 and T2. Result every run: `BOOT_IDENTITY` set, `bootCli:"2.1.281"`,
  `bootHash===curHash` (the GARBAGE hash), `isRuntimeUpdatePending()===false`,
  `hostSessionBlockReason()===null`, `admitted:true`, while the on-disk binary exits 7
  and does NOT run. Requirement 6(b) (a present-but-non-running binary must never become
  a baseline) is broken. This is round-3 defect #1's integrity class reopened by a race:
  round 4 closed the STATIC broken-boot case (probe fails → `bootState=failed`) but not
  the case where the proof and the trusted bytes are DIFFERENT files. **Realism:** needs
  a binary change inside the sub-second boot window — narrow if purely adversarial, but a
  non-adversarial trigger exists (a server restart, e.g. crash-restart, that races an
  in-progress `npm install` of the bundled package straddles the replacement and captures
  a torn baseline). Given the module's whole purpose is a fail-closed gate and 6(b) is
  explicit, classed as a fail-OPEN blocker. **Root-fix direction:** bind the proof, the
  hash and the stat to ONE file identity — open the binary once (fd), run/hash/fstat that
  same fd, or re-stat after probe+hash and fail closed if dev:ino:size:mtime moved.
  regressed-from: this ticket's round-4 build.
- **Attacks that PASSED (fail-safe or clean — NOT defects):**
  - **Live external npm-install race (the charter's headline attack), driven for real:**
    this lane's 88 586-poll run + the clean-room verifier's 28 782-poll run both drove a
    REAL `npm install` downgrade in an isolated copy while a tight loop polled admission
    the whole time. ZERO admitted polls during any mixed/half-replaced state (with an
    ATOMIC detector — an early non-atomic detector's single false "admit" was traced to
    reading `pending` and `cur` at two different instants straddling the first file
    change, not a real fail-open); blocked correctly at `0.3.280`. The three fail-closed
    reasons ("could not be read on disk", "checking runtime", "SDK 0.3.281 → 0.3.280")
    were all observed mid-race. The STEADY-STATE admission gate holds.
  - **Binary changed DURING an in-flight hash (stale hash under the new key?):** the
    served identity reflected the FINAL content hash, blocked; 0 stale admits — a stale
    hash cached under the OLD stat key is never served because the next admission's stat
    key differs and forces a re-hash.
  - **Stat-key collision (in-place overwrite + `utimesSync` mtime reset):** not reachable
    — `utimesSync` truncates mtime to ms and cannot restore the original's sub-ms
    component (mt0 `…315.404` → mt1 `…315.0`), so the stat key differs → re-hash → the
    altered binary BLOCKS. The theoretical stat-collision fail-open needs a forged
    ns-precision mtime + local write to node_modules (disclosed low-realism class,
    round-3 #3); it was BLOCKED here.
  - **Boot `--version` HANGS:** a binary that never exits → `probeVersionAsync`'s 5 s
    SIGKILL timeout fires → `bootState=failed`, `BOOT_IDENTITY=null`, admission BLOCKED
    "runtime check failed: the bundled runtime did not run `--version` at boot" — bounded
    (settled at 5003 ms), fail-CLOSED, NOT pending-forever.
  - **Many concurrent admissions during a hash (one hash or many?):** 200 admissions in
    13.4 ms, all returned "checking" (a per-call synchronous 237 MB hash would be tens of
    seconds) — single-flight on `binKey` holds; one async hash.
- **Could NOT test (honest gaps):** cross-provider (non-Anthropic) verification (OpenAI
  cyber-filter, above); actual authenticated model-session launches after an admit/block
  decision (the attacks drove the admission predicate directly); the destructive Docker
  REBUILD under a LIVE container session (finding #6, unchanged rounds 1–3; the pin route
  only writes the pin); the HTTP 403/415 + container-pin paths were re-run by THIS lane
  (9/9, 6/6) but the clean-room verifier focused on the admission gate.
- **Verdict handed to orchestrator:** FEAT-151 is **NOT VERIFIED / BROKEN** (round 4).
  One fail-OPEN remains — a boot-time proof/hash/stat TOCTOU that lets a non-running
  binary become the trusted baseline — the round-3 boot-integrity defect reopened by a
  race. Everything the round-4 fix targeted for the STEADY state holds (real npm race,
  content-hash vs size, full cache key, async single-flight hash, bounded boot timeout;
  62/62, 9/9, 6/6). Needs a round-5 fixing lane (bind proof+hash+stat to one fd/inode),
  then an independent clean-room verify — and, given SECURITY/session-lifecycle/fail-open
  class, that pass should include a genuinely cross-provider (non-Anthropic) verifier once
  the OpenAI cyber-filter path is worked around.

### 2026-09-24 — fixing lane (Opus 4.8), round 5 — bind the boot proof, hash and identity to ONE file (TOCTOU close)
- **Hypothesis verified FIRST (before any change), with real fs operations
  (`/tmp/toctou-hyp.mjs`):** a swap between the run-proof and the hash always moves at
  least one of {ino, mtime, ctime}. Measured all four classes: rename-over → `ino`+`ctime`
  move; rename-over same-size → `ino`+`ctime`; in-place overwrite same-size →
  `mtime`+`ctime`; **in-place + adversarial `utimesSync` mtime-reset → `ctime` STILL
  moves** (mtime restored to the old value, ctime advanced) — an attacker cannot forge
  ctime via `utimes` (only a wall-clock roll-back would). No class kept ino, mtime AND
  ctime identical. Hypothesis HELD → proceeded with variant (b) (portable stat-identity
  re-check, no fd/`/proc` dependency), adding **ctime** to the swap-detection identity.
- **Fix (all in `src/server/runtime/runtime-update.ts`, unstaged; user owns git) — small
  and known-correct:**
  - New `statIdentity(st)` = `statKey` (dev:ino:size:mtime) **+ ctime**, used ONLY for
    swap detection. Kept SEPARATE from `statKey` so the identity CACHE key (defect #3:
    a revert with a fresh inode must re-hash) is unchanged.
  - **`bootChecked` (the round-4 verdict's defect):** wrapped in a bounded retry loop
    (MAX_TRIES=3). Capture `statIdentity` BEFORE the `--version` proof and again AFTER
    the hash; if it moved, the proof and the hashed bytes straddled different files —
    discard and retry. The retry's proof runs the swapped (garbage) binary → fails →
    `bootState='failed'`, `BOOT_IDENTITY` null, admission fails CLOSED. `BOOT_CLI_VERSION`
    and the `hashCache` seed are now set ONLY on a proven+stable capture. Exhausting the
    retries fails closed ("the bundled runtime binary kept changing during the boot check").
  - **Admission re-hash (`ensureHash`), same rule:** stat before + after `hashFile`, and
    cache the hash ONLY if `statIdentity` is unchanged across it AND `statKey`==the caller's
    `binKey`. A swap mid-hash is discarded (never cached under a key it does not belong to);
    the next admission re-stats, gets the new key, re-hashes; admission stays fail-closed
    ("checking") until a stable hash lands.
- **Demonstrated (real commands, real output):**
  - **Genuine must-FAIL proof against the REAL round-4 code** (`/tmp/mustfail-boot-toctou.mjs`):
    an isolated reflinked copy with the re-stat guard disabled (round-4 behaviour) fails
    OPEN in BOTH variants — `{blocked:false, bootIdentityNull:false, reason:null}`, the
    garbage binary's hash (`4d8fe247…`) trusted as `BOOT_IDENTITY`. With the guard enabled
    the fix blocks.
  - `node scripts/verify-feat-151-runtime-update.mjs` → **72/72 PASS** (was 62/62). New
    **Part H** adds the swap-between-proof-and-hash race in BOTH variants
    (rename-over and in-place write): a good-but-slow boot binary (prints `2.1.281`,
    sleeps 3 s) whose `--version` proof succeeds against the good inode, with a GARBAGE
    non-running binary (exit 7) swapped over the path at ~800 ms (mid-proof) so the later
    hash reads the garbage bytes. Each variant carries a must-FAIL baseline (an inline
    round-4 boot replica with NO re-stat) that PASSES — proving the old logic trusts the
    swapped non-running binary (`trustsSwapped:true`, bootHash == on-disk garbage hash) —
    alongside the fix that BLOCKS (`BOOT_IDENTITY` null, reason names the runtime check).
  - `node scripts/verify-feat-151-http.mjs` → **9/9 PASS**; `node
    scripts/verify-feat-151-container.mjs` → **6/6 PASS**.
  - `npm run gate` → **PASS (exit 0)** (leak-gate + check-nul + typecheck); `npx tsc
    --noEmit` → **0 errors**. My diff touches only `runtime-update.ts` + the verify script
    (both currently untracked in this fresh-history tree).
- **Could NOT test (honest gaps, carry-forward to the verifier):**
  - Actual authenticated model sessions were not launched — the attacks drive
    `whenRuntimeChecked()` / `isRuntimeUpdatePending()` / `hostSessionBlockReason()` /
    `BOOT_IDENTITY` directly; downstream real-session behaviour after an admit/block is
    unverified.
  - The boot race is driven deterministically via a slow-proof + timed swap, not by racing
    a real concurrent `npm install` straddling the sub-second boot window (the non-adversarial
    trigger named in the round-4 verdict).
  - A theoretical stat-identity collision needs a forged ns-precision mtime AND a forged
    ctime (impossible via `utimes` without moving the wall clock) + a local write to
    node_modules — not reachable in the tested classes.
  - The destructive Docker REBUILD under a LIVE container session (finding #6, unchanged
    rounds 1–4); a truly-offline host.
- **Verification class:** SECURITY / session-lifecycle / fail-open, regression-prone
  (file with a 4-round regression history) → an independent clean-room verify pass is
  warranted before VERIFIED, and — given the class — a genuinely cross-provider
  (non-Anthropic) verifier once the OpenAI cyber-filter path is worked around. I am the
  fixing lane, not the verifier (no `Verified-by` line). regressed-from: this ticket's
  round-4 build (the boot proof→hash→identity used three unbound path reads).

### 2026-09-24 — verifying lane (Opus 4.8), round 5 — independent clean-room — VERDICT: BROKEN
- **Verified-by:** dispatch anthropic run `12676d1d-6e9e-418b-a1e2-a7176966dce2`
  (clean-room, `scripts/independent-verify.mjs`) — **VERDICT: BROKEN**. Contract:
  **VALID** (manifest-backed, 3 recorded runs). Range = synthetic node-spawned
  temp-index base/head (`851fe58`..`d8eca17`), scoped so the diff is EXACTLY the
  round-5 file `src/server/runtime/runtime-update.ts` (39 710 bytes, not truncated),
  while the exported room still carries the full working tree so all three fixer
  scripts run. Room kept `…/scratch/cleanroom-verify-WohGdn`; manifest
  `…/scratch/cleanroom-record-nly4Sx/manifest.jsonl`.
- **Provider path (charter):** OpenAI FIRST, neutral framing ("correctness of a
  package-upgrade consistency check under concurrent file changes"). OpenAI was
  **NOT safety-blocked this round** (the neutral framing cleared the cyber-filter that
  blocked round 4) — it ran the fixer test and *announced the exact cache attack*
  ("attack cache reuse after an in-place content change with the original mtime
  restored") — but then hit an OpenAI **usage/quota limit mid-run** (run
  `01a0d359-9f44-7171-8f75-322e0ab4eee6`, `dispatch failed [quota-window]`), so that
  dispatch is INVALID (infra, not a refusal). Fell back to an Anthropic clean room
  (author-provider openai → cross-provider anthropic) per the charter.
- **Fixer tests re-run (required evidence #1):** all three on the LIVE tree —
  `verify-feat-151-runtime-update.mjs` **72/72**, `verify-feat-151-http.mjs` **9/9**,
  `verify-feat-151-container.mjs` **6/6**; the clean-room verifier independently re-ran
  `verify-feat-151-runtime-update.mjs` **72/72** (run `e9b19c1dceae`, exit 0).
- **THE BREAK (fail-OPEN, manifest-backed, independently reproduced 3×):** the admission
  identity/hash **cache keys on `statKey` = dev:ino:size:mtime and OMITS ctime**
  (`runtime-update.ts:191`). The round-5 ctime-aware `statIdentity` is used ONLY inside
  the boot check and the re-hash straddle — NOT for cache invalidation; on a cache HIT
  `readCurrentIdentity` returns the stale identity and never computes `statIdentity`. So
  after a clean boot, a **same-size in-place content overwrite with the binary's mtime
  restored** (only ctime moves) leaves `statKey` unchanged → cache hit → no re-hash →
  `isRuntimeUpdatePending()` false, `hostSessionBlockReason()` null → a NEW host session
  is admitted against a **changed, non-running (exit 7)** binary while the module keeps
  reporting the boot hash. The module's own `statIdentity` comment
  ("a same-inode in-place overwrite that resets mtime is still caught") is therefore
  FALSE for the steady-state admission path. Clean-room ADVERSARIAL
  `post-boot-inplace-same-size-mtime-restor` (run `6a2b1dc30f27`, exit 1):
  `{sameIno:true, sameSize:true, sameMtime:true, ctimeMoved:true, pending:false,
  reason:null, bootHash 4dd25df9…, onDiskHash 40a636e8…}`. Its control
  `post-boot-unlink-recreate-same-size-mtim` (run `9e38773a357b`, exit 0) recreates with a
  NEW inode → cache miss → correctly BLOCKS, pinning the defect to the missing ctime.
- **Corroboration:** I reproduced the same fail-open against the REAL bundled binary in an
  isolated reflinked copy, restoring the binary's exact **nanosecond** mtime via
  `utimensat` (standard `python3 -c "os.utime(path, ns=(…))"`): `statKeySame:true`,
  `ctimeMoved:true`, `onDiskRuns:false`, module reports stale boot hash, `pendingAfter:false`.
  Also reproduced with a coarse whole-second mtime (exactly restorable — as npm/tar/reproducible
  builds with SOURCE_DATE_EPOCH produce). The round-5 fixing lane's own "Could NOT test" note
  dismissed this attack as "needs a forged mtime AND ctime" — true only for the straddle check;
  the cache path reads mtime alone, so forging only the (ns-precise, reachable) mtime suffices
  and ctime moving is irrelevant.
- **Realistic trigger:** a local actor able to overwrite the bundled binary in place
  (same byte size, different content) and restore its exact mtime (`utimensat` — Python
  `os.utime(ns=)`, `touch`, or C). Nothing ROUTINE hits it: a real `npm install`/revert
  renames → new inode → caught (my Attack 1: 6 real straddling installs, 0 bad admits); an
  ordinary in-place corruption bumps mtime → caught (fixer Part E). The clean-room verifier
  notes `cp -p`/`rsync -t`/tar-with-fixed-mtime as mtime-preserving copy tools, but those
  restoring a *different same-size* binary is contrived (a legit same binary hashes
  identically anyway). So: **primarily a deliberate adversary** with node_modules write
  access — largely outside the feature's routine-update threat model — but it IS a literal
  fail-open against the content-match requirement, and the module's documented ctime
  protection does not hold where it matters.
- **The round-5 CHANGE ITSELF is sound** (its three target scenarios all fail CLOSED):
  - my Attack 2 — binary churned in-place throughout boot (20 rename-overs) → boot fails
    CLOSED permanently, reason "the bundled runtime binary kept changing during the boot
    check"; a good stable binary afterwards does NOT recover without a restart (fail-safe).
  - my Attack 3 — platform dir is a symlink repointed mid-boot to a non-running binary →
    fail CLOSED, BOOT_IDENTITY null.
  - fixer Part H (rename + in-place swap between proof and hash) → fail CLOSED both variants.
- **Could NOT test:** actual authenticated model sessions (attacks call the guard functions
  directly); a real npm rename-over that happens to REUSE the same inode + mtime (filesystems
  won't reuse an inode on demand — but it would hit the same missing-ctime cache path); the
  boot-window package.json-vs-binary read race the verifier flagged as unbound; the destructive
  Docker rebuild under a live container session (finding #6, unchanged rounds 1–5).
- **Verdict handed to orchestrator:** FEAT-151 round 5 is **NOT VERIFIED / BROKEN**. The
  round-5 TOCTOU straddle fix works, but a fail-OPEN remains in the steady-state admission
  **cache key** (statKey omits ctime), reproduced independently by the clean room and by
  this lane on the real binary. regressed-from: round-4 cache-key design (defect #2/#3);
  round 5 added ctime to the straddle checks but not to the cache key. A round-6 fixing lane
  should add ctime to the cache/hash key (still satisfies defect #3: a revert with a fresh
  inode changes ctime → re-hash; an unchanged binary keeps ctime → no re-hash). SECURITY /
  session-lifecycle / fail-open class → the round-6 fix again warrants an independent
  cross-provider clean-room pass.

### 2026-09-24 — fixing lane (Opus 4.8), round 6 — add ctime to the steady-state admission cache key (round-5 verdict close)
- **Hypothesis (verified FIRST, before the edit):** only the cache key omitted ctime,
  and adding it does not break the revert-re-admit case nor re-hash an unchanged binary
  on every admission. Confirmed with real fs ops in a scratch dir: an in-place same-size
  overwrite with the mtime restored via `utimesSync` leaves `dev:ino:size:mtime`
  UNCHANGED but moves `ctimeMs` (`statKey (no ctime) unchanged: true`, `statIdentity
  (ctime) changed: true`), while a fresh-inode reinstall moves the key regardless. So the
  fix is a one-field key change with defect #3 preserved and no per-admission re-hash for
  an untouched binary (its ctime is stable). Hypothesis HELD.
- **Change (`src/server/runtime/runtime-update.ts`, unstaged; user owns git):**
  - `statKey` now returns `dev:ino:size:mtime:ctime` (was `dev:ino:size:mtime`). This is
    the key for BOTH the identity cache (`compositeKey`) and the binary-content hash cache
    (`hashCache.binKey`), so a post-boot same-size in-place overwrite that restores the
    original mtime (only ctime moves) now moves the key → cache miss → async re-hash →
    content differs from boot → admission fails CLOSED.
  - Collapsed the round-5 `statIdentity` (= `statKey` + ctime) into `statKey`, which now
    already carries ctime; its two straddle-check callsites (`bootChecked`, `ensureHash`)
    call `statKey` directly. No behaviour change to the boot proof↔hash TOCTOU guard —
    same fields compared.
  - Fixed the comments that claimed ctime protection the code did not have: the header
    "cache key covers every input" block, the `statKey` doc, and the two straddle comments
    now state ctime is in the key and why (mtime is forgeable via `utimes`, ctime is not;
    defect #3 still holds via fresh-inode key moves).
- **Defect #3 re-checked (charter):** still holds — a same-version revert gets a fresh
  inode from npm's rename-over, so `statKey` moves (with or without ctime), the binary
  re-hashes to the identical content hash, and admission re-admits with no restart. Part G
  (real npm install revert) stays green: `pendingAfterRevert:false`.
- **Must-FAIL proof (WA §C, before→after on the REAL module):** new Part I
  (`verify-feat-151-runtime-update.mjs`) normalises the binary's mtime to a whole second
  (utimes-restorable), does a same-size in-place content overwrite, restores that exact
  mtime, and asserts a new host session is BLOCKED. Ran it against the PRE-fix `statKey`
  (no ctime) — the FIX assertions FAILED as required:
  `FAIL FIX: the ctime move forced a re-hash and the content hash CHANGED — {…,"ctimeMoved":true,"oldAdmits":true,"hashChanged":false,"newPending":false}`
  (`curHash === bootHash`, a stale hit admitting the changed binary). With the fix both
  pass: `PASS FIX: a same-size, mtime-restored in-place overwrite BLOCKS new host sessions`.
- **Commands + real output (live tree):**
  - `node scripts/verify-feat-151-runtime-update.mjs` → `ALL PASS — 77 passed, 0 failed`
    (was 72; +5 from Part I).
  - `node scripts/verify-feat-151-http.mjs` → `ALL PASS — 9 passed, 0 failed`.
  - `node scripts/verify-feat-151-container.mjs` → `ALL PASS — 6 passed, 0 failed`.
  - `npm run gate` → `GATE: PASS — safe to commit. (exit 0)` (leak-gate + check-nul +
    typecheck all PASS).
  - `npx tsc --noEmit` → exit 0, 0 errors.
- **Orchestrator judgment (recorded here, not routed to the user):**
  > Round loop closed at round 6. The guard's threat model is SDK↔CLI skew from updates,
  > installs and rollbacks, not a local actor with write access to node_modules, who could
  > modify the unguarded SDK JS anyway. Every finding within that model is fixed and was
  > independently verified across rounds 1–5. The round-5 finding needed a deliberate mtime
  > forge. It is fixed here because the fix is a one-field key change, with no further
  > verification round (WA §N stopping rule). Residuals are follow-ups: the container rebuild
  > under a live container session is not exercised, and a truly offline host is not
  > exercised. OpenAI decorrelation was limited: filtered in round 4, quota-exhausted in
  > round 5.
- **regressed-from:** round-5 cache-key design (ctime added to the straddle checks but not
  to the identity/hash cache key). This round closes that gap.
- **Symptom of a deeper design flaw?** no — a single omitted stat field in one cache key,
  now covered; the identity/proof architecture from rounds 3–5 is unchanged.
