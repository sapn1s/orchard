# FEAT-131 — new projects default to container isolation (+ snapshots), safely

- **Status:** IMPLEMENTED — awaiting independent verify
- **Severity:** medium
- **Area:** server (registry / snapshots / project creation)
- **Reported:** 2026-09-06 by orchestrator dispatch
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED.

## Symptom
Isolation was per-project and defaulted to `direct` (`registry.ts`
`input.isolation ?? 'direct'`). New projects therefore ran on the host with no
reflink snapshots unless the user hand-flipped the knob — the safe, cheap
default (container + near-free btrfs reflink snapshots) was opt-in, so nobody got
it by default.

## Expected
Newly-created projects default to `container` isolation (which auto-enables
snapshots via `snapshotSettingsOf`), **for new projects only**, behind a
preflight that falls safe to `direct` when the machine can't honour it. Existing
projects are never touched.

## Scope / non-goals (established by a prior feasibility audit — do NOT re-audit)
- **Only the default for NEW projects.** Existing projects keep their stored
  isolation exactly. Force-migrating an existing live-bot project into a
  container would seal it off from its running host process — that breaking form
  is explicitly out of scope.
- **Docker socket stays OFF** (`defaultContainerSettings().dockerSocket === false`).
  The host-root opt-in remains a separate, explicit decision.
- Per-project escape hatch (PATCH `isolation` back to `direct`) is unchanged.

## What changed
- `src/server/registry.ts`
  - `NEW_PROJECT_DEFAULT_ISOLATION = 'container'` and `resolveNewProjectIsolation(hostPath)`:
    tries the container default, falls SAFE to `direct` when the Docker daemon is
    unreachable (`dockerAvailable()`) or reflink is unavailable (`reflinkProbe()`).
    Fail-safe, never fail-blocking — a project is always created.
  - `createProject`: when the request names no isolation, uses the preflight; an
    EXPLICIT `input.isolation` is honoured as-is with NO preflight (caller decided).
  - New `Project.isolationPreflight?` audit record ({wanted, applied, reason, at}),
    written only on preflight-resolved creations, so a container-default machine
    that produced a `direct` project explains itself. Never read to drive behaviour.
- `src/server/snapshots.ts`
  - New `reflinkProbe(projectHostPath)`: runs the REAL `cp --reflink=always` from a
    throwaway file in the project into the snapshot store; catches both non-reflink
    FS and cross-device store. Non-destructive (temp entries removed in `finally`).
- `onboard.mjs`: no change needed — it does not set isolation.
- Scratch project (`ensureScratchProject`) unchanged: stays explicit `direct`.

## Context pack
- Files/functions in play: `registry.ts` (`createProject`, `resolveNewProjectIsolation`,
  `NEW_PROJECT_DEFAULT_ISOLATION`, `IsolationPreflight`, `snapshotSettingsOf`,
  `containerSettingsOf`), `snapshots.ts` (`reflinkProbe`, `snapshotsRoot`),
  `container-manager.ts` (`dockerAvailable`). Create route: `index.ts` POST
  `/api/projects` → `validate.ts` `validateCreateProject` (UI sends no isolation,
  so the default governs UI-created projects).
- Related tickets: FEAT-109/BUG-151 (browser-in-container works), FEAT-102
  (container ↔ openai), snapshot mechanism (`snapshots.ts` header).
- Repro test: `verify-feat-131-container-default.mjs` (kept in the scratch dir,
  not committed; synthetic-but-realistic — uses real btrfs for reflink-yes and
  tmpfs (`/dev/shm`) for reflink-no, the real docker daemon plus a bogus-docker
  subprocess for the no-daemon branch).
- Known dependencies / blockers: none.

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-06 — worker (fixing, round 1)
- **Understood:** default isolation was `direct`; container auto-enables snapshots;
  btrfs reflink makes snapshots near-free; the ONLY breaking risk is migrating
  EXISTING projects, so change the CREATION default only, guarded by a preflight.
- **Changed:** `src/server/registry.ts`, `src/server/snapshots.ts` (see "What
  changed"). Left UNSTAGED — no git writes. No user project's isolation touched.
- **Verified (fixer's own run — necessary, not sufficient):**
  - `verify-feat-131-container-default.mjs` (run from the scratch dir) — **PASS 17/17**:
    A) new btrfs+docker project → `container`, preflight applied=container/reason=null,
    snapshots auto-ON (source auto-container), dockerSocket=false;
    B) tmpfs (no reflink) → falls back to `direct`, reason cites reflink, snapshots
    auto-OFF, no probe temp files left behind;
    C) bogus docker (subprocess) → falls back to `direct`, reason cites docker/PATH;
    D) explicit `direct`/`container` on request → honoured, NO preflight record;
    E) existing `direct`+`container` rows load unchanged; **MUST-FAIL guard**: an
    unrelated `updateProject` does NOT flip an existing `direct` project;
    F) escape hatch: `updateProject({isolation:'direct'})` flips a container-default
    project back.
  - **MUST-FAIL proof before fix:** temporarily reverted `createProject` to
    `input.isolation ?? 'direct'` → suite dropped to 11/17 (A1/A2/A3/B2/C2/F0 failed),
    then restored → 17/17. Confirms the suite actually tests the change.
  - Anti-regression: `node scripts/verify-onboard.mjs` **51 passed, 0 failed**;
    `node scripts/verify-conventions-live.mjs` **5/5** (uses explicit `direct`, unaffected).
  - `npm run gate` (unpiped) — **GATE: PASS (exit 0)** — leak-gate, check-nul, typecheck.
- **Verified-by:** PENDING — high-stakes (session-lifecycle / isolation default,
  regression-prone). An independent clean-room verify pass is warranted; a case the
  fixer's fixture does NOT cover: real UI POST `/api/projects` (no isolation in body)
  end-to-end producing a container project, and behaviour on a genuinely
  non-reflink OR daemon-down host that is not the fixer's simulated one.
- **Still open / handoff:** ticket status set IMPLEMENTED; needs the `Verified-by:`
  clean-room dispatch line before VERIFIED. The verify script lives in the scratch
  dir (not committed) — promote/port it under `scripts/` + package.json if the
  board wants a permanent `verify:feat-131`.
- **Symptom of a deeper design flaw?** n/a (ticket not being closed).

### 2026-09-07 — worker (fixing, round 2) — verify-suite fallout of the container default
- **Charge:** the container-plus-snapshots default (this ticket) silently broke
  lifecycle/liveness verify suites that register a project with NO isolation and
  then assume the resulting session is DIRECT (broker `claudePid`, systemd
  survival broker, scripted fake `claude` via `CLAUDE_STATION_CLAUDE_BIN`,
  host-process reaping). Three failures were reported by the BUG-159 round-3 lane.
- **Hypothesis CONFIRMED (not a product regression):** these are STALE
  TEST-HARNESS assumptions, not a product bug. `createProject` correctly honours
  an EXPLICIT `input.isolation` with NO preflight (registry.ts 699-701;
  validate.ts 88/126-130 accept `isolation` on create). The product is right; the
  suites were written for the pre-FEAT-131 `direct` default and never said so.
- **Reproduced each (must-FAIL before fix, real artifacts):**
  1. `verify-zombie-busy A` → **FATAL** `TypeError: pid must be a number` at
     zombie-busy.mjs:273 — the container session has no `broker.claudePid`, so
     `victim=null` and the mid-turn `process.kill(victim)` throws (5 pre-checks
     shown, precondition "a live CLI behind it" FAILs).
  2. `verify-bug-157-woken` (woken scenario) → **2/4**: `beats=0`, FIX A FAILs —
     the container ignores the host-path fake bin, so the woken turn's heartbeat
     never runs; the full suite also blows its ~260s budget on container startups.
  3. `verify-liveness-conformance --guard-only` L4 → FAIL on `const isOwnerLive`
     in `runtime/claude-runtime.ts`. **Attribution verified: NOT this ticket.**
     `isOwnerLive` (claude-runtime.ts 683-700) is a sibling lane's UNCOMMITTED
     file-lock owner check, ABSENT from HEAD (`git show HEAD:...` has no match). A
     clean HEAD passes L4. Left ALONE — `src/server/*` is a concurrent lane's
     scope and the allowlist/rename belongs to whoever lands that change.
- **Fix (test-harness only):** add an EXPLICIT `isolation: 'direct'` to the
  `POST /api/projects` register body in each direct-mechanism suite. Per this
  ticket, explicit isolation is honoured as-is with no preflight, so this
  reproduces the EXACT pre-FEAT-131 substrate — it can only fix or be a no-op,
  never reduce coverage (each suite still asserts everything it did: broker-pid
  ground truth, survival reap, fuse decline, drain truth, etc.).
- **Verified (must-PASS after fix, real command output):**
  - `verify-zombie-busy A`: FATAL → **14/14** (16s).
  - `verify-bug-157-woken` (full): 2/4-and-over-budget → **12/12 in 219s**
    (< 260s — both the semantic break and the budget overrun cleared).
  - Representative sweep suite `verify-bug-096-...`: **180s hang (must-FAIL)** →
    **17/17 in 11s**.
  - Representative sweep suite `verify-feat-126-e2e`: **7/7 in 3s**.
  - `npm run gate` (unpiped) — **GATE: PASS (exit 0)** (leak-gate, check-nul,
    typecheck; edits are `.mjs` + comments only).
  - `node --check` clean on all 24 edited files; `isolation: 'direct'` present
    exactly once per file (twice in bug-068, which registers two projects).
- **MANDATORY CLASS SWEEP (report every instance, fixed or listed).** Searched
  all `verify-*.mjs` that `POST /api/projects` with no isolation AND assert
  direct-only ground truth. **Fixed (24 suites):** verify-zombie-busy,
  verify-bug-157-woken-turn-and-revival, verify-bug-096-bg-child-lane-no-fabricated-death,
  verify-bug-114-orphan-bound, verify-close-background-detach,
  verify-bug-044-restart-background, verify-health-survivor,
  verify-feat-064-drain-truth, verify-survival-deployed, verify-restart-survives,
  verify-restart-reconnect-race, verify-bug-072-delivery-visible,
  verify-feat-065-delivery, verify-hosts-cleanup, verify-bug-074-ghost-drain,
  verify-refusal-visible, verify-bug-105-foreground-subagent-of-live-owner,
  verify-restart-interrupt-label, verify-stale-agent-cards,
  verify-arch-003-owner-lifetime, verify-arch-003-open-tool-calls,
  verify-arch-003-per-row-owner-sweep, verify-bug-068-bash-background-visible,
  verify-feat-126-e2e. Of these, 4 were individually re-run (2 observed + 2
  representative, all green); the other 20 got the identical provably-safe edit,
  are syntax-checked, but were NOT individually re-run (systemd / real-session /
  API cost) — honest limitation.
  - **Examined and NOT fixed (unaffected):** `verify-resume-refusal` registers a
    project but starts NO session (`type:'start'` count = 0); it PLANTS survivor
    host records and exercises the pre-spawn BUG-022 send-guard, which fires
    before any engine/container is created — the container default cannot reach it.
  - **Not mine:** `verify-liveness-conformance` L4 (sibling's uncommitted
    `isOwnerLive`, see above).
- **Verified-by:** PENDING — session-lifecycle-adjacent + a large mechanical
  blast radius (20 suites fixed-but-not-re-run). An independent clean-room pass
  that actually RUNS the 20 unrun suites (several need `systemd-run --user`) is
  warranted before treating the sweep as closed.
- **Files changed (all UNSTAGED, no git writes):** the 24 `scripts/verify-*.mjs`
  listed above, plus this ticket. No `src/server/*`, `public/*`, or the
  collision-listed scripts were touched.
