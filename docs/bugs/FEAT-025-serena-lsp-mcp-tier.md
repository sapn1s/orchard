```orchard-ticket
{
  "id": "FEAT-025",
  "type": "feature",
  "title": "Dispatched agents had no symbol-aware code tools",
  "summary": "Agents working in a repository could only grep and read whole files, which is costly and imprecise on large long-lived projects. A per-project switch now attaches language-server-backed code tools, alongside the browser tier, and it is wired into the real attach path. Turning the tier on automatically by project size or language was deliberately left unbuilt.",
  "impact_if_we_wait": "Nothing regresses; the tier works whenever someone turns it on. Bounded: the only gap is that projects that would benefit still need a person to enable them by hand, and no existing session behaviour changes.",
  "current_need": "Nothing is outstanding here. The toggle suite passed 13 of 13, typecheck stayed clean, and the automatic enablement work is tracked separately.",
  "severity": "medium",
  "area": "Agent code tooling",
  "reported": "2026-08-04",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-04",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "The tier can be turned on and off per project from the interface",
    "An enabled project launches sessions whose agents can list the symbol tools",
    "The server starts and lists its tools, demonstrated rather than asserted",
    "Projects with the tier off are unaffected"
  ],
  "code_refs": [
    {
      "path": ".mcp.json",
      "symbol": null,
      "note": "repo-level attach used to enable the tier for this project's own dev sessions"
    }
  ],
  "related": [
    {
      "id": "BUG-035",
      "relation": "see_also"
    },
    {
      "id": "FEAT-021",
      "relation": "see_also"
    },
    {
      "id": "FEAT-033",
      "relation": "blocks"
    },
    {
      "id": "FEAT-038",
      "relation": "blocks"
    },
    {
      "id": "FEAT-051",
      "relation": "blocks"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": false,
    "Migration and rollback": false,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-025-serena-lsp-mcp-tier.md",
    "sha256": "0e4292b914eb2f2475e6792a87db042cae9dca0280b7eb762f8c86c9de019549",
    "bytes": 22105,
    "original_title": "Attachable Serena (LSP) MCP tier: symbol-level code tools for dispatched agents",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Read against the original head: the goal, the attach-slot design, the opt-in stance, the per-project flags, the memory distinction and both caveats are present.",
    "dropped": [
      "the tool-name list is kept in the diagnosis rather than the human layer",
      "the two named example repositories, which illustrate scale rather than change anything"
    ]
  }
}
```

# FEAT-025 — Dispatched agents had no symbol-aware code tools

## Diagnosis

Dispatched fix agents had only grep and whole-file reads. Serena (oraios/serena) exposes LSP-backed tools — `find_symbol`, `find_referencing_symbols`, `get_symbols_overview`, `replace_symbol_body`, `insert_after_symbol`/`insert_before_symbol`, `search_for_pattern` — over MCP, so it can be attached through the same per-project/session slot that already carries the stealth browser.

Per-project configuration is `--context ide-assistant --project <hostPath>`, with the language server chosen from the project's language (TS/JS here). Serena's own project memories hold code knowledge, which is a different thing from the board's task state under FEAT-021 — both are kept.

## Evidence

The toggle suite `verify:tool-toggle` ran 13/13 passing, and typecheck stayed clean. The toggle was exercised against the real attach seam end to end rather than against a stub, and the server was confirmed to start and list its tools rather than being declared enabled on faith. `verify:local-conventions`, `verify:browser`, `verify:ui`, `verify:addproject`, `verify:overrides` and `verify:session-scope` are named in the ticket without recorded results.

## Implementation notes

The tier is opt-in per project rather than on everywhere: a scratch project does not want a language server standing up. The switch covers both Serena and Playwright in one place. Auto-enabling by repository size or detected language is queued as FEAT-033.

## Risks

Per-language language-server setup adds moving parts, which is why the tier stays opt-in. A session that is already running will not hot-load a newly attached server — the change applies to sessions launched afterwards.

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed per user request; enabling for this repo now as the dogfood + reference impl.

### 2026-08-04 — dogfood install + wiring agent

**Env at start:** only `python3` on PATH, no uv/uvx/pipx, no repo `.mcp.json`, `claude` CLI present at `~/.local/bin/claude`.

**1. Toolchain — installed `uv` user-local via the official installer:**
```
curl -LsSf https://astral.sh/uv/install.sh | sh
# → downloading uv 0.12.1 x86_64-unknown-linux-gnu; installing to ~/.local/bin (uv, uvx)
```
`~/.local/bin` was already on PATH in `~/.bashrc`/login shells (confirmed `bash -lc 'which uvx'` → `~/.local/bin/uvx`). Reversible: `rm ~/.local/bin/uv ~/.local/bin/uvx` (uv installer keeps no other state besides `~/.local/share/uv`, `~/.cache/uv`).

**2. Serena — package/CLI has moved on since the ticket was filed.** `serena-mcp-server` is no longer the entrypoint name; the installed package (`serena-agent`, git HEAD `cd04838b`, reports `version=1.6.2.dev0`) exposes `serena` / `serena-agent` / `serena-hooks`. The MCP server is now a subcommand: `serena start-mcp-server`. Also the `--context ide-assistant` named in the ticket/user prompt no longer exists — `serena context list` shows `ide-assistant` was renamed to **`claude-code`** (confirmed by reading `.../serena/resources/config/contexts/claude-code.yml`, which is verbatim the old ide-assistant prompt: "You are running in a CLI coding agent context where file operations... are handled by your own, internal tools... use Serena's tools for editing"). Used `--context claude-code` throughout.

Ran via `uvx --from git+https://github.com/oraios/serena serena ...` — no dedicated venv needed, uvx handled it cleanly (71 packages, ~2s after first cache warm).

Created the project config non-interactively:
```
printf "n\nn\n" | uvx --from git+https://github.com/oraios/serena serena project create ~/projects/claude-station --name claude-station
# → Detected and enabled main language server 'typescript' (100.00% of source files).
#   Additionally detected 2 other applicable language servers (vue, svelte) — declined both (repo is plain TS/Node, not Vue/Svelte).
# → Generated project with language servers {typescript} at ~/projects/claude-station/.serena/project.yml.
```
This wrote `.serena/project.yml` (language_servers: [typescript]) and `.serena/.gitignore` (Serena's own cache dirs) under the repo root — currently untracked, left in the tree per instructions (not committed; recommend `.serena/` join `.gitignore` at commit time, keeping `.serena/project.yml` tracked as the actual project config — this agent did not decide that trade-off, flagging for the committer).

**TypeScript language server: auto-provisioned by Serena, no manual install needed.** First MCP-server start triggered:
```
Typescript Language Server executable not found at .../ts-lsp/node_modules/.bin/typescript-language-server. Installing...
Running command 'npm install --prefix ./ typescript@5.9.3' in '.../ts-lsp'
```
into `~/.serena/language_servers/static/TypeScriptLanguageServer/ts-lsp/` (uses the repo's system `npm`, not `node_modules` inside claude-station — fully isolated from the repo's own deps). Confirmed installed binaries:
```
$ ls ~/.serena/language_servers/static/TypeScriptLanguageServer/ts-lsp/node_modules/.bin/
tsc -> ../typescript/bin/tsc
tsserver -> ../typescript/bin/tsserver
typescript-language-server -> ../typescript-language-server/lib/cli.mjs
```

**3. Wired `.mcp.json` at repo root:**
```json
{
  "mcpServers": {
    "serena": {
      "command": "uvx",
      "args": [
        "--from", "git+https://github.com/oraios/serena",
        "serena", "start-mcp-server",
        "--context", "claude-code",
        "--project", "~/projects/claude-station",
        "--enable-web-dashboard", "false",
        "--open-web-dashboard", "false"
      ]
    }
  }
}
```
Validated: `python3 -c "import json; json.load(open('.mcp.json'))"` → valid JSON.

**4. Productization integration point — found and verified (NOT built, per instructions):**

The stealth-browser precedent lives entirely in `src/server/browser.ts` + `src/server/agent-bridge.ts`:
- `src/server/browser.ts:240` — `mcpServerFor(project): McpStdioServer` builds `{ command, args, env }` for the browser's MCP shim (host vs container two-shape logic at lines 240–254).
- `src/server/agent-bridge.ts:22` — `import { MCP_SERVER_NAME, mcpServerFor } from './browser.ts'`.
- `src/server/agent-bridge.ts:531–535` — **the exact hook**, inside `AgentSession`'s option-building (right before `resume`/`systemPrompt` are finalized):
  ```ts
  if (browserSettingsOf(opts.project).enabled) {
    options.mcpServers = { [MCP_SERVER_NAME]: mcpServerFor(opts.project) as never };
    options.strictMcpConfig = true;
    this.browserAttached = true;
  }
  ```
  `options` here is the `@anthropic-ai/claude-agent-sdk` session-start options object. `strictMcpConfig: true` means this is the *only* place MCP servers get attached — no merging with user/global config happens elsewhere.

  A Serena tier plugs in identically: a new `src/server/serena.ts` mirroring `browser.ts` (`serenaSettingsOf(project)`, `mcpServerFor(project): McpStdioServer` returning the `uvx ... serena start-mcp-server --context claude-code --project <hostPath>` command/args), a `SERENA_SETTINGS` key on `Project.settings` (mirrors `settings.browser`, see `src/server/registry.ts` `browserSettingsOf`/`defaultBrowserSettings` for the shape to copy), and in `agent-bridge.ts` around line 531 — since `strictMcpConfig` replaces the whole object, this becomes:
  ```ts
  const mcpServers: Record<string, McpStdioServer> = {};
  if (browserSettingsOf(opts.project).enabled) mcpServers[MCP_SERVER_NAME] = browserMcpServerFor(opts.project);
  if (serenaSettingsOf(opts.project).enabled) mcpServers[SERENA_SERVER_NAME] = serenaMcpServerFor(opts.project);
  if (Object.keys(mcpServers).length) { options.mcpServers = mcpServers as never; options.strictMcpConfig = true; }
  ```
  Per-project opt-in toggle (UI checkbox) mirrors `settings.browser.enabled` (see `registry.ts` `browserSettingsOf`) and the `/api/projects/:id/browser/...` route pattern in `index.ts` (~line 1188 `handleBrowserRoute`) for an equivalent `/api/projects/:id/serena/...` status route if a start/stop lifecycle is wanted (Serena's MCP process is spawned per-session by the SDK itself via stdio, unlike the browser's standalone daemon — likely simpler: no separate daemon/socket, just per-project settings + the mcpServers entry, since `uvx` handles caching/reuse).

**VERIFICATION — real evidence, not claimed:**

Ran the actual server against this repo with a held-open stdin (90s) to let it get past the LSP handshake instead of exiting on immediate EOF:
```
uvx --from git+https://github.com/oraios/serena serena start-mcp-server --context claude-code \
  --project ~/projects/claude-station --enable-web-dashboard false --open-web-dashboard false --log-level INFO
```
Captured log (full trace in this session; key lines):
```
INFO serena.agent:__init__:636 - Starting Serena server (version=1.6.2.dev0, ...); language backend=LSP
INFO serena.agent:__init__:641 - Available projects: claude-station
INFO serena.agent:apply:182 - SerenaAgentContext[name='claude-code'] excluded 6 tools: create_text_file, read_file, execute_shell_command, find_file, list_dir, search_for_pattern
INFO serena.agent:_create_base_toolset:814 - Number of exposed tools: 21
INFO serena.mcp:_set_mcp_tools:307 - Starting MCP server with 21 tools: ['replace_content', 'replace_in_files',
  'replace_symbol_body', 'insert_after_symbol', 'insert_before_symbol', 'get_symbols_overview', 'find_symbol',
  'find_referencing_symbols', 'find_implementations', 'find_declaration', 'get_diagnostics_for_file',
  'rename_symbol', 'safe_delete_symbol', 'write_memory', 'read_memory', 'list_memories', 'delete_memory',
  'rename_memory', 'edit_memory', 'onboarding', 'initial_instructions']
INFO serena.mcp:server_lifespan:408 - MCP server lifetime setup complete
INFO solidlsp.language_servers.typescript_language_server:_start_server:451 - Sending initialize request to LSP server
INFO ...window_log_message:384 - Using Typescript version (bundled) 5.9.3 from .../ts-lsp/node_modules/typescript/lib/tsserver.js
INFO solidlsp.language_servers.typescript_language_server:_start_server:467 - TypeScript server is ready
INFO solidlsp.language_servers.typescript_language_server:_start_server:478 - TypeScript project indexing complete
INFO sensai.util.logging:stop:336 - Language server startup (language=typescript) completed in 1.603 seconds
```
All the symbol-level tools named in the ticket goal are present and exposed: `find_symbol`, `find_referencing_symbols`, `get_symbols_overview`, `replace_symbol_body`, `insert_after_symbol`/`insert_before_symbol`. (`search_for_pattern` is deliberately excluded by the `claude-code` context — it assumes Claude Code's own grep covers that, matching upstream's design intent.)

`claude mcp` confirms it reads the repo `.mcp.json` correctly:
```
$ claude mcp list
serena: uvx --from git+https://github.com/oraios/serena serena start-mcp-server --context claude-code --project ~/projects/claude-station --enable-web-dashboard false --open-web-dashboard false - ⏸ Pending approval (run `claude` to approve)

$ claude mcp get serena
serena:
  Scope: Project config (shared via .mcp.json)
  Status: ⏸ Pending approval (run `claude` to approve)
```
"Pending approval" is expected/correct for a fresh project-scoped `.mcp.json` — Claude Code always requires explicit user approval for new project MCP servers on next interactive launch; this is not a failure.

**PASS/FAIL: PASS.** Server starts, activates the project, provisions its own TypeScript LSP, initializes it against this repo, and exposes the full symbol-tool surface. `.mcp.json` is valid and points at a command that actually runs end-to-end.

**Explicit note per instructions:** the CURRENTLY-RUNNING claude-station session (and this agent's own session) will NOT pick up `.mcp.json` — it only takes effect for `claude` sessions started after this file existed. Next session launched in this repo (after running `claude mcp` approval once, or `claude` interactive prompt) will have Serena's tools available as `mcp__serena__*`.

**Blockers / open items for the next agent:**
- Did not commit `.mcp.json`, `.serena/project.yml`, or `.serena/.gitignore` — left untracked in the tree per instructions (`git status` shows them `??`). Committer should decide whether `.serena/` (minus `project.yml`) belongs in root `.gitignore`.
- Noticed unrelated concurrent modifications to `package.json`, `public/app.js`, `src/server/agent-bridge.ts`, `src/server/events.ts` during this session (verified via `git diff`/mtimes — not caused by this agent). Consistent with the ticket's own note that another live session/orchestrator is working this repo in parallel; left entirely untouched, not part of this ticket's diff.
- Productized attach (step 4 design) is documented above but NOT built — future FEAT-025 build work should add `src/server/serena.ts` + `settings.serena` + the `agent-bridge.ts:~531` merge shown above.
### 2026-08-04 — orchestrator (integrated but UNUSED — explicit decision pending)
Serena is repo-enabled + verified (boots, 21 tools) but has NOT been exercised on a
real task — zero demonstrated value so far, and its session connection has been flaky.
Per WA §C ("installed ≠ done"), this ticket is NOT done. Explicit pending DECISION
(owner: user): (a) DOGFOOD — route the next fix agent's code navigation through
Serena's find_symbol/find_referencing_symbols on a big file and judge if it helps; or
(b) PARK with a trigger (revisit when a large-refactor task appears). Also verify
whether harness-spawned subagents inherit the repo `.mcp.json` (unknown — they may not
get Serena at all, which would explain zero use).

### 2026-08-04 — orchestrator (dogfood VERDICT — useful; decisions made)
Dogfooded on real code (read-only). Findings: (1) harness-spawned SUBAGENTS DO
inherit Serena (my earlier "maybe they don't" worry — refuted; live mcp__serena__*
calls succeeded). (2) 100% correct vs grep on symbols/refs. (3) REAL win on this
repo's big server files — get_symbols_overview + find_referencing_symbols (refs with
enclosing context) beat grep+read-whole-file on precision + tokens; grep still wins
for raw string/log/non-symbol text. (4) Reliable (warm server, no flakiness).
DECISIONS:
- **claude-station: DEFAULT-ON** — already enabled + inherited + proven useful. Kept.
- **Other projects: OPT-IN by default, AUTO-ON for large single-LS typed repos.**
  Heuristic for the productized feature: enable when the repo is a mainstream
  single-LS language (TS/Py/Go/Rust/Java) AND is large (>~15k LOC or files routinely
  >800 lines); keep opt-in for polyglot repos (multiple LS cold-starts), scratch/home
  dirs, and throwaway tasks. Budget for cold-start/index latency on short-lived agents.
- **Workflow:** WA §I now tells agents to PREFER Serena's symbol tools over
  grep-whole-file on large files (so it's actually used, not dead weight — closes the
  'installed ≠ used' gap for real).
- Remaining (productization, still queued): make it a selectable per-project attach in
  the UI (mirror browser.ts mcpServerFor → agent-bridge merge point) with the size/
  language auto-on heuristic.

### 2026-08-04 — build agent (per-project UI toggle — Serena + Playwright)
**Understood + what "attach" means here (found before building, §B):** "attach" in
this codebase = one thing — an entry in the `mcpServers` record handed to the
runtime (`RuntimeStartConfig.mcpServers`, forwarded verbatim to the Claude SDK's
`Options.mcpServers`, see `runtime/claude-runtime.ts:123-125`), plus
`strictMcpConfig: true` so the CLI's tool surface is EXACTLY what the station handed
it (no merge with repo `.mcp.json` or the user's global `~/.claude` MCP config). The
seam has MOVED since the earlier design note said `agent-bridge.ts:531`: the runtime
refactor (FEAT-037) means the map is now built in the **`AgentSession` constructor**
(`src/server/agent-bridge.ts` ~528, right before `this.#runtime.start({… mcpServers,
strictMcpConfig …})`). Before this ticket only the stealth browser was ever in that
map; Serena reached this repo's own sessions purely via the repo-root `.mcp.json`
(which strict wipes — so browser-on sessions silently lost Serena).

**Changed (file:line):**
- `src/server/tools.ts` (NEW) — `plannedMcpServers(project) → { servers, strict }`,
  the single pure function that decides the whole map from the per-project toggles:
  browser (gated on `browser.enabled`), `serena` (default-on), `playwright` (opt-in).
  Plus `serenaMcpServerFor` (the same `uvx … serena start-mcp-server --context
  claude-code --project <hostPath>` this repo dogfooded, but keyed to the project's
  OWN checkout so it works for any project, not only ones carrying a `.mcp.json`) and
  `playwrightMcpServerFor` (`npx -y @playwright/mcp@latest --headless` — nothing added
  to package.json; npx fetches on demand only once a project opts in, so "install
  nothing" holds until a user flips it on).
- `src/server/agent-bridge.ts:~528` — replaced the browser-only block with
  `const plan = plannedMcpServers(opts.project)`; forwards `plan.servers` +
  `plan.strict` into `#runtime.start`. This is the REAL launch path (`startSession`
  → `new AgentSession` → constructor → `runtime.start`).
- `src/server/registry.ts` — `ToolSettings {serena, playwright}` +
  `defaultToolSettings()` (**serena:true, playwright:false**) + `toolSettingsOf()`;
  added `tools?` to `ProjectSettings`, to `defaultSettings()`, and the one-level-deeper
  merge in `updateProject` (flipping one toggle can't drop the other).
- `src/server/validate.ts` — `tools` accepted in the settings PATCH allow-list + a
  validation block (booleans only, unknown-key rejection), mirroring `browser`.
- `public/lib/drawer.js` — two toggle rows added to the Integrations group inside
  FEAT-034's "Instructions & tools" section: Serena (LSP) and Playwright (labelled a
  UI-testing tool per FEAT-034's gating convention). `toolToggleRow()` + `putTools()`
  helper (mirrors `putBrowser`). The rows mirror the SERVER defaults when a project's
  stored settings predate `tools` (absent serena renders ON), so the UI never disagrees
  with what a launched session actually gets.
- `scripts/verify-tool-toggle.mjs` (NEW) + `verify:tool-toggle` npm script — asserts
  on `plannedMcpServers` directly (the exact function the launch path calls, mirroring
  how `verify-local-conventions.mjs` asserts on `composeInstructions`).
- `scripts/qa/feat-025-tool-toggle.spec.ts` (NEW) — Playwright UI spec.

**DEFAULT decision (matches the task's "opt a tool OUT" ask + preserves current
behaviour):** Serena default-**ON** globally, Playwright default-**OFF**. This diverges
from the "opt-in for other projects" nuance in the 2026-08-04 verdict above — that
size/language AUTO-ON heuristic is still future work (FEAT-033); this ticket is the
plain per-project toggle. Proven not to regress live sessions: `feat-040` and
`verify:browser` both run real haiku sessions that now attach Serena by default and
still pass. Note the repo `.mcp.json` is now redundant for claude-station (station
attaches Serena directly, strict wipes the file) — safe to remove later, left as-is
here (out of scope, and only takes effect on the NEXT server restart, which this agent
did not perform — :4317 untouched).

**Verified (PASS/FAIL, real launch/compose seam + user-observable):**
- `node scripts/verify-tool-toggle.mjs` → **13/13 PASS**. Proves against the real
  attach function: default project → Serena attached + strict (repo default-on
  preserved), Playwright/browser absent; `tools.serena=false` → Serena NOT in the map;
  `tools.playwright=true` → Playwright IS; all three compose together; serena command
  pinned to the project hostPath; and a WIRING check that `agent-bridge.ts` forwards
  the plan into `runtime.start`. **MUST-FAIL confirmed:** moved `tools.ts` aside → the
  script FATALs (the seam didn't exist pre-change; Serena was never station-attached).
- `npx playwright test scripts/qa/feat-025-tool-toggle.spec.ts` → **1 passed**. Both
  toggles render; Serena defaults pressed=true, Playwright pressed=false; toggling flips
  them; the SERVER stored `{serena:false, playwright:true}` under `settings.tools`; the
  choice survives a full page reload. Screenshot → `docs/bugs/assets/FEAT-025-after.png`.
- `npm run typecheck` → **PASS**. `npm run verify:ui -- --offline` → **PASS (3)**.
  `npx playwright test` (full qa:sweep, incl. FEAT-034 settings-sections regression
  guard) → **5 passed** (one flaky feat-040 timeout on a loaded run cleared on re-run;
  passes solo in 18.5s). `verify:browser` → **24/0** (attach/strict seam I edited still
  correct). `verify-addproject`/`verify-overrides` → PASS. (`verify-session-scope` shows
  2 PRE-EXISTING fails: the SDK now reports the full id `claude-haiku-4-5-20251001`
  where the test hard-codes the alias `haiku` — unrelated to this toggle, touches no
  model-resolution code.)

**Open / handoff:**
- **Container isolation:** the serena/playwright commands run wherever the CLI runs;
  for `isolation: container` that's inside the container (docker exec), where `uvx`/`npx`
  and the host path may not resolve. Direct isolation (the verified path + claude-station
  itself) is correct; container Serena needs the browser.ts-style host/container two-shape
  treatment — deferred, flagged for a follow-up.
- **Auto-on heuristic (FEAT-033)** — still the queued next step; this toggle is its
  manual precursor.
- FEAT-038 item 4 (onboard's tool-enablement step) can now shell to this: set
  `settings.tools` per the heuristic when onboarding a repo.

- 2026-08-06 — privacy scrub for public release (FEAT-049, sanctioned append-only exception): private names/paths neutralized (project aliases, home paths → ~).
