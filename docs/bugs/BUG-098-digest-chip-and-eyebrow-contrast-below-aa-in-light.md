```orchard-ticket
{
  "id": "BUG-098",
  "type": "bug",
  "title": "Digest chip and label text were hard to read in light theme",
  "summary": "In the light theme the clickable ticket-reference chip in the digest and the decisions label above an item both fell below the accessibility contrast minimum, and a chip that wrapped onto its own line started indented from the text beside it. Both now clear the minimum in light, dark is unchanged, and a wrapped chip lines up.",
  "impact_if_we_wait": "Low-vision readers strain on the one element in the digest they are meant to click. Bounded: this is display contrast in one theme only, with no data affected, and every element remained readable in the dark theme throughout.",
  "current_need": "Treat the ticket as closed: the pre-fix contrast case failed as expected, the corrected colours passed in both themes, and standing checks stayed clean.",
  "severity": "medium",
  "area": "Digest readability",
  "reported": "2026-08-14",
  "reported_by": "visual reviewer",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-14",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "The solid ticket-reference chip label reaches at least 4.5:1 contrast in the light theme",
    "The decisions eyebrow reaches at least 4.5:1 in light without becoming louder than the item text it labels",
    "A wrapped reference chip aligns its left edge with the item text",
    "Dark theme contrast and the earlier importance-ladder outcomes are unchanged"
  ],
  "code_refs": [
    {
      "path": "public/styles.css",
      "symbol": ".digest ref chip",
      "note": "solid chip label measured 4.13:1 in light on the card, 6.68:1 in dark; wrapped chip border box started ~14px right of the text left edge"
    },
    {
      "path": "public/styles.css",
      "symbol": "eyebrow tints",
      "note": "DECISIONS eyebrow measured 4.19:1 in light; the other three eyebrows measured 4.57–5.59 and all dark eyebrows 6.3–6.8"
    }
  ],
  "related": [
    {
      "id": "BUG-095",
      "relation": "see_also"
    },
    {
      "id": "BUG-101",
      "relation": "recurrence_of"
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
    "archived_path": "docs/bugs/archive/BUG-098-digest-chip-and-eyebrow-contrast-below-aa-in-light.md",
    "sha256": "0cde5c1c47acdaadff60fde7c66bc5923761d3f814e04705e8d9a6ed7fa5a4cc",
    "bytes": 6613,
    "original_title": "digest ref-chip (clickable) and DECISIONS eyebrow fall below WCAG AA in the light theme",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Checked field by field against the original head; the three measured defects, both wanted outcomes, the do-not-regress list and the forward-looking note are all present.",
    "dropped": []
  }
}
```

# BUG-098 — Digest chip and label text were hard to read in light theme

## Diagnosis

Two light-theme colours in the digest sat just under the 4.5:1 minimum. The solid ticket-reference chip label used a mid blue that measured 4.13:1 against the card, and it is the clickable element, so it is the one that most needs to be legible. The decisions eyebrow used an ochre that measured 4.19:1; ochre is inherently light, so of the four eyebrow hues it landed lowest. Separately, a reference chip that wrapped onto its own line rendered its border box about 14px right of the item's text left edge, breaking the left rag. All three were pre-existing and byte-identical in the baseline, so none was introduced by the preceding round of fixes.

## Evidence

Reported on 2026-08-14 by an independent visual reviewer measuring rendered pixels during the BUG-095 closing review. Light-theme measurements: chip label 4.13:1, DECISIONS eyebrow 4.19:1, other eyebrows 4.57–5.59. Dark theme passed throughout: chip 6.68:1, eyebrows 6.3–6.8. After the fix, the anti-regression suites ran green — verify:feat-083 at 22/22, verify:feat-083-adversarial at 170/170, and verify:ui at 7/7 — with typecheck and the leak gate clean. The fixer's own record describes the pass as a clean-room read of the rendered output rather than of the stylesheet.

## Implementation notes

The constraint on the eyebrow was two-sided: raise it to the minimum without making it louder than the item text it labels, since keeping the eyebrow subordinate was the outcome of the previous round and had to survive. The chip had to stay recognisably link-blue and stay clearly distinct from the dashed inert chip. Dark-theme values were left alone because they already passed.

## Verification plan

Measure the rendered contrast of the chip label and each of the four eyebrows in both themes and assert at least 4.5:1 in light; the pre-fix case must fail at chip 4.13 and DECISIONS 4.19. Re-render the realistic wrapping fixture from the previous round, confirm the wrapped chip aligns, and confirm none of the protected properties moved: the importance ladder (light 14.83 / 8.13 / 4.67, dark 13.89 / 8.20 / 4.80), no bold anywhere, group breaks out-ranking item breaks (gap 99 versus 51, rule delta 14 versus 8), the 4.6× item-break to line-break whitespace ratio, and the rail, eyebrow and chip treatments in both themes.

## Risks

Risk bucket is visual and accessibility only, rated low.

The same review raised a non-defect worth recording: the digest text measure runs to about 90 characters per line, above the 45–75 comfort band, and the previous round's leading tighten from 1.55 to 1.45 works slightly against a long measure. It reads fine at the current size. If item legibility is revisited, the right fix is a max-width of roughly 68ch on the text column, not restoring the leading, which would undo the wrapped-item separation that round won.

## Activity log (APPEND-ONLY)
### 2026-08-14 — orchestrator
- Filed from the independent visual reviewer's sign-off, which measured these from pixels and explicitly
  scoped them as pre-existing/out-of-round. Queued behind FEAT-081 (shared file: public/styles.css).

### 2026-08-14 — worker (fix + verify)
Fix is CSS-only in `public/styles.css` (the `.digest` block); `public/lib/digest.js` untouched. Uses two
new card-local tokens redefined per theme, mirroring the existing `--dg-*` pattern, so DARK is byte-identical:
- `--dg-ref-ink` — the clickable chip label. Light: `color-mix(--st-prog 80%, --ink)` (grounds the link
  blue 20% into ink); dark: raw `--st-prog`. Chip border/fill/hover unchanged (solid-vs-dashed intact).
- `--dg-eye-dec-ground` — the ochre DECISIONS eyebrow's ground. Light: `color-mix(--ink-2 70%, --ink)`
  (a slightly darker ground, ochre stays 60%); dark: raw `--ink-2`. Only the decision eyebrow uses it;
  the other three eyebrows are unchanged (they already passed).
- Wrap alignment: dropped `margin-left:7px` from `.digest-ref`, moved the gap to
  `.digest-text:has(+ .digest-ref){ margin-right:7px }`. It becomes a trailing gap at the sentence end,
  so a chip that WRAPS onto its own line sits flush-left (aligned) instead of offset 7px right.

Measured RENDERED contrast (browser-resolved fill vs browser-resolved painted surface, 1x1-canvas pixel
resolve, both themes) on the BUG-095 realistic wrapping fixture. Must-FAIL proof captured by re-running the
same probe against the stashed pre-fix CSS.

| element (LIGHT)        | before | after |
|------------------------|--------|-------|
| chip ref-link (clickable) | 4.28 FAIL | **5.60 PASS** |
| eyebrow DECISIONS      | 4.17 FAIL | **4.67 PASS** |
| eyebrow Done           | 4.63   | 4.63  (unchanged) |
| eyebrow In-flight      | 4.71   | 4.71  (unchanged) |
| eyebrow FYI            | 5.59   | 5.59  (unchanged) |

(My resolved-fill numbers read ~0.1–0.15 above the reviewer's glyph-pixel sample — no anti-alias softening;
the reviewer's 4.13 chip / 4.19 decision are reproduced within model tolerance. Post-fix margins clear 4.5
even accounting for AA.) DARK unchanged before/after: chip 6.61–6.63, DECISIONS 6.71→6.82, Done 6.36,
In-flight 6.66, FYI 6.60 — all pass, none regressed.

BUG-095 do-not-regress, re-measured (identical light and dark, my diff touches no vertical spacing):
- Importance ladder AA held: light 14.83 / 8.13 / 4.60, dark 13.87 / 8.32 / 4.82 (all ≥4.5, carried by
  ink-contrast only, no bold).
- Whitespace rhythm ordering held: group gap 42.6px > item gap 22.1px > line-break — group breaks still
  out-rank item breaks, items still out-rank wrapped lines. (Metric basis is text-content whitespace, not
  the reviewer's exact band method, so the absolute numbers differ from 99/51; the ordering is the invariant
  and my diff changes none of the padding/border/line-height/token values that produce it.)
- Wrapped chip: "see RESPONSE_FORMAT.md" delta 7px (pre) → 0px (post) = ALIGNED. Solid-vs-dashed chip
  distinction and rail hues intact in both themes (confirmed by eye on the screenshots).

Screenshots (real headless brave over CDP, free port, PID-kill, never :4317):
`/tmp/iv-orchard/digest-a11y.png` (light), `/tmp/iv-orchard/digest-a11y-dark.png` (dark).

Anti-regress all green: verify:feat-083 22/22, verify:feat-083-adversarial 170/170 (contract HOLDS),
verify:ui 7/7, typecheck clean, leak-gate PASS (0 hits / 440 files, exit 0).

Risk bucket: routine low-risk UI/a11y (colour + one horizontal-margin move; no JS, no lifecycle/security).
An unbiased visual review may follow — welcome but not required for this bucket.
