# FEAT-044 — onboard external-project-A: first external project on the full Orchard stack

- **Status:** DONE — full chain proven live (onboard artifacts + board:check green in
  external-project-A, dashboard-registered with the WA stack, real haiku session received WA +
  board snapshot + routing and quoted the injected board Focus line in a live turn)
- **Area:** cross-project adoption — dogfood of FEAT-038 (onboard), FEAT-041 (shared WA),
  FEAT-039 (local conventions), FEAT-043 (routing/dispatch)
- **Reported:** 2026-08-06 (user: "do whatever can be done"; original ask 2026-08-04 —
  "if I started a session in external-project-A and wanted the same orchestrator…")

## Goal
Bring `~/projects/external-project-A` onto the orchestrator system with ONE action and prove the
whole chain works outside claude-station: onboard scaffolding (board + CLAUDE.md + guard),
registered in the dashboard, a launched session receives the shared WA + board snapshot +
routing guidance, and (if the repo warrants) a starter `docs/CONVENTIONS.md`. This is also the
declared TRIGGER for FEAT-041's deferred multi-consumer methodology story — note what the second
consumer actually needs rather than building it speculatively.

## Constraints
- external-project-A is the USER'S project: scaffold only the opt-in Orchard files (docs/bugs/, CLAUDE.md
  per onboard.mjs, optional CONVENTIONS.md stub); do NOT modify its application code; commit the
  scaffolding in external-project-A's own git ONLY if the working tree is clean and the commit contains
  exclusively the onboarding files (otherwise leave uncommitted + report).
- Registering the project in the dashboard uses the normal add-project API on :4317 (safe,
  no restart); do NOT restart anything.

## Verification (REQUIRED, user-observable)
Onboard artifacts on disk + board:check green INSIDE external-project-A; project visible in the
dashboard; a REAL (cheap haiku) session launched for external-project-A demonstrably receives the
injected WA + board snapshot + routing section (assert via the compose/effective surface, and
one tiny live turn referencing the board proves boot-awareness). Report what the second WA
consumer revealed about the multi-consumer sync gap (observations only).

## Activity log (APPEND-ONLY)
### 2026-08-06 — orchestrator
- Filed + dispatched. external-project-A confirmed present at ~/projects/external-project-A, no board yet.

### 2026-08-06 — onboarding agent — full chain executed + proven live
**Understood:** run the FEAT-038-verified onboard core against the user's real
external-project-A repo, register/configure it in the live dashboard (no restarts, :4317
API only), then prove the whole injection chain with a real cheap session — and
observe (not build) what the second WA consumer teaches FEAT-041's deferred
multi-consumer story.

**Survey (read-only, before touching anything):** external-project-A =
`external-project-A` — a large multi-platform (Discord/Telegram) bot platform in
TypeScript: npm workspaces (`packages/*`, `plugins/*_plugins/*`), plugin
architecture with a hard core/feature-plugin decoupling rule (ADR-057), its own
rich agent docs (`CLAUDE.md` for Claude Code + `AGENTS.md` for Codex — both
forbid agents running ANY git command and any build/deploy), `docs/` with ADRs.
Git: branch `main`, working tree **DIRTY — 644 modified files** (the user's own
in-flight work), incl. `CLAUDE.md` and `package.json` already modified.

**Executed:**
1. `node scripts/onboard.mjs ~/projects/external-project-A` (the real FEAT-038
   CLI core) → CREATED `docs/bugs/{README,INDEX,TEMPLATE}.md`,
   `docs/CONVENTIONS.md`, `scripts/board.mjs`; added `board:check`/`board:gen`
   to its `package.json` (verbatim two-key diff, no reformat of the rest).
   **`CLAUDE.md` correctly reported `exists` and was left byte-untouched** —
   the user's own file wins per the idempotency contract. Re-run → all
   `exists`, board.mjs `exists (identical)` — idempotent on the real repo too.
2. Seeded the `docs/CONVENTIONS.md` stub with GENUINE project-specifics only
   (distilled from external-project-A's own CLAUDE.md + package.json, nothing
   invented): what it is; the repo's hard agent rules (NO git commands, NO
   build/deploy, type-check ok); plugin-docs-first (`plugins/docs/v2/`);
   ADR-057; how to run/check (`npm run dev`, `type-check`, vitest,
   `board:check`).
3. `npm run board:check` INSIDE external-project-A via the COPIED guard → "0 ticket
   file(s) scanned … OK — no drift" exit 0.
4. Dashboard: project was ALREADY registered (id `external-project-A`, discovered via
   `GET /api/projects` — created earlier via the normal add-project flow), so
   no POST needed; that half of "register" was pre-satisfied. Completed
   FEAT-038 item 2 via the normal API: `PATCH /api/projects/external-project-A`
   `settings.instructions = [{templateId: "working-agreement-v2"}]` — every
   launched session now defaults to the shared WA. `GET /api/compose/external-project-A`
   → appliedIds `[working-agreement-v2]`, 13116 chars, preview shows the
   canonical-source banner. `GET /api/projects/external-project-A/board` →
   `hasBoard: true`, all lists empty. NO restarts; service untouched.
5. **Live proof (real dashboard path, real subscription, haiku):** a scratch WS
   client on the REAL `ws://127.0.0.1:4317/ws` sent the same `start` command the
   UI sends (`projectId: external-project-A`, `overrides: {model: 'haiku'}`) → **8/8
   PASS**: ack `appliedTemplates = ["working-agreement-v2","local-conventions",
   "provider-routing"]` (shared WA + injected CONVENTIONS.md + ROUTING.md core
   — the effective composed surface), `instructionMode: append`, session-init
   cwd `~/projects/external-project-A`, model observed
   `claude-haiku-4-5-20251001`. ONE tiny live turn ("quote the Focus line of
   your injected board snapshot; name the routing section heading", NO tools)
   → reply: `**Focus:** board is clear — nothing open` (verbatim from
   `boardStateSection()`'s empty-board snapshot — boot-aware of ITS OWN fresh
   board, live) and `Provider Routing (mixed Claude + GPT fleet)` (the exact
   injected routing heading). Session closed via `{type:'close'}`.
   Screenshots: `assets/FEAT-044-dashboard-external-project-A.png` (project in
   sidebar), `assets/FEAT-044-external-project-A-sessions.png` (project selected, WA v2
   chip on the launch bar), `assets/FEAT-044-external-project-A-session-list.png`
   (session list incl. the proof session), `assets/FEAT-044-live-turn.png`
   (the real transcript: prompt + the two quoted lines).

**Git in external-project-A: NO commit** — the tree was dirty (644 files of the user's
own work, incl. `CLAUDE.md`/`package.json`) so the charter's clean-tree +
onboarding-files-only condition cannot be met. Left uncommitted for the user:
new `docs/bugs/{README,INDEX,TEMPLATE}.md` + `docs/bugs/assets/`,
`docs/CONVENTIONS.md`, `scripts/board.mjs`, and the two `board:*` keys in
`package.json`. (Also honoured external-project-A's own no-git-writes rule — only
read-only `git status/diff` were run there.)

**Multi-consumer WA observations (for the deferred FEAT-041 follow-up — observations ONLY, nothing built):**
- **Launched sessions have NO drift problem by construction.** The second
  consumer reads the SAME mirror (`docs/prompts/WORKING_AGREEMENT.v2.md`
  read-through at compose time) — there is no per-project WA copy to go stale.
  `sync:methodology` (canonical → mirror) already updates every launched
  session on every project at once. Same for ROUTING.md. The multi-consumer
  "pull" story for launched sessions is: nothing to do.
- **The real gap is bare-`claude` coverage, not drift:** onboard's WA reach for
  bare sessions is the CLAUDE.md pointer, but any repo with a pre-existing
  CLAUDE.md (external-project-A — likely the common case for real projects) silently
  gets NO pointer (`exists` no-op is correct, but the outcome is a coverage
  hole). external-project-A's bare sessions follow its own CLAUDE.md and never see the
  WA. A future onboard pass could OFFER appending a short WA-pointer section to
  an existing CLAUDE.md (opt-in, never silent).
- **Per-repo copies that CAN drift are only `scripts/board.mjs`** (by design,
  re-syncable via `--force-board-tool`). With N onboarded projects a fleet-wide
  re-sync sweep ("re-run onboard --force-board-tool across registered
  projects") becomes worth having — trigger it from the registry list, not a
  hand-kept list.
- **The scope audit reaches the second consumer with zero config:**
  `npm run check:scope` auto-discovered `~/projects/external-project-A/docs/CONVENTIONS.md`
  (registry-independent glob) and scanned it. One finding — a FALSE POSITIVE on
  the onboard stub's own preamble (L4 "every project, not just this one…" trips
  the `every-project` heuristic on EVERY onboarded repo). Worth a one-line fix
  someday: reword the stub preamble or teach `check-scope.mjs` to skip the
  stub's boilerplate header.
- **Push-back (a external-project-A session learning a universal rule):** the injected
  WA banner already names the canonical repo (`~/projects/methodology`) + the
  sync command, so a session on ANY project knows where universal edits go.
  Untested live; no mechanism needed yet beyond the existing banner + §L
  routing discipline.

### 2026-08-06 — follow-up agent — three scripts-only chores from the observations above, executed
**Understood:** close out the three "worth a follow-up" items the multi-consumer
observations above flagged, scripts-only, with external-project-A itself HANDS-OFF
(read-only checks on it fine, no writes) and all verification on scratch dirs.

**Changed:**
1. **Opt-in WA pointer for an existing CLAUDE.md** — `scripts/onboard.mjs`:
   new `--wa-pointer` flag. When the target's `CLAUDE.md` already existed
   (report status `exists`, i.e. it predates this onboard run), APPENDS a
   short section delimited by `<!-- orchard:wa-pointer:start/end -->`
   pointing at the shared WA path + the canonical-source note — never
   rewrites the file. Without the flag, behavior is byte-for-byte unchanged
   (new `appendWaPointer()` is only ever called when the flag is set AND the
   file pre-existed). Idempotent: a second `--wa-pointer` run checks for the
   marker and no-ops. A FRESH onboard-authored `CLAUDE.md` (no pre-existing
   file) is untouched by the flag — its own template already contains the
   full pointer inline, so appending again would double it up. Also added the
   flag's type to `scripts/onboard.d.mts`.
2. **Fleet board-tool re-sync sweep** — new `scripts/fleet-sync.mjs`. Reads
   the project list via `GET /api/projects` (read-only; default
   `http://127.0.0.1:4317`, or `--registry-file <path>` for a fixture),
   scopes to projects that HAVE `docs/bugs` on disk (i.e. actually onboarded)
   and are not excluded, then re-runs the SAME `onboard(hostPath, {
   forceBoardTool: true })` core the CLI/UI onboard action uses (no
   reimplementation of the copy/compare logic). `external-project-A` is excluded BY
   DEFAULT (hands-off constraint, not just an example `--exclude`) and is not
   un-excludable via any flag; `--exclude <id>` adds more IDs on top.
   Dry-run by default (reports `would-update` / `identical` / `skip` and
   writes nothing); `--apply` performs the actual re-sync.
3. **check-scope stub false positive** — reworded `CONVENTIONS_STUB`'s
   preamble in `onboard.mjs` from "...applies to **every project**, not just
   this one..." to "...**not specific to this project**..." — the wording
   that was tripping `check-scope.mjs`'s `every-project` heuristic on every
   onboarded repo's stub. Picked this over teaching `check-scope.mjs` to
   special-case the stub's boilerplate: rewording is a one-line, zero-risk
   fix at the source of the false positive, whereas special-casing exact
   preamble wording in the detector adds a maintenance-prone exception and
   risks silently swallowing a REAL leak that happens to share that phrasing.
   Only affects NEWLY onboarded repos — does not retroactively rewrite
   `docs/CONVENTIONS.md` in already-onboarded repos (idempotency contract:
   an existing file is never touched), so the REAL external-project-A stub (written
   before this fix) still trips today; a re-run of onboard cannot fix it
   either (existing file, correctly left alone) — the honest fix there would
   be a manual reword by the user in external-project-A itself, out of scope here
   (hands-off).

**Verified (§C, non-vacuous, scratch dirs only, external-project-A untouched):**
- `node scripts/verify-onboard.mjs` → **36/36 PASS** (26 pre-existing +
  10 new `(g)` cases: flag absent ⇒ byte-identical; flag present ⇒ appends
  once with the marker + WA path; re-run ⇒ idempotent, no duplicate marker,
  byte-identical to the first append; fresh onboard-authored CLAUDE.md is
  never double-appended).
- `node scripts/verify-fleet-sync.mjs` (new) → **21/21 PASS**, against a
  scratch in-process HTTP server (`GET /api/projects` mock on an
  OS-assigned free port — never touches real `:4317`) plus a
  `--registry-file` fixture path. Proves: dry-run correctly classifies
  stale/`would-update`, identical/`identical`, not-onboarded/`skip`,
  default-excluded `external-project-A`/`skip`, and an explicit `--exclude`/`skip` —
  and WRITES NOTHING in dry-run (asserted byte-for-byte); `--apply`
  re-syncs only the in-scope stale project, leaves identical alone, leaves
  BOTH excluded projects' diverged copies untouched; unreachable registry
  source is a hard non-zero exit (never a silent empty sweep). **Found +
  fixed a real bug while writing this test:** the first draft used
  `execFileSync` to spawn the CLI against the test's own in-process HTTP
  server — a synchronous spawn blocks the single-threaded event loop, so the
  server could never accept the child's connection back, a guaranteed
  deadlock. Switched to async `execFile`/`promisify`; documented why in a
  comment so it isn't reintroduced.
- `node scripts/verify-check-scope.mjs` → **12/12 PASS** (9 pre-existing +
  3 new): a sanity check proves the OLD stub wording DID trip
  `every-project` (so the new-case checks are non-vacuous); a freshly
  `onboard()`-ed scratch repo's `docs/CONVENTIONS.md` is NOT flagged
  anymore; a REAL universal-sounding line appended to that same file still
  trips the SAME pattern — the detector itself is unweakened, only the
  false-positive source was removed.
- `npm run typecheck` → clean.
- Ran `node scripts/check-scope.mjs` for real (read-only) against
  `~/projects/*` as an honesty check: it still flags the REAL
  `external-project-A/docs/CONVENTIONS.md` (written before this fix, untouched per
  hands-off) — expected, not a regression; matches the "only new onboard
  runs get the reworded stub" scoping above.
- No `:4317` writes (fleet-sync.mjs and its test only ever GET; the scratch
  HTTP server used by the test is a separate in-process mock on a free
  port). No writes anywhere under `~/projects/external-project-A`. All scratch procs
  killed by pid (one stray manual debug server on a leftover port, killed by
  pid, no pkill). No git commit.

**package.json — NOT edited per constraint.** Entries a maintainer may want
to add by hand: `"verify:fleet-sync": "node scripts/verify-fleet-sync.mjs"`
and optionally `"fleet-sync": "node scripts/fleet-sync.mjs"`. `verify:onboard`
and `verify:check-scope` already exist and now cover the new cases without
any script-key change (the new assertions live inside the same two files).

**Still open / handoff:** the real `external-project-A/docs/CONVENTIONS.md` still
trips `check:scope`'s `every-project` heuristic (pre-fix wording, hands-off —
not touched here); whoever next has write access to external-project-A could reword
that one line by hand. `fleet-sync.mjs` has never been run with `--apply`
against the real `:4317` registry (only against scratch fixtures) — first
real use should probably still start as a dry-run to sanity-check the live
project list before anyone reaches for `--apply`.

- 2026-08-06 — privacy scrub for public release (FEAT-049, sanctioned append-only exception): private names/paths neutralized (project aliases, home paths → ~).
