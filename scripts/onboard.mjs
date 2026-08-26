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

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

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
  const waAbs = path.join(repoRoot, 'docs', 'prompts', 'WORKING_AGREEMENT.v2.md');
  const home = os.homedir();
  if (home && (waAbs === home || waAbs.startsWith(home + path.sep))) {
    return '~/' + path.relative(home, waAbs).split(path.sep).join('/');
  }
  return '$ORCHARD_HOME/docs/prompts/WORKING_AGREEMENT.v2.md';
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
shared Working Agreement above — live in \`docs/CONVENTIONS.md\` next to this
file. A launched Orchard session auto-injects that doc alongside the WA; a
bare \`claude\` session should read it too.

This board (\`docs/bugs/\`) is an accumulating-context ticket tracker — see
\`docs/bugs/README.md\` before filing or working a ticket. \`npm run
board:check\` catches drift between tickets and the board index.

_Scaffolded by \`onboard.mjs\` (claude-station FEAT-038)._
`;
}

const CONVENTIONS_STUB = `# Project Conventions (local)

Project-specific rules for THIS project only. Anything universal — not
specific to this project — belongs in the shared Working Agreement instead
(see that doc's §L, and \`scripts/check-scope.mjs\` in claude-station, which
flags misfiled universal-sounding lines here and project-specific ones in the
shared doc).

This file is auto-injected alongside the shared Working Agreement for
sessions launched on this project (see \`localConventionsSection()\` in
claude-station's \`src/server/templates.ts\`). Empty/whitespace-only = treated
as absent, injects nothing.

<!-- Add this project's local rules below. Examples: repo-specific ports to
     never touch, a stack-specific test command, a directory layout quirk. -->
`;

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
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes(WA_POINTER_MARKER)) {
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

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Onboard steps
// ---------------------------------------------------------------------------

function scaffoldBoard(targetDir) {
  const bugsDir = path.join(targetDir, 'docs', 'bugs');
  const reports = [];
  reports.push(ensureFile(path.join(bugsDir, 'README.md'), BUGS_README, 'docs/bugs/README.md'));
  reports.push(ensureFile(path.join(bugsDir, 'INDEX.md'), BUGS_INDEX, 'docs/bugs/INDEX.md'));
  reports.push(ensureFile(path.join(bugsDir, 'TEMPLATE.md'), BUGS_TEMPLATE, 'docs/bugs/TEMPLATE.md'));
  const arch = bugsTemplateArch();
  if (arch) {
    reports.push(ensureFile(path.join(bugsDir, 'TEMPLATE-ARCH.md'), arch, 'docs/bugs/TEMPLATE-ARCH.md'));
  }
  fs.mkdirSync(path.join(bugsDir, 'assets'), { recursive: true });
  return reports;
}

function scaffoldWaPointer(targetDir) {
  const reports = [];
  reports.push(ensureFile(path.join(targetDir, 'CLAUDE.md'), claudeMd(), 'CLAUDE.md'));
  reports.push(
    ensureFile(path.join(targetDir, 'docs', 'CONVENTIONS.md'), CONVENTIONS_STUB, 'docs/CONVENTIONS.md')
  );
  return reports;
}

/**
 * The copied, per-repo tools. Both are single-file, zero-dependency (node
 * builtins only) and `--dir`-aware, which is exactly what makes the copy-not-
 * dependency decision above work. FEAT-056 added arch-watch.mjs — the
 * recurrence detector that raises architecture questions from the project's OWN
 * board — on the same terms: copied here, re-synced by `--force-board-tool`
 * (and fleet-wide by scripts/fleet-sync.mjs), never a shared import.
 */
// board.mjs is no longer zero-dep: it imports ./lib/verdict-contract.mjs, so the
// copy must carry that too or the copied drift-guard fails to load (the guard's
// whole point is to WORK in the target — step 1 of the method genuinely running).
//
// lib/ticket-schema.mjs joins on the same terms: BOTH board.mjs and
// arch-watch.mjs import it (it is the one definition of the ticket format and
// of "done"), so an onboarded repo that lacks it cannot load either tool. It is
// deliberately import-free — not even node builtins — so copying it out cannot
// drag anything else along.
//
// lib/board-path.mjs joins on the same terms (FEAT-106): it is the ONE place
// that resolves where an onboarded project keeps its Orchard-generated files
// (legacy scattered layout vs. the consolidated `.orchard/` one). It is plain
// ESM, node builtins only, so it copies out cleanly and imports without a build.
const COPIED_TOOLS = ['board.mjs', 'arch-watch.mjs', 'lib/verdict-contract.mjs', 'lib/ticket-schema.mjs', 'lib/board-path.mjs'];

// ---------------------------------------------------------------------------
// FEAT-089 — the method's runtime pieces that today live only in THIS repo:
// the readability/response-format Stop hook and the sanctioned pre-commit gate.
// Both are general Claude-Code / node capabilities (nothing Orchard-specific in
// them) — they simply were never installed anywhere else. onboard now carries
// them too, under the SAME never-clobber, idempotent, report-what-it-did
// contract as everything above.
// ---------------------------------------------------------------------------

/**
 * Files copied VERBATIM (byte-for-byte) into the target so the format hook and
 * the gate actually run there. Each keeps its repo-relative path, because the
 * hook resolves its own dependencies with relative imports
 * (`../lib/readability.mjs`, `../../public/lib/digest.js`) — copying the whole
 * closure at the same relative layout is what makes those resolve in the
 * target. Same copy-not-shared-dependency rationale as COPIED_TOOLS above:
 * self-contained, keeps working if this repo later moves/renames.
 *
 * NEVER clobbers: a file that already exists at the destination is left exactly
 * as-is and reported `exists` (so a target that happens to ship its own
 * `public/lib/dom.js` is never overwritten — at worst the hook's import of a
 * mismatched local copy fails, and the hook is written to FAIL OPEN, so it goes
 * inert rather than wedging a turn).
 */
const METHOD_FILES = [
  // The Stop hook + its dependency closure (readability grader, digest grammar).
  'scripts/hooks/response-format-gate.mjs',
  'scripts/lib/readability.mjs',
  'scripts/lib/structure.mjs',
  // FEAT-091: layer-2 block grammar + the durable metrics sink the hook writes.
  // The hook imports both dynamically and fails soft without them, but a target
  // missing them silently records nothing — which is the whole point of the
  // feature — so they travel with the hook. The grammar lives in public/lib/ (the
  // renderer lane moved it there so the hook and the browser UI share ONE parser,
  // mirroring public/lib/digest.js); the hook imports it as ../../public/lib.
  'public/lib/response-blocks.js',
  'scripts/lib/format-metrics.mjs',
  'public/lib/digest.js',
  'public/lib/dom.js',
  'public/lib/route.js',
  // The sanctioned pre-commit gate wrapper + its one dependency (the leak-gate).
  'scripts/gate.mjs',
  'scripts/leak-gate.mjs',
  // BUG-103: the NUL-in-source guard `gate.mjs` invokes. Must travel with the
  // gate, or the copied gate fails to spawn it and the onboarded repo carries
  // the exact invisible-false-negative hazard this guard exists to prevent.
  'scripts/check-nul.mjs',
];

/**
 * The Stop-hook entry installed into the target's OWN `.claude/settings.json`.
 * Defined inline (not read from this repo's `.claude/settings.json`, which is
 * gitignored here and may be absent) so the installed config is deterministic.
 * Uses `$CLAUDE_PROJECT_DIR` so it resolves against the target at run time.
 * ADVISORY-ONLY, matching this repo (FEAT-085): it never blocks a turn.
 */
const STOP_HOOK_COMMAND = 'node "$CLAUDE_PROJECT_DIR/scripts/hooks/response-format-gate.mjs"';
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
 * BUG-118 — the ONE method file that is ALWAYS re-synced over an existing copy.
 *
 * Why a single-file exception rather than a `--force-method` covering all of
 * METHOD_FILES: most of that list has names a target repo can plausibly own
 * itself (`public/lib/dom.js`, `scripts/gate.mjs`), and overwriting those would
 * destroy the target's own code. Nothing but this project ships
 * `scripts/hooks/response-format-gate.mjs`, so re-copying it clobbers only our
 * own earlier copy — there is no user content to lose.
 *
 * ROUND 4 — WHY IT IS NO LONGER BEHIND A FLAG. Round 3 added `--force-hook` and
 * left ordinary onboarding on the never-clobber path, which reported a stale
 * copy as `exists (diverged — left untouched)` and moved on. That is delivery
 * that never arrives: a project onboarded before a hook fix keeps the OLD hook
 * until somebody runs a flag nobody knows to run. It bit exactly that way — a
 * project still holding the round-1 hook (which accepts only `1|true|yes` as
 * the marker) went silent for every genuine launched session once the launcher
 * started sending a session id, and ordinary onboarding left it that way.
 *
 * The never-clobber rule is right for files a user may own. This is not one of
 * them, so it does not get that protection. Re-syncing is reported (`re-synced
 * (stale hook replaced)`), and the target's own git history holds whatever was
 * there before, so an overwrite is visible and recoverable rather than silent.
 * `--force-hook` remains accepted as a no-op alias (fleet-sync passes it).
 */
const RESYNCABLE_HOOK = 'scripts/hooks/response-format-gate.mjs';

/** Copy one repo-relative file into the target. Never overwrites an existing
 *  file EXCEPT RESYNCABLE_HOOK, which is ours alone and is always kept current. */
function copyMethodFile(targetDir, rel, { forceHook = false } = {}) {
  const src = path.join(repoRoot, rel);
  const dest = path.join(targetDir, rel);
  const label = rel;
  let srcBytes;
  try {
    srcBytes = fs.readFileSync(src);
  } catch {
    return { path: rel, label, status: 'SKIPPED (source missing in this repo)' };
  }
  if (fs.existsSync(dest)) {
    // Never clobber. Note when the existing copy differs from source so a
    // collision (e.g. the target ships its own public/lib/dom.js) is visible.
    let identical = false;
    try {
      identical = fs.readFileSync(dest).equals(srcBytes);
    } catch {
      /* unreadable dest — treat as diverged */
    }
    if (!identical && rel === RESYNCABLE_HOOK) {
      // Always, flag or no flag — see RESYNCABLE_HOOK. `forceHook` is kept in the
      // signature only so existing callers (fleet-sync) stay valid; it changes
      // nothing.
      void forceHook;
      fs.writeFileSync(dest, srcBytes);
      return { path: path.relative(process.cwd(), dest), label, status: 're-synced (stale hook replaced)' };
    }
    return {
      path: path.relative(process.cwd(), dest),
      label,
      status: identical ? 'exists (identical)' : 'exists (diverged — left untouched)',
    };
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, srcBytes);
  return { path: path.relative(process.cwd(), dest), label, status: 'created' };
}

/**
 * Install / MERGE the Stop-hook config into the target's own
 * `.claude/settings.json`. Never clobbers an existing settings file:
 *   - no file            → create it with the Stop hook.
 *   - file, no such hook → MERGE our entry into hooks.Stop, preserving all
 *                          other keys and hooks byte-for-value.
 *   - file, hook present → no-op, reported `exists`.
 *   - unparseable file   → SKIPPED (never overwrite a file we can't safely merge).
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

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { path: rel, label, status: 'SKIPPED (existing settings unreadable — not overwritten)' };
  }
  // Fast idempotence check on the raw text — our hook already wired?
  if (raw.includes('response-format-gate.mjs')) {
    return { path: rel, label, status: 'exists (hook already present)' };
  }
  let settings;
  try {
    settings = JSON.parse(raw);
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('not an object');
  } catch {
    return { path: rel, label, status: 'SKIPPED (existing settings not mergeable JSON — not overwritten)' };
  }
  // Merge: add our Stop entry, disturbing nothing else.
  settings.hooks = (settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)) ? settings.hooks : {};
  settings.hooks.Stop = Array.isArray(settings.hooks.Stop) ? settings.hooks.Stop : [];
  settings.hooks.Stop.push(STOP_HOOK_ENTRY);
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return { path: rel, label, status: 'merged (Stop hook added, existing config preserved)' };
}

/** FEAT-089: copy the format hook + gate closure, then wire the target's .claude hook. */
function installMethod(targetDir, { forceHook = false } = {}) {
  const reports = [];
  for (const rel of METHOD_FILES) reports.push(copyMethodFile(targetDir, rel, { forceHook }));
  reports.push(installClaudeHook(targetDir));
  return reports;
}

function installBoardTool(targetDir, { forceBoardTool }) {
  const reports = [];
  for (const tool of COPIED_TOOLS) {
    const label = `scripts/${tool}`;
    const src = path.join(repoRoot, 'scripts', tool);
    const dest = path.join(targetDir, 'scripts', tool);
    const srcContent = fs.readFileSync(src, 'utf8');

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (!fs.existsSync(dest)) {
      fs.writeFileSync(dest, srcContent);
      reports.push({ path: path.relative(process.cwd(), dest), label, status: 'created' });
    } else if (forceBoardTool) {
      const identical = fs.readFileSync(dest, 'utf8') === srcContent;
      if (identical) {
        reports.push({ path: path.relative(process.cwd(), dest), label, status: 'exists (identical)' });
      } else {
        fs.writeFileSync(dest, srcContent);
        reports.push({ path: path.relative(process.cwd(), dest), label, status: 're-synced (--force-board-tool)' });
      }
    } else {
      const identical = fs.readFileSync(dest, 'utf8') === srcContent;
      reports.push({
        path: path.relative(process.cwd(), dest),
        label,
        status: identical ? 'exists (identical)' : 'exists (diverged — rerun with --force-board-tool to re-sync)',
      });
    }
  }

  // Wire npm scripts, if the target has a package.json. Never overwrite an
  // existing board:check/board:gen script (someone may have customized it) —
  // only add the two keys if absent.
  const pkgPath = path.join(targetDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = readJson(pkgPath);
    if (pkg) {
      pkg.scripts ??= {};
      let changed = false;
      const wanted = {
        'board:check': 'node scripts/board.mjs check',
        'board:gen': 'node scripts/board.mjs gen',
        'arch:watch': 'node scripts/arch-watch.mjs --persist',
        // FEAT-089: the sanctioned pre-commit gate (leak-gate + typecheck),
        // invoked as `npm run gate`. Never overwrites a target's own `gate`.
        gate: 'node scripts/gate.mjs',
        // BUG-103: the NUL-in-source guard, also run inside `gate`. Wired
        // standalone too for discoverability. Never overwrites a target's own.
        'check:nul': 'node scripts/check-nul.mjs',
      };
      const added = [];
      const already = [];
      for (const [key, value] of Object.entries(wanted)) {
        if (pkg.scripts[key] === undefined) {
          pkg.scripts[key] = value;
          added.push(key);
          changed = true;
        } else {
          already.push(key);
        }
      }
      if (changed) {
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
      }
      reports.push({
        path: path.relative(process.cwd(), pkgPath),
        label: 'package.json scripts',
        status:
          added.length && already.length
            ? `added [${added.join(', ')}], already had [${already.join(', ')}]`
            : added.length
              ? `added [${added.join(', ')}]`
              : `already had [${already.join(', ')}]`,
      });
    } else {
      reports.push({ path: pkgPath, label: 'package.json scripts', status: 'SKIPPED (package.json unparseable)' });
    }
  } else {
    reports.push({
      path: path.relative(process.cwd(), pkgPath),
      label: 'package.json scripts',
      status: 'SKIPPED (no package.json — run `node scripts/board.mjs check` directly)',
    });
  }

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
  for (const a of argv) {
    if (a === '--no-board') noBoard = true;
    else if (a === '--force-board-tool') forceBoardTool = true;
    else if (a === '--force-hook') forceHook = true;
    else if (a === '--wa-pointer') waPointer = true;
    else if (a === '--deploy-context') deployContext = true;
    else if (a.startsWith('--dir=')) targetDir = a.slice('--dir='.length);
    else if (!a.startsWith('--')) targetDir = a;
  }
  return { targetDir, noBoard, forceBoardTool, forceHook, waPointer, deployContext };
}

export function onboard(targetDir, { noBoard = false, forceBoardTool = false, forceHook = false, waPointer = false, deployContext = false } = {}) {
  if (!targetDir) throw new Error('onboard: target dir is required');
  const resolved = path.resolve(targetDir);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`onboard: not a directory: ${resolved}`);
  }

  const reports = [];
  if (!noBoard) {
    reports.push(...scaffoldBoard(resolved));
  } else {
    reports.push({ path: path.join(path.relative(process.cwd(), resolved), 'docs/bugs'), label: 'docs/bugs/*', status: 'SKIPPED (--no-board)' });
  }
  const waReports = scaffoldWaPointer(resolved);
  reports.push(...waReports);
  if (waPointer) {
    const claudeMdReport = waReports.find((r) => r.label === 'CLAUDE.md');
    if (claudeMdReport && claudeMdReport.status === 'exists') {
      // Only a PRE-EXISTING CLAUDE.md needs the append — a fresh
      // onboard-authored one (status 'created') already has the full pointer.
      reports.push(appendWaPointer(resolved));
    }
  }
  if (deployContext) {
    // FEAT-050 opt-in: DEPLOY-CONTEXT.md stub for the commit gatekeeper.
    reports.push(
      ensureFile(path.join(resolved, 'docs', 'DEPLOY-CONTEXT.md'), DEPLOY_CONTEXT_STUB, 'docs/DEPLOY-CONTEXT.md')
    );
  }
  reports.push(...installBoardTool(resolved, { forceBoardTool }));
  // FEAT-089: the format/readability Stop hook + the sanctioned gate wrapper.
  reports.push(...installMethod(resolved, { forceHook }));
  return reports;
}

function main() {
  const { targetDir, noBoard, forceBoardTool, forceHook, waPointer, deployContext } = parseArgs(process.argv.slice(2));
  if (!targetDir) {
    console.error('usage: node scripts/onboard.mjs <target-dir> [--no-board] [--force-board-tool] [--force-hook] [--wa-pointer] [--deploy-context]');
    process.exit(2);
  }
  let reports;
  try {
    reports = onboard(targetDir, { noBoard, forceBoardTool, forceHook, waPointer, deployContext });
  } catch (e) {
    console.error(`onboard: ${e.message}`);
    process.exit(1);
  }
  console.log(`onboard — ${path.resolve(targetDir)}`);
  for (const r of reports) {
    const tag = r.status.startsWith('created') || r.status.startsWith('added') || r.status.startsWith('appended')
      ? 'CREATED'
      : r.status.startsWith('merged')
        ? 'MERGED '
        : r.status.startsWith('SKIPPED')
          ? 'SKIPPED'
          : r.status.startsWith('re-synced')
            ? 'RESYNC '
            : 'EXISTS ';
    console.log(`  ${tag}  ${r.label.padEnd(24)} ${r.status}`);
  }
  process.exit(0);
}

const isMain = process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) main();
