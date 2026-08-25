```orchard-ticket
{
  "id": "FEAT-099",
  "type": "feature",
  "title": "Everyday git work still means leaving Orchard",
  "summary": "Orchard already shows a project's branch and how many files are changed, and can commit everything, push, pull and create a GitHub repo. Choosing which files go into a commit, reading a diff, switching branches and reading history all still mean leaving for another tool, and on Linux there is no client of comparable quality to leave for.",
  "impact_if_we_wait": "Nothing breaks and nothing shipped regresses. The cost of waiting is only that the reasoning goes cold, which is why it is recorded here rather than built. The user marked it optional and future, so this is a parked idea, not queued work.",
  "current_need": "Nothing outstanding. An independent clean-room verify pass is warranted before this is called closed.",
  "severity": "low",
  "area": "In-app git surface",
  "reported": "2026-08-21",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "in_progress",
  "human_action": "none",
  "updated": "2026-08-22",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A person can choose individual changed files and commit only those",
    "A changed file's diff is readable without leaving the app",
    "Branches can be listed, switched and created without a terminal",
    "Recent commit history for the project is visible in the app",
    "Every new action follows Orchard's own design language rather than imitating another client's chrome"
  ],
  "code_refs": [
    {
      "path": "src/server/git.ts",
      "symbol": "statusOf",
      "note": "what already exists: repo, branch, detachedAt, dirty count, ahead/behind, upstream, remoteUrl, lastCommit — driven by fixed-argv git CLI calls, no npm git library and no third-party GitHub MCP server, deliberately"
    },
    {
      "path": "src/server/git.ts",
      "symbol": "commit",
      "note": "commit is all-or-nothing today; the client labels it 'git add -A && git commit'. Per-file staging is the single biggest gap against the GitHub Desktop main screen"
    },
    {
      "path": "public/lib/drawer.js",
      "symbol": "Git group",
      "note": "the existing surface lives in the settings drawer under data-focus=git; the crown chip in public/app.js deep-links to it"
    },
    {
      "path": "scripts/verify-git.mjs",
      "symbol": null,
      "note": "existing suite drives real repos and a local bare remote; extend rather than replace"
    }
  ],
  "related": [
    {
      "id": "FEAT-046",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "plan+review",
  "body_slots": {
    "Diagnosis": false,
    "Evidence": true,
    "Implementation notes": true,
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

# FEAT-099 — Everyday git work still means leaving Orchard

## Evidence

The user's words, verbatim, marked optional and future:

> "github desktop on windows main page has almost all functions which means we can recreate it internally as same ui our design for features since linux doesnt have [as] good"

Their point is not that Orchard is missing git. It is that GitHub Desktop's *main screen* — one screen — covers nearly everything they actually do with a repo, and that Linux has no equivalent of comparable quality. So the choice is between switching to a weaker tool and growing the surface Orchard already has, in Orchard's own design language.

**What exists today** (read at HEAD, not assumed). The settings drawer has a Git group, deep-linked from the crown chip in the session header:

- a status line — branch or detached head, dirty file count, ahead/behind, upstream, remote, last commit subject;
- `init` for a project that is not yet a repository;
- commit, explicitly labelled `git add -A && git commit`, disabled on a clean tree;
- push, with `-u origin <branch>` when there is no upstream, behind an arm/confirm step;
- pull, fast-forward only, offered only when an upstream exists;
- create a private GitHub repository via `gh repo create`;
- open a terminal in the project directory.

That is already a real slice of GitHub Desktop's main screen. The screenshot the user referred to shows `main · 650 dirty` in the header, which is this surface working.

## Implementation notes

**The gap, as a list, against GitHub Desktop's main screen** — this is the scoping work, not a commitment to build all of it:

1. **Per-file staging.** The one that makes 650 dirty files unusable. Commit is all-or-nothing; GitHub Desktop's main screen is fundamentally a checklist of changed files.
2. **Diff view.** Reading what changed in a file, inline, before committing it.
3. **Branches.** List, switch, create. Currently a terminal trip.
4. **History.** The commit log for the current branch, with each commit's files.
5. **Fetch,** as distinct from pull — `statusOf` never touches the network, so `behind` lags reality until something fetches. Today nothing does except pull.
6. **Discard changes** on a file, and **undo last commit**.

Deliberately *not* on that list until someone argues for them: stash, rebase, conflict resolution, pull requests. GitHub Desktop has them; they are not what the user described as "almost all functions" of the main page.

**Two constraints that already hold and must keep holding.** The existing module drives the `git` and `gh` CLIs the machine already has, with fixed argv through `execFile` and never a shell, so a commit message or branch name cannot become shell. It deliberately uses no npm git library and no third-party GitHub MCP server, because each would add a supply-chain trust boundary for something two argv calls do. Any expansion inherits both constraints — and a per-file staging UI multiplies the number of user-supplied paths reaching the CLI, so that is where the argv discipline gets tested.

**The design constraint is the user's own.** "Same ui our design" — the ask is explicitly *not* to clone GitHub Desktop's chrome. This surface would be built in Orchard's visual language, which means it is a design task as much as a git task, and per the standing rule it would need a visual review, not just functional tests.

## Risks

Scope. GitHub Desktop is a shipped product with years in it, and "recreate the main page" is the kind of framing that grows without a boundary. The numbered list above exists so that a future decision is about *which items*, not about a vibe. Items 1 and 2 alone would be most of the value.

A second risk is that the existing Git group is small and legible precisely because it does one thing per row. Six more capabilities in the same drawer group is how a clean panel becomes a control panel; where this surface lives is itself part of the design work.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-21 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-08-21 — user
- **Unparked — build it:** The user asked for this to be built, in their own words: "in this list it says dirty i assume it is referring to tree, so maybe clicking that and it should show red/green changes amount on tree and tree type immediate view that we are on latest working on... but ya clicking opens full view replicated in a page a github desktop window ui replicated our style". So the branch chip becomes a click target and opens a full in-app git view in Orchard's visual language. Priority is the numbered list's items 1 and 2 first — per-file staging and a diff pane — because all-or-nothing commit is the thing that cannot be done at all today; history and branches after. Stash, rebase, conflict resolution and pull requests remain out of scope. The two constraints stand: fixed argv, never a shell, and no npm git library or third-party GitHub MCP server. Discard and reset are deliberately NOT in this pass — this surface can destroy uncommitted work, so a discard path ships only when it can be proven to touch only what was selected.

### 2026-08-21 — agent
- **Server half landed; client held on FEAT-101:** Built through four dispatch rounds to openai/gpt-5.6-sol. Landed in abbf8f3: src/server/git.ts gains changes/stage/diff and commit now takes the index exactly as staged and refuses an empty one; scripts/verify-git.mjs extended to 36 assertions. VERIFIED: 36 passed, 0 failed, exit 0, run by the dispatcher outside the sandbox — the proof the user asked for is real, a browser staged c.txt and not d.txt, committed, and the commit contained only c.txt while d.txt stayed dirty on disk. npm run gate exits 0. BASELINE HONESTY: at HEAD before this change the suite was already red on two assertions (8 passed, 2 failed); both are fixed here. WHAT IS NOT COMMITTED: public/lib/git-view.js, public/git-view.css and the FEAT-099 hunks in public/app.js and public/index.html are verified but held back, because git-view.js imports FEAT-101's public/lib/slide-panel.js which is still untracked in that lane's working tree; committing would have left main importing a module that does not exist, and staging that lane's file would have taken its work. CONCURRENCY DAMAGE, recorded so it is not mistaken for care: the BUG-138 lane's commit 3e7bcf4 swept up this ticket's src/server/index.ts routes (gitcli.changes/stage/diff) and public/lib/drawer.js openGit hook under its own message, which is why HEAD referenced functions that did not exist until abbf8f3. FOUR ROUNDS, and why: round 1 shipped the whole feature runtime-unverified because the Codex sandbox refuses to bind a localhost port or write the scratch root — every subsequent round had the same limit, so the dispatcher ran the suite each time and fed the real failures back. Round 2 and 3 were spent on one bug worth recording: the browser suite rendered the wrong project, because the crown chip follows currentProject() off the route hash, and clicking a project's tree button only expands it. Navigating to #/project/<id> fixed it. Round 4 was the visual review: the first screenshot gave the changed-files list about 180px and showed 3 rows of 42, which is the exact failure the brief warned about, plus raw diff headers leaking absolute host paths and none of the red/green the user asked for. Now the list owns the column with a pinned compact commit footer, headers are suppressed, counts are semantic red/green, gutter numbers come from real hunk headers, and it was re-reviewed at 64 and 184 changed files. DEFERRED: history, branches, fetch-distinct-from-pull. OUT OF SCOPE and deliberately absent, including as unwired endpoints: discard, reset, checkout --, clean, stash, rebase, conflict resolution, pull requests. INDEPENDENT VERIFY WARRANTED: this changes commit semantics and validates client-supplied paths into argv; generation should not be its own only verifier.

### 2026-08-21 — agent
- **Client half landed:** Landed the held-back client wiring now that FEAT-101's public/lib/slide-panel.js is in (57822ae). Committed: public/lib/git-view.js, public/git-view.css, the FEAT-099 hunks of public/app.js (the crown chip now opens the working-tree view instead of deep-linking the drawer's Git group) and the stylesheet link in public/index.html. THREE CHECKS the brief named, all done: (1) the import resolves — public/lib/git-view.js imports ./slide-panel.js, a real tracked sibling, and the server serves anything under public/, so /git-view.css and /lib/git-view.js both load; (2) slide-panel adoption corrected — the file had createSlidePanel(root) with no settledClass, which for a full-screen surface blanks the session mid-slide, so it is now createSlidePanel(root, { settledClass: 'git-open' }) with a matching html.git-open .window { visibility: hidden; } rule in git-view.css, mirroring tickets-open and guide-open; (3) the chip opens the routed project's tree — getProject is currentProject(), which reads the route hash, so expanding another project's tree cannot change it. VERIFIED: scripts/verify-git.mjs, 38 passed 0 failed, exit 0, real browser over a 64-file then 184-file working tree — chip clicked, changed files listed with semantic red/green counts, c.txt staged and only c.txt committed while d.txt stayed dirty, and each file's diff read in the pane. MUST-FAIL PROOF for the two new assertions: reverting the settledClass argument alone made 'slide settles before the session underneath is hidden' fail (37 passed, 1 failed) with observed {settled:false, win:visible}; restoring it returned 38/0. Also scoped .gv-empty to .git-view — the guide reader in styles.css owns a .gv-* namespace and that one selector collided. npm run gate exits 0. CONCURRENCY: public/app.js carried an unrelated hunk from another lane (a \u2019 escape rewritten as a literal curly quote at renderProjectGroup); it was filtered out of the index with git apply --cached over a hunk-filtered patch and left uncommitted in the working tree, since --only scopes to files and not hunks. STILL ABSENT ON PURPOSE: discard, reset, checkout --, clean, stash, rebase, conflicts, pull requests — not even as unwired endpoints. INDEPENDENT VERIFY STILL WARRANTED, as the prior entry said: this path validates client-supplied paths into argv and changes commit semantics.

### 2026-08-22 — agent
- **Completed in full:** Completed in full, after the user's verdict that the previous pass "outright skipped" requests for a minimal MVP. Landed in b2bc67d. ALL EIGHT of the user's remaining items are in: (1) green/red line counts in the crown chip, from working-tree totals statusOf computes in one numstat pass; (2) the git view is now a ROUTE shaped like the ticket board — #/git, /branches, /history, /stashes, with ← sessions, brand, project select and a view switcher, resolved as a third mutually exclusive sibling of #/tickets and #/guide in onHashRoute, popstate and the boot hash check, so Back/Forward across all three never strands an overlay; (3) ONE primary button carries fetch/pull/push state (Pull origin ↓N when behind, Push origin ↑N when ahead, Fetch origin otherwise, behind winning when both) with a 10-minute background fetch that skips a hidden tab, never stacks, backs off on failure and is cleared on close; (4) select-all with a real indeterminate state that stages exactly the FILTERED rows in ONE chunked request; (5) a debounced case-insensitive path filter with a matched/total count; (6) commit title + description, passed as two separate -m arguments — git's own subject/body convention, no string assembly; (7) branch listing, creation and switching; (8) a read-only stash view that exists in the UI only when stashes do. Row density is 23px, so the list shows ~31 of 650 rather than 8 of 184, and it owns over 80% of its column. HISTORY, the ticket's own success criterion, is also in: paged read-only log with per-commit files and diffs.

  BRANCH SWITCHING, the one destructive-adjacent path: refused outright on a dirty tree, with a message naming the real file count ("N files have uncommitted changes — commit them first; Orchard will not carry them across branches or discard them"). No force, no stash-on-your-behalf, no silent discard. If git refuses an otherwise-clean switch, its stderr is surfaced verbatim and the status re-read; success is never claimed. Branch names are validated against the real ref list and through `git check-ref-format`.

  ARCHITECTURAL CHANGE worth naming: src/server/git.ts was execFileSync throughout, on the single process that also carries every live session's WebSocket. A network fetch would have frozen the whole app. It is now async end to end (execFile, still fixed argv, still never a shell) and the routes await it.

  STILL ABSENT ON PURPOSE, not even as unwired endpoints: discard, reset, checkout --, working-tree restore, clean, stash push/pop/apply/drop, revert, amend, cherry-pick, rebase, conflict resolution, pull requests. Stash CREATE/APPLY/DROP are deliberately out — stash push removes work from the working tree and pop/drop destroys the entry, which is exactly the class this ticket forbids; the user asked for "a stashed-changes view" and the view is complete. Constraints held: fixed argv via execFile, never a shell; no npm git library; no third-party GitHub MCP server.

  VERIFIED: scripts/verify-git.mjs, 73 passed 0 failed, exit 0, run by the dispatcher outside the sandbox. Realistic fixture, not a minimal one: a 650-path working tree across nested directories with modified, deleted, renamed, staged-added, untracked and binary entries, a path containing a space and one containing non-ASCII, a local bare remote giving real ahead/behind, three local branches, two fixture-created stashes and 63 commits so history paging is genuinely exercised. Measured, not asserted by feel: filter keystroke to settled list 107ms, single checkbox round-trip 101ms, list share of column >0.80, row height 23px, 27-31 rows visible at 1440x900. MUST-FAIL PROOFS documented in the suite for the dirty-tree switch refusal and the batch-stage path validation.

  SEVEN BUGS THE VERIFICATION ACTUALLY CAUGHT, recorded because each one would have shipped: (a) staging any renamed file failed the whole batch — `git add -A -- <vanished source path>` errors "pathspec did not match any files", and the user's repo has renames; (b) fixing (a) then broke UNSTAGING a rename, because the pathspec rule is operation-dependent — add takes the destination, restore --staged takes both halves (regressed-from: the fix in this same lane, round 10); (c) a stash of untracked files listed no files at all, because `git stash show --numstat` omits them — needs -u, and per-file diffs cannot use -u at all, so tracked files go through `git diff <ref>^1 <ref> -- <path>` and untracked through `git show <ref>^3 -- <path>`; (d) the chip's counts went null on exactly the tree that matters, because the untracked budget was 50 FILES — now a cost budget, and a 184-file tree reports +14104 −4 exactly; (e) filtered select-all staged NOTHING, because toggleAll repainted before reading the checkbox and sent staged:false; (f) history "load more" fetched page two successfully and rendered nothing, because the render rebuilt instead of appending; (g) the branch-creation form and the dirty-tree paragraph were STILL PAINTED on the Changes view — `.gt-create { display:grid }` beats the `hidden` attribute — and the assertion had gone green on `el.hidden`. (g) was found by LOOKING AT THE SCREENSHOT while the suite reported 73/73 green; every visibility assertion is now on computed display/offsetParent, never the attribute.

  SUITE ROBUSTNESS, fixed because it hid work: a hand-rolled `new Promise` poll with no deadline hung the whole run forever and concealed roughly fifteen assertions from the first browser pass. Every hand-rolled poll now has a deadline that resolves with a diagnosis, and the three interaction assertions report the visible error text, response status and row counts instead of a bare boolean.

  NOT DONE, named rather than discovered later: a `← sessions` assertion against a real SESSION route (the fixture registers projects but never opens a session, so only the project surface is verified); the real ten-minute fetch interval expiry (the suite proves the timer is cleared on close, not that it fires at ten minutes); `gh repo create`, which remains deliberately unverified as the file has always said.

  COST: eleven dispatch rounds to openai/gpt-5.6-sol. The first attempt was ONE mega-brief covering everything; it deleted src/server/git.ts, quit after five tool calls with "Unable to complete FEAT-099 in this turn", and had to be restored from HEAD. Splitting it into server / route+shell / working-tree / branches+stashes+history / verification, then four fix rounds driven by real suite output, worked. Every browser run was the dispatcher's to execute — the Codex sandbox cannot bind a port — which is exactly the tax the brief predicted.

  INDEPENDENT VERIFY STILL WARRANTED: this pass changes commit semantics, validates client-supplied paths into argv at 650-path scale, and adds the first checkout in the product. Generation should not be its own only verifier.
