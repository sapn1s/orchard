```orchard-ticket
{
  "id": "BUG-162",
  "type": "bug",
  "title": "git sync control sits on \"Working…\" forever — every project looks stuck",
  "summary": "The git panel's Fetch/sync button shows \"Working…\" while `syncing===true` and never leaves it — perma-stuck on every project, unfixed by reopening. Server: fetch/push/pull run git with no real bound, so a prompting or black-hole remote hangs for the 60s hard timeout. Client: `open()` never resets `syncing`, so a navigation during a slow fetch strands the per-generation flag permanently.",
  "impact_if_we_wait": "The primary git surface is unusable for anyone whose remote is slow or prompts: the sync control on every project reads \"Working…\" indefinitely and no reopen recovers it — the 'cannot tell working from dead' class that has bitten this project repeatedly.",
  "current_need": "The sync control must never sit working indefinitely. A network git op must be bounded and fail with the real reason; the flag must be owned so switching project resets the control and no navigation can strand it.",
  "severity": "high",
  "area": "git panel + server git ops",
  "reported": "2026-08-28",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-08-28",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "a network git op against an unreachable, prompting or black-hole remote fails in seconds with a real reason, never riding the timeout or hanging forever",
    "opening the panel resets the sync control to match the opened project; an in-flight fetch cannot leave the flag stuck true",
    "navigating to a remoteless project mid-fetch shows \"No origin configured\", never a stranded \"Working…\"",
    "a failed fetch clears \"Working…\" and surfaces \"could not reach origin\" instead of sitting silent",
    "verify-git, verify-git-branch-switch and verify-bug-156-publish-branch stay green"
  ],
  "code_refs": [],
  "related": [
    {
      "id": "BUG-156",
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
    "confirmation": "Authored directly in the record format through scripts/board-tool.mjs. There is no legacy original.",
    "dropped": []
  }
}
```

# BUG-162 — git sync control sits on "Working…" forever — every project looks stuck

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-28 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-08-28 — fix lane (round 1, class=fix)
- **Confirmed mechanism — two compounding defects, not the narrow race the dispatch first described.** The dispatch opened on a rare navigate-away-mid-fetch race on a *remoteless* project. The user's escalation ("the trees are perma stuck in 'working' state" — plural, permanent, unfixed by reopening) falsified that framing. Re-derived from that fact:
  - **Server (`src/server/git.ts`).** `git()` (the shared helper) inherited default env and resolved its Promise only from the `execFile` callback. `fetch`/`push`/`pull` therefore had no *real* bound: a remote that prompts for a credential/passphrase/host-key with no tty, or a black-hole that accepts the TCP connection and never answers, hangs `git` for the full 60s hard timeout. Empirically (probe against a loopback accept-and-silence server): the callback DID fire at ~timeout on this Node/git build (so it is not the "grandchild holds the pipe, callback never fires" variant), but it took the whole timeout AND leaked a surviving `git-remote-http` grandchild each time.
  - **Client (`public/lib/git-view.js`).** `syncing` is owned per generation: `fetchNow`'s `finally` clears it only when `t===generation`, and `open()` bumped `generation` but never reset `syncing`. During a slow (up-to-60s) fetch, any navigation — the project `<select>` or a view tab, both `ctx.navigate → open()` — bumps `generation`; the in-flight fetch's `finally` then skips the clear, and `open()` inherits the stale `true`. Because `syncing` is one shared closure var, every project's panel then reads "Working…" forever. That is the perma-stuck, "fresh open won't clear it" the user saw.
- **Fix — ownership + a real bound (both halves needed; clearing the flag alone would hide a hung process).**
  - `public/lib/git-view.js` — `open()` now resets `syncing=false` alongside the other per-generation resets (`failures`, `fetchedAt`). Each generation owns the flag; a superseded fetch's `finally` still refuses to touch it (`t===generation` guard kept, so it cannot clobber a newer live fetch). Navigation can no longer strand it.
  - `src/server/git.ts` — new `netGit()` wrapper for the three network ops: `GIT_TERMINAL_PROMPT=0` (never block on a headless prompt), `GIT_SSH_COMMAND=… -oBatchMode=yes -oConnectTimeout=10 -oStrictHostKeyChecking=accept-new`, and `-c http.lowSpeedLimit=1000 -c http.lowSpeedTime=15`. `git()` gained an optional `env` param. `fetch`/`push`/`pull` now call `netGit`; the existing 502 path surfaces the real reason.
- **Sibling states checked.** Remoteless project on a clean open → "No origin configured" (disabled). Failed fetch → clears "Working…" and `syncNote` shows "could not reach origin" (button returns to its real action, e.g. "Publish … to origin"), not silent. Both verified in the real browser, both themes.
- **Verification.** New `scripts/verify-bug-162-git-sync-stuck.mjs` drives headless brave against scratch repos (one origin = loopback black-hole, one remoteless). Must-FAIL proven: with the `open()` reset reverted, the strand test observes `afterNav="Working…"` and `settled="Working…"` (perma-stuck, matching the report). With both fixes: 5/5 PASS — bounded fetch (~15s, real reason), clean remoteless label, no strand on mid-fetch navigation, stays usable after the stranded fetch resolves, failed fetch clears + reports. Regressions green: verify-git 74/0, verify-git-branch-switch 20/0, verify-bug-156-publish-branch 9/0. Screenshots (both themes) eyeballed.
- **Independent verify warranted.** Session-lifecycle-adjacent, regression-prone surface (a control that must never read "working" when nothing is) touching a contended file — flag for a clean-room second pass. Bucket: not a routine UI tweak.
- **Files (unstaged; agent does no git writes):**
  - `public/lib/git-view.js` — `open()` resets `syncing=false` so a superseded fetch can never strand the flag.
  - `src/server/git.ts` — `netGit()` bounds + de-prompts fetch/push/pull; `git()` takes optional `env`.
  - `scripts/verify-bug-162-git-sync-stuck.mjs` — new real-browser reproduction + sibling-state suite.
