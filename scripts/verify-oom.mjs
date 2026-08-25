/**
 * Container OOM honesty — acceptance from the TODO: force an OOM in a
 * throwaway container with a small memoryMb and prove the UI-facing error
 * explains the memory limit in plain words rather than showing "137".
 *
 *   node scripts/verify-oom.mjs        (needs docker; runs ONE cheap haiku turn)
 *
 * How the death is staged, honestly: a real session runs in the container;
 * `tail /dev/zero` is exec'd so the KERNEL genuinely OOM-kills a process in
 * the session's cgroup (memory.events oom_kill advances — verified raw);
 * then the CLI process is SIGKILLed inside the container, which is exactly
 * what the OOM killer does to it when IT is the victim. The transport dies,
 * and the bridge must attribute the death to the memory limit.
 */
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

/* Never a fixed port: two suites defaulting to the same number collide the
   moment both run (observed: verify-ui + verify-sessions on 4319). The OS
   hands out a free one; the env var still pins it when a run needs to. */
async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const PORT = Number(process.env.VERIFY_OOM_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-oom-data-'));

let pass = 0, fail = 0;
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : fail++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000 });

let server = null;
const cleanupDirs = [];
let containerToRemove = null;

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
  for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-oom-proj-'));
  cleanupDirs.push(projDir);
  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: projDir, name: 'oom-fixture' }),
  })).json();
  const pid = reg.project?.id;
  if (!pid) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  // container isolation + the smallest allowed memory limit
  const patch = await (await fetch(`${BASE}/api/projects/${pid}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ isolation: 'container', settings: { container: { memoryMb: 512 } } }),
  })).json();
  if (patch.project?.isolation !== 'container') throw new Error(`patch failed: ${JSON.stringify(patch).slice(0, 300)}`);
  const cname = `claude-station-${pid}`;
  containerToRemove = cname;

  console.log('\n=== oom: live session in a 512 MB container ===');
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const events = [];
  let sdkSession = null;
  let turnEnded = false;
  ws.on('message', (raw) => {
    const e = JSON.parse(String(raw));
    events.push(e);
    if (e.t === 'session-init') sdkSession = e.sessionId;
    if (e.t === 'turn-end') turnEnded = true;
  });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.send(JSON.stringify({
    type: 'start', projectId: pid,
    prompt: 'Reply with exactly: OOM-CHECK-READY. Do not use any tools.',
    overrides: { model: 'haiku' },
  }));
  const t0 = Date.now();
  while (!turnEnded && Date.now() - t0 < 180_000) await sleep(300);
  check('a real session ran a turn inside the container', turnEnded && !!sdkSession,
    `sdkSession=${sdkSession}, events=${events.length}, last=${JSON.stringify(events.at(-1)?.t)}`);

  console.log('\n=== oom: the kernel really kills inside the cgroup ===');
  const kills0 = Number(/oom_kill (\d+)/.exec(docker(['exec', cname, 'cat', '/sys/fs/cgroup/memory.events']))?.[1] ?? -1);
  // tail /dev/zero grows until the cgroup limit; the kernel kills it. || true:
  // the exec's non-zero exit (137) must not throw the harness.
  try { docker(['exec', cname, 'sh', '-c', 'tail /dev/zero || true']); } catch { /* killed — expected */ }
  const kills1 = Number(/oom_kill (\d+)/.exec(docker(['exec', cname, 'cat', '/sys/fs/cgroup/memory.events']))?.[1] ?? -1);
  check('memory.events oom_kill advanced (raw cgroup evidence)', kills0 >= 0 && kills1 > kills0, `before=${kills0} after=${kills1}`);

  console.log('\n=== oom: transport death is explained in plain words ===');
  // SIGKILL the CLI inside the container — the same signal, same victim, as
  // when the OOM killer picks the CLI itself.
  // Find the session's processes the same way the server's reaper does: the
  // CLAUDE_STATION_EXEC env tag in /proc — `ps` may not exist in the image.
  const killScript = 'n=0; for p in /proc/[0-9]*; do if grep -qz "CLAUDE_STATION_EXEC=" "$p/environ" 2>/dev/null; then kill -9 "${p#/proc/}" 2>/dev/null && n=$((n+1)); fi; done; echo "$n"';
  const killed = Number(docker(['exec', cname, 'sh', '-c', killScript]).trim() || '0');
  if (!killed) throw new Error('could not find the CLI process inside the container');
  const t1 = Date.now();
  let fatal = null;
  while (!fatal && Date.now() - t1 < 30_000) {
    fatal = events.find((e) => e.t === 'error' && e.fatal === true) ?? null;
    await sleep(300);
  }
  check('a fatal error event arrived after the kill', !!fatal, JSON.stringify(fatal)?.slice(0, 300) ?? '(none)');
  check('…and it names the memory limit in plain words, not just an exit code',
    !!fatal && /memory limit/i.test(fatal.message) && /512 MB/.test(fatal.message) && /memoryMb/.test(fatal.message),
    fatal?.message?.slice(0, 220) ?? '(none)');
  const closed = events.find((e) => e.t === 'session-closed');
  check('the session was torn down with an OOM reason, not left half-alive',
    !!closed && /OOM/i.test(closed.reason ?? ''), JSON.stringify(closed));
  ws.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exitCode = 1;
}).finally(() => {
  try { if (containerToRemove) execFileSync('docker', ['rm', '-f', containerToRemove], { timeout: 30_000 }); } catch { /* not created */ }
  stopByPid(server);
  setTimeout(() => {
    fs.rmSync(DATA, { recursive: true, force: true });
    for (const d of cleanupDirs) fs.rmSync(d, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  }, 2500);
});
