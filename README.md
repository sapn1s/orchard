# Orchard

A local, single-user dashboard for running AI coding sessions across all your projects at once.
It runs on your machine, on a subscription you already have, and it remembers how you want to
work so you do not have to say it again in every project.

![Orchard dashboard: project sidebar, live transcript, Needs-you rail](docs/assets/screenshot-dashboard.png)

## Why it exists

**You end up explaining how to work, over and over.** Every new project starts with the same
preamble: how to verify a change, when to write something down, what "done" means, which tools
are available. Nobody types that every time, so most projects get a thinner version, or none.
Add a project to Orchard and it composes one instruction bundle for every session in it: a shared
working agreement, that project's conventions file, routing rules, reply-format guidance. On this
repository that bundle measures roughly 36,000 characters. It is stored once and read at launch,
so editing it changes every project rather than one.

**Watching many sessions should not mean many terminal windows.** The sidebar lists projects and
their sessions. The main pane renders the transcript (tool calls, subagents, approvals, diffs)
instead of emulating a terminal. Leave a session running, look at another, come back. Anything
that needs an answer collects in one rail on the right instead of scrolling past in a window you
closed. The layout takes after OpenAI's Codex web UI.

**Isolation is one control, not a Dockerfile.** A project can be switched from running on your
machine to running inside a Docker container from its settings. The first run builds an image
locally (Docker required, around 1 GB, so it is not instant). After that, sessions in that
project run with a memory cap, a process cap, dropped capabilities and no new privileges. The
project directory is bind-mounted read-write, so the container isolates the rest of your machine,
not the project itself.

**Everyday git work stays in the app.** A git panel with four views: changes, branches, history,
stashes. Read diffs, stage and unstage files, commit, create and switch branches, sync with the
remote. It is deliberately narrow. No discarding changes, no merge, rebase or amend, no per-hunk
staging; history and stashes are read-only. For anything else it opens a terminal in the project
directory.

**Written-down work survives a session ending.** Adding a project scaffolds a file-based ticket
board under `docs/bugs/`: an index plus one append-only file per ticket. A session launched there
sees a short snapshot of the board in its prompt. Sessions get compacted, restarted and replaced;
the board does not. Uncheck "apply the Orchard method" when you add the project to skip it. A
project with no `docs/bugs/` directory has nothing injected.

**Long replies get shorter without you asking.** Sessions are asked to lead with a short digest
block, and a hook checks the final message of each turn against that format and nudges when it
drifts. It is advisory: it comments, it does not block the turn, and it grades only the main
thread, never subagents. On by default for projects added through Orchard, switchable off per
project in the settings drawer.

## Quick start

```sh
npm install                       # first time only
npm start                         # -> http://127.0.0.1:4317
```

Node 23 or newer runs the TypeScript directly (native type stripping); there is no build step.
`PORT` and `CLAUDE_STATION_DATA` override the defaults. Data (the project registry, instruction
templates, snapshots) lives under your XDG data directory, outside the repository.

To run it as a background app, copy `deploy/claude-station.service` into your systemd user unit
directory, fix the repository path inside it, then `systemctl --user enable --now claude-station`.

**The old name.** Orchard used to be called Claude Station. Names that identify *stored state*
still use the old one on purpose: the systemd unit, the `CLAUDE_STATION_*` environment variables,
the `~/.local/share/claude-station` data directory, the Docker image and container labels.
Renaming them would move or orphan data that already exists, so they stay until there is a
migration to go with them.

**Providers.** Two, both on a subscription you already have: Claude Code (Anthropic Pro/Max) and
OpenAI Codex (ChatGPT Plus and up). The Claude path needs `claude` on `PATH` and a signed-in
subscription. The Codex path needs `codex` plus `codex login`, meaning "Sign in with ChatGPT",
not an API key. Orchard never reads or stores API keys for any provider. Setup, detection rules
and the honest capability differences are in [docs/PROVIDERS.md](docs/PROVIDERS.md).

New to it? [docs/guide/](docs/guide/README.md) walks through the workflow with screenshots.

## What it does

- **Sessions with a queue.** Type while a turn is running. Messages are held, shown as queued,
  and delivered in order, or force-sent.
- **Subagent visibility.** Spawned agents render as live rows with their own tool activity, and
  always settle (completed, failed or cut) rather than spinning forever.
- **Multi-provider.** Pick the provider at launch. A chip in the header shows the model the
  running session actually reported, not the one you asked for.
- **A rail for anything that needs you.** A running session can raise a question; it appears as a
  card you answer from the rail, without hunting for the session it came from.
- **Restart survival.** The server can restart while sessions keep running. Live turns are drained
  and re-adopted instead of killed.
- **Headless dispatch.** `scripts/dispatch.mjs` runs a one-shot task through either provider and
  prints the final result to stdout. `scripts/gatekeeper.mjs` reviews a commit range from a fresh
  context on the *other* provider.
- **Honest state.** Provider errors are relayed with their real cause. Unimplemented things fail
  loudly rather than quietly degrading.
- **Instruction templates.** Markdown files with frontmatter, composed per project, with a preview
  endpoint that shows exactly what a project would send.
- **Project snapshots.** Per-session undo via reflink copies on btrfs: near-instant, close to zero
  extra bytes until files diverge, restored only when you ask, and a loud failure if reflink is
  unavailable instead of a silent full copy.

![Model and effort picker](docs/assets/screenshot-model-picker.png)

Per-project settings (model, permission mode, isolation, snapshots, integrations) live in a
drawer, with a "this session" scope that overrides the project default for a single run.

![Project settings drawer](docs/assets/screenshot-settings.png)

## Optional integrations

Per-project toggles. All three are third-party tools that Orchard attaches to a session. None of
them are bundled.

- **serena.** Symbol-level code navigation over a language server, run via `uvx`
  ([github.com/oraios/serena](https://github.com/oraios/serena)).
- **playwright.** `@playwright/mcp` via `npx`: an ephemeral headless browser with a clean profile,
  for deterministic UI checks.
- **A persistent browser profile.** A per-project browser adapter that keeps its profile between
  sessions, so a session can work with sites you stay signed in to. The adapter is a separate
  local project, not part of this repository and not published with it. You supply it yourself and
  point `CLAUDE_STATION_SBMCP_REPO` at it. Without it, the toggle degrades with a clear message
  saying what was not found.

## Security posture

Single-user, local-only tooling. Stated plainly so the boundaries are checkable.

- **Localhost-only binding.** The server listens on `127.0.0.1` and has no auth tier of its own
  (deliberately out of scope, see Status). Anyone who can reach the port can drive your sessions.
  Do not port-forward it or put it behind a reverse proxy on an untrusted network.
- **Browser and DNS-rebinding boundary.** The localhost binding alone is not the whole boundary.
  A browser's same-origin policy does not gate WebSocket connection *establishment*, so a page on
  another origin could otherwise open a socket to the local port and drive a session, and a stable
  attacker domain could reach it by DNS rebinding. The WebSocket upgrade therefore enforces an
  origin allowlist, and both HTTP and WebSocket enforce a host allowlist. Non-browser clients such
  as the CLI send no origin and are allowed. Both lists are extendable through
  `CLAUDE_STATION_ALLOWED_ORIGINS` and `CLAUDE_STATION_ALLOWED_HOSTS` for legitimate proxy setups.
- **Permission modes.** Sessions run with Claude Code's normal permission gate. Skipping approvals
  is never a global default: it is an explicit per-project or per-session choice. Outside a
  container the interface marks it as a raised risk and says what it means. Inside a container it
  is the default and is labelled calmly, because there the container is the boundary, not the
  prompt.
- **Isolation tiers.** `direct` (the default, on the host in the project directory), `container`
  (Docker, with memory and process limits on by default), and `sandbox` (bubblewrap), which is
  designed but **not implemented**. Selecting it returns an error rather than silently degrading.
- **Docker socket.** Mounting the Docker socket into a container is off by default and takes two
  deliberate clicks, with the consequence stated where you choose it: on a rootful daemon it is
  equivalent to root on the host and voids every other limit set on the container.
- **Dispatch runner.** The headless task runner defaults to a read-only sandbox with approvals set
  to never. The sandbox, not a person, is the wall. In-workspace writes are opt-in. On the
  Anthropic path this maps to Claude Code's permission gate, which is policy enforcement and not a
  kernel sandbox; real filesystem isolation needs a container or bubblewrap.
- **Credentials.** No API keys are read or stored. Sessions use the sign-in material the provider
  CLIs already keep. Machine-local config is gitignored.

## Verify

```sh
npm run typecheck                # tsc --noEmit
node scripts/verify.ts --offline # API + agent bridge, no model calls
node scripts/verify-ui.ts        # drives the real UI in a real DOM against a real server
npm run verify                   # the full end-to-end pass (calls the model, costs tokens)
npm run gate                     # the pre-commit gate
```

Every harness spawns a real server on a scratch data directory and a free port, prints the value
each check observed, and kills what it started.

## Layout

| Path | Purpose |
| --- | --- |
| `src/server/index.ts` | HTTP and WebSocket server, JSON API, static UI |
| `src/server/agent-bridge.ts` | Wraps the provider runtimes; normalises messages into one event type |
| `src/server/events.ts` | The typed event union, the only contract between bridge and UI |
| `src/server/runtime/` | Provider runtimes (Claude Code, Codex) behind one interface |
| `src/server/registry.ts` | JSON project registry, atomic writes, project scan |
| `src/server/git.ts` | The git panel's server side |
| `src/server/snapshots.ts` | Per-session project snapshots via reflink, and restore |
| `public/` | The UI (vanilla JavaScript, no framework, no bundler) |
| `scripts/` | Verification harnesses, dispatch runner, gatekeeper, onboarding, gates |
| `docs/guide/` | The user guide, also served inside the app |

## Status

A personal project, developed in the open and moving quickly. It is built for one person on one
machine. Interfaces change without deprecation periods, and the tracker in `docs/bugs/` is the
honest record of what works and what does not.

Deliberately out of scope: an auth tier, multiple users, a file manager, a preview proxy, API-key
authentication.

## Licence

Orchard is released under the [PolyForm Noncommercial License 1.0.0](LICENSE)
(`PolyForm-Noncommercial-1.0.0`).

**You may** use, modify and share it for any noncommercial purpose: personal projects, study,
research, hobby work. Charities, schools, public research bodies and government institutions may
use it too.

**You may not** use it for a commercial purpose without a separate licence. To ask for one, open
an issue on this repository, or use the contact listed on the copyright holder's GitHub profile.
The terms are arranged with the copyright holder, not granted by this file. That is the same
channel the `Required Notice:` line at the top of `LICENSE` points at. There is no licensing
email address, deliberately.
