```orchard-ticket
{
  "id": "BUG-242",
  "type": "bug",
  "title": "Git writes fail after a session outlives a server restart",
  "summary": "A direct session whose CLI survives a server restart can never do a git write again, even after the user re-grants: every commit or push is refused with a missing-or-invalid-shim-secret failure. Relaunching the session is the only cure.",
  "impact_if_we_wait": "Restart survival (FEAT-015) exists so an in-flight session keeps working across a deploy, but git-write authorization silently does not survive it. After any service restart the user must throw away and relaunch every long-running session before it can commit, and the refusal names no cause.",
  "current_need": "Re-bake surviving sessions' git shims with the freshly-minted secret at boot-time adoption, keeping the secret memory-only, so a re-granted write succeeds post-restart.",
  "severity": "medium",
  "area": "agent git-write enforcement / restart survival",
  "reported": "2026-10-07",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-10-07",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A direct session that survives a restart can do a git write once a grant exists, no relaunch, secret never on disk.",
    "The fix holds when ensure() fires on post-restart Bash calls: the surviving shim learns the new secret instead of reverting.",
    "A stale-secret refusal names the cause (server restarted; secret stale) where the shim can tell, not the generic message.",
    "A synthesized pre-fix must-FAIL repro reddens pre-fix and passes after, on a scratch server with real restart and post-restart Bash."
  ],
  "code_refs": [],
  "related": [
    {
      "id": "ARCH-012",
      "relation": "see_also"
    },
    {
      "id": "BUG-173",
      "relation": "see_also"
    },
    {
      "id": "FEAT-015",
      "relation": "see_also"
    },
    {
      "id": "FEAT-108",
      "relation": "see_also"
    },
    {
      "id": "FEAT-135",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [
    "ARCH-012"
  ],
  "verification": [
    {
      "provider": "anthropic",
      "model": "claude-opus-4-8",
      "run_id": "93ff397d-ec91-448d-a90d-51e950197e95",
      "verdict": "holds",
      "verdict_on": "2026-10-07",
      "recorded_at": "2026-10-07T23:16:22.948Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs"
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

# BUG-242 — Git writes fail after a session outlives a server restart

## Symptom
After the claude-station service restarts, a direct session that survived the restart (its CLI kept running in its own systemd scope, re-adopted by the new server) can no longer perform ANY git write through the invocation-layer shim. Every classified write is refused with the route's missing-or-invalid-shim-secret, failing-closed reason, even when the user mints a fresh runtime grant. Only relaunching the session restores git writes.

## Repro
1. Launch a direct session with the git-write block on; it gets a git shim with the host secret baked into its source (scripts/lib/git-shim.mjs shimSource/installGitShim via getShimSecret()).
2. Restart the server. The new host process mints a FRESH secret (scripts/lib/git-shim-secret.mjs randomBytes(32), memory-only, re-minted per boot).
3. The new server re-adopts the surviving broker (src/server/survival.ts attachSurvivable, from index.ts adoptSurvivingHosts); it spawns NOTHING, so the CLI keeps its OLD shim with the OLD baked secret.
4. User mints a git-write grant and asks the session to commit.
5. The shim POSTs /api/git-shim/decide with the stale baked secret; the route calls isShimSecretValid() which fails (secret rotated), returning allow:false with the generic failing-closed reason (src/server/index.ts ~2871). Refused for the life of the session.

## Expected
A session that survives a server restart keeps working git-shim auth without the secret ever being persisted to disk (memory-only preserved). A write succeeds after restart once a grant exists. A stale-secret refusal, where the shim can tell, names the cause (server restarted; secret stale) rather than the generic message.

## Decision: the dropped runtime grant
Runtime grants are memory-only BY DESIGN and deliberately dropped on restart (scripts/lib/git-grant-store.mjs header: fail-closed; losing a grant is accepted, a silent standing permission is the hazard). Restoring grants is therefore OUT OF SCOPE (the task rule: in scope only if grants are already meant to survive, and they are not). Post-restart disposition: the user re-grants; this ticket only ensures the re-granted write reaches the re-baked shim.

## Context pack (grows; the where-to-look)
- Files/functions in play: scripts/lib/git-shim-secret.mjs (getShimSecret, memory-only, re-minted per boot); scripts/lib/git-shim.mjs (shimSource/installGitShim/ensureGitShim bake the secret at launch); src/server/runtime/claude-runtime.ts ~950 and src/server/runtime/codex-runtime.ts ~430 (install at launch); src/server/index.ts ~2848 git-shim decide route (refuses stale secret) and ~5884 adoptSurvivingHosts (re-adopt, spawns nothing); src/server/survival.ts (attachSurvivable, spawnSurvivable, HostStatus); src/server/session-host.mjs (broker writeStatus).
- Same class as ARCH-012: a rotating secret goes stale invisibly; nothing errors loudly enough to point at the restart.
- Container sessions: container-internal git is NOT shimmed (shim dir is a host temp path absent from the container FS), so the host secret does not gate container-internal git; this bug is DIRECT sessions only.
- Repro test: add scripts/verify-bug-242 (synthesized pre-fix must-FAIL, isolated scratch server).
- Verification-class: plan+review.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-07 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-08 — fixing lane (plan+review, round 1)
- **Understood (confirmed by code):** On a service restart (NOT a machine reboot, so the shim dir under os.tmpdir() survives), a direct session is handed off (closeAllSessions handoff) and its CLI keeps running with PATH pointing at its OLD shim dir D1 (old secret S1 baked in the file). The new server mints a fresh secret S2 (git-shim-secret.mjs, memory-only). Boot adoption (index.ts adoptSurvivingHosts -> adoptSession) builds a new AgentSession that calls `#runtime.start({ attach: true })` (agent-bridge.ts ~1847). start() calls installGitShim which mints a BRAND-NEW dir D2 with S2 and a handle H2 whose PreToolUse `ensure()` maintains D2. The surviving CLI never looks at D2 — it execs git from D1 (S1). The decide route (index.ts ~2871) rejects S1 as invalid -> git writes refused for the life of the session. ensure() does NOT heal D1 because H2 points at D2.
- **Coordinator-proven hazard folded in:** a live handle whose captured shim `source` holds a dead secret reverts any re-bake when its `ensure()` fires on a Bash tool call (reproduced with real installGitShim/ensure(), restored:true). So "server re-bakes D1 once at adoption" is fragile under any design where an ensure() targets D1 with a stale captured source. The fix must make the in-memory source learn the current secret, and the restart test must run Bash-tool calls after restart so ensure() fires.
- **Plan (design):**
  1. PERSIST the surviving shim dir. The broker (session-host.mjs) echoes `gitShimDir: process.env.ORCHARD_GIT_SHIM_DIR ?? null` into every status write; add `gitShimDir?: string|null` to HostStatus (survival.ts). The broker already carries that env (installGitShim set it on the session env that flows to the broker).
  2. SECRET RECOMPUTED AT WRITE-TIME, ONE PLACE. Change git-shim.mjs so the baked `shimAuth` may be a provider function; shimSource/installGitShim/ensureGitShim resolve it at the moment they WRITE the file. The runtime passes `getShimSecret` (the function). ensureGitShim rebuilds `source` from the current secret each call instead of rewriting a captured string, so ensure() always writes the CURRENT secret and SELF-HEALS rather than reverting (directly answers the coordinator). Secret stays memory-only; only the written file holds a resolved literal.
  3. REUSE THE SURVIVING DIR ON ADOPT. Thread `adoptShimDir` (= st.gitShimDir) through RuntimeStartConfig -> claude-runtime (and codex if it adopts) -> installGitShim({ reuseDir }). On reuse, installGitShim does NOT mkdtemp; it writes the `git` file into D1 with the CURRENT secret, preserving the non-secret baked coords (realGit/hostUrl/grantKey/windowKey) by reading them from the existing D1 shim file (safe fallbacks: recompute hostUrl/realGit, grantKey from config, windowKey optional). The handle then points at D1, so the adopting server's PreToolUse ensure() keeps the dir the CLI actually uses fresh. D1 is validated with ensureGitShim's existing unsafeDir checks; a vanished D1 is recreated at the same path (closes the BUG-230 fall-through-to-real-git hole for survivors too). This removes the wasted D2.
  4. EXPLICIT STALE MESSAGE where the shim can tell. Bake a per-boot nonce (minted with the secret, memory-only) into the shim and send it in the /decide body; when the secret is invalid AND the presented nonce differs from the current boot nonce, the route returns "server restarted; secret stale — the session's shim re-bakes on its next tool call" instead of the generic failing-closed reason. With (2)+(3) the stale path is nearly unreachable (ensure heals before git runs), so this covers the residual window honestly.
  5. GRANT: dropped by design, out of scope (see Decision section). The fix only guarantees a re-granted write authenticates.
- **Feasibility (the STOP check):** FEASIBLE for direct sessions — the server runs on the host and can write D1 (a host tmp path); the dir path is knowable via (1). Container sessions do NOT shim container-internal git (dir is a host path absent in the container FS), so the secret never gates their container git; they are out of scope for this fix, not a blocker. No STOP condition hit.
- **Still open / handoff:** plan goes to cross-provider (openai) review next ("find what breaks this plan"); findings to be addressed before building. Then build + a real restart demo on an isolated scratch server with post-restart Bash-tool calls (so ensure() fires), plus a synthesized pre-fix must-FAIL.

### 2026-10-08 — plan review (fresh Claude reviewer) + revised design
- **Review verdict:** plan sound in direction; 1 BLOCKER + 4 MAJOR findings addressed below. (OpenAI review abandoned: provider quota window; reviewed by an independent fresh-context Claude agent per coordinator instruction.)
- **#1 [BLOCKER] windowKey must be SHARED between the reused shim and the adopting runtime's PreToolUse hook.** The hook mints a fresh windowKey W2 every start() (claude-runtime ~950) and opens its decision window under W2. If the shim presents a DIFFERENT key (e.g. W1 read from D1, or none), every post-restart git write falls to redeemGitWrite's independent() path (a second claimGrant + a second full leak gate), defeating BUG-231's one-decision-per-Bash and risking a once-grant being double-consumed -> a legitimate granted commit still refused. FIX: do NOT read windowKey from D1; mint ONE fresh key, bake it into the reused shim AND use it as the runtime #gitWindowKey. This REQUIRES the re-bake to happen inside start() via installGitShim({reuseDir}) (only the runtime knows the hook's key), so a standalone boot-pass re-bake is rejected.
- **#2 [MAJOR] Recompute ALL coords server-side; read NOTHING from the D1 file.** grantKey=project.id, hostUrl=127.0.0.1:PORT, realGit=resolveRealGit(env) are all independently known in the adopting process. Reading baked coords out of the same-uid-writable D1 file would let a lane that tampered D1's hostUrl before restart have the server re-bake the attacker value (redirect the grant consult to an allow-all look-alike -> self-grant/leak-gate bypass), reopening BUG-173 round 3.
- **#3 [MAJOR] Atomic rewrite.** ensureGitShim does rmSync(git) then writeFileSync — a window where D1/git is ABSENT, so a concurrent lane's git resolves past the empty dir to the REAL ungated binary. After a restart the first ensure() ALWAYS rewrites, so the plan guarantees the window fires on a live multi-lane CLI. FIX: write a temp file in the same dir and rename() over git (atomic same-fs); never leave the path absent.
- **#4 [MAJOR, residual-documented] The protected in-flight turn is NOT healed.** ensure() only fires on the NEXT PreToolUse; a Bash call already executing across the restart (its PreToolUse ran under the dead server), and the window between attach-connect and SDK re-initialize re-registering hooks, exec git against D1/S1 with no fresh ensure() -> refused. Not worse than status quo (broken forever), but must be documented + a truncated/mid-turn fixture must exercise "git write issued before the first post-adoption PreToolUse."
- **#5 [MAJOR] Resolve the secret LITERAL before JSON.stringify.** shimSource bakes coords via JSON.stringify; a function passed unresolved is silently dropped -> baked shimAuth absent -> every write fails closed silently. FIX: shimSource resolves `typeof shimAuth==='function'?shimAuth():shimAuth` before stringify; a test asserts the D1 file contains a 64-hex secret.
- **#6/#7/#8 [MINOR]** recompute-source-each-ensure is defense-in-depth (secret is immutable per process); the ensure refactor must capture ALL coords so the recomputed source matches (no churn). gitShimDir is a tmp path in a 0600 status file — keep it OUT of any outward-facing serialization. The per-boot nonce for the stale message must be evaluated strictly AFTER isShimSecretValid fails closed and never short-circuit it.
- **REVISED DESIGN (what I will build):**
  - git-shim.mjs: shimSource resolves secret literal before stringify (#5). New atomic same-dir temp+rename writer used by install and ensure (#3). installGitShim gains `reuseDir`: validates the dir with the existing unsafeDir checks, recreates it if vanished, writes the git file fresh with server-recomputed coords + current secret + the passed windowKey, reads NOTHING from the file (#2). ensure() recomputes its source from a provider thunk capturing all coords (#6). `shimAuth` may be a string or a provider function (getShimSecret).
  - git-shim-secret.mjs: add a memory-only per-boot nonce getShimBootId() minted with the secret.
  - runtime.ts: RuntimeStartConfig gains `adoptShimDir?: string|null`.
  - claude-runtime.ts: on adopt pass reuseDir=adoptShimDir; pass shimAuth=getShimSecret (function) and the same gitWindowKey into the reused shim so the hook and shim share one key (#1). Bake shimBootId.
  - codex-runtime.ts: pass shimAuth=getShimSecret (function) for the recompute property; no adopt (codex persistedTranscript:false).
  - agent-bridge.ts: thread adoptShimDir=opts.adopt?.st.gitShimDir into start().
  - survival.ts: HostStatus gains gitShimDir?:string|null. session-host.mjs: echo gitShimDir:process.env.ORCHARD_GIT_SHIM_DIR into every status write (broker inherits that env). Keep it out of outward payloads.
  - index.ts decide route: after isShimSecretValid fails, if a presented shimBootId differs from the current getShimBootId(), return "server restarted; secret stale — the session's shim re-bakes on its next tool call" (#4 message; strictly downstream of fail-closed).
- **Independent clean-room verify warranted** (session-lifecycle + leak-gate-adjacent; BUG-173/230/231 regression history).

### 2026-10-08 — fixing lane (build + verify), round 1
- **Changed (all unstaged; the user commits):**
  - scripts/lib/git-shim-secret.mjs — added getShimBootId() (memory-only per-boot nonce) + _setShimBootIdForTest().
  - scripts/lib/git-shim-secret.d.mts, scripts/lib/git-shim.d.mts — declarations for the new/changed signatures.
  - scripts/lib/git-shim.mjs — shimSource resolves a provider shimAuth/shimBootId to a LITERAL before JSON.stringify (#5); new writeShimFileAtomic (temp+rename, never-absent — #3) + shared unsafeShimDir; installGitShim gains reuseDir (re-bake an existing dir in place, recompute coords, read NOTHING from the file — #2) and takes provider functions; ensureGitShim recomputes source each call (self-heal, no churn — #6) and writes atomically; shimBootId threaded through runGitShim/resolveGitShim/askHostGrant into the decide body.
  - src/server/runtime/runtime.ts — RuntimeStartConfig.adoptShimDir.
  - src/server/runtime/claude-runtime.ts — on adopt pass reuseDir=adoptShimDir; pass getShimSecret/getShimBootId as FUNCTIONS; the reused shim bakes the SAME gitWindowKey the PreToolUse hook opens its window under (#1).
  - src/server/runtime/codex-runtime.ts — pass the provider functions (codex never adopted: persistedTranscript:false).
  - src/server/agent-bridge.ts — thread adoptShimDir=opts.adopt?.st.gitShimDir into start().
  - src/server/survival.ts — HostStatus.gitShimDir (kept out of outward serialization — #7).
  - src/server/session-host.mjs — broker echoes gitShimDir:process.env.ORCHARD_GIT_SHIM_DIR into every status write.
  - src/server/index.ts — decide route: after isShimSecretValid fails (fail-closed FIRST), a presented shimBootId != current getShimBootId() yields the explicit "server restarted; secret stale" message (#4/#8).
  - scripts/verify-bug-242-restart-secret-rebake.mjs (new) + scripts/fixtures/bug-242/pre-git-shim.mjs (pinned pre-fix baseline, import rewritten).
- **Verified (this fixer's own run, necessary not sufficient):**
  - `node scripts/verify-bug-242-restart-secret-rebake.mjs` → **21 passed, 0 failed**. Legs: [unit] reuseDir re-bakes the SAME dir to the new secret; baked file carries a 64-hex literal + passed windowKey + bootId; self-healing ensure() (restored on rotation, no-op when unchanged); tampered-file hostUrl NOT read back (recomputed); atomic (no stray temp); unsafe reuse dir refused. [must-FAIL] the PINNED pre-fix shim REVERTS an external re-bake when ensure() fires (the coordinator-proven hazard) and has no reuseDir — reddens exactly as predicted. [e2e] TWO real host processes = a genuine restart (independent per-boot getShimSecret): a real subprocess `git add` via the installed shim is ALLOWED against server A; after A exits and B boots, WITHOUT the adopt re-bake it is REFUSED by B with the explicit stale-secret message; WITH the adopt re-bake (real installGitShim reuseDir, as claude-runtime does) it is ALLOWED again, no relaunch.
  - Anti-regression (run with the ambient session shim stripped from PATH, a BUG-240 test-setup artifact, not a code change): verify-feat-135-git-shim 31/0, verify-bug-173-grant-aware-shim 28/0, verify-bug-230-fifo-special-file 14/0, verify-bug-230-nested-shim-ownership 23/0, verify-bug-184-ledger-truthful-outcome 28/0, verify-bug-240-temp-index 8/8, verify-bug-231-call-claims 21/0, verify-bug-231-one-decision 50/0, verify-feat-164-self-grant 21/0 (its exit 2 = 12 pre-existing self-grant holes awaiting the FEAT-164 fork, 0 failed — unchanged).
  - `npm run gate` → **PASS (exit 0)** (leak-gate + check-nul + typecheck).
- **Residual, stated honestly (#4):** ensure() heals on the NEXT PreToolUse Bash call. A git write ALREADY executing across the restart (its PreToolUse ran under the dead server), and the brief window between attach-connect and the SDK re-initialize re-registering hooks, still exec git against the stale shim and are refused — i.e. the very in-flight turn survival protects is not healed, only the next tool call onward. Not worse than status quo (which stayed broken for the session's life); the user re-grants and the next call works. The decide route now NAMES this (stale-secret message). A truncated/mid-turn fixture for "git issued before the first post-adoption PreToolUse" is the follow-up test if this residual is to be closed.
- **Grant disposition:** unchanged/out of scope — runtime grants are memory-only by design (git-grant-store.mjs) and dropped on restart; the user re-grants, and this fix guarantees the re-granted write authenticates.
- **Independent clean-room verify WARRANTED** (session-lifecycle + leak-gate-adjacent; BUG-173/230/231 regression history). Exact command for the verifier: `node scripts/verify-bug-242-restart-secret-rebake.mjs` (pinned pre-fix fixture is in-repo; no env needed). Suggested requirement to attack: that a session surviving a real server restart authenticates a git write WITHOUT the secret ever touching disk, that the reused shim is re-baked atomically and never reverted by ensure(), and that no coord is read from the same-uid-writable shim file.
- **Symptom of a deeper design flaw?** yes — it is another instance of ARCH-012 (a rotating secret goes stale invisibly); filed as recurrence_evidence on ARCH-012's class rather than a new ARCH ticket (the class already exists). Not closing the ticket here (awaits independent verify).

### 2026-10-07 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-4-8 run 93ff397d-ec91-448d-a90d-51e950197e95 — VERDICT: HOLDS. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-07 — independent clean-room verify (verify lane, round 1)
- **VERDICT: HOLDS** — VALID, manifest-backed (scripts/independent-verify.mjs, verdict-contract VALID). Provider anthropic/claude-opus-4-8 (OpenAI quota-blocked, so same-provider — decorrelation reduced, noted). Dispatch run `93ff397d-ec91-448d-a90d-51e950197e95`.
- **Clean-room input (decorrelated):** only the plain requirement (survive-restart re-auth with new per-boot secret, incl. after further Bash calls) + the diff of BUG-242's 13 handoff files overlaid on HEAD + the fixer's test code. No Activity log / rationale / self-assessment. Diff scoped via a dangling `HEAD..<sha>` commit (11 source + 2 test files; the other 30 dirty working-tree files from concurrent lanes were NOT shown). Room stripped `docs`; 13/13 paths predicate-cleared.
- **Executed evidence (all through the room's recorder):**
  - FIXER TEST re-run: `node scripts/verify-bug-242-restart-secret-rebake.mjs` → exit 0, **21 passed / 0 failed** (run 5e2b68fafb92).
  - P1 (restart survival) + P2 (no auth weakening) + P3 (memory-only): adversarial `adv/multi.mjs` → exit 0 (run 8aa6f29f1cae). TWO restarts in a row each re-bake the new boot secret; 8 no-op ensure() calls (no churn) + rotations 4/5/6 each self-heal; empty/null/undefined/short/long/forged-other-session secrets all REFUSED (fail-closed, never-minted refuses everything); secret on disk ONLY in the shim `git` file.
  - P1/P4 (real multi-restart e2e): adversarial `adv/e2e2.mjs` → exit 0 (run ea98d3b30c9f). THREE real host processes, two restarts in a row: real `git add` ALLOWED pre-restart, REFUSED-as-stale before each adopt, ALLOWED after each adopt re-bake, and repeated adds stay ALLOWED after the 2nd adopt.
- **Per property:** P1 HOLDS, P2 HOLDS, P3 HOLDS, P4 HOLDS. No break found; two-break STOP not triggered.
- **Could-not-test (verifier's own list):** (1) the TypeScript adoption path (config.attach/adoptShimDir through the real claude-runtime) was modeled via the lib modules, not driven through a live server. (2) Cross-version UPGRADE-restart: a session launched by a PRE-fix session-host.mjs (which does not echo gitShimDir) then adopted by the fixed server → `reuseDir` undefined → a fresh dir minted while the surviving CLI's PATH keeps the dead-secret dir. Reproducible only at the library primitive; author documents it as an inherent one-time upgrade-boundary limitation, and it is unreachable for any session launched under the fixed code. (3) Container/codex live runtime not exercised (codex never adopts across a restart by design: persistedTranscript:false).
- **Note:** verdict recorded via `board-tool.mjs verified` (independently_verified:true). Kept clean room + run manifests under `~/.local/state/claude-station/scratch/` (cleanroom-verify-EaKYMk; records in cleanroom-record-iew8Xv/manifest.jsonl).

### 2026-10-11 — landed in batch commit (orchestrator triage)
- Work landed in the 2026-10-11 whole-tree batch commit. Verified state unchanged; this entry records only the git landing. Full batch manifest is in the commit message.
