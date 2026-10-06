#!/usr/bin/env node
/**
 * verify-feat-166-typed-answer-browser.mjs — FEAT-166 round 3, the user's reality:
 * the Decide card and the Needs-You rail write a TYPED answer, the card shows it as
 * answered, a re-declaration shows pending, and a pre-r3 (frozen) answer still shows.
 *
 * Playwright driving headless Brave against an ISOLATED scratch server: free
 * ephemeral port, scratch data/store dirs, project = a full COPY of the real board
 * (busy state: every ticket, the real INDEX, the real frozen snapshot). Port 4317
 * and the live board are never touched; the server is killed by pid.
 *
 * Run: node scripts/verify-feat-166-typed-answer-browser.mjs   (VERIFY_BROWSER=brave)
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { parseTicket, TICKET_FILE_RE } from './lib/ticket-schema.mjs';
import { ticketAnswerState, ticketFile } from '../src/server/board.ts';
import { loadAnswerFrozen } from './lib/answer-source.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const BRAVE = process.env.VERIFY_BROWSER_PATH ?? spawnSync('sh', ['-c', `command -v ${process.env.VERIFY_BROWSER ?? 'brave'}`], { encoding: 'utf8' }).stdout.trim();
const SHOTS = '/tmp/iv-orchard/feat-166-r3';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0; const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
}
async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const DATA = tmp('f166r3-data-'), STORE = tmp('f166r3-store-'), WORK = tmp('f166r3-proj-');
const BUGS = path.join(WORK, 'docs', 'bugs');
fs.mkdirSync(path.dirname(BUGS), { recursive: true });
fs.cpSync(path.join(ROOT, 'docs', 'bugs'), BUGS, { recursive: true });

const index = fs.readFileSync(path.join(BUGS, 'INDEX.md'), 'utf8');
const openSec = index.split(/^## /m).find((s) => /^open/i.test(s)) ?? '';
const open = new Set(openSec.split('\n').map((l) => (l.match(/^\| ([A-Z]+-\d+) \|/) || [])[1]).filter(Boolean));
const all = fs.readdirSync(BUGS).filter((f) => TICKET_FILE_RE.test(f)).map((f) => {
  const text = fs.readFileSync(path.join(BUGS, f), 'utf8');
  return { id: f.match(/^[A-Z]+-\d+/)[0], f, text, p: parseTicket(text, { file: f, mode: 'auto' }) };
});
const decidable = (x) => x.p.format === 'block' && x.p.record && open.has(x.id) && !['done', 'not_a_bug', 'verified'].includes(x.p.record.work_state);
const pool = all.filter((x) => decidable(x) && x.p.record.decision === null && !ticketAnswerState(x.text, path.join(BUGS, x.f)) && !['FEAT-164', 'FEAT-166', 'BUG-230'].includes(x.id));
const frozen = loadAnswerFrozen(BUGS).tickets;
const frozenCard = all.find((x) => x.p.format === 'block' && x.p.record?.decision && frozen[x.id]?.state);
const [T1, T2] = pool.map((x) => x.id);
console.log(`  (busy copy: ${all.length} tickets, ${open.size} open; card=${T1} rail=${T2} frozen-card=${frozenCard?.id})`);

const decide = (id, q, extra = []) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/board-tool.mjs'), 'decide', '--id', id, '--question', q,
  '--option', 'A=Keep it as is | Nothing changes | No new surface | Friction stays | It is the status quo',
  '--option', 'B=Change it | The new behaviour ships | Less friction | A new surface | It costs a migration',
  '--recommend', 'B', '--why', 'It removes the friction.', '--author', 'worker (fixing r3 test)', ...extra],
{ cwd: ROOT, encoding: 'utf8', env: { ...process.env, ORCHARD_BOARD_TOOL_ROOT: WORK } });
const recordOf = (id) => parseTicket(fs.readFileSync(ticketFile(BUGS, id), 'utf8'), { mode: 'auto' }).record;

const srv = spawn(process.execPath, [path.join(ROOT, 'src/server/index.ts')], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE, CLAUDE_STATION_SURVIVE: '0' }, stdio: ['ignore', 'ignore', 'pipe'],
});
let browser = null;
try {
  let up = false;
  for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { await sleep(200); } }
  if (!up) throw new Error('scratch server never healthy');
  const reg = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: WORK, name: 'FEAT-166 r3 scratch' }) })).json();
  const pid = reg.project.id;
  browser = await chromium.launch({ executablePath: BRAVE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const openTicket = async (id) => {
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/tickets/${id}?project=${encodeURIComponent(pid)}`);
    await page.waitForSelector('#tvDetail .tv-decide, #tvDetail h1', { timeout: 20000 });
    await sleep(500);
    return page.locator('#tvDetail .tv-decide');
  };

  console.log(`\nD1. Decide card answer flow (${T1})`);
  ok('decide exited 0', decide(T1, 'Should the friction stay?').status === 0);
  let card = await openTicket(T1);
  ok('card pending', (await card.getAttribute('data-state')) === 'pending');
  await card.locator('.dc-opt input[value="B"]').check();
  await card.locator('.dc-send:not(.dc-followup-send)').click();
  await page.waitForFunction(() => document.querySelector('#tvDetail .tv-decide')?.dataset.state === 'answered', null, { timeout: 15000 }).catch(() => {});
  card = page.locator('#tvDetail .tv-decide');
  const st1 = await card.getAttribute('data-state');
  const pick = await card.locator('.dc-answered .dc-k').first().textContent().catch(() => null);
  ok('card flips to answered showing B', st1 === 'answered' && pick === 'B', { st1, pick });
  await page.screenshot({ path: path.join(SHOTS, `D1-${T1}-answered.png`) });
  const typed = recordOf(T1).decision.answers ?? [];
  ok('the record holds ONE typed answer: B, by user, recorded_by server, via ticket view', typed.length === 1 && typed[0].chose?.key === 'B'
    && typed[0].by === 'user' && typed[0].recorded_by === 'server' && typed[0].via === 'ticket view', typed);
  const api1 = await (await fetch(`${BASE}/api/projects/${encodeURIComponent(pid)}/tickets/${T1}`)).json();
  ok('ticket API answer = B, awaiting', api1.answer?.chose?.key === 'B' && api1.answer?.awaiting === true, api1.answer);
  card = await openTicket(T1);
  ok('after a reload the card is still answered B', (await card.getAttribute('data-state')) === 'answered');

  console.log(`\nD2. Re-decide → pending (${T1})`);
  ok('decide (re-declare) exited 0', decide(T1, 'A new question about the friction?').status === 0);
  card = await openTicket(T1);
  const st2 = await card.getAttribute('data-state');
  const q2 = (await card.locator('.dc-q').textContent())?.trim();
  ok('card PENDING with the new question', st2 === 'pending' && q2 === 'A new question about the friction?', { st2, q2 });
  await page.screenshot({ path: path.join(SHOTS, `D2-${T1}-redecided.png`) });

  console.log(`\nD3. A pre-r3 (frozen) answer still shows (${frozenCard?.id})`);
  if (frozenCard) {
    card = await openTicket(frozenCard.id);
    const st3 = await card.getAttribute('data-state');
    const note3 = (await card.locator('.dc-note-ro').first().textContent().catch(() => ''))?.trim();
    ok('frozen-answered ticket: card answered with the user\'s original words', st3 === 'answered' && note3 === frozen[frozenCard.id].state.note, { st3, note3: note3?.slice(0, 60) });
    await page.screenshot({ path: path.join(SHOTS, `D3-${frozenCard.id}-frozen.png`) });
  } else ok('a frozen-answered record ticket with a decision exists', false);

  console.log(`\nD4. Needs-You rail answer (${T2})`);
  ok('decide exited 0', decide(T2, 'Rail: should the friction stay?').status === 0);
  const noKey = await fetch(`${BASE}/api/projects/${encodeURIComponent(pid)}/board/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: T2, answer: 'no key' }) });
  ok('a rail POST naming no decision is refused 409 and writes nothing', noKey.status === 409 && !(recordOf(T2).decision.answers ?? []).length, noKey.status);
  await page.goto(`${BASE}/#/project/${pid}`);
  await page.waitForSelector('#rail, .needs-card', { timeout: 20000 }).catch(() => {});
  await page.evaluate(() => window.__station?.refreshRail?.(true)).catch(() => {});
  // The rail is the board grid (FEAT-153): clicking an answerable needs-you tile
  // mounts its needs-card (the Needs-You answer flow) at the top of the rail.
  const tile = page.locator(`button.tc[data-id="${T2}"]`).first();
  const tileUp = await tile.waitFor({ state: 'attached', timeout: 20000 }).then(() => true).catch(() => false);
  if (tileUp) { await tile.scrollIntoViewIfNeeded(); await tile.click(); }
  const railCard = page.locator(`.needs-card[data-id="${T2}"]`);
  const seen = tileUp && await railCard.first().waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
  ok('clicking the rail tile opens its Needs-You answer card', seen, { tileUp });
  if (seen) {
    await railCard.first().locator('.nc-input').fill('keep it, via the rail');
    await railCard.first().locator('.nc-send').click();
    let n = 0;
    for (let i = 0; i < 50 && !n; i++) { await sleep(200); n = (recordOf(T2).decision.answers ?? []).length; }
    const a = recordOf(T2).decision.answers ?? [];
    ok('rail click writes ONE typed answer (via Needs-You rail, by user)', a.length === 1 && a[0].via === 'Needs-You rail' && a[0].by === 'user' && a[0].note === 'keep it, via the rail', a);
    const b = await (await fetch(`${BASE}/api/projects/${encodeURIComponent(pid)}/board`)).json();
    ok('board API: it left needs-you and sits in the answered lane', !b.needsYou.some((i) => i.id === T2) && (b.answeredAwaiting ?? []).some((i) => i.id === T2 && i.answer === 'keep it, via the rail'));
    await page.screenshot({ path: path.join(SHOTS, `D4-${T2}-rail.png`) });
  }
} catch (e) {
  failures.push(`harness: ${e.message}`); console.log(`  FAIL  harness — ${e.stack}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  try { process.kill(srv.pid, 'SIGTERM'); } catch { /* gone */ }
  await sleep(500);
  try { process.kill(srv.pid, 'SIGKILL'); } catch { /* gone */ }
  for (const d of [DATA, STORE, WORK]) fs.rmSync(d, { recursive: true, force: true });
}
console.log(`\n${failures.length ? 'FAIL' : 'PASS'} — ${pass} passed, ${failures.length} failed (screens: ${SHOTS})`);
process.exit(failures.length ? 1 : 0);
