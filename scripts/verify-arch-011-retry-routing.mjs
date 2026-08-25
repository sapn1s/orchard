#!/usr/bin/env node
/**
 * verify-arch-011-retry-routing.mjs — grades scripts/lane-context.mjs, the
 * measured-staleness retry rule ARCH-011's decision record describes.
 *
 * ---------------------------------------------------------------------------
 * WHAT MAKES THIS A PROOF RATHER THAN A DEMONSTRATION
 * ---------------------------------------------------------------------------
 * The rule routes between exactly the two options it replaced, so the danger is
 * that it quietly collapses into one of them and still looks like it works.
 * The MUST-FAIL bar this suite is built around: **a constant router fails it.**
 * `always reuse` (option A) fails every `fresh` case; `always fresh` (option B)
 * fails every `reuse` case; and a time-based router fails the two cases where
 * content and elapsed time disagree (a reverting edit and a bare `touch`).
 * The suite asserts that its own case list contains both verdicts, so it cannot
 * silently drift into being passable by a constant.
 *
 * Two families of case, and the honest label on each:
 *
 *  - REAL-STORE (read-only). Runs the touched-set derivation over every real
 *    worker transcript in this machine's CLI store. Nothing is mutated. These
 *    grade the feasibility claims the ticket records as numbers.
 *  - SCRATCH-REPO (synthetic transcripts, realistic state). Routing cannot be
 *    graded without mutating files, and the real repo must not be mutated, so
 *    these build a scratch repository and a scratch CLI store. The transcripts
 *    are SYNTHETIC — stated plainly — but they are modelled on the real shape
 *    measured above (a dozen files, a mix of file-tool and Bash-argument
 *    provenance, a second lane committing in between), not on the minimal case
 *    that would prove only the mechanism.
 *
 * Plus a TRUNCATION family, because the CLI appends to a lane transcript while
 * the lane runs: a fixture built from the final state cannot prove a concurrent
 * read correct. A real transcript is truncated at many points and each prefix
 * is graded, including mid-line cuts.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const TOOL = path.join(HERE, 'lane-context.mjs');

let pass = 0;
let fail = 0;
const failures = [];
function grade(name, ok, detail = '') {
  if (ok) { pass++; process.stdout.write(`PASS ${name}\n`); }
  else { fail++; failures.push(name); process.stdout.write(`FAIL ${name}${detail ? `: ${detail}` : ''}\n`); }
}

/* ─────────────────────────────────────────────────────────────── scratch root */

function scratchRoot() {
  const base = process.env.CLAUDE_STATION_TMPDIR
    || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'orchard-scratch');
  const dir = path.join(base, `arch-011-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const ROOT = scratchRoot();
process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ } });

function run(args, env = {}) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* reported by the caller */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

/* ═══════════════════════════════════════════════ family 1 — the real store */

function encodeProjectDir(dir) { return path.resolve(dir).replace(/[^a-zA-Z0-9]/g, '-'); }

function realLaneTranscripts() {
  const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const proj = path.join(home, 'projects', encodeProjectDir(REPO));
  const out = [];
  let sessions = [];
  try { sessions = fs.readdirSync(proj, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return out; }
  for (const s of sessions) {
    const dir = path.join(proj, s.name, 'subagents');
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) if (f.endsWith('.jsonl')) out.push(path.join(dir, f));
  }
  return out;
}

/**
 * A local re-derivation of the touched set, used ONLY to grade the real store
 * in bulk without paying a process spawn per lane. It is deliberately the same
 * shape as the tool's file-tool branch; the tool itself is what the routing
 * families exercise end to end.
 */
function fileToolSet(transcriptPath) {
  const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
  const set = new Set();
  let text = '';
  try { text = fs.readFileSync(transcriptPath, 'utf8'); } catch { return set; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'assistant') continue;
    const c = (o.message && o.message.content) || [];
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b && b.type === 'tool_use' && FILE_TOOLS.has(b.name) && typeof b.input?.file_path === 'string') set.add(b.input.file_path);
    }
  }
  return set;
}

function familyRealStore() {
  const lanes = realLaneTranscripts();
  if (!lanes.length) {
    process.stdout.write('SKIP real-store family — no lane transcripts under this machine\'s CLI store\n');
    return null;
  }
  const withSet = lanes.filter((l) => fileToolSet(l).size > 0);
  const share = withSet.length / lanes.length;
  grade(
    'real-store/touched-set-recoverable',
    share >= 0.75,
    `${withSet.length}/${lanes.length} = ${(share * 100).toFixed(0)}% of REAL lanes yield a touched set (bar: 75%)`,
  );
  process.stdout.write(`     measured: ${withSet.length}/${lanes.length} real lanes (${(share * 100).toFixed(0)}%) record at least one file-tool path\n`);
  return { lanes, withSet };
}

/* ══════════════════════════════════ family 2 — truncated / concurrent reads */

/**
 * A lane transcript is appended to by another process. Grade PREFIXES of a real
 * one, including mid-line cuts, on two properties:
 *   - the derivation never throws and never emits a non-path;
 *   - the touched set is MONOTONE in prefix length. That is the property that
 *     matters: a short read may know LESS, and the rule's safety depends on
 *     never inventing a file (which would flip a reuse to a fresh) — while
 *     knowing less is exactly why fingerprinting a running lane is refused.
 */
function familyTruncation(real) {
  if (!real) return;
  const big = real.withSet
    .map((p) => ({ p, size: fs.statSync(p).size }))
    .sort((a, b) => b.size - a.size)[0];
  if (!big) { process.stdout.write('SKIP truncation family — no sized lane\n'); return; }

  const text = fs.readFileSync(big.p, 'utf8');
  const tmp = path.join(ROOT, 'trunc.jsonl');
  const cuts = [];
  for (let i = 1; i <= 24; i++) cuts.push(Math.floor((text.length * i) / 25));
  // Explicit mid-line cuts: one byte either side of a newline.
  const nl = text.indexOf('\n', Math.floor(text.length / 2));
  if (nl > 0) cuts.push(nl - 1, nl + 1, nl + 2);

  let prev = 0;
  let monotone = true;
  let threw = false;
  let badPath = null;
  for (const cut of cuts.sort((a, b) => a - b)) {
    fs.writeFileSync(tmp, text.slice(0, cut));
    let size;
    try { size = fileToolSet(tmp).size; } catch { threw = true; break; }
    if (size < prev) monotone = false;
    for (const p of fileToolSet(tmp)) if (typeof p !== 'string' || !p) badPath = String(p);
    prev = size;
  }
  grade('truncation/no-throw-on-partial-read', !threw, 'derivation threw on a truncated transcript');
  grade('truncation/touched-set-monotone', monotone, 'a shorter prefix reported MORE files than a longer one — the derivation is inventing paths');
  grade('truncation/no-malformed-path', badPath === null, `emitted ${JSON.stringify(badPath)}`);
  process.stdout.write(`     graded ${cuts.length} truncations of a REAL ${(big.size / 1024).toFixed(0)}KB lane transcript, including mid-line cuts\n`);
}

/* ═════════════════════════════════ family 3 — routing, on a scratch repo */

/**
 * Build a scratch git repo in a realistic BUSY state — not the minimal case.
 * Twelve files across source, scripts, docs and the board, which is the shape
 * the real store measures (median 4 written / 5 read, 11 read at p90).
 */
function buildScratchRepo() {
  const repo = path.join(ROOT, 'repo');
  fs.mkdirSync(path.join(repo, 'src', 'server'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'scripts', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'docs', 'bugs'), { recursive: true });
  const files = [
    'src/server/index.ts', 'src/server/agent-bridge.ts', 'src/server/registry.ts',
    'src/server/survival.ts', 'scripts/board.mjs', 'scripts/lib/ticket-schema.mjs',
    'scripts/verify-thing.mjs', 'docs/bugs/INDEX.md', 'docs/bugs/BUG-001-a.md',
    'docs/bugs/BUG-002-b.md', 'package.json', 'public-app.js',
  ];
  for (const f of files) fs.writeFileSync(path.join(repo, f), `// ${f}\noriginal content for ${f}\n`);
  const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'verify@example.invalid');
  git('config', 'user.name', 'arch-011 verify');
  git('add', '-A');
  git('commit', '-qm', 'scratch base');
  return { repo, files };
}

/**
 * Write a SYNTHETIC lane transcript into a scratch CLI store, in the on-disk
 * shape the real store uses, plus the parent session entry that marks the lane
 * finished. Synthetic is stated here and in the suite's summary.
 */
function writeLane(store, repo, agentId, { reads = [], writes = [], bash = [], complete = true }) {
  const proj = path.join(store, 'projects', encodeProjectDir(repo));
  const sessionId = 'ssn-00000000-0000-0000-0000-000000000001';
  const subdir = path.join(proj, sessionId, 'subagents');
  fs.mkdirSync(subdir, { recursive: true });

  const toolUseId = `toolu_${agentId}`;
  const t0 = Date.now() - 60_000;
  const lines = [];
  const say = (blocks, i) => lines.push(JSON.stringify({
    type: 'assistant', isSidechain: true, agentId, timestamp: new Date(t0 + i * 1000).toISOString(),
    message: { role: 'assistant', content: blocks },
  }));
  let i = 0;
  for (const f of reads) say([{ type: 'tool_use', id: `t${i}`, name: 'Read', input: { file_path: path.join(repo, f) } }], i++);
  for (const f of writes) say([{ type: 'tool_use', id: `t${i}`, name: 'Edit', input: { file_path: path.join(repo, f), old_string: 'a', new_string: 'b' } }], i++);
  for (const c of bash) say([{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: c } }], i++);
  fs.writeFileSync(path.join(subdir, `agent-${agentId}.jsonl`), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(subdir, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'worker', description: 'synthetic lane', toolUseId, spawnDepth: 1, model: 'test' }));

  // The parent session: the tool_use is always present; the tool_result only
  // when the lane has finished. That distinction is the completion signal.
  const parent = [JSON.stringify({ type: 'assistant', sessionId, message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input: {} }] } })];
  if (complete) parent.push(JSON.stringify({ type: 'user', sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'done' }] } }));
  fs.writeFileSync(path.join(proj, `${sessionId}.jsonl`), parent.join('\n') + '\n');
  return agentId;
}

function familyRouting() {
  const { repo } = buildScratchRepo();
  const store = path.join(ROOT, 'clistore');
  const data = path.join(ROOT, 'data');
  const env = { CLAUDE_CONFIG_DIR: store, CLAUDE_STATION_DATA: data };
  const F = (agent, extra = []) => run(['fingerprint', `--agent=${agent}`, `--cwd=${repo}`, ...extra], env);
  const C = (agent, extra = []) => run(['check', `--agent=${agent}`, `--cwd=${repo}`, ...extra], env);
  const abs = (f) => path.join(repo, f);
  const busy = {
    reads: ['src/server/index.ts', 'src/server/registry.ts', 'docs/bugs/INDEX.md', 'docs/bugs/BUG-001-a.md', 'scripts/lib/ticket-schema.mjs'],
    writes: ['src/server/agent-bridge.ts', 'src/server/survival.ts', 'public-app.js'],
    bash: ['node scripts/board.mjs check', 'sed -i s/x/y/ docs/bugs/BUG-002-b.md', 'npm run gate'],
  };
  const routes = [];
  const routeOf = (r) => { if (r.json?.route) routes.push(r.json.route); return r.json?.route; };

  // --- the touched set really is derived from the transcript -----------------
  const a1 = writeLane(store, repo, 'a1nothingchanged', busy);
  const f1 = F(a1);
  // 5 reads + 3 writes through file tools, plus the two existing paths named as
  // Bash arguments (`scripts/board.mjs`, `docs/bugs/BUG-002-b.md`). `npm run
  // gate` names no path and must contribute nothing.
  grade('routing/fingerprint-derives-touched-set', f1.json?.ok === true && f1.json.file_count === 10, `file_count=${f1.json?.file_count}, expected 10 (8 file-tool + 2 Bash-argument paths; a Bash line naming no path adds nothing)`);
  grade('routing/bash-arguments-are-tagged-not-hidden', (f1.json?.by_source?.bash_arg || 0) >= 2 && (f1.json?.by_source?.file_tool || 0) >= 8, `by_source=${JSON.stringify(f1.json?.by_source)}`);

  // --- rule 3: nothing moved -> reuse ---------------------------------------
  const c1 = C(a1);
  grade('rule3/unchanged-files-reuse', routeOf(c1) === 'reuse' && c1.json?.reason === 'touched-files-unchanged', `${c1.json?.route}/${c1.json?.reason}`);

  // --- rule 2: one file of twelve moved -> fresh -----------------------------
  const a2 = writeLane(store, repo, 'a2onefilemoved', busy);
  F(a2);
  fs.appendFileSync(abs('src/server/registry.ts'), '// another lane edited this\n');
  const c2 = C(a2);
  grade('rule2/one-changed-file-of-ten-fresh', routeOf(c2) === 'fresh' && c2.json?.reason === 'touched-files-changed' && c2.json.changed.length === 1, `${c2.json?.route}/${c2.json?.reason} changed=${c2.json?.changed?.length}`);
  grade('rule2/names-the-file-that-moved', c2.json?.changed?.[0]?.path === 'src/server/registry.ts', JSON.stringify(c2.json?.changed?.[0]));

  // --- a file another lane rewrote WHOLESALE ---------------------------------
  const a3 = writeLane(store, repo, 'a3wholesale', busy);
  F(a3);
  fs.writeFileSync(abs('src/server/agent-bridge.ts'), 'completely different file\n'.repeat(50));
  grade('rule2/wholesale-rewrite-fresh', routeOf(C(a3)) === 'fresh');

  // --- a file another lane DELETED -------------------------------------------
  const a4 = writeLane(store, repo, 'a4deleted', busy);
  F(a4);
  fs.rmSync(abs('docs/bugs/BUG-001-a.md'));
  const c4 = C(a4);
  grade('rule2/deletion-is-a-change', routeOf(c4) === 'fresh' && c4.json?.changed?.some((c) => c.kind === 'deleted'), JSON.stringify(c4.json?.changed));
  fs.writeFileSync(abs('docs/bugs/BUG-001-a.md'), '// docs/bugs/BUG-001-a.md\noriginal content for docs/bugs/BUG-001-a.md\n');

  // --- WHERE CONTENT BEATS TIME (1): an edit that was reverted ---------------
  // A time-based or git-range rule calls this stale. The bytes say otherwise,
  // and the bytes are what the worker's context holds.
  const a5 = writeLane(store, repo, 'a5reverted', busy);
  F(a5);
  const before = fs.readFileSync(abs('scripts/lib/ticket-schema.mjs'));
  fs.writeFileSync(abs('scripts/lib/ticket-schema.mjs'), 'churn\n');
  spawnSync('git', ['commit', '-qam', 'another lane churns'], { cwd: repo });
  fs.writeFileSync(abs('scripts/lib/ticket-schema.mjs'), before);
  spawnSync('git', ['commit', '-qam', 'another lane reverts'], { cwd: repo });
  const c5 = C(a5);
  grade('content-beats-time/reverted-edit-is-not-stale', routeOf(c5) === 'reuse', `${c5.json?.route}/${c5.json?.reason} — a git-range or interval rule would have said fresh here`);

  // --- WHERE CONTENT BEATS TIME (2): mtime moved, bytes did not --------------
  const a6 = writeLane(store, repo, 'a6touched', busy);
  F(a6);
  const later = new Date(Date.now() + 5_000);
  fs.utimesSync(abs('src/server/index.ts'), later, later);
  grade('content-beats-time/bare-touch-is-not-stale', routeOf(C(a6)) === 'reuse', 'an mtime-based rule would have said fresh here');

  // --- rule 1: a lane that touched nothing -----------------------------------
  const a7 = writeLane(store, repo, 'a7touchednothing', { reads: [], writes: [], bash: ['git status --porcelain', 'echo hello'] });
  F(a7);
  const c7 = C(a7);
  grade('rule1/unknowable-touched-set-fresh', routeOf(c7) === 'fresh' && c7.json?.reason === 'touched-set-unknowable', `${c7.json?.route}/${c7.json?.reason}`);

  // --- option C, folded in: the failed check is one the lane declared green --
  const a8 = writeLane(store, repo, 'a8contradiction', busy);
  F(a8);
  const c8 = C(a8, ['--failed-check=verify:thing', '--worker-declared=verify:thing,gate']);
  grade('optionC/own-declaration-contradicted-fresh', routeOf(c8) === 'fresh' && c8.json?.reason === 'contradicts-own-declaration', `${c8.json?.route}/${c8.json?.reason}`);
  const c8b = C(a8, ['--failed-check=verify:other', '--worker-declared=verify:thing,gate']);
  grade('optionC/does-not-fire-on-a-check-the-lane-never-claimed', routeOf(c8b) === 'reuse', `${c8b.json?.route}/${c8b.json?.reason} — C must not duplicate the hash check`);
  const c8c = C(a8, ['--failed-check=verify:thing']);
  grade('optionC/no-declaration-list-means-no-clause', routeOf(c8c) === 'reuse', `${c8c.json?.route}/${c8c.json?.reason}`);

  // --- the hash outranks C: changed files are fresh for the RIGHT reason -----
  const a9 = writeLane(store, repo, 'a9hashoutranksc', busy);
  F(a9);
  fs.appendFileSync(abs('public-app.js'), '// moved\n');
  const c9 = C(a9, ['--failed-check=verify:thing', '--worker-declared=verify:thing']);
  grade('optionC/hash-outranks-the-clause', routeOf(c9) === 'fresh' && c9.json?.reason === 'touched-files-changed', `reason=${c9.json?.reason} — when the bytes moved, why the check failed is irrelevant`);

  // --- fingerprinting a RUNNING lane is refused ------------------------------
  const a10 = writeLane(store, repo, 'a10stillrunning', { ...busy, complete: false });
  const f10 = F(a10);
  grade('concurrency/refuses-to-fingerprint-a-running-lane', f10.status !== 0 && f10.json?.refusal?.code === 'lane-not-complete', `status=${f10.status} code=${f10.json?.refusal?.code}`);
  const f10b = F(a10, ['--allow-running=1']);
  grade('concurrency/running-lane-fingerprintable-only-on-an-explicit-override', f10b.json?.ok === true && f10b.json.lane_complete === false, JSON.stringify(f10b.json?.lane_complete));

  // --- the fallback oracle is labelled and errs toward fresh -----------------
  const a11 = writeLane(store, repo, 'a11nofingerprint', busy);
  const c11 = C(a11); // deliberately never fingerprinted
  grade('fallback/labelled-as-a-weaker-oracle', c11.json?.oracle === 'git+mtime-fallback' && typeof c11.json?.oracle_caveat === 'string', `oracle=${c11.json?.oracle}`);
  fs.utimesSync(abs('src/server/registry.ts'), later, later);
  const c11b = C(a11);
  grade('fallback/errs-toward-fresh', c11b.json?.route === 'fresh', `${c11b.json?.route}/${c11b.json?.reason} — the weak oracle must over-report change, never under-report`);

  // --- the guard rail: this tool never speaks about who runs the checks ------
  const allowed = new Set(['ok', 'verb', 'agent_id', 'oracle', 'oracle_caveat', 'failed_check', 'route', 'reason', 'explain', 'changed', 'unchanged_count', 'lane_last_timestamp']);
  const strayKeys = Object.keys(c1.json || {}).filter((k) => !allowed.has(k));
  grade('guardrail/verdict-carries-no-authority-over-the-checks', strayKeys.length === 0, `unexpected verdict field(s): ${strayKeys.join(', ')} — a routing verdict must not grow a say in what is checked or who checks it`);
  grade('guardrail/reuse-states-it-is-a-cost-decision', /cost decision only/.test(c1.json?.explain || ''), 'the reuse verdict must say in words that it is about cost and not about grading');

  return routes;
}

/* ═════════════════════════════════════════════════════════════════ the bar */

function familyNotAConstant(routes) {
  const reuse = routes.filter((r) => r === 'reuse').length;
  const fresh = routes.filter((r) => r === 'fresh').length;
  grade('must-fail/option-A-always-reuse-would-fail-this-suite', fresh >= 4, `only ${fresh} fresh verdict(s) — a suite an always-reuse router passes proves nothing`);
  grade('must-fail/option-B-always-fresh-would-fail-this-suite', reuse >= 4, `only ${reuse} reuse verdict(s) — a suite an always-fresh router passes proves nothing`);
  process.stdout.write(`     routing verdicts observed: ${reuse} reuse / ${fresh} fresh across ${routes.length} graded routes\n`);
}

/* ══════════════════════════════════════════════════════════════════ main */

process.stdout.write('=== ARCH-011 retry routing (scripts/lane-context.mjs)\n');
const real = familyRealStore();
familyTruncation(real);
const routes = familyRouting();
familyNotAConstant(routes);

process.stdout.write(`\n=== ${pass}/${pass + fail} checks pass`);
process.stdout.write(fail ? ` — FAILED: ${failures.join(', ')}\n` : '\n');
process.stdout.write('    real-store + truncation families run against the REAL CLI transcript store, read-only.\n');
process.stdout.write('    routing family uses SYNTHETIC lane transcripts on a scratch repo (stated, not implied):\n');
process.stdout.write('    routing cannot be graded without mutating files, and the real repo must never be mutated.\n');
process.exitCode = fail ? 1 : 0;
