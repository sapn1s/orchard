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
