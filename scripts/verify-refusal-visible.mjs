/**
 * BUG-038 — a turn refusal must be VISIBLE where the user is looking (not
 * console-only), AND must only fire when the thing it blames is genuinely
 * still alive.
 *
 *   node scripts/verify-refusal-visible.mjs
 *
 * Two halves, both proven with a REAL browser (brave headless via playwright)
 * against a scratch server (:4317 and the real unit are never touched, kill by
 * pid only):
 *
 * VISIBILITY (the original charter). Every send-path refusal already sets
 * `say()` (#fine) in the source — this proves that text actually reaches the
 * DOM for the two real refusal shapes, not just the WS event:
 *   - ALIVE — the BUG-022 survivor-drain guard, driven with a real live dummy
 *     pid standing in for a draining broker. The composer keeps the text, #go
 *     is NOT stuck in "stop" mode, and a retry once the drain clears actually
 *     sends (a real turn runs to completion).
 *   - FRAMELESS — BUG-033's timer backstop (CodexRuntime HANG fixture),
 *     driven through the real UI (openTab + typeAndSend), not just the raw WS
 *     event verify-zombie-busy.mjs's scenario D already checks.
 *
 * CORRECTNESS (added after a live user report: "nothing was even running when
 * it was stopping me from sending"). The survivor guard used to refuse merely
 * because a `HostStatus` record EXISTED on disk — a corpse (broker + CLI both
 * exited) left behind by a finished turn kept blocking sends. This proves the
 * opposite shape: a STALE (dead) survivor must NOT block a send — the send
 * must go straight through, with the refusal text NEVER appearing.
 *
 * PRE-FIX (git stash the `src/server/index.ts` + `src/server/survival.ts`
 * hunks): the STALE scenario fails (blocked by a corpse) and the FRAMELESS
 * scenario's UI-visibility checks fail (scenario D in verify-zombie-busy.mjs
 * only ever asserted the raw WS event, never the DOM).
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const ASSETS = path.join(ROOT, 'docs', 'bugs', 'assets');
const BRAVE = process.env.QA_BRAVE_PATH ?? '/usr/bin/brave';

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${line}`);
  ok ? pass++ : (fail++, failures.push(name));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

/* ------------------------------------------------------------ scratch server */

const servers = new Set();
const tmpDirs = new Set();
const dummies = new Set();
function mkTmp(tag) { const d = fs.mkdtempSync(path.join(os.tmpdir(), `cs-b38-${tag}-`)); tmpDirs.add(d); return d; }
function storeFor(workDir) {
  const s = path.join(os.homedir(), '.claude', 'projects', workDir.replace(/[^a-zA-Z0-9]/g, '-'));
  tmpDirs.add(s);
  return s;
}

function startServer(port, dataDir, env = {}) {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: dataDir, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const log = [];
  child.stderr?.on('data', (d) => { log.push(String(d)); });
  servers.add(child);
  child.__log = log;
  return child;
}
/** Kill by PID only — never pkill (this machine also runs the user's real server). */
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ }
  servers.delete(child);
}

async function waitHealth(port, ms = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return true; } catch { /* not up */ }
    await sleep(250);
  }
  return false;
}
const health = async (port) => (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json());

async function registerProject(port, workDir, name, settings = {}) {
  const reg = await (await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: workDir, name }),
  })).json();
  if (!reg.project?.id) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(reg.project.id)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { permissionMode: 'bypassPermissions', model: 'haiku', ...settings } }),
  });
  return reg.project.id;
}

/* ------------------------------------------------------------------- ws/api */

function openWs(port) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const events = [];
    ws.on('message', (raw) => { try { events.push(JSON.parse(String(raw))); } catch { /* ignore */ } });
    ws.once('open', () => res({ ws, events, send: (o) => ws.send(JSON.stringify(o)) }));
    ws.once('error', rej);
  });
}
const waitEv = async (events, pred, ms = 120000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = events.find(pred);
    if (hit) return hit;
    await sleep(200);
  }
  return null;
};

/* ------------------------------------------------------------------ browser */

const READ_UI = () => ({
  busy: window.__station.state.busy,
  composer: document.querySelector('#prompt')?.value ?? '',
  fine: document.querySelector('#fine')?.textContent ?? '',
  fineHidden: document.querySelector('#fine')?.hidden ?? true,
  goMode: document.querySelector('#go')?.dataset?.mode ?? null,
  bodyText: document.body.textContent.slice(-4000),
  // BUG-045: the drain-wait queue contract for retryable refusals.
  queueCount: document.querySelectorAll('#queueBox .qrow').length,
  queueChip: document.querySelector('#queueBox .q-l')?.textContent ?? '',
  queueText: document.querySelector('#queueBox .qedit')?.value ?? '',
  // exactly-once probe: top-level "you" bubbles carrying the test marker
  youWithTest: [...document.querySelectorAll('#panes .pane .you')]
    .filter((n) => n.textContent.includes('keep-this-message')).length,
});
async function pollUi(page, pred, ms) {
  const t0 = Date.now();
  let ui = null;
  while (Date.now() - t0 < ms) {
    try { ui = await page.evaluate(READ_UI); } catch { /* navigating */ }
    if (ui && pred(ui)) return { ok: true, ui };
    await sleep(600);
  }
  return { ok: false, ui };
}
async function openTab(browser, port, projectId, sdkSessionId, encodedDir) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/#/project/${encodeURIComponent(projectId)}/session/${encodeURIComponent(sdkSessionId)}?dir=${encodeURIComponent(encodedDir)}`);
  await page.waitForFunction(() => window.__station && document.querySelector('#prompt'), undefined, { timeout: 25000 });
  await sleep(2500); // let openSession finish its liveness probe
  return page;
}
async function typeAndSend(page, text) {
  await page.fill('#prompt', text);
  await page.focus('#prompt');
  await page.keyboard.press('Enter');
}

/* --------------------------------------------------------------------- main */

let browser = null;

/**
 * ALIVE — the survivor-drain guard, genuinely mid-turn: visible refusal, text
 * kept, composer not stuck, and a retry once the drain clears actually sends.
 */
async function scenarioAlive() {
  console.log('\n===== ALIVE — genuinely-draining survivor: VISIBLE refusal, retry succeeds =====');
  const port = await freePort();
  const DATA = mkTmp('alive-data');
  const WORK = mkTmp('alive-work');
  storeFor(WORK);
  const ENCODED = WORK.replace(/[^a-zA-Z0-9]/g, '-');
  // Real survival disabled for the SEED turn: it must leave NO genuine broker
  // status file behind to interfere with the fixture this scenario plants —
  // the ONLY survivor record in the hosts dir must be the planted one.
  const srv = startServer(port, DATA, { CLAUDE_STATION_SURVIVE: '0' });
  if (!(await waitHealth(port))) throw new Error('scratch server never became healthy');
  const projectId = await registerProject(port, WORK, 'b38-alive');

  // A real, quick, completed turn to get a genuine on-disk sdkSessionId to
  // resume — then close the socket cleanly (not detached-live) so the ONLY
  // thing standing between the next resume and success is the planted survivor.
  const c0 = await openWs(port);
  c0.send({ type: 'start', projectId, prompt: 'Reply with exactly: SEED-OK' });
  const init = await waitEv(c0.events, (e) => e.t === 'session-init', 60000);
  check('PRECONDITION: a real seed turn started', !!init, { sessionId: init?.sessionId });
  const sdkSessionId = init.sessionId;
  await waitEv(c0.events, (e) => e.t === 'turn-end', 60000);
  c0.send({ type: 'close' });
  try { c0.ws.close(); } catch { /* ignore */ }
  await sleep(500);

  // Plant an ALIVE dummy broker for this exact session — the shape of a real
  // drain window right after a restart.
  const dummy = spawn('sleep', ['300'], { stdio: 'ignore', detached: true });
  dummy.unref();
  dummies.add(dummy);
  const hostsDir = path.join(DATA, 'session-hosts');
  fs.mkdirSync(hostsDir, { recursive: true });
  const key = `h-alive-${sdkSessionId.slice(0, 8)}`;
  const statusPath = path.join(hostsDir, `${key}.json`);
  fs.writeFileSync(statusPath, JSON.stringify({
    hostPid: dummy.pid, claudePid: dummy.pid, sock: path.join(hostsDir, `${key}.sock`),
    status: statusPath, sdkSessionId, resumeHint: sdkSessionId,
    state: 'draining', exitCode: null, signal: null, updatedAt: new Date().toISOString(),
  }), { mode: 0o600 });

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/#/project/${encodeURIComponent(projectId)}/session/${encodeURIComponent(sdkSessionId)}?dir=${encodeURIComponent(ENCODED)}`);
  await page.waitForFunction(() => window.__station && document.querySelector('#prompt'), undefined, { timeout: 25000 });
  await sleep(1500);
  const TESTMSG = 'BUG-038-ALIVE keep-this-message please';
  await typeAndSend(page, TESTMSG);

  // BUG-045: poll for the QUEUED shape — the retryable refusal must become a
  // visible drain-wait queue row (with the "waiting…" chip), NOT a composer
  // bounce. (Pre-fix: composer === TESTMSG, no queue row — these FAIL.)
  const refused = await pollUi(page, (ui) => ui.queueText === TESTMSG
    && /waiting for the previous turn to finish draining/.test(ui.queueChip), 15000);
  check('(visibility) the refusal is VISIBLE as a drain-wait queue chip naming why it waits',
    refused.ok, { chip: refused.ui?.queueChip, fine: refused.ui?.fine });
  check('(queued) the typed message is a QUEUE row, not bounced to the composer',
    refused.ui?.queueText === TESTMSG && refused.ui?.composer === '',
    { queueText: refused.ui?.queueText, composer: refused.ui?.composer });
  check('(enabled) the composer is NOT left disabled/stuck busy', refused.ui?.goMode === 'send' && refused.ui?.busy === false,
    { goMode: refused.ui?.goMode, busy: refused.ui?.busy });
  await page.screenshot({ path: path.join(ASSETS, 'BUG-038-alive-refusal-visible.png') });

  // The drain clears for real: kill the dummy broker. NO Enter is pressed from
  // here on — BUG-045's whole point is that the queued message sends ITSELF.
  try { process.kill(dummy.pid, 'SIGKILL'); } catch { /* already gone */ }
  for (let i = 0; i < 40; i++) { try { process.kill(dummy.pid, 0); await sleep(150); } catch { break; } }

  // A fast turn can start AND finish inside one poll gap — assert the end
  // state (queue empty, an honest completion line) rather than racing to
  // catch the transient busy:true in between.
  const done = await pollUi(page, (ui) => ui.busy === false && ui.queueCount === 0 && /\$[0-9]/.test(ui.fine), 75000);
  check('(auto-retry) after the drain clears the QUEUED message delivers ITSELF (no Enter) and the turn completes',
    done.ok, { queueCount: done.ui?.queueCount, busy: done.ui?.busy, fine: done.ui?.fine });
  check('(exactly-once) the message appears as exactly ONE transcript turn — no double-send, no loss',
    done.ui?.youWithTest === 1, { youWithTest: done.ui?.youWithTest });
  // Belt and braces: the on-disk store agrees — the marker was persisted as
  // exactly one USER message across this scratch project's transcripts.
  const store = storeFor(WORK);
  let userHits = 0;
  for (const f of (fs.existsSync(store) ? fs.readdirSync(store) : []).filter((x) => x.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(store, f), 'utf8').split('\n')) {
      if (line.includes(TESTMSG) && line.includes('"user"')) userHits++;
    }
  }
  check('(exactly-once, on disk) the store holds the marker as exactly ONE user message',
    userHits === 1, { userHits, store });
  await page.screenshot({ path: path.join(ASSETS, 'BUG-038-alive-retry-sent.png') });
  await page.close();
  stopByPid(srv);
}

/**
 * STALE — the CORRECTNESS half. A survivor record whose broker + CLI are BOTH
 * already dead (a corpse the sweep has not yet reaped) must not block the send
 * at all — the refusal text must NEVER appear, and the send goes straight
 * through as an ordinary resume.
 */
async function scenarioStale() {
  console.log('\n===== STALE — dead survivor corpse must NOT block the send (correctness fix) =====');
  const port = await freePort();
  const DATA = mkTmp('stale-data');
  const WORK = mkTmp('stale-work');
  storeFor(WORK);
  const ENCODED = WORK.replace(/[^a-zA-Z0-9]/g, '-');
  // Real survival disabled for the SEED turn — see scenarioAlive for why: the
  // only survivor record in the hosts dir must be the corpse this scenario plants.
  const srv = startServer(port, DATA, { CLAUDE_STATION_SURVIVE: '0' });
  if (!(await waitHealth(port))) throw new Error('scratch server never became healthy');
  const projectId = await registerProject(port, WORK, 'b38-stale');

  const c0 = await openWs(port);
  c0.send({ type: 'start', projectId, prompt: 'Reply with exactly: SEED-OK-2' });
  const init = await waitEv(c0.events, (e) => e.t === 'session-init', 60000);
  const sdkSessionId = init.sessionId;
  await waitEv(c0.events, (e) => e.t === 'turn-end', 60000);
  c0.send({ type: 'close' });
  try { c0.ws.close(); } catch { /* ignore */ }
  await sleep(500);

  // THE REAL REPORTED SHAPE: the broker's own PROCESS (hostPid, its systemd
  // scope) is still alive — so the OLD code's `scanSurvivingHosts` (which only
  // ever checked `pidAlive(hostPid)`) happily keeps this record — but the CLI
  // it was minding has already exited and the broker has recorded that fact.
  // A pid that is merely alive proves nothing about whether ITS TURN is still
  // running; `probeSurvivorHost` must consult `state`/`claudePid`, not just
  // "does the broker process still exist".
  const dummy = spawn('sleep', ['300'], { stdio: 'ignore', detached: true });
  dummy.unref();
  dummies.add(dummy);
  // A pid that has ALREADY exited can be silently reused by the OS by the time
  // we check it (flaky) — use a fixed pid far outside any real range instead,
  // which `pidAlive()` (ESRCH) always reports as dead.
  const deadCli = 1999999;
  const hostsDir = path.join(DATA, 'session-hosts');
  fs.mkdirSync(hostsDir, { recursive: true });
  const key = `h-stale-${sdkSessionId.slice(0, 8)}`;
  const statusPath = path.join(hostsDir, `${key}.json`);
  fs.writeFileSync(statusPath, JSON.stringify({
    hostPid: dummy.pid, claudePid: deadCli, sock: path.join(hostsDir, `${key}.sock`),
    status: statusPath, sdkSessionId, resumeHint: sdkSessionId,
    state: 'exited', exitCode: 0, signal: null, updatedAt: new Date().toISOString(),
  }), { mode: 0o600 });

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  if (process.env.B38_DEBUG) {
    await page.addInitScript(() => {
      window.__sent = [];
      const OrigWS = window.WebSocket;
      window.WebSocket = new Proxy(OrigWS, {
        construct(target, args) {
          const inst = new target(...args);
          const origSend = inst.send.bind(inst);
          inst.send = (data) => { window.__sent.push(String(data)); return origSend(data); };
          return inst;
        },
      });
    });
  }
  await page.goto(`http://127.0.0.1:${port}/#/project/${encodeURIComponent(projectId)}/session/${encodeURIComponent(sdkSessionId)}?dir=${encodeURIComponent(ENCODED)}`);
  await page.waitForFunction(() => window.__station && document.querySelector('#prompt'), undefined, { timeout: 25000 });
  await sleep(1500);
  const TESTMSG = 'Reply with exactly: BUG-038-STALE-DONE';
  await typeAndSend(page, TESTMSG);
  if (process.env.B38_DEBUG) {
    await sleep(1000);
    console.log('SENT FRAMES:', JSON.stringify(await page.evaluate(() => window.__sent)));
  }

  // A refused send never leaves the composer / never goes busy for real — so
  // proving delivery means proving a REAL turn actually ran, not just that the
  // text briefly appeared as an optimistic bubble (which paints before the
  // server has even finished processing the `start`, and a long transcript can
  // scroll the bubble out of bodyText's tail window regardless).
  const started = await pollUi(page, (ui) => ui.busy === true, 15000);
  check('THE FIX: the send is NOT blocked by the dead survivor — a REAL turn starts',
    started.ok, { busy: started.ui?.busy, fine: started.ui?.fine, composer: started.ui?.composer });
  const done = await pollUi(page, (ui) => ui.busy === false && /\$[0-9]/.test(ui.fine), 60000);
  check('…and the turn completes normally (reply rendered, composer empty)',
    done.ok && (done.ui?.bodyText ?? '').includes('BUG-038-STALE-DONE') && done.ui?.composer === '',
    { fine: done.ui?.fine, composer: done.ui?.composer, sawReply: done.ui?.bodyText.includes('BUG-038-STALE-DONE') });
  check('…and the stale "still finishing" refusal text never appeared at any point',
    !/still finishing its previous turn/.test(done.ui?.fine ?? ''), { fine: done.ui?.fine });
  const h1 = await health(port);
  check('the corpse was dropped from disk (does not keep lingering across sends)',
    !fs.existsSync(statusPath), {
      statusPathExists: fs.existsSync(statusPath), health: h1.sessions?.length,
      hostsDirNow: fs.existsSync(hostsDir) ? fs.readdirSync(hostsDir) : '(missing)',
    });
  if (process.env.B38_DEBUG) console.log('FULL SERVER LOG:\n' + srv.__log.join(''));
  await page.screenshot({ path: path.join(ASSETS, 'BUG-038-stale-not-blocked.png') });
  await page.close();
  stopByPid(srv);
}

/**
 * FRAMELESS — BUG-033's timer backstop, driven through the REAL UI (not just
 * the raw WS assertion verify-zombie-busy.mjs's scenario D already makes).
 */
async function scenarioFrameless() {
  console.log('\n===== FRAMELESS — BUG-033 timer backstop refusal, proven VISIBLE in the real DOM =====');
  const port = await freePort();
  const DATA = mkTmp('fl-data');
  const WORK = mkTmp('fl-work');
  storeFor(WORK);
  const ENCODED = WORK.replace(/[^a-zA-Z0-9]/g, '-');
  const FAKE = path.join(ROOT, 'scripts', 'fixtures', 'codex-fake-app-server.mjs');
  // BUG-045: the fixture's input log records the EXACT prompt text of every
  // turn the engine receives — the ground truth for the exactly-once check.
  const INPUT_LOG = path.join(DATA, 'codex-input.log');
  const srv = startServer(port, DATA, {
    CLAUDE_STATION_CODEX_BIN: FAKE, CLAUDE_STATION_REAP_SWEEP_MS: '0', CLAUDE_STATION_FRAMELESS_MS: '4000',
    CODEX_FAKE_INPUT_LOG: INPUT_LOG,
    // The auto-retry RESUMES the hung thread (the fixture mints thr_fixture_0001
    // deterministically) — without this the fixture treats the resume as a
    // protocol violation and the delivered turn dies engine-side.
    CODEX_FAKE_EXPECT_RESUME: 'thr_fixture_0001',
  });
  if (!(await waitHealth(port))) throw new Error('scratch server never became healthy');
  const projectId = await registerProject(port, WORK, 'b38-frameless', { provider: 'openai', model: null });

  const c = await openWs(port);
  c.send({ type: 'start', projectId, prompt: 'HANG until stopped' });
  const init = await waitEv(c.events, (e) => e.t === 'session-init', 60000);
  check('PRECONDITION: a real turn started then went silent (HANG)', !!init, { sessionId: init?.sessionId });
  const sdkSessionId = init.sessionId;
  try { c.ws.close(); } catch { /* detach, not close */ }
  await sleep(3000);
  const h0 = await health(port);
  check('PRECONDITION: inside the window it is still judged live', h0.sessions?.find((x) => x.sdkSessionId === sdkSessionId)?.liveness?.live === true,
    h0.sessions?.find((x) => x.sdkSessionId === sdkSessionId)?.liveness);
  await sleep(6000); // past the 4s window
  const h1 = await health(port);
  const s1 = h1.sessions?.find((x) => x.sdkSessionId === sdkSessionId);
  check('PRECONDITION: past the window the self-report stops vouching for it (frameless)',
    s1?.liveness?.live === false && s1?.liveness?.kind === 'frameless', s1?.liveness);

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/#/project/${encodeURIComponent(projectId)}/session/${encodeURIComponent(sdkSessionId)}?dir=${encodeURIComponent(ENCODED)}`);
  await page.waitForFunction(() => window.__station && document.querySelector('#prompt'), undefined, { timeout: 25000 });
  await sleep(1500);
  const TESTMSG = 'BUG-038-FRAMELESS keep-this-message';
  await typeAndSend(page, TESTMSG);

  // Same care as the ALIVE scenario: the tab's own pre-send "following live"
  // notice already fills #fine before we ever type — wait for the SPECIFIC
  // refusal shape. BUG-045: the frameless refusal is retryable:true, so it now
  // QUEUES (visible drain-wait row) instead of bouncing to the composer.
  const refused = await pollUi(page, (ui) => ui.queueText === TESTMSG && ui.queueCount === 1, 15000);
  check('(visibility) the frameless refusal is VISIBLE as a queue row + chip (not console-only)',
    refused.ok && (refused.ui?.queueChip ?? '') !== '', { chip: refused.ui?.queueChip, fine: refused.ui?.fine });
  check('(queued) the typed message is a QUEUE row, not bounced to the composer',
    refused.ui?.queueText === TESTMSG && refused.ui?.composer === '',
    { queueText: refused.ui?.queueText, composer: refused.ui?.composer });
  check('(enabled) the composer is NOT left disabled/stuck busy', refused.ui?.goMode === 'send' && refused.ui?.busy === false,
    { goMode: refused.ui?.goMode, busy: refused.ui?.busy });
  await page.screenshot({ path: path.join(ASSETS, 'BUG-038-frameless-refusal-visible.png') });

  // BUG-045: NO manual retry — the stale bridge was dropped at refusal time,
  // so the client's own slow-poll retry resumes from disk (the ordinary fresh
  // resume against the fixture) and the queued message delivers itself.
  const done = await pollUi(page, (ui) => ui.busy === false && ui.queueCount === 0 && ui.youWithTest >= 1, 60000);
  check('(auto-retry) after the frameless corpse is dropped the QUEUED message sends ITSELF (no Enter)',
    done.ok, { queueCount: done.ui?.queueCount, busy: done.ui?.busy, youWithTest: done.ui?.youWithTest });
  // Exactly-once is judged at the ENGINE, not the DOM: the fixture's input log
  // holds one JSON line per turn the engine actually received. (A codex RESUME
  // re-renders the delivered user message alongside the optimistic bubble —
  // a render duplication this same startTurn-resume path always had — so a
  // .you count would conflate rendering with delivery.)
  await sleep(500);
  const logLines = fs.existsSync(INPUT_LOG) ? fs.readFileSync(INPUT_LOG, 'utf8').split('\n').filter(Boolean) : null;
  const turns = logLines === null ? -1 : logLines.filter((l) => l.includes('keep-this-message')).length;
  check('(exactly-once) the ENGINE received the message as exactly ONE turn (fixture input log)',
    turns === 1, { engineTurnsWithMarker: turns, logTail: logLines?.slice(-4) ?? '(no log file)' });
  await page.screenshot({ path: path.join(ASSETS, 'BUG-038-frameless-retry-sent.png') });
  await page.close();
  try { c.ws.close(); } catch { /* ignore */ }
  stopByPid(srv);
}

async function main() {
  if (!fs.existsSync(BRAVE)) {
    console.error(`FATAL: browser not found at ${BRAVE} (set QA_BRAVE_PATH) — this bug is what the USER SEES, so the DOM must be asserted.`);
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(ASSETS, { recursive: true });
  browser = await chromium.launch({ headless: true, executablePath: BRAVE });
  const only = process.argv[2];
  if (!only || only === 'alive') await scenarioAlive();
  if (!only || only === 'stale') await scenarioStale();
  if (!only || only === 'frameless') await scenarioFrameless();
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(async () => {
  try { await browser?.close(); } catch { /* ignore */ }
  for (const s of [...servers]) stopByPid(s);
  for (const d of dummies) { try { process.kill(d.pid, 'SIGKILL'); } catch { /* gone */ } }
  await sleep(800);
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
});
