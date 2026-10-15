#!/usr/bin/env node
/**
 * verify-bug-255-r3-ui.mjs — BUG-255 r3 (final fix round). The three r2 breaks, driven
 * in a real headless browser against a real scratch server + a fake CLI, each graded
 * twice: against the tree under test, and against a SYNTHESIZED PRE-FIX tree (the r2
 * working state, saved before the r3 edits), which must BREAK every case.
 *   A1 restart: a tab is open on a bound session; the user's switch re-reads the fact and
 *      that read is answered by the OLD server and held; the server restarts; a newer fact
 *      arrives from the NEW boot; then the held old-boot fact lands. The indicator must not
 *      revert to it and must stay on the true account. (Fact ordering is total across boots.)
 *   A2 container: a container-project session with NO binding (an "empty" fact in r2) and a
 *      stale per-session override in localStorage. The indicator shows the PROJECT account
 *      (the server's `next`), never the override; a per-session pick is refused and changes
 *      nothing.
 *   A2b absent fact: the server's fact names no account (cannot place the session) — the
 *      indicator says "account unknown — checking" (never the stale override) and converges
 *      once the server names it; the resume then runs on exactly that account (/proc).
 *   C1 a live switch whose stop FAILS before teardown: reported failed, binding unchanged,
 *      indicator (switching tab AND a viewing tab) shows the old account with nothing pending;
 *      the old CLI keeps serving the session on the old account in the same tab; when the tab
 *      goes away it is released (not orphaned) and a fresh resume runs on the old account.
 *   C2 a live switch whose stop fails PART-WAY (bridge torn down, CLI not yet ended): reported
 *      failed, binding unchanged, indicator on the old account; the leftover CLI is REAPED
 *      (no orphan); the next message resumes the session on the old account (/proc).
 * Fault injection for C is a scratch-only server entry (scripts/fixtures/bug-255/
 * entry-stopfail.mjs) that wraps AgentSession.close — no seam exists in the product.
 *
 * Isolation: scratch HOME / DATA / STORE per case, a free ephemeral port, fake credentials
 * written only into the scratch dir (never read, never printed); only CLAUDE_CONFIG_DIR is
 * read from /proc/<pid>/environ. Run: node scripts/verify-bug-255-r3-ui.mjs [A1 A2 A2b C1 C2]
 *   BUG255_PRE_ROOT=<dir> the synthesized pre-fix tree (default /tmp/bug255r3-preroot); the
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
const STOPFAIL_ENTRY = path.join(REPO, 'scripts', 'fixtures', 'bug-255', 'entry-stopfail.mjs');
const ASSETS = path.join(REPO, 'docs', 'bugs', 'assets');
const PRE_ROOT = process.env.BUG255_PRE_ROOT ?? '/tmp/bug255r3-preroot';
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
  const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), `bug255r3${tag}-`));
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
const sid = argOf('--resume') || argOf('--session-id') || randomUUID();
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

function startServer(ROOT, fx, port, { stopfail = null } = {}) {
  const entry = stopfail ? STOPFAIL_ENTRY : path.join(ROOT, 'src', 'server', 'index.ts');
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: fx.DATA, CLAUDE_PROJECTS_DIR: fx.STORE, HOME: fx.HOME, CLAUDE_STATION_CLAUDE_BIN: fx.FAKE, CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0', CLAUDE_STATION_SURVIVE: '0', BUG255_ROOT: ROOT, ...(stopfail ? { BUG255_STOPFAIL: stopfail } : {}) };
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
/** Each case returns true iff the property HELD in this tree; it records its own checks. */
const CASES = {
  /* A1 — restart with a tab open; a late fact from the OLD boot must never win. */
  async A1(ROOT, tag) {
    const fx = makeScratch('a1');
    const acc = await mintAccounts(ROOT, fx.DATA, ['plan A', 'plan B']); const A = acc['plan A'], B = acc['plan B'];
    const port = await freePort();
    let server = startServer(ROOT, fx, port); await waitHealth(port);
    const P = await project(ROOT, port, fx, 'a1proj');
    const sids = []; for (let i = 0; i < 3; i++) sids.push(await makeSession(port, P, { startOn: A.id, bindTo: B.id }));
    const sid = sids[0];
    const ctx = await browser.newContext();
    const other = await newPage(ctx); await other.goto(P.link(sids[1])); // busy state: a second tab on another session
    const page = await newPage(ctx);
    let holdNext = false; let release = null; let heldBoot = null;
    await page.route(isAcctGet, async (route) => {
      if (route.request().method() !== 'GET' || !holdNext) return route.continue();
      holdNext = false;
      const resp = await route.fetch(); // answered by the CURRENT (old) server, now
      try { heldBoot = JSON.parse((await resp.body()).toString()).boot; } catch {}
      await new Promise((r) => { release = r; });
      await route.fulfill({ response: resp }).catch(() => {});
    });
    await page.goto(P.link(sid));
    const c0 = await waitChip(page, (t) => t.startsWith('plan B'), 15000);
    await sleep(1500);
    holdNext = true;
    await pick(page, 'plan A');
    const c1 = await waitChip(page, (t) => t.startsWith('plan A'), 8000);
    for (let i = 0; i < 100 && !release; i++) await sleep(100);
    const boot1 = (await jget(port, `/api/sessions/${sid}/account`)).body?.boot;
    await killServer(server); await sleep(400);
    server = startServer(ROOT, fx, port); await waitHealth(port);
    const boot2 = (await jget(port, `/api/sessions/${sid}/account`)).body?.boot;
    await sleep(4000); // the watch socket reconnects and re-reads
    const r = await jsend(port, 'POST', `/api/sessions/${sid}/account`, { account: B.id, encodedDir: P.encodedDir, projectId: P.projectId });
    const c2 = await waitChip(page, (t) => t.startsWith('plan B'), 8000);
    release?.();
    await sleep(1500);
    const c3 = await chip(page);
    const c4 = await waitChip(page, (t) => t.startsWith('plan B'), 12000);
    await shot(page, `BUG-255-r3-A1-${tag}.png`);
    const truth = (await jget(port, `/api/sessions/${sid}/account`)).body;
    await ctx.close(); await killServer(server);
    const setup = c0.startsWith('plan B') && c1.startsWith('plan A') && !!release && r.body?.ok === true && c2.startsWith('plan B');
    ok(setup, `[${tag}] A1 setup: chip B, click A shows A, an old-boot read was held, restart, the new server's rebind to B reached the tab`, { c0, c1, held: !!release, heldBoot, boot1, boot2, rebind: r.body?.ok, c2 });
    const held = setup && !c3.startsWith('plan A') && c4.startsWith('plan B') && truth?.bound === B.id;
    ok(held, `[${tag}] A1 a LATE fact from the OLD boot does not revert the indicator; it stays on the true account "plan B"`, { afterStale: c3, after12s: c4, serverBound: truth?.bound === B.id ? 'B' : truth?.bound, heldBoot, currentBoot: truth?.boot });
    return held;
  },

  /* A2 — container project; the server fact is the project account; a stale override is never shown. */
  async A2(ROOT, tag) {
    const fx = makeScratch('a2');
    const acc = await mintAccounts(ROOT, fx.DATA, ['plan A', 'plan B']); const A = acc['plan A'], B = acc['plan B'];
    const port = await freePort();
    const server = startServer(ROOT, fx, port); await waitHealth(port);
    const D = await project(ROOT, port, fx, 'a2direct');
    for (let i = 0; i < 2; i++) await makeSession(port, D, { startOn: A.id, bindTo: B.id }); // busy-state neighbour
    const C = await project(ROOT, port, fx, 'a2box', 'container'); // registration only: no container is started
    const set = await C.setAccount(B.id);
    const sid = (await import('node:crypto')).randomUUID(); C.writeTranscript(sid);
    const ctx = await browser.newContext();
    const pg = await newPage(ctx);
    await pg.addInitScript((o) => { try { localStorage.setItem('cs-overrides', o); } catch {} }, JSON.stringify({ [`${C.encodedDir} ${sid}`]: { claudeAccount: A.id } }));
    await pg.goto(C.link(sid));
    const ch = await waitChip(pg, (t) => !!t && !/checking/.test(t), 15000);
    await shot(pg, `BUG-255-r3-A2-${tag}.png`);
    await pick(pg, 'plan A');
    await sleep(2500);
    const ch2 = await chip(pg);
    const msgs = (await said(pg)).slice(-3);
    await ctx.close(); await killServer(server);
    ok(set.status === 200, `[${tag}] A2 setup: container project account set to plan B`, { status: set.status });
    const held = ch.startsWith('plan B') && ch2.startsWith('plan B') && bindingOf(fx, sid) === undefined;
    ok(held, `[${tag}] A2 container session (no binding, stale override "plan A"): the indicator shows the PROJECT account "plan B", and still does after a refused pick`, { chip: ch, afterPick: ch2, binding: bindingOf(fx, sid), messages: msgs });
    return held;
  },

  /* A2b — the server's fact names no account: "account unknown — checking", never the override. */
  async A2b(ROOT, tag) {
    const fx = makeScratch('a2b');
    const acc = await mintAccounts(ROOT, fx.DATA, ['plan A', 'plan B']); const A = acc['plan A'], B = acc['plan B'];
    const port = await freePort();
    const server = startServer(ROOT, fx, port); await waitHealth(port);
    const P = await project(ROOT, port, fx, 'a2bproj');
    await P.setAccount(B.id);
    for (let i = 0; i < 2; i++) await makeSession(port, P, { startOn: A.id, bindTo: A.id }); // busy state
    const sid = await makeSession(port, P); // unbound, stopped, ran on the project account B
    const ctx = await browser.newContext();
    const pg = await newPage(ctx);
    await pg.addInitScript((o) => { try { localStorage.setItem('cs-overrides', o); } catch {} }, JSON.stringify({ [`${P.encodedDir} ${sid}`]: { claudeAccount: A.id } }));
    // For the first 5s the server "cannot place" the session: every account fact it serves names no account.
    let blank = true;
    const strip = (f) => { if (f && typeof f === 'object') { delete f.launch; delete f.bound; delete f.next; } return f; };
    await pg.route((u) => isAcctGet(u) || /\/api\/sessions\/[^/]+\/transcript/.test(u) || /\/transcript\?/.test(u), async (route) => {
      if (!blank) return route.continue();
      const resp = await route.fetch();
      let body = (await resp.body()).toString();
      try { const j = JSON.parse(body); if (j && typeof j === 'object') { if ('rev' in j && 'sessionId' in j) strip(j); if (j.accountFact) strip(j.accountFact); delete j.boundAccount; } body = JSON.stringify(j); } catch {}
      await route.fulfill({ response: resp, body });
    });
    await pg.goto(P.link(sid));
    const seen = new Set();
    const t0 = Date.now(); while (Date.now() - t0 < 4500) { const t = await chip(pg); if (t) seen.add(t); await sleep(100); }
    await shot(pg, `BUG-255-r3-A2b-unknown-${tag}.png`);
    blank = false;
    const after = await waitChip(pg, (t) => t.startsWith('plan B'), 12000);
    const n0 = launchesOf(fx, sid).length;
    await uiSend(pg, 'resume please');
    let l = null; for (let i = 0; i < 100 && !l; i++) { const ls = launchesOf(fx, sid); if (ls.length > n0) l = ls[ls.length - 1]; else await sleep(150); }
    const dir = l ? configDirOf(l.pid) : '(no launch)';
    await ctx.close(); await killServer(server);
    const shown = [...seen];
    const neverOverride = !shown.some((t) => t.startsWith('plan A'));
    const saidUnknown = shown.some((t) => /account unknown — checking/.test(t));
    const held = neverOverride && saidUnknown && after.startsWith('plan B') && dir === B.dir;
    ok(held, `[${tag}] A2b a fact naming no account renders "account unknown — checking" (never the stale override "plan A"), converges to "plan B", and the resume runs on plan B (/proc)`, { shownWhileBlank: shown, after, resumeConfigDir: dir === B.dir ? 'B' : dir === A.dir ? 'A' : dir });
    return held;
  },

  /* C1/C2 — a live switch whose stop fails (injected). */
  async C1(ROOT, tag) { return stopFailCase(ROOT, tag, 'before'); },
  async C2(ROOT, tag) { return stopFailCase(ROOT, tag, 'after'); },
};

async function stopFailCase(ROOT, tag, mode) {
  const K = mode === 'before' ? 'C1' : 'C2';
  const fx = makeScratch(K.toLowerCase());
  const acc = await mintAccounts(ROOT, fx.DATA, ['plan A', 'plan B']); const A = acc['plan A'], B = acc['plan B'];
  const port = await freePort();
  const server = startServer(ROOT, fx, port, { stopfail: mode }); await waitHealth(port);
  const P = await project(ROOT, port, fx, `${K.toLowerCase()}proj`);
  await P.setAccount(A.id);
  for (let i = 0; i < 2; i++) await makeSession(port, P, { bindTo: B.id }); // busy state
  const sid = await makeSession(port, P); // unbound, on the project account A
  const ctx = await browser.newContext();
  const drv = await newPage(ctx); const view = await newPage(ctx);
  await drv.goto(P.link(sid)); await waitChip(drv, (t) => t.startsWith('plan A'), 15000);
  // The driving tab resumes the session (a real send): it is now LIVE in this tab, on A.
  const n0 = launchesOf(fx, sid).length;
  await uiSend(drv, 'hello again');
  let live = null; for (let i = 0; i < 100 && !live; i++) { const ls = launchesOf(fx, sid); if (ls.length > n0) live = ls[ls.length - 1]; else await sleep(150); }
  await sleep(1500);
  const liveDir = live ? configDirOf(live.pid) : '(no launch)';
  await view.goto(P.link(sid)); const v0 = await waitChip(view, (t) => t.startsWith('plan A'), 15000);
  const d0 = await chip(drv);
  // The switch to B, by a real click; the stop is made to fail.
  await pick(drv, 'plan B');
  await sleep(3500);
  const d1 = await chip(drv); const v1 = await chip(view);
  const dSaid = (await said(drv)).slice(-4);
  await shot(drv, `BUG-255-r3-${K}-${tag}.png`);
  const bind1 = bindingOf(fx, sid);
  const fact1 = (await jget(port, `/api/sessions/${sid}/account?projectId=${P.projectId}`)).body;
  const oldAlive1 = live ? alive(live.pid) : false;
  let oldGone = false; if (live) for (let i = 0; i < 60 && !oldGone; i++) { if (!alive(live.pid)) oldGone = true; else await sleep(150); }

  ok(!!live && liveDir === A.dir && d0.startsWith('plan A') && v0.startsWith('plan A'), `[${tag}] ${K} setup: the session is live in the driving tab on plan A (/proc); both tabs show plan A`, { liveDir: liveDir === A.dir ? 'A' : liveDir, d0, v0 });
  const failedSaid = dSaid.some((m) => /did NOT happen|not switch|could not stop/i.test(m)) && !dSaid.some((m) => /switched to plan B|recorded/i.test(m));
  const indicatorOld = d1 === 'plan A' && v1 === 'plan A';
  ok(failedSaid, `[${tag}] ${K} the failed stop is reported as a FAILED switch (not "switched", not "recorded for the next resume")`, { messages: dSaid });
  ok(indicatorOld && bind1 === undefined, `[${tag}] ${K} the binding stays on the old account and BOTH tabs show "plan A" as current with nothing pending`, { driving: d1, viewing: v1, binding: bind1 === undefined ? '(none — unchanged)' : bind1 === B.id ? 'B' : bind1, fact: { launch: fact1?.launch, bound: fact1?.bound, last: fact1?.last?.outcome } });

  let processOk; let detail;
  if (mode === 'before') {
    // KEEP SERVING: the old CLI still serves THIS tab on A — the next message goes to it, no new launch.
    const n1 = launchesOf(fx, sid).length;
    await uiSend(drv, 'still there?');
    await sleep(3000);
    const n2 = launchesOf(fx, sid).length;
    const errs = (await said(drv)).filter((m) => /driven in another tab|no session|already has a session/i.test(m));
    const servedByOld = oldAlive1 && alive(live.pid) && n2 === n1 && errs.length === 0 && configDirOf(live.pid) === A.dir;
    // Then the tab goes away: the session is released (idle → closed), not orphaned; a fresh tab resumes on A.
    await drv.close(); await view.close();
    let released = false; for (let i = 0; i < 80 && !released; i++) { if (!alive(live.pid)) released = true; else await sleep(150); }
    const fresh = await newPage(ctx); await fresh.goto(P.link(sid)); await waitChip(fresh, (t) => t.startsWith('plan'), 15000);
    const n3 = launchesOf(fx, sid).length;
    await uiSend(fresh, 'resume after the tab closed');
    let l = null; for (let i = 0; i < 100 && !l; i++) { const ls = launchesOf(fx, sid); if (ls.length > n3) l = ls[ls.length - 1]; else await sleep(150); }
    const freshDir = l ? configDirOf(l.pid) : '(no launch)';
    const fErrs = (await said(fresh)).filter((m) => /driven in another tab/i.test(m));
    processOk = servedByOld && released && freshDir === A.dir && fErrs.length === 0;
    detail = { oldStillServesThisTab: servedByOld, newLaunchesOnSend: n2 - n1, errors: errs, releasedWhenTabClosed: released, freshResumeDir: freshDir === A.dir ? 'A' : freshDir === B.dir ? 'B' : freshDir, freshErrors: fErrs };
    ok(processOk, `[${tag}] ${K} no orphan: the old CLI keeps serving the session on plan A in the same tab, is released when the tab goes, and a fresh resume runs on plan A (/proc)`, detail);
  } else {
    // REAP: teardown had begun, so nothing can serve the old CLI — it must be gone; the next message resumes on A.
    const n1 = launchesOf(fx, sid).length;
    await uiSend(drv, 'resume after the failed switch');
    let l = null; for (let i = 0; i < 100 && !l; i++) { const ls = launchesOf(fx, sid); if (ls.length > n1) l = ls[ls.length - 1]; else await sleep(150); }
    const nextDir = l ? configDirOf(l.pid) : '(no launch)';
    const errs = (await said(drv)).filter((m) => /driven in another tab/i.test(m));
    processOk = oldGone && nextDir === A.dir && errs.length === 0;
    detail = { oldCliReaped: oldGone, nextResumeDir: nextDir === A.dir ? 'A' : nextDir === B.dir ? 'B' : nextDir, errors: errs };
    ok(processOk, `[${tag}] ${K} no orphan: the half-stopped old CLI is reaped, and the next message resumes the session on plan A (/proc)`, detail);
  }
  await ctx.close(); await killServer(server);
  return failedSaid && indicatorOld && bind1 === undefined && processOk;
}

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
  console.log('\n== must-FAIL grading (the synthesized pre-fix tree must break every case)');
  // A pre-fix crash leaves its own FAIL line uncounted above, so count it here: an un-run must-FAIL is a failure.
  for (const k of Object.keys(pre)) ok(pre[k] === false, `must-FAIL: the pre-fix tree breaks ${k} (a crash is not a break)`, { prefixHeld: pre[k], fixedHeld: fixed[k] });
} else {
  console.log(`\n(must-FAIL half SKIPPED: no pre-fix tree at ${PRE_ROOT})`);
}
await browser.close();
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
