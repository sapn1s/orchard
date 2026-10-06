```orchard-ticket
{
  "id": "BUG-223",
  "type": "bug",
  "title": "Test suites reach the host Docker daemon; sandbox isolation is opt-in",
  "summary": "Three anti-regression suites built a base image, a CLI layer and six containers on the HOST Docker daemon instead of the sandbox. None touch Docker directly — they start scratch Orchard servers that build containers for them. The guard assertIsolatedDocker() protects only a suite that calls it, so a suite reaching Docker indirectly runs unprotected.",
  "impact_if_we_wait": "Any lane running a suite that starts an Orchard server can create, run and remove containers on the live host daemon, racing the user's live projects — the BUG-216 blast radius, through a path no per-suite guard covers. This run's objects escaped only by owner-key cleanup luck.",
  "current_need": "Decide: authorise a dispatch-broker.ts fix for the stale-project break (r5 P3/P2), then a round-6 attacker on properties 2-3.",
  "severity": "high",
  "area": "test docker isolation",
  "reported": "2026-09-30",
  "reported_by": "agent",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-10-01",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A suite reaching Docker only through a scratch Orchard server lands every container, image, network and volume in the sandbox, with no line added.",
    "A suite that must use the host daemon opts OUT explicitly, and that is the only path to the host.",
    "Must-FAIL: a suite that never calls assertIsolatedDocker builds on the host daemon pre-fix and in the sandbox post-fix."
  ],
  "code_refs": [
    {
      "path": "scripts/lib/docker-sandbox.mjs"
    },
    {
      "path": "scripts/dispatch.mjs"
    },
    {
      "path": "scripts/lib/station-boot.mjs"
    },
    {
      "path": ".claude/agents/worker.md"
    }
  ],
  "related": [
    {
      "id": "FEAT-158",
      "relation": "see_also"
    },
    {
      "id": "BUG-216",
      "relation": "see_also"
    },
    {
      "id": "FEAT-157",
      "relation": "see_also"
    },
    {
      "id": "FEAT-131",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "0cb9332d-b851-4ab6-808f-d10a4d7029cf",
      "verdict": "broken",
      "verdict_on": "2026-10-01",
      "recorded_at": "2026-10-01T12:29:26.280Z",
      "author": "BUG-223 fix lane",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Round-1 attacker, two-break STOP. Break 1 (nested checkout not redirected): fixed, repro re-run hits sandbox. Break 2 (pre-fix CLI adopted after restart keeps host): mitigated by loud adoption warning only. Round 2 not run."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "5d1ff1c9-a26b-477a-9148-753cdf8db6f6",
      "verdict": "broken",
      "verdict_on": "2026-10-01",
      "recorded_at": "2026-10-01T20:42:12.003Z",
      "author": "BUG-223 r2 verify lane",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Round-2 jailed attacker (host socket = tripwire), two-break STOP. A: lane-booted server with own XDG_STATE_HOME ran sandbox up on HOST. B: symlinked checkout unclassified, session on HOST. Both fixed in lane-docker.mjs; repros PASS."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "22193cde-7a1b-4f35-9f42-d438252fcaae",
      "verdict": "broken",
      "verdict_on": "2026-10-01",
      "recorded_at": "2026-10-01T21:05:02.756Z",
      "author": "BUG-223 r3 fix lane",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Round-3 jailed attacker vs inherited-declaration redesign, two-break STOP. Both breaks in TOP-LEVEL shape derivation (claim 1): project rooted inside a checkout subdir; scan-budget exhaustion. Inherited \"host\" mark then pins descendants. Inheritance claims 2-4 held. B1 re-run here: HOST."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "47d7cd92-90b4-4de8-8f70-fc1e7b8ebd30",
      "verdict": "broken",
      "verdict_on": "2026-10-01",
      "recorded_at": "2026-10-01T21:39:34.876Z",
      "author": "BUG-223 r4 fix lane",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "Round-4 jailed attacker vs declared laneDocker setting, two-break STOP. Both break claim 2 (initial value a stale host snapshot): scratch registered on an empty dir; repoint keeps host. Both fixed (empty dir -> sandbox; repoint ratchets to sandbox); repros now SANDBOX."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "2f0e8008-4ef8-4c70-8bda-e3de1032b566",
      "verdict": "holds",
      "verdict_on": "2026-10-01",
      "recorded_at": "2026-10-01T21:53:25.051Z",
      "author": "BUG-223-r5-verify-lane",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "r5 property 4 (drawer+API refuse invalid laneDocker): jailed attacker; PATCH/PUT/POST flat+nested bad values all 400 and unstored; session overrides fatal; drawer driven in headless Brave, session scope disabled for real."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "f63724a4-d591-499d-9184-6a8fee984b00",
      "verdict": "broken",
      "verdict_on": "2026-10-01",
      "recorded_at": "2026-10-01T21:53:26.856Z",
      "author": "BUG-223-r5-verify-lane",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "r5 property 1 (empty dir starts sandbox): 2 breaks - unlistable empty dir (0333) classified host; scratch delete+re-ensure re-classified leftovers to host. Both fixed (lane-docker, registry); repros now SANDBOX, 0 session tripwire lines."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "25846b56-fbdd-4fe5-b6bd-e5ca2f1c619e",
      "verdict": "broken",
      "verdict_on": "2026-10-01",
      "recorded_at": "2026-10-01T21:53:28.675Z",
      "author": "BUG-223-r5-verify-lane",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "r5 property 2 (repoint only toward sandbox): repoint itself held; 2 breaks via path lookup - scratch-dir repoint makes 2 rows on one path (first-match host; FIXED in lane-docker), stale broker project after repoint (OPEN, needs dispatch-broker.ts)."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "45d06dff-352b-489a-bb7f-a6bbcc3c8f65",
      "verdict": "broken",
      "verdict_on": "2026-10-01",
      "recorded_at": "2026-10-01T21:53:30.410Z",
      "author": "BUG-223-r5-verify-lane",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "r5 property 3 (laneDockerEnv reads only the declaration, never host on unknown/malformed): 1 break - dispatch broker keeps the stale project after a repoint, so a sandbox lane reads the host row now at its old path. OPEN; fix is in dispatch-broker.ts."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "85b888c3-76eb-4be8-8d79-58544b62e4fc",
      "verdict": "holds",
      "verdict_on": "2026-10-01",
      "recorded_at": "2026-10-01T22:17:38.573Z",
      "author": "BUG-223 r6 fix lane",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "r6 property 2 (repoint toward sandbox only; no launch from old path): jailed attacker, 0 tripwire lines, pure-function level only (no scratch server). Unexecuted: direct-session launch decides by path (agent-bridge.ts:1783) across an await."
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "d3ad67f3-f25e-48b0-819a-3a173b6707d4",
      "verdict": "holds",
      "verdict_on": "2026-10-01",
      "recorded_at": "2026-10-01T22:17:40.417Z",
      "author": "BUG-223 r6 fix lane",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "r6 property 3 (asking project's declaration only; unknown/deleted/malformed never host): jailed attacker, 0 tripwire lines. 27 malformed shapes x3 readers all sandbox; registry cut at 310 offsets: sandbox or refusal. No end-to-end server run."
    }
  ],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": false,
    "Verification plan": true,
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

# BUG-223 — Test suites reach the host Docker daemon; sandbox isolation is opt-in

## Symptom
A lane's anti-regression suites created container objects on the live host Docker daemon while the FEAT-158 sandbox sat idle beside them. The three suites — `verify-decisions`, `verify-runtime-decision`, `verify-mcp-attach` — were run without `DOCKER_HOST` pointing at the sandbox. Each starts a scratch Orchard server; each server, seeing a project whose default isolation is `container` (FEAT-131), built a `claude-station-base:v1` image and a CLI layer and started five containers plus a build container. All of it on the host daemon.

## Evidence
FEAT-157 Activity log, 2026-09-30, entry "fixing, round 1 — INCIDENTS (mine, contained)": the containers `claude-station-decisions`, `-bug035-selective/-broken/-healthy`, `-decision-fixture`, `-rtbuild-...` and images `claude-station-rt:*`, `claude-station-base:v1-u1000-g1000` were created on the host daemon and removed afterward by exact owner key. No live container was touched only because the scratch servers refuse foreign containers and removal was keyed to each scratch data dir's owner id — not because anything stopped them reaching the host daemon.

## Diagnosis
`assertIsolatedDocker()` (`scripts/lib/docker-sandbox.mjs`) is the sandbox guard, and it is opt-in: a suite is protected only if its own code calls it. The suites in this incident never call it, and correctly so by the current contract — they do not touch Docker in their own code. They touch it two layers down, through a scratch Orchard server that builds and runs containers on their behalf. The guard's polarity is the defect: isolation is granted per suite that knows it is a container suite, but the failure is precisely the suite that does NOT know it is one.

## Fix design (recommended: default-deny at the lane boundary, with an explicit host opt-out)
Set `DOCKER_HOST` (and the sandbox lock env) to the standing sandbox at the process boundary where a lane is launched — `scripts/dispatch.mjs` / the worker launch path — after ensuring the sandbox is up (`sandbox:docker up`). Every child the lane spawns, including a scratch Orchard server and every `docker` it shells out to, inherits it. A suite that must reach the host daemon (GPU/CDI, host `/proc`) sets an explicit opt-out env and remains the ONLY path to the host, cleaning up through `owned-docker.mjs` as today.

Why this over the other candidate — a shared test bootstrap that every container suite imports and that calls a default-deny guard: that keeps the same opt-in polarity one level up. It still relies on a suite knowing it is a container suite and importing the bootstrap, which is exactly the knowledge the incident suites lacked (and it cannot cover a non-suite entry point — an ad-hoc `node -e`, a REPL, a future script). Setting the daemon at the lane boundary defends the unknowing case structurally: code that never mentions Docker still cannot reach the host, because the only daemon it can see is the sandbox. The cost is that the sandbox must be ensured-up before a lane runs and the host opt-out must be honored by the rare host-required suite; both are already FEAT-158 mechanisms.

Corollary to record in `docs/CONVENTIONS.md` once built: a dispatched lane inherits the sandbox daemon by default; reaching the host daemon is the explicit exception, not the default.

## Verification plan
Must-FAIL against a pinned pre-fix state: a suite that starts a scratch Orchard server with a container-isolation project and never calls `assertIsolatedDocker()` builds on the host daemon (pre-fix) and in the sandbox (post-fix), asserted by the daemon id the objects landed on. Anti-regression: FEAT-158's own suite, and a host-required suite still reaches the host through its explicit opt-out.

## Notes
Filed by the FEAT-157 strip lane (2026-09-30). This is the Docker half of the FEAT-157 round-1 incident; the sibling half — a copied tree's `node_modules` symlink letting a suite mutate the live SDK and block host sessions for 11 minutes — is a separate concern (every copied tree needs a real reflink `node_modules`, never a symlink) and is not covered here.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-30 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-01 — agent
- **fixing, round 1:** **fixing, round 1 (claude-opus-5-5 lane) — built; independent attacker BROKEN 2/2, both answered, a round-2 attacker is warranted.**

  Launch points (checked against the code, plus this lane's own environment as the real example):
  - Direct session spawn: `agent-bridge.ts` computes `laneDockerEnv(project)` and passes it as a new `RuntimeStartConfig.dockerEnv`. `claude-runtime.ts` and `codex-runtime.ts` merge it into their spawn-env COPY. Both paths are covered: the SDK spawn and the survival/session-host path (survival.ts spreads the SDK env into the scope).
  - In-process subagents share the CLI process env. Evidence from this lane: CLAUDE_PID=3848533 is the parent CLI, and ORCHARD_GIT_SHIM_DIR is present, which is set at the same boundary. So the session boundary covers them. Bash, scripts/dispatch.mjs, independent-verify and the scratch servers they boot all inherit it.
  - NOT covered by the session env: the server-side dispatch broker (`dispatch-broker.ts` spawned dispatch.mjs with the server's `{...process.env}`). It now applies the same rule.
  - Codex runtime: it ignores `config.env` (it never received the ORCHARD_DISPATCH_* env). That is pre-existing and out of scope, so only `dockerEnv` is merged there.

  Rule, in `scripts/lib/lane-docker.mjs` (new; types in `.d.mts`):
  - A project is covered if its root carries `scripts/lib/docker-sandbox.mjs`, if it contains the server's own checkout at any depth, or if it holds a checkout 1–2 levels below its root (bounded scan, at most 4000 dirs, skips dot-dirs and node_modules; measured 0.02–31 ms on the real registry).
  - Covered projects get `DOCKER_HOST=<sandbox socket>` and `ORCHARD_LANE_DOCKER=sandbox`. Otherwise nothing changes.
  - The opt-out:
    - In a suite: `useHostDocker(reason)`. It needs a reason, logs to stderr and `<state>/docker-sandbox/host-optouts.jsonl`, and marks the env with ORCHARD_DOCKER_HOST_OPTOUT, so a scratch server under it launches host sessions too.
    - In a shell: `eval "$(npm run -s sandbox:docker -- host-env '<reason>')"`.
    - The FEAT-158 destructive guard still refuses under the opt-out.
  - If the sandbox is down, docker calls fail and never fall back to the host. `ensureSandboxUp()` runs `sandbox:docker up` in the background, deduped, so a session start never blocks.
  - Unchanged: the server's own env; container sessions (`docker exec` uses the server env, and DOCKER_HOST is not in ENV_PASSTHROUGH; container-manager.ts and index.ts are not touched); projects without a checkout.
  - The GPU suite (`verify-feat-gpu-env-mem.mjs`) now calls `useHostDocker`.
  - CONVENTIONS.md has the new corollary paragraph.

  Proof: `scripts/verify-bug-223-lane-docker.mjs` (`npm run verify:bug-223`). Every check is graded by daemon id: host 3cdcf1c8…, sandbox 2c805f30….
  - It uses a real scratch server with the live server's Docker env, the real bridge and survival path, and a fake CLI. The fixtures are synthetic: a scratch dir holding a copy of docker-sandbox.mjs.
  - MUST-FAIL on the pre-fix wiring: 3/6 (part A only) and 13/16 (full suite).
    - A1: the session process, its inheriting grandchild, and a labelled probe volume all landed on the HOST. The volume was removed by exact name; afterwards 0 probe volumes on either daemon.
    - C1: the broker lane reached the HOST.
    - D1: the codex runtime child reached the HOST.
  - POST-FIX: 27/27.
    - Session, grandchild and volume land in the sandbox.
    - The home-dir shape (A4) is covered.
    - A plain project keeps the host.
    - The server process has no DOCKER_HOST, and its docker reaches the host.
    - The opt-out reaches the host, its children stay there, it is logged, and a missing reason is refused.
    - Sandbox down: the call fails with no host fallback.
    - The broker lane reaches the sandbox, and a plain project's broker lane reaches the host.
    - The codex child reaches the sandbox.
    - exec argv carries no DOCKER_HOST.
    - Coverage F1–F7.
  - Shell opt-out executed: the host id was printed and logged.

  Anti-regressions:
  - verify-feat-102-dispatch-broker: 25/25.
  - verify-bug-146-conventions-inject: 22/22. verify-local-conventions: 18/18.
  - Same result on a pinned pre-fix copy of the tree, so not regressions (environmental):
    - verify-feat-135-active-e2e: 7/8. The control inherits this lane's own ORCHARD_GIT_SHIM_DIR.
    - verify-feat-135-codex-active-e2e: 0/2. It needs a real codex model run.
    - verify-feat-126-e2e: FATAL "no start ack". runtime-check-pending on a fresh server.
  - NOT run: verify-feat-158-docker-sandbox. It cycles down/up and resets the SHARED sandbox under other lanes. Its library `scripts/lib/docker-sandbox.mjs` is byte-identical to pre-lane (cmp). Guard sanity: it accepts the lane env and refuses the opted-out env.

  Independent attacker: separate process, `dispatch.mjs --provider anthropic --model claude-opus-5-5`, clean room (docs/CLAUDE.md/.claude stripped), lane env DOCKER_HOST=sandbox, run id 0cb9332d-b851-4ab6-808f-d10a4d7029cf. Verdict BROKEN; it hit the two-break STOP. Its fixer-test run: 19/19.
  - Break 1: a project that holds a checkout below its root (the live registry's home-directory project, `~`) was not redirected. FIXED with the containing-checkout rule and the bounded scan. The attacker's own repro, re-run on the fixed code, now reaches the SANDBOX. Suite A4 and F2/F4 cover it.
  - Break 2: a CLI launched before this rule and adopted after a restart keeps the host. A running process's env cannot change, so this is MITIGATED, not fixed. Adoption reads the CLI's /proc environ and, on a mismatch, logs and emits a session status line ("…still reach the HOST daemon until the session is restarted"). The attacker's repro, re-run: still HOST, and the warning appeared in the fixed server's log.

  Known limits:
  - Code that names the host itself: a hand-built env without DOCKER_HOST, `docker -H`/`--context`, a direct socket dial.
  - A checkout 3 or more levels below a project's root that is not the server's own.
  - Unguarded suites now share the sandbox without the lock, so a guarded `reset`/`down` can disrupt them mid-run. That is a test failure, not host damage.
  - A lane-booted server with a non-default XDG_STATE_HOME runs a no-op `up` against the host-side sandbox container.
  - Not tested (attacker list): the real CLI's tmux teammates and MCP env; a sandbox restart; a live-server restart.

  regressed-from: none. FEAT-158 shipped the guard opt-in; this is that gap, not a regression.

  Files:
  - New: scripts/lib/lane-docker.mjs, scripts/lib/lane-docker.d.mts, scripts/verify-bug-223-lane-docker.mjs.
  - Edited: src/server/agent-bridge.ts, src/server/dispatch-broker.ts, src/server/runtime/runtime.ts, src/server/runtime/claude-runtime.ts, src/server/runtime/codex-runtime.ts, scripts/docker-sandbox.mjs, scripts/verify-feat-gpu-env-mem.mjs, package.json, docs/CONVENTIONS.md.
  - Gate: `npm run gate` exit 0.
  - Lane scratch: ~/.local/state/claude-station/scratch/bug223/. It holds pre/ copies, logs, the attacker charter and report, and the room.

  DECISIONS for the orchestrator:
  1. Scope. This build covers only projects that hold an Orchard checkout. The user's other direct projects (at least three carry docker/compose files) keep the host, because redirecting them would move the user's own compose stacks into the sandbox. Redirecting every direct project is a product decision.
  2. Deploy. Sessions that are live at the restart (including the orchestrator's) keep the host until they are restarted (break 2).
  3. Commission a round-2 clean-room attacker against the round-1 fixes.

### 2026-10-01 — BUG-223 fix lane
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 0cb9332d-b851-4ab6-808f-d10a4d7029cf — VERDICT: BROKEN — Round-1 attacker, two-break STOP. Break 1 (nested checkout not redirected): fixed, repro re-run hits sandbox. Break 2 (pre-fix CLI adopted after restart keeps host): mitigated by loud adoption warning only. Round 2 not run.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-01 — BUG-223 r2 verify lane
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 5d1ff1c9-a26b-477a-9148-753cdf8db6f6 — VERDICT: BROKEN — Round-2 jailed attacker (host socket = tripwire), two-break STOP. A: lane-booted server with own XDG_STATE_HOME ran sandbox up on HOST. B: symlinked checkout unclassified, session on HOST. Both fixed in lane-docker.mjs; repros PASS.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-01 — BUG-223 r2 verify lane
- **Note:** **verifying, round 2 (claude-opus-5-5 lane) — jailed attacker BROKEN 2/2 (two-break STOP); both fixed in scripts/lib/lane-docker.mjs; round-3 attacker or a class decision needed.**

  Live check: this lane's own `docker info` printed 2c805f30-ad5e-41c3-b6d1-c9a17d4e2444 (the sandbox; host is 3cdcf1c8…), with DOCKER_HOST at the sandbox socket and ORCHARD_LANE_DOCKER=sandbox. So the post-restart launch path is live.

  Attacker: dispatch.mjs, anthropic/claude-opus-5-5, run 5d1ff1c9-a26b-477a-9148-753cdf8db6f6, clean room (repo strip: docs/ removed, boot stubs seeded; diff of the BUG-223 files only, no ticket). Provider: openai had quota headroom, but its codex sandbox refuses `listen`, and this attack needs scratch servers, so anthropic was used. Jail: bwrap with a private pid ns and /proc; /run/docker.sock bind-mounted to a TRIPWIRE that answers `info` with ID HOST-TRIPWIRE-… and logs every request; the dispatch socket was masked and ORCHARD_DISPATCH_* was unset. So "reached the host" = tripwire id or a log line, and the real host was unreachable. The attacker's process died mid-way through running the fixer suite: survival's systemd scope cannot reach the user bus from the pid ns. That is a jail artefact, and its report message was lost; its breaks were harvested from its transcript, and both were re-executed here.

  - Break A (claim 1; normal code, not code naming the host). A lane boots a scratch server with its own XDG_STATE_HOME. sandboxPaths() derives a socket that does not exist, ensureSandboxUp() judges the sandbox down, and it runs `sandbox:docker up` with hostDockerEnv. Tripwire lines: GET containers/orchard-docker-sandbox, GET volumes/…, POST volumes/create. On the real host this means inspecting and `start`ing the sandbox container and taking the shared sandbox lock. The sessions themselves failed with no host fallback. Round 1 had listed this as a "no-op up" known limit; it is a lane reaching the host without the opt-out.
  - Break B (claim 1; coverage). A project holding the checkout through a SYMLINKED dir (`proj/orchard -> ../ext/orchard`) was not classified, because Dirent.isDirectory() is false for a symlink. Under a live-like server its session reached HOST-TRIPWIRE. The real-directory control reached the sandbox.
  - CLASS shared by A and B: each launch point RE-DERIVES the lane's daemon from local, perturbable inputs (filesystem shape, the XDG state env) instead of inheriting the decision the lane was born with. Any input that is not modelled flips the result to the host.

  Fixes (scripts/lib/lane-docker.mjs only):
  - (A) A launcher whose own env already names a daemon (DOCKER_HOST set, i.e. a server booted inside a lane or by a guarded suite) passes THAT daemon to its sandboxed sessions. ensureSandboxUp() never runs `up` from such a launcher; it logs and returns 'inherited-down'. A DOCKER_HOST naming a well-known host socket is never inherited.
  - (B) The nested scan follows symlinked directories, still bounded by depth and budget.
  - The live server has no DOCKER_HOST (read from its /proc environ), so it is unaffected.

  Proof (synthetic fixtures, run in the jail; repro at ~/.local/state/claude-station/scratch/bug223-r2/repro/r2.mjs):
  - MUST-FAIL on the round-1 code: A FAIL (8 tripwire lines, the `up` host calls) and B FAIL (session id HOST-TRIPWIRE).
  - POST-FIX: A PASS and B PASS (session id 2c805f30…, 0 tripwire lines).
  - Unit controls 12/12: host-socket DOCKER_HOST not inherited; opt-out still wins; plain project not applicable; dangling symlink and symlink cycle bounded; symlink-to-file ignored; inherited-down makes no host contact.
  - Real registry, all 20 projects, pre vs post classification: 0 decisions changed; scans 0.0–8 ms.

  Anti-regressions:
  - verify-bug-223-lane-docker: 27/27, in the jail with CLAUDE_STATION_SURVIVE=0. With survival on, A1/A2/A4 fail in the jail only: systemd-run --scope cannot reach the user bus from a pid ns, a jail artefact.
  - verify-feat-102-dispatch-broker: 25/25.
  - npm run gate: exit 0.

  Not covered:
  - Durability: the repro is not yet folded into verify-bug-223-lane-docker.mjs, which is outside this lane's file scope.
  - Hypotheses not executed: a project rooted INSIDE a checkout subdir (the marker check does not walk up); MCP-server/hook env from the real CLI (tools.ts/browser.ts build `env: {}` for MCP servers, unexecuted); survival-path inheritance under the new value (the wiring is unchanged).
  - tmux is not installed, so CLI teammates are unreachable here.

  regressed-from: none (round-1 gaps).

  DECISIONS:
  1. Class: the two breaks share "re-derived, not inherited". Either accept per-input fixes plus a round-3 attacker, or redesign so the lane decision is carried explicitly (e.g. the marker env is authoritative everywhere downstream).
  2. A round-3 clean-room attacker is warranted (session-lifecycle / host-safety).

### 2026-10-01 — BUG-223 r3 fix lane
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 22193cde-7a1b-4f35-9f42-d438252fcaae — VERDICT: BROKEN — Round-3 jailed attacker vs inherited-declaration redesign, two-break STOP. Both breaks in TOP-LEVEL shape derivation (claim 1): project rooted inside a checkout subdir; scan-budget exhaustion. Inherited "host" mark then pins descendants. Inheritance claims 2-4 held. B1 re-run here: HOST.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-01 — BUG-223 r3 fix lane
- **Note:** **fixing, round 3 (claude-opus-5-5 lane): built the inherited-declaration redesign. Must-FAIL is proven and the suite passes 40/40. The jailed round-3 attacker returned BROKEN 2/2 (two-break STOP). Both breaks are in the top-level shape derivation, and the inherited `host` mark amplifies them. Needs a scope decision.**

  Hypothesis check (the charter's reading): it holds, with one correction. The session-spawn decision is computed in agent-bridge.ts, which calls `laneDockerEnv()`; the runtimes only merge `config.dockerEnv`. Because the decision lives in lane-docker.mjs, the redesign needed no agent-bridge.ts edit and no runtime edit. The broker calls the same function.

  Design:
  - The decision is made ONCE, by the owner: the top-level process (nothing inherited, which means the live server, whose /proc environ carries no mark), or an explicit `useHostDocker` opt-out.
  - The owner stamps it as `ORCHARD_LANE_DOCKER=<sandbox socket URL>|host|host-optout` beside DOCKER_HOST.
  - `laneDockerEnv()` reads an inherited declaration first and returns it verbatim. Only when nothing is inherited does it derive from the project's shape; the round-2 symlink scan is kept for that top-level case.
  - The round-2 "inherit DOCKER_HOST" rule (`inheritedDaemon`) is removed, so DOCKER_HOST is no longer a second source.
  - Unusable declarations fail CLOSED to `unix:///nonexistent/...`: garbage, a relative path, a well-known host socket, or legacy `sandbox` without a usable DOCKER_HOST. Legacy `sandbox` plus DOCKER_HOST (rounds 1–2, the live lanes) is read as that socket.
  - Self-apply: loading lane-docker.mjs makes a process obey its inherited declaration (`process.env.DOCKER_HOST := declared`). So a scratch server whose parent dropped DOCKER_HOST still uses the sandbox for its OWN docker calls. A process with no mark is untouched.
  - `ensureSandboxUp()` runs `sandbox:docker up` only when nothing is inherited. Under a declaration it only probes the declared daemon.
  - Sandbox CLI under an inherited sandbox declaration:
    - `up` is a no-op if the declared daemon answers; otherwise it is REFUSED (exit 2).
    - `down` is REFUSED.
    - `env` and `status` print the declared daemon and do not contact the host.
    - `reset` targets the declared daemon.
    - `env` and `up` now also print the `ORCHARD_LANE_DOCKER` declaration.

  Proof: `scripts/verify-bug-223-lane-docker.mjs` gains part G (G0 unit checks; G1–G6 run real processes in a bwrap jail whose /run/docker.sock is a tripwire). The fixtures are synthetic. G1 and G2 are the round-2 repro (r2.mjs) folded in; G3 is the new "nested server, shifted layout" case: DOCKER_HOST dropped, own XDG_STATE_HOME, an Orchard-shaped project plus a plain one.
  - MUST-FAIL, run on pinned tree copies under scratch/bug223-r3/t1 and t2:
    - Round-1 tree: 1/9. G1 FAIL (8 tripwire requests, the `up` on the host). G2 FAIL. G3 FAIL (14 requests). G4 and G5 FAIL.
    - Round-2 tree: 3/9. G1 and G2 PASS. G3 FAIL ×3 (14 requests; sessions failed or reached the host). G4 FAIL. G5 FAIL.
    - G6 passes on all trees (a control).
  - POST-FIX: G 13/13; full suite 40/40 (A–G, survival path live for A).

  Anti-regressions:
  - verify-feat-102-dispatch-broker: 25/25.
  - board:check: OK (no drift).
  - `npm run gate`: exit 1. The FAIL is typecheck only: 35 errors, all in src/server/container-manager.ts (29), index.ts (5) and agent-bridge.ts (1). These are the ARCH-022 lane's in-flight files; my files have 0 errors. Leak-gate passed.

  Attacker: dispatch.mjs, anthropic/claude-opus-5-5, session 22193cde-7a1b-4f35-9f42-d438252fcaae.
  - Setup: clean room (docs stripped, boot stubs seeded, no ticket), with BUG223-change.diff and BUG223-round3-delta.diff. Jailed in bwrap with the host socket as a tripwire and the dispatch socket masked. Lane env: DOCKER_HOST and ORCHARD_LANE_DOCKER set to the sandbox socket.
  - Room defect: the room as shipped could not boot a server, because container-manager.ts imports exports that service-manager.ts lacks (ARCH-022 in flight). The attacker stubbed them in its own copy. Its fixer-suite run there: 40/40, with G's nested jail working.
  - Break 1 (claim 1, real): a project rooted INSIDE a checkout subdir (`tree/docs`) lands on the HOST, with mark `host` and the tripwire id for both the session and its grandchild. The marker check does not walk up. Re-executed here in the jail: same result (+4 tripwire requests).
  - Break 2 (claim 1, real): a home-shaped project with 4101 dirs listed before `projects/orchard` exhausts the 4000-dir scan budget, so it lands on the HOST. Its scratch server then launches even the checkout's session on the HOST, because the inherited `host` mark pins descendants. Under round 2 that nested session would have re-derived to the sandbox, so this amplification is new in round 3.
  - Class: the top-level derivation from project SHAPE is incomplete, and round 3 makes its output binding for the whole subtree.
  - Inheritance claims 2–4 held: env scrubbers, CLI, fail-closed, self-apply. Hypotheses it did not execute: broker gives the same result; a tcp:// or hard-link declaration (names the host).

  regressed-from: none. Both breaks exist under round 2 too. The amplification in break 2 is mine.

  Known limits:
  - Read-only host `info` probes by the FEAT-158 guard.
  - verify-feat-158-docker-sandbox, run from a lane, now has its `down`/`up` REFUSED unless it opts out. Its `base` env keeps the mark. This suite is outside my scope, and the fix is a one-line `useHostDocker`.
  - docs/CONVENTIONS.md's BUG-223 paragraph does not yet describe the declaration. It is outside my scope.

  Files:
  - Edited: scripts/lib/lane-docker.mjs, scripts/lib/lane-docker.d.mts, scripts/docker-sandbox.mjs, scripts/verify-bug-223-lane-docker.mjs.
  - Not edited: agent-bridge.ts, the runtimes, dispatch-broker.ts.
  - Pre copies and WIP are in ~/.local/state/claude-station/scratch/bug223-r3/ (pre/, work/, room/atk, attack-out.txt).

  DECISIONS:
  1. Scope (the remaining class). Under ARCH-010 the fix is to make the owner's scope a DECLARED per-project fact, not a scanned one. One way: a project setting `docker: sandbox|host`, defaulting to sandbox for direct projects, with host as an explicit per-project choice for the user's compose projects. Patching the scan (walk up, raise the budget) is the surface-patching ARCH-010 rejects. This choice belongs to the user or orchestrator.
  2. Interim: stamp `host` (current; binding, as charter) vs stamp nothing for plain projects (re-derivation below, as round 2).
  3. A one-line `useHostDocker` in verify-feat-158 (other owner).

### 2026-10-01 — BUG-223 r4 fix lane
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 47d7cd92-90b4-4de8-8f70-fc1e7b8ebd30 — VERDICT: BROKEN — Round-4 jailed attacker vs declared laneDocker setting, two-break STOP. Both break claim 2 (initial value a stale host snapshot): scratch registered on an empty dir; repoint keeps host. Both fixed (empty dir -> sandbox; repoint ratchets to sandbox); repros now SANDBOX.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-01 — BUG-223 r4 fix lane
- **Note:** **fixing, round 4 (claude-opus-5-5 lane): built the orchestrator's decision. Which Docker a project's sessions and lanes use is now a DECLARED per-project setting, `settings.laneDocker: 'sandbox' | 'host'`. The real registry is classified and backed up. Suite 56/56. Must-FAIL proven on the round-3 tree. The jailed round-4 attacker returned BROKEN 2/2. Both breaks are fixed and their repros now land in the sandbox. One residual class needs a decision.**

    Hypothesis (laneDockerEnv can read the setting without an agent-bridge.ts change): HOLDS. agent-bridge.ts already passes `opts.project.hostPath`. `laneDockerEnv()` looks that path up in the registry this process serves (`registryFile()`; hostPath is unique per registry) and reads `settings.laneDocker`. It does this on every call, so a flip applies to the next session or lane with no restart. No edit to agent-bridge.ts, dispatch-broker.ts or the runtimes.

    Design:
    - At the top level, `laneDockerEnv()` reads the setting and never scans. Verified with a counter: 0 directory listings over 5 calls, one of them the home dir. A control confirms the counter does see a classification scan.
    - `sandbox` gives DOCKER_HOST plus ORCHARD_LANE_DOCKER=<socket>. `host` gives ORCHARD_LANE_DOCKER=host.
    - An undeclared row, an unregistered path or an unreadable registry fails safe to the sandbox, with a warning.
    - Round-3 inheritance is unchanged: decided once at the top, inherited below.
    - The initial value is set once, at registration (`createProject` and `ensureScratchProject`), by `classifyLaneDocker`. It is `sandbox` if the project holds an Orchard checkout: marker at its root or in an ancestor, the server's checkout inside it, or a checkout 1–2 levels down. It is also `sandbox` if the directory is empty or the scan is inconclusive. Otherwise it is `host`. An explicit value in the create request wins.
    - A repoint moves a project only toward the sandbox, and only if the new directory classifies as sandbox. A repoint never moves a project to host.
    - PATCH accepts exactly `sandbox` or `host` (anything else is a 400).
    - `npm run lane-docker:classify` (scripts/classify-lane-docker.mjs) is the one-time migration. It is idempotent, never overwrites a declared value, backs up first, and re-reads before writing.

    Classification of the real registry (all 20 projects). It matches today's round-3 scan on every row (0 diffs, compared against the pinned pre-lane lane-docker.mjs). Only `laneDocker` changed. Backup: ~/.local/share/claude-station/registry.json.bak-bug223-2026-10-01T21-29-48-073Z (restore it to revert). After the write, the reader returns the same decision for every row.
    - `sandbox` (2): the Orchard checkout project (its root carries the marker) and the home-directory project (it contains the checkout).
    - `host` (18): the scratch project, a leftover test-fixture project, and 16 of the user's own projects (5 of them container-isolation).
    - The per-project table (names are private, kept off this public board) is in scratch/bug223-r4/classify-real.txt.

    Proof (`npm run verify:bug-223`). Fixtures are synthetic. A/G/H run real scratch servers and a fake CLI. G and H are jailed with the host socket as a tripwire.
    - MUST-FAIL on a pinned round-3 tree (scratch/bug223-r4/t-r3): 41/51, FAIL ×10.
      - H1 (r3 break 1, project inside a checkout subdir) and H2 (r3 break 2, home dir past the scan budget): the session and its grandchild reached HOST-TRIPWIRE with mark `host`. 14 tripwire requests, including volumes/create. The PATCH was refused with 400.
      - H3: a checkout-shaped project declared host still got the sandbox.
      - H4: a plain project declared sandbox still got the host.
      - G0f–G0i fail. G0i showed 22 directory listings.
      - F8/F9: the classifier did not exist yet.
    - POST-FIX: 56/56, with the survival path live for A.
      - New checks: A5/A6 (the round-4 breaks), F8–F11, G0c/G0f–G0i, H1–H4.
      - G2/H grade lane requests only. The top-level server's own read-only `GET /containers/json?label=claude-station=1` boot listing now reaches the tripwire. That listing is the server's own host docker, which claim 5 keeps by design. It is new since round 3 and comes from in-flight server code, not this change.

    Settings drawer: Settings → Isolation & environment → "Docker daemon for sessions and lanes", with a Sandbox|Host toggle and a note per state. For a container project the note says it applies to dispatched lanes only. An undeclared project shows "Not chosen yet, so the sandbox is used". In session scope the toggle is disabled with a note. It was driven in headless brave over a scratch server holding a COPY of the real 20-project registry.
    - Clicking host→sandbox→host on one of the user's host projects changed the registry on disk each time. A bad value was refused with 400. The one console error is a navigation-aborted refreshProcs fetch from the harness.
    - Screenshots in scratch/bug223-r4/shots/: bug223r4-{sandbox,host}-{dark,light}.png, -container-dark, -undeclared-light, -flipped-sandbox-light.

    Attacker, round 4: anthropic/claude-opus-5-5, run 47d7cd92-90b4-4de8-8f70-fc1e7b8ebd30, verdict BROKEN (two-break STOP).
    - Setup: dispatch.mjs in a clean room (docs/ stripped except docs/prompts boot stubs; no CLAUDE.md/.claude; no ticket). Inputs were the round-4 delta diff and the rounds 1–3 diff.
    - Jail: bwrap with the host socket as a TRIPWIRE, the dispatch socket masked and the real registry read-only.
    - Its fixer-suite run: 52/52, exit 0.
    - Break 1 (claim 2): the scratch project is registered on an empty dir and declared `host`. A later Orchard clone into it leaves `host`, so the session reached HOST-TRIPWIRE.
    - Break 2 (claim 2): repointing a `host` project at a checkout kept `host`, so the session reached HOST-TRIPWIRE.
    - Class: the declared value is a snapshot of a directory's contents at one moment, and nothing re-declares it when the contents or the path change. Its default for "nothing there yet" was `host`.
    - FIXED:
      - An empty dir now classifies as sandbox.
      - updateProject reclassifies on a hostPath change, toward the sandbox only, and logs it.
      - ensureScratchProject now logs its declaration.
    - The attacker's repros, re-run in the same jail:
      - On the round-4-as-attacked code (scratch/bug223-r4/room): S and R both HOST-TRIPWIRE, 2 lane requests each.
      - On the fixed code (room-fixed): S and R both sandbox (2c805f30…), 0 lane requests.
      - Extra case R2, a NON-empty plain project repointed at a checkout: host→sandbox, session in the sandbox.
    - Its hypotheses not executed (not run here either):
      - A row stored unnormalised: the lookup matches on `path.resolve`, but the create/repoint clash check compares raw strings.
      - The classify script's re-read→write window races a server write (no lock).
      - A symlinked project path misses the lookup and fails safe to the sandbox.
      - Broker lanes for breaks 1 and 2: they read the same hostPath.

    Anti-regressions:
    - verify-feat-102-dispatch-broker: 25/25.
    - verify-scratch: 17/17.
    - verify-feat-089-method-auto: 35/35.
    - verify-feat-139-http: 16/16.
    - verify-feat-159-settings-controls: 32/32.
    - verify-bug-146-conventions-inject: 30/30. verify-local-conventions: 18/18.
    - Identical on the pinned pre-lane tree (pre-existing, not mine):
      - verify-feat-146-settings-content: 137/139. Its mutation marker predates `envGroup`.
      - verify-feat-146-settings-shell: HARNESS ERROR, "null textContent".
    - NOT run: verify-feat-158-docker-sandbox. It cycles down/up on the SHARED sandbox. Its edit is one opt-out line (`base = useHostDocker(...)`), so its down/up and its foreign-down lock checks are not refused under a lane mark. `node --check` passes.

    `npm run gate`: exit 0 (leak-gate, check-nul, typecheck all PASS).

    regressed-from: none. The round-4 breaks are in this round's own new initial-value rule.

    Known limits:
    - A NON-empty, non-Orchard project that later has an Orchard checkout cloned into it, without a repoint, keeps `host`. The real `scratch` row (it holds `tbr-look`) is in exactly this shape. Declared means user-owned.
    - The PATCH that flips the setting is open to any API caller, like the other project settings.
    - Live sessions keep the daemon they started with.

    Files:
    - Edited: scripts/lib/lane-docker.mjs, scripts/lib/lane-docker.d.mts, src/server/registry.ts, src/server/validate.ts, public/lib/drawer.js, scripts/verify-bug-223-lane-docker.mjs, scripts/verify-feat-158-docker-sandbox.mjs, package.json (`lane-docker:classify`), docs/CONVENTIONS.md (the BUG-223 paragraph).
    - New: scripts/classify-lane-docker.mjs.
    - Not touched: agent-bridge.ts, dispatch-broker.ts, the runtimes, and the ARCH-022 files.
    - Scratch: ~/.local/state/claude-station/scratch/bug223-r4/. It holds pre/, t-r3/, room/, room-fixed/, shots/, the suite logs, the attack charter and output, and classify-real.txt.

    DECISIONS:
    1. Flip the real `scratch` project to `sandbox`? It is a catch-all where sessions clone things, and it sits in the residual shape above. This is one Settings click; I left it at the classified value.
    2. A round-5 attacker, or accept. This is session-lifecycle and host-safety work, so an independent clean-room pass on the round-4 fixes is warranted.
    3. Deploy: the setting takes effect after the next Orchard restart. Until then the live server runs the round-3 scan.

### 2026-10-01 — BUG-223 r4 fix lane
- **Note:** board:gen rewrote INDEX.md; `npm run board:check` exit 0, OK (no drift; 130 standing advisory warnings, 49 stale doc refs, none about BUG-223). Final `npm run gate` exit 0. The tripwire and attacker processes were stopped by pid; no Docker objects were created.

### 2026-10-01 — BUG-223-r5-verify-lane
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 2f0e8008-4ef8-4c70-8bda-e3de1032b566 — VERDICT: HOLDS — r5 property 4 (drawer+API refuse invalid laneDocker): jailed attacker; PATCH/PUT/POST flat+nested bad values all 400 and unstored; session overrides fatal; drawer driven in headless Brave, session scope disabled for real.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-01 — BUG-223-r5-verify-lane
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run f63724a4-d591-499d-9184-6a8fee984b00 — VERDICT: BROKEN — r5 property 1 (empty dir starts sandbox): 2 breaks - unlistable empty dir (0333) classified host; scratch delete+re-ensure re-classified leftovers to host. Both fixed (lane-docker, registry); repros now SANDBOX, 0 session tripwire lines.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-01 — BUG-223-r5-verify-lane
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 25846b56-fbdd-4fe5-b6bd-e5ca2f1c619e — VERDICT: BROKEN — r5 property 2 (repoint only toward sandbox): repoint itself held; 2 breaks via path lookup - scratch-dir repoint makes 2 rows on one path (first-match host; FIXED in lane-docker), stale broker project after repoint (OPEN, needs dispatch-broker.ts).. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-01 — BUG-223-r5-verify-lane
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 45d06dff-352b-489a-bb7f-a6bbcc3c8f65 — VERDICT: BROKEN — r5 property 3 (laneDockerEnv reads only the declaration, never host on unknown/malformed): 1 break - dispatch broker keeps the stale project after a repoint, so a sandbox lane reads the host row now at its old path. OPEN; fix is in dispatch-broker.ts.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-01 — BUG-223 r5 verify lane
- **Note:** **verifying, round 5 (claude-opus-5-5 lane): four concurrent jailed clean-room attackers, one per round-4 property. 4 HOLDS; 1, 2 and 3 BROKEN. Fixed three breaks in lane-docker/registry; one break class (stale dispatch-broker project) is OPEN and needs a change outside my sanctioned files.**

    Setup: dispatch.mjs, anthropic/claude-opus-5-5, four rooms built from the current tree (docs stripped except docs/prompts; no CLAUDE.md/.claude/ticket; node_modules reflinked), with the round-4 delta diff, the post-attack fixes diff and the rounds 1-3 diff. Each room ran in its own bwrap jail with its own host-socket TRIPWIRE, the dispatch socket masked and the real registry read-only. Each charter carried the two-break STOP and named the accepted residual as out of scope. Scratch: ~/.local/state/claude-station/scratch/bug223-r5/ (charter-pN.txt, attack-pN-out.txt, room-pN/atk, room-fixed/).

    Results:
    - P1 (empty dir starts sandbox), run f63724a4-d591-499d-9184-6a8fee984b00: BROKEN 2/2.
      - Break 1: an empty dir that cannot be listed (mode 0333) classified `host`; its session reached HOST-TRIPWIRE. Cause: the readdir that tests emptiness threw, and the scan fell through to `host`.
      - Break 2: scratch deleted and re-ensured over its leftover files was re-classified `host`; session HOST-TRIPWIRE. Nobody chose it.
      - FIXED: classifyLaneDocker returns `sandbox` when the root cannot be listed; ensureScratchProject always declares `sandbox` (Orchard's own throwaway project; the toggle still flips it). Existing rows are untouched (the real `scratch` row stays `host`).
    - P2 (repoint only toward sandbox), run 25846b56-fbdd-4fe5-b6bd-e5ca2f1c619e: BROKEN 2/2. The repoint rule itself held on 11 executed shapes (flat/nested, `..`, symlink, relative, concurrent PATCHes, swap). Both breaks are the path lookup:
      - Break 1: the scratch-dir repoint (`ensureScratchProject` -> updateProject) skips the clash check, so scratch (`sandbox`) and a user project (`host`) share one path; first-match gave scratch `host`. FIXED in declaredLaneDocker: when several rows resolve to one path, `host` needs every one of them to declare it, else sandbox. (Real registry: 20 rows, 0 shared paths, so no live decision changes.)
      - Break 2: see P3 (same mechanism).
    - P3 (laneDockerEnv reads only the declaration; unknown/malformed never host), run 45d06dff-352b-489a-bb7f-a6bbcc3c8f65: BROKEN 1 (no second path found). Held: the registry cut at every byte offset 0-401 (both row orders), 10 malformed values, malformed shapes, missing/relative/sub-dir paths, 0 listings and 0 stats over 5 decisions.
      - Break (OPEN): `dispatchBroker.start(project)` returns the existing broker for that id and keeps the project object it was first started with. After project B (sandbox) is repointed and project A (classified host) is registered at B's old path, B's next broker lane runs with the OLD hostPath: cwd is A's directory, and the lookup reads A's `host`. Lane reached HOST-TRIPWIRE. I re-executed it in the jail on the attacked tree and on the fixed tree: HOST-TRIPWIRE both times.
      - Not fixable in lane-docker/registry/validate: a path lookup cannot know which project asks. The fix is in src/server/dispatch-broker.ts (re-read `getProject(project.id)` per lane, or refresh/stop the broker on a repoint). That also fixes the wrong cwd, which is a pre-existing broker defect.
    - P4 (drawer + API refuse invalid values), run 2f0e8008-4ef8-4c70-8bda-e3de1032b566: HOLDS. PATCH/PUT/POST, flat and nested, all bad values (null, "", case, whitespace, NUL, arrays, objects, numbers, prototype keys, duplicate keys, wrong content type, 3 MB body) returned 400/413 and stored nothing. Session overrides carrying laneDocker are fatal. The drawer was driven in headless Brave: it sends only the two values, and in session scope it is disabled with no listener; a bad stored value displays "Not chosen yet" and is read as sandbox.

    Attacker repros, re-run by me in the same jails (pre = attacked tree, post = room-fixed = current files):
    - P1 unreadable: pre `host` + session HOST-TRIPWIRE; post `sandbox`, session DOCKER_HOST = sandbox socket.
    - P1 scratch re-ensure: pre `host` + HOST-TRIPWIRE; post `sandbox`.
    - P2 dup path: pre scratch session HOST-TRIPWIRE (2 /info lines: harness probe + session); post SANDBOX (2c805f30), 1 /info line (the harness probe).
    - The remaining fixed-run tripwire lines are the top-level server's own boot listing and `ensureSandboxUp` (the harness set XDG_STATE_HOME, so the sandbox looked down). That is the server's own host docker, by design; 0 were session lines.

    Anti-regressions (current tree): verify-bug-223-lane-docker 56/56 (exit 0, SURVIVE=0); verify-scratch 17/17; verify-feat-102-dispatch-broker 25/25. `npm run gate` exit 0.
    regressed-from: none. The p1/p2 breaks are in round 4's own registration and lookup rules; the stale broker predates BUG-223.

    Documented limit (accepted residual, by decision): a project declared `host` that LATER gains an Orchard checkout in place (e.g. a clone into it, no repoint) stays `host` until the user flips the setting. That is the declared-value design, and the drawer toggle is the remedy.
    Other limits: the suite has no checks for the three round-5 fixes yet (proof is the re-run repros above). The classify script would still classify an undeclared scratch row by its contents (the real registry is already classified). Duplicate rows on one path are not prevented, only made fail-safe.

    Files edited: scripts/lib/lane-docker.mjs, src/server/registry.ts.

    DECISIONS:
    1. The stale-broker break: authorise a fix in src/server/dispatch-broker.ts (re-read the project by id per lane), then a round-6 attacker on properties 2 and 3.
    2. Whether to add suite checks for the round-5 fixes (the suite file is outside this lane's sanctioned files).

### 2026-10-01 — BUG-223 r6 fix lane
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 85b888c3-76eb-4be8-8d79-58544b62e4fc — VERDICT: HOLDS — r6 property 2 (repoint toward sandbox only; no launch from old path): jailed attacker, 0 tripwire lines, pure-function level only (no scratch server). Unexecuted: direct-session launch decides by path (agent-bridge.ts:1783) across an await.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-01 — BUG-223 r6 fix lane
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run d3ad67f3-f25e-48b0-819a-3a173b6707d4 — VERDICT: HOLDS — r6 property 3 (asking project's declaration only; unknown/deleted/malformed never host): jailed attacker, 0 tripwire lines. 27 malformed shapes x3 readers all sandbox; registry cut at 310 offsets: sandbox or refusal. No end-to-end server run.. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-01 — BUG-223 r6 fix lane
- **Note:** **fixing + verifying, round 6, the final round (claude-opus-5-5 lane): fixed the round-5 open break (stale dispatch-broker project) and added suite checks for all round-5 fixes and this one. Suite 62/62. Must-FAIL shown on pinned round-5 and round-4 trees. Two concurrent jailed attackers (properties 2 and 3): both HOLDS, 0 tripwire lines. One residual is documented, not fixed: it is in an ARCH-022 file this lane may not edit.**

      Fix (ARCH-010, no cached derived copy):
      - src/server/dispatch-broker.ts `runDispatch` re-reads the project BY ID (`getProject(started.id)`) for every lane and takes the lane's cwd, `--cwd` and `laneDocker` from that fresh row.
      - A project that is no longer registered gets no lane (refusal `project-not-registered`). A registry that cannot be read gets refusal `registry-unreadable`. The start-time Project object is used only for its id.
      - The declaration is read from that same row: `laneDockerEnv({ project: row })` -> new `declarationOfRow(row)` in scripts/lib/lane-docker.mjs. This is one interpreter of the value, shared with the path lookup `declaredLaneDocker`, which now calls it too. It reads `laneDocker` only as an own property.
      - Before the fix, the broker passed `projectPath` only and the declaration was looked up by whichever row sat at that path.
      - Consequence: three suites started brokers on UNREGISTERED fixture projects (no real path does), and their lanes are now refused. I added `scripts/lib/broker-fixture.mjs` (`registerFixtureProjects`) and a one-line registration in each: verify-feat-102-dispatch-broker, verify-arch-017-drain, verify-lane-ledger (main data dir, legs 4/6/7, the restart dir). Their assertions are unchanged.

      Must-FAIL (round-5 open break: repoint, then a host project registered at the old path). This is the r5 attacker's own repro, `stale-broker.mjs`, re-run in a bwrap jail with the host socket as a TRIPWIRE:
      - Pinned round-5 tree (scratch/bug223-r6/room-pre): lane 2 for project B (declared sandbox) got HOST-TRIPWIRE, `ORCHARD_LANE_DOCKER=host`, cwd = A's dir. 2 tripwire lines.
      - Fixed tree (room-post): lane 2 got the sandbox (2c805f30), cwd = B's new dir. 0 tripwire lines.

      Suite (`scripts/verify-bug-223-lane-docker.mjs`) has new checks:
      - A7: scratch deleted and re-ensured over leftovers -> sandbox (r5 p1 b2).
      - F12: an unlistable 0333 dir -> sandbox (r5 p1 b1).
      - G0j: two rows on one path give host only if every row declares host (r5 p2 b1).
      - G0k: the row re-read by id decides, not the path; null and malformed rows -> sandbox (r6).
      - C4: real createProject/updateProject; B repointed, A registered at the old path; B's broker lane reaches the SANDBOX in B's NEW dir (r5 p3).
      - C5: deleted project -> lane refused, no spawn (r6).

      Suite results:
      - Current tree: 62/62, exit 0.
      - Pinned round-5 tree: 59/62. Exactly C4, C5 and G0k fail. On C4 the lane-2 `docker info` reached the real HOST daemon (read-only) with the old cwd.
      - Pinned round-4 tree: 56/62. A7, F12, G0j, C4, C5 and G0k fail.

      Attackers, round 6:
      - Setup: concurrent dispatch.mjs runs, anthropic/claude-opus-5-5. Clean rooms were built from the current tree (src, scripts, public, deploy, docs/prompts only; no CLAUDE.md, .claude or ticket; node_modules reflinked). Inputs were the round-6 and round-5 diffs plus earlier rounds' diffs.
      - Jail: each ran in its own bwrap jail with its own host-socket TRIPWIRE, the dispatch socket masked and the real registry read-only.
      - Rules: the two-break STOP and an 8-minute budget. The charter asked for the user actions behind any break.
      - P2, run 85b888c3-76eb-4be8-8d79-58544b62e4fc: HOLDS, 0 tripwire lines. Executed at pure-function level:
        - a stale row at a path now owned by a host project -> sandbox, fresh cwd;
        - a prototype-inherited laneDocker -> undeclared/sandbox.
      - P3, run d3ad67f3-f25e-48b0-819a-3a173b6707d4: HOLDS, 0 tripwire lines.
        - 27 malformed shapes (`__proto__`, `constructor`, arrays, `" host"`, `"HOST"`, settings as a string or null) gave sandbox through all three readers, and the readers agreed.
        - A real-shaped registry was cut at 310 byte offsets. The pure function gave sandbox every time. The broker's `getProject` threw (-> registry-unreadable) or returned the right row, and never another project's row.
      - Limit, stated honestly: neither attacker booted a scratch server inside the budget. Both verdicts rest on executed pure-function and registry-function calls plus code reading. There is no end-to-end session or lane daemon-id run from the attackers. That end-to-end shape is covered by suite C4/C5 above.

      Documented residual (not fixed; stopping rule):
      - What it is: direct-session launch still decides the daemon BY PATH. agent-bridge.ts:1783 calls `laneDockerEnv({ projectPath: opts.project.hostPath })` with the row read when the session started. `startSession` awaits `prepareDispatchForSession` (agent-bridge.ts:5624) before that line runs.
      - Exact user actions to trigger it (P2 hypothesis, NOT executed end to end; only the pure-function consequence was executed):
        1. Start or resume a direct session on project A (declared sandbox).
        2. While that start is still awaiting the dispatch-broker setup (milliseconds), PATCH A's hostPath to another directory.
        3. In the same window, register a new project B at A's OLD path, where that dir is non-empty and holds no Orchard checkout, so B classifies host.
        4. A's session then starts in B's directory with the host daemon.
      - Realism: needs two API calls inside a millisecond await. No normal UI sequence produces it.
      - Fix shape: pass the row re-read by id after the await as `project` to laneDockerEnv. That is a one-line change, but in agent-bridge.ts, an ARCH-022 file this lane was told not to edit.
      - Same class as the broker break (a cached Project outliving a repoint).

      Observed out of scope (not properties 2/3; the server's own host env, by design):
      - Server-run git operations (git.ts netGit) and "open terminal" run with the server's env, so a docker call from a project's git hook would reach the host. Hypothesis, not executed.

      Anti-regressions (current tree):
      - verify-bug-223-lane-docker: 62/62.
      - verify-feat-102-dispatch-broker: 25/25.
      - verify-feat-102-static: 10/10.
      - verify-feat-102-entitlement: PASS.
      - verify-arch-017-drain: 41/41.
      - verify-lane-ledger: 63/63 on 2 of 3 runs. One run failed D7 ("vacuous unless the sweep also covered the peer-died-first side"), a timing-sweep coverage check unrelated to the broker's project read.
      - verify-lane-ledger `--must-fail-proof` leg 1 fails, pre-existing and not mine. It diffs against `git show HEAD:dispatch-broker.ts`, and HEAD already records lanes: a moving-baseline proof (CONVENTIONS).
      - `npm run gate`: exit 0.

      regressed-from: none. The stale broker predates BUG-223. The round-5 checks cover round 5's own fixes.

      Files:
      - Edited: src/server/dispatch-broker.ts, scripts/lib/lane-docker.mjs, scripts/lib/lane-docker.d.mts, scripts/verify-bug-223-lane-docker.mjs, scripts/verify-feat-102-dispatch-broker.mjs, scripts/verify-arch-017-drain.mjs, scripts/verify-lane-ledger.mjs.
      - New: scripts/lib/broker-fixture.mjs.
      - Scratch: ~/.local/state/claude-station/scratch/bug223-r6/ (room-pre, room-post, room-r4, room-p2, room-p3, charters, attack outputs, suite logs).
      - My tripwires were stopped by pid. No Docker objects were created.

      Independent review: this is a session-lifecycle and host-safety change, so a fresh-context review of the diff is warranted before commit. The attackers' depth was limited by their budget.

### 2026-10-01 — worker
- **BUG-223 residual: direct-session lane Docker read by project id:** BUG-223 residual fixed inside the ARCH-022 lane (coordinator request, agent-bridge slot held by ARCH-022): src/server/agent-bridge.ts startSession, the direct-session lane Docker decision, now reads THIS project's registry row by id - laneDockerEnv({ projectPath, project: getProject(opts.project.id) ?? null }) - through the by-row reader declarationOfRow (scripts/lib/lane-docker.mjs), the same one the dispatch broker uses; it used to resolve by project PATH, so a second row on the same path could decide another project's daemon. One line. Executed: npm run gate exit 0; scripts/verify-bug-223-lane-docker.mjs 62/62. Not separately attacked: covered by the ARCH-022 attacker scope per the coordinator.
