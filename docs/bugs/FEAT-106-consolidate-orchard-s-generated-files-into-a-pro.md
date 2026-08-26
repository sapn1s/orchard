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
