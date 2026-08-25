# BUG-024 — FEAT-015 survival broker runs as a server child (NOT scope-escaped) in the deployed systemd --user service → survival ineffective on restart

- **Status:** VERIFIED — NOT A BUG (misdiagnosis). Survival IS effective in the real
  deployed `--user` service: the broker + CLI live in their own
  `claude-station-host-<key>.scope` cgroup, NOT the service cgroup. The original
  report drew on two wrong diagnostics (globbed `run-*.scope` for an explicitly-named
  scope; read broker-PPID==server as "not scoped", but `systemd-run --scope` execs
  in-place so PPID legitimately stays the server while the cgroup is relocated).
  Shipped hardening + a deployed-context regression test anyway. See 2026-08-04 entry.
- **Severity:** high (FEAT-015 gives a FALSE sense of restart-protection in production; scratch tests passed but deployment differs)
- **Area:** FEAT-015 survival / systemd deployment
- **Reported:** 2026-08-04 by orchestrator (observed live after activating FEAT-015)

## Symptom (observed live)
After restarting the real `claude-station.service` to activate FEAT-015, the survival
broker `session-host.mjs` IS spawned for the driven session — but `ps` shows it as a
DIRECT CHILD of the server process (`PID 65434 ← server 65173`), NOT inside its own
`systemd-run --user --scope`. `systemctl --user list-units 'run-*.scope'` is empty.
`systemd-run` IS on PATH (`/usr/sbin/systemd-run`) and `CLAUDE_STATION_SURVIVE` is unset
(default on). So the scope-escape — the CORE of FEAT-015 — silently did not happen in the
deployed context, meaning `KillMode=control-group` would still reap the broker + CLI on the
next restart. Survival is currently INEFFECTIVE despite all scratch tests passing.

## Why the scratch tests missed it (the real lesson)
`verify:restart-survives`/`verify:restart-reconnect-race` run their scratch server in a
freshly-created `systemd-run --user --scope` from a full interactive shell — where nested
`systemd-run --scope` works. The DEPLOYED server runs as a `systemctl --user` **service unit**
whose spawn environment likely lacks what `systemd-run --user --scope` needs
(`XDG_RUNTIME_DIR` / `DBUS_SESSION_BUS_ADDRESS` propagation, or nested-scope permission), so
the scope-launch **silently falls back to a direct child** instead of failing loudly. This is
the FEAT-032 #3 "verify the REAL deployed state, not just scratch" gap, concretely.

## Fix direction
1. Make the scope-launch **fail loudly / log** when it can't create a scope (never silently
   fall back to an unprotected direct child — that defeats the feature and hides the failure).
2. Ensure the scope actually forms inside a `systemctl --user` service: propagate/repair the
   env `systemd-run --user --scope` needs (XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS), or use
   the correct API from within a service. Confirm the broker's parent becomes systemd, not the server.
3. Reproduce the DEPLOYED context in the test (a scratch server run AS a transient `systemctl
   --user` **service**, not just a shell scope), assert the broker escapes the service cgroup,
   and that stopping the service leaves the broker alive.

## Verification (REQUIRED — must reproduce the deployed context)
A scratch harness where the server runs as a `systemd --user` service unit (mirroring the real
deploy), spawns a driven session, and asserts: (a) the broker's parent is systemd (scoped), not
the server; (b) `systemctl --user stop` of that service leaves the broker + CLI ALIVE and the
turn completing. Must FAIL on current code (broker is a server child), pass after.

## CRITICAL constraint
The live `claude-station.service` (:4317) runs THIS orchestrator session, which is CURRENTLY
UNPROTECTED (this bug) — a restart of :4317 kills it. Do NOT restart/stop :4317. Scratch only.

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed from a live post-activation check. FEAT-015 scratch-verified but broker not scope-escaped
  in the real systemd --user service — the exact deployed-vs-scratch gap. Dispatched opus fix.

### 2026-08-04 — opus (root-caused live; NOT A BUG; hardened + deployed-context test)
**ROOT CAUSE = MISDIAGNOSIS. Survival is ALREADY effective in the real deployed service.**
Inspected the live `claude-station.service` (:4317, never touched — only read `systemctl show`
/ `/proc`). Ground truth on the SAME broker the report flagged (broker pid 65434 ← server 65173):
- The broker AND the driven CLI (pid 65442, `claude --resume=87564f3e…`) are BOTH in cgroup
  `…/app.slice/claude-station-host-h-mseul1ou-g5nwzg.scope` — a REAL transient scope, distinct
  from the service cgroup `…/app.slice/claude-station.service`. Neither pid is in the service's
  `cgroup.procs` (count 0). `systemctl --user list-units 'claude-station-host-*.scope'` shows the
  scope `loaded active running`. A `KillMode=control-group` restart of the service therefore does
  NOT reach them. Survival works.
- The two report diagnostics were both wrong: (1) `systemctl … list-units 'run-*.scope'` is empty
  because our scope is explicitly named `claude-station-host-<key>.scope` via `--unit=`, so it
  never matches the anonymous `run-*.scope` glob (the correct glob shows it). (2) "broker PPID =
  server ⇒ direct child, not scoped" is a false inference: `systemd-run --user --scope` EXECs the
  command IN-PLACE, so the broker keeps PPID = server WHILE being relocated into a fresh scope
  cgroup. PPID is not the escape indicator — cgroup membership is (verified above).
- Also verified the code has NO "silent fallback to an unprotected direct child" path: if the
  scope cannot be created, `systemd-run` errors BEFORE exec'ing the broker, so the broker simply
  does not run (previously surfaced only as a ~30s socket timeout) — it never runs unprotected
  inside the service cgroup.

**HARDENING SHIPPED (still valuable — the fix-brief items, honestly applied):**
- `src/server/survival.ts`: `systemd-run` now runs with stderr captured; a FAST nonzero exit
  BEFORE the transport connects (guarded by `everConnected`, since the success path execs the
  broker in-place and only "exits" much later) → `failScopeLaunch()` LOGS LOUDLY to stderr
  (journalctl) that the scope could NOT be created and the CLI is NOT restart-protected, writes a
  `scopeLaunchFailed:true` status flag, and settles the SDK facade as error/exit immediately
  instead of a silent ~30s hang. A survival that isn't actually escaping the cgroup can no longer
  masquerade as working. Belt-and-braces env: re-inject `XDG_RUNTIME_DIR` /
  `DBUS_SESSION_BUS_ADDRESS` into the `systemd-run` env if a future caller ever strips them (the
  SDK today hands `{...process.env}`, which in a `--user` service already carries both — confirmed).

**VERIFY (scratch only; :4317 / claude-station.service confirmed `active`, MainPID unchanged,
:4317→200, and the real orchestrator scope still alive after every run; killed by pid; scratch
units `--collect`-auto-removed; NEVER stopped a `claude-station-host-*.scope` globally):**
- NEW `scripts/verify-survival-deployed.mjs` (+ `npm run verify:survival-deployed`) — reproduces
  the DEPLOYED context (scratch server run AS a transient `systemctl --user` SERVICE, given only
  PORT/HOST/DATA like the real unit; manager supplies XDG/DBUS). Asserts the RIGHT things:
  broker + CLI in their OWN `claude-station-host-*.scope` cgroup and NOT in the service's
  `cgroup.procs`; the scope unit exists; a `systemctl --user stop` leaves broker + CLI ALIVE and
  the in-flight turn COMPLETING (marker `SURVIVED` written by the surviving CLI); fresh server
  re-adopts + reaps. Also documents the misdiagnosis inline (empty `run-*.scope`; PPID==server is
  normal). → **PASS 12/12** on current code — the honest proof that the deployed context is
  already protected. (Cannot be a fail→pass "bug" test: there is no bug to fail on.)
- `npm run verify:restart-survives` → **PASS 15/15** (no regression).
- `npm run verify:detach` → **PASS 7/7** (no regression).
- `npm run typecheck` → **PASS** (exit 0).
- `npm run verify:restart-reconnect-race` → 9/10; the one FAIL ("marker landed") is PRE-EXISTING
  and env-independent — it reproduces IDENTICALLY on the clean baseline (git-stash of my change):
  a haiku Write-step flake (the transcript check PASSES: original sentinel present, uncorrupted,
  no spliced racing turn). NOT a regression from this work.
