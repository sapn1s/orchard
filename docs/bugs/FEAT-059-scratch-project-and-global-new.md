```orchard-ticket
{
  "id": "FEAT-059",
  "type": "feature",
  "title": "Global new-session button opened a session in the selected project",
  "summary": "The sidebar's global New button used to start a session inside whichever project was selected, adding a throwaway chat to that project's list and giving it that project's working directory and instructions. A built-in scratch space now owns those sessions, created on first use and editable like any other project. The per-project buttons are unchanged.",
  "impact_if_we_wait": "Throwaway questions would keep landing in real projects and mixing into their session history. Bounded: only where a session is listed and which directory it opens in, not the contents of any project or its files.",
  "current_need": "Nothing is outstanding. The scratch checks, the session and project suites, and the offline interface checks all passed, with type checking clean.",
  "severity": "medium",
  "area": "New session affordance",
  "reported": "2026-08-09",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-10",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Global New starts a session whose project is the scratch space, not the selected project",
    "No session appears under the previously selected project after using global New",
    "Per-project new-session buttons still create sessions in their own project",
    "The scratch space is created on demand and survives a restart",
    "Scratch settings are editable like any other project's",
    "A fresh install has no scratch directory until first use"
  ],
  "code_refs": [
    {
      "path": "dataDir()/scratch",
      "symbol": null,
      "note": "application-owned scratch directory, keyed by a constant rather than the repo path, so it survives restarts and the Orchard rename"
    }
  ],
  "related": [
    {
      "id": "BUG-041",
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
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-059-scratch-project-and-global-new.md",
    "sha256": "75fb0dda97667e55abde0896fc47e32420f449c6d1b6040ec21ae90c39d4e08c",
    "bytes": 9946,
    "original_title": "global \"New session\" should open a SCRATCH session, not one in the current project",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head: the duplication complaint, the application-owned scratch directory and its rationale, the rebinding, the defaults policy and the six-part verification bar are all present.",
    "dropped": [
      "the verbatim quotation of the user's original report, whose substance is in the summary and diagnosis",
      "the aside suggesting a clear-scratch action only if trivial, kept as a clause in the implementation notes"
    ]
  }
}
```

# FEAT-059 — Global new-session button opened a session in the selected project

## Diagnosis

### Why the global button was wrong

The sidebar's global `+`/New duplicated the per-project new-session buttons, which are the correct affordance for "a session in THIS project". It silently bound a throwaway question to whatever project happened to be selected, polluting that project's session list and handing the session a cwd, board and instruction set it had nothing to do with.

## Evidence

### What ran

17/17 scratch checks passed alongside the anti-regression suites: `verify:addproject` 7/7, `verify:sessions` 52/52, `verify:ui` 3/3, `verify:new-session-overrides` 5/5 and `verify:overrides` 5/5. `typecheck` stayed clean. A dedicated `verify:scratch` target is named in the record without a result of its own.

No independent clean-room verifier was dispatched for FEAT-059; the evidence above is the fixer's own executed run.

## Implementation notes

### The scratch project

A built-in `scratch` project owned by the application rather than the user's `~/projects` tree: directory `dataDir()/scratch` (i.e. `~/.local/share/claude-station/scratch`), created on demand and registered as a normal project with the reserved id `scratch` and the label "Scratch — throwaway". It is application state, not a user repo; it survives restarts and the Orchard rename because `dataDir` is keyed by a constant, not the repo path; it does not clutter `~/projects`; it is trivially wipeable; and no git repo is implied. The path is overridable via settings/env.

### Rebinding and defaults

The global button always starts a session in the scratch project with the application's defaults; per-project buttons keep their meaning. The destination is made unmistakable through the button title and the session's project label. Because scratch is a normal project, its settings row already covers provider, model, permissions and tools. Shipped defaults inject the working agreement but not the board or conventions, since there is no project context. Scratch sessions age out of the sidebar under the existing recency rules; a "clear scratch" action was left as a nice-to-have.

## Verification plan

### The user-observable bar (must FAIL pre-change)

Global New starts a session whose project is `scratch` and whose cwd is the scratch dir, with no session appearing under the previously selected project. Per-project buttons still create sessions in their own project. The scratch project is created on demand and survives a restart. Its settings are editable like any project's. A fresh install has no scratch dir until first use. Backed by `verify:addproject`, `verify:sessions`, `typecheck` and `verify:ui` offline.

## Activity log (APPEND-ONLY)
### 2026-08-09 — orchestrator
- Filed from user report; storage recommendation stated (Orchard-owned dataDir/scratch) rather than
  a user-tree directory, so it survives the rename and implies no repo.

### 2026-08-10 — agent (build)
**Hypothesis check (done BEFORE changing anything):** the ticket's claim — "the global New button binds
a session to the currently-selected project" — was verified against the actual code, not assumed. Found
in `public/app.js`: `$('#newBtn')`'s click handler read `state.current.projectId ?? state.projects[0]?.id`
and called `startNew(id)` (was app.js:6963-6967), and `paintCrown()`'s tooltip literally said
`New session in ${dest.name}` where `dest = currentProject() ?? state.projects[0]` (was app.js:1502-1510)
— i.e. the code did not just resemble the bug, its own comment documented the bug as intended design
("The sidebar's + spawns in the CURRENT project"). Confirmed with a pre-change run of the new verify
script below: global New landed on `scratch-fixture-a` (whatever was selected), never `scratch`.
**No discrepancy found — hypothesis confirmed exactly as chartered.**

**Built:**
- `src/lib/paths.ts` — `scratchDir()`: `dataDir()/scratch`, overridable via `CLAUDE_STATION_SCRATCH_DIR`.
  Deliberately does NOT create the directory (side-effect-free path lookup).
- `src/server/registry.ts` — `SCRATCH_PROJECT_ID = 'scratch'`, `SCRATCH_PROJECT_NAME = 'Scratch — throwaway'`,
  `ensureScratchProject()`: get-or-create, `ensureDir()`s the folder and registers a normal `Project` row
  (isolation `direct`, `defaultSettings()`) on first call only; idempotent; keeps `hostPath` synced if the
  env var changes between runs.
- `src/server/index.ts` — `POST /api/projects/scratch/ensure` (line ~417, alongside the existing `/scan`
  route): calls `ensureScratchProject()`, returns the project. No other route needed — once registered,
  scratch is a normal project and the existing GET/PATCH `/api/projects/:id` routes already serve it.
- `public/lib/api.js` — `ensureScratchProject()` client helper hitting the route above.
- `public/app.js`:
  - `#newBtn` click handler (was line 6963) replaced with `startScratch()`: calls the ensure endpoint,
    upserts the returned project into `state.projects` (so `currentProject()` resolves it), then
    `startNew(p.id)` — reusing the existing, already-correct `startNew()` (it does not carry overrides
    across projects; verified unaffected by `verify-new-session-overrides.mjs`, still green).
  - `paintCrown()` (was line 1502): the `#newBtn` tooltip/aria-label no longer tracks `currentProject()`;
    it's now a fixed string naming the scratch destination, so the button never again claims to target
    "whatever is selected".
  - Per-project `+` (`renderProjectGroup`, line ~583) is UNTOUCHED — still calls `startNew(p.id)` directly
    with its own project's id.

**Injection decision (ticket's recommended split, implemented):** WA yes, board snapshot + local
conventions no. Traced the real compose surface: `agent-bridge.ts:478` calls
`composeInstructions(refs, {hostPath: project.hostPath, routing: true})` (folds WA/whatever templates the
project's `instructions` list names, plus local conventions via `hostPath`), and `agent-bridge.ts:783`
separately layers `boardStateSection(project.hostPath)`. Both `boardStateSection()` and
`localConventionsSection()` already return `null` when `docs/bugs/` / `docs/CONVENTIONS.md` are absent
from `hostPath` (see `board.ts:223`, `templates.ts:301-311`) — since the scratch dir starts empty and
nothing in this change ever creates those files there, board + local-conventions injection is opt-out
STRUCTURALLY (no project context exists to summarize) rather than via a special-cased `if (isScratch)`
branch. This keeps scratch "a normal project" exactly as required — it just happens to have no board
because it has no `docs/bugs/`, same as any other boardless project (e.g. $HOME). No template/board code
changes were needed or made; verified directly against `composeInstructions()`/`boardStateSection()`
(the real functions, not a re-derivation) in `scripts/verify-scratch.mjs` part F.

**Verification:** new `scripts/verify-scratch.mjs` (not added to package.json — reporting the entry per
instructions: `"verify:scratch": "node scripts/verify-scratch.mjs"`). Confirmed RED pre-change (`git
stash` the 5 source edits, keep the new script, run it): 7/17 failed exactly on the ticket's claims
(global New still landed on the selected project; no on-demand dir/registration; no restart survival; no
scratch PATCH) while the 4 injection checks and the per-project-button check passed (expected — those
paths were never broken). Post-change (`git stash pop`): 17/17 green, covering fresh-install absence,
on-demand creation, no-pollution of the previously-selected project, restart survival, PATCH-ability, and
the compose-surface injection assertions.

Anti-regression suite, all run for real against this change (scratch ports/dataDir per script,
never touched :4317, killed by pid via each script's own `stopByPid`):
- `typecheck` — clean.
- `verify:addproject` (`node scripts/verify-addproject.mjs`) — 7/7 PASS.
- `verify:sessions` (`node scripts/verify-sessions.ts`) — 52/52 PASS.
- `verify:overrides` (`node scripts/verify-overrides.mjs`) — 5/5 PASS.
- `verify:new-session-overrides` (`node scripts/verify-new-session-overrides.mjs`) — 5/5 PASS.
- `verify:ui --offline` (`node scripts/verify-ui.ts --offline`) — 3/3 PASS, genuinely (not waved off):
  boot, real-session listing, and transcript rendering all green.

Noted but out of scope: two orphaned test-server processes from unrelated prior runs were found
listening on 44173 (`CLAUDE_STATION_DATA=/tmp/cs-arch-data-*`) and 44677
(`CLAUDE_STATION_DATA=/tmp/claude-station-ui-*`) — neither started by this session, left untouched
(:4317 — the real app — confirmed separate and undisturbed throughout).

**Closing assessment:** symptom of a deeper design flaw? **Yes** — the same one BUG-036/039's family
names: a control's TOOLTIP was allowed to assert its own correctness ("New session in X") without any
test ever having to prove X was where the session landed, so the bug shipped self-documented as a
feature and stayed invisible to every existing verify script (none of them drove the global button — only
`verify-ui.ts`'s live-session path used the per-project `+`, by design, per its own BUG-036 comment). The
fix closes the immediate gap with `verify-scratch.mjs`, but the general lesson is: a UI affordance whose
destination is asserted only in a title-attribute string, never in an automated click-and-check, will
drift from its code the moment someone "obviously" changes one but not the other.
