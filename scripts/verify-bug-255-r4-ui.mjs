#!/usr/bin/env node
/**
 * verify-bug-255-r4-ui.mjs — BUG-255 r4: ONE launch-account authority
 * (src/server/launch-account.ts `effectiveLaunchAccount`). The two breaks independent
 * verify r3 (run e43dd24e) found, driven in a real headless browser against a real
 * scratch server + a fake CLI, each graded twice: against the tree under test, and
 * against a SYNTHESIZED PRE-FIX tree (this working tree with the r4-touched files
 * restored from their pre-edit snapshot), which must BREAK every graded case.
 *   U1 ws start resume: an UNBOUND stopped session the indicator shows on the project
 *      account B; the user sends from the real UI while the tab's `start` frame carries a
 *      client account pick A (what an older client / a stale tab sends — injected on the
 *      wire with routeWebSocket). The CLI must launch on B (/proc), the account shown.
 *   U2 outbox pump: the same session viewed in a tab (shows B); a row is enqueued for it
 *      carrying a client account A (an older client's row, POST /api/outbox). The detached
 *      pump resume must launch on B (/proc), and the viewing tab keeps showing B.
 *   U3 container drift: a session bound to A under `direct` (project account B) is open in
 *      a tab (shows A); the project is switched to `container`. The open tab — without a
 *      reopen — and a fresh tab must show the PROJECT account B (a container launch binds
 *      the project's credentials). Switched back to `direct`, the dormant binding applies
 *      again: the tab shows A and a real resume runs on A (/proc).
 *   U5 (anti-regression, not graded): a FORK runs on its parent's account whatever the client
 *      sends, and its new id is bound to it at init (/proc + binding + indicator).
 *   U4 (anti-regression of the new rule, not must-FAIL graded): a NEW session's pick (A,
 *      project B) launches on A and becomes its BINDING at init, so after it stops the
 *      indicator still shows A and its resume runs on A (/proc).
 * Isolation: scratch HOME / DATA / STORE per case, a free ephemeral port, stub credentials
 * written only into the scratch dir (never read, never printed); only CLAUDE_CONFIG_DIR is
 * read from /proc/<pid>/environ. No container is started (U3 registers isolation only).
 * Run: node scripts/verify-bug-255-r4-ui.mjs [U1 U2 U3 U4 U5]
 *   BUG255_PRE_ROOT=<dir> the synthesized pre-fix tree (default /tmp/bug255r4-preroot); the
 *   must-FAIL half is skipped (and says so) if it is absent.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const ASSETS = path.join(REPO, 'docs', 'bugs', 'assets');
const PRE_ROOT = process.env.BUG255_PRE_ROOT ?? '/tmp/bug255r4-preroot';
const ONLY = process.argv.slice(2);
const only = (k) => ONLY.length === 0 || ONLY.includes(k);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, name, observed) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`); c ? pass++ : fail++; return c; };

async function freePort() { const net = await import('node:net'); return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }

/* ---------------------------------------------------------------- fixture */
const spawned = new Set(); // server children THIS harness started (killed by pid only)
const scratches = new Set();
process.on('exit', () => {
  for (const c of spawned) { try { if (c.exitCode === null) process.kill(c.pid, 'SIGKILL'); } catch {} }
  for (const d of scratches) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

function makeScratch(tag) {
  const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), `bug255r4${tag}-`));
  scratches.add(SCRATCH);
  const HOME = path.join(SCRATCH, 'home'), DATA = path.join(SCRATCH, 'data'), STORE = path.join(SCRATCH, 'store'), WORK = path.join(SCRATCH, 'work');
  for (const d of [path.join(HOME, '.claude', 'projects'), DATA, STORE, WORK]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(HOME, '.claude', 'settings.json'), JSON.stringify({ cleanupPeriodDays: 36500 }) + '\n');
  delete process.env.CLAUDE_CONFIG_DIR; process.env.HOME = HOME; process.env.CLAUDE_STATION_DATA = DATA; process.env.CLAUDE_PROJECTS_DIR = STORE;
  const LAUNCHES = path.join(WORK, 'launches.jsonl');
  const FAKE = path.join(WORK, 'fake-claude.mjs');
  fs.writeFileSync(FAKE, `
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const a = process.argv; const argOf = (f) => { const i = a.indexOf(f); if (i > -1) return a[i + 1]; const e = a.find((x) => x.startsWith(f + '=')); return e ? e.slice(f.length + 1) : null; };
const sid = a.includes('--fork-session') ? (argOf('--session-id') || randomUUID()) : (argOf('--resume') || argOf('--session-id') || randomUUID());
try { fs.appendFileSync(${JSON.stringify(LAUNCHES)}, JSON.stringify({ pid: process.pid, sid, ts: Date.now() }) + '\\n'); } catch {}
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
  return { SCRATCH, HOME, DATA, STORE, WORK, FAKE, LAUNCHES };
}

async function mintAccounts(ROOT, DATA, labels) {
  const accts = await import(path.join(ROOT, 'src', 'server', 'claude-accounts.ts'));
  const file = path.join(DATA, 'claude-accounts.json');
  const out = {};
  for (const label of labels) {
    const row = accts.createAccount(label);
    const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const r of reg.accounts) if (r.id === row.id) r.state = 'ready';
    fs.writeFileSync(file, JSON.stringify(reg, null, 2) + '\n');
    fs.writeFileSync(path.join(accts.resolveAccountDir(row.id), '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'stub' } }) + '\n');
    out[label] = { ...row, dir: accts.resolveAccountDir(row.id) };
  }
  return out;
}

function startServer(ROOT, fx, port) {
  const entry = path.join(ROOT, 'src', 'server', 'index.ts');
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: fx.DATA, CLAUDE_PROJECTS_DIR: fx.STORE, HOME: fx.HOME, CLAUDE_STATION_CLAUDE_BIN: fx.FAKE, CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0', CLAUDE_STATION_SURVIVE: '0' };
  const child = spawn(process.execPath, [entry], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  spawned.add(child);
  child.stderr.on('data', (d) => { if (process.env.BUG255_DEBUG) process.stderr.write(d); });
  child.stdout.on('data', (d) => { if (process.env.BUG255_DEBUG) process.stderr.write(d); });
  return child;
}
async function waitHealth(port) { for (let i = 0; i < 300; i++) { try { await fetch(`http://127.0.0.1:${port}/api/health`); return true; } catch { await sleep(150); } } return false; }
async function killServer(child) { if (!child || child.exitCode !== null) return; const done = new Promise((r) => child.once('exit', r)); try { process.kill(child.pid, 'SIGKILL'); } catch {} await done; spawned.delete(child); }

async function jget(port, p) { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { status: r.status, body: await r.json().catch(() => null) }; }
async function jsend(port, method, p, body) { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; }
function openWs(port) { return new Promise((res, rej) => { const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); const events = []; ws.on('message', (raw) => { try { events.push(JSON.parse(String(raw))); } catch {} }); ws.once('open', () => res({ ws, events, send: (o) => ws.send(JSON.stringify(o)), close: () => { try { ws.close(); } catch {} } })); ws.once('error', rej); ws.on('error', () => {}); }); }
const waitEv = async (events, pred, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const h = events.find(pred); if (h) return h; await sleep(80); } return null; };

function configDirOf(pid) {
  try { const raw = fs.readFileSync(`/proc/${pid}/environ`, 'utf8'); for (const kv of raw.split('\0')) if (kv.startsWith('CLAUDE_CONFIG_DIR=')) return kv.slice(18); return '(absent)'; }
  catch (e) { return `(gone: ${e.code})`; }
}
const alive = (pid) => { try { process.kill(pid, 0); return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.[0] !== 'Z'; } catch { return false; } };
const launchesOf = (fx, sid) => { try { return fs.readFileSync(fx.LAUNCHES, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => !sid || l.sid === sid); } catch { return []; } };
const bindingOf = (fx, sid) => { try { const b = JSON.parse(fs.readFileSync(path.join(fx.DATA, 'session-accounts.json'), 'utf8')).bindings ?? {}; return sid in b ? b[sid] : undefined; } catch { return undefined; } };

async function project(ROOT, port, fx, name, isolation = 'direct') {
  const hist = await import(path.join(ROOT, 'src', 'lib', 'session-history.ts'));
  const projCwd = path.join(fx.WORK, name); fs.mkdirSync(projCwd, { recursive: true });
  const reg = await jsend(port, 'POST', '/api/projects', { hostPath: projCwd, name, isolation });
  if (!reg.body?.project?.id) throw new Error(`project ${name} (${isolation}) not registered: ${JSON.stringify(reg.body).slice(0, 300)}`);
  const projectId = reg.body.project.id; const encodedDir = reg.body.project.encodedDir ?? hist.encodeCwd(projCwd);
  const writeTranscript = (sid) => { const dir = path.join(fx.STORE, encodedDir); fs.mkdirSync(dir, { recursive: true }); const ts = new Date().toISOString(); const lines = [{ type: 'user', sessionId: sid, cwd: projCwd, timestamp: ts, uuid: `u-${sid}`, message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }, { type: 'assistant', sessionId: sid, cwd: projCwd, timestamp: ts, uuid: `a-${sid}`, message: { role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'ok' }] } }]; fs.writeFileSync(path.join(dir, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n'); };
  const link = (sid) => `http://127.0.0.1:${port}/#/project/${encodeURIComponent(projectId)}/session/${encodeURIComponent(sid)}?dir=${encodeURIComponent(encodedDir)}`;
  const setAccount = (id) => jsend(port, 'PATCH', `/api/projects/${projectId}`, { settings: { claudeAccount: id } });
  return { projectId, encodedDir, projCwd, writeTranscript, link, setAccount };
}

/** A real session (fake CLI), started then stopped; optionally bound to `bindTo` via the offline route. */
async function makeSession(port, P, { startOn = undefined, bindTo = undefined } = {}) {
  const c = await openWs(port); let init = null;
  for (let i = 0; i < 40 && !init; i++) {
    c.send({ type: 'start', projectId: P.projectId, overrides: { model: 'haiku', permissionMode: 'bypassPermissions', ...(startOn !== undefined ? { claudeAccount: startOn } : {}) }, prompt: 'hi' });
    init = await waitEv(c.events, (e) => e.t === 'session-init', 6000); if (!init) await sleep(1000);
  }
  if (!init) throw new Error('no session-init: ' + JSON.stringify(c.events.filter((e) => e.t === 'error').slice(-3)));
  await waitEv(c.events, (e) => e.t === 'turn-end', 8000); await sleep(400);
  c.close(); await sleep(700);
  P.writeTranscript(init.sessionId);
  if (bindTo !== undefined) {
    const r = await jsend(port, 'POST', `/api/sessions/${init.sessionId}/account`, { account: bindTo, encodedDir: P.encodedDir, projectId: P.projectId });
    if (!r.body?.ok) throw new Error(`setup rebind failed: ${JSON.stringify(r.body)}`);
  }
  return init.sessionId;
}

/* ---------------------------------------------------------------- browser helpers */
let browser = null;
async function newPage(ctx) {
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.__said = [];
    const hook = () => { const f = document.getElementById('fine'); if (!f) return setTimeout(hook, 50); new MutationObserver(() => { const t = (f.textContent || '').trim(); if (t && window.__said[window.__said.length - 1] !== t) window.__said.push(t); }).observe(f, { childList: true, characterData: true, subtree: true }); };
    hook();
  });
  return page;
}
const chip = (page) => page.evaluate(() => { const n = document.getElementById('acctSelN'); const sel = document.getElementById('acctSel'); const s = document.getElementById('acctSelS'); return (sel && !sel.hidden && n) ? ((n.textContent || '').trim() + (s ? (s.textContent || '') : '')) : ''; }).catch(() => '');
async function waitChip(page, pred, ms) { const t0 = Date.now(); let t = ''; while (Date.now() - t0 < ms) { t = await chip(page); if (pred(t)) return t; await sleep(100); } return t; }
const said = (page) => page.evaluate(() => window.__said.slice()).catch(() => []);
async function pick(page, label) {
  await page.click('#acctSel');
  await page.waitForSelector('#acctOpts', { state: 'visible', timeout: 5000 }).catch(() => {});
  await page.evaluate((l) => { [...document.querySelectorAll('#acctOpts .opt')].find((x) => (x.querySelector('.n')?.textContent || '').trim() === l)?.click(); }, label);
}
async function uiSend(page, text) { await page.fill('#prompt', text); await page.focus('#prompt'); await page.keyboard.press('Enter'); }
const isAcctGet = (u) => /\/api\/sessions\/[^/?]+\/account(\?|$)/.test(u);
async function shot(page, name) { try { fs.mkdirSync(ASSETS, { recursive: true }); await page.screenshot({ path: path.join(ASSETS, name) }); } catch {} }

/* ---------------------------------------------------------------- cases */
const dirName = (dir, acc) => (dir === acc['plan A'].dir ? 'A' : dir === acc['plan B'].dir ? 'B' : dir);
async function nextLaunch(fx, sid, n0, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const ls = launchesOf(fx, sid); if (ls.length > n0) return ls[ls.length - 1]; await sleep(150); }
  return null;
}
/** Backdate a transcript so the outbox gate does not read it as "another program is writing it". */
function backdate(fx, P, sid) { const f = path.join(fx.STORE, P.encodedDir, `${sid}.jsonl`); const t = new Date(Date.now() - 10 * 60_000); try { fs.utimesSync(f, t, t); } catch {} }

const GRADED = ['U1', 'U2', 'U3'];
const CASES = {
  /* U1 — ws start resume of an UNBOUND session whose start frame carries a client account pick. */
  async U1(ROOT, tag) {
    const fx = makeScratch('u1');
    const acc = await mintAccounts(ROOT, fx.DATA, ['plan A', 'plan B']); const A = acc['plan A'], B = acc['plan B'];
    const port = await freePort();
    const server = startServer(ROOT, fx, port); await waitHealth(port);
    const P = await project(ROOT, port, fx, 'u1proj');
    await P.setAccount(B.id);
    for (let i = 0; i < 2; i++) await makeSession(port, P, { bindTo: A.id }); // busy state: bound neighbours
    const sid = await makeSession(port, P); // unbound, stopped, ran on the project account B
    const ctx = await browser.newContext();
    const other = await newPage(ctx); await other.goto(P.link(sid)); // a second tab VIEWING the same session
    const page = await newPage(ctx);
    let injected = 0;
    await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => {
        try {
          const f = JSON.parse(String(m));
          if (f && f.type === 'start' && f.resumeSessionId === sid) { f.overrides = { ...(f.overrides ?? {}), claudeAccount: A.id }; injected++; server.send(JSON.stringify(f)); return; }
        } catch {}
        server.send(m);
      });
      server.onMessage((m) => ws.send(m));
    });
    await page.goto(P.link(sid));
    const c0 = await waitChip(page, (t) => t.startsWith('plan'), 15000);
    const n0 = launchesOf(fx, sid).length;
    await uiSend(page, 'resume please');
    const l = await nextLaunch(fx, sid, n0);
    const dir = l ? configDirOf(l.pid) : '(no launch)';
    await sleep(1500);
    const c1 = await chip(page); const v1 = await chip(other);
    await shot(page, `BUG-255-r4-U1-${tag}.png`);
    await ctx.close(); await killServer(server);
    ok(c0.startsWith('plan B') && injected > 0 && !!l, `[${tag}] U1 setup: the indicator shows the project account "plan B"; the resume's start frame carried a client pick of plan A (${injected}x); a CLI launched`, { c0, injected, launched: !!l });
    const held = c0.startsWith('plan B') && injected > 0 && dir === B.dir && c1.startsWith('plan B') && v1.startsWith('plan B');
    ok(held, `[${tag}] U1 the resume launches on the account the indicator showed ("plan B", /proc), not the client pick; both tabs still show plan B`, { launchedOn: dirName(dir, acc), chipAfter: c1, viewingTab: v1 });
    return held;
  },

  /* U2 — the outbox pump resumes an UNBOUND session from a row carrying a client account. */
  async U2(ROOT, tag) {
    const fx = makeScratch('u2');
    const acc = await mintAccounts(ROOT, fx.DATA, ['plan A', 'plan B']); const A = acc['plan A'], B = acc['plan B'];
    const port = await freePort();
    const server = startServer(ROOT, fx, port); await waitHealth(port);
    const P = await project(ROOT, port, fx, 'u2proj');
    await P.setAccount(B.id);
    for (let i = 0; i < 2; i++) await makeSession(port, P, { bindTo: A.id }); // busy state
    const sid = await makeSession(port, P); // unbound, ran on B
    backdate(fx, P, sid);
    const ctx = await browser.newContext();
    const view = await newPage(ctx);
    await view.goto(P.link(sid));
    const c0 = await waitChip(view, (t) => t.startsWith('plan'), 15000);
    const n0 = launchesOf(fx, sid).length;
    const enq = await jsend(port, 'POST', '/api/outbox', { session: sid, project: P.projectId, dir: P.encodedDir, text: 'queued by an older client', nonce: `n-${Date.now()}`, overrides: { claudeAccount: A.id, model: 'haiku' } });
    const l = await nextLaunch(fx, sid, n0, 30000);
    const dir = l ? configDirOf(l.pid) : '(no launch)';
    const c1 = await waitChip(view, (t) => t.startsWith('plan'), 5000);
    await sleep(1200);
    const c2 = await chip(view);
    await shot(view, `BUG-255-r4-U2-${tag}.png`);
    await ctx.close(); await killServer(server);
    ok(c0.startsWith('plan B') && (enq.status === 201 || enq.status === 200) && !!l, `[${tag}] U2 setup: the viewing tab shows "plan B"; a row carrying a client account A was enqueued; the pump resumed the session`, { c0, enqueue: enq.status, launched: !!l, err: enq.body?.error });
    const held = c0.startsWith('plan B') && !!l && dir === B.dir && c1.startsWith('plan B') && c2.startsWith('plan B');
    ok(held, `[${tag}] U2 the detached pump resume launches on "plan B" (/proc), the account the viewing tab shows — never the row's client account`, { launchedOn: dirName(dir, acc), viewingTab: c2 });
    return held;
  },

  /* U3 — a binding made under `direct`; the project becomes `container`; then `direct` again. */
  async U3(ROOT, tag) {
    const fx = makeScratch('u3');
    const acc = await mintAccounts(ROOT, fx.DATA, ['plan A', 'plan B']); const A = acc['plan A'], B = acc['plan B'];
    const port = await freePort();
    const server = startServer(ROOT, fx, port); await waitHealth(port);
    const P = await project(ROOT, port, fx, 'u3proj');
    await P.setAccount(B.id);
    await makeSession(port, P); // busy state: an unbound neighbour
    const sid = await makeSession(port, P, { bindTo: A.id }); // bound to A under direct
    const ctx = await browser.newContext();
    const page = await newPage(ctx);
    await page.goto(P.link(sid));
    const c0 = await waitChip(page, (t) => t.startsWith('plan A'), 15000);
    const toC = await jsend(port, 'PATCH', `/api/projects/${P.projectId}`, { isolation: 'container' });
    const c1 = await waitChip(page, (t) => t.startsWith('plan B'), 8000); // the open tab, no reopen
    const factC = (await jget(port, `/api/sessions/${sid}/account?projectId=${P.projectId}`)).body;
    const fresh = await newPage(ctx); await fresh.goto(P.link(sid));
    const f1 = await waitChip(fresh, (t) => t.startsWith('plan B'), 15000);
    await shot(page, `BUG-255-r4-U3-container-${tag}.png`);
    await fresh.close();
    const toD = await jsend(port, 'PATCH', `/api/projects/${P.projectId}`, { isolation: 'direct' });
    const c2 = await waitChip(page, (t) => t.startsWith('plan A'), 8000);
    const n0 = launchesOf(fx, sid).length;
    await uiSend(page, 'back on direct');
    const l = await nextLaunch(fx, sid, n0);
    const dir = l ? configDirOf(l.pid) : '(no launch)';
    await ctx.close(); await killServer(server);
    ok(c0.startsWith('plan A') && toC.status === 200 && toD.status === 200, `[${tag}] U3 setup: the bound session shows "plan A"; the project was switched to container and back`, { c0, toContainer: toC.status, toDirect: toD.status, err: toC.body?.error ?? toD.body?.error });
    const containerTruth = c1.startsWith('plan B') && f1.startsWith('plan B') && factC?.next === B.id;
    ok(containerTruth, `[${tag}] U3 under container the open tab (no reopen) and a fresh tab show the PROJECT account "plan B"; the server declares next=B`, { openTab: c1, freshTab: f1, next: factC?.next === B.id ? 'B' : factC?.next === A.id ? 'A' : factC?.next, bound: factC?.bound === A.id ? 'A (dormant)' : factC?.bound });
    const back = c2.startsWith('plan A') && dir === A.dir;
    ok(back, `[${tag}] U3 back on direct the dormant binding applies again: the tab shows "plan A" and the resume runs on plan A (/proc)`, { chip: c2, launchedOn: dirName(dir, acc) });
    return containerTruth && back;
  },

  /* U4 — a NEW session's pick becomes its binding (the rule that replaces per-launch overrides). */
  async U4(ROOT, tag) {
    const fx = makeScratch('u4');
    const acc = await mintAccounts(ROOT, fx.DATA, ['plan A', 'plan B']); const A = acc['plan A'], B = acc['plan B'];
    const port = await freePort();
    const server = startServer(ROOT, fx, port); await waitHealth(port);
    const P = await project(ROOT, port, fx, 'u4proj');
    await P.setAccount(B.id);
    for (let i = 0; i < 2; i++) await makeSession(port, P, { bindTo: A.id }); // busy state
    const ctx = await browser.newContext();
    const page = await newPage(ctx);
    await page.goto(`http://127.0.0.1:${port}/#/project/${encodeURIComponent(P.projectId)}`);
    const c0 = await waitChip(page, (t) => t.startsWith('plan'), 15000);
    await pick(page, 'plan A');
    const c1 = await waitChip(page, (t) => t.startsWith('plan A'), 5000);
    const before = new Set(launchesOf(fx).map((x) => x.pid));
    await uiSend(page, 'a brand new session');
    let l = null; for (let i = 0; i < 100 && !l; i++) { l = launchesOf(fx).find((x) => !before.has(x.pid)) ?? null; if (!l) await sleep(150); }
    const sid = l?.sid; const dir = l ? configDirOf(l.pid) : '(no launch)';
    await sleep(2500);
    const bound = sid ? bindingOf(fx, sid) : undefined;
    await ctx.close(); await sleep(1500);
    if (sid) P.writeTranscript(sid);
    const ctx2 = await browser.newContext();
    const pg2 = await newPage(ctx2);
    await pg2.goto(P.link(sid ?? 'none'));
    const c2 = await waitChip(pg2, (t) => t.startsWith('plan'), 15000);
    const n0 = sid ? launchesOf(fx, sid).length : 0;
    await uiSend(pg2, 'resume the new one');
    const l2 = sid ? await nextLaunch(fx, sid, n0) : null;
    const dir2 = l2 ? configDirOf(l2.pid) : '(no launch)';
    await shot(pg2, `BUG-255-r4-U4-${tag}.png`);
    await ctx2.close(); await killServer(server);
    const held = c0.startsWith('plan B') && c1.startsWith('plan A') && dir === A.dir && bound === A.id && c2.startsWith('plan A') && dir2 === A.dir;
    ok(held, `[${tag}] U4 a new session picked "plan A" (project B) launches on A, is BOUND to A at init, shows "plan A" after it stops, and resumes on A (/proc)`, { c0, picked: c1, launchedOn: dirName(dir, acc), binding: bound === A.id ? 'A' : bound, reopened: c2, resumedOn: dirName(dir2, acc) });
    return held;
  },
};

Object.assign(CASES, {
  /* U5 (not must-FAIL graded: forks were not a named break) — a fork runs on its PARENT's account
     (the function, keyed by the parent id) whatever the client sends, and the new child id is bound
     to it at init, so the child's indicator and its own resume agree. */
  async U5(ROOT, tag) {
    const fx = makeScratch('u5');
    const acc = await mintAccounts(ROOT, fx.DATA, ['plan A', 'plan B']); const A = acc['plan A'], B = acc['plan B'];
    const port = await freePort();
    const server = startServer(ROOT, fx, port); await waitHealth(port);
    const P = await project(ROOT, port, fx, 'u5proj');
    await P.setAccount(B.id);
    const parent = await makeSession(port, P, { bindTo: A.id });
    const c = await openWs(port);
    let init = null;
    for (let i = 0; i < 20 && !init; i++) {
      c.send({ type: 'start', projectId: P.projectId, resumeSessionId: parent, fork: true, resumeEncodedDir: P.encodedDir, prompt: 'fork it', overrides: { model: 'haiku', permissionMode: 'bypassPermissions', claudeAccount: B.id } });
      init = await waitEv(c.events, (e) => e.t === 'session-init', 6000); if (!init) await sleep(1000);
    }
    const child = init?.sessionId;
    const l = child ? launchesOf(fx, child).slice(-1)[0] : null;
    const dir = l ? configDirOf(l.pid) : '(no launch)';
    await waitEv(c.events, (e) => e.t === 'turn-end', 8000); await sleep(400); c.close(); await sleep(800);
    const bound = child ? bindingOf(fx, child) : undefined;
    if (child) P.writeTranscript(child);
    const ctx = await browser.newContext(); const pg = await newPage(ctx);
    await pg.goto(P.link(child ?? 'none'));
    const ch = await waitChip(pg, (t) => t.startsWith('plan'), 15000);
    await ctx.close(); await killServer(server);
    const held = !!child && child !== parent && dir === A.dir && bound === A.id && ch.startsWith('plan A');
    ok(held, `[${tag}] U5 a fork of a session bound to A (project B, client sent B) runs on A (/proc), its new id is bound to A, and its indicator shows "plan A"`, { forked: !!child && child !== parent, launchedOn: dirName(dir, acc), childBinding: bound === A.id ? 'A' : bound, chip: ch, errors: c.events.filter((e) => e.t === 'error').map((e) => e.message).slice(-2) });
    return held;
  },
});

/* ---------------------------------------------------------------- main */
async function runAll(ROOT, tag) {
  const out = {};
  for (const k of Object.keys(CASES)) {
    if (!only(k)) continue;
    console.log(`\n== [${tag}] ${k}`);
    try { out[k] = await CASES[k](ROOT, tag); }
    // A crash is NOT a break: it proves nothing about the property (null, never graded as must-FAIL).
    catch (err) { out[k] = null; ok(false, `[${tag}] ${k} ran to completion`, String(err?.stack ?? err).slice(0, 600)); }
    finally { for (const c of [...spawned]) await killServer(c); } // only the servers this harness started
  }
  return out;
}

browser = await chromium.launch({ headless: true, executablePath: process.env.QA_BRAVE_PATH ?? '/usr/bin/brave', args: ['--no-sandbox'] });
const fixed = await runAll(REPO, 'fixed');
if (fs.existsSync(path.join(PRE_ROOT, 'src', 'server', 'index.ts'))) {
  const before = { pass, fail };
  const pre = await runAll(PRE_ROOT, 'prefix');
  // The pre-fix run is EXPECTED to break: its own FAIL lines are evidence, not suite failures.
  pass = before.pass; fail = before.fail;
  console.log('\n== must-FAIL grading (the synthesized pre-fix tree must break every graded case)');
  for (const k of Object.keys(pre)) {
    if (GRADED.includes(k)) ok(pre[k] === false, `must-FAIL: the pre-fix tree breaks ${k} (a crash is not a break)`, { prefixHeld: pre[k], fixedHeld: fixed[k] });
    else console.log(`  (info) ${k} on the pre-fix tree: ${pre[k] === true ? 'held' : pre[k] === false ? 'broke' : 'crashed'} — not graded (a new rule, not a pre-fix defect)`);
  }
} else {
  console.log(`\n(must-FAIL half SKIPPED: no pre-fix tree at ${PRE_ROOT})`);
}
await browser.close();
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
