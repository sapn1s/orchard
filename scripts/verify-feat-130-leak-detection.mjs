#!/usr/bin/env node
// FEAT-130 adversarial verification — credential/secret/email detection + the
// commit-path enforcement. Run: npm run verify:feat-130
//
// SELF-IMMUNITY: every shaped fixture below is SPLIT ('sk-' + 'ant-…') so this
// tracked file does not trip its own gate when scanned in the public tree —
// exactly the convention leak-tokens.mjs and verify-gatekeeper.mjs use. The
// parts reassemble at runtime into the shape under test; they are fabricated,
// never a live credential or a real personal address.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ORCHARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(ORCHARD, 'scripts', 'leak-gate.mjs');
const {
  scanLine, scanSecrets, scanIdentity, scanKeyShapes, scanBinary, emailAllowed, TOKENS,
} = await import(path.join(ORCHARD, 'scripts', 'lib', 'leak-tokens.mjs'));
const gitmod = await import(path.join(ORCHARD, 'src', 'server', 'git.ts'));

let pass = 0, fail = 0;
const bad = [];
function ok(name, cond) { if (cond) pass++; else { fail++; bad.push(name); } console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); }
const caught = (text) => scanLine(text).length > 0;
// "classic literal TOKENS did NOT catch this" — proves the catch is NEW (must-FAIL before).
const classicCaught = (text) => TOKENS.some((t) => t.re.test(text));

// ── Shaped fixtures — SPLIT so the source is gate-clean; joined at runtime ──
const F = {
  sk:   'sk-' + 'ant-api03-AbCdEf0123456789GhIjKlMnOpQrStUvWxYZ001122',
  ghp:  'ghp' + '_0123456789abcdefABCDEF0123456789abcd',
  akia: 'AKI' + 'A1234567890ABCDEF',
  xox:  'xox' + 'b-123456789012-123456789012-abcdefABCDEF12',
  pem:  '-----BEGIN ' + 'RSA PRIVATE KEY-----',
  bearer: 'Authorization: Bearer ' + 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcXYZ012',
  secretEq: 'SECRET' + '=real-looking-value',
  apikeyEq: 'API_' + 'KEY=Ax9Kd82bQm10ZzPpLw',
  quoted: 'pass' + 'word: "hunter2pass"',
  conn: 'postgres:/' + '/admin:s3cr3tPw9x@' + 'db.internal:5432/app',
  email: 'jdoe.personal@' + 'gmail.com',
};
// Split identities/addresses used below (never a real handle or personal email).
const NOREPLY = '48549775+' + 'sa' + 'pn1s' + '@users.noreply.github.com';
const PERSONAL1 = 'jane.doe@' + 'gmail.com';
const PERSONAL2 = 'jane.personal@' + 'gmail.com';

console.log('A. Detection — each NEW class caught after, NOT caught by classic literal tokens before:');
for (const [k, v] of Object.entries(F)) {
  ok(`caught: ${k}`, caught(v));
  ok(`NOT caught by classic literal tokens (was blind before): ${k}`, !classicCaught(v));
}

console.log('\nB. False-positive proof — real-tree legit content must NOT be caught:');
const CLEAN = [
  ['sk- session-key slug', 'sk-' + 'notification-woken'],
  ['sk- long dashed slug', 'sk-' + 'subagent-vs-dispatched-full-session'],
  ['MAX_TOKEN const', 'const MAX_' + 'TOKEN = 200;'],
  ['FUZZ_TOKEN const', "export const FUZZ_" + "TOKEN = 'RANDOM-MUST-BE-VISIBLE';"],
  ['dependency maintainer email (microsoft)', 'dgozman@' + 'microsoft.com'],
  ['dependency maintainer email (oraios)', 'info@' + 'oraios-ai.de'],
  ['reserved fixture email', 'a@' + 'example.invalid'],
  ['systemd cgroup pseudo-email', 'user@' + '1000.service'],
  ['test fixture email .local', 'f047@' + 'verify.local'],
  ['ticket discussing shapes by name', 'The gate must catch sk-' + ' keys, ghp' + '_ tokens and AKI' + 'A ids.'],
  ['Bearer placeholder', 'Authorization: Bearer ' + '<token>'],
  ['placeholder anthropic fixture', 'sk-' + 'ant-oat01-not-a-real-token'],
  ['API_KEY placeholder value', 'API_' + 'KEY=your-key-here'],
  ['TOKEN=xxx placeholder', 'TOKEN' + '=xxx'],
  ['SECRET code reference', 'const SECRET' + ' = process.env.MY_SECRET;'],
  ['conn string doc placeholder', 'redis:/' + '/user:pass@localhost:6379'],
  ['anthropic noreply trailer', 'Co-Authored-By: Claude <noreply@' + 'anthropic.com>'],
  ['git ssh url', 'clone git@' + 'github.com:me/x.git'],
];
for (const [name, text] of CLEAN) ok(`clean: ${name}`, !caught(text));

console.log('\nC. Committer identity:');
ok('noreply identity waived', scanIdentity('sa' + 'pn1s', NOREPLY).length === 0);
ok('personal email committer caught', scanIdentity('Jane', PERSONAL1).some((h) => /personal email/.test(h.token)));
ok('emailAllowed(noreply anthropic)', emailAllowed('noreply@' + 'anthropic.com'));
ok('emailAllowed(gmail) false', !emailAllowed('x@' + 'gmail.com'));

console.log('\nD. Binary/skipped-file blind spot — key shapes found in raw bytes:');
ok('scanKeyShapes finds embedded sk key', scanKeyShapes(`\x00\x00binaryjunk\x00${F.sk}\x00more`).length > 0);
ok('scanKeyShapes finds PEM', scanKeyShapes(`\x00${F.pem}\x00`).length > 0);
ok('scanKeyShapes ignores plain email (no flood)', scanKeyShapes(`noise ${F.email} noise`).length === 0);

// ── FEAT-130 round 3 — the holes the round-2 verifier proved (each was a MISS
//    before this round; the classic literal tokens never covered any of them). ──
console.log('\nD2. Round-3 provider formats — real-shaped keys the round-2 scanLine missed:');
const PROV = {
  google:      'AI' + 'zaSy' + '34567890abcdefABCDEFghijklmnopqrs',     // AIza + 35
  stripe:      'sk' + '_live_' + '4eC39HqLyjWDarjtT1zdp7dc',            // sk_ (underscore) — sk- matcher misses
  githubPat:   'github' + '_pat_' + '11ABCDE0Y0abcdEFGHijkLMNopQRstUVwxYZ0123456789ABCdefGHIjklMNopqrSTuvWXyz012345',
  sendgrid:    'SG' + '.' + 'abcdEFGHijklMNOPqrstuv' + '.' + 'abcdEFGHijklMNOPqrstuvWXYZ0123456789-_abcdefg',
  npm:         'npm' + '_' + '0123456789abcdefABCDEF0123456789abcd',    // npm_ + 36
  pypi:        'pypi-' + 'AgE' + 'IcHlwaS5vcmcCJDABCDEF0123456789abcdef',
  jwt:         'eyJ' + 'hbGciOiJIUzI1NiJ9' + '.' + 'eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
};
for (const [k, v] of Object.entries(PROV)) {
  ok(`caught provider: ${k}`, caught(v));
  ok(`NOT caught by classic literal tokens (was blind before): ${k}`, !classicCaught(v));
}

console.log('\nD3. Placeholder anchoring — a real secret is NOT waived by a stray "example" substring:');
// Round-2 MEDIUM: PLACEHOLDER.test() waived any value merely CONTAINING a
// placeholder word. A genuine password with "example" mid-string slipped.
ok('real password containing "example" IS caught',
  caught('PASS' + 'WORD=' + 'MyReal' + 'example' + 'P4' + 'ssw0rd99'));
ok('real api key containing "test" IS caught',
  caught('SECRET' + '=' + 'Zx' + 'test' + 'Kd82bQm10ZzPpLwQ7aa'));
// The reverse direction must still hold: genuine placeholders do NOT fire.
ok('placeholder your-key-here still clean', !caught('API_' + 'KEY=' + 'your-key-here'));
ok('placeholder not-a-real-token still clean', !caught('sk-' + 'ant-oat01-not-a-real-token'));
ok('placeholder <your-secret> still clean', !caught('SECRET' + '=<your-secret>'));

console.log('\nD4. scanBinary — assignment/provider shapes inside binary/NUL content (not KEY-only):');
// Round-2 HIGH: one NUL downgraded the whole blob to KEY/PEM-only, so a staged
// `apikey=<body>` + trailing NUL slipped. scanBinary adds assignment/conn/provider.
ok('scanBinary catches apikey=<body> across a NUL', scanBinary('api' + 'key=' + 'Ax9Kd82bQm10ZzPpLwQ7' + '\x00tail').length > 0);
ok('scanBinary catches github_pat_ in blob', scanBinary('junk\x00' + PROV.githubPat + '\x00more').length > 0);
ok('scanBinary still ignores plain email (no flood)', scanBinary('noise jdoe.personal@' + 'gmail.com noise').length === 0);

console.log('\nD5. Gate enforcement (--staged) — type-change T + text SVG (round-2 CRITICAL/HIGH):');
{
  const mkrepo = () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'feat130-r3g-'));
    const gg = (a) => execFileSync('git', a, { cwd: t, encoding: 'utf8', stdio: 'pipe' });
    gg(['init', '-b', 'main']); gg(['config', 'user.name', 'x']);
    gg(['config', 'user.email', NOREPLY]);
    fs.symlinkSync(path.join(ORCHARD, 'scripts'), path.join(t, 'scripts'));
    return { t, gg };
  };
  const stagedExit = (t) => {
    try { execFileSync(process.execPath, [GATE, '--summary', '--staged'], { cwd: t, encoding: 'utf8', stdio: 'pipe' }); return 0; }
    catch (e) { return e.status; }
  };
  // T: tracked symlink → regular file whose blob carries a secret assignment.
  const r1 = mkrepo();
  fs.symlinkSync('/tmp/target', path.join(r1.t, 'thing')); r1.gg(['add', 'thing']); r1.gg(['commit', '-m', 'link']);
  fs.rmSync(path.join(r1.t, 'thing')); fs.writeFileSync(path.join(r1.t, 'thing'), 'access' + '_key=' + F.akia + '\n');
  r1.gg(['add', 'thing']);
  ok('type-change T (symlink→file with secret) REFUSED by --staged', stagedExit(r1.t) === 1);
  // SVG: text image carrying a github_pat_ (allowlisted image dir would waive pixels).
  const r2 = mkrepo();
  fs.writeFileSync(path.join(r2.t, 'logo.svg'), '<svg><!-- ' + PROV.githubPat + ' --></svg>\n'); r2.gg(['add', 'logo.svg']);
  ok('text SVG with embedded token REFUSED by --staged', stagedExit(r2.t) === 1);
  // FP guard: a clean SVG must still pass.
  const r3 = mkrepo();
  fs.writeFileSync(path.join(r3.t, 'ok.svg'), '<svg width="10"><rect fill="#fff"/></svg>\n'); r3.gg(['add', 'ok.svg']);
  ok('clean SVG still passes --staged (no FP)', stagedExit(r3.t) === 0);
  for (const d of [r1.t, r2.t, r3.t]) fs.rmSync(d, { recursive: true, force: true });
}

console.log('\nD6. Round-4 bypasses — placeholder/entropy granularity + provider boundary:');
// Round-3 verifier BROKEN cases. Values SPLIT so this file stays gate-clean; the
// entropy bodies below are fabricated random-looking strings, never live keys.
// split into ≤5-char literals so no fragment is itself secret-shaped and the var
// name avoids the secret-key list — this file stays gate-clean (self-immunity).
const R4BODY = 'Q7mR2' + 'vK9aL' + '6zB8n' + 'C4pD5';    // fabricated mixed case+digit run
// #1 — a structural marker (xxxx) spliced INTO a high-entropy run must NOT waive it.
ok('xxxx spliced into a secret value IS caught',
  caught('PASS' + 'WORD=' + 'Q7mR2vK9' + 'xxxx' + 'aL6zB8nC4pD5'));
// #2 — a placeholder assignment before a real one on the same line must NOT mask it.
ok('placeholder assignment before a real secret IS caught',
  caught('PASS' + 'WORD=your-key-here; PASS' + 'WORD=' + R4BODY));
// #3 — an AIza key whose 35-char body ends in a hyphen must be caught.
ok('AIza key ending in a hyphen IS caught',
  caught('AI' + 'za' + 'Q7mR2vK9aL6zB8nC4pD5eF0gH3iJ1kL2mN-'));
// Precision must not regress: high-entropy NON-secrets must stay clean.
ok('git SHA (revision=) stays clean', !caught('revision=' + '3fa9c2d41b079e107d9d372bb682c45e135790ab'));
ok('lockfile integrity hash stays clean',
  !caught('integrity sha512-' + 'abcdEF0123456789abcdEF0123456789abcdEF0123456789abcdEF0123456789ab'));
ok('minified bundle high-entropy literal stays clean',
  !caught('var t=function(e){return e};var h="' + 'a8f3c2d41b079e107d9d372bb682c45e' + '"'));
ok('a pure xxxx placeholder value still waived', !caught('PASS' + 'WORD=' + 'xxxxxxxxxxxxxxxxxxxxxxxx'));
ok('your-key-here placeholder still waived', !caught('PASS' + 'WORD=your-key-here'));

// ── Enforcement in a scratch git repo (git run inside node, not Bash tool) ──
console.log('\nE. Enforcement — pre-commit / commit-msg hooks (hand git commit):');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat130-repo-'));
const g = (args) => execFileSync('git', args, { cwd: tmp, encoding: 'utf8', stdio: 'pipe' });
function commitExpect(shouldFail, label, { file, content, msg } = {}) {
  if (file) fs.writeFileSync(path.join(tmp, file), content ?? '');
  g(['add', '-A']);
  let threw = false;
  try { g(['commit', '-m', msg ?? 'clean message']); } catch { threw = true; }
  ok(`${label} → ${shouldFail ? 'REFUSED' : 'allowed'}`, threw === shouldFail);
}
g(['init', '-b', 'main']);
g(['config', 'user.name', 'sa' + 'pn1s']);
g(['config', 'user.email', NOREPLY]);
fs.mkdirSync(path.join(tmp, '.git', 'hooks'), { recursive: true });
for (const h of ['pre-commit', 'commit-msg']) {
  fs.copyFileSync(path.join(ORCHARD, '.githooks', h), path.join(tmp, '.git', 'hooks', h));
  fs.chmodSync(path.join(tmp, '.git', 'hooks', h), 0o755);
}
fs.symlinkSync(path.join(ORCHARD, 'scripts'), path.join(tmp, 'scripts'));

commitExpect(false, 'clean file + clean msg', { file: 'a.txt', content: 'nothing secret here\n' });
commitExpect(true, 'planted sk key in file', { file: 'b.txt', content: `key=${F.sk}\n` });
commitExpect(true, 'secret in commit MESSAGE', { file: 'b.txt', content: 'now clean\n', msg: `fix using ${F.ghp}` });
commitExpect(false, 'recover after cleanup', { file: 'b.txt', content: 'still clean\n', msg: 'ordinary message' });

console.log('\nF. Enforcement — committer identity (pre-commit --identity):');
g(['config', 'user.email', PERSONAL2]);
commitExpect(true, 'personal committer email', { file: 'c.txt', content: 'clean\n' });
g(['config', 'user.email', NOREPLY]);
commitExpect(false, 'noreply identity restored', { file: 'c.txt', content: 'clean3\n' });

// Fail-closed when committer email is unresolvable: gate --identity exits 2.
const iso = { ...process.env, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'feat130-noid-'));
execFileSync('git', ['init', '-b', 'main'], { cwd: tmp3, env: iso, stdio: 'pipe' });
let idCode = 0;
try { execFileSync(process.execPath, [GATE, '--summary', '--identity'], { cwd: tmp3, env: iso, stdio: 'pipe' }); }
catch (e) { idCode = e.status; }
ok('FAIL-CLOSED: gate exits 2 when committer email unresolvable', idCode === 2);

// Fail-closed when the gate itself is unavailable: hook refuses (no scripts/).
const tmp4 = fs.mkdtempSync(path.join(os.tmpdir(), 'feat130-nogate-'));
const g4 = (args) => execFileSync('git', args, { cwd: tmp4, encoding: 'utf8', stdio: 'pipe' });
g4(['init', '-b', 'main']);
g4(['config', 'user.name', 'sa' + 'pn1s']);
g4(['config', 'user.email', NOREPLY]);
fs.mkdirSync(path.join(tmp4, '.git', 'hooks'), { recursive: true });
fs.copyFileSync(path.join(ORCHARD, '.githooks', 'pre-commit'), path.join(tmp4, '.git', 'hooks', 'pre-commit'));
fs.chmodSync(path.join(tmp4, '.git', 'hooks', 'pre-commit'), 0o755);
fs.writeFileSync(path.join(tmp4, 'z.txt'), 'clean\n');
g4(['add', '-A']);
let noGateRefused = false;
try { g4(['commit', '-m', 'x']); } catch { noGateRefused = true; }
ok('FAIL-CLOSED: hook refuses when leak gate unavailable (no scripts/)', noGateRefused);

console.log('\nG. Enforcement — src/server/git.ts commit() (UI/CLI path), fail-closed:');
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'feat130-uipath-'));
const g2 = (args) => execFileSync('git', args, { cwd: tmp2, encoding: 'utf8', stdio: 'pipe' });
g2(['init', '-b', 'main']);
g2(['config', 'user.name', 'sa' + 'pn1s']);
g2(['config', 'user.email', NOREPLY]);
fs.writeFileSync(path.join(tmp2, 'x.txt'), `token=${F.sk}\n`);
g2(['add', '-A']);
let refused = false;
try { await gitmod.commit(tmp2, { title: 'add x' }); } catch (e) { refused = /leak gate/i.test(String(e.message)); }
ok('git.ts commit() REFUSES planted secret (422)', refused);
fs.writeFileSync(path.join(tmp2, 'x.txt'), 'clean content\n');
g2(['add', '-A']);
let committed = false;
try { const r = await gitmod.commit(tmp2, { title: 'add x clean' }); committed = Boolean(r.committed); } catch { committed = false; }
ok('git.ts commit() allows clean tree', committed);
fs.writeFileSync(path.join(tmp2, 'y.txt'), 'clean\n');
g2(['add', '-A']);
let msgRefused = false;
try { await gitmod.commit(tmp2, { title: 'ship', description: `contains ${F.email}` }); } catch (e) { msgRefused = /leak gate/i.test(String(e.message)); }
ok('git.ts commit() REFUSES secret/email in message', msgRefused);

for (const d of [tmp, tmp2, tmp3, tmp4]) fs.rmSync(d, { recursive: true, force: true });

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
if (fail) { console.log('failed:', bad.join(' | ')); process.exit(1); }
