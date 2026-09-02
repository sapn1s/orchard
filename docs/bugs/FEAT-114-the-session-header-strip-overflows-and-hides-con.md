```orchard-ticket
{
  "id": "FEAT-114",
  "type": "feature",
  "title": "The session header strip overflows and hides controls the user cannot reach",
  "summary": "The session header (.seal strip) was one flex row with overflow-x:auto and a hidden scrollbar, so past the visible width every chip clipped off-screen unreachable. With the rail open, the process, integration and permission chips were invisible. Several chips had no tooltip, provider choice lived only in the composer tray, and the collapse button never showed how to reopen it.",
  "impact_if_we_wait": "Controls that exist cannot be seen or reached — running processes, integrations and the permission mode drop off the right edge whenever the window is not wide, the normal case with the rail open. A sidebar a user cannot tell how to reopen reads as gone.",
  "current_need": "Categorise the strip so only glance-worthy signal stays visible, never clip, give every non-obvious control a tooltip, surface the provider choice as a selector, and make the sidebar reopenable discoverably.",
  "severity": "medium",
  "area": "Web UI — session header strip",
  "reported": "2026-09-02",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "in_verification",
  "human_action": "review",
  "updated": "2026-09-02",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "The strip never clips: every chip stays reachable at any width, verified in a real headless browser from 1440 to 520px in both themes.",
    "Interactive controls and informational readouts are visually distinct: navigation and selectors read as pressable pills; git/processes/integrations/permission read as quiet readouts.",
    "Every non-obvious control has a tooltip: isolation, instructions, provider, git, processes and permission.",
    "The provider (Anthropic/OpenAI) choice is a header selector that opens the existing provider popover and shares state with the tray control.",
    "The project sidebar can be reopened after collapse, and the toggle's label, icon and aria reflect the live state.",
    "Existing entry points still work: Board, Guide, Settings, isolation, git, running-here, mounts and permission deep-links all land as before."
  ],
  "code_refs": [
    {
      "path": "public/index.html",
      "note": "#seal two-tier crown markup split by #sealBreak; #fold sidebar toggle"
    },
    {
      "path": "public/app.js",
      "note": "paintProvSel + #provSel handler; paintFold + #fold click; paintCrown tier-divider; mounts before #sealBreak; closePops resets #provSel"
    },
    {
      "path": "public/styles.css",
      "note": ".seal flex-wrap tiers; .seal-break/.seal-vdiv; .pill.sel; .seal .readout; #fold.is-collapsed mirror"
    }
  ],
  "related": [],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": false,
    "Evidence": false,
    "Implementation notes": false,
    "Verification plan": false,
    "Migration and rollback": false,
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": null,
    "sha256": null,
    "original_title": null,
    "migrated_on": null,
    "migrated_by": null,
    "confirmation": "Authored directly in the record format through scripts/board-tool.mjs. There is no legacy original.",
    "dropped": []
  }
}
```

# FEAT-114 — The session header strip overflows and hides controls the user cannot reach

## Diagnosis

The crown's `#seal` strip was a single flex row: `display:flex; align-items:center;
overflow-x:auto; scrollbar-width:none`. It never wrapped. Once the chips exceeded
the available width the row simply scrolled, and because the scrollbar was hidden
(and desktop pointers have no easy horizontal scroll), everything past the visible
edge was clipped and unreachable. Measured on the real UI at 1440px with the
needs-you rail open: seal `scrollWidth` 913px vs `clientWidth` ~745px — the
process chip (`▸ :4317 …`), the integrations strip and the permission readout were
all off-screen. Narrower windows lost even more.

Three secondary faults sat in the same strip:

- **No tooltips** on `#isoBtn`, `#insBtn`, `#integStrip` (empty `title`), so
  single-glyph controls were unexplained.
- **Provider choice was tray-only.** `#provBtn` in the composer tray was the only
  Anthropic/OpenAI selector; the header had no engine control even though the
  isolation chip next to it already behaved as a selector.
- **Sidebar reopen was undiscoverable.** `#fold` toggles `.collapsed` on `#win`
  and does reopen the sidebar on desktop, but it kept its `title`/`aria-label`
  "Hide sidebar" and identical icon while collapsed — so a user who hid the pane
  had no signal the same button brings it back.

## Evidence

Real headless-brave capture against a scratch server, Orchard registered as a
project (dirty git repo, live processes — real chip content), both themes:

- **Before:** `clips:true` (scrollWidth > clientWidth) at 1440/1200/1024/900/760/640;
  the strip rendered a single 33px row and screenshots show the row cut off at the
  rail edge after "…⎇ main · 37 dirty · +3401 · −38 · ▸ :4317 :347…".
- **After:** `clips:false` and `overflowsCrown:false` at every width 1440→520 in
  both themes; the strip wraps into two clean tiers.

## Implementation notes

- **Two tiers, wrapping, DOM kept flat.** `#seal` is now `flex-wrap:wrap` with a
  full-width `#sealBreak` element between the interactive controls and the
  informational readouts. Kept flat (all chips remain direct children of `#seal`)
  so `paintPerm`'s `sealSep.before(chip)` and the `:scope > .perm` / `.mnt,.addm`
  removal queries stay valid. Tier 1: Board · Guide · Settings │ Provider ·
  Isolation · Instructions. Tier 2: git · processes · integrations · permission.
- **Interactive vs informational.** Tier-1 controls keep the bordered `.pill`
  look; `.pill.sel` (isolation, provider) shows the menu chevron. Tier-2 `gitBtn`
  and `procBtn` gained `.readout` — transparent border/background at rest, quiet
  ink, border only on hover — so readouts stop masquerading as buttons. A
  `.seal-vdiv` hairline separates nav from selectors (hidden when no project).
- **Provider selector.** New `#provSel` in the header, painted by `paintProvSel()`
  (twin of `paintProvBtn`, same `providerView()` source and same
  `!!currentProject() && !dockLive()` visibility). It opens the SAME `#provPop`
  via `place(node.provPop, node.provSel, 292)`, so header and tray never disagree;
  `closePops` resets its aria. Providers are real: `registry.ts` `Provider =
  'anthropic' | 'openai'`, so this is not a selector for something unwired.
- **Sidebar toggle.** `paintFold()` reflects collapsed state into title,
  aria-label, aria-expanded and an `is-collapsed` mirror class (CSS `scaleX(-1)`
  on the glyph). Reads "Hide sidebar" open / "Show sidebar" collapsed.
- **Tooltips** added to isolation, instructions, provider; git/proc/permission
  already carried them.

## Verification plan

Driven in real headless brave over a realistic busy-state fixture (Orchard's own
dirty repo, 25 live processes, board of 69). Must-FAIL proven against the
pre-change tree (before/after geometry + screenshots). Regression suites re-run.
An independent clean-room pass is warranted only if this is bundled with
server-side change; as a UI-only strip/CSS change it is low-risk.

## Risks

- The tree carried other lanes' uncommitted work in `public/app.js`,
  `public/styles.css`, `public/lib/*`. Edits were kept to the crown/seal/fold
  regions, disjoint from those hunks; `public/index.html` was clean.
- An empty tier-2 (non-repo project, nothing running) leaves ~7px of row-gap
  below tier 1 — cosmetic, not a clip.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-02 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-09-02 — worker lane (explore-then-build, round 1)
- **Understood:** reproduced the clip in real headless brave — `#seal` was a
  single `overflow-x:auto` row with a hidden scrollbar; proc/integrations/perm
  clipped off the right edge at 1440 with the rail open, worse when narrower.
  Confirmed the missing tooltips, the tray-only provider control, and that the
  fold button reopens the sidebar but never says so.
- **Changed:** `public/index.html` (two-tier `#seal` split by `#sealBreak`,
  `#provSel` header selector, tooltips, `#fold` aria-expanded seed);
  `public/app.js` (`paintProvSel` + handler, `paintFold` + toggle, paintCrown
  tier-divider + provSel, mounts before `#sealBreak`, closePops resets provSel);
  `public/styles.css` (`.seal` flex-wrap tiers, `.seal-break`/`.seal-vdiv`,
  `.pill.sel`, `.seal .readout`, `#fold.is-collapsed` mirror).
- **Verified:** after-tree in real brave — `clips:false` at 1440/1200/1024/900/760/640/520
  in BOTH themes; every listed control has a non-empty tooltip; `#provSel` opens
  the shared `#provPop` (Claude/OpenAI); fold flips Hide↔Show + mirror + reopens.
  Screenshots read well in both themes. Regressions: bug-106-crossproject-strip
  33/33, bug-075-mount-chip 9/9, bug-082-proc-chip 16/16, verify-processes 9/9,
  verify-overrides 5/5, verify-ui (offline) 3/3. Two unrelated suites fail from
  OTHER lanes' uncommitted work (verify-git stash-view via `public/lib/git-view.js`
  which I did not touch + a scratch-repo git divergence; verify-skip-perms toast
  wording) — outside my slice.
- **Gate:** `npm run gate` currently exits 1 for reasons NOT in my slice — the
  leak-gate flags three untracked `.py` files with home paths, and typecheck fails
  on `src/lib/session-provenance.mjs` (another lane's uncommitted work). My three
  files are TS-free and leak-clean — grepped for the home-path, bare-username and
  stray scratch-dir token shapes the gate scans for, none present. Left unstaged
  for the orchestrator to commit.
- **Handoff:** UI-only; work_state `in_verification`, human_action `review`.
