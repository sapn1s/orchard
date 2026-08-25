# BUG-095 — response-digest card is visually unreadable; redesign it via a visual-review gate (and adopt that gate for UI)

- **Status:** VERIFIED
- **Area:** public/lib/digest.js (renderDigest DOM) + public/styles.css (.digest) — plus a workflow addition
- **Reported:** 2026-08-14 by user

## Symptom (user)
The rendered digest is "visually TERRIBLE to read." Items stack too densely with no clear per-item
boundary; importance is encoded as font-weight, so high-importance items go **bold** and read as
TITLES while med/low read as DESCRIPTIONS — but the ticket refs don't follow that title/description
logic, so the reader's mental grouping breaks ("this is not a description… the ticket no longer
matches"). The information hierarchy is ambiguous.

## The deeper issue (workflow gap — the primary fix)
FEAT-083 passed 22/22 functional render tests + a 170/170 adversarial pass, yet shipped an unreadable
UI. Those tests assert DOM STRUCTURE + BEHAVIOR (element exists, groups ordered, content preserved, no
XSS) — none judge VISUAL HIERARCHY / READABILITY / cognitive load. No unbiased eye looked at the actual
rendered pixels. **Functional-green ≠ good UX.** See memory: ui-needs-visual-review-not-just-functional-tests.

## Wanted
### 1. Adopt a VISUAL REVIEW GATE for UI changes (workflow)
UI work is not done at "tests pass." Render it, capture a real screenshot, and have a fresh
design-critical eye (apply the frontend-design skill; unbiased/cross-provider where feasible) evaluate
hierarchy + readability + cognitive load before done. DOM assertions stay (necessary) but are not
sufficient. This ticket dogfoods the gate.

### 2. Redesign the digest card for clear cognitive processing
Via that gate (screenshot → design critique → rebuild → re-screenshot → look), not DOM asserts alone.
Design intent (the redesigner decides specifics with the frontend-design lens): each item is a clearly
bounded unit with an unambiguous read order; importance must NOT be encoded as bold-that-mimics-a-title
(use a subtle accent — a dot, a hairline, a muted tint — not weight that competes with hierarchy); the
kind (Decision/Done/etc.) reads as a quiet label, not a heading; the ref is visibly ATTACHED to its
item (a small trailing chip), never floating between items; generous separation between items so they
don't blur. Compare the reader's experience to a good bug-ticket row: one clear line, clear
distinction, a way to get more — low load at a glance.

## Verification (§C + visual)
- Functional (keep): renderDigest still produces the grouped items, refs link, no XSS, content never
  swallowed (verify:feat-083 + adversarial still pass). typecheck, leak-gate.
- VISUAL (new, the point): capture a real headless-brave screenshot of a realistic multi-item digest
  (all kinds, mixed importance, ticket + inert refs) and evaluate the IMAGE for: can a first-time reader
  tell items apart, tell the statement from the ref, and scan importance without mistaking weight for a
  title? Attach before/after screenshots. An unbiased/design-critical reviewer signs off on the image,
  not just the DOM.
- Risk bucket: UI/visual (low functional risk; the fix IS readability).

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
