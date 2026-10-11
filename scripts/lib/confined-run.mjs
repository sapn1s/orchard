/**
 * BUG-240 — the confined runner: run a command (a test suite, a fixture builder,
 * anything that needs scratch git or destructive file work) in a container that
 * can reach no host file, no daemon and no network, by construction rather than
 * by a parser.
 *
 *   node <orchard>/scripts/confined-run.mjs [options] -- <cmd> [args...]
 *
 * Why it exists. The FEAT-158 sandbox daemon is privileged dind with host /tmp,
 * the scratch roots (rw) and the repo (ro) bound at identical paths, so a
 * container started there can reach host state (BUG-240 Activity log). The
 * FEAT-135 git shim refuses scratch git on the host. This runner is the venue
 * for both: the project tree goes IN as a tar stream, results come OUT as a tar
 * stream, and the container in between has no host mount, no capability, no
 * network and no privilege gain. Git inside is the image's real git, unshimmed,
 * because nothing it can write is real.
 *
 * What it does NOT do: it is a venue, not a chokepoint. A lane that talks to a
 * Docker socket directly (the host's, or the privileged sandbox's) is not
 * confined by this file; that is the lane-launch decision recorded on BUG-240.
 *
 * Lifecycle (each step's status is checked; any failure fails the run):
 *   0. remove any labelled container past its expiry (killed earlier runs);
 *   1. create `--rm` with the fixed confinement flags and an expiry label, and
 *      start a detached host reaper for it, so it is removed at the deadline even
 *      if this process is SIGKILLed and whatever the image's PID 1 does;
 *   2. start; `docker exec -i` unpacks the input tars into /work (a size-capped tmpfs);
 *   3. `docker exec` runs the caller's argv (exit status passed through);
 *   4. for --out, `docker exec` tars the path to stdout, read by extractStrict;
 *   5. `rm -f`.
 * The caller chooses only the image and the in-container argv; neither can add a
 * docker flag (exec argv comes after the container id; images with declared
 * VOLUMEs are refused, so an image cannot add writable storage).
 *
 * Daemon: always the FEAT-158 sandbox socket (sandboxPaths()), never an inherited
 * DOCKER_HOST, and only after checkIsolatedDocker proves it is not the host
 * daemon. No sandbox lock is taken: the runner sweeps nothing, and a concurrent
 * `sandbox:docker reset` only makes the run fail loudly.
 *
 * Image contract: /bin/sh and a tar that reads `-x -f -`. git and node are used
 * when present (node:24-bookworm, the default, has both).
 */
import { spawn, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sandboxPaths, checkIsolatedDocker } from './docker-sandbox.mjs';
import { scratchRoot } from './scratch.mjs';

export const DEFAULT_BASE_IMAGE = 'node:24-bookworm';
export const CONFINED_LABEL = 'orchard.confined-run';
export const WORK = '/work';
export const DEFAULT_LIMITS = Object.freeze({ memoryMb: 4096, pids: 2048, workMb: 2048, tmpMb: 1024, cpus: 2, outMb: 512, captureBytes: 16 << 20, deadlineSec: 6 * 3600 });
const DK_TIMEOUT_MS = 120_000;

/**
 * The confinement. Every flag here is load-bearing; the proof suite asserts each
 * is present and holds at runtime. Nothing a caller passes is merged in except
 * the numeric limits.
 */
export function confinementFlags(limits = {}) {
  const l = { ...DEFAULT_LIMITS, ...limits };
  for (const k of ['memoryMb', 'pids', 'workMb', 'tmpMb', 'outMb']) {
    if (!Number.isInteger(l[k]) || l[k] <= 0) throw new Error(`confined-run: limit ${k} must be a positive integer`);
  }
  if (!(Number.isFinite(l.cpus) && l.cpus > 0 && l.cpus <= 64)) throw new Error('confined-run: limit cpus must be a number in (0, 64]');
  return [
    '--rm',
    '--user', '1000:1000',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--network', 'none',
    '--ipc', 'private',
    '--read-only',
    '--no-healthcheck',
    // Both writable places are size-capped tmpfs (charged to the memory cgroup too).
    '--tmpfs', `${WORK}:rw,exec,nosuid,nodev,size=${l.workMb}m,uid=1000,gid=1000,mode=0755`,
    '--tmpfs', `/tmp:rw,exec,nosuid,nodev,size=${l.tmpMb}m,mode=1777`,
    '--pids-limit', String(l.pids),
    '--cpus', String(l.cpus),
    '--memory', `${l.memoryMb}m`,
    '--memory-swap', `${l.memoryMb}m`,
    '--log-driver', 'none',
    '--label', `${CONFINED_LABEL}=1`,
  ];
}

/** Docker CLI env pinned to the sandbox daemon. Host env that could redirect the CLI is dropped. */
export function sandboxCliEnv(base = process.env) {
  const env = { ...base };
  for (const k of ['DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'CLAUDE_STATION_DOCKER',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[k];
  env.DOCKER_HOST = sandboxPaths().dockerHost;
  return env;
}

/** Prove the target is the sandbox, not the host. Returns the pinned env or throws. */
export function pinSandbox(base = process.env) {
  const env = sandboxCliEnv(base);
  const v = checkIsolatedDocker(env);
  if (!v.ok) throw new Error(`confined-run refuses: ${v.reason}`);
  env.DOCKER_HOST = v.target; // the realpath'd socket, as checked
  return { env, targetId: v.targetId };
}

/** A run's time budget: every docker call and the dependency walk are bounded by it. */
export function makeBudget(seconds) { return { until: Date.now() + seconds * 1000 }; }
const msLeft = (b) => (b ? b.until - Date.now() : Infinity);
function overBudget(b, what) { if (msLeft(b) <= 0) throw new Error(`confined-run: the deadline passed during ${what}; nothing was run`); }

function dk(env, args, opts = {}) {
  const { budget, ...rest } = opts;
  const left = msLeft(budget);
  if (left <= 0) return { code: 1, out: '', err: 'deadline passed before this docker call' };
  const timeout = Math.max(1000, Math.min(rest.timeout ?? DK_TIMEOUT_MS, left));
  const r = spawnSync('docker', args, { env, encoding: 'utf8', maxBuffer: 64 << 20, ...rest, timeout });
  const err = r.error ? `${r.error.code ?? ''} ${r.error.message}` : (r.stderr ?? '').trim();
  return { code: r.error ? 1 : (r.status ?? 1), out: (r.stdout ?? '').trim(), err };
}

/*
 * Expiry that trusts nothing inside the image (round-2 review 1-2). Every
 * container this file creates carries `orchard.confined-run.expires=<epoch s>`
 * from the moment it is CREATED, and:
 *   - a detached host reaper (its own session, outlives a SIGKILLed runner)
 *     removes it at that time; a normal run kills the reaper on cleanup;
 *   - every runner invocation first removes any labelled container past its
 *     expiry (reconciliation for the window before the reaper is spawned).
 * PID 1 `sleep` is only a convenience; nothing depends on the image honouring it.
 */
export const EXPIRES_LABEL = `${CONFINED_LABEL}.expires`;
// Retries until the container is gone (or 30 attempts, ~1 h of backoff), so one
// failed removal does not end the protection.
// With graceSec > 0 (ambiguous creates), an absent name is re-checked until
// expiry + grace, so a create that materialises late is still removed
// (round-10 review 1); past the grace the next run's sweep reconciles it.
const REAPER_JS = `const [id, at, graceArg] = process.argv.slice(1);
const grace = Number(graceArg) || 0;
const { spawnSync } = require('node:child_process');
const gone = () => { const r = spawnSync('docker', ['container', 'inspect', '--format', '{{.Id}}', id], { encoding: 'utf8', timeout: 60000 }); return r.status !== 0 && /no such (container|object)/i.test(r.stderr || ''); };
const until = Number(at) * 1000 + grace * 1000;
const every = Math.max(1000, Math.min(30000, grace * 200));
let n = 0;
const attempt = () => {
  if (gone()) { if (Date.now() < until) setTimeout(attempt, every); return; }
  spawnSync('docker', ['rm', '-f', '-v', id], { stdio: 'ignore', timeout: 120000 });
  if (!gone()) { if (++n < 30) setTimeout(attempt, Math.min(300000, 5000 * n)); }
  else if (Date.now() < until) setTimeout(attempt, every);
};
setTimeout(attempt, Math.max(0, Number(at) * 1000 - Date.now()));`;
export const AMBIGUOUS_GRACE_SEC = 600;
export function spawnReaper(env, id, expiresEpochSec, graceSec = 0) {
  const r = spawn(process.execPath, ['-e', REAPER_JS, id, String(expiresEpochSec), String(graceSec)], { env, detached: true, stdio: 'ignore' });
  r.unref();
  return r;
}
/**
 * Remove a container now; kill its reaper ONLY if the container is really gone
 * ("No such container" counts as gone). On failure the reaper is kept, so it
 * retries at the expiry. Returns true when removed.
 */
export function removeOrKeepReaper(env, id, reaper, log = () => {}) {
  const r = dk(env, ['rm', '-f', '-v', id], { timeout: 60_000 });
  const ok = r.code === 0 || /No such container/i.test(r.err);
  if (ok) { try { reaper?.kill('SIGKILL'); } catch { /* gone */ } }
  else log(`could not remove container ${id.slice(0, 12)} now (${r.err.split('\n')[0]}); its reaper retries at the deadline`);
  return ok;
}

/**
 * A create that reported failure may still have created the container (a lost or
 * timed-out reply: round-8 review 2). Every container is created under a name
 * chosen beforehand, so try to remove that name now, and if that cannot be
 * confirmed, leave a reaper on the name for the expiry.
 */
export function reapAmbiguous(env, name, expiresEpochSec, log = () => {}) {
  const removedNow = removeOrKeepReaper(env, name, null, () => {});
  // Always leave a reaper on the name: a create still pending on the daemon can
  // materialise AFTER "No such container" (round-9 review 1). The reaper exits
  // at the expiry once the name is gone.
  spawnReaper(env, name, expiresEpochSec, AMBIGUOUS_GRACE_SEC);
  log(`create of ${name} reported failure; ${removedNow ? 'nothing to remove now' : 'its removal could not be confirmed'}; a reaper checks the name again at the deadline`);
  return removedNow;
}

/** Remove labelled containers past expiry. Bounded by the budget; reports only real removals. */
export function sweepExpired(env, budget, now = Date.now() / 1000) {
  const ls = dk(env, ['ps', '-a', '--filter', `label=${EXPIRES_LABEL}`, '--format', `{{.ID}} {{.Label "${EXPIRES_LABEL}"}}`], { budget, timeout: 30_000 });
  const removed = [], failed = [];
  if (ls.code !== 0) return { removed, failed: [`list: ${ls.err}`] };
  for (const line of ls.out.split('\n').filter(Boolean)) {
    const [cid, at] = line.split(' ');
    if (!(Number(at) > 0 && Number(at) < now)) continue;
    if (msLeft(budget) <= 0) { failed.push(`${cid} (budget spent)`); continue; }
    const r = dk(env, ['rm', '-f', '-v', cid], { budget, timeout: 30_000 });
    if (r.code === 0) removed.push(cid); else failed.push(`${cid} (${r.err.split('\n')[0]})`);
  }
  return { removed, failed };
}

/** Files to ship: tracked + untracked-not-ignored (read-only git) plus .git; else the whole dir. Never node_modules. */
export function treeList(cwd, { withGit = true, budget } = {}) {
  overBudget(budget, 'listing the tree');
  // Host-side git must not run project-configured programs: core.fsmonitor is forced off
  // through GIT_CONFIG_COUNT (round-8 review 1), and caller git env that could redirect
  // or re-enable it is dropped. ls-files runs no hooks.
  const gitEnv = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false', GIT_OPTIONAL_LOCKS: '0' };
  for (const k of ['GIT_CONFIG_PARAMETERS', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) delete gitEnv[k];
  for (const k of Object.keys(gitEnv)) if (/^GIT_CONFIG_(KEY|VALUE)_[1-9]/.test(k)) delete gitEnv[k];
  const r = spawnSync('git', ['-C', cwd, 'ls-files', '-co', '--exclude-standard', '-z'],
    { env: gitEnv, encoding: 'buffer', maxBuffer: 256 << 20, timeout: Math.max(1000, Math.min(120_000, msLeft(budget))), killSignal: 'SIGKILL' });
  if (r.error) throw new Error(`confined-run: listing the tree failed (${r.error.code ?? r.error.message}); nothing was run`);
  if (r.status !== 0) return fs.readdirSync(cwd).filter((f) => f !== 'node_modules' && (withGit || f !== '.git'));
  const exists = (f) => { try { fs.lstatSync(path.join(cwd, f)); return true; } catch { return false; } };
  const files = r.stdout.toString('utf8').split('\0').filter((f) => f && f !== 'node_modules' && !f.startsWith('node_modules/') && exists(f));
  if (withGit && exists('.git')) files.push('.git');
  return files;
}

/**
 * Cache identity of a run image: the base image's resolved ID plus a fingerprint
 * of the node_modules tree as shipped (every entry's path, type, size, mtime and
 * symlink target). A locally patched package or a re-pulled base gets a new key.
 */
export function depsKey(cwd, baseId, budget) {
  const h = crypto.createHash('sha256').update(baseId).update('\0');
  const chunk = Buffer.allocUnsafe(1 << 20);
  const root = path.join(cwd, 'node_modules');
  const walk = (d) => {
    overBudget(budget, 'the dependency fingerprint');
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of ents) {
      overBudget(budget, 'the dependency fingerprint');
      const p = path.join(d, e.name);
      const st = fs.lstatSync(p);
      h.update(`${path.relative(root, p)}\0${st.mode}\0${st.size}\0`);
      if (e.isSymbolicLink()) h.update(fs.readlinkSync(p));
      else if (e.isDirectory()) walk(p);
      // Regular-file CONTENTS, not mtime (round-9 review 2), hashed through one bounded
      // buffer with a budget check per chunk (round-10 review 2).
      else if (st.isFile()) {
        const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          for (let n; (n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0;) { h.update(chunk.subarray(0, n)); overBudget(budget, 'the dependency fingerprint'); }
        } finally { fs.closeSync(fd); }
      }
    }
  };
  if (fs.existsSync(root)) walk(root); else h.update('no-node_modules');
  return h.digest('hex').slice(0, 24);
}

/** `tar -c` of one entry under dir, piped into `docker cp -a - <id>:<dest>`, uid/gid forced to 1000. */
function tarInto(env, dir, entry, id, dest, budget) {
  // tar archives symlinks AS symlinks (never followed): nothing outside `entry` is read.
  overBudget(budget, `copying ${entry}`);
  const sh = 'tar -c --owner=1000 --group=1000 --numeric-owner -C "$1" "$2" | docker cp -a - "$3"';
  // GNU `timeout` puts the pipeline in its own process group and signals the whole group,
  // so a stalled tar or docker cp cannot outlive the timeout (round-10 review 3).
  const secs = Math.max(1, Math.floor(Math.min(900_000, msLeft(budget)) / 1000));
  const r = spawnSync('timeout', ['-s', 'KILL', String(secs), 'bash', '-o', 'pipefail', '-c', sh, 'tar-into', dir, entry, `${id}:${dest}`],
    { env, encoding: 'utf8', maxBuffer: 16 << 20, timeout: (secs + 10) * 1000, killSignal: 'SIGKILL' });
  if (r.status === 137 || r.status === 124 || r.signal === 'SIGKILL' || r.error?.code === 'ETIMEDOUT') throw new Error(`copying ${entry} into the run image timed out after ${secs}s (pipeline killed)`);
  if (r.status !== 0) throw new Error(`copying ${entry} into the run image failed: ${(r.stderr ?? r.error?.message ?? '').trim()}`);
}

function imageVolumes(env, ref, budget) {
  const r = dk(env, ['image', 'inspect', '--format', '{{json .Config.Volumes}}', ref], { budget });
  if (r.code !== 0) throw new Error(`confined-run: cannot inspect ${ref}: ${r.err}`);
  const v = r.out && r.out !== 'null' ? JSON.parse(r.out) : {};
  return Object.keys(v ?? {});
}

/**
 * The run image: the base plus the project's node_modules at /opt/node_modules
 * when there is one. Built by create + `cp -a` + commit: no Dockerfile, no RUN,
 * so no build-time network or code execution. Cached by depsKey. Returns the
 * image ID (not a tag), so a concurrent rebuild under the same tag cannot swap
 * what this run starts. Images that declare VOLUMEs are refused.
 */
export function ensureImage(env, cwd, baseImage, log = () => {}, budget = makeBudget(DEFAULT_LIMITS.deadlineSec)) {
  if (dk(env, ['image', 'inspect', baseImage], { budget }).code !== 0) {
    log(`pulling ${baseImage} into the sandbox`);
    const p = dk(env, ['pull', '-q', baseImage], { timeout: 900_000, budget });
    if (p.code !== 0) throw new Error(`could not pull ${baseImage}: ${p.err.split('\n')[0]}`);
  }
  // Resolve the tag to an immutable ID FIRST, then validate and use only that ID (a retag
  // between a check and the use cannot substitute a different image: round-3 review 3).
  const baseId = dk(env, ['image', 'inspect', '--format', '{{.Id}}', baseImage], { budget }).out;
  if (!/^sha256:[0-9a-f]{64}$/.test(baseId)) throw new Error(`confined-run: cannot resolve ${baseImage} to an image ID`);
  const checked = (imgId, label) => {
    const vols = imageVolumes(env, imgId, budget);
    if (vols.length) throw new Error(`confined-run refuses ${label}: it declares VOLUME ${vols.join(', ')} (writable storage outside the caps)`);
    return imgId;
  };
  checked(baseId, baseImage);
  if (!fs.existsSync(path.join(cwd, 'node_modules'))) return baseId;
  const tag = `orchard-confined-run:${depsKey(cwd, baseId, budget)}`;
  const have = dk(env, ['image', 'inspect', '--format', '{{.Id}}', tag], { budget });
  if (have.code === 0 && /^sha256:[0-9a-f]{64}$/.test(have.out)) return checked(have.out, tag);
  log(`building ${tag} from ${baseImage} + node_modules (once per dependency tree)`);
  const expires = Math.ceil(budget.until / 1000);
  const stageName = `orchard-confined-stage-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const c = dk(env, ['create', '--name', stageName, '--network', 'none', '--label', `${CONFINED_LABEL}=1`, '--label', `${EXPIRES_LABEL}=${expires}`, baseId, 'true'], { budget });
  if (c.code !== 0) { reapAmbiguous(env, stageName, expires, log); throw new Error(`create for the run image failed: ${c.err}`); }
  const id = c.out;
  const reaper = spawnReaper(env, id, expires);
  let imageId = null, stagingRemoved = false;
  try {
    tarInto(env, cwd, 'node_modules', id, '/opt', budget);
    // The image must not carry the staging container's expiry label onward.
    const cm = dk(env, ['commit', '--change', `LABEL ${CONFINED_LABEL}=1 ${EXPIRES_LABEL}=0`, id, tag], { timeout: 900_000, budget });
    if (cm.code !== 0) throw new Error(`image commit failed: ${cm.err}`);
    const made = cm.out.trim();
    if (!/^sha256:[0-9a-f]{64}$/.test(made)) throw new Error(`image commit returned no image ID (${made})`);
    imageId = checked(made, tag);
  } finally {
    stagingRemoved = removeOrKeepReaper(env, id, reaper, log); // keeps the reaper if removal failed (round-3 review 1)
  }
  if (!stagingRemoved) throw new Error(`confined-run: the staging container ${id.slice(0, 12)} could not be removed (its reaper retries at the deadline); nothing was run`);
  return imageId;
}

/** Unpack stdin into /work (project tar, then one tar per --ship entry: `-i`), prepare HOME. */
const SHIP_SH = [
  'set -e',
  `cd ${WORK}`,
  'tar -x -i -f - --no-same-owner',
  `mkdir -p ${WORK}/.home`,
].join('\n');

/** The run step: HOME, an optional git identity, node_modules link, cd, exec argv ("$@"). */
const RUN_SH = [
  'set -e',
  `export HOME=${WORK}/.home`,
  'if command -v git >/dev/null 2>&1; then',
  '  git config --global user.name confined-run; git config --global user.email confined-run@localhost',
  '  git config --global init.defaultBranch main; git config --global safe.directory "*"',
  'fi',
  `if [ -d /opt/node_modules ] && [ ! -e ${WORK}/node_modules ]; then ln -s /opt/node_modules ${WORK}/node_modules; fi`,
  `cd "${WORK}/$ORCHARD_CONFINED_SUBDIR"`,
  // The command only ever starts inside the shipped tree, whatever the env says.
  `case "$(pwd -P)" in ${WORK}|${WORK}/*) ;; *) echo "confined-run: working directory $(pwd -P) is outside ${WORK}; refusing" >&2; exit 2;; esac`,
  'exec "$@"',
].join('\n');

/**
 * Minimal, strict, STREAMING tar reader for --out: regular files and directories
 * only. Symlinks, hardlinks, devices and FIFOs are skipped and reported; any path
 * that is absolute or climbs out is refused. Files are created with
 * O_EXCL|O_NOFOLLOW under a fresh directory this process just made, whose only
 * children it made. Input arrives in chunks (push) and file bodies are written
 * as they arrive, so host memory stays bounded by one chunk plus a 512-byte
 * header and at most 64 KiB of metadata, whatever the archive size. maxBytes is
 * a hard cap on the whole stream: exceeding it throws.
 */
export class StrictTarSink {
  constructor(destDir, { budget, maxMembers = 100_000, maxBytes = Infinity } = {}) {
    Object.assign(this, { destDir, budget, maxMembers, maxBytes });
    this.skipped = []; this.written = 0; this.members = 0; this.total = 0;
    this.longName = null; this.paxPath = null; this.pending = false;
    this.state = 'header'; this.hdr = Buffer.alloc(512); this.hdrLen = 0;
    this.remaining = 0; this.pad = 0; this.sink = null; this.meta = null; this.metaLen = 0; this.cur = null;
    overBudget(budget, 'the --out extraction');
  }
  push(chunk) {
    this.total += chunk.length;
    if (this.total > this.maxBytes) throw new Error(`extractStrict: --out archive exceeds the ${this.maxBytes}-byte cap; refusing`);
    let i = 0;
    while (i < chunk.length) {
      if (this.state === 'end') return;
      if (this.state === 'header') {
        const n = Math.min(512 - this.hdrLen, chunk.length - i);
        chunk.copy(this.hdr, this.hdrLen, i, i + n); this.hdrLen += n; i += n;
        if (this.hdrLen === 512) { this.hdrLen = 0; this.#header(); }
      } else if (this.state === 'body') {
        const n = Math.min(this.remaining, chunk.length - i);
        const part = chunk.subarray(i, i + n); i += n; this.remaining -= n;
        if (this.sink === 'file') this.#write(part);
        else if (this.sink === 'meta') { part.copy(this.meta, this.metaLen); this.metaLen += n; }
        if (this.remaining === 0) this.#finishMember();
      } else { // pad
        const n = Math.min(this.pad, chunk.length - i); i += n; this.pad -= n;
        if (this.pad === 0) this.state = 'header';
      }
    }
  }
  #header() {
    const h = this.hdr;
    if (++this.members > this.maxMembers) throw new Error(`extractStrict: more than ${this.maxMembers} archive members; refusing`);
    overBudget(this.budget, 'the --out extraction');
    if (h.every((x) => x === 0)) { this.state = 'end'; return; }
    const str = (b) => b.toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(str(h.subarray(124, 136)).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new Error('extractStrict: bad size field');
    const type = String.fromCharCode(h[156] || 48);
    const prefix = str(h.subarray(345, 500));
    const name = this.longName ?? this.paxPath ?? (prefix ? `${prefix}/${str(h.subarray(0, 100))}` : str(h.subarray(0, 100)));
    this.cur = { type, size, name };
    this.remaining = size; this.pad = (512 - (size % 512)) % 512; this.sink = null;
    // Metadata members are size-capped and parsed linearly (round-6 review 1: no regex backtracking).
    if (type === 'L' || type === 'x') {
      if (type === 'L' && size > 4096) throw new Error('extractStrict: long-name member over 4 KiB');
      if (type === 'x' && size > 65536) throw new Error('extractStrict: pax header over 64 KiB');
      this.sink = 'meta'; this.meta = Buffer.alloc(size); this.metaLen = 0;
    } else if (type !== 'g') {
      this.longName = null; this.paxPath = null; this.pending = false;
      const norm = path.posix.normalize(name.replace(/^\.\//, ''));
      this.cur.norm = norm;
      if (!norm || norm === '.' || norm === './') { /* discard */ }
      else if (path.posix.isAbsolute(norm) || norm === '..' || norm.startsWith('../')) this.skipped.push(`${name} (escapes)`);
      else if (type === '5') mkdirOwned(this.destDir, norm.replace(/\/$/, ''));
      else if (type !== '0' && type !== '\0' && type !== '7') this.skipped.push(`${norm} (type ${type})`);
      else {
        const parent = path.posix.dirname(norm);
        if (parent !== '.') mkdirOwned(this.destDir, parent);
        this.cur.target = path.join(this.destDir, ...norm.split('/'));
        this.cur.fd = fs.openSync(this.cur.target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
        this.sink = 'file';
      }
    }
    this.state = 'body';
    if (size === 0) this.#finishMember();
  }
  #write(part) {
    // Write every byte; a zero-progress write is an error, not a silent truncation (round-6 review 2).
    for (let off = 0; off < part.length;) {
      const n = fs.writeSync(this.cur.fd, part, off, part.length - off);
      if (!(n > 0)) throw new Error(`extractStrict: write made no progress on ${this.cur.norm}`);
      off += n;
    }
  }
  #finishMember() {
    const c = this.cur;
    if (this.sink === 'meta') {
      if (c.type === 'L') this.longName = this.meta.toString('utf8').replace(/\0.*$/s, ''); else this.paxPath = paxPathOf(this.meta);
      this.pending = true; this.meta = null;
    } else if (this.sink === 'file') { fs.closeSync(c.fd); c.fd = null; this.written++; }
    this.sink = null; this.cur = null;
    this.state = this.pad ? 'pad' : 'header';
  }
  /** Call once the stream is complete; throws on any truncation. */
  end() {
    if (this.state === 'body') throw new Error(`extractStrict: truncated archive (${this.cur.name}: ${this.cur.size} bytes declared, ${this.cur.size - this.remaining} present)`);
    if (this.state === 'header' && this.hdrLen > 0) {
      // No end-of-archive block: truncated (round-5 review 2, round-11 review 1).
      throw new Error(this.hdr.subarray(0, this.hdrLen).some((x) => x !== 0) ? 'extractStrict: truncated archive (partial header)' : 'extractStrict: truncated archive (no end-of-archive block)');
    }
    if (this.state !== 'end') throw new Error('extractStrict: truncated archive (no end-of-archive block)');
    // Metadata with no member after it means the archive was cut off (round-11 review 1).
    if (this.pending) throw new Error('extractStrict: truncated archive (metadata without its member)');
    overBudget(this.budget, 'the --out extraction');
    return { written: this.written, skipped: this.skipped };
  }
  /** On any failure: close and remove the partially written current file. */
  abort() {
    const c = this.cur;
    if (c?.fd != null) { try { fs.closeSync(c.fd); } catch { /* closed */ } try { fs.unlinkSync(c.target); } catch { /* gone */ } }
  }
}

/** Buffer form of StrictTarSink (same rules). */
export function extractStrict(buf, destDir, opts = {}) {
  const s = new StrictTarSink(destDir, opts);
  try { s.push(buf); return s.end(); } catch (e) { s.abort(); throw e; }
}

/**
 * The `path` value of a pax extended header, parsed record by record in linear
 * time: each record is "<len> <key>=<value>\n" where <len> counts the whole
 * record. Any malformed record ends parsing (the header is then ignored).
 */
export function paxPathOf(body) {
  let i = 0, found = null;
  while (i < body.length) {
    let j = i, len = 0;
    while (j < body.length && j - i < 12 && body[j] >= 0x30 && body[j] <= 0x39) { len = len * 10 + (body[j] - 0x30); j++; }
    if (j === i || body[j] !== 0x20 || len <= j - i + 1 || i + len > body.length || body[i + len - 1] !== 0x0a) return found;
    const rec = body.subarray(j + 1, i + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0 && rec.slice(0, eq) === 'path') found = rec.slice(eq + 1);
    i += len;
  }
  return found;
}

function mkdirOwned(root, rel) {
  let cur = root;
  for (const seg of rel.split('/')) {
    cur = path.join(cur, seg);
    try { fs.mkdirSync(cur, { mode: 0o755 }); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (!fs.lstatSync(cur).isDirectory()) throw new Error(`refusing: ${cur} exists and is not a directory`);
    }
  }
}

/**
 * `--ship <hostDir>[:<dest>]` -> { host, rel } where rel is the /work-relative
 * destination. A COPY goes in (never a mount); nothing comes back. dest `~/x` or
 * omitted-under-$HOME lands under the container HOME (/work/.home), so a suite
 * that reads ~/projects/methodology finds it where it looks.
 */
export function resolveShip(spec) {
  const i = spec.indexOf(':');
  const hostRaw = i === -1 ? spec : spec.slice(0, i);
  let dest = i === -1 ? null : spec.slice(i + 1);
  const home = os.homedir();
  const host = fs.realpathSync(hostRaw.replace(/^~(?=\/|$)/, home));
  if (!fs.statSync(host).isDirectory()) throw new Error(`confined-run: --ship ${hostRaw} is not a directory`);
  if (dest == null) {
    const r = path.relative(home, host);
    if (!r || r.startsWith('..') || path.isAbsolute(r)) throw new Error(`confined-run: --ship ${hostRaw} is outside $HOME; give a destination (--ship ${hostRaw}:~/name)`);
    dest = `~/${r}`;
  }
  let rel;
  if (dest.startsWith('~/')) rel = path.posix.join('.home', dest.slice(2));
  else if (dest.startsWith(`${WORK}/`)) rel = dest.slice(WORK.length + 1);
  else rel = dest;
  rel = path.posix.normalize(rel);
  if (!rel || rel === '.' || path.posix.isAbsolute(rel) || rel.split('/').includes('..') || /[|\\&\n]/.test(rel)) {
    throw new Error(`confined-run: --ship destination ${JSON.stringify(dest)} must stay inside ${WORK}`);
  }
  return { host, rel };
}

/**
 * Pipe producers' stdout (in order) into a consumer's stdin. Resolves only when
 * the consumer AND every producer actually launched have closed. Once the
 * consumer closes, or any producer fails, no further producer is launched
 * (those are 'not-run'); launched ones still running are killed and awaited.
 */
function pipeChain(producers, consumer) {
  return new Promise((resolve) => {
    const statuses = new Array(producers.length).fill('not-run');
    const pending = new Set();
    let consumerCode = null, spawnErr = null, idx = 0, stopped = false, finished = false;
    const done = () => { if (!finished && consumerCode !== null && pending.size === 0) { finished = true; resolve({ statuses, consumerCode, spawnErr }); } };
    const stop = () => { stopped = true; try { consumer.stdin.end(); } catch { /* closed */ } };
    consumer.on('error', (e) => { spawnErr ??= e.message; consumerCode = 1; stop(); done(); });
    consumer.stdin.on('error', () => { /* consumer exited early; its status says why */ });
    consumer.on('close', (c) => { consumerCode ??= c ?? 1; stopped = true; for (const p of pending) { try { p.kill('SIGKILL'); } catch { /* gone */ } } done(); });
    const next = () => {
      if (stopped) return;
      if (idx >= producers.length) { stop(); return; }
      const k = idx++;
      let p;
      try { p = producers[k](); } catch (e) { spawnErr ??= e.message; statuses[k] = 1; stop(); done(); return; }
      statuses[k] = null;
      pending.add(p);
      let settled = false;
      const settle = (code) => {
        if (settled) return; settled = true;
        statuses[k] = code; pending.delete(p);
        if (code === 0) next(); else stop();
        done();
      };
      p.on('error', (e) => { spawnErr ??= e.message; settle(1); });
      p.stdout.pipe(consumer.stdin, { end: false });
      p.on('close', (c) => settle(c ?? 1));
    };
    next();
  });
}

/**
 * Run argv confined. Returns { code, stdout?, stderr?, outDir?, skipped? }.
 * opts: cwd, subdir, image, out, ship[], env[] (K=V inside), timeoutSec, withGit,
 * limits {memoryMb,pids,workMb,tmpMb}, capture (collect output, bounded), log.
 */
export async function runConfined(argv, opts = {}) {
  if (!Array.isArray(argv) || !argv.length) throw new Error('confined-run: no command given (put it after --)');
  if (opts.timeoutSec != null && !(Number.isFinite(opts.timeoutSec) && opts.timeoutSec > 0)) throw new Error('confined-run: --timeout-sec must be a positive number');
  const limits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) };
  const deadlineSec = Math.ceil(opts.timeoutSec ?? limits.deadlineSec);
  const budget = makeBudget(deadlineSec);
  const cwd = fs.realpathSync(opts.cwd ?? process.cwd());
  const log = opts.log ?? ((m) => process.stderr.write(`[confined-run] ${m}\n`));
  const ships = (opts.ship ?? []).map((spec) => resolveShip(spec));
  const subdir = opts.subdir ?? '';
  if (subdir && (path.posix.isAbsolute(subdir) || subdir.split('/').includes('..'))) throw new Error('confined-run: --subdir must be relative and stay inside the tree');
  // Caller env first, the runner's own variables LAST (docker is last-wins), and the
  // runner's names are refused outright (independent Claude verify: --env could reset
  // ORCHARD_CONFINED_SUBDIR past the --subdir guard).
  const inner = [];
  for (const kv of opts.env ?? []) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(kv)) throw new Error(`confined-run: bad --env ${JSON.stringify(kv)}`);
    if (/^ORCHARD_CONFINED/.test(kv)) throw new Error(`confined-run: --env may not set ${kv.split('=')[0]} (reserved by the runner)`);
    inner.push('-e', kv);
  }
  inner.push('-e', 'ORCHARD_CONFINED=1', '-e', `ORCHARD_CONFINED_SUBDIR=${subdir}`, '-e', 'CI=1');

  // pinSandbox's daemon probes carry their own 15 s timeouts (docker-sandbox.mjs); the budget is checked after.
  const { env } = pinSandbox(opts.baseEnv ?? process.env);
  overBudget(budget, 'pinning the sandbox daemon');
  const swept = sweepExpired(env, budget);
  if (swept.removed.length) log(`removed ${swept.removed.length} expired confined-run container(s) left by killed runs`);
  if (swept.failed.length) log(`could not remove ${swept.failed.length} expired container(s): ${swept.failed.slice(0, 3).join('; ')}`);
  const image = ensureImage(env, cwd, opts.image ?? DEFAULT_BASE_IMAGE, log, budget);
  const remaining = () => msLeft(budget) / 1000;
  if (remaining() <= 5) throw new Error('confined-run: the deadline passed while preparing the image; nothing was run');

  const name = `orchard-confined-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const expires = Math.ceil(budget.until / 1000);
  const create = dk(env, ['create', '--name', name, ...confinementFlags(limits), '--label', `${EXPIRES_LABEL}=${expires}`, ...inner,
    '--entrypoint', 'sleep', image, String(Math.floor(remaining()))], { budget });
  if (create.code !== 0) { reapAmbiguous(env, name, expires, log); throw new Error(`confined-run: create failed: ${create.err}`); }
  const id = create.out;
  // Image-independent expiry: survives this process being SIGKILLed.
  const reaper = spawnReaper(env, id, expires);
  const live = new Set();
  let cleaned = false;
  const cleanup = () => {
    for (const ch of live) { try { ch.kill('SIGKILL'); } catch { /* gone */ } }
    if (cleaned) return;
    cleaned = removeOrKeepReaper(env, id, reaper, log); // keeps the reaper if removal failed (round-3 review 1)
  };
  const onSig = (s) => { cleanup(); process.exit(s === 'SIGINT' ? 130 : 143); };
  process.once('SIGINT', onSig); process.once('SIGTERM', onSig);
  const timer = setTimeout(() => { log(`deadline ${deadlineSec}s reached: removing the container`); cleanup(); }, Math.max(1, remaining()) * 1000);
  timer.unref?.();
  const track = (ch) => { live.add(ch); ch.on('close', () => live.delete(ch)); return ch; };
  let runResult = null;
  try {
    const st = dk(env, ['start', id], { budget });
    if (st.code !== 0) throw new Error(`confined-run: start failed: ${st.err}`);

    // Step 2: ship. Every producer's status and the unpacker's status must be 0.
    const files = treeList(cwd, { withGit: opts.withGit !== false, budget });
    log(`shipping ${files.length} entries from ${cwd}${ships.length ? ` + ${ships.length} --ship dir(s)` : ''} (container ${id.slice(0, 12)})`);
    const unpack = track(spawn('docker', ['exec', '-i', id, '/bin/sh', '-c', SHIP_SH], { env, stdio: ['pipe', 'ignore', 'pipe'] }));
    let unpackErr = '';
    unpack.stderr.on('data', (d) => { if (unpackErr.length < 4096) unpackErr += d; });
    const producers = [
      () => { const t = track(spawn('tar', ['-c', '-C', cwd, '--null', '-T', '-'], { stdio: ['pipe', 'pipe', 'pipe'] })); t.stdin.end(files.join('\0') + '\0'); t.stderr.on('data', (d) => { if (unpackErr.length < 4096) unpackErr += `[host tar] ${d}`; }); return t; },
      // --ship renames members (not symlink targets: flag S) to land under their destination.
      ...ships.map((s) => () => { const t = track(spawn('tar', ['-c', '-C', s.host, `--transform=s|^\\.|${s.rel}|S`, '.'], { stdio: ['ignore', 'pipe', 'pipe'] })); t.stderr.on('data', (d) => { if (unpackErr.length < 4096) unpackErr += `[host tar ${s.host}] ${d}`; }); return t; }),
    ];
    const shipped = await pipeChain(producers, unpack);
    if (shipped.spawnErr || shipped.consumerCode !== 0 || shipped.statuses.some((s) => s !== 0)) {
      throw new Error(`confined-run: shipping the input failed (host tar ${JSON.stringify(shipped.statuses)}, unpack ${shipped.consumerCode}${shipped.spawnErr ? `, ${shipped.spawnErr}` : ''}); the command was NOT run.\n${unpackErr.trim()}`);
    }

    // Step 3: run. Output is passed through (or captured, bounded); the daemon logs nothing.
    const captured = { stdout: '', stderr: '', truncated: false };
    const cap = (k) => (d) => { const room = limits.captureBytes - captured[k].length; const s = String(d); if (s.length > room) captured.truncated = true; if (room > 0) captured[k] += s.slice(0, room); };
    const run = track(spawn('docker', ['exec', id, '/bin/sh', '-c', RUN_SH, 'confined-run', ...argv],
      { env, stdio: ['ignore', opts.capture ? 'pipe' : 'inherit', opts.capture ? 'pipe' : 'inherit'] }));
    if (opts.capture) { run.stdout.on('data', cap('stdout')); run.stderr.on('data', cap('stderr')); }
    const code = await new Promise((resolve) => { run.on('error', () => resolve(1)); run.on('close', (c) => resolve(c ?? 1)); });
    const result = { code, ...(opts.capture ? captured : {}) };

    // Step 4: --out, read back through the strict extractor.
    if (opts.out) {
      const rel = path.posix.normalize(opts.out.replace(new RegExp(`^${WORK}/?`), ''));
      if (path.posix.isAbsolute(rel) || rel === '..' || rel.startsWith('../')) throw new Error('confined-run: --out must be under /work');
      // Bounded by the remaining budget: a stalled export (e.g. a hostile image's tar) cannot hold the runner.
      overBudget(budget, 'the --out export');
      // STREAMED with a hard byte cap (limits.outMb): the export is never buffered whole on the
      // host; exceeding the cap kills the export and fails the run loudly.
      fs.mkdirSync(scratchRoot(), { recursive: true });
      const outDir = fs.mkdtempSync(path.join(scratchRoot(), 'confined-out-'));
      const maxBytes = limits.outMb * 1024 * 1024;
      const sink = new StrictTarSink(outDir, { budget, maxBytes });
      const exp = track(spawn('docker', ['exec', id, 'tar', '-c', '-C', WORK, '--', rel], { env, stdio: ['ignore', 'pipe', 'pipe'] }));
      let expErr = '', failure = null;
      exp.stderr.on('data', (d) => { if (expErr.length < 4096) expErr += d; });
      exp.stdout.on('data', (d) => {
        if (failure) return;
        try { sink.push(d); } catch (e) { failure = e; try { exp.kill('SIGKILL'); } catch { /* gone */ } }
      });
      const kill = setTimeout(() => { failure ??= new Error('confined-run: the --out export hit the deadline'); try { exp.kill('SIGKILL'); } catch { /* gone */ } }, Math.max(1000, Math.min(600_000, msLeft(budget))));
      const expCode = await new Promise((resolve) => { exp.on('error', (e) => { failure ??= e; resolve(1); }); exp.on('close', (c) => resolve(c ?? 1)); });
      clearTimeout(kill);
      let x = null;
      if (!failure && expCode !== 0) failure = new Error(`--out export exited ${expCode}: ${expErr.trim()}`);
      if (!failure) { try { x = sink.end(); } catch (e) { failure = e; } }
      if (failure) {
        sink.abort();
        fs.rmSync(outDir, { recursive: true, force: true });
        log(`--out REFUSED: ${failure.message}`);
        result.code = result.code || 1; result.outError = failure.message;
      } else {
        Object.assign(result, { outDir, written: x.written, skipped: x.skipped });
        log(`--out: ${x.written} files into ${outDir}${x.skipped.length ? `; skipped ${x.skipped.length} non-regular/escaping entries` : ''}`);
      }
    }
    runResult = result;
  } finally {
    clearTimeout(timer);
    process.off('SIGINT', onSig); process.off('SIGTERM', onSig);
    cleanup();
  }
  // A container that could not be removed fails the run, whatever the command did
  // (round-7 review 1); its reaper still retries at the deadline.
  if (!cleaned) {
    runResult.cleanupFailed = true;
    if (runResult.code === 0) runResult.code = 1;
    log(`run reported as FAILED: container ${id.slice(0, 12)} could not be removed`);
  }
  return runResult;
}

export const __test = { SHIP_SH, RUN_SH, pipeChain, REAPER_JS, tarInto };
