```orchard-ticket
{
  "id": "FEAT-171",
  "type": "feature",
  "title": "Use Orchard from a phone: the chat gets the screen",
  "summary": "The user opens Orchard from their phone over tailscale. On a phone-width screen the sidebars and the tall session header should get out of the way so the conversation fills most of the screen, with the sidebars a tap away instead of open by default.",
  "impact_if_we_wait": "Remote use from a phone stays impractical: the transcript gets a small slice of the screen and only a message or two is readable at once.",
  "current_need": "A phone layout below a narrow breakpoint: sidebars collapsed by default and reopened as overlays, a compact header, a composer that survives the on-screen keyboard, and desktop unchanged.",
  "severity": "medium",
  "area": "client layout / responsive",
  "reported": "2026-10-07",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "in_progress",
  "human_action": "none",
  "updated": "2026-10-07",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "At 390x844 and 360x800 the transcript area is at least 75% of the viewport height with the keyboard closed.",
    "Everything above the transcript is at most 48px tall on a phone.",
    "Both sidebars are closed on first load on a phone and each opens and closes from a visible control.",
    "No horizontal scroll on a phone.",
    "Desktop at 1024px and wider looks the same as before."
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "98d900fe-808d-4e25-b30c-3517edcb6e53",
      "verdict": "broken",
      "verdict_on": "2026-10-07",
      "recorded_at": "2026-10-07T13:42:38.370Z",
      "author": "dispatch anthropic",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "clean-room verify r1; openai fallback (quota-window); same-provider decorrelation reduced; landscape transcript 70.3-72.6% < 75%"
    }
  ],
  "verification_class": "plan+review",
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

# FEAT-171 — Use Orchard from a phone: the chat gets the screen

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-10-07 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-10-07 — agent (build lane)
- **baseline + plan + review:** - **Board check (WA B):** no prior mobile/responsive ticket (searched mobile|phone|tailscale|viewport|narrow). The client already had narrow rules: a `max-width:720px` icon-strip sidebar and a `max-width:1040px` off-canvas board rail.
  - **Baseline (must-FAIL), measured before any change** with `node scripts/verify-feat-171-mobile.mjs --label before --no-assert`. That is headless Chromium with touch + isMobile, on an isolated scratch server holding a REAL transcript copy (e5ca715a…), a SYNTHETIC 5-exchange short chat, a busy sidebar and a copy of the real board. Result: 21/52 checks passed. Numbers (transcript % | px above transcript | messages full+partial | visible chars):
    - 390 chat: 20.9% | 443px | 0+1 | 17
    - 390 real: 11.6% | 522px | 0+1 | 2
    - 360 chat: 7.3% | 472px | 0+1 | 0
    - 360 real: 0% | 551px | 0+0 | 0 (composer pushed off-screen)
    - landscape 844x390: 9.6%
  - **Root cause:** the 720px icon-strip rule is beaten by source order. The later 1040px rail rule re-sets `.window` grid columns, so the 272px sidebar stays fully open on a phone and the main column is about 118px wide. The crown's pills wrap into a tall column.
  - Also found: the rail's floating badge covers the composer (y=775 vs dock top 620), the textarea is 15px (iOS zooms on focus), and the send button is 29px.
  - And: even a working 720px strip hides session rows, so no session could be picked on a phone.
  - Screenshots: `docs/bugs/assets/FEAT-171-before-*.png`.
  - **Plan:** one phone breakpoint, `(max-width:720px), (max-height:480px) and (pointer:coarse)`, at the end of styles.css; the broken strip is removed. Parts:
    - the sidebar becomes an off-canvas drawer opened by a hamburger in the crown;
    - the crown becomes one row of 48px or less: menu, title, status, a "more" button that reveals the seal strip as a drop panel, and a board button;
    - the composer gets 16px text, safe-area insets, height from `visualViewport` and larger touch targets;
    - desktop and the 721-1040px layout are untouched.
  - **Review:** OpenAI dispatch failed `[quota-window]` (usage limit). Used a separate-process Claude reviewer instead (`dispatch --provider anthropic`, run fed169c7-ce84-42a1-816b-3d4e6ff34389). Adopted:
    - phone selectors also beat `.window.collapsed`, and fold on a phone closes the drawer;
    - the "more" button carries a warning marker when a seal item is risky, warning or flagged; the status label shows for every non-idle state;
    - an explicit z-order: drawer above pops-host, pops above the drawer on a phone, badge hidden while the drawer is open;
    - Escape and outside-tap steps for the drawer and details panel, ignoring taps inside `.pop`;
    - hover-open popovers gated to `(hover:hover)`; row and project affordances visible on a phone;
    - `inert` on the closed drawer;
    - `visualViewport` resize+scroll setting `--app-h`, plus stick-to-bottom;
    - 16px on all inputs;
    - a crown button proxying the rail badge, so BUG-160's sibling placement is kept;
    - the jump, left-off and bookmark pills re-placed;
    - the drawer closed from the session-open path and on hashchange;
    - no edge-swipe.
    - Could-not-test noted: real iOS keyboard, safe-area, long-press, and WebKit (not installed).

### 2026-10-07 — agent (build lane)
- **built + verified (self) — needs independent verify:** - **Built.** Phone layout = one media block at the end of `public/styles.css`: `(max-width:720px), (max-height:480px) and (pointer:coarse)`. The broken 720px icon-strip block is removed. `--layout: phone` is declared there and read by app.js (`phoneLayout()`), so the query exists once.
    - Sidebar: an off-canvas drawer (visibility-hidden when closed, so out of tab order) with a scrim. Opened by `#navBtn`. Closed by the scrim, Escape, its fold button, opening or starting a session, or hashchange. The desktop `.collapsed` state is set aside on a phone and handed back on leaving.
    - Crown: one 47px row (menu, title with ellipsis, status — label for every non-idle state, more, board). `#crownMore` reveals the model chip and seal strip in flow; it carries an "!" marker plus an aria reason when the strip hides a risky permission, usage warn/danger/maxed, a model switch or a merge conflict.
    - Board: `#crownRail` proxies `#railBadge`, which stays a sibling of .rail (BUG-160). The floating badge is hidden on a phone because it covered the composer. The rail has a scrim, a phone-only close button and a 2-column card grid.
    - Composer: 16px fields (no iOS zoom), 36/40px targets, safe-area insets, height from `visualViewport` (`--app-h`/`--app-top`) with re-stick to bottom. The calm permission line is hidden on a phone; the risky one stays. In landscape the composer is a single row and the plain status line yields.
    - Touch: hover previews of git/usage skip touch-driven mouseenter. Long-press on a row or project opens its menu (iOS has no contextmenu). The project's + and cog are always shown, and the row no longer reflows on tap — that reflow made a tap on + land on the project head, found by the real click path.
    - Viewport meta: `viewport-fit=cover, interactive-widget=resizes-content`.
  - **Files (this lane only):** `public/styles.css`, `public/index.html`, `public/app.js` (11 hunks), new `scripts/verify-feat-171-mobile.mjs`, this ticket, `docs/bugs/assets/FEAT-171-*`.
    - NOTE: `public/app.js` ALSO carries another lane's uncommitted BUG-234 r7 edits, made before this lane started. This lane's own app.js diff is saved at `~/.local/state/claude-station/scratch/feat171/feat171-app.js.patch` (plus styles/index patches) for a selective commit.
  - **Verified** with `node scripts/verify-feat-171-mobile.mjs --label after`: **88/88 PASS**. Before, the same suite with `--label before --no-assert` against a pre-change copy (`FEAT171_SERVE_ROOT`) passed 24/58. Rows are transcript % | px above transcript | messages full+partial | visible chars, before → after:
    - 390 chat: 20.9→80.6% | 443→47 | 0+1→8+1 | 17→407
    - 390 real: 11.6→80.6% | 522→47 | 0+1→0+1 | 2→729
    - 360 chat: 7.3→79.5% | 472→47 | 0+1→7+1 | 0→407
    - 360 real: 0→79.5% | 551→47 | 0+0→0+1 | 0→615
    - landscape 844x390: 9.6→72.6% (3+1 messages)
    - The real transcript's last message is one long reply, which is why its count stays 0+1 while its visible characters go 2→729.
  - **Checks covered:** sidebar and rail closed on load; no horizontal overflow; composer on screen; drawer open, pick-session, scrim, Escape; scrim covers controls; rail open, close button, outside tap; details open/close with controls kept on row 1; long title ellipsis; long-press row menu above the drawer; alert marker; Tab never enters the closed drawer/rail; desktop folded → phone → desktop round trip.
  - **Desktop/tablet unchanged:** 8 element boxes identical before/after at 1280x860, 1024x768 and 800x1000. Screenshots differ by 374-473 px (<0.05%), confined to live-state indicators: the session dot and the loading usage ring.
  - **Anti-regression** (post vs pre-change copy):
    - verify-needs-you-rail 19/19, feat-070-sidebar 14/14, bug-085-sidebar-cap 11/11, bug-082-proc-chip 13/13, feat-161 42/42 (one run hit a 1-second "2d 5h vs 2d 4h" boundary flake; it passed on both reruns).
    - The first post run of 070/085/082/161 FAILED: `MutationObserver` was absent in the node UI harness, and a `(hover:hover)` gate broke 161's hover tests. Both were fixed with a per-event touch check and a guard.
    - Pre-existing and identical on the pre-change copy: feat-168 (crash after 187/187), bug-106 (32/33), feat-146 (11-categories fail), verify:ui (3 live-turn fails).
    - verify-git cannot run under the agent git-write hook.
  - **Visual review:** two independent design-critic passes. The first found the title not ellipsizing, the details panel wrapping the board button off row 1, a clipped focus ring, a rail shadow band, no rail dimming or close, and a tall landscape composer — all fixed. The second found no blockers. Its remaining nits were not done: bookmark pill alignment, unlabeled tray icons, inline-code hyphen breaks.
  - **Could not test:**
    - Sending real messages (`--live`): in this scratch setup a UI send produces no turn at all. It fails identically on the pre-change client and at desktop width, and verify:ui's live-turn checks fail the same way, so it is environmental and not investigated further.
    - Real iOS keyboard / visualViewport offset, safe-area insets, a real long-press, WebKit (not installed) — these need the user's phone.
  - **Plan review:** OpenAI quota-window; Claude separate process fed169c7-ce84-42a1-816b-3d4e6ff34389.
  - **Bucket:** UI, regression-prone file (app.js). An independent clean-room verify is warranted before VERIFIED.

### 2026-10-07 — dispatch anthropic
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run 98d900fe-808d-4e25-b30c-3517edcb6e53 — VERDICT: BROKEN — clean-room verify r1; openai fallback (quota-window); same-provider decorrelation reduced; landscape transcript 70.3-72.6% < 75%. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-07 — agent (verify lane, round 1)
- **Independent clean-room verify: BROKEN** (contract VALID). Run `98d900fe-808d-4e25-b30c-3517edcb6e53`, anthropic/claude-opus-5-5, separate `claude -p` process via `scripts/independent-verify.mjs`.
  - **Provider fallback:** openai was tried first (codex thread `01a1167c-653b-7d43-8470-d753f32116f3`). It died mid-run on `quota-window` and returned INVALID (infra, not recorded). Anthropic is the same provider as the author, so decorrelation is reduced. A second anthropic attempt (`1f79d6f5-5e4d-4c27-9398-416781ec9309`) came back INVALID because I passed the fixer command wrapped in `./vrun.mjs`. That was a harness-input error on my side, so it is not recorded.
  - **Room:** HEAD `e79aada970fe` plus FEAT-171 only. That is the saved app.js patch (applied cleanly, offsets only), `git diff` of styles.css and index.html, and the new suite. BUG-234's app.js edits are excluded. It is a scratch copy at `~/.local/state/claude-station/scratch/feat171/vroom-repo` (a filesystem copy of `.git`; I ran no git writes), and I used `--working-tree` on it. The diff had 4/4 paths and was not truncated. The verifier was fed the requirement, the diff, how to run, and the fixer's test code only.
  - **Fixer suite:** 72/72 PASS (run `5294f7def037`).
  - **Broken property:** in phone landscape the transcript is under 75% of the height.
    - On a fresh load: 72.6% at 844x390, 70.3% at 740x360, 71.5% at 812x375 (run `13b4927b33e2`).
    - After rotating a live portrait page: the same numbers (run `5d233157b29c`).
    - The verifier flagged this as **"two-break: route to design review"**. Both paths are the same landscape geometry: a 47px crown plus the dock under the `max-height:480px` block.
    - The fixer's suite asserts only ≥50% in landscape, which is why it passed.
  - **Held:**
    - persisted desktop state reloaded at 375 (`3e6468873ec7`)
    - drawer open, then hash or history-back navigation (`ffe6f1b2ee8f`, partial)
    - 500-char token, long URL, wide code and table at 360/375 (`e45df892af78`)
    - keyboard at vh 400/300 (`0fa3cbbba97d`)
    - settings, git and usage popovers and the board view at 360 (`7702ae22fe36`)
    - breakpoint 719/720/721/1023/1024/1025 (`d1d4f5c3c425`; the phone breakpoint is 720)
    - light and dark contrast (`fc063b83180a`)
  - **Could not test (verifier):**
    - the desktop before/after pixel comparison
    - tapping a second project, "+" new session, and the Ctrl+K finder (its script aborted)
    - the row context menu at 360 (its synthetic event had no coordinates, so this is a test fault and not evidence)
    - the ticket modal
    - real iOS keyboard, visualViewport and safe-area
    - live send
  - **Unconfirmed lead from the INVALID openai run (not a verdict):** with the RIGHT rail open, changing session by hash left the rail and scrim covering the new session. The anthropic run tested the left drawer only (it held). The fix lane should check this.
  - **Artifacts:**
    - verdict: `~/.local/state/claude-station/scratch/feat171/verdict-r1-anthropic-b.md`
    - room: `~/.local/state/claude-station/scratch/cleanroom-verify-kSrGJx`
    - records: `~/.local/state/claude-station/scratch/cleanroom-record-Hf8oZM`

### 2026-10-07 — agent (fix lane, round 2: landscape rescope)
- **Design review decision (orchestrator): RESCOPE, not a layout change.**
  - The 75% transcript share was the orchestrator's own charter number, not the user's requirement. The user asked for the "main chat to take most of the interface".
  - A landscape phone is only ~360-390px tall. A 47px top bar plus the one-row composer is close to the floor, so ~70-73% meets "most of the interface".
  - The verifier's "fresh landscape load" and "rotate a live portrait page" are the same landscape geometry, so they count as ONE finding, not two independent breaks.
- **Provider note on round 1:** the verify round ran on anthropic (same provider as the author) because OpenAI was out of quota (`quota-window`). It was NOT cross-provider; decorrelation was reduced.
- **New thresholds** in `scripts/verify-feat-171-mobile.mjs`: portrait transcript >= 75% (unchanged); landscape transcript >= 70% (was >= 50%, which made the suite a weak guard). The landscape check now prints crown px and px above the transcript.
- **Must-FAIL proof:** the suite gained an env-only probe, `FEAT171_FORCE_CROWN_PX=120`, that injects a 120px top bar. Under it the run exits 1, 75/88: `FAIL  land chat: transcript >= 70% of a landscape phone's height — observed: 53.8% (crown 120px, above transcript 120px)`. All four portrait share checks also FAIL (70.4%). 53.8% would have PASSED the old >= 50% bar. The probe's screenshots were deleted.
- **Real run** (`--label after`): **88/88 PASS**, exit 0. Landscape 844x390 = 72.6% (crown 47px, 4 full messages); portrait 390 = 80.6%, 360 = 79.5%.
- **Not addressed in this round:** the unconfirmed lead from round 1, where the right rail stayed open after a hash session change. This dispatch was scoped to the rescope only.
