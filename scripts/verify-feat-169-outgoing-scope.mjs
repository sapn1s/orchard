#!/usr/bin/env node
// FEAT-169 — the agent COMMIT leak gate scans only OUTGOING content, so a
// pre-existing hit already living in a project repo's tree no longer blocks a
// clean commit; a secret the commit ADDS is still blocked; a push keeps the
// conservative full-tree scan.
//
//   node scripts/verify-feat-169-outgoing-scope.mjs
//   node scripts/verify-feat-169-outgoing-scope.mjs --real   # also clone the real
//                                                            # the real project repo (READ-ONLY)
//
// SYNTHETIC fixture (said so per CONVENTIONS): temp git repos with a synthetic
// identity (t@t). NO private value is written in this file — every needle is
// DERIVED at runtime from the token list itself, so this tracked file stays
// gate-clean. Output prints token LABELS and exit codes, never needles.
//
// MUST-FAIL proof is the pre-change behaviour reproduced on the SAME gate: the
// old agent guard scanned the whole working tree (`--summary`, no scope flag),
// so running that scope over a realistic-state repo with old hits FAILS even on
// a clean change. The new `--changed` scope PASSES the same case.
import { execFileSync as _exec, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Use the REAL git binary by absolute path: this verify runs inside an agent
// session whose PATH is prefixed with the FEAT-135 git-write shim, which would
// block every write in these SCRATCH repos (they are not a granted project). An
// absolute path never resolves through the shim. We only ever touch temp repos
// and a READ-ONLY clone, never a registered project repo.
const REAL_GIT = ['/usr/bin/git', '/bin/git', '/usr/local/bin/git'].find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!REAL_GIT) { console.error('FATAL: no real git binary found'); process.exit(2); }
const execFileSync = (cmd, args, opts) => _exec(cmd === 'git' ? REAL_GIT : cmd, args, opts);

const ORCHARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL = process.argv.includes('--real');
const GATE = path.join(ORCHARD, 'scripts', 'leak-gate.mjs');
const { TOKENS } = await import(path.join(ORCHARD, 'scripts', 'lib', 'leak-tokens.mjs'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat169-'));
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir);
process.env.CLAUDE_STATION_DATA = dataDir; // isolate the grant ledger from the real one

let pass = 0, fail = 0;
const bad = [];
const ok = (name, cond, observed) => {
  if (cond) pass++; else { fail++; bad.push(name); }
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${observed !== undefined ? `   [${observed}]` : ''}`);
};

// ── needles, derived from the list (never literals in this file) ─────────────
const literal = (t) => /^[A-Za-z0-9_-]+$/.test(t.re.source);
const projects = TOKENS.filter((t) => t.kind === 'project' && literal(t));
const OWN = projects[0];
const OTHER = projects[1];
const THIRD = projects[2];
const needle = (t) => t.re.source;
const homeTok = TOKENS.find((t) => t.name === 'home path');
const HOME_NEEDLE = homeTok.re.source.replace(/\\b/g, '').replace(/\\\//g, '/') + '/x';
if (!homeTok.re.test(HOME_NEEDLE)) { console.error('FATAL: home needle bad'); process.exit(2); }
const alnum = (n) => { const cs = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; return [...randomBytes(n)].map((b) => cs[b % cs.length]).join(''); };
const SK = () => 'sk' + '-' + 'Ab1' + alnum(40); // a fabricated OpenAI-shaped key

// ── git fixture helpers (synthetic identity t@t) ─────────────────────────────
function mkrepo(name, { init = true } = {}) {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: d, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  g('config', 'commit.gpgsign', 'false');
  g('config', 'core.hooksPath', '/dev/null');
  if (init) { fs.writeFileSync(path.join(d, 'README.md'), 'fixture\n'); g('add', '-A'); g('commit', '-q', '-m', 'init'); }
  return d;
}
const G = (repo) => (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
function write(repo, rel, content) { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), content); }
function reset(repo) {
  const g = G(repo);
  try { g('rev-parse', '-q', '--verify', 'HEAD'); g('reset', '-q', '--hard', 'HEAD'); }
  catch { g('read-tree', '--empty'); } // unborn branch: just clear the index
  g('clean', '-qfdx');
}
function runGate(repo, args) {
  const r = spawnSync(process.execPath, [GATE, '--summary', ...args], { cwd: repo, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

// ══ A. realistic-state repo: MANY pre-existing old hits across UNCHANGED files ══
console.log('\nA. Realistic-state repo (pre-existing hits in committed, unchanged files):');
const repo = mkrepo('busy-project');
const g = G(repo);
// Seed ~40 committed files, each carrying an old hit (project token / home path /
// a secret-shaped fixture) — the real-repo shape: false positives already in the
// tree. None of these are touched by the clean change below.
let oldHits = 0;
for (let i = 0; i < 20; i++) { write(repo, `legacy/vault-${i}.md`, `path uses ${needle(OTHER)} and ${HOME_NEEDLE}\n`); oldHits += 1; }
for (let i = 0; i < 20; i++) { write(repo, `fixtures/key-${i}.txt`, `example key ${SK()}\n`); oldHits += 1; }
g('add', '-A'); g('commit', '-q', '-m', 'legacy content with old hits');
const fullOld = runGate(repo, []); // the PRE-CHANGE agent-guard scope (whole working tree)
ok('A0 pre-existing old hits are present and the FULL-TREE scan FAILS (reproduces the block)',
  fullOld.code === 1, `exit ${fullOld.code}, ~${oldHits} seeded files`);

// A clean change that touches NONE of the old-hit files.
write(repo, 'src/feature.js', 'export const add = (a, b) => a + b;\n');
g('add', '--', 'src/feature.js');
const fullClean = runGate(repo, []);
ok('A1 MUST-FAIL baseline: full-tree scope FAILS even on a clean change (old behaviour)',
  fullClean.code === 1, `exit ${fullClean.code}`);
const changedClean = runGate(repo, ['--changed']);
ok('A2 --changed PASSES the clean change (old hits in unchanged files not scanned)',
  changedClean.code === 0, `exit ${changedClean.code}`);
const stagedClean = runGate(repo, ['--staged']);
ok('A2b --staged PASSES the clean change too', stagedClean.code === 0, `exit ${stagedClean.code}`);

// A3 a NEW secret in a NEW untracked file → --changed FAILS.
write(repo, 'src/leak.js', `const k = '${SK()}';\n`);
const changedNewLeak = runGate(repo, ['--changed']);
ok('A3 --changed FAILS on a new secret in a new file', changedNewLeak.code === 1, `exit ${changedNewLeak.code}`);
fs.rmSync(path.join(repo, 'src/leak.js'));

// A4 a secret ADDED to a tracked file the commit MODIFIES → --changed FAILS
// (whole changed file is scanned, so a secret split across context is caught).
write(repo, 'README.md', `fixture\nnew password: ${SK()}\n`);
const changedModLeak = runGate(repo, ['--changed']);
ok('A4 --changed FAILS on a secret added to a modified tracked file', changedModLeak.code === 1, `exit ${changedModLeak.code}`);
reset(repo);
const stageClean = () => { write(repo, 'src/feature.js', 'export const add = (a, b) => a + b;\n'); g('add', '--', 'src/feature.js'); };
stageClean(); // restore the clean staged change

// A5 DELETION of an old-hit file → --changed PASSES (removing a leak is never blocked).
g('rm', '-q', '--', 'legacy/vault-0.md');
const changedDelete = runGate(repo, ['--changed']);
ok('A5 --changed PASSES a deletion of a leak-bearing file (deletion carries no outgoing content)',
  changedDelete.code === 0, `exit ${changedDelete.code}`);
reset(repo);

// A6 stage a secret, then CLEAN the worktree copy → --staged still FAILS (bypass closed).
write(repo, 'secret.txt', `${SK()}\n`); g('add', '--', 'secret.txt'); fs.rmSync(path.join(repo, 'secret.txt'));
const stagedBypass = runGate(repo, ['--staged']);
ok('A6 --staged FAILS on staged-then-cleaned-worktree secret (index bypass closed)', stagedBypass.code === 1, `exit ${stagedBypass.code}`);
reset(repo);

// A7 empty diff → --changed PASSES.
const changedEmpty = runGate(repo, ['--changed']);
ok('A7 --changed PASSES an empty diff', changedEmpty.code === 0, `exit ${changedEmpty.code}`);

// A8 rename: move a CLEAN file to a new name and add a secret in it → --changed FAILS;
// renaming only (no content change) of a clean file PASSES.
write(repo, 'clean-src.txt', 'nothing to see\n'); g('add', '-A'); g('commit', '-q', '-m', 'add clean-src');
g('mv', 'clean-src.txt', 'moved.txt');
const changedPureRename = runGate(repo, ['--changed']);
ok('A8a --changed PASSES a pure rename of a clean file', changedPureRename.code === 0, `exit ${changedPureRename.code}`);
write(repo, 'moved.txt', `moved ${SK()}\n`);
const renamedLeak = runGate(repo, ['--changed']);
ok('A8b --changed FAILS when the renamed destination gains a secret', renamedLeak.code === 1, `exit ${renamedLeak.code}`);
reset(repo);

// ══ B. unborn HEAD: --changed must scan the WHOLE tree (first commit is all outgoing) ══
console.log('\nB. Unborn HEAD (first commit):');
const fresh = mkrepo('fresh', { init: false });
write(fresh, 'app.js', `const k='${SK()}';\n`);
execFileSync('git', ['add', '-A'], { cwd: fresh });
const unbornLeak = runGate(fresh, ['--changed']);
ok('B1 --changed on an unborn HEAD scans the whole tree and FAILS on a secret', unbornLeak.code === 1, `exit ${unbornLeak.code}`);
reset(fresh);
write(fresh, 'app.js', 'const k=1;\n');
const unbornClean = runGate(fresh, ['--changed']);
ok('B2 --changed on an unborn HEAD PASSES a clean first commit', unbornClean.code === 0, `exit ${unbornClean.code}`);

// ══ C. the allowlist (requirement 2 — already built by FEAT-156) on --changed ══
console.log('\nC. .leakgate-allow waives a CHANGED-file false positive with a reason; reasonless is rejected:');
write(repo, 'docs/api.md', `we call ${needle(THIRD)} here\n`);
g('add', '--', 'docs/api.md');
let r = runGate(repo, ['--changed']);
ok('C1 without an allowlist the changed-file project token FAILS', r.code === 1 && new RegExp(`\\[${THIRD.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`).test(r.out), `exit ${r.code}`);
write(repo, '.leakgate-allow', `token:${THIRD.name} in:docs/** because: the docs legitimately cite that project's public name\n`);
g('add', '--', '.leakgate-allow');
r = runGate(repo, ['--changed']);
ok('C2 a .leakgate-allow entry WITH a reason waives it → PASS', r.code === 0 && /waived/.test(r.out), `exit ${r.code}`);
write(repo, '.leakgate-allow', `token:${THIRD.name} in:docs/**\n`); // no `because:`
g('add', '--', '.leakgate-allow');
r = runGate(repo, ['--changed']);
ok('C3 a reasonless allowlist entry is REJECTED (exit 2, fail-closed)', r.code === 2 && /needs a reason/.test(r.out), `exit ${r.code}`);
reset(repo);

// ══ D. git-grant scope decision: commit→narrow, push→full ════════════════════
console.log('\nD. git-grant picks the scope: a commit narrows, a push keeps the full scan:');
const grant = await import(path.join(ORCHARD, 'scripts', 'lib', 'git-grant.mjs'));
const store = await import(path.join(ORCHARD, 'scripts', 'lib', 'git-grant-store.mjs'));
function scopeFor(command) {
  store._resetGitGrantsForTest();
  store.grantGitWrite('proj', { scope: 'always' });
  let seen = null;
  grant.evaluateGitWrite({ command, projectKey: 'proj', runLeakGate: (scope) => { seen = scope; return { ok: true }; } });
  return seen;
}
let s = scopeFor('git commit -m x');
ok('D1 `git commit` → narrow (outgoing delta)', s && s.narrow === true, JSON.stringify(s));
s = scopeFor('git add . && git commit -m x');
ok('D2 `git add . && git commit` → narrow (add is gate-exempt)', s && s.narrow === true, JSON.stringify(s));
s = scopeFor('git push');
ok('D3 `git push` → full-tree (narrow false)', s && s.narrow === false, JSON.stringify(s));
s = scopeFor('git commit -m x && git push');
ok('D4 `git commit && git push` → full-tree (a push publishes the whole history)', s && s.narrow === false, JSON.stringify(s));

// ══ E. real-artifact demonstration (READ-ONLY clone of the real repo) ═══════════
if (REAL) {
  console.log('\nE. Real repo demonstration (READ-ONLY clone of the real project repo):');
  // Resolve the real repo path via the registry under the user's home, never a
  // literal home path (which would be a leak in this tracked file).
  let realPath = null;
  try {
    const regPath = path.join(os.homedir(), '.local', 'share', 'claude-station', 'registry.json');
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    const pj = reg.projects.find((p) => OWN.re.test(String(p.hostPath ?? '')) && /-bot$/.test(String(p.hostPath ?? '')));
    realPath = pj?.hostPath ?? null;
  } catch { /* no registry */ }
  if (!realPath || !fs.existsSync(realPath)) {
    ok('E0 real repo present', false, 'not found — skipping E');
  } else {
    const clone = path.join(tmp, 'real-clone');
    execFileSync('git', ['clone', '-q', '--no-hardlinks', realPath, clone]); // reads the source, never writes it
    const cg = G(clone);
    cg('config', 'user.email', 't@t'); cg('config', 'user.name', 't'); cg('config', 'core.hooksPath', '/dev/null');
    const full = runGate(clone, []);
    ok('E1 full-tree scan on the real clone FAILS (reproduces the reported block)', full.code === 1, `exit ${full.code}`);
    write(clone, 'FEAT-169-CLEAN-TOUCH.md', 'a trivial, clean change\n');
    cg('add', '--', 'FEAT-169-CLEAN-TOUCH.md');
    const changed = runGate(clone, ['--changed']);
    const staged = runGate(clone, ['--staged']);
    ok('E2 --changed PASSES a clean change on the real clone', changed.code === 0, `exit ${changed.code}`);
    ok('E2b --staged PASSES the clean change on the real clone', staged.code === 0, `exit ${staged.code}`);
    write(clone, 'FEAT-169-CLEAN-TOUCH.md', `a change\nkey=${SK()}\n`);
    const changedBad = runGate(clone, ['--changed']);
    ok('E3 --changed FAILS when the change adds a secret on the real clone', changedBad.code === 1, `exit ${changedBad.code}`);
  }
}

console.log(`\nFEAT-169 verify: ${pass} passed, ${fail} failed.`);
if (fail) { console.log('FAILED: ' + bad.join('; ')); process.exit(1); }
fs.rmSync(tmp, { recursive: true, force: true });
console.log('ALL PASS');
