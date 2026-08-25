# Claude Station — handover

A local, single-user dashboard for running and reviewing Claude Code sessions across
many projects. Rendered chat (not an embedded terminal), live sub-agent visibility,
per-project container isolation, instruction templates, and an attachable stealth browser.

## Run it

```sh
cd ~/projects/claude-station && npm start     # http://127.0.0.1:4317
```

Loopback-only by design. No auth tier, no multi-user, no API key — it uses your existing
Claude subscription via `~/.claude/.credentials.json`.

## What works (verified by running, not by reading)

| Area | Status |
|---|---|
| Project registry + real session history | 661-session store indexed in ~196 ms; Windows/Linux dirs merged per project |
| Live turns, multi-turn, interrupt | Verified end to end |
| Sub-agent live strip + navigation | Click an agent → its own transcript, breadcrumb, back to `main` |
| Approvals (`canUseTool`) | Deny genuinely blocks — verified the file was never created |
| Per-project containers | Session executes **inside**; `~` and other projects unreachable |
| Instruction templates | Proven to reach the model (sentinel present with template, absent in control) |
| Per-session overrides | `model: haiku` over a `sonnet` project default confirmed in `session-init` |
| Cross-OS fork | A real Windows session forked and answered from prior context; original byte-identical |
| Stealth browser (per project) | Read Indeed, which `curl` 403s in the same run |
| Open at newest + huge sessions | `?tail=N` backward-scan: 273 MB session opens in ~1.5 ms reading 1 MB; newest matches disk EOF |
| Live-follow external sessions | A session running in another terminal streams new messages in live (~180 ms write→render); reads only the appended delta |
| Live badge | Quiet moss dot on sessions being written now — hollow if you're driving it, filled if something else is |

Suites: `npm run verify` (75) · `verify:ui` (7) · `verify:container` (13) · `verify:browser` (24)
· 139 Playwright checks across 18 suites.

## Known limits — read these

- **You cannot send a message *into* a running sub-agent.** The SDK has no such capability
  (checked: no `Query` member, and of 40 control-protocol subtypes only `stop_task` and
  `background_tasks` address a task — neither carries a payload). You get full navigation
  and live watching; steering happens on `main`. The UI says so plainly rather than faking it.
- **Thinking text is never returned** — only token counts. The UI shows `thinking · N tokens`.
- **`sandbox` isolation is unimplemented** — modelled, returns 501. `bwrap` is installed if
  you want it later.
- **Hard-Cloudflare sites are not reliably reachable** by the browser (g2.com stayed blocked).
  A cold project profile gets challenged more than a warmed one. Zillow is *stochastic* —
  it works often, but don't build a check on it.
- **Forking a very large Windows session can exceed the context window** ("Prompt is too
  long"). Reported honestly as an error. One such fork cost **$8.89 in a single turn** —
  worth knowing before you fork a multi-MB transcript.
- **Concurrent sessions on the same project share one browser** (same Chrome, tabs, cookies).
- **Browsers are deliberately left running when the server restarts** — killing a logged-in
  browser because the dashboard restarted would lose your sessions.
- **Live-follow is persisted-message follow, ~1-2 s behind — not token streaming.** For a
  session the dashboard didn't spawn it shows each message as it's written to disk, not
  token-by-token; that live stream only exists inside the process driving the session. It
  does not fake one. Sessions the dashboard drives itself DO stream token-level over the bridge.
- **Very old history on files past the 128 MiB scan budget is reachable only via the backward
  (tail) cursor**, not forward `?offset`. Scroll-up uses the backward cursor and reaches
  index 0 regardless; the forward budget is not a dead end.

## Security posture

- Loopback bind only; no auth tier because nothing is exposed.
- Container isolation is fail-closed: an unrecognised isolation value is a hard error, and a
  container that can't start fails the session rather than silently running on the host.
- Mount validation normalises before comparing and refuses `/etc`, `/usr`, `/bin`, `~/.local`,
  `hostPath:/`, `$HOME`, and the browser/shim paths.
- The docker-socket opt-in is host-root-equivalent on a rootful daemon. It states the
  consequence in **both** states and requires an explicit confirm.
- Credentials are mounted rw (needed for OAuth refresh) and never logged.

## Housekeeping

- Data lives in `~/.local/share/claude-station/` (`CLAUDE_STATION_DATA` overrides).
- Six of your real projects are registered with default settings — remove any you don't want.
- `POST /api/containers/orphans` sweeps orphaned containers. One pre-existing
  `claude-station-claude-station` container predates this work.
- The sessions this project's own verification created are real and kept, under
  `~/.claude/projects/-home-<user>-projects-claude-station`.
- Old provisional UI is preserved in `.attic/`.

## Working agreement

`docs/prompts/WORKING_AGREEMENT.md` (stable) and `.v2.md` (living — append learned
preferences here). These are also seeded as instruction templates in the app.
