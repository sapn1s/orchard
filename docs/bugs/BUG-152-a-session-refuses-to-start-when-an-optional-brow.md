```orchard-ticket
{
  "id": "BUG-152",
  "type": "bug",
  "title": "a session refuses to start when an optional browser is unconfigured",
  "summary": "Sessions in a container project answered nothing but \"Error\" on send. The project's settings had not changed in weeks. What changed was the machine: a reboot dropped CLAUDE_STATION_SBMCP_REPO from the systemd user environment, and every project with the persistent-browser toggle on became unstartable. An optional tool being unconfigured refused the whole session.",
  "impact_if_we_wait": "Every browser-enabled project stays dead after any reboot, with an error naming an environment variable rather than anything the user set. The same class recurs: host configuration outside the repo can take sessions down for reasons unrelated to the session.",
  "current_need": "A session in the affected project answers a message.",
  "severity": "high",
  "area": "server/agent-bridge",
  "reported": "2026-08-25",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "in_progress",
  "human_action": "none",
  "updated": "2026-08-25",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "a session in the affected project starts and answers a message with the adapter unconfigured",
    "an unavailable browser produces a non-fatal error, not a refused session",
    "no mcp__stealth-browser__ tools are attached to a session told the browser is unavailable",
    "the system prompt states the browser is enabled-but-unavailable, with the reason",
    "container binds can be computed with the toggle on and no adapter configured"
  ],
  "code_refs": [],
  "related": [],
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

# BUG-152 — a session refuses to start when an optional browser is unconfigured

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-25 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-08-25 — worker
- **degrade an unavailable optional browser instead of refusing the session:** Live error first, before any theory — that is what turned this from the fourth round of guessing into a diagnosis. Drove the RUNNING server over its own /ws `start` for the affected project and got, verbatim: "stealth browser unavailable (adapter-missing): no browser adapter configured — set CLAUDE_STATION_SBMCP_REPO to a checkout of the adapter project." Fatal, at start, before the container step. The journal held nothing: the refusal is emitted to the socket, never logged, so every journal-first look at this came up empty.

  All four of the day's suspects were checked, not just the first that fit. (1) Image drift: no. The worktree's Dockerfile+provision.json hash to 89abd0532b34 and that base image was already built and on disk; HEAD's 21c6f6ce17d0 is there too, so neither tree drifts. (2) Stale service: no. The unit runs src/ directly, every source mtime predates the 18:30 start, the live GET returns the new orchestrator field, and a live PATCH of it returned 200 — server and disk agree. (3) The mount of the renamed sibling directory: still tolerated, confirmed on a real container start, which logged "skipping project mount ... that host path does not exist". BUG-136's second-round fix holds. (4) Browser socket: no root-owned anything anywhere in the adapter state tree.

  The real cause is none of them and is not in the repo at all. The adapter checkout is present and complete on disk; the environment variable pointing at it is not. It lived only in the systemd user manager's environment, which the 18:30 reboot wiped, and the unit has never carried it. The project's own settings have had the browser on and untouched since 08-09. So: host configuration with nothing to do with the session being started took every browser-enabled project down.

  Two fixes, because the outage had two halves.

  HOST (durable config): added a unit drop-in 20-browser-adapter.conf carrying CLAUDE_STATION_SBMCP_REPO, and reloaded. `systemctl --user show` now lists it. The RUNNING process does not have it — process environments cannot be changed from outside — so THE LIVE FIX NEEDS A RESTART, which was deliberately not performed: the user has a live session in this server. Not restarting was the instruction and is also correct.

  CODE (so losing it is never an outage again): an unavailable browser now DEGRADES the session instead of refusing it. The old refusal argued that a session "silently missing" the browser moves the failure to mid-task — but silently is no longer what happens. FEAT-105 already built the enabled-but-UNAVAILABLE prompt state and never passed it a value; it is now fed from a `browserUnavailableReason` computed once in startSession and threaded, exactly like FEAT-102's dispatch reason. The same value also keeps the toolset out of `plannedMcpServers`, so a session told the browser is unavailable does not simultaneously hold 24 browser tools that cannot work. The error event stays, visible and in red — it is just `fatal: false`. This is also what the README always claimed ("the toggle degrades with a clear message") and never did.

  Third defect found while doing it: `browserBinds()` resolves the MCP shim through `requireRepoDir()`, so with the toggle on and no adapter, merely ASKING for a project's container binds threw — taking down container start, rebuild and the drift check, none of which are about the browser. Guarded in desiredBinds; and the BUG-136 root-owned-dir heal now reads socketPath() directly instead of filtering browserBinds, because gating that heal on adapter availability would have disabled the repair in precisely the state that causes it.

  VERIFIED — the user's reality, not the mechanism. End-to-end against the REAL project record (copied into a scratch data dir, free ephemeral port, scratch adapter state) with the adapter UNCONFIGURED: non-fatal error, "starting session WITHOUT the stealth browser", absent sibling mount skipped, container recreated dropping the now-unexpected stealth binds, turn-end success, resultText "PONG". The same run before the fix died at "container isolation unavailable". Converse with the adapter configured: browser armed lazily, socket ready, no Chrome, PONG. And on the LIVE server, with the browser toggle temporarily off: PONG — proving the availability gate is the sole blocker there; the setting was restored to enabled immediately after (confirmed by re-reading the live API).

  The end-to-end run is what caught the second `browserBinds` call site. Unit assertions reported 20/20 green on a tree that still could not start a session — the first version of the D section also hid two checks in an `else` branch that never ran. Both are fixed: every call site is graded, always.

  Suite: verify-bug-152 25/25 (24 when no adapter checkout is configured — the converse case skips honestly). Must-FAIL on the exact pre-fix tree: 11 failures. Anti-regressions: verify-browser-close-command 39/39 (one assertion updated — it pinned the literal call text, which this change necessarily alters; the property it guards is unchanged and still asserted), verify-bug-151-playwright-first 61/61. verify-arch-007-lazy-browser fails identically on the pre-fix baseline and on this tree (harness cannot reach the daemon's TCP port) — pre-existing, not caused here, and not investigated.

  `npm run gate` exit 0, read directly. It first caught a private project name and a home path in the new verify script; scrubbed, and the script now takes the adapter path from the environment rather than baking one.

  STILL OPEN / HANDOFF. The live server is still running the pre-fix code with no adapter env, so the affected project is still broken IN THE UI until the service is restarted. Restart is owed for this and for other reasons; whoever does it should confirm afterwards that a session in that project both starts and has its browser back.

  Symptom of a deeper design flaw? Yes, arguably — an optional per-project tool could veto session start at all, and the same shape exists wherever a start-time capability check throws rather than records. Worth an ARCH ticket on "optional capabilities degrade, never refuse" if it recurs a third time; not filed unilaterally.
