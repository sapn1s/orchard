#!/usr/bin/env node
/**
 * verify-feat-135-git-shim.mjs — FEAT-135.
 *
 * Proves the invocation-layer git shim (scripts/lib/git-shim.mjs) closes the
 * subprocess-evasion hole in the FEAT-108 command-string git-write block, WITHOUT
 * breaking the sanctioned FEAT-134 temp-index snapshot.
 *
 * Legs:
 *   [must-FAIL] with NO shim, a node subprocess performs a git write the shell
 *     hook refuses — the evasion is real.
 *   [unit] decideGitShim classifies reads/writes/sanctioned-plumbing correctly.
 *   [e2e]  with the shim on PATH, node-subprocess commit / reset --hard are
 *     REFUSED (nonzero, HEAD unchanged, loud stderr); reads still work; an
 *     absolute-path git call is asserted to bypass (documented gap).
 *   [sanctioned] snapshotWorkingTree runs WITH the shim on PATH against the REAL
 *     repo and succeeds; the real .git/index is byte-identical and HEAD unchanged.
 *
 * Scratch repos live under os.tmpdir(); the real repo is only READ (plus the
 * dangling objects snapshotWorkingTree creates by design — no index/ref/worktree
 * mutation).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installGitShim, decideGitShim } from './lib/git-shim.mjs';
import { decideGitWrite } from './lib/git-write-policy.mjs';
import { snapshotWorkingTree } from './lib/tree-snapshot.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'feat135-'));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };

// ---- must-FAIL: the hook allows a node-subprocess git write ----
console.log('[must-FAIL] the command-string hook cannot see subprocess git');
ok(decideGitWrite('git commit -m x').allow === false, 'hook refuses shell `git commit`');
ok(decideGitWrite(`node -e 'require("child_process").execFileSync("git",["commit"])'`).allow === true,
  'hook ALLOWS the node -e form (the hole)');
{
  const tw = fs.mkdtempSync(path.join(SCRATCH, 'mf-'));
  const g = (...a) => execFileSync('git', ['-C', tw, ...a], { encoding: 'utf8' });
  g('init', '-q'); g('config', 'user.email', 'x@x'); g('config', 'user.name', 'x');
  fs.writeFileSync(path.join(tw, 'a'), '1'); g('add', 'a'); g('commit', '-q', '-m', 'b');
  const h0 = g('rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(tw, 'a'), '2');
  spawnSync(process.execPath, ['-e',
    `require('child_process').execFileSync('git',['-C',${JSON.stringify(tw)},'commit','-am','evil'])`], { encoding: 'utf8' });
  ok(h0 !== g('rev-parse', 'HEAD').trim(), 'NO shim: node subprocess moved HEAD (evasion confirmed)');
}

// Install shim onto a COPY of env (as the runtime would for a session).
const { env: shimEnv, shimDir } = installGitShim(process.env, { baseDir: SCRATCH });

// ---- unit ----
console.log('\n[unit] decideGitShim classification');
const tmpIdx = { GIT_INDEX_FILE: path.join(os.tmpdir(), 'x-idx') };
ok(decideGitShim(['status']).allow, 'read: status allowed');
ok(decideGitShim(['-C', REPO, 'log']).allow, 'read: -C <repo> log allowed');
ok(!decideGitShim(['commit', '-m', 'x']).allow, 'write: commit refused');
ok(!decideGitShim(['reset', '--hard']).allow, 'write: reset --hard refused');
ok(!decideGitShim(['checkout', '.']).allow, 'write: checkout . refused');
ok(!decideGitShim(['stash']).allow, 'write: stash refused');
ok(!decideGitShim(['push']).allow, 'write: push refused');
ok(!decideGitShim(['add', '-A']).allow, 'write: add -A (real index) refused');
ok(!decideGitShim(['clean', '-fd']).allow, 'write: clean -fd refused');
ok(!decideGitShim(['branch', '-D', 'x']).allow, 'write: branch -D refused');
ok(decideGitShim(['add', '-A'], tmpIdx).allow, 'sanctioned: add -A under temp index allowed');
ok(decideGitShim(['read-tree', 'HEAD'], tmpIdx).allow, 'sanctioned: read-tree under temp index allowed');
ok(decideGitShim(['write-tree'], tmpIdx).allow, 'sanctioned: write-tree under temp index allowed');
ok(decideGitShim(['commit-tree', 'x'], tmpIdx).allow, 'sanctioned: commit-tree under temp index allowed');
ok(!decideGitShim(['commit-tree', 'x'], {}).allow, 'commit-tree WITHOUT temp index refused');
ok(decideGitShim(['commit'], { ORCHARD_ALLOW_GIT_WRITE: '1' }).allow, 'hatch open: commit allowed');

// ---- e2e throwaway ----
console.log('\n[e2e] throwaway repo, git via shimmed PATH');
const tw = fs.mkdtempSync(path.join(SCRATCH, 'tw-'));
const g = (...a) => execFileSync('git', ['-C', tw, ...a], { encoding: 'utf8' });
g('init', '-q'); g('config', 'user.email', 'x@x'); g('config', 'user.name', 'x');
fs.writeFileSync(path.join(tw, 'a.txt'), 'one\n'); g('add', 'a.txt'); g('commit', '-q', '-m', 'base');
const head0 = g('rev-parse', 'HEAD').trim();

fs.writeFileSync(path.join(tw, 'a.txt'), 'clobbered\n');
const write = spawnSync(process.execPath, ['-e',
  `require('child_process').execFileSync('git',['-C',${JSON.stringify(tw)},'commit','-am','evil'],{stdio:'inherit'})`],
  { encoding: 'utf8', env: shimEnv });
ok(write.status !== 0, 'node-subprocess commit REFUSED (nonzero)');
ok(head0 === g('rev-parse', 'HEAD').trim(), 'HEAD unchanged by refused commit');
ok(/git write refused at the invocation layer/.test(write.stderr || ''), 'loud refusal on stderr');

const reset = spawnSync(process.execPath, ['-e',
  `require('child_process').execFileSync('git',['-C',${JSON.stringify(tw)},'reset','--hard','HEAD~1'],{stdio:'inherit'})`],
  { encoding: 'utf8', env: shimEnv });
ok(reset.status !== 0, 'node-subprocess reset --hard REFUSED');
ok(head0 === g('rev-parse', 'HEAD').trim(), 'HEAD unchanged by refused reset');

ok(spawnSync('git', ['-C', tw, 'status', '--porcelain'], { encoding: 'utf8', env: shimEnv }).status === 0,
  'read: git status works through shim');
const log = spawnSync('git', ['-C', tw, 'log', '--oneline'], { encoding: 'utf8', env: shimEnv });
ok(log.status === 0 && /base/.test(log.stdout), 'read: git log works through shim');

const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
fs.writeFileSync(path.join(tw, 'a.txt'), 'bypass\n');
const bypass = spawnSync(process.execPath, ['-e',
  `require('child_process').execFileSync(${JSON.stringify(realGit)},['-C',${JSON.stringify(tw)},'commit','-am','bypass'])`],
  { encoding: 'utf8', env: shimEnv });
ok(bypass.status === 0, '(documented gap) absolute-path git bypasses the shim');

// ---- sanctioned on REAL repo ----
console.log('\n[sanctioned] snapshotWorkingTree on the REAL repo, shim on PATH');
const idxPath = path.join(REPO, '.git', 'index');
const hashIdx = () => crypto.createHash('sha256').update(fs.readFileSync(idxPath)).digest('hex');
const realHead = () => execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const idxBefore = hashIdx(), headBefore = realHead();
const driver = path.join(SCRATCH, 'snap-driver.mjs');
fs.writeFileSync(driver,
  `import { snapshotWorkingTree } from ${JSON.stringify(path.join(REPO, 'scripts/lib/tree-snapshot.mjs'))};\n` +
  `console.log(JSON.stringify(snapshotWorkingTree(${JSON.stringify(REPO)})));\n`);
const snap = spawnSync(process.execPath, [driver], { encoding: 'utf8', env: shimEnv });
ok(snap.status === 0, 'snapshotWorkingTree SUCCEEDS with shim on PATH');
if (snap.status !== 0) console.log('    stderr:', (snap.stderr || '').trim());
let snapOut = null; try { snapOut = JSON.parse((snap.stdout || '').trim()); } catch { /* */ }
ok(snapOut && /^[0-9a-f]{40}$/.test(snapOut.tree || ''), 'snapshot returned a tree sha');
ok(idxBefore === hashIdx(), 'real .git/index BYTE-IDENTICAL before/after snapshot');
ok(headBefore === realHead(), 'real HEAD unchanged before/after snapshot');

fs.rmSync(SCRATCH, { recursive: true, force: true });
console.log(`\n== ${pass} passed, ${fail} failed ==`);
process.exit(fail ? 1 : 0);
