```orchard-ticket
{
  "id": "FEAT-164",
  "type": "feature",
  "title": "Agent git-write grant can only be given for 30 minutes",
  "summary": "The control that lets agents run git writes for a project only offers a 30-minute grant, so a project where the user always wants agents to commit needs a fresh grant every half hour. Add a permanent, per-project, explicitly labelled and revocable option, honoured by the same enforcement path as the timed grant.",
  "impact_if_we_wait": "Users who trust agents to commit in a given project must re-grant every 30 minutes; a grant lapsing mid-task stops the agent.",
  "current_need": "RESCOPED 2026-10-12 (non-author reviewer, user-delegated): the guard covers ordinary agent commit/push forms only; exotic flag routes are named residuals. Suite 127/0, gate PASS, no independent HOLDS yet. The structural fix (read-only .git per session) is ARCH-021 option D.",
  "severity": "medium",
  "area": "agent git-write grant",
  "reported": "2026-10-05",
  "reported_by": "agent",
  "owner": "you",
  "work_state": "in_verification",
  "human_action": "decide",
  "updated": "2026-10-14",
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
    "prerequisite": null,
    "answers": [
      {
        "answer_id": "40f9d8b2-7adf-4158-8150-bb4803a94b85",
        "kind": "decision",
        "followup": false,
        "chose": {
          "key": "A",
          "label": "OS caller check plus sealed grant"
        },
        "note": "Decided A on the user's delegation (2026-10-05, orchestrator); recorded per INDEX status.",
        "question": null,
        "by": "user",
        "via": "ticket view",
        "on": "2026-10-12",
        "recorded_at": "2026-10-12T11:22:43.598Z",
        "recorded_by": "server",
        "decision_key": "rec:a2ed312622f69f2b5cda1d2a3cef4e107994d755aad7704507ae57d83e27c159",
        "log_k": 30,
        "heading_sha": "0abbad4dd62e31ed15e48bd233e7583c1213f57476d9500b73c1cd1d1cd3f80d"
      }
    ]
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
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5",
      "run_id": "a6b600b7-880f-460c-b179-2f81576a7878",
      "verdict": "broken",
      "verdict_on": "2026-10-11",
      "recorded_at": "2026-10-11T14:35:55.548Z",
      "author": "independent-verify (clean room, anthropic)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "VALID. Subset retry can publish with ZERO checks: when the dropped newest ticket carried the batch's only check and the project has no gate, the survivor ships with checks []. Fixer 78/0. Single break; fix round 1 follows."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5",
      "run_id": "adb2b039-d5cb-41a5-9144-1bf7d179bea6",
      "verdict": "broken",
      "verdict_on": "2026-10-11",
      "recorded_at": "2026-10-11T14:57:06.202Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "b1858a1ced0e6c3c76e93605807b0dbc1b2d0d5ab0a0d6b5fec4456f484c9678",
      "note": "VALID. P1: guard uses session project's policy; scoped A commits/pushes into ungranted B. P4: gitGuardOn keys on permanent; saved migrated/scoped grant gets container .git:ro. Fixer 77/2: index.ts imports FEAT-175 grant-rebuild.ts, not in candidate. diff 376KB so cap 471000."
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a12c67-2e5d-7732-9edf-8df3124f40bd",
      "verdict": "broken",
      "verdict_on": "2026-10-11",
      "recorded_at": "2026-10-11T19:20:32.592Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "VALID. P1: push destination ignores url.insteadOf; a fixture-path alias rewritten to ungranted B pushed a commit into B under A's grant. Fixer 107/0. Candidate 7fde4d846f77 frozen in a scratch copy: real-store freeze blocked by a FEAT-175 dep cycle."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5",
      "run_id": "73256821-bc1c-44ce-8b18-ac5e4e26fd45",
      "verdict": "broken",
      "verdict_on": "2026-10-11",
      "recorded_at": "2026-10-11T21:18:21.338Z",
      "author": "verify lane (anthropic; openai quota)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "VALID. P1/P4: aliased push (git -c alias.p=push p ...) skips push-target resolution: commit-only grant pushes; scoped+push A pushes into ungranted B and release-mode C. Fixer 115/0. Group 9023f682c49c frozen in scratch copy; 36 files hash-equal live."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5",
      "run_id": "7e3709d5-c98d-4b27-a2b7-df72e5258e37",
      "verdict": "broken",
      "verdict_on": "2026-10-12",
      "recorded_at": "2026-10-12T00:05:57.114Z",
      "author": "verify lane (anthropic; openai quota)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "VALID. P1: push --repo=<scratch> + ungranted positional remote is judged on --repo, lands in ungranted project. P3: creating targets always allowed; release-mode init --separate-git-dir moves real .git. Fixer 115/2 (no-network S9). Group 6aeb561172a8 scratch freeze."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5",
      "run_id": "dc1b17e1-1f8c-4872-82cf-303ed2b7f0a8",
      "verdict": "holds",
      "verdict_on": "2026-10-12",
      "recorded_at": "2026-10-12T11:23:26.237Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "rescoped property; scratch candidate c2c78a6011b6"
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5",
      "run_id": "9bd8c5d3-81ed-4b2f-8b0d-a8147a6ea6f1",
      "verdict": "broken",
      "verdict_on": "2026-10-13",
      "recorded_at": "2026-10-13T18:17:31.556Z",
      "author": "worker (fixing, option A)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "24788bace8ffef9c380db1c729a57cd82884553356f1f6917fcc92a219757f2e",
      "verify_mode": "mixed-state",
      "note": "VALID. Option A. 2 breaks: git panel POST stage/commit/push ungated (agent commits+pushes with no grant); seal bound to id only, so editing unsealed hostPath moves a grant to another repo. OpenAI quota-limited, so Claude Opus. Both fixed after; not re-verified."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5",
      "run_id": "f8f4bf80-7924-4b31-82c4-63af12d3f7cb",
      "verdict": "broken",
      "verdict_on": "2026-10-13",
      "recorded_at": "2026-10-13T18:28:30.235Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "bc1cb231d615ad700795bfb7f34f638ca01e562163f07be6999fc638ccb45353",
      "verify_mode": "mixed-state",
      "note": "Option A re-verify; OpenAI quota, so Opus. Fixer 52/0. PATCH hostPath ungated + timed grant keyed by id only: agent repoints a timed-granted project at an ungranted repo (PATCH or registry edit), shim then allows its git add."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5",
      "run_id": "19ebbe14-9ac8-4995-b917-c8e75f366317",
      "verdict": "broken",
      "verdict_on": "2026-10-13",
      "recorded_at": "2026-10-13T18:46:08.400Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "e33a08c5a68694916096850cfa4f7d5ceeb525246ff4ed68ec1eb617b34a2bda",
      "verify_mode": "mixed-state",
      "note": "Third break: route to independent adjudication. OpenAI quota, so Opus; fixer 62/0. Identity = path strings: agent mv-swaps another repo into the granted path, standing grant still applies (add+commit allowed); moving back revives. Symlink swap holds."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5",
      "run_id": "1659cb7f-53de-4074-b597-93bc45349832",
      "verdict": "broken",
      "verdict_on": "2026-10-13",
      "recorded_at": "2026-10-13T18:58:10.136Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "2f0ec96f5f1d024ac7f3ec4797b62d8e92e810b9f04be5a1f72d3c1479b62661",
      "verify_mode": "mixed-state",
      "note": "VALID, ordinary forms; OpenAI quota so Opus; fixer 127/0. 2 breaks, STOP: container guard leaves an unregistered repo 1 level below a scoped bind root rw; release.mjs resolveTarget maps a path by string prefix, so cut on ungranted repo nested in granted A commits+tags+pushes it."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5",
      "run_id": "95027178-7065-4ed3-b33f-1b6b56d14d7a",
      "verdict": "broken",
      "verdict_on": "2026-10-13",
      "recorded_at": "2026-10-13T22:14:46.832Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "b7131675527fa7b2b7bcd7f8a276fb6d31a5e8435da99d707f551bd046614f63",
      "verify_mode": "mixed-state",
      "note": "VALID; OpenAI quota so Opus; fixer 31/0. New mechanism, route to adjudication: push check covers the OWNER's identity, not the destination's: scoped+push A force-pushes a bare repo nested in A; owner=owners[0], so registry order lets A push into ungranted Q. Nested/release/GIT_DIR/cache held."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5",
      "run_id": "e5d8ca9e-1ce5-4a4e-837d-df77c07693f8",
      "verdict": "broken",
      "verdict_on": "2026-10-13",
      "recorded_at": "2026-10-13T23:11:42.043Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "f25fb3f4c9c69f4faeb92de224949b84107496de841b78af51f784ba1e1e8f5b",
      "verify_mode": "mixed-state",
      "note": "VALID; Opus (OpenAI quota); fixer 38/0. New mechanisms, route to adjudication: file:// not percent-decoded, so a %20 URL reads non-repo and a real push lands in ungranted Q; network URL case/double-slash variants escape Q's veto. Release/worktree regression untested."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5",
      "run_id": "45e78a71-b4f6-40f9-858c-9e6d421c94fe",
      "verdict": "broken",
      "verdict_on": "2026-10-13",
      "recorded_at": "2026-10-13T23:45:13.912Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "a58cb1d571effc8abe79c22abc5744915e28a8e0edb22c58f2d570a1772279f4",
      "verify_mode": "mixed-state",
      "note": "VALID; Opus (OpenAI quota). Owner remotes read raw (no insteadOf): Q's gh: shorthand loses its veto, A pushes into Q (network + local bare; commit landed). Network remote added/repointed after grant allowed. Release/worktree not independently probed."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5",
      "run_id": "619c99b4-5f84-45bc-8167-47571735eaa4",
      "verdict": "broken",
      "verdict_on": "2026-10-14",
      "recorded_at": "2026-10-14T00:18:01.777Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "38822c753ae1fa16ff97a1b6c15c4bd4946183dcf7d14845691303322da5f385",
      "verify_mode": "mixed-state",
      "note": "VALID; Opus (OpenAI quota); fixer 51/0. Careless-plausible: release push uses live origin/upstream, so after set-url or an added upstream remote it lands unrecorded. Push into another GRANTED project by path/URL skips source grant (ungranted A landed in B; leak gate keyed on B)."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5",
      "run_id": "6efa2e34-e237-4893-ab4b-72cc753c7999",
      "verdict": "broken",
      "verdict_on": "2026-10-14",
      "recorded_at": "2026-10-14T01:01:10.508Z",
      "author": "verify lane (anthropic; openai quota)",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "68d88fda161b1f31b07014daf1fd18da5f4bde59a893463d8d83b22fa6f71b3a",
      "verify_mode": "mixed-state",
      "note": "VALID; fixer 56/0. (1) Container projects bypass decidePush: no shim, hook uses standing grant, so git push allowed under commits-only and release mode. (2) Regression: guard caps (depth 8/20000 dirs) truncate on ordinary node_modules; granted .git goes ro. No container e2e."
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

## Plan: scoped grants and soft releases (2026-10-11, fixing, plan+review)

### The user's decision (relayed verbatim by the orchestrator, 2026-10-11)
> "default no commits, each project the user requests and will inform the scoping; when undetermined scoping, use whatever is appropriate, while avoiding spam to main GitHub — instead it must be like soft release versions."

The threat model is careless or habitual agent commits, not a malicious agent (the user's own statement here and in the ARCH-021 log of 2026-10-08). That settles the self-grant decision card above: no provenance or sealing is built. A same-uid agent that deliberately edits the registry or POSTs the loopback grant route stays a stated residual, the same class as ARCH-021's. The card's answer is the orchestrator's or user's to record; this lane does not forge it.

### Invariant
1. With no grant (the default), no agent work reaches a project's real repo or remote. This is unchanged.
2. Under a commit grant with an undetermined scope, the real repo receives agent work only as release commits. Each release is one commit plus one version tag covering a batch of finished tickets that are verified (HOLDS bound to the exact candidate hash). Agents never write the real repo directly. A release is published only after the gate and the checks pass on the exact tree being committed.
3. A push to a project's real remote happens only from a release (in release mode) and only when push is granted. In scoped mode it happens only when push is granted.

### Evidence that shaped it
- The private bot project holds the only standing grant: a legacy `{permanent:true}`, granted 2026-10-07. Since 10-06 it has 80 direct commits on main (26 on 10-10, 29 on 10-11) and 123 audited `git push`. That is the spam pattern.
- The same grant also carries about 6,000 fixture-repo writes (`git -c protocol.file.allow…`, `core.fsmonitor`, `update-index`). Release mode must keep those working, so the restriction is on the real repo, not on all git.
- The Orchard board has 23 tickets that got a typed HOLDS in the last 30 days, over 10 active days, peaking at 6 a day. The user's own cadence was 4 batch commits in 30 days, one of them 415 files and unsplittable.
- The private bot project's board is prose and holds no typed verdicts. FEAT-170 candidates can therefore never be "verified" there today, so a release there stays empty until it adopts typed verdicts (`board-tool verified`).

### Settings shape: one declared project setting (ARCH-010)
`settings.gitWrite`, written only by `registry.setGitWritePolicy` and read only through `gitWritePolicyOf` (which normalises with `normalizeGitWrite` in `scripts/lib/agent-git-policy.mjs`, the one rule):
```
{ commit: boolean,            // agent work may reach the real repo
  push: boolean,              // ...and its remote (needs commit)
  scope: string | null,       // the user's scope note; blank = undetermined
  release?: { minTickets?, maxWaitHours?, minIntervalHours?, checks?: string[], tagPrefix? },
  grantedAt, grantedVia }
```
- Derived **mode** (one function):
  - `none`: no commit grant.
  - `scoped`: commit plus a non-blank note.
  - `release`: commit with no note.
- Legacy `{permanent:true}` reads as `{commit:true, push:false, scope:null}`, which is release mode (the user's rule for an undetermined scope). There is no unattended push, because the push grant is new and explicit (review #5). Nothing is rewritten on disk until the user saves.
- The generic settings PATCH keeps refusing `gitWrite`.

### Enforcement (existing chokepoints, one new deny-only guard)
- **E1, grant store, unchanged code.** The permanent source answers truthy iff mode ≠ none. A commit grant therefore still lets agents write scratch and fixture repos (leak gate as today).
- **E2, real-repo guard.** `realRepoWriteRefusal({mode, push}, verb, target, protectedDirs, timedLive)` is one pure function. `/api/git-shim/decide` calls it before redeem.
  - The shim sends `target`, the git common dir resolved by the real git with the invocation's own global options and env (the shadow-guard resolver). `init`/`clone` report `creating`.
  - **protected** means the target equals, or lies inside, the git common dir of any registered project.
  - An unresolvable target counts as protected only when the invocation's cwd (realpath, after `-C`) lies inside a registered hostPath. Elsewhere it counts as unprotected, so fixture writes with odd global options keep working (review #2).
  - **Push is judged by DESTINATION (review #1).** For `push`/`send-pack` the shim sends the destination URLs (argv URL, or `remote.<name>.pushurl`/`url` read by the real git under the invocation's globals, falling back to the branch's remote).
    - A network URL, or a local path that resolves to a protected repo, is a real-remote push.
    - An undeterminable destination counts as real.
    - A local non-registered bare repo (a fixture remote) is not.
  - Rules:
    - a real-remote push is refused unless the mode is `scoped` and push is granted, even under a live timed grant (review #7);
    - otherwise a live timed or once grant → no guard (the user's explicit 30 minutes lifts direct commits only);
    - not protected → no guard;
    - `release` → deny, and the message names the release path.
  - The shim prints a host reason that starts with `orchard:` VERBATIM, so the agent learns the policy at the refusal (review #8).
  - The Bash hook still permits first and the shim then denies. That costs one leak-gate run and leaves a `permitted` audit row with no `executed`. This is stated, not fixed: a hook-side resolution would be text parsing (ARCH-021).
- **E3, containers (BUG-244).** `gitGuardOn` reads the normalised mode: `.git` is rw only in `scoped`. Release mode keeps the `:ro` overlay, so it holds structurally there.
- **E4, the agent sees its policy.** When a grant exists, agent-bridge appends a "Git policy for this project" note to the system prompt (mode, the scope note verbatim, the release command). A project with no grant gets byte-identical output.

### Release batching: the single publisher in release mode
`scripts/lib/release.mjs` + `scripts/release.mjs` (`npm run release -- <verb>`).
- **Eligible candidate:** an open FEAT-170 candidate whose:
  - files are all CURRENT;
  - files are not STALE-BASE;
  - members each have a HOLDS bound to its hash (`ticketSatisfied`);
  - dependencies are in the same batch or already committed.
  A path shared by two candidates that are not dependency-related excludes the later one. Everything else is excluded, with the reason listed.
- **Due (the default, adjustable per project):** eligible ≥ 1, and ≥ `minIntervalHours`=24 since the last release, and either eligible ≥ `minTickets`=5 or the oldest eligible has waited ≥ `maxWaitHours`=72.
  - At Orchard's measured rate (about 0.8 verified tickets a day, bursts of 6) that gives about 2 releases a week of 3–5 tickets. Its ceiling is 1 a day, against 26–29 commits a day today on the private bot project and 4 monthly mega-batches by hand.
  - The user's `--now` skips the cadence only. It never skips eligibility or checks.
- **Cut:**
  1. Take the release lock.
  2. Compute the batch.
  3. Tree = HEAD + every member's frozen bytes, in freeze order (`buildTree`).
  4. Check out that exact tree in a throwaway `--shared` clone with its remote removed, and run the checks there:
     - the project's `release.checks`, by default `npm run gate` when `package.json` has a `gate` script;
     - plus every member's recorded `--check`.
     - Zero checks → refuse.
  5. On any failure, retry without the most recently verified member, up to 2 more times, and publish the largest passing subset (review #4). If nothing passes: refuse, write nothing, and record the failure keyed by tree (auto does not retry the same tree). Two consecutive refused auto attempts, or the oldest eligible ticket waiting more than 2×`maxWaitHours`, raise ONE Needs-You card for the project (`decisions.raise`): "Soft release blocked".
  6. Re-check eligibility.
  7–11. Publish through ONE publisher shared with `candidate commit` (review #3): `publishFrozenTree` in candidate-store.mjs, extracted from `commitCandidate`. It does the staged-path refusal, the temp index, pre-commit and commit-msg (leak gate), the hook-changed-index refusal, `commit-tree`, then ONE `update-ref --stdin` transaction: HEAD (expected old value) plus, for a release, `refs/tags/<tag>` (create), so the commit and the tag are atomic. It then syncs the real index for these paths only and marks the members committed. An existing tag name is skipped by bumping the patch version (review #9).
  12. Append to `<git-common-dir>/orchard-releases/log.jsonl`.
- **Version:** the latest `<prefix>X.Y.Z` tag reachable from HEAD (default prefix `v`; none → `v0.1.0`). Any FEAT member bumps the minor version; otherwise the patch.
- **Message:**
  - subject: `Release v0.4.0: 3 tickets`;
  - one changelog line per ticket: id, title from the board record, verify run, candidate short hash;
  - trailers: `Orchard-Release: v0.4.0` plus one `Orchard-Candidate: <hash>` per candidate, so FEAT-170's `ready`/reconcile already treat those candidates as committed.
- **Push** (only at a release, and only if `push` is granted, or if the user passes `--push` in a terminal): `git push --atomic <upstream remote> <commit>:refs/heads/<branch> refs/tags/<tag>`.
  - A failed push leaves the release local and `pushed:false`.
  - `release.mjs push` (or the next auto tick) retries it.
- **Who can cut:**
  - The user's terminal, in any mode. This is the ONE obvious command: `npm run release -- cut <project> [--now] [--push]`, with `plan` to preview.
  - The station, under a commit grant, as a child process spawned outside any shim.
    - It runs from `POST /api/projects/:id/release`. The body must be `{}`, and every parameter comes from the registry, so there is no force and no push override (review #6). Agents call it through `release.mjs cut <project> --via-station`, with the cadence enforced.
    - It also runs from an auto tick every 15 min for release-mode projects only (`ORCHARD_RELEASE_TICK=0` turns it off).
    - A station-cut release pushes only if push is granted. Legacy grants map to push off.
  - An agent running the cut itself in-session is refused by E2 at `update-ref` in release mode, and by the store in none mode. There is no second, weaker check inside the tool.

### Settings UI: one place
Project Settings drawer, new **Agent git** section:
- "Agents may commit" and "…and push";
- the scope note (placeholder: "Blank = soft releases: work is batched into verified, versioned release commits");
- the cadence fields and the checks list;
- live status: mode, eligible tickets, when the next release is due, last release;
- "Cut release now (if due)" (the station route, so the cadence applies; forcing is the terminal's `--now`).
The git panel keeps "Allow 30 min" and Revoke. Its "Allow permanently…" becomes "Settings…", which opens that section. Every control uses ONE writer route: `PUT /api/projects/:id/git-write-policy`. The legacy `POST git-write-grant {scope:'permanent'}` maps to commit+push with no note, and `DELETE` clears commit/push but keeps the note and cadence.

### Failure modes
| Where | Outcome |
|---|---|
| A check or the gate fails on the release tree | Refused; HEAD, tags and index unchanged; failure recorded; auto does not retry the same tree |
| HEAD moves during the cut | The `update-ref` transaction fails; nothing published (neither commit nor tag) |
| A crash after publish | Trailers reconcile the candidate state (FEAT-170 `reconcileCommitted`); the log is rebuilt from the tags |
| The push fails or there is no remote | Release kept local, `pushed:false`, retried by `release.mjs push` or the tick |
| Two cuts at once | The release lock (pid-checked) lets the second exit "busy" |
| Staged changes on release paths | Refused, as `candidate commit` does |
| A project with no verdict source (prose board) | Nothing eligible; `plan` says why |
| A non-git project | `release` exits "no repo"; agents simply cannot commit there |
| A container project | Cut on the host (station/user); `.git` ro in the container in release mode |
| Absolute-path git or a scrubbed PATH in release mode | The text hook permits under the grant; only the shim applies E2. This is a stated residual (ARCH-021 class); careless agents use PATH git |
| Release checks run outside any shim | A member's agent-recorded `--check` runs as the user in the throwaway clone (cwd = clone, no remote, no `GIT_*` redirects). A check that deliberately targets the real repo by path is a stated residual under the careless threat model. Shimming the checks would refuse the fixture-repo git that Orchard's own suites need |
| A timed grant revoked between E2's live check and the claim | ms-window over-grant, leak-gated; stated |

### Migration
- No on-disk rewrite. Legacy `{permanent:true}` (the private bot project) is read as release mode from the next server start: its agents stop committing to main directly, while fixture git keeps working. It stays empty until the private bot project has typed verdicts.
- One edit restores direct commits: a scope note in Settings, e.g. "commit to main; push at most daily". This is reported as the user's one item.
- No grant: nothing changes. Timed grants: nothing changes.
- Rollback: revert the edited files. The stored shape is a superset, so the legacy reader still treats `{commit:true}` without `permanent` as no grant, which fails closed.

### Proof bar (persistent suite `scripts/verify-feat-164-release.mjs`, run through `scripts/confined-run.mjs`; each property must FAIL on a named baseline and pass after)
- **P1 ungranted:** an agent- or auto-triggered cut and a shim real-repo commit on a no-grant project leave HEAD unchanged. Baseline: a mutant with the grant check removed commits.
- **P2 one release for N:** N=3 verified candidates give exactly 1 new commit plus 1 tag whose tree = HEAD + the frozen bytes. Baseline: today's `candidate commit` per ticket gives 3 commits.
- **P3 unverified excluded:** a 4th candidate with no HOLDS (and one with a later BROKEN) is absent from the tree and the message. Baseline: a mutant that skips `ticketSatisfied` includes it.
- **P4 push:**
  - Push granted: a local bare remote receives the commit + tag only at the cut.
  - Not granted: the remote is unchanged.
  - E2 refuses an agent's real-repo `git push` and `git commit` in release mode, while a fixture repo commit is allowed.
  - Baseline: the legacy permanent grant allows the real-repo push and commit.
- **P5 gate failure:** a release tree whose check fails is refused; HEAD, tags and remote unchanged. Baseline: a mutant that skips the checks publishes the broken tree.
- Plus: cadence (due/not due), version bump, atomic HEAD+tag on HEAD moved, settings normalisation and the legacy mapping, gitGuardOn per mode, prompt-note byte-identity for no grant.
- Regressions: the FEAT-164/108/BUG-173/231/242/244 and FEAT-170 suites, then `npm run gate`.

### Plan review 1: Claude Opus, separate process (`claude -p --permission-mode plan`); saved at `scratch/feat164-release/review-1-claude-opus.txt`
OpenAI was at its usage limit (the dispatch reported `quota-window`, reset at 20:26), so this review is NOT cross-provider. Verdict: **SOUND-WITH-CHANGES**.

| # | Finding | Disposition |
|---|---|---|
| 1 | blocker: E2 judged the local repo, so a push from a clone or shadow to `origin`/GitHub got through | **Accepted.** Push is now judged by destination URL (above). |
| 2 | "Unresolvable means protected" breaks fixture writes | **Accepted.** That rule now applies only when the cwd is inside a registered hostPath. |
| 3 | Two publishers (the cut re-implemented `commitCandidate`) | **Accepted.** `publishFrozenTree` is shared; `commitCandidate` calls it. The FEAT-170 suite is a regression gate. |
| 4 | A failing check stalls releases silently | **Accepted.** Subset retry (drop the newest, ≤2 retries) plus one Needs-You card after 2 refusals or 2×maxWait. |
| 5 | Legacy maps to push:true, so the private bot project would push unattended | **Accepted.** Legacy maps to push:false. The tick stays on: the dispatch asks for "automatic under the grant", and with push off it only commits locally. |
| 6 | The release route has no contract, and checks run unshimmed | **Partly accepted.** The route takes `{}` only and reads everything from the registry, with no force. Shimming the checks is rejected: it would refuse the fixture git that suites need. Stated as a residual. |
| 7 | A timed grant re-opened push | **Accepted.** A real-remote push needs scoped mode with push granted, always. |
| 8 | The refusal text was mangled, and the hook permits first | **Accepted** (verbatim reason). The hook-first permit is stated (above). |
| 9 | A tag collision blocks the release | **Accepted.** The patch version is bumped until the tag name is free. |
| 10 | Unlisted readers on `permanent === true`, and the grantedAt incarnation | **Accepted.** The registry's `gitWritePermanentOf` becomes the store's projection (`{permanent:true, grantedAt}` iff mode ≠ none), and every save stamps a new `grantedAt`, so a claim minted under one mode never survives a switch. `gitGuardOn` reads the normalised mode. |
| 11 | Nothing can release on day 1 | **Noted, not a change.** The publisher is in scope per the dispatch. The proofs run it on fixtures. |

## Rescope (2026-10-12) — non-author reviewer decision; rounds stopped

**Decided by:** the coordinator, as non-author reviewer, on the user's delegation, after verify 7e3709d5-c98d-4b27-a2b7-df72e5258e37 (the 13th BROKEN). Per WA §N this is the independent design review the two-break rule calls for. The outcome is **RESCOPE**. No further fix rounds or verifies run against the old property.

**Why:** every break since round 2 used a new git-argument route:
- the session's policy instead of the target's;
- unregistered repos;
- insteadOf / pushInsteadOf / include;
- aliases;
- `--repo`;
- `init --separate-git-dir` / `--template`.

A guard that parses git command lines is enumerated by construction: the next unusual flag is the next break. The user's stated threat model is careless or habitual autonomous commits and pushes (about 200 one-fix commits a day, a broken main), not deliberate evasion (user, ARCH-021 log 2026-10-08; restated in this ticket's plan). Closing every exotic flag combination costs more than the class it protects against. The structural fix is OS-level, not more parsing.

**The rescoped property (what FEAT-164 promises):** for the ORDINARY forms an agent uses on a real repo — `commit`, `push`, `merge`, `rebase`, `reset`, `tag`:
1. **Default no agent commits.** An ungranted project gets no agent commit or push.
2. **The TARGET repo's policy decides, never the session's.** The repo git resolves as the target is mapped to the registered project that owns it. A repo that belongs to no registered project is ungranted, except a fixture under the scratch roots (scratch, system tmp, shadow root, confined /work).
3. **Push destinations are resolved by git** (`remote get-url --push`, `ls-remote --get-url`, including insteadOf / pushInsteadOf / includes), and **aliases are expanded by git** (`config --get alias.*`, recursive, depth-capped). A shell (`!`) alias or an unresolvable alias or destination is refused.
4. **Scoped mode** (commit plus a scope note) allows direct commits and, if granted, pushes. **Release mode** (commit with a blank note) refuses direct real-repo writes. Its work reaches the repo only as batched, verified, gate-checked soft-release commits plus a version tag (`scripts/release.mjs`). Nothing unverified ships, a gate failure refuses the release, and a release pushes only if push is granted.
5. **Existing permanent grants keep their behaviour** (migrated scoped note, visible in Settings).
6. **Containers:** `.git` is rw only in scoped mode (FEAT-175 applied the `gitGuardOn` change).

**Proof for the rescoped property:** `node scripts/confined-run.mjs --no-git -- node scripts/verify-feat-164-release.mjs` gives 127 passed, 0 failed. Every property has a must-FAIL on a pinned or synthesized baseline (P1–P5, M, X, U, W, AL, K, R2). Also: settings UI 18/0, regressions green, `npm run gate` PASS. There is NO standing independent HOLDS, so the ticket is not VERIFIED (board rule 5).

**Accepted residuals (recorded by name; outside the rescoped property):**
1. `push --repo=<x>` combined with configured remotes: judged on `--repo` only (verify 7e3709d5).
2. `init --separate-git-dir` / `init --template` in release mode (verify 7e3709d5).
3. git by absolute path, git's exec-path copy (`/usr/lib/git-core/git`), or a scrubbed PATH: bypasses the PATH shim (FEAT-135 / ARCH-021).
4. The Bash text hook decides by the SESSION's grant. An ungranted session's typed `git -C <scoped repo> commit` is denied (fails closed). The hook also permits first in a granted session and the shim then refuses, which wastes one leak-gate run and leaves a `permitted` audit row.
5. Same-uid tampering: editing the registry JSON, calling the loopback grant route, rewriting `.git` with non-git tools (the earlier A/B/C self-grant fork; FEAT-164 r2).
6. An external `git-<cmd>` (e.g. git-lfs) that contacts a remote by itself, without calling git.
7. Release checks run outside any shim, in a throwaway clone with no remote.
8. A timed grant revoked in the milliseconds between the guard and the store claim.
9. Shadow-root residuals (FEAT-170): a symlink swapped inside a lane `.git` between check and exec; cross-lane `-C`.
10. Container residuals (BUG-244): the docker-socket opt-in; repos nested two or more levels below a bind root.
11. Accepted costs, not breaks: a raw-URL push while any pushInsteadOf is configured is refused (git exposes no resolver); every shell (`!`) alias is refused.
12. Same-uid repo substitution: moving another repo into a granted path keeps the grant, and moving it back revives it. Deliberate tampering, same class as 5; option D (ARCH-021) retires it.
13. Container sessions bypass decidePush; push enforcement in containers requires OS-level isolation (ARCH-021 option D).

**The structural fix is a separate proposal to the user:** OS-level session isolation, where each agent session runs with the real repos' `.git` read-only unless the project is granted (mount namespace / separate uid). That makes the property hold by construction for every command form and retires residuals 1–6. It is ARCH-021's option D (and FEAT-170's sealed-copy option C). Decide it there; it is not part of FEAT-164.

**The A/B/C self-grant decision card on this record** predates the user's decision of 2026-10-11. The user's threat model (careless, not malicious) answers it as "no OS provenance or sealing in FEAT-164", which is residual 5 above. Only the orchestrator or user records that answer on the card; this lane did not forge it.

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

### 2026-10-11 — worker (fixing)
- **Note:** fixing (plan+review), 2026-10-11: Plan written in the body ("Plan: scoped grants and soft releases"), from the user's decision relayed by the orchestrator (default no agent commits; a scope note per project; an undetermined scope gives batched soft releases). Plan review: OpenAI quota-window, so a separate Claude Opus process ran it, with verdict SOUND-WITH-CHANGES and 11 findings. 10 were adopted; the request to shim the checks was rejected and stated as a residual. Disposition table is in the body. COORDINATION (container lane, BUG-244): gitGuardOn in container-manager.ts will read the normalised policy (scripts/lib/agent-git-policy.mjs normalizeGitWrite). The .git overlay is rw only in mode scoped (commit granted plus a scope note). Release mode and the legacy permanent grant keep it ro. A grant-change rebuild should key on that mode, not on settings.gitWrite.permanent. Build in progress.

### 2026-10-11 — worker (fixing)
- **Note:** fixing (plan+review) — BUILT, per the plan in the body (scoped grants and soft releases). Class plan+review; plan review was Claude Opus as a separate process (OpenAI hit its quota window); 10 of 11 findings adopted.

  WHAT EXISTS NOW
  - Setting: settings.gitWrite = { commit, push, scope, release:{minTickets,maxWaitHours,minIntervalHours,checks,tagPrefix}, grantedAt, grantedVia }.
    - ONE rule: scripts/lib/agent-git-policy.mjs normalizeGitWrite → mode none | scoped (commit + note) | release (commit, blank note).
    - Legacy {permanent:true} reads as release mode with push OFF.
    - ONE writer: registry.setGitWritePolicy (via PUT/DELETE /api/projects/:id/git-write-policy and the r1 grant route). ONE reader: gitWritePolicyOf.
    - The store projection gitWritePermanentOf = a standing grant iff mode ≠ none, so fixture repos stay writable. Every save stamps a new grantedAt (the claim incarnation).
  - Enforcement:
    - The shim resolves each write's target with the real git (shadow-guard resolveWriteTarget: common dir, cwd, push destination URLs) and sends it to /api/git-shim/decide.
    - Before any claim, decide calls decideRealRepoGuard:
      - release mode refuses every write to a REGISTERED project's real repo;
      - a push reaching a real remote (judged by destination) needs scoped + push, even under a 30-min grant;
      - mode none adds nothing.
    - The refusal text reaches the agent verbatim.
    - agent-bridge appends a "Git policy for this project" note to the system prompt (null for no grant).
  - Soft releases: scripts/lib/release.mjs + scripts/release.mjs (npm run release -- plan|cut|push|auto|policy <project>).
    - Eligible = FEAT-170 candidate CURRENT, not STALE-BASE, HOLDS bound to its hash, no later BROKEN.
    - Cadence default 5 tickets / 72 h / 24 h, per-project override.
    - Checks (project gate plus each member's --check) run on the exact tree in a throwaway shared clone. On failure it retries without the newest ticket (up to 2 times); zero checks → refused.
    - Publication goes through the shared publisher candidate-store publishFrozenTree, also now used by `candidate commit`: hooks, then ONE update-ref transaction for HEAD + annotated tag.
    - The changelog message carries Orchard-Release and Orchard-Candidate trailers.
    - Push happens only at a release, only when granted (or the user's --push).
  - Station:
    - POST /api/projects/:id/release takes {} only, needs a commit grant, and runs `release.mjs cut --as-agent` as a child process.
    - A 15-min auto tick (release mode only; ORCHARD_RELEASE_TICK=0 turns it off) raises one Needs-You card after two refused cuts or a 2×maxWait wait.
  - UI (worker lane): Project Settings → Agent git section (commit/push toggles, scope note, cadence, release status, Save/Revoke/Cut release now). The git pill's "Allow permanently…" became "Settings…", and the pill reads "Agent git · soft releases|scoped".

  PROOFS (all confined or isolated; never a real repo)
  - `node scripts/confined-run.mjs --no-git -- node scripts/verify-feat-164-release.mjs` → 78 passed, 0 failed (scratch/feat164-release/runs/run5.log). Each property must-FAILs on a named baseline:
    - P1 ungranted gets no commit: a mutant with the grant check removed released v0.1.0; real code refuses via auto, cut --as-agent, the lib, and the station route (403).
    - P2 one release for N=3: today's per-ticket candidate commit gave 3 commits; the release gave 1 commit plus annotated tag v0.1.0, with the tree = HEAD + frozen bytes and the hook seeing exactly 3 files.
    - P3 unverified excluded: a mutant without the verdict check would ship BUG-304 (no verdict) and BUG-305 (later BROKEN); real code excludes them plus a CHANGED one, with reasons.
    - P4 push: with the decide host WITHOUT the guard (= today's standing grant), an agent's real-repo commit, clone→real push and real→remote push all landed. In release mode, through the REAL shim executable, all three are refused while a fixture repo commits and pushes. A not-due release pushes nothing; push granted puts exactly the release commit + tag on the remote; push not granted leaves the remote untouched.
    - P5 gate failure: a mutant ignoring checks shipped BREAKS_MAIN; real code refuses with HEAD, tags and remote unchanged, does not retry the same tree on auto, and raises the alarm after two cuts. A subset retry ships the good ticket without the breaker.
    - Also: cadence, the --now scope, versions plus a tag collision, HEAD moved / hook refused → nothing published, zero checks refused, busy lock, and the station routes on an isolated scratch server (S9).
  - UI: verify-feat-164-settings-ui 15/0 (pre-change UI 1/9 must-FAIL); verify-feat-163-165-git-bar 43/0. Screenshots docs/bugs/assets/FEAT-164-agentgit-*.png (both themes); reviewed, and a visible "Scope note" label was added after review.
  - Regressions (confined): FEAT-170 candidates 93/0 (shared publisher), shadow 57/0, FEAT-135 31/0, BUG-173 28/0, BUG-184 28/0, BUG-231 21/0, BUG-242 21/0, FEAT-108 grant 71/0 + block 241/0, FEAT-164 permanent 41/0 (A2/B4/B8 updated to the new stored shape), single-authority 31/0, store-authority 28/0, bug-240/bug-230 exit 0.
  - `npm run gate` → GATE: PASS (leak, check-nul, prompt-privacy, typecheck) at 17:05.

  NOT DONE / RESIDUALS
  - container-manager.ts gitGuardOn is still keyed on `.permanent === true`. The file has been locked by the FEAT-175 lane the whole time (FEAT-129), so I did not force it. The exact change is posted on FEAT-175's log, which also asks for its grant-rebuild fingerprint at index.ts. Effect until it lands: a NEW-shape grant leaves a container's .git read-only, which fails closed, so scoped container projects can't commit in-container yet. No container project holds a grant today.
  - The decide-route wiring was not driven end-to-end through a launched session (the shim secret is memory-only per boot). The same decideRealRepoGuard runs behind the real shim executable in S2.
  - Stated residuals: absolute-path git or a scrubbed PATH (the text hook permits under a grant; ARCH-021 class); the hook permits first and the shim then refuses (one wasted leak-gate run plus a `permitted` audit row); release checks run unshimmed in the throwaway clone; a ms window if a timed grant is revoked between the guard and the claim.
  - The self-grant decision card (A/B/C) above: the user's stated threat model (careless, not malicious) settles it as "no provenance/sealing". The orchestrator or user should record that answer; this lane did not forge it.

  USER-VISIBLE CONSEQUENCE (needs restart)
  The one live standing grant (a direct project, legacy {permanent:true}) becomes RELEASE mode with push off from the next server start. Its agents stop committing and pushing to main directly, while fixture git keeps working. That project's board has no typed verdicts, so no release will be eligible until it does. To restore direct commits: Settings → Agent git → write a scope note.

  Changed files (unstaged; no git writes on real repos):
  - new: scripts/lib/agent-git-policy.mjs, scripts/lib/agent-git-policy.d.mts, scripts/lib/release.mjs, scripts/release.mjs, scripts/verify-feat-164-release.mjs, scripts/verify-feat-164-settings-ui.mjs
  - edited: scripts/lib/candidate-store.mjs, scripts/lib/shadow-guard.mjs, scripts/lib/git-shim.mjs, scripts/lib/git-shim.d.mts, scripts/lib/git-grant-store.mjs, scripts/lib/git-grant-store.d.mts, src/server/registry.ts, src/server/index.ts (FEAT-164 hunks only), src/server/agent-bridge.ts (FEAT-164 hunk only), scripts/verify-feat-164-permanent-git-grant.mjs, scripts/verify-feat-163-165-git-bar.mjs, public/lib/api.js, public/lib/drawer.js, public/lib/git-view.js, public/git-view.css, public/styles.css, public/app.js, package.json, scripts/test-manifest.json
  - also: container-manager.ts has one FEAT-164 import line (normalizeGitWrite), so the pending gitGuardOn change compiles.

  Symptom of a deeper design flaw? Yes, already filed: ARCH-021 (same-uid enforcement is policy, not structure). This build adds no new authority: the one guard is deny-only, and the publisher is shared.

### 2026-10-11 — independent-verify (clean room, anthropic)
- **Verification recorded:** dispatch anthropic/claude-opus-5 run a6b600b7-880f-460c-b179-2f81576a7878 — VERDICT: BROKEN — VALID. Subset retry can publish with ZERO checks: when the dropped newest ticket carried the batch's only check and the project has no gate, the survivor ships with checks []. Fixer 78/0. Single break; fix round 1 follows.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-11 — worker (fixing r1)
- **Note:** fixing round 1 (the one allowed), after independent verify a6b600b7-880f-460c-b179-2f81576a7878 (anthropic/claude-opus-5, clean room, --working-tree; contract VALID; verdict BROKEN, recorded typed).

  THE BREAK (reproduced first, pinned): cutRelease checked `no-checks` once, before the subset-retry loop.
  - If the newest ticket carried the batch's ONLY check and the project had no gate script, dropping that ticket left a survivor with zero checks.
  - The survivor was published and tagged with `checks: []` in the log, and the CLI printed "Checks passed".
  - The verifier hit it two ways: a one-drop case (B) and a two-drop case (F). Both are the same code path and the same property (5), so this is a single break, not a two-break.

  FIX (two points, same property):
  - (a) Every attempt inside the retry loop refuses `no-checks` when no check covers its batch.
  - (b) The publish point asserts that the exact tree about to be published has at least one check on record, all passing.

  ALSO CLOSED from the verifier's could-not-test list: the live host built its protected set from registered work trees only. A registered project whose origin is a LOCAL bare repo (its "GitHub") was therefore not a real remote, and the round-1 suite hand-inserted that remote. Now `protectedRepoDirs` also protects every registered repo's local-path remotes (agent-git-policy localRemoteDirsOf), and the suite builds the set with the host's own function.

  PROOF: `node scripts/confined-run.mjs --no-git -- node scripts/verify-feat-164-release.mjs` → 84 passed, 0 failed (scratch/feat164-release/runs/run7.log).
  - New R2.1 and R2.2 run the verifier's B and F shapes against the REAL round-1 bytes, pinned at scripts/fixtures/feat-164/release-r1.mjs. Round 1 published unchecked (released v0.1.0, unchecked-in-log=true). Now both are refused `no-checks` with no commit and no tag.
  - R2.3 control: with a gate script, the survivors ship and the log records the checks.
  - S1.0b: the local bare origin is protected and an unregistered fixture remote is not.
  - The P5 baseline mutant now has to disable both check points to publish broken bytes (it still does: must-FAIL intact).
  - `npm run gate` → PASS.

  STATUS: FIXED, not re-verified. The dispatch allowed one independent verify, and it was spent. Next step: one cross-provider verify (OpenAI was in a quota window until 20:26).
  Files this round: scripts/lib/release.mjs, scripts/lib/agent-git-policy.mjs (+ .d.mts), scripts/verify-feat-164-release.mjs, new scripts/fixtures/feat-164/release-r1.mjs.
  STILL PENDING (another lane's lock): container-manager.ts gitGuardOn → standingGitWriteOpen (mode scoped), plus the grant-rebuild fingerprint in index.ts. The exact text is on FEAT-175's log. Until then it fails closed for new-shape grants.

### 2026-10-11 — worker (fixing r1, migration)
- **Note:** Coordinator change, 2026-10-11 (migration). An existing permanent grant keeps EXACTLY its behaviour.
  - normalizeGitWrite reads a legacy {permanent:true} as scoped mode: commit and push, with MIGRATED_SCOPE_NOTE ("Direct commits and pushes as before (migrated from the earlier permanent grant — edit or clear this note to change it).").
  - Nothing on disk is rewritten. The note is persisted only when the user saves.
  - An unsaved migrated grant adds no prompt note, so agent prompts stay byte-identical.
  - Only NEW grants with a genuinely blank note get release mode.
  - Settings → Agent git shows a "Migrated grant" callout above the scope note.
  - Release status and "Cut release now" now render only in release mode, because in scoped mode they wrongly suggested auto-releases (found in the screenshot review).

  Proofs:
  - verify-feat-164-release (confined) → 89/0.
    - M1 must-FAIL: the pre-migration normaliser (legacy reverted to release mode, synthesized from its exact prior lines) refuses the real-shim direct commit and push. The migrated one lets both through.
    - M2: a new blank grant is refused.
    - M3: re-saving keeps the behaviour.
    - S0.11b: no prompt note.
  - verify-feat-164-settings-ui → 18/0 (the migrated section seeds the r1 shape on a scratch server and checks that disk is unchanged and that the callout, note and toggles show). Screenshots: docs/bugs/assets/FEAT-164-agentgit-migrated-{light,dark}.png, reviewed.
  - verify-feat-164-permanent 41/0.
  - npm run gate PASS.

  The earlier "needs restart → the one live legacy-grant project becomes release mode" consequence no longer applies; its behaviour is unchanged after a restart.
  Files: scripts/lib/agent-git-policy.mjs (+ .d.mts), public/lib/drawer.js, public/styles.css, scripts/verify-feat-164-release.mjs, scripts/verify-feat-164-settings-ui.mjs.

### 2026-10-11 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5 run adb2b039-d5cb-41a5-9144-1bf7d179bea6 — VERDICT: BROKEN — VALID. P1: guard uses session project's policy; scoped A commits/pushes into ungranted B. P4: gitGuardOn keys on permanent; saved migrated/scoped grant gets container .git:ro. Fixer 77/2: index.ts imports FEAT-175 grant-rebuild.ts, not in candidate. diff 376KB so cap 471000.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-11 — worker (fixing r2)
- **Note:** fixing round 2 (the one fix round after verify adb2b039-d5cb-41a5-9144-1bf7d179bea6, BROKEN, P1 + P4).

  P1 FIXED, structurally. The TARGET repo picks the policy, never the session.
  - New agent-git-policy.mjs decideByTarget. The shim already resolves each write's target with the real git (common dir, cwd, push destinations). The host maps that target to the registered project that OWNS it: by common dir or local-path remote (the longest match wins), and by normalised network remote URL for pushes.
  - That owner's policy decides: none → refused; release → refused (soft releases); scoped → allowed; a timed grant on it lifts commits only.
  - The grant-store claim, the leak gate and the ledger record now run against that project. The decide reply carries projectKey and the shim confirms with it.
  - The BUG-231 hook window is redeemed only when target == session project.
  - The old session-keyed guard (realRepoWriteRefusal / decideRealRepoGuard / protectedRepoDirs / isProtectedTarget / pushReachesRealRemote) is DELETED. Its real bytes are pinned at scripts/fixtures/feat-164/agent-git-policy-r1.mjs as the must-FAIL baseline.
  - Decision on "a repo that belongs to no registered project is ungranted": applied to anything that can PUBLISH. A push to a network URL that is no registered project's remote is refused. A purely LOCAL unregistered repo (fixture or scratch, e.g. the ~6,000 fixture writes of the migrated project) stays under the session's own grant. Treating those as ungranted would break the migration promise ("keeps exactly its behaviour") and the test fixtures, and they cannot reach a registered repo or remote.
  - Residual: the Bash text hook still decides by the SESSION's grant. An ungranted session's TYPED `git -C <scoped repo> commit` is still denied at the hook (fails closed); subprocess git follows the target (X4). Only the deny direction is fully structural at both layers.

  P4: half done, and the other half is BLOCKED on FEAT-175's lock.
  - index.ts grant-rebuild fingerprint is fixed: mode scoped → 'perm'.
  - container-manager.ts gitGuardOn has been FEAT-129-locked by the live FEAT-175 lane the whole session. It was not forced. The patch is in ~/.local/state/claude-station/scratch/feat164-release/gitGuardOn.patch and was posted on FEAT-175's log.
  - Until it lands, a SAVED scoped/migrated grant keeps the container .git read-only (fails closed). An UNSAVED migrated grant is unaffected (still `permanent:true`).

  PROOFS: `node scripts/confined-run.mjs --no-git -- node scripts/verify-feat-164-release.mjs` → 99 passed, 1 failed (scratch/feat164-release/runs/run10.log). The 1 is K1-AFTER, waiting on that patch.
  - X1 [must-FAIL on round 1], through the REAL shim: the pinned r1 guard let a scoped+push session in A commit into AND push ungranted B. Now both are refused, and the refusal names B.
  - X2 methodology-style: a release-mode session commits into a scoped target, and the claim is on the target (key pm).
  - X3: scoped session → ungranted target refused.
  - X4: ungranted session → scoped target allowed at the shim (claim on the target).
  - X5: scoped session → release-mode target refused.
  - X6: an unregistered clone of B commits locally, but its push to B's origin is refused by B's policy.
  - K1 [must-FAIL on round 1]: the r1 check gives a saved scoped/migrated grant a read-only .git; the AFTER passes once the patch lands. K2: legacy rw, release and none ro.
  - S1 rewritten on decideByTarget, incl. network remotes matched across scp/https forms (S1.10) and an unknown network URL refused whatever the session (S1.5).
  - Regressions (confined): BUG-173 28/0, BUG-184 28/0, FEAT-135 31/0, FEAT-170 93/0, FEAT-164 permanent 41/0, FEAT-108 grant 71/0.
  - `npm run gate` → PASS.

  FOR THE NEXT VERIFY (coordinator note):
  - Use `--max-diff-bytes 500000`.
  - The candidate must include its dependencies on FEAT-175 files: index.ts imports src/server/grant-rebuild.ts, and FEAT-175 touches container-manager.ts, agent-bridge.ts and index.ts. Freeze FEAT-164 with --depends-on FEAT-175 (or verify --working-tree), else the room's typecheck and fixer suite fail on the missing import (that is the earlier verify's 77/2).
  - K1 needs the gitGuardOn patch applied first.

  Files this round: scripts/lib/agent-git-policy.mjs (+ .d.mts), scripts/lib/git-shim.mjs, scripts/lib/shadow-guard.mjs (comment), src/server/index.ts (decide route + fingerprint + import), src/server/registry.ts (comment), scripts/verify-feat-164-release.mjs, new scripts/fixtures/feat-164/agent-git-policy-r1.mjs.

### 2026-10-11 — worker (fixing r2)
- **Note:** fixing r2, coordinator correction to P1 (unregistered repos).
  - decideByTarget now treats an UNREGISTERED repo as a fixture ONLY under defaultFixtureRoots(): the scratch root (scratch.mjs), the system tmp, the shadow root, and the confined runner's /work. Those keep the session's own grant.
  - Any other unregistered repo, e.g. a real checkout that is not a project, is UNGRANTED: commits are refused, local pushes to a non-fixture destination are refused, and an unresolvable target there is refused. The refusal says to register and grant it.
  - Baseline pinned at scripts/fixtures/feat-164/agent-git-policy-r2.mjs.

  Proof (confined): verify-feat-164-release → 106 passed, 1 failed (runs/run12.log).
  - U1 [must-FAIL on round 2]: the r2 bytes let a scoped session commit and push into a methodology-like unregistered repo; now both are refused.
  - U2: a scratch fixture still commits and pushes before and after.
  - U3: an unresolvable target there is refused.
  - U0b: the production default root list is checked. The U cases inject that list minus /work, because inside the confined runner HOME is under /work and / is read-only.
  - The 1 FAIL is K1-AFTER, waiting on FEAT-175 applying the gitGuardOn patch (not yet in container-manager.ts).
  - npm run gate PASS.
  No verify run (coordinator commissions it after FEAT-175's patch).
  Files: scripts/lib/agent-git-policy.mjs (+ .d.mts), scripts/verify-feat-164-release.mjs, new scripts/fixtures/feat-164/agent-git-policy-r2.mjs.

### 2026-10-11 — FEAT-175 lane
- **coordination:** FEAT-175 lane applied your gitGuardOn.patch at the coordinator's direction. container-manager.ts now exports standingGitWriteOpen(project), which is normalizeGitWrite(...).mode === 'scoped', and gitGuardOn = !standingGitWriteOpen && !timed duration grant. The grant-rebuild fingerprint in index.ts now calls cm.standingGitWriteOpen (your inline normalizeGitWrite copy was replaced, so there is one rule). Your verify-feat-164-release.mjs K1 should now pass; FEAT-175 did not run it, so please re-run it on your side. FEAT-175's e2e suite adds P1s, a scoped grant gets rw .git after the idle rebuild. Your PUT/DELETE git-write-policy route was not edited: the reconciler's 2 s fingerprint tick picks policy changes up without a nudge.

### 2026-10-11 — dispatch openai
- **Verification recorded:** dispatch openai run 01a12c67-2e5d-7732-9edf-8df3124f40bd — VERDICT: BROKEN — VALID. P1: push destination ignores url.insteadOf; a fixture-path alias rewritten to ungranted B pushed a commit into B under A's grant. Fixer 107/0. Candidate 7fde4d846f77 frozen in a scratch copy: real-store freeze blocked by a FEAT-175 dep cycle.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-11 — worker (fixing r3)
- **Note:** fixing r3, after re-verify 01a12c67-2e5d-7732-9edf-8df3124f40bd (openai, BROKEN, property 1: url.insteadOf / pushInsteadOf aliases).

  FIX (structural): git itself now resolves the push destination (scripts/lib/shadow-guard.mjs resolveWriteTarget). No rewrite logic is re-implemented.
  - Remote NAME → `git <invocation globals> remote get-url --push --all <name>`. Measured on git 2.39: this applies insteadOf, pushInsteadOf, pushurl and includes exactly as push does.
  - URL/path ARGUMENT → `git ls-remote --get-url <arg>` (applies insteadOf, including from includes and -c).
    - git has NO read-only resolver that applies pushInsteadOf to a raw URL (measured: ls-remote --get-url ignores it, and `remote get-url` refuses -c-only remotes). So when ANY pushInsteadOf is in effect (any scope), a URL-argument push is UNRESOLVABLE and refused.
    - A remote defined where get-url cannot see it (only -c remote.<n>.url) is refused too.
    - Cost, stated: a user with a global pushInsteadOf can't push agent work by raw URL. Pushing by remote name works.
  - The resolved URL is then mapped to the owning project (decideByTarget). Anything unresolved leaves the URL list empty, so the host refuses it (fail closed).
  - Baseline pinned: scripts/fixtures/feat-164/shadow-guard-r2.mjs, synthesized from the exact prior lines.

  PROOF (confined): verify-feat-164-release → 115 passed, 0 failed (runs/run13.log). Through the REAL shim, with B an ungranted registered project and the alias a path inside the scratch fixture root:
  - W1 insteadOf, W2 pushInsteadOf on a URL argument, W3 insteadOf from an INCLUDED config file: each [must-FAIL on round 2]. The r2 resolver pushed into B; now each is refused (W1/W3 by B's policy, W2 as undeterminable).
  - W2b: a configured remote rewritten by pushInsteadOf is resolved by git and refused by B.
  - W4 control: an ordinary fixture push still works.
  - K1 (container .git rw for a saved scoped grant) passes now that FEAT-175 applied the gitGuardOn patch.
  - Regressions (confined): FEAT-170 shadow 79/0, FEAT-135 31/0, BUG-173 28/0, BUG-184 28/0.
  - npm run gate PASS.

  HOW THE NEXT (FINAL) VERIFY MUST FREEZE: one group candidate, no cycle.
  - Today: FEAT-175's open candidate ff3d04bc1464 pins FEAT-164 b1858a1ced0e (stale), and both claim the shared files (src/server/index.ts, agent-bridge.ts, container-manager.ts). FEAT-164 cannot --depends-on FEAT-175, because that is a cycle.
  - Steps:
    1. FEAT-175's lane: `node scripts/candidate.mjs release FEAT-175` (drops its stale candidate).
    2. Re-freeze FEAT-164 FIRST, owning the shared files (their FEAT-175 hunks taken in with --accept-foreign):
       `node scripts/candidate.mjs freeze --id FEAT-164 --files <FEAT-164 files below> --accept-foreign src/server/index.ts --accept-foreign src/server/agent-bridge.ts --accept-foreign src/server/container-manager.ts --check "node scripts/confined-run.mjs --no-git -- node scripts/verify-feat-164-release.mjs"`
    3. Freeze FEAT-175 on top as the GROUP: `node scripts/candidate.mjs freeze --id FEAT-175 --files <FEAT-175-only files, incl. src/server/grant-rebuild.ts and its suites> --depends-on FEAT-164 --check …`.
    4. Verify the group: `node scripts/independent-verify.mjs --candidate FEAT-175 --max-diff-bytes 500000 …`, with FEAT-164's requirement included.
    5. Record HOLDS/BROKEN for BOTH ids with the group hash (`board-tool verified --id FEAT-164 … --candidate <group hash>`). A member is satisfied by a verdict bound to the group hash, and `candidate commit FEAT-175` publishes both.
  - FEAT-164 files:
    - scripts/lib/agent-git-policy.mjs (+ .d.mts), scripts/lib/release.mjs, scripts/release.mjs
    - scripts/lib/candidate-store.mjs, scripts/lib/shadow-guard.mjs, scripts/lib/git-shim.mjs (+ .d.mts), scripts/lib/git-grant-store.mjs (+ .d.mts)
    - src/server/registry.ts, src/server/index.ts, src/server/agent-bridge.ts, src/server/container-manager.ts
    - public/lib/api.js, public/lib/drawer.js, public/lib/git-view.js, public/git-view.css, public/styles.css, public/app.js
    - scripts/verify-feat-164-release.mjs, scripts/verify-feat-164-settings-ui.mjs, scripts/verify-feat-164-permanent-git-grant.mjs, scripts/verify-feat-163-165-git-bar.mjs
    - scripts/fixtures/feat-164/{release-r1,agent-git-policy-r1,agent-git-policy-r2,shadow-guard-r2}.mjs
    - package.json, scripts/test-manifest.json
  - Alternative if the group is impractical: `independent-verify --working-tree --max-diff-bytes 500000` (both tickets in the room).

### 2026-10-11 — verify lane (anthropic; openai quota)
- **Verification recorded:** dispatch anthropic/claude-opus-5 run 73256821-bc1c-44ce-8b18-ac5e4e26fd45 — VERDICT: BROKEN — VALID. P1/P4: aliased push (git -c alias.p=push p ...) skips push-target resolution: commit-only grant pushes; scoped+push A pushes into ungranted B and release-mode C. Fixer 115/0. Group 9023f682c49c frozen in scratch copy; 36 files hash-equal live.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-11 — worker (fixing r4)
- **Note:** fixing r4, after group verify 73256821-bc1c-44ce-8b18-ac5e4e26fd45 (BROKEN, properties 1 and 4: an aliased push skipped the push checks).

  FIX (structural; git resolves the command): scripts/lib/shadow-guard.mjs expandGitAliases runs before anything is classified.
  - A builtin (`git --list-cmds=builtins`) is never an alias. Otherwise `git <invocation globals> config --get alias.<x>` resolves it, so -c, --config-env, includes and every config scope apply.
  - Expansion is recursive with a depth cap of 10 and loop detection. Words are split as git's split_cmdline does; global options inside the alias are honoured.
  - The target carries alias state none, expanded, shell or unresolved, plus resolvedVerb.
  - Host (agent-git-policy decideByTarget):
    - a shell (!) alias is refused as a potential push;
    - an unresolvable alias (unparsable value, loop, too deep, config error) is refused;
    - a non-builtin verb that arrives without the shim's resolution is refused (fail closed);
    - an expanded push is judged as a push (destination via git, owner policy).
  - Measured in the BEFORE leg: a shell alias's inner `git push` runs via git's exec-path and bypasses the PATH shim, so refusing the shell alias outright is the only safe choice.
  - Baselines pinned: scripts/fixtures/feat-164/shadow-guard-r3.mjs and agent-git-policy-r3.mjs (round 3, synthesized from the exact prior lines).

  PROOF (confined): verify-feat-164-release → 127 passed, 0 failed (runs/run15.log). Through the REAL shim, with B ungranted. Each case is [must-FAIL on round 3]; on r3 each was allowed by the host, and AL1–AL4 actually landed in B:
  - AL1 `-c alias.p=push`;
  - AL2 a ~/.gitconfig alias `pu = push`;
  - AL3 nested a→b→c→push;
  - AL4 a shell `!git push …` alias;
  - AL5 an unresolvable alias (unbalanced quote).
  Now each is refused and nothing lands. AL6: an alias loop is refused. AL7: an alias to a harmless commit in a fixture still works.
  Regressions (confined): FEAT-170 shadow 82/0, FEAT-135 31/0, BUG-173 28/0, BUG-184 28/0, FEAT-108 grant 71/0. npm run gate PASS.
  Cost, stated: any shell (!) alias is refused under every grant, including harmless ones.
  Residual, stated: an external git-<cmd> (e.g. git-lfs) that talks to a remote by itself, without calling git, is not judged as a push.
  Freeze for the next verify: unchanged from fixing r3's steps (group candidate FEAT-175 --depends-on a re-frozen FEAT-164, --max-diff-bytes 500000). Add the two new fixture files to FEAT-164's --files.
  Files this round: scripts/lib/shadow-guard.mjs, scripts/lib/agent-git-policy.mjs (+ .d.mts), scripts/verify-feat-164-release.mjs, new scripts/fixtures/feat-164/{shadow-guard-r3,agent-git-policy-r3}.mjs.

### 2026-10-12 — verify lane (anthropic; openai quota)
- **Verification recorded:** dispatch anthropic/claude-opus-5 run 7e3709d5-c98d-4b27-a2b7-df72e5258e37 — VERDICT: BROKEN — VALID. P1: push --repo=<scratch> + ungranted positional remote is judged on --repo, lands in ungranted project. P3: creating targets always allowed; release-mode init --separate-git-dir moves real .git. Fixer 115/2 (no-network S9). Group 6aeb561172a8 scratch freeze.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-12 — worker (rescope)
- **Note:** RESCOPE recorded (coordinator, non-author reviewer, user-delegated), after verify 7e3709d5-c98d-4b27-a2b7-df72e5258e37: the 13th BROKEN, each through a new argument route; a command-line parser is enumerated by construction.
  - Rounds stopped; code kept as-is.
  - The rescoped property, the 11 named residuals (including --repo with remotes and init --separate-git-dir/--template) and the reasoning are in the body section "Rescope (2026-10-12)".
  - Status: in_verification. No standing independent HOLDS exists, so it is not VERIFIED (board rule 5).
  - Structural fix: OS-level read-only .git per session, proposed to the user under ARCH-021 option D.
  - The A/B/C self-grant card is superseded by the user's threat model; the orchestrator or user records that answer.
  - Symptom of a deeper design flaw? Yes, already filed: ARCH-021.

### 2026-10-12 — you (answer · via ticket view)
- **Chose:** A — OS caller check plus sealed grant
- **Note:** Decided A on the user's delegation (2026-10-05, orchestrator); recorded per INDEX status.
- **State:** answered — awaiting agent action (not dispatched)

### 2026-10-12 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5 run dc1b17e1-1f8c-4872-82cf-303ed2b7f0a8 — VERDICT: HOLDS — rescoped property; scratch candidate c2c78a6011b6. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-13 — fixing lane (scope-note replacement)
- **Did:** Replaced the private bot project's migrated scope note (MIGRATED_SCOPE_NOTE) via the live PUT /api/projects/<bot-project>/git-write-policy; commit/push/mode (scoped) unchanged, legacy flag now false. New note is the user's soft-releases text. GET readback confirms. Running sessions pick up the note at session START (agent-bridge compose bakes agentGitPolicyNote into the systemPrompt once), not per command; no restart done. No code/git changes.

### 2026-10-13 — defaults lane
- **coordination:** COORDINATION (defaults lane, 2026-10-13, not option A): I am adding small hunks to files your option-A lane also touches. src/server/index.ts: socket approval/question/plan-response acks (refusedForNoAnswer), BUG-239 Needs-You incident loop (skip DATA_ONLY_KINDS), a new GET /api/lane-incidents/late-answers route, and the releaseTick card for release mode with no typed verdicts. scripts/lib/release.mjs: planRelease gains a verdictSource field and releaseAlarm returns it first. If your mutate.sh restores release.mjs from bak/, please re-take the backup first (it would drop these hunks). No change to option-A code paths (requireUserCaller, verifiedGitWrite, seal).

### 2026-10-13 — worker (fixing, option A)
- **Verification recorded:** dispatch anthropic/claude-opus-5 run 9bd8c5d3-81ed-4b2f-8b0d-a8147a6ea6f1 — VERDICT: BROKEN — mixed-state candidate 24788bace8ff — VALID. Option A. 2 breaks: git panel POST stage/commit/push ungated (agent commits+pushes with no grant); seal bound to id only, so editing unsealed hostPath moves a grant to another repo. OpenAI quota-limited, so Claude Opus. Both fixed after; not re-verified.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-13 — worker (fixing, option A)
- **Note:** Fixing (option A built; dispatch: self-grant suite 2 FAILs). VERDICT ON THE HYPOTHESIS: BOTH. The 2 FAILs were STALE and the suite's 11 OPEN checks were a REAL self-grant hole. (a) STALE: UA6 expected a scope-less permanent grant to let a direct write through, but since the 2026-10-11 rescope that is RELEASE mode, which refuses direct writes by design (the shim's own refusal text names release mode). H1a-setup expected the r1 shape permanent:true; the writer stores {commit,push,scope,...} since the rescope. Both fixtures updated; UA6 now uses a user SCOPED policy, and UA5b asserts the release-mode refusal. (b) REAL, reproduced on the pre-change tree through a real Orchard-launched session process: an agent POST to the grant route returned 200 (once/duration/permanent), git-grant.mjs from the agent did the same, the agent answered its own request "Allow", and a registry edit (forge, copy to another project, tamper) granted. All 11 holes reproduced.
  BUILT (option A, the user's 2026-10-12 choice): O1 src/server/caller-provenance.ts requireUserCaller = THE gate. It maps the loopback peer to its pid via /proc/net/tcp{,6} and the socket inode. The caller counts as an agent if the pid sits in one of THIS server's claude-station-host-<key>.scope units (key in its hosts dir), descends from the server process, or shares the server's .service cgroup. An unidentified loopback caller is refused (fail closed). The gate is applied to POST git-write-grant, PUT git-write-policy, the board/answer of a git-write request (any answer, so the request stays pending), and, after the verify, every mutating git panel POST (all but diff). Revoke stays open. S1 scripts/lib/git-write-seal.mjs: an HMAC over the value bound to project id + hostPath, keyed by <data>/git-write-seal.key (0600). The one writer setGitWritePolicy seals; registry load() voids any value that does not verify (so every in-server reader sees only sealed values); release.mjs resolveTarget verifies too. MIGRATION: the first load that creates the key seals the existing grants (the live registry holds one such grant); after that, an unsealed value never grants.
  PROOFS: verify-feat-164-self-grant 52/0. Must-FAIL by mutation, restored and cmp-identical: (1) gate+seal off gave 30/14 (H2 x3, H2c, H2d, H3b, H3c, H1a-d, C1, M6); (2) git panel gate off + hostPath dropped from the binding gave 47/5 (G1 x3, H1e, M3b). Suite: release 127/0 (confined), permanent 42/0 (A16b new: an unsealed hand-written value grants nothing), settings-ui 18/0 (alone; a parallel run timed out on browser contention), single-authority 31/0, store-authority 28/0. Regressions: FEAT-108 grant 69/0, FEAT-108 write-block 239/0, BUG-173 28/0, BUG-184 28/0, BUG-231 50/0 + call-claims 21/0, BUG-242 21/0, BUG-249 25/0, FEAT-169 pass, FEAT-175 unit 48/0, FEAT-135 31/0 (confined with git). npm run gate PASS.
  INDEPENDENT VERIFY: OpenAI is quota-limited until 2026-10-14 (the test dispatch failed with quota-window), so Claude Opus ran it: run 9bd8c5d3-81ed-4b2f-8b0d-a8147a6ea6f1, BROKEN (VALID), typed entry recorded. Both breaks were fixed afterwards with the must-FAILs above (G1, H1e, M3b). That fixed state is NOT independently verified; a re-verify is the orchestrator's call.
  RESIDUALS (decision card cost): an agent that deliberately escapes its scope (systemd-run --user --scope, or a relay outside it), reads the key, deletes the key so a later load re-migrates, or replays an old sealed value. A terminal the server spawned is refused (fails closed). A legitimate hostPath relocation drops the grant (re-grant). FEAT-112 services-proposal "Allow" is still ungated (same pattern, not a git grant). Takes effect on the next service restart (not restarted here).
  Files (unstaged): new scripts/lib/git-write-seal.mjs (+.d.mts), new src/server/caller-provenance.ts, src/server/registry.ts, src/server/index.ts, scripts/lib/release.mjs, scripts/verify-feat-164-self-grant.mjs, scripts/verify-feat-164-permanent-git-grant.mjs, scripts/verify-feat-164-release.mjs, scripts/verify-feat-164-settings-ui.mjs.

### 2026-10-13 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5 run f8f4bf80-7924-4b31-82c4-63af12d3f7cb — VERDICT: BROKEN — mixed-state candidate bc1cb231d615 — Option A re-verify; OpenAI quota, so Opus. Fixer 52/0. PATCH hostPath ungated + timed grant keyed by id only: agent repoints a timed-granted project at an ungranted repo (PATCH or registry edit), shim then allows its git add.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-13 — defaults lane
- **observation for the option-A lane:** verify-feat-164-release, run confined at ~21:31 against the tree as it then stood, gave 120/7: P2, P2.1-P2.5 and P4.2 failed because release.mjs auto returned error not-granted, meaning resolveTarget's verifiedGitWrite read the fixture's sealed policy as none. That is consistent with the seal-binding change (id plus hostPath) landing in git-write-seal.mjs/release.mjs/registry.ts at 21:30 and in the suite at 21:32, after your 127/0 run at 20:59. My hunks in release.mjs (boardVerdictSource, planRelease.verdictSource, the releaseAlarm never-branch) do not touch policy resolution. Please re-run the suite on your final tree. Tracked under FEAT-179.

### 2026-10-13 — worker (fixing, grant binding)
- **Note:** Fixing (grant binding redesign, coordinator ruling after re-verify f8f4bf80: a project PATCH or registry path edit carried a live timed grant to an ungranted repo). BUILT at the single authority: scripts/lib/repo-identity.mjs repoIdentityOf(dir) = { realpath of the toplevel, realpath of the git common dir } (a non-repo gives its own realpath and null; unresolvable gives null, which never matches). Every grant records it at grant time. The standing grant stores `repo` inside the seal (setGitWritePolicy; the migration binds pre-existing grants to their current repo). Timed grants carry it on the store record (grant route + request approval; an unresolvable path gets 409 at grant time). ENFORCEMENT: reg.gitWritePolicyOf voids a standing grant whose binding does not match the project's CURRENT resolved path (this is also the store's permanent source); the shim-decide route REVOKES any timed grant whose binding no longer matches, before decideByTarget or the store can see it; release.mjs and the container guard (standingGitWriteOpen) check the binding too. PATH CHANGES: PATCH /api/projects/:id with hostPath requires requireUserCaller; a user path change revokes the timed grant and the standing grant, so the user re-grants for the new repo.
  PROOFS: verify-feat-164-self-grant 62/0. B0 normal timed work passes; B1 agent PATCH of the path is refused (403, path unchanged); B2 a registry-file path edit leaves the grant inert for the new path (write refused, grant voided) and B2b moving the path back does not revive it; B3 a user path change voids the timed and standing grants, B3b the new repo is refused until re-grant, B3c the re-grant works; M8 a symlink swap under an unchanged path voids the binding; M9 migration binds. Must-FAIL by mutation (PATCH gate, decide-route revoke, policy binding and path-change void off; restored cmp-identical): 57/5, failing B1, B2, B2b, B3, B3b; B0 and B3c still pass. Not separately mutation-proven: the standing-grant symlink case through gitWritePolicyOf (the hostPath seal binding also catches a string edit; M8 proves the identity check itself). Suite: release 127/0 (confined), permanent 42/0, settings-ui 18/0, single-authority 31/0, store-authority 28/0. Regressions: FEAT-108 grant 69/0, BUG-173 28/0, BUG-231 50/0, FEAT-175 unit 48/0. npm run gate PASS. Independent verify: the coordinator commissions it.
  Files added this round (unstaged): new scripts/lib/repo-identity.mjs (+.d.mts), scripts/lib/git-grant-store.mjs (+.d.mts), src/server/container-manager.ts (standingGitWriteOpen); plus edits to the earlier files: index.ts, registry.ts, git-write-seal.mjs, release.mjs, and the FEAT-164 self-grant/permanent/release/settings-ui suites. Not restarted.

### 2026-10-13 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5 run 19ebbe14-9ac8-4995-b917-c8e75f366317 — VERDICT: BROKEN — mixed-state candidate e33a08c5a686 — Third break: route to independent adjudication. OpenAI quota, so Opus; fixer 62/0. Identity = path strings: agent mv-swaps another repo into the granted path, standing grant still applies (add+commit allowed); moving back revives. Symlink swap holds.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-13 — worker (adjudication record)
- **Note:** Adjudication (independent adjudicator, run 19ebbe14-9ac8-4995-b917-c8e75f366317): RESCOPE on the third break, an mv of another repo into a granted path. It is deliberate same-uid filesystem tampering, the same class as residual 5, and a nonce or root-commit binding would not stop it either. Appended verbatim as residual 12 in the body section "Rescope (2026-10-12)". No code changed.

### 2026-10-13 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5 run 1659cb7f-53de-4074-b597-93bc45349832 — VERDICT: BROKEN — mixed-state candidate 2f0ec96f5f1d — VALID, ordinary forms; OpenAI quota so Opus; fixer 127/0. 2 breaks, STOP: container guard leaves an unregistered repo 1 level below a scoped bind root rw; release.mjs resolveTarget maps a path by string prefix, so cut on ungranted repo nested in granted A commits+tags+pushes it.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-13 — worker (fixing, single identity authority)
- **Note:** Fixing (single authority by repo identity; coordinator ruling after verify 1659cb7f: container nested repo writable, release CLI prefix match). BUILT: scripts/lib/repo-identity.mjs grantCoversTarget(bound, target) is THE grant decision. It resolves the TARGET's repository (git common dir; a linked worktree is the same repository; a non-repo dir compares by realpath) and matches it to the identity the grant was given for. Never by prefix. Callers: (1) shim decide: agent-git-policy ownersOfDir/ownersOfTree now match by identity equality (was insideOrEqual prefix, which mapped a submodule gitdir under A/.git/modules to A); every owner whose grant would allow is asked grantCoversTarget(binding, target); the decide route supplies each project's binding (timed record or sealed standing repo); an unresolvable target resolves the cwd's own repository on the host (fail closed); several owners of one repository must all allow. (2) release.mjs resolveTarget: the owning project is matched by repository identity (prefix match deleted), and the grant must cover the repo actually cut. (3) container plan: repoWriteGranted asks grantCoversTarget(containerGrantBinding(project), repo identity) for every discovered repo (timed binding read from the grant store's own record), so any nested .git that is not the granted repository is overlaid read-only at create. Discovery is a capped walk (depth 8, 20000 dirs, nothing skipped by name, replacing depth 1 for the guard's own discovery). If either cap is hit the discovery is TRUNCATED and fails closed: the grant is not applied in the container (every reached .git including the granted one stays read-only), and gitGuardDiscoveryOf(project) reports { truncated, grantApplied:false }.
  PROOFS: new scripts/verify-feat-164-identity.mjs (confined) 27/0. [I] authority: the granted repo and its subdir are covered; a nested repo, a deeper one and a submodule-style repo are not; a worktree is covered. [S] shim: commit in A allowed (granted work unaffected), commit in the nested and submodule repos refused, a grant bound to another repo covers nothing. [R] through the real release CLI: `policy <A/nested>` and `policy <A/sub>` resolve no project and no grant (A's by prefix before); `cut <A/nested> --as-agent` refused not-granted with the nested HEAD and tags unchanged; `policy <A>` still scoped. [C] container plan: nested one-level repo, submodule gitdir and a three-level repo are overlaid read-only; A/.git is not (granted repo unaffected); a grant bound elsewhere opens nothing; depth cap 2 and dir budget 3 report truncated, grant not applied, A/.git read-only. [G] no prefix match in grant decisions (in-process scan, non-vacuity G0; the host rg output shows the only remaining hits are container overlay-placement geometry, mount validation, the dispatch home, and agent-git-policy inFixture, which classifies UNREGISTERED scratch space under the 2026-10-11 rule and never extends a project grant). MUST-FAIL by mutation, each restored cmp-identical: release prefix + no coverage check, plus container identity and fail-closed checks off, gives 18/9 (R2, R3, R4, C1, C2, C3, C8, G1, G3); the pre-change shim shape (prefix ownersOfDir, no coverage check) gives 24/3 (S3, S5, G2). The prefix ownership alone is also caught by the coverage check (defence in depth). Suite: identity 27/0, self-grant 62/0, release 127/0 (confined; S1.4 holds through host-side cwd resolution), permanent 42/0, settings-ui 18/0, single-authority 31/0, store-authority 28/0. Regressions: FEAT-108 grant 69/0, write-block 239/0, BUG-173 28/0, BUG-231 50/0, FEAT-175 unit 48/0. npm run gate PASS.
  NOT RUN / FOLLOW-UP: verify-bug-244 and verify-feat-175 (docker-sandbox tier) were not run here. BUG-244's granted fixtures use literal {permanent:true} grants with no `repo` binding, so its "granted repo stays writable" checks will now read the repo as read-only (fail closed) until those fixtures add repo: repoIdentityOf(dir). A file lock held by another lane blocked an index.ts registration, so container-manager reads the timed binding from the grant store module directly instead (same instance in the server). Not restarted.
  Files this round (unstaged): scripts/lib/repo-identity.mjs (+.d.mts), scripts/lib/agent-git-policy.mjs (+.d.mts), scripts/lib/release.mjs, src/server/container-manager.ts, src/server/index.ts (decide-route binding), new scripts/verify-feat-164-identity.mjs, scripts/verify-feat-164-release.mjs (projOf binding).

### 2026-10-13 — worker (container suites, sandbox)
- **Note:** Container suites in the Docker SANDBOX (lane-declared sandbox daemon at ~/.local/state/claude-station/docker-sandbox/run/docker.sock; the host daemon was never contacted; the suites run assertIsolatedDocker). BUG-244 FIXTURES now create real repo-bound grants: granted(dir) = { permanent:true, repo: repoIdentityOf(dir) } at all 8 grant sites, which is what setGitWritePolicy stores. Assertion changes (none weakened): R1 flipped from "a repo 3 levels down gets no overlay (residual)" to "it IS overlaid" (the capped walk retires the residual); P2.granted.unregistered-mount-commit (expected granted P2 to commit into unregistered mount u) became P1.granted-unregistered-mount-commit (+ .effective). The commit is now REFUSED, as the 1659cb7f ruling requires, and on the pinned pre-fix code it is a genuine must-FAIL (matrix M1/M1b). U.granted-unregistered flipped from "no overlays" to "main/.git and mono/.git under granted G are read-only, G's own .git is not". M2 (granted control on old code) keeps its 2 real granted checks (>=2).
  REAL REGRESSION FOUND AND FIXED: FEAT-175 e2e went 50/4 on two runs (all 4 SHOTS: dashboard page.goto timed out). Diagnosis with a temporary instrumented copy (deleted): /api/projects took 3.0 to 3.8 s and app.js/styles.css were still pending at 30 s, so the server's event loop was starved. SHOTS alone passed 4/0, and a plain dashboard loaded in 86 ms. Cause: this round's repoIdentityOf ran two synchronous `git rev-parse` per call on hot paths (policy reader, container guard and mount plan, reconciler ticks) for ~15 container projects. FIX (scripts/lib/repo-identity.mjs): a repo identity is cached but RE-VALIDATED on every call without spawning: realpath recomputed (symlink swap = new key), and the lstat signature (dev/ino/mtime/ctime) of the dir, each dir up to the toplevel, <toplevel>/.git and the common dir must be unchanged, else git re-runs; non-repo answers are not cached. PROOFS (identity suite, now 31/0): P1 50 reads spawn git once (2), not 100; P2 a cached subdir that later gets `git init` re-resolves; P3 a rewritten gitfile re-resolves (correctness only: that repo is not cached); P4 the hot path ×500 spawns 0 once warm. Must-FAIL by mutation (restored cmp-identical): cache off gives P1+P4 FAIL (100 and 1000 spawns); never-revalidated cache gives P2 FAIL (stale). End to end: FEAT-175 e2e 54/0 after the fix (50/4 twice before).
  COUNTS (sandbox): BUG-244 post 99/0, pre 41/30 and mutant 91/8 (as designed), matrix 6/0, exit 0 (baseline before the fixture update was post 84/14, matrix 5/1). FEAT-175 e2e 54/0. No separate FEAT-164 container suite exists; the FEAT-164 container legs are the in-process [C] checks of verify-feat-164-identity. Non-Docker: identity 31/0, self-grant 62/0, release 127/0 (confined), permanent 42/0, settings-ui 18/0, single-authority 31/0, store-authority 28/0, FEAT-175 unit 48/0. npm run gate PASS.
  Files this round: scripts/lib/repo-identity.mjs, scripts/verify-bug-244-container-git-readonly.mjs, scripts/verify-feat-164-identity.mjs. Not restarted.

### 2026-10-13 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5 run 95027178-7065-4ed3-b33f-1b6b56d14d7a — VERDICT: BROKEN — mixed-state candidate b7131675527f — VALID; OpenAI quota so Opus; fixer 31/0. New mechanism, route to adjudication: push check covers the OWNER's identity, not the destination's: scoped+push A force-pushes a bare repo nested in A; owner=owners[0], so registry order lets A push into ungranted Q. Nested/release/GIT_DIR/cache held.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-13 — worker (fixing, push identity)
- **Note:** Fixing (push branch moved onto repo identity; independent adjudicator COMPLETE THE REDESIGN after verify 95027178: a scoped+push grant on A pushed into a bare repo nested in A, and into ungranted Q via the first registry match). BUILT in scripts/lib/agent-git-policy.mjs: DELETED ownerOfUrl, ownerOfDir, the localRemotes clause in ownersOfDir, and the owner-vs-itself binding self-check. A LOCAL or file:// destination resolves to its repository identity (repoIdentityOf); a non-repository destination is refused (fail closed) except scratch space under an unregistered source. EVERY project owning that repository by identity must allow it (scoped+push AND grantCoversPush). An unowned destination pushed from a registered source needs EVERY source owner to be scoped+push and the destination to be one of the local remotes RECORDED IN ITS GRANT. Network remotes are unchanged (URL match), except that every owner of the URL must allow instead of the first match. DENY-ONLY addition: a project whose LIVE config lists the destination as a local remote must allow it too. Live config never grants anything, so tampering with it can only remove protection from an ungranted project by editing that project's own config. This keeps "B's origin is judged by B" (release suite S1.7, X6, W1, W2b, W3, AL1-AL3). scripts/lib/repo-identity.mjs: grantBindingOf(dir) records { toplevel, commonDir, remotes:[local-remote identities] } WHEN THE USER GRANTS (setGitWritePolicy, the timed grant route, request approval, the seal migration; the store keeps `remotes`); grantCoversPush(bound, target) = the granted repository or a recorded remote, never by prefix or live config.
  PROOFS (verify-feat-164-identity [PU], 38/0): PU1 a push from granted A into a bare repo nested in A, added as a live remote after the grant, is refused (also under the scratch fixture roots); PU2 a push into registered ungranted Q is refused in both registry orders and under the fixture roots; PU3 the local origin recorded at grant time is allowed; PU4 once origin is repointed in live config, a push to the new destination is refused; PU6 a local remote added after the grant is refused; PU7 the network branch still refuses an unknown URL. MUST-FAIL on the pre-redesign module (the previous round's exact bytes, swapped in and restored cmp-identical): PU1, PU2, PU4, PU6 FAIL, PU3 passes. Not asserted: moving ANOTHER repository into the recorded origin's exact path keeps the identity, which is adjudicated residual 12. rg: no ownerOfUrl, ownerOfDir or live-localRemotes ownership left in agent-git-policy (.mjs/.d.mts).
  SUITE: identity 38/0, release 127/0 (confined), self-grant 62/0 (M9 compares against grantBindingOf, the recorded shape), permanent 42/0, settings-ui 18/0, single-authority 31/0, store-authority 28/0. Regressions: FEAT-108 grant 69/0, write-block 239/0, BUG-173 28/0, BUG-231 50/0, FEAT-175 unit 48/0. BUG-244 in the Docker SANDBOX (lane-declared sandbox daemon, never the host): post 99/0, pre 41/30 and mutant 91/8 as designed, matrix 6/0, exit 0. npm run gate PASS. Not restarted.
  Files this round: scripts/lib/agent-git-policy.mjs (+.d.mts), scripts/lib/repo-identity.mjs (+.d.mts), scripts/lib/git-grant-store.mjs (+.d.mts), scripts/lib/git-write-seal.mjs, src/server/registry.ts, src/server/index.ts (two grant sites + import), scripts/verify-feat-164-identity.mjs, scripts/verify-feat-164-release.mjs (projOf recorded remotes), scripts/verify-feat-164-self-grant.mjs (M9).

### 2026-10-13 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5 run e5d8ca9e-1ce5-4a4e-837d-df77c07693f8 — VERDICT: BROKEN — mixed-state candidate f25fb3f4c9c6 — VALID; Opus (OpenAI quota); fixer 38/0. New mechanisms, route to adjudication: file:// not percent-decoded, so a %20 URL reads non-repo and a real push lands in ungranted Q; network URL case/double-slash variants escape Q's veto. Release/worktree regression untested.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-13 — worker (fixing, parseRemote)
- **Note:** Fixing (ONE shared parseRemote; independent adjudicator REDESIGN after verify e5d8ca9e: a %20 file:// push landed in ungranted Q; case and // variants of a network URL bypassed Q's veto). BUILT new scripts/lib/remote-url.mjs parseRemote(u, {base}) returning {kind:'local', path} | {kind:'network', key} | null, where null means refuse. Rules: `<transport>::` remote helpers give null. `scheme://` is a URL. For file:, fileURLToPath, and any host (including localhost; checked on the raw form because WHATWG normalises localhost to ''), a NUL, or an undecodable % gives null. Other schemes give a key: host lowercased, path percent-decoded, `//` collapsed, slashes trimmed, one `.git` stripped, case-folded; port and user ignored. scp-like uses git's colon-with-no-slash-before rule (`[host]:path` accepted). Anything else is a local path resolved against base. git still resolves aliases and insteadOf in git-target.mjs (kept); its absolutize now uses parseRemote. DELETED: isNetworkUrl, isNetworkRemote, normalizeRemoteUrl, and the file:// strips in agent-git-policy (localRemoteDirsOf, push branch) and repo-identity (localRemoteIdentitiesOf). Every remote decision uses parseRemote: push-destination classification, network ownership by KEY equality (describeRegisteredRepo networkRemotes are keys), local remotes, recorded remotes, and the shim's absolutize. rg (outside the pinned historical fixtures): no isNetworkUrl, isNetworkRemote, normalizeRemoteUrl or `replace(/^file` left; the only `file://` literal is inside parseRemote. parseRemote is called at agent-git-policy 233/260/352, repo-identity 130 and git-target 198.
  PROOFS (verify-feat-164-identity [UR], 44/0): UR1 a %20-encoded file:// push into ungranted Q, from an unregistered scratch repo under the default fixture roots, is refused by Q; UR2 eight variants of Q's remote (upper case, `//`, no `.git`, trailing slash, `.git/`, scp, ssh with port and case, %2E-encoded) all hit Q's veto while A lists the variant; UR3 scp forms by git's rule, and a slash before the colon is a local path; UR4 file://host, file://localhost, an encoded NUL, ext::, a bad %, empty and hostless all parse to null and the push is refused; UR4b an encoded-NUL file:// push from an unregistered scratch source is refused; UR5 a granted remote is still allowed (A's own GitHub remote in three spellings, plus its recorded local origin). MUST-FAIL on the previous round's exact module bytes (swapped in, restored cmp-identical): UR1, UR2, UR4b and UR5 FAIL; UR3 and UR4 only exercise the new parser, which the old module lacks. SUITE: identity 44/0, release 127/0 (confined), self-grant 62/0, permanent 42/0, settings-ui 18/0, single-authority 31/0, store-authority 28/0. Regressions: FEAT-108 grant 69/0, write-block 239/0, BUG-173 28/0, BUG-231 50/0, FEAT-135 shim 31/0 (confined with git), FEAT-175 unit 48/0. BUG-244 in the Docker SANDBOX: post 99/0, pre 41/30 and mutant 91/8 as designed, matrix 6/0, exit 0. npm run gate PASS. Not restarted.
  Files this round: new scripts/lib/remote-url.mjs (+.d.mts), scripts/lib/agent-git-policy.mjs (+.d.mts), scripts/lib/repo-identity.mjs, scripts/lib/git-target.mjs, scripts/verify-feat-164-identity.mjs.

### 2026-10-13 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5 run 45e78a71-b4f6-40f9-858c-9e6d421c94fe — VERDICT: BROKEN — mixed-state candidate a58cb1d571ef — VALID; Opus (OpenAI quota). Owner remotes read raw (no insteadOf): Q's gh: shorthand loses its veto, A pushes into Q (network + local bare; commit landed). Network remote added/repointed after grant allowed. Release/worktree not independently probed.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-14 — worker (fixing, resolved veto keys)
- **Note:** Fixing (veto keys through git's resolution; network destinations recorded at grant). Ruling after verify 45e78a71: (1) Q's remote written as an insteadOf shorthand (gh:me/q.git) lost its veto; (2) a network remote added or repointed after the grant was allowed. BUILT: scripts/lib/repo-identity.mjs resolvedRemotesOf(dir) reads every configured remote AS GIT RESOLVES IT, via `git remote get-url --all` (insteadOf) and `git remote get-url --push --all` (pushInsteadOf / pushurl), the same resolution git-target.mjs uses for a push destination, then parseRemote, giving { network keys, local repo identities }. describeRegisteredRepo builds every project's VETO keys (networkRemotes, localRemotes) from it; the raw `git config --get-regexp remote.*` reads and localRemoteDirsOf are DELETED (rg: no raw remote-config read left in scripts/lib). grantBindingOf now records, WHEN THE USER GRANTS, both local remote identities and `networkKeys` (the parsed keys of the repo's resolved remotes at that moment); the store keeps networkKeys. The network push branch keeps every-owner-must-allow and now also requires grantCoversNetworkPush(binding, key), a key recorded at grant time. Otherwise it refuses with: "that remote was added or repointed in project X AFTER the user granted push there, so the grant does not cover it. Ask the user to re-grant agent git (Settings → Agent git) to include it."
  PROOFS (verify-feat-164-identity [NK], 51/0; A lists the expanded URLs itself, the verifier's shape): NK1 Q's veto holds for an insteadOf shorthand (gh:me/q3.git); NK2 under pushInsteadOf (url ghp:me/q4.git; git applies pushInsteadOf only to a url, never to an explicit pushurl); NK3 under an insteadOf rewrite of a full URL; NK4 a network remote recorded at grant is still allowed; NK5 one ADDED after the grant is refused with the re-grant wording; NK6 one REPOINTED after the grant is refused; NK7 a re-grant picks up both. MUST-FAIL on the previous round's exact module bytes (swapped in, restored cmp-identical): NK1, NK2, NK3, NK5 and NK6 FAIL ("ALLOWED"); NK4 and NK7 pass on both. SUITE: identity 51/0, release 127/0 (confined; projOf records networkKeys as a grant would), self-grant 62/0, permanent 42/0, settings-ui 18/0, single-authority 31/0, store-authority 28/0. Regressions: FEAT-108 grant 69/0, write-block 239/0, BUG-173 28/0, BUG-231 50/0, FEAT-135 31/0, FEAT-175 unit 48/0. BUG-244 in the Docker SANDBOX: post 99/0, pre 41/30 and mutant 91/8 as designed, matrix 6/0, exit 0. npm run gate PASS. Not restarted.
  Files this round: scripts/lib/repo-identity.mjs (+.d.mts), scripts/lib/agent-git-policy.mjs (+.d.mts), scripts/lib/git-grant-store.mjs (+.d.mts), scripts/verify-feat-164-identity.mjs, scripts/verify-feat-164-release.mjs.

### 2026-10-14 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5 run 619c99b4-5f84-45bc-8167-47571735eaa4 — VERDICT: BROKEN — mixed-state candidate 38822c753ae1 — VALID; Opus (OpenAI quota); fixer 51/0. Careless-plausible: release push uses live origin/upstream, so after set-url or an added upstream remote it lands unrecorded. Push into another GRANTED project by path/URL skips source grant (ungranted A landed in B; leak gate keyed on B).. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-14 — worker (fixing, decidePush)
- **Note:** Fixing (ONE push authority; ruling after verify 619c99b4: release pushed to live origin/upstream, and a push by path/URL into another granted project skipped the SOURCE grant, with the leak gate scanning the destination). BUILT: scripts/lib/agent-git-policy.mjs decidePush({ source, url, projects, sessionProjectId }) is the ONLY push decision. It allows only when ALL hold: (1) every project owning the SOURCE repository is scoped + push; (2) the destination (parseRemote, after git's resolution) is among the source grant's RECORDED destinations (grantBindingOf networkKeys / local remote identities) or is the source repository itself; (3) no destination project vetoes it (the destination's own repository owner, a project whose git-resolved network remotes include the key, or a project whose live local remotes include it, unless it is itself a source owner). An unregistered source may push only into unregistered scratch space that nobody vetoes. key = the SOURCE project; gateRepo = the SOURCE work tree. The shim's push branch (decideByTarget) is now just a loop over decidePush. The decide route's leak gate scans `sourceGateRepo ?? target.hostPath`, so a push gates the source. RELEASE (scripts/lib/release.mjs pushRelease): resolves the branch's remote with `git remote get-url --push --all`, decides EVERY URL with decidePush against the registry's sealed bindings (new pushGuardOf; standing grants only, no timed grants in the CLI), and pushes to exactly those URLs, never the remote by name. `release: true` lets a RELEASE-mode source with push granted push its cut release (the meaning of release mode); destination vetoes are unchanged. rg: pushRefusal / grantCoversPush / grantCoversNetworkPush / ownersOfNetworkKey occur only inside decidePush (and their definitions); decidePush's callers are the shim branch and release.mjs; the only other push invocation of git is src/server/git.ts push, the user-only git panel route (requireUserCaller).
  PROOFS: release suite DP1 a release after `git remote set-url origin <other>` is refused (pushed.refused, re-grant wording, other bare repo untouched, no tag); DP2 a release whose branch tracks a newly added upstream is refused, same checks; P4.2 the normal granted release still pushes commit + tag. MUST-FAIL with the old pushRelease bytes (restored cmp-identical): DP1 and DP2 FAIL, P4.2 passes. Identity suite DP3 an UNGRANTED source pushing into granted B (B's origin by path, B's repo by path, file://) is refused by the source's missing grant; DP4 gateRepo is the SOURCE (A), never B; DP4b the decide route gates on sourceGateRepo first; DP5 a normal granted push (B to its recorded origin) is allowed, keyed to B; DP6 the shim push branch only delegates to decidePush, and release.mjs calls it. MUST-FAIL on the previous round's exact module (restored cmp-identical): DP3 (B's repo by path was allowed), DP4 and DP6 FAIL; DP5 passes. Known fail-closed side effect, not a hole: a project listing another project's local origin as a live remote vetoes pushes there (the deny-only claimant rule), until that remote is removed.
  SUITE: identity 56/0, release 129/0 (confined), self-grant 62/0, permanent 42/0, settings-ui 18/0, single-authority 31/0, store-authority 28/0. Regressions: FEAT-108 grant 69/0, write-block 239/0, BUG-173 28/0, BUG-231 50/0, FEAT-135 31/0, FEAT-175 unit 48/0. BUG-244 in the Docker SANDBOX: post 99/0, pre 41/30 and mutant 91/8 as designed, matrix 6/0. npm run gate PASS. Not restarted.
  Files this round: scripts/lib/agent-git-policy.mjs (+.d.mts), scripts/lib/release.mjs, src/server/index.ts (decide-route gate repo), scripts/verify-feat-164-identity.mjs, scripts/verify-feat-164-release.mjs.

### 2026-10-14 — verify lane (anthropic; openai quota)
- **Verification recorded:** dispatch anthropic/claude-opus-5 run 6efa2e34-e237-4893-ab4b-72cc753c7999 — VERDICT: BROKEN — mixed-state candidate 68d88fda161b — VALID; fixer 56/0. (1) Container projects bypass decidePush: no shim, hook uses standing grant, so git push allowed under commits-only and release mode. (2) Regression: guard caps (depth 8/20000 dirs) truncate on ordinary node_modules; granted .git goes ro. No container e2e.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-14 — worker (verify 6efa2e34 response)
- **Note:** Response to verify 6efa2e34 (coordinator: exactly two things). (1) REGRESSION FIXED: in a granted container, an ordinary node_modules deeper than 8 levels truncated nested-repo discovery, which failed closed and left the .git read-only. src/server/container-manager.ts discovery is now a PRUNED walk with a bounded, documented list (GIT_GUARD_PRUNE_DIRS: node_modules, bower_components, jspm_packages, .pnpm-store, .yarn, vendor, Pods, Carthage, .venv, venv, __pycache__, .tox, .nox, .mypy_cache, .pytest_cache, .ruff_cache, .gradle, .m2, .cargo, target, dist, build, out, .next, .nuxt, .svelte-kit, .turbo, .parcel-cache, .cache, .angular, coverage, .terraform). A pruned directory is itself still checked, so a repo AT dist/ is overlaid; its contents are not walked and count toward neither cap. A truly unreachable depth (non-pruned levels beyond 8) still truncates and fails closed. Recorded residual: a repo nested INSIDE a pruned tree is not overlaid. PROOFS (verify-feat-164-identity, 59/0): C10 a 23-level node_modules with default caps does not truncate, the grant applies, A/.git stays writable, and the nested, submodule and three-deep repos are still overlaid; C11 a repo at dist/ is still overlaid; C12 12 plain non-pruned levels still fail closed. MUST-FAIL with pruning removed (restored cmp-identical): C10 FAILS (truncated), C11 and C12 still pass. (2) RECORDED, NOT FIXED: in container projects the shim is not on the agent's PATH, so decidePush never runs there, and a plain `git push` works under a commits-only grant or in release mode. Added as residual 13 in the body list: "Container sessions bypass decidePush; push enforcement in containers requires OS-level isolation (ARCH-021 option D)." Evidence logged on ARCH-021. Suite / BUG-244 sandbox / gate results follow in the next entry.

### 2026-10-14 — worker (verify 6efa2e34 response)
- **Note:** Results for the verify 6efa2e34 response: identity 59/0 (C10-C12 new), release 129/0 (confined), self-grant 62/0, permanent 42/0, settings-ui 18/0, single-authority 31/0, store-authority 28/0; regressions FEAT-108 grant 69/0, write-block 239/0, BUG-173 28/0, BUG-231 50/0, FEAT-135 31/0, FEAT-175 unit 48/0. BUG-244 in the Docker SANDBOX: post 99/0, pre 41/30 and mutant 91/8 as designed, matrix 6/0, exit 0. npm run gate PASS. Files this round: src/server/container-manager.ts (pruned discovery), scripts/verify-feat-164-identity.mjs, docs/bugs/FEAT-164 (residual 13), docs/bugs/ARCH-021 (evidence). Not restarted.

### 2026-10-14 — worker (BUG-259 fixing r1)
- **Note:** Owner cell moved off 👤: this decision was answered and an agent has acted since, so the rail already treats it as resolved; the 👤 in INDEX was stale drift (BUG-259 triage). Nothing about the answer or its record changed.

### 2026-10-14 — worker (BUG-259 fixing r1)
- **Note:** Correction: the Owner cell is back on 👤. board:check requires 👤 while the record still says human_action decide, and settling that record is outside BUG-259. The earlier note's 'stale drift' stands as an observation only; nothing else changed.

### 2026-10-14 — note (worker, FEAT-190): r2/r3 policy SUPERSEDED

FEAT-164 r2/r3's *policy rulings* (release mode derived from a blank scope note;
"the TARGET repo's grant decides, not the session's" / a grant covers only its own
project repo) are SUPERSEDED by **FEAT-190** (orchestrator decision 2026-10-14):
granting means allowed (commit+push default on, scope advisory, release explicit
opt-in), and a granted session covers the OTHER repos it works in. FEAT-190 rewrites
this ticket's verify suite to assert the new rules in the same change, and FEAT-190's
independent verify covers the superseded behaviour. FEAT-164's grant-binding,
single-use-claim and container machinery are unchanged.
