#!/usr/bin/env node
/**
 * verify-bug-261-gate-failed-refusal.mjs — BUG-261.
 *
 * An agent with a LIVE git-push grant had its push refused by the leak gate, and
 * the refusal it saw was the GENERIC `gitShimRefusal` ("git write refused /
 * disabled") — it never said the grant was active, never said the gate failed,
 * and never showed what the gate flagged. The agent read it through
 * `git push … 2>&1 | tail -2`, saw only the footer, and concluded the grant had
 * not reached the session (told the user to restart; a restart changes nothing).
 *
 * Cause: the shim rendered a host refusal verbatim ONLY when the reason started
 * with `'orchard: '`; `gitWriteGateFailedRefusal` / `gitWriteRefusal` did not, and
 * the decide route never forwarded `decision.gateFailed`. So the shim had no
 * channel to tell granted-but-gate-failed from ungranted.
 *
 * Fix: the host decision carries a TYPED `refusalKind` the shim renders by; the
 * gate-failed and ungranted messages carry their decisive line FIRST and LAST; the
 * gate detail is REDACTED to labels + count (no private values).
 *
 * Legs:
 *   [must-FAIL] the SYNTHESIZED pre-fix variant — the exact pre-BUG-261 render
 *     (prefix-sniff) over the exact pre-BUG-261 gate-failed message (no 'orchard:'
 *     prefix) — produces the GENERIC refusal; the decisive phrase is ABSENT from
 *     head -1 and tail -1. (Synthesized inline, NOT HEAD: the fix is already in the
 *     working tree, so a `git show` of HEAD would be the FIXED state.)
 *   [e2e gate-failed] a REAL `git push` through the installed shim subprocess,
 *     against a REAL host process (grant live + a failing leak gate), piped through
 *     `2>&1 | head -1` and `| tail -1`: BOTH carry the decisive phrase. The private
 *     value the gate flagged never appears; the labels + count do.
 *   [e2e ungranted] same, NO grant: the decisive ungranted phrase is on head -1 and
 *     tail -1, and it is DISTINCT from the gate-failed one.
 *   [redaction] redactGateDetail over a realistic multi-line gate detail: labels +
 *     count only; no excerpt, no path, no matched value.
 *   [unit] resolveGitShim carries refusalKind + offender; the fail-closed (no
 *     refusalKind) deny still renders the generic refusal with the real offender.
 *
 * Scratch repos + host live on ephemeral ports under os.tmpdir(); the real repo is
 * never mutated. The mini-host mirrors src/server/index.ts's decide route body
 * (field validation, secret gate, evaluateGitWrite, the BUG-261 refusalKind).
 */
import http from 'node:http';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installGitShim, resolveGitShim, gitShimRefusal } from './lib/git-shim.mjs';
import { gitWriteGateFailedRefusal, gitWriteRefusal, redactGateDetail } from './lib/git-write-policy.mjs';
import { grantGitWrite, _resetGitGrantsForTest } from './lib/git-grant-store.mjs';

delete process.env.ORCHARD_ALLOW_GIT_WRITE; // keep the block ON for the whole run

const DIR = path.dirname(fileURLToPath(import.meta.url));
const LIBDIR = path.resolve(DIR, 'lib');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'bug261-'));
const TEST_AUTH = 'bug261-auth-' + Math.random().toString(16).slice(2);
const PROJECT = 'proj-261';

// A scrubbed "fresh launch" env: strip any inherited shim dir + shim/grant vars so
// this verifier running INSIDE an Orchard session does not import the parent shim.
const CLEAN_PATH = (process.env.PATH ?? '').split(path.delimiter)
  .filter((p) => p && p !== process.env.ORCHARD_GIT_SHIM_DIR).join(path.delimiter);
const BASE = { ...process.env, PATH: CLEAN_PATH };
for (const k of ['ORCHARD_GIT_SHIM_DIR', 'ORCHARD_GIT_GRANT_KEY', 'ORCHARD_GIT_SHIM_HOST', 'ORCHARD_ALLOW_GIT_WRITE']) delete BASE[k];

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };

// A private value the gate would echo — built by concatenation so THIS file never
// carries the literal (npm run gate scans it).
const HOME = '/home/' + 'sa' + 'p';
const USERVAL = 'sa' + 'p';
// A realistic multi-line gate detail, shaped exactly like runLeakGateForRepo's
// output (hostGateBanner + capped hit lines with VALUE excerpts + footer + FAIL
// summary). The hit lines carry the private values; the labels in [ ] are generic.
const GATE_DETAIL = [
  'Orchard host leak gate (/opt/orchard/scripts/leak-gate.mjs) — authoritative for this commit; a repo-local scripts/leak-gate.mjs is only a preflight.',
  'LEAK GATE: ran',
  `docs/notes.md:12: [home path] absolute path is ${HOME}/projects/secret-thing/config`,
  `deploy/env.sh:4: [username (bare word)] RUN_AS=${USERVAL}`,
  'LEAK GATE: how to resolve —',
  '  - a real leak: remove it; the commit stays refused until it is gone.',
  'LEAK GATE: FAIL — 2 hit(s) in 2 file(s) across 41 files [REPO (changed vs HEAD)].',
].join('\n');

// The decisive phrases (substrings that must ride on both head -1 and tail -1).
const GATE_DECISIVE = 'git IS granted for this project';
const GATE_DECISIVE_2 = 'leak gate FAILED';
const UNGRANTED_DECISIVE = 'was REFUSED — no grant lifted it';

// ── The EXACT pre-BUG-261 code, inlined, so the must-FAIL is a real baseline ─────
function preFixRender(reason) {
  // scripts/lib/git-shim.mjs:396 BEFORE BUG-261.
  return (typeof reason === 'string' && reason.startsWith('orchard: ')) ? reason : gitShimRefusal(reason);
}
function preFixGateFailedMessage(offender, detail = '') {
  // scripts/lib/git-write-policy.mjs gitWriteGateFailedRefusal BEFORE BUG-261.
  const d = String(detail || '').trim();
  return [
    `Git writes ARE granted for this project, but \`${offender}\` was blocked: the`,
    'leak gate FAILED. A grant lifts the prohibition on git writes; it never lifts',
    'the leak gate. This commit/push would carry a private token (a home path, a',
    'username, or a private project name) into history — the exact leak FEAT-108',
    'exists to prevent, and the trade the user set is explicit: a leaked commit is',
    'never acceptable, granted or not.',
    '',
    'Fix the leak the gate reports, then retry — or leave the work UNSTAGED and',
    'report the file list for the user to handle. Run `npm run gate` to see the',
    'hits yourself.',
    ...(d ? ['', 'Leak gate said:', d] : []),
  ].join('\n');
}

const firstLine = (s) => String(s).split('\n')[0];
const lastLine = (s) => { const L = String(s).replace(/\n+$/, '').split('\n'); return L[L.length - 1]; };

// ── A separate host PROCESS mirroring index.ts's decide route (with refusalKind) ─
const HOST_SRC = `
import http from 'node:http';
import { evaluateGitWrite } from ${JSON.stringify(path.join(LIBDIR, 'git-grant.mjs'))};
import { grantGitWrite, revokeGitWrite, _resetGitGrantsForTest } from ${JSON.stringify(path.join(LIBDIR, 'git-grant-store.mjs'))};
delete process.env.ORCHARD_ALLOW_GIT_WRITE;
const EXPECTED = process.env.EXPECTED_AUTH || '';
const GATE_DETAIL = process.env.GATE_DETAIL || '';
const read = (req) => new Promise((r) => { let s=''; req.on('data',c=>s+=c); req.on('end',()=>r(s)); });
const send = (res,obj) => { res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify(obj)); };
const server = http.createServer(async (req,res) => {
  const raw = await read(req);
  if (req.url === '/_test/reset') { _resetGitGrantsForTest(); return send(res,{ok:true}); }
  if (req.url === '/_test/grant') { const b=JSON.parse(raw||'{}'); grantGitWrite(b.projectKey,{scope:b.scope,ttlMs:b.ttlMs}); return send(res,{ok:true}); }
  if (req.method==='POST' && req.url==='/api/git-shim/decide') {
    let body; try { body = JSON.parse(raw||'{}'); } catch { return send(res,{allow:false,reason:'unreadable',refusalKind:'error'}); }
    const grantKey = typeof body.grantKey==='string'&&body.grantKey?body.grantKey:null;
    const argv = Array.isArray(body.argv)?body.argv.filter(a=>typeof a==='string'):null;
    const sessionLabel = typeof body.sessionLabel==='string'?body.sessionLabel:null;
    const auth = typeof body.shimAuth==='string'?body.shimAuth:null;
    if (!grantKey||!argv) return send(res,{allow:false,reason:'required',refusalKind:'error'});
    if (auth !== EXPECTED) return send(res,{allow:false,reason:'invalid shim credential',refusalKind:'error'});
    // A failing leak gate that reports the realistic (value-carrying) detail.
    const d = evaluateGitWrite({ argv, projectKey:grantKey, sessionLabel, runLeakGate:()=>({ok:false,detail:GATE_DETAIL}) });
    // BUG-261 — the TYPED outcome the shim renders by (mirrors src/server/index.ts).
    return send(res,{ allow:!!d.allow, reason:d.reason??null, offender:d.offender??null,
      refusalKind: d.allow?null:(d.gateFailed?'gate-failed':'ungranted') });
  }
  res.writeHead(404); res.end();
});
server.listen(0,'127.0.0.1',()=>{ process.stdout.write('READY '+server.address().port+'\\n'); });
`;
async function startHostProcess() {
  const file = path.join(SCRATCH, 'host.mjs');
  fs.writeFileSync(file, HOST_SRC);
  const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...BASE, EXPECTED_AUTH: TEST_AUTH, GATE_DETAIL } });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const to = setTimeout(() => reject(new Error('host did not become READY')), 5000);
    child.stdout.on('data', (c) => { buf += c; const m = buf.match(/READY (\d+)/); if (m) { clearTimeout(to); resolve(Number(m[1])); } });
    child.on('exit', () => { clearTimeout(to); reject(new Error('host exited early')); });
  });
  return { child, url: `http://127.0.0.1:${port}` };
}
const ctl = (url, p, body) => fetch(url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then((r) => r.json());

function scratchRepo(name) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, name + '-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: BASE });
  g('init', '-q'); g('config', 'user.email', 'x@x'); g('config', 'user.name', 'x');
  fs.writeFileSync(path.join(dir, 'a'), '1'); g('add', 'a'); g('commit', '-q', '-m', 'seed');
  return { dir, g };
}

/** Run `git push` through the installed shim subprocess, returning the FULL 2>&1 text,
 *  plus what a `| head -1` and a `| tail -1` would each see (via a real shell pipe). */
function pushThroughShim(dir, shimEnv) {
  const full = spawnSync('git', ['-C', dir, 'push'], { encoding: 'utf8', env: shimEnv });
  const head = spawnSync('sh', ['-c', `git -C ${JSON.stringify(dir)} push 2>&1 | head -1`], { encoding: 'utf8', env: shimEnv });
  const tail = spawnSync('sh', ['-c', `git -C ${JSON.stringify(dir)} push 2>&1 | tail -1`], { encoding: 'utf8', env: shimEnv });
  return { status: full.status, stderr: full.stderr || '', head: (head.stdout || '').trim(), tail: (tail.stdout || '').trim() };
}

async function main() {
  // ── [must-FAIL] synthesized pre-fix: generic refusal, decisive phrase absent ──
  console.log('[must-FAIL] the pre-BUG-261 render + message produce the generic refusal');
  {
    const preOut = preFixRender(preFixGateFailedMessage('git push', GATE_DETAIL));
    ok(/git write refused at the invocation layer/.test(preOut),
      'pre-fix output IS the generic gitShimRefusal (the bug)');
    ok(!firstLine(preOut).includes(GATE_DECISIVE) && !lastLine(preOut).includes(GATE_DECISIVE),
      'pre-fix: the decisive "grant active / gate failed" phrase is on NEITHER head -1 NOR tail -1');
    // And the fixed message, over the identical inputs, DOES carry it both ends.
    const fixedOut = gitWriteGateFailedRefusal('git push', GATE_DETAIL);
    ok(firstLine(fixedOut).includes(GATE_DECISIVE) && firstLine(fixedOut).includes(GATE_DECISIVE_2),
      'fixed: decisive phrase on head -1');
    ok(lastLine(fixedOut).includes(GATE_DECISIVE) && lastLine(fixedOut).includes(GATE_DECISIVE_2),
      'fixed: decisive phrase on tail -1');
  }

  // ── [redaction] COUNTS only; never a value, path, or excerpt ──────────────────
  console.log('\n[redaction] redactGateDetail surfaces only the gate-authored counts');
  {
    const r = redactGateDetail(GATE_DETAIL);
    ok(/^2 hit\(s\) in 2 file\(s\) /.test(r), `redacted summary is counts only: "${r}"`);
    ok(/npm run gate/.test(r), 'redacted summary points to `npm run gate` for the kinds + file:line');
    ok(!r.includes(HOME) && !r.includes('/projects/secret-thing') && !r.includes('RUN_AS=' + USERVAL),
      'redacted summary contains NO matched value');
    ok(!r.includes('docs/notes.md') && !r.includes('deploy/env.sh'), 'redacted summary contains NO file path');
    ok(redactGateDetail('') === '' && redactGateDetail(null) === '', 'empty detail → empty summary');

    // ADVERSARIAL (BUG-261 r3 clean-room): a legal file name that itself contains
    // `:N: [ … ]` must NOT let a path/value fragment ride out as a "label". Because
    // redaction reads ONLY the gate-authored FAIL summary, a pathological hit line
    // cannot leak. `pathVal` built by concatenation so this file carries no literal.
    const pathVal = HOME + '/clients/acme-secret';
    const adv = [
      `notes:1: [${pathVal}]:42: [home path] RUN_AS=${USERVAL} ${pathVal}`,
      'LEAK GATE: FAIL — 1 hit(s) in 1 file(s) across 9 files [REPO (changed vs HEAD)].',
    ].join('\n');
    const ra = redactGateDetail(adv);
    ok(ra === '1 hit(s) in 1 file(s) (the kinds and exact file:line are NOT shown here — run `npm run gate` to see them)',
      `adversarial path-in-name → counts only: "${ra}"`);
    ok(!ra.includes('/home/') && !ra.includes('acme-secret') && !ra.includes(USERVAL) && !ra.includes('notes:1'),
      'adversarial: NO path fragment, value, or filename escapes redaction');
    // And through the full gate-failed message:
    const advMsg = gitWriteGateFailedRefusal('git push', adv);
    ok(!advMsg.includes('/home/') && !advMsg.includes('acme-secret') && !advMsg.includes('RUN_AS=' + USERVAL),
      'adversarial: the full refusal message leaks no path fragment or value');
  }

  // ── [unit] resolveGitShim carries refusalKind + offender; fail-closed stays generic ──
  console.log('\n[unit] resolveGitShim typed-outcome plumbing + fail-closed fallback');
  {
    // No coords baked → fail closed, no host call: no refusalKind, offender is the
    // local `git <sub>` token (so the generic refusal names the real offender).
    const fc = await resolveGitShim(['push'], BASE);
    ok(fc.allow === false && fc.refusalKind == null && fc.offender === 'git push',
      'fail-closed deny: refusalKind null, offender = "git push"');
    ok(!gitShimRefusal(fc.offender ?? fc.reason).includes('leak gate FAILED'),
      'fail-closed renders the GENERIC refusal (no false gate-failed claim)');
  }

  // ── [e2e] real `git push` through the installed shim against a real host ──────
  console.log('\n[e2e] real subprocess `git push` through the shim, piped to head -1 / tail -1');
  {
    const { child, url: hostUrl } = await startHostProcess();
    try {
      const { dir } = scratchRepo('e2e');
      const { env: shimEnv } = installGitShim(BASE, { baseDir: SCRATCH, grantKey: PROJECT, hostUrl, shimAuth: TEST_AUTH });

      // (a) GRANTED + gate fails → the gate-specific message, decisive on both ends.
      await ctl(hostUrl, '/_test/reset');
      await ctl(hostUrl, '/_test/grant', { projectKey: PROJECT, scope: 'duration', ttlMs: 20 * 60 * 1000 });
      const gf = pushThroughShim(dir, shimEnv);
      ok(gf.status !== 0, 'granted+gate-failed: push refused (nonzero)');
      ok(gf.head.includes(GATE_DECISIVE) && gf.head.includes(GATE_DECISIVE_2),
        'granted+gate-failed: `| head -1` carries the decisive phrase');
      ok(gf.tail.includes(GATE_DECISIVE) && gf.tail.includes(GATE_DECISIVE_2),
        'granted+gate-failed: `| tail -1` carries the decisive phrase');
      ok(/restart will NOT help/.test(gf.stderr) && /npm run gate/.test(gf.stderr),
        'granted+gate-failed: full stderr says a restart will not help + names `npm run gate`');
      ok(/2 hit\(s\) in 2 file\(s\)/.test(gf.stderr) && /npm run gate/.test(gf.stderr),
        'granted+gate-failed: names what the gate flagged (counts; defers kinds to `npm run gate`)');
      // The redacted flagged-summary carries NO token-label list (counts only — r3). The
      // static explanatory prose mentions "a home path, a username" as generic examples;
      // the leak-safety assertions below target the ACTUAL flagged values/paths, not prose.
      ok(!gf.stderr.includes('username (bare word)'),
        'granted+gate-failed: does NOT echo the gate token-label "username (bare word)" from the detail');
      ok(!gf.stderr.includes(HOME) && !gf.stderr.includes('/projects/secret-thing') && !gf.stderr.includes('RUN_AS=' + USERVAL),
        'granted+gate-failed: NO private value leaked into the refusal');
      ok(!gf.stderr.includes('docs/notes.md') && !gf.stderr.includes('deploy/env.sh'),
        'granted+gate-failed: NO file path leaked into the refusal');
      ok(!/git write refused at the invocation layer/.test(gf.stderr),
        'granted+gate-failed: NOT the generic refusal');

      // (b) NO grant → the ungranted message, its distinct decisive fact on both ends.
      await ctl(hostUrl, '/_test/reset');
      const ug = pushThroughShim(dir, shimEnv);
      ok(ug.status !== 0, 'ungranted: push refused (nonzero)');
      ok(ug.head.includes(UNGRANTED_DECISIVE), 'ungranted: `| head -1` carries the ungranted decisive fact');
      ok(ug.tail.includes(UNGRANTED_DECISIVE), 'ungranted: `| tail -1` carries the ungranted decisive fact');
      ok(!ug.stderr.includes(GATE_DECISIVE), 'ungranted: does NOT claim a grant is active (distinct from gate-failed)');
      ok(!ug.stderr.includes('NO grant is active'),
        'ungranted: does NOT assert "NO grant is active" (route maps grant-active slot/claim denials here too — BUG-261 r2 finding)');

      // (c) HOST FAIL-CLOSED (bad shim secret, refusalKind 'error'): the shim must
      // still render the GENERIC FEAT-135 refusal naming the real offender — not the
      // terse host line verbatim (BUG-261 r2 finding 1 regression guard). The host's
      // specific error reason survives as appended context.
      const { env: badEnv } = installGitShim(BASE, { baseDir: SCRATCH, grantKey: PROJECT, hostUrl, shimAuth: 'the-wrong-secret' });
      const fcPush = pushThroughShim(dir, badEnv);
      ok(fcPush.status !== 0, 'fail-closed (bad secret): push refused (nonzero)');
      ok(/git write refused at the invocation layer: `git push`/.test(fcPush.stderr),
        'fail-closed: renders the GENERIC FEAT-135 refusal naming the real offender `git push`');
      ok(fcPush.stderr.includes('Host said:') && /invalid shim credential/.test(fcPush.stderr),
        'fail-closed: the host error reason survives as appended context');
      ok(!fcPush.head.includes(GATE_DECISIVE) && !fcPush.head.includes('no grant lifted it'),
        'fail-closed: not mis-rendered as a gate-failed or ungranted message');
    } finally {
      child.kill();
    }
  }

  _resetGitGrantsForTest();
  console.log(`\nBUG-261: ${pass} passed, ${fail} failed`);
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('verify threw:', e); try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {} process.exit(1); });
