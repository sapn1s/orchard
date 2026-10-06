/**
 * FEAT-158 — the standing isolated Docker sandbox, and the guard every
 * destructive suite calls before it touches a daemon.
 *
 * WHY. BUG-216: a verifier ran Orchard's orphan sweep against the host daemon,
 * which also runs the user's live projects, and 44 containers it had not created
 * went. Every lane since has hand-built its own docker-in-docker daemon. This
 * module is the one place that says (a) where the shared sandbox lives and
 * (b) whether the daemon a suite is about to talk to is the host one.
 *
 * THE GUARD'S RULE. It compares daemon IDs, empirically, through the same
 * `docker` binary and the same environment the suite will use. Refusal is the
 * default: it concludes "isolated" only when BOTH ids were read and they
 * differ. Anything unreadable refuses (same rule as the FEAT-145 store guard: a
 * comparison failure may only ARM the guard, never disarm it).
 *
 *   - DOCKER_HOST unset             → refuse (the suite would reach the default daemon)
 *   - CLAUDE_STATION_DOCKER set      → refuse (a shim can reach any daemon)
 *   - target id unreadable           → refuse
 *   - host id unreadable             → refuse (HOST_DOCKER_ID, read outside a
 *                                      socket-masking sandbox, may stand in)
 *   - target id === host id          → refuse (any spelling of the host socket)
 *
 * "The host id" is a SET: the default context (pinned, so a persisted
 * `docker context use` cannot redirect it), each well-known host socket
 * addressed directly, and HOST_DOCKER_ID when given. A match with any refuses.
 *
 * Scope: this defends against a misdirected daemon, not a hostile `docker`
 * binary on PATH (which could answer `info` from one daemon and act on another).
 */
import { spawnSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** The one sandbox. Names are fixed so every lane finds the same one. */
export const SANDBOX_CONTAINER = 'orchard-docker-sandbox';
export const SANDBOX_VOLUME = 'orchard-docker-sandbox-data';
export const SANDBOX_LABEL = 'orchard.docker-sandbox';
/** Official image only. Pinned to the host's engine major so the CLI and daemon agree. */
export const SANDBOX_IMAGE = process.env.ORCHARD_DOCKER_SANDBOX_IMAGE || 'docker:29-dind';
/** Where the daemon's socket appears inside the sandbox container. */
export const SOCK_IN_CONTAINER_DIR = '/run/orchard-sandbox';

/** Host-side state dir: $XDG_STATE_HOME/claude-station/docker-sandbox (the socket lives in run/). */
export function sandboxPaths() {
  const stateBase = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  const dir = path.join(stateBase, 'claude-station', 'docker-sandbox');
  const runDir = path.join(dir, 'run');
  const sock = path.join(runDir, 'docker.sock');
  return { stateBase, dir, runDir, sock, dockerHost: `unix://${sock}` };
}

/**
 * Env that reaches the HOST daemon: DOCKER_HOST removed and the context pinned
 * to `default`. Deleting DOCKER_CONTEXT alone is not enough — `docker context
 * use X` persists `currentContext` in the CLI config, and a bare `docker` then
 * reaches X, not the host (FEAT-158 round 2: that let a host-targeting suite
 * read the SANDBOX's id as "the host id" and pass).
 */
export function hostDockerEnv(base = process.env) {
  const env = { ...base };
  delete env.DOCKER_HOST;
  env.DOCKER_CONTEXT = 'default';
  return env;
}

/** The well-known host daemon sockets, probed explicitly (never via the CLI's context). */
export function hostSocketCandidates(env = process.env) {
  const c = ['/run/docker.sock', '/var/run/docker.sock'];
  // rootless: $XDG_RUNTIME_DIR/docker.sock, and its usual place when that var is unset
  if (env.XDG_RUNTIME_DIR) c.push(path.join(env.XDG_RUNTIME_DIR, 'docker.sock'));
  if (typeof process.getuid === 'function') c.push(`/run/user/${process.getuid()}/docker.sock`);
  return c;
}

/** Daemon ID `docker` reaches under `env`, or '' if nothing answered. */
export function daemonIdUnder(env, timeoutMs = 15_000) {
  const r = spawnSync('docker', ['info', '--format', '{{.ID}}'], { env, encoding: 'utf8', timeout: timeoutMs });
  if (r.status !== 0) return '';
  return (r.stdout ?? '').trim();
}

/**
 * Every id that counts as "the host": the default context, each well-known
 * socket addressed directly, and HOST_DOCKER_ID. More ids can only ARM the guard.
 * Returns { ids: Set, readable: number } (readable = ids actually read from a daemon).
 */
export function hostDaemonIds(env = process.env) {
  const ids = new Set();
  const h = hostDockerEnv(env);
  const seen = new Set();
  const add = (id) => { if (id) ids.add(id); };
  add(daemonIdUnder(h));
  for (const sock of hostSocketCandidates(env)) {
    let key = sock;
    try { key = fs.realpathSync(sock); } catch { continue; } // absent
    if (seen.has(key)) continue;
    seen.add(key);
    add(daemonIdUnder({ ...h, DOCKER_HOST: `unix://${sock}` }));
  }
  const readable = ids.size;
  const given = (env.HOST_DOCKER_ID ?? '').trim();
  if (given) ids.add(given);
  return { ids, readable };
}

/**
 * Decide, without exiting. Returns { ok: true, targetId, hostId, target } or
 * { ok: false, reason }.
 */
export function checkIsolatedDocker(env = process.env) {
  let target = env.DOCKER_HOST ?? '';
  if (!target) {
    return { ok: false, reason: 'DOCKER_HOST is unset, so this would reach the host daemon. Use the sandbox: eval "$(npm run -s sandbox:docker -- env)"' };
  }
  // ALLOWLIST of forms, not a list of bad spellings (rounds 2, 2b and 3 each found a new
  // spelling: a relative path, `/proc/self/cwd/..`, leading whitespace the CLI strips).
  // Only `unix:///<absolute path>` (pinned below) or `tcp://host:port`, with nothing around them.
  if (/^unix:/i.test(target) && !/^unix:\/\/\//i.test(target)) {
    return { ok: false, reason: `DOCKER_HOST=${target} is a relative socket path; it means a different socket in every working directory. Use an absolute path.` };
  }
  if (!/^(unix:\/\/\/[^\s]+|tcp:\/\/[^\s/]+(\/)?)$/.test(target)) {
    return { ok: false, reason: `DOCKER_HOST=${JSON.stringify(target)} is not of the form unix:///<absolute socket path> or tcp://<host>:<port>, so the guard cannot pin what it points at.` };
  }
  // A tcp:// target is not pinned: under a proxy the guard can reach one daemon while a child
  // with the proxy vars stripped (the server's build env does that) dials another (round-4 attacker a).
  const proxied = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'].filter((k) => env[k]);
  if (target.startsWith('tcp://') && proxied.length) {
    return { ok: false, reason: `DOCKER_HOST=${target} is tcp:// and ${proxied.join(', ')} is set, so a child without the proxy could reach a different daemon. Use the unix socket.` };
  }
  if (env.CLAUDE_STATION_DOCKER) {
    return { ok: false, reason: `CLAUDE_STATION_DOCKER is set (${env.CLAUDE_STATION_DOCKER}); a docker shim can still reach the host daemon.` };
  }
  // Pin the socket to its real path, resolved HERE, and check (and hand on) only that.
  // An absolute spelling can still mean a different socket per process
  // (`/proc/self/cwd/..`, a symlink flipped later: round-2b attackers a and c);
  // the resolved path cannot. assertIsolatedDocker writes it back into DOCKER_HOST.
  if (target.startsWith('unix://')) {
    let real = '';
    try { real = fs.realpathSync.native(target.slice('unix://'.length)); } catch { /* unresolvable */ }
    if (!real) return { ok: false, reason: `DOCKER_HOST=${target} does not resolve to a socket.` };
    target = `unix://${real}`;
  }
  const targetId = daemonIdUnder({ ...env, DOCKER_HOST: target });
  if (!targetId) return { ok: false, reason: `no daemon answers at DOCKER_HOST=${target}. Start it: npm run sandbox:docker -- up` };
  // Inside a sandbox that masks the host socket the host id is unreadable;
  // HOST_DOCKER_ID (read outside, e.g. printed by `sandbox:docker env`) stands in.
  const { ids } = hostDaemonIds(env);
  if (!ids.size) return { ok: false, reason: `the host daemon id is unreadable, so DOCKER_HOST=${target} cannot be proven different from it (set HOST_DOCKER_ID).` };
  if (ids.has(targetId)) {
    return { ok: false, reason: `DOCKER_HOST=${target} IS the host daemon (id ${targetId.slice(0, 12)}).` };
  }
  return { ok: true, target, targetId, hostId: [...ids][0] };
}

/* ------------------------------------------------------------------ lock */
/*
 * One exclusive lock per target daemon, so two lanes never run destructive
 * work, `reset` or `down` in the same daemon at once.
 *
 * WHERE. Next to the daemon's socket (`<socket dir>/.orchard-docker.lock`),
 * because that is the one thing every lane reaching the daemon shares: flock is
 * per inode, so a symlinked or bind-mounted view of the directory locks the same
 * file, whatever the caller's XDG_STATE_HOME or HOME. (Round 1 keyed it under
 * the caller's state dir, and a lane with another XDG_STATE_HOME ran concurrently.)
 * A non-unix daemon (tcp://) uses a lock keyed by daemon id under the sandbox
 * state dir. There is no other fallback: a lock that cannot be opened refuses
 * (exit 3). `sandbox:docker up` creates the file (through the sandbox itself if
 * the run dir came back root-owned).
 *
 * HOW. A kernel flock(2) held by a helper (`flock -x … node <watcher>`). The
 * watcher follows the holder AND every descendant it has seen (by pid + start
 * time) and exits only when all are gone, so `kill -9` of a suite does not free
 * the daemon while its server child is still working in it; and when they are
 * all gone the kernel drops the flock, so no stale lock is ever left.
 *
 * RE-ENTRY. A holder's descendants re-enter (a suite running `sandbox:docker
 * down/up` as children). ORCHARD_DOCKER_LOCK carries lockfile, holder pid and a
 * random token; re-entry needs the holder to be our ancestor, the token to match
 * the holder's info file, and the lock to be held right now.
 *
 * Not defended (deliberate sabotage): killing the watcher, or deleting the lock
 * file while it is held.
 */
const LOCK_ENV = 'ORCHARD_DOCKER_LOCK';
const LOCK_NAME = '.orchard-docker.lock';
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Fallback lock path, keyed by daemon id (tcp:// daemons). */
export function lockPathFor(daemonId) {
  return path.join(sandboxPaths().dir, 'locks', `${daemonId}.lock`);
}

/** The lock file for a unix socket: beside it, in its (real) directory. '' if not a unix socket. */
export function lockPathForSocket(dockerHost) {
  const m = /^unix:\/\/(\/.*)$/i.exec(dockerHost ?? '');
  if (!m) return '';
  let dir = path.dirname(m[1]);
  try { dir = path.dirname(fs.realpathSync.native(m[1])); } catch { /* use as given */ }
  return path.join(dir, LOCK_NAME);
}

function ensureLockFile(file) {
  try {
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.closeSync(fs.openSync(file, 'a', 0o666));
      try { fs.chmodSync(file, 0o666); } catch { /* not ours to chmod */ }
    }
    fs.closeSync(fs.openSync(file, 'r'));
    return true;
  } catch { return false; }
}

function procStat(pid) {
  try {
    const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
    return { state: f[0], ppid: Number(f[1]), start: f[19] };
  } catch { return null; }
}
function isAncestor(pid) {
  for (let p = process.pid, n = 0; p > 1 && n < 64; p = procStat(p)?.ppid ?? 0, n++) if (p === pid) return true;
  return false;
}
function readInfo(lockFile) {
  try { return JSON.parse(fs.readFileSync(`${lockFile}.info`, 'utf8')); } catch { return null; }
}
function holderInfo(lockFile) {
  const i = readInfo(lockFile);
  return i ? `${i.who} (pid ${i.pid}, since ${i.since})` : 'another process (no holder info)';
}
function sameFile(a, b) {
  try { const x = fs.statSync(a), y = fs.statSync(b); return x.ino === y.ino && x.dev === y.dev; } catch { return false; }
}
function lockHeldNow(lockFile) {
  return spawnSync('flock', ['-n', lockFile, 'true'], { stdio: 'ignore' }).status === 1;
}

/*
 * The watcher, run by `flock` once it holds the lock. argv: holderPid markFile.
 * Tracks the holder and all descendants seen (pid + start time); exits when none live.
 * Excludes its own chain (flock = its parent), which also descends from the holder.
 */
const WATCHER = String.raw`
const fs = require('node:fs');
const [holder, mark] = process.argv.slice(1);
const stat = (pid) => { try { const s = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'); const f = s.slice(s.lastIndexOf(')') + 2).split(' '); return { state: f[0], start: f[19] }; } catch { return null; } };
const kids = (pid) => { let out = []; try { for (const t of fs.readdirSync('/proc/' + pid + '/task')) { try { out = out.concat(fs.readFileSync('/proc/' + pid + '/task/' + t + '/children', 'utf8').trim().split(/\s+/).filter(Boolean)); } catch {} } } catch {} return out; };
const skip = new Set([String(process.pid), String(process.ppid)]);
const live = new Map();
const h = stat(holder); if (!h) process.exit(0);
live.set(String(holder), h.start);
fs.writeFileSync(mark, 'ok');
const tick = () => {
  for (const [pid, start] of [...live]) {
    const s = stat(pid);
    if (!s || s.start !== start || s.state === 'Z') { live.delete(pid); continue; }
    for (const k of kids(pid)) if (!skip.has(k) && !live.has(k)) { const ks = stat(k); if (ks) live.set(k, ks.start); }
  }
  if (!live.size) process.exit(0);
};
setInterval(tick, 100);
`;

/**
 * Take the exclusive lock `lockFile`, waiting up to `timeoutSec`
 * (ORCHARD_DOCKER_LOCK_TIMEOUT, default 1800). Exits 3 on timeout or when the
 * lock cannot be taken. Re-entrant for the holder's descendants.
 */
export function acquireLock(lockFile, { who = path.basename(process.argv[1] ?? 'unknown'), timeoutSec, label = lockFile } = {}) {
  const envT = (process.env.ORCHARD_DOCKER_LOCK_TIMEOUT ?? '').trim();
  const raw = timeoutSec ?? (envT === '' ? 1800 : envT);
  const tSec = Number(raw);
  if (!Number.isFinite(tSec) || tSec < 0 || tSec > 1e7) {
    console.error(`REFUSED: ORCHARD_DOCKER_LOCK_TIMEOUT=${JSON.stringify(String(raw))} is not a number of seconds from 0 to 1e7. Not running.`);
    process.exit(3);
  }
  if (!ensureLockFile(lockFile)) {
    console.error(`REFUSED: ${who} cannot open the Docker daemon lock ${lockFile}, so it cannot exclude other lanes. Not running.`);
    process.exit(3);
  }
  const [hFile, hPid, hTok] = (process.env[LOCK_ENV] ?? '').split('\t');
  const info = readInfo(lockFile);
  if (hFile && sameFile(hFile, lockFile) && hTok && info?.token === hTok && info?.pid === Number(hPid) && isAncestor(Number(hPid)) && lockHeldNow(lockFile)) {
    return { lockFile, reentrant: true };
  }

  const markDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchard-lock-'));
  const mark = path.join(markDir, 'state');
  const child = spawn('flock', ['-x', '-w', String(tSec), lockFile, process.execPath, '-e', WATCHER, String(process.pid), mark], {
    stdio: 'ignore',
    detached: true, // own process group, so our exit can release it at once (kill -pgid)
  });
  child.unref();
  const start = Date.now();
  let told = 0;
  const done = (code, msg) => { fs.rmSync(markDir, { recursive: true, force: true }); if (msg) console.error(msg); if (code != null) process.exit(code); };
  for (;;) {
    let st = '';
    try { st = fs.readFileSync(mark, 'utf8').trim(); } catch { /* not yet */ }
    if (st === 'ok') break;
    const cs = child.pid ? procStat(child.pid) : null;
    if (!cs || cs.state === 'Z') {
      try { st = fs.readFileSync(mark, 'utf8').trim(); } catch { /* none */ }
      if (st === 'ok') break;
      done(3, `TIMED OUT: ${who} waited ${((Date.now() - start) / 1000).toFixed(0)}s (limit ${tSec}s) for the Docker daemon lock ${label}, still held by ${holderInfo(lockFile)}. Not running.`);
    }
    const waited = Date.now() - start;
    if (waited > 400 && (told === 0 || waited - told >= 30_000)) {
      console.error(`WAITING: the Docker daemon lock ${label} is held by ${holderInfo(lockFile)}; ${who} waits (timeout ${tSec}s, ORCHARD_DOCKER_LOCK_TIMEOUT).`);
      told = waited;
    }
    if (waited > (tSec + 10) * 1000) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
      done(3, `TIMED OUT: the lock helper for ${lockFile} never answered. Not running.`);
    }
    sleepSync(100);
  }
  done(null);
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    fs.rmSync(`${lockFile}.info`, { force: true });
    fs.writeFileSync(`${lockFile}.info`, JSON.stringify({ who, pid: process.pid, token, since: new Date().toISOString(), cmd: process.argv.slice(1).join(' ') }), { mode: 0o600 });
  } catch { /* read-only: holder info is advisory, and re-entry then fails safe (waits) */ }
  process.env[LOCK_ENV] = `${lockFile}\t${process.pid}\t${token}`;
  process.on('exit', () => {
    if (readInfo(lockFile)?.token === token) { try { fs.rmSync(`${lockFile}.info`, { force: true }); } catch { /* ok */ } }
    // Release now if no child of ours is still at work; otherwise the watcher holds it until they finish.
    const mine = fs.existsSync(`/proc/${process.pid}/task`) ? fs.readdirSync(`/proc/${process.pid}/task`).some((t) => {
      try { return fs.readFileSync(`/proc/${process.pid}/task/${t}/children`, 'utf8').trim().split(/\s+/).filter((k) => k && Number(k) !== child.pid).length > 0; } catch { return false; }
    }) : false;
    if (!mine) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } }
  });
  return { lockFile, reentrant: false, helperPid: child.pid };
}

/** The lock for a daemon: beside its unix socket when that dir is usable, else keyed by its id. */
export function acquireDaemonLock(daemonId, { who, timeoutSec, dockerHost = process.env.DOCKER_HOST } = {}) {
  // A unix socket's lock is beside it, or nowhere: falling back to a per-caller path
  // would let a lane with another XDG_STATE_HOME in at the same time (round-3 attacker b).
  // acquireLock refuses (exit 3) when it cannot be opened. Only tcp:// and the like use the id-keyed path.
  const beside = lockPathForSocket(dockerHost);
  const file = beside || lockPathFor(daemonId);
  return acquireLock(file, { who, timeoutSec, label: `${daemonId.slice(0, 12)} (${file})` });
}

/**
 * The guard a destructive suite calls FIRST. Refuses (prints `REFUSED: …`,
 * exits 2) unless the effective daemon is provably not the host one, then
 * takes that daemon's exclusive lock (waits, or exits 3 at the timeout) and
 * re-checks that the daemon it now holds is the one it checked.
 */
export function assertIsolatedDocker(suite = path.basename(process.argv[1] ?? 'this suite'), env = process.env) {
  const v = checkIsolatedDocker(env);
  if (!v.ok) {
    console.error(`REFUSED: ${suite} removes Docker objects and must not run against the host daemon. ${v.reason}`);
    process.exit(2);
  }
  // From here on the suite and every child it spawns with this env use the pinned path.
  env.DOCKER_HOST = v.target;
  acquireDaemonLock(v.targetId, { who: suite, dockerHost: v.target });
  const again = checkIsolatedDocker(env);
  if (!again.ok || again.targetId !== v.targetId) {
    console.error(`REFUSED: ${suite}: the daemon at ${v.target} changed while waiting for its lock (${again.ok ? `now id ${again.targetId.slice(0, 12)}` : again.reason}).`);
    process.exit(2);
  }
  console.log(`isolated daemon ${v.target} id=${v.targetId.slice(0, 12)} (host id=${v.hostId.slice(0, 12)}), lock held`);
  return v;
}
