---
sources:
  - src/server/browser.ts
  - scripts/verify-browser.mjs
  - docs/CONVENTIONS.md
  - docs/bugs/FEAT-025-serena-lsp-mcp-tier.md
  - .mcp.json
  - docs/prompts/ROUTING.md
  - src/server/runtime/claude-runtime.ts
  - src/server/runtime/codex-runtime.ts
---
# Integrations: browser, Serena, providers

Orchard attaches extra capabilities to sessions and routes whole tasks across a
mixed model fleet. Three integrations matter, and two of them are commonly
confused — so read the browser section first.

## Browser: two DIFFERENT capabilities

Orchard uses a browser in two unrelated ways. They are not the same tool, not the
same binary role, and are never used for the same purpose.

### 1. Browser for UI testing (drives Orchard's own dashboard)

The verify suites launch a **scratch server on a free ephemeral port** and drive
the dashboard's own UI with a **headless Chromium/brave** (and Playwright specs
under `scripts/qa/`). This is how a change is proven in the real app: click the
toggle, reload, assert the stored setting survived.

- **What it is:** a test harness pointing a headless browser at Orchard's UI.
- **When it's used:** verification/QA only — `verify:ui`, Playwright specs, the
  UI-facing checks in `scripts/verify-browser.mjs`.
- **Ports:** never a fixed port. Each suite calls the OS for a free port
  (`freePort()` → `listen(0)`); an env var can pin it, but the default is
  collision-proof so two suites can run at once. See `~/projects/orchard/scripts/verify-browser.mjs`.

### 2. Stealth browser for net browsing (a tool the AGENT uses)

A separate, per-project **stealth / anti-detection browser** that a running agent
uses to *browse the live web* — reaching sites that block plain HTTP clients. It is
attached to a session as an MCP integration; tools arrive as
`mcp__stealth-browser__*` (e.g. `browser_navigate`, `browser_read`,
`browser_wait_for`). Source: `~/projects/orchard/src/server/browser.ts`.

- **What it is:** a real Chrome, run on the **host** (never inside a container —
  containerised Chrome leaks the very fingerprints these sites detect), managed by
  a daemon per project. A containerised session reaches it through **one
  bind-mounted unix socket**; the daemon binds no TCP port, so `--network none`
  containers still work and there is no network path to the browser.
- **When it's used:** at agent runtime, opt-in per project (`settings.browser.enabled`),
  when a task needs the live web behind bot-walls. The verify harness proves it by
  fetching a Cloudflare-gated page (Indeed) that plain `curl` gets a bare `403` on.
- **Isolation:** every path derives from `project.id` alone and is re-derived per
  call; project A can never be handed project B's socket. `stop` must *prove* Chrome
  is gone — it refuses to report "stopped" if an orphaned Chrome survives
  (`ORPHANS REMAIN`).

**The distinction in one line:** capability #1 is *us testing our dashboard*;
capability #2 is *the agent going out onto the web*. Different binaries' roles,
different lifecycles, different reasons.

## Serena: the attachable LSP symbol tier (FEAT-025)

Serena (`oraios/serena`) is an attachable **MCP server that gives an agent
LSP-backed, symbol-level code tools** instead of grep-plus-read-whole-file. It runs
per project via `uvx … serena start-mcp-server --context claude-code --project <hostPath>`;
Orchard auto-provisions the TypeScript language server on first start. Tools arrive
as `mcp__serena__*`. Config lives in the repo `.mcp.json` (a `serena` entry — do not
depend on it being present in every project; Orchard also attaches Serena directly
per the per-project toggle, default-ON for this repo).

- **What it is for:** symbol-level navigation — `get_symbols_overview` (map a file's
  symbols), `find_symbol` (jump to a definition), `find_referencing_symbols` (every
  reference, each attributed to its *enclosing* symbol), plus symbol-precise edits
  (`replace_symbol_body`, `insert_after_symbol`/`insert_before_symbol`).
- **When to prefer it over grep:** on **large files** and for anything symbol-shaped
  — definitions, references-with-context, precise edits. Proven a real win on
  Orchard's 1500–2100-line server files: more precise and fewer tokens than reading
  whole files.
- **When grep still wins:** raw string / log / comment / non-symbol text. (And
  `ast-grep` complements both — symbols vs syntactic shapes.)

Sources: `~/projects/orchard/docs/CONVENTIONS.md` (the "prefer symbol/LSP tools"
note), FEAT-025 (`~/projects/orchard/docs/bugs/FEAT-025-serena-lsp-mcp-tier.md`), and
the `serena` entry in `~/projects/orchard/.mcp.json`.

## Providers: the mixed Claude + GPT fleet

Both subscriptions (Anthropic + ChatGPT) are meant to be sweated **together**, not
as alternates. A Claude orchestrator's in-process subagents can never be GPT — so the
dispatch unit is the whole **orchestrated task**: route a task to the
stronger/cheaper provider and consume its result. Full guidance:
`~/projects/orchard/docs/prompts/ROUTING.md`; runtimes in
`~/projects/orchard/src/server/runtime/` (`claude-runtime.ts`, `codex-runtime.ts`).

### Core routing rules

- **Architecture / hard multi-file / novel problem shapes** → Claude Opus 5;
  escalate to Fable 5 only for frontier-hard work.
- **Math / formal reasoning** → Fable 5 first, Opus 5 second — do *not* default math
  to GPT.
- **Long-context sweeps (500K–1M token reads)** → GPT (verified MRCR edge at 1M).
- **Verification / adversarial review → CROSS-PROVIDER by default:** have the *other*
  provider review finished work so correlated blind spots differ. `plan+review`
  dispatches are cross-provider by default (reviewer ≠ implementer's provider).
- **Bulk / parallel / low-stakes** → the ABUNDANT side's ladder.

### The budget reality

Capacity here is **Claude-abundant, GPT-scarce** (the OpenAI side is a $20 ChatGPT
Plus plan on rolling 5-hour windows). Spend the scarce GPT hours where a second,
differently-biased mind changes the outcome — plan review, adversarial review, a
contested second opinion — **not** on bulk volume, which goes to the abundant Claude
side. Route by skill first, then break ties with this budget rule. (This is
configuration, not physics — re-check it when the plans change.)

### Dispatching to the other provider

From any orchestrator session, via Bash (`scripts/dispatch.mjs`):

```
npm run dispatch -- --provider openai [--model <m>] [--sandbox workspace-write] "task prompt"
```

Final result on stdout, progress on stderr; the run is recorded into Orchard's
transcript history like any session. The sandbox defaults to **read-only** — opt into
`--sandbox workspace-write` only when the task must write. A symmetric Claude-side form
exists: `--provider anthropic --model opus "…"`.
