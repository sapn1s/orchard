/**
 * Content-search verification — server classification, canonical locate(),
 * and one real UI click-through (Enter → hit → session opens AT the message)
 * in headless Chromium.
 *
 *   node scripts/verify-search.mjs
 *
 * The fixture is synthesised so every classification rule is exercised with a
 * known right answer:
 *   L1 user prose containing the token            → prose hit, locate exact
 *   L2 assistant prose without it                 → no hit
 *   L3 user tool_result-only with the token       → tool hit, NOT a canonical
 *                                                   message → locate exact:false
 *   L4 assistant text + tool_use input with token → tool hit (token only in input)
 *   L5 sidechain entry with the token             → dropped
 *   L6 metadata-only token (gitBranch)            → dropped
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

/* Never a fixed port: two suites defaulting to the same number collide the
   moment both run (observed: verify-ui + verify-sessions on 4319). The OS
   hands out a free one; the env var still pins it when a run needs to. */
async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const PORT = Number(process.env.VERIFY_SEARCH_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const SCRATCH = process.env.VERIFY_SEARCH_SCRATCH ?? path.join(os.homedir(), 'scratch', 'csearch', 'verify-search');
fs.mkdirSync(SCRATCH, { recursive: true });
const DATA = fs.mkdtempSync(path.join(SCRATCH, 'data-'));
const PROFILE = fs.mkdtempSync(path.join(SCRATCH, 'brave-'));
const PROJECTS = fs.mkdtempSync(path.join(SCRATCH, 'projects-'));
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';
const TOKEN = 'XSEARCHTOKENX';
const LOCATE_TOKEN = 'XLOCATEAFTERFILTERSX';

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
      try { if (await this.eval(expr)) return true; } catch { /* mid-navigation */ }
      await sleep(150);
    }
    console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
    return false;
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

let server = null, browser = null;
const cleanupDirs = [];

function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

const entry = (o) => JSON.stringify(o);
const uid = (n) => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`;

async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: PROJECTS },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  // Fixture project + session.
  const projDir = fs.mkdtempSync(path.join(SCRATCH, 'host-'));
  cleanupDirs.push(projDir);
  const encoded = projDir.replace(/[/.]/g, '-');
  const store = path.join(PROJECTS, encoded);
  fs.mkdirSync(store, { recursive: true });
  cleanupDirs.push(store);
  const sid = '22222222-3333-4444-9555-666666666666';
  const T = (n) => new Date(1700000000000 + n * 1000).toISOString();
  const lines = [
    entry({ parentUuid: null, isSidechain: false, type: 'user', uuid: uid(1), timestamp: T(1), sessionId: sid,
      message: { role: 'user', content: [{ type: 'text', text: `the quick brown ${TOKEN} fox jumps` }] } }),
    entry({ parentUuid: uid(1), isSidechain: false, type: 'assistant', uuid: uid(2), timestamp: T(2), sessionId: sid,
      message: { role: 'assistant', content: [{ type: 'text', text: 'nothing to see in this one' }] } }),
    entry({ parentUuid: uid(2), isSidechain: false, type: 'user', uuid: uid(3), timestamp: T(3), sessionId: sid,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: `command output mentioning ${TOKEN} here` }] } }),
    entry({ parentUuid: uid(3), isSidechain: false, type: 'assistant', uuid: uid(4), timestamp: T(4), sessionId: sid,
      message: { role: 'assistant', content: [{ type: 'text', text: 'running a tool now' }, { type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: `grep ${TOKEN} /tmp` } }] } }),
    entry({ parentUuid: uid(4), isSidechain: true, type: 'user', uuid: uid(5), timestamp: T(5), sessionId: sid,
      message: { role: 'user', content: [{ type: 'text', text: `sidechain content with ${TOKEN} must not surface` }] } }),
    entry({ parentUuid: uid(4), isSidechain: false, type: 'user', uuid: uid(6), timestamp: T(6), sessionId: sid, gitBranch: `feature/${TOKEN}`,
      message: { role: 'user', content: [{ type: 'text', text: 'metadata trap: token only in gitBranch' }] } }),
    entry({ parentUuid: uid(6), isSidechain: false, type: 'assistant', uuid: uid(7), timestamp: T(7), sessionId: sid,
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'a visible reasoning block before the target' }] } }),
    entry({ parentUuid: uid(7), isSidechain: true, type: 'assistant', uuid: uid(8), timestamp: T(8), sessionId: sid,
      message: { role: 'assistant', content: [{ type: 'text', text: 'a sidechain entry before the target' }] } }),
    entry({ parentUuid: uid(7), isSidechain: false, type: 'user', uuid: uid(9), timestamp: T(9), sessionId: sid,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'tool output before the target' }] } }),
    entry({ parentUuid: uid(9), isSidechain: false, type: 'assistant', uuid: uid(10), timestamp: T(10), sessionId: sid,
      message: { role: 'assistant', content: [{ type: 'text', text: `final prose ${LOCATE_TOKEN}` }] } }),
  ];
  fs.writeFileSync(path.join(store, `${sid}.jsonl`), lines.join('\n') + '\n');
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: projDir, name: 'search-fixture' }),
  })).json();
  const projectId = reg.project?.id;
  if (!projectId) throw new Error(`could not register fixture project: ${JSON.stringify(reg)}`);

  console.log('\n=== search: classification ===');
  const r = await (await fetch(`${BASE}/api/search?q=${TOKEN}&project=${projectId}`)).json();
  const mine = (r.hits ?? []).filter((h) => h.sessionId === sid);
  const prose = mine.filter((h) => h.kind === 'prose');
  const tool = mine.filter((h) => h.kind === 'tool');
  check('prose hit found, ranked first, snippet is the human text',
    prose.length === 1 && mine[0]?.kind === 'prose' && prose[0].snippet.includes('quick brown') && prose[0].line === 1,
    JSON.stringify(prose[0] ?? null));
  check('tool_result and tool_use-input hits found, kind=tool, ranked below prose',
    tool.length === 2 && tool.some((h) => h.line === 3) && tool.some((h) => h.line === 4),
    tool.map((h) => `line ${h.line}: ${h.snippet.slice(0, 40)}`).join(' | ') || '(none)');
  check('sidechain and metadata-only matches were DROPPED',
    !mine.some((h) => h.line === 5) && !mine.some((h) => h.line === 6),
    `lines surfaced: ${mine.map((h) => h.line).join(',')}`);

  console.log('\n=== search: locate (canonical index space) ===');
  const locProse = await (await fetch(`${BASE}/api/search/locate?dir=${encodeURIComponent(encoded)}&sessionId=${sid}&line=1`)).json();
  // Cross-check against the transcript route rather than assuming.
  const t = await (await fetch(`${BASE}/api/transcript/${encodeURIComponent(encoded)}/${sid}?tail=100`)).json();
  const msgAt = (i) => t.messages.find((m) => m.index === i);
  check('prose line 1 → exact canonical index whose message IS that text',
    locProse.exact === true && msgAt(locProse.index)?.blocks?.some((b) => (b.text ?? '').includes(TOKEN)),
    JSON.stringify({ locate: locProse, text: msgAt(locProse.index)?.blocks?.[0]?.text?.slice(0, 50) }));
  const locTool = await (await fetch(`${BASE}/api/search/locate?dir=${encodeURIComponent(encoded)}&sessionId=${sid}&line=3`)).json();
  check('tool_result-only line 3 → exact:false, nearest earlier rendered message',
    locTool.exact === false && Number.isInteger(locTool.index) && locTool.index < (locProse.index + 3),
    JSON.stringify(locTool));
  const locGone = await fetch(`${BASE}/api/search/locate?dir=${encodeURIComponent(encoded)}&sessionId=${sid}&line=999`);
  check('a line beyond EOF answers 410, not a guessed index', locGone.status === 410, `HTTP ${locGone.status}`);

  console.log('\n=== search: locate param validation (BUG-012) ===');
  const locBadLine = await fetch(`${BASE}/api/search/locate?dir=${encodeURIComponent(encoded)}&sessionId=${sid}&line=abc`);
  check('non-numeric ?line answers 400, not 500', locBadLine.status === 400,
    `HTTP ${locBadLine.status}: ${JSON.stringify(await locBadLine.json().catch(() => null))}`);
  const locMissingLine = await fetch(`${BASE}/api/search/locate?dir=${encodeURIComponent(encoded)}&sessionId=${sid}`);
  check('missing ?line answers 400', locMissingLine.status === 400, `HTTP ${locMissingLine.status}`);
  const locStillValid = await fetch(`${BASE}/api/search/locate?dir=${encodeURIComponent(encoded)}&sessionId=${sid}&line=1`);
  check('a valid ?line still works (no regression)', locStillValid.status === 200, `HTTP ${locStillValid.status}`);
  const locAfterFilters = await (await fetch(`${BASE}/api/search/locate?dir=${encodeURIComponent(encoded)}&sessionId=${sid}&line=10`)).json();
  const tAfterFilters = await (await fetch(`${BASE}/api/transcript/${encodeURIComponent(encoded)}/${sid}?tail=100`)).json();
  const renderedAfterFilters = tAfterFilters.messages.find((m) => m.blocks?.some((b) => (b.text ?? '').includes(LOCATE_TOKEN)));
  check('locate shares rendered indices after thinking, sidechain, and tool_result entries',
    locAfterFilters.exact === true && locAfterFilters.index === renderedAfterFilters?.index,
    JSON.stringify({ locate: locAfterFilters, rendered: renderedAfterFilters?.index }));

  console.log('\n=== search: UI click-through (real browser) ===');
  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', '--window-size=1280,900', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  if (!devPort) throw new Error('browser never wrote DevToolsActivePort');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.waitFor('boot', `document.querySelectorAll('#tree button.proj').length > 0`);
  await cdp.eval(`(() => {
    const f = document.querySelector('#finder'); f.classList.add('on');
    const i = document.querySelector('#findInput');
    i.value = ${JSON.stringify(TOKEN)};
    i.dispatchEvent(new Event('input'));
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  const gotRows = await cdp.waitFor('content hit rows', `document.querySelectorAll('#tree .row.hit').length > 0`);
  const rowInfo = await cdp.eval(`[...document.querySelectorAll('#tree .row.hit')].map((r) => r.querySelector('.snip')?.textContent.slice(0, 50))`);
  check('Enter rendered content-hit rows with snippets and a highlighted match',
    gotRows && rowInfo.length >= 3 && (await cdp.eval(`document.querySelector('#tree .row.hit .snip mark')?.textContent`)) === TOKEN,
    JSON.stringify(rowInfo));
  await cdp.eval(`document.querySelector('#tree .row.hit').click()`);
  const opened = await cdp.waitFor('session opened at the match',
    `window.__station?.state.current.sessionId === ${JSON.stringify(sid)} && document.querySelector('#panes .pane.on [data-i]') !== null`, 30_000);
  const view = await cdp.eval(`(() => {
    const top = document.querySelector('#scroll').getBoundingClientRect().top;
    for (const m of document.querySelectorAll('#panes .pane.on [data-i]')) {
      if (m.getBoundingClientRect().bottom > top + 4) return { topI: Number(m.dataset.i), text: m.textContent.slice(0, 60), hash: location.hash };
    }
    return null;
  })()`);
  check('clicking the hit opened the session AT the matched message (deep-link)',
    opened && view && view.topI === locProse.index && view.text.includes(TOKEN),
    JSON.stringify(view));
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
    fs.rmSync(DATA, { recursive: true, force: true });
    fs.rmSync(PROFILE, { recursive: true, force: true });
    fs.rmSync(PROJECTS, { recursive: true, force: true });
    for (const d of cleanupDirs) fs.rmSync(d, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  }, 2500);
});
