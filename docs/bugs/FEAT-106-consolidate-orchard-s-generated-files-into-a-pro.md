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
  "updated": "2026-10-01",
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
  "verification": [
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a0ec00-7ab9-7da2-a286-5c69bbeddf93",
      "verdict": "broken",
      "raw_verdict": "broken",
      "verdict_on": "2026-09-29",
      "harness": "scripts/independent-verify.mjs",
      "line_sha256": "a4767cf0d5f0e4440080b9ec9589affb225cbfc018369192bc9118d8d3ef4ad8",
      "origin": "legacy-prose-freeze"
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a0ed53-3c8f-7480-b2bb-aad5a7318629",
      "verdict": "broken",
      "raw_verdict": "broken",
      "verdict_on": "2026-09-29",
      "harness": "scripts/independent-verify.mjs",
      "line_sha256": "f3d924a8fe1f288093de95402cf1f6c25f167e41be084199f8b3aff551e49645",
      "origin": "legacy-prose-freeze"
    },
    {
      "provider": "anthropic",
      "model": null,
      "run_id": "b0e62aed-e1ef-4a65-96a1-293729c6ba16",
      "verdict": "invalid",
      "raw_verdict": null,
      "verdict_on": "2026-09-29",
      "harness": null,
      "line_sha256": "bedf4e261514ce23e283f4925e6cc69d381b21405b3782ae68b75c571439cfdd",
      "origin": "legacy-prose-freeze"
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a0ee91-aa36-7760-85a4-f856ffac17a1",
      "verdict": "broken",
      "raw_verdict": "broken",
      "verdict_on": "2026-09-29",
      "harness": "scripts/independent-verify.mjs",
      "line_sha256": "a1970f8dec315727734686ef5b7afd7040165718f61f606cd11b737b6b071d16",
      "origin": "legacy-prose-freeze"
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a0f251-8ae5-7c81-937d-d77adc313a70",
      "verdict": "broken",
      "raw_verdict": "broken",
      "verdict_on": "2026-09-30",
      "harness": "scripts/independent-verify.mjs",
      "line_sha256": "fcef3260f2660b1b66818f2da1e97586b0810e319f57b042ce021169fd323d5c",
      "origin": "legacy-prose-freeze"
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "run_id": "f8a7c4dc-c025-4a30-83da-7657d5ba0e8e",
      "verdict": "broken",
      "verdict_on": "2026-10-01",
      "recorded_at": "2026-10-01T11:03:30.525Z",
      "author": "verify-driver",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "round 7: FIFO at target .orchard/config.json hangs onboard/fleet-sync via unguarded readFileSync in board-path.mjs readOrchardConfig (escaped target read)"
    },
    {
      "provider": "openai",
      "model": null,
      "run_id": "01a0f92b-8033-7a91-ac2d-57710204b2a6",
      "verdict": "broken",
      "verdict_on": "2026-10-01",
      "recorded_at": "2026-10-01T20:37:04.545Z",
      "author": "dispatch openai",
      "recorded_by": "board-tool",
      "harness": "scripts/independent-verify.mjs",
      "note": "round 8 cross-provider: readOrchardConfig hang FIXED + symlink-escape HELD, but uncapped fs.readFileSync at onboard.mjs:1111 bytesEqual (via cleanupLegacy->atomicRemoveVerified) reads a whole 16 MiB file on an ordinary editor save - benign cap violation, no hang/no byte loss"
    }
  ],
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

### 2026-09-29 — worker (stage 3 of 3: the producer cutover — PLAN, then build)

- **Understood / scope:** make `scripts/onboard.mjs` + `scripts/fleet-sync.mjs`
  WRITE the `.orchard/` layout the target-layout section specifies (stages 1–2
  already made every READER layout-independent via `board-path.mjs`), plus a
  GUARDED cleanup of the legacy scattered layout in a target. High stakes: this
  deletes files in OTHER repos, so cleanup is dry-run by default, backs up
  before deleting on `--migrate`, and removes ONLY files whose bytes provably
  match this repo's current source (or the exact unedited stub); anything
  diverged is KEPT and reported.
- **Hypothesis check (fork?):** verified the ticket + charter TOGETHER fully
  determine behaviour — no NEW user-only decision remains. The one place that
  looked like a fork — an existing, populated legacy board (`docs/bugs` full of
  the target's own user-authored tickets) on upgrade — is RESOLVED by the
  charter's own high-stakes rule ("cleanup removes only files Orchard provably
  wrote; user-modified is kept"): the board is NOT provably-Orchard-wrote once it
  holds user tickets, so it is never moved or deleted. Design consequence:
  - FRESH onboard (no board anywhere) → board scaffolded at `.orchard/bugs`,
    `config.json` declares `"board": ".orchard/bugs"`.
  - UPGRADE of a legacy target with an existing `docs/bugs` → board LEFT IN
    PLACE, `config.json` declares `"board": "docs/bugs"` (the resolver's
    `declared` layout, built in stage 1 for exactly this). Never relocated.
  Flagged for review: if the user actually wants live boards physically moved to
  `.orchard/bugs`, that is a separate, git-visible relocation, not this lane.
- **Plan (build):**
  1. `onboard.mjs` — one source-of-truth map of every generated file → its
     `.orchard/`-relative dest. Tools (`board.mjs`, `arch-watch.mjs`, `gate.mjs`,
     `leak-gate.mjs`, `check-nul.mjs`) → `.orchard/`; hook → `.orchard/hooks/`;
     the flattened lib closure (verdict-contract, ticket-schema, board-path,
     readability, structure, format-metrics, leak-tokens, + `public/lib/`'s
     digest/dom/route/response-blocks) → `.orchard/lib/`. `public/` is NEVER
     written to a target again.
  2. `.orchard/config.json` (layoutVersion + host-relative board) + nested
     `.orchard/.gitignore` (`bugs/.arch/`, backup dir).
  3. CONVENTIONS.md / DEPLOY-CONTEXT.md scaffold under `.orchard/`; on upgrade a
     filled-in legacy `docs/CONVENTIONS.md` is COPIED into `.orchard/` (content
     preserved) rather than re-stubbed. BUG-146's `CONVENTIONS_STUB` single-source
     is untouched.
  4. `package.json` — the 5 script VALUES re-pointed to `.orchard/…`, but only
     when the existing value is EXACTLY the known legacy value; a customized
     script is kept + reported. Absent keys added with the new value.
  5. `.claude/settings.json` Stop-hook command re-pointed to `.orchard/hooks/…`
     (re-points an exact legacy command in place; merges if absent; never
     clobbers an unparseable/customized file).
  6. Guarded `cleanupLegacy()` — dry-run by default, `--migrate` applies with a
     `.orchard/.legacy-backup-<ts>/` backup first. Deletes a legacy tool file
     only if bytes === current source; the WHOLE root `public/` only if it holds
     nothing but current-source Orchard files (else kept + reported, per the
     recorded migration decision). Idempotent: a second pass finds nothing.
     Operator home dir is out of scope (never enumerated) per the recorded
     decision.
  7. `fleet-sync.mjs` — labels/dests follow onboard's new `.orchard/` output
     (the label rewrite stage 2 deferred here).
  8. Verify: rewrite `verify-onboard.mjs` for the new layout + new
     `verify-feat-106-onboard-orchard-layout.mjs` covering fresh / upgrade /
     user-modified-old-file-survives / idempotent re-run, with a must-FAIL
     against the pre-change onboard. Re-run BUG-146's proof green.
- **Tested ONLY against throwaway temp repos under scratch; NEVER any real repo.**

### 2026-09-29 — worker (stage 3 of 3: BUILT + verified, working-tree only)

- **Changed (all UNSTAGED — user does git):**
  - `scripts/onboard.mjs` — writes the `.orchard/` layout: `orchardFileManifest()`
    (exported) is the single source mapping every generated file → its
    `.orchard/` dest (tools at `.orchard/`, hook at `.orchard/hooks/`, the
    flattened lib closure incl. `public/lib/*.js` at `.orchard/lib/`); NO
    `public/` written. `config.json` (layoutVersion + host-relative board) +
    nested `.gitignore`; board scaffolded at `.orchard/bugs` fresh, legacy
    `docs/bugs` declared IN PLACE (never moved); CONVENTIONS/DEPLOY-CONTEXT
    scaffold under `.orchard/` (a filled-in legacy doc is content-migrated); the
    5 package.json values + the `.claude` Stop-hook command re-pointed to
    `.orchard/` (guarded: only an exact legacy value is re-pointed; a
    customization is kept); guarded `cleanupLegacy()` (`--migrate`) removes only
    byte-matching Orchard files, backs up to `.orchard/.legacy-backup-<ts>/`
    first, keeps user-modified + the whole `public/` if it holds anything
    non-Orchard. Built on top of BUG-146's `conventions-stub.mjs` (untouched).
  - `scripts/fleet-sync.mjs` — sweeps onboard's OWN manifest (no more
    SYNCED_TOOLS list to drift), labels/dests follow `.orchard/`.
  - `scripts/verify-feat-106-onboard-orchard-layout.mjs` (NEW) — fresh / upgrade
    / user-modified-survives / idempotent / flat-closure-imports / MUST-FAIL.
  - Updated fixtures broken by the legitimate output move: `verify-onboard.mjs`,
    `verify-fleet-sync.mjs`, `verify-bug-118` (hook now at `.orchard/hooks/`),
    `verify-bug-146` + `verify-check-scope` (stub at `.orchard/CONVENTIONS.md`),
    `verify-gatekeeper` (stub at `.orchard/DEPLOY-CONTEXT.md`),
    `verify-feat-106-layout-independence` (flat gate fixture now carries
    `.orchard/lib/leak-tokens.mjs`, the dep leak-gate has imported since before
    this stage — the fixture was incomplete for the real flat layout).
- **Verified (temp repos only):**
  - `verify-feat-106-onboard-orchard-layout` **52/0** — incl. F MUST-FAIL: the
    PINNED pre-change onboard (commit `b637ba7`, a fixed SHA not HEAD) writes the
    legacy `scripts/board.mjs` + `public/lib/*.js` and FAILS every new-layout
    assertion; and C: a user-modified `scripts/arch-watch.mjs` SURVIVES
    `--migrate` while a byte-matching `board.mjs` is removed + backed up, and a
    `public/` holding a user `index.html` is kept WHOLE.
  - `verify-onboard` 57/0 · `verify-fleet-sync` 24/0 · `verify-feat-106-board-path`
    34/0 · `verify-feat-106-readers` 22/0 · `verify-feat-106-layout-independence`
    4/0/2skip · `verify-bug-146-conventions-inject` **18/0** (charter-required,
    green) · `verify-check-scope` 12/0 · `verify-gatekeeper` 31/0 ·
    `verify-local-conventions` 18/0.
  - `npm run gate` **exit 0** (leak-gate + check-nul + typecheck all PASS).
    `npm run board:check` exit 0 (advisory/doc-staleness warnings only).
- **One orthogonal failure, NOT FEAT-106:** `verify-bug-118` is 110/1; the single
  FAIL is `C1 … child still carries the parent PATH`, which spawns a real
  `ClaudeRuntime` from `src/server/runtime/claude-runtime.ts` — dirty in the
  working tree from the concurrent FEAT-155/FEAT-156 lanes (new
  `leak-gate-host.ts` import), a file FEAT-106 does not touch. My edits to that
  suite are confined to onboard-output paths (all pass). regressed-from: none by
  FEAT-106; attributable to the concurrent FEAT-156 working-tree state.
- **Hypothesis CONFIRMED:** no NEW user-only decision remained — the ticket +
  the charter's user-data-safety rule together fully determine behaviour
  (declare-in-place for a live legacy board, since user tickets are not
  provably-Orchard-wrote). Flagged for review only: whether the user ever wants
  live boards physically relocated to `.orchard/bugs` (a separate git op).
- **Independent verify WARRANTED (high stakes):** this deletes files in OTHER
  repos. A clean-room / cross-provider pass should exercise the `--migrate`
  cleanup against a realistic legacy target (esp. partial/interrupted migrate,
  a `public/` mixing Orchard + user files, and a diverged tool copy) — generation
  must not be its own only verifier.
- **Still open / handoff:** commit these working-tree files; then the fleet
  rollout (`fleet-sync --apply`) migrates onboarded targets to `.orchard/` tools
  (non-destructive; `--migrate` is the separate, backed-up cleanup step).
- **Symptom of a deeper design flaw?** no — planned consolidation.

### 2026-09-29 — verify driver (independent clean-room pass, cross-provider) — VERDICT: BROKEN

- **Why this pass:** the prior verify lane was killed by a session limit before
  it launched the independent verifier; the ticket carried only the fixer's
  "BUILT + verified, working-tree only" self-check. This is the warranted skeptic
  for a data-loss-class change (a guarded delete of files in a target repo).
- **Requirement graded** (`/tmp/req-FEAT-106.txt`, plain terms, not the fixer's
  prose): onboard writes the consolidated `.orchard/` layout and NEVER writes
  `public/` to a target; a legacy board is declared IN PLACE, never relocated;
  and the guarded `--migrate` cleanup must satisfy three invariants — (a) never
  delete a user-modified or unrecognised file, (b) be reversible (backup before
  delete), (c) be idempotent — with the operator home explicitly out of scope.
  Adversarial cases required: user-modified survivor, unrecognised extra file,
  second consecutive run, partial/interrupted run + backup-recovery check.
- **Command (tilde form):**
  `node scripts/independent-verify.mjs --repo ~/projects/orchard --working-tree --requirement @/tmp/req-FEAT-106.txt --run "node scripts/verify-feat-106-onboard-orchard-layout.mjs" --test-file scripts/verify-feat-106-onboard-orchard-layout.mjs --timeout-min 25 --verdict-out /tmp/verdict-FEAT-106.txt`
  (working-tree snapshot HEAD `a977e76` → tree `78f2945`; fix is UNCOMMITTED —
  `scripts/onboard.mjs` + `scripts/fleet-sync.mjs` both `M` at dispatch, not
  mid-write.)
- **Verdict: BROKEN — VALID** (executed-evidence contract satisfied: fixer test
  re-run + 3 adversarial cases the fixture does not cover + explicit could-not-test
  list; all manifest-backed). Exit 1.
  - Fixer test re-run in the room: **48 pass, 1 fail** — the sole fail is section
    F (`git show <pinned-sha>:scripts/onboard.mjs`), an INFRA artifact: the clean
    room is a `git archive` export with no `.git`. Flagged as such in the
    requirement; NOT a product defect.
  - **FINDING 1 (symlink escape — most serious):** `cleanupLegacy` FOLLOWS a
    `target/public` symlink and deletes `lib/dom.js` on the OTHER side of it. In
    the adversarial fixture `public` symlinked to a throwaway operator-HOME dir;
    cleanup traversed the link and removed a file there — violating both invariant
    (a) (deletes outside the managed set) and the recorded "operator home is out
    of scope / never enumerate or delete there" migration decision. Cleanup must
    refuse to traverse a symlink out of the target.
  - **FINDING 2 (TOCTOU data loss — invariants b+c):** `backupAndRemove` copies
    the file to the backup, THEN deletes the original. A user edit written into
    the window between those two steps is lost: the original is deleted and the
    backup holds only the pre-edit bytes, so neither the live file nor any backup
    retains the edited content — a genuine (if narrow) data-loss + reversibility
    hole. The interrupted-migration case (exception after backup, before delete)
    itself CONVERGED correctly on re-run and PASSED — the loss is specifically the
    concurrent-write-between-backup-and-delete race, not the interrupt-resume path.
- **Could-not-test (verifier's own list):** actual process-termination / power-loss
  durability (interruption was an injected filesystem exception, not a real kill);
  the pinned pre-change baseline (no git history in the clean room, per above).
- **Outcome:** ticket LEFT OPEN. BROKEN + VALID means the fix does NOT hold — do
  not commit as-is and do not mark VERIFIED. Both findings are in the guarded-delete
  path (`cleanupLegacy` / `backupAndRemove` in `scripts/onboard.mjs`); a fix lane
  should: refuse symlink traversal out of the target during cleanup, and close the
  backup→delete window (e.g. re-hash the file immediately before delete and abort
  if it changed since backup, or rename-into-backup rather than copy-then-delete).
- **Note for the user (guarded-delete awareness):** even had this HELD, a change
  that deletes files in other repos merits your awareness before rollout;
  `--migrate` is the destructive step and stays opt-in.
- **Verified-by:** dispatch openai run 01a0ec00-7ab9-7da2-a286-5c69bbeddf93
  (clean-room, `scripts/independent-verify.mjs`; cross-provider, author=anthropic
  → verifier=openai) — VERDICT: BROKEN

### 2026-09-29 — worker (round 2: close the two data-loss findings — DESIGN fix)

- **Understood:** the openai clean-room found two data-loss holes in the guarded
  cleanup. Fixed the DESIGN (a stated, tested invariant), not the two instances.
- **The invariant (now written at the top of the cleanup section + tested):**
  cleanup only ever removes a REGULAR FILE that lies INSIDE the target repo
  (realpath-checked; a symlink is never followed or traversed), whose bytes AT
  THE MOMENT OF REMOVAL equal the bytes backed up and hash-matched as
  Orchard-written.
- **Changed (`scripts/onboard.mjs`, working-tree only):**
  - `safeRemovable(rootReal, rel)` — walks the path component-by-component with
    `lstat` (like the store-isolation guard), REFUSING the instant any component
    is a symlink or a non-directory ancestor, requiring the leaf to be a regular
    file, then realpath-confining under the resolved repo root. Closes FINDING 1
    (a `public` → operator-HOME symlink is never traversed).
  - `scanNoFollow` replaces the old `readdirSync`-recursing `listFilesRecursive`:
    it flags any symlink / non-regular entry and NEVER follows it; a `public/`
    holding any symlink is KEPT WHOLE. `public` itself is `lstat`-checked and
    kept if it is a symlink.
  - `atomicRemoveVerified` replaces `backupAndRemove` (copy-then-delete): removal
    is an ATOMIC `rename` INTO the backup dir, after which the moved copy is
    re-hashed against the Orchard source; a file changed between the hash-match
    and the rename is renamed straight BACK and KEPT. Closes FINDING 2 (the
    copy→edit→delete TOCTOU) — the backed-up bytes ARE the removed bytes, and the
    file is never in a half-state. A cross-fs/permission error refuses rather than
    falling back to the unsafe copy-then-delete. `cleanupLegacy` RE-CHECKS
    `safeRemovable` at apply time (not just classification), so a file that turns
    into a symlink after the scan is skipped.
  - Exported `safeRemovable`, `atomicRemoveVerified`, `resolveRootReal` for direct
    unit tests.
- **Verified — `scripts/verify-feat-106-cleanup-safety.mjs` (NEW) 31/0**, temp
  repos ONLY. Both verifier repros as non-vacuous must-FAIL-before / PASS-after:
  - S1 symlinked `public`→outside: a link-following scan REACHES the outside dir
    (trap is real); `--migrate` leaves the operator sentinel + baited `dom.js`
    intact and keeps the symlink.
  - T1 TOCTOU: the naive copy-then-delete LOSES a windowed edit (backup=old,
    original gone); `atomicRemoveVerified` on bytes-that-differ RESTORES the file
    intact, and a matching file is removed atomically into the backup.
  - Generalisations: S2 symlinked dir at depth ≥2 + symlinked `scripts/lib`; S3
    symlinked FILE (tool path and public file). Named attacks I ran myself: X1
    hardlink (content survives at the other link; only our entry removed), X2 the
    target dir is itself a symlink (cleanup stays confined to the resolved repo),
    X3 permission-denied mid-cleanup (rename refuses → file INTACT, no partial
    state, nothing orphaned in the backup). U1–U4 unit-check `safeRemovable`.
  - Nothing declined: every attack in the class I could name is closed and tested.
- **Anti-regression (all green):** `verify-feat-106-onboard-orchard-layout` 52/0,
  `verify-onboard` 57/0, `verify-fleet-sync` 24/0, `verify-feat-106-board-path`
  34/0, `verify-feat-106-readers` 22/0, `verify-feat-106-layout-independence`
  4/0/2skip. `npm run gate` **exit 0**, `npm run board:check` exit 0.
- **Could-not-test (same as the verifier):** real process-kill / power-loss
  durability — the atomic `rename` is the mitigation (a kill mid-rename leaves the
  file at exactly one of the two paths, never lost), but true power-loss fsync
  durability is not exercised offline; and the pinned pre-change baseline needs a
  `.git` (absent in a clean-room archive).
- **Independent re-verify still WARRANTED** (data-loss class): a fresh
  cross-provider pass should re-run the two original repros + these
  generalisations against the working tree.
- **Still open:** ticket stays OPEN / not VERIFIED (my own suite is not the last
  word). Handoff: re-dispatch the clean-room verify against the round-2 tree.
- **Symptom of a deeper design flaw?** no — planned consolidation; the round-1
  cleanup simply under-specified its safety invariant, now stated + enforced.

### 2026-09-29 — worker (round 3: stale delivered-path assertions in other suites)

- **Understood:** the `.orchard/` relocation broke suites that assert onboard's
  DELIVERED paths inside an onboarded project. `verify:feat-091` [6] onboarding
  delivery went 11/11 → 8 fail at HEAD-in-worktree; my round-1/2 anti-regression
  list missed it. Task: fix [6] keeping each check's strength, then SWEEP the
  whole `scripts/` tree for the same staleness and fix it the same way.
- **verify:feat-091 counts: BEFORE 279 pass / 8 fail → AFTER 288 pass / 0 fail.**
  Fixed only the [6] section (built on FEAT-091 round-15's unstaged edit): the
  five delivered paths → `.orchard/hooks/…` + `.orchard/lib/…`; byte-identity of
  `public/lib/response-blocks.js` (source) → `.orchard/lib/response-blocks.js`
  (delivered); the COPIED hook now runs from `.orchard/hooks/…` and exits 0; and
  metrics recorded + block-accounting all preserved.
- **Sweep — other suites/tools that hard-coded a pre-`.orchard/` delivered path,
  all fixed the same way (each strength kept):**
  - `scripts/verify-feat-089-method-auto.mjs` — board/conventions/drift-guard/hook
    closure/gate/`gate` npm value/hook-executes + the idempotence watch-list all
    → `.orchard/`. 7 fails → **VERDICT PASS 35/0**.
  - `scripts/verify-ticket-schema.mjs` (H) — copied `ticket-schema.mjs` and the
    board run → `.orchard/lib` + `.orchard/board.mjs`/`.orchard/bugs`; the
    load-bearing non-vacuity (remove the copy → board breaks) preserved. **64/0**.
  - `scripts/qa/FEAT-038-onboard-ui.spec.ts` — `ARTIFACTS` list + the copied
    `board:check` run → `.orchard/` (Playwright spec; paths corrected, not
    executed in this lane — needs the browser harness).
  - `scripts/board-tool.mjs` `runGate()` (a TOOL, not a test) — now resolves
    `.orchard/gate.mjs` first, then legacy `scripts/gate.mjs`, so a migrated
    target's gate is found while Orchard's own repo is unchanged.
  - Swept-and-cleared (NOT stale): `verify-unmappable-status.mjs` +
    `verify-feat-156` build hand-made board fixtures / reference THIS repo, not
    onboard output; `verify-bug-177` `~/scripts/hooks/…` is a canned error-string
    fixture, not a path assertion; my own FEAT-106 tests build legacy fixtures
    deliberately.
- **Anti-regression list AMENDED** for this ticket: add `verify:feat-091`,
  `verify-feat-089-method-auto`, `verify-ticket-schema`, `verify-board-tool`, and
  the FEAT-038 qa spec to the FEAT-106 rerun set — any suite that onboards a
  target and inspects delivered paths.
- **Verified:** the four fixed node suites green (288/0, 35/0, 64/0, and the
  cleanup/onboard suites from rounds 1–2 unchanged); `verify-board-tool` 33/1 —
  the 1 fail is the pre-existing BUG-016 title-derivation case (all gate-path
  checks pass; my `runGate` edit is orthogonal). `npm run gate` **exit 0**,
  `npm run board:check` exit 0, `ticket-leak-gate` exit 0.
- **Symptom of a deeper design flaw?** partial-yes (process, not code): a
  producer-path change needs a tree-wide sweep for consumers that assert the old
  paths — three rounds each surfaced another. The durable fix is a resolver the
  suites share, but that is a larger follow-up; noted, not built here.

### 2026-09-29 — verify driver (round 2/3 independent clean-room pass, cross-provider) — VERDICT: BROKEN

- **Why this pass:** the prior verify lane for rounds 2+3 was killed by a session
  limit before it recorded a verdict — the ticket carried only round 1's BROKEN
  entry (run `01a0ec00`) and the fixer's round-2/3 self-checks. This is the
  warranted skeptic for a data-loss-class change (guarded delete of files in a
  target repo). Fix is UNCOMMITTED (`--working-tree`).
- **Requirement graded** (`/tmp/req-FEAT-106-r23.txt`, plain terms — reframed
  attack on the round-2 redesign, not round 1's already-closed symlink/TOCTOU
  repros). Base invariants held over cleanup: (a) never delete a user-modified /
  unrecognised / non-regular file, (b) reversible (removed bytes == backed-up
  bytes, no lost-window), (c) idempotent; never traverse a symlink out of the
  target; operator home out of scope. Round-2 attacks on the new atomic
  rename-into-backup -> re-hash -> rename-back design: backup on another filesystem
  (EXDEV), rename-BACK failure, backup NAME collision, a symlink swapped in
  between lstat and rename, case-insensitive / unicode-normalised names. Round-3
  attacks: for each of the 4 relocated suites, same-strength at the `.orchard/`
  path (byte-identity of delivered content; hook ACTUALLY RUNS; non-vacuity
  intact); board-tool's `.orchard/gate.mjs`-first lookup not attacker-pointable;
  confirm verify-board-tool's 1 fail is pre-existing BUG-016 at HEAD.
- **Command (tilde form):**
  `node scripts/independent-verify.mjs --repo ~/projects/orchard --working-tree --requirement @/tmp/req-FEAT-106-r23.txt --run "node scripts/verify-feat-106-cleanup-safety.mjs" --test-file scripts/verify-feat-106-cleanup-safety.mjs --timeout-min 25 --verdict-out /tmp/verdict-FEAT-106-r23.txt`
  (`scripts/onboard.mjs` `M` at dispatch, `node --check` clean — NOT mid-write;
  round-2 exports `safeRemovable`/`scanNoFollow`/`atomicRemoveVerified`/
  `resolveRootReal` all present.)
- **Verdict: BROKEN — VALID** (exit 1; executed-evidence contract satisfied:
  fixer test re-run + a distinct adversarial harness the fixture does not cover +
  explicit could-not-test list; all manifest-backed).
  - Fixer test re-run in the room: **31 pass, 0 fail** (manifest
    `181d2a4b46d3`) — the round-2 cleanup-safety suite is green in the clean room,
    and the two round-1 repros (S1 symlink-escape, T1 windowed-edit TOCTOU) stay
    closed.
  - **FINDING 1 (backup-destination collision):** `atomicRemoveVerified` renames a
    file INTO the backup dir with `renameSync`, which OVERWRITES a pre-existing
    entry of the same backup basename — its unique prior bytes are destroyed
    (`priorBackupSurvives:false`). Two legacy files mapping to one backup name, or
    a backup dir that already holds that name, silently lose data. Violates (b).
  - **FINDING 2 (restore-collision, silent user-file loss):** when the file's
    bytes change between the hash-match and the rename, round 2 renames it BACK to
    the original path to keep it — but if a NEW user file now occupies that
    original path, the rename-BACK OVERWRITES it and the tool reports `KEPT`. A
    user file created in that window is destroyed with no backup. Violates (a)+(b).
  - **FINDING 3 (ancestor-swap TOCTOU — symlink escape re-opened):** swapping the
    `scripts/` ancestor dir for an outside-pointing symlink AFTER `safeRemovable`
    succeeds but BEFORE the rename causes `atomicRemoveVerified` to move the
    OUTSIDE file into the backup and report `removed:true`. The apply-time
    `safeRemovable` re-check does not re-validate every ancestor at the instant of
    the rename, so round 1's FINDING-1 escape class is not fully closed for
    ancestor components. Violates (a) + the operator-home-out-of-scope decision.
  - Adversarial harness `adversarial-cleanup.mjs` (manifest `d634921a0be7`,
    exit 1) — 3/3 invariant failures, each a case the fixer fixture never
    exercises (pre-populated backup dest; a new live entry during restore; an
    ancestor swapped immediately before rename).
- **Could-not-test (verifier's own list, honest):** real EXDEV and
  case-insensitive/unicode-normalising filesystem behaviour (fixtures used one
  workspace fs); restore-under-permission-failure (the restore attack instead used
  an occupied original path); and — an ARCHITECTURAL clean-room limit — most of
  ROUND 3: the clean room strips `docs/bugs/` and exports without `.git`, so
  ticket-schema/board-tool suites stopped on missing `docs/bugs`, the
  response-blocks recorder was unavailable, and BUG-016-at-HEAD could not be diffed
  (no git history). Round-3's delivered-path strength and the board-tool gate
  lookup were therefore NOT independently graded this pass — the fixer's own
  round-3 greens (feat-091 288/0, feat-089 35/0, ticket-schema 64/0) stand
  un-refuted but also un-verified here.
- **Outcome:** ticket LEFT OPEN. BROKEN + VALID -> the round-2 cleanup redesign
  does NOT hold — do not commit as-is, do not mark VERIFIED. All three findings are
  in the guarded-delete path (`atomicRemoveVerified` in `scripts/onboard.mjs`). A
  fix lane should: (1) refuse (never overwrite) when the backup dest already
  exists — fail closed or use a collision-proof backup name; (2) on rename-BACK,
  refuse if the original path is now occupied rather than clobbering it; (3)
  re-validate the FULL ancestor chain (or hold a dir-fd / O_NOFOLLOW handle opened
  during safeRemovable) at the instant of the rename so an ancestor swapped after
  the check cannot redirect the move outside the target.
- **Round-3 handoff:** the clean room cannot grade the relocated delivered-path
  suites (needs `docs/bugs` + `.git`). If round-3 strength must be independently
  confirmed, verify it in-repo against the working tree (not a stripped clean
  room), or exclude only the ticket under test — the suites depend on the board
  surface the room removes by design.
- **Verified-by:** dispatch openai run 01a0ed53-3c8f-7480-b2bb-aad5a7318629
  (clean-room, `scripts/independent-verify.mjs`; cross-provider, author=anthropic
  -> verifier=openai) — VERDICT: BROKEN

### 2026-09-29 — worker (round 4: close the three atomicRemoveVerified findings)

- **Understood:** the round-2/3 verify (openai 01a0ed53) found 3 holes in
  `atomicRemoveVerified`, all in the guarded-delete path. Fixed the DESIGN with a
  stated + tested invariant; the coordinator's decisions on each are implemented.
- **Invariant, extended:** cleanup removes only a regular file inside the target
  (realpath-checked; symlinks never followed/traversed) whose bytes at removal
  equal the hash-matched Orchard bytes — AND no byte the user had before
  onboarding, or wrote during it, is ever destroyed: every removed file exists
  byte-identical in the run's backup dir.
- **Changed (`scripts/onboard.mjs`, working-tree only):**
  - `noClobberMove(src,dst)` — `link()`+`unlink()`. `link()` FAILS (EEXIST)
    rather than overwriting an existing `dst`, and never crosses a filesystem
    silently (EXDEV → throw). A crash between the two steps leaves both names on
    one inode — no byte lost. This is the collision-proof move primitive.
  - `atomicRemoveVerified` now uses `noClobberMove` in BOTH directions: the
    forward move refuses onto an existing backup entry (**FINDING 1**), and the
    restore refuses to overwrite a NEW file that took the original path
    (**FINDING 2**) — leaving the removed bytes safe in the backup and reporting.
  - `cleanupLegacy` creates a FRESH per-run backup dir with `fs.mkdtempSync`
    (collision-proof even within one millisecond — **FINDING 1**), only in the
    apply branch.
  - **FINDING 3** (ACCEPTED adversarial race, narrowed): `safeRemovable` now
    returns the parent's realpath; the apply loop re-validates it immediately
    before each move and, on any mismatch — or a scan-safe file that has become a
    symlink/non-regular since — ABORTS the whole cleanup, leaving everything else
    in place. The residual mid-move race is documented as out of the threat model.
  - **THREAT MODEL stated** in the cleanup section header (and summarised in the
    ticket): defends benign concurrency (the user editing/creating their OWN files
    during onboarding); does NOT defend an adversary with write access to the
    target during onboarding (who could do worse directly), so no openat/dir-fd
    machinery is built — the ancestor-swap race is narrowed, not closed, by design.
- **Verified — `scripts/verify-feat-106-cleanup-safety.mjs` 49/0** (was 31; +18),
  temp repos ONLY, each finding non-vacuous must-FAIL-before / PASS-after:
  - F1 backup collision: a naive rename INTO a pre-populated backup destroys the
    prior bytes; `atomicRemoveVerified` REFUSES (no-clobber), prior bytes + source
    survive; and each `--migrate` run uses a unique mkdtemp dir (the first backup
    survives a second run). Generalisation covered.
  - F2 restore collision: a naive rename-back destroys a new user file at the
    original path; the restore primitive REFUSES (EEXIST), the new file survives,
    the removed bytes stay in the backup. Generalisation: a DIRECTORY occupant is
    also never clobbered.
  - F3 ancestor-swap: the parent-realpath re-check DETECTS an ancestor swapped to
    an outside symlink (the abort trigger); the outside file is never reached.
  - E1 EXDEV (real: /tmp btrfs vs /dev/shm tmpfs) — the cross-fs move REFUSES,
    source intact. E2 read-only backup dir — refuses, source intact, nothing
    orphaned. Round-1/2 repros (S1–S3, T1, X1–X3, U1–U4) all still green.
- **Anti-regression (all green):** `verify-feat-106-onboard-orchard-layout` 52/0,
  `verify-onboard` 57/0, `verify-fleet-sync` 24/0, board-path 34/0, readers 22/0,
  layout-independence 4/0/2skip, `verify:feat-091` 298/0, feat-089 35/0,
  ticket-schema 64/0. `npm run gate` **exit 0**, `board:check` exit 0,
  `ticket-leak-gate` exit 0.
- **Could-not-test:** the actual mid-move ancestor-swap race (inherently timing;
  narrowed + accepted per the threat model, tested at the trigger level); true
  power-loss fsync durability (link+unlink is crash-safe by construction — both
  names on one inode — but offline power-loss is not exercised).
- **Independent re-verify still WARRANTED** (data-loss class): re-run the three
  findings + generalisations against the round-4 tree. Ticket stays OPEN / not
  VERIFIED.
- **Symptom of a deeper design flaw?** no — the safety invariant simply had to be
  discovered adversarially, round by round; it is now explicit, enforced, and
  tested, with the accepted residual race named.

### 2026-09-29 — verify driver (round 4b: suite-strength of the round-3 `.orchard/` relocation — OPTION-B in-repo, read-only)

- **Why option-b, not a clean room:** round 3 relocated the suites that assert
  onboard's DELIVERED paths to `.orchard/`. The round-2/3 clean room (openai
  01a0ed53) COULD NOT grade this — it strips `docs/bugs/` and exports without
  `.git`, so the ticket-schema/board-tool suites stop on missing `docs/bugs`. So
  this is a SEPARATE-PROCESS, READ-ONLY dispatch against the LIVE working tree via
  `scripts/dispatch.mjs`. Reduced isolation (the verifier can see the board/docs);
  decorrelation is lower than a clean room — recorded here and in the Verified-by.
  This pass grades ONLY the suite-strength dimension; the cleanup DATA-LOSS
  dimension (round-4 `atomicRemoveVerified`) is covered separately by FEAT-106
  r4(a) on OpenAI.
- **Command (tilde form):**
  `export CLAUDE_CONFIG_DIR=<grey account dir>; node scripts/dispatch.mjs --provider anthropic --cwd ~/projects/orchard --sandbox read-only --allow-tools "Bash Read Grep Glob" --timeout-min 20 --meta-out /tmp/meta-FEAT-106-r4b.json --ticket FEAT-106 --phase verifying --round 4 --class verify --prompt-stdin`
  (verifier given: the strength-preservation property, the `git diff` of each of
  the 4 suites + `board-tool.mjs` in `/tmp/feat-106-r4b-diffs.txt`, and RUN
  instructions — NOT the fixer's prose. Run id
  `b0e62aed-e1ef-4a65-96a1-293729c6ba16`, exit 0.)
- **Per-suite strength verdicts (all PASS — same strength at the `.orchard/` path):**
  - `verify-feat-091-response-blocks.mjs` [6] — **PASS.** Still reads the DELIVERED
    `.orchard/lib/response-blocks.js` and compares byte-for-byte (`a === b`) to the
    source `public/lib/response-blocks.js`; still SPAWNS the copied hook at
    `.orchard/hooks/response-format-gate.mjs` and asserts exit 0 + metrics + block
    counts. Only path strings changed. `npm run verify:feat-091` → **304/0**.
  - `verify-feat-089-method-auto.mjs` — **PASS.** Existence checks stay existence
    checks; `scripts.gate === 'node .orchard/gate.mjs'` still an exact string match;
    hook still run via `execFileSync` with exit 0 asserted; idempotence still
    compares mtime + content. `npm run verify:feat-089` → **35/0**.
  - `verify-ticket-schema.mjs` (H) — **PASS.** Byte-identity vs source kept; copied
    `.orchard/board.mjs check --dir=.orchard/bugs` still actually run; the
    load-bearing must-fail kept (`rmSync(copied)` → run must exit non-zero and
    mention `ticket-schema`). `npm run verify:ticket-schema` → **64/0**.
  - `qa/FEAT-038-onboard-ui.spec.ts` — **PASS (inspection only, not executed** —
    Playwright/browser harness). `ARTIFACTS` list keeps its 6 entries remapped 1:1
    (`CLAUDE.md` stays at root); the copied board check still spawned from
    `.orchard/board.mjs` against `.orchard/bugs`, exit 0 expected.
- **BUG-016 pre-existing? YES for the FEAT-106 dimension — but the fixer's "33/1"
  COUNT is now stale.** `npm run verify:board-tool` → **27/7** (exit 1) in the
  current live tree. 1 failure is the genuine BUG-016 title case — `(c) restored
  row's title is DERIVED from the ticket H1`: the H1 of `BUG-016-*.md` is now an
  ` ````orchard-ticket ` fence so the derived title is null. The OTHER 6 (`a`,
  `c`-clean, `e0`, `e`, `f`, `g`) all report the SAME board problem —
  `UNPARSEABLE DECISION: FEAT-157`, an UNTRACKED ticket from unrelated uncommitted
  work polluting the live board — NOT the `.orchard/` change. The suite never
  calls `runGate()`, so board-tool.mjs's `.orchard/gate.mjs`-first lookup edit
  cannot be behind ANY of these failures. Net: none of the 7 failures depend on
  FEAT-106; the count differs from round 3 only because the dirty tree gained
  FEAT-157.
- **Reduced-isolation caveat:** option-b in-repo (not a clean room), so the
  verifier saw the board/docs — decorrelation is lower than the r1/r2/r3 openai
  clean-room passes. This grades suite-strength ONLY.
- **Outcome:** suite-strength dimension of round 3 HOLDS (4/4 PASS); board-tool
  failures confirmed independent of FEAT-106. Status NOT flipped to VERIFIED on
  this alone — the cleanup data-loss dimension (FEAT-106 r4(a)) is the gating
  verify for closing this ticket.
- **Verified-by:** dispatch anthropic run b0e62aed-e1ef-4a65-96a1-293729c6ba16
  (option-b in-repo, read-only, reduced isolation) — suite-strength 4/4 PASS;
  board-tool failures pre-existing/unrelated to FEAT-106.

### 2026-09-29 — verify driver (round 4a: cleanup-safety of the round-4 `noClobberMove` primitive, clean-room cross-provider OpenAI) — VERDICT: BROKEN

- **Why this pass:** round 4 replaced the guarded-delete internals with a new
  `noClobberMove` (link+unlink) primitive, a per-run `mkdtemp` backup, and a
  parent-realpath abort. This is the warranted skeptic for that data-loss-class
  change — the CLEANUP-SAFETY dimension. (The suite-strength dimension is graded
  separately by round 4b, run b0e62aed, which HELD 4/4.) Fix is UNCOMMITTED
  (`--working-tree`): `scripts/onboard.mjs` `M`, `scripts/verify-feat-106-cleanup-safety.mjs`
  untracked (both `node --check` clean, not mid-write; exports present).
- **Requirement graded** (`/tmp/req-FEAT-106-r4a.txt`, plain terms + a filled-in
  citation-block example so the OpenAI verifier could not slip the citation
  format). Base invariants over cleanup: never delete a user-modified/unrecognised
  file; reversible (removed bytes == backed-up bytes, nothing destroyed);
  idempotent. Attacks on the NEW primitive: `link()` unsupported/refused
  (EPERM/ENOSYS/EXDEV) — what fallback, does no-clobber hold; original already has
  nlink>1; `unlink` failing after `link` succeeded (two names, reported?); mkdtemp
  in a user-controlled/hostile location; and whether the parent-realpath
  abort-on-mismatch actually fires. The adversarial ancestor-SWAP race was
  DECLARED OUT OF SCOPE per the threat-model header and not to be counted.
- **Command (tilde form):**
  `node scripts/independent-verify.mjs --repo ~/projects/orchard --working-tree --requirement @/tmp/req-FEAT-106-r4a.txt --run "node scripts/verify-feat-106-cleanup-safety.mjs" --test-file scripts/verify-feat-106-cleanup-safety.mjs --timeout-min 25 --verdict-out /tmp/verdict-FEAT-106-r4a.txt`
  (working-tree snapshot HEAD `a977e76` → tree `ebc0a41`; verifier openai via
  dispatch, author-provider anthropic → cross-provider.)
- **Verdict: BROKEN — VALID** (exit 1; executed-evidence contract satisfied: fixer
  test re-run + two adversarial cases the fixture does not cover + explicit
  could-not-test list; all manifest-backed, 8 recorded runs).
  - Fixer test re-run in the room: **49 pass, 0 fail** (manifest `c215890520bc`) —
    the round-4 cleanup-safety suite is green in the clean room; the round-1/2/3
    repros (S1–S3 symlink-escape, T1 windowed-edit, X1–X3, U1–U4, F1/F2 collision,
    F3 ancestor-swap detection, E1 EXDEV, E2 read-only backup) all stay closed.
  - **link-refused adversarial HELD** (manifest `2cbe2986fb64`, exit 0): injecting
    EPERM / ENOSYS / EXDEV from `link()` makes `noClobberMove` REFUSE and leave the
    source bytes intact with NO silent copy — the unsupported-filesystem attack in
    the charter is closed.
  - **FINDING (concurrent editor atomic-save — data-loss, invariant b):** an
    editor-style atomic save (write temp + `rename` onto the original) that lands
    BETWEEN the `link()` and the `unlink()` inside `noClobberMove` destroys the
    user's NEW bytes. `link()` backs up the OLD inode; the editor's rename repoints
    the ORIGINAL PATH at the user's new inode; `unlink(path)` then removes that new
    inode (its only name), and the backup holds only the old Orchard bytes. Net:
    the user's new save survives NEITHER at the original path NOR in the backup,
    yet `atomicRemoveVerified` returns `removed:true` (a falsely-clean report).
    Manifest `a5f00385da2b`, exit 1, `originalExists:false backupHasUserSave:false
    backupMatchesOldSource:true`. This is benign concurrency (a user editing their
    OWN file with an ordinary editor) — exactly what the threat-model header CLAIMS
    to defend — and it is NOT the out-of-scope ancestor-swap race; it re-opens the
    round-1 T1 TOCTOU class through inode-swap (link resolves the inode, unlink
    resolves the path, and they diverge when the leaf is atomically replaced).
- **Could-not-test (verifier's own list):** real power-loss fsync durability;
  hostile backup-parent behaviour; whole-cleanup abort propagation; concurrent-save
  timing was injected deterministically rather than by a real race.
- **Outcome:** ticket LEFT OPEN — NOT flipped to VERIFIED. BROKEN + VALID means the
  round-4 cleanup does NOT hold; do not commit as-is. DATA-LOSS → priority. The
  hole is in `noClobberMove` / `atomicRemoveVerified` in `scripts/onboard.mjs`: the
  primitive assumes the leaf at `abs` is the same inode at unlink as at link, which
  an atomic-save rename breaks. A fix lane should make the removal unlink the exact
  inode it backed up (not re-resolve the path) — e.g. verify the leaf's identity
  (dev/ino) immediately before unlink and abort/keep on mismatch, or open a handle
  to the backed-up inode and operate on it — so a benign concurrent replace can
  never be silently deleted. NOTE: round 4b (suite-strength) HELD, but this gating
  cleanup dimension is BROKEN, so the ticket does not close.
- **Verified-by:** dispatch openai run 01a0ee91-aa36-7760-85a4-f856ffac17a1
  (clean-room, `scripts/independent-verify.mjs`; cross-provider, author=anthropic
  → verifier=openai) — VERDICT: BROKEN

### 2026-09-30 — worker (round 5: close the concurrent atomic-save inode race)

- **Understood:** round-4a verify (openai 01a0ee91) found the round-4 `link()`
  +`unlink()` FORWARD move loses data: an editor's atomic save (`rename` a new
  file over the original) landing BETWEEN the link and the unlink makes
  `unlink(path)` destroy the user's NEW inode — `link` backed up the OLD inode,
  the save repointed the path at the NEW inode, `unlink` removed it, and the
  report still said `removed:true`. Benign concurrency, exactly what the header
  claims to defend. The bug: the primitive re-resolved the PATH at unlink instead
  of removing the exact inode it captured.
- **Invariant, sharpened to INODES:** every inode observed at a cleanup path at
  any moment during the run still exists afterwards — at the path or in the run's
  backup dir.
- **Changed (`scripts/onboard.mjs`, working-tree only):** the FORWARD move is now
  a SINGLE atomic `rename(original → uniqueBackupPath)` (into the fresh mkdtemp
  backup dir; refuses if `dest` somehow pre-exists — keeps round-3 FINDING-1
  protection). rename captures exactly the inode at the path at that instant and
  never unlinks the path, so there is no link/unlink window: an atomic save either
  precedes the rename (captured → hash-fail → put back) or follows it (the path is
  already free; the save recreates it; we never touch that path again). The
  PUT-BACK is unchanged — no-clobber `link()`+`unlink(backupName)` (drops the
  backup name whose inode we hold, never the original path; refuses EEXIST if the
  path was re-occupied — round-3 FINDING 2). EXDEV still refuses, never copy+delete.
  Added an `afterCapture`/`beforePutBack` TEST-ONLY hook seam (undefined in
  production) so the race is injected deterministically. Header invariant + threat
  model updated.
- **Verified — `verify-feat-106-cleanup-safety.mjs` 58/0** (was 49; +9), temp
  repos ONLY:
  - AS non-vacuity: the round-4 link+unlink forward, with a save injected in the
    window, LOSES the new inode (neither at path nor in backup) — the exact
    verifier repro.
  - AS1 (THE fix): save AFTER capture with Orchard bytes → `removed:true` AND the
    user's new save SURVIVES at the path, the Orchard bytes survive in the backup.
  - AS2/AS3: save after capture / during put-back with non-Orchard bytes →
    `KEPT-in-backup`, the new file untouched, captured bytes in the backup.
  - AS4: repeated saves → no loss, valid outcome. All round-1..4 cases (S1–S3, T1,
    X1–X3, U1–U4, F1/F2/F3, E1 real-EXDEV, E2 read-only backup) stay green.
- **Anti-regression (all green):** onboard-orchard-layout 52/0, onboard 57/0,
  fleet-sync 24/0, board-path 34/0, readers 22/0, layout-independence 4/0/2skip,
  verify:feat-091 308/0, feat-089 35/0, ticket-schema 64/0. `npm run gate` exit 0,
  `board:check` exit 0, `ticket-leak-gate` exit 0.
- **Could-not-test:** real power-loss fsync durability (rename is atomic by
  construction — the inode is at the path or the backup, never nowhere — but
  offline power-loss is not exercised); the injected saves are deterministic hook
  seams, not a real scheduler race (the seam sits at the exact instants a real
  race could occur).
- **Independent re-verify still WARRANTED** (data-loss class): re-run the
  atomic-save repro + generalisations against the round-5 tree. Ticket stays OPEN
  / not VERIFIED.
- **Symptom of a deeper design flaw?** no — the invariant needed to be discovered
  at inode granularity, which took an adversarial round to surface; it is now
  explicit, enforced by a single capturing rename, and tested.

### 2026-09-30 — verify driver (round 5: cleanup-safety of the single-rename capture, clean-room cross-provider OpenAI) — VERDICT: BROKEN

- **Why this pass:** round 5 replaced the round-4 `link()`+`unlink()` forward move
  with a SINGLE atomic `rename(original → uniqueBackupPath)` plus a dest-exists
  guard and an `afterCapture`/`beforePutBack` test-only hook seam, to close the
  round-4a concurrent-atomic-save inode race. This is the warranted skeptic for
  that data-loss-class change (guarded delete of files in a target repo). Fix is
  UNCOMMITTED (`--working-tree`): `scripts/onboard.mjs` `M`,
  `scripts/verify-feat-106-cleanup-safety.mjs` untracked (both `node --check`
  clean, not mid-write; exports present; suite 58/0 in-repo before dispatch).
- **Requirement graded** (`/tmp/req-FEAT-106-r5.txt`, plain terms + a filled-in
  citation-block example so the OpenAI verifier could not slip the citation
  format). Confirm the INODE-CONSERVATION invariant holds across: a backup-name
  race (something occupying the unique backup dest between the dest-exists CHECK
  and the RENAME); a hardlinked original (nlink>1); a DIRECTORY or FIFO at a
  cleanup path at capture time; whether the test-hook seam is INERT in production
  (no env/arg can set afterCapture/beforePutBack); and whether the report is ever
  `removed:true` while user bytes are lost. Adversarial cases required; all
  scratch confined to throwaway `/tmp` targets.
- **Command (tilde form):**
  `node scripts/independent-verify.mjs --repo ~/projects/orchard --working-tree --requirement @/tmp/req-FEAT-106-r5.txt --run "node scripts/verify-feat-106-cleanup-safety.mjs" --test-file scripts/verify-feat-106-cleanup-safety.mjs --timeout-min 25 --verdict-out /tmp/verdict-FEAT-106-r5.txt`
  (verifier openai via dispatch, author-provider anthropic → cross-provider.)
- **Verdict: BROKEN — VALID** (exit 1; executed-evidence contract satisfied: fixer
  test re-run + five adversarial cases the fixture does not cover + explicit
  could-not-test list; all manifest-backed).
  - Fixer test re-run in the room: **58 pass, 0 fail** (manifest `6a5a5466284d`,
    exit 0) — the round-5 cleanup-safety suite is green in the clean room; the
    round-1..4 repros (S1–S3 symlink-escape, T1 windowed-edit, X1–X3, U1–U4,
    F1/F2/F3, AS/AS1–AS4 atomic-save, E1 real-EXDEV, E2 read-only backup) all stay
    closed.
  - **FINDING 1 (backup-destination-race — data-loss, invariant b):** a separate
    process scheduled BETWEEN the dest-exists CHECK and the `renameSync` places a
    user inode from the cleanup path at the fresh backup destination; the rename
    then OVERWRITES it, the user inode survives NOWHERE, and cleanup still reports
    `removed`. The unique-mkdtemp-dir assumption does not make the check→rename
    step atomic. Manifest `fe9f73600a37`, exit 1 (`USER INODE LOST by backup
    destination overwrite`, survivors:[], originalExists:false).
  - **FINDING 2 (FIFO at capture — hang / robustness):** a FIFO appearing at a
    cleanup path immediately before capture (leaf swap after `safeRemovable`) is
    renamed into the backup, then `bytesEqual` does a BLOCKING `readFileSync` on
    the FIFO → cleanup HANGS (ETIMEDOUT) instead of refusing it. Manifest
    `572b62100012`, exit 1 (`captured FIFO: true`).
  - **FINDING 3 (directory at capture — path loss, invariant a):** a directory
    appearing at a cleanup path at capture time is moved into the backup; put-back
    then fails EPERM (cannot `link()` a dir), so the ORIGINAL PATH disappears
    rather than being kept in place. The bytes survive in the backup, but the file
    was not left where it stood. Manifest `776cfdbce3ab`, exit 1.
  - **Two adversarial cases HELD** (not findings): `hardlink-write-and-new-save`
    (manifest `42e69346b106`, exit 0) — a modification through a second hardlink
    after capture plus a new original-path occupant both survive (KEPT-in-backup,
    no clobber); and **the hook-seam probe HELD** — `production-hook-inputs`
    (manifest `606fd11f12ce`, exit 0): the CLI/env inputs the verifier tried do NOT
    activate `afterCapture`/`beforePutBack`, and the call sites set them only from
    the direct `hooks` argument. Confirm-case 4 (seam inert in production) is
    un-refuted this pass.
- **Could-not-test (verifier's own list):** uninstrumented real race FREQUENCY and
  power-loss fsync durability (races were scheduled deterministically around real
  filesystem ops, not by a real scheduler); independent forward-rename EXDEV
  injection (the suite exercises EXDEV only through the restore primitive).
- **Outcome:** ticket LEFT OPEN — NOT flipped to VERIFIED. BROKEN + VALID means the
  round-5 single-rename capture does NOT hold; do not commit as-is. DATA-LOSS →
  priority. All three findings are in the guarded-delete path
  (`atomicRemoveVerified` in `scripts/onboard.mjs`). A fix lane should: (1) make
  the backup destination collision-proof against a concurrent occupant appearing
  between the check and the rename (the dest lives in a per-run mkdtemp dir, so the
  cheap close is to REFUSE if the rename would land on any pre-existing dest — but
  the check→rename gap itself must be closed, e.g. rename to a name that cannot
  pre-exist and re-verify identity, or `renameat`/`link`-based no-clobber capture);
  (2) re-assert the leaf is a REGULAR FILE at the instant of capture (dev/ino or an
  `O_NOFOLLOW`/`fstat` handle) so a FIFO or directory swapped in after
  `safeRemovable` is refused in place rather than renamed into the backup — and
  never let `bytesEqual` do a blocking read on a captured non-regular inode (bound
  the read / stat the type first). NOTE: the suite-strength dimension (round 4b,
  run b0e62aed) already HELD 4/4; this gating cleanup-safety dimension is BROKEN,
  so the ticket does not close.
- **Verified-by:** dispatch openai run 01a0f251-8ae5-7c81-937d-d77adc313a70
  (clean-room, `scripts/independent-verify.mjs`; cross-provider, author=anthropic
  → verifier=openai) — VERDICT: BROKEN

### 2026-09-30 — worker (round 6: triage the 3 round-5 findings; fix the (a)s)

- **Per-finding (a)/(b) decision:**
  | # | finding | class | disposition |
  |---|---|---|---|
  | 1 | backup-dest race: a process places a user inode at our backup dest in the check→rename gap, rename overwrites it | **(b) adversarial** | ACCEPTED, no build. The dest lives in a fresh, unpredictable per-run `mkdtemp` dir; nothing benign (an editor, the user, a second concurrent onboard — which gets its OWN mkdtemp dir) writes there. Reaching it needs an attacker racing our private backup dir. Closing it needs `renameat2(NOREPLACE)`/openat Node doesn't expose. dest-exists guard kept (closes benign/leftover); residual documented in the header. |
  | 2 | FIFO swapped at the leaf → blocking read → HANG | **(a) fix** (robustness) | trigger is a leaf-swap, but a hang/wedge is never acceptable and the fix is trivial |
  | 3 | directory swapped at the leaf → captured, put-back can't link a dir → original path EMPTIED | **(a) fix** | same fix as #2 |
- **Fix (`scripts/onboard.mjs`, `atomicRemoveVerified`):** RE-ASSERT the leaf is a
  regular file (`lstat`, `isFile()`) at the instant before the capture rename —
  a FIFO / directory / symlink is REFUSED IN PLACE, never renamed into the backup;
  and TYPE-GUARD the captured inode before any read, so `bytesEqual` never
  blocking-reads a non-regular inode (defence-in-depth for the residual gap).
  Closes both #2 (no hang) and #3 (original path never emptied). Header invariant
  + threat model updated; FINDING 1's residual stated as accepted.
- **Invariant extended:** …and the captured leaf is a REGULAR FILE — a non-regular
  type at a cleanup path is refused in place, never captured.
- **Verified — `verify-feat-106-cleanup-safety.mjs` 65/0** (was 58; +7), temp
  repos ONLY: LS non-vacuity (a naive dir-capture EMPTIES the path — put-back can't
  link a dir); LS-FIFO refused in place, no hang (suite runs under a 120s timeout,
  never hit); LS-DIR refused in place, dir + content intact; LS-SYMLINK refused in
  place; F1-boundary (the dest-exists guard refuses a pre-existing dest; source
  intact) — with the residual check→rename gap documented as accepted. All
  round-1..5 cases (S1–S3, T1, X1–X3, U1–U4, F1/F2/F3, AS/AS1–AS4, E1/E2) stay green.
- **Anti-regression (all green):** onboard-orchard-layout 52/0, onboard 57/0,
  fleet-sync 24/0, board-path 34/0, readers 22/0, layout-independence 4/0/2skip,
  verify:feat-091 327/0, feat-089 35/0, ticket-schema 64/0. `npm run gate` exit 0,
  `board:check` exit 0, `ticket-leak-gate` exit 0.
- **Could-not-test:** the two accepted adversarial residuals (FINDING 1's
  check→rename gap; a leaf swapped in the recheck→rename microsecond) — reachable
  only by an attacker with target write access mid-onboarding, out of the threat
  model; and real power-loss fsync durability.
- **Independent re-verify still WARRANTED** (data-loss class): re-run the leaf-swap
  repros against the round-6 tree; confirm FINDING 1 is accepted-adversarial not
  benign. Ticket stays OPEN / not VERIFIED.
- **Symptom of a deeper design flaw?** no — the accepted-vs-fixed boundary is now
  explicit per finding, and the fixable robustness holes are closed + tested.

### 2026-09-30 — verify driver (round 6: benign-scoped cleanup-safety of the regular-file recheck, clean-room cross-provider OpenAI) — VERDICT: BROKEN

- **Why this pass:** round 6 added a regular-file recheck (`lstat`+`isFile()`) at
  the instant before the capture rename and a type-guard on the captured inode, to
  close the round-5 FIFO-hang (#2) and directory-path-loss (#3) findings, and
  ACCEPTED round-5 FINDING 1 (backup-dest check→rename race) as out of the threat
  model. This is the warranted skeptic for that data-loss-class change. Fix
  UNCOMMITTED (`--working-tree`): `scripts/onboard.mjs` `M`,
  `scripts/verify-feat-106-cleanup-safety.mjs` untracked (both `node --check`
  clean, not mid-write; suite 65/0 in-repo before dispatch).
- **Requirement graded** (`/tmp/req-FEAT-106-r6.txt`, plain terms + a filled-in
  citation-block example so the OpenAI verifier could not slip the citation
  format). SCOPE was explicitly BENIGN-ONLY: confirm user bytes are never lost
  under ordinary use, an editor writing the file, concurrent USER edits, a SECOND
  onboarding run, and odd file types (dir/FIFO/symlink) that exist BEFORE
  onboarding starts (refused in place, no hang, no path-loss). A finding requiring
  an ATTACKER racing the target or the private backup dir during the run was
  declared OUT OF SCOPE and not to be counted (round-5 FINDING 1 already accepted).
- **Command (tilde form):**
  `node scripts/independent-verify.mjs --repo ~/projects/orchard --working-tree --requirement @/tmp/req-FEAT-106-r6.txt --run "node scripts/verify-feat-106-cleanup-safety.mjs" --test-file scripts/verify-feat-106-cleanup-safety.mjs --timeout-min 25 --verdict-out /tmp/verdict-FEAT-106-r6.txt`
  (working-tree snapshot HEAD `a977e76` → tree `1208f430`; verifier openai via
  dispatch, author-provider anthropic → cross-provider; 13 recorded runs.)
- **Verdict: BROKEN — VALID** (exit 1; executed-evidence contract satisfied: fixer
  test re-run + four adversarial cases the fixture does not cover + explicit
  could-not-test list; all manifest-backed).
  - Fixer test re-run in the room: **65 pass, 0 fail** (manifest `e7f6637a383a`,
    exit 0) — the round-6 cleanup-safety suite is green in the clean room; all
    round-1..5 repros (S1–S3, T1, X1–X3, U1–U4, F1/F2/F3, AS/AS1–AS4, E1/E2,
    LS/LS-FIFO/LS-DIR/LS-SYMLINK) stay closed.
  - **FINDING (BENIGN, IN SCOPE — hang / robustness, NOT attacker-racing):** a
    pre-existing FIFO at `docs/CONVENTIONS.md` (an odd file type present BEFORE
    onboarding starts — a benign confirm-case) is read at `scripts/onboard.mjs:517`
    during the conventions content-migration step, BEFORE the cleanup's regular-file
    type guard runs. The round-6 recheck guards the CLEANUP capture (the verifier
    confirmed dir/FIFO/symlink leaves at `scripts/board.mjs` are refused in place —
    run `457edc7c2e83`), but the earlier conventions read is an unguarded blocking
    `readFileSync`, so `--migrate` HANGS on the FIFO (ETIMEDOUT after the test's 3s
    kill; the FIFO inode stayed intact). The regular-file control migrated cleanly.
    Manifest `837ae6ab1b85`, exit 1. This is benign concurrency-free breakage — a
    pre-existing type at a path onboarding reads, no attacker required — so it is
    counted as a valid BROKEN, NOT out of scope.
  - **Benign confirm-cases that HELD** (not findings): whole-migration byte
    conservation for four removed files + repeat/partial runs preserving a modified
    file and an extra binary file (run `d4fea9fb22fe`, exit 0); pre-existing dir /
    FIFO / symlink at a tool cleanup path (`scripts/board.mjs`) intact at the same
    inode through two whole migrations (run `457edc7c2e83`, exit 0); external-editor
    atomic-save (write-temp-then-rename) before AND after capture of both a tool file
    and a public file, saved bytes surviving migration + a second run (run
    `deb169126ee8`, exit 0).
  - **Out-of-scope, correctly NOT counted** (verifier's UNTESTED line): the
    backup-destination check→rename race and a non-regular leaf swapped between the
    recheck and the rename (attacker racing the private backup dir / target
    mid-run) — the accepted residuals from round 5's FINDING 1.
- **Could-not-test (verifier's own list):** uninstrumented editor scheduling and
  real power-loss fsync durability (editor timing was injected deterministically,
  not by a real scheduler).
- **Outcome:** ticket LEFT OPEN — NOT flipped to VERIFIED. BROKEN + VALID means
  round 6 does NOT fully hold under BENIGN conditions. The remaining hole is a
  robustness/hang defect OUTSIDE the cleanup guard: the conventions
  content-migration read (`scripts/onboard.mjs:517`) blocking-reads a pre-existing
  FIFO at `docs/CONVENTIONS.md`. A fix lane should stat-the-type / bound the read of
  any legacy path onboarding reads (not only the ones the cleanup capture guards) so
  a pre-existing non-regular file is refused in place rather than wedging
  `--migrate`. The DATA-LOSS invariant (no user bytes lost under benign conditions)
  otherwise HELD across every byte-conservation, modified/extra-file, repeat-run and
  editor-save case; the sole failure is a hang, not byte loss. Suite-strength
  dimension (round 4b, run `b0e62aed`) already HELD 4/4 and is unaffected.
- **Verified-by:** dispatch openai run 01a0f2fa-23be-7ea3-b592-fe9a570f3aa8
  (clean-room, `scripts/independent-verify.mjs`; cross-provider, author=anthropic
  → verifier=openai) — VERDICT: BROKEN

### 2026-10-01 — worker (round 7: route every TARGET-repo read through a guarded reader)

- **Understood:** the last in-scope finding — a FIFO at `docs/CONVENTIONS.md` is
  blocking-read during the conventions migration (before the cleanup type guard),
  so `--migrate` HANGS. No bytes lost. Fix it as a CLASS: one guarded reader for
  every read onboard/fleet-sync make of a file in the TARGET repo.
- **Changed (`scripts/onboard.mjs` + `scripts/fleet-sync.mjs`, working-tree only):**
  - New `readTargetFile(p, {max})` (exported): `lstat`-refuses any non-regular
    type BEFORE opening, opens `O_RDONLY|O_NONBLOCK` (so a type that raced the
    lstat cannot block), `fstat`-refuses a raced non-regular, and CAPS bytes at 8
    MiB. Returns `{ok,data}` or `{ok:false,reason}`. Plus `targetBytesEqual` for
    target-vs-repo compares.
  - **Enumerated + converted EVERY target-repo read:** onboard — `appendWaPointer`
    (CLAUDE.md), `readJson` (package.json), `scaffoldRoot` CONVENTIONS.md
    migration (the reported hang), `copyOrchardFile` dest compare (`.orchard/*`),
    `installClaudeHook` (.claude/settings.json), `scaffoldDeployContext`
    (DEPLOY-CONTEXT.md), and the cleanup classification reads (tool/doc/public
    byte-compares, already lstat-guarded by `safeRemovable` but routed through the
    helper for one path). fleet-sync — the dry-run dest byte-compare. Reads of
    THIS repo's own source files are left as-is (we control them). `existsSync`
    sites are stats (never block) and were left.
- **Verified — the suites that exercise target reads, all green, temp repos ONLY:**
  `verify-feat-106-cleanup-safety` **78/0** (+13: TR unit — regular reads, FIFO /
  dir / unix-socket / oversized-cap all refused with no block; TR-E2E — a FIFO at
  `docs/CONVENTIONS.md` → onboard does NOT hang, falls back to the stub, reports
  it, leaves the FIFO; an OVERSIZED (9 MiB) CONVENTIONS.md + a FIFO at the second
  path `package.json` → no hang); suite runs under a 120s wrapper so any hang
  fails it. `verify-onboard` 57/0, `verify-fleet-sync` 24/0,
  `verify-feat-106-onboard-orchard-layout` 52/0, `verify-feat-089-method-auto`
  35/0, `verify-ticket-schema` 64/0, `verify:feat-091` 330/0. `npm run gate` exit 0
  (leak-gate + check-nul + typecheck), `ticket-leak-gate` exit 0.
- **CONCURRENT-LANE INTERACTION (not mine — recorded per WA):** a FEAT-157 lane
  ("pin a versioned Orchard base") ran `onboard` against the Orchard repo ITSELF,
  creating `repo/.orchard/` (its `config.json` carries my onboard's
  `"board":"docs/bugs"` declare-in-place output; its `.orchard/lib/` holds
  `verification-source.mjs`/`ticket-record.js` from a BUG-225 manifest extension
  to onboard.mjs that also appeared in the shared working tree). Consequences for
  FEAT-106's anti-regression list, with evidence they are NOT my diff:
  - `verify-feat-106-board-path` 29/5 — all 5 fails are the `A*` "Orchard has NO
    `.orchard/`" assertions; `board-path.mjs` is byte-unchanged by me (`git diff
    --stat` empty) and my tests only ever onboard `/tmp` targets, never
    `repoRoot`. The failures are `repo/.orchard/` existing, created by FEAT-157.
  - `verify-bug-146-conventions-inject` 16/18 — `resolveConventionsFile(<repo>)`
    now returns `repo/.orchard/CONVENTIONS.md` (present) instead of
    `docs/CONVENTIONS.md`, so templates.ts injects that copy; same root cause.
  - `npm run board:check` exit 1 — board-wide "NO standing HOLDS verification"
    enforcement firing on dozens of legacy tickets (ARCH-001, BUG-035…), a BUG-225
    verification-source change, not FEAT-106.
  I did NOT touch `repo/.orchard/` (FEAT-157's artifact) or the BUG-225 enforcement.
  DECISION FOR THE ORCHESTRATOR: FEAT-157 giving the Orchard repo its own
  `.orchard/` is in direct tension with FEAT-106's HARD CONSTRAINT and
  board-path's `A*` assertions ("Orchard's repo has no `.orchard/` by
  construction"). One of the two must give; that is a cross-ticket design call.
- **Could-not-test:** a real scheduler race for the FIFO (injected via a real
  FIFO node + a bounded `O_NONBLOCK` read, not a timed race); board-path/bug-146
  under a clean repo (blocked by the live `repo/.orchard/` I must not remove).
- **Symptom of a deeper design flaw?** the recurring producer-move-breaks-a-reader
  pattern (now also across tickets, FEAT-157 vs board-path) argues for a shared
  resolver the suites read rather than hard-coded paths — flagged, not built.

### 2026-10-01 — verify-driver
- **Verification recorded:** dispatch anthropic/claude-opus-5-5 run f8a7c4dc-c025-4a30-83da-7657d5ba0e8e — VERDICT: BROKEN — round 7: FIFO at target .orchard/config.json hangs onboard/fleet-sync via unguarded readFileSync in board-path.mjs readOrchardConfig (escaped target read). Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-01 — verify driver (round 7: benign-scoped target-read guarding, clean-room SAME-provider) — VERDICT: BROKEN

- **Why this pass:** round 7 claims EVERY read onboard.mjs / fleet-sync.mjs make
  of a file in a TARGET repo is routed through the new guarded `readTargetFile`
  (lstat-refuse non-regular → O_NONBLOCK open → fstat-refuse raced non-regular →
  8 MiB cap), closing the round-6 FIFO-at-`docs/CONVENTIONS.md` hang as a CLASS.
  Warranted skeptic for this data-loss/robustness-class change. Fix UNCOMMITTED
  (`--working-tree`): `scripts/onboard.mjs` + `scripts/fleet-sync.mjs` both `M`,
  `scripts/verify-feat-106-cleanup-safety.mjs` untracked; all three `node --check`
  clean (not mid-write); round-7 exports (`readTargetFile`, `safeRemovable`,
  `atomicRemoveVerified`, `orchardFileManifest`) present; suite 78/0 in-repo.
- **Requirement graded** (`/tmp/req-FEAT-106-r7.txt`, plain terms + a filled-in
  CITATION-block example). SCOPE BENIGN-ONLY: user bytes safe + no hang + no
  escaped target read, under pre-existing odd-type files and ordinary concurrent
  USER edits; ACTIVE-ATTACKER RACES declared OUT OF SCOPE (report, don't count) —
  round-5 FINDING-1 backup-dest race and leaf/ancestor-swap races already accepted.
  FOCUS: (F-A) did any target read escape `readTargetFile`? enumerate+classify
  every fs read in BOTH files; (F-B) a target path that is a SYMLINK to a regular
  file OUTSIDE the repo — refused, not followed? Attribution note: three live-tree
  reds (board-path 29/5, bug-146 16/18, board:check) are FEAT-157/BUG-225, not
  round 7 — confirm, don't count.
- **Command (tilde form):**
  `export CLAUDE_CONFIG_DIR=<verifier account config dir>; node scripts/independent-verify.mjs --repo ~/projects/orchard --working-tree --requirement @/tmp/req-FEAT-106-r7.txt --run "node scripts/verify-feat-106-cleanup-safety.mjs" --test-file scripts/verify-feat-106-cleanup-safety.mjs --provider anthropic --timeout-min 25 --verdict-out /tmp/verdict-FEAT-106-r7.txt`
  (working-tree snapshot HEAD `a977e76` → tree `7999b358`; dispatch session/run
  `f8a7c4dc-c025-4a30-83da-7657d5ba0e8e`, exit 1, 4 recorded runs.)
- **Provider — SAME-PROVIDER FALLBACK, noted:** routed to the designated verifier account
  (fresh), but author-provider is also anthropic, so decorrelation is REDUCED vs a
  cross-provider pass. OpenAI exhausted until 2026-10-05; this is the sanctioned
  fallback for now. Recorded here and in Verified-by.
- **Verdict: BROKEN — VALID** (exit 1; executed-evidence contract satisfied —
  fixer test re-run + two adversarial cases the fixture does not cover + explicit
  could-not-test list; all manifest-backed; `--check-only` re-confirmed VALID).
  - Fixer test re-run in the room: **78 pass, 0 fail** (manifest `f885580fd2f8`,
    exit 0) — the round-7 cleanup-safety suite is green in the clean room; all
    round-1..6 repros (S1–S3, T1, X1–X3, U1–U4, F1/F2/F3, AS/AS1–AS4, E1/E2,
    LS/LS-FIFO/LS-DIR/LS-SYMLINK, TR/TR-E2E) stay closed.
  - **FINDING (BENIGN, IN SCOPE — hang / escaped target read):** a FIFO already
    sitting at the TARGET's `.orchard/config.json` makes `node scripts/onboard.mjs
    <target>` HANG forever, and also hangs a `fleet-sync` dry-run that includes
    that target (manifest `7c8008769bf5`, exit 1 — both processes SIGTERM-killed at
    the 15s budget). Cause: an UNGUARDED `fs.readFileSync` in
    `scripts/lib/board-path.mjs:78` (`readOrchardConfig`), reached from
    `onboard.mjs` `boardRelFor`/`scaffoldBoard` (≈503–506,517,566) and
    `fleet-sync.mjs` `planSweep` (≈98). The round-7 enumeration guarded every read
    LEXICALLY INSIDE onboard.mjs/fleet-sync.mjs but MISSED the target read that
    happens inside the imported helper `board-path.mjs`. Same round-6 hang class,
    different target path. No bytes lost — it is a hang, like round 6's.
  - **F-B symlink case HELD** (manifest `3e7040c37a7c`, exit 0): a symlink to a
    regular file OUTSIDE the target, placed at `docs/CONVENTIONS.md`, `CLAUDE.md`
    (`--wa-pointer`) and `.claude/settings.json`, is REFUSED as "not a regular file
    (symlink)" at all three — the outside file is never ingested into
    `.orchard/CONVENTIONS.md`, no outside file changed, no append/rewrite via the
    symlink. `readTargetFile`'s lstat-refuse correctly does not follow the link.
- **Could-not-test (verifier's own list):** other board-path `isFile`/`isDir`
  probes; a SYMLINKED or OVERSIZED `.orchard/config.json` (raw `readFileSync`
  follows symlinks — would likely be read through — NOT run); a socket/dir at
  `config.json`; DEPLOY-CONTEXT.md + fleet-sync dest compare with odd types. Also
  noted un-exploited: `onboard.mjs:1263` `bytesEqual(dest)` is an uncapped
  `readFileSync`, but the inode is lstat-checked regular and lives in the private
  backup dir, so it cannot hang (no finding). The three live-tree reds
  (board-path/bug-146/board:check) were NOT run in the clean room (it strips docs
  and has no `.orchard/`); their FEAT-157/BUG-225 attribution stands un-refuted,
  correctly NOT counted. Real scheduler-race FIFO timing + power-loss fsync not
  exercised. Active-attacker races correctly left out of scope.
- **Outcome:** ticket LEFT OPEN — NOT flipped to VERIFIED (work_state unchanged).
  BROKEN + VALID means round 7 does NOT fully hold under BENIGN conditions. The
  remaining hole is the SAME hang class the round-7 "guard every target read"
  design set out to close, surviving via an imported helper. A fix lane should:
  route `readOrchardConfig` (and the other target-path reads/probes inside
  `scripts/lib/board-path.mjs` that onboard/fleet-sync reach — `boardLayout`,
  `resolveBoardDir`, any `isFile`/`isDir`/`readFileSync` on a target path) through
  the same guarded reader (or an equivalent non-blocking, type-refusing read), so
  a pre-existing non-regular file at `.orchard/config.json` is refused in place
  rather than wedging `--migrate`/onboard/fleet-sync. The DATA-LOSS invariant
  (no user bytes lost under benign use) otherwise HELD; the F-B symlink-escape
  case HELD; the sole in-scope failure is a hang, not byte loss. Suite-strength
  dimension (round 4b, run `b0e62aed`) already HELD 4/4 and is unaffected.
- **Independent re-verify still WARRANTED** (data-loss/robustness class), and
  ideally CROSS-PROVIDER once OpenAI is available again (this pass was
  same-provider).
- **Verified-by:** dispatch anthropic/claude-opus-5-5 run
  f8a7c4dc-c025-4a30-83da-7657d5ba0e8e (clean-room, `scripts/independent-verify.mjs`;
  SAME-provider fallback — author=anthropic → verifier=anthropic, decorrelation
  reduced, OpenAI exhausted until 2026-10-05) — VERDICT: BROKEN

### 2026-10-01 — worker (round 8: guard the target read inside the imported helper)

- **Per-finding table:**
  | finding | class | disposition |
  |---|---|---|
  | a FIFO (or socket/non-regular) at the target's `.orchard/config.json` HANGS `onboard`/`fleet-sync` — an UNGUARDED `fs.readFileSync` in `board-path.mjs:readOrchardConfig`, reached from onboard (`boardRelFor`/`scaffoldBoard`) and fleet-sync (`planSweep`→`boardLayout`) | **(a) benign hang** | FIXED |
  | F-B: a symlink at `CONVENTIONS.md`/`CLAUDE.md`/`settings.json` → refused, not followed | — | already HELD (round 7), no change |
- **Why round 7 missed it:** the round-7 enumeration guarded every read written
  LEXICALLY inside onboard.mjs/fleet-sync.mjs, but `readOrchardConfig` lives in the
  IMPORTED helper `scripts/lib/board-path.mjs`. Same hang class as round 6, a
  different target path, reached through an import.
- **Fix (`scripts/lib/board-path.mjs`):** a self-contained `readRegularCapped`
  (node builtins only — the module is copied verbatim into targets AND imported
  from TypeScript, so it may NOT import onboard's `readTargetFile`): lstat-refuses
  any non-regular type (symlinks NOT followed), opens `O_RDONLY|O_NONBLOCK`,
  fstat-refuses a raced non-regular, caps at 1 MiB. `readOrchardConfig` now reads
  through it → a non-regular `config.json` degrades to "no declaration", never
  wedges. `isDir`/`isFile` use `statSync` (a stat never blocks) — left as-is.
- **Verified — `verify-feat-106-cleanup-safety` 84/0** (+6: CFG — `readOrchardConfig`
  parses a regular config, returns null for a FIFO / symlink / oversized config
  with no block; CFG-E2E — a FIFO at `.orchard/config.json` → `onboard` does NOT
  hang, FIFO left in place), suite under a 180s wrapper. Manual: `onboard` and
  `fleet-sync --registry-file` over a target with a FIFO `.orchard/config.json`
  both exit 0 (were SIGTERM-killed before). Anti-regression all green:
  onboard-orchard-layout 52/0, onboard 57/0, fleet-sync 24/0, readers 22/0,
  layout-independence 4/0/2skip, feat-089 35/0, ticket-schema 64/0, verify:feat-091
  330/0, **board-path 34/0** (recovered — see below). `npm run gate` exit 0,
  `board:check` exit 0, `ticket-leak-gate` exit 0.
- **Concurrent-lane attribution update (correcting round 7):** the FEAT-157
  `repo/.orchard/` has since been REMOVED, so `board-path` is back to 34/0 and
  `board:check` back to exit 0 — confirming those round-7 reds were FEAT-157/BUG-225,
  not FEAT-106. `verify-bug-146-conventions-inject` is STILL 16/18, and its 2 fails
  PERSIST without `repo/.orchard/`, so round-7's attribution of them to that dir was
  WRONG: the real cause is a concurrent **+210/-76 line expansion of
  `docs/CONVENTIONS.md`** (not my diff — I never edit that doc) whose inject-region
  now exceeds templates.ts's cap, truncating off the "separate-process rule" and
  firing the TRUNCATED notice. That is a cap-vs-doc-growth concern for BUG-146's /
  the conventions doc's owner, not FEAT-106.
- **No (a) left that I can see** after this fix: the round-7 verify recorded the
  data-loss invariant HELD and the symlink-escape HELD; this config hang was the
  sole in-scope failure and is closed. If a re-verify finds another read reached
  through an import, it is the same one-line class fix.
- **Could-not-test:** a real scheduler-race FIFO timing (injected via a real FIFO
  node + bounded O_NONBLOCK read); power-loss fsync durability.
- **Independent re-verify WARRANTED**, ideally CROSS-PROVIDER once OpenAI is back
  (round-7 pass was same-provider). Ticket stays OPEN / not VERIFIED.
- **Symptom of a deeper design flaw?** yes-ish (recorded, not built): "guard every
  target read" is only sound if enforced at the ONE place target paths are read,
  not re-enumerated per caller — a shared `readTargetFile` that `board-path.mjs`
  and the server all funnel through would end this round-by-round whack-a-mole. It
  is not built here because board-path must stay import-free for copy-into-target.

### 2026-10-01 — dispatch openai
- **Verification recorded:** dispatch openai run 01a0f92b-8033-7a91-ac2d-57710204b2a6 — VERDICT: BROKEN — round 8 cross-provider: readOrchardConfig hang FIXED + symlink-escape HELD, but uncapped fs.readFileSync at onboard.mjs:1111 bytesEqual (via cleanupLegacy->atomicRemoveVerified) reads a whole 16 MiB file on an ordinary editor save - benign cap violation, no hang/no byte loss. Typed entry in the record's verification[]; this line is an echo, not proof.

### 2026-10-01 — verify driver (round 8: target-reads-through-an-import, clean-room CROSS-PROVIDER OpenAI) — VERDICT: BROKEN

- **Why this pass:** round 8 routes `readOrchardConfig` (inside the IMPORTED helper
  `scripts/lib/board-path.mjs`, reached from onboard/fleet-sync) through a new
  self-contained guarded reader `readRegularCapped` (lstat-refuse non-regular →
  O_NONBLOCK open → fstat-refuse raced non-regular → 1 MiB cap), closing the
  round-7 FIFO-at-`.orchard/config.json` hang that escaped through the import. This
  is the warranted CROSS-PROVIDER skeptic (OpenAI back; round 7 was same-provider
  anthropic). Fix UNCOMMITTED (`--working-tree`): `scripts/lib/board-path.mjs` +
  `scripts/onboard.mjs` + `scripts/fleet-sync.mjs` `M`,
  `scripts/verify-feat-106-cleanup-safety.mjs` untracked; suite 84/0 in-repo.
- **Requirement graded** (`/tmp/req-FEAT-106-r8.txt`, plain terms + a filled-in
  CITATION-block example per the contract). SCOPE BENIGN-ONLY: user bytes safe + no
  hang + no escaped/unbounded target read, under pre-existing odd-type files and
  ORDINARY concurrent USER edits; ACTIVE-ATTACKER RACES declared OUT OF SCOPE
  (report, don't count). FOCUS: (F-A) TRACE THE CALL GRAPH from onboard/fleet-sync
  INTO board-path.mjs + any `scripts/lib` helper — does every reached TARGET read
  go through a guarded/`statSync` reader, incl. `readOrchardConfig` now via
  `readRegularCapped`? (F-B) a target path that is a SYMLINK to a regular file
  OUTSIDE the repo — refused, not followed? Attribution: the three earlier live-tree
  reds (board-path, bug-146, board:check) are FEAT-157/BUG-225 — confirm, don't count.
- **Command (tilde form):**
  `node scripts/independent-verify.mjs --repo ~/projects/orchard --working-tree --requirement @/tmp/req-FEAT-106-r8.txt --run "node scripts/verify-feat-106-cleanup-safety.mjs" --test-file scripts/verify-feat-106-cleanup-safety.mjs --timeout-min 25 --verdict-out /tmp/verdict-FEAT-106-r8.txt`
  (no `--provider` → cross-provider default author=anthropic → verifier=openai;
  working-tree snapshot HEAD `a977e76`; dispatch run
  `01a0f92b-8033-7a91-ac2d-57710204b2a6`, exit 1, 3 recorded verifier runs.)
- **Verdict: BROKEN — VALID** (exit 1; executed-evidence contract satisfied —
  fixer test re-run + 3 adversarial cases the fixture does not cover + explicit
  could-not-test list; all manifest-backed).
  - Fixer test re-run in the room: **84 pass, 0 fail** (manifest `79adfb9fbce2`,
    exit 0) — the round-8 suite is green in the clean room; all round-1..7 repros
    (S1–S3, T1, X1–X3, U1–U4, F1/F2/F3, E1/E2, CFG/CFG-E2E, and the round-7 TR*
    cases) stay closed.
  - **F-A call-graph trace HELD for the config hang** (adversarial
    `config-type-matrix-and-outside-symlink`, manifest `a283245da226`, exit 0):
    onboard reaches `boardLayout`+`resolveBoardDir`, fleet-sync reaches
    `boardLayout`, both → `declaredBoardDir` → `readOrchardConfig` → the guarded
    `readRegularCapped`; other reached board-path checks use `statSync` (never
    blocks). A regular / FIFO / socket / directory / oversized / outside-symlink
    `.orchard/config.json` makes BOTH real CLIs exit 0 with no hang. The round-7
    hang class is CLOSED.
  - **F-B symlink-escape HELD** (same `config-type-matrix` run): a symlink at
    `.orchard/config.json` pointing at a regular file OUTSIDE the target is REFUSED
    (returns null), outside bytes preserved — the link is not followed.
  - **FINDING (BENIGN, IN SCOPE — unbounded target read, NOT a hang, NO byte loss):**
    `scripts/onboard.mjs:1111` `bytesEqual` does an UNCAPPED `fs.readFileSync` on
    the captured target file, reached through onboard → `cleanupLegacy` →
    `atomicRemoveVerified` (:1263) → `bytesEqual` (:1111). An ordinary editor atomic
    save that grows a legacy tool file to 16 MiB before the cleanup capture makes
    `bytesEqual` read all 16,777,216 bytes, exceeding the 8 MiB `readTargetFile`
    cap — no attacker and no private-backup manipulation required (adversarial
    `editor-save-exceeds-cleanup-cap`, manifest `f745ff8af354`, exit 1; the raw read
    is at `onboard.mjs:1111` per the captured stack). User bytes SURVIVED; this
    violates only the "capped"/bounded-read half of the invariant, not the
    no-hang / no-byte-loss halves. This is the SAME uncapped-read class round 7
    listed as a could-not-test non-finding (then at the `:1263` dest compare,
    dismissed because it lived in the private backup dir); this pass proves it is
    reachable on a target-originated file via `cleanupLegacy` under an ordinary
    large save.
- **Could-not-test (verifier's own list):** active-attacker inode/ancestor/
  backup-dest races (out of scope, accepted residual); real power-loss fsync
  durability; the three attribution suites (board-path/bug-146/board:check) were NOT
  run in the clean room (it strips docs + has no `.orchard/`) — their
  FEAT-157/BUG-225 attribution stands un-refuted, correctly NOT counted. Verifier
  also noted initial fixture commands failed on recorder shell-quoting; corrected
  commands supplied the cited evidence.
- **Outcome:** ticket LEFT OPEN — NOT flipped to VERIFIED (work_state unchanged).
  BROKEN + VALID. The round-8 config-hang fix and the symlink-escape refusal both
  HOLD; the sole in-scope failure is a benign UNBOUNDED read (16 MiB) during
  cleanup — low severity (no hang, no byte loss) but it breaks the capped-read
  claim. A fix lane should cap `bytesEqual`/the `atomicRemoveVerified` compare read
  (route it through `readTargetFile`/`readRegularCapped` with the 8 MiB cap, or a
  size-guard before the raw read) so a large pre-existing/edited legacy file is
  bounded like every other target read. Suite-strength dimension (round 4b, run
  `b0e62aed`) already HELD 4/4 and is unaffected.
- **Independent re-verify still WARRANTED** (data-loss/robustness class) after the
  cap fix lands; this pass was cross-provider (openai), decorrelation restored.
- **Verified-by:** dispatch openai run 01a0f92b-8033-7a91-ac2d-57710204b2a6
  (clean-room, `scripts/independent-verify.mjs`; CROSS-provider — author=anthropic
  → verifier=openai) — VERDICT: BROKEN

### 2026-10-01 — worker (round 9: one owned target-read helper; cap the last read)

- **Per-finding table:**
  | finding | class | disposition |
  |---|---|---|
  | UNBOUNDED read: a legacy file grown past 8 MiB BETWEEN cleanup classification and capture is read whole by `bytesEqual` inside `atomicRemoveVerified` (onboard.mjs:1111) — no hang, no byte loss, but breaks the capped-read half of the invariant | **(a) benign unbounded read** | FIXED |
  | round-8 config-hang fix + symlink-escape refusal | — | re-confirmed HELD by the verifier; no change |
- **Fix — consolidated to ONE owned helper (the coordinator's round-8 proposal,
  built):** the guarded reader now lives in `scripts/lib/board-path.mjs` as the
  OWNER (`readTargetFile` + `targetBytesEqual` + `MAX_TARGET_READ`, all exported;
  node-builtins-only so the module still copies into targets and imports from
  TypeScript). `onboard.mjs` IMPORTS both from board-path and RE-EXPORTS them (so
  `fleet-sync` and the verify suites that `import … from './onboard.mjs'` are
  unchanged); onboard's duplicate `readTargetFile`/`targetBytesEqual`/`bytesEqual`
  are deleted. `readOrchardConfig` already routes through it. The last raw read —
  the `atomicRemoveVerified` authoritative compare — now uses `targetBytesEqual`,
  so a 16 MiB captured file is size-refused by the 8 MiB cap (never read whole)
  and, being oversized, judged not-Orchard and put back.
- **No-bypass guarantee (new check, NB):** a structural scan asserts every raw
  `fs.readFileSync`/`createReadStream` in `onboard.mjs` + `fleet-sync.mjs` +
  `board-path.mjs` is on a repo-side / CLI-fixture argument (`src`, `repoSrcPath`,
  `entry.src`, `registryFile`, the `.station-hands-off` `f`, `path.join(repoRoot…`)
  — any read of a TARGET path would fail the check. So a future target read cannot
  silently bypass the helper. (Non-vacuity asserted: the scan finds real sites.)
- **Verified — `verify-feat-106-cleanup-safety` 89/0** (+5: CAP — a >8 MiB captured
  file is bounded → removed:false + restored; `readTargetFile` refuses the 16 MiB
  file without reading it whole; non-vacuity a small matching file IS removed; NB —
  no-bypass scan + its non-vacuity), temp repos only, under a 200s wrapper. All
  round-1..8 repros (S1–S3, T1, X1–X3, U1–U4, F1/F2/F3, E1/E2, LS*, TR*, AS*, CFG*)
  stay closed. Anti-regression all green: onboard 57/0, fleet-sync 24/0,
  onboard-orchard-layout 52/0, board-path 34/0, readers 22/0,
  layout-independence 4/0/2skip, feat-089 35/0, ticket-schema 64/0,
  verify:feat-091 330/0. `npm run gate` exit 0, `board:check` exit 0,
  `ticket-leak-gate` exit 0.
- **NO (a) remaining that I can find.** Every target-repo read in `scripts/lib/*`
  and both entry scripts now funnels through the one owned `readTargetFile`
  (enforced by the NB check): non-regular types refused (no hang), reads capped (no
  unbounded read), symlinks not followed (no escape), user bytes conserved. The
  round-8 verify recorded data-loss, symlink-escape and config-hang all HELD; this
  round closes the sole remaining (unbounded-read) item. I believe the
  cleanup-safety loop is DONE pending one more independent confirmation.
- **Could-not-test:** active-attacker inode/ancestor/backup-dest races (accepted,
  out of scope); real power-loss fsync durability.
- **Independent re-verify WARRANTED** (cross-provider, to confirm the consolidation
  + cap). Ticket stays OPEN / not VERIFIED.
- **Symptom of a deeper design flaw?** addressed: the round-by-round "another
  target read escaped" pattern is now structurally closed — one owner + a
  no-bypass check — rather than patched per caller.
