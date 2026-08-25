```orchard-ticket
{
  "id": "BUG-022",
  "type": "bug",
  "title": "Immediate reconnects no longer corrupt a surviving session",
  "summary": "Immediate reconnects can no longer start a second driver while earlier work is still draining after restart. This prevents interleaved transcript writes and preserves the original turn’s remaining work. Restart, detach, reattachment, interface, and standing checks passed.",
  "impact_if_we_wait": "Without the fix, an immediate reconnect can silently discard in-flight work and corrupt that session’s transcript. Bounded: the race affects one resumed session during restart recovery, not unrelated sessions or stored project data.",
  "current_need": "Treat the ticket as closed: the pre-fix race failed, corrected restart and reattachment behavior passed, and type checking stayed clean.",
  "severity": "high",
  "area": "Restart session survival",
  "reported": "2026-08-04",
  "reported_by": "bug-hunt workflow",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-04",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "An immediate post-restart resume cannot create two concurrent drivers for one session",
    "Surviving in-flight work completes before another driver may resume the session",
    "Concurrent processes cannot interleave turns in one transcript",
    "A rejected or delayed resume clearly reports that earlier work is still finishing"
  ],
  "code_refs": [
    {
      "path": "src/server/index.ts",
      "symbol": "start handler",
      "note": "Checks for an existing driver before allowing a resumed session to start"
    },
    {
      "path": "src/server/index.ts",
      "symbol": "adoptSurvivingHosts",
      "note": "Boot invokes survivor adoption while the listener begins accepting connections"
    },
    {
      "path": "src/server/survival.ts",
      "symbol": "scanSurvivingHosts",
      "note": "Reads persisted stationSessionId and resumeHint values used to identify surviving drivers"
    },
    {
      "path": "src/server/survival.ts",
      "symbol": "adoptSurvivingHosts",
      "note": "Initiates graceful draining of brokers inherited from the previous server"
    },
    {
      "path": "src/server/agent-bridge.ts",
      "symbol": "startSession",
      "note": "Previously spawned the competing resumed CLI after the in-memory guard missed the survivor"
    },
    {
      "path": "scripts/verify-restart-survives.mjs",
      "symbol": "Phase B",
      "note": "The earlier scenario waited for reaping before reconnecting and therefore missed the race"
    }
  ],
  "related": [
    {
      "id": "BUG-008",
      "relation": "see_also"
    },
    {
      "id": "BUG-018",
      "relation": "see_also"
    },
    {
      "id": "BUG-020",
      "relation": "see_also"
    },
    {
      "id": "BUG-023",
      "relation": "see_also"
    },
    {
      "id": "BUG-029",
      "relation": "blocks"
    },
    {
      "id": "BUG-037",
      "relation": "see_also"
    },
    {
      "id": "BUG-072",
      "relation": "see_also"
    },
    {
      "id": "BUG-117",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [
    "BUG-008",
    "BUG-018",
    "BUG-020"
  ],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": true,
    "Migration and rollback": false,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-022-restart-survives-reconnect-race-corrupts-transcript.md",
    "sha256": "9761e436f6259f9cd9ba4645084f19f1cef46c66a8c7706eb25447458ca19d61",
    "bytes": 17202,
    "original_title": "a resume right after restart races a still-draining FEAT-015 survivor: two CLIs on one transcript, in-flight work silently lost",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared line by line against the archived original; the reconnect race, concurrent drivers, lost work, transcript interleaving, guard directions, evidence, and related cases are present.",
    "dropped": []
  }
}
```

# BUG-022 — Immediate reconnects no longer corrupt a surviving session

## Diagnosis

After restart, the new server accepted connections before the previous server’s surviving broker had finished draining. Its duplicate-driver guard consulted only the new process’s empty in-memory session map. A resume using the same persisted session identifier could therefore spawn another CLI against the transcript still being written by the survivor.

The two processes then appended unrelated turns to one transcript. The original turn stopped before its final reply and marker write, violating the promise that surviving work drains to completion.

## Evidence

The BUG-022 manual reproduction used session 6e04bb41-a21e-47fb-bb6e-5fcdbf6861c2. The original broker and CLI remained alive when the replacement server acknowledged a resume and spawned another CLI with the same session identifier. The transcript contained interleaved turns, while the original final reply and marker file never appeared.

The pre-fix race produced PRE-FIX 6/10. After correction, `verify:restart-survives` passed 15/15, `verify:detach` passed 7/7, `verify:reattach-approval` passed 11/11, and `verify:ui` passed 3/3. Another matched run recorded 10/10 without an adjacent suite name. Typecheck was clean.

`verify:restart-survives-race` and `verify:restart-reconnect-race` were named without recorded results.

## Implementation notes

Persisted survivor status already exposes the station session identifier and resume hint needed to recognize a driver owned by the previous process. Duplicate-driver protection must include that on-disk state, or acceptance of a matching resume must remain gated until adoption confirms the survivor has drained and exited.

## Verification plan

Restart while a turn is blocked in a tool call, reconnect immediately with the same session identifier, and attempt another prompt. Assert that only one CLI drives the session, the first turn completes, its marker is written, and the transcript remains ordered. Retain detach, reattachment approval, interface, and type checks as regression coverage.

## Risks

Persisted survivor records can become stale. A guard that trusts them without confirming process state could temporarily refuse a safe resume after the old process has already exited.

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
