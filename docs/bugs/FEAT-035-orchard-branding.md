```orchard-ticket
{
  "id": "FEAT-035",
  "type": "feature",
  "title": "Dashboard had no visual identity after the product rename",
  "summary": "The dashboard now carries an Orchard identity: a grafted-sapling mark, a matching favicon, and a wordmark in the header and page title. Before this, the product had been renamed but still showed a generic placeholder mark. The interface text rename was deliberately left to a separate ticket.",
  "impact_if_we_wait": "The product would keep presenting an unrelated placeholder mark under its new name, which reads as unfinished. Bounded: this is presentation only, with no effect on session data, behaviour, or anything a person can do in the dashboard.",
  "current_need": "Nothing is outstanding. The mark, favicon and wordmark shipped, the interface suite passed all three of its cases, and standing checks stayed clean.",
  "severity": "low",
  "area": "Dashboard brand identity",
  "reported": "2026-08-04",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-08-04",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A distinctive Orchard mark replaces the placeholder favicon",
    "The mark and wordmark appear in the dashboard header and page title",
    "Greyscale plus the single existing moss accent, with no new colours introduced",
    "The header and favicon render correctly in a captured screenshot",
    "The interface suite and standing type checks pass"
  ],
  "code_refs": [
    {
      "path": "public/favicon.svg",
      "symbol": null,
      "note": "replaced the dark-window-and-dot placeholder mark"
    },
    {
      "path": "public/index.html",
      "symbol": null,
      "note": "mark, wordmark and page title"
    },
    {
      "path": "public/styles.css",
      "symbol": null,
      "note": "mark and wordmark styling against the existing palette"
    },
    {
      "path": "public/app.js",
      "symbol": null,
      "note": "deliberately untouched — owned by a concurrent worker; a script-side render would have been handed off instead"
    }
  ],
  "related": [
    {
      "id": "FEAT-036",
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
    "archived_path": "docs/bugs/archive/FEAT-035-orchard-branding.md",
    "sha256": "1d2807426a659214be03e028bc4e5a262cdafb97ed0f299286424ec92b29997b",
    "bytes": 4025,
    "original_title": "Orchard branding: logo / favicon / wordmark + tasteful dashboard UX touches (Fable-designed)",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head: the goal, the greyscale-plus-one-accent fences, the three deliverables, the app.js prohibition and the FEAT-036 split are all present.",
    "dropped": [
      "the framing instruction that the designing agent is 'the ARTIST' and should express freely, which restates the design fences already recorded"
    ]
  }
}
```

# FEAT-035 — Dashboard had no visual identity after the product rename

## Diagnosis

### Why the work existed

The product was renamed to Orchard, but the dashboard still shipped the previous dark-window-plus-dot favicon and carried no mark or wordmark of its own. The task was design work rather than a defect: give the interface an intentional identity coherent with the existing visual system.

## Evidence

The interface suite ran offline and passed 3/3. Standing checks reported clean, including the type check. A screenshot of the header and favicon was captured as part of the acceptance for the rendered result.

## Implementation notes

### Design fences

- Greyscale plus exactly one moss/green accent — the existing `--live` custom property. No new colours.
- Hairlines, restrained composition, generous space. Serif for prose, mono for machine values.
- Motif drawn from the orchestrate → orchard reading: living, growing, tended. The shipped mark is a grafted sapling in moss on greyscale.
- The `frontend-design` skill was to be read first, specifically to avoid a default-looking mark.

### Scope fences

- Assets confined to `public/index.html`, `public/styles.css`, and new SVG files.
- `public/app.js` was owned by a sibling agent and was not to be edited; any genuinely required script-side render was to be recorded as a handoff.
- Optional restrained touches were permitted where they helped — empty states, the idle rail, a loading moment — but explicitly not to the point of over-decoration.
- The runtime text rename was out of scope and is carried by FEAT-036.

## Verification plan

Survey the existing interface first — `public/index.html`, `public/styles.css`, and the current `public/favicon.svg` — so the new mark matches what is already there. Then confirm the header and favicon render by capturing a screenshot, run `verify:ui --offline`, and run `typecheck`. The service on :4317 was not to be touched and no commit was to be made.

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed + dispatched to a Fable agent with creative latitude. Rename refactor = FEAT-036.

### 2026-08-04 — Fable (designer)
- **The mark:** a grafted sapling drawn in the app's own grammar — a hairline stem
  rising from a short ground line (the orchard *row*: planted, tended, not wild),
  one branch reaching, and the moss `--live` dot as the bud at its tip. The apex
  is left bare: still growing. It is literally the product — the session tree with
  one thing running. The favicon keeps the old mark's grammar (dark tile, grey
  strokes, single moss dot) so the tab reads as the same app, evolved: the
  window's rows became a living stem.
- **Wordmark:** "Orchard" in the existing serif (Charter), 14.5px/500, in the
  sidebar's top chrome next to the inline mark (currentColor strokes + `var(--live)`
  bud, so it follows the theme). Sidebar chrome regrouped: brand left, the three
  icons right. Collapsed sidebar shows the mark alone, centered.
- **One restrained touch:** the rail's "nothing needs you" ✓ is now a small moss
  leaf (pure CSS mask over the glyph app.js renders — no JS change; the ✓ stays
  in the accessibility tree).
- Files: `public/favicon.svg` (rewritten), `public/index.html` (brand markup,
  `<title>Orchard</title>`, h1 initial text), `public/styles.css` (`.brand`,
  collapsed rules, `.rail-empty .ok` leaf, header comment).
- Screenshots: `docs/bugs/assets/FEAT-035-header-light.png`, `-header-dark.png`,
  `-collapsed-dark.png`, `-rail-empty.png`, `-favicon-sizes.png` (16/32/64/128 —
  reads at 16). Real server + headless Brave/CDP on a free port; killed by pid.
- Verified: `verify:ui --offline` 3/3 PASS, `typecheck` PASS. No commit.
- **HANDOFF (app.js — sibling-owned, not touched):** app.js still says
  "Claude Station" at runtime: `document.title` template (~line 5363), the h1
  fallback (~line 2391), and the boot hint copy. Needs the FEAT-036 rename pass.
