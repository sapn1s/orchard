```orchard-ticket
{
  "id": "FEAT-077",
  "type": "feature",
  "title": "Templates list read as a wall of jargon",
  "summary": "The templates list now reads as two labelled groups: the Working Agreement as one unit with its living extension, and an opt-in patterns group that collapses out of the way. The four pattern entries carry plain-language descriptions saying what each is for, and each template shows how many projects use it and where it came from.",
  "impact_if_we_wait": "People could not tell core templates from optional add-ons, or judge what any of them were for. Bounded: this was presentation of an existing list, not template content, injection behaviour, or any stored project setting.",
  "current_need": "Restart the service on :4317 so the per-template project count is served; the refreshed descriptions and the grouped list are already live.",
  "severity": "medium",
  "area": "Templates list",
  "reported": "2026-08-13",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-08-13",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-13",
      "question": "Should the older Working Agreement entry be retired as a duplicate of the newer one?",
      "mode": "single",
      "options_keys": [
        "A",
        "B"
      ],
      "chosen": "B",
      "chosen_on": "2026-08-13",
      "chosen_by": "user",
      "note": "Kept both. The first version is the stable base and the second explicitly extends it, so they are presented as one unit rather than two competing entries."
    },
    {
      "asked_on": "2026-08-13",
      "question": "Should the Working Agreement become a forced baseline for every project?",
      "mode": "single",
      "options_keys": [
        "A",
        "B"
      ],
      "chosen": "A",
      "chosen_on": "2026-08-13",
      "chosen_by": "user",
      "note": "It stays opt-in, switched on during onboarding, because a large part of it assumes tooling a bare project does not have. Injection behaviour was left unchanged."
    }
  ],
  "success_criteria": [
    "Each pattern template's seeded description carries the new plain-language text",
    "Already-seeded files in the data directory no longer carry the old jargon description",
    "The rendered list shows a Working Agreement group and a separate collapsed patterns group",
    "An unattached pattern reads as used by zero projects and an attached template reads as one or more",
    "Pattern template bodies are unchanged; only descriptions and presentation change"
  ],
  "code_refs": [
    {
      "path": "src/server/templates.ts",
      "symbol": "seedTemplates",
      "note": "carries the pattern descriptions; skips files that already exist, so seeded copies in the data directory had to be refreshed separately"
    },
    {
      "path": "src/server/templates.ts",
      "symbol": "listTemplates",
      "note": "source of the rendered list; extended with a per-template attached-project count"
    },
    {
      "path": "public/lib/drawer.js",
      "symbol": null,
      "note": "renders the two groups; reaches users on reload without a restart"
    },
    {
      "path": "public/lib/styles.css",
      "symbol": null,
      "note": "group and collapse styling"
    }
  ],
  "related": [
    {
      "id": "FEAT-076",
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
    "archived_path": "docs/bugs/archive/FEAT-077-templates-management-remake.md",
    "sha256": "52d62b69c148c76e2dafe3568a35f07af75edf7f0c4ca7e34113187888a8962b",
    "bytes": 10619,
    "original_title": "templates management remake: comprehensible descriptions + clear grouping (WA base+living vs opt-in patterns)",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared field by field against the original head: the three numbered goals, the do-not-retire and opt-in decisions, the priority ordering and the full verification bar are all present.",
    "dropped": [
      "the verbatim four replacement description strings, which live in the seeded files themselves",
      "the quoted old description fragment used as the user's illustration of the confusion"
    ]
  }
}
```

# FEAT-077 — Templates list read as a wall of jargon

## Diagnosis

### What made the list unreadable

Six entries sat flat and undifferentiated. The four `pattern-*` templates are genuine, universal patterns read through from the methodology repo's `docs/prompts/patterns/`, but they are niche — attached to zero projects — and their one-line descriptions were abstract enough that a reader could not tell what any of them was for, who wrote it, or when it would apply.

`working-agreement` and `working-agreement-v2` are not duplicates. The second one states that the first is the stable base to read first, and that it contains everything in the base plus more. Rendered as two peers, they read as competing choices.

## Evidence

### What ran

A must-FAIL check asserted the new description strings before any edit and failed, then passed after. FEAT-077's own suite ran 30/30, and the standing anti-regression set stayed green: pattern-templates 34/34, template-readthrough 18/18, routing-inject 18/18, local-conventions 18/18, and the UI suite 3/3, plus a further 8/8 tally. Typecheck and the leak gate were clean. A clean-room pass over the work is described in the ticket's own record.

## Implementation notes

### Where the work landed

Descriptions were rewritten in the seeding path so fresh installs get them, and the already-seeded copies in the data directory were refreshed in place, since seeding skips files that already exist. Those refreshed descriptions were live immediately with no restart.

The list gained a Working Agreement group presenting base and living extension as one unit, and a separate collapsible opt-in patterns group. Each template shows a count of projects whose instruction settings include it, and its stated provenance.

The descriptions and grouping were treated as the core value; the count and provenance were to land only if cheap, and did.

## Verification plan

### The bar that was set

Assert the seeded output for each pattern carries the new text, and that the old jargon string is gone from all four live files while the new text is present. Drive the real templates render headlessly and assert both groups exist with patterns collapsed, that an unattached pattern reads zero, and that a template attached by a fixture project reads at least one. Re-run the standing suites, with pattern bodies unchanged.

## Risks

### Bounds on the change

This was interface copy and presentation over seed data, not a security, lifecycle or data-loss surface, so self-verification was judged sufficient.

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
