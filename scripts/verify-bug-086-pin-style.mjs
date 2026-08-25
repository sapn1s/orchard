/**
 * BUG-086 — pinned sessions rendered like the ACTIVE/open session, so you could
 * not tell which session was actually OPEN vs merely PINNED.
 *
 *   Wanted: the OPEN row (aria-current="true") keeps the active highlight (the
 *   "you are here" state); a PINNED-but-not-open row gets a quieter, distinct
 *   treatment that reads as "pinned" — an explicit pin GLYPH marker, NOT a
 *   full active-style highlight — and clearly looks un-selected. A pinned-AND-
 *   open row shows the active highlight AND the pin marker (active wins, pin is
 *   secondary). A plain row is plain.
 *
 * Real-shape: boots the REAL app.js in happy-dom against a REAL server, injects
 * the REAL styles.css, drives the REAL renderTree/sessionRow over controlled
 * state, and asserts on computed styling + the rendered DOM marker. Nothing here
 * re-implements the row builder or the stylesheet.
 *
 * PRE-FIX assertions that FAIL: a pinned-not-open row carries no explicit pin
 * marker element (the only pin indicator was a leading-edge ::before bar that
 * reads as selection), so "pinned reads as pinned, distinct from active" cannot
 * hold; a pinned-AND-open row likewise has no pin marker beside the highlight.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Window } from 'happy-dom';
import WebSocket from 'ws';
import { findNeighborProject } from './lib/neighbor-project.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug086-data-'));
const NEIGHBOR = findNeighborProject({ excludePath: ROOT });
const NB = path.basename(NEIGHBOR);

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${line}`);
  ok ? pass++ : (fail++, failures.push(name));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const HOUR = 3600 * 1000;

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
async function waitFor(label, fn, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (fn()) return true; await sleep(100); }
  console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
  return false;
}

let server = null;

async function main() {
  console.log('\n========== BUG-086 — pinned rows read as pinned (marker), only the open row keeps the active highlight ==========');
  if (!fs.existsSync(NEIGHBOR)) throw new Error(`precondition failed: ${NEIGHBOR} missing`);
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;

  server = spawn(process.execPath, [ENTRY], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'ignore', 'pipe'], detached: true,
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(200); } }
  if (!up) throw new Error('server never became healthy');

  const reg = await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: NEIGHBOR, name: NB }),
  });
  if (!reg.ok) throw new Error(`could not register ${NB}: ${await reg.text()}`);

  // ---- boot the REAL app.js in happy-dom against the REAL server, with the
  // REAL styles.css injected (the shared harness strips <link> tags, so computed
  // styling would otherwise be blank — re-inject it as a <style> node).
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  const win = new Window({ url: `${BASE}/` });
  const doc = win.document;
  doc.write(html.replace(/<link[^>]*>/g, '').replace(/<script[^>]*><\/script>/g, ''));
  doc.close();
  const styleEl = doc.createElement('style');
  styleEl.textContent = css;
  doc.head.append(styleEl);

  const g = win;
  const realFetch = globalThis.fetch;
  g.fetch = (input, init) => realFetch(input.startsWith('http') ? input : BASE + input, init);
  const openSockets = [];
  class TrackedWebSocket extends WebSocket {
    constructor(...a) { super(...a); this.on('error', () => {}); openSockets.push(this); }
  }
  g.WebSocket = TrackedWebSocket;
  win.location.host = `127.0.0.1:${PORT}`;

  const prev = { WebSocket: globalThis.WebSocket, fetch: globalThis.fetch };
  globalThis.document = doc;
  globalThis.window = win;
  globalThis.WebSocket = g.WebSocket;
  globalThis.location = win.location;
  globalThis.fetch = g.fetch;

  try {
    await import(`${path.join(ROOT, 'public', 'app.js')}?ui=${Date.now()}`);
    const qa = (s) => [...doc.querySelectorAll(s)];
    const booted = await waitFor('project list', () => qa('#tree button.proj').length > 0);
    if (!booted) throw new Error('app.js never rendered any project row');

    const S = win.__station;
    const st = S.state;

    const PID = 'p-pin';
    const ENC = 'enc-pin';
    const mk = (id, title, extra = {}) => ({
      sessionId: id, encodedDir: ENC, displayTitle: title, os: 'linux',
      lastActivityAt: iso(1 * HOUR), ...extra,
    });
    st.projects = [{ id: PID, name: 'Pins', lastActivityAt: iso(1 * HOUR), hostPath: '/tmp/pins' }];
    st.projSort = 'recency'; S.resortProjects();
    st.expanded = new Set([PID]);

    const groupOf = () => qa('#tree .pgroup')
      .find((gr) => gr.querySelector('.proj .nm')?.textContent.trim() === 'Pins');
    const cs = (e) => win.getComputedStyle(e);
    // happy-dom's `background` shorthand is unreliable ("none none" when unset),
    // so read backgroundColor and normalise every "no fill" spelling to "".
    const NO_FILL = new Set(['', 'transparent', 'none', 'rgba(0, 0, 0, 0)', 'rgba(0,0,0,0)']);
    const bg = (e) => { const v = (cs(e).backgroundColor || '').trim(); return NO_FILL.has(v) ? '' : v; };
    const ink = (e) => (cs(e).color || '').trim();
    const hasMark = (e) => !!e.querySelector('.pin-mark');
    const activeAttr = (e) => e.getAttribute('aria-current');
    const hasSvg = (e) => !!e.querySelector('.pin-mark svg');

    // Only ONE session is "open" (aria-current) at a time, so the open+unpinned
    // case and the pinned+open case need two separate renders.
    const mkList = () => [
      mk('PINONLY', 'PINONLY', { pinned: true }), // pinned, not open
      mk('PLAIN', 'PLAIN'),                       // neither
      mk('OPENISH', 'OPENISH'),                   // the current session (unpinned here)
    ];
    const rowFor = (gr, t) => [...gr.querySelectorAll('.kids button.row')]
      .find((r) => r.textContent.replace(/\s+/g, ' ').trim().endsWith(t));

    // ===== Scenario A: the open session is UNPINNED =====
    st.seen = new Map();
    st.current = { projectId: PID, encodedDir: ENC, sessionId: 'OPENISH', title: null, os: null };
    st.sessions = new Map([[PID, { loaded: true, loading: false, error: null, list: mkList(), shown: 10, encodedDir: ENC, dirs: [] }]]);
    S.renderTree();
    let gr = groupOf();
    const open = rowFor(gr, 'OPENISH');
    const pin = rowFor(gr, 'PINONLY');
    const plain = rowFor(gr, 'PLAIN');
    if (!open || !pin || !plain) throw new Error(`missing rows A: open=${!!open} pin=${!!pin} plain=${!!plain}`);

    const plainBg = bg(plain), plainInk = ink(plain);
    const openBg = bg(open), openInk = ink(open);

    // Sanity: the active highlight is a real, distinct treatment on the open row.
    check('open row carries the active highlight (background differs from a plain row)',
      openBg && openBg !== plainBg, `open.bg="${openBg}" plain.bg="${plainBg}"`);
    check('open row is aria-current="true"', activeAttr(open) === 'true', `aria-current=${activeAttr(open)}`);

    // The core distinction: a pinned-not-open row must NOT wear the active
    // highlight — it reads exactly as un-selected as a plain row, unlike the open row.
    check('pinned-not-open row is NOT highlighted like the open row (no active background)',
      bg(pin) === plainBg && bg(pin) !== openBg,
      `pin.bg="${bg(pin)}" plain.bg="${plainBg}" open.bg="${openBg}"`);
    check('pinned-not-open row text stays quiet (same ink as a plain row, not the open row\'s ink)',
      ink(pin) === plainInk && ink(pin) !== openInk,
      `pin.ink=${ink(pin)} plain.ink=${plainInk} open.ink=${openInk}`);
    check('pinned-not-open row is aria-current="false" (clearly un-selected)',
      activeAttr(pin) === 'false', `aria-current=${activeAttr(pin)}`);

    // The pin READING: an explicit pin marker element. (must FAIL pre-fix — the
    // only pin indicator was a leading-edge ::before bar, no marker element.)
    check('pinned-not-open row shows an explicit pin marker glyph (must FAIL pre-fix: no marker element)',
      hasMark(pin), `.pin-mark present=${hasMark(pin)}`);
    check('pin marker renders an actual glyph (svg), not empty', hasSvg(pin), `svg present=${hasSvg(pin)}`);

    // A plain and an open-unpinned row carry NO pin marker — the mark appears
    // only where it means something.
    check('plain row is plain: no active highlight, no pin marker',
      bg(plain) === plainBg && !hasMark(plain), `plain.bg="${bg(plain)}" mark=${hasMark(plain)}`);
    check('open-but-unpinned row has NO pin marker (highlight is not a pin)',
      !hasMark(open), `mark=${hasMark(open)}`);

    // ===== Scenario B: the open session is ALSO pinned =====
    const listB = [mk('BOTH', 'BOTH', { pinned: true }), mk('PLAIN', 'PLAIN')];
    st.current = { projectId: PID, encodedDir: ENC, sessionId: 'BOTH', title: null, os: null };
    st.sessions.set(PID, { loaded: true, loading: false, error: null, list: listB, shown: 10, encodedDir: ENC, dirs: [] });
    S.renderTree();
    gr = groupOf();
    const both = rowFor(gr, 'BOTH');
    if (!both) throw new Error('missing row B: both');

    // Pinned AND open: active highlight WINS, pin marker still shown as secondary.
    check('pinned-AND-open row keeps the active highlight (background like the open row)',
      bg(both) === openBg && bg(both) !== '', `both.bg="${bg(both)}" openBg="${openBg}"`);
    check('pinned-AND-open row ALSO shows the pin marker (must FAIL pre-fix: no marker beside the highlight)',
      hasMark(both), `.pin-mark present=${hasMark(both)}`);
    check('pinned-AND-open row is aria-current="true"', activeAttr(both) === 'true', `aria-current=${activeAttr(both)}`);
  } finally {
    try {
      const st2 = win.__station?.state;
      if (st2?.snapPollTimer) { clearInterval(st2.snapPollTimer); st2.snapPollTimer = null; }
      if (st2?.liveTimer) { clearInterval(st2.liveTimer); st2.liveTimer = null; }
    } catch { /* never booted */ }
    for (const s of openSockets) { try { s.on('error', () => {}); s.close(); } catch { /* closed */ } }
    await sleep(200);
    globalThis.WebSocket = prev.WebSocket; globalThis.fetch = prev.fetch;
  }
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(async () => {
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : (process.exitCode ?? 0);
  try { if (server?.pid) process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ }
  await sleep(300);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
  setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
});
