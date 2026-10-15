#!/usr/bin/env node
/**
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

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'bug255ui-'));
const HOME = path.join(SCRATCH, 'home'); const DATA = path.join(SCRATCH, 'data'); const STORE = path.join(SCRATCH, 'store'); const WORK = path.join(SCRATCH, 'work');
fs.mkdirSync(path.join(HOME, '.claude', 'projects'), { recursive: true }); fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(STORE, { recursive: true }); fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(path.join(HOME, '.claude', 'settings.json'), JSON.stringify({ cleanupPeriodDays: 36500 }) + '\n');
delete process.env.CLAUDE_CONFIG_DIR; process.env.HOME = HOME; process.env.CLAUDE_STATION_DATA = DATA; process.env.CLAUDE_PROJECTS_DIR = STORE;

const FAKE = path.join(WORK, 'fake-claude.mjs');
fs.writeFileSync(FAKE, `
import * as readline from 'node:readline';
import { randomUUID } from 'node:crypto';
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const ri = process.argv.indexOf('--resume'); const sid = ri > -1 ? process.argv[ri+1] : randomUUID();
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
  const mk = (label) => { const row = accts.createAccount(label); const reg = JSON.parse(fs.readFileSync(accountsFile, 'utf8')); for (const r of reg.accounts) if (r.id === row.id) r.state = 'ready'; fs.writeFileSync(accountsFile, JSON.stringify(reg, null, 2) + '\n'); fs.writeFileSync(path.join(accts.resolveAccountDir(row.id), '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'stub' } }) + '\n'); return row; };
  const A = mk('plan A'); const B = mk('plan B');

  const port = await freePort();
  server = spawn(process.execPath, [ENTRY], { cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE, HOME, CLAUDE_STATION_CLAUDE_BIN: FAKE, CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0', CLAUDE_STATION_SURVIVE: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', (d) => { if (process.env.BUG255_DEBUG) process.stderr.write(d); });
  for (let i = 0; i < 200; i++) { try { await fetch(`http://127.0.0.1:${port}/api/health`); break; } catch { await sleep(150); } }

  const projCwd = path.join(WORK, 'proj'); fs.mkdirSync(projCwd, { recursive: true });
  const reg = await jpost(port, '/api/projects', { hostPath: projCwd, name: 'bug255ui', isolation: 'direct' });
  const projectId = reg.body.project.id; const encodedDir = reg.body.project.encodedDir ?? hist.encodeCwd(projCwd);
  const sessionsFile = path.join(DATA, 'session-accounts.json');
  const bindingOf = (sid) => { try { return JSON.parse(fs.readFileSync(sessionsFile, 'utf8')).bindings?.[sid]; } catch { return undefined; } };
  const writeTranscript = (sid) => { const dir = path.join(STORE, encodedDir); fs.mkdirSync(dir, { recursive: true }); const ts = new Date().toISOString(); const lines = [ { type: 'user', sessionId: sid, cwd: projCwd, timestamp: ts, uuid: `u-${sid}`, message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }, { type: 'assistant', sessionId: sid, cwd: projCwd, timestamp: ts, uuid: `a-${sid}`, message: { role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'ok' }] } } ]; fs.writeFileSync(path.join(dir, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n'); };

  // Create a BOUND, STOPPED session: start under A, switch to B, close.
  const c = await openWs(port);
  let sid = null;
  for (let i = 0; i < 40 && !sid; i++) { c.send({ type: 'start', projectId, overrides: { model: 'haiku', permissionMode: 'bypassPermissions', claudeAccount: A.id }, prompt: 'hi' }); const init = await waitEv(c.events, (e) => e.t === 'session-init', 6000); if (init) sid = init.sessionId; else await sleep(1000); }
  if (!sid) throw new Error('could not start a session');
  await sleep(1200);
  c.send({ type: 'switch-account', requestId: 'sw', account: B.id });
  await waitEv(c.events, (e) => e.t === 'ack' && e.of === 'switch-account');
  c.close(); await sleep(800); writeTranscript(sid);
  if (bindingOf(sid) !== B.id) throw new Error(`setup: expected binding B, got ${bindingOf(sid)}`);

  // The STALE OVERRIDE that is the bug's precondition: this tab has A armed for S.
  const ovr = JSON.stringify({ [`${encodedDir} ${sid}`]: { claudeAccount: A.id } });
  const deepLink = `http://127.0.0.1:${port}/#/project/${encodeURIComponent(projectId)}/session/${encodeURIComponent(sid)}?dir=${encodeURIComponent(encodedDir)}`;

  browser = await chromium.launch({ headless: true, executablePath: process.env.QA_BRAVE_PATH ?? '/usr/bin/brave', args: ['--no-sandbox'] });

  // The synthesized PRE-FIX app.js: claudeAccountView reverted to the override chain.
  const liveApp = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const prefixApp = liveApp.replace(/function claudeAccountView\(\) \{[\s\S]*?\n\}/, `function claudeAccountView() {
  const o = state.overrides ?? {};
  const v = ('claudeAccount' in o ? o.claudeAccount : null) ?? currentProject()?.settings?.claudeAccount ?? null;
  return typeof v === 'string' && v ? v : 'default';
}`);
  if (prefixApp === liveApp) throw new Error('could not synthesize the pre-fix client (claudeAccountView not found)');
  // BUG-255 r3 — the fixed restoreOverrides no longer re-arms a stored per-session account; the
  // pre-fix client did, so the synthesized pre-fix reverts that too (or it would have no override to show).
  const prefixApp2 = prefixApp.replace('const { provider: _stale, claudeAccount: _staleAcct, ...rest } = saved;', 'const { provider: _stale, ...rest } = saved;');

  async function chipText(mode) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.addInitScript((o) => { try { localStorage.setItem('cs-overrides', o); } catch {} }, ovr);
    if (mode === 'prefix') await page.route('**/app.js', (r) => r.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: prefixApp2 }));
    await page.goto(deepLink, { waitUntil: 'domcontentloaded' });
    // wait for the account chip to render with a non-empty label
    let txt = '';
    for (let i = 0; i < 80; i++) {
      txt = await page.evaluate(() => { const n = document.getElementById('acctSelN'); const sel = document.getElementById('acctSel'); return (sel && !sel.hidden && n) ? (n.textContent || '').trim() : ''; });
      if (txt && !/checking/.test(txt)) break; await sleep(150); // r3: 'account unknown — checking' is not a rendered account
    }
    return { ctx, page, txt };
  }

  /* (a) DISPLAY — the fixed client shows the BOUND account B despite the stale override A */
  console.log('\n== (a) DISPLAY: a bound session shows the account it is actually on');
  const fixed = await chipText('fixed');
  await fixed.page.screenshot({ path: path.join(ASSETS, 'BUG-255-display-bound.png') });
  ok(fixed.txt === 'plan B', 'the indicator shows the BOUND account "plan B", not the stale override "plan A"', { chip: fixed.txt });

  const pre = await chipText('prefix');
  await pre.page.screenshot({ path: path.join(ASSETS, 'BUG-255-display-prefix.png') });
  ok(pre.txt === 'plan A', 'must-FAIL twin: the PRE-FIX client shows the stale override "plan A" (the reported bug)', { chip: pre.txt });
  ok(fixed.txt !== pre.txt, 'the fix changes what the user sees (bound B vs pre-fix override A)', { fixed: fixed.txt, prefix: pre.txt });
  await pre.ctx.close();

  /* (d) ACTION — clicking account A in the real popover rebinds the session to A */
  console.log('\n== (d) ACTION: picking another account actually switches the bound session');
  const page = fixed.page;
  await page.click('#acctSel');
  await page.waitForSelector('#acctOpts', { state: 'visible', timeout: 5000 });
  // click the row labelled "plan A"
  const clicked = await page.evaluate(() => { const b = [...document.querySelectorAll('#acctOpts .opt')].find((x) => (x.querySelector('.n')?.textContent || '').trim() === 'plan A'); if (b) { b.click(); return true; } return false; });
  if (!clicked) throw new Error('could not find the "plan A" account row in the popover');
  // wait for the server binding to move to A and the chip to update
  let bound = bindingOf(sid); let chip = '';
  for (let i = 0; i < 60; i++) { bound = bindingOf(sid); chip = await page.evaluate(() => (document.getElementById('acctSelN')?.textContent || '').trim()); if (bound === A.id && chip === 'plan A') break; await sleep(150); }
  await page.screenshot({ path: path.join(ASSETS, 'BUG-255-after-rebind.png') });
  ok(bound === A.id, 'the real click rebound the session: the server binding moved to A (not a dropped override)', { binding: bound, A: A.id });
  ok(chip === 'plan A', 'the indicator updated to the newly-picked account "plan A"', { chip });
  await fixed.ctx.close();

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
  console.log(`screenshots: ${path.join(ASSETS, 'BUG-255-display-bound.png')}, BUG-255-display-prefix.png, BUG-255-after-rebind.png`);
  await browser.close(); browser = null;
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
