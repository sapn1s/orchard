#!/usr/bin/env node
// FEAT-156 — own-project exemption + per-repo `.leakgate-allow` + named gate/list.
//
//   node scripts/verify-feat-156-leak-gate-own-project.mjs            # the working tree's gate
//   node scripts/verify-feat-156-leak-gate-own-project.mjs --baseline # must-FAIL: the gate pinned at a977e76
//
// SYNTHETIC fixture (said so per CONVENTIONS): temp git repos + a scratch
// CLAUDE_STATION_DATA registry. No private value is written in this file: every
// needle is DERIVED at runtime from the token list itself (the literal source of
// a project-kind token), so this tracked file stays gate-clean. Output prints
// token LABELS, never the needles.
//
// The baseline is PINNED to a named revision (a977e76, the HEAD this feature was
// built on) — never `HEAD`, which becomes the fixed state the moment it lands.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ORCHARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = process.argv.includes('--baseline');
const PIN = 'a977e76';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat156-'));
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir);
// Isolation knob BEFORE any src/server import: the host helper reads the registry
// from here, never the user's live one.
process.env.CLAUDE_STATION_DATA = dataDir;

let GATE_DIR = path.join(ORCHARD, 'scripts');
if (BASELINE) {
  GATE_DIR = path.join(tmp, 'base', 'scripts');
  fs.mkdirSync(path.join(GATE_DIR, 'lib'), { recursive: true });
  for (const f of ['leak-gate.mjs', 'lib/leak-tokens.mjs']) {
    fs.writeFileSync(path.join(GATE_DIR, f), execFileSync('git', ['show', `${PIN}:scripts/${f}`], { cwd: ORCHARD }));
  }
}
const GATE = path.join(GATE_DIR, 'leak-gate.mjs');
const LIST = path.join(GATE_DIR, 'lib', 'leak-tokens.mjs');
// Needles always come from the CURRENT list (the baseline list has the same tokens).
const { TOKENS } = await import(path.join(ORCHARD, 'scripts', 'lib', 'leak-tokens.mjs'));

let pass = 0, fail = 0;
const bad = [];
const ok = (name, cond, observed) => {
  if (cond) pass++; else { fail++; bad.push(name); }
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${observed !== undefined ? `   [observed: ${observed}]` : ''}`);
};

// ── needles, derived ───────────────────────────────────────────────────────
const literal = (t) => /^[A-Za-z0-9_-]+$/.test(t.re.source);
const projects = TOKENS.filter((t) => t.kind === 'project' && literal(t));
if (projects.length < 3) { console.error('FATAL: fewer than 3 literal project tokens to derive needles from — nothing to test'); process.exit(2); }
const OWN = projects[0];            // the project whose repo we commit in
const OTHER = projects[1];          // another private project
const THIRD = projects[2];          // allowlisted in the other repo
const needle = (t) => t.re.source;
const homeTok = TOKENS.find((t) => t.name === 'home path');
const HOME_NEEDLE = homeTok.re.source.replace(/\\b/g, '').replace(/\\\//g, '/') + '/x';
if (!homeTok.re.test(HOME_NEEDLE)) { console.error('FATAL: derived home-path needle does not match its own token'); process.exit(2); }
// A fabricated key shape, assembled at runtime (never a literal in this file).
const alnum = (n) => { const cs = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; return [...randomBytes(n)].map((b) => cs[b % cs.length]).join(''); };
const SK = 'sk' + '-' + 'Ab1' + alnum(40);

// ── fixture repos ──────────────────────────────────────────────────────────
function mkrepo(dirName) {
  const d = path.join(tmp, dirName);
  fs.mkdirSync(d, { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: d, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'verify@example.invalid');
  g('config', 'user.name', 'verify');
  g('config', 'commit.gpgsign', 'false');
  g('config', 'core.hooksPath', '/dev/null');
  fs.writeFileSync(path.join(d, 'README.md'), 'fixture\n');
  g('add', '-A'); g('commit', '-q', '-m', 'init');
  return d;
}
function stage(repo, rel, content) {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), content);
  execFileSync('git', ['add', '--', rel], { cwd: repo });
}
function reset(repo) {
  execFileSync('git', ['reset', '-q', '--hard', 'HEAD'], { cwd: repo });
  execFileSync('git', ['clean', '-qfdx'], { cwd: repo });
}

const repoOwn = mkrepo(`${needle(OWN)}-app`);      // dir carries the project's own name
const repoOther = mkrepo('neutral-other');
const repoRenamed = mkrepo('neutral-renamed');     // registered under OWN's name, dir does not match
const repoUnreg = mkrepo(`${needle(OWN)}-unregistered`);
const aliasPath = path.join(tmp, 'alias-link');
fs.symlinkSync(repoOwn, aliasPath);

const now = new Date().toISOString();
const proj = (id, name, hostPath) => ({ id, name, hostPath, isolation: 'direct', settings: {}, createdAt: now, updatedAt: now });
const writeRegistry = (projectsList) => fs.writeFileSync(path.join(dataDir, 'registry.json'),
  JSON.stringify({ version: 1, projects: projectsList }, null, 2));
const BASE_REG = [
  proj('own', `${needle(OWN)}-app`, repoOwn),
  proj('other', 'neutral-other', repoOther),
  proj('renamed', `${needle(OWN)}-renamed`, repoRenamed),   // the rename attack: name matches, dir does not
];
writeRegistry(BASE_REG);

const host = await import(path.join(ORCHARD, 'src', 'server', 'leak-gate-host.ts'));
const runGate = (repo, args) => {
  const r = spawnSync(process.execPath, [GATE, '--summary', ...args, ...(args.includes('--no-own') ? [] : host.ownProjectArgs(repo))].filter((a) => a !== '--no-own'),
    { cwd: repo, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const has = (s, re) => re.test(s);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

console.log(`FEAT-156 verify — gate under test: ${BASELINE ? `PINNED ${PIN} (must-FAIL baseline)` : 'working tree'}`);
console.log(`  (needles derived at runtime: own=[${OWN.name}] other=[${OTHER.name}] third=[${THIRD.name}])`);

// ── host resolution (the registry is the authority) ─────────────────────────
console.log('\nR. Host resolution via the registry:');
ok('R1 own repo resolves to exactly one registered name', host.ownProjectNamesFor(repoOwn).length === 1, host.ownProjectNamesFor(repoOwn).length);
ok('R2 unregistered repo resolves to nothing', host.ownProjectNamesFor(repoUnreg).length === 0, host.ownProjectNamesFor(repoUnreg).length);
{
  // The registry is written by the live service (writeAtomic → rename, so a torn
  // read should be impossible) — but a half-written or hand-mangled file must
  // still mean NO waiver, never a wider one. Truncate the real-shaped file.
  const full = fs.readFileSync(path.join(dataDir, 'registry.json'), 'utf8');
  const cuts = [0, 1, Math.floor(full.length / 3), Math.floor(full.length / 2), full.length - 2];
  const got = cuts.map((n) => { fs.writeFileSync(path.join(dataDir, 'registry.json'), full.slice(0, n)); return host.ownProjectNamesFor(repoOwn).length; });
  fs.writeFileSync(path.join(dataDir, 'registry.json'), full);
  ok('R4 a truncated/corrupt registry grants NO waiver at every cut point', got.every((n) => n === 0), `cuts ${cuts.length}, names ${got.join(',')}`);
}
ok('R3 a subdir of the own repo resolves via its git toplevel', (() => { fs.mkdirSync(path.join(repoOwn, 'sub'), { recursive: true }); return host.ownProjectNamesFor(path.join(repoOwn, 'sub')).length === 1; })());

// (a) own name staged in own repo → waived + reported
console.log('\n(a) own project name staged in its own registered repo:');
stage(repoOwn, 'src/app.js', `// ${needle(OWN)} upload handler\n`);
let r = runGate(repoOwn, ['--staged']);
ok('a1 exits 0', r.code === 0, `exit ${r.code}`);
ok('a2 the waiver is reported with the label and file:line', has(r.out, new RegExp(`waived src/app\\.js:1: \\[${esc(OWN.name)}\\] own-project`)), (r.out.match(/LEAK GATE: waived .*/g) ?? []).length + ' waived line(s)');
ok('a3 waiver count printed', has(r.out, /waivers — 1 own-project/), (r.out.match(/waivers — .*/) ?? ['none'])[0]);
ok('a4 the registered NAME is never printed (label only)', !r.out.includes(`${needle(OWN)}-app`));
// worktree mode (the agent pre-exec guard's first pass) too
r = runGate(repoOwn, []);
ok('a5 working-tree mode also waives it', r.code === 0, `exit ${r.code}`);
// commit message naming the project
const msgFile = path.join(tmp, 'MSG');
fs.writeFileSync(msgFile, `${needle(OWN)}: fix upload\n`);
r = runGate(repoOwn, ['--staged', `--commit-msg=${msgFile}`]);
ok('a6 own name in the commit message is waived + reported', r.code === 0 && has(r.out, /waived COMMIT_MSG:1:/), `exit ${r.code}`);
reset(repoOwn);

// (b) same repo: another project's token / a home path → FAIL
console.log('\n(b) own repo staging ANOTHER project token or a home path:');
stage(repoOwn, 'src/b.js', `// see ${needle(OTHER)}\n`);
r = runGate(repoOwn, ['--staged']);
ok('b1 another project token FAILS', r.code === 1 && has(r.out, new RegExp(`\\[${esc(OTHER.name)}\\]`)), `exit ${r.code}`);
reset(repoOwn);
stage(repoOwn, 'src/c.js', `const p = '${HOME_NEEDLE}';\n`);
r = runGate(repoOwn, ['--staged']);
ok('b2 a home path FAILS', r.code === 1 && has(r.out, /\[home path\]/), `exit ${r.code}`);
reset(repoOwn);
stage(repoOwn, 'src/d.js', `// ${needle(OWN)} lives at ${HOME_NEEDLE}\n`);
r = runGate(repoOwn, ['--staged']);
ok('b3 own name + home path on ONE line: own waived, home path still FAILS', r.code === 1 && has(r.out, /\[home path\]/) && has(r.out, /own-project/), `exit ${r.code}`);
reset(repoOwn);

// (c) own name in a DIFFERENT project's repo → FAIL, and the attack shapes
console.log('\n(c) own name outside its own repo, and the self-grant attacks:');
stage(repoOther, 'x.js', `// ${needle(OWN)}\n`);
r = runGate(repoOther, ['--staged']);
ok('c1 own name in a different registered project repo FAILS', r.code === 1, `exit ${r.code}`);
reset(repoOther);
stage(repoRenamed, 'x.js', `// ${needle(OWN)}\n`);
r = runGate(repoRenamed, ['--staged']);
ok('c2 registry rename attack (name matches, directory does not) FAILS', r.code === 1, `exit ${r.code}; names resolved=${host.ownProjectNamesFor(repoRenamed).length}`);
reset(repoRenamed);
stage(repoUnreg, 'x.js', `// ${needle(OWN)}\n`);
r = runGate(repoUnreg, ['--staged']);
ok('c3 unregistered repo (directory matches, registry does not) FAILS', r.code === 1, `exit ${r.code}`);
reset(repoUnreg);
writeRegistry([...BASE_REG, proj('alias', `${needle(OWN)}-alias`, aliasPath)]);
stage(repoOwn, 'src/app.js', `// ${needle(OWN)}\n`);
r = runGate(repoOwn, ['--staged']);
ok('c4 two registered projects on one real dir (symlink alias) → no waiver, FAILS', r.code === 1 && host.ownProjectNamesFor(repoOwn).length === 0, `exit ${r.code}`);
writeRegistry(BASE_REG);
reset(repoOwn);
const tree = path.join(tmp, 'tree'); fs.mkdirSync(tree); fs.writeFileSync(path.join(tree, 'a.txt'), 'clean\n');
r = (() => { const x = spawnSync(process.execPath, [GATE, tree, `--own-project=${needle(OWN)}`], { cwd: tree, encoding: 'utf8' }); return { code: x.status, out: x.stdout + x.stderr }; })();
ok('c5 --own-project is refused in TREE mode (exit 2)', r.code === 2, `exit ${r.code}`);
// the gate's own checkout never gets an exemption
r = (() => { const x = spawnSync(process.execPath, [GATE, '--summary', `--own-project=${needle(OWN)}`], { cwd: path.resolve(GATE_DIR, '..'), encoding: 'utf8' }); return { code: x.status, out: x.stdout + x.stderr }; })();
ok('c6 own-project refused inside the gate\'s own checkout', has(r.out, /own-project — refused/), `exit ${r.code}`);

// (d) per-repo allowlist, per hit
console.log('\n(d) .leakgate-allow waives ONE hit class; a different hit on the same line still FAILS:');
const ALLOW = `# fixture allowlist\ntoken:${THIRD.name} in:docs/** because: the docs cite that project's public API by name\n`;
stage(repoOther, '.leakgate-allow', ALLOW);
stage(repoOther, 'docs/a.md', `Uses ${needle(THIRD)} from ${HOME_NEEDLE}\n`);
r = runGate(repoOther, ['--staged']);
ok('d1 same line: allowlisted word waived, home path still FAILS', r.code === 1 && has(r.out, /\[home path\]/) && has(r.out, new RegExp(`waived docs/a\\.md:1: \\[${esc(THIRD.name)}\\] \\.leakgate-allow:2`)), `exit ${r.code}`);
stage(repoOther, 'docs/a.md', `Uses ${needle(THIRD)} for uploads\n`);
r = runGate(repoOther, ['--staged']);
ok('d2 with only the allowlisted word: PASS, waiver reported + counted', r.code === 0 && has(r.out, /waivers — 0 own-project, 1 \.leakgate-allow/), `exit ${r.code}`);
ok('d3 a commit that changes the allowlist prints its entries for review', has(r.out, /ADDS\/CHANGES \.leakgate-allow/));
stage(repoOther, 'src/z.js', `// ${needle(THIRD)}\n`);
r = runGate(repoOther, ['--staged']);
ok('d4 the same word OUTSIDE the entry glob FAILS', r.code === 1 && has(r.out, /src\/z\.js:1/), `exit ${r.code}`);
reset(repoOther);
fs.writeFileSync(path.join(repoOther, '.leakgate-allow'), ALLOW);   // present but NOT staged
stage(repoOther, 'docs/a.md', `Uses ${needle(THIRD)}\n`);
r = runGate(repoOther, ['--staged']);
ok('d5 an UNSTAGED allowlist does not govern a commit (FAILS, says so)', r.code === 1 && has(r.out, /NOT in the index/), `exit ${r.code}`);
reset(repoOther);

// (e) credential / identity allowlisting refused
console.log('\n(e) allowlisting a credential or identity is an error:');
const refuse = (label, allowText) => {
  reset(repoOther);
  stage(repoOther, '.leakgate-allow', allowText);
  stage(repoOther, 'k.env', `KEY_LINE ${SK}\n`);
  const x = runGate(repoOther, ['--staged']);
  ok(label, x.code === 2 && has(x.out, /can NEVER be allowlisted|cannot be allowlisted|can never be allowlisted/), `exit ${x.code}`);
};
refuse('e1 token:<key-shape class> refused (exit 2)', 'token:openai/anthropic api key (sk-) because: we really need this one\n');
refuse('e2 match:<a live key> refused (exit 2)', `match:${SK} because: we really need this one\n`);
refuse('e3 token:home path refused (identity)', 'token:home path because: docs mention the path\n');
{
  reset(repoOther);
  stage(repoOther, '.leakgate-allow', `token:${THIRD.name}\n`);
  const x = runGate(repoOther, ['--staged']);
  ok('e4 an entry without a reason is refused (exit 2)', x.code === 2 && has(x.out, /needs a reason/), `exit ${x.code}`);
}
reset(repoOther);

// (f) the gate names what ran
console.log('\n(f) output names the gate and token list that ran:');
const expand = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const ranOf = (out) => { const m = out.match(/LEAK GATE: ran (\S+) with token list (\S+)/); return m ? [expand(m[1]), expand(m[2])] : null; };
r = runGate(repoOther, ['--staged']);
let ran = ranOf(r.out);
ok('f1 PASS names the absolute gate + list that actually ran', r.code === 0 && ran && ran[0] === GATE && ran[1] === LIST, ran ? `gate ${ran[0] === GATE ? 'matches' : 'DIFFERS'}, list ${ran[1] === LIST ? 'matches' : 'DIFFERS'}` : 'no ran-line');
stage(repoOther, 'y.js', `// ${needle(OTHER)}\n`);
r = runGate(repoOther, ['--staged']);
ran = ranOf(r.out);
ok('f2 FAIL names them too', r.code === 1 && ran && ran[0] === GATE, ran ? 'ran-line present' : 'no ran-line');
ok('f3 FAIL footer explains .leakgate-allow + the own-project exemption', has(r.out, /how to resolve/) && has(r.out, /\.leakgate-allow/) && has(r.out, /OWN project name is exempt/));
ok('f4 the ran-line does not itself trip the home-path token', !(r.out.match(/LEAK GATE: ran .*/)?.[0] ?? '').match(homeTok.re));
reset(repoOther);

// (s) round 3 — every hit on a line judged on its own (cross-provider verify run 01a0ed77)
console.log('\n(s) Round 3 — no first-match short-circuit: every hit on a line is its own hit:');
const TWO = TOKENS.find((t) => t.kind === 'project' && /^[A-Za-z0-9_-]*\[_-\][A-Za-z0-9_-]*$/.test(t.re.source));
if (!TWO) { console.error('FATAL: no two-spelling project token ([_-] class) to derive the verifier repro from'); process.exit(2); }
const SP1 = TWO.re.source.replace('[_-]', '_');
const SP2 = TWO.re.source.replace('[_-]', '-');
if (!(TWO.re.test(SP1) && TWO.re.test(SP2) && SP1 !== SP2)) { console.error('FATAL: derived spellings do not both match'); process.exit(2); }
console.log(`  (two-spelling token: [${TWO.name}])`);
{
  const { scanLine: scanLineUnderTest } = await import(LIST);
  const n = scanLineUnderTest(`${SP1} and ${SP2}`).filter((h) => h.token === TWO.name).length;
  ok('s0 scanLine records BOTH spellings as separate hits', n === 2, `${n} hit(s)`);
}
// the verifier's repro: a match: waiver for one spelling, the other spelling beside it
stage(repoOther, '.leakgate-allow', `match:${SP1} because: the approved spelling is quoted in the docs\n`);
stage(repoOther, 'r.md', `${SP1} and ${SP2}\n`);
r = runGate(repoOther, ['--staged']);
ok('s1 VERIFIER REPRO: match: waiver for spelling 1 does NOT clear spelling 2 on the same line (staged)', r.code === 1 && has(r.out, /r\.md:1: \[/), `exit ${r.code}`);
r = runGate(repoOther, []);
ok('s1b ...and in working-tree mode', r.code === 1, `exit ${r.code}`);
stage(repoOther, 'r.md', `${SP1} only\n`);
r = runGate(repoOther, ['--staged']);
ok('s1c anti-regression: the approved spelling alone is still waived', r.code === 0 && has(r.out, /waived r\.md:1:/), `exit ${r.code}`);
reset(repoOther);
stage(repoOwn, 'o1.js', `// ${needle(OWN)} ${needle(OTHER)}\n`);
r = runGate(repoOwn, ['--staged']);
ok('s2 own name THEN foreign token on one line: foreign FAILS, own waived', r.code === 1 && has(r.out, new RegExp(`\\[${esc(OTHER.name)}\\]`)) && has(r.out, /own-project/), `exit ${r.code}`);
reset(repoOwn);
stage(repoOwn, 'o2.js', `// ${needle(OTHER)} ${needle(OWN)}\n`);
r = runGate(repoOwn, ['--staged']);
ok('s3 foreign token THEN own name: foreign FAILS, own waived', r.code === 1 && has(r.out, new RegExp(`\\[${esc(OTHER.name)}\\]`)) && has(r.out, /own-project/), `exit ${r.code}`);
reset(repoOwn);
stage(repoOther, '.leakgate-allow', `token:${THIRD.name} because: the docs cite that project's public API by name\n`);
stage(repoOther, 'n.md', `${needle(THIRD)} next to ${needle(OWN)}\n`);
r = runGate(repoOther, ['--staged']);
ok('s4 allowlisted word next to a foreign token: foreign FAILS', r.code === 1 && has(r.out, new RegExp(`\\[${esc(OWN.name)}\\]`)) && has(r.out, /waived n\.md:1/), `exit ${r.code}`);
reset(repoOther);
stage(repoOwn, '.leakgate-allow', `token:${THIRD.name} because: the docs cite that project's public API by name\n`);
stage(repoOwn, 'm.md', `${needle(OWN)} ${needle(THIRD)} ${needle(OTHER)} ${HOME_NEEDLE} ${needle(OWN)}\n`);
r = runGate(repoOwn, ['--staged']);
{
  const failing = (r.out.match(/^m\.md:1: \[([^\]]+)\]/gm) ?? []).map((l) => l.replace(/^m\.md:1: \[|\]$/g, ''));
  const waived = (r.out.match(/waived m\.md:1: \[[^\]]+\]/g) ?? []).length;
  ok('s5 five hits on one line: exactly the foreign token + home path FAIL; own + allowlisted waived',
    r.code === 1 && failing.includes(OTHER.name) && failing.includes('home path') && !failing.includes(OWN.name) && !failing.includes(THIRD.name) && waived >= 2,
    `failing=${failing.length} waived=${waived}`);
}
reset(repoOwn);
// the same first-match pattern in the credential scanners
const PH_KEY = 'sk' + '-' + 'x'.repeat(32);
const CONN_PH = 'postgres' + '://u:' + 'password' + '@h1/db';
const CONN_REAL = 'mysql' + '://u:' + 'Rx9k' + 'Lm2Pq7' + '@h2/db';
stage(repoOther, 'k1.txt', `a ${PH_KEY} then ${SK}\n`);
r = runGate(repoOther, ['--staged']);
ok('s6 a placeholder key BEFORE a real key on one line no longer hides it', r.code === 1 && has(r.out, /k1\.txt:1: \[openai/), `exit ${r.code}`);
reset(repoOther);
stage(repoOther, 'k2.txt', `a ${CONN_PH} then ${CONN_REAL}\n`);
r = runGate(repoOther, ['--staged']);
ok('s7 a placeholder connection string BEFORE a real one no longer hides it', r.code === 1 && has(r.out, /k2\.txt:1: \[connection string password\]/), `exit ${r.code}`);
reset(repoOther);

// (o) round 4 — OVERLAPPING candidates: a skipped match must never consume the
// start of another (cross-provider verify run 01a0ed84). Every fixture below is
// fabricated at runtime from split parts; nothing here is a live secret.
console.log('\n(o) Round 4 — overlapping candidates, every credential class:');
const { scanLine: scanO } = await import(LIST);
const R = (n) => 'Ab1' + alnum(n);
const CONN_REAL_O = 'mysql' + '://u:' + 'Qz8v' + alnum(8) + '@h2/db';
const CRED = {
  'openai/anthropic api key (sk-)': 'sk' + '-' + R(40),
  'github token (gh*_)': 'gh' + 'p_' + R(36),
  'aws access key id (AKIA/ASIA)': 'AK' + 'IA' + 'QWERTYUIOP123456',
  'slack token (xox…)': 'xo' + 'xb-' + R(10) + '-' + R(10),
  'private key (PEM header)': '-----BEGIN ' + 'RSA PRIVATE KEY-----',
  'bearer token': 'Bear' + 'er ' + R(30),
  'google api key (AIza)': 'AI' + 'za' + R(32),
  'stripe key (sk_/rk_ live/test)': 'sk' + '_live_' + R(24),
  'github fine-grained token': 'github' + '_pat_' + R(44),
  'sendgrid api key (SG.)': 'S' + 'G.' + R(20) + '.' + R(20),
  'npm token (npm_)': 'np' + 'm_' + R(33),
  'pypi token (pypi-AgE)': 'py' + 'pi-AgE' + R(30),
  'json web token (jwt)': 'ey' + 'J' + R(16) + '.ey' + 'J' + R(16) + '.' + R(16),
  ['connection string ' + 'password']: CONN_REAL_O,
  'secret assignment': 'API_' + 'KEY=' + R(20),
  'personal email': 'jane.' + alnum(6).toLowerCase() + '@' + 'gmail.com',
};
const DECOYS = {
  'placeholder conn': 'postgres' + '://u:' + 'password' + '@',
  'placeholder key': 'sk' + '-' + 'x'.repeat(32),
  'allowed email': 'noreply' + '@github.com',
  'placeholder bearer': 'Bear' + 'er ' + '<token>'.padEnd(24, 'x'),
  'placeholder assignment': 'API_' + 'KEY=' + '<redacted>',
};
{
  // Property 1 (the family): a decoy NEVER changes the verdict. For every class,
  // decoy + glue + real is caught exactly when a NEUTRAL prefix ending in the
  // same character is — so the only thing a preceding match can influence is
  // the regex's own word-boundary anchor, never whether the real one is seen.
  // Property 2: with a separator glue, every class is always caught.
  const misses = [];
  const sepMisses = [];
  let cases = 0;
  for (const [cls, real] of Object.entries(CRED)) {
    for (const [dn, decoy] of Object.entries(DECOYS)) {
      for (const glue of ['', ' ', '-', '@', '/', ':']) {
        cases++;
        const got = scanO(decoy + glue + real).some((h) => h.token === cls);
        const neutral = scanO('q ' + 'z' + decoy.slice(-1) + glue + real).some((h) => h.token === cls);
        if (got !== neutral) misses.push(`${cls} after ${dn} glue=${JSON.stringify(glue)}`);
        if (glue && !got) sepMisses.push(`${cls} after ${dn} glue=${JSON.stringify(glue)}`);
      }
    }
  }
  ok(`o1 no decoy hides any credential class, overlapping or not (${cases} lines vs a neutral prefix)`, misses.length === 0, `${misses.length} hidden${misses.length ? ': ' + misses.slice(0, 4).join(' | ') : ''}`);
  ok('o1b with any separator glue every class is caught', sepMisses.length === 0, `${sepMisses.length} missed${sepMisses.length ? ': ' + sepMisses.slice(0, 4).join(' | ') : ''}`);
}
stage(repoOther, 'ov.txt', `${'postgres' + '://u:' + 'password' + '@'}${CONN_REAL_O}\n`);
r = runGate(repoOther, ['--staged']);
ok('o2 VERIFIER REPRO: overlapping placeholder conn string hides the real one → gate FAILS (staged)', r.code === 1 && has(r.out, /ov\.txt:1: \[connection string password\]/), `exit ${r.code}`);
r = runGate(repoOther, []);
ok('o2b ...and working-tree mode', r.code === 1, `exit ${r.code}`);
reset(repoOther);
{
  const n = scanO(`${SP1}${SP2} ${SP2}${SP1}`).filter((h) => h.token === TWO.name).length;
  ok('o3 glued TOKEN spellings are each recorded', n === 2, `${n} distinct hit(s)`);
  stage(repoOther, '.leakgate-allow', `match:${SP1} because: the approved spelling is quoted in the docs\n`);
  stage(repoOther, 'g.md', `${SP1}${SP2}\n`);
  const x = runGate(repoOther, ['--staged']);
  ok('o3b glued spellings: match: waiver for one does not clear the other', x.code === 1, `exit ${x.code}`);
  reset(repoOther);
}
stage(repoOther, '.leakgate-allow', `token:${THIRD.name} in:docs/** because: the docs cite that project's public API by name\n`);
stage(repoOther, 'docs/rep.md', `${needle(THIRD)} and again ${needle(THIRD)}\n`);
stage(repoOther, 'src/rep.js', `// ${needle(THIRD)} ${needle(THIRD)}\n`);
r = runGate(repoOther, ['--staged']);
ok('o4 repeated token: occurrences under the in: glob waived, the ones outside FAIL', r.code === 1 && has(r.out, /waived docs\/rep\.md:1/) && has(r.out, /src\/rep\.js:1:/) && !has(r.out, /^docs\/rep\.md:1:/m), `exit ${r.code}`);
reset(repoOther);
{
  const decoyRun = Array.from({ length: 3999 }, () => 'postgres' + '://u:' + 'password' + '@').join('');
  const longLine = `${'x'.repeat(100_000)} ${decoyRun}${CONN_REAL_O}`;
  const t0 = performance.now();
  const hits = scanO(longLine).map((h) => h.token);
  const ms = Math.round(performance.now() - t0);
  ok(`o5 long line (${Math.round(longLine.length / 1024)} KB, 3999 overlapping decoys, odd count so a non-overlapping scan lands on the real scheme) still catches the real credential`, hits.includes('connection string password'), `${ms} ms`);
  stage(repoOther, 'long.txt', longLine + '\n');
  const t1 = performance.now();
  const x = runGate(repoOther, ['--staged']);
  ok('o5b ...and the gate FAILS on it', x.code === 1, `exit ${x.code}, ${Math.round(performance.now() - t1)} ms`);
  reset(repoOther);
}
stage(repoOther, 'pem.txt', `${'postgres' + '://u:' + 'password' + '@'}${CRED['private key (PEM header)']}\nMIIE${alnum(60)}\n-----END ${'RSA PRIVATE KEY'}-----\n`);
r = runGate(repoOther, ['--staged']);
ok('o6 PEM block glued to a placeholder conn string → FAIL', r.code === 1 && has(r.out, /pem\.txt:1: \[private key \(PEM header\)\]/), `exit ${r.code}`);
reset(repoOther);

// ── the real host wrappers (working tree only: they always run Orchard's gate) ──
if (!BASELINE) {
  console.log('\nH. Real host wrappers:');
  const { runLeakGateForRepo } = await import(path.join(ORCHARD, 'src', 'server', 'runtime', 'claude-runtime.ts'));
  const gitcli = await import(path.join(ORCHARD, 'src', 'server', 'git.ts'));
  // Capture the host's waiver log instead of echoing it: it names the fixture
  // path, which carries a derived needle. Asserted on below, never printed.
  const warned = [];
  const realWarn = console.warn;
  console.warn = (...a) => { warned.push(a.join(' ')); };
  stage(repoOwn, 'src/app.js', `// ${needle(OWN)}\n`);
  let h = runLeakGateForRepo(repoOwn);
  ok('h1 agent git-write guard: own name in own repo → ok, waiver in detail', h.ok && /waived src\/app\.js:1/.test(h.detail), `ok=${h.ok}`);
  ok('h1b ...and the waiver is LOGGED by the host (not silent)', warned.some((w) => /agent git-write leak gate PASSED with waivers/.test(w)), `${warned.length} host log line(s)`);
  const c = await gitcli.commit(repoOwn, { title: `${needle(OWN)}: add handler` });
  ok('h2 dashboard commit(): own name in file + message → committed, waivers in response', Boolean(c.committed) && /waived COMMIT_MSG:1/.test(c.leakGate) && /waived src\/app\.js:1/.test(c.leakGate), `sha=${c.committed ? 'yes' : 'no'}`);
  ok('h2b ...and logged by the host', warned.some((w) => /commit leak gate PASSED with waivers/.test(w)));
  stage(repoOwn, 'src/e.js', `// ${needle(OTHER)}\n`);
  h = runLeakGateForRepo(repoOwn);
  ok('h3 agent guard: another project token → refused, names the host gate + footer', !h.ok && h.detail.includes(host.hostLeakGatePath()) && /how to resolve/.test(h.detail), `ok=${h.ok}`);
  let refusal = '';
  try { await gitcli.commit(repoOwn, { title: 'more' }); } catch (e) { refusal = String(e.message); }
  ok('h4 dashboard commit refused with the host gate named + footer kept', refusal.includes(host.hostLeakGatePath()) && /how to resolve/.test(refusal) && /FAIL —/.test(refusal), refusal ? 'refused' : 'NOT refused');
  stage(repoOther, 'q.js', `// ${needle(OWN)}\n`);
  h = runLeakGateForRepo(repoOther);
  ok('h5 agent guard: own name in ANOTHER project repo → refused', !h.ok, `ok=${h.ok}`);
  reset(repoOwn); reset(repoOther);

  // round 4 — the overlapping conn-string repro on BOTH host paths
  stage(repoOther, 'ov.txt', `${'postgres' + '://u:' + 'password' + '@'}${CONN_REAL_O}\n`);
  h = runLeakGateForRepo(repoOther);
  ok('ho1 agent guard REFUSES the overlapping conn-string repro', !h.ok, `ok=${h.ok}`);
  let ro = '';
  try { await gitcli.commit(repoOther, { title: 'conf' }); } catch (e) { ro = String(e.message); }
  ok('ho2 dashboard commit REFUSES the overlapping conn-string repro', /FAIL —/.test(ro), ro ? 'refused' : 'NOT refused (committed)');
  reset(repoOther);

  // round 3 — the verifier's repro on BOTH host paths
  stage(repoOther, '.leakgate-allow', `match:${SP1} because: the approved spelling is quoted in the docs\n`);
  stage(repoOther, 'r.md', `${SP1} and ${SP2}\n`);
  h = runLeakGateForRepo(repoOther);
  ok('hs1 agent guard REFUSES the two-spelling repro', !h.ok, `ok=${h.ok}`);
  let rs = '';
  try { await gitcli.commit(repoOther, { title: 'docs' }); } catch (e) { rs = String(e.message); }
  ok('hs2 dashboard commit REFUSES the two-spelling repro', /FAIL —/.test(rs), rs ? 'refused' : 'NOT refused (committed)');
  reset(repoOther);

  // ── X. round 2: the allowlist is ONLY the git-index copy, in every mode ─────
  // (round-1 clean-room verify BROKEN: an untracked `.leakgate-allow` hidden via
  // .git/info/exclude waived a foreign project token on the agent path.)
  console.log('\nX. Round 2 — only the reviewed (index) allowlist ever waives:');
  const git = (...a) => execFileSync('git', a, { cwd: repoOther, stdio: 'pipe' });
  const WIDE = `token:${THIRD.name} because: hidden local allowlist nobody reviewed\n`;
  const exclude = path.join(repoOther, '.git', 'info', 'exclude');
  const excludeBefore = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  fs.appendFileSync(exclude, `\n${'.leakgate-allow'}\n`);
  fs.writeFileSync(path.join(repoOther, '.leakgate-allow'), WIDE);                // untracked AND ignored
  fs.writeFileSync(path.join(repoOther, 'f.txt'), `uses ${needle(THIRD)}\n`);      // not staged yet
  r = runGate(repoOther, []);
  ok('x1 hidden untracked allowlist does NOT waive — working-tree mode FAILS', r.code === 1, `exit ${r.code}`);
  h = runLeakGateForRepo(repoOther);
  ok('x2 agent guard (`git add f && git commit` shape) REFUSES with the hidden allowlist', !h.ok, `ok=${h.ok}`);
  git('add', '--', 'f.txt');
  r = runGate(repoOther, ['--staged']);
  ok('x3 hidden untracked allowlist does NOT waive — staged mode FAILS', r.code === 1, `exit ${r.code}`);
  let rx = '';
  try { await gitcli.commit(repoOther, { title: 'add f' }); } catch (e) { rx = String(e.message); }
  ok('x4 dashboard commit REFUSES with the hidden allowlist', /FAIL —/.test(rx), rx ? 'refused' : 'NOT refused');
  fs.writeFileSync(exclude, excludeBefore);
  reset(repoOther);
  // a STAGED allowlist still works (it is part of what is being committed)
  stage(repoOther, '.leakgate-allow', `token:${THIRD.name} in:docs/** because: the docs cite that project's public API by name\n`);
  fs.mkdirSync(path.join(repoOther, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repoOther, 'docs', 'g.md'), `uses ${needle(THIRD)}\n`);  // untracked, not staged
  r = runGate(repoOther, []);
  ok('x5 staged allowlist waives in working-tree mode', r.code === 0 && /waivers — 0 own-project, 1 \.leakgate-allow/.test(r.out), `exit ${r.code}`);
  h = runLeakGateForRepo(repoOther);
  ok('x6 staged allowlist waives on the agent guard', h.ok, `ok=${h.ok}`);
  git('add', '--', 'docs/g.md');
  const cx = await gitcli.commit(repoOther, { title: 'docs + allowlist' });
  ok('x7 staged allowlist waives on the dashboard commit (and is committed with it)', Boolean(cx.committed) && /ADDS\/CHANGES \.leakgate-allow/.test(cx.leakGate), `sha=${cx.committed ? 'yes' : 'no'}`);
  // a working-tree WIDENING of the committed allowlist does not widen the waiver
  fs.writeFileSync(path.join(repoOther, '.leakgate-allow'), `token:${THIRD.name} because: widened locally to every file, never staged\n`);
  fs.writeFileSync(path.join(repoOther, 'src-w.js'), `// ${needle(THIRD)}\n`);
  r = runGate(repoOther, []);
  ok('x8 unstaged widening of a committed allowlist does NOT widen — working-tree mode FAILS, says index governs', r.code === 1 && /differs from the index/.test(r.out), `exit ${r.code}`);
  h = runLeakGateForRepo(repoOther);
  ok('x9 ...and the agent guard REFUSES', !h.ok, `ok=${h.ok}`);
  git('add', '--', 'src-w.js');
  r = runGate(repoOther, ['--staged']);
  ok('x10 ...and staged mode FAILS (only src-w.js staged)', r.code === 1, `exit ${r.code}`);
  reset(repoOther);
  console.warn = realWarn;
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nFEAT-156 ${BASELINE ? 'BASELINE' : 'verify'}: ${pass} passed, ${fail} failed`);
if (fail) console.log(`failed: ${bad.join(' | ')}`);
process.exit(fail ? 1 : 0);
