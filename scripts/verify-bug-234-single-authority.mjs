/**
 * BUG-234 r7 — the reading view can NEVER receive truncated text. The explicit-cap
 * path that every r3→r6 break lived in is removed BY CONSTRUCTION: the reading
 * routes (main tail, forward/follow, subagent tail, subagent page) no longer accept
 * a caller-supplied `maxTextChars`, so they always deliver the full message. The
 * client's truncation-note / fence-closing machinery is deleted with it.
 *
 *   node scripts/verify-bug-234-single-authority.mjs
 *
 *   U. STRUCTURAL —
 *      - `deliverText` is still the ONE cap authority (defined once); no server-side
 *        fence grammar (`danglingFenceCloser` / `fenceSafeTruncate` / fence regex in
 *        session-history), no `?? 4000`, and deliverText is a plain cut + metadata.
 *      - NO reading route reads `maxTextChars` from the request: `src/server/index.ts`
 *        contains ZERO `searchParams.get('maxTextChars')`.
 *      - the client has NO truncation-note machinery: `appendTruncationNote`,
 *        `truncationNote`, `closeTruncatedFence` and the `.trunc-note` class are gone
 *        from public/, and response-blocks.js no longer exports closeTruncatedFence.
 *   P. ROUTE IGNORES THE CAP — through a REAL isolated scratch server, a
 *      `?maxTextChars=10` request on EACH of the four reading routes returns the FULL
 *      block text, never `truncated:true`. (The param is inert on a reading route.)
 *   M. MUST-FAIL — the pre-fix cap state reproduces the bug: `deliverText(fold, 4000)`
 *      IS a truncated mid-fence cut, and rendered by the REAL (r7) client — which no
 *      longer closes fences — it shows raw table source in a <pre> and NO <table>.
 *      This is exactly the danger the route change removes; if it does not reproduce,
 *      the suite is vacuous and FAILS loudly.
 *
 * Free ports, never :4317, PID-kill only, isolated store via station-boot.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import { isolatedServerEnv } from './lib/station-boot.mjs';
import { deliverText } from '../src/lib/session-history.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const BRAVE = process.env.VERIFY_BUG_234_BROWSER ?? 'brave';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : (fail++, failures.push(name));
}

/* ------------------------------------------------------------------ fixtures */
/* Realistic >4000-char reply: prose, a 70-row status table, a closing line, all
 * wrapped in a 4-backtick orchard-answer fold (the real BUG-234 shape). */
const TABLE_ROWS = (n) => {
  const out = ['| Project | Session | State | Last activity | Notes |', '| --- | --- | --- | --- | --- |'];
  for (let i = 0; i < n; i++) out.push(`| orchard | sess-${String(i).padStart(4, '0')} | ok | 2026-10-0${(i % 7) + 1} | row ${i} reconciled against the board index cleanly |`);
  return out;
};
function fold({ fence = '````', info = 'orchard-answer', nl = '\n', rows = 70 } = {}) {
  const body = ['Here is the full rechecked status across every session:', '', ...TABLE_ROWS(rows), '', 'All rows reconciled; nothing outstanding.'];
  return [`${fence}${info}`, ...body, `${fence}`].join(nl);
}

/* --------------------------------------------------------------- Part U */
function partU() {
  console.log('\n=== U. structural: one cap authority, no reading-route cap, no client note machinery ===');
  const srcFiles = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.ts$/.test(e.name)) srcFiles.push(p); } };
  walk(path.join(ROOT, 'src'));
  const read = (f) => fs.readFileSync(f, 'utf8');
  const filesWith = (re) => srcFiles.filter((f) => re.test(read(f))).map((f) => path.relative(ROOT, f));

  check('U1: no danglingFenceCloser / fenceSafeTruncate anywhere in src/', filesWith(/danglingFenceCloser|fenceSafeTruncate/).length === 0, filesWith(/danglingFenceCloser|fenceSafeTruncate/));
  const FENCE_RE = /\/[^/\n]*(`\{3,?\}|~\{3,?\}|`{3}\+|~{3}\+)[^/\n]*\//;
  const hist = read(path.join(ROOT, 'src/lib/session-history.ts'));
  check('U2: session-history.ts (the cap authority) holds no fence-run regex', !FENCE_RE.test(hist), { match: FENCE_RE.exec(hist)?.[0] ?? null });
  check('U3: deliverText defined in exactly one src file', filesWith(/function deliverText\b/).length === 1, filesWith(/function deliverText\b/));
  const jsonl = read(path.join(ROOT, 'src/server/jsonl.ts'));
  const subs = read(path.join(ROOT, 'src/server/subagents.ts'));
  check('U4: jsonl.ts / subagents.ts restate no `?? 4000` cap', !/\?\?\s*4000/.test(jsonl) && !/\?\?\s*4000/.test(subs), null);
  check('U5: subagents.ts does not raw-slice block text at maxTextChars', !/\.slice\(0,\s*maxTextChars\)/.test(subs), null);

  // deliverText behaviour: no-cap = full; cap = PLAIN cut + metadata, nothing appended.
  const big = 'x'.repeat(9000);
  const nc = deliverText(big), c = deliverText(big, 4000);
  check('U6: deliverText no-cap = full text, not truncated', nc.text.length === 9000 && nc.truncated === undefined, nc.text.length);
  check('U7: deliverText cap = PLAIN cut + truncated + fullLength, nothing appended', c.text === big.slice(0, 4000) && c.truncated === true && c.fullLength === 9000, { len: c.text.length, fullLength: c.fullLength });
  const sur = 'a'.repeat(3999) + '\u{1F600}' + 'b';
  check('U8: deliverText never ends on half a surrogate pair', deliverText(sur, 4000).text === 'a'.repeat(3999), deliverText(sur, 4000).text.length);

  // NO reading route reads maxTextChars from the request (r7 — removed by construction).
  const indexSrc = read(path.join(ROOT, 'src/server/index.ts'));
  const mtcReads = (indexSrc.match(/searchParams\.get\(['"]maxTextChars['"]\)/g) || []).length;
  check('U9: src/server/index.ts reads maxTextChars from ZERO request params (no reading route caps)', mtcReads === 0, { 'searchParams.get(maxTextChars)': mtcReads });

  // Client truncation-note / fence machinery is deleted everywhere in public/.
  const pubFiles = [];
  const walkPub = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory() && e.name !== 'vendor') walkPub(p); else if (/\.js$/.test(e.name) && !/vendor/.test(p)) pubFiles.push(p); } };
  walkPub(path.join(ROOT, 'public'));
  const pubWith = (re) => pubFiles.filter((f) => re.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f));
  check('U10: no appendTruncationNote / truncationNote anywhere in public/', pubWith(/appendTruncationNote|truncationNote/).length === 0, pubWith(/appendTruncationNote|truncationNote/));
  check('U11: no closeTruncatedFence reference anywhere in public/', pubWith(/closeTruncatedFence/).length === 0, pubWith(/closeTruncatedFence/));
  check('U12: no .trunc-note class anywhere in public/', pubWith(/trunc-note/).length === 0 && !/trunc-note/.test(fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8')), pubWith(/trunc-note/));
  check('U13: response-blocks.js no longer exports closeTruncatedFence', !/export function closeTruncatedFence\b/.test(fs.readFileSync(path.join(ROOT, 'public/lib/response-blocks.js'), 'utf8')), null);
  // renderAssistantText renders the whole delivered text (no truncated branch).
  const digestSrc = fs.readFileSync(path.join(ROOT, 'public/lib/digest.js'), 'utf8');
  check('U14: digest.js renderAssistantText has no `opts.truncated` branch', !/opts\.truncated/.test(digestSrc), null);
}

/* --------------------------------------------------------------- browser */
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url, { maxPayload: 256 * 1024 * 1024 });
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
  async waitFor(label, expr, timeoutMs = 30_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) { try { if (await this.eval(expr)) return true; } catch { /* mid-nav */ } await sleep(150); }
    console.log(`        (timed out waiting for ${label})`); return false;
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

/* Render ONE assistant text block through the REAL renderMessages() and report
 * whether a <pre> wraps raw table source and whether a <table> rendered. */
const RENDER = (text) => `(() => {
  const S = window.__station;
  const pane = document.createElement('section');
  pane.className = 'pane'; pane.dataset.thread = 'main';
  document.getElementById('panes').appendChild(pane);
  S.renderMessages({ key: 'p', kind: 'main', paneEl: pane, claudeBody: null, stream: null, tools: new Map() },
    [{ index: 0, role: 'assistant', timestamp: null, uuid: null, parentUuid: null, blocks: [{ type: 'text', text: ${JSON.stringify(text)} }] }]);
  const pres = [...pane.querySelectorAll('pre')].map((p) => p.textContent || '');
  const preHasTableSource = pres.some((t) => /\\|\\s*(Project|Session)\\b/.test(t) || /\\|\\s*-{2,}/.test(t) || /full rechecked status/.test(t));
  const r = { hasTable: !!pane.querySelector('table'), preCount: pres.length, preHasTableSource };
  pane.remove();
  return r;
})()`;

let server = null, browser = null;
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}
async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b234r7-data-'));
const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b234r7-proj-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b234r7-brave-'));

async function main() {
  partU();

  // Realistic-state scratch store (SYNTHETIC): a MAIN transcript and a SUBAGENT
  // transcript, each holding a >4000-char CRLF orchard-answer fold.
  const ENC = '-home-scratch-proj';
  const SID = 'b234bbbb-0000-4000-8000-000000000001';
  const AGENT = 'sub1234';
  const mainFold = fold({ nl: '\r\n', rows: 80 });
  const subFold = fold({ nl: '\r\n', rows: 80 });
  const sessDir = path.join(PROJ, ENC);
  fs.mkdirSync(sessDir, { recursive: true });
  fs.writeFileSync(path.join(sessDir, `${SID}.jsonl`), [
    JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-10-07T00:00:00.000Z', message: { role: 'user', content: 'Recheck every session and report the full table.' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: '2026-10-07T00:00:01.000Z', message: { role: 'assistant', model: 'claude', content: [{ type: 'text', text: mainFold }] } }),
  ].join('\n') + '\n');
  const subDir = path.join(sessDir, SID, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, `agent-${AGENT}.jsonl`), [
    JSON.stringify({ type: 'user', uuid: 'su1', timestamp: '2026-10-07T00:00:00.000Z', message: { role: 'user', content: 'Recheck every session and report the full table.' } }),
    JSON.stringify({ type: 'assistant', uuid: 'sa1', timestamp: '2026-10-07T00:00:01.000Z', message: { role: 'assistant', model: 'claude', content: [{ type: 'text', text: subFold }] } }),
  ].join('\n') + '\n');

  const PORT = Number(process.env.VERIFY_BUG_234_PORT ?? await freePort());
  const BASE = `http://127.0.0.1:${PORT}`;
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: isolatedServerEnv({ PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: PROJ }, { requireStore: true }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  /* ---------------- P. every reading route ignores ?maxTextChars ---------------- */
  console.log('\n=== P. each reading route returns FULL text even with ?maxTextChars=10 ===');
  const findFold = (r, needle = '| Project') => (r.messages || []).flatMap((m) => m.blocks || []).find((b) => b.type === 'text' && typeof b.text === 'string' && b.text.includes(needle));
  const tx = (q) => `${BASE}/api/transcript/${encodeURIComponent(ENC)}/${encodeURIComponent(SID)}?${q}`;
  const sg = (q) => `${BASE}/api/sessions/${encodeURIComponent(SID)}/subagents/${encodeURIComponent(AGENT)}/messages?dir=${encodeURIComponent(ENC)}&${q}`;
  const ROUTES = [
    { label: 'main tail',      url: tx('tail=50&maxTextChars=10'),            want: mainFold },
    { label: 'main forward',   url: tx('offset=0&limit=300&maxTextChars=10'), want: mainFold },
    { label: 'subagent tail',  url: sg('tail=50&maxTextChars=10'),            want: subFold },
    { label: 'subagent page',  url: sg('offset=0&limit=300&maxTextChars=10'), want: subFold },
  ];
  for (const rt of ROUTES) {
    const blk = findFold(await (await fetch(rt.url)).json());
    check(`P[${rt.label}]: ?maxTextChars=10 still returns the FULL block (byte-identical), not truncated`,
      !!blk && blk.text === rt.want && blk.truncated !== true,
      { len: blk?.text?.length, want: rt.want.length, truncated: blk?.truncated });
  }

  /* ---------------- browser for the must-FAIL render ---------------- */
  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0', '--no-first-run', '--disable-extensions', '--window-size=1280,900', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) { try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); } }
  if (!devPort) throw new Error('browser never wrote DevToolsActivePort');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  if (!await cdp.waitFor('app boot', 'window.__station && !!window.__station.renderMessages', 60_000)) throw new Error('app never booted');

  /* ---------------- M. must-FAIL vs the original 4000-cap state ---------------- */
  console.log('\n=== M. MUST-FAIL: deliverText(fold, 4000) rendered by the r7 client shows raw table source ===');
  // The full fold renders a real table (sanity: the fixture is well-formed).
  const fullDom = await cdp.eval(RENDER(mainFold));
  check('M0 sanity: the FULL fold renders a real <table>, no raw <pre>', fullDom.hasTable && !fullDom.preHasTableSource, fullDom);
  // deliverText with the OLD 4000 cap IS a truncated mid-fence cut...
  const cut = deliverText(mainFold, 4000);
  check('M1: deliverText(fold, 4000) is a truncated plain cut (the pre-fix cap state)', cut.truncated === true && cut.text === mainFold.slice(0, 4000), { len: cut.text.length, truncated: cut.truncated });
  // ...and the r7 client (no fence-closing) renders it as RAW table source in a <pre>,
  // with NO <table>. This is the bug the reading-route change removes by never
  // producing a truncated block in the first place.
  const cutDom = await cdp.eval(RENDER(cut.text));
  check('M2 must-FAIL: the 4000-char cut renders raw table source in a <pre> (bug reproduced)', cutDom.preHasTableSource, cutDom);
  check('M3 must-FAIL: the 4000-char cut renders NO real <table> (the table was lost)', !cutDom.hasTable, cutDom);

  /* ---------------- T. tool_use `truncated` status label (BUG-234 r8) ---------------- */
  // A tool_use block whose serialised JSON input exceeded the 16 KiB chip cap
  // (jsonl.ts) carries truncated:true. Through the REAL renderBlockEntry the chip's
  // `.res` status span must read 'truncated'; a non-truncated chip's must be empty.
  // r7 passed '' unconditionally, dropping the label — this check must FAIL on r7.
  console.log('\n=== T. tool_use chip shows the "truncated" status label iff the input was capped ===');
  const TOOL_INPUT = JSON.stringify({ command: 'echo hi', description: 'a '.repeat(50) });
  const RENDER_TOOLS = `(() => {
    const S = window.__station;
    const pane = document.createElement('section');
    pane.className = 'pane'; pane.dataset.thread = 'main';
    document.getElementById('panes').appendChild(pane);
    S.renderMessages({ key: 't', kind: 'main', paneEl: pane, claudeBody: null, stream: null, tools: new Map() },
      [{ index: 0, role: 'assistant', timestamp: null, uuid: null, parentUuid: null, blocks: [
        { type: 'tool_use', toolName: 'Bash', text: ${JSON.stringify(TOOL_INPUT)}, truncated: true },
        { type: 'tool_use', toolName: 'Bash', text: ${JSON.stringify(TOOL_INPUT)} },
      ] }]);
    const res = [...pane.querySelectorAll('details.tool > summary .res')].map((n) => n.textContent || '');
    const chips = pane.querySelectorAll('details.tool').length;
    pane.remove();
    return { res, chips };
  })()`;
  const toolDom = await cdp.eval(RENDER_TOOLS);
  check('T1: exactly two tool_use chips rendered', toolDom.chips === 2, toolDom);
  check('T2: the truncated tool_use chip shows the "truncated" status label', toolDom.res[0] === 'truncated', toolDom.res);
  check('T3 (also must-FAIL on r7): the non-truncated tool_use chip shows NO status label', toolDom.res[1] === '', toolDom.res);

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
