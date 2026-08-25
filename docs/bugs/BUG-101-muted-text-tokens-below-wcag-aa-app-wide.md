```orchard-ticket
{
  "id": "BUG-101",
  "type": "bug",
  "title": "Muted text failed accessibility contrast across the app",
  "summary": "Muted text now meets accessibility contrast requirements while preserving its visual hierarchy. Rendered contrast checks cover both themes, and visual review covered affected surfaces. The footer’s transient activity count also received distinct styling.",
  "impact_if_we_wait": "The repaired contrast remains guarded, so waiting causes no accessibility regression. The exposure is limited to optional response-summary styling refinements, not data loss, functionality, or the shipped contrast correction.",
  "current_need": "Treat the ticket as closed: the pre-fix case failed, corrected contrast passed, affected surfaces were reviewed, and standing checks stayed clean.",
  "severity": "medium",
  "area": "App text contrast",
  "reported": "2026-08-14",
  "reported_by": "bug-hunt workflow",
  "owner": "you",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-18",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Informational text meets WCAG AA contrast against every surface where it appears",
    "Muted text retains a visible hierarchy in light and dark themes",
    "Decorative text exceptions are explicitly documented",
    "Footer activity is visually distinct from permanent session properties",
    "The zero-agent footer has no dangling separator",
    "Automated checks reject future contrast regressions"
  ],
  "code_refs": [
    {
      "path": "public/styles.css",
      "symbol": "--ink",
      "note": "Text colour token included in the app-wide contrast audit"
    },
    {
      "path": "public/styles.css",
      "symbol": "--ink-2",
      "note": "Muted text colour token included in the app-wide contrast audit"
    },
    {
      "path": "public/styles.css",
      "symbol": "--ink-3",
      "note": "Muted text colour token included in the app-wide contrast audit"
    },
    {
      "path": "public/styles.css",
      "symbol": "--ink-4",
      "note": "Quietest text colour token included in the app-wide contrast audit"
    }
  ],
  "related": [
    {
      "id": "BUG-095",
      "relation": "recurrence_of"
    },
    {
      "id": "BUG-098",
      "relation": "recurrence_of"
    },
    {
      "id": "BUG-100",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [
    "BUG-095",
    "BUG-098"
  ],
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
    "archived_path": "docs/bugs/archive/BUG-101-muted-text-tokens-below-wcag-aa-app-wide.md",
    "sha256": "1e0a7cb27f201f344e2bc6aa7e27c0568da6cda72e6ed208345856d750a0dfa5",
    "bytes": 37110,
    "original_title": "muted text tokens fall below WCAG AA app-wide (3rd instance this session; audit the tokens, don't patch the third case)",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the supplied ticket text; the class diagnosis, shipped changes, measurements, footer work, design refinements, risks, and executed checks are represented.",
    "dropped": []
  }
}
```

# BUG-101 — Muted text failed accessibility contrast across the app

## Diagnosis

Three contrast failures appeared during one review session. Functional assertions had passed because they cannot assess rendered colour contrast. The composer footer was the third instance: its muted text measured 2.09:1 in light mode and 2.92:1 in dark mode, below WCAG AA thresholds. Fixing that use alone would have left the shared token class defective.

## Evidence

The pre-fix run with the old colour values injected exercised 16 cases and exposed the known failures. After correction, `verify:bug-101-contrast` passed 28/28. `verify:feat-083` passed 22/22, `verify:ui` passed 7/7, `verify:bug-100-footer-label` passed 14/14, and `verify:feat-083-adversarial` passed 170/170. Another recorded pass tally was 16/16. The standing `leak-gate` check was clean. The ticket also records visual signoff on the rendered result.

## Implementation notes

The correction audited shared text tokens against their actual backgrounds in both themes instead of patching the footer alone. Failing values were raised while retaining the muted hierarchy. The footer’s transient agent count was distinguished from permanent session properties.

Two response-summary refinements were recorded without recommendations: whether a high-importance item inside a low-importance group should retain full emphasis, and whether dark-mode section labels should use the stronger light-mode ranking ladder. They do not alter the shipped accessibility correction.

## Verification plan

Compute rendered contrast for audited token and surface combinations in both themes, rejecting informational text below 4.5:1 unless a legitimate large-text or decorative exception is documented. Render the idle and active footer, digest card, and chips in both themes. Check the zero-agent footer for a dangling separator. Preserve the established digest ladder and group-over-item hierarchy.

## Migration and rollback

The change is limited to shared colour tokens, their affected text treatments, and the footer activity presentation. Rollback would restore the former colour values, but doing so would reintroduce measured WCAG AA failures and should also remove or update the matching contrast expectations.

## Risks

Functional risk is low. The main risk is flattening the intended visual hierarchy while increasing contrast, or changing established digest emphasis relationships. Shared tokens affect many surfaces, so visual review across both themes remains necessary.

## Activity log (APPEND-ONLY)
### 2026-08-14 — orchestrator
- Filed after the third measured contrast failure in one session, from the unbiased visual review of the
  BUG-100 footer fix (which otherwise resolved the alarming-content complaint and got the width/truncation
  right). Escalated from a one-off fix to a token audit per §N.

### 2026-08-14 — worker (lane: public/styles.css, public/app.js footer+empty-state, new guard)

**Audit — measured contrast, token × surface (rendered pixels via CDP over the real styles.css), BOTH themes.**
Surfaces a token actually carries small informational text on: `--window` `--rail` `--sunken`.

BEFORE (failing pairs in **bold**, all < 4.5:1 AA):

| token | LIGHT win / rail / sunk | DARK win / rail / sunk |
|-------|---------|---------|
| --ink   | 16.66 / 15.64 / 14.83 | 14.99 / 15.49 / 13.89 |
| --ink-2 | 6.28 / 5.90 / 5.59 | 7.01 / 7.24 / 6.50 |
| --ink-3 | **3.11 / 2.92 / 2.77** | **4.22 / 4.36 / 3.91** |
| --ink-4 | **2.09 / 1.96 / 1.86** | **2.71 / 2.80 / 2.51** |
| footer `.fine` (was --ink-4) | **2.09** (matches ticket's #AEB5B0/#FFFFFF) | **2.71** (#565D58/#131513; ticket cited 2.92 — same sub-3.0 failure) |

Both `--ink-3` and `--ink-4` failed on every real text surface. `--ink-4` has **129 foreground-`color:` uses** — it is the app's quietest TEXT tier (mono timestamps, paths, verdicts, eyebrows, "N mounts", the footer label), NOT decoration — so reassigning was wrong; the 4-tier scale had to be raised in place.

AFTER (committed) — all 28 audited pairs pass (guard output):

| token | LIGHT win / rail / sunk | DARK win / rail / sunk |
|-------|---------|---------|
| --ink   | 16.66 / 15.64 / 14.83 | 14.99 / 15.49 / 13.89 |
| --ink-2 | 7.34 / 6.89 / 6.53 | 7.01 / 7.24 / 6.50 (unchanged) |
| --ink-3 | 5.94 / 5.58 / 5.29 | 5.64 / 5.83 / 5.23 |
| --ink-4 | 5.19 / 4.88 / 4.62 | 5.01 / 5.18 / 4.65 |
| footer label `.fine` (--ink-3) | 5.94 | 5.64 |
| footer count `.fine-run` (--ink-4) | 5.19 | 5.01 |

**What I changed (values, hierarchy PRESERVED — ordering intact, re-cut on perceptual lightness per BUG-095):**
- `--ink-3`: light `#8C948F → #606562`, dark `#737B76 → #8E8F8B`.
- `--ink-4`: light `#AEB5B0 → #696E6B`, dark `#565D58 → #858683`.
- `--ink-2`: light `#5A625E → #535755` (darkened ~1 step) to open room for four ORDERED AA tiers; **dark `--ink-2` unchanged** (already 6.50 on sunken). `--ink` unchanged.
- Ladder stays a clear descent: light 16.66 / 7.34 / 5.94 / 5.19 · dark 14.99 / 7.01 / 5.64 / 5.01. Bottom two are compressed (forced by keeping the top muted while clearing the 4.5 floor) but remain a visible step, reinforced by the smaller sizes `--ink-4` is used at. The **3.0 large-text allowance is NOT used** — every value clears 4.5 on its real surfaces; the app's muted text is all small (9.5–12px), so the allowance does not legitimately apply and I did not lean on it.
- Footer `.fine` moved `--ink-4 → --ink-3` (the isolation/access label is safety-relevant tertiary text, not the quietest tier).

**Exempted (documented, NOT silently left failing):**
- `--ink-4` on `--hair` / `--hair-2` / `--desk` (4.10–4.26, sub-4.5): no read-critical `--ink-4` TEXT renders there — a hovered/current row promotes its text to `--ink`; `--desk` is the bare desktop behind the window, no text.
- `--ink-4` as borders / dots / dividers / dashed outlines / ornament glyphs (carets, tw-triangles) and the moss dot: incidental / UI-component tones (WCAG 1.4.3 / 1.4.11), not body text. Raising the token value made them slightly darker — benign or beneficial (focus/hover borders, status dots, group separators read a touch stronger; opacity-damped dividers stay faint).
- Disabled-state text (`.mi[disabled]`, `.qacts .solid:disabled`, `.tv-btn:disabled`, `.prow[disabled]`, `.trow.off/.gone`): WCAG exempts inactive components; incidentally they now clear 5:1 anyway.

**Footer structure (BUG-101 review fold-in).** The three segments (`Direct` · `full access to this machine` · `2 agents running`) were one flat run-on. New `sayIso()` in app.js renders the transient count in a `.fine-run` span set apart from the permanent isolation label: quieter tone (`--ink-4` vs the label's `--ink-3`) + the **moss "alive" dot** as its separator instead of another `·` (the app reserves moss for a running agent — structure now matches meaning). Cap (88) and truncation order preserved: the count is dropped FIRST when tight; the label always survives (BUG-100 footer-label suite 14/14 still green; textContent stays under cap). The moss dot is a ~7px CSS `::before` ornament (exempt) and costs no textContent budget.

**Empty state (zero agents) — verified.** Resting footer (`restLabel()`/`sayIso` with no activity) renders `Direct · full access to this machine` with NO trailing separator and no `.fine-run` — clean, no dangling `·`, no dead strip (by construction: the moss-dot separator only exists inside `.fine-run`, which is only appended when there IS activity). Captured: `/tmp/iv-orchard/a11y-footer-idle.png` + `-dark`.

**Automated guard (`scripts/verify-bug-101-contrast.mjs`, `npm run verify:bug-101-contrast`).** Renders the real `styles.css` cascade (token×surface swatch matrix + the real `.fine`/`.fine-run` footer markup) in headless Brave over CDP (free port, PID-kill only, never :4317), reads getComputedStyle pixels, computes true contrast, FAILS below 4.5:1. **Bites both directions:**
- `--pre-fix` (old hexes injected): 16/16 known failures reported (footer light **2.09**, dark **2.71**; ink-3/ink-4 across all surfaces) — exit 1.
- committed: **28/28 pass** — exit 0.

**Anti-regress — re-measured, all HELD:**
- BUG-095 digest item ladder (hardcoded, untouched): light **14.83 / 8.13 / 4.67** on the sunken card; group-break > item-break is structural (border rules), unchanged.
- BUG-098 DECISIONS eyebrow **4.67** — held EXACTLY by re-pinning light `--dg-eye-dec-ground` to absolute `#494C4A` (was `color-mix(--ink-2 70%, --ink)`, which would have drifted to 4.87 under the darker `--ink-2`); ref chip `--dg-ref-ink` untouched (**5.36** raw / unchanged); dark digest tokens untouched. Group labels (done 4.89 / in-flight 4.98 / fyi 6.53) moved UP only (safe).
- Solid-vs-dashed chip distinction and rail hues intact (visual: `a11y-digest.png` + `-dark`); the greyscale FYI/default rail darkened slightly with `--ink-4` but stays subordinate — hue, not lightness, carries the group distinction. **Flagged for the visual reviewer.**
- Suites: verify:feat-083 **22/22**, verify:feat-083-adversarial **170/170**, verify:bug-100-footer-label **14/14**, verify:ui **7/7**, typecheck **0 errors**, leak-gate **PASS (0 hits / 441 files)**.

**Screenshots (looked at all six):** `/tmp/iv-orchard/a11y-footer-idle.png`, `a11y-footer-busy.png`, `a11y-digest.png` (+ `-dark` each). Footer: label legible in both themes, count set apart by the moss dot, idle clean. Digest: hues distinct, low-importance item now legible, chips preserved.

**Risk bucket / independent verify.** UI/visual + a11y, but it touches a regression-prone stylesheet AND another worker's fresh BUG-098/BUG-095 tuning (via `--ink-2` and the digest eyebrow). Per the standing rule I flag that an **independent clean-room verify pass is warranted** (the app-wide `--ink-2` darkening perturbs secondary text everywhere; a second fresh-context reviewer should confirm no surface regressed beyond the audited set). The unbiased visual review that follows should specifically eyeball: the app-wide secondary-text darkening (light `--ink-2`), the slightly stronger `--ink-4` structural tones (dividers/dots/the FYI digest rail), and the footer moss-dot treatment.

### 2026-08-15 — worker (fix2: unbiased-review follow-up, lane: public/styles.css, public/app.js, the contrast guard)

The unbiased visual reviewer returned **STILL NEEDS WORK** on two LIGHT-ONLY defects. Both were RANK
failures, not floor failures — every value was already above 4.5:1, which is exactly why the first pass
and the guard both missed them. Dark measured clean on every axis and is left alone.

**DEFECT 1 — the quietest token was doing double duty as TEXT and as STRUCTURE.**
Raising `--ink-4` for legibility dragged every rail/divider/dot up with it. Light rail ranking had
inverted: the lowest-importance group carried the heaviest mark.

Fix — decouple, don't re-lower. New global **`--ink-4-struct`** = the quietest STRUCTURE tone
(light `#AEB5B0`, the pre-raise weight; dark `#858683`, i.e. unchanged — dark structure measured
correct). `--ink-4` stays the quietest TEXT tone at its AA value. Plus a card-local
**`--dg-rail-dec`** (light `#855F20`) so the DECISIONS rail — the palest of the four hues raw — is
also the strongest mark, without touching the global `--st-needs` (the tracker's tags) or the tuned
`--dg-eye-dec-ground`.

| rails on the sunken card | DECISIONS | IN-FLIGHT | DONE | FYI | ordered by importance? |
|---|---|---|---|---|---|
| light BEFORE | 3.39 | 4.13 | 4.02 | **4.62** | NO — inverted, FYI loudest |
| light AFTER  | **5.11** | 4.13 | 4.02 | **1.86** | YES |
| dark (untouched) | 7.06 | 6.68 | 6.25 | 4.65 | YES |

**Audit — every other structural consumer of `--ink-4`.** 14 declarations moved to `--ink-4-struct`
(all had inflated the same way): the `.row.win` `·` glyph, the pinned-block divider + `pin-last`
closing edge, the `.sess-status` base/idle dot, both `.prov-state` dots, the `.risk .why` /
`.wiring-confirm` / ceremony / `.rowmenu .mnote.arm` quote rails, the `.supersede` rule, the
`.needs-card.observation` rail, and the digest group rail. **Deliberately NOT moved** (reported, with
the reason): focus/hover borders (~27 declarations), the disclosure carets/`.tw`/`.cx`/`.sect-car`
glyphs, the `.tray .ic` pending ring, the `.trow` box, the `.sw` knob, the `.qcard` pending edge, the
`.permline` risk edge, and **the dashed inert-chip outline** — those are affordances where visibility
IS the job (WCAG 1.4.11 wants ≥3:1), so the raise was a real improvement there. That is also what
preserves the dashed chip's `~1.13 → 2.42:1` gain the reviewer asked us to keep. The split is
semantic (quiet ornament vs affordance), not mechanical.

**DEFECT 2 — the footer's tiers 3 and 4 were the same grey, and its separators were ranked backwards.**
Three footer-LOCAL tokens (the strip only ever renders on `--window`, so it can be tuned without
moving any other surface); dark's separator tones are byte-identical to before.

| footer, light | BEFORE | AFTER |
|---|---|---|
| label `.fine` | 5.94 (`#606562`) | 5.94 — unchanged |
| count `.fine-run` | 5.19 (`#696E6B`, 9 RGB levels off the label) | **4.76** (`#6F7471`, 15 levels) + 9.5px + `.04em` tracking + tabular figures |
| MINOR break (`·` inside the label) | **5.94** — full text weight | **3.96** (`--fine-sep #7C817E`) |
| MAJOR break (moss accent dot) | **3.54** — a grey speck | **5.51** (`--fine-dot #5C6F43`) |

| footer, dark | BEFORE | AFTER |
|---|---|---|
| label / minor `·` | 5.64 | 5.64 — unchanged |
| MAJOR dot | 6.74 | 6.74 — unchanged (already out-ranked the minor break) |
| count | 5.01 (9 levels off the label) | 4.75 (13 levels) + the same size/tracking cue |

The label↔count distinction is now carried by THREE cues (register/size, tracking, accent separator)
rather than one 9-level tone step — the tone ladder itself has no room to widen in light without
either dropping tier 4 below AA (the binding floor is `--ink-4` on `--sunken`, 4.62, ~0.12 of
headroom) or collapsing tier 3 into tier 2. All four tiers remain ≥4.5:1. The label's `·` is now
rendered inside a `.fine-sep` span by a new `appendLabel()` in app.js; `textContent` is
byte-identical, so the BUG-100 cap (88) and truncation order are untouched.

**Guard extended — it now asserts RANK, not just floors** (the thing that broke). Same 28 AA pairs,
plus a ranking block: rails must descend with importance and the major break must out-rank the minor
one, in both themes. Two must-FAIL modes:
- `--pre-fix` (the pre-BUG-101 hexes): **16/16** known AA failures reported — exit 1.
- `--pre-fix2` (NEW — re-couples structure to the text tier and un-ranks the footer): reports exactly
  the reviewer's two defects — `light: rails not in importance order — decision 3.39 > in-flight 4.13
  > done 4.02 > fyi 4.62` and `light: minor separator (5.94) out-ranks the major one (3.54)` — exit 1.
- committed: **28/28 pairs pass + rankings hold in both themes** — exit 0.

**Tier-2 scope gap (the reviewer's flag) — closed.** `--ink-2` carries no text on the three reviewed
surfaces, so the light darkening (`#5A625E → #535755`) had never actually been looked at. The surfaces
that DO exercise it: prose body/`em`/blockquote/`md-table` cells, `.tool` names + `.out`, `.ran`/`.lag`
agent rows, `.permline b`, `.mrow .dst`, `.risk .l`, `.wiring-row .l`, `.frozen b`, `.grp-note[data-ok]`,
`.seal .perm[data-risk]`, popover/settings labels. Captured as `fix2-tier2-surface.png` (+ `-dark`) and
measured: the change moved light `--ink-2` **6.28 → 7.34** on `--window` (6.89 rail / 6.53 sunken) —
strictly MORE contrast, so it cannot have hurt legibility, and the descent stays clean
(16.66 / 7.34 / 5.94 / 5.19). Its downstream consumers were re-measured too: the digest eyebrows are
`decision 4.67` (BUG-098's tuned value, held exactly), `in-flight 4.98`, `done 4.89`, `fyi 6.53`. **No
regression found on any tier-2 surface.**

**Anti-regress — re-measured, all HELD:** digest text tones byte-identical (light 14.83 / 8.13 / 4.67,
dark 13.89 / 8.20 / 4.80), importance still tone-only with no bold; group hairline still out-ranks the
item rule; solid-vs-dashed chip distinction intact (link chip 5.36, dashed outline 2.42); idle footer
clean and centred with no orphan dot. Suites: verify:feat-083 **22/22**, verify:feat-083-adversarial
**170/170**, verify-bug-100-footer-label **14/14**, verify:ui **7/7**, typecheck **0 errors**, leak-gate
**PASS (0 hits / 443 files)**, verify:bug-101-contrast **28/28 + rankings**.

**Screenshots (headless Brave over CDP, free port, PID-kill; looked at all eight):**
`/tmp/iv-orchard/fix2-digest.png`, `fix2-footer-idle.png`, `fix2-footer-busy.png`,
`fix2-tier2-surface.png` (+ `-dark` for each). The real-app footer render from the BUG-100 suite
(`/tmp/iv-orchard/footer-after.png`) confirms the live `sayIso` path produces the new structure.

**An unbiased visual re-review is expected.** Worth eyeballing specifically: the FYI rail at 1.86:1
(deliberately the quietest mark on the card — is it *too* faint at 1x?), the darkened light moss dot
(still reads as moss, not charcoal?), and the 9.5px transient count.

### 2026-08-15 — worker (fix3: make the GUARD systemic, lane: public/styles.css + the contrast guard)

Round three on ONE defect. The primary deliverable this round is the guard, not the colours: rounds 1
and 2 each corrected the channel that had just broken, and the inversion simply moved into the next
channel nobody was asserting. Round 1 fixed the rails; round 2 shipped green while the **eyebrows had
inverted in exactly the same way** (FYI 6.53 loudest, DECISIONS 4.67 faintest — the FYI group
simultaneously carried the loudest label and the faintest edge).

**Root cause.** Importance was hand-tuned PER CHANNEL — each group's eyebrow was mixed against
whatever global token happened to be nearby (`--ink-2`), so nothing held the channels consistent with
each other. And the automated guard asserted only the rails. An unasserted channel is where the next
inversion hides.

**CHANNEL AUDIT — every property that differs between `.digest-decision / -in-flight / -done / -fyi`.**
Searched `public/styles.css` and `public/lib/digest.js` for per-kind rules. Exactly **two** channels
vary by group:

| # | channel | how it varies | asserted now? |
|---|---------|---------------|---------------|
| 1 | **rail** — `.digest-group` `border-left-color` | `--dg-rail-dec` / `--st-prog` / `--st-done` / `--dg-rail-fyi` | YES |
| 2 | **eyebrow** — `.digest-group-label` `color` | kind hue 60% over the `--dg-eye-*-ground` ladder | YES (new) |

Everything else on the card is INVARIANT across groups and therefore cannot encode a ranking: rail
WIDTH (2px for all four), group padding, the group divider (`--hair`) and item rule
(`--dg-item-rule`), the eyebrow's size/weight/letter-spacing/transform, the card ground (`--sunken`),
and the ref-chip treatment (varies by ref TYPE, not group). The group's DOM position is fixed by
`KIND_ORDER` in `public/lib/digest.js` — positional, not a weight. The item ink tiers
(`imp-high/med/low`) vary by ITEM importance, not by group, and stay covered by the BUG-095 ladder.

**RANK TABLES — before (HEAD `d97db6c`) → after, both channels, both themes.** Measured on the sunken
card from rendered pixels.

| channel / theme | DECISIONS | IN-FLIGHT | DONE | FYI | ordered? |
|---|---|---|---|---|---|
| rails light BEFORE | 5.11 | 4.13 | 4.02 | **1.86** | yes, but a cliff |
| rails light AFTER | 5.11 | 4.13 | 4.02 | **2.75** | yes, gentle |
| rails dark (untouched) | 7.06 | 6.68 | 6.25 | 4.65 | yes |
| eyebrow light BEFORE | **4.67** | 4.98 | 4.89 | **6.53** | **NO — inverted** |
| eyebrow light AFTER | **5.49** | 5.19 | 5.03 | **4.75** | yes |
| eyebrow dark (untouched) | 6.78 | 6.56 | 6.32 | 6.50 | yes (flat, within tolerance) |

**Fix 1 — the light eyebrow ladder (the ordering fix).** Every eyebrow is
`color-mix(kind hue 60%, ground)`, so the GROUND is the ladder. Four card-local grounds replace the
"whatever `--ink-2` is" default, each solved to land its eyebrow on a target contrast rather than
hand-tuned: `--dg-eye-dec-ground #2F312F`, `--dg-eye-prog-ground #4D504E`,
`--dg-eye-done-ground #4F5250`, `--dg-eye-fyi-ground #686C69`. The 60% hue trace is uniform across
all four — only the ground moves, so "which kind" still registers by hue while "how important" reads
by weight. Result 5.49 / 5.19 / 5.03 / 4.75: a gentle descent in the character of dark's, **every
step ≥ 4.5:1**. BUG-098's DECISIONS eyebrow is **raised** from its tuned 4.67 to 5.49, never lowered,
so its AA fix survives. Dark restores all four grounds to `--ink-2` — byte-identical to before.

**Fix 2 — the light rail cliff.** New card-local `--dg-rail-fyi` (light `#8E9490` → **2.75:1**; dark
`var(--ink-4-struct)`, unchanged). fix2 had handed FYI the global structural token (1.86:1), which
over-corrected: the only rail in either theme under 3:1, and a cliff after three near-equal rails.
Light now decays 5.11 / 4.13 / 4.02 / 2.75 — FYI still unambiguously the quietest mark, but part of
the ladder instead of falling off it. Card-local, so the **14 other `--ink-4-struct` consumers**
(dividers, dots, quote rails) do not move.

**GUARD — now systemic (`scripts/verify-bug-101-contrast.mjs`).** The ranking block was rewritten
around a `CHANNELS` table instead of one hard-coded rail check. For **each** channel, in **both**
themes, it asserts:
- the **importance order** DECISIONS ≥ IN-FLIGHT ≥ DONE ≥ FYI, with a **stated tolerance** for
  intentionally near-equal neighbours — rails `tol 0.15` (in-flight/done sit ~0.11 apart by design),
  eyebrows `tol 0.35` (dark's eyebrows are deliberately near-flat; its done 6.32 / fyi 6.50 pair is
  0.18 wide). Both tolerances are far below the defects they must catch — the eyebrow inversion was
  1.78 wide.
- a **floor**: rails ≥ 2.5:1 (non-text marks, but fix2 proved a rank fix can over-correct into
  invisibility), eyebrows ≥ 4.5:1 (AA — they are text).
Plus the existing footer major/minor separator hierarchy and the 28 AA token×surface pairs. Adding a
third group-varying channel means adding one row to `CHANNELS`; the comment block says so.

Three must-FAIL modes, all confirmed biting:
- `--pre-fix` (pre-BUG-101 hexes): **16/16** AA failures — exit 1.
- `--pre-fix2` (re-couples structure to the text tier, un-ranks the footer): `light: rails not in
  importance order (tol 0.15) — decision 3.39 > in-flight 4.13 > done 4.02 > fyi 4.62` +
  `light: minor separator (5.94) out-ranks the major one (3.54)` — exit 1.
- `--pre-fix3` (**NEW** — restores the fix2 eyebrow grounds and the 1.86 FYI rail, i.e. HEAD):
  `light: eyebrows not in importance order (tol 0.35) — decision 4.67 > in-flight 4.98 > done 4.89 >
  fyi 6.53` + `light: rails below the 2.5:1 floor — fyi 1.86` — exit 1. **This is what a green fix2
  would now have failed on.**
- committed: **28/28 AA pairs pass + every channel ranks + every floor holds, both themes** — exit 0.

**Harness defect fixed (`/tmp/iv-orchard/shoot.mjs`).** The tier-2 exemplar captioned "Quoted guidance
rendered at --ink-2" was a `.prose blockquote` — there is **no `.prose blockquote` colour rule** in
styles.css, so it inherited PRIMARY ink and the sample proved nothing about tier 2. Replaced with a
`.gv-doc .prose p` block (a real `--ink-2` body-copy consumer, styles.css:2787) and re-captioned. The
new capture visibly renders grey against the primary-ink paragraph above it — honest evidence at last.

**PRESERVED (re-measured, all HELD):** the corrected rail ORDER (both themes); the footer separator
hierarchy (light major dot 5.51 > minor `·` 3.96; dark 6.74 > 5.64) and the idle state's dropped
accent dot; the count's size/tracking/tabular-figure step; the moss identity of the accent dot; all
four text tiers ≥4.5:1 (light 16.66 / 7.34 / 5.94 / 5.19, dark 14.99 / 7.01 / 5.64 / 5.01);
digest text hierarchy tone-only with no bold; solid-vs-dashed chip distinction; **all of dark mode
byte-identical**.

**Anti-regress:** verify:feat-083 **22/22**, verify:feat-083-adversarial **170/170**,
verify-bug-100-footer-label **14/14**, verify:ui **7/7**, typecheck **0 errors**, leak-gate
**PASS (0 hits / 443 files)**, verify:bug-101-contrast **28/28 + all channel rankings**.

**Screenshots (headless Brave over CDP, free port, PID-kill; looked at all eight):**
`/tmp/iv-orchard/fix3-digest.png`, `fix3-footer-idle.png`, `fix3-footer-busy.png`,
`fix3-tier2-surface.png` (+ `-dark` each). **The light card now decays like dark's**: DECISIONS is the
deepest ochre label over the strongest ochre rail, IN-FLIGHT slate, DONE moss, and FYI a mid-grey
label over a visible-but-quietest grey rail. Side by side, light and dark now have the same rhythm —
no group is loud in one channel and faint in the other.

### 2026-08-15 — worker (fix4: close a proven hole in the guard — GUARD + COMMENT ONLY, no pixels moved)

The unbiased reviewer **SIGNED OFF the rendered card** (every claimed value reproduced, light now decays
coherently in both channels, FYI rail correctly balanced at 2.75:1, dark untouched and correct, footer and
tier-2 clean) but returned **STILL NEEDS WORK on the GUARD**, with proof. This round changes **no colour
value** — only `scripts/verify-bug-101-contrast.mjs` and one stale design comment.

**THE HOLE (reviewer-proven).** The eyebrow channel used `tol: 0.35` and compared **adjacent pairs only**.
Light's shipped eyebrow ladder is 5.49 / 5.19 / 5.03 / 4.75 — steps of **0.30 / 0.16 / 0.28**, i.e. *every
step is smaller than the tolerance*. So a **fully reversed** light ladder (4.75 / 5.03 / 5.19 / 5.49 —
today's values exactly inverted) slid straight through: the reviewer ran the shipped assertion logic and got
`shipped {"inv":[],"bf":[]}` and `REVERSED {"inv":[],"bf":[]}` — a clean PASS on a total inversion. The rail
channel (`tol 0.15`) bites when reversed; the eyebrow channel did not. **The guard caught the round-2 defect
only because that inversion happened to be 1.78 wide.** At the amplitude round 3 actually ships, the same
defect class was invisible to it — which defeats the entire purpose of round 3.

**FIX 1 — a CUMULATIVE first-vs-last assertion, per channel per theme**, alongside (not replacing) the
adjacent-pair check. Adjacent comparison with a tolerance wider than the step size *structurally cannot*
detect a gradual inversion at any amplitude; the cumulative check can, because a reversal always shows up as
a negative end-to-end span no matter how it is distributed across the steps. `span` is a stated number per
channel per theme:

| channel / theme | measured span (top − bottom) | required |
|---|---|---|
| rails light | 5.11 − 2.75 = **2.36** | ≥ 0.5 |
| rails dark | 7.06 − 4.65 = **2.41** | ≥ 0.5 |
| eyebrows light | 5.49 − 4.75 = **0.74** | ≥ 0.5 |
| eyebrows dark | 6.78 − 6.50 = **0.28** | ≥ 0.15 |

**FIX 2 — the tolerance is now PER-THEME, and light's eyebrow tolerance drops 0.35 → 0.15.** Decision and
justification: `0.35` was never about light. It existed *solely* because DARK's eyebrow ladder is
deliberately near-flat (6.78 / 6.56 / 6.32 / 6.50, where FYI sits **0.18 ABOVE** Done — a real small
inversion, intentionally absorbed). A single global number has to be loose enough for dark's flatness, which
forces light — a deliberate, well-separated ladder — to be audited far more loosely than it can afford.
Splitting per theme lets **light be strict (0.15, the same as the rails; its tightest real step is 0.16)
while dark stays permissive (0.35)**. The split is also *arithmetically required* for the cumulative check:
dark's whole eyebrow ladder spans 0.28, which is **less than its own 0.35 tolerance**, so the reviewer's
literal "span > tol" formulation is unsatisfiable in dark — span therefore had to become its own stated
number rather than being derived from tol. Rails keep `tol 0.15` in both themes (unchanged).

Both mechanisms now bite the reversal independently (belt and braces): the tightened light tolerance catches
each backwards step, and the span catches the ladder end to end.

**FIX 3 — `--pre-fix4`, reproducing the reviewer's demonstration exactly.** The new must-FAIL mode hands each
light group the **mirror kind's** eyebrow colour, so the measured ratios come out as exactly the reviewer's
reversed ladder. Confirmed biting:
```
light: eyebrows not in importance order (tol 0.15) — decision 4.75 > in-flight 5.03 > done 5.19 > fyi 5.49
light: eyebrows cumulative descent too small (decision 4.75 − fyi 5.49 = -0.74, needs >= 0.5)
```
All **four** must-FAIL modes re-confirmed after the change:
- `--pre-fix`: **16/16** AA failures reported.
- `--pre-fix2`: rail inversion + footer separator inversion — now **3** findings (the new cumulative check
  adds `rails cumulative descent too small (3.39 − 4.62 = -1.23)`).
- `--pre-fix3`: `rails below the 2.5:1 floor — fyi 1.86` + the eyebrow inversion, now also its cumulative
  failure (`4.67 − 6.53 = -1.86`) — **3** findings.
- `--pre-fix4` (NEW): the 2 findings above.
- committed: **28/28 AA pairs + every channel ranks adjacently AND cumulatively + every floor holds, both
  themes** — exit 0.

**FIX 4 — the stale design comment (public/styles.css, the rail-tint block).** It still read *"FYI now takes
the structural token (back to 1.86:1, subordinate again)"* — the **round-2** state — when FYI has been a
card-local `--dg-rail-fyi #8E9490` at **2.75:1** since fix3. These comments are the design record for this
card, so a wrong one is a trap for the next reader. Rewritten to keep the fix2 history (why Decisions got
`--dg-rail-dec`) and add the fix3 correction (why FYI is card-local at 2.75, not the 1.86 cliff).

**PRESERVED — nothing rendered changed.** No colour value was touched in this round; `public/styles.css` has
exactly one hunk and it is a comment. All 28 AA pairs, both rail rankings, both eyebrow rankings, all floors,
and the footer separator hierarchy measure byte-identical to fix3. typecheck **0 errors**. No re-render
needed (no visual change), per the mandate.

**LEAK-GATE — checked, and it FAILS on a PRE-EXISTING hit outside this lane.** `npm run gatekeeper` reports
`LEAK GATE: FAIL — 2 hit(s) in 1 file(s) across 443 files`, both in
`docs/bugs/FEAT-085-stop-hook-enforces-response-format.md:321` (an encoded home path + bare username inside a
quoted transcript filename, committed in `fd04c1c`). My working tree contained only `public/styles.css` and
`scripts/verify-bug-101-contrast.mjs`, neither of which is that file, so this is not a regression from this
round — but the repo gate is **red** and someone needs to scrub that line. **Flagged, not fixed** (out of
lane).

**TWO OPEN JUDGEMENT CALLS — recorded for the user, deliberately NOT decided by this worker.**
- **(a) Item-level importance ink vs group rank.** `.digest-item.imp-high|med|low` (14.83 / 8.13 / 4.67) is
  deliberately excluded from the group-ranking audit, on the grounds that it varies per **ITEM**, not per
  group. But nothing binds it to group rank: a high-importance item inside the **FYI** group would put a
  full-ink sentence on the quietest rail — precisely the round-2 style of cross-channel incoherence this
  ticket has spent three rounds eliminating. Today's fixture happens to decay monotonically down the card,
  which flatters the current design. **Should item ink be constrained relative to its group's rank (e.g.
  capped by the group's tier), or stay orthogonal to it?**
- **(b) Dark's near-flat eyebrows.** Dark measures 6.78 / 6.56 / 6.32 / 6.50, so dark's group ranking rides
  on the **rail alone** — the eyebrow channel carries essentially no importance signal there. This is
  currently treated as intentional (a hue trace, not a shout) and is what forces dark's loose 0.35 tolerance.
  **Is that intended, or should dark mirror light's deliberate ladder** (which would let both themes share
  one strict tolerance and delete the per-theme split)?

### 2026-08-18 — worker (guard extended: rendered CONTROL fills, not just token × surface)

FEAT-090's "Record answer" button shipped at **2.87:1** with this guard green. The blind spot was structural,
not an oversight in the pair list: the audit compares COLOUR TOKENS against SURFACES, and a control's real
pixel is neither — `opacity:.45` on a `--solid`/`--on-solid` pair (15.9:1 as tokens) composites to `#969896`
under a near-white label (2.85:1) in light and to `#757874` in dark, where it was the brightest fill on the
page. No token × surface pair can express that number.

Added, in the file's existing must-FAIL discipline: a CONTROLS harness (the real `.tv-decide` markup, the
pinned bar, and `.tv-btn.solid`) measured in both themes as COMPOSITED pixels — each element's own alpha ×
its `opacity`, over the first opaque ancestor ground. 13 controls × 2 themes, asserting:
1. an **enabled** control's label clears AA (4.5:1) against its own rendered fill;
2. a **disabled** control is AA-exempt only while it behaves like one — it must RECEDE (≤1.5:1 off its
   ground) and be less prominent than the enabled primary; a disabled control that stands off its ground is
   claiming attention, and anything claiming attention must also clear AA. Exemption is permission to be
   quiet, not permission to shout;
3. **parity** — the Decide card's primary fill must equal the app primary's (`.tv-btn.solid`), so a card's
   main action can never render weaker than the secondary form it supersedes.

New must-FAIL mode `--pre-fix5` re-injects the shipped `opacity:.45` disabled primary and reports 4 findings
(2.85 / 3.97 labels + both recede failures); committed CSS passes all 26 control rows. Same rule as the
ranking block: if a fourth channel of control state is ever added, add it to `CONTROLS` — that is the point.
