```orchard-ticket
{
  "id": "FEAT-034",
  "type": "feature",
  "title": "Settings list showed options that did not apply",
  "summary": "The project and session settings were one flat list that also displayed options with no effect in the current mode, such as container-only mounts while running directly. Settings are now grouped into themed sections, with container-only options appearing only under container isolation. Both project-default and this-session scopes still persist.",
  "impact_if_we_wait": "People scan a long list and change options that do nothing, then wonder why nothing happened. Bounded: this is a settings presentation problem, not a loss of settings or of stored values.",
  "current_need": "Nothing is outstanding. The grouped and gated drawer was built and checked in a real browser, and standing type checks stayed clean.",
  "severity": "medium",
  "area": "Project settings drawer",
  "reported": "2026-08-04",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-04",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Container-only settings are hidden while isolation is direct",
    "Switching isolation to container reveals the container-only settings",
    "Groups collapse and expand",
    "Every setting still persists in project-default scope",
    "Every setting still persists in this-session scope"
  ],
  "code_refs": [
    {
      "path": "public/lib/drawer.js",
      "symbol": null,
      "note": "settings render and grouping"
    },
    {
      "path": "public/app.js",
      "symbol": null,
      "note": "settings wiring"
    },
    {
      "path": "public/styles.css",
      "symbol": null,
      "note": "existing card idiom reused, no new colors"
    }
  ],
  "related": [
    {
      "id": "FEAT-031",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-032",
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
    "archived_path": "docs/bugs/archive/FEAT-034-settings-ux-revamp.md",
    "sha256": "17b92f2b30107479c909429986f808bd41b9ca610f6108410fc15be2d93f4596",
    "bytes": 7909,
    "original_title": "Project settings UX revamp: categorize + conditional disclosure",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head: the flat-list and inapplicable-option complaint, the three groups, the container gating, the design language, the survey-first instruction and the browser bar are all present.",
    "dropped": [
      "the skill pointer naming which design skill to use when building",
      "the serialization note about ordering this after other frontend tickets, kept as a dependency instead"
    ]
  }
}
```

# FEAT-034 — Settings list showed options that did not apply

## Diagnosis

The settings surface rendered every option unconditionally in a single flat list. Mounts, docker-socket opt-in and container environment only take effect when isolation is set to container, but nothing branched on the isolation tier, so those controls were always drawn.

## Evidence

The original ticket names mounts and docker-socket as the concrete case: always shown, effective only under container isolation. The build was checked in a real browser against the shown-versus-hidden behaviour, and typecheck reported clean.

## Implementation notes

### Grouping
Themed sections, collapsible: Model & behaviour (model, effort, permission mode, spend cap, allowed and disallowed tools); Isolation & environment (isolation tier plus the container-only mounts, docker-socket opt-in and container env); Instructions & tools (working-agreement templates, attachable MCPs for browser and Serena). The existing project-default versus this-session scope toggle is preserved.

### Disclosure
Container-only settings are gated on isolation being container rather than disabled in place; dead options are not rendered. Advanced or rare settings start collapsed, common ones sit at the top.

### Design language
Greyscale with a single moss accent, hairlines, and the existing card idiom. No new colors.

### Survey first
The building agent was directed to enumerate the current settings surface and its container-versus-direct branching before regrouping, so no setting or its persistence was dropped.

## Verification plan

In a real browser: with isolation set to direct, confirm mounts and the other container-only settings are absent; switch to container and confirm they appear; collapse and expand each group; change every setting and confirm it persists in both the project-default and this-session scopes. A Playwright spec asserting the role and name of shown-versus-hidden groups was preferred once the harness from the related test-harness ticket landed. verify:ui offline was named as the suite to run alongside typecheck.

## Risks

Regrouping a flat list risks silently dropping a setting or its persistence, which is why the survey-first step and the both-scopes persistence check are part of the bar.

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
