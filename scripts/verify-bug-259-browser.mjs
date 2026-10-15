#!/usr/bin/env node
/**
 * verify-bug-259-browser.mjs — the user's view of BUG-259 in a real headless
 * browser against an ISOLATED scratch server (free port, scratch data/store, a
 * byte-for-byte COPY of the real board with its many Needs-You rows). Port 4317
 * and the live board are never touched; every process is killed by pid.
 *
 *   A. the board copy carries the real 2026-10-14 migration (agent-owned cards)
 *      plus one hard-stop card filed here; the digest's Needs-You list drops the
 *      owned ones and names them under "Agents decided these themselves".
 *   B. the owned ticket's history reads "Decided by an agent, not by you" with a
 *      Reopen button; the hard-stop card shows "Why this is yours".
 *   C. the user clicks Reopen: the card is back on the rail as a live Decide card
 *      with its original question, and an agent cannot own it again. (The scratch
 *      server classifies callers against ITS OWN sessions, so this browser counts as
 *      the user; an agent-session refusal is FEAT-164's requireUserCaller, wired in
 *      the route before the write — checked statically by the CLI suite, R6.)
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import { parseTicket, TICKET_FILE_RE } from './lib/ticket-schema.mjs';
import { ticketAnswerState } from '../src/server/board.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const REAL_BUGS = path.join(ROOT, 'docs', 'bugs');
const BRAVE = process.env.VERIFY_BROWSER ?? 'brave';
const SHOTDIR = '/tmp/iv-orchard/bug-259';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0; const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
}

const procs = new Set();
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}
async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
  static async connect(u) {
    const ws = new WebSocket(u, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const c = new Cdp(ws);
    ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && c.waiting.has(m.id)) { const { res, rej } = c.waiting.get(m.id); c.waiting.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } });
    return c;
  }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.waiting.set(id, { res, rej })); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result?.value; }
  async waitFor(expr, ms = 20000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await this.eval(expr)) return true; } catch { /* mid-nav */ } await sleep(150); } return false; }
  async shot(file) { const r = await this.send('Page.captureScreenshot', { format: 'png' }); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); return file; }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

const tool = (WORK, ...args) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'board-tool.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ORCHARD_BOARD_TOOL_ROOT: WORK } });
  try { return JSON.parse(r.stdout); } catch { return { ok: false, raw: (r.stdout + r.stderr).slice(0, 300) }; }
};

async function main() {
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'b259-data-'));
  const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'b259-store-'));
  const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'b259-prof-'));
  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'b259-proj-'));
  fs.mkdirSync(path.join(WORK, 'docs'), { recursive: true });
  fs.cpSync(REAL_BUGS, path.join(WORK, 'docs', 'bugs'), { recursive: true });
  const A = '--author=worker (BUG-259 browser demo)';
  // The real board already carries the 2026-10-14 migration (`own` on the agent-owned
  // cards), so the copy IS the busy, realistic state: many owned cards, 4 left to you.
  const ownedNow = (id) => /\*\*Decided by agent \(own\):\*\*/.test(fs.readFileSync(path.join(WORK, 'docs', 'bugs', fs.readdirSync(path.join(WORK, 'docs', 'bugs')).find((f) => f.startsWith(`${id}-`))), 'utf8'));
  ok('setup: the real board copy carries owned cards (BUG-121, FEAT-087, FEAT-135)', ['BUG-121', 'FEAT-087', 'FEAT-135'].every(ownedNow));
  const st = tool(WORK, 'decide', '--id=BUG-259', '--question=Restart the service now to load the reopen route?', '--option=A=Restart now | the route goes live | you can reopen today | your running sessions end | it interrupts work', '--option=B=Wait for a quiet moment | nothing changes yet | no interruption | reopen waits | it delays the feature', '--decider=live', '--consequence=restarting the service ends every running session, including yours', A);
  ok('setup: one real hard-stop card filed (live)', st.ok, st.refusal ?? '');

  const srv = spawn(process.execPath, [ENTRY], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE, CLAUDE_STATION_SURVIVE: '0' }, stdio: ['ignore', 'ignore', 'pipe'] });
  procs.add(srv);
  let up = false;
  for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { await sleep(200); } }
  if (!up) throw new Error('scratch server never healthy');
  const reg = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: WORK, name: 'BUG-259 scratch' }) })).json();
  const pid = reg.project.id;

  const browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0', '--no-first-run', '--disable-extensions', '--window-size=1440,950', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  procs.add(browser);
  let devPort = 0;
  for (let i = 0; i < 80 && !devPort; i++) { try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); } }
  if (!devPort) throw new Error('browser never wrote DevToolsActivePort');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
  const go = async (hash, ready) => {
    await cdp.send('Page.navigate', { url: 'about:blank' });
    await cdp.send('Page.navigate', { url: `${BASE}/${hash}${hash.includes('?') ? '&' : '?'}project=${encodeURIComponent(pid)}` });
    await cdp.waitFor(ready); await sleep(700);
  };

  console.log('\nA. digest over the busy board copy');
  await go('#/tickets', `!!document.querySelector('.dg-awaiting')`);
  const dg = await cdp.eval(`(() => ({
    awaiting: [...document.querySelectorAll('.dg-awaiting .dg-group:not(.dg-agent-decided .dg-group) [data-id]')].map((a) => a.dataset.id),
    decidedHead: document.querySelector('.dg-agent-decided summary')?.textContent ?? '',
    decided: [...document.querySelectorAll('.dg-agent-decided-item')].map((a) => a.dataset.id) }))()`);
  ok('A owned cards are not in the Needs-You list', !['BUG-121', 'FEAT-087', 'FEAT-135'].some((id) => dg.awaiting.includes(id)), dg.awaiting.length);
  ok('A the hard-stop card is in the Needs-You list', dg.awaiting.includes('BUG-259'));
  ok('A "Agents decided these themselves" names the owned record cards', dg.decided.includes('BUG-121') && dg.decided.includes('FEAT-087') && dg.decided.length >= 10, dg.decided.length);
  console.log(`        needs-you rows: ${dg.awaiting.length}; agent-decided: ${dg.decided.join(', ')}`);
  await cdp.eval(`document.querySelector('.dg-agent-decided').open = true; document.querySelector('.dg-agent-decided').scrollIntoView()`);
  console.log(`        screenshot: ${await cdp.shot(path.join(SHOTDIR, 'A-digest.png'))}`);

  console.log('\nB. the owned ticket, and the hard-stop card');
  await go('#/tickets/BUG-121', `!!document.querySelector('.tvh-owned')`);
  const tb = await cdp.eval(`(() => ({ by: document.querySelector('.tvh-owned-by')?.textContent ?? '', btn: !!document.querySelector('.tvh-reopen button'), decide: !!document.querySelector('#tvDetail .tv-decide') }))()`);
  ok('B history reads "Decided by an agent, not by you" with the author', /Decided by an agent, not by you.*worker \(BUG-259 fixing r1\)/.test(tb.by), tb.by);
  ok('B a Reopen button is offered, and no live Decide card', tb.btn && !tb.decide, tb);
  await cdp.eval(`document.querySelector('.tvh-owned').scrollIntoView({block:'center'})`);
  console.log(`        screenshot: ${await cdp.shot(path.join(SHOTDIR, 'B-owned-ticket.png'))}`);
  await go('#/tickets/FEAT-135', `!!document.querySelector('.tvh-reopen') || !!document.querySelector('#tvDetail h1')`);
  ok('B the legacy owned ticket also offers Reopen', await cdp.eval(`!!document.querySelector('.tvh-reopen button')`));
  await go('#/tickets/BUG-259', `!!document.querySelector('#tvDetail .tv-decide')`);
  const stop = await cdp.eval(`document.querySelector('#tvDetail .dc-stop')?.textContent ?? ''`);
  ok('B the hard-stop card says why it is yours', /Why this is yours: live — restarting the service ends every running session/.test(stop), stop);
  await cdp.eval(`document.querySelector('#tvDetail .tv-decide').scrollIntoView({block:'start'})`);
  console.log(`        screenshot: ${await cdp.shot(path.join(SHOTDIR, 'B-stop-card.png'))}`);

  console.log('\nC. the user clicks Reopen (this browser is outside the scratch server\'s sessions, so the user-only route classifies it as the user)');
  await go('#/tickets/BUG-121', `!!document.querySelector('.tvh-reopen button')`);
  await cdp.eval(`document.querySelector('.tvh-reopen button').click()`);
  await cdp.waitFor(`!!document.querySelector('#tvDetail .tv-decide')`, 10000);
  await sleep(500);
  const after = await cdp.eval(`(() => ({ decide: !!document.querySelector('#tvDetail .tv-decide'), q: document.querySelector('#tvDetail .dc-q')?.textContent ?? '', reopened: [...document.querySelectorAll('.tvh-when')].some((n) => /You reopened it/.test(n.textContent)) }))()`);
  const brd = await (await fetch(`${BASE}/api/projects/${encodeURIComponent(pid)}/board`)).json();
  ok('C the decision is back as a live Decide card with its original question', after.decide && /record block/i.test(after.q), after);
  ok('C the history says you reopened it', after.reopened);
  ok('C BUG-121 is back on the Needs-You rail', brd.needsYou.some((i) => i.id === 'BUG-121'));
  ok('C …and has left "Agents decided"', !(brd.agentDecided ?? []).some((d) => d.id === 'BUG-121' && !d.reopened));
  const again = tool(WORK, 'own', '--id=BUG-121', '--basis=judgement', '--chose=B', '--why=Again.', A);
  ok('C an agent cannot own it again after your reopen', !again.ok && again.refusal?.code === 'reopened-by-user', again.refusal ?? again);
  console.log(`        screenshot: ${await cdp.shot(path.join(SHOTDIR, 'C-reopened.png'))}`);

  cdp.close();
  for (const p of procs) stopByPid(p);
  await sleep(500);
  for (const d of [DATA, STORE, PROFILE, WORK]) fs.rmSync(d, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); for (const p of procs) stopByPid(p); process.exit(1); });
