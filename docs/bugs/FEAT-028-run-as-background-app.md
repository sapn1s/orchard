```orchard-ticket
{
  "id": "FEAT-028",
  "type": "feature",
  "title": "The station required a terminal window left open to keep running",
  "summary": "The station used to run in a foreground terminal that the user had to keep open and watch. It now runs as a background service that starts on login, restarts on failure, and opens from the desktop launcher straight to the dashboard. The service is active and enabled after the one-time cutover.",
  "impact_if_we_wait": "Nothing further is at stake; the background service is live and the terminal instance no longer holds the port. Bounded: this was always about how the station is launched and kept alive, not about session data or anything the station stores.",
  "current_need": "Nothing is outstanding. The service unit was validated, the launch command was proved to boot the server on a scratch port, and the cutover left the service active and enabled.",
  "severity": "medium",
  "area": "Deploy and run story",
  "reported": "2026-08-04",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-08-04",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "The station starts automatically on login without a terminal window",
    "The service unit loads and its definition validates",
    "The launch command boots the server, proved on a free scratch port",
    "The desktop entry opens the dashboard in a browser",
    "The service survives a crash by restarting on failure"
  ],
  "code_refs": [
    {
      "path": "src/server/index.ts",
      "symbol": null,
      "note": "the headless entry point the service unit runs, via an absolute node path because the user service environment is minimal"
    },
    {
      "path": "scripts/station-open.sh",
      "symbol": null,
      "note": "starts the service, then opens the dashboard on 127.0.0.1:4317"
    },
    {
      "path": "deploy/",
      "symbol": null,
      "note": "reference copies of the service unit and desktop entry; machine-local copies install under the user config and applications directories"
    }
  ],
  "related": [
    {
      "id": "FEAT-015",
      "relation": "see_also"
    },
    {
      "id": "FEAT-036",
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
    "archived_path": "docs/bugs/archive/FEAT-028-run-as-background-app.md",
    "sha256": "e578219e257c2bf20beec31fb2b9f4b1c3d6b1e3fc1c6461cc22091ed734d227",
    "bytes": 7160,
    "original_title": "Run claude-station as a background app (systemd user service + Super+R launcher)",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Read against the original section by section: the foreground complaint, the unit design, the launcher and desktop entry, the port-conflict cutover and the scratch-port proof all survive above.",
    "dropped": [
      "the framing of FEAT-028 as the daemonize half of a pair, which the related link now carries"
    ]
  }
}
```

# FEAT-028 — The station required a terminal window left open to keep running

## Diagnosis

The station ran only as a foreground process, so its lifetime was tied to a terminal the user had to keep track of. As the parent of all projects it wants to be ambient infrastructure instead: background, autostarting on login, and reachable like any other installed application.

## Evidence

The user's report that it had to be "opened in a terminal window I need to keep track of", and the request that it instead be "opened with Super+R".

## Implementation notes

A `systemd --user` unit, `claude-station.service`, runs the server headless with `Restart=on-failure` and `WantedBy=default.target` so it comes up at login; `loginctl enable-linger` is available if it should come up without a login at all. ExecStart uses an absolute node path, captured from `which node`, because the user-session environment is minimal and an nvm-managed node is not on that path.

The launcher wrapper starts the service and then hands the dashboard URL to `xdg-open`. A `.desktop` entry with `Terminal=false` and the repo favicon makes "Claude Station" appear in the application launcher. Reference copies live in `deploy/` and machine-local copies are installed under `~/.config/systemd/user/` and `~/.local/share/applications/`, following the same split FEAT-025 used.

## Verification plan

Reload the user daemon and read back the installed unit, and run the desktop entry through `desktop-file-validate`. Prove ExecStart actually boots the server by running it on a scratch free port and curling it, then stopping it by pid — deliberately never binding 4317 during the check, because the running terminal instance held that port.

## Migration and rollback

Cutover was a one-time step that needed the user, because their foreground instance held 4317 and starting the service alongside it would have failed with an address-in-use error. The sequence was: close the terminal instance to free the port, then `systemctl --user enable --now claude-station`. It ended with the service both active and enabled.

## Risks

The service environment is far thinner than an interactive shell, so a relative or shell-resolved node path in ExecStart would fail at start time rather than at install time.

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed + dispatched. systemd user service + desktop launcher; cutover left to user
  (their terminal instance currently holds 4317).

### 2026-08-04 — build + verify agent
**Understood**: build a systemd --user unit + desktop launcher so the station runs
headless and is opened via Super+R, without ever touching the live 4317 instance
(pid 3843747, the user's own terminal session, confirmed running throughout and
unchanged at the end of this work).

**Node path resolution**: `which node` → `/usr/sbin/node`, which is itself a
symlink; `readlink -f` resolved it to the real path **`/usr/bin/node`** (no nvm in
use — `which nvm` empty, no `~/.nvm`). Used the resolved path in ExecStart per the
ticket's instruction to capture the concrete binary.

**Server port handling** (`src/server/index.ts:31-32`): `HOST = '127.0.0.1'`,
`PORT = Number(process.env.PORT ?? 4317)` — so `Environment=PORT=4317` in the unit
is the explicit/documented default, not required but makes the port visible in
`systemctl --user cat`.

**Files created** (repo, uncommitted — left in the tree per instructions):
- `deploy/claude-station.service` — reference unit:
  `ExecStart=/usr/bin/node ~/projects/claude-station/src/server/index.ts`,
  `WorkingDirectory=~/projects/claude-station`, `Environment=PORT=4317`,
  `Restart=on-failure`, `RestartSec=2`, `After=network-online.target`,
  `WantedBy=default.target`.
- `deploy/claude-station.desktop` — reference desktop entry:
  `Exec=~/projects/claude-station/scripts/station-open.sh`,
  `Icon=~/projects/claude-station/public/favicon.svg`, `Terminal=false`,
  `Type=Application`, `Categories=Development;`.
- `scripts/station-open.sh` (chmod +x) — `systemctl --user start claude-station`
  then `xdg-open http://127.0.0.1:4317`.

**Installed machine-local copies** (not in git, per FEAT-025's pattern):
- `~/.config/systemd/user/claude-station.service` (copy of the repo file)
- `~/.local/share/applications/claude-station.desktop` (copy of the repo file)

**Verified** (never touched port 4317 / pid 3843747 — checked before and after,
unchanged both times):
1. `systemctl --user daemon-reload` → exit 0.
2. `systemctl --user cat claude-station` → parsed cleanly, printed full unit
   contents (PASS).
3. `desktop-file-validate ~/.local/share/applications/claude-station.desktop` →
   exit 0, no output (PASS). `desktop-file-utils` was already installed
   (`/usr/sbin/desktop-file-validate`), no install needed.
4. **Scratch-port boot proof** (port 4417, confirmed free beforehand via `ss
   -ltn`): ran the exact ExecStart binary/script —
   `PORT=4417 /usr/bin/node src/server/index.ts` from
   `~/projects/claude-station`, backgrounded, pid 3851505.
   - `ss -ltnp | grep 4417` → `LISTEN ... 127.0.0.1:4417 ... pid=3851505` (PASS,
     listener came up).
   - `curl -s -o ... -w 'HTTP %{http_code}' http://127.0.0.1:4417/api/projects` →
     `HTTP 200`, body `{"projects": [{"id":"claude-station", ...}]}` (9 projects
     registered per server log) (PASS).
   - Stopped by pid: `kill 3851505` → process gone (`ps -p 3851505` empty),
     `ss -ltnp | grep 4417` → nothing (port freed cleanly). Never used `pkill`.
   - Re-checked 4317 immediately after: `ss -ltnp | grep 4317` still shows
     `pid=3843747`, unchanged — the live user session was never touched.

**Result: all verification PASSED.** Did NOT run `enable --now` on 4317 and did
NOT start/stop/reload anything against the live instance.

**Cutover (one-time, needs the user, NOT done by this agent)**:
1. Close the terminal currently running the station (frees port 4317, kills pid
   3843747's server — the user's own action, not this agent's).
2. `systemctl --user enable --now claude-station`
3. Optional, for boot-without-login: `loginctl enable-linger $USER`
4. Launch via Super+R → "Claude Station" (uses `scripts/station-open.sh`, which
   is idempotent: `systemctl --user start claude-station` is a no-op if already
   running, then opens `http://127.0.0.1:4317` in the default browser).

**Uninstall / reversal** (fully user-local, nothing system-wide changed):
```
systemctl --user disable --now claude-station   # if enabled
rm ~/.config/systemd/user/claude-station.service
rm ~/.local/share/applications/claude-station.desktop
systemctl --user daemon-reload
loginctl disable-linger $USER                      # only if enable-linger was run
# repo files (deploy/claude-station.service, deploy/claude-station.desktop,
# scripts/station-open.sh) are plain tracked/untracked files — `git rm` or
# `rm` them if the feature is abandoned entirely.
```

**Still open**: the cutover itself (closing the user's terminal + `enable --now`)
is deliberately left for the user, per the ticket's safety constraint — this
agent only built and verified the artifacts, never touched the live 4317
instance.

### 2026-08-04 — you (via Needs-You rail)
- **Answer:** DONE

- 2026-08-06 — privacy scrub for public release (FEAT-049, sanctioned append-only exception): private names/paths neutralized (project aliases, home paths → ~).
