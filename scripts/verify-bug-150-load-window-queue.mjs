/**
 * BUG-150 — a message queued in the window between "the session is on screen"
 * and "its transcript has finished loading" must be written to storage.
 *
 * The live loss: openSession() sets state.current, then AWAITS the transcript
 * fetch, and only re-took queue ownership (adoptQueue) AFTER it. Until that
 * point queueKey was null, so queueTargetKey() returned null and persistQueue()
 * wrote nothing — anything queued in that window lived only in the tab's heap,
 * exactly the non-durable state BUG-129 exists to end. A reload or tab-close in
 * that window destroyed the text silently.
 *
 * The fix declares ownership synchronously (adoptQueueRows) BEFORE the await, so
 * the window is closed by construction; only the outbox delivery-judgment (which
 * reads the painted transcript) stays deferred.
 *
 * This drives a REAL browser against a REAL server through the REAL openSession
 * / adoptQueueRows / persistQueue path. What is asserted, in the user's terms:
 *   1. Type a message DURING the load window (openSession is called and left
 *      pending on its transcript fetch) — the text is in durable storage the
 *      instant it is accepted, keyed to this session. This IS success
 *      criterion #1 ("queued at any point after a session is on screen is
 *      written to storage"), and storage surviving reload/close is the whole
 *      durability guarantee.
 *   2. Ownership was taken for THIS session (queueOwnerKey === draftKey), and it
 *      is still stored after openSession fully resolves.
 *   3. MUST-FAIL: the same actions against a SYNTHESIZED pre-fix client (the two
 *      openSession edits mechanically reverted, hit-count asserted) lose the
 *      text — nothing is stored, as it was live. The baseline is a constructed
 *      variant, never HEAD, so committing the fix cannot turn this into
 *      decoration (docs/CONVENTIONS.md).
 *
 * SYNTHETIC-SESSION NOTE (stated per docs/CONVENTIONS.md): the session row is
 * fabricated and the transcript endpoint is stubbed empty. That is faithful for
 * THIS bug: the load window (resetTranscript -> adoptQueueRows -> the awaited
 * fetch) runs identically whether or not the session file exists on disk — the
 * file only affects transcript CONTENT, which arrives AFTER the window closes.
 * A stubbed, DELAYED transcript is used precisely to hold the window open.
 *
 *   node scripts/verify-bug-150-load-window-queue.mjs
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const PORT = Number(process.env.VERIFY_BUG150_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-150-data-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-150-store-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-150-chrome-'));
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';

let pass = 0, fail = 0;
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : fail++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.on = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const c = new Cdp(ws);
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.id && c.waiting.has(m.id)) {
        const { res, rej } = c.waiting.get(m.id);
        c.waiting.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method && c.on.has(m.method)) {
        c.on.get(m.method)(m.params);
      }
    });
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.waiting.set(id, { res, rej }));
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  }
  async waitFor(label, expr, timeoutMs = 30_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (await this.eval(expr)) return true; } catch { /* nav */ }
      await sleep(120);
    }
    console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
    return false;
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

let server = null, browser = null;
const cleanupDirs = [DATA, STORE, PROFILE];
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

/*
 * The MUST-FAIL baseline. NOT `git show HEAD:public/app.js`: committing this fix
 * would make HEAD the FIXED state and the proof could never fail again
 * (docs/CONVENTIONS.md — "a must-FAIL proof must not be anchored to a moving
 * baseline"). Instead the pre-fix client is CONSTRUCTED from the current one by
 * neutering the single construction point the fix rests on: resetTranscript's
 * re-binding of queue ownership (`return adoptQueueRows()`). With that reverted,
 * queueKey is left null across the load window (the original BUG-150 loss) AND
 * across the failed-fetch catch path (the round-1 regression, scenario E) — one
 * neuter reproduces both. The hit count is asserted; if the transform ever stops
 * matching, this throws rather than quietly proving nothing.
 */
function preFixClient() {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const from = 'return adoptQueueRows();';
  const to = 'return null; /* PRE-FIX-150: resetTranscript does NOT re-bind queue ownership */';
  const hits = src.split(from).length - 1;
  if (hits !== 1) throw new Error(`pre-fix transform matched ${hits}x (expected 1) for: ${JSON.stringify(from)}`);
  return src.replace(from, to);
}

const encodeCwd = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

/**
 * Open the (synthetic) session WITHOUT awaiting, then queue a message in the
 * SAME synchronous tick. openSession runs its body up to its first await (the
 * transcript fetch) and returns the pending promise, so the queueMessage call
 * lands squarely in the load window — the exact instant the bug is about.
 * Returns the storage bytes read straight after acceptance.
 */
function windowQueueExpr(needle, projId, encDir) {
  return `(() => {
    const st = window.__station;
    const p = st.state.projects.find((x) => x.id === ${JSON.stringify(projId)});
    const sess = { encodedDir: ${JSON.stringify(encDir)}, sessionId: 'synthetic-' + Math.random().toString(36).slice(2), os: 'linux', displayTitle: 'BUG-150 fixture' };
    window.__bug150sess = sess;
    window.__bug150open = st.openSession(p, sess); // pending on the transcript fetch — we are now IN the window
    st.queueMessage(${JSON.stringify(needle)});     // queued DURING the load window
    return {
      stored: localStorage.getItem(st.QUEUE_KEY),
      ownerKey: st.queueOwnerKey(),
      draftKey: st.draftKey(st.state.current),
      queueLen: st.state.queue.length,
    };
  })()`;
}

async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-150-proj-'));
  cleanupDirs.push(projDir);
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: projDir, name: 'bug150-fixture' }),
  })).json();
  if (!reg.project?.id) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  const projId = reg.project.id;
  const encDir = encodeCwd(projDir);

  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

  // Serve app.js from a swappable holder, and hold every transcript fetch open
  // for a beat so the load window is unambiguously wide. `servePreFix` flips the
  // client the page boots with (post-fix vs the synthesized pre-fix baseline);
  // `failTranscript` makes the transcript fetch 500, driving openSession's catch
  // path (scenario E — the round-1 regression).
  let servePreFix = false;
  let failTranscript = false;
  const preFix = preFixClient();
  check('the pre-fix client was constructed by neutering resetTranscript re-binding (baseline is a variant, not HEAD)',
    preFix.includes('PRE-FIX-150') && !preFix.includes('return adoptQueueRows();'),
    `${preFix.length} bytes; the single re-bind point (return adoptQueueRows()) neutered`);
  await cdp.send('Fetch.enable', { patterns: [
    { urlPattern: '*/app.js*', requestStage: 'Request' },
    { urlPattern: '*/api/transcript/*', requestStage: 'Request' },
  ] });
  cdp.on.set('Fetch.requestPaused', (p) => {
    const u = p.request.url;
    if (/\/app\.js/.test(u) && servePreFix) {
      void cdp.send('Fetch.fulfillRequest', {
        requestId: p.requestId, responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'text/javascript' }, { name: 'cache-control', value: 'no-store' }],
        body: Buffer.from(preFix, 'utf8').toString('base64'),
      }).catch(() => {});
      return;
    }
    if (/\/api\/transcript\//.test(u)) {
      const fail = failTranscript;
      setTimeout(() => {
        if (fail) {
          void cdp.send('Fetch.fulfillRequest', {
            requestId: p.requestId, responseCode: 500,
            responseHeaders: [{ name: 'content-type', value: 'application/json' }],
            body: Buffer.from(JSON.stringify({ error: 'synthetic transcript failure' }), 'utf8').toString('base64'),
          }).catch(() => {});
          return;
        }
        void cdp.send('Fetch.fulfillRequest', {
          requestId: p.requestId, responseCode: 200,
          responseHeaders: [{ name: 'content-type', value: 'application/json' }],
          body: Buffer.from(JSON.stringify({ messages: [], total: 0, offset: 0, tookMs: 0 }), 'utf8').toString('base64'),
        }).catch(() => {});
      }, 1500); // hold the window open
      return;
    }
    void cdp.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
  });

  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.waitFor('boot', `window.__station !== undefined`);
  // The synthetic sess carries the real encodedDir so the write is keyed
  // exactly as a genuine open would key it.
  const expr = (needle) => windowQueueExpr(needle, projId, encDir);

  /* ═══ 1. POST-FIX: a message queued in the load window is stored at once ═══ */
  console.log('\n=== 1. post-fix: a message queued during the transcript load is durable ===');
  const N1 = 'Reply with exactly: WINDOW-XRAY';
  const r1 = await cdp.eval(expr(N1));
  check('the window message is accepted into the dock (state.queue holds it)',
    r1.queueLen >= 1, JSON.stringify({ queueLen: r1.queueLen }));
  check('ownership was taken SYNCHRONOUSLY for this session (queueOwnerKey === draftKey, not null)',
    r1.ownerKey && r1.ownerKey === r1.draftKey, JSON.stringify({ ownerKey: r1.ownerKey, draftKey: r1.draftKey }));
  check('SUCCESS CRITERION #1: queued during the load window, the text is already in durable storage',
    typeof r1.stored === 'string' && r1.stored.includes('WINDOW-XRAY'),
    (r1.stored ?? '(nothing stored)').slice(0, 200));

  // Let openSession fully resolve; the text must still be stored afterwards
  // (nothing about closing the load window retroactively drops it).
  await cdp.eval(`window.__bug150open.catch(() => {})`);
  await sleep(200);
  const stillStored = await cdp.eval(`localStorage.getItem(window.__station.QUEUE_KEY)`);
  check('after openSession resolves, the window message is STILL stored (durable across the whole open)',
    typeof stillStored === 'string' && stillStored.includes('WINDOW-XRAY'),
    (stillStored ?? '(nothing stored)').slice(0, 200));

  /* ═══ 1b. POST-FIX scenario E: the transcript fetch FAILS — ownership held ═══ */
  console.log('\n=== 1b. post-fix: a failed transcript fetch must NOT drop queue ownership (scenario E) ===');
  await cdp.eval(`localStorage.removeItem(window.__station.QUEUE_KEY)`);
  failTranscript = true;
  const N1b = 'Reply with exactly: WINDOW-ECHO';
  const r1b = await cdp.eval(expr(N1b));
  check('E: the window message is stored even though the transcript fetch will fail',
    typeof r1b.stored === 'string' && r1b.stored.includes('WINDOW-ECHO'),
    (r1b.stored ?? '(nothing stored)').slice(0, 160));
  // Let the fetch reject and openSession's catch branch run.
  await cdp.eval(`window.__bug150open.catch(() => {})`);
  await cdp.waitFor('catch branch ran (error hint painted)',
    `[...document.querySelectorAll('#panes .hint-row')].some((n) => /could not read this session/.test(n.textContent))`, 8000);
  const afterFail = await cdp.eval(`({
    ownerKey: window.__station.queueOwnerKey(),
    draftKey: window.__station.draftKey(window.__station.state.current),
    stored: localStorage.getItem(window.__station.QUEUE_KEY),
    dockHas: [...document.querySelectorAll('#queueBox .qedit')].some((t) => t.value.includes('WINDOW-ECHO')),
  })`);
  check('E: after the failed fetch, ownership is STILL held for this session (queueOwnerKey === draftKey, not null)',
    afterFail.ownerKey && afterFail.ownerKey === afterFail.draftKey,
    JSON.stringify({ ownerKey: afterFail.ownerKey, draftKey: afterFail.draftKey }));
  check('E: the window message is still visible in the dock after the failure (not wiped from state.queue)',
    afterFail.dockHas === true, JSON.stringify({ dockHas: afterFail.dockHas }));
  // DECISIVE: a message typed AFTER the failed fetch must be durable — the exact
  // silent-loss the round-1 regression reintroduced.
  const N1c = 'Reply with exactly: WINDOW-FOXTROT';
  const afterTyped = await cdp.eval(`(() => {
    window.__station.queueMessage(${JSON.stringify(N1c)});
    return localStorage.getItem(window.__station.QUEUE_KEY);
  })()`);
  check('E (SUCCESS CRITERION #1 on the failure path): a message typed AFTER the failed fetch is durably stored',
    typeof afterTyped === 'string' && afterTyped.includes('WINDOW-FOXTROT'),
    (afterTyped ?? '(nothing stored)').slice(0, 200));
  failTranscript = false;

  /* ═══ 2. MUST-FAIL: the same actions against the synthesized pre-fix client ═══ */
  console.log('\n=== 2. must-FAIL: the same window-queue against the PRE-FIX client loses it ===');
  await cdp.eval(`localStorage.removeItem(window.__station.QUEUE_KEY)`);
  servePreFix = true;
  await cdp.send('Page.reload', { ignoreCache: true });
  await cdp.waitFor('pre-fix boot',
    `window.__station !== undefined && window.__station.resetTranscript.toString().includes('PRE-FIX-150')`, 30_000);
  const isPreFix = await cdp.eval(`window.__station.resetTranscript.toString().includes('PRE-FIX-150')`);
  check('pre-fix client is actually the one booted (resetTranscript carries the neutered marker)',
    isPreFix === true, JSON.stringify({ isPreFix }));
  const N2 = 'Reply with exactly: WINDOW-YANKEE';
  const r2 = await cdp.eval(expr(N2));
  check('pre-fix: the message IS accepted into the dock, exactly as the user saw it live',
    r2.queueLen >= 1, JSON.stringify({ queueLen: r2.queueLen }));
  check('pre-fix: ownership was NOT taken during the window (queueOwnerKey is null — the defect)',
    !r2.ownerKey, JSON.stringify({ ownerKey: r2.ownerKey }));
  check('MUST-FAIL PROVED: pre-fix, nothing is written — the text exists only in the tab heap',
    !String(r2.stored ?? '').includes('WINDOW-YANKEE'), (r2.stored ?? '(nothing stored)').slice(0, 160));
  // …and it is still not stored once the pre-fix open resolves (adoptQueue after
  // the await does not persist a row queued during the window).
  await cdp.eval(`window.__bug150open.catch(() => {})`);
  await sleep(200);
  const preAfter = await cdp.eval(`localStorage.getItem(window.__station.QUEUE_KEY)`);
  check('pre-fix: still nothing stored after the open resolves — a reload here destroys the message',
    !String(preAfter ?? '').includes('WINDOW-YANKEE'), (preAfter ?? '(nothing stored)').slice(0, 160));

  /* ═══ 2b. MUST-FAIL scenario E against the pre-fix client (catch path) ═══ */
  console.log('\n=== 2b. must-FAIL scenario E: pre-fix, a failed fetch drops ownership + loses the next msg ===');
  await cdp.eval(`localStorage.removeItem(window.__station.QUEUE_KEY)`);
  failTranscript = true;
  await cdp.eval(expr('Reply with exactly: WINDOW-GOLF'));
  await cdp.eval(`window.__bug150open.catch(() => {})`);
  await cdp.waitFor('pre-fix catch ran',
    `[...document.querySelectorAll('#panes .hint-row')].some((n) => /could not read this session/.test(n.textContent))`, 8000);
  const preE = await cdp.eval(`(() => {
    window.__station.queueMessage('Reply with exactly: WINDOW-HOTEL'); // typed AFTER the failed fetch
    return { ownerKey: window.__station.queueOwnerKey(), stored: localStorage.getItem(window.__station.QUEUE_KEY) };
  })()`);
  check('MUST-FAIL PROVED (E): pre-fix, ownership is null after the failed fetch (the regression)',
    !preE.ownerKey, JSON.stringify({ ownerKey: preE.ownerKey }));
  check('MUST-FAIL PROVED (E): pre-fix, a message typed after the failed fetch is written nowhere',
    !String(preE.stored ?? '').includes('WINDOW-HOTEL'), (preE.stored ?? '(nothing stored)').slice(0, 160));
  failTranscript = false;

  await cdp.send('Fetch.disable');
  cdp.on.delete('Fetch.requestPaused');
  cdp.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exitCode = 1;
}).finally(() => {
  stopByPid(browser);
  stopByPid(server);
  setTimeout(() => {
    for (const d of cleanupDirs) fs.rmSync(d, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  }, 2500);
});
