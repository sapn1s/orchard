```orchard-ticket
{
  "id": "ARCH-007",
  "type": "architecture",
  "title": "Browser startup remains eager in container sessions",
  "summary": "Browser startup is lazy only for direct sessions; container sessions still start it eagerly. Achieving direct-session laziness made the station implement a protocol relay, creating a large maintenance surface unrelated to browser behavior.",
  "impact_if_we_wait": "Container sessions remain eager, and every browser call retains station-owned protocol code in its request path. Bounded: this is a single-user local tool with nothing deployed; no user data is at risk, and no lost reply has been reported.",
  "current_need": "Independent clean-room verification of the lazy browser lifecycle before this is called verified — the suite that passes it was written by the lane that built it.",
  "severity": "medium",
  "area": "Browser startup",
  "reported": "2026-08-19",
  "reported_by": "user",
  "owner": "you",
  "work_state": "in_verification",
  "human_action": "review",
  "updated": "2026-08-25",
  "decision": null,
  "decision_history": [
    {
      "asked_on": "2026-08-19",
      "question": "How should browser startup become lazy without unnecessary protocol ownership?",
      "mode": "single",
      "options_keys": [
        "A",
        "B",
        "C",
        "D"
      ],
      "chosen": "A",
      "chosen_on": "2026-08-25",
      "chosen_by": "user",
      "note": "Capability-owned laziness. B and C leave container startup eager, which is the reported symptom; D removes mid-session browser availability, so a session that did not opt in cannot acquire the browser when the model later needs it. Only A moves laziness into the component that owns the browser. Prerequisite migration steps 1-2 (version-control the adapter, add a station-side lazy-capability probe) execute first."
    }
  ],
  "success_criteria": [
    "Every isolation shape invokes an adapter-owned entry point rather than a station-owned protocol server",
    "Listing tools and checking browser status start no Chrome process",
    "Concurrent first browser calls launch exactly one Chrome instance and all receive replies",
    "Direct and container sessions start Chrome only on the first page-dependent call",
    "The station refuses adapters that cannot declare lazy-start capability"
  ],
  "code_refs": [
    {
      "path": "src/server/sbmcp-lazy-shim.mjs",
      "symbol": null,
      "note": "Station-owned 648-line protocol relay proposed for deletion under option A"
    },
    {
      "path": "src/server/browser.ts",
      "symbol": "mcpServerFor",
      "note": "Selects the station relay for direct isolation"
    },
    {
      "path": "src/server/browser.ts",
      "symbol": "available",
      "note": "Migration adds a lazy-capability precondition here"
    },
    {
      "path": "scripts/verify-bug-116-lazy-browser.mjs",
      "symbol": null,
      "note": "Contains 56 checks, roughly 40 of which police the relay"
    },
    {
      "path": "src/daemon.mjs",
      "symbol": "main",
      "note": "Sibling adapter checkout launches Chrome before serving"
    },
    {
      "path": "src/mcp-stdio.mjs",
      "symbol": null,
      "note": "Adapter-owned protocol entry point restored under option A"
    }
  ],
  "related": [
    {
      "id": "BUG-116",
      "relation": "blocks"
    },
    {
      "id": "BUG-108",
      "relation": "see_also"
    },
    {
      "id": "BUG-035",
      "relation": "see_also"
    },
    {
      "id": "BUG-114",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [
    "BUG-116"
  ],
  "verification": [],
  "verification_class": "arch",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": true,
    "Migration and rollback": true,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/ARCH-007-laziness-is-implemented-by-interposition-so-the-station-owns-a-protocol-it-does-not-implement.md",
    "sha256": "2d4206a4dea8e05e06e120f045fa01da405631cc92dd7827dcc70aef39f618f1",
    "bytes": 30599,
    "original_title": "laziness is implemented by interposition, so the station owns a protocol it does not implement",
    "migrated_on": "2026-08-19",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against archived ARCH-007; the four options, recommendation, recurrence argument, migration, proof bar, bounds, and falsifiers remain represented.",
    "dropped": [
      "Repeated rhetorical framing",
      "Full environment-variable inventory",
      "Detailed browser process table"
    ]
  }
}
```

# ARCH-007 — Browser startup remains eager in container sessions

## Diagnosis

The station wanted Chrome to start on first use, but the timing control lives in a separate browser adapter. It therefore inserted its own stdio server between sessions and the adapter. That server answers discovery locally, starts the adapter on the first tool call, and relays later traffic.

Answering some requests locally and forwarding others makes the station responsible for framing, correlation, liveness, backpressure, request accounting, and shutdown. The narrower defect remains elsewhere: the adapter implements browser status through a tool path that obtains a page, so asking whether Chrome runs can start Chrome.

The architectural invariant is that changing startup timing must not transfer protocol ownership. A session should invoke an adapter-owned entry point for every isolation shape.

## Evidence

The archived defect narrative maps five landed commits to progressively discovered relay cases: df13918 introduced deferred startup; 4f8d488 addressed malformed input and reply ordering; 703a436 removed blocking reply order and drained accepted work; 4954b65 unified request accounting; 608064f derived terminating-signal handling.

Four described holes also exist in the adapter's own handwritten server, while two arose during relay hardening. That comparison weakens the claim that interposition alone caused the defects, but it preserves the ownership concern: the station maintains a protocol server merely to change startup timing.

The process census attributed eight orphaned headless browsers to the BUG-114 verifier-leak family and found none using the adapter's browser path. BUG-108 was measured and ruled out as the cause. BUG-035 documents the two attach shapes on which this design depends.

## Implementation notes

For option A, place the adapter under version control and pin it before changing behavior. Add a station-side capability probe that keeps the current relay until a lazy-capable adapter is present.

In the adapter, begin serving before Chrome exists and write daemon state with a null Chrome process. Add a single-flight launch operation to page-dependent calls. Browser status must return a stopped result without invoking that launch operation. Then point direct isolation back to the adapter entry point and remove the station relay and relay-only checks.

After direct isolation changes, start only the host daemon for container sessions so its socket can be mounted. The first in-container page-dependent call should launch Chrome on the host.

## Verification plan

Run the adapter tests and verify:browser against the modified checkout before switching the station. Prove the eager adapter is a live failing control, while the lazy adapter leaves Chrome absent after session creation and tool listing.

Issue at least eight concurrent first tool calls and require one Chrome root process with every reply returned. Check browser status before launch and confirm the process count remains zero. Then exercise a real page through direct isolation.

For container isolation, run verify:container and confirm the socket exists before Chrome, the first tool call renders through the host browser, and cross-project isolation remains intact. Run verify:bug-116-lazy-browser only after removing checks that describe deleted relay behavior.

## Migration and rollback

Land adapter versioning and capability detection independently. Next land lazy adapter startup, including status, stop, cleanup, and concurrent-launch handling. Switch direct isolation behind the capability check as a separate station change. Delete the old relay only after the direct and container paths meet the proof bar.

The station switch is the primary rollback point: reverting it restores the unchanged relay while adapter support remains dormant. Keep the relay file until container behavior is established, so rollback does not require reconstructing deleted code.

## Risks

Option A can create duplicate Chrome instances if concurrent first calls are not serialized. Pre-launch status, stop, and orphan cleanup can also regress because current daemon metadata assumes Chrome already exists.

If the adapter cannot be controlled or safely versioned, option A loses its premise. If adapter-owned protocol code later loses replies in real use, moving ownership upstream was insufficient and a library-backed transport belongs inside the adapter. Continued quiet across additional independent attacks would strengthen option C, though it would not resolve eager container startup.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-19 — arch review lane (read-only)

- **Understood:** the user invoked the project's own three-strikes rule against BUG-116 and asked for verification, not agreement. Read the ticket end to end, all five `Verified-by:` verdicts, the 648-line shim, the 1,291-line suite, and — the part the ticket's own history could not do — the adapter's `daemon.mjs`, `mcp-stdio.mjs`, `cli.mjs` and `tools.mjs` in the sibling checkout.
- **What changed my reading of the trigger:** the six defects are not six independent bugs (they are all one surface: relaying a JSON-RPC stream through an extra process) **but neither are they all caused by interposing** — four of the six exist unfixed today in the adapter's own 193-line shim, which sits in the same position in the same stream and has never been held to an adversarial standard, and two existed only inside the fix cycle. So the rate measures the proof bar as much as the shape. The argument for redesign therefore does **not** rest on the rate; it rests on (a) 648 lines of hand-written protocol code owned by the station to change one timing boolean, (b) the container half of BUG-116 being unfixable without the upstream change anyway, and (c) `sbmcp status` being a second instance of the "asking starts it" invariant, which is the bar round 1 set for filing this ticket.
- **Also established:** the "20+ browsers per hour" are the UI/renderer verification family, not this feature (measured: 0 stealth-browser processes, 8 leaked headless verification browsers reparented to `systemd --user`, 1 daily driver); the leak is BUG-114's; the launches themselves are legitimate and the count is inflated by counting processes rather than instances. And there is no configuration route to laziness — the adapter's whole knob set was read from source.
- **Changed:** this ticket and its `INDEX.md` row. **No product code, no scripts, no adapter code.** The INDEX row was generated by `board:gen` in a scratch copy of the repo outside the tree (other lanes hold uncommitted board edits) and only this ticket's row was applied here.
- **Verified:** nothing to verify — this ticket builds nothing by design. `npm run gate` run before commit with its exit status read directly, never piped; the repo-wide result is reported in the commit lane's notes and this lane's own two files scan clean.
- **Still open / handoff:** a human picks A, B, C or D. If the answer is "not now", the cheapest information-gathering move is migration steps 1–2 alone (version-control the adapter, add the capability precondition) — they change no behaviour, are useful under every option including C, and they are the only way to find out whether A's premise (the adapter can be safely modified) is even true. Owner flip to 👤 on INDEX is needed for the Decide card to render; INDEX is orchestrator-owned.

### 2026-08-25 — you (answer · via ticket view)
- **Question:** How should browser startup become lazy without unnecessary protocol ownership?
- **Chose:** A — Capability-owned laziness
- **State:** answered — awaiting agent action (not dispatched)

### 2026-08-25 — build lane (option A landed)

- **Decision recorded first**, before any code: `decision_history[0]` now carries `chosen: "A"`, `chosen_by: user`, `chosen_on: 2026-08-25`, with the reason B/C leave container startup eager (the reported symptom) and D removes mid-session availability. `decision` is cleared; the question is closed.

- **Migration step 1 — the adapter is under version control.** It had **no `.git` at all**, confirmed. Backed up first (`~/scratch/arch-007/adapter-backup-preARCH007-*.tar.gz`), then `git init` + an initial import commit of the verbatim pre-change tree at `~/random_projects/stealth-browser-mcp`. That import is not bookkeeping: the must-fail control below **runs the eager daemon out of that commit**, so the premise "the adapter can be safely modified" is now proven by being exercised, not asserted.

- **Migration step 2 — the capability probe.** `browser.lazyStartCapability()` reads `sbmcp.capabilities.lazyStart` from the adapter's `package.json`. Deliberately a **file read**: a probe that ran the adapter, or pinged its daemon, to learn whether it starts lazily would be the same defect wearing a different hat. `available()` now refuses an adapter that cannot declare it, so an eager adapter can no longer be attached silently. The daemon reports the same number over a new `capabilities` op — runtime confirmation, not the gate.

- **The lifecycle change.** The daemon claims its socket, reaps orphans, **serves**, and owns no Chrome. `ensureBrowser()` is a single-flight gate in front of every page-dependent call. `ping`, `tools/list`, `capabilities` and `browser_status` are answered with `browser === null`, which is now the daemon's resting state.

- **The two hard parts the ticket named.**
  - *The launch race*: eight first calls pipelined down one connection (the shape the MCP shim actually uses) produce **one** Chrome root and eight correlated replies, measured, in 551ms.
  - *Status and cleanup before Chrome exists*: `browser_status` never touches `ensureBrowser` and reports `chrome_running:false`; `stopChrome`/`killProfileOrphans`/`shutdown` all run with no browser; `sbmcp stop` on a never-launched daemon exits 0 and claims no orphans. One trap found and closed while building: the 60-second cookie snapshot went through the launching page accessor, so **a background timer would have resurrected Chrome** — it now uses a non-launching `currentPage()`.

- **Two behaviours changed deliberately, not by omission.**
  1. **Idle now reclaims Chrome, not the daemon.** It used to exit the process. That was safe only while a serving daemon always had a Chrome behind it; a container bind-mounts this socket, runs `SBMCP_AUTOSTART=0`, and cannot recreate it — exiting would have removed the browser from a live session permanently. Same reasoning applied to an unexpected Chrome disconnect: it drops to the lazy state and the next call relaunches, instead of taking the daemon down.
  2. **Warm logins still survive a station restart — kept on purpose.** The user's mitigation for that (closing the unwanted window) was already defeated in practice, but laziness removes the nuisance *at its source*: a window now exists only if something used it. Survival therefore costs nothing and is worth keeping, so `index.ts`'s leave-running-on-shutdown behaviour is untouched.

- **`running` no longer means "the daemon answered".** A lazy daemon answers with no Chrome, so the CLI would have called every armed project a running browser. It now reads `chrome_running` off the daemon and reports `daemon_running` separately; an older eager daemon omits the field and falls back to `true`, so the CLI stays honest against both generations.

- **The relay is gone.** `src/server/sbmcp-lazy-shim.mjs` (648 lines) and `scripts/verify-bug-116-lazy-browser.mjs` (1,291 lines, ~40 of 56 checks policing the relay) are deleted; `verify:bug-116` is replaced by `verify:arch-007`. Both isolation shapes now invoke the adapter's own entry point. Rollback is `git revert` in this repo, plus the adapter's own history — which is why step 1 came first.

- **Verified — `npm run verify:arch-007`, 83/83, exit 0.** Nine sections against the **real adapter on this machine**, not a fixture.
  - **Live must-fail control**, section B: the pre-change daemon, checked out of the adapter's initial import and run for real, **had already launched 9 Chrome processes by the time it answered a ping at all**. The first hand-run control also put **1 real visible window** on the display.
  - **The user's criterion, both halves, in the shape the user reports.** Section I drives a real station server (free port, scratch `CLAUDE_STATION_DATA`), creates a real **container** project with the browser enabled, and takes a real turn: **0 Chrome processes, 0 new windows**, socket present. Then the second half — driving the mounted shim from *inside the running container* over the bind-mounted socket with autostart forbidden — **launches Chrome on the host and returns the rendered page**, one root process. Section H is the same for `direct`. Section G is **headful** and diffs actual X window ids, because "no window appears" is a claim about windows and a process count is only a proxy for it.
  - Also proven: idle closes Chrome and leaves the socket serving; a call after an idle close relaunches and works; `browser/stop` keeps the daemon alive; `reap` leaves a healthy never-launched daemon alone; the run leaks no Chrome.

- **Anti-regressions run.** `verify:container` **19/19, exit 0**. `verify:browser` **23/24** — the one failure is **pre-existing at HEAD and not mine**: `verify-browser.mjs` expects the mount-guard text `"managed by Claude Station (stealth browser)"` while `container-manager.ts` says `"managed by Claude Station — pick another path"`; both files are untouched by this lane (empty `git diff HEAD` for both), so the mismatch exists at HEAD independently of this change. `npm run gate` **PASS, exit 0**, read directly and never piped — it caught a hardcoded home path in the new verifier on the first attempt, which was fixed before commit.

- **Not touched:** the two affected user project repos; port 4317; the claude-station service; any `claude-station-host-*` scope. No process this lane did not start was killed. The user's `~/.stealth-browser-mcp` had no live daemon, so the new behaviour applies from their next use with nothing to migrate.

- **Still open / handoff — an independent clean-room pass is warranted** (session-lifecycle, regression-prone, and it modifies a dependency that had no history until today). What it should attack, in the order I would attack it:
  1. **The single-flight gate under adversarial timing**, not just eight-at-once: a first call that *fails* to launch (make Chrome unresolvable mid-run) and a second that must still be able to retry; a `browser/stop` racing an in-flight launch; a `shutdown` racing a launch. `ensureBrowser` awaits `stopping` and `stopChrome` awaits `launching`, and that mutual await is the part most likely to deadlock or to leak a browser nobody holds a handle to.
  2. **Partial and truncated reads of the capability declaration** — a `package.json` being rewritten while `lazyStartCapability()` reads it. The gate fails closed on unparseable JSON, which is right, but "the browser silently became unavailable because npm was mid-write" is a plausible live failure that no test here models.
  3. **Orphan accounting when Chrome is killed out from under the daemon** (`SIGKILL` the root, not `browser.close()`): does the disconnect handler's new drop-to-lazy path leave renderer processes holding the profile, and does the next launch then trip the profile lock?
  4. **The claim that `running` stayed honest**: point the station at the *eager* daemon from the import commit and confirm the CLI's fallback still reports `running:true` — I asserted that compatibility path in code but only tested the lazy side of it.
  5. **The container mount over a long session**: the socket now outlives Chrome by design, but nothing here tests a container whose daemon is `sbmcp stop`ped mid-session — the mount goes stale and `SBMCP_AUTOSTART=0` means nothing can recover it. That is the failure this design trades for, and it should be measured rather than assumed acceptable.
