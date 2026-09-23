# BUG-182 — clean-room verification silently loses its live-server evidence: `BOOT_STUBS` is a stale copy of a fact `templates.ts` owns

- **Status:** IN-VERIFICATION
- **Severity:** high (no product defect; the harness silently degrades every future
  clean-room verification that needs a live server, which is exactly the false-proof
  class the working agreement ranks highest)
- **Area:** verification harness (`scripts/independent-verify.mjs`)
- **Reported:** 2026-09-18 by the FEAT-145 steps 4+5 independent verification round
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED

## Symptom

A clean-room verification that needs a live server aborts with `server never became
healthy` — a generic health-check timeout that gives no hint anything is missing. It
reads like a subject-under-test failure, not a harness gap.

## Repro

Exact repro recorded on FEAT-145 (`### 2026-09-18 — verifying round 1 (steps 4 + 5…)`):
`node scripts/verify-feat-145-session-override.mjs` inside a clean room built by
`scripts/independent-verify.mjs` ran sections 1–3 green, then aborted at §4 with
`server never became healthy` (manifest `c645dfb4a988`). The same suite re-run in the
real working tree passed 34/34, including the §4 live-server evidence — the only
difference was the room.

## Root cause

`scripts/independent-verify.mjs:255-262` hardcodes `BOOT_STUBS`, the list of files it
must stub back in after stripping `docs/prompts` so the server can still boot:

```js
const BOOT_STUBS = [
  'docs/prompts/WORKING_AGREEMENT.md',
  'docs/prompts/WORKING_AGREEMENT.v2.md',
  'docs/prompts/patterns/MANAGER_SUBAGENT_TREE.md',
  'docs/prompts/patterns/INDEX_TABLE_ROUTER.md',
  'docs/prompts/patterns/RAW_CURATED_MEMORY_SPLIT.md',
  'docs/prompts/patterns/GO_NO_GO_PREFLIGHT.md',
];
```

But `src/server/templates.ts:85-88` — the file that actually owns which paths
`seedTemplates` reads — now declares FOUR working-agreement paths, not two:

```js
'working-agreement': path.join('docs', 'prompts', 'WORKING_AGREEMENT.md'),
'working-agreement-v2': path.join('docs', 'prompts', 'WORKING_AGREEMENT.v2.md'),
'working-agreement-v3': path.join('docs', 'prompts', 'WORKING_AGREEMENT.v3.md'),
'working-agreement-v4': path.join('docs', 'prompts', 'WORKING_AGREEMENT.v4.md'),
```

`.v3.md` and `.v4.md` are absent from `BOOT_STUBS`. The clean room strips
`docs/prompts` entirely, `seedTemplates` then tries to read a `.v3`/`.v4` path that
does not exist in the stripped room, and the server never comes up. Nothing about the
failure names the missing path — it just times out on health, so the round silently
falls back to whatever static evidence it already had. In the round that found this,
the live `/ws` container-refusal evidence for FEAT-145 steps 4+5 had to be re-run in
the real tree as a non-independent control instead of inside the clean room.

## Why this is the false-proof class, not an ordinary harness bug

Per the working agreement, anything that can make a record claim work was verified
when it was not is the highest-priority harm class. This defect does exactly that
silently: every future clean-room verification in this repo that needs a live server
pays the same cost, with no signal beyond a generic timeout, until someone happens to
notice (as FEAT-145's verifier did) that the failure is environmental rather than a
feature defect.

## This is the project's own ARCH-010 shape — frame the fix that way

`BOOT_STUBS` is a **second place** holding a fact that `templates.ts` already owns
(which paths `seedTemplates` reads). The two can disagree — and did — and a reader
(the clean-room script) re-derives what the owner should declare. Per CONVENTIONS'
ARCH-010 rule, an option that leaves a second place able to hold a different answer is
out, and an option that adds a check counting/comparing the places is *also* out (it
buys the fix in more checking machinery, not in removing the second place). Two shapes
that do NOT satisfy this ticket, spelled out so they are not proposed by reflex:

- **Adding `.v3`/`.v4` to `BOOT_STUBS`.** This is the same defect with a newer copy —
  it fixes today's drift and reproduces exactly this failure the next time
  `templates.ts` grows another seeded path.
- **A drift-checker that asserts `BOOT_STUBS` and `templates.ts`'s path list stay in
  sync.** CONVENTIONS rejects this by name: it is "an option that adds a check
  counting the places that derive it," which this project already has more of than
  product.

The acceptable direction: `templates.ts` (or a helper it exports) declares the list of
paths `seedTemplates` needs to boot, and `independent-verify.mjs` READS that
declaration to build its stub set, rather than holding its own copy. A newly-added
`seedTemplates` read must then be picked up with zero edits to the clean-room script.

## Proof bar for the fixer

- A must-FAIL fixture proving the CURRENT clean room fails to boot: reproduce the
  `server never became healthy` failure against a synthesized/pinned pre-fix state (not
  against "HEAD" or "current" — CONVENTIONS' must-FAIL rule: an anchor that moves stops
  failing the moment the fix lands and never reports the regression again).
- After the fix: the same clean room boots successfully.
- **The class assertion, not just the instance:** add a path to whatever list
  `templates.ts` declares (a throwaway fifth working-agreement path or similar) and
  show the clean room picks it up and stubs it automatically, with NO edit to
  `independent-verify.mjs`. This is the test that actually proves the second place was
  removed rather than just topped up.
- A stub gap must fail LOUDLY and NAME the missing path (e.g. "clean room cannot boot:
  seedTemplates needs docs/prompts/WORKING_AGREEMENT.v5.md which no BOOT_STUBS-equivalent
  declared") — never present as a generic health-check timeout. This is what would have
  let the FEAT-145 verifier diagnose the failure in seconds instead of falling back to a
  non-independent control.

## Context pack (grows — the "where to look", so no agent cold-starts)
- Files/functions in play: `scripts/independent-verify.mjs:255-268` (`BOOT_STUBS`,
  `BOOT_STUB_BODY`) and `:391-405` (the seeding loop that writes them, including the
  existing `die()` call for a stub write failure — the model for how a boot-blocking gap
  should fail); `src/server/templates.ts:85-88` (the four working-agreement path
  declarations `seedTemplates` reads) and wherever `seedTemplates` resolves/reads those
  paths at runtime.
- Related tickets: FEAT-145 (steps 4+5 independent verification round where this was
  found; see its Activity log entry `### 2026-09-18 — verifying round 1 (steps 4 + 5…)`
  for the full evidence trail, including the non-independent real-tree control run that
  had to substitute for the lost clean-room evidence). BUG-179 and BUG-181 record the
  same general shape (a verification harness reconstructing a partial view of the
  project re-breaks every time the real code grows past what the harness copied/stubbed)
  in different harnesses — worth cross-referencing if a fourth instance appears.
- Repro test: none dedicated yet; the repro is embedded in
  `scripts/verify-feat-145-session-override.mjs` run inside a clean room built by
  `scripts/independent-verify.mjs` (see FEAT-145 manifest `c645dfb4a988`). The fixer
  should add a smaller, dedicated must-FAIL fixture per the proof bar above rather than
  relying on that suite.
- Known dependencies / blockers: none. Independent of any in-flight lane; safe to fix at
  any time PROVIDED no lane is mid-run against `scripts/independent-verify.mjs` (one was,
  at filing time — this ticket was filed without touching that script for that reason).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-18 — filed from the FEAT-145 steps 4+5 independent verification round
- **Understood:** the FEAT-145 verifier's §4 abort (`server never became healthy`) was
  traced to `BOOT_STUBS` in `scripts/independent-verify.mjs` being a stale, hand-maintained
  copy of the working-agreement paths `src/server/templates.ts`'s `seedTemplates` actually
  reads — `templates.ts` has grown to four paths (`.md`, `.v2`, `.v3`, `.v4`) while
  `BOOT_STUBS` still only seeds two of them plus four pattern docs, none of the missing
  `.v3`/`.v4`.
- **Changed:** filed this ticket only. No code written — a lane is currently running
  `scripts/independent-verify.mjs` and editing it mid-run would break that run.
- **Verified:** confirmed by direct read at HEAD: `scripts/independent-verify.mjs:255-262`
  lists six stub paths, none of them `.v3.md`/`.v4.md`; `src/server/templates.ts:85-88`
  declares all four working-agreement variants. Matches the FEAT-145 verifier's own
  diagnosis verbatim. Not independently re-run for this filing (finding-phase ticket).
- **Still open / handoff:** un-owned. Fixer: make `templates.ts` the sole declared source
  of the boot-required path list and have `independent-verify.mjs` read it, per the proof
  bar above — do not just append the two missing paths to `BOOT_STUBS`.
- **Symptom of a deeper design flaw?** not closing this ticket, so not answered yet — but
  this is a fresh instance of the project's own named ARCH-010 pattern (a fact duplicated
  instead of declared once by its owner), not a new class; no new ARCH ticket filed.

### 2026-09-18 — fixing round 1 (the stub list now has one owner, and a gap is loud)
- **Understood:** confirmed the diagnosis by execution, not by reading: a room stripped exactly
  as the clean room strips it and stubbed from the pre-fix six-path list never becomes healthy,
  and the server's own death names `docs/prompts/WORKING_AGREEMENT.v3.md`. That message never
  reached the verification round, which saw only the health-check timeout.
- **Changed:**
  - **NEW `src/server/seed-sources.mjs` (+ `.d.mts` sidecar, the `board-path.mjs` convention).**
    The single declaration of which repo docs `seedTemplates()` reads: `SEED_SOURCE_PATHS`
    (id → repo-relative path), `seedSourceRelPath(id)` (throws BY NAME for an undeclared id),
    `seedSourceRelPaths()`, and `READ_THROUGH_SEED_IDS` (the pre-FEAT-027 ids that adopt their
    path as a read-time `source:` default). Plain ESM so a `scripts/*.mjs` reader can import it
    without a TypeScript toolchain.
  - **`src/server/templates.ts`** reads that declaration and no longer holds a path literal of
    its own: `DEFAULT_SEED_SOURCES` is derived from it, and every seed entry lost its
    `sourceAbs:` line — the loop resolves `seedSourceAbs(s.id)` instead, OUTSIDE the refresh
    branch's fail-open `catch`, so an undeclared seed surfaces by name rather than being
    swallowed. A future seed therefore CANNOT introduce a boot-required doc the clean room has
    never heard of; there is nowhere left to write one.
  - **`scripts/independent-verify.mjs`**: `BOOT_STUBS` is **deleted**. New
    `declaredBootDocs(dir)` imports the declaration **out of the room's own exported copy** —
    the revision under test, so the stub set always matches the code that will boot — and the
    seeding moved into an exported `seedBootStubs(dir)`. Loud failure at every step, each
    naming the path: a missing declaration WHILE `src/server/templates.ts` is present refuses
    (a repo with no seeding server declares nothing and is correctly stubbed with nothing, so
    non-Orchard verifications are unaffected); an unusable declaration refuses; a stub that
    cannot be written refuses; and after seeding, every declared doc must EXIST or the room
    refuses to be handed over — never a health-check timeout.
  - **NEW `scripts/verify-bug-182-cleanroom-boot-stubs.mjs`** + `npm run verify:bug-182-cleanroom-boot`.
- **Verified:** `node scripts/verify-bug-182-cleanroom-boot-stubs.mjs` → **21/21 PASS**, with
  REAL servers booted in REAL stripped rooms (scratch `CLAUDE_STATION_DATA`/`CLAUDE_CONFIG_DIR`,
  killed by pid):
  - **MUST-FAIL, synthesized inline** (the stale six-path list is written out in the suite as a
    fixed anchor — never `git show HEAD:`, per CONVENTIONS): the room never becomes healthy and
    the server names `cannot read seed source …/WORKING_AGREEMENT.v3.md`.
  - **After the fix, same room:** `seedBootStubs` adds exactly `.v3`/`.v4`, every stub is inert
    placeholder text, the server boots and answers `/api/health`, and its data dir really
    contains `working-agreement-v3.md`/`-v4.md`.
  - **THE CLASS ASSERTION:** a scratch copy grows a NEW seed (`working-agreement-v5` →
    `docs/prompts/WORKING_AGREEMENT.v5.md`) in `seed-sources.mjs` + `templates.ts`; the clean
    room sees 9 boot docs instead of 8, stubs the new one automatically and the grown room
    boots — with `scripts/independent-verify.mjs` byte-unchanged (sha256 prefix
    `416246211b632333` before and after, asserted in-suite).
  - **Loud, not silent:** a missing declaration with the seeder present exits 2 naming both
    files; an uncreatable stub exits 2 naming the exact path; neither message is a timeout.
  - **No regression in the general error path:** an unrelated deleted file
    (`src/server/liveness.ts`) still fails as `ERR_MODULE_NOT_FOUND`, the stub machinery does
    not claim it, and seeding reports nothing to add.
  - Harness regression suite: `npm run verify:independent-verification` → **152/152 PASS**
    (1 SKIPPED — the pre-existing restricted-sandbox skip). Template suites green:
    pattern-templates 34/34, template-readthrough 18/18, feat-096-template-refresh 19/19,
    local-conventions 18/18, boot-aware 12/12, routing-inject 18/18, feat-132-session-config
    14/14, feat-113-system-prompt-stable 11/11. `npm run typecheck` 0 errors; `npm run gate`
    PASS.
- **Still open / handoff:** independent verification not yet run (fixing-phase entry).
  **Could not test:** a real cross-provider dispatch through the full clean room (that costs a
  live verification run — the suite exercises `buildCleanroom`'s strip+stub path and boots the
  room's real server instead); and `scripts/verify-feat-077.mjs` fatals on a WebSocket
  close-before-open race, which was confirmed PRE-EXISTING by running it against a scratch copy
  of the tree with `templates.ts`/`independent-verify.mjs` restored from HEAD — identical crash,
  so it is not caused by this change and all of its template checks pass before the crash.
- **Symptom of a deeper design flaw?** It is a fresh instance of the project's own ARCH-010
  pattern, now closed at the source rather than topped up: the second place is deleted, not
  synchronised, and no drift-checker was added (CONVENTIONS rejects that shape by name).
