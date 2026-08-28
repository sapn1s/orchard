/**
 * FEAT-108 round 3 — the git-write REQUEST → APPROVE flow, in the Orchard UI.
 *
 * The user's correction to round 2: the grant must live in the UI (no CLI as the
 * way), and the orchestrator must be able to REQUEST permission — the request
 * surfaces on the Needs-You rail, the user Allows/Declines with one click, and
 * the agent then does the git work. Round 2's grant store + gate enforcement
 * stay; this round adds the request/approve rail and the git-panel toggle.
 *
 * WHAT THIS DRIVES (real server + real headless brave, no fixtures for the flow):
 *   A. In-process enforcement seam — a grant minted with grantedVia
 *      'request-approval' is subject to the MANDATORY leak gate exactly like any
 *      other: allow on a clean scratch repo, REFUSE (fail-closed) on a leaking
 *      one. The approval mint is not special-cased around the gate.
 *   B. SELF-APPROVAL DEFENCE (the safety property): an agent hitting ONLY the
 *      request endpoint — the surface added for agents — can NEVER produce a
 *      grant, no matter how many times it calls. Proven against the real server:
 *      request once → no grant; request again → still no grant. A grant appears
 *      only after the USER answers "Allow" on the rail.
 *   C. The request surfaces on the board feed as a git-write permission card
 *      (marker + Allow/Decline), renders in the real rail UI, and:
 *        · click Allow  → grant becomes ACTIVE (visible via the grant route)
 *        · the git panel shows the state at a glance + a direct Revoke toggle
 *        · Revoke → grant gone
 *        · a second request → click Decline → NO grant, card leaves the rail
 *      Screenshots captured in both themes and asserted non-empty.
 *
 * MUST-FAIL baseline: run with VERIFY_APP_ROOT at a pre-change worktree — the
 * request route is absent (400 fallthrough), the rail card never appears, and
 * the git-panel pill does not exist, so B and C fail there. A passes both sides
 * only for the round-2 mechanics; the 'request-approval' grantedVia label and
 * the request/rail/toggle are round-3-only.
 *
 *   node scripts/verify-feat-108-git-request-approve.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import { grantGitWrite, revokeGitWrite, _resetGitGrantsForTest } from './lib/git-grant-store.mjs';
import { evaluateGitWrite } from './lib/git-grant.mjs';

const SCRATCH = process.env.VERIFY_SCRATCH ?? path.join(os.homedir(), 'scratch');
const RUN = path.join(SCRATCH, `gitreq-${Date.now()}`);
fs.mkdirSync(RUN, { recursive: true });
const SHOTS = path.join(RUN, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });
const DATA = path.join(RUN, 'data'); fs.mkdirSync(DATA, { recursive: true });
const STORE = path.join(RUN, 'store'); fs.mkdirSync(STORE, { recursive: true });
const PROFILE = path.join(RUN, 'chrome'); fs.mkdirSync(PROFILE, { recursive: true });
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';
const APP_ROOT = process.env.VERIFY_APP_ROOT ?? path.resolve(import.meta.dirname, '..');
const REPO = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(APP_ROOT, 'src', 'server', 'index.ts');

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
const PORT = Number(process.env.VERIFY_GITREQ_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : fail++;
}
const ENV = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
function git(cwd, args) { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...ENV } }).trim(); }

// The REAL leak gate over a scratch repo → { ok, detail }.
function realGate(repoPath) {
  try {
    execFileSync(process.execPath, [path.join(REPO, 'scripts', 'leak-gate.mjs'), '--summary'], { cwd: repoPath, stdio: 'pipe', timeout: 30_000 });
    return { ok: true, detail: 'clean' };
  } catch (e) {
    return { ok: false, detail: (e.stdout?.toString() || e.message || 'gate failed').slice(0, 120) };
  }
}

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
async function sessionIdFor(projectId) {
  const t0 = Date.now();
  while (Date.now() - t0 < 20_000) {
    const h = await (await fetch(`${BASE}/api/health`)).json().catch(() => ({ sessions: [] }));
    const s = (h.sessions ?? []).find((x) => x.projectId === projectId && (x.stationSessionId || x.sdkSessionId));
    if (s) return s.stationSessionId || s.sdkSessionId;
    await sleep(200);
  }
  throw new Error('no live session id surfaced');
}
const grantOf = async (pid) => (await (await fetch(`${BASE}/api/projects/${pid}/git-write-grant`)).json()).grant;
const requestWrite = (sid, body) => fetch(`${BASE}/api/sessions/${sid}/git-write-request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const boardFeed = async (pid) => (await fetch(`${BASE}/api/projects/${pid}/board`)).json();

// Read the rail's git-write card as the user sees it.
const CARD = `(() => {
  const c=[...document.querySelectorAll('.needs-card.git-write')];
  return c.map(card=>({ id:card.dataset.id, idLabel:card.querySelector('.nc-id')?.textContent??'',
    title:card.querySelector('.nc-title')?.textContent??'',
    opts:[...card.querySelectorAll('.nc-opt')].map(b=>b.textContent),
    hasTextbox:!!card.querySelector('.nc-input') }));
})()`;
const clickOpt = (label, id) => `(() => { const card=document.querySelector('.needs-card.git-write[data-id=${JSON.stringify(id)}]'); if(!card)return false; const b=[...card.querySelectorAll('.nc-opt')].find(x=>x.textContent===${JSON.stringify(label)}); if(!b)return false; b.click(); return true; })()`;
// Read the git panel's permission pill.
const PILL = `(() => { const w=document.querySelector('.gt-gitwrite'); if(!w)return null;
  return { on:w.dataset.on, state:w.querySelector('.gt-gw-state')?.textContent??'',
    allowShown:!document.querySelector('.gt-gw-allow')?.hidden, revokeShown:!document.querySelector('.gt-gw-revoke')?.hidden }; })()`;

async function main() {
  // ===== A: in-process enforcement seam — approval-minted grant obeys the gate =
  console.log('\n=== A: an approval-minted grant is still subject to the mandatory leak gate ===');
  try {
    _resetGitGrantsForTest();
    const KEY = 'proj-A';
    const clean = path.join(RUN, 'clean'); fs.mkdirSync(clean, { recursive: true }); git(clean, ['init', '-q']);
    fs.writeFileSync(path.join(clean, 'a.txt'), 'nothing secret\n');
    const leaky = path.join(RUN, 'leaky'); fs.mkdirSync(leaky, { recursive: true }); git(leaky, ['init', '-q']);
    // A home path + username — the exact BUG-155 class the gate exists to catch.
    fs.writeFileSync(path.join(leaky, 'ticket.md'), `see /home/${os.userInfo().username}/projects/private-thing\n`);

    grantGitWrite(KEY, { scope: 'duration', ttlMs: 60_000, grantedVia: 'request-approval', note: 'please let me commit' });
    const cleanRes = evaluateGitWrite({ command: 'git commit -m x', projectKey: KEY, env: {}, runLeakGate: () => realGate(clean) });
    check('a commit under an approval-minted grant is ALLOWED over a clean repo', cleanRes.allow === true && cleanRes.granted === true, cleanRes);

    grantGitWrite(KEY, { scope: 'duration', ttlMs: 60_000, grantedVia: 'request-approval' });
    const leakRes = evaluateGitWrite({ command: 'git commit -m x', projectKey: KEY, env: {}, runLeakGate: () => realGate(leaky) });
    check('the SAME grant REFUSES a commit over a leaking repo (gate fail-closed)', leakRes.allow === false && leakRes.gateFailed === true, { allow: leakRes.allow, gateFailed: leakRes.gateFailed, detail: leakRes.reason?.slice?.(0, 80) });
    check('a publishing write with no gate runner at all fails closed under the grant',
      evaluateGitWrite({ command: 'git push', projectKey: KEY, env: {}, runLeakGate: null }).allow === false, 'no-runner→deny');
    _resetGitGrantsForTest();
  } catch (e) {
    check('A: scratch git available', false, e.message);
  }

  // ===== boot server + one live session ======================================
  server = spawn(process.execPath, [ENTRY], {
    cwd: APP_ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE, CLAUDE_STATION_CLAUDE_BIN: FAKE, CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => { const s = String(d); if (/git-write/i.test(s)) process.stderr.write(`  [server] ${s}`); });
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');
  console.log(`app root: ${APP_ROOT}`);

  const work = path.join(RUN, 'work'); fs.mkdirSync(work, { recursive: true });
  git(work, ['init', '-b', 'main']);
  fs.writeFileSync(path.join(work, 'a.txt'), 'one\n');
  git(work, ['add', '-A']); git(work, ['commit', '-m', 'first']);
  const pid = await register(work, 'req-me');
  await startLiveSession(pid);
  const sid = await sessionIdFor(pid);

  // ===== B: the self-approval defence — the request endpoint never grants =====
  console.log('\n=== B: an agent hitting the request endpoint can never grant itself ===');
  check('MUST-FAIL(pre-change): before any request, no grant is active', (await grantOf(pid)) === null, await grantOf(pid));
  const r1 = await requestWrite(sid, { reason: 'commit the fifteen tickets of work', scope: 'duration', minutes: 30 });
  const r1b = await r1.json();
  check('the request route accepts an agent request (201, pending, NOT granted)',
    r1.status === 201 && r1b.pending === true && r1b.granted === false && !!r1b.id, { status: r1.status, pending: r1b.pending, granted: r1b.granted });
  check('after the request, STILL no grant — the request is inert', (await grantOf(pid)) === null, await grantOf(pid));
  // Try to force it: call the agent-facing endpoint repeatedly.
  for (let i = 0; i < 3; i++) await requestWrite(sid, { reason: `retry ${i}`, scope: 'duration', minutes: 30 });
  check('calling the request endpoint repeatedly produces NO grant (self-grant closed)', (await grantOf(pid)) === null, await grantOf(pid));

  // ===== C: the request surfaces + the user approves + the panel toggle =======
  console.log('\n=== C1: the request surfaces on the board feed as a git-write card ===');
  const feed = await boardFeed(pid);
  const cardItem = (feed.needsYou ?? []).find((x) => x.gitWrite && x.id === r1b.id);
  check('the request appears on the Needs-You feed with a gitWrite marker', !!cardItem && cardItem.gitWrite.reason.includes('fifteen tickets'), cardItem?.gitWrite);
  check('the card offers Allow and Decline as options', Array.isArray(cardItem?.options) && cardItem.options.join(',') === 'Allow,Decline', cardItem?.options);

  // Drive the real UI.
  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0', '--no-first-run', '--disable-extensions', '--window-size=1400,900', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) { try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); } }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');

  console.log('\n=== C2: the card renders in the real rail; both themes ===');
  await cdp.send('Page.navigate', { url: `${BASE}/#/` });
  const shown = await cdp.waitFor('git-write card', `document.querySelectorAll('.needs-card.git-write').length>0`, 30_000);
  const cards = shown ? await cdp.eval(CARD) : [];
  const card = cards.find((c) => c.id === r1b.id) ?? cards[0];
  check('the rail shows a git-write permission card (🔑 label, no free-text box)',
    !!card && /git-write request/.test(card.idLabel) && card.hasTextbox === false, card);
  check('the rail card offers one-click Allow and Decline', card && card.opts.join(',') === 'Allow,Decline', card?.opts);
  await cdp.eval(`document.documentElement.dataset.theme='light'`); await sleep(150); await cdp.shot(path.join(SHOTS, 'rail-card-light.png'));
  await cdp.eval(`document.documentElement.dataset.theme='dark'`); await sleep(150); await cdp.shot(path.join(SHOTS, 'rail-card-dark.png'));

  console.log('\n=== C3: click Allow → a grant becomes active ===');
  const clickedAllow = await cdp.eval(clickOpt('Allow', r1b.id));
  check('the Allow button is clickable', clickedAllow, clickedAllow);
  const granted = await (async () => { const t0 = Date.now(); while (Date.now() - t0 < 15_000) { if (await grantOf(pid)) return true; await sleep(200); } return false; })();
  const g = await grantOf(pid);
  check('approving in the UI mints an active grant (via request-approval)', granted && g?.grantedVia === 'request-approval', g);

  console.log('\n=== C4: the git panel shows the state at a glance + a direct Revoke ===');
  await cdp.send('Page.navigate', { url: `${BASE}/#/git/changes?project=${pid}` });
  await cdp.waitFor('git panel', `!!document.querySelector('.gt-gitwrite')`, 30_000);
  await cdp.waitFor('pill shows allowed', `document.querySelector('.gt-gitwrite')?.dataset.on==='true'`, 10_000);
  const pill1 = await cdp.eval(PILL);
  check('the git panel pill reads "allowed" and offers Revoke (not Allow)',
    pill1 && pill1.on === 'true' && /allowed/i.test(pill1.state) && pill1.revokeShown === true && pill1.allowShown === false, pill1);
  await cdp.eval(`document.documentElement.dataset.theme='light'`); await sleep(150); await cdp.shot(path.join(SHOTS, 'panel-allowed-light.png'));
  await cdp.eval(`document.documentElement.dataset.theme='dark'`); await sleep(150); await cdp.shot(path.join(SHOTS, 'panel-allowed-dark.png'));

  console.log('\n=== C5: Revoke from the panel → grant gone ===');
  await cdp.eval(`document.querySelector('.gt-gw-revoke').click()`);
  const revoked = await (async () => { const t0 = Date.now(); while (Date.now() - t0 < 10_000) { if ((await grantOf(pid)) === null) return true; await sleep(200); } return false; })();
  await cdp.waitFor('pill flips to blocked', `document.querySelector('.gt-gitwrite')?.dataset.on==='false'`, 10_000);
  const pill2 = await cdp.eval(PILL);
  check('Revoke clears the grant and the pill flips back to blocked + Allow', revoked && pill2.on === 'false' && pill2.allowShown === true, pill2);
  await cdp.eval(`document.documentElement.dataset.theme='light'`); await sleep(150); await cdp.shot(path.join(SHOTS, 'panel-blocked-light.png'));
  await cdp.eval(`document.documentElement.dataset.theme='dark'`); await sleep(150); await cdp.shot(path.join(SHOTS, 'panel-blocked-dark.png'));

  console.log('\n=== C6: a fresh request → Decline → NO grant ===');
  const r2 = await (await requestWrite(sid, { reason: 'one push please', scope: 'once' })).json();
  await cdp.send('Page.navigate', { url: `${BASE}/#/` });
  await cdp.waitFor('second card', `[...document.querySelectorAll('.needs-card.git-write')].some(c=>c.dataset.id===${JSON.stringify(r2.id)})`, 30_000);
  await cdp.shot(path.join(SHOTS, 'rail-decline-light.png'));
  const declined = await cdp.eval(clickOpt('Decline', r2.id));
  check('the Decline button is clickable', declined, declined);
  await sleep(1500);
  check('declining mints NO grant', (await grantOf(pid)) === null, await grantOf(pid));
  // Authoritative: the declined request is resolved and gone from the board feed
  // (the rail is a mirror of this). Then confirm the UI drops it too.
  const feedAfter = await (async () => { const t0 = Date.now(); let f; while (Date.now() - t0 < 12_000) { f = await boardFeed(pid); if (!(f.needsYou ?? []).some((x) => x.id === r2.id)) return f; await sleep(300); } return f; })();
  check('the declined request is resolved and leaves the board feed', !(feedAfter.needsYou ?? []).some((x) => x.id === r2.id), (feedAfter.needsYou ?? []).map((x) => x.id));
  const gone = await cdp.waitFor('card removed', `![...document.querySelectorAll('.needs-card.git-write')].some(c=>c.dataset.id===${JSON.stringify(r2.id)})`, 12_000);
  check('the declined card leaves the rail', gone, gone);

  // Screenshots are read by a human reviewer; assert they are non-trivial.
  const shots = fs.readdirSync(SHOTS).filter((f) => f.endsWith('.png'));
  check('screenshots captured for human visual review (both themes)', shots.length >= 6 && shots.every((f) => fs.statSync(path.join(SHOTS, f)).size > 2000), shots);

  cdp.close();
  console.log(`\nscreenshots in ${SHOTS}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => { console.error(`\nFATAL: ${err.message}\n${err.stack}`); process.exitCode = 1; })
  .finally(() => { for (const ws of liveWs) { try { ws.close(); } catch { /* gone */ } } stopByPid(browser); stopByPid(server); setTimeout(() => process.exit(process.exitCode ?? 0), 2000); });
