/**
 * FEAT — GPU passthrough (flag + host detection), per-project container env,
 * and a higher/settable RAM cap. Live verification.
 *
 * Two layers:
 *  1. Pure authorities imported from container-manager.ts: hostGpuAvailable()
 *     and gpuEnabled() tri-state — graded against THIS host's real state.
 *  2. A throwaway container project driven through the REAL server ensure path
 *     (PATCH settings -> POST /container/start), then `docker inspect`/`exec`
 *     to read the observed Memory, Env (PYTHONPATH) and DeviceRequests, and to
 *     print /sys/fs/cgroup/memory.max from inside the container.
 *
 * GPU is graded against THIS host's real state, read independently of the code
 * under test (`nvidia-smi -L` + `docker info` runtimes / CDI devices):
 *  - host CAPABLE  -> hostGpuAvailable ok; gpu:'on' rebuild runs and
 *                     `nvidia-smi` INSIDE the container lists the GPU; 'auto'
 *                     resolves on.
 *  - host NOT capable -> detection says not ok; a forced gpu:'on' rebuild fails
 *                     with docker's own device-driver/CDI error (flag passed,
 *                     host prereq surfaced).
 *
 *   node scripts/verify-feat-gpu-env-mem.mjs
 */
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ownerKeyFor, removeOwnedContainer, removeOwnedImages, pruneOwnedImages, refuseTakenName } from './lib/owned-docker.mjs';
import { useHostDocker } from './lib/lane-docker.mjs';

// BUG-223: GPU passthrough is graded against THIS host's real GPU/CDI state, which the
// sandbox does not have, so this suite takes the logged host opt-out. Cleanup stays
// owner-keyed (owned-docker.mjs).
useHostDocker('GPU/CDI passthrough is graded against the host GPU; the sandbox has none', { who: 'verify-feat-gpu-env-mem' });

const ROOT = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, obs) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}\n        observed: ${obs}`); ok ? pass++ : fail++; };

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

/* ---------------------------------- layer 1: pure authorities -------------- */
const cm = await import(path.join(ROOT, 'src/server/container-manager.ts'));

const host = cm.hostGpuAvailable();
console.log(`\n[host GPU probe] ok=${host.ok} reason=${JSON.stringify(host.reason)}`);
// Ground truth on this machine: driver + /dev/nvidia* present, but no
// nvidia-container-toolkit / docker nvidia runtime. So detection must say NOT ok.
const smi = spawnSync('nvidia-smi', ['-L'], { encoding: 'utf8' });
const hasHostGpu = smi.status === 0 && /GPU/.test(smi.stdout || '');
const dinfo = spawnSync('docker', ['info'], { encoding: 'utf8' }).stdout || '';
const dockerGpu = /Runtimes:.*\bnvidia\b/.test(dinfo) || /cdi: nvidia\.com\/gpu=/.test(dinfo);
const HOST_CAPABLE = hasHostGpu && dockerGpu;
console.log(`[ground truth] nvidia-smi GPU=${hasHostGpu} docker nvidia runtime/CDI=${dockerGpu} -> capable=${HOST_CAPABLE}`);
if (HOST_CAPABLE) {
  check('hostGpuAvailable TRUE on a host with a GPU and a docker nvidia runtime/CDI', host.ok === true, host.reason);
} else if (hasHostGpu) {
  check('hostGpuAvailable false when docker has no nvidia runtime/CDI', host.ok === false && /nvidia|runtime|CDI|toolkit/i.test(host.reason), host.reason);
} else {
  check('hostGpuAvailable false when no host GPU', host.ok === false, host.reason);
}

const proj = (gpu) => ({ id: 'x', settings: { container: { gpu } } });
check("gpuEnabled 'off' => false", cm.gpuEnabled(proj('off')) === false, String(cm.gpuEnabled(proj('off'))));
check("gpuEnabled 'on' => true (forced regardless of host)", cm.gpuEnabled(proj('on')) === true, String(cm.gpuEnabled(proj('on'))));
check("gpuEnabled 'auto' tracks host support", cm.gpuEnabled(proj('auto')) === host.ok, `auto=${cm.gpuEnabled(proj('auto'))} host.ok=${host.ok}`);

/* Clean-room round-8 finding: the GPU probe must never THROW into status /
 * drift / ensure — a missing or hung docker must degrade to "not passable",
 * and a gpu:'off' project must not probe the host at all. Run in a child with
 * CLAUDE_STATION_DOCKER pointing at a binary that does not exist. */
{
  const code = `
    const cm = await import(${JSON.stringify(path.join(ROOT, 'src/server/container-manager.ts'))});
    const out = {};
    for (const gpu of ['off', 'auto', 'on']) {
      const t0 = Date.now();
      try { const st = cm.statusOf({ id: 'f155probe-' + gpu, name: 'x', hostPath: '/tmp', isolation: 'container', settings: { container: { gpu } } }); out[gpu] = { ok: true, state: st.state, reason: st.gpu?.hostReason, ms: Date.now() - t0 }; }
      catch (e) { out[gpu] = { ok: false, err: String(e.message) }; }
    }
    try { out.probe = cm.hostGpuAvailable(); } catch (e) { out.probe = { threw: String(e.message) }; }
    console.log(JSON.stringify(out));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, CLAUDE_STATION_DOCKER: '/nonexistent/f155/docker' } });
  let j = null; try { j = JSON.parse(r.stdout.trim().split('\n').pop()); } catch {}
  check('with docker MISSING, statusOf never throws for gpu off/auto/on, and hostGpuAvailable returns a verdict',
    !!j && ['off', 'auto', 'on'].every((g) => j[g]?.ok === true) && typeof j.probe?.ok === 'boolean', JSON.stringify(j ?? r.stderr.slice(-400)));
  check("gpu:'off' does not consult the host probe", j?.off?.reason === 'GPU off for this project', JSON.stringify(j?.off));
}

/* Clean-room round-12: the probe runs on the server's event loop, so a slow
 * nvidia-smi (heavy GPU load) must not stall it when /dev/nvidia0 exists. */
if (fs.existsSync('/dev/nvidia0')) {
  const shim = fs.mkdtempSync(path.join(os.tmpdir(), 'f155-smi-'));
  fs.writeFileSync(path.join(shim, 'nvidia-smi'), '#!/bin/sh\nsleep 6\nexec /usr/bin/nvidia-smi "$@"\n', { mode: 0o755 });
  const code = `const cm = await import(${JSON.stringify(path.join(ROOT, 'src/server/container-manager.ts'))}); const t0 = Date.now(); const r = cm.hostGpuAvailable(); console.log(JSON.stringify({ ms: Date.now() - t0, r }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, PATH: `${shim}:${process.env.PATH}` } });
  let j = null; try { j = JSON.parse(r.stdout.trim().split('\n').pop()); } catch {}
  check('with a 6 s nvidia-smi, the GPU probe still answers in < 1 s (device node present)', !!j && j.ms < 1000 && j.r.ok === true, JSON.stringify(j ?? r.stderr.slice(-300)));
  fs.rmSync(shim, { recursive: true, force: true });
}

/* ---------------------------------- layer 2: real ensure path -------------- */
const PORT = Number(process.env.VERIFY_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-gpu-data-'));
// FEAT-158: cleanup removes only containers THIS scratch server owns (the name is a fixed slug).
const OWNER = await ownerKeyFor(DATA);
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-gpu-work-'));
fs.writeFileSync(path.join(WORK, 'README.md'), 'gpu-env-mem test\n');

const api = async (p, method = 'GET', body) => {
  const r = await fetch(BASE + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
const docker = (args) => { try { return execFileSync('docker', args, { encoding: 'utf8' }); } catch (e) { return String(e.stdout || '') + String(e.stderr || ''); } };

const server = spawn(process.execPath, [path.join(ROOT, 'src/server/index.ts')], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
  stdio: ['ignore', 'pipe', 'pipe'], detached: false,
});
server.stderr.on('data', (d) => { if (/error|throw|unhandled/i.test(String(d))) process.stderr.write(`  [server!] ${d}`); });

let cname = null;
try {
  for (let i = 0; i < 120; i++) { try { const r = await fetch(`${BASE}/api/health`); if (r.ok) break; } catch {} await sleep(250); }

  const created = await api('/api/projects', 'POST', { hostPath: WORK, name: 'GpuEnvMem', isolation: 'container' });
  if (created.status !== 201) throw new Error(`project create failed: ${JSON.stringify(created.body)}`);
  const pid = created.body.project.id;
  cname = `claude-station-${pid}`;
  refuseTakenName(cname); // FEAT-158: never adopt another instance's same-named container

  // ---- items 4 (RAM) + 5 (env), plus gpu:'off' -> no device request --------
  const MEM_MB = 16384;
  const patch = await api(`/api/projects/${pid}`, 'PATCH', { settings: { container: { memoryMb: MEM_MB, env: { PYTHONPATH: '/workspace/pylibs' }, gpu: 'off' } } });
  check('PATCH accepts memoryMb=16384 + env.PYTHONPATH + gpu=off', patch.status === 200, `status=${patch.status} ${JSON.stringify(patch.body?.error ?? '')}`);
  const cs = patch.body?.project?.settings?.container ?? {};
  check('settings persisted (gpu/env/memory)', cs.gpu === 'off' && cs.env?.PYTHONPATH === '/workspace/pylibs' && cs.memoryMb === MEM_MB, JSON.stringify(cs));

  const start = await api(`/api/projects/${pid}/container/start`, 'POST', {});
  check('POST /container/start succeeds with gpu:off', start.status === 200 && !start.body?.problem && start.body?.state === 'running', JSON.stringify({ status: start.status, state: start.body?.state, problem: start.body?.problem, error: start.body?.error }).slice(0, 300));

  const inspect = JSON.parse(docker(['inspect', cname]) || '[]')[0] ?? {};
  const memBytes = Number(inspect?.HostConfig?.Memory ?? 0);
  check('docker Memory == 16 GiB', memBytes === MEM_MB * 1024 * 1024, `${memBytes} bytes (${(memBytes / 1024 / 1024).toFixed(0)} MiB)`);
  const env = inspect?.Config?.Env ?? [];
  check('container Env carries PYTHONPATH', env.includes('PYTHONPATH=/workspace/pylibs'), env.filter((e) => e.startsWith('PYTHONPATH')).join(',') || '(none)');
  const devReqs = inspect?.HostConfig?.DeviceRequests ?? [];
  check('gpu:off => no GPU DeviceRequests', devReqs.length === 0, JSON.stringify(devReqs));

  // Observed values the user asked to see, read from INSIDE the running container:
  const cgMax = docker(['exec', cname, 'cat', '/sys/fs/cgroup/memory.max']).trim();
  console.log(`  [observed] /sys/fs/cgroup/memory.max = ${cgMax} (== ${(Number(cgMax) / 1024 / 1024 / 1024).toFixed(0)} GiB)`);
  check('cgroup memory.max reflects the 16 GiB cap', Number(cgMax) === MEM_MB * 1024 * 1024, cgMax);
  const pp = docker(['exec', cname, 'printenv', 'PYTHONPATH']).trim();
  console.log(`  [observed] PYTHONPATH inside container = ${pp}`);
  check('PYTHONPATH visible to processes inside the container', pp === '/workspace/pylibs', pp);

  // ---- item 1 (GPU): flip to 'on', prove drift + that --gpus all is passed --
  const patch2 = await api(`/api/projects/${pid}`, 'PATCH', { settings: { container: { gpu: 'on' } } });
  check('PATCH gpu=on accepted', patch2.status === 200, `status=${patch2.status}`);
  const status = await api(`/api/projects/${pid}/container/status`, 'GET');
  const drift = status.body?.driftReasons ?? [];
  check('gpu change shows as drift', status.body?.drifted === true && drift.some((r) => /gpu/i.test(r)), JSON.stringify(drift));
  check('status.gpu surfaces setting+effective+hostReason', status.body?.gpu?.setting === 'on' && typeof status.body?.gpu?.effective === 'boolean' && !!status.body?.gpu?.hostReason, JSON.stringify(status.body?.gpu));

  const rebuild = await api(`/api/projects/${pid}/container/rebuild`, 'POST', {});
  const msg = JSON.stringify({ problem: rebuild.body?.problem, error: rebuild.body?.error, state: rebuild.body?.state });
  if (HOST_CAPABLE) {
    check('gpu:on rebuild runs on a capable host', rebuild.body?.state === 'running', msg.slice(0, 400));
    const dr = JSON.parse(docker(['inspect', cname]) || '[]')[0]?.HostConfig?.DeviceRequests ?? [];
    check('gpu:on => docker DeviceRequests carries the GPU request', dr.length > 0 && JSON.stringify(dr).includes('gpu'), JSON.stringify(dr));
    const smiIn = spawnSync('docker', ['exec', cname, 'nvidia-smi'], { encoding: 'utf8' });
    console.log(`  [observed] nvidia-smi INSIDE ${cname} (exit ${smiIn.status}):\n${(smiIn.stdout || smiIn.stderr || '').split('\n').map((l) => `      ${l}`).join('\n')}`);
    check('nvidia-smi runs INSIDE the Orchard-ensured container and sees the GPU', smiIn.status === 0 && /NVIDIA|GeForce|RTX/i.test(smiIn.stdout || ''), `exit=${smiIn.status}`);
    // 'auto' on a capable host resolves ON and does not drift from the 'on' container.
    await api(`/api/projects/${pid}`, 'PATCH', { settings: { container: { gpu: 'auto' } } });
    const st2 = await api(`/api/projects/${pid}/container/status`, 'GET');
    check("gpu:'auto' on a capable host is effective ON with no drift", st2.body?.gpu?.effective === true && !(st2.body?.driftReasons ?? []).some((r) => /gpu/i.test(r)), JSON.stringify({ gpu: st2.body?.gpu, drift: st2.body?.driftReasons }));
    // Clean-room round-1 finding: REMOVING an env key must be drift, or the
    // variable lives on in the running container forever.
    await api(`/api/projects/${pid}`, 'PATCH', { settings: { container: { env: {} } } });
    const st3 = await api(`/api/projects/${pid}/container/status`, 'GET');
    check('removing container.env PYTHONPATH shows as drift', st3.body?.drifted === true && (st3.body?.driftReasons ?? []).some((r) => /env keys/.test(r)), JSON.stringify(st3.body).slice(0, 400));
    const rb3 = await api(`/api/projects/${pid}/container/rebuild`, 'POST', {});
    const ppAfter = spawnSync('docker', ['exec', cname, 'printenv', 'PYTHONPATH'], { encoding: 'utf8' });
    check('after the recreate, the removed PYTHONPATH is gone from the container', rb3.body?.state === 'running' && ppAfter.status !== 0 && !ppAfter.stdout.trim(), `state=${rb3.body?.state} printenv exit=${ppAfter.status} out=${JSON.stringify(ppAfter.stdout.trim())}`);
    const st4 = await api(`/api/projects/${pid}/container/status`, 'GET');
    check('and no lingering drift after that recreate (no loop)', !st4.body?.drifted && st4.body?.state === 'running', JSON.stringify(st4.body).slice(0, 300));
  } else {
    // --gpus all cannot succeed here. Orchard passing the flag is proven by
    // docker's OWN device-driver error surfacing through the route.
    const gpuErr = /gpu|nvidia|device driver|capabilities/i.test(msg);
    check('gpu:on passes --gpus all (host prereq surfaces as docker device-driver error)', gpuErr, msg.slice(0, 400));
  }

} catch (err) {
  check('no exception during live run', false, String(err?.stack || err));
} finally {
  if (cname) { removeOwnedContainer(cname, OWNER); }
  try { server.kill('SIGKILL'); } catch {}
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
