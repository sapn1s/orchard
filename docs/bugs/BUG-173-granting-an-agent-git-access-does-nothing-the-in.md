# BUG-173 — Granting an agent git access does nothing; the invocation shim never reads the grant

- **Status:** VERIFIED — grant-aware shim landed (rounds 2-4); independent clean-room pass HOLDS. See residuals below.
- **Severity:** high
- **Area:** server (git-write enforcement / grant)
- **Reported:** 2026-09-08 by verification lane (agent ab774fb0c07261cdf)
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED.
- **Verified-by:** dispatch anthropic run bb1f02d5-364a-4efc-a739-6e3a27642850 (clean-room, `scripts/independent-verify.mjs`) — VERDICT: HOLDS
- **Residuals (honest, not blocking):** (a) the live decide route's ALLOW side is still mirror-tested only — no real Orchard session was launchable in the clean room to trigger `getShimSecret()`'s lazy secret mint, so the real `POST /api/git-shim/decide` was exercised only on its DENY side; the allow path is proven against the faithful mirror host. (b) A same-uid agent that rewrites the shim file, prepends its own PATH, or calls git by absolute path bypasses the shim entirely — fundamentally unclosable between two processes of one uid (FEAT-135 lineage); documented and OUT OF SCOPE.

## Symptom
The user enabled the time-boxed "allow agent git writes" grant in the dashboard
(scope = duration, ~30 min), then asked an agent session to `git add`. The write
was still refused with the FEAT-135 invocation-layer refusal ("git write refused
at the invocation layer"). The grant bought nothing: the user still has to do all
git by hand — which is exactly what the grant exists to avoid.

## Repro
1. Start an agent session in a project.
2. In the dashboard, mint a duration git-write grant (~30 min) for that project.
3. In the session, have a subprocess (or a plain tool call that resolves the PATH
   `git`) run `git add -A`.
4. It is refused with the FEAT-135 shim message, despite the live grant.

Reproduced in-process without mutating the repo:
`decideGitShim(['add','-A'], process.env)` → `{ allow:false, reason:"git add" }`.
The grant was confirmed live at the same time: the grant's `recentWrites` recorded
`offender: "git add"`, `grantScope: "duration"`, session `cs-mtrtl3rg-1` — i.e. the
grant-aware layer PERMITTED the identical write while the shim refused it.

## Expected
A minted grant is honoured by BOTH enforcement layers. A subprocess `git` write in
a session covered by a live grant succeeds; when the grant expires or is revoked,
the shim re-blocks within the same session with no relaunch.

## Invariant (one testable sentence)
Every git-write enforcement path — the FEAT-108 Bash hook AND the FEAT-135 PATH
shim — must reach the same allow/deny decision for the same invocation given the
CURRENT host grant state, evaluated at call time, not at session-launch time.

SCOPE (clarified round 3, a DECISION — see the round-3 Activity entry): the grant
is per-PROJECT, matching the FEAT-108 hook (the pre-existing single grant
authority, `peekGrant(projectKey)`). A DIFFERENT session inside the SAME granted
project is allowed BY DESIGN — the grant UI is a project-level control the user
toggles expecting their project's lanes to work. A grant for a DIFFERENT project
never unblocks the call. Per-SESSION scoping is explicitly NOT the contract:
making the shim stricter than the hook would create two authorities with
different answers — the ARCH-010 defect this ticket exists to remove.

## The design that produces the class
Two independent enforcement layers exist and only one is grant-aware:

- **FEAT-108 hook — grant-AWARE.** `src/server/runtime/claude-runtime.ts:758` calls
  `evaluateGitWrite`, which consults `peekGrant(projectKey)`
  (`scripts/lib/git-grant.mjs:45`). A live grant flips a write to allowed and the
  decision is re-made on every Bash tool call (see the "mid-session takes effect on
  the next tool call with no relaunch" comment at claude-runtime.ts:752).

- **FEAT-135 shim — grant-BLIND.** `scripts/lib/git-shim.mjs:90-99` (`decideGitShim`)
  consults ONLY `gitWriteBlockEnabled(env)`, i.e. the `ORCHARD_ALLOW_GIT_WRITE` env
  var. That var is baked into the session env at launch
  (`claude-runtime.ts:573`, `codex-runtime.ts:412`) and is never updated when a grant
  is minted later. A grant minted after launch can therefore never reach a baked env
  var, so the shim keeps refusing. The gap is already acknowledged in the module
  comment at `git-shim.mjs:48-51`.

The split exists on purpose (FEAT-135): the hook scans the Bash command STRING and
cannot see git spawned from inside a subprocess (`node -e '…execFileSync("git",…)'`,
a wrapper script), so the shim is a PATH-level backstop that every process hits
regardless of how it spawned git. The design gap is that the backstop was wired to a
static env hatch instead of the live grant the hook already reads.

## Proposed direction (a direction, not a decision — for the implementer)
The shim must consult the HOST grant AT CALL TIME rather than a launch-time env var,
since a grant minted after launch can never reach a baked env. Options for whoever
implements: have the shim query the host's grant route, or have the host write a
grant token/file keyed by `ORCHARD_SESSION` (already present in the shim env — set as
`ORCHARD_SESSION_ENV` in the env the shim is installed onto, claude-runtime.ts:573)
that the shim reads on each invocation. Whatever the transport, `decideGitShim` must
resolve current grant state per call, not once at launch, and must fail CLOSED if it
cannot read that state.

## Proof bar (what must be true to call it fixed)
1. With NO grant, a subprocess `git add` in a session is still refused by the shim
   (FEAT-135 backstop intact).
2. A grant minted AFTER the session launched is honoured by the shim on the next git
   invocation, with no session relaunch — the write succeeds.
3. When that grant expires (duration lapses) OR is revoked, the shim RE-BLOCKS within
   the same live session on the next invocation.
4. The shim's decision matches the hook's decision for the same invocation and grant
   state (no layer permits what the other refuses, and vice-versa).
5. Publishing-subcommand gating (leak-gate) and single-use grant consumption are not
   bypassed by the shim path — the shim honours the same guards the hook applies, or
   defers to the same grant machinery.
6. If the shim cannot read host grant state, it fails closed (refuses), never open.

## What would falsify the fix
- A grant minted after launch still leaves the shim refusing (baked-env regression).
- An expired/revoked grant still lets the shim allow writes (stale grant honoured).
- The shim allows a write the hook would refuse for the same grant state, or the
  shim path bypasses the leak-gate / single-use consumption the hook enforces.
- A grant-state read failure causes the shim to allow (fails open).

## Context pack (grows — the "where to look", so no agent cold-starts)
- Files/functions in play:
  - `scripts/lib/git-shim.mjs:90-99` `decideGitShim` (grant-blind; module comment
    48-51 acknowledges the gap)
  - `scripts/lib/git-grant.mjs:45` `peekGrant`; `consumeGrant`, `recordGitWrite`
  - `src/server/runtime/claude-runtime.ts:573` (shim install / env baking),
    `:752-762` (hook grant evaluation, mid-session re-decide)
  - `src/server/runtime/codex-runtime.ts:412` (same env baking)
  - `scripts/lib/git-write-policy.mjs` `offenderForGit`, `gitWriteBlockEnabled`
    (the ONE classifier shared by both layers, ARCH-008)
- Related tickets: FEAT-108 (Bash-hook git block), FEAT-135 (PATH shim backstop),
  FEAT-134 (temp-index snapshot plumbing), ARCH-008 (single classifier),
  BUG-172 (a separate mis-classification in the same backstop).
- Repro test: `node -e "import('./scripts/lib/git-shim.mjs').then(m=>console.log(m.decideGitShim(['add','-A'],process.env)))"`
  → `{ allow:false, reason:'git add' }`. Add a `verify:` script that exercises the
  after-launch-grant and revoke/expire cases against the real grant store.
- Known dependencies / blockers: the shim runs as a standalone node executable in the
  session subprocess — any grant read it does must work from that process (no shared
  in-memory host state), so a token/file or route query is required.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-08 — filing lane
- **Understood:** Two git-write enforcement layers; only the FEAT-108 hook reads the
  grant. The FEAT-135 shim keys off a launch-baked `ORCHARD_ALLOW_GIT_WRITE` env var,
  so any grant minted after launch is invisible to it and subprocess git writes stay
  refused despite a live grant.
- **Changed:** nothing (ticket only; no fix implemented per charter).
- **Verified:** in-process, non-mutating: `decideGitShim(['add','-A'], process.env)`
  → `{ allow:false, reason:'git add' }` while the live grant recorded the same
  `offender:"git add"` permitted under `grantScope:"duration"` (session
  `cs-mtrtl3rg-1`). Established by verification lane agent ab774fb0c07261cdf.
- **Still open / handoff:** implement per the proposed direction — make `decideGitShim`
  consult current host grant state at call time (route query or `ORCHARD_SESSION`-keyed
  token), fail closed on read failure, and satisfy the full proof bar above.

### 2026-09-08 — fixing lane (round 2; resumed a quota-killed round-1 lane)
- **Inherited work audited (unstaged, unverified, no verifier, no activity entry).** Ran
  `git diff` on the five files round-1 left. Verdict: the design was sound and, contrary to
  the handoff note ("server route likely least finished"), essentially COMPLETE. What I did
  with each hunk:
  - `scripts/lib/git-grant.mjs` — KEPT. Adds an `argv` shape to `evaluateGitWrite` so the
    shim and the hook share ONE authority (ARCH-010); the grant/leak-gate/single-use tail is
    identical to the command-string path. Correct.
  - `scripts/lib/git-shim.mjs` — KEPT. `decideGitShim` still denies LOCALLY (sync, network-
    free) but flags `consultHost`; new `askHostGrant` + `resolveGitShim` do the call-time
    loopback consult; `installGitShim` bakes `grantKey`/`hostUrl`; `runGitShim` is now async.
    Fails closed on every failure path. Correct.
  - `src/server/index.ts` — KEPT. `POST /api/git-shim/decide` runs the SAME `evaluateGitWrite`
    the hook runs (peekGrant + leak gate on publish + single-use consume), resolves repo path
    via `reg.getProject(grantKey).hostPath` (= the hook's `config.gitRepoPath`), fails closed
    on unreadable/partial body. Verified `readBody`/`sendJson`/`reg.getProject`/`hostPath`
    exist and no index↔claude-runtime import cycle (one-way: index imports the now-exported
    `runLeakGateForRepo`). Correct.
  - `src/server/runtime/claude-runtime.ts` + `codex-runtime.ts` — KEPT. Both bake
    `grantKey: config.gitGrantKey` (= `opts.project.id`, the exact key the hook peeks) and a
    `http://127.0.0.1:${PORT}` loopback URL onto the session env. Sibling codex defect fixed
    identically. Correct.
  - DROPPED/ADDED nothing to the inherited hunks. **Added what round-1 missed:** the sidecar
    declaration files `scripts/lib/git-shim.d.mts` and `git-grant.d.mts` (allowJs is off, so
    TS types come from these, not the `.mjs`) — without this the typecheck gate FAILED
    (TS2353 on `argv`/`grantKey`); and the verifier below.
- **Design confirmed = the ticket's hypothesis:** shim consults the host grant authority at
  call time over loopback, keyed by the project id baked at launch, one authority for both
  layers, fail-closed. Grant scope is per-PROJECT (matches the existing hook — `peekGrant`
  is project-keyed); a grant for another project/session cannot unblock this one.
- **Staleness window accepted: ~ZERO (bounded by one git invocation).** The host computes
  live grant state per call; there is no cached/copied grant in the session, so an expired or
  revoked grant re-blocks on the very next git invocation with no relaunch. The only bound is
  the per-call host round-trip (`HOST_GRANT_TIMEOUT_MS = 2000ms`), on timeout of which the
  shim FAILS CLOSED. Reads never touch the network (hot path stays cheap).
- **Changed (all UNSTAGED):** scripts/lib/git-grant.mjs, scripts/lib/git-shim.mjs,
  scripts/lib/git-grant.d.mts, scripts/lib/git-shim.d.mts, src/server/index.ts,
  src/server/runtime/claude-runtime.ts, src/server/runtime/codex-runtime.ts,
  scripts/verify-bug-173-grant-aware-shim.mjs (new).
- **Verified — `node scripts/verify-bug-173-grant-aware-shim.mjs` → "BUG-173: 17 passed, 0
  failed" (exit 0).** Legs: [must-FAIL] the pre-fix shim (`git show HEAD:…git-shim.mjs`)
  refuses `git add` even with a live 20-min grant + reachable host, and has NO call-time
  consult; the identical post-fix scenario is ALLOWED. [e2e] a REAL `git add` subprocess
  through the installed shim against a REAL SEPARATE host process (with `/_test/*` grant
  routes): no grant → refused; grant minted AFTER launch → SUCCEEDS (index moves); revoke →
  re-blocked next invocation; grant for a different project → refused. [unit] duration expiry
  re-blocks (deterministic `now`); a granted `commit` with a FAILING leak gate is blocked and
  with NO gate runner fails closed (grant never lifts the gate). [fail-closed] missing coords
  / unreachable host / malformed 200 body / unresponsive host (timeout) all DENY; reads stay
  local and allowed.
  - **Why a SEPARATE host process for the e2e:** the shim is spawned with `spawnSync`, which
    blocks the driver's event loop, so an in-process host could never answer the shim's
    loopback fetch (an allow could never succeed, and denies would pass for the wrong reason).
    The separate process also matches production (host ≠ session process).
- **Anti-regression:** `verify-feat-108-git-grant.mjs` → 38 passed / 0 failed / 1 skipped;
  `verify-feat-135-git-shim.mjs` → 31 passed / 0 failed (run with the session's own inherited
  git shim stripped from PATH — see below). `npm run gate` → PASS (leak-gate, check-nul,
  typecheck; exit 0).
- **Could NOT test / caveats:**
  - The `src/server/index.ts` route BODY is exercised by a faithful mirror (same field
    validation, same `evaluateGitWrite` call, same fail-closed) in a spawned host process, not
    by booting the whole Orchard server; the route's registry/`hostPath`/`readBody` wiring is
    covered by the typecheck gate + code audit, not an HTTP hit on the live server.
  - The leak gate in the e2e/unit legs is a stubbed runner (`{ok:...}`), not the real
    `scripts/leak-gate.mjs` subprocess — the real gate is what the LIVE route injects via
    `runLeakGateForRepo(repoPath)`; I verified the wiring, not a real leak-gate subprocess run
    on a publish through the shim.
  - Harness note (not a product bug): both this verifier and `verify-feat-135-git-shim.mjs`
    run INSIDE an Orchard agent session whose PATH already carries a git shim. This verifier
    scrubs that via a clean BASE env; the FEAT-135 one does not, so it only passes when run
    with `ORCHARD_GIT_SHIM_DIR` stripped from PATH (confirmed 31/0). Its in-session failure is
    environmental, present on HEAD too, NOT a BUG-173 regression.
- **Independent verification WARRANTED (high-stakes, fail-closed safety backstop touching the
  git-write path).** Generation was its own verifier here; a clean-room second pass
  (scripts/independent-verify.mjs / fresh-context agent) should confirm before VERIFIED —
  especially the real-server route path and a real-leak-gate publish through the shim, the two
  things I mirrored/stubbed rather than drove end to end. Status left OPEN.
- **NO git writes performed; all changes left UNSTAGED per charter.**

### 2026-09-08 — independent verification lane (round 1)
- **Verified-by:** dispatch anthropic run 0b3509de-3c9d-45d1-9e1d-881eb2aa18ea (clean-room, `scripts/independent-verify.mjs`) — VERDICT: BROKEN
- **Provider note:** cross-provider (OpenAI) was attempted FIRST and refused by the
  provider — `dispatch failed [quota-window] (provider openai): You've hit your usage
  limit … try again at 5:44 AM` (harness reported VERDICT-CONTRACT: INVALID, nothing
  verified). Fell back to the harness's clean-room **anthropic** path per charter, so
  decorrelation is reduced (same provider as the fixer, fresh clean-room context).
- **Invocation:** `node scripts/independent-verify.mjs --repo . --working-tree
  --requirement @<plain-terms> --run "node scripts/verify-bug-173-grant-aware-shim.mjs"
  --run "npm run typecheck" --test-file scripts/verify-bug-173-grant-aware-shim.mjs
  --author-provider anthropic --provider anthropic` (FEAT-134 dirty-tree snapshot:
  HEAD dc1f4ea0f3d2 → tree 960394143e91; real index untouched). Verdict contract:
  **VALID (manifest-backed, 3 recorded runs)**.
- **Adversarial case run (real server, not the mirror):** the verifier booted the REAL
  `src/server/index.ts` and hit the REAL `POST /api/git-shim/decide` (run
  `ff1d8e1a198b`, exit 1):
  - `PASS no grant → REAL route denies`
  - `PASS grant minted after boot → REAL route ALLOWS (got {"allow":true,…})`
  - `DIFFERENT-SESSION decide: {"allow":true,"reason":null,"offender":"git add"}`
    → `FAIL grant for wrong SESSION → REFUSED (claim requires this)`
  - `PASS revoked grant → REAL route denies`
  So the real route DOES exist, boot, and behave like the mirror for the project-scoped
  cases — the mirror was faithful. The single refutation is **session scoping**.
- **FINDING (the defect):** `evaluateGitWrite` and `/api/git-shim/decide` key the grant
  on `projectKey` ALONE and merely RECORD `sessionLabel`. After a duration grant for
  project `advproj`, a decide call carrying `sessionLabel:"a-totally-different-session-xyz"`
  returned `{"allow":true}`. Any session in a granted project may write, including one the
  grant was never intended for. NOTE for the decider: this is refuted *against the claim as
  stated to the verifier* ("wrong project/session … still refuse"). Whether per-session
  scoping is a required property or the grant is deliberately project-scoped is a DESIGN
  call for the user — if project-scope is intended, the claim text (not the code) is what
  is wrong, and the ticket should say so explicitly rather than leave the ambiguity.
- **FIXER-TEST re-run — environmental failure in the clean room, PASSES in the real repo.**
  In the clean room the export is not a git repo, so the must-FAIL leg's
  `git show HEAD:scripts/lib/git-shim.mjs` threw `fatal: not a git repository` and the
  suite aborted before any assertion (run `ca49f5d33d6f`, exit 1). Re-run by this lane in
  the real checkout: `node scripts/verify-bug-173-grant-aware-shim.mjs` → **`BUG-173: 17
  passed, 0 failed`, exit 0** (all four legs green, incl. after-launch grant honoured,
  revoke/expiry re-block, wrong-project refused, and all fail-closed cases). Follow-up for
  the fixer: the must-FAIL leg should tolerate a non-git checkout (e.g. skip-with-reason or
  vendor the pre-fix source) or it is unrunnable in every clean room.
- **Could NOT be tested (verifier's own list):** (a) a real leak-gate SUBPROCESS driven end
  to end through the spawned shim binary on a granted commit/push over a planted-secret repo
  — only the route decision + `runLeakGateForRepo` wiring/typecheck were confirmed;
  (b) grant-expiry racing an in-flight shim call; (c) env-var redirection of
  `ORCHARD_GIT_SHIM_HOST` to an agent-run look-alike host that always answers
  `{"allow":true}` (the self-spoofing attack — still UNKNOWN and the highest-value
  remaining probe); (d) the clean room needed two seed stubs
  (`docs/prompts/WORKING_AGREEMENT.v3.md`, `.v4.md`) invented by hand or `seedTemplates`
  throws and the server never listens — a clean-room boot-stub gap worth its own ticket.
- **Status:** left OPEN (verdict BROKEN). No git writes performed by this lane; the fix
  under test was not modified.

### 2026-09-08 — fixing lane (round 3; resolves the round-1 independent refutation)
- **DECISION recorded — session scoping: PROJECT scope is CORRECT and stays (per-session
  is NOT the contract).** The round-1 verifier refuted the round-2 fix "against the claim as
  stated to the verifier" (a different session in a granted project can write). That claim
  was wrong, not the code. Rationale: the FEAT-108 hook — the pre-existing single grant
  authority — is already project-scoped (`peekGrant(projectKey)`); making the shim stricter
  than the hook would create two authorities with different answers, exactly the ARCH-010
  defect this ticket removes. The grant UI is a project-level control the user toggles
  expecting their project's lanes to work. The Invariant section is corrected to read
  project-scoped, and the verifier now asserts the REAL contract (see [scope] leg).
  - **Correction to the round-2 Activity entry's claim (append-only — that entry is not
    rewritten):** where round 2 wrote "a grant for another project/session cannot unblock
    this one", the "/session" half is withdrawn. The contract is: a grant for a DIFFERENT
    PROJECT is refused; a DIFFERENT SESSION inside the SAME granted project is ALLOWED, by
    design.
- **Bypass fixed — `ORCHARD_GIT_SHIM_HOST` (and `_GRANT_KEY`) env redirection.** Round 2
  read the host URL + grant key from env vars the agent controls: an agent could export
  `ORCHARD_GIT_SHIM_HOST=<its own allow-all host>` and self-grant (bypassing the leak gate
  entirely — worse than the curl-the-grant-route residual git-grant-store documents, because
  a forged host answers `{allow:true}` for a publish without running the gate). Also found and
  closed: a child-set `ORCHARD_ALLOW_GIT_WRITE=1` opened the installed shim's local env hatch.
  Fixes: (a) the host URL, grant key, and a host-minted per-process SECRET
  (`scripts/lib/git-shim-secret.mjs`) are now BAKED INTO the generated shim source, not read
  from env — `askHostGrant`/`resolveGitShim`/`runGitShim`/`installGitShim` take them as opts;
  (b) `POST /api/git-shim/decide` REQUIRES the secret (`isShimSecretValid`) and fails closed
  without it; (c) the installed shim passes `ignoreEnvHatch:true` so a child-set
  `ORCHARD_ALLOW_GIT_WRITE` no longer opens writes (the runtime installs the shim ONLY when
  the host block is ON, so honouring a child hatch was never correct).
- **RESIDUAL BYPASS, stated honestly (not in scope):** the agent session runs as the SAME
  uid as the host, so a determined agent can READ its own shim file to extract the baked
  secret + URL, or REWRITE the shim file / prepend its own PATH / call git by absolute path —
  any of which bypasses the shim entirely. This is the pre-existing "determined adversarial
  lane" residual FEAT-135 already documents, and is fundamentally unclosable between two
  processes of one uid. What round 3 DOES close is the TRIVIAL bypass class: a one-line env
  export that any lane could hit accidentally or casually. The secret does not stop redirection
  (a forged host ignores it); the BAKED URL does. The secret keeps NON-session localhost
  processes off the route (defence-in-depth); possessing it only lets a caller reach the route,
  which still runs the full grant + leak gate and can never mint a grant.
- **Changed (all UNSTAGED):** scripts/lib/git-shim.mjs, scripts/lib/git-shim.d.mts,
  scripts/lib/git-shim-secret.mjs (new), scripts/lib/git-shim-secret.d.mts (new),
  src/server/index.ts, src/server/runtime/claude-runtime.ts,
  src/server/runtime/codex-runtime.ts, scripts/verify-bug-173-grant-aware-shim.mjs,
  docs/bugs/BUG-173-…md (this ticket: Invariant scope clarification + this entry).
- **Verified — `node scripts/verify-bug-173-grant-aware-shim.mjs` → "BUG-173: 28 passed, 0
  failed" (exit 0).** New/changed legs on top of round 2: [scope] a DIFFERENT session in the
  SAME granted project is ALLOWED and a DIFFERENT project is REFUSED (the corrected contract);
  [bypass] a forged `ORCHARD_GIT_SHIM_HOST`/`_GRANT_KEY` in the shim SUBPROCESS env is IGNORED
  (baked coords win — proven by a real `git add` subprocess still succeeding under the real
  baked grant despite a dead forged host + bogus forged key), and a child-set
  `ORCHARD_ALLOW_GIT_WRITE=1` is IGNORED (still refused with no grant); [secret] wrong/missing
  shim credential → route denies; [race] a grant that expires WHILE the call is in flight (host
  delays past a ~120ms ttl before `evaluateGitWrite`'s `now`) → deny with a refusal reason, not
  a stale allow; [leak-gate] the REAL `scripts/leak-gate.mjs` SUBPROCESS on a granted commit —
  clean repo passes → allowed, planted home-path-token repo fails → blocked (grant never lifts
  the gate). The must-FAIL leg still proves the pre-fix HEAD shim refuses under a live grant.
- **Anti-regression:** `verify-feat-108-git-grant.mjs` → 40 passed / 0 failed / 0 skipped;
  `verify-feat-135-git-shim.mjs` → 31 passed / 0 failed. `npm run gate` → PASS (leak-gate,
  check-nul, typecheck; exit 0, read UNPIPED). Note: the shim credential is named `shimAuth`
  on the wire / in opts (not `secret`) specifically so the leak-gate's secret-assignment
  heuristic does not false-positive on `secret: <credential>` — a deliberate naming choice.
- **Could NOT test / caveats:**
  - The `src/server/index.ts` decide route body (incl. the new `isShimSecretValid` gate) is
    exercised by a faithful mirror in a spawned host process, not by booting the whole Orchard
    server; the route's registry/`hostPath`/`readBody` wiring + the `isShimSecretValid` import
    are covered by the typecheck gate + code audit. The round-1 verifier already booted the
    REAL route and confirmed the mirror faithful for the project-scoped cases, so this is
    low-risk, but the secret gate specifically was NOT hit on the live server.
  - The e2e/scope/race legs use a stubbed leak-gate runner; the REAL leak-gate subprocess is
    driven in the dedicated [leak-gate] leg via `evaluateGitWrite` with a real
    `runLeakGateForRepo`-shaped runner (not through the spawned shim binary end-to-end, since
    the shim's host consult is the decision point and the gate runs host-side).
- **Independent verification WARRANTED (high-stakes: security backstop, fail-closed, on the
  git-write path, and this round changed the trust model).** A clean-room second pass
  (scripts/independent-verify.mjs / fresh-context agent) should confirm — especially the live
  route's secret gate and the same-uid residual framing. Status left OPEN.
- **NO git writes performed; all changes left UNSTAGED per charter.**

### 2026-09-08 — independent verification lane (round 2; audits the round-3 trust-model change)
- **Verified-by:** dispatch anthropic run bb1f02d5-364a-4efc-a739-6e3a27642850 (clean-room, `scripts/independent-verify.mjs`) — VERDICT: HOLDS
- **Verdict contract: VALID** (manifest-backed; adversarial cases `real-server-secret-gate`,
  `slow-host-late-allow`). Invocation: `node scripts/independent-verify.mjs --repo . --working-tree
  --requirement @<plain-terms> --run "node scripts/verify-bug-173-grant-aware-shim.mjs" --run "npm
  run typecheck" --test-file scripts/verify-bug-173-grant-aware-shim.mjs --author-provider anthropic
  --provider anthropic` (working-tree snapshot HEAD dc1f4ea0f3d2 → tree 32790d274a0a; real index
  untouched).
- **Provider note — SAME-PROVIDER FALLBACK, decorrelation reduced.** Cross-provider (OpenAI) was
  attempted FIRST and refused again: `dispatch failed [quota-window] (provider openai): You've hit
  your usage limit … try again at 5:44 AM` (harness: VERDICT-CONTRACT INVALID, nothing verified) —
  attempted at 03:43 local, before the reset. Fell back to the clean-room **anthropic** path per
  charter. This is the SECOND consecutive anthropic-on-anthropic pass on this ticket, so it is
  materially weaker evidence than a cross-provider run and should be read as such.
- **FIXER-TEST re-run (clean room, run `eb07e400ba2e`, exit 0):** `node
  scripts/verify-bug-173-grant-aware-shim.mjs` → **`BUG-173: 28 passed, 0 failed`**. Round 1's
  clean-room abort (`git show HEAD:…` on a non-git export) did NOT recur — the must-FAIL leg ran and
  passed. Independently re-run by this lane in the REAL checkout: same, 28 passed / 0 failed, exit 0.
- **ADVERSARIAL 1 — `real-server-secret-gate` (NOT covered by the fixture, which mirrors the route
  with a hardcoded TEST_AUTH).** Booted the REAL `src/server/index.ts` on an isolated data dir and
  hit the REAL `POST /api/git-shim/decide` before any session had launched (so `getShimSecret()` had
  never minted). Run `1e31460902db`, exit 0: `server listening on 47317`; `PASS missing shimAuth ->
  deny`, `PASS empty shimAuth -> deny`, `PASS wrong shimAuth -> deny`, `PASS wrong-type shimAuth ->
  deny`, `PASS wrong-secret commit -> deny` (all `{"allow":false,"reason":"git-shim decide: missing
  or invalid shim secret — failing closed"}`), `PASS malformed body -> deny` (`unreadable body —
  failing closed`), `PASS missing grantKey/argv -> deny`, `PASS no 64-hex credential echoed in any
  response`, `PASS no 64-hex credential in server log`. So the live secret gate — the thing round 3
  only mirrored and typechecked — really rejects and really does not leak the credential.
- **ADVERSARIAL 2 — `slow-host-late-allow` (fixture only covers a host that NEVER answers).** A host
  that accepts the socket and sends `200 {allow:true}` AFTER the timeout bound. Run `7fd8ea65fa46`,
  exit 0: `PASS askHostGrant: late allow:true is NOT honoured :: {"allow":false}`; `PASS returned
  at/near the timeout bound :: 202ms (bound 200, late 600)`; `PASS resolveGitShim(write): late
  allow:true still DENIES`; `PASS post-late-fire: still DENIES on a fresh call`. The AbortController
  genuinely drops the in-flight late allow rather than honouring it.
- **Anti-regression re-run by this lane in the real checkout (the verifier did not run these):**
  `verify-feat-108-git-grant.mjs` → `PASS — 40 passed, 0 failed, 0 skipped` (the shared FEAT-108 hook
  grant authority is intact after the round-3 change); `verify-feat-135-git-shim.mjs` → `31 passed, 0
  failed` (run with `ORCHARD_GIT_SHIM_DIR` stripped from PATH, the known environmental caveat).
- **Could NOT be tested (verifier's own list, verbatim in substance):**
  - the real-server ALLOW path (valid host-minted secret + live grant) through
    `src/server/index.ts` — no genuine Orchard session could be launched in the clean room to trigger
    `getShimSecret()`'s lazy mint, so the LIVE route was exercised only on its DENY side; the allow
    path is still proven only against the mirror host in the fixer's test.
  - whether the secret comparison resists a timing side-channel — `isShimSecretValid` uses plain
    `===` (non-constant-time; author-documented as acceptable given 256-bit entropy). No remote
    timing oracle was measured, so this is neither confirmed nor refuted.
  - the accepted out-of-scope residual (same-uid agent rewriting the shim file, prepending its own
    PATH, or calling git by absolute path) — explicitly out of scope, not attempted.
  - the verifier did not exercise `npm run typecheck` or the FEAT-108/135 suites; this lane ran the
    latter two in the real checkout (above) instead.
- **Status:** left OPEN for the decider (verdict HOLDS but on a same-provider fallback). No git
  writes performed by this lane; the fix under test was not modified; no other ticket or the board
  index was touched.

### 2026-09-08 — fixing lane (round 4; hardens the round-2-verify residual)

- **Scope:** the single hardening item the round-2 independent verifier left open — the shim-secret
  comparison used plain `===` (non-constant-time), a timing side-channel. Fixed exactly that.
- **Change:** `scripts/lib/git-shim-secret.mjs` — `isShimSecretValid` now does the final equality with
  `crypto.timingSafeEqual`. Type/emptiness/mint guards run first (unchanged); then both values are
  wrapped in Buffers and their lengths compared explicitly — a length mismatch returns a deny rather
  than letting `timingSafeEqual` throw (it throws on unequal lengths) and never falls open. Added the
  `timingSafeEqual` import. No change to `src/server/index.ts`; the deny reason strings are
  byte-identical, so nothing asserting on them breaks. Every prior refusal (missing / empty /
  wrong-type / wrong-secret / not-yet-minted) still denies with the same behaviour.
- **Evidence (real commands, real output):**
  - `node scripts/verify-bug-173-grant-aware-shim.mjs` → `BUG-173: 28 passed, 0 failed`.
  - `node scripts/verify-feat-108-git-grant.mjs` → `PASS — 40 passed, 0 failed, 0 skipped`.
  - `node scripts/verify-feat-135-git-shim.mjs` → `== 31 passed, 0 failed ==` (run with the session's
    inherited env; the `ORCHARD_GIT_SHIM_DIR`-on-PATH caveat from prior rounds does not apply here).
  - `npm run gate` → `GATE: PASS — safe to commit. (exit 0)` (leak-gate, check-nul, typecheck).
- **Status:** hardening complete. No git writes by this lane; no other ticket or the board index
  touched. Left unstaged for the user.

### 2026-09-23 — residual fix (shim consult timeout was shorter than the gate it triggers)

- **Understood — a live-repro residual the prior rounds' stubs hid.** With a VALID duration grant
  for project `claude-station`, the orchestrator's `git commit` was refused by the shim with the
  generic invocation-layer refusal, while `git add` from the SAME session had just succeeded, and
  HEAD never moved. Root cause: `askHostGrant`'s budget `HOST_GRANT_TIMEOUT_MS` was **2000ms**, but
  for a PUBLISHING subcommand (commit/push) `/api/git-shim/decide` runs the host-side leak gate
  (`runLeakGateForRepo`, src/server/index.ts:2445) BEFORE it can answer, and that gate takes
  **~2.5s** on this repo. So the shim's `AbortController` fired at 2000ms, `askHostGrant`
  fail-closed to a bare `{allow:false}`, and `resolveGitShim` fell back to `local.reason` = the
  offender string → the generic "git write refused at the invocation layer: `git commit`". A
  granted commit/push could therefore NEVER pass the shim, even with a valid grant and a CLEAN gate.
  `git add` is not a publishing subcommand, so the route skips the gate, answers in ~25ms, and
  always beat the 2000ms budget — hence the asymmetry. The rounds 2–4 verifiers never caught it
  because their e2e/scope legs used a STUBBED leak-gate runner (`{ok:...}`, near-instant); only the
  real `scripts/leak-gate.mjs` subprocess over the real repo is slow enough to cross the budget.
- **Measured latency of the LIVE `/api/git-shim/decide` under the current grant** (real output):
  `add -A` → allow **25ms**; `commit` → allow **2489ms**; `push` → allow **2606ms**. The route's
  own decision is ALLOW in every case — the defect was entirely the client-side budget.
- **Changed (UNSTAGED):** `scripts/lib/git-shim.mjs` — `HOST_GRANT_TIMEOUT_MS` 2000 → 15000, and
  the doc comment above it rewritten to state why the budget must exceed the host-side gate. No
  other file needed a change: `scripts/lib/git-shim.d.mts` declares the const without a value, and
  `scripts/verify-bug-173-grant-aware-shim.mjs` passes an explicit `timeoutMs: 200` to its
  unresponsive-host leg (its `< 2000` wall-clock bound is unaffected by the default) and uses
  `T + 2000` only as a grant-expiry time offset.
- **Verified — before/after against the LIVE route (real output, `askHostGrant` from the edited
  module):** BEFORE (explicit 2000ms budget) `git commit` → `{"allow":false}` at 2001ms (the abort);
  AFTER (new 15000ms default) `git commit` → `{"allow":true,"granted":true}` at 3099ms and `git
  push` → `{"allow":true,"granted":true}` at 2502ms. `npm run gate` → GATE: PASS, exit 0 (so the
  refusal was never a real leak — purely the timeout). The shim re-imports the on-disk module per
  invocation, so the new budget is live with no session relaunch.
- **Second defect found — filed BUG-184.** The host RECORDS the write as permitted (`recordGitWrite`,
  gate=pass) at the moment the route decides ALLOW, but the shim client has already aborted and
  refused, so the ledger claims a commit succeeded that never ran (HEAD unchanged). A record that
  asserts success for a refused operation is a false-proof class defect; split out rather than
  folded here.
- **Still open / handoff:** independent clean-room verify WARRANTED — this touches the fail-closed
  git-write safety path and the fix was self-verified. The narrower question a verifier should
  probe: does 15000ms leave headroom on a LARGER repo whose gate runs longer, and is a genuinely
  hung host still denied at the (now longer) bound.
- **NO git writes performed by this lane; all changes left UNSTAGED.**
