#!/usr/bin/env node
/**
 * independent-verify.mjs — FEAT-061: CLEAN-ROOM independent verification.
 *
 * The problem, stated plainly: the agent that writes a fix also writes the
 * fixture, runs it, and reports PASS — and the orchestrator commits on that
 * report. A blind spot that SHAPED the fixture (one page of test data, so the
 * cursor bug never fires) survives every check we have, including the
 * non-vacuity rule, because non-vacuity only proves the fixture discriminates
 * the thing the fixer already thought of.
 *
 * The countermeasure has to be STRUCTURAL, not a prompt convention:
 *
 *  1. NOT a Task subagent. An orchestrator's in-process subagents inherit this
 *     session's instructions, board snapshot and framing — contaminated by
 *     construction. Verification goes out through scripts/dispatch.mjs: a
 *     separate process, a fresh CLI, its own context.
 *  2. A CLEAN ROOM, not just a fresh prompt. `claude`/`codex` auto-discover
 *     ambient instructions from the working directory (CLAUDE.md, AGENTS.md,
 *     .claude/) and would happily read docs/prompts/ and docs/bugs/ — so
 *     dispatching "in the repo" re-imports the very framing we are trying to
 *     decorrelate from. This script exports the tree at the reviewed revision
 *     into a temp dir and REMOVES that surface before the verifier starts
 *     (--print-cleanroom-report shows exactly what was stripped).
 *  3. Its whole input is: the requirement in plain terms, the diff, how to run
 *     things, and the fixer's TEST CODE. Never the fixer's report, rationale or
 *     self-assessment — the prose is what transmits the blind spot. (The test
 *     CODE is included on purpose: the verifier must re-run it.)
 *  4. Adversarial objective. "Attempt to BREAK this claim", never "check this
 *     work" — "double-check" invites agreement.
 *  5. EXECUTED-EVIDENCE contract (scripts/lib/verdict-contract.mjs): no fixer
 *     test run + no uncovered adversarial case + no "what I could not test"
 *     ⇒ the verdict is INVALID, rejected mechanically rather than politely.
 *     Since the 2026-08-11 pivot the harness EMITS the evidence sections
 *     itself from its own run records — the verifier only cites run ids and
 *     writes the speech slots, so there is no pasted output left to validate.
 *  6. Cross-provider by default (decorrelated blind spots; ROUTING.md).
 *
 * Usage:
 *   node scripts/independent-verify.mjs --requirement @docs/req.txt \
 *     [--repo <dir>] [--range <A..B|rev> | --working-tree] [--run "<command>"]... \
 *     [--test-file <path>]... [--allow-input <repo-rel-path>]... \
 *     [--author-provider anthropic|openai] \
 *     [--provider anthropic|openai] [--model <m>] [--timeout-min <n>]
 *     [--keep-cleanroom] [--print-prompt] [--verdict-out <file>]
 *   node scripts/independent-verify.mjs --check-only <verdict-file>
 *
 * A verify lane verifying a TICKET uses `--ticket <T>` (below) — the default for every
 * verify lane; never hand-build a candidate. With NO mode flag the room is the last
 * commit, HEAD^..HEAD: only COMMITTED work is visible (range → rev-parse → git archive).
 * `--candidate <TICKET|hash>` (FEAT-170) verifies a FROZEN candidate: the ticket's files
 * exactly as frozen at fix-handoff, overlaid on the freeze-time HEAD and nothing else
 * (scripts/lib/candidate-store.mjs). Edits made to the live tree after the freeze —
 * another lane's, a whole-file restore (BUG-224) — cannot reach the room or the diff,
 * and the verdict's record command carries the candidate hash it is bound to.
 *
 * `--ticket <T> [--files a,b] [--mixed]` is the DEFAULT way to verify one ticket on a
 * shared tree. It uses T's clean candidate (exactly as --candidate) when every frozen
 * file is still CURRENT. Otherwise — no candidate, a CHANGED file, or files that also
 * carry other open tickets' uncommitted hunks (the BUG-255 shape: freeze refused
 * `owned`, dependency cycles) — it freezes a MIXED-STATE candidate
 * (candidate-store freezeMixed): T's files as they sit in the tree, the whole tree as
 * the room, NO ownership taken, the foreign hunks DISCLOSED to the verifier by owning
 * ticket where known, the verdict bound to the content hash. The record shows the mode
 * (board-tool reads it from the candidate: verify_mode clean-candidate|mixed-state).
 * The verifier's inputs are unchanged otherwise: never the fixer's report.
 *
 * `--working-tree` (FEAT-134, mutually exclusive with --range) snapshots the
 * CURRENT dirty tree — tracked edits + untracked-not-ignored files — into a
 * dangling commit via a throwaway index and verifies that; the real repo state is
 * never written. The durable id is the snapshot TREE sha.
 *
 * Exit codes: 0 = verdict HOLDS, 1 = verdict BROKEN, 3 = verdict INVALID
 * (contract violated — e.g. a static-only review), 2 = usage/infra error.
 * A dispatch that fails counts as INVALID, never as a pass.
 *
 * Scope: this script only OBTAINS and VALIDATES a verdict. It never commits,
 * never pushes, never edits the reviewed repo.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CITATION_CONTRACT, validateVerdict, formatVerifiedBy, parseManifest,
  parseCitationReply, composeVerdict,
} from './lib/verdict-contract.mjs';
// Clean rooms are both EXPENSIVE (a 374 MB reflink copy) and LONG-LIVED (a kept
// room and its record dir are the artifacts a verdict cites, read after the
// run), and `/tmp` on this machine is wiped on every boot. See scratch.mjs.
import { mkdtempScratch, scratchRootInfo, checkSameFilesystem, SCRATCH_ENV } from './lib/scratch.mjs';
// FEAT-134: verify the CURRENT dirty tree, not only committed objects. The
// snapshot is a dangling commit built via a throwaway index — real repo untouched.
import { snapshotWorkingTree } from './lib/tree-snapshot.mjs';
// FEAT-170: verify an immutable, content-hashed candidate instead of the shared tree.
import { materializeCandidate, CandidateError, freezeMixed, cleanCandidateUsable } from './lib/candidate-store.mjs';
import { warnIfLaneWorkLost } from './lib/lane-snapshot.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DISPATCH = path.join(ROOT, 'scripts', 'dispatch.mjs');
// Run the CLI only when invoked directly; importing the module (e.g. the NUL-safety
// verify script pulling in argvSafePrompt) must NOT arg-parse, validate or dispatch.
const IS_ENTRY = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

/* ----------------------------------------------- BUG-250: crash-safe cleanup
 * The clean room and record dir live under the PERSISTENT scratch root (not
 * /tmp — they are evidence a verdict cites days later). The only cleanup used
 * to be an `rmSync` on the two NORMAL exit paths, so a crash, a `die()`, an
 * uncaught exception, or a SIGINT/SIGTERM between room creation and those lines
 * leaked the room forever (865 leaked dirs measured). Fix: every scratch dir is
 * REGISTERED at its `mkdtemp` call site and removed by a single `exit` handler
 * plus signal handlers, so an abnormal exit no longer leaks. A `--keep-cleanroom`
 * room is deliberately NEVER registered — a crashed kept run must still keep its
 * evidence. SIGKILL / power-loss cannot be handled and is NOT covered here: a
 * room leaked that way is reclaimed by the OPERATOR via the read-only report tool
 * (scripts/scratch-report.mjs), which emits `rm` commands for review — there is
 * no autonomous sweep (BUG-250 round 2 retired it; it broke four times). This
 * handler deletes ONLY the exact dirs THIS process created — never a foreign dir.
 */
const _scratchToClean = new Set();
let _cleanupDone = false;
let _activeDispatchChild = null;
function trackScratch(dir) { if (dir) _scratchToClean.add(dir); }
function untrackScratch(dir) { if (dir) _scratchToClean.delete(dir); }
function cleanupScratch() {
  if (_cleanupDone) return; _cleanupDone = true;
  for (const d of _scratchToClean) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  _scratchToClean.clear();
}
if (IS_ENTRY) {
  process.on('exit', cleanupScratch);
  const SIGNUM = { SIGINT: 2, SIGQUIT: 3, SIGHUP: 1, SIGTERM: 15 };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
    process.on(sig, () => {
      // Stop the verifier child FIRST (it runs with --cwd room.dir): deleting the
      // room out from under a live child lets its writes recreate fragments.
      try { if (_activeDispatchChild && _activeDispatchChild.pid) _activeDispatchChild.kill('SIGKILL'); } catch { /* already gone */ }
      cleanupScratch();
      process.exit(128 + (SIGNUM[sig] ?? 0));
    });
  }
}

const USAGE = `usage: node scripts/independent-verify.mjs --requirement <text|@file>
         [--repo <dir>] [--ticket <TICKET> [--files a,b,…] [--mixed]   (default for a ticket)
                         | --candidate <TICKET|hash> | --range <A..B|rev> | --working-tree]
         [--run "<command>"]... [--test-file <path>]... [--allow-input <repo-rel-path>]...
         [--author-provider anthropic|openai]
         [--provider anthropic|openai] [--model <m>] [--timeout-min <n>]
         [--max-diff-bytes <n>] [--keep-cleanroom] [--print-prompt]
         [--verdict-out <file>]
       node scripts/independent-verify.mjs --check-only <verdict-file> [--manifest <jsonl>]`;

function die(msg, code = 2) {
  process.stderr.write(`independent-verify: ${msg}\n`);
  process.exit(code);
}

/*
 * A raw NUL byte cannot travel in argv: Node's spawn rejects any argv string
 * containing \0 with ERR_INVALID_ARG_VALUE, so a clean-room run over a base whose
 * diff carries a NUL (historically public/app.js's draftKey delimiter — see
 * BUG-104/BUG-106) died before the verifier ever started and had to be stripped by
 * hand. A NUL in a diff is meaningless to a human verifier anyway, so render it as
 * a VISIBLE sentinel: the prompt stays transmissible by EITHER the argv OR the
 * stdin path, no layer chokes on the byte, and the verifier can still SEE that a
 * NUL was present in the payload. Applied at the single spawn choke point.
 */
export const NUL_SENTINEL = '␀'; // U+2400 SYMBOL FOR NULL
export function argvSafePrompt(s) {
  return typeof s === 'string' && s.includes('\0') ? s.replace(/\0/g, NUL_SENTINEL) : s;
}

/* ------------------------------------------------------------------- args */

const argv = process.argv.slice(2);
const opts = {
  repo: process.cwd(),
  range: null,
  workingTree: false,
  candidate: null,
  ticket: null,
  mixed: false,
  files: [],
  requirement: null,
  runs: [],
  testFiles: [],
  authorProvider: 'anthropic',
  provider: null,
  model: null,
  timeoutMin: 15,
  maxDiffBytes: 60_000,
  keepCleanroom: false,
  printPrompt: false,
  verdictOut: null,
  checkOnly: null,
  manifest: null,
  allowInputs: [],
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const take = () => {
    if (i + 1 >= argv.length) die(`${a} needs a value\n${USAGE}`);
    return argv[++i];
  };
  if (a === '--repo') opts.repo = path.resolve(take());
  else if (a === '--range') opts.range = take();
  else if (a === '--working-tree') opts.workingTree = true;
  else if (a === '--candidate') opts.candidate = take();
  else if (a === '--ticket') opts.ticket = take();
  else if (a === '--mixed') opts.mixed = true;
  else if (a === '--files') opts.files.push(...take().split(',').map((x) => x.trim()).filter(Boolean));
  else if (a === '--file') opts.files.push(take());
  else if (a === '--requirement') opts.requirement = take();
  else if (a === '--run') opts.runs.push(take());
  else if (a === '--test-file') opts.testFiles.push(take());
  else if (a === '--allow-input') opts.allowInputs.push(take());
  else if (a === '--author-provider') opts.authorProvider = take();
  else if (a === '--provider') opts.provider = take();
  else if (a === '--model') opts.model = take();
  else if (a === '--timeout-min') opts.timeoutMin = Number(take());
  else if (a === '--max-diff-bytes') opts.maxDiffBytes = Number(take());
  else if (a === '--keep-cleanroom') opts.keepCleanroom = true;
  else if (a === '--print-prompt') opts.printPrompt = true;
  else if (a === '--verdict-out') opts.verdictOut = path.resolve(take());
  else if (a === '--check-only') opts.checkOnly = path.resolve(take());
  else if (a === '--manifest') opts.manifest = path.resolve(take());
  else if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
  else die(`unknown argument ${a}\n${USAGE}`);
}

/* ------------------------------------------- CAUSE 1: --run command forms */

/**
 * Command-form issues in the `--run` fixer-test commands. BUG-273 r3 RESCOPE
 * (technical adjudicator, after the r2 shell-text advisories misfired): the ONLY
 * structural guard here is `runs.length > 1` (severity `error`, exit 2) — the
 * verdict contract allows EXACTLY ONE `FIXER-TEST:` citation, so N fixer-test
 * commands yield N lines and a contract-INVALID verdict (BUG-196 r7). That is an
 * ARRAY-LENGTH test, not shell text — robust by construction.
 *
 * The r2 shell-TEXT advisories (double `--`, env prefix) and their quote-aware
 * tokeniser are DELETED: the citation-identity authority is already
 * `canonCmd`/`sameCmd` in lib/verdict-contract.mjs (BUG-066) — it byte-matches
 * the recorded run against the harness-supplied fixer test and canonicalises
 * env/`NAME=value` prefixes — so those advisories merely restated, less reliably,
 * what that single authority decides (ARCH-010 two-authorities anti-pattern). A
 * real shell tokeniser would be needed to stop them false-firing (a `--flag="a --
 * b"` attached-quote form was mis-counted as a double `--`), and a cry-wolf
 * advisory trains operators to ignore the neighbourhood.
 *
 * The ONE non-fatal advisory kept is the `npm run confined` wrap: genuine
 * operator guidance (the room already seeds its own scratch .git, so the wrap is
 * usually unnecessary), matched by a plain substring regex with no tokenisation,
 * and NOT rejected — a suite that must `git init` its OWN fixtures still needs
 * confined (the FEAT-135 PATH write-shim fails CLOSED in the room).
 *
 * Returns an array of { severity, bad, why, fix }: `error` dies before dispatch,
 * `warning` is printed and the run proceeds. Empty = nothing to say.
 */
export function validateRunForms(runs) {
  const problems = [];
  if (runs.length > 1) {
    problems.push({
      severity: 'error',
      bad: runs.map((r) => `--run ${JSON.stringify(r)}`).join(' '),
      why: `${runs.length} --run commands were supplied, so the verifier is handed ${runs.length} fixer-test commands to run and cite — but the verdict contract allows EXACTLY ONE \`FIXER-TEST:\` citation, so more than one makes the verdict contract-INVALID (BUG-196 round 7).`,
      fix: 'Pass ONE canonical fixer test: --run "node <suite>". Describe any other suites as adversarial/supporting inside --requirement — the verifier builds and cites its own adversarial runs.',
    });
  }
  for (const r of runs) {
    const s = String(r);
    const isConfined = /\b(?:npm\s+run\s+confined|confined-run(?:\.mjs)?)\b/.test(s);
    if (isConfined) {
      problems.push({
        severity: 'warning',
        bad: `--run ${JSON.stringify(s)}`,
        why: 'this wraps the suite in `npm run confined` / confined-run. The clean room is already an isolated throwaway that seeds its own scratch .git, so a confined wrap is usually unnecessary AND its `--` passthrough can make the recorded command differ from the harness-supplied fixer test (canonCmd reconciles the common case, but not every one). KEEP it only if the suite must `git init` its OWN fixtures — in-room git-WRITE is still blocked by the PATH shim, so confined remains the sanctioned escape hatch for that.',
        fix: 'If the suite needs no git-write fixtures, run it DIRECTLY: --run "node <suite>".',
      });
    }
  }
  return problems;
}

/* --------------------------------------------------- --check-only (no LLM) */

function reportValidation(v) {
  if (!v.valid) {
    console.log('VERDICT-CONTRACT: INVALID — this answer does not count as a pass OR a fail.');
    for (const viol of v.violations) console.log(`  VIOLATION: ${viol}`);
    console.log('\nAn answer whose evidence the harness cannot corroborate is a STATIC review —');
    console.log('exactly what shares the fixer\'s blind spot — so it is rejected mechanically, not weighed.');
    return 3;
  }
  console.log(`VERDICT-CONTRACT: VALID (verdict ${v.verdict}; adversarial case(s): ${v.adversarial.join(', ')}${v.manifestChecked ? '; manifest-backed' : '; PROSE-ONLY — no run manifest was checked'})`);
  for (const f of v.findings) console.log(`  ${f}`);
  return v.verdict === 'BROKEN' ? 1 : 0;
}

/**
 * OUTPUT-BINDING (the 5288429d fix): vrun.mjs preserves each run's FULL raw
 * output as `<id>.out` beside the manifest. Attach it to the entry whenever the
 * artifact exists, so validateVerdict can bind the verdict's pasted OUTPUT
 * block to the recorded output of the run it cites — pasted prose then carries
 * zero evidentiary weight; the artifact is the evidence. Entries whose artifact
 * is missing stay metadata-only (checkable id/exit/cmd/hash, unbound output).
 */
function attachRecordedOutputs(entries, dir) {
  for (const e of entries) {
    const f = path.join(dir, `${e.id}.out`);
    try { if (fs.existsSync(f)) e.output = fs.readFileSync(f, 'utf8'); } catch { /* stays metadata-only */ }
  }
  return entries;
}

if (IS_ENTRY) {
  if (opts.checkOnly) {
    if (!fs.existsSync(opts.checkOnly)) die(`--check-only file not found: ${opts.checkOnly}`);
    let manifest;
    if (opts.manifest) {
      if (!fs.existsSync(opts.manifest)) die(`--manifest file not found: ${opts.manifest}`);
      manifest = attachRecordedOutputs(parseManifest(fs.readFileSync(opts.manifest, 'utf8')), path.dirname(opts.manifest));
    }
    process.exit(reportValidation(validateVerdict(fs.readFileSync(opts.checkOnly, 'utf8'), { manifest })));
  }

  if (!opts.requirement) die(`--requirement is required\n${USAGE}`);
  if (opts.workingTree && opts.range) die('--working-tree and --range are mutually exclusive: one verifies the dirty tree, the other a committed range');
  if (opts.candidate && (opts.workingTree || opts.range)) die('--candidate is mutually exclusive with --range and --working-tree: it verifies one frozen candidate, nothing else');
  if (opts.ticket && (opts.candidate || opts.workingTree || opts.range)) die('--ticket is mutually exclusive with --candidate, --range and --working-tree: it picks the clean candidate or the mixed-state freeze itself');
  if ((opts.mixed || opts.files.length) && !opts.ticket) die('--mixed and --files go with --ticket <TICKET>');
  if (opts.authorProvider !== 'anthropic' && opts.authorProvider !== 'openai') die('--author-provider must be anthropic|openai');
  if (opts.provider && opts.provider !== 'anthropic' && opts.provider !== 'openai') die('--provider must be anthropic|openai');
  // Cross-provider by default: decorrelated blind spots (ROUTING.md).
  if (!opts.provider) opts.provider = opts.authorProvider === 'anthropic' ? 'openai' : 'anthropic';
  if (!Number.isFinite(opts.timeoutMin) || opts.timeoutMin <= 0) die('--timeout-min must be positive');
  // CAUSE 1 (BUG-273 r2 RESCOPE): the ONLY hard pre-dispatch reject is >1 --run
  // (an array-length test, robust by construction); the shell-text checks are
  // advisory warnings — canonCmd/sameCmd (verdict-contract.mjs) is the single
  // citation-identity authority, and `npm run confined` is still needed by
  // git-write-fixture suites, so neither is rejected here.
  const runProblems = validateRunForms(opts.runs);
  const runWarnings = runProblems.filter((p) => p.severity === 'warning');
  const runErrors = runProblems.filter((p) => p.severity === 'error');
  for (const w of runWarnings) {
    process.stderr.write(`--run advisory (NOT rejected): ${w.bad}\n    note: ${w.why}\n    suggestion: ${w.fix}\n`);
  }
  if (runErrors.length) {
    const lines = runErrors.map((p) => `  REJECTED ${p.bad}\n      why: ${p.why}\n      fix: ${p.fix}`);
    die(`--run command-form error(s) — rejected before dispatch so no verification round is wasted:\n${lines.join('\n')}`);
  }
}

/* -------------------------------------------------------------- git utils */

function git(repo, ...args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
function gitOk(repo, ...args) {
  const r = git(repo, ...args);
  if (r.code !== 0) die(`git ${args.join(' ')} failed in ${repo}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

/* ------------------------------------------------------------- clean room */

/**
 * THE CONTAMINATION SURFACE — inverted from a deny-list to an ALLOW-list
 * (BUG-120, ARCH-010). It has two parts, each owned in ONE place, and the SAME
 * set drives both the room strip AND the diff the verifier is handed (BUG-186):
 *
 *   1. AMBIENT_FILE_NAMES / AMBIENT_DIR_NAMES — the files/dirs agent CLIs
 *      auto-discover on entry (CLAUDE.md, AGENTS.md, .claude, …). This is a
 *      property of the CLIs, not of any project, so it lives here and applies to
 *      EVERY repo this script verifies, including a foreign one with no
 *      declaration of its own.
 *   2. The project's PROSE ROOTS — methodology, board, architecture notes,
 *      conventions, analysis. Declared by the project in `src/server/
 *      cleanroom-surface.mjs` (read OUT OF THE ROOM's own copy — the revision
 *      under test), so a repo that reorganises its docs is self-describing and
 *      a newly-added document under a root needs NO edit here. A repo without
 *      that declaration falls back to DEFAULT_PROSE_ROOTS.
 *
 * The old `CONTAMINATION` array was a hand-maintained deny-list that named
 * `docs/prompts`/`docs/bugs` but missed `docs/CONVENTIONS.md`,
 * `docs/ARCHITECTURE-REVIEW.md` and `docs/analysis/` — the exact defect BUG-120
 * records. Naming the ROOT closes that class.
 */
// Ambient instruction surface, split into files and directories, matched by
// NAME at ANY DEPTH — a CLI auto-discovers a nested `src/AGENTS.md` or
// `pkg/.claude` just as it does one at the repo root (BUG-186 round-2). Both the
// room strip and the diff exclusion walk this SAME recursive rule, so nothing
// undeclared reaches the verifier by either route. Unconditional: an
// auto-discovered instruction file is never a legitimate declared input, so the
// allow-list does not spare it.
// Ambient instruction surface as case-insensitive PATTERNS (round-7). A CLI
// auto-loads whole FAMILIES, not fixed names — Codex loads AGENTS.md AND
// AGENTS.override.md; Claude loads CLAUDE.md and CLAUDE.local.md; Gemini loads
// GEMINI.md; Cursor loads .cursorrules and .cursor/rules/. A fixed name list
// misses a variant by construction (round-6: AGENTS.override.md slipped through
// as "declared code" and shipped). A pattern per family covers the variants.
// `AGENTS?(\.[^/]*)?\.md` = AGENTS.md / AGENT.md / AGENTS.override.md /
// AGENTS.local.md, but NOT AGENTSFOO.md (the dot-segment is required).
export const AMBIENT_FILE_PATTERNS = [
  /^AGENTS?(\.[^/]*)?\.md$/i,
  /^CLAUDE(\.[^/]*)?\.md$/i,
  /^GEMINI(\.[^/]*)?\.md$/i,
  /^copilot-instructions\.md$/i,
  /^\.cursorrules$/i,
];
// Directories agent CLIs auto-load rules/config from, matched at any depth.
export const AMBIENT_DIR_NAMES = ['.claude', '.codex', '.cursor', '.gemini'];
/** Human-readable description of the ambient surface, for the run record. */
export const AMBIENT_INSTRUCTION_NAMES = [
  'AGENTS*.md', 'CLAUDE*.md', 'GEMINI*.md', 'copilot-instructions.md', '.cursorrules',
  ...AMBIENT_DIR_NAMES.map((d) => `${d}/`),
];
// Case-INSENSITIVE (round-4): a CLI's auto-discovery is not reliably
// case-sensitive, so any case variant of an ambient name is ambient.
const isAmbientFile = (name) => AMBIENT_FILE_PATTERNS.some((re) => re.test(String(name)));
const isAmbientDir = (name) => { const n = String(name).toLowerCase(); return AMBIENT_DIR_NAMES.some((d) => d.toLowerCase() === n); };
/** Prose home assumed for a repo that ships no cleanroom-surface.mjs. */
export const DEFAULT_PROSE_ROOTS = ['docs'];
const PROSE_SURFACE_DECL = path.join('src', 'server', 'cleanroom-surface.mjs');

/**
 * Read the project's declared prose roots OUT OF THE ROOM (the revision under
 * test), mirroring `declaredBootDocs`. A repo without the declaration is not an
 * error — it simply gets DEFAULT_PROSE_ROOTS. A declaration that is PRESENT but
 * broken is loud (a room whose contamination surface cannot be read must not
 * quietly ship a leak).
 */
export async function declaredProseRoots(dir) {
  const decl = path.join(dir, PROSE_SURFACE_DECL);
  if (!fs.existsSync(decl)) return [...DEFAULT_PROSE_ROOTS];
  let mod;
  try { mod = await import(pathToFileURL(decl).href); }
  catch (err) {
    die(`clean room cannot read the prose-surface declaration ${PROSE_SURFACE_DECL}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let roots;
  try { roots = typeof mod.cleanroomProseRoots === 'function' ? mod.cleanroomProseRoots() : null; }
  catch (err) {
    die(`clean room could not evaluate cleanroomProseRoots() in ${PROSE_SURFACE_DECL}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(roots) || !roots.every((r) => typeof r === 'string' && r.trim())) {
    die(`clean room got no usable prose-root list from ${PROSE_SURFACE_DECL} (expected cleanroomProseRoots() to return an array of repo-relative paths).`);
  }
  return roots;
}

/** POSIX-normalise a repo-relative path (the interchange form used everywhere here). */
function normRel(rel) {
  return String(rel).split(path.sep).join('/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/**
 * Canonicalise a DECLARED path (an `--allow-input`) ONCE at intake (round-4
 * finding): resolve `.`/`..`/`//`/trailing-slash to a single repo-relative POSIX
 * form, and REFUSE anything absolute or escaping the repo. Every later
 * comparison — the ambient hard error, the predicate, the strip, the diff — then
 * sees the same canonical string, so `docs/a/../keep.json` can no longer pass the
 * fs existence check (which resolves `..`) while the predicate compares the raw
 * literal and strips the real `docs/keep.json`.
 */
export function canonicalizeDeclared(raw) {
  const posix = String(raw).split(path.sep).join('/');
  if (path.posix.isAbsolute(posix)) die(`--allow-input ${raw} must be a repo-relative path, not absolute`);
  const norm = path.posix.normalize(posix).replace(/\/+$/, '').replace(/^\.\//, '');
  if (norm === '' || norm === '.') die(`--allow-input ${raw} does not name a file inside the repo`);
  if (norm === '..' || norm.startsWith('../') || norm.split('/').includes('..')) {
    die(`--allow-input ${raw} escapes the repository (resolves to ${norm}); a declared input must be a path inside the repo`);
  }
  return norm;
}

/** Does a repo-relative path exist in `dir`, by LSTAT (a symlink counts, dangling or not)? */
function lexists(dir, rel) { try { fs.lstatSync(path.join(dir, ...rel.split('/'))); return true; } catch { return false; } }

/**
 * The real LEAF paths (files and symlinks, never dirs) under a repo-relative
 * path in `dir`, by an lstat walk that never follows a symlink. A file or symlink
 * leaf returns itself; a directory returns all its leaves; a missing path returns
 * []. Used to CAPTURE what a declared `--allow-input` actually contains at intake,
 * so the post-condition can prove every one of those leaves SURVIVED to the final
 * room (round-5: an emptied declared dir, or a declared file that was itself an
 * escaping symlink `auditSymlinks` later removed, is a silent loss otherwise).
 */
function realLeavesUnder(dir, rel) {
  let st; try { st = fs.lstatSync(path.join(dir, ...rel.split('/'))); } catch { return []; }
  if (!st.isDirectory()) return [rel];
  const out = [];
  (function rec(r) {
    let ents; try { ents = fs.readdirSync(path.join(dir, ...r.split('/')), { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const cr = `${r}/${e.name}`;
      if (e.isDirectory() && !e.isSymbolicLink()) rec(cr);
      else out.push(cr);
    }
  })(rel);
  return out;
}

/**
 * A CONTENT signature of a leaf (round-6): `{kind:'file', sig:<sha256>}` for a
 * regular file, `{kind:'symlink', sig:<link target>}` for a symlink, or null if
 * the path is missing. Captured for each declared-input leaf at intake and
 * re-checked on the FINAL room, so a boot stub (or any writer) standing in for a
 * declared input with DIFFERENT bytes is caught — mere existence is not enough.
 */
function fileSig(dir, leaf) {
  const p = path.join(dir, ...leaf.split('/'));
  let st; try { st = fs.lstatSync(p); } catch { return null; }
  if (st.isSymbolicLink()) { try { return { kind: 'symlink', sig: fs.readlinkSync(p) }; } catch { return null; } }
  if (st.isDirectory()) return { kind: 'dir', sig: '' };
  try { return { kind: 'file', sig: createHash('sha256').update(fs.readFileSync(p)).digest('hex') }; } catch { return null; }
}

/**
 * Write a file INTO the clean room through the ONE safe helper (round-7): it
 * refuses to follow a symlink at ANY existing path component (an lstat walk) and
 * refuses a destination whose real parent is OUTSIDE the room. A writer that
 * followed a committed symlink (`src/out` → off-tree) used to drop a boot stub
 * OUTSIDE the room — a containment breach. No room write may bypass this.
 */
export function safeWriteInRoom(dir, rel, body, mode) {
  const roomReal = fs.realpathSync(dir);
  const parts = normRel(rel).split('/');
  let cur = dir;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = path.join(cur, parts[i]);
    let st; try { st = fs.lstatSync(cur); } catch { continue; } // missing → will be a real mkdir
    if (st.isSymbolicLink()) {
      die(`refusing to write ${rel} into the clean room: path component ${path.relative(dir, cur)} is a SYMLINK — a room writer must never follow a link (it could write OUTSIDE the room). The symlink audit removes escaping links before any writer; a link still here is a hard error.`);
    }
  }
  const p = path.join(dir, ...parts);
  // Refuse to write THROUGH a symlink leaf too (it could redirect the write).
  try { if (fs.lstatSync(p).isSymbolicLink()) die(`refusing to write ${rel} into the clean room: the target itself is a SYMLINK.`); } catch { /* absent → fine */ }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const parentReal = fs.realpathSync(path.dirname(p));
  if (parentReal !== roomReal && !parentReal.startsWith(roomReal + path.sep)) {
    die(`refusing to write ${rel}: its parent resolves to ${parentReal}, OUTSIDE the clean room ${roomReal}.`);
  }
  fs.writeFileSync(p, body, mode ? { mode } : undefined);
}

/**
 * Write a file that MUST NOT follow a symlink at its final component (round-8).
 * `O_NOFOLLOW` makes `open` fail (ELOOP) rather than write through a symlink, so
 * a committed OR verifier-planted symlink at a harness-written spool path
 * (`.vrun/alive`, `.vrun/res/*`) can never redirect the write onto declared code
 * or out of the room. Returns true on success; callers treat false as "spool
 * gone / under attack" (fail-safe: the heartbeat goes stale → vrun exits, the
 * authoritative record stays in memory). Intermediate components are harness-
 * created (the `.vrun` dir is refused if the export already contains it).
 */
export function writeNoFollow(p, data) {
  let fd;
  try { fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600); }
  catch { return false; }
  try { fs.writeSync(fd, typeof data === 'string' ? data : String(data)); return true; }
  catch { return false; }
  finally { try { fs.closeSync(fd); } catch { /* already closed */ } }
}

/**
 * Is a repo-relative path an ambient-instruction path, at ANY depth? True when
 * ANY path segment is an ambient DIR name (so `.claude` and everything under it,
 * anywhere), OR the FINAL segment is an ambient FILE name (`src/AGENTS.md`). A
 * path's TYPE is irrelevant — a symlink, dir or file named `.claude` is ambient
 * all the same (round-3 finding: a `.claude` symlink used to slip a type check).
 * Ambient is never a legitimate declared input, so this is unconditional.
 */
export function isAmbientPath(rel) {
  const segs = normRel(rel).split('/').filter(Boolean);
  if (!segs.length) return false;
  if (isAmbientFile(segs[segs.length - 1])) return true;
  return segs.some((s) => isAmbientDir(s));
}

/**
 * THE ONE PREDICATE (round-3 redesign). Given the declared surface, decide for a
 * byte-exact repo-relative path whether the verifier MAY see it. EVERY route —
 * the room strip, the post-strip assertion, and the diff filter — asks THIS and
 * nothing else, so a string-built pathspec and a hand walk can no longer
 * disagree with git's view of the tree on an edge case (that disagreement was
 * rounds 1–2). The three prior rounds each patched one edge; this removes the
 * second decision point instead.
 *
 *   - ambient (any depth, any type) → NEVER declared (cannot be allow-listed);
 *   - outside every prose root → declared (code / config / tests);
 *   - inside a prose root → declared ONLY if it IS an allowed input or under one.
 */
export function makeIsDeclared({ proseRoots = [], allowed = [] } = {}) {
  const allow = [...new Set((allowed ?? []).map(normRel))];
  const proseSet = (proseRoots ?? []).map(normRel);
  const inProse = (rel) => proseSet.some((r) => rel === r || rel.startsWith(r + '/'));
  const underAllowed = (rel) => allow.some((a) => rel === a || rel.startsWith(a + '/'));
  return (raw) => {
    const rel = normRel(raw);
    if (isAmbientPath(rel)) return false;
    if (!inProse(rel)) return true;
    return underAllowed(rel);
  };
}

/**
 * Strip everything the verifier may NOT see from an exported clean room, using
 * `makeIsDeclared` as the sole decision, walked with `withFileTypes` (lstat, so
 * a symlink is judged as a leaf on its OWN path and NEVER followed). Walks the
 * WHOLE tree — node_modules included (round-3 finding: `node_modules/pkg/AGENTS.md`
 * used to survive because the walk skipped it). Returns the nodes removed.
 * Exported so the boot-stub suite exercises the real strip, not a copy of it.
 */
export function stripCleanroom(dir, { proseRoots = [], allowed = [] } = {}) {
  const isDeclared = makeIsDeclared({ proseRoots, allowed });
  const allow = [...new Set((allowed ?? []).map(normRel))];
  const ancestorOfAllowed = (rel) => allow.some((a) => a === rel || a.startsWith(rel + '/'));
  const stripped = [];
  const remove = (rel) => {
    try { fs.rmSync(path.join(dir, ...rel.split('/')), { recursive: true, force: true }); stripped.push(rel); } catch { /* gone */ }
  };
  (function walk(relDir) {
    let ents;
    try { ents = fs.readdirSync(relDir ? path.join(dir, ...relDir.split('/')) : dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      const isRealDir = e.isDirectory() && !e.isSymbolicLink();
      if (isDeclared(rel)) { if (isRealDir) walk(rel); continue; }   // keep; recurse a real dir to catch nested ambient
      if (isRealDir && ancestorOfAllowed(rel)) { walk(rel); continue; } // needed ancestor of a declared input → keep, prune inside
      remove(rel);                                                    // undeclared file / dir / symlink → gone (symlink never followed)
    }
  })('');
  return stripped;
}

/**
 * Boot stubs. Stripping `docs/prompts` (above) is correct — the verifier must
 * not read our methodology — but the SERVER refuses to boot without it:
 * `seedTemplates()` (src/server/templates.ts) reads a set of doc paths at
 * startup and throws ENOENT if any is missing, which surfaces to the verifier
 * only as the opaque `server never healthy`. Every UI/server-backed
 * verification used to pay this tax by hand (a stub-creation one-liner smuggled
 * into the requirement text and `--run`). So the clean room seeds the minimum
 * set ITSELF, right after stripping.
 *
 * WHICH PATHS (BUG-182). This script used to hold its own hardcoded list. That
 * was a SECOND PLACE holding a fact `templates.ts` owns, and the two drifted:
 * `templates.ts` grew `WORKING_AGREEMENT.v3.md` and `.v4.md`, the list did not,
 * and clean-room rounds needing a live server silently degraded to static
 * evidence behind `server never became healthy`. Per ARCH-010 the list is now
 * DECLARED by its owner (`src/server/seed-sources.mjs`) and READ here — and
 * read out of THE CLEAN ROOM'S OWN COPY, i.e. the revision under test, so the
 * stub set always matches the code that will boot. A newly-added seed doc is
 * picked up with zero edits to this file.
 *
 * SAFETY PROPERTY (the whole point): each stub is an INERT placeholder, NOT a
 * copy of the real file. The reason we strip is that the verifier must not
 * inherit our framing; seeding real content back would defeat that entirely.
 * The server only needs these paths to EXIST and be readable — it does not care
 * what they say — so a one-line placeholder satisfies the boot path while
 * transmitting zero methodology. If a seeded doc ever needs real CONTENT to
 * boot, stop and rethink rather than seeding real prose here.
 */
const SEED_SOURCE_DECL = path.join('src', 'server', 'seed-sources.mjs');
/** The seeder itself: present without its declaration ⇒ the room cannot boot. */
const SEEDER = path.join('src', 'server', 'templates.ts');

/**
 * Read the boot-required doc paths the ROOM declares. Every failure here is
 * LOUD and names what is wrong: a clean room that cannot learn what to stub
 * must not proceed to a health-check timeout that reads like a defect in the
 * subject under test (BUG-182 is exactly that failure).
 *
 * The module is imported from the exported room. It is a tiny, dependency-free
 * declaration file — no I/O, no side effects — which is why reading it this way
 * is safe; it is the same rule as `--run` executing the room's own code.
 */
export async function declaredBootDocs(dir) {
  const decl = path.join(dir, SEED_SOURCE_DECL);
  if (!fs.existsSync(decl)) {
    // A repo that has no seeding server (this script is not Orchard-only — it
    // verifies any repo) declares nothing and needs nothing stubbed. But if the
    // SEEDER is there and its declaration is not, the room is the BUG-182 trap
    // again: say so instead of shipping a room whose server dies opaquely.
    if (fs.existsSync(path.join(dir, SEEDER))) {
      die(`clean room cannot determine its boot stubs: ${SEEDER} is present but ${SEED_SOURCE_DECL} is missing from the exported tree. ` +
          'That file is the single declaration of the docs seedTemplates() reads at boot; without it the server would die on an ' +
          'unexplained health-check timeout. Refusing to build a room that cannot boot.');
    }
    return [];
  }
  let mod;
  try {
    mod = await import(pathToFileURL(decl).href);
  } catch (err) {
    die(`clean room cannot read the boot-stub declaration ${SEED_SOURCE_DECL}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let rels;
  try {
    rels = typeof mod.seedSourceRelPaths === 'function' ? mod.seedSourceRelPaths() : null;
  } catch (err) {
    die(`clean room could not evaluate seedSourceRelPaths() in ${SEED_SOURCE_DECL}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(rels) || rels.length === 0 || !rels.every((r) => typeof r === 'string' && r.trim())) {
    die(`clean room got no usable boot-stub list from ${SEED_SOURCE_DECL} (expected seedSourceRelPaths() to return ` +
        'a non-empty array of repo-relative paths). A room that stubs nothing cannot boot the server.');
  }
  return rels.map((r) => r.split('/').join(path.sep));
}
const BOOT_STUB_BODY =
  'Clean-room placeholder — independent-verify.mjs.\n\n' +
  'The real file was removed as CONTAMINATION so the verifier cannot inherit\n' +
  'this project\'s methodology or board prose. This inert placeholder exists\n' +
  'ONLY so the stripped server can boot (seedTemplates reads this path). It\n' +
  'deliberately carries no real content.\n';

/**
 * Write the inert boot stubs a stripped room needs, from the list the ROOM
 * declares (BUG-182). Exported so the proof script can exercise the real thing
 * rather than a re-implementation of it.
 */
export async function seedBootStubs(dir, { allowed = [] } = {}) {
  const bootDocs = await declaredBootDocs(dir);
  const allow = [...new Set(allowed.map(normRel))];
  const collidesAllowed = (rel) => allow.some((a) => rel === a || rel.startsWith(a + '/') || a.startsWith(rel + '/'));
  const seededStubs = [];
  for (const relSep of bootDocs) {
    const rel = relSep.split(path.sep).join('/');
    // (round-6 rule b) Boot-stub seeding is a SECOND writer into the room that
    // runs after the strip. It must NEVER write an ambient-named path — doing so
    // resurrects an auto-discovered instruction file the strip removed.
    if (isAmbientPath(rel)) {
      die(`clean room refuses to seed an ambient-named boot doc ${rel}: writing it would RESURRECT an ambient-instruction file the strip removed. The repo's seed-source declaration (${SEED_SOURCE_DECL}) must not point seedTemplates at an ambient-named path.`);
    }
    // (round-6 rule a) …and must NEVER overwrite or stand in for a declared input.
    if (collidesAllowed(rel)) {
      die(`clean room refuses to seed boot doc ${rel}: it collides with a declared --allow-input, so a placeholder would stand in for the real declared content. Declare a different input, or move the seed doc.`);
    }
    const p = path.join(dir, ...rel.split('/'));
    if (fs.existsSync(p)) continue; // survived the strip (unexpected, but respect it)
    try {
      // Through the ONE safe writer: never follow a symlink component, never
      // write outside the room (round-7 containment-breach fix).
      safeWriteInRoom(dir, rel, BOOT_STUB_BODY);
      seededStubs.push(rel);
    } catch (err) {
      die(`clean room could not seed the boot stub ${rel} (the server cannot start without it — seedTemplates reads it): ${(err instanceof Error ? err.message : String(err))}`);
    }
  }
  // And PROVE it: every declared boot doc must now exist in the room. A gap here
  // is what BUG-182 was — the server dies at boot and the round sees only
  // `server never became healthy`. Name the missing path instead.
  const missing = bootDocs.filter((rel) => !fs.existsSync(path.join(dir, rel)));
  if (missing.length) {
    die(`clean room cannot boot: seedTemplates needs ${missing.join(', ')} — declared in ${SEED_SOURCE_DECL} but not present in the room after stubbing. ` +
        'Refusing to hand the verifier a room whose server will die on an opaque health-check timeout.');
  }
  return seededStubs;
}

/**
 * DEPENDENCIES — COPIED, never symlinked (BUG-112).
 *
 * The clean room used to get `node_modules` as a SYMLINK to the live repo's
 * `node_modules`. That made the clean room a WRITE PATH INTO THE LIVE
 * REPOSITORY, which is the exact opposite of what a clean room is for. Three
 * proven escapes, all from inside the room:
 *   - `node_modules/../package.json` — the kernel resolves `..` AFTER the
 *     symlink, so an ordinary relative write lands on the LIVE package.json;
 *   - `node_modules/<anything>` — a plain write into the live tree;
 *   - a package manager: run `npm install <pkg>` with the cwd inside
 *     `node_modules` and npm walks up from the REAL path, finds the live repo
 *     root and rewrites the live `package.json` + `package-lock.json`. That is
 *     not hypothetical — it happened, mid-flight, while another lane was
 *     editing `package.json`, and the revert nearly ate that lane's work.
 *
 * The objection to copying was cost. Measured, on this project's 374 MB /
 * 10,871-file `node_modules`: `cp -a --reflink=auto` takes 0.4 s and consumes
 * ~0 extra disk on a CoW filesystem (btrfs/XFS), and 1.1 s / 374 MB when the
 * copy has to be real. A verification dispatch takes MINUTES. The cost is
 * noise; the write path was not. So: copy, preferring a reflink, and report
 * the mode and the milliseconds honestly rather than claiming it is free.
 *
 * `cp -a` preserves symlinks AS symlinks (`.bin/*` are relative and stay inside
 * the copy); anything that points out of the room is removed by auditSymlinks.
 */
function provisionModules(repo, dir) {
  const nm = path.join(repo, 'node_modules');
  const dest = path.join(dir, 'node_modules');
  // Round-8 defence: if the exported tree committed a `node_modules` SYMLINK
  // (gitignored normally, so this needs a forced add — but possible), `cp` could
  // write THROUGH it outside the room. Remove a symlink at the dest first so the
  // copy always lands on a real in-room directory.
  try { if (fs.lstatSync(dest).isSymbolicLink()) fs.rmSync(dest, { force: true }); } catch { /* absent */ }
  if (!fs.existsSync(nm) || fs.existsSync(dest)) return { mode: 'none', ms: 0 };
  // `--reflink=auto` fails SILENTLY across a filesystem boundary: it does a full
  // byte copy and exits 0, so the only symptom is that a 0.4 s copy became a
  // real one. Detect and REPORT it (the snapshot store's preflight shape) rather
  // than letting every run pay for it invisibly.
  const fsCheck = checkSameFilesystem(nm, dir);
  const t0 = Date.now();
  // GNU cp: reflink where the filesystem supports it, a real copy where it does
  // not. Either way the result is an independent tree, never a live-tree alias.
  const r = spawnSync('cp', ['-a', '--reflink=auto', nm, dest], { encoding: 'utf8' });
  if ((r.status ?? 1) === 0) return { mode: 'copy (cp -a --reflink=auto)', ms: Date.now() - t0, fsCheck };
  try {
    fs.cpSync(nm, dest, { recursive: true, verbatimSymlinks: true, force: true });
    return { mode: 'copy (fs.cpSync fallback)', ms: Date.now() - t0, fsCheck };
  } catch (err) {
    // Fail OPEN on capability, CLOSED on safety: no dependencies is a weaker
    // verification (and is reported as such), but it is never a link back into
    // the live tree.
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* nothing to undo */ }
    return { mode: 'NONE — copy failed, and a symlink to the live tree is not an option', ms: Date.now() - t0, fsCheck, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * CAUSE 3 (BUG-203, BUG-268 r1 run d7c2127d, BUG-250 run 4cad32f7, BUG-120 run
 * 9da3de75): a `git archive | tar` export has NO .git, so any harness the verifier
 * must re-run that uses git — `git init` a scratch repo, `git rev-parse`, a shim
 * that shells out to git — fails as an ENVIRONMENT artifact and the verdict comes
 * back INVALID: a wasted 20-60 min round, not a product defect. The old workaround
 * was to wrap the suite in `npm run confined`, which then broke the FIXER-TEST
 * citation (cause 1).
 *
 * Seed a REAL but wholly SYNTHETIC scratch .git at room-build time so the verifier's
 * own git use just works: a hand-built skeleton with no remote and no alternates,
 * built HERMETICALLY (global/system git config read from /dev/null, no inherited
 * GIT_* env via buildRoomGitEnv, hooks disabled), a synthetic identity
 * (verify@example.invalid — the sanctioned throwaway address, docs/CONVENTIONS.md),
 * and ONE commit of the FINAL room tree (the copied node_modules excluded — it is a
 * 10k-file live-tree copy, slow and pointless to commit).
 *
 * SUPPORTED CONTRACT (BUG-273 r3 adjudication). The clean room is a DECORRELATION
 * mechanism (WA §I — the verifier should not know the board, methodology, or author),
 * NOT a containment/exfiltration jail. The enforceable property here is SEED
 * HERMETICITY: because the commit is built through buildRoomGitEnv with NO inherited
 * GIT_* env, no real objects can seep into the room's own commit, so a read or
 * `git show HEAD:<stripped path>` rooted IN the room serves only the inert boot stub,
 * never real methodology. What is OUT OF SCOPE and NOT defended: a verifier that
 * reaches the live repo by ABSOLUTE PATH or via `git -C <realrepo>`, or that is
 * steered by its own env (GIT_*, PATH, HOME/XDG gitconfig). The codex
 * `workspace-write` sandbox permits unrestricted filesystem READS (it jails only
 * WRITES), and the anthropic verifier path is an application-level permission gate,
 * not an OS jail — so cross-provider containment is architecturally impossible here
 * and was never a guarantee. (Live `codex sandbox -c sandbox_mode=workspace-write`
 * read test recorded in the BUG-273 r3 adjudication entry; do not re-litigate.)
 *
 * Best-effort: a seeding failure is LOUD on stderr but not fatal — a verification
 * that needs no git still runs, and one that does gets a clear git error rather than
 * the opaque `server never healthy` / stand-in-citation symptoms this fixes.
 */
/**
 * buildRoomGitEnv — the SINGLE env chokepoint (BUG-273 r2, P3) for EVERY
 * subprocess that runs rooted in the clean room: the scratch-.git seed's
 * add/write-tree/commit-tree, its HEAD-resolve check, AND the verifier dispatch.
 *
 * It takes the ambient environment and strips the ENTIRE `GIT*` family with ONE
 * prefix rule — not an enumerated name list. That single rule covers GIT_DIR,
 * GIT_WORK_TREE, GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_OBJECT_DIRECTORY,
 * GIT_NAMESPACE, GIT_COMMON_DIR, GIT_CEILING_DIRECTORIES, GIT_INDEX_FILE and any
 * FUTURE GIT_* by construction, so no inherited git state reaches a room git call.
 *
 * What this DOES buy (BUG-273 r3 adjudication — the enforceable, in-scope part):
 *   (a) SEED HERMETICITY — on the scratch-.git seed's plumbing, an inherited
 *       GIT_ALTERNATE_OBJECT_DIRECTORIES would otherwise seep real objects INTO the
 *       room's own commit, so `git -C room show HEAD:<stripped>` would then serve
 *       real prose. Dropping it keeps the room's commit built from ONLY the stripped
 *       tree. This IS the guarantee the seed must hold.
 *   (b) HONEST-CASE DECORRELATION HYGIENE — on the verifier dispatch, a verifier
 *       running `git log`/`show` rooted in the room (no `-C`) sees room state, not
 *       real-repo history leaked via inherited GIT_DIR. Correctness, not a wall.
 *
 * What it is NOT: a containment/exfiltration boundary. A verifier can still read the
 * live repo by ABSOLUTE PATH or `git -C <realrepo>`, or steer itself via PATH /
 * HOME/XDG gitconfig — all explicitly OUT OF SCOPE (the sandbox permits reads
 * anywhere; the anthropic path is an app-level gate, not an OS jail). This env
 * builder defends only (a) and (b); it is NOT the clean room's security guarantee.
 *
 * It replaces three hand-maintained `...process.env` sites that each had to
 * remember the GIT_* deny-list and had ALREADY diverged (the seed overrode a
 * handful of GIT_* names but left GIT_ALTERNATE_OBJECT_DIRECTORIES et al. intact;
 * the HEAD check omitted even GIT_DIR; the verifier dispatch stripped nothing).
 *
 * NON-git vars are KEPT: the verifier dispatch child needs the full
 * provider/auth/config surface (HOME, PATH, CLAUDE_CONFIG_DIR, the codex binary
 * seam, tool-profile, locale, …) to authenticate and run — a 5-name positive
 * allowlist would break every real dispatch. `extra` is layered LAST so the
 * room's own git identity/dir vars (passed by the seed) win over the (absent)
 * inherited ones.
 */
export function buildRoomGitEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^GIT(_|$)/.test(k)) continue; // drop EVERY inherited GIT_* name by one prefix rule
    if (v !== undefined) env[k] = v;
  }
  return { ...env, ...extra };
}

export function seedScratchGit(dir) {
  try {
    const gitDir = path.join(dir, '.git');
    if (fs.existsSync(gitDir)) return { ok: false, error: '.git already present in the room (git archive never exports it — refusing to overwrite)' };
    // 1. A minimal, VALID .git skeleton, written with PLAIN FS WRITES. The installed
    //    git-write shim refuses `git init` (it is not a read verb), but the shim
    //    guards the `git` BINARY, not filesystem writes — so hand-building the
    //    skeleton is permitted and reaches nothing real. No remote, no alternates:
    //    the repo is wholly self-contained and can never address the real repo.
    fs.mkdirSync(path.join(gitDir, 'objects', 'info'), { recursive: true });
    fs.mkdirSync(path.join(gitDir, 'objects', 'pack'), { recursive: true });
    fs.mkdirSync(path.join(gitDir, 'refs', 'heads'), { recursive: true });
    fs.mkdirSync(path.join(gitDir, 'refs', 'tags'), { recursive: true });
    fs.mkdirSync(path.join(gitDir, 'info'), { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(gitDir, 'config'),
      '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = false\n');
    // node_modules is a 10k-file live-tree COPY (and may not be gitignored in a
    // foreign repo); keep it out of the commit. info/exclude ignores the whole dir
    // so `git add` never descends into it.
    fs.writeFileSync(path.join(gitDir, 'info', 'exclude'), '/node_modules/\n');
    // 2. Build ONE commit of the room tree via the SANCTIONED temp-index plumbing
    //    the shim already permits (and snapshotWorkingTree already uses): add /
    //    write-tree / commit-tree under a GIT_INDEX_FILE inside the OS temp dir.
    //    None of the shim-refused verbs (init / commit / update-ref) is used.
    const idxTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-gitidx-'));
    // Through the ONE chokepoint: NO inherited GIT_* (an inherited
    // GIT_ALTERNATE_OBJECT_DIRECTORIES would otherwise seep real objects into
    // this commit); only the room-set git vars below reach the plumbing.
    const env = buildRoomGitEnv({
      GIT_DIR: gitDir,
      GIT_WORK_TREE: dir,
      GIT_INDEX_FILE: path.join(idxTmp, 'index'), // under os.tmpdir() → isTempIndex
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      // Synthetic throwaway identity — docs/CONVENTIONS.md sanctions this address
      // for scratch/fixture repos ONLY, and via env rather than the command line.
      GIT_AUTHOR_NAME: 'independent-verify', GIT_AUTHOR_EMAIL: 'verify@example.invalid',
      GIT_COMMITTER_NAME: 'independent-verify', GIT_COMMITTER_EMAIL: 'verify@example.invalid',
    });
    const g = (args) => spawnSync('git', args, { encoding: 'utf8', env });
    try {
      const add = g(['add', '-A']);
      if ((add.status ?? 1) !== 0) return { ok: false, error: `git add (temp index): ${(add.stderr || add.stdout || '').trim().slice(0, 200)}` };
      const wt = g(['write-tree']);
      if ((wt.status ?? 1) !== 0) return { ok: false, error: `git write-tree: ${(wt.stderr || '').trim().slice(0, 200)}` };
      const ct = g(['commit-tree', wt.stdout.trim(), '-m', 'clean-room base (synthetic — independent-verify)']);
      if ((ct.status ?? 1) !== 0) return { ok: false, error: `git commit-tree: ${(ct.stderr || '').trim().slice(0, 200)}` };
      const commit = ct.stdout.trim();
      // 3a. Install the index: the temp index already reflects the working tree
      //     (= the committed tree), so COPYING it to .git/index makes HEAD ↔ index
      //     ↔ worktree agree — `git status` is then clean. A `git read-tree`/`git
      //     add` against the real index would be shim-refused; an fs copy is not a
      //     git-binary call.
      fs.copyFileSync(path.join(idxTmp, 'index'), path.join(gitDir, 'index'));
      // 3b. Point the branch at the commit with a PLAIN FS WRITE (`git update-ref`
      //     would be refused by the shim; an fs write is not a git-binary call).
      fs.writeFileSync(path.join(gitDir, 'refs', 'heads', 'main'), commit + '\n');
      // 4. Prove it resolves (a READ the shim always allows).
      // Same chokepoint: `-C dir` must discover the ROOM's .git, which it only
      // does when no inherited GIT_DIR/GIT_COMMON_DIR points elsewhere.
      const head = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: buildRoomGitEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }) });
      if ((head.status ?? 1) !== 0 || head.stdout.trim() !== commit) {
        return { ok: false, error: `seeded repo does not resolve HEAD to the new commit (${(head.stderr || '').trim().slice(0, 160)})` };
      }
      return { ok: true, head: commit, error: null };
    } finally {
      try { fs.rmSync(idxTmp, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * CONTAINMENT AUDIT (BUG-112): after everything is in place, no path inside the
 * clean room may resolve OUT of it. `node_modules` was the symlink we knew
 * about; this closes the class — a symlink committed to the repo (`git archive`
 * exports symlinks faithfully) or shipped inside a dependency can point at
 * `/home/<user>/<project>` just as well, and would be just as writable.
 *
 * An escaping link is REMOVED, not merely reported: a report nobody reads is
 * not containment. Removals are surfaced on stderr so a verification that lost
 * something real is visible rather than mysterious.
 */
function auditSymlinks(dir) {
  const root = fs.realpathSync(dir);
  const inside = (p) => p === root || p.startsWith(root + path.sep);
  const removed = [];
  (function walk(d) {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) {
        let target;
        try { target = fs.realpathSync(full); }
        catch { // dangling: judge it textually — where WOULD it land?
          try { target = path.resolve(path.dirname(full), fs.readlinkSync(full)); } catch { continue; }
        }
        if (!inside(target)) {
          try { fs.rmSync(full, { force: true }); removed.push(`${path.relative(root, full)} -> ${target}`); } catch { /* best effort */ }
        }
        continue; // never follow a link while walking
      }
      if (e.isDirectory()) walk(full);
    }
  })(root);
  return removed;
}

/**
 * ZERO SYMLINKS in the room (round-9). After `auditSymlinks` has removed every
 * ESCAPING link, this removes every remaining INTERNAL symlink too, so the final
 * room contains no symlink at all (except under a declared `--allow-input`, which
 * the verifier asked for). `node_modules/.bin/*` entries — the one class of
 * internal symlink the verifier legitimately needs to run tools — are
 * MATERIALISED as tiny `exec` shim scripts that invoke the real (in-room) target,
 * so tooling keeps working without a symlink. Returns what it did. This is
 * defence-in-depth now that all harness writes live outside the room: no symlink
 * remains for any writer to follow.
 */
export function materializeSymlinks(dir, { allowed = [] } = {}) {
  const allow = [...new Set((allowed ?? []).map(normRel))];
  const underAllowed = (rel) => allow.some((a) => rel === a || rel.startsWith(a + '/'));
  const roomReal = fs.realpathSync(dir);
  const inRoom = (p) => p === roomReal || p.startsWith(roomReal + path.sep);
  const isUnderBin = (rel) => rel.split('/').includes('.bin');
  const materialized = [], removed = [];
  (function walk(relDir) {
    let ents; try { ents = fs.readdirSync(relDir ? path.join(dir, ...relDir.split('/')) : dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isSymbolicLink()) {
        if (underAllowed(rel)) continue; // the verifier declared this input; leave it
        const abs = path.join(dir, ...rel.split('/'));
        let target = null; try { target = fs.realpathSync(abs); } catch { /* dangling */ }
        fs.rmSync(abs, { force: true });
        if (target && inRoom(target) && isUnderBin(rel)) {
          // a `.bin` tool launcher → an exec shim honouring the target's own shebang
          safeWriteInRoom(dir, rel, `#!/bin/sh\nexec ${JSON.stringify(target)} "$@"\n`, 0o755);
          materialized.push(rel);
        } else {
          removed.push(rel);
        }
        continue;
      }
      if (e.isDirectory()) walk(rel);
    }
  })('');
  return { materialized, removed };
}

async function buildCleanroom(repo, rev, { allowed = [] } = {}) {
  const dir = mkdtempScratch('cleanroom-verify-');
  // BUG-250: register for crash cleanup the instant it exists (before the tar
  // below, which can `die()`). A `--keep-cleanroom` room is simply NOT registered,
  // so it is never auto-deleted — nothing else needs doing to preserve it.
  if (!opts.keepCleanroom) trackScratch(dir);
  const tar = spawnSync('sh', ['-c', `git -C ${JSON.stringify(repo)} archive ${JSON.stringify(rev)} | tar -x -C ${JSON.stringify(dir)}`], { encoding: 'utf8' });
  if ((tar.status ?? 1) !== 0) die(`could not export ${rev} into a clean room: ${(tar.stderr || '').trim()}`);

  // The prose roots the ROOM itself declares (revision under test), plus the
  // universal ambient set — one surface, read once, that drives BOTH this strip
  // and the diff the verifier is handed (BUG-186). A declared --allow-input that
  // the room does not contain is a HARNESS error, never a product FAIL: the
  // check named an input that is not there, so nothing can be verified honestly.
  const proseRoots = await declaredProseRoots(dir);
  // Canonicalise every declared input ONCE, here (round-4): resolve `.`/`..`/
  // trailing-slash and refuse escapes, so every later comparison sees the same
  // repo-relative POSIX string.
  const allowedCanon = allowed.map(canonicalizeDeclared);
  for (const rel of allowedCanon) {
    // An ambient-instruction path is stripped UNCONDITIONALLY and can never be
    // provided — so declaring it as an input is a hard ERROR, never a silent drop
    // that leaves the run exiting 0 with the "input" absent (round-3 finding).
    // The ambient match is case-insensitive (round-4), so `.CLAUDE` is caught.
    if (isAmbientPath(rel)) {
      die(`--allow-input ${rel} names an ambient-instruction path (a CLI auto-discovers it as instructions), which the clean room strips unconditionally and can never provide as an input. Remove it, or rename the file so it is not ambient.`);
    }
    if (!fs.existsSync(path.join(dir, ...rel.split('/')))) {
      die(`--allow-input ${rel} is not present at the revision under test — a declared clean-room input that does not exist cannot be provided, and a missing input must surface as a harness error, not as a verification failure that looks like a real defect`);
    }
  }
  // CAPTURE what each declared input actually contains, NOW (before any
  // mutation), as its real leaves WITH a content signature (sha256 / symlink
  // target). The FINAL-stage assertion (after every writer) proves each leaf is
  // present AND byte-for-byte the captured original — so an emptied declared dir,
  // a declared escaping symlink the audit removes, OR a boot stub standing in for
  // a declared input (round-6) are all LOUD, never silent.
  const declaredCapture = allowedCanon.map((rel) => ({
    rel,
    leaves: realLeavesUnder(dir, rel).map((leaf) => ({ leaf, sig: fileSig(dir, leaf) })),
  }));

  // THE ROOM PIPELINE: every mutation of the room happens HERE, in order, and the
  // FINAL stage is the assertion below — nothing may mutate the room after it.
  // Writes, in code order (round-7: auditSymlinks moved BEFORE any WRITER, so a
  // writer can never follow an escaping symlink out of the room; every write then
  // also goes through safeWriteInRoom as a second guard):
  //   1. git archive | tar          (export the tree — above)
  //   2. provisionModules              (copy node_modules in)
  //   3. stripCleanroom                (remove everything undeclared)
  //   4. auditSymlinks                 (remove escaping symlinks)
  //   5. materializeSymlinks           (ZERO symlinks: .bin → exec shims, others removed)
  //   6. seedBootStubs                 (write inert boot placeholders, safely)
  //   7. recorder: vrun.mjs (spool is OUTSIDE the room, round-9)
  //   8. assertFinalRoom()             (LAST — the room exactly as handed over)
  const modules = provisionModules(repo, dir);
  const stripped = stripCleanroom(dir, { proseRoots, allowed: allowedCanon });
  const escapes = auditSymlinks(dir);
  const shims = materializeSymlinks(dir, { allowed: allowedCanon });
  const seededStubs = await seedBootStubs(dir, { allowed: allowedCanon });

  // THE RUN MANIFEST (2026-08-11 re-scope): executed evidence is proven by
  // artifacts the harness itself records, never by prose.
  //
  // PROVENANCE (the 3609cf7c fix, revised by BUG-092): the first version of
  // this recorder was a standalone vrun.mjs that appended to plain files in a
  // same-user temp dir, with the path readable from its own source — so a
  // verifier with Bash could hand-write manifest entries and `<id>.out` files
  // for runs that never happened (the eleventh closing clean-room verdict
  // demonstrated exactly that). Execution therefore happens HARNESS-SIDE: this
  // process executes each command itself and keeps the authoritative manifest —
  // WITH each run's full output — in its own MEMORY (`entries`, which the
  // sandboxed verifier cannot reach), mirroring to disk only as a
  // human-readable record.
  //
  // TRANSPORT (BUG-092): the earlier version relayed the command over a
  // unix-domain socket. That is UNREACHABLE from the cross-provider (openai/
  // codex) verifier: codex `workspace-write` applies a seccomp filter that
  // fails AF_UNIX `connect()` with EPERM — empirically, even when the socket
  // path is INSIDE the writable workspace (verified 2026-08-14 via `codex exec
  // --sandbox workspace-write`; both an in-workspace and an out-of-workspace
  // socket returned `EPERM connect`). So the socket is replaced by a FILE
  // SPOOL under the workspace: `.vrun/req/<nonce>.json` (the verifier drops the
  // command; workspace-write grants that write) and `.vrun/res/<nonce>.json`
  // (this process writes the result). Both directions are ordinary file I/O,
  // which the sandbox permits.
  //
  // The provenance property is UNCHANGED by the transport swap, because the
  // authority was never the transport — it is this process's in-memory
  // `entries`. The spool lives in the workspace and IS writable by the
  // verifier, but that buys nothing: a forged `.res` file (or a hand-written
  // manifest.jsonl / `<id>.out`) names an id this process never recorded, and
  // `composeVerdict`/`manifestCheck` reject any citation of an id absent from
  // `entries` as "a run that did not happen". Tampering is therefore DETECTABLE,
  // never silent. The residual is identical to before: a verifier can have a
  // real command PRINT its desired "evidence" — but the command is bound into
  // `RAN:` (visible on the verdict face) and the FIXER-TEST's RAN is pinned to
  // the harness-supplied command.
  const recordDir = mkdtempScratch('cleanroom-record-');
  if (!opts.keepCleanroom) trackScratch(recordDir);
  const manifestFile = path.join(recordDir, 'manifest.jsonl');
  // ROUND-9: ALL harness run-state lives OUTSIDE the room. The spool (the
  // verifier's request channel + the harness's heartbeat and responses) is a
  // FRESH mkdtemp under the SYSTEM TEMP dir — a root the codex workspace-write
  // sandbox permits the verifier to read AND write (the same `$TMPDIR` the
  // sanctioned GIT_INDEX_FILE-in-tmpdir writes use), and one that NO symlink
  // inside the room can redirect. The room therefore holds NO harness-write
  // target at all: a verifier symlink ANYWHERE in the room — committed or planted
  // mid-run — cannot redirect a harness write, because the harness never writes
  // inside the room during the run (rounds 1–8 all turned on an in-room harness
  // write following a symlink; this removes the class). vrun.mjs carries the
  // absolute spool paths baked in; nothing in the room points at them.
  const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanroom-spool-'));
  trackScratch(spoolDir); // BUG-250: disposable, but crash-clean it like the rest (7 leaked today)
  const reqDir = path.join(spoolDir, 'req');
  const resDir = path.join(spoolDir, 'res');
  fs.mkdirSync(reqDir);
  fs.mkdirSync(resDir);
  const entries = []; // authoritative, in-memory, outputs attached
  const aliveFile = path.join(spoolDir, 'alive');
  const MAX_OUTPUT = 64 * 1024 * 1024;
  const handled = new Set();
  // LIVENESS beat: the socket recorder's death was instantly visible to the
  // client (connect → ECONNREFUSED). The file spool restores that: this process
  // rewrites `<spool>/alive` with a fresh timestamp every poll tick, and vrun
  // treats a STALE heartbeat as "recorder dead" (exit 2), so a verifier can
  // never sit forever against a crashed harness NOR forge a record around one.
  // Execution is ASYNC (not spawnSync) precisely so the beat keeps ticking
  // while a long command runs — otherwise a blocking exec would look like death.
  // The spool is OUTSIDE the room (round-9); writeNoFollow is kept as a leaf
  // guard regardless.
  const beat = () => { writeNoFollow(aliveFile, String(Date.now())); };
  const respond = (file, obj) => {
    // Atomic publish: write a temp (no-follow) then rename, so the verifier's
    // poller never reads a half-written response. rename REPLACES a symlink at
    // the destination rather than following it.
    const tmp = path.join(resDir, `.${file}.tmp`);
    try { if (writeNoFollow(tmp, JSON.stringify(obj))) fs.renameSync(tmp, path.join(resDir, file)); }
    catch { /* the verifier may have raced/removed the spool; memory stays authoritative */ }
  };
  const record = (file, cmd, output, code) => {
    const exit = typeof code === 'number' ? code : 127;
    const sha256 = createHash('sha256').update(output).digest('hex').slice(0, 16);
    const id = randomBytes(6).toString('hex');
    const entry = { id, cmd, exit, sha256, bytes: Buffer.byteLength(output), ts: new Date().toISOString() };
    entries.push({ ...entry, output });
    try {
      fs.appendFileSync(manifestFile, JSON.stringify(entry) + '\n');
      fs.writeFileSync(path.join(recordDir, `${id}.out`), output);
    } catch { /* the disk mirror is a courtesy; memory is authoritative */ }
    respond(file, { ...entry, output });
  };
  const handleRequest = (file) => {
    if (handled.has(file) || !file.endsWith('.json') || file.startsWith('.')) return;
    handled.add(file);
    let req;
    try { req = JSON.parse(fs.readFileSync(path.join(reqDir, file), 'utf8')); }
    catch { return; } // partial/garbage request — a rename-based client never yields one
    const cmd = String(req?.cmd ?? '').trim();
    if (!cmd) { respond(file, { error: 'no command' }); return; }
    // Async spawn: the harness executes HARNESS-SIDE (authority unchanged) but
    // without blocking the heartbeat/poll loop, so a long test suite keeps the
    // recorder visibly alive to vrun.
    const child = spawn('sh', ['-c', cmd], { cwd: dir });
    let out = '', truncated = false;
    const grab = (d) => { if (out.length < MAX_OUTPUT) out += d; else truncated = true; };
    child.stdout.on('data', grab);
    child.stderr.on('data', grab);
    child.once('error', () => record(file, cmd, `vrun: could not execute command: ${cmd}\n`, 127));
    child.once('close', (code) => record(file, cmd, out + (truncated ? '\n[output truncated at 64MB]\n' : ''), code));
  };
  const drain = () => {
    beat();
    let files;
    try { files = fs.readdirSync(reqDir); } catch { return; }
    for (const f of files) handleRequest(f);
  };
  // Poll for request files (fs.watch is unreliable across some filesystems);
  // unref'd so it never keeps the process alive. On close the heartbeat stops,
  // which is how vrun learns the recorder is gone.
  beat();
  const poll = setInterval(drain, 75);
  poll.unref();
  const recorder = { close: () => { clearInterval(poll); untrackScratch(spoolDir); try { fs.rmSync(spoolDir, { recursive: true, force: true }); } catch { /* gone */ } } };

  safeWriteInRoom(dir, 'vrun.mjs', `#!/usr/bin/env node
// vrun.mjs — run-recorder CLIENT for independent verification. The harness
// executes the command itself and records {id, cmd, exit, output sha256} in
// its own memory; this client only relays the command (via a file spool the
// sandbox permits — a unix socket is blocked by the codex workspace-write
// seccomp filter, BUG-092) and prints the MANIFEST line to cite in the verdict.
// Evidence from runs made any other way is not counted, and a forged record is
// rejected because it cites an id the harness never recorded.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
const REQ = ${JSON.stringify(reqDir)};
const RES = ${JSON.stringify(resDir)};
const ALIVE = ${JSON.stringify(aliveFile)};
const STALE_MS = 4000; // > many poll ticks; a fresh heartbeat means the recorder lives
const cmd = process.argv.slice(2).join(' ');
if (!cmd) { console.error('usage: node ./vrun.mjs <command and args>'); process.exit(2); }
const dead = () => { console.error('vrun: the harness run recorder is not available — evidence cannot be recorded, and unrecorded runs do not count'); process.exit(2); };
const alive = () => {
  try { return Date.now() - Number(fs.readFileSync(ALIVE, 'utf8')) < STALE_MS; } catch { return false; }
};
if (!alive()) dead();
const name = randomBytes(8).toString('hex') + '.json';
try {
  const tmp = path.join(REQ, '.' + name + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify({ cmd }));
  fs.renameSync(tmp, path.join(REQ, name)); // atomic: the harness never sees a partial request
} catch { dead(); }
const resf = path.join(RES, name);
(function poll() {
  let raw = null;
  try { if (fs.existsSync(resf)) raw = fs.readFileSync(resf, 'utf8'); } catch { raw = null; }
  if (raw) {
    let res;
    try { res = JSON.parse(raw); } catch { setTimeout(poll, 40); return; }
    if (res.error) { console.error('vrun: ' + res.error); process.exit(2); }
    process.stdout.write(res.output ?? '');
    console.log(\`\\nMANIFEST: \${res.id} sha256=\${res.sha256} exit=\${res.exit}\`);
    process.exit(res.exit);
  }
  if (!alive()) dead(); // recorder died while we waited — never hang, never forge around it
  setTimeout(poll, 40);
})();
`, 0o755);

  // CAUSE 3: seed a synthetic scratch .git of the FINAL room tree, so a harness
  // the verifier re-runs can use git without failing as an environment artifact.
  // After the strip (stripped prose is not in the commit, so a room-rooted
  // `git show HEAD:<stripped>` serves only the inert stub — seed hermeticity, not a
  // containment wall against absolute-path reads) and before the final assertion (which validates the whole
  // room, .git included: it is `declared` content and carries zero symlinks).
  const gitSeed = seedScratchGit(dir);
  if (!gitSeed.ok) {
    process.stderr.write(`independent-verify: WARNING — could not seed the clean room's scratch .git (${gitSeed.error}); a harness that re-runs git will fail. The room is otherwise usable.\n`);
  }

  // ===== FINAL PIPELINE STAGE — assert the room EXACTLY as the verifier will
  // receive it, AFTER every writer (strip, audit, symlink materialisation, boot
  // seeding, vrun.mjs, scratch .git). NOTHING below this point may mutate the room, and the
  // harness writes NOTHING inside the room during the run (the spool is OUTSIDE
  // it, round-9). Evaluating here — not mid-pipeline — is the round-6 fix. =====
  const isDeclared = makeIsDeclared({ proseRoots, allowed: allowedCanon });
  const seededSet = new Set(seededStubs.map(normRel));
  const allowSet = [...new Set(allowedCanon.map(normRel))];
  const underAllowedInput = (rel) => allowSet.some((a) => rel === a || rel.startsWith(a + '/'));
  // A seeded boot stub is the ONLY undeclared content allowed to remain — and
  // only if it is provably INERT (its bytes are exactly BOOT_STUB_BODY) and not
  // ambient. Anything else undeclared is a leak.
  const okStub = (rel) => {
    const r = normRel(rel);
    if (!seededSet.has(r) || isAmbientPath(r)) return false;
    try { return fs.readFileSync(path.join(dir, ...r.split('/')), 'utf8') === BOOT_STUB_BODY; } catch { return false; }
  };
  const leftovers = [];
  const symlinks = [];
  (function scan(relDir) {
    let ents;
    try { ents = fs.readdirSync(relDir ? path.join(dir, ...relDir.split('/')) : dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isSymbolicLink()) {
        // ZERO SYMLINKS invariant (round-9): the only symlink allowed is one the
        // verifier declared as an input; everything else must be gone/materialised.
        if (!underAllowedInput(rel)) symlinks.push(rel);
        if (!isDeclared(rel) && !okStub(rel)) leftovers.push(rel);
        continue;
      }
      if (e.isDirectory()) { scan(rel); continue; }
      if (!isDeclared(rel) && !okStub(rel)) leftovers.push(rel);
    }
  })('');
  if (symlinks.length) {
    die(`clean room still contains SYMLINK(s) after materialisation (round-9 invariant: the room has ZERO symlinks outside a declared input): ${symlinks.slice(0, 50).join(', ')}${symlinks.length > 50 ? ` … (+${symlinks.length - 50} more)` : ''}`);
  }
  if (leftovers.length) {
    die(`clean room is NOT clean (final room, as handed to the verifier) — undeclared content survived EVERY stage: ${leftovers.slice(0, 50).join(', ')}${leftovers.length > 50 ? ` … (+${leftovers.length - 50} more)` : ''}`);
  }
  // Every declared input is PRESENT and byte-for-byte the captured original — a
  // boot stub (or any writer) standing in for it with different content is caught.
  for (const { rel, leaves } of declaredCapture) {
    if (!leaves.length && !lexists(dir, rel)) {
      die(`clean room lost a declared input: --allow-input ${rel} is not present in the final room.`);
    }
    for (const { leaf, sig } of leaves) {
      const now = fileSig(dir, leaf);
      if (!now) die(`clean room lost declared-input content: --allow-input ${rel} — ${leaf} is absent from the final room (stripped, overwritten, or an escaping symlink cleaned up).`);
      if (sig && (now.kind !== sig.kind || now.sig !== sig.sig)) {
        die(`clean room altered a declared input: --allow-input ${rel} — ${leaf} in the final room is not the captured original (a boot stub or other writer stood in for it). The verifier must see the real declared bytes, or a loud harness error.`);
      }
    }
  }
  // Every boot stub we seeded is PRESENT and INERT in the FINAL room (round-7):
  // a stub dropped through an (audited-away) escaping symlink, or overwritten, is
  // a missing/altered boot doc — the server would then die opaquely at boot.
  for (const rel of seededStubs) {
    const sig = fileSig(dir, rel);
    if (!sig) die(`clean room boot stub ${rel} is ABSENT from the final room (it was seeded, then lost — e.g. written through an escaping symlink the audit removed). The stripped server would die opaquely at boot.`);
    if (sig.kind !== 'file' || fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8') !== BOOT_STUB_BODY) {
      die(`clean room boot stub ${rel} is not the inert placeholder in the final room (a later writer altered it).`);
    }
  }

  return { dir, stripped, proseRoots, allowed: allowedCanon, seededStubs, modules, escapes, shims, gitSeed, recordDir, spoolDir, manifestFile, entries, recorder, scratch: scratchRootInfo() };
}

/* ------------------------------------------------------------ the prompt */

function readRequirement(spec) {
  if (!spec.startsWith('@')) return spec;
  const f = path.resolve(spec.slice(1));
  if (!fs.existsSync(f)) die(`--requirement file not found: ${f}`);
  return fs.readFileSync(f, 'utf8');
}

/**
 * The DISCLOSED list of other tickets' hunks inside a mixed-state candidate's files:
 * ticket ids, paths and line ranges only — never a ticket's prose, never the fixer's
 * report (the room strips the board, so an id is an opaque label).
 */
export function mixedDisclosureText(m) {
  const d = m.disclosure || { files: [], hunks: [] };
  const rng = (start, len) => (len === 0 ? `after line ${start}` : len === 1 ? `line ${start}` : `lines ${start}-${start + len - 1}`);
  const lines = d.hunks.map((h) => `  ${h.path} ${rng(h.newStart, h.newLen)} (was ${rng(h.oldStart, h.oldLen)} at the last commit) — ${h.class === 'mixed' ? 'MIXED, partly' : 'NOT this change:'} ${h.owners.length ? h.owners.join(', ') : 'owner unknown'} (${h.basis})`);
  const perFile = d.files.map((f) => `  ${f.path}: ${f.hunks} changed hunk(s); ${f.unattributed} not attributed to any other ticket${f.claimants.length ? `; also claimed by ${f.claimants.join(', ')} (which lines are theirs is not recorded)` : ''}`);
  return `=== MIXED STATE — OTHER TICKETS' UNCOMMITTED WORK IN THESE FILES (disclosed) ===
These files were frozen exactly as they sit in a shared working tree where other
in-flight changes are also uncommitted, and your working copy is that whole tree.
The diff below is each of these files against the last commit, so it ALSO holds
other tickets' changes, which will be committed together with this one. Attack the
REQUIREMENT in this real mixed state; a hunk below is in scope only where it breaks
the requirement. Attribution is by matching each other ticket's own frozen copy, not
line-level provenance: an unlisted hunk may still be another ticket's, and a listed
one may also hold lines of the change under test.
Per file:
${perFile.join('\n') || '  (none)'}
Hunks attributed to other tickets (line numbers are in your working copy):
${lines.join('\n') || '  (none attributable — no other ticket\'s frozen change matches a hunk here)'}
`;
}

function composePrompt({ requirement, diff, truncated, fullDiffBytes, runs, tests, cwd, mixed = null }) {
  // FEAT-062 model-compliance hardening: a real clean-room verifier (run
  // 791c0681) ran all its probes through its own Bash — never ./vrun.mjs — and
  // answered in free markdown, so its (real) substance was INVALID and lost.
  // The recording rules are now the FIRST thing the verifier reads and the
  // LAST line of the prompt: unmissable, twice.
  return `You are an INDEPENDENT VERIFIER. Somebody changed some code and claims it now
satisfies the requirement below. Your job is to ATTEMPT TO BREAK THAT CLAIM by
running things — not to review it, not to double-check it, not to be fair to it.
You have deliberately NOT been shown the author's report, reasoning or
self-assessment; you have the requirement, the diff, the existing test code, and
a working copy you can run.

=== EVIDENCE RECORDING (mandatory — READ THIS FIRST) ===
A run recorder is at ./vrun.mjs in your working copy. Run EVERY evidence command
through it:
  node ./vrun.mjs <command and args>
The HARNESS executes the command itself, records {command, exit code, full
output} in its own memory, passes the output through to you, and prints a line
like:
  MANIFEST: 3fa9c2d41b07 sha256=9e107d9d372bb682 exit=1
The first token is the run id. You will CITE that id in your answer — you never
paste output: after you answer, the harness composes the evidence sections of
the final verdict ITSELF from its own records of the runs you cite. A run made
through your own shell instead of ./vrun.mjs DOES NOT EXIST as evidence — it is
as if you never ran it — and any output or explanation you type is discarded.
An answer in any shape other than the citation block at the end of this prompt
is INVALID and thrown away unread.

A checked-out working copy is at: ${cwd} (this is your working directory).
You MAY create scratch test files there and run them. Do not try to reach
outside it; there is nothing else you need.

=== REQUIREMENT (what the code must do) ===
${requirement.trim()}

=== HOW TO RUN THINGS ===
${runs.length ? runs.map((r) => `  ${r}`).join('\n') : '  (no command was supplied — work out how to run the code from the tree)'}

=== THE EXISTING TEST CODE (written by the author — re-run it, do not trust it) ===
${tests.length ? tests.map((t) => `--- ${t.rel} ---\n${t.body}`).join('\n\n') : '(no test file supplied)'}

${mixed ? `${mixed}\n` : ''}=== THE DIFF UNDER TEST ===${truncated ? `\n[NOTE: diff TRUNCATED at ${diff.length} of ${fullDiffBytes} bytes — judge only what is shown]` : ''}
${diff}

=== HOW TO FIND THE REAL DEFECT ===
The author's test passes; that is not evidence of much, because the author wrote
both the code and the test and could only test what they already thought of. The
defects that survive are the ones the FIXTURE does not exercise. So: work out
what shape of input the existing test never produces — a second page, an empty
set, a boundary count, two things at once, a failing dependency — construct it,
run it through ./vrun.mjs, and cite the run id.

${CITATION_CONTRACT}

FINAL REMINDER: every evidence command goes through \`node ./vrun.mjs …\`, and
your ENTIRE answer is the labelled citation block above — nothing else counts.`;
}

/* ------------------------------------------------------------------ main */

/**
 * CAUSE 2 (BUG-187/191, BUG-173, BUG-245 run 01a121c0, BUG-254 run 01a1371a,
 * ARCH-022): the openai (codex) verifier dispatch aborts ~10-12% of rounds for a
 * PROVIDER reason — the rolling quota window, moderation, the cyber filter
 * (classified `internal`), an overload, a rate-limit, auth expiry, a missing model,
 * or a network drop — none of which is a verdict. Historically that round was lost.
 * Given a finished dispatch result, return the provider-abort kind when the run
 * aborted for one of those reasons (so the caller falls back to anthropic), else
 * null. A dispatch that produced a verdict (exit 0) is NEVER an abort, whatever it
 * found; `timeout` / `transport` / `sandbox-preflight` are local, not a provider
 * reason, so they do not trigger the fallback either.
 */
const PROVIDER_ABORT_KINDS = new Set([
  'quota-window', 'rate-limited', 'overloaded', 'auth-expired', 'model-unavailable', 'network', 'internal',
]);
// BUG-273 r4 (P2): the dispatcher OWNS the failure kind and writes it to
// `meta.failureKind` on EVERY failure branch (anthropic, openai, and
// sandbox-preflight alike — dispatch.mjs). This reader reads ONLY that owned
// value; it never scrapes the dispatch child's stderr, which is a SHARED,
// unstructured channel that also carries the verifier's own taxonomy-laden
// reasoning (the two prior breaks — a provider-looking substring on a local
// timeout, r2; the first-match placeholder scrape, r3 — were both symptoms of
// reading a fact off a channel the dispatcher does not own; ARCH-010).
//
// Fail CLOSED: a verdict (code 0), a missing/unreadable meta (dispatch died
// before writing), or a kind outside PROVIDER_ABORT_KINDS — including the LOCAL
// kinds timeout/transport/sandbox-preflight/interrupted — all yield null ⇒ no
// anthropic fallback. A lost round is recoverable; a wrong auto-fallback masks a
// real local failure and mis-attributes the verifying provider.
//
// BUG-273 r5 (P2): ALSO require the meta's nonce to match the one THIS invocation
// passed to dispatch.mjs (--meta-nonce). dispatch.mjs stamps every meta write —
// including the init-invalidate it does before any provider work — with that
// nonce. A STALE meta left on a reused path by a PRIOR run (then a crash before
// this run wrote anything) carries an old/absent nonce, so it is rejected ⇒ null
// ⇒ no fallback. The r4 reader honoured `failureKind` from any present meta and
// failed closed only on ABSENT meta; a stale-but-present meta was the third P2
// break. `expectNonce` null (a caller that passed no nonce) ⇒ any present nonce
// mismatches ⇒ fail closed, which is the safe default.
export function providerAbortKind({ code, meta, nonce: expectNonce } = {}) {
  if (code === 0) return null; // a verdict (HOLDS or BROKEN) is not an abort
  if (!meta || meta.nonce == null || meta.nonce !== expectNonce) return null; // stale / absent / unstamped
  const k = meta.failureKind;
  return (typeof k === 'string' && PROVIDER_ABORT_KINDS.has(k)) ? k : null;
}

function resolveRange(repo, range) {
  if (range && /\.{2,3}/.test(range)) {
    const [base, head] = range.split(/\.{2,3}/);
    return { base: gitOk(repo, 'rev-parse', base).trim(), head: gitOk(repo, 'rev-parse', head).trim() };
  }
  const head = gitOk(repo, 'rev-parse', range || 'HEAD').trim();
  return { base: gitOk(repo, 'rev-parse', `${head}^`).trim(), head };
}

async function main() {
  if (git(opts.repo, 'rev-parse', '--git-dir').code !== 0) die(`not a git repo: ${opts.repo}`);
  const repo = gitOk(opts.repo, 'rev-parse', '--show-toplevel').trim();
  let base, head;
  let candidate = null;
  // FEAT-176: say LOUDLY, before anything is built, when a finished lane's work is
  // gone from the live tree — a verify on that tree would judge the wrong code.
  // Warning only; never changes this run's outcome.
  warnIfLaneWorkLost({ top: repo });
  // MIXED-STATE (no ticket of its own; see candidate-store freezeMixed): `--ticket T`
  // uses T's clean candidate when every file is CURRENT, and otherwise freezes T's files
  // AS THEY ARE in the shared tree, other tickets' hunks included and disclosed — never
  // claiming, never refused for ownership. The clean `--candidate` path is unchanged.
  let verifyMode = opts.candidate ? 'clean-candidate' : null;
  if (opts.ticket) {
    let why = ['--mixed was requested'];
    if (!opts.mixed) {
      let u;
      try { u = cleanCandidateUsable(repo, opts.ticket, opts.files); }
      catch (e) { die(e instanceof CandidateError ? `--ticket ${opts.ticket}: ${e.message}` : String(e?.stack || e)); }
      if (u.usable) { opts.candidate = u.hash; verifyMode = 'clean-candidate'; console.error(`  mode       clean candidate ${u.hash.slice(0, 12)} for ${opts.ticket} (every file CURRENT)`); }
      else why = u.reasons;
    }
    if (!opts.candidate) {
      let mm;
      try { mm = freezeMixed({ repo, id: opts.ticket, files: opts.files, why }); }
      catch (e) { die(e instanceof CandidateError ? `--ticket ${opts.ticket} (mixed-state freeze): ${e.message}${e.detail?.length ? `\n  ${e.detail.join('\n  ')}` : ''}` : String(e?.stack || e)); }
      opts.candidate = mm.hash; verifyMode = 'mixed-state';
      console.error(`  mode       MIXED-STATE for ${opts.ticket} — no clean diff (${why.join('; ')}); froze ${mm.files.length} file(s) as they sit in the shared tree, no ownership taken; ${mm.disclosure.hunks.length} other-ticket hunk(s) disclosed to the verifier`);
    }
  }
  if (opts.candidate) {
    // FEAT-170: the room is the candidate's own tree — HEAD at freeze + exactly the
    // frozen files, re-materialised from the STORE (never the live tree) and asserted
    // equal to the tree recorded at freeze. base..tree is then exactly those files.
    try { candidate = materializeCandidate(repo, opts.candidate); }
    catch (e) { die(e instanceof CandidateError ? `--candidate ${opts.candidate}: ${e.message}` : String(e?.stack || e)); }
    base = candidate.base;
    head = candidate.tree;
    // Plan review point 9: node_modules is copied from the LIVE repo. If another lane
    // changed the lockfile, the room would run dependencies the candidate does not
    // declare — refuse rather than verify against them silently.
    for (const lock of ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock']) {
      const inCand = spawnSync('git', ['-C', repo, 'cat-file', 'blob', `${head}:${lock}`], { encoding: 'buffer' });
      const livePath = path.join(repo, lock);
      const liveExists = fs.existsSync(livePath);
      if ((inCand.status ?? 1) !== 0 && !liveExists) continue;
      const same = (inCand.status ?? 1) === 0 && liveExists && Buffer.compare(inCand.stdout, fs.readFileSync(livePath)) === 0;
      if (!same) die(`--candidate: ${lock} in the candidate differs from the live repo's, so the node_modules this room would copy was not installed from the candidate's dependencies. Re-freeze after the lockfile settles (or include ${lock} in the candidate and install it).`);
    }
    const m = candidate.manifest;
    console.error(`  candidate ${m.ticket} ${m.hash.slice(0, 12)} — base ${m.base.slice(0, 12)} → tree ${m.tree.slice(0, 12)}, ${m.files.length} frozen file(s)${m.deps.length ? `, group with ${m.deps.map((d) => d.ticket).join(', ')}` : ''}; live-tree edits after the freeze cannot reach this room`);
  } else if (opts.workingTree) {
    console.error('  note       --working-tree hands the verifier EVERY in-flight ticket\'s code; use --ticket <TICKET> to verify only that ticket\'s files as they are (its candidate, else a mixed-tree freeze)');
    // FEAT-134: base = HEAD, head = the snapshot TREE sha (NOT the dangling commit
    // — a commit is gc-collectable, the tree is the durable id the range line and
    // any record then carries). git diff / git archive both accept a bare tree, so
    // the clean-room strip and the `clean room is NOT clean` guard run over the
    // snapshot exactly as they do over a committed rev. The real index is untouched.
    let snap;
    try { snap = snapshotWorkingTree(repo); }
    catch (e) { die(e instanceof Error ? e.message : String(e)); }
    base = snap.head;
    head = snap.tree;
    console.error(`  working-tree snapshot — HEAD ${snap.head.slice(0, 12)} → tree ${snap.tree.slice(0, 12)} (dangling commit ${snap.commit.slice(0, 12)}; real index untouched)`);
  } else {
    ({ base, head } = resolveRange(repo, opts.range));
  }

  // Build the clean room FIRST: the prose surface it strips is declared in the
  // revision under test (read out of the room's own copy), and that SAME surface
  // is what the diff below excludes — one source, never a second list (BUG-186).
  const room = await buildCleanroom(repo, head, { allowed: opts.allowInputs });

  // BUG-250 TEST SEAM — never active in a real run. When
  // CLAUDE_STATION_IV_CRASH_AFTER_ROOM is set, crash in the requested way right
  // after the room exists, so the verify suite can prove the crash-safe handlers
  // actually remove the room on an abnormal exit (throw / die / signal).
  if (process.env.CLAUDE_STATION_IV_CRASH_AFTER_ROOM) {
    const mode = process.env.CLAUDE_STATION_IV_CRASH_AFTER_ROOM;
    process.stderr.write(`IV-CRASH-SEAM room=${room.dir} record=${room.recordDir} spool=${room.spoolDir}\n`);
    if (mode === 'throw') throw new Error('crash seam: uncaught throw after room build');
    if (mode === 'die') die('crash seam: die() after room build', 7);
    if (mode === 'exit') process.exit(9);
    if (mode === 'hang') { await new Promise(() => {}); } // park until the test signals us
  }

  // THE DIFF HANDED TO THE VERIFIER (BUG-186), an ALLOW-LIST over byte-exact
  // paths driven by the SAME `makeIsDeclared` predicate the room strip uses.
  //   1. `git diff --name-only -z --no-renames` → the changed paths byte-exact
  //      (NUL, no quoting; renames decomposed to delete+add so BOTH sides show
  //      and DELETIONS are included).
  //   2. Filter in JS with the predicate → the ALLOWED changed paths.
  //   3. Emit the diff limited to those paths as `:(literal)` pathspecs, batched
  //      under ARG_MAX.
  //   4. THE GUARANTEE (round-4): a literal pathspec that names a path which is
  //      now a DIRECTORY also selects its descendants, so `src/widget` (a deleted
  //      file, declared) can drag in the ambient `src/widget/AGENTS.md`. So we do
  //      not trust pathspec semantics as the last line — we read the file list
  //      the diff ACTUALLY contains and ASSERT it is a subset of the declared
  //      set. A stray undeclared descendant is excluded by an explicit
  //      `:(exclude,literal)` and rebuilt once; if anything undeclared still
  //      remains, we FAIL LOUDLY rather than ship it. Any future pathspec
  //      surprise is then a hard error, never a leak.
  const isDeclared = makeIsDeclared({ proseRoots: room.proseRoots, allowed: room.allowed });
  // `--no-ext-diff --no-textconv` (round-5): the EMITTED patch must be git's own
  // internal diff, never a repo-configured `diff.external` / `.gitattributes` diff
  // driver / textconv filter — such a helper can re-expand a declared path and
  // emit content for UNDECLARED paths in the PATCH while `--name-only` (which does
  // not invoke it) still reports only the declared set, so the subset check would
  // pass a patch that leaks. Applied to EVERY diff invocation so the patch and the
  // checked name-list are produced identically.
  // `-c diff.submodule=short --submodule=short` (round-7): repo config
  // `diff.submodule=diff` INLINES a submodule's internal patch — board/ambient
  // prose from inside a changed submodule gitlink — which the `--name-only`
  // footing never reproduces, defeating the subset check. Force the short format
  // (a one-line "Subproject commit X..Y", never content) on every invocation.
  // `-c core.quotePath=false` keeps non-ASCII header paths byte-exact so the
  // patch-header backstop below does not false-positive on a declared edge name.
  const GIT_CFG = ['-c', 'core.quotePath=false', '-c', 'diff.submodule=short'];
  const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--submodule=short'];
  const nameOnly = spawnSync('git', ['-C', repo, ...GIT_CFG, 'diff', ...DIFF_FLAGS, '--name-only', '-z', '--no-renames', base, head], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  if ((nameOnly.status ?? 1) !== 0) die(`git diff --name-only failed in ${repo}: ${(nameOnly.stderr ? nameOnly.stderr.toString() : '').trim()}`);
  const changedPaths = (nameOnly.stdout ? nameOnly.stdout.toString('utf8') : '').split('\0').filter(Boolean);
  // Mixed state: the room is the whole shared tree (so the ticket's code boots with its
  // co-owners' companions), but the diff the verifier attacks is the ticket's own files.
  const mixedFiles = candidate?.manifest.mode === 'mixed' ? new Set(candidate.manifest.files.map((f) => f.path)) : null;
  const allowedPaths = changedPaths.filter(isDeclared).filter((p) => !mixedFiles || mixedFiles.has(p));
  if (!allowedPaths.length) {
    die(`range ${base.slice(0, 8)}..${head.slice(0, 8)} has no verifiable diff after excluding the board/methodology surface (${changedPaths.length} changed path(s), none the verifier may see) — nothing for the verifier to attack`);
  }
  // Run `git diff` (patch, or --name-only -z) over the allowed paths as
  // `:(literal)` pathspecs plus any explicit exclude specs, batched under ARG_MAX.
  const BATCH_BYTES = 100_000;
  const runDiff = (kind, excludeSpecs) => {
    const pos = allowedPaths.map((p) => `:(literal)${p}`);
    const bufs = [];
    for (let i = 0; i < pos.length;) {
      const batch = [];
      let bytes = 0;
      while (i < pos.length && (batch.length === 0 || bytes + Buffer.byteLength(pos[i]) + 1 < BATCH_BYTES)) {
        bytes += Buffer.byteLength(pos[i]) + 1; batch.push(pos[i]); i++;
      }
      const args = ['-C', repo, ...GIT_CFG, 'diff', ...DIFF_FLAGS, ...(kind === 'names' ? ['--name-only', '-z'] : []), '--no-renames', base, head, '--', ...batch, ...excludeSpecs];
      const r = spawnSync('git', args, { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
      if ((r.status ?? 1) !== 0) die(`git diff (allow-listed) failed in ${repo}: ${(r.stderr ? r.stderr.toString() : '').trim()}`);
      bufs.push(r.stdout || Buffer.alloc(0));
    }
    const out = Buffer.concat(bufs).toString('utf8');
    return kind === 'names' ? out.split('\0').filter(Boolean) : out;
  };
  let excludeSpecs = [];
  let fullDiff = runDiff('patch', excludeSpecs);
  let actualPaths = runDiff('names', excludeSpecs);
  let leaked = actualPaths.filter((p) => !isDeclared(p));
  if (leaked.length) {
    // A declared path is now a directory (file→dir) and its literal pathspec
    // prefix-matched an undeclared descendant. Exclude exactly those (few) and
    // rebuild once — bounded, so no ARG_MAX.
    excludeSpecs = leaked.map((p) => `:(exclude,literal)${p}`);
    fullDiff = runDiff('patch', excludeSpecs);
    actualPaths = runDiff('names', excludeSpecs);
    leaked = actualPaths.filter((p) => !isDeclared(p));
  }
  if (leaked.length) {
    die(`diff post-condition FAILED — the verifier's diff would contain undeclared path(s) after filtering: ${leaked.slice(0, 20).join(', ')}${leaked.length > 20 ? ` … (+${leaked.length - 20} more)` : ''}. Refusing to ship a diff that is not a subset of the declared surface (a pathspec surprise is a hard error, never a leak).`);
  }
  // BACKSTOP (round-7): judge the EMITTED patch's OWN headers, not only the
  // `--name-only` footing. With `--submodule=short` nothing is inlined, so these
  // equal the allowed set; if any format expands content past the allow-list (an
  // inlined submodule diff under `diff.submodule=diff`, a sub-diff section), its
  // header paths are undeclared and this fails CLOSED. `core.quotePath=false`
  // keeps non-ASCII header paths byte-exact so a declared edge name is not a
  // false positive.
  const allowedSet = new Set(allowedPaths.map(normRel));
  const patchPaths = new Set();
  for (const line of fullDiff.split('\n')) {
    let m;
    if ((m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line))) { patchPaths.add(m[1]); patchPaths.add(m[2]); }
    else if ((m = /^Submodule (\S+) /.exec(line))) { patchPaths.add(m[1]); }
  }
  const patchLeaked = [...patchPaths].filter((p) => { const n = normRel(p); return !allowedSet.has(n) && !isDeclared(n); });
  if (patchLeaked.length) {
    die(`diff post-condition FAILED — the EMITTED patch's own headers name undeclared path(s): ${patchLeaked.slice(0, 20).join(', ')}${patchLeaked.length > 20 ? ` … (+${patchLeaked.length - 20} more)` : ''}. A format that expands content past the allow-list (e.g. an inlined submodule diff) fails closed, never ships.`);
  }
  if (!fullDiff.trim()) die(`range ${base.slice(0, 8)}..${head.slice(0, 8)} produced an empty allow-listed diff — nothing for the verifier to attack`);
  const fullDiffBytes = Buffer.byteLength(fullDiff, 'utf8');
  const truncated = fullDiffBytes > opts.maxDiffBytes;
  // FEAT-170 round 2: a candidate is exactly what is under attack, so a verifier handed
  // a truncated candidate diff verifies only part of it (run 64ff5cb8 saw 60000 of 123317
  // bytes). Refuse loudly and name the size instead of truncating silently.
  if (candidate && truncated) die(`--candidate: the candidate's diff is ${fullDiffBytes} bytes, which exceeds --max-diff-bytes ${opts.maxDiffBytes}; a truncated diff hides part of the candidate from the verifier. Re-run with --max-diff-bytes ${Math.ceil(fullDiffBytes * 1.25 / 1000) * 1000} or more.`);
  const diff = truncated ? fullDiff.slice(0, opts.maxDiffBytes) : fullDiff;

  const tests = opts.testFiles.map((rel) => {
    const p = path.isAbsolute(rel) ? rel : path.join(repo, rel);
    if (!fs.existsSync(p)) die(`--test-file not found: ${p}`);
    return { rel: path.relative(repo, p) || path.basename(p), body: fs.readFileSync(p, 'utf8') };
  });

  // RECORD WHAT THE ROOM WAS GIVEN (BUG-120 criterion 3): the stripped surface,
  // the declared inputs, and the diff exclusions — written beside the manifest
  // the verdict already cites, so a verdict can be read against its own inputs.
  const roomManifest = {
    base, head,
    verifyMode: verifyMode ?? (opts.workingTree ? 'working-tree' : 'range'),
    candidate: candidate ? { hash: candidate.manifest.hash, ticket: candidate.manifest.ticket, mode: candidate.manifest.mode === 'mixed' ? 'mixed-state' : 'clean-candidate', deps: candidate.manifest.deps, files: candidate.manifest.files.map((f) => ({ path: f.path, owner: f.owner, sha256: f.sha256, deleted: f.deleted })), ...(candidate.manifest.mode === 'mixed' ? { disclosure: candidate.manifest.disclosure } : {}) } : null,
    proseRoots: room.proseRoots,
    ambientStripped: AMBIENT_INSTRUCTION_NAMES,
    allowedInputs: room.allowed,
    strippedLeaves: room.stripped,
    diffFilter: 'allow-list: makeIsDeclared() over byte-exact `git diff --name-only -z --no-renames` paths (no exclusion strings, no ARG_MAX, no quoting)',
    changedPaths: changedPaths.length,
    diffAllowList: allowedPaths,
  };
  try { fs.writeFileSync(path.join(room.recordDir, 'room-manifest.json'), JSON.stringify(roomManifest, null, 2)); }
  catch { /* the record dir is a human-auditable mirror; the run proceeds regardless */ }

  const prompt = composePrompt({
    requirement: readRequirement(opts.requirement),
    diff, truncated, fullDiffBytes, runs: opts.runs, tests, cwd: room.dir,
    mixed: candidate?.manifest.mode === 'mixed' ? mixedDisclosureText(candidate.manifest) : null,
  });

  if (opts.printPrompt) {
    // Seam for the clean-room test: prove the composed prompt carries no
    // methodology/board/routing payload, and show what was stripped.
    process.stderr.write(`scratch root: ${room.scratch.dir} (${room.scratch.source})${room.scratch.degraded ? ' — DEGRADED: this is a boot-wiped temp dir; set $' + SCRATCH_ENV : ''}\n${room.modules.fsCheck ? room.modules.fsCheck.message + '\n' : ''}clean room: ${room.dir}\nrecord dir: ${room.recordDir}\nprose roots: ${room.proseRoots.join(', ') || '(none declared)'}\nallowed inputs: ${room.allowed.join(', ') || '(none — the room was given only code, config and tests)'}\nstripped: ${room.stripped.length ? `${room.stripped.slice(0, 30).join(', ')}${room.stripped.length > 30 ? ` … (+${room.stripped.length - 30} more)` : ''}` : '(nothing present to strip)'}\ndiff: allow-list of ${allowedPaths.length}/${changedPaths.length} changed path(s) the verifier may see (byte-exact, predicate-filtered)\nroom manifest: ${path.join(room.recordDir, 'room-manifest.json')}\nboot stubs seeded: ${room.seededStubs.join(', ') || '(none needed)'}\nnode_modules: ${room.modules.mode}${room.modules.ms ? ` in ${room.modules.ms}ms` : ''} — NEVER a symlink into the live repo (BUG-112)\nescaping symlinks removed: ${room.escapes.length ? room.escapes.join(', ') : '(none)'}\nscratch git: ${room.gitSeed?.ok ? `seeded HEAD ${room.gitSeed.head.slice(0, 12)} (synthetic identity verify@example.invalid, no remote)` : `NOT seeded — ${room.gitSeed?.error ?? 'unknown'}`}\n`);
    process.stdout.write(prompt);
    // No dispatch will run against this room, so the recorder is done: stop the
    // heartbeat now, so a kept room's vrun sees a dead recorder at once rather
    // than waiting out the staleness window.
    room.recorder.close();
    if (!opts.keepCleanroom) {
      untrackScratch(room.dir); untrackScratch(room.recordDir);
      fs.rmSync(room.dir, { recursive: true, force: true });
      fs.rmSync(room.recordDir, { recursive: true, force: true });
    }
    process.exit(0);
  }

  console.error(`independent-verify — repo ${repo}`);
  console.error(`  range      ${base.slice(0, 12)}..${head.slice(0, 12)} (${fullDiffBytes} diff bytes${truncated ? `, truncated to ${opts.maxDiffBytes}` : ''})`);
  console.error(`  scratch    ${room.scratch.dir} (${room.scratch.source})${room.scratch.degraded ? ` — DEGRADED: a boot-wiped temp dir; set $${SCRATCH_ENV} to something persistent` : ''}`);
  if (room.modules.fsCheck) console.error(`  ${room.modules.fsCheck.ok ? 'reflink    ' : 'REFLINK LOST '}${room.modules.fsCheck.message}`);
  console.error(`  clean room ${room.dir}`);
  console.error(`  inputs     given: ${room.allowed.join(', ') || 'code, config and tests only (no board/methodology)'} — recorded in ${path.join(room.recordDir, 'room-manifest.json')}`);
  console.error(`  stripped   ${room.stripped.length} node(s)${room.stripped.length ? `: ${room.stripped.slice(0, 12).join(', ')}${room.stripped.length > 12 ? ` … (+${room.stripped.length - 12} more)` : ''}` : ' (nothing present to strip)'}`);
  console.error(`  diff       allow-list ${allowedPaths.length}/${changedPaths.length} changed path(s) the verifier may see — board/methodology excluded by predicate, at any depth, byte-exact (BUG-186)`);
  console.error(`  boot stubs ${room.seededStubs.join(', ') || '(none needed)'} (inert placeholders so the stripped server can boot)`);
  console.error(`  node_modules ${room.modules.mode}${room.modules.ms ? ` in ${room.modules.ms}ms` : ''} — copied, never linked, so nothing in the room can write into the live repo (BUG-112)`);
  console.error(`  scratch git  ${room.gitSeed?.ok ? `seeded (HEAD ${room.gitSeed.head.slice(0, 12)}, synthetic identity, no remote) — git-dependent harnesses run directly in the room` : `NOT seeded (${room.gitSeed?.error ?? 'unknown'}) — a harness that re-runs git will fail`}`);
  if (room.escapes.length) console.error(`  contained  removed ${room.escapes.length} symlink(s) pointing OUT of the clean room: ${room.escapes.join(', ')}`);
  console.error(`  verifier   ${opts.provider}${opts.model ? `/${opts.model}` : ''} via dispatch.mjs (author-provider ${opts.authorProvider}${opts.provider === opts.authorProvider ? ' — SAME provider, decorrelation reduced' : ' → cross-provider'})`);

  const runDispatch = (promptText, resumeId, metaName) => new Promise((res) => {
    const metaFile = path.join(room.recordDir, metaName);
    // BUG-273 r5 (P2): a fresh freshness token per attempt. dispatch.mjs stamps
    // it into every meta write (init-invalidate + the terminal write); the reader
    // (providerAbortKind) honours a failureKind only when meta.nonce matches THIS.
    // So a crash-before-write that left a stale meta on a reused path cannot be
    // mis-read as a provider abort — the stale file carries a different nonce.
    const metaNonce = randomUUID();
    // FEAT-062 closing finding 5 (2026-08-11): Linux caps ONE argv string at
    // MAX_ARG_STRLEN (131072 bytes) — a large prompt (big --max-diff-bytes)
    // passed positionally killed the spawn with E2BIG before anything ran.
    // Oversized prompts travel over stdin end-to-end (dispatch --prompt-stdin
    // → claude's stdin); small prompts keep the argv path unchanged.
    // Neutralise any NUL byte in the payload (illegal in argv → ERR_INVALID_ARG_VALUE;
    // also unsafe downstream). See argvSafePrompt above for the full rationale.
    const safePrompt = argvSafePrompt(promptText);
    const ARGV_SAFE_BYTES = 100_000;
    const viaStdin = Buffer.byteLength(safePrompt, 'utf8') > ARGV_SAFE_BYTES;
    const child = spawn(process.execPath, [
      DISPATCH,
      '--provider', opts.provider,
      ...(opts.model ? ['--model', opts.model] : []),
      '--cwd', room.dir,
      '--sandbox', 'workspace-write', // the verifier MUST be able to write and run a test
      // …and to EXECUTE it: `acceptEdits` alone auto-approves writes but not Bash,
      // which turned the first real verification run into an armchair review
      // ("could not be run in non-interactive mode"). The blast radius is the
      // throwaway clean room, which is the only tree this dispatch is pointed at.
      '--allow-tools', 'Bash Read Write Edit Glob Grep',
      '--timeout-min', String(opts.timeoutMin),
      '--meta-out', metaFile,
      '--meta-nonce', metaNonce,
      ...(resumeId ? ['--resume', resumeId] : []),
      ...(viaStdin ? ['--prompt-stdin'] : ['--', safePrompt]),
      // Through the ONE chokepoint (BUG-273 r2 P3, r3 scope): honest-case
      // decorrelation hygiene — the verifier's git use rooted in the room (no `-C`)
      // must NOT inherit GIT_DIR/GIT_ALTERNATE_OBJECT_DIRECTORIES, so `git log`/`show`
      // sees room state, not real-repo history. This is correctness, NOT a
      // containment wall: a verifier can still read the live repo by absolute path
      // or `git -C <realrepo>` (out of scope). Non-git env (provider auth/config) is
      // preserved.
    ], { stdio: [viaStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: buildRoomGitEnv({ ORCHARD_LANE_SNAPSHOT: '0' }) }); // FEAT-176: the clean room is throwaway
    _activeDispatchChild = child; // BUG-250: a signal handler kills it before deleting the room it runs in
    child.once('exit', () => { if (_activeDispatchChild === child) _activeDispatchChild = null; });
    if (viaStdin) {
      child.stdin.on('error', () => { /* EPIPE if dispatch dies early; exit handler reports */ });
      child.stdin.end(safePrompt);
    }
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; process.stderr.write(d); });
    const done = (code) => {
      let meta = null;
      // A partial/truncated meta (another process mid-write, disk full) throws in
      // JSON.parse → meta stays null → providerAbortKind fails closed. The nonce
      // this attempt passed travels with the result so the reader can match it.
      try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { /* unparsable ⇒ meta null ⇒ fail closed */ }
      res({ code, stdout, stderr, meta, nonce: metaNonce });
    };
    child.once('error', (e) => { console.error(`dispatch not runnable: ${e.message}`); done(-1); });
    child.once('exit', (c) => done(c ?? 1));
  });

  let active = await runDispatch(prompt, null, 'dispatch-meta-1.json');

  // CAUSE 2: an openai dispatch that ABORTED for a PROVIDER reason (quota window,
  // moderation/cyber filter → internal, overload, rate-limit, auth, model, network)
  // — not a verdict — falls back to anthropic in THIS SAME invocation, so the round
  // is not wasted. The cross-provider DEFAULT (author anthropic → verifier openai)
  // is UNCHANGED; this is a recovery path. The clean room, recorder and prompt are
  // reused as-is. A fallback where author is also anthropic reduces decorrelation —
  // a same-provider verdict beats a lost round, and the record names the provider.
  let fellBackFrom = null;
  if (opts.provider === 'openai') {
    const abortKind = providerAbortKind(active);
    if (abortKind) {
      console.error(`  provider   openai dispatch ABORTED [${abortKind}] (a provider reason, not a verdict) — falling back to anthropic in the same invocation; same clean room, recorder and prompt${opts.authorProvider === 'anthropic' ? ' (NOTE: author is anthropic too → decorrelation reduced this round)' : ''}`);
      fellBackFrom = 'openai';
      opts.provider = 'anthropic';
      active = await runDispatch(prompt, null, 'dispatch-meta-openai-fallback.json');
    }
  }

  let cite = active.code === 0 ? parseCitationReply(active.stdout) : null;
  let reprompted = false;

  // FEAT-062 model-compliance mitigation: a verifier that answers in free
  // prose gets ONE corrective re-prompt — same session (its investigation is
  // preserved), same clean room, same recorder, same round — before the
  // answer is counted. A real run (791c0681) did exactly this: probes through
  // its own Bash, verdict in markdown; the substance was real and was lost.
  const sessionForReprompt = active.meta?.sessionId ?? null;
  if (cite && cite.violations.length && active.code === 0) {
    if (opts.provider === 'anthropic' && sessionForReprompt) {
      console.error('  compliance  reply is not a well-formed citation block — ONE corrective re-prompt (resuming the same verifier session; the round counts after it resolves)');
      // BUG-097: make compliance COPY-PASTE. The verifier's real failures are
      // shape, not effort, so the corrective message lists the run ids the
      // harness has ALREADY recorded for this session — the verifier only has
      // to slot them into FIXER-TEST/ADVERSARIAL and write the prose. (If it
      // recorded nothing, the list says so, which is itself the diagnosis.)
      const recorded = room.entries.map((e) => `  run ${e.id}  (exit ${e.exit})  ${e.cmd}`).join('\n');
      const corrective = `Your previous answer was DISCARDED: it was not a citation block, so nothing
in it counts — not as a pass, not as a fail. Evidence exists ONLY as runs the
harness recorded through ./vrun.mjs in ${room.dir}.

Runs the harness has recorded for you so far (cite these by id):
${recorded || '  (none — you have not recorded a single run through ./vrun.mjs yet)'}
If your evidence commands did not go through \`node ./vrun.mjs <cmd>\`, re-run
them through it NOW and note the new MANIFEST ids it prints.
Then answer with ONLY the labelled citation block — no markdown, no headings,
no explanation outside the labels. The case-slug after ADVERSARIAL: must be a
SHORT tag (letters/digits/hyphen, ≤40 chars), e.g. \`ADVERSARIAL: empty-input run <id>\`:

${CITATION_CONTRACT}`;
      const second = await runDispatch(corrective, sessionForReprompt, 'dispatch-meta-2.json');
      reprompted = true;
      if (second.code === 0) { active = second; cite = parseCitationReply(second.stdout); }
      else console.error('  compliance  corrective re-prompt dispatch failed — judging the original reply');
    } else {
      console.error(`  compliance  reply is not a well-formed citation block and no re-prompt is possible (${opts.provider === 'anthropic' ? 'no session id recorded' : 'resume is anthropic-only'})`);
    }
  }

  // The manifest is the harness's own IN-MEMORY record of what its recorder
  // server actually executed (outputs attached) — never re-read from disk,
  // which the verifier's process could have edited. An empty list is an EMPTY
  // manifest, not a skip: artifact checking is always on for a live run, so a
  // verifier that recorded nothing has, by definition, tested nothing.
  room.recorder.close();
  const manifest = room.entries;

  if (!opts.keepCleanroom) {
    untrackScratch(room.dir); untrackScratch(room.recordDir);
    fs.rmSync(room.dir, { recursive: true, force: true });
    fs.rmSync(room.recordDir, { recursive: true, force: true });
  } else console.error(`  clean room KEPT at ${room.dir} (manifest at ${room.manifestFile})`);

  const { code, stdout, stderr } = active;
  const runId = active.meta?.sessionId ??
    (/thread\s+([A-Za-z0-9][\w.:-]{5,})\s+started/.exec(stderr)?.[1] ??
     /session\s+([A-Za-z0-9][\w.:-]{5,})/.exec(stderr)?.[1] ?? null);

  if (code !== 0) {
    const tax = stderr.split('\n').find((l) => l.includes('dispatch failed [')) ?? '';
    console.log('VERDICT-CONTRACT: INVALID — the verification dispatch itself failed, so nothing was verified.');
    console.log(`  VIOLATION: dispatch exited ${code}: ${tax.trim() || 'no error detail'}`);
    console.log('  (fail-closed: an unverifiable change is not a verified change)');
    process.exit(3);
  }

  console.error(`  manifest   ${manifest.length} recorded run(s)${reprompted ? '; compliance re-prompt used (1 of 1)' : ''}`);
  if (fellBackFrom) console.error(`  provider   verdict produced by anthropic after a ${fellBackFrom} provider abort (cause-2 fallback) — recorded as the verifying provider below`);
  // BUG-097: a citation that was recorded despite an off-shape label/prose is
  // still a real verdict — surface the cosmetic fix-ups honestly rather than
  // discarding the dispatch over them.
  if (cite?.normalized?.length) {
    console.error(`  format-normalized (${cite.normalized.length}): ${cite.normalized.join(' | ')}`);
  }

  // HARNESS-EMITTED EVIDENCE (the 0322f40e structural pivot): the verifier's
  // reply is a CITATION BLOCK, never a verdict document. Fifteen consecutive
  // closing clean-room runs proved that a text-shaped evidence contract is
  // attacker-controlled input and parsing it is an unwinnable arms race — so
  // the final verdict's evidence sections are composed HERE, from this
  // process's own in-memory records of what its recorder executed. The reply
  // itself is never echoed: nothing the verifier types can appear in the
  // report as evidence, in any wording, because evidence text no longer
  // passes through the verifier at all.
  const bail = (headline, violations) => {
    console.log(`VERDICT-CONTRACT: INVALID — ${headline}`);
    for (const viol of violations) console.log(`  VIOLATION: ${viol}`);
    console.log('  (the reply is not echoed: evidence exists only as harness records, and an answer that does not cite them does not count)');
    if (opts.verdictOut) fs.writeFileSync(opts.verdictOut, [`INVALID — ${headline}`, ...violations.map((x) => `- ${x}`)].join('\n') + '\n');
    process.exit(3);
  };
  if (cite.violations.length) bail('the verifier\'s answer is not a well-formed citation of recorded runs.', cite.violations);

  const composed = composeVerdict(cite, { manifest, knownRuns: opts.runs });
  if (composed.violations.length) bail('the citations do not check out against the harness\'s own records.', composed.violations);

  // Belt-and-suspenders: the composed verdict must itself satisfy the full
  // executed-evidence contract (every specimen ratchet stays live). It is
  // harness-authored, so a failure here is a composition bug — fail closed.
  const v = validateVerdict(composed.text, { manifest, knownRuns: opts.runs });
  if (!v.valid) bail('the harness-composed verdict failed its own contract (composition self-check; fail-closed).', v.violations);

  if (opts.verdictOut) fs.writeFileSync(opts.verdictOut, composed.text);
  console.log(composed.text.trim());
  console.log('');
  const exit = reportValidation(v);
  if (v.valid) {
    console.log('');
    // BUG-225 r3: proof is a TYPED entry written by the board tool — a pasted
    // prose `Verified-by:` line counts for nothing.
    console.log('Record it on the ticket (a typed entry naming the dispatch run, which an');
    console.log('in-process Task subagent cannot produce):');
    console.log(`  node scripts/board-tool.mjs verified --id=<TICKET> --provider=${opts.provider}` +
      `${opts.model ? ` --model=${opts.model}` : ''} --run=${runId ?? 'UNKNOWN-RUN-ID'} --verdict=${String(v.verdict ?? '').toUpperCase()}` +
      `${candidate ? ` --candidate=${candidate.manifest.hash}` : ''}`);
    if (candidate) console.log(`  (bound to ${candidate.manifest.mode === 'mixed' ? 'MIXED-STATE' : 'clean'} candidate ${candidate.manifest.hash.slice(0, 12)}: a later edit to its files makes a new candidate, which needs its own verdict; board-tool records the mode from the candidate itself)`);
    if (!runId) console.log('  WARNING: the dispatch printed no run id — the board tool will refuse the command above.');
  }
  process.exit(exit);
}

if (IS_ENTRY) {
  await main();
}
