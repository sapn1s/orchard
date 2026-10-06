```orchard-ticket
{
  "id": "BUG-231",
  "type": "bug",
  "title": "A Bash git write is decided twice: by hook and shim",
  "summary": "In a direct session the PreToolUse hook decides a Bash git write, and each git call inside it is decided again by the shim through /api/git-shim/decide. The hook spends a once-grant, so the shim then refuses the write. Under a timed or permanent grant the leak gate runs twice, and the hook leaves an unconfirmed pending record.",
  "impact_if_we_wait": "A one-off ('once') grant cannot make a git write through Bash in a direct session. Every granted write runs the leak gate twice, and the audit trail carries a phantom pending record for each Bash command.",
  "current_need": "A decision on which layer spends the grant for one Bash command, and what 'once' means (one Bash command or one git invocation). Then wire both layers through the single claim authority (claimGrant/settleClaim, FEAT-164 r3).",
  "severity": "medium",
  "area": "agent git-write grant",
  "reported": "2026-10-05",
  "reported_by": "agent",
  "owner": "agent",
  "work_state": "in_verification",
  "human_action": "none",
  "updated": "2026-10-05",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "One Bash git write under any grant produces exactly one grant decision and one ledger record.",
    "A once-grant lets exactly one Bash git write through in a direct session, and the same holds in a container session.",
    "A granted commit still runs the leak gate at least once, including one made with an absolute-path git."
  ],
  "code_refs": [
    {
      "path": "src/server/runtime/claude-runtime.ts"
    },
    {
      "path": "src/server/index.ts"
    },
    {
      "path": "scripts/lib/git-shim.mjs"
    },
    {
      "path": "scripts/lib/git-grant.mjs"
    }
  ],
  "related": [
    {
      "id": "FEAT-164",
      "relation": "see_also"
    },
    {
      "id": "BUG-173",
      "relation": "see_also"
    },
    {
      "id": "BUG-184",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "openai",
      "model": "default",
      "run_id": "01a10ca5-0fb3-7032-a8c0-5374865424e8",
      "verdict": "broken",
      "verdict_on": "2026-10-05",
      "recorded_at": "2026-10-05T15:22:43.146Z",
      "author": "independent-verify",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Property (4) breaks via a NEW route: in redeemGitWrite, after revokeGitWrite succeeds and grantView=null, the still-open call window authorizes the next commit; closing it fails the write. STOP rule: single-authority redesign. Fixers 30/30 (67f6e57252e2); probe df41562628f9 exit1."
    },
    {
      "provider": "openai",
      "model": "default",
      "run_id": "01a10cb9-ec2b-7b82-b07f-52409dd7df87",
      "verdict": "invalid",
      "verdict_on": "2026-10-05",
      "recorded_at": "2026-10-05T15:45:59.418Z",
      "author": "independent-verify",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Contract INVALID (fixer-test citation rejected; exit3). Substance: probe cac43c8795dd exit1 = a hidden out-of-command add verb takes the independent path, spends a fresh once-grant while the commit window is correctly withdrawn = DOCUMENTED ACCEPTED RESIDUAL, not a new break. Detail in Activity log."
    },
    {
      "provider": "openai",
      "model": "default",
      "run_id": "01a10ddd-5061-7312-8ae2-3b4e14cdea82",
      "verdict": "invalid",
      "verdict_on": "2026-10-05",
      "recorded_at": "2026-10-05T21:05:51.938Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Contract-VALID BROKEN but the sole finding is the documented once=one-Bash-call semantics (one grant covers every write written out in one command), NOT a break. Repro: a 2nd SEPARATE call is denied; a replacement spent once by the next call. Charter mis-stated property 4 as one write. See log."
    },
    {
      "provider": "openai",
      "model": "default",
      "run_id": "01a10df8-9157-76b0-8c9b-bd5fb2cd70d9",
      "verdict": "broken",
      "verdict_on": "2026-10-05",
      "recorded_at": "2026-10-05T21:35:16.205Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Property 5 BREAKS at CLAIM_MAX_MS: a revoked call outliving 5min has its withdrawn window reaped (git-grant.mjs:240); its next written-out commit decides afresh, eats a mid-call regrant, commits, DENIES a new call. Probe ed70bc971ca6 exit1; fixers 27/0. 2nd finding=round-3 mis-oracle. See log."
    },
    {
      "provider": "openai",
      "model": "default",
      "run_id": "01a10e18-6f39-7c63-b1e8-3b35038aec21",
      "verdict": "broken",
      "verdict_on": "2026-10-05",
      "recorded_at": "2026-10-05T22:08:14.497Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "BROKEN (VALID, manifest 6 runs). Fixer cc28db7f3e3c exit0 19/0. Two breaks, STOP. P5: initially-DENIED call id left 'unknown', no tombstone; reused id steals a fresh once-grant (7f57e10c4704). P8: fingerprint skip bypasses now-failing gate on identical 2nd write (af310f923a95). See log."
    }
  ],
  "verification_class": "plan+review",
  "body_slots": {
    "Diagnosis": false,
    "Evidence": true,
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

# BUG-231 — A Bash git write is decided twice: by hook and shim

## Symptom

Found by the FEAT-164 round-3 plan review (an anthropic dispatch, read-only) and confirmed against the real host audit log `git-write-audit.jsonl` under the data dir.

On 2026-09-25 at 16:53:30.456Z, the hook recorded `w1-93fc2b16ddc2` (`git add … && git commit`, duration grant, outcome `permitted`, never confirmed). 78 ms later the shim recorded `w2` (`git add`, executed) and `w3` (`git commit`, gate pass, executed) for the same Bash command. The same pattern appears on 2026-09-28 at 20:23:09 (`w7` hook, then `w8` shim). That is two decisions for one write. With a once-grant, the hook's decision spends it and the shim's decision then refuses.

## Evidence

- The hook path is claude-runtime.ts, PreToolUse: `evaluateGitWrite({ command, … })`.
- The shim path is /api/git-shim/decide in index.ts: `evaluateGitWrite({ argv, … })`.
- In a direct session the shim dir is first on PATH for the Bash tool (checked in a lane: `process.env.PATH` begins with `/tmp/orchard-git-shim-*`).
- Containers are not shimmed, so there the hook is the only layer.

## Options (not chosen)

- (a) The shim is the only authority for shimmed git, and the hook only refuses forms the shim cannot see, such as an absolute-path git. The cost: an absolute-path `git commit` under an active grant loses the hook's pre-exec leak gate unless the hook still gates.
- (b) The hook's claim stays open for the duration of the Bash command and is bound to the session. The shim's decide redeems it instead of claiming again, and PostToolUse settles it. This keeps one decision per Bash command, but it needs session binding and a lifetime.
- (c) Define 'once' as one git invocation. The hook stops spending, and its check becomes advisory.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-05 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-05 — worker (fixing r1)
- **Note:** **BUG-231 fixing r1 (plan+review, option b decided by the orchestrator). Built; verified; independent clean-room verify warranted (SECURITY / regression-prone grant layer).**
  - **Hypothesis CONFIRMED first** on an isolated scratch server with a pinned pre-change tree (real hook, real shim, real leak gate): once-grant → hook spends, shim refuses `git add` (exit 1, 0 commits); duration → leak gate runs twice; hook record left 'permitted' forever. Same pattern as the real audit log (w1 hook, w2/w3 shim, 2026-09-25).
  - **Design (one Bash call = one decision):** the hook's claimGrant decision becomes a per-tool-call WINDOW (scripts/lib/git-grant.mjs), bound by a per-session random key baked into the shim (git-shim.mjs `windowKey`) and the CLI's tool_use_id. The shim's /api/git-shim/decide REDEEMS a matching window instead of deciding again (`redeemGitWrite`); no key or no matching window → the old independent claimGrant path (Codex, subprocess git with no git text, background jobs).
      - **'once' = one foreground Bash call**, covering the git writes written out in it: a window has SLOTS (multiset of bare-`git` write verbs from the command); each redeem consumes one; out of slots → independent decision.
      - **Spend:** reserved at the hook when every write provably reaches the shim (`gitWritesReachShim`, conservative) AND the shim has already observed each verb in this session; first redeem spends; a call that never reached git releases at its end. Otherwise the hook spends, as before.
      - **Gate:** the hook ALWAYS gates a publish before it runs (as before). It records a content fingerprint (HEAD + path:blob of index and changed worktree, `repoContentFingerprint`, leak-gate-host.ts); the shim re-gates at the write only if the content changed since. Result: one gate for the usual `git add && git commit` of files already written; a leak the command itself creates is still caught at the commit.
      - **Settlement:** PostToolUse / PostToolUseFailure / PermissionDenied (new hooks), canUseTool deny, a later deny inside our own hook (file lock / profile), SubagentStop (that agent's windows), the agent's next tool call (supersession), turn end (`result`), runtime close, and lapse at CLAIM_MAX_MS.
      - Records gain an additive `decision` field: every record of one Bash call names one decision. The first redeem confirms the hook's own record, so no phantom pending record.
      - Container sessions: `gitShimReachesCli` is declared by agent-bridge (direct only), so the hook decides, gates and spends, as before.
  - **Reviews:** plan review, anthropic (`ea104f47-7c7a-4d04-baff-1ad29ecfcf5c`) → SOUND-WITH-CHANGES. Folded in: slots instead of 'only Bash in flight'; per-verb reach proof. Its updatedInput-nonce alternative was rejected: it needs permissionDecision allow, which bypasses the user's permission rules. Build review, cross-provider openai (`01a10c96-99a2-7e42-8a54-20506886b0ae`) → BROKEN on the first build, with three executed probes, all fixed:
      - F1: a user shell function routing a publish around the shim got no gate. The hook now always gates, and the shim skips only unchanged content.
      - F2: an absolute-path write left a slot a background process could use. Slots now exist only for bare-`git` heads.
      - F3: an orphaned subagent window. SubagentStop now ends it.
      - Not re-reviewed after these fixes.
  - **Verified:** `node scripts/verify-bug-231-one-decision.mjs` (new). The e2e uses a scratch server, a throwaway repo and a fake CLI around the REAL hook/shim/gate, with gate runs counted by a NODE_OPTIONS preload. The unit section runs pinned pre-change bytes, the current code, and mutants.
      - Current tree: e2e 21/21; unit 23/23.
      - **Must-FAIL:**
          - Pinned pre-change tree: e2e 6 pass / 15 FAIL (once refused, gate ×2, pending record, once wasted on a denied or never-run call).
          - Pinned pre-change bytes (scripts/fixtures/bug-231/pre-git-grant{,-store}.mjs, sha256 10ed56e1…/370adddf…): U1–U3 reproduce all three symptoms.
          - Orphan: a mutant tree with window ending disabled FAILs S5/S6/S6b/S7/S8/S10 (S6b = an orphan's unused slot grants a later outside write). The no-lapse mutant FAILs U6; the no-slot-consume mutant FAILs U5.
      - The e2e runs from `--root=<tree>`, so the pinned tree is reusable.
  - **Anti-regressions (after final edits):**
      - feat-164-single-authority 30/0, feat-164-permanent 41/0, feat-164-self-grant 21/0 (12 holes open, unchanged)
      - feat-108-git-grant 66/0, feat-108-git-write-block 241/0, feat-135-git-shim 31/0
      - bug-173 28/0, bug-184 28/0, bug-230 23/0
      - Run earlier with the same runtime wrapper: feat-135-active-e2e 8/0, bug-187 104/104. These were not re-run after the round-2 SubagentStop/fingerprint edits.
      - feat-135-codex-active-e2e not run (real model, quota; codex files untouched).
      - `npm run gate` exit 0.
      - Disclosure: this session's shim was restored mid-lane. From then on it refused the scratch `git init` in feat-135-git-shim / feat-108 suites, so those three ran with only the invoker's shim dir dropped from their PATH; their writes go to their own /tmp scratch repos only.
  - **Side item (FEAT-164 self-grant suite):** it leaked its survival-mode session-host scope every run. Reproduced: `claude-station-host-t-muv6ums4-n2h3dt` still alive after a run, broker + fake CLI naming the run's deleted dir. I stopped it by pid. Fix: `reapOwnHosts()` ends only the hosts recorded in the run's own data dir, each pid checked to be in that exact scope cgroup, and a CLEANUP check asserts none remain. After the fix: 21/0, no new t- scope.
  - **Residuals (stated):**
      - Spend deferral relies on per-verb reach. A user shell function that conditionally routes a verb around the shim can leave a once-grant reserved and then released for a write that ran. That is an over-grant by one, always gated.
      - A process outside the call holding the session shim can consume a live window's remaining slots. This is bounded by the one decision's writes, and every such write is gated.
      - run_in_background: the window ends at backgrounding.
      - A call running longer than 5 min lapses, and its later invocations decide independently.
      - Sessions that survive a server restart keep the old shim, whose secret is refused: fail closed, as before.
  - **Changed files (unstaged):** scripts/lib/git-grant.mjs, git-grant.d.mts, git-grant-store.mjs, git-grant-store.d.mts, git-write-policy.mjs, git-write-policy.d.mts, git-shim.mjs, git-shim.d.mts, git-shim-secret.mjs (comment); src/server/index.ts, src/server/runtime/claude-runtime.ts, src/server/runtime/runtime.ts, src/server/agent-bridge.ts, src/server/leak-gate-host.ts; scripts/verify-feat-164-self-grant.mjs; new scripts/verify-bug-231-one-decision.mjs, scripts/fixtures/bug-231/{fake-cli.mjs,gate-trace.mjs,pre-git-grant.mjs,pre-git-grant-store.mjs}.
  - Deploy: the live :4317 service runs the old code until it is restarted.

### 2026-10-05 — independent-verify
- **Verification recorded:** dispatch openai/default run 01a10ca5-0fb3-7032-a8c0-5374865424e8 — VERDICT: BROKEN — Property (4) breaks via a NEW route: in redeemGitWrite, after revokeGitWrite succeeds and grantView=null, the still-open call window authorizes the next commit; closing it fails the write. STOP rule: single-authority redesign. Fixers 30/30 (67f6e57252e2); probe df41562628f9 exit1.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-05 — worker
- **fixing r4:** **Fixing round 4 (dispatch phase=fixing round=4 class=plan+review; joint with FEAT-164). Verdict: done. Single-authority redesign built. An independent clean-room verify is warranted (SECURITY / regression-prone).** regressed-from: FEAT-164 r1, r2, r3 and BUG-231 r1. The r3 break is verify run 01a10ca5-0fb3-7032-a8c0-5374865424e8.
    - **Rule:** the grant store is the only authority. Windows, the hook, the shim and claim objects hold only a claim HANDLE. Every git write is allowed only by `useClaim(handle, now)` in git-grant-store.mjs, asked at that write, after its gate.
    - **Hypothesis confirmed first, and wider than charted.** The test was a probe on pinned pre-change bytes (scripts/fixtures/feat-164-r4/pre-git-grant{,-store}.mjs, sha256 a8c96222…/4088fed3…). It found TWO holders outside the store's current answer:
        - (1) the call window, state 'committed' with claim null. It allowed the next commit after a revoke (the verifier's route) and after a duration grant expired.
        - (2) the claim object itself. `settleClaim('commit')` never re-asked the store, so a reserved window still committed after a revoke, and so did the hook when the revoke landed mid-gate.
    - **Built:**
        - Store: each project has a revocation generation, and `revokeGitWrite` always bumps it. `useClaim` is true only if all of these hold: the generation is unchanged; the claim has not lapsed; the claim is the same timed grant object and is unexpired, or the same permanent incarnation (same grantedAt). It spends a reserved once-use atomically, once per handle; an invalid claim ends and its reservation returns. `endClaim` is idempotent. `settleClaim` stays as a use+end wrapper and throws as before.
        - git-grant.mjs: the hook asks `useClaim` with the post-gate clock. Windows keep the handle, and every redeem asks `useClaim` with the post-gate clock. A withdrawn window refuses the rest of its call; it never falls back to a fresh decision.
    - **Former allow-holders and how each routes now:**
        - hook evaluateGitWrite → useClaim;
        - deferred hook allow → authorises no write; each shimmed write → useClaim at redeem;
        - window 'committed' → removed; the window holds the handle → useClaim;
        - reserved claim settle → useClaim;
        - independent shim/Codex path → evaluateGitWrite → useClaim;
        - shim resolveGitShim → relays the host's useClaim answer for one exec.
      - Non-grant allows, unchanged: reads, the host env hatch, and sanctioned plumbing under a temp index.
    - **Plan review, cross-provider (openai, transcript 01a10cac-7dfb-7f40-af40-f516d0a10d8d) → UNSOUND. All folded in:**
        - F1: revoke and re-grant mid-call, then the fallback spends the new grant (one call decided twice). Fixed by the withdrawn tombstone.
        - F2: the redeem used a pre-gate `now`. Fixed with a post-gate clock at both sites.
        - F3: a permanent off→on through the registry without a revoke resurrected old claims. Fixed by the grantedAt incarnation.
        - F4: the shim holds a boolean between decide and exec. This is structural; useClaim is defined as the linearisation point.
        - The reviewer found no other holder in claude-runtime, codex-runtime, agent-bridge or git-shim.
    - **Verified:**
        - NEW scripts/verify-feat-164-store-authority.mjs: 27/0.
            - MUST-FAIL on pinned bytes: b1 on r1 (synthesized from pinned r2); b2 on r2; on r4pre: b3, reserved-revoke, hook mid-gate revoke, revoke+re-grant mid-call, expiry mid-call, expiry mid-gate on a real clock (hook and shim), permanent re-incarnation, concurrent calls on the same project + revoke. All of these hold on the current tree.
            - Structural, at runtime: granted writes map 1:1 to store useClaim()==true over a grid of once/duration/permanent × reach × revoke. A mutant whose redeem skips the store question FAILs it.
            - Static: discovers every `granted: true` site at runtime (5 sites in 72 files; fails if 0). Each must be store-guarded, a deferral, or a shim relay. A check of the scan against the pre-r4 fixture flags 2 BAD sites, so the scan is not vacuous.
        - verify-bug-231 e2e gains S11 on the real scratch server: a revoke through the real DELETE route mid-call, then a fresh once-grant. Current tree: 24/0 e2e, 23/0 unit. On the pinned pre-r4 tree, S11 FAILs (the call's next commit landed).
    - **Changed semantics:** these existing checks were rewritten, because a revoke, expiry or replacement landing mid-gate now DENIES the write (r3 let it through): single-authority S1/G4/G5/G6/G8 (now 31/0, with S1 split into the r1 no-collateral property and the r4 revoke-wins property), and permanent A13a/A13d (41/0). The BUG-231 U6 mutant now also removes the store's lapse check, which is the defence in depth.
    - **Anti-regressions:**
        - feat-108-git-grant 66/0, feat-108-git-write-block 241/0, feat-135-git-shim 31/0, bug-230 23/0. These four ran with the invoker's shim dropped from PATH; the scratch `git init` touched /tmp only.
        - bug-173 28/0, bug-184 28/0.
        - feat-164-self-grant 21/0, 12 holes open (exit 2, unchanged); no t- scope was left behind.
        - `npm run gate` exit 0.
    - **Residuals, accepted and unchanged:**
        - same-uid self-grant (the A/B/C decision);
        - an over-grant via a user shell function or an outside process consuming a live call's slots;
        - a double gate when a command creates the content it commits;
        - an unshimmed write (absolute path, container) is authorised at the hook's useClaim, the last observable instant;
        - a call longer than CLAIM_MAX_MS lapses and later invocations decide afresh;
        - a withdrawn call's unused hook record stays 'permitted'.
    - **Changed files (unstaged):**
        - scripts/lib/git-grant-store.mjs, git-grant-store.d.mts, git-grant.mjs, git-grant.d.mts (comment)
        - src/server/index.ts (comment)
        - scripts/verify-feat-164-single-authority.mjs, verify-feat-164-permanent-git-grant.mjs, verify-bug-231-one-decision.mjs
        - NEW scripts/verify-feat-164-store-authority.mjs, scripts/fixtures/feat-164-r4/pre-git-grant{,-store}.mjs
        - package.json (verify:feat-164-store-authority)

### 2026-10-05 — independent-verify
- **Verification recorded:** dispatch openai/default run 01a10cb9-ec2b-7b82-b07f-52409dd7df87 — VERDICT: INVALID — Contract INVALID (fixer-test citation rejected; exit3). Substance: probe cac43c8795dd exit1 = a hidden out-of-command add verb takes the independent path, spends a fresh once-grant while the commit window is correctly withdrawn = DOCUMENTED ACCEPTED RESIDUAL, not a new break. Detail in Activity log.. Typed entry in the record's verification[]; this line is an echo, not proof.
- **Independent clean-room verification — full detail (verifying round 2, joint with FEAT-164 r4; cross-provider openai/default, harness scripts/independent-verify.mjs).**
  - **Formal result:** verdict-contract **INVALID** (exit 3). The verifier answered `VERDICT: BROKEN`, but the harness rejected its citation block: the `=== FIXER-TEST ===` slot cited run `df58d3abc872` (`node scripts/verify-feat-164-store-authority.mjs`), which the contract classed as a stand-in rather than the harness-supplied fixer-test command. An INVALID verdict counts as neither a pass nor a fail (verdict-contract.mjs).
  - **Setup:** a FOCUSED diff was built WITHOUT touching the real repo — two dangling commits from node-spawned git over throwaway indices (sanctioned temp-index plumbing: read-tree/add/write-tree/commit-tree; a scratch work-tree held HEAD copies of the 7 files so `add` overlaid them). base `de2109de3f5e` = full working tree with the 7 grant-layer files reverted to HEAD; head `7a70c773f171` = full working tree. Diff handed over = exactly those 7 files (scripts/lib/git-grant-store.mjs +.d.mts, git-grant.mjs +.d.mts, git-shim.mjs; src/server/runtime/claude-runtime.ts, codex-runtime.ts), 83783 bytes, 7/7 changed paths. Real repo untouched (HEAD still a977e76, status unchanged).
  - **What reproduced green in-room:** author suites verify-feat-164-store-authority (df58d3abc872), verify-feat-164-single-authority (7142dc43aa00), verify-feat-164-permanent-git-grant (eafe6cc241c7), verify-bug-231-one-decision (b90525f0b594) all ran exit 0.
  - **The verifier's finding (synthetic unit probe `cac43c8795dd`, exit 1, `verifier-withdrawn.mjs`):** with a duration grant and an open tool-call window for the command `git commit …; node hidden-add.cjs` (window slots = ['git commit'] only — the add verb is hidden inside a node subprocess and never written out in the command text), it revoked the grant, redeemed the commit (→ window correctly `withdrawn`, refused), issued a FRESH once-grant mid-call, re-redeemed the commit (→ still refused through the withdrawn window, fresh grant NOT spent, remainingUses stayed 1), then redeemed a hidden `git add`. Because `add` is not in the withdrawn window's slots, the window-match loop found no window and fell to the independent `evaluateGitWrite → claimGrant` path, which minted a NEW decision (`d-3ef9a2d4…`, distinct from the window's `d-07faeb89…`) and spent the fresh once-grant (allow=true, gated).
  - **Independent assessment — ACCEPTED RESIDUAL, not a new in-scope break.** The design deliberately routes a git verb NOT present in the command text (subprocess git / no git text / background job) through the independent decision path "exactly as before" (redeemGitWrite doc comment), and BUG-231 r1 + r4 residuals already name "an outside process consuming a live call's slots" and "a subprocess git in a command with no git text" as accepted, always-gated over-grants. The probe shows NO in-scope violation: no once-grant spent twice, no un-gated write, the withdrawn WINDOW authorised nothing, and the fresh once-grant was spent exactly once by a gated write against a genuinely live, user-issued grant. The enumerated in-scope properties HELD in the probe itself (withdrawn window refused commit AND retry-commit; fresh grant not spent through the withdrawn window).
  - **Could-not-test (STOP rule fired early):** real Bash execution of the sequence; the Codex path; server-restart-mid-call-with-a-live-claim; clock-skew/expiry boundary and concurrent calls beyond what the author suites cover.
  - **Decision for the orchestrator:** (1) accept-as-residual → the single-authority fix HOLDS modulo the documented out-of-command-text residual; or (2) re-scope the hidden/subprocess-verb independent path as in-scope (it would then want the window-withdrawal tombstone to bind the whole Bash call, not just matched slots) and spend another clean-room run. Quota: this lane used its ONE sanctioned run.
  - **Independent-skeptic note:** SECURITY / session-lifecycle / regression-prone area with three prior breaks; this verdict is already from a separate cross-provider clean-room process. If the orchestrator chooses (2), a fresh-context clean-room pass with the tightened requirement and a corrected FIXER-TEST citation is warranted. Kept room: ~/.local/state/claude-station/scratch/cleanroom-verify-av7XIR; record dir cleanroom-record-H4T0bB.

### 2026-10-05 — dispatch openai
- **Verification recorded:** dispatch openai/default run 01a10ddd-5061-7312-8ae2-3b4e14cdea82 — VERDICT: INVALID — Contract-VALID BROKEN but the sole finding is the documented once=one-Bash-call semantics (one grant covers every write written out in one command), NOT a break. Repro: a 2nd SEPARATE call is denied; a replacement spent once by the next call. Charter mis-stated property 4 as one write. See log.. Typed entry in the record's verification[]; this line is an echo, not proof.
- **Independent clean-room verification — full detail (verifying round 3, joint FEAT-164 r4 + BUG-231; cross-provider openai/default, harness scripts/independent-verify.mjs, run `01a10ddd-5061-7312-8ae2-3b4e14cdea82`).**
  - **Contract SATISFIED this round (round 2's INVALID-on-contract is fixed).** The harness-supplied fixer-test command was passed as `--run "node scripts/verify-feat-164-store-authority.mjs"`, so the verifier's FIXER-TEST citation (manifest `6444cddf1227`, exit 0, 27/0) matched a known run and validated. Result: verdict-contract **VALID**, verdict **BROKEN** (harness exit 1), manifest-backed (6 recorded runs).
  - **Diff scope identical to round 2:** a FOCUSED 7-file diff built without touching the real repo — base `8b88875df520` = a working-tree snapshot with the 7 grant-layer files reverted to HEAD, head `063daa930b3c` = the full working-tree snapshot (scripts/lib/git-grant-store.mjs +.d.mts, git-grant.mjs +.d.mts, git-shim.mjs; src/server/runtime/claude-runtime.ts, codex-runtime.ts), 7/7 changed paths, 84779 bytes. Real repo HEAD/index untouched (snapshot via a throwaway index; `git add`-over-scratch-worktree overlay, no `update-index --cacheinfo`, which the shim blocks).
  - **The verifier's finding (adversarial probe `verify-adversarial.mjs`, manifest `20f1ef29a605`, exit 1, two cases):** against the command `git commit -m first; git commit -m second` (TWO write verbs WRITTEN OUT in ONE Bash call — one window, `beginGitWriteToolCall` once, two redeems sharing the window), both redeems returned allow=true under the SAME decision, so one once-grant authorised both writes of the one call; and with a replacement once-grant issued mid-call (no revoke), the second redeem still succeeded under the old handle while the replacement stayed unspent (remainingUses:1). The verifier's oracle was `expectedSecondAllow:false` and it reported BROKEN on properties 4 and 2.
  - **Independent assessment — NOT an in-scope break; the harness BROKEN is a SUBSTANTIVE FALSE POSITIVE.** The oracle `expectedSecondAllow:false` assumes `once = one git write`. The CANONICAL design (BUG-231 option (b), chosen; r1 design) is `'once' = one foreground Bash CALL, covering the git writes WRITTEN OUT in it` — a window has slots = the multiset of bare-`git` write verbs in the command, and each written-out write redeems one slot under the one handle. Two literal commits in one call is the SAME shape as the ordinary `git add && git commit` and MUST both pass under one once-grant; the spent-handle idempotency at git-grant-store.mjs:312 (`if (st.state === 'spent') return true`) is exactly what makes the second written-out write of ONE call succeed. "Fixing" this would RE-INTRODUCE BUG-231 itself (grant consumed by the first write, the second write of the same command refused). The root cause of the false positive is that the REQUIREMENT handed to the verifier mis-stated property 4 as "at most ONE git write, ever — never two"; the verifier faithfully applied the wrong oracle.
  - **Decisive in-process reproduction against the HEAD (fix) code (/tmp/adjudicate.mjs, store+window API, injected passing gate):**
      - B1 — one call, two commits written out → both allow=true, grant consumed (grantView null after). Intended.
      - B2 — one once-grant, then TWO SEPARATE Bash calls → call 1 allowed, call 2 **DENIED** at both hook and redeem (grantView null). The once-grant does NOT leak to a second call. **Charter property 4 ("never by another call/session/project") HOLDS.**
      - B3 — replacement once-grant issued mid-call: NOT consumed by the in-flight call (remainingUses:1 after the call); the replacement is then spent exactly once by the NEXT separate call, and a further call is DENIED. No once-grant is ever double-spent. **Charter property 2 (replacement) HOLDS.**
  - **Corroboration in-room:** author `verify-feat-164-store-authority.mjs` re-ran 27/0 — its own must-FAILs on pinned pre-fix bytes (b1/b2/b3, reserved-call revoke, revoke mid-gate at the hook, revoke+re-grant mid-call, expiry mid-call, expiry mid-gate hook AND shim on a real clock, permanent re-incarnation mid-call, concurrent calls + revoke) all reproduce on the pinned trees and all HOLD on the current tree; plus the structural 1:1 (granted writes ↔ store useClaim()==true over the scenario grid, a mutant caught) and the static single-authority scan.
  - **Could-not-test (the verifier stopped at its first "break"):** real Bash execution of the sequence (the in-room git shim blocked scratch `git init`, so the probe used the store/window API directly); the Codex path (codex-runtime.ts); server-restart-mid-call-with-a-live-claim; hook-deny-then-retry; SubagentStop ending a subagent's windows; turn-end; and the expiry boundary + concurrency beyond what store-authority already covers.
  - **Decision for the orchestrator.** This clean-room run did NOT validly test the real requirement — it attacked a stricter, incorrect property 4 that the code was never meant to satisfy — so it is recorded **INVALID** (counts as neither pass nor fail) rather than BROKEN. No in-scope break was found; the enumerated properties that WERE exercised (4 and 2, plus everything store-authority covers) HOLD on the fix. The ONE sanctioned run is spent. To obtain a clean independent HOLDS, a corrected re-run is warranted with property 4 restated as: "a once-grant authorises at most one Bash CALL's written-out writes, and must not carry to a second call, session or project" — the orchestrator decides whether to spend another run (quota).
  - **Independent-skeptic note:** still warranted. Because this run attacked the wrong property, it did NOT independently establish HOLDS for the single-authority redesign; an independent cross-provider clean-room HOLDS on the corrected requirement remains outstanding for this SECURITY / session-lifecycle / regression-prone area (four prior breaks). Kept room: `~/.local/state/claude-station/scratch/cleanroom-verify-0anExE`; record dir `cleanroom-record-ZpXGJI` (manifest + `<id>.out`).

### 2026-10-05 — dispatch openai
- **Verification recorded:** dispatch openai/default run 01a10df8-9157-76b0-8c9b-bd5fb2cd70d9 — VERDICT: BROKEN — Property 5 BREAKS at CLAIM_MAX_MS: a revoked call outliving 5min has its withdrawn window reaped (git-grant.mjs:240); its next written-out commit decides afresh, eats a mid-call regrant, commits, DENIES a new call. Probe ed70bc971ca6 exit1; fixers 27/0. 2nd finding=round-3 mis-oracle. See log.. Typed entry in the record's verification[]; this line is an echo, not proof.
- **Independent clean-room verification — full detail (verifying round 4, joint BUG-231 + FEAT-164 r4; property-4 CORRECTED per the round-3 INVALID; cross-provider openai/default, harness scripts/independent-verify.mjs, run `01a10df8-9157-76b0-8c9b-bd5fb2cd70d9`).**
  - **Contract VALID, verdict BROKEN (harness exit 1), manifest-backed (6 recorded runs).** Fixer-test supplied via `--run "node scripts/verify-feat-164-store-authority.mjs"` (round-3 citation contract, validated): FIXER-TEST manifest `0e65657fad65`, exit 0, 27/0.
  - **Diff scoped exactly as round 3** (focused 7-file range built from the current working tree without touching the real repo — a throwaway-index snapshot via node-spawned git, `git add` overlay, no `update-index --cacheinfo` which the FEAT-135 shim blocks). base `d7317210abfa` = full working tree with the 7 grant-layer files reverted to HEAD; head `6ff4336da032` = full working-tree snapshot. 7/7 changed paths (scripts/lib/git-grant-store.mjs +.d.mts, git-grant.mjs +.d.mts, git-shim.mjs; src/server/runtime/claude-runtime.ts, codex-runtime.ts), 84345 bytes (`--max-diff-bytes 120000`, NOT truncated). Real repo HEAD a977e76 / 359 dirty entries unchanged after the run. Note: git-shim.mjs now carries the BUG-230 FIFO/lstat guard — in scope only as unchanged authority behaviour; the corrected requirement said so.
  - **Requirement corrected (the round-3 fix):** property 3 (once-grant scope) restated as "authorises the git writes WRITTEN OUT in ONE foreground Bash call … never carried to another call/session/project" with an explicit note NOT to treat two writes of one call as a violation; the accepted-residuals and prior-break lists were handed to the verifier verbatim. Requirement file: /tmp/iv-r4-requirement.txt (synthetic charter text, no real board/methodology — clean room strips docs).
  - **THE IN-SCOPE BREAK — property 5 at the CLAIM_MAX_MS reap boundary (adversarial probe `adversarial-grants.mjs lapse`, manifest `ed70bc971ca6`, exit 1; real git-grant-store + git-grant + installGitShim + real git, controlled clock).** Command `git commit first; <revoke>; git commit denied; <advance now by CLAIM_MAX_MS + fresh once-regrant>; git commit stale` in ONE call. `first` redeemed (allow=true). Revoke → window `withdrawn`; `denied` correctly refused (allow=false). The clock crosses CLAIM_MAX_MS, so `reapWindows` (git-grant.mjs:240-243, `now - w.at >= CLAIM_MAX_MS`) DROPS the still-in-flight call's withdrawn window. `stale` then finds no window → decides AFRESH on the independent `evaluateGitWrite → claimGrant` path (**redeemed=false**), consumes the fresh mid-call regrant (`grantView` → null), commits, and a genuine NEW call is then **DENIED** (`genuine_new_call_allow=false`). So a revoked call that outlives 5 min defeats property 5: the withdrawn call's later written-out write runs and steals a legitimate grant. The verb is IN the command text and the window existed, so this is NOT a listed accepted-residual (subprocess/out-of-text verb) and NOT a re-count of the r1/r2/r3 breaks. The gate DID run (over-grant by one, gated), but the consequence — denial of a genuine new call — is harmful, not harmless.
  - **The harness's SECOND finding is a FALSE POSITIVE — the round-3 mis-oracle re-appearing (probe `adversarial-grants.mjs replacement`, manifest `62289197fb61`, exit 1).** Command `git commit first && <fresh once-regrant> && git commit stale` in ONE call. `stale` redeemed the SAME window handle (**redeemed=true**, spent-handle idempotency), and the replacement stayed `remainingUses:1` for the next call. Two commits written out in ONE call BOTH running on one once-grant is the intended `add && commit` shape (property 3), and a mid-call replacement not disturbing the in-flight call is round-3's accepted B3. The probe's oracle `messages.includes("stale")` flags the intended second write — exactly the property that round 3 was ruled INVALID for mis-stating. NOT an in-scope break; the verdict rests solely on the lapse finding above.
  - **Corroboration in-room:** author `verify-feat-164-store-authority.mjs` re-ran 27/0 — must-FAILs on pinned pre-fix bytes (b1/b2/b3, reserved-call revoke, revoke mid-gate at the hook, revoke+re-grant mid-call, expiry mid-call, expiry mid-gate hook AND shim on a real clock, permanent re-incarnation mid-call, concurrent calls+revoke) all reproduce on the pinned trees and HOLD on the current tree; plus the structural 1:1 (granted writes ↔ store useClaim()==true, a mutant caught) and the static single-authority scan. So the enumerated properties that store-authority covers HOLD; the gap is the window-reap-vs-withdrawn interaction, which that suite does not model (its expiry/concurrency cases do not advance a WITHDRAWN window past CLAIM_MAX_MS mid-call).
  - **Could-not-test (verifier stopped at two findings per the STOP rule):** a real end-to-end Bash exec driven through the real hook+shim with real leak scanning (the probe used production grant functions + real shim + injected passing gate + controlled clock, not a live scan); the Codex runtime callbacks (codex-runtime.ts); a production server restart mid-call with a live claim; hook-deny-then-retry; SubagentStop / turn-end window closure; concurrency beyond store-authority's grid.
  - **Decision for the orchestrator.** Recorded BROKEN (VALID, manifest-backed) on one genuine property-5 break at the CLAIM_MAX_MS reap boundary; the harness's replacement finding is the round-3 mis-oracle and does NOT count. This is a 5th distinct break in a SECURITY / session-lifecycle area — the reap (property 7, 5-min orphan expiry) and property 5 (withdrawn call stays denied) CONFLICT for a call that outlives 5 min: reapWindows drops the withdrawn window and the zombie call decides afresh. A fix must make a reaped-while-withdrawn window stay denied (or keep withdrawn state past reap for a still-open call), without breaking orphan cleanup. The ONE sanctioned run is spent. An independent clean-room HOLDS on the corrected requirement remains outstanding.
  - **Independent-skeptic note:** this run IS a separate cross-provider clean-room process (satisfies "generation is not its own only verifier"), but it did NOT establish HOLDS — it found a new break. Kept room: `~/.local/state/claude-station/scratch/cleanroom-verify-RohpoV`; record dir `cleanroom-record-LDRTvV` (manifest.jsonl + `<id>.out`).

### 2026-10-05 — worker
- **Note:** **fixing r5 (dispatch phase=fixing round=5 class=plan+review; joint with FEAT-164). Verdict: done. regressed-from: BUG-231 r4 / FEAT-164 r4 (the 5th break, verify run 01a10df8-9157-76b0-8c9b-bd5fb2cd70d9). An independent clean-room verify is warranted (SECURITY / session-lifecycle / regression-prone, five prior breaks).**
      - **Rule:** a call's claim state is the store's, keyed by call id; withdrawn or lapsed is terminal for that id until its call-end signal, and time never turns it back into undecided.
      - **Hypothesis confirmed first, on pinned pre-change bytes** (scripts/fixtures/bug-231-r5/pre-git-grant{,-store}.mjs, sha256 26a5fead… / b67a220d…). The per-call window lived in git-grant.mjs and its existence decided behaviour. Two things other than the call ending destroyed it: the CLAIM_MAX_MS reap (the 5th break), and a repeat PreToolUse with a known tool_use_id, which closed the withdrawn window and decided afresh (same class, found by the probe).
      - **Built:**
          - git-grant-store.mjs owns per-call records: binding → tool_use_id → {handle, status open|withdrawn|ended, bookkeeping}. API: openCallClaim, callClaimState, useCallClaim, findCallFor, endCallClaims.
          - useCallClaim is the allow for a call's write. It is true only when the call is open and useClaim is true; a false answer withdraws the call, terminally.
          - The lapse at CLAIM_MAX_MS now withdraws the call, ending its handle so a reserved use returns. It does not delete the record.
          - Records are deleted only after CALL_TOMBSTONE_MS (24h). An ended record keeps only a tombstone.
          - The hook refuses any tool_use_id the store already knows, before it claims.
          - In git-grant.mjs the windows map and reapWindows are gone. A shim write that matches a withdrawn call is denied. Only a write that matches no not-ended call decides independently: no binding (Codex), git after the call ended, or a verb not written out.
      - **Changed semantics (decision for orchestrator):** a live call that outlives 5 min now has its later written-out write DENIED. Before, it decided afresh. Example: `npm test && git commit` where the tests take 6 min. This is fail-closed, as the charter requires; raising CLAIM_MAX_MS above the Bash max timeout would bring back the legitimate long call.
      - **Plan review, cross-provider** (openai, session 01a10e05-9177-7741-8a42-5a396606c470): UNSOUND, on one finding. A new once-grant issued after the call's once-grant was spent does not stop the call's next written-out write. **Rejected, no change:** this is the round-3/round-4 mis-oracle. A spent once-grant is already gone from the map, so a new grant replaces nothing. Two written-out writes of one call on one once-grant is property 3, and the new grant stays unspent for the next call (r3 B3). No other path was found.
      - **Verified:**
          - NEW scripts/verify-bug-231-call-claims.mjs: 17/0.
              - MUST-FAIL on the pinned bytes: reapBoundary (the break, verbatim shape); withdrawn call past 5 min (9 min, 60 min) under a re-incarnated permanent grant; lapsed live call is terminal; tombstone outlives calls; unknown call id; call id reuse. All 6 break on pre and hold on the current tree.
              - Two mutants of the current tree reopen reapBoundary: a withdrawn record that no longer matches, and the sweep reaping at CLAIM_MAX_MS. So the check is not vacuous.
              - Anti-regressions: property 4 (one call's add+commit on one once-grant, the next call denied); the independent carve-out (Codex with no binding, git after the call ended).
              - Restart: a fresh module instance holds a live call and a withdrawn call. It refuses the old boot's shim secret, holds no timed grant, and denies both calls. This is in-process modelling, not a real server restart.
          - **The verifier's REAL probe** (kept room cleanroom-verify-RohpoV/adversarial-grants.mjs, real shim + real git in a /tmp scratch):
              - `lapse` FAILs on the pinned pre bytes (stale committed, genuine new call denied) and PASSes on the current tree (stale refused, fresh grant preserved, genuine call allowed).
              - `replacement` reports FAIL on both. That is the known mis-oracle above.
          - **Existing suites:**
              - store-authority 28/0. The noask mutant was re-anchored to useCallClaim. The static scan accepts useCallClaim, with a new check that it is defined only in the store and answers through useClaim.
              - single-authority 31/0; permanent 41/0.
              - bug-231 one-decision 47/0 (e2e S1-S11 on a real scratch server, plus unit). The U6 mutant was re-anchored to the store sweep. U7b was rewritten for the changed semantics: a lapsed reserved call is denied, its reservation is released, and exactly one new call gets the once-grant.
              - feat-108-git-grant 66/0; feat-108-git-write-block 241/0; feat-135-git-shim 31/0.
              - bug-173 28/0; bug-184 28/0; bug-230 nested 23/0; bug-230 FIFO 14/0.
              - feat-164-self-grant 21/0 with 12 holes open (exit 2, unchanged).
              - Shim suites ran with the invoker's shim dropped from PATH.
          - `npm run gate` exit 0.
      - **Residuals, unchanged:** a git verb not written out in a withdrawn call still takes the independent path (accepted in r2). A shim invocation carries the session binding, not the tool_use_id, so a write is matched to its call by binding + project + verb (first match). Restart safety relies on the per-boot shim secret.
      - **Filed:** BUG-233 (Codex re-checks the shim only per turn; file only).
      - **Changed files (unstaged):**
          - scripts/lib/git-grant-store.mjs, git-grant-store.d.mts, git-grant.mjs
          - scripts/verify-feat-164-store-authority.mjs, scripts/verify-bug-231-one-decision.mjs, package.json
          - NEW scripts/verify-bug-231-call-claims.mjs, scripts/fixtures/bug-231-r5/pre-git-grant{,-store}.mjs
          - docs/bugs/BUG-233-*.md

### 2026-10-06 — worker (fixing r6)
- **fixing r6 (dispatch phase=fixing round=6 class=fix). Verdict: done.** regressed-from: BUG-231 r5 (the 5-min live-call denial broke ordinary use). Independent clean-room verify warranted (SECURITY / session-lifecycle / regression-prone, prior breaks).
    - **Problem:** r5 made a LIVE, non-withdrawn call that outlives CLAIM_MAX_MS (5 min) deny its later written-out write. That breaks ordinary use — e.g. `npm test && git commit` where the tests run 6 min has its commit denied. The Claude Code Bash tool caps a single foreground call at `timeout` ≤ 600000 ms (10 min).
    - **Source check:** Orchard does NOT set or override the Bash tool timeout anywhere — no `BASH_MAX_TIMEOUT_MS` / `BASH_DEFAULT_TIMEOUT_MS` in `.claude/settings*.json`, `~/.claude/settings*.json`, the env passthrough, or anywhere under the repo (checked 2026-10-06). So there is no single source to derive from; the bound is taken from the harness max and a margin.
    - **Fix:** `scripts/lib/git-grant-store.mjs` — new `export const BASH_MAX_TIMEOUT_MS = 600 * 1000` (the harness hard cap, 10 min) and `CLAIM_MAX_MS = BASH_MAX_TIMEOUT_MS + 5 * 60 * 1000` (15 min), with a comment naming why (the lapse must exceed the longest a single foreground Bash call can run). A withdrawn/revoked/expired call is still denied IMMEDIATELY (store generation/expiry check, not this lapse); only an otherwise-live call's handle lapse moved. `git-grant-store.d.mts` declares both.
    - **Orphan tombstone (r5 property c) unchanged:** `CALL_TOMBSTONE_MS = 24h` still far exceeds the 15-min lapse, so an orphan tombstone outlives the lapse.
    - **Tests (both sides of the boundary with injected time, no real sleeps):**
        - `verify-bug-231-call-claims.mjs`: NEW `liveLongCallWithinBound` (a live deferred once-call whose write arrives at a FIXED 6 min — past r5's old 5 min, inside r6's bound — is ALLOWED and spends), plus a NEW `mut-fivemin` mutant that puts the bound back to 5 min and asserts that scenario BREAKS (non-vacuous). Existing lapse checks use `store.CLAIM_MAX_MS` symbolically and adapt. 19/0 (was 17/0).
        - `verify-bug-231-one-decision.mjs`: U7 split into U7a (within-bound write at `CLAIM_MAX_MS - 60s` ALLOWED + spends — the r6 property) and U7b (past-bound at `CLAIM_MAX_MS + 60s` DENIED terminal, reservation returns, once-grant to exactly one new call). U6 orphan lapse retimed to `CLAIM_MAX_MS + 60s`. 48/0 (was 47/0).
    - **Proof suites green:** bug-231-call-claims 19/0; bug-231 one-decision 48/0; store-authority 28/0; single-authority 31/0; permanent 41/0. `npm run gate` exit 0 (leak-gate + check-nul + typecheck).
    - **Changed files (unstaged):** scripts/lib/git-grant-store.mjs, scripts/lib/git-grant-store.d.mts, scripts/verify-bug-231-call-claims.mjs, scripts/verify-bug-231-one-decision.mjs.

### 2026-10-05 — dispatch openai
- **Verification recorded:** dispatch openai/default run 01a10e18-6f39-7c63-b1e8-3b35038aec21 — VERDICT: BROKEN — BROKEN (VALID, manifest 6 runs). Fixer cc28db7f3e3c exit0 19/0. Two breaks, STOP. P5: initially-DENIED call id left 'unknown', no tombstone; reused id steals a fresh once-grant (7f57e10c4704). P8: fingerprint skip bypasses now-failing gate on identical 2nd write (af310f923a95). See log.. Typed entry in the record's verification[]; this line is an echo, not proof.
- **Independent clean-room verification — full detail (verifying round 5, joint BUG-231 + FEAT-164 r4+r5+r6; cross-provider openai/default via codex-cli, harness `scripts/independent-verify.mjs`, run `01a10e18-6f39-7c63-b1e8-3b35038aec21`).** VERDICT **BROKEN** (harness exit 1), verdict-contract **VALID**, manifest-backed (6 recorded runs).
    - **Scope + contract.** Diff scoped exactly as round 4: a focused 7-file range built from the CURRENT working tree without touching the real repo (throwaway-index snapshot via node-spawned git; `git add -A` with `:(exclude)` pathspecs leaving the 7 fix files at HEAD in the base). base `af184f9c6b5f`, head `de3a942ce1ce`, 7/7 changed paths (scripts/lib/git-grant-store.mjs +.d.mts, git-grant.mjs +.d.mts, git-shim.mjs; src/server/runtime/claude-runtime.ts, codex-runtime.ts), 93369 diff bytes (`--max-diff-bytes 120000`, NOT truncated). Clean room stripped `docs`; given only code/config/tests. Fixer-test cited per contract via `--run "node scripts/verify-bug-231-call-claims.mjs"`: FIXER-TEST manifest `cc28db7f3e3c`, exit 0, 19/0 (incl. 6 MUST-FAIL-on-pinned-pre-r5-bytes checks all BREAKing on the old tree). Requirement handed to the room (synthetic, /tmp/iv-r5-requirement.txt): round-4's corrected properties PLUS the r5/r6 call-id-keyed store property (withdrawn/revoked/expired/lapsed/**unknown** → every later write carrying that call id DENIED, never re-decided independently; only a NO-call-id write decides independently) and the 15-min live-call bound vs 24-h orphan tombstone.
    - **BREAK 1 — property 5, the "unknown"/initially-denied arm (adversarial probe `initially-denied-call-id-retry`, manifest `7f57e10c4704`, exit 1; real git-grant-store + git-grant + installGitShim + real git on an isolated HTTP adapter, scratch repo).** A call id with NO grant has its write DENIED (`firstAllowed:false`); the deny settles the call to `stateAfterDeny:"unknown"` and creates **no tombstone**. A fresh `once` grant is then issued and the SAME call id retries: because the id is `unknown` (never recorded in the `calls` map — `openCallClaim` only records when a grant/claim existed), `openCallClaim` treats it as a brand-new call, opens a claim and **spends the fresh once-grant** (`retryAllowed:true`, commit executes, `changed:true`), and a genuine NEW call is then **DENIED** (`genuineNewCallAllowed:false`). This violates property 5 ("once a call is … unknown, every later write carrying that call id is DENIED until the call ends") and the DESIGN'S OWN doc comment in git-grant-store.mjs (status `ended` = "the call-end signal arrived (Post / **deny** / supersession …)") — a deny is supposed to leave an `ended` tombstone, but a never-granted call leaves no record at all. DISTINCT from the r5 break (reuse of a WITHDRAWN/ENDED call); this is the DENIED-with-no-grant path, which the r5 tombstone does not cover. Not a listed accepted-residual. High confidence, clean in-scope break.
    - **BREAK 2 — property 8, fingerprint-skip bypasses a now-failing gate (adversarial probe `cached-fingerprint-skips-failing-gate`, manifest `af310f923a95`, exit 1; same real stack).** A granted commit runs once (gate passes, content fingerprint recorded). The gate is then mutated to FAIL ("injected gate dependency failure") and the SAME commit (byte-identical content → matching fingerprint) is redeemed again: `redeemGitWrite` sees the matching fingerprint and **skips the now-failing gate** (`gateCallsBefore:1 → gateCallsAfter:1`, i.e. not re-run), and the real commit executes (`execution.code:0`). The fingerprint-disabled CONTROL runs the gate, it fails, and the write is correctly REFUSED (fail-closed message). So property 8 ("the leak gate runs before EVERY granted commit/push; if the gate fails or throws, the write is refused") is violated on the cache-hit path. **Realism caveat for the fixer (my assessment, not the harness's):** the content-fingerprint skip is the documented BUG-230/BUG-231-r1 "shim skips only unchanged content" optimisation and is sound IFF the gate is a pure function of the committed content; the probe defeats it by making the gate NON-deterministic (a dependency failure) for identical content. It is NOT on the charter's accepted-residuals list, so the harness counts it; whether to (a) always re-run the gate for granted commits/pushes, or (b) document content-deterministic skip as an accepted residual, is an orchestrator/fixer decision. Lower confidence that this is a "must-fix" vs a scope clarification than BREAK 1.
    - **Both findings checked against the requirement + known list before recording: neither is PLAINLY a listed known** (the knowns cover same-uid self-grant, over-grant-by-one always-gated residuals, gate-runs-twice, the ms store→exec gap, the BUG-233 Codex per-turn recheck, and the by-design mid-call spent-grant-not-reconsumed property 4 — none of which is either of these). Per the charter the harness verdict is recorded as-is: **BROKEN**.
    - **COULD NOT TEST (two-break STOP rule fired after findings 1+2).** The probes used the real hook + real shim + real git over an isolated HTTP adapter and scratch repos, NOT the full claude-runtime/codex-runtime wiring; and these were NOT exercised: a real server RESTART mid-call with simultaneous live + withdrawn claims; hook-deny-then-retry through the full runtime; SubagentStop / turn-end boundaries; the 15-min live-call boundary end-to-end through a real Bash exec; concurrency (racing writes). The fixer-suite's own `restart` and `callIdReuse`/`unknownCallId` cases pass on the current tree (they model the WITHDRAWN/ENDED reuse and module-reinstantiation restart, not the never-granted-deny reuse BREAK 1 exercises, nor a real process restart).
    - **5th/6th distinct breaks in a SECURITY / session-lifecycle area; design-vs-patch question open.** Prior breaks r1–r5 are closed and were NOT re-counted (the fixer suite's 6 pinned-pre-r5 MUST-FAILs confirm r4/r5 stay closed on the current tree). BREAK 1 is a new arm of the same property-5 family the r5 redesign was supposed to settle; combined with r1/r3/r4/r5 all being property-5-adjacent, the orchestrator should weigh whether the call-id tombstone model needs the design, not another patch. The ONE sanctioned run is spent. Kept clean room: `~/.local/state/claude-station/scratch/cleanroom-verify-9AO88F`; record dir `~/.local/state/claude-station/scratch/cleanroom-record-fc43Bo` (manifest + `<id>.out`). Verdict file: /tmp/iv-r5-verdict.txt.

### 2026-10-06 — worker (fixing r7)
- **fixing r7 (dispatch phase=fixing round=7 class=fix; joint with FEAT-164). Verdict: done — both breaks fixed.** regressed-from: BUG-231 r1 (BREAK 2, the fingerprint skip, shipped r1 and widened by r5's store move) and the r5 call-id tombstone model (BREAK 1, which never covered the no-grant deny). Independent clean-room verify WARRANTED (SECURITY / session-lifecycle / data-loss; six prior breaks).
- **Hypothesis CONFIRMED FIRST on the current tree, with the verifier's OWN kept probe** (`~/.local/state/claude-station/scratch/cleanroom-verify-9AO88F/adversarial-verifier.mjs`, real git-grant-store + git-grant + installGitShim + real git, ephemeral port): `retry` → AssertionError "PROPERTY 5 BROKEN" (`stateAfterDeny:"unknown"`, `retryAllowed:true`, `genuineNewCallAllowed:false`); `gate` → AssertionError "PROPERTY 8 BROKEN" (`gateCallsBefore:1→After:1`, commit executed). After the fix the SAME probe passes both: `retry` → `retryAllowed:false`, `genuineNewCallAllowed:true`; `gate` → gate re-ran (`gateCallsBefore:1→After:2`), commit blocked.
- **BREAK 1 fix (by rule, not case) — every terminal outcome tombstones the call id.** Audited the store's settle paths: `useCallClaim`→`withdraw`, `endCallClaims`→`ended`, the CLAIM_MAX_MS lapse→`withdraw`, the 24h sweep→delete all tombstone an EXISTING record; the ONE gap was a call id DENIED before any claim was opened (no grant for the project), which left NO record, so `callClaimState` stayed `unknown` and a once-grant issued after the deny let the same id retry (hook) or be redeemed (shim) and steal it. New store export `denyCallClaim({binding,toolUseId,agentKey,projectKey,data})` (git-grant-store.mjs) writes a `withdrawn` tombstone keyed by the call id, carrying the command's slots; the hook's no-grant branch (git-grant.mjs `evaluateGitWrite`, `if (!claim)`) routes through it. Result: the id is undecidable again (`callClaimState != unknown` → the hook refuses the retry) AND a shim write of the same call is refused (`findCallFor` matches the not-ended tombstone, `redeemGitWrite` denies any status != open). **A user granting after a denial applies to the agent's NEXT Bash call (a NEW call id), which is the normal retry shape** — the denied id stays denied for its 24h life.
- **BREAK 2 fix (config-key in the cache key; inputs ARE reliably enumerable, so not removed).** The fingerprint skip was keyed on repo CONTENT only, so a verdict flip for byte-identical content ran ungated. The gate's verdict is a pure function of content PLUS the gate script (`scripts/leak-gate.mjs`), the token-list module (`scripts/lib/leak-tokens.mjs` — it has NO further imports, so that is its full config closure), and the resolved `--own-project` names (registry). The per-repo `.leakgate-allow` waiver file is already in the content fingerprint (the gate reads it from the git INDEX, an index entry the fingerprint hashes). New `gateVerdictKey(repoPath)` in `src/server/leak-gate-host.ts` hashes those three inputs; `repoContentFingerprint` now returns `{head, entries, gateKey}`. `fingerprintCovered` (git-grant.mjs) skips the re-gate ONLY when the gateKey is present on BOTH sides AND unchanged — a missing/unreadable key on either side forces a re-gate (fail toward running the gate). The single-gate optimisation for the normal unchanged-config case is preserved (one-decision U2 stays green). A TRULY non-deterministic gate (verdict changes with neither content nor any enumerable config input — the probe's injected dependency failure) is out of the charter's scope; it is caught here only incidentally (the probe's stub fingerprint carries no gateKey → always re-gate), and a null fingerprint always re-gates.
- **Proof (must-FAIL before fix, honest counts):**
    - Pinned pre-r7 bytes = the clean-room checkout's grant-layer files, the exact bytes run 01a10e18 broke: `scripts/fixtures/bug-231-r7/pre-git-grant.mjs` (sha256 `0bb2dc53…`), `pre-git-grant-store.mjs` (sha256 `a299998c…`).
    - `verify-bug-231-call-claims.mjs` 21/0 (was 19/0): NEW `initiallyDeniedCallIdRetry` holds on cur; a NEW pre-r7 must-FAIL block (`stateAfterDeny:"unknown"`, `shimRetry:true`) BREAKS on the pinned bytes.
    - `verify-bug-231-one-decision.mjs` 50/0 (was 48/0): NEW U13 (gate-config-key change forces a re-gate that refuses a now-failing commit) holds on cur AND must-FAILs on pre-r7 (the key is ignored → the fingerprint skip runs the failing gate's commit ungated). U2 "gate runs exactly once" preserved; U9 (leaking commit refused at the shim) preserved; the FP stub gained a constant `gateKey`.
    - `verify-feat-164-store-authority.mjs` 28/0 (the static single-authority scan accepts `denyCallClaim` — it authorises nothing, writes only a tombstone), `verify-feat-164-single-authority.mjs` 31/0, `verify-feat-164-permanent-git-grant.mjs` 41/0.
    - `npm run gate` exit 0 (leak-gate + check-nul + typecheck; the TS changes compile).
- **Residuals / notes:** a non-deterministic gate (verdict flips with no content/config change) is out of scope — the real leak-gate is a deterministic pure function of (content, gate script, token list, own-project names). On a very dirty working tree `repoContentFingerprint` returns null (pre-existing content-hash behaviour), which simply forces the shim to always re-gate (fail-safe); not a regression of this change.
- **Changed files (unstaged, NO git writes):**
    - scripts/lib/git-grant-store.mjs, git-grant-store.d.mts (new `denyCallClaim`)
    - scripts/lib/git-grant.mjs, git-grant.d.mts (no-grant tombstone; `gateKey` in the fingerprint skip)
    - src/server/leak-gate-host.ts (new `gateVerdictKey`; `gateKey` in `repoContentFingerprint`)
    - scripts/verify-bug-231-call-claims.mjs, scripts/verify-bug-231-one-decision.mjs
    - NEW scripts/fixtures/bug-231-r7/pre-git-grant{,-store}.mjs
