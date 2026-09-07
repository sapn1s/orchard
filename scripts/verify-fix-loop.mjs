#!/usr/bin/env node
/**
 * verify-fix-loop.mjs — FEAT-062: the verify→fix loop.
 *
 * Roles per task, with deliberately DIFFERENT lifetimes:
 *   - FIXER: a durable thread. One anthropic session, resumed across rounds
 *     (dispatch.mjs --resume → `claude -p --resume`), so its accumulated
 *     context — code paths, dead ends already explored — is not thrown away.
 *   - VERIFIER: ephemeral and clean-room, EVERY round. A fresh dispatch
 *     through scripts/independent-verify.mjs; no memory of prior rounds, no
 *     exposure to the fixer's rebuttals. Persisting a verifier would let it
 *     converge with the fixer — the exact thing this design prevents.
 *
 * FEAT-061's inherited lessons, honored structurally:
 *   - Findings relay VERBATIM (the harness-composed verdict text, never this
 *     script's paraphrase — paraphrase reintroduces framing contamination).
 *   - ROUND CAP: 15 consecutive clean-room rounds each broke the then-current
 *     contract; unbounded verifier-chasing DIVERGES. Cap + an honest
 *     IN-PROGRESS (CAPPED, exit 4) is a designed outcome, not a failure mode.
 *   - INVALID verdicts are never relayed (cross-provider review finding #3):
 *     there is nothing trustworthy to relay — the round is recorded as a
 *     verifier failure and the next round retries with a fresh verifier.
 *
 * STALENESS GATE (the ticket's founding objection, made mechanical): the unit
 * of identity is the SNAPSHOT — a dangling temp-index commit of the working
 * tree (untracked included, .gitignored excluded), identified by its TREE sha.
 * Immediately before every relay the repo is re-fingerprinted; if the tree
 * moved relative to what was just verified, the moved paths are intersected
 * with (the fixer's touched files ∪ the verify diff's files) and the relay
 * OPENS with a re-orientation preamble naming exactly those paths — or, when
 * nothing relevant moved, says so explicitly. Never silent. (Cross-provider
 * review findings #4/#5/#6/#7: HEAD comparison alone misses working-tree
 * movement, mid-verify movement, and mislabels the fixer's output identity.)
 *
 * PROVIDER POLICY (ROUTING: the openai side is SCARCE): bulk rounds run on
 * anthropic; ONE cross-provider verify is reserved for the FINAL verdict —
 * after a bulk round HOLDS. If the openai window is exhausted (`quota-window`)
 * the final verify degrades to anthropic and the degradation is RECORDED.
 *
 * ARCH-002 (declared lifetime at dispatch): every dispatch this loop makes is
 * `lifetime: "turn"` — a foreground child of this process, dead when the loop
 * ends — declared in the state record, never inferred. The state file itself
 * is ADVISORY bookkeeping: a resumed/killed loop re-verifies rather than
 * trusting the file's last verdict.
 *
 * Usage:
 *   node scripts/verify-fix-loop.mjs --requirement <text|@file> --run "<cmd>"
 *     [--repo <dir>] [--base <rev>] [--test-file <p>]... [--max-rounds <n=4>]
 *     [--bulk-provider anthropic] [--bulk-model <m>]
 *     [--final-provider openai] [--final-model <m>] [--no-final-cross]
 *     [--fixer-model <m>] [--fresh-fixer] [--timeout-min <n=15>]
 *     [--state <file>] [--force-lock]
 *
 * Exit codes: 0 = VERIFIED (final verdict VALID+HOLDS), 4 = round cap reached
 * (honest IN-PROGRESS; per-round table printed), 2 = usage/infra error.
 *
 * Test seams (spawned WITHOUT a shell — review finding #12):
 *   CLAUDE_STATION_VFL_VERIFY_BIN    path to an independent-verify stand-in
 *   CLAUDE_STATION_VFL_DISPATCH_BIN  path to a dispatch stand-in
 *
 * This script NEVER commits, never pushes, never edits the repo itself; only
 * the fixer dispatch writes, and only in the repo it is pointed at.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotWorkingTree } from './lib/tree-snapshot.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const VERIFY_BIN = process.env.CLAUDE_STATION_VFL_VERIFY_BIN || path.join(ROOT, 'scripts', 'independent-verify.mjs');
const DISPATCH_BIN = process.env.CLAUDE_STATION_VFL_DISPATCH_BIN || path.join(ROOT, 'scripts', 'dispatch.mjs');

const USAGE = `usage: node scripts/verify-fix-loop.mjs --requirement <text|@file> --run "<cmd>"
         [--repo <dir>] [--base <rev>] [--test-file <p>]... [--max-rounds <n=4>]
         [--bulk-provider anthropic] [--bulk-model <m>]
         [--final-provider openai] [--final-model <m>] [--no-final-cross]
         [--fixer-model <m>] [--fresh-fixer] [--timeout-min <n=15>]
         [--state <file>] [--force-lock]`;

function die(msg, code = 2) {
  process.stderr.write(`verify-fix-loop: ${msg}\n`);
  process.exit(code);
}
const log = (msg) => process.stderr.write(`[loop] ${msg}\n`);

/* ------------------------------------------------------------------- args */

const argv = process.argv.slice(2);
const opts = {
  repo: process.cwd(), base: 'HEAD', requirement: null, runs: [], testFiles: [],
  maxRounds: 4, bulkProvider: 'anthropic', bulkModel: null,
  finalProvider: 'openai', finalModel: null, noFinalCross: false,
  fixerModel: null, freshFixer: false, timeoutMin: 15,
  state: null, forceLock: false,
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const take = () => { if (i + 1 >= argv.length) die(`${a} needs a value\n${USAGE}`); return argv[++i]; };
  if (a === '--repo') opts.repo = path.resolve(take());
  else if (a === '--base') opts.base = take();
  else if (a === '--requirement') opts.requirement = take();
  else if (a === '--run') opts.runs.push(take());
  else if (a === '--test-file') opts.testFiles.push(take());
  else if (a === '--max-rounds') opts.maxRounds = Number(take());
  else if (a === '--bulk-provider') opts.bulkProvider = take();
  else if (a === '--bulk-model') opts.bulkModel = take();
  else if (a === '--final-provider') opts.finalProvider = take();
  else if (a === '--final-model') opts.finalModel = take();
  else if (a === '--no-final-cross') opts.noFinalCross = true;
  else if (a === '--fixer-model') opts.fixerModel = take();
  else if (a === '--fresh-fixer') opts.freshFixer = true;
  else if (a === '--timeout-min') opts.timeoutMin = Number(take());
  else if (a === '--state') opts.state = path.resolve(take());
  else if (a === '--force-lock') opts.forceLock = true;
  else if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
  else die(`unknown argument ${a}\n${USAGE}`);
}
if (!opts.requirement) die(`--requirement is required\n${USAGE}`);
if (!opts.runs.length) die(`at least one --run command is required (the fixer test the verifier re-runs)\n${USAGE}`);
if (!Number.isInteger(opts.maxRounds) || opts.maxRounds < 1) die('--max-rounds must be a positive integer');
if (!Number.isFinite(opts.timeoutMin) || opts.timeoutMin <= 0) die('--timeout-min must be positive');

function readRequirement(spec) {
  if (!spec.startsWith('@')) return spec;
  const f = path.resolve(spec.slice(1));
  if (!fs.existsSync(f)) die(`--requirement file not found: ${f}`);
  return fs.readFileSync(f, 'utf8');
}

/* -------------------------------------------------------------- git utils */

function git(...args) {
  const r = spawnSync('git', ['-C', opts.repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
function gitOk(...args) {
  const r = git(...args);
  if (r.code !== 0) die(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

/**
 * SNAPSHOT (review finding #6, specified exactly): a dangling commit of the
 * working tree via a temporary index — `read-tree HEAD` + `add -A` +
 * `write-tree` + `commit-tree -p HEAD`. Untracked files are INCLUDED;
 * .gitignored files are EXCLUDED (git add -A policy); nothing touches the
 * real index, no branch moves, the commit stays unreferenced. The TREE sha is
 * the identity used by the staleness gate — it fingerprints commits AND
 * working-tree movement uniformly.
 */
function snapshot() {
  // Hoisted to scripts/lib/tree-snapshot.mjs (FEAT-134) so independent-verify.mjs
  // shares the exact same mechanism (one definition, ARCH-008). The helper throws
  // on any git failure; this wrapper preserves verify-fix-loop's fail-fast `die`.
  try { return snapshotWorkingTree(opts.repo); }
  catch (e) { die(e instanceof Error ? e.message : String(e)); }
}

/**
 * NUL-safe changed-paths between two tree-ish (review finding #8).
 * --no-renames (closing finding 4, 2026-08-11): git ≥2.9 detects renames by
 * default and lists only the DESTINATION path, so an uncommitted `git mv` of a
 * file the fixer touched never intersected touchedFiles — the gate classified
 * it "moved-elsewhere / proceed normally". Rename pairs must surface as
 * delete+add so BOTH paths reach the staleness intersection (review findings
 * #8/#9: "retain both old and new paths for renames/copies").
 */
function changedPaths(a, b) {
  const r = git('diff', '--no-renames', '--name-only', '-z', a, b);
  if (r.code !== 0) return [];
  return r.stdout.split('\0').filter(Boolean);
}

/*
 * NOTE (2026-08-12, orchestrator instruction — RECURRING CLASS, WA §N): the
 * before/after `git status --porcelain` LINE-DELTA that used to compute
 * `fixRound`'s touchedFiles is GONE, deliberately, and must not come back. It
 * produced THREE distinct defects in a row — (1) `changedPaths` rename drop,
 * (2) `.slice(3)` corruption of a bare rename-pair token, (3) clean-room run
 * 87b38f59: a file edited a SECOND time while already dirty emits an IDENTICAL
 * status line on both sides and silently drops out, which is the loop's steady
 * state since it never commits between rounds (`touchedFiles: []`). A status
 * line encodes a file's STATUS, not its CONTENT; comparing lines can never see
 * a same-status content change. The approach is replaced, not patched:
 * touchedFiles is now a tree-to-tree diff of the loop's own snapshots (see
 * `fixRound`), which is content-addressed and therefore immune to prior
 * dirtiness, ordering, rename representation and repeated edits alike.
 */

/* ------------------------------------------------------------- state file */

const repoKey = () => {
  const top = gitOk('rev-parse', '--show-toplevel').trim();
  return top.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+/, '');
};

let stateFile, lockFile;
const state = {
  requirement: null, repo: null, base: null, createdAt: new Date().toISOString(),
  // ARCH-002: lifetime is DECLARED at dispatch — every unit this loop starts
  // is turn-scoped (a foreground child of this process), stated, never inferred.
  fixer: { sessionId: null, provider: 'anthropic', lifetime: 'turn', lastRound: null },
  rounds: [],
  outcome: null, // 'VERIFIED' | 'CAPPED'
  advisory: 'This file is bookkeeping, not ground truth (ARCH-002): a resumed loop re-verifies; nothing may act on a verdict recorded here without re-running it.',
};

function saveState() {
  // Review finding #10: sibling file + atomic rename, 0600, never truncated-in-place.
  const tmp = `${stateFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, stateFile);
}

function acquireLock() {
  // Review finding #10: refuse concurrent loops on the same repo.
  if (fs.existsSync(lockFile) && !opts.forceLock) {
    let holder = null;
    try { holder = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { /* unreadable = stale-ish */ }
    let alive = false;
    if (holder?.pid) { try { process.kill(holder.pid, 0); alive = true; } catch { alive = false; } }
    if (alive) die(`another verify-fix-loop (pid ${holder.pid}) holds the lock for this repo (${lockFile}); use --force-lock only if you are sure it is dead`);
    log(`stale lock (pid ${holder?.pid ?? '?'} not running) — taking over`);
  }
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }) + '\n', { mode: 0o600 });
  const release = () => { try { fs.rmSync(lockFile, { force: true }); } catch { /* ignore */ } };
  process.on('exit', release);
  process.on('SIGINT', () => { release(); process.exit(130); });
  process.on('SIGTERM', () => { release(); process.exit(143); });
}

/* ------------------------------------------------------- child processes */

/**
 * Spawn a node script (no shell — review finding #12), tee stderr through.
 * When `stdin` is a string it is piped to the child's stdin and closed — the
 * E2BIG-proof channel for oversized payloads (see ARGV_SAFE_BYTES): Linux caps
 * ONE argv string at MAX_ARG_STRLEN (131072 bytes), so a large prompt passed
 * positionally kills the spawn with E2BIG before the child ever runs.
 */
function runChild(bin, args, stdin = null) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [bin, ...args], { stdio: [stdin != null ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    if (stdin != null) {
      child.stdin.on('error', () => { /* EPIPE if the child dies early; the exit handler reports it */ });
      child.stdin.end(stdin);
    }
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; process.stderr.write(d); });
    child.once('error', (e) => res({ code: -1, stdout, stderr: stderr + `\nspawn error: ${e.message}` }));
    child.once('exit', (c) => res({ code: c ?? 1, stdout, stderr }));
  });
}

/*
 * ARGV vs STDIN threshold (requirement #6 — "no spawn E2BIG at ANY hop").
 * Mirrors independent-verify.mjs's verifier hop EXACTLY: prompts at or under
 * this size travel as a positional argv element (keeps the existing argv-based
 * shim/dispatch assertions intact); anything larger travels over dispatch's
 * `--prompt-stdin` seam. Chosen threshold (not always-stdin) because it is the
 * already-proven verifier-hop value and preserves the deterministic suite's
 * argv-reading seams for the common small-prompt case, while the demonstrated
 * ~161KB verdict is safely over it.
 */
const ARGV_SAFE_BYTES = 100_000;

/* --------------------------------------------------------------- verifier */

/*
 * The requirement is the OTHER variable-size payload the loop hands to a child
 * (independent-verify.mjs), so requirement #6 ("no E2BIG at ANY hop") covers it
 * too. A `@file` spec forwards unchanged (already a small path; the child reads
 * it). An INLINE requirement over the argv limit is materialized to a temp file
 * ONCE and forwarded as `@file`, so it never rides argv into the verifier
 * spawn. Small inline requirements keep the argv path.
 */
let verifierReqArg = null;
function requirementArgForVerifier() {
  if (verifierReqArg !== null) return verifierReqArg;
  const spec = opts.requirement;
  if (spec.startsWith('@') || Buffer.byteLength(spec, 'utf8') <= ARGV_SAFE_BYTES) {
    verifierReqArg = spec;
  } else {
    const reqFile = path.join(os.tmpdir(), `vfl-req-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
    fs.writeFileSync(reqFile, spec, { mode: 0o600 });
    process.on('exit', () => { try { fs.rmSync(reqFile, { force: true }); } catch { /* ignore */ } });
    log(`requirement is ${Buffer.byteLength(spec, 'utf8')}B (over the argv limit) — forwarding to the verifier as @${reqFile} to avoid E2BIG`);
    verifierReqArg = `@${reqFile}`;
  }
  return verifierReqArg;
}

/**
 * One EPHEMERAL clean-room verifier round. A brand-new dispatch every time —
 * the run id is recorded and must differ from every prior round's (asserted).
 */
async function verifyRound({ provider, model, snapCommit }) {
  const args = [
    '--repo', opts.repo,
    '--range', `${state.base}..${snapCommit}`,
    '--requirement', requirementArgForVerifier(),
    ...opts.runs.flatMap((r) => ['--run', r]),
    ...opts.testFiles.flatMap((t) => ['--test-file', t]),
    '--provider', provider,
    ...(model ? ['--model', model] : []),
    '--timeout-min', String(opts.timeoutMin),
  ];
  const r = await runChild(VERIFY_BIN, args);
  const runId =
    /session\s+([A-Za-z0-9][\w.:-]{5,})/.exec(r.stderr)?.[1] ??
    /thread\s+([A-Za-z0-9][\w.:-]{5,})\s+started/.exec(r.stderr)?.[1] ?? null;
  const verdict = r.code === 0 ? 'HOLDS' : r.code === 1 ? 'BROKEN' : r.code === 3 ? 'INVALID' : 'DISPATCH-FAILED';
  const quotaWindow = /dispatch failed \[quota-window\]/.test(r.stderr);
  return { exit: r.code, verdict, runId, quotaWindow, verdictText: r.stdout.trim() };
}

/* ------------------------------------------------------------------ fixer */

/**
 * The DURABLE fixer thread: same session resumed each round via
 * dispatch --resume; its context (dead ends, code paths) persists. Fresh only
 * on the very first round, on resume failure, or on --fresh-fixer.
 */
async function fixRound({ preamble, verdictText, round }) {
  const metaFile = path.join(os.tmpdir(), `vfl-fixer-meta-${process.pid}-${round}.json`);
  const resume = (!opts.freshFixer && state.fixer.sessionId) ? state.fixer.sessionId : null;
  const intro = resume
    ? `You are the FIXER continuing your own earlier work (round ${round} of a verify→fix loop).`
    : `You are the FIXER in a verify→fix loop (round ${round}). The task and requirement:

${readRequirement(opts.requirement).trim()}

The repo is at ${opts.repo} (your working directory).`;
  const prompt = `${preamble ? `${preamble}\n\n` : ''}${intro}

An INDEPENDENT VERIFIER — it cannot see you, has none of your context, and is
replaced by a fresh one every round — attempted to break the work and returned
the verdict below. It is relayed to you VERBATIM (composed by the verification
harness from its own execution records; the findings name real, reproduced
defects):

---BEGIN VERIFIER VERDICT (verbatim)---
${verdictText}
---END VERIFIER VERDICT---

Fix the DEFECT the findings describe — the actual defect, not the verifier's
specific probe. Do NOT weaken or special-case any test to make it pass. Run the
project's own test (${opts.runs.join(' ; ')}) before you finish. End your reply
with a one-line summary of the files you touched.`;

  // TOUCHED FILES, part 1 of 2: snapshot the tree BEFORE the fixer runs. The
  // snapshot machinery is the same one the staleness gate uses (temp-index
  // dangling commit; untracked included, ignored excluded), so the fixer's
  // touched set and the gate's movement set are computed in one currency.
  const beforeSnap = snapshot();
  // requirement #6, FIXER hop: the composed prompt embeds the VERBATIM verifier
  // verdict, which can be very large (a ~161KB verdict was demonstrated to crash
  // the loop with spawn E2BIG when relayed as a positional argv element). Route
  // oversized prompts over dispatch's `--prompt-stdin` seam — the exact channel
  // the 2026-08-11 fix built for the verifier hop; small prompts keep the argv
  // path so the deterministic suite's argv-reading seams still hold.
  const viaStdin = Buffer.byteLength(prompt, 'utf8') > ARGV_SAFE_BYTES;
  const args = [
    '--provider', 'anthropic',
    ...(opts.fixerModel ? ['--model', opts.fixerModel] : []),
    '--cwd', opts.repo,
    '--sandbox', 'workspace-write',
    '--allow-tools', 'Bash Read Write Edit Glob Grep',
    '--timeout-min', String(opts.timeoutMin),
    '--meta-out', metaFile,
    ...(resume ? ['--resume', resume] : []),
    ...(viaStdin ? ['--prompt-stdin'] : ['--', prompt]),
  ];
  let r = await runChild(DISPATCH_BIN, args, viaStdin ? prompt : null);
  let usedResume = Boolean(resume);
  if (r.code !== 0 && resume) {
    // Resume failure → fresh fixer, stated (review finding #9's fallback rule).
    log(`fixer resume of session ${resume} FAILED (exit ${r.code}) — falling back to a FRESH fixer session, context lost and said so`);
    const freshArgs = args.filter((x, idx) => !(x === '--resume' || args[idx - 1] === '--resume'));
    r = await runChild(DISPATCH_BIN, freshArgs, viaStdin ? prompt : null);
    usedResume = false;
  }
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { /* no meta — sessionId stays as-is */ }
  try { fs.rmSync(metaFile, { force: true }); } catch { /* ignore */ }
  if (r.code !== 0) die(`fixer dispatch failed (exit ${r.code}) — see stderr above; loop cannot continue without a fixer`);
  // Review finding #11: `fixerResumed` is only claimed on a real session id
  // from the machine-readable channel; the id is required to resume next round.
  if (meta?.sessionId) state.fixer.sessionId = meta.sessionId;
  else log('WARNING: fixer dispatch wrote no session id — next round will start a FRESH fixer (recorded)');

  // TOUCHED FILES, part 2 of 2: snapshot AFTER the round and diff the two
  // snapshot TREES. `changedPaths` is `git diff --no-renames --name-only -z`,
  // so the result is exactly the set of paths whose CONTENT (or existence)
  // differs between the tree the fixer started from and the tree it produced —
  // both sides of a rename, deletions, new untracked files, and a second edit
  // of an already-dirty file all included; pre-existing dirt that the fixer did
  // NOT touch is excluded because it is identical in both trees. This replaces
  // the status-line delta wholesale (see the note above `snapshot`'s helpers).
  const snap = snapshot();
  const touched = changedPaths(beforeSnap.tree, snap.tree);
  state.fixer.lastRound = { baseHead: snap.head, snapshotSha: snap.commit, treeSha: snap.tree, touchedFiles: touched };
  return { usedResume, sessionId: state.fixer.sessionId, touched, reply: r.stdout.trim() };
}

/* -------------------------------------------------------- staleness gate */

/**
 * Runs immediately before every relay (review finding #5). Compares the repo's
 * CURRENT tree fingerprint against the tree that was just VERIFIED; any moved
 * path that intersects (fixer's touched files ∪ the verify diff) makes the
 * relay open with a mandatory re-orientation preamble naming exactly those
 * paths. Irrelevant movement is still said out loud. Never silent.
 */
function stalenessGate(verifiedSnap, verifyDiffPaths) {
  const now = snapshot();
  // The reference fingerprint is what the FIXER last saw (the snapshot taken
  // the moment it finished its previous round) — that is whose mental model
  // the gate protects. Round 1, or a fresh fixer, has no such reference; then
  // the reference is the tree just verified (mid-verify movement only).
  const referenceTree = state.fixer.lastRound?.treeSha ?? verifiedSnap.tree;
  if (now.tree === referenceTree) return { decision: 'clean', movedPaths: [], preamble: null };
  const moved = changedPaths(referenceTree, now.tree);
  const relevant = new Set([...(state.fixer.lastRound?.touchedFiles ?? []), ...verifyDiffPaths]);
  const hits = moved.filter((p) => relevant.has(p));
  const refHead = state.fixer.lastRound?.baseHead ?? verifiedSnap.head;
  const shortlog = git('log', '--oneline', `${refHead}..HEAD`).stdout.trim();
  if (hits.length) {
    return {
      decision: 'reoriented', movedPaths: hits,
      preamble: `RE-ORIENTATION REQUIRED — THE REPO CHANGED SINCE THE VERDICT BELOW WAS PRODUCED.
The following files — files you touched or that the verified diff covers — have
moved underneath you:
${hits.map((p) => `  - ${p}`).join('\n')}
${shortlog ? `Intervening commits:\n${shortlog.split('\n').map((l) => `  ${l}`).join('\n')}\n` : ''}RE-READ those files before touching anything; your prior assumptions about them
may be void. The verdict below was produced against the PRE-CHANGE state.`,
    };
  }
  return {
    decision: 'moved-elsewhere', movedPaths: moved,
    preamble: `NOTE: the repo moved since the verdict below was produced (${moved.length} path(s)${shortlog ? `; commits:\n${shortlog.split('\n').map((l) => `  ${l}`).join('\n')}` : ''}), but NONE of it touches your files or the verified diff. Proceed normally.`,
  };
}

/* ------------------------------------------------------------------ main */

async function main() {
  if (git('rev-parse', '--git-dir').code !== 0) die(`not a git repo: ${opts.repo}`);
  state.repo = gitOk('rev-parse', '--show-toplevel').trim();
  state.base = gitOk('rev-parse', opts.base).trim();
  state.requirement = opts.requirement;

  const stateDir = path.join(os.tmpdir(), 'verify-fix-loop');
  fs.mkdirSync(stateDir, { recursive: true });
  stateFile = opts.state ?? path.join(stateDir, `${repoKey()}.json`);
  lockFile = `${stateFile}.lock`;
  acquireLock();
  saveState();

  log(`repo ${state.repo}  base ${state.base.slice(0, 12)}`);
  log(`fixer: durable anthropic thread${opts.fixerModel ? ` (${opts.fixerModel})` : ''}; verifier: ephemeral clean-room per round`);
  log(`rounds: max ${opts.maxRounds} (each verifier dispatch is a round); bulk ${opts.bulkProvider}${opts.bulkModel ? `/${opts.bulkModel}` : ''}; final ${opts.noFinalCross ? 'DISABLED (--no-final-cross, recorded)' : `${opts.finalProvider}${opts.finalModel ? `/${opts.finalModel}` : ''} (cross-provider, reserved for the last word — ROUTING: openai is scarce)`}`);
  log(`state ${stateFile} (advisory — ARCH-002)`);

  let pendingFinal = false;      // a bulk HOLDS awaits cross-provider confirmation
  let degradeFinal = false;      // openai window exhausted → final degrades to anthropic

  for (let n = 1; n <= opts.maxRounds; n++) {
    const role = pendingFinal ? 'final' : 'bulk';
    let provider = role === 'final' ? (degradeFinal ? 'anthropic' : opts.finalProvider) : opts.bulkProvider;
    let model = role === 'final' ? (degradeFinal ? opts.bulkModel : opts.finalModel) : opts.bulkModel;

    const snap = snapshot();
    const verifyDiffPaths = changedPaths(state.base, snap.tree);
    log(`— round ${n}/${opts.maxRounds} [${role}] verifier ${provider}${model ? `/${model}` : ''} on snapshot ${snap.commit.slice(0, 12)} (tree ${snap.tree.slice(0, 12)})`);

    const v = await verifyRound({ provider, model, snapCommit: snap.commit });

    // No verifier reuse, ever: each round is a NEW dispatch with a NEW id.
    if (v.runId && state.rounds.some((r) => r.verifier.runId === v.runId)) {
      die(`verifier run id ${v.runId} was already used by a previous round — verifier reuse is structurally forbidden`);
    }
    const round = {
      n, role, headSha: snap.head, snapshotSha: snap.commit, treeSha: snap.tree,
      verifier: { provider, model, runId: v.runId, lifetime: 'turn', degradedFromOpenai: role === 'final' && degradeFinal },
      verdict: v.verdict, verdictExit: v.exit,
      findingsVerbatim: v.verdict === 'BROKEN' ? v.verdictText : null,
      staleness: null, fixerResumed: null,
    };
    state.rounds.push(round);
    saveState();
    log(`  round ${n}: ${v.verdict}${v.runId ? ` (run ${v.runId})` : ''}`);

    if (v.verdict === 'HOLDS') {
      if (role === 'final' || opts.noFinalCross) {
        state.outcome = 'VERIFIED';
        saveState();
        console.log(`VERIFY-FIX-LOOP: VERIFIED after ${n} round(s).`);
        if (opts.noFinalCross && role !== 'final') console.log('  NOTE: cross-provider final verdict was explicitly disabled (--no-final-cross); this HOLDS is single-provider.');
        printRounds();
        console.log('\nPaste-ready (the final round):');
        console.log(`- **Verified-by:** dispatch ${provider}${model ? `/${model}` : ''} run ${v.runId ?? 'UNKNOWN-RUN-ID'} (clean-room via verify-fix-loop) — VERDICT: HOLDS`);
        process.exit(0);
      }
      pendingFinal = true; // the next round is the cross-provider last word
      log(`  bulk HOLDS — reserving the next round for the cross-provider FINAL verdict (${opts.finalProvider})`);
      continue;
    }

    if (v.verdict === 'BROKEN') {
      pendingFinal = false;
      if (n === opts.maxRounds) break; // findings exist but no budget to fix — CAPPED below, honestly
      const gate = stalenessGate(snap, verifyDiffPaths);
      round.staleness = { decision: gate.decision, movedPaths: gate.movedPaths };
      saveState();
      log(`  staleness: ${gate.decision}${gate.movedPaths.length ? ` (${gate.movedPaths.join(', ')})` : ''}`);
      const fix = await fixRound({ preamble: gate.preamble, verdictText: v.verdictText, round: n });
      round.fixerResumed = fix.usedResume;
      saveState();
      log(`  fixer ${fix.usedResume ? `resumed session ${fix.sessionId}` : `fresh session ${fix.sessionId ?? '(no id)'}`}; touched: ${fix.touched.join(', ') || '(none — snapshot trees identical)'}`);
      continue;
    }

    // INVALID / DISPATCH-FAILED: nothing trustworthy to relay (review finding
    // #3) — never fed to the fixer. Recorded; next round retries fresh.
    pendingFinal = false;
    if (role === 'final' && v.quotaWindow && !degradeFinal) {
      degradeFinal = true;
      pendingFinal = true; // retry the final on the degraded provider
      log(`  final verdict dispatch hit [quota-window] on ${opts.finalProvider} — DEGRADING the final verify to anthropic (recorded honestly)`);
      continue;
    }
    log(`  round ${n} produced no usable verdict (${v.verdict}) — not relayed to the fixer; retrying with a fresh verifier next round`);
  }

  state.outcome = 'CAPPED';
  saveState();
  console.log(`VERIFY-FIX-LOOP: CAPPED — round cap (${opts.maxRounds}) reached without a confirmed VERIFIED.`);
  console.log('Honest status: IN-PROGRESS. This is the designed outcome of a bounded loop, not a failure');
  console.log('of the cap (FEAT-061: unbounded verifier-chasing diverges).');
  printRounds();
  console.log('\nEscalation menu (operator chooses; the loop does not):');
  console.log('  - fresh fixer with the full round history');
  console.log('  - reclassify: explore / plan+review (the framing may be wrong, not the code)');
  console.log('  - surface to the user with the round table above');
  process.exit(4);
}

function printRounds() {
  console.log('\nround | role  | verifier            | verdict         | staleness       | fixer');
  for (const r of state.rounds) {
    console.log(`  ${String(r.n).padEnd(3)} | ${r.role.padEnd(5)} | ${`${r.verifier.provider}${r.verifier.model ? `/${r.verifier.model}` : ''}${r.verifier.degradedFromOpenai ? ' (degraded)' : ''}`.padEnd(19)} | ${`${r.verdict} (exit ${r.verdictExit})`.padEnd(15)} | ${(r.staleness?.decision ?? '-').padEnd(15)} | ${r.fixerResumed == null ? '-' : r.fixerResumed ? 'resumed' : 'fresh'}${r.verifier.runId ? `  run ${r.verifier.runId}` : ''}`);
  }
  console.log(`\nstate: ${stateFile}`);
}

await main();
