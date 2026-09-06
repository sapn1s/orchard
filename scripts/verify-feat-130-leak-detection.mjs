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
  scanLine, scanSecrets, scanIdentity, scanKeyShapes, emailAllowed, TOKENS,
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
