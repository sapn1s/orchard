/**
 * URL-state / routing verification — the acceptance criteria of TODO item 0.5,
 * driven in a REAL Chromium (brave --headless=new over raw CDP; happy-dom has
 * no layout, so scroll geometry — half the feature — would be unverifiable
 * there). Real server, real session store under ~/.claude.
 *
 *   node scripts/verify-routing.mjs
 *
 * Checks:
 *   1. opening a session writes #/project/<id>/session/<sid>?dir=…
 *   2. scrolling away writes &i=<top visible message index> (debounced)
 *   3. hard reload → same session, same place (index at viewport top)
 *   4. the URL in a NEW tab → same view
 *   5. browser Back returns to the previously open session
 *   6. a bogus session id fails honestly: message shown, NO new session
 *   7. a deep i restores a window around it: history bar shown, composer
 *      hidden, live-follow off; "Jump to latest" restores the normal tail
 *
 * Ports are parameterised (VERIFY_ROUTING_PORT), never 4318 (a UI test stub
 * squats there) and never the live 4317.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

/* Never a fixed port: two suites defaulting to the same number collide the
   moment both run (observed: verify-ui + verify-sessions on 4319). The OS
   hands out a free one; the env var still pins it when a run needs to. */
async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const PORT = Number(process.env.VERIFY_ROUTING_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-route-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-route-chrome-'));
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';

let pass = 0, fail = 0;
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : fail++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------- raw CDP */

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
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
      }
    });
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.waiting.set(id, { res, rej }));
  }
  /** Evaluate an expression, await promises, return the JSON value. */
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  }
  async waitFor(label, expr, timeoutMs = 20_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (await this.eval(expr)) return true; } catch { /* mid-navigation */ }
      await sleep(150);
    }
    console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
    return false;
  }
  close() { try { this.ws.close(); } catch { /* already gone */ } }
}

/* ------------------------------------------------------------- processes */

let server = null, browser = null;
const cleanupDirs = [];

function stopByPid(child, name) {
  // NEVER pkill / pattern match — pid only (see TODO process notes).
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* already gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); }
  }
  if (!up) throw new Error('server never became healthy');

  // Register THIS repo — its real sessions live in ~/.claude/projects.
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: ROOT, name: 'Claude Station' }),
  })).json();
  const projectId = reg.project?.id;
  if (!projectId) throw new Error(`could not register project: ${JSON.stringify(reg)}`);
  const sessions = await (await fetch(`${BASE}/api/projects/${projectId}/sessions`)).json();
  if (!sessions.sessions?.length) throw new Error('precondition failed: no real sessions for this repo');

  /*
   * Deep restore needs a session where `i=5` is far older than the newest
   * TAIL_PAGE — synthesised (600 alternating text messages) in a throwaway
   * project's store rather than borrowed, so the check does not depend on what
   * happens to be in the real store this week. The store dir is removed on
   * teardown. Entry shape mirrors what isMainThreadEntry/blocksOf require.
   */
  const bigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-route-proj-'));
  const bigEncoded = bigDir.replace(/[/.]/g, '-');
  const bigStore = path.join(os.homedir(), '.claude', 'projects', bigEncoded);
  fs.mkdirSync(bigStore, { recursive: true });
  const bigSid = '11111111-2222-4333-8444-555555555555';
  const lines = [];
  for (let n = 0; n < 600; n++) {
    const role = n % 2 ? 'assistant' : 'user';
    lines.push(JSON.stringify({
      parentUuid: null, isSidechain: false, type: role,
      message: { role, content: [{ type: 'text', text: `synthetic message ${n}` }] },
      uuid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      timestamp: new Date(1700000000000 + n * 1000).toISOString(), sessionId: bigSid,
    }));
  }
  fs.writeFileSync(path.join(bigStore, `${bigSid}.jsonl`), lines.join('\n') + '\n');
  cleanupDirs.push(bigStore);
  const regBig = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: bigDir, name: 'route-fixture' }),
  })).json();
  const bigProjectId = regBig.project?.id;
  const bigSessions = await (await fetch(`${BASE}/api/projects/${bigProjectId}/sessions`)).json();
  const big = bigSessions.sessions?.find((s) => s.sessionId === bigSid) ?? null;
  if (!big) console.log(`  (fixture session not listed — deep-restore will be skipped: ${JSON.stringify(bigSessions).slice(0, 200)})`);

  const target0 = sessions.sessions[0];

  browser = spawn(BRAVE, [
    '--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', '--window-size=1280,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  if (!devPort) throw new Error('browser never wrote DevToolsActivePort');

  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');

  const HERE = `document.querySelector('#panes .pane .you, #panes .pane .claude') !== null`;
  const CUR = `window.__station?.state.current.sessionId`;

  console.log('\n=== routing: open writes the URL ===');
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.waitFor('boot', `document.querySelectorAll('#tree button.proj').length > 0`);
  // Open the big session through the real sidebar row.
  const target = target0;
  await cdp.waitFor('session rows', `[...document.querySelectorAll('#tree .kids button.row')].length > 0 || (document.querySelector('#tree button.proj')?.click(), false)`);
  const clicked = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('#tree .kids button.row')];
    const row = rows.find((r) => r.textContent.includes(${JSON.stringify(target.displayTitle.slice(0, 30))}));
    if (!row) return false;
    row.click(); return true;
  })()`);
  if (!clicked) { // fall back: open via the app's own API surface
    await cdp.eval(`(async () => {
      const p = window.__station.state.projects[0];
      const api = window.__station.api;
      const s = (await api.projectSessions(p.id)).sessions.find((x) => x.sessionId === ${JSON.stringify(target.sessionId)});
      const rows = [...document.querySelectorAll('#tree .kids button.row')];
      window.dispatchEvent(new Event('noop'));
    })()`);
  }
  await cdp.waitFor('transcript', HERE, 30_000);
  let hash = await cdp.eval('location.hash');
  check('opening a session wrote #/project/<id>/session/<sid>?dir=…',
    hash.startsWith(`#/project/${projectId}/session/${target.sessionId}`) && hash.includes('dir='), hash);

  console.log('\n=== routing: scroll writes i, reload restores the place ===');
  await cdp.eval(`(() => { const s = document.querySelector('#scroll'); s.scrollTop = Math.max(0, s.scrollHeight/2 - s.clientHeight); s.dispatchEvent(new Event('scroll')); return s.scrollTop; })()`);
  await sleep(800); // debounce is 400ms
  hash = await cdp.eval('location.hash');
  const iMatch = /[?&]i=(\d+)/.exec(hash);
  check('scrolling away from the bottom wrote &i=<index>', !!iMatch, hash);
  const rememberedI = iMatch ? Number(iMatch[1]) : null;

  // Pre-seed the persisted expansion set with THIS project before reloading:
  // boot then preloads its session list, and applyRoute must AWAIT that
  // in-flight load. (Regression: it used to see the still-empty list, declare
  // the session missing, and silently drop to the project view.)
  await cdp.eval(`localStorage.setItem('cs-expanded', JSON.stringify([${JSON.stringify(projectId)}]))`);
  await cdp.eval('location.reload()');
  await sleep(800);
  const reOk = await cdp.waitFor('transcript after reload', HERE, 30_000);
  const afterReload = await cdp.eval(`(() => {
    const st = window.__station.state;
    const top = document.querySelector('#scroll').getBoundingClientRect().top;
    let topI = null, last = null;
    for (const m of document.querySelectorAll('#panes .pane.on [data-i]')) {
      if (m.getBoundingClientRect().bottom > top + 4) { topI = Number(m.dataset.i); break; }
      last = m;
    }
    if (topI === null && last) topI = Number(last.dataset.i);
    return { sessionId: st.current.sessionId, topI, hash: location.hash };
  })()`);
  check('hard reload landed back in the SAME session', reOk && afterReload.sessionId === target.sessionId,
    `session ${String(afterReload.sessionId).slice(0, 8)} vs expected ${target.sessionId.slice(0, 8)}`);
  check('…at the remembered message (top-visible index within ±3 of i)',
    rememberedI != null && afterReload.topI != null && Math.abs(afterReload.topI - rememberedI) <= 3,
    `i=${rememberedI}, top after reload=${afterReload.topI}, hash=${afterReload.hash}`);

  console.log('\n=== routing: same URL in a NEW tab ===');
  const urlNow = await cdp.eval('location.href');
  const created = await (await fetch(`http://127.0.0.1:${devPort}/json/new?${encodeURIComponent(urlNow)}`, { method: 'PUT' })).json();
  const cdp2 = await Cdp.connect(created.webSocketDebuggerUrl);
  await cdp2.waitFor('app booted in second tab', `window.__station !== undefined`, 60_000);
  const tabOk = await cdp2.waitFor('transcript in second tab', HERE, 30_000);
  const tab = await cdp2.eval(`({ sessionId: window.__station?.state.current.sessionId, hash: location.hash })`);
  check('pasting the URL into a new tab opened the same session', tabOk && tab.sessionId === target.sessionId,
    `session ${String(tab.sessionId).slice(0, 8)}, hash=${tab.hash}`);
  cdp2.close();

  console.log('\n=== routing: Back returns to the previous session ===');
  // Open a DIFFERENT session on top, then go back.
  await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('#tree .kids button.row')];
    const other = rows.find((r) => !r.textContent.includes(${JSON.stringify(target.displayTitle.slice(0, 30))}));
    if (!other) return false;
    other.click(); return true;
  })()`);
  await cdp.waitFor('second session open', `${CUR} && ${CUR} !== ${JSON.stringify(target.sessionId)}`, 30_000);
  const secondId = await cdp.eval(CUR);
  await cdp.eval('history.back()');
  const backOk = await cdp.waitFor('back to first session', `${CUR} === ${JSON.stringify(target.sessionId)}`, 30_000);
  check('browser Back returned to the previously open session', backOk,
    `was ${String(secondId).slice(0, 8)}, back → ${String(await cdp.eval(CUR)).slice(0, 8)}`);

  console.log('\n=== routing: bogus session id fails honestly ===');
  const bogus = `${BASE}/#/project/${projectId}/session/00000000-dead-beef-0000-000000000000?dir=${encodeURIComponent(target.encodedDir)}`;
  await cdp.send('Page.navigate', { url: bogus });
  await cdp.waitFor('boot after bogus link', `document.querySelectorAll('#tree button.proj').length > 0`, 30_000);
  await sleep(1000);
  const bogusOut = await cdp.eval(`({
    sessionId: window.__station?.state.current.sessionId ?? null,
    said: [...document.querySelectorAll('#panes .hint-row')].map((n) => n.textContent).join(' | '),
    hash: location.hash,
  })`);
  check('a bogus session id shows an honest message and does NOT open a session',
    bogusOut.sessionId === null && /not here|not found|deleted/i.test(bogusOut.said),
    JSON.stringify(bogusOut));

  if (big) {
    console.log('\n=== routing: deep restore (history window + gap) ===');
    const deepI = 5;
    await cdp.send('Page.navigate', { url: `${BASE}/#/project/${bigProjectId}/session/${big.sessionId}?dir=${encodeURIComponent(big.encodedDir)}&i=${deepI}` });
    await sleep(500);
    await cdp.waitFor('deep transcript', HERE, 30_000);
    await sleep(500);
    const deep = await cdp.eval(`(() => {
      const th = window.__station.state.threads.get('main');
      const top = document.querySelector('#scroll').getBoundingClientRect().top;
      let topI = null;
      for (const m of document.querySelectorAll('#panes .pane.on [data-i]')) {
        if (m.getBoundingClientRect().bottom > top + 4) { topI = Number(m.dataset.i); break; }
      }
      return {
        gap: th.gap ? { ...th.gap } : null,
        topI,
        composerHidden: document.querySelector('#box').hidden,
        historyBarShown: !document.querySelector('#history').hidden,
        jumpShown: !document.querySelector('#jump').hidden,
        following: window.__station.state.following,
      };
    })()`);
    check('deep i rendered a window AROUND the message (top-visible near i, not the tail)',
      deep.topI != null && Math.abs(deep.topI - deepI) <= 5, `i=${deepI}, top=${deep.topI}`);
    check('the forward gap is recorded and live-follow is OFF while parked',
      !!deep.gap && deep.gap.next < deep.gap.total && !deep.following, JSON.stringify({ gap: deep.gap, following: deep.following }));
    check('composer replaced by the history bar; Latest pill offered',
      deep.composerHidden && deep.historyBarShown && deep.jumpShown,
      JSON.stringify({ composerHidden: deep.composerHidden, historyBarShown: deep.historyBarShown, jumpShown: deep.jumpShown }));

    await cdp.eval(`document.querySelector('#historyLatestBtn').click()`);
    const caught = await cdp.waitFor('back at the tail', `(() => {
      const th = window.__station.state.threads.get('main');
      return th && !th.gap && !document.querySelector('#box').hidden && document.querySelector('#history').hidden;
    })()`, 30_000);
    const afterJump = await cdp.eval(`({ hash: location.hash, gap: window.__station.state.threads.get('main').gap ?? null })`);
    check('"Jump to latest" restored the normal tail (gap gone, composer back, i dropped from URL)',
      caught && !/[?&]i=/.test(afterJump.hash), JSON.stringify(afterJump));
  } else {
    console.log('\n  (deep-restore section SKIPPED — no session over 300 messages in this store)');
  }

  cdp.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exitCode = 1;
}).finally(() => {
  stopByPid(browser, 'browser');
  stopByPid(server, 'server');
  setTimeout(() => {
    fs.rmSync(DATA, { recursive: true, force: true });
    fs.rmSync(PROFILE, { recursive: true, force: true });
    for (const d of cleanupDirs) fs.rmSync(d, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  }, 2500);
});
