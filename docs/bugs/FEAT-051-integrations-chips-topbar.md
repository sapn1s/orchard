```orchard-ticket
{
  "id": "FEAT-051",
  "type": "feature",
  "title": "Attached integrations were invisible in the session topbar",
  "summary": "The topbar now shows a small chip for each integration attached to the current session, drawn from what the session was actually handed rather than the toggle settings. Chips before launch look distinct from chips on a running session, a provider running without integrations says so plainly, and clicking a chip opens the existing integrations group in the drawer.",
  "impact_if_we_wait": "People could not tell which integrations a session actually had without opening settings and inferring it. Bounded: this was visibility only, and attachment itself always worked as configured.",
  "current_need": "Nothing is outstanding. The interface and toggle suites both passed on the shipped chips, and the standing type check stayed clean.",
  "severity": "medium",
  "area": "Session topbar integrations",
  "reported": "2026-08-06",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-11",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Chips reflect what the running session was actually handed, not the toggle setting",
    "Before launch, chips show what would attach and read as distinct from live",
    "Turning an integration off in the drawer removes its chip",
    "A provider that runs without integrations shows that honestly",
    "Clicking a chip opens the integrations group in the drawer",
    "The strip is hidden when nothing is attachable and survives a narrow viewport"
  ],
  "code_refs": [
    {
      "path": "docs/bugs/assets/",
      "symbol": null,
      "note": "screenshots captured as FEAT-051-*.png"
    }
  ],
  "related": [
    {
      "id": "FEAT-025",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-037",
      "relation": "see_also"
    },
    {
      "id": "FEAT-040",
      "relation": "see_also"
    },
    {
      "id": "FEAT-042",
      "relation": "see_also"
    },
    {
      "id": "FEAT-045",
      "relation": "see_also"
    },
    {
      "id": "FEAT-054",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": true,
    "Migration and rollback": false,
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-051-integrations-chips-topbar.md",
    "sha256": "93518c495ae4d384ae1061760d52f649c4c7bcab4a4e4726b272e04e8ef77589",
    "bytes": 7568,
    "original_title": "Integrations chips in the topbar: attached MCP tools visible like browser extensions",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head: the ground-truth requirement, the planned-versus-live distinction, the click target, the hidden and narrow-viewport rules, and the additive server field are all present.",
    "dropped": [
      "the browser-extension analogy as a phrasing, kept only as the shape it describes",
      "procedural run constraints already standing in the project agreement"
    ]
  }
}
```

# FEAT-051 — Attached integrations were invisible in the session topbar

## Diagnosis

### What was missing

Attachment was already gated and planned per project, but nothing surfaced the result. The only reachable signal was the toggle setting, which is the intent rather than the outcome: a capability can be toggled on and still be gated away for the running session. The requested shape was a compact strip of one chip per attached capability, read like browser extension icons.

## Evidence

The interface suite passed 3 of 3 and the tool-toggle suite passed 13 of 13 on the shipped chips. The standing type check reported clean. Screenshots were captured under `docs/bugs/assets/` as `FEAT-051-*.png`. A model-chip suite and a chips-specific suite were named in the plan; no result was recorded for either, so they are a plan mention rather than a run.

## Implementation notes

Chip state is derived from the session-init tool list handed to the session — the gated plan output from FEAT-025's `plannedMcpServers()` seam — so live chips are ground truth rather than a restatement of settings. Pre-launch chips render hollow against filled live chips, staying inside the existing greyscale and moss conventions from FEAT-042 and FEAT-040 without introducing new colors. A provider that runs with integrations off is stated as such, matching the capabilities-honesty line from FEAT-037 and FEAT-045. Chips carry a short when-to-use line. Clicking one routes to the drawer's existing integrations group; no new settings surface was added. Constraints held during the work: scratch ports only, the primary service port untouched, no dependency-manifest edit.

## Verification plan

Render chips for a project with the language-server integration on by default plus the browser-automation one toggled on. Toggle the browser one off in the drawer and assert its chip disappears from the planned state. Start a real session and assert the live chips match the actual attach. Assert the integrations-off provider renders its honesty line. Click a chip and assert the drawer opens on the integrations group. Narrow the viewport and assert the strip ellipsizes without jank.

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
