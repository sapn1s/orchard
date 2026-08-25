```orchard-ticket
{
  "id": "BUG-024",
  "type": "bug",
  "title": "Sessions survive service restarts despite misleading diagnostics",
  "summary": "Restart protection works in the deployed service. The broker and command process enter their own named scope, even though the broker remains a child of the server. Earlier checks searched for the wrong scope name and treated the unchanged parent process as evidence that isolation had failed. Hardening and a deployed-context regression test were added.",
  "impact_if_we_wait": "Misleading diagnostics could prompt unnecessary changes or unsafe service testing. Bounded: deployed restart survival is effective; this concerns diagnostic and regression confidence, not session loss under the established behavior.",
  "current_need": "Treat the concern as closed: restart and detachment checks passed, the corrected scope diagnosis explains the deployment, and type checking stayed clean.",
  "severity": "high",
  "area": "Session restart survival",
  "reported": "2026-08-04",
  "reported_by": "agent",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-04",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "The broker and command process occupy a scope outside the service cgroup",
    "Stopping a scratch user service leaves the broker and command process alive",
    "Scope-launch failures are surfaced instead of silently weakening restart protection"
  ],
  "code_refs": [
    {
      "path": "session-host.mjs",
      "symbol": null,
      "note": "The survival broker remains the server's process child after the scope launcher replaces itself, while its cgroup moves to the named host scope."
    }
  ],
  "related": [
    {
      "id": "BUG-035",
      "relation": "see_also"
    },
    {
      "id": "FEAT-032",
      "relation": "see_also"
    },
    {
      "id": "FEAT-048",
      "relation": "see_also"
    },
    {
      "id": "FEAT-060",
      "relation": "see_also"
    },
    {
      "id": "FEAT-061",
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
    "Migration and rollback": true,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-024-survival-broker-not-scope-escaped-in-deployed-service.md",
    "sha256": "9d1923847970572ec7602c0921097c8717db65249c1304311cd12ef041225f5e",
    "bytes": 8436,
    "original_title": "FEAT-015 survival broker runs as a server child (NOT scope-escaped) in the deployed systemd --user service → survival ineffective on restart",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared line by line with the archived original; the corrected diagnosis, deployed behavior, hardening, evidence, safety constraint, and FEAT-032 connection are preserved.",
    "dropped": []
  }
}
```

# BUG-024 — Sessions survive service restarts despite misleading diagnostics

## Diagnosis

BUG-024 was a misdiagnosis. The deployed broker and command process live in their own explicitly named `claude-station-host-<key>.scope` cgroup, outside the service cgroup. Searching only for `run-*.scope` therefore missed them. The broker's parent process also remains the server because `systemd-run --scope` replaces itself in place; the unchanged parent does not show that cgroup relocation failed. The proposed missing-environment explanation was based on those two misleading observations.

## Evidence

`verify:restart-survives` completed with 15/15 passing, and `verify:detach` completed with 7/7 passing. Another recorded tally was 12/12 without an adjacent suite name. `typecheck` was reported clean. `verify:restart-reconnect-race` and `verify:survival-deployed` were named, but no result was recorded for either.

## Implementation notes

Hardening and a deployed-context regression test shipped despite the corrected diagnosis. The test must identify the explicitly named host scope and compare cgroup placement rather than infer isolation from the broker's parent process.

## Verification plan

Run the server as a scratch `systemd --user` service, start a driven session, and confirm that the broker and command process occupy their named scope outside the service cgroup. Stop only the scratch service and confirm that both processes remain alive while the turn completes.

## Migration and rollback

Do not restart or stop the live service on `:4317` while exercising this scenario. Use a scratch user service so the active orchestrator session is not exposed to test disruption.

## Risks

Parent-process inspection and wildcard searches for automatically named scopes can recreate the false diagnosis. Tests must inspect the actual named scope and cgroup boundary.

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
