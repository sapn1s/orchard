# FEAT-139 — one Settings home, with a Machine · Project · Session scope spine

- **Status:** IN-PROGRESS
- **Severity:** medium
- **Area:** drawer / server (global-settings) / sidebar / styles
- **Reported:** 2026-09-07 by user (via orchestrator)
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED.

Dispatch: ticket=FEAT-139 phase=fixing round=1 class=fix

## Symptom
User: "need uiux feature where u can click on global settings, under navbar,
collapse things into it like templates, appearance, but also add ability to
configure project defaults globally — do sessions run in containers, provider
dispatches allowed, MCP etc. Visually pleasing to quickly navigate." Follow-up:
"our current settings sidebar is a bit too complex to navigate, so combine both
views into something nice, group cognitively."

Three separate sidebar-foot doors (Templates `#libBtn`, Appearance `#themeBtn`,
plus the cog → project settings), a buried text link to the machine-wide
"Global defaults" drawer view, and a five-group project-settings IA the user
finds hard to navigate. Global defaults accepted only model + effort — the
"sessions in containers / provider dispatch / MCP" knobs the user named had no
machine-wide default at all.

## Expected
One navbar Settings door. Inside it, a single panel whose spine is a three-way
scope control — **Machine · This project · This session** — that combines the
old project-settings and global-defaults views. Templates and Appearance live
under Machine scope. Machine-wide defaults exist for isolation, OpenAI dispatch
and the MCP tool toggles (not just model/effort), and per-project values inherit
from them with a visible "overrides the machine default" affordance. Theme is a
real control in the panel, not a localStorage-only cycle. Project settings are
re-grouped around what a user is trying to DO.

## Scope (built)
1. Single door: `#libBtn` and `#themeBtn` removed from the sidebar foot; the
   navbar cog (`#cogBtn` / seal-strip `#settingsBtn`) is the one entry.
2. Scope spine: `#dScope` is now `Machine · This project · This session`. Machine
   scope renders the widened global-defaults panel in the same view/idiom as the
   project settings — the two views are combined.
3. Widened global layer (`global-settings.ts`): `isolation`, `openaiDispatch`,
   `serena`, `playwright` added to `model` + `effort`. Validation stays strict.
   The tool/isolation defaults FEED the creation path
   (`resolveNewProjectIsolation`, `resolveNewProjectToolSettings`) so they are
   real seeds, not dead toggles — see Out-of-scope on why model/effort inherit
   LIVE while the others seed NEW projects only, and how the UI says so.
4. Theme becomes an Appearance control under Machine scope (localStorage stays
   the fast client read; the panel is the proper surface).

## Cognitive re-grouping (justification)
Old five groups mixed altitude: permissions sat under "Model & behaviour",
provider+integrations under "Instructions & tools", wiring was its own top-level
group. New IA is organised by the question the user is answering:
- **Model & spend** — which brain, how hard it thinks, budget.
- **Isolation & environment** — where/how it runs (isolation tier, container,
  mounts, services, snapshots).
- **Capabilities** — what it can reach and do (provider engine, browser + MCP
  tool toggles, permissions).
- **Instructions** — how it is guided (instruction stack, response format).
- **Advanced** (collapsed) — rare maintenance: wiring, memories, git, processes.
Progressive disclosure: the four common sections open, Advanced collapsed. All
group `data-focus` anchors preserved so FEAT-054 deep-links still land.

## Out of scope (deliberately NOT built)
- Per-class model routing (`class=fix|explore|verify` → model). It is a LIE
  today (`dispatch-broker.ts` forwards `--model` verbatim; nothing maps class →
  model) and must not appear as a control. Worth a separate FEAT for the routing
  engine if wanted.
- Arbitrary user-defined MCP servers (`plannedMcpServers` is a fixed set of 3).
- Any migration of existing on-disk records. Existing projects keep their
  concrete isolation/tool values; a machine-default change only affects NEW
  projects for those knobs (model/effort inherit live because a project stores
  `null` for them).

## Context pack
- Files: `public/lib/drawer.js` (scope spine, machine view, re-grouping),
  `public/index.html` (#dScope, sidebar foot), `public/app.js` (theme hooks,
  remove libBtn/themeBtn), `public/styles.css` (3-seg scope, appearance),
  `public/lib/api.js` (patchSettings passthrough — unchanged shape),
  `src/server/global-settings.ts` (widened GlobalDefaults + validation),
  `src/server/registry.ts` (creation path reads global defaults),
  `src/server/index.ts` (GET/PATCH /api/settings — unchanged, passthrough).
- Related: FEAT-118 (global model/effort), FEAT-131/FEAT-133 (creation-time
  isolation/tool defaults), FEAT-034 (settings showing inapplicable options),
  FEAT-054 (deep-link focus), BUG-158 (seal-strip settings door).

## Symptom of a deeper design flaw?
(answered on close)

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-07 — fixing lane (round 1, class=fix)
- **Understood:** Consolidate the three settings doors (cog/project, `#libBtn`
  Templates, `#themeBtn` Appearance) + the buried "Global defaults" view into one
  panel with a Machine · This-project · This-session scope spine; widen the
  machine layer past model/effort to isolation + dispatch + MCP toggles WITHOUT
  shipping a dead toggle; make theme a real control; re-group the project IA.
  Verified every ground fact from the explore lane at file:line before building
  (global-settings.ts :70/:113/:137, drawer.js VIEWS/globalsView/open/paint,
  registry creation resolvers, index.html doors) — all held.
- **Changed (unstaged):**
  - `src/server/global-settings.ts` — widened `GlobalDefaults` with `isolation`,
    `openaiDispatch`, `serena`, `playwright` (all `null`=built-in); strict
    validation (bad isolation / non-bool → 400); doc'd the LIVE-inherit
    (model/effort) vs NEW-PROJECT-SEED (the rest) split at the owner.
  - `src/server/registry.ts` — `resolveNewProjectIsolation` /
    `resolveNewProjectToolSettings` now read the global defaults as the "wanted"
    values (still behind the container + playwright-binary preflights), so the
    machine toggles are REAL creation seeds, not dead. Imports `readGlobalDefaults`.
  - `public/index.html` — `#dScope` → 3 tabs (Machine/This project/This session);
    sidebar foot: removed `#libBtn` + `#themeBtn`, added `#settingsFootBtn`.
  - `public/lib/drawer.js` — machine scope routes to new `machineDefaultsView()`
    (Appearance seg, resolution-order note, model/effort pickers, new-project
    defaults segs for isolation + 3 tools, Templates link, model-overriders list);
    `globalSeg()` tri-state (Built-in/values) helper; re-grouped project sections
    to Model&spend / Isolation&environment / Capabilities(provider+integrations+
    permissions) / Instructions / Advanced(wiring+memories+git+processes);
    `open()` honours `opts.scope` and de-sticks machine on project-context opens;
    paint() retitles/hints per scope; "Switch to This project" copy fix.
  - `public/app.js` — theme refactor (state exposed via ctx.getTheme/setTheme/
    themes; no more `#themeBtn`/`#themeVal`/`#libCount`); `#settingsFootBtn` opens
    Machine scope; removed `#libBtn` listener + libCount write.
  - `public/styles.css` — segmented `.d-scope` spine + `.gseg`/`.gset`.
- **Verified (fixer run, real scratch server on ephemeral port, isolated
  CLAUDE_STATION_DATA/CONFIG_DIR, 3 seeded projects + 1 model-overrider):**
  - `npm run gate` → PASS (exit 0), typecheck clean, no leaks.
  - Server: PATCH /api/settings accepts the 4 new fields; bad isolation → 400,
    non-bool serena → 400. Set machine defaults {isolation:sandbox, serena:false,
    openaiDispatch:false, playwright:true} then POST a NEW project with no
    tools/isolation → created with isolation=sandbox, serena=false,
    openaiDispatch=false, playwright=false (fell back via its host-binary
    preflight — correct). This is the anti-dead-toggle proof: the machine
    defaults visibly changed a new project's stored config.
  - Playwright (headless MCP, real app): one navbar/foot door; sidebar foot =
    {Add project, Settings} only (libBtn/themeBtn gone). Scope spine renders 3
    tabs. Machine scope shows Appearance + model/effort + new-project defaults +
    Templates(8) + "1 project overrides the model → beta:opus". Theme round-trip:
    clicking Dark sets html[data-theme]=dark + localStorage + aria-pressed;
    computed surfaces all dark (--window #131513, drawer rgb(19,21,19), ink
    #E6E9E5). Isolation round-trip: clicking Container persisted to server
    (GET /api/settings → isolation:container) and UI reflected it. Project scope
    sections = [Model&spend, Isolation&environment, Capabilities, Instructions
    open; Advanced collapsed]; Capabilities contains Provider+Integrations+
    Permissions; Advanced contains Wiring+memories+git+processes. Session scope
    hint + project-only notes correct. 0 console errors.
  - Screenshot rasterisation from the shared browser did not reflect dark surfaces
    (light composite) though computed styles were dark — a known shared-browser
    artifact, not a product defect; dark correctness proven via getComputedStyle.
- **Verified-by:** PENDING — independent clean-room verify warranted (this touches
  the project CREATION path, a stateful/regression-prone area). Attacks to name:
  (1) create a project via POST with EXPLICIT settings.tools/isolation → the
  global default must NOT override an explicit request (createProject honours the
  explicit value; verify it still does); (2) global isolation=container on a
  machine with no docker → new project must fall safe to direct (preflight);
  (3) settings.json with a garbage/legacy shape → readGlobalDefaults tolerant,
  session start never throws; (4) unknown field in PATCH still 400.
- **Still open / handoff:** none blocking. If the orchestrator wants the
  screenshots in `docs/bugs/assets/`, they were captured live but not saved (the
  docs/bugs tree was lock-held by a concurrent lane at cleanup time); re-run the
  scratch driver to regenerate if needed.
- **Symptom of a deeper design flaw?** Partial-yes. The recurring shape is
  FEAT-034 / FEAT-118 / this: settings surfaces proliferate doors and scopes
  ad hoc, and each new knob picks its own home. The durable fix is the scope
  SPINE this ticket introduces (one panel, scope decides applicability) — future
  knobs slot into a scope rather than spawning a door. Not filing an ARCH: the
  invariant ("every config knob is reached through the one panel, placed by
  scope + cognitive group") is now expressed in code, not pending a decision.

### 2026-09-07 — independent-verify attempt (round 1, class=verify)
- **Understood:** run the clean-room cross-provider verification the fixer asked
  for (openai verifier, anthropic author), exercising the four named attacks.
- **Outcome:** VERDICT-CONTRACT **INVALID** — the verification dispatch did NOT
  run. The clean room exported and copied node_modules successfully and the
  openai dispatch STARTED (thread 01a07c25-d6c4-72d1-8933-cd35029dbc65), then
  failed `[quota-window]`: "You've hit your usage limit … try again at 6:30 PM."
  Nothing about FEAT-139 was verified or refuted — this is a provider
  availability failure, not a finding against the feature. Did NOT fall back to
  same-provider verification (that would defeat the point).
- **Blocker found and fixed first:** the run was impossible until BUG-172 was
  fixed — `git archive` was mis-classified as a git write, so the clean-room
  export refused before any dispatch. See BUG-172 (fixed, unstaged). Post-fix the
  export works; the only remaining blocker is OpenAI quota.
- **Verified-by:** still PENDING — re-dispatch the openai clean-room verify after
  the quota window resets (≥ 6:30 PM), then paste the `Verified-by: dispatch
  openai run <id>` line here per docs/bugs/README.md.
- **Handoff:** requirement file `/tmp/feat139-req.txt` is intact; re-run the exact
  command in the round-1 verify charter. The four attacks to exercise are named in
  the fixer's `Verified-by: PENDING` bullet above.

### 2026-09-08 15:42Z — fixing lane (round 2, class=fix)
- **Understood:** user reported the round-1 Settings panel "looks good visual but
  the buttons are not highlighting currently selected option — eg is serena on or
  off, no difference visually." Treated serena as one instance of a class and
  audited every control.
- **Root cause (measured in the real app, headless Playwright, before touching
  code):** every segmented control paints its SELECTED button with
  `background: var(--sunken)` — which is EXACTLY the `.grp` card background the
  seg sits on. Measured light: selected bg `rgb(241,242,239)` == card
  `rgb(241,242,239)` (selEqualsCard TRUE); dark: selected bg `rgb(26,29,26)` ==
  card `rgb(26,29,26)`. So the "selected" fill carried ZERO contrast; the only
  signal was a faint `--hair→--ink-4` border and `--ink-3→--ink` text shift the
  user could not see. My hypothesis (some control types unstyled) was WRONG — all
  seg types were equally broken by one shared CSS rule; the `.sw` switches and
  `.cb` MCP checkboxes were already correct (they use the solid-fill idiom).
- **Broken control class (7 seg instances across 2 scopes, all via
  `.seg button[aria-pressed="true"]`):** Machine → Appearance (System/Light/Dark),
  New-project isolation (Built-in/Container/Sandbox/Direct), and the three On/Off
  toggles (OpenAI dispatch, Serena, Playwright); Project → Isolation
  (Container/Sandbox/Direct) and Provider (Claude/OpenAI Codex). Already-correct,
  audited-and-left: the `.d-scope` scope spine (window-bg+border+shadow), all
  `.sw` switches, the `.cb` checkboxes, and the native `<select>` model/effort
  pickers (render their value natively).
- **Changed (unstaged) — CSS ONLY, `public/styles.css`:** rewrote
  `.seg button[aria-pressed="true"]` to the panel's own on/off idiom — the solid
  fill already used by `.sw`/`.cb` in this same drawer (NOT a new visual
  language): `background/border-color: var(--solid); color: var(--on-solid)`, plus
  `.seg button[aria-pressed="true"] .g` → `--on-solid` and a hover refinement.
  `--solid` inverts per theme (dark chip on light, light chip on dark), so
  selection reads at a glance in BOTH themes and is a luminance inversion, not a
  hue — state is not colour-alone. No drawer.js change needed: the buttons already
  set `aria-pressed`.
- **Verified (headless Playwright MCP against a real scratch server on ephemeral
  port 40947, isolated CLAUDE_STATION_DATA, seeded globals
  {isolation:sandbox, openaiDispatch:true, serena:false, playwright:false} + one
  project {isolation:sandbox, provider:openai}):**
  - must-FAIL (pre-change): selected seg fill == card fill in BOTH themes, both
    scopes (screenshots `FEAT-139-before-machine-{light,dark}.png`).
  - PASS (post-change): selected fill light `rgb(27,31,29)` / dark
    `rgb(230,233,229)` — selEqualsCard FALSE everywhere; a large luminance delta
    vs the card and vs the transparent unselected buttons. Machine + project,
    light + dark. (Note: reading two themes in one JS turn returns a stale
    custom-property value for the second read; an isolated single-theme read with
    a forced reflow gives the true rendered value, matched by the screenshots.)
  - ARIA: 19/19 machine + 14/14 project selection controls carry aria-pressed;
    0 missing; the pressed one matches the visual selection.
  - Saved-value round-trip after a FRESH reload: machine segs rendered
    [System, Sandbox, On, Off, Off] == seeded globals; project showed
    Sandbox + OpenAI Codex == stored — displayed state tracks the SAVED value.
  - `npm run gate` → PASS (exit 0): leak-gate, check-nul, typecheck all clean.
  - Screenshots in `docs/bugs/assets/`: FEAT-139-before-machine-light.png,
    FEAT-139-before-machine-dark.png, FEAT-139-after-machine-light.png,
    FEAT-139-after-machine-dark.png, FEAT-139-after-project-light.png,
    FEAT-139-after-project-dark.png.
- **Bucket / Verified-by:** low-risk contained-render CSS fix (WA §N: contained
  render → the proof above IS the whole proof; no separate verification round
  warranted). Touches no lifecycle/security/data path.
- **Still open / handoff:** none. Scope of change is one CSS rule; the seg markup
  and its ARIA were already correct. (Note: this shared working tree also carries
  round-1's uncommitted `drawer.js`/`global-settings.ts`/etc. — this lane touched
  ONLY `public/styles.css`.)
- **Symptom of a deeper design flaw?** Minor-yes: a "selected" state whose fill
  equals its container is invisible by construction, and the seg control reused
  `--sunken` while the sibling toggles used `--solid` — two idioms for one
  meaning. Now unified on `--solid`. Not filing an ARCH; the fix collapses the
  divergence rather than deferring it.

### 2026-09-08 21:59Z — fixing lane (round 3, class=fix)
- **Understood:** an independent clean-room verification returned BROKEN —
  `Verified-by: dispatch openai run 01a07dd4-1c25-7e80-819f-c3d46c75bcf8
  (clean-room, scripts/independent-verify.mjs) — VERDICT: BROKEN`. Fix the three
  defects it found, class not instance. Did NOT re-run the verify (I am the fixer).
- **Defect 1 (high) — model + effort were DEAD TOGGLES at project creation
  → FIXED, STRUCTURALLY.** Round 1 wired the four NEW machine defaults
  (isolation + 3 tools) into the creation path but left the two ORIGINAL fields
  (`model`, `effort`) unwired, so `createProject` stored `{model:null,effort:null}`
  despite a machine default of haiku/low — the exact dead-toggle the charter
  forbade. Root cause: creation read the global layer in three ad-hoc places
  (`resolveNewProjectIsolation`, `resolveNewProjectToolSettings`, and — missing —
  model/effort in `createProject`), so a field with no reader silently failed.
  Fix per ARCH-010: the OWNER of `GlobalDefaults` (global-settings.ts) now
  declares `SEED_CHANNEL` — `{model,effort}→'projectSettings'`,
  `isolation→'isolation'`, `{openaiDispatch,serena,playwright}→'toolSettings'` —
  as `… satisfies Record<keyof GlobalDefaults, SeedChannel>`, and `createProject`
  iterates the derived `PROJECT_SETTINGS_SEED_KEYS` to seed model/effort. Adding a
  field to `GlobalDefaults` without a channel is now a COMPILE ERROR (proven
  non-vacuously: a temp 7th field reddened tsc at the `satisfies` line, then
  reverted), so the next added default cannot be forgotten the same way. This is a
  STRUCTURAL fix, not per-field. Reconciliation with FEAT-118's live-inherit: a
  NULL machine default leaves the row null (still inherits a later machine change
  via `applyGlobalDefaults`); a NON-null default freezes onto the row so its
  stored config reflects the machine default (req 3). An explicit request value —
  including explicit null — still wins (req 4).
- **Defect 2 (uncertain) — DIAGNOSED as a STALE FIXTURE, updated.**
  `verify-feat-118-global-defaults.mts` FAILed 2 cases ("no settings file",
  "corrupt settings") because they pinned the OLD 2-key JSON string
  `{"model":null,"effort":null}` while FEAT-139 widened `readGlobalDefaults()` to
  6 keys — the observed output was sane (every field null, no throw). NOT a product
  bug. Fixed by asserting the shape-AGNOSTIC invariant (every live key resolves
  null, nothing thrown) so future field growth never re-reddens it. 14/14 now.
- **Defect 3 (coverage gap) — closed with real coverage.** New
  `verify-feat-139-http.mjs` boots an isolated scratch server (free port,
  isolatedServerEnv) and drives the ACTUAL routes: unknown-field
  PATCH /api/settings → HTTP 400 with NO partial write (req 2); PATCH machine
  defaults then POST /api/projects (no settings) → persisted registry row
  reflects model/effort/isolation (Defect 1 over HTTP, re-read from the registry
  route not the POST echo); explicit model=opus over HTTP beats the machine default
  (req 4, non-vacuous). `verify-feat-139-scopes.mts` covers module-level: seeding,
  req-4 (incl. explicit-null), live-inherit preservation, precedence (project beats
  machine via applyGlobalDefaults; session beats project — synthetic session layer,
  the production merge is inline at agent-bridge.ts ~L1074-1082 and not exported),
  and isolation degradation (req 6: resolveNewProjectIsolation never throws, yields
  a valid tier, records a reason on fallback). **Requirement 4 re-proven
  non-vacuously** — the default now lands, so the explicit override genuinely
  clobbers something.
- **Requirement 7 (theme) — REAL GAP, NOT in this lane's editable set.** There is
  NO server-side theme record: `rg 'theme' src/server/` is empty and
  GET /api/settings has no `theme` key (the HTTP suite's theme check reports WARN,
  not a hard fail). Round 1 kept theme localStorage-only, which requirement 7
  ("a client-side cache is acceptable, but must not be the only record") forbids.
  I could not fix it: theme surfacing lives in `src/server/index.ts` + the drawer/
  app client, which a concurrent lane (`cs-mtr8j0jq-3`) held FEAT-129-locked all
  round. Handoff: route theme server-persistence to that lane or a follow-up.
- **Must-FAIL proof:** before the registry.ts change (SEED_CHANNEL present but
  unread) `verify-feat-139-scopes.mts` was 12/16 with D1 model/effort + changed-
  default + R4-effort-inherit RED; `verify-feat-118` was 12/14 with the two stale
  asserts RED. After: 16/16, 14/14, and 8/8 on the HTTP suite. Baselines are the
  real pre-fix module state, not a moving ref.
- **Changed (unstaged), THIS round only:**
  - `src/server/global-settings.ts` — added `SeedChannel`, `SEED_CHANNEL`
    (`satisfies Record<keyof GlobalDefaults, SeedChannel>`), `ProjectSettingsSeedKey`,
    `PROJECT_SETTINGS_SEED_KEYS`.
  - `src/server/registry.ts` — `createProject` seeds the 'projectSettings'-channel
    machine defaults via `seedProjectSetting` + `PROJECT_SETTINGS_SEED_KEYS`;
    widened the global-settings import.
  - `scripts/verify-feat-118-global-defaults.mts` — the two stale 2-key asserts →
    shape-agnostic `allDefaultsNull` invariant.
  - `scripts/verify-feat-139-scopes.mts` (new), `scripts/verify-feat-139-http.mjs`
    (new).
- **Gate:** `npm run gate` → PASS (exit 0), unpiped, read directly — leak-gate,
  check-nul, typecheck all clean. (One caught-and-fixed slip: the seed helper's
  cast needed `as unknown as Record<…>`; the gate reddened, I fixed it, re-ran
  green — did not commit on the piped exit.)
- **Bucket / Verified-by:** touches the project CREATION path (stateful,
  regression-prone), so PENDING an independent clean-room re-verify — warranted,
  flagged for the orchestrator to dispatch a fresh openai clean-room round.
- **Symptom of a deeper design flaw?** Yes, and it is the SAME shape ARCH-010
  names: creation read the machine layer in three places and the field with no
  reader died silently. The durable fix is the single owner-declared
  `SEED_CHANNEL` that the creation path reads — future machine defaults slot into
  a channel or fail to compile, rather than each being remembered (or forgotten)
  one call site at a time.

### 2026-09-08 22:34Z — fixing lane (round 4, class=fix)
- **Understood:** a second clean-room verification returned BROKEN on exactly ONE
  thing — theme. `Verified-by: dispatch openai run
  01a07de3-8fda-7ff0-ae9b-a55d131b6a58 (clean-room, scripts/independent-verify.mjs)
  — VERDICT: BROKEN` (artifacts `/tmp/feat139-verdict-r2.txt`, run log under
  the orchestrator task dir, session 1db6c752, task b9rps9tsz.output).
  Its finding: `public/app.js` wrote ONLY localStorage; with the cache removed,
  appearance reset to system (`non-cache writes: []`) — there was NO server-side
  theme record at all, violating requirement 7 ("a client cache is acceptable but
  not the only record"). Round 3's dead-toggle structural fix HELD (the verifier
  re-tested it: machine model/effort/isolation seed new projects, 16/16) — not
  disturbed. Also closed the two "could-not-test" gaps r2 named.
- **Task 1 — theme is now a REAL persisted machine setting, THROUGH the seed map.**
  - `src/server/global-settings.ts`: added `Theme = 'system'|'light'|'dark'` and
    `theme: Theme` to `GlobalDefaults` (default `'system'`, the ONLY non-null field
    — 'system' IS its built-in "no preference", so a corrupt/absent settings.json
    resolves theme to 'system', never themeless). It goes THROUGH the round-3
    owner-declared map: a new `SeedChannel` value `'machineOnly'` was added and
    `theme: 'machineOnly'` declared in `SEED_CHANNEL` (still
    `satisfies Record<keyof GlobalDefaults, SeedChannel>`), i.e. an EXPLICIT,
    owner-declared "does not seed a project" — not a work-around of the map. Theme
    is whole-app appearance, not project config, so it must not copy onto a project
    row; `'machineOnly'` is consumed by no creation channel and `ProjectSettingsSeedKey`
    excludes it. `normalise`/`patchGlobalDefaults` handle theme with STRICT
    validation (unknown value → 400, same bar as an unknown field; explicit null →
    clear to 'system').
  - `src/server/index.ts` (`serveStatic`): for `index.html`, INJECT the persisted
    theme onto `<html data-theme="…">` when it is light/dark (system injects
    nothing = CSS default). This makes FIRST PAINT match the server even with a
    COLD localStorage cache — no flash of the wrong theme. (Lock note: this file +
    the frontend were FEAT-129 lock-held by `cs-mtr8j0jq-3` during round 3; this
    round the lock was NOT held on them at edit time, so the work that went undone
    in round 3 is now done.)
  - `public/app.js`: theme init prefers the server-injected `<html data-theme>`
    (authoritative, present cold), then the localStorage cache, then 'system'.
    `applyTheme` still writes the localStorage FAST cache + `<html>` but no longer
    the sole record; a post-first-paint reconcile reads `GET /api/settings` (source
    of truth) and repairs a stale cache; the Appearance control writes THROUGH via
    `api.patchSettings({theme})`. `ctx.setTheme` → the write-through path.
- **Task 2 — closed the three r2 could-not-test items.**
  - HTTP 400 (req 2) had no recorded result in r2 (the clean-room RECORDER failed,
    not the script). `scripts/verify-feat-139-http.mjs` boots an isolated scratch
    server and asserts unknown-field PATCH → 400 with no partial write; it ran
    green here (16/16), so it produces a result reliably. Added HARD theme
    assertions to it (was a WARN): server keeps a theme record, valid PATCH
    persists across a fresh GET, unknown theme → 400 with no write, and the served
    index.html injects `data-theme="dark"` (system injects nothing).
  - The R6 fallback assertion in `verify-feat-139-scopes.mts` was VACUOUS (r2
    observed `applied:'container', reason:null` — the branch never ran on a
    docker-having machine). Now FORCED: `CLAUDE_STATION_DOCKER` is pointed at a
    non-existent binary BEFORE registry.ts is imported (the const is captured at
    import), so `dockerAvailable()` returns not-ok and the fallback + its recorded
    reason ACTUALLY execute (wanted=container → applied=direct, reason non-null).
  - Req 5 (missing/corrupt settings.json) confirmed still covered by
    `verify-feat-118-global-defaults.mts` (runs, can fail). Its shape-agnostic
    invariant `allDefaultsNull` would have WRONGLY reddened once theme (non-null
    default) landed — a regression I introduced — so it is now `matchesDefaults`
    vs the owner-declared `GLOBAL_DEFAULTS` (regressed-from: this round's own
    change, caught and fixed in-lane). Added theme cases: garbage theme → 'system',
    valid theme round-trips, invalid theme rejected.
- **Must-FAIL proofs (real output, then reverted):**
  - Theme persistence + injection: temporarily forced `normalise` to always
    return theme='system' (pre-fix "never persisted" state) → scopes 20/21 (THEME
    persist RED), http 13/16 (theme-survives, rejected-wrote-nothing, index
    injection RED), feat-118 16/18 (theme persist RED). Reverted → all green.
  - R6 non-vacuity: temporarily dropped the audit reason on fallback
    (`reason: null`) → scopes 20/21 with "R6 records WHY" RED; the fallback-branch
    assertion still passed (applied=direct), proving the reason check is what the
    reason mutation breaks. Reverted → 21/21.
- **Verified (this fixer run):** `verify-feat-139-scopes.mts` 21/21,
  `verify-feat-139-http.mjs` 16/16, `verify-feat-118-global-defaults.mts` 18/18.
  Headless Playwright MCP (real app, isolated scratch server, ephemeral port
  34805, cold data dir): set Dark via the panel → `<html data-theme=dark>` +
  localStorage=dark + `GET /api/settings`.theme=dark (write-through, server is
  source of truth); the RAW served index.html is `<html lang="en" data-theme="dark">`
  (first paint dark before any script — no light flash); cleared localStorage,
  reloaded → first-paint `data-theme=dark`, cache re-seeded from injection, server
  still dark, surfaces dark (--window #131513, body rgb(7,8,7)). Screenshots
  `docs/bugs/assets/FEAT-139-theme-dark-set-via-panel.png` and
  `docs/bugs/assets/FEAT-139-theme-dark-survives-cache-clear-reload.png` (the
  latter rasterised genuinely dark — no shared-browser light-composite artifact
  this round).
- **Gate:** `npm run gate` → PASS (exit 0, unpiped, read directly) — leak-gate,
  check-nul, typecheck all clean.
- **Changed (unstaged), THIS round only:** `src/server/global-settings.ts`,
  `src/server/index.ts`, `public/app.js`, `scripts/verify-feat-139-scopes.mts`,
  `scripts/verify-feat-139-http.mjs`, `scripts/verify-feat-118-global-defaults.mts`,
  and the two screenshots under `docs/bugs/assets/`.
- **Bucket / Verified-by:** theme adds a server-persisted setting + a first-paint
  injection on the static-serve path and a client reconcile — data-path + a route
  behaviour change, PENDING an independent clean-room re-verify (warranted; flag
  for the orchestrator to dispatch a fresh openai clean-room round on the theme
  round-trip incl. cold-cache first paint).
- **Symptom of a deeper design flaw?** Same ARCH-010 shape, now closed for theme:
  requirement 7 said "not the ONLY record" and round 1 kept the record in exactly
  one place (localStorage) with no owner. The fix gives theme an owner (the global
  settings file) that the client READS rather than being the authority itself, and
  a seed channel (`machineOnly`) that declares — at the owner — that it does not
  seed a project. A blocker to note: the FEAT-129 advisory lock held by lane
  `cs-mtr8j0jq-3` intermittently refused Bash calls during teardown this round; the
  scratch server (pid 2658852, isolated ephemeral port + data dir) and the tmp
  launcher `scripts/tmp-feat139-boot.mjs` may still need cleanup if the kill/rm did
  not land — see handoff.

### 2026-09-08 (later) — finding lane (round 5, class=explore)
- **User re-reported after reload: "still same, not highlighted current option."**
  Investigated the USER'S LIVE SERVER (port 4317), not a scratch instance.
- **HEADLINE — this is DEPLOY LAG, not a code defect. The user must RESTART the
  live server to see the already-correct fix.** The on-disk code (rounds 1-4) is
  correct and complete; the running server predates it.
- **Reproduced on live 4317 (headless Playwright MCP):** opened Machine scope.
  Appearance seg → "System" pressed, highlighted (bg rgb(27,31,29)/white). BUT the
  Isolation (Built-in/Container/Sandbox/Direct) and the three On/Off segs (OpenAI
  dispatch / Serena / Playwright) had **NO button aria-pressed=true at all** →
  nothing highlighted. YES, reproduces.
- **Single root cause — STALE LIVE SERVER.** `GET /api/settings` on 4317 returns
  the OLD 2-key shape `{model, effort}` only — no isolation/openaiDispatch/serena/
  playwright/theme. The live server (pid 2794244) started **Sep 7 04:09:53**,
  before any FEAT-139 server code; it holds the pre-FEAT-139 `global-settings.ts`
  in memory. The frontend IS current (served fresh from disk, `cache-control:
  no-store` on all static — line 230 index.ts; verified the served /styles.css
  contains round-2's `.seg button[aria-pressed="true"]{background:var(--solid)…}`
  rule, and `--solid`/`--on-solid` are defined in both themes). New drawer.js
  reads `g.isolation`/`g.serena`/… → `undefined` from the stale API; `globalSeg`
  presses "Built-in" only when `current === null` (drawer.js:2796), and
  `undefined === null` is false → nothing pressed → nothing to highlight.
  Appearance escapes because it has a client fallback `ctx.getTheme() ?? 'system'`
  (drawer.js:2812), so System always presses — which is exactly the asymmetry the
  user saw.
- **Ruled out:** CSS reverted (it's on disk, line 1616, and served); browser cache
  (no-store); selector mismatch (DOM IS `.seg > button[aria-pressed]`); vars
  undefined (defined both themes); round-4 data-theme injection (unrelated — theme
  seg works). Every non-stale hypothesis eliminated with numbers.
- **Fix PROVEN on CURRENT code (scratch server, free port 36701, cold isolated
  data dir = the user's real never-set state, all-null defaults):** `GET
  /api/settings` returns the full 7-key shape `{model,effort,isolation,
  openaiDispatch,serena,playwright:null, theme:'system'}`; ALL tri-state controls
  correctly press "Built-in" (aria-pressed=true, bg rgb(27,31,29)/white) — Machine
  Isolation, OpenAI dispatch, Serena, Playwright, plus Appearance→System. So the
  on-disk code is correct; the user sees a stale binary. Screenshot in Playwright
  output dir: `feat139-r5-current-code-machine-highlighted.png`. No code change
  made or needed — changing globalSeg to also press Built-in on `undefined` would
  paper over a real frontend/backend version skew; the correct remedy is deploy.
- **Item 5 — how round 2 got a false green:** round 2 tested a FRESH scratch
  server (current code) AND seeded NON-NULL machine defaults
  {isolation:sandbox, openaiDispatch:true, serena:false, playwright:false}, so a
  CONCRETE button was always pressed and highlighted. It never tested (a) the
  user's actual live 4317 server, nor (b) the null / "Built-in" default state that
  a user who has never touched machine defaults actually has. Round 2's "19/19
  carry aria-pressed" counted buttons that HAVE the attribute (value true OR
  false), not that the CURRENT one is true. The gap: realistic-state (all-null
  defaults) + the real deployed server were both unmodelled.
- **What the user must do:** restart the live server (systemd `--user` deploy) so
  it loads the current `global-settings.ts`. I did NOT restart 4317 (the user is
  using it; a restart interrupts their live session). Flagging for the
  orchestrator/user to deploy.
- **Process note:** pid 2658852 / port 34805 (round-4 scratch) confirmed DEAD;
  port 34805 free. My own scratch server (pid 2715254, port 36701) killed by pid;
  all scratch ports free; 4317 untouched. No git writes; no files changed.

### 2026-09-18 19:59Z — fixing lane (round 6, class=fix) — strip + rail declutter (folds in FEAT-114)
- **Charter:** restructure the session header strip and the board side rail so a
  control you click to CHANGE something and a number you can only READ do not look
  the same. Three zones — Navigate / Live-readout / Config(one door) — plus the
  permission MODE pill kept as its own language. Folds FEAT-114 (strip overflow)
  into this ticket. User complaint: "some are status labels, some are settings and
  then we also have settings, all visually same … board/guide can be buttons."
- **Hypothesis check (done FIRST, against the real markup — REFINED, not
  refuted):** the charter's hypothesis was "the strip renders settings-controls,
  navigation and read-only status with IDENTICAL chip/pill styling." Partly true.
  FEAT-114 had ALREADY differentiated the readouts (`.readout`, transparent) and
  the perm chip (`.perm`, borderless) from the pills. The genuinely-undifferentiated
  pair was NAV (Board/Guide, `.pill.board-pill`) vs CONFIG (Provider/Isolation/
  Instructions/Settings, all plain `.pill`) — nav and config wore ONE bordered-pill
  look, and the config chips were on the strip at all. So the clutter is (a) config
  chips present on the strip that belong in Settings, and (b) nav==config visual
  weight. The three-zone design is the correct fix for exactly that; I proceeded and
  report the refinement rather than build on the literal (wrong) claim.
- **Changed (unstaged), THIS round:**
  - `public/app.js` — `paintCrown` no longer paints the provider/isolation/
    instruction chips onto the strip (they move under the one Settings door);
    `paintProvSel` keeps `#provSel` hidden; removed now-dead `ISO_META` and
    `PROC_PORT_CAP` consts. Proc readout FACE compacted from the port-dump
    (":4317 :34699 … · 90 procs") to a single "N ports"/"N procs" count — the full
    port list stays ONLY in the existing `#procPop` popover (BUG-082 invariant taken
    to its end). Side rail: `reconcileNeeds` now renders at most `NEEDS_RAIL_CAP`(3)
    interactive needs cards + a one-click "+N more need you → board" count row
    (`railMoreRow`), preserving the in-place focused-textarea reconcile for the
    shown set; the Queued section renders a single "N queued → board" count instead
    of the full ~86-row list. No data or route removed — everything is one click
    away on the board (`navTickets`).
  - `public/styles.css` — three distinguishable zone treatments: `.board-pill` nav
    = opaque bg + weight 500 + hover FILL (highest affordance); `.seal .readout` =
    chromeless, ink-4 muted (a step quieter); `.seal .perm` = a fully-rounded
    (999px) MODE PILL with a soft filled ground + live dot, its own language.
    `.seal-break` repurposed from a full-width tier break to a flexible spacer that
    right-aligns the readout cluster and still shrinks-to-wrap (keeps FEAT-114's
    no-clip). New rule `#seal #provSel,#isoBtn,#insBtn { display:none }` — REQUIRED,
    because `.pill{display:inline-flex}` overrides the plain `[hidden]` attribute
    (no `.pill[hidden]` reset exists), so a JS `.hidden=true` alone left them
    visible (caught live in the browser proof). Plus `.rail-more` styling.
  - `scripts/verify-bug-082-proc-chip.mjs`, `scripts/verify-bug-075-mount-chip.mjs`
    — updated the strip-FACE assertions to the new design (proc face is a count,
    not a port list; isolation/instruction chips are OFF the strip), KEEPING every
    still-valid invariant (procPop lists all ports in :4317-first order + station
    tag + toggle; mounts still container-gated + functional). Both green: 13/13, 9/9.
- **Proof (headless Playwright MCP, real browser, isolated scratch server on an
  ephemeral port, the REAL Orchard repo registered as the project → real git chip
  + a REALISTIC BUSY board: 19 needs-you, 86 queued, 5 in-flight):**
  - Three zones carry distinguishably different COMPUTED styles (nav opaque bg +
    weight 500; readout transparent bg+border, ink-4; mode pill bg-distinct-from-nav
    + 999px radius) — asserted true in BOTH light and dark.
  - Removed items ABSENT from the strip: `#provSel`/`#isoBtn`/`#insBtn` all
    computed display:none / offsetParent null. Reachable from Settings: opening the
    drawer (project scope, `#dScope` spine present) surfaces provider + isolation +
    instructions controls (one click).
  - Mode pill present + distinct ("skips prompts"), kept as the one strip-resident
    posture control.
  - No horizontal overflow: `#seal` scrollWidth == clientWidth (clips:false) at
    1400px AND 1100px (FEAT-114's original symptom).
  - Rail: exactly 3 needs cards + "16 more need you → board"; Queued = a single
    "86 queued → board" row (0 inline rows).
  - **MUST-FAIL (fixed baseline = git HEAD public/, served by a second scratch
    server built with the CURRENT src + HEAD public):** the SAME assertions FAIL —
    `#provSel`(◆Anthropic)/`#isoBtn`(▣Container)/`#insBtn`(▤Working Agreement v4)
    all VISIBLE; proc face = ":4317 :34699 :43767 +2 · 46 procs"; rail = 19 uncapped
    needs cards + 86 queued rows, no count rows. Baseline is a fixed revision, not a
    moving ref.
  - Screenshots (viewport, real render): `docs/bugs/assets/FEAT-139-strip-rail-light.png`,
    `FEAT-139-strip-rail-dark.png`, and the before/HEAD state
    `FEAT-139-strip-rail-before.png`. Visual review: both themes read as three
    clean groups; dark renders correctly (nav-button dark bg — the one white
    `getComputedStyle` was the documented same-turn custom-property stale-read, the
    pixels are correct).
- **Deliberate scope decisions (flagged for the orchestrator):**
  - The container "+ Add mount" / mount pills were LEFT on the strip (not in the
    charter's named remove-list; container-only, rare; has its own workflow +
    BUG-075 tests + inline remove). They are the one remaining config affordance on
    the strip; relocating them into Settings ▸ Mounts is a clean follow-up if wanted.
  - The Claude account selector (`#acctSel`, FEAT-145) is inserted after the now-
    hidden `#provSel`; it only appears with >1 account, so it is out of view in the
    common case. Not touched this round.
- **Anti-regression:** `npm run gate` → PASS (exit 0, unpiped, read directly:
  leak-gate, check-nul, typecheck). `verify-bug-082-proc-chip` 13/13,
  `verify-bug-075-mount-chip` 9/9, `verify-bug-106-crossproject-strip` (checks
  `#seal .perm` text — unaffected). `verify-bug-106` currently FAILS at fixture
  setup ("both project headers" timeout) — I proved it fails IDENTICALLY against
  HEAD's public/ (ran the same test pointed at git-HEAD public), so it is a
  pre-existing shared-tree/other-lane condition, NOT this change; flagged, not hidden.
- **Bucket / Verified-by:** contained render, zero adversarial rounds → the proof
  above IS the deliverable (WA §N). No lifecycle/security/data path touched. An
  independent clean-room pass is NOT warranted for this UI-only slice.
- **Still open / handoff:** none blocking. Orchestrator owns INDEX.md + status; I
  did not run `board:gen` (it rewrites INDEX). All scratch servers killed by pid;
  ephemeral ports free; 4317 (user session) untouched; no git writes.
- **Symptom of a deeper design flaw?** Same shape as the ticket's own thesis: a
  strip that grew a chip per feature with no zone discipline, so a readout, a nav
  link and a settings control all became "a pill". The durable fix is the zone rule
  now expressed in code (Navigate / Live-readout / Config-one-door / Mode-pill) and
  the ARCH-010-style single Settings door FEAT-139 already established — a new chip
  now has to declare which zone it is. Not filing an ARCH; the invariant is in code.

---

### 2026-09-18 — Independent design-critic review (verify lane, round 1)

Reviewed the RENDERED result on the live instance (localhost:4317, busy Orchard
project, 134 dirty, 19 needs-you), not the diff or the builder's report. Widths
1100 / 1400 / 1680 in light; dark judged from the on-disk dark reference plus
computed CSS-variable contrast. Screenshots (repo root): feat139-live-1400-orchard.png,
feat139-live-1100-orchard.png, feat139-live-1680-orchard.png, feat139-live-1680-after-polish.png.

Verdict: SHIPS, with one polish applied. The felt-clutter goal is genuinely
met — the config chips (provider / isolation / instruction stack) leaving the
strip for the single Settings door is the big win, and the nav-vs-readout
hierarchy is legible at a glance.

Measured zone treatment (light, 1400, real state):
- Nav (Board/Guide/Settings): white fill #FFF, 1px #E3E5E1 border, radius 6px,
  text --ink #1B1F1D, weight 500. Clearly the "buttons".
- Readouts (git/ports/usage): transparent bg, transparent border, flat text
  --ink-4 #696E6B (~5.2:1 on white) weight 400. A full tone quieter and no
  chrome — the eye separates "press" from "read". Zone distinction ACHIEVED.
- usage warn = #B0703C (81% wk). Draws the eye (not invisible) — intent #2 met.
- Mode pill .perm "asks first": radius 999px, border #E3E5E1, FILLED bg
  --sunken #F1F2EF, text --ink-2 #535755, plus a status dot. Distinct from the
  transparent tool chips (--ink-3 #60655E) — but only by a subtle ~5% fill + the
  dot, same pill shape, and it sits glued to the tool run (6px gap) at wide.

Dark: readout --ink-4 #858683 on --window #131513 ≈ 5.07:1 (AA pass; matches the
"raised to clear AA" comment). Nav #E6E9E5 ≈ 15:1. Muted zone SURVIVES dark.

Defects found (ranked, none blocking):
1. (medium) Mode pill reads as "the filled chip at the end", not emphatically a
   flippable live mode. Distinction rests entirely on a subtle sunken fill + dot;
   it is not spatially set apart from the tool chips. Intent #3 only partially
   achieved. Author's call whether to strengthen (e.g. a hair of separation or a
   faint tint) — left untouched as a deliberate-token judgment.
2. (medium-low) Intermediate width (~1100) fractures the readout zone: the
   flexible .seal-break spacer collapses just enough that git clings to the nav
   row while ports+usage wrap down and interleave with the bordered tool chips,
   and the mode pill orphans to a 3rd row. The flat-vs-bordered treatment keeps
   it readable, but "one muted status cluster" doesn't hold, and 3 wrapping rows
   slightly undercut the reduce-clutter goal. Fixing properly needs a wrapper
   (markup) or breakpoint — out of CSS-only polish scope; flagged for author.
3. (low) Light usage-warn #B0703C ≈ 3.2:1 on white — under AA 4.5 for 11px text
   (dark is fine ~5.9:1). It's a warn accent so noticeable, but the lightest
   readable link in the chain. Left to author since --warn is a tuned token.

Polish APPLIED (public/styles.css only): `.seal .sep:last-child { display:none }`.
#sealSep is shown whenever a project is selected and is the LAST strip element
(perm/integ insert before it), so it rendered as a 1px hairline dangling off the
end of the row with nothing after it. Now hidden when final; re-appears only if a
later state inserts content after it. Confirmed gone at 1680 (before/after shots).

Could not reproduce the "+16 more need you" rail string in the live busy state —
the rail caps via counts (19 NEEDS) + focus line + a couple expanded cards, not a
"+N more" line, so that specific concern doesn't manifest here. Minor: the FOCUS
line is a quiet single truncated row, not strongly prominent; and the "9 agents
stopped" digest (6 near-identical local_bash rows) is the tallest thing in the
rail — likely a separate feature's surface, noted for awareness.

### 2026-09-19 10:49Z — fixing lane (round 2 of the strip work, class=fix) — design-review defects 1 & 2

- **Charter:** close the two defects the 2026-09-18 independent design-critic
  raised against the round-6 header-strip restructure (defect 1 = mode pill not
  categorically distinct; defect 2 = readout zone fractures at ~1100px), plus the
  housekeeping move of four stray root screenshots. Defect 3 (light `--warn`
  token) is a deliberately tuned token — OUT of scope, not touched.
- **Hypothesis check FIRST (headless Playwright MCP, real app, before any edit):**
  booted an isolated scratch server (free port 39257, isolated
  CLAUDE_STATION_DATA + CLAUDE_CONFIG_DIR + CLAUDE_PROJECTS_DIR via
  scripts/lib/station-boot.mjs), drove the REAL served page, seeded a realistic
  busy single-project state through the documented `window.__station` hooks
  (git: main·134 dirty·+2200·−480·↑3; procs: 5 ports/90; usage: 81% wk·2d;
  Serena integ; perm "asks first"). Background poll timers cleared so the fixture
  isn't wiped mid-measure; seed+measure done atomically. BOTH defects reproduced
  exactly as described — NOT refuted, so I proceeded:
  - Defect 2 (zone fracture): a zone-mix metric over live `getBoundingClientRect`
    rows (badMix = readout items span >1 row AND ≥1 of those rows also holds a nav
    item). PRE-CHANGE light: 1400 (seal 923) one row, badMix=false; **1100 (seal
    666) badMix=TRUE** — Board/Guide/Settings + git/proc/usage share row 0 while
    integ+perm orphan to row 1; **1000 (seal 800) badMix=TRUE** — perm orphans
    alone to row 1. overflow=false throughout (FEAT-114 intact). Same in dark.
    Before screenshot: `FEAT-139-r2-before-1100-light.png` (nav+readouts jumbled,
    "◆ Serena / asks first" dangling on a 3rd row).
  - Defect 1 (mode pill): PRE-CHANGE both themes — perm was a 999px capsule,
    `margin-left:0`, glued to the tool chips at the 6px inter-chip gap
    (permGap=6), a flat dot (`box-shadow:none`), and NO caret (`hasCaret:false`).
    Distinction rested only on a ~5% sunken fill — the reviewer's exact finding.
- **Fix — defect 2 (width-independent wrapper, per charter's preferred option):**
  - `public/index.html` — wrapped `#gitBtn`/`#procBtn`/`#usageBtn`/`#integStrip`/
    `#sealSep` in a single `<span class="seal-readouts" id="sealReadouts">`. The
    flexible `.seal-break` spacer stays a direct child of `#seal` BEFORE the
    wrapper (wide right-alignment preserved). The perm pill inserts before
    `#sealSep` (paintPerm), so it now lands INSIDE the wrapper too.
  - `public/styles.css` — new `.seal-readouts { display:inline-flex;
    flex-wrap:wrap; align-items:center; column-gap:6px; row-gap:7px; min-width:0 }`
    so the cluster wraps as ONE unit below the nav (never fractures), and only its
    own contents wrap inside it (no horizontal overflow). `.seal .sep:last-child`
    still hides `#sealSep` — it is now last child of the wrapper, still matched.
  - `public/app.js` — the perm remove query at the seal-chip site changed from
    `node.seal.querySelector(':scope > .perm')` (direct-child) to
    `node.seal.querySelector('.perm')` (subtree), because perm moved into the
    wrapper. Mount insertion (`node.sealBreak.before(...)`) and the `.seal-vdiv`
    query are unaffected (both still direct children of `#seal`).
- **Fix — defect 1 (categorical mode pill), both themes:**
  - `public/app.js` (paintPerm) — the chip now also renders a caret
    (`svg('M4 6.5 8 10.5 12 6.5', 8, 'cx')`) in the `.sel` idiom, announcing "opens
    something to CHANGE the mode".
  - `public/styles.css` (`.seal .perm`) — `margin-left:8px` (clear separation from
    the tool chips, not glued at 6px); the dot is now an LED (solid core +
    `box-shadow: 0 0 0 2px color-mix(...)` halo ring, tint tracks the dot colour,
    incl. the `[data-risk="true"]` variant); `.cx` caret styled at ink-4/opacity
    .55 firming to .8 on hover. Kept QUIETER than the nav buttons: soft sunken
    ground + ink-2, no weight-500, no hover FILL (only a firmed border). Shape
    (999px) already distinguished it from the 6px nav buttons and the chromeless
    readouts; these add the "live + flippable" affordance the reviewer wanted.
- **Verified — must-FAIL then PASS, headless Playwright MCP, real served page,
  1000/1100/1400 × light+dark (same scratch server, reloaded to pick up edits):**
  - Defect 2: post-fix badMix=FALSE at ALL of 1000/1100/1400 in BOTH themes;
    readout items always share ONE row as each other, distinct from the nav row
    (1100/1000: nav on row 0, [git,proc,usage,integ,perm] together on row 1;
    1400: single right-aligned row). `hasWrapper`/`permInWrapper`=true. overflow
    (scrollWidth>clientWidth) = FALSE at 1000/1100/1400 both themes (no FEAT-114
    regression). The identical metric returned badMix=TRUE at 1100/1000 pre-change
    — non-vacuous.
  - Defect 1: post-fix both themes — `hasCaret`=true & caret visible, dot
    `box-shadow` is a 2px halo ring (light `…/0.35`, dark `…/0.35`), `margin-left`
    8px, permGap=14 (was 6). Same assertions failed pre-change (no caret, ring
    none, gap 6).
  - After screenshots (docs/bugs/assets/): `FEAT-139-r2-after-1100-light.png`,
    `FEAT-139-r2-after-1100-dark.png`, `FEAT-139-r2-after-1400-light.png`,
    `FEAT-139-r2-after-1400-dark.png`, and perm close-ups
    `FEAT-139-r2-perm-closeup-{light,dark}.png` (LED ring + caret legible in both).
- **Anti-regression:** `npm run gate` → PASS (exit 0, unpiped, read directly:
  leak-gate, check-nul, typecheck). `verify-bug-082-proc-chip` 13/13,
  `verify-bug-075-mount-chip` 9/9 (both exercise the strip and still green under
  the wrapper). `verify-bug-106-crossproject-strip` FAILS at fixture setup
  ("both project headers" timeout, line 181) — the SAME pre-existing shared-tree
  failure round 6 recorded and proved identical against HEAD; it aborts upstream
  of any `#seal`/perm code, so it is not this change. (No git writes permitted, so
  I did not re-diff against HEAD myself; cross-referenced round 6's proof.)
- **Housekeeping:** moved the four stray root screenshots (plain `mv`) to
  docs/bugs/assets/ as `FEAT-139-review-live-{1400,1100,1680}-orchard.png` and
  `FEAT-139-review-live-1680-after-polish.png`; also filed my own proof shots
  there. Two other feat139-prefixed root pngs (`feat139-live-1400-a.png`,
  `feat139-r5-current-code-machine-highlighted.png`) were NOT in the charter's
  named set and were left untouched.
- **Changed (unstaged), THIS lane only:** `public/index.html`, `public/styles.css`,
  `public/app.js` (product) + the moved/added screenshots under docs/bugs/assets/
  (that dir is gitignored). The other `public/lib/*.js` modifications in this
  shared tree are pre-existing, not mine.
- **Bucket / Verified-by:** contained render, zero adversarial rounds — the proof
  above IS the deliverable (WA §N). No lifecycle/security/data path touched. An
  independent clean-room pass is NOT warranted for this UI-only slice.
- **Limits / could-not-test:** the strip's available width is layout-constrained
  (seal ~666–923px inside the crown column even at 1000–1400 viewport, with a
  right rail present at wider viewports), so the fracture manifests at these
  seal widths rather than at the reviewer's raw viewport numbers; the invariant
  (no zone-mix, no overflow) is asserted at the real rendered widths. Fixture is
  synthetic busy-state driven through the sanctioned `window.__station` hooks on
  the REAL served page (no real multi-project live board available in an isolated
  scratch server); git/procs/usage/perm values seeded to a realistic busy day.
- **Still open / handoff:** none blocking. Orchestrator owns INDEX.md + status; I
  did not run board:gen. Scratch server killed by pid; ephemeral port freed; the
  user's 4317 and other live tabs untouched; no git writes.
