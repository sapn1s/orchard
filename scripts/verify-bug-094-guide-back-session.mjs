/**
 * BUG-094 — "← sessions" back link from the Guide (and Tickets) must return to
 * the session the user was ON, not bare `#/` (which the session router reads as
 * "start a NEW session").
 *
 *   node scripts/verify-bug-094-guide-back-session.mjs
 *
 * Real brave --headless=new over raw CDP, one scratch server on an OS-assigned
 * free port (never :4317), the repo's OWN real ~/.claude session store as the
 * REALISTIC fixture (a user who has actually been working, with real sessions in
 * the sidebar), never a synthetic one-liner.
 *
 * Checks (the user's reality, driven through the real click-path):
 *   1. open a real session → note its id + URL
 *   2. click the topbar Guide pill (#guideBtn) → reader opens over the live session
 *   3. click "← sessions" (#gvHome) → the SAME session is active AND the URL is a
 *      proper #/project/<id>/session/<sid> hash (so a reload keeps it) — NOT a
 *      bare #/project/<id> that boot()/applyRoute turns into a new session.
 *   4. same for the Tickets dashboard "← sessions" (#tvHome).
 *   5. cold-URL edge: load #/guide with no prior session → "← sessions" → the
 *      sessions view, no crash, no thrown page error.
 *   6. anti-regress: browser Back from the guide still closes the reader.
 *
 * MUST-FAIL pre-fix: with #gvHome/#tvHome pinned to formatHash({projectId}) (bare
 * project, session dropped), step 3/4's URL check fails — the hash loses
 * /session/<sid>, so a reload lands on a new session. Re-run after the fix.
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
const PORT = Number(process.env.VERIFY_BUG094_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b094-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b094-brave-'));
const BRAVE = process.env.VERIFY_BUG094_BROWSER ?? 'brave';

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : (fail++, failures.push(name));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

let server = null, browser = null;
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

const CUR = `window.__station?.state.current.sessionId`;
const HERE = `document.querySelector('#panes .pane .you, #panes .pane .claude') !== null`;

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

  // REALISTIC fixture: register THIS repo — its real sessions live in
  // ~/.claude/projects, so the sidebar is a real working set, not a stub.
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: ROOT, name: 'Orchard' }),
  })).json();
  const projectId = reg.project?.id;
  if (!projectId) throw new Error(`could not register project: ${JSON.stringify(reg)}`);
  const sessions = await (await fetch(`${BASE}/api/projects/${projectId}/sessions`)).json();
  if (!sessions.sessions?.length) throw new Error('precondition failed: no real sessions for this repo');
  const target = sessions.sessions[0];

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
  const cdp = await Cdp.connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');

  // ---- open a real session through the sidebar --------------------------------
  console.log('\n=== setup: open a real session ===');
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.waitFor('boot', `document.querySelectorAll('#tree button.proj').length > 0`, 60_000);
  await cdp.eval(`document.querySelector('#tree button.proj')?.click()`);
  await cdp.waitFor('session rows', `[...document.querySelectorAll('#tree .kids button.row')].length > 0 || (document.querySelector('#tree button.proj')?.click(), false)`, 30_000);
  await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('#tree .kids button.row')];
    const row = rows.find((r) => r.textContent.includes(${JSON.stringify(target.displayTitle.slice(0, 30))})) || rows[0];
    if (row) row.click();
  })()`);
  await cdp.waitFor('transcript', HERE, 30_000);
  const sid0 = await cdp.eval(CUR);
  const hash0 = await cdp.eval('location.hash');
  check('a real session is open with a proper session URL',
    !!sid0 && hash0.includes(`/session/${sid0}`), { sid: String(sid0).slice(0, 8), hash: hash0 });

  // ---- GUIDE: pill in, "← sessions" out --------------------------------------
  console.log('\n=== guide: pill opens reader, "← sessions" returns to the SAME session ===');
  await cdp.eval(`document.querySelector('#guideBtn').click()`);
  await cdp.waitFor('guide open', `document.querySelector('#guideView') && !document.querySelector('#guideView').hidden`, 20_000);
  const gvHref = await cdp.eval(`document.querySelector('#gvHome')?.getAttribute('href') ?? null`);
  check('the guide "← sessions" href carries the open session (not a bare project/root hash)',
    typeof gvHref === 'string' && gvHref.includes(`/session/${sid0}`),
    { href: gvHref, expectSession: String(sid0).slice(0, 8) });
  await cdp.eval(`document.querySelector('#gvHome').click()`);
  await cdp.waitFor('guide closed', `document.querySelector('#guideView')?.hidden === true`, 20_000);
  await sleep(300);
  const afterGuide = await cdp.eval(`({ sid: ${CUR} ?? null, hash: location.hash })`);
  check('after guide "← sessions": the SAME session is active (not a new/blank one)',
    afterGuide.sid === sid0, { was: String(sid0).slice(0, 8), now: String(afterGuide.sid).slice(0, 8) });
  check('after guide "← sessions": the URL still names the session (reload-safe, not bare #/project)',
    afterGuide.hash.includes(`/session/${sid0}`), afterGuide.hash);

  // ---- TICKETS: pill in, "← sessions" out ------------------------------------
  console.log('\n=== tickets: dashboard opens, "← sessions" returns to the SAME session ===');
  // The board pill (#boardBtn) is an anchor href="#/tickets"; drive it directly
  // (it is shown only for projects with a board, but .click() fires regardless).
  await cdp.eval(`document.querySelector('#boardBtn').click()`);
  await cdp.waitFor('tickets open', `document.querySelector('#ticketsView') && !document.querySelector('#ticketsView').hidden`, 20_000);
  const tvHref = await cdp.eval(`document.querySelector('#tvHome')?.getAttribute('href') ?? null`);
  check('the tickets "← sessions" href carries the open session (not a bare project/root hash)',
    typeof tvHref === 'string' && tvHref.includes(`/session/${sid0}`),
    { href: tvHref, expectSession: String(sid0).slice(0, 8) });
  await cdp.eval(`document.querySelector('#tvHome').click()`);
  await cdp.waitFor('tickets closed', `document.querySelector('#ticketsView')?.hidden === true`, 20_000);
  await sleep(300);
  const afterTickets = await cdp.eval(`({ sid: ${CUR} ?? null, hash: location.hash })`);
  check('after tickets "← sessions": the SAME session is active (not a new/blank one)',
    afterTickets.sid === sid0, { was: String(sid0).slice(0, 8), now: String(afterTickets.sid).slice(0, 8) });
  check('after tickets "← sessions": the URL still names the session (reload-safe)',
    afterTickets.hash.includes(`/session/${sid0}`), afterTickets.hash);

  // ---- anti-regress: browser Back from the guide still closes the reader ------
  console.log('\n=== anti-regress: browser Back from the guide still works ===');
  await cdp.eval(`document.querySelector('#guideBtn').click()`);
  await cdp.waitFor('guide open again', `document.querySelector('#guideView') && !document.querySelector('#guideView').hidden`, 20_000);
  await cdp.eval('history.back()');
  const backOk = await cdp.waitFor('reader closed by Back', `document.querySelector('#guideView')?.hidden === true && ${CUR} === ${JSON.stringify(sid0)}`, 20_000);
  check('browser Back closes the guide and lands back on the same session',
    backOk, { sid: String(await cdp.eval(CUR)).slice(0, 8) });

  // ---- cold-URL edge: #/guide with no prior session --------------------------
  console.log('\n=== cold: #/guide opened directly → "← sessions" → sessions view, no crash ===');
  let pageError = null;
  cdp.send('Runtime.enable').catch(() => {});
  cdp.ws.on('message', (d) => {
    try { const m = JSON.parse(d.toString());
      if (m.method === 'Runtime.exceptionThrown') pageError = m.params?.exceptionDetails?.exception?.description ?? 'exception';
    } catch { /* ignore */ }
  });
  await cdp.eval(`localStorage.removeItem('cs-expanded')`);
  await cdp.send('Page.navigate', { url: `${BASE}/#/guide` });
  await cdp.waitFor('cold guide boot', `window.__station !== undefined && document.querySelector('#guideView') && !document.querySelector('#guideView').hidden`, 60_000);
  const coldHref = await cdp.eval(`document.querySelector('#gvHome')?.getAttribute('href') ?? null`);
  check('cold #/guide gives a non-crashing "← sessions" href (a project/root hash, defined)',
    typeof coldHref === 'string' && coldHref.startsWith('#/'), { href: coldHref });
  await cdp.eval(`document.querySelector('#gvHome').click()`);
  const coldClosed = await cdp.waitFor('cold guide closed', `document.querySelector('#guideView')?.hidden === true`, 20_000);
  await sleep(300);
  const coldOut = await cdp.eval(`({ hash: location.hash, guideOpen: !document.querySelector('#guideView')?.hidden })`);
  check('cold "← sessions" closes the reader onto the sessions view (no guide hash), no page error',
    coldClosed && !coldOut.hash.startsWith('#/guide') && !pageError,
    { hash: coldOut.hash, pageError });

  cdp.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) console.log(`  failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exitCode = 1;
}).finally(() => {
  stopByPid(browser);
  stopByPid(server);
  setTimeout(() => {
    fs.rmSync(DATA, { recursive: true, force: true });
    fs.rmSync(PROFILE, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  }, 2500);
});
