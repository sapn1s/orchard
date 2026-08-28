# BUG-156 — Git panel goes quiet after committing a branch with no upstream; never offers to push/publish

- **Status:** OPEN — fix built + self-verified (9/9 UI, 74/74 git regression). Independent clean-room verify warranted (touches the push path on the user's real repo).
- **Severity:** medium
- **Area:** git panel (public/lib/git-view.js) / server git (src/server/git.ts)
- **Reported:** 2026-08-26 by user (a private project, on a branch with no upstream)
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED.

## Symptom
User committed through Orchard's Git panel on a private project, on a branch with no upstream, and asked, verbatim:

> "created a supposed commit, but there is no option to push?"

The panel showed the branch header, "Fetch origin — Last fetched just now", "0 of 0 · 0 staged", and "No uncommitted changes." — and no push affordance anywhere.

## Repro
1. A repo whose current branch has commits but **no upstream** configured, and which has an `origin` remote (`git remote get-url origin` succeeds, `git rev-parse @{upstream}` fails). This is exactly the state of the reporting branch on the user's private project.
2. Commit via the Git panel.
3. The sync control reads "Fetch origin"; there is no push/publish button; the panel says nothing about the commit being local-only.

## Expected
After committing, the panel tells the user the branch is not on its remote and offers to **publish** it (first push = `push -u origin <branch>`). Push is explicit/user-initiated, never automatic. Failures (rejected, diverged, no upstream, auth) are reported, never silent.

## Findings (round 1, 2026-08-26)
- **The commit DID land.** Read-only inspection of the real repo (under `~/projects/`): HEAD is `9838b7d` (2026-08-26 21:04) on the reporting branch, clean tree. The "supposed commit" was real — no data was lost. The more-serious "reported success but no commit" case did not occur.
- **Push already exists server-side and partially client-side.** `git.ts push()` already does `push -u origin <branch>` when there is no upstream; `index.ts` routes `POST .../git/push`; `git-view.js` line 22 already renders "Push origin (↑N)" **when `ahead>0`**.
- **Root cause:** `ahead` is computed against `@{upstream}`, so it is `null` when the branch has no upstream. The sync-button logic fell through to `action='fetch'` whenever `ahead<=0`, and `noRemote` was false (a remote existed), so the only offer was "Fetch origin". A fresh branch with no upstream — the user's exact case — could therefore never reach push/publish. Push "did not exist" for that state.

## Fix
`public/lib/git-view.js` (2 hunks, client-only; server unchanged):
- **line 22 (sync-button paint):** add a `noUpstream` case (remote present, upstream absent) → `action='publish'`, label `Publish <branch> to origin`, and a sync-note `"<branch> isn't on origin yet — commits stay local until you publish"` so the panel no longer goes quiet.
- **line 51 (sync click handler):** map the UI `publish` action to the existing server `push` route (which already does `push -u`), and add a success `ctx.notify` for publish/push/pull so a completed action is visible.

## Context pack
- Files/functions in play: `public/lib/git-view.js` (paint sync button ~line 22; `sync.onclick` ~line 51); `src/server/git.ts` `push()`/`statusOf()` (unchanged); `src/server/index.ts` git route (unchanged).
- Related tickets: FEAT-099 (git panel build), FEAT-049 (publish-safety — publishing code is an explicit escalation).
- Repro test: `node scripts/verify-bug-156-publish-branch.mjs` (headless brave, scratch repos + bare "origin"; covers publish, ref-landed, indicator-clears, ahead, rejected-push).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-26 — worker (fix lane, round 1)
- **Understood:** Two questions — did the commit happen (yes, verified read-only against the real repo), and where is push (existed for the `ahead>0` case but unreachable for a no-upstream branch, which is the user's state).
- **Changed:** `public/lib/git-view.js` (2 hunks — sync-button paint + click handler; see Fix). Added test `scripts/verify-bug-156-publish-branch.mjs`. No server change; no git writes by this lane.
- **Verified:** must-FAIL baseline on the pre-change tree = 6 fails incl. the exact report (scenario 1: "Fetch origin" / "Last fetched just now", no publish). On the fixed tree `node scripts/verify-bug-156-publish-branch.mjs` = **9 passed, 0 failed**: publish offered on no-upstream+remote; pressing Publish lands the branch on the bare origin (bare ref === local HEAD); indicator clears to Fetch; a further commit shows "Push origin (↑1)"; a divergent remote makes publish **rejected and the error is surfaced in the panel** (not silent) with the remote ref untouched. Anti-regression `node scripts/verify-git.mjs` = **74/74**. `npm run gate` = **PASS (exit 0)**. Screenshots read in both themes (publish-{light,dark}.png show the Publish button + note; reject-{dark}.png shows the red non-fast-forward error). Screenshots live under a scratch run dir (git-ignored, not published).
- **Verified-by:** PENDING — independent clean-room verify warranted: this touches the push path against the user's real repo. The push mechanism itself was unchanged and is covered by verify-git 74/74, but a second fresh-context pass should cover a case the fixture omits (e.g. detached HEAD with a remote; a branch whose remote-tracking ref exists but upstream is unset; auth-failure surfacing).
- **Still open / handoff:** independent verification before VERIFIED. Consider whether "publish" should also gate behind FEAT-049's publish-safety escalation when the remote is a public GitHub URL — noted, not built here (out of scope; this only surfaces an already-configured origin).
- **Symptom of a deeper design flaw?** (answer on close) — candidate: the sync button derives its whole affordance from `ahead/behind`, which are null without an upstream; any state where those are null silently degrades to "fetch". Worth watching for an ARCH ticket if a second null-upstream affordance gap appears.

### 2026-08-27 — worker (leak redaction + class fix)
- **Redacted (security):** this ticket had been written with private tokens (the real project name and an absolute home path) and was blocking `npm run gate` for every lane. The project name and its rename-branch name were replaced with neutral descriptions ("a private project", "the reporting branch"); the absolute path became `~/projects/`; the commit message was dropped, the commit hash/timestamp/clean-tree facts kept. No finding, count, trace or file reference was changed — only identifying tokens. The repo is public; a leaked path/name is an exposure the moment it is pushed.
- **Class fix (this was the 2nd such leak in 2 days, after BUG-155):** the board tool's write path now refuses at authoring time. `scripts/board-tool.mjs` `file`/`update` scan the content against the SAME token list the commit-time leak-gate uses (extracted to `scripts/lib/leak-tokens.mjs`) and refuse a write carrying a private token, returning the offending line + class. Filed as prevention ticket **FEAT-110**.
