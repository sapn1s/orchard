/**
 * BUG-215 round 2 — a container→direct CLAUDE session must FORK, not be refused
 * as "Orchard-owned (Codex)", and a refused fork must never silently eat the
 * typed message.
 *
 *   node scripts/verify-bug-215-r2-container-fork-codex-misclassify.mjs
 *
 * THE BUG. Since FEAT-144 the server MIRRORS every Claude-store transcript into
 * the Orchard transcript store under provider `anthropic`
 * (…/transcripts/anthropic/<encodedDir>/<id>.jsonl). The FEAT-037 P2b fork guard
 * in agent-bridge refused the fork whenever `resolveOrchardSessionFile` found ANY
 * Orchard transcript for the id — which now hits for every mirrored Claude session
 * too. So a container-recorded Claude session, resumed against a now-direct
 * project, armed the fork bar (BUG-215 r1 copy fix) and then, on Fork, was refused
 * with "…is an Orchard-owned (Codex) transcript…". The typed message then vanished
 * on reload because the fatal-error branch never reclaimed pendingStart.
 *
 * PART A — SERVER PREDICATE (real modules, real-shaped scratch fixture; MUST-FAIL
 *   synthesized pre-fix state). A container-encoded Claude transcript in a scratch
 *   CLAUDE store PLUS its `anthropic` mirror in a scratch Orchard data dir (exactly
 *   the two files the live incident had). Drive the REAL `resolveOrchardSessionFile`
 *   over the REAL fixture and show the guard's decision flips:
 *     - PRE-FIX predicate (presence-only: `dirs.some(hit)`) === true  → REFUSE  (the bug)
 *     - POST-FIX predicate (`hit.provider !== CLAUDE_MIRROR_PROVIDER`) === false → ALLOW
 *     - a Codex ('openai') capture still trips POST-FIX === true → REFUSE (anti-regression)
 *   Then planFork stages the container→direct copy from the CLAUDE store into the
 *   host store dir, byte-identical, original untouched (the fork the guard blocked).
 *
 * PART B — SERVER END-TO-END (real scratch server; the ACTUAL guard through a raw
 *   fork `start` frame). Register a direct project, plant the container-dir Claude
 *   session + its anthropic mirror, then send `{type:'start', fork:true,
 *   resumeSessionId, resumeEncodedDir:<containerDir>}`. Assert the server no longer
 *   emits the "Orchard-owned (Codex)" refusal and instead STAGES the fork (status
 *   line + a staged copy lands under the host store dir) — i.e. the real running
 *   guard now lets a mirrored Claude session through.
 *
 * PART C — CLIENT MESSAGE-LOSS (real public/app.js in happy-dom against a real
 *   scratch server). Reproduce the exact journey: open the container-dir session,
 *   get the needs-fork bar, click Fork, type a message, send (arming pendingStart),
 *   then feed the REAL fatal fork-refusal error frame through the REAL `onEvent`.
 *   Assert the typed message is RECLAIMED into the composer and the phantom bubble
 *   removed (kept with a visible error) rather than lost. MUST-FAIL pre-fix: run
 *   with BUG215_APPJS pointing at the HEAD snapshot and the composer is left empty
 *   (message lost) with the bubble still painted.
 *
 * Leak hygiene: every path/name/id here is synthetic (/orchard-scratch/*, scratch
 * tmp dirs). No real project, home, username, or session id.
 */
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Window } from 'happy-dom';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const APPJS = process.env.BUG215_APPJS || path.join(ROOT, 'public', 'app.js');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${line}`);
  ok ? pass++ : (fail++, failures.push(name));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(label, fn, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (fn()) return true; await sleep(100); }
  console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
  return false;
}
async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

const uid = (n) => `00000000-0000-4000-c000-${String(n).padStart(12, '0')}`;
function writeSession(storeDir, sid, text) {
  fs.mkdirSync(storeDir, { recursive: true });
  const t = new Date();
  const lines = [
    JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', uuid: uid(1), timestamp: t.toISOString(), sessionId: sid,
      message: { role: 'user', content: [{ type: 'text', text }] } }),
    JSON.stringify({ parentUuid: uid(1), isSidechain: false, type: 'assistant', uuid: uid(2), timestamp: t.toISOString(), sessionId: sid,
      message: { role: 'assistant', content: [{ type: 'text', text: 'noted.' }] } }),
  ];
  const f = path.join(storeDir, `${sid}.jsonl`);
  fs.writeFileSync(f, lines.join('\n') + '\n');
  execFileSync('touch', ['-d', t.toISOString(), f]);
  return f;
}

// ------------------------------------------------------------------ PART A
async function partA() {
  console.log('\n========== PART A — server: guard keys on PROVIDER, mirrored Claude forks, Codex still refused ==========');
  const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b215r2-a-store-'));
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b215r2-a-data-'));
  const prevStore = process.env.CLAUDE_PROJECTS_DIR;
  const prevData = process.env.CLAUDE_STATION_DATA;
  process.env.CLAUDE_PROJECTS_DIR = STORE;
  process.env.CLAUDE_STATION_DATA = DATA;
  try {
    const cm = await import(`${path.join(ROOT, 'src', 'server', 'container-manager.ts')}?a=${Date.now()}`);
    const reg = await import(`${path.join(ROOT, 'src', 'server', 'registry.ts')}?a=${Date.now()}`);
    const fork = await import(`${path.join(ROOT, 'src', 'server', 'fork.ts')}?a=${Date.now()}`);
    const ot = await import(`${path.join(ROOT, 'src', 'server', 'orchard-transcripts.ts')}?a=${Date.now()}`);
    const sh = await import(`${path.join(ROOT, 'src', 'lib', 'session-history.ts')}?a=${Date.now()}`);

    const CLAUDE_MIRROR_PROVIDER = ot.CLAUDE_MIRROR_PROVIDER;
    check('sanity: the Claude-mirror provider key is "anthropic"', CLAUDE_MIRROR_PROVIDER === 'anthropic', `= ${CLAUDE_MIRROR_PROVIDER}`);

    // A now-DIRECT project whose session was recorded INSIDE the container:
    // the transcript lives in the CLAUDE store under the container-encoded dir.
    const id = 'samplesvc';
    const hostPath = '/orchard-scratch/sample-svc';
    const proj = { id, name: id, hostPath, isolation: 'direct',
      settings: reg.defaultSettings(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const containerDir = cm.containerStoreDirName({ id }); // -workspace-samplesvc
    const hostEnc = sh.encodeCwd(hostPath);                // guard's second candidate dir
    const sid = 'a1b2c3d4-0000-4000-8000-000000000001';

    // The two real files the live incident had: the Claude-store transcript AND
    // its anthropic mirror in the Orchard transcript store, under the SAME dir.
    const srcFile = writeSession(path.join(STORE, containerDir), sid, 'work done inside the container');
    const origBytes = fs.readFileSync(srcFile);
    const mirrorFile = writeSession(path.join(ot.orchardTranscriptsRoot(), 'anthropic', containerDir), sid, 'work done inside the container');

    // The guard's own inputs, computed by the guard's own resolver over real data.
    const dirs = [containerDir, hostEnc];
    const hit = dirs.map((d) => ot.resolveOrchardSessionFile(d, sid)).find((h) => !!h);
    check('A: resolveOrchardSessionFile finds the mirror and names provider "anthropic"',
      !!hit && hit.provider === 'anthropic' && hit.filePath === mirrorFile,
      `hit=${JSON.stringify(hit)}`);

    // MUST-FAIL (synthesized pre-fix): the old presence-only guard would REFUSE.
    const preFixWouldRefuse = dirs.some((d) => !!ot.resolveOrchardSessionFile(d, sid));
    check('A: PRE-FIX guard (presence-only) REFUSES the mirrored Claude session — the bug',
      preFixWouldRefuse === true, `pre-fix dirs.some(hit) = ${preFixWouldRefuse}`);

    // POST-FIX: the shipped predicate ALLOWS a Claude mirror through.
    const postFixWouldRefuse = !!hit && hit.provider !== CLAUDE_MIRROR_PROVIDER;
    check('A: POST-FIX guard (provider !== anthropic) ALLOWS the mirrored Claude fork',
      postFixWouldRefuse === false, `post-fix refuse? = ${postFixWouldRefuse}`);

    // Anti-regression: a genuine Codex ('openai') capture still trips the guard.
    const codexSid = 'ffffffff-0000-4000-c000-000000000002';
    const codexDir = 'C--Users-dev-codexthread';
    writeSession(path.join(ot.orchardTranscriptsRoot(), 'openai', codexDir), codexSid, 'codex thread');
    const codexHit = ot.resolveOrchardSessionFile(codexDir, codexSid);
    const codexRefuse = !!codexHit && codexHit.provider !== CLAUDE_MIRROR_PROVIDER;
    check('A (anti-regression): a Codex ("openai") transcript still trips POST-FIX → REFUSE',
      codexHit?.provider === 'openai' && codexRefuse === true, `codexHit=${JSON.stringify(codexHit)} refuse=${codexRefuse}`);

    // The fork the guard was blocking actually works: planFork stages from the
    // CLAUDE store into the host store dir, byte-identical, original untouched.
    const plan = fork.planFork(proj, sid, containerDir);
    check('A: planFork stages the container→direct copy into the HOST store dir',
      !!plan.stagedFile && plan.stagedFile.includes(hostEnc) && fs.existsSync(plan.stagedFile),
      `stagedFile=${plan.stagedFile} hostEnc=${hostEnc}`);
    check('A: the staged copy is byte-identical to the source (self-contained history)',
      !!plan.stagedFile && fs.readFileSync(plan.stagedFile).equals(origBytes),
      plan.stagedFile ? `staged=${fs.statSync(plan.stagedFile).size}B src=${origBytes.length}B` : 'no stagedFile');
    check('A: the ORIGINAL Claude-store transcript is untouched (byte-for-byte)',
      fs.existsSync(srcFile) && fs.readFileSync(srcFile).equals(origBytes),
      `original ${fs.existsSync(srcFile) ? 'present' : 'GONE'}`);
  } finally {
    if (prevStore === undefined) delete process.env.CLAUDE_PROJECTS_DIR; else process.env.CLAUDE_PROJECTS_DIR = prevStore;
    if (prevData === undefined) delete process.env.CLAUDE_STATION_DATA; else process.env.CLAUDE_STATION_DATA = prevData;
    try { fs.rmSync(STORE, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ---------------------------------------------- shared scratch server (B + C)
let server = null;
async function bootServer() {
  const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b215r2-store-'));
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b215r2-data-'));
  const CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b215r2-config-')); // empty → SDK turn fails fast, no real turn
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  server = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1',
      CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE, CLAUDE_CONFIG_DIR: CONFIG },
    stdio: ['ignore', 'ignore', 'pipe'], detached: true,
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(200); } }
  if (!up) throw new Error('server never became healthy');
  return { STORE, DATA, CONFIG, PORT, BASE };
}

/** Register a direct project + plant the container-dir Claude session and its anthropic mirror. */
async function plantContainerSession(env, { name = 'sample-svc' } = {}) {
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b215r2-proj-'));
  const regRes = await fetch(`${env.BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    // isolation:'direct' — the real scenario: the SESSION ran in a container but
    // the PROJECT now runs direct on the host (so the CLI resolves the host store
    // dir, not the container one, and the session needs a fork).
    body: JSON.stringify({ hostPath: projDir, name, isolation: 'direct', applyMethod: false }),
  });
  if (!regRes.ok) throw new Error(`register failed: ${await regRes.text()}`);
  const PID = (await regRes.json()).project.id;
  const enc = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
  const containerDir = enc(`/workspace/${PID}`);
  const SID = 'a1b2c3d4-0000-4000-8000-0000000000ab';
  writeSession(path.join(env.STORE, containerDir), SID, 'recorded inside the container');
  // The FEAT-144 mirror the live incident had — the file that fooled the guard.
  writeSession(path.join(env.DATA, 'transcripts', 'anthropic', containerDir), SID, 'recorded inside the container');
  return { PID, containerDir, SID, projDir, hostEnc: projDir.replace(/[^a-zA-Z0-9]/g, '-') };
}

// ------------------------------------------------------------------ PART B
async function partB(env) {
  console.log('\n========== PART B — server end-to-end: the real guard STAGES a mirrored Claude fork (no Codex refusal) ==========');
  const { PID, containerDir, SID } = await plantContainerSession(env);

  const codexRe = (e) => e.t === 'error' && /Orchard-owned \(Codex\)/.test(String(e.message || ''));
  const forkAck = (e) => e.t === 'ack' && e.of === 'start' && e.fork && e.fork.forked === true;
  const stagingStatus = (e) => e.t === 'status' && /staged a/.test(String(e.status || ''));
  // A now-DIRECT (host) session start is gated on the boot runtime check; that gate
  // is transient — retry the fork start on a fresh socket until it clears.
  const transientGate = (e) => e.t === 'error' && /runtime check pending|checking runtime/.test(String(e.message || ''));

  let ev = [];
  let ws = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    ev = [];
    ws = new WebSocket(`ws://127.0.0.1:${env.PORT}/ws`);
    ws.on('message', (m) => { try { ev.push(JSON.parse(String(m))); } catch { /* non-json */ } });
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    ws.send(JSON.stringify({
      type: 'start', projectId: PID, prompt: 'continue please',
      resumeSessionId: SID, resumeEncodedDir: containerDir, fork: true,
    }));
    // Resolve the moment the guard decides: Codex refusal (bug), fork ack (success),
    // staging status, or ANY fatal error (incl. the transient runtime gate). Close
    // the ws the instant it resolves so no real SDK turn does any work.
    await waitFor('the guard to resolve',
      () => ev.some((e) => codexRe(e) || forkAck(e) || stagingStatus(e) || (e.t === 'error' && e.fatal)), 20000);
    try { ws.close(); } catch { /* closed */ }
    await sleep(200);
    if (ev.some(transientGate) && !ev.some((e) => codexRe(e) || forkAck(e) || stagingStatus(e))) {
      await sleep(1000); // runtime check still warming up — retry
      continue;
    }
    break;
  }

  const refusal = ev.find(codexRe);
  check('B: the server does NOT refuse the mirrored Claude fork as "Orchard-owned (Codex)"',
    !refusal, refusal ? `refusal=${JSON.stringify(String(refusal.message).slice(0, 120))}`
      : `frames=${JSON.stringify(ev.map((e) => e.t + (e.of ? `/${e.of}` : '')))}`);
  const ack = ev.find(forkAck);
  const staged = ev.find(stagingStatus);
  check('B: the guard passed and the fork was PLANNED/STAGED container→direct (ack.fork or staging status)',
    (!!ack && ack.fork.sourceEncodedDir === containerDir) || !!staged,
    `ack.fork=${JSON.stringify(ack?.fork && { forked: ack.fork.forked, sourceEncodedDir: ack.fork.sourceEncodedDir, targetEncodedDir: ack.fork.targetEncodedDir })} staging=${JSON.stringify(staged?.status?.slice?.(0, 100) ?? null)}`);
}

// ------------------------------------------------------------------ PART C
async function partC(env) {
  console.log(`\n========== PART C — client: a refused fork KEEPS the typed message (app.js=${path.basename(APPJS)}) ==========`);
  const { PID, containerDir, SID } = await plantContainerSession(env, { name: 'sample-svc-c' });
  const TESTMSG = 'please fork this and keep my words';

  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const win = new Window({ url: `${env.BASE}/` });
  const doc = win.document;
  doc.write(html.replace(/<link[^>]*>/g, '').replace(/<script[^>]*><\/script>/g, ''));
  doc.close();

  const realFetch = globalThis.fetch;
  win.fetch = (input, init) => realFetch(input.startsWith('http') ? input : env.BASE + input, init);
  const openSockets = [];
  class TrackedWebSocket extends WebSocket {
    constructor(...a) { super(...a); openSockets.push(this); }
    send(data) {
      let obj = null;
      try { obj = JSON.parse(data); } catch { /* not json */ }
      // Do NOT forward the fork START — we synthesise the refusal locally so the
      // test is deterministic and never depends on a real CLI turn.
      if (obj && obj.type === 'start' && obj.fork === true) return;
      return super.send(data);
    }
  }
  win.WebSocket = TrackedWebSocket;
  win.location.host = `127.0.0.1:${env.PORT}`;

  const prev = { WebSocket: globalThis.WebSocket, fetch: globalThis.fetch, document: globalThis.document, window: globalThis.window, location: globalThis.location };
  globalThis.document = doc;
  globalThis.window = win;
  globalThis.WebSocket = win.WebSocket;
  globalThis.location = win.location;
  globalThis.fetch = win.fetch;

  try {
    await import(`${APPJS}?ui=${Date.now()}`);
    const q = (s) => doc.querySelector(s);
    const qa = (s) => [...doc.querySelectorAll(s)];
    const projName = (n) => n.querySelector('.nm')?.textContent?.trim() ?? '';

    const booted = await waitFor('project list', () => qa('#tree button.proj').length > 0);
    if (!booted) throw new Error('app.js never rendered any project row');
    const st = win.__station.state;
    const FORKFAIL = 'fork failed: staged copy is 0B but the source is 4096B — refusing to fork a truncated history';

    // Open the project (real click) so currentProject() is set and the main pane
    // exists — the surface a real fork send paints its optimistic bubble onto.
    const head = qa('#tree button.proj').find((n) => projName(n) === 'sample-svc-c');
    head?.click();
    await waitFor('the project to open', () => win.__station.currentProject()?.id === PID, 8000);
    check('C: the container→direct project is open in the app', win.__station.currentProject()?.id === PID,
      `currentProject=${win.__station.currentProject()?.id}`);

    // A refused-fork send is EXACTLY submit()'s forkFrom branch: startTurn with
    // fork:true + the server-supplied source dir (public/app.js:13398). Drive that
    // real path — it arms pendingStart with the typed text, paints the optimistic
    // bubble, and clears the composer. The fork START frame is dropped by
    // TrackedWebSocket so no real CLI turn runs; we then feed the REAL fatal
    // fork-refusal error frame the server emits, which is what used to eat the text.
    const bubblesBefore = qa('#panes .pane > .you').length;
    win.__station.startTurn(TESTMSG, { resumeSessionId: SID, fork: true, resumeEncodedDir: containerDir });
    await waitFor('pendingStart armed by the fork send', () => st.pendingStart != null, 8000);
    check('C: the fork send armed pendingStart with the typed message and cleared the composer',
      st.pendingStart === TESTMSG && q('#prompt').value === '',
      `pendingStart=${JSON.stringify(st.pendingStart)} composer=${JSON.stringify(q('#prompt').value)}`);
    const bubblesArmed = qa('#panes .pane > .you').length;
    check('C: the optimistic (phantom) bubble was painted by the fork send',
      bubblesArmed === bubblesBefore + 1, `bubbles ${bubblesBefore} -> ${bubblesArmed}`);

    // The REAL fatal fork-refusal frame the server emits (stage-truncated / Codex /
    // any planFork throw): {t:'error', message, fatal:true}, no needsFork.
    win.__station.onEvent({ t: 'error', message: FORKFAIL, fatal: true });
    await sleep(300);

    const composer = q('#prompt').value;
    const bubblesAfter = qa('#panes .pane > .you').length;
    check('C: FIX — the typed fork message is RECLAIMED into the composer, not lost',
      composer === TESTMSG, `composer=${JSON.stringify(composer)}`);
    check('C: FIX — the optimistic (phantom) bubble was removed (turn never began)',
      bubblesAfter === bubblesArmed - 1, `bubbles ${bubblesArmed} -> ${bubblesAfter}`);
    check('C: the fatal error is still surfaced (kept WITH a visible error, not silently)',
      st.sessError === FORKFAIL, `sessError=${JSON.stringify(st.sessError)}`);
  } finally {
    try {
      const st2 = win.__station?.state;
      if (st2?.liveTimer) { clearInterval(st2.liveTimer); st2.liveTimer = null; }
      if (st2?.drainWaitTimer) { clearInterval(st2.drainWaitTimer); st2.drainWaitTimer = null; }
    } catch { /* never booted */ }
    for (const s of openSockets) { try { s.removeAllListeners?.(); s.close(); } catch { /* closed */ } }
    await sleep(200);
    globalThis.WebSocket = prev.WebSocket; globalThis.fetch = prev.fetch;
    // Deliberately DO NOT restore globalThis.document/window/location to the outer
    // (node) undefined: app.js registers module-level poll timers (proc/usage/queue)
    // that dereference `document`, and this is the last part before the process
    // exits — leaving the happy-dom globals in place lets those stray ticks no-op
    // instead of throwing "getElementById of undefined" during teardown.
    void prev;
  }
}

async function main() {
  await partA();
  const env = await bootServer();
  try {
    await partB(env);
    await partC(env);
  } finally {
    for (const dir of [env.STORE, env.DATA, env.CONFIG]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(async () => {
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : (process.exitCode ?? 0);
  try { if (server?.pid) process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ }
  await sleep(300);
  setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
});
