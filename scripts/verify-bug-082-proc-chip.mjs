/**
 * BUG-082 — the crown proc chip dumped EVERY listening port inline, growing
 * unbounded (6-7+ scratch ports) and crowding the other crown chips out.
 *
 *   node scripts/verify-bug-082-proc-chip.mjs
 *
 * The fix: the chip previews only the first PROC_PORT_CAP ports inline (:4317
 * always first, then ascending — a STABLE order so it doesn't jitter between
 * polls) with a "+N" overflow; clicking #procBtn opens #procPop (the shared
 * chip-popover chrome / place()+closePops(), like model/provider) which lists
 * EVERY listening port. The "· N procs" summary is kept.
 *
 * Real-shape: boots the REAL app.js in happy-dom against a REAL server, injects
 * a project + a procSummary with N>cap ports, and drives the REAL
 * paintProcChip() / the REAL #procBtn click handler. Asserts against the REAL
 * rendered #procN / #procPop.
 *
 * PRE-FIX assertions that FAIL: with 9 ports the inline preview shows all 9
 * (not capped); there is no "+N"; the first inline port is the raw-order head,
 * not :4317. The popover (#procPop) does not exist pre-fix. Anti-regression:
 * the "· N procs" summary and the singular/plural grammar stay intact; a
 * single-port summary stays fully inline (verify:processes crown assertion).
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Window } from 'happy-dom';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug082-data-'));

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
async function waitFor(label, fn, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (fn()) return true; await sleep(100); }
  console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
  return false;
}

let server = null;

const mkProject = (id, name) => ({ id, name, isolation: 'direct', settings: { instructions: [], mounts: [] } });

async function main() {
  console.log('\n========== BUG-082 — proc chip caps inline ports + opens a full-list popover ==========');
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

  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const win = new Window({ url: `${BASE}/` });
  const doc = win.document;
  doc.write(html.replace(/<link[^>]*>/g, '').replace(/<script[^>]*><\/script>/g, ''));
  doc.close();

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
    const q = (s) => doc.querySelector(s);
    const qa = (s) => [...doc.querySelectorAll(s)];

    const booted = await waitFor('app boot', () => !!win.__station?.state);
    if (!booted) throw new Error('app.js never exposed __station.state');
    const S = win.__station;
    const st = S.state;

    st.projects = [mkProject('p1', 'ProcProj')];
    st.current = { ...(st.current ?? {}), projectId: 'p1' };

    // Paint via the dedicated hook when present (post-fix); fall back to the
    // always-exported paintCrown() (which calls paintProcChip internally) so the
    // PRE-FIX run reaches the assertions and FAILS them, rather than crashing on
    // a hook the old code never exported.
    const paintChip = () => { if (S.paintProcChip) S.paintProcChip(); else S.paintCrown(); };
    const popOpen = () => q('#procPop')?.classList?.contains('open') ?? false;
    const clickChip = () => { try { q('#procBtn').dispatchEvent(new win.Event('click', { bubbles: true })); } catch { /* pre-fix handler opens the drawer */ } };

    // ---- N=9 ports (raw, shuffled, :4317 NOT first) — the reported crowding. ----
    const RAW = [37129, 44173, 4317, 35873, 44677, 37825, 44913, 33001, 40002]; // 9 ports
    st.procSummary = { p1: { count: 11, ports: RAW, hasSelf: true } };
    paintChip();

    const chipText = () => q('#procN')?.textContent ?? '';
    // Inline port tokens are the ":NNNN" runs BEFORE the "· N procs" summary.
    const inlinePorts = () => {
      const head = chipText().split('·')[0];
      return (head.match(/:\d+/g) ?? []);
    };

    const CAP = 3;
    check(`inline preview caps at ${CAP} ports (must FAIL pre-fix: all 9 inline)`,
      inlinePorts().length === CAP, `inline=${JSON.stringify(inlinePorts())} | text=${JSON.stringify(chipText())}`);
    check('overflow shown as "+N" (N = 9 - cap = 6) (must FAIL pre-fix: no +N)',
      /\+6\b/.test(chipText()), `text=${JSON.stringify(chipText())}`);
    check(':4317 is ALWAYS the first inline port (must FAIL pre-fix: raw-order head)',
      inlinePorts()[0] === ':4317', `inline[0]=${JSON.stringify(inlinePorts()[0])}`);
    check('remaining inline ports ascending after :4317 (stable, no jitter)',
      JSON.stringify(inlinePorts()) === JSON.stringify([':4317', ':33001', ':35873']),
      `inline=${JSON.stringify(inlinePorts())}`);
    check('the "· N procs" summary is kept (anti-regression)',
      /·\s*11 procs\b/.test(chipText()), `text=${JSON.stringify(chipText())}`);

    // ---- Chip width bounded: never more than CAP ":port" tokens inline, no
    // matter how many ports the poll reports (the whole point of the fix). ----
    st.procSummary = { p1: { count: 40, ports: Array.from({ length: 30 }, (_, i) => 40000 + i).concat(4317), hasSelf: true } };
    paintChip();
    check('width bounded: 31 ports still previews only CAP inline (+overflow)',
      inlinePorts().length === CAP && /\+28\b/.test(chipText()), `inline=${inlinePorts().length} text=${JSON.stringify(chipText())}`);

    // ---- Stable order across re-renders: same set, shuffled input, same text. ----
    const SET = [44913, 4317, 37825, 35873]; // 4 ports
    st.procSummary = { p1: { count: 6, ports: SET, hasSelf: true } };
    paintChip();
    const t1 = chipText();
    st.procSummary = { p1: { count: 6, ports: [...SET].reverse(), hasSelf: true } };
    paintChip();
    const t2 = chipText();
    check('stable ordering: same port set in a different input order → identical chip text',
      t1 === t2 && t1.startsWith(':4317'), `t1=${JSON.stringify(t1)} t2=${JSON.stringify(t2)}`);

    // ---- Clicking #procBtn opens #procPop listing ALL ports (the full view). ----
    st.procSummary = { p1: { count: 11, ports: RAW, hasSelf: true } };
    paintChip();
    check('popover starts closed', !popOpen(), q('#procPop')?.className ?? '(no #procPop pre-fix)');
    clickChip();
    const popRows = () => qa('#procPorts .proc-port .pn').map((n) => n.textContent);
    check('click opens #procPop (reuses place()/closePops() chip-popover chrome)',
      popOpen(), q('#procPop')?.className ?? '(no #procPop pre-fix)');
    check('popover lists ALL 9 ports (the full list, not the capped preview)',
      popRows().length === 9, `rows=${JSON.stringify(popRows())}`);
    check('popover order matches the inline order (:4317 first, then ascending)',
      JSON.stringify(popRows()) === JSON.stringify([4317, 33001, 35873, 37129, 37825, 40002, 44173, 44677, 44913].map((x) => `:${x}`)),
      `rows=${JSON.stringify(popRows())}`);
    check('the :4317 row is tagged "station" (the primary port is legible)',
      qa('#procPop .proc-port').some((r) => /:4317/.test(r.textContent) && /station/.test(r.textContent)),
      qa('#procPop .proc-port').map((r) => r.textContent).join(' | '));

    // Clicking again (or closePops) closes it — a real toggle, not a leak.
    clickChip();
    check('clicking #procBtn again closes the popover (toggle)',
      !popOpen(), q('#procPop')?.className ?? '(no #procPop pre-fix)');

    // ---- Anti-regression: a SINGLE port stays fully inline (verify:processes
    // crown assertion — one scratch port must still read ":NNNN · 1 proc"). ----
    st.procSummary = { p1: { count: 1, ports: [51515], hasSelf: false } };
    paintChip();
    check('single port: fully inline, no "+N", singular "1 proc" grammar (verify:processes parity)',
      chipText() === ':51515 · 1 proc', `text=${JSON.stringify(chipText())}`);

    // ---- Anti-regression: no ports → just the proc count, chip still shown. ----
    st.procSummary = { p1: { count: 3, ports: [], hasSelf: false } };
    paintChip();
    check('no ports: chip shows only the proc count (no dangling separator)',
      chipText() === '3 procs' && q('#procBtn').hidden === false, `text=${JSON.stringify(chipText())} hidden=${q('#procBtn').hidden}`);

    // ---- Anti-regression: zero processes hides the chip AND closes any pop. ----
    if (S.paintProcPop) { S.paintProcPop(); q('#procPop')?.classList.add('open'); }
    st.procSummary = { p1: { count: 0, ports: [] } };
    paintChip();
    check('zero procs: chip hidden and any open popover is closed',
      q('#procBtn').hidden === true && !popOpen(),
      `hidden=${q('#procBtn').hidden} popOpen=${popOpen()}`);
  } finally {
    try {
      const st2 = win.__station?.state;
      if (st2?.drainWaitTimer) { clearInterval(st2.drainWaitTimer); st2.drainWaitTimer = null; }
      if (st2?.liveTimer) { clearInterval(st2.liveTimer); st2.liveTimer = null; }
    } catch { /* app never booted that far */ }
    for (const s of openSockets) { try { s.on?.('error', () => {}); s.close(); } catch { /* closed */ } }
    await sleep(300);
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
