/**
 * FEAT-151 — the runtime routes over the REAL HTTP surface (round-2 carry-forward).
 *
 * The independent verifier could exercise the origin/content-type guards only at
 * the module level; this drives them over a booted scratch server on a free port
 * (isolatedServerEnv, which REFUSES a non-isolated env), closing that gap.
 *
 * SAFETY — the scratch server is booted from the LIVE tree, so projectRoot()
 * (import.meta.dirname-based) is the real repo. Therefore this script ONLY hits
 * paths that return BEFORE updateHostRuntime is ever reached: the read-only GET,
 * and the 403/415 guard rejections that fire before readBody / any npm spawn /
 * any package.json touch. It asserts installedSdk is byte-identical across a
 * rejected mutation to PROVE npm never ran. The "real install during a live
 * session" case needs a copy-rooted server and is covered separately (it must
 * never install into the live repo).
 *
 *   node scripts/verify-feat-151-http.mjs
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedServerEnv } from './lib/station-boot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-feat151-http-data-'));
const PROJDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-feat151-http-proj-'));

let pass = 0, fail = 0;
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${JSON.stringify(observed)}`);
  ok ? pass++ : fail++;
}
async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
async function waitHealth(port, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return true; } catch { /* not up */ }
    await sleep(250);
  }
  return false;
}

let child;
async function main() {
  const port = await freePort();
  const env = isolatedServerEnv(
    { PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: PROJDIR },
    { requireStore: true },
  );
  child = spawn(process.execPath, [ENTRY], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr?.on('data', (d) => { const s = String(d); if (/error/i.test(s)) process.stderr.write(`  [srv] ${s}`); });
  if (!(await waitHealth(port))) throw new Error(`scratch server on ${port} never became healthy`);
  const base = `http://127.0.0.1:${port}`;

  // 1. GET /api/runtime/version — read-only, 200, and the documented shape.
  const vRes = await fetch(`${base}/api/runtime/version`);
  const v = await vRes.json();
  check('GET /api/runtime/version → 200', vRes.status === 200, { status: vRes.status });
  check('payload carries host{runningSdk,installedSdk,restartPending}', v.host && 'runningSdk' in v.host && 'installedSdk' in v.host && 'restartPending' in v.host, v.host);
  check('payload carries runningCli + installedCli (the CLI half)', v.host && 'runningCli' in v.host && 'installedCli' in v.host, { runningCli: v.host?.runningCli, installedCli: v.host?.installedCli });
  check('payload carries latest{} (best-effort) and container{}', !!v.latest && !!v.container, { latest: !!v.latest, container: !!v.container });
  const installedBefore = v.host?.installedSdk;

  // 2. Cross-origin POST /api/runtime/update → 403, BEFORE any npm/body read.
  const xo = await fetch(`${base}/api/runtime/update`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
    body: JSON.stringify({ target: 'host', version: '0.3.281' }),
  });
  check('cross-origin POST /api/runtime/update → 403', xo.status === 403, { status: xo.status });

  // 3. Cross-origin POST /api/runtime/container-pin → 403 (mutation, same guard).
  const xoPin = await fetch(`${base}/api/runtime/container-pin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
    body: JSON.stringify({ version: '2.1.281' }),
  });
  check('cross-origin POST /api/runtime/container-pin → 403', xoPin.status === 403, { status: xoPin.status });

  // 4. Wrong content-type (same-origin) POST /api/runtime/update → 415, before npm.
  const wct = await fetch(`${base}/api/runtime/update`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ target: 'host', version: '0.3.281' }),
  });
  check('text/plain POST /api/runtime/update → 415', wct.status === 415, { status: wct.status });

  // 5. Prove the rejected mutations never spawned npm: installedSdk unchanged.
  const after = await (await fetch(`${base}/api/runtime/version`)).json();
  check('rejected mutations spawned NO npm (installedSdk unchanged, package.json untouched)',
    after.host?.installedSdk === installedBefore, { before: installedBefore, after: after.host?.installedSdk });

  // 6. GET does not accept a body-mutation via query and stays read-only under a
  //    foreign Origin (a browser GET carries Origin; it must still be allowed to
  //    READ — the guard is on the mutation, not the read).
  const roXo = await fetch(`${base}/api/runtime/version`, { headers: { origin: 'http://evil.example' } });
  check('GET /api/runtime/version allowed under foreign Origin (read, not mutation)', roXo.status === 200, { status: roXo.status });

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
}

main()
  .catch((e) => { console.error('FATAL', e); fail++; })
  .finally(() => {
    try { child?.kill('SIGKILL'); } catch { /* */ }
    for (const d of [DATA, PROJDIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
    process.exit(fail === 0 ? 0 : 1);
  });
