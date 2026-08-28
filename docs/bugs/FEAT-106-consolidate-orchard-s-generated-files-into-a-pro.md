```orchard-ticket
{
  "id": "FEAT-106",
  "type": "feature",
  "title": "Consolidate Orchard's generated files into a project-local .orchard directory",
  "summary": "onboard.mjs scatters 21 generated paths across an onboarded project's root, scripts/, docs/ and public/. public/ is a web-served static root (a downstream Next.js target's Dockerfile copies /app/public into the image), so a deploy would publish ~149 KB of Orchard dashboard internals at public URLs. Consolidate everything Orchard generates into one project-local .orchard/ directory, the way .claude/ works.",
  "impact_if_we_wait": "Every onboarded Next.js target keeps risking publishing Orchard dashboard internals (dom.js, digest.js, route.js, response-blocks.js) at public URLs, and the generated files stay scattered and easy to miss when reasoning about a target repo.",
  "current_need": "Land the layout-independent foundation first (board-path resolver + inert layout-independence fixes) so the onboard rewrite and consumer cutover can follow without moving Orchard's own board.",
  "severity": "medium",
  "area": "onboard",
  "reported": "2026-08-26",
  "reported_by": "agent",
  "owner": "unassigned",
  "work_state": "open",
  "human_action": "none",
  "updated": "2026-08-26",
  "decision": null,
  "decision_history": [],
  "success_criteria": [
    "public/ no longer appears in onboarded targets",
    "All Orchard-generated files live under .orchard/",
    "Orchard's own docs/bugs board is byte-untouched",
    "Stop hook + gate work in both legacy and flat layouts"
  ],
  "code_refs": [],
  "related": [],
  "recurrence_evidence": [],
  "verification": [],
  "verification_class": "fix",
  "body_slots": {
    "Diagnosis": false,
    "Evidence": false,
    "Implementation notes": false,
    "Verification plan": false,
    "Migration and rollback": false,
    "Risks": false,
    "Activity log": true
  },
  "source": {
    "archived_path": null,
    "sha256": null,
    "original_title": null,
    "migrated_on": null,
    "migrated_by": null,
    "confirmation": "Authored directly in the record format through scripts/board-tool.mjs. There is no legacy original.",
    "dropped": []
  }
}
```

# FEAT-106 — Consolidate Orchard's generated files into a project-local .orchard directory

## Symptom

`scripts/onboard.mjs` scatters 21 generated paths across each onboarded project's root, `scripts/`, `docs/` and **`public/`**. `public/` is a web-served static root: a downstream target is Next.js and its `Dockerfile:91` does `COPY --from=builder /app/public ./public`, so a deploy would publish ~149 KB of Orchard dashboard internals at that site's `/lib/*.js`. The user asked for everything Orchard generates to be consolidated into a single `.orchard/` directory per project, the way `.claude/` works.

## Target layout (decided — implement, do not redesign)

```
<target>/
  CLAUDE.md                    <- stays at root; the harness reads it there
  .claude/settings.json        <- stays; Stop-hook command re-pointed
  package.json                 <- stays; 5 script VALUES re-pointed
  .orchard/
    config.json                <- NEW: declares the board path + layoutVersion
    .gitignore                 <- NEW, nested
    CONVENTIONS.md  DEPLOY-CONTEXT.md
    bugs/                      <- README, INDEX, TEMPLATE, TEMPLATE-ARCH, tickets, assets/, .arch/
    board.mjs  arch-watch.mjs  gate.mjs  leak-gate.mjs  check-nul.mjs
    hooks/response-format-gate.mjs
    lib/  <- verdict-contract, ticket-schema, board-path (new), readability,
            structure, format-metrics, digest.js, dom.js, route.js, response-blocks.js
```

`public/` disappears from onboarded targets entirely. The nine copied `public/lib/*.js` fold into one flat `.orchard/lib/`; the planner verified those files import only siblings and there are no name collisions, so nearly every relative import resolves byte-unchanged.

## The five-commit split

**Commit 1 — `scripts/lib/board-path.mjs`.** Plain ESM, node builtins only, so it can be copied into targets AND imported from TypeScript (`src/server/tickets.ts` already imports `../../scripts/board.mjs`). Exports:
- `resolveOrchardDir(hostPath)` -> `<hostPath>/.orchard`
- `resolveBoardDir(hostPath)` -> (1) `<hostPath>/.orchard/config.json {"board":"<host-relative>"}` DECLARED; (2) `<hostPath>/.orchard/bugs` if it exists (discovered); (3) `<hostPath>/docs/bugs` (legacy).
- `resolveLibDir` / `resolveConventionsFile` / `resolveDeployContextFile` / `resolveStopHookFile` -> same shape: `.orchard` candidate first, legacy second.
- `boardLayout(hostPath)` -> `'declared' | 'orchard' | 'legacy' | 'none'`.
HARD CONSTRAINT: Orchard's own `docs/bugs/` (~249 live + ~194 archived tickets) must not move or be read from a different path. Orchard's repo has no `.orchard/`, so the resolver falls through to `docs/bugs` by construction. Add `lib/board-path.mjs` to the set of libs copied into targets. Pure addition: no callers change.

**Commit 2 — layout-independence fixes (inert today, green in both layouts).**
- `scripts/gate.mjs` — resolve `LEAK_GATE`/`CHECK_NUL` as siblings of `HERE` instead of `ROOT/scripts`. Identical in Orchard's tree, correct under a flat `.orchard/`. `repoRoot()` unchanged.
- `scripts/hooks/response-format-gate.mjs` — the two dynamic imports (`digest.js`, `response-blocks.js`) become candidate loops: try `../lib/<x>.js` (flat) FIRST, then `../../public/lib/<x>.js` (Orchard's own tree + legacy). Co-located copy must win. Preserve the existing `noteCannotGrade` diagnostics for the all-candidates-fail case.
- `scripts/verify-bug-118-orchard-only-stop-hook.mjs` — extend the mirror fixture with the flat-layout case; home for the regression test that the candidate loop works in both trees.

**Commit 3 — onboard.mjs writes the `.orchard/` layout.** Emit `.orchard/config.json` (declares board + layoutVersion), nested `.orchard/.gitignore`, CONVENTIONS.md/DEPLOY-CONTEXT.md, `bugs/`, the copied tools + hook + flattened `lib/` all under `.orchard/`; re-point the `.claude` Stop-hook command and the 5 package.json script values; `public/` no longer written to targets. (Refined by that stage.)

**Commit 4 — consumers read through the resolver.** `src/server/tickets.ts`, `board.mjs`, arch-watch and any other reader resolve board/lib/conventions/deploy-context/stop-hook via `board-path.mjs`, so both the legacy and flat layouts work. (Refined by that stage.)

**Commit 5 — verification + docs.** `verify-onboard` covers the new layout; migration/idempotency across old+new targets; docs updated. (Refined by that stage.)

## Constraints

- Touch NOTHING outside the Orchard repo. No user repo is in scope.
- Do not move, rename or rewrite any ticket under `docs/bugs/`.
- Explicit-file commits only (`git commit --only -- <paths>`), never `git add -A`.
- `npm run gate` must exit 0.

## Verification bar (stage 1: commits 1 and 2)

- **A. Orchard's own board untouched.** `git status --porcelain docs/bugs` empty; `board.mjs check` exit 0; `resolveBoardDir('<repo>')` returns `<repo>/docs/bugs`; ticket count unchanged.
- **D-partial. The Stop hook actually fires.** Drive it with a real transcript on stdin, `ORCHARD_SESSION_ID` set + `ORCHARD_STOP_HOOK_ENFORCE` on, once compliant and once missing the digest fence; assert outcomes DIFFER, and that `noteCannotGrade` was NOT called with `deps-digest-unloadable`/`deps-digest-incompatible`. In both the current layout and a flat-layout fixture.
- **C-partial.** `gate.mjs` reaches all three sub-gates; prove non-vacuity (FAILS if a sibling is genuinely absent).
- Must-FAIL baseline against the pre-change tree for the new assertions.

## Migration decisions (stage 3 — from the user, recorded here so they do not live only in chat)

- **A downstream target's root `public/` is Orchard's own creation.** The real app's static root is `frontend/public/`; the root `public/` appears to be produced by onboard. **Stage 3 deletes the WHOLE root `public/` directory, not just `public/lib/`** — under the condition the user has applied throughout: the delete set is derived from what onboard itself produces, and stage 3 must first confirm the directory holds nothing but Orchard-generated files before removing it. If anything unexpected is in there, leave it and report.
- **The operator home directory (`~`, the terminal's default cwd) is OUT OF SCOPE entirely.** Do not de-onboard it, do not delete anything in it, do not enumerate it. User's words: "can leave as is since its not repo, reason i use it is because when opening terminal that is the default directory, but for now i think just skip it, dont concern urself with it." Recorded as explicitly skipped so a later stage/session does not rediscover it as an oversight and "fix" it. (Home path written as `~` to keep this public-repo ticket leak-clean.)
- **Consequence for the onboarding-guard follow-up:** because the default terminal directory gets registered as a project, the separate ticket about onboard refusing non-git / `package.json`-less directories must treat THIS case as deliberate and wanted — a warning is right, a refusal would break the user's normal workflow.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-08-26 — agent
- **Filed:** through the board tool; the record was validated before it was written.

### 2026-08-26 — worker (stage 1 of 3: commits 1 and 2)
- **Understood:** land the layout-independent foundation without moving Orchard's own board. Commit 1 = the resolver; commit 2 = inert-today fixes that go green in a flat `.orchard/` layout.
- **Changed:**
  - `scripts/lib/board-path.mjs` (new) + `scripts/verify-feat-106-board-path.mjs` (new) + `scripts/onboard.mjs` (COPIED_TOOLS gains `lib/board-path.mjs`) — commit **69c05d2**.
  - `scripts/gate.mjs` (sub-gates resolved as siblings of HERE), `scripts/hooks/response-format-gate.mjs` (two dynamic imports → `importFirst` candidate loop, `../lib` first then `../../public/lib`), `scripts/verify-bug-118-orchard-only-stop-hook.mjs` (new `flatMirrorFor` + section H), `scripts/verify-feat-106-layout-independence.mjs` (new) — commit **3192ed5**.
- **Verified:**
  - A (Orchard's board untouched): `verify-feat-106-board-path.mjs` 34/34 — `resolveBoardDir(<repo>)` === `<repo>/docs/bugs`, `boardLayout(<repo>)` === `legacy`, repo has no `.orchard/`. `node scripts/board.mjs check` exit 0; ticket count unchanged (244).
  - D-partial (hook fires in both layouts, outcomes differ, NO `deps-digest-*`/`deps-blocks-*` record): `verify-bug-118` section H — 111/111 total. Advisory + enforce, legacy and flat, plus H6 non-vacuity (neither candidate present → silent + `deps-digest-unloadable`).
  - C-partial (gate reaches all three sub-gates; non-vacuity): `verify-feat-106-layout-independence.mjs` 6/6, incl. C3 (absent sibling → gate reports FAIL) and must-FAIL baselines M1 (pre-change gate breaks in flat layout) + M2 (pre-change hook goes inert in flat layout).
  - `npm run typecheck` exit 0.
- **KNOWN pre-existing blocker (NOT this lane):** `npm run gate` exits 1 because the leak-gate finds 7 home-path / private-project hits in `docs/bugs/BUG-155-*.md` (committed in 1d1add7). My working tree adds ZERO new hits (identical 7-in-1 count on clean HEAD and after my changes); my own files were scrubbed to clean. Rewriting BUG-155 is out of scope for this stage (do-not-rewrite-tickets constraint). Flagged for a separate scrub so the repo-wide gate can go green.
- **Still open / handoff:** commits 3–5 per the split above. Stage 3 must honour the two Migration decisions recorded above (delete the WHOLE root `public/` only after confirming it holds nothing but Orchard-generated files; the operator home dir explicitly skipped).
- **Symptom of a deeper design flaw?** no (this is planned consolidation work, not a defect fix).

### 2026-08-26 — worker (stage 2 of 3: commit 3, "readers route through the resolver")
- **Understood:** make every reader of a board / conventions / deploy-context / stop-hook path go through the commit-1 resolver instead of a literal path. NO producer changes — onboard still writes the legacy layout, every real project is still legacy, so this commit is a behaviour NO-OP on today's projects and is independently verifiable against them.
- **Changed (all working-tree only — no commit; the user is taking over git ops this session):**
  - `src/server/board.ts` — `boardDir()` delegates to `resolveBoardDir()`; `readBoard`, the `.arch` findings/acks paths and the launch snapshot follow for free. Launch-snapshot footer names the resolved board dir (host-relative) instead of a literal `docs/bugs/`.
  - `src/server/tickets.ts` — template fallback resolves this station's own board via `resolveBoardDir(<repo>)`; the "no board" error text drops the `docs/bugs/` literal (it already interpolates the resolved `dir`). The `boardDir` callers at :680/:722 follow the board.ts change.
  - `src/server/wiring.ts` — conventions / board / drift-guard checks resolved (conventions + board via the resolver; the board TOOL via `.orchard/board.mjs`-first-then-`scripts/board.mjs`, so a mid-migration project is not reported broken). All detail strings name the resolved host-relative path.
  - `src/server/templates.ts` — `localConventionsSection()` resolves via `resolveConventionsFile()`; footer names the resolved path. `LOCAL_CONVENTIONS_RELPATH` kept as the legacy default (still consumed by verify-local-conventions to seed a legacy fixture).
  - `src/server/runtime/claude-runtime.ts` — the launch-time Stop-hook re-sync resolves BOTH ends via `resolveStopHookFile()`: dest in the target (`.orchard/hooks/…` preferred, `scripts/hooks/…` legacy) and source in this repo (falls through to legacy). Wiring detection already matched the hook BASENAME so it accepts either command form (comment added). NOTE: this file is shared with the concurrent FEAT-107 `decideGitWrite` lane; edited by hand only.
  - `scripts/board.mjs` — default `--dir` → `resolveBoardDir(process.cwd())` (explicit `--dir` still wins; reject-unknown-args intact). The reachability ride-along's `hostPath` is derived via a resolver ROUND-TRIP GUARD (`resolveBoardDir(host) === dir` else skip) instead of the by-luck `dir/../..` + the misleading comment.
  - `scripts/arch-watch.mjs`, `scripts/board-tool.mjs` — same default-`--dir` / `boardDirOf` resolver change; usage string updated. `ORCHARD_BOARD_TOOL_ROOT` semantics unchanged.
  - `scripts/check-scope.mjs` — fleet CONVENTIONS.md scan resolved. `scripts/gatekeeper.mjs` — DEPLOY-CONTEXT.md resolved; the "declares NO …" string names the resolved path.
  - `scripts/fleet-sync.mjs` — `SYNCED_TOOLS` gains `lib/board-path.mjs`; onboarded-probe becomes `boardLayout(hostPath) !== 'none'`; dry-run dest resolved per-tool (`.orchard/<tool>`-first). See the deviation note below on report labels.
  - `scripts/lib/board-path.d.mts` (NEW) — hand-written types for the resolver, required because this is the FIRST TS import of `board-path.mjs` and the repo types its `.mjs` modules via sidecar `.d.mts` (like `ticket-schema.d.mts`).
  - `scripts/verify-feat-106-readers.mjs` (NEW) + `scripts/verify-fleet-sync.mjs` (one skip-reason regex + one comment updated to the new "no board layout" wording).
- **Verified:**
  - **A (Orchard's board untouched):** my diff touches NO file under `docs/bugs/`; `resolveBoardDir(<repo>)` = `<repo>/docs/bugs`, `boardLayout(<repo>)` = `legacy`; `board.mjs check` exit 0. (The board grew 244→245 during the session, but from an EXTERNAL concurrent lane filing FEAT-107, not from this lane.)
  - **E (real artifact):** `readBoard(<real repo>)` is BYTE-IDENTICAL pre vs post this change (43286 bytes both) — the board endpoint's data is provably unchanged for a legacy project, so the render cannot change. `scripts/verify-ui.ts` boots a real server on a scratch port + temp data dir and renders end-to-end through the changed board.ts/wiring.ts: 7/7.
  - **Module-level E/F/stop-hook:** new `verify-feat-106-readers.mjs` 22/22 over REALISTIC fixtures (each board is a byte copy of the real 244-ticket board placed at docs/bugs vs .orchard/bugs): boardDir/readBoard route per-layout and return identical content; wiringStatus reports board+drift-guard+conventions OK on BOTH; planSweep keeps migrated/adopt-only(declared)/untouched all in scope, skips only the true no-board; localConventionsSection + ensureCurrentStopHook wired in both layouts; snapshot footer names the resolved path.
  - **Must-FAIL baseline:** ran the same suite against the pre-change reader modules — 10 flat-layout assertions FAIL (boardDir, readBoard, wiring, planSweep, conventions, stop-hook, footer), incl. 6b proving a migrated project reports `not-onboarded` at launch without the claude-runtime fix; the legacy assertions pass in both.
  - **Regressions:** `verify-feat-106-board-path` 34/34, `verify-feat-106-layout-independence` 4/0/2skip, `verify-bug-118` 111/111, `verify-local-conventions` 18/18, `verify-check-scope` 12/12, `verify-feat-076-wiring` 36/0, `verify-fleet-sync` 23/0 (was 22/1 at HEAD — my change also fixed a pre-existing failure: commit 1 added `lib/board-path.mjs` to onboard's COPIED_TOOLS but not SYNCED_TOOLS, so the SYNCED⊇COPIED assertion was red at HEAD), `verify-gatekeeper` 31/0, `verify-bug-127-render` 9/9, `verify-bug-067-notice-render` 17/17, `verify-board-rank` 25/25. `npm run typecheck` 0; `npm run gate` 0.
  - **Pre-existing failures (proven identical at HEAD, orthogonal to board-path):** `verify-board-tool` 33/1 (test (c) derives a title from ticket line[0] but real BUG-016 is block-format), `verify-arch-watch` (real-board clustering / git-history / status-mismatch), `verify-ticket-dashboard` (409 rev-race, likely aggravated by the concurrent lane writing docs/bugs), `verify-feat-091-renderer` (`response-blocks.js` missing `fenceSegments` export). All four FAIL byte-for-byte on the pre-change tree.
- **Reader sites the table missed / deviations reported:**
  - `scripts/fleet-sync.mjs` report LABELS (`scripts/<tool>`) were NOT rewritten to `.orchard/<tool>` as the table suggested: onboard (unchanged this commit) still EMITS `scripts/<tool>` labels, so renaming now would break `fleet-sync --apply`'s per-tool outcome on every legacy project. That label/dest rewrite belongs with the onboard cutover (commit 4). Probe + dry-run-dest + SYNCED_TOOLS membership are done.
  - `board.mjs:784` kept `dir/../..` (correct for BOTH legacy and `.orchard/bugs`, which are each two levels below host) but added the resolver round-trip guard so a config-declared board at an odd depth skips instead of misreading.
  - Swept and found no other live readers of `docs/bugs` / `docs/CONVENTIONS.md` / `docs/DEPLOY-CONTEXT.md` / the stop-hook path in `src/server` or the shipped tools. Remaining literals live in `scripts/qa/*.spec.ts` (screenshot output paths into THIS repo's `docs/bugs/assets/`), `scripts/onboard.mjs` (the producer — commit 4), `scripts/wa-consolidate.mjs` / `triage.mjs` / `provenance-check.mjs` / `independent-verify.mjs` (methodology tooling scoped to Orchard's own tree, defaulted `--dir`), and `capture-guide-screenshots.mjs` — none are per-project board readers on the migration path; left for a later pass if ever needed.
- **Could not test:** the live headless-brave screenshot pass on the ticket VIEW (the ticket's "read the screenshots yourself" bar). The real board endpoint is proven byte-identical pre/post and verify-ui renders end-to-end, but a migrated (`.orchard/`) project cannot exist until the commit-4 onboard rewrite, so the flat-layout RENDER can only be driven after that. Recommend the independent clean-room verify pass (this is regression-prone, UI-feeding, session-lifecycle-adjacent code) cover the headless-brave render.
- **Handoff:** NOT committed (user is doing all git ops this session). `board:gen` deliberately NOT run — `docs/bugs/INDEX.md` is dirty from the concurrent FEAT-107 lane and a regen here would race it; regenerate after the tree is committed. Commit 4 (onboard writes `.orchard/`) then flips fleet-sync's labels and the producer.
