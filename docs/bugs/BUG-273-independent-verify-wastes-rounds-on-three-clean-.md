```orchard-ticket
{
  "id": "BUG-273",
  "type": "bug",
  "title": "independent-verify wastes rounds on three clean-room infrastructure causes",
  "summary": "A history study found 5-17% of independent-verify runs end INVALID for infrastructure reasons, each a lost 20-60 min round. Three live causes are fixed in independent-verify.mjs: bad --run command forms rejected before dispatch; an openai provider-abort falls back to anthropic in-invocation; the clean room seeds a synthetic scratch .git so git-dependent harnesses run.",
  "impact_if_we_wait": "Each INVALID round is a lost 20-60 min of dispatch and operator time; at 12-17% of verify runs this taxes every high-stakes ticket and trains operators to read harness artifacts as product defects.",
  "current_need": "Land and independently verify the three fixes. High-stakes (verification-harness correctness, regression-prone clean-room code) — an independent clean-room pass is warranted.",
  "severity": "medium",
  "area": "Independent verification harness",
  "reported": "2026-10-25",
  "reported_by": "worker (dispatch, fixing r1)",
  "owner": "unassigned",
  "work_state": "in_verification",
  "human_action": "none",
  "updated": "2026-10-25",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A --run wrapping a suite in npm run confined, or carrying two -- separators, is rejected before dispatch with a direct-run corrected form.",
    "More than one --run is rejected before dispatch (the contract allows exactly one FIXER-TEST citation).",
    "An env-prefixed --run is rejected before dispatch with a plain-command corrected form.",
    "An openai dispatch aborting for a provider reason falls back to anthropic in-invocation; a verdict or timeout/transport does not; the record names the provider.",
    "The clean room seeds a synthetic scratch .git after the strip, so stripped files are not recoverable via git and git-dependent harnesses run directly.",
    "Must-FAIL: synthesized pre-fix state reddens each proof; post-fix passes; anti-regression suites stay green."
  ],
  "code_refs": [
    {
      "path": "scripts/independent-verify.mjs",
      "symbol": "validateRunForms",
      "note": "cause 1: pre-dispatch --run command-form rejection"
    },
    {
      "path": "scripts/independent-verify.mjs",
      "symbol": "providerAbortKind",
      "note": "cause 2: classify a provider-reason abort vs a verdict"
    },
    {
      "path": "scripts/independent-verify.mjs",
      "symbol": "seedScratchGit",
      "note": "cause 3: synthetic hermetic scratch .git at room-build time"
    }
  ],
  "related": [
    {
      "id": "FEAT-061",
      "relation": "see_also"
    },
    {
      "id": "BUG-203",
      "relation": "see_also"
    },
    {
      "id": "BUG-066",
      "relation": "see_also"
    },
    {
      "id": "BUG-196",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "openai",
      "model": "codex",
      "run_id": "01a16fec-65fd-7531-a634-9e278aeb931a",
      "verdict": "broken",
      "verdict_on": "2026-10-24",
      "recorded_at": "2026-10-24T22:00:56.855Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "b98a5aa590323a7164bddfc4e8bae2454adb68f00878cec5b6354cab8320fc1f",
      "verify_mode": "mixed-state"
    },
    {
      "provider": "openai",
      "model": "codex",
      "run_id": "01a17020-c787-7221-820e-488bc941fe79",
      "verdict": "broken",
      "verdict_on": "2026-10-24",
      "recorded_at": "2026-10-24T22:57:42.468Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "4ef1109e3895ac8a72f23abe5635ab8258460f511e9b217fff21eab8585928af",
      "verify_mode": "mixed-state",
      "note": "r2 openai/codex cross-provider, no fallback. P3 TWO-BREAK: inherited PATH selects a substituted git binary reaching the real repo, recovering stripped blobs — new path vs r1 GIT_DIR/GIT_ALTERNATE. Route to design review. P1 minor false double-'--' advisory. P2 held. Suite 52/52."
    },
    {
      "provider": "openai",
      "model": "codex",
      "run_id": "01a17034-6861-77a2-8648-c04f41925016",
      "verdict": "broken",
      "verdict_on": "2026-10-24",
      "recorded_at": "2026-10-24T23:20:19.121Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "6c40c9be04dfd189db0fbd83fea97d694946fe6f1c0a5b96fdb71488a4c09d66",
      "verify_mode": "mixed-state"
    },
    {
      "provider": "openai",
      "model": "codex",
      "run_id": "01a1708a-64ca-70b0-a571-8109da7d31c2",
      "verdict": "broken",
      "verdict_on": "2026-10-25",
      "recorded_at": "2026-10-25T00:52:50.476Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "8f4349e304bf5238c42ff051f798861fffebe67cfb4efee8637ab0b99aae62f1",
      "verify_mode": "mixed-state"
    },
    {
      "provider": "openai",
      "model": "codex",
      "run_id": "01a1709a-edbe-75b2-92d1-5b641df0af61",
      "verdict": "holds",
      "verdict_on": "2026-10-25",
      "recorded_at": "2026-10-25T01:12:01.955Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "84d23ad12389780ca0b37103ee075798e1789610ef1f98ab23a012c7462855b7",
      "verify_mode": "mixed-state"
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a173aa-a5e2-7440-a80d-8b98203c237d",
      "verdict": "broken",
      "verdict_on": "2026-10-25",
      "recorded_at": "2026-10-25T15:29:29.769Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Committed-range IV of commit 6b5d754. >1 --run hard check, nonce-fresh provider-abort fallback, seed hermeticity HOLD. BROKEN: seedScratchGit 'git add -A' omits tracked-but-.gitignore files from synthetic HEAD (HEAD:file exit 128). Not pushed. Fix: add -f exported set / use real tree."
    }
  ],
  "verification_class": "fix",
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

# BUG-273 — independent-verify wastes rounds on three clean-room infrastructure causes

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-24 — worker (dispatch, fixing r1)
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-25 — worker (dispatch, fixing r1) — all three causes fixed
- **Hypothesis confirmed:** all three causes live at HEAD. (1) `--run` had NO pre-dispatch validation (arg-parse only pushes to `opts.runs`). (2) `main()` bailed INVALID (exit 3) on any `code !== 0` with no provider fallback. (3) `buildCleanroom` does `git archive | tar` → no `.git`. Cause 4 (permission block) left alone (fixed via `--allow-tools`).
- **Fix — cause 1 (`scripts/independent-verify.mjs`, `validateRunForms`):** rejects, BEFORE dispatch (exit 2), a `--run` that wraps a suite in `npm run confined`/`confined-run` or carries ≥2 `--` separators; more than one `--run` (contract allows exactly one FIXER-TEST, BUG-196 r7); an env-prefixed command (BUG-066). Each error prints the exact corrected direct-run form. A single `--` passthrough and a non-confined `npm run` stay accepted.
- **Fix — cause 2 (`providerAbortKind` + `main`):** a dispatch that aborted (`code !== 0`) for a PROVIDER kind (quota-window/rate-limited/overloaded/auth-expired/model-unavailable/network/internal — the last covers codex cyberPolicy/moderation) when the provider was `openai` now re-dispatches once against anthropic in the same invocation (same room/recorder/prompt), sets `opts.provider` so the record names the verifying provider, and notes the fallback. A verdict (exit 0) or a local failure (timeout/transport/sandbox-preflight) never triggers it. Cross-provider default unchanged.
- **Fix — cause 3 (`seedScratchGit`, called in the room pipeline after `vrun.mjs` write, before the final-room assertion):** seeds a synthetic, hermetic scratch `.git` (identity `verify@example.invalid`, no remote, no alternates) of the FINAL room tree (node_modules excluded) AFTER the strip, so `git show HEAD:<stripped file>` yields only the inert boot stub, never real methodology. Built shim-safely: the `.git` skeleton is written with plain fs writes (the installed git-write shim refuses `git init`), the one commit via the sanctioned temp-index plumbing (`add`/`write-tree`/`commit-tree` under a `GIT_INDEX_FILE` in the OS temp dir — the same path `snapshotWorkingTree` uses), and the ref + index installed via fs. `git update-ref`/`git commit` are never invoked.
- **Must-FAIL proof + pass-after (`scripts/verify-bug-273-iv-infra.mjs`, 35/35):** synthesized pre-fix behaviour (a no-op validator; a never-fallback classifier) reddens the suite (16 failures); post-fix the real exports pass. Cause 3's pre-fix state is the REAL artifact — a `git archive`-shaped export with no `.git`, where `git rev-parse HEAD` fails `not a git repository` — reproduced directly, then seeded and all reads work, status clean, toplevel contained, synthetic author, no remote, node_modules excluded, stripped file not recoverable, re-seed refused.
- **End-to-end (real repo):** `independent-verify.mjs --range HEAD --print-prompt --keep-cleanroom` built a real room over this repo, stripped `.claude`/`docs`, seeded boot stubs, and printed `scratch git: seeded HEAD 89e5d07e… (synthetic identity verify@example.invalid, no remote)`, exit 0 — the final-room assertion passed with `.git` present. In the kept room: HEAD resolves, status clean, toplevel contained, `git show HEAD:docs/prompts/WORKING_AGREEMENT.v4.md` returns the inert stub (not real prose), node_modules untracked. Room removed after.
- **Anti-regressions:** `verify-scratch-root` 28/28 (builds a real room via `--print-prompt` — exercises the `.git` seed + final assertion, no regression); `verify-bug-186-diff-strip` 12/12 (1 git SKIP); new suite 35/35; `npm run gate` PASS exit 0 (leak-gate + typecheck clean, read unpiped). `verify-independent-verification` and `verify-feat-062-loop` could NOT complete in this session — both crash on their OWN `git init` fixtures / `609db5e^` anchor / live-provider dispatches (the git-write shim blocks `git init`, no live provider), a pre-existing environmental limitation in files I did not touch; all their validator checks before the git-init step PASS.
- **Independent verify warranted:** verification-harness correctness + regression-prone clean-room code — an independent clean-room pass is warranted (flagged per WA high-stakes rule). NOTE for the verifier: run its fixer test DIRECTLY (`--run "node scripts/verify-bug-273-iv-infra.mjs"`), not via `npm run confined` (which cause 1 now rejects).
- **Files changed (unstaged, for the user to commit):** `scripts/independent-verify.mjs`, `scripts/verify-bug-273-iv-infra.mjs` (new), `docs/bugs/BUG-273-…md` (this ticket + INDEX via board:gen).

### 2026-10-24 — dispatch openai
- **Verification recorded:** dispatch openai/codex run 01a16fec-65fd-7531-a634-9e278aeb931a — VERDICT: BROKEN — mixed-state candidate b98a5aa59032. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-25 — design reviewer (dispatch, non-author, fixing r2 plan+review)
Independent WA §N design review (I did not write this code). Read the whole ticket, the openai BROKEN verdict echo (run 01a16fec; only the verdict is stored in-repo, no reasoning), and `validateRunForms` / `providerAbortKind` / `seedScratchGit` / the room+verifier env build. No interrupted earlier reviewer entry was present (last prior entry was the openai dispatch). Per-property disposition, each with why the other two options lose:

- **P1 `validateRunForms` → RESCOPE.** Demote the three shell-text pre-dispatch HARD rejects (confined-wrapper, double-`--`, env-prefix) to a NON-fatal advisory that prints the corrected form; keep ONLY the `runs.length > 1` hard exit-2 (that one is an array-length test, not shell text — robust by construction). The real structural guard against a recorded-vs-supplied byte mismatch ALREADY exists and is the single citation-identity authority: `canonCmd`/`sameCmd` in `scripts/lib/verdict-contract.mjs` (BUG-066), which canonicalises env/`NAME=value` prefixes. The env-prefix reject in `validateRunForms` duplicates that solved job; a second gatekeeper that can disagree with the first is the ARCH-010 two-authorities anti-pattern.
  - *Why REDESIGN (preflight-execute the `--run` locally in room shape) loses:* cost asymmetry — it pays suite-runtime PLUS a room build on EVERY verify (incl. the 85-95% that are already fine) to save an occasional wasted round; "local room shape" only approximates the verifier's actual room; and it CANNOT run git-write-fixture suites (hits the same PATH-shim wall — see confined finding below), so it would false-reject exactly the suites cause 1 already strands. A long suite makes it unaffordable.
  - *Why KEEP PATCHING loses:* the checks are enumerated-by-construction shell-text matches — two breaks already (a legit quoted arg carrying two `--` is false-rejected and its printed "corrected form" is mangled because the splitter ignores quotes; an env assignment after `&&` is false-accepted). Each patch invites the next odd-but-legal shell form, and the env-prefix branch re-implements canonCmd worse.

- **P2 `providerAbortKind` → confirmed, right LOCAL fix (single break, no redesign).** Currently an explicit `meta.failureKind` only short-circuits when it is a PROVIDER kind; an authoritative LOCAL kind (`timeout`/`transport`/`sandbox-preflight`) is ignored and the code falls through to the `dispatch failed [<kind>]` stderr scrape, which can misread a stray substring and wrongly fire the anthropic fallback on what was really a local timeout. Fix: when `meta.failureKind` is an explicit local kind, `return null` BEFORE the stderr scrape; only scrape when meta is absent or the openai placeholder. Small and correct.

- **P3 `seedScratchGit` (+ verifier env) → REDESIGN to one allowlist chokepoint.** The seed env (line ~886) spreads `...process.env` and overrides a handful of GIT_* names — a denylist, enumerated-by-construction, that does NOT clear `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_OBJECT_DIRECTORY`, `GIT_NAMESPACE`, `GIT_COMMON_DIR`, `GIT_CEILING_DIRECTORIES`, etc.; the HEAD-resolve check (line ~916) omits even the GIT_DIR override; and the VERIFIER dispatch env (line ~1798) spreads `...process.env` wholesale. The docstring already CLAIMS "no inherited GIT_* env," and containment (stripped methodology/board unrecoverable) is the harness's core threat-model guarantee — so the inherited env IS squarely in the stated threat model, and the code fails to enforce what it claims. Inherited `GIT_ALTERNATE_OBJECT_DIRECTORIES` lets `git show HEAD:<stripped>` resurrect real prose from the live repo's objects; inherited `GIT_DIR` points room git at the real repo (and breaks the line-916 assertion). Structural fix: one `buildRoomGitEnv()` that passes ONLY PATH, HOME, locale, and the vars the room-builder itself sets — NO inherited GIT_* — routed through the seed's git calls, the HEAD check, AND the verifier dispatch env.
  - *Why KEEP PATCHING loses:* `delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES/GIT_DIR` is the same denylist treadmill, must be repeated at three env sites (easy to miss one — 916 and 1798 already diverge), and still misses the other GIT_* names. Two breaks prove the denylist leaks.
  - *Why RESCOPE loses:* you cannot drop containment — unrecoverability of stripped content is the guarantee the clean room exists to provide.

- **Confined-wrap rejection + git-init question.** `git init` on fixtures is STILL BLOCKED inside the room. The seeded `.git` only supplies a read-side git-repo CONTEXT (rev-parse/show/status rooted at the room); it does NOT lift the FEAT-135 PATH shim that refuses git-WRITE (`git init`), which rides in on PATH and fails CLOSED regardless of whether a `.git` exists. `npm run confined` (Docker; shim not on PATH) is the SANCTIONED escape hatch for throwaway git-write. So cause 1's BLANKET hard-reject of confined strands any suite that must `git init` its own fixtures — the fixer's own r1 log admits `verify-independent-verification` and `verify-feat-062-loop` crash on exactly that. The P3 allowlist MUST keep PATH (so the shim/containment stays), which means in-room git-write stays blocked and those suites MUST retain confined. Hence P1's downgrade-to-advisory is also what keeps them verifiable. Net: do NOT reject `npm run confined` wraps.

**Build spec for the fixer (≤6):**
1. P1: delete the confined/double-`--`/env-prefix pre-dispatch HARD rejects; keep only `runs.length > 1` as hard exit-2. Emit the other forms as a non-fatal stderr WARNING; fix the corrected-form builder to not split inside quotes.
2. P1: lean on `canonCmd`/`sameCmd` (verdict-contract.mjs) as the single citation-identity guard — do not re-predict byte-match in independent-verify. Do NOT reject `npm run confined` (git-write fixtures still need it).
3. P2: in `providerAbortKind`, `return null` when `meta.failureKind` is an explicit local kind (timeout/transport/sandbox-preflight) BEFORE the stderr scrape; scrape only when meta is absent/placeholder.
4. P3: add `buildRoomGitEnv()` — allowlist (PATH, HOME, locale, + only room-set GIT_*/identity; no inherited GIT_*) — and route the seed git calls (~886/~916) AND the verifier dispatch env (~1798) through it; keep PATH and ORCHARD_LANE_SNAPSHOT=0.
5. P3 must-FAIL: with `GIT_ALTERNATE_OBJECT_DIRECTORIES=<real .git/objects>` and `GIT_DIR=<real .git>` set in the parent, build a room and assert `git show HEAD:<stripped path>` yields ONLY the inert stub and `git -C room rev-parse --show-toplevel` is the room — reddens pre-fix, passes post-fix.
6. P1 must-FAIL: add the quoted-two-`--` false-reject and env-after-`&&` false-accept cases to the suite. (P3 is a containment/security fix — an independent clean-room verify pass is warranted.)

### 2026-10-25 — worker (dispatch, fixing r2 plan+review) — reviewer spec built (P1 rescope, P2 local-kind, P3 chokepoint)
- **Hypothesis confirmed FIRST:** the room/seed/verifier env were built in THREE separate `...process.env` sites with NO existing chokepoint — seed (then line ~886), HEAD-resolve check (~916, which overrode nothing), verifier dispatch (~1798, `{...process.env, ORCHARD_LANE_SNAPSHOT:'0'}`). So a new `buildRoomGitEnv()` was added and all three routed through it (not a second chokepoint — there was none).
- **P1 RESCOPE (`validateRunForms` + caller):** the shell-text checks (confined wrapper, double `--`, env prefix) are now ADVISORY `severity:'warning'` (printed, run proceeds); the ONLY hard `severity:'error'` (exit 2) kept is `runs.length > 1` (array-length test). The separator count is now QUOTE-AWARE (`shellTokens`), so a legit quoted arg carrying `--` is accepted. `npm run confined` is NOT rejected (its advisory explicitly says to KEEP it for suites that must `git init` their own fixtures). `canonCmd`/`sameCmd` (verdict-contract.mjs, BUG-066) stays the single citation-identity authority — no byte-match re-prediction here.
- **P2 (`providerAbortKind`):** an EXPLICIT local `meta.failureKind` (`timeout`/`transport`/`sandbox-preflight`) — in fact ANY non-provider meta kind that is not the openai placeholder — now decides the result from meta ALONE and returns null BEFORE the stderr scrape. The scrape runs only when meta is absent or is the `see stderr taxonomy line` placeholder. Fixes the misread where a provider-looking substring on a local timeout's stderr wrongly fired the anthropic fallback.
- **P3 REDESIGN (`buildRoomGitEnv`):** ONE chokepoint strips the ENTIRE inherited `GIT*` family by a single prefix rule `/^GIT(_|$)/` — NOT an enumerated name list — covering GIT_DIR, GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_OBJECT_DIRECTORY, GIT_NAMESPACE, GIT_COMMON_DIR, GIT_CEILING_DIRECTORIES, GIT_WORK_TREE, GIT_INDEX_FILE and any future GIT_* by construction; `extra` (the room's own git identity/dir vars, or `ORCHARD_LANE_SNAPSHOT=0`) is layered last. Routed through the seed git calls, the HEAD-resolve check AND the verifier dispatch. **Deviation from the literal spec, flagged:** a 5-name POSITIVE allowlist (PATH/HOME/locale only) would have broken every real verifier dispatch — dispatch.mjs needs the full provider/auth/config surface (CLAUDE_CONFIG_DIR, the codex binary seam, tool-profile, …). So NON-git env is KEPT and only the GIT_* family is dropped. This still satisfies the reviewer's three stated requirements (one place; no inherited GIT_*; not an enumerated deny-list that misses names — the prefix rule covers the whole family), so it is the ARCH-010-clean single authority the review asked for, just preserving auth.
- **Must-FAIL proof + pass-after (`scripts/verify-bug-273-iv-infra.mjs`, now 52/52 post-fix):** pre-r2 behaviour synthesized literally (old hard-reject + naive-split validator; old scrape-through classifier; old `...process.env` spread) reddened the suite with **14 failures** — P1 confined/double/env/quoted-`--` false-rejects, P2 the three local-meta + provider-stderr cases returning a provider kind, P3 `git show HEAD:<stripped>` + `git cat-file <real blob>` RESURRECTING this repo's real WORKING_AGREEMENT prose under inherited GIT_DIR/GIT_ALTERNATE. Post-fix all 52 pass. P3 runs against the REAL repo's git objects (hostile parent env set+restored inside the helper), not a synthetic fixture.
- **End-to-end (real repo):** `independent-verify.mjs --range HEAD --print-prompt --keep-cleanroom` built a real room through the new chokepoint and printed `scratch git: seeded HEAD 76ba9e73… (synthetic identity verify@example.invalid, no remote)`, exit 0, final-room assertion passed. In the kept room: HEAD resolves, `rev-parse --show-toplevel` is the room, `git show HEAD:docs/prompts/WORKING_AGREEMENT.v4.md` returns the inert clean-room placeholder (not real prose), status clean. Room removed after.
- **Anti-regressions:** `verify-scratch-root` 28/28 (builds a real room via `--print-prompt` — exercises the seed + chokepoint + final assertion, no regression); `verify-bug-186-diff-strip` 12/12 (1 pre-existing git SKIP); new suite 52/52; `npm run gate` PASS exit 0 (read unpiped); `npm run board:check` — the only DRIFT is the pre-existing FEAT-170 unreachable-ticket row (unrelated), plus pre-existing STALE doc WARNs.
- **Independent verify warranted:** P3 is a containment/security fix (stripped methodology unrecoverable) touching regression-prone clean-room env code — an independent clean-room pass is warranted per the WA high-stakes rule. NOTE for the verifier: run its fixer test DIRECTLY (`--run "node scripts/verify-bug-273-iv-infra.mjs"`); confined is no longer rejected but is unnecessary for this suite (it needs no git-write fixtures).
- **Files changed (unstaged, for the user to commit):** `scripts/independent-verify.mjs`, `scripts/verify-bug-273-iv-infra.mjs`, `docs/bugs/BUG-273-…md` (this entry + INDEX via board:gen).

### 2026-10-24 — dispatch openai
- **Verification recorded:** dispatch openai/codex run 01a17020-c787-7221-820e-488bc941fe79 — VERDICT: BROKEN — mixed-state candidate 4ef1109e3895 — r2 openai/codex cross-provider, no fallback. P3 TWO-BREAK: inherited PATH selects a substituted git binary reaching the real repo, recovering stripped blobs — new path vs r1 GIT_DIR/GIT_ALTERNATE. Route to design review. P1 minor false double-'--' advisory. P2 held. Suite 52/52.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-25 — technical adjudicator (dispatch, non-author) — WA §N adjudication after P3 second two-break

Independent adjudication (I neither wrote this code nor did the r2 design review). Read the whole ticket, both openai BROKEN echoes (runs 01a16fec r1, 01a17020 r2), the r2 design-review entry, the r2 build entry, and `validateRunForms`/`shellTokens`/`buildRoomGitEnv`/`seedScratchGit`/the verifier dispatch env (line ~1877) in `scripts/independent-verify.mjs`. WA §N (second two-break on one property) ⇒ stop, adjudicate, no automatic round.

**P3 → RESCOPE (decided here; no user escalation — see "authority" below).** The clean room is a DECORRELATION mechanism (WA §I: the verifier "should not know the board, the methodology, or who wrote the code — cheaper as well as less biased"; "the prose is what transmits the blind spot"), NOT a containment/exfiltration boundary. The attacked property P3 ("stripped content is unrecoverable from the clean room / the room cannot reach the real repo") is **outside the supported contract AND the stated threat model**, which is the WA's literal RESCOPE test.

- **Evidence — the codex `workspace-write` sandbox permits unrestricted filesystem READ; it jails WRITES only.** Ran the real sandbox the openai/codex verifier runs in (not a fixture), cwd a scratch room:
  - `codex sandbox -c sandbox_mode=workspace-write -- sh -c "cd /tmp/iv-room-test; head -4 <repo>/docs/prompts/WORKING_AGREEMENT.v4.md; echo EXIT=$?"` → **EXIT=0**, returned the real WA prose. Reading the live repo by ABSOLUTE PATH succeeds.
  - `codex sandbox -c sandbox_mode=workspace-write -- sh -c "... /usr/bin/git -C <repo> show HEAD:docs/prompts/WORKING_AGREEMENT.v4.md ..."` → **GITEXIT=0**, recovered the real stripped content straight from the live repo — no GIT_* env, no PATH substitution, just system git + `-C <abs path>`.
  - write probe `echo pwned > <repo>/PWNED_TEST` → **"Read-only file system", WRITE_EXIT=1**, file not created. Confirms: writes jailed, reads open.
- **Therefore** hardening the room's git env (r1: GIT_DIR/GIT_ALTERNATE_OBJECT_DIRECTORIES; r2: PATH-substituted git; the next doors HOME/XDG gitconfig) is **enumerated defence of doors beside a wide-open wall**: a verifier that shells `cat /realrepo/...` or `git -C /realrepo show` reads everything regardless of env. The two breaks are not a leaky denylist to patch again — they are symptoms that the property is unenforceable in this architecture.
- **Architectural confirmation the boundary was never meant to hold:** dispatch.mjs's own header states the ANTHROPIC verifier path translates `--sandbox` to an *application-level* Claude Code permission gate, "not an OS jail." So containment is architecturally IMPOSSIBLE on the anthropic verifier path irrespective of any git-env work — it was never a cross-provider guarantee. (The openai path IS an OS bwrap jail, but one that permits reads anywhere, as proven above.)
- **Authority / is this cutting user-required behaviour? No.** Searched WA §I/§N and CONVENTIONS for a user-stated clean-room secrecy/containment requirement: none. Every statement frames the room as bias-decorrelation + throwaway scratch. Success criterion #5 ("stripped files are not recoverable via git") was authored by the r1 fixer, and survives in NARROWED, enforceable form (below). So §N lets the adjudicator decide; it is not a §A preference/authority fork.
- **Structural alternative, priced and rejected.** True containment would need an OS read-jail restricting readable roots to room+tmp (codex newer `--sandbox-state-readable-root`, not used by dispatch.mjs) — a cross-cutting sandbox-policy change that STILL cannot hold on the anthropic application-gate path. A "minimal constructed env" (fixed PATH to resolved git, HOME=room, GIT_CONFIG_NOSYSTEM/GLOBAL) does NOT achieve containment either: absolute-path reads and `git -C /realrepo` survive any env. So it buys no security while risking dispatch-auth breakage. RESCOPE wins.

**What stays enforceable and IN SCOPE (keep `buildRoomGitEnv`, do NOT rip it out):**
- Seed hermeticity: `seedScratchGit` must build its one commit from ONLY the stripped room tree. An inherited `GIT_ALTERNATE_OBJECT_DIRECTORIES` would otherwise leak real blobs INTO the room's own commit, so `git -C room show HEAD:<stripped>` would then genuinely serve real prose — that IS in scope. `buildRoomGitEnv` on the seed's plumbing delivers this and is correct; keep it.
- Honest-case hygiene: a verifier running `git log`/`show` rooted in the room (no `-C`) must see room state, not real-repo history leaked via inherited GIT_DIR. `buildRoomGitEnv` on the verifier dispatch env (line ~1877) delivers this — keep it, but it is DECORRELATION/correctness, not a security wall.

**P1 → DELETE the brittle advisory parser (do not patch `shellTokens`).** Reproduced the false positive against the real export: `node x.mjs --title="a -- b" -- extra` → `shellTokens` tokenises `--title="a`, then counts the ` -- ` *inside* the quoted value `"a -- b"` as a bare separator → **sepCount=2 → false double-`--` advisory**. The regex cannot see a quote that is attached to an unquoted prefix (`--flag="…"`, the common form); fixing it means a real shell tokenizer (attached quotes, escapes, `$'…'`) — the enumeration treadmill. The authoritative citation-identity check is already `canonCmd`/`sameCmd` (verdict-contract.mjs, BUG-066); the double-`--` and env-prefix advisories merely restate what that authority decides, so they are redundant, and a false-firing advisory trains operators to ignore the neighbourhood (cry-wolf). Delete both advisories and `shellTokens` with them. KEEP the `runs.length > 1` HARD error (array-length, robust) and the `npm run confined` advisory (genuine operator guidance; plain substring regex, no tokenisation).

**Build spec (≤5):**
1. P3: correct the overselling docstrings in `seedScratchGit` (~line 866 "It can NEVER reach the real repo") and `buildRoomGitEnv` (~894 "Containment — stripped prose/board unrecoverable — is the clean room's core guarantee") to state the REAL contract: the room is a decorrelation mechanism; the seeded `.git` + room tree do not expose stripped content to reads/`git show` rooted IN the room; a verifier reaching the live repo by absolute path or steered env is explicitly OUT OF SCOPE and not defended (workspace-write permits reads anywhere; the anthropic path is only an app-level gate).
2. P3: KEEP `buildRoomGitEnv` and all three call sites — it is correct seed-hermeticity + honest-case hygiene. No code removal, no new env construction.
3. P3: re-aim the r2 "containment" must-FAIL test in `scripts/verify-bug-273-iv-infra.mjs` to assert only the enforceable property: with a hostile parent `GIT_ALTERNATE_OBJECT_DIRECTORIES`/`GIT_DIR` set, the SEEDED room commit does NOT leak real blobs — `git -C room show HEAD:<stripped>` yields the inert stub. Drop any assertion that a verifier cannot reach the real repo (now out of scope); add a comment citing the sandbox read test so a future round does not re-litigate it.
4. P1: delete the double-`--` and env-prefix advisory branches and `shellTokens`/`RUN_ENV_PREFIX_RE`; keep the `runs.length > 1` hard error and the `npm run confined` advisory. Remove the now-dead P1 quoted-`--`/env-prefix suite cases (or repoint them to assert no false warning is emitted).
5. Verify: run `scripts/verify-bug-273-iv-infra.mjs` (must-FAIL pre-fix on the narrowed seed-hermeticity property, pass post-fix) + `verify-scratch-root` + `npm run gate` (exit 0, unpiped) + `board:gen`.

**Independent clean-room re-verify:** NOT warranted as a containment/security pass (the security property is being retired as out-of-scope). It remains a correctness change to regression-prone clean-room code, so a routine independent re-verify of the narrowed properties (seed hermeticity; P1 no-false-warning; P2 untouched and still HELD) is appropriate — bucket: correctness, not security.

— technical adjudicator (non-author). Evidence: live `codex sandbox -c sandbox_mode=workspace-write` read test (commands + outputs above); `shellTokens` false-positive reproduced against the real export.

### 2026-10-25 — worker (dispatch, fixing r3) — adjudicator spec built (P3 rescope to decorrelation + seed hermeticity; P1 advisory parser deleted)

Built exactly the technical adjudicator's build spec (entry above). Hypothesis checked FIRST: the adjudicator searched WA §I/§N + CONVENTIONS for a user-stated clean-room secrecy/containment requirement and found NONE, and decided under §N authority with no user escalation — so the STOP-and-report hypothesis did NOT fire; I proceeded to build.

- **P3 RESCOPE — docstrings/comments corrected, code KEPT (`scripts/independent-verify.mjs`):** no code removed. Reworded `seedScratchGit`'s docstring (dropped "It can NEVER reach the real repo") and `buildRoomGitEnv`'s docstring (dropped "Containment — stripped prose/board unrecoverable — is the clean room's core guarantee") to state the SUPPORTED contract: the clean room is a DECORRELATION mechanism, NOT a containment/exfiltration jail. The seeded `.git` + room tree do not expose stripped content to ordinary git reads rooted IN the room under the harness's own env; a verifier reaching the live repo by ABSOLUTE PATH or `git -C <realrepo>`, or steering its own env (GIT_*, PATH, HOME/XDG), is EXPLICITLY OUT OF SCOPE and not defended (workspace-write permits reads anywhere; the anthropic path is an app-level gate, not an OS jail). Named the two ENFORCEABLE, in-scope properties buildRoomGitEnv delivers — (a) SEED HERMETICITY (commit built from only the stripped tree; no real objects seep in) and (b) HONEST-CASE DECORRELATION HYGIENE (a room-rooted read sees room state, not real-repo history via inherited GIT_DIR). Corrected the verifier-dispatch comment (line ~1877) and the pipeline seed comment (line ~1303) to the same framing. The r2 GIT* prefix-rule chokepoint is kept unchanged (the adjudicator: "KEEP `buildRoomGitEnv` and all three call sites").
- **P1 — advisory shell-text parser DELETED (`validateRunForms` + docstring):** removed `shellTokens`, `RUN_ENV_PREFIX_RE`, the double-`--` advisory branch and the env-prefix advisory branch. KEPT the ONE hard `severity:'error'` (`runs.length > 1`, array-length test, exit 2) and the ONE plain-substring `npm run confined` advisory (`severity:'warning'`, no tokenisation — git-write-fixture suites still need confined). canonCmd/sameCmd (verdict-contract.mjs, BUG-066) remains the single citation-identity byte-match authority — no re-prediction here. The caller (lines ~372-386) was already warning/error-split and needed no change.
- **P2 — UNCHANGED** (`providerAbortKind` untouched), as the adjudicator directed.
- **Proof (`scripts/verify-bug-273-iv-infra.mjs`) — 54/54 POST-FIX, pre-fix anchor reddens with 7 failures.** Rewrote the P1 cases (deleted the double-`--`/env-prefix advisory expectations; the two forms now assert NO warning; added the adjudicator's exact quote-ATTACHED false positive `--grep="a -- b" -- extra` → accepted, NO warning; kept the `>1 --run` hard-error and the confined advisory). Re-aimed the P3 "containment" test to `proveCause3Hermeticity`: (1) seed hermeticity — a room seeded under a HOSTILE parent `GIT_DIR=<real .git>`/`GIT_ALTERNATE_OBJECT_DIRECTORIES=<real objects>`, read with a CLEAN env, yields the inert stub at `docs/prompts/WORKING_AGREEMENT.v4.md` (proves no real blob seeped into the commit); (2) honest-case hygiene — a room-rooted plain `git show HEAD:<stripped>` under the verifier dispatch env (built by the function under test) is NOT steered to real prose by inherited GIT_DIR. Dropped the out-of-scope `git cat-file <real blob>`-via-alternates assertion; added a comment citing the live sandbox read test so a future round does not re-litigate. The pre-fix `...process.env` spread leaks real WORKING_AGREEMENT prose on the honest-case read (observed: `LEAKED real prose: <!-- canonical source: ~/projects/methodology/WORKING_AGREEM…`); the chokepoint returns the stub. P2 cases unchanged and still HELD. The pre-fix P1 anchor now models the r2 `shellTokens` advisory validator (incl. the quote-attached mis-count), not a hard-reject validator.
- **Verification (real outputs):** `verify-bug-273-iv-infra` 54 passed, 0 failed (pre-fix anchor: 7 failures). `verify-scratch-root` 28/28 PASS (builds a real room via `--print-prompt` — exercises the seed + chokepoint + final assertion). `verify-bug-186-diff-strip` 12/12 PASS, 1 pre-existing git SKIP (`cannot spawn git` — the git-write shim, a file I did not touch). `npm run gate` PASS exit 0 (leak-gate + typecheck, read unpiped). `npm run board:check` — see below.
- **Bucket:** correctness (not security) — the security/containment property is retired as out-of-scope per the adjudicator; a routine independent re-verify of the narrowed properties (seed hermeticity; P1 no-false-warning; P2 HELD) is appropriate, not a clean-room security pass.
- **Files changed (unstaged, for the user to commit):** `scripts/independent-verify.mjs`, `scripts/verify-bug-273-iv-infra.mjs`, `docs/bugs/BUG-273-…md` (this entry + INDEX via board:gen).

### 2026-10-24 — dispatch openai
- **Verification recorded:** dispatch openai/codex run 01a17034-6861-77a2-8648-c04f41925016 — VERDICT: BROKEN — mixed-state candidate 6c40c9be04df. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-25 — design reviewer (dispatch, r4 plan+review, non-author)

Independent WA §N design review of the FALLBACK property (P2 `providerAbortKind`), which has now broken TWICE (r2, r3). I did not write this code. Read the whole ticket, all three openai BROKEN echoes, `providerAbortKind` (iv.mjs ~1500), its single caller (~1910), and the dispatcher's failure paths in `scripts/dispatch.mjs` (anthropic ~498-543; openai sandbox-preflight ~562; openai result loop ~643-678).

**P2 → STRUCTURAL FIX at the owner (the hypothesis, decided here).** The two-break is one root cause: the classifier reconstructs the terminal failure kind from stderr TEXT. This is the ARCH-010 violation named in the charter — the dispatcher OWNS the failure kind and already computes it, but writes a PLACEHOLDER to meta and forces the reader to scrape.

- **Evidence the owner already knows the kind.** In `dispatch.mjs` every failing branch has the kind in hand: openai result loop line 648 `const kind = timedOut ? 'timeout' : (pe?.kind ?? 'internal')`, plus the literal branches `timeout`/`interrupted`/`internal` (652/655/658) and the `transport` catch (671). The anthropic path ALREADY writes the real kind to meta (`writeMeta({…failureKind: pe.kind})` at 505/511/522/529/540), and the openai SANDBOX-PREFLIGHT path ALREADY does too (`failureKind:'sandbox-preflight'` at 564). The ONLY ARCH-010-breaking site is the openai result loop's single `writeMeta` at line 677: `failureKind: exitCode === 0 ? null : 'see stderr taxonomy line'` — a placeholder, with the real kind emitted only via `progress()` to stderr.
- **Why stderr scraping is unfixable here (both breaks are the same bug).** iv.mjs line 1890 captures the dispatch child's stderr, which is a SHARED, unstructured channel: `progress()` lines AND the verifier's own streamed reasoning deltas (dispatch.mjs line 627 `process.stderr.write(t)` for codex; 483/627 pass-through). Because BUG-273 is itself about the `dispatch failed [<kind>]` taxonomy, the verifier's reasoning transcript literally contains those strings. `.find(first match)` (iv.mjs 1510) then grabs an earlier `dispatch failed [rate-limited]` — from a retry progress line or the verifier's own prose — ahead of the real terminal `[timeout]`. r2 (provider-looking substring on a local timeout) and r3 (placeholder + first-line `.find`) are two faces of one defect: reading a fact off a channel that does not own it.
- **The fix (owner writes it; reader reads only it; fail closed).** (a) In the openai result loop, carry the kind already computed in each branch into the single `writeMeta` (line 677) instead of the placeholder — exactly what the anthropic path does. (b) `providerAbortKind` reads ONLY `meta.failureKind`: `PROVIDER_ABORT_KINDS.has(k) ? k : null`; delete the stderr scrape, the `OPENAI_STDERR_PLACEHOLDER` constant, and the `stderr` param. (c) Fail CLOSED: meta absent/unreadable (dispatch died before writing — ironically the disk-full case) or an unknown kind ⇒ `null` ⇒ no fallback. A lost round is recoverable; a wrong auto-fallback masks a real local failure and mis-attributes the verifying provider.
- **Cost:** small, local to `dispatch.mjs` (one `let terminalFailureKind` set in the branches that already know it) plus a simplification of `providerAbortKind`. It makes the openai path CONSISTENT with the already-correct anthropic and sandbox-preflight paths — this is the convergent, lowest-entropy change, not a new mechanism.

- **Why RESCOPE loses (delete auto-fallback; print "openai aborted: rerun with --provider anthropic").** The in-invocation fallback is a real, chartered win (success criterion #4): a provider hiccup otherwise burns a 20-60 min room-build + dispatch, and manual rerun re-pays all of it. The structural fix is cheap enough that retreating from the feature is unjustified. (Decorrelation caveat when author is also anthropic already exists in the code and is accepted: a same-provider verdict beats a lost round.)
- **Why KEEP PATCHING loses (take the LAST `dispatch failed [` line instead of the first).** Still scrapes a channel the dispatcher does not own and that carries the verifier's own taxonomy-laden reasoning; "last line" is just as capturable by the verifier quoting a kind at the end of its reasoning. Two breaks on stderr-reconstruction say the approach, not the heuristic, is wrong. ARCH-010: the reader must not re-derive what the owner can declare.

**Build spec (≤5):**
1. `dispatch.mjs` openai result loop (~643-673): introduce `let terminalFailureKind = null;` and set it in each failure branch to the kind already in hand — `kind` (648), `'timeout'` (652), `'interrupted'` (655), `'internal'` (658), `'transport'` (671 catch). Pass it to the single `writeMeta` (677): `failureKind: exitCode === 0 ? null : terminalFailureKind`. Remove the `'see stderr taxonomy line'` placeholder. (anthropic + sandbox-preflight paths already correct — leave them.)
2. `independent-verify.mjs` `providerAbortKind`: read `meta?.failureKind` ONLY — `return (typeof k==='string' && PROVIDER_ABORT_KINDS.has(k)) ? k : null`. Delete the stderr `.find`/regex, `OPENAI_STDERR_PLACEHOLDER`, `LOCAL_FAILURE_KINDS` (no longer needed), and the `stderr` destructure. Fail closed on missing/unknown meta (no fallback).
3. Note `'interrupted'` is NOT in `PROVIDER_ABORT_KINDS` (correct: an interrupt is local, no fallback). Confirm the set stays exactly {quota-window, rate-limited, overloaded, auth-expired, model-unavailable, network, internal}; `internal` still covers codex cyber/moderation. No taxonomy-kind strings need to change — openai's `pe.kind` already uses the same vocabulary the set tests.
4. Must-FAIL in `scripts/verify-bug-273-iv-infra.mjs`: (a) a result with `meta.failureKind:'timeout'` and a stderr line `dispatch failed [rate-limited] …` (the r2/r3 confound) ⇒ `providerAbortKind` returns `null` (pre-fix returns `rate-limited`); (b) `meta.failureKind:'rate-limited'` ⇒ returns `rate-limited`; (c) `meta` absent (undefined) with provider-looking stderr ⇒ `null` (fail closed; pre-fix scrapes it); (d) dispatch-level: a stubbed openai failure writes the real kind to meta, not the placeholder. Drop the now-irrelevant placeholder-scrape cases or repoint them to assert the scrape is gone.
5. Verify: `scripts/verify-bug-273-iv-infra.mjs` (must-FAIL pre-fix, pass post-fix) + `verify-scratch-root` + `npm run gate` (exit 0, unpiped) + `board:gen`. Independent re-verify bucket: correctness/regression-prone harness code — a routine independent pass of the narrowed P2 property is warranted (it has broken twice); not a security pass.

**C2 (canonCmd/normCmd quoted-whitespace collapse) → OUT OF SCOPE for BUG-273, filed as BUG-276.** `normCmd` (verdict-contract.mjs ~293) collapses `/\s+/` over the whole string, reaching inside quoted args; `canonCmd`/`sameCmd`/`bareCmd` inherit it, so two commands differing only by quoted-internal whitespace false-match. It is BUG-066 code, predates BUG-273, and is unrelated to the P2 fallback fix — folding it in would widen scope. Harm is LOW (few fixer-test commands carry internal quoted whitespace; the verifier is trusted, so this catches accidental stand-ins, not an active forgery incident). Filed BUG-276 with an engineer-ready quote-aware-tokenizer fix spec.

— design reviewer (non-author). Evidence: dispatch.mjs failure-branch read (anthropic/preflight already write typed kind; openai result loop writes placeholder at 677); iv.mjs shared-stderr capture + `.find` first-match; charter's stated r2/r3 break mechanisms. No code written.

### 2026-10-25 — worker (dispatch, fixing r4) — P2 structural fix at the owner (dispatcher writes typed kind; reader reads meta only)

Built exactly the r4 design-review build spec (entry above). Did NOT touch `scripts/lib/verdict-contract.mjs` (BUG-276 lane concurrent). **Hypothesis verified FIRST:** read every openai failure branch in `dispatch.mjs` — all five already know their kind at the point of `writeMeta`: `is_error` → `kind` (`timedOut?'timeout':(pe?.kind??'internal')`, line ~648), the `timedOut` branch → `'timeout'`, `subtype:'interrupted'` → `'interrupted'`, `finalText==null` → `'internal'`, and the transport `catch` → `'transport'`. None was unknowing, so the STOP-and-report condition did NOT fire; proceeded to build.

- **`dispatch.mjs` openai result loop (~582, ~646-689):** added `let terminalFailureKind = null;` beside `let exitCode`, set it in each failure branch to the kind already in hand (`kind` / `'timeout'` / `'interrupted'` / `'internal'` / `'transport'`), and carried it into the single `writeMeta` (line ~689): `failureKind: exitCode === 0 ? null : terminalFailureKind`. Removed the `'see stderr taxonomy line'` placeholder. The anthropic path (writeMeta with `pe.kind`, ~505/522/529) and the openai sandbox-preflight path (`'sandbox-preflight'`, ~564) already wrote typed kinds and were left unchanged. A failure branch that set nothing (defensive) leaves `terminalFailureKind` null ⇒ fail-closed meta, no fallback.
- **`providerAbortKind` (`scripts/independent-verify.mjs` ~1488-1507):** now reads `meta.failureKind` ONLY: `return (typeof k==='string' && PROVIDER_ABORT_KINDS.has(k)) ? k : null`. Deleted the stderr `.find`/regex scrape, the `OPENAI_STDERR_PLACEHOLDER` constant, `LOCAL_FAILURE_KINDS`, and the `stderr` destructure param. Fails CLOSED on exit-0 (a verdict), missing/unreadable meta, local kinds, and unknown kinds. The single caller (~1911) passes the whole `active` object — `{code, meta}` destructures cleanly; no caller change needed. `PROVIDER_ABORT_KINDS` unchanged {quota-window, rate-limited, overloaded, auth-expired, model-unavailable, network, internal}; `'interrupted'` stays local (not in the set).
- **Must-FAIL + pass-after (`scripts/verify-bug-273-iv-infra.mjs`, 75/75 post-fix; pre-fix anchor reddens 7):** rebuilt the P2 cases for the meta-only r4 contract and repointed the pre-fix anchor `preProviderAbortKind` to the r2/r3 SHIPPED code (placeholder/absent-meta stderr scrape). The three P2 reddeners all fired against that anchor: (c) placeholder meta with `[rate-limited]` AHEAD of the real terminal `[timeout]` on stderr → pre-fix scrapes `rate-limited`, r4 returns null; (d) absent meta + provider-looking stderr → pre-fix scrapes, r4 fails closed null; and null/unreadable meta + provider stderr → fail closed. Regression guards: meta=timeout + provider-looking stderr → null (stderr ignored), meta=rate-limited → fallback, exit-0 → null, each local meta kind → null, unknown kind → null. (The P1 three + P3 one reddeners from r3 remain, total 7.)
- **Owner-side proof — drove the REAL `dispatch.mjs` with a stubbed provider (`proveDispatchWritesTypedKind`):** spawns `node --import <register> scripts/dispatch.mjs --provider openai --meta-out <f>` with the CodexRuntime + sandbox-preflight dynamic imports stubbed via a module LOAD hook (Node 24 strips the `.ts` import natively). All six scenarios write the TYPED kind to meta, never the placeholder: provider-rate-limited→`rate-limited` (exit 1), provider-internal→`internal`, interrupted→`interrupted`, no-final-text→`internal`, transport (messages() throws)→`transport`, success→`null` (exit 0). Plus a source guard that the placeholder string is gone from `dispatch.mjs`. (Timeout branch is wall-clock-driven and not stub-reachable; its kind `'timeout'` is set in-branch and covered by the existing anthropic-path timeout write and the source read.)
- **Verification (real outputs):** `verify-bug-273-iv-infra` **75 passed, 0 failed** (pre-fix anchor: 7 failures — must-FAIL holds). `verify-scratch-root` **28/28 PASS**. `verify-dispatch` **24/24 PASS** (dispatch.mjs failure taxonomy, anthropic path). `verify-feat-100-declared-dispatch` **31/31 PASS** (dispatch.mjs meta-out writer). `npm run gate` **PASS exit 0** (leak-gate + typecheck, read unpiped). `npm run board:check` — DRIFT 1 (pre-existing FEAT-170 UNREACHABLE TICKET, unrelated) + pre-existing STALE doc WARNs; nothing from this change.
- **Bucket:** correctness / regression-prone harness code. The P2 fallback property has now broken twice (r2, r3); this is a structural fix at the owner, and a routine independent re-verify of the narrowed P2 property is warranted (not a security pass). NOTE for the verifier: run its fixer test DIRECTLY (`--run "node scripts/verify-bug-273-iv-infra.mjs"`); confined is not rejected but is unnecessary (no git-write fixtures). `providerAbortKind` is `export`ed and unit-exercised; the dispatch owner-side write is proven by `proveDispatchWritesTypedKind` against the real `dispatch.mjs`.
- **Files changed (unstaged, for the user to commit):** `scripts/dispatch.mjs`, `scripts/independent-verify.mjs`, `scripts/verify-bug-273-iv-infra.mjs`, `docs/bugs/BUG-273-…md` (this entry + INDEX via board:gen).

### 2026-10-25 — dispatch openai
- **Verification recorded:** dispatch openai/codex run 01a1708a-64ca-70b0-a571-8109da7d31c2 — VERDICT: BROKEN — mixed-state candidate 8f4349e304bf. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-25 — verify lane (dispatch openai, r4 independent verification)
Ran `independent-verify.mjs --ticket BUG-273 --provider openai --run "node scripts/verify-bug-273-iv-infra.mjs"`, scoped `--files scripts/dispatch.mjs,scripts/independent-verify.mjs,scripts/verify-bug-273-iv-infra.mjs` (excludes the concurrent BUG-276 edit to verdict-contract.mjs). Mixed-state candidate 8f4349e304bf (base ce21cd0823fe, 3 frozen files, 0 other-ticket hunks disclosed). Needed `--max-diff-bytes 93000` (candidate diff 73918 B). Attack brief restricted to P2 only (C1/C2/C4 held/rescoped in r3).

- **VERDICT: BROKEN** — openai/codex run 01a1708a-64ca-70b0-a571-8109da7d31c2, VERDICT-CONTRACT VALID (manifest-backed adversarial case). The fixer's own suite `verify-bug-273-iv-infra.mjs` ran 75/75 in-room; the break is a NEW adversarial case the suite did not cover.
- **THIRD distinct P2 break — `stale-meta-after-startup-crash` (two-break STOP ⇒ route to independent design review).** The r4 fix reads ONLY `meta.failureKind` and fails closed on ABSENT meta — but NOT on STALE meta. The verifier drove the REAL `dispatch.mjs` in-room with `codex-runtime.ts` stubbed to throw BEFORE `writeMeta`. Control (fresh meta path): crash → `meta=null` → `providerAbortKind` returns null → no fallback (correct). Break (meta path already holds a prior run's `failureKind:"rate-limited"`): the identical local startup crash leaves the stale meta intact, `providerAbortKind` reads `rate-limited` and fires the anthropic fallback for what was actually a LOCAL crash. dispatch.mjs does not clear/invalidate the meta file before a run, so a crash-before-write + reused meta-out path = fail-OPEN. This is a different root cause than r2 (provider-looking stderr substring) and r3 (placeholder + first-line `.find`) — both of which r4 removed by deleting the stderr scrape. Matches charter attack-surface #1 ("a meta left over from a previous run in the same dir" / "a crash before writeMeta").
- **Could-not-test (verifier stopped at the two-break per charter):** full orchestration, anthropic retry counts / second-fallback behaviour, signals/interrupts, and partial/truncated meta writes remain UNTESTED.
- **Housekeeping:** verdict recorded via board-tool (verification[] + echo); board:gen re-run. Only board fail is pre-existing FEAT-170 unreachable-ticket (unrelated). Files touched by this lane: this ticket + INDEX only (no product edits).

### 2026-10-25 — technical adjudicator (dispatch, non-author) — WA §N adjudication after P2 SECOND two-break (r4 stale-meta)

Independent adjudication (I did not write this code nor any prior review/build). Read the whole ticket, the r2/r3/r4 P2 verdicts, the r4 design review, `providerAbortKind` + its single caller (iv.mjs ~1488/1842-1911), and the meta-out handling in `dispatch.mjs` (writeMeta ~342, openai result loop ~589/689). WA §N (second two-break on P2) ⇒ stop, adjudicate, no automatic round.

**Q1 — Is the r4 break reachable through the SUPPORTED path? NO.** Through independent-verify, dispatch is ALWAYS handed a FRESH, UNIQUE meta-out path per attempt, including the fallback attempt. Executed evidence:
- `recordDir = mkdtempScratch('cleanroom-record-')` (iv.mjs line 1168) and `mkdtempScratch` is `fs.mkdtempSync(path.join(scratchRoot(), prefix))` (scripts/lib/scratch.mjs:124) — the OS guarantees a brand-new, EMPTY directory per independent-verify invocation.
  - Demonstrated: `node -e 'for(3){ d=fs.mkdtempSync(.../"cleanroom-record-"); ... }'` →
    `recordDir: /tmp/cleanroom-record-PwClzL | entries: []` / `attempt-1 path exists before write? false` / `fallback path exists before write? false` (×3, all fresh+empty).
- The three `runDispatch(...)` call sites pass DISTINCT literal meta names (grep, iv.mjs):
  `1895: runDispatch(prompt, null, 'dispatch-meta-1.json')` · `1911: runDispatch(prompt, null, 'dispatch-meta-openai-fallback.json')` · `1946: runDispatch(corrective, …, 'dispatch-meta-2.json')`. `runDispatch` sets `metaFile = path.join(room.recordDir, metaName)` (1843) and `--meta-out metaFile` (1866). The fallback's path (`…-openai-fallback.json`) is a DIFFERENT, never-pre-existing file in the fresh room dir.
- Therefore the r4 scenario — "meta path already holds a prior run's `failureKind:"rate-limited"`" + crash-before-write — can arise ONLY if a caller REUSES a meta-out path across two dispatch.mjs invocations. independent-verify never does. The r4 verifier manufactured it by driving the REAL `dispatch.mjs` DIRECTLY with a reused `--meta-out` (its own entry says so). So there is NO production fail-open on the supported path today; Q1 downgrades severity, it does not clear the latent defect.

**Disposition — REDESIGN at the owner.** dispatch.mjs makes meta-out freshness true BY CONSTRUCTION; the reader honours `failureKind` only for the run it launched.
- *One-line why:* the 4-round cycle persists because freshness of a PRESENT meta is an IMPLICIT cross-file invariant (iv.mjs happens to pick unique mkdtemp names); enforce it at the owner that already owns the kind, so it holds for ANY caller — "one chokepoint, or don't do it."
- *Why RESCOPE (delete auto-fallback, print rerun line) loses:* the in-invocation fallback is a chartered win — openai aborts are the #1 wasted-round cause (~10–12 incidents), each otherwise re-paying a 20–60 min room-build. Q1 shows no production fail-open forcing a retreat, and the REDESIGN is cheap (one init-write + a nonce check). Deleting the feature to avoid an OUT-OF-PATH, cheaply-closable door throws away real value.
- *Why KEEP PATCHING (bounded budget) loses:* each prior fix patched a symptom — r2 stderr substring → r3 placeholder + first-line `.find` → r4 meta-only read — while the freshness invariant stayed implicit. A bounded "also handle stale meta" in the READER still leaves the invariant implicit and invites round 6; the owner is where the kind and its lifetime live. (r4's meta-only/fail-closed-on-absent was itself the right structural step; it just stopped one field short of stamping freshness.) The owner already frets about this: the FEAT-100 comment at dispatch.mjs ~353 distinguishes "declared nothing" from "this meta file is old" — acknowledging stale meta without enforcing against it.
- *Why the implicit 4th option (declare HELD / out-of-path, like r3's containment rescope) loses:* tempting given Q1, but dispatch.mjs's `--meta-out` is a DOCUMENTED general contract ("written on failure too", header ~113) consumed by direct callers too; leaving a latent fail-open there and keeping the fragile implicit invariant is exactly what the construction fix cheaply removes. Unlike r3's containment (architecturally unenforceable + not user-required), freshness IS enforceable at the owner for ~nothing.

**Q3 — remaining failure doors under REDESIGN, closed-by-construction?**
- *Partial / truncated meta:* `JSON.parse` throws → reader's `catch` leaves `meta=null` → `providerAbortKind` returns null → no fallback. CLOSED (any unparseable meta fails closed; reader already catches at iv.mjs 1888).
- *Kill between init-invalidate and branch write:* the init write stamps `{nonce:<current>, failureKind:null}` (or unlink leaves no file) → reader sees null kind (or null meta) → no fallback. CLOSED.
- *Kill BEFORE the init-invalidate on a REUSED path:* stale file carries an OLD/absent nonce → nonce mismatch → reader rejects → fail closed. CLOSED by the nonce (this is the door init-truncation alone would NOT close; it is why the charter pairs invalidate-at-start WITH a nonce).
- *The anthropic fallback attempt itself failing:* NOT a freshness door and NOT a fail-OPEN — the fallback writes to its OWN fresh meta path; if it too aborts, the round is lost (INVALID), which is recoverable and never a wrong attribution. The design does not close it and need not; named as the accepted safe-degradation residual.

**Build spec (≤5):**
1. `dispatch.mjs`: generate a per-run `nonce` (randomUUID) at startup — or accept `--meta-nonce <N>` from the caller — stored module-level; `writeMeta` always includes `nonce`. As the FIRST action when `--meta-out` is set (after arg-validate, before any provider dispatch), write an INIT meta `{nonce, exitCode:null, failureKind:null, …}`, overwriting any stale file at that path.
2. `independent-verify.mjs` `runDispatch`: generate a fresh nonce per attempt, pass `--meta-nonce`, keep the existing unique meta path per attempt (unchanged).
3. `providerAbortKind` (+ caller): stays meta-only + fail-closed (r4), now ALSO require `meta.nonce === <the nonce this invocation passed>` before honouring `meta.failureKind`; mismatch/absent ⇒ null ⇒ no fallback. No stderr scrape returns.
4. Must-FAIL in `verify-bug-273-iv-infra.mjs`: against the REAL `dispatch.mjs`, (a) reuse a meta-out path already holding `{failureKind:'rate-limited'}`, stub codex-runtime to throw BEFORE any branch write ⇒ reader returns null (pre-fix: `rate-limited`; post-fix: null); (b) crash after init-write before branch write ⇒ meta `failureKind:null` ⇒ null; (c) nonce-mismatch stale file ⇒ null. Keep the r4 regression guards.
5. Verify: `verify-bug-273-iv-infra` (must-FAIL pre-fix, pass post-fix) + `verify-dispatch` + `verify-feat-100-declared-dispatch` + `verify-scratch-root` + `npm run gate` (exit 0, unpiped) + `board:gen`. Bucket: correctness / regression-prone harness; a routine independent re-verify of the narrowed FRESHNESS property is warranted (NOT a security pass).

— technical adjudicator (non-author). Evidence: `mkdtempSync` fresh-dir demo (command+output above); three distinct literal meta names (grep); dispatch.mjs writeMeta single write + FEAT-100 stale-meta comment. No code written.

### 2026-10-25 — worker (dispatch, fixing r5) — P2 freshness-by-construction at the owner (init-invalidate + caller nonce)

Built exactly the r5 adjudicator build spec (entry above). Did NOT touch `scripts/lib/verdict-contract.mjs` (BUG-276 under verification). **Hypothesis verified FIRST:** `opts.metaOut` is resolved at a SINGLE point — the arg-parse (`--meta-out`, dispatch.mjs ~191) — and both provider paths start only later (`await dispatchAnthropic()/dispatchOpenai()` ~401). So there is one chokepoint where `--meta-out` is known before any provider work; the init-invalidate write sits there. The STOP-and-report condition did NOT fire.

- **`dispatch.mjs` — nonce + init-invalidate (single chokepoint).** Added `import { randomUUID }`; `--meta-nonce <N>` arg (opts.metaNonce); a module-level `const metaNonce = opts.metaNonce ?? randomUUID()` (caller-supplied so the caller can match it back, random otherwise so a direct caller still gets a unique stamp). `writeMeta` now stamps `nonce: metaNonce` into EVERY record (init, each anthropic/openai failure branch, success, sandbox-preflight — all go through the one `writeMeta`). As the FIRST action after arg+profile validation and BEFORE any provider dispatch (right after the profile-notice block, ~line 300), `writeMeta({ exitCode: null, failureKind: null })` overwrites whatever stale file sat at the meta path with `{nonce:<this run>, failureKind:null}`. No-op when `--meta-out` is unset.
- **`independent-verify.mjs` — reader gates on the nonce; caller stamps per attempt.** `runDispatch` generates a fresh `randomUUID()` per attempt, passes `--meta-nonce`, and carries that nonce out in the result (`{code, stdout, stderr, meta, nonce}`). `providerAbortKind({code, meta, nonce: expectNonce})` now returns null unless `meta` exists AND `meta.nonce != null` AND `meta.nonce === expectNonce`, THEN applies the r4 provider-kind test. The single caller (~1927) passes the whole `active` object, so no caller change. A truncated/partial meta still throws in `JSON.parse` → `meta=null` → fail closed (unchanged, now explicitly commented).
- **Every other case gives null, no fallback** (charter): absent meta, unparsable/partial meta (`meta=null`), nonce mismatch, unstamped meta (no nonce field), and a null/init kind all yield null. A matching-nonce provider kind is the ONLY path to a fallback, which still fires at most once.
- **Must-FAIL + pass-after (`scripts/verify-bug-273-iv-infra.mjs`, 88/88 post-fix; pre-fix anchor reddens 9).** Reader-level: added r5 cases to the synthesized pre-r5 anchor set — a STALE present provider meta with a non-matching nonce, and an unstamped meta with a provider kind, both REDDEN the pre-anchor (which ignores the nonce and honours any present kind → wrong fallback) and pass the real r5 reader (null); the init-invalidate record (current nonce, null kind) → null. Existing ABORT/NO_FALLBACK cases given matching nonces so the r1–r4 behaviour still holds. **Owner-side, driven against the REAL `scripts/dispatch.mjs`** (same stub seam as r4, plus a `crash-before-write` scenario where `rt.start()` throws AFTER the init write but before the terminal write) — the four charter cases: (1) a reused meta path holding a stale `rate-limited` + crash before writeMeta → the init-invalidate overwrote it to `{nonce:<this run>, failureKind:null}`, reader → null; (2) a truncated/partial meta (the REAL valid meta truncated at 6 offsets strictly inside the object) → every prefix `JSON.parse`-fails → `meta=null` → null; (3) a nonce mismatch — dispatch stamps nonce-A, reader expecting nonce-B → null, same meta read with nonce-A round-trips → `rate-limited`; (4) a genuine rate-limited abort with the matching nonce → fallback once.
- **Verification (real outputs):** `verify-bug-273-iv-infra` **88 passed, 0 failed** (pre-fix anchor: 9 failures — must-FAIL holds). `verify-scratch-root` **28/28 PASS**. `verify-dispatch` **24/24 PASS** (dispatch.mjs failure taxonomy, anthropic path — unaffected by the nonce/init write). `verify-feat-100-declared-dispatch` **31/31 PASS** (meta-out writer shape; the added `nonce` key did not break the declared-fields assertions). `npm run gate` **PASS exit 0** (leak-gate + typecheck, read unpiped). `npm run board:check` — DRIFT 1, the pre-existing FEAT-170 UNREACHABLE TICKET (unrelated) + pre-existing STALE doc WARNs; nothing from this change.
- **Bucket:** correctness / regression-prone harness. P2 has now broken three times (r2/r3/r4); this is the construction fix at the owner (freshness is stamped, not inferred), so a routine independent re-verify of the narrowed FRESHNESS property is warranted — NOT a security pass. NOTE for the verifier: run its fixer test DIRECTLY (`--run "node scripts/verify-bug-273-iv-infra.mjs"`); confined is unnecessary (no git-write fixtures).
- **Files changed (unstaged, for the user to commit):** `scripts/dispatch.mjs`, `scripts/independent-verify.mjs`, `scripts/verify-bug-273-iv-infra.mjs`, `docs/bugs/BUG-273-…md` (this entry + INDEX via board:gen).

### 2026-10-25 — dispatch openai
- **Verification recorded:** dispatch openai/codex run 01a1709a-edbe-75b2-92d1-5b641df0af61 — VERDICT: HOLDS — mixed-state candidate 84d23ad12389. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-25 — dispatch openai
- **Verification recorded:** dispatch openai run 01a173aa-a5e2-7440-a80d-8b98203c237d — VERDICT: BROKEN — Committed-range IV of commit 6b5d754. >1 --run hard check, nonce-fresh provider-abort fallback, seed hermeticity HOLD. BROKEN: seedScratchGit 'git add -A' omits tracked-but-.gitignore files from synthetic HEAD (HEAD:file exit 128). Not pushed. Fix: add -f exported set / use real tree.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-25 — worker (dispatch, fixing r6) — seed commits EXACTLY the exported file set (the r5 BROKEN)

Fixed the r5 `BROKEN` (openai run `01a173aa-a5e2-7440-a80d-8b98203c237d`, committed-range IV of `6b5d754`): `seedScratchGit` used `git add -A`, which HONOURS `.gitignore` / nested `.gitignore` / `info/exclude` / `core.excludesFile`, so an exported-but-ignored TRACKED file was silently dropped from the synthetic HEAD while the seed still reported `ok` — then the verifier's `git show HEAD:<file>` died 128.

- **Hypothesis verified FIRST.** There is NO captured list of exported paths at seed time (the export is `git archive | tar`, line ~1076, which keeps no manifest), and the commit must mirror the FINAL room tree — post-strip, post-stub, post-symlink-materialisation (docstring "ONE commit of the FINAL room tree") — NOT the pre-strip archive set. So the owner of "what to commit" is the room directory ON DISK after the pipeline. The fix enumerates it with a plain fs walk that applies NO ignore rules (not a git walk), then force-adds that explicit set so no ignore source can subtract from it. The "don't re-walk with ignore rules" caution is satisfied: the walk is ignore-free; only git applies ignore rules, and that is exactly what we removed.
- **`independent-verify.mjs` — `seedScratchGit` (fix by construction).** Replaced `git add -A` with: a recursive `fs.readdirSync(withFileTypes)` walk of the room, skipping only top-level `.git` (our skeleton) and `node_modules` (the live-tree copy), emitting FILES and SYMLINKS (symlinks pushed, never followed; directories recursed, never listed so git can't re-expand them under ignore rules); then `git add -f --pathspec-from-file=- --pathspec-file-nul` fed the NUL-joined list on stdin. `-f` overrides every ignore source; `--pathspec-file-nul` takes each byte literally so a leading `-`, spaces, newlines, unicode cannot be misread as a flag or re-split. `node_modules` is simply never listed, so `-f` cannot pull it in; `info/exclude /node_modules/` is kept so `git status` stays clean. Empty `relFiles` → no-op status 0. Everything else (skeleton, temp-index plumbing, `buildRoomGitEnv`, HEAD-resolve) unchanged.
- **Must-FAIL + pass-after (`verify-bug-273-iv-infra.mjs`).** Added `proveExportedFileSet(seed, label)` over a single REALISTIC-STATE adversarial room (`buildAttackRoom`) covering the whole verifier attack list, run under a HOSTILE HOME gitconfig whose `core.excludesFile` ignores `*.xf`. Anchored to a literal pre-fix `preSeedScratchGit` (byte-identical to shipped `6b5d754` except the one `git add -A` line). Pre-fix reddens EXACTLY the 3 ignored-but-exported items (`secret.env`, `dist/bundle.js`, `pkg/debug.log`); the real seed passes all 14. The pre-fix anchor now reddens 12 total across all causes (3 are this cause).
- **Per-attack-item tally (POST-FIX real — all PASS):** tracked-but-ignored root file; ignored directory; nested `.gitignore`; the `.gitignore` files themselves; HOME/global `excludesFile` cannot matter (`thing.xf` committed under hostile HOME); leading-`-` name; spaces in path; unicode dir+file; empty dir absent from HEAD yet seed ok; symlink committed as mode 120000 with target not followed; stripped stub served (not real prose); node_modules absent from HEAD; `git status` clean after the seed. 13 attack checks + "seed reports ok" = 14 PASS.
- **Verification (real outputs):** `node scripts/verify-bug-273-iv-infra.mjs` → **102 passed, 0 failed** (MUST-FAIL anchor held: pre-fix produced 12 failures). `node scripts/verify-scratch-root.mjs` → **PASS 28 FAIL 0 SKIP 0** (real node_modules reflink-copy + cross-fs detection; the seed change did not perturb room build). `npm run gate` → **GATE: PASS (exit 0)**, read unpiped (leak-gate + check-nul + check-unicode-separators + prompt-privacy + pre-push-hook + typecheck).
- **Bucket:** correctness / regression-prone clean-room harness. The seed is the exact surface the r5 IV refuted; a routine independent re-verify of the EXPORTED-FILE-SET property (`git show HEAD:<file>` for a tracked-but-ignored export) on the working tree atop `6b5d754` is warranted — NOT a security pass. Run the fixer test directly (`--run "node scripts/verify-bug-273-iv-infra.mjs"`); confined unnecessary (no git-write fixtures).
- **Files changed (unstaged, for the user to commit):** `scripts/independent-verify.mjs`, `scripts/verify-bug-273-iv-infra.mjs`, `docs/bugs/BUG-273-…md` (this entry + INDEX via board:gen).
