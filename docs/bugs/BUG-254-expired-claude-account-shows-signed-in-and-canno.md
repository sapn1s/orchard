```orchard-ticket
{
  "id": "BUG-254",
  "type": "bug",
  "title": "Expired Claude account shows signed-in and cannot re-authenticate",
  "summary": "A container project's Claude account fails its sessions with \"not signed in / expired\", yet the drawer still shows that account signed-in and offers only Delete. Deleting and re-adding mints a NEW account id, which breaks every project that pointed at the old one.",
  "impact_if_we_wait": "Sessions keep failing with no honest signal, and the only offered recovery — delete then re-add — hands the account a new id that silently orphans every project bound to the old one.",
  "current_need": "An honest live status, plus an in-place re-login that keeps the same account id and reaches running sessions.",
  "severity": "high",
  "area": "drawer/server",
  "reported": "2026-10-13",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-10-13",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Drawer status distinguishes signed-in, needs-re-login, and unknown; a probe failure never renders as signed-in.",
    "A ready account offers \"Sign in again\" that reuses the login relay on the SAME account dir and keeps the SAME id.",
    "After a successful re-login, running direct and container sessions on that account pick up the new credential at their next turn with no manual restart.",
    "No credential contents are ever printed or logged."
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": "claude-opus-4-8",
      "run_id": "9e06a5b9-5559-42e2-b2d4-c4a57530bec1",
      "verdict": "holds",
      "verdict_on": "2026-10-13",
      "recorded_at": "2026-10-13T08:25:58.632Z",
      "author": "independent clean-room (anthropic Opus)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "HOLDS. Verifier's own suites (60+7 cases): probe failures of every shape never read signed-in; reauth timeout/cancel/error keeps the ready row; applyRelogin closes only matching idle sessions, never default. UNTESTED: real expired token, e2e resume, browser UI (fixer covered UI via Playwright)."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-4-8",
      "run_id": "90182607-1ae7-419a-b09a-008aafc59958",
      "verdict": "broken",
      "verdict_on": "2026-10-13",
      "recorded_at": "2026-10-13T10:42:04.799Z",
      "author": "independent clean-room (anthropic Opus)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "HOLD: heal 10/0, in-place re-login fail/cancel/success 8/0, unknown->not-stale, no cred leak. BROKEN: probe gate authorized -uroot and --privileged=true (priv-esc). Fixed in lifecycle.ts (container must be first token after exec); re-verified 18/0. Fresh independent re-verify warranted."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-4-8",
      "run_id": "e9bb075c-48fe-40f4-9529-f3411afae10f",
      "verdict": "broken",
      "verdict_on": "2026-10-13",
      "recorded_at": "2026-10-13T10:59:09.144Z",
      "author": "independent clean-room (anthropic Opus)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "r5 (openai refused priv-esc framing; anthropic fallback). P1 HOLDS: ~35 privileged exec shapes on REAL sandbox container, 0 authorized (r4 fix held, no 3rd break). P2 HOLDS. BROKEN P3 (NEW): applyCredentialInPlace write-then-ftruncate torn stale-tail. BROKEN P4 (NEW): recreates on unknown probe."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-4-8",
      "run_id": "fa84e17b-ca62-48b2-8fdf-c1b5e9b42c9a",
      "verdict": "holds",
      "verdict_on": "2026-10-13",
      "recorded_at": "2026-10-13T12:03:09.808Z",
      "author": "independent clean-room (anthropic Opus)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "r7 clean-room (openai refused; anthropic fallback). P3=wholesale atomic replace (gate: in-place padded write ~0.012% torn; CLI reloads on mtime only). HOLDS: P4 unknown+stale-heal; replace never torn (400k); failed reauth keeps good cred. UNTESTED(no docker): e2e heal (author 19/0 sandbox), D gate."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-4-8",
      "run_id": "2e54808c-1d3d-4ca1-9cfd-15d7fe6d389e",
      "verdict": "broken",
      "verdict_on": "2026-10-13",
      "recorded_at": "2026-10-13T12:24:30.417Z",
      "author": "independent clean-room (anthropic Opus, sandbox docker)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "r8 WITH sandbox docker (openai quota->anthropic). Fixer heal suite green in-room. BROKEN P2: docker global opts before exec (-H/--host/-D) authorized; -H sends exec to unchecked daemon. BROKEN P3: leasesReady-false window git-mismatch recreate not credReady-gated. Two-break STOP; P1 untested."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-4-8",
      "run_id": "76463b63-8ec8-4dc4-b227-eac96bf114be",
      "verdict": "invalid",
      "verdict_on": "2026-10-13",
      "recorded_at": "2026-10-13T12:56:16.356Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Clean-room anthropic (openai quota->fallback). Substantively GREEN: re-ran author r9 31/0 + container-heal 28/0 (sandbox) + OWN adversarial docker 36/0 (every global-opt spelling refused on probe/op/lease; all P1 shapes) + recon 10/0. INVALID = citation-format (2 FIXER-TEST lines) only, no break."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-4-8",
      "run_id": "99126667-d78f-4918-bb21-72abac96456b",
      "verdict": "holds",
      "verdict_on": "2026-10-13",
      "recorded_at": "2026-10-13T13:12:58.430Z",
      "author": "independent clean-room (anthropic Opus, sandbox docker)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "r10 clean-room (openai quota->anthropic). VALID HOLDS; correct shape (1 FIXER-TEST + 2 ADVERSARIAL, 12 manifest runs). r9 31/0; container-heal 28/0 (authorize refuses every global-opt on probe+op+lease; idle stale->fresh heal); module-p2p3 13/0. UNTESTED: P3b relogin, P3c stop-restart."
    }
  ],
  "verification_class": "plan+review",
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

# BUG-254 — Expired Claude account shows signed-in and cannot re-authenticate

## Symptom
A container project (reported against a private project) uses a named Claude account. Its sessions fail with "not signed in / expired". In the Orchard drawer's accounts section, that account still shows "signed in", and the only action offered is Delete.

## Repro
1. Add a Claude account and sign it in (state flips to `ready`, `lastStatus.loggedIn:true`).
2. Let the OAuth credential expire or revoke it out-of-band.
3. Open the drawer accounts section -> the account still shows "signed in" (defect A -- status is the stored value from login time, never re-probed).
4. Try to sign in again -> `startClaudeLogin` refuses any non-`pending` account (defect B, claude-login.ts:246). Delete + re-add gives a NEW id, breaking projects pointing at the old one.

## Expected
- Status reflects a live probe: signed-in / needs-re-login / unknown. Never "signed in" on a probe failure (fail toward needs-re-login/unknown).
- A ready account can be re-authenticated IN PLACE via the existing login relay against the same account dir, keeping the same id.
- After re-login the replaced `.credentials.json` reaches running sessions (direct and container) at their next idle turn, with no manual restart.

## Context pack (grows -- the "where to look")
- `src/server/claude-accounts.ts` -- `AccountRow.state`/`lastStatus` (stored once by `markAccountReady`), `readAccountHealth` (live probe, currently only called on login exit), `listAccounts`, `resolveLaunchAccountDir`.
- `src/server/claude-login.ts:246` -- refusal of a non-pending account; `:262-266` the relay spawn (CLAUDE_CONFIG_DIR=<dir> claude auth login --claudeai).
- `src/server/container-manager.ts:~1120` -- single-file `.credentials.json` bind / staleFileBinds (BUG-136); the CLI replaces the file wholesale.
- `src/server/grant-rebuild.ts` -- FEAT-175 LEVEL-based recreate-when-idle reconciler to reuse for applying a credential change to running container sessions.
- Invariants: docs/CONVENTIONS.md "A Claude account dir is an overlay" (FEAT-145).
- Related: FEAT-145, BUG-136, FEAT-175, ARCH-010.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-13 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-13 — worker (fixing r1)
- **fix built; status+reauth verified, propagation lean:** Understood — both defects confirmed against the real code. (A) The drawer reads the account list's stored `state`/`lastStatus`, set ONCE by markAccountReady at login time and NEVER re-probed, so an expired/revoked credential shows "signed in" forever. `readAccountHealth` (a live `claude auth status --json` probe) existed but was only called on login exit. (B) startClaudeLogin refused any non-pending account (claude-login.ts:246), and delete+re-add mints a new id, orphaning every project pinned to the old one.

  Changed:
  - src/server/claude-accounts.ts — new live-health view: AccountHealthState (signed-in|needs-relogin|unknown|setup-pending), healthViewOf (error checked BEFORE loggedIn, so a probe failure can never render as signed-in), listAccountsWithHealth (parallel probes, short TTL cache CLAUDE_STATION_ACCOUNT_HEALTH_TTL_MS, DEFAULT account never probed), invalidateAccountHealth (called from markAccountReady + deleteAccount).
  - src/server/index.ts — GET /api/claude-accounts returns listAccountsWithHealth({force:?force=1}); applyRelogin(accountId) + reloginSessionAccount wired via startClaudeLogin onReady.
  - src/server/claude-login.ts — startClaudeLogin accepts a READY account as a RE-login (reauth) against the SAME dir/id; the three delete-on-failure sites (error/timeout/cancel) are guarded so a reauth never deletes the established account; onReady fires after markAccountReady.
  - public/lib/drawer.js — acctHealth() renders live state + colour; "Sign in again" (ready) / "Sign in" (pending) button calling startLogin(a); reauth-aware cancel/failure wording; refreshAccountHealth() re-probes (forced) when the pane opens. public/lib/api.js + public/app.js — thread the force flag. public/styles.css — .set .f.ok (var --live) / .f.warn (var --warn), both theme-defined.

  DESIGN DECISIONS:
  - Honest status fails toward unknown/needs-relogin, never signed-in on a failed probe (ordering in healthViewOf).
  - Default (~/.claude) is NEVER probed: probing shells `claude auth status` against the user's REAL store, which the CLI mutates (rewrites .claude.json). It keeps its static text and carries no health. (This was a real regression I caught — the registry suite's byte-unchanged canary failed until I excluded the default.)
  - Credential propagation to running sessions: after the coordinator retracted the live-hot-swap/busy-deferral scope, the LEAN correct fix is applyRelogin closing each matching running session RESUMABLY (reusing FEAT-160's tested close+resume primitive). The next message resumes it (same id, full history): a direct session gets a fresh CLI reading the fresh token; a container's resume rebinds the new credential via staleFileBinds (running) or docker-start re-resolution (stopped). Container account match is PROJECT-scope (containerAccountId); a busy session (by definition authenticating fine, not logged out) is left untouched and refreshes on its next natural resume. No new standing reconciler, no second recreate trigger (BUG-214). Option (b), a directory bind so a file replace is visible live, loses: FEAT-145 forbids binding the account dir (dangling projects/settings.json symlinks) AND it would NOT help, because the persistent CLI caches the OAuth token in memory — only a process restart (close+resume) picks up a new token.

  Verified (fixer's own run):
  - npm run verify:bug-254 (new, must-FAIL anchored) — 12/12. Status mapping signed-in/needs-relogin/unknown/setup-pending via the FEAT-145 claude stub; the must-FAIL anchor asserts the STORED state is still ready/loggedIn:true in the expired case (so the pre-fix surface WOULD lie); default never probed + fake ~/.claude byte-unchanged; reauth keeps same id + dir.
  - Real drawer over a scratch server (scripts/scratch-bug254-serve.mjs + scratch-bug254-drawer.mjs), BOTH themes — 8/8: expired ready account shows "needs re-login" (warn colour) with "Sign in again"+"Delete", pending shows "Sign in", default keeps static text with NO sign-in button. Screenshots docs/bugs/assets/BUG-254-accounts-{light,dark}.png, visually reviewed (clean, consistent, warn ochre readable in both themes). Live API check: GET /api/claude-accounts?force=1 returned health needs-relogin for the ready account and no health for default.
  - Anti-regression: verify:feat-145-login 56/0 (updated §10 to the new reauth contract — the 3 pre-change "refused when ready" assertions were the OLD contract), verify:feat-145-accounts-registry 36/0, verify:feat-145-session-wiring 21/0, verify:feat-175-grant-rebuild-unit 48/0. npm run gate PASS (exit 0).

  Still open / handoff: independent clean-room verify (plan+review class) — commissioning now. The propagation path (applyRelogin closing live sessions resumably) is high-stakes session-lifecycle and reuses FEAT-160; its SELECTION logic is unit-reasoned but not driven against a live session in my suite (a real turn needs an SDK runtime the login stub does not provide). The verifier should stress: (1) a probe failure never yields signed-in; (2) a cancelled/failed reauth never deletes a ready account; (3) applyRelogin only matches sessions on the re-logged-in account and never truncates a busy one.

### 2026-10-13 — independent clean-room (anthropic Opus)
- **Verification recorded:** dispatch anthropic/claude-opus-4-8 run 9e06a5b9-5559-42e2-b2d4-c4a57530bec1 — VERDICT: HOLDS — HOLDS. Verifier's own suites (60+7 cases): probe failures of every shape never read signed-in; reauth timeout/cancel/error keeps the ready row; applyRelogin closes only matching idle sessions, never default. UNTESTED: real expired token, e2e resume, browser UI (fixer covered UI via Playwright).. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-13 — worker (fixing r1)
- **closed — HOLDS recorded:** Independent clean-room HOLDS recorded (anthropic Opus, run 9e06a5b9-5559-42e2-b2d4-c4a57530bec1); the verifier authored its own 60+7-case adversarial suites. Symptom of a deeper design flaw? NO — defect A (stale 'signed in') is the freshness-at-the-writer variant of ARCH-010 that docs/CONVENTIONS already names as needing its own attention 'where the fact can change while it is being read'; it is handled here by reading the fact LIVE from its owner (the CLI) rather than caching it at login, which is the prescribed remedy, not a new structural gap.

### 2026-10-13 — worker (fixing r2) — LIVE RECURRENCE diagnosed + live state repaired; auto-heal gap NOT fixed (needs its own round)
- **User symptom (live):** after restarting claude-station (service ActiveEnter 2026-10-13 11:40:04 EEST) and re-authenticating a named Claude account (label redacted; id 5a23b2f0b64542b3036e52a5), a session of a private container project (aliased `<container-project>` below) still failed "anthropic — authentication expired / OAuth session expired and could not be refreshed".
- **Ground-truth diagnosis (read-only first; the charter's PRIMARY hypothesis holds — BUG-136 class):**
  - The project `<container-project>` (isolation=container, settings.claudeAccount = the re-authed account id) runs a long-lived container `claude-station-<container-project>`, created 2026-10-12T07:51:07Z, still running, owner label = this instance (01678e1ac055b75f), role=session.
  - Credential bind is a SINGLE-FILE bind: host `…/claude-accounts/5a23b2f0…/.credentials.json` → container `/home/claude/.claude/.credentials.json`.
  - Host file was replaced wholesale by the re-auth (mtime 11:40:57, inode **171351486**, `claude auth status` = loggedIn:true, expiresAt 2026-10-13T16:40:57Z). The container still held the OLD pinned inode **165438363** — an unlinked ghost whose token had been blanked: in-container **expiresAt = 0**. Exactly BUG-136 (inode-pinned single-file bind vs atomic host replace). Re-auth wrote to the RIGHT place; the running container simply could not see it.
  - Note: diagnosis must use the SERVICE's docker daemon (`/var/run/docker.sock`); a bare shell here defaults to a sandbox docker-in-docker context where the project's container is invisible.
- **Live repair via Orchard's own path (no session mid-turn: liveSessions=0, no claude/node process inside the container):** POST /api/projects/&lt;container-project&gt;/container/rebuild → recreated the container (new StartedAt 2026-10-13T08:56:44Z). CONFIRMED: in-container credential inode now 171351486 (matches host), in-container expiresAt 2026-10-13T16:40:57Z, `docker exec … claude auth status --json` = loggedIn:true, subscriptionType:max. No credential contents printed anywhere (only inode/expiresAt/mtime/loggedIn).
- **AUTO-HEAL GAP (real, not fixed):** `staleFileBinds` (container-manager.ts:2234) + `driftReasons` are SUPPOSED to detect this inode mismatch and recreate on the next ensure with no leases (held=false). But on this LIVE server a plain `POST container/start` (= `ensureContainer`, held=false) returned `state:running` with the OLD StartedAt and NO driftReasons — it did NOT recreate. Only the forced `rebuild` (forceRecreate) healed it. So the self-heal that BUG-254 r1's propagation story relies on did not fire for this container. All preconditions I could check externally are satisfied (role=session, owner actable, real host↔container inode mismatch, the `stat -c '%i %n' <abs>` probe is authorised by authorizeProbe), yet the reason was not produced. I could NOT isolate the exact code cause from outside the running process (cannot modify/restart the live service; a bare-shell script can't reach the same docker context) and so — per WA §C (must-FAIL proof before a fix) — did NOT ship a speculative code change.
  - Two candidate causes for a dedicated fixing round to confirm with in-process instrumentation (or a harness fixture that creates a real container, atomic-replaces the host credential to a new inode, and asserts ensure recreates):
    1. Restart-recovery `adoptSession` (agent-bridge.ts ~:6216) reattaches to a surviving in-container CLI WITHOUT calling `admitContainer`/`ensureContainer`, so `staleFileBinds` never runs on the post-restart resume path — explains why the 11:41 session (post-restart) never triggered a heal.
    2. `staleFileBinds`/its probe not producing the reason in-service despite a genuine mismatch (it swallows any probe failure as "no drift" at container-manager.ts:2251 — a silent-failure risk). Needs live instrumentation to decide between (1) and (2).
- **Sibling-class recurrence (one line):** YES — any long-lived container project whose account `.credentials.json` is replaced on the host (re-auth, or host-side token rotation) while the container keeps running will hold the ghost inode and fail "expired" until a forced rebuild; this is the recurring single-file-bind-vs-wholesale-replace class (BUG-136) and the automatic `staleFileBinds` heal is not reliably closing it.
- **High-stakes:** auth + session-lifecycle + regression-prone → any code fix in the next round warrants an independent clean-room verify pass, not self-verification only.
- **User action:** re-send the message in the affected container project's session; the fresh container now authenticates. No account delete/re-add is needed (id preserved).

### 2026-10-13 — worker (fixing r3 — plan+review design review)
- **STRUCTURAL REFUTED; keep-patching chosen (cross-provider approved); build = round 4:** DESIGN REVIEW (two-break, WA §N) — STRUCTURAL FIX REFUTED; KEEP-PATCHING chosen, cross-provider approved. The property "a running container sees the account's current .credentials.json" broke twice (BUG-136 host atomic-replace vs single-file bind; r2 live auto-heal miss), so per WA §N I held the independent design review rather than add another guard.

  PRIMARY HYPOTHESIS (bind a DIRECTORY instead of the single file) — REFUTED as infeasible/unsafe:
  (1) The live credential's only real-file home is the FEAT-145 account overlay dir, which also carries the dangling projects/settings host-symlinks. Binding THAT dir crosses those symlinks — violates "only the credential crosses, never the host-symlinked projects/settings."
  (2) Neutral-dir-bind + symlink `~/.claude/.credentials.json`→bind is UNSAFE. EMPIRICAL (real CLI 2.1.296, scratch CLAUDE_CONFIG_DIR, no docker needed): with the cred path a symlink, after ONE run the CLI REPLACED the symlink with a regular 0600 file on the local fs; the real target was untouched (same inode+mtime). Binary analysis agrees — the plaintext credential backend writes via an atomic writer (En) using O_NOFOLLOW / no allowSymlink; it refuses/clobbers symlinks. So in-container token refresh would stop reaching the host and future host replaces would be invisible — strictly WORSE than today, and a non-persisted rotated (single-use) refresh token could invalidate the account for all consumers.
  (3) The only symlink-free structural variant is binding at ~/.claude WHOLESALE — exactly what BUG-136 explicitly rejected (hands the overlay's projects/settings across; dangling symlinks need fragile nested over-binds) and re-violates the same invariant.
  A full filesystem-component redesign (a FUSE-style filtered view exposing only .credentials.json with atomic-replace forwarding, mounted at ~/.claude with container-owned config/transcript mounts) is theoretically possible but is NOT a bounded bind-mount fix — out of scope for this class; would be an ARCH question if ever pursued.

  POSITIVE DISCOVERY (reframes the fix): CLI 2.1.296 re-reads .credentials.json on MTIME CHANGE (fn Lk: stat(join(cfgDir,'.credentials.json')).mtimeMs → clears cache + reloads, NO process restart). This REFUTES r1's claim "only a process restart picks up a new token." The single-file bind's SOLE defect is inode-pinning on the HOST→container direction: after a host atomic-replace the container keeps the OLD (ghost) inode, so its stat never sees a new mtime and it never reloads. Container→HOST persistence already works: EMPIRICAL (real claude-station-rt container) — an atomic rename onto the single-file bind mountpoint fails EBUSY, and the CLI's in-place fallback (open+truncate same inode) is what persists; r2's live ghost-inode blanking (expiresAt=0, in place) is the real-world proof the fallback fires. So keep-patching leaves NO hidden second defect on persistence.

  CROSS-PROVIDER INDEPENDENT CRITIQUE (openai, run 01a1348f-5e7b-7573-a3e8-41f14e4ef5cd): VERDICT — "rejection of the simple directory-bind fixes HOLDS; 'structural replacement is infeasible' is too strong (a FUSE-style filesystem component could work, but that's a redesign not a bounded fix); KEEP-PATCHING defensible as containment; reject RESCOPE." It confirmed exec-pushing the new credential into the container's old inode FAILS (creates a 2nd credential authority, still can't persist container→host to the current host pathname, write races) → that option DROPPED. It added four acceptance conditions for the build (below) and corrected the residual wording.

  DECISION: KEEP-PATCHING (bounded). Why the others lose — RESCOPE: "a running container sees the account's current credential after in-place re-auth" is squarely the supported contract (it is the entire BUG-254 feature); cannot be declared out of scope. REDESIGN (dir bind): refuted above; the only true structural fix is a filesystem component (ARCH-scale), not warranted for this recurrence.

  BOUNDED KEEP-PATCH SCOPE for the build round (reviewer-approved, NON-RENEWABLE budget: 1 build round + 1 independent clean-room verify):
  (a) Cause 1 — restart re-adoption (adoptSession, agent-bridge.ts:6223, called from index.ts:6430) reattaches to the surviving container WITHOUT ensureContainer/admitContainer, so staleFileBinds/driftReasons never runs on resume. Route stale-credential-bind drift through the EXISTING FEAT-175 LEVEL-based idle-only reconciler (grant-rebuild.ts) so a drifted container is healed when no session of the PROJECT has work in flight — never recreated under a working session. Acceptance conditions from the critique: recover survivor LEASES on adoption BEFORE any reconcile (else a restart makes a mid-turn container look idle and it gets recreated under the survivor); reconcile at PROJECT/container scope (every surviving session, not one adopted one); and guarantee an eventual idle transition RELIABLY INVOKES the reconciler (not merely "next lazy ensure").
  (b) Cause 2 — staleFileBinds (container-manager.ts:2234) silently returns [] on any docker/stat probe hiccup (lines 2251, 2264), so a real mismatch hides as "no drift." Make the probe return a DISTINGUISHABLE clean/stale/UNKNOWN; preserve proven mismatches from a partial probe; an UNKNOWN must REMAIN PENDING and RETRY through the reconciler (logging alone leaves the functional failure intact) and must NEVER itself trigger a spurious recreate.
  PRICED RESIDUAL (accepted, same class BUG-136 already accepted; accepted by: engineering per this review): a credential rotation DURING a live mid-turn session still cannot recreate (held lease → doEnsure refuses), so POTENTIALLY MULTIPLE sessions sharing that container stay stale until the next safe (idle) reconcile. Do NOT promise mid-turn healing; the mtime-reload would only help if the container could SEE the new file, which the bind prevents until recreate. Build must verify in the docker sandbox (npm run sandbox:docker): a real container, atomic-replace the host credential to a new inode, assert heal-when-idle with NO recreate under a live lease, and a must-FAIL against current main. HIGH-STAKES (auth + session-lifecycle + regression-prone) → independent clean-room verify required.

  This round: plan+review only (no code changed). Recommend the orchestrator dispatch the bounded keep-patch as round 4 (fixing).

### 2026-10-13 — independent clean-room (anthropic Opus)
- **Verification recorded:** dispatch anthropic/claude-opus-4-8 run 90182607-1ae7-419a-b09a-008aafc59958 — VERDICT: BROKEN — HOLD: heal 10/0, in-place re-login fail/cancel/success 8/0, unknown->not-stale, no cred leak. BROKEN: probe gate authorized -uroot and --privileged=true (priv-esc). Fixed in lifecycle.ts (container must be first token after exec); re-verified 18/0. Fresh independent re-verify warranted.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-13 — board tool
- **Note:** fixing r4 — bounded keep-patch built (a)+(b)+in-place re-login; independent verify found a probe-gate priv-esc, fixed + self-reverified; work_state in_verification (fresh independent re-verify warranted). HIGH-STAKES (auth + session-lifecycle + ARCH-022 authority).

  HYPOTHESIS CONFIRMED (empirically, real container in the docker sandbox): the CLI live-reload story holds — an IN-PLACE rewrite of the host .credentials.json (same inode) REACHES a running container; an atomic replace (new inode) leaves it frozen (BUG-136). In-container token rotations already write in place (EBUSY fallback), so a container-dedicated account only ever diverges via a HOST-side atomic replace — of which Orchard's own re-login was one. So the in-place write closes the re-login door Orchard owns, with NO recreate, for a non-diverged container. (It cannot reach an ALREADY-diverged container — that is what (a)/(b) are for.)

  BUILT:
  - IN-PLACE RE-LOGIN (claude-login.ts): a REAUTH now runs the CLI against a private TEMP CLAUDE_CONFIG_DIR, then copies the fresh credential IN PLACE into the account's real .credentials.json (open r+, write-then-ftruncate so there is never an empty-file window, fsync, mode 0600) — the real inode is PRESERVED, so a running non-diverged container sees the new token with no recreate. A failed/cancelled/errored reauth leaves the account + old credential untouched (same id); the temp dir is removed on every finish path. readAccountHealth gained an optional configDir so the confirmed loggedIn fact is read from the temp dir before the copy. A first login is unchanged (writes straight to the account dir).
  - (b) TRI-STATE PROBE (container-manager.ts): staleFileBinds is now probeFileBinds -> {stale[],unknown[]}; driftReasons/doEnsure still act ONLY on proven stale (never recreate on unknown). New exported credBindDriftOf(project) -> clean|stale|unknown for the reconciler. A probe that cannot read a bind is UNKNOWN, no longer silently [] (the r2 self-heal miss).
  - (a) RECONCILER ROUTING (grant-rebuild.ts + index.ts): credential-bind drift is a SECOND, orthogonal reason to recreate-when-idle, through the existing FEAT-175 LEVEL reconciler. Deps readCredDrift (=cm.credBindDriftOf) + leasesReady (=lifecycle.isReady). A stale bind -> pending -> recreated once no session of the PROJECT is working (idle sessions closed resumably, resume on next message); unknown -> kept pending + retried, NEVER recreated on; clean -> dropped. It NEVER holds turns (holdOf stays git-only) and NEVER recreates under a busy session or a held lease (the priced residual: a mid-turn container stays stale until idle). Survivor leases: acceptance #1 is met by lifecycle.recover() (a surviving in-container exec -> draining orphan lease -> the reconciler's lease blocker), gated by leasesReady so no reconcile runs before recovery; adoptSession needed no change (container sessions are protected by recover(), not the direct-only adopt path). index.ts applyRelogin also nudges the reconciler.
  - ROOT CAUSE of the r2 silent miss, FOUND + FIXED (lifecycle.ts authorizeProbe): the inode stat probe (and the memory probe) were ALWAYS REFUSED by the authority — statOk/memOk matched the flag-stripped positionals, so cmd[1]==='-c' could never be true; guardOk already used the raw tail. So staleFileBinds has been a no-op through the authority since ARCH-022. Fixed statOk/memOk to match the raw tail too. This is why r2's live start saw NO driftReasons on a genuinely stale container.

  VERIFICATION (self): verify-bug-254-container-heal.mjs (NEW, real container in sandbox, must-FAIL baselines synthesized inline) 18/0 — in-place reaches / atomic freezes / no stale tail / credBindDriftOf tri-state / idle heal recreates and restores inode / busy session never killed / git-only baseline does not heal / and all privilege-flag spellings refused. Anti-regression: grant-rebuild-unit 48/0, bug-254 (status/reauth) 12/0, feat-145-login 56/0, feat-145-accounts-registry 36/0, feat-145-session-wiring 21/0, tsc clean, npm run gate PASS (exit 0). arch-022-authority: 2 PRE-EXISTING fails unrelated to this change (S1 static-scan flags lane-snapshot.mjs/agent-git-policy.mjs/claude-runtime.ts — files not touched here; I12 torn-lease-file quarantine — a path that never calls authorizeProbe; its sibling I7, the real surviving-exec protection, PASSES). bug-244 could not complete (blocked on the sandbox daemon lock by the concurrent arch-022 run; guardOk is behaviourally unchanged by this patch).

  INDEPENDENT CLEAN-ROOM VERIFY (anthropic Opus, run 90182607-1ae7-419a-b09a-008aafc59958; openai was quota-exhausted so cross-provider fell back to anthropic per the standing rule): VERDICT BROKEN. It HELD the heal, the in-place re-login (incl. fail/cancel/success, 0600, no cred leak, temp cleanup — 8/0) and unknown->not-stale, but BROKE the probe gate: my enabling of statOk/memOk made a PRE-EXISTING incomplete privilege-flag blocklist reachable, so `-uroot` (attached short value) and `--privileged=true` (equals form) were authorized and ran as root. FIXED (lifecycle.ts): the container must be the FIRST token after exec (no docker flag may precede it) — structurally blocks every privilege-flag spelling; the enumerated blocklist is kept as defence in depth. Re-verified myself 18/0 (the two exact attack spellings now refused). The FIX to the probe gate has NOT been independently re-verified -> work_state in_verification; a fresh independent clean-room verify is warranted (budget for this round's independent pass was spent finding the priv-esc).

  regressed-from: the probe-gate no-op was introduced by ARCH-022 (authorizeProbe's positionals-stripped statOk/memOk); the priv-esc spelling gap pre-existed in authorizeProbe's flag scan but was unreachable until this round enabled the probes.

  FILES: src/server/claude-login.ts, src/server/claude-accounts.ts, src/server/container-manager.ts, src/server/grant-rebuild.ts, src/server/index.ts, src/server/lifecycle.ts, scripts/verify-bug-254-container-heal.mjs (new). No credential bytes are printed or logged anywhere.

  USER ACTION: restart the claude-station service to load the new server code. After that: a re-login heals running non-diverged containers live (no recreate); any drifted container heals automatically the moment its project is idle; a mid-turn container is never killed (it heals at its next idle). No account delete/re-add is ever needed (id preserved).

### 2026-10-13 — independent clean-room (anthropic Opus)
- **Verification recorded:** dispatch anthropic/claude-opus-4-8 run e9bb075c-48fe-40f4-9529-f3411afae10f — VERDICT: BROKEN — r5 (openai refused priv-esc framing; anthropic fallback). P1 HOLDS: ~35 privileged exec shapes on REAL sandbox container, 0 authorized (r4 fix held, no 3rd break). P2 HOLDS. BROKEN P3 (NEW): applyCredentialInPlace write-then-ftruncate torn stale-tail. BROKEN P4 (NEW): recreates on unknown probe.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-13 — worker (fixing r6 — plan+review adjudication)
- **RESCOPE (reviewer): P4 approved, P3 gated on a newly-found recovery risk — budget NOT spent on a build:** WA §N adjudication of the exhausted r3 keep-patch budget (1 build + 1 verify, both spent). I wrote a design-review plan for the two r5 breaks (P3 torn stale-tail on the in-place credential write; P4 reconciler recreates/holds on an UNKNOWN cred probe) and had it critiqued by a SEPARATE process (openai/codex, run 01a134ef-c0ee-7b40-b833-262bba0b7caa, framed as a design review — no priv-esc framing, the filter did NOT trip this time). No code, board status, or git state changed this round.

  REVIEWER VERDICT: RESCOPE — 'P4 is sound for the stated edge case; P3 needs a stronger recovery condition before approval. This remains a bounded revision.' Per the charter (reviewer rescopes -> STOP and report), I did NOT build. The reviewer did not reject the approach wholesale; it is a conditional grant that tightens P3's acceptance bar and leaves one genuinely-new gating risk unresolved.

  P3 (proposed fix = pad the new JSON with trailing whitespace to >= old length + write in ONE write(), no ftruncate, so the deterministic write-then-ftruncate torn window is gone): reviewer agrees this removes the specific two-syscall window and that a measured residual race CAN be acceptable, BUT only if a sharper bar is met first. NEW GATING RISK it identified (not in my plan, not in any prior round): the CLI stats a changed mtime, reads a torn/inconsistent credential mid-write, and CACHES that read against the write's FINAL mtime; the write then finishes with no further mutation -> the running CLI is stuck on the bad read forever (mtime never changes again to trigger a reload). So 'loggedIn stays true' and 'JSON.parse succeeds' do NOT prove the fix. Reviewer's required conditions before P3 can ship: (1) prove the SAME running CLI recovers and uses the fresh credential with NO further login/write/touch/restart (i.e. test recovery AFTER the final update, nothing to rescue a cached bad read); (2) hammer must assert each read equals a COMPLETE old-or-new credential, not merely valid JSON (a syntactically-valid mixed doc passes JSON.parse); (3) exercise the REAL container reader path — it may size-inspect + do multiple reads, so one writer syscall does not by itself give a whole-document snapshot (NOTE: padding to a FIXED max length also stabilises the file SIZE across writes, which helps a stat-then-read reader — worth building in); (4) include the first-growth-beyond-previous-max case (size changes); (5) check writeSync's RETURN byte count and handle a short write (a successful syscall may write fewer bytes -> persistent corruption). If recovery REQUIRES another mtime change, padding alone is insufficient and a reliable recovery mechanism is needed (that would be a redesign, not a bounded patch).

  P4 (proposed fix = make drive()'s 'a0===d && !credStale -> return' guard phase-INDEPENDENT so a FAILED entry with git-matching + unknown cred no longer recreates; and in tick() failed-branch when a===d: drop on clean, DOWNGRADE failed->pending on unknown to stop the turn-hold without 3s-churn, keep failed only on PROVEN stale): reviewer APPROVED — 'removing the phase qualifier is appropriate; it does not strand the described failed git retry (a known mismatch incl a0===none still passes the guard); the downgrade preserves reprobes and removes the unconditional failed-phase hold.' Two refinements: narrow the invariant claim to 'credential UNCERTAINTY alone never recreates or holds turns WHEN GIT IS KNOWN TO MATCH' (independent git mismatch / unreadable git / an in-flight rebuild keep their own behaviour — the literal 'unknown never holds/recreates in every phase' overclaims); and add an unknown->stale test proving recovery still recreates when idle after a downgrade.

  DECISION FOR THE ORCHESTRATOR (budget NOT spent — no build this round): the reviewer's headline is RESCOPE, so I stopped. Options: (a) re-dispatch ONE bounded round that FIRST resolves the P3 recovery gate cheaply read-only/in the docker sandbox (does CLI 2.1.296 recover from a torn/cached credential read with NO further mutation?) and only then builds P3+P4 under the sharpened conditions; or (b) split — build P4 now (clearly approved, low-risk, unit-testable) and hold P3 until the recovery gate is proven, since if the CLI does not self-recover P3 needs a different mechanism (redesign). High-stakes (auth + session-lifecycle); any build still warrants an independent clean-room verify attacking only P3+P4.

### 2026-10-13 — independent clean-room (anthropic Opus)
- **Verification recorded:** dispatch anthropic/claude-opus-4-8 run fa84e17b-ca62-48b2-8fdf-c1b5e9b42c9a — VERDICT: HOLDS — r7 clean-room (openai refused; anthropic fallback). P3=wholesale atomic replace (gate: in-place padded write ~0.012% torn; CLI reloads on mtime only). HOLDS: P4 unknown+stale-heal; replace never torn (400k); failed reauth keeps good cred. UNTESTED(no docker): e2e heal (author 19/0 sandbox), D gate.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-13 — worker (fixing r7)
- **P3 fallback shipped (atomic replace), P4 built; clean-room HOLDS:** ONE bounded round under the r6 reviewer's "bounded revision" grant. No git writes; no credential contents printed.

  P3 GATE (ran FIRST, docker sandbox, no real credentials needed): does CLI 2.1.296 reliably self-recover from a torn credential read with NO further write/touch/login/restart? A tight concurrent-reader race against the r6-proposed PADDED fixed-length single write() (no ftruncate) — measured on the host AND inside a real claude-station-rt container over the single-file bind — produced ~0.012% TORN reads (49 and 21 per 400k; mixed A+B docs that still parse). A ~1 KB write() is NOT atomic against a reader. Since CLI 2.1.296 reloads the credential ONLY on an mtime CHANGE (r3 fn Lk), a torn read cached against the write's FINAL mtime has no recovery trigger — it strands the running CLI. GATE FAILS: reliable self-recovery cannot be proven, and per the charter I did NOT invent a recovery mechanism.

  P3 DECISION = FALLBACK (the path that already HOLDS). Removed the r4 same-inode in-place write entirely. applyCredentialInPlace -> applyCredentialReplace (claude-login.ts): write the fresh credential to a sibling temp in the account dir, fsync, rename() over .credentials.json — a WHOLESALE ATOMIC replace (new inode, complete bytes, never torn). A failed/cancelled reauth still leaves the account's existing good credential untouched (temp-dir reauth + the account is only marked ready on a confirmed loggedIn). The running container keeps its old bound inode (BUG-136) until the VERIFIED P2 idle-only reconciler recreates it when the project is idle. PRICED RESIDUAL (accepted per charter): a few seconds until the heal runs rather than instant; the failing sessions are idle (auth-blocked) so the heal fires. index.ts applyRelogin comment updated: every re-login now diverges the container and relies on the heal (the nudge was already wired); idle direct sessions still close resumably to pick up the new account credential.

  P4 BUILT (reviewer-approved, grant-rebuild.ts): (1) drive()'s `a0===d && !credStale -> return` guard is now PHASE-INDEPENDENT (was pending-only; the r5 break was a FAILED entry with git-matching + an 'unknown' cred probe recreating). (2) tick() failed-branch, when git is known and actual===desired: drop on CLEAN cred, DOWNGRADE failed->pending on 'unknown' (clears the 'failed' turn-hold and the fixed-retry churn, keeps reprobing), keep 'failed' only on a PROVEN 'stale' bind. Narrowed invariant per the reviewer: credential UNCERTAINTY alone never recreates nor holds turns WHEN GIT IS KNOWN TO MATCH (a0===d); a real git mismatch incl a0==='none' keeps its own behaviour.

  VERIFICATION (self): verify-bug-254-reconciler-unknown.mjs (NEW, must-FAIL baseline built inline by reverting the two fix hunks) 9/0 — pre-fix module BOTH holds turns AND recreates on unknown; fixed does neither; unknown->stale still heals when idle; git-mismatch+unknown still recreates. verify-bug-254-cred-atomicity.mjs (NEW, pure-fs concurrent race) 2/0 — shipped atomic replace 0 torn / 0 parseFail across 400k reads; removed in-place path tears (must-FAIL baseline). verify-bug-254-container-heal.mjs (UPDATED §A to the atomic-replace contract + a §T torn-read regression) 19/0 in the docker sandbox — atomic replace -> new inode -> container frozen -> credBindDriftOf 'stale' -> idle heal recreates and restores the inode -> reads the new token; busy session never killed; probe gate refuses every privilege-flag spelling. Anti-regression: feat-175-grant-rebuild-unit 48/0, bug-254-account-status 12/0, feat-145-login 56/0, feat-145-accounts-registry 36/0, feat-145-session-wiring 21/0, tsc clean, npm run gate PASS (exit 0).

  INDEPENDENT CLEAN-ROOM (scripts/independent-verify.mjs): openai/codex was dispatched first (design-review framing) but its cyber-filter flagged the docker/privilege content mid-run -> dispatch failed -> INVALID (same refusal class as r5); fell back to anthropic Opus per the standing rule (same-provider, decorrelation reduced — recorded). Run fa84e17b-ca62-48b2-8fdf-c1b5e9b42c9a VERDICT HOLDS: re-ran both fixer suites green and added its own adversarial cases (P4 fresh-unknown + pending->stale heal; P3 failed-relogin with src missing / src a directory / interleaved fail-succeed race — the existing good credential stays byte-identical with no temp litter and a reader is never torn). UNTESTED in-room (docker unreachable): container-heal e2e §A/§B/§C (author ran 19/0 in the sandbox), the §D probe-authorization gate, and the leasesReady()===false suppression window (both suites use leasesReady:true). No property broke through a new door — no two-break STOP.

  regressed-from: BUG-254 r4 introduced the same-inode in-place write (applyCredentialInPlace) that r5 broke (torn stale-tail) and r6 gated (mtime-cache poisoning); r7 removes it. The P4 phase-qualifier gap was r4's (drive guard pending-only); r5 broke it.

  FILES: src/server/claude-login.ts, src/server/grant-rebuild.ts, src/server/index.ts (comment), scripts/verify-bug-254-container-heal.mjs (updated), scripts/verify-bug-254-reconciler-unknown.mjs (new), scripts/verify-bug-254-cred-atomicity.mjs (new), scripts/verify-bug-254-r7.mjs (new runner). No credential bytes are printed or logged.

  USER ACTION: restart the claude-station service to load the new server code. After that, "Sign in again" on a ready account re-logs in on the SAME account id/dir and ends with every container on that account authenticated with NO manual step — the credential is replaced atomically on the host and each running container is recreated automatically the moment its project is idle (a few seconds; its auth-failing sessions are idle). No account delete/re-add is ever needed.

### 2026-10-13 — independent clean-room (anthropic Opus, sandbox docker)
- **Verification recorded:** dispatch anthropic/claude-opus-4-8 run 2e54808c-1d3d-4ca1-9cfd-15d7fe6d389e — VERDICT: BROKEN — r8 WITH sandbox docker (openai quota->anthropic). Fixer heal suite green in-room. BROKEN P2: docker global opts before exec (-H/--host/-D) authorized; -H sends exec to unchecked daemon. BROKEN P3: leasesReady-false window git-mismatch recreate not credReady-gated. Two-break STOP; P1 untested.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-13 — worker (fixing r9)
- **Note:** Two-break adjudication (plan+review): STEP 0 established FIRST (regression vs pre-existing), then an independent design review approved both fixes KEEP-PATCH, then built + verified.

  STEP 0 — NEITHER r8 break is a BUG-254 regression; the live server on committed HEAD has NEITHER:
  - Probe gate (P2). The hole is pre-verb GLOBAL-option blindness in verbIndex() (docker-exec.ts), UNCHANGED from HEAD, and it was already reachable on HEAD via the BUG-244 git-guard probe (guardOk used `tail` on HEAD). BUG-254 r4 widened WHICH probe shapes pass (statOk/memOk) but did not introduce the blindness. DECISIVE: no untrusted input reaches authorizeProbe at all — all 3 probe-argv callers (container-manager.ts:1990/2263/4615) build a fixed literal ['exec', containerName, ...fixedCmd, ...absPaths]; no caller emits a docker global option or privilege flag, and the container token is a single argv element AFTER exec. The r4/r8 "breaks" are the verifier calling the gate function directly with argv no code path constructs.
  - Lease window (P3). grant-rebuild.ts is UNTRACKED (not on HEAD): the whole reconciler is uncommitted FEAT-175+BUG-254 work, so committed HEAD has no reconciler and cannot exhibit this. Within the uncommitted code, the git-path-not-leasesReady-gated behaviour is FEAT-175's; BUG-254 r4 added leasesReady but scoped it to the credential reason only. Reproduced at module level (/tmp repro): leasesReady=false + git mismatch + sessionsOf=[]/leasesOf=[] (survivor not yet recovered) -> recreate fires.

  INDEPENDENT DESIGN REVIEW (fresh-context Opus; openai quota-exhausted so cross-provider fell back to anthropic per the standing rule — recorded). VERDICT both items KEEP-PATCH:
  - ITEM 1 probe gate: verbIndex===0 + RESCOPE approved; full typed-request constructor NOT required (per ARCH-022 this gate is enforcement over Orchard's OWN code, not access control over untrusted input, so the constructor's gain is pure defence-in-depth). CONDITION it added: put the guard at the single authorize() CHOKE POINT, not only in authorizeProbe — authorizeLease and the op/mutation path share the identical pre-verb blindness (a `-H`-redirected granted mutation would reach an unchecked daemon). Keep verbIndex/verbAt unchanged (shared with isReadArgv); keep the privilege blocklist as defence in depth.
  - ITEM 2 lease window: gating ALL reconcile reasons on leasesReady approved (matches FEAT-175's own "never recreate under live work"; the only thing delayed is rw->ro tightening which is not time-critical). CONDITIONS: keep pending + cheap retry (no backoff/drop); a force during the window told explicitly and NOT allowed to bypass; single top-level guard subsuming the old cred-only credReady.

  BUILT (per the conditions):
  - lifecycle.ts authorize(): ONE choke-point guard `if (verbAt(args) !== 0) refuse('global-option', ...)` after the getStore/isWriter guards, before the ctx dispatch — covers probe + lease + op. Structurally ends the daemon/context/config-redirect class (-H/--host/--context/-c/--config/-l/--log-level/-D, incl glued and = spellings); refuses nothing legitimate (every Orchard docker argv starts with the verb/object word — audited). verbIndex/verbAt untouched; the r4 privilege blocklist kept.
  - grant-rebuild.ts drive(): credReady renamed reconcileReady and promoted to a single guard right after the "nothing-to-do" return (a0===d && !credStale) and before any action: if !reconcileReady() -> hold (pending, retried), telling a force press explicitly; credStale no longer carries its own readiness clause.

  VERIFICATION (author): verify-bug-254-r9.mjs (NEW) 31/0 — verbAt classification for every global-option spelling (refused) + real argv (verb at 0, allowed) + the guard-wired-at-choke-point source assertion; lease window with a reverted-hunk must-FAIL baseline (PRE-FIX recreates in the window, REAL holds), release-when-ready, force-refused, stale-cred gated too, no-false-hold control. verify-bug-254-container-heal.mjs (sandbox, UPDATED +§D global-option block) 28/0 — e2e credential heal, tri-state drift, probe gate refuses every privilege flag AND every global-option-before-verb spelling, control probe (verb at 0) still authorized, idle reconciler recreates/busy protected. Anti-regression: feat-175-grant-rebuild-unit 48/0, reconciler-unknown 9/0, account-status 12/0, feat-145-login 56/0, tsc clean, npm run gate PASS (exit 0).

  INDEPENDENT CLEAN-ROOM (scripts/independent-verify.mjs --working-tree, fresh context, board/methodology stripped; anthropic — openai quota-exhausted, same-provider decorrelation reduced, recorded). SUBSTANTIVELY A CLEAN PASS, harness verdict INVALID on a citation-FORMAT technicality only (never a BROKEN; no two-break). The verifier re-ran both author suites green (r9 31/0; container-heal 28/0 in its OWN sandbox) AND authored its OWN adversarial tests: scratch-adv-docker 36/0 — exotic global-option spellings NOT in the author list (--, --tls, --tlsverify, --debug, --log-level=, -ldebug, --config=, -c default, --tlscacert) refused on the PROBE, OP-MUTATION and LEASE paths; `container -H sock stop` (global after the object word) refused; privilege-after-container refused; controls (plain probe, tagged exec, legit --user session exec) authorized; and the charter's untested P1 shapes all PASS (two sessions one busy -> no recreate neither closed; back-to-back re-login binds the LATEST credential; credential replaced while STOPPED then restarted binds FRESH; clean git+cred -> no churn). scratch-adv-recon 10/0 — window holds for git/cred/both/none, survivor appearing mid-drive protected, readiness-dropping-to-false-again held. (Its lone exit-1 was a bug in the verifier's OWN synthetic case — an uncaught throw from a fake leasesReady that cannot occur in the real system where isReady() only returns a boolean.) NOTE it correctly flagged that an ENV DOCKER_HOST redirect is "outside the argv claim" — that env var is Orchard's own trusted service config, not argv, so it is not in scope. The INVALID is purely that its reply carried 2 `FIXER-TEST:` lines (contract allows one).

  regressed-from: FEAT-175 (git reconcile path never leasesReady-gated) and BUG-254 r4 (scoped leasesReady to the credential reason only) for ITEM 2; ARCH-022/BUG-244 verbIndex pre-verb blindness for ITEM 1 — neither is a BUG-254-introduced regression.

  FILES: src/server/lifecycle.ts, src/server/grant-rebuild.ts, scripts/verify-bug-254-r9.mjs (new), scripts/verify-bug-254-container-heal.mjs (updated §D). No credential bytes printed or logged anywhere.

  USER ACTION: the live server on committed HEAD has NEITHER break, so no urgency to roll back; load this build at the next restart. After it loads: a re-login heals as before, and a restart no longer risks the idle reconciler acting before boot lease-recovery completes (every recreate reason now waits for leasesReady). No account delete/re-add is ever needed.

### 2026-10-13 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-4-8 run 76463b63-8ec8-4dc4-b227-eac96bf114be — VERDICT: INVALID — Clean-room anthropic (openai quota->fallback). Substantively GREEN: re-ran author r9 31/0 + container-heal 28/0 (sandbox) + OWN adversarial docker 36/0 (every global-opt spelling refused on probe/op/lease; all P1 shapes) + recon 10/0. INVALID = citation-format (2 FIXER-TEST lines) only, no break.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-13 — independent clean-room (anthropic Opus, sandbox docker)
- **Verification recorded:** dispatch anthropic/claude-opus-4-8 run 99126667-d78f-4918-bb21-72abac96456b — VERDICT: HOLDS — r10 clean-room (openai quota->anthropic). VALID HOLDS; correct shape (1 FIXER-TEST + 2 ADVERSARIAL, 12 manifest runs). r9 31/0; container-heal 28/0 (authorize refuses every global-opt on probe+op+lease; idle stale->fresh heal); module-p2p3 13/0. UNTESTED: P3b relogin, P3c stop-restart.. Typed entry in the record's verification[]; this line is an echo, not proof.
