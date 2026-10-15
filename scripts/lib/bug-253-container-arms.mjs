/**
 * BUG-253 — the container arms of scripts/verify-bug-253-first-prompt-durable.mjs: the incident's own shape.
 *
 * A scratch Orchard server on the FEAT-158 Docker sandbox (never the host daemon: assertIsolatedDocker first),
 * with the FEAT-175 fake in-container CLI (ORCHARD_TEST_CONTAINER_CLI) and a pass-through docker shim
 * (CLAUDE_STATION_DOCKER) that can, for the container named in a flag file,
 *   - FAIL `docker create` (admission fails — K1), or
 *   - SLEEP before `docker create` (a slow container recreation — K2: the tab closes mid-admission).
 * Acts only on containers/images this scratch data dir owns (owner label); removes them at the end.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import { assertIsolatedDocker } from './docker-sandbox.mjs';
import { isolatedServerEnv } from './station-boot.mjs';
import { ownerKeyFor, removeOwnedContainer } from './owned-docker.mjs';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const FAKE_CLI = path.join(REPO, 'scripts', 'fixtures', 'feat-175', 'fake-container-cli.mjs');
const CLI_VERSION = '9.9.175-feat175';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runContainerArms({ check, mark, filesHolding, skip }) {
  console.log('\n--- K: container project on the Docker sandbox (the incident shape)');
  if (skip) { console.log('  NOTE  K skipped (--no-container) — the container arms did NOT run'); return; }
  let TARGET;
  try { ({ target: TARGET } = assertIsolatedDocker('verify-bug-253-first-prompt-durable')); } catch (e) {
    check('K the Docker sandbox is up (npm run sandbox:docker -- up && eval "$(npm run -s sandbox:docker -- env)")', false, String(e?.message ?? e));
    return;
  }
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'b253-ctr-'));
  const DATA = path.join(TMP, 'data');
  const HOME = path.join(TMP, 'home');
  const WORK = path.join(TMP, 'work');
  for (const d of [DATA, WORK, path.join(HOME, '.claude', 'projects')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(HOME, '.claude', '.credentials.json'), '{}\n');
  const FAIL_FLAG = path.join(TMP, 'fail-create');
  const SLOW_FLAG = path.join(TMP, 'slow-create');
  const SHIM = path.join(TMP, 'docker-shim');
  fs.writeFileSync(SHIM, `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const argv = process.argv.slice(2);
const named = (flag) => { let n = ''; try { n = fs.readFileSync(flag, 'utf8').trim(); } catch {} return n && argv.some((a) => a === n || a.startsWith(n + '-') || a.startsWith(n + '.')) ? n : ''; };
if (argv[0] === 'create' && named(${JSON.stringify(FAIL_FLAG)})) { process.stderr.write('BUG-253 injected docker create failure\\n'); process.exit(1); }
const slow = argv[0] === 'create' ? named(${JSON.stringify(SLOW_FLAG)}) : '';
const go = () => {
  const child = spawn('docker', argv, { stdio: ['inherit', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.stdout.write(d));
  child.stderr.on('data', (d) => process.stderr.write(d));
  child.on('close', (c) => process.stdout.write('', () => process.exit(c ?? 1)));
  child.on('error', (e) => { process.stderr.write(String(e.message)); process.exit(127); });
};
if (slow) setTimeout(go, 15000); else go();
`);
  fs.chmodSync(SHIM, 0o755);
  const dk = (args) => { const r = spawnSync('docker', args, { encoding: 'utf8', env: { ...process.env, DOCKER_HOST: TARGET }, timeout: 120_000 }); return { code: r.status ?? -1, out: (r.stdout ?? '').trim() }; };

  let proc = null, base = '', log = '';
  const created = new Set();
  const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const waitFor = async (pred, ms = 60_000, every = 250) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await pred(); if (v) return v; await sleep(every); } return null; };
  const api = async (p, method = 'GET', body) => { const r = await fetch(base + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json(); } catch { /* */ } return { status: r.status, body: j }; };
  const openWs = () => new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${base.split(':')[2]}/ws`);
    const events = [];
    ws.on('message', (raw) => { try { events.push(JSON.parse(String(raw))); } catch { /* */ } });
    ws.once('open', () => res({ events, send: (o) => ws.send(JSON.stringify(o)), close: () => { try { ws.close(); } catch { /* */ } } }));
    ws.once('error', rej);
    ws.on('error', () => { /* dropped */ });
  });
  const onDisk = (m) => [...filesHolding(DATA, m), ...filesHolding(path.join(HOME, '.claude', 'projects'), m)].map((f) => path.relative(TMP, f));
  try {
    const port = await freePort();
    const env = isolatedServerEnv({
      PORT: String(port), CLAUDE_STATION_DATA: DATA, DOCKER_HOST: TARGET, CLAUDE_STATION_DOCKER: SHIM,
      HOME, CLAUDE_PROJECTS_DIR: path.join(HOME, '.claude', 'projects'), ORCHARD_DISPATCH_SOCK: '',
      ORCHARD_TEST_CONTAINER_CLI: FAKE_CLI, ORCHARD_TEST_CONTAINER_CLI_VERSION: CLI_VERSION,
      CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0',
    });
    proc = spawn(process.execPath, [path.join(REPO, 'src', 'server', 'index.ts')], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', (d) => { log = (log + d).slice(-60000); });
    proc.stderr.on('data', (d) => { log = (log + d).slice(-60000); });
    spawn(process.execPath, ['-e', `const p=${process.pid},c=${proc.pid};setInterval(()=>{try{process.kill(c,0)}catch{process.exit(0)}try{process.kill(p,0)}catch{try{process.kill(c,'SIGKILL')}catch{}process.exit(0)}},1000)`], { detached: true, stdio: 'ignore' }).unref();
    base = `http://127.0.0.1:${port}`;
    const healthy = await waitFor(async () => { try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; } }, 60_000);
    if (!healthy) throw new Error(`container-arm server never healthy: ${log.slice(-1500)}`);
    await waitFor(() => /base-pin migration (done|skipped)/.test(log), 60_000);

    const register = async (name) => {
      const dir = path.join(WORK, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
      const r = await api('/api/projects', 'POST', { hostPath: dir, name: `b253-${name}`, isolation: 'container', settings: { container: { gpu: 'off' }, tools: { serena: false, playwright: false, openaiDispatch: false } } });
      const id = r.body?.project?.id;
      if (!id) throw new Error(`register ${name} failed: ${JSON.stringify(r)}`);
      const st = (await api(`/api/projects/${id}/container/status`)).body;
      const cname = st?.containerName || `claude-station-${id}`;
      created.add(cname);
      return { id, dir, cname };
    };
    const starts = async (pid) => (await api(`/api/outbox/starts?project=${encodeURIComponent(pid)}`)).body ?? { rows: [], recent: [] };

    // K1 — admission fails: `docker create` refused for this project's container.
    {
      const p = await register('k1');
      fs.writeFileSync(FAIL_FLAG, p.cname);
      const m = mark('CTR-ADMIT');
      const c = await openWs();
      c.send({ type: 'start', projectId: p.id, prompt: m, overrides: { permissionMode: 'default' } });
      const first = await waitFor(() => c.events.find((e) => (e.t === 'ack' && e.of === 'start') || (e.t === 'error' && e.fatal)), 240_000);
      c.close();
      fs.rmSync(FAIL_FLAG, { force: true });
      const row = await waitFor(async () => (await starts(p.id)).rows.find((r) => r.text === m && r.state !== 'sending') ?? null, 20_000);
      check('K1 container admission failed (docker create refused): fatal frame says kept', first?.t === 'error' && !!first.kept, { t: first?.t, kept: first?.kept, msg: String(first?.message ?? '').slice(0, 80) });
      check('K1 the dock shows it failed with its exact words; it is on disk', row?.state === 'failed' && onDisk(m).length > 0, { row: row && { state: row.state, reason: row.reason?.slice(0, 100) }, disk: onDisk(m) });
    }
    // K2 — the incident: a slow container recreation, and the tab closes while the start waits on admission.
    {
      const p = await register('k2');
      fs.writeFileSync(SLOW_FLAG, p.cname);
      const m = mark('CTR-SLOW');
      const c = await openWs();
      c.send({ type: 'start', projectId: p.id, prompt: m, overrides: { permissionMode: 'default' } });
      await sleep(4000);
      const ackedBeforeClose = c.events.some((e) => e.t === 'ack' && e.of === 'start');
      c.close();
      const fin = await waitFor(async () => {
        const v = await starts(p.id);
        const row = v.rows.find((r) => r.text === m && r.state !== 'sending');
        if (row) return { where: 'dock', state: row.state, reason: row.reason?.slice(0, 110) };
        const rec = v.recent?.find((r) => r.state === 'delivered' && r.startedAs);
        if (rec) return { where: 'delivered', startedAs: rec.startedAs };
        return null;
      }, 240_000, 1000);
      fs.rmSync(SLOW_FLAG, { force: true });
      let received = [];
      try { received = fs.readFileSync(path.join(p.dir, '.feat175-received.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => String(r.text ?? '').includes(m)); } catch { /* none */ }
      check('K2 the tab closed while the start waited on a slow container (no ack yet)', !ackedBeforeClose, { ackedBeforeClose });
      check('K2 the message is shown in the dock or delivered once — never lost; it is on disk or in the session', !!fin && (fin.where === 'dock' ? onDisk(m).length > 0 : received.length === 1),
        { fin, disk: onDisk(m), receivedInContainer: received.length });
    }
  } catch (e) {
    check('K container arms ran', false, `${e?.stack ?? e}\n  log tail: ${log.slice(-1200)}`);
  } finally {
    if (proc && proc.exitCode === null) { try { process.kill(proc.pid, 'SIGTERM'); } catch { /* */ } for (let i = 0; i < 40 && proc.exitCode === null; i++) await sleep(200); if (proc.exitCode === null) { try { process.kill(proc.pid, 'SIGKILL'); } catch { /* */ } } }
    let owner = '';
    try { owner = await ownerKeyFor(DATA); } catch { /* */ }
    for (const n of created) { try { removeOwnedContainer(n, owner); } catch { /* */ } }
    if (/^[0-9a-f]{16}$/.test(owner)) {
      for (const id of dk(['ps', '-aq', '--filter', `label=claude-station.owner=${owner}`]).out.split('\n').filter(Boolean)) dk(['rm', '-f', '-v', id]);
      for (const id of dk(['images', '-q', '--filter', `label=claude-station.owner=${owner}`]).out.split('\n').filter(Boolean)) dk(['image', 'rm', '-f', id]);
    }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
  }
}
