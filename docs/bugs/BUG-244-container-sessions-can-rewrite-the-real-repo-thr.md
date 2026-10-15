```orchard-ticket
{
  "id": "BUG-244",
  "type": "bug",
  "title": "Container sessions can rewrite the real repo through a writable .git",
  "summary": "A container project bind-mounts its directory read-write including .git, and container git is not shimmed, so an agent inside the container can commit, reset or update-ref the real repo with only the fail-open host text hook in the way.",
  "impact_if_we_wait": "A careless model in any ungranted container project can destroy real-repo history (reset --hard, branch -D, gc --prune, rm -rf .git) through any shell form the text classifier misses, and the user only finds out afterwards.",
  "current_need": "Mount every real .git reachable through a container rw bind read-only unless the project holds the permanent git-write grant, without recreating any container under live sessions.",
  "severity": "high",
  "area": "container isolation / agent git-write enforcement",
  "reported": "2026-10-08",
  "reported_by": "agent",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-10-08",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "An ungranted container cannot commit, reset, update-ref, branch -D, gc-prune or delete the real .git by any spawn form; host repo byte-identical; must-FAIL on HEAD.",
    "A container project with the permanent git-write grant can still commit and update-ref.",
    "No container holding a live lease is recreated or has a launch refused by the guard; it applies at the next idle launch or Rebuild.",
    "Non-git and granted projects keep byte-identical bind lists (no drift churn)."
  ],
  "code_refs": [
    {
      "path": "src/server/container-manager.ts"
    }
  ],
  "related": [
    {
      "id": "ARCH-021",
      "relation": "see_also"
    },
    {
      "id": "FEAT-164",
      "relation": "see_also"
    },
    {
      "id": "BUG-214",
      "relation": "see_also"
    },
    {
      "id": "ARCH-022",
      "relation": "see_also"
    },
    {
      "id": "FEAT-135",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "6846e653-ac26-4001-bdbf-94a5d35ac6f5",
      "verdict": "broken",
      "verdict_on": "2026-10-08",
      "recorded_at": "2026-10-08T08:58:09.832Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "cb489e39c2da096c60893fbb59782d09d6ace772249b519feeba0c3681827bd3",
      "note": "Nested repo named dist/build/target/venv skipped; submodule-checkout registered project Q under granted G treated as G's. OpenAI blocked twice by its cyber content filter (runs 01a11a9d…, 01a11aa1…), so verified by Claude Opus."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "e1a5f657-5ddf-460d-a87b-bf69eda64146",
      "verdict": "broken",
      "verdict_on": "2026-10-08",
      "recorded_at": "2026-10-08T09:20:59.404Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "734a167a6495ae731cec9f2f6fcae8dc0ffe68d5c8ddee1f17092bb38917c1dc",
      "note": "Ownership by exact folder only: linked-worktree and monorepo-subfolder registered projects unlocked by a granted mounter; bare repo one level below not overlaid."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "e4c8001a-ebc4-4531-81af-26ec5f3eb3eb",
      "verdict": "broken",
      "verdict_on": "2026-10-08",
      "recorded_at": "2026-10-08T09:26:12.463Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "323433cafc7e4f99377a12c8be30c891dff67414fdd41fccefc375471fea99c7",
      "note": "Overlay path containing ':' makes docker create fail; deleted overlay source + stop/start lets Docker create a root-owned dir (BUG-136 class)."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "9914222c-aadf-4a9d-98f2-bc84a459a462",
      "verdict": "broken",
      "verdict_on": "2026-10-08",
      "recorded_at": "2026-10-08T09:39:46.196Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "dd93c9635c177c3aad1e784ec44009bedf712bd66a23746d81c200c3db684d29",
      "note": "Bare repo that is itself a rw bind root (mounted origin.git, or a bare project dir) gets no overlay; push -f / update-ref -d into it succeed."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "16d31ab3-8b4b-4ae7-ad5c-906605ed54fd",
      "verdict": "broken",
      "verdict_on": "2026-10-08",
      "recorded_at": "2026-10-08T09:52:47.434Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "dae0dad7cdfbd59c592290be37119df9601640f15c07cf4fef1986fe67cc97d9",
      "note": "Guarded .git whose objects/ and refs/ are symlinks into the rw project tree: raw writes reach the real store through the symlinks."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "33d49218-0e2f-4fc2-8501-0300e14edd01",
      "verdict": "broken",
      "verdict_on": "2026-10-08",
      "recorded_at": "2026-10-08T10:04:11.421Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "dd7c6cae3f4de9a61986ae9e460ba450e7f906d529b7b12e7b67c68b677cbd8d",
      "note": "r4 replace-bind path: a grant flip on a bare-root mount surfaces a non-informational missing-bind (refused live / recreated idle); a real mount change at that path hides as gitguard."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "9ff97062-9b11-407b-8af5-efe77046917b",
      "verdict": "broken",
      "verdict_on": "2026-10-08",
      "recorded_at": "2026-10-08T10:36:38.707Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "211a5480fd3cd16d1da550d39338d059da83e07d28287f924190121f674774cd",
      "note": "Ownership walked only up from a registered project's folder: a repo one level below ungranted Q (q/dist, umbrella/api) writable from a granted G that mounts it."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "d79e62e2-6a85-43ef-9f05-32b938a1a92f",
      "verdict": "broken",
      "verdict_on": "2026-10-08",
      "recorded_at": "2026-10-08T10:53:40.004Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "bc9632f065042083f2985dac1beb01572ed898ee1abc0873f19c6820882688ab",
      "note": "r7 down-walk let an ungranted umbrella/parent project claim a granted nested project's own .git (G lost its own write)."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "5c26f90e-79b2-44a4-946f-f115dbf29565",
      "verdict": "broken",
      "verdict_on": "2026-10-08",
      "recorded_at": "2026-10-08T10:59:53.130Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "230d753f5a17d7e5f65c96c40fbfca84983b522aedef0da2e022b34f237abc57",
      "note": "Overlay emitted inside a deeper user mount that shadows the nested repo (<workdir>/data): Docker creates a root-owned .git in the mounted host dir."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "eecfb1d3-0c61-4359-aa63-1d0429705210",
      "verdict": "broken",
      "verdict_on": "2026-10-08",
      "recorded_at": "2026-10-08T11:13:27.673Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "aaa2bc923a64f0eea5b60d6017d485184c40bc6d7199444200d67a1bce9cde8a",
      "note": "r9 skip rule used raw path prefixes: a mount spelled <workdir>/data/ still got an overlay inside it (root-owned .git)."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "d40eea90-b9f5-44fd-ad69-c33d1de6a341",
      "verdict": "broken",
      "verdict_on": "2026-10-08",
      "recorded_at": "2026-10-08T11:22:24.468Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "31545216dabfb31d714dd962033b7463ef5312ca033cf1165eb6eb01154952e5",
      "note": "Host-side delete + re-clone of a nested repo while the container runs: the overlay stays on the old dir, the new .git is writable, status shows no drift."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "a9180902-815b-43a1-88f6-96467694fd02",
      "verdict": "broken",
      "verdict_on": "2026-10-08",
      "recorded_at": "2026-10-08T12:06:03.370Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "706ec7c00e8fb404be13d799b698a3e2f0d509394ca292ff306f3b51418a5db4",
      "note": "FEAT-157 recovery branch started a stopped container (after docker cp) whose overlay source was gone: root-owned sub/.git."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "0a3940df-a409-4f4f-bc60-3a2f7cc4f057",
      "verdict": "holds",
      "verdict_on": "2026-10-08",
      "recorded_at": "2026-10-08T12:20:21.813Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "candidate": "7dfdd7d6e7e3b0af775239d356498e30a5ff2e5154ebdc434005fd3e2a09c73c",
      "note": "HOLDS on r13 after 12 BROKEN rounds. Remaining in-model residuals (recorded): repos 2+ levels below a bind root; network push. Same provider as author (OpenAI blocked by its content filter twice)."
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

# BUG-244 — Container sessions can rewrite the real repo through a writable .git

## Problem

A container project's directory is bind-mounted read-write into its container **including `.git`** (`desiredBinds()`, `src/server/container-manager.ts`). Container git is not shimmed (FEAT-135 shim dir is a host temp path, `claude-runtime.ts` FEAT-135 comment), so the only guard is the host PreToolUse text hook, which is fail-open by construction (ARCH-021). An agent in the container can `commit`, `reset --hard`, `update-ref`, `branch -D`, `gc --prune=now` or `rm -rf .git` against the real repo from a script, `sh -c`, `python -c`, or any form the classifier misses.

Also observed in the live registry (2026-10-08): one ungranted container project declares a **read-write user mount of another project's repo**, so that repo's `.git` is reachable rw from the container too.

Evidence: process-research 2026-10-07 `agent-vcs.md` §1 "Containers", §2 table row "container project".

User goal (sets the bar): agents must not autonomously commit/push to a project's real repo unless the user granted it for that project; a careless model must not be able to destroy real-repo history; NOT a defence against a deliberately evasive agent (ARCH-021 2026-10-08 log).

## Plan (round 1)

**Invariant.** For a container project P without a permanent git-write grant (and with the FEAT-108 block on), every real git directory that sits at the root of a read-write directory bind of P's container (the project dir and every rw user mount) is mounted **read-only** inside the container. The kernel refuses the write (EROFS) however git or the file write was spawned; no parsing.

**Design.**
- `gitGuardBinds(project)` in container-manager.ts, appended to `desiredBinds()` after user mounts (Docker orders mounts by destination, so a nested ro overlay over a rw parent applies regardless of list order). For each rw directory bind B:
  - `B.host/.git` is a directory -> bind its realpath read-only at `B.container/.git`.
  - `.git` is a gitfile (`gitdir: X`, worktree/submodule style) -> resolve X and its `commondir`; each resolved dir that lies inside realpath(B.host) is bound read-only at its mapped container path. A gitdir outside B is not reachable through B (residual below).
  - `.git` is a symlink -> its realpath; inside B -> bound read-only at the mapped path; outside -> not reachable through B.
  - absent -> nothing (non-git projects are byte-identical to today, so no drift).
  - BUG-136 rule kept: a source that does not exist is never bound.
  - A user mount whose containerPath equals a guard path wins (guard skipped for that path, logged), so the create never fails on a duplicate destination.
- Create-time label `claude-station.git-guard=<container paths>` so drift can tell a guard bind from any other on a live container.

**How grants switch it.** `gitGuardOn(P) = gitWriteBlockEnabled() && P.settings.gitWrite?.permanent !== true`. The FEAT-164 permanent grant is project-scope, lives in the registry (which no container can reach), and is written only by the user-facing grant route, so it is a safe drift-oracle input (same rule as accounts/mounts: project scope only). Granted projects keep today's rw bind exactly.
Timed/once grants (host memory, <= 6 h) do **not** switch the bind: a bind cannot follow an expiring clock without recreating containers under live sessions. Consequence, stated: in a container project a timed grant still passes the host hook, but the in-container write then fails with "Read-only file system". Container projects need the permanent grant for agent git writes. This is a behaviour change for container projects that used timed grants today.

**Drift and recreation (BUG-214 class).**
- `driftReasons` partitions binds into guard binds (desired guard binds + live binds whose container path is in the label or equals `<rw bind>/.git`) and the rest. The rest is compared exactly as today, so no existing container gains a non-guard reason.
- A guard difference yields a reason prefixed `gitguard:`, added to `doEnsure`'s deferrable set beside `image ` and `lockdown:`. With any lease held (including boot-recovered orphan leases from `lifecycle.recover()`), the container is never removed or recreated and the launch is not refused; it runs on the current container with a log line. The guard applies at the next launch with no lease, or on Rebuild (explicit user action). The `?force=1` path is unchanged (user action).
- Mixed reasons (guard + a non-deferrable one) behave exactly as today (refused under leases).
- Drift is acted on only inside `doEnsure` (admission, manual Start, Rebuild); `statusOf` only reports. So the change itself starts no recreate: nothing happens until a launch/Start/Rebuild.
- Grant/revoke changes desired binds, so it is the same deferred `gitguard:` drift. A revoke while sessions are live leaves that container rw until its next idle launch or Rebuild. The host hook still bites immediately, as today.
- Applying at an idle launch drops the container's writable layer, exactly as the lockdown and image swaps already do.

**Portability.** Linux Docker and Docker Desktop on WSL2 (README: native Windows unsupported) both support a nested `:ro` bind over a rw bind. Paths are Linux paths; repos on `/mnt/c` bind the same. No new host tooling; Podman also supports nested ro binds. The guard is runtime-agnostic (Claude and Codex container sessions alike).

**Residuals (accepted, recorded).** The `dockerSocket` opt-in (root-equivalent, defeats every mount guard). A git repo nested below a bind root (not scanned; only the bind root's `.git` is guarded). A gitdir outside every bind that is reachable through another, non-root path of a rw user mount. Working-tree file deletion (not history; covered by snapshots). Host (direct) sessions are unchanged (ARCH-021 B / BUG-240). A stale bind if the host replaces the `.git` directory inode while the container lives: the container keeps seeing the old dir, still read-only, and a Rebuild fixes it.

**Proof bar** (persistent suite `scripts/verify-bug-244-container-git-readonly.mjs`, sandbox daemon only via `assertIsolatedDocker`, real `admitContainer` path through `lifecycle-harness`, `--tree` for the pinned HEAD tree):
- P1 ungranted: inside the container, `git commit`, `git reset --hard`, `git update-ref`, `git branch -D`, `gc --prune=now`, a write spawned from `sh -c`/`python3 -c`, and `rm -rf .git` all fail. The host repo's refs, objects, index and HEAD digest is byte-identical. Same for a rw user mount holding a repo. **Must FAIL on HEAD.**
- P2 granted (`settings.gitWrite.permanent`): commit + update-ref succeed inside and are visible on the host (regression control; passes on HEAD and after).
- P3 no live recreate: container created by HEAD code (no guard) with a held lease; under the new tree a second admission, a manual Start and a restarted-server admission all keep the container id running and are not refused, and status reports `gitguard:` drift. After all leases drain, the next admission applies the guard. A grant flip under a live lease is kept too. **Must FAIL** on a mutant tree that adds the guard bind without the deferral (a launch is refused or the container is recreated).
- Unit: a non-git project and a granted project produce byte-identical bind lists to HEAD (no churn).
- `npm run gate`; the existing desiredBinds/drift suites (FEAT-145 account, FEAT-155 workspace-root, BUG-214/218) re-run.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-08 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-08 — fixing lane r1
- **plan review + revision:** Plan review (OpenAI via scripts/dispatch.mjs, transcript 01a11a7e-6ffa-73f1-8b04-66472c5ac00c): UNSOUND, 4 blockers + 6 majors. Plan REVISED (round 1b), what changed and why:
  - B1 (idle recreate is not "next created naturally"): ACCEPTED. A `gitguard:` drift reason is now INFORMATIONAL ONLY. doEnsure strips it before every decision, so it never recreates, defers or refuses, idle or live. The overlay applies only when the container is created anyway: no container exists, another drift reason recreates it, or the user presses Rebuild. Status still reports it (drawer: "until you rebuild").
  - B3 (aliases/nested): ACCEPTED in part. Git dirs (gitdir + commondir, realpaths, wherever they live) are found for repos at every rw bind root AND one level below it. Each one is overlaid at EVERY container path through which a rw bind reaches it, so a parent dir mounted rw is covered too. Repos nested two or more levels down are an explicit reduced guarantee (residual). Removing a gitfile/symlink linkage does not destroy history (the gitdir stays read-only), so it is accepted.
  - B4 (cross-project grants): ACCEPTED. A repo is writable only if the container's project holds the permanent grant AND, when the repo is another registered project's work tree, that project holds it too. User mount at/under an overlay path, or a rw user mount of .git internals: user-declared, kept as a stated residual.
  - B2 (push): PARTLY ACCEPTED as a residual. No mount stops a network push. The container is given no host git credentials (no ~/.ssh, no SSH_AUTH_SOCK, no credential store); the suite asserts that. Credentials the user puts in the project or container env are out of scope. The host hook still applies to push.
  - M5: wording changed to "the guard adds no refusal and no destruction". Existing refusals (cli-mismatch-live, mixed non-deferrable drift) are unchanged.
  - M6: recovery and swap create through createArgs, so the overlay applies there naturally. A guard-caused swap create failure would be attributed to the image (residual; sources are exist-checked first).
  - M7: classification is by provenance: a create-time label (always written, "[]" when none, overriding any image label), or byte-identical to a wanted guard bind; never a wanted non-guard bind.
  - M8: guard tuples are host realpath + posix container path + ":ro". The suite runs repeated status cycles (incl. a symlinked project path) and expects zero drift after create. Directory binds only, so no staleFileBinds inode compare.
  - M9: timed grants inert in containers. Kept, and surfaced as a follow-up for the user (host-mediated writes or hiding timed grants for container projects). Not built here.
  - M10: fixtures rebuilt per operation. Each operation is proven to succeed AND change its target on HEAD (genuine must-FAIL). P3's must-FAIL is a mutant tree that treats gitguard as an ordinary reason.
  - ORCHARD_ALLOW_GIT_WRITE hatch dropped as an input: per-process env must not flip the drift oracle.

### 2026-10-08 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 6846e653-ac26-4001-bdbf-94a5d35ac6f5 — VERDICT: BROKEN — Nested repo named dist/build/target/venv skipped; submodule-checkout registered project Q under granted G treated as G's. OpenAI blocked twice by its cyber content filter (runs 01a11a9d…, 01a11aa1…), so verified by Claude Opus.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-08 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run e1a5f657-5ddf-460d-a87b-bf69eda64146 — VERDICT: BROKEN — Ownership by exact folder only: linked-worktree and monorepo-subfolder registered projects unlocked by a granted mounter; bare repo one level below not overlaid.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-08 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run e4c8001a-ebc4-4531-81af-26ec5f3eb3eb — VERDICT: BROKEN — Overlay path containing ':' makes docker create fail; deleted overlay source + stop/start lets Docker create a root-owned dir (BUG-136 class).. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-08 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 9914222c-aadf-4a9d-98f2-bc84a459a462 — VERDICT: BROKEN — Bare repo that is itself a rw bind root (mounted origin.git, or a bare project dir) gets no overlay; push -f / update-ref -d into it succeed.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-08 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 16d31ab3-8b4b-4ae7-ad5c-906605ed54fd — VERDICT: BROKEN — Guarded .git whose objects/ and refs/ are symlinks into the rw project tree: raw writes reach the real store through the symlinks.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-08 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 33d49218-0e2f-4fc2-8501-0300e14edd01 — VERDICT: BROKEN — r4 replace-bind path: a grant flip on a bare-root mount surfaces a non-informational missing-bind (refused live / recreated idle); a real mount change at that path hides as gitguard.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-08 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 9ff97062-9b11-407b-8af5-efe77046917b — VERDICT: BROKEN — Ownership walked only up from a registered project's folder: a repo one level below ungranted Q (q/dist, umbrella/api) writable from a granted G that mounts it.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-08 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run d79e62e2-6a85-43ef-9f05-32b938a1a92f — VERDICT: BROKEN — r7 down-walk let an ungranted umbrella/parent project claim a granted nested project's own .git (G lost its own write).. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-08 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 5c26f90e-79b2-44a4-946f-f115dbf29565 — VERDICT: BROKEN — Overlay emitted inside a deeper user mount that shadows the nested repo (<workdir>/data): Docker creates a root-owned .git in the mounted host dir.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-08 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run eecfb1d3-0c61-4359-aa63-1d0429705210 — VERDICT: BROKEN — r9 skip rule used raw path prefixes: a mount spelled <workdir>/data/ still got an overlay inside it (root-owned .git).. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-08 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run d40eea90-b9f5-44fd-ad69-c33d1de6a341 — VERDICT: BROKEN — Host-side delete + re-clone of a nested repo while the container runs: the overlay stays on the old dir, the new .git is writable, status shows no drift.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-08 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run a9180902-815b-43a1-88f6-96467694fd02 — VERDICT: BROKEN — FEAT-157 recovery branch started a stopped container (after docker cp) whose overlay source was gone: root-owned sub/.git.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-08 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 0a3940df-a409-4f4f-bc60-3a2f7cc4f057 — VERDICT: HOLDS — HOLDS on r13 after 12 BROKEN rounds. Remaining in-model residuals (recorded): repos 2+ levels below a bind root; network push. Same provider as author (OpenAI blocked by its content filter twice).. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-08 — fixing lane r1
- **built + verified:** Build + verify complete (fixing lane r1). Final design: every real git dir reachable through a container rw bind (bind root or one level below, incl. bare repos, gitfile/worktree commondir, top-level dir symlinks, every alias) is overlaid :ro unless the container's project holds the PERMANENT grant AND no ungranted registered project directly uses that repo (direct users outrank an umbrella folder). A bind root that is itself a bare repo is replaced by a :ro bind. `gitguard:` drift is informational only (never recreate/defer/refuse); `gitguard-lapsed:` (fixed access(W_OK) probe, declared in lifecycle.ts) defers like an image swap; a stopped container whose overlay source is gone is never started or docker-cp'd (missingGuardSources). Timed/once grants cannot unlock a container's .git.
  Proofs (scripts/verify-bug-244-container-git-readonly.mjs, sandbox only): matrix 6/0 — post 98/0; pinned pre-fix 28 must-FAILs, each attack shown effective on the old code; mutant (gitguard treated as ordinary drift) fails P3 live/start/restart/idle. Gate PASS. Regression: BUG-214/218 green; FEAT-102 x2, BUG-152 green; ARCH-022 authority 56/57 (the one FAIL is scripts/lib/shadow-guard.mjs, another lane's file); FEAT-145/FEAT-155-workspace-root fail at docker start on GPU CDI in the sandbox (environmental, pre-existing).
  Independent verify: 13 rounds, Claude Opus 5.5 (OpenAI refused twice by its cyber content filter). r1-r12 BROKEN, each finding fixed + regression-tested; r13 HOLDS run 0a3940df-a409-4f4f-bc60-3a2f7cc4f057 on candidate 7dfdd7d6.
  Recorded residuals: repos 2+ levels below a bind root; network push (no host git credentials are given to containers); paths with ':' or ','; symlinked FILE entries in .git; user mounts at/under an overlay path; docker-socket opt-in; a new repo created after container creation stays writable until the next natural recreate/Rebuild.
  Follow-ups for the user/orchestrator (not built): (1) timed grants are inert in containers — host-mediated writes, or hide timed grants for container projects; (2) recovery-branch recreate on a missing overlay source skips the CLI byte check (verifier note; CLI-skew property, not BUG-244); (3) a granted monorepo with an ungranted registered subfolder project loses its own write (deliberate fail-closed); (4) PRE-EXISTING, observed: lifecycle authorizeProbe's memOk (`cmd[1] === '-c'`) can never match because positionals() drops every '-…' word, so the memory probe is always refused.
  Takes effect: needs an Orchard restart to load the code (not done; never restart mid-flight); then each container gets the overlay only when next created (new container, other drift, or Rebuild) — existing containers are untouched.
  Files (unstaged): src/server/container-manager.ts, src/server/lifecycle.ts, scripts/verify-bug-244-container-git-readonly.mjs, scripts/fixtures/bug-244/pre-container-manager.ts.pin, package.json (verify:bug-244 line), docs/CONVENTIONS.md (BUG-244 paragraph), this ticket.

### 2026-10-11 — landed in batch commit (orchestrator triage)
- Work landed in the 2026-10-11 whole-tree batch commit. Verified state unchanged; this entry records only the git landing. Full batch manifest is in the commit message.

### 2026-10-11 — worker (FEAT-164 fixing)
- **Note:** Coordination from FEAT-164 (fixing, 2026-10-11), for the lane building container rebuild on grant change: settings.gitWrite becomes { commit, push, scope, release } (legacy { permanent:true } is still read). The ONE rule is scripts/lib/agent-git-policy.mjs normalizeGitWrite(raw).mode, one of none, scoped or release. FEAT-164 is changing gitGuardOn to: guard ON unless mode === 'scoped' (one line in container-manager.ts). Release mode keeps the .git overlay ro, which is the structural half of soft releases. So a rebuild trigger should compare that mode, not .permanent. Detail in FEAT-164's plan.
