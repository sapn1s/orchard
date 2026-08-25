/**
 * BUG-149 — a message refused because the session is live in another tab must
 * not vanish, and the refusal must not reach only the console.
 *
 * The live loss, exactly as reported: the user sent a message from a second
 * tab, it looked sent, no reply ever came, and the only trace was a
 * `console.log` line. On reload the text was gone and had to be retyped.
 *
 * This drives a REAL browser (the second tab, the user's seat) against a REAL
 * server, with a REAL first tab holding the session — a raw socket that has
 * started a REAL turn, which is precisely what the server's guard tests
 * (`running && !running.detached`). Nothing here is a mock of the refusal: the
 * frame is produced by the same code path the user hit.
 *
 * What is asserted, in the user's terms:
 *   1. The refusal is ON SCREEN — a visible banner with the server's sentence —
 *      not merely in the console.
 *   2. The banner is TRUE: it says another tab is driving it and that this tab
 *      can watch read-only. (The structural reason is in the code refs: the
 *      bridge has one #emit sink and attach() replaces it.)
 *   3. The typed text is still there, in the dock, saying NOT delivered.
 *   4. It is in browser storage, and it SURVIVES A RELOAD still marked unsent.
 *   5. It is recoverable without retyping — one click puts it in the composer.
 *   6. A message queued BEFORE the refusal is not mislabelled dead: the session
 *      is alive, and the old fatal path lied about that too.
 *   7. No optimistic "you" bubble is left claiming the message was delivered.
 *   8. MUST-FAIL: the identical script run against a SYNTHESIZED pre-fix client
 *      (the live-elsewhere branch mechanically disabled, so the frame falls into
 *      the generic fatal path exactly as it did before this fix) loses the text
 *      and shows no banner. The baseline is CONSTRUCTED, never `git show HEAD`,
 *      so committing the fix cannot turn this proof into decoration.
 *
 *   node scripts/verify-bug-149-live-elsewhere.mjs
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRATCH_ROOT = process.env.ORCHARD_SCRATCH || path.join(os.homedir(), 'scratch');
fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
const SCRATCH = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'bug149-'));
const DATA = path.join(SCRATCH, 'data');
const PROFILE = path.join(SCRATCH, 'chrome');
const WORK = path.join(SCRATCH, 'work');
for (const d of [DATA, PROFILE, WORK]) fs.mkdirSync(d, { recursive: true });
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
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

/* ------------------------------------------------------------------- CDP */
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.on = new Map(); }
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
      } else if (m.method && c.on.has(m.method)) c.on.get(m.method)(m.params);
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
  async waitFor(label, expr, timeoutMs = 30_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (await this.eval(expr)) return true; } catch { /* navigating */ }
      await sleep(150);
    }
    console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
    return false;
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

/*
 * The MUST-FAIL baseline, CONSTRUCTED rather than checked out. Disabling the
 * `code === 'live-elsewhere'` branch drops the frame into the generic fatal
 * path — which is byte-for-byte the arrangement that lost the user's message:
 * say() to the strip + console, sessError latched, failQueue, and a `return`
 * before anything reclaims state.pendingStart. The hit count is asserted, so a
 * transform that stops matching throws instead of quietly proving nothing.
 */
function preFixClient() {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const from = `      if (e.code === 'live-elsewhere') {`;
  const to = `      if (false && e.code === 'live-elsewhere') { /* PRE-FIX: falls into the fatal path */`;
  const hits = src.split(from).length - 1;
  if (hits !== 1) throw new Error(`pre-fix transform matched ${hits}x (expected 1)`);
  return src.replace(from, to);
}

/** A REAL reload, proved to be one (a same-document nav would pass vacuously). */
async function reload(cdp, label) {
  await cdp.eval(`window.__reloadMarker149 = 'same-document'`);
  await cdp.send('Page.reload', { ignoreCache: true });
  if (!await cdp.waitFor(`reboot (${label})`, `window.__station !== undefined`, 45_000)) {
    throw new Error(`the page never came back after the ${label} reload`);
  }
  if (await cdp.eval(`window.__reloadMarker149 ?? null`) !== null) {
    throw new Error(`the ${label} "reload" did not reload the document — the check would be vacuous`);
  }
}

/*
 * A screenshot per decisive moment. Functional assertions cannot tell a clear
 * banner from an ugly or unreadable one, and this fix is entirely about what a
 * person can SEE — so the run leaves images to be looked at.
 */
const SHOTS = path.join(SCRATCH_ROOT, 'bug149-shots');
fs.mkdirSync(SHOTS, { recursive: true });
async function shot(cdp, name) {
  try {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const f = path.join(SHOTS, `${name}.png`);
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
    console.log(`        screenshot: ${f}`);
  } catch (e) { console.log(`        (screenshot ${name} failed: ${e.message})`); }
}

const DOCK = `(() => ({
  rows: [...document.querySelectorAll('#queueBox .qrow')].map((r) => ({
    status: r.querySelector('.qs')?.textContent ?? '',
    text: r.querySelector('.qedit')?.value ?? '',
    dead: r.classList.contains('dead'),
    restored: r.classList.contains('restored'),
    acts: [...r.querySelectorAll('.cacts button')].map((b) => b.textContent),
  })),
  label: document.querySelector('#queueBox .q-l')?.textContent ?? '',
  hidden: document.querySelector('#queueBox').hidden,
}))()`;

// What the user can actually READ. `offsetParent === null` catches a banner
// that exists in the DOM but is hidden — the shape this bug is about.
const BANNER = `(() => {
  const b = document.querySelector('#liveElsewhere');
  if (!b) return { present: false };
  return { present: true, hidden: !!b.hidden, visible: b.offsetParent !== null, text: b.textContent ?? '' };
})()`;

const typeSend = (t) => `(() => {
  const p = document.querySelector('#prompt');
  p.value = ${JSON.stringify(t)};
  p.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
})()`;

/* ------------------------------------------------------------------- run */
let server = null, browser = null, tabA = null;
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

const PORT = Number(await freePort());
const BASE = `http://127.0.0.1:${PORT}`;

const MSG = 'Reply with exactly: SECOND-TAB-MESSAGE';
const PRE_QUEUED = 'Reply with exactly: ALREADY-QUEUED';

async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: WORK, name: 'bug149-fixture' }),
  })).json();
  const pid = reg.project?.id;
  if (!pid) throw new Error(`register failed: ${JSON.stringify(reg)}`);

  /* --- TAB A: a real first tab, holding a real live session --------------- */
  console.log('\n=== 0. the FIRST tab starts a real session and keeps driving it ===');
  const events = [];
  const wsA = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((res, rej) => { wsA.once('open', res); wsA.once('error', rej); });
  tabA = wsA;
  wsA.on('message', (raw) => { try { events.push(JSON.parse(String(raw))); } catch { /* ignore */ } });
  wsA.send(JSON.stringify({
    type: 'start', projectId: pid, overrides: { model: 'haiku' },
    prompt: 'Reply with exactly: FIRST-TAB-READY',
  }));
  const t0 = Date.now();
  let init = null;
  while (Date.now() - t0 < 180_000 && !init) { init = events.find((e) => e.t === 'session-init'); await sleep(200); }
  if (!init?.sessionId) throw new Error('the first tab never got a session — cannot test the two-tab refusal');
  const sdkId = init.sessionId;
  // Wait for the turn to end so the second tab is not merely racing a busy turn:
  // the refusal under test is about OWNERSHIP, not about being mid-reply.
  const t1 = Date.now();
  while (Date.now() - t1 < 240_000 && !events.some((e) => e.t === 'turn-end')) await sleep(250);
  check('PRECONDITION: a real session is live and ATTACHED to the first tab (idle, not mid-turn)',
    events.some((e) => e.t === 'turn-end') && wsA.readyState === WebSocket.OPEN, sdkId);

  /* --- TAB B: the browser, the user's seat -------------------------------- */
  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 120 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  if (!devPort) throw new Error('the browser never opened a devtools port');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  // The pre-fix leg substitutes app.js through Fetch interception; a memory-
  // cached copy would silently defeat it and "prove" the fix against itself.
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

  const legs = [
    { name: 'FIXED (this working tree)', prefix: 'fixed', prefix_fix: true },
    { name: 'PRE-FIX (live-elsewhere branch disabled)', prefix: 'prefix', prefix_fix: false },
  ];
  const results = {};

  for (const leg of legs) {
    console.log(`\n########## ${leg.name} ##########`);
    if (!leg.prefix_fix) {
      const body = preFixClient();
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*app.js*', requestStage: 'Request' }] });
      cdp.on.set('Fetch.requestPaused', (p) => {
        void cdp.send('Fetch.fulfillRequest', {
          requestId: p.requestId, responseCode: 200,
          responseHeaders: [{ name: 'content-type', value: 'text/javascript' }, { name: 'cache-control', value: 'no-store' }],
          body: Buffer.from(body).toString('base64'),
        }).catch(() => { /* raced a nav */ });
      });
    }
    // A clean slate per leg: the dock is durable now, so a leftover row from the
    // other leg would make the second leg's assertions meaningless.
    await cdp.send('Page.navigate', { url: `${BASE}/` });
    await cdp.waitFor('boot', `window.__station !== undefined`, 45_000);
    await cdp.eval(`localStorage.clear()`);

    const r = await runLeg(cdp, pid, sdkId, leg.prefix_fix);
    results[leg.prefix] = r;
    if (!leg.prefix_fix) {
      cdp.on.delete('Fetch.requestPaused');
      await cdp.send('Fetch.disable');
    }
  }

  /* --- the must-FAIL comparison ------------------------------------------ */
  console.log('\n=== 8. MUST-FAIL: the pre-fix client loses the message and says nothing ===');
  const pre = results.prefix, fix = results.fixed;
  check('PRE-FIX: the refusal is nowhere the user can see it (no visible banner)',
    !pre.banner.visible, JSON.stringify(pre.banner).slice(0, 200));
  check('PRE-FIX: the typed text is in NO dock row — it is gone',
    !pre.dock.rows.some((x) => x.text.includes('SECOND-TAB-MESSAGE')),
    JSON.stringify(pre.dock.rows.map((x) => x.text)));
  check('PRE-FIX: and it is in NO browser storage either — the reload had nothing to bring back',
    !(pre.stored ?? '').includes('SECOND-TAB-MESSAGE'), (pre.stored ?? '(nothing stored)').slice(0, 160));
  check('FIXED: the same actions keep it (banner seen, text kept) — the difference is the fix, not the fixture',
    fix.banner.visible && fix.dock.rows.some((x) => x.text.includes('SECOND-TAB-MESSAGE')),
    JSON.stringify({ banner: fix.banner.visible, texts: fix.dock.rows.map((x) => x.text) }));

  cdp.close();
}

/** One end-to-end pass of the user's story. Returns what was on screen. */
async function runLeg(cdp, pid, sdkId, fixed) {
  const label = fixed ? '' : ' [pre-fix]';
  const P = (n, ok, obs) => (fixed ? check(n, ok, obs) : console.log(`  (pre-fix) ${n}: ${JSON.stringify(obs).slice(0, 160)}`));

  console.log(`\n=== 1. the second tab opens the same session by CLICKING it in the sidebar${label} ===`);
  // The real click-path: expand the project in the sidebar tree, then click the
  // live session row — exactly the two clicks the user made.
  await cdp.waitFor('the project in the sidebar',
    `[...document.querySelectorAll('#tree .proj')].some(p => /bug149-fixture/.test(p.textContent))`, 60_000);
  await cdp.eval(`(() => {
    const p = [...document.querySelectorAll('#tree .proj')].find((x) => /bug149-fixture/.test(x.textContent));
    if (p && !document.querySelector('#tree .row')) p.click();
  })()`);
  const sawRow = await cdp.waitFor('a live session row in the sidebar',
    `[...document.querySelectorAll('#tree .row')].some(r => r.dataset.live)`, 60_000);
  if (!sawRow) throw new Error('the second tab never saw the live session in the sidebar');
  await cdp.eval(`(() => {
    [...document.querySelectorAll('#tree .row')].find((x) => x.dataset.live).click();
  })()`);
  const opened = await cdp.waitFor('the session on screen',
    `window.__station.state.current.sessionId === ${JSON.stringify(sdkId)}`, 60_000);
  P('the second tab has the SAME session open, read-only (no socket of its own)', opened,
    await cdp.eval(`({ sid: window.__station.state.current.sessionId, live: window.__station.state.live })`));

  console.log(`\n=== 2. a message is queued here first, then the refused one is typed${label} ===`);
  // A pre-existing row: the old fatal path marked EVERY queued row dead ("the
  // session hit a fatal error"), which was false. This is the witness for that.
  await cdp.eval(`window.__station.queueMessage(${JSON.stringify(PRE_QUEUED)}); window.__station.paintQueue();`);
  await cdp.eval(typeSend(MSG));
  const refused = await cdp.waitFor('the refusal to land',
    `window.__station.state.busy === false && window.__station.state.pendingStart === null`, 60_000);
  if (!refused && fixed) console.log('        (the client never settled the refusal)');

  await sleep(1200); // let the repaint that follows the frame settle
  const banner = await cdp.eval(BANNER);
  const dock = await cdp.eval(DOCK);
  // Only OUR message matters here: the transcript legitimately contains the
  // first tab's real prompt, which was delivered and must stay on screen.
  const bubbles = await cdp.eval(
    `[...document.querySelectorAll('#panes .you')].filter((b) => /SECOND-TAB-MESSAGE/.test(b.textContent)).length`);
  // The other half of the same race: rolling back by "the last .you" can remove
  // the FIRST tab's real, delivered message instead. That is a transcript lie
  // in the opposite direction, so it is asserted explicitly.
  const innocent = await cdp.eval(
    `[...document.querySelectorAll('#panes .you')].filter((b) => /FIRST-TAB-READY/.test(b.textContent)).length`);

  if (fixed) {
    await shot(cdp, '1-refused-banner-and-dock');
    console.log('\n=== 3. the refusal is ON SCREEN, and it is true ===');
    check('a banner is visible in the interface (not only console.log)', banner.visible,
      JSON.stringify(banner).slice(0, 320));
    check('it names the cause (another tab is driving it) and what is still possible here (read-only)',
      /another tab/i.test(banner.text) && /read-only/i.test(banner.text), banner.text.slice(0, 240));
    // A screenshot caught the first attempt rendering BELOW the composer, off
    // the bottom of the viewport — present, visible, correct, and unreadable.
    // Position is asserted so that cannot come back silently.
    const order = await cdp.eval(`(() => {
      const b = document.querySelector('#liveElsewhere');
      const dock = document.querySelector('#queueBox');
      const box = document.querySelector('#box');
      const PRECEDING = Node.DOCUMENT_POSITION_FOLLOWING;
      return {
        aboveDock: !!(b.compareDocumentPosition(dock) & PRECEDING),
        aboveComposer: !!(b.compareDocumentPosition(box) & PRECEDING),
        inViewport: b.getBoundingClientRect().bottom <= window.innerHeight + 1,
      };
    })()`);
    check('the sentence after the bold lead reads as a sentence (not "… . this session is")',
      /Open in another tab\. [A-Z]/.test(banner.text), banner.text.slice(0, 60));
    check('and it is where it can be read: above the dock and the composer, inside the viewport',
      order.aboveDock && order.aboveComposer && order.inViewport, JSON.stringify(order));

    console.log('\n=== 4. the typed text is kept, and says it was NOT delivered ===');
    const row = dock.rows.find((x) => x.text.includes('SECOND-TAB-MESSAGE'));
    check('the message is a dock row the user can read', !!row, JSON.stringify(dock.rows.map((x) => x.text)));
    check('and that row SAYS it was not delivered, naming the reason',
      !!row && row.dead && /NOT delivered/.test(row.status) && /another tab/i.test(row.status),
      row ? row.status : '(no row)');
    check('no optimistic bubble is left claiming the refused message was delivered',
      bubbles === 0, `${bubbles} "you" bubble(s) carrying the refused text`);
    check('and the OTHER tab\'s real, delivered message was not removed in its place',
      innocent === 1, `${innocent} "you" bubble(s) carrying the first tab's delivered prompt`);

    console.log('\n=== 5. the session is alive, so nothing else is mislabelled dead ===');
    const other = dock.rows.find((x) => x.text.includes('ALREADY-QUEUED'));
    check('a message queued before the refusal is still pending, not marked dead by it',
      !!other && !other.dead && !/NOT delivered/.test(other.status), other ? other.status : '(no row)');
    // Also caught by the screenshot, not by any assertion: the dock announced
    // "1 queued message · delivering…" in a tab that holds no socket and cannot
    // deliver anything. The dock is where a user checks whether their words got
    // out; it must not be the thing that misleads them.
    check('the dock does not promise a delivery this tab cannot make',
      !/delivering/.test(dock.label) && /not driving the session/.test(dock.label), dock.label);
  }

  console.log(`\n=== 6. it is in browser storage, and survives a reload${label} ===`);
  const stored = await cdp.eval(`localStorage.getItem(window.__station.QUEUE_KEY)`);
  if (fixed) {
    check('the refused text is in durable browser storage (the BUG-129 store)',
      typeof stored === 'string' && stored.includes('SECOND-TAB-MESSAGE'),
      (stored ?? '(nothing stored)').slice(0, 200));
  }
  await reload(cdp, fixed ? 'post-refusal' : 'post-refusal (pre-fix)');
  const back = await cdp.waitFor('the dock to come back', `document.querySelectorAll('#queueBox .qrow').length > 0`, 30_000);
  const afterReload = await cdp.eval(DOCK);
  if (fixed) {
    await shot(cdp, '2-after-reload-still-unsent');
    const row = afterReload.rows.find((x) => x.text.includes('SECOND-TAB-MESSAGE'));
    check('AFTER A RELOAD the user still has their words, without retyping', back && !!row,
      JSON.stringify(afterReload.rows.map((x) => x.text)));
    check('and it still says it is unsent', !!row && /unsent|NOT delivered/i.test(row.status),
      row ? row.status : '(no row)');

    console.log('\n=== 7. it is recoverable in one click, and never auto-resent ===');
    check('a restored, undelivered row offers a way back into the composer',
      !!row && row.acts.some((a) => /composer/i.test(a)), row ? JSON.stringify(row.acts) : '(no row)');
    await cdp.eval(`(() => {
      const rows = [...document.querySelectorAll('#queueBox .qrow')];
      const r = rows.find((x) => (x.querySelector('.qedit')?.value ?? '').includes('SECOND-TAB-MESSAGE'));
      [...r.querySelectorAll('.cacts button')].find((b) => /composer/i.test(b.textContent)).click();
    })()`);
    const inBox = await cdp.eval(`document.querySelector('#prompt').value`);
    check('one click puts the exact text back in the composer', String(inBox).includes('SECOND-TAB-MESSAGE'),
      String(inBox).slice(0, 120));
  }

  return { banner, dock, stored, afterReload };
}

try {
  await main();
} catch (e) {
  fail++; failures.push(`harness: ${e.message}`);
  console.error('\n  HARNESS ERROR:', e.stack ?? e.message);
} finally {
  try { tabA?.close(); } catch { /* gone */ }
  stopByPid(browser);
  stopByPid(server);
  await sleep(600);
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* leave it */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log(`failed: ${failures.join(' | ')}`);
process.exit(fail ? 1 : 0);
