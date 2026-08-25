#!/usr/bin/env node
/**
 * verify-bug-080-mirror-images.mjs — §C proof for BUG-080.
 *
 * Two folded findings, both proven here:
 *   1. The public mirror must not ship private image assets. docs/bugs/assets/
 *      *.png are raw dashboard captures (private paths / usernames / session
 *      titles in the pixels); the text-only leak gate was blind to them.
 *   2. The leak gate ignored its path arg — `node leak-gate.mjs <tree>` scanned
 *      the SOURCE repo, not the built mirror tree it was handed.
 *
 * Checks (no network, scratch dirs only):
 *   A. TREE mode: a non-allowlisted image under docs/bugs/assets → HARD FAIL,
 *      named; allowlisted images (public/, docs/assets/) pass.
 *   B. Path-arg: the gate scans the TREE it is given (file count + a planted
 *      token in the tree are reported), NOT the repo at cwd.
 *   C. REPO mode unchanged: text tokens still caught with the same file:line
 *      format; images in the private repo are skipped (no new failures).
 *   D. End-to-end pipeline: publish-public-mirror.sh (default, no push) EXCLUDES
 *      docs/bugs/assets from the tarball, keeps allowlisted assets, and the tree
 *      passes the gate.
 *
 * The private-token literal is assembled from split halves so THIS file does
 * not trip claude-station's own leak gate.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(ROOT, 'scripts', 'leak-gate.mjs');
const PUBLISH = path.join(ROOT, 'scripts', 'publish-public-mirror.sh');
const HOME_TOKEN = '/home/' + 'sa' + 'p'; // matches the gate's "home path" class

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

function runGate(args, cwd = ROOT) {
  const r = spawnSync(process.execPath, [GATE, ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bug080-'));
const fakePng = Buffer.from('\x89PNG\r\n\x1a\n private capture', 'binary');

/* ---- A: TREE mode gates private images, allows the allowlist ---- */
console.log('\n[A] TREE mode — private image hard-fails, allowlisted images pass');
const treeA = path.join(scratch, 'treeA');
fs.mkdirSync(path.join(treeA, 'docs', 'bugs', 'assets'), { recursive: true });
fs.mkdirSync(path.join(treeA, 'docs', 'assets'), { recursive: true });
fs.mkdirSync(path.join(treeA, 'public'), { recursive: true });
fs.writeFileSync(path.join(treeA, 'docs', 'bugs', 'assets', 'BUG-999-x.png'), fakePng);
fs.writeFileSync(path.join(treeA, 'docs', 'assets', 'screenshot.png'), fakePng);  // allowlisted
fs.writeFileSync(path.join(treeA, 'public', 'favicon.svg'), '<svg/>\n');           // allowlisted
fs.writeFileSync(path.join(treeA, 'README.md'), 'clean text, no tokens\n');
let r = runGate([treeA]);
check('private bug-asset image → exit 1', r.code === 1, `exit ${r.code}`);
check('flagged by path + [private image] class', /docs\/bugs\/assets\/BUG-999-x\.png:0: \[private image/.test(r.out),
  r.out.split('\n').find((l) => l.includes('BUG-999')) ?? '(no image hit line)');
check('allowlisted docs/assets image NOT flagged', !r.out.includes('docs/assets/screenshot.png'), 'should be silent');
check('allowlisted public/ svg NOT flagged', !r.out.includes('public/favicon.svg'), 'should be silent');

/* ---- B: path-arg — the gate scans the TREE it is handed, not the repo ---- */
console.log('\n[B] path-arg — scans the handed tree, not the source repo');
const treeB = path.join(scratch, 'treeB');
fs.mkdirSync(treeB, { recursive: true });
fs.writeFileSync(path.join(treeB, 'notes.md'), `debug notes point at ${HOME_TOKEN}/work\n`);
fs.writeFileSync(path.join(treeB, 'ok.md'), 'nothing private here\n');
r = runGate([treeB], ROOT); // cwd = the real repo, arg = scratch tree
check('token in the tree is caught (file:line + class)', /notes\.md:1: \[home path\]/.test(r.out),
  r.out.split('\n').find((l) => l.includes('notes.md')) ?? '(no hit)');
check('reports the TREE (2 files), not the repo', /across 2 files \[TREE /.test(r.out),
  r.out.split('\n').find((l) => l.includes('LEAK GATE')) ?? '(no summary)');
// a CLEAN tree scanned from inside the real repo must PASS with the tree's tiny
// count — proving the ~300-file repo (with its 100+ private pngs) was NOT scanned.
const treeBclean = path.join(scratch, 'treeBclean');
fs.mkdirSync(treeBclean, { recursive: true });
fs.writeFileSync(path.join(treeBclean, 'a.md'), 'clean\n');
r = runGate([treeBclean], ROOT);
check('clean tree from repo cwd → PASS on 1 file (repo not scanned)', r.code === 0 && /across 1 files \[TREE /.test(r.out),
  r.out.split('\n').find((l) => l.includes('LEAK GATE')) ?? `exit ${r.code}`);

/* ---- C: REPO mode unchanged (text caught, images skipped) ---- */
console.log('\n[C] REPO mode — text token caught, repo images skipped (no regression)');
const repoC = path.join(scratch, 'repoC');
fs.mkdirSync(path.join(repoC, 'docs', 'bugs', 'assets'), { recursive: true });
spawnSync('git', ['init', '-q'], { cwd: repoC });
spawnSync('git', ['config', 'user.email', 'x@example.com'], { cwd: repoC });
spawnSync('git', ['config', 'user.name', 'x'], { cwd: repoC });
fs.writeFileSync(path.join(repoC, 'docs', 'bugs', 'assets', 'cap.png'), fakePng); // must be IGNORED in repo mode
fs.writeFileSync(path.join(repoC, 'leak.md'), `path is ${HOME_TOKEN}\n`);
spawnSync('git', ['add', '-A'], { cwd: repoC });
r = runGate([], repoC); // no arg → REPO mode at cwd, as the gatekeeper calls it
check('repo-mode text token caught (leak.md:1 [home path])', /leak\.md:1: \[home path\]/.test(r.out),
  r.out.split('\n').find((l) => l.includes('leak.md')) ?? '(no hit)');
check('repo-mode image is SKIPPED (cap.png not flagged)', !r.out.includes('cap.png'),
  r.out.split('\n').find((l) => l.includes('cap.png')) ?? 'ok');
check('summary tagged [REPO (git-tracked)]', /\[REPO \(git-tracked\)\]/.test(r.out),
  r.out.split('\n').find((l) => l.includes('LEAK GATE')) ?? '(no summary)');

/* ---- D: end-to-end pipeline excludes private images, keeps the allowlist ---- */
console.log('\n[D] publish-public-mirror.sh (default, no push) — excludes bug-assets, keeps allowlist');
const outD = path.join(scratch, 'mirror-out');
const rp = spawnSync('bash', [PUBLISH, '--out', outD], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const pubOut = (rp.stdout ?? '') + (rp.stderr ?? '');
const treeD = path.join(outD, 'tree');
check('pipeline exit 0 (no leak, no network)', rp.status === 0, `exit ${rp.status}\n${pubOut.slice(-400)}`);
const bugAssetsDir = path.join(treeD, 'docs', 'bugs', 'assets');
const bugAssetImgs = fs.existsSync(bugAssetsDir)
  ? fs.readdirSync(bugAssetsDir).filter((n) => /\.(png|jpe?g|gif|ico|webp|bmp|tiff?|svg)$/i.test(n))
  : [];
check('zero images under docs/bugs/assets in the tree', bugAssetImgs.length === 0,
  bugAssetImgs.length ? `${bugAssetImgs.length} image(s) shipped: ${bugAssetImgs.slice(0, 3).join(', ')}` : '');
check('excluded-image count reported (>0)', /excluded [1-9][0-9]* private image/.test(pubOut),
  pubOut.split('\n').find((l) => l.includes('excluded')) ?? '(no exclusion line)');
check('allowlisted docs/assets screenshots KEPT', fs.existsSync(path.join(treeD, 'docs', 'assets', 'screenshot-dashboard.png')),
  'README screenshot missing from tree');
check('allowlisted public/favicon.svg KEPT', fs.existsSync(path.join(treeD, 'public', 'favicon.svg')), 'favicon missing');
check('leak gate PASS on the built tree', /leak gate: PASS/.test(pubOut),
  pubOut.split('\n').find((l) => l.includes('leak gate')) ?? '(no gate line)');
// confirm no stray non-allowlisted image remains anywhere in the shipped tree
const strayImgs = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
  if (e.name === '.git') continue; const p = path.join(d, e.name);
  if (e.isDirectory()) walk(p);
  else if (/\.(png|jpe?g|gif|ico|webp|bmp|tiff?|svg)$/i.test(e.name)) {
    const rel = path.relative(treeD, p).split(path.sep).join('/');
    if (!/^(public\/|docs\/assets\/)/.test(rel)) strayImgs.push(rel);
  }
} })(treeD);
check('zero non-allowlisted images anywhere in the tree', strayImgs.length === 0, strayImgs.slice(0, 5).join(', '));

fs.rmSync(scratch, { recursive: true, force: true });
console.log(`\nverify-bug-080: ${pass} PASS, ${fail} FAIL${fail ? ` — failed: ${failures.join('; ')}` : ''}`);
process.exit(fail ? 1 : 0);
