```orchard-ticket
{
  "id": "BUG-240",
  "type": "bug",
  "title": "Git-write guard refuses writes in throwaway scratch repos",
  "summary": "The agent git-write guard (FEAT-108 hook + FEAT-135 shim) decides by verb only and never resolves which repository a write targets, so commits in scratch and fixture repos that verify scripts build are refused, despite the CONVENTIONS exception.",
  "impact_if_we_wait": "Every verification needing a scratch repo breaks or gets contorted: verify:wa-selfmaintain fails 12/43 (T7/T8), FEAT-170 had to run in the Docker sandbox, a clean-room fixture could not be built.",
  "current_need": "Decide whether agent lanes keep direct Docker access (host root): A keep + runner, B confine sandbox projects, C confine all. The confined runner is built.",
  "severity": "high",
  "area": "agent git-write enforcement / scratch repos",
  "reported": "2026-10-07",
  "reported_by": "agent",
  "owner": "you",
  "work_state": "in_verification",
  "human_action": "decide",
  "updated": "2026-10-14",
  "decision": {
    "id": "a3850757-b019-48cc-bb0a-edabf9406acc",
    "mode": "single",
    "question": "Should agent lanes keep direct Docker daemon access, which is host root (lane user is in group docker; the FEAT-158 sandbox is privileged)?",
    "options": [
      {
        "key": "A",
        "label": "Keep it; document the residual",
        "what_changes": "Nothing changes at lane launch. Scratch-git and destructive suites use the new confined runner (npm run confined)",
        "benefit": "No project loses anything; the runner already fixes the BUG-240 suites",
        "cost": "Any lane can still start a privileged or host-mount container by its own choice",
        "why_not_obvious": "It matches the accidental-misuse threat model (0 deliberate circumventions in 1,871 transcripts)"
      },
      {
        "key": "B",
        "label": "Confine sandbox-declared projects only",
        "what_changes": "Their lanes start with the host and raw sandbox sockets masked and a private PID namespace, reaching the sandbox only through a policy proxy",
        "benefit": "Closes host root where agents run destructive tests; host projects keep deploy, GPU and sysctl lanes",
        "cost": "Large: bubblewrap lane isolation plus an API proxy; BUG-223 host opt-out and GPU suites become user-run; service restart",
        "why_not_obvious": "It removes a capability the user ratified in BUG-223"
      },
      {
        "key": "C",
        "label": "Confine every lane",
        "what_changes": "Same as B for all projects; host-Docker work (deploys, privileged sysctl, GPU compose) becomes user-run or user-approved",
        "benefit": "Agent sessions hold no host root anywhere",
        "cost": "Breaks deploy and GPU lanes in the host-declared projects",
        "why_not_obvious": "It changes how every other project works"
      }
    ],
    "recommendation": "B",
    "recommendation_reason": "B closes host-root access exactly where agents run destructive tests, without breaking deploy lanes elsewhere; A leaves it open by choice, C costs other projects their workflows.",
    "prerequisite": null,
    "answers": [
      {
        "answer_id": "b2c1b9df-7800-4286-b3a9-f9f121ad8921",
        "kind": "decision",
        "followup": false,
        "chose": {
          "key": "A",
          "label": "Keep it; document the residual"
        },
        "note": "Keep agents direct Docker access. The git restriction exists to stop agents autonomously committing/pushing to a project real repo (noise commits, broken main, unintended changes) which the shim covers; it is NOT a security boundary against a deliberately malicious agent. Docker host-root is out of scope for that intent and confining it would cost efficiency. The confined runner stays available for scratch-git/destructive suites.",
        "question": null,
        "by": "user",
        "via": "ticket view",
        "on": "2026-10-08",
        "recorded_at": "2026-10-08T07:16:06.226Z",
        "recorded_by": "server",
        "decision_key": "rec:3dff65b3f837cf7ddfcf033a585d29d68769859431a0f7541859a1c231f6753d",
        "log_k": 23,
        "heading_sha": "1286d331430ffa341c4822ccf910b3d4fdb2497a7db81794da8f7b6a4a25d992"
      }
    ]
  },
  "decision_history": [
    {
      "id": "016ba62b-b6a3-41e2-9952-7b965b2206cb",
      "asked_on": "2026-10-07",
      "question": "How should agent scratch-repo git writes be allowed, given the reviewed path-check plan was unsound?",
      "mode": "single",
      "options_keys": [
        "A",
        "B",
        "C"
      ],
      "chosen": null,
      "chosen_on": null,
      "chosen_by": null,
      "note": "Superseded unanswered on 2026-10-07 with board-tool decide --replace."
    },
    {
      "id": "895c90a4-2fc0-4a0c-b476-d8be274d68b1",
      "asked_on": "2026-10-07",
      "question": "Where should agent suites that need scratch git repos run, now that the FEAT-158 sandbox proved unconfined (privileged, host /tmp and scratch rw)?",
      "mode": "single",
      "options_keys": [
        "A",
        "B",
        "C"
      ],
      "chosen": null,
      "chosen_on": null,
      "chosen_by": null,
      "note": "Superseded unanswered on 2026-10-07 with board-tool decide --replace."
    }
  ],
  "success_criteria": [
    "A git write from a script whose target resolves strictly inside a scratch root, unlinked to any project repo, succeeds under the live shim.",
    "Every named escape route (symlinked .git, --git-dir/GIT_WORK_TREE, alternates, push to the real repo, real worktree under /tmp) is refused, real repo unchanged.",
    "Unresolvable targets fail closed to the existing refusal.",
    "verify:wa-selfmaintain T7/T8 green; existing git-guard suites and npm run gate green."
  ],
  "code_refs": [
    {
      "path": "scripts/lib/git-shim.mjs"
    },
    {
      "path": "scripts/lib/scratch.mjs"
    },
    {
      "path": "scripts/lib/git-write-policy.mjs"
    },
    {
      "path": "src/server/runtime/claude-runtime.ts"
    }
  ],
  "related": [
    {
      "id": "ARCH-021",
      "relation": "see_also"
    },
    {
      "id": "FEAT-135",
      "relation": "see_also"
    },
    {
      "id": "FEAT-108",
      "relation": "see_also"
    },
    {
      "id": "BUG-231",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "openai",
      "model": "default",
      "run_id": "01a11660-ceb5-7543-80bc-747ec14ea750",
      "verdict": "broken",
      "verdict_on": "2026-10-07",
      "recorded_at": "2026-10-07T12:44:50.601Z",
      "author": "plan+review lane",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Plan review UNSOUND: 5 blockers (unchecked verb output paths; config -fPATH / GIT_CONFIG; descendant symlinks under scratch roots; GIT_TRACE probe side-writes; submodules/hooks unbounded) + 4 majors. Per-path resolution is open enumeration. See log."
    },
    {
      "provider": "openai",
      "model": "default",
      "run_id": "01a11667-f473-7820-add1-3bcedd58defe",
      "verdict": "broken",
      "verdict_on": "2026-10-07",
      "recorded_at": "2026-10-07T12:54:27.500Z",
      "author": "plan+review lane",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Plan A review UNSOUND: r1 blockers 1-4 held; 5 partly (host services reachable from confined hooks). New blockers: socket-mediated writes, incomplete protected set, hardlink aliases, FEAT-134 sanctioned plumbing (read-tree --index-output). Live shim NOT wired."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5",
      "run_id": "8d55eadd-9927-468b-911f-15098522ccdd",
      "verdict": "broken",
      "verdict_on": "2026-10-07",
      "recorded_at": "2026-10-07T13:05:45.121Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "89261a8f69444b6c8c8bf1b0d7e06970ecd90f24c04530f09aeb6d1e5e4dc561"
    },
    {
      "provider": "openai",
      "model": "default",
      "run_id": "01a117aa-3d1d-7160-8afd-ce2a2ee8e8dd",
      "verdict": "broken",
      "verdict_on": "2026-10-07",
      "recorded_at": "2026-10-07T18:50:41.199Z",
      "author": "venue lane",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Runner r10 (venue scope): UNSOUND on 3 mediums (ambiguous-create grace, depsKey budget/memory, staging pipeline group kill); all fixed after with P10e-g, suite 61/61. Rounds 2-10 found lifecycle/robustness items only, no confinement escape after r3 (VOLUME tag TOCTOU, fixed). r11 blocked on quota."
    },
    {
      "provider": "openai",
      "model": "default",
      "run_id": "01a11774-948a-7823-a6cf-ad44f270df8c",
      "verdict": "broken",
      "verdict_on": "2026-10-07",
      "recorded_at": "2026-10-07T18:50:51.560Z",
      "author": "venue lane",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Venue plan r1: UNSOUND. Blocker = lanes keep direct Docker authority (user-held chokepoint). No escape from inside the runner. Majors fixed later."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5",
      "run_id": "ab828746-3642-4bdd-a2e3-00b5290ee4f3",
      "verdict": "broken",
      "verdict_on": "2026-10-07",
      "recorded_at": "2026-10-07T23:19:52.588Z",
      "author": "venue lane",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Runner (venue scope): --env could override ORCHARD_CONFINED_SUBDIR/ORCHARD_CONFINED; P3a assumed a git project dir. Both fixed after (P6e, P3a), suite 62/62. No confinement escape. Plan Q1/Q2 untested."
    },
    {
      "provider": "openai",
      "model": "default",
      "run_id": "01a118b7-01cf-7fa2-8422-f9bad988c69e",
      "verdict": "holds",
      "verdict_on": "2026-10-07",
      "recorded_at": "2026-10-07T23:38:26.988Z",
      "author": "venue lane",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Runner r13 (venue scope): SOUND; one minor (capture cap) fixed after. Chokepoint card still open."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5",
      "run_id": "a11809aa-b915-45a9-9e40-733b035663bd",
      "verdict": "broken",
      "verdict_on": "2026-10-08",
      "recorded_at": "2026-10-08T00:41:52.946Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "ac00ddda6dfc1a7718ceb7a9d8d9df2c2a54e973de66f818121d3bfd7abc9d6a"
    }
  ],
  "verification_class": "plan+review",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": false,
    "Implementation notes": true,
    "Verification plan": true,
    "Migration and rollback": true,
    "Risks": true,
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

# BUG-240 — Git-write guard refuses writes in throwaway scratch repos

## Symptom

Three times on 2026-10-07 the agent git-write guard refused writes in THROWAWAY repos that verification needs:
1. A verify lane could not build a clean-room fixture repo (`git init`/`commit` in a scratch dir; `docker run alpine/git` too).
2. FEAT-170's suite had to run inside the Docker sandbox to make its test repos.
3. `npm run verify:wa-selfmaintain` fails 12 of 43 (T7a-c, T7f, T7g, T7i, T7j, T7l-n, T8a-b): `wa-consolidate --apply` commits in a `/tmp/cs-wa-meth-*` scratch repo and the FEAT-135 shim refuses it. Reproduced on the current tree: 31/43.

`.orchard/CONVENTIONS.md` (identity rule) names "scratch and fixture repos built by a verify script" as the explicit exception. Nothing enforces that exception.

## Diagnosis

Hypothesis CONFIRMED on the current tree. Neither layer asks WHICH repository a write targets:
- Hook (claude-runtime.ts PreToolUse -> `evaluateGitWrite({command})` -> `decideGitWrite`): classifies the Bash string by verb. Its leak gate always runs against `config.gitRepoPath`, never against the real target.
- Shim (git-shim.mjs `decideGitShim` -> `offenderForGit(argv)`): classifies argv by verb. cwd, `-C`, `--git-dir`, `GIT_DIR` are never read. The only target-aware rule is the FEAT-134 temp-INDEX plumbing exception.
So a write to `/tmp/x` is indistinguishable from a write to the project. ARCH-021 does not settle this: it decides how complete the gate is for the PROJECT repo (text vs. hooks/RO mount), and is silent on scope. Every ARCH-021 option keeps the shim, so the scope fix is orthogonal and lands in the shim under any choice.

## Implementation notes (the plan)

**Invariant.** A git write from an agent session that would otherwise be refused is allowed ONLY when every repository location the real git process will write (git dir, common dir, object dir and its whole alternates chain, index file, work tree, and for init/clone/push/worktree their destination) resolves, symlinks followed, strictly inside a baked scratch root, and overlaps no registered project path or protected repo. Anything unresolvable, unparsed or unrecognised falls through to TODAY's path unchanged (host grant consult, then deny). The allowance can only turn a would-be-deny into an allow; it never weakens a decision for a non-scratch target.

**Layer: the shim only, not the text hook.** The shim runs as the git process, with the real cwd and env, so it can ask git itself where the write lands. Teaching the hook to resolve targets from shell text (`cd /tmp/x && git commit`) is the open-ended parser ARCH-021 condemns. A shell function or alias can route a "scratch-looking" command to the real repo, and every parse miss there fails open. So Bash-typed git writes stay refused by the hook, as today. Fixture building goes in a script (`node`/`bash file.sh`), whose git calls reach the shim. That covers cases 1-3 (all three are scripts or can be). Containers are unshimmed and unchanged. A `docker run <git image>` typed in Bash stays refused, which is correct: a bind mount of the real repo would make it a real write.

**Design.**
- New module `scripts/lib/git-scratch-target.mjs`, `resolveScratchWrite(argv, env, baked) -> {scratch:true} | {scratch:false, why}`. Pure decision plus one bounded real-git probe.
- Baked at `installGitShim` time, in the HOST process, into the shim source (never read from agent env, since an agent controls `TMPDIR`/`CLAUDE_STATION_TMPDIR`/`CLAUDE_STATION_DATA`):
  - `scratchRoots` = realpath of the host `os.tmpdir()` and of `scratchRoot()` (scripts/lib/scratch.mjs). A root is dropped if it is `/`, `$HOME`, or an ancestor of either.
  - `registryPath` = the host's `registryFile()`.
  - `protectedRepos` = the session's own `gitRepoPath`, when the caller passes it.
- At call time, the registry is read from the baked path. Every `projects[].hostPath` is protected. A read or parse failure means `scratch:false` (fail closed).
- Global-option parse of argv (allowlist): `-C`, `-c k=v` with k in {user.*, init.defaultbranch, commit.gpgsign, tag.gpgsign, gc.auto, maintenance.auto, advice.*, color.*, core.autocrlf, core.filemode, protocol.file.allow}, `--git-dir`, `--work-tree`, `--bare`, `-p/-P/--no-pager/--paginate`, `--no-replace-objects`, `--no-optional-locks`, `--literal-pathspecs`, `--*-pathspecs`. Any other global (`--exec-path`, `--config-env`, `--namespace`, `--super-prefix`, unknown) means refuse.
- Env refuse-list (any set means refuse): `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`, `GIT_SHALLOW_FILE`, `GIT_NAMESPACE`, `GIT_EXEC_PATH`. Env that git itself resolves (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_INDEX_FILE`) is honoured by asking git, below.
- Existing-repo verbs. Run the REAL git (baked absolute path, same globals, same env) as `rev-parse --path-format=absolute` once each for `--absolute-git-dir`, `--git-common-dir`, `--git-path objects`, `--git-path index`, `--is-bare-repository`, and (non-bare) `--show-toplevel`. Bounded at 5 s; non-zero means refuse. `realpath` every result. Then walk `objects/info/alternates` recursively (depth cap 5, relative entries resolved against the objects dir), plus `GIT_ALTERNATE_OBJECT_DIRECTORIES`. Every path must be strictly inside a root and overlap no protected path (A inside P, or P inside A, either way refuses). Refuse if any `url.*.insteadof`/`url.*.pushinsteadof` key exists in the effective config (`git config --get-regexp`) for transport verbs.
- Verb allowlist in scratch mode, everything else refused: add rm mv commit commit-tree write-tree read-tree update-index update-ref symbolic-ref hash-object mktree mktag checkout switch restore reset branch tag merge rebase cherry-pick revert stash notes am apply clean gc repack prune pack-refs reflog replace bisect sparse-checkout fast-import unpack-objects index-pack pack-objects commit-graph multi-pack-index interpret-trailers, plus these with argument checks:
  - `config`: refuse `--global`, `--system`, `--blob`; `--file/-f` must be under a root.
  - `remote`: only add, remove/rm, rename, set-url, get-url.
  - `worktree`: add/move/remove/prune/lock/unlock/list; every path argument under a root and unprotected.
  - `init`: refuse if any GIT_DIR/WORK_TREE/COMMON_DIR/OBJECT_DIRECTORY env or `--git-dir`/`--work-tree` is present; options limited to -q, --bare, -b/--initial-branch, --object-format, --template, --shared; `--separate-git-dir` under a root; the directory (cwd after -C if omitted) resolved via its deepest existing ancestor; an existing `.git` there goes through the existing-repo check.
  - `clone`: explicit destination required; options limited to -q, --bare, --mirror, -b/--branch, --depth, --single-branch, --no-checkout/-n, -o/--origin, --no-tags, --no-local, --template; `--shared`/`--reference`/`--separate-git-dir` must point under a root (the source of `--shared` too); refuse `--recurse-submodules`, `-c/--config`, `-u/--upload-pack`, and any source that is not a local path or `file://`.
  - `fetch`/`pull`: refuse `--upload-pack`/`-u`, `ext::`/`fd::` URLs, and insteadOf config. Sources must be local paths, `file://`, or remote names whose configured url is a local path (read via `git config --get remote.<n>.url` and checked like a path). Fetching FROM a project repo is a read and is allowed.
  - `push`: refuse `--receive-pack`/`--exec`/`--repo`; the destination (explicit path, `file://`, or a remote name resolved as above, including pushurl) must resolve, through the same rev-parse probe run in the destination, to a repo strictly inside a root and unprotected. No push to any non-local URL from scratch, because that would publish content around the leak gate.
- Wire-in (`git-shim.mjs` `resolveGitShim`): after `decideGitShim` says deny-with-consultHost, call `resolveScratchWrite`. On `scratch:true`, allow WITHOUT a host consult, no ledger record, and exec real git with the same argv/env. On `scratch:false`, run today's path verbatim.
- No change to git-grant.mjs, the hook, index.ts or the codex runtime beyond optionally passing `protectedRepos: [config.gitRepoPath]` at the two `installGitShim` call sites (one-line each; coordinated with the BUG-231 owner and the proposal-1 lane via their Activity logs).

**Escape analysis** (each must be refused; P = the project repo):
- E1. Scratch `.git` is a SYMLINK to P/.git: `--absolute-git-dir` is realpath'd to P/.git, outside the roots, so refused.
- E2. Scratch `.git` is a gitdir FILE pointing at P/.git or P/.git/worktrees/x: rev-parse returns the target, so refused (git dir or common dir outside).
- E3. `--git-dir=P/.git` or `GIT_DIR=P/.git` from a scratch cwd: git reports it as the git dir, so refused. `--work-tree=P` or `GIT_WORK_TREE=P` with a scratch GIT_DIR: `--show-toplevel` is P, so refused. `core.worktree=P` in scratch config: same.
- E4. Alternates: scratch `objects/info/alternates` lists P/.git/objects (also nested or relative): the walk finds it, so refused. `GIT_ALTERNATE_OBJECT_DIRECTORIES=P/.git/objects`: refused. `GIT_OBJECT_DIRECTORY=P/.git/objects`: `--git-path objects`, so refused. `GIT_INDEX_FILE=P/.git/index`: `--git-path index`, so refused.
- E5. `git -C /tmp/x push P` / `push file://P` / a remote named `origin` with url or pushurl P / an insteadOf rewriting a /tmp prefix to P: destination resolves to P or insteadOf is present, so refused. `--receive-pack='git-receive-pack P'`: refused.
- E6. A worktree of P placed under /tmp (`P` ran `git worktree add /tmp/w` earlier, or the agent hand-made one): its common dir is P/.git, so refused. `git -C /tmp/x worktree add P/sub`: path argument inside P, so refused.
- E7. Registered project living under /tmp (test projects) or the registry unreadable: protected overlap or fail-closed, so refused.
- E8. Agent sets `TMPDIR=~/projects` or `CLAUDE_STATION_TMPDIR`: the roots are baked from the host, so it has no effect.
- E9. `-c core.worktree=P`, `-c protocol.ext.allow=always`, `--config-env`, `GIT_CONFIG_PARAMETERS`: refused (key not allowlisted / env refused).
- E10. `git -C /tmp init --separate-git-dir P/.git` or `GIT_DIR=P/.git git init`: refused.
- E11. Clone `--shared`/`--reference` of P: refused (alternates into P). A plain local clone of P into scratch is allowed: it reads P, and hardlinked object files are immutable.
Accepted residuals (pre-existing, same-uid adversarial class FEAT-135 already documents, none widened): TOCTOU (swap a scratch path component for a symlink between resolve and exec); absolute `/usr/bin/git` or `git-receive-pack` binaries bypass the shim entirely; a hook or `core.fsmonitor`/editor in a scratch repo runs arbitrary code (its nested `git` calls hit the shim and are decided independently).

## Verification plan

**Proof bar.** New persistent suite `scripts/verify-scratch-git-scope.mjs`, `npm run verify:scratch-git-scope`, driving the REAL installed shim (installGitShim with a stub decide host that always DENIES, so any allow can only come from the scratch rule) against a real protected repo P and real scratch repos:
- Must-FAIL-before / pass-after: scratch init+add+commit, clone-to-scratch, push to a scratch bare remote, fetch, and worktree-in-scratch are ALLOWED after the change and DENIED on the pinned pre-change git-shim.mjs bytes.
- E1-E11 each REFUSED on the new code, each asserted by P's HEAD, index mtime and objects being unchanged (not just exit code). They are also refused pre-change (they were never allowed), which proves the change opened only the scratch class.
- `verify:wa-selfmaintain` 43/43 run under a live shim (T7/T8 green). Existing suites green: verify-feat-135-git-shim, verify-bug-173-grant-aware-shim, verify-bug-230-nested-shim-ownership, verify-bug-231-one-decision, verify-bug-231-call-claims, verify-feat-164-*, verify-feat-108-*. `npm run gate` exit 0.

## Migration and rollback

Additive. A new module plus one branch in `resolveGitShim`, behind fail-closed resolution. Existing sessions keep their already-generated shim until relaunch; new sessions get the new baked fields. Rollback is deleting the branch. No data or ledger change.

## Risks

- A parse or allowlist gap in this module fails CLOSED (the write is refused as today). The design's failure direction is safe, and the review should attack that claim.
- Cost: about 6-8 extra real-git spawns per scratch write only. Reads and project-repo writes skip the probe until the classifier already said "write". For a project-repo write the probe adds one rev-parse round before the unchanged host consult.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-07 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-07 — plan+review lane
- **checkpoint:** CHECKPOINT (restart requested by the coordinator). Phase=finding round=1 class=plan+review.
  - **Done:** hypothesis CONFIRMED (the hook and the shim both decide by verb; neither resolves the target repo). verify:wa-selfmaintain reproduced 31/43 (T7/T8 fail at the shim). ARCH-021 judged orthogonal (it decides gate completeness for the project repo; every option keeps the shim). Plan written in this ticket (Implementation notes / Verification plan).
  - **In flight:** nothing running. The OpenAI plan review (thread 01a115eb) FAILED immediately with quota-window "try again at 3:39 PM", although --check had said available. No children left.
  - **Exact next step:** after 15:39, re-send the review: node src/server/dispatch-client.mjs --provider openai --sandbox read-only --timeout-min 40 --ticket BUG-240 --phase finding --round 1 --class plan+review --prompt-stdin < ~/.local/state/claude-station/scratch/bug-240-lane/wip-20261007T133407/review-prompt.txt. Then build per the reviewed plan: new scripts/lib/git-scratch-target.mjs; one defensive branch in resolveGitShim; baked scratchRoots/registryPath in installGitShim; new scripts/verify-scratch-git-scope.mjs.
  - **Build facts found:** the live shim does import() of the CHECKOUT's git-shim.mjs, so an edit reaches every running session at once. The wire-in must try/catch and fall through to today's path, and unbaked (old) shims get no scratch allowance. The test suite can build its protected fixture as scratch BEFORE registering it in a stub registry, with no absolute-git bypass. The hook misclassifies a quoted 'git' argument or a .../git path followed by a pipe as a write (seen 4x this session: "git head", "git echo", "git ="), which is a separate false-positive.
  - **Files changed:** docs/bugs/BUG-240-*.md (new, this ticket), docs/bugs/INDEX.md (row added by board-tool). No code edits. WIP copy: ~/.local/state/claude-station/scratch/bug-240-lane/wip-20261007T133407.
  - **Gate:** npm run gate exit 1 on leak-gate only (502 hits in 14 files: mermaid vendor bundle, FEAT-130, leak-tokens.mjs, BUG-236 and others, from the in-flight BUG-236 token-rule change). BUG-240 has 0 hits; check-nul and typecheck PASS.

### 2026-10-07 — plan+review lane
- **resume:** RESUMED after the 13:45 restart (nothing had survived; the dispatch had already died on quota). Non-OpenAI work done while waiting for the 15:39 quota reset. The live module is NOT touched: every running shim does import() of the checkout's git-shim.mjs, so the wire-in waits for the review.
  - **New, unwired:** scripts/lib/git-scratch-target.mjs (the resolver), scripts/verify-bug-240-scratch-git-scope.mjs (proof suite, `--pre` / `--module`), scripts/fixtures/bug-240/pre-git-shim.mjs (pinned pre-change shim, sha256 prefix 227e1740661c64d1, import path rewritten).
  - **Staged wire-in:** a patch script plus its applied copy in the lane WIP dir (scratch root, bug-240-lane). It adds one fail-closed branch in resolveGitShim, bakes scratchScope host-side in installGitShim, and tightens isTempIndex.
  - **NEW FINDING (pre-existing FEAT-134 hole):** `GIT_INDEX_FILE` set to a temp-dir SYMLINK to any repo's real index passes isTempIndex's path.resolve prefix test, and the shim allows `git add`, which writes the real index through the link (E4h: the outside repo changed). The same happens for a repo under /tmp with `GIT_INDEX_FILE=<repo>/.git/index` (E4g). Index only, no ref moves. The staged fix realpaths the index and refuses a `.git` component or a git-dir ancestor.
  - **Evidence on the staged module:** suite 56/56. `--pre` on the pinned bytes: 11/11 scratch writes REFUSED (must-fail-before). verify:wa-selfmaintain 43/43 under a staged shim, against 31/43 under today's shim.
  - **Next:** OpenAI plan+code review (prompt in the WIP dir) after 15:39, then apply the wire-in to scripts/lib/git-shim.mjs, then the existing git-guard suites and npm run gate.

### 2026-10-07 — plan+review lane
- **Verification recorded:** dispatch openai/default run 01a11660-ceb5-7543-80bc-747ec14ea750 — VERDICT: BROKEN — Plan review UNSOUND: 5 blockers (unchecked verb output paths; config -fPATH / GIT_CONFIG; descendant symlinks under scratch roots; GIT_TRACE probe side-writes; submodules/hooks unbounded) + 4 majors. Per-path resolution is open enumeration. See log.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-07 — plan+review lane
- **Decision declared:** How should agent scratch-repo git writes be allowed, given the reviewed path-check plan was unsound? Options: A — Kernel-confine scratch writes; B — Harden the path checks; C — Keep refusing scratch writes. Recommended: A — Only A makes the invariant hold by the kernel instead of by an enumeration; bwrap 0.11.2 already works on this host (inside write ok, outside EROFS). Written to the record with board-tool decide; the Decide card reads the record, not this line.

### 2026-10-07 — plan+review lane
- **decision card:** STOPPED at a decision card (no wire-in; the live git-shim.mjs is untouched).
  - **OpenAI plan+code review (run 01a11660-ceb5-7543-80bc-747ec14ea750): UNSOUND.** Blockers, each concrete and accepted:
    - (1) whole-verb allowances miss explicit output paths: pack-objects <P/.git/objects/pack/x>, fast-import --export-marks=<P/.git/config>, interpret-trailers --in-place <P file>;
    - (2) config -f<PATH> (attached) and GIT_CONFIG= escape the config check;
    - (3) descendant symlinks under a realpath'd scratch git dir (refs/heads to P) are never examined;
    - (4) the probes themselves write files through GIT_TRACE / GIT_TRACE2_EVENT;
    - (5) submodule recursion, plus hooks, filters and bisect run: git prepends its exec-path, so a hook's git does not re-enter the shim.
    Majors: registered storage (gitdir files, external commondirs) is not protected, only hostPath; init/clone checks are partial; the escape() oracle accepts any nonzero exit; the temp-index fix is incomplete (relative GIT_INDEX_FILE resolves after -C). Minor: the "every ARCH-021 option keeps the shim" claim is overstated (option A = classifier only), so that claim is withdrawn.
  - **Conclusion:** per-path resolution is an open enumeration, the same shape ARCH-021 condemns. That leaves a genuine design fork, recorded as the decision card (A kernel confinement via bwrap, recommended; B harden the path checks; C keep refusing). bwrap 0.11.2 works on this host: write inside the bound dir ok, outside EROFS.
  - **Independent of the fork (pre-existing, live today):** FEAT-134's isTempIndex lets `GIT_INDEX_FILE` = a temp-dir symlink to ANY repo's real index pass, and `git add` then writes that real index (E4h, proven). The fix needs an absolute path plus a check against the resolved repo index (review finding 8), not naming heuristics.
  - **Left on disk, inert (nothing imports them):** scripts/lib/git-scratch-target.mjs (draft resolver; superseded if A wins), scripts/verify-bug-240-scratch-git-scope.mjs (escape fixtures reusable for A or B; its oracle must be hardened per finding 9), scripts/fixtures/bug-240/pre-git-shim.mjs (pinned pre-change bytes). The staged wire-in and the review prompt are in the lane WIP dir (scratch root, bug-240-lane).
  - **Baseline suites on today's code:** verify-feat-135-git-shim and verify-feat-108-git-request-approve FAIL in an agent session for THIS bug (fixture git init refused; feat-108 also builds under ~/scratch, not a scratch root). bug-173 28/0, bug-230 pass, bug-231 one-decision 50/0, bug-231 call-claims 21/0, feat-164 store 28/0, single 31/0, permanent 41/0, feat-163-165 45/0. feat-164-self-grant exits 2 with 12 documented OPEN holes (pre-existing).

### 2026-10-07 — plan+review lane
- **plan A:** PLAN A (coordinator chose A: kernel confinement; B is an UNSOUND enumeration, C keeps the bug). This supersedes the path-check plan above.
  - **Invariant:** a git write the shim would otherwise refuse may run ONLY inside a bubblewrap sandbox. In that sandbox the whole filesystem is read-only except the host-baked scratch roots, and inside those roots every registered project's path and resolved git storage is re-bound read-only. The process tree has no network, its own PID/IPC namespaces, and no TTY injection. The kernel, not a parser, guarantees that nothing outside writable scratch changes. Anything that cannot be sandboxed is refused exactly as today.
  - **Routing (UX only, never a security decision):** decideGitShim says write and would consult the host. A pure-JS hint (no git spawn) computes the effective cwd after -C (and --git-dir/GIT_DIR, or the init/clone destination). If the hint resolves under a writable root and outside every registered path, the write runs CONFINED and never consults the host: no ledger record, no grant spent, no BUG-231 window touched. Otherwise it takes today's path verbatim (host consult, leak gate, deny). A wrong hint only produces a confined write that fails with EROFS, which is fail-closed.
  - **Mount layout** (bwrap argv, in order): --unshare-all --die-with-parent --new-session --ro-bind / / --dev /dev --proc /proc; --bind R R for each root R (host realpath of os.tmpdir() and scratchRoot()); then --ro-bind X X for each registered project hostPath under a root, its .git, the gitdir/commondir it points at (read from the .git file and commondir in pure JS, realpath'd), and every /tmp/orchard-git-shim-* dir. bwrap's --ro-bind / / applies read-only to submounts too (/home, /tmp tmpfs).
  - **Protected-repo determination:** structural. Anything outside the roots is read-only by the mount. Inside the roots, the registry (read from the BAKED host path; unreadable or malformed means refuse) supplies the re-protected set. The roots, registry path, bwrap path and real git are baked by the HOST at installGitShim time, never read from the agent env.
  - **Hooks/PATH:** hooks, filters, editors, fsmonitor, receive-pack, submodule recursion, `bisect run` and git's exec-path-prepended nested git calls all run INSIDE the sandbox process tree, so they are confined the same way, whether or not they re-enter the shim. The env passes through unchanged. GIT_TRACE*/GIT_CONFIG/-fPATH outputs outside the roots fail with EROFS. With no network, a nested shim's host consult fails closed.
  - **Fallback (fail closed):** on non-linux, no baked bwrap path, or a failed preflight (`bwrap --ro-bind / / --unshare-all true`, which catches a container without user namespaces, userns disabled, or a missing binary), the scratch write is refused exactly as today, with the reason appended to the refusal ("scratch git writes need bubblewrap: <reason>").
  - **Index-symlink hole (FEAT-134 isTempIndex):** sanctioned temp-index plumbing still runs unconfined, because snapshots write the real object store by design. isTempIndex is tightened: GIT_INDEX_FILE must be ABSOLUTE (relative is refused, since it resolves after -C), realpath'd (loose) strictly inside realpath(tmpdir), with no ancestor that is a git dir (HEAD plus objects, commondir or gitdir). A symlink to a real index realpaths outside tmp, or into a git dir, and is refused. Hardlinks are harmless, because git writes the index by lockfile plus rename.
  - **How every Orchard project gets it:** the shim is installed per session by claude-runtime and codex-runtime through installGitShim. The baked scope is computed inside installGitShim, so there are no runtime edits, and every project's new sessions get it. Live shims import the checkout module: the isTempIndex fix applies to them at once, but they lack the baked scope, so they get no scratch allowance until relaunch (fail closed).
  - **Accepted residuals (not widened):** unix-domain sockets on read-only mounts stay connectable (e.g. a docker socket), and the agent itself, unconfined, can already reach them and call /usr/bin/git directly. TOCTOU on the hint only misroutes into the sandbox. Writes inside writable scratch, including other lanes' throwaway clean rooms, are permitted by design.
  - **Proof bar** (persistent suite verify-bug-240-scratch-git-scope.mjs; the oracle asserts refusal or failure AND that P is byte-unchanged over its full .git and work tree; each attack is shown to SUCCEED on an unconfined control repo, so the attack itself is valid). The 5 OpenAI blockers (pack-objects/fast-import/interpret-trailers outputs, config -fPATH and GIT_CONFIG, descendant refs symlink, GIT_TRACE to P, hook and submodule nested git) and the original 5 escape routes (symlink or gitdir-file .git, --git-dir/GIT_WORK_TREE, alternates, push to P, P worktree under /tmp) leave P unchanged. Index-symlink E4h must-FAIL on the pinned pre bytes and pass after. Scratch writes are allowed. The bwrap-unavailable fallback refuses with its reason. verify:wa-selfmaintain 43/43; FEAT-108/135, BUG-230/231 suites green; gate clean on these files.

### 2026-10-07 — plan+review lane
- **Verification recorded:** dispatch openai/default run 01a11667-f473-7820-add1-3bcedd58defe — VERDICT: BROKEN — Plan A review UNSOUND: r1 blockers 1-4 held; 5 partly (host services reachable from confined hooks). New blockers: socket-mediated writes, incomplete protected set, hardlink aliases, FEAT-134 sanctioned plumbing (read-tree --index-output). Live shim NOT wired.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-07 — plan+review lane
- **plan A review:** Plan A reviewed UNSOUND (run 01a11667). Re-attack of r1 blockers: 1-4 HELD under A, 5 partly (confined hooks can still reach host services). New blockers to resolve before any build ships: host pathname sockets reachable from the sandbox; protected set incomplete (external object storage, registry/shim dirs under a writable root, reverse overlap); hardlink/bind aliases into writable scratch; the FEAT-134 sanctioned-plumbing exception is a whole-verb allowance (read-tree --index-output), not fixed by isTempIndex alone. Majors: launcher env/fd hygiene, explicit confined/granted/denied outcomes, more boundary tests. Staged (NOT live): scripts/lib/git-confine.mjs; wire-in patch in the lane WIP dir. Suite scripts/verify-bug-240-scratch-git-scope.mjs: --pre 16/16 (13 scratch writes refused, 3 index holes open), staged module 51/51. Live git-shim.mjs untouched.

### 2026-10-07 — design-review lane
- **Decision declared:** Where should agent suites that need scratch git repos run, now that the FEAT-158 sandbox proved unconfined (privileged, host /tmp and scratch rw)? Options: A — New confined runner on the sandbox daemon; B — Make the FEAT-158 sandbox itself unprivileged; C — No agent scratch git at all. Recommended: A — A is the smallest construct that is confined by construction for the helper; B is the follow-up for the daemon (FEAT-170 N2); C gives up verification. Supersedes the earlier unanswered decision (kept in decision_history). Written to the record with board-tool decide; the Decide card reads the record, not this line.

### 2026-10-07 — design-review lane
- **design review:** DESIGN REVIEW (two-break rule: B and A both UNSOUND). No OpenAI this round.
  - **Outcome: RESCOPE in direction (agents do no host scratch writes), BLOCKED on the venue, so a decision card.** "Keep" (patching host allow-mechanisms) loses: two independent UNSOUND verdicts by different routes. "Redesign" on the host loses: both designs (path checks, bwrap) were broken through the open surface. Rescope wins only if its venue is confined by construction, and the existing one is not (see b).
  - **(a) How FEAT-170 reached the sandbox:** every lane of a `sandbox` project inherits DOCKER_HOST at the FEAT-158 daemon (this lane has it too: ORCHARD_LANE_DOCKER = the sandbox socket). The Bash hook classifies only command TEXT for git write verbs, so `docker run ... node <suite>` (git runs inside the container, unshimmed) passed, while `docker run alpine/git commit` carries a git write verb in its text and was refused. Inferred from FEAT-170's disclosure plus the hook's text-only design; the exact FEAT-170 command line is not logged.
  - **(b) Ground truth, read-only (`docker inspect orchard-docker-sandbox`):** privileged=true, no userns remap; binds: host /tmp rw, the tooling scratch root rw, the Orchard repo ro, its run dir rw. A read-only bind is no boundary for privileged root, and host /tmp holds session shim dirs and any tmp-registered project. NOT confined by construction. Established from configuration only; no escape was attempted against real repos.
  - **(c) Not built (blocked on the card).** Under option A: a one-call helper (e.g. `runGitSandboxed({ fixtures, script })` in scripts/lib) that starts an unprivileged no-bind container on the sandbox daemon, streams fixtures in and results out, plus migrating wa-selfmaintain T7/T8 to it.
  - **Live-hole fix DONE (plain fix, independent of the card):** scripts/lib/git-shim.mjs isTempIndex now requires an absolute path, a realpath'd parent inside realpath(tmpdir), a non-symlink leaf, and no git-dir ancestor. New persistent suite scripts/verify-bug-240-temp-index.mjs (`npm run verify:bug-240`): `--pre` on the pinned bytes: H1 (temp symlink to an outside repo's index), H2 (a tmp repo's own index), H3 (relative after -C), H4 (a linked-worktree index): 4/4 OPEN. After: 8/8, all four refused with the index unchanged, while snapshotWorkingTree and the candidate-store mkdtemp index still work.
  - **Guard suites after the fix, identical to baseline:** bug-173 28/0, bug-230 pass, bug-231 50/0 and 21/0, feat-164 28/0, 31/0, 41/0, feat-163-165 pass; feat-164-self-grant exit 2 (12 documented OPEN holes, pre-existing). feat-135 and feat-108 fail at their fixture `git init`, exactly as at baseline: that is this ticket's bug, which option A would fix.
  - **Known sibling NOT fixed (minimal scope):** the sanctioned plumbing still allows `read-tree --index-output=<path>`, which the plan-A review found. Needs its own fix.
  - **npm run gate:** exit 0 (leak-gate, check-nul, typecheck PASS); 0 leak hits in BUG-240 files.
  - **Files (unstaged):** scripts/lib/git-shim.mjs (isTempIndex only), scripts/verify-bug-240-temp-index.mjs (new), scripts/fixtures/bug-240/pre-git-shim.mjs (new, pinned pre bytes), package.json (verify:bug-240 line), docs/bugs/BUG-240-*.md, docs/bugs/INDEX.md. The abandoned option-A files were moved to the lane WIP dir (scratch root, bug-240-lane).

### 2026-10-07 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5 run 8d55eadd-9927-468b-911f-15098522ccdd — VERDICT: BROKEN. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-07 — design-review lane
- **rescope (coordinator call):** RESCOPE (coordinator call after independent verify run 8d55eadd-9927-468b-911f-15098522ccdd came back BROKEN, a two-break on property 1).
  - **Rescoped property (testable):** with the agent env as inherited from Orchard (no agent-chosen TMPDIR or GIT_INDEX_FILE indirection beyond a temp path), the shim refuses `git add`/plumbing whose GIT_INDEX_FILE is a temp-dir symlink to, a relative path onto, or the own index of a real repo (proof: `npm run verify:bug-240`, 4/4 OPEN on the pinned pre bytes, 8/8 after).
  - **Accepted residuals, outside that scope** (deliberate same-uid evasion, the BUG-230 "same-uid self-sabotage" class):
    - (1) an agent-set `TMPDIR=<repo>/.git` plus GIT_INDEX_FILE passes the guard and writes the real index;
    - (2) `read-tree --index-output=<path>` writes a real index under the sanctioned plumbing exception (nothing in scripts/ or src/ issues it).
    Neither is chased here.
  - **Evidence:** plan B UNSOUND (run 01a11660), plan A UNSOUND (run 01a11667), and fix verify BROKEN (run 8d55eadd: TMPDIR and --index-output). The research found 0 deliberate circumventions in 1,871 transcripts (FEAT-170 r3 reach.py). The text/env guard defends against accidental or habitual git writes only. Airtight enforcement needs OS-level confinement of the agent session, which is ARCH-021 and the user's decision.
  - **Still open, the user's decision:** the FEAT-158 Docker sandbox is privileged with host /tmp and scratch rw (docker inspect), so it is not a confined venue for scratch-git suites. The venue decision card above stands.
  - No code changed in this step; the symlink fix stays as landed.

### 2026-10-07 — venue lane
- **Verification recorded:** dispatch openai/default run 01a117aa-3d1d-7160-8afd-ce2a2ee8e8dd — VERDICT: BROKEN — Runner r10 (venue scope): UNSOUND on 3 mediums (ambiguous-create grace, depsKey budget/memory, staging pipeline group kill); all fixed after with P10e-g, suite 61/61. Rounds 2-10 found lifecycle/robustness items only, no confinement escape after r3 (VOLUME tag TOCTOU, fixed). r11 blocked on quota.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-07 — venue lane
- **Verification recorded:** dispatch openai/default run 01a11774-948a-7823-a6cf-ad44f270df8c — VERDICT: BROKEN — Venue plan r1: UNSOUND. Blocker = lanes keep direct Docker authority (user-held chokepoint). No escape from inside the runner. Majors fixed later.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-07 — venue lane
- **Decision declared:** Should agent lanes keep direct Docker daemon access, which is host root (lane user is in group docker; the FEAT-158 sandbox is privileged)? Options: A — Keep it; document the residual; B — Confine sandbox-declared projects only; C — Confine every lane. Recommended: B — B closes host-root access exactly where agents run destructive tests, without breaking deploy lanes elsewhere; A leaves it open by choice, C costs other projects their workflows. Supersedes the earlier unanswered decision (kept in decision_history). Written to the record with board-tool decide; the Decide card reads the record, not this line.

### 2026-10-07 — venue lane
- **venue:** VENUE BUILT (option A of the prior card) + new user-held chokepoint card.
    - **Ground truth:** the lane user is in group docker and /run/docker.sock is root:docker 0660 (no passwordless sudo), so every lane of every project already holds host root through the HOST daemon; the privileged FEAT-158 sandbox is a second door. The single chokepoint is lane-level socket access, not any one daemon.
    - **Inventory:** 30 Docker-using verify suites (6 guarded, 2 dual on purpose, 20 inherit DOCKER_HOST, 1 GPU host opt-out); 0 start a privileged container; ~18 boot scratch servers whose session containers need path-identical host binds, uid identity and cgroup limits; 2 read host /proc without opting out (feat-155-dockerfile, feat-155-prebuilt-lockdown: a separate gap); ~60 suites build scratch git repos. Other projects: none use the sandbox; all but 3 declare laneDocker=host and use host Docker operationally (deploys, privileged sysctl, GPU, socket binds).
    - **B priced and not taken as the venue:** a rootless dind probe runs without --privileged and holds (inner --privileged fails, -v /:/h sees only its own fs), but maps container uid 1000 to 100999 and has no cgroup driver, so the server-container suites would test something else. Not a drop-in.
    - **Built (A):** scripts/lib/confined-run.mjs, scripts/confined-run.mjs (`npm run confined`, works from any project dir), scripts/verify-bug-240-confined-run.mjs (`npm run verify:bug-240-confined`, 61/61 incl. a CONTROL showing a plain sandbox container writes host /tmp). Fixed flags: --cap-drop ALL, no-new-privileges, --network none, read-only rootfs, uid 1000, size-capped tmpfs only, memory/pids caps, no mounts; tree in and --out back as tar streams (strict extractor); image-independent expiry (label + detached reaper + sweep). docs/CONVENTIONS.md paragraph under FEAT-158.
    - **Migrated with proof (confined):** verify-wa-selfmaintain 43/43 (31/43 on host), verify-feat-135-git-shim 31/0 (fails at fixture init on host), verify-feat-170-candidates 93/0. verify-feat-108-git-request-approve stays host-run (leak tokens derive from the host identity; needs the live claude CLI). No existing suite edited.
    - **Review:** OpenAI r1-r10 all UNSOUND: r1 blocker = the chokepoint (now the card); r2-r10 lifecycle/robustness only, each fixed with a test; r3 found the one confinement-relevant item (VOLUME check on a mutable tag), fixed. r11 blocked by quota until 01:41.
    - **Gate:** npm run gate exit 0. Files (unstaged): scripts/lib/confined-run.mjs, scripts/confined-run.mjs, scripts/verify-bug-240-confined-run.mjs (new), package.json (2 scripts), docs/CONVENTIONS.md, this ticket.

### 2026-10-07 — venue lane
- **Verification recorded:** dispatch anthropic/claude-opus-5 run ab828746-3642-4bdd-a2e3-00b5290ee4f3 — VERDICT: BROKEN — Runner (venue scope): --env could override ORCHARD_CONFINED_SUBDIR/ORCHARD_CONFINED; P3a assumed a git project dir. Both fixed after (P6e, P3a), suite 62/62. No confinement escape. Plan Q1/Q2 untested.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-07 — venue lane
- **checkpoint:** CHECKPOINT (restart requested by the coordinator). Phase=finding round=1 class=plan+review.
    - **Done:** confined runner built and proven (suite `npm run verify:bug-240-confined` 62/62; wa-selfmaintain 43/43, feat-135 31/0, feat-170 93/0 confined; gate exit 0). OpenAI r1-r10 all UNSOUND, each item fixed with a test; r11 blocked by quota. Per the user instruction relayed by the coordinator, an independent Claude verify replaced OpenAI: run ab828746 BROKEN on two items (--env overriding the runner's reserved variables; P3a assumed a git project dir), both fixed (P6e, P3a init inside the container). Chokepoint decision card written (A keep + runner / B confine sandbox-declared projects / C confine all; recommend B).
    - **In flight:** nothing. No confined containers or reapers left on the sandbox.
    - **Exact next step:** re-run the independent Claude verify on the fixed tree (prompt: lane WIP dir r-venue/requirement.txt; `node scripts/independent-verify.mjs --requirement @<that file> --working-tree --provider anthropic --model claude-opus-5 --author-provider anthropic --timeout-min 45 --run "node scripts/verify-bug-240-confined-run.mjs" --test-file scripts/verify-bug-240-confined-run.mjs`), record it, then hand back the card.
    - **Files changed (unstaged):** scripts/lib/confined-run.mjs (new), scripts/confined-run.mjs (new), scripts/verify-bug-240-confined-run.mjs (new), package.json (confined, verify:bug-240-confined), docs/CONVENTIONS.md (FEAT-158 section paragraph), this ticket.

### 2026-10-07 — venue lane
- **review done:** RESUMED after restart; runner review finished. OpenAI r11 (dangling metadata, budget at entry) and r12 (pax without path) fixed with P5k; r13 SOUND (run 01a118b7), its one minor (capture cap) fixed. Suite 63/63, wa-selfmaintain 43/43 confined, gate exit 0, no leftover containers or reapers. The venue is done; BUG-240 stays blocked only on the chokepoint card (A keep / B confine sandbox projects / C confine all; recommend B). Files unchanged from the checkpoint list.

### 2026-10-07 — venue lane
- **Verification recorded:** dispatch openai/default run 01a118b7-01cf-7fa2-8422-f9bad988c69e — VERDICT: HOLDS — Runner r13 (venue scope): SOUND; one minor (capture cap) fixed after. Chokepoint card still open.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-08 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5 run a11809aa-b915-45a9-9e40-733b035663bd — VERDICT: BROKEN. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-08 — venue lane
- **caps fixed:** Verify a11809aa (BROKEN on caps only) fixed in the one allowed round. (1) CPU: --cpus in the fixed flags (default 2, --cpus N); P7e: 6 busy workers held to <=1.3 cores at --cpus 1, CONTROL without --cpus >=3 cores (must-FAIL). (2) --out: StrictTarSink streams the export straight to disk with a hard --out-mb cap (default 512); over the cap the export is killed, the partial dir removed, the run fails with outError (P7f); P7g: a 400 MiB export keeps the runner peak RSS under 200 MiB while a buffered CONTROL peaks over 400 MiB (must-FAIL). Both were local changes. Suite 67/67, wa-selfmaintain 43/43 confined, npm run gate exit 0. Files unchanged from the checkpoint list.

### 2026-10-08 — you (answer · via ticket view · decision a3850757-b019-48cc-bb0a-edabf9406acc)
- **Chose:** A — Keep it; document the residual
- **Note:** Keep agents direct Docker access. The git restriction exists to stop agents autonomously committing/pushing to a project real repo (noise commits, broken main, unintended changes) which the shim covers; it is NOT a security boundary against a deliberately malicious agent. Docker host-root is out of scope for that intent and confining it would cost efficiency. The confined runner stays available for scratch-git/destructive suites.
- **State:** answered — awaiting agent action (not dispatched)

### 2026-10-08 — BUG-240 decision lane
- **decision rationale + threat model:** Decision A recorded through the server answer API (POST /api/projects/claude-station/tickets/BUG-240/answer, chose key A). Quoting the user's stated intent behind the restriction: "It exists so agents don't autonomously commit or push to a project's real repo, which would mean noise commits, a broken main branch and unintended changes. It is NOT a security boundary against a deliberately malicious agent." Threat model (confirming prior lanes, 0 deliberate circumventions in 1,871 transcripts): the write guard defends against ACCIDENTAL or HABITUAL commits and pushes to the real repo, which the FEAT-135 shim covers. A deliberately malicious same-uid agent is explicitly OUT of scope, so direct Docker host-root access is out of scope for this intent and confining it (B/C) would cost efficiency for no in-scope gain. The confined runner (npm run confined) stays available for scratch and destructive suites.

### 2026-10-14 — worker (BUG-259 fixing r1)
- **Note:** Owner cell moved off 👤: this decision was answered and an agent has acted since, so the rail already treats it as resolved; the 👤 in INDEX was stale drift (BUG-259 triage). Nothing about the answer or its record changed.

### 2026-10-14 — worker (BUG-259 fixing r1)
- **Note:** Correction: the Owner cell is back on 👤. board:check requires 👤 while the record still says human_action decide, and settling that record is outside BUG-259. The earlier note's 'stale drift' stands as an observation only; nothing else changed.
