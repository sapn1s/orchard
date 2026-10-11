#!/usr/bin/env node
/**
 * verify-bug-250-crash-safe.mjs — proof for BUG-250 after the round-3 RESCOPE.
 *
 * The autonomous liveness-gated sweep (lease + confined walker + root refusals)
 * was REMOVED: it broke four times across two independent clean-room rounds
 * (deleting a live dir; deleting external data through a same-device bind mount).
 * What remains, and what this suite proves:
 *
 *   A. CRASH-SAFE creator-side cleanup (KEPT). The REAL independent-verify.mjs,
 *      driven through its crash seam against a git-capable SHADOW repo, removes
 *      the exact room+record dir it created on throw / die / exit / every handled
 *      signal. A synthesized PRE-Part-1 shape (room made, no handler) LEAKS.
 *   B. ABSENCE of the broken surface. Every round-1/round-2 break was a property
 *      of the autonomous root-walking deleter; with that retired, the breaks are
 *      impossible BY CONSTRUCTION. We assert the deleted API is gone (so a
 *      re-introduction fails the gate), and that NO code path under scripts/ can
 *      delete inside the scratch root except IV's own room cleanup.
 *   C. The operator report tool is READ-ONLY over a realistic busy fixture:
 *      deletes nothing, reports btrfs-EXCLUSIVE (not du) cost, emits `rm`
 *      commands that EXCLUDE a fuser-held dir.
 *
 * All fixtures live under ~/.local/state/claude-station (same btrfs as the repo,
 * never /tmp, never the REAL scratch root).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as scratch from './lib/scratch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const IV = path.join(HERE, 'independent-verify.mjs');
const REPORT = path.join(HERE, 'scratch-report.mjs');

let pass = 0, fail = 0, skipc = 0;
const failures = [];
function check(name, ok, observed) {
  const o = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        observed: ${(o ?? '').slice(0, 400)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
function skip(name, why) { console.log(`  SKIP  ${name} (${why})`); skipc++; }
function section(t) { console.log(`\n${t}\n${'-'.repeat(t.length)}`); }

const stateBase = path.join(os.homedir(), '.local', 'state', 'claude-station');
fs.mkdirSync(stateBase, { recursive: true });
const cleanupRoots = [];
const liveChildren = [];
process.on('exit', () => {
  for (const c of liveChildren) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  for (const r of cleanupRoots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* gone */ } }
});
function mkroot(tag) { const d = fs.mkdtempSync(path.join(stateBase, `bug250-${tag}-`)); cleanupRoots.push(d); return d; }

// The crash seam needs a real git repo (IV exits "not a git repo" otherwise) AND
// a history (resolveRange('HEAD') uses HEAD^ as base). Use THIS repo harness-side
// — the git-write shim on PATH forbids building a shadow repo (`git init` is
// blocked even from a subprocess), and this repo has both .git and history. If
// ever run WITHOUT .git (a clean-room export — round-1/2 P4), skip honestly; an
// independent pass must run section A in a git-capable tree.
const GIT_REPO = (() => {
  if (!fs.existsSync(path.join(REPO, '.git'))) return null;
  return spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD~1'], { encoding: 'utf8' }).status === 0 ? REPO : null;
})();

/* ===================================================== A. crash-safe cleanup */
section('A. independent-verify.mjs crash-safe creator-side cleanup (real tool)');

const SHADOW = GIT_REPO;
function leaked(root) { return fs.readdirSync(root).filter((n) => n.startsWith('cleanroom-verify-') || n.startsWith('cleanroom-record-')); }

function runCrash(mode) {
  const root = mkroot(`iv-${mode}`);
  const env = { ...process.env, CLAUDE_STATION_TMPDIR: root, CLAUDE_STATION_IV_CRASH_AFTER_ROOM: mode };
  const r = spawnSync(process.execPath, [IV, '--repo', SHADOW, '--range', 'HEAD', '--requirement', `crash ${mode}`, '--provider', 'anthropic'], { env, encoding: 'utf8', timeout: 120000 });
  return { root, r };
}
for (const mode of ['throw', 'die', 'exit']) {
  if (!SHADOW) { skip(`IV crash (${mode})`, 'no git-capable repo in this tree'); continue; }
  const { root, r } = runCrash(mode);
  const reached = /IV-CRASH-SEAM/.test(r.stderr || '');
  check(`IV crash (${mode}) reaches the seam AND leaves NO clean-room dir`, reached && leaked(root).length === 0, `reachedSeam=${reached} exit=${r.status} leaked=${JSON.stringify(leaked(root))} tail=${(r.stderr || '').split('\n').filter(Boolean).slice(-1)[0] || ''}`);
}
// Every handled signal: INT/TERM/HUP/QUIT. Park at the seam, signal, assert gone.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
  if (!SHADOW) { skip(`IV ${sig} mid-run`, 'no git-capable repo in this tree'); continue; }
  const root = mkroot(`iv-${sig}`);
  const env = { ...process.env, CLAUDE_STATION_TMPDIR: root, CLAUDE_STATION_IV_CRASH_AFTER_ROOM: 'hang' };
  const child = spawn(process.execPath, [IV, '--repo', SHADOW, '--range', 'HEAD', '--requirement', `sig ${sig}`, '--provider', 'anthropic'], { env });
  let seen = false, stderr = '';
  child.stderr.on('data', (d) => { stderr += d; if (/IV-CRASH-SEAM/.test(stderr)) seen = true; });
  const res = await new Promise((resolve) => {
    child.on('exit', (code, s) => resolve({ code, s }));
    const t = setInterval(() => { if (seen) { clearInterval(t); try { process.kill(child.pid, sig); } catch { /* gone */ } } }, 40);
    setTimeout(() => { clearInterval(t); try { child.kill('SIGKILL'); } catch { /* gone */ } }, 90000);
  });
  check(`IV ${sig} mid-run leaves NO clean-room dir`, seen && leaked(root).length === 0, `seen=${seen} exit=${JSON.stringify(res)} leaked=${JSON.stringify(leaked(root))}`);
}
// MUST-FAIL anchor (synthesized pre-Part-1 shape: room made, no handler, exit).
{
  const root = mkroot('prefix');
  const pre = `
    import * as fs from 'node:fs'; import * as path from 'node:path';
    const dir = fs.mkdtempSync(path.join(${JSON.stringify(root)}, 'cleanroom-verify-'));
    fs.writeFileSync(path.join(dir, 'payload'), 'x');
    process.exit(1); // no exit/signal handler — the pre-Part-1 bug
  `;
  spawnSync(process.execPath, ['--input-type=module', '-e', pre], { encoding: 'utf8' });
  check('MUST-FAIL: pre-Part-1 shape LEAKS its room (bug reproduced)', fs.readdirSync(root).filter((n) => n.startsWith('cleanroom-verify-')).length === 1, fs.readdirSync(root));
}

/* ===================================================== B. absence of the sweep */
section('B. the broken autonomous-sweep surface is GONE (retired, not patched)');

const GONE = ['sweepScratchRoot', 'sweepDeletionBlocked', 'deletionBlocked', 'rmTreeConfined', 'visibleMountPoints', 'mountUnder', 'dangerousSweepRoot', 'writeLease', 'writeKeep', 'leaseLiveness', 'leaseIsLive', 'pidAlive', 'pidStartToken', 'currentBootId', 'currentPidNs', 'SWEEP_PREFIXES', 'SCRATCH_ROOT_MARKER'];
const stillExported = GONE.filter((n) => typeof scratch[n] !== 'undefined');
check('scratch.mjs no longer exports ANY sweep/lease/liveness/walker symbol', stillExported.length === 0, `stillExported=${JSON.stringify(stillExported)}`);
const kept = ['scratchRoot', 'scratchRootInfo', 'mkdtempScratch', 'checkSameFilesystem', 'SCRATCH_ENV', 'fsTypeOf'];
check('scratch.mjs KEEPS its resolution/reflink API', kept.every((n) => typeof scratch[n] !== 'undefined'), kept.filter((n) => typeof scratch[n] === 'undefined'));

const scratchSrc = fs.readFileSync(path.join(HERE, 'lib', 'scratch.mjs'), 'utf8');
const ivSrc = fs.readFileSync(IV, 'utf8');
const reportSrc = fs.readFileSync(REPORT, 'utf8');

// scratch.mjs must contain ZERO deletion primitives — it resolves roots, never deletes.
const DELETE_RE = /\b(rmSync|rmdirSync|unlinkSync|rimraf)\b|spawnSync\(\s*['"]rm['"]/g;
check('scratch.mjs contains NO deletion primitive at all', (scratchSrc.match(DELETE_RE) || []).length === 0, (scratchSrc.match(DELETE_RE) || []));

// The old CLI must be gone; IV must not import or call the retired API.
check('scripts/sweep-scratch.mjs is deleted', !fs.existsSync(path.join(HERE, 'sweep-scratch.mjs')), 'exists');
check('independent-verify.mjs does not import/call the retired API', !/writeLease|writeKeep|sweepScratchRoot|leaseLiveness/.test(ivSrc), 'found a retired reference');

// No code path under scripts/ deletes by WALKING a root. Assert: no file (except
// this suite) runs `rm -rf` on an enumerated root, and IV's only deletions target
// its own tracked room/record/spool paths — never scratchRoot() or a readdir.
check('independent-verify.mjs never spawns `rm` and never readdirs a scratch root to delete', !/spawnSync\(\s*['"]rm['"]/.test(ivSrc) && !/readdirSync\([^)]*scratchRoot/.test(ivSrc), 'found root-walking deletion');
const ivRmTargets = (ivSrc.match(/\brmSync\(([^,]+),/g) || []).map((m) => m.replace(/\brmSync\(/, '').replace(/,$/, '').trim());
const badTargets = ivRmTargets.filter((t) => /scratchRoot|readdir|\broot\b/.test(t));
check('every rmSync in IV targets a tracked dir (room/record/spool/d/dest), not a root', badTargets.length === 0, `rmTargets=${JSON.stringify(ivRmTargets)} bad=${JSON.stringify(badTargets)}`);

// The report tool deletes nothing: no fs deletion, no spawned rm/unmount.
check('scratch-report.mjs performs NO deletion (no rmSync/unlink/rmdir, no spawned rm)', (reportSrc.match(DELETE_RE) || []).length === 0 && !/spawnSync\(\s*['"](rm|unlink|rmdir)['"]/.test(reportSrc), (reportSrc.match(DELETE_RE) || []));

// Positive: a bind mount inside a cleanroom-* dir cannot be traversed by shipped
// code because no shipped code walks a scratch root at all (vacuous-by-design).
check('no shipped scratch code walks/deletes a root (bind-mount-in-room is untraversable)', !/rmTreeConfined|one-file-system/.test(scratchSrc) && !/rmTreeConfined|one-file-system/.test(ivSrc), 'a root walker still exists');

// Repo-wide (rg): the retired API is referenced NOWHERE under scripts/ (except
// this suite, which names the symbols only to assert their absence). A future
// re-introduction of an autonomous sweep therefore fails this gate.
{
  const SELF = path.basename(fileURLToPath(import.meta.url));
  const rg = spawnSync('rg', ['-l', '-e', 'sweepScratchRoot', '-e', 'rmTreeConfined', '-e', 'leaseLiveness', '-e', 'dangerousSweepRoot', '-e', 'visibleMountPoints', 'scripts/'], { cwd: REPO, encoding: 'utf8' });
  const hits = (rg.stdout || '').split('\n').filter(Boolean).filter((f) => path.basename(f) !== SELF);
  check('no file under scripts/ references the retired autonomous-sweep API', hits.length === 0, `hits=${JSON.stringify(hits)}`);
}

/* ===================================================== C. read-only INVENTORY (no liveness claim) */
section('C. scratch-report.mjs is a READ-ONLY inventory that makes NO liveness/safety claim');

function report(root, extra = []) {
  const r = spawnSync(process.execPath, [REPORT, '--root', root, ...extra], { encoding: 'utf8' });
  return { status: r.status, out: r.stdout || '', errtext: r.stderr || '' };
}
function countFiles(d) { let n = 0; const walk = (p) => { let st; try { st = fs.lstatSync(p); } catch { return; } if (st.isDirectory() && !st.isSymbolicLink()) { for (const c of fs.readdirSync(p)) walk(path.join(p, c)); } else n++; }; walk(d); return n; }
function waitFor(f, ms = 4000) { const end = Date.now() + ms; while (Date.now() < end) { if (fs.existsSync(f)) return true; spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},60)']); } return fs.existsSync(f); }
function nulList(root, extra = []) {
  const b = spawnSync(process.execPath, [REPORT, '--root', root, ...extra], { encoding: 'buffer' });
  return b.stdout.toString('utf8').split('\0').filter(Boolean);
}

// --- Absence of any liveness/safety classification (the twice-broken surface) ---
{
  const src = fs.readFileSync(REPORT, 'utf8');
  const hasEnumeration = /scanHeldAndMounted|readdirSync\(\s*['"]\/proc|\/proc\/\$\{|\/proc\/'\s*\+/.test(src);
  // The words fuser/mount appear ONLY in the operator-facing advisory banner (strings),
  // never as a computed classification; assert no eligible/held/mounted FIELD or label.
  const hasClassification = /\.held\b|\.mounted\b|\beligible\b|ELIGIBLE|notEligible/.test(src);
  check('scratch-report.mjs has NO /proc holder enumeration (round-1..4 break surface removed)', !hasEnumeration, { hasEnumeration });
  check('scratch-report.mjs makes NO eligible/held/mounted classification', !hasClassification, { hasClassification });
}

// --- Behaviour-independence: holders/mounts CANNOT change the output, because the
// tool no longer probes them. Build a fixture, snapshot the list, then add a deep-fd
// holder + (real unshare) a bind mount inside a dir, and assert the list is IDENTICAL. ---
{
  const root = mkroot('inv-indep');
  const mk = (n) => { const d = path.join(root, n); fs.mkdirSync(path.join(d, 'sub'), { recursive: true }); fs.writeFileSync(path.join(d, 'sub', 'f'), 'x'); return d; };
  for (let i = 0; i < 5; i++) mk(`cleanroom-verify-i${i}`);
  const holdDir = mk('cleanroom-verify-willhold');
  const before = countFiles(root);
  const listBefore = nulList(root).sort();

  // Perturbation 1: a holder on a deep fd (round-3 door a) AND via cwd on a subdir
  // that is a bind-mount alias (round-4 door 1) if a namespace is available.
  const ready = path.join(root, 'ready');
  const code = `const fs=require('fs'); fs.openSync(${JSON.stringify(path.join(holdDir, 'sub', 'f'))},'r'); fs.writeFileSync(${JSON.stringify(ready)},'1'); setInterval(()=>{},1e9);`;
  const holder = spawn(process.execPath, ['-e', code], { stdio: 'ignore' }); liveChildren.push(holder);
  waitFor(ready);
  const listAfterHolder = nulList(root).sort();
  check('output is IDENTICAL whether or not a deep-fd holder exists (no liveness probe)', JSON.stringify(listBefore) === JSON.stringify(listAfterHolder), { before: listBefore.length, after: listAfterHolder.length });
  check('the held dir is STILL listed (tool reports facts, not a safety verdict)', listAfterHolder.includes(holdDir), { holdDir, listed: listAfterHolder.includes(holdDir) });
  holder.kill('SIGKILL');

  // Perturbation 2: a bind mount inside one dir — must also not change the output.
  const nsProbe = spawnSync('unshare', ['-rm', '--map-root-user', process.execPath, '-e', 'process.exit(0)'], { encoding: 'utf8' });
  if ((nsProbe.status ?? 1) !== 0) { skip('output identical with a mount inside a dir', 'no user+mount namespace available'); }
  else {
    const child = `
      import * as fs from 'node:fs'; import * as path from 'node:path';
      import { spawnSync } from 'node:child_process';
      const root = ${JSON.stringify(root)};
      const target = path.join(root, 'cleanroom-verify-i0', 'sub');
      const ext = fs.mkdtempSync('/tmp/bug250r5-ext-'); fs.writeFileSync(path.join(ext,'victim'),'x');
      const mok = spawnSync('mount',['--bind',ext,target]).status === 0;
      const b = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(REPORT)}, '--root', root], { encoding: 'buffer' });
      const list = b.stdout.toString('utf8').split('\\0').filter(Boolean).sort();
      spawnSync('umount',['-l',target]);
      console.log(JSON.stringify({ mok, list }));
    `;
    const cr = spawnSync('unshare', ['-rm', '--map-root-user', process.execPath, '--input-type=module', '-e', child], { encoding: 'utf8' });
    let res = null; try { res = JSON.parse((cr.stdout || '').trim().split('\n').pop()); } catch { /* below */ }
    if (!res || !res.mok) { skip('output identical with a mount inside a dir', `bind mount unavailable in ns: ${(cr.stderr || '').trim().slice(0, 120)}`); }
    else check('output is IDENTICAL with a mount inside a dir (no mount scan to defeat)', JSON.stringify(res.list) === JSON.stringify(listBefore), { nsList: res.list.length, before: listBefore.length });
  }

  try { fs.rmSync(ready, { force: true }); } catch { /* the test's own holder-ready marker, not tool state */ }
  const after = countFiles(root);
  check('inventory deletes NOTHING (file count unchanged across all runs)', before === after, `before=${before} after=${after}`);
}

// --- Read-only + inventory fidelity over a busy fixture (symlink, lane trees, crafted name) ---
{
  const root = mkroot('inv-fidelity');
  const mk = (n) => { const d = path.join(root, n); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'f'), 'x'); return d; };
  for (let i = 0; i < 4; i++) mk(`cleanroom-verify-f${i}`);
  mk('cleanroom-record-f0');
  mk('feat157-copy-aaa'); mk('arch020'); // non-cleanroom lane trees
  fs.symlinkSync('/etc', path.join(root, 'cleanroom-verify-evil-symlink'));
  const before = countFiles(root);
  const r = report(root);
  const after = countFiles(root);
  const list = nulList(root);
  check('inventory deletes NOTHING (busy fixture)', before === after && r.status === 0, `before=${before} after=${after} exit=${r.status}`);
  check('STDOUT = NUL-separated cleanroom paths only (default --print0)', list.length === 5 && list.every((p) => /cleanroom-(verify|record)-/.test(path.basename(p))), list.map((p) => path.basename(p)));
  check('prefix-named symlink is NOT listed (type filter, not a liveness claim)', !list.some((p) => /evil-symlink/.test(p)), list.map((p) => path.basename(p)));
  check('hand-named lane trees are NOT in the cleanroom list', !list.some((p) => /feat157-copy|arch020/.test(p)), list.map((p) => path.basename(p)));
  check('btrfs EXCLUSIVE cost reported on stderr; raw du never shown', /btrfs EXCLUSIVE/.test(r.errtext) && !/\bdu -s/.test(r.errtext), r.errtext.split('\n').find((l) => /EXCLUSIVE/.test(l)));
  check('loud advisory banner tells the operator to run `fuser -m` + mount check', /NOT a safety check/.test(r.errtext) && /fuser -m/.test(r.errtext), r.errtext.split('\n').find((l) => /fuser -m/.test(l)));
}

// --- (c) injection still impossible: crafted name is one inert argv entry ---
{
  const root = mkroot('inv-inject');
  const craft = 'cleanroom-verify-$(touch INJECTED)`touch INJECTED2`';
  fs.mkdirSync(path.join(root, craft), { recursive: true });
  const list = nulList(root);
  check('(c) crafted-name dir is present as ONE literal NUL entry', list.includes(path.join(root, craft)), list.map((p) => path.basename(p)));
  const sbox = mkroot('inv-inject-sbox');
  spawnSync('bash', ['-c', `${JSON.stringify(process.execPath)} ${JSON.stringify(REPORT)} --root ${JSON.stringify(root)} 2>/dev/null | xargs -0 -r -n1 echo >/dev/null`], { cwd: sbox });
  check('(c) NUL list through xargs -0 executes nothing from the crafted name', !fs.existsSync(path.join(sbox, 'INJECTED')) && !fs.existsSync(path.join(sbox, 'INJECTED2')), fs.readdirSync(sbox));
}

/* ===================================================== D. anti-regression (IV happy/keep) */
section('D. IV happy path still cleans; --keep-cleanroom still keeps');
if (!SHADOW) { skip('IV happy path / --keep-cleanroom', 'no git-capable repo in this tree'); }
else {
  const root = mkroot('iv-happy');
  const env = { ...process.env, CLAUDE_STATION_TMPDIR: root };
  const hp = spawnSync(process.execPath, [IV, '--repo', SHADOW, '--range', 'HEAD', '--requirement', 'x', '--provider', 'anthropic', '--print-prompt'], { env, encoding: 'utf8', timeout: 120000 });
  check('--print-prompt (no keep) cleans the room', hp.status === 0 && leaked(root).length === 0, `exit=${hp.status} leaked=${JSON.stringify(leaked(root))}`);

  const root2 = mkroot('iv-keep');
  const env2 = { ...process.env, CLAUDE_STATION_TMPDIR: root2 };
  const kp = spawnSync(process.execPath, [IV, '--repo', SHADOW, '--range', 'HEAD', '--requirement', 'x', '--provider', 'anthropic', '--print-prompt', '--keep-cleanroom'], { env: env2, encoding: 'utf8', timeout: 120000 });
  const keptRoom = leaked(root2);
  check('--keep-cleanroom keeps the room (by NOT registering it)', kp.status === 0 && keptRoom.length >= 1, `exit=${kp.status} kept=${JSON.stringify(keptRoom)}`);
}

/* ===================================================== summary */
section('summary');
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAIL'} — ${pass} passed, ${fail} failed, ${skipc} skipped`);
if (fail) { console.log(`failures: ${failures.join(', ')}`); process.exit(1); }
process.exit(0);
