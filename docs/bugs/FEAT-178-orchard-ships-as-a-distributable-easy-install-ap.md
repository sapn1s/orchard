```orchard-ticket
{
  "id": "FEAT-178",
  "type": "feature",
  "title": "Orchard ships as a distributable, easy-install app (like commercial agent harnesses)",
  "summary": "A new user on a clean machine cannot install and run Orchard. Running it needs a checkout at a hardcoded path, Node 23+, a hand-run systemd unit, a manual per-project onboard, Docker, and a logged-in claude CLI. Commercial harnesses install in one command or one signed download; Orchard ships as a private dev repo.",
  "impact_if_we_wait": "Orchard cannot be handed to anyone else, or reinstalled cleanly even by its author: a second machine, a Windows dual-boot, or a wiped disk all start from scratch. Every assumption about this one machine hardens, so the packaging job only grows. Nothing is broken for the current user today.",
  "current_need": "A chosen distribution shape and a planned install path: one command or one download from a clean machine to a working dashboard, no hidden manual step. The shape (npm global, native binary, or desktop app) is a user-direction fork.",
  "severity": "medium",
  "area": "deploy / distribution",
  "reported": "2026-10-13",
  "reported_by": "user",
  "owner": "you",
  "work_state": "blocked",
  "human_action": "decide",
  "updated": "2026-10-13",
  "decision": {
    "id": "bd041081-bc41-400c-ba84-cdbe28f92a40",
    "mode": "single",
    "question": "Which distribution shape should Orchard ship as?",
    "options": [
      {
        "key": "A",
        "label": "npm global package",
        "what_changes": "ship built JS with a bin, npm i -g orchard, drop private:true",
        "benefit": "cheapest from today Node app, cross-platform where Node exists, npm auto-update; the SDK dependency bundles the host runtime CLI; matches Claude Code / Codex CLI",
        "cost": "needs a build step and dropping private:true, assumes Node >=23, and still needs guided OAuth login on first run (Docker only for sandboxed sessions)",
        "why_not_obvious": "presupposes Node >=23 already present and still needs guided OAuth login on first run, so npm-install alone is not clean-machine-complete"
      },
      {
        "key": "B",
        "label": "curl-sh installer script",
        "what_changes": "a script fetches a pinned release, provisions deps, installs the service, prints what it did",
        "benefit": "full control of first-run and dep-provisioning, Unix-friendly, can itself install shape A",
        "cost": "a script to maintain and sign, no native Windows experience, and a checker that only prints instructions fails the bar; it must provision",
        "why_not_obvious": "a shell installer is a supply-chain trust surface (WA section G), leans on Node underneath, and needs a separate PowerShell/native path for Windows"
      },
      {
        "key": "C",
        "label": "native binary",
        "what_changes": "bundle the Node runtime into a single signed executable per OS/arch",
        "benefit": "no Node-version floor on the user box, one download",
        "cost": "per-OS/arch builds plus signing, larger artifact, self-owned auto-update, and it still needs guided OAuth login (Docker only for sandboxed sessions)",
        "why_not_obvious": "removing the Node floor leaves every other first-run gap (login, asset and subprocess packaging) unsolved, at far higher build and signing cost"
      },
      {
        "key": "D",
        "label": "desktop app",
        "what_changes": "Electron/Tauri wrapping the dashboard plus bundled server, installs and launches like an app",
        "benefit": "most like a commercial harness (Cursor), Linux/macOS/Windows, built-in auto-update (note Electron has no Linux auto-updater)",
        "cost": "heaviest to build and sign across three OSes, largest surface, and still needs guided OAuth login (Docker only for sandboxed sessions)",
        "why_not_obvious": "the richest experience is the most build and signing work and a window over a failed backend is still a failed install"
      }
    ],
    "recommendation": "A",
    "recommendation_reason": "Smallest step, matches the npm tier cited; the SDK dependency bundles the host runtime. A review (OpenAI 01a13646) preferred C for the Node floor, but no shape alone reaches a dashboard: ship guided OAuth onboarding with A; C/D later.",
    "prerequisite": null
  },
  "decision_history": [
    {
      "id": "027d3ce7-b7bf-4def-8f3a-4c9d20b13cd0",
      "asked_on": "2026-10-13",
      "question": "Which distribution shape should Orchard ship as?",
      "mode": "single",
      "options_keys": [
        "A",
        "B",
        "C",
        "D"
      ],
      "chosen": null,
      "chosen_on": null,
      "chosen_by": null,
      "note": "Superseded unanswered on 2026-10-13 with board-tool decide --replace."
    }
  ],
  "success_criteria": [
    "A user on a clean machine (fresh VM or container, no checkout) installs from a published artifact with one command and reaches a working dashboard.",
    "The install needs no git clone at a hardcoded path and no hand-written systemd unit, and states its dependencies (Node, Docker, claude CLI) up front.",
    "The distribution shape is chosen by the user via the recorded decision on this ticket, not assumed by the implementer.",
    "First-run meets WA section P: works from a clean state with no hidden manual step, documented and tested, no weak defaults or secrets shipped.",
    "Proof: the install runs end-to-end on a fresh VM from the published artifact to a working dashboard, not a rehearsal on the author's machine."
  ],
  "code_refs": [],
  "related": [
    {
      "id": "FEAT-028",
      "relation": "see_also"
    },
    {
      "id": "FEAT-038",
      "relation": "see_also"
    },
    {
      "id": "FEAT-039",
      "relation": "see_also"
    },
    {
      "id": "FEAT-049",
      "relation": "see_also"
    },
    {
      "id": "FEAT-052",
      "relation": "see_also"
    },
    {
      "id": "FEAT-089",
      "relation": "see_also"
    },
    {
      "id": "FEAT-106",
      "relation": "see_also"
    },
    {
      "id": "FEAT-151",
      "relation": "see_also"
    },
    {
      "id": "FEAT-157",
      "relation": "see_also"
    },
    {
      "id": "FEAT-172",
      "relation": "see_also"
    },
    {
      "id": "FEAT-173",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "plan+review",
  "body_slots": {
    "Diagnosis": false,
    "Evidence": false,
    "Implementation notes": false,
    "Verification plan": false,
    "Migration and rollback": false,
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": null,
    "sha256": null,
    "original_title": null,
    "migrated_on": null,
    "migrated_by": null,
    "confirmation": "Authored directly in the record format through scripts/board-tool.mjs. There is no legacy original.",
    "dropped": []
  }
}
```

# FEAT-178 — Orchard ships as a distributable, easy-install app (like commercial agent harnesses)

## Symptom

User (verbatim): "we need distirbutable app easy install, similar how companies make harnesses".

Orchard today is a private dev repo run in place. There is no artifact a new user can install and no documented, tested path from a clean machine to a running dashboard. Commercial agent harnesses set the bar the user is pointing at: Claude Code and Codex CLI install with one `npm i -g` (or a `curl | sh` installer); Cursor ships a signed desktop app with auto-update. Orchard ships none of these.

## What in the repo currently assumes THIS developer's machine

Filed from a round-1 survey; every item cites a file actually read on 2026-10-13.

- **Run entry is the TypeScript source, not a built artifact.** `package.json`: `name: "orchard"`, `version: 0.1.0`, `"private": true`, `"engines": {"node": ">=23"}`, no `bin` field, `start` = `node src/server/index.ts`. It relies on Node 23+ running `.ts` directly (type-stripping); there is no build step, no published package, and `private:true` blocks `npm publish`.
- **systemd unit hardcodes a home-relative checkout path.** `deploy/claude-station.service`: `ExecStart=/usr/bin/node %h/projects/orchard/src/server/index.ts`, `WorkingDirectory=%h/projects/orchard`. It assumes a git checkout at `~/projects/orchard` and a `/usr/bin/node`. Installed by hand (FEAT-028 was the one-time cutover).
- **Desktop launcher is Linux-only.** `deploy/claude-station.desktop` + a Super+R / `xdg-open` flow (FEAT-028). Nothing equivalent exists for the user's Windows dual-boot or for macOS.
- **Per-project onboarding is a manual script with a checkout-coupled pointer.** `scripts/onboard.mjs` must be run by hand per project; the Working Agreement pointer it writes is `$ORCHARD_HOME/docs/prompts/WORKING_AGREEMENT.v4.md`, coupled to a local Orchard checkout existing (FEAT-039 tracks hoisting the WA to a project-neutral location; FEAT-089 made adding a project install the method).
- **Hardcoded `~/projects/orchard` strings beyond the unit.** e.g. `scripts/rename-to-orchard.sh`, several `scripts/verify-*.mjs`, and the CLAUDE.md pointers. A relocatable install cannot assume that path.
- **Data dir is ALREADY portable (reuse it).** `src/lib/paths.ts:23` `dataDir()` resolves `$CLAUDE_STATION_DATA`, else `$XDG_DATA_HOME`, else `~/.local/share` — the one piece that does not assume the dev's layout, and should anchor where the install keeps state.
- **The host runtime CLI is bundled in an npm dep; the real hard requirement is an OAuth login.** Corrected by the round-1 cross-provider review against the code: host (`isolation:direct`) sessions do NOT run a separately-installed `claude` — the SDK spawns a platform binary it ships, `require.resolve('@anthropic-ai/claude-agent-sdk-<platform>/claude')` (`src/server/runtime/runtime-update.ts:bundledCliPath`), so any npm/bundled install provisions the runtime automatically. The external `claude` binary is used only by the login flow (`src/server/claude-login.ts`, `CLAUDE_STATION_CLAUDE_BIN || 'claude'`). What a fresh machine genuinely lacks is an OAuth login: the SDK reads `~/.claude/.credentials.json` (OAuth only), so the installer must guide login on first run, not silently fail at the first turn. (Container sessions use a separate `@anthropic-ai/claude-code` baked into the per-project image.)
- **Docker is OPTIONAL — only the sandboxed-session feature needs it.** `src/server/container-manager.ts` shells to `docker` (`docker exec -i`, `docker inspect`, `docker build`) and builds per-project images. A clean machine has no daemon, so containerised sessions are unavailable until one is installed — but host/direct sessions and the dashboard run without Docker. First-run must show sandbox availability accurately and never silently downgrade a requested sandboxed session to host.
- **Node >= 23 is a steep floor.** Many clean machines ship an older Node; the install must either bundle/pin a runtime or state and check the floor loudly.

## Candidate distribution shapes (trade-offs for the decision)

- **A — npm global package** (`npm i -g orchard`, exposes a `bin`). Cheapest path from the current Node app; cross-platform where Node exists; auto-update via `npm`; the SDK dependency bundles the host runtime CLI, so the install provisions the runtime automatically. Costs: needs a build step (ship JS, not run `.ts` live), drop `private:true`, assumes Node ≥23 already on the box, and still needs a guided OAuth login on first run (Docker only for sandboxed sessions). Closest to how Claude Code / Codex CLI actually ship.
- **B — `curl | sh` installer script** that fetches a pinned release, provisions deps, installs the service, and prints what it did. Full control over first-run and dep-provisioning; Unix-friendly. Costs: a script to maintain and sign/verify (WA §P / §G supply-chain), no native Windows experience, and a checker that only *prints* missing-dep instructions fails the bar — it must provision, not just report.
- **C — native binary** (bundle the Node runtime, e.g. a single executable). No Node-version floor on the user's box; one file to download. Costs: per-OS/arch builds + signing, larger artifact, self-owned auto-update, and still a guided OAuth login on first run (Docker only for sandboxed sessions). Removing the Node floor leaves every other first-run gap (login, asset + subprocess packaging) unsolved at higher build/signing cost.
- **D — desktop app** (Electron/Tauri wrapping the dashboard + bundled server). Most "like a company harness" (what Cursor does); installs and launches like an app on Linux/macOS/Windows; carries auto-update (note: Electron has no built-in Linux auto-updater; Tauri ships no Node, so it needs a server sidecar). Costs: heaviest to build and sign across three OSes, largest surface, still a guided OAuth login underneath (Docker only for sandboxed sessions).

(Shapes are not mutually exclusive — e.g. B can install A — but the PRIMARY shape sets the build pipeline, the signing story, and the first-run UX, so it is a genuine fork for the user, recorded as the decision on this ticket.)

**The fork is NOT the whole job (round-1 cross-provider review).** No packaging shape alone reaches a working dashboard: the binding, shape-independent work is integrated first-run onboarding — guided OAuth login, loud Node-floor/dep checks, and accurate Docker-optional sandbox state. "No hidden manual step" here means *integrated guided* onboarding, not zero interaction (OAuth inherently needs the user). That onboarding must ship WITH whichever shape is chosen.

## First-run experience requirements (WA section P)

- Works from a clean state with **no hidden manual step**; the setup path is documented AND tested.
- Surfaces state: on first run, show what is installed, what is missing (OAuth login, Docker daemon for sandboxed sessions, Node floor), and what the user must do — never fail silently at the first turn, and never silently downgrade a requested sandboxed session to host.
- Security hygiene: no committed secrets in the artifact, least privilege, explicit opt-in for anything that widens blast radius (e.g. the Docker-socket mount the container manager already notes hands root).
- Supply-chain: install only from verifiable sources — a published npm package or a signed release binary, not an arbitrary `git clone` (WA §G supply-chain clause).
- Cleanup path (service/data removal) is tested against an isolated instance, not the author's live one.

## Proof bar

Stand up a **fresh VM or container** with no Orchard checkout and no hand-configured service. Install ONLY from the published artifact (the npm package / release binary / installer the decision picks). Reach a working dashboard. Record the exact steps and the result. A run on the author's already-configured machine does not count — the whole point is the clean-machine path.

## Related tickets

- **FEAT-028** — run as a background app (the existing systemd --user unit + desktop launcher; the Linux-only, path-hardcoded starting point this must generalise).
- **FEAT-038 / FEAT-089** — onboarding a project to Orchard's method (per-project setup a distributable install must also make turnkey).
- **FEAT-039** — WA pointer coupled to a local checkout; a relocatable install cannot assume `$ORCHARD_HOME`.
- **FEAT-049 / FEAT-172** — public-release scrub / leak posture; publishing an installable artifact crosses the same exposure line.
- **FEAT-052 / FEAT-173** — public README / quick-start (the install instructions live or die here).
- **FEAT-106** — consolidating Orchard's generated files into a project dir (clean install/uninstall depends on knowing where state lives).
- **FEAT-151 / FEAT-157** — updating the claude runtime from the UI / pinning a versioned Orchard base (auto-update is part of the distribution story).

## Decision

The distribution shape is a user-direction fork; it is recorded as a `board-tool decide` card on this ticket so it reaches the Needs-You rail. See the decision record in the ticket header.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-13 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-13 — agent
- **Decision declared:** Which distribution shape should Orchard ship as? Options: A — npm global package; B — curl-sh installer script; C — native binary; D — desktop app. Recommended: A — A is the smallest step to a real installable artifact from today's Node app, and matches how the cited harnesses ship; B can wrap A later, and C/D are larger bets inheriting the same claude-CLI and Docker deps. Written to the record with board-tool decide; the Decide card reads the record, not this line.

### 2026-10-13 — worker (finding r1)
- **Decision declared:** Which distribution shape should Orchard ship as? Options: A — npm global package; B — curl-sh installer script; C — native binary; D — desktop app. Recommended: A — Smallest step, matches the npm tier cited; the SDK dependency bundles the host runtime. A review (OpenAI 01a13646) preferred C for the Node floor, but no shape alone reaches a dashboard: ship guided OAuth onboarding with A; C/D later. Supersedes the earlier unanswered decision (kept in decision_history). Written to the record with board-tool decide; the Decide card reads the record, not this line.

### 2026-10-13 — worker (finding r1, cross-provider refutation)
- **Independent refutation (WA §A):** clean-room review dispatched in a SEPARATE read-only process, cross-provider. Provider/model: **OpenAI (Codex default)**, dispatch run `01a13646-e843-7c01-a478-f8521a681e64` (transcript under the OpenAI dispatch transcripts dir for this project). Charter gave only the plain requirement, the four options, and the repo facts (NOT the rationale or the recommendation). Objective: argue the best option and attack each on first-run, upgrades, Windows, Docker, systemd and native deps.
- **Verdict: recommendation SURVIVES as A, now CONDITIONED.** The review preferred C-first (to erase the Node ≥23 floor) but conceded C still leaves every other first-run gap and costs per-OS/arch builds + signing + self-owned auto-update — it buys only the floor at far higher cost. A remains the smallest step and matches the npm tier the user cited.
- **Factual error the review exposed, verified against the code and FIXED in this ticket:** the host runtime CLI is NOT a separately-installed dependency — it ships BUNDLED inside `@anthropic-ai/claude-agent-sdk` (`runtime-update.ts:bundledCliPath`, `require.resolve('@anthropic-ai/claude-agent-sdk-<platform>/claude')`). The external `claude` binary is used only by the login flow (`claude-login.ts`). This strengthens A (an npm install provisions the runtime). Corrected the "hard dependency on the claude CLI" bullet, the Docker-optional bullet, and the A/B/C/D cost lines.
- **Decisive cross-cutting insight added:** no packaging shape alone reaches a working dashboard; the binding, shape-independent work is integrated first-run onboarding (guided OAuth login, loud Node-floor/dep checks, accurate Docker-optional sandbox state, never a silent downgrade). Folded into the shapes section, the first-run requirements, and the conditioned recommendation.
- **Scope note:** this was source inspection + design review in a read-only sandbox; no packaging build or clean-machine install was performed (that is the ticket's own proof bar, for the chosen shape).
