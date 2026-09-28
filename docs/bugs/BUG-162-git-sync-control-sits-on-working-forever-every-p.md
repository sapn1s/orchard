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
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-09-28",
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

### 2026-09-23 — fix lane (round 2, class=fix)
- **Residual gap the round-1 fix left open (its own log admitted "leaked a surviving `git-remote-http` grandchild each time").** Round-1's `netGit` still bounded fetch/push/pull only with env de-prompting + curl's `http.lowSpeed` abort + `execFile`'s `timeout`. That is a REAL bound only for a *pure* black hole (curl aborts the stalled transfer in ~15s and reaps its own helper). But `execFile`'s `timeout` SIGTERMs the DIRECT `git` only — never the process group — so for any remote that keeps curl's transfer just above `http.lowSpeedLimit`, git rides the full hard timeout and its `git-remote-http` grandchild (the process actually holding the socket) is orphaned and left running.
- **Must-FAIL reproduced on the real exported `git.fetch()` (not a mock), Node 24.18 / git 2.55:** a loopback "trickle" remote that sends an HTTP header then dribbles ~2KB/500ms. Against round-1 code: `failed=true elapsed=60189ms` (rides the whole 60s timeout) and **`leaked helpers=1 — ORPHAN: /usr/lib/git-core/git-remote-http origin http://…`** — the exact orphaned grandchild.
- **Fix — spawn git as its OWN process-group leader and reap the whole group (`src/server/git.ts`, `netGit`).** Replaced the `execFile`-timeout indirection with a direct `spawn('git', …, { detached: true, stdio: ['ignore','pipe','pipe'] })`. On timeout the timer kills the group by NEGATIVE pid — `process.kill(-pid, 'SIGTERM')` then a `SIGKILL` backstop 2s later — so no git-remote-http/ssh grandchild survives (never a bare `child.kill()`, which is the orphaning bug). On kill the op resolves `code:124` with a loud real reason `timed out after 60s — could not reach origin`; the existing 502 path surfaces it. The `NET_ENV` de-prompt + `NET_CONF` fast-fail (seconds) are unchanged and remain the first line of defence; the group-reap is the guarantee underneath. Client `syncing` ownership is already correct from round 1 (`open()` resets it), so no client change was needed — the residual defect was purely the server orphan/backstop.
- **Verification.** New permanent guard `scripts/verify-bug-162-netgit-orphan.mjs` drives the real `git.fetch()` against BOTH a black-hole (A) and a trickle (B, the must-FAIL) loopback remote and asserts each fails AND leaves zero live `git-remote-http`. Post-fix: `RESULT: PASS (2/2)` — A `failed=true elapsed=15260ms leaked=0`, B `failed=true elapsed=60184ms leaked=0` with reason "timed out after 60s — could not reach origin". (Command: `node scripts/verify-bug-162-netgit-orphan.mjs`.) Regressions all green re-run on this change: verify-git 74/0, verify-git-branch-switch 20/0, verify-bug-156-publish-branch 9/0, and round-1's `verify-bug-162-git-sync-stuck.mjs` 5/0 (failed fetch still clears "Working…" and shows "could not reach origin"). `npm run gate` → PASS (exit 0): leak-gate + check-nul + typecheck.
- **Note.** Trickle case still rides the 60s hard cap by design — lowering it risks aborting a legitimately slow large push/fetch; the value-add here is that the cap is now a CLEAN group-kill, not an orphaning SIGTERM. The `git()` helper's optional `env` param is now unused by `netGit` but left in place (harmless, still referenced in-body).
- **Independent verify warranted.** Session-lifecycle-adjacent, regression-prone, process-lifecycle/data-adjacent (spawned-child reaping) on a contended file — flag for a clean-room second pass (`scripts/independent-verify.mjs` / fresh-context agent). Bucket: not a routine UI tweak.
- **Files (unstaged; agent does no git writes):**
  - `src/server/git.ts` — `netGit()` now spawns git detached and reaps the process group on timeout (SIGTERM→SIGKILL by negative pid); real reason + `code:124` on timeout.
  - `scripts/verify-bug-162-netgit-orphan.mjs` — new real-`fetch()` orphan/timeout guard (black-hole + trickle scenarios).

### 2026-09-23 — independent verify (round 3, class=verify)
- **Verdict: PASS.** The round-2 `netGit` claim holds for every demonstrated network-hang scenario. Verified the diff/test/requirement only (did not read the fixer's rationale).
- **Fixer test re-run (once, real output):** `verify-bug-162-netgit-orphan.mjs` → `RESULT: PASS (2/2)` — A black-hole `failed=true elapsed=15039ms leaked=0`; B trickle `failed=true elapsed=60017ms leaked=0` reason "timed out after 60s — could not reach origin".
- **Clean-room cross-provider review (openai/codex via `npm run dispatch`)** surfaced 5 candidate defects; each attacked with real repro:
  - *#1 setsid grandchild holds the inherited stdout/stderr pipe → `child.on('close')` never fires → promise hangs forever (the exact stuck-"Working…" symptom).* Mechanism PROVEN generically (`/tmp/close-vs-exit.mjs`: direct child exits, `exit` fires @1ms, `close` never fires within 4s). But NOT weaponizable against real git: a 401 remote + `credential.helper=cache` spawns a real `credential-cache--daemon` that escapes the group yet does NOT hold netGit's pipe — `fetch()` resolved in 28ms, no hang. The socket-holder (`git-remote-http`) is in-group and reaped. Not a break; recorded as a hardening note (resolve on `exit`, or `unref`/detach the stdio, to be robust against a hypothetical pipe-holding escapee).
  - *#4 SIGKILL backstop `setTimeout` is never cleared on early finish (`unref()` ≠ cancel); on pid reuse it could `kill(-pid)` an unrelated/concurrent group.* CONFIRMED by code read. Negligible in practice (Linux sequential pid alloc; requires a group-leader pid reused inside the 2s window) but a real latent hazard — cancel the backstop in `finish()`.
  - *#5 on timeout, `reason = err.trim() || "timed out…"` — a git op that already wrote stderr masks the timeout reason.* Real minor UX gap; in practice err is empty on the tty-less timeout path (test B shows the friendly message).
  - *#3 server shutdown mid-fetch strands detached children (their killer timer dies with the process).* Real but inherent to `detached`; NET_CONF self-bounds HTTP ~15s / ssh connect ~10s. See could-not-test.
- **Extra attack — fast-error remote (immediate HTTP 500):** `fetch()` failed in 24ms with a real reason, resolved cleanly, no hang. PASS.
- **User-observable outcome verified** (`verify-bug-162-git-sync-stuck.mjs`, real headless browser, both themes) → 5/5 PASS: failed fetch clears "Working…", surfaces "could not reach origin", button reverts to "Publish main to origin", mid-fetch nav to a remoteless project shows "No origin configured" without stranding.
- **Regressions:** verify-git 74/0, verify-bug-156-publish-branch 9/0. `verify-git-branch-switch` flaked 2/3 on the "after explicit confirm the switch proceeds" browser-timing step — NOT attributable to this diff (branch switch uses local `git()` checkout; the change is confined to the fetch/push/pull `netGit` body). Recommend a separate flake ticket; does not block BUG-162.
- **Could NOT test:** (a) a real git helper that both escapes the group AND holds netGit's stdout/stderr pipe (the cache daemon closed its std fds — could not construct one); (b) server-process-kill mid-fetch orphan (would require killing the real host server — out of scope); (c) deterministic pid-reuse to prove the #4 cross-group SIGKILL.
- Verified-by: independent verifier (Opus 4.8), clean-room openai/codex cross-check; commands + real output above.

### 2026-09-28 — board-hygiene lane (status correction, no code)
- **Move: open → verified.** A board-check sweep found this ticket still `work_state: open` despite being fixed and independently verified. Ground truth: the fix landed on `main` in two commits — `257aca3` ("bound git network ops and own the sync flag so the control never hangs", round 1) and `3481e76` ("bound git network ops and reap the whole process group", round 2) — and the round-3 **independent** clean-room verify (2026-09-23, entry above) returned **PASS** with a `Verified-by:` line, having attacked five candidate defects with real repros (only latent/hardening notes remained, none blocking). Per `DONE_WORK_STATES`, `verified` moves it to the Done table on the next `board:gen`. No code, scripts, or INDEX hand-edit — record field only.
