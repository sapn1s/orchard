/**
 * BUG-090 — resuming a session recorded before a project's isolation changed
 * (classically: before the container was enabled, when the cwd — and thus the
 * encoded-cwd store dir — was different) must NOT dead-end with a raw
 * "fork:true / resumeEncodedDir" prose error. It must surface a STRUCTURED
 * needs-fork signal the client turns into a one-click, context-aware Fork.
 *
 *   node scripts/verify-bug-090-needs-fork.mjs
 *
 * PART A — SERVER (fork.ts, direct unit over a scratch CLAUDE store; no docker,
 *   no model). A session planted under a DIFFERENT encoded dir than the project
 *   now resolves to →
 *     - explainUnresumable returns a STRUCTURED reason with .fork.resumeEncodedDir
 *       (the exact dir planFork will stage from) + .fork.cause. MUST-FAIL pre-fix:
 *       explainUnresumable returned a bare string, so `.fork` is undefined.
 *     - planFork(project, id, that resumeEncodedDir) stages a self-contained copy
 *       into the target dir; the ORIGINAL bytes are untouched.
 *
 * PART B — UI (real scratch server + happy-dom driving the REAL public/app.js).
 *   A session listed under the container store dir, project now resolving to a
 *   different dir → a plain resume yields the needs-fork signal → the one-click
 *   Fork bar appears with the container-appropriate copy and a context-aware
 *   #forkBtn label; clicking it and sending emits fork:true + the server-supplied
 *   resumeEncodedDir. MUST-FAIL pre-fix: the server emitted a plain fatal error
 *   (no needsFork), so no fork bar ever appears.
 *
 * Leak hygiene: every path/name here is synthetic (/orchard-scratch/<proj>,
 * scratch tmp dirs). No real project, home, username, or session id.
 */
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Window } from 'happy-dom';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');

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
  console.log('\n========== PART A — server: structured needs-fork + fork stages, original untouched ==========');
  const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug090a-store-'));
  process.env.CLAUDE_PROJECTS_DIR = STORE;
  // Fresh import so storeRoot()/defaultRoot() sees the scratch store.
  const fork = await import(`${path.join(ROOT, 'src', 'server', 'fork.ts')}?a=${Date.now()}`);
  const cm = await import(`${path.join(ROOT, 'src', 'server', 'container-manager.ts')}?a=${Date.now()}`);
  const reg = await import(`${path.join(ROOT, 'src', 'server', 'registry.ts')}?a=${Date.now()}`);

  const mkProject = (id, hostPath, isolation) => ({
    id, name: id, hostPath, isolation,
    settings: reg.defaultSettings(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });

  try {
    // --- Scenario 1: enabled the container (the reported case).
    // Session recorded pre-container under the host-path encoding; project now
    // isolation=container so the CLI looks under -workspace-<id>.
    const idA = 'p090a';
    const hostA = '/orchard-scratch/proj-a';
    const projA = mkProject(idA, hostA, 'container');
    const hostEnc = cm.encodeCwdForStore(hostA);
    const containerEnc = cm.encodeCwdForStore(cm.containerWorkdir(idA));
    const sidA = 'aaaaaaaa-0000-4000-c000-000000000001';
    const srcFileA = writeSession(path.join(STORE, hostEnc), sidA, 'pre-container work');
    const origBytesA = fs.readFileSync(srcFileA);

    const whyA = fork.explainUnresumable(projA, sidA);
    check('A1: explainUnresumable returns a STRUCTURED object (not a bare string)',
      whyA !== null && typeof whyA === 'object' && typeof whyA.message === 'string',
      `typeof=${typeof whyA} keys=${whyA && Object.keys(whyA)}`);
    check('A1: it carries a machine-readable fork.resumeEncodedDir = the SOURCE dir',
      !!whyA?.fork && whyA.fork.resumeEncodedDir === hostEnc,
      `fork=${JSON.stringify(whyA?.fork)} expected resumeEncodedDir=${hostEnc}`);
    check('A1: cause is "isolation-changed" for the container case',
      whyA?.fork?.cause === 'isolation-changed', `cause=${whyA?.fork?.cause}`);
    check('A1: the readable fallback message is still present',
      typeof whyA?.message === 'string' && whyA.message.length > 0, `message=${JSON.stringify(whyA?.message?.slice(0, 80))}`);

    // Fork with the signalled dir: stages into the container dir, original intact.
    // Guarded so a pre-fix run (no structured .fork) still reaches Part B.
    const planA = whyA?.fork ? fork.planFork(projA, sidA, whyA.fork.resumeEncodedDir) : { stagedFile: null };
    check('A1: planFork staged a copy under the target (container) store dir',
      !!planA.stagedFile && planA.stagedFile.includes(containerEnc) && fs.existsSync(planA.stagedFile),
      `stagedFile=${planA.stagedFile}`);
    check('A1: the staged copy is byte-identical to the source (self-contained history)',
      !!planA.stagedFile && fs.readFileSync(planA.stagedFile).equals(origBytesA),
      planA.stagedFile ? `staged=${fs.statSync(planA.stagedFile).size}B src=${origBytesA.length}B` : 'no stagedFile (pre-fix)');
    check('A1: the ORIGINAL session file is untouched (byte-for-byte)',
      fs.existsSync(srcFileA) && fs.readFileSync(srcFileA).equals(origBytesA), `original still ${fs.existsSync(srcFileA) ? 'present' : 'GONE'}`);

    // --- Scenario 2: cross-OS (Windows-origin dir), no container involved.
    const idB = 'p090b';
    const hostB = '/orchard-scratch/proj-b';
    const projB = mkProject(idB, hostB, 'direct');
    const winEnc = 'C--Users-dev-GitHub-proj-b';
    const sidB = 'bbbbbbbb-0000-4000-c000-000000000002';
    writeSession(path.join(STORE, winEnc), sidB, 'recorded on windows');

    const whyB = fork.explainUnresumable(projB, sidB);
    check('A2: cross-OS session yields a structured fork with cause "cross-os"',
      !!whyB?.fork && whyB.fork.resumeEncodedDir === winEnc && whyB.fork.cause === 'cross-os',
      `fork=${JSON.stringify(whyB?.fork)}`);

    // --- Scenario 3: session truly absent → no fork option (nothing to branch).
    const whyC = fork.explainUnresumable(projB, 'cccccccc-0000-4000-c000-000000000003');
    check('A3: a session that exists nowhere yields a message with NO fork option',
      !!whyC && typeof whyC.message === 'string' && whyC.fork === undefined,
      `why=${JSON.stringify(whyC)}`);

    // --- Anti-regression: an id already under the target dir resumes fine (null).
    const idD = 'p090d';
    const hostD = '/orchard-scratch/proj-d';
    const projD = mkProject(idD, hostD, 'direct');
    const sidD = 'dddddddd-0000-4000-c000-000000000004';
    writeSession(path.join(STORE, cm.encodeCwdForStore(hostD)), sidD, 'already here');
    check('A4 (anti-regression): a resolvable id returns null (no needs-fork)',
      fork.explainUnresumable(projD, sidD) === null, `why=${JSON.stringify(fork.explainUnresumable(projD, sidD))}`);
  } finally {
    delete process.env.CLAUDE_PROJECTS_DIR;
    try { fs.rmSync(STORE, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ------------------------------------------------------------------ PART B
let server = null;
async function partB() {
  console.log('\n========== PART B — UI: one-click container Fork appears and sends fork:true + resumeEncodedDir ==========');
  const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug090b-store-'));
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug090b-data-'));
  const PROJDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug090b-proj-'));
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const TESTMSG = 'BUG-090 fork this into the container please';

  server = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE },
    stdio: ['ignore', 'ignore', 'pipe'], detached: true,
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(200); } }
  if (!up) throw new Error('server never became healthy');

  // Register a scratch project (direct). Plant its one session under the
  // CONTAINER store dir — i.e. recorded while the container was on — so the
  // project (now resolving to its host dir) can't plain-resume it and the
  // server's cause detection reports 'isolation-changed'.
  const regRes = await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: PROJDIR, name: 'proj-b090' }),
  });
  if (!regRes.ok) throw new Error(`register failed: ${await regRes.text()}`);
  const PID = (await regRes.json()).project.id;
  const enc = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
  const containerDir = enc(`/workspace/${PID}`);
  const SID = 'eeeeeeee-0000-4000-c000-000000000005';
  writeSession(path.join(STORE, containerDir), SID, 'recorded inside the container');

  const listed = await (await fetch(`${BASE}/api/projects/${PID}/sessions`)).json();
  const sessions = listed.sessions ?? [];
  check('B: the container-dir session is listed for the project',
    sessions.some((s) => s.sessionId === SID), `sessions=${sessions.map((s) => `${s.sessionId.slice(0, 8)}@${s.encodedDir}`).join(',')}`);
  if (!sessions.some((s) => s.sessionId === SID)) throw new Error('planted session not listed');

  // ---- boot the REAL app.js in happy-dom against the REAL server
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const win = new Window({ url: `${BASE}/` });
  const doc = win.document;
  doc.write(html.replace(/<link[^>]*>/g, '').replace(/<script[^>]*><\/script>/g, ''));
  doc.close();

  const g = win;
  const realFetch = globalThis.fetch;
  g.fetch = (input, init) => realFetch(input.startsWith('http') ? input : BASE + input, init);
  const sentFrames = [];
  const openSockets = [];
  class TrackedWebSocket extends WebSocket {
    constructor(...a) { super(...a); openSockets.push(this); }
    send(data) {
      let obj = null;
      try { obj = JSON.parse(data); } catch { /* not json */ }
      if (obj) sentFrames.push(obj);
      // Do NOT forward a fork START to the server — the assertion is the client's
      // outgoing intent; forwarding would stage a copy and spawn a real CLI turn.
      if (obj && obj.type === 'start' && obj.fork === true) return;
      return super.send(data);
    }
  }
  g.WebSocket = TrackedWebSocket;
  win.location.host = `127.0.0.1:${PORT}`;

  const prev = { WebSocket: globalThis.WebSocket, fetch: globalThis.fetch };
  globalThis.document = doc;
  globalThis.window = win;
  globalThis.WebSocket = g.WebSocket;
  globalThis.location = win.location;
  globalThis.fetch = g.fetch;

  try {
    await import(`${path.join(ROOT, 'public', 'app.js')}?ui=${Date.now()}`);
    const q = (s) => doc.querySelector(s);
    const qa = (s) => [...doc.querySelectorAll(s)];
    const projName = (n) => n.querySelector('.nm')?.textContent?.trim() ?? '';

    const booted = await waitFor('project list', () => qa('#tree button.proj').length > 0);
    if (!booted) throw new Error('app.js never rendered any project row');

    const ownRows = () => {
      const head = qa('#tree button.proj').find((n) => projName(n) === 'proj-b090');
      return [...(head?.nextElementSibling?.querySelectorAll('button.row') ?? [])];
    };
    await waitFor("project's sessions", () => ownRows().length > 0);
    ownRows()[0].click();
    await waitFor('transcript', () => qa('#panes .pane .you, #panes .pane .claude').length > 0, 30000);

    // Resume via a plain send → the server refuses with the needs-fork signal.
    const prompt = q('#prompt');
    const go = q('#go');
    prompt.value = TESTMSG;
    go.click();

    const frozen = q('#frozen');
    const shown = await waitFor('the one-click Fork bar', () => frozen && frozen.hidden === false, 8000);
    const st = win.__station?.state;
    check('B: the needs-fork signal surfaced the one-click Fork bar (not a dead-end fatal error)',
      shown, `#frozen.hidden=${frozen?.hidden} sessError=${JSON.stringify(st?.sessError)}`);
    check('B: state carries the structured pendingFork (resumeEncodedDir + cause)',
      st?.pendingFork?.resumeEncodedDir === containerDir && st?.pendingFork?.cause === 'isolation-changed',
      `pendingFork=${JSON.stringify(st?.pendingFork)}`);
    const barText = frozen?.textContent ?? '';
    check('B: the bar uses plain, container-appropriate copy (not "fork:true / resumeEncodedDir")',
      /before you enabled the container/i.test(barText) && !/resumeEncodedDir/i.test(barText),
      `barText=${JSON.stringify(barText.trim().slice(0, 140))}`);
    check('B: the #forkBtn label is context-aware for the container case',
      /Fork into the container/i.test(q('#forkBtn')?.textContent ?? ''), `label=${JSON.stringify(q('#forkBtn')?.textContent)}`);

    // One click → arm the fork; then send.
    q('#forkBtn').click();
    check('B: clicking Fork arms forkFrom + the server-supplied source dir (one-click, not silent auto-fork)',
      st?.forkFrom === SID && st?.forkEncodedDir === containerDir,
      `forkFrom=${st?.forkFrom} forkEncodedDir=${st?.forkEncodedDir}`);
    const p2 = q('#prompt');
    if (!p2.value) { p2.value = TESTMSG; }
    q('#go').click();

    const sentFork = await waitFor('the fork start frame', () => sentFrames.some((f) => f.type === 'start' && f.fork === true), 8000);
    const forkFrame = sentFrames.find((f) => f.type === 'start' && f.fork === true);
    check('B: sending emits fork:true with the server-supplied resumeEncodedDir + resumeSessionId',
      sentFork && forkFrame?.resumeEncodedDir === containerDir && forkFrame?.resumeSessionId === SID,
      `frame=${JSON.stringify(forkFrame && { fork: forkFrame.fork, resumeEncodedDir: forkFrame.resumeEncodedDir, resumeSessionId: forkFrame.resumeSessionId })}`);
  } finally {
    try {
      const st2 = win.__station?.state;
      if (st2?.liveTimer) { clearInterval(st2.liveTimer); st2.liveTimer = null; }
      if (st2?.drainWaitTimer) { clearInterval(st2.drainWaitTimer); st2.drainWaitTimer = null; }
    } catch { /* app never booted that far */ }
    for (const s of openSockets) { try { s.removeAllListeners?.(); s.close(); } catch { /* closed */ } }
    await sleep(300);
    globalThis.WebSocket = prev.WebSocket; globalThis.fetch = prev.fetch;
    try { fs.rmSync(STORE, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(PROJDIR, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function main() {
  await partA();
  await partB();
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
