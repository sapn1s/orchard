# BUG-215 — the fork bar tells a container→direct session to fork the wrong way

- **Status:** IN-PROGRESS
- **Severity:** medium
- **Area:** composer / server (fork bar)
- **Reported:** 2026-09-29 by orchestrator dispatch
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED.

## Symptom
Resuming a session that had run inside a container, in a project that now runs
direct on the host, pops the one-click fork bar with copy for the OPPOSITE
direction: "Fork it into the container to continue; the original stays on the
host", button "Fork into the container". The project has no container; the fork
actually branches the history to a direct-on-host session. The user is told to
fork the exact wrong way.

## Repro
Exact steps → wrong behavior.
1. A project whose per-session config recorded isolation `container` at launch;
   the project is now `direct`.
2. Open that session and send → resume is refused and the fork bar arms.
3. The bar reads "…before you enabled the container… Fork it into the container…"
   even though this is a container→direct move.

## Expected
The bar names the real direction: "This session ran in a container, but the
project now runs directly on the host — … Fork it to continue here; the original
stays untouched." Button: "Fork to continue here". The classic direct→container
case keeps its existing copy.

## Context pack
- Files/functions in play:
  - `src/server/fork.ts` — `explainUnresumable()` builds the needs-fork payload;
    `UnresumableReason.fork` now carries `toContainer` (true = direct→container,
    false = container→direct). `planFork()` already stages container→direct
    correctly (verified — flow was NOT broken, only the copy).
  - `src/server/events.ts` — the `needsFork` event type gains `toContainer?`.
  - `public/app.js` — `armNeedsFork()` (`say` copy + carries `toContainer` on
    `state.pendingFork`), `paintFrozenBar()` (bar span + `#forkBtn` label), and
    the `#forkBtn` click handler's "Forking …" status line all branch on
    `toContainer === false`.
- Related tickets: BUG-090 (the one-click fork bar this extends), BUG-138
  (path-changed cause), FEAT-155 (container store dir).
- Repro test: `node scripts/verify-bug-forkbar-direction.mjs`
- Known dependencies / blockers: the BUG-090 PART B end-to-end SDK round-trip
  harness has bit-rotted on HEAD (fails "No conversation found" independent of
  this change); this ticket's UI proof drives the same real `onEvent` render
  entry directly instead.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-29 — fix lane (Opus 4.8)
- **Understood:** `explainUnresumable` reports cause `isolation-changed` for BOTH
  directions of an isolation mismatch, but every UI surface hard-coded the
  direct→container wording. For a now-`direct` project the direction is fully
  determined by `project.isolation`.
- **Hypothesis verified FIRST:** the container→direct fork itself works —
  `planFork` stages a byte-identical copy into the HOST store dir, original
  untouched (probe + PART A of the test). So this is a copy bug, not a broken
  flow; safe to reword.
- **Changed (unstaged):**
  - `src/server/fork.ts` — add `toContainer` to `UnresumableReason.fork`, set to
    `project.isolation === 'container'` for `isolation-changed` only.
  - `src/server/events.ts` — add `toContainer?` to the `needsFork` event type.
  - `public/app.js` — direction-correct copy in `armNeedsFork` (say line +
    `state.pendingFork.toContainer`), `paintFrozenBar` (new container→direct
    branch: "Recorded in a container." / "Fork to continue here"), and the
    forkBtn click "Forking …" status line.
  - `scripts/verify-bug-forkbar-direction.mjs` — new repro/verify script.
- **Verified:** `node scripts/verify-bug-forkbar-direction.mjs` → `16/16 checks
  passed`. PART A (server, scratch CLAUDE store): both directions carry the right
  `toContainer`; container→direct `planFork` stages into the host dir
  byte-identical, original untouched; cross-os carries no `toContainer`. PART B
  (real app.js in happy-dom, real needs-fork event shape through real `onEvent`):
  container→direct bar does NOT say "into the container", says "runs directly on
  the host" + "continue here", button "Fork to continue here"; direct→container
  keeps classic copy. MUST-FAIL proof: ran against a synthesized pre-fix app.js
  snapshot (`BUG_FORKBAR_APPJS=…`) → the 5 container→direct rendered-text checks
  FAIL (bar reads "into the container"), classic copy still PASSes — confirming
  the direction bug, not a broken render. `npm run gate` → PASS (exit 0).
- **Verified-by:** PENDING — independent clean-room verify warranted (regression-
  prone: same-file as BUG-090/BUG-138 fork copy). No visual screenshot captured
  (text-only copy change; exact rendered strings asserted) — the bit-rotted
  end-to-end SDK harness makes a live-browser bar capture non-trivial; flagged.
- **Still open / handoff:** independent verifier should exercise a case the
  fixture omits — e.g. a project where the session recorded `direct` and the
  project is now `container` (toContainer true via `project.isolation`) reached
  through a real refused resume, and confirm cross-os/path-changed copy is
  untouched.
- **Symptom of a deeper design flaw?** no — a single cause value legitimately
  spans two directions; carrying the direction on the payload is the right shape,
  not a structural smell.

### 2026-09-30 — fix lane round 2 (Opus 4.8): the fork was REFUSED as Codex, and the message vanished
- **New user report (after r1's copy fix deployed):** a container-recorded Claude
  session, project now `direct`, armed the fork bar (r1 copy correct) but on Fork
  errored `fork failed: <id> is an Orchard-owned (Codex) transcript…`; a subsequent
  typed message did nothing and was gone after reload. Deploy confirmed current:
  service ActiveEnterTimestamp 2026-09-30 06:27 > the r1 fix mtimes (≤ 05:33).
- **Root cause (verified FIRST, two independent defects):**
  1. SERVER — `startSession`'s FEAT-037 P2b fork guard (`src/server/agent-bridge.ts`
     ~5608) refused the fork whenever `resolveOrchardSessionFile` found ANY Orchard
     transcript for the id. Since FEAT-144 the server MIRRORS every Claude-store
     transcript into that same store under provider `anthropic`, so the guard now
     hit for every mirrored Claude session and misclassified it as Codex. Confirmed
     on the user's real data: `~/.local/share/claude-station/transcripts/anthropic/
     -workspace-<proj>/<id>.jsonl` exists beside the CLAUDE-store transcript.
  2. CLIENT — `onEvent`'s fatal-error branch (`public/app.js` ~11912) latched
     `sessError` and returned WITHOUT reclaiming `pendingStart`, so a refused fork's
     optimistic bubble stayed painted, the composer stayed empty, and reload
     destroyed the typed text (steps 3–4: silent message loss).
- **Fix (unstaged):**
  - `src/server/agent-bridge.ts` — the guard now keys on the transcript's PROVIDER:
    refuse only when `orchardHit.provider !== CLAUDE_MIRROR_PROVIDER` ('anthropic').
    A mirrored Claude session forks via the CLAUDE store as normal (planFork stages
    the CLI store file); a real Codex capture ('openai') is still refused. Imports
    `CLAUDE_MIRROR_PROVIDER` from `orchard-transcripts.ts`.
  - `public/app.js` — a fatal error with a live `pendingStart` (a start/fork that
    never began) now routes through the existing `rollBackPendingStart()` (same
    recovery the non-fatal pre-ack branch uses): the phantom bubble is removed and
    the typed text returns to the composer, with the error still shown + latched.
- **Verified:** `node scripts/verify-bug-215-r2-container-fork-codex-misclassify.mjs`
  → 16/16. PART A (real modules, real-shaped scratch fixture = container-encoded
  Claude transcript + its `anthropic` mirror): resolver names provider `anthropic`;
  PRE-FIX guard predicate (`dirs.some(hit)`) REFUSES (synthesized pre-fix MUST-FAIL);
  POST-FIX predicate ALLOWS; a Codex 'openai' capture still REFUSES (anti-regression);
  planFork stages container→direct byte-identical, original untouched. PART B (real
  scratch server, raw fork `start` frame through the ACTUAL guard): no "Orchard-owned
  (Codex)" refusal; `ack.fork.forked=true`, sourceEncodedDir=`-workspace-<proj>`, plus
  the staging status — the running guard staged the fork. PART C (real app.js in
  happy-dom): the real `startTurn(fork:true)` arms pendingStart+bubble, the REAL fatal
  fork-refusal frame is fed through the REAL `onEvent`, and the message is RECLAIMED
  into the composer + bubble removed + error surfaced. MUST-FAIL confirmed: PART C
  against the HEAD (pre-fix) app.js snapshot → message LOST (composer empty) + phantom
  bubble REMAINS (2/16 fail). `npm run gate` → PASS (exit 0).
- **Step 1 (first send) checked — NOT a loss:** `explainUnresumable` on the first
  plain send emits `needsFork`, which `armNeedsFork` handles by calling
  `rollBackPendingStart` BEFORE the fatal path — the first message is returned to the
  composer, not dropped. The loss was only at the FORK send (the fatal refusal).
- **Anti-regressions:** `verify-bug-forkbar-direction` 16/16 (r1 copy intact both
  directions). `verify-resume-refusal` 11/13 — the 2 failures are PRE-EXISTING on
  clean HEAD (identical result against the HEAD app.js snapshot), a bit-rotted suite,
  NOT this change.
- **regressed-from:** the guard is FEAT-037 P2b's; it went wrong when FEAT-144 added
  the `anthropic` mirror into the same store the guard scanned (a presence check that
  was correct until a second provider shared the store).
- **related:** BUG-213 (a refused fork retries as a plain resume of its source) —
  my client fix routes the fatal case into `rollBackPendingStart`, which re-arms
  `resumeOnNextSend=source`; that is BUG-213's known behaviour and is unchanged by
  this fix (consistent with the existing non-fatal pre-ack path). When BUG-213 makes
  `rollBackPendingStart` preserve fork intent, the fatal case inherits it for free.
  For THIS container→direct case the re-armed plain resume can't resume (that is why
  it needs a fork) so it simply re-arms the fork bar — no silent misdirection.
- **HIGH-STAKES (§N):** session-lifecycle + regression-prone (same files as
  BUG-090/BUG-138/BUG-215-r1). My suite is NOT the last word — an independent
  clean-room verify is warranted, specifically: (a) a REAL pre-fix SERVER build run
  of PART B (I proved the server MUST-FAIL at the predicate level over real data, not
  by reverting the built server), and (b) a real Claude-auth fork round-trip that
  writes the forked transcript and reloads (the SDK end-to-end harness is bit-rotted,
  same limit r1/BUG-090 hit) — `Verified-by:` stays PENDING.
- **Deploy note:** server (agent-bridge) + client (app.js) both changed — a client
  reload alone is NOT enough; the service must be restarted for the guard fix to take
  effect. Not restarting here per charter; orchestrator to schedule.

### 2026-09-30 — fix lane round 3 (Opus 4.8): the fork worked but the AGENT MEMORY didn't carry over
- **New user report (after r2 deployed):** the container→direct fork now succeeds,
  but the forked session says "my saved memory notes didn't carry over — the host
  uses a different memory folder, so this session started without them."
- **Hypothesis verified FIRST (real dirs, read-only):** Claude auto-memory lives at
  `~/.claude/projects/<encodedDir>/memory/*.md`, and the encodedDir follows the CLI's
  cwd. The container session's cwd was `/workspace/<proj>` → memory written to
  `-workspace-<proj>/memory`; the now-direct fork's cwd is the host path →
  `-home-…-<proj>/memory`, a DIFFERENT dir. Confirmed on the user's real data: the
  container-encoded dir holds 47 memory files (incl `MEMORY.md`, feedback_*, project
  notes); the host-encoded dir's `memory/` was created empty at the fork time and
  holds 0. (The `C--Users-…` Windows-origin dirs also carry memory — legitimately
  separate machines, NOT to be merged.) So the agent's statement was correct.
- **Design chosen (ARCH-010):** ONE canonical memory dir per project, both encodings
  share it. Rejected (a) copy-on-fork — two copies that diverge, the exact defect
  ARCH-010 names. Chosen: `canonicalMemoryDir(project)` declared once in memories.ts,
  ANCHORED ON THE CONTAINER STORE DIR (`-workspace-<id>/memory`) because the
  containerised CLI can only write memory into its store dir (bind-mounted from
  `containerHistoryDir`), and moving that host side would recreate every container
  (desiredBinds is the drift oracle) — so it is the one dir both modes can share
  WITHOUT touching container mounts. The host/`direct` encoding's `memory` is made a
  SYMLINK to it by `ensureUnifiedMemoryDir`, called from `startSession` before the CLI
  spawns. One physical dir, no second place able to hold a different answer; the
  memories API reads it once (realpath-deduped). Verified the CLI reaches memory
  through the symlink at the fs level (readdir/readFile the CLI uses) — a real
  auth'd CLI drive was not done (SDK harness bit-rotted, same limit as r1/r2).
- **Merge never loses:** `ensureUnifiedMemoryDir` merges any files a pre-existing
  host-encoded dir holds into the canonical dir before symlinking — exact byte-dups
  are dropped, a true name clash keeps BOTH (host copy renamed `<base>.from-<enc>-<ts>.md`
  and reported). Runs for every isolation mode (container start also funnels prior
  direct memory into the canonical dir it reads), idempotent, and non-fatal (a
  failure is a status/error event, never breaks the session — same discipline as the
  start snapshot).
- **Changed (unstaged):**
  - `src/server/memories.ts` — `canonicalMemoryDir`, `ensureUnifiedMemoryDir`
    (+ `mergeInto`), and realpath-dedupe in `listMemories`; header doc updated.
  - `src/server/agent-bridge.ts` — import + call `ensureUnifiedMemoryDir(opts.project)`
    in `startSession` before minting the id / spawning; non-fatal, emits a status when
    it links/merges/conflicts.
  - `scripts/verify-bug-215-r3-memory-carryover.mjs` — new repro/verify (synthetic names).
- **Verified:** `node scripts/verify-bug-215-r3-memory-carryover.mjs` → 22/22. PART A
  (real memories.ts over a real-shaped fixture: populated container-store memory incl
  MEMORY.md, EMPTY host dir, separate Windows dir): MUST-FAIL pre-fix — the host/direct
  dir the fork reads is EMPTY (0 files) → the amnesia; after the fix the host dir is a
  symlink resolving to canonical, the direct session reads all 5 files byte-identical,
  `listMemories` returns 6 (5 shared deduped + 1 Windows), idempotent. PART A2
  (merge): dup dropped, clash keeps both, no file lost, coincident-encoding no-op.
  PART B (real scratch server, real `GET /api/projects/:id/memories`): the panel
  returns the carried-over memory exactly once. PART C: startSession wires the call
  before spawn, non-fatal. Anti-regressions: `verify-bug-215-r2` 16/16,
  `verify-bug-forkbar-direction` 16/16. `npm run gate` → PASS (exit 0).
- **Real user data:** NOT modified. Backup of both encodings' memory taken first
  under the scratch root (`scratchRoot()` from `scripts/lib/scratch.mjs`), dir
  `bug-215-r3-memory-backup-20260930T073806` — full path reported to the
  orchestrator out-of-band, kept out of this public ticket.
  The fix self-heals the affected project at the next DIRECT session start (after a
  service restart deploys this), replacing the empty host `memory/` with a symlink to
  the container dir. To do it immediately (host memory dir is empty, so `rmdir` is
  safe), the one-off `rmdir`s the project's host-encoded `<store>/<host-enc>/memory`
  then `ln -s` the container-encoded `<store>/<container-enc>/memory` into its place
  (`<store>` = `~/.claude/projects`; the two encodings are the host-path and
  `/workspace/<id>` forms). Exact command reported to the orchestrator out-of-band.
  (a NEW session picks it up; the already-running forked session loaded memory at
  start and won't retroactively gain it). NOT run here.
- **regressed-from:** not a prior fix's regression — a pre-existing gap the
  container→direct fork (BUG-090/BUG-215 r1/r2) exposed once forking across isolation
  became routine. Memory has ALWAYS been per-encoded-dir; nobody hit it until sessions
  moved between encodings.
- **Deploy note:** server-only change (agent-bridge + memories) — a client reload is
  NOT enough; the service must be restarted for `startSession` to run the unify. Not
  restarting here per charter; orchestrator to schedule.
- **HIGH-STAKES (§N):** data-adjacent (moves/symlinks a user memory dir) +
  session-lifecycle + regression-prone (same fork path as BUG-090/138/215). My suite
  is not the last word — an independent clean-room verify is warranted, specifically:
  (a) a real auth'd container→direct fork that then reads memory through the symlink in
  a live CLI (the fs-level proof stands in for it here), and (b) a project that ran
  BOTH ways before the fix (real split memory) merged with a genuine name clash.
  `Verified-by:` PENDING.
