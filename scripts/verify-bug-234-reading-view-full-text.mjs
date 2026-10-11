/**
 * BUG-234 r7 — the single-session reading view ALWAYS delivers FULL assistant text.
 * The reading route no longer accepts a caller cap, so it can never return a
 * truncated (mid-fence) block that would render table source as raw <pre>.
 *
 *   node scripts/verify-bug-234-reading-view-full-text.mjs
 *
 * Reality under test (CONVENTIONS "test against the real artifact"): the REAL
 * 6535-char `orchard-answer` reply in the user's real session
 * 1f4cad56-e1bf-4d26-8057-499e5268612c ("All 26 sessions rechecked just now"),
 * served through a REAL isolated scratch server's transcript route and rendered
 * through the app's REAL renderMessages() in a REAL headless browser.
 *
 *   A. FULL FIDELITY — the route with no cap returns the whole message (len 6535,
 *      not truncated) and it renders a real <table>, with NO <pre> wrapping the
 *      raw table source.
 *   B. ROUTE IGNORES THE CAP — the route WITH an explicit maxTextChars (even =10)
 *      still returns the whole 6535-char message, never truncated, and still renders
 *      a <table> with no raw-source <pre>. The param is inert on a reading route.
 *   C. MUST-FAIL vs a SYNTHESIZED pre-fix state — the OLD behaviour (a hard 4000
 *      char slice, as a truncated block would reach the r7 client) MUST reproduce the
 *      bug: a <pre> containing the table source and NO <table>. If it does not
 *      reproduce, the whole suite is vacuous and FAILS loudly.
 *
 * Real brave --headless=new over raw CDP; free port, never :4317; PID-kill only;
 * isolated CLAUDE_STATION_DATA + CLAUDE_PROJECTS_DIR via station-boot.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import { isolatedServerEnv } from './lib/station-boot.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const BRAVE = process.env.VERIFY_BUG_234_BROWSER ?? 'brave';
const SENTINEL = 'All 26 sessions rechecked just now';
const REAL_SESSION = '1f4cad56-e1bf-4d26-8057-499e5268612c';
// Discover the real transcript at runtime (its encoded-dir name is a home path,
// so it is never written as a literal here — the leak gate would reject one).
const PROJECTS_ROOT = (process.env.CLAUDE_PROJECTS_DIR || '').trim() || path.join(os.homedir(), '.claude', 'projects');
function discoverReal() {
  let names = [];
  try { names = fs.readdirSync(PROJECTS_ROOT); } catch { return null; }
  for (const d of names) {
    const f = path.join(PROJECTS_ROOT, d, `${REAL_SESSION}.jsonl`);
    if (fs.existsSync(f)) return { encodedDir: d, file: f };
  }
  return null;
}
let REAL_ENCODED_DIR = null;
let REAL_FILE = null;

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const PORT = Number(process.env.VERIFY_BUG_234_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b234-data-'));
const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b234-proj-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b234-brave-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : (fail++, failures.push(name));
}

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

let server = null, browser = null;
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

/*
 * Render ONE assistant message (already fetched into the page, or synthesized)
 * through the REAL renderMessages() and report what the DOM holds. `msgJson` is a
 * TranscriptMessage. We look for: a real <table>, any <pre> that wraps the raw
 * table source (the bug), and whether a visible truncation marker is present.
 */
const RENDER = (msgJson) => `(() => {
  const S = window.__station;
  const msg = ${JSON.stringify(msgJson)};
  const pane = document.createElement('section');
  pane.className = 'pane'; pane.dataset.thread = 'main'; pane.dataset.probe = 'b234';
  document.getElementById('panes').appendChild(pane);
  const th = { key: 'p', kind: 'main', paneEl: pane, claudeBody: null, stream: null, tools: new Map() };
  S.renderMessages(th, [msg]);
  const pres = [...pane.querySelectorAll('pre')].map((p) => p.textContent || '');
  // A <pre> is "wrapping the table source" if its text carries the markdown table
  // grammar — a pipe-delimited header/row or a |---| separator.
  const preHasTableSource = pres.some((t) => /\\|\\s*Project\\b/.test(t) || /\\|\\s*-{2,}/.test(t) || /\\|\\s*Session\\b/.test(t));
  return {
    hasTable: !!pane.querySelector('table'),
    tableHead: pane.querySelector('table') ? [...pane.querySelectorAll('table thead th')].map((n) => n.textContent) : [],
    preCount: pres.length,
    preHasTableSource,
    markerVisible: /truncated/i.test(pane.textContent || ''),
    textLen: (pane.textContent || '').length,
  };
})()`;

async function fetchMessage(cdp, query) {
  // Hit the REAL route from inside the page, then find the real message by content.
  return cdp.eval(`(async () => {
    const r = await (await fetch(${JSON.stringify(`/api/transcript/${encodeURIComponent(REAL_ENCODED_DIR)}/${encodeURIComponent(REAL_SESSION)}?${query}`)})).json();
    const msgs = r.messages || [];
    const msg = msgs.find((m) => (m.blocks || []).some((b) => b.type === 'text' && typeof b.text === 'string' && b.text.includes(${JSON.stringify(SENTINEL)})));
    if (!msg) return { found: false, count: msgs.length };
    const b = msg.blocks.find((x) => x.type === 'text' && x.text.includes(${JSON.stringify(SENTINEL)}));
    return { found: true, msg, textLen: b.text.length, truncated: b.truncated === true, endsWithFence: /\`{4}\\s*$/.test(b.text.replace(/\\u27e8[^\\u27e9]*\\u27e9\\s*$/, '').trim()) };
  })()`);
}

async function main() {
  const real = discoverReal();
  if (!real) {
    throw new Error(`REAL transcript for session ${REAL_SESSION} not found under ${PROJECTS_ROOT} — cannot test against the real artifact`);
  }
  REAL_ENCODED_DIR = real.encodedDir;
  REAL_FILE = real.file;
  // Copy the REAL transcript into an isolated scratch store so the scratch server
  // reads the real message without touching (or exposing) the rest of the store.
  const destDir = path.join(PROJ, REAL_ENCODED_DIR);
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(REAL_FILE, path.join(destDir, `${REAL_SESSION}.jsonl`));

  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: isolatedServerEnv({ PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: PROJ }, { requireStore: true }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

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
  const cdp = await Cdp.connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.waitFor('app boot', 'window.__station && !!window.__station.renderMessages && !!window.__station.api', 60_000);

  /* ===================== A. FULL FIDELITY (no cap) ===================== */
  console.log('\n=== A. reading view delivers the FULL message, renders a table ===');
  const full = await fetchMessage(cdp, 'offset=0&limit=300');
  if (!full.found) throw new Error(`the real message ("${SENTINEL}") was not found via the no-cap route — count=${full.count}. Reality changed; test is meaningless.`);
  check('A1: route returns the WHOLE message (6535 chars, not the old 4000 cap)', full.textLen === 6535, { textLen: full.textLen });
  check('A2: the message is NOT marked truncated', full.truncated === false, { truncated: full.truncated });
  const fullDom = await cdp.eval(RENDER(full.msg));
  check('A3: the full reply renders a real <table>', fullDom.hasTable, { hasTable: fullDom.hasTable });
  check('A4: the table header is the real "Project | Session | …" row', /Project/.test(fullDom.tableHead[0] ?? ''), fullDom.tableHead);
  check('A5: NO <pre> wraps the raw table source', !fullDom.preHasTableSource, { preCount: fullDom.preCount, preHasTableSource: fullDom.preHasTableSource });

  /* ===================== B. ROUTE IGNORES THE CAP (r7) ===================== */
  console.log('\n=== B. the reading route ignores ?maxTextChars — always full, never truncated ===');
  // r7: the reading route no longer accepts a caller cap, so ANY maxTextChars value
  // returns the WHOLE 6535-char message, never truncated, and still renders a table.
  for (const cap of [10, 2000, 4000, 6000, 6535]) {
    const t = await fetchMessage(cdp, `offset=0&limit=300&maxTextChars=${cap}`);
    if (!t.found) { check(`B(cap=${cap}): message still found`, false, { count: t.count }); continue; }
    check(`B(cap=${cap}): route returns the FULL 6535 chars, NOT truncated (cap ignored)`, t.textLen === 6535 && t.truncated === false, { textLen: t.textLen, truncated: t.truncated });
    const dom = await cdp.eval(RENDER(t.msg));
    check(`B(cap=${cap}): renders a real <table>, no raw table source in a <pre>`, dom.hasTable && !dom.preHasTableSource, { hasTable: dom.hasTable, preHasTableSource: dom.preHasTableSource });
  }

  /* ===================== C. MUST-FAIL vs synthesized pre-fix ===================== */
  console.log('\n=== C. MUST-FAIL: the OLD hard-4000-slice reproduces the bug ===');
  // Synthesize the exact pre-fix state: the old blocksOf sliced to maxTextChars
  // with NO fence balancing and NO marker. Rebuild it from the real full text.
  const realText = await cdp.eval(`(async () => {
    const r = await (await fetch(${JSON.stringify(`/api/transcript/${encodeURIComponent(REAL_ENCODED_DIR)}/${encodeURIComponent(REAL_SESSION)}?offset=0&limit=300`)})).json();
    const msg = (r.messages || []).find((m) => (m.blocks || []).some((b) => b.type === 'text' && typeof b.text === 'string' && b.text.includes(${JSON.stringify(SENTINEL)})));
    return msg.blocks.find((b) => b.type === 'text' && b.text.includes(${JSON.stringify(SENTINEL)})).text;
  })()`);
  // The pre-fix state: a hard 4000-char slice, rendered by the r7 client (which no
  // longer closes fences) exactly as a truncated block would reach it. This is the
  // bug the reading-route change removes by never producing a truncated block.
  const preFixMsg = {
    index: 0, role: 'assistant', timestamp: null, uuid: null, parentUuid: null,
    blocks: [{ type: 'text', text: realText.slice(0, 4000) }],
  };
  const preDom = await cdp.eval(RENDER(preFixMsg));
  check('C1: PRE-FIX reproduces the bug — a <pre> wraps the raw table source', preDom.preHasTableSource, { preHasTableSource: preDom.preHasTableSource, preCount: preDom.preCount });
  check('C2: PRE-FIX renders NO real <table> (the table was lost)', !preDom.hasTable, { hasTable: preDom.hasTable });

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
    for (const dir of [DATA, PROJ, PROFILE]) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } }
    process.exit(process.exitCode ?? 0);
  }, 1500);
});
