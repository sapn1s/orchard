# FEAT-034 — Project settings UX revamp: categorize + conditional disclosure

- **Status:** VERIFIED
- **Area:** claude-station UI (settings drawer)
- **Reported:** 2026-08-04 by user
- **Skill:** use `frontend-design` when building.

## Problem
The project/session settings are one long flat list — hard to manage — and it shows
settings that DON'T APPLY in the current mode (e.g. **mounts / docker-socket only
matter when isolation = container**, yet they're always shown). Needs grouping +
conditional disclosure.

## Design direction
- **Group into themed sections** (collapsible cards / tabs), e.g.:
  - **Model & behaviour:** model, effort, permission mode, spend cap, allowed/disallowed tools.
  - **Isolation & environment:** isolation tier (direct / container / [sandbox]) — and
    **container-only** settings (mounts, docker-socket opt-in, container env) that appear
    ONLY when isolation = container.
  - **Instructions & tools:** working-agreement templates, attachable MCPs (browser, Serena).
  - Keep the existing **Project-default vs This-session** scope toggle.
- **Conditional disclosure (the core ask):** hide/disable settings that don't apply in the
  current mode — container-only settings gated on isolation=container; don't render dead options.
- **Progressive disclosure:** advanced/rare settings collapsed by default; common ones up top.
- **Design language:** greyscale + single moss accent, hairlines, the existing `.grp`/`.grp-l`
  card idiom — no new colors. Keep it scannable, not a wall.

## Approach for the building agent
- FIRST survey the CURRENT settings surface (use Serena: `get_symbols_overview` /
  `find_symbol` on `public/lib/drawer.js` + the settings render in `public/app.js`) to
  enumerate every setting + how container-vs-direct is currently branched.
- Then regroup + gate. Preserve all existing functionality + persistence (don't drop settings).

## Verification (REQUIRED, §C user-observable)
Real browser: with isolation=direct, container-only settings (mounts) are NOT shown;
switching to isolation=container reveals them; groups collapse/expand; every setting still
persists (project-default AND this-session scope). Prefer a Playwright `.spec.ts` (once the
FEAT-032 harness lands) asserting the role/name of shown-vs-hidden groups. verify:ui offline + typecheck.

## Context pack
- Touches: `public/lib/drawer.js` (settings render/grouping) + `public/app.js` (wiring) +
  `public/styles.css`. Serialize with other FE tickets (after FEAT-031).

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed from user. Core asks: category grouping + conditional disclosure (container-only
  settings gated). Queue behind FEAT-031; build with frontend-design skill; verify user-observable.

### 2026-08-04 — building agent (FEAT-031 shipped, unblocked)
**Understood:** `public/lib/drawer.js`'s `settingsView()` (was lines 240–369) built one flat
run of `.grp` cards in a fixed order: Runtime (isolation seg + `containerBlock` — already
correctly gated on `iso === 'container'`), Snapshots, Memories, Git, Processes, **Access**
(mounts list/add-form + `dockerSocketBlock` — NOT gated, always rendered regardless of
isolation), Integrations (browser), Model, Permissions, Instructions summary. Surveyed with
Serena `get_symbols_overview` + `find_symbol(depth:1)` on `createDrawer` — enumerated all ~20
helper functions/rows before touching anything (no ast-grep/rg fallback needed, Serena's MCP
tools worked directly). Confirmed the real gap the ticket names: `PROJECT_ONLY = new
Set(['isolation','mounts','container'])` (validate.ts) rejects `mounts`/`container.*` server-side
outside a container, yet the old Access card rendered unconditionally — the exact "dead
option" the ticket flags. `containerBlock` itself was already correctly conditional; only
Access (mounts + docker-socket) was the actual bug.

**Changed:**
- `public/lib/drawer.js`: added a `section(id, label, opened, kids)` helper — a native
  `<details class="sect">`/`<summary class="sect-l">` wrapper (expand/collapse and a11y come
  free from the platform; `d.sectClosed: Set` remembers a user's manual close across repaints
  only, not reload). Rebuilt `settingsView()` into four sections: **Model & behaviour** (Model,
  Permissions grps, open by default), **Isolation & environment** (Isolation/Runtime grp,
  **Access grp now gated: `if (isContainer) access = el(...)` else `access = null`**,
  Snapshots grp — all open by default), **Instructions & tools** (Instructions summary,
  Integrations/browser grps, open by default), **Advanced** (Memories, Git, Processes grps,
  **closed by default** — the progressive-disclosure ask). All existing fields, rows, cycle
  logic, `put()`/session-override plumbing, and scope toggle were left untouched — only
  regrouped and the Access gate added.
- `public/styles.css`: new `.sect`/`.sect-l`/`.sect-car` rules matching the existing `.grp`/
  `.grp-l` idiom exactly — greyscale, hairline `::after` rule, uppercase tracked label, a CSS
  chevron (no image asset) that rotates on `[open]`. No new colours; moss (`--live`) untouched
  — reserved for "alive", not reused for a section label per the palette rule already documented
  in the stylesheet.
- `scripts/qa/settings-sections.spec.ts` (new): Playwright spec, scratch server on a free port
  (never :4317), reused Brave via `playwright.config.ts`. Asserts: (a) exactly 4 sections in the
  right order/labels; Model & Isolation open, Advanced closed by default; Advanced's hidden
  content (`Running here` grp) present-but-`toBeHidden`, then visible after clicking the
  summary, hidden again after a second click; (b) **the core ask** — `#vSettings .grp-l:has-text
  Access` has count 0 in direct isolation, `+ Add mount` / docker-socket toggle absent from the
  DOM (scoped to `#vSettings` — app.js has an unrelated `+ Add mount` button in the
  new-project form, first draft's `page.getByRole` without that scope was a false positive,
  caught and fixed before landing); switching isolation to Container makes Access appear,
  switching back to Direct removes it again; (c) persistence — a project-default Model change
  survives `page.reload()`, a this-session Effort override survives toggling the scope buttons
  project→session→project→session without a reload (proves the in-memory `ctx.overrides` path
  wasn't broken by the refactor).

**Verified:**
- `npx playwright test scripts/qa/settings-sections.spec.ts` → **PASS** (1 passed).
- Regression-proved the spec against the PRE-fix code: `git stash push -- public/lib/drawer.js
  public/styles.css` then re-ran → **FAILS** as required (0 `.sect` elements found — confirms
  the test is not a vacuous pass) → `git stash pop` to restore.
- `npx playwright test` (full `qa:sweep`, both specs incl. FEAT-032/033's
  `reload-preserves-work.spec.ts`) → **PASS** (2 passed) — no regression on the other FE-owned
  journey.
- `npm run typecheck` → **PASS** (drawer.js/styles.css aren't in `tsconfig.json`'s `include`,
  so this only re-confirms the new `.spec.ts` itself typechecks clean).
- `npm run verify:ui -- --offline` → **PASS** (3 passed: boot, real sessions+transcript render;
  live turn skipped per `--offline`).
- Screenshots: `docs/bugs/assets/FEAT-034-after.png` (direct isolation, Model & behaviour +
  Isolation & environment sections open, an overridden Effort badge visible from the this-session
  scope check, Access correctly absent) and `docs/bugs/assets/FEAT-034-container.png` (isolation
  switched to Container — the Access section with the container image/memory-cap rows now
  visible below the fold, confirming the gate opens the right direction too).

**Status → VERIFIED.** All existing settings preserved (same fields, same `put()`/override
plumbing, same scope toggle); nothing dropped, only regrouped + gated. No open items.
