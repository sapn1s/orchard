```orchard-ticket
{
  "id": "BUG-147",
  "type": "bug",
  "title": "strict MCP config silently drops the user's own MCP servers",
  "summary": "Serena defaults ON, so plannedMcpServers() always returns strict:true and every launched session is passed --strict-mcp-config. That suppresses both the repo's .mcp.json and the user's global ~/.claude MCP config. It is explained only in code comments. A user who configures an MCP server globally will find it absent from every Orchard session with no message anywhere.",
  "impact_if_we_wait": "The user concludes MCP does not work in Orchard and re-configures by hand, or gives up. The one server that IS on by default is invisible unless they inspect the launch argv, so the surface looks empty from outside.",
  "current_need": "Document the suppression where a user reads it, and surface the attached MCP set in the UI so the default is visible rather than inferred.",
  "severity": "medium",
  "area": "MCP / tools",
  "reported": "2026-08-25",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-08-25",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "A user can discover, without reading source, that Orchard replaces rather than merges their MCP config.",
    "The MCP servers actually attached to a session are visible in the UI or the session log.",
    "A globally-configured MCP server that will not reach a session is reported, not silently dropped.",
    "Provisioning state is checked before a session is handed an MCP config naming a binary that is not installed."
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

# BUG-147 — strict MCP config silently drops the user's own MCP servers

## Found by the independent verification pass on BUG-145

Verified against a REAL launched session, not a re-composition: the launched CLI argv carried

    --mcp-config {"mcpServers":{"serena":...}} --strict-mcp-config

`plannedMcpServers()` (`src/server/tools.ts:179-187`) sets `strict: Object.keys(servers).length > 0`, and serena is ON by default (`registry.ts:107-109`), so **strict is effectively always true**. Consumed at `src/server/agent-bridge.ts:1036-1052` and forwarded at `:1149-1150`.

The consequence is stated only in code comments — `tools.ts:7` and `agent-bridge.ts:1031-1034`. Nothing user-facing says it: not the guide, not PROVIDERS.md, not the settings drawer.

**This is the most likely explanation for the user's report that "MCP tools are not enabled by default."** They are enabled — serena attaches for every project, including the ones that had no Working Agreement — but the user's OWN servers are replaced rather than merged, and the one that is attached is invisible without inspecting the launch. Checked on this machine: no global `mcpServers` are configured today (`~/.claude.json`, `~/.claude/settings.json` both empty), so nothing is being lost right now. The trap is latent, and it fires the first time they add one.

## The second half: an unprovisioned data dir fails silently

Provisioning is a one-time install step. It is **not** triggered by server boot, project create, or session launch. On a fresh `CLAUDE_STATION_DATA`, `plannedMcpServers()` still emits a serena entry pointing at `hostSerenaBin()` — a path that does not exist — and the session is handed that config. Serena then fails to start and nothing reports it.

On the operator's real install the binary IS present (`<data>/provision/bin/serena`, serena-agent 1.7.0, `serena --help` exit 0), so this is latent here too. It is the shape that BUG-035 and BUG-091 already hit twice.

## Recommended, in order of value

1. Say it where a user reads it: Orchard REPLACES the MCP config; servers you configure globally do not reach an Orchard session.
2. Show the attached set per session (FEAT-051 already put integration chips in the topbar — this is the same surface).
3. If a global MCP config exists and is being suppressed, say so once, rather than never.
4. Refuse-or-warn when a planned MCP server's binary is not provisioned, instead of handing the session a config that cannot start.

## Context pack (grows — the "where to look", so no agent cold-starts)
- `src/server/tools.ts:7` (the comment that is the only documentation), `:179-187` (`plannedMcpServers`), `:63-78` (serena spec)
- `src/server/agent-bridge.ts:1031-1034`, `:1036-1052`, `:1149-1150`
- `src/server/registry.ts:107-109` (`defaultToolSettings`), `src/server/provisioning.ts:129-148` (`hostBinFor`/`hostSerenaBin`)
- Related: BUG-035 (serena missing from onboarded sessions), BUG-091 (MCP tools fail when PATH lacks user bin), BUG-107 (container projects silently lost code-nav tools for two weeks), FEAT-051 (integration chips), BUG-144/BUG-145 (the pass that found this)

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-25 — agent
- **Filed:** through the board tool; the record was validated before it was written.
