/**
 * FEAT-083 — structured response digest envelope.
 *
 *   npm run verify:feat-083
 *
 * Drives a REAL browser (brave --headless=new over raw CDP; the same rig
 * verify:bug-067 uses) against a REAL server, then renders FIXTURE assistant
 * messages through the app's OWN transcript renderer (renderMessages) and
 * asserts on the resulting DOM. No CLI turn is spawned — the fixtures ARE the
 * transcript — so the run is fast, free, and pollutes nothing.
 *
 * Four scenarios, over the SAME render path:
 *   1. WELL-FORMED digest + prose  -> structured .digest list (grouped, no
 *      emoji, refs link), and the raw JSON is HIDDEN; prose renders below.
 *   2. NO digest                   -> prose renders unchanged (must-FAIL guard:
 *      the prose sentence must be present).
 *   3. MALFORMED digest + prose    -> digest DROPPED, but ALL content survives
 *      (must-FAIL: the prose AND the broken-JSON token must both still render —
 *      a parse error must never hide the message).
 *   4. DISABLED for the project    -> the SAME well-formed fixture is NOT parsed:
 *      no .digest, the raw JSON shows as a code block, prose shows. This is also
 *      the pre-fix baseline: over identical input, scenario 1 (enabled) hides the
 *      JSON and builds the list; scenario 4 (disabled) does neither.
 *
 * Plus a server round-trip: PATCH responseDigest.enabled=false persists, and a
 * fresh project defaults to enabled=true.
 *
 * Process hygiene: OS-assigned free port (never 4317). Kill children by PID
 * only, never pkill.
 */
import { spawn } from 'node:child_process';
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
const PORT = Number(process.env.VERIFY_FEAT_083_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f083-data-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f083-store-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f083-work-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f083-chrome-'));
const BRAVE = process.env.VERIFY_FEAT_083_BROWSER ?? 'brave';

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : (fail++, failures.push(name));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------- raw CDP */
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
  async waitFor(label, expr, timeoutMs = 30_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (await this.eval(expr)) return true; } catch { /* mid-navigation */ }
      await sleep(150);
    }
    console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
    return false;
  }
  close() { try { this.ws.close(); } catch { /* already gone */ } }
}

/* ------------------------------------------------------------- processes */
let server = null, browser = null;
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

/* ------------------------------------------------------------- fixtures */
const SENTINEL = 'ZEBRAFINCH';
const BROKEN = 'BROKENJSONXYZ';

// A REALISTIC-STATE well-formed digest: a busy turn with all four kinds, mixed
// importance, a ticket ref (link), a plain-label ref (inert), then real prose
// below with markdown the app must still render (bold + a list).
// BUG-095 follow-up: the sentences are full length, so in the panel they WRAP to
// two or three lines — the normal case for a real digest. The earlier one-line
// fixture made the card look better than it is; the visual sign-off (and the
// /tmp shoot harness that reuses this rig) needs the wrapping shape.
const WELL_FORMED =
  '```orchard-digest\n' +
  JSON.stringify({
    items: [
      { text: 'Rebuilt the digest card as a hairline-bounded ticket list: kind rides a tinted rail plus an eyebrow, importance rides ink contrast alone, and refs are inline chips.', kind: 'done', importance: 'high', ref: 'FEAT-083' },
      { text: 'Wired the per-project disable flag through the settings PATCH route and the project defaults, so an opt-out survives a restart.', kind: 'done', importance: 'med' },
      { text: 'Need your call on whether the response digest ships enabled by default for every project, or stays opt-in until the schema settles.', kind: 'decision', importance: 'high', ref: 'BUG-093' },
      { text: 'The adversarial data-loss and XSS suite is re-running against the new renderer to confirm no message content can be swallowed by a parse error.', kind: 'in-flight', importance: 'med' },
      { text: 'The response-format convention, including the envelope schema and the importance vocabulary, is documented for agents to read before replying.', kind: 'fyi', importance: 'low', ref: 'see RESPONSE_FORMAT.md' },
    ],
  }, null, 2) +
  '\n```\n\n' +
  `Here is the reply prose ${SENTINEL} with a **bolded** word and a list:\n\n- alpha\n- beta\n`;

// No envelope at all — pure prose that must survive untouched.
const NO_DIGEST =
  `Just a plain reply ${SENTINEL}. No structured digest here, only **prose** and:\n\n- one\n- two\n`;

// A leading orchard-digest fence whose JSON is broken (trailing comma + stray
// token). The digest MUST be dropped and the WHOLE message rendered as prose,
// so both the broken token and the prose sentinel survive.
const MALFORMED =
  '```orchard-digest\n' +
  `{ "items": [ { "text": "half an item", ${BROKEN} , ] }\n` +
  '```\n\n' +
  `And the real reply prose ${SENTINEL} below the broken block.\n`;

const asMsg = (text, index) => ({ role: 'assistant', index, blocks: [{ type: 'text', text }] });
const FX_B64 = Buffer.from(JSON.stringify({
  well: asMsg(WELL_FORMED, 0),
  none: asMsg(NO_DIGEST, 1),
  bad: asMsg(MALFORMED, 2),
})).toString('base64');

// Rendered into a throwaway pane + thread (the history render path), then the
// DOM is snapshotted. Base64 avoids embedding backticks (the fences) inside the
// outer JS template literal.
const RENDER_AND_SNAP = (key) => `(() => {
  const S = window.__station;
  const fx = JSON.parse(atob(${JSON.stringify(FX_B64)}));
  const pane = document.createElement('section');
  pane.className = 'pane';
  pane.dataset.thread = 'main';
  pane.dataset.probe = 'f083';
  document.getElementById('panes').appendChild(pane);
  const th = { key: 'p', kind: 'main', paneEl: pane, claudeBody: null, stream: null, tools: new Map() };
  S.renderMessages(th, [fx[${JSON.stringify(key)}]]);
  const digest = pane.querySelector('.digest');
  const full = pane.textContent;
  const proseText = [...pane.querySelectorAll('.prose')].map((p) => p.textContent).join(' \\u2016 ');
  const EMOJI = /[\\u{1F000}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{2190}-\\u{21FF}\\u2705\\u2714\\u26A0]/u;
  const out = {
    hasDigest: !!digest,
    groupLabels: [...pane.querySelectorAll('.digest-group-label')].map((n) => n.textContent),
    itemTexts: [...pane.querySelectorAll('.digest-item .digest-text')].map((n) => n.textContent),
    itemImp: [...pane.querySelectorAll('.digest-item')].map((n) => [...n.classList].find((c) => c.startsWith('imp-'))),
    refLinks: [...pane.querySelectorAll('a.digest-ref-link')].map((a) => ({ text: a.textContent, href: a.getAttribute('href') })),
    refLabels: [...pane.querySelectorAll('.digest-ref-label')].map((n) => n.textContent),
    digestText: digest ? digest.textContent : '',
    proseText,
    full,
    hasEmoji: EMOJI.test(full),
    hasStrong: !!pane.querySelector('.prose strong'),
    hasList: !!pane.querySelector('.prose li'),
    hasCodeBlock: !!pane.querySelector('.prose pre'),
  };
  pane.remove();
  return out;
})()`;

async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  console.log('\n=== server round-trip: the responseDigest opt-out persists ===');
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: WORK, name: 'feat-083' }),
  })).json();
  const pid = reg.project?.id;
  if (!pid) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  check('a fresh project defaults to responseDigest.enabled === true',
    reg.project?.settings?.responseDigest?.enabled === true, reg.project?.settings?.responseDigest);
  const patched = await (await fetch(`${BASE}/api/projects/${pid}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ responseDigest: { enabled: false } }),
  })).json();
  const got = (await (await fetch(`${BASE}/api/projects/${pid}`)).json()).project;
  check('PATCH responseDigest.enabled=false is accepted and persists',
    (patched.project ?? patched)?.settings?.responseDigest?.enabled === false
      && got?.settings?.responseDigest?.enabled === false,
    { patched: (patched.project ?? patched)?.settings?.responseDigest, got: got?.settings?.responseDigest });

  browser = spawn(BRAVE, [
    '--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', '--window-size=1280,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  if (!devPort) throw new Error('browser never wrote DevToolsActivePort');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const pageT = targets.find((t) => t.type === 'page');
  const cdp = await Cdp.connect(pageT.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  const booted = await cdp.waitFor('app boot', 'window.__station && !!window.__station.assistantProse && !!window.__station.renderMessages', 30_000);
  if (!booted) throw new Error('app never booted / digest renderer not exposed');

  // Ensure the ENABLED scenarios render with digest on: a project with the flag
  // unset (default enabled) selected as current.
  await cdp.eval(`(() => {
    const S = window.__station;
    S.state.projects = [{ id: 'p-on', name: 'on', settings: {} }, { id: 'p-off', name: 'off', settings: { responseDigest: { enabled: false } } }];
    S.state.current.projectId = 'p-on';
    return S.digestEnabled();
  })()`);

  console.log('\n=== 1. WELL-FORMED digest (enabled) ===');
  const w = await cdp.eval(RENDER_AND_SNAP('well'));
  check('a structured .digest is rendered', w.hasDigest, { hasDigest: w.hasDigest });
  check('groups are ordered Decisions, Done, In-flight, FYI',
    JSON.stringify(w.groupLabels) === JSON.stringify(['Decisions', 'Done', 'In-flight', 'FYI']), w.groupLabels);
  check('all five items rendered as bounded entries', w.itemTexts.length === 5, { count: w.itemTexts.length, itemTexts: w.itemTexts });
  check('the ticket refs render as deep links (#/tickets/<id>)',
    w.refLinks.some((r) => r.text === 'FEAT-083' && r.href === '#/tickets/FEAT-083?project=p-on')
      && w.refLinks.some((r) => r.text === 'BUG-093' && r.href === '#/tickets/BUG-093?project=p-on'),
    w.refLinks);
  check('a non-ticket ref renders as an inert label (not a link)',
    w.refLabels.some((l) => l.includes('RESPONSE_FORMAT.md')) && !w.refLinks.some((r) => r.text.includes('RESPONSE_FORMAT.md')),
    { labels: w.refLabels });
  check('importance is carried as a class (high + med + low all present)',
    w.itemImp.includes('imp-high') && w.itemImp.includes('imp-med') && w.itemImp.includes('imp-low'), w.itemImp);
  check('NO emoji anywhere in the rendered message', !w.hasEmoji, { hasEmoji: w.hasEmoji });
  check('the raw JSON is HIDDEN (digest holds no "items"/kind JSON text)',
    !w.digestText.includes('"items"') && !w.digestText.includes('"kind"') && !w.digestText.includes('orchard-digest'),
    { digestTextSample: w.digestText.slice(0, 80) });
  check('the raw envelope JSON is not shown anywhere as text',
    !w.full.includes('"kind"') && !w.full.includes('orchard-digest'), { fullSample: w.full.slice(0, 60) });
  check('the prose below the digest still renders (sentinel + bold + list)',
    w.full.includes(SENTINEL) && w.hasStrong && w.hasList, { sentinel: w.full.includes(SENTINEL), strong: w.hasStrong, list: w.hasList });

  console.log('\n=== 2. NO digest — prose unchanged (must-FAIL guard: prose intact) ===');
  const n = await cdp.eval(RENDER_AND_SNAP('none'));
  check('no .digest is rendered for a plain message', !n.hasDigest, { hasDigest: n.hasDigest });
  check('MUST-FAIL GUARD: the prose sentence is present and intact',
    n.full.includes(SENTINEL) && n.proseText.includes('No structured digest here'), { proseText: n.proseText.slice(0, 120) });
  check('markdown in the plain message still renders (bold + list)', n.hasStrong && n.hasList, { strong: n.hasStrong, list: n.hasList });

  console.log('\n=== 3. MALFORMED digest — content must never be swallowed ===');
  const b = await cdp.eval(RENDER_AND_SNAP('bad'));
  check('the digest is DROPPED on a parse error (no .digest)', !b.hasDigest, { hasDigest: b.hasDigest });
  check('MUST-FAIL: the prose sentinel still renders (message not hidden)', b.full.includes(SENTINEL), { hasSentinel: b.full.includes(SENTINEL) });
  check('MUST-FAIL: the broken-JSON block still renders as content (nothing lost)',
    b.full.includes(BROKEN), { hasBrokenToken: b.full.includes(BROKEN) });

  console.log('\n=== 4. DISABLED for the project — plain prose (pre-fix baseline) ===');
  const disabledFlag = await cdp.eval(`(() => { window.__station.state.current.projectId = 'p-off'; return window.__station.digestEnabled(); })()`);
  check('digestEnabled() is false when the project opts out', disabledFlag === false, { digestEnabled: disabledFlag });
  const d = await cdp.eval(RENDER_AND_SNAP('well'));
  check('the SAME well-formed fixture renders NO .digest when disabled', !d.hasDigest, { hasDigest: d.hasDigest });
  check('disabled: the raw JSON is shown as ordinary prose (a code block), not hidden',
    d.full.includes('"kind"') && d.hasCodeBlock, { hasKindJson: d.full.includes('"kind"'), hasCodeBlock: d.hasCodeBlock });
  check('disabled: the prose still renders (sentinel present)', d.full.includes(SENTINEL), { hasSentinel: d.full.includes(SENTINEL) });

  cdp.close();
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(() => {
  stopByPid(browser);
  stopByPid(server);
  setTimeout(() => {
    for (const dir of [DATA, STORE, WORK, PROFILE]) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } }
    process.exit(process.exitCode ?? 0);
  }, 1500);
});
