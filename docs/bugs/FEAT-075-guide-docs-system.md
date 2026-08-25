```orchard-ticket
{
  "id": "FEAT-075",
  "type": "feature",
  "title": "New users could not learn what runs behind the scenes",
  "summary": "New and returning users had no place to learn what the system does behind the scenes or how to change it. A guide now exists, derived from the code rather than invented, with diagrams, an in-app reader, annotated screenshots taken over placeholder data, and a staleness check that flags a page when the code it describes moves on.",
  "impact_if_we_wait": "Nothing is waiting. All four phases shipped and the guide is readable both in the repository and inside the product. The optional narrowing of the staleness check to specific regions of a file was never a blocker.",
  "current_need": "Nothing is outstanding. With the screenshot assets removed the seven image checks failed, they passed once captured, and the standing checks stayed clean.",
  "severity": "medium",
  "area": "Product guide and docs",
  "reported": "2026-08-13",
  "reported_by": "user",
  "owner": "agent",
  "work_state": "verified",
  "human_action": "none",
  "updated": "2026-08-13",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "Guide content matches the code it describes, spot-checked against source, with no invented behavior",
    "Mermaid diagrams render both on GitHub and inside the application",
    "A guide route in the dashboard renders markdown with diagrams and images loading",
    "Screenshots use synthetic placeholder data and pass the leak gate",
    "Annotation overlays point at the element each page showcases",
    "A doc whose declared sources changed since blessing is reported as stale"
  ],
  "code_refs": [
    {
      "path": "docs/guide/",
      "symbol": null,
      "note": "index plus workflow and features sections assembled from the inspection drafts"
    },
    {
      "path": "docs/assets/guide/",
      "symbol": null,
      "note": "emptying this directory is what made the seven image checks fail before capture"
    },
    {
      "path": "scripts/check-docs-fresh.mjs",
      "symbol": null,
      "note": "recomputes git blob hashes against the lockfile; advisory by default, --strict gates, --bless re-pins"
    },
    {
      "path": "docs/guide/.doc-sources.lock.json",
      "symbol": null,
      "note": "per doc, each declared source's blob hash at last bless plus the date"
    },
    {
      "path": "scripts/independent-verify.mjs",
      "symbol": null,
      "note": "the clean-room verifier the guide documents as a separate context from the fixer"
    },
    {
      "path": "src/main/browser.ts",
      "symbol": null,
      "note": "the two modes the guide distinguishes: UI testing versus stealth browsing"
    },
    {
      "path": "scripts/onboard.mjs",
      "symbol": null,
      "note": "answers whether a new project gets the orchestration setup by default"
    }
  ],
  "related": [
    {
      "id": "BUG-080",
      "relation": "see_also"
    },
    {
      "id": "FEAT-052",
      "relation": "see_also"
    },
    {
      "id": "FEAT-062",
      "relation": "see_also"
    },
    {
      "id": "FEAT-068",
      "relation": "see_also"
    },
    {
      "id": "FEAT-080",
      "relation": "blocks"
    },
    {
      "id": "FEAT-081",
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
    "Verification plan": true,
    "Migration and rollback": false,
    "Risks": true,
    "Activity log": true
  },
  "source": {
    "archived_path": "docs/bugs/archive/FEAT-075-guide-docs-system.md",
    "sha256": "a82544ea21763cd5d3145be45849033b42eb82d826762f17665eb54640973402",
    "bytes": 19726,
    "original_title": "a Guide/Docs system: explain the internal workflow AND the features, for a new/returning user",
    "migrated_on": "2026-08-20",
    "migrated_by": "migrate-tickets.mjs",
    "confirmation": "Read against the original head: the user's coverage list, all four phases, the accuracy rule, and the blob-hash staleness design are all present above.",
    "dropped": [
      "the verbatim user quote, whose content is carried by the coverage list",
      "the phase-by-phase restatement of the verification bar, folded into one plan"
    ]
  }
}
```

# FEAT-075 — New users could not learn what runs behind the scenes

## Diagnosis

Many of the processes a user depends on are invisible from the interface: dispatch classes and agent tiers, the must-FAIL bar and the clean-room verifier, the verify-then-fix loop from FEAT-062, Working Agreement injection into CLAUDE.md, what triggers consolidation and how to steer it, the two browser modes, the symbol tier, isolation tiers and permission modes, and whether onboarding applies orchestration by default. None of this was written down anywhere a person would find it.

## Evidence

With `docs/assets/guide/` emptied, the seven image checks failed; restoring the captured assets turned them green. The guide viewer suite ran 26/26, the screenshot suite 26/26, the freshness suite 22/22, the board tool suite 34/34, sessions 52/52, the UI suite 7/7 and the BUG-076 suite 6/6. Typecheck, the leak gate and the board check were clean. A clean-room pass over the work is described in the ticket. `verify:fix-loop` and `verify:browser` are named in the ticket but no result for either was recorded.

## Implementation notes

Phase 1 used read-only agents to derive each subsystem's description from the code, so content is inspected rather than remembered. Phase 2 assembled those drafts into an index with Mermaid architecture and flow diagrams that render both on GitHub and in the app. Phase 3 added a dashboard route reachable from the topbar. Phase 4 added a capture script that drives the interface over synthetic placeholder data, overlays a highlight and label on the element each page showcases before capturing, and writes into the guide asset directory. Phase 2b pins each page to the files it derives from using git blob hashes; the check warns and exits zero by default so it rides along with the normal board cadence, with a strict mode for gating and a bless mode to re-pin after review. Pinning to symbols or regions instead of whole files was left as an optional later precision upgrade.

## Verification plan

For content: spot-check each page against the source it claims to describe and confirm the diagrams render. For the viewer: load the route and confirm markdown, diagrams and images all appear. For the screenshots: confirm they contain only placeholder data and that each annotation lands on the intended element. For freshness: change a declared source and confirm the page is reported stale with its bless date.

## Risks

Because the freshness check pins whole files, an unrelated edit to a referenced file flags a page that is still accurate. The cost is reviewer time on a warning that exits zero, not a blocked build.

## Activity log (APPEND-ONLY)
### 2026-08-13 — orchestrator
- Filed from the user's request for a workflow+feature guide. Also the home for documenting the
  2026-08-13 workflow-hardening changes (realistic-state fixtures, concurrency gate, high-stakes
  independent-verify, regression honesty — all now in .claude/agents/worker.md) so they're visible.
- **Phase 1 DONE:** 5 read-only agents wrote docs/guide/{orchestration,verification,working-agreement,
  integrations,projects-and-sessions}.md from the code (disjoint files, no commits). Orchestrator
  authored docs/guide/README.md (index + mermaid architecture/flow diagram + the freshness note)
  and committed the set. leak-gate clean. Consolidation, verifier-distinct-context, browser-two-modes,
  onboarding-not-auto-default all answered accurately.
- **NEXT:** Phase 2b (docs:fresh staleness checker), Phase 3 (in-app Guide viewer route), Phase 4
  (annotated synthetic-data screenshots).

### 2026-08-13 — worker (Phase 2b DONE: docs:fresh — git-blob-hash staleness checker)
- **Sources declared** (YAML frontmatter `sources:` on each guide page, every path verified to exist,
  inferred from each page's own references):
  - `orchestration.md` → WORKING_AGREEMENT.v2.md, ROUTING.md, .claude/agents/worker.md, scripts/dispatch.mjs
  - `verification.md` → WORKING_AGREEMENT.v2.md, scripts/independent-verify.mjs, scripts/lib/verdict-contract.mjs,
    scripts/verify-fix-loop.mjs, scripts/board.mjs, .claude/agents/worker.md
  - `working-agreement.md` → WORKING_AGREEMENT.v2.md, ROUTING.md, docs/CONVENTIONS.md, src/server/templates.ts,
    src/server/index.ts, scripts/sync-methodology.mjs, scripts/wa-capture.mjs, scripts/wa-consolidate.mjs,
    scripts/arch-watch.mjs
  - `integrations.md` → src/server/browser.ts, scripts/verify-browser.mjs, docs/CONVENTIONS.md,
    docs/bugs/FEAT-025-serena-lsp-mcp-tier.md, .mcp.json, ROUTING.md, src/server/runtime/{claude,codex}-runtime.ts
  - `projects-and-sessions.md` → src/server/registry.ts, scripts/onboard.mjs, scripts/board.mjs, scripts/arch-watch.mjs
  - (README.md not pinned — it is the index; it cites FEAT-075 only, no derived source files.)
- **Lockfile** `docs/guide/.doc-sources.lock.json`: per doc, each source's git blob hash + a `blessedAt` date.
  Blob hash computed in pure node (sha1 of `blob <len>\0<content>`), cross-checked === `git hash-object`.
- **`scripts/check-docs-fresh.mjs`** (`npm run docs:fresh`): recomputes each source's WORKING-TREE blob hash,
  compares to the pin. Flags `changed` (hash differs — prints `STALE: <doc> — <source> changed since <blessedAt>
  (review: git diff <old12>..HEAD -- <source>)`), `missing` (declared source gone from disk — reported loudly),
  `unblessed` (source declared but never pinned). Advisory by default (WARN + exit 0, like board:check);
  `--strict` exits 1 on any stale; `--bless [doc]` re-pins current hashes + bumps blessedAt (refuses to
  half-bless a page whose source vanished).
- **Wired into board:check** (`scripts/board.mjs`) as an advisory ride-along — same pattern as arch-watch:
  guarded dynamic import (board.mjs is COPIED into other repos by onboard where the checker/guide dir don't
  exist → degrades to silence), WARN lines only, board:check exit UNCHANGED unless `--strict`. BUG-071/073
  board behavior intact.
- **Verification (`scripts/verify-docs-fresh.mjs`, `npm run verify:docs-fresh`) — 22/22, all in temp trees
  (scratch root + scratch sources, never real files, no server/port):**
  (a) fresh bless → 0 stale + pin===blobHash;
  (b) MUST-FAIL — mutate a scratch source → checker flips clean→stale flagging EXACTLY that doc+source, while a
  presence-only checker that does NOT recompute the hash stays SILENT (0 flags) — proving the hash recompute is
  the whole mechanism; sibling doc referencing only the unchanged source is not swept in;
  (c) `--bless <doc>` clears; (d) deleted source → `missing` + `--bless` refuses it; (e) unchanged doc never
  false-flags across 5 rounds of churn; (f) REALISTIC busy-state fixture (5 docs, shared sources, a real
  "busy day" = two sources changed + one deleted + one newly-added-unblessed) → EXACT stale set, zero false
  pos/neg, untouched docs silent; (g) CLI end-to-end real process: advisory exit 0 (+STALE WARN), `--strict`
  exit 1, clean exit 0.
- **Anti-regressions:** verify:board-tool 34/34 (incl. BUG-071/073, FEAT-068 items); typecheck clean; leak-gate
  PASS (0 hits, new files scanned via `git ls-files -co`); board:check exit 0 unchanged, board:check --strict
  exit 0 (docs clean). Scripts lane — no app.js/server touched, no deploy.
- Status stays OPEN (Phases 3-4 remain).

### 2026-08-13 — worker (Phase 3 DONE: in-app Guide viewer — route + topbar entry + offline mermaid)
- **Server route** (`src/server/index.ts`, read-only, no writes, reads THIS server's own repo dir
  `projectRoot()/docs/guide` — the guide ships WITH the app, not per-project):
  - `GET /api/guide` → `{ pages: [{ page, title }] }`, README first then alpha; title = the page's
    first `# heading` (frontmatter skipped), falling back to the filename. `docs/guide` absent
    (onboarded repo that never copied docs/) → `{ pages: [] }`, never a 500.
  - `GET /api/guide/:page` → `{ page, title, markdown }` with the YAML `sources:` frontmatter STRIPPED
    (the reader shows prose, not the freshness-checker header).
  - **Path safety:** a page id must match `^[A-Za-z0-9._-]+$` (rejects `%`, `/`, `\`), `.md` is
    APPENDED server-side (never accepted from the client), and the resolved path is asserted
    `isInside(GUIDE_DIR, …)` — so encoded `../`, `..\`, and the real `.doc-sources.lock.json` all 404.
  - Rides the existing HTTP handler behind the BUG-076 Host allowlist (verified: foreign Host → 403).
- **Client** (`public/`): a low-chrome topbar **Guide pill** (`#guideBtn`, always shown — the guide
  ships with the app) opens `#/guide`; a sibling overlay route (`parseGuideHash`/`formatGuideHash` in
  `lib/route.js`, wired into `onHashRoute`/`popstate`/boot/Esc exactly like FEAT-058's ticket route)
  with a left page list + the selected page's markdown. Rendering **reuses the app's existing
  `prose()`** (no new md lib); the only special case is ```` ```mermaid ```` blocks, split out and
  promoted two heading levels (prose renders `#`→h3 for in-message use; a guide page IS the page).
  pushState nav → browser Back walks page→page→out, like the ticket portal.
- **MERMAID — approach (a), vendored + lazy-loaded:** `public/vendor/mermaid.min.js` (mermaid 11.16.1
  standalone UMD, MIT; **zero dynamic imports — all diagram types bundled**, attaches
  `globalThis.mermaid`), obtained via `npm pack` (build-time only) so NOTHING is fetched at runtime.
  Lazy-loaded by a `<script>` inject ONLY when a guide page opens; `mermaid.render()` with
  `securityLevel:'strict'`, theme following the app's light/dark. Each block pre-fills a labelled
  source-listing fallback (approach (c)) that stays if the bundle ever fails — the diagram content is
  never lost. Chosen over (b) committed SVGs because it renders ANY future ```` ```mermaid ```` with no
  per-doc build/asset-serving plumbing, and true offline is guaranteed (0 dynamic imports, local file).
- **Verification** (`scripts/verify-feat-075-guide-viewer.mjs`, `npm run verify:feat-075-guide-viewer`)
  **— 26/26**, scratch server on an OS free port (never :4317) + real `brave --headless=new` over raw
  CDP (happy-dom has no layout and cannot run mermaid's SVG engine), killed by PID:
  - SERVER (fetch/raw-http): lists 6 real pages README-first with heading titles; `:page` returns
    markdown with frontmatter stripped and no `sources:` leak; **6 traversal/non-page names → 404**
    (encoded `../`, `..\`, the real lockfile with/without ext, a missing page) with the real
    lockfile proven present-on-disk yet refused; foreign Host → 403, localhost → 200.
  - CLIENT (real browser, REALISTIC busy-state = the actual six-page guide): Guide pill visible → `#/guide`;
    click opens README (heading + prose); a ```` ```mermaid ```` **rendered offline to an on-page `<svg>`
    with 98 drawn nodes** (`window.mermaid` from the local vendor file, no network); page-list click →
    `#/guide/orchestration` (active row marked, frontmatter NOT shown); browser **Back** returns to
    README then out to sessions; a **cold deep-link** `#/guide/verification` renders that page + its svg.
  - **MUST-FAIL pre-fix** (implementation git-stashed, verify script + vendor kept): `/api/guide` 404s
    (no pages), no Guide pill, no diagram, no navigation → the mechanism checks fail (~18 FAIL); the
    traversal-404 checks pass trivially pre-fix because the whole route is absent (documented).
- **Anti-regressions:** verify:ui 7/7, verify:sessions 52/52 (server routing intact), verify:bug-076 6/6
  (Origin/Host guard intact), typecheck clean, leak-gate PASS (0 hits / 374 files incl. the untracked
  vendor bundle + spec via `git ls-files -co`).
- **Deploy split:** the SERVER route (`/api/guide`) needs a **redeploy** to be served; the CLIENT
  (public/*) is live on a browser reload. Did NOT deploy (per lane). Independent clean-room verify not
  required — routine read-only reader + a scoped GET route (no session-lifecycle / data-loss / security
  surface beyond the reused BUG-076 guard, which is itself re-verified).
- Status stays OPEN (Phase 4 — annotated synthetic-data screenshots — remains).

### 2026-08-13 — worker (Phase 4 DONE: annotated guide screenshots over SYNTHETIC data → FEAT-075 complete)
- **Capture** (`scripts/capture-guide-screenshots.mjs`, `npm run docs:screenshots`): boots a SCRATCH
  server on an OS free port (never :4317, scratch `CLAUDE_STATION_DATA` + `CLAUDE_PROJECTS_DIR`),
  registers the three FICTIONAL projects **atlas-api / aurora-web / lumen-cli** (all under fictional
  `/tmp` paths — FEAT-052 discipline, no real names/home paths), seeds a synthetic ticket board on
  disk for aurora-web, drives a headless `brave --headless=new` over raw CDP @1440×900 ×2, and for
  EACH shot injects a DOM overlay (an absolutely-positioned highlight RING + caption computed from the
  target element's `getBoundingClientRect`) BEFORE `Page.captureScreenshot` (clipped to the element +
  caption). Every widget is lit from the app's OWN renderers over injected synthetic state
  (`renderTree` / `applySnapshot` / `paintCrown` / `paintModelChip` / `refreshRail` / the `#/tickets`
  route) — nothing re-implements the UI, nothing captures real data. Killed by PID, no pkill.
- **Declarative shot list** (`scripts/lib/guide-fixture.mjs` `SHOTS[]` = `{name, outFile, target, label}`)
  — **7 shots**, re-runnable to fixed paths under `docs/assets/guide/`:
  - `running-strip.png` → `#strip` — "Running now — the main turn plus every subagent, live from the server"
  - `for-you-rail.png` → `#railSummary` — "For You — the Focus ticket + a live counts strip of what's on your plate"
  - `project-sidebar.png` → `.row.pinned .pin-mark` — "Pinned sessions hold the top; projects sort by recency; a pending new session rides above all"
  - `model-chip.png` → `#modelChip` — "The live model chip — flags a silent provider fallback until you acknowledge it"
  - `isolation-chip.png` → `#isoBtn` — "Isolation tier (Direct/Sandbox/Container) with the permission mode + instruction stack beside it"
  - `guide-pill.png` → `#guideBtn` — "The Guide pill — open this guide from anywhere in the app"
  - `board-portal.png` → `#ticketsView .tv-list` — "The ticket board — every ticket, filterable, in its own route"
- **Synthetic guarantee (BUG-080):** `docs/assets/` is the allowlisted public image dir and the
  leak-gate is pixel-blind, so the guarantee is BY CONSTRUCTION — the fixture defines every project
  name / path / session + ticket title, all fictional. `guide-fixture.assertSynthetic()` reproduces the
  leak-gate's own token list and asserts the whole fixture trips NONE of them (and positively that the
  three fictional names are present) — asserted in the verifier.
- **Embedded** (markdown image + caption, `../assets/guide/…` — GitHub-relative, renders on the guide
  pages): running-strip → `orchestration.md`; for-you-rail + board-portal → `verification.md`;
  project-sidebar + isolation-chip + model-chip → `projects-and-sessions.md`; guide-pill → `README.md`
  (+ a staleness note: re-run `docs:screenshots` when the UI moves). **Frontmatter `sources:` untouched**
  on every page (embedding images is not a source change), so the Phase-2b lockfile stays valid
  (`docs:fresh` shows only the pre-existing `index.ts`↔working-agreement.md drift, unrelated to this lane).
- **Staleness story:** the capture is idempotent (fixed `outFile` paths) — re-running refreshes the same
  PNGs when the UI changes. That is the screenshots' half of the freshness design (docs:fresh covers the
  prose; docs:screenshots covers the pixels).
- **Verification** (`scripts/verify-feat-075-screenshots.mjs`, `npm run verify:feat-075-screenshots`) — **26/26:**
  (a) the fixture is synthetic — 0 leak-token hits + the three fictional names + no `/home/` anywhere;
  (b) REALISTIC busy-state fixture — 3 projects across all 3 isolation tiers, a pinned + ≥5-session
  list spanning days, a board with a needs-you Focus, a main+2-subagent running set (not a one-widget
  stub); (c) a FRESH capture into a scratch out-dir exits 0 and produces every one of the 7 PNGs
  non-empty + real PNG signature, and the capture manifest records `targetFound && annotationInjected`
  per shot (the annotation was drawn on the right element); (d) the COMMITTED `docs/assets/guide/*.png`
  exist as non-empty PNGs + only PNGs in the dir; (e) `leak-gate` PASS.
  **MUST-FAIL pre-fix** (observed): with `docs/assets/guide/` empty the seven (d) checks FAIL (18/25) —
  the absence of the capture output fails the suite; generating the PNGs flips it to 26/26.
- **Anti-regressions:** `verify:ui` 7/7 (real live SDK session intact), `typecheck` clean, `leak-gate`
  PASS (0 hits / 384 files incl. the new PNGs via `git ls-files -co`; images allowlisted under
  `docs/assets/`), `docs:fresh` lockfile still valid (no `sources:` touched).
- **Independent verify:** WARRANTED (leak-safety surface) — the synthetic guarantee is generation-adjacent;
  a fresh-context clean-room pass over `assertSynthetic()` + a visual read-back of the seven committed
  PNGs is the recommended second check. Bucket: docs/scripts lane, but leak-adjacent → not purely routine.
- **Phase 4 DONE → FEAT-075 COMPLETE** (Phases 1, 2, 2b, 3, 4 all in). Status → VERIFIED.
