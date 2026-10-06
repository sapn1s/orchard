#!/usr/bin/env node
/**
 * FEAT-158 — the standing isolated Docker sandbox.
 *
 *   npm run sandbox:docker -- up [--no-preload] [--image <ref>]...
 *   npm run sandbox:docker -- status
 *   eval "$(npm run -s sandbox:docker -- env)"
 *   npm run sandbox:docker -- reset          # containers/networks/volumes gone; images + build cache kept
 *   npm run sandbox:docker -- down [--purge] # stop + remove the container; --purge also drops the cache volume
 *   eval "$(npm run -s sandbox:docker -- host-env '<reason>')"  # BUG-223: the logged opt-out to the HOST daemon
 *
 * Shape: one `docker:dind` container (`orchard-docker-sandbox`) on the host
 * daemon, its /var/lib/docker on a named volume (warm image store and build
 * cache across restarts), its API on a Unix socket under the Orchard state dir
 * (no TCP port; the socket is group-owned by the invoking user's gid).
 *
 * Host paths a test is likely to bind-mount are mounted into the sandbox at the
 * SAME path (the tooling scratch root, /tmp, and this repo read-only), so a
 * `-v /path:/x` issued against the sandbox sees the same files it would on the
 * host. That is file access, not daemon access: a container in the sandbox can
 * still write into those host dirs, exactly as the test itself can.
 *
 * On the HOST daemon this script only ever touches: the one container named
 * `orchard-docker-sandbox` carrying label `orchard.docker-sandbox=1` (it refuses
 * a same-named container without the label), the one volume
 * `orchard-docker-sandbox-data`, and read-only `docker save` of preload images.
 * `reset` acts inside the sandbox only, after the FEAT-158 guard proves the
 * target is not the host daemon.
 *
 * `reset`, `down` and a (re)starting `up` take the sandbox daemon's exclusive
 * lock (the one a guarded suite holds for its run), so they wait for a lane
 * mid-test instead of pulling the daemon out from under it.
 */
import { spawnSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchRoot } from './lib/scratch.mjs';
import {
  SANDBOX_CONTAINER, SANDBOX_VOLUME, SANDBOX_LABEL, SANDBOX_IMAGE, SOCK_IN_CONTAINER_DIR,
  sandboxPaths, hostDockerEnv, daemonIdUnder, checkIsolatedDocker, acquireDaemonLock, acquireLock,
} from './lib/docker-sandbox.mjs';
// Importing lane-docker.mjs also applies this process's inherited declaration (DOCKER_HOST := it).
import { inheritedLaneDocker, LANE_MARK_ENV } from './lib/lane-docker.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = sandboxPaths();
/*
 * BUG-223 round 3 (ARCH-010): a process that INHERITS a sandbox declaration
 * (ORCHARD_LANE_DOCKER=<socket>) is inside a lane. Its sandbox IS the declared daemon: it
 * never re-derives one from XDG_STATE_HOME, and it never runs `up`/`down` (both act on the
 * HOST daemon). Only the top-level owner (nothing inherited, or a host/opt-out declaration)
 * manages the sandbox container.
 */
const DECL = inheritedLaneDocker(process.env);
const IN_LANE = !!DECL && (DECL.kind === 'sandbox' || DECL.kind === 'invalid');
const LANE_HOST = IN_LANE ? DECL.dockerHost : P.dockerHost;
const LANE_SOCK = LANE_HOST.startsWith('unix://') ? LANE_HOST.slice('unix://'.length) : null;
const HOST_ENV = hostDockerEnv();
const SBX_ENV = { ...hostDockerEnv(), DOCKER_HOST: LANE_HOST };
delete SBX_ENV.CLAUDE_STATION_DOCKER;

const t0 = Date.now();
const secs = (t = t0) => ((Date.now() - t) / 1000).toFixed(1) + 's';
const log = (s) => console.error(`[sandbox ${secs()}] ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(env, args, opts = {}) {
  const r = spawnSync('docker', args, { env, encoding: 'utf8', timeout: opts.timeout ?? 120_000, maxBuffer: 64 << 20 });
  return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}
const host = (args, o) => run(HOST_ENV, args, o);
const sbx = (args, o) => run(SBX_ENV, args, o);

/**
 * The host-side container record, or null. Refuses a same-named container we did
 * not create: ours carries the label AND runs a dind image. Everything after
 * acts on the returned ID, never on the name (a name can be re-used meanwhile).
 */
// The official dind image only (docker:dind, docker:29-dind, docker:29.1-dind, with or without docker.io/library/).
const OFFICIAL_DIND = /^(docker\.io\/library\/)?docker:([0-9][0-9.]*-)?dind$/;
function inspectOurs() {
  // Parsed as JSON: a label value can contain any separator (round-2b: `1|docker:29-dind` passed a split).
  const r = host(['inspect', '--type', 'container', SANDBOX_CONTAINER]);
  if (r.code !== 0) return null;
  let j;
  try { j = JSON.parse(r.out)[0]; } catch { console.error(`REFUSED: cannot parse docker inspect of ${SANDBOX_CONTAINER}`); process.exit(2); }
  const id = j.Id, status = j.State?.Status, label = j.Config?.Labels?.[SANDBOX_LABEL] ?? '', image = j.Config?.Image ?? '';
  const runDir = (j.Mounts ?? []).find((m) => m.Destination === SOCK_IN_CONTAINER_DIR)?.Source ?? '';
  // Round 5 (attacker c): an image NAME is not proof — a local image retagged `docker:29-dind` passed.
  // Ours also has our shape: privileged, our volume on /var/lib/docker, and the socket run dir bound.
  const shaped = j.HostConfig?.Privileged === true && !!runDir
    && (j.Mounts ?? []).some((m) => m.Type === 'volume' && m.Name === SANDBOX_VOLUME && m.Destination === '/var/lib/docker')
    && volumeIsOurs() === 'ours'; // round 6: the shape was forgeable on a foreign volume of our name
  if (label !== '1' || !(image === SANDBOX_IMAGE || OFFICIAL_DIND.test(image)) || !shaped) {
    console.error(`REFUSED: a container named ${SANDBOX_CONTAINER} exists on the host daemon that is not ours (label ${SANDBOX_LABEL}=${label || 'absent'}, image ${image}${shaped ? '' : ', not the sandbox shape'}). Not touching it.`);
    process.exit(2);
  }
  return { id, status, image, runDir: runDir || P.runDir };
}

/**
 * reset/down/(re)start take the sandbox's exclusive lock, the one a guarded suite
 * holds: beside the daemon socket, in the run dir the CONTAINER mounts (so a caller
 * with another XDG_STATE_HOME still finds the same lock). Re-inspects afterwards
 * and refuses if the container changed while it waited.
 */
function lockSandbox(verb, ours) {
  acquireLock(path.join(ours.runDir, '.orchard-docker.lock'), { who: `sandbox:docker ${verb}`, label: `sandbox (${ours.runDir})` });
  const now = inspectOurs();
  if (!now || now.id !== ours.id) {
    console.error(`REFUSED: ${SANDBOX_CONTAINER} changed while ${verb} waited for its lock (${ours.id.slice(0, 12)} -> ${now ? now.id.slice(0, 12) : 'gone'}). Not touching it.`);
    process.exit(2);
  }
  return now;
}

/** The sandbox volume is ours only if it carries our label (no adoption of an unlabelled volume, legacy included). */
function volumeIsOurs() {
  const v = host(['volume', 'inspect', SANDBOX_VOLUME]);
  if (v.code !== 0) return 'absent';
  let labels = {};
  try { labels = JSON.parse(v.out)[0]?.Labels ?? {}; } catch { return 'foreign'; }
  return labels[SANDBOX_LABEL] === '1' ? 'ours' : 'foreign';
}

/**
 * The run dir becomes a root dockerd's socket dir: it must be a real dir we own, not a symlink
 * to somewhere else (round-3 attacker c: a symlinked run dir let dind replace a socket there).
 * A same-uid process that swaps the path after this check and before dockerd binds it is a
 * documented limit: dockerd resolves bind sources by path.
 */
function requireRealRunDir(dir) {
  let st = null;
  try { st = fs.lstatSync(dir); } catch { /* absent */ }
  if (!st || st.isSymbolicLink() || !st.isDirectory() || st.uid !== process.getuid()) {
    console.error(`REFUSED: ${dir} must be a real directory owned by you (not a symlink) before the sandbox binds its socket there.`);
    process.exit(2);
  }
}

function sandboxReady() {
  if (LANE_SOCK && !fs.existsSync(LANE_SOCK)) return '';
  return daemonIdUnder(SBX_ENV, 5_000);
}

async function waitReady(limitMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < limitMs) {
    const id = sandboxReady();
    if (id) return id;
    await sleep(250);
  }
  return '';
}

/** Images to preload: Orchard's base for THIS tree, plus the fixtures the suites use. */
function preloadList(extra) {
  // busybox/alpine/redis: the fixtures the container suites use; the untagged
  // base is verify-feat-112's default VERIFY_F112_BASE.
  const list = ['busybox:latest', 'alpine:latest', 'redis:7-alpine', 'claude-station-base:u1000-g1000'];
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const m = await import(${JSON.stringify(path.join(REPO, 'src/server/container-manager.ts'))});
     console.log(m.imageNameFor({ id: 'sandbox-probe', name: 'sandbox-probe', path: '/nonexistent', settings: {} })); process.exit(0);`],
  { cwd: REPO, encoding: 'utf8', timeout: 30_000, env: { ...process.env, CLAUDE_STATION_DATA: path.join(P.dir, 'probe-data') } });
  const base = (probe.stdout ?? '').trim().split('\n').pop();
  if (probe.status === 0 && /^claude-station-base:/.test(base)) list.unshift(base);
  else log(`could not compute Orchard's base image tag (skipping it): ${(probe.stderr ?? '').split('\n')[0]}`);
  return [...new Set([...list, ...extra])];
}

async function preload(images) {
  for (const img of images) {
    const t = Date.now();
    if (sbx(['image', 'inspect', img]).code === 0) { log(`preload ${img}: already warm`); continue; }
    if (host(['image', 'inspect', img]).code === 0) {
      // docker save (read-only on the host) | docker load (into the sandbox)
      const ok = await new Promise((res) => {
        const save = spawn('docker', ['save', img], { env: HOST_ENV, stdio: ['ignore', 'pipe', 'inherit'] });
        const load = spawn('docker', ['load', '-q'], { env: SBX_ENV, stdio: ['pipe', 'ignore', 'inherit'] });
        save.stdout.pipe(load.stdin);
        let codes = 0; let bad = false;
        const done = (c) => { if (c !== 0) bad = true; if (++codes === 2) res(!bad); };
        save.on('exit', done); load.on('exit', done);
      });
      log(`preload ${img}: ${ok ? 'copied from host' : 'COPY FAILED'} in ${secs(t)}`);
      continue;
    }
    const r = sbx(['pull', '-q', img], { timeout: 600_000 });
    log(`preload ${img}: ${r.code === 0 ? 'pulled' : 'PULL FAILED ' + r.err.split('\n')[0]} in ${secs(t)}`);
  }
}

function mounts() {
  const paths = new Map(); // host path -> mode
  const add = (p, mode) => { try { if (p && fs.statSync(p).isDirectory() && !paths.has(p)) paths.set(p, mode); } catch { /* absent */ } };
  add(scratchRoot(), 'rw');
  add(path.join(P.stateBase, 'claude-station', 'scratch'), 'rw');
  add('/tmp', 'rw');
  add(REPO, 'ro');
  return [...paths].flatMap(([p, m]) => ['-v', `${p}:${p}:${m}`]);
}

async function up(argv) {
  const extra = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--image') extra.push(argv[++i]);
  fs.mkdirSync(P.runDir, { recursive: true });
  const ours = inspectOurs();
  if (ours?.status === 'running' && sandboxReady()) {
    log('already running');
  } else if (ours) {
    const held = lockSandbox('up', ours);
    requireRealRunDir(held.runDir); // round 6: the restart path bound a symlinked run dir unchecked
    log(`container exists (${held.status}); starting`);
    const r = host(['start', held.id]);
    if (r.code !== 0) { console.error(`start failed: ${r.err}`); process.exit(1); }
  } else {
    // Round 5 (attacker c): a creating `up` takes the lock too, so a concurrent `down --purge` cannot
    // remove the volume between our label check and `docker create` (which would auto-create it unlabelled).
    acquireLock(path.join(P.runDir, '.orchard-docker.lock'), { who: 'sandbox:docker up', label: `sandbox (${P.runDir})` });
    if (inspectOurs()) { console.error(`REFUSED: ${SANDBOX_CONTAINER} appeared while up waited for its lock. Run up again.`); process.exit(2); }
    requireRealRunDir(P.runDir); // checked after the lock (round 6), as late as a path check can be
    // Never adopt someone else's volume of this name as the privileged daemon's /var/lib/docker.
    const vol = volumeIsOurs();
    if (vol === 'foreign') {
      console.error(`REFUSED: a volume named ${SANDBOX_VOLUME} exists on the host daemon without label ${SANDBOX_LABEL}=1. It is not ours; not mounting it. Remove or rename it yourself if it is stale.`);
      process.exit(2);
    }
    if (vol === 'absent') {
      const c = host(['volume', 'create', '--label', `${SANDBOX_LABEL}=1`, SANDBOX_VOLUME]);
      if (c.code !== 0) { console.error(`volume create failed: ${c.err}`); process.exit(1); }
      // `volume create` of an existing name succeeds and returns THAT volume unchanged: re-check (round-2b race).
      if (volumeIsOurs() !== 'ours') {
        console.error(`REFUSED: ${SANDBOX_VOLUME} appeared without our label while up was creating it. Not mounting it.`);
        process.exit(2);
      }
    }
    const gid = process.getgid();
    const args = ['create', '--privileged', '--name', SANDBOX_CONTAINER,
      '--label', `${SANDBOX_LABEL}=1`, '--restart', 'unless-stopped',
      '-e', 'DOCKER_TLS_CERTDIR=',
      '-v', `${SANDBOX_VOLUME}:/var/lib/docker`,
      '-v', `${P.runDir}:${SOCK_IN_CONTAINER_DIR}`,
      ...mounts(),
      SANDBOX_IMAGE,
      'dockerd', `--host=unix://${SOCK_IN_CONTAINER_DIR}/docker.sock`, `--group=${gid}`];
    log(`creating ${SANDBOX_CONTAINER} from ${SANDBOX_IMAGE} (volume ${SANDBOX_VOLUME})`);
    const r = host(args, { timeout: 600_000 });
    if (r.code !== 0) { console.error(`create failed: ${r.err}`); process.exit(1); }
    // Check what got attached BEFORE the daemon starts writing to it (round 5: checking after `run`
    // let dockerd write into a volume swapped in meanwhile). A volume referenced by a container cannot
    // be removed, so the volume checked here is the one `start` will use.
    const made = r.out.trim();
    const mv = host(['inspect', '--format', '{{range .Mounts}}{{if eq .Destination "/var/lib/docker"}}{{.Name}}{{end}}{{end}}', made]).out;
    if (mv !== SANDBOX_VOLUME || volumeIsOurs() !== 'ours') {
      host(['rm', made]);
      console.error(`REFUSED: the sandbox was created on a volume that is not ours (${mv || 'none'}); removed the container it just made, never started.`);
      process.exit(2);
    }
    const started = host(['start', made]);
    if (started.code !== 0) { console.error(`start failed: ${started.err}`); process.exit(1); }
  }
  const cid = inspectOurs()?.id; // the verified container, for the exec fallback below (round 6: it went by name)
  const id = await waitReady();
  if (!id) { console.error(`the sandbox daemon did not answer at ${P.dockerHost}; see: docker logs ${SANDBOX_CONTAINER}`); process.exit(1); }
  const v = checkIsolatedDocker(SBX_ENV);
  if (!v.ok) { console.error(`REFUSED: the sandbox failed its own isolation check: ${v.reason}`); process.exit(1); }
  log(`daemon ready id=${id.slice(0, 12)} (host ${v.hostId.slice(0, 12)})`);
  // Pre-create the lock beside the socket, so a lane whose view of the dir is read-only can still take it.
  // If the run dir came back root-owned (Docker recreates a missing bind source as root), create it from inside.
  const lockF = path.join(P.runDir, '.orchard-docker.lock');
  if (!fs.existsSync(lockF)) {
    try { fs.closeSync(fs.openSync(lockF, 'a', 0o666)); fs.chmodSync(lockF, 0o666); } catch {
      if (cid) host(['exec', cid, 'sh', '-c', `touch ${SOCK_IN_CONTAINER_DIR}/.orchard-docker.lock && chmod 666 ${SOCK_IN_CONTAINER_DIR}/.orchard-docker.lock`]);
    }
    if (!fs.existsSync(lockF)) log(`WARNING: could not create the lock ${lockF}; guarded suites will refuse until it exists`);
  }
  if (!argv.includes('--no-preload')) await preload(preloadList(extra));
  log(`up in ${secs()}`);
  console.log(`export DOCKER_HOST=${P.dockerHost} ${LANE_MARK_ENV}=${P.dockerHost}`);
}

function env() {
  // The export line only; HOST_DOCKER_ID lets the guard work inside a room that masks the host socket.
  // It also DECLARES the daemon (ORCHARD_LANE_DOCKER), so whatever this shell launches inherits it.
  // Inside a lane the declared daemon is printed and the host is not contacted.
  const hostId = IN_LANE ? (process.env.HOST_DOCKER_ID ?? '') : daemonIdUnder(HOST_ENV);
  console.log(`export DOCKER_HOST=${LANE_HOST} ${LANE_MARK_ENV}=${LANE_HOST}${hostId ? ` HOST_DOCKER_ID=${hostId}` : ''}`);
}

/** `up`/`down` from inside a lane: never touch the host daemon (BUG-223 round 3). */
function laneRefuses(verb) {
  const why = `this process inherits ${LANE_MARK_ENV}=${DECL.raw} (it runs inside a lane whose daemon was decided at launch)`;
  if (verb === 'up') {
    const id = sandboxReady();
    if (id) {
      log(`declared daemon ${LANE_HOST} answers (id ${id.slice(0, 12)}); ${why}, so up does not manage the sandbox and does not contact the host`);
      console.log(`export DOCKER_HOST=${LANE_HOST} ${LANE_MARK_ENV}=${LANE_HOST}`);
      return 0;
    }
  }
  console.error(`REFUSED: sandbox:docker ${verb} acts on the HOST daemon, and ${why}${verb === 'up' ? ` and that daemon (${LANE_HOST}) is not answering` : ''}. The live server starts the sandbox when it launches a session. To manage it from here anyway, opt out explicitly (logged): eval "$(npm run -s sandbox:docker -- host-env '<reason>')"`);
  return 2;
}

function status() {
  if (IN_LANE) {
    const id = sandboxReady();
    console.log(JSON.stringify({ declared: `${LANE_MARK_ENV}=${DECL.raw}`, DOCKER_HOST: LANE_HOST, daemon: id ? `answers, id ${id.slice(0, 12)}` : 'not answering', container: '(not inspected: inside a lane the host daemon is not contacted)' }, null, 2));
    return;
  }
  const ours = inspectOurs();
  const id = sandboxReady();
  const v = id ? checkIsolatedDocker(SBX_ENV) : null;
  const out = {
    container: ours ? `${SANDBOX_CONTAINER} (${ours.status}, ${ours.image})` : 'absent',
    volume: host(['volume', 'inspect', SANDBOX_VOLUME]).code === 0 ? SANDBOX_VOLUME : 'absent',
    DOCKER_HOST: LANE_HOST,
    daemon: id ? `answers, id ${id.slice(0, 12)}` : 'not answering',
    isolated: v ? (v.ok ? 'yes (daemon id differs from host)' : `NO: ${v.reason}`) : 'n/a',
  };
  if (id) {
    out.images = sbx(['images', '--format', '{{.Repository}}:{{.Tag}}']).out.split('\n').filter(Boolean);
    out.containers = sbx(['ps', '-a', '--format', '{{.Names}} ({{.Status}})']).out.split('\n').filter(Boolean);
    out.disk = sbx(['system', 'df', '--format', '{{.Type}} {{.Size}} ({{.Reclaimable}} reclaimable)']).out.split('\n');
  }
  console.log(JSON.stringify(out, null, 2));
}

/**
 * One HTTP/1.1 keep-alive connection to the Docker API. Every request goes over the SAME
 * connected socket, so the daemon that answered the id check is the daemon that receives the
 * deletes: replacing the socket file after connect cannot redirect it (round 5 and round 6,
 * attacker c: two different socket swaps sent reset's deletes to the host).
 */
function pinnedDocker(sockPath) {
  const sock = net.connect(sockPath);
  let buf = Buffer.alloc(0); let wake = null; let dead = null;
  sock.on('data', (d) => { buf = Buffer.concat([buf, d]); wake?.(); });
  const fail = (e) => { dead = e || new Error('connection closed'); wake?.(); };
  sock.on('error', fail); sock.on('close', () => fail());
  const more = () => new Promise((res, rej) => { if (dead) return rej(dead); wake = () => { wake = null; res(); }; });
  const need = async (n) => { while (buf.length < n) await more(); };
  const until = async (sep) => { let i; while ((i = buf.indexOf(sep)) < 0) await more(); return i; };
  const take = (n) => { const out = buf.subarray(0, n); buf = buf.subarray(n); return out; };
  const ready = new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
  return {
    async req(method, p) {
      await ready;
      sock.write(`${method} ${p} HTTP/1.1\r\nHost: docker\r\nConnection: keep-alive\r\nContent-Length: 0\r\n\r\n`);
      const h = await until('\r\n\r\n');
      const head = take(h + 4).toString();
      const code = Number(/^HTTP\/1\.[01] (\d+)/.exec(head)?.[1] ?? 0);
      if (/\r\nconnection: *close/i.test(head)) dead = new Error('daemon closed the pinned connection');
      let body = Buffer.alloc(0);
      const len = /\r\ncontent-length: *(\d+)/i.exec(head);
      if (/\r\ntransfer-encoding: *chunked/i.test(head)) {
        for (;;) {
          const e = await until('\r\n'); const n = parseInt(take(e + 2).toString(), 16);
          await need(n + 2); const chunk = take(n + 2).subarray(0, n);
          if (n === 0) break;
          body = Buffer.concat([body, chunk]);
        }
      } else if (len) { await need(Number(len[1])); body = take(Number(len[1])); }
      const text = body.toString();
      let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
      if (code < 200 || code >= 300) throw new Error(`${method} ${p} -> ${code} ${text.slice(0, 200)}`);
      return json;
    },
    close() { sock.destroy(); },
  };
}

async function reset() {
  if (!sandboxReady()) { console.error('the sandbox is not running; nothing to reset'); process.exit(1); }
  const v = checkIsolatedDocker(SBX_ENV);
  if (!v.ok) { console.error(`REFUSED: reset would not be isolated: ${v.reason}`); process.exit(2); }
  acquireDaemonLock(v.targetId, { who: 'sandbox:docker reset', dockerHost: v.target });
  // Connect ONCE, prove on that connection that it is the daemon the guard cleared, then act on it only.
  const api = pinnedDocker(v.target.slice('unix://'.length));
  let ids = [], nets = [], vols = [];
  try {
    const info = await api.req('GET', '/info');
    if (info?.ID !== v.targetId) { console.error(`REFUSED: the daemon on reset's connection (${info?.ID ?? 'none'}) is not the one the guard checked (${v.targetId}); not touching it.`); process.exit(2); }
    ids = ((await api.req('GET', '/containers/json?all=1')) ?? []).map((c) => c.Id);
    for (const id of ids) await api.req('DELETE', `/containers/${id}?force=1`);
    nets = ((await api.req('GET', `/networks?filters=${encodeURIComponent(JSON.stringify({ type: ['custom'] }))}`)) ?? []).map((n) => n.Id);
    for (const n of nets) await api.req('DELETE', `/networks/${n}`);
    // Volumes are test state, except buildkit builder state, which IS build cache.
    vols = (((await api.req('GET', '/volumes')) ?? {}).Volumes ?? []).map((x) => x.Name).filter((n) => n && !/^buildx_buildkit_.*_state$/.test(n));
    for (const n of vols) await api.req('DELETE', `/volumes/${encodeURIComponent(n)}?force=1`);
  } catch (e) {
    console.error(`reset stopped: ${e.message}`); process.exit(1);
  } finally { api.close(); }
  log(`reset (in sandbox ${v.targetId.slice(0, 12)}): removed ${ids.length} containers, ${nets.length} networks, ${vols.length} volumes; images and build cache kept`);
}

function down(argv) {
  const purge = argv.includes('--purge');
  let ours = inspectOurs();
  if (ours) {
    ours = lockSandbox(purge ? 'down --purge' : 'down', ours);
    const r = host(['rm', '-f', ours.id]);
    log(r.code === 0 ? `removed ${SANDBOX_CONTAINER} (${ours.id.slice(0, 12)})` : `rm failed: ${r.err}`);
  } else {
    log('no sandbox container');
    // Round 5: still serialise with a creating `up` (it holds this lock from its volume check to `create`).
    if (purge) fs.mkdirSync(P.runDir, { recursive: true });
    if (purge) acquireLock(path.join(P.runDir, '.orchard-docker.lock'), { who: 'sandbox:docker down --purge', label: `sandbox (${P.runDir})` });
  }
  if (!purge) { log(`kept volume ${SANDBOX_VOLUME} (warm cache)`); return; }
  // Ownership is read at the last moment, after the container is gone (round 5: reading it before
  // the container removal left a window to swap in a foreign volume of this name).
  const vol = volumeIsOurs();
  if (vol === 'foreign') {
    console.error(`REFUSED: volume ${SANDBOX_VOLUME} has no ${SANDBOX_LABEL}=1 label. It is not ours; not removing it.`);
    process.exit(2);
  }
  if (vol === 'absent') { log('volume: absent'); return; }
  const r = host(['volume', 'rm', SANDBOX_VOLUME]);
  log(r.code === 0 ? `removed volume ${SANDBOX_VOLUME} (cache gone)` : `volume: ${r.err}`);
}

const [verb = 'status', ...rest] = process.argv.slice(2);
switch (verb) {
  case 'up': if (IN_LANE) process.exit(laneRefuses('up')); await up(rest); break;
  case 'env': env(); break;
  case 'status': status(); break;
  case 'reset': await reset(); break;
  case 'down': if (IN_LANE) process.exit(laneRefuses('down')); down(rest); break;
  // BUG-223: the shell form of the one logged way a lane reaches the HOST daemon.
  case 'host-env': {
    const { hostEnvShell } = await import('./lib/lane-docker.mjs');
    const reason = rest.join(' ').trim();
    if (!reason) { console.error('usage: eval "$(npm run -s sandbox:docker -- host-env <reason>)"  (a reason is required; the opt-out is logged)'); process.exit(64); }
    console.log(hostEnvShell(reason, 'sandbox:docker host-env'));
    break;
  }
  default: console.error('usage: sandbox:docker -- up|status|env|reset|down [--purge]|host-env <reason>'); process.exit(64);
}
