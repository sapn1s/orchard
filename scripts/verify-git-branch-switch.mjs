/**
 * BRANCH SWITCHING from the Git panel (the user's "our github desktop
 * recreation, missing ability to switch branches … sessions keep working on
 * some branch and i wanna change").
 *
 * Drives the REAL git-view UI in headless brave against scratch repos with
 * several local branches, a local bare "origin" carrying a remote-only branch,
 * and (for the refusal case) a dirty working tree. Nothing on a real repo,
 * nothing on a network. Every claim is checked by reading git state afterwards,
 * not by trusting the UI.
 *
 * Covered:
 *   1. list — the Branches tab lists local + remote branches (anti-regression)
 *   2. switch a local branch — HEAD actually moves
 *   3. create a branch from HEAD — new branch exists and is current
 *   4. NEW: check out a remote branch as a new tracking branch
 *   5. refuse honestly on a dirty tree — buttons disabled + server 409 with
 *      git's real "uncommitted changes" text, HEAD unchanged (no stash/discard)
 *   6. NEW: warn when sessions are live — banner with the count, switch gated
 *      behind an explicit confirm, then the switch proceeds
 *
 * MUST-FAIL baseline: run with VERIFY_APP_ROOT pointed at a pre-change checkout
 * (a worktree at HEAD). Checks 4 and 6 fail there (remote rows inert / route
 * absent / no live count); 1-3 and 5 pass both sides (anti-regression).
 *
 *   node scripts/verify-git-branch-switch.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

const SCRATCH = process.env.VERIFY_SCRATCH ?? path.join(os.homedir(), 'scratch');
const RUN = path.join(SCRATCH, `gitbranch-${Date.now()}`);
fs.mkdirSync(RUN, { recursive: true });
const SHOTS = path.join(RUN, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });
const DATA = path.join(RUN, 'data'); fs.mkdirSync(DATA, { recursive: true });
const STORE = path.join(RUN, 'store'); fs.mkdirSync(STORE, { recursive: true });
const PROFILE = path.join(RUN, 'chrome'); fs.mkdirSync(PROFILE, { recursive: true });
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';
const APP_ROOT = process.env.VERIFY_APP_ROOT ?? path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(APP_ROOT, 'src', 'server', 'index.ts');

// The scripted fake `claude` — a single idle turn, so the started session stays
// a LIVE (non-closed) bridge for the project without any real engine.
const FAKE = path.join(RUN, 'fake-claude.mjs');
fs.writeFileSync(FAKE, `
import * as readline from 'node:readline';
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
let started = false;
rl.on('line', (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.type === 'control_request') { say({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } }); return; }
  if (m.type !== 'user' || started) return;
  started = true;
  say({ type: 'system', subtype: 'init', session_id: 'fakesdk-' + process.pid, cwd: process.cwd(), model: 'haiku', tools: [], slash_commands: [] });
  say({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [ { type: 'text', text: 'idle' } ] } });
  say({ type: 'result', subtype: 'success', total_cost_usd: 0 });
});
process.stdin.resume();
`);

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
const PORT = Number(process.env.VERIFY_GITBRANCH_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : fail++;
}
const ENV = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
function git(cwd, args) { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...ENV } }).trim(); }
function gitRaw(cwd, args) { try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ...ENV } }).trim(); } catch { return 'ERR'; } }
const head = (cwd) => gitRaw(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const c = new Cdp(ws);
    ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && c.waiting.has(m.id)) { const { res, rej } = c.waiting.get(m.id); c.waiting.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } });
    return c;
  }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.waiting.set(id, { res, rej })); }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  }
  async waitFor(label, expr, timeoutMs = 20_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) { try { if (await this.eval(expr)) return true; } catch { /* nav */ } await sleep(150); }
    console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
    return false;
  }
  async shot(file) { const r = await this.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

// Phase 1: a bare "origin" + a `main` with one commit, pushed. Registration
// (next) scaffolds Orchard onboarding files into the tree, so branches are
// created only AFTER that scaffold is committed — exactly as a user would
// commit before switching.
function makeBase(tag) {
  const work = path.join(RUN, `${tag}-work`);
  const bare = path.join(RUN, `${tag}-bare.git`);
  fs.mkdirSync(work, { recursive: true });
  git(work, ['init', '-b', 'main']);
  fs.writeFileSync(path.join(work, 'a.txt'), 'one\n');
  git(work, ['add', '-A']); git(work, ['commit', '-m', 'first']);
  git(RUN, ['init', '--bare', bare]);
  git(work, ['remote', 'add', 'origin', bare]);
  git(work, ['push', '-u', 'origin', 'main']);
  return { work, bare, tag };
}
// Phase 2 (after register): commit whatever onboarding scaffolded, then build a
// clean set of branches (feature-a, rebrand/kenimai current) and a remote-only
// origin/hotfix visible after fetch.
async function finishBranches(p) {
  const t0 = Date.now();
  while (Date.now() - t0 < 15_000 && !fs.existsSync(path.join(p.work, 'CLAUDE.md'))) await sleep(200);
  await sleep(1000); // let the scaffold settle so a late write does not re-dirty
  if (gitRaw(p.work, ['status', '--porcelain'])) { git(p.work, ['add', '-A']); git(p.work, ['commit', '-m', 'onboard']); }
  git(p.work, ['branch', 'feature-a']);
  git(p.work, ['switch', '-c', 'rebrand/kenimai']);
  fs.writeFileSync(path.join(p.work, 'b.txt'), 'rebranded\n');
  git(p.work, ['add', '-A']); git(p.work, ['commit', '-m', 'Rebranding to Kenimai']);
  const other = path.join(RUN, `${p.tag}-other`);
  git(RUN, ['clone', p.bare, other]);
  git(other, ['switch', '-c', 'hotfix']);
  fs.writeFileSync(path.join(other, 'h.txt'), 'hot\n');
  git(other, ['add', '-A']); git(other, ['commit', '-m', 'a hotfix']);
  git(other, ['push', '-u', 'origin', 'hotfix']);
  git(p.work, ['fetch', 'origin']);
}

let server = null, browser = null;
const liveWs = [];
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}
async function register(hostPath, name) {
  const r = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath, name }) })).json();
  if (!r.project?.id) throw new Error(`register failed: ${JSON.stringify(r)}`);
  return r.project.id;
}
// Start a real (fake-engine) live session, held open for the project.
async function startLiveSession(projectId) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`); const events = [];
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => { try { events.push(JSON.parse(String(raw))); } catch {} });
  ws.on('error', () => {});
  liveWs.push(ws);
  ws.send(JSON.stringify({ type: 'start', projectId, overrides: { model: 'haiku', permissionMode: 'bypassPermissions' }, prompt: 'stay' }));
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) { if (events.find((e) => e.t === 'agent-started' || (e.t === 'ack' && e.of === 'start'))) return; await sleep(150); }
  throw new Error('live session never started');
}

// Read the branches list the way the user sees it.
const BRANCHES = `(() => {
  const rows=[...document.querySelectorAll('.gt-branch-row')].map(r=>({name:r.querySelector('.gt-branch-name')?.textContent,current:r.dataset.current==='true',remote:r.dataset.remote==='true',disabled:r.querySelector('.gt-branch-name')?.disabled}));
  const warn=document.querySelector('.gt-live-warn');
  return { rows, chip:document.querySelector('.gt-branch')?.textContent??'', err:document.querySelector('.gt-view-error')?.textContent??'',
    reason:document.querySelector('.gt-create .gt-reason')?.textContent??'',
    live: warn?{msg:warn.querySelector('.gt-live-msg')?.textContent??'',confirm:!!warn.querySelector('.gt-live-confirm'),confirmed:warn.dataset.confirmed==='true'}:null };
})()`;

async function openBranches(cdp, pid) {
  await cdp.send('Page.navigate', { url: `${BASE}/#/git/branches?project=${pid}` });
  await cdp.waitFor('branches list', `document.querySelectorAll('.gt-branch-row').length>0`, 30_000);
  await sleep(400);
  return cdp.eval(BRANCHES);
}
const clickBranch = (cdp, name) => cdp.eval(`(() => { const b=[...document.querySelectorAll('.gt-branch-name')].find(x=>x.textContent===${JSON.stringify(name)}); if(!b||b.disabled)return false; b.click(); return true; })()`);

async function main() {
  server = spawn(process.execPath, [ENTRY], {
    cwd: APP_ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE, CLAUDE_STATION_CLAUDE_BIN: FAKE, CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');
  console.log(`app root: ${APP_ROOT}`);

  const p = makeBase('sw');
  const live = makeBase('live');
  const pid = await register(p.work, 'switch-me');
  const lid = await register(live.work, 'live-me');
  await finishBranches(p);
  await finishBranches(live);

  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0', '--no-first-run', '--disable-extensions', '--window-size=1400,900', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) { try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); } }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');

  // --- 1: list ---------------------------------------------------------------
  console.log('\n=== 1: Branches tab lists local + remote branches ===');
  const s1 = await openBranches(cdp, pid);
  const names = s1.rows.map((r) => r.name);
  check('lists all three local branches (main, feature-a, rebrand/kenimai)',
    ['main', 'feature-a', 'rebrand/kenimai'].every((n) => names.includes(n)), names);
  check('lists the remote branch origin/hotfix as a distinct remote row',
    s1.rows.some((r) => r.remote && r.name === 'origin/hotfix'), s1.rows.filter((r) => r.remote).map((r) => r.name));
  check('current branch rebrand/kenimai is marked current (its switch button disabled)',
    s1.rows.find((r) => r.name === 'rebrand/kenimai')?.current === true, s1.chip);
  await cdp.eval(`document.documentElement.dataset.theme='light'`); await sleep(150); await cdp.shot(path.join(SHOTS, 'list-light.png'));
  await cdp.eval(`document.documentElement.dataset.theme='dark'`); await sleep(150); await cdp.shot(path.join(SHOTS, 'list-dark.png'));

  // --- 2: switch a local branch ---------------------------------------------
  console.log('\n=== 2: switch to a local branch — HEAD actually moves ===');
  check('sanity: on rebrand/kenimai before switch', head(p.work) === 'rebrand/kenimai', head(p.work));
  check('feature-a switch button is clickable (clean tree, no live sessions)', await clickBranch(cdp, 'feature-a'), 'clicked');
  const moved = await (async () => { const t0 = Date.now(); while (Date.now() - t0 < 15_000) { if (head(p.work) === 'feature-a') return true; await sleep(150); } return false; })();
  check('clicking feature-a moved the repo HEAD to feature-a', moved, head(p.work));

  // --- 3: create a branch from HEAD -----------------------------------------
  console.log('\n=== 3: create a branch from current HEAD ===');
  await openBranches(cdp, pid);
  await cdp.eval(`(() => { const i=document.querySelector('.gt-new-branch'); i.value='spike/new-idea'; i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await sleep(150);
  await cdp.eval(`document.querySelector('.gt-create button').click()`);
  const created = await (async () => { const t0 = Date.now(); while (Date.now() - t0 < 15_000) { if (head(p.work) === 'spike/new-idea') return true; await sleep(150); } return false; })();
  check('creating spike/new-idea makes it exist and become current', created && gitRaw(p.work, ['rev-parse', '--verify', 'spike/new-idea']) !== 'ERR', head(p.work));

  // --- 4: check out a remote branch as a tracking branch --------------------
  console.log('\n=== 4: check out a remote branch as a new tracking branch ===');
  await openBranches(cdp, pid);
  check('sanity: no local hotfix branch yet', gitRaw(p.work, ['rev-parse', '--verify', 'refs/heads/hotfix']) === 'ERR', 'absent');
  const clickedRemote = await clickBranch(cdp, 'origin/hotfix');
  check('origin/hotfix is a real, clickable checkout control (not an inert label)', clickedRemote, clickedRemote);
  const tracked = await (async () => { const t0 = Date.now(); while (Date.now() - t0 < 15_000) { if (head(p.work) === 'hotfix') return true; await sleep(150); } return false; })();
  check('checking out origin/hotfix created local hotfix and switched to it', tracked, head(p.work));
  check('local hotfix tracks origin/hotfix', gitRaw(p.work, ['rev-parse', '--abbrev-ref', 'hotfix@{upstream}']) === 'origin/hotfix', gitRaw(p.work, ['rev-parse', '--abbrev-ref', 'hotfix@{upstream}']));

  // --- 5: refuse honestly on a dirty tree -----------------------------------
  console.log('\n=== 5: dirty tree — refuse honestly, never stash/discard ===');
  fs.writeFileSync(path.join(p.work, 'a.txt'), 'DIRTY EDIT\n');
  const s5 = await openBranches(cdp, pid);
  const beforeDirty = head(p.work);
  check('with a dirty tree every local switch button is disabled', s5.rows.filter((r) => !r.remote && !r.current).every((r) => r.disabled), s5.rows.filter((r) => !r.remote).map((r) => `${r.name}:${r.disabled}`));
  check('the panel explains WHY switching is blocked (uncommitted changes)', /uncommitted changes/i.test(s5.reason), s5.reason);
  // The server itself must refuse with git's real words, and touch nothing.
  const refusal = await (await fetch(`${BASE}/api/projects/${pid}/git/switch-branch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'main' }) }));
  const refusalBody = await refusal.json();
  check('server refuses a switch on a dirty tree (409) with real uncommitted-changes text', refusal.status === 409 && /uncommitted changes/i.test(refusalBody.error || ''), { status: refusal.status, error: refusalBody.error });
  check('the refused switch did NOT move HEAD and did NOT discard the dirty edit',
    head(p.work) === beforeDirty && fs.readFileSync(path.join(p.work, 'a.txt'), 'utf8') === 'DIRTY EDIT\n', head(p.work));
  fs.writeFileSync(path.join(p.work, 'a.txt'), 'one\n'); // clean up for later reads
  await cdp.eval(`document.documentElement.dataset.theme='light'`); await sleep(150); await cdp.shot(path.join(SHOTS, 'dirty-light.png'));

  // --- 6: warn when sessions are live ---------------------------------------
  console.log('\n=== 6: live sessions in the project — warn + confirm before switch ===');
  await startLiveSession(lid);
  await sleep(600);
  const s6 = await openBranches(cdp, lid);
  check('server reports the live session and the panel shows a live-session warning', s6.live && /1 session live/.test(s6.live.msg), s6.live);
  check('while live sessions are unconfirmed, switch buttons are gated (disabled)', s6.rows.filter((r) => !r.current).every((r) => r.disabled) && s6.live.confirm, s6.rows.map((r) => `${r.name}:${r.disabled}`));
  const blockedClick = await clickBranch(cdp, 'main');
  check('a live-gated branch cannot be switched without confirming', blockedClick === false && head(live.work) === 'rebrand/kenimai', head(live.work));
  await cdp.eval(`document.documentElement.dataset.theme='dark'`); await sleep(150); await cdp.shot(path.join(SHOTS, 'live-warn-dark.png'));
  await cdp.eval(`document.querySelector('.gt-live-confirm').click()`); await sleep(300);
  const afterConfirm = await cdp.eval(BRANCHES);
  check('confirming ("Switch anyway") enables the switch buttons', afterConfirm.rows.filter((r) => !r.current).some((r) => !r.disabled) && afterConfirm.live?.confirmed === true, afterConfirm.live);
  const okClick = await clickBranch(cdp, 'main');
  const liveMoved = await (async () => { const t0 = Date.now(); while (Date.now() - t0 < 15_000) { if (head(live.work) === 'main') return true; await sleep(150); } return false; })();
  check('after an explicit confirm the switch proceeds and HEAD moves', okClick && liveMoved, head(live.work));

  cdp.close();
  for (const ws of liveWs) { try { ws.close(); } catch { /* gone */ } }
  console.log(`\nscreenshots in ${SHOTS}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => { console.error(`\nFATAL: ${err.message}\n${err.stack}`); process.exitCode = 1; })
  .finally(() => { for (const ws of liveWs) { try { ws.close(); } catch { /* gone */ } } stopByPid(browser); stopByPid(server); setTimeout(() => process.exit(process.exitCode ?? 0), 2000); });
