# FEAT-015 — Restart the server without killing live sessions

- **Status:** VERIFIED — in-flight driven `direct` sessions now survive a server
  restart (process + transport); one honest residual transport gap documented
  (no live-follow-up-turn on the still-running CLI — the thread continues by
  resume-from-disk). See the 2026-08-04 implementation entry.
- **Status (history):** OPEN (design) — answers a direct user question
- **Severity:** high (root cause of this session's recurring session-death + sub-agent orphaning)
- **Reported:** 2026-08-03 by user

## Question
"How will we solve restarting while this session is going and other sessions?
Rare enough, or is there a solution — did you already implement any?"

## Honest current state
NOT solved. The detach/reattach work (committed) handles a **socket** dropping
(browser reload, tab switch) — the session survives that. It does NOT handle the
**server process dying**: the live bridges (SDK `query` objects) and the CLI
subprocesses they spawned live inside the server process, so a restart takes them
all down. An in-flight turn is interrupted; the conversation HISTORY survives
(it's on disk), so a resume-from-disk loses only the current turn, not the thread.

## Is it rare enough?
- Normal use: yes. You rarely restart, and if you do it at a PAUSE between turns,
  nothing is lost — history is on disk and resume re-attaches.
- Active development (now): no — server changes are frequent. Mitigations:
  restart between turns; the staged idle-watcher auto-restarts the moment
  `liveBridges` hits 0.

## The robust fix (if we want restart-any-time)
Decouple the session process from the server (tmux/daemon model):
1. Spawn each session's CLI in its OWN process group / detached, so it survives
   the server dying.
2. On server boot, RE-ADOPT running session processes (discover by pid/tag, like
   `processes.ts` already scans /proc) and reconnect their stdio/transport.
3. The bridge becomes a reconnectable proxy, not the owner of the subprocess.
Significant work; the SDK's `spawnClaudeCodeProcess` hook (already used for
containers) is the seam. Worth it only if any-time restart becomes a real need.

## Recommendation
Short-term: restart at pauses + idle-watcher (installable as a durable helper).
Long-term: the daemonize+re-adopt design above, as its own feature once the
manual pattern proves painful enough to justify it.

## Activity log (APPEND-ONLY)
### 2026-08-03 — orchestrator
- Logged in answer to the user's question. No code yet; documents the honest gap
  and the two paths. Ties to DEPLOY-003 (the immediate "4317 is stale" instance).

### 2026-08-04 — grounded investigation (READ-ONLY, live process tree + code)
Dispatched to determine the ACTUAL mechanism orphaning the in-flight background
sub-agents of the long-running orchestrator session
`87564f3e-aa58-4f5a-b116-6711392ab2a4` ("previous Claude Code process exited";
dashboard shows nothing running during those windows). Evidence, not theory.

**1. Process tree (decisive).** The claude-station server runs as a systemd
**user** unit (`systemctl --user`, not system — that is why `systemctl status`
showed `MainPID=0`):
- `MainPID=4078893` = `/usr/bin/node ~/projects/claude-station/src/server/index.ts`
  in cgroup `…/user@1000.service/app.slice/claude-station.service`.
- `ps --ppid 4078893` → **exactly one child** claude process:
  `PID 4131704 = …/claude-agent-sdk-linux-x64/claude … --resume=87564f3e-aa58-4f5a-b116-6711392ab2a4 --input-format stream-json --permission-prompt-tool stdio --include-partial-messages`.
  So the orchestrator's model CLI **is a direct child of the station server
  process** (not independent), spawned by the SDK `query()` over stdio.
- `GET /api/sessions` (read-only) confirms it is a **live driven bridge**:
  `{ stationSessionId: "cs-msepip7x-4", sdkSessionId: "87564f3e…", isolation:
  "direct", busy: true, totalCostUsd ~30.6 }`. So the dashboard is driving a
  session that works ON claude-station itself.
- `pstree -p 4131704`: its only child PROCESSES are the tool `bash` and the
  `serena` MCP (`uv → python → ts-lsp`). The many `{claude}(NNN)` entries are
  **threads of 4131704, not child processes**. **Task sub-agents run IN-PROCESS
  inside the single orchestrator CLI process** — there are no per-sub-agent
  `claude` PIDs. Consequence: sub-agents cannot outlive their host CLI process;
  when 4131704 dies, every in-flight Task sub-agent dies with it.

**2. Code trace — how the driven subprocess is owned & what each event does.**
- Spawn: `agent-bridge.ts:555 this.#q = query({ prompt: this.#input, options })`.
  For `isolation:"direct"` (this session) NO `spawnClaudeCodeProcess` override is
  set (`agent-bridge.ts:472-509`), so the SDK spawns the `claude` CLI with its
  default `child_process.spawn` — a normal child in the server's **process group
  and systemd cgroup**. There is **no `detached:true` anywhere** on this path
  (`rg detached` finds only `git.ts:152`, an unrelated terminal-opener). The
  container path instead spawns `docker exec -i` via `spawnClaudeCodeProcess`
  (`agent-bridge.ts:485`).
- (a) **Server restart → EXITS the subprocess (orphans everything).** systemd
  unit has `KillMode=control-group`, `KillSignal=15`, `Restart=on-failure`,
  `RestartSec=2`. `systemctl --user restart` (or any crash/redeploy) SIGTERMs
  the **entire control group** — 4131704 and all its descendants — regardless of
  what the server does. `shutdown()` (`index.ts:2136-2138`) only does
  `wss.close(); server.close(); exit` — it does **not** detach or hand off the
  child. The child (and all in-process sub-agents) die.
- (b) **ws `close` / dashboard reload → does NOT exit the subprocess (safe).**
  Both the raw-drop path `ws.on('close')` (`index.ts:2046`) and the explicit
  `{type:'close'}` command (`index.ts:2025`, the BUG-018 fix) route a busy
  session to `session.detach()`. `detach()` (`agent-bridge.ts:712-715`) merely
  swaps `#emit` to a no-op sink — **the `#q` query object and the child CLI are
  untouched**; the turn and its sub-agents keep running, transcript keeps being
  written. A returning socket `attach()`s + `replayPending()`/`replayAgents()`.
- (c) **`detach()` (BUG-018)** — same as (b): socket-only; subprocess survives.
- (d) **reattach** — `attach()` swaps `#emit` back to the live socket; no
  process change.
  So of the four events, **only server restart EXITS the subprocess.**

**3. Root mechanism.** The orphaning is a **server-process death killing its
child CLI (and the in-process sub-agents)** — i.e. a **claude-station / systemd
restart**, exactly the gap this ticket already documents. It is NOT a dashboard
reload/detach (those are socket-only and proven safe by BUG-018 +
verify-detach/verify-close-busy-detach). The "dashboard shows nothing running"
during the window is the *restart* symptom: the fresh server boots with
`liveBridges = 0`; the session is only rediscovered from the on-disk transcript,
and must be re-driven/resumed. Under `KillMode=control-group` this is total: even
the sub-agent threads inside 4131704 go down with the process group.

**4. Auto-compaction reality (honest boundary).** No evidence that context
compaction cycles the process. The SDK-spawned CLI compacts **in place** within
the same PID (4131704) — the query object and stdio pipes persist; no exit, no
new PID. The string **"previous Claude Code process exited" is NOT in this repo
nor in `node_modules/@anthropic-ai/*`** (grepped) — it is a **harness/CLI-level**
message emitted when a `--resume` finds its prior owning process gone. That is a
process-death signature (a restart), not an in-place compaction. Whether the
outer harness driving the *dashboard operator* ever compacts by cycling ITS own
process is **outside claude-station's code and not observable from here** — I
will not guess it. Grounded conclusion: the reproducible, in-repo orphan cause is
the restart in (3); compaction of the driven CLI is in-place and does not orphan.

**5. Mitigation sketch (FEAT-015 daemonize + re-adopt) — feasible, with one
concrete correction to the existing sketch.** Two coupled problems must both be
solved for a driven `direct` session to survive a server restart:
- **Cgroup reachability (new finding).** `detached:true`/`setsid` ALONE is
  insufficient here: `KillMode=control-group` kills the whole
  `claude-station.service` cgroup on stop, so a merely-detached child in the same
  cgroup still dies. The child must be launched into a **separate cgroup/scope** —
  e.g. `systemd-run --user --scope claude … --resume=<id>` (a transient scope
  systemd will not reap on the service's restart) — via a `direct`-path
  `spawnClaudeCodeProcess` override (the same SDK seam the container path already
  uses at `agent-bridge.ts:485`). Alternatively set `KillMode=mixed` so only the
  MainPID is signalled, then detach the child — but a transient scope is cleaner
  and survives crashes too.
- **Transport ownership (the real blocker, already hinted in this ticket).** The
  SDK talks stream-json over the child's stdio **pipes owned by the dying
  parent**; those FDs break when the parent exits even if the child lives. True
  survival needs the transport decoupled from the parent — run the CLI under a
  reconnectable channel (a named socket/FIFO, or a `tmux`/scope supervisor whose
  I/O the new server re-opens). On boot, **re-adopt** by scanning `/proc` for
  `claude … --resume=<sdkSessionId>` (`processes.ts` already scans /proc) and
  reconnecting; the `AgentSession` becomes a reconnectable proxy rather than the
  subprocess owner. Because sub-agents are in-process (finding 1), re-adopting the
  one CLI PID recovers the whole in-flight fan-out for free — no per-sub-agent
  bookkeeping needed. Non-trivial (mainly the transport-handoff), but the seam
  and the /proc scanner already exist.

**Honesty on limits:** could not exercise a restart (forbidden — must not touch
:4317). The lifecycle-per-event conclusions are from code + the live tree + the
existing verify-* evidence, not from a fresh kill test. The harness-level
compaction of the *operator's own* process is genuinely outside this repo and
was not determined.

### 2026-08-04 — IMPLEMENTED (process + transport survival, re-adopt, verified)

**Understood.** Inherited the full grounded investigation above and validated its
two coupled blockers with live probes before writing any code:
- *Cgroup reachability.* Confirmed the real unit is `claude-station.service`
  (systemd `--user`, `KillMode=control-group`, MainPID 4078893 = :4317 — never
  touched). Confirmed a `systemd-run --user --scope` child lands in a SEPARATE
  cgroup (`…/app.slice/run-*.scope`, not under `claude-station.service`), and —
  the decisive primitive — that `systemctl --user stop` of a transient
  `KillMode=control-group` service kills a normal child but SPARES a `--scope`
  grandchild. So a scope escapes the control-group kill; `detached`/`setsid`
  alone would NOT (it escapes a process-group kill, not a cgroup kill).
- *Transport ownership.* Re-confirmed from the SDK types: `query()` owns the
  stdio transport and `spawnClaudeCodeProcess` is the only injection seam
  (synchronous return of a `SpawnedProcess`). A surviving CLI whose stdio pipes
  die with the parent is useless (stdin EOF ends input, stdout EPIPE kills it).

**Design choice — a broker in a scope, not just a detached child.** Neither piece
alone suffices, so both are solved together for isolation `direct`:
1. The CLI is launched under a tiny broker (`src/server/session-host.mjs`) placed
   in its OWN transient systemd scope via `systemd-run --user --scope` — the same
   `spawnClaudeCodeProcess` seam the container path already uses
   (`agent-bridge.ts`). The broker OWNS the CLI's stdio: it keeps stdin OPEN and
   always DRAINS stdout, so a dead server neither EOFs nor EPIPEs the CLI. The
   in-flight turn (and its in-process Task sub-agents) runs to completion and the
   CLI writes its own transcript to disk as usual. The server talks stream-json
   to the broker over a unix socket; a disconnect is survivable.
2. On shutdown the server HANDS OFF busy survivable sessions (does not close
   them); on boot it RE-ADOPTS surviving brokers (scans `dataDir()/session-hosts`
   for live host pids) and gracefully reaps them — a SIGTERM makes the broker EOF
   the CLI, which DRAINS the current turn (EOF is not an interrupt — same
   contract as `#input.end()`), writes the final transcript, and exits. The
   thread then continues by the normal, already-working resume-from-disk path.
3. The transport `kill()` only DISCONNECTS the socket (never reaps the
   broker/CLI), so a mere SDK abort / server exit leaves the CLI running; a
   GENUINE `AgentSession.close()` reaps the broker (CLI terminates). Handoff is
   gated on `busy` so an idle session still closes normally; a broker abandon net
   (`CLAUDE_STATION_HOST_ABANDON_MS`, default 120 s) bounds any leak if a server
   never returns. Survival is gated by `survivalEnabled()` (on by default;
   `CLAUDE_STATION_SURVIVE=0` kill-switch; auto-off when `systemd-run --user` is
   unavailable — an honest no-op that runs exactly as before, since a scope is
   the only thing that survives a control-group kill). Container / sandbox paths
   untouched; BUG-018 detach and BUG-020 replay unregressed (verified).

**HONEST residual transport gap (what still does NOT work, and why).** A restarted
server CANNOT inject a *brand-new turn* into the STILL-RUNNING surviving CLI. The
SDK owns the conversation transport inside `query()`: a fresh `query({resume})`
always SPAWNS a new CLI and runs its own init handshake — it cannot be handed the
mid-flight stream of an already-initialised CLI, and there is no SDK reconnect
API here to do so. What survival guarantees is that **no in-flight work is killed
or orphaned**: the turn + sub-agents finish and the transcript is written. The
restarted server re-adopts (drains + reaps) each survivor, and the thread
continues by resume-from-disk (a new turn on a fresh CLI reading the completed
transcript — already-working, verified end-to-end). This is the deliberate,
documented boundary, not a silent shortfall.

**Changed.**
- `src/server/session-host.mjs` (NEW) — the durable broker/supervisor.
- `src/server/survival.ts` (NEW) — `survivalEnabled()`, `spawnSurvivable()`
  (scope launch + a `SpawnedProcess` facade over the unix socket), `reapHost()`,
  `scanSurvivingHosts()`, `adoptSurvivingHosts()`.
- `src/server/agent-bridge.ts` — install the `direct` survival spawn override;
  track the broker handle; reap it on genuine `close()`; `survivable`/`handoff()`;
  `closeAllSessions(reason, {handoff})` (hand off busy survivors, close the rest).
- `src/server/index.ts` — boot re-adopt (`adoptSurvivingHosts`); shutdown hands
  off busy survivable sessions instead of `closeAllSessions(signal)`.
- `scripts/verify-restart-survives.mjs` + `package.json`
  (`verify:restart-survives`) — the faithful repro/fix harness.

**Verified (scratch only; :4317 and `claude-station.service` never touched; killed
by pid / own transient units; real service confirmed `active` and :4317 still
listening after every run):**
- `npm run verify:restart-survives` → **PASS 15/15.** Faithful mechanism: the
  scratch server runs as its OWN transient `--user` service (KillMode=
  control-group) and a "restart" is `systemctl --user stop` of that unit (a real
  control-group kill). **Phase A (FAILURE CONTROL, `CLAUDE_STATION_SURVIVE=0`):**
  the CLI is a plain child IN the service cgroup → the stop KILLS it mid-turn
  (`stillAlive:[]`) and the in-flight work never completes (marker absent) — the
  bug, reproduced. **Phase B (FIX, default):** the CLI pid is NOT in the service
  cgroup (escaped to a scope); after the stop the broker + CLI are STILL ALIVE;
  the in-flight turn COMPLETES after the server is dead (marker `SURVIVED`
  written by the surviving CLI); a fresh server RE-ADOPTS + reaps the broker (no
  orphan); a resume-from-disk follow-up turn works end-to-end
  (`RESUME-OK`, non-interrupted). Non-vacuous by construction (A must reproduce
  the death for the run to pass).
- `npm run verify:detach` → **PASS 7/7** (BUG-018 detach/reattach unregressed;
  broker transport is transparent to detach/reattach; no broker leaked after).
- `npm run verify:reattach-approval` → **PASS 11/11** (BUG-008 contract intact).
- `npm run verify:ui -- --offline` → **PASS 3/3.**
- `npm run typecheck` → **PASS** (tsc --noEmit, exit 0).
- Post-run hygiene each time: no leftover `session-host.mjs` procs, no leftover
  `claude-station-host-*` scopes, scratch dirs cleaned.

**Handoff / residual notes for a future agent.**
- The one remaining gap is the SDK live-reconnect (new turn on the still-running
  CLI). Closing it needs either an SDK API to adopt an existing stream, or a
  server-side stream-json re-implementation that bypasses `query()` for
  re-adopted sessions — out of scope here; resume-from-disk covers continuity.
- `adoptSurvivingHosts()` currently DRAINS-then-reaps survivors (safe, lossless).
  If live event-stream re-attachment is ever wanted, the broker already keeps the
  stream reachable over its socket — a future server could reconnect a relay and
  parse it directly instead of reaping.
- `verify:reattach-approval` runs `direct` sessions with survival ON by default
  now; kept green, so the broker is transport-transparent to the approval replay.

- 2026-08-06 — privacy scrub for public release (FEAT-049, sanctioned append-only exception): private names/paths neutralized (project aliases, home paths → ~).
