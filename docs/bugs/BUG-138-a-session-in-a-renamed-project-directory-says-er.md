```orchard-ticket
{
  "id": "BUG-138",
  "type": "bug",
  "title": "a session in a renamed project directory says Error and answers nothing",
  "summary": "A session showed a bare \"Error\". The project's directory had been renamed, so the working directory Orchard recorded was gone — and the failure named neither the project nor the path. Following the rename meant editing registry.json by hand, which would have stranded every session: history is indexed by the working directory.",
  "impact_if_we_wait": "Renaming a project directory is ordinary and silent: the project dies with an unreadable error, and the only available fix strands its whole session history under a path nothing points at any more.",
  "current_need": "Landed. Repointing a project now carries its sessions, the failure names the path, and the sidebar flags a project whose directory is gone. NEEDS A SERVER RESTART for the running build to have any of it.",
  "severity": "high",
  "area": "registry / session history / drawer",
  "reported": "2026-08-21",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "done",
  "human_action": "review",
  "updated": "2026-08-21",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A session whose project directory is missing refuses with the path it expected and what to do about it — and writes nothing.",
    "Repointing a project at its renamed directory keeps every session listed and readable, moving no files, and reports how many came along.",
    "A candidate directory is only called a match against the project's own recorded identity; a project identified only by its path asks.",
    "Reversible: renaming the directory back, or repointing again, strands nothing."
  ],
  "code_refs": [
    {
      "path": "src/server/registry.ts",
      "note": "pastPaths + ProjectIdentity + repointCandidates - the record of where a project used to be, and what identifies it"
    },
    {
      "path": "src/server/index.ts",
      "note": "sessionsForProject merges past store dirs; PATCH hostPath with a carry report; pathMissing on the list"
    },
    {
      "path": "src/server/agent-bridge.ts",
      "note": "startSession preflight - the working directory is checked before anything tries to use it"
    },
    {
      "path": "public/lib/drawer.js",
      "note": "the Directory block: missing state, candidates, armed confirm"
    }
  ],
  "related": [
    {
      "id": "BUG-136",
      "relation": "see_also"
    }
  ],
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
    "confirmation": "Authored directly in the record format through scripts/board-tool.mjs.",
    "dropped": []
  }
}
```

# BUG-138 — a session in a renamed project directory says Error and answers nothing

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-21 — user
- **Filed:** through the board tool; the record was validated before it was written.

## Diagnosis
Two independent facts, both about the same missing thing.

**Why it said nothing.** With `direct` isolation the project's `hostPath` is handed
to the CLI as its cwd. Nothing checked it existed, so the spawn died with an ENOENT
that named neither the project nor the path — the third instance today of a
specific cause held somewhere and dropped before it reached the user (BUG-136's
container credentials, then its missing mount, now this).

**Why following the rename would have cost the history.** Sessions are indexed by
the WORKING DIRECTORY (`~/.claude/projects/<encoded cwd>/`) and merged on that
path's normalised BASENAME (`logicalKeyForCwd`). So *moving* a directory keeps its
history and *renaming* it does not: the files stay on disk under a key nothing
points at. And `hostPath` was rejected by `validateProjectPatch` as an unknown
field, so the only repoint available was hand-editing registry.json — which would
have stranded exactly that history, silently.

**The identity gap underneath both.** A registry row's only link to its sessions
was the path itself: a fact re-derived from an artifact that no longer carries it.
There is no single rule that fixes this, because identity is per project — a
non-repo directory has nothing but its path; a worktree, fork or second checkout
SHARES a remote, so a remote match there would repoint the wrong row; a plain
one-checkout repo has a remote that really is unique. So identity is now DECLARED
per project at the moment the row is written, while the directory is still there
to be asked, and `kind: 'path-only'` is a real answer that means "ask the user".

## Evidence
- Exactly one registered project pointed at a directory that is gone (`direct`
  isolation, 5 real session files recorded under its now-missing path). Every
  other registered project is fine — checked, not assumed.
- That project's row carries no recorded identity (it predates the field) and its
  directory is gone, so nothing is left to match against. `repointCandidates`
  reports that in words and offers 40 directories for a human to choose from. No
  similarly-named directory was promoted to a match; nothing was repointed.
- Pre-fix, against a HEAD worktree, `npm run verify:bug-138` scores **13/38**: no
  `pathMissing`, no candidates route, `PATCH {hostPath}` 400s as an unknown field,
  and the start failure names nothing about the directory. Post-fix **38/38**.

## Implementation notes
- `Project.pastPaths` — previous hostPaths, newest first; `sessionsForProject`
  merges each one's store dir (de-duplicated by sessionId, same shape as the
  existing container-dir merge). No file is moved or copied, which is what makes
  it reversible in both directions: repointing back drops that path off the list.
- `Project.identity` (`git-remote` | `path-only`) — captured at add and at repoint.
  A candidate is `match` ONLY against it. A remote shared with another registered
  project is reported as undecidable rather than matched.
- `PATCH /api/projects/:id {hostPath}` — refuses a path that is not an existing
  directory, and one another project already owns (their histories would merge).
  The reply carries `pathChange` with the carried-session COUNT.
- `startSession` preflight — the working directory is checked first, before the
  browser, the container and any spawn; the refusal names the path, the project,
  that nothing was changed, and where to fix it.
- `explainUnresumable` gains `cause: 'path-changed'`. An older session recorded
  against the pre-rename path used to be labelled "recorded on another machine",
  which sent the reader looking for a Windows checkout that was never involved.

## Risks
- The repoint is a registry write, so it is behind an armed confirm that names the
  exact directory; opening the panel, listing candidates and even an unambiguous
  match write nothing.
- `pastPaths` is capped at 10. A project renamed more than ten times loses the
  oldest store dir from its merged list (the files are untouched and still readable
  by path).
- Two projects that legitimately share a git remote (a worktree, a second checkout)
  are reported as undecidable rather than matched — deliberately conservative; the
  cost is a question, and the alternative is repointing a row at someone else's work.

### 2026-08-21 — worker (BUG-138 lane)
- **Understood:** the user's ask moved mid-lane from "explain the error" to
  "follow the rename and keep the sessions", and then to "identity depends per
  project". Both landed; the honest failure is the fallback, not the goal.
- **Changed:** `src/server/registry.ts` (pastPaths, ProjectIdentity, captureIdentity,
  repointCandidates, sameRemote), `src/server/index.ts` (past-dir merge, PATCH
  hostPath + carry report, `pathMissing`, repoint-candidates route),
  `src/server/agent-bridge.ts` (working-directory preflight), `src/server/validate.ts`
  (accept hostPath), `src/server/fork.ts` + `src/server/events.ts` + `public/app.js`
  (`path-changed` resume cause, sidebar "dir missing" chip), `public/lib/drawer.js`
  + `public/lib/api.js` + `public/styles.css` (the Directory block).
- **Verified:** `npm run verify:bug-138` **38/38** (real registry read-only + a real
  server, a real on-disk rename, and 40 REAL transcripts seeded as the fixture
  project's own history — repoint carries all 40, the largest still reads with the
  same message count, no file moved, round-trip clean, typo and clash refused).
  `npm run verify:bug-138-ui` **19/19** (real app.js in happy-dom: the sidebar chip,
  the drawer block, the badged match, "arming writes nothing", the confirm copy, and
  the result line reporting 12 of 12 sessions carried). Must-FAIL: the same suite on
  a HEAD worktree scores 13/38. Anti-regression: `verify:sessions` 52/52,
  `verify:addproject` 7/7, `verify:feat-071-project-dir` 6/6, `verify:overrides` 5/5.
  `npm run gate` exit 0.
- **Verified-by:** NOT YET — this touches the session store's indexing and a
  registry write, so an independent clean-room pass is warranted before VERIFIED.
- **Still open:** the user's own broken project is deliberately NOT repointed.
  Orchard cannot decide it (no recorded identity, directory gone) and says so; the
  sidebar now flags it and the drawer offers the candidates. That is theirs to pick.
- **Symptom of a deeper design flaw?** yes, and it is already the third instance
  today of one shape — a specific cause produced and then dropped before the user
  (BUG-136 twice, this once). Named here rather than filed as ARCH so the pattern
  is visible; worth an ARCH ticket if it recurs a fourth time.
