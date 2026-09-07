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
 *     [--test-file <path>]... [--author-provider anthropic|openai] \
 *     [--provider anthropic|openai] [--model <m>] [--timeout-min <n>]
 *     [--keep-cleanroom] [--print-prompt] [--verdict-out <file>]
 *   node scripts/independent-verify.mjs --check-only <verdict-file>
 *
 * By default only COMMITTED work is visible (range → rev-parse → git archive).
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
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DISPATCH = path.join(ROOT, 'scripts', 'dispatch.mjs');
// Run the CLI only when invoked directly; importing the module (e.g. the NUL-safety
// verify script pulling in argvSafePrompt) must NOT arg-parse, validate or dispatch.
const IS_ENTRY = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

const USAGE = `usage: node scripts/independent-verify.mjs --requirement <text|@file>
         [--repo <dir>] [--range <A..B|rev> | --working-tree] [--run "<command>"]...
         [--test-file <path>]... [--author-provider anthropic|openai]
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
  else if (a === '--requirement') opts.requirement = take();
  else if (a === '--run') opts.runs.push(take());
  else if (a === '--test-file') opts.testFiles.push(take());
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
  if (opts.authorProvider !== 'anthropic' && opts.authorProvider !== 'openai') die('--author-provider must be anthropic|openai');
  if (opts.provider && opts.provider !== 'anthropic' && opts.provider !== 'openai') die('--provider must be anthropic|openai');
  // Cross-provider by default: decorrelated blind spots (ROUTING.md).
  if (!opts.provider) opts.provider = opts.authorProvider === 'anthropic' ? 'openai' : 'anthropic';
  if (!Number.isFinite(opts.timeoutMin) || opts.timeoutMin <= 0) die('--timeout-min must be positive');
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
 * Ambient-instruction surface that agent CLIs auto-discover, plus this
 * project's own methodology/board. Removed from the clean room so the verifier
 * cannot inherit our framing even by reading the tree it is testing.
 */
const CONTAMINATION = [
  'CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'AGENT.md', '.cursorrules',
  '.claude', '.codex', '.github/copilot-instructions.md',
  'docs/prompts', 'docs/bugs', 'docs/DEPLOY-CONTEXT.md',
];

/**
 * Boot stubs. Stripping `docs/prompts` (above) is correct — the verifier must
 * not read our methodology — but the SERVER refuses to boot without it:
 * `seedTemplates()` (src/server/templates.ts) reads exactly these six files at
 * startup and throws ENOENT if any is missing, which surfaces to the verifier
 * only as the opaque `server never healthy`. Every UI/server-backed
 * verification used to pay this tax by hand (a stub-creation one-liner smuggled
 * into the requirement text and `--run`). So the clean room seeds the minimum
 * set ITSELF, right after stripping.
 *
 * SAFETY PROPERTY (the whole point): each stub is an INERT placeholder, NOT a
 * copy of the real file. The reason we strip is that the verifier must not
 * inherit our framing; seeding real content back would defeat that entirely.
 * The server only needs these paths to EXIST and be readable — it does not care
 * what they say — so a one-line placeholder satisfies the boot path while
 * transmitting zero methodology. Keep this list in sync with `seedTemplates`'s
 * seed sources; if that set ever needs real content to boot, stop and rethink
 * rather than seeding real prose here.
 */
const BOOT_STUBS = [
  'docs/prompts/WORKING_AGREEMENT.md',
  'docs/prompts/WORKING_AGREEMENT.v2.md',
  'docs/prompts/patterns/MANAGER_SUBAGENT_TREE.md',
  'docs/prompts/patterns/INDEX_TABLE_ROUTER.md',
  'docs/prompts/patterns/RAW_CURATED_MEMORY_SPLIT.md',
  'docs/prompts/patterns/GO_NO_GO_PREFLIGHT.md',
];
const BOOT_STUB_BODY =
  'Clean-room placeholder — independent-verify.mjs.\n\n' +
  'The real file was removed as CONTAMINATION so the verifier cannot inherit\n' +
  'this project\'s methodology or board prose. This inert placeholder exists\n' +
  'ONLY so the stripped server can boot (seedTemplates reads this path). It\n' +
  'deliberately carries no real content.\n';

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

function buildCleanroom(repo, rev) {
  const dir = mkdtempScratch('cleanroom-verify-');
  const tar = spawnSync('sh', ['-c', `git -C ${JSON.stringify(repo)} archive ${JSON.stringify(rev)} | tar -x -C ${JSON.stringify(dir)}`], { encoding: 'utf8' });
  if ((tar.status ?? 1) !== 0) die(`could not export ${rev} into a clean room: ${(tar.stderr || '').trim()}`);

  const stripped = [];
  for (const rel of CONTAMINATION) {
    const p = path.join(dir, rel);
    if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); stripped.push(rel); }
  }
  // Belt-and-braces: anything named like an ambient instruction file anywhere
  // in the exported tree (a nested CLAUDE.md would be read on entry too).
  const leftovers = [];
  const AMBIENT = /^(CLAUDE(\.local)?\.md|AGENTS?\.md)$/i;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') walk(full); continue; }
      if (AMBIENT.test(e.name)) { fs.rmSync(full, { force: true }); stripped.push(path.relative(dir, full)); }
    }
  })(dir);
  (function scan(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (e.name !== 'node_modules') scan(full); continue; }
      if (AMBIENT.test(e.name)) leftovers.push(path.relative(dir, full));
    }
  })(dir);
  if (leftovers.length) die(`clean room is NOT clean — ambient instruction files remain: ${leftovers.join(', ')}`);

  // Re-seed the minimum boot stubs the strip just removed (see BOOT_STUBS).
  // Inert placeholders only — never the real content — so the server can start
  // without the verifier ever reading our methodology.
  const seededStubs = [];
  for (const rel of BOOT_STUBS) {
    const p = path.join(dir, rel);
    if (fs.existsSync(p)) continue; // survived the strip (unexpected, but respect it)
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, BOOT_STUB_BODY);
      seededStubs.push(rel);
    } catch (err) {
      die(`clean room could not seed the boot stub ${rel} (the server cannot start without it — seedTemplates reads it): ${(err instanceof Error ? err.message : String(err))}`);
    }
  }

  // Dependencies: a verifier that cannot run the tests cannot produce evidence.
  const modules = provisionModules(repo, dir);

  // …and then: NOTHING in this room may point OUT of it (see auditSymlinks).
  const escapes = auditSymlinks(dir);

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
  const manifestFile = path.join(recordDir, 'manifest.jsonl');
  const spoolDir = path.join(dir, '.vrun');
  const reqDir = path.join(spoolDir, 'req');
  const resDir = path.join(spoolDir, 'res');
  fs.mkdirSync(reqDir, { recursive: true });
  fs.mkdirSync(resDir, { recursive: true });
  const entries = []; // authoritative, in-memory, outputs attached
  const aliveFile = path.join(spoolDir, 'alive');
  const MAX_OUTPUT = 64 * 1024 * 1024;
  const handled = new Set();
  // LIVENESS beat: the socket recorder's death was instantly visible to the
  // client (connect → ECONNREFUSED). The file spool restores that: this process
  // rewrites `.vrun/alive` with a fresh timestamp every poll tick, and vrun
  // treats a STALE heartbeat as "recorder dead" (exit 2), so a verifier can
  // never sit forever against a crashed harness NOR forge a record around one.
  // Execution is ASYNC (not spawnSync) precisely so the beat keeps ticking
  // while a long command runs — otherwise a blocking exec would look like death.
  const beat = () => { try { fs.writeFileSync(aliveFile, String(Date.now())); } catch { /* spool gone */ } };
  const respond = (file, obj) => {
    // Atomic publish: write a temp then rename, so the verifier's poller never
    // reads a half-written response.
    const tmp = path.join(resDir, `.${file}.tmp`);
    try { fs.writeFileSync(tmp, JSON.stringify(obj)); fs.renameSync(tmp, path.join(resDir, file)); }
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
  const recorder = { close: () => { clearInterval(poll); try { fs.rmSync(aliveFile, { force: true }); } catch { /* gone */ } } };

  fs.writeFileSync(path.join(dir, 'vrun.mjs'), `#!/usr/bin/env node
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
`, { mode: 0o755 });

  return { dir, stripped, seededStubs, modules, escapes, recordDir, manifestFile, entries, recorder, scratch: scratchRootInfo() };
}

/* ------------------------------------------------------------ the prompt */

function readRequirement(spec) {
  if (!spec.startsWith('@')) return spec;
  const f = path.resolve(spec.slice(1));
  if (!fs.existsSync(f)) die(`--requirement file not found: ${f}`);
  return fs.readFileSync(f, 'utf8');
}

function composePrompt({ requirement, diff, truncated, fullDiffBytes, runs, tests, cwd }) {
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

=== THE DIFF UNDER TEST ===${truncated ? `\n[NOTE: diff TRUNCATED at ${diff.length} of ${fullDiffBytes} bytes — judge only what is shown]` : ''}
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
  if (opts.workingTree) {
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

  const fullDiff = gitOk(repo, 'diff', base, head);
  if (!fullDiff.trim()) die(`range ${base.slice(0, 8)}..${head.slice(0, 8)} has an empty diff — nothing to verify`);
  const fullDiffBytes = Buffer.byteLength(fullDiff, 'utf8');
  const truncated = fullDiffBytes > opts.maxDiffBytes;
  const diff = truncated ? fullDiff.slice(0, opts.maxDiffBytes) : fullDiff;

  const tests = opts.testFiles.map((rel) => {
    const p = path.isAbsolute(rel) ? rel : path.join(repo, rel);
    if (!fs.existsSync(p)) die(`--test-file not found: ${p}`);
    return { rel: path.relative(repo, p) || path.basename(p), body: fs.readFileSync(p, 'utf8') };
  });

  const room = buildCleanroom(repo, head);
  const prompt = composePrompt({
    requirement: readRequirement(opts.requirement),
    diff, truncated, fullDiffBytes, runs: opts.runs, tests, cwd: room.dir,
  });

  if (opts.printPrompt) {
    // Seam for the clean-room test: prove the composed prompt carries no
    // methodology/board/routing payload, and show what was stripped.
    process.stderr.write(`scratch root: ${room.scratch.dir} (${room.scratch.source})${room.scratch.degraded ? ' — DEGRADED: this is a boot-wiped temp dir; set $' + SCRATCH_ENV : ''}\n${room.modules.fsCheck ? room.modules.fsCheck.message + '\n' : ''}clean room: ${room.dir}\nrecord dir: ${room.recordDir}\nstripped: ${room.stripped.join(', ') || '(nothing present to strip)'}\nboot stubs seeded: ${room.seededStubs.join(', ') || '(none needed)'}\nnode_modules: ${room.modules.mode}${room.modules.ms ? ` in ${room.modules.ms}ms` : ''} — NEVER a symlink into the live repo (BUG-112)\nescaping symlinks removed: ${room.escapes.length ? room.escapes.join(', ') : '(none)'}\n`);
    process.stdout.write(prompt);
    // No dispatch will run against this room, so the recorder is done: stop the
    // heartbeat now, so a kept room's vrun sees a dead recorder at once rather
    // than waiting out the staleness window.
    room.recorder.close();
    if (!opts.keepCleanroom) {
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
  console.error(`  stripped   ${room.stripped.join(', ') || '(nothing present to strip)'}`);
  console.error(`  boot stubs ${room.seededStubs.join(', ') || '(none needed)'} (inert placeholders so the stripped server can boot)`);
  console.error(`  node_modules ${room.modules.mode}${room.modules.ms ? ` in ${room.modules.ms}ms` : ''} — copied, never linked, so nothing in the room can write into the live repo (BUG-112)`);
  if (room.escapes.length) console.error(`  contained  removed ${room.escapes.length} symlink(s) pointing OUT of the clean room: ${room.escapes.join(', ')}`);
  console.error(`  verifier   ${opts.provider}${opts.model ? `/${opts.model}` : ''} via dispatch.mjs (author-provider ${opts.authorProvider}${opts.provider === opts.authorProvider ? ' — SAME provider, decorrelation reduced' : ' → cross-provider'})`);

  const runDispatch = (promptText, resumeId, metaName) => new Promise((res) => {
    const metaFile = path.join(room.recordDir, metaName);
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
      ...(resumeId ? ['--resume', resumeId] : []),
      ...(viaStdin ? ['--prompt-stdin'] : ['--', safePrompt]),
    ], { stdio: [viaStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    if (viaStdin) {
      child.stdin.on('error', () => { /* EPIPE if dispatch dies early; exit handler reports */ });
      child.stdin.end(safePrompt);
    }
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; process.stderr.write(d); });
    const done = (code) => {
      let meta = null;
      try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { /* stderr scrape fallback below */ }
      res({ code, stdout, stderr, meta });
    };
    child.once('error', (e) => { console.error(`dispatch not runnable: ${e.message}`); done(-1); });
    child.once('exit', (c) => done(c ?? 1));
  });

  let active = await runDispatch(prompt, null, 'dispatch-meta-1.json');
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
    console.log('Paste this into the ticket (it names a dispatch run, which an in-process');
    console.log('Task subagent cannot produce):');
    console.log(formatVerifiedBy({
      provider: opts.provider, model: opts.model, verdict: v.verdict,
      runId: runId ?? 'UNKNOWN-RUN-ID',
    }));
    if (!runId) console.log('  WARNING: the dispatch printed no run id — the line above will NOT pass board:check.');
  }
  process.exit(exit);
}

if (IS_ENTRY) {
  await main();
}
