# FEAT-077 — templates management remake: comprehensible descriptions + clear grouping (WA base+living vs opt-in patterns)

- **Status:** DONE (2026-08-13 — §1 descriptions + §2 grouping + §3 usage/provenance all landed. Client assets (drawer.js/styles.css) reach users on reload; the `attachedCount` API field needs a :4317 restart to serve. Descriptions already refreshed on the live data-dir files with no restart.) — see 2026-08-13 worker log
- **Area:** src/server/templates.ts (`seedTemplates` descriptions) + the templates UI (public/lib — where `listTemplates` renders) + a small usage-count read
- **Reported:** 2026-08-13 by user

## Problem
The templates list is a flat wall of jargon that a human can't quickly parse: 6 entries with
abstract one-line descriptions and no signal of what's core vs optional, what's used, or where it came
from. User reaction on seeing "Pattern: Go/No-go Pre-flight Gate — Opt-in. A numbered eligibility
checklist that must fully pass before work starts…" was confusion about what it is, who made it, and
when they'd ever use it. Assessment (orchestrator, after reading all bodies):
- The 4 `pattern-*` templates are **genuinely good, universal patterns** (read-through from the
  methodology repo `docs/prompts/patterns/`), NOT junk or tests — but **niche** (attached to 0
  projects) and **badly described**.
- `working-agreement` (v1) and `working-agreement-v2` are **NOT duplicates**: v2 says "v1 is the
  stable base: read it first … Everything in v1, plus". v1 is the base, v2 the living extension. They
  must read as ONE Working-Agreement unit, not two competing entries. **Do not retire v1.**

## Wanted
Make the templates section comprehensible at a glance.

### 1. Rewrite the 4 pattern descriptions — benefit-first, human-readable (in `seedTemplates()` so fresh installs get them, AND refresh the already-seeded data-dir files whose frontmatter `description:` won't be re-seeded since seedTemplates skips existing files)
- **pattern-go-no-go-preflight** → "A short yes/no checklist an agent must fully pass before it
  starts — any failed item stops it cold. Use when starting in the wrong state (wrong branch, a job
  already done, a resource still in use) is costly to unwind and the things to check are a clear
  finite list."
- **pattern-index-table-router** → "Keep a growing pile of docs manageable: the root file is just a
  table of links to per-topic files, so it never bloats and readers load only the topic they need.
  Use when notes/playbooks keep piling up and one flat doc would get too big to read."
- **pattern-manager-subagent-tree** → "For big jobs that split into a few distinct areas (security,
  performance, docs…): put one manager agent over each area, let it run its own helpers, and the top
  orchestrator reads only each manager's summary. Use when the work has several domains too complex to
  fan out flat."
- **pattern-raw-curated-memory-split** → "Keep two notes per topic: an append-only raw log of
  everything as it happens, plus a short summary you rewrite as understanding changes. Readers use the
  summary; the raw log is insurance if the summary is ever wrong. Use when observations pile up faster
  than you can digest them."

### 2. Group the list (UI)
- A **"Working Agreement"** section presenting v1+v2 as ONE unit (base + living extension), not two
  peers. Make clear v2 builds on v1.
- A separate, collapsible **"Patterns (opt-in)"** section for the 4 pattern-* — so niche add-ons stop
  competing with the core.

### 3. Signal (UI) — secondary, nice-to-have
- **"attached to N projects"** per template (small read over the registry: count projects whose
  `settings.instructions` include that templateId). Makes unused ones obvious (patterns show 0).
- Surface each template's **`source:`** provenance (e.g. "from docs/prompts/patterns/…") so a user
  knows it came from the methodology repo, not nowhere.

## Non-goals / decided
- **WA stays opt-in, switched on by onboarding** (decided from content analysis — ~15% of the WA
  presupposes the dispatch CLI / board / provider fleet a bare project lacks; onboarding installs
  that machinery). This ticket does NOT make the WA a forced universal baseline. See FEAT-076 (Wiring
  panel already surfaces WA state) — no change to injection semantics here.
- **Do not retire v1.** It is the base v2 extends.
- Priority: the description rewrites + grouping (§1,§2) are the core user value; usage-count +
  provenance (§3) are enhancements — land them if cheap, don't let them block §1/§2.

## Verification (§C)
- The description rewrite is verifiable: `seedTemplates()` output for each pattern id carries the new
  text; and the live data-dir files' frontmatter `description:` is refreshed (assert the OLD jargon
  string is GONE and the NEW human string present for all 4). Must-FAIL: assert the new strings before
  editing → fails.
- UI: drive the real templates render (happy-dom / headless) — assert the two groups exist, patterns
  collapsed, and (if built) the usage count reads 0 for an unattached pattern and ≥1 for an attached
  template (fixture: a project attaching working-agreement-v2).
- Anti-regressions: verify:pattern-templates, verify:template-readthrough, verify:routing-inject,
  verify:local-conventions, verify:ui, typecheck, leak-gate. (The read-through of pattern BODIES must
  be unchanged — only descriptions/UI change.)
- **Risk bucket:** UI + seed-data copy edits. Self-verify sufficient (not security/lifecycle/data-loss).

## Activity log (APPEND-ONLY)
### 2026-08-13 — orchestrator
- Filed from user request after reading the WA (product-agnostic, ~85% universal but ~15% assumes
  orchestration infra → WA stays opt-in-via-onboarding) and all 4 pattern bodies (good universal
  patterns, just niche + badly described). Descriptions are seed-defined in `seedTemplates()`
  (templates.ts) AND persisted in already-seeded data-dir files (seedTemplates skips existing) → both
  must be updated. v1 is the base v2 extends → not retired. FEAT-076 (Wiring) already committed; no
  concurrent same-file writer, single lane.

### 2026-08-13 — worker (implementation)
Hypothesis CONFIRMED before editing: the 4 pattern descriptions lived in BOTH
`seedTemplates()` (templates.ts) AND the already-seeded data-dir files
(`~/.local/share/claude-station/templates/pattern-*.md` frontmatter
`description:`), which seedTemplates skips on existing files. The live UI reads
descriptions from those data-dir files via `readTemplate()` → `/api/templates`,
so both sources had to change. No third source.

Fix map:
- `src/server/templates.ts` — `seedTemplates()`: rewrote all 4 pattern
  descriptions to the exact ticket strings (fresh installs). Injection semantics
  and body read-through untouched.
- `~/.local/share/claude-station/templates/pattern-*.md` (4 files, data dir, NOT
  in git) — refreshed the frontmatter `description:` line in place (the live
  instance shows the new copy with no re-seed / no restart). Only the description
  line changed; name/mode/living/source/body left intact.
- `public/lib/drawer.js` — `libraryView()` rewritten: extracted `templateRow()`;
  three groups now — "Working Agreement" (v1 base + v2 living, one unit, base
  first, note says v2 builds on v1; v1 NOT retired), a COLLAPSED "Patterns
  (opt-in) · N" `<details>` section for the 4 `pattern-*`, and "Your templates"
  for user-created ones. Each row surfaces "attached to N projects" and, when
  present, `from <source>` provenance.
- `src/server/index.ts` — GET `/api/templates` now adds `attachedCount` per
  template (count of registered projects whose `settings.instructions` reference
  that id; enabled-or-not). Pure read over the registry; no injection change.
- `public/styles.css` — `.lrow .src` (provenance) + `.lrow .use` display tweaks.

### 2026-08-13 — orchestrator (follow-up, UX polish)
- User reported the Patterns section content sat flush-left with no inset (looked bad). Cause: the
  `<details>` section appended its intro + rows DIRECTLY, unlike the WA/Other groups which wrap rows
  in a `.grp` card (`padding: 12px 15px; margin: 0 12px`). Fix (public/lib/drawer.js `libraryView`):
  wrap the patterns intro + rows in a `.grp` card like its siblings; `.sect .grp:first-of-type`
  zeroes its top margin so it tucks under the summary. Client-only (reaches users on reload).
  Verified: node --check OK, typecheck clean, verify:ui 3/3, leak-gate PASS. Trivial visual fix,
  structural parity with the working WA group — self-verified.
- `package.json` + `scripts/verify-feat-077.mjs` — new suite (`verify:feat-077`).

Verification (`node scripts/verify-feat-077.mjs`): **30/30 PASS**.
- Must-FAIL proof: run BEFORE refreshing the data-dir files → Section B failed
  8/8 (old "Opt-in. A numbered eligibility…" jargon still on disk) while Sections
  A (seed source) + C (UI) already passed. After the in-place refresh → 30/30.
  Section A asserts each seed description === the new string and the old fragment
  / "Opt-in." prefix is gone; Section B asserts the same over the live default
  data-dir files; Section C drives real `public/app.js` in happy-dom over a real
  server + busy fixture (a project attaching WA-v2, plus a user template): clicks
  `#libBtn`, asserts the WA group holds v1+v2, the Patterns `<details>` exists and
  is `open === false` (collapsed) with 4 rows, the "Your templates" group, WA-v2
  row "attached to 1 project", an unattached pattern "attached to 0 projects",
  pattern provenance `from docs/prompts/patterns/…`, and the new human
  description (old jargon gone).
- Anti-regressions: `verify:pattern-templates` 34/34, `verify:template-readthrough`
  18/18, `verify:routing-inject` 18/18, `verify:local-conventions` 18/18,
  `verify:ui --offline` 3/3, `typecheck` clean, `leak-gate` PASS (0 hits, 393
  git-tracked files). Body read-through UNCHANGED (template-readthrough green).
- Risk bucket: UI + seed-data copy edits (per ticket §C: self-verify sufficient,
  not security/lifecycle/data-loss). No independent clean-room pass required.
- Deploy note: drawer.js/styles.css are static client assets → reach users on a
  browser reload, no restart. The `attachedCount` field on `/api/templates` is
  server-side → needs a :4317 restart to appear (until then the UI shows "attached
  to 0 projects" for every row — graceful `?? 0` fallback, no error). The 4
  pattern description edits are already live on disk (read fresh per request), so
  the corrected copy shows on the next drawer open with no restart.
