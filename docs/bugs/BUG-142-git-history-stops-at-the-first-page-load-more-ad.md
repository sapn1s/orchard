```orchard-ticket
{
  "id": "BUG-142",
  "type": "bug",
  "title": "Git history stops at the first page: Load more adds nothing",
  "summary": "The git History view lists the first 50 commits and offers Load more. Clicking it never produces a 51st row. The reader is left believing the repository has 50 commits, and the verification suite that drives this view stops at that point, so every check after it has never run.",
  "impact_if_we_wait": "Anything older than the 50th commit is unreachable from the History view, and two suites (verify:git, and FEAT-099 that depends on it) cannot finish, so their later checks are unproven rather than passing.",
  "current_need": "Find what happens between the click and the render — the server half is already proven correct — then re-run npm run verify:git to completion.",
  "severity": "medium",
  "area": "git history view",
  "reported": "2026-08-25",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-08-25",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Clicking Load more on a repository with more than 50 commits adds the next page of rows",
    "A failure to load says so on screen instead of leaving the button as it was",
    "npm run verify:git runs to completion instead of stopping in history pagination"
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": false,
    "Verification plan": false,
    "Migration and rollback": false,
    "Risks": true,
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

# BUG-142 — Git history stops at the first page: Load more adds nothing

## Diagnosis

Not yet located. What is known, measured today at b6c0151:

- The SERVER half is correct. Calling the log function directly over this repository returns page 1 (50 commits, a next cursor) and then page 2 (50 more commits, another cursor). The HTTP route forwards `cursor`, and the client sends it.
- The BROWSER half does not complete. In real headless Brave, the History view renders 50 `.gt-parent-row` rows and a `.gt-more` button; clicking that button never raises the row count above 50 within 20 seconds, and no error text appears in the view.

So the defect sits between the click and the render, in `loadMore()` in `public/lib/git-view.js`. One candidate worth ruling out first: `loadMore` reads `project().id` OUTSIDE its own `try`, so if `project()` is undefined at that moment the rejection is swallowed by `void loadMore()` and the user sees exactly this — a button that does nothing and says nothing.

## Evidence

`npm run verify:git` at b6c0151: 69 checks pass, then

```
(timed out waiting for history load more after 20000ms)
FATAL: page threw: TypeError: Cannot read properties of undefined (reading .click)
```

The FATAL is a cascade: the next line clicks `.gt-parent-row[50]`, which does not exist. The suite aborts there, so every check after history pagination — branches, the home route, and the rest — has never run.

This was first recorded as a footnote on BUG-139, which reproduced it identically at HEAD in a clean worktree and established it is not that fix. It predates BUG-139 and belongs to the FEAT-099 git surface work. It is filed here so it stops being carried as a note on other tickets.

## Risks

The view is read-only, so nothing can be lost by this; the cost is unreachable history and two suites that cannot finish.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-25 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-09-23 — agent (fixing, round 1, class=explore)
- **Observed the real click-to-render path** in headless Brave with request +
  DOM instrumentation. The ticket's server-half claim holds: the HTTP route
  forwards `cursor` (`src/server/index.ts:945`), `git.log()` reads it, and both
  pages return correctly. The candidate in the Diagnosis (`project().id` outside
  `loadMore`'s try) is NOT the cause — `project()` is defined throughout.
- **Root cause (a race, not a dropped result).** A single hash / Back-Forward
  navigation fires the git view's `open()` **twice**: both the `hashchange`
  (`public/app.js`) and the `popstate` listener route git and call `showGit`,
  and Chromium raises both on a Back/Forward that changes the fragment (the WA
  itself exercises this at `verify-git.mjs` lines 678–681). Two `loadHistory()`
  then race, each unguarded. A superseded one resolves late and calls
  `buildHistory()` (`rows.clear()` + `replaceChildren`), silently discarding the
  page `loadMore()` had just appended → the row count snaps back to 50 and
  "Load more" appears to do nothing, with no error text. History is the only
  git sub-view carrying accumulated client state (appended pages) a rebuild can
  destroy. It is timing-dependent — rare under fast localhost (the live
  `verify:git` flake was ~1 in ~12 runs); the `?limit=50` request fired twice
  for a single navigation was the tell.
- **Fix** (`public/lib/git-view.js`): bind `loadView`/`loadHistory` to `open()`'s
  existing `generation` token and return before mutating shared state or the DOM
  once superseded. A stale load now returns at the top guard *before* it even
  issues its fetch, so the second page-1 request is never made and there is
  nothing to clobber. Scope is deliberately history-only — the other sub-views
  rebuild identical full lists and have no appended state to lose.
- **Proof.** New `scripts/verify-bug-142-loadmore-race.mjs` drives the exact
  interleaving deterministically with CDP request interception (holds the stale
  page-1, renders via the live one, `loadMore` → 100, releases the stale load).
  Must-FAIL: full pre-fix state (all three edits reverted) fails the anti-clobber
  assertion 3/3 runs; post-fix passes 4/4 (incl. a third page landing, the
  button disappearing at end of history, and every sha unique — no loop/double
  render). `npm run verify:git` now runs **to completion: 74 passed, 0 failed**
  (previously aborted at ~69 in history pagination). Regressions green:
  bug-150-load-window-queue 16/16, bug-150-adversarial 25/25,
  bug-166-decision-composer 10/10; `npm run gate` PASS (exit 0).
- **Note for reviewers.** This is a concurrency/race fix in a file with recent
  churn (BUG-150, BUG-166, BUG-162) — an independent clean-room verify pass is
  warranted before close. Left UNSTAGED for the user to commit.

### 2026-09-23 — agent (verifying, round 2, class=verify) — INDEPENDENT
- **Verdict: PASS.** Read only the diff, the test, and the ticket — not the
  fixer's rationale — then attacked. The user-observable requirement holds:
  Load more appends older commits repeatedly and the end of history stops
  cleanly with no dup/loop/gap.
- **Executed evidence.** Fixer's `verify-bug-142-loadmore-race.mjs` 4/4 across
  4 runs (asserts rendered rows 50→100→120, every sha unique, button gone at
  end, and that the released stale page-1 request was *never issued* post-fix —
  `staleRequestWasIssued:false`). `npm run verify:git`: the
  `history pages, loads more…` check passed in **every** run I made (~20+);
  never once flaked (pre-fix flaked ~1/12 on this exact real double-open nav
  path). First 7 consecutive runs were a clean 74/0.
- **Cross-check on the crown-chip noise.** Mid-verification the shared tree was
  being mutated by concurrent lanes (public/app.js, styles.css, index.html,
  src/server/git.ts all modified — not mine). verify:git began reporting
  `71 passed, 3 failed`, all three being *crown chip* checks (rendered chip
  collapsed to a bare dirty-count number). Proven NOT a BUG-142 regression:
  swapping git-view.js back to HEAD (fix reverted, other lanes' edits intact)
  reproduced the identical 3 crown-chip failures, and the history/loadMore
  checks still passed. Restored the fixer's git-view.js byte-identical
  afterward. Those 3 failures belong to a concurrent lane, not this fix.
- **Attacks run:** superseded loadHistory clobber after Load more (the reported
  bug) — held via CDP interception, list stays 100, PASS; end-of-history with
  the last partial page (20) — button disappears cleanly, PASS; duplicate-row /
  loop check at end — all sha unique, PASS; double-click Load more — guarded by
  `historyBusy` re-entry check (reasoned, not the failure mode); stale-load
  error suppression — loadHistory catch is generation-guarded so a superseded
  reject shows no stale error, PASS.
- **Residual (out of BUG-142 scope, pre-existing — NOT introduced by this fix).**
  `loadMore()` itself carries NO generation token; its continuation mutates the
  shared `historyData` and DOM after the await. If a user clicks Load more on
  project A's history and navigates to project B's history before that cursor
  fetch resolves, A's page can append into B's list / corrupt B's historyData.
  loadHistory was the reported clobber and is now fixed; loadMore's own
  cross-navigation continuation is a distinct latent race that predates this
  change. Flagging for a follow-up ticket, not blocking this PASS.
- **Could NOT test (executed):** the cross-project loadMore race above (reasoned
  from the code, no CDP repro built — the shared tree was under concurrent
  mutation and a two-project interception harness was out of proportion for an
  out-of-scope latent bug); generation-token numeric overflow (not reachable —
  needs 2^53 navigations); the exact-50-commit and single-page boundaries
  (server-side pagination, already proven correct in the ticket).
- **Verified-by:** independent verifier lane, 2026-09-23. Fix stands; recommend
  the fixer's own note (independent clean-room pass warranted) is satisfied by
  this entry, and that the loadMore residual be filed separately.

### 2026-09-23 — agent (fixing, round 3, class=fix)
- **Closed the loadMore residual the independent verifier found** (rows 150–166
  above) rather than filing it — same defect class the ticket exists to kill,
  executed not theorised.
- **Reproduced it deterministically.** Two projects with distinct commit-subject
  markers (PROJA-*/PROJB-*); via CDP request interception, held project A's
  page-2 (cursor) fetch in flight, navigated to project B's history, then
  released A's fetch. Pre-fix (loadMore's guard reverted, round-1 fix intact)
  A's page spliced into B's rendered list — the new
  `scripts/verify-bug-142-loadmore-race.mjs` Phase-2 check fails 7/8, the P1
  history checks still pass, isolating loadMore as the one uncovered path.
- **Fix** (`public/lib/git-view.js`): one shared `superseded(token)` — the single
  authority for "is this response still for the current view?" reading open()'s
  `generation` — now used by `loadView`, `loadHistory` AND `loadMore` (and the
  open() stash promise), so no loader re-derives the check and the next one added
  can't forget it (ARCH-010, the coordinator's explicit ask: same mechanism, not
  a parallel token). `loadMore` captures the token at click time and drops its
  append if the view moved on; `historyBusy` is reset unconditionally (transient
  guard) and also reset in open() so a fresh view never inherits a stuck busy
  flag from an abandoned in-flight loadMore.
- **Proof.** `node scripts/verify-bug-142-loadmore-race.mjs` — 8/8 post-fix
  (P1 stale-rebuild clobber + P2 cross-project append); Phase-2 must-FAIL shown
  by reverting only loadMore's guard (7/8, P1 still green). `npm run verify:git`
  runs to completion with the `history pages, loads more…` check PASSING; the
  run's `71 passed, 3 failed` is entirely the crown-chip/status-line checks from
  concurrent lanes' unstaged edits to public/app.js (+88) and public/styles.css
  (+31) — files this fix never touched — matching the independent lane's
  already-proven-independent 71/3. Regressions green: bug-150-load-window-queue
  16/16, bug-150-adversarial 25/25, bug-166-decision-composer 10/10; `npm run
  gate` PASS (exit 0). Left UNSTAGED for the user to commit.
