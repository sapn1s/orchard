# FEAT-146 — Settings is two navigation axes fighting each other

- **Status:** IN VERIFICATION — built and polished; the clean-room verdict HOLDS but is SAME-PROVIDER only, so a cross-provider re-run is still outstanding
- **Severity:** medium
- **Area:** drawer / settings
- **Reported:** 2026-09-18 by user
- **Verification-class:** plan+review ⟶ independent verification REQUIRED before VERIFIED.

## Symptom

User, verbatim: "can we improve settings, lets make it modal, like
anthropic/openai, or like valorant settings or any windows apps tbh, some
descriptions are long, add under tooltip, make easy cognitive layout tabs etc"

## Repro

Open Settings (`Ctrl/⌘ ,` or any of the 18 `drawer.open()` call sites in
`public/app.js`). It renders as a 388px right-hand drawer
(`public/index.html:399`, `public/lib/drawer.js`, 3518 lines) carrying two
orthogonal axes at once: a *scope* tab strip (machine/project/session,
`#dScope`, `index.html:413-418`) and a *content* axis of six views (`VIEWS`,
`drawer.js:3325-3335`). ~60 controls across 12 groups, ~85 prose strings
totalling ~2,050 words, in a fixed 388px column. Three separate controls carry
code comments about text wrapping one letter per line
(`drawer.js:3081-3085`, `:2875-2876`, `:1409-1414`) — direct evidence the
current layout is measurably too cramped for its own content.

## Expected

A modal settings surface (`.smodal`) where **content is the rail and scope is
a header lens plus a per-row provenance chip** — not two competing tab strips.

## Context pack (grows — the "where to look", so no agent cold-starts)

### Decided design (a full spec exists — this is not an open question)

- **Content becomes the rail; scope becomes a header lens plus a per-row
  provenance chip.** Scope is not a real axis in this data model: machine
  scope has *unique content* (appearance, accounts, new-project seeds,
  templates) that does not exist at project level; session scope is a strict
  lossy subset that today renders as a screen of dead disabled controls.
  Rejected alternatives, with their costs: scope-as-rail forces a tab bar that
  mutates identity as you move down the rail (the most disorienting shape in
  settings UI) and doubles the deep-link contract to `{scope, category, key}`;
  a flat list has nowhere to put the four sub-applications (instruction
  stack, template library+editor, snapshot list + restore ceremony, the OAuth
  login wizard).
- **11 rail categories in two groups.** *This project*: Model & spend,
  Permissions & tools, Instructions, Isolation & environment, Snapshots,
  Workspace, Advanced. *This machine*: Accounts, Appearance, New-project
  defaults, Templates. Ordered by reach frequency, not by how the code is
  organised today.
- **Modal shell** `.smodal`, copied from the existing `.tmodal` idiom
  (`index.html:589`, `styles.css:4577`) — explicitly NOT abstracted into a
  shared base. `min(940px,94vw) × min(680px,88vh)`, fixed height, 224px fixed
  rail, no category-switch transition.
- **Four-column row grid** — label / provenance chip / value / a
  permanently-reserved 46px affordance gutter — so nothing reflows when state
  changes.
- **Provenance chip is the one loud element**: hollow = inherited from a
  level above, filled (`--solid`/`--on-solid`) = set at the current write
  target, absent = built-in. Luminance, never hue — the same idiom FEAT-139
  chose for `.seg[aria-pressed]`.
- **Inline disclosure, not hover tooltips.** An `ⓘ` toggle expands a
  `.set-why` block in flow, with `aria-expanded`/`aria-controls`/
  `aria-describedby`. Hover tooltips are rejected outright: invisible to
  touch, awkward by keyboard, and needing collision logic inside a scrolling
  modal pane. A `Show all descriptions` footer toggle persists in
  localStorage. **The codebase has no tooltip component today — every
  tooltip is a native `title=`.**
- **The hidden-vs-inline rule, the safety-critical part of this ticket.**
  Mechanical test: *if removing the sentence could cause the user to take an
  irreversible, costly, or security-widening action they would otherwise not
  take, it stays inline.* Of ~85 prose strings, **38 are load-bearing** and
  may never go behind a toggle: destruction/overwrite of user data (snapshot
  restore, account delete, memory delete, repoint, process kill), security
  widening (`bypassPermissions`, Docker socket, sandbox→direct), statements
  of what a control does *not* protect, live-state honesty notes, and
  cost/billing consequence. These render with **no `ⓘ` at all** — the icon's
  absence is itself the signal.
- **Accessibility is in scope, not a follow-up**: hand-rolled focus trap
  (not `<dialog>`/`showModal()`, because the app owns its own Esc ladder and
  z-index order at `app.js:11999`), `inert` on `#app`, focus restore,
  roving-tabindex rail that is deliberately NOT `role="tablist"` (a tablist
  forbids the two group headings), `aria-live` on login status, real
  `aria-label`s on quota meters and cycle rows.
- **Deep links must survive**: all 14 `data-focus` and 6 `data-sect` keys keep
  working via a `FOCUS_CATEGORY` map; `applyFocus()`'s internals (the
  `FLASH_MS` one-shot, repaint-survival re-flash, the `ephemeralOpen` guard)
  are explicitly not to be touched. The exported drawer API stays identical
  so none of the 18 `drawer.open()` call sites in `app.js` move.
- **Explicitly NOT to change**: the data layer (`base()`/`val()`/
  `overriddenNow()`/`put()`/`saveGlobal()`/`ensureGlobals()` and the
  machine→project→session resolution — this is a rendering change only),
  every destructive ceremony, `.grp`/`.grp-l`/`.grp-note`, `.prov-state`,
  `createSlidePanel` (still used by `git-view.js`), and `Ctrl/⌘ ,`.

### Also fixes, as part of the work

A real gap: there is **no project-scope Claude-account control**, yet the
account popover's locked message literally says *"Change it in this
project's settings"* (`app.js:11076`). The server supports
`settings.claudeAccount` at project scope
(`global-settings.ts:164, 236-246`), and container projects are
project-scope-only by design (see FEAT-145's account-dir overlay section in
`docs/CONVENTIONS.md`), so a container project currently has **no reachable
way to set its account at all**.

### Known rough edges the redesign should absorb (checklist)

- Machine scope on the Instructions view is a mislabelled no-op
  (`VIEWS.instructions.scope=true` but `instructionsView()` never branches on
  it).
- `#dScope` uses `aria-pressed` on `role="tab"` with no `aria-controls`, no
  roving tabindex, no arrow keys.
- `.rev` is `role="button" tabindex="0"` with a click handler and no
  keydown, so revert is keyboard-dead.
- Four different idioms for "inherit".
- `data-focus="iso"` and `data-sect="iso"` collide so the section anchor is
  unreachable.
- Eight groups have no `data-focus` anchor so future deep links silently
  no-op.
- `vGlobals` is a dead view kept only for stale links.
- `.trow .grip` renders a drag handle that is not draggable.

### Files/functions in play

- `public/index.html:399` (drawer markup), `:413-418` (`#dScope`), `:589`
  (`.tmodal` idiom to copy)
- `public/lib/drawer.js` (3518 lines) — `VIEWS` (`:3325-3335`), the three
  cramped-text comments (`:3081-3085`, `:2875-2876`, `:1409-1414`),
  `applyFocus()` and its `FLASH_MS`/`ephemeralOpen` internals
- `public/styles.css:4577` (`.tmodal`)
- `public/app.js:11999` (Esc ladder / z-index order), `:11076` (account
  popover locked message), 18 `drawer.open()` call sites
- `src/server/global-settings.ts:164, 236-246` (`settings.claudeAccount` at
  project scope)

### Related tickets

FEAT-139 (the `.seg[aria-pressed]` luminance idiom this reuses), FEAT-145
(the account-dir overlay invariant; the project-scope account gap this
ticket also fixes).

### Repro test

None yet — new suite required (real-browser, both themes, keyboard-only
traversal; see Proof bar).

### Known dependencies / blockers

None.

## Proof bar

- An anti-regression assertion that every control in the pre-redesign
  inventory still exists and still writes the same key.
- Every `data-focus`/`data-sect` anchor still resolves.
- A real-browser pass in **both** themes.
- Keyboard-only traversal of the whole modal including the OAuth wizard.
- An explicit check that no load-bearing string (of the 38 identified) ended
  up behind an `ⓘ`.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-18 — filed from user request
- **Understood:** user asked for a modal settings redesign with tabs/cognitive
  layout and long descriptions moved under a disclosure affordance. Turned
  into a full design (rail-as-content, scope-as-lens, inline-disclosure with
  a hard safety carve-out for load-bearing prose) rather than left as an open
  question, because the trade-offs (scope-as-rail's identity-mutation problem,
  hover tooltips' touch/keyboard/collision problems) were resolvable from the
  existing codebase without a human decision.
- **Changed:** filed this ticket only. No code written.
- **Verified:** not applicable — filing only.
- **Still open / handoff:** un-owned. Fixer should start from the rail
  category list and the four-column row grid, build `.smodal` alongside
  (not replacing) `.tmodal`, then migrate views one rail category at a time
  behind the unchanged `drawer.open()` API so deep links never break mid-
  migration.
- **Symptom of a deeper design flaw?** not closing this ticket, so not
  answered yet.

### 2026-09-19 — PHASE 1 built: the modal shell and its navigation
_Dispatch: ticket=FEAT-146 phase=fixing round=1 class=fix. Phase 1 of 2 — the
shell only. Phase 2 re-homes content into the categories and rebuilds row
anatomy (the four-column grid, the provenance chip, the `ⓘ` disclosure)._

- **Understood:** build `.smodal` (rail = content, header lens = scope), its
  navigation, accessibility and deep-link mapping, and render the EXISTING view
  builders unchanged inside the new pane. Explicitly not phase 1: row restyling,
  the `ⓘ` disclosure, moving any control between categories.
- **Changed** (all unstaged):
  - `public/index.html` — the 388px `.drawer` is gone; `.smodal` is a SIBLING of
    `#win` (so the focus trap can `inert` the app), with header / `<nav>` rail /
    `<section>` pane / footer. `#vGlobals` retired. `#vEditor` moved INSIDE the
    pane so the template editor stays a pane-level takeover.
  - `public/lib/drawer.js` — `RAIL` (11 categories, 2 groups), `FOCUS_CATEGORY`
    (29 keys → category), `selectCat`/`buildRail`/`markRail`/`paintRailDots`,
    the modal open/close + hand-rolled focus trap, the close guard
    (`armedNode`/`disarmOne`/`escape`/`backdropClose`), `paint()` split into
    pane + `paintChrome()`, `d.paneScroll`, `liveStateText()` pinned to the
    footer. `createSlidePanel` is no longer imported here (git-view.js keeps it).
  - `public/styles.css` — `.smodal*` copied from the `.tmodal` idiom (NOT
    abstracted), `.srail`, `.spane`, `.sfoot`, `.slens`; `.drawer`/`.d-body`/
    `.d-scope` rules and the old narrow-drawer `@media` retired; `.view.on`
    animation removed; `<860px` horizontal snap strip, `<560px` full-bleed sheet.
    BUG-183's token repairs were re-read from disk and left untouched.
  - `public/app.js` — Esc-ladder branch only: settings moved up to just after
    `tvSheetOpen()`, and the old bottom-of-ladder `drawer.close()` removed.
    `drawer.close()` is now the guarded close, so the exported API shape is
    IDENTICAL (10 keys, all functions) and no `drawer.open()` call site moved.
  - `scripts/verify-feat-146-settings-shell.mjs` — new, 114 assertions.
  - Sibling suites updated for the rename only: `verify-feat-101-slide-panels`
    (the drawer row REMOVED — it is no longer a slide panel, so measuring slide
    motion on it would be measuring nothing), `verify-bug-154-socket-consent`,
    and 4 `scripts/qa/*.spec.ts` `#drawer`-open selectors → `#smodal` hidden.
- **Navigation defects also fixed** (all were in the charter's scope):
  - `data-focus="iso"` / `data-sect="iso"` collided, so the SECTION anchor was
    unreachable. The section id is `isoSection` now; `iso` still resolves (to
    the group) and both anchors are distinct, reachable nodes.
  - Eight groups had no anchor, so any future deep link at them would silently
    no-op. Added: `projectModel`, `provider`, `snapshots`, `snapshotsGroup`,
    `memories`, `globalEffort`, `globalTemplates`, `modelOverrides`, `accounts`.
  - `.rev` was `role="button" tabindex="0"` with a click handler and no keydown,
    so revert was keyboard-dead. It answers Enter/Space now.
  - `vGlobals` (dead view) retired; `open('globals')` still resolves.
- **Verified:** `node scripts/verify-feat-146-settings-shell.mjs` → **PASS, 114
  passed, 0 failed, exit 0**. Real server + brave `--headless=new` over raw CDP,
  a CONTAINER project and a DIRECT one, both themes, 940/800/500px, zero console
  errors. `npm run typecheck` clean; `npm run gate` PASS (leak-gate, check-nul,
  typecheck).
  Highlights of what was actually observed, not inferred:
  - all 14 `data-focus` + 6 `data-sect` keys resolve, flash and scroll into
    view, on both projects; `mounts`/`services` are an honest silent no-op on
    the direct project and the modal stays open;
  - exported API = exactly the 10 documented keys, all functions; 21 live
    `drawer.open()` call sites still present (the ticket's "18" counts unique
    sites; 21 is the comment-stripped occurrence count);
  - `inert` on `#win` while open and removed after; Tab from the last focusable
    wraps to the first; focus returns to the opener and falls back to `#cogBtn`
    when the opener was repainted away;
  - Esc #1 disarms an armed ceremony and the modal STAYS OPEN, Esc #2 closes;
    a backdrop click over an armed ceremony flashes it instead of closing;
  - during a REAL sign-in (the product's own login relay driven against a
    stubbed `claude` binary on the server's PATH) neither Esc nor a backdrop
    click closes, and `#gAcctCancel` flashes;
  - rail `↓`/`↑` cross the group boundary, `Home`/`End` jump, focus stays in the
    rail, only `Enter` moves it into the pane;
  - a lens flip leaves `scrollTop` byte-identical (120 → 120), the rail node
    identity unchanged and the selection unchanged; the SAME row click writes a
    session override under one lens (registry untouched, read back from the
    server) and writes `effort: null → "low"` through to the registry under the
    other.
- **Must-FAIL (non-vacuity):** the deep-link suite is re-run against a
  SYNTHESIZED pre-fix `drawer.js` — the shipped module rewritten on the wire via
  CDP `Fetch` interception with `FOCUS_CATEGORY` emptied. 6/6 sampled deep links
  stop routing (every one lands on whatever category was already selected).
  Anchored to a constructed broken variant, never to a moving revision.
- **Could not test:** container RUNTIME state (no Docker in the harness), so the
  Isolation rail dot's `live` branch is unexercised — only the `null` branch is.
  Real OAuth against claude.com (the login binary is stubbed; the relay,
  the panel and the close guard around it are real). Touch/pointer gestures on
  the `<560px` sheet — only the layout and the absent backdrop were measured.
  `prefers-reduced-motion` was not exercised (the app's global `*` reduce rule
  covers the new animations by construction, but that is inferred, not observed).
- **Still open / handoff to PHASE 2:**
  - Every project category except Snapshots and Templates still renders the WHOLE
    `settingsView()`; every machine category except Templates renders the whole
    `machineDefaultsView()`. The rail selects, but the pane does not yet filter.
    That is the deliberate seam — re-homing is phase 2's first job.
  - The `<details class="sect">` sections become redundant once content is
    re-homed (the rail replaces them). `d.sectClosed` and the `ephemeralOpen`
    guard go with them — but `applyFocus()` walks `details.sect` ancestors, so
    removing the sections means re-reading that function's contract first.
  - `data-armed="true"` is now the marker every armed ceremony carries for the
    close guard. Any ceremony phase 2 adds or moves must keep it.
  - `stampBaselines()` (dirty free-text detection) stamps `data-base146` on every
    text input in the pane after each paint. A phase-2 control that holds
    uncommitted text outside a normal paint must stamp its own baseline, the way
    `openEditor` does.
  - The footer's left slot carries the write-target hint; the charter's
    `Show all descriptions` toggle is phase 2's and belongs there.
  - `scripts/qa/settings-sections.spec.ts` still looks for a section labelled
    "Model & behaviour" — pre-existing drift from FEAT-139, not touched here.
- **Symptom of a deeper design flaw?** not closing this ticket, so not answered
  yet — phase 2 owns the answer.

### 2026-09-19 — PHASE 2a built: the pane FILTERS, and the project-scope account control
_Dispatch: ticket=FEAT-146 phase=fixing round=2 class=fix. Phase 2a of 2 — content
re-homing, the missing FEAT-145 control, the grouping defects. Phase 2b owns row
anatomy, the provenance chip and the `ⓘ` disclosure; none of that is built here._

- **Understood:** close phase 1's deliberate seam. The rail selected but every
  project category still rendered the whole of `settingsView()`, and every
  machine category except Templates the whole of `machineDefaultsView()`. Each of
  the 11 categories now builds only its own cards, no card is built by two of
  them, and no control was lost on the way.
- **Changed** (all unstaged):
  - `public/lib/drawer.js` — `settingsView()` / `machineDefaultsView()` became
    dispatchers over `d.cat`; the group builders themselves are UNCHANGED, just
    called from one place each: `modelPane` (model/effort/spend rows,
    `providerGroup`, the new account control, the machine-default link),
    `permissionsPane` (perms + `integrationsGroup`), `instructionsPane`
    (stack summary + `responseFormatGroup`), `isolationPane` (runtime,
    `containerBlock`, access + `dockerSocketBlock`, `servicesGroup`),
    `workspacePane` (`directoryBlock`/`repointPanel`, `gitGroup`,
    `processesGroup`), `advancedPane` (`wiringGroup` + the memory list),
    `accountsPane`, `appearanceGroup`, the defaults pane, `libraryView`.
    `snapshotsGroup()` moved into `snapshotsView()`, above the list it governs.
  - `<details class="sect">` is down to TWO: `advanced` (the memory list) and
    `patterns` (Templates). `d.sectClosed` and the `ephemeralOpen` one-shot stay
    for exactly those. `applyFocus()` was NOT touched — the four retired section
    keys (`model`, `caps`, `instr`, `isoSection`) are carried by each category's
    `catWrap` wrapper's own `data-focus`, and applyFocus resolves `[data-focus]`
    before `details[data-sect]`, so all 20 anchors still land.
  - The memory list renders inline in Advanced instead of behind an "open the
    list ›" navigation; `memoriesView()` is now the same builder, kept so the old
    `open('memories')` door still resolves. The "Instruction templates ›" link
    card in New-project defaults is gone (Templates is one rail click away); its
    `globalTemplates` anchor lands on the library itself now.
  - **The project-scope Claude account control** (`projectAccountGroup`), in
    Model & spend: a `<select>` showing each account's label, plan/login state and
    its OWN remaining 5-hour window. Project scope writes `settings.claudeAccount`
    (null for "machine default" — never the `'default'` sentinel, which the server
    maps to null and the echo-check would read as a failed save). Session scope
    delegates to app.js's own `pickAccount`. Under the session lens on a CONTAINER
    project it renders LOCKED with `accountLockedReason()` verbatim on screen.
  - **ARCH-010 consolidation:** the Claude ACCOUNT LIST now has ONE owner,
    `public/app.js`. `d.claudeAccounts`, the drawer's own
    `api.getClaudeAccounts()` call and its copy of the plan-description helper are
    gone; `ctx.accounts/refreshAccounts/acctPlanDesc/acctUsageDesc/
    accountLockedReason/pickSessionAccount` are how the modal reads them. The
    drawer still owns the LOGIN flow, which is a surface, not a fact.
  - Rail dots wired to real conditions, both directions: `--warn` for an OAuth
    login in flight, an account not signed in yet, a failed start snapshot, a
    missing host directory; `--live` for a process running out of the project dir,
    a running container, and a live session under the session lens.
    `prefetchForDots()` issues on open exactly the reads the old all-in-one pane
    issued anyway, so an unvisited category can still carry a dot.
  - `.trow .grip` — the `⠿` handle whose own tooltip said "Use the arrows to
    reorder" is deleted, glyph and CSS rule. The ▲/▼ arrows are the real control.
  - Machine scope on Instructions: already gone with the lens (scope is
    project/session only and `#dHint` says "Writing to this project"), asserted
    rather than assumed.
  - `public/styles.css` — `.scat` (the category wrapper), `.trow .grip` removed.
  - `src/server/wiring.ts` — one stale pointer this re-home created: the
    Integrations row said "Manage these in the Integrations group above"; that
    card is in Permissions & tools now, so it names the category.
  - `scripts/verify-feat-146-settings-content.mjs` — NEW, 69 assertions.
  - `scripts/verify-feat-146-settings-shell.mjs` — phase 1's suite, kept green at
    114/114. Four edits, each for a DELIBERATE design change, invariants intact:
    the machine warm-up opens the category that owns `globalModel`; the
    `isoSection` anchor is the category wrapper rather than a `<details>` (the
    invariant — two distinct reachable nodes, no collision — is unchanged); the
    `provider` anchor's expected category is `model`; the write-target test
    selects Model & spend before clicking Effort, and the scroll-preservation test
    measures on Permissions (asserted scrollable, not assumed).
- **Verified:** `node scripts/verify-feat-146-settings-content.mjs` → **PASS, 69
  passed, 0 failed, exit 0**; `node scripts/verify-feat-146-settings-shell.mjs` →
  **PASS, 114 passed, 0 failed, exit 0**. `npm run typecheck` clean; `npm run
  gate` PASS (leak-gate 0 hits / 1114 files, check-nul, typecheck).
  Observed, not inferred:
  - COMPLETENESS, the assertion that matters: all 16 flagged rows from the
    inventory pinned at commit `dc1f4ea` (pre-redesign) are still on screen, each
    in its assigned category, each in EXACTLY ONE category; all 24 unflagged
    controls likewise. Must-FAIL: dropping `integrationsGroup(...)` from the
    Permissions builder in a synthesized variant served over CDP makes the sweep
    name the four rows that vanished.
  - all 11 categories carry 11 markers BETWEEN them (1 each), not 11 each — the
    two-directional assertion, and the measurement that shows the seam is closed;
  - the 8 anchors this phase moved resolve, flash and scroll into view; phase 1's
    suite still drives all 20 on a container AND a direct project;
  - the account control wrote `claudeAccount: null → "<real account id>"` through
    to the registry (read back from the server, against an account really created
    through `POST /api/claude-accounts` — a client-side fixture would have hidden
    validate.ts's existence check), and `__inherit__` cleared it back to null;
  - under the session lens on the container project the control is present,
    `disabled`, its reason visible and byte-equal to `accountLockedReason()`, and
    a forced `change` event wrote NOTHING (overrides `{}` before and after, the
    registry still null). On the direct project the same lens armed
    `overrides.claudeAccount` and still wrote no registry value;
  - dots: accounts warn while an account is `pending` and CLEARS when ready; warn
    during a REAL sign-in (product login relay, stubbed CLI); snapshots warn for a
    failed start snapshot and clears; model `live` under the session lens only;
    workspace warn for a genuinely deleted host directory (server-reported
    `pathMissing`); workspace `live` while a real `sleep` process ran out of the
    project dir, cleared once it exited;
  - 11 categories × 940/800/500 × light/dark: non-empty, unclipped, inside the
    viewport, zero console errors. Screenshots of the five densest categories.
- **Could not test:** the Isolation dot's `live` branch (no Docker in the harness
  — same gap phase 1 reported). The live-session dot and the per-account 5-hour
  window are driven by seeding `state.effective` / `state.usage` with the shape
  the server's own events carry, because the harness has no live session or
  provider; the account LIST and the account itself are real. Real OAuth against
  claude.com. Touch gestures on the `<560px` sheet. `prefers-reduced-motion`.
- **Still open / handoff to PHASE 2b:**
  - Row anatomy is untouched, as charged: `.grp`/`.grp-l`/`.grp-note`/
    `.prov-state`/`.mini`/`.risk` are exactly as phase 1 left them, there is no
    four-column grid, no provenance chip and no `ⓘ`. The footer's left slot still
    carries only the write-target hint; the `Show all descriptions` toggle is 2b's.
  - Two `data-focus` anchors now sit on a WRAPPER (`.scat`), not a card: a
    provenance-chip pass must not assume every anchor is a `.grp`.
  - `catWrap(anchor, ...kids)` is the one place a category's cards are assembled;
    adding a card to a category is a one-line change there, and the completeness
    suite will fail loudly if a card leaves without a home.
  - Every armed ceremony still carries `data-armed="true"`; the only new control
    (the account `<select>`) holds no uncommitted text, so it needs no
    `data-base146` baseline.
  - Pre-existing, NOT caused here and not fixed here: `scripts/qa/
    settings-sections.spec.ts` asserts the four `<details class="sect">` sections
    this ticket deliberately retired (it was already drifting per phase 1);
    `scripts/qa/FEAT-054-chip-deep-link.spec.ts` asserts
    `details[data-sect="instr"]`, which is now a wrapper;
    `scripts/verify-feat-077.mjs` section C and `scripts/verify-feat-118-ui.mjs`
    reference `#libBtn` and `#vGlobals`, removed by FEAT-139 and phase 1
    respectively. Four suites want one sweep; none is a product defect.
- **Symptom of a deeper design flaw?** not closing this ticket, so not answered
  yet — the answer belongs with phase 2b, which finishes the redesign.

### 2026-09-19 — PHASE 2b built: row anatomy — the four-column grid, the provenance chip, the inline `ⓘ`
_Dispatch: ticket=FEAT-146 phase=fixing round=3 class=fix. Phase 2b of 2 — the
final build phase. Phases 1 and 2a stayed green throughout and are the
anti-regression._

- **Understood:** rendering only. The four columns (label / provenance chip /
  value / a permanently reserved 46px gutter), the chip's hollow-vs-filled
  luminance idiom, the inline disclosure that replaces the tooltips the user
  asked for — and, above all, the hazard rule that keeps 38 load-bearing
  sentences out from behind an icon.
- **Changed** (all unstaged):
  - `public/styles.css` — `.set` is a four-column grid
    (`minmax(0,1fr) auto minmax(110px,200px) 46px`, `column-gap:10px`,
    `min-height:34px`, padding `9px 8px`). Row 1 / row 2 are stated EXPLICITLY:
    auto-placement is sparse, and the full-width `.set-why` is appended before
    the gutter, so an auto-placed gutter landed on row 2 — the `ⓘ` sat half a
    paragraph below the label it belongs to. Caught by looking at the
    screenshot, not by a DOM assertion. New: `.prov` (chip), `.sgut` (gutter),
    `.set-why` (disclosure), `.sfoot-tog` (the footer switch), `.set > .set-main`
    (see below). **Deleted:** `.ovr`, `.inh` and the `.set:hover .inh` reveal —
    information available only to a mouse is not available.
  - `public/lib/drawer.js` — `provOf()` / `fieldProv()` / `provChip()` /
    `resetTarget()` / `resetField()` / `gutter()`, the `WHY` description map,
    and `whyIsOpen`/`toggleWhy`/`setWhyAll`/`collapseWhyAtFocus`. `row()` and
    `listRow()` rebuilt on them; `imageRow`, `memoryRow` and the three
    new-project-default `.gset` rows carry chips too (that is where the
    `project-only` and filled-`machine` states come from).
  - `public/index.html` — `#dWhyAll` ("Show all descriptions") in the footer's
    free left slot, which phase 1 left for it.
  - `scripts/verify-feat-146-settings-rows.mjs` — NEW, 59 assertions.
  - `scripts/verify-feat-146-settings-shell.mjs` — ONE edit, for a deliberate
    design change: the write-target test read the `.ovr` tag, which no longer
    exists; it reads the chip (`data-level="session"`, `data-fill="true"`)
    instead. The invariant is unchanged — the row must SHOW that the write
    landed at session scope.
- **The hazard rule, as built.** Only definitional prose about a reversible
  choice between safe options went behind an `ⓘ`: five entries (model, effort,
  container image, Serena, Playwright). There is deliberately NO entry for
  `permissionMode`, `maxBudgetUsd`, the two tool lists, isolation, the docker
  socket, the account pickers, snapshot retention, or any destructive ceremony —
  so on those rows the icon's ABSENCE is the signal, exactly as specified.
  `.risk`, `permModeNote()`, `projectOnlyNote()`, `.prov-state`,
  `failureNote()`/`liveFailureNote()` and every ceremony are untouched.
- **A nested-button problem the spec did not anticipate, and how it was solved.**
  "A cycle row stays a `<button>`" and "the `ⓘ` is a real `<button>`" cannot both
  hold if the gutter lives inside the row button — a button inside a button is
  invalid HTML, and this is an accessibility ticket. So a cycle row is now a
  `<div class="set" data-cycle="true">` holding a real `<button class="set-main">`
  that spans columns 1-3 as a **subgrid** (its label/chip/value sit on exactly
  the same rails as every non-cycle row), with the gutter's real buttons outside
  it in column 4. The click handler is on the ROW, so the whole row still cycles,
  keyboard activation of the inner button bubbles to the same handler, and the
  focus ring is drawn on the row. Subgrid + `:has` support is ASSERTED in the
  suite, not assumed.
- **Also fixed, from the inventory's "four idioms for inherit":** the `.inh`
  hover tag is deleted; the `.ovr` tag is replaced by the chip; the bare word
  `inherit` is gone from cycle rows — a row inheriting the machine default now
  shows the MACHINE VALUE beside a hollow `machine` chip, and a row with nothing
  set anywhere shows a dimmed `built-in` with no chip at all. The remaining two
  ("Built-in" in `globalSeg`, the "no global default" select option) are
  CONTROLS, not display idioms: deleting them would leave no way to unset a
  machine default, and they belong to FEAT-139, which this phase was told not to
  restyle.
- **Verified:** `node scripts/verify-feat-146-settings-rows.mjs` → **PASS, 59
  passed, 0 failed, exit 0**. Anti-regression:
  `verify-feat-146-settings-shell.mjs` → **114/114**,
  `verify-feat-146-settings-content.mjs` → **69/69**.
  `node scripts/verify-bug-101-contrast.mjs` → ALL PASS (all three sections).
  `npm run typecheck` clean; `npm run gate` **PASS** (leak-gate, check-nul,
  typecheck). Observed, not inferred:
  - THE HAZARD ASSERTION: 8 load-bearing sentences spanning classes (a) data
    destruction, (b) security widening, (c) limit-of-protection and (e) cost,
    each driven onto the screen by a REAL server state (a `bypassPermissions`
    direct project, a container with `dockerSocket:true`, a project whose
    directory was actually deleted, the session lens on a container project) —
    every one found, visible on first paint, and not inside a `.set-why`. Class
    (d) is covered by the live provider verdict (`OpenAI Codex — connected`),
    asserted present in flow without pinning wording that a live read owns.
  - the general case, two-directionally: EVERY `.set-why` the modal can produce
    — 10 blocks across 3 categories × both lenses — carries one of the five
    definitional descriptions and nothing else.
  - MUST-FAIL: a synthesized `drawer.js` that moves permModeNote's sentence into
    the `WHY` map (served over CDP Fetch interception) makes BOTH the
    first-paint check (`visible:false, inWhy:true`) and the definitional-prose
    invariant go red, the latter naming the smuggled sentence. Anchored to a
    constructed variant, never to a revision.
  - the chip in all five states against real inheritance: built-in (no chip,
    dim, `built-in`), machine (hollow, `medium`, the real machine default read
    back from `/api/settings`), project (filled under the project lens), the
    SAME value hollow under the session lens, session (filled, registry still
    `low`), project-only (Base image under the session lens on a container
    project). Every chip anywhere in the modal names its own level in text.
  - reset: present only on a filled chip (swept across the pane, zero
    violations); clicking it cleared `settings.effort` on the SERVER
    (`"low" → null`) and the row fell back to the machine default `medium` with
    a hollow `machine` chip — the resolved parent, not a blank.
  - no reflow, measured twice: a row with a reset and a row without share the
    same rails to the pixel (gutter `574..620`, width 46 in both; label left 8;
    value right 564), and the same row keeps byte-identical geometry once its
    reset disappears. Every `.set` gutter measured exactly 46px at 940/800/500
    in both themes.
  - the `ⓘ` keyboard path with REAL CDP key events: Tab from the row control
    lands on `#whyb-model`; Enter expands with `aria-expanded=true`,
    `aria-controls=why-model`, `aria-describedby` on the control; the block is
    in flow (it pushes the next row down, no overlap); Esc collapses it,
    restores focus to the `ⓘ`, drops `aria-describedby` and leaves the modal
    OPEN; the next Esc closes it.
  - `Show all descriptions`: one click expands 2/2, 1/1 and 2/2 blocks in
    model / isolation / defaults, writes `localStorage["orchard.settings.descriptions"]="all"`,
    survives a full reload, and collapses again on a second click.
  - chip contrast: filled 16.66:1 (light) / 14.99:1 (dark), hollow 5.29:1 /
    5.23:1 — all above AA, and the difference is luminance, not hue.
  - 11 categories × 940/800/500 × light/dark: unclipped, inside the viewport,
    zero console errors. Screenshots of both themes and of the expanded state.
- **Could not test:** the Isolation dot's `live` branch and anything needing a
  real container runtime (no Docker in the harness — the same gap phases 1 and
  2a reported). Real OAuth. Touch gestures on the `<560px` sheet — the 24×24 hit
  targets are built and measured in CSS, but no real touch event was dispatched.
  `prefers-reduced-motion` on the `.set-why` fade (the rule is written; the
  media state was not emulated). A screen reader was not run: the ARIA wiring is
  asserted attribute by attribute, which is not the same as hearing it.
- **Still open / handoff:**
  - `container.memoryMb` shows a filled `project` chip with NO reset, because
    the server has no unset for it (`validate.ts` requires an integer ≥ 512) and
    inventing one would mean a second write path into container settings. The
    gutter is still reserved, so nothing reflows. If that field should be
    resettable, it is a data-layer change and needs its own ticket.
  - The footer now carries three items and both prose slots can ellipsize at
    940px; neither is load-bearing (those sentences render in the pane), and
    both now carry a native `title` so the full text is recoverable.
  - Pre-existing, not caused here and not fixed here — the same four suites
    phase 2a listed (`scripts/qa/settings-sections.spec.ts`,
    `scripts/qa/FEAT-054-chip-deep-link.spec.ts`, `scripts/verify-feat-077.mjs`
    section C, `scripts/verify-feat-118-ui.mjs`) still want one sweep.
- **Symptom of a deeper design flaw?** Yes, and it is worth naming even though
  this phase fixed its instance: the four competing "where did this value come
  from" idioms existed because **no layer ever declared the provenance of a
  value — every row re-derived it**, which is ARCH-010's rule verbatim. The chip
  is now the one place that answers it for a settings row, but the data layer
  still returns bare values, so the next surface that needs provenance (the
  launch popover, the crown chips) will derive it again. Worth an ARCH ticket if
  a third reader appears; one reader and one panel is not yet a class.

### 2026-09-19 — round 3: the four stale sibling suites, swept
_Dispatch: ticket=FEAT-146 phase=fixing round=3 class=fix. Owned only
`scripts/qa/settings-sections.spec.ts`, `scripts/qa/FEAT-054-chip-deep-link.spec.ts`,
`scripts/verify-feat-077.mjs` §C and `scripts/verify-feat-118-ui.mjs` — the four
false reds phase 2a found and correctly left alone. Did not touch
`public/lib/drawer.js`, `public/styles.css`, `public/index.html` or
`public/app.js` (a lane was rewriting the first three concurrently — see below)._

- **Understood:** each suite still asserted UI the redesign retired; per-suite,
  update to assert the CURRENT invariant, never assert less, and delete only as
  a last resort with the reason recorded.
- **Changed** (all unstaged):
  - `scripts/qa/settings-sections.spec.ts` — REWRITTEN. Old intent: (a) four
    named `<details class="sect">` sections, Advanced collapsed by default;
    (b) the Access card absent outside container isolation. New assertions:
    (a) the 11-item rail in its two groups, in order (`#sRail .srail-item .n`),
    plus the ONE surviving `<details data-sect="advanced">` (Agent memories)
    still collapsed-by-default and still toggles — the direct descendant of
    the old invariant; (b) unchanged in substance, re-pointed at
    `#sRail-isolation` → `#vSettings .grp-l:has-text("Access")`. Also found and
    fixed a REAL fixture bug unrelated to the redesign: the suite assumed a
    fresh project registers `isolation: 'direct'`, but
    `NEW_PROJECT_DEFAULT_ISOLATION` (`registry.ts`) is `'container'` — the
    fixture now PATCHes isolation to direct explicitly rather than assuming
    the server's default. Persistence assertions re-pointed at
    `.grp[data-focus="projectModel"]` (unchanged row anatomy at the time).
    **Went red again mid-fix** when phase 2b landed (row anatomy: `.ovr` →
    the `.prov` provenance chip) — not chased blindly; confirmed the ONE
    broken assertion via the concurrent lane's own new `provChip`/`fieldProv`
    code, then re-pointed it at `.prov[data-level="session"][data-fill="true"]`.
    Verified 3/3 clean runs after.
  - `scripts/qa/FEAT-054-chip-deep-link.spec.ts` — REWRITTEN. `git`/`processes`
    moved from "Advanced" to "Workspace" in phase 2a, so the "Advanced expands"
    half of the original intent has no surviving analog for any of this
    suite's five door chips (none still targets a collapsible `<details>`);
    kept assertion re-pointed at rail-category selection
    (`#sRail-<id>[aria-current="page"]`) plus the unchanged flash/scroll
    mechanics. **FINDING, not fixed (out of scope — app.js is off limits
    here):** `#isoBtn` has been unconditionally `hidden = true` since FEAT-139
    (`app.js:2619`) and nothing un-hides it, so the "isolation popover footer"
    door (`#isoBtn` → `#pop` → `#popSettings`) is dead code predating this
    ticket — a real user cannot reach it. Its `{focus:'iso'}` mapping is still
    live product code, so that one sub-test now drives
    `window.__station.drawer.open('settings',{focus:'iso'})` directly instead
    of through the unreachable button, rather than deleting the coverage.
  - `scripts/verify-feat-077.mjs` — `#libBtn` (removed by FEAT-139) replaced
    with the current path: `#cogBtn` → `#sRail-templates`. Also fixed the
    confirmed-pre-existing WebSocket close-before-open fatal (cheap and
    obviously correct, as the charter allowed): the teardown loop called
    `s.removeAllListeners()` then `s.close()`, but a socket still CONNECTING
    at teardown emits its 'error' ASYNCHRONOUSLY, after the listeners meant to
    catch it were already stripped — Node then treats it as unhandled and
    crashes the process, which was happening AFTER every check had already
    printed PASS. Fixed by attaching a permanent no-op `error` listener before
    `close()` instead of removing listeners. 30/30, verified clean across
    multiple runs.
  - `scripts/verify-feat-118-ui.mjs` — `drawer.open('globals')` (a view phase 1
    retired) replaced with the real current path, `drawer.open('settings',
    {focus:'globalModel'})`; `#vGlobals` reads replaced with `#vSettings`
    (same underlying host element, `VIEWS.machine.el === 'settings'`). Two
    NEW async races surfaced once the suite could actually reach this deep,
    both fixed test-side (no drawer.js edit): (1) `ensureGlobals()`'s own
    `.finally` only repaints for `d.view === 'globals' || 'settings'`, never
    updated for FEAT-146's `d.view === 'machine'` — so the FIRST-ever visit to
    a machine category shows "Loading machine-wide defaults…" and it is never
    replaced; worked around with a documented one-time reopen (the real defect
    is reported here, not fixed, since drawer.js is off limits); (2) the
    rail's background dot-prefetches call the SAME full-pane `paint()` on
    resolution regardless of which category is visible, so a multi-step UI
    interaction split across separate CDP round trips (select → read; type →
    click) can be silently clobbered mid-sequence by an unrelated repaint —
    fixed by making each logical step one atomic, single-threaded
    `Runtime.evaluate` call. Verified 8/8 clean runs after both fixes; before,
    ~1 run in 3 failed non-deterministically.
- **Verified:** `npx playwright test scripts/qa/settings-sections.spec.ts` →
  PASS (3/3 repeat runs). `npx playwright test
  scripts/qa/FEAT-054-chip-deep-link.spec.ts` → could NOT run in this sandbox:
  the fixture's `execFileSync('git', ['init', …])` is refused by this
  environment's agent git-write guard even for a throwaway scratch repo
  (unrelated to this ticket). Verified everything BEFORE that line by running
  a discarded scratch copy with the `git init` swapped for a bare `.git`
  directory stub: server boot, project fixtures, baseline rail-category and
  no-stray-flash assertions, and (with the git-dependent chip swapped for the
  permission chip) sections 3/4/5/6/7/8 all passed — the git/proc-chip
  sections (1 and the first half of 6) rely on identical, already-proven
  mechanics and were not independently exercised. `node
  scripts/verify-feat-077.mjs` → PASS, 30/30, exit 0 (3/3 repeat runs). `node
  scripts/verify-feat-118-ui.mjs` → PASS, 15/15, exit 0 (8/8 repeat runs after
  the atomic-eval fix). `npm run typecheck` clean. `npm run gate` PASS
  (leak-gate 0 hits / 1115 files, check-nul, typecheck).
- **Could not test:** `scripts/qa/FEAT-054-chip-deep-link.spec.ts`'s git-chip
  and proc-chip sections end to end (sandbox git-write guard, above) — the
  user or a differently-permissioned lane should run it directly once.
- **Still open / handoff:**
  - `#isoBtn` dead-code finding (above) is real but out of this charter's
    scope (app.js) — worth a small ticket if the isolation-popover door was
    meant to stay reachable, or a deletion if it was meant to retire with
    FEAT-139's other moved chips.
  - `ensureGlobals()`'s missed-repaint-on-`'machine'`-view finding (above) is
    real product behavior (a real user's first-ever visit to a machine
    category can stick on "Loading…" until their next click) but out of this
    charter's scope (drawer.js) — a one-line fix
    (`d.view === 'machine'` added to that `.finally`'s condition) for whoever
    picks up phase 2b/3 next.
  - The rail's dot-prefetch full-pane repaint racing an in-progress
    multi-step interaction (finding 2 above) is systemic, not limited to the
    one field this round hit — worth a note for whoever next builds a
    CDP/Playwright suite against a category with a free-text field.
- **Symptom of a deeper design flaw?** Not this ticket's to answer a second
  time — see phase 2b's entry above. This round's two NEW findings
  (`#isoBtn` dead since FEAT-139, `ensureGlobals()`'s view-guard) are both
  instances of the SAME class already named there: a fact (is this button
  reachable? does this view need a repaint?) that nothing declares in one
  place, so a change elsewhere silently invalidates an assumption a reader
  had no way to see.

### 2026-09-19 — INDEPENDENT VERIFICATION (round 1): VALID — VERDICT: HOLDS
_Dispatch: ticket=FEAT-146 phase=verifying round=1 class=verify. Clean-room
independent verification via `scripts/independent-verify.mjs`. This lane was the
HARNESS, not the verifier: it composed the requirement, ran the clean room and
recorded the result. It formed no opinion of its own and changed no source file._

- **Verified-by:** dispatch anthropic run `ef020037-e216-4a21-b0dd-d71e35b5a585`
  (clean-room, `scripts/independent-verify.mjs`) — **VERDICT: HOLDS**, contract
  **VALID**, manifest-backed, harness exit 0.
- **Setup, stated honestly.** `--working-tree` snapshot `dc1f4ea0f3d2 → tree
  413ba09c8ed3` (2,252,039 diff bytes, deliberately truncated to 0 — the room
  carries many concurrent lanes' edits, so the FEAT-146 surface was named in the
  requirement instead: `public/lib/drawer.js`, `public/styles.css`,
  `public/index.html`, and only the Esc-ladder region of `public/app.js`; the
  rest of the dirty tree was declared out of scope). `docs/prompts` and
  `docs/bugs` stripped. All three author suites supplied as TEST CODE; no author
  report, rationale or Activity-log prose was shown.
- **BUG-182's fix held, and it mattered.** The room seeded all eight
  `seed-sources.mjs`-declared boot docs (including `WORKING_AGREEMENT.v3.md` /
  `.v4.md`, the two the old hardcoded list was missing). The stripped server
  BOOTED, so this round is live-server evidence end to end, not a static
  fallback. This is the first FEAT-146 round for which that is true.
- **CROSS-PROVIDER FAILED — this verdict is SAME-PROVIDER and therefore weaker.**
  OpenAI was tried properly first and is still inside its quota window:
  `dispatch failed [quota-window] (provider openai): You've hit your usage
  limit… try again at 1:37 PM`. That retry time is 13:37 TODAY and had **not**
  passed (the attempt was at 01:17 local). The fallback is `anthropic`, the same
  provider as the authors — the harness says so on its own face
  (`author-provider anthropic — SAME provider, decorrelation reduced`). Any
  blind spot shared by author and verifier survives this round. Re-running
  cross-provider after 13:37 would strengthen it.
- **(i) All three author suites RE-RUN**, chained into the one fixer-test command
  the contract permits, executed harness-side through the recorder:
  `node scripts/verify-feat-146-settings-shell.mjs && node
  scripts/verify-feat-146-settings-content.mjs && node
  scripts/verify-feat-146-settings-rows.mjs` → **exit 0**, manifest
  `761155b744f3`. Real server + real headless browser inside the clean room,
  independent of this tree's `node_modules` (reflink-copied, never linked). The
  rows suite's own MUST-FAIL reproduced in the clean room too: the synthesized
  variant that smuggles `permModeNote`'s sentence into the `WHY` map makes both
  the first-paint check and the definitional-prose invariant go red and NAMES the
  smuggled sentence.
- **(ii) Three adversarial cases the authors' fixtures do not cover**, each its
  own scratch script, each its own recorded run, each aimed at a DIFFERENT item
  on the attack list. All three the code SURVIVED:
  - `deeplink-open` (run `ca8bfa9585f9`, exit 0) — **the gap in the authors' own
    deep-link helper.** Their `DEEP_LINK` helper always calls `D.close();
    D.close()` before `open()`, so a deep link arriving while the modal is
    ALREADY OPEN on a different category is never exercised. Driven bare, it
    re-routed model→workspace, the anchor was found, flashed and in view, zero
    console errors.
  - `perm-reset` (run `5c7d6e455d9c`, exit 0) — **the security-critical reset the
    rows suite never performs.** The authors reset only `effort`, a
    null-clearable machine-defaulted field. `permissionMode` is the opposite
    case: the server rejects null, so its reset must WRITE `'default'`. Set a
    project to `bypassPermissions`, clicked the filled chip's reset, read back
    from the server: `"bypassPermissions" → "default"`. The revert away from a
    security-widening mode really lands.
  - `sandbox-shape` (run `c9095938079a`, exit 0) — **the third isolation tier no
    fixture builds.** Every author fixture is container or direct; `sandbox` was
    never rendered by anything. With `isolation:sandbox` stored on the server the
    Isolation category renders non-empty, the Sandbox tier is selected, and its
    in-flow "confined to the project directory" safety note is VISIBLE and
    unclipped — i.e. a hazard string that survives on a project shape the authors
    never painted. Zero console errors.
  - Also attempted and survived, in the discarded first attempt (see below), and
    recorded: the chip-lying attack where a project stores a value EQUAL to the
    machine default. The chip showed a FILLED `project` (not a hollow `machine`
    lie), the reset offered "Reset Effort to the machine value (medium)", and
    clicking it CLEARED the key (registry → null) and fell back to a HOLLOW
    `machine` chip. Recorded run `2f151ee32585`, exit 0.
- **(iii) The verifier's own could-not-test list**, verbatim in substance:
  - real provider OAuth completion — the `claude` binary is stubbed and blocks on
    stdin, so only the login-in-flight guard state is exercised, never a genuine
    handshake or quota spend;
  - **control-completeness on a git-REPOSITORY project shape and a
    snapshots-present shape** — every fixture (the authors' and the verifier's)
    uses non-git, snapshot-less scratch dirs, and there was no pinned pre-redesign
    baseline to diff a repo-only or snapshot-only control against, **so a control
    dropped only in those shapes could not be ruled out**. This is the largest
    remaining hole and it is exactly attack #1 on the list;
  - a real container runtime — the docker-socket flag is a stored setting only;
    no Docker daemon was exercised (the same gap all three build phases reported);
  - the cosmetic chip state after a `permissionMode` reset: it stays filled
    `project` showing `default` rather than going ABSENT. The verifier explicitly
    declined to call this a defect, because `permissionMode` has no null-clear in
    the (out-of-scope) data layer and no ABSENT baseline could be forced. Worth a
    look by whoever owns the chip, but it is NOT a finding.
- **No FINDING lines.** The verdict is HOLDS with zero defects cited; the three
  break attempts and the equal-to-default chip attack all failed to break it.
- **Round 0 was INVALID on SHAPE, and its substance was correctly discarded.**
  The first dispatch answered with THREE `FIXER-TEST:` lines (one per suite);
  the contract allows exactly one, the harness's single corrective re-prompt did
  not fix it, and the whole answer was thrown away (`exit 3`). The harness-side
  cause was this lane's: the three `--run` strings each carried a `node
  ./vrun.mjs` prefix, which would also have failed `composeVerdict`'s
  command-identity check against the recorded command. Fixed by supplying ONE
  chained `--run` and saying so in the requirement. **For the next harness: pass
  `--run` as the BARE command the recorder will execute, never with the
  `./vrun.mjs` prefix, and chain multiple suites into one command rather than
  supplying several.**
- **Safety, and how it was confirmed.** Every server the room booted set
  `CLAUDE_STATION_DATA` / `CLAUDE_CONFIG_DIR` / `CLAUDE_PROJECTS_DIR` at scratch
  dirs it created; no test was pointed at the real config or transcript store.
  No OAuth was completed and no provider quota was spent by any test — the
  `claude` leaf was stubbed. Confirmed AFTER the run by re-fingerprinting the
  real store: the registry and the user's CLI `settings.json` are BYTE-IDENTICAL
  to their pre-run state (same sha256 prefix, same size, same mtime), and the
  registry contains zero projects matching any scratch or clean-room path. No
  source file was modified by this lane; no git write command was run. Both kept
  clean rooms were removed afterwards; the two record dirs
  (`cleanroom-record-bYTtt6` for round 0, `cleanroom-record-JD8gep` for the
  VALID round) are kept under the scratch root as the cited artifacts. No
  leftover server or browser process from either room survives.
- **Still open / handoff:** the redesign is independently VERIFIED subject to two
  named weaknesses, both of which are cheap to close and neither of which this
  lane may close itself: (a) the verdict is SAME-PROVIDER — re-run
  `independent-verify` with `--provider openai` after the quota window reopens;
  (b) completeness was never tested on a **git-repo** project shape or a
  **snapshots-present** shape, the two shapes most likely to hide a silently
  dropped control. A follow-up round that builds those two fixtures would
  retire the biggest item on the could-not-test list.
- **Symptom of a deeper design flaw?** Not this lane's to answer — phase 2b
  answered it (no layer declares a value's provenance, so every reader
  re-derives it; ARCH-010 verbatim), and nothing found in this round changes
  that answer.

### 2026-09-19 — round 4: the fourteen defects an independent design review measured
_Dispatch: ticket=FEAT-146 phase=fixing round=4 class=fix. Owned
`public/lib/drawer.js`, `public/styles.css`, `public/index.html`, `public/app.js`
and the verify scripts. The three FEAT-146 suites and the contrast suite were the
anti-regression throughout._

- **Understood:** an independent design-critical visual review (81 screenshots,
  both themes, 940/800/500px, all 11 categories) measured 14 defects. Every one
  was a rendering fact with a number attached, so every fix here is graded
  against that number rather than against a described intent.
- **Changed** (all unstaged):
  - `public/styles.css` — the rail's narrow layout (24px `mask-image` fades, the
    group headings collapsed to a hairline divider below 860px);
    `scrollbar-gutter: stable` on `.spane`; `.grp` padding `12px 15px 13px` →
    `14px 16px` and pane `16px 22px 26px` → `16px 20px 24px`; `.set-why` became
    the ONE explanatory surface and the `.risk .why` / `.wiring-row .why`
    hairline variant was deleted; `.sgut` became two fixed 23px slots assigned by
    `grid-column`, `align-self: start` + 3px; the type scale collapsed to four
    steps across ~45 rules; `.seg` lost its stacked glyph row and is 34px; new
    `.guidance-in`, `.cacts`, `.gcustom.joined`, `.slive`; `.gsel` draws its own
    caret; `.mode` is a plain text button; `.mini.danger:disabled` stays filled;
    `.lrow` reserves the marker column and the 46px value gutter; the light
    `--warn` moved `#B0703C` → `#967A3A`.
  - `public/lib/drawer.js` — `WIRING_ICON` (`✅⚠️❌ℹ️`) replaced by `WIRING_STATE`
    rendered through the panel's own `.prov-state` dot-and-word idiom; the `ISO`
    and provider glyph maps emptied; the guidance textarea is `.guidance-in`, not
    `.vin`; `liveStateText()` lost its duplicate branch and renders in the pane;
    `directoryBlock` is a card with a `.set.stack` row; the Git/processes/repoint
    actions are all `.mini` in `.cacts`; `revealSelectedCat()`; the restore
    button reads `Restore this project`; the sign-in heading is fixed; the three
    inline settings-key duplicates deleted; Patterns wrapped in a card; the
    living marker reserved on every template row; `descriptionsGroup()` added to
    Appearance.
  - `public/index.html` — `#dLive` moved from the footer into the pane;
    `#isoBtn` and the `#pop` popover it alone opened, DELETED.
  - `public/app.js` — the `#isoBtn` / `#pop` / `#popSettings` node refs and
    handlers removed; `ensureGlobals()`'s `.finally` now covers
    `d.view === 'machine'`.
  - `scripts/verify-feat-146-settings-polish.mjs` — NEW, 81 assertions.
  - Sibling suites updated for deliberate changes only:
    `verify-feat-146-settings-shell.mjs` (the `iso` deep link is driven directly
    now that its unreachable door is gone, + one NEW assertion that the door is
    absent; the call-site count 21 → 20; the git-init button is a `.mini`),
    `verify-feat-146-settings-rows.mjs` (`.set-why` → `.set-why.disclosure`, see
    below), `verify-bug-075-mount-chip.mjs` (`#isoBtn` hidden → absent — the
    stronger form of the same invariant), `scripts/lib/guide-fixture.mjs`.
- **The one naming decision worth recording.** `.set-why` used to mean "prose
  behind an ⓘ", and the hazard rule is stated in those terms. Making it the ONE
  explanatory surface would have silently widened the class the rule governs, so
  the ⓘ-toggled block carries `.set-why.disclosure` and the rows suite was
  re-pointed at that. `.set-why` is now the SURFACE; `.disclosure` is the subset
  the hazard rule is about. The rule itself is unchanged and still green.
- **Verified:** `node scripts/verify-feat-146-settings-polish.mjs` → **PASS, 81
  passed, 0 failed**. Anti-regression: `-shell.mjs` → **115/115** (114 + the new
  door assertion), `-content.mjs` → **69/69**, `-rows.mjs` → **59/59**,
  `verify-bug-101-contrast.mjs` → **ALL PASS** (all three sections, after the
  `--warn` change). `npm run typecheck` clean; `npm run gate` **PASS**
  (leak-gate, check-nul, typecheck). Measured, not inferred — the review's own
  numbers on the left, what the browser reports now on the right:
  - card width 660/670 across categories → **664 on all 11, x=475 on all 11**,
    and the precondition that makes it non-vacuous is asserted (7 categories
    overflow the pane, 4 do not);
  - `.set-why` two components → **ONE**: 32 blocks over 7 categories, all
    `rgb(19,21,19) | 8px | 9px 11px | 1px rgb(29,32,29) | 407.83px | 11.5px`,
    covering both the always-visible block and the ⓘ disclosure;
  - ten type sizes → **four**: `10px mono, 10px sans, 11.5px mono, 11.5px sans,
    12px mono, 12px sans, 15px sans` and nothing else, swept over all 11
    categories;
  - colour emoji → **none**, and the only non-greyscale paint left anywhere in
    the modal is `rgb(143,164,112)` = `--live`;
  - the textarea 201×60 / radius 0 / `monospace` / light-grey-in-dark →
    **630×96, radius 8, the real `--mono` stack, `bg = --window` in BOTH themes,
    a 205-character value unclipped, `resize: vertical`, `appearance: none`**;
  - the ⓘ moved x:1089→1068 when a reset appeared → **x 1064 → 1064**, gutter
    `46px @1060` in both states; the four columns' spread against the row's
    FIRST LINE BOX is **2px** (firstLine 293, chip 295, value 294.5, info 294,
    reset 294.5) — it was 8px;
  - seg heights 53 / 54 / 35 → **34 / 34 / 34**, zero `.g` glyph spans;
  - footer 299px-into-201 and 476px-into-320 → **6 states (940/800/500 ×
    project/session), 0 clipped**, one prose slot;
  - `selInView: false` → **fully in view at 940/800/500 for a first, a middle
    and a last category**, the middle one centred at 0.50 both times, with the
    strip genuinely overflowing (1324 vs 766 and vs 500);
  - `Restore <62-char name>` → **"Restore this project", 132px**, on a project
    whose real name is 73 characters; the primary is filled and Cancel is not;
  - Templates title rail `[504 × 8]` (was two rails 25px apart, and the sweep
    asserts it saw both marked and unmarked rows); its right block ends at
    x:1050, the settings value rail ends at x:1050;
  - the Git card: 4 buttons, one class, one border width.
- **MUST-FAIL (non-vacuity), six of them.** Five are re-run against a SYNTHESIZED
  stylesheet served over CDP `Fetch` interception, each re-creating one measured
  defect exactly; two against a constructed DOM state. All six caught it:
  `scrollbar-gutter: auto` → widths `[664, 674]`; a flex-packed `.sgut` → the ⓘ
  moves `1090 → 1069`; a 12.5px label → the type sweep names three rows; the
  restored hairline variant → two surfaces side by side in Isolation
  (`8px/rgb(19,21,19)` and `0px/transparent`); a 53px `.prov-seg` → `{model:
  [53,53], appearance:[34,34,34]}`; a single injected `❌` → the emoji detector
  names the element; the second footer string re-added → both strings clip.
  Anchored to constructed variants, never to a revision.
  **One of those must-FAILs found a real hole in the suite itself**: the type
  sweep only measured childless leaves, so `.set .l` — which carries a `.f`
  sub-label child, and is the single most important size in the pane — was never
  measured at all. It sweeps every element that owns a direct text node now.
- **Also closed, the two product defects the round-3 lane found and correctly
  left alone:** `#isoBtn` was unconditionally `hidden = true` from FEAT-139 on,
  so the button, its popover, that popover's three options and its "Project
  settings ›" footer were unreachable by any user — all deleted, with the deep
  link it carried re-pointed and asserted. And `ensureGlobals()`'s `.finally`
  repainted for `'globals'`/`'settings'` but never `'machine'`, so a user's
  FIRST-ever visit to a machine category stuck on "Loading machine-wide
  defaults…" until their next click; driven as a real reload-then-navigate and
  asserted (`stuck: false, cards: 5`).
- **Decisions honoured as given:** the warm caution colour stays and the light
  value is duller (`#967A3A`, re-checked by the contrast suite); the fixed 680px
  height stays; the provenance chip, the 200px value rail, the restore
  ceremony's structure and copy, the card-label idiom, the rail's sentence-case
  group headings at desktop width, the hidden lens on machine categories, the
  52px row pitch and the absent category-switch transition are all untouched.
- **Could not test / not done:**
  - **Row density was NOT built.** The charter asks for it as a way to fill
    Appearance and, in the same charter, lists "Row density (52px pitch — do
    **not** tighten)" under do-not-change. A control whose only purpose is to
    tighten a pitch that must not be tightened is a contradiction this lane
    cannot resolve alone, and it would add a machine-level stored preference
    that becomes a second authority over row geometry. Appearance got the
    "Show all descriptions" default instead — a real machine-level visual
    preference that already exists in localStorage and now has one writer
    (`setWhyAll`) and two surfaces. Appearance is still the emptiest category.
  - The Isolation rail dot's `live` branch and anything needing a real container
    runtime (no Docker in the harness — the same gap every phase has reported).
  - Real OAuth against claude.com; the login relay and its panel are real
    against a stubbed CLI.
  - Touch gestures on the `<560px` sheet. The mask fade is static rather than
    scroll-aware: it renders at both ends even at `scrollLeft: 0`, which is
    correct-looking but is a simplification, not a measured scroll state.
  - A screen reader was not run. The collapsed group headings below 860px keep
    their text and their `aria-labelledby` linkage (asserted `font-size: 0`,
    `width: 1px`, text intact), which is not the same as hearing it.
  - `prefers-reduced-motion` was not emulated this round either.
- **Still open / handoff:**
  - The `#isoBtn` deletion changed the `drawer.open()` call-site count from 21
    to 20. That number is asserted in `verify-feat-146-settings-shell.mjs`; if a
    future change adds a door, update it there.
  - `scripts/lib/guide-fixture.mjs`'s `isolation-chip` shot now targets
    `#settingsBtn`. The screenshot's LABEL was rewritten to match; whoever
    regenerates the guide should look at the new frame.
  - `.set-why` vs `.set-why.disclosure` is the one class distinction a future
    lane must not collapse — see the naming note above.
- **Symptom of a deeper design flaw?** Not a new one. Eleven of the fourteen are
  the same shape as phase 2b's answer, one level down: **no layer declared the
  design's own constants, so every rule re-derived them.** Four card paddings,
  ten type sizes, three segment heights, two explanation surfaces and two value
  rails existed because each was chosen at its own call site by whoever wrote it
  — ARCH-010's rule applied to visual facts rather than data facts. The new
  suite is the mitigation available today (it MEASURES the constants and fails
  when a second answer appears), not the fix; the fix would be declaring the
  scale once in tokens and forbidding a literal. Worth an ARCH ticket only if a
  third surface in this codebase starts re-deriving them.

### 2026-09-19 — round 5: the clean-room round's named could-not-test, closed
_Dispatch: ticket=FEAT-146 phase=verifying round=2 class=verify. Owned
`scripts/verify-feat-146-settings-content.mjs` and its fixtures,
`public/lib/drawer.js` + `public/styles.css` (for the rail fades only), and
this ticket. No source file outside those was touched; `docs/bugs/INDEX.md`
was not edited._

- **Understood:** the independent verifier could not rule out ONE class of
  defect — "completeness was only ever tested on non-git, snapshot-less
  projects … a control dropped only in those shapes could not be ruled out."
  That is the whole job: build the shapes nothing had ever painted and assert
  what each of them makes reachable.

- **Changed** (all unstaged):
  - `scripts/verify-feat-146-settings-content.mjs` — **69 → 139 assertions**.
    New section 8 (SHAPE completeness, nine shapes), section 9 (a live session
    under both lenses), section 10 (the scroll-aware rail fades), section 12 (a
    second must-FAIL, for the shape sweep). The old section 8 must-FAIL is
    section 11, unchanged in substance; its one-off `Fetch` handler became a
    shared override list because two sections now intercept and two handlers
    would both answer the same `requestId`.
  - `public/lib/drawer.js` — `updateRailEdges()` writes the strip's real scroll
    position once onto `data-edge`; called from `revealSelectedCat`, `markRail`,
    a passive `scroll` listener and a `resize` listener (both registered ONCE on
    the persistent nodes, never inside `buildRail`, which runs on every open).
  - `public/styles.css` — the `<860px` rail's mask is driven by `--fade-s` /
    `--fade-e`, set from `[data-edge~="start"]` / `[data-edge~="end"]`. A 0px
    stop is a hard edge, so the mask is always declared and never toggled off.

- **The nine shapes, each a COMPLETE two-directional statement.** Every probe
  is either assigned a category (present there, in exactly one category) or
  implicitly forbidden (absent from all eleven) — a shape may not stay silent
  about a control, which is exactly how the shape-gated ones went unmeasured.
  Shape-independent rows are asserted on every shape; the gated ones
  (`container.image`/`memoryMb`, `snapshots.keep`/`exclude`) only where the
  shape earns them.
  - a REAL git repository with a remote and an upstream and a dirty file →
    status line (`main · 1 dirty file · tracks origin/main`, `last: f7ed94a
    fixture commit`), `Review and stage 1 changed file`, `Push…`,
    `Pull (ff-only)`, `Refresh`, the kitty terminal link;
  - a repo with NO remote → `Open Git workbench`, `Create GitHub repo…`,
    `Refresh`, terminal, and NOT Push/Pull;
  - not a repo at all → `git init`, terminal, the "Not a git repository" note,
    and none of the six above;
  - `isolation: 'sandbox'` → the Sandbox tier selected and its "confined to the
    project directory" note, with the Access card, mounts, socket, Services and
    both container flags correctly UNREACHABLE;
  - a container with NEITHER mounts nor services → Access, `+ Add mount`, the
    socket switch, Services, "No service sidecars", `+ Add service`;
  - a container WITH a mount and a service → the same plus the mount row and the
    service row, and the empty state gone;
  - snapshots PRESENT (two real ones, taken through `POST /snapshots`) → the
    rows, per-row Restore and delete, `+ Take one now`, and no empty state;
  - snapshots present AND both failure channels → `failureNote()` and a failed
    row, plus `liveFailureNote()`'s "This session has no restore point";
  - only the DEFAULT Claude account → the read-only account row
    (`--settings › claudeAccount`) and `Accounts on this machine ›` in Model &
    spend, the machine-level "Only the default account" note in Accounts, and
    NO `#pAccountSel` / `#gAccountSel` anywhere. **This shape had no coverage at
    all: every prior fixture seeded two accounts, so the one-account branch —
    a different control, not a disabled version of the same one — had never
    been on screen.**

- **NO control was found dropped.** Every shape-gated control the pre-redesign
  code could build is reachable, in one category, writing the same key. The
  re-home did not lose anything on any shape.

- **TWO REAL FIXTURE DEFECTS the new assertions found** (both in test fixtures,
  neither a product defect — stated because they are why the gap persisted):
  - the container fixture's mount had been aimed at `/workspace`, which the
    server refuses to mount over (`mounts[0]: refusing to mount over
    /workspace`). A refused mount takes the WHOLE PATCH with it, and the
    isolation in that same PATCH only "worked" because
    `NEW_PROJECT_DEFAULT_ISOLATION` is already `container` — so the fixture had
    silently never rendered a mount ROW, in this suite or any other. Re-aimed at
    `/mnt/extra`, and the precondition now reads the mount and service back from
    the server rather than assuming the PATCH landed;
  - a `settings` PATCH carrying one invalid key rejects every key beside it, so
    the services patch had to be verified rather than fired.

- **Verified — real output, not a claim:**
  `node scripts/verify-feat-146-settings-content.mjs` → **PASS, 139 passed, 0
  failed, exit 0** (was 69/69). Anti-regression, all re-run after the drawer.js
  and styles.css edits: `-shell.mjs` → **115/115**, `-rows.mjs` → **59/59**,
  `-polish.mjs` → **81/81**, `node scripts/verify-bug-101-contrast.mjs` → **ALL
  PASS** (all three sections). `npm run typecheck` clean; `npm run gate`
  **PASS** (leak-gate 0 hits / 1117 files, check-nul, typecheck).
  - the git fixtures are built with real `git` confined to the suite's own
    scratch dir, an obviously-synthetic identity and a detached global/system
    config; the "remote" is an `example.invalid` URL and the upstream is set
    with `update-ref`, so **nothing is pushed and no network is reachable**. The
    prior lane's git-write refusal did not reproduce here; the fixture builder
    reports a refusal LOUDLY as a failed PRECONDITION rather than skipping the
    shape, so the git shapes can never quietly go untested.
  - `failureNote()` is the one path that could not be driven from real server
    state: `toSummary()` has no failure fields, so the server never emits a
    `failures` array today. `api.js` explicitly reads one, so it is INJECTED
    over CDP onto the REAL list body — a contract-shaped stub, named as such,
    not an invented response. `liveFailureNote()` is driven by the session's own
    start-snapshot report, which is real server shape.

- **MUST-FAIL, the new one (section 12), two constructed variants served over
  CDP `Fetch` interception:** dropping `gitGroup(p)` from `workspacePane` makes
  the git-repo shape go red and NAME all six controls only that shape could have
  shown (`git.status | git.review | git.push | git.pull | git.refresh |
  git.terminal`); dropping `servicesGroup(…)` from `isolationPane` names the
  three services controls. Section 11's original must-FAIL still reproduces.
  Anchored to constructed variants, never to a revision.

- **The rail's edge fades are scroll-aware now** (round 4's one open polish
  item). The 24px mask used to render at BOTH ends even at `scrollLeft: 0`,
  dimming the first category to promise content that was not there. Measured at
  800px and 500px, three positions each:
  - `scrollLeft 0` → `edge="end"`, `--fade-s: 0px`, `--fade-e: 24px`;
  - mid-scroll (279/558 and 412/824) → `edge="start end"`, `24px` / `24px`;
  - fully scrolled (558/558, 824/824) → `edge="start"`, `24px` / `0px`;
  - the mask is declared in every state (the fade is its stop positions, not an
    on/off), the strip genuinely overflows at both widths, and at desktop width
    the vertical rail reports `edge="none"` so a stale `start end` cannot
    outlive the layout that produced it.
  Looked at, not only asserted: `feat146b-rail-scroll-start.png` shows
  "Model & spend" fully solid with only the right end faded;
  `feat146b-rail-scroll-mid.png` shows both ends faded. The polish suite's own
  "the strip carries edge fades" assertion is still green.

- **A live session, under both lenses:** with no session the live-state line is
  silent under BOTH lenses (silence, never a reassuring blank); with one, the
  SESSION lens names the overridden fields, is visible, and renders in the PANE
  (`#dBody`, not `.sfoot` — round 4 moved it), while the PROJECT lens says
  nothing; and the live session removes no row (Model and Effort are both still
  offered under the session lens).

- **Could not test:**
  - **the cross-provider re-run** — this lane is anthropic, the same provider as
    the authors and as the clean-room round. The OpenAI quota window reopens at
    13:37; re-running `scripts/independent-verify.mjs --provider openai` after
    it is still the outstanding item, and is why the Status says IN VERIFICATION
    rather than VERIFIED.
  - the container RUNTIME state row and the Isolation dot's `live` branch — no
    Docker in the harness, the same gap every phase has reported. The container
    SETTINGS shapes (mounts, services, socket, image, memory) are all covered;
    what is not is a running container's state row.
  - a real OAuth handshake against claude.com (the `claude` leaf is stubbed).
  - `failureNote()` against a server that really emits `failures` — no such
    server exists yet (see above).
  - touch gestures, a screen reader, and `prefers-reduced-motion`, as in every
    prior round. The rail fades were measured as computed values and looked at
    in two screenshots; no pointer-drag scroll was dispatched (the scroll
    listener fires for any scroll source, but that is inference).

- **Still open / handoff:**
  - the cross-provider independent re-run, above — the only thing between this
    ticket and VERIFIED.
  - the shape probe list (`SHAPE_PROBES`) is where a future shape-gated control
    belongs: adding a control that only some projects can reach without naming
    it there means no shape asserts it, which is precisely the hole this round
    closed.
  - the suite now takes ~9 minutes (nine full 11-category sweeps plus two
    must-FAIL sweeps). That is the price of measuring shapes rather than one
    shape; if it becomes a problem, sweep fewer categories per shape and lose
    the "in EXACTLY one category" half of the statement — that trade should be
    made deliberately, not by accident.
  - round 4's declined row-density control stays declined, as decided.
- **Symptom of a deeper design flaw?** Not a new one — the same answer phase 2b
  and round 4 gave, one level further out. Nothing declared WHICH PROJECT SHAPES
  a control belongs to, so every fixture author picked a shape and every reader
  assumed it was representative; the shape table in this suite is the mitigation
  available today (it states the fact once and fails loudly when a shape stops
  matching), not the fix.
