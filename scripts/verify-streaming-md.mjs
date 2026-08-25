/**
 * FEAT-016 — markdown formats LIVE while a turn streams (the HONEST variant),
 * instead of showing raw `**bold**`, `- ` list markers and ``` fences as literal
 * syntax until the final message snaps into place.
 *
 *   npm run verify:streaming-md
 *
 * This drives a REAL browser (brave --headless=new over raw CDP; happy-dom has
 * no layout and would not exercise the real render path) against a REAL server
 * running a REAL cheap haiku turn. The prompt asks for a bolded word, a bulleted
 * list and a fenced code block, plus a sentinel word.
 *
 * The load-bearing assertion: WHILE the turn is still streaming (th.stream is
 * live, i.e. before turn-end), the streaming node already contains FORMATTED DOM
 * — <strong>, <ul>/<li>, <pre> — not literal `**` / `- ` / triple-backtick. That
 * is only possible if the accumulated buffer is being reparsed through prose()
 * mid-stream. Then it proves the final render still matches (sentinel present
 * exactly once, no duplicated streaming leftover).
 *
 * Process hygiene: OS-assigned free port (never 4317's live session, never a
 * fixed default). Kill children by PID only, never pkill. The spawned `claude`
 * CLI writes its transcript into the user's REAL store under an encoded temp
 * path; that stray dir is swept in the finally.
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
const PORT = Number(process.env.VERIFY_STREAMING_MD_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-strmd-data-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-strmd-work-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-strmd-store-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-strmd-chrome-'));
const BRAVE = process.env.VERIFY_STREAMING_MD_BROWSER ?? 'brave';
const REAL_STORE = path.join(os.homedir(), '.claude', 'projects');
const SHOT = path.join(ROOT, 'docs', 'bugs', 'assets', 'FEAT-016-after.png');

const SENTINEL = 'ZEBRAFINCH';
const PROMPT =
  'Reply ONLY in GitHub-flavored markdown, with nothing before or after it. Produce, in this exact order:\n' +
  '1. One short sentence that contains the word **beacon** in bold.\n' +
  '2. A bulleted list with exactly three items: apple, banana, cherry.\n' +
  '3. A fenced code block (triple backticks) whose only line is: print(42)\n' +
  `4. Then one final short sentence that ends with the sentinel word ${SENTINEL}.`;

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

  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: WORK, name: 'streaming-md' }),
  })).json();
  const pid = reg.project?.id;
  if (!pid) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  // The reply is pure text (no tools), so bypassPermissions is not needed; just
  // pin the cheapest model so the turn is fast and free.
  await (await fetch(`${BASE}/api/projects/${pid}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'haiku' }),
  })).json();

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
  const booted = await cdp.waitFor('app boot + our project loaded',
    `window.__station && window.__station.state.projects.some((p) => p.id === ${JSON.stringify(pid)})`, 30_000);
  if (!booted) throw new Error('app never booted / project never loaded in the page');

  console.log('\n=== drive a real haiku turn from the browser and watch it stream ===');
  // Arm the project and fire the turn through the app's own code path.
  await cdp.eval(`(async () => {
    const st = window.__station.state;
    st.current.projectId = ${JSON.stringify(pid)};
    await window.__station.startTurn(${JSON.stringify(PROMPT)});
    return true;
  })()`);

  /*
   * SNAPSHOT of the render, taken from the page each frame. `streaming` is true
   * exactly while th.stream is live — i.e. strictly BEFORE turn-end. So any
   * formatted node seen with streaming===true is proof the buffer was reparsed
   * MID-STREAM, not on turn-end.
   */
  const SNAP = `(() => {
    const st = window.__station.state;
    const th = st.threads.get('main');
    const wrap = th && th.stream ? th.stream.wrap : null;
    const streaming = !!(th && th.stream);
    const proses = [...document.querySelectorAll('#panes .pane .claude .body .prose')];
    const sentinelProses = proses.filter((p) => p.textContent.includes(${JSON.stringify(SENTINEL)}));
    return {
      streaming,
      streamText: wrap ? wrap.textContent : '',
      hasStrong: !!(wrap && wrap.querySelector('strong')),
      hasList: !!(wrap && wrap.querySelector('li')),
      hasPre: !!(wrap && wrap.querySelector('pre')),
      finalCount: sentinelProses.length,
      finalHasStrong: sentinelProses.some((p) => p.querySelector('strong')),
      finalHasList: sentinelProses.some((p) => p.querySelector('li')),
      finalHasPre: sentinelProses.some((p) => p.querySelector('pre')),
      finalText: sentinelProses.map((p) => p.textContent).join(' || '),
      sentinelHits: (proses.map((p) => p.textContent).join('\\n').match(new RegExp(${JSON.stringify(SENTINEL)}, 'g')) || []).length,
    };
  })()`;

  let everStreamed = false, sawStrong = false, sawList = false, sawPre = false;
  let literalWhileStreaming = false; // did any raw ** / triple-backtick show as text while streaming?
  let midShot = false, midSnap = null, finalSnap = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 180_000) {
    let snap;
    try { snap = await cdp.eval(SNAP); } catch { await sleep(40); continue; }
    if (snap.streaming) {
      everStreamed = true;
      if (snap.hasStrong) sawStrong = true;
      if (snap.hasList) sawList = true;
      if (snap.hasPre) sawPre = true;
      // Capture the strongest mid-stream frame for evidence + the screenshot.
      if (sawStrong && (sawList || sawPre) && (!midSnap || (snap.hasStrong && snap.hasList && snap.hasPre))) midSnap = snap;
      if (!midShot && snap.hasStrong && (snap.hasList || snap.hasPre)) {
        midShot = true;
        try {
          const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
          fs.mkdirSync(path.dirname(SHOT), { recursive: true });
          fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
        } catch { /* screenshot is best-effort evidence, not an assertion */ }
      }
    }
    if (everStreamed && !snap.streaming && snap.finalCount > 0) { finalSnap = snap; break; }
    await sleep(40);
  }
  if (!finalSnap) finalSnap = await cdp.eval(SNAP);

  check('PRECONDITION: the turn actually streamed token deltas (a live stream node existed)',
    everStreamed, `everStreamed=${everStreamed}`);

  check('MID-STREAM the streaming node rendered a bolded word as <strong> (not literal **)',
    sawStrong, midSnap ? `while streaming: streamText=${JSON.stringify(midSnap.streamText.slice(0, 140))}` : `never observed <strong> before turn-end`);
  check('MID-STREAM the streaming node rendered a list as <ul>/<li> (not literal "- ")',
    sawList, `sawList=${sawList}`);
  check('MID-STREAM the streaming node rendered a closed fence as <pre> (not literal triple-backtick)',
    sawPre, `sawPre=${sawPre}`);
  check('THE FIX: all three markdown forms were formatted LIVE, before turn-end',
    sawStrong && sawList && sawPre,
    midSnap ? { strong: midSnap.hasStrong, list: midSnap.hasList, pre: midSnap.hasPre } : { sawStrong, sawList, sawPre });

  console.log('\n=== the final render still matches — no duplication, sentinel once ===');
  check('exactly ONE final message carries the sentinel (no duplicated streaming leftover)',
    finalSnap.finalCount === 1 && finalSnap.sentinelHits === 1,
    { finalMessagesWithSentinel: finalSnap.finalCount, sentinelOccurrences: finalSnap.sentinelHits });
  check('the final rendered message is fully formatted (<strong> + <li> + <pre>)',
    finalSnap.finalHasStrong && finalSnap.finalHasList && finalSnap.finalHasPre,
    { strong: finalSnap.finalHasStrong, list: finalSnap.finalHasList, pre: finalSnap.finalHasPre });
  check('the final message has no leftover literal markdown syntax (no "**", no triple-backtick as text)',
    !finalSnap.finalText.includes('**') && !finalSnap.finalText.includes('```'),
    `finalText=${JSON.stringify(finalSnap.finalText.slice(0, 200))}`);
  check('screenshot of the mid-stream formatted render was captured',
    midShot && fs.existsSync(SHOT), `${SHOT} exists=${fs.existsSync(SHOT)}`);

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
    for (const d of [DATA, WORK, STORE, PROFILE]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
    // The CLI writes the transcript into the user's REAL store under an encoded
    // temp path; sweep our stray dir(s) so runs do not accumulate.
    try {
      for (const d of fs.readdirSync(REAL_STORE).filter((n) => /-tmp-.*cs-strmd-work-/.test(n) || /cs-strmd-work-/.test(n))) {
        fs.rmSync(path.join(REAL_STORE, d), { recursive: true, force: true });
      }
    } catch { /* store unreadable — nothing to sweep */ }
    process.exit(process.exitCode ?? 0);
  }, 2500);
});
