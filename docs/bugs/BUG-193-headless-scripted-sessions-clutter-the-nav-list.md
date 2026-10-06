# BUG-193 — headless/scripted sessions clutter the nav session list

- **Status:** IN-PROGRESS
- **Severity:** medium
- **Area:** sidebar / server / session-history
- **Reported:** 2026-09-28 by user
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED.

## Symptom
Programmatic `claude` sessions the user never opened show up in a project's
navigation session list. User: "there is no point for me to see that session in
the list." Example: the `trading-volume` project's store held a transcript
`c3795424-….jsonl` — entrypoint `sdk-cli`, prompt "say ok2". That one dir holds ~1038 such files;
machine-wide there are ~1033 `sdk-cli` + ~1616 `sdk-ts` transcripts against only
49 interactive `cli` ones, so the human's own threads drown in scripted noise.

## Repro
Open a project whose store contains external `claude -p` / Agent-SDK transcripts
(e.g. trading-volume). The nav list shows those scripted rows alongside real
conversations.

## Expected
- SHOW: interactive sessions (entrypoint `cli`, or a legacy transcript with no
  entrypoint field), AND sessions the user launched/uses through the Orchard
  dashboard (these run via the Agent SDK and carry `sdk-ts`/`sdk-cli`).
- HIDE (fold out of the default view; still reachable via "N more"/search/URL):
  every other programmatic session — external `claude -p` scripts, Orchard
  dispatch/verify lanes, test-harness runs.
- A hidden session still OPENS on a direct deep link.

## Context pack
- Files/functions in play:
  - `src/lib/session-history.ts` — `readSessionMeta` / `RawEntry` / `SessionMeta`
    now capture the transcript's `entrypoint` from the head (no extra IO).
  - `src/lib/session-provenance.mjs` — new `isProgrammaticEntrypoint` +
    `foldsFromDefaultList`: the single owner of "does this row fold from the
    default nav list" (ARCH-010). `.d.mts` updated.
  - `src/server/index.ts` — the `/api/projects/:id/sessions` GET emits
    `foldByDefault` per row (server-owned; client does not re-derive).
  - `public/app.js` — `foldsFromList` reads `foldByDefault` (falls back to the
    old `isAgentStarted` for an older server); `visibleSessions` folds on it.
  - `src/server/codex-native.ts` — Codex rows carry `entrypoint: null`.
- Key design fact: EVERY session Orchard launches — a dashboard session AND a
  dispatched lane — writes a `session-provenance/<id>.json` record at
  `system:init` / dispatch. So "Orchard launched this" is a declared fact, not a
  heuristic. Measured on the real store: 47 user-started (dashboard) records,
  mostly `sdk-ts`; 989 agent-started (dispatch) records. The external
  trading-volume `sdk-cli` files have NO record — that is what distinguishes them
  from the 44 dashboard `sdk-ts` sessions that must stay visible.
- Related tickets: session-provenance work (the `startedBy` fold this extends),
  ARCH-010 (declared-by-owner), BUG-158 (keep listing cheap).
- Repro test: `node scripts/verify-bug-193-list-fold.mjs` (real store + real
  provenance; 20 checks incl. a must-FAIL proof).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-28 — fixing lane (round 1)
- **Understood:** the prior diagnosis was correct — `listSessionFiles` lists every
  `*.jsonl`, `readSessionMeta` never read `entrypoint`, and `sessionsForProject`
  applies no gate. But Orchard ALREADY records what it launched: session-provenance
  writes a durable per-session record for both dashboard and dispatch sessions. So
  no migration is needed (hypothesis CONFIRMED). The gap was only that
  `resolveStartedBy` defaults a record-less session to `user`, so an external
  `sdk-cli` script fell through as visible.
- **Changed:** captured `entrypoint` in session-history (head-only, zero extra IO);
  added `isProgrammaticEntrypoint` + `foldsFromDefaultList` to session-provenance
  as the one fold authority; server emits `foldByDefault`; client folds on it.
  Files: `src/lib/session-history.ts`, `src/lib/session-provenance.mjs` (+`.d.mts`),
  `src/server/index.ts`, `public/app.js`, `src/server/codex-native.ts`, plus
  `scripts/verify-bug-193-list-fold.mjs`. Left unstaged (agents never git-write).
- **Verified:**
  - `node scripts/verify-bug-193-list-fold.mjs` — 20 passed, 0 failed, 0 skipped.
    Includes a synthesized-baseline MUST-FAIL proof (external `sdk-cli` was LISTED
    pre-fix), and real-artifact cases: external `sdk-cli` c3795424 → FOLD; Orchard
    dashboard `sdk-ts` 4fb289a9 (provenance user) → SHOW; legacy no-entrypoint
    6850e3b6 → SHOW.
  - `npx tsc --noEmit` — EXIT 0.
  - Anti-regression: `verify-session-provenance.mjs` 25/25;
    `verify-session-provenance-fold.mjs` 7/7; `verify-session-provenance-endpoint.mjs` 7/7.
  - Performance on the real 1038-file trading-volume dir: `listSessions` cold
    ~1.68s (unchanged shape — entrypoint reads from the head sample already read),
    all 1038 rows got `entrypoint`.
  - Live end-to-end: (see below) second server on a free port over the real store.
- **Still open / handoff:** independent clean-room verify warranted
  (session-lifecycle / list-visibility, regression-prone file `app.js`). A hidden
  row is still reachable via "N more"/URL, so this is fold, not deletion.
- **Symptom of a deeper design flaw?** no — this is a direct application of the
  existing ARCH-010 provenance mechanism to one more reader (the nav list).

### 2026-09-28 — verifying lane (round 1, cross-provider clean-room)
- **Verified-by:** dispatch openai run 01a0e824-cea8-7f22-aa78-8a4c1895e1c8
  (clean-room, `scripts/independent-verify.mjs`, 19 recorded runs) — VERDICT: BROKEN.
  Author-provider anthropic → cross-provider openai/codex. Diff isolated to the 6
  BUG-193 files/hunks via a dangling temp-index commit (`HEAD..9d4f932e`), so the
  unrelated uncommitted app.js/index.ts edits were excluded from what the verifier saw.
- **Verdict is VALID (manifest-backed)** but rests on synthetic fixtures the verifier
  built; the real fixer test did NOT execute in the clean room (`node
  scripts/verify-bug-193-list-fold.mjs` → MODULE_NOT_FOUND: the untracked test was
  passed as `--test-file` (body in prompt) but the verifier never re-created it in the
  room before running). Verify lane ran it independently: **20/20 on the real store**
  before dispatch.
- **Findings, graded against the USER'S real store (not just the mechanism):**
  1. `readSessionMeta` samples head/tail (256KB each; full scan only ≤512KB). Verifier
     showed a hand-crafted >512KB transcript whose `entrypoint` sits outside both
     sampled regions can misread it → a `cli` session wrongly folded, or an external
     `sdk-cli` left visible. **Real-artifact check (verify lane): 0 divergences across
     2707 real transcripts, 444 of them >512KB** — sample-mode vs full-scan `entrypoint`
     agree everywhere. The code comment "the head is enough and this never needs a full
     scan" is an overclaim, but the failure does NOT reproduce on any real transcript,
     and the reported clutter (tiny `sdk-cli` scripts) is always full-scanned. Severity:
     LOW / robustness (theoretical on real data).
  2. Same sampling root cause, false-negative direction (external session left visible).
     Same 0/444 real-store result. LOW.
  3. `public/app.js` counts a folded external session in the project-header session
     count AND the unseen badge even when `visibleSessions` returns zero default rows
     (all-hidden project shows count "1" / badge 1). Run against STUBBED client deps,
     not the real DOM; the header-count/badge paths are NOT in the BUG-193 diff
     (pre-existing), so this is a fold-consistency/completeness gap the charter asked
     about, not a regression the diff introduced. Severity: LOW (design/consistency).
- **Core requirement HOLDS on real data:** external programmatic sessions fold; `cli`,
  legacy no-entrypoint, and Orchard dashboard/native-openai sessions stay visible;
  empty/corrupt/truncated → sane visible; new-id fork WITH provenance stays visible;
  all-hidden project keeps a reveal affordance; "N more" restores a hidden row; hidden
  rows keep transcript+URL (fold, not deletion). No perf regression observed (entrypoint
  read piggybacks the head sample already read).
- **Could NOT test:** real dashboard fork/resume lifecycle (simulated only); browser
  render / search / direct-deep-link load / populated needs-you rail (client fns ran
  stubbed); a live server (no :4317 restart, per charter).
- **Recommendation (verify lane, does not decide):** the three findings are all LOW and
  none blocks the core symptom fix. Optional hardening: drop the "head is enough"
  overclaim and full-scan `entrypoint` recovery for >512KB files (cheap — one extra
  bounded read only when head yielded no entrypoint), and decide whether header
  count/unseen badge should exclude folded rows. Clean room kept at
  `~/.local/state/claude-station/scratch/cleanroom-verify-F2aoJb`.

### 2026-09-28 — fixing lane (round 2)
- **Understood:** round-1 clean-room finding 3 — `public/app.js` counted folded
  rows in the project-header session count and the unseen badge, so an all-hidden
  project read "1" while presenting nothing. Findings 1/2 (>512KB head/tail
  sampling can miss `entrypoint`) — **accepted: theoretical**: 0 divergences across
  2707 real transcripts (444 of them >512KB), and the reported clutter (tiny
  `sdk-cli` scripts) is always full-scanned. Left alone per the round-2 charter.
- **Changed (public/app.js only):** added `listedSessions`/`listedCount` — the
  set the nav list presents, computed from the SERVER's `foldByDefault` via the
  existing `foldsFromList` (client never recomputes the fold). Used it for the
  project-header count, the `projectDotState` empty check, the unseen badge
  (`unseenCount` now skips folded rows), the empty-state branch, and the "N
  sessions of history listed" toast. An all-hidden project now reads count 0 and
  shows an empty state; added `allHiddenNote` so it says "N background/scripted
  sessions are hidden" instead of emptyProjectNote's false "no .jsonl files".
  "N more" (the reveal affordance for folded rows) is deliberately unchanged.
- **Verified:**
  - `node scripts/verify-bug-193-list-fold.mjs` — **26 passed, 0 failed** (was 20;
    +6 round-2 cases incl. a must-FAIL: naive list length counts folded rows (3)
    vs listedCount 0; all-hidden header count/unseen badge = 0; mixed = 2/1;
    older-server fallback still folds agent lanes).
  - `npm run gate` — PASS (exit 0).
  - Live (second server, free port, isolated data dir, real store; no :4317
    restart): Playwright header counts now EXCLUDE folded rows and match the API
    listed counts exactly — trading-volume 1060→**9**, orchard 494→**199**, and
    four other projects each dropped their folded count (e.g. 139→136, 25→18,
    21→6). An all-hidden project shows header count **0** and NO bogus "N more".
    A real dashboard session still opens/shows.
- **Still open / handoff:** the `allHiddenNote` text itself wasn't captured in a
  clean DOM screenshot (the project list is itself windowed, and a pending new
  session suppresses the note by design); count=0 + no-"N more" empty state was
  confirmed. Independent clean-room re-verify still warranted (regression-prone
  `app.js`; list-visibility class).
- **Symptom of a deeper design flaw?** no — same ARCH-010 application, now covering
  the count/badge readers of the nav list too.

### 2026-09-28 — verifying lane (round 3, live :4317 after user restart)
- **Setup:** user restarted the Orchard service on :4317 (pid 3076339 =
  `src/server/index.ts`) running the BUG-193 build; verified live against the real
  store via Playwright (headless) + `curl /api/projects/.../sessions`.
- **Checks (all PASS):**
  - **Fold-out:** `c3795424-fdc6-4229-90bc-f408b9767447` (foldByDefault=true,
    startedBy=user, title "say ok2") is absent from the trading-volume nav default
    list — not in the DOM at all (`targetInHTML=false`).
  - **Count == listed rows:** trading-volume nav badge = **6**, matching the API's
    6 `foldByDefault=false` rows exactly (of 1065 total; 1059 folded). Orchard
    (project id `claude-station`, dir = the encoded `~/projects/orchard` home path) badge = **318**,
    matching API 318 listed of 639. (Round-2's 9/199 were from an isolated snapshot;
    live counts have since accrued more folded agent lanes — the badge==API-listed
    invariant holds in both.)
  - **Deep link:** the deep link still opens the folded session (page title
    resolved to "say ok2 — Claude Station").
  - **Real sessions intact:** orchard/other projects still list real dashboard
    sessions.
  - **"N more" is fold-inclusive by design:** the collapsed nav shows only recent
    non-folded rows; clicking "N more" reveals folded agent lanes (FEAT-002/014
    dispatches) too — consistent with round-2's "'N more' deliberately unchanged".
    Not a defect.
- **Cleanup:** no `/tmp/bug193-port.txt` present and nothing listening on a stray
  BUG-193 port (the :4317 owner is the user's restarted src server; unrelated pid
  2636 `dist/server/index.js` holds no listening socket and is a different old
  service — left untouched, killed nothing). Removed stale test artifacts left in
  /tmp by earlier lanes: `bug193-idx-Omi18m/`, `bug193_work_dir`, `bug193_sha`,
  `bug193-trading-volume.json` (no process held any fd on them).
- **Verdict:** live behavior on :4317 confirms the fix. Independent clean-room
  re-verify still warranted per the fix charter (regression-prone `app.js`;
  list-visibility class).

### 2026-09-28 — fixing lane (round 4)
- **Report:** an openai dispatch/verify lane
  (`01a0e93a-19aa-7ea0-9818-58d9058be068`, source `dispatch:openai`) showed in
  the nav list of the project it ran against — a session the user did not create.
- **Diagnosis (charter hypothesis REFUTED):** classification was already CORRECT.
  The list API emits `foldByDefault:true, startedBy:"agent", provider:"openai"`
  for this row, and its provenance record is
  `{startedBy:"agent", source:"dispatch:openai"}` (openai/codex lanes DO write a
  provenance record, contra the hypothesis). Round-1's server-owned fold covers
  it. The row appeared for ONE reason: it was the currently-OPEN session (the
  user had deep-linked into it, `aria-current="true"`), and `visibleSessions`
  force-adds the open session via `isAlwaysVisible`, resurrecting a folded
  programmatic row the user only opened to peek at. So NO session changed
  classification (0 across all projects) — this is a presentation-only defect in
  the open-session bypass, not a classification gap.
- **Why round 1 missed it:** rounds 1–3 verified the fold with the target
  session NOT open (trading-volume `c3795424` was checked from a different
  current route). The `isAlwaysVisible` bypass only fires for the row you are
  viewing, so the deep-link-into-a-folded-lane path was never exercised. The
  ticket's Expected says a hidden session "OPENS on a direct deep link" — it must
  not thereby plant itself in the list.
- **Changed (`public/app.js`, `visibleSessions` only):** the open-session bypass
  now excludes folded rows — `(isAlwaysVisible(x) && !foldsFromList(x)) ||
  hasLiveWork(x)`. A folded lane you deep-link into still OPENS (transcript pane
  renders) and stays reachable under "N more"/URL, but no longer gets a nav row.
  A NON-folded open session is still always shown (BUG-085 "open session never
  vanishes" preserved). LIVE work still bypasses the fold whatever its
  provenance (running work is never hidden).
- **Verified:**
  - `scripts/verify-bug-193-list-fold.mjs` — **31 passed, 0 failed** (was 26;
    +5 round-4 cases via a happy-dom boot of the REAL app.js driving the REAL
    `visibleSessions`). MUST-FAIL proven by reverting the one-line fix: pre-fix
    the open folded lane IS in the default rows (check FAILS); post-fix it is
    absent. Cases: three genuine sessions still show; folded LIVE lane still
    shows; non-folded open session still always present; "N more" reveals the
    folded open lane.
  - Anti-regression: `verify-bug-085-sidebar-cap.mjs` 11/11 (same function).
  - `npm run gate` — PASS (exit 0). (Leak-gate first flagged the real project
    name in the new test fixture; scrubbed to a generic name.)
  - Live on :4317 (client-only change; the running server already serves the
    fixed `public/app.js` from disk — no restart needed): at the user's exact
    URL, after a hard reload, the openai lane is ABSENT from the nav
    (`targetShown:false`), moved under "5 more"; the deep link still OPENS it
    (page/title render the transcript); the only remaining row is a folded LIVE
    lane (`data-live="here"`), shown by design.
- **Design tension flagged (orchestrator decision):** a folded LIVE dispatch
  lane still shows (hasLiveWork). The user's broader intent ("don't want
  agent-created sessions") could extend to these, but hiding RUNNING work is a
  deliberate, defended anti-pattern (BUG-085 era). Left as-is; naming it here so
  the decision is explicit rather than silent.
- **Still open / handoff:** independent clean-room re-verify still warranted
  (regression-prone `app.js`; list-visibility class). Untested: real
  fork/resume lifecycle while a folded lane is open; multi-tab.
- **Symptom of a deeper design flaw?** no — the classification mechanism was
  right; this closes one more reader (the open-session bypass) against the same
  fold authority.

### 2026-09-28 — fixing lane (round 5)
- **Correction to round 4:** the user saw `01a0e93a` in the nav list BEFORE
  opening it (they opened it only to copy the link), so the round-4 open-session
  explanation did not cover the sighting. Kept the round-4 open-session fix (still
  a real bug) and found the additional cause.
- **Cause (evidence, liveness — NOT a stale tab):** the lane was LIVE (mid-turn)
  when seen and the "folded live lanes still show" rule (`hasLiveWork`) surfaced
  it. Evidence: the codex rollout + Orchard transcript mtimes both moved
  18:14:54→18:19:29 (a running turn appending); the list API returns
  `foldByDefault:true, startedBy:"agent", provider:"openai"` and provenance
  `source:"dispatch:openai"`. For a FOLDED row the pool never includes it
  (`!foldsFromList` gate), so the ONLY default-view bypass is `alwaysIds`
  (`isAlwaysVisible` OR `hasLiveWork`); the user was not viewing it, so
  `hasLiveWork` is the sole path. Stale-tab RULED OUT: on the live server the
  OTHER folded lanes (`01a0e938`, `bb7462f5`) never showed — a pre-restart tab
  would have shown all rows unfolded. `src/server/liveness.ts` uses a 30s
  transcript-mtime window over ground truth; by the time it was probed the lane
  had finished (`live:false`) — genuinely live when seen, not zombie.
- **User decision (coordinator):** hide agent-created lanes from the nav even
  while running. Not by-design-kept.
- **Changed (`public/app.js`, `visibleSessions` only):** the fold now wins over
  BOTH bypasses — `alwaysIds = !foldsFromList(x) && (isAlwaysVisible(x) ||
  hasLiveWork(x))`. A folded lane no longer appears running or not, open or not.
  Non-folded live/open (dashboard/interactive) sessions still always show;
  deep links still OPEN a folded lane; it stays under "N more"/URL/search.
- **Running lanes still observable elsewhere (no new surface built):** the
  per-project proc chip (`procChipText`/`procChipTitle` — count + ports of
  processes running from the dir) and the orchestrator's own agent/lane views
  (`viewAgent`, running snapshot) still show running work. Hiding folded lanes
  from the nav does NOT leave running lanes unobservable.
- **Verified:**
  - `scripts/verify-bug-193-list-fold.mjs` — **31 passed, 0 failed**. Round-5
    MUST-FAIL added: "folded LIVE lane is ABSENT from the default nav rows" —
    proven by reverting to the round-4 form (fold live lane present → check
    FAILS); post-fix absent. Uses the happy-dom boot of the REAL app.js +
    REAL `visibleSessions` over a realistic-state fixture (a folded LIVE lane
    among genuine sessions).
  - Anti-regression `verify-bug-085-sidebar-cap.mjs` 11/11; `npm run gate` PASS
    (exit 0).
  - Live on :4317 (client-only; server already serves the updated app.js — no
    restart): after a hard reload, all three folded lanes
    (`01a0e93a`/`01a0e938`/`bb7462f5`) are ABSENT from the project nav; the two
    genuine user sessions show; count 3, "4 more". The LIVE-folded case could
    not be reproduced live (no lane in that project is currently running) — the
    realistic-state fixture test covers it; noted honestly.
- **Still open / handoff:** independent clean-room re-verify still warranted
  (regression-prone `app.js`; list-visibility class). Untested live: a
  concurrently-RUNNING folded lane absent on :4317 (none was live at verify time).

### 2026-09-29 — pointer from FEAT-154 round 8 (not a BUG-193 defect)
- A user report that session `6927511d` was missing from the nav list after a restart was checked
  against this ticket's fold. **The fold was not the cause.** The row reads `foldByDefault:false`,
  and its provenance is `{startedBy:'user', source:'agent-bridge'}` (it is the user's own dashboard
  session). A real `visibleSessions` reconstruction shows it at seat 5–6 of the 6-seat BUG-085
  budget, so it is visible at the bottom. A hidden state could not be reproduced. The "blue after
  opening" half was a real defect, fixed there (FEAT-144 mirror counted as a live writer). Details
  are in FEAT-154's round-8 entry. BUG-193's folds hold: `verify-bug-193-list-fold` 31/31.
