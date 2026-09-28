/**
 * BUG-187 — shared harness for the responderless-CLI verifier arms.
 *
 * Every server it boots is ISOLATED (station-boot.mjs: its own free port, a
 * scratch CLAUDE_STATION_DATA and CLAUDE_PROJECTS_DIR) and every process it
 * starts is killed BY PID. Brokers of an isolated server live in
 * `claude-station-host-t-*` scopes and are reaped by pid from the scratch
 * hosts dir. Port 4317, the real service and any scope not ours are never
 * touched.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import { isolatedServerEnv, isolatedStoreEnv } from './station-boot.mjs';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const FAKE_CLI = path.join(ROOT, 'scripts', 'fixtures', 'bug-187', 'fake-cli.mjs');
export const REAL_CLI = path.join(ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-linux-x64', 'claude');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const pidAlive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

export async function freePort() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

export function mkScratch(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `b187-${prefix}-`));
}

/** A result recorder with named, behavioural checks. */
export function makeChecker(label) {
  const results = [];
  return {
    results,
    check(name, ok, observed) {
      const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${label}] ${name}\n        observed: ${line}`);
      results.push({ arm: label, name, ok: !!ok, observed: line });
      return !!ok;
    },
    note(msg) { console.log(`  NOTE  [${label}] ${msg}`); },
  };
}

/**
 * One isolated test world: data dir, store, project cwd, fake-CLI dirs.
 * `tree` = the source tree whose server to run (ROOT, or a pinned tree).
 */
export function makeWorld(name, { tree = ROOT, real = false } = {}) {
  const base = mkScratch(name);
  const w = {
    name,
    tree,
    base,
    data: path.join(base, 'data'),
    store: path.join(base, 'store'),
    work: path.join(base, 'work'),
    cmd: path.join(base, 'cmd'),
    log: path.join(base, 'fake.log'),
    tap: path.join(base, 'fake.tap'),
    servers: [],
    real,
  };
  for (const d of [w.data, w.store, w.work, w.cmd]) fs.mkdirSync(d, { recursive: true });
  return w;
}

/**
 * Boot an isolated server for this world. `env` adds knobs. The fake CLI is
 * used unless the world is `real`.
 */
export async function bootServer(w, env = {}, { port } = {}) {
  const p = port ?? await freePort();
  const storeEnv = w.real ? isolatedStoreEnv(path.join(w.base, 'claude-config'), { alsoReader: true }) : { CLAUDE_PROJECTS_DIR: w.store };
  const full = isolatedServerEnv({
    PORT: String(p),
    CLAUDE_STATION_DATA: w.data,
    ...storeEnv,
    ...(w.real ? {} : { CLAUDE_STATION_CLAUDE_BIN: FAKE_CLI }),
    FAKE_CMD_DIR: w.cmd,
    FAKE_LOG: w.log,
    FAKE_TAP: w.tap,
    CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0',
    ...env,
  });
  const proc = spawn(process.execPath, [path.join(w.tree, 'src', 'server', 'index.ts')], {
    cwd: w.tree, env: full, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const srv = { port: p, proc, log: '' };
  proc.stdout.on('data', (d) => { srv.log += String(d); });
  proc.stderr.on('data', (d) => { srv.log += String(d); });
  w.servers.push(srv);
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(`http://127.0.0.1:${p}/api/health`); if (r.ok) return srv; } catch { /* not yet */ }
    if (proc.exitCode !== null) throw new Error(`server exited early (${proc.exitCode}): ${srv.log.slice(-2000)}`);
    await sleep(250);
  }
  throw new Error(`server never became healthy: ${srv.log.slice(-2000)}`);
}

/** SIGTERM a server (what systemd's restart sends) and wait for it to exit. */
export async function stopServer(srv, signal = 'SIGTERM') {
  if (!srv?.proc || srv.proc.exitCode !== null) return;
  try { process.kill(srv.proc.pid, signal); } catch { /* gone */ }
  for (let i = 0; i < 80 && pidAlive(srv.proc.pid); i++) await sleep(250);
  if (pidAlive(srv.proc.pid)) { try { process.kill(srv.proc.pid, 'SIGKILL'); } catch { /* gone */ } }
  await sleep(300);
}

export async function registerProject(srv, w) {
  const r = await (await fetch(`http://127.0.0.1:${srv.port}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: w.work, name: `b187-${w.name}`, isolation: 'direct' }),
  })).json();
  const id = r.project?.id;
  if (!id) throw new Error(`register failed: ${JSON.stringify(r)}`);
  return id;
}

export function openWs(srv) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
    const events = [];
    ws.on('message', (raw) => { try { events.push({ at: Date.now(), ...JSON.parse(String(raw)) }); } catch { /* ignore */ } });
    ws.once('open', () => res({ ws, events, send: (o) => ws.send(JSON.stringify(o)), close: () => { try { ws.close(); } catch { /* ignore */ } } }));
    ws.once('error', rej);
    ws.on('error', () => { /* a killed server drops the socket */ });
  });
}

export async function waitFor(pred, ms = 30_000, every = 200) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await pred();
    if (v) return v;
    await sleep(every);
  }
  return null;
}

export const waitEv = (c, pred, ms = 60_000) => waitFor(() => c.events.find(pred), ms);

export function hostsDir(w) { return path.join(w.data, 'session-hosts'); }
export function hostRecords(w) {
  try {
    return fs.readdirSync(hostsDir(w))
      .filter((f) => f.endsWith('.json') && !f.endsWith('.ctl.json') && !f.endsWith('.ended.json'))
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(hostsDir(w), f), 'utf8')); } catch { return null; } })
      .filter((x) => x && Number.isInteger(x.hostPid));
  } catch { return []; }
}
export const hostFor = (w, station) => hostRecords(w).find((h) => h.stationSessionId === station) ?? null;

/** Queue one command for a fake CLI (by its pid). */
let cmdSeq = 0;
export function fakeCmd(w, pid, obj) {
  const dir = path.join(w.cmd, String(pid));
  fs.mkdirSync(dir, { recursive: true });
  const n = String(++cmdSeq).padStart(5, '0');
  fs.writeFileSync(path.join(dir, `${n}.tmp`), JSON.stringify(obj));
  fs.renameSync(path.join(dir, `${n}.tmp`), path.join(dir, `${n}.json`));
}
/** Every event the fake with this pid logged. */
export function fakeLog(w, pid) {
  try {
    return fs.readFileSync(`${w.log}.${pid}`, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
/** Every stdin line the fake with this pid read (the stdin tap). */
export function fakeTap(w, pid) {
  try {
    return fs.readFileSync(`${w.tap}.${pid}`, 'utf8').split('\n').filter(Boolean).map((l) => { try { const o = JSON.parse(l); return { at: o.at, m: JSON.parse(o.line) }; } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** Start a fake-CLI session; resolves { c, station, host, cli }. */
export async function startFakeSession(srv, w, projectId, prompt = 'hello', extra = {}) {
  let c = null;
  let ack = null;
  // FEAT-151: a fresh server refuses host sessions until its boot runtime check
  // completes ("runtime check pending") — retry on exactly that refusal.
  for (let attempt = 0; attempt < 40 && !ack; attempt++) {
    c = await openWs(srv);
    c.send({ type: 'start', projectId, prompt, ...extra, overrides: { permissionMode: 'default', ...(extra.overrides ?? {}) } });
    ack = await waitFor(() => {
      const a = c.events.find((e) => e.t === 'ack' && e.of === 'start');
      if (a) return a;
      // BUG-190 round 4 sibling: retry on the server's structured code only — a
      // substring would also match a fatal "… while checking runtime …" error.
      if (c.events.some((e) => e.t === 'error' && e.code === 'runtime-check-pending')) return 'retry';
      return null;
    }, 60_000);
    if (ack === 'retry') { ack = null; c.close(); await sleep(1500); }
  }
  if (!ack) throw new Error(`start never acked: ${JSON.stringify(c?.events.slice(-5))}`);
  const station = ack.stationSessionId;
  const host = await waitFor(() => { const h = hostFor(w, station); return h && h.claudePid ? h : null; }, 20_000);
  if (!host) throw new Error('no broker record for the session');
  return { c, station, host, cli: host.claudePid };
}

export async function health(srv) {
  try { return await (await fetch(`http://127.0.0.1:${srv.port}/api/health`)).json(); } catch { return null; }
}

/** Kill everything a world spawned: servers, then every broker + CLI in its hosts dir. */
export async function cleanupWorld(w, { keep = false } = {}) {
  for (const s of w.servers) { try { if (s.proc.exitCode === null) process.kill(s.proc.pid, 'SIGKILL'); } catch { /* gone */ } }
  for (const h of hostRecords(w)) {
    for (const p of [h.claudePid, h.hostPid]) if (p && pidAlive(p)) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  }
  // Brokers whose record is gone but whose control file names a pid-less state: nothing more to do.
  await sleep(300);
  if (!keep) { try { fs.rmSync(w.base, { recursive: true, force: true }); } catch { /* ignore */ } }
}

/**
 * Spawn a broker DIRECTLY into a world's hosts dir, as if a prior server had
 * created it (the owner is this harness process — alive, isolated — so the
 * BUG-114 orphan bound never fires). `hostScript` picks the broker code: this
 * tree's, or a PINNED tree's (an "old broker" still running old JS after a
 * deploy). The broker runs in `cwd` (the project dir), which is how a server
 * finds the project of a record that carries no projectId.
 */
export function spawnBrokerDirect(w, { hostScript, command, args, env = {}, stationSessionId, cwd = w.work, key }) {
  const dir = path.join(w.data, 'session-hosts');
  fs.mkdirSync(dir, { recursive: true });
  const k = key ?? `t-direct-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  let pidStart = null;
  try { const st = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8'); pidStart = st.slice(st.lastIndexOf(')') + 2).split(' ')[19] ?? null; } catch { /* ignore */ }
  const owner = { mode: 'isolated', dataDir: w.data, port: 0, pid: process.pid, pidStart, startedAt: new Date().toISOString() };
  const ctl = path.join(dir, `${k}.ctl.json`);
  fs.writeFileSync(ctl, JSON.stringify({
    sock: path.join(dir, `${k}.sock`), status: path.join(dir, `${k}.json`), errlog: path.join(dir, `${k}.err`),
    command, args, owner, meta: { stationSessionId, resumeHint: null, owner },
  }));
  const proc = spawn(process.execPath, [hostScript, ctl], {
    cwd, env: { ...process.env, FAKE_CMD_DIR: w.cmd, FAKE_LOG: w.log, FAKE_TAP: w.tap, ...env }, stdio: ['ignore', 'ignore', 'ignore'], detached: true,
  });
  proc.unref();
  return { key: k, statusPath: path.join(dir, `${k}.json`), sock: path.join(dir, `${k}.sock`), proc };
}

/** A raw client on a broker socket: every line it receives, and writers. */
export function rawClient(sock) {
  return new Promise((res, rej) => {
    const s = net.connect(sock);
    const lines = [];
    let buf = '';
    s.on('data', (d) => {
      buf += String(d);
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, nl); buf = buf.slice(nl + 1); try { lines.push({ at: Date.now(), m: JSON.parse(l) }); } catch { lines.push({ at: Date.now(), raw: l }); } }
    });
    s.once('connect', () => res({
      s, lines,
      write: (o) => s.write(`${JSON.stringify(o)}\n`),
      writeRaw: (t) => s.write(t),
      close: () => { try { s.destroy(); } catch { /* ignore */ } },
      closed: () => s.destroyed,
    }));
    s.once('error', rej);
    s.on('error', () => { /* settled */ });
  });
}

export function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

/** A minimal Claude-store transcript so the dashboard can list and open a session the fake CLI never wrote. */
export function writeSyntheticTranscript(w, sdkId, lines = ['synthetic session for the BUG-187 browser arm']) {
  const enc = w.work.replace(/[^a-zA-Z0-9]/g, '-');
  const dir = path.join(w.store, enc);
  fs.mkdirSync(dir, { recursive: true });
  const t = Date.now();
  const rows = [];
  lines.forEach((text, i) => {
    rows.push({ type: 'user', uuid: `u-${sdkId}-${i}`, parentUuid: i ? `a-${sdkId}-${i - 1}` : null, sessionId: sdkId, cwd: w.work, timestamp: new Date(t - 60_000 + i * 2000).toISOString(), message: { role: 'user', content: text } });
    rows.push({ type: 'assistant', uuid: `a-${sdkId}-${i}`, parentUuid: `u-${sdkId}-${i}`, sessionId: sdkId, cwd: w.work, timestamp: new Date(t - 59_000 + i * 2000).toISOString(), message: { role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: `ack: ${text}` }] } });
  });
  fs.writeFileSync(path.join(dir, `${sdkId}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return path.join(dir, `${sdkId}.jsonl`);
}
