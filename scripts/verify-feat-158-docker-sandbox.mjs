#!/usr/bin/env node
/**
 * FEAT-158 — the standing Docker sandbox and the destructive-suite guard.
 *
 *   A. Guard matrix. The real guard (`checkIsolatedDocker`) must refuse every
 *      spelling of the host daemon (unset, /var/run, /run, a `..` path, a
 *      symlink to the socket), a CLAUDE_STATION_DOCKER shim, a dead socket, and
 *      an unreadable host id; it must accept the sandbox, including when the
 *      host is masked and HOST_DOCKER_ID stands in.
 *      Non-vacuity: two constructed broken guards (none at all — what
 *      verify-feat-112 had before FEAT-158 — and a DOCKER_HOST string compare)
 *      are graded by the same matrix and must each fail rows.
 *   B. Sandbox shape: labelled container, no published TCP port, socket 0660,
 *      named volume on /var/lib/docker, daemon id stable across down/up.
 *   C. `reset` removes containers/networks/volumes in the sandbox and keeps
 *      images; the host daemon's objects are unchanged throughout.
 *   D. (round 2) The daemon lock: a second guarded suite and a `reset` from
 *      another process wait and then time out loudly (exit 3) while this suite
 *      holds the sandbox's lock, having done nothing; a SIGKILLed holder's lock
 *      is released within seconds; our own children re-enter it.
 *   Round-2 guard rows: a persisted `docker context use <sandbox>` must not
 *   make the host look like "not the host"; host masking is real (bwrap over
 *   /run/docker.sock), not a CLI-config trick.
 *
 * Needs the sandbox up (`npm run sandbox:docker -- up`) and bwrap. It takes the
 * sandbox's lock for its whole run (B cycles the container), so it waits for a
 * lane that is mid-test in the sandbox instead of disrupting it.
 */
import { spawnSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkIsolatedDocker, hostDockerEnv, daemonIdUnder, sandboxPaths, acquireDaemonLock,
  SANDBOX_CONTAINER, SANDBOX_VOLUME, SANDBOX_LABEL,
} from './lib/docker-sandbox.mjs';
import { useHostDocker } from './lib/lane-docker.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB = path.join(REPO, 'scripts/lib/docker-sandbox.mjs');
const P = sandboxPaths();
// Hold the sandbox's lock for the whole run (B cycles the container). Taken
// before `base` is built so our children inherit it and re-enter.
{
  const id0 = daemonIdUnder({ ...hostDockerEnv(), DOCKER_HOST: P.dockerHost });
  if (!id0) { console.error(`sandbox not answering at ${P.dockerHost}; run: npm run sandbox:docker -- up`); process.exit(2); }
  acquireDaemonLock(id0, { who: 'verify-feat-158-docker-sandbox', dockerHost: P.dockerHost });
}
const HOST = hostDockerEnv();
// BUG-223: this suite manages the sandbox itself (down/up/foreign down cycle its container on the
// HOST daemon), so its children take the logged opt-out; a lane's inherited sandbox mark would refuse them.
const base = useHostDocker('FEAT-158 suite cycles the sandbox container (down/up) on the host daemon', { env: { ...HOST } }); delete base.CLAUDE_STATION_DOCKER; delete base.HOST_DOCKER_ID;
const SBX = { ...base, DOCKER_HOST: P.dockerHost };
const docker = (env, args) => {
  const r = spawnSync('docker', args, { env, encoding: 'utf8', timeout: 60_000 });
  return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
};
const cli = (...args) => spawnSync(process.execPath, [path.join(REPO, 'scripts/docker-sandbox.mjs'), ...args], { env: base, encoding: 'utf8', timeout: 600_000 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
  ok ? pass++ : fail++;
}

const hostId = daemonIdUnder(HOST);
if (!hostId) { console.error('cannot read the host daemon id; this suite needs it'); process.exit(2); }
if (!daemonIdUnder(SBX)) { console.error(`sandbox not answering at ${P.dockerHost}; run: npm run sandbox:docker -- up`); process.exit(2); }

// Host baseline: everything except the self-restarting plugin swarm tasks (churn unrelated to us).
const hostSnapshot = () => ({
  c: docker(HOST, ['ps', '-a', '--format', '{{.ID}} {{.Names}}']).out.split('\n').filter((l) => l && !/-plugin\.1\./.test(l) && !l.endsWith(` ${SANDBOX_CONTAINER}`)).sort(),
  v: docker(HOST, ['volume', 'ls', '-q']).out.split('\n').filter(Boolean).sort(),
  n: docker(HOST, ['network', 'ls', '-q']).out.split('\n').filter(Boolean).sort(),
});
const before = hostSnapshot();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f158-'));
try {
  /* ---------------------------------------------------------------- A */
  console.log('\n=== A. guard matrix ===');
  const link = path.join(tmp, 'host.sock');
  fs.symlinkSync('/var/run/docker.sock', link);
  // Round 2: a persisted `docker context use <sandbox>` in the CLI config.
  const ctxCfg = path.join(tmp, 'ctx-cfg');
  fs.mkdirSync(ctxCfg);
  docker({ ...base, DOCKER_CONFIG: ctxCfg }, ['context', 'create', 'f158-sbx', '--docker', `host=${P.dockerHost}`]);
  docker({ ...base, DOCKER_CONFIG: ctxCfg }, ['context', 'use', 'f158-sbx']);
  // Real host masking: the check runs in a bwrap whose /run/docker.sock is /dev/null
  // (as a jailed lane sees it); `alias` is the real host socket at another path.
  const alias = path.join(tmp, 'alias.sock');
  fs.writeFileSync(alias, '');
  const masked = (env) => {
    const r = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-pid',
      '--bind', tmp, tmp, '--ro-bind', '/run/docker.sock', alias, '--ro-bind', '/dev/null', '/run/docker.sock',
      process.execPath, '--input-type=module', '-e',
      `const m = await import(${JSON.stringify(LIB)}); console.log(JSON.stringify(m.checkIsolatedDocker(process.env)));`],
    { env, encoding: 'utf8', timeout: 60_000 });
    try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { ok: 'bwrap-failed', reason: r.stderr }; }
  };
  const rows = [
    ['DOCKER_HOST unset', { ...base }, false],
    ['host via /var/run/docker.sock', { ...base, DOCKER_HOST: 'unix:///var/run/docker.sock' }, false],
    ['host via /run/docker.sock', { ...base, DOCKER_HOST: 'unix:///run/docker.sock' }, false],
    ['host via a ../ path', { ...base, DOCKER_HOST: 'unix:///var/run/../run/docker.sock' }, false],
    ['host via a symlink to the socket', { ...base, DOCKER_HOST: `unix://${link}` }, false],
    ['sandbox but CLAUDE_STATION_DOCKER shim set', { ...SBX, CLAUDE_STATION_DOCKER: '/usr/bin/docker' }, false],
    ['dead socket', { ...base, DOCKER_HOST: `unix://${path.join(tmp, 'none.sock')}` }, false],
    ['host via DOCKER_HOST while `docker context use` points at the sandbox', { ...base, DOCKER_CONFIG: ctxCfg, DOCKER_HOST: 'unix:///var/run/docker.sock' }, false],
    ['host via DOCKER_HOST while DOCKER_CONTEXT names the sandbox context', { ...base, DOCKER_CONFIG: ctxCfg, DOCKER_CONTEXT: 'f158-sbx', DOCKER_HOST: 'unix:///run/docker.sock' }, false],
    ['sandbox, host masked (bwrap), no HOST_DOCKER_ID', { ...SBX, masked: true }, false],
    ['host at an alias path, host masked (bwrap), HOST_DOCKER_ID given', { ...base, DOCKER_HOST: `unix://${alias}`, HOST_DOCKER_ID: hostId, masked: true }, false],
    // Round 2 (attacker a): a relative path is checked from our cwd but a child spawned elsewhere reaches another socket.
    ['sandbox via a RELATIVE unix path (means another socket in a child\'s cwd)', { ...base, DOCKER_HOST: `unix://${path.relative(process.cwd(), P.sock)}` }, false],
    // Round 3 (attacker a): whitespace the docker CLI strips skipped the unix: checks and the pin.
    ['sandbox with a leading space (the CLI strips it; the pin must not be skipped)', { ...base, DOCKER_HOST: ` ${P.dockerHost}` }, false],
    ['sandbox with a trailing newline', { ...base, DOCKER_HOST: `${P.dockerHost}\n` }, false],
    ['the sandbox', { ...SBX }, true],
    ['the sandbox, with `docker context use` pointing at the sandbox too', { ...SBX, DOCKER_CONFIG: ctxCfg }, true],
    ['sandbox, host masked (bwrap), HOST_DOCKER_ID given', { ...SBX, HOST_DOCKER_ID: hostId, masked: true }, true],
  ];
  const run1 = (guard, env) => {
    const { masked: m, ...e } = env;
    return m ? masked(e) : guard(e);
  };
  // Masked rows run the REAL guard inside bwrap; the constructed broken guards are
  // in-process functions that cannot be jailed, so they are graded on the other rows only.
  const grade = (guard) => rows.filter(([, env]) => guard === checkIsolatedDocker || !env.masked)
    .map(([name, env, want]) => ({ name, want, got: run1(guard, env).ok }));
  for (const r of grade(checkIsolatedDocker)) {
    check(`real guard: ${r.name} → ${r.want ? 'accept' : 'refuse'}`, r.got === r.want, `got ${r.got ? 'accept' : 'refuse'}`);
  }
  const broken = {
    'no guard (verify-feat-112 before FEAT-158)': () => ({ ok: true }),
    'string compare on DOCKER_HOST': (env) => ({ ok: !!env.DOCKER_HOST && env.DOCKER_HOST !== 'unix:///var/run/docker.sock' }),
    // The round-1 guard: host id read with DOCKER_CONTEXT deleted, so a persisted currentContext redirects it.
    'round-1 guard (host id via the CLI\'s current context)': (env) => {
      if (!env.DOCKER_HOST || env.CLAUDE_STATION_DOCKER) return { ok: false };
      const t = daemonIdUnder(env); if (!t) return { ok: false };
      const h = { ...env }; delete h.DOCKER_HOST; delete h.DOCKER_CONTEXT;
      const hid = daemonIdUnder(h) || (env.HOST_DOCKER_ID ?? '');
      return { ok: !!hid && hid !== t };
    },
  };
  for (const [name, g] of Object.entries(broken)) {
    const wrong = grade(g).filter((r) => r.got !== r.want).map((r) => r.name);
    check(`must-FAIL: the matrix catches a broken guard (${name})`, wrong.length > 0, `rows it gets wrong: ${JSON.stringify(wrong)}`);
  }
  // Round 2b (attacker a): an ABSOLUTE spelling that still means a different socket per process
  // (`/proc/self/cwd/..`) must be pinned to the real path the guard resolved, and handed on pinned.
  const procSelf = `unix:///proc/self/cwd/${path.relative(process.cwd(), P.sock)}`;
  const pv = checkIsolatedDocker({ ...base, DOCKER_HOST: procSelf });
  check('a /proc/self/cwd spelling is pinned: the guard checks and returns the socket\'s real path, not the per-process spelling',
    pv.ok && pv.target === `unix://${fs.realpathSync(P.sock)}`, `ok=${pv.ok} target=${pv.target ?? pv.reason}`);
  const pin = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const m = await import(${JSON.stringify(LIB)}); m.assertIsolatedDocker('f158-pin'); console.log('DH=' + process.env.DOCKER_HOST);`],
  { env: { ...base, DOCKER_HOST: procSelf }, encoding: 'utf8', timeout: 60_000 });
  check('assertIsolatedDocker rewrites DOCKER_HOST to the pinned path, so the suite\'s children inherit it', pin.status === 0 && pin.stdout.includes(`DH=unix://${fs.realpathSync(P.sock)}`),
    `exit=${pin.status} ${(pin.stdout.match(/DH=.*/) ?? [pin.stderr.trim()])[0]}`);
  // The real refusal as a suite prints it (process exit 2, text on stderr).
  const suite = spawnSync(process.execPath, [path.join(REPO, 'scripts/verify-bug-216-sweep-ownership.mjs')],
    { env: { ...base, DOCKER_HOST: 'unix:///var/run/docker.sock' }, encoding: 'utf8', timeout: 60_000 });
  check('verify-bug-216 refuses the host daemon before doing anything (exit 2)', suite.status === 2 && /REFUSED: .*IS the host daemon/.test(suite.stderr),
    `exit=${suite.status} ${suite.stderr.trim()}`);

  /* ---------------------------------------------------------------- B */
  console.log('\n=== B. sandbox shape ===');
  const insp = JSON.parse(docker(HOST, ['inspect', SANDBOX_CONTAINER]).out)[0];
  check('sandbox container carries the ownership label', insp.Config.Labels?.[SANDBOX_LABEL] === '1');
  check('sandbox container carries no claude-station label (no Orchard sweep sees it)', !Object.keys(insp.Config.Labels ?? {}).some((k) => k.startsWith('claude-station')));
  // The image EXPOSEs 2375/2376 (listed with a null binding); what matters is that none is bound to a host port.
  const bound = Object.values(insp.NetworkSettings?.Ports ?? {}).flat().filter(Boolean);
  check('no port is published to the host (Unix socket only)', bound.length === 0 && Object.keys(insp.HostConfig?.PortBindings ?? {}).length === 0,
    `exposed=${JSON.stringify(insp.NetworkSettings?.Ports ?? {})} bindings=${JSON.stringify(insp.HostConfig?.PortBindings ?? {})}`);
  const volMount = (insp.Mounts ?? []).find((m) => m.Destination === '/var/lib/docker');
  check('/var/lib/docker is the named cache volume', volMount?.Type === 'volume' && volMount?.Name === SANDBOX_VOLUME, JSON.stringify(volMount));
  const st = fs.statSync(P.sock);
  check('socket is group-only (0660) with the invoking user\'s gid', (st.mode & 0o777) === 0o660 && st.gid === process.getgid(), `mode=${(st.mode & 0o777).toString(8)} gid=${st.gid}`);
  const id1 = daemonIdUnder(SBX);
  const imgs1 = docker(SBX, ['images', '-q']).out.split('\n').filter(Boolean).length;
  const d1 = cli('down'); const u1 = cli('up', '--no-preload');
  const id2 = daemonIdUnder(SBX);
  const imgs2 = docker(SBX, ['images', '-q']).out.split('\n').filter(Boolean).length;
  check('down + up keeps the daemon identity and the image store (warm)', d1.status === 0 && u1.status === 0 && id1 === id2 && imgs2 === imgs1 && imgs1 > 0,
    `id ${id1.slice(0, 12)} → ${id2.slice(0, 12)}, images ${imgs1} → ${imgs2}`);
  const u2 = cli('up', '--no-preload');
  check('up is idempotent on a running sandbox', u2.status === 0 && /already running/.test(u2.stderr) && daemonIdUnder(SBX) === id1, u2.stderr.split('\n')[0]);
  const e = cli('env');
  check('env prints one export line naming the sandbox socket', e.status === 0 && e.stdout.trim().split('\n').length === 1 && e.stdout.startsWith(`export DOCKER_HOST=${P.dockerHost}`), e.stdout.trim());

  /* ---------------------------------------------------------------- C */
  console.log('\n=== C. reset keeps caches ===');
  docker(SBX, ['network', 'create', 'f158-net']);
  docker(SBX, ['volume', 'create', 'f158-vol']);
  docker(SBX, ['run', '-d', '--name', 'f158-c', '--network', 'f158-net', '-v', 'f158-vol:/v', 'busybox', 'sleep', '300']);
  const seeded = docker(SBX, ['ps', '-aq']).out.split('\n').filter(Boolean).length;
  const r = cli('reset');
  const after = {
    c: docker(SBX, ['ps', '-aq']).out, n: docker(SBX, ['network', 'ls', '--filter', 'type=custom', '-q']).out,
    v: docker(SBX, ['volume', 'ls', '-q']).out.split('\n').filter((x) => x && !/^buildx_buildkit_/.test(x)).join(','),
    imgs: docker(SBX, ['images', '-q']).out.split('\n').filter(Boolean).length,
  };
  check('reset removes containers, custom networks and volumes in the sandbox', r.status === 0 && seeded > 0 && !after.c && !after.n && !after.v,
    `seeded=${seeded} left c=[${after.c}] n=[${after.n}] v=[${after.v}]`);
  check('reset keeps the image store', after.imgs === imgs1, `images ${imgs1} → ${after.imgs}`);

  /* ---------------------------------------------------------------- D */
  console.log('\n=== D. the daemon lock ===');
  // A foreign process: same env minus our lock marker, so it is NOT a re-entrant child of ours.
  const foreign = { ...SBX, ORCHARD_DOCKER_LOCK_TIMEOUT: '2' }; delete foreign.ORCHARD_DOCKER_LOCK;
  const sbxCli = (env, ...a) => spawnSync(process.execPath, [path.join(REPO, 'scripts/docker-sandbox.mjs'), ...a], { env, encoding: 'utf8', timeout: 60_000 });
  docker(SBX, ['run', '-d', '--name', 'f158-live', 'busybox', 'sleep', '300']);
  const s216 = spawnSync(process.execPath, [path.join(REPO, 'scripts/verify-bug-216-sweep-ownership.mjs')], { env: foreign, encoding: 'utf8', timeout: 60_000 });
  check('a second guarded suite waits for our lock, then times out loudly (exit 3) having run nothing',
    s216.status === 3 && /WAITING: .*held by verify-feat-158/.test(s216.stderr) && /TIMED OUT/.test(s216.stderr) && !/isolated daemon/.test(s216.stdout),
    `exit=${s216.status} ${s216.stderr.trim().split('\n').slice(0, 2).join(' | ')}`);
  const rs = sbxCli(foreign, 'reset');
  const live = docker(SBX, ['ps', '-q', '--filter', 'name=f158-live']).out;
  check('a foreign `reset` waits for our lock, times out (exit 3), and removes nothing', rs.status === 3 && !!live && /TIMED OUT/.test(rs.stderr),
    `exit=${rs.status} f158-live=${live ? 'still there' : 'GONE'}`);
  const dn = sbxCli(foreign, 'down');
  check('a foreign `down` waits for our lock, times out (exit 3), and leaves the sandbox up', dn.status === 3 && !!daemonIdUnder(SBX), `exit=${dn.status}`);
  // Round 2 (attacker b): a caller with ANOTHER state dir must find the same lock (it lives beside the socket).
  const otherXdg = path.join(tmp, 'other-xdg'); fs.mkdirSync(otherXdg);
  const dnX = sbxCli({ ...foreign, XDG_STATE_HOME: otherXdg }, 'down');
  check('a foreign `down` from a shell with a different XDG_STATE_HOME still waits for our lock (exit 3), sandbox up',
    dnX.status === 3 && /WAITING/.test(dnX.stderr) && !!daemonIdUnder(SBX), `exit=${dnX.status} ${dnX.stderr.trim().split('\n')[0]}`);
  const spoof = spawnSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(LIB)}); m.acquireDaemonLock(process.argv[1], { who: 'f158-spoof', dockerHost: process.env.DOCKER_HOST }); console.log('ENTERED');`, daemonIdUnder(SBX)],
    { env: { ...foreign, ORCHARD_DOCKER_LOCK: `${path.join(path.dirname(P.sock), '.orchard-docker.lock')}\t${process.pid}\tnot-the-token` }, encoding: 'utf8', timeout: 60_000 });
  check('a spoofed ORCHARD_DOCKER_LOCK (right file, our pid as "holder", wrong token) does not re-enter', spoof.status === 3 && !/ENTERED/.test(spoof.stdout), `exit=${spoof.status}`);
  const badT = sbxCli({ ...foreign, ORCHARD_DOCKER_LOCK_TIMEOUT: 'abc' }, 'reset');
  check('an invalid ORCHARD_DOCKER_LOCK_TIMEOUT refuses with its own message (exit 3)', badT.status === 3 && /not a number of seconds/.test(badT.stderr), badT.stderr.trim().split('\n').pop());
  const ru = cli('reset');
  check('our own child re-enters the lock (reset as a child runs at once)', ru.status === 0 && !/WAITING/.test(ru.stderr), ru.stderr.trim().split('\n').pop());

  // SIGKILL, on a throwaway lock file so nothing real is held.
  const lk = path.join(tmp, 'kill.lock');
  const holdSrc = (childMs) => `const m = await import(${JSON.stringify(LIB)}); m.acquireLock(process.argv[1], { who: 'f158-holder' });
    ${childMs ? `(await import('node:child_process')).spawn('sleep', ['${childMs / 1000}'], { stdio: 'ignore' });` : ''} console.log('HELD'); setInterval(() => {}, 1e6);`;
  const waitSrc = `const m = await import(${JSON.stringify(LIB)}); const t = Date.now(); m.acquireLock(process.argv[1], { who: 'f158-waiter' }); console.log('GOT ' + (Date.now() - t));`;
  async function killRun(childMs) {
    const holder = spawn(process.execPath, ['--input-type=module', '-e', holdSrc(childMs), lk], { env: foreign, stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((res) => holder.stdout.on('data', (d) => { if (/HELD/.test(String(d))) res(); }));
    const waiter = spawn(process.execPath, ['--input-type=module', '-e', waitSrc, lk], { env: { ...foreign, ORCHARD_DOCKER_LOCK_TIMEOUT: '30' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let wOut = '', wErr = '';
    waiter.stdout.on('data', (d) => { wOut += d; }); waiter.stderr.on('data', (d) => { wErr += d; });
    await sleep(1500);
    const waitingSeen = /WAITING: .*f158-holder/.test(wErr) && !/GOT/.test(wOut);
    const tKill = Date.now();
    holder.kill('SIGKILL');
    const wCode = await new Promise((res) => waiter.on('exit', res));
    return { waitingSeen, wCode, got: /GOT/.test(wOut), took: Date.now() - tKill };
  }
  const k1 = await killRun(0);
  check('a SIGKILLed holder\'s lock is released: the waiter was blocked, then got it within 5 s of the kill',
    k1.waitingSeen && k1.wCode === 0 && k1.got && k1.took < 5000, `waitingSeen=${k1.waitingSeen} exit=${k1.wCode} released ${k1.took} ms after kill -9`);
  // Round 2 (attacker b): kill -9 of a suite must not free the daemon while its child is still at work.
  const k2 = await killRun(6000);
  check('a SIGKILLed holder whose child still works keeps the lock until the child ends (~4.5 s after the kill), then releases it',
    k2.waitingSeen && k2.wCode === 0 && k2.got && k2.took >= 3000 && k2.took < 9000, `waitingSeen=${k2.waitingSeen} exit=${k2.wCode} released ${k2.took} ms after kill -9 (child sleeps 6 s from ~1.5 s before the kill)`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

const now = hostSnapshot();
const missing = (a, b) => a.filter((x) => !b.includes(x));
const gone = { c: missing(before.c, now.c), v: missing(before.v, now.v), n: missing(before.n, now.n) };
check('host daemon: no container, volume or network went missing', !gone.c.length && !gone.v.length && !gone.n.length,
  `host containers ${before.c.length}→${now.c.length}, volumes ${before.v.length}→${now.v.length}, networks ${before.n.length}→${now.n.length}; missing=${JSON.stringify(gone)}`);

console.log(`\n${fail ? 'FAILURES' : 'ALL PASS'}: ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
