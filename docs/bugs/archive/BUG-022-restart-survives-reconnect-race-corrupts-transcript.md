# BUG-022 — a resume right after restart races a still-draining FEAT-015 survivor: two CLIs on one transcript, in-flight work silently lost

- **Status:** VERIFIED
- **Severity:** high (silent data loss + transcript corruption, defeats FEAT-015's core promise)
- **Area:** server / restart survival (`src/server/survival.ts`, `src/server/index.ts` boot re-adopt, `src/server/agent-bridge.ts` "already running" guard)
- **Reported:** 2026-08-04 by adversarial verification of FEAT-015

## Symptom
FEAT-015 claims: *"What survival guarantees is that no in-flight work is killed or
orphaned: the turn + sub-agents finish and the transcript is written."* This is **false**
in the exact case restart-survival exists for: a client reconnects and resumes the same
thread on the freshly-booted server **before** boot's re-adopt has finished draining the
old server's surviving broker. The fresh server's "already running — refuse a second
driver" guard (`index.ts:1778-1782`) only checks the **in-memory** `sessions` map of the
CURRENT process — which is always empty right after boot — so it does not see the
survivor at all. It accepts the resume, spawns a **second** `claude` CLI against the
**same `sdkSessionId`**, and that second CLI immediately appends a **new user turn** onto
the **same on-disk transcript file** the first (still-running, still mid-tool-call) CLI is
still writing to. The original in-flight turn's remaining work (in the repro: a background
`sleep` finishing, then a `Write` of a marker file) is **never completed** — it is silently
dropped, not "drained to completion" as documented — while the transcript file itself now
contains an interleaved mix of both turns' messages.

## Repro
Scratch-only, modelled directly on `scripts/verify-restart-survives.mjs` Phase B (own
transient systemd `--user --scope` services; never touches `:4317`/`claude-station.service`):

1. Start a scratch claude-station server (survival ON, the default) as its own transient
   systemd service (`KillMode=control-group`, matching production).
2. Drive a `direct` session with a turn that stays in-flight for a while: `Bash: sleep 25`,
   then `Write` a marker file, then reply `RACE-DONE-1`. Confirm the Bash tool-call is seen
   (turn genuinely in-flight) and a survival broker + CLI exist for it (`sdkSessionId` known
   from `session-init`).
3. `systemctl --user stop` the scratch service (a real control-group kill = "the restart").
   Confirm the broker + CLI are **still alive** (the fix's cgroup-escape working as
   designed).
4. Boot a **second** fresh server process pointed at the same `CLAUDE_STATION_DATA`. Its
   `listen()` callback fires `adoptSurvivingHosts()`, which SIGTERMs the old broker to start
   a graceful drain — but does **not await** it; the call returns immediately and the server
   starts accepting connections while the old CLI is still mid-`sleep`.
5. The instant the fresh server is healthy, open a websocket to it and send
   `{type:'start', resumeSessionId: <the same sdkSessionId>, prompt:'Reply with exactly
   RACE-DONE-2'}` — exactly what a dashboard auto-reattach or an impatient click does right
   after a restart, with zero awareness of `hostsDir()` survivors.
6. Observed: the fresh server sends an `ack` (not an `error`) — it accepted the resume.
   `/proc` scan confirms a **second** `claude` process now running with
   `--resume=<same sdkSessionId>`, while the **original** survivor CLI (confirmed by pid) is
   **still alive at the same instant**. Two distinct `claude` PIDs, same `sdkSessionId`,
   concurrently.
7. After both settle, the on-disk transcript
   (`~/.claude/projects/<encoded-cwd>/<sdkSessionId>.jsonl`) shows the two turns
   **interleaved into one file**: the original prompt, its Bash tool-calls, a background-task
   notification for the still-running `sleep` — then, spliced in mid-stream, the SECOND
   CLI's new user turn (`"Reply with exactly RACE-DONE-2"`) and its reply. The marker file
   the FIRST turn was supposed to write (proof its `sleep`+`Write` steps completed) **never
   appears** — the original in-flight work is silently lost, contradicting the "drains to
   completion" guarantee.

Evidence captured this run (`sdkSessionId = 6e04bb41-a21e-47fb-bb6e-5fcdbf6861c2`):
- Old broker/CLI (broker pid 4182229, CLI pid 4182236) confirmed alive right up to and past
  the moment the second resume was accepted.
- Second CLI: pid 4182493, cmdline includes `--resume=6e04bb41-...` (same id).
- `server2`'s racing "start" got a normal `ack` (`stationSessionId: cs-mserh8cr-1`), no
  `error` — the guard never fired.
- Its `turn-end` for the racing prompt: `{"subtype":"success","interrupted":false,
  "isError":false,"durationMs":12,"numTurns":0,"resultText":""}` — an anomalously instant,
  content-free "success", itself a symptom of the two processes fighting over the same
  session.
- Transcript (29 lines, all individually valid JSON, all under the one `sessionId`) shows,
  in order: the original prompt → Bash sleep attempts → a `<task-notification>` for the
  still-running background sleep → then **a second, unrelated user turn**
  (`"Reply with exactly RACE-DONE-2"`) spliced in → its assistant reply
  (`"RACE-DONE-2"`). The original turn's own final reply (`RACE-DONE-1`) and its marker
  Write **never appear anywhere** — genuinely lost, not merely delayed.
- The marker file was confirmed **absent** after the full run.

## Expected
Either:
- The fresh server's "already driving this session" guard must consult **on-disk survivor
  state** (`hostsDir()` / `scanSurvivingHosts()`), not just its own empty in-memory
  `sessions` map, and refuse (or queue/wait for) a resume of a `sdkSessionId` that still has
  a live, un-reaped broker — the same way it already refuses a second in-process driver
  (`index.ts:1778-1782`); or
- Boot re-adopt must be made a genuine precondition of accepting new work: e.g. hold new
  `start`/resume requests for an in-flight `sdkSessionId` until `adoptSurvivingHosts()` has
  confirmed that particular broker fully drained and exited, not just fired-and-forgot its
  SIGTERM.
Either way, "no in-flight work is killed or orphaned" must hold even when a client
reconnects immediately — the documented residual gap ("no live follow-up turn on the
still-running CLI") should be the ONLY limitation, not silent transcript corruption and
lost work.

## Fix direction
- `scanSurvivingHosts()` / `HostStatus` already carries `stationSessionId` and `resumeHint`
  (the `sdkSessionId`) in the broker's status file (`survival.ts:73-74`, written by
  `spawnSurvivable`) — this is exactly the data needed. Add a lookup
  (`survivingHostForSdkSession(sdkSessionId)`) and call it from the same guard site as
  `index.ts:1778-1782`, alongside the existing `liveSessions().find(...)` check, so a
  survivor-in-drain is treated the same as an in-process `running` session (refuse, or
  surface a clear "still finishing its last turn after a restart, try again shortly"
  status instead of silently double-driving it).
- Alternatively/additionally, make `adoptSurvivingHosts()` awaitable-to-drained (poll
  `HostStatus.state === 'exited'` or pid death) and gate the HTTP/WS listener's acceptance
  of `start` for a matching `sdkSessionId` on that drain finishing — but the in-memory guard
  fix above is cheaper and matches the existing BUG-008/BUG-018 pattern already in the file.
- Whichever direction: add a repro case to `scripts/verify-restart-survives.mjs` (or a new
  `verify:restart-survives-race` harness) that fails today and passes once fixed — the
  existing Phase B harness only resumes AFTER re-adopt fully reaps
  (`verify-restart-survives.mjs:324-327` waits for `reaped` before opening `c2`), which is
  exactly why this hole was never caught.

## Context pack
- Files/functions in play:
  - `src/server/index.ts:1778-1832` — the WS `start` handler's "already running" guard
    (in-memory only) and the `startSession(...)` fallthrough that spawns a fresh CLI via
    `options.resume`.
  - `src/server/index.ts:2086-2091` — boot-time `adoptSurvivingHosts()` call: fire-and-forget,
    not awaited, does not block the listener from accepting connections.
  - `src/server/survival.ts:270-311` — `scanSurvivingHosts()` / `adoptSurvivingHosts()`;
    `HostStatus` already has `stationSessionId`/`resumeHint` needed for a cross-process guard.
  - `src/server/agent-bridge.ts:1386` (`startSession`), `agent-bridge.ts:514-537` (survival
    spawn override) — where the second CLI actually gets spawned via `spawnClaudeCodeProcess`.
- Related tickets: FEAT-015 (this is a hole in its fix), BUG-018 (detach, the pattern the
  fix direction reuses), BUG-008/BUG-020 (reattach approval/agent replay — same "don't
  double-drive a session" family of guard).
- Repro test: none yet automated; manual repro above modelled on
  `scripts/verify-restart-survives.mjs` Phase B. Add `verify:restart-survives-race` (or
  extend the existing script with a Phase C) as part of the fix.
- Known dependencies / blockers: none — the data needed (`stationSessionId`/`resumeHint` in
  `HostStatus`) already exists on disk; this is a missing guard, not a missing capability.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-04 — adversarial verification (READ-ONLY audit + scratch repro)
- **Understood:** Set out to refute FEAT-015's "restart-survives" fix. Read the ticket, the
  broker (`session-host.mjs`), `survival.ts`, and the `agent-bridge.ts`/`index.ts` wiring.
  The ticket's own "residual gap" section only claims the boundary is "no live follow-up
  turn on the still-running CLI"; it asserts drained-then-reaped survivors are otherwise
  lossless. Suspected the boot-time re-adopt (`adoptSurvivingHosts`, fire-and-forget SIGTERM,
  not awaited) combined with the WS `start` handler's PURELY in-memory "already running"
  guard (`index.ts:1778`, which is necessarily empty on a fresh boot) would let a client
  resume the same `sdkSessionId` while the old broker was still draining.
- **Verified (scratch only, modelled on `verify-restart-survives.mjs` Phase B; own
  transient `--user --scope`/`--unit=cs-race-*` services; `:4317`/`claude-station.service`
  never touched — confirmed `active`/listening before, during, and after):**
  - Reproduced the race twice. Both times: the fresh server ACCEPTED (`ack`, no `error`) a
    resume of an `sdkSessionId` whose broker+CLI from the prior server were confirmed alive
    at that exact instant (`pidAlive` check). `/proc` scan found a second, distinct `claude`
    PID with `--resume=<same id>` in its cmdline running concurrently with the original.
  - Second run additionally captured the on-disk transcript: 29 lines, all valid JSON, but
    with the SECOND turn's prompt/reply spliced into the middle of the FIRST turn's
    still-in-progress tool-call sequence (a `<task-notification>` for its still-running
    background `sleep`, immediately followed by an unrelated new user turn). The first
    turn's own final reply and its proof-of-completion `Write` (a marker file) **never
    appeared** — the "drains to completion" guarantee did not hold.
  - Other attack surfaces tried and found to HOLD (not filed as separate bugs): no
    orphaned `run-*.scope`/broker/socket across a normal close/restart cycle
    (`systemctl --user list-units 'run-*.scope'` empty before/after, matching this ticket's
    own verified hygiene claims); `CLAUDE_STATION_SURVIVE=0` and the
    `systemd-run`-unavailable path were not re-tested live here (already covered by the
    ticket's own Phase A control and code-reviewed as an honest early-return in
    `survivalEnabled()`/`systemdRunAvailable()`) — flagged as NOT independently re-verified
    in this pass, scope was spent on the race instead.
  - Did not exercise: two servers both mid-`shutdown()` simultaneously (requires a
    non-standard systemd config to make `restart` overlap-start; not reachable via
    `systemctl --user stop`+manual second spawn, which is what this repro used instead and
    found sufficient to demonstrate the underlying guard gap).
- **Changed:** none — filed this ticket only, per instructions. No FEAT-015 source touched.
- **Still open / handoff:** fix the guard (see Fix direction). A good first PASS check for
  whoever picks this up: extend `scripts/verify-restart-survives.mjs` with a Phase C that
  does NOT wait for re-adopt before opening the second websocket (unlike the existing Phase
  B, which waits for `reaped` first) — it should currently FAIL the same way this manual
  repro did, and should PASS (second resume refused or queued, first turn's marker
  eventually appears, transcript has no interleaved second turn) once the guard lands.

### 2026-08-04 — FIX + automated repro (VERIFIED)
- **Understood:** Confirmed the two-part hole exactly as filed, and found a second,
  overlapping defect the repro depends on:
  1. **The guard gap (the filed bug).** The WS `start`/resume guard (`index.ts:1778-1832`)
     only consulted the in-process `liveSessions()` map, which is empty right after a boot,
     so a resume racing boot's fire-and-forget `adoptSurvivingHosts()` was accepted and
     spawned a SECOND `claude --resume` on the same transcript.
  2. **The filed Fix-direction's data assumption was wrong for the actual repro case.**
     `HostStatus.resumeHint` only carries the sdkSessionId for a RESUME; the repro (and the
     common case) is a FRESH `direct` session whose id is minted by the CLI at `init` and
     was never written to the broker status file — so a resumeHint-only match could never
     see it. Fixed by having the BROKER learn its CLI's real sdkSessionId from the first
     stream-json `init` line and persist it (`HostStatus.sdkSessionId`).
  3. **Re-adopt truncated in-flight turns (why the "marker lands" guarantee was also false).**
     The broker's graceful reap ended the CLI's stdin immediately; empirically the `claude`
     CLI treats stdin-EOF as "no more input" and exits at the next opportunity WITHOUT
     waiting for a pending tool call (observed: clean `exitCode 0` at ~14–23s, mid-`sleep 30`,
     Bash tool_use present but no Write, no `result`). So even absent the racing resume, a
     boot re-adopt that hit a still-in-flight turn LOST its later steps + reply. FEAT-015's
     existing Phase B never caught this because its marker lands during the pre-boot idle
     window and re-adopt only fires after the turn already finished.
- **Changed:**
  - `src/server/survival.ts` — added `HostStatus.sdkSessionId` and
    `survivingHostForSdkSession(sdkSessionId)` (matches a still-alive broker on its recorded
    sdkSessionId, or on `resumeHint` for the brief pre-`init` window).
  - `src/server/index.ts` — the resume guard now, after the empty-on-boot in-memory check,
    consults `survivingHostForSdkSession(cmd.resumeSessionId)` and REFUSES with an honest,
    retryable error (`fatal:false`) while a survivor is still alive/draining. No path can now
    run two `claude --resume` on one sdkSessionId.
  - `src/server/session-host.mjs` — the broker now parses stdout stream-json to (a) capture
    and persist the CLI's real sdkSessionId at `init` and (b) track turn boundaries; graceful
    reap now HOLDS stdin-EOF until the in-flight turn's `result` lands (idle → EOF at once),
    with a 90s force-EOF backstop then SIGTERM/SIGKILL escalation. Re-adopt/close now truly
    drains a mid-tool turn instead of truncating it.
  - `scripts/verify-restart-reconnect-race.mjs` (+ `npm run verify:restart-reconnect-race`)
    — new scratch harness (own transient `--user` services; never touches `:4317`) that
    drives a slow in-flight turn, control-group-kills the first server, boots a second, and
    resumes the SAME sdkSessionId the instant it is healthy — DURING the drain window.
- **Verified (scratch only; `:4317`/`claude-station.service` untouched; killed only by
  pid/unit; every scope/socket/broker cleaned up):**
  - `verify:restart-reconnect-race` — non-vacuous: **PRE-FIX 6/10** (racing resume ACCEPTED,
    a second `claude --resume=<id>` coexisted with the survivor, transcript CORRUPTED with the
    spliced `RACE-RESUME-2` turn), **POST-FIX 10/10** (resume REFUSED with the retryable
    error, NO second CLI ever coexisted, original turn COMPLETED — its `SURVIVED` marker
    landed, transcript holds the original turn and no spliced second turn). Reverting all
    three source files via `git stash` reproduced the pre-fix failures; restoring passed.
  - No regressions: `verify:restart-survives` **15/15**, `verify:detach` **7/7**,
    `verify:reattach-approval` **11/11**, `verify:ui -- --offline` **3/3**, `typecheck` clean.
- **Residual boundary (unchanged, still honest):** a restarted server still cannot inject a
  brand-new live follow-up turn into the STILL-RUNNING surviving CLI (the SDK owns the
  transport inside `query()`); the thread continues by resume-from-disk once the survivor has
  drained + reaped. The guarantee this ticket restores is narrower and exact: no double-drive,
  no transcript corruption, no lost in-flight work.
