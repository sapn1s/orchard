/**
 * BUG-001 — the skip-permissions toggle on a FOLLOWED (terminal-driven, no
 * dashboard bridge) session must never lie:
 *
 *   1. Persistence: arming it and reloading must keep the SAME session's
 *      armed state (the `persistOverrides`/`restoreOverrides` machinery,
 *      keyed by encodedDir+sessionId, must cover the no-bridge/follow path
 *      exactly like it covers the bridged path — verified already by
 *      verify-overrides.mjs).
 *   2. No lying affordance: because there is no bridge to send
 *      `set-permission-mode` to, the toggle can only ARM a takeover — it
 *      must never look like it changed the terminal session's live mode.
 *      `state.followingExternal` + `paintPerm()`'s `external` branch is the
 *      code path responsible; this test asserts the toggle, its title, and
 *      the seal chip all say "armed / only if you take over", never a bare
 *      "confirmed"/"from next send" claim that implies a live effect it
 *      cannot have.
 *
 * Fixture: an EXTERNAL session (like verify-agent-summary.mjs) — a session
 * file that is "live" purely by mtime recency, drivenByDashboard:false, no
 * bridge. That is exactly the terminal-driven case from the bug report.
 *
 *   node scripts/verify-skip-perms-followed.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const PORT = Number(process.env.VERIFY_SKIPFOLLOW_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-skf-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-skf-chrome-'));
const ASSETS = path.join(ROOT, 'docs', 'bugs', 'assets');
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';

let pass = 0, fail = 0;
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : fail++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const c = new Cdp(ws);
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.id && c.waiting.has(m.id)) {
        const { res, rej } = c.waiting.get(m.id);
        c.waiting.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.waiting.set(id, { res, rej }));
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  }
  async waitFor(label, expr, timeoutMs = 20_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (await this.eval(expr)) return true; } catch { /* nav */ }
      await sleep(150);
    }
    console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
    return false;
  }
  async screenshot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

let server = null, browser = null;
const cleanupDirs = [DATA, PROFILE];
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

const uid = (n) => `00000000-0000-4000-f000-${String(n).padStart(12, '0')}`;

/** A session file written by "another process" (a terminal), no bridge. */
function makeExternalSession(store, sid) {
  const ts = new Date().toISOString();
  const lines = [
    JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', uuid: uid(1), timestamp: ts, sessionId: sid,
      message: { role: 'user', content: [{ type: 'text', text: 'terminal-driven session' }] } }),
    JSON.stringify({ parentUuid: uid(1), isSidechain: false, type: 'assistant', uuid: uid(2), timestamp: ts, sessionId: sid,
      message: { role: 'assistant', content: [{ type: 'text', text: 'working from the terminal.' }] } }),
  ];
  const f = path.join(store, `${sid}.jsonl`);
  fs.writeFileSync(f, lines.join('\n') + '\n');
  return f;
}

async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-skf-proj-'));
  cleanupDirs.push(projDir);
  const encoded = projDir.replace(/[/.]/g, '-');
  const store = path.join(os.homedir(), '.claude', 'projects', encoded);
  fs.mkdirSync(store, { recursive: true });
  cleanupDirs.push(store);
  const sid = 'ffffffff-3333-4333-8333-333333333333';
  const file = makeExternalSession(store, sid);
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: projDir, name: 'skipfollow-fixture' }),
  })).json();
  const pid = reg.project?.id;
  if (!pid) throw new Error(`register failed: ${JSON.stringify(reg)}`);

  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');

  // Keep the fixture "live" by mtime across the whole run: touch it again
  // right before each navigation, exactly like verify-agent-summary.mjs.
  const touch = () => execFileSync('touch', [file]);
  const url = `${BASE}/#/project/${pid}/session/${sid}?dir=${encodeURIComponent(encoded)}`;
  const openIt = () => { touch(); return cdp.send('Page.navigate', { url }); };

  await openIt();
  await cdp.waitFor('session open', `window.__station?.state.current.sessionId === ${JSON.stringify(sid)}`, 30_000);
  await cdp.waitFor('followingExternal set', `window.__station.state.followingExternal === true`, 15_000);

  console.log('\n=== followed/external session: toggle never claims a live effect ===');
  const before = await cdp.eval(`({
    pressed: document.querySelector('#skipBtn').getAttribute('aria-pressed'),
    live: window.__station.state.live,
    external: window.__station.state.followingExternal,
  })`);
  check('starts un-armed, confirmed NOT live, confirmed external-follow',
    before.pressed === 'false' && before.live === false && before.external === true, JSON.stringify(before));
  await cdp.screenshot(path.join(ASSETS, 'BUG-001-followed-before.png'));

  await cdp.eval(`document.querySelector('#skipBtn').click()`);
  await cdp.waitFor('armed', `document.querySelector('#skipBtn').getAttribute('aria-pressed') === 'true'`);
  const armed = await cdp.eval(`({
    pressed: document.querySelector('#skipBtn').getAttribute('aria-pressed'),
    ovr: window.__station.state.overrides.permissionMode ?? null,
    externalFlag: document.querySelector('#skipBtn').dataset.external,
    title: document.querySelector('#skipBtn').title,
    chip: document.querySelector('#seal .perm')?.textContent ?? '',
    chipTitle: document.querySelector('#seal .perm')?.title ?? '',
    say: document.querySelector('#fine')?.textContent ?? '',
    live: window.__station.state.live,
  })`);
  check('toggle arms the override (recorded, not sent live)',
    armed.pressed === 'true' && armed.ovr === 'bypassPermissions' && armed.live === false, JSON.stringify(armed));
  check('the toggle is marked data-external and its title says it ONLY applies on takeover (not "confirmed"/live)',
    armed.externalFlag === 'true'
      && /take over/i.test(armed.title)
      && !/confirmed/i.test(armed.title),
    JSON.stringify({ externalFlag: armed.externalFlag, title: armed.title }));
  check('the seal chip names "if you take over", not a bare "from next send" (which would imply the dashboard is driving)',
    /take over/i.test(armed.chip) || /take over/i.test(armed.chipTitle),
    JSON.stringify({ chip: armed.chip, chipTitle: armed.chipTitle }));
  check('the toast said this arms a takeover, not that it changed anything running now',
    /take over|armed/i.test(armed.say) && !/confirmed by the server/i.test(armed.say),
    armed.say);
  await cdp.screenshot(path.join(ASSETS, 'BUG-001-followed-armed.png'));

  console.log('\n=== reload of the SAME followed session: state stays honest ===');
  await openIt(); // full navigate == reload semantics for this SPA's hash route
  await sleep(500);
  await cdp.waitFor('session reopen', `window.__station?.state.current.sessionId === ${JSON.stringify(sid)}`, 30_000);
  await cdp.waitFor('followingExternal set again', `window.__station.state.followingExternal === true`, 15_000);
  const after = await cdp.eval(`({
    pressed: document.querySelector('#skipBtn').getAttribute('aria-pressed'),
    ovr: window.__station.state.overrides.permissionMode ?? null,
    externalFlag: document.querySelector('#skipBtn').dataset.external,
    live: window.__station.state.live,
  })`);
  check('after reload the armed override for THIS session survived (persisted, not reset to OFF)',
    after.pressed === 'true' && after.ovr === 'bypassPermissions', JSON.stringify(after));
  check('…and it is STILL honestly marked external/not-live (no bridge exists to have confirmed it)',
    after.live === false && after.externalFlag === 'true', JSON.stringify(after));
  await cdp.screenshot(path.join(ASSETS, 'BUG-001-followed-after-reload.png'));

  console.log('\n=== disarm also persists honestly ===');
  await cdp.eval(`document.querySelector('#skipBtn').click()`);
  await cdp.waitFor('disarmed', `document.querySelector('#skipBtn').getAttribute('aria-pressed') === 'false'`);
  await openIt();
  await sleep(500);
  await cdp.waitFor('session reopen 2', `window.__station?.state.current.sessionId === ${JSON.stringify(sid)}`, 30_000);
  const disarmed = await cdp.eval(`({
    pressed: document.querySelector('#skipBtn').getAttribute('aria-pressed'),
    ovr: window.__station.state.overrides.permissionMode ?? null,
  })`);
  check('disarm also survives reload (no zombie re-arm)',
    disarmed.pressed === 'false' && disarmed.ovr === null, JSON.stringify(disarmed));

  cdp.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exitCode = 1;
}).finally(() => {
  stopByPid(browser);
  stopByPid(server);
  setTimeout(() => {
    for (const d of cleanupDirs) fs.rmSync(d, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  }, 2500);
});
