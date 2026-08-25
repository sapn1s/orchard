# FEAT-028 — Run claude-station as a background app (systemd user service + Super+R launcher)

- **Status:** DONE — verified; cutover done (service active+enabled)
- **Area:** deploy / run story
- **Reported:** 2026-08-04 by user ("open in a terminal window I need to keep track of")
- **Related:** FEAT-015 (restart-survives-sessions); this is the run/daemonize half

## Problem
The station currently runs in a foreground terminal the user must keep track of.
As the "parent of all projects" it should be ambient infrastructure — background,
autostart, launchable like an app (user said: "opened with Super+R").

## Design (recommended)
- **`systemd --user` service** `claude-station.service`: runs `node src/server/index.ts`
  headless; `Restart=on-failure`; `WantedBy=default.target` (autostart on login);
  optional `loginctl enable-linger` for boot-without-login. ABSOLUTE node path in
  ExecStart (systemd user env is minimal — capture `which node`, handle nvm).
- **Launcher**: a wrapper (`scripts/station-open.sh`) that `systemctl --user start
  claude-station` then `xdg-open http://127.0.0.1:4317`; a
  `~/.local/share/applications/claude-station.desktop` (Terminal=false, the repo
  favicon as Icon) so Super+R → "Claude Station" opens the dashboard.
- Reference copies committed to repo (`deploy/`), machine-local copies installed to
  `~/.config/systemd/user/` + `~/.local/share/applications/` (like FEAT-025's pattern).

## Cutover (one-time; needs the user — port conflict)
The user's current terminal instance holds 4317. To switch: close that terminal
(frees 4317), then `systemctl --user enable --now claude-station`. Do NOT start the
service while the terminal instance holds the port (EADDRINUSE).

## Verification (REQUIRED)
- Unit validates (`systemctl --user daemon-reload`, `systemctl --user cat`,
  desktop-file-validate the .desktop).
- Prove ExecStart actually boots the server by running it on a SCRATCH free port
  (not 4317) and curling it up, then stopping by pid. Do NOT bind 4317.

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
