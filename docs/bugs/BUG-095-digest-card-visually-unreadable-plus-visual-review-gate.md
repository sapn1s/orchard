```orchard-ticket
{
  "id": "BUG-095",
  "type": "bug",
  "title": "Digest items were visually difficult to distinguish",
  "summary": "Digest items now have clearer boundaries, hierarchy, references, and importance cues. UI work also includes a visual-review gate so rendered pixels receive design critique alongside functional checks.",
  "impact_if_we_wait": "Without the redesign, readers struggle to group items and may mistake importance for titles. Bounded: this affects readability and display-correctness, not stored data, content integrity, linking, or security.",
  "current_need": "Treat the work as complete: functional, adversarial, and UI checks passed, while type and leak checks stayed clean.",
  "severity": "medium",
  "area": "Response digest display",
  "reported": "2026-08-14",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-14",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Each digest item has a clear visual boundary and unambiguous reading order",
    "Importance remains scannable without bold styling that resembles a title",
    "Each reference appears visibly attached to its corresponding item",
    "Kind labels remain visually quieter than item statements",
    "UI changes receive screenshot-based design critique alongside functional testing"
  ],
  "code_refs": [
    {
      "path": "public/lib/digest.js",
      "symbol": "renderDigest",
      "note": "Builds the grouped digest items and their references"
    },
    {
      "path": "public/styles.css",
      "symbol": ".digest",
      "note": "Controls digest hierarchy, spacing, boundaries, labels, importance cues, and reference presentation"
    }
  ],
  "related": [
    {
      "id": "BUG-098",
      "relation": "see_also"
    },
    {
      "id": "BUG-101",
      "relation": "recurrence_of"
    },
    {
      "id": "FEAT-083",
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
    "Migration and rollback": true,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/BUG-095-digest-card-visually-unreadable-plus-visual-review-gate.md",
    "sha256": "d2433dbf0c909e9f24c05ae091ca9f323d021fcd7da12200f0c621409972506e",
    "bytes": 13444,
    "original_title": "response-digest card is visually unreadable; redesign it via a visual-review gate (and adopt that gate for UI)",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared field by field with the original; the unreadable hierarchy, redesign intent, visual-review gate, functional protections, and recorded executed evidence are preserved.",
    "dropped": []
  }
}
```

# BUG-095 — Digest items were visually difficult to distinguish

## Diagnosis

Importance was expressed through font weight, making high-importance statements resemble titles while other statements resembled descriptions. Dense stacking and weak boundaries made items blur together, and references appeared disconnected from their statements. BUG-095 also exposed a workflow gap: functional DOM checks could pass while the rendered interface remained difficult to read.

## Evidence

`verify:feat-083` passed 22/22, `verify:feat-083-adversarial` passed 170/170, and `verify:ui` passed 7/7. Typecheck and leak-gate were reported clean. The dedicated `verify:feat-083-response-digest` suite was named, but no execution result was recorded.

## Implementation notes

Present each item as a bounded unit with generous separation and a clear reading order. Use a subtle accent rather than bold weight for importance. Keep kind labels quiet and attach each reference as a small trailing chip. UI work should pass through screenshot capture, fresh design critique, revision, and another visual inspection.

## Verification plan

Keep functional coverage for grouping, links, preserved content, and XSS resistance. Capture a realistic multi-item digest containing every kind, mixed importance, ticket references, and inert references. Review the image for item separation, statement-to-reference association, hierarchy, readability, and cognitive load. Preserve before-and-after screenshots and obtain design-critical sign-off.

## Migration and rollback

The change is confined to digest rendering, styling, and the UI review workflow. Revert the presentation changes if they impair grouping, links, content preservation, or safe rendering; retain the functional checks throughout.

## Risks

Functional risk is low because the change is primarily visual. Excessive accents, boundaries, or spacing could replace ambiguity with clutter, while weak styling could leave the original grouping problem intact.

## Activity log (APPEND-ONLY)
### 2026-08-14 — orchestrator
- Filed from user report: digest unreadable AND a workflow gap (functional tests can't catch ugly).
  Primary fix is the visual-review gate; the digest redesign is the first application. Memory saved
  (ui-needs-visual-review-not-just-functional-tests). Redesign dispatched with screenshot-based visual
  acceptance + the frontend-design skill.

### 2026-08-14 — redesign worker (VERIFIED)
Dogfooded the visual-review gate: rendered the realistic fixture (all 4 kinds, mixed importance, a
ticket-ref link + an inert label, prose below) through the app's OWN transcript path in real headless
brave over raw CDP (OS-free port, PID-kill only, never :4317), clipped the shot to the digest card, and
LOOKED at the pixels before and after. Applied the frontend-design skill (three separate visual channels,
restraint, greyscale-first).

Before/after screenshots (for the orchestrator to look at):
- /tmp/iv-orchard/digest-before.png  (light)
- /tmp/iv-orchard/digest-after.png   (light)
- /tmp/iv-orchard/digest-after-dark.png (dark — confirms the tokens hold in both themes)

Visual-critique of the BEFORE image (the hierarchy failures, confirmed by eye):
- Importance was encoded as font-WEIGHT, so high-importance items ("Need your call…", "Shipped the
  digest renderer and CSS.") rendered BOLD and read as TITLES, while med/low items rendered grey and read
  as DESCRIPTIONS. Within a group this manufactured a false title→description pairing out of sibling
  facts — exactly the reported "this is not a description… the ticket no longer matches" break.
- Refs floated in a right-pinned column (flex spacer pushed them to the far edge), detached from their
  sentence by a wide gap, and sat on the bold "title" line — reinforcing the false title read. The link
  chips and the inert-label chip looked nearly identical, so clickable vs pointer was ambiguous.
- Items had no real boundary — only a thin per-row coloured left rule and 2px gaps — so adjacent rows
  blurred (the DONE pair looked like one title+desc unit).
- The kind labels were fully-saturated coloured uppercase, competing as headings against the bold items;
  three signals (kind colour, importance weight, ref) all fought on the same axis.

The redesign (how it answers each failure) — public/lib/digest.js renderDigest doc + DOM kept minimal
(the fix is fundamentally visual), public/styles.css `.digest` fully rebuilt. Three channels, each on its
OWN axis so they can't be confused:
- KIND → a quiet tinted LEFT RAIL per group (the one colour per group, FEAT-066 STATUS tokens) + a MUTED
  GREY uppercase label. The label is no longer a coloured heading; colour is the rail's job.
- IMPORTANCE → a leading DOT + INK CONTRAST, never weight. high = solid ink dot + full-contrast ink;
  med = mid-grey dot + ink-2; low = a hollow ring + ink-3. All greyscale, so importance can't be mistaken
  for the kind colour OR for a bold title. Font-weight is now constant across all items.
- REF → a small chip ATTACHED inline right after its sentence (dropped the flex right-pin). A link is a
  solid tinted chip; an inert label is a DASHED grey chip — clickable vs pointer now reads at a glance.
- BOUNDARIES → each item is a bounded row parted by subtle --hair-2 hairlines (the clean bug-ticket-row
  feel), with generous padding, groups parted by a full-width hairline. Rows no longer blur.

Self-critique of the AFTER image: items are clearly distinct; the statement/ref split is unambiguous and
the two ref styles are distinguishable; high-importance lines read as "more important facts" (contrast +
solid dot) NOT as headings — no bold anywhere. Holds in both light and dark. A reviewer should sanity-check
that the full-ink high-importance contrast still reads as importance-not-title to a fresh eye (I judge it
does; it is contrast, not weight) and that the tinted rails aren't too loud (they carry the only colour, by
design).

Functional (kept green): verify:feat-083 22/22 · verify:feat-083-adversarial 170/170 (contract HOLDS, no
content lost/hidden/mangled, no XSS, refs link) · typecheck clean · verify:ui 7/7 · leak-gate PASS (420
files). Risk bucket: UI/visual (low functional risk). The screenshot rig was a scratch script (removed
before commit); it reuses the verify-feat-083 CDP harness verbatim.

### 2026-08-14 — visual-polish pass (reviewer's three tweaks applied)
Applied an unbiased reviewer's three recommended refinements to the shipped redesign (frontend-design lens),
re-rendered the SAME realistic fixture through the app's own transcript path in real headless brave over CDP
(OS-free port, PID-kill only, never :4317; verify-feat-083 rig reused), clipped to the .digest card, and
LOOKED at light + dark before signing off.

- (1) KIND LABEL too quiet → the eyebrow now carries a trace of its kind's rail hue (color-mix ~60% of the
  STATUS token into --ink-2, so decision=amber, done=moss, in-flight=slate; fyi has no hue so just lifted to
  --ink-2). Grounded into ink so it stays a label, not a coloured heading — "which kind" now registers about
  as fast as importance.
- (2) GROUP BOUNDARIES weaker than item boundaries → group breaks now out-rank item breaks: a heavier divider
  (--hair vs the item divider's lighter --hair-2) AND more air above each group's eyebrow (padding-top 17px
  vs the item row's 7px). Kinds read as distinct blocks; siblings stay lightly parted.
- (3) IMPORTANCE dots → dropped entirely (Chanel "remove one accessory"): the leading dot was a redundant
  second encoding of importance whose med/low states read nearly identical. Importance now rides INK CONTRAST
  alone (high=--ink, med=--ink-2, low=--ink-3), font-weight still constant. The hanging indent the dot needed
  was removed, so rows sit flush. The card still carries several structural devices (rail hue, tinted eyebrow,
  hairline rows, ref chips).

Kept everything the redesign got right: importance as ink-contrast NOT weight (no bold), refs as inline chips
(solid=link, dashed=inert), hairline-bounded rows, greyscale-first, holds in both themes.

Final screenshots (for the orchestrator/user to look at):
- /tmp/iv-orchard/digest-final.png       (light)
- /tmp/iv-orchard/digest-final-dark.png  (dark)

Functional stayed green: typecheck clean · verify:feat-083 22/22 · verify:feat-083-adversarial 170/170
(contract HOLDS) · verify:ui 7/7 · leak-gate PASS (420 files).

### 2026-08-14 — sign-off follow-up: AA contrast for the ink ladder + the WRAPPING fixture
The unbiased visual reviewer signed the polish pass off but flagged two pre-existing issues that the
polish had made LOAD-BEARING. Both are now fixed in public/styles.css (plus the verify fixture).

(1) ACCESSIBILITY — importance is now encoded by ink contrast ALONE (the redundant dot was dropped), so an
unreadable step is a real defect. Measured on the card surface (--sunken), sRGB WCAG ratios:

  light (#F1F2EF)   before: high #1B1F1D 14.83 · med #5A625E 5.59 · low #8C948F 2.77  ← low FAILS AA (4.5)
                     after: high #1B1F1D 14.83 · med #424A46 8.13 · low #666E6A 4.67  ← all pass AA
  dark  (#1A1D1A)   before: high #E6E9E5 13.89 · med #9AA29C 6.50 · low #737B76 3.91  ← low FAILS AA
                     after: high #E6E9E5 13.89 · med #AEB6B0 8.20 · low #828A85 4.80  ← all pass AA

Raising low alone would have collapsed it into med, so the whole ladder was re-cut on perceptual lightness,
not just on ratio: light L* 11.3 / 30.6 / 45.7 (steps 19.3 and 15.1), dark L* 92.0 / 73.3 / 55.1 (steps 18.7
and 18.2) — three steps that still read distinctly at a glance, and every step now readable. The values live
as card-LOCAL tokens (--dg-ink-high/med/low on .digest, with a dark override for both [data-theme="dark"]
and the prefers-color-scheme default), so the app's global ink scale is untouched. The inert ref chip took
the same AA-clearing low ink (it was --ink-3 = 2.75:1).

(2) THE FIXTURE WAS UNREALISTIC — every digest item was a single line. Real items are full sentences that
WRAP to 2–3 lines; that is the normal case. Rebuilt the fixture as a realistic digest (9 items, all four
kinds, mixed importance, ticket-ref chip + inert label chip, prose below, every item wrapping) and rendered
it. WHAT IT REVEALED: the reviewer's risk was real — with wrapped items, ~20.9px between two lines of ONE
item against ~34.9px + a 4-value hairline (#EDEFEB on #F1F2EF) between two DIFFERENT items left the item
boundary barely perceptible; the eye had only the ink-colour change to go on, so two same-importance wrapped
items ran together. Fixed by moving both sides of that margin:
  - line-height inside an item 1.55 → 1.45 (~19.6px between lines of one item)
  - item padding 7px → 10px (≈39px between items — now ~2x the intra-item line gap, was ~1.67x)
  - the item rule got a card-local --dg-item-rule (#E9EBE7 light / #202320 dark) instead of --hair-2,
    roughly 2x the old delta but still clearly BELOW the group rule (--hair #E3E5E1 / #242724)
  - group spacing bumped to keep its rank (padding-bottom 10→12, padding-top 17→19), so group breaks still
    out-rank item breaks on BOTH channels (heavier rule + more air).
The committed verify fixture (scripts/verify-feat-083-response-digest.mjs) now uses wrapping-length
sentences too, so the shape under test matches the shape users see.

Verified by looking, not by assertion: rendered the realistic wrapping fixture through the app's own
transcript path in real headless brave over CDP (OS-free port, PID-kill only, never :4317; verify-feat-083
rig reused), clipped to the card, both themes:
- /tmp/iv-orchard/digest-wrap.png       (light)
- /tmp/iv-orchard/digest-wrap-dark.png  (dark)
- /tmp/iv-orchard/wrap-baseline.png     (the same fixture BEFORE the fix, for comparison)
Item boundaries now read unambiguously between wrapped items, group breaks still visibly out-rank them, and
the low step is legible in both themes. No bold anywhere; chips, rails, eyebrows, greyscale-first unchanged.

Functional stayed green: verify:feat-083 22/22 · verify:feat-083-adversarial 170/170 (contract HOLDS) ·
typecheck clean · verify:ui 7/7 · leak-gate PASS.
