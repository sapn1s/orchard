# FEAT-075 — a Guide/Docs system: explain the internal workflow AND the features, for a new/returning user

- **Status:** VERIFIED — all four phases in (Phase 4 done 2026-08-13)
- **Area:** docs content + (later) in-app viewer + diagrams + annotated screenshots
- **Reported:** 2026-08-13 by user:
  > "as a new user i simply don't even know of consolidation etc processes … i'd want to know about
  > things: browser for ui testing / browser stealth for net browsing / serena mcp / working
  > agreement appends to CLAUDE.md / consolidation (what triggers it / instructions / what it does) /
  > ticket processing, verifying flow (is verifier distinct context from the bug solver) / when i
  > open a new project is orchestration setup always default … best would be a /docs section and/or
  > infinite grid diagram, ideally with auto-created screenshots that circle/highlight the UX."

## Goal
A discoverable, accurate reference covering BOTH (a) the internal WORKFLOW processes (many are
invisible today) and (b) the user-facing FEATURES — so a new or returning user can understand
what runs, when, why, and how to change it. Accuracy is paramount: content is DERIVED from the
actual code/config (an inspection pass), never invented.

## Phases
### Phase 1 — INSPECTION (accurate source material) [this ticket kicks it off]
Read-only agents document each subsystem ACCURATELY from the code, writing `docs/guide/*.md`
section drafts. Coverage (the user's list + siblings):
- **Orchestration & dispatch:** orchestrator-does-not-implement, dispatch classes (trivial/fix/
  explore/plan+review/arch/verify), agent types (worker=Opus 4.8), the model-tier rule.
- **Verification flow:** §C must-FAIL, the INDEPENDENT clean-room verifier (distinct fresh context,
  scripts/independent-verify.mjs — answer "is the verifier a different context than the solver?"),
  the verify→fix loop (FEAT-062), the concurrency/worktree rules.
- **Working Agreement + consolidation:** WA → CLAUDE.md injection (templates.ts), canonical
  methodology repo + committed mirror, wa-capture / wa-consolidate — WHAT TRIGGERS consolidation,
  what it does, how a user changes/steers it (the user explicitly does not know this — get it right).
- **Integrations:** browser for UI testing vs browser-STEALTH for net browsing (browser.ts — the
  two modes, when each), Serena MCP (LSP symbol tier — what it's for), provider routing/mix.
- **Projects & sessions:** onboarding a new project (is the orchestration setup applied by DEFAULT?
  onboard.mjs), isolation tiers (direct/sandbox/container) + permission modes + mounts, session
  survival + the running-process list, scratch sessions, provider switching.

### Phase 2 — AUTHOR the guide
Assemble `docs/guide/` from the Phase-1 drafts: an index/overview (`README.md`) with a MERMAID
architecture + flow diagram(s) (renders on GitHub AND in-app), a `workflow/` section and a
`features/` section. Concise, skimmable, each process = what/when/why/how-to-change.

### Phase 3 — IN-APP viewer (separate FEAT)
A "Guide"/"Docs" route in the dashboard rendering the markdown (mermaid + screenshots),
discoverable from the topbar/sidebar. So it's not just on GitHub.

### Phase 4 — ANNOTATED screenshots (separate FEAT)
A capture script that navigates the UI over SYNTHETIC placeholder data (FEAT-052 discipline — NO
real project names/paths; leak-gate/BUG-080 apply), screenshots key states, and overlays
highlight/circle + label on the specific element each doc showcases (pre-capture DOM overlay).
Embedded in the relevant guide pages under docs/assets/guide/.

## Verification (per phase)
Phase 1/2: content matches the code it describes (spot-checked against source; no invented
behavior); mermaid renders. Phase 3: the route renders the guide, mermaid + images load, verify:ui.
Phase 4: screenshots use synthetic data (leak-gate clean), annotations point at the right element.

## Phase 2b — SELF-REPORTING STALENESS (user request: docs detect their own drift)
Reliable marker = git BLOB HASH (content-addressed, deterministic). Design:
- Each `docs/guide/*.md` frontmatter declares `sources:` — the files it's derived from.
- Lockfile `docs/guide/.doc-sources.lock.json`: per doc, each source's git blob hash at last
  "bless" + date.
- `scripts/check-docs-fresh.mjs` (npm `docs:fresh`): recompute current hashes; mismatch → WARN
  "STALE: <doc> — <source> changed since <date>; review: git diff <old>..HEAD -- <source>".
  Advisory by default (exit 0, like board:check); `--strict` gates. `--bless <doc>` re-pins after
  review. Wire into board:check so drift surfaces in the normal cadence (FEAT-068 philosophy).
- Precision upgrade (optional later): pin to symbols/regions (markers or Serena) so only RELEVANT
  changes flag, reducing false positives from unrelated edits to a referenced file.
- Same check covers the mermaid diagram (lists subsystems→sources); screenshots refresh by
  re-running the capture script.

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
