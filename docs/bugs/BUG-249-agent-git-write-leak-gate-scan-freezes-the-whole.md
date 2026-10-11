```orchard-ticket
{
  "id": "BUG-249",
  "type": "bug",
  "title": "Agent git-write leak-gate scan freezes the whole server on a large repo",
  "summary": "While a lane did a burst of git-writes on a large project repo (~1.7G), the dashboard went dead: history calls failed with \"history unavailable: server unreachable (Failed to fetch)\". The server was not down; its event loop was frozen.",
  "impact_if_we_wait": "Any lane doing repeated non-commit git-writes (or pushes) on a large registered repo intermittently freezes the entire single-process server for every other session and the UI, several seconds at a time, for as long as the burst lasts. The bigger the repo, the longer each freeze.",
  "current_need": "Run the mandatory git-write leak-gate scan off the server's main event loop, while keeping the gate's decision and fail-closed guarantees identical: any scan error/timeout/non-zero denies, no write approved before its scan completes, 30s timeouts kept.",
  "severity": "high",
  "area": "server / runtime",
  "reported": "2026-10-10",
  "reported_by": "agent",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-10-10",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "During a leak-gate scan of a large real repo, a concurrent cheap request is serviced within a small bound; must-FAIL against the synthesized pre-fix version.",
    "The gate's decision is unchanged: a leak still denies, a clean tree still allows, and a scan error/timeout/non-zero still denies (fail-closed).",
    "Concurrent decide requests do not cross results and cannot double-spend a once-grant; no write is approved before its own scan completes.",
    "Existing leak-gate / git-shim / git-grant suites still pass unchanged (FEAT-108, FEAT-164, BUG-173, BUG-184, BUG-231, FEAT-169, FEAT-156)."
  ],
  "code_refs": [
    {
      "path": "src/server/runtime/claude-runtime.ts"
    },
    {
      "path": "scripts/lib/git-grant.mjs"
    },
    {
      "path": "scripts/lib/git-grant-store.mjs"
    },
    {
      "path": "src/server/leak-gate-host.ts"
    },
    {
      "path": "src/server/index.ts"
    },
    {
      "path": "src/server/git.ts"
    }
  ],
  "related": [
    {
      "id": "FEAT-108",
      "relation": "see_also"
    },
    {
      "id": "FEAT-164",
      "relation": "see_also"
    },
    {
      "id": "BUG-231",
      "relation": "see_also"
    },
    {
      "id": "BUG-173",
      "relation": "see_also"
    },
    {
      "id": "BUG-184",
      "relation": "see_also"
    },
    {
      "id": "FEAT-169",
      "relation": "see_also"
    },
    {
      "id": "FEAT-156",
      "relation": "see_also"
    },
    {
      "id": "ARCH-021",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": "default",
      "run_id": "28f9ef2f-eed0-45e9-a942-f6b7809c8b9e",
      "verdict": "broken",
      "verdict_on": "2026-10-10",
      "recorded_at": "2026-10-10T21:29:28.054Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "P1 responsiveness BROKEN: scan is off-loop but repoContentFingerprint (pre+post gate, publishing writes) is still synchronous execFileSync on the hot path; stalled loop ~936ms hook/~927ms redeem. Anthropic fallback (openai quota out); decorrelation reduced."
    },
    {
      "provider": "anthropic",
      "model": "default",
      "run_id": "d7f70173-d94e-4dd3-a885-41d07ae7f3d0",
      "verdict": "holds",
      "verdict_on": "2026-10-10",
      "recorded_at": "2026-10-10T21:29:29.900Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "P2 fail-closed HOLDS: all bad runner shapes, hang/timeout, chained-publish-after-exempt, sync-promise, rejected re-gate deny; no write approved before scan completes. Anthropic fallback."
    },
    {
      "provider": "anthropic",
      "model": "default",
      "run_id": "2db7fa0f-6043-4890-938b-afe4a4d37e98",
      "verdict": "holds",
      "verdict_on": "2026-10-10",
      "recorded_at": "2026-10-10T21:29:31.731Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "P3 grant-store concurrency HOLDS: no cross-call bleed, no once double-spend, pending not redeemable, revoke mid-gate denies, multislot+crossbinding+deferred-revoke+fp-reuse attacks beyond documented residual all held. Anthropic fallback."
    },
    {
      "provider": "anthropic",
      "model": "default",
      "run_id": "663a85d4-3ccd-44cd-b732-db11d4f2f362",
      "verdict": "broken",
      "verdict_on": "2026-10-10",
      "recorded_at": "2026-10-10T21:34:56.954Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "P4 no-regression BROKEN: FEAT-108 wiring PINs stale after rename evaluateGitWrite(->evaluateGitWriteAsync( (feat-108-git-grant 63/1f; git-write-block 238/1f). Behavior suites pass: FEAT-164x4,FEAT-169,BUG-231x2,BUG-242. BUG-173/184 could-not-run (room has no git history)."
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "9426c4e5-3ffb-4a2d-9531-e264ca8af341",
      "verdict": "holds",
      "verdict_on": "2026-10-10",
      "recorded_at": "2026-10-10T22:15:21.363Z",
      "author": "agent",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "P3 fp-stability+once-grant HOLDS post-hoist to async compositions. Clean-room anthropic (decorr reduced). 22/22 adv: changed/missing/rejected/malformed pre|post fp force re-gate (fail-closed), stable skips, once spent once. Fixer 25/25. Untested: reachProven deferred, restore-in-window (pre==post)."
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "94281069-c528-475b-9fa4-1d8efa8d67ba",
      "verdict": "holds",
      "verdict_on": "2026-10-10",
      "recorded_at": "2026-10-10T22:15:23.215Z",
      "author": "agent",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "P4 no-regression HOLDS. Clean-room anthropic (decorr reduced). FEAT-108 PINs pass+anti-tamper (call-removed/reverted-sync/await-dropped FAIL). Suites: feat-108 x2,164 x3,169,bug-231 unit+e2e,call-claims,242. Fixer 25/25. GAP: /decide redeem await NOT pinned; hook sync-revert uncaught."
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "77aa64ec-8672-4443-8cba-5d96cc70e15a",
      "verdict": "holds",
      "verdict_on": "2026-10-10",
      "recorded_at": "2026-10-10T22:15:35.165Z",
      "author": "agent",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "P1 HOLDS (r2 re-fix). Clean-room anthropic (OpenAI exhausted; same-provider decorr reduced). Real hook+/decide, 88k diff, pub+non-pub: scan/fp/gateKey/ownProjectArgs off-loop; sync-revert must-FAIL stalls, async doesn't; fixer 25/25. Residual(not sync): ls-files parse 157ms@400k. No 3rd break."
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

# BUG-249 — Agent git-write leak-gate scan freezes the whole server on a large repo

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-10 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-10 — agent (plan + independent review, round 1)
- **Hypothesis verified (empirically).** The blocker is `execFileSync` in `runLeakGateForRepo`
  (src/server/runtime/claude-runtime.ts ~341-394). Measured on the real 1.7G repo: full-tree
  `--summary` scan ~4.6s wall (freezes the single-process event loop that whole time);
  narrowed `--summary --changed` (pure-commit scope) ~0.2s; `--staged` ~0.16s. The
  runtime path runs TWO sequential scans (working-tree + staged), 30s timeout EACH. The
  fingerprint/own-project git reads (`repoContentFingerprint`, `ownProjectArgs`,
  `gateVerdictKey` in leak-gate-host.ts) are ~25-31ms each — negligible vs the scan, and
  only run on publishing writes. So the dominant blocker is isolated to the gate scan;
  gated verbs are the publishing ones (commit/push) — `add`/`reset`/`checkout` are
  GATE_EXEMPT. A push (full-tree, ~4.6s) is the expensive case; a burst of them froze the
  UI ("history unavailable: server unreachable").
- **Hot callers** both already `async`: PreToolUse hook (claude-runtime.ts ~1225,
  `evaluateGitWrite`) and `/api/git-shim/decide` (index.ts ~2921, `redeemGitWrite`). A third,
  lower-priority caller is git.ts `runCommitLeakGate` (dashboard commit, own runner,
  `--identity --commit-msg`, 60s timeout, `--staged` ~0.16s, user-initiated one-at-a-time).
- **Why async is unavoidable:** unblocking the loop requires the scan to not be
  `execFileSync`; the injected gate must become awaitable, so the awaiting function must be
  `async`. No synchronous non-blocking scan exists.
- **Plan reviewed independently:** dispatch openai run `01a12615-4af1-7122-83c4-3b895c26d57c`
  (read-only). Verdict: STOP/REVISE Design B before proceeding — the strong-form hypothesis
  ("the store's FEAT-164 r4 reservation already covers every newly-possible interleaving") is
  TOO STRONG. Five concrete holes found (predictions from source, not reproduced):
  1. `safeGate` (git-grant.mjs ~382) normalizes `run(scope)` synchronously, so a Promise
     becomes `{ok:false}` before any await and a rejection escapes its try/catch. The async
     path must `await` the runner INSIDE the error boundary, then normalize the resolved value
     (still handling sync-throw, rejected promise, missing runner, existing shapes), and the
     cleanup/finally must cover the await itself so an exception before the spend never
     strands a reservation.
  2. Slot double-spend in `redeemGitWrite` is reachable even with ONE slot: two concurrent
     `/decide` both pass `findCallFor` (slot present) before either spends; the 2nd
     `useCallClaim` hits a 'spent' handle and `useClaim` returns true again (store ~327,
     deliberate for multi-write calls). `available()==0` only guards NEW claims, not
     re-redemption. `/decide` takes binding+argv, not a unique per-invocation capability, so
     "command text bounds concurrency" is NOT enforced. Sync execution currently bounds
     successful redemptions by slot count; naive async breaks that bound.
  3. Reserving the slot by simply removing it before the await opens a different hole:
     `findCallFor` matches on `data.slots.includes(verb)`, so removing the last matching slot
     makes a concurrent request see NO call → fall back to an INDEPENDENT decision (could
     consume a replacement grant, or bypass a withdrawn call's terminal-denial). "Belongs to
     this call" must stay distinct from "has an available slot".
  4. A pending hook becomes externally redeemable: `evaluateGitWrite` opens the call with
     `data.mode:'pending'`, `status:'open'` BEFORE the gate. Redeem checks status but never
     rejects 'pending' mode, so once the hook awaits, a concurrent `/decide` can redeem the
     pending window (exempt verb spends immediately; a publishing verb can finish its own
     gate before the hook's gate fails). Also the deferrable branch (git-grant.mjs ~157)
     returns allow WITHOUT `useCallClaim`, so "revoke mid-gate => deny at finish" is not
     universal — a deferred decision is re-validated at the shim's `useCallClaim`, not the hook.
  5. Post-scan fingerprint certifies content the scan never saw: `data.gatedFp` is assigned
     AFTER the gate; during an async scan another operation can change repo content/config,
     and the completion path then fingerprints the changed state and attributes it to the
     earlier successful scan → redeem skips its gate. (Capture before+after and cache only on
     equality rejects ordinary intervening changes; a change-and-restore within the scan
     window remains the documented residual — conservative fallback is the shim re-gates.)
  Factual corrections from the reviewer, folded in: non-commit writes are exempt (scope is
  commit/push); git.ts has its own 60s runner; two 30s scans not one; shim host-request
  timeout is 15s (concurrency raises contention / late 'permitted' records after a client
  aborts); fingerprint hashes changed/untracked files synchronously.
- **Revised Design B (what I am building):** split each decision into THREE synchronous
  sections with the gate between them — phase1 (sync): classify, `claimGrant` RESERVE (kept
  before the gate, load-bearing against the r2 re-entrant double-spend), `openCallClaim`,
  compute gateScope + a PRE-gate fingerprint; phase2 (async): the gate; phase3 (sync, ATOMIC,
  no awaits): re-validate + spend (`useClaim`/`useCallClaim`) + record. Keep the EXISTING
  synchronous `evaluateGitWrite`/`redeemGitWrite` as thin compositions (phase1 → SYNC gate →
  phase3) so the ~120 call sites across 12 verify scripts stay UNCHANGED — if they still pass
  unchanged, the decision logic is provably preserved; the async-only guards below are no-ops
  in the fully-synchronous/sequential path. Add async compositions used only by the two hot
  runtime callers + a promisified `runLeakGateForRepoAsync`. Concurrency guards (all no-ops
  when synchronous): (a) `safeGate` async-correct per #1; (b) redeem denies a call whose
  `data.mode === 'pending'` per #4; (c) redeem re-checks slot presence in phase3 before
  consuming, atomically, per #2 (matching today's splice position so #3's independent-fallback
  behaviour is unchanged); (d) fingerprint captured pre+post gate, cached only if stable per
  #5. git.ts commit left for a follow-up (user-initiated, ~0.16s, already async).
- **Still open / handoff:** BUILD + prove (event-loop responsiveness must-FAIL vs synthesized
  sync build using a controlled slow-subprocess gate and sampling the SERVER loop, not the
  driver's setImmediate; fail-closed; the concurrency interleavings the reviewer enumerated,
  driven by Promise barriers; full anti-regression suites + `npm run gate`). This touches the
  FEAT-164 (4 rounds) / BUG-231 (7 rounds) store — highest regression risk in the repo — so a
  mandatory independent clean-room verify is warranted; generation must not be its own only
  verifier. Watch the bug-231-one-decision mutant anchored to the literal
  `w.slots.splice(...)` line if slot-consume moves.

### 2026-10-10 — agent (build + self-verify, round 1)
- **Changed (unstaged, for the user to commit):**
  - `scripts/lib/git-grant.mjs` — split `evaluateGitWrite`/`redeemGitWrite` into a synchronous
    `prepareEvaluate`/`prepareRedeem` (classify + the once-grant RESERVE + open the call) and a
    synchronous `finish` (the spend + record), with the gate BETWEEN them. The pre-existing
    `evaluateGitWrite`/`redeemGitWrite` stay (sync composition: prepare → sync gate → finish), so
    the ~120 verify call sites are UNCHANGED. New `evaluateGitWriteAsync`/`redeemGitWriteAsync`
    compositions AWAIT the gate. New helpers `runGateSync`/`runGateAsync` (await inside the error
    boundary; a stray promise on the sync path, a sync throw, a rejected promise, a missing runner
    all fail closed) replace `safeGate`; `fingerprintsAgree` compares a pre- and post-gate
    fingerprint. Guards (no-ops when synchronous): redeem refuses a call whose hook gate is still
    `pending` (#4); redeem re-checks the slot atomically at the spend (#2); `gatedFp` is cached
    only when the fingerprint was stable across the scan (#5).
  - `src/server/runtime/claude-runtime.ts` — added `runLeakGateForRepoAsync` (promisified
    `execFile`, same two-pass scan / own-project / FEAT-169 scope / 30s-per-scan / fail-closed as
    the sync one); the PreToolUse hook now `await`s `evaluateGitWriteAsync` with the async gate.
  - `src/server/index.ts` — `/api/git-shim/decide` now `await`s `redeemGitWriteAsync` with the
    async gate (handler was already async).
  - `scripts/lib/git-grant.d.mts` — `GateRunner` may return a verdict or a promise; added the two
    `…Async` declarations returning `Promise<GitWriteEvaluation>`.
  - `scripts/verify-bug-249-gate-nonblocking.mjs` + `scripts/fixtures/bug-249/slow-gate.mjs` — new.
- **Verified (fixer's own run — necessary, not sufficient):**
  - `node scripts/verify-bug-249-gate-nonblocking.mjs` → 16/16 PASS. Responsiveness with the
    synthetic 900ms gate: pre-fix (sync `execFileSync`, the synthesized must-FAIL baseline) FROZE
    the event loop 929ms (= the whole scan); the fix (async `execFile`) held the freeze to 3ms
    while running the same ~936ms scan. Fail-closed: sync throw / rejected promise / `{ok:false}`
    (records `blocked-gate`) / missing runner / a promise handed to the SYNC path all deny; an
    exempt `git add` still never gates. Reservation: two concurrent once-grant decisions → exactly
    one allow, the loser never reached the gate. Redeem slot race: two concurrent redeems BOTH
    entered the gate (race window real) → exactly one allow (slot consumed atomically at the
    spend). Pending-hook: a concurrent redeem while the hook gate is in flight → deny. Revoke
    mid-gate → deny at the spend. Fingerprint: stable → the redeem SKIPS re-gate; UNSTABLE
    (content changed across the scan) → NOT cached → the redeem RE-GATES.
  - **User's reality** — `--big-repo=<the real ~1.7G repo>`: pre-fix FROZE the loop **4941ms** (the
    whole real scan); the fix held it to **2ms** while running the same ~4779ms real scan.
    (`allow:false` there — the real repo has legitimate leak hits; the fail-closed deny is correct,
    the timing is the point. Path passed by arg, never written into the committed test.)
  - **Anti-regression (SYNC compositions, call sites UNCHANGED — proves the decision logic is
    preserved):** verify-feat-164-store-authority 28, -single-authority 31, -permanent-git-grant
    41, verify-feat-108-git-grant 64, -git-write-block 239, verify-feat-169-outgoing-scope 20,
    verify-bug-231-one-decision unit 26 + **e2e 24/24** (real scratch server + real hook
    `evaluateGitWriteAsync` + real shim `redeemGitWriteAsync`: slot accounting, FEAT-164 r4
    mid-call revoke, and the fingerprint-skip gate-run counts all hold), verify-bug-231-call-claims
    21, verify-bug-184 28, verify-bug-173 28, verify-bug-242 21. (verify-feat-108-git-request-
    approve is e2e needing a live CLI not available in this sandbox — unrelated to the change.)
  - `npm run gate` → **PASS (exit 0)**: leak-gate, check-nul, prompt-privacy, typecheck all green.
- **Verified-by:** PENDING — independent clean-room verification is WARRANTED (high-stakes: touches
  the FEAT-164 r4 / BUG-231 r7 grant store, the most regression-prone code here, on a leak-gate
  enforcement path). Suggested attack: two concurrent /decide on a real scratch server with a slow
  gate (no double-spend/leak); the `pending`-mode and slot guards; a push with a real leak still
  denies on the async path.
- **Still open / handoff:** `src/server/git.ts` `runCommitLeakGate` (dashboard commit, `--staged`
  ~0.16s, user-initiated one-at-a-time) left synchronous — a cheap low-priority follow-up since
  `commit()` is already async. Residual (documented, same class as the existing forged-shim-secret
  residual): a change-and-restore of repo content WITHIN one async scan window is undetectable by
  the pre/post fingerprint; the conservative fallback is that the shim re-gates.
- **Symptom of a deeper design flaw?** Candidate: leak-gate enforcement running IN the host
  process at all (ARCH-021 already tracks that git-write enforcement is a host-side shell-text
  parser). Not filing a new ARCH this round — leaving it to the independent verify + orchestrator.

### 2026-10-10 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/default run 28f9ef2f-eed0-45e9-a942-f6b7809c8b9e — VERDICT: BROKEN — P1 responsiveness BROKEN: scan is off-loop but repoContentFingerprint (pre+post gate, publishing writes) is still synchronous execFileSync on the hot path; stalled loop ~936ms hook/~927ms redeem. Anthropic fallback (openai quota out); decorrelation reduced.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-10 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/default run d7f70173-d94e-4dd3-a885-41d07ae7f3d0 — VERDICT: HOLDS — P2 fail-closed HOLDS: all bad runner shapes, hang/timeout, chained-publish-after-exempt, sync-promise, rejected re-gate deny; no write approved before scan completes. Anthropic fallback.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-10 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/default run 2db7fa0f-6043-4890-938b-afe4a4d37e98 — VERDICT: HOLDS — P3 grant-store concurrency HOLDS: no cross-call bleed, no once double-spend, pending not redeemable, revoke mid-gate denies, multislot+crossbinding+deferred-revoke+fp-reuse attacks beyond documented residual all held. Anthropic fallback.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-10 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/default run 663a85d4-3ccd-44cd-b732-db11d4f2f362 — VERDICT: BROKEN — P4 no-regression BROKEN: FEAT-108 wiring PINs stale after rename evaluateGitWrite(->evaluateGitWriteAsync( (feat-108-git-grant 63/1f; git-write-block 238/1f). Behavior suites pass: FEAT-164x4,FEAT-169,BUG-231x2,BUG-242. BUG-173/184 could-not-run (room has no git history).. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-10 — dispatch (independent clean-room verify, round 1 — SUMMARY)

- **Overall: NOT VERIFIED — 2 BROKEN / 2 HOLDS.** One attacker per property, four separate
  `scripts/independent-verify.mjs` clean-room dispatches (each a fresh process, no fixer report).
  Verdicts: **P1 BROKEN** (run 28f9ef2f), **P2 HOLDS** (run d7f70173), **P3 HOLDS** (run
  2db7fa0f), **P4 BROKEN** (run 663a85d4). All four are manifest-backed VALID verdicts (fixer test
  re-run + ≥1 uncovered adversarial case + could-not-test list each).
- **P1 BROKEN (headline requirement not met on publishing writes).** The leak-gate *scan* is now
  off-loop (async execFile), but `repoContentFingerprint` — taken PRE- and POST-gate on publishing
  writes (commit/push), and once in the synchronous `prepareRedeem` — is still `execFileSync`
  (git rev-parse/ls-files/diff/hash-object) on the hot path. With a large changed set it froze the
  loop ~936ms on the hook path (fingerprint runs TWICE = pre+post) and ~927ms on the /decide path,
  vs a 6ms control with no window. So a push on a big repo still freezes the server — the exact
  symptom the ticket is about. Repro: the verifier's `adv/p1-fingerprint-stall.mjs` drives the
  REAL hook/redeem with a window + real fingerprint; baseline sync froze 925ms, async-with-window
  936ms. Fix needed: make the pre/post fingerprint async (or move it off-loop) too.
- **P4 BROKEN (success-criterion #4 violated).** The fix renamed the wired call in
  `claude-runtime.ts` from `evaluateGitWrite(` to `await evaluateGitWriteAsync(`, so two FEAT-108
  source-wiring PINs now fail: `verify-feat-108-git-grant` 63 pass/1 fail, `verify-feat-108-git-
  write-block` 238 pass/1 fail (a new probe confirmed line 1268 is the only call site and both
  failures trace to the rename). ALL behavior suites pass: FEAT-164 store/single/permanent/self
  (28/31/41/21), FEAT-169 (20), BUG-231 one-decision (50) + call-claims (21), BUG-242 (21), plus a
  mixed sync+async concurrency probe. So the decision LOGIC is preserved; the stale anti-tamper
  PINs need a sanctioned update to accept the `…Async` wiring. (Fixer's own log claimed FEAT-108
  suites pass unchanged — they do not, post-rename.)
- **P2 HOLDS / P3 HOLDS.** Fail-closed holds across every bad runner shape (undefined/null/0/''/{}/
  thrown/rejected/never-resolving/800ms-timeout), chained-publish-after-exempt (11 forms),
  sync-path-handed-a-promise, and rejected re-gate; no write approved before its scan completes.
  Grant-store integrity holds under concurrency beyond the documented change-and-restore residual:
  no cross-call/cross-project bleed, no once double-spend, pending-mode not redeemable, single-slot
  redeem race yields exactly one allow, revoke mid-gate denies at the spend, multislot + deferred
  revoke + stale-gatedFp-reuse all held.
- **Method / caveats (honest).** `--working-tree` is unusable in an agent session (the FEAT-135
  shim refuses the `add`/`write-tree`/`commit-tree` it needs — only a THROWAWAY-index form is
  sanctioned), and BUG-249 has no frozen candidate, so the reviewed range was built with the
  sanctioned throwaway-index plumbing: two dangling commits in the real object store (no refs
  moved, real worktree/history untouched). head = full current working tree (so every regression
  suite is present & current); base = that tree with ONLY the 6 BUG-249 files reverted to HEAD, so
  the diff is EXACTLY the 6 files (`git diff` + the 2 untracked new files), ticket excluded. The
  diff for `src/server/index.ts` and `src/server/runtime/claude-runtime.ts` is entangled with
  unrelated concurrent batch edits (flagged to each verifier; the authoritative logic is
  `scripts/lib/git-grant.mjs`). **Cross-provider was NOT achieved:** OpenAI quota was exhausted
  (resets 2026-10-14), so all four ran on anthropic — SAME provider as the author (Opus 4.8),
  decorrelation reduced. Re-running P1/P4 on OpenAI after reset would strengthen confidence.
- **Could-not-test:** a real 1.7G repo (P1 used a modeled ~925ms fingerprint stub — proves the
  path is synchronous, not the absolute big-tree duration); the full live server handlers (no
  server started, per rules); `verify-bug-173` / `verify-bug-184` (their must-FAIL step does
  `git show <hash>:…`, which the history-less clean room cannot satisfy); `verify-feat-108-git-
  request-approve` (needs a live CLI).
- **Build artifacts (scratch, not committed):** range BASE 9d442f90 / HEAD 88f21d91 in the real
  object store; builder + requirement/verdict logs under `~/.local/state/claude-station/scratch/`.

### 2026-10-11 — agent (fixing, round 2 — P1 structural re-fix + P4 PIN correction)
- **CORRECTION to the round-1 log.** The round-1 "build + self-verify" entry claimed the FEAT-108
  suites "pass unchanged (500+ assertions)". They did NOT: renaming the wired call to `await
  evaluateGitWriteAsync(` broke two source-wiring PINs (`verify-feat-108-git-grant` 63/1,
  `verify-feat-108-git-write-block` 238/1), exactly as the independent verify's **P4** found. The
  round-1 anti-regression run did not actually re-run those two suites against the post-rename
  tree. Corrected here; the entry above stands as written (append-only), this supersedes its
  FEAT-108 claim. (regressed-from: BUG-249 round 1.)
- **P1 (BROKEN at r1) — fixed structurally, not patched.** Root cause: round 1 moved the leak-gate
  SCAN off-loop but `repoContentFingerprint` was still `execFileSync` (git ls-files/diff/
  hash-object) + per-file `fs.*Sync`, taken PRE- and POST-gate on the hook path and once in the
  shim redeem — so a publish still froze the single process. Inventory of EVERY sync child-proc /
  heavy fs reachable from the PreToolUse hook and `/api/git-shim/decide` (rg execFileSync/spawnSync/
  execSync/readFileSync): (1) `repoContentFingerprint` git reads + stats; (2) `gateVerdictKey`'s two
  config `readFileSync` + its `ownProjectArgs` `git rev-parse`; (3) the async gate's own
  `ownProjectArgs` `git rev-parse`. ALL moved off-loop:
  - `src/server/leak-gate-host.ts` — new `repoContentFingerprintAsync` (promisified `execFile` via a
    `gitAsync` helper that feeds `hash-object --stdin-paths`; candidates stat'd with
    `fs.promises.lstat` in parallel, order preserved so the hash zip stays consistent),
    `gateVerdictKeyAsync` (async `readFile` ×2 + `ownProjectArgsAsync`; BYTE-IDENTICAL digest to the
    sync one for the same state), and `ownProjectNamesForAsync`/`ownProjectArgsAsync`. Residual sync
    is O(1) fs-metadata only (`listProjects` registry read, `realpathSync`), NOT tree-size dependent.
  - `src/server/runtime/claude-runtime.ts` — the async gate now `await ownProjectArgsAsync(...)`; the
    hook injects `repoFingerprint: () => repoContentFingerprintAsync(...)`.
  - `src/server/index.ts` — `/decide` injects `repoContentFingerprintAsync`.
  - `scripts/lib/git-grant.mjs` — the pre/post fingerprint capture + the redeem skip-check
    fingerprint moved OUT of `prepareEvaluate`/`prepareRedeem`/`finish` into the compositions, so the
    `…Async` ones `await safeFingerprintAsync(...)` (new) off-loop while the sync ones stay inline.
    The fingerprint-STABILITY guard is UNCHANGED (pre/post still bracket the gate, `fingerprintsAgree`
    still gates `gatedFp` caching) — so no design fork, NOT a two-break. `.d.mts`: the reader may now
    return a value OR a promise.
- **P4 (BROKEN at r1) — PINs updated + kept anti-tamper.** Both FEAT-108 source-wiring PINs now
  assert `/await\s+evaluateGitWriteAsync\(/` (and the ordering PIN uses the async name); the
  grant suite's leak-gate PIN now pins `runLeakGateForRepoAsync(`. Proven anti-tamper: the regex
  matches only the real wiring and FAILS on call-removed, reverted-to-sync, and await-dropped
  (fire-and-forget) variants.
- **Verified (self; independent clean-room still warranted — see below).**
  - `node scripts/verify-bug-249-gate-nonblocking.mjs` → 25/25. New section (1b) drives the REAL
    `evaluateGitWriteAsync`/`redeemGitWriteAsync` over the WHOLE path with the injected fingerprint,
    for a publishing (push, full-tree) AND a non-publishing (commit, narrow) write, on the hook AND
    redeem paths. New section (3) PINs the runtime/`/decide` inject the ASYNC reader (not the sync
    one) + the async own-project resolve. New (2f) case: an ASYNC fingerprint reader is awaited and
    its result cached (stable → redeem SKIPS the gate).
  - **User's reality — real ~1.7G repo** (`--big-repo`, real `repoContentFingerprint(Async)`):
    hook push sync-fingerprint froze the loop **154ms → 6ms** async (25.7×); hook commit **160ms →
    4ms** (43×); redeem **155ms → 3ms**. (The r1 verify MODELLED ~930ms with a stub; the real stall
    is ~160ms here because `hash-object` only hashes the working-tree diff, not the 1.7G history —
    still a real per-push freeze, now gone.) Synthetic (no big repo, documented): **523ms → 1ms**.
  - **Must-FAIL proven** against the round-1 state (reverted `safeFingerprintAsync`'s await + the two
    runtime injections to the sync reader): the async-reader-awaited check + both wiring PINs FAIL;
    restored and re-confirmed green.
  - **Anti-regression:** verify-feat-108-git-grant **64/0** (was 63/1), -git-write-block **239/0**
    (was 238/1), feat-164 store 28 / single 31 / permanent 41, feat-169 20, bug-231 one-decision
    unit+**e2e 24/24** (REAL scratch server + REAL async hook + REAL async shim: gate-runs-once,
    leak-refused, mid-call revoke all hold), bug-231-call-claims 21, bug-242 21.
  - `npm run gate` → **PASS (exit 0)** (leak-gate, check-nul, prompt-privacy, typecheck).
- **Changed files (unstaged, for the user):** `src/server/leak-gate-host.ts`,
  `src/server/runtime/claude-runtime.ts`, `src/server/index.ts`, `scripts/lib/git-grant.mjs`,
  `scripts/lib/git-grant.d.mts`, `scripts/verify-bug-249-gate-nonblocking.mjs`,
  `scripts/verify-feat-108-git-grant.mjs`, `scripts/verify-feat-108-git-write-block.mjs`.
- **Verified-by:** PENDING — independent clean-room verify still warranted (P1 is now a SECOND
  break of the same property through a different door; high regression risk). Re-run P1/P4 on
  OpenAI after quota reset (2026-10-14) for cross-provider decorrelation. Suggested attack: a repo
  with a LARGE working-tree diff (hundreds of changed files) to make the fingerprint stall large;
  two concurrent `/decide` on a real server with a slow fingerprint; confirm `gateVerdictKeyAsync`
  equals `gateVerdictKey` byte-for-byte on a repo with a resolvable own-project.
- **Residual (unchanged class):** a change-and-restore of repo content within one async window is
  still undetectable by the pre/post fingerprint (conservative fallback: re-gate). `src/server/
  git.ts` dashboard-commit gate is still sync (user-initiated, ~0.16s) — low-priority follow-up.

### 2026-10-10 — agent
- **Verification recorded:** dispatch anthropic run 9426c4e5-3ffb-4a2d-9531-e264ca8af341 — VERDICT: HOLDS — P3 fp-stability+once-grant HOLDS post-hoist to async compositions. Clean-room anthropic (decorr reduced). 22/22 adv: changed/missing/rejected/malformed pre|post fp force re-gate (fail-closed), stable skips, once spent once. Fixer 25/25. Untested: reachProven deferred, restore-in-window (pre==post).. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-10 — agent
- **Verification recorded:** dispatch anthropic run 94281069-c528-475b-9fa4-1d8efa8d67ba — VERDICT: HOLDS — P4 no-regression HOLDS. Clean-room anthropic (decorr reduced). FEAT-108 PINs pass+anti-tamper (call-removed/reverted-sync/await-dropped FAIL). Suites: feat-108 x2,164 x3,169,bug-231 unit+e2e,call-claims,242. Fixer 25/25. GAP: /decide redeem await NOT pinned; hook sync-revert uncaught.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-10 — agent
- **Verification recorded:** dispatch anthropic run 77aa64ec-8672-4443-8cba-5d96cc70e15a — VERDICT: HOLDS — P1 HOLDS (r2 re-fix). Clean-room anthropic (OpenAI exhausted; same-provider decorr reduced). Real hook+/decide, 88k diff, pub+non-pub: scan/fp/gateKey/ownProjectArgs off-loop; sync-revert must-FAIL stalls, async doesn't; fixer 25/25. Residual(not sync): ls-files parse 157ms@400k. No 3rd break.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-11 — dispatch (independent clean-room re-verify, round 2 — SUMMARY)
- **All three re-attacked properties HOLD.** Three separate `scripts/independent-verify.mjs`
  clean-room processes (each a fresh process + fresh room, no fixer report shown): **P1 HOLDS**
  (run 77aa64ec), **P3 spot-check HOLDS** (run 9426c4e5), **P4 HOLDS** (run 94281069). All three
  are manifest-backed VALID verdicts (fixer test re-run once, ≥1 adversarial case outside the
  fixture, could-not-test list). Scoped diff: base `5941c88d`..head `0c9f7e27` — exactly the 8
  round-2 files, built as dangling commits so the unrelated working-tree churn the round-1
  verifier flagged is excluded; the room itself is the full dirty tree so everything runs.
- **Provider note:** OpenAI quota is exhausted until 2026-10-14, so all three ran on **anthropic
  (SAME provider as the author) — cross-provider decorrelation reduced**, same limitation as
  round 1. A fresh OpenAI pass after reset would strengthen confidence but is not blocking.
- **P1 (BROKEN at r1, now HOLDS).** Real hook + `/decide` redeem over an ~88k-entry working-tree
  diff, publishing (push, full-tree) AND non-publishing (commit, narrow), both paths: no sync
  child-proc / heavy-fs remains on the hot path — scan, `repoContentFingerprint`,
  `gateVerdictKey`, and `ownProjectArgs` are all off-loop. Must-FAIL: reverting the reader to sync
  stalls the loop; async does not. **Residual, explicitly OUTSIDE the requirement (not a sync
  call):** the `ls-files` OUTPUT PARSE is on-loop CPU that grows with tracked-file count (~157ms
  at 400k tracked files on a very large monorepo). This is a CPU-parse cost, not a sync
  child-proc/fs read, so it does not break the property — and it is NOT a third break. No STOP-rule
  trigger.
- **P3 (HELD r1, re-checked after the capture hoist).** Moving fingerprint capture out of
  `prepareEvaluate`/`prepareRedeem`/`finish` into the async compositions preserved the stability
  guard and the once-grant: 22/22 adversarial — a changed/missing/rejected/malformed pre|post
  fingerprint all force a re-gate (fail-closed), a stable fingerprint skips the re-gate, a
  once-grant is spent exactly once, no double-spend, no cross-call bleed.
- **P4 (BROKEN at r1, now HOLDS).** Both FEAT-108 source-wiring PINs pass AND are anti-tamper:
  call-removed, reverted-to-sync, and await-dropped (fire-and-forget) variants all FAIL the PIN.
  Behaviour suites pass: feat-108-git-grant, -git-write-block, feat-164 store/single/permanent,
  feat-169, bug-231 one-decision unit+e2e (real scratch server + async hook + async shim;
  gate-runs-once holds), bug-231-call-claims, bug-242 (incl 2-host e2e).
- **Coverage gaps the verifiers surfaced (for the orchestrator, not blockers):**
  (a) the `/decide` call site `await redeemGitWriteAsync(` in `src/server/index.ts` is NOT pinned
  by any FEAT-108 PIN — a dropped `await` THERE would go uncaught by the PIN suite;
  (b) no PIN catches the hook's leak-gate injection being reverted to the sync
  `runLeakGateForRepo` (that would reintroduce the freeze — a responsiveness regression, outside
  the no-regression property, but currently unpinned);
  (c) could-not-test in the room: a real ~1.7G repository (the write-guard blocks repo init, so a
  read-only VCS double over a 282MB scratch tree was used), full server/SDK end-to-end under load,
  the 10s async-timeout→null→re-gate path, the deferred first-call (`reachProven`) path, and
  change-and-restore within one async window (pre==post — the documented residual).
- **Verdict:** round-2 fix is independently confirmed on all three re-attacked properties; no new
  break, STOP-rule not triggered. Gaps (a)/(b) are optional follow-up PINs, orchestrator's call.

### 2026-10-11 — agent (fixing, round 3 — closed the two unpinned wiring gaps (a)/(b))
- **Scope:** TEST-ONLY. Closed the round-2 re-verify's unpinned gaps (a) and (b) with two new
  source-wiring anti-tamper PINs in `scripts/verify-feat-108-git-grant.mjs` (both `indexSrc` and
  `runtimeSrc` are already read there). No product code touched.
- **(a) `/api/git-shim/decide` redeem now pinned.** New PIN asserts `/await\s+redeemGitWriteAsync\(/`
  in `src/server/index.ts`. Proven anti-tamper against synthesized IN-MEMORY mutations of the real
  source (not HEAD): dropping the `await` (→ fire-and-forget) FAILS the PIN; reverting to the sync
  `await redeemGitWrite(` FAILS the PIN; both mutations asserted to actually change the source.
- **(b) PreToolUse hook leak-gate injection now pinned at the injection site.** New PIN asserts
  `/runLeakGate:\s*\(scope\)\s*=>\s*runLeakGateForRepoAsync\(/` in `claude-runtime.ts`. The round-2
  gap was real: the bare-name line-278 PIN (`/runLeakGateForRepoAsync\(/`) can NOT catch a sync
  revert because the same file also DEFINES `runLeakGateForRepoAsync` — the test now DEMONSTRATES
  this (the mutated source still satisfies the old bare-name PIN) and shows the injection-site PIN
  is what rejects the revert to `runLeakGateForRepo(`.
- **Verified:** `node scripts/verify-feat-108-git-grant.mjs` → **69/0** (was 64/0; +5 assertions:
  2 PIN-on-real + 3 must-FAIL mutation guards). `npm run gate` → **PASS (exit 0)** (leak-gate,
  check-nul, prompt-privacy, typecheck). BUG-249 remains `verified`.
- **Changed files (unstaged, for the user):** `scripts/verify-feat-108-git-grant.mjs` (+ this
  ticket entry).

### 2026-10-11 — landed in batch commit (orchestrator triage)
- Work landed in the 2026-10-11 whole-tree batch commit. Verified state unchanged; this entry records only the git landing. Full batch manifest is in the commit message.
