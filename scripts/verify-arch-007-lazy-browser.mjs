#!/usr/bin/env node
/**
 * ARCH-007 — capability-owned laziness.
 *
 * WHAT WENT WRONG. Enabling the stealth browser for a project made a real,
 * headful Chrome window appear the moment a session started, whether or not
 * anything ever used it. The station had already made this lazy for `direct`
 * sessions by interposing a 648-line stdio relay of its own — but the container
 * branch of `startSession()` still called `browser.start()` unconditionally, and
 * the adapter's daemon was eager by construction: it claimed its socket, reaped
 * orphans, LAUNCHED CHROME, and only then served. So the fix landed for a mode
 * the user's own projects do not use, and the window kept appearing.
 *
 * WHAT WAS DECIDED. Option A: move laziness into the thing that owns the
 * browser. The adapter's daemon now serves FIRST and launches Chrome on the
 * first page-dependent tool call. The station's relay is deleted, and both
 * isolation shapes invoke the adapter's own entry point.
 *
 * WHAT THIS FILE PROVES, and why it is shaped this way:
 *
 *   - It runs the REAL adapter at `browser.repoDir()`, not a fixture. The bug
 *     lived in that file, on the user's machine.
 *   - It runs a LIVE MUST-FAIL CONTROL: the pre-change daemon, checked out from
 *     the adapter's own git history, is started the same way and must launch
 *     Chrome before any tool call. A lazy-start suite that never demonstrates
 *     the eager behaviour proves nothing about the change.
 *   - Section G is HEADFUL and counts actual X windows, because "no window
 *     appears" is the user's criterion and a process count is only a proxy for
 *     it. Everything else runs headless so the suite does not spray windows
 *     across the user's desktop.
 *
 * Scratch state only (SBMCP_STATE_DIR under ~/scratch, never /tmp); every daemon
 * and Chrome it starts is scoped to a per-run profile dir and torn down at the
 * end. Override the location with ARCH007_SCRATCH.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browser = await import(path.join(ROOT, 'src/server/browser.ts'));

const ADAPTER = browser.repoDir();
if (ADAPTER === null) {
  // FEAT-049: no baked-in adapter path any more. This suite drives the REAL
  // adapter, so an unset CLAUDE_STATION_SBMCP_REPO is a skip, not a failure.
  console.log('SKIP verify-arch-007: CLAUDE_STATION_SBMCP_REPO is not set — point it at a browser-adapter checkout to run this suite.');
  process.exit(0);
}
const SCRATCH_ROOT = process.env.ARCH007_SCRATCH || path.join(os.homedir(), 'scratch', 'arch-007');
const SCRATCH = path.join(SCRATCH_ROOT, `verify-${process.pid}`);
const STATE = path.join(SCRATCH, 'state');
fs.mkdirSync(STATE, { recursive: true });

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  return ok;
}
const section = (s) => console.log(`\n${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- helpers */

const projRoot = (state, p) => path.join(state, 'projects', p);
const sockOf = (state, p) => path.join(projRoot(state, p), 'browser.sock');
const profileOf = (state, p) => path.join(projRoot(state, p), 'chrome-data');

/** Exactly the adapter's own scan: match this profile's --user-data-dir in /proc. */
function chromePids(profile) {
  const needle = `--user-data-dir=${profile}`;
  const all = [];
  let root = null;
  let entries;
  try { entries = fs.readdirSync('/proc'); } catch { return { root: null, all: [] }; }
  for (const d of entries) {
    if (!/^\d+$/.test(d)) continue;
    let cmd;
    try { cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8'); } catch { continue; }
    if (!cmd.includes(needle)) continue;
    all.push(Number(d));
    if (!cmd.includes('--type=')) root = root ?? Number(d);
  }
  return { root, all };
}

/** Visible Chrome/Chromium window ids. Used as a SET diff so the user's own
 *  browser windows can never be miscounted as ours. */
function chromeWindows() {
  const r = spawnSync('xdotool', ['search', '--onlyvisible', '--class', 'chrom'], { encoding: 'utf8' });
  return new Set((r.stdout || '').trim().split('\n').filter(Boolean));
}

/** One request over a fresh socket connection. */
function rpc(sock, msg, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const c = net.connect(sock);
    let buf = '';
    const t = setTimeout(() => { c.destroy(); reject(new Error('rpc timeout')); }, timeoutMs);
    c.on('error', (e) => { clearTimeout(t); reject(e); });
    c.on('connect', () => c.write(JSON.stringify({ id: 1, ...msg }) + '\n'));
    c.on('data', (d) => {
      buf += d.toString('utf8');
      const i = buf.indexOf('\n');
      if (i < 0) return;
      clearTimeout(t); c.destroy();
      let m; try { m = JSON.parse(buf.slice(0, i)); } catch (e) { return reject(e); }
      m.ok ? resolve(m.result) : reject(new Error(m.error));
    });
  });
}

/**
 * N requests pipelined down ONE connection, which is the shape production uses
 * (the MCP shim multiplexes every tool call over a single socket). Resolves when
 * all N have replied, so a lost or mis-correlated reply hangs and is caught.
 */
function rpcMany(sock, msgs, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const c = net.connect(sock);
    const out = new Map();
    let buf = '';
    const t = setTimeout(() => { c.destroy(); reject(new Error(`rpcMany timeout: got ${out.size}/${msgs.length}`)); }, timeoutMs);
    c.on('error', (e) => { clearTimeout(t); reject(e); });
    c.on('connect', () => {
      // One write, so all N land together and genuinely race.
      c.write(msgs.map((m, i) => JSON.stringify({ id: i + 1, ...m })).join('\n') + '\n');
    });
    c.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        out.set(m.id, m);
        if (out.size === msgs.length) {
          clearTimeout(t); c.destroy();
          return resolve([...out.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v));
        }
      }
    });
  });
}

const statusOf = async (sock) => JSON.parse((await rpc(sock, { op: 'tools/call', name: 'browser_status', args: {} })).content[0].text);

function cli(state, args, timeout = 130_000, env = {}) {
  return spawnSync(process.execPath, [path.join(ADAPTER, 'src/cli.mjs'), ...args], {
    encoding: 'utf8', timeout, env: { ...process.env, SBMCP_STATE_DIR: state, ...env },
  });
}

const started = [];
function trackDaemon(state, p) { started.push({ state, p }); }

/* ------------------------------------------------- a local page to render */

let pageUrl = null;
const pageServer = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>ARCH-007 fixture</title><body><h1 id="h">lazy-browser-ok</h1></body>');
});
await new Promise((r) => pageServer.listen(0, '127.0.0.1', r));
pageUrl = `http://127.0.0.1:${pageServer.address().port}/`;

/* ================================================== A. station-side wiring */

section('A. station wiring — no processes, nothing started');

const cap = browser.lazyStartCapability();
check('adapter declares lazy start in package.json', cap.ok && cap.version >= 1, `${JSON.stringify(cap)}`);
check('available() accepts the real adapter', browser.available().ok, browser.available().message);

{
  // An adapter that cannot declare laziness is the eager kind. The station must
  // refuse it rather than attach it and pop a window.
  const fake = path.join(SCRATCH, 'eager-adapter');
  fs.mkdirSync(path.join(fake, 'src'), { recursive: true });
  fs.mkdirSync(path.join(fake, 'node_modules'), { recursive: true });
  for (const f of ['cli.mjs', 'mcp-stdio.mjs', 'tools.mjs']) fs.writeFileSync(path.join(fake, 'src', f), '');
  const write = (o) => fs.writeFileSync(path.join(fake, 'package.json'), JSON.stringify(o));

  const prev = process.env.CLAUDE_STATION_SBMCP_REPO;
  process.env.CLAUDE_STATION_SBMCP_REPO = fake;

  write({ name: 'x' });
  let a = browser.available();
  check('available() REFUSES an adapter with no capability declaration', !a.ok && /lazy/i.test(a.message), a.message.slice(0, 110));

  write({ name: 'x', sbmcp: { capabilities: { lazyStart: 0 } } });
  a = browser.available();
  check('available() REFUSES lazyStart=0', !a.ok, a.message.slice(0, 60));

  write({ name: 'x', sbmcp: { capabilities: { lazyStart: 'yes' } } });
  a = browser.available();
  check('available() REFUSES a non-numeric lazyStart', !a.ok, a.message.slice(0, 60));

  fs.writeFileSync(path.join(fake, 'package.json'), '{ not json');
  a = browser.available();
  check('available() REFUSES unparseable package.json', !a.ok && /JSON/i.test(a.message), a.message.slice(0, 60));

  write({ name: 'x', sbmcp: { capabilities: { lazyStart: browser.REQUIRED_LAZY_START } } });
  a = browser.available();
  check('available() ACCEPTS a declared lazy adapter', a.ok, a.message.slice(0, 60));

  if (prev == null) delete process.env.CLAUDE_STATION_SBMCP_REPO; else process.env.CLAUDE_STATION_SBMCP_REPO = prev;
}

{
  const p = (iso) => ({ id: 'arch007-proj', name: 'p', path: '/tmp/x', isolation: iso });
  const d = browser.mcpServerFor(p('direct'), 12_345);
  check(
    'direct isolation invokes the ADAPTER entry point, not a station-owned server',
    d.args.length === 1 && d.args[0] === browser.mcpStdioPath() && d.args[0].startsWith(ADAPTER),
    d.args[0],
  );
  check('direct isolation carries no relay env', !('SBMCP_INNER_SHIM' in d.env) && !('SBMCP_TOOLS_MODULE' in d.env), JSON.stringify(d.env));
  check('direct isolation preserves the project idle setting', d.env.SBMCP_IDLE_MS === '12345', d.env.SBMCP_IDLE_MS);

  const c = browser.mcpServerFor(p('container'));
  check(
    'container isolation invokes the mounted adapter shim with autostart off',
    c.args[0] === browser.CONTAINER_MCP_STDIO && c.env.SBMCP_AUTOSTART === '0' && c.env.SBMCP_SOCKET === browser.CONTAINER_SOCKET,
    JSON.stringify(c.env),
  );
}

check(
  'the station-owned relay file is gone',
  !fs.existsSync(path.join(ROOT, 'src/server/sbmcp-lazy-shim.mjs')),
  'src/server/sbmcp-lazy-shim.mjs',
);
{
  const g = spawnSync('grep', ['-rn', 'sbmcp-lazy-shim\\|lazyShimPath', 'src', 'public', 'scripts'], { cwd: ROOT, encoding: 'utf8' });
  const hits = (g.stdout || '').split('\n').filter((l) => l.trim() && !l.startsWith('scripts/verify-arch-007'));
  check('nothing in the tree still references the relay', hits.length === 0, hits.slice(0, 3).join(' | '));
}
{
  const src = fs.readFileSync(path.join(ROOT, 'src/server/agent-bridge.ts'), 'utf8');
  const idx = src.indexOf('BROWSER BEFORE CONTAINER');
  const block = src.slice(idx, idx + 3500);
  check(
    'the container branch no longer promises a running browser at session start',
    !/starting stealth browser/.test(block) && /stealth browser armed/.test(block),
    'agent-bridge container branch',
  );
}

/* ============================== B. MUST-FAIL CONTROL: the pre-change daemon */

section('B. must-fail control — the pre-ARCH-007 daemon, live from the adapter\'s git history');

{
  const ctlDir = path.join(SCRATCH, 'eager-daemon');
  fs.mkdirSync(ctlDir, { recursive: true });
  const base = spawnSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: ADAPTER, encoding: 'utf8' }).stdout.trim().split('\n')[0];
  const show = spawnSync('git', ['show', `${base}:src/daemon.mjs`], { cwd: ADAPTER, encoding: 'utf8' });
  const haveControl = show.status === 0 && show.stdout.includes('await launch();');
  check('the eager daemon is recoverable from version control', haveControl, `base=${base?.slice(0, 8)}`);

  if (haveControl) {
    // Run the ORIGINAL daemon against the CURRENT adapter's deps and helpers.
    fs.writeFileSync(path.join(ADAPTER, 'src', '.arch007-control-daemon.mjs'), show.stdout);
    const state = path.join(SCRATCH, 'state-eager');
    const p = 'control';
    fs.mkdirSync(projRoot(state, p), { recursive: true });
    const child = spawn(process.execPath, [path.join(ADAPTER, 'src/.arch007-control-daemon.mjs'), '--project', p], {
      detached: true, stdio: 'ignore',
      env: { ...process.env, SBMCP_STATE_DIR: state, SBMCP_HEADLESS: 'true' },
    });
    child.unref();
    // Wait for the socket to answer — the eager daemon only serves AFTER Chrome.
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      await sleep(500);
      try { await rpc(sockOf(state, p), { op: 'ping' }, 2000); up = true; } catch {}
    }
    const pids = chromePids(profileOf(state, p));
    check(
      'CONTROL: the eager daemon has launched Chrome by the time it answers at all',
      up && pids.all.length > 0,
      `serving=${up} chrome_procs=${pids.all.length}`,
    );
    if (up) {
      // And its status could not be asked without a browser existing.
      const st = await statusOf(sockOf(state, p)).catch((e) => ({ error: e.message }));
      check('CONTROL: the eager daemon reports no lazy_start field', st.lazy_start === undefined, JSON.stringify(Object.keys(st)).slice(0, 90));
    }
    cli(state, ['stop', p]);
    try { fs.unlinkSync(path.join(ADAPTER, 'src', '.arch007-control-daemon.mjs')); } catch {}
    const left = chromePids(profileOf(state, p)).all;
    check('CONTROL cleaned up', left.length === 0, `${left.length} left`);
  }
}

/* =========================== C. lazy adapter: arming starts nothing at all */

section('C. arming — the station call that used to open a window');

const P1 = 'lazy-arm';
{
  const r = cli(STATE, ['start', P1], 130_000, { SBMCP_HEADLESS: 'true' });
  trackDaemon(STATE, P1);
  check('sbmcp start exits 0', r.status === 0, (r.stdout || r.stderr || '').trim().slice(0, 120));
  check('the socket exists (this is what a container mount needs)', fs.existsSync(sockOf(STATE, P1)));
  check(
    'NO Chrome process exists after arming — the reported symptom',
    chromePids(profileOf(STATE, P1)).all.length === 0,
    `${chromePids(profileOf(STATE, P1)).all.length} chrome processes`,
  );
  const meta = JSON.parse(fs.readFileSync(path.join(projRoot(STATE, P1), 'daemon.json'), 'utf8'));
  check('daemon metadata exists with a NULL chrome pid', meta.chromePid === null && meta.lazyStart === true, JSON.stringify(meta).slice(0, 120));

  const sock = sockOf(STATE, P1);
  const tl = await rpc(sock, { op: 'tools/list' });
  check('tools/list answers without a browser', Array.isArray(tl.tools) && tl.tools.length > 0, `${tl.tools?.length} tools`);
  check('listing tools started no Chrome', chromePids(profileOf(STATE, P1)).all.length === 0);

  const caps = await rpc(sock, { op: 'capabilities' });
  check('capabilities op declares lazyStart at runtime too', caps.lazyStart >= 1 && caps.chromeRunning === false, JSON.stringify(caps).slice(0, 120));
  check('asking for capabilities started no Chrome', chromePids(profileOf(STATE, P1)).all.length === 0);

  const st = await statusOf(sock);
  check('browser_status reports chrome_running=false', st.chrome_running === false && st.lazy_start === true, JSON.stringify(st).slice(0, 140));
  check(
    'ASKING FOR STATUS STARTED NO CHROME — status must not be what launches it',
    chromePids(profileOf(STATE, P1)).all.length === 0,
  );

  // Repeatedly, because a one-shot check would miss a status path that launches
  // only on a second call or after a cache expires.
  for (let i = 0; i < 5; i++) await statusOf(sock);
  check('five more status calls still started no Chrome', chromePids(profileOf(STATE, P1)).all.length === 0);

  const cs = JSON.parse(cli(STATE, ['status', P1]).stdout)[0];
  check(
    'the CLI reports running=false, daemon_running=true for an armed browser',
    cs.running === false && cs.daemon_running === true && cs.lazy_start === true && cs.chrome_procs_live === 0,
    JSON.stringify(cs).slice(0, 160),
  );
}

/* ============================= D. concurrent first calls -> exactly one Chrome */

section('D. the launch race — eight concurrent first calls');

{
  const sock = sockOf(STATE, P1);
  const N = 8;
  const t0 = Date.now();
  const replies = await rpcMany(sock, Array.from({ length: N }, () => ({ op: 'tools/call', name: 'browser_evaluate', args: { expression: '1+1' } })));
  const okCount = replies.filter((r) => r.ok).length;
  check(`all ${N} concurrent first calls got a reply`, replies.length === N, `${replies.length}`);
  check(`all ${N} concurrent first calls SUCCEEDED`, okCount === N, `${okCount}/${N} ok; first error: ${replies.find((r) => !r.ok)?.error ?? '-'}`);
  check('replies are correctly correlated (ids 1..N, each once)', new Set(replies.map((r) => r.id)).size === N, JSON.stringify(replies.map((r) => r.id)));

  const pids = chromePids(profileOf(STATE, P1));
  check(
    'EXACTLY ONE Chrome root process was launched by eight racing callers',
    pids.root !== null && chromeRoots(profileOf(STATE, P1)) === 1,
    `roots=${chromeRoots(profileOf(STATE, P1))} total_procs=${pids.all.length} in ${Date.now() - t0}ms`,
  );

  const st = await statusOf(sock);
  check('status now reports chrome_running=true with a pid', st.chrome_running === true && typeof st.chrome_pid === 'number', JSON.stringify({ r: st.chrome_running, p: st.chrome_pid }));
  const cs = JSON.parse(cli(STATE, ['status', P1]).stdout)[0];
  check('the CLI now reports running=true', cs.running === true && cs.chrome_procs_live > 0, JSON.stringify({ r: cs.running, n: cs.chrome_procs_live }));
}

function chromeRoots(profile) {
  const needle = `--user-data-dir=${profile}`;
  let n = 0;
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    let cmd; try { cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8'); } catch { continue; }
    if (cmd.includes(needle) && !cmd.includes('--type=')) n++;
  }
  return n;
}

/* ============================================ E. it actually works, and stops */

section('E. a real page, then stop-without-killing-the-daemon');

{
  const sock = sockOf(STATE, P1);
  const nav = await rpc(sock, { op: 'tools/call', name: 'browser_navigate', args: { url: pageUrl } });
  const text = nav?.content?.[0]?.text ?? '';
  check('a real page renders through the lazily-launched browser', /lazy-browser-ok/.test(text), text.slice(0, 120).replace(/\n/g, ' '));

  // browser/stop reclaims Chrome but must leave the socket serving: a container
  // has this socket bind-mounted and cannot recreate it.
  const r = await rpc(sock, { op: 'browser/stop' });
  check('browser/stop reports it stopped Chrome', r.stopped === true, JSON.stringify(r));
  check('Chrome is gone after browser/stop', chromePids(profileOf(STATE, P1)).all.length === 0, `${chromePids(profileOf(STATE, P1)).all.length} left`);
  check('the socket file still exists after browser/stop', fs.existsSync(sockOf(STATE, P1)));
  const ping = await rpc(sock, { op: 'ping' }).catch((e) => ({ error: e.message }));
  check('the daemon is STILL SERVING after browser/stop', ping.ok === true, JSON.stringify(ping));
  const st = await statusOf(sock);
  check('status is answerable again with Chrome absent', st.chrome_running === false && st.chrome_pid === null, JSON.stringify({ r: st.chrome_running, p: st.chrome_pid }));

  // And it relaunches: laziness must be a state, not a one-shot.
  const nav2 = await rpc(sock, { op: 'tools/call', name: 'browser_navigate', args: { url: pageUrl } });
  check('a page-dependent call RELAUNCHES Chrome after a stop', /lazy-browser-ok/.test(nav2?.content?.[0]?.text ?? ''));
  check('exactly one Chrome root after the relaunch', chromeRoots(profileOf(STATE, P1)) === 1, `${chromeRoots(profileOf(STATE, P1))}`);
}

/* ============================================== F. teardown paths with no Chrome */

section('F. stop / cleanup before Chrome ever exists');

{
  const r = cli(STATE, ['stop', P1]);
  const out = `${r.stdout}${r.stderr}`;
  check('sbmcp stop on a launched browser exits 0', r.status === 0, out.trim().slice(0, 120));
  check('sbmcp stop reports no orphans', !/ORPHANS REMAIN/.test(out), out.trim().slice(0, 120));
  check('no Chrome and no socket left', chromePids(profileOf(STATE, P1)).all.length === 0 && !fs.existsSync(sockOf(STATE, P1)));
}

{
  // The case current daemon metadata was never written for: stop a daemon that
  // never launched anything.
  const P2 = 'never-used';
  const s = cli(STATE, ['start', P2], 130_000, { SBMCP_HEADLESS: 'true' });
  trackDaemon(STATE, P2);
  check('a second project arms cleanly', s.status === 0 && chromePids(profileOf(STATE, P2)).all.length === 0);
  const r = cli(STATE, ['stop', P2]);
  const out = `${r.stdout}${r.stderr}`;
  check('sbmcp stop on a NEVER-LAUNCHED daemon exits 0', r.status === 0, out.trim().slice(0, 120));
  check('...and does not claim orphans remain', !/ORPHANS REMAIN/.test(out), out.trim().slice(0, 120));
  check('...and removes the socket', !fs.existsSync(sockOf(STATE, P2)));

  // reap must also tolerate a lazy, never-launched daemon.
  const P3 = 'reap-me';
  cli(STATE, ['start', P3], 130_000, { SBMCP_HEADLESS: 'true' });
  trackDaemon(STATE, P3);
  const rr = cli(STATE, ['reap']);
  check('reap leaves a HEALTHY never-launched daemon alone', rr.status === 0 && fs.existsSync(sockOf(STATE, P3)), (rr.stdout || '').trim().slice(0, 80));
  const st = await statusOf(sockOf(STATE, P3)).catch((e) => ({ error: e.message }));
  check('...and it is still serving afterwards', st.chrome_running === false, JSON.stringify(st).slice(0, 80));
  cli(STATE, ['stop', P3]);
}

{
  // Idle must reclaim CHROME and keep the socket, or a container loses its mount.
  const P4 = 'idle-proj';
  const s = cli(STATE, ['start', P4], 130_000, { SBMCP_HEADLESS: 'true', SBMCP_IDLE_MS: '4000' });
  trackDaemon(STATE, P4);
  check('idle-test daemon armed', s.status === 0);
  const sock = sockOf(STATE, P4);
  await rpc(sock, { op: 'tools/call', name: 'browser_evaluate', args: { expression: '1+1' } });
  check('idle-test browser launched on demand', chromeRoots(profileOf(STATE, P4)) === 1);
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) { await sleep(500); gone = chromePids(profileOf(STATE, P4)).all.length === 0; }
  check('the idle timeout closed CHROME', gone, `${chromePids(profileOf(STATE, P4)).all.length} chrome procs`);
  check('the idle timeout did NOT remove the socket', fs.existsSync(sock));
  const ping = await rpc(sock, { op: 'ping' }, 5000).catch((e) => ({ error: e.message }));
  check('the daemon is still serving after an idle close', ping.ok === true, JSON.stringify(ping));
  const nav = await rpc(sock, { op: 'tools/call', name: 'browser_navigate', args: { url: pageUrl } }).catch((e) => ({ error: e.message }));
  check('a call after an idle close relaunches and works', /lazy-browser-ok/.test(nav?.content?.[0]?.text ?? ''), nav.error ?? 'ok');
  cli(STATE, ['stop', P4]);
  check('idle project torn down clean', chromePids(profileOf(STATE, P4)).all.length === 0);
}

/* ================================== G. the user's criterion: an actual window */

section('G. HEADFUL — what the user actually sees');

{
  const P5 = 'headful';
  const before = chromeWindows();
  const s = cli(STATE, ['start', P5], 130_000); // headful: no SBMCP_HEADLESS
  trackDaemon(STATE, P5);
  check('headful project armed', s.status === 0, (s.stdout || s.stderr || '').trim().slice(0, 100));
  await sleep(2500); // give a window time to appear if one is going to
  const afterArm = chromeWindows();
  const newAfterArm = [...afterArm].filter((w) => !before.has(w));
  check(
    'NO NEW BROWSER WINDOW APPEARS WHEN A BROWSER-ENABLED SESSION ARMS — the success criterion',
    newAfterArm.length === 0,
    `${newAfterArm.length} new window(s)`,
  );
  check('...and no Chrome process either', chromePids(profileOf(STATE, P5)).all.length === 0);

  const sock = sockOf(STATE, P5);
  const nav = await rpc(sock, { op: 'tools/call', name: 'browser_navigate', args: { url: pageUrl } });
  check('THE BROWSER STILL WORKS when something actually uses it', /lazy-browser-ok/.test(nav?.content?.[0]?.text ?? ''), (nav?.content?.[0]?.text ?? '').slice(0, 90).replace(/\n/g, ' '));
  await sleep(1500);
  const afterUse = chromeWindows();
  const newAfterUse = [...afterUse].filter((w) => !before.has(w));
  check('...and a real window exists once it is used', newAfterUse.length >= 1, `${newAfterUse.length} new window(s)`);

  cli(STATE, ['stop', P5]);
  await sleep(1200);
  const afterStop = [...chromeWindows()].filter((w) => !before.has(w));
  check('the window is gone after stop', afterStop.length === 0, `${afterStop.length} left`);
}

/* ================ H/I. the real station, a real session, both isolation shapes */

/*
 * Everything above drives the adapter directly. These two sections drive the
 * product: a real claude-station server on a free port with its own
 * CLAUDE_STATION_DATA, a real project with the browser enabled, and one real
 * message. That is where the user met the bug, and section I is the CONTAINER
 * shape specifically — the previous attempt was proven for `direct` and shipped
 * a symptom that only container projects see.
 */

const fakeClaude = path.join(SCRATCH, 'fake-claude.mjs');
fs.writeFileSync(fakeClaude, `
import * as readline from 'node:readline';
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.type === 'control_request') { say({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } }); return; }
  if (m.type === 'user') {
    say({ type: 'system', subtype: 'init', session_id: 'fake-' + process.pid, tools: [], mcp_servers: [] });
    say({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'hello' }] } });
    say({ type: 'result', subtype: 'success', total_cost_usd: 0 });
  }
});
`);

async function freePort() {
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

/** A real station server on a free port with a scratch data dir. */
async function withServer(extraEnv, fn) {
  const port = await freePort();
  const BASE = `http://127.0.0.1:${port}`;
  const DATA = path.join(SCRATCH, `data-${port}`);
  fs.mkdirSync(DATA, { recursive: true });
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/server/index.ts')], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, SBMCP_STATE_DIR: STATE, ...extraEnv },
  });
  const logs = [];
  srv.stdout.on('data', (d) => logs.push(String(d)));
  srv.stderr.on('data', (d) => logs.push(String(d)));
  try {
    let up = false;
    for (let i = 0; i < 160 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
    if (!up) throw new Error(`server never came up: ${logs.join('').slice(-600)}`);
    const api = async (p, method = 'GET', body) => {
      const r = await fetch(BASE + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    return await fn({ BASE, port, api, logs });
  } finally {
    // Kill only the process group we started here. Never any other station.
    try { process.kill(-srv.pid, 'SIGKILL'); } catch { try { srv.kill('SIGKILL'); } catch {} }
  }
}

/**
 * Speak MCP over a child's stdio, holding stdin open until every wanted id has
 * replied. Returns { byId, stderr }.
 */
function mcpOverStdio(cmd, args, input, wantIds, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const byId = new Map();
    let out = '';
    let errOut = '';
    const done = () => {
      clearTimeout(timer);
      try { child.stdin.end(); } catch {}
      try { child.kill('SIGKILL'); } catch {}
      resolve({ byId, stderr: errOut });
    };
    const timer = setTimeout(done, timeoutMs);
    child.stderr.on('data', (d) => { errOut += String(d); });
    child.stdout.on('data', (d) => {
      out += String(d);
      let i;
      while ((i = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, i); out = out.slice(i + 1);
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id != null) byId.set(m.id, m);
      }
      if (wantIds.every((id) => byId.has(id))) done();
    });
    child.on('error', () => done());
    child.stdin.write(input); // deliberately NOT closed
  });
}

async function runTurn(port, projectId, prompt = 'say hello') {
  const { default: WebSocket } = await import('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const ev = [];
  ws.on('message', (m) => { try { ev.push(JSON.parse(String(m))); } catch {} });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  ws.send(JSON.stringify({ type: 'start', projectId, prompt }));
  const t0 = Date.now();
  while (Date.now() - t0 < 300_000 && !ev.some((e) => e.t === 'turn-end' || (e.t === 'error' && e.fatal))) await sleep(250);
  return { ws, ev };
}

section('H. real station, real DIRECT session, browser enabled, one message');

await withServer({ CLAUDE_STATION_CLAUDE_BIN: fakeClaude, CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0' }, async ({ port, api }) => {
  const hostPath = path.join(SCRATCH, 'proj-direct');
  fs.mkdirSync(hostPath, { recursive: true });
  fs.writeFileSync(path.join(hostPath, 'README.md'), 'arch007\n');
  const created = await api('/api/projects', 'POST', { hostPath, name: 'A7Direct' });
  const id = created.body?.project?.id;
  if (!check('direct project created', !!id, JSON.stringify(created.body).slice(0, 160))) return;
  await api(`/api/projects/${id}`, 'PATCH', { browser: { enabled: true, idleMs: 600000 } });
  trackDaemon(STATE, id);

  const winBefore = chromeWindows();
  const { ws, ev } = await runTurn(port, id);
  await sleep(2500);
  const procs = chromePids(profileOf(STATE, id)).all;
  const statuses = ev.filter((e) => e.t === 'status').map((e) => String(e.status));
  check('the turn completed', ev.some((e) => e.t === 'turn-end'), JSON.stringify(ev.filter((e) => e.t === 'error').map((e) => String(e.message).slice(0, 120))).slice(0, 200));
  check('a browser-enabled DIRECT session that never uses the browser starts NO Chrome', procs.length === 0, `${procs.length} chrome processes`);
  check('...and opens no window', [...chromeWindows()].filter((w) => !winBefore.has(w)).length === 0);
  check('the session tells the user the browser is ARMED, not started', statuses.some((s) => /armed/i.test(s)), JSON.stringify(statuses.map((s) => s.slice(0, 70))).slice(0, 220));
  ws.close();
});

section('I. real station, real CONTAINER session — the shape the user actually reports');

{
  const dockerOk = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 20_000 }).status === 0;
  if (!check('docker is available for the container proof', dockerOk)) {
    console.log('  (container section SKIPPED — this is the reported shape, so a skip here means the ticket is NOT proven)');
  } else {
    let cname = null;
    try {
      await withServer({ CLAUDE_STATION_CLAUDE_BIN: fakeClaude, CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0' }, async ({ port, api }) => {
        const hostPath = path.join(SCRATCH, 'proj-container');
        fs.mkdirSync(hostPath, { recursive: true });
        fs.writeFileSync(path.join(hostPath, 'README.md'), 'arch007\n');
        const created = await api('/api/projects', 'POST', { hostPath, name: 'A7Cont', isolation: 'container' });
        const id = created.body?.project?.id;
        if (!check('container project created', !!id, JSON.stringify(created.body).slice(0, 200))) return;
        cname = `claude-station-${id}`;
        await api(`/api/projects/${id}`, 'PATCH', { browser: { enabled: true, idleMs: 600000 } });
        trackDaemon(STATE, id);

        const winBefore = chromeWindows();
        const { ws, ev } = await runTurn(port, id);
        await sleep(2500);
        const statuses = ev.filter((e) => e.t === 'status').map((e) => String(e.status));
        const fatal = ev.filter((e) => e.t === 'error' && e.fatal).map((e) => String(e.message).slice(0, 250));
        check('the container turn completed', ev.some((e) => e.t === 'turn-end'), fatal.join(' | ').slice(0, 300) || 'no fatal errors');

        const procs = chromePids(profileOf(STATE, id)).all;
        const newWins = [...chromeWindows()].filter((w) => !winBefore.has(w));
        check(
          'THE REPORTED SYMPTOM: a browser-enabled CONTAINER session starts NO Chrome process',
          procs.length === 0,
          `${procs.length} chrome processes`,
        );
        check(
          'THE USER\'S CRITERION: no browser window appears when a container session opens',
          newWins.length === 0,
          `${newWins.length} new window(s)`,
        );
        check('the socket the container mounts DOES exist (arming still did its structural job)', fs.existsSync(sockOf(STATE, id)));
        check('the session says armed, not "starting stealth browser"', statuses.some((s) => /armed/i.test(s)) && !statuses.some((s) => /starting stealth browser/i.test(s)), JSON.stringify(statuses.map((s) => s.slice(0, 70))).slice(0, 260));

        // Now the other half: make something ACTUALLY USE it, over the exact
        // container transport — the bind-mounted socket, the bind-mounted shim,
        // autostart forbidden. Driven from inside the running container.
        const running = spawnSync('docker', ['inspect', '-f', '{{.State.Status}}', cname], { encoding: 'utf8' }).stdout.trim();
        if (check('the container is running', running === 'running', running)) {
          const req = [
            JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'a7', version: '1' } } }),
            JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
            // 127.0.0.1 is correct even from inside the container: the container
            // only ships the URL string down the socket. The BROWSER is on the
            // host, so the host resolves it. That is the isolation design.
            JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: pageUrl } } }),
          ].join('\n') + '\n';
          // NB: stdin must stay OPEN. The shim exits on stdin end (correct — that
          // is how a closing CLI reaps it), so writing and closing in one shot
          // would kill it before the async tool call ever replied.
          const r = await mcpOverStdio('docker', [
            'exec', '-i',
            '-e', `SBMCP_SOCKET=${browser.CONTAINER_SOCKET}`,
            '-e', 'SBMCP_AUTOSTART=0',
            '-e', `SBMCP_PROJECT=${id}`,
            cname, 'node', browser.CONTAINER_MCP_STDIO,
          ], req, [1, 2, 3], 240_000);
          const byId = r.byId;
          check('the container can list browser tools over the mounted socket', (byId.get(2)?.result?.tools ?? []).length > 0, `${(byId.get(2)?.result?.tools ?? []).length} tools; stderr=${(r.stderr || '').slice(-200)}`);
          const call = byId.get(3);
          const text = JSON.stringify(call?.result ?? {});
          check(
            'AND IT WORKS: the first in-container browser call launches Chrome ON THE HOST and returns the rendered page',
            call?.result?.isError !== true && /lazy-browser-ok/.test(text),
            text.slice(0, 220).replace(/\n/g, ' ') + ` stderr=${(r.stderr || '').slice(-160)}`,
          );
          check('exactly one Chrome root process resulted', chromeRoots(profileOf(STATE, id)) === 1, `${chromeRoots(profileOf(STATE, id))}`);
        }
        ws.close();
      });
    } finally {
      if (cname) {
        spawnSync('docker', ['rm', '-f', cname], { encoding: 'utf8', timeout: 60_000 });
      }
    }
  }
}

/* --------------------------------------------------------------- teardown */

section('teardown');
for (const { state, p } of started) {
  try { cli(state, ['stop', p], 60_000); } catch {}
}
let stray = 0;
for (const { state, p } of started) stray += chromePids(profileOf(state, p)).all.length;
stray += chromePids(profileOf(path.join(SCRATCH, 'state-eager'), 'control')).all.length;
check('this run leaked no Chrome processes', stray === 0, `${stray} stray`);
pageServer.close();

console.log(`\nARCH-007: ${pass} passed, ${fail} failed`);
if (fail) { console.log(`failed: ${failures.join(', ')}`); process.exit(1); }
process.exit(0);
