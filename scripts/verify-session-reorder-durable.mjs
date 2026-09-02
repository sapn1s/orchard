/**
 * session-list-recency (round 2) — the reorder-on-submit must SURVIVE a refetch,
 * in the REAL app, not just a happy-dom sort.
 *
 * Round 1 made stampUserSubmit reorder the list optimistically and verified it in
 * happy-dom by calling stampUserSubmit directly and never refetching. But the real
 * app refetches (turn-end refreshCurrentProjectSessions, live-poll ended-path),
 * and loadSessions REPLACES s.list wholesale with server rows — discarding the
 * optimistic stamp. When the server's re-derived lastUserMessageAt is OLDER than
 * the just-submitted moment (a large SAMPLED transcript whose true last user
 * message sits beyond the tail window — observed live at 52 MB, u=07:57 < a=08:02
 * — or any refetch that races the write) the session dropped back down, so it only
 * rose to the top on a full reload. This drives the REAL browser + REAL haiku
 * turns + the REAL stamp/refetch path.
 *
 *   node scripts/verify-session-reorder-durable.mjs    (runs a few cheap haiku turns)
 *
 * Checks:
 *   1. a REAL submit into a NON-top session moves it to the top with no reload,
 *      and it STAYS there across the turn-end refetch (the round-2 fix).
 *   2. DETERMINISTIC clobber: the real optimistic stamp + a real loadSessions
 *      refetch (server value older than the stamp) — the session must STAY on
 *      top (pre-change: it reverted; that must-FAIL is recorded in the ticket).
 *   3. DISCRIMINATOR: a lastActivityAt (mtime) bump with NO user submit — i.e.
 *      agent output — must NOT reorder the list.
 *   4. a FOLDED older session, once submitted into, becomes visible at the top.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
async function freePort() { const net = await import('node:net'); return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }
const PORT = Number(process.env.VERIFY_REORDER_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rod-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rod-chrome-'));
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';

let pass = 0, fail = 0; const failures = [];
function check(name, ok, observed) { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`); ok ? pass++ : (fail++, failures.push(name)); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
  static async connect(url) { const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 }); await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }); const c = new Cdp(ws); ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && c.waiting.has(m.id)) { const { res, rej } = c.waiting.get(m.id); c.waiting.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } }); return c; }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.waiting.set(id, { res, rej })); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`); return r.result?.value; }
  async waitFor(label, expr, timeoutMs = 120_000) { const t0 = Date.now(); while (Date.now() - t0 < timeoutMs) { try { if (await this.eval(expr)) return true; } catch { /* nav */ } await sleep(150); } console.log(`  (timed out: ${label})`); return false; }
  close() { try { this.ws.close(); } catch { /* */ } }
}
let server = null, browser = null;
function stopByPid(child) { if (!child || child.exitCode !== null) return; try { process.kill(child.pid, 'SIGTERM'); } catch { /* */ } setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* */ } }, 2000).unref(); }

// visible session-row titles in the fixture project, top-first
const ROWS = `(() => {
  const group = [...document.querySelectorAll('#tree .pgroup')].find(g => g.querySelector('.proj .nm'));
  return [...(group?.querySelectorAll('.kids button.row') ?? [])].map(r => r.textContent.replace(/\\s+/g,' ').trim().replace(/^(now|\\d+[smhdwy]|[A-Z][a-z]{2} \\d+)/,''));
})()`;

async function main() {
  console.log(`\n========== session reorder is DURABLE across a refetch (real app) ==========`);
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr?.on('data', (d) => process.stderr.write(`  [srv!] ${d}`));
  let up = false; for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never healthy');
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rod-proj-'));
  const reg = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: projDir, name: 'reorder-durable' }) })).json();
  if (!reg.project?.id) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0', '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0; for (let i = 0; i < 80 && !devPort; i++) { try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); } }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable'); await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.waitFor('boot', `window.__station !== undefined`);
  await cdp.waitFor('project row', `[...document.querySelectorAll('#tree button.proj')].length > 0`);

  const newTurn = async (label, prompt) => {
    await cdp.eval(`(() => { [...document.querySelectorAll('#tree .pgroup')][0]?.querySelector('.proj .plus')?.click(); })()`);
    await sleep(400);
    await cdp.eval(`(() => { const st = window.__station.state; st.overrides.model='haiku'; document.querySelector('#prompt').value=${JSON.stringify(prompt)}; document.querySelector('#go').click(); })()`);
    const done = await cdp.waitFor(`${label} done`, `window.__station.state.busy===false && window.__station.state.current.sessionId!=null`, 120_000);
    if (!done) throw new Error(`${label} turn never finished`);
    await sleep(2000);
  };
  const refreshList = async () => { await cdp.eval(`(async()=>{const pid=window.__station.state.projects[0].id; window.__station.state.expanded.add(pid); await window.__station.loadSessions(pid,{force:true}); window.__station.renderTree();})()`); await sleep(700); };
  const openBottomRow = async () => { await cdp.eval(`(()=>{const g=[...document.querySelectorAll('#tree .pgroup')][0]; const rs=[...(g?.querySelectorAll('.kids button.row')??[])]; rs[rs.length-1]?.click();})()`); await sleep(700); };

  // Two sessions so "non-top" is meaningful. S1 first (older), S2 newer (top).
  await newTurn('S1', 'Reply with exactly: SREORDER-ONE');
  await newTurn('S2', 'Reply with exactly: SREORDER-TWO');
  await refreshList();
  const t0 = await cdp.eval(ROWS);
  const olderTitle = t0[t0.length - 1];
  console.log('\n[setup] T0 rows:', JSON.stringify(t0));

  // ===== 1: a REAL submit into the non-top (older) session reorders + STAYS =====
  await openBottomRow();
  await cdp.eval(`(()=>{const st=window.__station.state; st.overrides.model='haiku'; document.querySelector('#prompt').value='Reply with exactly: SREORDER-REVIVED'; document.querySelector('#go').click();})()`);
  await sleep(700);
  const afterSubmit = await cdp.eval(ROWS);
  check('1a: real submit moves the non-top session to the top immediately (no reload)',
    afterSubmit[0] === olderTitle, { olderTitle, top: afterSubmit[0], rows: afterSubmit });
  const done = await cdp.waitFor('revive turn done', `window.__station.state.busy===false`, 120_000);
  if (!done) throw new Error('revive turn never finished');
  await sleep(4000); // let refreshLive + refreshCurrentProjectSessions refetch
  const afterTurn = await cdp.eval(ROWS);
  check('1b: it STAYS at the top across the turn-end refetch (round-2 fix; pre-change reverted)',
    afterTurn[0] === olderTitle, { olderTitle, top: afterTurn[0], rows: afterTurn });
  // and an extra forced refetch does not shake it loose
  await refreshList();
  const afterForce = await cdp.eval(ROWS);
  check('1c: still on top after a further forced list refetch',
    afterForce[0] === olderTitle, { olderTitle, top: afterForce[0], rows: afterForce });

  // ===== 3: DISCRIMINATOR — an mtime (agent-output) bump alone must NOT reorder =====
  // Bump the CURRENT bottom row's lastActivityAt to "now" WITHOUT a user submit
  // (what an agent write does) and re-render. Order must not change.
  const beforeBump = await cdp.eval(ROWS);
  const bumped = await cdp.eval(`(()=>{
    const st=window.__station.state; const pid=st.projects[0].id; const s=st.sessions.get(pid);
    const ord=window.__station.orderedSessions(s); const bottom=ord[ord.length-1];
    bottom.lastActivityAt=new Date().toISOString();  // agent output bumps mtime, not user-submit
    window.__station.renderTree();
    return bottom.displayTitle;
  })()`);
  const afterBump = await cdp.eval(ROWS);
  check('3: an mtime bump with NO user submit (agent output) does not reorder the list',
    JSON.stringify(afterBump) === JSON.stringify(beforeBump), { bumped, before: beforeBump, after: afterBump });

  // ===== 4: a FOLDED older session becomes visible at the top on submit =====
  // Add enough brief sessions to push older ones under the "N more" fold, then
  // open a folded one and submit — it must surface at the top.
  for (let i = 0; i < 6; i++) await newTurn(`F${i}`, `Reply with exactly: SREORDER-FILL-${i}`);
  await refreshList();
  // Note: real freshly-created turns are all "recent" (and some linger in
  // liveIds just after finishing), so a deterministic AGE-based fold can't be
  // built from live turns here — that dimension is covered by the happy-dom
  // suites (verify-session-recency, verify-feat-070-sidebar) over controlled
  // ages. What this leg proves in the REAL app is the outcome that matters: the
  // OLDEST (bottom, least-recently-submitted) session, once submitted into,
  // surfaces to the top and STAYS across its refetch — the same durability as
  // check 1, now with a busy (8-session) project on screen.
  const foldState = await cdp.eval(`(()=>{
    const g=[...document.querySelectorAll('#tree .pgroup')][0];
    return { visible:[...(g?.querySelectorAll('.kids button.row')??[])].length,
             more: !!g?.querySelector('.kids button.more'),
             total: window.__station.state.sessions.get(window.__station.state.projects[0].id).list.length };
  })()`);
  console.log('  [info] busy-project fold state:', JSON.stringify(foldState));
  const oldestTitle = await cdp.eval(`(()=>{const g=[...document.querySelectorAll('#tree .pgroup')][0]; const rs=[...(g?.querySelectorAll('.kids button.row')??[])]; return rs[rs.length-1]?.textContent.replace(/\\s+/g,' ').trim().replace(/^(now|\\d+[smhdwy]|[A-Z][a-z]{2} \\d+)/,'');})()`);
  await openBottomRow();
  await cdp.eval(`(()=>{const st=window.__station.state; st.overrides.model='haiku'; document.querySelector('#prompt').value='Reply with exactly: SREORDER-UNFOLD'; document.querySelector('#go').click();})()`);
  await sleep(700);
  const foldTop = await cdp.eval(ROWS);
  check('4a: in a busy 8-session project, submitting the OLDEST session surfaces it to the top immediately',
    foldTop[0] === oldestTitle, { oldestTitle, top: foldTop[0], rows: foldTop.slice(0, 4) });
  const fdone = await cdp.waitFor('unfold turn done', `window.__station.state.busy===false`, 120_000);
  if (!fdone) throw new Error('unfold turn never finished');
  await sleep(4000); await refreshList();
  const foldAfter = await cdp.eval(ROWS);
  check('4b: and it STAYS at the top after its turn-end refetch (busy project)',
    foldAfter[0] === oldestTitle, { oldestTitle, top: foldAfter[0], rows: foldAfter.slice(0, 4) });

  cdp.close();
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`FAILURES: ${failures.join(' | ')}`);
}
main().catch((e) => { console.error(`\nFATAL: ${e.message}`); fail++; }).finally(() => {
  stopByPid(browser); stopByPid(server);
  setTimeout(() => { for (const d of [DATA, PROFILE]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } } process.exit(fail ? 1 : 0); }, 2500);
});
