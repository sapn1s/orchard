#!/usr/bin/env node
/**
 * onboard.mjs — FEAT-038: "onboard this project to Orchard" in one action.
 *
 * The orchestrator methodology (board + working-agreement + drift-guard)
 * already carries to ANY project via the `tickets` skill + WA read-through +
 * zero new code — but wiring a fresh repo up today is a handful of MANUAL
 * steps (scaffold docs/bugs by hand, remember to add a CLAUDE.md pointer,
 * copy board.mjs over, wire npm scripts). This script is that one action,
 * and it is IDEMPOTENT: re-running never clobbers something already there,
 * it just reports what already existed vs. what it created.
 *
 * What it does to <target-dir>:
 *   1. Scaffolds docs/bugs/{README.md,INDEX.md,TEMPLATE.md} — the `tickets`
 *      skill's board shape verbatim (see ~/.claude/skills/tickets/SKILL.md
 *      and this repo's docs/bugs/README.md, which the skill mirrors).
 *      Opt-in: pass --no-board to skip this for a scratch dir the user does
 *      NOT want a durable board in (the tickets skill is explicit that
 *      scratch/ad-hoc-prompt dirs should not get one).
 *   2. Drops a thin project CLAUDE.md that points at the shared Working
 *      Agreement (today `docs/prompts/WORKING_AGREEMENT.v2.md` in the
 *      claude-station repo — FEAT-039 gap #2 is hoisting that to a
 *      project-neutral location; until that lands this pointer is an
 *      absolute path into claude-station, which is the honest state of the
 *      world today, not a design claim that this is the final home) plus a
 *      docs/CONVENTIONS.md stub — the per-project local-rules doc FEAT-039's
 *      `localConventionsSection()` (src/server/templates.ts) already knows
 *      how to read and inject alongside the shared WA.
 *   3. Makes the board drift-guard (`board:check` / `board:gen`, today
 *      claude-station-local scripts/board.mjs) portable: COPIES board.mjs
 *      into the target project's own scripts/ dir and wires board:check /
 *      board:gen into the target's package.json.
 *
 * Design decision — copy, not a shared/npm dependency (documented per the
 * ticket's "pick the clean approach and document it"):
 *   board.mjs has zero dependencies outside node builtins (fs/path/url) and
 *   already takes a --dir flag, so it needs no path rewriting to work
 *   unmodified in another repo. Three alternatives were considered and
 *   rejected for a single-user, no-registry-published tool:
 *     - npm package: would require publishing/versioning infra for one
 *       script — pure overhead here.
 *     - symlink to the claude-station copy: breaks the moment either repo
 *       moves (exactly the FEAT-039 gap #2 coupling problem, self-inflicted
 *       on a second script) and silently stops working if claude-station's
 *       checkout is ever deleted.
 *     - invoke claude-station's copy via an absolute path from the target's
 *       npm scripts: same fragility as the symlink, plus requires the
 *       target project to always know where claude-station lives.
 *   A plain file copy is self-contained (the guard keeps working even if
 *   claude-station is later moved/renamed/removed) at the cost of the two
 *   copies being able to drift if board.mjs itself changes — acceptable
 *   because board.mjs churns rarely and the fix, if that ever matters, is to
 *   re-run onboard with --force-board-tool (below) to re-sync.
 *
 * Idempotency contract: on re-run, every artifact that already exists is
 * left BYTE-FOR-BYTE untouched (reported as "exists", not overwritten) —
 * this protects any local customization (e.g. a filled-in
 * docs/CONVENTIONS.md, or a hand-edited board.mjs) from being clobbered by a
 * second onboard pass. Pass --force-board-tool to explicitly re-sync just
 * the copied board.mjs from this repo (the one artifact meant to mirror its
 * source); every other artifact has no --force equivalent by design, since
 * "safe no-op" is the whole point.
 *
 * DEFERRED (not built here, per FEAT-038's own sub-gaps list):
 *   - Per-project Serena/Playwright tool-tier toggle — FEAT-025/FEAT-033.
 *   - Any UI action / button — this is the CLI core FEAT-038 asked for;
 *     a UI affordance that shells out to this script is a separate pass.
 *
 * Usage:
 *   node scripts/onboard.mjs <target-dir> [--no-board] [--force-board-tool] [--force-hook] [--wa-pointer] [--deploy-context]
 *
 * --force-hook (BUG-118 round 3) is now a NO-OP ALIAS: the response-format Stop
 * hook is re-synced on EVERY run, flag or not, because it is the one installed
 * file no target repo can plausibly own (see RESYNCABLE_HOOK). The flag is still
 * accepted so existing callers and muscle memory keep working.
 *
 * --deploy-context (FEAT-050): opt-in docs/DEPLOY-CONTEXT.md stub — the
 * per-project "what prod/public ACTUALLY looks like" doc the independent
 * commit gatekeeper (claude-station scripts/gatekeeper.mjs) injects into
 * every reviewer so works-locally-breaks-prod mismatches are catchable.
 * Same idempotency contract as everything else here: an existing file is
 * never touched.
 *
 * --wa-pointer (FEAT-044 follow-up): when the target already has its own
 * CLAUDE.md (the common case for a real pre-existing repo — onboard's
 * idempotency contract correctly leaves it byte-untouched), that repo's bare
 * `claude` sessions silently never see a pointer to the shared WA. This flag
 * opts into APPENDING a short, clearly-delimited section to the end of that
 * existing file (never rewrites it) so bare sessions can find the shared WA
 * too. Without the flag, behavior is byte-identical to before. Idempotent:
 * re-running with the flag never duplicates the section.
 *
 * Exit code 0 always on a successful run (idempotent, nothing to fail on
 * a re-run); non-zero only on a real error (bad target dir, I/O failure).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
// BUG-146 — the scaffold text is owned in one place so the injector's
// "is this an unedited stub?" test can never drift from what we emit here.
import { CONVENTIONS_STUB } from './lib/conventions-stub.mjs';
// FEAT-106 stage 3 — the ONE place that classifies a project's board layout, so
// onboard's board placement (fresh → `.orchard/bugs`; legacy → declared in
// place) agrees with every reader that routes through the same resolver.
// FEAT-106 round 9 — the guarded target-read helpers are OWNED by board-path.mjs
// (node-builtins-only, copied into targets), and onboard/fleet-sync import them
// from there so EVERY target-repo read in scripts/lib/* and both entry scripts
// comes from one module. Re-exported below for fleet-sync and the verify suites.
import { boardLayout, resolveBoardDir, readTargetFile, targetBytesEqual } from './lib/board-path.mjs';
export { readTargetFile, targetBytesEqual };

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// FEAT-106 — the consolidated project-local directory, the way `.claude/` works.
// Everything Orchard generates for a target lives under here; `public/` and the
// scattered `scripts/`/`docs/` copies are never written to a target again.
const ORCHARD = '.orchard';

// ---------------------------------------------------------------------------
// Content templates (mirror ~/.claude/skills/tickets/SKILL.md's scaffold
// spec + this repo's own docs/bugs/{README,TEMPLATE}.md shape).
// ---------------------------------------------------------------------------

const BUGS_README = `# Bug tracker — accumulating-context tickets

In-repo issue tracking where **each ticket is the issue's durable memory**. The
problem this solves: multi-agent fixing cold-starts every attempt, re-derives
context, and regresses — a bug gets "fixed" three times and stays broken because
each agent lost what the last one learned. Here, context accumulates on the
ticket, so attempt N inherits attempts 1..N-1 and does not repeat their misses.

## The core mechanism: the Activity log is APPEND-ONLY

Every ticket has an \`## Activity log (append-only)\` section. Every agent that
touches the issue MUST:

1. **Read the whole ticket first** — especially every prior log entry. You
   inherit all prior diagnosis, every approach tried, and why each fell short.
2. **Not repeat a failed approach** the log already records, unless you state
   precisely why it will differ this time.
3. **Append your own dated entry** (never edit or delete a prior one) with:
   what you understood, what you changed (files + commit sha once committed),
   what you **verified** (commands + PASS/FAIL lines + screenshot paths), what
   is still open, and — if not fully solved — a precise **handoff**: "next agent
   should try X because Y." A dead end with a handoff is a valid outcome; a
   silent "done" that wasn't is the failure this whole system exists to prevent.
4. **Run the FULL relevant verify suite**, not just your own new test, before
   claiming a fix — anti-regression. If your change touches a file another
   ticket also touches, run that ticket's test too.
5. **Answer the closing question when you close a ticket**: TEMPLATE.md's
   "**Symptom of a deeper design flaw?** (no / yes → ARCH-### filed)" — one
   line, required, so a structural suspicion is handed forward instead of
   dropped (shared Working Agreement §N).

## Files

- \`INDEX.md\` — the board.
- \`<ID>-<slug>.md\` — one ticket. IDs: \`BUG-NNN\`, \`FEAT-NNN\`, \`DEPLOY-NNN\`,
  \`ARCH-NNN\`.
- \`assets/\` — screenshots, named \`<ID>-*.png\`.
- \`TEMPLATE.md\` — the shape, including the Context pack + Activity log.
- \`TEMPLATE-ARCH.md\` — an \`ARCH-NNN\` ticket: the container for a
  **re-architecture decision** (violated invariant, options + trade-offs,
  migration path, proof bar). Symptom framing is forbidden there.
- \`.arch/\` — derived, git-ignored: the recurrence detector's findings for
  this project's Needs-You rail. Never hand-edited.

## Architecture-review loop (\`npm run arch:watch\`)
\`scripts/arch-watch.mjs\` clusters this project's CLOSED tickets by declared
subsystem and raises a needs-human finding when one subsystem has been patched
past the recurrence threshold — the mechanical half of "a symptom fixed 2–3×
means the design is wrong". It NEVER refactors and never files a ticket: it
raises a question on this project's Needs-You rail; a human decides; if the
answer is "redesign", the work lives in an \`ARCH-NNN\` ticket. Full contract,
thresholds and dismissal mechanics: claude-station's
\`docs/ARCHITECTURE-REVIEW.md\`.

## Status: OPEN → IN-PROGRESS → VERIFIED → DONE. Also BLOCKED, NOT-A-BUG.

## Hard rules for any agent on a ticket
- NEVER kill/restart a live dev server a running session depends on.
  Verification spawns its own scratch server on a free port; kill by pid,
  never \`pkill\`.
- Verification is the deliverable, not the code. A check that passes on
  empty/missing input is worse than none.
- Do NOT commit unless explicitly asked. Leave changes in the working tree.
- Edit ONLY your ticket file and the code for your fix. Do **NOT** edit
  \`INDEX.md\` — the orchestrator owns it and rebuilds it from ticket statuses
  (two agents editing INDEX clobber each other's rows).
- Two agents must not edit the same code file at once — the orchestrator
  serializes same-file tickets.

## Board drift-guard
\`npm run board:check\` reconciles \`INDEX.md\` against the ticket files (catches
silently-dropped rows, status/severity drift, orphan rows). \`npm run
board:gen\` rewrites \`INDEX.md\` from the ticket files, preserving the
curated Owner/Status-blurb/Commit columns. See \`scripts/board.mjs\`.

_Scaffolded by \`onboard.mjs\` (claude-station FEAT-038); this file mirrors the
\`tickets\` skill's spec._
`;

const BUGS_INDEX = `# Board

See \`README.md\` (append-only tickets; every agent reads the whole ticket + appends).
Owner: 🤖 = subagent in flight · 👤 = needs you · — = queued/unassigned.

## Open

| ID | Title | Owner | Status | Sev |
|----|-------|-------|--------|-----|

## Done (committed)

| ID | Title | Commit |
|----|-------|--------|

## Shipped earlier (pre-tracker)
Nothing yet — this section exists so \`scripts/board.mjs\` (the drift-guard) can
parse the board; note anything shipped before this board existed here.
`;

const BUGS_TEMPLATE = `# <ID> — <short title>

- **Status:** OPEN
- **Severity:** low | medium | high
- **Area:** (subsystem)
- **Reported:** <date> by <who>

## Symptom
What the user sees. Verbatim quote if there is one.

## Repro
Exact steps → wrong behavior.

## Expected
What should happen instead.

## Context pack (grows — the "where to look", so no agent cold-starts)
- Files/functions in play: …
- Related tickets: …
- Repro test: \`npm run verify:<x>\` (add one if none exists)
- Known dependencies / blockers: …

## Activity log (APPEND-ONLY — never edit or delete a prior entry)

### <date> — <agent/who>
- **Understood:** …
- **Changed:** files, and the commit sha once committed
- **Verified:** commands + PASS/FAIL lines + screenshot paths
- **Still open / handoff:** if not fully solved, the precise next step and WHY
  (so the next agent does not repeat this)
- **Symptom of a deeper design flaw?** (no / yes → ARCH-### filed) — required
  when you CLOSE the ticket; "yes" costs one ARCH ticket (\`TEMPLATE-ARCH.md\`),
  silence loses the only structural suspicion anyone had.
`;

// FEAT-056: the ARCH ticket template ships as the single source of truth in
// this repo's docs/bugs/ and is copied verbatim into onboarded projects. Read
// lazily + tolerantly: a missing source must not make `onboard` unusable.
function bugsTemplateArch() {
  try {
    return fs.readFileSync(path.join(repoRoot, 'docs', 'bugs', 'TEMPLATE-ARCH.md'), 'utf8');
  } catch {
    return null;
  }
}

/**
 * BUG-103 / FEAT-089 leak fix: the pointer this generator writes into EVERY
 * onboarded project (now automatic on every add) must not carry the operator's
 * absolute home path — that is the leak-gate class exactly (`/home/<user>`,
 * bare-word username), and any of those repos may be public.
 *
 * So express the WA location leak-safely while still RESOLVABLE for the operator
 * on their own machine:
 *   - normal case (Orchard checkout under $HOME): a `~`-relative path. `~` is a
 *     real, shell-resolvable reference for the operator, carries no home path or
 *     username, and a bare `claude` session can `cat` it directly. If the repo is
 *     later published, `~/projects/…` simply does not resolve for a third party —
 *     an inaccurate pointer, never an identity leak.
 *   - fallback (checkout NOT under $HOME — rare): a `$ORCHARD_HOME` env-var form,
 *     so we still never embed an absolute operator path.
 * Chosen over a project-root-relative path because the WA lives in the Orchard
 * checkout, not in the onboarded target — a relative path would climb out of the
 * target into an operator-specific absolute location anyway (`../../home/<user>/…`).
 */
function waPointerPath() {
  const waAbs = path.join(repoRoot, 'docs', 'prompts', 'WORKING_AGREEMENT.v3.md');
  const home = os.homedir();
  if (home && (waAbs === home || waAbs.startsWith(home + path.sep))) {
    return '~/' + path.relative(home, waAbs).split(path.sep).join('/');
  }
  return '$ORCHARD_HOME/docs/prompts/WORKING_AGREEMENT.v3.md';
}

function claudeMd() {
  // Leak-safe, operator-resolvable pointer (see waPointerPath): never the
  // absolute home path, which would leak the operator's identity into any
  // public onboarded repo.
  const waPath = waPointerPath();
  return `# CLAUDE.md

This project follows the shared Orchard Working Agreement — a bare \`claude\`
session in this repo should read it before doing anything else:

  ${waPath}

(That path is the Orchard/claude-station checkout on this machine — \`~\` is your
own home, or set \`$ORCHARD_HOME\` if the checkout lives elsewhere. See FEAT-039
in that repo's board for the plan to hoist the shared WA to a project-neutral
location; until then this pointer is coupled to that checkout existing locally.)

Project-specific rules that are NOT universal — i.e. do not belong in the
shared Working Agreement above — live in \`.orchard/CONVENTIONS.md\`. A launched
Orchard session auto-injects that doc alongside the WA; a bare \`claude\` session
should read it too.

Everything Orchard generates for this project lives under \`.orchard/\` (the way
\`.claude/\` does): the ticket board is \`.orchard/bugs/\` — see
\`.orchard/bugs/README.md\` before filing or working a ticket — alongside the
copied board/gate tools. \`npm run board:check\` catches drift between tickets
and the board index.

_Scaffolded by \`onboard.mjs\` (claude-station FEAT-038)._
`;
}

const DEPLOY_CONTEXT_STUB = `# Deploy context — what production/public ACTUALLY looks like

Read by the independent commit gatekeeper (claude-station
\`scripts/gatekeeper.mjs\`, FEAT-050): this whole file is injected into every
fresh-context reviewer so "works on the author's machine, breaks the real
server" mismatches are catchable. Keep it FACTUAL and current — a stale
deploy context produces confidently wrong reviews.

Fill in the sections below (delete the ones that do not apply):

## Where this deploys
<!-- host/provider, how deploys happen (CI? manual? auto-push?) -->

## Services & ports actually present in prod
<!-- e.g. "nginx on :443 → app on :8080; NO postgres — prod uses sqlite" -->

## Environment variables set in prod
<!-- names only, never values. Note vars that exist LOCALLY but NOT in prod. -->

## Paths & filesystem
<!-- e.g. "app root is /srv/app; /home/<user>/ paths do NOT exist in prod" -->

## What is NOT present in prod (local-only)
<!-- dev servers, local caches, test fixtures, tools assumed on PATH -->

_Stub scaffolded by \`onboard.mjs --deploy-context\` (claude-station FEAT-050)._
`;

// ---------------------------------------------------------------------------
// --wa-pointer: opt-in WA-pointer append for a PRE-EXISTING CLAUDE.md
// (FEAT-044 "Multi-consumer WA observations" gap: a repo with its own
// CLAUDE.md silently gets no pointer to the shared WA, since onboard's
// idempotency contract correctly refuses to touch a file that already
// exists. This is opt-in and additive only: it APPENDS a short, clearly-
// delimited section to the existing file, never rewrites it, and is itself
// idempotent — re-running with the flag never duplicates the section.)
// ---------------------------------------------------------------------------

const WA_POINTER_MARKER = '<!-- orchard:wa-pointer:start -->';
const WA_POINTER_MARKER_END = '<!-- orchard:wa-pointer:end -->';

function waPointerSection() {
  const waPath = waPointerPath();
  return `

${WA_POINTER_MARKER}
## Shared Orchard Working Agreement (appended by \`onboard.mjs --wa-pointer\`)

This project also has the shared Orchard Working Agreement available. A
session launched via the claude-station dashboard gets it injected
automatically; a bare \`claude\` session in this repo should read it directly
at:

  ${waPath}

(\`~\` is your own home, or set \`$ORCHARD_HOME\` if the Orchard checkout lives
elsewhere. Canonical source lives under \`~/projects/methodology\`; the path
above is a synced mirror inside claude-station's own checkout — see FEAT-039 in
that repo's board for the plan to hoist it to a project-neutral location.)
${WA_POINTER_MARKER_END}
`;
}

/**
 * Append the WA-pointer section to an ALREADY-EXISTING CLAUDE.md. Never
 * called for a fresh onboard-authored CLAUDE.md (that template already
 * contains the full pointer). Idempotent: a second call is a no-op once the
 * marker is present.
 */
function appendWaPointer(targetDir) {
  const file = path.join(targetDir, 'CLAUDE.md');
  const rel = path.relative(process.cwd(), file);
  const r = readTargetFile(file);
  if (!r.ok) return { path: rel, label: 'CLAUDE.md (--wa-pointer)', status: `SKIPPED (CLAUDE.md ${r.reason} — not modified)` };
  if (r.data.includes(WA_POINTER_MARKER)) {
    return { path: rel, label: 'CLAUDE.md (--wa-pointer)', status: 'exists (pointer already present)' };
  }
  fs.appendFileSync(file, waPointerSection());
  return { path: rel, label: 'CLAUDE.md (--wa-pointer)', status: 'appended' };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write `content` to `file` only if it does not already exist. Returns a report line. */
function ensureFile(file, content, label) {
  const rel = path.relative(process.cwd(), file);
  if (fs.existsSync(file)) {
    return { path: rel, label, status: 'exists' };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return { path: rel, label, status: 'created' };
}

/** Parse a TARGET-repo JSON file through the guarded reader (never blocks). */
function readJson(file) {
  const r = readTargetFile(file);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.data);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Onboard steps
// ---------------------------------------------------------------------------

/**
 * FEAT-106 — where this project's board lives, host-relative, as onboard should
 * declare it in `.orchard/config.json`. FRESH (no board anywhere) → `.orchard/bugs`.
 * A project that already has a LEGACY `docs/bugs` full of the target's own tickets
 * is declared IN PLACE (`docs/bugs`) and NEVER relocated — a live board is user
 * data, not something Orchard provably wrote, so moving it is out of the guarded
 * cleanup contract. An already-consolidated / declared board keeps its resolved
 * location. Returns a POSIX host-relative path.
 */
function boardRelFor(targetDir) {
  const layout = boardLayout(targetDir);
  if (layout === 'none') return `${ORCHARD}/bugs`;
  if (layout === 'legacy') return 'docs/bugs';
  const abs = resolveBoardDir(targetDir);
  return path.relative(path.resolve(targetDir), abs).split(path.sep).join('/');
}

/**
 * Scaffold the ticket board. A FRESH project gets `.orchard/bugs/{README,INDEX,
 * TEMPLATE,TEMPLATE-ARCH}` + `assets/`. A project that already carries a board
 * (legacy `docs/bugs` or a consolidated one) is left byte-untouched — its
 * tickets are user data. `ensureFile` is never-clobber besides.
 */
function scaffoldBoard(targetDir) {
  const layout = boardLayout(targetDir);
  const reports = [];
  if (layout !== 'none') {
    // Board already exists (legacy or consolidated) — do not re-scaffold or move.
    const rel = boardRelFor(targetDir);
    reports.push({ path: rel, label: `${rel}/*`, status: `exists (${layout} board left in place, declared in .orchard/config.json)` });
    return reports;
  }
  const bugsDir = path.join(targetDir, ORCHARD, 'bugs');
  const base = `${ORCHARD}/bugs`;
  reports.push(ensureFile(path.join(bugsDir, 'README.md'), BUGS_README, `${base}/README.md`));
  reports.push(ensureFile(path.join(bugsDir, 'INDEX.md'), BUGS_INDEX, `${base}/INDEX.md`));
  reports.push(ensureFile(path.join(bugsDir, 'TEMPLATE.md'), BUGS_TEMPLATE, `${base}/TEMPLATE.md`));
  const arch = bugsTemplateArch();
  if (arch) {
    reports.push(ensureFile(path.join(bugsDir, 'TEMPLATE-ARCH.md'), arch, `${base}/TEMPLATE-ARCH.md`));
  }
  fs.mkdirSync(path.join(bugsDir, 'assets'), { recursive: true });
  return reports;
}

const ORCHARD_GITIGNORE = `# Orchard-generated, not checked in.
bugs/.arch/
.legacy-backup-*/
`;

/**
 * The `.orchard/config.json` a target declares its layout in. `layoutVersion`
 * lets a later migration recognise the format; `board` is the host-relative
 * board path the resolver honours (its `declared` precedence). Never clobbers an
 * existing config (a user may have hand-declared a board path).
 */
function orchardConfigJson(boardRel) {
  const cfg = { layoutVersion: 1 };
  if (boardRel) cfg.board = boardRel;
  return JSON.stringify(cfg, null, 2) + '\n';
}

/**
 * The root-level scaffold: CLAUDE.md at the target root (the harness reads it
 * there) + everything else under `.orchard/` — config.json, nested .gitignore,
 * and CONVENTIONS.md. On UPGRADE a filled-in legacy `docs/CONVENTIONS.md` is
 * COPIED into `.orchard/CONVENTIONS.md` (content preserved) rather than
 * re-stubbed, so the user's local rules travel to the new location.
 */
function scaffoldRoot(targetDir, { noBoard = false } = {}) {
  const reports = [];
  const orchardDir = path.join(targetDir, ORCHARD);
  reports.push(ensureFile(path.join(targetDir, 'CLAUDE.md'), claudeMd(), 'CLAUDE.md'));
  reports.push(ensureFile(path.join(orchardDir, 'config.json'), orchardConfigJson(noBoard ? null : boardRelFor(targetDir)), `${ORCHARD}/config.json`));
  reports.push(ensureFile(path.join(orchardDir, '.gitignore'), ORCHARD_GITIGNORE, `${ORCHARD}/.gitignore`));

  // CONVENTIONS.md: prefer migrating a non-stub legacy doc into `.orchard/`.
  const orchardConv = path.join(orchardDir, 'CONVENTIONS.md');
  const legacyConv = path.join(targetDir, 'docs', 'CONVENTIONS.md');
  if (fs.existsSync(orchardConv)) {
    reports.push({ path: `${ORCHARD}/CONVENTIONS.md`, label: `${ORCHARD}/CONVENTIONS.md`, status: 'exists' });
  } else if (fs.existsSync(legacyConv)) {
    // Guarded read — a FIFO/dir/oversized file at docs/CONVENTIONS.md must not
    // block or be migrated (round-6/7 hang); fall back to the stub and note it.
    const r = readTargetFile(legacyConv);
    const legacyText = r.ok ? r.data : '';
    fs.mkdirSync(orchardDir, { recursive: true });
    fs.writeFileSync(orchardConv, legacyText || CONVENTIONS_STUB);
    const migratedUser = legacyText && legacyText !== CONVENTIONS_STUB;
    const status = !r.ok
      ? `created (from stub — legacy docs/CONVENTIONS.md not migrated: ${r.reason})`
      : migratedUser ? 'migrated from docs/CONVENTIONS.md (user content preserved)' : 'created (from legacy stub)';
    reports.push({ path: `${ORCHARD}/CONVENTIONS.md`, label: `${ORCHARD}/CONVENTIONS.md`, status });
  } else {
    reports.push(ensureFile(orchardConv, CONVENTIONS_STUB, `${ORCHARD}/CONVENTIONS.md`));
  }
  return reports;
}

// ---------------------------------------------------------------------------
// FEAT-106 stage 3 — the SINGLE SOURCE mapping every generated file this repo
// ships into a target to its `.orchard/`-relative destination. Everything the
// old scattered layout put across `scripts/`, `public/lib/` and `scripts/hooks/`
// now lands under `.orchard/`; the nine `public/lib/*.js` + the `scripts/lib/*`
// modules fold into ONE flat `.orchard/lib/`. Every relative import inside these
// files resolves byte-unchanged because the layout is preserved RELATIVE TO each
// file's new home (a tool at `.orchard/board.mjs` imports `./lib/x` =
// `.orchard/lib/x`, exactly as `scripts/board.mjs` imported `scripts/lib/x`); the
// Stop hook + gate were made candidate-loop / sibling-relative in stage 1 so
// `.orchard/hooks/…` and `.orchard/gate.mjs` resolve their deps in `.orchard/lib`
// and `.orchard/` respectively.
//
// `resync` marks a file that is re-copied over an existing divergent copy on
// EVERY run (the Stop hook — BUG-118; nothing but this project ships it, so a
// re-copy clobbers only our own stale copy). Everything else is never-clobber
// unless `--force-board-tool`, preserving any hand-edit under `.orchard/`.
// ---------------------------------------------------------------------------

// Tools that sit at the top of `.orchard/` (src: scripts/<name>).
const ORCHARD_TOOLS = ['board.mjs', 'arch-watch.mjs', 'gate.mjs', 'leak-gate.mjs', 'check-nul.mjs'];
// The response-format Stop hook (src: scripts/hooks/…, dest: .orchard/hooks/…).
const ORCHARD_HOOK = 'response-format-gate.mjs';
// The flattened method library. Each entry is a repo-relative source; the
// basename is its name inside the flat `.orchard/lib/`.
const ORCHARD_LIB_SOURCES = [
  'scripts/lib/verdict-contract.mjs', // board.mjs dep
  'scripts/lib/verification-source.mjs', // board.mjs dep (BUG-225 r3 typed verification source)
  'scripts/lib/answer-source.mjs', // board.mjs dep (FEAT-166 r3 typed answer stores)
  'public/lib/ticket-record.js', // verification-source.mjs dep (the one proof rule)
  'scripts/lib/ticket-schema.mjs', // board.mjs + arch-watch.mjs dep
  'scripts/lib/board-path.mjs', // board.mjs + hook dep (FEAT-106 resolver)
  'scripts/lib/readability.mjs', // hook dep
  'scripts/lib/structure.mjs', // hook dep
  'scripts/lib/format-metrics.mjs', // hook dep (dynamic import)
  'scripts/lib/leak-tokens.mjs', // leak-gate.mjs dep
  'public/lib/response-blocks.js', // hook dep (layer-2 block grammar)
  'public/lib/digest.js', // hook dep (digest grammar)
  'public/lib/dom.js', // digest.js closure
  'public/lib/route.js', // digest.js closure
];

/**
 * The full copy manifest for a target: `{ src (abs), dest (abs), label
 * (.orchard-relative), resync }`. The ONE list that both the writer
 * (installOrchardFiles) and the legacy-cleanup dry-run reason about, so a file
 * added here is copied AND its legacy twin is recognised for cleanup.
 */
export function orchardFileManifest(targetDir) {
  const orchardDir = path.join(targetDir, ORCHARD);
  const out = [];
  for (const t of ORCHARD_TOOLS) {
    out.push({ src: path.join(repoRoot, 'scripts', t), dest: path.join(orchardDir, t), label: `${ORCHARD}/${t}`, resync: false });
  }
  out.push({
    src: path.join(repoRoot, 'scripts', 'hooks', ORCHARD_HOOK),
    dest: path.join(orchardDir, 'hooks', ORCHARD_HOOK),
    label: `${ORCHARD}/hooks/${ORCHARD_HOOK}`,
    resync: true,
  });
  for (const rel of ORCHARD_LIB_SOURCES) {
    const name = path.basename(rel);
    out.push({ src: path.join(repoRoot, rel), dest: path.join(orchardDir, 'lib', name), label: `${ORCHARD}/lib/${name}`, resync: false });
  }
  return out;
}

// ---------------------------------------------------------------------------
// FEAT-121 — the SINGLE SOURCE of the `npm run <x>` commands onboarding wires
// into a target's package.json. installBoardTool() wires exactly these, and
// verifyEmittedNpmScripts() (the post-onboard smoke check) reads the SAME map
// plus the npm-run references parsed out of the emitted DOC templates below, so
// the checker can never fall behind by "whatever nobody typed" — the recurring
// hardcoded-list defect class this project keeps hitting. A doc referencing
// `npm run board:check` in a project with no matching script (or no
// package.json at all — the trading_volume half-onboarding trap) is now caught
// loudly at the end of every onboard, and by a standalone `--verify-only` run
// against an existing project.
// ---------------------------------------------------------------------------
const WIRED_NPM_SCRIPTS = {
  'board:check': 'node .orchard/board.mjs check',
  'board:gen': 'node .orchard/board.mjs gen',
  'arch:watch': 'node .orchard/arch-watch.mjs --persist',
  // FEAT-089: the sanctioned pre-commit gate (leak-gate + typecheck),
  // invoked as `npm run gate`. Never overwrites a target's own `gate`.
  gate: 'node .orchard/gate.mjs',
  // BUG-103: the NUL-in-source guard, also run inside `gate`. Wired standalone
  // too for discoverability. Never overwrites a target's own.
  'check:nul': 'node .orchard/check-nul.mjs',
};

// FEAT-106 stage 3 — the EXACT values onboard used to wire under the legacy
// scattered layout. A script whose value still matches its legacy entry here is
// provably onboard's own and is RE-POINTED to the `.orchard/` value on upgrade;
// any other value is a user customization and is kept + reported. This is the
// npm-script half of the "only re-point what Orchard provably wrote" rule.
const LEGACY_NPM_SCRIPTS = {
  'board:check': 'node scripts/board.mjs check',
  'board:gen': 'node scripts/board.mjs gen',
  'arch:watch': 'node scripts/arch-watch.mjs --persist',
  gate: 'node scripts/gate.mjs',
  'check:nul': 'node scripts/check-nul.mjs',
};

// ---------------------------------------------------------------------------
// FEAT-089 / FEAT-106 — the method's runtime pieces (the readability Stop hook,
// the sanctioned pre-commit gate + its closure) now travel INSIDE `.orchard/`
// via orchardFileManifest() above, so the never-clobber-a-target's-own-file
// worry is gone: `.orchard/` is Orchard's namespace, the way `.claude/` is, and
// nothing a target owns collides with it. The idempotency contract still holds
// (a hand-edited copy under `.orchard/` is reported diverged and left, resynced
// only with `--force-board-tool`; the Stop hook alone is always current).
// ---------------------------------------------------------------------------

/**
 * The Stop-hook command installed into the target's OWN `.claude/settings.json`.
 * Points at the consolidated `.orchard/hooks/…` location. Uses
 * `$CLAUDE_PROJECT_DIR` so it resolves against the target at run time.
 * ADVISORY-ONLY, matching this repo (FEAT-085): it never blocks a turn.
 */
const STOP_HOOK_COMMAND = `node "$CLAUDE_PROJECT_DIR/${ORCHARD}/hooks/${ORCHARD_HOOK}"`;
// The exact legacy command onboard used to install (scattered layout). A Stop
// hook whose command still matches this is provably onboard's own and is
// RE-POINTED to the `.orchard/` command on upgrade; any other command is left.
const LEGACY_STOP_HOOK_COMMAND = 'node "$CLAUDE_PROJECT_DIR/scripts/hooks/response-format-gate.mjs"';
const STOP_HOOK_ENTRY = {
  hooks: [
    {
      type: 'command',
      command: STOP_HOOK_COMMAND,
      timeout: 5,
      statusMessage: 'Checking response format (advisory)',
    },
  ],
};

/**
 * Copy one manifest entry into the target under `.orchard/`. Because `.orchard/`
 * is Orchard's namespace (like `.claude/`), no file a target owns collides here,
 * so the old never-clobber-a-user-file worry is gone — but a HAND-EDITED copy
 * under `.orchard/` is still respected: a diverged copy is reported and left,
 * re-synced only with `--force-board-tool`. The Stop hook (`resync: true`) is
 * the one exception, always kept current (BUG-118), because nothing but this
 * project ships it and staleness there silently kills the launched-session gate.
 */
function copyOrchardFile(entry, { forceBoardTool = false } = {}) {
  const { src, dest, label, resync } = entry;
  let srcBytes;
  try {
    srcBytes = fs.readFileSync(src);
  } catch {
    return { path: label, label, status: 'SKIPPED (source missing in this repo)' };
  }
  if (fs.existsSync(dest)) {
    // Guarded read of the target-side copy — a non-regular file where our copy
    // should be is left untouched (never read/overwrite a FIFO → no hang).
    const dr = readTargetFile(dest, { encoding: null });
    if (!dr.ok) return { path: path.relative(process.cwd(), dest), label, status: `exists (${dr.reason} — left untouched)` };
    const identical = dr.data.equals(srcBytes);
    if (identical) return { path: path.relative(process.cwd(), dest), label, status: 'exists (identical)' };
    if (resync) {
      fs.writeFileSync(dest, srcBytes);
      return { path: path.relative(process.cwd(), dest), label, status: 're-synced (stale hook replaced)' };
    }
    if (forceBoardTool) {
      fs.writeFileSync(dest, srcBytes);
      return { path: path.relative(process.cwd(), dest), label, status: 're-synced (--force-board-tool)' };
    }
    return { path: path.relative(process.cwd(), dest), label, status: 'exists (diverged — rerun with --force-board-tool to re-sync)' };
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, srcBytes);
  return { path: path.relative(process.cwd(), dest), label, status: 'created' };
}

/**
 * FEAT-106: copy the full `.orchard/` file manifest (board + gate tools, the
 * Stop hook, the flattened lib closure) into the target, then wire the target's
 * `.claude` Stop hook.
 */
function installOrchardFiles(targetDir, { forceBoardTool = false } = {}) {
  const reports = [];
  for (const entry of orchardFileManifest(targetDir)) reports.push(copyOrchardFile(entry, { forceBoardTool }));
  reports.push(installClaudeHook(targetDir));
  return reports;
}

/**
 * Install / MERGE / RE-POINT the Stop-hook config in the target's own
 * `.claude/settings.json`. Never clobbers an existing settings file:
 *   - no file                     → create it with the `.orchard/` Stop hook.
 *   - file already on `.orchard/`  → no-op, reported `exists`.
 *   - file on the LEGACY command   → re-point that command in place to `.orchard/`
 *                                    (FEAT-106 upgrade), leaving everything else.
 *   - file, no such hook           → MERGE our entry into hooks.Stop, preserving
 *                                    all other keys/hooks byte-for-value.
 *   - unparseable file             → SKIPPED (never overwrite what we can't merge).
 */
function installClaudeHook(targetDir) {
  const dir = path.join(targetDir, '.claude');
  const file = path.join(dir, 'settings.json');
  const label = '.claude/settings.json';
  const rel = path.relative(process.cwd(), file);

  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true });
    const settings = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      hooks: { Stop: [STOP_HOOK_ENTRY] },
    };
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
    return { path: rel, label, status: 'created (Stop hook)' };
  }

  // Guarded read — a non-regular `.claude/settings.json` must not block or be
  // overwritten (round-7 target-read class).
  const sr = readTargetFile(file);
  if (!sr.ok) return { path: rel, label, status: `SKIPPED (settings.json ${sr.reason} — not modified)` };
  const raw = sr.data;
  // Already on the `.orchard/` command → nothing to do. Match on the path
  // substring (never quote-escaped inside JSON), NOT the full command string
  // whose embedded quotes ARE escaped in the file — matching the full string
  // here silently re-merged a duplicate hook on every re-run.
  if (raw.includes(`${ORCHARD}/hooks/${ORCHARD_HOOK}`)) {
    return { path: rel, label, status: 'exists (hook already present)' };
  }
  let settings;
  try {
    settings = JSON.parse(raw);
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('not an object');
  } catch {
    return { path: rel, label, status: 'SKIPPED (existing settings not mergeable JSON — not overwritten)' };
  }
  // Upgrade path: an entry still on the exact LEGACY command is provably ours —
  // re-point it to `.orchard/` in place, disturbing nothing else.
  const stop = Array.isArray(settings?.hooks?.Stop) ? settings.hooks.Stop : null;
  let repointed = false;
  if (stop) {
    for (const group of stop) {
      const hooks = Array.isArray(group?.hooks) ? group.hooks : [];
      for (const h of hooks) {
        if (h && h.command === LEGACY_STOP_HOOK_COMMAND) {
          h.command = STOP_HOOK_COMMAND;
          repointed = true;
        }
      }
    }
  }
  if (repointed) {
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
    return { path: rel, label, status: 're-pointed (legacy Stop-hook command → .orchard/, existing config preserved)' };
  }
  // Merge: add our Stop entry, disturbing nothing else.
  settings.hooks = (settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)) ? settings.hooks : {};
  settings.hooks.Stop = Array.isArray(settings.hooks.Stop) ? settings.hooks.Stop : [];
  settings.hooks.Stop.push(STOP_HOOK_ENTRY);
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return { path: rel, label, status: 'merged (Stop hook added, existing config preserved)' };
}

/**
 * Wire (and, on upgrade, RE-POINT) the `npm run <x>` board/gate scripts in the
 * target's package.json. A key that is absent is ADDED with the `.orchard/`
 * value; a key whose value is EXACTLY the known legacy value is RE-POINTED to
 * the `.orchard/` value (provably onboard's own — the "only touch what Orchard
 * wrote" rule); any other value is a user customization and is left + reported.
 * No package.json → create a minimal one (FEAT-121 half-onboarding trap).
 */
function wireNpmScripts(targetDir) {
  const reports = [];
  const pkgPath = path.join(targetDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = readJson(pkgPath);
    if (pkg) {
      pkg.scripts ??= {};
      let changed = false;
      const added = [];
      const repointed = [];
      const already = [];
      const kept = [];
      for (const [key, value] of Object.entries(WIRED_NPM_SCRIPTS)) {
        const cur = pkg.scripts[key];
        if (cur === undefined) {
          pkg.scripts[key] = value;
          added.push(key);
          changed = true;
        } else if (cur === value) {
          already.push(key);
        } else if (cur === LEGACY_NPM_SCRIPTS[key]) {
          pkg.scripts[key] = value; // provably onboard's own legacy value → re-point
          repointed.push(key);
          changed = true;
        } else {
          kept.push(key); // user-customized → never overwrite
        }
      }
      if (changed) fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
      const parts = [];
      if (added.length) parts.push(`added [${added.join(', ')}]`);
      if (repointed.length) parts.push(`re-pointed to .orchard/ [${repointed.join(', ')}]`);
      if (already.length) parts.push(`already [${already.join(', ')}]`);
      if (kept.length) parts.push(`kept customized [${kept.join(', ')}]`);
      reports.push({ path: path.relative(process.cwd(), pkgPath), label: 'package.json scripts', status: parts.join(', ') || 'no change' });
    } else {
      reports.push({ path: pkgPath, label: 'package.json scripts', status: 'SKIPPED (package.json unparseable — not overwritten; smoke check will flag the dead npm-run refs)' });
    }
  } else {
    // FEAT-121: NO package.json → create a minimal one so the emitted docs'
    // `npm run board:*` commands resolve (the trading_volume half-onboarding).
    const pkg = {
      name: path.basename(path.resolve(targetDir)).toLowerCase().replace(/[^a-z0-9._-]+/g, '-') || 'onboarded-project',
      version: '0.0.0',
      private: true,
      scripts: { ...WIRED_NPM_SCRIPTS },
    };
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    reports.push({
      path: path.relative(process.cwd(), pkgPath),
      label: 'package.json',
      status: `created (minimal — wired [${Object.keys(WIRED_NPM_SCRIPTS).join(', ')}] so the emitted docs' npm-run commands resolve)`,
    });
  }
  return reports;
}

// ---------------------------------------------------------------------------
// FEAT-121 — post-onboard smoke check: every `npm run <x>` command onboarding
// EMITS into a project's docs must resolve to a real script in that project's
// package.json. Derives the command list from the actual doc templates onboard
// injects (not a hand-typed list), so it can never be short by "whatever nobody
// typed".
// ---------------------------------------------------------------------------

/**
 * Parse concrete `npm run <name>` references out of an emitted doc string.
 * Runs against the EVALUATED template constants (so escaped backticks are real
 * backticks and line-wrapped references — the docs wrap `npm run` onto the next
 * line before `board:gen` — are joined via the `\s+`). Skips obvious
 * placeholders like `npm run verify:<x>` (a "add one if none exists" stand-in,
 * not a command onboard promises exists).
 */
function extractNpmRunRefs(text) {
  const refs = new Set();
  const re = /npm run\s+`?([^\s`]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let tok = m[1].replace(/[`.,;:)]+$/, '');
    if (/[<>{}]/.test(tok) || tok.includes('…')) continue; // placeholder, not a real command
    if (!/^[a-zA-Z][\w:-]*$/.test(tok)) continue;
    refs.add(tok);
  }
  return refs;
}

/**
 * The doc templates onboard writes into a target, mapped to the repo-relative
 * path onboard writes each one to. This is the "single source both the injector
 * and the checker read" the FEAT asks for: the very strings onboard injects are
 * what the checker parses, so a new `npm run` reference added to any template is
 * automatically covered.
 */
function emittedDocTemplates() {
  return [
    { file: '.orchard/bugs/README.md', text: BUGS_README },
    { file: '.orchard/bugs/INDEX.md', text: BUGS_INDEX },
    { file: '.orchard/bugs/TEMPLATE.md', text: BUGS_TEMPLATE },
    { file: 'CLAUDE.md', text: claudeMd() },
    { file: '.orchard/CONVENTIONS.md', text: CONVENTIONS_STUB },
  ];
}

/**
 * Map every emitted `npm run <x>` reference -> the doc file(s) that reference
 * it, parsed from the templates above. This is the authoritative "what
 * onboarding emits" set, scoped strictly to onboard's own output (it never
 * flags a target's unrelated npm scripts).
 */
function emittedNpmScriptRefs() {
  const byScript = new Map();
  for (const { file, text } of emittedDocTemplates()) {
    for (const script of extractNpmRunRefs(text)) {
      if (!byScript.has(script)) byScript.set(script, new Set());
      byScript.get(script).add(file);
    }
  }
  return byScript;
}

/**
 * Assert that every `npm run <x>` command onboarding emits into `targetDir`'s
 * docs resolves to a real script in that project's package.json. Pure/read-only
 * — writes nothing — so it doubles as the standalone `--verify-only` a session
 * can run against an existing project. Returns { ok, failures:[{script,files}],
 * hasPkg, pkgParseable }.
 */
export function verifyEmittedNpmScripts(targetDir) {
  const resolved = path.resolve(targetDir);
  const pkgPath = path.join(resolved, 'package.json');
  const hasPkg = fs.existsSync(pkgPath);
  const pkg = hasPkg ? readJson(pkgPath) : null;
  const pkgParseable = !hasPkg ? true : pkg !== null;
  const scripts = pkg && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const failures = [];
  for (const [script, files] of emittedNpmScriptRefs()) {
    if (scripts[script] === undefined) {
      failures.push({ script, files: [...files] });
    }
  }
  return { ok: failures.length === 0, failures, hasPkg, pkgParseable, pkgPath: resolved };
}

/** Render the smoke check as onboard report lines (loud + specific on FAIL). */
function smokeCheckReports(targetDir) {
  const res = verifyEmittedNpmScripts(targetDir);
  if (res.ok) {
    return [{ path: '', label: 'npm-run smoke check', status: 'SMOKE PASS (every emitted `npm run <x>` resolves to a package.json script)' }];
  }
  const reports = [];
  const missingPkgNote = !res.hasPkg
    ? ' — target has NO package.json'
    : !res.pkgParseable
      ? ' — target package.json is unparseable'
      : '';
  reports.push({
    path: '',
    label: 'npm-run smoke check',
    status: `SMOKE FAIL: ${res.failures.length} emitted npm-run command(s) resolve to no package.json script${missingPkgNote}`,
  });
  for (const f of res.failures) {
    reports.push({
      path: '',
      label: '  dead npm-run ref',
      status: `SMOKE FAIL: \`npm run ${f.script}\` referenced by ${f.files.join(', ')} has no matching script in ${path.relative(process.cwd(), path.join(res.pkgPath, 'package.json'))}`,
    });
  }
  return reports;
}

// ---------------------------------------------------------------------------
// FEAT-106 stage 3 — GUARDED cleanup of the legacy scattered layout.
//
// High stakes: this deletes files in a TARGET repo. THE INVARIANT (hardened
// across three cross-provider verify rounds):
//
//   Cleanup only ever removes a REGULAR FILE that lies INSIDE the target repo
//   (realpath-checked; a symlink is never followed or traversed), whose captured
//   bytes equal the bytes hash-matched as Orchard-written — and, stated as byte
//   conservation: EVERY INODE OBSERVED AT A CLEANUP PATH AT ANY MOMENT DURING THE
//   RUN STILL EXISTS AFTERWARDS, either at the path or in the run's backup dir.
//   (Round 5 sharpened this from "path bytes" to "inode": an editor's atomic save
//   swaps the inode under the path, so the removal must move the exact inode it
//   captured, never re-resolve and unlink the path.)
//
// How each clause is enforced:
//   - "regular file, symlinks never followed/traversed, inside the repo":
//     `safeRemovable` walks the path component-by-component with lstat (like the
//     store-isolation guard), REFUSING the moment any component is a symlink or
//     a non-directory ancestor, requiring the leaf to be a regular file, and
//     realpath-confining the result under the resolved repo root. A `public`
//     that is a symlink (the round-1 escape: `public` → operator HOME) is thus
//     never traversed — the whole dir is KEPT and reported.
//   - "captured bytes == hash-matched, and no inode is ever destroyed": the
//     forward move is a SINGLE atomic `rename(original → uniqueBackupPath)` into a
//     FRESH per-run backup dir (`mkdtemp`, collision-proof). rename captures
//     exactly the inode at the path at that instant and cannot clobber a unique
//     destination; EXDEV (backup on another fs) refuses rather than copy+delete.
//     The captured inode is re-hashed against the Orchard source; if it is not
//     Orchard's, it is put BACK with a no-clobber `link()`+`unlink(backupName)`
//     — so a NEW user file that has taken the original path is never overwritten
//     (round-3 FINDING 2), and the unlink only ever drops the BACKUP name whose
//     inode we hold, never the original path (round-4 hole: an atomic save between
//     a forward link and unlink made unlink destroy the user's new inode).
//
//   - "captured leaf is a regular file": at the INSTANT before capture the leaf
//     is re-lstat'd and REFUSED IN PLACE if it is not a regular file, and the
//     CAPTURED inode is type-checked before any read — so a FIFO / directory /
//     symlink swapped in after the scan can never hang a blocking read or empty
//     the original path (round-5 FINDINGS 2 & 3).
//
// THREAT MODEL (explicit). This defends BENIGN CONCURRENCY: the user (or their
// tools) reading, creating, or editing their OWN files in the target while
// onboarding runs. It does NOT defend against an ADVERSARY who can write to the
// target repo DURING onboarding — such an actor can already do worse directly,
// so openat/O_NOFOLLOW dir-handle machinery is deliberately NOT built. The one
// adversarial race we narrow cheaply (round-3 FINDING 3): an ancestor dir swapped
// for an outside-pointing symlink AFTER `safeRemovable` but BEFORE the move. We
// re-validate the parent's realpath immediately before every move and ABORT the
// WHOLE cleanup (leaving everything else in place) on any mismatch. This shrinks
// the window to the interval between one realpath read and one link() call; the
// residual race is ACCEPTED as out of the threat model, stated here so a later
// reader does not mistake it for an oversight.
//
// Two more residual races are likewise ACCEPTED (attacker with write access to
// the target mid-onboarding): a process placing a user inode at our private,
// unpredictable mkdtemp backup dest in the check→rename gap (round-5 FINDING 1 —
// nothing benign knows that path), and a leaf swapped in the gap between the
// capture-time regular-file re-lstat and the rename. Neither is reachable by
// benign concurrency; closing them needs renameat2(NOREPLACE)/openat handles Node
// does not expose, which the threat model does not warrant.
//
// Dry-run by DEFAULT; `--migrate` applies. Idempotent: once cleaned, a re-run
// finds nothing. The board (`docs/bugs` — user tickets) is never in the delete
// set; the operator home is out of scope and is never enumerated.
// ---------------------------------------------------------------------------

// The exact target-relative paths onboard used to scatter under the legacy
// layout. Source for the byte-compare is the same repo-relative path.
const LEGACY_TOOL_FILES = [
  'scripts/board.mjs', 'scripts/arch-watch.mjs', 'scripts/gate.mjs', 'scripts/leak-gate.mjs', 'scripts/check-nul.mjs',
  'scripts/hooks/response-format-gate.mjs',
  'scripts/lib/verdict-contract.mjs', 'scripts/lib/ticket-schema.mjs', 'scripts/lib/board-path.mjs',
  'scripts/lib/readability.mjs', 'scripts/lib/structure.mjs', 'scripts/lib/format-metrics.mjs', 'scripts/lib/leak-tokens.mjs',
];
// The legacy public/lib files. The whole root public/ is only deletable if it
// contains nothing but these (current-source) files.
const LEGACY_PUBLIC_FILES = ['public/lib/response-blocks.js', 'public/lib/digest.js', 'public/lib/dom.js', 'public/lib/route.js'];

/**
 * Resolve `targetDir`'s realpath, or null if it cannot be resolved. Every
 * cleanup path is checked against THIS, and paths are walked FROM it, so a
 * symlinked target is resolved once up front and everything downstream stays
 * inside the real repo.
 */
export function resolveRootReal(targetDir) {
  try { return fs.realpathSync(targetDir); } catch { return null; }
}

/**
 * Return `{ ok:true, abs }` only if `relPath` under `rootReal` is SAFE to
 * remove: every path component exists and is NOT a symlink (never followed or
 * traversed), every ancestor is a real directory, the leaf is a REGULAR file,
 * and the realpath is confined to the repo. Otherwise `{ ok:false, reason }`.
 */
export function safeRemovable(rootReal, relPath) {
  const parts = relPath.split('/').filter(Boolean);
  if (parts.length === 0) return { ok: false, reason: 'empty path' };
  let cur = rootReal;
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]);
    let st;
    try { st = fs.lstatSync(cur); } catch { return { ok: false, reason: 'absent' }; }
    if (st.isSymbolicLink()) return { ok: false, reason: `symlink component '${parts.slice(0, i + 1).join('/')}' — not followed` };
    const last = i === parts.length - 1;
    if (last) {
      if (!st.isFile()) return { ok: false, reason: 'not a regular file' };
    } else if (!st.isDirectory()) {
      return { ok: false, reason: `non-directory ancestor '${parts[i]}'` };
    }
  }
  // Belt & braces: the component walk already refused every symlink, so realpath
  // must equal the lexical path under rootReal. Confirm it never escaped, and
  // capture the PARENT's realpath so the apply step can re-validate it at the
  // instant of the move (round-3 FINDING 3 window-narrowing).
  let real, parentReal;
  try {
    real = fs.realpathSync(cur);
    parentReal = fs.realpathSync(path.dirname(cur));
  } catch { return { ok: false, reason: 'realpath failed' }; }
  if (real !== cur && !real.startsWith(rootReal + path.sep)) return { ok: false, reason: 'realpath escapes the target repo' };
  if (parentReal !== rootReal && !parentReal.startsWith(rootReal + path.sep)) return { ok: false, reason: 'parent realpath escapes the target repo' };
  return { ok: true, abs: cur, parentReal };
}

/**
 * Enumerate a REAL directory without ever following a symlink. Returns regular
 * files (relative to `baseAbs`, posix) and a separate list of any symlink /
 * non-regular entries encountered (which alone disqualify a wholesale removal).
 */
function scanNoFollow(baseAbs, relBase = '', acc = { files: [], symlinks: [], unreadable: false }) {
  let entries;
  try { entries = fs.readdirSync(baseAbs, { withFileTypes: true }); } catch { acc.unreadable = true; return acc; }
  for (const e of entries) {
    const childRel = relBase ? `${relBase}/${e.name}` : e.name;
    const childAbs = path.join(baseAbs, e.name);
    if (e.isSymbolicLink()) { acc.symlinks.push(childRel); continue; } // NEVER follow
    if (e.isDirectory()) scanNoFollow(childAbs, childRel, acc);
    else if (e.isFile()) acc.files.push(childRel);
    else acc.symlinks.push(childRel); // socket/fifo/device — a non-regular entry, treat as disqualifying
  }
  return acc;
}

/**
 * Remove `abs` (a safe-checked regular file) ATOMICALLY by renaming it into the
 * backup dir, then verifying the moved bytes equal the Orchard source. rename is
 * atomic within one filesystem (the backup dir lives under the repo's own
 * `.orchard/`), so the file is never in a half-state and never lost. If a
 * concurrent writer changed it between the hash-match and the rename, the moved
 * bytes will NOT match — rename it straight back and report the race (KEPT). A
 * cross-filesystem or permission error means we cannot do this atomically, so we
 * refuse and leave the file untouched (never fall back to copy-then-delete,
 * which is the very TOCTOU this design removes).
 */
/**
 * Move `src` → `dst` WITHOUT ever overwriting an existing `dst`. `link()` FAILS
 * with EEXIST if `dst` exists (the atomic no-clobber guarantee) and with EXDEV
 * across filesystems; on success `src` and `dst` briefly share one inode, then
 * `src`'s name is unlinked, leaving the exact bytes at `dst`. A crash between the
 * two steps leaves BOTH names on one inode — no byte is ever lost. If the unlink
 * of `src` fails, the freshly-made `dst` link is removed again so no duplicate is
 * left and `src` stays intact. Throws on any failure; never overwrites.
 */
export function noClobberMove(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.linkSync(src, dst); // EEXIST if dst exists; EXDEV across filesystems
  try {
    fs.unlinkSync(src);
  } catch (e) {
    try { fs.unlinkSync(dst); } catch { /* leave dst; the bytes are still safe there */ }
    throw e;
  }
}

/**
 * `hooks` is a TEST-ONLY seam (undefined in production): `afterCapture` and
 * `beforePutBack` let a test inject a concurrent editor atomic-save at the exact
 * instants a real race could occur, so the byte-conservation invariant is proven
 * deterministically rather than by luck.
 */
export function atomicRemoveVerified(abs, relPath, srcAbs, backupDir, hooks = {}) {
  const dest = path.join(backupDir, relPath);
  // FORWARD (CAPTURE) — a SINGLE atomic `rename` moves whatever inode currently
  // sits at `abs` into a UNIQUE backup path, capturing exactly that inode. We
  // NEVER unlink `abs` by path (the round-4 hole: an editor's atomic save landing
  // between a link() and an unlink() made unlink destroy the user's NEW inode).
  // With a single rename there is no such window: an atomic save either PRECEDES
  // this rename (we capture the new inode, hash-fail, and put it back) or FOLLOWS
  // it (abs is already free; the save recreates abs; we never touch that path
  // again). `dest` is inside a fresh mkdtemp dir with a unique relpath, so it
  // never pre-exists; we still refuse if it somehow does, so no prior backup inode
  // is ever clobbered (round-3 FINDING 1).
  // RE-ASSERT the leaf is a REGULAR FILE at the instant of capture. safeRemovable
  // checked it at scan; a FIFO / directory / symlink swapped in since (a leaf
  // swap) must be REFUSED IN PLACE, never captured — else we would blocking-read
  // a FIFO (hang) or empty the original path for a directory whose put-back can't
  // link (round-5 FINDINGS 2 & 3). The residual microsecond between this lstat and
  // the rename is an ACCEPTED adversarial gap (an attacker with write access to
  // the target mid-onboarding — out of the threat model).
  let leafLst;
  try { leafLst = fs.lstatSync(abs); } catch { return { removed: false, reason: 'not removed (leaf vanished before capture; left in place)' }; }
  if (!leafLst.isFile()) {
    const kind = leafLst.isDirectory() ? 'directory' : leafLst.isSymbolicLink() ? 'symlink' : leafLst.isFIFO() ? 'FIFO' : 'special file';
    return { removed: false, reason: `not removed (leaf is a ${kind} at capture, not a regular file — refused IN PLACE, never captured)` };
  }
  // Backup-dest guard (round-3 FINDING 1). The dest lives in a fresh, unpredictable
  // per-run mkdtemp dir, so nothing BENIGN can occupy it; the residual check→rename
  // gap is only reachable by an attacker racing our private backup dir (out of
  // the threat model). Refuse rather than clobber if it somehow pre-exists.
  let destLst = null;
  try { destLst = fs.lstatSync(dest); } catch { destLst = null; }
  if (destLst) return { removed: false, reason: `not removed (backup dest already exists — refusing to overwrite: ${dest})` };
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(abs, dest); // EXDEV if the backup is on another fs → refuse below
  } catch (e) {
    return { removed: false, reason: `not removed (capture-move failed: ${e.code || e.message}; left in place — never a copy+delete)` };
  }
  if (hooks.afterCapture) hooks.afterCapture({ abs, dest });
  // Type-guard the CAPTURED inode before ANY read: never blocking-read a
  // non-regular inode (defence-in-depth for the residual pre-check→rename gap).
  let capturedRegular = false;
  try { capturedRegular = fs.lstatSync(dest).isFile(); } catch { capturedRegular = false; }
  // Authoritative check: the (regular) inode we captured carries the Orchard
  // bytes. Routed through the CAPPED reader (round-9): a legacy file grown past
  // the cap between classification and capture is bounded, not read unbounded —
  // and, being oversized, is correctly judged "not Orchard" and put back.
  if (capturedRegular && targetBytesEqual(dest, srcAbs)) return { removed: true };
  if (hooks.beforePutBack) hooks.beforePutBack({ abs, dest });
  // PUT-BACK — no-clobber (round-3 FINDING 2): link the captured inode back to the
  // original path; if a NEW file now occupies it, link fails EEXIST and we keep
  // the captured bytes in the backup rather than overwrite the new file. The
  // unlink here drops the BACKUP name (whose inode we captured), never the
  // original path, so no un-captured inode is ever removed.
  try {
    noClobberMove(dest, abs);
    return { removed: false, reason: 'KEPT (changed between hash-check and removal — restored, not deleted)' };
  } catch (e) {
    if (e.code === 'EEXIST') return { removed: false, reason: `KEPT-in-backup (original path re-occupied by a new file during cleanup — NOT overwritten; the removed bytes are preserved in the backup: ${dest})` };
    return { removed: false, reason: `KEPT-in-backup (put-back failed: ${e.code || e.message}; the removed bytes are safe at ${dest})` };
  }
}

/**
 * Compute (and, with `apply`, perform) the guarded cleanup. Returns report lines.
 * Writes nothing unless `apply` is true. See the invariant at the top of this
 * section. The board (`docs/bugs` — user tickets) is never in the delete set.
 */
function cleanupLegacy(targetDir, { apply = false } = {}) {
  const reports = [];
  const rootReal = resolveRootReal(targetDir);
  if (!rootReal) return [{ path: '', label: 'legacy cleanup', status: 'SKIPPED (target realpath unresolvable — refusing to enumerate)' }];
  const toDelete = []; // { rel, src, parentReal } — proven safe + Orchard-written at classification time
  let found = false;

  // 1. Scattered tool files.
  for (const rel of LEGACY_TOOL_FILES) {
    if (!fs.existsSync(path.join(rootReal, rel))) continue;
    found = true;
    const safe = safeRemovable(rootReal, rel);
    if (!safe.ok) { reports.push({ path: rel, label: `legacy ${rel}`, status: `KEPT (${safe.reason})` }); continue; }
    const src = path.join(repoRoot, rel);
    if (targetBytesEqual(safe.abs, src)) toDelete.push({ rel, src, parentReal: safe.parentReal });
    else reports.push({ path: rel, label: `legacy ${rel}`, status: 'KEPT (diverged from Orchard source — user-modified or stale; review manually)' });
  }

  // 2. Legacy stub docs — deletable only if still the exact unedited stub.
  const docChecks = [
    { rel: 'docs/CONVENTIONS.md', stub: CONVENTIONS_STUB },
    { rel: 'docs/DEPLOY-CONTEXT.md', stub: DEPLOY_CONTEXT_STUB },
  ];
  for (const { rel, stub } of docChecks) {
    if (!fs.existsSync(path.join(rootReal, rel))) continue;
    found = true;
    const safe = safeRemovable(rootReal, rel);
    if (!safe.ok) { reports.push({ path: rel, label: `legacy ${rel}`, status: `KEPT (${safe.reason})` }); continue; }
    const dr = readTargetFile(safe.abs); // guarded — a non-regular doc never blocks
    const text = dr.ok ? dr.data : null;
    // A stub doc is Orchard-written verbatim; an exact string match is the test.
    if (text === stub) toDelete.push({ rel, src: null, stub, parentReal: safe.parentReal });
    else reports.push({ path: rel, label: `legacy ${rel}`, status: 'KEPT (edited — user content; migrated into .orchard/ where applicable, legacy copy left for you to remove)' });
  }

  // 3. The root public/ — wholesale, only if nothing but current Orchard files
  //    AND no symlink anywhere in it. A symlinked `public` (the round-1 escape)
  //    is never traversed.
  const publicAbs = path.join(rootReal, 'public');
  let publicLst = null;
  try { publicLst = fs.lstatSync(publicAbs); } catch { publicLst = null; }
  const publicToDelete = [];
  if (publicLst) {
    found = true;
    if (publicLst.isSymbolicLink()) {
      reports.push({ path: 'public', label: 'legacy public/', status: 'KEPT (public/ is a SYMLINK — never followed or removed; may point outside the repo)' });
    } else if (!publicLst.isDirectory()) {
      reports.push({ path: 'public', label: 'legacy public/', status: 'KEPT (public/ is not a directory)' });
    } else {
      const scan = scanNoFollow(publicAbs);
      const known = new Map(LEGACY_PUBLIC_FILES.map((rel) => [rel, path.join(repoRoot, rel)]));
      if (scan.unreadable) {
        reports.push({ path: 'public', label: 'legacy public/', status: 'KEPT (public/ unreadable)' });
      } else if (scan.symlinks.length) {
        reports.push({ path: 'public', label: 'legacy public/', status: `KEPT WHOLE dir — contains ${scan.symlinks.length} symlink/non-regular entry(ies) (never traversed): [${scan.symlinks.slice(0, 8).join(', ')}${scan.symlinks.length > 8 ? ', …' : ''}]` });
      } else if (scan.files.length === 0) {
        reports.push({ path: 'public', label: 'legacy public/', status: 'KEPT (empty — not created by this onboard; left as-is)' });
      } else {
        const unexpected = [];
        for (const r of scan.files) {
          const rel = `public/${r}`;
          const src = known.get(rel);
          const safe = safeRemovable(rootReal, rel);
          if (!safe.ok || !src || !targetBytesEqual(safe.abs, src)) unexpected.push(rel);
          else publicToDelete.push({ rel, src, parentReal: safe.parentReal });
        }
        if (unexpected.length) {
          reports.push({ path: 'public', label: 'legacy public/', status: `KEPT WHOLE dir — contains ${unexpected.length} non-Orchard/diverged entry(ies): [${unexpected.slice(0, 8).join(', ')}${unexpected.length > 8 ? ', …' : ''}]` });
        } else {
          for (const d of publicToDelete) toDelete.push(d);
          reports.push({ path: 'public', label: 'legacy public/', status: apply ? `whole dir removed (${publicToDelete.length} Orchard file(s), backed up)` : `would remove WHOLE dir (${publicToDelete.length} Orchard file(s) — nothing else present)` });
        }
      }
    }
  }

  if (!found) {
    reports.push({ path: '', label: 'legacy cleanup', status: 'no legacy layout found (nothing to clean up)' });
    return reports;
  }

  if (!apply) {
    for (const { rel } of toDelete) {
      reports.push({ path: rel, label: `legacy ${rel}`, status: 'would remove (matches Orchard source — run --migrate to apply)' });
    }
    if (toDelete.length) reports.push({ path: '', label: 'legacy cleanup', status: `DRY-RUN — ${toDelete.length} file(s) would be removed; re-run with --migrate to apply (atomic backup-move first)` });
    return reports;
  }

  // Apply: create a FRESH, collision-proof backup dir for THIS run (`mkdtemp`
  // guarantees uniqueness even within the same millisecond — round-3 FINDING 1).
  // Only now, since dry-run writes nothing.
  let backupDir;
  try {
    fs.mkdirSync(path.join(rootReal, ORCHARD), { recursive: true });
    backupDir = fs.mkdtempSync(path.join(rootReal, ORCHARD, '.legacy-backup-'));
  } catch (e) {
    reports.push({ path: '', label: 'legacy cleanup', status: `SKIPPED (could not create a backup dir: ${e.code || e.message}; nothing removed)` });
    return reports;
  }

  // For each file, RE-CHECK safety AND re-validate the parent realpath at the
  // instant before the move; on any ancestor swap, ABORT the whole cleanup.
  let removedCount = 0;
  for (const item of toDelete) {
    const { rel, src, stub, parentReal } = item;
    const safe = safeRemovable(rootReal, rel);
    if (!safe.ok) {
      // 'absent' = the user removed it themselves since the scan — benign, skip.
      if (safe.reason === 'absent') { reports.push({ path: rel, label: `legacy ${rel}`, status: 'SKIPPED (removed by someone else since scan)' }); continue; }
      // Anything else (a symlink/non-regular where a regular file stood at scan)
      // is an ancestor/leaf swap under us — round-3 FINDING 3 signal. HALT.
      reports.push({ path: rel, label: `legacy ${rel}`, status: `ABORTED — became unsafe since scan (${safe.reason}); whole cleanup halted, everything else left in place.` });
      break;
    }
    // round-3 FINDING 3 (adversarial window-narrowing): if the parent's realpath
    // changed since the scan (an ancestor swapped for a symlink pointing
    // elsewhere), STOP everything rather than move through the new path.
    if (safe.parentReal !== parentReal) {
      reports.push({ path: rel, label: `legacy ${rel}`, status: `ABORTED — parent path changed since scan ('${parentReal}' → '${safe.parentReal}'); possible ancestor symlink swap. Whole cleanup halted; everything else left in place.` });
      break;
    }
    // For a stub doc there is no source file to hash against; materialise the
    // exact stub bytes into a throwaway so removal verifies against them too.
    let srcAbs = src;
    let tmpStub = null;
    if (srcAbs === null && typeof stub === 'string') {
      tmpStub = path.join(backupDir, `.stub-ref-${path.basename(rel)}`);
      try { fs.writeFileSync(tmpStub, stub); } catch { tmpStub = null; }
      srcAbs = tmpStub;
    }
    if (!srcAbs) { reports.push({ path: rel, label: `legacy ${rel}`, status: 'SKIPPED (could not materialise reference bytes)' }); continue; }
    const res = atomicRemoveVerified(safe.abs, rel, srcAbs, backupDir);
    if (tmpStub) { try { fs.rmSync(tmpStub); } catch { /* ignore */ } }
    if (res.removed) { removedCount++; reports.push({ path: rel, label: `legacy ${rel}`, status: 'removed (no-clobber move into .orchard/.legacy-backup-*)' }); }
    else reports.push({ path: rel, label: `legacy ${rel}`, status: res.reason });
  }
  // Prune now-empty legacy container dirs. rmdir refuses a non-empty dir and a
  // symlink (ENOTDIR), so this can never follow a link or delete user content.
  for (const rel of ['scripts/hooks', 'scripts/lib', 'public/lib', 'public']) {
    try { fs.rmdirSync(path.join(rootReal, rel)); } catch { /* non-empty, symlink, or absent — leave */ }
  }
  if (removedCount) reports.push({ path: path.relative(process.cwd(), backupDir), label: 'legacy backup', status: `${removedCount} file(s) moved here (no-clobber) before removal` });
  else { try { fs.rmdirSync(backupDir); } catch { /* not empty — a stub-ref or KEPT-in-backup file remains; leave it */ } }
  return reports;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  let targetDir = null;
  let noBoard = false;
  let forceBoardTool = false;
  let forceHook = false;
  let waPointer = false;
  let deployContext = false;
  let verifyOnly = false;
  let migrate = false;
  for (const a of argv) {
    if (a === '--no-board') noBoard = true;
    else if (a === '--force-board-tool') forceBoardTool = true;
    else if (a === '--force-hook') forceHook = true;
    else if (a === '--wa-pointer') waPointer = true;
    else if (a === '--deploy-context') deployContext = true;
    else if (a === '--verify-only') verifyOnly = true;
    else if (a === '--migrate') migrate = true;
    else if (a.startsWith('--dir=')) targetDir = a.slice('--dir='.length);
    else if (!a.startsWith('--')) targetDir = a;
  }
  return { targetDir, noBoard, forceBoardTool, forceHook, waPointer, deployContext, verifyOnly, migrate };
}

/** FEAT-106 opt-in: `.orchard/DEPLOY-CONTEXT.md`, migrating a filled-in legacy copy. */
function scaffoldDeployContext(targetDir) {
  const orchardDc = path.join(targetDir, ORCHARD, 'DEPLOY-CONTEXT.md');
  const legacyDc = path.join(targetDir, 'docs', 'DEPLOY-CONTEXT.md');
  const label = `${ORCHARD}/DEPLOY-CONTEXT.md`;
  if (fs.existsSync(orchardDc)) return { path: label, label, status: 'exists' };
  if (fs.existsSync(legacyDc)) {
    const r = readTargetFile(legacyDc); // guarded — never block on a FIFO/dir
    const text = r.ok ? r.data : '';
    fs.mkdirSync(path.dirname(orchardDc), { recursive: true });
    fs.writeFileSync(orchardDc, text || DEPLOY_CONTEXT_STUB);
    const migratedUser = text && text !== DEPLOY_CONTEXT_STUB;
    const status = !r.ok
      ? `created (from stub — legacy docs/DEPLOY-CONTEXT.md not migrated: ${r.reason})`
      : migratedUser ? 'migrated from docs/DEPLOY-CONTEXT.md (user content preserved)' : 'created (from legacy stub)';
    return { path: label, label, status };
  }
  return ensureFile(orchardDc, DEPLOY_CONTEXT_STUB, label);
}

export function onboard(targetDir, { noBoard = false, forceBoardTool = false, forceHook = false, waPointer = false, deployContext = false, migrate = false } = {}) {
  if (!targetDir) throw new Error('onboard: target dir is required');
  void forceHook; // accepted as a no-op alias (the Stop hook is always resynced)
  const resolved = path.resolve(targetDir);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`onboard: not a directory: ${resolved}`);
  }

  const reports = [];
  if (!noBoard) {
    reports.push(...scaffoldBoard(resolved));
  } else {
    reports.push({ path: `${ORCHARD}/bugs`, label: `${ORCHARD}/bugs/*`, status: 'SKIPPED (--no-board)' });
  }
  // Root CLAUDE.md + everything else under .orchard/ (config.json, .gitignore,
  // CONVENTIONS.md).
  const rootReports = scaffoldRoot(resolved, { noBoard });
  reports.push(...rootReports);
  if (waPointer) {
    const claudeMdReport = rootReports.find((r) => r.label === 'CLAUDE.md');
    if (claudeMdReport && claudeMdReport.status === 'exists') {
      // Only a PRE-EXISTING CLAUDE.md needs the append — a fresh
      // onboard-authored one (status 'created') already has the full pointer.
      reports.push(appendWaPointer(resolved));
    }
  }
  if (deployContext) {
    reports.push(scaffoldDeployContext(resolved));
  }
  // FEAT-106: the board/gate tools + Stop hook + flattened lib, all under .orchard/.
  reports.push(...installOrchardFiles(resolved, { forceBoardTool }));
  // package.json script values, re-pointed to .orchard/ (guarded).
  reports.push(...wireNpmScripts(resolved));
  // Guarded cleanup of the legacy scattered layout (dry-run unless --migrate).
  reports.push(...cleanupLegacy(resolved, { apply: migrate }));
  // FEAT-121: prove the instructions we just wrote actually work — every
  // `npm run <x>` the emitted docs reference must resolve to a real script.
  // A fresh onboard that left dead commands now fails LOUDLY here.
  reports.push(...smokeCheckReports(resolved));
  return reports;
}

function reportTag(status) {
  if (status.startsWith('SMOKE FAIL')) return 'FAIL   ';
  if (status.startsWith('SMOKE PASS')) return 'SMOKE  ';
  if (status.startsWith('created') || status.startsWith('added') || status.startsWith('appended') || status.startsWith('migrated')) return 'CREATED';
  if (status.startsWith('merged')) return 'MERGED ';
  if (status.startsWith('re-pointed')) return 'REPOINT';
  if (status.startsWith('removed') || status.startsWith('whole dir removed')) return 'REMOVED';
  if (status.startsWith('would remove') || status.startsWith('DRY-RUN')) return 'WOULD  ';
  if (status.startsWith('KEPT')) return 'KEPT   ';
  if (status.startsWith('SKIPPED')) return 'SKIPPED';
  if (status.startsWith('re-synced')) return 'RESYNC ';
  return 'EXISTS ';
}

function main() {
  const { targetDir, noBoard, forceBoardTool, forceHook, waPointer, deployContext, verifyOnly, migrate } = parseArgs(process.argv.slice(2));
  if (!targetDir) {
    console.error('usage: node scripts/onboard.mjs <target-dir> [--no-board] [--force-board-tool] [--force-hook] [--wa-pointer] [--deploy-context] [--migrate] [--verify-only]');
    process.exit(2);
  }

  // FEAT-121: standalone verify mode — writes NOTHING, just asserts every
  // `npm run <x>` command onboarding's docs reference resolves in the target's
  // package.json. A session can run this against an already-onboarded project
  // (the trading_volume half-onboarding class) to catch dead documented
  // commands. Exit 0 = all resolve, 1 = at least one dead reference.
  if (verifyOnly) {
    const resolved = path.resolve(targetDir);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      console.error(`onboard --verify-only: not a directory: ${resolved}`);
      process.exit(2);
    }
    console.log(`onboard --verify-only — ${resolved}`);
    const smoke = smokeCheckReports(resolved);
    let failed = false;
    for (const r of smoke) {
      if (r.status.startsWith('SMOKE FAIL')) failed = true;
      console.log(`  ${reportTag(r.status)}  ${r.label.padEnd(24)} ${r.status}`);
    }
    process.exit(failed ? 1 : 0);
  }

  let reports;
  try {
    reports = onboard(targetDir, { noBoard, forceBoardTool, forceHook, waPointer, deployContext, migrate });
  } catch (e) {
    console.error(`onboard: ${e.message}`);
    process.exit(1);
  }
  console.log(`onboard — ${path.resolve(targetDir)}`);
  let smokeFailed = false;
  for (const r of reports) {
    if (r.status.startsWith('SMOKE FAIL')) smokeFailed = true;
    console.log(`  ${reportTag(r.status)}  ${r.label.padEnd(24)} ${r.status}`);
  }
  if (smokeFailed) {
    console.error('\nonboard: FAILED post-onboard smoke check — the docs it wrote reference `npm run` commands that do not resolve. See SMOKE FAIL lines above. (exit 1)');
    process.exit(1);
  }
  process.exit(0);
}

const isMain = process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) main();
