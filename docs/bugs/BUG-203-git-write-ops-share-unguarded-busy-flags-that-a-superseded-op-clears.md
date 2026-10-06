# BUG-203 — switching project mid branch-switch or commit leaks the busy flag, stalling or double-submitting the other project's git controls

- **Status:** VERIFIED — product fix independently confirmed by run 625ee528; scan claim withdrawn (round 5 decision A, 2026-09-30). The r5 option-b in-repo verify (separate-process dispatch against the LIVE checkout on free ports, run 625ee528) DROVE all six behavioural CDP harnesses independently for the FIRST time: busy-flag 8/8, loadmore 8/8, writepath 3/3, toggle 4/4, open-continuation 3/3, retention 500/500 reclaimed — so the flag-leak-across-switch and retention claims are confirmed by a driven-in-a-browser independent run. The STRUCTURAL scan (`verify-gitview-async-token.mjs`) is RETRACTED as a soundness claim and is now a documented best-effort single-file lint (four rounds proved it foolable; sound only with a real parser) — its header says so and its logic is unchanged. The known scan holes (comment U+2028/U+2029/lone-CR terminator, identifier-escape `.then(`, dynamic/destructured `.then`, shadowed `guard` param, logic moved to the unscanned `git-view-fmt.js`) are NONE of them present in the shipped git-view.js. verify:git's 3 failures are crown-chip/status-line checks in `app.js`/`drawer.js` (other lanes), not git-view. Verified-by run 625ee528 (option-b in-repo, reduced isolation). — was: OPEN — PRODUCT FIX INDEPENDENTLY CONFIRMED, scan residual only (round 5, 2026-09-30). The r5 option-b in-repo verify (separate-process dispatch against the LIVE checkout on free ports, run 625ee528) DROVE all six behavioural CDP harnesses independently for the FIRST time — the earlier clean rooms could never run them (sandbox blocks `git init`). Every product harness HOLDS: busy-flag 8/8, loadmore 8/8, writepath 3/3, toggle 4/4, open-continuation 3/3, retention 500/500 reclaimed. So the flag-leak-across-switch and retention claims are now confirmed by a driven-in-a-browser independent run, not just locally. The residual is again the STRUCTURAL scan (requirement 3): r5 fails closed on bare `/` (division+regex moved to `public/lib/git-view-fmt.js`), but the verifier fooled it a FOURTH round on constructs the fixtures don't cover — `//` comment terminated by U+2028/U+2029/lone-CR, an identifier-escape `.then(`, destructured/computed `.then`, a shadowed `guard` parameter, and (the git-view-fmt hole) async logic moved into the UNSCANNED helper module with a callback. The SHIPPED git-view.js contains NONE of these, so runtime is unaffected; the break is against the scan's "cannot be fooled" property. Stays OPEN pending an orchestrator decision: accept the scan as a best-effort single-file lint (not a security boundary, per r4/r5 notes) and VERIFY on the now-confirmed product, OR keep hardening the scan. Do NOT mark VERIFIED without that decision.
  <!-- historical: r1/r2 chased paths one at a time and the clean room kept finding the next miss (`toggle`, `loading`, then `open()`'s own continuation) while the r2 line-regex scan was fooled 5/5. r3 REDESIGNS so the check cannot be forgotten: one `guard(token, promise)` helper is the only async boundary in `git-view.js` — reaching the code after `await guard(...)` IS the proof the token is current, so no caller can forget it — and `open()` no longer awaits, so it cannot suspend then run a continuation (the dropdown-wipe). Enforced by a PARSED structural scan (comment/string/template/regex-aware lexer, whole-file). r3's clean-room verify (run 51f611bc) returned BROKEN on two grounds, both now fixed in **r4 (2026-09-30)**: (a) the shared module-lifetime `NEVER` retained every superseded continuation → r4 gives each superseded resolution its OWN never-promise (an unrooted, collectable cycle; measured 500/500 frames reclaimed vs 0/500 on r3); (b) the lexer was fooled 7/7 → r4 makes it FAIL CLOSED (forbids `++`/`--` outright — the real file was simplified to `+= 1`; matches `.then`/`.catch`/`.finally` across whitespace/newline/computed access; exempts only the guard's own `.then`; rejects a vacuous live-`generation` token), with all 7 forms plus the earlier 5 as must-FAIL fixtures. r4's independent clean-room verify (run 997b8ca5, 2026-09-30) returned BROKEN: the retention fix and the busy-flag-leak invariant HOLD, but the fail-closed scan is FOOLED a THIRD round — a regex literal after a keyword (`return`) or `)` is misread as division and blanks a following unguarded `await`/`.then` (3 boundaries accepted). Stays OPEN; residual is the scan only. Behavioural CDP claims remain unverified in an independent room (sandbox blocks git init). -->
- **Superseded status prose above is retained for history inside the comment; the current status is the first bullet.**
- **Severity:** low-med (a git-view control/render glitch on the slide-panel; requires navigating between projects while a git request — branch switch / checkout / commit / STAGE / load — is in flight. No data loss: the server-side action completes correctly; the harm is the OTHER project's controls being wrongly disabled or re-enabled, or one project's status/error/diff rendering into another's view, until the next clean load)
- **Area:** ALL async paths in `public/lib/git-view.js` — loads (`loadChanges`/`loadBranches`/`loadStashes`/`loadHistory`/`loadMore`/`loadView`), writes (`switchBranch`/`checkoutRemote`/`createForm`/`commitForm`/`sync`/`refreshBranch`), stage (`toggle`/`toggleAll`), detail (`selectFile`/`selectStash`/`selectCommit`), `projects`, `fetchNow`, and the grant path (`loadGrant`/`gwAllow`/`gwRevoke`); plus the per-project flags reset in `open()` (`loading`/`batching`/`committing`/`syncing`/`branchBusy`/`historyBusy`/`gwBusy`/`liveConfirmed`/`failures`, and the `pending` set)
- **Reported:** 2026-09-29 (found while closing BUG-142's `historyBusy` leak; this is the SAME defect class in the write paths, deliberately left out of BUG-142's named scope — history/load paths only)
- **Related:** BUG-142 (same class: a superseded async continuation clears a SHARED busy flag / renders shared state after the view moved on; BUG-142 fixed the load/history paths, this is the write-path residual)

## Symptom
On the git slide-panel, start a branch switch / remote checkout / branch create / commit in project A,
then switch the panel to project B before the write resolves. Two observable failures, both because
the SHARED `branchBusy` / `committing` flag is not owned per generation:

1. **B's controls stall.** `open()` did not reset `branchBusy` / `committing`, so A's in-flight write
   leaves the flag SET when B's view opens. B's branch-switch / create guard reads the leaked flag and
   refuses — B's git-write controls are dead until A's unrelated write resolves.
2. **B's controls double-submit.** Once B has started its own write (flag now owned by B's generation),
   A's superseded write resolving runs its `finally` and clears the flag UNCONDITIONALLY — re-opening
   B's re-entry guard mid-operation, so a second B write can fire (a duplicate switch/commit).

The git write itself always completes correctly server-side; the harm is B's control state.

> Correction to this ticket's original framing (same lane, same day): the filed version claimed A's
> `refreshBranch()` renders A's *data* into B's view. That is NOT what happens — `refreshBranch` reads
> the LIVE `project().id` (already B after the nav), so it fetches B's own data. There is no
> cross-project data clobber; the real, reproduced defect is the shared flag leak/clear above.

## Why (same mechanism as BUG-142)
`branchBusy` and `committing` are SHARED module-scope booleans owned by no particular request:

- the write handlers' `finally` cleared them UNCONDITIONALLY — exactly the shape BUG-142 fixed for
  `historyBusy` in `loadMore` — so a superseded write clears the current view's flag;
- `open()` reset `historyBusy`/`syncing` but NOT `branchBusy`/`committing`, so a stale write flag
  leaked forward into a freshly-opened view;
- `commitForm.onsubmit` / `sync.onclick` call `loadChanges(true)` AFTER their own await, so BUG-142's
  `token=generation` default captured the NEW generation once the user had navigated away.

## Fix
**r1 (write handlers):** capture the `generation` token at click/submit time in `switchBranch` /
`checkoutRemote` / `createForm` / `commitForm` / `sync`; thread it into `refreshBranch(token)` and
`loadChanges(quiet, token)`; gate every shared-state write and `finally` flag-clear on
`!superseded(token)`; reset `branchBusy` / `committing` in `open()`.

**r2 (the whole class):** the clean room proved fixing paths one at a time does not converge, so r2
converts EVERY remaining async path in `git-view.js`: `toggle` / `toggleAll` (stage), `selectFile` /
`selectStash` / `selectCommit` (detail render), `projects` (the project dropdown), `loadGrant` /
`gwAllow` / `gwRevoke` (agent-git grant), and `fetchNow` (refactored off inline `t!==generation` onto
`superseded(t)` so the one authority is textual too). `open()` now resets EVERY per-project flag —
`loading`, `batching`, `gwBusy`, `liveConfirmed` (added) alongside the earlier ones — and clears the
`pending` stage set.

**r3 (make forgetting impossible — REDESIGN).** r2 still relied on each function remembering a
`superseded` check, and a line-regex scan the clean room fooled 5/5. r3 introduces ONE async boundary:
`guard(token, promise)` resolves to the value only while the token is current and otherwise returns a
promise that never settles, forwarding a rejection only while current. EVERY git-view async operation
is now `await guard(token, <api-call>)` and nothing else awaits or uses `.then`/`.catch`/`.finally`
(internal loaders are FIRED, not awaited — they self-guard). So reaching the code after
`await guard(...)` IS the proof the token is current; there is nothing to forget. `open()` no longer
awaits at all — every load/project/stash/fetch is fired — so it cannot suspend and then run a
continuation against a superseded view (the round-2 `projects()` dropdown-wipe); and `projects()` only
APPENDS other repos behind guard (open() sets the current option synchronously), so a stale one
touches nothing.

## Verification
- **Structural (the by-construction guard), redesigned:** `scripts/verify-gitview-async-token.mjs` is
  now a comment/string/template/regex-aware LEXER over the whole file (no AST parser is installed —
  typescript here is v7-native with no JS API, and acorn/@babel-parser were intentionally not added).
  It enforces two rules on real tokens: every `await` operand is `guard(<identifier>, …)`, and no
  `.then`/`.catch`/`.finally` outside the one-line `guard` helper. Post-fix: 23 awaits, all through
  guard, 0 violations → PASS. The round-2 clean room's 5 fooling patterns are encoded as must-FAIL
  fixtures and every one is now REJECTED (guard-after-touch → await-not-guard; vacuous literal token →
  vacuous-guard-token; then-chain → stray-.then; helper indirection → await-not-guard; two async fns
  on one line → await-not-guard), plus a false-positive check on a correctly-guarded snippet.
- **Behavioural — open()'s continuation (`scripts/verify-bug-203-open-continuation.mjs`), the round-2
  finding:** project A's initial changes fetch is held so A's open() is in flight; switch to B (both
  repos listed in the dropdown); release A. PASS post-fix (dropdown keeps both repos); must-FAIL
  pre-r3 (A's resumed continuation wipes B's dropdown back to one option). 3/3 post-fix.
- **Behavioural — stage path (`scripts/verify-bug-203-toggle-race.mjs`), the clean-room's cases:**
  T1 — A's held stage POST released after switching to B must not render A's status into B; PASS
  post-fix (B stays `bravobranch`), must-FAIL pre-r2 (B shows `alphabranch`). T2 — A's FAILED stage
  (fulfilled 500) must not surface A's error in B; PASS post-fix (B error empty), must-FAIL pre-r2
  (B shows `STALE-A-STAGE-FAILURE`). 4/4 post-fix.
- **Behavioural — write path (`scripts/verify-bug-203-writepath-race.mjs`):** C1 (flag must not leak
  across nav) + C2 (stale finally must not clear B's flag), each with its own partial-revert
  must-FAIL. 3/3 post-fix.
- **Anti-regression (all green after the r3 redesign):** `verify-bug-203-writepath-race.mjs` 3/3,
  `verify-bug-203-toggle-race.mjs` 4/4, BUG-142 `verify-bug-142-busy-flag.mjs` 8/8 and
  `verify-bug-142-loadmore-race.mjs` 8/8; `npm run verify:git` runs to completion (all git-view checks
  pass; the run's 71/3 is the crown-chip/status-line checks owned by concurrent `public/app.js` edits,
  not this fix). `npm run gate` PASS. Left UNSTAGED.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-29 — agent (BUG-142 round-4 fix lane)
- Filed as the write-path sibling of BUG-142. BUG-142's charter scoped the fix to the history/load
  paths (`loadMore`/`loadHistory`/`loadView`/`open` and the leaf loaders `loadChanges`/`loadBranches`/
  `loadStashes`), all of which are now generation-guarded. The write handlers are a distinct family;
  expanding into commit/branch-switch flows in a race-sensitive hot file during BUG-142 round 4 was
  judged out of proportion, so the residual is filed rather than closed. Handoff: the repair candidate
  above is concrete and follows the pattern already in the file.

### 2026-09-29 — agent (fixing, round 1, class=fix)
- **Picked up in the same lane** (coordinator dispatch) so one independent verify covers BUG-142 +
  BUG-203 together. Applied the token-owned invariant to every write path (see Fix section).
- **Corrected the original filing's mechanism.** Built the CDP repro and found `refreshBranch` reads
  the live `project().id`, so there is NO cross-project data clobber — the real defect is the shared
  `branchBusy`/`committing` flag leaking across a project switch (open() not resetting it) and being
  cleared unconditionally by a superseded write. Rewrote Symptom/Why accordingly; the two facets are
  each proven by a partial-revert must-FAIL (C1/C2, see Verification).
- **regressed-from:** none — this defect predates BUG-142; BUG-142's load-path fix left it untouched
  (documented as its round-2 verifier residual). Not introduced by BUG-142.
- **High-stakes note:** session-lifecycle / regression-prone (git write controls in a race-prone hot
  file, round 4+ of this module's races). An independent clean-room verify pass is warranted — run
  `scripts/verify-bug-203-writepath-race.mjs` plus the two BUG-142 harnesses and `verify:git` to
  completion. Left UNSTAGED for the user to commit.
- **Symptom of a deeper design flaw?** yes → covered by BUG-142's ARCH note: every git-view async
  continuation must read the one `superseded` authority and no shared boolean may be cleared by a
  stale continuation. With this change that rule now holds across BOTH the load paths (BUG-142) and
  the write paths (BUG-203) in `git-view.js` — the whole module is converted.

### 2026-09-29 — clean-room verify driver (verifying, class=verify) — INDEPENDENT, VERDICT: BROKEN
- **Verified TOGETHER with BUG-142 round 4** (both fixes uncommitted, sharing
  `public/lib/git-view.js`). Out-of-process clean room via
  `scripts/independent-verify.mjs --working-tree` (wraps `scripts/dispatch.mjs`),
  NOT a Task subagent. The CORRECTED premise was judged: the claim is
  flag-leak-across-a-project-switch (open() not resetting `branchBusy`/
  `committing`; a superseded write clearing the current view's flag), NOT the
  withdrawn cross-project data-clobber. Requirement + attack in
  `/tmp/req-BUG-142-r4.txt` (all four flags across A→B / A→B→A switches and a
  superseded write completing late).
- **This ticket's named fix HOLDS.** `verify-bug-203-writepath-race.mjs` re-ran
  3/3 (run 4c7b28fc9949, exit 0): C1 — A's in-flight `branchBusy` does not leak
  across the nav, B can still switch (`bSwitchPosts:1`); C2 — releasing a
  superseded switch does not re-open B's guard (still one B switch POST). So the
  `branchBusy`/`committing` leak/clear this ticket targeted on the
  switch/checkout/create/commit/sync handlers is closed.
- **Verdict: BROKEN (VALID, manifest-backed).** The clean room broke the broader
  requirement on the ONE write-ish handler neither ticket named — `toggle()`, the
  per-file stage checkbox — plus the `loading` flag `open()` fails to reset:
  - `toggle()` captures no generation token → A's stage POST resolving after the
    switch to B renders A's status into B (B header `alphabranch`, commit button
    "Commit 1 file to alphabranch") — a real cross-project data render leak on the
    stage path (adversarial run 2951291fbc39, exit 1).
  - `toggle()`'s catch runs `fail()`+`loadChanges(true)` under the current
    generation → A's failed stage shows `STALE-A-STAGE-FAILURE` in B and clears
    B's `loading` while B's own changes load is still in flight (run 7399ec91b0c7,
    exit 1).
  - `open()` resets `historyBusy`/`branchBusy`/`committing` but NOT `loading`
    (nor `batching`).
- **FINDING (verbatim from the VALID verdict):** (1) `toggle()` has no token, so
  A's late stage resolve renders A's status into B; (2) `toggle()`'s catch shows
  A's error in B and clears B's `loading` mid-load; (3) `open()` does not reset
  `loading`.
- **Could-not-test:** sync pull/push/publish against a real remote (clean-room
  origin is an empty bare repo — only fetch reachable); A→B→A and same-project
  reopen for the commit/create-branch forms (read, not driven); the
  `toggleAll`/`batching` path (read, not run).
- **Status stays OPEN** (BROKEN). This ticket already owns the WRITE-path
  instances of the class; `toggle()` is the stage-write handler it did not name,
  and `loading` is the flag `open()` still misses — strong candidates to fold in
  here. Next lane: capture the token in `toggle()`, gate its render + flag-clear
  on `!superseded(token)`, reset `loading`/`batching` in `open()`, then re-verify
  the stage-leak case plus this ticket's C1/C2 and BUG-142's busy-flag suite.
  Orchestrator: confirm scope (here vs BUG-142 vs a new sibling) before dispatch.
- **Verified-by:** dispatch anthropic (grey account, same-provider fallback —
  author-provider anthropic, decorrelation reduced) run
  5aa54e8e-995b-44a3-8fc1-6a726dfbf4cc (clean-room, `scripts/independent-verify.mjs`,
  `--working-tree`) — VERDICT: BROKEN.

### 2026-09-29 — agent (fixing, round 2, class=fix)
- **Closed the CLASS, not the two named cases** (coordinator scope call: both land
  here). The clean room found `toggle()` + the `loading` reset; rather than patch
  those two and wait for round 3 to find `selectStash`/`selectCommit`/`projects`/
  `loadGrant`/`gw*`/`fetchNow`, I enumerated EVERY async path in `git-view.js` and
  converted all of them to the generation-token invariant (see Fix r2). `open()`
  now resets every per-project flag and clears `pending`.
- **Structural guard added** so the next missing path can't land silently:
  `scripts/verify-gitview-async-token.mjs` fails if any async function awaits then
  touches state without `superseded(`. It caught 10 uncovered paths on the pre-r2
  tree (the clean room found 2 by hand); 0 on the fixed tree. This is the "by
  construction" net the coordinator asked for.
- **Proof.** Structural scan: PASS post-fix (23/23 guarded), must-FAIL pre-r2 (10
  violations). Behavioural stage-path `verify-bug-203-toggle-race.mjs`: 4/4
  post-fix; must-FAIL pre-r2 on both the status-leak (T1: B showed `alphabranch`)
  and the error-leak (T2: B showed `STALE-A-STAGE-FAILURE`) — the clean room's two
  cases. Anti-regression: writepath-race 3/3, BUG-142 busy-flag 8/8, loadmore-race
  8/8, `verify:git` to completion (71/3 = concurrent-lane crown-chip in app.js,
  not this fix). `npm run gate` PASS; `npm run board:check` OK. Left UNSTAGED.
- **regressed-from:** none — `toggle()` and the `loading` reset predate BUG-142;
  BUG-142's load-path fix and BUG-203 r1's write-path fix each left them untouched
  (documented as the r1 verifier residual). Not introduced by either.
- **High-stakes note:** session-lifecycle / regression-prone (round 2 here, round
  5 of this module's race lineage). Independent clean-room verify warranted before
  VERIFIED — run the structural scan + both behavioural harnesses + the BUG-142
  suites + `verify:git`. The structural scan is cheap and belongs in the clean
  room's run list.
- **Symptom of a deeper design flaw?** yes → the whole module is now converted to
  the one `superseded` authority, and the structural scan enforces it going
  forward. This is the terminal state of the shared-flag/superseded-continuation
  class that BUG-142 + BUG-203 chased across five rounds; the ARCH note on BUG-142
  covers it.

### 2026-09-29 — clean-room verify driver (verifying, round 2, class=verify) — INDEPENDENT, VERDICT: BROKEN
- **Verified TOGETHER with BUG-142 round 4** (both fixes uncommitted, sharing
  `public/lib/git-view.js`). Out-of-process clean room via
  `scripts/independent-verify.mjs --working-tree` (wraps `scripts/dispatch.mjs`),
  NOT a Task subagent. Requirement + attack in `/tmp/req-BUG-203-r2.txt`: probe
  the round-2 CLASS fix and the structural guard on paths the earlier rounds did
  NOT exercise — can the scan be fooled (guard after the state touch, then-chain
  vs await, helper indirection)? per-path A→B races for the newly-guarded
  `selectFile`/`selectCommit`/`gwAllow`/`gwRevoke`/`fetchNow`; does `open()`
  clearing `pending`/`liveConfirmed` lose legitimate state on a same-project
  re-open? Round-1 (`toggle()`, `loading`) cases were excluded, not re-run.
- **Named write-path fix (r1) still HOLDS** — the toggle-race harness re-ran
  clean (run 06034c0dbd7f, exit 0). The BROKEN verdict is NOT a regression of
  the r1 branch/commit/sync flags; it is the r2 class-completeness claim.
- **Verdict: BROKEN (VALID, manifest-backed).** The clean room broke two of the
  r2 claims on paths the harnesses never drive:
  - **`open()` is itself an unguarded async path.** After `await loadView(token)`
    (`git-view.js:127`) it runs `void projects(token)` with NO `superseded(token)`
    check; `projects()` (line 110) calls `projectSelect.replaceChildren(...)`
    BEFORE its first await/guard. So a superseded project-A open, released after
    the nav to B, rewrites B's project dropdown — observed **B's dropdown 2
    options → 1** ("A's superseded open() continuation must NOT rewrite B's
    dropdown" FAILed), leaving B unable to switch project (adversarial run
    91ede6fe6f0e, exit 1). A real cross-project render leak the class fix missed.
  - **The structural scan (`verify-gitview-async-token.mjs`) is FOOLED 5/5.**
    It only checks that `superseded(` appears somewhere on the SAME LINE as an
    async-with-await function — so it PASSes: a guard placed AFTER the state
    write, a vacuous `superseded(token)&&false`, a non-async `.then()` chain that
    writes `data`, a helper called from `.then()` that writes unguarded, and a
    second unguarded async fn on a line already carrying a guard (adversarial run
    dffc50a0f286, exit 1). Claim (c) — "a missing path can't land silently" — is
    false; the scan also misses writes made before the first await in a function
    (like `projects()`) called after its caller's await, which is exactly the
    real defect above.
- **FINDING (verbatim from the VALID verdict):** (1) `git-view.js:127` `open()`
  has no `superseded` check after `await loadView(token)`, so a superseded A open
  runs `void projects(token)` and `projects()`'s `replaceChildren` wipes B's
  dropdown (2→1); (2) the scan only requires `superseded(` on the async fn's line
  and passes a guard-after-write, a vacuous guard, a then-chain, a helper
  indirection, and a second unguarded async fn on a guarded line; (3) the scan
  misses pre-first-await writes in a callee invoked after the caller's await, so
  claim (c) is false for the shipped file.
- **Could-not-test (from the verdict):** `selectFile`/`selectCommit`/`gwAllow`/
  `gwRevoke`/`fetchNow` A→B holds were READ (each checks `superseded()` before its
  first post-await write) but not driven in a browser — the browser budget went to
  the `open()` continuation; the same-project re-open effect of clearing `pending`
  / `liveConfirmed` was READ (nothing reads `pending`; `loadBranches` already sets
  `liveConfirmed=false` on every load, so the reset looks harmless) not driven;
  `verify:git` and the writepath/busy-flag/loadmore harnesses were not re-run this
  round; sync push/pull/publish against a real remote (scratch repos have no origin).
- **Status stays OPEN** (BROKEN). Next lane: guard `open()`'s own post-await
  continuation (gate the `void projects(token)` on `!superseded(token)`, or move
  the render guard into `projects()` before `replaceChildren`), and HARDEN the
  structural scan so presence-on-a-line no longer satisfies it — check the guard
  precedes the first state touch, follow callees/then-chains, and reject vacuous
  guards; then re-verify the projects-dropdown case plus this ticket's C1/C2,
  the toggle-race suite and BUG-142's busy-flag suite. Orchestrator: confirm scope
  (here vs a new sibling for the scan hardening) before dispatch.
- **HIGH-STAKES / independent-skeptic note:** the scan is a by-construction guard
  now proven vacuous (5/5 fooled) — a second clean-room hardening-verify pass is
  warranted once the scan is rewritten, since a scan that passes crafted bypasses
  is worse than none.
- **Verified-by:** dispatch anthropic (grey account, same-provider fallback —
  author-provider anthropic, decorrelation reduced) run
  e0afcc07-b666-4e7d-8d1e-d834bb2ad649 (clean-room, `scripts/independent-verify.mjs`,
  `--working-tree`) — VERDICT: BROKEN.

### 2026-09-30 — agent (fixing, round 3, class=fix)
- **Stopped patching and REDESIGNED** (coordinator's call). Both round-2 breaks
  share one root: the invariant depended on each function remembering a check.
  r3 removes that dependency. A single `guard(token, promise)` is the only async
  boundary: it resolves to the value only while the token is current and
  otherwise never settles (forwarding a rejection only while current). Every
  git-view async op is now `await guard(token, <api-call>)`; internal loaders are
  FIRED, not awaited, so the ONLY await in the module is of guard(). Reaching the
  code after `await guard(...)` is itself the proof the token is current — nothing
  to forget. `open()` no longer awaits (every load/project/stash/fetch is fired),
  so it can't suspend then run a superseded continuation — the projects()
  dropdown-wipe (break a) is structurally gone; projects() also only APPENDS
  behind guard now.
- **Scan rewritten from a line regex to a parsed lexer.** No AST parser is
  installed (typescript v7-native exposes no JS API; no acorn/@babel-parser/
  rollup — checked, and a dependency was intentionally not added). The new
  `verify-gitview-async-token.mjs` is a comment/string/template/regex-aware lexer
  over the whole file enforcing: every `await` operand is `guard(<identifier>,…)`
  and no `.then`/`.catch`/`.finally` outside guard. The clean room's 5 fooling
  patterns are must-FAIL fixtures and all 5 are now rejected; a correctly-guarded
  snippet is accepted (no false positive).
- **Proof.** Scan: 9/9 (real file 0 violations across 23 guarded awaits; 5
  fixtures rejected; must-FAIL on the pre-r3 tree). Behavioural open-continuation
  `verify-bug-203-open-continuation.mjs`: 3/3 post-fix, must-FAIL pre-r3 (held A
  open() resumes and wipes B's dropdown 2→1 options). Anti-regression: writepath
  3/3, toggle 4/4, BUG-142 busy-flag 8/8, loadmore 8/8, `verify:git` to completion
  (71/3 = concurrent-lane crown-chip in app.js, not this fix). `npm run gate` PASS
  (leak-gate + typecheck); `npm run board:check` OK. Left UNSTAGED.
- **regressed-from:** BUG-203 r2 (this lane) for the open()-continuation and the
  fooled scan — the r2 self-verified scan was not sound, which is exactly why an
  independent clean-room pass is mandated for this class.
- **High-stakes note:** session-lifecycle / regression-prone, and this is a
  structural redesign of a hot file. Independent clean-room verify strongly
  warranted before VERIFIED — run the scan (cheap, belongs in the run list) + the
  three BUG-203 behavioural harnesses + both BUG-142 harnesses + `verify:git`, and
  ATTACK the scan lexer itself (nested templates, regex-division ambiguity, a
  guard defined across lines) since a scan that passes a crafted bypass is worse
  than none.
- **Symptom of a deeper design flaw?** resolved structurally — the module now has
  a single async boundary and a parsed guard that makes the class unrepresentable,
  not merely absent. The ARCH note on BUG-142 covers the lineage.

### 2026-09-30 — clean-room verify driver (verifying, round 3, class=verify) — INDEPENDENT, VERDICT: BROKEN
- **Verified TOGETHER with BUG-142** (BUG-203 r3 is uncommitted; both share
  `public/lib/git-view.js`). Out-of-process clean room via
  `scripts/independent-verify.mjs --working-tree` (wraps `scripts/dispatch.mjs`),
  NOT a Task subagent. Requirement (`/tmp/req-BUG-203-r3.txt`) framed as
  confirming the r3 redesign is correct on three concerns: (1) the rewritten
  parsed lexer scan classifies guarded vs unguarded boundaries correctly even
  under nested templates / regex-vs-division / comments / aliased-promise
  `.then`; (2) `guard`'s never-settling promises do not accumulate held closures
  unbounded across many project switches; (3) `open()` firing loaders WITHOUT
  awaiting does not swallow errors or leak unhandled rejections.
- **Behavioural fixer tests HOLD.** The lexer scan re-ran 9/9 against its own
  shipped fixtures (`verify-gitview-async-token.mjs`, run f67d51a3cfcc, exit 0);
  concern (3) HOLDS — the real module loaded under happy-dom surfaced 4/4 fired
  current-loader errors into the view text with 0 unhandled rejections (run
  122b0680a3f7, exit 0). So the redesign's cross-project render/flag behaviour on
  the paths the harnesses drive was not re-broken.
- **Verdict: BROKEN (VALID, manifest-backed).** Two of the three r3 correctness
  claims broke on cases the shipped fixtures never exercise:
  - **The rewritten parsed lexer is FOOLED 7/7 on forms the 5 shipped fixtures
    don't cover** (`adv/lexer-fool.mjs`, run c97085c555ad, exit 1;
    falsePositives=0): a postfix `x++ / 2` / `n-- / 2` divide is misread as a
    regex start (`+`/`-` are in `REGEX_PREV`), blanking a real unguarded `await`
    — including inside a nested template; `p. then(` / `p.\nthen(` /
    `p['then'](` slip past the `\.(then|catch|finally)\s*\(` rule so an unguarded
    then-chain on an aliased promise is accepted; a stray `api.x().then(...)` on
    the SAME line as the `const guard` helper is accepted (whole-line exemption);
    and `await guard(generation, …)` is accepted though it is VACUOUS — Rule 1
    takes any identifier as the token and `superseded()` compares against the
    live `generation` at resolve time, so it always reads current. The r2 verdict
    fooled the old line-regex 5/5; the rewritten parsed lexer is still fooled.
  - **Retention is UNBOUNDED across project switches** (`adv/never-retention.mjs`,
    run bffac52adb7c, exit 1; corroborated by heap-growth `adv/retention-rejection.mjs`
    run 2be70ef97ffe, exit 1, ~6KB/switch). `guard` returns a single
    module-lifetime `NEVER = new Promise(() => {})`; every superseded op does
    `promise.then(… ? NEVER : v …)`, adopting NEVER and adding a reaction to its
    reaction list that is never released — so the whole async frame of every
    superseded op stays alive for the life of the page. A FinalizationRegistry
    probe over 500 superseded A→B ops collected 0/500 scopes with the shared
    NEVER vs 500/500 in a control that makes a fresh never-settling promise per
    call. Memory grows with every project switch that has a request in flight.
- **FINDING (verbatim from the VALID verdict):** (1) `git-view.js:98-99` — the
  shared module-lifetime NEVER retains every superseded continuation's async
  frame unbounded (500/500 retained; 0 with a per-call never-promise), so memory
  grows per in-flight project switch; (2) scan `clean()` — `x++ / 2`/`n-- / 2`
  divide misread as regex-start, blanking a real unguarded `await` (incl. nested
  template); (3) scan Rule 2 — `p. then(` / `p.\nthen(` / `p['then'](` accepted
  (unguarded aliased then-chain); (4) scan `inGuard` — a stray `.then(...)` on the
  `const guard` line is accepted (whole-line exemption); (5) scan Rule 1 —
  `guard(generation, …)` accepted though vacuous (token is the live generation).
- **Could-not-test (from the verdict):** retention inside a real Brave/V8 page
  heap (measured in Node V8 with a FinalizationRegistry, not the panel's page
  lifetime); the Brave/CDP end-to-end scripts (open-continuation, toggle-race,
  writepath-race, bug-142 busy-flag) — need a live server + headless browser, not
  run in the room, so the cross-project flag/render behaviour is unverified here;
  a reject with a non-Error value in a catch body.
- **Status stays OPEN** (BROKEN). The r3 redesign fixed the r2 open()-continuation
  break but introduced/left two new defects: (a) the guard's shared-NEVER design
  leaks memory per superseded switch — a correctness-adjacent resource leak, the
  fix candidate is a per-call never-settling promise (or drop the reaction rather
  than adopt a permanent one); (b) the rewritten scan — the very "make forgetting
  impossible" net — is again vacuous on 7 real surface forms and does not reject
  a vacuous live-generation token. Next lane: fix guard's retention; harden the
  lexer (postfix ++/-- before `/`; whitespace/newline/computed `.then`;
  per-token same-line exemption not whole-line; reject a token that is the live
  `generation` identifier), then re-verify with the CDP harnesses in a live
  browser. Orchestrator: confirm scope before dispatch.
- **HIGH-STAKES / independent-skeptic note:** this is the SECOND round the
  by-construction scan has been proven vacuous (r2 line-regex 5/5, r3 parsed
  lexer 7/7). A scan that passes crafted bypasses is worse than none; a further
  hardening-verify pass is warranted once the scan is rewritten. Behavioural CDP
  coverage in the room was NOT obtained (no live browser) — an independent pass
  that actually drives the browser harnesses is still outstanding for the
  cross-project flag/render claims.
- **Verified-by:** dispatch anthropic (second anthropic account, distinct from the fixer's — same-provider fallback;
  grey at cap, openai parked — author-provider anthropic, decorrelation reduced)
  run 51f611bc-cc24-44b4-b403-073c3b72514d (clean-room,
  `scripts/independent-verify.mjs`, `--working-tree`) — VERDICT: BROKEN.

### 2026-09-30 — agent (fixing, round 4, class=fix)
- **(a) Retention.** `guard` no longer adopts a shared module-lifetime `NEVER`;
  each superseded resolution returns its OWN `new Promise(()=>{})`. A shared NEVER
  is a GC root whose reaction list pins every superseded op's frame; a per-call
  never-promise is referenced only by the frame awaiting it (unrooted cycle) and
  is collected. Proof: `scripts/verify-gitview-guard-retention.mjs` extracts the
  SHIPPED guard, runs 500 superseded ops, counts frames GC-reclaimed via a
  FinalizationRegistry (`node --expose-gc`). r4: 500/500 reclaimed → PASS; must-FAIL
  on the r3 tree (`GV_FILE=/tmp/gv-b203-r3.js`): 0/500 → FAIL. Semantics unchanged
  (superseded ⇒ never settles ⇒ no code-after-await, no catch runs).
- **(b) Scan fails closed, not chased.** Per the coordinator: the 7 forms are
  contrived and this is a lint over one file we control, so instead of parsing
  every construct the scan now REFUSES what it can't classify. It forbids `++`/`--`
  outright (postfix-then-`/` is what made the regex/divide split ambiguous) — the
  real file was simplified (`a++`→`a;a+=1`, `++request`→`request+=1;…`,
  `++generation`→`generation+=1;…`, etc.), matches `.then`/`.catch`/`.finally`
  across whitespace/newline and computed `['then']`, exempts only the guard's own
  `.then` (not its whole line), and rejects `guard(generation,…)` as vacuous. All
  7 clean-room forms + the earlier 5 are must-FAIL fixtures; the real file passes
  with 0 violations; a correctly-guarded snippet is accepted (no false positive).
- **Residual (documented, not chased):** the scan is a lexer, not a full parser.
  Computed-access detection matches only string-literal keys (`['then']`), not a
  dynamically-built key (`p['th'+'en']`); and the divide/regex heuristic is only
  guaranteed sound because `++`/`--` are now banned. This is acceptable for a
  single-file lint we own — a crafted dynamic bypass is not a real occurrence
  here, and if one is ever needed the fix is to simplify the file, not weaken the
  scan. It is NOT a security boundary.
- **Live-browser coverage:** the retention measure is a Node/V8 FinalizationRegistry
  probe, NOT the panel's real page heap; and the r3/r4 clean rooms did not drive
  the CDP behavioural harnesses in a live browser (no browser in the room). The
  cross-project flag/render/dropdown behaviour is covered by the six CDP harnesses
  when run locally (all green here) but remains unverified inside an independent
  clean room. Flag for the independent pass.
- **Proof (local).** Scan 15/15 (real file clean; 11 fooling fixtures rejected;
  no false positive). Retention 500/500 reclaimed (must-FAIL 0/500 on r3).
  Behavioural: writepath 3/3, toggle 4/4, open-continuation 3/3, BUG-142 busy-flag
  8/8, loadmore 8/8. `npm run verify:git` to completion (71/3 = concurrent-lane
  crown-chip in app.js, not this fix). `npm run gate`: my files are leak-clean and
  typecheck passes; the gate's single leak hit is `docs/bugs/BUG-217-*.md` (a
  bare-word username token), a DIFFERENT lane's untracked ticket — not this
  change. Left UNSTAGED.
- **regressed-from:** BUG-203 r3 (this lane) — the shared-NEVER retention and the
  fooled lexer were both introduced by r3's redesign.
- **High-stakes note:** independent clean-room verify still warranted (this is the
  3rd scan iteration and a resource-leak fix); it should attack the fail-closed
  scan and, ideally, drive the CDP harnesses in a real browser.

### 2026-09-30 — clean-room verify driver (verifying, round 4, class=verify) — INDEPENDENT, VERDICT: BROKEN
- **Verified TOGETHER with BUG-142** (BUG-203 r4 is uncommitted; both share
  `public/lib/git-view.js`). Out-of-process clean room via
  `scripts/independent-verify.mjs --working-tree` (wraps `scripts/dispatch.mjs`),
  NOT a Task subagent. Requirement (`/tmp/req-BUG-203-r4.txt`) framed as
  confirming the r4 fixes on three claims: (1) the retention fix reclaims held
  superseded closures; (2) the fail-closed scan
  (`verify-gitview-async-token.mjs`) rejects an unguarded async boundary; (3) no
  busy flag leaks across a project switch.
- **Two of three claims HOLD.** Retention: the fixer's
  `verify-gitview-guard-retention.mjs` re-ran 500/500 reclaimed (run
  76e993c56492); an adversarial 200 A->B->A bursts with 3-4 concurrent in-flight
  ops each, mixing rejections and Promise.all all settled late, reclaimed 800/800
  frames with 0 stale continuations run (run b451b7ea0681, exit 0). Busy-flag
  leak: all 28 writes of `false` to `branchBusy`/`committing`/`loading`/
  `historyBusy`/`syncing`/`batching`/`gwBusy` outside `open()` sit AFTER an
  `await guard(` in the same function → 0 unguarded (run 0a82c5db34fb, exit 0).
  The scan's own fixer test re-ran 15/15 (run 983890eee7bc, exit 0). So r3's two
  named breaks — the shared-NEVER retention leak and the flag-leak class — are
  closed by r4.
- **Verdict: BROKEN (VALID, manifest-backed).** The fail-closed scan is FOOLED
  again on a form the 11 fixtures do not cover, and it is NOT the documented
  computed-key limitation: a `/` after a keyword (`return`) or after `)` is
  misread as DIVISION, because `REGEX_PREV` lacks keywords and `)`. So a regex
  literal there — `function q(s){ return /'/.test(s) }` — starts a fake string
  that blanks the code after it, and a following genuinely-unguarded
  `async function f(){ const v = await api.gitChanges(id); data = v; }` (or
  `api.gitChanges(id).then(v=>{data=v})`) then scans with ZERO violations. 3
  genuinely-unguarded boundaries accepted (adversarial run 7c72559d0441, exit 1;
  falsePositives=0). This is the THIRD consecutive round the by-construction scan
  is proven vacuous (r2 line-regex 5/5, r3 lexer 7/7, r4 fail-closed 3/3 on
  regex-after-keyword) — the "make forgetting impossible" net still passes a
  crafted bypass.
- **FINDING (verbatim from the VALID verdict):** the lint scan wrongly accepts
  real unguarded async boundaries. In `clean()` at
  `scripts/verify-gitview-async-token.mjs`, a `/` after a keyword (`return`) or
  after `)` counts as division, because `REGEX_PREV` lacks keywords and `)`. So
  in `function q(s){ return /'/.test(s) }` the quote inside the regex starts a
  fake string that blanks the code after it. A following
  `async function f(){ const v = await api.gitChanges(id); data = v; }` or
  `api.gitChanges(id).then(v=>{data=v})` then gets zero violations (run
  7c72559d0441, all 3 cases accepted). This bypass does not rely on a computed
  key. It is not fail-closed like the `++`/`--` rule.
- **Could-not-test (from the verdict):** none of the four browser-driven fixer
  tests could run (open-continuation, toggle-race, writepath-race,
  bug-142-busy-flag) — each stops at `git init` because the clean-room sandbox
  blocks git writes. So claim 3 (the busy-flag/render leak) was checked ONLY
  STATICALLY (every `false` flag write follows an `await guard(` in its
  function), NOT by a live DOM race in a browser; old-view data/error/status
  rendering into the new view was not observed at runtime. `npm run verify:git`
  was not run (needs the same git-writing scratch repos). Retention was measured
  in Node V8 via FinalizationRegistry, not the panel's live page heap.
- **Status stays OPEN** (BROKEN). The r4 retention fix and the busy-flag-leak
  invariant both HOLD; the residual is the scan itself — still not fail-closed
  against a regex literal after a keyword or `)`. Next lane: add keywords
  (`return`/`typeof`/`case`/…) and `)` to `REGEX_PREV`, OR (simpler, matching the
  fail-closed philosophy) forbid bare regex literals in this file / require them
  parenthesised, and add the 3 regex-after-keyword forms as must-FAIL fixtures.
  Orchestrator: confirm scope before dispatch.
- **HIGH-STAKES / independent-skeptic note:** THIRD consecutive round the
  by-construction scan is vacuous — a scan that passes crafted bypasses is worse
  than none. Separately, the behavioural cross-project flag/render claims have
  NEVER been driven in an independent clean room across all four rounds, because
  the clean-room sandbox blocks the `git init` the CDP harnesses need. An
  independent pass on a git-write-capable sandbox (or a non-git behavioural
  harness) remains outstanding for the cross-project claims.
- **Verified-by:** dispatch anthropic (a second anthropic account (distinct from the fixer's) — same-provider
  fallback, distinct from the fixer's account; grey near cap, openai parked —
  author-provider anthropic, decorrelation reduced) run
  997b8ca5-5609-48f5-8e5f-1d0d853fce28 (clean-room, `scripts/independent-verify.mjs`,
  `--working-tree`) — VERDICT: BROKEN.

### 2026-09-30 — agent (fixing, round 5, class=fix)
- **Product fixes confirmed holding** by the round-4 clean room (retention 800/800
  reclaimed; busy-flag invariant 28/28 behind `await guard(`). This round touched
  ONLY the structural scan, which the room fooled again: a regex literal after
  `return` or `)` was misread as division, blanking a following unguarded await.
- **Closed the divide-vs-regex class for good.** Rather than teach the lexer to
  disambiguate `/` (undecidable without a full parser — the thing that keeps
  getting fooled), the scan now FAILS CLOSED on `/`: after comments/strings/
  templates are blanked, ANY surviving `/` is a violation. To let the real file
  pass, every division and regex literal moved OUT of git-view.js into a new
  `public/lib/git-view-fmt.js` (pure formatting/parsing helpers — `ago`,
  `isDiffMeta`, `hunkMatch`, `durationLeftLabel`), which the scan does not read.
  git-view.js now contains no bare `/` in code; the cleaner's regex-detection
  heuristic (the fooled part) was deleted entirely.
- **Proof.** Scan 18/18: real file 0 violations (23 guarded awaits); the round-4
  clean room's 3 boundaries (regex-after-`return`, regex-after-`)`, division-
  after-`)`) are must-FAIL fixtures and each is now rejected (the previously-
  blanked await also reappears as `await-not-guard`), alongside the earlier 11;
  a correctly-guarded snippet is accepted (no false positive). Anti-regression:
  the `ago`/`renderDiff`/`gwLabel` extraction is exercised green by
  `verify:git` ("renders commit files/diff" PASS), and all six CDP harnesses stay
  green (busy-flag 8/8, loadmore 8/8, writepath 3/3, toggle 4/4, open-continuation
  3/3) + retention 500/500. `npm run gate` PASS; `npm run board:check` OK.
- **Unverified (recorded per coordinator):** the behavioural CDP harnesses have
  NEVER run inside an independent clean room — its sandbox blocks `git init`, so
  the cross-project flag/render/dropdown behaviour is proven only by the fixer's
  local browser runs, not independently. This is the outstanding gap for VERIFIED.
- **Residual (scan):** it remains a lexer, not a parser. It is now maximally
  conservative (fails closed on `/`, `++`/`--`, whitespace/computed `.then`, and
  a live-`generation` token); the cost is that any future division/regex in
  git-view.js must live in `git-view-fmt.js`. This is a deliberate, documented
  trade for a single-file lint we own — not a security boundary.
- **Files:** `public/lib/git-view.js` (extraction + no bare `/`), new
  `public/lib/git-view-fmt.js`, `scripts/verify-gitview-async-token.mjs`
  (fail-closed `/` rule + 3 boundary fixtures). Left UNSTAGED.

### 2026-09-30 — clean-room verify driver (verifying, round 5, class=verify) — OPTION-B IN-REPO, VERDICT: BROKEN (product HOLDS; scan residual)
- **Why option-b, not a clean room.** All four prior rounds could NEVER drive the
  behavioural CDP harnesses independently: the clean-room sandbox blocks the
  `git init` those harnesses need. r5 runs the verify as a SEPARATE-PROCESS
  dispatch against the LIVE checkout on FREE ports, repo treated READ-ONLY (writes
  only to /tmp; no tracked file modified; port 4317 untouched). This is REDUCED
  ISOLATION — the verifier could see the board — recorded here honestly. It is the
  FIRST time the six harnesses ran under an independent process.
- **Dispatch (tilde form; grey account via CLAUDE_CONFIG_DIR, personal weekly PARKED):**
  `cat /tmp/verifier-prompt-BUG-203-r5.txt | node scripts/dispatch.mjs --provider anthropic --cwd ~/projects/orchard --sandbox workspace-write --allow-tools "Bash Read Grep Glob" --timeout-min 25 --meta-out /tmp/meta-BUG-203-r5.json --ticket BUG-203 --phase verifying --round 5 --class verify --prompt-stdin`
  The verifier was handed the requirement, the raw diffs (git-view.js diff +
  git-view-fmt.js + the scan), and the run-list — NOT the fixer's prose.
- **PRODUCT FIX HOLDS — driven independently in a browser (per-harness):**
  - `verify-bug-142-busy-flag.mjs` 8/8 (exit 0)
  - `verify-bug-142-loadmore-race.mjs` 8/8 (exit 0)
  - `verify-bug-203-writepath-race.mjs` 3/3 (exit 0)
  - `verify-bug-203-toggle-race.mjs` 4/4 (exit 0)
  - `verify-bug-203-open-continuation.mjs` 3/3 (exit 0)
  - `verify-gitview-guard-retention.mjs` (`--expose-gc`) 500/500 frames reclaimed (exit 0)
  - `verify-gitview-async-token.mjs` (the scan) 18/18 on the real file, `awaitCount=23` (exit 0)
  - `npm run verify:git` 71/74 (exit 1) — the 3 failures are all crown-chip /
    status-line checks (rendered by `public/app.js`/`drawer.js`, both modified by
    concurrent lanes), NOT git-view; every git-view/history/stage/commit/branch/
    stash/diff check PASSED. Same crown-chip 71/3 the prior four rounds recorded.
  So the flag-leak-across-a-project-switch invariant and the retention reclaim —
  this ticket's actual PRODUCT claims — are confirmed by an independent process
  that actually drove the DOM races, closing the "behavioural claims never verified
  independently" gap that stood open through r1–r4.
- **Verdict: BROKEN (VALID) — the fail-closed scan is fooled a FOURTH round.** The
  probe (requirement 3: can a guarded-boundary violation hide via template `${}`,
  a regex-in-string, or the git-view-fmt import) found FIVE accepting constructs,
  each injected into a copy of the real git-view.js under /tmp and run via `GV_FILE=`:
  - **FINDING 1 (comment terminator):** `clean()` ends a `//` comment only at `\n`;
    JS also ends it at U+2028, U+2029 and a lone `\r`. An unguarded
    `await api.gitStatus(projectId)` after such a terminator is ACCEPTED (0
    violations); executed with a mid-flight project switch → `data=A-STALE`.
  - **FINDING 2 (identifier escape):** `api.gitStatus(projectId).then(…)` —
    a valid property-name escape Rule 2's regex never sees — ACCEPTED; stale write lands.
  - **FINDING 3 (destructured/computed `.then`):** `{then}=p; then.call(p,…)`,
    `p['th'+'en'](…)`, `Reflect.get(p,'then').call(p,…)` all ACCEPTED; executed
    (destructured) → stale write lands.
  - **FINDING 4 (shadowed guard):** `async function leak(t,guard=(a,b)=>b){ await guard(t,api.gitStatus(projectId)); … }`
    ACCEPTED — Rule 1 checks the callee NAME, not its binding; stale write lands.
  - **FINDING 5 (the git-view-fmt hole — the exact probe asked for):** async logic
    moved into `public/lib/git-view-fmt.js` (which nothing in scripts/ or
    package.json scans) with the continuation passed back as a callback
    (`ago.fetchInto(api,projectId,r=>{data=…})`) is ACCEPTED. The helper's
    "pure/synchronous" header is unenforced; the scan has no callback rule and no
    second-file rule. (Not executed — the point is the scan cannot see it.)
  Rejected in the probe: plain unguarded await, raw `.then`, `for await`, `?.then`,
  string variants (`'/*'`, escaped quotes), all template-`${}` await/`/`/`.then`
  variants, `./*x*/then`. So the template-`${}` and regex-in-string vectors HELD;
  the comment-terminator, identifier-escape, dynamic-`.then`, shadowed-guard and
  unscanned-helper vectors did NOT.
- **Interpretation.** This is the FOURTH consecutive round the by-construction scan
  is proven foolable (r2 line-regex 5/5, r3 lexer 7/7, r4 fail-closed-on-`/` 3/3,
  r5 5 new forms). The PRODUCT is sound and now independently confirmed; the scan
  is a best-effort single-file lint that a full parser would be needed to make
  sound. Per the r4/r5 fixer notes it is explicitly NOT a security boundary.
- **Could-not-test (from the verdict):** same-project sub-view switch (Changes→
  History→Changes) during an in-flight write — `open()` resets `branchBusy`/
  `committing` every call, which by reading could re-enable a control mid-POST;
  no harness covers it. Retention in a real Brave heap (measured in Node V8, not
  the panel's page). Races for `gwBusy`/`syncing`/`committing`/`batching` (code
  read, not driven). Cause of the 3 crown-chip failures (attributed by code
  location, not bisected, under the read-only constraint). FINDING 5 at runtime
  (would need a modified git-view-fmt.js loaded in a browser).
- **Status stays OPEN.** The product fix HOLDS and is now independently
  behaviourally verified; the residual is scan soundness only. ORCHESTRATOR
  DECISION required: (A) accept the scan as a documented best-effort lint and mark
  VERIFIED on the confirmed product, or (B) commission a further scan-hardening
  round (comment terminators U+2028/U+2029/CR; identifier-escape + dynamic/
  destructured `.then`; bind-not-name guard check; a second-file/callback rule or
  fold git-view-fmt.js back under the scan). Recommendation: (A) — four rounds show
  scan soundness is not reachable without a real parser, the shipped file is clean,
  and the runtime claim is the one that matters and now holds.
- **Verified-by:** dispatch anthropic (grey account, personal weekly PARKED —
  same-provider, decorrelation reduced) run
  625ee528-94e5-49d9-bafe-c4d858440a45 (option-b in-repo, reduced isolation —
  verifier could see the board; live checkout, free ports, repo read-only) —
  VERDICT: BROKEN (product HOLDS; scan residual only).

### 2026-09-30 — orchestrator decision (verifying, round 5, class=trivial) — DECISION A: VERIFIED on the confirmed product; scan claim WITHDRAWN
- **Decision (A), recorded.** The PRODUCT fix is independently confirmed by run
  625ee528, which for the FIRST time drove all six behavioural harnesses in a real
  browser under an independent process: busy-flag 8/8, loadmore 8/8, writepath 3/3,
  toggle 4/4, open-continuation 3/3, retention 500/500 reclaimed. The
  flag-leak-across-a-project-switch invariant and the retention reclaim — this
  ticket's actual product claims — hold.
- **The scan is no longer a soundness claim — RETRACTED.**
  `scripts/verify-gitview-async-token.mjs` is a best-effort single-file LINT, not a
  guarantee. Round 4 of the attacks showed a lexer cannot be made sound without a
  real parser, and further hardening has stopped buying anything (WA §N stopping
  rule). Its header comment is updated to say so plainly (no logic changed).
- **Verification was OPTION-B in-repo — recorded honestly.** Reduced isolation
  (same-provider anthropic; the verifier could see the board), a separate-process
  DISPATCH (not a Task subagent) against the LIVE checkout on free ports, repo
  read-only, port 4317 untouched. Chosen because the clean-room sandbox blocks the
  `git init` the CDP harnesses need — the reason r1–r4 could never drive them
  independently.
- **Scan residual (the withdrawn claim's known holes), none present in the shipped
  git-view.js:** (1) `//` comment terminated by U+2028/U+2029/lone-CR; (2)
  identifier-escape `.then(`; (3) destructured/computed `.then`
  (`{then}=p`, `p['th'+'en']`, `Reflect.get`); (4) a shadowed `guard` parameter
  (Rule 1 checks the callee name, not its binding); (5) async logic moved into the
  UNSCANNED `public/lib/git-view-fmt.js` with a callback. The shipped file contains
  none of these, so runtime is unaffected.
- **What remains unverified:** `npm run verify:git`'s 3 failures are the
  crown-chip / status-line checks rendered by `public/app.js` / `public/drawer.js`
  (both edited by concurrent lanes), NOT git-view — they belong to those lanes, not
  this ticket. FINDING 5 at runtime (would need a modified git-view-fmt.js loaded in
  a browser) and the same-project sub-view-switch race remain code-read only, as the
  r5 could-not-test list records.
- **Status → VERIFIED** on the confirmed product; the withdrawn scan claim is not a
  blocker. An independent clean-room re-verify remains warranted if the git-init
  sandbox constraint is ever lifted (session-lifecycle / regression-prone module).
- **Verified-by:** dispatch anthropic run 625ee528-94e5-49d9-bafe-c4d858440a45
  (option-b in-repo, reduced isolation — same-provider anthropic, grey account /
  personal weekly PARKED, verifier could see the board; live checkout, free ports,
  repo read-only) — executed PASS on all six behavioural harnesses; scan claim
  withdrawn.
