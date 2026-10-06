/**
 * BUG-090 follow-up — the needs-fork bar's copy is direction-correct BOTH ways.
 *
 * The classic isolation-changed case is direct→container: a session recorded
 * before the container was enabled, resumed against a now-container project. Its
 * mirror also happens — a session that RAN in a container, resumed against a
 * project that now runs direct on the host (a real reported case). Both surface
 * the same cause 'isolation-changed', but the bar copy
 * was hard-coded for one direction ("Fork it into the container"), so the
 * container→direct user was told to fork the exact wrong way.
 *
 *   node scripts/verify-bug-forkbar-direction.mjs
 *
 * PART A — SERVER (fork.ts, direct unit over a scratch CLAUDE store). Asserts the
 *   fork payload carries `toContainer` naming the direction (true=direct→container,
 *   false=container→direct) AND that planFork actually stages the container→direct
 *   fork into the host store dir, byte-identical, original untouched (hypothesis:
 *   the flow is not broken, only the copy). MUST-FAIL pre-fix: no toContainer field.
 *
 * PART B — UI (real scratch server + happy-dom driving the REAL public/app.js).
 *   Boots the real app.js, selects a session, then feeds the REAL needs-fork event
 *   shape (the one PART A proves the server emits) through the real `onEvent` for
 *   BOTH directions and asserts the rendered #frozen bar text + #forkBtn label the
 *   user sees. container→direct (toContainer:false) must NOT say "into the
 *   container"; direct→container (toContainer:true) must keep the classic copy.
 *   (The end-to-end SDK resume round-trip is deliberately NOT used — that harness
 *   has bit-rotted independently, see the existing verify-bug-090-needs-fork.mjs
 *   PART B which fails the same way on HEAD; onEvent is the same render entry it
 *   dispatches to and exercises the exact code changed here.)
 *   MUST-FAIL pre-fix: run with BUG_FORKBAR_APPJS pointing at a pre-fix app.js
 *   snapshot and the container-direction assertions fail (bar reads "into the
 *   container"). This run's observed pre-fix output is recorded in the ticket.
 *
 * The app.js loaded is overridable via BUG_FORKBAR_APPJS so the pre-fix snapshot
 * can be graded by the very same assertions. Leak hygiene: every path/name here
 * is synthetic (/orchard-scratch/<proj>, scratch tmp dirs).
 */
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Window } from 'happy-dom';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const APPJS = process.env.BUG_FORKBAR_APPJS || path.join(ROOT, 'public', 'app.js');

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
  console.log('\n========== PART A — server: fork payload names the direction; container→direct fork stages ==========');
  const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-fbdir-a-store-'));
  process.env.CLAUDE_PROJECTS_DIR = STORE;
  const fork = await import(`${path.join(ROOT, 'src', 'server', 'fork.ts')}?a=${Date.now()}`);
  const cm = await import(`${path.join(ROOT, 'src', 'server', 'container-manager.ts')}?a=${Date.now()}`);
  const reg = await import(`${path.join(ROOT, 'src', 'server', 'registry.ts')}?a=${Date.now()}`);

  const mkProject = (id, hostPath, isolation) => ({
    id, name: id, hostPath, isolation,
    settings: reg.defaultSettings(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });

  try {
    // --- Direction 1: direct→container (classic). Session recorded on host,
    // project now isolation=container.
    const id1 = 'fbd1';
    const host1 = '/orchard-scratch/proj-fbd1';
    const proj1 = mkProject(id1, host1, 'container');
    const hostEnc1 = cm.encodeCwdForStore(host1);
    const sid1 = 'aaaaaaaa-0000-4000-c000-000000000001';
    writeSession(path.join(STORE, hostEnc1), sid1, 'pre-container work');
    const why1 = fork.explainUnresumable(proj1, sid1);
    check('A1 (direct→container): cause is isolation-changed, toContainer === true',
      why1?.fork?.cause === 'isolation-changed' && why1.fork.toContainer === true,
      `fork=${JSON.stringify(why1?.fork)}`);

    // --- Direction 2: container→direct (the reported case). Session recorded in
    // the container store dir, project now isolation=direct.
    const id2 = 'fbd2';
    const host2 = '/orchard-scratch/proj-fbd2';
    const proj2 = mkProject(id2, host2, 'direct');
    const containerEnc2 = cm.containerStoreDirName({ id: id2 });
    const hostEnc2 = cm.encodeCwdForStore(host2);
    const sid2 = 'bbbbbbbb-0000-4000-c000-000000000002';
    const src2 = writeSession(path.join(STORE, containerEnc2), sid2, 'ran inside the container');
    const orig2 = fs.readFileSync(src2);
    const why2 = fork.explainUnresumable(proj2, sid2);
    check('A2 (container→direct): cause is isolation-changed, toContainer === false',
      why2?.fork?.cause === 'isolation-changed' && why2.fork.toContainer === false,
      `fork=${JSON.stringify(why2?.fork)}`);
    check('A2: the fork source dir is the container store dir it was recorded under',
      why2?.fork?.resumeEncodedDir === containerEnc2,
      `resumeEncodedDir=${why2?.fork?.resumeEncodedDir} expected=${containerEnc2}`);

    // HYPOTHESIS CHECK — the container→direct fork actually works (stages into the
    // host store dir, byte-identical, original untouched). If this failed we would
    // STOP and report a broken flow instead of rewording copy.
    const plan2 = why2?.fork ? fork.planFork(proj2, sid2, why2.fork.resumeEncodedDir) : { stagedFile: null, targetEncodedDir: null };
    check('A2: planFork stages the container→direct fork into the HOST store dir',
      !!plan2.stagedFile && plan2.targetEncodedDir === hostEnc2 && plan2.stagedFile.includes(hostEnc2) && fs.existsSync(plan2.stagedFile),
      `stagedFile=${plan2.stagedFile} targetEncodedDir=${plan2.targetEncodedDir} hostEnc=${hostEnc2}`);
    check('A2: the staged copy is byte-identical (self-contained history)',
      !!plan2.stagedFile && fs.readFileSync(plan2.stagedFile).equals(orig2),
      plan2.stagedFile ? `staged=${fs.statSync(plan2.stagedFile).size}B src=${orig2.length}B` : 'no stagedFile');
    check('A2: the ORIGINAL container-dir session file is untouched',
      fs.existsSync(src2) && fs.readFileSync(src2).equals(orig2), `original ${fs.existsSync(src2) ? 'present' : 'GONE'}`);

    // --- Anti-regression: cross-os / path-changed carry NO toContainer field.
    const id3 = 'fbd3';
    const host3 = '/orchard-scratch/proj-fbd3';
    const proj3 = mkProject(id3, host3, 'direct');
    const winEnc = 'C--Users-dev-GitHub-proj-fbd3';
    const sid3 = 'cccccccc-0000-4000-c000-000000000003';
    writeSession(path.join(STORE, winEnc), sid3, 'recorded on windows');
    const why3 = fork.explainUnresumable(proj3, sid3);
    check('A3 (anti-regression): cross-os fork has cause cross-os and NO toContainer',
      why3?.fork?.cause === 'cross-os' && !('toContainer' in (why3?.fork ?? {})),
      `fork=${JSON.stringify(why3?.fork)}`);
  } finally {
    delete process.env.CLAUDE_PROJECTS_DIR;
    try { fs.rmSync(STORE, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ------------------------------------------------------------------ PART B
let server = null;
async function partB() {
  console.log(`\n========== PART B — UI: container→direct fork bar copy is direction-correct (app.js=${path.relative(ROOT, APPJS)}) ==========`);
  const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-fbdir-b-store-'));
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-fbdir-b-data-'));
  const PROJDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-fbdir-b-proj-'));
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const TESTMSG = 'BUG forkbar continue this session here please';

  server = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE },
    stdio: ['ignore', 'ignore', 'pipe'], detached: true,
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(200); } }
  if (!up) throw new Error('server never became healthy');

  // Register a DIRECT project; plant its one session under the CONTAINER store
  // dir — recorded while the container was on. The project (now direct) can't
  // plain-resume it → the server reports isolation-changed with toContainer=false.
  const regRes = await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: PROJDIR, name: 'proj-fbdir' }),
  });
  if (!regRes.ok) throw new Error(`register failed: ${await regRes.text()}`);
  const PID = (await regRes.json()).project.id;
  const enc = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
  const containerDir = enc(`/workspace/${PID}`);
  const SID = 'eeeeeeee-0000-4000-c000-000000000005';
  writeSession(path.join(STORE, containerDir), SID, 'recorded inside the container');

  const listed = await (await fetch(`${BASE}/api/projects/${PID}/sessions`)).json();
  const sessions = listed.sessions ?? [];
  if (!sessions.some((s) => s.sessionId === SID)) throw new Error('planted session not listed');

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
      if (obj && obj.type === 'start' && obj.fork === true) return; // never forward a real fork start
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
    await import(`${APPJS}?ui=${Date.now()}`);
    const q = (s) => doc.querySelector(s);
    const qa = (s) => [...doc.querySelectorAll(s)];
    const projName = (n) => n.querySelector('.nm')?.textContent?.trim() ?? '';

    const booted = await waitFor('project list', () => qa('#tree button.proj').length > 0);
    if (!booted) throw new Error('app.js never rendered any project row');

    const ownRows = () => {
      const head = qa('#tree button.proj').find((n) => projName(n) === 'proj-fbdir');
      return [...(head?.nextElementSibling?.querySelectorAll('button.row') ?? [])];
    };
    await waitFor("project's sessions", () => ownRows().length > 0);
    ownRows()[0].click();
    await waitFor('transcript', () => qa('#panes .pane .you, #panes .pane .claude').length > 0, 30000);

    const st = win.__station?.state;
    const onEvent = win.__station?.onEvent;
    if (typeof onEvent !== 'function') throw new Error('app.js did not expose onEvent');

    const armAndRead = (toContainer) => {
      // The REAL needs-fork error frame the server emits (shape proven in PART A),
      // dispatched through the REAL client event handler → armNeedsFork → the bar.
      onEvent({
        t: 'error', fatal: true,
        message: `cannot resume ${SID}: recorded under ${containerDir}`,
        needsFork: { resumeSessionId: SID, resumeEncodedDir: containerDir, cause: 'isolation-changed', toContainer },
      });
      return {
        pendingFork: st?.pendingFork,
        bar: (q('#frozen')?.textContent ?? '').trim(),
        btn: (q('#forkBtn')?.textContent ?? '').trim(),
        fine: (q('#fine')?.textContent ?? '').trim(),
      };
    };

    // ---- Direction: container→direct (the reported bug) ----
    const c2d = armAndRead(false);
    check('B (container→direct): pendingFork carries toContainer=false',
      c2d.pendingFork?.cause === 'isolation-changed' && c2d.pendingFork?.toContainer === false,
      `pendingFork=${JSON.stringify(c2d.pendingFork)}`);
    check('B (container→direct): the bar does NOT say "into the container" (the wrong direction)',
      !/into the container/i.test(c2d.bar), `barText=${JSON.stringify(c2d.bar.slice(0, 180))}`);
    check('B (container→direct): the bar names the real direction ("runs directly on the host" + "continue here")',
      /runs directly on the host/i.test(c2d.bar) && /continue here/i.test(c2d.bar),
      `barText=${JSON.stringify(c2d.bar.slice(0, 180))}`);
    check('B (container→direct): the #forkBtn label is "Fork to continue here" (not "into the container")',
      /Fork to continue here/i.test(c2d.btn) && !/into the container/i.test(c2d.btn), `label=${JSON.stringify(c2d.btn)}`);
    check('B (container→direct): the arming status line does not say "into the container"',
      !/into the container/i.test(c2d.fine) && (c2d.fine === '' || /continue here|runs directly on the host/i.test(c2d.fine)),
      `fineText=${JSON.stringify(c2d.fine.slice(0, 180))}`);

    // ---- clicking Fork arms the branch client-side (flow intact) ----
    q('#forkBtn').click();
    check('B (container→direct): clicking Fork arms forkFrom + the container source dir',
      st?.forkFrom === SID && st?.forkEncodedDir === containerDir,
      `forkFrom=${st?.forkFrom} forkEncodedDir=${st?.forkEncodedDir}`);

    // Reset the armed fork so the next direction re-arms cleanly.
    st.forkFrom = null; st.forkEncodedDir = null; st.pendingFork = null;

    // ---- Anti-regression: direct→container keeps the classic copy ----
    const d2c = armAndRead(true);
    check('B (direct→container, anti-regression): pendingFork carries toContainer=true',
      d2c.pendingFork?.toContainer === true, `pendingFork=${JSON.stringify(d2c.pendingFork)}`);
    check('B (direct→container, anti-regression): the bar says "into the container" (classic copy preserved)',
      /into the container/i.test(d2c.bar) && !/runs directly on the host/i.test(d2c.bar),
      `barText=${JSON.stringify(d2c.bar.slice(0, 180))}`);
    check('B (direct→container, anti-regression): the #forkBtn label is "Fork into the container"',
      /Fork into the container/i.test(d2c.btn), `label=${JSON.stringify(d2c.btn)}`);
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
