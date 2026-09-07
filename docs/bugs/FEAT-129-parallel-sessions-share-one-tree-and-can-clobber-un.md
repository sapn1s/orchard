# FEAT-129 — Parallel sessions on one project can silently overwrite each other's unsaved edits

- **Status:** OPTION A, ROUND 3 — the one load-bearing residual (agent_id≡task_id) CONFIRMED EQUAL empirically on live subagents; heartbeat cannot self-release a live subagent lock. VERIFIED-candidate.
- **Severity:** medium
- **Area:** server (agent-bridge cwd) / runtime / orchestration discipline
- **Reported:** 2026-09-06 by finding lane (dispatched, read-only investigation)
- **Verification-class:** plan+review ⟶ independent verification REQUIRED before VERIFIED

## Symptom
The user wants to run several sessions on ONE project at the same time, each on a
different feature, sometimes editing the SAME files. They ask whether Orchard does
this safely, cite that the Claude Code CLI "was just saying file is locked while one
agent tries to edit," and ask whether parallel orchestrators are "out of sync of what
else I have developed."

There is no structural protection. Every session and every lane for a project runs in
the SAME working tree (`agent-bridge.ts` line 949: `this.cwd = opts.project.hostPath`;
container isolation bind-mounts the one repo). No file lock, no atomic-write layer, no
"file busy" signal exists anywhere in the tree (`grep -rniE 'flock|lockfile|O_EXCL'`
over `src/` finds nothing; every "advisory" hit is a stall/provenance notice, not a
write lock). The only defenses are (1) the harness Edit tool's staleness guard, (2)
opt-in `isolation: worktree` per dispatched lane, and (3) orchestrator discipline
(serialize same-file lanes) codified in WA §I/§J and `docs/bugs/README.md`.

## Repro (measured, from this project's own transcripts — same-tree lanes)
Two concurrent-lane clobbers actually occurred; both were WHOLE-FILE / git operations,
not Edit-vs-Edit races:

- **agent-ad026a349210180ac (2026-08-26):** "My package.json edit survived, but
  claude-runtime.ts now has a *different* lane's change (+17/-5) and my edits are gone
  … Another lane owns FEAT-107 … is actively mutating tracked files — it reverted my
  claude-runtime.ts edit while keeping its own." A concurrent lane's whole-tree git
  revert/checkout wiped this lane's uncommitted hunk. (Same run also shows a ticket-id
  collision: two lanes both grabbed FEAT-107.)
- **agent-af0292b979a87a510 (2026-08-27):** "The orphaned-but-alive verifier agent just
  overwrote my container script on disk with its own real-CLI version." A whole-file
  Write from a still-alive orphan overwrote a live lane's file.

By contrast, the harness Edit tool did NOT silently clobber: the same incident logged
`<tool_use_error> File has been modified` — the read-modify-write staleness guard
failed loud rather than overwriting. And agent-a89cf54509a1d9f95 (2026-09-02) shows the
safe path: "styles.css is being actively edited by another lane … My edit applied to
current disk content so other hunks are intact." So **the Edit tool is safe; the hazard
is whole-file operations** — `Write`, and Bash-driven `git checkout -- file` / `git
reset --hard` / `git stash` / `git show HEAD:file > file` / a verify script that
regenerates a file — none of which carry a staleness check.

## Expected
A parallel same-file workflow should either (a) refuse/serialize a colliding writer with
a visible "file busy" signal (the CLI behaviour the user saw), or (b) give each session
its own tree so writes cannot collide, or (c) at minimum guarantee that whole-file/git
operations cannot silently drop another lane's uncommitted work.

## The two questions, answered
1. **Concurrent editors safe?** No structural safety. WITHIN one orchestrator, discipline
   (serialize same-file lanes) mostly holds but demonstrably failed twice above. ACROSS
   two separate live sessions the risk is worse: each session's orchestrator serializes
   only ITS OWN lanes — neither coordinates the other, and nothing locks the shared tree.
2. **Out of sync?** Partly real, mostly a design characterization (NOT separately measured
   for two top-level sessions). What IS shared: the git working tree (both see each
   other's on-disk committed AND uncommitted changes — there is no private buffer; edits
   write straight to disk) and the board (`docs/bugs/`, injected as a per-turn system-prompt
   snapshot — see BUG-165). What is NOT shared: in-flight intent — neither session knows
   what the other is mid-editing or about to do, because the board snapshot is only
   re-read at each session's own turn boundary. So "out of sync about what the other is
   about to change" is true by construction; "can't see what the other already wrote" is
   false (same tree).

## Decision — how do we make parallel same-file work safe?

- **A — advisory "file busy" lock (matches what the user saw in the CLI).** A lightweight
  per-path advisory lock (lockfile / O_EXCL) a writer takes before Write/Edit and Bash git
  ops, surfacing "file busy, owned by lane X" instead of a silent overwrite. Buys: the
  exact fail-loud behaviour the user expects, works across sessions, small. Costs: only
  covers writers that consult it — a raw Bash `git checkout` still bypasses it unless git
  ops are wrapped; needs a stale-lock reaper (see BUG-033 zombie pattern).
- **B — worktree-per-session by default.** Make each concurrent session (not just opt-in
  per-lane) run in its own `git worktree`, merging back explicitly. Buys: true structural
  isolation, no lock needed, collisions become merges. Costs: larger; the merge/PR step is
  new UX; `isolation: worktree` exists today only per dispatched lane, not per session.
- **C — keep discipline-only, document the limit.** Accept that discipline + opt-in
  worktrees is the model; make the "run same-file lanes serially / give them worktrees"
  rule louder and add nothing structural. Buys: zero build. Costs: the user is about to
  rely on cross-session parallel editing where no single orchestrator serializes, and the
  two measured clobbers show discipline alone already leaks.

## Context pack
- Files/functions in play: `src/server/agent-bridge.ts` (`this.cwd = opts.project.hostPath`,
  ~949; board snapshot inject ~1351); `src/server/tools.ts` (MCP surface — no write lock);
  the Read/Edit/Write tools are the Claude Agent SDK's built-ins forwarded to the CLI, not
  Orchard code, so the staleness guard is the SDK's, not ours.
- Related tickets: ARCH-011 (in-progress — "measured-staleness retry rule: hash a lane's
  touched set at its end, route the retry on whether those bytes still match"; a detection/
  retry mechanism, adjacent but not a lock); FEAT-005 (durable ticket/worktree pattern);
  BUG-033 (zombie-busy no reaper — stale-lock reaper precedent); BUG-165 (live board
  snapshot per turn); WA §I/§J and `docs/bugs/README.md` §"Concurrency rules".
- Evidence: the orchestrator session's transcript store under the Claude projects dir
  (`<claude-home>/projects/<encoded-project-dir>/<session-id>/subagents/`), files
  agent-ad026a349210180ac.jsonl, agent-af0292b979a87a510.jsonl, agent-a89cf54509a1d9f95.jsonl.
- Repro test: none yet — add one that spawns two writers on one path (one Edit, one Bash
  `git checkout`) and asserts the uncommitted hunk survives or a busy signal is raised.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-06 — finding lane (dispatched, read-only)
- **Understood:** All lanes/sessions of a project share one working tree; no lock/atomic/
  busy-signal exists. The harness Edit tool has a fail-loud staleness guard (safe). The real
  hazard is whole-file/Bash-git operations, which have no guard and silently clobber a
  concurrent lane's uncommitted work.
- **Changed:** none (investigation only; filed this ticket).
- **Verified:** grep for lock primitives over `src/` — none. Confirmed `this.cwd =
  hostPath`. Reconstructed two real clobbers (ad026, af0292) from transcripts and confirmed
  both were whole-file/git operations; confirmed the Edit guard fired protectively in the
  same and a later run.
- **Still open / handoff:** needs the human decision above. If A, wrap Bash git-mutation
  commands too, or the lock is bypassable (that bypass is exactly what caused ad026). If B,
  extend the existing per-lane `isolation: worktree` to a per-session default and design the
  merge-back UX. Cross-session desync is characterized, not yet measured — a two-session
  repro would quantify it.

### 2026-09-06 — fixing lane (dispatched, option A)
- **Decision taken:** A — advisory file-busy lock (as recommended). Built, not filed.
- **Changed:**
  - `scripts/lib/file-lock.mjs` (NEW) + `scripts/lib/file-lock.d.mts` (NEW) — the pure
    classifier + the per-path lockfile store. Same importable-policy convention as
    git-write-policy / fable-tier-policy (one definition, ARCH-008).
  - `src/server/runtime/claude-runtime.ts` — wired into the SAME in-process `PreToolUse`
    callback the git-write block and Fable gate ride. Runs AFTER the git block, on any
    file-mutating tool (Write / Edit / NotebookEdit / MultiEdit) and the whole-file /
    git-tree Bash path. Fleet-wide, default ON, escape hatch `ORCHARD_ALLOW_FILE_CLOBBER=1`
    (announced once, never silent).
  - `scripts/verify-feat-129-file-lock.mjs` (NEW) — the graded suite (54 checks).
- **Design:** a lane CLAIMS a per-path lockfile before mutating it; a concurrent writer to a
  path a DIFFERENT LIVE owner holds is told BUSY ("file locked by lane X"). Edit ALSO claims
  (not to guard Edit — it is already staleness-safe — but so a later foreign whole-file/git
  write to that path is refused). The lock KEY is the repo-RELATIVE path, so two sessions on
  one project coordinate regardless of absolute cwd. Owner = station session id, with the
  per-lane `agent_id` folded on per call, so lanes within a session AND separate sessions are
  distinct owners. Whole-tree ops (git reset hard / stash / branch switch) deny if ANY file
  is held by a live foreign owner.
- **Reaper (reliability):** ground truth FIRST (owner pid provably dead on this host →
  reclaim now — the liveness.ts `pidAlive` rung), TTL backstop LAST
  (`CLAUDE_STATION_FILE_LOCK_TTL_MS`, default 300_000 = the REVIVED_TASK_TTL_MS precedent) so
  two in-process lanes that share the host pid still can't wedge a file. Reclaim is race-safe
  (rename-to-claim: only one contender wins a stale/dead lock; link-based create so a fresh
  lock is never observed empty). Fail-safe direction: an unresolvable lock error or retry
  exhaustion DENIES the mutation (serialize, never clobber); the TTL still guarantees release.
- **Verified (54/54, `node scripts/verify-feat-129-file-lock.mjs`, gate-safe):**
  - THE real clobber on a scratch git repo, must-FAIL then PASS: A has an uncommitted edit +
    claim; PRE (hatch open = old behaviour) B's whole-tree checkout is allowed, the command
    runs, A's work is CLOBBERED (bug reproduced on disk); POST (lock on) B's checkout is
    DENIED (busy, names A), B respects it, A's uncommitted work SURVIVES on disk. Same for a
    whole-file `Write` by B and a whole-tree hard reset by B.
  - Stale-lock reaper: a dead-owner lock reclaims immediately; a stale-past-TTL lock reclaims
    even with a live pid; a fresh live-owner lock is NOT falsely reaped. No wedge.
  - Single-lane unaffected: solo lane writes many files + re-edits + `npm test` + its own
    tree reset, no false busy.
  - Cross-session: two session owners on the SAME file → second coordinated (busy); on
    DIFFERENT files → both allowed (no false contention).
  - Race safety: 12 REAL concurrent processes on one free path → exactly one wins, every
    loser busy against that one winner (no split-brain ownership).
  - Regressions: FEAT-108 git-write-block 164/164, FEAT-124 Fable-gate 51/51, `npm run gate`
    exit 0. (The orchestrator-profile-registry suite fails, but that reproduces on baseline
    with my changes stashed — it stems from a CONCURRENT lane's `src/server/registry.ts`
    edit, NOT this change.)
- **Known limits (honest):** cross-MODE contention (a container session whose tool paths are
  `/workspace/<id>/…` vs a direct session's hostPath) may not share a lock key if the
  container path is not under the host repoRoot — same-mode coordination is the covered case.
  A lane that bypasses the tool layer entirely (a wrapper script, `python -c` that shells out)
  is not seen, same blind spot as the git-write block. The FEAT-108 git-write block already
  denies raw checkout/reset/stash by default, so this lock is the second layer for the
  granted-git case and the primary layer for non-git whole-file writes.
- **Still open / handoff:** HIGH-STAKES (concurrency + rides the dispatch hook + data-loss
  adjacent) — an independent adversarial verify pass is warranted before VERIFIED
  (scripts/independent-verify.mjs / a fresh-context skeptic). Note the concurrent-lane tree
  churn observed during this build is itself a live instance of the ticket's scenario.

### 2026-09-06 — adversarial verify lane (round 1, independent, read-only)
- **Verdict by surface:**
  - **reaper-vs-live-lock — BROKEN (highest harm; the exact clobber, reintroduced).** In-process
    lanes share the host pid (runtime passes NO `ownerPid`, so it defaults to `process.pid` for
    every lane — claude-runtime.ts ~745), so `pidAlive` cannot distinguish them and the TTL is the
    ONLY guard. There is NO heartbeat: a lock's `refreshedAt` only advances on the SAME owner's
    NEXT mutating tool call. A lane that Edits a file, then does legitimate NON-mutating work
    (a 5-min+ verify/build/`npm test` — one long tool call, no refresh) still "holding" it,
    goes stale at TTL. A foreign lane's `Write` to that path is then ALLOWED and clobbers the
    live lane's uncommitted work — the BUG-157 "5-minute staleness reclaimed live work" shape.
    Repro (module-direct, TTL=300s): A claims `x.ts` at T0 with `ownerPid=<alive pid>`; B
    `evaluateFileLock` Write of `x.ts` at T0+TTL+1 with the same alive pid → `allow:true`
    (CLOBBER of live A). This is the documented O_EXCL+shared-pid tradeoff (the alternative
    wedges forever), but per the verify contract "reclaims a live lock = BROKEN": a lane whose
    honest work outlasts 300s loses the very protection the lock exists for. The verify suite's
    "fresh live-owner NOT falsely reaped" case only tests WITHIN TTL, so it misses this.
  - **classifier-coverage — BROKEN (partial).** `scanBashMutation` MISSES in-place / whole-file
    mutators it does not enumerate: `perl -i -pe '…' f`, `perl -i.bak …`, `patch f < d.diff`,
    `ex -s -c wq f`, and `python -c "open('f','w')"`. `sed -i` IS covered but `perl -i` is not —
    an inconsistency; both silently overwrite a locked file with no deny. `python -c`/wrapper is
    the already-documented tool-layer blind spot (same as git-write-block), but `perl -i`, `patch`,
    `ex` are NOT documented and are common in-place editors → clobber slips. (`cat >f <<EOF`
    heredoc and `cd sub && sed -i f` DO classify as mutations; `git worktree add` correctly does
    not touch tracked files.)
  - **path-key — BROKEN (niche).** Basic spellings normalize correctly (`f` / `./f` / abs all →
    key `f`). But (a) a SYMLINK gets a different key than its target (`ln.ts` → `ln.ts`, not
    `real.ts`) so a lane locking the real path and one writing via the symlink both "own" it →
    clobber; (b) a `cd sub && <mutate> f` command keys `f` against repoRoot (`f`) while the actual
    file is `sub/f` — a lane holding `sub/f` gets a different key → no protection. Both require
    an uncommon spelling; the common Write(abs path) case is solid.
  - **shared-hook — CONFIRMED.** No regression: FEAT-108 git-write 164/164, FEAT-124 Fable
    51/51, FEAT-129 54/54 all green. Layering is correct — the git-write block runs BEFORE the
    file lock, so a git-tree op that is both a git-write and a lock case is denied by 108 first;
    the file lock is the second layer only for the granted-git / non-git whole-file path.
  - **wedge / false-busy — CONFIRMED.** Solo re-entrancy refreshes (`mode:refresh`, no false
    busy). A crashed holder whose pid is reused shows "alive" so ground-truth reclaim is skipped,
    but the TTL backstop still frees it at 300s — no permanent wedge.
- **Evidence:** (i) `node scripts/verify-feat-129-file-lock.mjs` → `PASS — 54 passed, 0 failed`,
  exit 0. (ii) adversarial repros in a scratch harness under `~/scratch/feat129/` (module-direct):
  attack 1 prints `ALLOWED -> CLOBBER of live A`; attack 2 prints `MISS` for perl -i / patch /
  python -c / ex; attack 3 prints the divergent symlink/cd keys.
- **Couldn't test:** cross-MODE container-vs-host key sharing (needs a real container session —
  documented limit); a true two-OS-process live interleave through the shipped runtime hook
  (repro is module-direct, but the runtime demonstrably passes default ownerPid+ttl so the same
  reclaim math holds); realism of a lane holding a lock >300s in production (asserted plausible
  for verify/build lanes, not measured on a live session).
- **Overall:** NOT VERIFIED. reaper-vs-live-lock reintroduces the exact clobber under the named
  >TTL-legit-work scenario; classifier and path-key have real (mostly niche) gaps. Fixes to
  consider: a lightweight heartbeat that refreshes a live lane's held locks between tool calls
  (kills attack 1), enumerate perl -i/patch/ex (attack 2), realpath the key + resolve the
  command's effective cwd (attack 3).

### 2026-09-06 — fixing lane (round 2, fix; class=fix)
- **Regressed-from:** FEAT-129 round-1 fix (same ticket) — its TTL-only guard reintroduced the
  exact BUG-157 "fixed timeout reclaimed live work" clobber. This entry closes that.
- **Root cause (confirmed via round-1 repro `~/scratch/feat129/attack.mjs`):** a lock's
  `refreshedAt` advanced ONLY on the same owner's next mutating tool call, so a live lane in ONE
  long tool call (a >5-min verify/build, no intervening mutation) went stale at the 300s TTL and a
  foreign lane's write was ALLOWED → clobber. In-process lanes share the harness pid, so `pidAlive`
  could not tell them apart and the TTL was the sole guard.
- **Fix — liveness from GROUND TRUTH, not a clock (a heartbeat wired to the running-set):**
  - `scripts/lib/file-lock.mjs` — NEW `refreshOwnedLocks({lockDir, ownerPid, host, isOwnerLive, now})`
    + `heartbeatIntervalMs(ttl)` (75s at the 300s default). Each session PROCESS re-stamps
    `refreshedAt` on every lock it holds whose owning lane is STILL a live task, and RELEASES
    (unlinks, race-safe) the lock of a lane that has left the running-set — both from ground truth,
    on a timer INDEPENDENT of tool calls. So a live lane's lock never goes stale however long its
    tool call runs; a finished lane's lock is freed at once (no wedge); a dead PROCESS stops its
    timer and the TTL backstop (`reclaimReason`, unchanged) frees its locks. Cross-session needs no
    foreign probe: each process refreshes only ITS OWN locks and an observer sees a live owner stay
    fresh. `reclaimReason`'s TTL is now a pure backstop that fires only once a heartbeat has stopped.
  - `src/server/runtime/runtime.ts` — `RuntimeStartConfig.liveLaneIds?: () => string[]` (the
    running-set as live agent_ids).
  - `src/server/agent-bridge.ts` — wires `liveLaneIds` to `this.liveAgents().filter(status==='running')`
    (the SAME running-set authority running-set.ts/harvest-agent use).
  - `src/server/runtime/claude-runtime.ts` — starts the heartbeat (`setInterval`, `.unref()`,
    cleared in `close()`); `isOwnerLive` maps a lock owner back to its lane (session-main owner live
    while the session is open; a `sessionOwner:agentId` lane live iff the running-set lists agentId;
    anything unresolved → live, i.e. fail toward never-clobber).
  - Classifier (`scanBashMutation`): added `perl -i`/`perl -i.bak`/`perl -pi -e`, `patch FILE`
    (no-file `patch` → whole tree, fail-safe), `ex -c 'w…'`; effective-cwd tracking so
    `cd sub && <mutate> f` keys `sub/f`. `lockKeyFor` now realpath-resolves target AND repo root, so
    a symlink and its target share ONE key. `python -c`/non-shell-wrapper documented as the residual
    blind spot shared with the git-write block (out of scope for a shell-level classifier).
- **Verified (self):** `node scripts/verify-feat-129-file-lock.mjs` → 75/75 (was 54; +21 round-2:
  the live-lane must-FAIL→PASS with a CONTROL proving the no-heartbeat clobber, dead/finished-owner
  release, foreign-lock untouched, perl/patch/ex, symlink+cd path-key, python-c residual). Baseline
  BROKEN reproduced first via `~/scratch/feat129/attack.mjs` (attack 1 ALLOWED, attack 2 MISS,
  attack 3 divergent keys); round-2 repro `~/scratch/feat129/attack2.mjs` 10/10. Regressions:
  FEAT-108 git-write 164/164, FEAT-124 Fable 51/51. `npm run gate` exit 0 (leak-gate + typecheck).
- **Still open / handoff — HIGH-STAKES, RE-VERIFY:** data-loss + rides the dispatch hook + this is
  round 2 of a fix a prior round broke → an INDEPENDENT adversarial re-run is warranted before
  VERIFIED (scripts/independent-verify.mjs / a fresh-context skeptic), attacking the heartbeat
  specifically: a heartbeat-vs-reclaim race on a lock transitioning live→gone; a foreground (non-
  background) subagent that holds a lock but is not in `liveAgents()` status:'running'; a lane whose
  agent_id the running-set drops transiently mid-long-call; and the container-mode key sharing left
  untested in round 1. Left unstaged for the user (no git writes).

### 2026-09-06 — adversarial verify lane (round 2, independent, read-only)
- **Verdict: CONFIRMED (with two documented residuals). No reachable clobber found; the round-1
  breaker is closed.** The one attack that could reintroduce the bug (attack 2) is not reachable
  for normally-dispatched lanes; it survives only in narrow resume/ambient edges, and the primary
  user scenario (two separate top-level sessions) is safe.
- **Evidence (contract):**
  - (i) `node scripts/verify-feat-129-file-lock.mjs` → `PASS — 75 passed, 0 failed`, exit 0.
  - (ii) adversarial harness `~/scratch/feat129-r2/attack.mjs` (drives the REAL module) 9/9 as
    expected; plus a direct classifier spot-check (not trusting the suite).
- **Per surface:**
  - **attack 1 (live lane in a >TTL long call) — CONFIRMED CLOSED.** Drove `refreshOwnedLocks`
    with the EXACT `isOwnerLive` closure semantics and a real-shaped engine task_id across ticks
    to T0+2×TTL; a foreign `Write` AND `git reset --hard` are both DENIED (holder named), the
    lock's `refreshedAt` advanced via the heartbeat not the clock. The round-1 clobber is gone.
    The heartbeat is a `setInterval(tick, heartbeatIntervalMs())` (`.unref()`ed), genuinely
    independent of tool calls.
  - **ID-SPACE (load-bearing, not suite-tested) — holds by strong corroboration.** The heartbeat's
    correctness rests on the SDK PreToolUse `agent_id` (what claims a lock) equalling the engine
    `task_id` (what `liveLaneIds()`=`liveAgents().filter(running).map(agentId)` returns). Real
    data confirms they share ONE distinctive format: hook `agent_id`=`a9ef1cca8415c0d5f`
    (scripts/fixtures/feat-096/real-pretooluse-payloads.jsonl); transcript `task_id`s are
    `a06efcde1be20603c`-shaped (17-hex, `a`-prefixed) — NOT the UUID used for session_id/uuid.
    If they DIVERGED in value, attack 2 would be SYSTEMIC (every subagent lock released in ≤75s).
    Format match + single-id-per-subagent design + green suite ⇒ equality is very likely; a live
    subagent showing BOTH fields at once was not observable from disk (the CLI, not the vendored
    SDK, sources the hook id). This is the top could-not-directly-prove item.
  - **attack 2 (own-session live lane absent from liveLaneIds → lock released → clobber) — mechanism
    real, NOT reachable for dispatched lanes.** The release path is real (harness: `released:1` →
    foreign write ALLOWED). BUT `#agents` rows are created `'running'` at `task_started`, are NEVER
    deleted, and only ever transition to a TERMINAL status (grep: no `#agents.delete`, no live
    `paused`/`pending` assignment). So a normally-dispatched subagent is in `liveLaneIds()` for its
    whole life. A live-but-unlisted own-lane exists only in narrow edges: a resume/re-attach lane
    the level lists with no row, a `skip_transcript` ambient task, or the sub-tick pre-`task_started`
    window (closed within one 75s tick). The MAIN/orchestrator owner (no `:agentId` suffix) is
    NEVER released while the session is open (harness confirmed). Not the user's stated scenario.
  - **attack 3 (transient running-set drop) — NOT reachable.** A running `#agents` row is stably
    present and stably `'running'` until a terminal frame; there is no code path that transiently
    omits or un-runs a still-live row. No transient-drop window exists.
  - **attack 4 (heartbeat-vs-reclaim on live→gone) — CONFIRMED safe.** A finished lane leaves the
    running-set and its lock is RELEASED at the next tick (≤75s), not wedged; a new lane then
    proceeds. Worst case is ≤~75s of false-busy after a lane finishes (fail toward serialize),
    never a clobber of live work.
  - **CROSS-SESSION (the user's real scenario) — CONFIRMED safe.** `refreshOwnedLocks` only
    releases locks whose `ownerPid`+`host` match this process, and `isOwnerLive` returns true for
    any owner not prefixed with this session's id (foreign → keep). Even in the shared-server-pid
    case, a foreign session's lane is refreshed/kept, never falsely released — no cross-session
    clobber.
  - **attack 5 (container key sharing) — CONFIRMED for the two-container case; cross-mode is the
    documented residual.** `containerWorkdir` is `/workspace/<PROJECT_ID>` (keyed by project, not
    session), so two container sessions on one project produce the SAME key
    (`/workspace/<pid>/src/a.ts`) and DO coordinate. A container session vs a direct host session
    diverge (`/workspace/<pid>/src/a.ts` vs repo-relative `src/a.ts`) — no coordination across
    modes, exactly the limit round-1 documented.
  - **classifier round-2 additions — CONFIRMED.** Direct check: `perl -i`/`-i.bak`/`-pi -e`
    detected, plain `perl` not; `patch FILE` → that file, `patch -pN < d` → whole tree (fail-safe);
    `ex -c 'wq' f` detected, `ex -c 'q' f` not; `cd sub && sed -i f` keys `sub/f`; symlink resolves
    to its target's key. `python -c` remains undetected — the documented, out-of-scope shell-layer
    blind spot (shared with the git-write block).
  - **non-vacuity — CONFIRMED.** Dead-owner and past-TTL locks still reclaim (suite §3); solo lane
    no false-busy (suite §4); 12-process race → exactly one winner (suite §6).
- **Couldn't test:** (1) value-equality of hook `agent_id` vs engine `task_id` on a single live
  subagent (format-matched only — see ID-SPACE above; the top residual risk if wrong); (2) a real
  session-resume re-attach lane that writes a file with no `#agents` row (attack 2's only realistic
  reach) — needs a live restart+resume with a concurrent same-file writer; (3) cross-mode
  container-vs-host contention on a live pair (documented limit, module-confirmed to diverge).
- **Overall:** VERIFIED-candidate. The data-loss surface holds against every reachable attack;
  residuals are niche (resume/ambient edges, container↔host cross-mode) and one honestly-flagged
  unproven-but-well-corroborated assumption (agent_id≡task_id). No clobber and no wedge reproduced.

### 2026-09-06 — round-3 targeted verify lane (independent, empirical, read-only)
- **Verdict: EQUAL — CONFIRMED EMPIRICALLY.** The round-2 top residual (the file-lock PreToolUse
  `agent_id` == the engine `task_id` that `liveLaneIds()` returns, for the SAME live subagent) is
  now observed directly, not just format-matched. The heartbeat therefore refreshes a live
  subagent's lock rather than self-releasing it. FEAT-129's load-bearing assumption HOLDS → the
  lock is safe to ship on this axis.
- **What was confirmed:** owner id folded onto a subagent lock is `i.agent_id` from the PreToolUse
  hook (claude-runtime.ts:783); `liveLaneIds()` returns `String(m.task_id)` from `task_started`
  (agent-bridge.ts:4031, 1456); `isOwnerLive` keeps a lock live iff `liveLaneIds().includes(agentId)`
  (claude-runtime.ts:695-697). If these two ids diverged, every subagent lock would self-release in
  ≤75s → systemic clobber. They do not diverge.
- **How (empirical, one shot, then repeated):** a scratch harness drove the SAME vendored SDK
  `query()` the runtime uses (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`, v0.3.220),
  dispatching ONE real `general-purpose` subagent that actually ran the Edit tool on a file
  (`target.txt`, edit landed on disk = real mutation, PreToolUse fired for it). For that same
  subagent both fields were captured at once via the SAME hook/message stream:
  - run 1: PreToolUse `agent_id` = `aeea1e3db8fa6dd45`; `task_started.task_id` = `aeea1e3db8fa6dd45` → EQUAL.
  - run 2 (fresh): `agent_id` = `a3ea65bf4f5804b5f`; `task_id` = `a3ea65bf4f5804b5f` → EQUAL.
  Both are the 17-hex `a`-prefixed lane-id format round-2 predicted; the value equality round-2
  could not observe is now direct. Harness: `~/scratch/feat129-r3/harness.mjs` (scratch,
  not in the tree; no real tree modified, no scratch server on :4317 touched).
- **Scope note:** confirmed for the normally-dispatched subagent case (the primary scenario and the
  one whose divergence would have been systemic). Does not re-open the round-2 residuals it already
  scoped (resume/ambient edges; container↔host cross-mode) — those are unchanged and out of scope
  for this single-fact pass.
- **Ship implication:** no round-3 fix needed on the id-keying axis; the round-2 `VERIFIED-candidate`
  standing is upheld with its last unproven assumption now proven.
