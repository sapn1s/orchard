```orchard-ticket
{
  "id": "BUG-135",
  "type": "bug",
  "title": "a tool enabled mid-session vanishes from the UI instead of pending",
  "summary": "Playwright was enabled for a project 33 minutes after that project's session launched. mcpServers is baked in once at launch, so it applied to the next session -- correct behaviour that no surface stated. The crown strip dropped the chip entirely, the drawer's explanation fired only in session scope, and the row still claimed the tool was fetched on demand.",
  "impact_if_we_wait": "Every mid-session tool enablement reads as a broken tool. The only signal is a toggle saying On against a session without it, so investigation goes to provisioning and pinning -- as it did here -- instead of the one UI truth that the attach is fixed at launch.",
  "current_need": "Landed. The open question it raises, not decided here: whether a running session should be able to re-attach MCP servers instead of being told to start a new one.",
  "severity": "medium",
  "area": "integrations strip / settings drawer (client)",
  "reported": "2026-08-20",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "done",
  "human_action": "none",
  "updated": "2026-08-20",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A tool enabled for the project but absent from the running session renders as a distinct pending state, never silently omitted.",
    "The drawer names the specific enabled-but-absent tools where the user flips the switch, in project scope.",
    "No false alarm when there is no live tool report, or when the tool is off.",
    "The Playwright row describes the pinned post-BUG-108 reality, not an on-demand fetch."
  ],
  "code_refs": [
    {
      "path": "public/app.js",
      "note": "paintIntegrations -- renders the union of planned and live; the pending state"
    },
    {
      "path": "public/lib/drawer.js",
      "note": "pendingAttachNote + integrationsGroup; the stale on-demand-fetch tail"
    },
    {
      "path": "public/styles.css",
      "note": ".ichip.pending"
    },
    {
      "path": "src/server/tools.ts",
      "note": "plannedMcpServers -- the launch-time attach decision (unchanged; confirmed correct)"
    },
    {
      "path": "scripts/qa/BUG-135-pending-attach.spec.ts",
      "note": "real click-path proof with must-FAIL"
    }
  ],
  "related": [
    {
      "id": "BUG-108",
      "relation": "see_also"
    },
    {
      "id": "FEAT-055",
      "relation": "see_also"
    },
    {
      "id": "FEAT-051",
      "relation": "see_also"
    },
    {
      "id": "BUG-088",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
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

# BUG-135 — a tool enabled mid-session vanishes from the UI instead of pending

## Symptom
A session opened for a project had no Playwright MCP tools, although Playwright was enabled for that
project. Reported as a missing tool.

## The fact, established before theorising
Playwright **was** enabled: the registry carries `tools: {serena: true, playwright: true}` for that
project, `isolation: "direct"` (so nothing about containers is involved), and the session's own
transcript shows 21 `mcp__serena__…` tool names and zero `mcp__playwright__…`. Serena arrived;
Playwright did not. So this was never "it was never enabled".

## Not the pinned path (BUG-108 refuted as the cause)
The lead was that BUG-108's pinned absolute path might not resolve inside the session's environment.
It resolves fine. `plannedMcpServers()` called on the REAL registry record emits
`<data-dir>/provision/bin/playwright-mcp --headless --executable-path <host brave>`, that binary
reports `Version 0.0.79`, and a real MCP `initialize` + `tools/list` against that exact command
returns the full `browser_*` tool set. **The tool was never broken, and BUG-108's open
container-browser decision is not implicated** — this project is `direct`, not containerised.

## Diagnosis — the attach is fixed at launch, and nothing said so
Timestamps settle it. The session launched at 12:18:31. The project's `updatedAt` is 12:51:10 — the
user turned Playwright on **33 minutes after the session started** — and the session's last message
is 12:51:46, so they were still in it.

`mcpServers` is computed once, by `plannedMcpServers()` in `AgentSession`'s constructor, and handed
to the SDK at launch. Enabling a tool mid-session therefore changes the NEXT launch and nothing about
the running one. That behaviour is correct. The defect is that three surfaces all declined to say it:

1. **The crown strip dropped the chip entirely.** `paintIntegrations()` rendered the live report
   *instead of* the plan once a session was live (`names = live ? [...live] : plannedServers(p)`), so
   a tool enabled mid-session was not shown as anything — it simply was not there.
2. **The drawer's explanation was scoped to the wrong place.** The "decided when a session launches
   … a running session can't attach or detach them" note fired only when `readOnly` (session scope),
   where the switches are disabled anyway. In **project** scope — where the user actually flips the
   switch — there was no note at all, and the row read "On. This project's sessions can drive a real
   browser", present tense.
3. **The Playwright row still described the pre-BUG-108 world.** Its tail said *"Fetched on demand
   the first time a session uses it"*. BUG-108 removed the fetch; it is now a pinned local install
   attached at launch. That sentence told the user, in the product, to expect the tool to turn up
   mid-session. It does not.

## Fix
- `paintIntegrations()` renders the UNION of planned and live. A tool that is enabled for the project
  but absent from the running session's own report is a third state, `pending` — a dimmed dashed chip
  whose hover says it is enabled here, not in this session, and that a new session is what brings it.
  The inverse (attached but no longer planned) stays `live`, because the running session really does
  still have it.
- `pendingAttachNote()` in the drawer names the specific tools that are enabled here and missing
  there, in project scope. It returns nothing unless a live session actually reported a tool list, so
  no session / a reattach whose init we never saw / a foreign selection (routed through the BUG-106
  `dockLiveTools` gate) cannot invent a discrepancy; and a session reporting zero MCP tools is left to
  the provider group's existing Codex "MCP off" honesty rather than double-reported.
- The stale "fetched on demand" tail is replaced with what BUG-108 actually made true.

## Verification
`scripts/qa/BUG-135-pending-attach.spec.ts` (1/1, 2.7s, no model) drives the real click-path against
a scratch server on a free port, using the reported session's OWN transcript-extracted tool list and
the real registry tool values. Must-FAIL proof: against pre-fix `public/`, the Playwright chip count
is **0** — it vanished, exactly as the user reported — and the note is absent; post-fix the chip is
present, `data-pending="true"`, and the note names Playwright without slandering Serena, which really
did attach. `npm run gate` PASS exit 0 (it caught a private project name in a code comment on the
first run, and that comment was rewritten).

Independent clean-room verification was waived by the user for this fix. This is a client-side
honesty change to a strip and a drawer note; no session-lifecycle, security or data path is touched.

## Deliberately not decided here
Whether a running session should be able to re-attach MCP servers, rather than being told to start a
new one. That is a feature decision about session lifecycle, not a bug fix, and it is not taken here.

## Noticed while working, not fixed
`scripts/qa/FEAT-051-integrations-chips.spec.ts` already fails on unmodified `main`, at leg 4 (the
Codex-honesty reload): `window.__station` is undefined after `page.reload()`. Confirmed pre-existing
by stashing this ticket's changes and re-running — identical failure. Untouched here.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-20 — user
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-08-20 — worker
- **Landed:** Landed in cdeb126. The lead (BUG-108's pinned path unreachable in a session) is REFUTED: the project is direct-isolation, the pinned binary answers a real MCP tools/list at the exact planned path, and BUG-108's open container-browser decision is not implicated. The real cause was a 33-minute gap between session launch and the toggle, plus three UI surfaces that never said the attach is fixed at launch.
