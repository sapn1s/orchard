/**
 * BUG-076 — Origin + Host allowlist on the WS/HTTP surface.
 *
 * The browser same-origin policy does NOT gate WebSocket *connection
 * establishment*: without a server-side check, a cross-origin attacker page can
 * open `ws://127.0.0.1:PORT/ws` and send a `start` (incl. bypassPermissions).
 * This proves the server now:
 *   1. REJECTS a WS handshake carrying a foreign Origin (must FAIL pre-fix:
 *      pre-fix the socket OPENS and the `start` command surface is reachable).
 *   2. ALLOWS a no-Origin client (the CLI / dispatch path).
 *   3. ALLOWS the same-origin dashboard Origin (http://127.0.0.1:PORT).
 *   4. REJECTS a WS handshake carrying a foreign Host (DNS-rebinding), and
 *      REJECTS a foreign-Host HTTP request while ALLOWING a localhost one.
 *
 * No Claude turn is spun up: an invalid-projectId `start` returns a JSON error
 * from the app, which is itself proof the start handler ran on the socket.
 *
 *   node scripts/verify-bug-076-ws-origin.mjs
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import WebSocket from 'ws';

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const PORT = Number(process.env.VERIFY_BUG076_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-076-data-'));

let pass = 0, fail = 0;
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : fail++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Attempt a WS handshake. Resolves { status: 'open', ws } if the handshake
 * completes, or { status: 'rejected', code } if the server refuses it.
 */
function tryConnect({ origin, host } = {}) {
  return new Promise((resolve) => {
    const opts = { headers: {} };
    if (origin !== undefined) opts.origin = origin;      // ws sets the Origin header
    if (host !== undefined) opts.headers.Host = host;    // override the default Host
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, opts);
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    ws.on('open', () => done({ status: 'open', ws }));
    ws.on('unexpected-response', (_req, res) => { try { ws.terminate(); } catch { /* */ } done({ status: 'rejected', code: res.statusCode }); });
    ws.on('error', () => done({ status: 'rejected', code: 'error' }));
    setTimeout(() => done({ status: 'timeout' }), 8000);
  });
}

/** Does the `start` command surface accept a command over this open socket? */
function probeStart(ws) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      // The app's start handler replied (here: "no project <id>") — the surface ran.
      if (m.t === 'error') done({ handled: true, message: m.message });
    });
    ws.send(JSON.stringify({ type: 'start', projectId: 'bug076-nonexistent', prompt: 'x' }));
    setTimeout(() => done({ handled: false }), 4000);
  });
}

function httpHead(hostHeader) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/health', method: 'GET',
      headers: hostHeader === undefined ? {} : { Host: hostHeader } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
}

let server = null;
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  console.log('\n=== BUG-076: Origin allowlist on the WS handshake ===');

  // 1. Foreign Origin (an attacker page) — MUST be rejected at the handshake.
  //    Pre-fix this OPENS and the start surface is reachable (the whole bug).
  const foreign = await tryConnect({ origin: 'http://evil.example.com' });
  if (foreign.status === 'open') {
    // Pre-fix path: prove the command surface really is reachable (must-FAIL evidence).
    const started = await probeStart(foreign.ws);
    try { foreign.ws.close(); } catch { /* */ }
    check('a foreign-Origin (http://evil.example.com) WS handshake is REJECTED',
      false, `handshake OPENED; start handler ran=${started.handled} (${started.message ?? ''})`);
  } else {
    check('a foreign-Origin (http://evil.example.com) WS handshake is REJECTED',
      foreign.status === 'rejected', foreign);
  }

  // 2. No Origin header (the CLI / dispatch runner) — MUST connect.
  const noOrigin = await tryConnect({});
  check('a no-Origin client (CLI / dispatch) connects', noOrigin.status === 'open', noOrigin.status);
  if (noOrigin.ws) try { noOrigin.ws.close(); } catch { /* */ }

  // 3. Same-origin dashboard Origin — MUST connect.
  const same = await tryConnect({ origin: `http://127.0.0.1:${PORT}` });
  check('the same-origin dashboard Origin (http://127.0.0.1:PORT) connects', same.status === 'open', same.status);
  if (same.ws) try { same.ws.close(); } catch { /* */ }

  console.log('\n=== BUG-076: Host allowlist (DNS-rebinding guard) ===');

  // 4a. Foreign Host on the WS upgrade — MUST be rejected.
  const foreignHostWs = await tryConnect({ host: 'attacker.rebind.example:1234' });
  check('a foreign-Host WS handshake is REJECTED', foreignHostWs.status === 'rejected', foreignHostWs);
  if (foreignHostWs.ws) try { foreignHostWs.ws.close(); } catch { /* */ }

  // 4b. Foreign Host on an HTTP request — MUST be 403; localhost Host — MUST be 200.
  const foreignHostHttp = await httpHead('attacker.rebind.example');
  check('a foreign-Host HTTP request is 403', foreignHostHttp === 403, `status ${foreignHostHttp}`);
  const localHostHttp = await httpHead(`127.0.0.1:${PORT}`);
  check('a localhost-Host HTTP request is 200', localHostHttp === 200, `status ${localHostHttp}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exitCode = 1;
}).finally(() => {
  stopByPid(server);
  setTimeout(() => {
    fs.rmSync(DATA, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  }, 1500);
});
