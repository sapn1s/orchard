/**
 * BUG-075 — "+ Add mount" chip must render ONLY for container-isolation
 * sessions (mounts bind-mount host paths INTO a container; a direct/sandbox
 * session already sees the whole filesystem, so the affordance is inert there).
 *
 *   node scripts/verify-bug-075-mount-chip.mjs
 *
 * The bug: paintCrown() appended the mount pills + "+ Add mount" button
 * unconditionally, so a Direct session showed "○ Direct … + Add mount" — the
 * mount affordance leaking across every isolation mode.
 *
 * The fix: gate the mounts block on p.isolation === 'container' — the SAME
 * ground truth (currentProject().isolation) the Direct/Container chip beside it
 * reads, so the two can never disagree, and the strip re-renders on every
 * session switch (paintCrown clears the old .mnt/.addm each pass).
 *
 * Real-shape: boots the REAL app.js in happy-dom, injects a container project
 * and a direct project, and drives the REAL paintCrown() (exposed as a test
 * hook, like paintSessStatus). Asserts against the REAL rendered #seal.
 *
 * PRE-FIX assertions that FAIL: a direct session shows the "+ Add mount" chip;
 * switching container->direct leaves it rendered (stale). Container anti-
 * regression (chip present + wired to the mounts drawer) stays green.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Window } from 'happy-dom';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug075-data-'));

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

const mkProject = (id, name, isolation, mounts = []) => ({
  id, name, isolation,
  settings: { instructions: [], mounts },
});

async function main() {
  console.log('\n========== BUG-075 — "+ Add mount" chip only for container sessions ==========');
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
    constructor(...a) {
      super(...a);
      // No live session is ever opened here (paintCrown is pure DOM+state), so
      // any WS boot() dials may never establish — swallow its 'error'/close so
      // the teardown close() does not throw an unhandled event.
      this.on('error', () => {});
      openSockets.push(this);
    }
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

    const CONTAINER = mkProject('c1', 'ContainerProj', 'container', [{ hostPath: '/data/shared', readOnly: false }]);
    const DIRECT = mkProject('d1', 'DirectProj', 'direct', []);
    st.projects = [DIRECT, CONTAINER];

    const addChip = () => qa('#seal .addm');
    const mntPills = () => qa('#seal .mnt');
    // FEAT-139 — the isolation (connection-mode) chip left the strip for the one
    // Settings door, so the ground truth the mounts read is p.isolation directly
    // (not a chip label). Assert the chip is OFF the strip instead of its text.
    // FEAT-146 round 4 — it is not merely hidden any more, it is DELETED: nothing
    // could un-hide it after FEAT-139, so the button and its popover were dead
    // code. Absent is the stronger form of the same invariant, and this reads
    // it that way rather than weakening to "hidden OR absent".
    const isoHidden = () => q('#isoBtn') === null;
    const paint = (projectId) => { st.current = { ...(st.current ?? {}), projectId }; S.paintCrown(); };

    // ---- DIRECT session: no Add-mount chip (must FAIL pre-fix: chip present) ----
    paint('d1');
    check('direct session: the isolation chip is OFF the strip (FEAT-139/146 → Settings)',
      isoHidden(), `#isoBtn present=${q('#isoBtn') !== null}`);
    check('direct session: NO "+ Add mount" chip (must FAIL pre-fix: present)',
      addChip().length === 0, `.addm count=${addChip().length}`);
    check('direct session: NO mount pills either (mounts are container-only)',
      mntPills().length === 0, `.mnt count=${mntPills().length}`);

    // ---- CONTAINER session: mounts present + functional (anti-regression) ----
    paint('c1');
    check('container session: the isolation chip stays OFF the strip (FEAT-139)',
      isoHidden(), `#isoBtn present=${q('#isoBtn') !== null}`);
    check('container session: "+ Add mount" chip PRESENT',
      addChip().length === 1, `.addm count=${addChip().length}`);
    check('container session: the configured mount renders as a pill (real add-mount display flow)',
      mntPills().length === 1 && (mntPills()[0].textContent ?? '').includes('shared'),
      `.mnt count=${mntPills().length} text=${JSON.stringify(mntPills()[0]?.textContent ?? null)}`);

    // Functional: clicking "+ Add mount" opens the mounts drawer (spy the real
    // drawer.open the handler is wired to — FEAT-054).
    const calls = [];
    const origOpen = S.drawer.open;
    S.drawer.open = (...a) => { calls.push(a); return undefined; };
    addChip()[0].click();
    S.drawer.open = origOpen;
    check('container session: "+ Add mount" is FUNCTIONAL (opens Settings › Mounts)',
      calls.length === 1 && calls[0][0] === 'settings' && calls[0][1]?.focus === 'mounts',
      `drawer.open calls=${JSON.stringify(calls)}`);

    // ---- SWITCH container -> direct hides it (no stale render) ----
    paint('d1');
    check('switch container->direct HIDES the Add-mount chip (must FAIL pre-fix: stale)',
      addChip().length === 0 && mntPills().length === 0 && isoHidden(),
      `.addm=${addChip().length} .mnt=${mntPills().length} #isoBtn present=${q('#isoBtn') !== null}`);

    // ---- SWEEP: FEAT-139 — the CONFIG chips (instructions/provider/isolation)
    // no longer live on the strip in ANY mode; they moved into the one Settings
    // door. Assert the instructions chip is OFF the strip in both modes. ----
    paint('c1'); const insC = q('#insBtn')?.hidden === true;
    paint('d1'); const insD = q('#insBtn')?.hidden === true;
    check('SWEEP: the instructions chip is OFF the strip in BOTH container and direct (FEAT-139)',
      insC && insD, `insBtn hidden container=${insC} direct=${insD}`);
  } finally {
    try {
      const st2 = win.__station?.state;
      if (st2?.drainWaitTimer) { clearInterval(st2.drainWaitTimer); st2.drainWaitTimer = null; }
      if (st2?.liveTimer) { clearInterval(st2.liveTimer); st2.liveTimer = null; }
    } catch { /* app never booted that far */ }
    // Keep an 'error' listener attached across close() — a never-established WS
    // emits 'error' during close(), which throws if unhandled (do NOT
    // removeAllListeners here, that would strip the swallow installed above).
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
