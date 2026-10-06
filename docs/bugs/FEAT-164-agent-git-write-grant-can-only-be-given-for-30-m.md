```orchard-ticket
{
  "id": "FEAT-164",
  "type": "feature",
  "title": "Agent git-write grant can only be given for 30 minutes",
  "summary": "The control that lets agents run git writes for a project only offers a 30-minute grant, so a project where the user always wants agents to commit needs a fresh grant every half hour. Add a permanent, per-project, explicitly labelled and revocable option, honoured by the same enforcement path as the timed grant.",
  "impact_if_we_wait": "Users who trust agents to commit in a given project must re-grant every 30 minutes; a grant lapsing mid-task stops the agent.",
  "current_need": "A permanent per-project grant, stored as a declared project setting and read by the one grant check, revocable from the same control with immediate effect.",
  "severity": "medium",
  "area": "agent git-write grant",
  "reported": "2026-10-05",
  "reported_by": "agent",
  "owner": "you",
  "work_state": "blocked",
  "human_action": "decide",
  "updated": "2026-10-05",
  "decision": {
    "mode": "single",
    "question": "How should Orchard stop a host agent session from granting itself git-write access?",
    "options": [
      {
        "key": "A",
        "label": "OS caller check plus sealed grant",
        "what_changes": "The server identifies the calling process from the OS and stores the permanent grant sealed, so registry edits, loopback grant calls and self-answered approvals stop working.",
        "benefit": "Closes every casual self-grant path for host sessions; additive and reversible, no new step for the user.",
        "cost": "A determined same-user agent can still evade it (a user-scope launch, replaying an old sealed value).",
        "why_not_obvious": "The plan review called it unsound against a deliberate attacker, but that residual is the same class as the host risk ARCH-021 already prices."
      },
      {
        "key": "B",
        "label": "Human-only credential per grant",
        "what_changes": "Every grant needs something only the person has: a typed passphrase or a security-key touch.",
        "benefit": "Truly holds: an agent on the same user account cannot produce the credential.",
        "cost": "Friction on every grant, including the permanent one, and a credential to set up and keep.",
        "why_not_obvious": "It is the only option that holds today without a new process boundary, but it taxes exactly the users who wanted fewer prompts."
      },
      {
        "key": "C",
        "label": "Separate OS user or container",
        "what_changes": "Agent sessions run as a different OS user or inside containers, so they cannot touch the server registry or its grant routes.",
        "benefit": "Holds by construction; no detection logic to get wrong.",
        "cost": "A large change that overlaps ARCH-021 and alters how every host session runs.",
        "why_not_obvious": "It is the real fix long-term, but it should be decided together with ARCH-021 rather than inside a grant feature."
      }
    ],
    "recommendation": "A",
    "recommendation_reason": "Decided A for the user by the orchestrator on the user's delegation (2026-10-05): it closes the casual paths now at low cost; C stays the long-term direction with ARCH-021. Override here if you disagree.",
    "prerequisite": null
  },
  "decision_history": [],
  "success_criteria": [
    "The grant control offers a permanent option next to the 30-minute one, clearly labelled as permanent, per project.",
    "The permanent grant is stored once, as a project setting, and the existing grant check reads it from there; nothing else derives it.",
    "Revoking it from the same control blocks the next git write of an already-running session.",
    "A permanent grant never lifts the mandatory leak gate, and the 30-minute and one-off grants keep working unchanged."
  ],
  "code_refs": [
    {
      "path": "scripts/lib/git-grant-store.mjs"
    },
    {
      "path": "scripts/lib/git-grant.mjs"
    },
    {
      "path": "src/server/index.ts"
    },
    {
      "path": "public/lib/git-view.js"
    }
  ],
  "related": [
    {
      "id": "FEAT-108",
      "relation": "see_also"
    },
    {
      "id": "ARCH-021",
      "relation": "see_also"
    },
    {
      "id": "BUG-173",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a10ba1-8393-7e23-9ba1-a14a63e1e6f9",
      "verdict": "broken",
      "verdict_on": "2026-10-05",
      "recorded_at": "2026-10-05T10:38:45.179Z",
      "author": "independent-verify clean-room (openai)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Property(2) TOCTOU: revoke of permanent during the leak-gate callback, with an independent once-grant active, makes consumeGrant spend the once-grant; next write denied. Author 34/34 green in-room; other properties held; fails CLOSED. Single break. Detail in Activity log 2026-10-05."
    },
    {
      "provider": "openai",
      "model": "default",
      "run_id": "01a10bbd-44d2-7420-8d4e-e1e73b939a22",
      "verdict": "broken",
      "verdict_on": "2026-10-05",
      "recorded_at": "2026-10-05T11:07:57.858Z",
      "author": "independent-verify clean-room (openai)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Round 2 BROKEN. Property(1) re-broken via a NEW path vs round 1: a re-entrant evaluateGitWrite inside the outer leak-gate callback double-spends one once-grant. TWO-BREAK rule -> single-authority redesign. Contract-VALID, manifest-backed. Over-grant only, gate still runs. See Activity log."
    },
    {
      "provider": "openai",
      "model": "default",
      "run_id": "01a10ca5-0fb3-7032-a8c0-5374865424e8",
      "verdict": "broken",
      "verdict_on": "2026-10-05",
      "recorded_at": "2026-10-05T15:22:44.678Z",
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
      "recorded_at": "2026-10-05T15:46:01.037Z",
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
      "recorded_at": "2026-10-05T21:05:53.755Z",
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
      "recorded_at": "2026-10-05T21:35:18.013Z",
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
      "recorded_at": "2026-10-05T22:08:16.184Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "BROKEN (VALID, manifest 6 runs). Fixer cc28db7f3e3c exit0 19/0. Two breaks, STOP. P5: initially-DENIED call id left 'unknown', no tombstone; reused id steals a fresh once-grant (7f57e10c4704). P8: fingerprint skip bypasses now-failing gate on identical 2nd write (af310f923a95). See log."
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

# FEAT-164 — Agent git-write grant can only be given for 30 minutes

## Symptom

User request: agent git access can only be granted for 30 minutes. Add a permanent option per project, alongside the timed one.

## Security notes

The FEAT-108 grant store is memory-only on purpose: a grant read back from an on-disk file can be planted by a host session that writes that file. A permanent grant persisted as a project setting reopens that write path for direct (host) sessions. It is the same class as the residual the store already records (a host session can call the grant route over loopback), and it is neutralised the same way: a granted commit or push still runs the leak gate and is refused on a leak. Container sessions reach neither the registry nor the loopback route.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-05 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-05 — worker (fixing r1)
- **Fixing round 1:** Fixing round 1 (dispatch phase=fixing round=1 class=fix).
  - **Understood:** the grant control (Git panel header, FEAT-108 r3) offered only a 30-minute grant; grants live only in server memory (git-grant-store.mjs) and are read by peekGrant inside evaluateGitWrite, the ONE decision both the runtime PreToolUse hook (claude-runtime.ts) and the FEAT-135 shim's /api/git-shim/decide route call.
  - **Design (ARCH-010):** the permanent grant is a DECLARED project setting, `settings.gitWrite = { permanent: true, grantedAt, grantedVia }`, written ONLY by `registry.setGitWritePermanent` (called by the user grant route; the generic settings PATCH rejects the key) and read ONLY by `registry.gitWritePermanentOf`. The store reads it at CALL TIME through `setPermanentGrantSource` (wired in index.ts at import); peekGrant/grantView answer permanent first; consumeGrant never spends a once-grant under it. Nothing caches it, so revoking bites on a running session's next git write. Fail closed: no source, a throwing source, a torn/unparseable registry, or anything but `permanent === true` = no grant. It never lifts the leak gate.
  - **Route/UI:** POST git-write-grant {scope:'permanent'} sets it; DELETE revokes timed AND permanent. Git panel: "Allow 30 min" (unchanged behaviour) + "Allow permanently…" whose first click only ARMS it (ochre, "Confirm: allow permanently", state line "Agents may commit and push here until you revoke"; lapses after 6 s), second click grants; granted state reads "Agent git allowed · permanent" with Revoke. CLI: `scripts/git-grant.mjs <project> --permanent`. Agents cannot request permanent: the git-write-request route still coerces scope to once/duration.
  - **ARCH-021:** no fork. ARCH-021 is about the classifier's completeness (unrecognised writes are ungated regardless of any grant); a permanent grant does not widen that, every recognised write still runs the leak gate, and options B/C/D would consult the same peekGrant.
  - **Verified:** `node scripts/verify-feat-164-permanent-git-grant.mjs` -> "FEAT-164: 34 passed, 0 failed" (Part A in-process over the real registry in a scratch data dir: allow with permanent, leak gate still mandatory, no-runner fails closed, per-project, not use-bounded, once-grant not spent, revoke denies the running session's next write, 30-min still works, fail-closed shapes, truncated registry at 5 cut points denies without throwing, generic PATCH refuses the key and does not drop it; Part B on an isolated scratch server: route sets/reads/revokes, registry written, survives a server restart, generic PATCH 400). UI e2e in `verify-feat-163-165-git-bar.mjs` [164-grant]: arm-only first click (no grant), 6 s lapse, confirm -> server scope=permanent + registry setting, survives reload, Revoke clears UI+server+registry, 30-min grant then "Make permanent…" upgrade, one Revoke clears both.
  - **Must-FAIL:** pre-change: "FAIL A0 registry exposes the single writer + reader", "FAIL A0 store exposes setPermanentGrantSource", then TypeError; UI suite on the pre-change tree: "[164-grant] section threw … reading 'hidden'".
  - **Anti-regressions:** verify-feat-108-git-grant PASS 64/0 (1 skip: fixture repo needs git init, refused by the lane shim); verify-feat-108-git-write-block PASS 239/0 (1 same skip); verify-bug-173 27/1 — the 1 FAIL is pre-existing and unrelated: it diffs against `HEAD:scripts/lib/git-shim.mjs`, a moving baseline that became the fixed state once committed (CONVENTIONS "must-FAIL proof must not be anchored to a moving baseline"); verify-feat-108-git-request-approve NOT runnable here (creates a fixture repo).
  - **Residual for the user (security):** the store's header deliberately kept grants out of any file so a host session cannot plant one (self-grant hole 2). A persisted permanent grant reopens that for DIRECT sessions (same uid can edit the registry JSON). Same class as the residual already recorded there (a direct session can POST the grant route over loopback), neutralised the same way (leak gate on every granted commit/push; every permitted write recorded + announced). Container sessions reach neither. The verify-feat-108-git-grant comment "the store never reads a file" is now only true for the timed grants.
  - Screenshots: docs/bugs/assets/FEAT-164-{blocked,armed,timed}-light.png, FEAT-164-permanent-{light,dark}.png.
  - Changed files (unstaged; no git writes): public/app.js, public/index.html, public/styles.css, public/lib/git-view.js, public/git-view.css, scripts/lib/git-grant-store.mjs, scripts/lib/git-grant-store.d.mts, scripts/git-grant.mjs, src/server/registry.ts, src/server/index.ts, package.json (two verify script entries), new scripts/verify-feat-163-165-git-bar.mjs, new scripts/verify-feat-164-permanent-git-grant.mjs. Gate: `npm run gate` -> GATE: PASS (exit 0; leak-gate, check-nul, typecheck).
  - **Handoff:** SECURITY-relevant -> an independent clean-room verify pass is warranted (scripts/independent-verify.mjs). Attack ideas: forge the setting by editing the registry from a direct session; race a revoke against a running session's commit; a grant on project A leaking to B through the shim decide route.

### 2026-10-05 — independent-verify clean-room (openai)
- **Verification recorded:** dispatch openai run 01a10ba1-8393-7e23-9ba1-a14a63e1e6f9 — VERDICT: BROKEN — Property(2) TOCTOU: revoke of permanent during the leak-gate callback, with an independent once-grant active, makes consumeGrant spend the once-grant; next write denied. Author 34/34 green in-room; other properties held; fails CLOSED. Single break. Detail in Activity log 2026-10-05.. Typed entry in the record's verification[]; this line is an echo, not proof.
- **Independent clean-room verification — full detail (round 1, cross-provider openai, harness scripts/independent-verify.mjs, --working-tree over the real dirty batch tree).**
  - **Verdict:** BROKEN (contract-VALID, manifest-backed). Run `01a10ba1-8393-7e23-9ba1-a14a63e1e6f9`.
  - **What reproduced green in the clean room:** the author's `verify-feat-164-permanent-git-grant.mjs` re-ran 34 passed / 0 failed (fixer-test manifest `ca17069f4fa4`, exit 0), covering Part A (enforcement, in-process) and Part B (isolated scratch server). Attack properties (1) project scoping, (3) 30-min still expires, (4) single reader, (5) leak gate still mandatory + fail-closed on no runner, and (6) agent cannot self-grant / generic PATCH refuses `gitWrite` / torn-and-truncated registry fails closed — all HELD.
  - **The break (property 2), adversarial probe `verifier-grant-race.mjs`, manifest `9957f9665c38`, exit 1:** with BOTH a permanent grant and an independent once-grant active on the same project, revoking the permanent grant (through the real `registry.setGitWritePermanent(id,false)` writer) DURING the injected leak-gate callback makes `consumeGrant` re-read permanent state — now false — and SPEND the underlying once-grant. The racing write itself is still authorized and recorded with `scope=permanent` (correct at decision time), but the once-grant is collateral-consumed, so the session's next write is denied. The control case (same scenario, no mid-gate revoke) keeps the once-grant and allows the next write; "real timed expiry" also held in the probe.
  - **Direction / severity:** fails CLOSED. It never allows a write that should be denied, and the leak gate runs on every allowed write, so there is no security hole. The core of property (2) — "revoke blocks the running session's next write" — actually still holds. What breaks is the accounting invariant the author's A9/A10 encode: an independent once-grant should not be spent by a permanent-authorized write. Low real-world likelihood (requires both grant kinds active at once AND a revoke landing inside the leak-gate window).
  - **Architectural note (ARCH-010):** the finding exposes that `consumeGrant` re-reads the permanent-source at a second instant distinct from `peekGrant`'s allow decision — the same "is permanent active?" fact read twice within one `evaluateGitWrite`, and the two reads can disagree when a revoke lands between them. A fix should have `consumeGrant` act on the SAME decision snapshot `peekGrant` produced rather than re-reading. Single break via a single path; the two-break "route to single-authority redesign" rule was NOT triggered.
  - **Not a finding (accepted-pending, confirmed out of scope by the charter):** a direct host session editing the registry JSON or calling the loopback grant route. The verifier did not report it.
  - **Limitations the verifier recorded as UNTESTED:** authenticated HTTP shim attribution, live-session request coercion, and the browser grant controls were not exercised (no agent session or browser launched). The diff handed over was the whole uncommitted batch tree with docs stripped (not FEAT-164 in isolation) because nothing is committed and agents cannot create an isolated base; the verifier was directed to the grant files + the FEAT-164 verify script and had the full working copy to read.

### 2026-10-05 — worker (fixing r2)
- **Note:** **Fixing round 2 (dispatch phase=fixing round=2 class=plan+review). Verdict: FORK on the self-grant goal; two fork-independent fixes built.** regressed-from: none (round-1 defects of this ticket).
    - **Hypothesis checked first, REAL agent:** new `scripts/verify-feat-164-self-grant.mjs` drives an isolated scratch server (own scope) where the "agent" is a REAL Orchard-launched session process (stand-in CLI binary, launched by the session host into its claude-station-host-t-*.scope, real FEAT-135 shim on PATH) and the "user" is a transient user-scope process. On the round-1 tree, 13 must-FAILs reproduced three self-grant paths, not two. H1: the agent edits registry.json `settings.gitWrite` and gets a live permanent grant (route view AND the real shim lets `git add` through); copying a user grant onto another project row also grants there. H2: the agent POSTs the grant route (once/duration/permanent → 200), and `scripts/git-grant.mjs` run from an agent cgroup does the same. **H3 (new):** the agent raises a git-write request, then POSTs `board/answer {answer:"Allow"}` itself, which mints the grant. Also: sessions with survival off run in the SERVER's cgroup. Checked and NOT issuance paths: the ORCHARD_ALLOW_GIT_WRITE env hatch (host env at launch; the installed shim ignores a child's env), the generic settings PATCH and project create (both reject gitWrite), and containers (server binds 127.0.0.1; registry not mounted).
    - **What is actually unforgeable (the fork):** agents, the server and the user's browser are one uid. Anything the browser holds without the human (cookie, page token, Origin/CSRF) is obtainable by curl or an agent-launched headless browser. Planned O1 = caller provenance from the OS (loopback peer → /proc/net/tcp inode → pid → cgroup; agent = claude-station-host-*.scope or the server's own cgroup) + S1 = HMAC-sealed permanent grant verified by the single reader. Cross-provider plan review (openai, dispatch transcript 01a10ba9-5101-7421-8bbc-de499f8a981e) returned **UNSOUND**. BLOCKER: `systemd-run --user --scope` (or writing one's pid into a user-owned cgroup.procs) makes an agent classify as user, and the seal key is same-uid readable. MAJOR: S1 is defeated WITHOUT key theft by replaying a previously sealed value after a revoke. MAJOR: a same-uid reverse proxy makes agent requests look like the user; the server-spawned terminal (git.ts openTerminal) and a server started from a terminal would classify the real user as an agent. Not built.
    - **Fork for the user (one sentence):** within one uid, nothing Orchard holds can stop a determined host agent from granting itself; the choices are (A) best-effort provenance + sealing that closes every casual path but not a deliberate one, (B) a human-only credential per grant (typed passphrase / WebAuthn touch), or (C) a uid/container boundary for agent sessions, which overlaps ARCH-021's direction. **Recommendation: A now, with the residual priced as the same class as ARCH-021's host residual (a host agent willing to evade can already commit UNGATED, worse than a gated self-grant); C long-term, decided together with ARCH-021.** The ARCH-021 option itself was NOT chosen here.
    - **Built (fork-independent):**
      1. **Round-1 verifier break (run 01a10ba1-8393-7e23-9ba1-a14a63e1e6f9), ARCH-010 fix:** `peekGrant` returns the decision with a private link to the exact grant object it read (null when permanent answered). `consumeGrant(decision)` spends only that object, only if it is still the one in the map, and never re-reads permanent state. Passing a bare project key now throws. One decision, one instant. Files: scripts/lib/git-grant-store.mjs, scripts/lib/git-grant.mjs, scripts/lib/git-grant-store.d.mts.
      2. **Answer-once:** `board/answer` on an ALREADY-RESOLVED record that carries gitWrite or services now returns 409 `already-answered` and changes nothing. Before this, replaying a past "Allow" re-minted a grant the user had revoked or spent (found by the reviewer). File: src/server/index.ts.
    - **Verified:** `node scripts/verify-feat-164-permanent-git-grant.mjs` → FEAT-164: 40 passed, 0 failed (34 + 6 new A13a-f: the verifier's race through the real registry writer, a replacement grant mid-gate, a failed gate spends nothing, bare-key refusal). Must-FAIL on a SYNTHESIZED round-1 consume (HEAD has no FEAT-164, so it is not a baseline): 36/4, failing A13b/c/d/f; restored byte-identical (cmp). `node scripts/verify-feat-164-self-grant.mjs` → 20 passed, 0 failed, 12 self-grant holes OPEN (exit 2 = holes open, no regression; the H checks are behavioural, so they verify whichever fork option is built). UA2b (replay refused) must-FAIL with the guard removed: 200 + re-minted grant; restored (cmp).
    - **Anti-regressions:** verify-feat-108-git-grant 66/0; verify-feat-108-git-write-block 241/0; verify-bug-173-grant-aware-shim 28/0; verify-bug-184-ledger-truthful-outcome 28/0 (both were 27/1 on a HEAD-anchored baseline; now pinned, see below); verify-git 74/0. NOT run: verify-feat-108-git-request-approve (builds a fixture repo, see BUG-230 below; the same request→user-Allow→replay flow is covered at HTTP level by the self-grant suite with a real session); verify-feat-112-services (needs the FEAT-158 Docker sandbox; it answers fresh records only, so the resolved-only guard does not reach it); verify-feat-163-165-git-bar (registers the real Orchard and methodology checkouts on a scratch server by default, which the charter forbids).
    - **Side items:** (4a) scripts/verify-git.mjs: three crown-chip checks updated to the FEAT-165 face. The face is "N files" + compact +added/−removed in #gitAdd/#gitDel, and the exact branch/counts sentence is in aria-label. Result: 71/3 → 74/0. (4b) verify-bug-173 AND verify-bug-184 (same defect) now pin their pre-fix baseline at a named revision (dc1f4ea0f3d2 = parent of ca672b9; b11e71f85711 = parent of a35e754) instead of HEAD; the must-FAIL legs fire again. (4c) NOT run. My own guard would refuse a real `git init` (the suite's non-REAL path exists for exactly that), but it currently does NOT, because of BUG-230. Running it now would exploit that bug. The suite also registers two real checkouts by default.
    - **BUG-230 filed (high), found here:** this lane's FEAT-135 shim dir was deleted mid-session. `installGitShim` rm's whatever ORCHARD_GIT_SHIM_DIR names. A nested runtime (my scratch server's sessions, or the in-process Codex runtime of an openai dispatch) inherits the parent's env and deletes the parent's shim, so the parent's subprocess git becomes `/usr/bin/git`. **Disclosure:** before I noticed, verify-git, the feat-108 suites and bug-184's real-commit leg ran fixture-repo init/commit/push in scratch dirs and local bare remotes through the unguarded git. No real repo was touched; no git write was run on this checkout.
    - **Changed files (unstaged; no git writes):** scripts/lib/git-grant-store.mjs, scripts/lib/git-grant-store.d.mts, scripts/lib/git-grant.mjs, src/server/index.ts, scripts/verify-feat-164-permanent-git-grant.mjs, new scripts/verify-feat-164-self-grant.mjs, scripts/verify-git.mjs, scripts/verify-bug-173-grant-aware-shim.mjs, scripts/verify-bug-184-ledger-truthful-outcome.mjs, docs/bugs/BUG-230-*.md (new), docs/bugs/FEAT-164-*.md (this entry + work_state), docs/bugs/INDEX.md.
    - **Handoff:** work_state → blocked on the fork above. SECURITY bucket → an independent clean-room verify of the round-2 consume/answer-once changes is warranted (attack: re-entrant revoke/re-grant inside the gate callback; double answer racing the resolve; services replay). The store header's "only mutator … explicit USER actions" text stays false for host sessions until the fork is decided.

### 2026-10-05 — independent-verify clean-room (openai)
- **Verification recorded:** dispatch openai/default run 01a10bbd-44d2-7420-8d4e-e1e73b939a22 — VERDICT: BROKEN — Round 2 BROKEN. Property(1) re-broken via a NEW path vs round 1: a re-entrant evaluateGitWrite inside the outer leak-gate callback double-spends one once-grant. TWO-BREAK rule -> single-authority redesign. Contract-VALID, manifest-backed. Over-grant only, gate still runs. See Activity log.. Typed entry in the record's verification[]; this line is an echo, not proof.
- **Independent clean-room verification — full detail (round 2, dispatch phase=verifying class=verify, cross-provider openai, harness scripts/independent-verify.mjs).**
  - **Verdict:** BROKEN (contract-VALID, manifest-backed). Run `01a10bbd-44d2-7420-8d4e-e1e73b939a22`. Verifier transcript `~/.local/share/claude-station/transcripts/openai/<cleanroom-verify-bhJ03M>/01a10bbd-44d2-7420-8d4e-e1e73b939a22.jsonl`; verdict file + kept clean room under `$XDG_STATE_HOME/claude-station/scratch/cleanroom-verify-bhJ03M` (record dir `cleanroom-record-J8WuJU`, 8 recorded runs).
  - **Setup / improvement over round 1:** round 1 could only hand over the whole dirty batch tree (nothing committed; the git-write guard blocks an agent from building an isolated base). This round, a FOCUSED diff was constructed without touching the real repo: two dangling commits built from node-spawned git over throwaway indices (base = full working tree with ONLY the 3 grant files reverted to HEAD; head = full working tree), so the harness diff is exactly `scripts/lib/git-grant-store.mjs` + `.d.mts` + `git-grant.mjs` (3/3 changed paths). The grant-related hunks of `src/server/index.ts` (import+`setPermanentGrantSource` wiring, POST-permanent, DELETE-revoke, the answer-once 409) were embedded in the requirement; the room still held the full working tree so the scratch-server suites ran. Real repo HEAD/index untouched (verified: status unchanged, HEAD a977e76).
  - **What reproduced green in the room:** author `verify-feat-164-permanent-git-grant.mjs` re-ran 40/40 (fixer-test manifest `8ba72542d243`, exit 0) — including A13a-f (the round-1 permanent-revoke race through the real registry writer, replacement mid-gate, a failed gate spending nothing, bare-key refusal). `verify-feat-164-self-grant.mjs` passed its 20 invariants and exited 2 on the accepted-pending self-grant holes (expected, not a break). Properties (2) answer-once, (3) 30-min expiry, (4) per-project scoping, (5) leak gate mandatory + fail-closed all HELD as covered by those suites.
  - **The break (property 1, NEW path — adversarial probe `adversarial-reentry.mjs`, manifest `b5e6ae9dbbc6`, exit 1):** with a single once-grant active, a NESTED `evaluateGitWrite` evaluated INSIDE the outer write's leak-gate callback consumes that once-grant (nested peek→permit→consume deletes `g` from the map). The outer `consumeGrant(decision)` then finds `grants.get(g.projectKey) !== g` and no-ops (its round-2 "revoked or replaced since the decision" guard) — but the outer write's ALLOW decision was already taken before the gate, so the outer write is permitted too. One once-grant authorizes TWO writes; both recorded `permitted`. The round-2 fix (peekGrant returns a decision object, consumeGrant spends only that object) closes the round-1 permanent-revoke path but NOT re-entrant double-spend.
  - **TWO-BREAK STOP RULE TRIGGERED.** Round 1 broke property (1) via one path (consumeGrant re-reading the permanent setting at a second instant). This is a SECOND, DISTINCT path to breaking the same property (re-entrant nesting double-spends one once-grant). Per the charter, the verifier stopped and reported: **"enumerated property, route to single-authority redesign."** The grant decision/consume accounting should not be patched a third time per-path; it wants one authority that issues and spends a write-authorization atomically.
  - **Direction / severity:** fails as an OVER-GRANT of the single-use count, not a security hole — every permitted write still runs the leak gate (fail-closed on leaks), and the core "revoke blocks the next write" holds. The predicted-and-confirmed correspondence: the fixing-r2 handoff itself named "re-entrant revoke/re-grant inside the gate callback" as the attack to run.
  - **Limitations the verifier recorded as UNTESTED (consequence of the stop rule firing early):** concurrent approval answers (property 2's double-answer race), TTL expiry boundaries, and adversarial HTTP project scoping were not independently exercised beyond the author suites; and the PRODUCTION reachability of leak-gate-callback re-entry is UNVERIFIED — whether any real evaluateGitWrite path re-enters evaluateGitWrite inside `runLeakGateForRepo` is open. A follow-up should (a) decide the single-authority redesign, and (b) establish or rule out real re-entry reachability to price this break.
  - **Independent-skeptic note:** this is a session-lifecycle / regression-prone (grant-accounting) area with a prior round-1 break; the verdict is already from a separate cross-provider clean-room process, so it satisfies the "generation is not its own only verifier" bar. The re-entry reachability question is the one thing a further pass should settle.

### 2026-10-05 — worker (finding r1)
- **Decision declared:** User saw no options on #/tickets/FEAT-164. Cause: the fixing-r2 fork (A/B/C) existed only as Activity-log prose; the record carried decision:null, human_action:none, owner agent, so ticketDecision() correctly returned null and no Decide card rendered (live API before: decision null, owner —; service started 2026-10-04 10:03, board.ts decision parse unchanged in the working tree, so not a stale-build or renderer bug). Changed: record.decision set (mode single, options A/B/C, recommendation A, reason states the orchestrator decided A on the user's delegation and it stays overridable); human_action decide + owner you via board-tool update (INDEX row now 👤). Body untouched (diff of everything after the record block: identical). NOT marked answered: the answered state is a user-authored reply entry from the Decide card, and writing one from a lane would forge the user's answer, so A stands as recommended until the user (or orchestrator, explicitly) records it. Verified: live API decision = 3 options, recommended A, owner 👤, needsYou true, no restart; Playwright on the live page shows the DECISION NEEDED card with A badged RECOMMENDED, screenshot docs/bugs/assets/FEAT-164-decide-card-live.png. Class check: board:check's decision-shape trigger fires only on a declared decision (record decision/human_action or a Status/heading), not on prose; a prose trigger over Activity logs was measured on the real board and is noisy (needs-you is a feature name here: ~30 hits on verified/done tickets), so it is not added. Root of the class: board-tool has no verb to declare a decision, so lanes report forks in prose; a board-tool decide verb is the enforcement point (not built here).

### 2026-10-05 — worker
- **fixing r3:** **Fixing round 3 (dispatch phase=fixing round=3 class=plan+review). Verdict: done for the store/decision layer. One NEW path to the same property was found (BUG-231) and needs a decision.** regressed-from: FEAT-164 r1, r2 (the two verifier breaks).
    - **Hypothesis confirmed first:** both breaks come from deciding (peekGrant) and spending (consumeGrant) in two separate calls on mutable state, with arbitrary code (the leak-gate callback) running between them. In r1 the spend re-read the permanent setting. In r2 the decision reserved nothing, so a nested decision could read the same once-grant.
    - **Redesign: one authority, the split removed rather than guarded.** It lives in `scripts/lib/git-grant-store.mjs` as `claimGrant(projectKey)` → `settleClaim(claim, 'commit'|'release')`:
      - One synchronous call reads the permanent setting once (permanent answers first), otherwise the live timed grant, and reserves a once-grant's use on the spot.
      - It returns an opaque frozen claim. Its state lives in a module-private WeakMap.
      - `settleClaim` ends a claim exactly once (a second settle or a forged object throws). It never re-reads grant state. On 'commit' it returns true only if the claim was live, and `evaluateGitWrite` permits only on true.
      - A claim left unsettled for `CLAIM_MAX_MS` (5 min) lapses: its reservation is freed and its commit refuses, so a lost claim cannot pin a once-grant until its TTL.
      - `peekGrant`/`consumeGrant` are DELETED. `grantView`/`permanentGrantOf` remain as display-only reads (routes, UI); `grantView` now shows a reserved once-grant as `remainingUses` (still claimable) + `reserved`.
      - `evaluateGitWrite` claims before the gate, releases on gate failure, commits on pass, and its `finally` releases on any exception.
      - The later self-grant fork check (A/B/C, not chosen) belongs in `claimGrant` only.
    - **Re-entry reachability (the r2 verifier left it open): NOT reachable in production today, by code reading.**
      - Both callers of evaluateGitWrite (the PreToolUse hook in claude-runtime.ts and /api/git-shim/decide in index.ts) run in the server process and are synchronous.
      - `runLeakGateForRepo` uses `execFileSync`, which blocks the event loop, so no JS (no other request, no hook) can run inside the gate.
      - leak-gate.mjs only runs git READS as a child, with the server's env (no shim on PATH).
      - It becomes reachable the moment the gate goes async: two /decide requests would then interleave. The design holds either way, and S3 tests that async case.
      - Side note from the reviewer, untested and out of scope: the gate's git reads run in an agent-writable repo with no hardened config (for example `core.fsmonitor`). Worth a separate probe.
    - **NEW, filed as BUG-231 (not built; needs a decision).** One Bash git write in a direct session is DECIDED TWICE: once by the hook on the command, then again by the shim for each git invocation inside it.
      - Confirmed in the REAL host audit log `git-write-audit.jsonl`. Hook record `w1-93fc2b16ddc2` (`git add … && git commit`, permitted, never confirmed) was followed 78 ms later by shim records `w2` (add) and `w3` (commit, gate pass) for the same Bash command, on 2026-09-25. The same pattern appears on 2026-09-28 (`w7`/`w8`).
      - Consequences: a once-grant is spent by the hook, so the shim refuses the write. Every granted write runs the gate twice. Each Bash command leaves a phantom pending record.
      - This is a third path to the same property, at the layer level. claimGrant cannot fix it, because the two decisions are separate requests.
      - Options are in BUG-231: (a) the shim is the sole authority; (b) a hook claim is bound to the session and redeemed by the shim, then settled at PostToolUse; (c) 'once' means one git invocation. **Recommendation: (b).** It keeps one decision per Bash command and keeps the hook's pre-exec gate for absolute-path git.
    - **Plan review:** the cross-provider openai dispatch (`01a10bc3-ecea-73f2-8124-cdf3da79055e`) died on its quota window (resets 17:36). I fell back to an anthropic read-only dispatch, so this review is NOT cross-provider. It returned UNSOUND only on the BUG-231 path; the store design itself was judged sound. Folded in from that review:
      - a claim lapse bound;
      - grantView shows a reservation instead of null;
      - `finally` uses the non-throwing `claimSettled`;
      - the returned `grant` is the claim's plain frozen view;
      - must-FAIL runs against the real pre-change bytes, not inline copies.
    - **Verified:**
      - `node scripts/verify-feat-164-single-authority.mjs` → 30 passed, 0 failed. Must-FAIL against fixed baselines:
        - r2 is the REAL pre-round-3 store and decision bytes, pinned at `scripts/fixtures/feat-164/r2-git-grant{,-store}.mjs` (nothing is committed, so there is no revision to name).
        - r1 is SYNTHESIZED from the r2 fixture by restoring round 1's re-reading consume.
        - r1 reproduces the permanent-revoke break; r2 reproduces nested double-spend, three-deep re-entry, and 8 concurrent async decisions all permitting on one once-grant. A control shows r2 held the r1 path, so the two breaks are distinct.
        - The current tree holds all of those, plus 25 more concurrent races, and: a failed or throwing gate spends nothing; revoke or replace mid-gate; TTL lapse mid-gate; duration and permanent nesting; claim lapse with no double spend; double or forged settle throws.
      - Mutation check: removing the reservation line makes 13 checks FAIL and fails CLOSED (0 permits, not 2); restored, byte-identical (cmp).
    - **Anti-regressions:**
      - verify-feat-164-permanent-git-grant 41/0 (A13f rewritten for the new API).
      - verify-feat-108-git-grant 66/0 (peekGrant reads switched to grantView).
      - verify-feat-108-git-write-block 241/0; verify-bug-173-grant-aware-shim 28/0; verify-bug-184-ledger-truthful-outcome 28/0.
      - verify-feat-164-self-grant 20/0 with 12 holes OPEN (exit 2, unchanged).
      - NOT run: verify-feat-108-git-request-approve and verify-git (fixture `git init`; see the disclosure below), verify-feat-163-165-git-bar (registers real checkouts).
    - **Disclosures:**
      - (1) This lane's own shim dir `/tmp/orchard-git-shim-wcWxOq` was found DELETED mid-lane (BUG-230 again). verify-feat-108-git-grant therefore ran its scratch fixture `git init`/commit through real git (0 skipped vs r2's 1). That touched a scratch tmp dir only; no real repo was touched and no git write was run on this checkout.
      - (2) verify-feat-164-self-grant LEAKED its session-host scope `claude-station-host-t-muv5revw-2te9af` after it had already removed its scratch dir. I stopped it by that exact unit name (t- glob, my run). The suite needs a cleanup fix.
    - **Left alone (BUG-230 lane's files):** the comments in scripts/lib/git-shim.mjs:59 and git-shim-secret.mjs:27 still say "peekGrant + … consume" — stale wording only.
    - **Changed files (unstaged; no git writes):**
      - scripts/lib/git-grant-store.mjs, scripts/lib/git-grant-store.d.mts, scripts/lib/git-grant.mjs, scripts/lib/git-grant.d.mts
      - src/server/index.ts (one comment line)
      - scripts/verify-feat-164-permanent-git-grant.mjs, scripts/verify-feat-108-git-grant.mjs
      - new scripts/verify-feat-164-single-authority.mjs; new scripts/fixtures/feat-164/r2-git-grant.mjs and r2-git-grant-store.mjs
      - docs/bugs/BUG-231-*.md (new), this entry
    - **Gate:** `npm run gate` → GATE: PASS (exit 0).
    - **Handoff:** SECURITY / regression-prone bucket, so an independent clean-room verify of claimGrant/settleClaim is warranted. Attack ideas: re-entrant and concurrent claims, lapse timing, settle forgery. Exclude BUG-231's layer double-decision from that verdict, or decide BUG-231 first. work_state stays blocked on the self-grant fork.

### 2026-10-05 — worker (BUG-231 fixing r1)
- **Note:** Side item from BUG-231 fixing r1: verify-feat-164-self-grant.mjs leaked its survival session-host scope every run (reproduced: claude-station-host-t-muv6ums4-n2h3dt alive after a run; stopped by pid). Fixed with reapOwnHosts() (own data dir records only, pid-in-exact-scope check, CLEANUP assertion). After: 21/0, 12 holes open (unchanged), no new t- scope. Detail: BUG-231 Activity log 2026-10-05 worker (fixing r1).

### 2026-10-05 — independent-verify
- **Verification recorded:** dispatch openai/default run 01a10ca5-0fb3-7032-a8c0-5374865424e8 — VERDICT: BROKEN — Property (4) breaks via a NEW route: in redeemGitWrite, after revokeGitWrite succeeds and grantView=null, the still-open call window authorizes the next commit; closing it fails the write. STOP rule: single-authority redesign. Fixers 30/30 (67f6e57252e2); probe df41562628f9 exit1.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-05 — worker
- **fixing r4:** Fixing round 4 (joint with BUG-231): single-authority redesign built — the grant store is the only authority; every git write is allowed only by store useClaim(handle) at the write (revocation generation + expiry + permanent incarnation; once-use spent atomically per handle). Hook mid-gate revoke/expiry now DENIES (r3 semantics changed; single-authority 31/0, permanent 41/0 rewritten accordingly). New verify-feat-164-store-authority.mjs 27/0 with must-FAILs for b1/b2/b3 on pinned fixtures. Full detail: BUG-231 Activity log 2026-10-05 worker (fixing r4). work_state stays blocked on the self-grant A/B/C fork.

### 2026-10-05 — independent-verify
- **Verification recorded:** dispatch openai/default run 01a10cb9-ec2b-7b82-b07f-52409dd7df87 — VERDICT: INVALID — Contract INVALID (fixer-test citation rejected; exit3). Substance: probe cac43c8795dd exit1 = a hidden out-of-command add verb takes the independent path, spends a fresh once-grant while the commit window is correctly withdrawn = DOCUMENTED ACCEPTED RESIDUAL, not a new break. Detail in Activity log.. Typed entry in the record's verification[]; this line is an echo, not proof.
- **Independent clean-room verification — full detail is recorded once in BUG-231's Activity log (same run 01a10cb9-ec2b-7b82-b07f-52409dd7df87, joint verify of the r4 single-authority redesign).** Summary: verdict-contract INVALID (exit 3; the verifier's `BROKEN` answer was rejected because its FIXER-TEST citation was classed as a stand-in). The verifier's reproduced finding — a hidden subprocess `add` verb not present in the command text taking the independent `evaluateGitWrite → claimGrant` path and spending a fresh user-issued once-grant while a sibling commit window is correctly withdrawn — is, on independent reading, the DOCUMENTED ACCEPTED RESIDUAL (out-of-command-text / subprocess git decides independently; always gated), NOT a new in-scope break. All four author suites (store-authority, single-authority, permanent, bug-231-one-decision) ran green in-room. In-scope enumerated properties HELD in the probe. Could-not-test: real Bash exec, Codex path, restart-mid-call-with-live-claim. Decision for the orchestrator: accept-as-residual (fix holds modulo residual) vs re-scope the hidden-verb path + re-run. See BUG-231 for the full entry.

### 2026-10-05 — dispatch openai
- **Verification recorded:** dispatch openai/default run 01a10ddd-5061-7312-8ae2-3b4e14cdea82 — VERDICT: INVALID — Contract-VALID BROKEN but the sole finding is the documented once=one-Bash-call semantics (one grant covers every write written out in one command), NOT a break. Repro: a 2nd SEPARATE call is denied; a replacement spent once by the next call. Charter mis-stated property 4 as one write. See log.. Typed entry in the record's verification[]; this line is an echo, not proof.
- **Independent clean-room verification — full detail is in BUG-231's Activity log (same run `01a10ddd-5061-7312-8ae2-3b4e14cdea82`, joint verify of the r4 single-authority redesign).** Summary: contract VALID this round (fixer-test supplied via `--run`, store-authority citation validated), harness verdict BROKEN — but the sole finding is a SUBSTANTIVE FALSE POSITIVE: the probe drove `git commit; git commit` as TWO writes WRITTEN OUT in ONE Bash call and expected the second to be denied, whereas the canonical design is `'once' = one Bash call covering its written-out writes` (the ordinary `add && commit` shape). Decisive in-process repro on the HEAD code: two writes in one call both allowed (intended); a 2nd SEPARATE call DENIED (property 4 holds); a mid-call replacement is unspent and then spent exactly once by the next call (property 2 holds). Recorded INVALID (neither pass nor fail); the charter's property-4 wording caused the wrong oracle. A corrected re-run for a clean independent HOLDS is warranted — orchestrator decides (one sanctioned run spent). See BUG-231 for the full entry.

### 2026-10-05 — dispatch openai
- **Verification recorded:** dispatch openai/default run 01a10df8-9157-76b0-8c9b-bd5fb2cd70d9 — VERDICT: BROKEN — Property 5 BREAKS at CLAIM_MAX_MS: a revoked call outliving 5min has its withdrawn window reaped (git-grant.mjs:240); its next written-out commit decides afresh, eats a mid-call regrant, commits, DENIES a new call. Probe ed70bc971ca6 exit1; fixers 27/0. 2nd finding=round-3 mis-oracle. See log.. Typed entry in the record's verification[]; this line is an echo, not proof.
- **Independent clean-room verification — full detail is in BUG-231's Activity log (same run `01a10df8-9157-76b0-8c9b-bd5fb2cd70d9`, verifying round 4, property-4 CORRECTED per the round-3 INVALID, joint verify of the r4 single-authority redesign; cross-provider openai/default).** Summary: contract VALID, harness verdict BROKEN (manifest-backed). ONE genuine in-scope break — property 5 at the CLAIM_MAX_MS reap boundary: a revoked call that stays in-flight past 5 min has its *withdrawn* window dropped by `reapWindows` (git-grant.mjs:240-243), so the same call's next written-out `git commit` decides AFRESH on the independent path (redeemed=false), consumes a fresh mid-call regrant, commits, and DENIES a genuine new call. The reap (property 7, orphan expiry) and property 5 (withdrawn call stays denied) conflict for a call outliving 5 min. The harness's second finding (replacement mode) is a FALSE POSITIVE — the round-3 mis-oracle: two commits written out in ONE call both running on one once-grant is intended, and a mid-call replacement correctly stays unspent (round-3 B3). Diff scoped as round 3 (focused 7-file range; git-shim.mjs carries the BUG-230 FIFO guard as unchanged authority). Fixer-test verify-feat-164-store-authority 27/0 in-room. Could-not-test: real Bash+shim+leak-scan end to end, Codex path, server restart mid-call, hook-deny-then-retry, SubagentStop/turn-end, concurrency. One sanctioned run spent; an independent HOLDS on the corrected requirement is still outstanding. See BUG-231 for the full entry.

### 2026-10-05 — worker
- **Note:** fixing r5 (joint with BUG-231): done — per-call claim state moved into the grant store; withdrawn/lapsed is terminal per call id. Full detail: BUG-231 Activity log, fixing r5 entry (2026-10-06).

### 2026-10-05 — dispatch openai
- **Verification recorded:** dispatch openai/default run 01a10e18-6f39-7c63-b1e8-3b35038aec21 — VERDICT: BROKEN — BROKEN (VALID, manifest 6 runs). Fixer cc28db7f3e3c exit0 19/0. Two breaks, STOP. P5: initially-DENIED call id left 'unknown', no tombstone; reused id steals a fresh once-grant (7f57e10c4704). P8: fingerprint skip bypasses now-failing gate on identical 2nd write (af310f923a95). See log.. Typed entry in the record's verification[]; this line is an echo, not proof.
- **Independent clean-room verify — joint with BUG-231, verifying round 5 (openai/default, run `01a10e18-6f39-7c63-b1e8-3b35038aec21`, harness scripts/independent-verify.mjs). VERDICT BROKEN (VALID, manifest-backed, 6 runs).** Two in-scope breaks on the single-authority grant store, two-break STOP. BREAK 1 (property 5, high confidence): an INITIALLY-DENIED call id (no grant → write denied) is left `unknown` with NO tombstone, so reusing that id after a fresh `once` grant steals it (commit runs) and denies the genuine new call — a new arm of property 5 that the r5 withdrawn/ended tombstone does not cover; probe `7f57e10c4704` exit 1. BREAK 2 (property 8, scope-dependent): `redeemGitWrite`'s content-fingerprint skip bypasses a now-failing gate on a byte-identical 2nd write; probe `af310f923a95` exit 1 (realism caveat: sound iff the gate is content-deterministic). Full detail + scope + could-not-test list in BUG-231's Activity log (same run id). ONE sanctioned run spent. Kept room cleanroom-verify-9AO88F / record cleanroom-record-fc43Bo.
