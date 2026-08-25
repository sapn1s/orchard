#!/usr/bin/env node
/**
 * verify-bug-092-sandbox-recorder.mjs — BUG-092.
 *
 * The cross-provider clean-room verifier (openai/codex) always returned INVALID
 * because the run recorder was a unix-domain socket, and codex `workspace-write`
 * blocks AF_UNIX `connect()` with EPERM — empirically, even when the socket path
 * is INSIDE the writable workspace (a seccomp block on the syscall, not a
 * Landlock path block). The fix replaces the socket with an in-workspace FILE
 * SPOOL (`.vrun/req` + `.vrun/res`), which the sandbox permits, while keeping
 * the authoritative manifest in the harness's memory so forgery stays detectable.
 *
 * What this proves WITHOUT a provider:
 *  (A) SHAPE — the vrun.mjs the harness generates is the file-spool client (no
 *      `net`/socket; it talks to `.vrun/req`/`.vrun/res`), and the harness owns
 *      a heartbeat so a dead recorder is detected, never hung on.
 *  (B) END-TO-END (in process) — a plain client whose cwd IS the workspace can
 *      record a run through vrun.mjs and read back the harness-assigned id, and
 *      the harness's in-memory manifest holds exactly that run. This is the
 *      transport the sandbox now uses, exercised faithfully.
 *  (C) LIVENESS — with the harness gone, vrun REFUSES to record (exit 2) rather
 *      than hanging or forging a record around a dead recorder.
 *
 * The real sandboxed proof (a codex dispatch under workspace-write actually
 * recording a run through the spool) was run by hand on 2026-08-14 and is
 * reproducible with CLAUDE_STATION_VERIFY_CODEX=1 (needs `codex` + auth; it
 * costs a real dispatch, so it is opt-in). Without the flag that leg is SKIPPED,
 * loudly.
 *
 * Run: node scripts/verify-bug-092-sandbox-recorder.mjs
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const IV = path.join(ROOT, 'scripts', 'independent-verify.mjs');

let pass = 0, fail = 0, skip = 0;
const failures = [];
function check(name, ok, observed) {
  const o = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${(o ?? '').slice(0, 400)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
function skipped(name, why) { console.log(`  SKIP  ${name}\n        ${why}`); skip++; }

const tmpDirs = [];
function tmp(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.push(d); return d; }
function cleanup() { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } } }

// Build a real clean room + recorder by asking independent-verify to print the
// prompt and KEEP the room. This runs the actual buildCleanroom() path, so the
// vrun.mjs and spool it produces are the real ones.
function buildKeptRoom() {
  // A tiny throwaway git repo with a one-commit diff so --range HEAD has content.
  const repo = tmp('bug092-repo-');
  const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'thing.mjs'), 'export const total = (xs) => xs.filter(Boolean).length;\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  fs.writeFileSync(path.join(repo, 'thing.mjs'), 'export const total = (xs) => xs.filter(Boolean).length; // changed\n');
  git('add', '-A'); git('commit', '-qm', 'change');
  const r = spawnSync(process.execPath, [
    IV, '--repo', repo, '--range', 'HEAD', '--requirement', 'total(xs) counts truthy entries.',
    '--print-prompt', '--keep-cleanroom',
  ], { encoding: 'utf8' });
  const room = /clean room: (\S+)/.exec(r.stderr)?.[1] ?? null;
  return { repo, room, stderr: r.stderr };
}

/* ============================== (A) transport SHAPE ======================= */

console.log('\n(A) the harness-generated vrun.mjs is the file-spool client (not a socket)');

const built = buildKeptRoom();
if (!built.room || !fs.existsSync(path.join(built.room, 'vrun.mjs'))) {
  check('a clean room with a vrun.mjs was built', false, built.stderr.slice(0, 300));
} else {
  const src = fs.readFileSync(path.join(built.room, 'vrun.mjs'), 'utf8');
  check('vrun.mjs is a FILE-SPOOL client — no unix socket (AF_UNIX connect is blocked by the codex sandbox)',
    !/node:net|net\.connect|\.sock\b/.test(src) && /\.vrun/.test(src) && /req/.test(src) && /res/.test(src),
    src.split('\n').find((l) => l.includes('const REQ') || l.includes('const RES')) ?? 'no spool consts found');
  check('vrun.mjs carries a LIVENESS check (a dead recorder is detected, never hung on or forged around)',
    /ALIVE/.test(src) && /STALE_MS/.test(src),
    'vrun reads the harness heartbeat before/while waiting');
  check('the request/response spool lives INSIDE the workspace (the writable root the sandbox grants)',
    src.includes(built.room), `workspace=${built.room}`);
}

/* ============================ (B) END-TO-END record ======================= */

console.log('\n(B) a client whose cwd is the workspace records a run and reads back the harness id');

if (!built.room) {
  skipped('end-to-end record through the file spool', 'no clean room to test against');
} else {
  // The harness that owns the recorder for the KEPT room has already exited
  // (--print-prompt closes it). So spin a SEPARATE minimal harness that watches
  // the same spool — this is the exact transport the live path uses, exercised
  // in-process. (A real live run is exercised end-to-end by the anthropic shim
  // tests in verify-independent-verification.mjs.)
  const reqDir = path.join(built.room, '.vrun', 'req');
  const resDir = path.join(built.room, '.vrun', 'res');
  const aliveFile = path.join(built.room, '.vrun', 'alive');
  fs.mkdirSync(reqDir, { recursive: true });
  fs.mkdirSync(resDir, { recursive: true });
  const harness = `
    import * as fs from 'node:fs';
    import { spawnSync } from 'node:child_process';
    import { createHash, randomBytes } from 'node:crypto';
    const REQ=${JSON.stringify(reqDir)}, RES=${JSON.stringify(resDir)}, ALIVE=${JSON.stringify(aliveFile)}, WS=${JSON.stringify(built.room)};
    const entries=[]; const seen=new Set();
    const beat=()=>{try{fs.writeFileSync(ALIVE,String(Date.now()))}catch{}};
    const drain=()=>{beat(); let fs2; try{fs2=fs.readdirSync(REQ)}catch{return} for(const f of fs2){
      if(seen.has(f)||!f.endsWith('.json')||f.startsWith('.'))continue; seen.add(f);
      let req; try{req=JSON.parse(fs.readFileSync(REQ+'/'+f,'utf8'))}catch{continue}
      const cmd=String(req.cmd||'').trim();
      const r=spawnSync('sh',['-c',cmd],{cwd:WS,encoding:'utf8'});
      const output=(r.stdout||'')+(r.stderr||''); const exit=typeof r.status==='number'?r.status:127;
      const sha256=createHash('sha256').update(output).digest('hex').slice(0,16); const id=randomBytes(6).toString('hex');
      entries.push({id,exit}); const obj={id,cmd,exit,sha256,output};
      const tmp=RES+'/.'+f+'.tmp'; fs.writeFileSync(tmp,JSON.stringify(obj)); fs.renameSync(tmp,RES+'/'+f);
    }};
    beat(); const iv=setInterval(drain,50);
    process.on('message',(m)=>{ if(m==='stop'){clearInterval(iv); process.send({entries}); process.exit(0);} });
  `;
  const hFile = path.join(tmp('bug092-harness-'), 'h.mjs');
  fs.writeFileSync(hFile, harness);
  const { fork } = await import('node:child_process');
  const child = fork(hFile, { stdio: 'ignore' });
  // Give the harness a beat, then run vrun from a cwd = the workspace.
  await new Promise((r) => setTimeout(r, 200));
  const run = spawnSync(process.execPath, ['./vrun.mjs', "node -e \"console.log('hello-from-spool')\""], { cwd: built.room, encoding: 'utf8' });
  const manifestLine = (run.stdout ?? '').split('\n').find((l) => l.startsWith('MANIFEST:')) ?? '';
  const recId = /MANIFEST:\s*([A-Fa-f0-9]+)\b/.exec(manifestLine)?.[1] ?? null;
  const harnessEntries = await new Promise((resolve) => {
    child.once('message', (m) => resolve(m.entries));
    child.send('stop');
    setTimeout(() => resolve([]), 2000);
  });
  check('vrun.mjs recorded the run and printed the harness-assigned MANIFEST id',
    run.status === 0 && !!recId && /hello-from-spool/.test(run.stdout),
    `exit=${run.status} manifest="${manifestLine.trim()}"`);
  check('the harness\'s OWN in-memory manifest holds exactly that recorded run (authority is memory, not the disk spool)',
    harnessEntries.some((e) => e.id === recId && e.exit === 0),
    `harness entries=${JSON.stringify(harnessEntries)} vrun id=${recId}`);
}

/* ================================ (C) LIVENESS ============================ */

console.log('\n(C) with the recorder gone, vrun refuses to record (never hangs, never forges)');

if (!built.room || !fs.existsSync(path.join(built.room, 'vrun.mjs'))) {
  skipped('vrun refuses without a live recorder', 'no clean room');
} else {
  // The KEPT room's original recorder was closed on --print-prompt (heartbeat
  // removed). A fresh vrun must see no live recorder and exit 2 promptly.
  try { fs.rmSync(path.join(built.room, '.vrun', 'alive'), { force: true }); } catch { /* */ }
  const start = Date.now();
  const r = spawnSync(process.execPath, ['./vrun.mjs', 'echo should-not-record'], { cwd: built.room, encoding: 'utf8', timeout: 15000 });
  check('vrun exits 2 and says the recorder is unavailable (dead recorder cannot be forged around)',
    r.status === 2 && /recorder is not available/.test(r.stderr ?? ''),
    `exit=${r.status}; ${(r.stderr ?? '').trim().slice(0, 140)}`);
  check('  …and it does so PROMPTLY (no long hang waiting on a response that will never come)',
    (Date.now() - start) < 12000, `${Date.now() - start}ms`);
}

/* ===================== (D) real codex sandbox (opt-in) ==================== */

console.log('\n(D) real codex workspace-write sandbox records through the spool (opt-in)');

if (process.env.CLAUDE_STATION_VERIFY_CODEX !== '1') {
  skipped('a real codex dispatch records a run through the file spool',
    'opt-in (costs a real provider dispatch): rerun with CLAUDE_STATION_VERIFY_CODEX=1. Proven by hand 2026-08-14: `codex exec --sandbox workspace-write` recorded a run through .vrun/req+res; the same sandbox returns EPERM on AF_UNIX connect even in-workspace.');
} else if (!spawnSync('sh', ['-c', 'command -v codex'], { encoding: 'utf8' }).stdout.trim()) {
  skipped('a real codex dispatch records a run through the file spool', 'codex not on PATH');
} else {
  const ws = tmp('bug092-codex-ws-');
  const reqDir = path.join(ws, '.vrun', 'req'); const resDir = path.join(ws, '.vrun', 'res'); const aliveFile = path.join(ws, '.vrun', 'alive');
  fs.mkdirSync(reqDir, { recursive: true }); fs.mkdirSync(resDir, { recursive: true });
  fs.writeFileSync(path.join(ws, 'vrun.mjs'), fs.readFileSync(path.join(built.room, 'vrun.mjs'), 'utf8')
    .replace(fs.readFileSync(path.join(built.room, 'vrun.mjs'), 'utf8').match(/const REQ = ("[^"]+")/)[1], JSON.stringify(reqDir))
    .replace(/const RES = "[^"]+"/, `const RES = ${JSON.stringify(resDir)}`)
    .replace(/const ALIVE = "[^"]+"/, `const ALIVE = ${JSON.stringify(aliveFile)}`), { mode: 0o755 });
  const harnessSrc = `import * as fs from 'node:fs'; import {spawnSync} from 'node:child_process'; import {createHash,randomBytes} from 'node:crypto';
    const REQ=${JSON.stringify(reqDir)},RES=${JSON.stringify(resDir)},ALIVE=${JSON.stringify(aliveFile)},WS=${JSON.stringify(ws)}; const seen=new Set(); const entries=[];
    const beat=()=>{try{fs.writeFileSync(ALIVE,String(Date.now()))}catch{}};
    const drain=()=>{beat(); let f2; try{f2=fs.readdirSync(REQ)}catch{return} for(const f of f2){ if(seen.has(f)||!f.endsWith('.json')||f.startsWith('.'))continue; seen.add(f); let req; try{req=JSON.parse(fs.readFileSync(REQ+'/'+f,'utf8'))}catch{continue} const r=spawnSync('sh',['-c',String(req.cmd||'')],{cwd:WS,encoding:'utf8'}); const output=(r.stdout||'')+(r.stderr||''); const exit=typeof r.status==='number'?r.status:127; const sha256=createHash('sha256').update(output).digest('hex').slice(0,16); const id=randomBytes(6).toString('hex'); entries.push({id,exit}); const t=RES+'/.'+f+'.tmp'; fs.writeFileSync(t,JSON.stringify({id,cmd:req.cmd,exit,sha256,output})); fs.renameSync(t,RES+'/'+f);} };
    beat(); setInterval(drain,50); process.on('message',(m)=>{if(m==='stop'){process.send({entries});process.exit(0)}});`;
  const hFile = path.join(tmp('bug092-codex-h-'), 'h.mjs'); fs.writeFileSync(hFile, harnessSrc);
  const { fork } = await import('node:child_process');
  const child = fork(hFile, { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 300));
  const cx = spawnSync('codex', ['exec', '--sandbox', 'workspace-write', '--cd', ws, '--skip-git-repo-check', '--color', 'never',
    'Run this single command using the recorder and report its output: node ./vrun.mjs echo recorded-under-sandbox'], { encoding: 'utf8', timeout: 180000 });
  const entries = await new Promise((resolve) => { child.once('message', (m) => resolve(m.entries)); child.send('stop'); setTimeout(() => resolve([]), 3000); });
  check('a real codex workspace-write dispatch recorded a run through the in-workspace file spool',
    entries.length >= 1, `harness recorded ${entries.length} run(s); codex exit=${cx.status}`);
}

/* ================================= summary ================================ */
cleanup();
console.log(`\nverify:bug-092-sandbox-recorder — ${pass}/${pass + fail} PASS${skip ? ` (${skip} SKIPPED)` : ''}`);
if (fail) { console.log('FAILURES:'); for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
process.exit(0);
