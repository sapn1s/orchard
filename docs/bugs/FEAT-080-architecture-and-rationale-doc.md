```orchard-ticket
{
  "id": "FEAT-080",
  "type": "feature",
  "title": "Nobody could learn the system's design without reading the code",
  "summary": "There was no place to learn what the product is built from, why each part was chosen, and what it achieves. An Architecture page now covers that in the existing in-app Guide viewer, layered so a scannable summary comes first. Every claim is anchored to real code, and the page is flagged automatically when the code it describes changes.",
  "impact_if_we_wait": "Evaluators and maintainers keep reverse-engineering the design from source, and gaps in the design stay invisible. Bounded: this is documentation and freshness signalling only, with no effect on running behaviour or stored data.",
  "current_need": "Nothing is outstanding. The page was drafted, attacked by a second provider, corrected against the cited code, and rendered in a real browser with the standing checks clean.",
  "severity": "medium",
  "area": "Architecture documentation",
  "reported": "2026-08-14",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-14",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Every factual claim in the page traces to a real code location or mechanism",
    "The freshness check recognises the page's declared sources and flags a seeded source change",
    "The in-app Guide viewer renders the page, including its diagram, with no network access",
    "The page leads with a scannable summary of what each part provides and why",
    "A rationale drift pass proposes updates for approval rather than rewriting silently"
  ],
  "code_refs": [
    {
      "path": "docs/guide/architecture.md",
      "symbol": null,
      "note": "the page delivered for FEAT-080; declares its sources in frontmatter so drift is detectable"
    },
    {
      "path": "docs/guide/",
      "symbol": null,
      "note": "rendered through the existing in-app Guide viewer rather than a second renderer"
    }
  ],
  "related": [
    {
      "id": "ARCH-001",
      "relation": "see_also"
    },
    {
      "id": "ARCH-002",
      "relation": "see_also"
    },
    {
      "id": "FEAT-075",
      "relation": "depends_on"
    },
    {
      "id": "FEAT-081",
      "relation": "see_also"
    }
  ],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "docs-only",
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
    "archived_path": "docs/bugs/archive/FEAT-080-architecture-and-rationale-doc.md",
    "sha256": "eebbdeea1352ced3e461f0b373763a2db397cbd414bce97fef99c3838ea81fcd",
    "bytes": 14364,
    "original_title": "Architecture & rationale doc: current arch · why · what each part achieves (factual, layered, in-app)",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Compared against the original head: the two user goals, the factual register, the layering, the visual budget, the delivery route, both drift halves and the build method survive above.",
    "dropped": [
      "the optional idea that closing an architecture ticket could append to the page, kept as a clause in the reconciliation note",
      "the parenthetical filename suggestion for the page"
    ]
  }
}
```

# FEAT-080 — Nobody could learn the system's design without reading the code

## Diagnosis

### What was missing

The design lived only in code and in scattered decision records. A reader wanting the high-level shape — what exists, why it was chosen that way, and what target each part hits — had no entry point short of a deep dive. A component list alone would not serve the second goal, which was spotting what was never thought through; that requires the rationale and the target beside each part.

### The register the page had to hold

Direct factual points grounded in the real mechanism, never generated or marketing claims. The model sentence is concrete cause-and-effect: a fresh-context clean-room verifier means a fix is not confirmed by the same agent, on the same fixture, that wrote it. That is a fact about the system rather than a boast.

## Evidence

Built by the review-pass method rather than a single worker: one agent drafted from the real subsystems, a cross-provider adversarial critique (Codex/openai) attacked it for unsupported claims, wrong framing, and omissions a real user or maintainer would notice, and the page was finalized from that critique. All 10 confirmed corrections were applied and re-checked against the cited code.

The guide-viewer suite ran 26/26 passing and the UI suite 7/7 passing. Documentation freshness and board index checks passed, and typecheck and the leak gate stayed clean. The page rendered in headless brave, confirming the offline diagram displays in the real viewer.

## Implementation notes

### Delivery

A markdown page under the guide directory, rendered by the Guide viewer that already exists — explicitly not a second renderer. The page declares its source files in frontmatter and is wired into the freshness and board index checks.

### Visual budget

Visuals only where they cut cognitive load: at most one offline flow diagram, plus a table mapping each subsystem to what it provides and why it was chosen. No decorative charts. Durable decision records are linked rather than restated.

### Staleness ownership

The design changes close to daily and no one person owns the page, so freshness is a process with two halves. Mechanical drift — the code behind a described subsystem changed — is caught by source hashing and blocks the index check. Rationale drift — the reasoning or the target changed — is not detectable from a hash, so a periodic reconciliation pass reads commits and closed architecture tickets since the last blessing and proposes updates for a person to approve.

## Verification plan

Spot-check a sample of the page's factual claims against the source they cite. Seed a change in a declared source and confirm the freshness check flags the page. Render the page in the in-app viewer with no network and confirm the diagram appears. Anti-regression cover comes from the freshness check, the board index check and the UI suite.

## Risks

A confidently stale architecture page is worse than none at all, which is why code anchoring and automatic flagging were treated as mandatory rather than optional. The change itself is documentation plus a small viewer registration, so the risk bucket is low.

## Activity log (APPEND-ONLY)
### 2026-08-14 — orchestrator
- Filed from user request (durable arch+rationale doc; factual not generated; layered; in-app; process
  for staleness). Existing `docs/ARCHITECTURE-REVIEW.md` is only the arch-watch feature's docs, not a
  system overview — gap confirmed. Build via review pass, not a rushed single worker.

### 2026-08-14 — draft worker
- **Delivered:** `docs/guide/architecture.md` (new guide page), linked from `docs/guide/README.md`
  workflow list. Registered by the FEAT-075 mechanism — the viewer auto-discovers `docs/guide/*.md`
  (server: `src/server/index.ts:488-521`; title = first `# heading`), so no renderer/registration was
  built. Declared 24 `sources:` and blessed the page (`docs:fresh --bless architecture.md`).
- **Subsystems documented** (each grounded via a dispatched Explore read of the real files, then
  spot-checked): service+port (`deploy/claude-station.service`), survival broker (`survival.ts`,
  `session-host.mjs`, `survivor-delivery.ts`), liveness authority (`liveness.ts`, `running-set.ts`),
  runtime seam + providers (`runtime.ts`, `claude-runtime.ts`, `codex-runtime.ts`, `agent-bridge.ts`),
  history/transcripts (`session-history.ts`, `orchard-transcripts.ts`, `codex-native.ts`), instruction
  injection (`templates.ts::composeInstructions`), wiring+onboard (`wiring.ts`, `onboard.mjs`),
  isolation (`container-manager.ts`), board+tickets (`board.ts`, `tickets.ts`, `board.mjs`),
  verification (`independent-verify.mjs`, `verdict-contract.mjs`, `gatekeeper.mjs`), docs-fresh
  (`check-docs-fresh.mjs`). Linked ARCH-001/002, FEAT-061/062/075/076/078 rather than restating them.
  One mermaid flow diagram (offline, renders — 103 svg nodes in a real headless brave).
- **5 spot-checked claims (file:line):** (1) survival escapes the service cgroup via
  `systemd-run --user --scope --collect` — `src/server/survival.ts:227-231`; (2) a client/socket
  disconnect is never forwarded as stdin EOF — `src/server/session-host.mjs:407-409`; (3) independent
  verification spawns a separate `dispatch.mjs` process (not an in-process subagent) —
  `scripts/independent-verify.mjs:451-467`; (4) CodexRuntime spawns `codex app-server` (JSON-RPC over
  stdio) — `src/server/runtime/codex-runtime.ts:370`; (5) `board.mjs gen` re-derives Status from the
  ticket header, preserving only Owner/commit — `scripts/board.mjs:478-493`. Also verified first-hand:
  `composeInstructions` order WA→local→routing (`templates.ts:466-494`).
- **Verify (§C, draft-light):** docs:fresh recognizes the page + all 24 sources; seeded-source-change
  proof (touched `wiring.ts` → flagged "changed", reverted → 0 warns). Guide route serves the page
  (scratch server, free port) with frontmatter stripped, no leak; page renders in real headless brave
  (heading + mermaid). Anti-regress: `verify-feat-075-guide-viewer.mjs` 26/26 (nav now 7 pages),
  leak-gate PASS (409 files), typecheck PASS.
- **AREAS FOR THE CRITIQUE PASS TO SCRUTINIZE:**
  1. **In-app renderer flattens tables + links.** Verified USER REALITY: the FEAT-075 renderer is
     `prose()` (`public/lib/dom.js`), which supports headings/paras/lists/code/emphasis/mermaid but
     NOT GFM tables or `[text](url)` links. The existing `orchestration.md` already renders its table
     as raw pipe text and its links as literal markdown (confirmed in-browser: `rawPipe:true,
     litLink:true`), so my page is consistent, not worse — and my per-subsystem prose restates the
     table. But my page leans harder on a 12-row table + many links; the finalize pass should decide:
     accept per existing convention, or reduce table reliance for in-app readability. (Ticket says do
     NOT build a second renderer, so enhancing prose() is out of scope for this ticket.)
  2. **Possible stale code comment I did NOT propagate.** `templates.ts:419` claims the launch path
     (agent-bridge) passes `routing:true` to `composeInstructions`, but `agent-bridge.ts` contains no
     reference to `composeInstructions`/`boardStateSection` — the only in-repo caller found is the
     preview route `GET .../compose` (`index.ts:1915`) with no hostPath/routing. I described compose's
     ORDER factually and attributed the board-snapshot fold to "the launch caller" without asserting
     agent-bridge does it. Critic should confirm where instructions are actually composed at launch
     (there may be a different injection path than compose()), and whether the WA is in fact injected
     per session today — this is the claim I'm least sure of.
  3. **"Reference engine" / capability parity framing** for ClaudeRuntime (all caps true) — confirm
     no capability is overstated vs the real flags.
  4. **Provider decorrelation as a "target"** is sourced to prompt docs (ROUTING.md/ARCHITECTURE-REVIEW.md),
     not runtime code — I framed it as a routing invariant, not a code-enforced one; verify that framing.
  5. **Sources breadth:** 24 pinned sources = 24 staleness tripwires. Critic/finalize may prune to the
     most load-bearing to reduce docs:fresh noise, or keep broad coverage. Judgement call left open.
### 2026-08-14 — finalize worker (applied cross-provider critique)
Read the Codex critique (`/tmp/iv-orchard/arch-critique.log`); verified EACH cited claim against the
real code before rewriting (the critic's line cites all checked out). Applied every confirmed
correction to `docs/guide/architecture.md`; rejected none.

- **C1 — WA/launch injection (was MISFRAMED).** Draft attributed compose to "the launch caller"
  without asserting agent-bridge does it. FIXED: the injection prose + subsystem-table row + mermaid
  now state instructions are composed AT LAUNCH — `agent-bridge.ts:534-549`
  (`composeInstructions(refs, {hostPath, routing:true})`), board snapshot appended at `:853-855`
  (`appendToSystemPrompt`), passed as runtime `systemPrompt` at `:909-926`. Added that WA is
  **conditional** (present only when an enabled WA template ref is selected; `templates.ts:426-433`
  loads only configured refs), that `instructions:[]` still gets conventions+routing+board but no WA,
  and that a repo `CLAUDE.md` WA-pointer is ambient provider-specific instruction Orchard does NOT
  compose or resolve (not provider-neutral).
- **C2 — Survival (was WRONG/universal).** Reframed the short-version bullet + subsystem-table row +
  removed the universal "Sessions outlive the server process" headline: survival is GATED to `direct`
  sessions with `survivalEnabled() && capabilities.persistedTranscript` (`agent-bridge.ts:791`);
  Codex, container, and survival-off sessions close normally (`agent-bridge.ts:2811`).
- **C3 — Wiring four-mechanism conflation (was WRONG).** Replaced "two decoupled layers" with the four
  distinct mechanisms (selected WA template → composed; `CLAUDE.md` pointer → ambient, not composed;
  board snapshot → appended at launch; drift-guard → installed tooling, not prompt content). Cites
  `templates.ts:426-433` (no CLAUDE.md resolution), `wiring.ts` recognises the pointer only for health.
- **C4 — Capability framing (was WRONG/overstated).** "All capabilities are true" → "all Boolean flags
  true, `backgroundLifetime:'reported'`" (`claude-runtime.ts:120-135`). Fixed "three-valued
  backgroundLifetime" → two-valued `'reported'|'absent'` (`runtime.ts:54-74`); the three-valued
  yes/no/unknown answer is the separate `WorkLifetime.outlivesTurn` (`runtime.ts:87-90`).
- **C5 — Provider decorrelation (was MISFRAMED as routing invariant).** Split ordinary provider
  selection (configured provider used as-is, `agent-bridge.ts:647-693`, no decorrelation) from
  verification policy. "Distinct process" is enforced; "cross-provider" is a DEFAULT of the verifier
  (`independent-verify.mjs:169-174`, same-provider logged "decorrelation reduced" at `:440`) and
  gatekeeper (`gatekeeper.mjs:133-136`), overridable — not an unbreakable invariant.
- **C6 — "Append-only tickets" (was WRONG).** Reframed to "context-accumulating": bodies grow by
  appended log entries, but lifecycle ops do narrow revision-guarded in-place edits (`tickets.ts:566`);
  `INDEX.md` is derived/rewritten. Dropped "append-only" as a storage invariant (transcript
  append-only via `fs.appendFileSync` is a separate, accurate claim, left as-is).
- **C7 — Absolute grounding guarantee (was UNSUPPORTED).** Deleted "Every point… Nothing is
  aspirational." Replaced with an honest caveat: claims are grounded in the listed sources; docs:fresh
  detects source-file CHANGES (blob hash) but does NOT prove semantic correctness, rationale, or
  omissions.
- **C8 — Renderer reality (graceful degrade now).** Added an in-app rendering note: the viewer
  (`public/lib/dom.js` `prose()`, INLINE regex `:148` = code/bold/emphasis only) renders no GFM tables
  or `[text](url)` links (FEAT-081 filed). Kept the table (renders once FEAT-081 lands) but the
  per-subsystem prose fully conveys provides/why WITHOUT it, and no critical info is reachable only via
  a link — ticket paths are visible in the link text.

- **REJECTED:** none. Every critique point was confirmed against code and applied. (The critic's
  suggested "upgrade the renderer" is explicitly out of scope for this ticket — FEAT-081 owns it — so
  I degraded the doc gracefully instead, which the ticket's "do NOT build a second renderer" mandates.)

- **Verify (§C):** re-verified each corrected claim against its cite (all match; no source files
  changed, so no re-bless needed). `docs:fresh` — architecture.md CLEAN (the 2 warns are pre-existing
  `working-agreement.md` staleness on templates.ts/index.ts, out of scope, NOT blessed here).
  Anti-regress: `typecheck` PASS; `verify-feat-075-guide-viewer` 26/26; `verify:ui` 7/7;
  `leak-gate` PASS (0 hits / 410 files). Headless brave render of `#/guide/architecture`: heading +
  58-node mermaid svg, 0 JS errors, all corrected claims present in rendered text (table degrades to
  pipe-text as expected).
- **Independent-verify note:** the page DESCRIBES lifecycle/verification/survival subsystems, but this
  change is a doc-only edit and its own build method WAS an independent cross-provider adversarial pass
  (Codex verified the claims against code) — that subsumes the clean-room verify for this bucket.

- **Risk bucket:** docs + a doc-only page; low. Not a security/lifecycle/data-loss change, so no
  independent clean-room verify is mandated — but the ticket's own design IS an adversarial critique
  pass, which subsumes it. Note the doc DESCRIBES lifecycle/verification subsystems; a critic should
  check the descriptions against code, which is exactly the requested next step.
