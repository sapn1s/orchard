# BUG-023 — a genuinely-closed survivable session leaks its broker's status/err/ctl files forever unless a resume or restart happens to trigger a sweep

- **Status:** VERIFIED — fixed, proven with a scratch harness that fails without the fix and passes with it
- **Severity:** low (metadata files only, a few hundred bytes each; no process/socket/scope leak; self-heals the instant any resume or restart occurs)
- **Area:** server / restart survival (`src/server/survival.ts`)
- **Reported:** 2026-08-04, adversarial FINAL verification of FEAT-015/BUG-022 before activation

## Symptom
Every `direct` session launched with survival enabled (default, when `systemd-run --user`
is available) creates three files in `hostsDir()` (`<dataDir>/session-hosts/`):
`<key>.json` (status), `<key>.err` (CLI stderr log), `<key>.ctl.json` (control file).
`session-host.mjs`'s own `shutdown()` removes the unix `.sock` file but **never removes
its own `.json`/`.err`/`.ctl.json`**. The only code that ever deletes a dead broker's
files is `cleanupHostFiles()`, called exclusively from inside `scanSurvivingHosts()`
(`src/server/survival.ts:279-292`) — and `scanSurvivingHosts()` itself is invoked from
exactly two call sites in the whole codebase: the boot-time `adoptSurvivingHosts()` and
the WS `start`/resume guard's `survivingHostForSdkSession()` (only when a client sends a
`resumeSessionId`). A workflow that never restarts the server and never resumes a session
by its `sdkSessionId` (e.g. always starting fresh sessions, or always closing outright
rather than reattaching-by-resume) never calls `scanSurvivingHosts()` at all, so these
three-file-per-session groups accumulate in `hostsDir()` without bound for the life of the
server process.

## Repro
Scratch-only (own transient `--user` systemd service; `:4317`/`claude-station.service`
never touched):
1. Start a scratch claude-station server, survival ON (default).
2. Register a project. Four times in a row: open a websocket, `start` a session, wait for
   `turn-end`, then send an explicit `{type:'close'}` (a **genuine** close — this is the
   path that calls `AgentSession.close()` → `this.#survivalHandle.reap()`, i.e. exactly
   the intended, correct teardown of a survivable session, not a crash or a leak in the
   session lifecycle itself).
3. After each cycle, list `hostsDir()`.
4. Never send a `resumeSessionId` anywhere in the run; never restart the server.

Observed: after N genuine closes, `hostsDir()` contains exactly `3*N` files
(`h-*.json`, `h-*.err`, `h-*.ctl.json`) — one triple per session, **never removed**. Every
recorded `hostPid` in those `.json` files is confirmed dead (`pidAlive() === false`,
`state:"exited"`), and there is **no** process leak (`systemctl --user list-units
'claude-station-host-*'` is empty — the transient scope's `--collect` correctly reaps the
unit) and **no** socket leak (`.sock` files are correctly removed by the broker's own
`shutdown()`). Only the three small metadata files per session persist indefinitely.

Evidence (this run, `N=4`):
```
FINAL hostsDir contents: [
  'h-msett3mb-3gy4q0.ctl.json', 'h-msett3mb-3gy4q0.err', 'h-msett3mb-3gy4q0.json',
  'h-msett7ft-42l6xe.ctl.json', 'h-msett7ft-42l6xe.err', 'h-msett7ft-42l6xe.json',
  'h-msettbhs-qbmkuh.ctl.json', 'h-msettbhs-qbmkuh.err', 'h-msettbhs-qbmkuh.json',
  'h-msettf34-5c1gfv.ctl.json', 'h-msettf34-5c1gfv.err', 'h-msettf34-5c1gfv.json'
]
.json status files remaining: 4
.sock files remaining: 0
leftover claude-station-host-* units: ""
  h-msett3mb-3gy4q0.json: hostPid=44696 alive=false state=exited
  h-msett7ft-42l6xe.json: hostPid=44843 alive=false state=exited
  h-msettbhs-qbmkuh.json: hostPid=44957 alive=false state=exited
  h-msettf34-5c1gfv.json: hostPid=45068 alive=false state=exited
```

## Expected
A genuinely-closed survivable session's broker files should be cleaned up promptly (or at
least bounded), not rely on an unrelated client happening to send a `resumeSessionId` or
the server happening to restart. Practically: either (a) `AgentSession.close()` /
`SurvivalHandle.reap()` should delete its own three files once the broker is confirmed
exited (it already knows its own `statusPath`/`sock` — `reapHost()` in `survival.ts:270-276`
sends the SIGTERM but never follows up to delete), or (b) a lightweight periodic/opportunistic
sweep (e.g. call `scanSurvivingHosts()` — which already does the right cleanup — after every
`close()`, not only from the two current call sites).

## Severity / risk assessment
Low. This is metadata only (JSON/err text files, not sockets, not systemd units, not
processes) — no functional impact on session correctness, resume, or the guard's
correctness (a dead broker's stale `.json` is correctly skipped by `survivingHostForSdkSession`
the next time anything calls `scanSurvivingHosts()`, and that same call sweeps it away).
It is a slow, unbounded **disk** leak on a long-running server with heavy `direct`-session
churn and infrequent restarts — worth fixing before it matters at scale, but not a hole in
BUG-022's correctness guarantees (no hang, no lost work, no double-drive).

## Context pack
- Files/functions in play:
  - `src/server/survival.ts:234-242` (`shutdown()` in `session-host.mjs` — removes `.sock`
    only) and `src/server/survival.ts:270-276` (`reapHost()` — SIGTERMs but never deletes
    files) and `:279-292` (`scanSurvivingHosts()`/`cleanupHostFiles()` — the only cleanup
    path, called from 2 sites only: `adoptSurvivingHosts()` at boot, and
    `survivingHostForSdkSession()` in the WS resume guard).
  - `src/server/agent-bridge.ts:862-864` (`AgentSession.close()` calling
    `this.#survivalHandle.reap()`) — the natural place to also clean up the broker's own
    files once it's confirmed exited, or to opportunistically call `scanSurvivingHosts()`.
- Related tickets: FEAT-015 (this module), BUG-022 (the fix this session's audit was
  verifying — this leak is a separate, lower-severity gap, not a regression of BUG-022's
  own guarantees).
- Repro test: none automated yet; manual repro above. A `verify:restart-survives-leak`-style
  harness (N genuine open/close cycles with no resume/restart, assert `hostsDir()` file
  count stays bounded) would catch a regression here.
- Known dependencies / blockers: none — straightforward fix, either call
  `cleanupHostFiles`-equivalent from `reap()`/`close()`, or opportunistically sweep.

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
