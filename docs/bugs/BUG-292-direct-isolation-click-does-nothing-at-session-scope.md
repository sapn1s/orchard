# BUG-292 — clicking an isolation option at session scope does nothing

- **Status:** VERIFIED/DONE — UX fix (aria-disabled project-only seg + .seg disabled style); independent HOLDS 00433981 (2026-11-19, anthropic fallback)
- **Severity:** medium
- **Area:** drawer (settings · Isolation & environment)
- **Reported:** 2026-11-10 by user
- **Verification-class:** fix ⟶ independent verification REQUIRED before DONE

## Symptom
Verbatim: "in settings clicking on direct to change session into host running,
nothing happens when clicking."

In Settings → Isolation & environment, with the scope lens set to **This
session**, the Isolation segmented control (Container / Sandbox / Direct) and the
Docker-daemon control (Sandbox / Host) look fully clickable — full opacity,
pointer cursor — but a click does nothing at all.

## Repro
1. Open a session (e.g. `/#/project/amazon-purchaser/session/<id>`).
2. Settings → Isolation & environment. Lens defaults to **This session**.
3. Click Container, Sandbox or Direct (or the Docker daemon's Host).
→ Nothing happens. No change, no feedback, no explanation on the control itself.
   (A hint below says isolation is project-scope only, but the control gives no
   sign it is unavailable and offers no way to act.)

## Expected
The per-session restriction is intentional and correct — isolation and the
lane-docker daemon are project-scope only (CONVENTIONS: "n is n, never
per-session"; changing them would rebuild every other session's container). The
defect is pure UX: a disallowed option must (a) READ as unavailable (dimmed,
not-allowed cursor, aria-disabled) and (b) a click must still DO something — not
be silently swallowed.

## Root cause
`public/lib/drawer.js`: at session scope both segmented controls set
`b.disabled = true` (native). A native-disabled `<button>` swallows the click
entirely, and `public/styles.css` had NO `.seg button:disabled` rule, so the
button rendered identical to a live option (opacity 1, cursor pointer). Measured
live on the reported session: `disabled=true, aria-disabled=null,
cursor=pointer, opacity=1` for all three isolation options.

## Fix
- `drawer.js`: new helper `lockProjectOnlySeg(b, focusKey)` — marks the button
  `aria-disabled="true"` (not native `disabled`, so it stays clickable) and wires
  a click to switch the lens to **This project** and flash the control, reusing
  the existing deep-link focus idiom (`d.focus` + `applyFocus`/`.focus-flash`). No
  isolation write occurs on that click. Applied to the isolation seg (`'iso'`) and
  the lane-docker seg (`'laneDocker'`).
- `styles.css`: `.seg button[aria-disabled="true"]` → `opacity .45; cursor
  not-allowed` (selected one `.6` so the current value stays legible). Luminance
  drop, not hue — holds in both themes.

## Context pack
- Files/functions in play: `public/lib/drawer.js` — `isolationPane()` (iso seg),
  `laneDockerGroup()` (docker seg), `lockProjectOnlySeg()` (new, next to
  `projectOnlyNote`), `applyFocus()`/`d.focus`; `public/styles.css` `.seg` block.
- The scope lens: `d.scope`, `#dScope [data-scope]`, `sessionOk = !!project()`.
- Related tickets: BUG-075 (direct sessions showed a container-only mount
  control), FEAT-139 (scope spine), FEAT-146 (settings pane by category).
- Repro test: `node scripts/verify-bug-292-session-iso-click.mjs`.
- Known dependencies: `public/lib/drawer.js` + `public/styles.css` currently also
  carry other lanes' uncommitted work (FEAT-200 / BUG-283) in the same tree — my
  BUG-292 hunks are isolated but not separable by file for a clean commit.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-11-10 — fixing lane (worker)
- **Understood:** The restriction is intentional (hypothesis 1 held — isolation
  is project-scope only); the defect is pure UX. Confirmed on the REAL reported
  session: at session scope all 3 isolation options were native-disabled yet
  opacity 1 / cursor pointer, so clicks were swallowed with no affordance and no
  way forward. Clicks at **project** scope were never broken.
- **Changed:** `public/lib/drawer.js` (lockProjectOnlySeg helper + the two
  `if (sessionScope)` lines for iso and laneDocker), `public/styles.css`
  (`.seg button[aria-disabled]` rules). New test
  `scripts/verify-bug-292-session-iso-click.mjs`. Unstaged (lane runs no git).
- **Verified:** (fixer's own run — necessary, not sufficient)
  - Live before/after on the real reported session, both themes: pre-fix
    `disabled=true, aria=null, cursor=pointer, opacity=1`; post-fix
    `aria-disabled=true, cursor=not-allowed, opacity .45/.6`, and a click on
    "Direct" switches the lens to This project + flashes the control + writes
    nothing. Screenshots: `docs/bugs/assets/BUG-292-prefix-session-iso-light.png`,
    `-postfix-session-light.png`, `-postfix-session-dark.png`.
  - `node scripts/verify-bug-292-session-iso-click.mjs` → ALL PASS, 27/0. Boots a
    scratch server (no git push/write to the real repo), drives the real drawer:
    (A) session-scope disabled-yet-forward in both themes; (B) PROJECT scope still
    persists `isolation: sandbox` to the registry (write path untouched); (C)
    non-vacuity — a synthesized pre-fix drawer.js (`b.disabled = true` restored),
    served via CDP Fetch interception, reddens section A by 8 assertions.
  - `npm run gate` → PASS (exit 0, unpiped).
  - Anti-regression `node scripts/verify-feat-146-settings-content.mjs` →
    128 pass / 11 fail, but ALL 11 are pre-existing/environmental and in untouched
    categories: the git-fixture precondition fails because the agent git-write
    guard refuses `git init` (the harness header itself declares this "not a
    product defect"), which cascades to every git-shape + git/services mutation
    check; plus one account 5-hour-window fixture quirk. The Isolation category
    renders with ZERO console errors at all widths/themes. None touch the seg /
    aria-disabled / `.seg` CSS I changed.
- **Verified-by:** PENDING — independent clean-room verify warranted (see below).
- **Still open / handoff:** (1) Independent clean-room pass:
  `node scripts/independent-verify.mjs --ticket BUG-292` — my fixture is author-
  written; a second context should confirm the click-forward behaviour and that
  no isolation write leaks at session scope. (2) Commit is blocked by the lane's
  no-git-write rule AND by `drawer.js`/`styles.css` carrying other lanes'
  uncommitted work — the orchestrator must decide how to land only the BUG-292
  hunks without picking up FEAT-200/BUG-283 work in the same files.
- **Symptom of a deeper design flaw?** no — a one-off: a project-only control was
  made unreachable with the native `disabled` attribute and no matching `.seg`
  disabled style. (A latent class question — "should every project-only control
  at session scope route forward uniformly?" — is now answered in one place by
  `lockProjectOnlySeg`, which both call sites share.)

### 2026-11-10 — orchestrator
- **orchestrator decision:** Orchestrator decision: harm class = contained render (WA §I rounds table → zero independent rounds); the DOM property check over the real page in both themes plus the synthesized pre-fix must-FAIL in scripts/verify-bug-292-session-iso-click.mjs is the proof. Closed. Landing note: drawer.js/styles.css also carry FEAT-200/BUG-283 uncommitted hunks — commit BUG-292's hunks separately.

### 2026-11-19 — verify lane
- **Verification recorded:** dispatch anthropic run 00433981-62fb-495c-bb77-a5ea61f4b3a3 — VERDICT: HOLDS — mixed-state candidate 370280dd6a91 — Clean-room IV (OpenAI quota -> Anthropic fallback). 17/0 adversarial: session click writes nothing, Enter path, laneDocker host persists after forward. Author suite 27/0 re-run. Intent met: Direct now routes to This project where it applies.. Typed entry in verification-ledger.json; this line is an echo, not proof.
