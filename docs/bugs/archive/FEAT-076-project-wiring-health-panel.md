# FEAT-076 — per-project "Wiring" health panel: is this project actually using our methodology?

- **Status:** DONE (2026-08-13 — needs a :4317 restart to serve the new route; client assets live on reload)
- **Area:** src/server (new `wiringStatus(projectId)` + route) + public/lib/drawer.js (new panel) + public/lib/api.js
- **Reported:** 2026-08-13 by user

## Problem
A project launched in Orchard inherits the *runtime* (MCP tools, Workflow tool, universal Provider
Routing) but NOT automatically the *methodology* (Working Agreement, local conventions, ticket board,
board drift-guard). Those reach a session via two decoupled layers:
1. **Session system-prompt injection** at launch (`composeInstructions`, non-destructive): attached
   instruction templates (`project.settings.instructions`) + live-read `docs/CONVENTIONS.md` +
   universal Provider Routing. Writes NOTHING to the repo.
2. **Project-file scaffolding** (`scripts/onboard.mjs`, explicit, idempotent): `docs/bugs/` board +
   board:check/gen scripts + a CLAUDE.md WA pointer + a `docs/CONVENTIONS.md` stub.

Today the user cannot SEE which layers are applied for a given project — so a project can silently be
running with our tools but none of our discipline (confirmed live: a real private project has `tools:
{serena,playwright}` but no attached WA template, no `docs/CONVENTIONS.md`, no `docs/bugs` board, and
its own CLAUDE.md with zero WA pointer). Even `orchard` itself has `instructions: []`. The failure
mode: "our orchestration guidelines aren't loaded and I wonder why the workflow is bad, without
knowing why."

## Wanted
A per-project **Wiring** panel in the project drawer that LIVE-COMPUTES each methodology layer from
its true source (registry refs + files on disk — no cached/derived state that can lie or drift) and
shows ✅ / ⚠️ / ❌, with a one-click **Apply** for each missing layer so setup happens from the UI.

### Checks (each derived, not stored)
| Check | Derivation | Apply action |
|---|---|---|
| Working Agreement | `working-agreement-v2` (or `working-agreement`) ref present+enabled in `settings.instructions` **OR** the project's CLAUDE.md contains a resolvable WA pointer | attach the `working-agreement-v2` template ref via the existing project-PATCH path |
| Local conventions | `<hostPath>/docs/CONVENTIONS.md` exists & non-empty | run onboard (creates the stub) |
| Ticket board | `<hostPath>/docs/bugs/INDEX.md` **and** `README.md` exist | run onboard |
| Board drift-guard | `<hostPath>/package.json` has a `board:check` script (and scripts/board.mjs present) | run onboard |
| Provider routing | universal — always ✅ (informational) | — |
| Integrations | `settings.tools` (serena / playwright) | link to existing Integrations group |

- **Apply = onboard** shells `node scripts/onboard.mjs --dir=<hostPath>` (idempotent — never clobbers
  existing artifacts; re-run just reports exists-vs-created). Server-side, foreground, only the target
  hostPath. **Apply = attach WA** is a registry PATCH adding the ref — reuse the validated project
  PATCH path, do not hand-roll registry writes.
- Panel re-computes after any Apply so the user sees the ✅ flip live.

## Constraints
- **Read the true source every render** — filesystem + registry, no memoized status that can go stale
  (the whole point is it can't lie). Cheap `fs.existsSync`/small reads; fine per drawer-open.
- Server endpoint path-safe (rides the BUG-076 Host guard like `/api/guide`). hostPath comes from the
  registry, never from the client.
- onboard-from-UI mutates the TARGET project's working tree (a real, user-visible side effect on
  THAT repo) — confirm/September: gate the Apply behind an explicit click with a clear label ("Scaffold
  board + guard into <project>"), and surface onboard's exists-vs-created report back to the user.
  NEVER run onboard against orchard's own tree as a side effect of merely opening the panel.

## Verification (§C)
- New `scripts/verify-feat-076-wiring.mjs` (`verify:feat076`): boots a REAL station server (free port,
  scratch dataDir; never :4317) with a REALISTIC fixture — one BARE project (no CONVENTIONS, no
  docs/bugs, no WA ref: a real bare-repo shape) and one FULLY-WIRED project — and asserts `wiringStatus`
  returns the right ✅/❌ per check for each. Must-FAIL: a bare project reported as WA/board ✅ before
  the check logic exists. Apply path: run onboard against a scratch temp dir → board/conventions/guard
  flip to ✅; attach-WA → the ref appears and WA flips ✅. Assert onboard is NEVER invoked against the
  station's own cwd.
- Drive the REAL drawer render (happy-dom or headless) over the bare fixture: panel shows the ❌ rows
  and the Apply buttons.
- Anti-regressions: verify:tool-toggle, verify:bug088, verify:bug089, verify:ui, verify:onboard,
  typecheck, leak-gate.
- **Risk bucket:** UI + a repo-mutating Apply (onboard shell-out). The onboard-from-server shell-out
  touches a real working tree → flag whether an independent clean-room pass is warranted for that path.

## Activity log (APPEND-ONLY)
### 2026-08-13 — orchestrator
- Filed from user request. Mechanism traced: `composeInstructions` (templates.ts:409) folds attached
  refs + `localConventionsSection(hostPath)` + universal `routingSection`; both that project AND orchard
  have `settings.instructions: []`. onboard.mjs (`--dir=`) is the file-scaffolding layer. WA templates
  `working-agreement-v2` / `working-agreement` exist in the library and are attachable. Single lane
  (server + drawer + api), serialize — no concurrent same-file writers.

### 2026-08-13 — worker (implementation)
Implemented the full lane. Fix map:
- **src/server/wiring.ts** (NEW): `wiringStatus(project)` — pure read, derives each layer from its
  true source every call (registry `settings.instructions` + `toolSettingsOf`; fs existence/non-empty
  of `<hostPath>/docs/CONVENTIONS.md`, `docs/bugs/{INDEX,README}.md`, `scripts/board.mjs`; a
  `board:check` script in `package.json`; a WORKING_AGREEMENT / `orchard:wa-pointer` reference in the
  project's own `CLAUDE.md`). Exports `WA_TEMPLATE_IDS`, `hasEnabledWaRef`. Zero side effects — never
  scaffolds, never shells out. Checks: working-agreement, conventions, board, drift-guard (ok/warn/
  missing), routing + integrations (informational).
- **src/server/index.ts**: import wiring; new project-scoped routes under the existing handler (so they
  ride the BUG-076 Host guard like `/api/guide`): `GET /api/projects/:id/wiring` → `{wiring}` (pure
  read) and `POST /api/projects/:id/wiring/apply` `{check}` → `{wiring, reports?}`. Apply `attach-wa`
  goes through `validateProjectPatch` + `updateProject` (enables an existing WA ref in place or appends
  `working-agreement-v2`, never a hand-rolled registry write); `conventions|board|drift-guard` call the
  same idempotent `onboardProject(p.hostPath)` the FEAT-038 button uses — hostPath ALWAYS from the
  registry, never the body; onboard is NEVER invoked on a status read. Unknown check → 400.
- **public/lib/api.js**: `wiring(id)` (via `optional` → null when route absent) + `applyWiring(id,check)`.
- **public/lib/drawer.js**: new "Wiring" section + `wiringGroup`/`wiringRow`/`refreshWiring`/`applyWiring`.
  Renders ✅/⚠️/❌/ℹ️ per row with Apply; attach-WA applies directly (registry-only, reversible), onboard
  Apply is gated behind an armed "Scaffold into <project>" confirm naming the exact repo; re-fetches
  status after any Apply so the row flips live and surfaces onboard's exists-vs-created summary. Wiring
  state re-read on every drawer open and reset on project switch (`open()` + `repaint()`).
- **public/styles.css**: `.wiring-row` / `.wiring-confirm` styling (no red; hairline idiom).
- **scripts/verify-feat-076-wiring.mjs** (NEW) + `verify:feat076` in package.json.

Verification (`npm run verify:feat076`): **36/36 PASS**. One scratch server (free ephemeral port, scratch
dataDir — never :4317), realistic BARE (real bare-repo shape: package.json w/o board:check, own CLAUDE.md
w/o WA pointer, no docs, tools serena+playwright) vs fully-onboarded WIRED vs PRISTINE fixtures. Covers:
bare reports every methodology layer ❌ and wired reports every one ✅ (bidirectional); 5× GET on PRISTINE
creates nothing (read has zero side effects); attach-wa flips WA ✅ via a persisted ref while CLAUDE.md
still has no pointer (ref arm) and wired proves the pointer arm; onboard Apply scaffolds into the project's
OWN hostPath; **station ROOT gains no methodology-file mutation across the whole run + every Apply report
path resolves inside the target dir** (onboard never runs against the station cwd); unknown check → 400;
foreign Host → 403; and a REAL brave-headless drive of the actual drawer (topbar cog → Wiring section) over
a freshly-added never-wired project asserts the ❌ rows + Apply buttons render.
- **Must-FAIL proof:** with the check logic stubbed to always-`ok` (simulating "no derivation"), BARE
  reports every layer ✅ — failing checks (1b)-(1e); restored → BARE correctly reports all missing. Route
  absent → `api.wiring` null → panel never renders → section (8) fails.
- **Anti-regressions:** typecheck PASS; verify:tool-toggle 13/13; verify:bug088 11/11; verify:bug089 6/6;
  verify:ui 7/7; verify:onboard 34/2 (the 2 failures are PRE-EXISTING on clean HEAD — spawned board:check
  ESM-resolve errors under a tmp dir, unrelated to this lane; confirmed by stash). leak-gate PASS (scrubbed
  a private token that had leaked into this ticket + the verify script).
- **Risk bucket:** UI + a repo-mutating Apply (onboard shell-out into a real working tree). Per §C an
  independent clean-room verify pass IS warranted for the onboard-from-server shell-out path — flagged to
  the orchestrator (scripts/independent-verify.mjs / a second fresh-context agent). The mitigations in
  place: hostPath is only ever the registry value; onboard is idempotent; the read path is proven to have
  zero side effects; and the "never against station cwd" invariant is asserted in the suite.
- **Deploy note:** client assets (lib/drawer.js, lib/api.js, styles.css) reach users on a normal reload —
  no build step (app.js imports lib/* directly). The new SERVER route needs a **:4317 restart** to be
  served; I did NOT restart the service or :4317 (would interrupt the running session/orphan agents) —
  handing that to the orchestrator.
