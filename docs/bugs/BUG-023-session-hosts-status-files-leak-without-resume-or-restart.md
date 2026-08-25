```orchard-ticket
{
  "id": "BUG-023",
  "type": "bug",
  "title": "Closed sessions left metadata files on disk",
  "summary": "Closed survivable sessions now clean up their broker metadata without waiting for a resume or server restart. A scratch harness reproduced persistent files before the fix and passed afterward, while standing checks stayed clean.",
  "impact_if_we_wait": "Long-running servers with frequent direct-session churn accumulate small files without bound. Bounded: this affects disk housekeeping, not session correctness, work, processes, sockets, system services, resume behavior, or guard correctness.",
  "current_need": "Treat the ticket as closed: the pre-fix harness failed, the corrected behavior passed, and standing checks stayed clean.",
  "severity": "low",
  "area": "Session survival cleanup",
  "reported": "2026-08-04",
  "reported_by": "bug-hunt workflow",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-04",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Closing a survivable session promptly removes its status, error, and control files",
    "Repeated close cycles without resumes or restarts keep the metadata file count bounded",
    "Closing sessions leaves no broker processes, sockets, or system service units"
  ],
  "code_refs": [
    {
      "path": "src/server/survival.ts",
      "symbol": "reapHost",
      "note": "Stops the broker; the original path did not remove its metadata files afterward"
    },
    {
      "path": "src/server/survival.ts",
      "symbol": "scanSurvivingHosts",
      "note": "Previously provided the only dead-broker metadata cleanup path"
    },
    {
      "path": "src/server/survival.ts",
      "symbol": "cleanupHostFiles",
      "note": "Removes files belonging to dead brokers"
    },
    {
      "path": "src/server/agent-bridge.ts",
      "symbol": "AgentSession.close",
      "note": "Genuine session closure invokes the survival handle's reap operation"
    }
  ],
  "related": [
    {
      "id": "FEAT-015",
      "relation": "see_also"
    },
    {
      "id": "BUG-022",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
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
    "archived_path": "docs/bugs/archive/BUG-023-session-hosts-status-files-leak-without-resume-or-restart.md",
    "sha256": "7ec2a242f062cefc1ceafc4daa0a4bc642bdb48528a54239b4d4b0a5d5b77472",
    "bytes": 18433,
    "original_title": "a genuinely-closed survivable session leaks its broker's status/err/ctl files forever unless a resume or restart happens to trigger a sweep",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the supplied ticket text; the symptom, trigger conditions, bounds, cleanup paths, reproduction, fix outcome, and executed evidence remain represented.",
    "dropped": [
      "Transient scratch identifiers and the verbatim twelve-file listing"
    ]
  }
}
```

# BUG-023 — Closed sessions left metadata files on disk

## Diagnosis

Each direct session with survival enabled created status, error-log, and control files under the session-host directory. Broker shutdown removed its Unix socket, and session closure reaped the broker, but neither path removed those three metadata files.

The only cleanup occurred during `scanSurvivingHosts()`, reached at server boot or when a client resumed by SDK session ID. Servers that continually opened and genuinely closed fresh sessions without resuming or restarting therefore accumulated one metadata triple per session.

## Evidence

A scratch server completed four genuine open-and-close cycles without any resume or restart. Twelve metadata files remained: four status files, four error logs, and four control files. Every recorded broker process was dead and marked exited. No sockets or transient system service units remained.

The pre-fix code was restored by stashing the `session-host.mjs` hunk and produced 11/17. After the fix, `verify:restart-survives` passed 15/15 and `verify:detach` passed 7/7. Additional recorded matched tallies were 3/3, 10/10, and 17/17 without adjacent suite names. Type checking was clean.

`verify:restart-survives-leak`, `verify:restart-reconnect-race`, and `verify:hosts-cleanup` were named without recorded results.

## Implementation notes

Cleanup must happen after a genuinely closed session's broker has exited, without depending on a future resume or restart. The existing dead-broker cleanup logic already knows how to remove the status, error, and control files. The close and reap path knows which broker belongs to the session.

## Verification plan

Run repeated survivable-session open-and-close cycles on a scratch service. Do not send a resume identifier or restart the server. Assert that broker metadata stays bounded after each close, all broker processes exit, sockets disappear, and transient service units are collected.

## Risks

Deleting metadata before broker exit could remove files still needed during shutdown. Cleanup must remain scoped to the closed session or to brokers confirmed dead. The affected files are only small metadata and logs; session state and user work are outside this cleanup.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-04 — FINAL adversarial verification of FEAT-015/BUG-022 (READ-ONLY audit + scratch repro)
- **Understood:** Tasked with a final, adversarial pass on BUG-022's fix
  (`session-host.mjs` turn-boundary tracking + stdin-EOF hold, `survival.ts`
  `sdkSessionId`/`survivingHostForSdkSession`, `index.ts`'s cross-process resume guard)
  before recommending ACTIVATE on the real machine. Default posture: assume broken.
- **Verified (scratch only; `:4317`/`claude-station.service` never touched — confirmed
  `active` throughout; killed only by pid/unit; every scope/socket/dir created was cleaned
  up):**
  - **Hang/backstop (HOLDS).** Drove `session-host.mjs` directly (no full server) against a
    controllable fake `claude` CLI that ignores stdin-EOF, traps SIGTERM, and never emits
    `result` — a worst-case stuck CLI. Confirmed the full escalation: `draining` at SIGTERM,
    alive at ~90s (EOF-backstop fired but a truly hostile CLI ignores it), alive at ~150s
    (SIGTERM fired but trapped/ignored), **dead via SIGKILL at ~160.7s** — matches the
    code's `90_000`/`150_000`/`160_000` ms timers exactly. No permanent hang possible even
    against a maximally uncooperative child.
  - **Turn-end detection (HOLDS).** A fake CLI emitting `init` then an `assistant` message
    then a `result` with `isError:true` (an errored turn) was correctly treated as
    turn-end — the broker reaped promptly (well under 1s after the result), not stuck
    waiting for a "success" specifically. `m.type === 'result'` is subtype-agnostic in
    `onStreamJsonLine`, as intended.
  - **sdkSessionId capture race (HOLDS).** A fake CLI writing `init`+`result` in a SINGLE
    `write()` call (one chunk) then exiting immediately still had its `sdkSessionId`
    correctly captured and persisted before the host process ever saw the child exit —
    Node's stream ordering guarantees the `data` handler (which synchronously
    `fs.writeFileSync`s the status) runs before the `exit` handler for the same child.
  - **Guard / no double-drive (HOLDS, regression-checked).** Re-ran
    `npm run verify:restart-reconnect-race` (3 times) and `npm run verify:restart-survives`
    (once, 15/15): the racing-resume guard consistently refuses with the honest retryable
    error, no second `claude --resume` ever coexists with a survivor, and a follow-up
    resume after a survivor fully drains + is reaped succeeds end-to-end
    (`verify:restart-survives`'s own "CONTINUITY" check). No permanently-stuck legitimate
    resume found.
  - **`verify:restart-reconnect-race`'s "marker lands" check is FLAKY, but this is a TEST
    HARNESS issue, not a BUG-022 code defect (root-caused, not just observed).** It failed
    3/3 runs this session (`markerExists:false`). Root-caused via a from-scratch isolation
    harness (single scratch server, no race, no second server — SIGTERM the broker
    directly after the real `systemctl --user stop` of the driving server) plus a raw
    observer socket on the broker's own unix socket: the `haiku` model, given "use the Bash
    tool to run `sleep 30`", frequently chooses to run it as a **backgrounded** Bash task
    (Claude Code's background-task + Monitor-tool feature) and ends its **turn** with a
    legitimate `result`/`stop_reason:end_turn` message BEFORE the backgrounded sleep
    finishes and BEFORE ever reaching the Write/reply steps it announced it would do next.
    The broker correctly sees a real `result`, correctly does not hold, and correctly reaps
    — this is the mechanism working as designed, not truncation. (Separately, when the
    model instead runs `sleep 30` as a true blocking foreground call — reproduced in the
    same isolation harness — the broker correctly HOLDS stdin-EOF for the full ~24s
    remaining and the marker lands.) **Recommendation for whoever owns
    `verify-restart-reconnect-race.mjs`:** harden the prompt so the model cannot elide the
    hold-window test by backgrounding the sleep (e.g. instruct "do not run this in the
    background", or use a command whose tool_result cannot return early) — as written, a
    real regression in the hold logic could hide behind this same model-choice flakiness.
    Not filed as its own ticket since it is test-only; noting here since it directly
    affects confidence in the "10/10" activation signal for BUG-022.
  - **Leaks — a REAL one found, filed as this ticket.** Repeated genuine open/close cycles
    (no resume, no restart) leak 3 metadata files per session in `hostsDir()` indefinitely
    — see Symptom/Repro above. No process, socket, or systemd-unit leak (all confirmed
    clean). Low severity, self-healing on any resume/restart, straightforward fix.
- **Attacks tried and their outcome (full list, no silent caps):**
  1. Hang / never-closes (stuck CLI ignoring EOF+SIGTERM) — **HOLDS**, SIGKILL escalation
     bounds it at ~160s.
  2. Permanently-refused legit resume after a survivor drains+reaps — **HOLDS**
     (`verify:restart-survives` CONTINUITY check + `verify:restart-reconnect-race`'s own
     guard-refusal-then-drain checks; guard is read-only, no state corruption possible).
  3. sdkSessionId capture race (turn finishes/CLI dies before `init` parsed) — **HOLDS**
     (same-chunk init+result test).
  4. Leaks across many close/restart/resume cycles — **hostsDir metadata files: LEAK
     FOUND, filed as BUG-023 (this ticket).** Processes/sockets/scopes: clean.
  5. Interrupt/error during the stdin-hold window — **HOLDS** (error-result fake-cli test:
     reaped promptly on an errored `result`, not stuck).
  6. (Bonus, not originally scoped) Investigated the `verify:restart-reconnect-race`
     "marker lands" flake to root cause rather than leaving it unexplained — concluded test
     fragility, not a product defect, with direct evidence (see above).
- **Changed:** none to `src/` (read-only audit as instructed). Filed this ticket
  (`BUG-023`) only. Scratch scripts used for diagnosis
  (`scripts/_scratch-isolate-holdlogic.mjs`, `scripts/_scratch-leak-check.mjs`,
  `/tmp/bug022-atk/*`) were all deleted / left in `/tmp` (not part of the repo). Did not
  touch `docs/bugs/INDEX.md` per instructions.
- **Still open / handoff:** BUG-023's fix (see Fix direction / Expected above) is small and
  independent of activation — recommend fixing opportunistically, not a blocker. The
  `verify-restart-reconnect-race.mjs` prompt-fragility note above is a good first pickup
  for whoever next touches that harness.

### 2026-08-04 — Fix: self-clean own status/err/ctl files in `session-host.mjs`'s `shutdown()`
- **Understood:** Read this ticket's full repro/context pack first. The gap: `reapHost()`
  (`survival.ts:339-345`) only SIGTERMs the broker and never follows up to delete its files;
  the only file-deleting code is `cleanupHostFiles()` inside `scanSurvivingHosts()`
  (`survival.ts:387-392`), reachable only from `adoptSurvivingHosts()` (boot) or
  `survivingHostForSdkSession()` (the WS resume guard) — neither runs on a plain
  open→close cycle. Constraint: must not change any exported signature in `survival.ts`
  (a sibling agent reads its scan/status exports for a health endpoint), so the fix lives
  entirely in `session-host.mjs`, the one place that *knows* with certainty when it is
  genuinely, permanently done.
- **Changed:** `src/server/session-host.mjs`'s `shutdown(code)` (the function every exit
  path — `child.on('exit')`, `child.on('error')`, and `gracefulReap()`'s escalation chain —
  funnels through) now also `fs.rmSync`s its own `status` (`<key>.json`), `errlog`
  (`<key>.err`), and `controlPath` (`<key>.ctl.json`) alongside the `.sock` file it already
  removed. This is safe unconditionally: `shutdown()` only ever runs as this specific host
  process is exiting for good, so a still-ALIVE surviving host (a different process, whose
  own `shutdown()` hasn't run) is never touched by this path — only a host's own files, only
  once it is certain it is on the way out. No change to `survival.ts` was needed or made
  (`cleanupHostFiles`/`scanSurvivingHosts`/`reapHost`/exported types all untouched — still
  the correct backstop for a host that dies WITHOUT running its own `shutdown()`, e.g.
  SIGKILL).
- **Verified (scratch only; `:4317`/`claude-station.service` never touched, confirmed
  `active` throughout; own transient units/ports; killed only by pid; all scratch dirs +
  derived `~/.claude/projects/<hash>` transcript stores cleaned up after each run):**
  - New harness `scripts/verify-hosts-cleanup.mjs` (`npm run verify:hosts-cleanup`): opens a
    SURVIVOR session left genuinely in-flight (long Bash sleep, never closed during the
    run), then runs 4 genuine open→start→wait-turn-end→explicit-`{type:'close'}` cycles (no
    `resumeSessionId`, no restart), asserting after each cycle that (a) the survivor's own 3
    files are still present untouched and (b) once a closed cycle's broker pid has actually
    exited, its 3 files are gone. Finally closes the survivor itself and asserts it cleans up
    too, then asserts `hostsDir()` is completely empty.
    - **Confirmed FAILS on pre-fix code** (stashed the `session-host.mjs` hunk, reran): 11/17
      passed, 6 FAILed — every closed cycle's 3-file triple remained (exactly BUG-023's
      symptom, `3*N` leaked files), matching the ticket's repro evidence precisely.
    - **PASSES with the fix**: 17/17 — 0 stale files after all cycles, survivor's files
      untouched throughout every intervening close, survivor's own files also gone once it
      too is genuinely closed.
  - `npm run verify:restart-survives` — **15/15 PASS**, unchanged from before the fix. Boot
    re-adopt (Phase B's `RE-ADOPT` check) still finds and drains the surviving broker via
    `scanSurvivingHosts()`/`adoptSurvivingHosts()` exactly as before — confirms the new
    self-cleanup in `shutdown()` does not race with or break re-adopt (the survivor's files
    are removed only after `shutdown()` runs, i.e. after the broker has already been
    reaped/drained, never while still alive and needed for re-adopt).
  - `npm run verify:detach` — **7/7 PASS** on a clean isolated run (`node
    scripts/verify-detach.mjs` directly, not chained after other scratch verifies). Two
    earlier attempts chained immediately after other scratch-server runs hit a transient
    `fetch failed` / timeout unrelated to this fix (confirmed by a clean rerun passing fully
    with the fix in place) — noting here in case it recurs for a future agent, but it did not
    reproduce on a clean run and is not caused by the `session-host.mjs` change (that change
    only touches a broker subprocess's own file cleanup, never the main server or its HTTP
    health endpoint).
  - `npm run typecheck` — **exit 0**, clean.
- **Files touched:** `src/server/session-host.mjs` (the fix), `scripts/verify-hosts-cleanup.mjs`
  (new, +`verify:hosts-cleanup` in `package.json`), this ticket. `src/server/survival.ts` was
  read but not modified — no change was needed there, and its exported
  functions/`HostStatus` type are unchanged (respecting the sibling agent's in-flight read of
  those exports for a health endpoint).
- **Still open / handoff:** None for this ticket — considered fully fixed and verified. If a
  host is ever killed with SIGKILL (skipping its own `shutdown()`, e.g. the backstop's final
  escalation in `gracefulReap()` or an external `kill -9`), its files still rely on the
  pre-existing `scanSurvivingHosts()`/`cleanupHostFiles()` backstop (unchanged, still
  correct) rather than self-cleanup — that residual, bounded-by-a-future-scan case is
  unchanged from before and was never in scope (self-heals, as this ticket's own Severity
  section already notes). Not filing a new ticket for it — it is strictly smaller than the
  original bug and already covered by existing, tested code.
