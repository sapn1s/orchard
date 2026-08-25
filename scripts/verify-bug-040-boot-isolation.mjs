/**
 * BUG-040 — booting a server must not mutate THIS repo's state unless this
 * repo is part of that server's configured world.
 *
 *   node scripts/verify-bug-040-boot-isolation.mjs
 *
 * The bug: server boot spawned `wa-consolidate.mjs --apply` bare, and the
 * script's project-side half (arch-watch findings, CONVENTIONS relocation
 * target) defaulted to its own module-relative repo root — so ANY boot,
 * including a scratch server in a verify suite, wrote this repo's real
 * docs/bugs/.arch/findings.json.
 *
 * Everything here is scratch: scratch dataDirs/stores/methodology repos in
 * tmpdir, servers on OS-assigned free ports (never 4317), stopped by PID.
 * Section 2's "server configured with the real root" boots from a COPY of the
 * repo so the assertion that the pass targets the configured root never
 * mutates this checkout.
 *
 * Proves:
 *   1. a scratch server whose registry does NOT contain this repo boots, runs
 *      the boot consolidation pass to completion (non-vacuity), and leaves
 *      this repo's docs/bugs/.arch/findings.json byte-for-byte AND
 *      mtime-untouched (FAILS pre-fix), with no mention of this repo's board
 *      in the pass output (FAILS pre-fix);
 *   2. a server whose registry DOES contain its own repo root still runs the
 *      arch pass against exactly that root (the real-station behavior is
 *      preserved) — proven against a copied root, read-only for this repo;
 *   3. CLAUDE_STATION_NO_WA_CONSOLIDATE=1 suppresses the arch ride-along of a
 *      direct `wa-consolidate --apply` run too, not just the server's spawn
 *      (FAILS pre-fix).
 */
import { spawn, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const REAL_FINDINGS = path.join(ROOT, 'docs', 'bugs', '.arch', 'findings.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

let server = null;
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopByPid(server); process.exit(130); });

/** Snapshot a file's identity: absent | {sha1, mtimeMs}. mtime matters because
 *  rewriting identical bytes is still the mutation this ticket forbids. */
function snap(file) {
  if (!fs.existsSync(file)) return { absent: true };
  const st = fs.statSync(file);
  return { absent: false, sha1: crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex'), mtimeMs: st.mtimeMs };
}
const sameSnap = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function scratchMethodology(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'WORKING_AGREEMENT.v2.md'),
    '# WA (scratch)\n\n## T\n\n### A. Rule\n\n- Prefer small diffs, because review is cheaper.\n');
  for (const a of [['init', '-q'], ['config', 'user.email', 'a@b.c'], ['config', 'user.name', 'v'], ['add', '-A'], ['commit', '-q', '-m', 'x']]) {
    spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  }
}

/** Boot a server from `rootDir`'s checkout, wait for health AND for the boot
 *  consolidation pass to report completion; return the full boot log. */
async function bootAndSettle(rootDir, env) {
  const port = await freePort();
  let log = '';
  server = spawn(process.execPath, [path.join(rootDir, 'src', 'server', 'index.ts')], {
    cwd: rootDir,
    env: { ...env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', (d) => { log += String(d); });
  server.stderr?.on('data', (d) => { log += String(d); });
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    try { await fetch(`http://127.0.0.1:${port}/api/health`); up = true; } catch { await sleep(250); }
  }
  // The boot pass is fire-and-forget; its outcome line is logged when the
  // child closes. Wait for it so post-boot assertions observe a FINISHED pass.
  for (let i = 0; i < 120 && !/WA consolidation pass/.test(log); i++) await sleep(250);
  stopByPid(server);
  server = null;
  await sleep(400);
  return { up, log: () => log };
}

async function main() {
  // The env a harness must NOT need for isolation: the opt-out stays unset so
  // the boot pass genuinely RUNS in sections 1 and 2.
  const baseEnv = { ...process.env };
  delete baseEnv.CLAUDE_STATION_NO_WA_CONSOLIDATE;

  const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug040-'));
  const METH = path.join(SCRATCH, 'meth');
  scratchMethodology(METH);

  console.log('\n=== 1. scratch server, scratch world: this repo\'s arch findings are UNTOUCHED ===');
  const before = snap(REAL_FINDINGS);
  const DATA1 = path.join(SCRATCH, 'data1');
  const STORE1 = path.join(SCRATCH, 'store1');
  fs.mkdirSync(DATA1, { recursive: true });
  fs.mkdirSync(STORE1, { recursive: true });
  const b1 = await bootAndSettle(ROOT, { ...baseEnv, CLAUDE_STATION_DATA: DATA1, CLAUDE_PROJECTS_DIR: STORE1, METHODOLOGY_DIR: METH });
  check('the scratch server booted to health', b1.up, 'health OK');
  check('the boot consolidation pass ran to completion (non-vacuity: not skipped, not hung)',
    /WA consolidation pass/.test(b1.log()), b1.log().split('\n').filter((l) => /consolidation pass/.test(l)).slice(-1)[0] ?? '(no line)');
  const after1 = snap(REAL_FINDINGS);
  check('this repo\'s docs/bugs/.arch/findings.json is UNCHANGED (existence, bytes AND mtime)',
    sameSnap(before, after1), { before, after: after1 });
  check('the pass output never references this repo\'s board dir',
    !b1.log().includes(path.join(ROOT, 'docs', 'bugs')), b1.log().split('\n').filter((l) => /arch-watch|consolidation pass/.test(l)).slice(-2).join(' | '));

  console.log('\n=== 2. a server CONFIGURED with its repo root still runs the arch pass on THAT root (copied root, read-only here) ===');
  const COPY = path.join(SCRATCH, 'rootcopy');
  fs.mkdirSync(COPY, { recursive: true });
  for (const d of ['src', 'scripts', 'docs']) fs.cpSync(path.join(ROOT, d), path.join(COPY, d), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(COPY, 'package.json'));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(COPY, 'node_modules'));
  fs.rmSync(path.join(COPY, 'docs', 'bugs', '.arch'), { recursive: true, force: true });
  const DATA2 = path.join(SCRATCH, 'data2');
  const STORE2 = path.join(SCRATCH, 'store2');
  fs.mkdirSync(DATA2, { recursive: true });
  fs.mkdirSync(STORE2, { recursive: true });
  // Seed the server's OWN registry with its repo root — the "real station" shape.
  fs.writeFileSync(path.join(DATA2, 'registry.json'), `${JSON.stringify({
    version: 1,
    projects: [{ id: 'home', name: 'Home', hostPath: COPY, createdAt: new Date().toISOString() }],
  }, null, 2)}\n`);
  const b2 = await bootAndSettle(COPY, { ...baseEnv, CLAUDE_STATION_DATA: DATA2, CLAUDE_PROJECTS_DIR: STORE2, METHODOLOGY_DIR: METH });
  check('the home-configured server booted and its boot pass completed',
    b2.up && /WA consolidation pass/.test(b2.log()), b2.log().split('\n').filter((l) => /consolidation pass/.test(l)).slice(-1)[0] ?? '(no line)');
  const copyFindings = path.join(COPY, 'docs', 'bugs', '.arch', 'findings.json');
  check('the arch pass RAN against the server\'s configured root (its findings.json was written there)',
    fs.existsSync(copyFindings), copyFindings);
  const after2 = snap(REAL_FINDINGS);
  check('…and THIS repo\'s findings.json is still untouched (the copied-root run was read-only here)',
    sameSnap(before, after2), { before, after: after2 });

  console.log('\n=== 3. CLAUDE_STATION_NO_WA_CONSOLIDATE=1 suppresses the arch ride-along of a direct --apply run ===');
  const PROJ = path.join(SCRATCH, 'proj');
  const projBugs = path.join(PROJ, 'docs', 'bugs');
  fs.mkdirSync(projBugs, { recursive: true });
  fs.writeFileSync(path.join(projBugs, 'BUG-001-x.md'),
    '# BUG-001 — x\n\n- **Status:** VERIFIED\n- **Severity:** med\n- **Area:** x\n- **Reported:** 2026-07-01 by v\n\n## Symptom\nx\n\n## Activity log (APPEND-ONLY)\n');
  const sup = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'wa-consolidate.mjs'), '--apply', '--conventions-dir', PROJ], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...baseEnv, METHODOLOGY_DIR: METH, CLAUDE_STATION_NO_WA_CONSOLIDATE: '1' },
  });
  check('the run says so honestly (suppression is logged, not silent)',
    /arch-watch ride-along suppressed/.test(sup.stdout + sup.stderr), (sup.stdout + sup.stderr).match(/.*suppress.*/i)?.[0] ?? (sup.stdout + sup.stderr).trim().split('\n').slice(-2).join(' | '));
  check('no arch findings were persisted for the target board under the env',
    !fs.existsSync(path.join(projBugs, '.arch', 'findings.json')), path.join(projBugs, '.arch'));
  const unsup = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'wa-consolidate.mjs'), '--apply', '--conventions-dir', PROJ], {
    cwd: ROOT, encoding: 'utf8', env: { ...baseEnv, METHODOLOGY_DIR: METH },
  });
  check('without the env the SAME invocation runs the arch pass for that board (the check is not vacuous)',
    /arch-watch — \d+ recurrence finding/.test(unsup.stdout) && fs.existsSync(path.join(projBugs, '.arch', 'findings.json')),
    unsup.stdout.match(/.*arch-watch.*/)?.[0]);
  const after3 = snap(REAL_FINDINGS);
  check('this repo\'s findings.json survived the whole suite untouched',
    sameSnap(before, after3), { before, after: after3 });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log(`FAILURES:\n${failures.map((f) => `  - ${f}`).join('\n')}`); process.exit(1); }
}

main().catch((e) => {
  console.error(`\nFATAL: ${e.stack || e.message}`);
  stopByPid(server);
  process.exit(1);
});
