# FEAT-033 — Tool adoption pipeline (high-value integrations to dogfood, one at a time)

- **Status:** OPEN — top-3 evaluated (ast-grep + Playwright kept, Stryker parked); recommend close or keep as parking spot.
- **Area:** methodology / tooling
- **Reported:** 2026-08-04 by user (find tools that benefit long-term, like Serena)
- **Discipline:** WA §C "installed ≠ done" — adopt ONE, prove value, keep or drop; no piles of unused tools.

## In plain terms
A shortlist of developer tools to try one at a time — keeping only the ones that prove their worth, instead of
piling up unused tools. This keeps tooling deliberate rather than accumulating clutter.

The top three were already evaluated: two were adopted (a structural code-search tool and a browser-testing
tool, both now in real use) and one was parked (a test-quality checker that needs a kind of test suite we don't
currently have).

**Recommendation:** this is mostly resolved — close it, or keep it open just as a parking spot for future tool
candidates.

**What I need from you:** triage only — your call on whether it stays open.

**If you do nothing:** nothing breaks; it stays open as a low-priority design note.

> Everything below is the full research shortlist and the per-tool adoption verdicts — reference.

## Ranked shortlist (research-backed, Aug 2026)

### TOP 3 — dogfood in this order
1. **Playwright MCP** (github.com/microsoft/playwright-mcp) — HIGH.
   Accessibility-snapshot = the USER-OBSERVABLE DOM our §C rule demands; token-efficient
   (~200-400/snapshot); retires hand-written CDP-over-WS scripts. Opt-in per UI project.
   **Caveat:** MCP = the agent OBSERVES/asserts; the durable artifact that SHIPS with a
   fix is a committed Playwright `.spec.ts` (test runner), NOT a saved MCP transcript.
   Long MCP sessions go stale → flaky locators.
2. **ast-grep (CLI first)** (ast-grep.github.io) — HIGH.
   Structural (AST) search + `--rewrite`; finds SIBLING VARIANTS of a bug class ripgrep
   misses + bulk root-cause refactors (our recurring-class pain, §N). Single binary, no
   auth, default-on like Serena. CLI is mature; the ast-grep MCP is experimental (prefer CLI).
3. **StrykerJS mutation testing** (stryker-mutator.io) — MED-HIGH value / high cost.
   Objective "is the test REAL?" referee (mutation score, not coverage). Scope to the
   files a fix TOUCHED (`--mutate` glob), run as a periodic/spot gate — NOT per-fix
   global (too slow on our big files). Needs deterministic fixtures.

### Honorable mentions (opt-in, situational)
- **Context7 / Docfork** — up-to-date library docs MCP; opt-in when onboarding a fast-moving
  dep (marginal for our stable TS core; Context7 token-heavy, ~modest accuracy — Docfork is a
  lighter FOSS alt).
- **Chrome DevTools MCP** — opt-in for perf/network-class UI bugs (we already drive Brave/CDP);
  don't run alongside Playwright MCP by default (2 browser stacks + schema token cost).
- **Semgrep (+MCP)** — back-pocket for DATA-FLOW/taint-shaped bug classes ast-grep's pure-AST
  matching misses; don't run two structural engines by default.

### Considered & REJECTED (don't map to a real need)
memory/vector/knowledge-graph MCPs (conflict with files-as-source board); repomix/codebase-
packing (have external-project-I); paid docs MCPs (Nia/Deepcon — subscription unjustified for a
single-user local tool); sequential-thinking (orchestrator already structures work); Playwright
"Test Agents" (overlaps our own orchestrator); Puppeteer MCP (subsumed by Chrome DevTools MCP).

## Adoption path (prove value before keeping)
1. ast-grep CLI (cheapest proof): take one existing bug-CLASS ticket → write a pattern → find
   siblings ripgrep missed → one bulk rewrite. Default-on if it delivers.
2. Playwright MCP on one UI project: a verify-agent asserts a user-visible DOM outcome and
   emits a committed `.spec.ts`; retire a hand-written CDP script.
3. StrykerJS on one module: a mutant survives a "real" test → that single finding justifies it.

## Activity log (APPEND-ONLY)
### 2026-08-04 — orchestrator
- Filed from research. Recommend dogfooding ast-grep FIRST (cheapest, direct hit on the
  recurring-bug-class pain), then Playwright MCP, then Stryker. Awaiting user pick.
### 2026-08-04 — orchestrator (VERDICT 1/3 — StrykerJS: PARK)
Fit-check (no install performed — correctly blocked): repo has NO Stryker-compatible
runner (no Jest/Vitest/Mocha; devDeps = @types/node,@types/ws,happy-dom,typescript)
and zero unit tests — the 40+ verify-*.mjs are standalone real-browser/real-server
integration scripts Stryker can't drive. Verdict: **LOW fit / PARK, do not adopt (not
even opt-in — nothing to point it at).** Trigger to revisit: IF we add a Vitest unit
layer for the pure-logic modules (src/lib/paths.ts, src/server/validate.ts, jsonl.ts,
decisions.ts — good mutation targets), then Stryker becomes a cheap scoped spot-gate on
those files. Until then it's premature; bugs here live in the integration/session layer,
not pure functions. Nothing installed; repo untouched.
### 2026-08-04 — orchestrator (VERDICT 2/3 — ast-grep: KEEP, DEFAULT-ON)
Installed @ast-grep/cli 0.45.0 from official npm (provenance verified: publisher =
ast-grep author; user-local ~/.local, reversible; symlinked to ~/.local/bin so it's on
PATH = actually usable, not just installed). MEDIUM-to-real win vs ripgrep on bug-CLASS
hunts: excludes comment noise (12 rg hits → 6 real refs in over-commented app.js),
matched a wrapped 8-line guard a single-line rg regex MISSED, metavariable patterns
($A || liveRec || state.live) found shape-siblings without guessing spelling. Honest
non-win: single-line guards tie rg. DECISION: **KEEP, DEFAULT-ON** (cheap static binary,
no auth — like Serena), as a SUPPLEMENT to rg (rg first-line for simple hunts). Baked
into WA §I. Caveats: pattern-authoring curve; over-tight patterns silently miss (sanity-
check vs loose rg); not a data-flow engine (Semgrep stays the back-pocket).
### 2026-08-04 — orchestrator (VERDICT 3/3 — Playwright MCP + @playwright/test: KEEP, OPT-IN per UI project)
Dogfooded in scratch (official npm @playwright/test 1.62.1 + @playwright/mcp 0.0.78,
provenance verified; reused system Brave via executablePath → ZERO browser download;
:4317 untouched). HIGH win: aria snapshot ~240 tokens vs ~4400 raw outerHTML (~18x), IS
the §C "what the user perceives" surface; deletes our hand-rolled ~90-line CDP class +
manual waitFor polling (web-first assertions auto-wait); the role/name snapshot surfaced a
real false assumption (#title→breadcrumb) raw CDP would've hidden — §C paying off.
DECISION: **KEEP, OPT-IN per UI-bearing project** (not global — most repos are non-UI).
Adoption: migrate hand-CDP UI scripts to .spec.ts INCREMENTALLY as touched; NEW UI verifies
= .spec.ts. Caveats: ship the committed .spec.ts NOT an MCP transcript (refs go stale→flaky);
use ariaSnapshot()/toMatchAriaSnapshot() (page.accessibility.snapshot removed in 1.62); pin
Brave-reuse in shared config so no chromium download.

### 2026-08-04 — orchestrator (PIPELINE ROLLUP — all top-3 resolved)
- **ast-grep — KEEP, DEFAULT-ON** (structural bug-class/refactor; on PATH; WA §I).
- **Playwright MCP + test — KEEP, OPT-IN per UI project** (UI verification; migrate hand-CDP
  incrementally; always ship .spec.ts).
- **StrykerJS — PARK** (no unit-test runner; revisit iff a Vitest unit layer is added).
- Not adopted / situational: Context7/Docfork (docs, opt-in on new dep), Chrome DevTools MCP
  (perf/network UI bugs), Semgrep (data-flow bug classes).
Discipline held: each proven on real code before keeping (installed ≠ used); ast-grep + Serena
are now actually USED via WA §I.

### 2026-08-04 — agent (Playwright graduated from scratch dogfood to REAL adoption, dispatched with FEAT-032 #2)
- Verdict 3/3's scratch dogfood is now the real thing on this repo: `@playwright/test@1.62.1`
  installed for real (official npm, provenance = `github.com/microsoft/playwright`),
  `playwright.config.ts` added (reuses system Brave via `launchOptions.executablePath`, zero
  chromium download — confirmed `~/.cache/ms-playwright` stays empty across install + runs),
  `qa:sweep` npm script wired, and the first COMMITTED-shape `.spec.ts` shipped:
  `scripts/qa/reload-preserves-work.spec.ts` — see FEAT-032's matching log entry for the full
  journey description and verification. `npm run qa:sweep` — PASS, stable across 2 runs.
  Uses `getByRole`/DOM assertions plus one `toMatchAriaSnapshot` on the static composer chrome
  (deliberately not on the dynamic transcript/strip, which would be flaky against elapsed-time
  text) — `page.accessibility.snapshot` (removed in 1.62) not used anywhere, per the caveat.
  "installed ≠ done" discipline held: this is a real used spec, not a saved MCP transcript, and
  it's wired into an npm script a future agent will actually run.
- Not done here (left for the next Playwright-touching agent): migrating any EXISTING hand-CDP
  verify-*.mjs script to `.spec.ts` — FEAT-033's adoption path says migrate incrementally as
  touched, not all at once; none were touched by this dispatch.
