#!/usr/bin/env node
/**
 * verify-bug-255-truth-ui.mjs — BUG-255 r2 (two-break redesign). The account
 * indicator renders ONLY the server's pushed, versioned account fact, so it never
 * misrepresents the account — across tabs and across a lost/late ack.
 * Driven in a real headless browser against a real scratch server + fake CLI:
 *   T1 two tabs: tab 1 rebinds a stopped bound session B->A by a real click; tab 2
 *      (same session, no action) shows "plan A" within 3s.
 *   T2 lost ack: the POST reaches the server and commits; the browser's response is
 *      reset. The indicator shows the truth ("plan A"), the status says "unknown —
 *      checking" then "switched"; it is never reported as a refusal.
 *   T3 delayed ack (response held 6s): the indicator shows "plan A" from the push
 *      within 3s, before the ack lands.
 *   T3b ack held PAST the unknown timer with the push missed: unknown fires, the re-read
 *      settles it, the late ack changes nothing.
 *   R  ordering: GET never bumps rev; the client's one writer drops a late older fact.
 *   T4 a real refusal (unready account) is still a refusal with its reason; the
 *      indicator stays on the true account; no "unknown".
 *   T5 a viewing tab sees a LIVE switch made elsewhere (another client resumes the
 *      session under B and live-switches it to A): the indicator follows to A.
 * MUST-FAIL: every test is run twice — against the current client and against the
 * r1 client (the synthesized pre-fix for THIS round, saved before the r2 edits and
 * served in place of app.js on the same server). The r1 client must FAIL T1/T2/T3/T5.
 *   BUG255_PRE_APP=/path/to/r1/app.js (default /tmp/bug255r2-pre/app.js; the
 *   must-FAIL half is skipped — and reported as skipped — if it is absent).
 * Original header of the suite this was derived from follows.
 *
 * verify-bug-255-ui.mjs — the USER-OBSERVABLE half of BUG-255, driven in a real
 * headless browser against a real scratch server + fake CLI. Proves, in the DOM
 * the user actually sees:
 *   (a) DISPLAY — a BOUND session (bound to B) whose tab also carries a STALE
 *       client override (A) shows the BOUND account B in the indicator, not the
 *       override. MUST-FAIL: the same page served a SYNTHESIZED PRE-FIX app.js
 *       (claudeAccountView reverted) shows the stale override A — the reported bug.
 *   (d) ACTION — clicking account A in the real popover actually rebinds the
 *       session (the server's session-accounts.json binding changes to A) and the
 *       indicator updates to A. The pre-fix client armed a dropped override and
 *       the binding never moved.
 * Screenshots are written to docs/bugs/assets/ for visual review.
 *
 * Isolation: scratch HOME / DATA / STORE. No real credentials; no token contents.
 * Run: node scripts/verify-bug-255-ui.mjs   (needs playwright chromium)
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const ASSETS = path.join(ROOT, 'docs', 'bugs', 'assets');
fs.mkdirSync(ASSETS, { recursive: true });

let pass = 0, fail = 0;
const ok = (c, name, observed) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`); c ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() { const net = await import('node:net'); return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'bug255truth-'));
const HOME = path.join(SCRATCH, 'home'); const DATA = path.join(SCRATCH, 'data'); const STORE = path.join(SCRATCH, 'store'); const WORK = path.join(SCRATCH, 'work');
fs.mkdirSync(path.join(HOME, '.claude', 'projects'), { recursive: true }); fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(STORE, { recursive: true }); fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(path.join(HOME, '.claude', 'settings.json'), JSON.stringify({ cleanupPeriodDays: 36500 }) + '\n');
delete process.env.CLAUDE_CONFIG_DIR; process.env.HOME = HOME; process.env.CLAUDE_STATION_DATA = DATA; process.env.CLAUDE_PROJECTS_DIR = STORE;

const FAKE = path.join(WORK, 'fake-claude.mjs');
fs.writeFileSync(FAKE, `
import * as readline from 'node:readline';
import * as fsx from 'node:fs'; const require_fs = () => fsx;
import { randomUUID } from 'node:crypto';
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
if (process.env.BUG255_ARGLOG) require_fs().appendFileSync(process.env.BUG255_ARGLOG, JSON.stringify(process.argv.slice(2)) + '\\n');
const argOf = (f) => { const a = process.argv; const i = a.indexOf(f); if (i > -1) return a[i + 1]; const e = a.find((x) => x.startsWith(f + '=')); return e ? e.slice(f.length + 1) : null; };
const sid = argOf('--resume') || argOf('--session-id') || randomUUID();
const rl = readline.createInterface({ input: process.stdin }); let started = false;
rl.on('line', (l) => { let m; try { m = JSON.parse(l); } catch { return; }
  if (m.type === 'control_request') { say({ type:'control_response', response:{ subtype:'success', request_id:m.request_id, response:{} } }); return; }
  if (m.type !== 'user') return;
  if (!started) { started = true; say({ type:'system', subtype:'init', session_id: sid, cwd: process.cwd(), model:'haiku', tools:[], slash_commands:[] }); }
  say({ type:'assistant', message:{ model:'claude-haiku-4-5', content:[{ type:'text', text:'ok' }] } });
  say({ type:'result', subtype:'success', total_cost_usd:0 });
});
rl.on('close', () => process.exit(0));
process.stdin.resume();
`);

let server = null; let browser = null;
function cleanup() {
  try { if (server && server.exitCode === null) process.kill(server.pid, 'SIGKILL'); } catch {}
  try { if (browser) browser.close(); } catch {}
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);

async function jpost(port, p, body) { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; }
function openWs(port) { return new Promise((res, rej) => { const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); const events = []; ws.on('message', (raw) => { try { events.push(JSON.parse(String(raw))); } catch {} }); ws.once('open', () => res({ ws, events, send: (o) => ws.send(JSON.stringify(o)), close: () => { try { ws.close(); } catch {} } })); ws.once('error', rej); ws.on('error', () => {}); }); }
const waitEv = async (events, pred, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const h = events.find(pred); if (h) return h; await sleep(80); } return null; };


async function main() {
  const accts = await import(path.join(ROOT, 'src', 'server', 'claude-accounts.ts'));
  const hist = await import(path.join(ROOT, 'src', 'lib', 'session-history.ts'));
  const accountsFile = path.join(DATA, 'claude-accounts.json');
  const mk = (label, ready = true) => { const row = accts.createAccount(label); const reg = JSON.parse(fs.readFileSync(accountsFile, 'utf8')); for (const r of reg.accounts) if (r.id === row.id) r.state = ready ? 'ready' : 'needs-login'; fs.writeFileSync(accountsFile, JSON.stringify(reg, null, 2) + '\n'); if (ready) fs.writeFileSync(path.join(accts.resolveAccountDir(row.id), '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'stub' } }) + '\n'); return row; };
  const A = mk('plan A'); const B = mk('plan B'); const C = mk('plan C', false);

  const port = await freePort();
  server = spawn(process.execPath, [ENTRY], { cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE, HOME, CLAUDE_STATION_CLAUDE_BIN: FAKE, CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0', CLAUDE_STATION_SURVIVE: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', (d) => { if (process.env.BUG255_DEBUG) process.stderr.write(d); });
  for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${port}/api/health`); break; } catch { await sleep(150); } }

  const projCwd = path.join(WORK, 'proj'); fs.mkdirSync(projCwd, { recursive: true });
  const reg = await jpost(port, '/api/projects', { hostPath: projCwd, name: 'bug255truth', isolation: 'direct' });
  const projectId = reg.body.project.id; const encodedDir = reg.body.project.encodedDir ?? hist.encodeCwd(projCwd);
  const sessionsFile = path.join(DATA, 'session-accounts.json');
  const bindingOf = (sid) => { try { return JSON.parse(fs.readFileSync(sessionsFile, 'utf8')).bindings?.[sid]; } catch { return undefined; } };
  const writeTranscript = (sid) => { const dir = path.join(STORE, encodedDir); fs.mkdirSync(dir, { recursive: true }); const ts = new Date().toISOString(); const lines = [ { type: 'user', sessionId: sid, cwd: projCwd, timestamp: ts, uuid: `u-${sid}`, message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }, { type: 'assistant', sessionId: sid, cwd: projCwd, timestamp: ts, uuid: `a-${sid}`, message: { role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'ok' }] } } ]; fs.writeFileSync(path.join(dir, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n'); };

  // A BOUND, STOPPED session: start under A, live-switch to `to`, close. Busy-state: several exist.
  async function makeBound(to) {
    const c = await openWs(port);
    let sid = null;
    for (let i = 0; i < 40 && !sid; i++) { c.send({ type: 'start', projectId, overrides: { model: 'haiku', permissionMode: 'bypassPermissions', claudeAccount: A.id }, prompt: 'hi' }); const init = await waitEv(c.events, (e) => e.t === 'session-init', 6000); if (init) sid = init.sessionId; else await sleep(1000); }
    if (!sid) throw new Error('could not start a session');
    await sleep(1000);
    c.send({ type: 'switch-account', requestId: 'sw', account: to.id });
    const ack = await waitEv(c.events, (e) => e.t === 'ack' && e.of === 'switch-account');
    c.close(); await sleep(600); writeTranscript(sid);
    if (!ack?.ok || bindingOf(sid) !== to.id) throw new Error(`setup: expected binding ${to.label}, got ${bindingOf(sid)} (${JSON.stringify(ack)})`);
    return sid;
  }
  const link = (sid) => `http://127.0.0.1:${port}/#/project/${encodeURIComponent(projectId)}/session/${encodeURIComponent(sid)}?dir=${encodeURIComponent(encodedDir)}`;

  browser = await chromium.launch({ headless: true, executablePath: process.env.QA_BRAVE_PATH ?? '/usr/bin/brave', args: ['--no-sandbox'] });
  const PRE = process.env.BUG255_PRE_APP ?? '/tmp/bug255r2-pre/app.js';
  const preApp = fs.existsSync(PRE) ? fs.readFileSync(PRE, 'utf8') : null;

  async function openTab(ctx, sid, mode, opts = {}) {
    const page = await ctx.newPage();
    if (opts.dropAccountPush) {
      // Simulate the push being MISSED too (e.g. the watch socket was down): pass every ws frame
      // through except `session-account`, so only the client's own re-read can learn the outcome.
      await page.routeWebSocket(/\/ws$/, (ws) => {
        const srv = ws.connectToServer();
        srv.onMessage((m) => { if (typeof m === 'string' && m.includes('"t":"session-account"')) { page.__dropped = (page.__dropped ?? 0) + 1; return; } ws.send(m); });
        ws.onMessage((m) => srv.send(m));
      });
    }
    if (process.env.BUG255_TRACE && mode === 'r2') { const traced = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8').replace('async function refreshAccountFact(sid) {', 'async function refreshAccountFact(sid) { console.log("RAF " + new Error().stack.split("\\n").slice(2, 5).join(" | "));'); await page.route('**/app.js', (r) => r.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: traced })); page.on('console', (m) => { if (m.text().startsWith('RAF')) console.log(m.text().slice(0, 400)); }); }
    if (mode === 'r1') await page.route('**/app.js', (r) => r.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: preApp }));
    // A message log: every status line the user is shown, in order.
    await page.addInitScript(() => {
      window.__said = [];
      const hook = () => { const f = document.getElementById('fine'); if (!f) return setTimeout(hook, 50); new MutationObserver(() => { const t = (f.textContent || '').trim(); if (t && window.__said[window.__said.length - 1] !== t) window.__said.push(t); }).observe(f, { childList: true, characterData: true, subtree: true }); };
      hook();
    });
    page.__gets = [];
    page.on('request', (r) => { if (/\/api\/sessions\/[^/]+\/account(\?|$)/.test(r.url())) page.__gets.push(`${r.method()}@${Date.now() % 100000}`); });
    page.on('websocket', (w) => { if (process.env.BUG255_DEBUG) console.log('ws opened', w.url()); });
    await page.goto(link(sid), { waitUntil: 'domcontentloaded' });
    await waitChip(page, (t) => !!t && !/checking/.test(t), 15000); // r3 wording: 'account unknown — checking'
    // Let the page-lifetime watch socket open (its open re-reads the fact) before a test acts,
    // so a test's switch is not resolved by that coincidental open-time re-read.
    await sleep(1500);
    return page;
  }
  const chip = (page) => page.evaluate(() => { const n = document.getElementById('acctSelN'); const sel = document.getElementById('acctSel'); return (sel && !sel.hidden && n) ? (n.textContent || '').trim() : ''; });
  async function waitChip(page, pred, ms) { const t0 = Date.now(); let t = ''; while (Date.now() - t0 < ms) { t = await chip(page); if (pred(t)) return t; await sleep(100); } return t; }
  async function clickAccount(page, label) {
    await page.click('#acctSel');
    await page.waitForSelector('#acctOpts', { state: 'visible', timeout: 5000 });
    const clicked = await page.evaluate((l) => { const b = [...document.querySelectorAll('#acctOpts .opt')].find((x) => (x.querySelector('.n')?.textContent || '').trim() === l); if (b) { b.click(); return true; } return false; }, label);
    if (!clicked) throw new Error(`no "${label}" row in the account popover`);
  }
  const said = (page) => page.evaluate(() => window.__said.slice());
  const refusalWords = /declined|could not switch|not switching|refus|failed|unchanged/i;

  const ONLY = (process.env.BUG255_ONLY || '').split(',').filter(Boolean);
  const only = (t) => !ONLY.length || ONLY.includes(t);
  // In the r1 (must-FAIL) run a broken property is the EXPECTED outcome: print it as such and grade it below.
  const rec = (mode, held, name, observed) => { if (mode === 'r2') return ok(held, name, observed); console.log(`  ${held ? 'r1-HELD (no break)' : 'r1-BROKE (expected)'}  ${name}\n        observed: ${JSON.stringify(observed)}`); };
  const results = {}; // results[mode][test] = boolean (the property held)
  async function runAll(mode) {
    const R = results[mode] = {};
    console.log(`\n######## client: ${mode === 'r2' ? 'CURRENT (r2)' : 'r1 (pre-fix for this round)'}`);

    /* T1 — two tabs */
    if (only('T1')) {
      console.log('\n== T1 two tabs: tab 1 switches; tab 2 must follow without any action');
      const sid = await makeBound(B);
      const ctx = await browser.newContext();
      const t1 = await openTab(ctx, sid, mode); const t2 = await openTab(ctx, sid, mode);
      const before = [await chip(t1), await chip(t2)];
      await clickAccount(t1, 'plan A');
      const t1c = await waitChip(t1, (t) => t === 'plan A', 5000);
      const bound = bindingOf(sid);
      const t0 = Date.now(); const t2c = await waitChip(t2, (t) => t === 'plan A', 3000); const lag = Date.now() - t0;
      if (mode === 'r2') await t2.screenshot({ path: path.join(ASSETS, 'BUG-255-r2-tab2-follows.png') });
      const held = bound === A.id && t1c === 'plan A' && t2c === 'plan A';
      rec(mode, held, `[${mode}] tab 2 shows the server's account "plan A" within 3s of tab 1's switch`, { before, binding: bound === A.id ? 'A' : bound, tab1: t1c, tab2: t2c, tab2LagMs: t2c === 'plan A' ? lag : '>3000' });
      R.T1 = held; await ctx.close();
    }

    /* T2 — lost ack (connection reset after the server committed); T2b also drops the push */
    for (const variant of ['T2', 'T2b'].filter(only)) {
      console.log(variant === 'T2' ? '\n== T2 lost ack: the switch commits server-side but the response is lost' : '\n== T2b lost ack AND the push is missed: only the re-read can resolve it');
      const sid = await makeBound(B);
      const ctx = await browser.newContext();
      const page = await openTab(ctx, sid, mode, { dropAccountPush: variant === 'T2b' });
      let committedStatus = null;
      await page.route('**/api/sessions/*/account', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        const resp = await route.fetch(); committedStatus = resp.status();
        await route.abort('connectionreset');
      });
      await clickAccount(page, 'plan A');
      const c = await waitChip(page, (t) => t === 'plan A', 12000);
      await sleep(1500);
      const msgs = await said(page);
      const bound = bindingOf(sid);
      const sawUnknown = msgs.some((m) => /unknown/i.test(m) && /check/i.test(m));
      const finalMsg = msgs[msgs.length - 1] ?? '';
      const reportedRefusal = msgs.some((m) => refusalWords.test(m) && !/unknown/i.test(m));
      if (mode === 'r2') await page.screenshot({ path: path.join(ASSETS, `BUG-255-r2-lost-ack-${variant}.png`) });
      // T2: the push may legitimately settle it before the reset is seen (no 'unknown' needed); T2b must go through 'unknown — checking'.
      const held = committedStatus === 200 && bound === A.id && c === 'plan A' && (variant === 'T2' || (sawUnknown && page.__dropped > 0)) && /switched to plan A/i.test(finalMsg) && !reportedRefusal;
      rec(mode, held, `[${mode}] ${variant} lost ack${variant === 'T2b' ? ' + missed push' : ''}: indicator shows the committed "plan A"; ${variant === 'T2b' ? 'status "unknown — checking" then ' : ''}"switched"; never a refusal`, { serverStatus: committedStatus, droppedPushes: page.__dropped ?? 0, binding: bound === A.id ? 'A' : bound, chip: c, messages: msgs.filter((m) => /account|switch|unknown/i.test(m)) });
      R[variant] = held; await ctx.close();
    }

    /* T3 — delayed ack (held 6s) */
    if (only('T3')) {
      console.log('\n== T3 delayed ack: the indicator follows the server push before the ack lands');
      const sid = await makeBound(B);
      const ctx = await browser.newContext();
      const page = await openTab(ctx, sid, mode);
      let ackAt = 0;
      await page.route('**/api/sessions/*/account', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        const resp = await route.fetch(); await sleep(6000); ackAt = Date.now();
        await route.fulfill({ response: resp });
      });
      const clickAt = Date.now();
      await clickAccount(page, 'plan A');
      const c = await waitChip(page, (t) => t === 'plan A', 3000);
      const chipAt = Date.now();
      await sleep(4500);
      const msgs = await said(page);
      const held = c === 'plan A' && bindingOf(sid) === A.id && !msgs.some((m) => refusalWords.test(m) && !/unknown/i.test(m));
      rec(mode, held, `[${mode}] delayed ack: "plan A" shown within 3s from the push (ack held 6s), no refusal`, { chipAt3s: c, msAfterClick: chipAt - clickAt, ackLandedAfterClickMs: ackAt ? ackAt - clickAt : 'not yet', messages: msgs.filter((m) => /account|switch|unknown/i.test(m)) });
      R.T3 = held; await ctx.close();
    }

    /* T3b — ack held PAST the unknown timer, push missed: unknown fires, the re-read settles it, the late ack is harmless */
    if (only('T3b')) {
      console.log('\n== T3b ack held 13s (past the 10s unknown timer) AND the push missed');
      const sid = await makeBound(B);
      const ctx = await browser.newContext();
      const page = await openTab(ctx, sid, mode, { dropAccountPush: true });
      let ackAt = 0;
      await page.route('**/api/sessions/*/account', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        const resp = await route.fetch(); await sleep(13000); ackAt = Date.now();
        await route.fulfill({ response: resp });
      });
      const clickAt = Date.now();
      await clickAccount(page, 'plan A');
      await sleep(500);
      const midState = await page.evaluate(() => ({ state: document.getElementById('acctSel')?.dataset.state, suffix: (document.getElementById('acctSelS')?.textContent || '').trim(), name: (document.getElementById('acctSelN')?.textContent || '').trim() }));
      if (mode === 'r2') await page.locator('#acctSel').screenshot({ path: path.join(ASSETS, 'BUG-255-r2-chip-requesting.png') });
      await sleep(9800);
      const unkState = await page.evaluate(() => ({ state: document.getElementById('acctSel')?.dataset.state, suffix: (document.getElementById('acctSelS')?.textContent || '').trim() }));
      const c = await waitChip(page, (t) => t === 'plan A', 3000);
      const chipAt = Date.now();
      for (let i = 0; i < 80 && !ackAt; i++) await sleep(100);
      await sleep(1500);
      const msgs = await said(page);
      const afterAck = await chip(page);
      const iSwitched = msgs.findIndex((m) => /switched to plan A/i.test(m));
      const held = page.__dropped > 0 && c === 'plan A' && afterAck === 'plan A' && bindingOf(sid) === A.id && msgs.some((m) => /unknown/i.test(m)) && iSwitched > -1 && iSwitched === msgs.length - 1 && !msgs.some((m) => refusalWords.test(m) && !/unknown/i.test(m));
      if (process.env.BUG255_DEBUG) console.log('T3b debug', { dropped: page.__dropped, gets: page.__gets });
      rec(mode, held, `[${mode}] T3b late ack after "unknown": settled to "plan A" by the re-read; the late ack changes nothing; no refusal`, { droppedPushes: page.__dropped ?? 0, midState, unkState, chipBeforeAck: c, msToChip: chipAt - clickAt, ackLandedAfterClickMs: ackAt ? ackAt - clickAt : 'never', chipAfterAck: afterAck, messages: msgs.filter((m) => /account|switch|unknown/i.test(m)) });
      R.T3b = held; await ctx.close();
    }

    /* T4 — a real refusal stays a refusal */
    if (only('T4')) {
      console.log('\n== T4 real refusal (unready account): shown as a refusal, indicator unchanged');
      const sid = await makeBound(B);
      const ctx = await browser.newContext();
      const page = await openTab(ctx, sid, mode);
      await clickAccount(page, 'plan C');
      await sleep(2500);
      const msgs = await said(page);
      const c = await chip(page);
      const bound = bindingOf(sid);
      const refused = msgs.some((m) => !/unknown/i.test(m) && /plan C|not ready|log ?in|sign|credential|account/i.test(m) && !/switched to/i.test(m) && !/switching/i.test(m));
      const held = bound === B.id && c === 'plan B' && refused && !msgs.some((m) => /unknown/i.test(m));
      rec(mode, held, `[${mode}] refusal of an unready account is a refusal with its reason; indicator stays "plan B"`, { binding: bound === B.id ? 'B' : bound, chip: c, messages: msgs.filter((m) => /account|switch|unknown|plan/i.test(m)) });
      R.T4 = held; await ctx.close();
    }

    /* T5 — a viewing tab sees a live switch made by another client */
    if (only('T5')) {
      console.log('\n== T5 viewing tab: another client resumes the session under B and live-switches it to A');
      const sid = await makeBound(B);
      const ctx = await browser.newContext();
      const page = await openTab(ctx, sid, mode);
      const before = await chip(page);
      const c = await openWs(port);
      let init5 = null;
      for (let i = 0; i < 30 && !init5; i++) {
        c.send({ type: 'start', projectId, resumeSessionId: sid, resumeEncodedDir: encodedDir, overrides: { model: 'haiku', permissionMode: 'bypassPermissions' }, prompt: 'again' });
        init5 = await waitEv(c.events, (e) => e.t === 'session-init', 6000); if (!init5) await sleep(1000);
      }
      if (init5?.sessionId !== sid) throw new Error(`T5 setup: resume did not hold ${sid}: ${JSON.stringify(init5 && { sessionId: init5.sessionId, account: init5.account, A: A.id, B: B.id })} events=${JSON.stringify(c.events.map((e) => e.t === "error" || e.t === "ack" ? e : e.t))}`);
      await waitEv(c.events, (e) => e.t === 'turn-end', 8000); await sleep(800);
      c.send({ type: 'switch-account', requestId: 'sw5', account: A.id });
      const ack = await waitEv(c.events, (e) => e.t === 'ack' && e.of === 'switch-account', 15000);
      c.close();
      const t0 = Date.now(); const after = await waitChip(page, (t) => t === 'plan A', 3000);
      const held = !!ack?.ok && bindingOf(sid) === A.id && after === 'plan A';
      rec(mode, held, `[${mode}] the viewing tab follows a live switch made elsewhere to "plan A" within 3s`, { before, ack: ack ? { ok: ack.ok, error: ack.error, account: ack.account === A.id ? 'A' : ack.account } : null, binding: bindingOf(sid) === A.id ? 'A' : bindingOf(sid), after, lagMs: after === 'plan A' ? Date.now() - t0 : '>3000' });
      R.T5 = held; await ctx.close();
    }
  }

  /* R — the ordering guard (plan review r2 #4): GET never bumps rev; the client's one writer drops an older fact */
  if (only('R')) {
    console.log('\n== R ordering: GET does not bump rev; a lower-rev fact arriving after a newer one is dropped');
    const sid = await makeBound(B);
    const g1 = (await (await fetch(`http://127.0.0.1:${port}/api/sessions/${sid}/account`)).json());
    const g2 = (await (await fetch(`http://127.0.0.1:${port}/api/sessions/${sid}/account`)).json());
    ok(g1.rev === g2.rev && g1.boot === g2.boot && g1.bound === B.id, 'two GETs return the same rev (a read is not a change)', { rev1: g1.rev, rev2: g2.rev, bound: g1.bound === B.id ? 'B' : g1.bound });
    const r = await jpost(port, `/api/sessions/${sid}/account`, { account: A.id, requestId: 'R-1', encodedDir, projectId });
    const g3 = (await (await fetch(`http://127.0.0.1:${port}/api/sessions/${sid}/account`)).json());
    ok(r.body?.ok === true && g3.rev > g1.rev && g3.bound === A.id && g3.last?.requestId === 'R-1' && g3.last?.outcome === 'switched', 'a switch bumps rev and records its outcome under the client requestId', { ok: r.body?.ok, rev: [g1.rev, g3.rev], last: g3.last && { requestId: g3.last.requestId, outcome: g3.last.outcome } });
    // The client's ONE writer, extracted from the real app.js and run on its own.
    const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    const fnSrc = appSrc.slice(appSrc.indexOf('function acceptAccountFact('), appSrc.indexOf('\n}\n', appSrc.indexOf('function acceptAccountFact(')) + 2);
    // BUG-255 r3 — the writer reads the module's highest-boot-seen; give the extracted copy its own.
    const accept = new Function('sessionAccounts', `let accountFactMaxBoot = 0; ${fnSrc}; return acceptAccountFact;`)(new Map());
    const newer = { ...g3 }; const older = { ...g1 };
    const a1 = accept(newer); const a2 = accept(older); const a3 = accept({ ...g1, boot: g1.boot + 1, rev: 0 });
    const a4 = accept({ ...g3, boot: g1.boot, rev: g3.rev + 100 }); // a LATE fact from the OLD boot, however high its rev
    ok(a1 === true && a2 === false && a3 === true && a4 === false, 'client writer: newer accepted, a LATE older fact dropped, a NEWER boot accepted at rev 0, an OLDER-boot fact never wins (total order)', { newer: a1, lateOlder: a2, newBoot: a3, oldBootLate: a4 });
  }

  await runAll('r2');
  if (preApp) {
    await runAll('r1');
    console.log('\n== must-FAIL grading (r1 client must break the property on the two-break paths)');
    for (const t of ['T1', 'T2', 'T2b', 'T3', 'T3b', 'T5'].filter(only)) ok(results.r1[t] === false, `must-FAIL: r1 client breaks ${t}`, { r1held: results.r1[t], r2held: results.r2[t] });
    if (only('T4')) ok(results.r1.T4 === true || results.r1.T4 === false, 'T4 on r1 recorded (control; a refusal was already a refusal in r1)', { r1held: results.r1.T4 });
  } else {
    console.log(`\n(must-FAIL half SKIPPED: no r1 client at ${PRE})`);
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
  await browser.close(); browser = null;
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
