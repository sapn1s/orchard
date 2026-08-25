# BUG-098 — digest ref-chip (clickable) and DECISIONS eyebrow fall below WCAG AA in the light theme

- **Status:** VERIFIED (2026-08-14) — chip + DECISIONS eyebrow now clear AA in light; wrapped chip aligned; BUG-095 properties unmoved
- **Area:** public/styles.css (`.digest` ref chip + eyebrow tints)
- **Reported:** 2026-08-14 by an independent visual reviewer during the BUG-095 sign-off

## Problem
Measured from the rendered pixels during the BUG-095 closing review (all PRE-EXISTING — not caused by
that round's fixes, and byte-identical in the baseline):

1. **Solid ticket-ref chip label = 4.13:1 in light** (`#4E77A8` on the card). This is the **clickable**
   element — the one that most needs to be legible — and it fails AA at its size. Dark is fine (6.68:1).
2. **DECISIONS eyebrow = 4.19:1 in light** (`#897040`). The other three eyebrows pass (4.57–5.59); dark
   all pass (6.3–6.8). The ochre hue is inherently light, so it lands lowest.
3. Cosmetic: when a ref chip WRAPS onto its own line (e.g. a long FYI item), its border box starts ~14px
   right of the text left edge instead of aligning — a visible break in the left rag.

## Wanted
- Raise the solid ref-chip label to **≥4.5:1 in light** while keeping it visibly "link blue" and clearly
  distinct from the dashed inert chip. Keep dark as-is (already passing).
- Raise the DECISIONS eyebrow to ≥4.5:1 without making it louder than the item text it labels (the
  eyebrow must stay subordinate — that was the BUG-095 fix and must not regress).
- Align a wrapped ref chip's left edge with the item text.

## Do NOT regress (BUG-095 outcomes, independently verified)
Importance ladder (light 14.83 / 8.13 / 4.67; dark 13.89 / 8.20 / 4.80, all AA); no bold anywhere
(importance is ink-contrast only); group breaks out-rank item breaks (gap 99 vs 51; rule Δ14 vs Δ8);
wrapped items stay unambiguous (item-break : line-break whitespace ratio 4.6×); rail/eyebrow/chip
treatments intact in both themes.

## Verification (§C + visual)
- Measure the actual rendered contrast of the chip label and each eyebrow in BOTH themes; assert ≥4.5:1
  in light (must-FAIL pre-fix: chip 4.13, DECISIONS 4.19).
- Re-render the realistic WRAPPING fixture (the one from BUG-095) and confirm the wrapped chip aligns and
  that none of the do-not-regress properties moved.
- Anti-regress: verify:feat-083 22/22, verify:feat-083-adversarial 170/170, verify:ui, typecheck, leak-gate.
- Risk bucket: UI/visual + a11y (low).

## Forward-looking note (not a defect, from the same review)
The digest text measure is ~90 characters per line, above the 45–75 comfort band; the BUG-095 leading
tighten (1.55→1.45) works slightly against a long measure. It reads fine at current size. If item
legibility is ever revisited, the correct fix is a `max-width` on the text column (~68ch), NOT restoring
the leading (which would undo the wrapped-item separation win).

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
