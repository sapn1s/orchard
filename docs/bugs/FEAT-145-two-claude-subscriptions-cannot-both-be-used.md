# FEAT-145 — Two Claude subscriptions cannot both be used

- **Status:** IN VERIFICATION — all 8 build steps LANDED (2026-09-18). Independent clean-room
  rounds: step 2 (registry) HOLDS, steps 4+5 HOLD, step 0 was BROKEN then re-fixed and wants a
  re-run; the credential-path round is still in flight and every HOLDS so far is SAME-PROVIDER
  (OpenAI quota-windowed). Not VERIFIED: verification is partially outstanding.
- **Severity:** medium (no data loss; the second plan just sits unused)
- **Area:** server (runtime / container-manager / provider-usage) / drawer settings
- **Reported:** 2026-09-18 by the user
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED (touches
  container bind recreation and the credential path every session reads — session-lifecycle
  class, flag for an independent clean-room pass per the standing rule on regression-prone areas).

## Symptom

The user holds two Claude subscriptions but can only use one at a time. Account
identity is implicit everywhere Orchard talks to the Claude CLI: the SDK reads
`~/.claude/.credentials.json` directly (`src/server/runtime/claude-runtime.ts:2-10`),
the container bind-mounts that exact file (`src/server/container-manager.ts:237`,
`:262-272`), and quota reads it directly too (`src/server/provider-usage.ts:184-193`).
Switching plans today means manually swapping that file by hand outside Orchard, so
in practice the second plan goes unused while the first sits in its 5-hour cooldown.

## Expected

A global default account (Machine settings) plus a per-session override, modelled on
the existing `provider`/`model` plumbing. Orchard drives the OAuth login for adding a
new account — no manual file swapping.

## Design invariant — state this prominently, it must not rot

An account dir is a **thin overlay over `~/.claude` that differs in exactly one file,
`.credentials.json`**. `projects/` and `settings.json` are symlinks back into the real
store, so there is still exactly ONE transcript store and zero reader changes anywhere
else in the codebase. `.claude.json` is deliberately NOT shared — it caches account
identity and trust records, and sharing it would leak one account's trust state into
another's session.

Verified against CLI 2.1.273: `CLAUDE_CONFIG_DIR` relocates the whole config store, and
`scripts/lib/station-boot.mjs:49-63` already builds the inverse of this overlay for the
test harness — read that function before building step 2 below, it is the existing
precedent for "overlay a config dir without duplicating the transcript store."

## Rejected options — recorded so they are not re-litigated

- **Per-account transcript stores.** Rejected: makes `encodedDir` an ambiguous key
  across roughly 15 call sites, needs a backfill of every existing session record, and
  splits the sidebar. An account is a billing fact, not a history fact.
- **Per-session account override inside containers.** Rejected: `desiredBinds()` is the
  container drift oracle, and the credentials file is one of its binds — switching the
  account for one session would recreate the container under every OTHER session on that
  same project, the same reason `mounts` is already project-scope-only today. Container
  projects get project-scope account pinning; `direct` (non-containerized) projects get
  the per-session override.
- **`CLAUDE_CODE_OAUTH_TOKEN`.** Kept on the shelf as a fallback ONLY if a fresh config
  dir turns out unable to run non-interactively (to be settled by build step 1). It swaps
  a refreshing credential for a static ~1-year token that Orchard would have to store and
  rotate itself, and it contradicts the no-API-key-path invariant already stated at
  `claude-runtime.ts:9-11`.

## Build steps (8, each independently landable)

0. **Realpath-aware `assertSessionStoreIsolated`.** `src/lib/paths.ts:162` compares paths
   lexically, so the isolation guard silently disarms for any symlinked store — this is a
   data-loss class defect once account dirs (which symlink `projects/`) exist, so fix it
   before anything else lands. IN FLIGHT.
1. **CLI probe.** In a fresh `CLAUDE_CONFIG_DIR`, test a non-interactive session, run
   `claude auth login` over pipes vs. a real TTY, and confirm `claude auth status --json`
   reports what's expected. Blocking, builds nothing — this determines whether the
   `CLAUDE_CODE_OAUTH_TOKEN` fallback above is ever needed. IN FLIGHT.
2. **Account registry.** `dataDir()/claude-accounts.json` + `src/server/claude-accounts.ts`
   + `GET/POST/DELETE /api/claude-accounts` + the overlay materialiser (build the account
   dir per the invariant above: symlink `projects/` and `settings.json`, own
   `.credentials.json` and `.claude.json`). The default account is implicit — `id: 'default'`,
   dir `~/.claude` — never a row in the registry, never deletable.
3. **"Add account" login flow.** Spawn `claude auth login --claudeai` with the new
   account's `CLAUDE_CONFIG_DIR`, relay its output over the existing WS connection, scrape
   the `https://claude.ai/oauth/authorize?...` URL out of that output for the user to open,
   accept the pasted code back on stdin, confirm success via `claude auth status --json`,
   and make cancel kill the whole process group (not just the leader).
4. **Global default setting.** `GlobalDefaults.claudeAccount: string | null`, seeded via
   `SEED_CHANNEL: 'projectSettings'` — it must be `projectSettings`, not `machineOnly`,
   because `SessionOverrides = Pick<ProjectSettings, ...>` at `src/server/validate.ts:537`
   means a per-session override can only exist for a field that lives on `ProjectSettings`
   in the first place. Wire it into the env edit at `src/server/agent-bridge.ts:1497-1507`
   and the drawer control at `public/lib/drawer.js:2827`. Proof bar for this step must
   include reading `/proc/<pid>/environ` under a **survived** (reattached) session — the
   hop from `src/server/survival.ts:328` to `src/server/session-host.mjs:191` is currently
   only reasoned about, never actually proven to carry the env var through.
5. **Per-session override.** Add the field to `ProjectSettings` and to
   `SESSION_OVERRIDE_FIELDS` (`src/server/validate.ts:524-535`), mirror it client-side at
   `public/app.js:44`, and add the explicit rejection path for container-backed projects
   (per the rejected-option note above — this must be a clear error, not a silent no-op).
6. **Container account binding.** `src/server/container-manager.ts:237` — the account's
   `.credentials.json` becomes the bind target instead of the hardcoded default. Must
   recreate the container exactly once when the project-level account changes, never loop.
7. **Quota plumbing.** Parameterise `readClaudeToken()` by account, rekey its cache by
   `provider\x00accountId`, and make sure the DEFAULT account is emitted FIRST in whatever
   list feeds `public/app.js:443` — that call site does `.find(s => s.provider === provider)`
   and must keep matching the default account unchanged when no other account exists yet.
   Burn-history in `scripts/usage.mts` keys extra accounts as `anthropic:<id>` so existing
   `anthropic` rows in that history stay byte-identical.
8. **Document the invariant.** Add the account-dir overlay invariant (see above) to
   `docs/CONVENTIONS.md`, so a future reader does not "clean up" the symlinks and quietly
   split the transcript store.

## Context pack (grows — the "where to look", so no agent cold-starts)
- Files/functions in play: `src/server/runtime/claude-runtime.ts:2-10`,
  `src/server/container-manager.ts:237,262-272` (`desiredBinds()`),
  `src/server/provider-usage.ts:184-193` (`readClaudeToken()`), `src/lib/paths.ts:162`
  (`assertSessionStoreIsolated`), `src/server/validate.ts:524-537`
  (`SESSION_OVERRIDE_FIELDS`, `SessionOverrides`), `src/server/agent-bridge.ts:1497-1507`,
  `public/lib/drawer.js:2827`, `public/app.js:44,443`, `src/server/survival.ts:328`,
  `src/server/session-host.mjs:191`, `scripts/lib/station-boot.mjs:49-63` (existing overlay
  precedent), `scripts/usage.mts` (burn history keys).
- Related tickets: none yet filed against the same files.
- Repro test: none yet — no verify script exists; step 2 onward should add one.
- Known dependencies / blockers: step 2 depends on step 0 and step 1 landing first (step 0
  because it is a correctness prerequisite once symlinked stores exist; step 1 because it
  decides whether the whole non-interactive-login approach is viable at all).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-18 — finding round 1
- **Understood:** the user has two Claude subscriptions and wants both usable from
  Orchard; account identity is currently implicit and singular across the SDK runtime,
  the container bind mounts, and quota reads. The user has already decided the shape
  (global default + per-session override, Orchard-driven OAuth login, thin overlay over
  `~/.claude`) and rejected three alternatives with reasons — filed here as the record.
- **Changed:** filed this ticket only. No code written this round.
- **Still open / handoff:** all 8 build steps are open. Steps 0 and 1 are flagged
  IN FLIGHT by the user as of filing — check for their outcome before starting step 2,
  since step 2's overlay materialiser depends on step 1's answer about non-interactive
  login viability.
- **Symptom of a deeper design flaw?** no

### 2026-09-18 — fixing round 1 (step 2 of 8: registry + HTTP + materialiser)
- **Scope:** step 2 ONLY — the accounts registry, its HTTP surface, and the
  overlay materialiser. No session wiring, UI, quota, or login flow (steps 3-7).
- **Built:**
  - `src/lib/paths.ts` — `accountsFile()` (`dataDir()/claude-accounts.json`) and
    `accountsDir()` (`dataDir()/claude-accounts/`), beside `globalSettingsFile()`.
    Re-read on disk first; did not disturb the other lane's `canonicalNearest()`
    / `assertSessionStoreIsolated` work.
  - `src/server/claude-accounts.ts` — new module (sibling idiom of
    `global-settings.ts`): tolerant-of-corruption reads, `writeAtomic`,
    field-by-field validation. The default account is IMPLICIT (id `default`,
    dir `~/.claude`), synthesised first by `listAccounts()`, never a row on disk.
    `resolveAccountDir(id)` is the ONE id→dir authority (ARCH-010) — a pure
    function of the id, and a stored `dir` is RECOMPUTED from the id on read so a
    hand-edited registry cannot repoint an account. Ids are server-minted opaque
    hex, never from the label. The invariant is stated in a header comment.
    `materialiseAccountDir` symlinks `projects` + `settings.json` into `~/.claude`,
    never creates `.credentials.json`, never touches `~/.claude`, is idempotent,
    and has distinct refusals (exists-not-ours / real store or settings missing /
    symlink points elsewhere). `deleteAccount` refuses `default`, verifies the dir
    is the one it minted (derived == stored, under the accounts root), UNLINKS the
    overlay symlinks without following them, and moves the dir aside to a trash
    path (recoverable). `readAccountHealth` shells `claude auth status --json`
    with `CLAUDE_CONFIG_DIR`, hard timeout, tolerant parse, `loggedIn` as truth.
  - `src/server/index.ts` — `GET/POST/DELETE /api/claude-accounts[/:id]` beside
    `/api/settings`, matching the existing error/validation style; `AccountError`
    carries the HTTP status.
  - `public/lib/api.js` — `getClaudeAccounts` / `createClaudeAccount` /
    `deleteClaudeAccount`, beside `getSettings`/`patchSettings`.
- **Verified:** `node scripts/verify-feat-145-accounts-registry.mjs` — 23/23 PASS
  against a LIVE server on a scratch `HOME` (fake `~/.claude` real store with a
  canary) + scratch `CLAUDE_STATION_DATA`. Proves: create via the live API with
  both symlinks resolving into `~/.claude`; `claude auth status --json`
  (real CLI 2.1.273) reports `loggedIn:false` with the right config/projects
  dirs; delete-safety canary survives (anchored by a must-FAIL twin —
  `rm -rf dir/projects/` DID follow the link and destroy an identical canary);
  delete refuses `default`; materialise idempotent; corrupt/truncated/garbage
  registry degrades to default-only; `~/.claude` byte-unchanged across the run.
  `npm run typecheck` exit 0; `npm run gate` PASS (exit 0).
- **Still open / handoff:** steps 3-7 (login flow, global default, per-session
  override, container binding, quota) unbuilt. Per the ticket's Verification-class,
  this touches the credential-path family — an independent clean-room verify pass
  is warranted before VERIFIED (session-lifecycle / regression-prone class).
- **Left unstaged for the user; no git writes performed. INDEX.md not edited.**
- **Symptom of a deeper design flaw?** no

### 2026-09-18 — verifying round 1 (step 0: realpath-aware `assertSessionStoreIsolated`)

- **Verdict: BROKEN (VALID, manifest-backed).** An independent clean-room pass was
  commissioned via `scripts/independent-verify.mjs` over an ISOLATED diff — only
  `src/lib/paths.ts` + `scripts/verify-feat-multi-account-store-guard.mjs`, built as a dangling
  `commit-tree` so the verifier saw a focused, prose-free diff and none of this ticket's
  rationale (the whole working tree was too dirty for `--working-tree`, which would have leaked
  untracked ticket prose). Change under test: `canonicalNearest()` + its use in
  `assertSessionStoreIsolated`.
- **Provider caveat — SAME-PROVIDER, therefore WEAKER.** Author was Claude; the intended
  cross-provider verifier is OpenAI, but OpenAI dispatch was rate-limited at run time
  (`dispatch failed [quota-window]`: usage limit, retry after 2026-09-19 13:37). Fell back to
  an anthropic clean-room verifier per the standing rule. Decorrelation is reduced — a
  same-provider verifier more easily SHARES a missed break — but a break it DID find still
  stands. Re-running under OpenAI once quota resets is worthwhile before step 0 is called done.
- **Verified-by:** dispatch anthropic run `3e2d3330-78a2-422b-8499-cff50288ea69`
  (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN.
- **FIXER-TEST re-run:** `node scripts/verify-feat-multi-account-store-guard.mjs` → exit 0,
  15/15 (manifest `06489e8dfc4b`). The author's suite genuinely passes; the defect is one it
  does not exercise.
- **The adversarial case that broke it — dangling `projects` symlink onto the real store
  (real store absent at guard time / TOCTOU).** The author's section 1 only builds a symlink
  whose target ALREADY EXISTS; section 4 only builds a fully-missing PLAIN path. Neither builds
  a `projects -> ~/.claude/projects` symlink while `~/.claude/projects` does not exist yet.
  Then `fs.realpathSync.native` throws ENOENT on the symlink leaf, so `canonicalNearest` stops
  at the nearest existing ancestor (the account dir) and re-appends the leaf LEXICALLY — it
  never reads the dangling link's target — yielding `<acct>/projects` instead of the real
  store. The two canonicalised paths then differ, `assertSessionStoreIsolated` takes the
  `return // isolated store: fine` branch, and does NOT throw for a non-sanctioned caller whose
  store symlink targets the real store. Silent false negative. This violates the fix's OWN
  stated invariant (requirement #3 / the `canonicalNearest` docstring: "a comparison failure
  can only ARM the guard, never disarm it") — here an ENOENT DISARMS it. Adversarial run
  `80971eacd47e` (exit 1): A multi-hop chain onto real store → THROWS (ok); B sibling near-miss
  → no throw (ok); C dangling projects→real → **NO THROW, guard disarmed**.
- **Independently reproduced by the harness** against the real `src/lib/paths.ts` (scratch
  `HOME`, real store deliberately absent): `readlink(projects) === realClaudeStoreDir` yet
  `assertSessionStoreIsolated` returns without throwing. Not a clean-room artifact.
- **Root cause / direction (NOT fixed here — verify lane):** `canonicalNearest` resolves
  symlinks only in the EXISTING portion of the path; a symlink at the not-yet-resolvable LEAF
  is treated as an opaque lexical component. Candidate fix: read the leaf's own
  `fs.readlinkSync` target (recursing) before the lexical fallback, so a dangling symlink onto
  the real store still canonicalises onto it. Whoever takes this must add the dangling/TOCTOU
  case to the suite and re-verify.
- **Could NOT test (verifier's honest list):** (1) the downstream CLI actually WRITING through
  the dangling symlink into the real store at runtime — `mkdirSync(recursive)` on a dangling
  symlink node itself threw ENOENT in this Node build, so only the guard-disarm + that the link
  target IS `realClaudeStoreDir` were shown, not the end-to-end pollution; (2) any INVERSE
  spurious-throw case — every genuinely-isolated store the verifier built (sibling near-miss,
  separate scratch dir, store under a symlinked HOME) resolved correctly and did not throw, so
  the "canonicalisation wrongly collapses an isolated store onto the real store" direction
  appears sound and was NOT broken.
- **Practical blast-radius:** the disarm requires `~/.claude/projects` to be ABSENT at guard
  time (fresh machine / fresh account / first run). On an in-use machine where the real store
  already exists, the leaf resolves and the guard arms correctly — but the fix's invariant is
  unconditional, and first-run is exactly when a new account is set up, so this is not a corner
  to wave off. Bucket: data-loss / session-lifecycle → step 0 is NOT done; re-fix + an
  independent pass (ideally OpenAI, once quota resets) warranted before VERIFIED.
- **No code changed by this lane (verify-only); no git writes; INDEX.md not edited.**
- **Symptom of a deeper design flaw?** no

### 2026-09-18 — fixing round 1 (step 4 of 8: global default account + session env wiring + Machine control)

- **Scope:** step 4 ONLY — the machine-default `claudeAccount`, its machine→project
  inheritance, the session env wiring to `CLAUDE_CONFIG_DIR`, and the Machine-settings
  control. Did NOT touch the login flow (step 3), `SESSION_OVERRIDE_FIELDS`/
  `SessionOverridable` (step 5), `container-manager.ts` (step 6), or
  `provider-usage.ts`/`scripts/usage.mts`/the usage badge (step 7, another lane live).
- **Built:**
  - `src/server/global-settings.ts` — `GlobalDefaults.claudeAccount: string | null`
    (default `null` = implicit `~/.claude`); `SEED_CHANNEL.claudeAccount:
    'projectSettings'` (verified: the `satisfies` map + `SessionOverrides =
    Pick<ProjectSettings,…>` require it, so step 5's override is expressible).
    `normalise()` reconciles a stored id against `readAccounts()` — the `'default'`
    sentinel AND any DELETED id normalise back to `null`, never dangling.
    `applyGlobalDefaults()` extended to merge `claudeAccount` (optional input, so the
    FEAT-118/139 callers are source-compatible — both suites still green).
    Import direction `global-settings → claude-accounts → paths` (no cycle).
  - `src/server/registry.ts` — `ProjectSettings.claudeAccount: string | null` +
    `defaultSettings()` seeds `null`; rides the existing `PROJECT_SETTINGS_SEED_KEYS`
    seed path automatically.
  - `src/server/validate.ts` — project PATCH validates `claudeAccount`: null / the
    'default' sentinel → null; an existing id kept; an unknown id rejected (400).
  - `src/server/agent-bridge.ts` — `Overridable` widened to
    `Pick<ProjectSettings, SessionOverridable | 'claudeAccount'>` (does NOT widen the
    override surface — `SessionOverridable` untouched); `pickOverridable` merges the
    account. At launch, for the anthropic provider only, `resolveLaunchAccountDir` sets
    `CLAUDE_CONFIG_DIR` ONLY when the effective account is non-default — the default
    sets NO var (byte-identical to today). The env literal was pulled into
    `dispatchEnv` + `accountEnv` and merged.
  - `src/server/claude-accounts.ts` — new `resolveLaunchAccountDir(id)`: returns null
    for the default; for a named account it throws LOUDLY (never silently falls back to
    `~/.claude`) with three distinct 409s — no such account / not `state:'ready'` /
    ready-but-`.credentials.json`-gone — and idempotently materialises the overlay
    before returning the dir.
  - `public/lib/drawer.js` — `ensureGlobals()` also fetches `/api/claude-accounts`; a
    "Default Claude account" control in `machineDefaultsView()` shows each account's
    label + plan + login state, with an empty state pointing at the (step 3) "Add
    account" button when no extra account exists yet.
- **Verified:** `node scripts/verify-feat-145-session-wiring.mjs` — 21/21 PASS on a
  scratch HOME (fake `~/.claude`) + scratch `CLAUDE_STATION_DATA`. Real observed values,
  not PASS/FAIL theatre. Proves: default ⇒ no var; pending account fails loudly;
  ready-but-no-cred fails loudly; ready+cred resolves to the overlay dir; a deleted
  machine-default id AND a hand-written garbage id both normalise to null;
  machine→project inheritance (null inherits, non-null project wins); the project PATCH
  validator; a transcript in `~/.claude/projects` readable through the overlay (one
  store, zero reader changes). **B1 DIRECT** and **B2 SURVIVAL** read `/proc/<pid>/environ`
  of REAL children: direct non-default carries `CLAUDE_CONFIG_DIR===overlay`, default is
  ABSENT; and the **survival hop DOES survive** — the CLI under a real
  `claude-station-host-t-*.scope` (cgroup confirmed) carries the var
  (survival.ts `runEnv` → systemd-run --scope → session-host.mjs
  `augmentedPathEnv(process.env)`). The ticket's flagged single-most-likely silent break
  is empirically NOT broken. No stray scopes/hosts leaked; reaped by `handle.reap()` +
  pid.
- **`npm run typecheck` exit 0; `npm run gate` PASS (exit 0).** Anti-regression:
  verify-feat-118 18/18, verify-feat-139 21/21, verify-feat-145-accounts-registry 23/23.
- **Could NOT test:** (1) a full real logged-in Claude turn end-to-end — the /proc reads
  use a stub leaf process, which is the faithful way to observe the env travelling
  through the real spawn/scope path without a live subscription; the SDK's own leaf
  spawn (direct, non-survival) is driven via the baseSessionEnv formula
  (claude-runtime.ts:573), not the SDK query, so the SDK-internal spawn is reasoned +
  typecheck-verified, not executed. (2) container isolation (step 6 owns the container
  bind; a container session never reaches this env path). (3) the actual quota effect of
  spending a second plan (step 7).
- **High-stakes note:** touches the credential path every session reads
  (session-lifecycle / regression-prone class per this ticket's Verification-class) — an
  independent clean-room verify pass is warranted before this step is called VERIFIED,
  ideally exercising the survival hop on the real deploy.
- **Left unstaged for the user; no git writes performed. INDEX.md not edited.**
- **Symptom of a deeper design flaw?** no

### 2026-09-18 — fixing round 2 (step 0 re-fix: the dangling-symlink disarm)

- **Scope:** `src/lib/paths.ts` + `scripts/verify-feat-multi-account-store-guard.mjs` ONLY.
  Fixes the refutation in the entry directly above.
- **Root cause confirmed as filed.** Round 1's `canonicalNearest` canonicalised only the
  EXISTING prefix with `fs.realpathSync.native` and re-appended the remainder LEXICALLY.
  `realpathSync` reports ENOENT for a dangling symlink exactly as for an absent plain file,
  so the link's *name* survived and its *target* was never read: a
  `projects -> ~/.claude/projects` link created before the real store exists canonicalised
  to `<acct>/projects`, the guard took `return // isolated store: fine`, and the CLI (which
  resolves the link on write, creating the target) wrote the user's real store. An ENOENT
  DISARMED the guard. The same non-ENOENT fallback (`return path.resolve(p)`) disarmed it
  for ELOOP/EACCES too — a second instance of the same defect the refutation did not name.
- **Built — `canonicalNearest` no longer delegates to `realpathSync`.** It walks the path
  component-by-component from the filesystem root, `lstat`ing each; on a symlink it reads
  the target with `readlinkSync` (which works on a DANGLING link — the link's INTENT is what
  must be compared), resolves a relative target against the link's own directory as the
  kernel does, and recurses so the target's own ancestors and any further hop resolve too.
  `..` is applied to the already-resolved prefix instead of being collapsed lexically up
  front, so `…/link/../x` means "the parent of link's target".
- **Fail-closed is now structural, and every non-happy branch is audited in the docstring.**
  `ENOENT` from `lstat` is the ONLY branch that continues without knowing the destination,
  and it is safe because absence is a FACT: nothing can exist beneath a missing component,
  so no redirection can hide there and the lexical tail is truthful. Every other outcome —
  EACCES / ELOOP / ENOTDIR / EIO, a `readlink` that fails after `lstat` said "symlink"
  (concurrent replacement), or the shared hop budget (`MAX_SYMLINK_HOPS = 40`, Linux
  SYMLOOP_MAX) running out — throws `UnresolvablePathError`.
  `assertSessionStoreIsolated` catches it and takes the REAL-STORE branch: "isolated" is now
  concluded only from a COMPLETED resolution, never from an error. The refusal message names
  the unresolvable path and its errno. A shared hop budget across the recursion is what makes
  a cycle terminate without needing cycle detection, and bounds recursion depth at 40.
- **Semantics preserved exactly:** the sanctioned-writer + `dataDirMode === 'shared'` allow
  still runs after the real-store verdict, including for the unresolvable case (same branch a
  literal real-store path takes), so the production server is unaffected.
- **Verified — `node scripts/verify-feat-multi-account-store-guard.mjs` → exit 0, 47/47**
  (was 15/15; the original 15 all still pass). Scratch `HOME` throughout; the real
  `~/.claude/projects` is never named, read or linked to. Added, each printing its OBSERVED
  value and asserting its preconditions:
  - §5 the dangling-leaf **must-FAIL**: ROUND 1's canonicaliser is synthesized INLINE (not
    `git show`n from a revision, so the proof survives the commit — CONVENTIONS "a must-FAIL
    proof must not be anchored to a moving baseline") and OBSERVED returning
    `round1(store)=<acct>/projects` vs `round1(real)=<home>/.claude/projects` ⇒ `isolated=true`
    (the bug), while the shipped guard THROWS `REFUSING`. Preconditions assert the real store
    is genuinely absent, the link target IS `realClaudeStoreDir`, and `realpathSync.native`
    really answers ENOENT on the leaf.
  - §6 dangling link whose target's **parent** (`~/.claude`) is also absent → throws.
  - §7 chain `projects -> hop-b -> <real store>`, dangling at the second hop → throws.
  - §8 **relative** target (`../../home/.claude/projects`), both dangling and live → throws in
    both states (the decision is independent of hop materialisation).
  - §9 **cycle** `projects -> loop-b -> projects` → terminates in **2 ms**, no `RangeError`,
    and ARMS the guard with `could not be canonicalised`; round-1 CONTROL shows it was
    wrongly ISOLATED (the ELOOP fallback).
  - §10 **TOCTOU** — guard called while the target is absent, target materialised only
    afterwards; asserts the decision ALREADY taken was the refusal.
  - §11 **inverse, 5 cases, no spurious throws**: separate real dir; symlink onto a separate
    store; DANGLING symlink onto a separate (absent) store; unmaterialised account dir under a
    SYMLINKED parent; relative symlink onto a separate store. Run with the sanctioned marker
    set but `CLAUDE_STATION_DATA` isolated, so a wrong collapse onto the real store WOULD throw.
- **Anti-regression:** `node scripts/verify-leak-store-guard.mjs` → exit 0, **13/13** (unchanged).
- **`npm run typecheck` / `npm run gate`: zero errors from this lane's files; BOTH currently
  FAIL on another lane's in-flight step-4 code** — `src/server/agent-bridge.ts` (`Overridable`
  missing `claudeAccount`, then `resolveLaunchAccountDir` not exported) and
  `src/server/global-settings.ts:246` (TS2871 "always nullish"). The errors shifted between two
  consecutive `tsc` runs minutes apart, which is that lane still editing. `npx tsc --noEmit |
  grep src/lib/paths` → **(none)**. Gate's other stages PASS (`leak-gate`, `check-nul`); it
  stops at `typecheck`. This needs re-running once the step-4 lane lands.
- **Could NOT test:** (1) the end-to-end pollution — the CLI actually writing through a
  dangling link into the real store — for the same reason the round-1 verifier gave: this is a
  pure-guard change and driving the real CLI at a real store is the thing the guard exists to
  prevent; what is proven is that the guard now REFUSES that configuration. (2) A whole-repo
  green typecheck/gate, blocked by the concurrent lane above. (3) Non-Linux path semantics
  (Windows roots / junctions) — `path.parse().root` is handled generically but only POSIX was
  exercised, and only POSIX is in scope for this product.
- **Left unstaged for the user; no git writes performed. INDEX.md not edited.**
- **Symptom of a deeper design flaw?** no — but note the same fallback disarmed the guard for
  ELOOP/EACCES as well as ENOENT, so the class was "an error branch that returns a *value*
  instead of refusing". The re-fix removes the value-returning error branch entirely.

### 2026-09-18 — fixing round 1 (step 7 of 8: per-account quota reporting)

- **Scope:** step 7 ONLY — `src/server/provider-usage.ts`, `scripts/usage.mts`, the
  usage badge/tooltip region of `public/app.js`. No registry, session-wiring, container
  or login changes; `global-settings.ts`, `registry.ts`, `agent-bridge.ts`,
  `public/lib/drawer.js` and `src/lib/paths.ts` were left untouched (other lanes in flight).
- **Built:**
  - `src/server/provider-usage.ts` — `readClaudeToken(accountDir)` now takes the account's
    config dir explicitly (from `resolveAccountDir(id)`, the sole ARCH-010 authority; it is
    never rederived here and `CLAUDE_CONFIG_DIR` is deliberately NOT consulted — that
    describes the server's own session, not the account being polled). `readClaudeUsage`
    gains `{ accountId, accountLabel }` and threads the account's token into the
    `Authorization` header; the endpoint is per-token so nothing else in the request
    changes. `ProviderUsage` gains `accountId` / `accountLabel`. `cache`/`inflight` are
    rekeyed `provider\x00accountId` (keyed by provider alone, account B was served A's
    snapshot for up to the 60s TTL). New `usageTargets()` enumerates every registered
    Claude account (DEFAULT FIRST — `listAccounts()` guarantees the order) plus openai,
    and degrades to default-only if the registry is unreadable. `getUsageSnapshots()`
    and the new `readUsageForTarget()` take targets instead of a fixed provider pair.
    A `CLAUDE_STATION_USAGE_URL` test seam lets a suite stub the endpoint.
  - `scripts/lib/usage-history.mjs` — NEW. The burn history reader/writer, extracted
    from `usage.mts` so the keying rule is directly gradable. **The rule, stated in the
    file:** the default account writes the bare `'anthropic'` key, byte-identical to every
    pre-145 row, so its existing history keeps matching `priorFor()`; every other account
    writes `anthropic:<accountId>` and gets its own KEEP=8 bucket. A brand-new account
    therefore has no prior read on its first call and reports a window-average, which
    `deriveWindow`'s `rateSource` already labels honestly rather than showing 0%/hr.
  - `scripts/usage.mts` — reads ALL targets, derives each against its OWN history key,
    prints one clearly-labelled block per account plus a "most 5h headroom" summary when
    more than one Claude account exists (with one account the readout is unchanged).
  - `public/app.js` — `usageTitle()` renders one block per snapshot in server order,
    naming non-default accounts (`Claude (work)`); the badge selects the snapshot for the
    account THIS session will actually run on via a new defensive `claudeAccountView()`
    (override → project setting → `'default'`), falling back to the first anthropic
    snapshot. With one account both are byte-identical to pre-145.
- **Verified:** `node scripts/verify-feat-145-usage.mjs` → **59/59, exit 0** (also
  `npm run verify:feat-145-usage`). It prints observed values, never bare PASS/FAIL, and
  never touches the live Anthropic endpoint (local stub) or the real `~/.claude`:
  - pre-existing `anthropic` rows in the REAL `usage-burn-history.jsonl` are BYTE-IDENTICAL
    across a run that also writes an `anthropic:<id>` account (sha 37bd6da04cdfbc89 before
    and after, 16 rows both), and a full post-145 run leaves the `anthropic` series
    identical to a synthesized pre-145 run (cef1de1bac1247e5 both);
  - `priorFor()` still finds the default account's real pre-existing 5h row
    (25% / resetsAt 1788962399), anchored by a **must-FAIL twin**: naive `anthropic:default`
    keying makes that lookup return null and strands 16 orphaned rows;
  - two accounts with different `resetsAt` are cached and served separately
    (A 11%/1788600000, B 77%/1788644444) with no re-fetch inside the TTL; the must-FAIL
    twin shows provider-only keying serving B account A's 11%;
  - a pending (no creds), a 401 and a wedged/timeout account all degrade to unknown with
    honest notes while both healthy accounts still report their own values; no token
    appears anywhere in any snapshot;
  - a single-account setup (child process, empty registry) yields exactly the pre-145 two
    rows, anthropic first, `.find(s => s.provider === 'anthropic')` resolving to the default
    account, and a strict superset payload (only `accountId`/`accountLabel` added);
  - the badge/tooltip are graded against the REAL `public/app.js` source (functions
    extracted, never re-implemented) with the pre-145 selection logic synthesized inline as
    a FIXED baseline: one account → byte-identical tooltip (sha 39f49b2e312121b5); two
    accounts pinned to the second → badge shows 77% where pre-145 would have shown 11%;
  - `readHistory` graded over the real file truncated at 9 points — never throws, always a
    clean prefix (per docs/CONVENTIONS on readers of files other processes write).
  - Sibling sweep: `node scripts/verify-feat-119-usage-awareness.mjs` 24/24;
    `node scripts/verify-feat-116-provider-usage.mts` 20/20 (its live-Claude section
    SKIPped on an endpoint **HTTP 429** from repeated polling — transient, unrelated;
    a real `npm run usage` minutes earlier read 5h 21% / weekly 61% live and successfully).
  - A REAL `npm run usage` against the live endpoint: single-account output unchanged
    (`ANTHROPIC (max)`, no account label), 28/32 pre-existing history lines byte-identical
    with the 4 changed lines being ordinary pre-existing KEEP=8 pruning.
  - `npm run typecheck` exit 0.
- **`npm run gate`: FAIL, and NOT from this lane.** The leak-gate reports 2 hits in
  `scripts/verify-feat-145-session-wiring.mjs:199` — one string literal there is a
  Claude-style ENCODED HOME PATH for a fixture project dir, which embeds the real
  username, so it trips both the encoded-home-path and the bare-username detectors. The
  file is owned by the step 4/5 lane. `check-nul` and `typecheck` both PASS, and this
  lane's own files are clean. Whoever owns that file must replace that literal with a
  neutral encoded path (no real username) before anything here is committed. Run
  `node scripts/leak-gate.mjs --summary` to see it; the value is deliberately not
  reproduced in this ticket.
- **Still open / handoff:** steps 3, 6, 8 unbuilt; steps 4/5 in flight elsewhere. Once the
  account setting lands on `ProjectSettings`, nothing here needs changing — the client reads
  `claudeAccount` defensively today and resolves to `'default'` until it exists. Per the
  ticket's Verification-class, an independent clean-room pass is still warranted.
- **Could NOT test:** (1) a real SECOND Claude subscription — no second credential exists on
  this machine, so account B is a stub-token fixture; the live endpoint was only ever read
  with the default account's real token. (2) The badge in a real browser under a real
  two-account server (the DOM assertions run the real `public/app.js` functions with stub
  `state`/`node`, not a rendered page) — a visual pass is worth doing once step 4 lands and
  a second account can actually be selected. (3) `GET /api/usage` over HTTP with two accounts
  registered — the handler is unchanged and was graded through `getUsageSnapshots()` in-process.
- **Left unstaged for the user; no git writes performed. INDEX.md not edited.**
- **Symptom of a deeper design flaw?** no

### 2026-09-18 — step 2 (accounts registry): INDEPENDENT CLEAN-ROOM VERIFICATION — VERDICT: **HOLDS** (verifying, round 1, class=verify)

- **Verified-by:** dispatch anthropic run `11a7fabe-2584-49d7-86ce-3a307a31e3a9`
  (clean-room, `scripts/independent-verify.mjs`) — VERDICT: HOLDS, contract VALID
  (manifest-backed; adversarial cases `delete-symlink-shapes`, `health-probe-degrade`).
- **PROVIDER CAVEAT — the verdict is SAME-PROVIDER and therefore weaker.** Cross-provider
  (OpenAI) was attempted first and the dispatch died on `quota-window` ("usage limit …
  try again Sep 19th 13:37"), so nothing was verified on that attempt (the harness
  correctly reported INVALID, exit 3). The run above fell back to `--provider anthropic`
  against an anthropic-authored change: the blind spots are correlated, which is exactly
  what cross-provider verification exists to break. Re-run on OpenAI after the quota
  window if the delete path is ever changed again.
- **Harness scoping (declared, not hidden).** `git clone` into a scratch base is blocked
  for agent sessions, so the run used `--working-tree` against the real tree — whose
  snapshot diff is 1.37 MB of several concurrent, unrelated lanes (transcript mirroring,
  the git shim, the lane ledger, the `assertSessionStoreIsolated` rewrite). The harness
  auto-diff was therefore suppressed (`--max-diff-bytes 0`) and the FEAT-145 surface
  alone — `src/server/claude-accounts.ts` in full, the two `paths.ts` accessors, the three
  `index.ts` routes, the `api.js` helpers — was supplied verbatim inside the requirement,
  with the out-of-scope lanes named as out of scope. The clean room still stripped
  `docs/prompts` and `docs/bugs`, so the verifier saw no methodology, no board and no
  author prose. The clean-room working copy itself carries the other lanes' code (it must,
  to boot the server); only the *diff under judgement* was scoped.
- **(i) The author's suite RE-RUN:** `node scripts/verify-feat-145-accounts-registry.mjs`
  — exit 0, **23 passed / 0 failed** (manifest `7b302cb03ec6`). Re-run by the verifier in
  the clean room, not by the author.
- **(ii) Adversarial case that mattered most — `delete-symlink-shapes`** (manifest
  `53718ad18e53`, `node scripts/adv-delete-symlink-shapes.mjs`, exit 0). The author's
  fixture deletes an account whose `projects` is ONE direct symlink with a trusted
  registry. This case stacked four escapes the fixture never produces, simultaneously:
  a **relative symlink CHAIN** for `projects`, a **relative** `settings.json` link, an
  extra **rogue symlink** aimed at the real store, and a `claude-accounts.json` whose
  stored `dir` had been **tampered to name `~/.claude` itself**. Result: the canary in
  the (scratch) real store survived, `projects` was still a real directory, and the
  scratch `~/.claude` was byte-unchanged — because `readAccounts()` recomputes `dir`
  from the id (so the tampered `dir` never reaches a filesystem call, and the
  `row.dir !== derived` check then refuses) and `removeAccountDir` unlinks only the two
  named links before `rename`, never recursing and never following.
  Second adversarial case, `health-probe-degrade` (manifest `928f0d31b210`): missing
  binary, a hang past the timeout (degraded in 805 ms), and non-JSON stdout each returned
  `{loggedIn:false, error}` without throwing — requirement 5's failure paths, which the
  author's fixture never exercises (it probes a real logged-out binary once).
- **(iii) What the verifier could NOT test (its own words, condensed):**
  1. **Concurrent create/delete racing `claude-accounts.json`** — `createAccount` does
     read → mint → materialise → `writeAccounts` with no lock, so two simultaneous POSTs
     could lose-update a row. It could not force a same-millisecond interleave, and
     lost-update is not forbidden by the stated requirement. **This is a live, named
     residual, not a clearance** — the registry has no writer arbitration.
  2. **The logged-IN branch of `readAccountHealth`** (`subscriptionType` populated) —
     no real second credential exists on this machine, so only `loggedIn:false` was ever
     observable. Same gap the step 4/5 lane already recorded.
  3. **A true TOCTOU swap** replacing the account dir with a symlink to `~/.claude` in the
     window between `deleteAccount`'s `existsSync` and `removeAccountDir`'s `renameSync` —
     not deterministically reproducible from a script.
- **Harness could-not-test, additional:** the cross-provider verdict (quota), and the UI
  side of `public/lib/api.js` (no browser pass — the helpers were only read, never driven).
- **SAFETY — the real `~/.claude` was never a target, and is confirmed unchanged.** Every
  test (the author's suite and both adversarial scripts) built a scratch `HOME` +
  `CLAUDE_STATION_DATA` and a fake `~/.claude`; the requirement text made that
  non-negotiable and named it before anything else. Confirmed by a before/after snapshot
  of the real store taken by the harness: the top-level entry set is **byte-identical**
  (same names, same types), `settings.json` sha256 prefix **unchanged**, `.credentials.json`
  **still present**. The transcript count only GREW (8331 → 8341 files,
  2.272 GB → 2.275 GB) — which is this session and the dispatch writing their own
  transcripts; nothing was removed or shrunk. The real station data dir likewise has no
  `claude-accounts.json`, no `claude-accounts/` and no `claude-accounts-trash/`, proving
  no account path ever ran against it.
- **No git writes performed. No source file modified. INDEX.md not edited.**

### 2026-09-18 — fixing round 1 (step 6 of 8: container account binding)

- **Scope:** `src/server/container-manager.ts` + the new
  `scripts/verify-feat-145-container-account.mjs` ONLY. No other file touched
  (steps 4/5/7 lanes own `paths.ts`, `global-settings.ts`, `registry.ts`,
  `agent-bridge.ts`, `validate.ts`, `drawer.js`, `app.js`, `provider-usage.ts`,
  `usage.mts`); `package.json` deliberately NOT edited, so there is no
  `npm run verify:feat-145-container-account` alias yet — run the file directly.
- **Built — the bind, not the env.** `credentialsFile()` (was a hardcoded
  `~/.claude/.credentials.json`) is now `credentialsBind(project)`: it resolves
  the project's EFFECTIVE account and binds THAT account dir's
  `.credentials.json` at the same container path (`$CONTAINER_HOME/.claude/
  .credentials.json`), same rw-ness, same position in the list. Three decisions
  worth keeping:
  - **Only that one file crosses.** The account dir is NOT bind-mounted
    wholesale: its `projects` / `settings.json` are symlinks to HOST paths that
    do not exist at those paths inside the container, so mounting the dir would
    hand the CLI a dangling `projects` — transcripts silently stopping. The
    container keeps its own image-local `$HOME/.claude` as config dir, the
    session-history bind is untouched, and the only per-account variable is the
    credential file. **No `ENV_PASSTHROUGH` entry was needed**, and a comment
    there now states that `CLAUDE_CONFIG_DIR` must never be added: agent-bridge
    sets it to a host path, forwarding it would point the CLI at an empty config
    dir it would create fresh (no credential, no `settings.json` ⇒
    `cleanupPeriodDays` back to 30, transcripts nowhere a reader looks).
  - **Project scope, machine-inherited.** `containerAccountId()` uses
    `applyGlobalDefaults` — the SAME machine→project merge `pickOverridable()`
    feeds a direct session's `CLAUDE_CONFIG_DIR` with — so a container project
    and a direct project on the same settings resolve to the same account, and
    moving the machine default moves inheriting container projects with it.
    Reading only `project.settings.claudeAccount` would strand them on the old
    account, which is the wrong plan's quota with no signal. Per-session is
    rejected by design (drift oracle; step 5 owns the refusal path). Note this
    makes container-manager a SECOND caller of `applyGlobalDefaults`, so that
    function's docstring line calling `pickOverridable` "the sole runtime
    caller" is now stale — one line for whoever next edits `global-settings.ts`.
  - **Loud, never a fallback.** The gate is `resolveLaunchAccountDir` (shared
    with the direct path, so both refuse on identical grounds) and the dir comes
    only from `resolveAccountDir` (ARCH-010, never re-derived). An
    `AccountError` is wrapped as `ContainerError('account-unavailable', …)`
    whose detail says the container is deliberately NOT started on the default
    account. `desiredBinds` THROWS rather than returning a list, so no caller can
    act on a half-right bind list; `statusOf` already catches and reports
    `state:'error'`.
- **Verified — `node scripts/verify-feat-145-container-account.mjs` → exit 0,
  29/29**, against REAL Docker (server 29.6.2) and the REAL station image, with a
  scratch `CLAUDE_STATION_DATA` and the real `HOME` (the default account IS
  `~/.claude`). Every check prints its observed value, redacted to `~`; no real
  path or username is written into the script. Proven:
  - a default-account project's bind list is **byte-identical** to a
    SYNTHESIZED pre-change list (built inline, not `git show HEAD:…`), anchored
    by a must-FAIL twin: the same comparison against a named account differs in
    **exactly one** element, the credential bind;
  - machine-default inheritance, project pin overriding it, and clearing the
    machine default returning the list to the pre-change one;
  - four loud refusals (no row / never logged in / ready-but-credential-gone /
    path-shaped id), each showing the naive pre-fix path it replaces, plus
    `ensureContainer` refusing with no container created;
  - `execArgv` drops `CLAUDE_CONFIG_DIR` and still forces `HOME` + the
    `ORCHARD_SESSION` marker;
  - **recreate exactly once, no loop:** ensure #1 starts; ensure #2 with no
    change leaves the container id unchanged; switching the project's account
    logs one `recreating` with the bind diff and produces a NEW id; ensure #4
    leaves it unchanged. The no-recreate assertion is the *same* id-equality
    comparison that reddened across the genuine recreate in the same run, so a
    recreate loop cannot pass silently;
  - `docker inspect` showing the selected account's credential path bound rw at
    the container path, the default one gone, and the container holding that
    account file's own **inode** (≠ the default file's inode);
  - **two real CLI turns inside the container**: one on the default account and
    one on a named account, both answering, each transcript landing in
    `containerHistoryDir()` (the real single store) with `"cwd":"/workspace/…"`;
    and a third on an account whose credential is deliberately invalid, which
    fails with `Not logged in · Please run /login` instead of silently
    succeeding on the default account;
  - returning the project to the default account restores a bind list
    byte-identical to the synthesized pre-change one.
- **Fixture note:** no second Claude subscription exists on this machine, so the
  "named account that works" fixture is an account dir whose `.credentials.json`
  is a symlink to the real one (never a copied token — a copy could rotate and
  invalidate the user's real refresh token). Account identity is therefore
  distinguished by the invalid-credential account, the inode check and the
  inspect path, not by two real plans.
- **`npm run typecheck` exit 0 (whole repo, zero errors); `npm run gate` PASS
  (exit 0)** — leak-gate, check-nul and typecheck all green. The step-4/5 lane's
  earlier leak-gate hit is gone. Sibling sweep: `verify-container.mjs` container
  session PASS, `verify-feat-102-static` 10/10, `verify-feat-102-dispatch-broker`
  25/25, `verify-bug-152-browser-degrades` 25/25.
- **Pre-existing, NOT from this lane:** `verify-bug-107-image-staleness.mjs` is
  5/18 — its harness copies only `src/` into a throwaway tree, and
  `registry.ts → wiring.ts` imports `scripts/lib/board-path.mjs`, which is
  therefore absent, so `container-manager` fails to import there at all. That
  import chain predates this change (container-manager has always imported
  registry); the suite needs `scripts/lib/` copied too. Worth its own ticket.
- **Could NOT test:** (1) two REAL subscriptions actually billing separately —
  impossible on this machine, see the fixture note; what is proven is which
  credential file the CLI inside the container uses and that a wrong one fails
  loudly. (2) A container recreate racing a LIVE session in the same container
  (an account switch kills sibling sessions in that container, which is the
  established behaviour of every bind change and is why per-session is rejected)
  — not exercised here. (3) The drawer/UI path for choosing a container
  project's account (step 5's lane). (4) `staleFileBinds` inode-drift healing for
  an account credential replaced by a host-side rotation — the mechanism is
  unchanged and account-agnostic, but only the default-account file was ever
  observed rotating.
- **Left unstaged for the user; no git writes performed. INDEX.md not edited.**
- **Symptom of a deeper design flaw?** no

### 2026-09-18 — fixing round 1 (step 5 of 8: the per-session Claude account override)

- **Scope:** step 5 ONLY — `SESSION_OVERRIDE_FIELDS`, the container refusal, the
  client mirror, and the launch-surface control. Did not touch the login flow
  (step 3), `container-manager.ts` (step 6), `provider-usage.ts`/`usage.mts`
  (step 7) or `src/lib/paths.ts` (step 0).
- **What step 4's lane had ALREADY done, re-read on disk first (not duplicated):**
  `ProjectSettings.claudeAccount` + `defaultSettings()` seed (registry.ts);
  `GlobalDefaults.claudeAccount` with `SEED_CHANNEL:'projectSettings'` and
  `normalise()` reconciling a deleted/garbage id back to null
  (global-settings.ts); the project-PATCH branch in `validateProjectPatch`
  (validate.ts) — including the `'default'` sentinel → null rule and the
  `readAccounts()` existence check this step's override path now reuses;
  `pickOverridable()` merging the account and the `CLAUDE_CONFIG_DIR` env edit
  keyed on `effective` (agent-bridge.ts); the Machine-settings control
  (drawer.js). None of it was reverted or re-derived.
- **Built (what was missing):**
  - `src/server/validate.ts` — `'claudeAccount'` added to
    `SESSION_OVERRIDE_FIELDS`, with a comment pair naming `public/app.js`'s
    `SESSION_OVERRIDABLE` (and vice-versa) so the hand-maintained mirror is at
    least self-documenting; the mechanical guard against drift is the set-equality
    assertion in the verify script, run from both directions. **The container
    refusal**: `validateSessionOverrides` now takes a REQUIRED
    `ctx: SessionOverrideContext { isolation }` and throws for
    `claudeAccount` + `isolation:'container'`, naming the reason (the credential
    is one of the container's binds; `desiredBinds()` is the drift oracle, so a
    per-session switch recreates the container under every other session and
    outlives this one) and the way out (pin it on the project, or run direct).
    Required-not-optional is the point: a future start path that forgets the
    context fails to COMPILE rather than silently skipping the refusal. Also a
    structural **anti-silent-drop guard**: every key accepted by the key loop must
    come back out of `validateProjectPatch`, or the start is refused.
  - `src/server/events.ts` — `SessionOverridable` gains `'claudeAccount'` (it is
    the type `overridden[]`/`effective` are reported under; without it the new
    field could not be reported as overridden). Minimal, and `Overridable` in
    agent-bridge was already the same union.
  - `src/server/index.ts` — ONE line at the single call site: pass
    `{ isolation: project.isolation }`. Edited despite being another lane's file
    because the required parameter makes it a compile error not to; it is far from
    the `/api/claude-accounts` routes step 3 is working in.
  - `src/server/agent-bridge.ts` — comment only: the note saying "NOT (yet) a
    per-session override field, step 5 adds it" was now false.
  - `public/app.js` — `'claudeAccount'` added to `SESSION_OVERRIDABLE`; a new
    **launch-surface account control** beside the provider selector (pill +
    popover, built in JS reusing `.pill.sel`/`.pop`/`.opt` chrome, so no new
    markup or CSS and no collision with another lane's shell work). It shows each
    account's **label, plan + login state, and its OWN remaining 5h window**
    (from step 7's per-account `/api/usage` snapshots) — the "which plan has
    headroom right now" answer at the point of choosing, which is the whole point
    of the feature. Rows: `Project default` (clears the override) / the implicit
    default / each extra account. Shown only when a SECOND account exists, a
    project is selected, nothing is live in view, and the engine is Claude. For a
    **container** project it renders LOCKED with the reason on screen (never
    absent, never offered-then-rejected), and `pickAccount` refuses with the same
    words. It reuses step 7's `claudeAccountView()` rather than re-deriving which
    account is current, and never "clears because you picked the current value" —
    the client cannot see the machine default, so equality with the project's
    stored value is not the same question as equality with what is inherited.
- **Verified — `node scripts/verify-feat-145-session-override.mjs` → 34/34, exit 0**
  (`npm run verify:feat-145-session-override`). Scratch HOME (fake `~/.claude`) +
  scratch `CLAUDE_STATION_DATA`; real observed values throughout:
  - the two mirrors are SET-EQUAL (8 fields each, printed), with a must-FAIL twin
    built from the FIXED pre-step-5 list showing the same assertion reddens on
    real drift;
  - **direct**: an override to account B really runs on B — `CLAUDE_CONFIG_DIR`
    read from `/proc/<pid>/environ` of a real child equals B's overlay dir and is
    NOT A's, while the project's STORED account re-read over HTTP is unchanged
    before and after (A → A);
  - **container**, over the LIVE server's real `/ws` `start` frame: one FATAL
    error frame naming the reason, no session/ack frame, `GET /api/sessions/live`
    empty, and the docker container set byte-identical across the refusal
    (93 before, 93 after, diff `[]`) — nothing created or recreated;
  - a bogus id (5 shapes: unknown hex, non-hex, empty, a number, an object) and a
    DANGLING id (account deleted after arming) all THROW; anchored by a must-FAIL
    twin — a silent-drop implementation synthesized inline returns `{}` normally
    and would pass the weaker assertion "validation returned an object / the
    session starts";
  - omitting the override inherits project → machine correctly, and the default
    account leaves `CLAUDE_CONFIG_DIR` **absent** (not set-to-empty) — including
    the both-ways case: a project pinned to A, overridden back to default, drops
    the var;
  - the merge is driven by the REAL exported `SESSION_OVERRIDE_FIELDS` +
    `applyGlobalDefaults` + `resolveLaunchAccountDir`, and the real
    `agent-bridge.ts` source is asserted to still iterate that constant and to
    resolve the account env from `const s = effective` — so the harness is not
    grading its own model of the bridge.
- **`npm run typecheck` exit 0. `npm run gate` → PASS (leak-gate PASS with the
  pre-existing LICENCE waiver, check-nul PASS, typecheck PASS), exit 0.** The
  leak the step-7 lane reported in `verify-feat-145-session-wiring.mjs` no longer
  reproduces; nothing in this lane's files carries a username or encoded home
  path (`node scripts/leak-gate.mjs --summary`).
- **Could NOT test:** (1) a real logged-in two-subscription turn end to end — the
  /proc reads use a parked stub leaf and stub credentials; a valid direct start is
  deliberately never sent over the live socket because it would launch a real CLI,
  so what is proven is the env the SDK's spawn receives, not a billed turn.
  (2) The new launch control in a REAL browser — the assertions here are on the
  source-level mirror and on server behaviour; the control's functions are exposed
  on the `__app` debug surface (`paintAccountSel`, `paintAcctPop`, `pickAccount`,
  `accountLockedReason`, `setAccountsForTest`) so a browser suite can drive them,
  and a visual pass is worth doing once step 3's "Add account" can mint a second
  real account. (3) The container REFUSAL against a project with a live running
  container — docker was present and its container set was compared, but no
  container existed for the scratch project, so "would have recreated" is proven
  by the refusal happening before any container work, not by observing a
  recreation being avoided.
- **Left unstaged for the user; no git writes performed. INDEX.md not edited.**
- **Symptom of a deeper design flaw?** no — but note the client mirror remains
  hand-maintained. The ARCH-010-shaped fix (the server declares the list and the
  browser READS it, e.g. on `/api/providers`-style boot payload) is cheap and was
  not done here only because it touches another lane's route file; worth filing if
  it drifts again.

### 2026-09-18 — fixing round 1 (step 8 of 8: document the invariant) + one ticket filed in passing

- **Scope:** documentation ONLY. Two files: `docs/CONVENTIONS.md` and one new ticket.
  No product code; `src/`, `public/`, `scripts/` and `INDEX.md` untouched (other lanes live).
- **Built — `docs/CONVENTIONS.md` gains "A Claude account dir is an overlay, not a copy
  (FEAT-145, 2026-09-18)"**, placed after the BUG-117 scratch-server/isolation-knob section
  and written as a decision procedure, not a changelog. Its purpose is stated up front:
  every item in it looks like a bug in isolation, so a reader who "fixes" one splits the
  transcript store, prunes the user's history, or disarms a guard. Eight rules, harvested
  from this ticket's own log: the one-file-differs invariant and its ARCH-010 framing
  (`resolveAccountDir` / `resolveLaunchAccountDir` own the id→dir fact; a stored `dir` is
  recomputed from the id on read); why `settings.json` must stay symlinked
  (`cleanupPeriodDays: 36500` vs a fresh dir's 30, plus the Bash guard hook, the Stop
  response-format gate and `enabledPlugins`) — the data-loss trap dressed as tidiness; why
  `.claude.json` is deliberately not shared (`oauthAccount`, `hasTrustDialogAccepted`), with
  the CLI-2.1.273 finding that a fresh dir hits no onboarding and no trust wall for `-p`, so
  there is nothing to gain; why the CLI's retention sweep skips a symlinked `projects` (it
  `lstat`s and bails unless `isDirectory()`) and must not be "fixed" by chasing the link; why
  `CLAUDE_CONFIG_DIR` must never enter `ENV_PASSTHROUGH` (only the credential file's host
  side crosses; the overlay's links are host paths that dangle inside a container); the
  store-isolation guard **stated as a specification** — a comparison failure may only ARM,
  never disarm — naming both closed false negatives (the dangling-leaf ENOENT and the
  non-ENOENT errno fallback) and saying explicitly that this is why the guard reads link
  TARGETS rather than delegating to `realpathSync`, so nobody simplifies it back; container
  account selection as project-scope-only because `desiredBinds()` is the drift oracle (same
  reason as `mounts`), with a refusal rather than a silent no-op; and `auth status --json`
  exiting 1 while still printing valid JSON (parse `loggedIn`, never the exit code) with
  `email` always `null` for subscription auth, which is why labels are user-supplied.
- **Reconciled rather than stacked** (CONVENTIONS' own maintenance rule): checked the whole
  file for overlap — `CLAUDE_CONFIG_DIR`, `cleanupPeriodDays`, `claude-accounts` and
  `auth status` appear nowhere else in it or in the shared Working Agreement, so nothing
  contradicts. The one genuine adjacency is the BUG-117 section, which owns the *scratch
  isolation* knobs (`CLAUDE_STATION_DATA`, `CLAUDE_PROJECTS_DIR`); that is about test
  isolation, not account identity, so the new section sits beside it without restating it.
  The ARCH-010 worked-examples list was extended with FEAT-145 (one account-id→dir
  authority) pointing at the new section — the only edit made outside the new block.
- **Filed in passing — `BUG-181` — the image-staleness suite fails on its own incomplete copy
  of the tree.** Substance reported by the step-6 container lane above:
  `scripts/verify-bug-107-image-staleness.mjs` scores 5/18 because its harness copies only
  `src/`, while `registry.ts → wiring.ts` imports `scripts/lib/board-path.mjs` from outside
  that copy, so `container-manager` cannot import at all inside the throwaway tree. Written
  for the fixer: symptom, cause, why it is a FALSE RED that will keep reading as a
  container-manager regression to every future lane, and a fix direction (copy the import
  closure rather than one more hardcoded dir; and make a missing-from-copy module report as a
  HARNESS error, distinguishable from a subject failure). States plainly that it is **not**
  caused by FEAT-145 and predates it. Notes the shared shape with BUG-179 (a harness pinning
  a partial tree re-breaks on every new cross-boundary import) without filing an ARCH.
- **Verified:** `npm run gate` → **PASS, exit 0** (leak-gate PASS with only the pre-existing
  LICENSE waiver, check-nul PASS, typecheck PASS) — so neither document carries a username or
  an encoded home path; both describe shapes only, and `node scripts/leak-gate.mjs --summary`
  is where any future hit should be read rather than reproduced in prose.
  `npm run board:check` → **DRIFT, 7 problems**, of which exactly ONE is this lane's and it
  is expected: `MISSING FROM BOARD: BUG-181 has a ticket file but no INDEX.md row`. **The new
  ticket will keep showing as missing until the orchestrator rebuilds the board** —
  `board:gen` was deliberately not run and `INDEX.md` was not edited. The other six pre-date
  this lane and belong to other tickets: five `UNMAPPABLE STATUS` (ARCH-017, BUG-169,
  FEAT-129, FEAT-131, FEAT-132 — free-text Status headers) and one `UNREACHABLE TICKET`
  (ARCH-007).
- **Could NOT test:** (1) nothing in this lane is executable, so there is no suite — the
  documentation rests on this ticket's log, which is its only source; every claim traces to
  an entry above rather than to a fresh measurement. (2) The `cleanupPeriodDays` 30-day
  default for a fresh config dir was taken from the step-6 lane's report and not re-observed
  here. (3) The step-1 CLI-probe findings (`auth status --json` exit code, `email: null`, no
  onboarding or trust wall) reached this lane through its charter rather than through an
  entry in this log — whoever closes step 1 should record them here, since CONVENTIONS now
  cites them as settled fact.
- **Still open / handoff:** steps 3 and 5's remaining work aside, step 0's re-fix and steps
  2/4/6/7 all still want the independent clean-room passes their own entries ask for (ideally
  OpenAI once the quota window resets). Orchestrator: rebuild `INDEX.md` to pick up BUG-181.
- **Left unstaged for the user; no git writes performed. INDEX.md not edited.**
- **Symptom of a deeper design flaw?** no
- **Addendum (same lane):** the `verify:feat-145-session-override` npm-script entry
  could NOT be added — `package.json` was held continuously by another live lane's
  FEAT-129 advisory file lock across four retries over ~4 minutes, and forcing it
  would drop that lane's unsaved work. Run the script by path
  (`node scripts/verify-feat-145-session-override.mjs`) until someone adds the
  one-line entry beside `verify:feat-145-login`.

### 2026-09-18 — fixing round 1 (step 3 of 8: the "Add account" login flow)

- **Scope:** step 3 ONLY — the CLI-driven sign-in for a `state:'pending'` account, its
  WebSocket relay, and the Machine-settings surface that drives it. Did NOT touch
  `src/lib/paths.ts`, `container-manager.ts`, `validate.ts`, `public/app.js`,
  `provider-usage.ts`, `scripts/usage.mts`, `agent-bridge.ts`, `registry.ts` or
  `global-settings.ts` (other lanes live in them).
- **Built:**
  - `src/server/claude-login.ts` — NEW. One login at a time (module-scope lock), for a
    `pending` account only. Spawns `claude auth login --claudeai` on PLAIN PIPES with
    `CLAUDE_CONFIG_DIR` = the account overlay, `BROWSER=/usr/bin/true`, and
    `DISPLAY`/`WAYLAND_DISPLAY` STRIPPED — the server must never pop a browser on its own
    desktop, since the user may be driving Orchard from another machine. `detached: true`
    so the child LEADS ITS OWN PROCESS GROUP; cancel/timeout/socket-close all kill by
    GROUP (`process.kill(-pid, …)`, SIGTERM then SIGKILL) and then delete the pending
    account, so an abandoned attempt leaves neither a stray process nor a half-made row.
    The authorize URL is scraped GENERICALLY (`/oauth/authorize?` in the path, never a
    hardcoded host — the real host is `claude.com/cai/…`, not `claude.ai/oauth/…`) and
    from COMPLETE LINES, so a URL split across two reads is not emitted truncated.
    Unrecognised output degrades to a `urlFound:false` status carrying the RAW output —
    once immediately at the paste prompt, and once on a grace timer for a CLI that prints
    nothing recognisable — so a CLI change reads as "no URL found, here it is" and never
    as a hang. ARCH-010: on child exit the verdict comes from `claude auth status --json`
    (`loggedIn` field), never from the exit code, in BOTH directions.
  - `src/server/claude-accounts.ts` — `markAccountReady(id, health)`: the one writer of
    `state:'ready'` + `lastStatus`, and it REFUSES a health that does not say
    `loggedIn:true`. Nothing else may flip the state.
  - `src/server/index.ts` — three WS commands (`claude-login-start` / `-code` / `-cancel`)
    handled ahead of the session switch on the EXISTING socket (no second transport), plus
    `ws.on('close')` cancelling a login this socket owns.
  - `public/lib/api.js` — `wsUrl()`; `public/lib/drawer.js` — the account list (label,
    signed-in state, plan), an explicit delete confirm NAMING the account and saying that
    the credential goes with it, "+ Add account" → label form → live sign-in panel: the
    authorize URL as a real link AND as a selectable/copyable field (the user may be on
    another machine), a paste-the-code field, live CLI output, and a cancel that really
    stops the CLI. `public/styles.css` — one small block reusing the drawer's existing
    tokens (the CLI-output well is the only new element).
  - `package.json` — `verify:feat-145-login`.
- **The pasted code never leaves the process:** written to the child's stdin, kept ONLY as
  a redaction secret, never logged, never echoed into an event, never persisted; anything
  the CLI echoes back is redacted on the way out.
- **Verified — `node scripts/verify-feat-145-login-flow.mjs` → exit 0, 54/54**, every check
  printing its observed value, on a scratch `HOME` (fake `~/.claude` with a canary) +
  scratch `CLAUDE_STATION_DATA`. NO REAL OAUTH: `scripts/fixtures/feat-145/claude-stub.mjs`
  replays the RECORDED REAL output of claude 2.1.273 (a real login needs a human at a
  browser and would spend a real subscription). Proves: the URL scraped byte-identically
  from the recorded output and from a URL SPLIT across two reads; `BROWSER=/usr/bin/true`
  with `DISPLAY`/`WAYLAND_DISPLAY` absent in the child while the parent had both set;
  `pid === pgid` read from `/proc/self/stat` (the group kill is possible by construction);
  cancel leaves BOTH the CLI and a grandchild it spawned dead, with no dir and no row —
  anchored by a **must-FAIL twin** in which a naive single-PID kill IS observed leaving the
  grandchild orphaned and running; exit 0 + logged out does NOT flip the state, exit 3 +
  genuinely logged in DOES; `markAccountReady` refuses a `loggedIn:false` health; the
  exit-code trap (exit 1 with valid JSON) parsed correctly; the timeout killing the group
  and removing the account; a second concurrent login refused 409; `'default'` refused 400,
  an already-`ready` account 409, an unknown id 404; and the code absent from every emitted
  event and every file under the data dir while the stub PROVES it was delivered.
  §11 runs the whole flow again over a LIVE server's WebSocket, including a socket dropped
  mid-login removing the half-made account.
- **Real-browser pass (brave --headless=new over CDP, scratch server + stub):** the whole
  journey — account list → "+ Add account" → label → sign-in panel with the link → paste
  code → "Signed in … on the max plan" and the list refreshing — with **zero page errors**,
  in dark AND light. It found two real defects, both fixed: the default row's value cell
  wrapped one letter per line (that column is a narrow mono slot; the default now carries
  no value cell, which is also the honest choice since nothing probes `~/.claude`'s plan),
  and the code field's placeholder was truncated mid-word at the drawer's real width.
- **`npm run typecheck` exit 0; `npm run gate` PASS (exit 0).** Anti-regression:
  `verify-feat-145-accounts-registry` 23/23, `verify-feat-145-session-wiring` 21/21.
- **Could NOT test:** (1) a REAL OAuth round trip against claude.com — deliberately, per
  the charter; what is proven is the relay, the scrape, the teardown and the status read
  against recorded real output. (2) The `Copy` button's clipboard write — `navigator.clipboard`
  needs a permission grant headless; the fallback (select the field) is what a denial takes.
  (3) A CLI that requires a TTY — step 1 measured that it does not, and this build depends
  on that measurement rather than re-proving it.
- **Handoff — two coordination notes:**
  - The four `claude-login-*` server→client events and the three client commands are typed
    STRUCTURALLY in `index.ts` rather than as `StationEvent` / `ClientCommand` members,
    because `src/server/events.ts` was held continuously by another live lane's FEAT-129
    advisory file lock. Fold them into those unions when that file is free; nothing else
    changes.
  - Re-login of an existing account is deliberately refused: delete and re-add. If that
    proves annoying in use, the smallest change is a `state:'pending'` reset on the row.
- **Left unstaged for the user; no git writes performed. INDEX.md not edited.**
- **Symptom of a deeper design flaw?** no

### 2026-09-18 — verifying round 1 (steps 4 + 5: global default + per-session account override)

- **Verdict: HOLDS (VALID, manifest-backed).** An independent clean-room pass was
  commissioned via `scripts/independent-verify.mjs --working-tree --max-diff-bytes 0`
  over a HAND-SUPPLIED surface: because roughly six unrelated lanes are dirty in this
  tree (1.6 MB of working-tree diff), the harness diff field was emptied on purpose and
  the requirement carried a hunk-filtered diff of only the in-scope files
  (`global-settings.ts`, `registry.ts`, `validate.ts`, `events.ts`, `agent-bridge.ts`,
  `index.ts`, `public/app.js`, `public/lib/drawer.js`, plus the `resolveAccountDir` /
  `resolveLaunchAccountDir` excerpt of the new `claude-accounts.ts`), with every other
  lane named and marked out of scope. `docs/prompts` and `docs/bugs` were stripped from
  the room, so the verifier saw none of this ticket's prose, rationale or self-assessment
  — only the requirement, that diff, the run commands, and the two author suites' CODE.
- **Provider caveat — SAME-PROVIDER, therefore WEAKER.** Cross-provider (OpenAI) was
  attempted FIRST and died exactly as the step-0 entry predicted: `dispatch failed
  [quota-window] (provider openai)` — usage limit, retry after 2026-09-19 13:37 — even
  though `dispatch-client --check` reported openai available. Fell back to an anthropic
  clean-room verifier per the standing rule. Authors were Claude, so decorrelation is
  reduced: a same-provider verifier more easily SHARES a missed break. A HOLDS from it is
  weaker evidence than a HOLDS from OpenAI would be. Re-running once the quota window
  resets is worthwhile before steps 4+5 are called VERIFIED.
- **Verified-by:** dispatch anthropic run `661f619e-d768-4b33-a008-6f18b61be8d1`
  (clean-room, `scripts/independent-verify.mjs`) — VERDICT: HOLDS. 5 recorded runs.
- **FIXER-TEST re-runs (both author suites, inside the clean room):**
  - `node scripts/verify-feat-145-session-wiring.mjs` → **exit 0, 21/21**
    (manifest `67fb2e4e509b`; an identical earlier run `0f66509b636c` also exit 0). The
    ticket's flagged single-most-likely silent break is GREEN on real observed values:
    under a real `claude-station-host-t-*.scope`, the survived child's
    `/proc/<pid>/environ` carries `CLAUDE_CONFIG_DIR` equal to the overlay dir — the
    `survival.ts → systemd-run --scope → session-host.mjs` hop DOES carry it. The default
    account's child environ shows the var `<absent>`, not empty.
  - `node scripts/verify-feat-145-session-override.mjs` → **exit 1 in the clean room, for
    an ENVIRONMENT reason, not a feature defect** (manifest `c645dfb4a988`). Sections 1-3
    ran and were fully green there (mirror set-equality + its must-FAIL twin; the
    'default' sentinel keeping the KEY present; all five bogus shapes and the dangling id
    throwing; the silent-drop must-FAIL twin; the container refusal and its scoping). The
    suite then aborted at §4 with `server never became healthy`, because
    `seedTemplates` now reads `docs/prompts/WORKING_AGREEMENT.v3.md` (and `.v4.md`) while
    `independent-verify.mjs`'s `BOOT_STUBS` list still seeds only the older six — so the
    stripped clean room cannot boot the server at all. **This is a HARNESS defect that
    silently costs every future clean-room verification in this repo its live-server
    evidence; it is not caused by FEAT-145 and deserves its own ticket.** Nothing was
    fixed here (verify lane, no source edits).
  - **Harness-side control (labelled as such — NOT independent):** the same suite re-run
    in the real working tree by the verification harness → **exit 0, 34/34**, including
    the §4 live-server `/ws` container refusal and the §5 `/proc` reads. That is what
    distinguishes "the clean room could not boot a server" from "the suite fails".
- **The adversarial cases the author fixtures do not cover — both green:**
  - `node scripts/adv-feat145.mjs` → exit 0 (manifest `d93e56688ca8`). Three attacks the
    fixtures never build. (1) **Container leakage**: a CONTAINER project pinned at
    PROJECT scope to a non-default account — the bridge really does resolve a non-null
    `CLAUDE_CONFIG_DIR` for it, and the docker-exec argv built by the real `execArgv()`
    does NOT forward it, while the same allow-list DOES forward `ORCHARD_SESSION`, so the
    filter is shown non-vacuous. (2) **A PROJECT pinned to a since-DELETED account**:
    `applyGlobalDefaults` deliberately does not reconcile a non-null project value, so
    the dangling id reaches the launch gate — where `resolveLaunchAccountDir` THROWS,
    naming the account and refusing, rather than returning null and spending the default
    plan. (3) **A machine default that is a PENDING (not-logged-in) account, inherited by
    a project**: it survives `normalise()` (it exists) and then throws at launch. All
    three are the "silently spend the wrong subscription" class and all three fail loudly.
  - `node scripts/adv2-feat145.mjs` → exit 0 (manifest `0c1ecf89299f`). The container
    refusal is **order-independent** (`{model, claudeAccount}`, account not first) and
    returns NO partial override set; it still fires when bundled with three valid keys;
    fatal-on-unknown still holds for a container (`bogusKey` throws, listing all eight
    allowed fields); all 8 override fields survive `validateProjectPatch` on a direct
    project, so the anti-silent-drop guard never folds a legitimate field; and
    `SESSION_OVERRIDABLE` (app.js) === `SESSION_OVERRIDE_FIELDS` (validate.ts), both
    lists printed, both containing `claudeAccount`.
- **Could NOT test (the verifier's own list, plus the harness's):**
  1. The live-server §4 of the override suite **inside the clean room** — the boot-stub
     gap above. Covered only by the harness-side control run, which is not independent.
  2. The real "add account" OAuth login flow and any real billed `claude` turn —
     explicitly forbidden; readiness and credential state were simulated exactly as the
     author suites do, so what is proven is the env the spawn receives, never a turn that
     actually billed a second subscription.
  3. The browser UI — `public/app.js`'s launch-surface account control (its container
     LOCK message, the per-account 5h-window rendering) and `public/lib/drawer.js`'s
     Machine-settings control were never driven through a real DOM; only the server-side
     dialect and env wiring they feed were exercised. The step-5 lane's own could-not-test
     list says the same; it remains open.
  4. The reattach / fork / resume frames as a SEPARATE bypass path for the container
     refusal — the adversarial work attacked `validateSessionOverrides` directly and over
     the primary `start` frame, but no frame was sent down the pure-reattach path at
     `public/app.js`, so "a reattach frame cannot smuggle `overrides.claudeAccount` past
     the isolation context" is asserted by code shape, not by execution.
  5. A project whose `isolation` CHANGES between validation and start (the TOCTOU form of
     the container bypass) — not exercised.
  6. Cross-provider decorrelation — see the provider caveat; this verdict is
     same-provider.
- **Safety, as run:** every suite and both adversarial scripts used a scratch `HOME`
  (a fake real store) and a scratch `CLAUDE_STATION_DATA`; the CLI leaf was stubbed and no
  login was ever attempted. The real store was confirmed unchanged by comparing, before
  and after, the size + mtime + sha256 of `.credentials.json` (identical) and of
  `settings.json` (identical), and the `projects/` entry count. The count rose by exactly
  one, and the new entry is the clean room's OWN transcript directory — i.e. the
  verifier's `claude -p` session writing its own history, which is inherent to dispatching
  at all, not a test touching the real store. No `claude-station-host-t-*` scopes were
  left behind.
- **No git writes performed. No source file modified. `INDEX.md` not edited.
  `package.json` not touched (held by another lane's lock).**
- **Symptom of a deeper design flaw?** Not in FEAT-145. But the boot-stub staleness is one:
  `independent-verify.mjs` hard-codes a copy of `seedTemplates`'s seed list, which is the
  ARCH-010 shape this project keeps paying for — a fact owned by `templates.ts` and
  re-derived by a second reader that can hold a different answer. It failed silently as
  `server never became healthy`, which reads as a product defect. Worth a ticket.

### 2026-09-18 — fixing round 2 (closing five deferred items: the registry writer lock, the typed login surface, the verify aliases, the step-1 probe facts, the Status header)

- **Scope:** the deferred tail of FEAT-145, not a build step. Five items, done in order with
  `npm run gate` re-run after each. Files touched: `src/server/claude-accounts.ts`,
  `src/server/events.ts`, `src/server/claude-login.ts`, `src/server/index.ts`,
  `scripts/verify-feat-145-accounts-registry.mjs`, `package.json`, and this ticket.
  No other lane's in-flight file was edited.

#### 1. A writer lock on the accounts registry — the one real defect (CLOSED)

- **The residual, confirmed as filed.** The step-2 clean-room round's could-not-test #1:
  `createAccount` does read → mint → materialise → `writeAccounts` with **no writer
  arbitration**. `writeAtomic` makes each WRITE atomic — which is exactly why a *reader*
  never sees a spliced file, and exactly why this looked safe — but it does nothing about
  two writers that both read the same `rows` and then each write their own whole file: the
  second write wins and the first writer's row is gone. Node being single-threaded does not
  save it either; every mutation here is synchronous, so the hazard is between PROCESSES
  (two servers on one data dir), which is what the proof below actually runs.
- **The window is real, not theoretical:** `materialiseAccountDir` does genuine fs work
  (mkdir + two `lstat`s + two `symlink`s + two `existsSync`es) between the read and the write.
- **Built — `withRegistryLock` in `src/server/claude-accounts.ts`, REUSING FEAT-129.** It
  imports `reclaimReason` + `FILE_LOCK_TTL_MS` from `scripts/lib/file-lock.mjs` (the same
  module and the same two symbols the FEAT-144 transcript mirror imports) and follows
  `withMirrorLock` in `src/server/orchard-transcripts.ts` **as its idiom, deliberately**:
  atomic link-create of the lockfile (temp + `linkSync`, so a racer never observes it empty),
  FEAT-129's own staleness authority (dead owner via `pidAlive`, then the shared TTL
  backstop), and a race-safe rename-aside reclaim where exactly one contender wins.
  - **Why not `evaluateFileLock`.** Structurally it cannot express this: it is
    claim-until-heartbeat with **no release export at all**, so a claim here would hold the
    registry for the full TTL after a 2 ms critical section. What this needs is a bounded
    section — acquire, run the synchronous body, release in `finally`. That is precisely the
    difference `withMirrorLock`'s own docstring already names, which is why this is the
    established in-repo idiom rather than a second locking mechanism. Nothing was hand-rolled
    that FEAT-129 already owns: staleness, liveness and the reclaim race are all its code.
  - **Where it diverges from the mirror lock, and why.** The mirror fails toward SKIP (its
    work is idempotent, so letting the other pass do it loses nothing). A registry mutation is
    NOT idempotent — a silently skipped create would report success and store nothing. So this
    fails toward a LOUD refusal: `AccountError` 503, which the existing route already turns
    into an honest HTTP answer. Patience is ~5 s (200 × 25 ms, `Atomics.wait`, not a spin).
- **Every mutating path is covered:** `createAccount` (the whole read→mint→materialise→write,
  with label validation left OUTSIDE so a bad label is refused whether or not anyone else is
  writing), `deleteAccount` (existence check + dir removal + rewrite as ONE section), and
  `markAccountReady`'s `state`/`lastStatus` flip.
- **Reads are deliberately NOT locked** and still degrade exactly as before: `readAccounts()`
  keeps its tolerant parse, takes no lock, and cannot block a session launch. `writeAtomic`
  already guarantees a reader sees the old or the new file, never a splice. The lock
  arbitrates writers against each other and nothing else — asserted, not asserted-by-comment
  (§9e below times a read taken while the lock is HELD).
- **Verified — `npm run verify:feat-145-accounts-registry` → exit 0, 36/36** (was 23/23; all
  23 originals still pass). New §9 spawns REAL concurrent processes — each child loads its
  modules and then busy-waits to a COMMON START INSTANT so all N land in the same millisecond
  — and prints observed row counts, never bare PASS/FAIL:
  - **must-FAIL twin, genuinely red:** 8 concurrent creates through a SYNTHESIZED PRE-LOCK
    implementation (written inline in the script, so the proof is anchored to a fixed baseline
    and survives this landing, per CONVENTIONS) → **8 minted, 1 survived in the file, 7 LOST**,
    and each of the 7 left an **orphan overlay dir no row names** — the user-visible damage.
  - **must-PASS:** the same 8 creates through the shipped code → **8 minted, 8 survived, 0
    lost**, no refusals, no crashes, unique well-formed ids, no duplicates.
  - **a create racing a delete** leaves a coherent file: it still parses, the created row is
    present AND the deleted row is gone. The twin of that race is also shown red — the
    pre-lock delete's stale read resurrects the victim (`twin-victim` survives alongside the
    racing create, where exactly one row should remain).
  - §9e: a **read** while the lock is held returns in **1 ms** with the right rows; a **write**
    meeting a LIVE foreign lock returns **503** and changes nothing on disk; a lock held by a
    **provably dead pid** is reclaimed immediately rather than waited out (FEAT-129's
    `reclaimReason`, exercised through the live HTTP route).
  - §8 still shows the fake `~/.claude` byte-identical across the whole run.

#### 2. The login events folded into the typed surface (DONE — typing only, no behaviour change)

- The four `claude-login-*` server→client events are now `StationEvent` members and the three
  client commands are `ClientCommand` members, in `src/server/events.ts`, with the rationale
  comments moved there from `index.ts`.
- `src/server/claude-login.ts`'s `LoginEvent` is no longer a parallel union: it is
  ``ClaudeLoginEvent = Extract<StationEvent, { t: `claude-login-${string}` }>``, so the wire
  shape is declared in ONE place (ARCH-010) and the login module cannot drift from the socket
  handler. `ClaudeLoginCommand` is the same projection over `ClientCommand`.
- `index.ts`'s `handleLoginCommand` takes `ClientCommand` and is a type predicate
  (`c is ClaudeLoginCommand`) instead of a structural `{ type: string; accountId?: unknown }`.
  The runtime `typeof` checks were KEPT: the union describes the wire contract, and the bytes
  arriving are untrusted JSON merely cast to it. The ws switch's `default:` is a soft
  "unknown command", not a `never` exhaustiveness check, so the three new members needed no
  case arm.
- **Proof: `npm run typecheck` exit 0**, and `node scripts/verify-feat-145-login-flow.mjs` →
  **exit 0, 54/54** (unchanged), which is what shows the move carried no behaviour.

#### 3. `package.json` verify aliases (DONE — the lock had been released)

- Added beside `verify:feat-145-login`, matching its naming exactly:
  `verify:feat-145-accounts-registry`, `verify:feat-145-session-wiring`,
  `verify:feat-145-session-override`, `verify:feat-145-container-account`,
  `verify:feat-multi-account-store-guard`. (`verify:feat-145-usage` and
  `verify:feat-145-login` already existed.) The FEAT-129 lock that blocked two earlier lanes
  was no longer held; nothing was forced. Spot-checked through the aliases:
  `npm run verify:feat-multi-account-store-guard` → **47/47**,
  `npm run verify:feat-145-accounts-registry` → **36/36**.

#### 4. The step-1 CLI-probe facts, recorded here at last (measured against CLI **2.1.273**, 2026-09-18)

`docs/CONVENTIONS.md` cites these as settled, but they reached the docs lane through a charter
and were never written into this ticket, so the ticket did not carry its own evidence. For the
record — these are the measurements step 1 made, and they are what decided that the
`CLAUDE_CODE_OAUTH_TOKEN` fallback is NOT needed:

- **`CLAUDE_CONFIG_DIR` relocates the ENTIRE store** — `projects/`, `settings.json`,
  `.claude.json`, `sessions/`, `backups/`, `history.jsonl`, `todos`, `statsig`, `plugins/`,
  `skills/`. That is what makes a one-file-differs overlay possible at all.
- **A fresh config dir hits no onboarding wall and no trust-dialog wall** for `-p` sessions.
  It fails only on credentials: `Not logged in · Please run /login`, exit 1. This is why
  `.claude.json` can be left unshared with nothing to lose.
- **`claude auth login --claudeai` runs on plain pipes, no TTY.** It prints
  `Opening browser to sign in…`, then a scrapeable authorize URL, then blocks on stdin at
  `Paste code here if prompted > `. The whole step-3 relay depends on this measurement.
- **The authorize URL host is `claude.com/cai/oauth/authorize`**, not
  `claude.ai/oauth/authorize` — which is why step 3 scrapes `/oauth/authorize?` generically
  and never by host.
- **`claude auth status --json` exits 1 when logged out while still printing valid JSON.**
  Parse `loggedIn`; never branch on the exit code. `email` is always `null` for subscription
  auth, which is why account labels are user-supplied rather than read from the CLI.
- **The overlay shape was proven end to end:** a dir with `projects`, `settings.json` and
  `.credentials.json` symlinked into `~/.claude` ran `claude -p` to a real model reply, with
  the transcript landing in the real store.

#### 5. Status header

- Set to **IN VERIFICATION** — a state word `board:check` recognises (`work_state:
  in_verification`, `verification_state: pending`), which is the honest reading of "all 8
  steps built, verification partially outstanding". Deliberately not VERIFIED, and not FIXED:
  independent rounds HOLD for steps 2/4/5 but step 0 was BROKEN-then-re-fixed and wants a
  re-run, the credential-path round is still in flight, and every HOLDS so far is
  same-provider. `npm run board:check` → **DRIFT, 5 problems, none of them FEAT-145** (five
  pre-existing `UNMAPPABLE STATUS` / `UNREACHABLE TICKET` on BUG-169, FEAT-129, FEAT-131,
  FEAT-132, ARCH-007). No sixth was added. `INDEX.md` NOT edited.

- **`npm run typecheck` exit 0. `npm run gate` → PASS, exit 0** (leak-gate PASS with only the
  pre-existing LICENSE waiver, check-nul PASS, typecheck PASS) — re-run after each of the five
  items, so any breakage would have been attributable. Leak hygiene: no real username and no
  encoded home path was written into any fixture, script or log this lane produced; every
  observed path printed by the new §9 is a scratch path under the run's own temp dir. Read any
  future hit with `node scripts/leak-gate.mjs --summary` rather than reproducing it here.
- **Could NOT test:** (1) a genuine same-millisecond interleave *inside one process* — there
  is none to have, because every registry mutation is synchronous; the lost update is a
  cross-PROCESS hazard and that is what §9 exercises with real spawned children. (2) Two REAL
  Claude subscriptions — unchanged from every earlier lane; no second credential exists on
  this machine. (3) The lock under a genuinely crashed writer that died *mid-critical-section*
  (holding the lockfile with the registry half-rewritten) — the dead-owner reclaim is proven
  with a synthesised dead-pid lockfile, and `writeAtomic` means a half-written registry cannot
  exist, but a real mid-section crash was not staged. (4) The browser UI for the login panel
  under the newly-typed events — this was a types-only move and the 54/54 suite covers the
  server relay, but no fresh DOM pass was run.
- **Left unstaged for the user; no git writes performed. `INDEX.md` not edited.**
- **Symptom of a deeper design flaw?** Not for the feature — but the registry gap is a
  recognisable class: `writeAtomic` makes each write atomic and therefore *looks* like it
  makes the sequence safe, which is how a read-modify-write on a shared file ships unguarded.
  Two other modules in this repo already own the answer (`withMirrorLock`, and FEAT-129
  itself); a third instance would be worth an ARCH rather than a third copy.

### 2026-09-18 — steps 6 + 7: INDEPENDENT CLEAN-ROOM VERIFICATION — VERDICT: **HOLDS** (verifying, round 1, class=verify)

- **Verified-by:** dispatch anthropic run `fdb40678-ee14-41bc-8a56-9360132afec2` (clean-room,
  `scripts/independent-verify.mjs`) — VERDICT: **HOLDS**, contract **VALID**, manifest-backed
  (5 recorded runs). Verdict text at
  `~/.local/state/claude-station/scratch/feat145-verify-4tjDW4/verdict-anthropic.txt`;
  run manifest + full per-run output at
  `~/.local/state/claude-station/scratch/cleanroom-record-5ZsvxI/`.
- **Provider caveat — the verdict is SAME-PROVIDER and therefore weaker.** OpenAI was tried
  first and the dispatch died on `quota-window` ("usage limit … try again at Sep 19th 1:37 PM")
  even though `dispatch-client --check` reported openai available; that attempt produced
  `INVALID — the verification dispatch itself failed` and was not counted. The run above is
  anthropic verifying anthropic authors, so blind-spot decorrelation is reduced to the
  clean-room/context axis only. Re-running cross-provider after the OpenAI window reopens
  would strengthen it.
- **Surface under test, named explicitly** (a dozen unrelated lanes are dirty in this tree, so
  the harness ran `--working-tree --max-diff-bytes 0` and hand-supplied the surface): the
  working-tree snapshot `HEAD dc1f4ea0 → tree 2c75a45e`, with the diff restricted to
  `src/server/container-manager.ts`, `src/server/provider-usage.ts`, `scripts/usage.mts`,
  `public/app.js` (usage region only), plus the new `scripts/lib/usage-history.mjs` supplied
  whole. Everything else in the tree was marked out of scope; `src/server/claude-accounts.ts`
  was supplied as read-only dependency context (step 2, already verified).
- **(i) Both author suites RE-RUN inside the clean room, through the harness recorder:**
  - `node scripts/verify-feat-145-container-account.mjs` → run `012389aea165`, **exit 0,
    29 PASS / 0 FAIL**, against REAL Docker (server 29.6.2) inside the clean room — including
    §3's live container turns, the `docker inspect` bind + inode checks, the
    recreate-exactly-once sequence and the `Not logged in · Please run /login` failure on an
    invalid credential.
  - `node scripts/verify-feat-145-usage.mjs` → run `fc2afcd53467`, **exit 0, 59/59**,
    including the byte-identical single-account tooltip (sha `39f49b2e312121b5` both sides),
    the `.find(s => s.provider === 'anthropic')` → default-account resolution, and the
    strict-superset `/api/usage` payload.
- **(ii) Two adversarial cases the authors' fixtures do not cover**, both written fresh in the
  clean room and run through the recorder (copies kept beside the record dir as
  `adv-recreate-loop.mjs` / `adv-burn-history.mjs`):
  - **`recreate-loop-implicit-vs-explicit-default`** (run `4ecef24914ed`, exit 0) — the
    highest-value attack on the list. The author suite calls `desiredBinds` on `project(null)`
    and on distinct named accounts once each; it never compares the IMPLICIT default against a
    project storing the literal `'default'` sentinel, and never repeats the call to prove the
    sorted drift-oracle list survives the `materialiseAccountDir` / `resolveLaunchAccountDir`
    side effects each call triggers. Result: **no recreate loop.** Implicit and explicit
    `'default'` produce identical bind lists; 25 repeated calls yield **1 distinct list** for
    both the default and a named account; the bound credential **inode is stable across all 25
    repair-triggering calls** (no `staleFileBinds` drift); machine-inherited matches an
    explicit pin exactly; clearing the machine default returns to the default list.
  - **`burn-history-keep-per-key-and-forgery`** (run `4f4d37a4d243`, exit 0) — the append-only
    user-data attack. With **six** distinct account keys each writing 12 rows, `KEEP=8` stayed
    strictly **per key** (6 × 8 = 48 rows, no global eviction, no neighbour eviction);
    `priorFor` never returned another key's row; the bare-`anthropic` default series survived
    alongside five extra accounts; and every forge/collision id tried (empty, `' '`, `':'`,
    embedded NUL, embedded newline, the literal `'anthropic'`, `'default'`/`'DEFAULT'`, a
    200-char value) is rejected by the registry's 8–64-hex `ID_RE` at read time, so **no
    ID_RE-valid id can ever map to the bare default key**.
- **Residual worth recording (a finding, not a break).** The verifier's FIRST cut of that
  second case (run `d1b6dcf3cf1a`, **exit 1**) reddened on exactly one line: `histKey('')`
  returns the bare `'anthropic'` key, i.e. the `!accountId → 'anthropic'` collapse is
  reachable by an empty-string account id. It was reclassified as UNREACHABLE — and the rerun
  proves it — only because the registry reader drops every non-`ID_RE` id before a snapshot is
  built. So the default-key guard lives in `claude-accounts.ts`'s validation, **not** in
  `usage-history.mjs` itself. If any future caller ever constructs a snapshot without going
  through the registry reader, an empty/absent `accountId` silently pollutes the default
  account's real series. Cheap hardening if anyone touches that file: make `histKey` demand a
  positive `'default'` sentinel rather than treating every falsy value as the default.
- **Could NOT test (verifier's own list, verbatim in substance):** (1) the live Anthropic OAuth
  endpoint — stubbed via `CLAUDE_STATION_USAGE_URL` per the safety rules and never contacted,
  so real 401/timeout wire behaviour is assumed from the stub; (2) a genuine SECOND paying
  subscription authenticating live inside a container — the live-auth proof uses an account dir
  whose credential is a symlink to the default one, so what is proven is *which file the
  containerised CLI uses*, not two plans billing separately; (3) concurrent registry
  writer-lock races (create racing delete); (4) the real browser DOM rendering of the app.js
  badge beyond the author's function-extraction harness. **Harness adds:** (5) cross-provider
  decorrelation (see the provider caveat above); (6) `GET /api/usage` over real HTTP with two
  accounts registered — still in-process only.
- **Safety, and how it was confirmed.** Scratch `CLAUDE_STATION_DATA` throughout; the live
  Anthropic endpoint was never contacted; no real quota spent beyond the verifier dispatch
  itself. Confirmed AFTER the run, against a snapshot taken before it: the real
  `usage-burn-history.jsonl` is byte-identical (same sha256, 32 lines) and the real
  `.credentials.json` is unchanged (same sha256 prefix and mtime); the top-level listings of
  the real Claude config dir and the station data dir are identical; `docker ps -a` is back to
  **93** containers and `docker images` to **67**, both diffing clean against the pre-run
  lists, with no `feat145*`/`adv-ctr*` container, image, `/tmp` scratch dir or
  `projects/-workspace-feat145v-*` transcript dir left behind; and the step 6/7 diff is
  byte-identical before and after (sha256 `c2ac9fca14c092a7…`), so the verifier modified
  nothing in the real repo. No git write command was run; `INDEX.md` not edited; the clean-room
  working copy was removed and only the record dir (manifest + `<id>.out`) kept.
- **Leak hygiene:** the raw verdict text contains real absolute home paths in its recorded
  output, which is why it is CITED by path above rather than pasted here; every path in this
  entry is `~`-relative.

### 2026-09-18 — fixing round 1 (residual from steps 6+7: `histKey` treated every falsy id as the default)
- **Understood:** the residual recorded above was a guard living in the wrong file. `histKey`
  read `if (!accountId || accountId === 'default')`, so `''`, `undefined`, `null`, `0` and
  `false` all keyed the DEFAULT account's series — and the only thing making that unreachable
  was the registry's hex `ID_RE` dropping such ids upstream in `claude-accounts.ts`. That is
  the ARCH-010 shape in miniature: the file that DEPENDS on the fact does not state it, and
  `usage-burn-history.jsonl` is append-only user data whose burn rate is computed from it, so a
  mis-keyed row does not error — it fabricates a rate.
- **Changed:** `scripts/lib/usage-history.mjs` — `histKey` now claims the default BY NAME
  (the explicit `'default'` sentinel, exported as `DEFAULT_ACCOUNT_ID`) and throws a named,
  explanatory error for anything that is neither the sentinel nor a non-blank id.
  `histKeyForSnapshot` passes the snapshot's `accountId` straight through (the `?? null` is
  gone) so this reader is no longer a second place deciding what an absent id means — every
  anthropic target and every `unknown()` degrade in `provider-usage.ts` already carries
  `DEFAULT_ACCOUNT_ID`. **On-disk keying is untouched:** default stays the bare `anthropic`,
  extra accounts stay `anthropic:<id>`. This is a guard, not a re-keying.
  `scripts/verify-feat-145-usage.mjs` grew section A7 (8 checks); one pre-existing `[A2]`
  assertion that `histKey('anthropic', null) === 'anthropic'` was updated, since it asserted
  exactly the behaviour this fix removes.
- **Verified:** `node scripts/verify-feat-145-usage.mjs` → **67/67 passed** (was 59/59).
  New evidence: all five falsy ids rejected; the MUST-FAIL twin re-implements the pre-fix
  falsy-default rule INLINE (a fixed anchor, not `git show`) and shows it folds all five into
  the bare `anthropic` key; the rejection message names the offending value and the reason;
  a whitespace-only id is rejected; the `'default'` sentinel still yields the bare key;
  `openai` is untouched. Against a scratch COPY of the real history file: every surviving
  pre-existing `anthropic` row is byte-identical after a sentinel-keyed run
  (sha `79ce51729ba7bf2d` before and after, 16 rows → 15 retained + 1 appended; the single
  removed row is the oldest of the `weekly` bucket, i.e. documented `KEEP=8` pruning), and
  `priorFor()` still matches the default account's prior 5h row (`used=21%`, same `resetsAt`)
  — no silent burn-rate reset. Whole FEAT-145 set re-run green: accounts-registry 36/36,
  login 54/54, multi-account-store-guard 47/47, session-wiring 21/21, session-override 34/34,
  container-account 29 PASS / 0 FAIL, usage 67/67. `npm run typecheck` 0 errors;
  `npm run gate` PASS (leak-gate 0 hits, check-nul, typecheck).
- **Still open / handoff:** independent verification of this residual has not been run — this
  is a fixing-phase entry. The real `usage-burn-history.jsonl` was only ever READ (the suite
  copies it to scratch before any mutation).
- **Symptom of a deeper design flaw?** Yes, and a named one: ARCH-010 (a fact a reader must
  act on, not stated where the reader depends on it). No new ARCH ticket — it is an instance,
  and BUG-182 in this same batch is the other one.

### 2026-09-19 — fixing round 2 (doc correction: `email` is not always `null`)

- **Corrects the step-1 probe entry above ("The step-1 CLI-probe facts") without rewriting
  it** — that entry recorded honestly what it observed on the one account it happened to
  check, and stays as-is; this entry supersedes its `email` conclusion going forward.
- **What was measured:** a read-only `claude auth status --json` probe against CLI **2.1.273**
  on two real, distinct accounts on this machine — different from the account the original
  step-1 probe checked. Both returned a **populated `email`** address, plus a real `orgId` and
  `orgName`; the original probe's `null` result was specific to the account it checked, not a
  universal property of subscription auth. (No real email address, org id, or account id is
  recorded here — see docs/CONVENTIONS leak-hygiene rule.)
- **Changed:** `docs/CONVENTIONS.md`'s `auth status --json` paragraph now states that `email`
  **may or may not be populated** and that nothing may branch on it either way, and restates
  the real reason account labels are user-supplied: a label is the user's own name for a
  subscription, and even a populated email is not a reliable identifier to build the UI
  around. Also corrected the same stale claim in a code comment at
  `public/lib/drawer.js` (`addAccountForm`'s doc comment) — a comment only, no logic changed.
  Grepped `docs/`, `src/`, `scripts/`, `public/` for the claim first; the only other hit was
  `scripts/fixtures/feat-145/claude-stub.mjs:57`, which is fixture data for one simulated
  login scenario (not a factual assertion) and was left alone.
- **No code in `src/` or `public/` branches on `email` being null or non-null** — grepped for
  every `email` reference in those trees; the drawer comment was descriptive prose, not a
  conditional, so nothing needed a behavioural fix.
- **Left unstaged for the user; no git writes performed. INDEX.md not edited.**
- **Symptom of a deeper design flaw?** no
