# BUG-177 — a failed quality-gate hook is invisible for the whole session

- **Status:** OPEN — fix built, awaiting independent verification
- **Severity:** medium
- **Area:** server (transcript roll-up) / client (transcript view)
- **Reported:** 2026-09-08 by orchestrator (measured on a live project)
- **Verification-class:** fix ⟶ independent verification REQUIRED before VERIFIED.

## Symptom
A Claude Code hook (a quality gate) can fail on EVERY turn and Orchard shows the
user nothing. Measured today: one project emitted `hook_non_blocking_error` on
every single turn — `Cannot find module <project>/scripts/hooks/response-format-gate.mjs`,
21 records in one session — so its response-format gate has silently NEVER run. A
grep for `hook_non_blocking_error` across `src/` returned zero matches: Orchard
ingested those records and dropped them. A gate whose failure is invisible is
worse than no gate — it manufactures the confidence the gate was installed to earn.

## Repro
Open a session whose transcript contains `type:"attachment"` lines with
`attachment.type === "hook_non_blocking_error"` (e.g. a hook whose module is
missing). Pre-fix: the transcript view renders normally and says nothing — the
attachment lines are neither `user` nor `assistant`, so every transcript reader
(`readSession`, `tailMessages`, `readForward`, `countMessages`) filters them out.

## Expected
The failure is surfaced and impossible to scroll past silently: a once-per-session
roll-up stating the hook name, the error, and how many turns were affected, plus a
per-turn indicator on each affected turn. A hook that FAILED TO RUN (module missing,
non-zero exit at launch) is distinguished from one that RAN and reported something —
the first is the dangerous one.

## Context pack (grows — the "where to look", so no agent cold-starts)
- Files/functions in play:
  - `src/server/transcript.ts` — `countMessages()` is the ONE full scan the
    transcript route already pays for; the roll-up is folded into it
    (`collectHookError` / `HookErrorSummary`, cached per (size,mtime) alongside
    the message count). Cheap-guarded by a single `indexOf` per line.
  - `src/server/index.ts` — the `/api/transcript/<dir>/<id>` route (tail + forward
    branches) now carries `hookErrors: counted.hookErrors` on the response.
  - `public/app.js` — `mountHookErrorBanner()` (session banner) + `applyHookBadges()`
    (per-turn badge), called from `openSession()` and `loadOlder()`; both exposed
    on `window.__station` for the verify script. `prependNodes()` updated so older
    pages never jump above the banner.
  - `public/styles.css` — `.hookfail` banner (borrows the board's brick/amber
    status tints) + `.hook-turn-badge`.
- Record shape (CLI 2.1.263): `{ type:"attachment", parentUuid, attachment:{
  type:"hook_non_blocking_error", hookName, hookEvent, stderr, stdout, exitCode,
  command, durationMs } }`. `parentUuid` links the failure to its turn's message.
- Classification: `crash` (never ran — MODULE_NOT_FOUND / ENOENT / exec-format /
  permission signatures in stderr) vs `reported` (ran, exited non-zero with a
  message). Grouped by (hookName, hookEvent, kind, message); `count` = turns hit.
- Repro test: `node scripts/verify-bug-177-hook-errors.mjs` (18/18).
- Related tickets: ARCH-010 (fact owned once by its writer — the roll-up is owned
  at the scan, not re-derived per reader); FEAT-132 (the sibling session-config
  card this banner sits beside).

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### 2026-09-08 — worker (fixing, round 1)
- **Understood:** the hypothesis held — the attachment records DO reach the
  server (they are in the transcript file the route already scans); they were
  simply filtered out by the `user`/`assistant` entry filter and never surfaced.
  So this is a carry-through plus a render, no new store, poll loop, or pipeline.
- **Changed (unstaged):**
  - `src/server/transcript.ts` — `HookErrorSummary`/`HookErrorGroup`/`HookErrorRef`
    types, `collectHookError`/`classifyHookError`/`hookErrorMessage`; folded into
    `countMessages` (one `indexOf` per line, cached with the count).
  - `src/server/index.ts` — `hookErrors` added to both transcript route branches.
  - `public/app.js` — `mountHookErrorBanner` + `applyHookBadges`, wired into
    `openSession`/`loadOlder`, `prependNodes` anchor updated, both exposed on
    `window.__station`.
  - `public/styles.css` — `.hookfail` banner + `.hook-turn-badge`.
  - `scripts/verify-bug-177-hook-errors.mjs` (new), `scripts/scratch-bug177-server.mjs`
    (scratch boot for the visual proof).
- **Verified (fixer's own run):**
  - `node scripts/verify-bug-177-hook-errors.mjs` → **18/18 PASS**. Must-FAIL
    proof anchored to a reconstructed pre-fix surface (messages-only): it shows
    NO hook failure — the bug. Post-fix `countMessages().hookErrors` surfaces all
    of them: totalRecords 23 (21 crash + 2 reported), correct classification,
    legible message (`Cannot find module …`, no stack), parentUuid carried,
    2 distinct groups. Negative case: a clean session → totalRecords 0, no groups.
    REAL ARTIFACT: a real transcript under `~/.claude/projects` with a
    `hook_non_blocking_error` record → roll-up total matched the raw line count and
    classified as `crash`.
  - Real server + Playwright (headless): booted a scratch server over a seeded
    isolated `CLAUDE_PROJECTS_DIR`; `GET /api/transcript/.../…?tail=100` returned
    `hookErrors` (22 total / 21 crash / 1 reported / 2 groups). Rendered through
    the REAL app: brick banner "A quality-check step never ran — Stop failed to
    start on 21 turns … (+1 other hook warning.)", expanded groups showing
    `Stop / never ran / 21 turns` + the missing-module message and
    `PostToolUse / reported / 1 turn`, and 21 brick "gate skipped" per-turn badges.
    A clean session rendered NO banner, NO badge, NO empty container.
  - `npm run gate` → leak-gate PASS, check-nul PASS, **typecheck FAIL** — the only
    errors are in `src/server/dispatch-broker.ts`, a concurrent lane's uncommitted
    WIP this charter told me not to touch; my files (`transcript.ts`, `index.ts`)
    produce zero tsc errors. Leak scan of my new files clean (positive control fired).
- **Could not test:** the live per-turn badge on OLDER pages beyond the newest
  tail page relies on `loadOlder` re-running `applyHookBadges` — exercised in code
  but not screenshotted at depth. The gate could not be run fully green because of
  the unrelated `dispatch-broker.ts` WIP.
- **Verified-by:** PENDING — independent clean-room verify warranted (this is a
  session-lifecycle/data-visibility change; the fixer wrote the fixtures).
- **Still open / handoff:** independent verifier should (a) drive a REAL busy
  session with a MIX of crash and reported hooks and confirm the banner headline
  uses crash counts (not total) and names only crashing hooks; (b) truncate a
  real transcript mid-`attachment`-line and confirm the count scan does not
  miscount or throw (partial-read case — `collectHookError` swallows parse errors,
  but grade it against the REAL truncated artifact); (c) confirm the cache keyed on
  (size,mtime) returns the same `hookErrors` on a warm hit.
- **Symptom of a deeper design flaw?** (answer on close.) Candidate: ARCH-010 in
  spirit — the transcript readers each independently decide "what counts as a
  message" and silently drop everything else, so a NEW record type is invisible
  until someone notices. Worth a look if a third record type gets dropped this way.
