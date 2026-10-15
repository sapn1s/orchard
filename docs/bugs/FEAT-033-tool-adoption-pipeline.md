```orchard-ticket
{
  "id": "FEAT-033",
  "type": "feature",
  "title": "Tool adoption stayed deliberate instead of accumulating unused tools",
  "summary": "A shortlist of developer tools was researched and worked through one at a time, keeping only what proved its worth. Two were adopted and are in real use: a structural code-search tool and a browser-testing tool. A test-quality checker was parked because it needs deterministic fixtures the project does not have.",
  "impact_if_we_wait": "The ticket stays open as a low-priority note and nothing breaks. Bounded: both adopted tools are already in use, and the parked candidate blocks no work. The only cost is a stale entry on the board.",
  "current_need": "Close the ticket with its two adoptions and one parked candidate recorded as the outcome.",
  "severity": "low",
  "area": "Development tooling",
  "reported": "2026-08-04",
  "reported_by": "user",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-10-14",
  "decision": null,
  "decision_history": [
    {
      "id": "e0e57d56-8c63-4e30-906d-af7604a0d91d",
      "asked_on": "2026-08-04",
      "question": "Should this close now, or stay open as a parking spot for future tool candidates?",
      "mode": "single",
      "options_keys": [
        "A",
        "B"
      ],
      "chosen": "A",
      "chosen_on": "2026-10-14",
      "chosen_by": "agent",
      "note": "Decided by the agent (worker (BUG-259 fixing r1)), not by you — recommendation: Open or closed is board bookkeeping; the three candidates it existed for are settled.",
      "owned": {
        "by": "worker (BUG-259 fixing r1)",
        "basis": "recommendation",
        "ref": null,
        "why": "Open or closed is board bookkeeping; the three candidates it existed for are settled.",
        "on": "2026-10-14",
        "next": "Close the ticket with its two adoptions and one parked candidate recorded as the outcome.",
        "handoff": null,
        "prior": {
          "human_action": "decide",
          "work_state": "open",
          "current_need": "Decide whether to close this now that the shortlist is worked through, or keep it open as a parking spot for future tool candidates."
        }
      },
      "snapshot": {
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
      }
    }
  ],
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

### 2026-10-10 — agent (built the missing test runner + manifest + CI; ran the suites for real)
Problem (measured): 298 npm scripts, 260 `verify:*`, no `test` script, no runner, no CI — `npm run
gate` runs only leak/NUL/privacy/typecheck, so nothing proved the verify suites still pass.

Hypothesis VERIFIED first: 405/405 physical verify scripts signal failure by exit code
(`process.exit`/`throw`/`node:assert`) — a single runner is viable. Confirmed by inspection, not assumed.

Built (all unstaged):
- `scripts/gen-test-manifest.mjs` + generated `scripts/test-manifest.json` — ONE owner (ARCH-010) of
  each suite's tier. 261 suites classified by static signal: pure 128, browser 90 (inline Brave/CDP or
  Playwright), scratch-server 23, host-live 13, docker-sandbox 7. 45 flagged `needsGit` (spawn a
  scratch-repo git write). `--check` guards drift.
- `scripts/test-runner.mjs` = `npm test` — bounded parallelism, docker-sandbox serialized, per-suite
  timeout, logs to scratch, summary table, true aggregate exit. Refuses host-live without
  `--include-host-live`; FAILS LOUD on any unclassified `verify*` script; detects a git-write-blocked
  lane and SKIPs `needsGit` suites (so a lane artifact is not scored as a regression).
- `.github/workflows/test.yml` — Node 23 / ubuntu, runs the PORTABLE (pure) tier + gate +
  manifest:check. CI cannot run browser (no browser), docker-sandbox (needs the standing sandbox),
  scratch-server (excluded for port/proc flakiness), or host-live (needs the live service).

Proven: runner summary table real; a synthesized failing suite made `npm test` exit 1 (then removed);
`npm run gate` PASS (exit 0).

Real run (this git-write-blocked dispatched lane, shared tree carrying other lanes' uncommitted edits):
- Full default (pure+scratch-server, 229): 124 pass / 105 fail-timeout — DOMINATED by lane artifacts:
  ~12 git-write-block refusals, 21+ browser suites under concurrency, 10 timeouts.
- Clean pure tier (needsGit auto-skipped): 95 ran → 66 pass, 23 fail, 6 timeout, 33 git-skip.
Failing-suite CLASSES (not product-fixed here, per charter):
- ENV / lane: 33 needsGit (blocked git) + git-write-block refusals; pass in a normal shell.
- MIS-TIER / heavy: timeouts on session-lifecycle suites that boot a server my signal missed
  (verify:detach, :reattach-approval, :close-busy-detach, :bug-044-restart-background, :bug-123, :triage).
- STALE / board-state-coupled (already documented in CONVENTIONS §Testing): verify:feat-090,
  :reachability, :feat-082-digest redden when the live board/in-flight tree differs from pinned values;
  likewise the board-mutating :board-tool (33/34), :round-ceiling (13/14), :bug-125 (123/126),
  :gatekeeper, :bug-119, :feat-097.
- NEEDS TRIAGE (small real/stale deltas, fail individually too): verify:session-provenance-fold,
  :bug-138, :feat-071-project-dir, :bug-144, :tool-toggle, :mcp-ready, :feat-085-independent,
  :liveness-conformance, :bug-074-ghost-drain, :orchestrator-profile-registry, :feat-145-usage.

HANDOFF: (1) a clean-room / normal-shell run (git-writes allowed, pinned tree) is needed to separate
real regressions from lane+board-coupling noise — this lane cannot. (2) scratch-server signal still
under-detects session-lifecycle suites that spawn the server indirectly; widen it or raise their
timeout. (3) the STALE board-coupled suites are a pre-existing class (CONVENTIONS names three) — worth
a follow-up to assert invariants rather than pinned board values. No product code touched.

### 2026-10-10 — agent (round 2: de-contaminated health run + manifest tier/timeout fixes)
Re-measured the verify suites' TRUE health; the previous 124/105 was contaminated (git blocked
in-process, shared mutating tree, mis-tiering). Method: pinned the CURRENT working tree (143
uncommitted files) to a reflink scratch copy, PRESERVED the real `.git` (full history) with a
synthetic identity, and ran with the git-shim stripped from `$PATH` so `needsGit` suites write
fixture repos via real git (sanctioned scratch exception). One runner per tree (concurrent runners
race the shared board). Full table + per-suite classification:
`~/.local/state/claude-station/scratch/feat-033-health/report.md`.

Counts (default = pure + scratch-server):
- real-history, OLD manifest: 90 pass / 61 fail-timeout of 151.
- real-history, FIXED manifest: **91 pass / 57 fail-timeout of 148** (pure 81/44/2,
  scratch-server 10/6/5).
- Discarded a first attempt that SQUASHED the repo to one commit — it broke every history-reading
  suite; restoring real history fixed feat-049, feat-089, bug-128, diff-size.
- Browser tier (separate tree, Brave): 33 / 57 of 90 — dominated by the same scratch-server
  session-init readiness cause under concurrency; not separately triaged (needs warm server / conc-1).

Classification of the 61 (real-history): ENV ~34 (harness shim-PATH 3; scratch-server cold
boot-probe readiness ~16 — SESSION-LIFECYCLE; FLAKY 2 (triage, bug-044 flipped between identical
runs); docker-sandbox/confined 2; filesystem 2; git-history-the-collapsed-repo-lacks ~4; registered-
project 1; other 4). STALE ~13 (committed-API 4 — clearest is `verify:orchestrator-enforcement`, a
HARD import crash on the removed export `ENFORCE_DENIED_GIT_SUBCOMMANDS` after the profile moved
deny-list -> allow-list; board/real-corpus-coupled ~9, the class CONVENTIONS §Testing already names).
REAL candidate ~10 — ALL reddening against UNCOMMITTED working-tree edits, not committed main:
- public/app.js (M): verify:session-provenance-fold (live/open agent sessions not fold-exempt),
  verify:feat-071-project-dir (no Directory line in settings drawer), verify:feat-145-usage
  (paintUsageChip throws).
- scripts/hooks/response-format-gate.mjs (M) + .orchard/lib/response-blocks.js (deleted):
  verify:feat-085-independent (41/18), verify:feat-085-adversarial (G5), verify:feat-083-adversarial
  (contract BROKEN — non-leading fence matched).
- README.md (M): verify:feat-049-licence (C9).
- repoint+UI: verify:bug-138 (missing-dir repoint emits a fatal error, not a clean 400),
  verify:bug-138-ui.

Hypothesis (most env, ~10-15 real) CONFIRMED, with the nuance that the "real" set tracks the
mid-change working tree, not committed main.

Manifest/runner fixes (REAL repo, UNSTAGED; backups in scratch/feat-033-r2-backup/):
- scripts/test-runner.mjs — per-suite `timeoutSec` (global --timeout is the floor; only raises).
- scripts/gen-test-manifest.mjs + regenerated scripts/test-manifest.json — OVERRIDES moved
  verify:live, verify:feat-154-open, verify:mcp-ready to host-live (all need a real artifact / live
  server, precondition-fail locally); TIMEOUTS gave bug-247/bug-239-bound-hangs/bug-123 600 s.
  HONEST: the raise let bug-123 finish (then it FAILs on corpus -> STALE); bug-247 and
  bug-239-bound-hangs STILL time out at 600 s (genuinely slow/hang in cold isolated boot).

Handoff: (1) the scratch-server session-init readiness cluster (~16) + the REAL working-tree
candidates (~10) warrant an INDEPENDENT clean-room / warm-live-server confirm before any is called a
product regression (session-lifecycle + regression-prone). (2) `verify:orchestrator-enforcement` is a
genuinely broken (STALE) committed test — crashes on import; worth fixing the test to the allow-list
API. (3) scratch-server tier is intrinsically FLAKY here; pure tier is stable. No product code
touched; only the three runner/manifest files + this ticket.

### 2026-10-11 — agent
- **correction — two 2026-10-10 entries belong to FEAT-174:** The two 2026-10-10 entries above ("built the missing test runner + manifest + CI; ran the suites for real" and "round 2: de-contaminated health run + manifest tier/timeout fixes") describe building npm test — scripts/test-runner.mjs, scripts/gen-test-manifest.mjs, scripts/test-manifest.json, .github/workflows/test.yml — and the suite-health run (report: ~/.local/state/claude-station/scratch/feat-033-health/report.md). That work is NOT tool adoption; it was mis-filed here. It now lives on FEAT-174 ("Verify suites have a runner and CI"), which carries the substance and the still-open items (independent verify, ~10 real-candidate failures to confirm, the crashing verify:orchestrator-enforcement test, browser-tier triage, unpushed CI). Per the append-only rule the two entries are left in place; this entry is the correction. The runner work committed in ed92aff.

### 2026-10-14 — worker (BUG-259 fixing r1)
- **Decided by agent (own):** Decided by the agent, not by you. Basis: recommendation. Chose: A. Why: Open or closed is board bookkeeping; the three candidates it existed for are settled. Next: Close the ticket with its two adoptions and one parked candidate recorded as the outcome. You can reopen this decision from the ticket view.
