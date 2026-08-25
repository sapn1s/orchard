/**
 * Per-message hover timestamp (user request): each chat message carries a
 * timestamp that is WEIGHTLESS at rest and revealed to the SIDE on hover, so
 * normal reading is uncrowded but the real time of any message is one hover away.
 *
 * Requirements proven here (REAL brave browser over CDP against a REAL server,
 * the verify-feat-082 rig — so getComputedStyle/opacity and real :hover behave
 * exactly as for the user; the visual gate LOOKS at the pixels):
 *
 *   FUNCTIONAL (renderMessages into the live main pane over a realistic,
 *   multi-day fixture — user + assistant + tool + thinking + a harness notice):
 *     1. user + assistant PROSE messages each get a <time.msg-ts> with a
 *        machine-readable datetime that round-trips the recorded ISO;
 *     2. tool chips, thinking chips and station notices do NOT get one
 *        ("where it makes sense");
 *     3. at REST the stamp is invisible (computed opacity 0) and OUT of flow;
 *     4. on real :hover the stamp becomes visible (opacity → 1) after the
 *        anti-flicker delay;
 *     5. hovering shifts NO layout — the bubble's own text box does not move a
 *        pixel between rest and hover (absolute-positioned stamp);
 *     6. accessibility — it is a real <time> in the a11y tree (not display:none),
 *        with a title carrying the full string.
 *
 *   VISUAL GATE: rest + hover, at wide and narrow widths, in light and dark
 *   (prefers-color-scheme via CDP + data-theme), each capture graded by
 *   shot-luma (a light-labelled shot must be light, dark must be dark, no two
 *   byte-identical). Files under /tmp for a human/agent to open.
 *
 * Process hygiene: OS-assigned free port (never 4317); kill children by PID only.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import { shotLedger } from './lib/shot-luma.mjs';
import { findNeighborProject } from './lib/neighbor-project.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-msgts-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-msgts-chrome-'));
const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-msgts-shots-'));
const BRAVE = process.env.VERIFY_BROWSER ?? 'brave';
const NEIGHBOR = findNeighborProject({ excludePath: ROOT });
const NB = path.basename(NEIGHBOR);
const ledger = shotLedger();

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
      try { if (await this.eval(expr)) return true; } catch { /* mid-nav */ }
      await sleep(150);
    }
    console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
    return false;
  }
  async moveMouse(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  }
  async tab() {
    // A real Tab key press through the input pipeline (not a scripted focus()).
    for (const type of ['rawKeyDown', 'keyUp']) {
      await this.send('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    }
    await sleep(20);
  }
  // The COMPUTED accessible name of the first element matching `selector`, read
  // from the REAL accessibility tree (not the aria-label attribute). This is what
  // a screen reader announces.
  async axName(selector) {
    const { root } = await this.send('DOM.getDocument', { depth: -1 });
    const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) return null;
    const { nodes } = await this.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
    const n = nodes?.find((x) => x.name?.value != null) ?? nodes?.[0];
    return n?.name?.value ?? null;
  }
  async shot(file, tone) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    const v = ledger.record(file, tone);
    check(`capture ${path.basename(file)} — distinct${tone ? `, genuinely ${tone}` : ''}`, v.ok, `${file} — ${v.why}`);
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

let server = null, browser = null;
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

// Realistic, multi-DAY fixture: yesterday's exchange + today's, so the dated
// formatter ("yesterday 14:32" / "14:32") is actually exercised, plus the row
// kinds that must NOT get a stamp (tool, thinking) and one that renders as a
// station notice rather than a bubble.
const DAY1 = '2026-08-17T09:15:00.000Z';
const DAY1B = '2026-08-17T09:15:42.000Z';
const DAY2 = '2026-08-18T14:32:00.000Z';
const DAY2B = '2026-08-18T14:33:20.000Z';
const FIX = [
  { role: 'user', index: 0, timestamp: DAY1, blocks: [{ type: 'text', text: 'Can you start on the login refactor when you have a moment?' }] },
  { role: 'assistant', index: 1, timestamp: DAY1B, blocks: [{ type: 'text', text: 'Sure. I will read the current auth flow first, then propose a plan before changing anything.' }] },
  { role: 'user', index: 2, timestamp: DAY2, blocks: [{ type: 'text', text: 'Great — go ahead and implement it now.' }] },
  {
    role: 'assistant', index: 3, timestamp: DAY2B, blocks: [
      { type: 'text', text: 'Implementing the refactor now. I will extract the token exchange into its own module and add coverage.' },
      { type: 'thinking', text: 'The current handler mixes transport and policy; splitting them makes the retry path testable in isolation.' },
      { type: 'tool_use', toolName: 'Edit', text: JSON.stringify({ file_path: '/app/auth/login.js', old_string: 'const x = 1', new_string: 'const x = 2' }) },
    ],
  },
  // A harness-injected notification: must render as a collapsed notice, NOT a
  // user bubble, and therefore must carry no message timestamp.
  {
    role: 'user', index: 4, timestamp: DAY2B, blocks: [{
      type: 'text',
      text: '[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>\n<task-id>abc123</task-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>',
    }],
  },
];

async function main() {
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  console.log('\n========== per-message hover timestamp — functional + visual gate ==========');
  if (!fs.existsSync(NEIGHBOR)) throw new Error(`precondition: neighbor ${NEIGHBOR} missing`);

  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  const reg = await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: NEIGHBOR, name: NB }),
  });
  if (!reg.ok) throw new Error(`register failed: ${await reg.text()}`);
  const PID = (await reg.json()).project.id;

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
  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');
  await cdp.send('Accessibility.enable');

  const setTheme = async (mode) => {
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: mode }] });
    await cdp.eval(`(() => { try { localStorage.setItem('cs.theme', ${JSON.stringify(mode)}); } catch {}; document.documentElement.dataset.theme = ${JSON.stringify(mode)}; })()`);
    await sleep(250);
  };
  const setWidth = async (w) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(150);
  };

  await cdp.send('Page.navigate', { url: `${BASE}/` });
  const booted = await cdp.waitFor('app boot', 'window.__station && !!window.__station.renderMessages && !!window.__station.stampTime', 30_000);
  if (!booted) throw new Error('app never booted');

  // Open the neighbor's newest session so the transcript view is live + visible,
  // then replace the main pane with our fixture (rendered by the REAL renderer).
  const opened = await cdp.eval(`(async () => {
    const S = window.__station;
    const rows = await (await fetch('/api/projects/${PID}/sessions')).json();
    const list = rows.sessions ?? [];
    if (!list.length) return { ok: false, why: 'no sessions' };
    await S.openSession({ id: '${PID}' }, list[0]);
    return { ok: true };
  })()`);
  check('precondition: a real session opened (transcript view is live)', opened?.ok, opened);
  await cdp.waitFor('transcript pane', `!!document.querySelector('#panes .pane')`, 30_000);
  await sleep(400);

  // Render the fixture into the visible main pane through the real renderer.
  const rendered = await cdp.eval(`(() => {
    const S = window.__station;
    const th = S.mainThread();
    th.paneEl.replaceChildren();
    th.claudeBody = null; th.stream = null;
    const shown = S.renderMessages(th, ${JSON.stringify(FIX)});
    S.showThread('main');
    const pane = th.paneEl;
    const q = (s) => [...pane.querySelectorAll(s)];
    const stampsIn = (sel) => q(sel).filter((n) => n.querySelector(':scope > time.msg-ts')).length;
    const firstUser = pane.querySelector('.you.has-ts');
    const ts = firstUser?.querySelector('time.msg-ts');
    return {
      shown,
      userBubbles: q('.you').length,
      userStamped: stampsIn('.you'),
      proseStamped: q('.prose.has-ts, .msg-with-digest.has-ts').length,
      // rows that must NOT be stamped
      toolStamped: q('.tool').filter((n) => n.querySelector('time.msg-ts')).length,
      thinkingStamped: q('.tool').filter((n) => /thinking/.test(n.textContent) && n.querySelector('time.msg-ts')).length,
      noticeCount: q('.notice').length,
      noticeStamped: q('.notice').filter((n) => n.querySelector('time.msg-ts')).length,
      tsTag: ts?.tagName,
      tsDatetime: ts?.getAttribute('datetime') ?? null,
      tsText: ts?.textContent ?? null,
      tsTitle: ts?.getAttribute('title') ?? null,
    };
  })()`);
  console.log('  render report:', JSON.stringify(rendered));
  check('user bubbles each carry a <time.msg-ts>', rendered.userBubbles > 0 && rendered.userStamped === rendered.userBubbles,
    `bubbles=${rendered.userBubbles} stamped=${rendered.userStamped}`);
  check('assistant PROSE messages carry a <time.msg-ts>', rendered.proseStamped >= 2, `proseStamped=${rendered.proseStamped}`);
  check('tool chips are NOT stamped ("where it makes sense")', rendered.toolStamped === 0, `toolStamped=${rendered.toolStamped}`);
  check('thinking chips are NOT stamped', rendered.thinkingStamped === 0, `thinkingStamped=${rendered.thinkingStamped}`);
  check('the harness notice renders as a notice, not a stamped bubble', rendered.noticeCount >= 1 && rendered.noticeStamped === 0,
    `notices=${rendered.noticeCount} stamped=${rendered.noticeStamped}`);
  check('the stamp is a real <time> element (a11y — in the accessibility tree)', rendered.tsTag === 'TIME', `tag=${rendered.tsTag}`);
  check('datetime round-trips the recorded ISO', rendered.tsDatetime === new Date(Date.parse(DAY1)).toISOString(),
    `datetime=${rendered.tsDatetime} expected=${new Date(Date.parse(DAY1)).toISOString()}`);
  check('the visible stamp text is a non-empty absolute time (HH:MM)', /\d{1,2}:\d{2}/.test(rendered.tsText ?? ''), `text=${JSON.stringify(rendered.tsText)}`);
  check('a title carries the full machine string', !!rendered.tsTitle && rendered.tsTitle.length > 5, `title=${JSON.stringify(rendered.tsTitle)}`);

  /* ─── BUG-106 clean-room defect B — keyboard / assistive-tech access, proven in
   * a REAL browser via the accessibility tree + a REAL Tab traversal (the
   * verifier's own caveat: its probe was source-level, not a real Tab / AX walk).
   *
   * The broken shape declared a `:focus-within` reveal but nothing in a message is
   * focusable, so the affordance could never fire AND the only thing an AT user
   * could obtain was the terse gutter text ("14:32"). The fix exposes the FULL
   * absolute time through the <time>'s accessible NAME, announced in reading order
   * with no focus or hover — and does NOT add a Tab stop per message. These checks
   * assert exactly that reality. */
  // The full, unambiguous time in the accessibility tree — no hover, no focus.
  const axFullName = await cdp.axName('.you.has-ts time.msg-ts');
  console.log('  a11y name:', JSON.stringify(axFullName));
  const day1 = new Date(Date.parse(DAY1));
  const hasYear = !!axFullName && axFullName.includes(String(day1.getFullYear()));
  const hasWord = !!axFullName && /[A-Za-z]{3,}/.test(axFullName); // a month/weekday word, not just digits
  check('AT: the <time> accessible NAME carries the FULL absolute time (year + a date word), reachable with no focus/hover',
    hasYear && hasWord, `axName=${JSON.stringify(axFullName)} hasYear=${hasYear} hasWord=${hasWord}`);
  check('AT: the accessible name is RICHER than the terse gutter text (not merely the "HH:MM" a mouse user sees)',
    !!axFullName && axFullName.trim() !== (rendered.tsText ?? '').trim() && axFullName.length > (rendered.tsText ?? '').length,
    `axName=${JSON.stringify(axFullName)} gutterText=${JSON.stringify(rendered.tsText)}`);

  // No dead focus reveal + no Tab-stop explosion: a real Tab traversal must never
  // land on a timestamp or a message bubble (which would be one stop PER message).
  await cdp.eval(`document.body.focus?.(); if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();`);
  const landings = [];
  let hitStampOrBubble = false;
  for (let i = 0; i < 40; i++) {
    await cdp.tab();
    const where = await cdp.eval(`(() => { const a = document.activeElement; if (!a) return null;
      return { tag: a.tagName, cls: a.className || '', isStamp: a.matches?.('time.msg-ts') === true,
               inBubble: !!a.closest?.('.you, .claude'), isBubble: a.matches?.('.you, .claude') === true }; })()`);
    if (!where) continue;
    landings.push(`${where.tag}.${String(where.cls).split(' ')[0]}`);
    if (where.isStamp || where.isBubble) hitStampOrBubble = true;
  }
  check('KEYBOARD: a real 40-Tab traversal NEVER lands on a timestamp or a message bubble (no per-message stop)',
    !hitStampOrBubble, `hitStampOrBubble=${hitStampOrBubble} sample=${JSON.stringify(landings.slice(0, 12))}`);

  // The stamp itself is not a keyboard focus target (a per-message stop) — its info
  // travels by accessible name, so this is correct, not a gap.
  const stampFocusable = await cdp.eval(`(() => { const t = document.querySelector('.you.has-ts time.msg-ts');
    if (!t) return null; const ti = t.getAttribute('tabindex'); return { tabindex: ti, focusableByTab: ti != null && Number(ti) >= 0 }; })()`);
  check('KEYBOARD: the timestamp is intentionally NOT a Tab stop (its info is in the accessible name instead)',
    stampFocusable && stampFocusable.focusableByTab === false, `stamp=${JSON.stringify(stampFocusable)}`);

  await setTheme('light');
  await setWidth(1280);

  // REST opacity + geometry of a target user bubble.
  const target = await cdp.eval(`(() => {
    const b = document.querySelector('.you.has-ts');
    b.scrollIntoView({ block: 'center' });
    const ts = b.querySelector('time.msg-ts');
    const p = b.querySelector('p');
    const br = b.getBoundingClientRect();
    return {
      restOpacity: getComputedStyle(ts).opacity,
      tsPosition: getComputedStyle(ts).position,
      textLeft: Math.round(p.getBoundingClientRect().left),
      textTop: Math.round(p.getBoundingClientRect().top),
      cx: Math.round(br.left + br.width / 2),
      cy: Math.round(br.top + br.height / 2),
    };
  })()`);
  check('REST: the stamp is invisible (opacity 0)', target.restOpacity === '0', `opacity=${target.restOpacity}`);
  check('the stamp is absolutely positioned (out of flow — cannot shift text)', target.tsPosition === 'absolute', `position=${target.tsPosition}`);
  await cdp.shot(path.join(SHOTS, 'light-wide-rest.png'), 'light');

  // HOVER: move the real pointer over the bubble, wait past the show-delay.
  await cdp.moveMouse(target.cx, target.cy);
  await sleep(400);
  const hover = await cdp.eval(`(() => {
    const b = document.querySelector('.you.has-ts');
    const ts = b.querySelector('time.msg-ts');
    const p = b.querySelector('p');
    return {
      hoverOpacity: getComputedStyle(ts).opacity,
      textLeft: Math.round(p.getBoundingClientRect().left),
      textTop: Math.round(p.getBoundingClientRect().top),
      tsVisibleWidth: Math.round(ts.getBoundingClientRect().width),
    };
  })()`);
  check('HOVER: the stamp becomes visible (opacity 1)', hover.hoverOpacity === '1', `opacity=${hover.hoverOpacity}`);
  check('NO LAYOUT SHIFT: the bubble text does not move between rest and hover',
    hover.textLeft === target.textLeft && hover.textTop === target.textTop,
    `rest=(${target.textLeft},${target.textTop}) hover=(${hover.textLeft},${hover.textTop})`);
  await cdp.shot(path.join(SHOTS, 'light-wide-hover.png'), 'light');

  // DARK, wide — rest + hover.
  await setTheme('dark');
  await cdp.moveMouse(5, 5); await sleep(300);
  await cdp.shot(path.join(SHOTS, 'dark-wide-rest.png'), 'dark');
  await cdp.moveMouse(target.cx, target.cy); await sleep(400);
  await cdp.shot(path.join(SHOTS, 'dark-wide-hover.png'), 'dark');

  // NARROW — the width where a side stamp is most at risk of colliding with text.
  await setWidth(430);
  await cdp.eval(`document.querySelector('.you.has-ts').scrollIntoView({ block: 'center' })`);
  const narrow = await cdp.eval(`(() => {
    const b = document.querySelector('.you.has-ts');
    const br = b.getBoundingClientRect();
    return { cx: Math.round(br.left + br.width / 2), cy: Math.round(br.top + br.height / 2) };
  })()`);
  await setTheme('light');
  await cdp.moveMouse(narrow.cx, narrow.cy); await sleep(400);
  await cdp.shot(path.join(SHOTS, 'light-narrow-hover.png'), 'light');
  await setTheme('dark');
  await cdp.moveMouse(narrow.cx, narrow.cy); await sleep(400);
  await cdp.shot(path.join(SHOTS, 'dark-narrow-hover.png'), 'dark');

  console.log(`\n  shots in: ${SHOTS}`);
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(async () => {
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : (process.exitCode ?? 0);
  stopByPid(server); stopByPid(browser);
  await sleep(300);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(`(screenshots left in ${SHOTS} for review)`);
  setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
});
