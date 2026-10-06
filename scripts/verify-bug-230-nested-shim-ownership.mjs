#!/usr/bin/env node
/**
 * BUG-230 — a nested Orchard runtime must never delete its PARENT session's git
 * shim, and a session whose own shim goes missing must fail CLOSED.
 *
 *   node scripts/verify-bug-230-nested-shim-ownership.mjs
 *
 * The parent is a REAL shim (installGitShim) standing in for an agent session's;
 * every child below is started from the parent's env, exactly as a lane's child
 * inherits it:
 *   A  a direct nested installGitShim(parentEnv)            (the ticket's probe)
 *   B  the REAL scripts/dispatch.mjs --provider openai       (in-process CodexRuntime;
 *      fake app-server via CLAUDE_STATION_CODEX_BIN)
 *   C  a REAL scratch server (isolatedServerEnv) launching a session (fake CLI)
 * After each: the parent shim dir still exists AND still refuses a subprocess
 * `git commit` on a throwaway repo, AND the child really installed its own shim
 * (non-vacuity: its recorded ORCHARD_GIT_SHIM_DIR is a different, live dir).
 *
 *   D  fail-closed, Claude runtime: an in-process ClaudeRuntime + fake CLI drives
 *      the REAL PreToolUse hook over the control channel — shim deleted → restored
 *      before the Bash call (git resolves to the shim again; a subprocess commit is
 *      refused); shim path made unrestorable → the Bash call is DENIED.
 *   E  fail-closed, Codex runtime: shim deleted → next turn restores it; shim path
 *      unrestorable → the next turn is refused with an error result.
 *
 * must-FAIL on the pre-change code: A/B/C (parent dir deleted), D-p2/p3, E.
 * Safety: the INVOKING session's own shim is stripped from this process's env up
 * front, so even the pre-change code can only ever delete this suite's own scratch
 * parent. All scratch under scripts/lib/scratch.mjs; only throwaway repos are ever
 * registered on the scratch server; every process spawned is killed by pid.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { installGitShim } from './lib/git-shim.mjs';
import { mkdtempScratch } from './lib/scratch.mjs';
import { isolatedServerEnv, isolatedStoreEnv } from './lib/station-boot.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const FAKE_CLI = path.join(ROOT, 'scripts', 'fixtures', 'bug-230', 'fake-cli.mjs');
const CODEX_WRAP = path.join(ROOT, 'scripts', 'fixtures', 'bug-230', 'codex-wrapper.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── never touch the invoking session's shim ─────────────────────────────── */
const INVOKER_SHIM = process.env.ORCHARD_GIT_SHIM_DIR;
process.env.PATH = String(process.env.PATH ?? '').split(path.delimiter)
  .filter((p) => p && p !== INVOKER_SHIM && !path.basename(p).startsWith('orchard-git-shim-'))
  .join(path.delimiter);
delete process.env.ORCHARD_GIT_SHIM_DIR;
delete process.env.ORCHARD_ALLOW_GIT_WRITE;

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

const RUN = mkdtempScratch('bug230-');
const childShims = new Set(); // shim dirs nested runtimes made (in os.tmpdir) — ours to remove at the end
const spawned = [];

function throwawayRepo(tag) {
  const dir = fs.mkdtempSync(path.join(RUN, `repo-${tag}-`));
  const g = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_INDEX_FILE: '' } });
  g('init', '-q'); g('config', 'user.email', 'b230@example.com'); g('config', 'user.name', 'b230');
  g('commit', '-q', '--allow-empty', '-m', 'base');
  const head = () => g('rev-parse', 'HEAD').stdout.trim();
  return { dir, head0: head(), head };
}

/** Does the parent session's shim still exist and still refuse a subprocess write? */
function parentGuard(parent, repo) {
  const r = spawnSync(process.execPath, ['-e',
    "const{execFileSync}=require('node:child_process');try{execFileSync('git',['commit','--allow-empty','-m','evil'],{cwd:process.argv[1],stdio:['ignore','ignore','pipe']});process.exit(0)}catch(e){process.stderr.write(String(e.stderr||e.message));process.exit(e.status||1)}",
    repo.dir], { encoding: 'utf8', env: parent.env });
  return {
    dirExists: fs.existsSync(parent.shimDir),
    refused: r.status !== 0 && /git write refused at the invocation layer/.test(r.stderr || ''),
    headUnchanged: repo.head() === repo.head0,
    code: r.status,
  };
}
function assertParent(label, parent, repo) {
  const g = parentGuard(parent, repo);
  check(`${label}: the parent's shim dir still exists`, g.dirExists, { shimDir: parent.shimDir, exists: g.dirExists });
  check(`${label}: the parent's shim still REFUSES a subprocess git commit (no fall-through to real git)`, g.refused && g.headUnchanged, g);
}
function readJsonl(f) {
  try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
async function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
}
function newParent() {
  return installGitShim(process.env, { baseDir: RUN }); // a real shim, no host coords → every write fails closed
}

async function armA() {
  console.log('\n===== A — a direct nested installGitShim over the parent env =====');
  const parent = newParent();
  const repo = throwawayRepo('a');
  check('A precondition: the parent shim refuses before any child runs', parentGuard(parent, repo).refused, parentGuard(parent, repo));
  const child = installGitShim(parent.env, { baseDir: RUN });
  check('A: the child got its OWN shim dir', child.shimDir !== parent.shimDir && fs.existsSync(path.join(child.shimDir, 'git')), { parent: parent.shimDir, child: child.shimDir });
  check('A: the child env does not stack the parent shim on PATH', !child.env.PATH.split(path.delimiter).includes(parent.shimDir) && child.env.PATH.split(path.delimiter)[0] === child.shimDir, child.env.PATH.split(path.delimiter).slice(0, 2));
  assertParent('A', parent, repo);
}

async function armB() {
  console.log('\n===== B — the REAL dispatch.mjs --provider openai run from inside the parent session =====');
  const parent = newParent();
  const repo = throwawayRepo('b');
  const out = path.join(RUN, 'b-env.jsonl');
  const cwd = fs.mkdtempSync(path.join(RUN, 'b-cwd-'));
  const r = await new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), '--provider', 'openai', '--cwd', cwd, 'hello fixture'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...parent.env, CLAUDE_STATION_DATA: fs.mkdtempSync(path.join(RUN, 'b-data-')), CLAUDE_STATION_CODEX_BIN: CODEX_WRAP, FAKE_OUT: out },
    });
    spawned.push(c);
    let so = '', se = '';
    c.stdout.on('data', (d) => { so += d; }); c.stderr.on('data', (d) => { se += d; });
    const t = setTimeout(() => { try { process.kill(c.pid, 'SIGKILL'); } catch { /* gone */ } }, 60_000);
    c.once('exit', (code) => { clearTimeout(t); resolve({ code, so, se }); });
  });
  const app = readJsonl(out).find((x) => x.argv?.[0] === 'app-server');
  if (app?.shimDir && app.shimDir !== parent.shimDir) childShims.add(app.shimDir);
  check('B: the dispatch ran to completion (exit 0)', r.code === 0, { code: r.code, stderr: r.se.slice(-300) });
  check('B non-vacuity: CodexRuntime installed a NESTED shim of its own for the app-server', !!app?.shimDir && app.shimDir !== parent.shimDir && app.pathHead === app.shimDir, app ?? 'no app-server record');
  assertParent('B', parent, repo);
}

async function armC() {
  console.log('\n===== C — a REAL scratch server (isolatedServerEnv) started from the parent session launches a session =====');
  const parent = newParent();
  const repo = throwawayRepo('c');
  const proj = throwawayRepo('c-proj');
  const out = path.join(RUN, 'c-env.jsonl');
  const PORT = await freePort();
  const DATA = fs.mkdtempSync(path.join(RUN, 'c-data-'));
  const STORE = fs.mkdtempSync(path.join(RUN, 'c-store-'));
  const env = isolatedServerEnv({
    PATH: parent.env.PATH, ORCHARD_GIT_SHIM_DIR: parent.shimDir,
    PORT: String(PORT), CLAUDE_STATION_DATA: DATA, ...isolatedStoreEnv(STORE, { alsoReader: true }),
    CLAUDE_STATION_CLAUDE_BIN: FAKE_CLI, CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0',
    CLAUDE_STATION_SURVIVE: '0', // the CLI stays the server's child, so killing the server by pid reaps it
    FAKE_OUT: out,
  });
  const srv = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  spawned.push(srv);
  let log = ''; srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  const BASE = `http://127.0.0.1:${PORT}`;
  try {
    let up = false;
    for (let i = 0; i < 200 && !up; i++) { try { up = (await fetch(`${BASE}/api/projects`)).ok; } catch { /* booting */ } if (!up) await sleep(150); }
    if (!up) { check('C: scratch server booted', false, log.slice(-600)); return; }
    const reg = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: proj.dir, name: 'b230-throwaway', isolation: 'direct', applyMethod: false }) })).json();
    const projectId = reg.project?.id;
    check('C: throwaway project registered on the scratch server', !!projectId, reg);
    if (!projectId) return;
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const events = [];
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (e) => { try { events.push(JSON.parse(String(e.data))); } catch { /* ignore */ } };
    for (let t = 0; t < 40 && readJsonl(out).length === 0; t++) {
      const seen = events.length;
      ws.send(JSON.stringify({ type: 'start', projectId, overrides: { model: 'haiku', permissionMode: 'bypassPermissions' }, prompt: 'hi' }));
      let pending = false;
      for (let i = 0; i < 30; i++) {
        await sleep(100);
        if (events.slice(seen).some((e) => e.code === 'runtime-check-pending')) { pending = true; break; }
        if (readJsonl(out).length) break;
      }
      if (!pending) break;
      await sleep(1500);
    }
    for (let i = 0; i < 100 && readJsonl(out).length === 0; i++) await sleep(100);
    const rec = readJsonl(out)[0];
    if (rec?.shimDir && rec.shimDir !== parent.shimDir) childShims.add(rec.shimDir);
    check('C non-vacuity: the scratch server launched a session that got its OWN nested shim', !!rec?.shimDir && rec.shimDir !== parent.shimDir && rec.pathHead === rec.shimDir, rec ?? { events: events.slice(-4), log: log.slice(-400) });
    assertParent('C (session live)', parent, repo);
    try { ws.close(); } catch { /* ignore */ }
  } finally {
    try { process.kill(srv.pid, 'SIGTERM'); } catch { /* gone */ }
    for (let i = 0; i < 40 && srv.exitCode === null && srv.signalCode === null; i++) await sleep(150);
    try { process.kill(srv.pid, 'SIGKILL'); } catch { /* gone */ }
  }
  assertParent('C (server stopped)', parent, repo);
}

async function armD() {
  console.log('\n===== D — fail-closed, Claude runtime: the REAL PreToolUse hook when the session\'s own shim vanishes =====');
  const { ClaudeRuntime } = await import(path.join(ROOT, 'src', 'server', 'runtime', 'claude-runtime.ts'));
  const repo = throwawayRepo('d');
  const out = path.join(RUN, 'd-env.jsonl');
  const probeOut = path.join(RUN, 'd-probe.json');
  const saved = { ...process.env };
  Object.assign(process.env, { CLAUDE_STATION_CLAUDE_BIN: FAKE_CLI, FAKE_OUT: out, FAKE_PROBE_OUT: probeOut, FAKE_REPO: repo.dir });
  const rt = new ClaudeRuntime();
  try {
    try {
      rt.start({ cwd: repo.dir, firstPrompt: '[[probe]]', permissionMode: 'default', onApproval: async () => ({ behavior: 'deny', message: 'n/a' }) });
      void (async () => { try { for await (const _ of rt.messages()) { /* drain */ } } catch { /* ignore */ } })();
    } catch { /* ignore */ }
    for (let i = 0; i < 300 && !fs.existsSync(probeOut); i++) await sleep(100);
  } finally {
    try { rt.close(); } catch { /* ignore */ }
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
  const rec = readJsonl(out)[0];
  if (!fs.existsSync(probeOut)) { check('D: the probe ran inside the runtime-launched fake CLI', false, rec ?? 'no fake start'); return; }
  const p = JSON.parse(fs.readFileSync(probeOut, 'utf8'));
  if (p.error) { check('D: probe completed', false, p.error); return; }
  const shimGit = rec?.shimDir ? path.join(rec.shimDir, 'git') : null;
  check('D control: shim intact → the Bash call is allowed', p.p1?.verdict === 'allow', p.p1);
  check('D threat is real: with the shim dir deleted, `git` falls through PATH to a real binary', !!p.p2?.gitAfterDeleteBeforeHook && p.p2.gitAfterDeleteBeforeHook !== shimGit, p.p2?.gitAfterDeleteBeforeHook);
  check('D: the hook restored the shim before the Bash call ran (git resolves to the shim again)', p.p2?.shimBack === true && p.p2?.gitAfterHook === shimGit, { shimBack: p.p2?.shimBack, gitAfterHook: p.p2?.gitAfterHook, shimGit });
  check('D: after restore a subprocess git commit is REFUSED', p.p2?.commit?.code !== 0 && /git write refused/.test(p.p2?.commit?.stderr || '') && repo.head() === repo.head0, p.p2?.commit);
  check('D: shim unrestorable → the Bash call is DENIED (fail closed), naming BUG-230', p.p3?.hook?.verdict === 'deny' && /BUG-230/.test(p.p3?.hook?.text || ''), p.p3);
}

async function armE() {
  console.log('\n===== E — fail-closed, Codex runtime: a turn when the session\'s own shim vanishes =====');
  const { CodexRuntime } = await import(path.join(ROOT, 'src', 'server', 'runtime', 'codex-runtime.ts'));
  const cwd = fs.mkdtempSync(path.join(RUN, 'e-cwd-'));
  const out = path.join(RUN, 'e-env.jsonl');
  const saved = { ...process.env };
  Object.assign(process.env, { FAKE_OUT: out, CLAUDE_STATION_DATA: fs.mkdtempSync(path.join(RUN, 'e-data-')) });
  const rt = new CodexRuntime();
  const results = [];
  try {
    rt.start({ cwd, firstPrompt: 'hello fixture', permissionMode: 'default', pathToExecutable: CODEX_WRAP, onApproval: async () => ({ behavior: 'allow', updatedInput: {} }) });
    void (async () => { try { for await (const m of rt.messages()) if (m?.type === 'result') results.push(m); } catch { /* ignore */ } })();
    const waitResults = async (n) => { for (let i = 0; i < 150 && results.length < n; i++) await sleep(100); };
    await waitResults(1);
    const rec = readJsonl(out).find((x) => x.argv?.[0] === 'app-server');
    const shimDir = rec?.shimDir;
    check('E control: first turn completes; the app-server got the runtime\'s shim', results.length >= 1 && !results[0].is_error && !!shimDir, { results: results.length, shimDir });
    if (!shimDir) return;
    fs.rmSync(shimDir, { recursive: true, force: true });
    rt.send('again');
    await waitResults(2);
    check('E: shim deleted → the next turn restores it and runs', fs.existsSync(path.join(shimDir, 'git')) && results.length >= 2 && !results[1].is_error, { restored: fs.existsSync(path.join(shimDir, 'git')), r: results[1] && { is_error: results[1].is_error, result: String(results[1].result ?? '').slice(0, 80) } });
    fs.rmSync(shimDir, { recursive: true, force: true });
    fs.writeFileSync(shimDir, 'not a directory');
    rt.send('third');
    await waitResults(3);
    check('E: shim unrestorable → the turn is REFUSED with an error result naming BUG-230', results.length >= 3 && results[2].is_error === true && /BUG-230/.test(String(results[2].result ?? '')), results[2] ?? 'no third result');
    fs.rmSync(shimDir, { force: true });
  } finally {
    try { rt.close(); } catch { /* ignore */ }
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

async function main() {
  console.log(`invoking session shim stripped from this process: ${INVOKER_SHIM ? 'yes' : 'none set'}`);
  for (const arm of [armA, armB, armC, armD, armE]) {
    try { await arm(); } catch (e) { check(`${arm.name} threw`, false, String(e?.stack ?? e).slice(0, 400)); }
  }
}

main().finally(() => {
  for (const c of spawned) { if (c.exitCode === null && c.signalCode === null) { try { process.kill(c.pid, 'SIGKILL'); } catch { /* gone */ } } }
  for (const d of childShims) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  try { fs.rmSync(RUN, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(`\nBUG-230: ${pass} passed, ${fail} failed${fail ? `\n  - ${failures.join('\n  - ')}` : ''}`);
  process.exit(fail ? 1 : 0);
});
