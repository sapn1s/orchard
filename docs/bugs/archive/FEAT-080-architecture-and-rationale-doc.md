# FEAT-080 — Architecture & rationale doc: current arch · why · what each part achieves (factual, layered, in-app)

- **Status:** VERIFIED (2026-08-14) — draft → cross-provider adversarial critique (Codex/openai) → FINALIZED. All 10 confirmed corrections applied and re-verified against cited code; page renders in headless brave; docs:fresh/guide-viewer/ui/typecheck/leak-gate all PASS. Built via the review-pass method (draft → adversarial critique → finalize), not a one-shot worker.
- **Area:** docs/guide/ (new Architecture page) + in-app Guide viewer (reuse FEAT-075) + docs:fresh sources + a reconciliation process
- **Reported:** 2026-08-14 by user

## Why (user's goals)
1. Be informed about the high-level architecture / features without a deep dive.
2. Spot what is truly missing / wasn't thought out — needs the RATIONALE (why chosen this way) and the
   TARGET each part achieves, not just a component list.
Audience includes a prospective USER evaluating "is this useful, why, what does it actually provide."

## Content principle (critical — the doc's value depends on it)
- **Direct factual points grounded in the real mechanism. No generated/marketing claims.** The right
  register is concrete cause→effect, e.g. *"uses a fresh-context clean-room verifier, so a fix is not
  confirmed by the same agent (and same fixture) that wrote it"* — a fact about the system, not a
  boast.
- **Layered for no-deep-dive:** scannable factual summary first (what it provides + why it's useful),
  detail below for those who want it.
- **Visuals only where they cut cognitive load** — at most one flow diagram (mermaid, offline) and a
  `subsystem → what it provides → why chosen / target` table. No decorative charts.
- Link the durable decision records (ARCH-001/002, key ARCH/FEAT tickets) rather than restating them.

## Delivery
- Markdown page under docs/guide/ (e.g. `architecture.md`), rendered in the existing **in-app Guide
  viewer** (FEAT-075) — do NOT build a second renderer.
- Declare `sources:` frontmatter and wire into `docs:fresh` / `board:check`.

## Staleness ownership (the hard part — arch changes ~daily)
No single session/person owns it; it's a PROCESS:
- **Mechanical drift** (a described subsystem's code changed) → `sources:` + `docs:fresh` blob-hash
  flag (FEAT-075, already exists), gating board:check.
- **Rationale/target drift** (the *why* changed, a new target/decision emerged; not blob-detectable) →
  a periodic **reconciliation pass**: an agent reads commits/closed ARCH tickets since the last
  blessing and PROPOSES doc updates for the user to approve (§L living-doc pattern applied to
  architecture). Optionally: closing an ARCH ticket appends to the doc.
- A confidently-stale arch doc is worse than none → code-anchoring + auto-flagging is mandatory.

## Build method (per user: don't one-shot / don't rush)
Draft by one agent (reads the real subsystems), then an ADVERSARIAL critique pass — cross-provider
where useful — targeting: generated/unsupported claims, wrong framing, and "what's missing that a real
user/maintainer would want." Finalize from the critique. This is the first dogfood of the
review-board idea; it does not require building a board product.

## Verification (§C)
- Every factual claim in the doc traceable to a real code location/mechanism (spot-check a sample
  against source). `docs:fresh` recognizes the new page's sources and flags on a seeded source change.
  In-app Guide viewer renders it (offline mermaid). Anti-regress: docs:fresh, board:check, verify:ui.
- Risk bucket: docs + a small viewer registration (low).

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
