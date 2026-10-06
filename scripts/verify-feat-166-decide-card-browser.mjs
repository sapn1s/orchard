#!/usr/bin/env node
/**
 * verify-feat-166-decide-card-browser.mjs — the user's view of `board-tool decide`
 * (FEAT-166), in a real headless browser against an ISOLATED scratch server.
 *
 * Busy-state fixture: the scratch project's board is a byte-for-byte COPY of the
 * REAL docs/bugs (every ticket, the real INDEX with its many needs-you rows), not
 * a minimal one. The live board and port 4317 are never touched: the server runs
 * on a free ephemeral port with scratch data/store dirs, killed by pid.
 *
 * Legs (tickets discovered at runtime, never named):
 *   A. BEFORE: an open record ticket with no decision shows NO Decide card — the
 *      state FEAT-164 was in while its options sat in the Activity log.
 *   B. AFTER `decide` via the CLI: the ticket page shows the Decide card, pending,
 *      with the declared question, three option rows and B tagged Recommended;
 *      the board API puts it on the needs-you rail.
 *   C. RE-DECISION on a ticket the user answered before: the card is PENDING with
 *      the new question, not the old answer's read-only reading.
 *
 * Run: node scripts/verify-feat-166-decide-card-browser.mjs   (VERIFY_BROWSER=brave)
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
const SHOTDIR = '/tmp/iv-orchard/feat-166';
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

const QUESTION = 'Which grant length should the git-write control offer per project?';
const OPTS = [
  'A=Keep the timed grant only | Nothing changes; agents keep re-asking every thirty minutes | No new trust surface at all | The user re-grants all day in a trusted project | It is the status quo the user asked to leave',
  'B=Permanent grant per project | A revocable per-project setting the one grant check reads | One decision per project instead of one per half hour | A planted setting is a new path to defend | Persisted trust is what the store avoided on purpose',
  'C=Longer timed grant | Offer eight hours next to thirty minutes | Cuts the re-grant count without persisting anything | Still lapses mid-task on a long day | It halves the problem rather than removing it',
];

const CARD = `(() => {
  const c = document.querySelector('#tvDetail .tv-decide');
  if (!c) return { card: false, detail: !!document.querySelector('#tvDetail .tv-doc, #tvDetail h1') };
  return { card: true, state: c.dataset.state, q: c.querySelector('.dc-q')?.textContent ?? '',
    keys: [...c.querySelectorAll('.dc-opt')].map((o) => o.querySelector('input')?.value ?? ''),
    rec: [...c.querySelectorAll('.dc-opt.is-rec')].map((o) => o.querySelector('input')?.value ?? '') };
})()`;

async function main() {
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'f166-data-'));
  const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'f166-store-'));
  const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'f166-prof-'));
  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'f166-proj-'));
  const BUGS = path.join(WORK, 'docs', 'bugs');
  fs.mkdirSync(path.join(WORK, 'docs'), { recursive: true });
  fs.cpSync(REAL_BUGS, BUGS, { recursive: true });

  const index = fs.readFileSync(path.join(BUGS, 'INDEX.md'), 'utf8');
  const openSec = index.split(/^## /m).find((s) => /^open/i.test(s)) ?? '';
  const open = new Set(openSec.split('\n').map((l) => (l.match(/^\| ([A-Z]+-\d+) \|/) || [])[1]).filter(Boolean));
  const all = fs.readdirSync(BUGS).filter((f) => TICKET_FILE_RE.test(f)).map((f) => {
    const text = fs.readFileSync(path.join(BUGS, f), 'utf8');
    return { id: f.match(/^[A-Z]+-\d+/)[0], f, text, p: parseTicket(text, { file: f, mode: 'auto' }) };
  });
  const rec = (x) => x.p.format === 'block' && x.p.record && open.has(x.id) && !['done', 'verified'].includes(x.p.record.work_state);
  const fresh = all.find((x) => rec(x) && x.p.record.decision === null && !ticketAnswerState(x.text, path.join(BUGS, x.f)) && !['FEAT-164', 'BUG-230', 'FEAT-166'].includes(x.id));
  const answered = all.find((x) => rec(x) && x.id !== fresh?.id && ticketAnswerState(x.text, path.join(BUGS, x.f))?.kind === 'decision');
  if (!fresh || !answered) { console.log('STOP — real board has no qualifying tickets'); process.exit(1); }
  console.log(`  (busy board copy: ${all.length} tickets, ${open.size} open rows; fresh=${fresh.id} answered-before=${answered.id})`);
  const decide = (id) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'board-tool.mjs'), 'decide', '--id', id, '--question', QUESTION,
    ...OPTS.flatMap((o) => ['--option', o]), '--recommend', 'B', '--why', 'B removes the half-hourly prompt while staying revocable.', '--author', 'worker (fixing r1)'],
  { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ORCHARD_BOARD_TOOL_ROOT: WORK } });

  const srv = spawn(process.execPath, [ENTRY], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE, CLAUDE_STATION_SURVIVE: '0' }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  procs.add(srv);
  let up = false;
  for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { await sleep(200); } }
  if (!up) throw new Error('scratch server never healthy');
  const reg = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: WORK, name: 'FEAT-166 scratch' }) })).json();
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

  const view = async (id, tag) => {
    await cdp.send('Page.navigate', { url: 'about:blank' });
    await cdp.send('Page.navigate', { url: `${BASE}/#/tickets/${id}?project=${encodeURIComponent(pid)}` });
    await cdp.waitFor(`!!document.querySelector('#tvDetail .tv-decide') || !!document.querySelector('#tvDetail h1, #tvDetail .tv-doc')`);
    await sleep(600);
    const c = await cdp.eval(CARD);
    const shot = await cdp.shot(path.join(SHOTDIR, `${tag}.png`));
    return { c, shot };
  };

  console.log('\nA. BEFORE decide — prose-only state (what the user saw on FEAT-164)');
  const a = await view(fresh.id, `A-${fresh.id}-before`);
  ok(`${fresh.id}: ticket page rendered, and NO Decide card`, a.c.card === false && a.c.detail === true, a.c);

  console.log('\nB. AFTER board-tool decide (CLI, space-separated, repeated --option)');
  const r = decide(fresh.id);
  ok('decide exited 0', r.status === 0, (r.stdout || r.stderr).slice(0, 300));
  const b = await view(fresh.id, `B-${fresh.id}-after`);
  ok(`${fresh.id}: Decide card shown, pending`, b.c.card === true && b.c.state === 'pending', b.c);
  ok(`${fresh.id}: card question is the declared one`, b.c.q === QUESTION, b.c.q);
  ok(`${fresh.id}: option rows A,B,C`, JSON.stringify(b.c.keys) === '["A","B","C"]', b.c.keys);
  ok(`${fresh.id}: B tagged Recommended`, JSON.stringify(b.c.rec) === '["B"]', b.c.rec);
  const board = await (await fetch(`${BASE}/api/projects/${encodeURIComponent(pid)}/board`)).json().catch(() => null);
  const item = board?.needsYou?.find((i) => i.id === fresh.id);
  ok(`${fresh.id}: board API lists it on the needs-you rail with the question`, !!item && item.question === QUESTION, item ?? Object.keys(board ?? {}));
  console.log(`        screenshot: ${b.shot}`);

  console.log('\nC. RE-DECISION on a ticket the user answered before');
  const c0 = await view(answered.id, `C-${answered.id}-before`);
  console.log(`        before: ${JSON.stringify(c0.c).slice(0, 160)}`);
  const r2 = decide(answered.id);
  ok('decide exited 0', r2.status === 0, (r2.stdout || r2.stderr).slice(0, 300));
  const c1 = await view(answered.id, `C-${answered.id}-after`);
  ok(`${answered.id}: card is PENDING with the new question (not the old answer)`, c1.c.card === true && c1.c.state === 'pending' && c1.c.q === QUESTION, c1.c);
  console.log(`        screenshot: ${c1.shot}`);

  cdp.close();
  for (const p of procs) stopByPid(p);
  await sleep(500);
  for (const d of [DATA, STORE, PROFILE, WORK]) fs.rmSync(d, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); for (const p of procs) stopByPid(p); process.exit(1); });
