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
import * as net from 'node:net';
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

/* ------------------------------------------------------ data-root relocation
 * The dind daemon's /var/lib/docker (its whole image store + build cache) lives,
 * by default, in the named volume orchard-docker-sandbox-data under the HOST
 * Docker data-root (typically / — an SSD). That store grows without bound (one
 * ~2.9 GB claude-station-rt image per CLI build, one ~2.6 GB confined-run image
 * per distinct dependency tree) and can reach 100+ GB. `sandboxDataRoot()` lets
 * it be moved onto another filesystem (e.g. a roomy HDD) by BIND-BACKING that
 * same named volume with a host directory, so none of the FEAT-158 ownership
 * checks (which key on the volume's NAME and label, not its backing dir) change.
 */
/**
 * Filesystems whose overlay2/overlayfs the dind daemon can use — an ALLOWLIST,
 * not a denylist of bad names. Anything NOT in this set (ntfs, exfat, vfat, fuse,
 * overlay-on-overlay, or an UNDETECTABLE filesystem) is refused: the check fails
 * CLOSED, because a store the daemon cannot back is as bad whether we recognised
 * the filesystem or not.
 */
export const DIND_OK_FS = new Set(['ext4', 'xfs', 'btrfs']);
export const SANDBOX_DATA_ENV = 'ORCHARD_DOCKER_SANDBOX_DATA';
export const SANDBOX_DATA_BASE_ENV = 'ORCHARD_DOCKER_SANDBOX_DATA_BASE';
export const DEFAULT_SANDBOX_DATA_BASE = '/backups';
/** The dedicated dir name the dind store must live in (keeps device= off host/system paths). */
export const SANDBOX_DATA_DIRNAME = 'orchard-docker-sandbox';
const MIN_DATA_FREE_GB = 20;

/* ---------------------------------------------- size-watermark store bound
 * BUG-289 round 3 (OpenAI consult): the sandbox store is bounded BY BYTES and by a
 * host free-space FLOOR, never by age. `pruneSandboxToCap` evicts UNUSED images
 * least-recently-tagged/used first until the store (dedup image layers + build
 * cache) is under the cap AND host free space on the store's filesystem is above
 * the floor. Age tells us nothing about one busy day's growth (a 7-day age prune
 * could not shrink a store that filled in hours), and summed image size overcounts
 * shared layers — so the bound is LayersSize (dedup) + build cache, in bytes.
 */
export const DEFAULT_SANDBOX_CAP_GB = 40;
export const DEFAULT_SANDBOX_FLOOR_GB = 50;
export const SANDBOX_CAP_ENV = 'ORCHARD_DOCKER_SANDBOX_CAP_GB';
export const SANDBOX_FLOOR_ENV = 'ORCHARD_DOCKER_SANDBOX_FLOOR_GB';
const GiB = 2 ** 30;
function gbFromEnv(env, name, dflt) {
  const raw = (env[name] ?? '').trim();
  if (raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name}=${JSON.stringify(raw)} must be a positive number of GB`);
  return n;
}
export const sandboxCapGb = (env = process.env) => gbFromEnv(env, SANDBOX_CAP_ENV, DEFAULT_SANDBOX_CAP_GB);
export const sandboxFloorGb = (env = process.env) => gbFromEnv(env, SANDBOX_FLOOR_ENV, DEFAULT_SANDBOX_FLOOR_GB);

/**
 * Resolve `input` to the REAL absolute path where the data will actually land,
 * EXACTLY as the kernel would: component by component, following every symlink —
 * including a DANGLING one — and NEVER collapsing `..` lexically before the
 * symlinks on the way are expanded (path.resolve() does collapse it, so
 * `<ok-fs>/lnk/../data` with lnk->other-fs was graded on <ok-fs> but the kernel,
 * following lnk first, lands it on other-fs — round-2 openai finding). The tail
 * may not exist yet (the store is mkdir -p'd there); nothing under an absent
 * directory can be a symlink, so the remainder is joined literally. THROWS on a
 * symlink loop or an unreadable symlink, so a path we cannot pin down never passes.
 * The returned path is what both the fs grade AND the bind-mount device= must use.
 */
export function resolveDataPath(input) {
  const abs = path.isAbsolute(input) ? input : `${process.cwd()}/${input}`;
  const queue = abs.split('/').filter(Boolean);
  let cur = '/';
  let budget = 0;
  while (queue.length) {
    const name = queue.shift();
    if (name === '.') continue;
    if (name === '..') { cur = path.dirname(cur); continue; }
    const next = cur === '/' ? `/${name}` : `${cur}/${name}`;
    let st = null;
    try { st = fs.lstatSync(next); }
    catch (e) {
      // ONLY ENOENT means "does not exist yet" (finish lexically). Any other error —
      // EACCES on an unsearchable parent, ELOOP, EIO — means we cannot see what is
      // there (it could be a symlink to a disallowed fs), so REFUSE rather than guess
      // (round-2 anthropic finding: EACCES-hidden symlink was treated as absent).
      if (e.code === 'ENOENT') st = null;
      else throw new Error(`${input}: cannot stat ${next} (${e.code || e.message}); refusing rather than guessing its filesystem.`);
    }
    if (st && st.isSymbolicLink()) {
      if (++budget > 256) throw new Error(`${input} resolves through too many symlinks (possible loop); refusing.`);
      let tgt;
      try { tgt = fs.readlinkSync(next); } catch (e) { throw new Error(`${input}: cannot read the symlink ${next} (${e.message}); refusing.`); }
      if (path.isAbsolute(tgt)) cur = '/';
      queue.unshift(...tgt.split('/').filter(Boolean)); // re-resolve the target's components next
      continue;
    }
    // `next` exists as a non-symlink, OR does not exist yet (ENOENT). Either way, descend
    // and keep resolving component by component — never switch to a lexical finish: a `..`
    // can climb back OUT of an absent dir into an existing one whose next component is a
    // real (possibly dangling) symlink, which must still be followed (round-2 anthropic
    // finding: `<btrfs>/missing/../lnk` with lnk->tmpfs was accepted as btrfs). The loop
    // terminates because every non-symlink step shifts one component off the queue.
    cur = next;
  }
  return cur;
}

/** The nearest existing ancestor of an already-resolved (symlink-free) path. */
function nearestExistingOf(resolved) {
  let p = resolved;
  while (p !== path.dirname(p) && !fs.existsSync(p)) p = path.dirname(p);
  return p;
}

/** Filesystem type backing an already-resolved path, or '' if findmnt cannot say. */
function fsTypeOf(resolved) {
  const r = spawnSync('findmnt', ['-n', '-o', 'FSTYPE', '--target', nearestExistingOf(resolved)], { encoding: 'utf8', timeout: 10_000 });
  if (r.status !== 0) return '';
  return (r.stdout ?? '').trim().split('\n')[0].trim();
}

/**
 * Filesystem type backing `dir`, resolved to where data lands (symlinks, `..` and
 * all), or '' if undetectable. May THROW if `dir` cannot be resolved (loop / unreadable).
 */
export function detectFsType(dir) {
  return fsTypeOf(resolveDataPath(dir));
}

/** Bytes free on the filesystem backing `dir` (resolved), or 0. */
export function freeBytesAt(dir) {
  try { const s = fs.statfsSync(nearestExistingOf(resolveDataPath(dir))); return s.bavail * s.bsize; } catch { return 0; }
}

/** The mountpoint (findmnt TARGET) backing an already-resolved path, or '' if findmnt cannot say. */
export function mountTargetOf(resolved) {
  const r = spawnSync('findmnt', ['-n', '-o', 'TARGET', '--target', nearestExistingOf(resolved)], { encoding: 'utf8', timeout: 10_000 });
  if (r.status !== 0) return '';
  return (r.stdout ?? '').trim().split('\n')[0].trim();
}

/**
 * Grade a candidate store dir and return { dir: <resolved>, fsType }, or THROW with a
 * clear reason. ONE place every code path (explicit AND base) funnels through, so a
 * check added here can never be missing from a branch (round-2 anthropic finding: the
 * base branch skipped the dedicated-dirname check and let a <base>/orchard-docker-sandbox
 * symlink to /var/lib/docker through). Throws — failing CLOSED — when the path is
 * relative, cannot be resolved (symlink loop / unreadable), lands on an UNDETECTABLE
 * filesystem (findmnt failed or is absent — never 'unknown'), lands on a filesystem not
 * on the DIND_OK_FS allowlist, or does not resolve to a DEDICATED directory named
 * orchard-docker-sandbox (which keeps the bind device= the privileged dind daemon runs
 * its /var/lib/docker on OFF the host daemon's data-root, /, and any shared/system path).
 */
function gradeStoreDir(dir, envName) {
  if (!path.isAbsolute(dir)) throw new Error(`${envName}=${dir} must be an absolute path.`);
  const resolved = resolveDataPath(dir); // kernel-style; throws on loop / unreadable symlink
  const t = fsTypeOf(resolved);
  if (!t) {
    throw new Error(`${envName}=${dir} (resolves to ${resolved}): cannot determine its filesystem type (findmnt failed or is not on PATH). Refusing rather than building the sandbox on an unknown filesystem.`);
  }
  if (!DIND_OK_FS.has(t)) {
    throw new Error(`${envName}=${dir} is on ${t} (resolves to ${resolved}), which cannot back the dind overlay2 store (need ext4/xfs/btrfs). Not creating the sandbox there.`);
  }
  if (path.basename(resolved) !== SANDBOX_DATA_DIRNAME) {
    throw new Error(`${envName}=${dir} (resolves to ${resolved}) must be a dedicated directory named ${SANDBOX_DATA_DIRNAME} (e.g. /mnt/backup/${SANDBOX_DATA_DIRNAME}), not a shared or system location such as /var/lib/docker or /. Refusing.`);
  }
  const sens = sensitiveStoreMatch(resolved);
  if (sens) {
    throw new Error(`${envName}=${dir} (resolves to ${resolved}) IS ${sens} by identity (same device/inode — a bind mount or hardlink), not a dedicated store dir. Refusing to run the sandbox /var/lib/docker there.`);
  }
  return { dir: resolved, fsType: t };
}

/** The host locations the sandbox store must never BE (by inode), beyond just by name. */
export const SENSITIVE_STORE_PATHS = ['/var/lib/docker', '/'];
/**
 * Return the sensitive path `resolved` IS (same device+inode via lstat), or ''. A bind mount
 * (mount --bind /var/lib/docker <store>) or a hardlinked dir can carry the dedicated basename
 * yet actually BE /var/lib/docker or / — which the basename check misses, because a bind mount
 * is not a symlink for resolveDataPath to follow. Returns '' when `resolved` does not exist yet
 * (a not-yet-created store dir cannot be a bind of anything).
 */
export function sensitiveStoreMatch(resolved) {
  let a;
  try { a = fs.lstatSync(resolved); } catch { return ''; }
  for (const sens of SENSITIVE_STORE_PATHS) {
    let b;
    try { b = fs.lstatSync(sens); } catch { continue; } // sensitive path absent on this host
    if (a.dev === b.dev && a.ino === b.ino) return sens;
  }
  return '';
}

/**
 * Where the dind daemon's /var/lib/docker should live. Returns one of:
 *   { mode: 'bind',   dir, fsType }               — bind-back the named volume with `dir`
 *   { mode: 'volume', warning }                   — today's default local volume (with why)
 *
 * ORCHARD_DOCKER_SANDBOX_DATA=<abs .../orchard-docker-sandbox> forces a bind dir and
 * THROWS (so `up` stops) on any gradeStoreDir() failure. With nothing set,
 * <base>/orchard-docker-sandbox is used when that base (ORCHARD_DOCKER_SANDBOX_DATA_BASE,
 * default /backups) is an ABSOLUTE path that exists, is writable, grades clean and has
 * >=20 GB free; otherwise — base mode being the convenience default, not an explicit
 * request — it falls back SAFELY to the default volume with a visible warning (it never
 * builds a bind store it could not fully vet, and never a cwd-relative one).
 */
export function sandboxDataRoot(env = process.env) {
  const explicit = (env[SANDBOX_DATA_ENV] ?? '').trim();
  if (explicit) {
    const g = gradeStoreDir(explicit, SANDBOX_DATA_ENV);
    return { mode: 'bind', dir: g.dir, fsType: g.fsType };
  }
  const base = (env[SANDBOX_DATA_BASE_ENV] ?? DEFAULT_SANDBOX_DATA_BASE).trim();
  const vol = (reason) => ({ mode: 'volume', warning: `${base} ${reason}; sandbox data stays on the default Docker volume (${SANDBOX_VOLUME}) under the host data-root. Set ${SANDBOX_DATA_ENV}=<dir>/${SANDBOX_DATA_DIRNAME} on a roomy ext4/xfs/btrfs filesystem to relocate it.` });
  if (!path.isAbsolute(base)) return vol('must be an absolute path');
  // Resolve the base KERNEL-STYLE (symlinks, incl. dangling, and `..`) BEFORE joining the
  // dirname, so base mode behaves EXACTLY as explicit mode: path.join collapses `..`
  // lexically, which would mis-grade `<base>/lnk/..` when lnk points at another filesystem.
  let resolvedBase;
  try { resolvedBase = resolveDataPath(base); }
  catch (e) { return vol(`cannot be resolved (${e.message})`); }
  if (!fs.existsSync(resolvedBase)) return vol('does not exist');
  try { fs.accessSync(resolvedBase, fs.constants.W_OK); } catch { return vol('is not writable'); }
  let g;
  try { g = gradeStoreDir(path.join(resolvedBase, SANDBOX_DATA_DIRNAME), SANDBOX_DATA_BASE_ENV); }
  catch (e) { return vol(`cannot host the sandbox store (${e.message})`); }
  const freeGb = freeBytesAt(g.dir) / 2 ** 30;
  if (freeGb < MIN_DATA_FREE_GB) return vol(`has only ${freeGb.toFixed(0)} GB free (need ${MIN_DATA_FREE_GB})`);
  return { mode: 'bind', dir: g.dir, fsType: g.fsType };
}

/* -------------------------------------------------- pinned Docker connection
 * One HTTP/1.1 keep-alive connection to the Docker API: every request goes over
 * the SAME connected socket, so the daemon that answered the id check is the one
 * that receives the deletes — replacing the socket file after connect cannot
 * redirect it (BUG-158 rounds 5/6). Shared by `reset`, the age `prune`, and the
 * size-watermark cap-prune, so all three pin identically.
 */
export function pinnedDocker(sockPath) {
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

/* ----------------------------------------------- size-watermark cap-prune
 * Bound the sandbox store by BYTES + a host free-space FLOOR (never by age).
 */
const gbStr = (n) => (Number.isFinite(n) ? (n / GiB).toFixed(1) + 'GB' : 'n/a');

/**
 * Remove UNUSED images (least-recently-tagged/used FIRST) and over-budget build
 * cache until the sandbox store (dedup image layers + build cache) is at or below
 * `capGb` AND host free space on the store's filesystem is at or above `floorGb`.
 * Sandbox-ONLY: same isolation guard, daemon lock and pinned-connection id re-check
 * as `reset`/`prune`, so it can never reach the host daemon and never races a guarded
 * suite. NEVER removes:
 *   - an image used by any container, running OR stopped (its ImageID/Image);
 *   - an image tagged/used within `recencySec` (default 10 min) — the window in which
 *     a just-built image has no container yet (a pending job the in-use check cannot
 *     see; OpenAI's concern) and the gap a lock-free confined-run build sits in;
 *   - anything while another daemon-lock holder runs (it takes that lock first).
 *
 * Cheap by default: it measures the store over a short unlocked pinned connection
 * and does nothing (no lock, no deletes) when already under both watermarks, so it
 * is safe to call after every confined run / verify job without serialising them.
 *
 * `freeBytes`: a function returning host free bytes on the store's filesystem, or
 * null to enforce the cap only (e.g. from a lane that cannot measure the host fs).
 * A measurement error MUST surface as Infinity (never 0), so the floor fails safe
 * toward keeping images rather than deleting on a bad reading.
 *
 * Returns a summary object (never throws for "still over" — logs a warning).
 */
export async function pruneSandboxToCap(env = process.env, {
  capGb = sandboxCapGb(env), floorGb = sandboxFloorGb(env),
  freeBytes = null, recencySec = 600, lock = true, log = () => {},
} = {}) {
  const v = checkIsolatedDocker(env);
  if (!v.ok) throw new Error(`cap-prune would not be isolated: ${v.reason}`);
  if (!v.target.startsWith('unix://')) throw new Error(`cap-prune needs a pinned unix socket; DOCKER_HOST=${v.target} is not one`);
  const sock = v.target.slice('unix://'.length);
  const capBytes = capGb * GiB, floorBytes = floorGb * GiB;
  const sum = (arr, f) => (arr ?? []).reduce((a, x) => a + (x[f] ?? 0), 0);
  // A reading of 0 (or non-finite/negative) is treated as UNMEASURABLE -> Infinity, never as
  // "disk full": contract 1e — the floor must fail safe toward KEEPING images, not deleting on a
  // bad reading. freeBytesAt() returns 0 on a statfs error, so 0 here means "could not measure".
  // If the disk is genuinely full the BYTE CAP (always measurable) still drives eviction.
  const freeNow = () => { if (!freeBytes) return Infinity; const b = freeBytes(); return Number.isFinite(b) && b > 0 ? b : Infinity; };
  const measure = async (api) => {
    const df = await api.req('GET', '/system/df');
    const imgBytes = df?.LayersSize ?? sum(df?.Images, 'Size');
    // Build-cache records flagged Shared are layers ALSO counted in LayersSize — exclude them, or
    // the store double-counts those bytes and over-evicts to meet a cap the real store already met
    // (contract 1a: a DEDUPLICATED measure). Only build cache NOT shared with images adds bytes.
    const bcBytes = sum((df?.BuildCache ?? []).filter((x) => !x.Shared), 'Size');
    return { store: imgBytes + bcBytes, imgBytes, bcBytes, free: freeNow() };
  };
  const over = (m) => m.store > capBytes || m.free < floorBytes;
  const summary = { capGb, floorGb, acted: false, removed: 0, removedTags: [], skippedIds: [], buildReclaimed: 0 };

  // 1) Cheap precheck over an UNLOCKED pinned connection: id re-check + one /system/df.
  const pre = pinnedDocker(sock);
  let m;
  try {
    const info = await pre.req('GET', '/info');
    if (info?.ID !== v.targetId) throw new Error(`the daemon on cap-prune's connection (${info?.ID ?? 'none'}) is not the one the guard checked (${v.targetId}); not touching it.`);
    m = await measure(pre);
  } finally { pre.close(); }
  summary.before = m;
  log(`cap-prune: cap ${capGb}GB floor ${floorGb}GB; store ${gbStr(m.store)} (images ${gbStr(m.imgBytes)}, buildcache ${gbStr(m.bcBytes)}), free ${gbStr(m.free)}`);
  if (!over(m)) { summary.after = m; log('cap-prune: under cap and above floor; nothing removed'); return summary; }

  // 2) Over budget: take the daemon lock, re-prove identity, act over ONE fresh pinned conn.
  if (lock) {
    acquireDaemonLock(v.targetId, { who: 'sandbox:docker cap-prune', dockerHost: v.target });
    const again = checkIsolatedDocker(env);
    if (!again.ok || again.targetId !== v.targetId) throw new Error('the sandbox daemon changed while cap-prune waited for its lock');
  }
  const api = pinnedDocker(sock);
  try {
    const info = await api.req('GET', '/info');
    if (info?.ID !== v.targetId) throw new Error(`the daemon on cap-prune's connection (${info?.ID ?? 'none'}) is not the one the guard checked (${v.targetId}); not touching it.`);
    summary.acted = true;
    m = await measure(api);
    if (!over(m)) { summary.after = m; log('cap-prune: back under budget before any delete (concurrent cleanup); nothing removed'); return summary; }

    // 2a) Evict over-budget build cache first (rebuildable, cheapest to lose). keep-storage
    //     leaves at most (cap - current image layers) bytes of cache; BuildKit drops its own LRU.
    const keep = Math.max(0, capBytes - m.imgBytes);
    try {
      const bc = await api.req('POST', `/build/prune?keep-storage=${keep}`);
      summary.buildReclaimed = bc?.SpaceReclaimed ?? 0;
      if (summary.buildReclaimed) log(`cap-prune: build cache reclaimed ${gbStr(summary.buildReclaimed)} (keep-storage ${gbStr(keep)})`);
    } catch (e) { log(`cap-prune: build cache prune skipped (${e.message.split('\n')[0]})`); }
    m = await measure(api);
    if (!over(m)) { summary.after = m; log(`cap-prune: under budget after build-cache prune; store ${gbStr(m.store)}`); return summary; }

    // 2b) Remove UNUSED images, least-recently-tagged/used first.
    const containers = (await api.req('GET', '/containers/json?all=1')) ?? [];
    const inUse = new Set();
    for (const c of containers) { if (c.ImageID) inUse.add(c.ImageID); if (c.Image) inUse.add(c.Image); }
    const images = (await api.req('GET', '/images/json?all=0')) ?? [];
    const nowSec = Date.now() / 1000;
    const cand = [];
    for (const img of images) {
      if (inUse.has(img.Id)) continue; // used by a running or stopped container
      let lastTag = 0;
      try {
        const insp = await api.req('GET', `/images/${encodeURIComponent(img.Id)}/json`);
        const t = Date.parse(insp?.Metadata?.LastTagTime ?? '');
        if (Number.isFinite(t) && t > 0) lastTag = t / 1000; // ms -> s
      } catch { /* fall back to Created */ }
      const lastUse = Math.max(lastTag, img.Created ?? 0);
      if (nowSec - lastUse < recencySec) continue; // recently tagged/used: a pending job may need it
      cand.push({ id: img.Id, lastUse, tags: (img.RepoTags ?? []).filter((t) => t && t !== '<none>:<none>') });
    }
    cand.sort((a, b) => a.lastUse - b.lastUse); // oldest last-use first
    for (const c of cand) {
      if (!over(m)) break;
      const label = c.tags[0] || c.id.replace(/^sha256:/, '').slice(0, 12);
      // ATOMIC removal, by IMAGE ID — never a per-tag untag loop. A loop that untags references one
      // at a time can STRIP a tag and then fail to delete the image (a dependent child image, or a
      // container created by a lock-free confined run mid-loop), leaving the image alive but missing
      // a reference a queued job needs (BUG-289 rounds 4/5). force=0 delete-by-id is atomic: it
      // either deletes, or 409s WITHOUT mutating anything.
      let gone = false, lastMsg = '';
      try { await api.req('DELETE', `/images/${encodeURIComponent(c.id)}?force=0&noprune=0`); gone = true; }
      catch (e) {
        lastMsg = e.message;
        // Escalate to force=1 ONLY when the daemon says the SOLE obstacle is multiple TAGS
        // ("referenced in multiple repositories") — then removing all tags + the image in one call
        // is safe (contract 1b: a multi-tag unused image stays evictable). We NEVER force past the
        // other 409s — "image is being used by ... container" (in use) or "has dependent child
        // images" (parent of another image): those are KEPT, atomically, with no untag (contract
        // 1c, and the parent-of-in-use protection). force=1 on a running-container image still 409s.
        if (/referenced in multiple repositories/i.test(e.message)) {
          try { await api.req('DELETE', `/images/${encodeURIComponent(c.id)}?force=1&noprune=0`); gone = true; }
          catch (e2) { lastMsg = e2.message; }
        }
      }
      if (gone) { summary.removed++; summary.removedTags.push(label); m = await measure(api); }
      else { summary.skippedIds.push(c.id); log(`cap-prune: kept ${label} (${(lastMsg.split('\n')[0] || 'still referenced').slice(0, 100)})`); }
    }
    summary.after = m;
    if (over(m)) log(`cap-prune: WARNING still over budget after removing ${summary.removed} image(s): store ${gbStr(m.store)} free ${gbStr(m.free)} — the rest are in use, recently tagged, or protected`);
    else log(`cap-prune: under budget; removed ${summary.removed} image(s) (${summary.removedTags.slice(0, 8).join(', ')}${summary.removedTags.length > 8 ? ', …' : ''}), store ${gbStr(summary.before.store)} -> ${gbStr(m.store)}`);
    return summary;
  } finally { api.close(); }
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
