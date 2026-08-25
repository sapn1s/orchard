```orchard-ticket
{
  "id": "BUG-136",
  "type": "bug",
  "title": "a containerised session says Error and never answers",
  "summary": "A new session in a container project showed Error and answered nothing. The container binds ~/.claude/.credentials.json as a single FILE; the host replaces that file on token refresh, orphaning the inode the container holds. Sessions then end is_error with \"Not logged in\" — which the UI dropped, labelling the turn \"success\".",
  "impact_if_we_wait": "Every container project dies silently one token rotation after its container was created, and stays dead: nothing recreates the container and the badge names nothing. The guard written for this exact message checks that the HOST file exists, which it always does.",
  "current_need": "Landed and proven on the real container: a CLI turn inside it now returns is_error=false with a real answer. NEEDS A SERVER RESTART — the running build predates 632e178, so a session start still throws bad-mounts. Container already healed.",
  "severity": "high",
  "area": "container isolation / turn-end labelling",
  "reported": "2026-08-21",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "review",
  "updated": "2026-08-21",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A container whose credentials file was replaced on the host is reported as drifted, naming that bind, and is recreated by the next ensure.",
    "A healthy file bind is never reported as stale, and neither is a directory bind.",
    "An error turn is labelled with the engine's own explanation rather than the word success."
  ],
  "code_refs": [
    {
      "path": "src/server/container-manager.ts",
      "note": "staleFileBinds - inode identity of every FILE bind, folded into driftReasons"
    },
    {
      "path": "public/app.js",
      "note": "turn-end endLabel - resultText was emitted by the server and read by nothing"
    },
    {
      "path": "src/server/agent-bridge.ts",
      "note": "turn-end already forwards resultText (line ~3179); unchanged"
    }
  ],
  "related": [
    {
      "id": "BUG-107",
      "relation": "see_also"
    },
    {
      "id": "BUG-108",
      "relation": "see_also"
    },
    {
      "id": "BUG-031",
      "relation": "see_also"
    }
  ],
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
    "confirmation": "Authored directly in the record format through scripts/board-tool.mjs.",
    "dropped": []
  }
}
```

# BUG-136 — a containerised session says Error and never answers

## Symptom
A new session in a container-isolated project showed **Error** beside the model name, and a sent
message appeared to go through and was never answered.

## Two faults, and which is which
The message DID reach the model's process. It was answered with an error, not with silence. Asked
directly, the CLI inside that project's container returns:

    {"subtype":"success","is_error":true,"result":"Not logged in - Please run /login", ...}

So: fault one is why a logged-in host produces a logged-out container. Fault two is why the UI
rendered that as a badge saying "Error" over a hint saying "success".

## Diagnosis
**One.** `desiredBinds()` mounts `~/.claude/.credentials.json` as a single FILE. Docker resolves a
bind source ONCE, at container create, and the container then holds that INODE for life. Directory
binds are safe - a directory mount follows the path - but the host's own Claude Code refreshes its
OAuth token the ordinary safe way, by writing a temp file and `rename()`ing it over the original.
That is a new inode. The container keeps the old one, now unlinked, and nothing reports anything: the
file is still present, still readable, and frozen. When its token expires the CLI tries to refresh
it, writes the failure into the ghost, and every session in that container is logged out permanently.

`doEnsure` already guards the case this LOOKS like - "credentials file not found, run claude and log
in first", written against this very error string - and it could never fire, because the host file is
present and perfectly valid. It is the container's copy that is a ghost. The guard checked existence
where it needed to check IDENTITY.

The comment on the bind says the mount is rw because "the CLI refreshes the OAuth token in place".
That is true only of the CLI inside the container. It was the mental model that made this invisible.

**Two.** The turn-end event has carried `resultText` - the engine's own sentence about what went
wrong - since BUG-031, and nothing in the client has ever read it (`rg resultText` found the producer
and no consumer). An error turn with no attributed provider error and terminal reason `completed`
fell through to `e.subtype`, which is the string `success`. So the one line naming the fault was
discarded and replaced by a word that contradicted the badge above it.

## Evidence
Against the real container, not a fixture:

    HOST ino=10156834 links=1 size=509   (valid tokens)
    CTR  ino=7965302  links=0 size=281   (accessToken "", refreshToken "", expiresAt 0)

Link count 0: the inode the container holds has no name on the host any more. The same container's
other file bind - the browser MCP shim - reports ino 1740240 on both sides, so the check discriminates
rather than firing on everything.

Must-FAIL, anchored to a build that cannot move: the running pre-fix server, started 2026-08-20
10:31, reports `GET /api/projects/<id>/container` as `"state":"running"` with no drift for that exact
container. The fixed code reports the stale bind and names it.

Ruled OUT, with the reason: the MCP servers. Both `serena` and `playwright-mcp` start cleanly inside
the container when run by hand, the image matches the current provision hash exactly
(`12a9489ed193`), and the container's `claude` is present and reports its version. BUG-108's pin is
not implicated. BUG-129/BUG-132 landed at 11:12 and 11:25 on 08-20, AFTER the running server started,
so the running server does not contain them at all - though both are client-side, so they ARE live;
neither touches delivery, and the message did reach the model. BUG-118's launcher-side hook re-sync
is in the running build and is not implicated: it degrades to a report and never fails a launch. The
earlier `serena` start failure in this project is fixed and did not recur.

## Fix
- `staleFileBinds()` (container-manager) compares, for every FILE bind, the inode the host path
  resolves to NOW against the inode the container actually holds, and folds a mismatch into
  `driftReasons`. Drift already means "recreate on the next ensure", so the next session start
  re-binds the current file and heals itself. Deliberately narrow: file binds only, running
  containers only, an absent host path is not a reason (the browser socket comes and goes with its
  daemon), and any docker or stat surprise degrades to "no drift" - this check may only ever add a
  reason it can prove.
- The turn-end label uses `resultText` where it would otherwise print the bare subtype - exactly the
  case where the alternative is a word that contradicts the badge. Provider-attributed errors and
  BUG-031's `api error` keep precedence.

## Risks
A token rotation now makes the container drift, so it is recreated at the next session start. That is
correct and is the existing drift policy, but it is a new trigger for `removeContainer`, and a
recreate would take down any session already live in that container. The exposure is small - a
container in this state is already unable to answer anything - but it is real. A rotation DURING a
live session still breaks that session; only the next start heals it.

The durable alternative, not taken: stop binding a single file. Mounting `~/.claude` wholesale would
fix the shape but hands the container read-write access to every project's transcripts and settings,
which this codebase has refused on purpose; a station-owned copy re-introduces the same staleness
plus a duplicated secret. Detect-and-recreate keeps the security posture and makes the failure
self-healing.

## Activity log
- 2026-08-21 - Reported: new session in a container project, Error badge, no answer. Ground truth
  first: no transcript was written for it, no session host was started, and the server journal was
  silent - so the failure was inside the CLI, not before persistence. Running the CLI in the
  container by hand produced "Not logged in - Please run /login" in 1.5s. Inode comparison found the
  orphaned bind. Both fixes landed; `npm run gate` exit 0.

### 2026-08-21 — board tool
- **landed:** Landed in 41a9d6f (code) and b8e08e5 (ticket). Deploy note: the drift check is server-side and needs a claude-station restart; the turn-end label is client-side and is live on the next page load.

### 2026-08-21 — board tool
- **second report — why it did not heal:** Re-measured first, on the real container, before theorising. Container still the one created 08-19: credentials inode 7965302 links=0, tokens blank, CLI 'Not logged in - Please run /login' in 87ms. So it had never been recreated. Checked the three candidates in order. (1) The running server DOES have the fix — it runs src/ directly with no build step, restarted 16:20:51, fix landed 16:07:35. (2) The drift check is NOT overruled: called out-of-process against the real project record it returns exactly one reason, naming the stale credentials bind. It was right. (3) The credential theory was still correct. What was wrong was that nothing could ever ask: ensureContainer threw ContainerError bad-mounts — 'host path does not exist' for a sibling project dir the user had deleted — at validateMounts, which runs BEFORE the inspect/drift/recreate block. A dead mount on an unrelated directory had pinned the project to its stale container permanently. Fix: validateMounts gains requireHostPath so an absent path is an error at write time and tolerated at ensure time; desiredBinds skips an absent user mount and announces it, which is self-correcting both ways since drift compares desiredBinds to the live binds; and the session-start error now includes err.detail, which held the only actionable fact (the path) and was being dropped — the same discard-the-explanation shape as fault two. Proof after a real ensureContainer: mount skipped, recreate logged for both reasons, host and container agree on inode 10156834 links=1, CLI turn is_error=false, result 'CREDENTIALS OK', 1969ms. Anti-regressions: write-time still rejects a missing path; mounting over /etc and over the whole host home stay rejected at BOTH strictnesses. npm run gate exit 0 (it caught a private project name in a comment first — scrubbed). Note the container WAS recreated, deliberately, as the fix. Not taken, and why: replacing the single-file credentials bind. Detect-and-recreate demonstrably works now that it is reachable; the residual cost is that a recreate at session start would kill a session already live in that container. The cheaper durable shape is to refresh the orphaned inode in place (write the host credentials through the mount via docker exec) so no recreate is needed at all — worth its own ticket, not worth bundling into a fix the user is blocked on.

### 2026-08-21 — worker
- **third report — root cause is the browser socket bind:** Third report. Both prior passes were live and CORRECT, and both were unreachable.

  LIVE ERROR (daemon.log, 17:07Z, after the 17:43 restart):
    [sbmcp] removing stale socket ~/.stealth-browser-mcp/projects/<bot-project>/browser.sock
    [sbmcp-daemon] FATAL: Error: EISDIR: illegal operation on a directory, unlink
      '~/.stealth-browser-mcp/projects/<bot-project>/browser.sock'
        at claimSocket (stealth-browser-mcp/src/daemon.mjs:58:6)

  browser.sock was a ROOT-OWNED EMPTY DIRECTORY, not a socket. Docker materialises a
  missing bind source as a root-owned dir, and desiredBinds applied its absent-path
  skip to USER mounts only; the stealth browser socket was passed to docker create
  unconditionally. That socket exists only while its daemon serves.

  ORIGIN, dated off the live system: container created 13:38Z by POST
  /api/projects/:id/container/start|rebuild, which calls ensureContainer with NO
  browser start (session start calls browser.start() first; that route does not).
  The daemon had died at 13:30Z, so the source was absent and docker left the
  directory. The daemon could never start again - it unlinks the stale socket on
  startup and got EISDIR forever.

  startSession runs the browser step BEFORE ensureContainer and that step throws
  fatal, so pass 1's credentials drift check was never reached. It was working: the
  live status route reported drifted:true with the right reason. Pass 2's
  absent-mount tolerance was fine too. Two correct fixes behind a gate neither
  opened.

  NOT ESTABLISHED, stated honestly: why the UI showed a BARE "Error". The
  browser catch in startSession does compose a full message
  ("stealth browser unavailable (start-failed): ..." plus BrowserError.detail),
  so the server had text to send. Whether the badge beside the model name simply
  never renders that message, or it was rendered elsewhere and the user is
  describing the badge, was not chased down - the fault above was reproduced and
  fixed without needing the answer. If a bare badge is still seen for a fatal
  start error, that is a separate UI defect and worth its own ticket.

  FIX
  - desiredBinds: browser binds take the same self-correcting absent-path skip the
    user mounts already had. Daemon down -> bind dropped -> drift -> recreate
    without it; daemon up -> drift -> recreate with it. Docker is never handed a
    missing source, so the directory cannot be created again.
  - doEnsure: removes an EMPTY directory already at the socket path so an affected
    project heals on its next ensure instead of needing a manual rmdir.
    Non-recursive, socket path only, failures logged not fatal.

  VERIFIED ON THE LIVE SYSTEM (not a scratch server - that is what the earlier
  lanes got wrong)
  - container/status before: drifted:true, stale credentials bind.
  - container held cred inode 10156834; host 10387682 (rotated 19:29 EEST).
  - rmdir poisoned dir -> POST browser/start (daemon up, real socket) -> POST
    container/start -> recreated 17:51Z, cred inode 10387682 == host,
    /sb/browser.sock is type "socket", drift clear.
  - THE ONE CRITERION: a real type:'start' over live ws://127.0.0.1:4317/ws, same
    shape public/app.js sends, answered "LIVE SESSION OK".
  - must-FAIL: with the guard removed the socket bind is passed to docker while
    absent (the poison); with it, skipped. Daemon-up case still binds it.

  NOT YET LIVE: the code fix ships on the next restart. The user's session works
  right now because the poisoned directory was removed by hand and the container
  recreated; the code change is what stops it recurring.

  STILL OPEN, SEPARATE - the user's "this didnt rename"
  Registry project <web-project> still points at ~/projects/<web-project>,
  which does not exist; the directory is now ~/projects/<app-project> (origin
  github.com/<user>/<app-project>.git). <bot-project> also still carries a mount of the
  old path, which is why every session start logs the skip line. BUG-138 built the
  repoint path but nothing has repointed this project. Left for the user - not
  touching their registry entries or repos.

  regressed-from: none - this path predates BUG-136 and no prior fix touched it.
