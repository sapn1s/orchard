# FEAT-051 — Integrations chips in the topbar: attached MCP tools visible like browser extensions

- **Status:** VERIFIED (2026-08-11) — live/planned chips from session-init.tools ground truth; codex MCP-off honesty; when-to-use lines.
- **Area:** claude-station UI (crown/topbar) + a minimal additive server field
- **Reported:** 2026-08-06 by user ("the mcp list should appear top like browser plugins show them — like apps")
- **Related:** FEAT-025 (tool toggles + `plannedMcpServers` seam), FEAT-042/FEAT-040 (crown chip conventions), FEAT-037 P3 / FEAT-045 (capabilities honesty, codex MCP-off)

## Goal
A compact "integrations strip" in the crown — one small chip per ATTACHED capability
for the current session/project (like browser extension icons): Serena (LSP),
Playwright, Browser daemon, plus the provider's MCP honesty (codex: MCP off).

## Requirements
- Shows what is ACTUALLY attached for the running session — ground truth from the
  real `mcpServers` plan the session was handed (FEAT-025 `plannedMcpServers()`
  output, post capability-gating), never just the toggle setting. Pre-launch, show
  what WOULD attach per project settings, visually distinct "planned" (hollow) vs
  "live" (filled/moss glyph), matching the greyscale/moss conventions.
- Click a chip → opens the drawer's Integrations group (existing surface — no new
  settings UI).
- Hidden entirely when nothing is attachable/attached; ellipsize/overflow safely on
  narrow viewports; hairline/greyscale, no new colors.
- If the server doesn't expose the per-session attached list, add the minimal
  additive field (effective-config or start ack) sourced from the plannedMcpServers
  truth; justify the seam.

## Verification (§C, non-vacuous, must FAIL pre-change)
Playwright: chips render for a project with serena on (default) + playwright toggled
on; toggling playwright off in the drawer removes its chip (planned state); a LIVE
session shows live-state chips matching the real attach; codex shows the MCP-off
honesty; chip click opens the drawer Integrations; narrow viewport no jank.
`verify:ui --offline` 3/3, `verify:tool-toggle` 13/13, `verify:model-chip`,
`typecheck`. Screenshots `docs/bugs/assets/FEAT-051-*.png`. Never touch :4317;
scratch ports; kill by pid. No package.json edit (report entry instead). No commit.

## Activity log (APPEND-ONLY)
### 2026-08-06 — build agent
- Filed per orchestrator dispatch (INDEX row is the orchestrator's). Building now.

### 2026-08-09 — orchestrator (scope addition: when-to-use clarity)
User question: "is our browser vs playwright overlapping? should we remove ours?" — answered NO,
they are complementary; but the DISTINCTION is undocumented in the UI, which is the real gap.
Verified from source before answering:
- `stealth-browser` (ours, `src/server/browser.ts` → external `stealth-browser-mcp` repo):
  per-project PERSISTENT profile (`profileDir(project)`), stealth-hardened, real browser →
  logged-in sessions, bot-protected sites, research/scraping with real accounts.
- `playwright` (`@playwright/mcp` via npx, `tools.ts:54`): EPHEMERAL, `--headless`, clean profile,
  structured snapshots → deterministic UI testing / repeatable automation. Not stealthy by design.

Add to this ticket's scope: each integration chip (and the drawer's Integrations rows) carries a
ONE-LINE when-to-use description — stealth = "real profile, stays logged in, survives bot checks";
playwright = "clean headless browser for repeatable UI tests"; serena = "symbol-level code
navigation (LSP)". Keep it terse; no paragraphs in the UI. Hover/title is fine for the chip, the
drawer row can carry the line inline.

### 2026-08-11 — build agent (UI batch with FEAT-053 + FEAT-054) — built + verified
- **Changed:**
  - `public/index.html` — `#integStrip` inside `#seal` (before the separator), hidden by
    default.
  - `public/app.js` — `paintIntegrations()` + `INTEG_META` (the three when-to-use one-liners
    verbatim from this ticket's scope addition, carried on each chip's hover title);
    `plannedServers()` mirrors `plannedMcpServers()`'s exact rules client-side
    (browser.enabled; serena default ON; playwright default OFF) for the PRE-LAUNCH hollow
    state; `liveAttachedServers()` parses `mcp__<name>__…` out of `state.liveTools` — which
    is `session-init.tools`, the CLI's OWN report of the real attach, now stored on the
    state and cleared with the socket. Live chips render filled (`data-live="true"`, moss
    glyph); planned hollow (dashed hairline). Codex honesty: provider `openai` (planned) or
    `capabilities.mcpConfig === false` (live) renders the single "⌬ MCP off" chip instead.
    Chip click → `drawer.open('settings', {focus:'integrations'})` (FEAT-054 seam). Strip
    hidden entirely when nothing attaches. Repainted from `paintCrown`, `session-init`,
    `effective-config`, and socket close.
  - `public/lib/drawer.js` — the Integrations rows carry the same one-liners inline
    (`.use1` under Browser and via `spec.use` on the Serena/Playwright toggle rows).
  - `public/styles.css` — `.integ`/`.ichip` (greyscale hairline, moss only for live, no new
    hue); narrow viewports drop labels to glyphs.
- **NO server seam was needed:** the ticket allowed a minimal additive field if the server
  didn't expose the attached list — it already does, twice: `session-init.tools` names every
  really-attached server's tools (stronger than the plan: it is the CLI's own post-attach
  report), and `capabilities.mcpConfig` carries the codex MCP-off truth. `agent-bridge.ts`/
  `index.ts` (BUG-043's fixer's files) were not touched.
- **Verified** — NEW `scripts/qa/FEAT-051-integrations-chips.spec.ts` PASS (real scratch
  server + real brave; the live leg is a REAL haiku session): planned serena chip hollow +
  no playwright chip; drawer toggle adds/removes the playwright chip and turning everything
  off hides the strip entirely; all three one-liners on hover AND inline in the drawer;
  provider→openai shows the MCP-off chip; the LIVE leg drives TWO turns (BUG-035 ground
  truth: serena can still be starting during turn one; `session-init` re-fires with the
  settled attach) and asserts the strip equals EXACTLY the live `mcp__*` set, all chips
  `data-live=true`, serena genuinely attached; chip click lands on the drawer Integrations
  group; 880px viewport drops labels, no horizontal overflow.
  **Proven MUST-FAIL-PRE-CHANGE** (batch files stashed → fails at `#integStrip` not found).
  Anti-regressions: `verify:ui -- --offline` 3/3 · `verify:tool-toggle` 13/13 ·
  `verify:model-chip` PASS · `typecheck` clean.
  Screenshots: `docs/bugs/assets/FEAT-051-planned.png`, `FEAT-051-live.png`,
  `FEAT-051-codex-mcp-off.png`.
- **package.json entry for the orchestrator to add:**
  `"verify:feat-051-chips": "playwright test scripts/qa/FEAT-051-integrations-chips.spec.ts"`
- **Known honest gap (stated, not hidden):** a REATTACHED live session whose `session-init`
  this tab never saw keeps the planned (hollow) rendering rather than inventing a live
  claim — the live list rides only the init event today. If reattach-backfill ever carries
  the tool list (BUG-020's seam), fold it in.
- **Closing assessment:** goal met (actual-attach ground truth, planned vs live distinct,
  codex honesty, deep-link click, hidden-when-empty, one-liners). No deeper design flaw:
  the one-source-of-truth attach decision (`plannedMcpServers`) stayed server-side and the
  UI only mirrors its inputs pre-launch and the CLI's own report live.
