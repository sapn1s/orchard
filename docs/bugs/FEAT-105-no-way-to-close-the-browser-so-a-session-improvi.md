```orchard-ticket
{
  "id": "FEAT-105",
  "type": "feature",
  "title": "No way to close the browser, so a session improvises a kill",
  "summary": "The browser is attached silently with no close tool. Two container subagents finished with it, found nothing to call, and reached for the host process table (lsof, then ps/kill by pattern) — the road ending at pkill chromium. Adds an adapter-owned browser_close reachable from every isolation shape, plus a launch-time note naming it and forbidding process kills.",
  "impact_if_we_wait": "Every browser-using session leaves a real headful window in the user's workspace for up to 15 idle minutes, each one an invitation to improvise a kill against a process the session cannot identify. Bounded: no user browser killed yet; observed damage is nuisance windows.",
  "current_need": "Independent clean-room verification: this is session-lifecycle plus a prompt-surface change, and the suite that passes it was written by the lane that built it.",
  "severity": "high",
  "area": "Browser lifecycle",
  "reported": "2026-08-25",
  "reported_by": "user",
  "owner": "you",
  "work_state": "in_verification",
  "human_action": "review",
  "updated": "2026-08-25",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "One command closes the browser from every isolation shape, including a container that has no CLI and no host process visibility",
    "Closing is idempotent and never an error, so a failed close cannot read as an invitation to kill something",
    "Listing tools, checking status, closing, and naming a tool that does not exist all start no Chrome",
    "A session is told at launch that the tool exists and that killing a browser process is never the answer",
    "A session with no browser is told so explicitly rather than left to infer it"
  ],
  "code_refs": [
    {
      "path": "src/server/agent-bridge.ts",
      "symbol": "browserAvailabilityNote",
      "note": "Launch-time note: names browser_close, forbids pkill/ps/lsof/pgrep, three-state like dispatchAvailabilityNote"
    },
    {
      "path": "scripts/verify-browser-close-command.mjs",
      "symbol": null,
      "note": "41 checks against the real adapter, incl. the container shim shape and an X window-id diff"
    },
    {
      "path": "scripts/verify-browser.mjs",
      "symbol": null,
      "note": "Chrome-on-host check now samples during the turn; a tidy session legitimately leaves nothing behind"
    }
  ],
  "related": [
    {
      "id": "ARCH-007",
      "relation": "see_also"
    },
    {
      "id": "BUG-114",
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

# FEAT-105 — No way to close the browser, so a session improvises a kill

## Diagnosis

The browser is attached **silently**. A session sees `mcp__stealth-browser__*` in its
tool list and must infer everything else: that the browser runs on the host outside its
sandbox, that opening is automatic and lazy (ARCH-007), that a real headful window
appears in the user's workspace, and that nothing in the session can close it.

Nothing could close it because nothing *existed* to close it. Of the eleven tools, none
closed the browser — `browser_tabs action=close` closes a tab. The daemon's `browser/stop`
is a socket op the MCP shim never forwards. `sbmcp stop` is a host CLI that is not on a
container's PATH and is not mounted. So for a containerised session the honest answer was
"there is no way", and the model, correctly believing tidying up was its job, went looking
in the only place left: the process table.

The invariant: **a capability a session cannot discover is a capability it will
reimplement, badly.** The dangerous half is that the bad reimplementation of "close a
browser" is a pattern-matched `kill`, and the pattern matches the user's own Chrome.

## Evidence

The real incident, from the user's own transcript —
`~/.claude/projects/-workspace-kenimai-website/c4d796c8-.../subagents/agent-a9903e6e75c0d1eb1.jsonl`,
2026-08-25T13:11:47Z:

```
PID=$(lsof -t -i:3007 | head -1); PGID=$(ps -o pgid= -p "$PID" | tr -d ' '); kill -TERM -"$PGID"
  -> /bin/bash: line 1: lsof: command not found
```

and the next turn, verbatim: *"lsof isn't available; the process tree is visible (PIDs
1417/1418/1425/1436). Killing by that process group."* That specific kill targeted a dev
server and was correctly scoped by pgid — but it is the improvisation *reflex* under a
missing tool, and the same reflex applied to a browser it cannot see has no safe landing.

The daemon log for that project is the other half, and it refutes the comfortable reading
that idle already handles this (`~/.stealth-browser-mcp/projects/kenimai-website/daemon.log`):

```
12:55:44 launching chrome ... headless=false
13:01:49 chrome disconnected unexpectedly — dropping to lazy state
13:06:24 launching chrome ... headless=false
13:09:03 chrome disconnected unexpectedly — dropping to lazy state
13:09:42 launching chrome ... headless=false
13:14:18 chrome disconnected unexpectedly — dropping to lazy state
```

**The idle timer never fired once.** Every close is `chrome disconnected unexpectedly` —
that is the *user* closing the window by hand, three times in 22 minutes. The design's
only automatic reclaim is a 15-minute idle timer, and the user's patience is shorter than
its interval. The system logs their mitigation as an anomaly.

## Implementation notes

`browser_close` is added to the **adapter**, not the station, so one implementation serves
both isolation shapes. It is dispatched **before** `page()` — closing must never be what
makes Chrome start, the same invariant ARCH-007 established for `browser_status`. It
delegates to the existing single `stopChrome()` path shared with the idle timer, the
`browser/stop` op and `shutdown()`, so no second close path exists to diverge.

It reaches containers with **no image rebuild**: the container mounts `mcp-stdio.mjs`,
which caches `tools/list` from the host daemon rather than hardcoding it.

The tool's own description carries the refusal, because a description is the one piece of
text guaranteed to be in front of a model at the moment it is choosing what to call.

Station-side, `browserAvailabilityNote()` mirrors `dispatchAvailabilityNote()`'s
three-state shape from FEAT-102 (enabled / enabled-but-unavailable / not-enabled — never
silence), gated on the same `browserSettingsOf(project).enabled` that attaches the tools,
so note and tools cannot disagree.

## Verification plan

Drive the real adapter against a scratch state dir. Prove discovery starts nothing; close
before launch succeeds; open→close→gone with the daemon still serving; idempotence and
transparent relaunch; the container shim shape with `SBMCP_AUTOSTART=0`; and — because the
complaint is about a *window*, not a process — a headful X window-id diff showing the
window appears and goes, with no pre-existing window disturbed.

## Risks

The browser is shared per project. One session closing it while another is mid-navigation
costs that session its page state; the next call relaunches lazily. This is the same
outcome as the user closing the window by hand, which they already do routinely, so it is
not a new failure mode — but it is untested under concurrency.

`browser_close` is advisory: a session that ignores it, crashes, or is interrupted still
leaves a window for the 15-minute idle timer. Nothing yet *owns* closing independently of
the model's cooperation.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-25 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-08-25 — build lane (browser_close + launch-time note)

- **Established the shape before building, and it corrected the brief twice.** First: the
  `lsof` improvisation in the real transcript was aimed at a **dev server**, not a browser
  — I nearly wrote a ticket asserting otherwise. The browser half of the story is that the
  two subagents opened the host browser via `mcp__stealth-browser__*` and simply had no
  close tool at all. Second: "maybe a session should not close it" is wrong — the daemon
  log proves the idle timer **never fired** and the user was closing windows by hand three
  times in 22 minutes. Both corrections came from reading the real artefacts (the user's
  container-session subagent transcripts and the live `daemon.log`), not from the design docs.

- **What a container session actually has**, established rather than assumed: only the
  bind-mounted `mcp-stdio.mjs` and `/sb/browser.sock`, with `SBMCP_AUTOSTART=0`. No
  `sbmcp` on PATH (the Dockerfile never mentions it, and `browserBinds()` mounts the shim
  only), no host process visibility, and the shim forwards only `tools/list`/`tools/call`
  — so the daemon's `browser/stop` socket op is unreachable. An MCP **tool** was therefore
  the only surface that works everywhere, and it needs no image rebuild because the shim
  caches `tools/list` from the host daemon.

- **Changed** — adapter (`~/random_projects/stealth-browser-mcp`, its own git history):
  `src/tools.mjs` declares `browser_close`; `src/daemon.mjs` dispatches it before `page()`
  through the existing single `stopChrome()` path. Station: `browserAvailabilityNote()` in
  `src/server/agent-bridge.ts`, appended to the composed system prompt at launch;
  `scripts/verify-browser-close-command.mjs` (new); `scripts/verify-browser.mjs` (one
  assertion re-aimed, see below); `package.json` (`verify:browser-close`).

- **A latent bug the must-fail control exposed, now fixed.** Running the new suite against
  the stashed pre-change adapter, `browser_close` failed with `unknown tool` — *after*
  launching Chrome (`roots=1095760`). `page()` ran before the name switch, so **any
  unrecognised tool name started the browser**. That is worst exactly here: a model
  guessing at a close tool (`browser_stop`? `browser_quit`?) popped a real window into the
  user's workspace per guess. `callTool` now validates the name against `TOOLS` before
  `page()`. Same "asking must not start it" invariant as ARCH-007. Pinned by a check.

- **Verified — `npm run verify:browser-close`, 41/41, exit 0**, against the real adapter on
  this machine in a scratch state dir.
  - **Must-fail control**, run by stashing the two adapter files and re-running: 8 checks
    fail, including `unknown tool: browser_close` and the accidental launch above.
  - **The container shape** — the mounted shim with `SBMCP_AUTOSTART=0`, which is where the
    incident happened: it advertises `browser_close`, navigate launches Chrome on the host,
    close removes it, and the daemon survives so the bind-mounted socket stays valid.
  - **The window, not a proxy for it** — section F runs headful and diffs real X window ids:
    the window appears, `browser_close` removes it, and **no window that existed before the
    run was disturbed**, which is the precise failure mode `pkill` would have caused.
  - Close before any launch, close twice, and a guessed tool name all succeed-or-error
    **without starting Chrome**.

- **The strongest evidence is an A/B on real behaviour, not on my fixture.** `verify:browser`
  drives a real model through a real browser turn. With the launch note reverted, Chrome was
  still running after the turn (the old assertion passed). With the note in place the model
  **closed the browser itself**: `peak during turn=11 chrome process(es) ... still live after
  turn=0`. That is the user's complaint fixed end to end by a real session, not by a test
  calling the tool directly. I re-aimed that one assertion accordingly — its intent is
  "Chrome ran on the **host**", so it now samples during the turn instead of asserting the
  window lingers afterwards, which was asserting the defect.

- **Anti-regressions run.** `verify:arch-007` **83/83, exit 0** (and it independently
  confirms reach: the container now lists **12** tools, was 11). `verify:container` **19/19,
  exit 0**. `verify:browser` **22/24** — both failures are **not mine and were confirmed so
  by running the suite with my change stashed** (23/1 then): (a) the mount-guard text
  mismatch already named in ARCH-007's log (`verify-browser.mjs` expects "managed by Claude
  Station (stealth browser)", `container-manager.ts` says "— pick another path"), and (b)
  `CONTROL: plain curl is BLOCKED on the target site` — indeed.com served plain `curl` a 200
  on this run, a third-party network flake that did not recur in the control run.
  `npm run gate` **PASS, exit 0**, read directly, never piped.

- **Not touched:** the user's live kenimai daemon (pid 1033253) and its socket, their own
  browser windows, port 4317, the claude-station service, any `claude-station-host-*` scope.
  Nothing was killed that this lane did not start; the suite's only backstop kill is scoped
  to its own scratch profile path. The running daemon still has the old code loaded, so the
  new tool applies from its next start — no restart was performed.

- **Two things for the user to decide, deliberately NOT decided here.**
  1. **Headless.** The adapter already supports `SBMCP_HEADLESS` / `--headless`; it defaults
     to headful and the station never plumbs it, so there is no way to set it per project.
     For the work these agents actually do (does a page scroll to `#request`) headless would
     end the workspace interference outright. The counter-argument is real: this browser
     exists to carry a persistent logged-in profile and headless is more detectable — which
     is the entire reason it is not a plain automation browser. Cost to offer it: one
     settings field, one env var through `mcpServerFor`/`start`. Their call, not mine.
  2. **An owner for closing that does not depend on the model cooperating.** `browser_close`
     is advisory. The candidate is closing Chrome when the last browser-attached session for
     a project ends — "release the handle" — which the station already has the facts for
     (`browserAttached`, and `POST /browser/stop`'s existing live-session guard). I did not
     build it: it is session-lifecycle code with a regression history (BUG-043, BUG-018,
     BUG-044) and another lane was live in this tree. Filing it separately is the honest move.

- **Still open / handoff — an independent clean-room pass is warranted** (session-lifecycle
  plus a prompt-surface change; generation must not be its own only verifier). What I would
  attack, in order:
  1. **Concurrency**: two sessions sharing one project browser, one calling `browser_close`
     while the other is mid-`browser_navigate`. `stopChrome` awaits `launching` and
     `ensureBrowser` awaits `stopping`; this suite only ever drove one caller at a time.
  2. **`browser_close` racing the idle timer and `shutdown`** — three entrants to one
     `stopChrome`, only two of which I exercised.
  3. **Whether the note survives the prompt budget.** It is appended after the dispatch note
     and before the board snapshot, all of which are capped independently; I asserted the
     append happens but never measured a *large* real project's composed prompt to confirm
     nothing truncates the browser section away.
  4. **The negative claim**, which is the one that actually matters and which I tested only
     by reading the note's text: put a fresh session in a container with a browser open and
     a plausible reason to tidy up, and see whether it still reaches for `ps`/`kill`. My
     `verify:browser` A/B is one real observation of correct behaviour; one is not a rate.
