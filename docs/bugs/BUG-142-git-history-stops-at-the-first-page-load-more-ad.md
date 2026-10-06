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
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-09-30",
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

### 2026-09-29 — clean-room verify driver (round 1, class=verify) — INDEPENDENT, VERDICT: BROKEN
- **Requirement verified:** clicking Load more repeatedly appends older pages
  (unique shas, button clears at end); a load failure shows on screen; and — the
  round-3 focus — navigating from project A's history to project B's *before* A's
  Load-more fetch resolves must not corrupt B's history. Verified out-of-process
  through a genuine clean room (`scripts/independent-verify.mjs`, wraps
  `scripts/dispatch.mjs`), NOT a Task subagent.
- **Strategy: committed range.** The round-3 loadMore fix landed in `561ad6b`
  (batch commit), which post-dates `seed-sources.mjs`, so a plain committed-range
  clean room boots. Range `3e7a3f1..561ad6b`; fixer test
  `scripts/verify-bug-142-loadmore-race.mjs` supplied as the test file.
  Command (tilde form):
  `node scripts/independent-verify.mjs --repo ~/projects/orchard --range 3e7a3f1..561ad6b --requirement @<req> --run "node scripts/verify-bug-142-loadmore-race.mjs" --run "npm run verify:git" --test-file scripts/verify-bug-142-loadmore-race.mjs --provider anthropic --timeout-min 20`
- **Verdict: BROKEN (VALID, manifest-backed).** The fixer test re-ran 8/8 and the
  APPEND guard holds — A's stale page never splices its rows into B (`projA:0` in
  B). But the clean room found a case the fixture never exercises: `loadMore`'s
  `finally` resets the SHARED `historyBusy` flag UNCONDITIONALLY (without the
  `superseded(token)` check the append path uses). So when B *also* has a
  Load-more in flight, A's late page clears B's busy flag → B's button re-enables
  mid-fetch → a duplicate B page-2 fetch fires → B ends with 150 rows, only 100
  unique. B's own history is corrupted, triggered by the cross-project
  interaction — the round-3 guard covers the append but not the shared busy flag.
  Adversarial run `be1c7bb5b3d8` exit 1 (`node scripts/adv-crossproject-busy.mjs`,
  the verifier's own harness): "B's Load more stays disabled while B's own fetch
  is in flight" FAILs (observed enabled), duplicate B cursor fetch issued, final
  `{rows:150, unique:100}`.
- **FINDING:** `public/lib/git-view.js` `loadMore`: the `finally { historyBusy=false }`
  runs even when the load is superseded, clearing another view's in-flight busy
  guard. Repair candidate: gate the `historyBusy` reset (and the DOM/state
  mutation) on `!superseded(token)`, as the append already is.
- **Could-not-test (from the verdict):** did not run `npm run verify:git` to
  completion nor test the on-screen load-failure message (the verifier's recorder
  became unavailable mid-run and it focused on the cross-project race); Phase-1's
  stale-rebuild leg printed `staleRequestIssued:false`, so that particular PASS
  did not actually exercise the double-open rebuild. These are coverage gaps, not
  the basis of the BROKEN verdict, which rests on the manifest-backed run above.
- **Status stays open** (BROKEN). Next lane: gate the `historyBusy`/DOM reset in
  `loadMore` on `!superseded(token)`, then re-verify the cross-project busy-flag
  case plus `verify:git` to completion.
- **Verified-by:** dispatch anthropic (grey account, same-provider fallback) run
  8fc1c329-17db-4e4c-94f6-1fe455626c11 (clean-room, `scripts/independent-verify.mjs`,
  committed range `3e7a3f1..561ad6b`) — VERDICT: BROKEN.

### 2026-09-29 — agent (fixing, round 4, class=fix)
- **Root cause confirmed and reproduced with my own command** (the round-3
  clean-room BROKEN finding, run 8fc1c329). `loadMore`'s `finally { historyBusy=false; … }`
  ran UNCONDITIONALLY, including on the superseded early-return path. `historyBusy`
  is a SHARED module-scope boolean, so a superseded load-more (project A, or a
  prior generation of the same project) cleared the flag while another view's
  load-more (project B / the current generation) was still in flight → B's
  re-entry guard defeated → duplicate page-2 fetch → B ends **150 rows, 100
  unique** (exactly the verifier's `{rows:150, unique:100}`).
- **The invariant.** Busy/in-flight state is OWNED per request token: only a
  load-more that is still current (`!superseded(token)`) may clear `historyBusy`;
  a superseded one must not touch it. `open()` owns the cross-generation reset,
  so skipping the stale clear can never wedge the flag (the current view always
  re-sets it at the top of its own load-more).
- **Fix** (`public/lib/git-view.js`): moved `historyBusy=false` inside the
  `finally`'s existing `!superseded(token)` gate — `finally{if(!superseded(token)){historyBusy=false;historyMore()}}`.
  Then applied the SAME rule to the sibling leaf loaders the charter named
  (loadHistory/loadView/open family): `loadChanges`, `loadBranches`, `loadStashes`
  now take the generation `token` (threaded from `loadView`), drop their result
  and skip clearing the shared `loading` flag once `superseded` — closing the
  identical cross-project clobber on the changes/branches/stashes views before a
  round 5 finds it. `superseded()` stays the ONE authority (ARCH-010).
- **Proof.** New `scripts/verify-bug-142-busy-flag.mjs` drives the real
  click-to-render path in headless Brave with CDP interception, counting
  per-project page-2 fetches (observable, disabled-state-independent).
  Must-FAIL (pre-fix, all edits absent): **4 PASS / 4 FAIL** — C1 cross-project
  ends `{rows:150,unique:100}` and issues 2 project-B cursor fetches; C2
  same-project re-enter ends `{rows:150,unique:100}`. PASS-after: **8/8** (C1
  `{rows:100,unique:100}`, one B fetch; C2 `{rows:100,unique:100}`, two A
  fetches; C3 double-click still one fetch). Anti-regression:
  `verify-bug-142-loadmore-race.mjs` (round 1/3) **8/8**; `npm run verify:git`
  now runs **to completion** — the `history pages, loads more…` check PASSES;
  the run's `71 passed, 3 failed` is entirely the crown-chip/status-line checks
  (rendered by `public/app.js`, which carries +221 unstaged lines from a
  concurrent lane — not this fix; git-view.js has no role in crown-chip
  rendering), matching the round-2/3 already-proven-independent 71/3.
  `npm run gate` PASS (exit 0); `npm run board:check` OK (no drift). Left
  UNSTAGED for the user to commit.
- **Sibling race I declined to close → filed BUG-203.** The git WRITE handlers
  (`switchBranch`/`checkoutRemote`/`createForm`/`commitForm`/`sync`, and
  `refreshBranch`) share the same defect class — `branchBusy`/`committing` are
  shared flags cleared unconditionally, `refreshBranch` renders shared state with
  no `superseded` guard, and the post-await `loadChanges(true)` callers capture
  the wrong generation. Out of BUG-142's named load-path scope; expanding into
  commit/branch-switch flows in round 4 of a race-prone hot file was judged out
  of proportion. Filed with a concrete repair candidate.
- **Note for reviewers.** Session-lifecycle / regression-prone (this is round 4
  of a race in a churny file — regressed-from the round-3 fix which covered the
  load-more APPEND but not the shared busy flag). An independent clean-room
  verify pass is warranted before close: re-verify the cross-project busy-flag
  case (`scripts/verify-bug-142-busy-flag.mjs`) plus `verify:git` to completion.
- **Symptom of a deeper design flaw?** yes → this is the fourth shared-flag /
  superseded-continuation race in one module; BUG-203 files the write-path
  instance. The structural fix (every git-view async continuation reads the one
  `superseded` authority; no shared boolean cleared by a stale continuation) is
  now applied across every load path — BUG-203 carries it to the write paths.

### 2026-09-29 — clean-room verify driver (round 4, class=verify) — INDEPENDENT, VERDICT: BROKEN
- **Verified TOGETHER with BUG-203** (both fixes are uncommitted and share
  `public/lib/git-view.js`). Out-of-process clean room via
  `scripts/independent-verify.mjs --working-tree` (wraps `scripts/dispatch.mjs`),
  NOT a Task subagent. Requirement (`/tmp/req-BUG-142-r4.txt`): every git-view
  async continuation whose view has moved on (another project, or a newer
  generation) must not clear or leave-set the shared `historyBusy`/`branchBusy`/
  `committing`/`loading` flags nor draw its stale result into the current view,
  on BOTH load and write paths; attack drove all four flags across A→B / A→B→A
  switches and a superseded write completing late. BUG-203's corrected premise
  (flag-leak-across-switch, not a data clobber) was the claim under judgement.
- **The round-4 named fixes HOLD.** BUG-142 fixer test
  `verify-bug-142-busy-flag.mjs` re-ran 8/8 (run f64d8b31e2b2, cited in the
  verdict's UNTESTED because only one FIXER-TEST slot is allowed); BUG-203
  `verify-bug-203-writepath-race.mjs` 3/3 (run 4c7b28fc9949): `historyBusy` and
  `branchBusy` no longer leak/clear across the switch. So the specific defects
  the round-3 verdict and round-4 fix targeted are closed.
- **Verdict: BROKEN (VALID, manifest-backed).** The clean room broke the broader
  invariant on two ADJACENT paths the fixtures never exercise — both concern the
  `loading` flag / the stage-toggle handler, which the round-4 fix did not touch:
  - **`toggle()` (the stage checkbox) captures NO generation token.** When
    project A's stage POST resolves after the panel navigates to B, it writes A's
    status into B's view — B's header renders `alphabranch` and B's commit button
    reads "Commit 1 file to alphabranch" (adversarial run 2951291fbc39, exit 1).
    A genuine cross-project DATA render leak, via the one write-ish handler
    neither ticket named.
  - **`toggle()`'s catch → `fail()` + `loadChanges(true)` under the CURRENT
    generation.** A's failed stage shows error `STALE-A-STAGE-FAILURE` in B's
    view, and that quiet reload's `finally` sets `loading=false` while B's own
    changes load is still in flight — B's sync button flips disabled→enabled
    mid-load (adversarial run 7399ec91b0c7, exit 1).
  - **`open()` resets `historyBusy`/`branchBusy`/`committing` but NOT `loading`
    (nor `batching`).** So the requirement's "open() resets every shared in-flight
    flag" is false for `loading`.
- **FINDING (verbatim from the VALID verdict):** (1) `toggle()` has no token, so
  A's late stage resolve renders A's status into B; (2) `toggle()`'s catch runs
  `fail()`+`loadChanges(true)` under the current generation, showing A's error in
  B and clearing B's `loading` mid-load; (3) `open()` does not reset `loading`.
- **Could-not-test (from the verdict):** sync pull/push/publish against a real
  remote (clean-room origin is an empty bare repo — only fetch reachable); the
  three-step A→B→A switch and same-project reopen for the commit/create-branch
  forms (read the code, not driven); the select-all/`toggleAll` `batching` flag
  (read, not run).
- **Status stays OPEN** (BROKEN). Next lane (scope call for the orchestrator):
  the `toggle()` stage handler and the `loading` reset in `open()` are the
  uncovered instances of the SAME shared-flag/superseded-continuation class this
  ticket exists to kill — capture the generation token in `toggle()`, gate its
  render/flag-clear on `!superseded(token)`, and reset `loading` (and `batching`)
  in `open()`. These may belong here, on BUG-203, or a new sibling — decide scope
  before dispatching the fix.
- **Verified-by:** dispatch anthropic (grey account, same-provider fallback —
  author-provider anthropic, decorrelation reduced) run
  5aa54e8e-995b-44a3-8fc1-6a726dfbf4cc (clean-room, `scripts/independent-verify.mjs`,
  `--working-tree`) — VERDICT: BROKEN.

### 2026-09-29 — agent (note: residuals closed under BUG-203 r2)
- **This ticket's own fix HOLDS** — the clean room re-ran BUG-142's busy-flag suite
  8/8 and loadmore-race 8/8; the BROKEN verdict above was for adjacent paths
  (`toggle()`, the `loading` reset), NOT the `loadMore`/`historyBusy` fix this
  ticket owns.
- **The two residuals are now CLOSED under BUG-203 round 2** (coordinator scope
  call: both land there). BUG-203 r2 converted EVERY async path in `git-view.js`
  to the generation-token invariant and added a structural scan
  (`scripts/verify-gitview-async-token.mjs`) that fails if any async path awaits
  then touches state without a `superseded(` guard. See BUG-203's r2 Activity entry.
  Recommend this ticket's independent re-verify run include that scan.

### 2026-09-29 — clean-room verify driver (verifying, round 2 of the joint BUG-203 r2 fix, class=verify) — INDEPENDENT, VERDICT: BROKEN
- **Verified TOGETHER with BUG-203 round 2** (both fixes uncommitted, sharing
  `public/lib/git-view.js`). Out-of-process clean room via
  `scripts/independent-verify.mjs --working-tree` (wraps `scripts/dispatch.mjs`),
  NOT a Task subagent. The joint requirement (`/tmp/req-BUG-203-r2.txt`) tested
  the CLASS claim BUG-203 r2 makes over the whole module — every async path
  generation-owned, `open()` resets every per-project flag, structural scan
  enforces it — since BUG-142's two round-4 residuals (`toggle()`, the `loading`
  reset) were folded into that class fix.
- **This ticket's own load-path fixes still HOLD** — the round-1/3/4 `loadMore` /
  `historyBusy` / `loading`-leaf-loader work was not re-broken; the toggle-race
  harness ran clean (run 06034c0dbd7f, exit 0). The BROKEN verdict is against the
  BUG-203 r2 CLASS claim, not BUG-142's history/load paths.
- **Verdict: BROKEN (VALID, manifest-backed).** Two class-completeness claims
  broke on paths no harness drives — recorded in FULL on BUG-203's r2 Activity
  entry (run e0afcc07): (1) `open()` is itself unguarded after `await
  loadView(token)` — its `void projects(token)` has no `superseded` check and
  `projects()` calls `replaceChildren` before its first await, wiping project B's
  dropdown 2→1 on a released superseded A open (run 91ede6fe6f0e, exit 1); (2) the
  structural scan is fooled 5/5 (guard-after-touch, vacuous guard, then-chain,
  helper indirection, second async fn on a guarded line — run dffc50a0f286, exit
  1), so it does not actually prevent a missing path landing silently.
- **Status stays OPEN** (BROKEN) — carried by BUG-203, which owns the class fix.
  BUG-142's own load/history behaviour is unaffected. See BUG-203 r2 for the next
  lane's handoff (guard `open()`'s own continuation; harden the scan).
- **Verified-by:** dispatch anthropic (grey account, same-provider fallback —
  author-provider anthropic, decorrelation reduced) run
  e0afcc07-b666-4e7d-8d1e-d834bb2ad649 (clean-room, `scripts/independent-verify.mjs`,
  `--working-tree`) — VERDICT: BROKEN.

### 2026-09-30 — agent (note: BUG-142's own fix still holds; class closed under BUG-203 r3)
- The BROKEN verdicts above were for the broader git-view async class, NOT the
  `loadMore`/`historyBusy` fix this ticket owns — its busy-flag 8/8 and
  loadmore-race 8/8 re-ran green through every round. BUG-203 round 3 has now
  REDESIGNED the whole module onto one `guard(token, promise)` async boundary
  (the only await in `git-view.js`), with a parsed structural scan
  (`scripts/verify-gitview-async-token.mjs`) that rejects the 5 patterns that
  fooled the r2 scan. `loadMore`/`loadHistory` are part of that conversion.
  Recommend this ticket's independent re-verify run include the redesigned scan.

### 2026-09-30 — clean-room verify driver (verifying, round 3 of the joint BUG-203 r3 fix, class=verify) — INDEPENDENT, VERDICT: BROKEN
- **Verified TOGETHER with BUG-203 round 3** (BUG-203 r3 uncommitted, sharing
  `public/lib/git-view.js`). Out-of-process clean room via
  `scripts/independent-verify.mjs --working-tree` (wraps `scripts/dispatch.mjs`),
  NOT a Task subagent. The joint requirement (`/tmp/req-BUG-203-r3.txt`) judged
  the r3 REDESIGN that carries the whole module — including `loadMore`/
  `loadHistory` — onto the single `guard(token, promise)` async boundary.
- **This ticket's own load-path behaviour is unaffected.** BUG-142's busy-flag /
  `loadMore` / `historyBusy` fixes are not the subject of the BROKEN verdict; the
  lexer scan re-ran 9/9 against its own fixtures (run f67d51a3cfcc, exit 0) and
  the fired-loader-rejection probe held 4/4 with 0 unhandled rejections (run
  122b0680a3f7, exit 0).
- **Verdict: BROKEN (VALID, manifest-backed)** — against BUG-203 r3's redesign of
  the shared file, recorded in FULL on BUG-203's round-3 Activity entry (run
  51f611bc): (1) the module's single `guard` returns a shared module-lifetime
  `NEVER` promise, so every superseded continuation's async frame is retained
  UNBOUNDED across project switches — 500/500 scopes retained vs 0/500 with a
  per-call never-promise (run bffac52adb7c, exit 1); (2) the rewritten parsed
  lexer scan is FOOLED 7/7 on surface forms the 5 shipped fixtures don't cover
  (postfix `++`/`--` before a divide, spaced/newline/computed `.then`, a stray
  `.then` on the `const guard` line, and a vacuous live-`generation` token — run
  c97085c555ad, exit 1).
- **Status stays OPEN** (BROKEN) — carried by BUG-203, which owns the r3 redesign.
  BUG-142's own history/load behaviour is unaffected. See BUG-203 r3 for the next
  lane's handoff (fix guard's retention; harden the lexer).
- **Verified-by:** dispatch anthropic (second anthropic account, distinct from the fixer's — same-provider fallback;
  grey at cap, openai parked — author-provider anthropic, decorrelation reduced)
  run 51f611bc-cc24-44b4-b403-073c3b72514d (clean-room,
  `scripts/independent-verify.mjs`, `--working-tree`) — VERDICT: BROKEN.

### 2026-09-30 — clean-room verify driver (verifying, round 4 of the joint BUG-203 r4 fix, class=verify) — INDEPENDENT, VERDICT: BROKEN
- **Verified TOGETHER with BUG-203 round 4** (BUG-203 r4 uncommitted, sharing
  `public/lib/git-view.js`). Out-of-process clean room via
  `scripts/independent-verify.mjs --working-tree` (wraps `scripts/dispatch.mjs`),
  NOT a Task subagent. The joint requirement (`/tmp/req-BUG-203-r4.txt`) judged
  the r4 fixes carried across the whole module — retention reclaim, the
  fail-closed lint scan, and the busy-flag-leak invariant — which include
  `loadMore`/`loadHistory`.
- **This ticket's own load-path behaviour is unaffected.** BUG-142's busy-flag /
  `loadMore` / `historyBusy` fixes are not the subject of the BROKEN verdict; the
  busy-flag-leak check found all 28 shared-flag `false` writes (incl.
  `historyBusy`) sit behind an `await guard(` (run 0a82c5db34fb, exit 0), and the
  retention fix HOLDS (800/800 reclaimed adversarially, run b451b7ea0681, exit 0).
- **Verdict: BROKEN (VALID, manifest-backed)** — against BUG-203 r4's shared lint
  scan, recorded in FULL on BUG-203's round-4 Activity entry (run 997b8ca5):
  the fail-closed `verify-gitview-async-token.mjs` is FOOLED a THIRD round — a
  `/` after a keyword (`return`) or after `)` is misread as division
  (`REGEX_PREV` lacks keywords and `)`), so a regex literal there blanks the
  following genuinely-unguarded `await`/`.then` and the scan reports zero
  violations (adversarial run 7c72559d0441, exit 1, 3 boundaries accepted).
- **Could-not-test:** the four browser-driven fixer tests (incl. this ticket's
  `verify-bug-142-busy-flag.mjs`) could not run in the clean room — the sandbox
  blocks the `git init` they need — so BUG-142's cross-project busy-flag behaviour
  was checked only statically this round, not driven in a browser. `npm run
  verify:git` was not run (same git-write block).
- **Status stays OPEN** (BROKEN) — carried by BUG-203, which owns the shared scan.
  BUG-142's own history/load behaviour is unaffected. See BUG-203 r4 for the next
  lane's handoff (make the scan fail-closed against a regex literal after a
  keyword/`)`).
- **Verified-by:** dispatch anthropic (a second anthropic account (distinct from the fixer's) — same-provider
  fallback, distinct from the fixer's account; grey near cap, openai parked —
  author-provider anthropic, decorrelation reduced) run
  997b8ca5-5609-48f5-8e5f-1d0d853fce28 (clean-room, `scripts/independent-verify.mjs`,
  `--working-tree`) — VERDICT: BROKEN.

### 2026-09-30 — clean-room verify driver (verifying, round 5 of the joint BUG-203 r5 fix, class=verify) — OPTION-B IN-REPO, VERDICT: BROKEN (BUG-142 load-path HOLDS)
- **Verified TOGETHER with BUG-203 round 5** (both share `public/lib/git-view.js`;
  r5 is uncommitted). Because the clean-room sandbox blocks the `git init` the CDP
  harnesses need — the reason BUG-142's cross-project busy-flag behaviour was only
  ever checked STATICALLY in the r3/r4 rooms — this round ran an OPTION-B in-repo
  verify: a SEPARATE-PROCESS dispatch (run 625ee528) against the LIVE checkout on
  FREE ports, repo READ-ONLY. First time BUG-142's browser harnesses ran under an
  independent process.
- **BUG-142's OWN load-path fix HOLDS, driven in a browser independently:**
  `verify-bug-142-busy-flag.mjs` 8/8 (exit 0) and `verify-bug-142-loadmore-race.mjs`
  8/8 (exit 0). So the `loadMore`/`historyBusy` cross-project busy-flag invariant
  this ticket owns is now confirmed by an independent driven-DOM run, closing the
  "checked only statically" gap the r4 room recorded. `npm run verify:git` ran
  71/74 — the `history pages, loads more…` check PASSED; the 3 failures are the
  crown-chip/status-line checks from concurrent `public/app.js`/`drawer.js` edits,
  not this fix (same 71/3 as prior rounds).
- **Verdict: BROKEN (VALID) — against the SHARED structural scan, which BUG-203
  owns, NOT BUG-142's history/load paths.** The fail-closed `verify-gitview-async-token.mjs`
  was fooled a fourth round on five constructs the fixtures don't cover (comment
  terminated by U+2028/U+2029/lone-CR; identifier-escape `.then(`;
  destructured/computed `.then`; shadowed `guard` parameter; async logic moved into
  the UNSCANNED `git-view-fmt.js` with a callback). Recorded in FULL on BUG-203's
  round-5 Activity entry (run 625ee528). The SHIPPED git-view.js contains none of
  them, so runtime is unaffected.
- **Status stays OPEN** — carried by BUG-203, which owns the shared scan. BUG-142's
  own history/load behaviour is unaffected and now independently verified. See
  BUG-203 r5 for the orchestrator decision (accept the scan as a best-effort lint
  vs. harden it further).
- **Verified-by:** dispatch anthropic (grey account, personal weekly PARKED —
  same-provider, decorrelation reduced) run
  625ee528-94e5-49d9-bafe-c4d858440a45 (option-b in-repo, reduced isolation —
  verifier could see the board; live checkout, free ports, repo read-only) —
  VERDICT: BROKEN (BUG-142 load-path HOLDS; break is the shared scan).

### 2026-09-30 — orchestrator decision (verifying, round 5, class=trivial) — DECISION A: VERIFIED; scan claim WITHDRAWN
- **Decision (A), recorded.** BUG-142's OWN load-path fix is independently
  confirmed by run 625ee528, which for the FIRST time drove this ticket's
  behavioural harnesses in a real browser under an independent process:
  `verify-bug-142-busy-flag.mjs` 8/8 and `verify-bug-142-loadmore-race.mjs` 8/8. In
  the same run `npm run verify:git`'s `history pages, loads more…` check PASSED. So
  the `loadMore`/`historyBusy` cross-project busy-flag invariant this ticket owns is
  confirmed by a driven-DOM independent run, closing the "checked only statically"
  gap the r3/r4 rooms recorded.
- **The shared structural scan is no longer a soundness claim — RETRACTED.** The
  `verify-gitview-async-token.mjs` break (fooled a fourth round) is against a
  best-effort single-file LINT that BUG-203 owns, not against BUG-142's history/load
  paths. A parser would be needed to make it sound; further hardening has stopped
  buying anything (WA §N). Its header now says so plainly (no logic changed). Full
  detail lives on BUG-203's r5 decision entry (run 625ee528).
- **Verification was OPTION-B in-repo — recorded honestly.** Reduced isolation
  (same-provider anthropic; the verifier could see the board), a separate-process
  DISPATCH (not a Task subagent) against the LIVE checkout on free ports, repo
  read-only. Chosen because the clean-room sandbox blocks the `git init` the CDP
  harnesses need.
- **Scan residual (the withdrawn claim's holes), none present in the shipped file:**
  comment U+2028/U+2029/lone-CR terminator; identifier-escape `.then(`;
  destructured/computed `.then`; shadowed `guard` parameter; async logic moved into
  the unscanned `public/lib/git-view-fmt.js` with a callback.
- **What remains unverified:** `npm run verify:git`'s 3 failures are the
  crown-chip / status-line checks in `public/app.js` / `public/drawer.js` edited by
  concurrent lanes — they belong to those lanes, not this ticket; BUG-142's own
  history/load check passed.
- **Status → VERIFIED** on the confirmed load-path fix; the withdrawn scan claim is
  BUG-203's and is not a blocker here.
- **Verified-by:** dispatch anthropic run 625ee528-94e5-49d9-bafe-c4d858440a45
  (option-b in-repo, reduced isolation — same-provider anthropic, grey account /
  personal weekly PARKED, verifier could see the board; live checkout, free ports,
  repo read-only) — executed PASS on `verify-bug-142-busy-flag.mjs` 8/8 and
  `verify-bug-142-loadmore-race.mjs` 8/8; scan claim withdrawn.
