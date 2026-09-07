/**
 * BUG-167 — prose() renders a bulleted list as one run-on paragraph when the
 * bullets follow a paragraph line with NO blank line between them.
 *
 *   npm run verify:bug-167
 *
 * prose() (public/lib/dom.js) splits blocks on blank lines only, and only treats
 * a block as a list when its FIRST line is a bullet. So a lead-in line followed
 * immediately (no blank line) by `- ` items fell through to the fallback, which
 * joins every line with a single space — a bulleted list became one <p> blob.
 * CommonMark starts a list at that bullet; this renderer did not. Also affected
 * `1.`-numbered lists after a lead-in line. Fix: a bullet line interrupts a
 * paragraph — emit the lead-in as a <p> and re-run the remainder (which now
 * starts at a marker, so the block-start path builds the ul/ol).
 *
 * This drives the REAL served public/lib/dom.js prose() in a REAL browser
 * (brave --headless=new over raw CDP; free port, never :4317; PID-kill only) and
 * grades RENDERED DOM SHAPE + reader-visible text.
 *
 *  A. MUST-FAIL repro, anchored to a FIXED baseline: the pre-fix prose() is loaded
 *     from a pinned git revision (PREFIX_SHA below, copied into public/lib/ so its
 *     `./response-blocks.js` import still resolves). For the real reported input it
 *     produces ONE <p> with all bullets inline and ZERO <ul>. The shipped prose()
 *     produces a <ul> with one <li> per item and the lead-in as its own <p>.
 *     Numbered (`1.`) variant checked the same way.
 *  B. Sibling shapes still render (anti-regression): a blank-line-separated list,
 *     a plain multi-line paragraph, a heading immediately followed by a list, and
 *     a wrapped-bullet continuation (the fold the fix must not steal from).
 *  C. Light + dark captures of the fixed render, each graded on its own pixels.
 */
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import { shotLedger } from './lib/shot-luma.mjs';

// A revision that does NOT contain the fix — the must-FAIL baseline. Pinned to a
// sha (not HEAD/"current") so it stays the pre-fix state after the fix commits.
const PREFIX_SHA = process.env.VERIFY_BUG_167_PREFIX_SHA ?? 'f42537f';

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const PORT = Number(process.env.VERIFY_BUG_167_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b167-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b167-brave-'));
const BRAVE = process.env.VERIFY_BUG_167_BROWSER ?? 'brave';
const SHOT_LIGHT = path.join(ROOT, 'docs', 'bugs', 'assets', 'BUG-167-light.png');
const SHOT_DARK = path.join(ROOT, 'docs', 'bugs', 'assets', 'BUG-167-dark.png');
// The pre-fix module, dropped beside the real one so its ./response-blocks.js
// import resolves. Served over /lib/, cleaned up in finally.
const PREFIX_REL = '__bug167-prefix-dom.js';
const PREFIX_ABS = path.join(ROOT, 'public', 'lib', PREFIX_REL);

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

/* -------------------------------------------------------------- fixtures */
// The REAL reported input: a bold lead-in line, then bullets on the very next
// line with NO blank line. Sentinels are greppable so we can locate items.
const REPORTED =
  '**Skills (3)** — the areas this session is scoped to:\n' +
  '- Web Development B167alpha\n' +
  '- Web App Architecture B167beta\n' +
  '- API Integration B167gamma';

// Same shape with an ordered list (BULLET also matches `\d+.`).
const NUMBERED =
  'Here are the next steps for the rollout:\n' +
  '1. Draft the migration B167one\n' +
  '2. Review with the team B167two\n' +
  '3. Ship it B167three';

const ITEMS = ['B167alpha', 'B167beta', 'B167gamma'];
const NUMS = ['B167one', 'B167two', 'B167three'];

const b64 = (s) => Buffer.from(s).toString('base64');

async function main() {
  // Materialise the pinned pre-fix prose() beside the live one.
  const prefixSrc = execFileSync('git', ['show', `${PREFIX_SHA}:public/lib/dom.js`], { cwd: ROOT }).toString();
  if (/A bullet line interrupts a paragraph/.test(prefixSrc)) {
    throw new Error(`PREFIX_SHA ${PREFIX_SHA} already contains the fix — it is not a valid must-FAIL baseline`);
  }
  fs.writeFileSync(PREFIX_ABS, prefixSrc);

  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
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
  await cdp.waitFor('app boot', 'window.__station && !!window.__station.renderMessages', 60_000);

  const modReady = await cdp.eval(`(async () => {
    const live = await import('/lib/dom.js');
    const pre = await import('/lib/${PREFIX_REL}');
    window.__prose = live.prose;      // shipped (fixed) prose()
    window.__prosePre = pre.prose;    // pinned pre-fix prose()
    return typeof window.__prose === 'function' && typeof window.__prosePre === 'function';
  })()`);
  if (!modReady) throw new Error('could not import both live and pre-fix prose from /lib/');

  // Render raw text through a named prose fn; report DOM shape + reader text.
  const render = (fnName, raw) => `(() => {
    const host = document.createElement('div');
    host.replaceChildren(window.${fnName}(atob(${JSON.stringify(b64(raw))})));
    const uls = host.querySelectorAll('ul').length;
    const ols = host.querySelectorAll('ol').length;
    const lis = [...host.querySelectorAll('li')].map((n) => n.textContent.trim());
    const ps = [...host.querySelectorAll('p')].map((n) => n.textContent.trim());
    const text = host.textContent;
    return { uls, ols, lis, ps, text };
  })()`;

  /* ================= A. MUST-FAIL repro (bulleted) ==================== */
  console.log('\n=== A. bullets after a lead-in line: pre-fix run-on <p> vs fixed <ul> ===');
  const pre = await cdp.eval(render('__prosePre', REPORTED));
  check(`MUST-FAIL PRE-FIX (${PREFIX_SHA}): the list renders as ONE <p> with the bullets inline, zero <ul>`,
    pre.uls === 0 && pre.ps.length === 1 && ITEMS.every((t) => pre.ps[0]?.includes(t)),
    { uls: pre.uls, pCount: pre.ps.length, p0: pre.ps[0] });

  const fix = await cdp.eval(render('__prose', REPORTED));
  check('FIXED: renders a <ul> with exactly one <li> per item',
    fix.uls === 1 && fix.ols === 0 && fix.lis.length === 3
      && ITEMS.every((t, i) => fix.lis[i]?.includes(t)),
    { uls: fix.uls, ols: fix.ols, lis: fix.lis });
  check('FIXED: the lead-in is its own <p>, and the bullet labels are NOT inside it',
    fix.ps.length === 1 && fix.ps[0].includes('Skills (3)') && !ITEMS.some((t) => fix.ps[0].includes(t)),
    { ps: fix.ps });
  check('FIXED: no content lost — lead-in + all three item sentinels reader-visible',
    fix.text.includes('Skills (3)') && ITEMS.every((t) => fix.text.includes(t)),
    { text: fix.text });

  /* ================= A2. MUST-FAIL repro (numbered) ================== */
  console.log('\n=== A2. numbered list after a lead-in line ===');
  const preN = await cdp.eval(render('__prosePre', NUMBERED));
  check(`MUST-FAIL PRE-FIX (${PREFIX_SHA}): numbered list renders as ONE <p>, zero <ol>`,
    preN.ols === 0 && preN.ps.length === 1 && NUMS.every((t) => preN.ps[0]?.includes(t)),
    { ols: preN.ols, pCount: preN.ps.length, p0: preN.ps[0] });
  const fixN = await cdp.eval(render('__prose', NUMBERED));
  check('FIXED: renders an <ol> (not <ul>) with one <li> per item',
    fixN.ols === 1 && fixN.uls === 0 && fixN.lis.length === 3
      && NUMS.every((t, i) => fixN.lis[i]?.includes(t)),
    { ols: fixN.ols, uls: fixN.uls, lis: fixN.lis });

  /* ================= B. sibling shapes (anti-regression) ============= */
  console.log('\n=== B. sibling markdown shapes still render correctly (fixed prose) ===');
  // B1: blank-line-separated list (already worked pre-fix) — must stay a <ul>/3 <li>.
  const sepList = '**Skills (3)** — the areas:\n\n- Web Dev B167s1\n- Web App B167s2\n- API B167s3';
  const b1 = await cdp.eval(render('__prose', sepList));
  check('[sibling] blank-line-separated list: <ul> with 3 <li>, lead-in as its own <p>',
    b1.uls === 1 && b1.lis.length === 3 && b1.ps.length === 1 && b1.ps[0].includes('Skills (3)'),
    { uls: b1.uls, lis: b1.lis, ps: b1.ps });

  // B2: a plain multi-line paragraph (no bullets) — must stay ONE <p>, no list.
  const para = 'This is a normal paragraph that\nwraps across two source lines\nand has no list markers at all.';
  const b2 = await cdp.eval(render('__prose', para));
  check('[sibling] plain wrapped paragraph: ONE <p>, no <ul>/<ol>, lines joined',
    b2.uls === 0 && b2.ols === 0 && b2.ps.length === 1 && b2.text.includes('wraps across two source lines'),
    { uls: b2.uls, ols: b2.ols, ps: b2.ps });

  // B3: heading immediately followed by a list.
  const headList = '### Section B167h\n- item one B167h1\n- item two B167h2';
  const b3 = await cdp.eval(render('__prose', headList));
  check('[sibling] heading then list: an <h*> heading plus a <ul> with 2 <li>',
    b3.uls === 1 && b3.lis.length === 2 && b3.text.includes('Section B167h'),
    { uls: b3.uls, lis: b3.lis, text: b3.text.slice(0, 80) });

  // B4: wrapped-bullet continuation — the fold the fix must NOT steal (at===0 block).
  const wrapped = '- a bullet whose text B167w1\n  wraps onto a second line\n- second bullet B167w2';
  const b4 = await cdp.eval(render('__prose', wrapped));
  check('[sibling] wrapped-bullet continuation: 2 <li>, continuation folded into first item',
    b4.uls === 1 && b4.lis.length === 2 && b4.lis[0].includes('wraps onto a second line'),
    { uls: b4.uls, lis: b4.lis });

  /* ==================== C. graded light + dark shots ================= */
  console.log('\n=== C. light + dark captures of the fixed render, graded on pixels ===');
  await cdp.eval(`(() => {
    document.body.replaceChildren();
    document.body.style.margin = '16px';
    document.body.appendChild(window.__prose(atob(${JSON.stringify(b64(REPORTED))})));
    return true;
  })()`);
  const ledger = shotLedger();
  fs.mkdirSync(path.dirname(SHOT_LIGHT), { recursive: true });
  for (const [tone, file] of [['light', SHOT_LIGHT], ['dark', SHOT_DARK]]) {
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: tone }] });
    await sleep(200);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    const g = ledger.record(file, tone);
    check(`${tone} capture written and graded ${tone} (own pixels, not a twin)`, g.ok, `${file} — ${g.why}`);
  }

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
  try { fs.rmSync(PREFIX_ABS, { force: true }); } catch { /* gone */ }
  setTimeout(() => {
    for (const dir of [DATA, PROFILE]) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } }
    process.exit(process.exitCode ?? 0);
  }, 1500);
});
