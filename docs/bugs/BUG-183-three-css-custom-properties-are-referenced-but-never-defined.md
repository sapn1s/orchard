# BUG-183 — three CSS custom properties are referenced but never defined, leaving the Add-account flow with no focus ring

- **Status:** OPEN
- **Severity:** medium (a shipped flow becomes keyboard-unusable; not a crash)
- **Area:** styles / drawer
- **Reported:** 2026-09-18 by user (found auditing settings for FEAT-146)
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED.

## Symptom

The global model picker, the custom-model free-text field, and every input in
the FEAT-145 add-account flow have **no visible focus ring** when tabbed to,
and their backgrounds fall through to transparent. Separately, every warning
indicator in the app renders the same hardcoded amber in dark mode instead of
a theme-adapted colour.

## Repro

1. Open Settings, tab to the global model picker (`.gsel`) or the custom-model
   text field (`.gtext`) or an add-account button (`.gbtn`). No focus ring
   appears in either theme.
2. Inspect computed styles: `outline: 2px solid var(--accent)` — `--accent`
   resolves to nothing, so the declaration is invalid and the `outline`
   property is dropped entirely (not "invisible", **absent**).
3. Inspect `background: var(--bg-2)` on the same rules — also empty, so the
   background falls through to whatever is behind it.
4. Toggle dark mode and look at any warning indicator (`.seal .readout.usage.warn`,
   `.lag.stall`, `.grp-note[data-warn="true"]`, `.prov-state[data-status=
   "installed-not-signed-in"] .dot`, `.req-exec.stall`) — all six-plus sites
   render the light-mode hardcoded fallback `#B0703C` because `--warn` is
   never defined in any theme block, so `var(--warn, #B0703C)` always takes
   the fallback branch regardless of theme.

## Expected

Every interactive control has a visible, theme-correct focus ring in both
light and dark mode. `--warn` resolves to a real value (that adapts between
light and dark) instead of silently always taking its hardcoded fallback.

## Root cause

`.gsel`, `.gtext`, `.gbtn` (`public/styles.css:1770-1797`) reference
`--ink-1`, `--bg-2`, `--line-1`, `--line-2`, `--accent` — **none of which
exist anywhere in this codebase.** Confirmed by grep across all four theme
declaration blocks: the real token set is `--sunken`, `--hair`/`--hair-2`,
`--ink`, `--ink-2`, `--ink-3`, `--ink-4` (light `:16-23`, dark media-query
`:62-69`, `[data-theme="dark"]` `:87-94`, `[data-theme="light"]`
`:111-118`). `--ink-1`, `--bg-2`, `--line-1`, `--line-2`, `--accent` do not
appear as declarations anywhere — every use of them is a reference to a
property that was never declared, so it resolves to the CSS-wide keyword
`unset`, which for `outline`/`background`/`color` behaves as if the
declaration were absent.

`--warn` is referenced with a hardcoded fallback at ten-plus sites
(`styles.css:771, 772, 1112, 1113, 1114, 1579, 1591, 1597, 2948, 3277` —
`.seal .readout.usage.warn`, `.lag.stall .gl/.el/.ty`,
`.grp-note[data-warn="true"]`, `.proj-dir-box[data-missing="true"] .proj-dir
.v`, `.dir-gone b`, `.prov-state[data-status="installed-not-signed-in"]
.dot`, `.req-exec.stall`) and **never defined** in any of the four theme
blocks, so every one of those sites always renders `#B0703C` regardless of
theme.

`--focus` is referenced with a fallback at `styles.css:1401`
(`.seal .perm:focus-visible { ... box-shadow: 0 0 0 2px var(--focus,
var(--ink-4)); }`) and is likewise never defined in any theme block.

## Fix direction

Define `--warn` (light `#B0703C`, dark `#C89A6A`) and `--focus` (e.g.
`var(--ink-2)` or `var(--ink-4)` — match whatever the existing `--focus`
fallback and the global `:focus-visible` rule at `styles.css:143` already
imply) in all four theme declaration blocks (`:root` light `:8-32`,
`@media (prefers-color-scheme: dark)` `:57-80`, `:root[data-theme="dark"]`
`:83-105`, `:root[data-theme="light"]` `:107-129` — all four must stay in
sync, the existing pattern every other token in those blocks already
follows). Rewrite `.gsel`/`.gtext`/`.gbtn` (`:1770-1797`) onto the real
tokens (`--sunken`/`--hair`/`--ink`/`--ink-4`) and **delete their bogus
`:focus-visible` overrides** (`:1777, 1789, 1797`) so the correct global
rule at `styles.css:143` (`:focus-visible { outline: 1.5px solid
var(--ink-2); outline-offset: 2px; border-radius: 5px; }`) applies instead.

## Context pack (grows — the "where to look", so no agent cold-starts)

- Files/functions in play: `public/styles.css:1770-1797` (`.gsel`/`.gtext`/
  `.gbtn`), `:8-32, 57-80, 83-105, 107-129` (the four theme blocks), `:143`
  (the correct global `:focus-visible` rule), `:771-772, 1112-1114, 1579,
  1591, 1597, 2948, 3277` (`--warn` use sites), `:1401` (`--focus` use site).
- Related tickets: FEAT-146 (the settings modal redesign this is a
  prerequisite for — same controls are in scope there), FEAT-145 (the
  add-account flow whose inputs this affects), FEAT-139 (the luminance-not-hue
  provenance idiom the redesign reuses, adjacent to this token audit).
- Repro test: none yet — needs a real-browser computed-style assertion (see
  Proof bar). No existing suite covers CSS custom-property resolution.
- Known dependencies / blockers: none. Independent of FEAT-146; can land
  first and the modal rework inherits the fix.

## Proof bar

- A real-browser assertion that `.gsel`, `.gtext`, `.gbtn` and the add-account
  flow's inputs each have a computed visible focus ring (non-empty `outline`
  or `box-shadow`) in **both** themes.
- A real-browser assertion that `getComputedStyle(...).getPropertyValue('--warn')`
  resolves to a defined, theme-appropriate value (not the empty string) under
  all four theme paths, so `var(--warn, #B0703C)` no longer silently always
  takes its fallback.
- Same for `--focus`.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-18 — filed from user-requested audit
- **Understood:** grepped all four theme declaration blocks in
  `public/styles.css` and confirmed `--ink-1`, `--bg-2`, `--line-1`,
  `--line-2`, `--accent`, `--warn`, `--focus` are referenced but never
  declared anywhere in the file. Verified the specific line numbers by direct
  read rather than assuming the reporter's line citations were exact.
- **Changed:** filed this ticket only. No code written.
- **Verified:** `grep -n` against `public/styles.css` confirming: (1) `.gsel`/
  `.gtext`/`.gbtn` at lines 1770-1797 use the five undefined tokens; (2) all
  four theme blocks (`:16-23`, `:62-69`, `:87-94`, `:111-118`) declare
  `--sunken`/`--hair`/`--ink`/`--ink-2`/`--ink-3`/`--ink-4` but never
  `--ink-1`/`--bg-2`/`--line-1`/`--line-2`/`--accent`/`--warn`/`--focus`;
  (3) ten-plus `--warn` use sites all carry the same hardcoded `#B0703C`
  fallback; (4) `--focus` used once at line 1401 with fallback `var(--ink-4)`.
  Not yet verified in a real browser (computed-style check) — that is the
  Proof bar for the fixer.
- **Still open / handoff:** un-owned. Fixer should add the two missing tokens
  to all four theme blocks, migrate the three `.g*` rules onto real tokens,
  delete their redundant `:focus-visible` overrides, and write the
  real-browser computed-style suite this ticket currently lacks.
- **Symptom of a deeper design flaw?** not closing this ticket, so not
  answered yet — worth noting for whoever does close it: this is the second
  ticket in one sweep (alongside FEAT-146's rough-edges list) finding drawer
  CSS that references a token vocabulary nobody kept in sync with the actual
  declared set; if a third instance turns up, that pattern may be worth an
  ARCH ticket on how theme tokens get audited.

### 2026-09-18 — fixed (round 1, class=fix); the sweep found five more
- **Understood:** all three reported claims re-verified from scratch before
  touching anything (`rg` for a `--token:` declaration of each name across
  `public/`, exit 1 — no definition exists anywhere, so none of them was a
  false report). The failure mode is worth stating precisely because it is why
  none of this was ever noticed: an undefined `var()` makes the declaration
  invalid *at computed-value time*, so it is dropped silently — no console
  error, no parse warning. For `outline: 2px solid var(--accent)` the WHOLE
  shorthand drops, which is why the FEAT-145 add-account flow had literally no
  focus ring rather than a wrong-coloured one.
- **The sweep found five defects beyond the three reported.** Every `var(--…)`
  in the file was matched against the set of properties actually declared
  (comments stripped first — a token merely *named* in prose otherwise reads as
  a use, which is the one false positive this check can produce):
  - `--accent` — 7 call sites. Four carried `var(--accent, var(--ink-4))` and
    so worked by accident; three (`.gsel`/`.gtext`/`.gbtn`) did not.
  - `--danger` — 3 call sites (`.seal .readout.usage.danger` ×2, `.dc-err`),
    all `var(--danger, #c0392b)`: the same non-adapting-fallback defect as
    `--warn`, and `#c0392b` is a louder red than anything else in the palette.
  - `.modelfree-set` (`:2074-2075`) — an unreported FOURTH control with the
    identical defect: a dead `var(--line-2)` hover border and a dead
    `var(--accent)` focus ring.
  - two raw `#B0703C` literals in `.provider-error` (`:3467`, `:3476`) — not an
    undefined token, but the same symptom: the light hex hardcoded, shipping
    unchanged onto the dark surface, under a comment reading "small warm
    accent" that describes `--warn` exactly.
- **Changed** (`public/styles.css` only; no JS/HTML touched, per the charter's
  fence around the pending settings redesign):
  - `--warn` declared in **all four** theme blocks — `#B0703C` light,
    `#C89A6A` dark. Warm ochre, never red (file header house rule).
  - `--focus: var(--ink-2)` and `--danger: var(--st-high)` declared **once, in
    `:root`, deliberately NOT repeated per theme.** A value that is a bare
    `var(...)` resolves through a token that is already theme-swapped on the
    same element, so the alias follows the active theme with no second place
    able to hold a different answer (CONVENTIONS.md / ARCH-010). Repeating it
    four times would re-create the exact drift this ticket is about. Only
    genuinely per-theme HEXES need all four blocks.
  - `--danger` reuses the palette's existing `--st-high` ("brick red accent",
    FEAT-066) rather than introducing a second red — see *Decided for you*.
  - `.gsel`/`.gtext`/`.gbtn` rewritten onto `--ink`/`--sunken`/`--window`/
    `--hair`/`--ink-4`, in the idiom the neighbouring real controls use
    (`.mini`, `.dc-note`, `.modelfree-set`): field grounds sit on `--sunken`,
    the button on `--window` darkening to `--sunken` on hover, all hairlined
    `--hair` and promoted to `--ink-4` on hover. Their `:focus-visible`
    overrides are **deleted**, so the global rule (`1.5px solid var(--ink-2)`,
    offset 2px) applies — one focus affordance for the whole app.
  - `.modelfree-set` given the same treatment.
  - `.provider-error`'s two literals moved onto `var(--warn)`.
  - Every now-redundant fallback collapsed (`var(--warn, #B0703C)` →
    `var(--warn)`, `var(--accent, var(--ink-4))` → `var(--ink-4)`, etc.), so
    the file no longer carries a dead hex that hides the next omission.
  - No restyling beyond the repair. Sizes, radii, spacing, and every
    unaffected rule are untouched.
- **Verified:** `node scripts/verify-bug-183-css-tokens.mjs` — **ALL PASS**.
  New suite, four blocks, observed values printed throughout. It measures the
  real `public/styles.css` cascade in headless Brave over CDP, reusing the
  harness from `verify-bug-101-contrast.mjs` (same static server, same minimal
  CDP client, no server/registry boot):
  - **A. sweep, the standing assertion** — every `var(--token)` must be
    defined; offenders are *listed with their line numbers*, not just counted.
    Now 44 defined / 42 used, zero undefined.
  - **B. theme-block parity** — every per-theme token present in all four
    blocks. The alias exemption is *derived* (value matches `^var\(--x\)$`),
    not a hand-maintained allowlist, and re-declaring an alias per theme is
    itself a failure.
  - **C. token resolution, all four theme paths** — system-light and
    system-dark via `Emulation.setEmulatedMedia`, plus `data-theme="dark"` and
    `data-theme="light"` each with the *opposite* media emulated so the
    attribute is proven to win. Each token read two ways: its computed value on
    `:root`, and a probe span painted `var(--token, rgb(255,0,255))` whose
    magenta would expose a fallback that fired. Observed: `--warn` #B0703C /
    #C89A6A / #C89A6A / #B0703C; `--focus` #535755 / #9AA29C / #9AA29C /
    #535755; `--danger` #A8503A / #CC7B60 / #CC7B60 / #A8503A. A separate
    assertion proves `--warn` *adapts* — resolving is not enough, one
    hardcoded value would also resolve.
  - **D. focus rings, both themes** — the real drawer markup for all eleven
    controls (`#gModelSel`, `#gModelCustomInput`, `#gModelCustomApply`,
    `#gAcctLabel`, `#gAcctCreate`, `#gAcctUrl`, `#gAcctCopy`, `#gAcctCode`,
    `#gAcctCodeSend`, `.modelfree-set`, and `.seal .perm` for `--focus`'s only
    call site). `:focus-visible` is **forced via CDP `CSS.forcePseudoState`**,
    not `.focus()` — a programmatic focus does not reliably match
    `:focus-visible` on `<select>`/`<button>` in Chromium, so an `.focus()`-
    based check would report "no ring" for correct CSS and lie in both
    directions. Every ring present, width ≥ 1px, non-transparent, and measured
    at **7.01:1 dark / 7.34:1 light** against its ground (WCAG 1.4.11 wants
    3:1). The `.g*` backgrounds are asserted opaque separately — a transparent
    ground is what `--bg-2` produced and a ring-only check cannot see it.
  - **Must-FAIL twin:** `node scripts/verify-bug-183-css-tokens.mjs --pre-fix`
    — **all four sections bite** (40 findings). The pre-fix state is
    *synthesized inline*: the old rule text re-declared in a `<style>`, plus
    `--warn/--focus/--danger: initial`, which is the one value that genuinely
    un-defines a custom property. Nothing is anchored to `HEAD` or any moving
    revision (CONVENTIONS.md, "a must-FAIL proof must not be anchored to a
    moving baseline"), so it keeps biting after this fix lands. Section B needs
    its own fixture — a `<style>` cannot desync the four theme blocks on disk,
    so B would have passed honestly and proved nothing; it gets a
    self-contained 4-block fixture carrying both defects it exists to catch
    (a token missing from one block, and an alias re-declared per theme).
    Observed in pre-fix mode: every probe painted `rgb(255,0,255)`, every ring
    `NO RING`, every `.g*` background `rgba(0,0,0,0)`.
  - `npm run typecheck` — clean. `npm run gate` — **PASS** (leak-gate 0 hits
    across 1112 files, check-nul, typecheck). `npm run verify:bug-101-contrast`
    — ALL PASS, confirming the palette additions regress no contrast or
    ranking assertion.
  - Leak hygiene: the new script contains no username and no encoded home path
    — grepped for the account name, an absolute POSIX home prefix and the
    Windows profile-dir segment, no match. Its only fixture host is
    `https://example.invalid/oauth` and its only scratch is a
    `mkdtempSync(os.tmpdir(), 'cs-b183-chrome-')` browser profile removed in
    `finally`. Confirmed by `node scripts/leak-gate.mjs --summary`.
- **Decided for you (two judgment calls, both reversible in one line):**
  1. **`--danger` was defined rather than reported as ambiguous.** Leaving it
     undefined would have left a permanent exception in the section-A sweep,
     which is the assertion meant to stop this class recurring — one waiver and
     the guard starts being ignored. Aliasing it to `--st-high` picks no new
     colour: `--st-high` is already declared in all four blocks, is already
     theme-aware, and at `#A8503A`/`#CC7B60` is *quieter* than the `#c0392b`
     the fallbacks were shipping, so this moves toward the no-red house rule
     rather than away from it. Caveat, stated plainly: `--st-high`'s own
     comment scopes it to the tracker's tags/badges, and this widens that. If
     the redesign lane wants a distinct danger tone, it is one line in `:root`.
  2. **`.modelfree-set` and `.provider-error` were repaired, not just
     reported** — both are the identical defect inside the file I own, and the
     charter's sweep instruction says to fix what is clearly the same bug.
- **Could not test:** (a) no visual/screenshot review — this is a measured
  computed-style proof, so nothing here says the repaired controls look *right*
  next to their neighbours, only that they resolve, adapt and focus correctly;
  the following redesign lane should eyeball them. (b) The `prefers-contrast`
  and `forced-colors` media paths are not exercised — the file declares no
  rules for either, so there is nothing to assert, but a future high-contrast
  mode would need its own block added to section B's parity set. (c) Real
  keyboard traversal of the add-account flow was not driven end to end (the
  flow needs a live OAuth session); `:focus-visible` was forced on the real
  markup instead, which proves the CSS but not the tab order. (d) No npm script
  alias was added for the new suite — `package.json` is outside this lane's
  ownership; whoever lands this may want `verify:bug-183-css-tokens`.
- **Still open / handoff:** nothing open in this ticket's scope. Note for the
  closer, on the filer's ARCH question: this fix converts that suspicion into a
  **mechanical guard** rather than a third instance waiting to happen — section
  A of the new suite is exactly the "how theme tokens get audited" check the
  filer wondered about, and section B guards the four-block sync. If a third
  instance still appears *after* this suite is wired into the gate, that is the
  signal for an ARCH ticket; before then, the guard should be given a chance to
  do its job.
- **Symptom of a deeper design flaw?** no — but only because the standing
  assertion above now exists. Without it the answer would be yes: two
  independent sweeps found the same class within one session, and the cause is
  structural (CSS fails silently and no tooling read the token vocabulary).
- **Git:** all work left unstaged, per the lane rule. Files:
  `public/styles.css`, `scripts/verify-bug-183-css-tokens.mjs` (new).
