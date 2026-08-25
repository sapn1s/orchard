```orchard-ticket
{
  "id": "FEAT-033",
  "type": "feature",
  "title": "Tool adoption stayed deliberate instead of accumulating unused tools",
  "summary": "A shortlist of developer tools was researched and worked through one at a time, keeping only what proved its worth. Two were adopted and are in real use: a structural code-search tool and a browser-testing tool. A test-quality checker was parked because it needs deterministic fixtures the project does not have.",
  "impact_if_we_wait": "The ticket stays open as a low-priority note and nothing breaks. Bounded: both adopted tools are already in use, and the parked candidate blocks no work. The only cost is a stale entry on the board.",
  "current_need": "Decide whether to close this now that the shortlist is worked through, or keep it open as a parking spot for future tool candidates.",
  "severity": "low",
  "area": "Development tooling",
  "reported": "2026-08-04",
  "reported_by": "user",
  "owner": "you",
  "work_state": "open",
  "human_action": "decide",
  "updated": "2026-08-04",
  "decision": {
    "mode": "single",
    "question": "Should this close now, or stay open as a parking spot for future tool candidates?",
    "options": [
      {
        "key": "A",
        "label": "Close the ticket",
        "what_changes": "The ticket moves to done with the two adoptions and one parked candidate recorded as its outcome.",
        "benefit": "The board stops carrying an entry that asks nothing of anyone.",
        "cost": "A future tool candidate needs a fresh ticket rather than a line appended here.",
        "why_not_obvious": "The research and the rejection reasons become harder to find, so a rejected candidate can be re-proposed later."
      },
      {
        "key": "B",
        "label": "Keep as a parking spot",
        "what_changes": "The ticket stays open and collects new tool candidates as they come up.",
        "benefit": "The shortlist and the reasons for rejecting candidates stay in one obvious place.",
        "cost": "An open ticket that needs no action sits on the board indefinitely.",
        "why_not_obvious": "An entry nobody has to act on trains readers to skim past open tickets generally."
      }
    ],
    "recommendation": "A",
    "recommendation_reason": "The three candidates it existed to evaluate are all settled, and reopening or refiling later costs one ticket.",
    "prerequisite": null
  },
  "decision_history": [],
  "success_criteria": [
    "Each shortlisted tool is either adopted after proving value or explicitly dropped",
    "No tool is left installed but unused"
  ],
  "code_refs": [],
  "related": [
    {
      "id": "BUG-108",
      "relation": "see_also"
    },
    {
      "id": "FEAT-025",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-038",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "plan+review",
  "body_slots": {
    "Diagnosis": true,
    "Evidence": true,
    "Implementation notes": true,
    "Verification plan": true,
    "Migration and rollback": false,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-033-tool-adoption-pipeline.md",
    "sha256": "de87c593904421c25b5a961c1373e428b5fd7ff960498d71339ca69ca139eae8",
    "bytes": 9202,
    "original_title": "Tool adoption pipeline (high-value integrations to dogfood, one at a time)",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head: the three ranked candidates, the honorable mentions, the rejection list, the adoption path and the triage ask are all present.",
    "dropped": [
      "the §C and §N working-agreement section markers, kept only as plain description"
    ]
  }
}
```

# FEAT-033 — Tool adoption stayed deliberate instead of accumulating unused tools

## Diagnosis

### Why the ticket exists

The working agreement's "installed ≠ done" rule: adopt ONE tool, prove its value, then keep or drop it. The ticket is the queue that keeps that discipline, so tooling does not accumulate as a pile of unused installs.

## Evidence

### Ranked shortlist (research-backed, Aug 2026)

**Top 3 — dogfood in this order**

1. **Playwright MCP** (github.com/microsoft/playwright-mcp) — HIGH. Accessibility-snapshot gives the user-observable DOM the §C rule demands; token-efficient (~200-400 per snapshot); retires hand-written CDP-over-WS scripts. Opt-in per UI project. Caveat: MCP means the agent observes and asserts; the durable artifact that ships with a fix is a committed Playwright `.spec.ts`, not a saved MCP transcript. Long MCP sessions go stale and locators turn flaky.
2. **ast-grep (CLI first)** (ast-grep.github.io) — HIGH. Structural AST search plus `--rewrite`; finds sibling variants of a bug class that ripgrep misses, and enables bulk root-cause refactors (the recurring-class pain of §N). Single binary, no auth, default-on like Serena. The CLI is mature; the ast-grep MCP is experimental, so prefer the CLI.
3. **StrykerJS mutation testing** (stryker-mutator.io) — MED-HIGH value at high cost. An objective "is the test REAL?" referee via mutation score rather than coverage. Scope to the files a fix touched (`--mutate` glob) and run as a periodic or spot gate, not a per-fix global run — too slow on the big files here. Needs deterministic fixtures.

**Honorable mentions (opt-in, situational)**

- **Context7 / Docfork** — up-to-date library docs MCP; opt-in when onboarding a fast-moving dependency. Marginal for a stable TS core; Context7 is token-heavy with modest accuracy, and Docfork is a lighter FOSS alternative.
- **Chrome DevTools MCP** — opt-in for perf and network-class UI bugs, given Brave/CDP is already driven here. Do not run alongside Playwright MCP by default: two browser stacks plus schema token cost.
- **Semgrep (+MCP)** — back-pocket for data-flow/taint-shaped bug classes that ast-grep's pure-AST matching misses. Do not run two structural engines by default.

**Considered and rejected (no real need)**

Memory/vector/knowledge-graph MCPs (conflict with the files-as-source board); repomix and codebase-packing tools (external-project-I already exists); paid docs MCPs (Nia, Deepcon — a subscription is unjustified for a single-user local tool); sequential-thinking (the orchestrator already structures work); Playwright "Test Agents" (overlaps the existing orchestrator); Puppeteer MCP (subsumed by Chrome DevTools MCP).

### Outcome so far

ast-grep and Playwright were adopted and are in real use. StrykerJS was parked pending the deterministic fixtures it requires. A `verify:agent` suite is named in the record but no result is attached to it; a separate 3/3 pass tally is recorded with no suite name beside it.

## Implementation notes

### Adoption path (prove value before keeping)

1. **ast-grep CLI** (cheapest proof): take one existing bug-CLASS ticket, write a pattern, find siblings ripgrep missed, then do one bulk rewrite. Default-on if it delivers.
2. **Playwright MCP** on one UI project: a verify-agent asserts a user-visible DOM outcome and emits a committed `.spec.ts`; retire a hand-written CDP script.
3. **StrykerJS** on one module: a mutant surviving a "real" test is the single finding that would justify it.

## Verification plan

Each candidate is proved by the adoption-path step above rather than by a suite: a sibling bug found that ripgrep missed, a committed spec replacing a hand-written CDP script, a surviving mutant. Two of the three cleared that bar and are in use.

## Risks

Running two browser stacks (Playwright MCP plus Chrome DevTools MCP) or two structural engines (ast-grep plus Semgrep) by default costs schema tokens for no gain. StrykerJS run globally per fix is too slow on the larger files here.

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
