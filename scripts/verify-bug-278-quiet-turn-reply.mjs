#!/usr/bin/env node
/**
 * BUG-278 — the final response after a subagent dispatch appears only after a
 * reload (phone, over the Tailscale `serve` proxy).
 *
 * THE USER'S REALITY, reproduced at the transport layer. A stateful proxy /NAT
 * (tailscale serve, a phone carrier) EVICTS AN IDLE FLOW: once a connection has
 * carried no bytes for a while, the box forgets it and silently black-holes it —
 * no FIN, no RST, so BOTH ends still believe the socket is open (a half-open
 * socket). That is exactly what happens during a QUIET SUBAGENT TURN: the driving
 * WebSocket carries nothing while the subagent works, the proxy evicts it, and
 * the final assistant message is then emitted to a sink nobody is reading. The
 * CLI wrote it to the transcript, so a RELOAD shows it — which is precisely the
 * reported symptom.
 *
 * This drives a REAL browser against a REAL server/bridge/runtime (the
 * schema-validated fake `codex app-server`, same seam as verify-running-snapshot),
 * through a REAL TCP proxy that black-holes an idle WebSocket flow the way a NAT
 * does. No station internals are mocked; the only synthetic piece is the engine
 * fixture, declared as such.
 *
 * TWO LEGS, so the proof survives the commit (never decoration):
 *   A — keepalive DISABLED (CLAUDE_STATION_WS_PING_MS=0): the pre-fix behaviour.
 *       The idle driving socket is evicted mid-quiet; the final reply never
 *       renders live; a reload brings it back from the transcript.
 *   B — keepalive ENABLED (short interval): the server's ping/pong keeps bytes
 *       flowing, so the proxy never evicts the flow and the final reply renders
 *       LIVE, no reload. A truly dead client (pong withheld) is still terminated,
 *       not kept attached forever.
 *
 *   node scripts/verify-bug-278-quiet-turn-reply.mjs [--leg=A|B|both]
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const FAKE = path.join(ROOT, 'scripts', 'fixtures', 'codex-fake-app-server.mjs');
const BRAVE = process.env.QA_BRAVE_PATH ?? '/usr/bin/brave';
const ARGV = process.argv.slice(2);
const LEG = (ARGV.find((a) => a.startsWith('--leg=')) ?? '--leg=both').split('=')[1];

// Timings: the quiet window must outlast the proxy's idle-eviction window, and
// (leg B) the keepalive ping must be well under the idle window so bytes flow.
const IDLE_MS = 3000;
const QUIET_MS = 7000;
const PING_MS = 1000;

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${line}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

const servers = new Set();
const proxies = new Set();
const tmpDirs = new Set();
function mkTmp(tag) { const d = fs.mkdtempSync(path.join(os.tmpdir(), `b278-${tag}-`)); tmpDirs.add(d); return d; }
function startServer(port, dataDir, env = {}) {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: dataDir, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (d) => { if (process.env.CS_VERBOSE) process.stderr.write(`  [srv] ${d}`); });
  servers.add(child);
  return child;
}
function stopByPid(pid) {
  if (!pid) return;
  try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }, 2500).unref();
}
async function waitHealth(port, ms = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return true; } catch { /* not up */ }
    await sleep(200);
  }
  return false;
}
async function registerProject(port, workDir, name, settings) {
  const reg = await (await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    // Force DIRECT isolation: this machine has the Docker sandbox available, so a
    // bare temp dir would otherwise resolve to a container we don't want here.
    body: JSON.stringify({ hostPath: workDir, name, isolation: 'direct' }),
  })).json();
  if (!reg.project?.id) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(reg.project.id)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings }),
  });
  return reg.project.id;
}

/*
 * The faithful NAT/firewall: a TCP proxy that forwards everything, but after a
 * WebSocket flow has been idle for IDLE_MS it BLACK-HOLES that one flow — drops
 * all bytes both ways while keeping BOTH sockets open, so neither end sees a
 * close. HTTP (short, non-Upgrade) flows are never black-holed, so page loads
 * and transcript reads keep working, exactly as they do for a real phone whose
 * firewall only evicts the long-lived idle socket. `onEvict` counts evictions.
 */
function startProxy(listenPort, upstreamPort, idleMs, onEvict) {
  const srv = net.createServer((client) => {
    const up = net.connect(upstreamPort, '127.0.0.1');
    let isWs = false, decided = false, blackholed = false, timer = null;
    const bump = () => {
      if (!isWs || blackholed) return;
      clearTimeout(timer);
      timer = setTimeout(() => { blackholed = true; onEvict?.(); }, idleMs);
    };
    const end = () => { clearTimeout(timer); try { client.destroy(); } catch { /* */ } try { up.destroy(); } catch { /* */ } };
    client.on('data', (d) => {
      if (!decided) { decided = true; if (/upgrade:\s*websocket/i.test(d.toString('latin1'))) { isWs = true; bump(); } }
      bump();
      if (!blackholed) up.write(d);
    });
    up.on('data', (d) => { bump(); if (!blackholed) client.write(d); });
    for (const s of [client, up]) { s.on('error', end); s.on('close', end); }
  });
  srv.listen(listenPort, '127.0.0.1');
  proxies.add(srv);
  return srv;
}

/*
 * A CONTROLLABLE NAT/proxy for the round-2 recovery legs. It forwards everything,
 * counts transcript reads (GET /api/transcript…) and WebSocket opens by sniffing
 * the first bytes of each flow, and can be told to:
 *   cutWs()  — abruptly destroy every currently-open WS flow (a transient drop,
 *              the shape a NAT leaves when it forgets a flow);
 *   down()   — refuse NEW upstream connections AND cut live WS, so the server is
 *              unreachable (both HTTP fetches and WS opens fail) while the page
 *              that is already loaded stays on screen;
 *   up()     — resume forwarding.
 * The transcript-fetch counter is the faithful measure of recovery activity: the
 * recovery probe and openSession's tail both hit /api/transcript, while the
 * page-lifetime watch socket (its own backoff) never reads a transcript.
 */
function startCtlProxy(listenPort, upstreamPort) {
  const ctl = { wsOpens: 0, txFetches: 0, isDown: false, pairs: new Set() };
  const srv = net.createServer((client) => {
    if (ctl.isDown) { try { client.destroy(); } catch { /* */ } return; }
    const up = net.connect(upstreamPort, '127.0.0.1');
    const pair = { client, up, isWs: false };
    ctl.pairs.add(pair);
    let sawUpgrade = false;
    const end = () => { ctl.pairs.delete(pair); try { client.destroy(); } catch { /* */ } try { up.destroy(); } catch { /* */ } };
    client.on('data', (d) => {
      // Count on EVERY chunk, not just the first: HTTP keep-alive carries many
      // requests over one TCP connection, so a per-connection "first chunk" sniff
      // under-counts transcript reads badly (it read 0 on the round-1 storm).
      const head = d.toString('latin1');
      if (!sawUpgrade && /upgrade:\s*websocket/i.test(head)) { sawUpgrade = true; pair.isWs = true; ctl.wsOpens++; }
      const m = head.match(/GET \/api\/transcript\//g);
      if (m) ctl.txFetches += m.length;
      try { up.write(d); } catch { /* */ }
    });
    up.on('data', (d) => { try { client.write(d); } catch { /* */ } });
    for (const s of [client, up]) { s.on('error', end); s.on('close', end); }
  });
  srv.listen(listenPort, '127.0.0.1');
  proxies.add(srv);
  ctl.cutWs = () => { for (const p of [...ctl.pairs]) { if (p.isWs) { try { p.client.destroy(); } catch { /* */ } try { p.up.destroy(); } catch { /* */ } ctl.pairs.delete(p); } } };
  ctl.down = () => { ctl.isDown = true; for (const p of [...ctl.pairs]) { try { p.client.destroy(); } catch { /* */ } try { p.up.destroy(); } catch { /* */ } ctl.pairs.delete(p); } };
  ctl.up = () => { ctl.isDown = false; };
  ctl.close = () => { try { srv.close(); } catch { /* */ } };
  return ctl;
}

// Does the view still show the session, or did a recovery wipe it to the
// "could not read this session" error pane? (The round-1 B1 break.)
const VIEW_STATE = (token) => `(() => {
  const panes = document.querySelector('#panes');
  const text = panes ? panes.textContent : '';
  return {
    hasToken: text.includes(${JSON.stringify(token)}),
    hasFinal: text.includes('FINAL::' + ${JSON.stringify(token)}),
    hasStale: text.includes('STALE SNAPSHOT'),
    couldNotRead: text.includes('could not read this session'),
    dropped: window.__station?.state?.dropped ?? null,
    live: window.__station?.state?.live ?? null,
    reconnecting: window.__station?.state?.sessReconnecting ?? null,
    ctl: window.__station?.reconnectInfo?.() ?? null,
  };
})()`;

// The reply bubble carries `FINAL::<token>`; the prompt echo carries only
// <token>. Searching for the FINAL:: form tells the reply apart from the prompt.
const READ_REPLY = (token) => `(() => {
  const panes = document.querySelector('#panes');
  const text = panes ? panes.textContent : '';
  return {
    hasReply: text.includes('FINAL::' + ${JSON.stringify(token)}),
    busy: window.__station?.state?.busy ?? null,
    dropped: window.__station?.state?.dropped ?? null,
    live: window.__station?.state?.live ?? null,
  };
})()`;

async function pollReply(page, token, ms) {
  const t0 = Date.now();
  let r = null;
  while (Date.now() - t0 < ms) {
    // READ_REPLY is a string expression with the token already baked in — pass
    // NO arg (Playwright rejects a string expression with arguments).
    try { r = await page.evaluate(READ_REPLY(token)); } catch { /* nav */ }
    if (r && r.hasReply) return { ok: true, r };
    await sleep(300);
  }
  return { ok: false, r };
}

async function oneLeg(leg, browser) {
  const keepalive = leg === 'B';
  const token = `QUIET-REPLY-${leg}-${Date.now().toString(36)}`;
  console.log(`\n========== LEG ${leg} — keepalive ${keepalive ? `ON (${PING_MS}ms)` : 'OFF'} ==========`);
  const serverPort = await freePort();
  const proxyPort = await freePort();
  const DATA = mkTmp('data');
  const WORK = mkTmp('work');
  let evictions = 0;
  const proxy = startProxy(proxyPort, serverPort, IDLE_MS, () => { evictions++; });

  const srv = startServer(serverPort, DATA, {
    CLAUDE_STATION_CODEX_BIN: FAKE,
    CLAUDE_STATION_SURVIVE: '0',
    CLAUDE_STATION_WS_PING_MS: keepalive ? String(PING_MS) : '0',
    CLAUDE_STATION_ALLOWED_ORIGINS: `http://127.0.0.1:${proxyPort}`,
    CLAUDE_STATION_ALLOWED_HOSTS: `127.0.0.1:${proxyPort}`,
  });
  if (!(await waitHealth(serverPort))) throw new Error('scratch server never became healthy');
  const projectId = await registerProject(serverPort, WORK, `b278-${leg}`, { provider: 'openai', model: null, permissionMode: 'bypassPermissions' });

  const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
  // The browser talks ONLY to the proxy — every socket it opens is evictable.
  await page.goto(`http://127.0.0.1:${proxyPort}/#/project/${encodeURIComponent(projectId)}`);
  await page.waitForFunction(() => window.__station && document.querySelector('#prompt'), undefined, { timeout: 30000 });

  // The reported turn: dispatch a subagent, stay quiet past the proxy's idle
  // window, then land the final reply.
  await page.fill('#prompt', `QUIET_THEN_REPLY:${token};QUIET:${QUIET_MS} — dispatch a worker then reply`);
  await page.focus('#prompt');
  await page.keyboard.press('Enter');

  // The turn is real and running (the subagent dispatched): we are now in the
  // quiet window the proxy will evict.
  await page.waitForFunction(
    () => !!(window.__station.state.stationSessionId || window.__station.state.sdkSessionId),
    undefined, { timeout: 45000 },
  ).catch(() => {});
  const id = await page.evaluate(() => window.__station.state.stationSessionId || window.__station.state.sdkSessionId);
  check(`leg ${leg} PRECONDITION: a real quiet subagent turn is running`, !!id, { id });

  // Wait out the idle window + the quiet window + slack, watching for the reply.
  const got = await pollReply(page, token, IDLE_MS + QUIET_MS + 12000);
  check(`leg ${leg}: the proxy ${keepalive ? 'did NOT evict (keepalive kept the flow alive)' : 'evicted the idle driving socket'}`,
    keepalive ? evictions === 0 : evictions >= 1, { evictions });

  if (keepalive) {
    check('leg B (FIXED): the final reply renders LIVE after the quiet subagent turn, no reload',
      got.ok, { hasReply: got.r?.hasReply, busy: got.r?.busy, dropped: got.r?.dropped, evictions });
  } else {
    check('leg A (PRE-FIX): the final reply does NOT render live — it was lost to the half-open sink',
      !got.ok, { hasReply: got.r?.hasReply, busy: got.r?.busy, dropped: got.r?.dropped, evictions });
    // ...but it IS on disk, which is why a reload brings it back ("appears only
    // after reload"). Proven environment-independently by reading the transcript
    // straight from the server (not through the black-holed proxy): the reply was
    // produced and persisted — the loss is purely transport.
    const cur = await page.evaluate(() => ({ sessionId: window.__station.state.current.sessionId, encodedDir: window.__station.state.current.encodedDir }));
    const txRes = await fetch(`http://127.0.0.1:${serverPort}/api/transcript/${encodeURIComponent(cur.encodedDir)}/${encodeURIComponent(cur.sessionId)}?tail=50`);
    const tx = await txRes.json().catch(() => ({}));
    const onDisk = JSON.stringify(tx).includes(`FINAL::${token}`);
    check('leg A (PRE-FIX): the SAME reply IS in the persisted transcript (a reload would show it) — a transport loss, not a lost reply',
      onDisk, { onDisk, cur, status: txRes.status, snippet: JSON.stringify(tx).slice(0, 200) });
  }

  await page.close();
  stopByPid(srv.pid);
  try { proxy.close(); } catch { /* */ }
  await sleep(1500); // let the server/engine children fully exit before the next leg
}

/*
 * The attack item: the keepalive must TERMINATE a truly-dead (silent) client, and
 * must NOT kill a healthy one. Driven at the WS layer with keepalive ON: one raw
 * socket SUPPRESSES its automatic pong (a frozen/gone tab whose socket lingers),
 * a second answers pongs normally. Within a couple of ping cycles the silent one
 * is terminated (its close fires) and the healthy one stays open. (Termination
 * routes through ws.on('close') → releaseSocketSession, whose detach-keeps-the-work
 * behaviour is already covered by BUG-043/BUG-018.)
 */
async function deadClientLeg() {
  console.log(`\n========== LEG B2 — a silent client is terminated; a healthy one is not ==========`);
  const WebSocket = (await import('ws')).default;
  const serverPort = await freePort();
  const DATA = mkTmp('data');
  const srv = startServer(serverPort, DATA, { CLAUDE_STATION_SURVIVE: '0', CLAUDE_STATION_WS_PING_MS: String(PING_MS) });
  if (!(await waitHealth(serverPort))) throw new Error('scratch server never became healthy');

  const open = async (silent) => {
    const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/ws`);
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    // The `ws` library auto-pongs by calling `ws.pong(...)` from its ping handler;
    // overriding it to a no-op makes a genuinely silent (never-ponging) client.
    if (silent) ws.pong = () => { /* dead: never answer a ping */ };
    const st = { closed: false };
    ws.on('close', () => { st.closed = true; });
    return { ws, st };
  };
  const dead = await open(true);
  const healthy = await open(false);

  // Wait out several ping cycles: the server pings each cycle, flips isAlive=false,
  // and terminates whoever did not pong by the next cycle.
  const t0 = Date.now();
  while (Date.now() - t0 < PING_MS * 5 + 2000 && !dead.st.closed) await sleep(150);
  check('leg B2: the SILENT (never-ponging) client is terminated by the keepalive — not attached forever',
    dead.st.closed, { closedAfterMs: Date.now() - t0 });
  check('leg B2: a HEALTHY (auto-ponging) client over the same window is left alone',
    !healthy.st.closed, { healthyClosed: healthy.st.closed });

  try { dead.ws.terminate(); } catch { /* */ }
  try { healthy.ws.terminate(); } catch { /* */ }
  stopByPid(srv.pid);
}

/*
 * CLIENT RECOVERY (the charter's "driving client reconnects on close and catches
 * up from the transcript without a reload"). A CLEAN close of just the driving
 * socket mid-quiet — the shape left when the server terminates a client its
 * keepalive found dead, or a real transient drop — must recover IN PLACE: the
 * reply that lands afterward renders without a page reload. No proxy; keepalive
 * on, so the page-lifetime watch socket stays alive to carry the catch-up.
 */
async function clientRecoveryLeg(browser) {
  console.log(`\n========== LEG C — clean driving-socket drop recovers in place (no reload) ==========`);
  const token = `CLEANDROP-${Date.now().toString(36)}`;
  const serverPort = await freePort();
  const DATA = mkTmp('data');
  const WORK = mkTmp('work');
  const srv = startServer(serverPort, DATA, { CLAUDE_STATION_CODEX_BIN: FAKE, CLAUDE_STATION_SURVIVE: '0', CLAUDE_STATION_WS_PING_MS: String(PING_MS) });
  if (!(await waitHealth(serverPort))) throw new Error('scratch server never became healthy');
  const projectId = await registerProject(serverPort, WORK, 'b278-C', { provider: 'openai', model: null, permissionMode: 'bypassPermissions' });

  const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
  await page.goto(`http://127.0.0.1:${serverPort}/#/project/${encodeURIComponent(projectId)}`);
  await page.waitForFunction(() => window.__station && document.querySelector('#prompt'), undefined, { timeout: 30000 });

  await page.fill('#prompt', `QUIET_THEN_REPLY:${token};QUIET:6000 — dispatch a worker then reply`);
  await page.focus('#prompt');
  await page.keyboard.press('Enter');
  // The turn is running and quiet; the driving socket is attached.
  await page.waitForFunction(() => window.__station.state.live && !!window.__station.state.sdkSessionId, undefined, { timeout: 30000 }).catch(() => {});
  check('leg C PRECONDITION: the driving socket is attached to a live quiet turn',
    await page.evaluate(() => window.__station.state.live === true && !!window.__station.state.sdkSessionId), {});

  // Marker that a REAL page reload would wipe — recovery must NOT reload.
  await page.evaluate(() => { window.__noReload278 = 'kept'; });
  // A clean close of ONLY the driving socket (a transient drop), mid-quiet.
  await page.evaluate(() => { try { window.__station.state.ws.close(); } catch { /* */ } });

  const got = await pollReply(page, token, 20000);
  const kept = await page.evaluate(() => window.__noReload278 ?? null);
  check('leg C: the reply renders after the clean drop WITHOUT a reload (recovered in place)',
    got.ok && kept === 'kept', { hasReply: got.r?.hasReply, kept, dropped: got.r?.dropped });

  await page.close();
  stopByPid(srv.pid);
}

/*
 * Shared setup for the round-2 recovery legs: a scratch server behind a
 * CONTROLLABLE proxy, keepalive ON, a project registered, a page loaded through
 * the proxy, and a quiet subagent turn started. Returns the handles the leg needs.
 */
async function recoveryHarness(browser, tag, token, quietMs, viewport = { width: 1180, height: 900 }) {
  const serverPort = await freePort();
  const proxyPort = await freePort();
  const DATA = mkTmp('data');
  const WORK = mkTmp('work');
  const ctl = startCtlProxy(proxyPort, serverPort);
  const srv = startServer(serverPort, DATA, {
    CLAUDE_STATION_CODEX_BIN: FAKE,
    // SURVIVE=1: a dropped driving client DETACHES the bridge and keeps the turn
    // running headless (the server keepalive's behaviour, BUG-278 index.ts). This
    // is what makes recovery reattach a still-live session — and what makes a
    // flapping link reconnect-and-storm on the round-1 code.
    CLAUDE_STATION_SURVIVE: '1',
    CLAUDE_STATION_WS_PING_MS: String(PING_MS),
    CLAUDE_STATION_ALLOWED_ORIGINS: `http://127.0.0.1:${proxyPort}`,
    CLAUDE_STATION_ALLOWED_HOSTS: `127.0.0.1:${proxyPort}`,
  });
  if (!(await waitHealth(serverPort))) throw new Error('scratch server never became healthy');
  const projectId = await registerProject(serverPort, WORK, `b278-${tag}`, { provider: 'openai', model: null, permissionMode: 'bypassPermissions' });
  const page = await browser.newPage({ viewport });
  await page.goto(`http://127.0.0.1:${proxyPort}/#/project/${encodeURIComponent(projectId)}`);
  await page.waitForFunction(() => window.__station && document.querySelector('#prompt'), undefined, { timeout: 30000 });
  await page.fill('#prompt', `QUIET_THEN_REPLY:${token};QUIET:${quietMs} — dispatch a worker then reply`);
  await page.focus('#prompt');
  await page.keyboard.press('Enter');
  // The bundled-runtime check can cold-start slowly; wait generously for a real
  // live driving socket, and FAIL LOUDLY if it never arrives (a null-session run
  // would silently no-op the drop and prove nothing).
  const live = await page.waitForFunction(
    () => window.__station.state.live && !!window.__station.state.sdkSessionId,
    undefined, { timeout: 60000 },
  ).then(() => true).catch(() => false);
  check(`harness: a live driving turn was established`, live, { live });
  return { serverPort, proxyPort, ctl, srv, page, projectId };
}

/*
 * ATTACK 1 + the B1 MUST-FAIL. The server goes UNREACHABLE while a live turn's
 * socket is dropped (a phone that lost signal mid-turn). The view must stay
 * INTACT — round 1 called openSession immediately, which wiped the pane to "could
 * not read this session" and stayed stuck. When the server returns, recovery must
 * re-render the reply WITHOUT a reload, and it must not spin while down.
 */
async function serverDownLeg(browser) {
  console.log(`\n========== LEG D — server unreachable during recovery: view intact, auto-recovers, no spin (B1 must-FAIL) ==========`);
  const token = `SRVDOWN-${Date.now().toString(36)}`;
  const h = await recoveryHarness(browser, 'D', token, 16000);
  // The prompt bubble is rendered immediately; it is the "view intact" witness.
  await page_waitToken(h.page, token, 10000);
  await h.page.evaluate(() => { window.__noReload278 = 'kept'; });

  // Signal lost mid-quiet: cut the socket AND refuse new connections.
  h.ctl.down();
  await sleep(5000); // stay down across several would-be retries
  const during = await h.page.evaluate(VIEW_STATE(token));
  const txDuring = h.ctl.txFetches;
  check('leg D: with the server down, the conversation stays ON SCREEN (round 1 wiped it to "could not read")',
    during.hasToken && !during.couldNotRead && (during.dropped || during.reconnecting), during);
  check('leg D: no spin while down — the probe backs off (a handful of transcript reads over 5s, not a storm)',
    txDuring < 10, { txFetchesWhileDown: txDuring });

  // Signal back: recovery must swap in the canonical transcript and the quiet
  // reply (which lands at ~16s) must render live, no reload.
  h.ctl.up();
  const got = await pollReply(h.page, token, 30000);
  const kept = await h.page.evaluate(() => window.__noReload278 ?? null);
  check('leg D (FIXED): when the server returns, the reply renders WITHOUT a reload (view was never wiped)',
    got.ok && kept === 'kept', { hasReply: got.r?.hasReply, kept, couldNotRead: (await h.page.evaluate(VIEW_STATE(token))).couldNotRead });

  await h.page.close();
  stopByPid(h.srv.pid);
  h.ctl.close();
  await sleep(1200);
}

/*
 * ATTACK 2 + the B2 MUST-FAIL. A flapping link drops the driving socket every 2s
 * for 60s. Round 1 started an independent recovery per socket (22 fetches / 11 WS
 * in 20s — a storm). The single controller must bound the attempt rate by its
 * backoff. We report the real counts.
 */
async function flappingLeg(browser) {
  console.log(`\n========== LEG E — flapping link (drop every 2s for 60s): attempts bounded by backoff (B2 must-FAIL) ==========`);
  const token = `FLAP-${Date.now().toString(36)}`;
  const FLAP_MS = Number(process.env.B278_FLAP_MS ?? 60000), PERIOD = 2000;
  // The quiet reply lands a few seconds AFTER the flap ends, so "did it recover?"
  // is a real question the fix must answer by re-following/reattaching.
  const h = await recoveryHarness(browser, 'E', token, FLAP_MS + 6000);
  await page_waitToken(h.page, token, 10000);
  // Count only the flap window.
  h.ctl.txFetches = 0; h.ctl.wsOpens = 0;
  const t0 = Date.now();
  const delays = [];
  while (Date.now() - t0 < FLAP_MS) {
    // A CLEAN driving-socket drop (the shape a reconnect succeeds from: the server
    // detaches and keeps the live bridge, so recovery reattaches — and on round 1,
    // each reopen was a new socket whose next drop started a fresh independent
    // recovery). One controller must own them all and space them by its backoff.
    await h.page.evaluate(() => { try { window.__station.state.ws && window.__station.state.ws.close(); } catch { /* */ } });
    const info = await h.page.evaluate(() => window.__station?.reconnectInfo?.() ?? null);
    if (info?.delay) delays.push(info.delay);
    if (process.env.CS_PROXY_DEBUG) console.log(`    [flap t+${Date.now() - t0}ms] drop; tx=${h.ctl.txFetches} ws=${h.ctl.wsOpens} ctl=${JSON.stringify(info)}`);
    await sleep(PERIOD);
  }
  const txFlap = h.ctl.txFetches, wsFlap = h.ctl.wsOpens, maxDelay = Math.max(0, ...delays);
  // The watch socket's own reconnect also reopens WS, so wsOpens is an upper
  // bound that includes it; transcript reads isolate the recovery controller.
  check('leg E (FIXED): the flap is bounded by backoff — far below a storm (round 1: 22 fetches / 11 WS in 20s ⇒ ~66 fetches in 60s)',
    txFlap < 25, { transcriptFetches: txFlap, wsOpens_incl_watch: wsFlap, flap_ms: FLAP_MS, period_ms: PERIOD });
  check('leg E (FIXED): the single controller backed OFF under the flap (delay grew toward the 30s cap — not reset each drop)',
    maxDelay >= 8000, { maxObservedDelayMs: maxDelay });
  // Let it settle and confirm it is still a working, SINGLE-owner session that
  // actually RECOVERS the reply (not a pile of racing timers and not left stuck).
  h.ctl.up?.();
  const got = await pollReply(h.page, token, 45000);
  const after = await h.page.evaluate(VIEW_STATE(token));
  check('leg E (FIXED): after the flap the session RECOVERS — the reply renders, no reload',
    got.ok, { hasFinal: after.hasFinal, couldNotRead: after.couldNotRead });
  check('leg E: exactly one controller (or none) owns recovery — not a pile of racing timers',
    after.ctl === null || !!after.ctl.sessionId, { ctl: after.ctl });
  await h.page.close();
  stopByPid(h.srv.pid);
  h.ctl.close();
  await sleep(1200);
}

/*
 * ATTACK: the session ENDS while recovering. The turn completes (server-side)
 * during the down window; when the link returns, recovery must show the final
 * transcript, not spin, and not error.
 */
async function endWhileRecoveringLeg(browser) {
  console.log(`\n========== LEG G — the session ends while recovering: final transcript shown, no spin, no error ==========`);
  const token = `ENDREC-${Date.now().toString(36)}`;
  const h = await recoveryHarness(browser, 'G', token, 4000); // reply lands at ~4s
  await page_waitToken(h.page, token, 10000);
  // Drop + go down IMMEDIATELY so the turn completes (at ~4s) while we are down.
  h.ctl.down();
  await sleep(7000); // the turn has ended server-side by now
  const during = await h.page.evaluate(VIEW_STATE(token));
  check('leg G: view intact while the (now-ended) session is unreachable',
    during.hasToken && !during.couldNotRead, during);
  h.ctl.up();
  const got = await pollReply(h.page, token, 25000);
  await sleep(3000);
  const txSettled = h.ctl.txFetches;
  const settled = await h.page.evaluate(VIEW_STATE(token));
  check('leg G: the ended session renders its final reply after the link returns, no reload',
    got.ok, { hasFinal: settled.hasFinal, couldNotRead: settled.couldNotRead });
  // After it has settled on an idle/ended session, the controller must stop — a
  // second sample a moment later shows no further transcript reads piling up.
  await sleep(3000);
  check('leg G: no spin on the ended session — transcript reads stop once recovered',
    h.ctl.txFetches - txSettled <= 1, { deltaAfterSettle: h.ctl.txFetches - txSettled });
  await h.page.close();
  stopByPid(h.srv.pid);
  h.ctl.close();
  await sleep(1200);
}

/*
 * ATTACK: the user navigates to ANOTHER session mid-recovery. The controller must
 * cancel — no stale render of the dropped session into the newly-opened one.
 * (Clean drop, proxy never down, so the second session loads normally.)
 */
async function navMidRecoveryLeg(browser) {
  console.log(`\n========== LEG F — user navigates away mid-recovery: controller cancels, no stale render ==========`);
  const serverPort = await freePort();
  const DATA = mkTmp('data');
  const WORK = mkTmp('work');
  const srv = startServer(serverPort, DATA, { CLAUDE_STATION_CODEX_BIN: FAKE, CLAUDE_STATION_SURVIVE: '1', CLAUDE_STATION_WS_PING_MS: String(PING_MS) });
  if (!(await waitHealth(serverPort))) throw new Error('scratch server never became healthy');
  const projectId = await registerProject(serverPort, WORK, 'b278-F', { provider: 'openai', model: null, permissionMode: 'bypassPermissions' });
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
  await page.goto(`http://127.0.0.1:${serverPort}/#/project/${encodeURIComponent(projectId)}`);
  await page.waitForFunction(() => window.__station && document.querySelector('#prompt'), undefined, { timeout: 30000 });

  // A long, live quiet turn.
  const s1 = `NAV-S1-${Date.now().toString(36)}`;
  await page.fill('#prompt', `QUIET_THEN_REPLY:${s1};QUIET:12000 — the dropped session`);
  await page.keyboard.press('Enter');
  const live = await page.waitForFunction(() => window.__station.state.live && !!window.__station.state.sdkSessionId, undefined, { timeout: 60000 }).then(() => true).catch(() => false);
  check('leg F PRECONDITION: a live quiet turn is on screen', live && (await page_waitToken(page, s1, 10000)), { live });
  const s1Id = await page.evaluate(() => window.__station.state.current.sessionId);

  // Drop the socket (recovery scheduled), then IMMEDIATELY navigate away to the
  // new-session compose view (startNew nulls current.sessionId and clears the
  // pane). The scheduled recovery attempt must see the session-id change and
  // cancel, rendering nothing of the dropped session into the new view.
  await page.evaluate(() => { try { window.__station.state.ws.close(); } catch { /* */ } });
  await page.evaluate((pid) => window.__station.startNew(pid), projectId);
  await sleep(3000); // let the recovery timer fire and bail on the guard

  const view = await page.evaluate(VIEW_STATE(s1));
  const movedAway = await page.evaluate((id) => window.__station.state.current.sessionId !== id, s1Id);
  check('leg F: navigating away cancelled recovery — the dropped session did NOT re-render into the new view',
    movedAway && !view.hasToken, { movedAway, currentSessionId: await page.evaluate(() => window.__station.state.current.sessionId), s1Visible: view.hasToken });
  check('leg F: the recovery controller no longer owns the departed session',
    view.ctl === null || view.ctl.sessionId !== s1Id, { ctl: view.ctl, s1Id });

  await page.close();
  stopByPid(srv.pid);
  await sleep(1000);
}

/*
 * ATTACK: a drop with an APPROVAL CARD pending. Recovery must re-render in place
 * (no wipe); the approval surface comes back from the canonical transcript rather
 * than vanishing behind a "could not read" pane. (Anti-regression: round 1 passed
 * this on a clean drop; the fetch-first change must not regress it.)
 */
async function approvalDropLeg(browser) {
  console.log(`\n========== LEG H — drop with an approval card pending: recovers in place, no wipe ==========`);
  const serverPort = await freePort();
  const DATA = mkTmp('data');
  const WORK = mkTmp('work');
  const srv = startServer(serverPort, DATA, { CLAUDE_STATION_CODEX_BIN: FAKE, CLAUDE_STATION_SURVIVE: '0', CLAUDE_STATION_WS_PING_MS: String(PING_MS) });
  if (!(await waitHealth(serverPort))) throw new Error('scratch server never became healthy');
  const projectId = await registerProject(serverPort, WORK, 'b278-H', { provider: 'openai', model: null, permissionMode: 'default' });
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
  await page.goto(`http://127.0.0.1:${serverPort}/#/project/${encodeURIComponent(projectId)}`);
  await page.waitForFunction(() => window.__station && document.querySelector('#prompt'), undefined, { timeout: 30000 });

  const tok = `APPROVAL-${Date.now().toString(36)}`;
  // EXEC_APPROVAL opens a server→client approval request that waits for a decision.
  await page.fill('#prompt', `${tok} EXEC_APPROVAL — run a command needing approval`);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__station.state.live && !!window.__station.state.sdkSessionId, undefined, { timeout: 30000 }).catch(() => {});
  // Wait for the approval card to appear (the pending decision surface).
  const cardShown = await page.waitForFunction(
    () => /approve|approval|allow|run this command|needs your/i.test(document.querySelector('#panes')?.textContent ?? ''),
    undefined, { timeout: 20000 },
  ).then(() => true).catch(() => false);
  check('leg H PRECONDITION: an approval card is pending on screen', cardShown, { cardShown });

  await page.evaluate(() => { window.__noReload278 = 'kept'; });
  await page.evaluate(() => { try { window.__station.state.ws.close(); } catch { /* */ } });
  await sleep(4000);
  const kept = await page.evaluate(() => window.__noReload278 ?? null);
  const v = await page.evaluate(VIEW_STATE(tok));
  check('leg H: the drop recovered in place — no "could not read" wipe, session still on screen, no reload',
    !v.couldNotRead && v.hasToken && kept === 'kept', { couldNotRead: v.couldNotRead, hasToken: v.hasToken, kept });

  await page.close();
  stopByPid(srv.pid);
  await sleep(1000);
}

/*
 * ATTACK: a BACKGROUND (hidden) tab. The recovery controller must not depend on
 * visibility — a hidden tab still recovers when the link returns and still does
 * not spin while down. We force document.visibilityState=hidden for the whole
 * recovery cycle.
 */
async function hiddenTabLeg(browser) {
  console.log(`\n========== LEG I — hidden/background tab: recovers when visible-independent, no spin ==========`);
  const token = `HIDDEN-${Date.now().toString(36)}`;
  const h = await recoveryHarness(browser, 'I', token, 14000);
  await page_waitToken(h.page, token, 10000);
  await h.page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.__noReload278 = 'kept';
  });
  h.ctl.down();
  await sleep(4000);
  const during = await h.page.evaluate(VIEW_STATE(token));
  const txDuring = h.ctl.txFetches;
  check('leg I: a hidden tab keeps the view and does not spin while down',
    during.hasToken && !during.couldNotRead && txDuring < 10, { hasToken: during.hasToken, txFetchesWhileDown: txDuring });
  h.ctl.up();
  const got = await pollReply(h.page, token, 30000);
  const kept = await h.page.evaluate(() => window.__noReload278 ?? null);
  check('leg I: the hidden tab recovers and renders the reply when the link returns, no reload',
    got.ok && kept === 'kept', { hasReply: got.r?.hasReply, kept });
  await h.page.close();
  stopByPid(h.srv.pid);
  h.ctl.close();
  await sleep(1200);
}

/*
 * ATTACK: a second tab must still be refused (BUG-149). The guarantee my change
 * rests on is that recovery starts NO model turn — openSession re-renders and
 * re-follows, it never calls startTurn. If recovery never starts a turn, it can
 * never create a second driver, so the one-driver resume-on-next-send path
 * (which refuses a second tab) is untouched. We wrap startTurn and prove it is
 * not called across a full drop→down→up recovery cycle.
 */
async function noTurnOnRecoveryLeg(browser) {
  console.log(`\n========== LEG J — recovery starts NO model turn (the BUG-149 one-driver invariant is untouched) ==========`);
  const token = `NOTURN-${Date.now().toString(36)}`;
  const h = await recoveryHarness(browser, 'J', token, 16000);
  await page_waitToken(h.page, token, 10000);
  await h.page.evaluate(() => {
    window.__turnCalls = 0;
    const o = window.__station.startTurn;
    window.__station.startTurn = (...a) => { window.__turnCalls++; return o(...a); };
  });
  h.ctl.down();
  await sleep(4000);
  h.ctl.up();
  const got = await pollReply(h.page, token, 30000);
  const turnCalls = await h.page.evaluate(() => window.__turnCalls);
  check('leg J: recovery started NO model turn across the drop/recover cycle (no second driver can arise)',
    turnCalls === 0, { startTurnCalls: turnCalls });
  check('leg J: and the session still recovered its reply without a turn being invented',
    got.ok, { hasReply: got.r?.hasReply });
  await h.page.close();
  stopByPid(h.srv.pid);
  h.ctl.close();
  await sleep(1200);
}

/*
 * LEG K — THE MERGE CONTRACT (design B′). A dropped driving socket is recovered by
 * MERGING the gap from the store by index (dropLiveTail + catchUpFollow), NOT by
 * re-opening the session. The invariants the merge must hold, straight from the
 * attack list: missed messages appear EXACTLY ONCE and IN ORDER, and the user's own
 * just-sent message is NOT duplicated (the optimistic indexless bubble is reconciled
 * away before the store-indexed copy is appended). A fresh session's whole turn is
 * drawn indexless from #0, so this is also the proof that dropLiveTail lets the merge
 * read the store from #0 instead of falling back to the reload control.
 */
async function mergeDedupLeg(browser) {
  console.log(`\n========== LEG K — merge recovery: missed messages appear once, in order; the user's own message is not duplicated ==========`);
  const token = `MERGE-${Date.now().toString(36)}`;
  const h = await recoveryHarness(browser, 'K', token, 6000);
  await page_waitToken(h.page, token, 10000);
  // Clean drop (server stays up). Recovery merges the gap from the store.
  await h.page.evaluate(() => { try { window.__station.state.ws.close(); } catch { /* */ } });
  const got = await pollReply(h.page, token, 30000);
  await sleep(2500); // let any late duplicate land if the dedup is broken
  const counts = await h.page.evaluate((t) => {
    const panes = document.querySelector('#panes');
    const main = panes.querySelector('.pane.on, .pane') ?? panes;
    const yous = [...main.querySelectorAll('.you')].filter((n) => n.textContent.includes(t) && !n.textContent.includes('FINAL::'));
    const replyMatches = (main.textContent.match(new RegExp('FINAL::' + t.replace(/[-]/g, '\\$&'), 'g')) || []).length;
    // Order: the user bubble must come BEFORE the first reply occurrence in DOM order.
    const all = [...main.querySelectorAll('*')];
    const youIdx = all.findIndex((n) => n.matches('.you') && n.textContent.includes(t) && !n.textContent.includes('FINAL::'));
    const replyIdx = all.findIndex((n) => n.textContent.includes('FINAL::' + t));
    return { youCount: yous.length, replyCount: replyMatches, inOrder: youIdx >= 0 && replyIdx >= 0 && youIdx < replyIdx, couldNotRead: panes.textContent.includes('could not read this session') };
  }, token);
  check('leg K: the recovered reply rendered without a reload', got.ok && !counts.couldNotRead, { hasReply: got.r?.hasReply, couldNotRead: counts.couldNotRead });
  check('leg K: the user\'s own message appears EXACTLY ONCE after the merge (no duplicate optimistic bubble)',
    counts.youCount === 1, { youCount: counts.youCount });
  check('leg K: the final reply appears EXACTLY ONCE (missed message merged, not doubled)',
    counts.replyCount === 1, { replyCount: counts.replyCount });
  check('leg K: the messages are in order (the user bubble precedes the reply)',
    counts.inOrder, { inOrder: counts.inOrder });

  await h.page.close();
  stopByPid(h.srv.pid);
  h.ctl.close();
  await sleep(1200);
}

/*
 * LEG L — a HUNG recovery read must not WEDGE the controller (independent-verify
 * anthropic run 675f631b). A NAT/keepalive that BLACK-HOLES a flow makes an HTTP
 * read hang forever (no FIN/RST). B′'s reachability probe is transcriptTail(limit:1)
 * (URL `tail=1`); it is raced against RECOVERY_READ_MS, so a hang is treated as a
 * failure — inFlight is released and the backoff GROWS — the anti-wedge signature.
 * Pre-fix (no timeout) the probe pins inFlight true and the delay never grows, so a
 * later drop is short-circuited forever and the session never re-attaches.
 */
async function hungReadLeg(browser) {
  console.log(`\n========== LEG L — a hung recovery read must NOT wedge the controller (independent-verify must-FAIL) ==========`);
  const token = `HUNG-${Date.now().toString(36)}`;
  const h = await recoveryHarness(browser, 'L', token, 16000);
  await page_waitToken(h.page, token, 10000);
  await h.page.evaluate(() => { window.__noReload278 = 'kept'; });

  // Hang (never settle) ONLY the reachability probe (tail=1) while armed; the
  // catch-up reads (tail=120 and smaller) and everything else pass.
  let hangProbe = true;
  await h.page.route('**/api/transcript/**', async (route) => {
    const url = route.request().url();
    if (hangProbe && /[?&]tail=1(\b|&|$)/.test(url)) return; // never fulfill -> hang
    await route.continue();
  });

  await h.page.evaluate(() => { try { window.__station.state.ws.close(); } catch { /* */ } });
  let maxDelay = 0, sawInFlightFalse = false;
  const baseDelay = await h.page.evaluate(() => window.__station.reconnectInfo()?.delay ?? 0) || 1000;
  for (let i = 0; i < 13; i++) { // ~26s of hang, longer than two RECOVERY_READ_MS cycles
    await sleep(2000);
    const ci = await h.page.evaluate(() => window.__station.reconnectInfo());
    if (ci) { maxDelay = Math.max(maxDelay, ci.delay); if (ci.inFlight === false) sawInFlightFalse = true; }
  }
  const during = await h.page.evaluate(VIEW_STATE(token));
  check('leg L: the pane stays intact while the recovery probe hangs (never "could not read")',
    during.hasToken && !during.couldNotRead, during);
  check('leg L (FIX): the controller is NOT wedged — a hung probe times out so the backoff GREW and inFlight was released (pre-fix: frozen at base, inFlight pinned)',
    maxDelay > baseDelay && sawInFlightFalse, { baseDelay, maxDelay, sawInFlightFalse });

  // Reads answer again: recovery must COMPLETE — the reply renders, pane never blanked.
  hangProbe = false;
  const got = await pollReply(h.page, token, 25000);
  const kept = await h.page.evaluate(() => window.__noReload278 ?? null);
  const after = await h.page.evaluate(VIEW_STATE(token));
  check('leg L (FIX): once reads answer, recovery COMPLETES — the reply renders, pane never blanked, no reload',
    got.ok && kept === 'kept' && !after.couldNotRead, { hasReply: got.r?.hasReply, kept, couldNotRead: after.couldNotRead });

  await h.page.unroute('**/api/transcript/**').catch(() => {});
  await h.page.close();
  stopByPid(h.srv.pid);
  h.ctl.close();
  await sleep(1200);
}

/*
 * LEG M — a genuinely UNMERGEABLE update (a rotated/truncated transcript file) shows
 * a VISIBLE "reload view" control the user CLICKS, instead of an automatic re-render
 * (design B′ point 3). The click is a real navigation, so it is allowed to move the
 * URL/scroll. This replaces the r4–r8 automatic atomicReopen, which moved the user's
 * URL/scroll behind their back. The control must appear and, clicked, re-render.
 */
async function reloadControlLeg(browser) {
  console.log(`\n========== LEG M — an unmergeable update shows a user-clicked reload control; clicking it re-renders ==========`);
  const token = `RELOAD-${Date.now().toString(36)}`;
  const h = await recoveryHarness(browser, 'M', token, 16000);
  await page_waitToken(h.page, token, 10000);
  // Drive the real file-rotation path: resyncTranscript() (what applyAppend calls on
  // a `resynced` append when the watch socket sees the file rotate) surfaces the
  // reload control instead of an automatic re-render. Called directly here because a
  // LIVE bridged session's applyAppend early-returns (isBridged) — the control's
  // routing from resyncTranscript is what this leg proves.
  await h.page.evaluate(() => window.__station.resyncTranscript());
  await sleep(600);
  const shown = await h.page.evaluate(() => {
    const b = document.querySelector('#panes .reload-view');
    return { present: !!b, hasButton: !!b?.querySelector('.reload-view-btn'), text: b?.textContent ?? '' };
  });
  check('leg M: the reload-view control is shown (no automatic re-render)', shown.present && shown.hasButton, shown);
  // Record the URL before clicking — the control's click is a real navigation.
  const urlBefore = await h.page.evaluate(() => location.hash);
  await h.page.click('#panes .reload-view-btn').catch(() => {});
  const after = await pollReply(h.page, token, 20000);
  const gone = await h.page.evaluate(() => !document.querySelector('#panes .reload-view'));
  check('leg M: clicking the control re-renders the conversation (reply present, banner gone)',
    after.ok && gone, { hasReply: after.r?.hasReply, bannerGone: gone, urlBefore });

  await h.page.close();
  stopByPid(h.srv.pid);
  h.ctl.close();
  await sleep(1200);
}

/*
 * LEG N — THE r8 USER-SCROLL SWALLOW (must-FAIL from the r7 code). During recovery the
 * user scrolls UP in the transcript; their scroll must update the URL's `&i=` exactly
 * as it would with no recovery in flight. The r7 code gated the debounced scroll-sync
 * to recovery's generation (`recoverySettleGen`) for an 800 ms settle tail after the
 * in-place repaint, swallowing the user's own concurrent scroll write. B′ performs no
 * in-place repaint and no scroll-sync suppression, so the write lands.
 *
 * We drop, hold recovery open (server unreachable so it keeps retrying = "mid-recovery"),
 * scroll up, bring the server back, and assert the URL gained an `&i=` — the user's own
 * scroll position, never swallowed. A CONTROL with no recovery in flight shows the same
 * write happens normally (so a swallow would be a real regression, not a no-op).
 */
async function userScrollUrlLeg(browser) {
  console.log(`\n========== LEG N — a user scroll DURING recovery writes the URL's &i= (r8 swallow must-FAIL) ==========`);
  const token = `SCROLL-${Date.now().toString(36)}`;
  // A LONG live turn. A fresh live turn is drawn indexless, so to get a transcript a
  // scroll can name an index from, REOPEN it from the store mid-turn: openSession
  // renders the persisted indexed tail (the prompt is persisted at #0 early) AND
  // reattaches the still-live bridge — exactly what a reload does. The view is then
  // both INDEXED and LIVE, the real r8 scenario (a reloaded, still-running session).
  const h = await recoveryHarness(browser, 'N', token, 28000);
  await page_waitToken(h.page, token, 15000);
  await sleep(4000); // let the prompt (and early turn output) persist to the store
  await h.page.evaluate(() => window.__station.reopenAtLatest());
  const live = await h.page.waitForFunction(() => window.__station.state.live && !!window.__station.state.sdkSessionId, undefined, { timeout: 60000 }).then(() => true).catch(() => false);
  check('leg N PRECONDITION: the reopened session is live again (reattached)', live, { live });
  const hasIndexed = await h.page.evaluate(() => !!document.querySelector('#panes [data-i]'));
  check('leg N PRECONDITION: the transcript carries indexed messages (a scroll can name an index)', hasIndexed, { hasIndexed });
  // Spy on history.replaceState: the scroll-sync (syncUrlSoon -> syncUrl('replace'))
  // writes through it. This is the exact write the r7 recoverySettleGen gate swallowed.
  await h.page.evaluate(() => {
    const orig = history.replaceState.bind(history);
    window.__rsOrig = orig;
    history.replaceState = (s, t, url) => { (window.__rsCalls = window.__rsCalls || []).push(String(url ?? location.hash)); return orig(s, t, url); };
  });
  // Land at the bottom, then drop + keep the server DOWN so recovery is in flight.
  await h.page.evaluate(() => { const sc = document.querySelector('#scroll') || document.scrollingElement; if (sc) { sc.scrollTop = sc.scrollHeight; sc.dispatchEvent(new Event('scroll')); } });
  await sleep(700);
  h.ctl.down();
  await sleep(1500);
  const recovering = await h.page.evaluate(() => ({ dropped: window.__station.state.dropped, ctl: window.__station.reconnectInfo() }));
  check('leg N PRECONDITION: recovery is in flight (dropped, controller live)', recovering.dropped && !!recovering.ctl, recovering);
  // The user scrolls UP mid-recovery. The real scroll handler arms the debounced URL
  // sync exactly as a drag would.
  await h.page.evaluate(() => { window.__rsCalls = []; });
  await h.page.evaluate(() => {
    const sc = document.querySelector('#scroll') || document.scrollingElement;
    if (sc) { sc.scrollTop = 0; sc.dispatchEvent(new Event('scroll')); }
  });
  await sleep(1400); // > the 400 ms syncUrlSoon debounce
  const rs = await h.page.evaluate(() => ({ calls: (window.__rsCalls || []).slice(), hash: location.hash }));
  h.ctl.up();
  // The user's scroll during recovery wrote the URL (replaceState ran with an i=).
  // Under the r7 recoverySettleGen gate this write was swallowed (0 calls) — the
  // must-FAIL this leg witnesses.
  const wroteI = rs.calls.some((u) => /[?&]i=\d/.test(u)) || /[?&]i=\d/.test(rs.hash);
  check('leg N: the user scroll during recovery was NOT swallowed — the scroll-sync wrote the URL (&i=) mid-recovery',
    rs.calls.length > 0 && wroteI, { replaceStateCalls: rs.calls.length, hash: rs.hash });

  await h.page.close();
  stopByPid(h.srv.pid);
  h.ctl.close();
  await sleep(1200);
}

/*
 * LEG O — THE r6 USER-NAV SWALLOW (must-FAIL from the r7 code). The user navigates to
 * ANOTHER session DURING recovery; the navigation must move the URL and push a history
 * entry exactly as it would with no recovery in flight. The r5/r6 code's global
 * syncUrl suppression window (reopenInPlaceDepth / recoverySettleUntil) swallowed the
 * user's concurrent navigation — the view moved but the URL/Back/reload stayed on the
 * recovered session (anthropic run 3347ebe2). B′ has no such window: openSession is a
 * real navigation and always writes.
 */
async function userNavUrlLeg(browser) {
  console.log(`\n========== LEG O — a user nav to another session DURING recovery writes the URL + history (r6 swallow must-FAIL) ==========`);
  const serverPort = await freePort();
  const DATA = mkTmp('data');
  const WORK = mkTmp('work');
  const srv = startServer(serverPort, DATA, { CLAUDE_STATION_CODEX_BIN: FAKE, CLAUDE_STATION_SURVIVE: '1', CLAUDE_STATION_WS_PING_MS: String(PING_MS) });
  if (!(await waitHealth(serverPort))) throw new Error('scratch server never became healthy');
  // TWO projects: the fake app-server reuses one thread id per process, so two
  // distinct sessions must live in two projects (exactly the r6 verifier's setup).
  const projectId = await registerProject(serverPort, WORK, 'b278-O', { provider: 'openai', model: null, permissionMode: 'bypassPermissions' });
  const WORK2 = mkTmp('work2');
  const projectId2 = await registerProject(serverPort, WORK2, 'b278-O2', { provider: 'openai', model: null, permissionMode: 'bypassPermissions' });
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
  await page.goto(`http://127.0.0.1:${serverPort}/#/project/${encodeURIComponent(projectId2)}`);
  await page.waitForFunction(() => window.__station && document.querySelector('#prompt'), undefined, { timeout: 30000 });

  // Session B in project 2: a short turn, let it finish, so a REAL second session
  // exists for the user to navigate INTO mid-recovery (the r6 scenario — openSession
  // to another existing session in another project, not startNew).
  const sB = `NAVURL-SB-${Date.now().toString(36)}`;
  await page.fill('#prompt', `QUIET_THEN_REPLY:${sB};QUIET:500 — session B`);
  await page.keyboard.press('Enter');
  await pollReply(page, sB, 40000);
  const sessB = await page.evaluate(() => ({ projectId: window.__station.state.current.projectId, sessionId: window.__station.state.current.sessionId, encodedDir: window.__station.state.current.encodedDir, title: window.__station.state.current.title, os: window.__station.state.current.os }));

  // Session A in project 1: a long live turn we will drop and recover.
  await page.evaluate((pid) => window.__station.selectProject(pid), projectId);
  await page.evaluate((pid) => window.__station.startNew(pid), projectId);
  const s1 = `NAVURL-S1-${Date.now().toString(36)}`;
  await page.fill('#prompt', `QUIET_THEN_REPLY:${s1};QUIET:16000 — the recovered session`);
  await page.keyboard.press('Enter');
  const live = await page.waitForFunction(() => window.__station.state.live && !!window.__station.state.sdkSessionId, undefined, { timeout: 60000 }).then(() => true).catch(() => false);
  check('leg O PRECONDITION: a live turn is on screen', live && (await page_waitToken(page, s1, 10000)), { live });
  const histBefore = await page.evaluate(() => history.length);
  const s1Id = await page.evaluate(() => window.__station.state.current.sessionId);

  // Drop S1 (recovery scheduled) then IMMEDIATELY openSession(B) — a real user
  // navigation to ANOTHER existing session while recovery is in flight. The URL must
  // move to B and a history entry be pushed; neither may be swallowed by a recovery
  // window (the r5/r6 global syncUrl suppression swallowed exactly this).
  await page.evaluate(() => { try { window.__station.state.ws.close(); } catch { /* */ } });
  // Let the drop's close event fire and schedule recovery BEFORE navigating, so the
  // user nav genuinely lands mid-recovery (openSession in the same tick marks the
  // close intentional and recovery never arms).
  await page.waitForFunction(() => window.__station.state.dropped === true && !!window.__station.reconnectInfo(), undefined, { timeout: 8000 }).catch(() => {});
  await page.evaluate(async (b) => {
    const p = window.__station.state.projects.find((x) => x.id === b.projectId);
    await window.__station.openSession(p, { encodedDir: b.encodedDir, sessionId: b.sessionId, displayTitle: b.title, os: b.os });
  }, sessB);
  await sleep(2500);
  const after = await page.evaluate((pid2) => ({
    movedAway: window.__station.state.current.projectId === pid2,
    hash: location.hash,
    histLen: history.length,
  }), projectId2);
  check('leg O: the user navigation during recovery moved the view to session B (not swallowed)',
    after.movedAway && after.hash.includes(projectId2), { ...after, proj2: projectId2 });
  check('leg O: the URL + history reflect the user\'s navigation (not frozen on the recovered session)',
    after.histLen > histBefore, { histBefore, histLen: after.histLen, hash: after.hash });

  await page.close();
  stopByPid(srv.pid);
  await sleep(1200);
}

/*
 * ── BUG-278 round 10 — the MERGE must be ATOMIC with a SUCCESSFUL fetch ──────────
 *
 * THE BUG (r9, OpenAI run 01a184bc-5427): a driving-drop recovery ran
 * `dropLiveTail(mainThread())` as a SEPARATE step BEFORE `catchUpFollow` fetched the
 * replacement. The reachability probe (tail=1) only proves the server answered ONE
 * read; the subsequent gap read (tail=120) can still 503 under the same flapping NAT.
 * So the probe succeeded, dropLiveTail wiped the user's own indexless `.you` bubble,
 * then every gap read failed — leaving the pane showing only the "retrying" hint with
 * the user's just-sent message GONE until a reload. The fix folds dropLiveTail INTO
 * catchUpFollow's success path (immediately before renderMessages, in one synchronous
 * frame): a failed/partial/hung/slow gap read never reaches it, so the bubble stays.
 *
 * These legs intercept the real recovery reads at the HTTP layer (Playwright
 * page.route) so the probe (tail=1) answers while the gap reads (tail>1 / before=)
 * fail, truncate, hang or slow — the exact shapes a half-open NAT produces. The
 * browser, server, bridge and fake engine are all real; only the fault is injected.
 */
const isProbe = (url) => /[?&]tail=1(&|$)/.test(url);
const isGapRead = (url) => /\/api\/transcript\//.test(url) && !isProbe(url);

async function failedGapLeg(browser) {
  console.log(`\n========== LEG P — successful probe then FAILING gap reads: the user's own message bubble is PRESERVED (r9 must-FAIL) ==========`);
  const token = `FAILGAP-${Date.now().toString(36)}`;
  const h = await recoveryHarness(browser, 'P', token, 18000);
  await page_waitToken(h.page, token, 10000);
  const before = await h.page.evaluate(VIEW_STATE(token));
  check('leg P PRECONDITION: the user\'s own message bubble is visible before the drop', before.hasToken, before);
  // Probe (tail=1) continues to the real server (success); EVERY gap/older read 503s.
  let failGap = true;
  await h.page.route('**/api/transcript/**', async (route) => {
    const url = route.request().url();
    if (failGap && isGapRead(url)) return void route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'injected gap read failure' }) });
    await route.continue();
  });
  await h.page.evaluate(() => { try { window.__station.state.ws.close(); } catch { /* */ } });
  // Through ~9s of repeated 503 gap reads the bubble must STAY and the pane must never
  // blank. Pre-fix (dropLiveTail BEFORE the fetch) the bubble is wiped on the first pass.
  let wiped = false, blanked = false, probes = 0, gapFails = 0;
  h.page.on('response', (r) => { const u = r.url(); if (/\/api\/transcript\//.test(u)) { if (isProbe(u)) probes++; else if (r.status() === 503) gapFails++; } });
  for (let i = 0; i < 9; i++) {
    await sleep(1000);
    const v = await h.page.evaluate(VIEW_STATE(token));
    if (!v.hasToken) wiped = true;
    if (v.couldNotRead) blanked = true;
  }
  const during = await h.page.evaluate(VIEW_STATE(token));
  const hintShown = await h.page.evaluate(() => (document.querySelector('#panes')?.textContent ?? '').includes('could not yet read the messages written while this view was reconnecting'));
  check('leg P: the fault reached probe-success followed by failing gap reads', probes >= 1 && gapFails >= 1, { probes, gapFails });
  check('leg P (FIX): the user\'s own message bubble is NEVER wiped while gap reads fail (r9 wiped it before any replacement was fetched)', !wiped && during.hasToken, { wiped, hasToken: during.hasToken });
  check('leg P: the pane never blanks to an error pane while gap reads fail', !blanked && !during.couldNotRead, { blanked, couldNotRead: during.couldNotRead });
  check('leg P: the retry hint is shown (the failure is never silent)', hintShown, { hintShown });
  await h.page.unroute('**/api/transcript/**').catch(() => {});
  await h.page.close();
  stopByPid(h.srv.pid);
  h.ctl.close();
  await sleep(1200);
}

async function failThenSucceedLeg(browser) {
  console.log(`\n========== LEG Q — gap reads FAIL then SUCCEED: bubble kept through the failures, reply merges once when reads answer ==========`);
  const token = `FGSUCC-${Date.now().toString(36)}`;
  const h = await recoveryHarness(browser, 'Q', token, 5000); // reply lands at ~5s
  await page_waitToken(h.page, token, 10000);
  let failGap = true;
  await h.page.route('**/api/transcript/**', async (route) => {
    const url = route.request().url();
    if (failGap && isGapRead(url)) return void route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'injected gap read failure' }) });
    await route.continue();
  });
  await h.page.evaluate(() => { try { window.__station.state.ws.close(); } catch { /* */ } });
  // ~5s of failing gap reads: the bubble stays, the pane never blanks.
  let wiped = false, blanked = false;
  for (let i = 0; i < 5; i++) { await sleep(1000); const v = await h.page.evaluate(VIEW_STATE(token)); if (!v.hasToken) wiped = true; if (v.couldNotRead) blanked = true; }
  check('leg Q: the bubble is preserved through the failing gap reads', !wiped && !blanked, { wiped, blanked });
  // Reads answer again — recovery must COMPLETE: the merged reply renders exactly once.
  failGap = false;
  const got = await pollReply(h.page, token, 30000);
  await sleep(2500);
  const counts = await h.page.evaluate((t) => {
    const panes = document.querySelector('#panes');
    const main = panes.querySelector('.pane.on, .pane') ?? panes;
    const yous = [...main.querySelectorAll('.you')].filter((n) => n.textContent.includes(t) && !n.textContent.includes('FINAL::'));
    const replyCount = (main.textContent.match(new RegExp('FINAL::' + t.replace(/[-]/g, '\\$&'), 'g')) || []).length;
    const all = [...main.querySelectorAll('*')];
    const youIdx = all.findIndex((n) => n.matches('.you') && n.textContent.includes(t) && !n.textContent.includes('FINAL::'));
    const replyIdx = all.findIndex((n) => n.textContent.includes('FINAL::' + t));
    return { youCount: yous.length, replyCount, inOrder: youIdx >= 0 && replyIdx >= 0 && youIdx < replyIdx, couldNotRead: panes.textContent.includes('could not read this session') };
  }, token);
  check('leg Q: once reads answer, the reply renders (recovery completed, no reload)', got.ok && !counts.couldNotRead, { hasReply: got.r?.hasReply, couldNotRead: counts.couldNotRead });
  check('leg Q: the user\'s own message appears EXACTLY ONCE after the merge', counts.youCount === 1, { youCount: counts.youCount });
  check('leg Q: the reply appears EXACTLY ONCE (merged, not doubled)', counts.replyCount === 1, { replyCount: counts.replyCount });
  check('leg Q: the messages are in order (the user bubble precedes the reply)', counts.inOrder, { inOrder: counts.inOrder });
  await h.page.unroute('**/api/transcript/**').catch(() => {});
  await h.page.close();
  stopByPid(h.srv.pid);
  h.ctl.close();
  await sleep(1200);
}

async function partialGapLeg(browser) {
  console.log(`\n========== LEG R — a TRUNCATED gap response (half-open read) is treated as a failed read: bubble preserved, then completes ==========`);
  const token = `PARTIAL-${Date.now().toString(36)}`;
  const h = await recoveryHarness(browser, 'R', token, 6000);
  await page_waitToken(h.page, token, 10000);
  // A stateful NAT can deliver a PARTIAL body — a valid JSON prefix, cut off mid-stream
  // (no FIN). The client's api() JSON.parse throws, so the read counts as a FAILURE: the
  // merge step is never reached, so the bubble must stay. This is the WA "test TRUNCATED
  // reads" rule applied to the recovery gap read.
  let truncate = true;
  await h.page.route('**/api/transcript/**', async (route) => {
    const url = route.request().url();
    if (truncate && isGapRead(url)) {
      const resp = await route.fetch();
      const body = await resp.text();
      const cut = body.slice(0, Math.max(8, Math.floor(body.length * 0.4))); // valid prefix, truncated mid-JSON
      return void route.fulfill({ status: 200, contentType: 'application/json', body: cut });
    }
    await route.continue();
  });
  await h.page.evaluate(() => { try { window.__station.state.ws.close(); } catch { /* */ } });
  let wiped = false, blanked = false;
  for (let i = 0; i < 6; i++) { await sleep(1000); const v = await h.page.evaluate(VIEW_STATE(token)); if (!v.hasToken) wiped = true; if (v.couldNotRead) blanked = true; }
  check('leg R: a truncated gap response never wipes the bubble or blanks the pane', !wiped && !blanked, { wiped, blanked });
  // Full responses resume — recovery completes.
  truncate = false;
  const got = await pollReply(h.page, token, 25000);
  const after = await h.page.evaluate(VIEW_STATE(token));
  check('leg R: once full responses resume, the reply renders (no error pane)', got.ok && !after.couldNotRead, { hasReply: got.r?.hasReply, couldNotRead: after.couldNotRead });
  await h.page.unroute('**/api/transcript/**').catch(() => {});
  await h.page.close();
  stopByPid(h.srv.pid);
  h.ctl.close();
  await sleep(1200);
}

async function hungGapLeg(browser) {
  console.log(`\n========== LEG S — a HUNG gap read (black-holed, no FIN): bubble preserved, no wedge, completes when it answers ==========`);
  const token = `HUNGGAP-${Date.now().toString(36)}`;
  const h = await recoveryHarness(browser, 'S', token, 8000);
  await page_waitToken(h.page, token, 10000);
  // The gap read hangs forever (the exact black-hole the bug is about). dropLiveTail is
  // only reached on a SUCCESSFUL read, so a hang leaves the bubble exactly as it is.
  let hangGap = true;
  await h.page.route('**/api/transcript/**', async (route) => {
    const url = route.request().url();
    if (hangGap && isGapRead(url)) return; // never fulfill -> hang
    await route.continue();
  });
  await h.page.evaluate(() => { try { window.__station.state.ws.close(); } catch { /* */ } });
  let wiped = false, blanked = false;
  for (let i = 0; i < 8; i++) { await sleep(1000); const v = await h.page.evaluate(VIEW_STATE(token)); if (!v.hasToken) wiped = true; if (v.couldNotRead) blanked = true; }
  const during = await h.page.evaluate(VIEW_STATE(token));
  check('leg S: the bubble stays intact while the gap read hangs (never "could not read")', !wiped && !blanked && during.hasToken, { wiped, blanked, hasToken: during.hasToken });
  // Reads answer — recovery completes, reply renders.
  hangGap = false;
  const got = await pollReply(h.page, token, 30000);
  const after = await h.page.evaluate(VIEW_STATE(token));
  check('leg S: once the hung read answers, recovery completes and the reply renders', got.ok && !after.couldNotRead, { hasReply: got.r?.hasReply, couldNotRead: after.couldNotRead });
  await h.page.unroute('**/api/transcript/**').catch(() => {});
  await h.page.close();
  stopByPid(h.srv.pid);
  h.ctl.close();
  await sleep(1200);
}

async function slowReadRacingAppendLeg(browser) {
  console.log(`\n========== LEG T — a SLOW gap read racing the turn's completion: the late reply is captured, each message appears once ==========`);
  const token = `SLOWRACE-${Date.now().toString(36)}`;
  // The reply persists ~6s in; the gap read is delayed ~3.5s. So the first gap read
  // is ISSUED while the turn is still running and RESOLVES after the reply has been
  // persisted — a slow read racing the live event (the reply landing in the store).
  // The read must capture the reply on completion and merge it exactly once, in order,
  // with the user's own indexless bubble reconciled to a single store-indexed copy.
  const h = await recoveryHarness(browser, 'T', token, 6000);
  await page_waitToken(h.page, token, 10000);
  let slow = true;
  await h.page.route('**/api/transcript/**', async (route) => {
    const url = route.request().url();
    if (slow && isGapRead(url)) { await sleep(3500); }
    await route.continue();
  });
  await h.page.evaluate(() => { try { window.__station.state.ws.close(); } catch { /* */ } });
  const got = await pollReply(h.page, token, 40000);
  slow = false;
  await sleep(2500);
  const counts = await h.page.evaluate((t) => {
    const panes = document.querySelector('#panes');
    const main = panes.querySelector('.pane.on, .pane') ?? panes;
    const yous = [...main.querySelectorAll('.you')].filter((n) => n.textContent.includes(t) && !n.textContent.includes('FINAL::'));
    const replyCount = (main.textContent.match(new RegExp('FINAL::' + t.replace(/[-]/g, '\\$&'), 'g')) || []).length;
    const all = [...main.querySelectorAll('*')];
    const youIdx = all.findIndex((n) => n.matches('.you') && n.textContent.includes(t) && !n.textContent.includes('FINAL::'));
    const replyIdx = all.findIndex((n) => n.textContent.includes('FINAL::' + t));
    return { youCount: yous.length, replyCount, inOrder: youIdx >= 0 && replyIdx >= 0 && youIdx < replyIdx, couldNotRead: panes.textContent.includes('could not read this session') };
  }, token);
  check('leg T: the slow read completes — the late reply is captured and renders, pane never blanked', got.ok && !counts.couldNotRead, { hasReply: got.r?.hasReply, couldNotRead: counts.couldNotRead });
  check('leg T: the user\'s own message appears EXACTLY ONCE (the indexless bubble reconciled to one store copy)', counts.youCount === 1, { youCount: counts.youCount });
  check('leg T: the reply appears EXACTLY ONCE and in order (slow read merged it cleanly, no duplicate)', counts.replyCount === 1 && counts.inOrder, { replyCount: counts.replyCount, inOrder: counts.inOrder });
  await h.page.unroute('**/api/transcript/**').catch(() => {});
  await h.page.close();
  stopByPid(h.srv.pid);
  h.ctl.close();
  await sleep(1200);
}

async function contiguousPrefixLeg(browser) {
  console.log(`\n========== LEG U — a contiguous gap PREFIX that lacks the current user message must NOT wipe it (independent-verify must-FAIL) ==========`);
  const old = `OLDTURN-${Date.now().toString(36)}`;
  const token = `NEWTURN-${Date.now().toString(36)}`;
  // First turn completes (quick), then a long second turn we drop. Both are drawn
  // indexless by the driving socket, so the pane holds BOTH turns' live tails.
  const h = await recoveryHarness(browser, 'U', old, 1000);
  check('leg U PRECONDITION: the first turn completed', (await pollReply(h.page, old, 20000)).ok, {});
  await h.page.fill('#prompt', `QUIET_THEN_REPLY:${token};QUIET:18000 — second turn`);
  await h.page.focus('#prompt');
  await h.page.keyboard.press('Enter');
  await page_waitToken(h.page, token, 12000);
  // The exact independent-verify attack: slice every gap read to a CONTIGUOUS prefix
  // that stops BEFORE the current (second-turn) user message, while leaving `total` at
  // the true count — a well-formed prefix that omits a message the store actually has.
  // Pre-fix, catchUpFollow accepts it and dropLiveTail removes BOTH turns' live tails,
  // re-rendering only the prefix (turn 1) — the user's current message vanishes.
  let partials = 0, prefixActive = true;
  await h.page.route('**/api/transcript/**', async (route) => {
    if (!isGapRead(route.request().url())) return void route.continue();
    const response = await route.fetch();
    let body; try { body = await response.json(); } catch { return void route.fulfill({ response }); }
    if (prefixActive) {
      const boundary = (body.messages || []).findIndex((m) => JSON.stringify(m).includes(token));
      if (boundary >= 0) { body.messages = body.messages.slice(0, boundary); partials++; }
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await h.page.evaluate(() => { try { window.__station.state.ws.close(); } catch { /* */ } });
  let wiped = false, blanked = false;
  for (let i = 0; i < 40; i++) { await sleep(150); const v = await h.page.evaluate(VIEW_STATE(token)); if (!v.hasToken) wiped = true; if (v.couldNotRead) blanked = true; }
  const during = await h.page.evaluate(VIEW_STATE(token));
  check('leg U: the gap reads were sliced to a prefix lacking the current user message', partials > 0, { partials });
  check('leg U (FIX): a contiguous prefix without the current user message NEVER wipes that message (treated as a short read, retried)', !wiped && during.hasToken, { wiped, hasToken: during.hasToken });
  check('leg U: the pane never blanks to an error pane while prefixes are returned', !blanked && !during.couldNotRead, { blanked, couldNotRead: during.couldNotRead });
  // Full responses resume — recovery completes, the current message is still present once.
  prefixActive = false;
  const got = await pollReply(h.page, token, 30000);
  await sleep(2000);
  const counts = await h.page.evaluate((t) => {
    const panes = document.querySelector('#panes');
    const main = panes.querySelector('.pane.on, .pane') ?? panes;
    const yous = [...main.querySelectorAll('.you')].filter((n) => n.textContent.includes(t) && !n.textContent.includes('FINAL::'));
    return { youCount: yous.length, hasReply: panes.textContent.includes('FINAL::' + t), couldNotRead: panes.textContent.includes('could not read this session') };
  }, token);
  check('leg U: once full responses resume, the current turn renders exactly once (bubble + reply), no error', got.ok && counts.youCount === 1 && !counts.couldNotRead, { hasReply: counts.hasReply, youCount: counts.youCount, couldNotRead: counts.couldNotRead });
  await h.page.unroute('**/api/transcript/**').catch(() => {});
  await h.page.close();
  stopByPid(h.srv.pid);
  h.ctl.close();
  await sleep(1200);
}

/*
 * LEGS V / W — the round-10 refutation (IV #3 run 8a0c18fa), reproduced FAITHFULLY. A
 * single turn is dropped while its live tail is still INDEXLESS (the reported bug: a
 * fresh session whose only turn is in flight, th.lastIndex null → the reconcile reads
 * the store from #0). Every gap read is then REPLACED at the HTTP layer with a
 * SELF-CONSISTENT stale snapshot — a well-formed message at index 0 that is NOT the
 * user's current prompt, whose `total` EQUALS the one message it returns (leg V) or is
 * ABSENT (leg W). That shape defeats the r10 `reached < total` count guard (reached ==
 * total, or no total), so r10 accepted it and dropLiveTail wiped the current optimistic
 * bubble with no replacement. Round 11 correlates by CONTENT: the snapshot does not
 * carry the message the user just sent, so it is a failed read — the bubble is
 * preserved AND the stale message is never rendered. REAL browser/server/bridge; only
 * the gap-read body is injected (as the IV did, which could not reproduce it server-side).
 */
async function staleSnapshotLeg(browser, tag, totalMode) {
  const label = totalMode === 'consistent' ? 'total EQUALS the one-message snapshot' : 'NO total field';
  console.log(`\n========== LEG ${tag} — a self-consistent stale snapshot (${label}) must NOT wipe the current message (r10 IV #3 must-FAIL) ==========`);
  const token = `NEWTURN-${Date.now().toString(36)}`;
  const h = await recoveryHarness(browser, tag, token, 18000);
  await page_waitToken(h.page, token, 12000);
  // The live tail must still be INDEXLESS at the drop (th.lastIndex null) — that is the
  // reported bug's state and the only one where the reconcile reads the store from #0.
  const pre = await h.page.evaluate(() => ({ lastIndex: window.__station.mainThread().lastIndex }));
  check(`leg ${tag} PRECONDITION: the dropped turn's live tail is indexless (lastIndex null)`, pre.lastIndex == null, pre);
  let injected = 0, staleActive = true;
  await h.page.route('**/api/transcript/**', async (route) => {
    if (!isGapRead(route.request().url())) return void route.continue();
    if (!staleActive) return void route.continue();
    // A self-consistent stale snapshot: ONE message at #0 that is NOT the user's prompt.
    const snap = { messages: [{ role: 'user', index: 0, uuid: 'stale-0', timestamp: Date.now(), blocks: [{ type: 'text', text: 'STALE SNAPSHOT — an older message, not the current prompt' }] }] };
    if (totalMode === 'consistent') snap.total = snap.messages.length; // else no total at all
    injected++;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snap) });
  });
  await h.page.evaluate(() => { try { window.__station.state.ws.close(); } catch { /* */ } });
  let wiped = false, blanked = false;
  for (let i = 0; i < 40; i++) { await sleep(150); const v = await h.page.evaluate(VIEW_STATE(token)); if (!v.hasToken) wiped = true; if (v.couldNotRead) blanked = true; }
  const during = await h.page.evaluate(VIEW_STATE(token));
  check(`leg ${tag}: the gap reads were replaced with a self-consistent stale snapshot (${label})`, injected > 0, { injected });
  check(`leg ${tag} (FIX): a self-consistent stale snapshot NEVER wipes the current message (content-correlated, not count)`, !wiped && during.hasToken, { wiped, hasToken: during.hasToken });
  check(`leg ${tag}: the stale message is NEVER rendered into the view`, !during.hasStale, { hasStale: during.hasStale });
  check(`leg ${tag}: the pane never blanks to an error pane while stale snapshots are returned`, !blanked && !during.couldNotRead, { blanked, couldNotRead: during.couldNotRead });
  staleActive = false;
  const got = await pollReply(h.page, token, 40000);
  await sleep(2000);
  const counts = await h.page.evaluate((t) => {
    const panes = document.querySelector('#panes');
    const main = panes.querySelector('.pane.on, .pane') ?? panes;
    const yous = [...main.querySelectorAll('.you')].filter((n) => n.textContent.includes(t) && !n.textContent.includes('FINAL::'));
    return { youCount: yous.length, hasReply: panes.textContent.includes('FINAL::' + t), hasStale: panes.textContent.includes('STALE SNAPSHOT'), couldNotRead: panes.textContent.includes('could not read this session') };
  }, token);
  check(`leg ${tag}: once real reads resume, the current turn renders exactly once (bubble + reply), no stale message, no error`, got.ok && counts.youCount === 1 && !counts.hasStale && !counts.couldNotRead, counts);
  await h.page.unroute('**/api/transcript/**').catch(() => {});
  await h.page.close();
  stopByPid(h.srv.pid);
  h.ctl.close();
  await sleep(1200);
}

/*
 * LEG CC — dropLiveTail's CONTENT-correlation rule, exercised directly against the REAL
 * exported function in the REAL app context (real DOM, real harnessNotice/caption
 * peeling). SYNTHETIC fixture: the optimistic bubbles and the `fresh` store messages
 * are built in-page rather than driven through the engine, because the engine cannot
 * easily be made to send the SAME text twice or re-wrap whitespace on demand. Each case
 * is a realistic live-tail shape. This is the micro-proof behind the integration legs
 * V/W/U/P/Q and the orchestrator's content rule.
 */
async function contentCorrelationLeg(browser) {
  console.log(`\n========== LEG CC — dropLiveTail removes an optimistic bubble ONLY on a uuid IDENTITY match (synthetic DOM, real function) ==========`);
  const h = await recoveryHarness(browser, 'CC', `CCTOK-${Date.now().toString(36)}`, 1000);
  await sleep(800);
  const r = await h.page.evaluate(() => {
    const S = window.__station;
    const th = S.mainThread();
    const pane = th.paneEl;
    const reset = () => { pane.innerHTML = ''; th.lastIndex = null; th.claudeBody = null; th.stream = null; th.settledStream = null; };
    // A bubble carries its send IDENTITY on data-uuid (the client stamps it; the
    // server/CLI persists it as the stored entry's uuid). `uuid:null` = a bubble
    // with no identity (must never be auto-removed).
    const mkYou = (text, { att = false, p = true, uuid = null } = {}) => { const d = document.createElement('div'); d.className = 'you'; if (uuid) d.dataset.uuid = uuid; if (p) { const e = document.createElement('p'); e.textContent = text; d.appendChild(e); } if (att) { const a = document.createElement('div'); a.className = 'att'; d.appendChild(a); } pane.appendChild(d); return d; };
    const mkClaude = (text) => { const d = document.createElement('div'); d.className = 'claude'; d.textContent = text; pane.appendChild(d); return d; };
    const u = (text, index, uuid) => ({ role: 'user', index, uuid, blocks: [{ type: 'text', text }] });
    const uAtt = (index, uuid) => ({ role: 'user', index, uuid, blocks: [{ type: 'attachment', attachment: { name: 'x.png', kind: 'image' } }] });
    const a = (text, index) => ({ role: 'assistant', index, uuid: `asst-${index}`, blocks: [{ type: 'text', text }] });
    const yous = () => [...pane.querySelectorAll(':scope > .you')].map((n) => (n.querySelector(':scope > p')?.textContent ?? '[att]'));
    const claudes = () => pane.querySelectorAll(':scope > .claude').length;
    const out = {};

    // 1) a bubble whose uuid IS in the merge → removed, with its settled partial.
    reset(); mkYou('hello world', { uuid: 'U1' }); mkClaude('p1');
    S.dropLiveTail(th, [u('hello world', 0, 'U1'), a('r1', 1)]);
    out.identityMatch = { remaining: yous(), claudes: claudes() };

    // 2) same TEXT twice, two distinct identities, both in the merge → both removed.
    reset(); mkYou('dup me', { uuid: 'A1' }); mkClaude('p1'); mkYou('dup me', { uuid: 'A2' }); mkClaude('p2');
    S.dropLiveTail(th, [u('dup me', 0, 'A1'), a('r1', 1), u('dup me', 2, 'A2'), a('r2', 3)]);
    out.twiceBoth = { remaining: yous(), claudes: claudes() };

    // 3) same text twice, only ONE identity persisted → exactly that one removed.
    reset(); mkYou('dup me', { uuid: 'B1' }); mkClaude('p1'); mkYou('dup me', { uuid: 'B2' }); mkClaude('p2');
    S.dropLiveTail(th, [u('dup me', 0, 'B1'), a('r1', 1)]);
    out.twiceOne = { remaining: yous(), stillHasB2: !!pane.querySelector(':scope > .you[data-uuid="B2"]') };

    // 4) a merge whose text IS IDENTICAL but whose uuid DIFFERS → NOT removed
    //    (identity, never text — the class that kept re-breaking).
    reset(); mkYou('same text', { uuid: 'MINE' }); mkClaude('p');
    S.dropLiveTail(th, [u('same text', 0, 'OTHER'), a('r', 1)]);
    out.textNotIdentity = { remaining: yous() };

    // 5) an attachment-only bubble (no <p>) is removed by IDENTITY — text-independent.
    reset(); mkYou('', { att: true, p: false, uuid: 'ATT1' });
    S.dropLiveTail(th, [uAtt(0, 'ATT1'), a('r', 1)]);
    out.attachmentIdentity = { remaining: yous() };

    // 6) a bubble with NO identity is NEVER removed (even if the merge carries its text).
    reset(); mkYou('no id here', { uuid: null }); mkClaude('p');
    S.dropLiveTail(th, [u('no id here', 0, 'SOMEUUID'), a('r', 1)]);
    out.noIdentity = { remaining: yous() };

    // 7) a stale snapshot lacking the bubble's identity removes NOTHING — including the
    //    assistant partial (turn unconfirmed → partial kept).
    reset(); mkYou('current prompt', { uuid: 'CUR' }); mkClaude('partial reply');
    S.dropLiveTail(th, [u('old prompt', 0, 'OLD'), a('old reply', 1)]);
    out.stale = { remaining: yous(), claudes: claudes() };

    // 8) a LEADING partial whose .you is already indexed on screen (not in the run) is
    //    confirmed by an assistant replacement in the merge → removed.
    reset(); const indexed = mkYou('indexed prompt', { uuid: 'IDX' }); indexed.dataset.i = '0'; mkClaude('leading partial');
    S.dropLiveTail(th, [a('the real reply', 1)]);
    out.leadingPartial = { claudes: claudes(), keptIndexed: !!pane.querySelector(':scope > .you[data-i]') };

    reset();
    return out;
  });
  check('leg CC/1: a bubble whose uuid is in the merge is removed (bubble + partial)', r.identityMatch.remaining.length === 0 && r.identityMatch.claudes === 0, r.identityMatch);
  check('leg CC/2: same text twice, two identities both in the merge → both removed', r.twiceBoth.remaining.length === 0 && r.twiceBoth.claudes === 0, r.twiceBoth);
  check('leg CC/3: same text twice, only one identity persisted → exactly that one removed', r.twiceOne.remaining.length === 1 && r.twiceOne.stillHasB2, r.twiceOne);
  check('leg CC/4: identical TEXT with a DIFFERENT uuid is NOT removed (identity, not text)', r.textNotIdentity.remaining.length === 1 && r.textNotIdentity.remaining[0] === 'same text', r.textNotIdentity);
  check('leg CC/5: an attachment-only bubble is removed by identity (text-independent)', r.attachmentIdentity.remaining.length === 0, r.attachmentIdentity);
  check('leg CC/6: a bubble with NO identity is never auto-removed', r.noIdentity.remaining.length === 1 && r.noIdentity.remaining[0] === 'no id here', r.noIdentity);
  check('leg CC/7: a stale snapshot lacking the identity removes nothing (bubble + partial kept)', r.stale.remaining.length === 1 && r.stale.claudes === 1, r.stale);
  check('leg CC/8: a leading partial whose .you is indexed is removed on an assistant replacement', r.leadingPartial.claudes === 0 && r.leadingPartial.keptIndexed, r.leadingPartial);
  await h.page.close();
  stopByPid(h.srv.pid);
  h.ctl.close();
  await sleep(1200);
}

/*
 * LEG XS — r11 IV finding (anthropic run 2d6af6ca, suffix-collision). A self-consistent
 * stale snapshot whose user text merely ENDS WITH the current prompt (an older, unrelated
 * message, not a recognised briefing) must NOT be mistaken for the current turn: the r11
 * IV found a bare `endsWith` suffix rule accepted it, wiping the bubble. userWords now
 * peels only KNOWN briefings then requires EXACT equality, so this is rejected.
 */
async function suffixCollisionLeg(browser) {
  console.log(`\n========== LEG XS — a stale snapshot that merely SHARES A SUFFIX with the prompt must NOT wipe it (r11 IV must-FAIL) ==========`);
  const token = `NEWTURN-${Date.now().toString(36)}`;
  const h = await recoveryHarness(browser, 'XS', token, 18000);
  await page_waitToken(h.page, token, 12000);
  const pre = await h.page.evaluate(() => ({ lastIndex: window.__station.mainThread().lastIndex, prompt: ([...document.querySelectorAll('#panes .you > p')].pop()?.textContent ?? '') }));
  check('leg XS PRECONDITION: indexless optimistic bubble present', pre.lastIndex == null && pre.prompt.includes(token), pre);
  let injected = 0, staleActive = true;
  await h.page.route('**/api/transcript/**', async (route) => {
    if (!isGapRead(route.request().url()) || !staleActive) return void route.continue();
    // A DIFFERENT, older message whose text happens to END WITH the current prompt.
    const snap = { messages: [{ role: 'user', index: 0, uuid: 'stale-0', timestamp: Date.now(), blocks: [{ type: 'text', text: `STALE SNAPSHOT older unrelated message — ${pre.prompt}` }] }], total: 1 };
    injected++;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snap) });
  });
  await h.page.evaluate(() => { try { window.__station.state.ws.close(); } catch { /* */ } });
  let wiped = false, staleSeen = false;
  for (let i = 0; i < 40; i++) { await sleep(150); const v = await h.page.evaluate(VIEW_STATE(token)); if (!v.hasToken) wiped = true; if (v.hasStale) staleSeen = true; }
  check('leg XS: the suffix-sharing stale snapshot was injected', injected > 0, { injected });
  check('leg XS (FIX): a suffix-only collision NEVER wipes the current message', !wiped, { wiped });
  check('leg XS: the stale message is NEVER rendered into the view', !staleSeen, { staleSeen });
  staleActive = false;
  const got = await pollReply(h.page, token, 40000);
  await sleep(2000);
  const counts = await h.page.evaluate((t) => {
    const main = document.querySelector('#panes');
    const yous = [...main.querySelectorAll('.you')].filter((n) => n.textContent.includes(t) && !n.textContent.includes('FINAL::') && !n.textContent.includes('STALE SNAPSHOT'));
    return { youCount: yous.length, hasReply: main.textContent.includes('FINAL::' + t), hasStale: main.textContent.includes('STALE SNAPSHOT') };
  }, token);
  check('leg XS: once real reads resume, the current turn renders exactly once, no stale message', got.ok && counts.youCount === 1 && !counts.hasStale, counts);
  await h.page.unroute('**/api/transcript/**').catch(() => {});
  await h.page.close();
  stopByPid(h.srv.pid);
  h.ctl.close();
  await sleep(1200);
}

/*
 * LEG XA — r11 IV finding (attachment-only gate-skip). When the trailing optimistic
 * bubble is attachment-only (no `<p>`), the text-coverage `want` is empty; the r11 IV
 * found the gate was then SKIPPED and a stale text snapshot accepted + rendered. The gate
 * now also requires attachment coverage, so a text-only stale snapshot is rejected. The
 * attachment-only shape is simulated by stripping the `<p>` from the real live bubble.
 */
async function attachmentStaleLeg(browser) {
  console.log(`\n========== LEG XA — an attachment-only optimistic bubble must still gate out a stale snapshot (r11 IV must-FAIL) ==========`);
  const token = `NEWTURN-${Date.now().toString(36)}`;
  const h = await recoveryHarness(browser, 'XA', token, 18000);
  await page_waitToken(h.page, token, 12000);
  const pre = await h.page.evaluate(() => {
    const p = [...document.querySelectorAll('#panes .you > p')].pop();
    const li = window.__station.mainThread().lastIndex;
    if (p) p.remove(); // make the trailing optimistic bubble ATTACHMENT-ONLY
    const optBubbles = [...document.querySelectorAll('#panes .you')].filter((n) => !n.matches('[data-i]')).length;
    return { lastIndex: li, optBubbles };
  });
  check('leg XA PRECONDITION: an indexless attachment-only optimistic bubble is present', pre.lastIndex == null && pre.optBubbles >= 1, pre);
  let injected = 0, staleActive = true;
  await h.page.route('**/api/transcript/**', async (route) => {
    if (!isGapRead(route.request().url()) || !staleActive) return void route.continue();
    const snap = { messages: [{ role: 'user', index: 0, uuid: 'stale-0', timestamp: Date.now(), blocks: [{ type: 'text', text: 'STALE SNAPSHOT — a text-only older message, no attachment' }] }], total: 1 };
    injected++;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snap) });
  });
  await h.page.evaluate(() => { try { window.__station.state.ws.close(); } catch { /* */ } });
  let staleSeen = false, lostBubble = false;
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    const v = await h.page.evaluate(() => ({ stale: document.querySelector('#panes').textContent.includes('STALE SNAPSHOT'), opt: [...document.querySelectorAll('#panes .you')].filter((n) => !n.matches('[data-i]')).length }));
    if (v.stale) staleSeen = true;
    if (v.opt < 1) lostBubble = true;
  }
  check('leg XA: the stale snapshot was injected', injected > 0, { injected });
  check('leg XA (FIX): the stale message is NEVER rendered when the tail is attachment-only', !staleSeen, { staleSeen });
  check('leg XA (FIX): the attachment-only optimistic bubble is never wiped by the stale snapshot', !lostBubble, { lostBubble });
  await h.page.unroute('**/api/transcript/**').catch(() => {});
  await h.page.close();
  stopByPid(h.srv.pid);
  h.ctl.close();
  await sleep(1200);
}

/*
 * LEG XI — r13 IV finding (openai run 01a186d6). An IDENTITYLESS trailing optimistic
 * bubble (data-uuid stripped — the shape a uuid-less delivery path could leave) must STILL
 * gate out a stale/unrelated read: the first candidate omitted identityless bubbles from
 * the coverage set, so `opt.uuids` was empty, the gate was skipped and a stale snapshot
 * RENDERED (though it did not wipe the bubble). The gate now rejects any merge while a
 * trailing `.you` bubble is uncovered — identityless included — so a stale read is never
 * rendered and the bubble is never wiped (bounded retry then arm resume: never-auto-remove).
 */
async function identitylessStaleLeg(browser) {
  console.log(`\n========== LEG XI — an IDENTITYLESS optimistic bubble must still gate out a stale snapshot (r13 IV must-FAIL) ==========`);
  const token = `NEWTURN-${Date.now().toString(36)}`;
  const h = await recoveryHarness(browser, 'XI', token, 18000);
  await page_waitToken(h.page, token, 12000);
  const pre = await h.page.evaluate(() => {
    const li = window.__station.mainThread().lastIndex;
    const bubbles = [...document.querySelectorAll('#panes .you')].filter((n) => !n.matches('[data-i]'));
    for (const b of bubbles) delete b.dataset.uuid; // strip identity → an identityless trailing bubble
    const identities = bubbles.map((n) => n.dataset.uuid ?? null);
    return { lastIndex: li, optBubbles: bubbles.length, identities };
  });
  check('leg XI PRECONDITION: an indexless IDENTITYLESS optimistic bubble is present', pre.lastIndex == null && pre.optBubbles >= 1 && pre.identities.every((u) => u == null), pre);
  let injected = 0, staleActive = true;
  await h.page.route('**/api/transcript/**', async (route) => {
    if (!isGapRead(route.request().url()) || !staleActive) return void route.continue();
    const snap = { messages: [{ role: 'user', index: 0, uuid: 'stale-xi-0', timestamp: Date.now(), blocks: [{ type: 'text', text: 'STALE SNAPSHOT — an older unrelated message' }] }], total: 1 };
    injected++;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snap) });
  });
  await h.page.evaluate(() => { try { window.__station.state.ws.close(); } catch { /* */ } });
  let staleSeen = false, lostBubble = false;
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    const v = await h.page.evaluate(() => ({ stale: document.querySelector('#panes').textContent.includes('STALE SNAPSHOT'), opt: [...document.querySelectorAll('#panes .you')].filter((n) => !n.matches('[data-i]')).length }));
    if (v.stale) staleSeen = true;
    if (v.opt < 1) lostBubble = true;
  }
  check('leg XI: the stale snapshot was injected', injected > 0, { injected });
  check('leg XI (FIX): the stale message is NEVER rendered when the tail is identityless', !staleSeen, { staleSeen });
  check('leg XI (FIX): the identityless optimistic bubble is never wiped by the stale snapshot', !lostBubble, { lostBubble });
  await h.page.unroute('**/api/transcript/**').catch(() => {});
  await h.page.close();
  stopByPid(h.srv.pid);
  h.ctl.close();
  await sleep(1200);
}

// Wait until the pane contains `token` (the prompt echo) — "the view is painted".
async function page_waitToken(page, token, ms) {
  return page.waitForFunction(
    (t) => (document.querySelector('#panes')?.textContent ?? '').includes(t),
    token, { timeout: ms },
  ).then(() => true).catch(() => false);
}

let browser = null;
try {
  if (!fs.existsSync(BRAVE)) {
    console.error(`FATAL: browser not found at ${BRAVE} (set QA_BRAVE_PATH) — this bug is what the USER SEES.`);
    process.exitCode = 1;
  } else {
    browser = await chromium.launch({ headless: true, executablePath: BRAVE });
    const all = LEG === 'both' || LEG === 'all';
    const recovery = LEG === 'recovery';
    if (LEG === 'A' || all) await oneLeg('A', browser);
    if (LEG === 'B' || all) { await oneLeg('B', browser); await deadClientLeg(); }
    if (LEG === 'C' || all) await clientRecoveryLeg(browser);
    // BUG-278 round 9 (design B′) recovery legs — the attack list, new contract.
    if (LEG === 'D' || all || recovery) await serverDownLeg(browser);
    if (LEG === 'E' || all || recovery) await flappingLeg(browser);
    if (LEG === 'F' || all || recovery) await navMidRecoveryLeg(browser);
    if (LEG === 'G' || all || recovery) await endWhileRecoveringLeg(browser);
    if (LEG === 'H' || all || recovery) await approvalDropLeg(browser);
    if (LEG === 'I' || all || recovery) await hiddenTabLeg(browser);
    if (LEG === 'J' || all || recovery) await noTurnOnRecoveryLeg(browser);
    if (LEG === 'K' || all || recovery) await mergeDedupLeg(browser);
    if (LEG === 'L' || all || recovery) await hungReadLeg(browser);
    if (LEG === 'M' || all || recovery) await reloadControlLeg(browser);
    if (LEG === 'N' || all || recovery) await userScrollUrlLeg(browser);
    if (LEG === 'O' || all || recovery) await userNavUrlLeg(browser);
    // BUG-278 round 10 — the merge must be ATOMIC with a SUCCESSFUL fetch: a probe
    // that succeeds then a gap read that fails/truncates/hangs/slows must never wipe
    // the user's own message bubble (OpenAI run 01a184bc-5427 must-FAIL).
    if (LEG === 'P' || all || recovery) await failedGapLeg(browser);
    if (LEG === 'Q' || all || recovery) await failThenSucceedLeg(browser);
    if (LEG === 'R' || all || recovery) await partialGapLeg(browser);
    if (LEG === 'S' || all || recovery) await hungGapLeg(browser);
    if (LEG === 'T' || all || recovery) await slowReadRacingAppendLeg(browser);
    if (LEG === 'U' || all || recovery) await contiguousPrefixLeg(browser);
    // BUG-278 round 11 — correlate by CONTENT (not count): a self-consistent stale
    // snapshot (total == short read / no total) that defeats the r10 reached<total
    // guard must still never wipe the current message (IV #3 run 8a0c18fa).
    if (LEG === 'V' || all || recovery) await staleSnapshotLeg(browser, 'V', 'consistent');
    if (LEG === 'W' || all || recovery) await staleSnapshotLeg(browser, 'W', 'none');
    if (LEG === 'CC' || all || recovery) await contentCorrelationLeg(browser);
    // r11 IV findings (anthropic run 2d6af6ca) reproduced as permanent regression legs.
    if (LEG === 'XS' || all || recovery) await suffixCollisionLeg(browser);
    if (LEG === 'XA' || all || recovery) await attachmentStaleLeg(browser);
    if (LEG === 'XI' || all || recovery) await identitylessStaleLeg(browser);
  }
} catch (err) {
  check('the suite ran to completion', false, String(err?.stack ?? err));
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const s of servers) stopByPid(s.pid);
  for (const p of proxies) { try { p.close(); } catch { /* */ } }
  await sleep(600);
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
}

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) { console.log(`FAILED: ${failures.join(' | ')}`); process.exitCode = 1; }
