```orchard-ticket
{
  "id": "FEAT-076",
  "type": "feature",
  "title": "No way to see whether a project uses our methodology",
  "summary": "A project drawer now shows a Wiring panel that checks, on every open, whether the project has the working agreement, local conventions, a ticket board and the board drift-guard, plus a one-click way to add each missing piece. Before this, a project could run with our tools and none of our discipline, invisibly.",
  "impact_if_we_wait": "Without the panel a project silently runs with the tools but none of the discipline, and people blame poor results on the model. Bounded: this is visibility and setup convenience, not data loss, and the panel only reads state until someone clicks to apply.",
  "current_need": "Restart the service on :4317 so the new route is served; client assets pick up on reload.",
  "severity": "medium",
  "area": "Project methodology setup",
  "reported": "2026-08-13",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-08-13",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A bare project shows the working agreement and board rows as missing",
    "A fully-wired project shows every methodology row as satisfied",
    "Applying setup to a scratch directory flips conventions, board and guard to satisfied",
    "Attaching the working agreement adds the ref and flips its row",
    "Setup is never run against the station's own working tree"
  ],
  "code_refs": [
    {
      "path": "src/server",
      "symbol": "wiringStatus",
      "note": "computes each check live from registry refs and files on disk; new route added alongside it"
    },
    {
      "path": "public/lib/drawer.js",
      "symbol": null,
      "note": "renders the Wiring panel and re-computes after each Apply"
    },
    {
      "path": "public/lib/api.js",
      "symbol": null,
      "note": "client call for the new status route"
    },
    {
      "path": "scripts/onboard.mjs",
      "symbol": null,
      "note": "shelled out server-side against the target hostPath only; idempotent, reports exists-vs-created"
    },
    {
      "path": "scripts/verify-feat-076-wiring.mjs",
      "symbol": null,
      "note": "FEAT-076 suite; boots a real station on a free port with a bare fixture and a fully-wired one"
    }
  ],
  "related": [
    {
      "id": "BUG-099",
      "relation": "see_also"
    },
    {
      "id": "BUG-107",
      "relation": "see_also"
    },
    {
      "id": "BUG-108",
      "relation": "see_also"
    },
    {
      "id": "FEAT-077",
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
    "archived_path": "docs/bugs/archive/FEAT-076-project-wiring-health-panel.md",
    "sha256": "ba1feaf8d48d7e4b9da8b69ee4b4c55a0b4f60f1155b5ee75d0ccb6822af0458",
    "bytes": 10465,
    "original_title": "per-project \"Wiring\" health panel: is this project actually using our methodology?",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head section by section: the two-layer diagnosis, all six checks and their derivations, both apply paths, the no-caching and path-safety constraints, and the fixture design are present.",
    "dropped": [
      "the ✅/⚠️/❌ glyph choice for panel rows",
      "the verbatim wording of the user's complaint about not knowing why a workflow was bad"
    ]
  }
}
```

# FEAT-076 — No way to see whether a project uses our methodology

## Diagnosis

### Two decoupled layers

A launched project inherits the runtime — tool servers, the Workflow tool, universal provider routing — but not the methodology. The methodology arrives by two independent routes. Session system-prompt injection at launch composes attached instruction templates, a live read of the project's conventions doc, and universal routing; it writes nothing to the repo. Project-file scaffolding is a separate explicit, idempotent script that creates the ticket board, the drift-guard scripts, a working-agreement pointer in the project's own instructions file, and a conventions stub.

Neither layer surfaced its state anywhere. A real private project was confirmed running with two tool servers attached, no working-agreement template, no conventions doc, no board, and its own instructions file carrying no pointer. Even this repo had an empty instruction list.

## Evidence

The panel's own suite runs 36/36 successfully against a two-project fixture: one bare project with no conventions doc, no board and no working-agreement ref, and one fully wired. The must-FAIL case was a bare project reported as satisfied before the check logic existed.

Anti-regression suites ran clean alongside it: tool-toggle 13/13, bug088 11/11, bug089 6/6, ui 7/7. Typecheck and the leak-gate were clean.

## Implementation notes

### What each row derives from

Working agreement: the versioned template ref present and enabled in project settings, or a resolvable pointer inside the project's own instructions file. Local conventions: the conventions doc exists and is non-empty. Ticket board: both the board index and its readme exist. Drift-guard: the project manifest carries the board-check script and the board script file is present. Provider routing is universal and shown for information only. Integrations reads the project's attached tools and links to the existing integrations group.

Nothing is memoized. Every render reads the registry and the filesystem, because a cached status is exactly the thing that can lie. The reads are cheap enough to do per drawer-open.

### Apply

Adding the working agreement reuses the validated project-patch path rather than hand-rolling a registry write. The scaffolding apply shells the onboarding script in the foreground against the host path taken from the registry, never from the client, and rides the existing host path guard. It is idempotent and reports exists-versus-created back to the user. It is gated behind an explicit click naming the target project, and it is never triggered as a side effect of opening the panel.

## Verification plan

Boot a real station server on a free port with a scratch data directory, never the live port. Assert the status call returns the correct per-check result for a bare project and a fully-wired one. Run the scaffolding apply against a scratch temporary directory and assert conventions, board and guard flip to satisfied; attach the working agreement and assert the ref appears and the row flips. Assert the scaffolding script is never invoked against the station's own working directory. Drive the real drawer render over the bare fixture and assert the missing rows and their Apply buttons appear.

## Risks

The apply path mutates another repository's working tree, which is a real user-visible side effect on a tree the station does not own. That is why the ticket flagged it as warranting a clean-room pass and why the scaffolding is confined to the registry-supplied host path with an explicit-click gate.

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
