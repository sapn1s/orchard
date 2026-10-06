/**
 * ARCH-020 (decision A, user 2026-09-29) — every project Dockerfile builds on
 * its OWN rootless BuildKit daemon.
 *
 * WHY. Project builds used to run on the host dockerd's single BuildKit, whose
 * local image store and layer cache every project shared. Cross-project
 * isolation then had to be rebuilt out of rules over the Dockerfile text (a
 * canonicaliser, a flag allow-list, an image-reference ban, a per-project
 * cache-scope step injected after every FROM) — and eight clean-room rounds each
 * broke one of those rules (FEAT-155 rounds 9–13). Here the isolation is a
 * property of WHERE the build runs, so it no longer depends on what the text
 * says:
 *
 *   - one builder per (data dir, project id, repo): a container of the pinned
 *     official `moby/buildkit` rootless image with its own state volume. Its
 *     layer cache, cache mounts and pulled images are that project's alone;
 *   - the builder has no access to the host's image store at all — a `FROM`
 *     that names a local-only image fails to resolve, however it is spelled;
 *   - the only client-side inputs a build session exposes are the repo (the
 *     context), the Dockerfile on stdin and Orchard's base as an OCI layout;
 *     no --ssh, no --secret, no entitlements (BuildKit itself refuses
 *     network.host / security.insecure / device without them);
 *   - the builder never names anything on the host. It exports an OCI layout
 *     into an Orchard-owned staging dir; Orchard checks that layout (regular
 *     files only, one image manifest, every blob's size and digest), WRITES ITS
 *     OWN index naming the candidate, tars exactly the referenced blobs and
 *     hands that to `docker load`. So even a build that escaped the rootless
 *     sandbox into its own buildkitd cannot retag another image on the host.
 *     Remaining trust: the host buildx client's file-sync receiver (confines
 *     writes to the staging dir) and dockerd/containerd's importer (verifies
 *     blob digests).
 *
 * WHAT THIS DOES NOT CLAIM. Network: a build can reach what that project's own
 * session container can reach (both sit on the default docker bridge; the
 * session is the party that writes the Dockerfile). Public registry images and
 * package downloads are ordinary inputs, fetched anonymously. Neither is a
 * cross-project storage leak; restricting egress is a separate decision.
 *
 * LIFECYCLE. A builder is started for a build and STOPPED after it (its state
 * persists in the volume), so nothing runs idle. Builds of one project are
 * serialised in-process; at most MAX_CONCURRENT_BUILDS run at once. One Orchard
 * server owns a data dir (as it does for the registry and every other state
 * file); the data dir is part of the builder's name, so a scratch server on
 * another data dir can never share a builder with the live one. Deleting a
 * project removes its builder, volume and images (`removeProjectBuilders`); the
 * orphan sweep removes builders whose project is gone.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { dockerBin, dockerSpawn, dockerSpawnSync } from './docker-exec.ts';
import { currentOp } from './lifecycle.ts';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { dataDir, ensureDir } from '../lib/paths.ts';
import { ownerKey } from './instance-owner.ts';


/** The builder image: official `moby/buildkit` rootless, pinned by digest (Docker Hub). */
export const BUILDER_IMAGE = 'moby/buildkit:v0.33.0-rootless@sha256:80b15f0735e87bab7bf59ec4d695dfb4a7cfb25521cf56dc75d6f256285b63ef';
/** Bumped whenever the builder's container config changes: an older builder is recreated (its volume kept). */
export const BUILDER_CONFIG_VERSION = '1';
export const BUILDER_NAME_PREFIX = 'claude-station-builder_';
export const LABEL_BUILDER = 'claude-station.builder';
export const LABEL_BUILDER_PROJECT = 'claude-station.builder-project';
export const LABEL_BUILDER_REPO = 'claude-station.builder-repo';
export const LABEL_BUILDER_DATA = 'claude-station.builder-data';
export const LABEL_BUILDER_CONFIG = 'claude-station.builder-config';
const STATE_PATH = '/home/user/.local/share/buildkit';
/** buildkitd's GC TARGET for one builder's cache (MB) — not a hard quota. */
export const GC_KEEP_MB = 30_000;
const BUILDER_MEMORY = '12g';
const BUILDER_PIDS = 4096;
export const MAX_CONCURRENT_BUILDS = 2;
/**
 * A build is not started with less free space than this on the docker root or
 * the staging filesystem (a failed build keeps the last good image; a full disk
 * breaks every project). A preflight, not a reservation.
 */
export function minFreeBytes(): number {
  const gb = Number(process.env.CLAUDE_STATION_BUILD_MIN_FREE_GB);
  return (Number.isFinite(gb) && gb >= 0 ? gb : 25) * 1024 ** 3;
}
/** Largest OCI layout Orchard will import (sum of the referenced blobs). */
const MAX_LAYOUT_BYTES = 200 * 1024 ** 3;

export class BuilderError extends Error {
  readonly code: string;
  readonly detail: string;
  constructor(code: string, message: string, detail = '') {
    super(message);
    this.name = 'BuilderError';
    this.code = code;
    this.detail = detail;
  }
}

interface Run { code: number; stdout: string; stderr: string }
function dockerSync(args: string[], timeoutMs = 30_000, env?: NodeJS.ProcessEnv): Run {
  const r = dockerSpawnSync(args, { timeoutMs, env: env ?? process.env, maxBuffer: 16 * 1024 * 1024 });
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') throw new BuilderError('docker-missing', `\`${dockerBin()}\` is not on PATH`);
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ----------------------------------------------------------------- identity */

/** Length-prefixed encoding, so no two different tuples hash the same bytes. */
function lp(...parts: string[]): string {
  return parts.map((p) => `${Buffer.byteLength(p)}:${p}`).join('');
}
function dataReal(): string {
  const d = dataDir();
  try { return fs.realpathSync(d); } catch { return path.resolve(d); }
}
/**
 * Which Orchard data dir a builder belongs to (so a scratch server never touches the live server's builders).
 * BUG-216: this IS the instance owner key — one authority (`instance-owner.ts`) for builders, images,
 * containers, networks and volumes alike.
 */
export function dataKey(): string {
  return ownerKey();
}
/** The builder (container AND volume) name for a project on a repo, under this data dir. */
export function builderName(projectId: string, repoKey: string): string {
  const h = crypto.createHash('sha256').update(lp('orchard-builder', dataReal(), projectId, repoKey)).digest('hex').slice(0, 24);
  return `${BUILDER_NAME_PREFIX}${h}`;
}
function expectedLabels(projectId: string, repoKey: string): Record<string, string> {
  return {
    [LABEL_BUILDER]: '1',
    [LABEL_BUILDER_PROJECT]: projectId,
    [LABEL_BUILDER_REPO]: repoKey,
    [LABEL_BUILDER_DATA]: dataKey(),
    [LABEL_BUILDER_CONFIG]: BUILDER_CONFIG_VERSION,
  };
}
/** Does a label set say "this project's builder, on this repo, under this data dir"? (config version not included: that is compatibility, not ownership) */
function ownedBy(labels: Record<string, string> | null | undefined, projectId: string, repoKey: string): boolean {
  const l = labels ?? {};
  return l[LABEL_BUILDER] === '1' && l[LABEL_BUILDER_PROJECT] === projectId && l[LABEL_BUILDER_REPO] === repoKey && l[LABEL_BUILDER_DATA] === dataKey();
}

function builderCpus(): string {
  return String(Math.max(1, Math.floor(os.cpus().length / 2)));
}
function builderCmd(): string[] {
  return ['--oci-worker-gc', `--oci-worker-gc-keepstorage=${GC_KEEP_MB}`];
}
const SEC_OPTS = ['seccomp=unconfined', 'apparmor=unconfined', 'systempaths=unconfined'];

/* ------------------------------------------------------------------- locks */

/**
 * Every builder operation of ONE project (build, stop, delete, reset) runs inside that project's
 * lifecycle operation (ARCH-022): the authority's FIFO slot is the one serialisation, so this is no
 * longer a second queue (a second queue is a second lock order). It only asserts the caller is in it.
 */
export function withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const op = currentOp();
  if (!op || op.projectId !== projectId) {
    return Promise.reject(new BuilderError('not-in-operation', `a build-state change for project ${projectId} must run inside that project's lifecycle operation (ARCH-022)`));
  }
  return fn();
}

let running = 0;
const waiting: (() => void)[] = [];
/** At most MAX_CONCURRENT_BUILDS project builds at once on this server. */
export async function withBuildSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT_BUILDS) await new Promise<void>((r) => waiting.push(r));
  running++;
  try { return await fn(); } finally { running--; waiting.shift()?.(); }
}

/* ---------------------------------------------------------------- builder */

interface Inspect {
  Id: string;
  Image: string;
  State: { Running: boolean };
  Config: { Labels: Record<string, string> | null; Cmd: string[] | null; User: string; Env: string[] | null };
  HostConfig: {
    Privileged: boolean; SecurityOpt: string[] | null; PortBindings: Record<string, unknown> | null; NetworkMode: string;
    CapAdd: string[] | null; Devices: unknown[] | null; Memory: number; PidsLimit: number | null; NanoCpus: number;
    Binds: string[] | null; PidMode: string; IpcMode: string; UsernsMode: string; VolumesFrom: string[] | null;
    MaskedPaths: string[] | null; ReadonlyPaths: string[] | null;
  };
  Mounts: { Type: string; Name?: string; Source: string; Destination: string; RW: boolean }[];
}
function inspectContainer(name: string): Inspect | null {
  const r = dockerSync(['container', 'inspect', name], 20_000);
  if (r.code !== 0) return null;
  try { return (JSON.parse(r.stdout) as Inspect[])[0] ?? null; } catch { return null; }
}
function volumeLabels(name: string): Record<string, string> | null | undefined {
  const r = dockerSync(['volume', 'inspect', name, '--format', '{{json .Labels}}'], 20_000);
  if (r.code !== 0) return undefined; // absent
  try { return JSON.parse(r.stdout) as Record<string, string> | null; } catch { return null; }
}

/** The local image id of the pinned builder image, pulling it (anonymously) if absent. */
export function ensureBuilderImage(env: NodeJS.ProcessEnv, log?: (s: string) => void): string {
  let r = dockerSync(['image', 'inspect', BUILDER_IMAGE, '--format', '{{.Id}}'], 20_000);
  if (r.code !== 0) {
    log?.(`[container] pulling the project builder image ${BUILDER_IMAGE.split('@')[0]} (once)\n`);
    const p = dockerSync(['pull', '-q', BUILDER_IMAGE], 15 * 60_000, env);
    if (p.code !== 0) throw new BuilderError('builder-unavailable', `could not pull the project builder image ${BUILDER_IMAGE}`, (p.stderr || p.stdout).trim().slice(0, 600));
    r = dockerSync(['image', 'inspect', BUILDER_IMAGE, '--format', '{{.Id}}'], 20_000);
  }
  const id = r.stdout.trim();
  if (r.code !== 0 || !/^sha256:[0-9a-f]{64}$/.test(id)) throw new BuilderError('builder-unavailable', `the project builder image ${BUILDER_IMAGE} is not usable`, r.stderr.trim().slice(0, 300));
  return id;
}

/**
 * Why an EXISTING builder container (already established to be ours) is not
 * the one we would create now. Empty = compatible, adopt it.
 */
export function builderConfigProblems(ins: Inspect, name: string, imageId: string): string[] {
  const p: string[] = [];
  const hc = ins.HostConfig;
  if ((ins.Config.Labels ?? {})[LABEL_BUILDER_CONFIG] !== BUILDER_CONFIG_VERSION) p.push('config version');
  if (ins.Image !== imageId) p.push(`image ${ins.Image} != ${imageId}`);
  if (hc.Privileged) p.push('privileged');
  // `systempaths=unconfined` is not echoed in SecurityOpt; docker records it as
  // empty MaskedPaths/ReadonlyPaths, so compare what inspect actually reports.
  if (JSON.stringify([...(hc.SecurityOpt ?? [])].sort()) !== JSON.stringify(SEC_OPTS.filter((o) => !o.startsWith('systempaths=')).sort())) p.push(`security opts ${JSON.stringify(hc.SecurityOpt)}`);
  if ((hc.MaskedPaths ?? []).length || (hc.ReadonlyPaths ?? []).length) p.push('system paths');
  if ((hc.CapAdd ?? []).length) p.push('added capabilities');
  if ((hc.Devices ?? []).length) p.push('devices');
  if (Object.keys(hc.PortBindings ?? {}).length) p.push('published ports');
  if (!['bridge', 'default'].includes(hc.NetworkMode)) p.push(`network ${hc.NetworkMode}`);
  if (hc.PidMode || hc.UsernsMode || !['private', 'shareable', ''].includes(hc.IpcMode)) p.push('namespace sharing');
  if ((hc.VolumesFrom ?? []).length) p.push('volumes-from');
  if ((ins.Config.User ?? '') !== '1000:1000') p.push(`user ${ins.Config.User}`);
  if (JSON.stringify(ins.Config.Cmd ?? []) !== JSON.stringify(builderCmd())) p.push(`cmd ${JSON.stringify(ins.Config.Cmd)}`);
  if (hc.Memory !== parseMem(BUILDER_MEMORY) || hc.PidsLimit !== BUILDER_PIDS || hc.NanoCpus !== Number(builderCpus()) * 1e9) p.push('limits');
  const mounts = ins.Mounts ?? [];
  if (mounts.length !== 1 || mounts[0]!.Type !== 'volume' || mounts[0]!.Name !== name || mounts[0]!.Destination !== STATE_PATH) p.push(`mounts ${JSON.stringify(mounts.map((m) => `${m.Type}:${m.Name ?? m.Source}->${m.Destination}`))}`);
  return p;
}
function parseMem(s: string): number {
  const m = /^(\d+)([kmg])$/i.exec(s);
  return m ? Number(m[1]) * { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2]!.toLowerCase() as 'k' | 'm' | 'g'] : 0;
}

/**
 * Make this project's builder exist, be ours, match the expected config and be
 * running + answering. FAILS CLOSED on anything whose ownership is not
 * established: a container or volume under our name that does not carry this
 * project's labels is refused and left alone, never removed.
 */
export async function ensureBuilder(projectId: string, repoKey: string, env: NodeJS.ProcessEnv, log?: (s: string) => void): Promise<string> {
  const name = builderName(projectId, repoKey);
  const imageId = ensureBuilderImage(env, log);
  let ins = inspectContainer(name);
  if (ins && !ownedBy(ins.Config.Labels, projectId, repoKey)) {
    throw new BuilderError('builder-foreign', `a container named ${name} exists but is not this project's builder; Orchard will not use or remove it`);
  }
  const vol = volumeLabels(name);
  if (vol !== undefined && !ownedBy(vol, projectId, repoKey)) {
    throw new BuilderError('builder-foreign', `a volume named ${name} exists but is not this project's builder state; Orchard will not use or remove it`);
  }
  if (ins) {
    const problems = builderConfigProblems(ins, name, imageId);
    if (problems.length) {
      log?.(`[container] recreating this project's builder (${problems.join('; ').slice(0, 200)}); its cache is kept\n`);
      dockerSync(['rm', '-f', ins.Id], 60_000); // FEAT-158 round 9: the container just checked, by id
      ins = null;
    }
  }
  const labels = expectedLabels(projectId, repoKey);
  if (vol === undefined) {
    const v = dockerSync(['volume', 'create', ...Object.entries(labels).flatMap(([k, val]) => ['--label', `${k}=${val}`]), name], 30_000);
    if (v.code !== 0) throw new BuilderError('builder-unavailable', `could not create the builder volume ${name}`, v.stderr.trim().slice(0, 300));
  }
  if (!ins) {
    log?.(`[container] creating this project's own builder ${name}\n`);
    const c = dockerSync([
      'create', '--name', name,
      ...Object.entries(labels).flatMap(([k, val]) => ['--label', `${k}=${val}`]),
      ...SEC_OPTS.flatMap((o) => ['--security-opt', o]),
      '--memory', BUILDER_MEMORY, '--memory-swap', BUILDER_MEMORY, '--cpus', builderCpus(), '--pids-limit', String(BUILDER_PIDS),
      '--network', 'bridge', '--restart', 'no',
      '--mount', `type=volume,source=${name},target=${STATE_PATH}`,
      imageId, ...builderCmd(),
    ], 60_000);
    if (c.code !== 0) throw new BuilderError('builder-unavailable', `could not create the builder container ${name}`, c.stderr.trim().slice(0, 400));
  }
  const s = dockerSync(['start', name], 60_000);
  if (s.code !== 0) throw new BuilderError('builder-unavailable', `the builder ${name} will not start`, s.stderr.trim().slice(0, 400));
  try {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const w = dockerSync(['exec', name, 'buildctl', 'debug', 'workers'], 15_000);
      if (w.code === 0 && /linux\//.test(w.stdout)) break;
      if (Date.now() > deadline) {
        const logs = dockerSync(['logs', '--tail', '20', name], 10_000);
        throw new BuilderError('builder-unavailable', `the builder ${name} did not become ready within 60 s`, sanitise(`${logs.stdout}${logs.stderr}`).slice(-1500));
      }
      await sleep(500);
    }
    ensureBuildxInstance(name, env);
  } catch (err) {
    stopBuilder(name); // started but unusable: never leave it running
    throw err;
  }
  return name;
}

/** The buildx client-side registration (a `remote` driver pointing at the container), in Orchard's own client config. */
function ensureBuildxInstance(name: string, env: NodeJS.ProcessEnv): void {
  const want = `docker-container://${name}`;
  const i = dockerSync(['buildx', 'inspect', name], 30_000, env);
  if (i.code === 0 && i.stdout.includes(want) && /Driver:\s+remote/.test(i.stdout)) return;
  if (i.code === 0) dockerSync(['buildx', 'rm', name], 30_000, env);
  const c = dockerSync(['buildx', 'create', '--name', name, '--driver', 'remote', want], 30_000, env);
  if (c.code !== 0) throw new BuilderError('builder-unavailable', `could not register the builder ${name} with buildx`, c.stderr.trim().slice(0, 300));
}

export function stopBuilder(name: string): void {
  // FEAT-158 round 9: stop only a builder of THIS data dir, by the id just inspected (a name can be re-used meanwhile).
  const ins = inspectContainer(name);
  if (!ins || ins.Config?.Labels?.[LABEL_BUILDER_DATA] !== dataKey()) return;
  try { dockerSync(['stop', '-t', '10', ins.Id], 60_000); } catch { /* best effort; the next build restarts it */ }
}

export interface BuilderInfo { name: string; projectId: string; repoKey: string; running: boolean }
/** This data dir's builders (containers). */
export function listOwnBuilders(): BuilderInfo[] {
  const r = dockerSync(['ps', '-a', '--filter', `label=${LABEL_BUILDER}=1`, '--filter', `label=${LABEL_BUILDER_DATA}=${dataKey()}`,
    '--format', `{{.Names}}\t{{.Label "${LABEL_BUILDER_PROJECT}"}}\t{{.Label "${LABEL_BUILDER_REPO}"}}\t{{.State}}`], 20_000);
  if (r.code !== 0) return [];
  return r.stdout.split('\n').filter(Boolean).map((l) => {
    const [name = '', projectId = '', repoKey = '', state = ''] = l.split('\t');
    return { name, projectId, repoKey, running: state === 'running' };
  }).filter((b) => b.name.startsWith(BUILDER_NAME_PREFIX));
}
/** This data dir's builder volumes whose container is gone (e.g. removed by hand). */
function listOwnBuilderVolumes(): { name: string; projectId: string; repoKey: string }[] {
  const r = dockerSync(['volume', 'ls', '--filter', `label=${LABEL_BUILDER}=1`, '--filter', `label=${LABEL_BUILDER_DATA}=${dataKey()}`,
    '--format', `{{.Name}}\t{{.Label "${LABEL_BUILDER_PROJECT}"}}\t{{.Label "${LABEL_BUILDER_REPO}"}}`], 20_000);
  if (r.code !== 0) return [];
  return r.stdout.split('\n').filter(Boolean).map((l) => {
    const [name = '', projectId = '', repoKey = ''] = l.split('\t');
    return { name, projectId, repoKey };
  }).filter((v) => v.name.startsWith(BUILDER_NAME_PREFIX));
}

/**
 * Remove one builder (container, its state volume, its buildx registration) —
 * each part ONLY if its own labels say it is this data dir's builder for
 * `projectId`. A name alone proves nothing: a container squatting on a
 * builder's name (next to a genuine labelled volume) is left alone.
 */
function removeBuilder(name: string, projectId: string, env: NodeJS.ProcessEnv): string[] {
  const done: string[] = [];
  const ours = (l: Record<string, string> | null | undefined) => l?.[LABEL_BUILDER] === '1' && l?.[LABEL_BUILDER_DATA] === dataKey() && l?.[LABEL_BUILDER_PROJECT] === projectId;
  const ins = inspectContainer(name);
  if (ins && ours(ins.Config.Labels)) {
    if (dockerSync(['rm', '-f', ins.Id], 60_000).code === 0) done.push(`container ${name}`);
  }
  const vl = volumeLabels(name);
  if (vl !== undefined && ours(vl)) {
    if (dockerSync(['volume', 'rm', '-f', name], 120_000).code === 0) done.push(`volume ${name}`);
  }
  if (!inspectContainer(name)) { try { dockerSync(['buildx', 'rm', name], 30_000, env); } catch { /* */ } }
  return done;
}

/**
 * Remove a project's builders — all of them, or (keepRepo) all but the one for
 * its current repo. Used by project delete and by a build-record reset (a
 * re-created project on another repo must never inherit the old cache).
 */
export function removeProjectBuilders(projectId: string, env: NodeJS.ProcessEnv, opts: { keepRepo?: string } = {}): string[] {
  const names = new Set<string>();
  for (const b of listOwnBuilders()) if (b.projectId === projectId && b.repoKey !== opts.keepRepo) names.add(b.name);
  for (const v of listOwnBuilderVolumes()) if (v.projectId === projectId && v.repoKey !== opts.keepRepo) names.add(v.name);
  return [...names].flatMap((n) => removeBuilder(n, projectId, env));
}

/** Builders (and stray volumes) of this data dir whose project is no longer registered. */
export function findOrphanBuilders(known: Set<string>): { name: string; projectId: string }[] {
  const seen = new Map<string, string>();
  for (const b of listOwnBuilders()) if (!known.has(b.projectId)) seen.set(b.name, b.projectId);
  for (const v of listOwnBuilderVolumes()) if (!known.has(v.projectId)) seen.set(v.name, v.projectId);
  return [...seen].map(([name, projectId]) => ({ name, projectId }));
}

/* ------------------------------------------------------------ disk + staging */

function stagingRoot(): string {
  return path.join(dataDir(), 'build-staging');
}
const activeStaging = new Set<string>();
/** A fresh staging dir for one build; stale ones (a crash, a restart) are removed first. */
export function newStagingDir(): string {
  const root = stagingRoot();
  ensureDir(root);
  for (const d of fs.readdirSync(root)) {
    const p = path.join(root, d);
    if (!activeStaging.has(p)) fs.rmSync(p, { recursive: true, force: true });
  }
  const dir = path.join(root, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(dir, { mode: 0o700 });
  activeStaging.add(dir);
  return dir;
}
export function releaseStagingDir(dir: string): void {
  activeStaging.delete(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Refuse to start a build when the docker root or the staging filesystem is short of space. */
export function diskPreflight(stagingDir: string): void {
  const min = minFreeBytes();
  const info = dockerSync(['info', '--format', '{{.DockerRootDir}}'], 20_000);
  const roots = [stagingDir];
  if (info.code === 0 && info.stdout.trim()) roots.push(info.stdout.trim());
  for (const p of roots) {
    let free: number;
    try { const s = fs.statfsSync(p); free = s.bavail * s.bsize; } catch { continue; } // unreadable (e.g. root-owned docker dir): the staging check still ran
    if (free < min) {
      throw new BuilderError('disk-low', `not enough free disk to build (${(free / 1024 ** 3).toFixed(1)} GiB free on ${p}; a project build needs at least ${(min / 1024 ** 3).toFixed(0)} GiB) — free some space, then press Rebuild`);
    }
  }
}

/* ------------------------------------------------------------- the import */

const MANIFEST_TYPES = new Set(['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json']);
const CONFIG_TYPES = new Set(['application/vnd.oci.image.config.v1+json', 'application/vnd.docker.container.image.v1+json']);
const LAYER_TYPES = new Set([
  'application/vnd.oci.image.layer.v1.tar', 'application/vnd.oci.image.layer.v1.tar+gzip', 'application/vnd.oci.image.layer.v1.tar+zstd',
  'application/vnd.docker.image.rootfs.diff.tar.gzip',
]);
interface Descriptor { mediaType?: string; digest?: string; size?: number; urls?: unknown; [k: string]: unknown }
export interface CheckedLayout { manifest: { mediaType: string; digest: string; size: number }; configDigest: string; blobs: string[] }

function hexOf(d: unknown): string {
  if (typeof d !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(d)) throw new BuilderError('layout-rejected', `a descriptor digest is not sha256:<64 hex> (${JSON.stringify(d).slice(0, 80)})`);
  return d.slice(7);
}
function readSmallJson(file: string, max: number): unknown {
  const st = fs.lstatSync(file);
  if (!st.isFile()) throw new BuilderError('layout-rejected', `${path.basename(file)} is not a regular file`);
  if (st.size > max) throw new BuilderError('layout-rejected', `${path.basename(file)} is larger than ${max} bytes`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new BuilderError('layout-rejected', `${path.basename(file)} is not valid JSON`); }
}
async function sha256File(file: string): Promise<string> {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/**
 * Check the OCI layout a builder exported, BEFORE anything reaches the host
 * image store. The builder is treated as untrusted: every entry must be a
 * regular file or directory at a known path (no links, devices, FIFOs); the
 * index must name exactly one image manifest; the manifest, its config and
 * every layer must exist with the declared size AND digest; only known media
 * types; no foreign `urls`. Returns exactly what may be imported.
 */
export async function checkOciLayout(dir: string): Promise<CheckedLayout> {
  const walk = (rel: string): void => {
    const abs = path.join(dir, rel);
    const st = fs.lstatSync(abs);
    const okDir = rel === '' || rel === 'blobs' || rel === 'blobs/sha256' || rel === 'ingest';
    const okFile = rel === 'oci-layout' || rel === 'index.json' || /^blobs\/sha256\/[0-9a-f]{64}$/.test(rel);
    if (st.isDirectory() && okDir) {
      const kids = fs.readdirSync(abs);
      if (rel === 'ingest' && kids.length) throw new BuilderError('layout-rejected', 'the exported layout has unexpected files under ingest/');
      for (const k of kids) walk(rel ? `${rel}/${k}` : k);
      return;
    }
    if (st.isFile() && okFile) return;
    throw new BuilderError('layout-rejected', `the exported layout contains an unexpected ${st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'special file'}: ${JSON.stringify(rel).slice(0, 120)}`);
  };
  walk('');
  const blobPath = (hex: string) => path.join(dir, 'blobs', 'sha256', hex);
  const idx = readSmallJson(path.join(dir, 'index.json'), 1024 * 1024) as { manifests?: Descriptor[] };
  const ms = Array.isArray(idx?.manifests) ? idx.manifests : [];
  if (ms.length !== 1) throw new BuilderError('layout-rejected', `the exported index lists ${ms.length} manifests; exactly one image is expected`);
  const md = ms[0]!;
  if (!MANIFEST_TYPES.has(String(md.mediaType))) throw new BuilderError('layout-rejected', `unexpected manifest media type ${JSON.stringify(md.mediaType).slice(0, 80)}`);
  let total = 0;
  const verify = async (d: Descriptor, types: Set<string>, what: string): Promise<string> => {
    const hex = hexOf(d.digest);
    if (!types.has(String(d.mediaType))) throw new BuilderError('layout-rejected', `unexpected ${what} media type ${JSON.stringify(d.mediaType).slice(0, 80)}`);
    if (d.urls !== undefined) throw new BuilderError('layout-rejected', `a ${what} descriptor carries foreign urls`);
    if (typeof d.size !== 'number' || !Number.isSafeInteger(d.size) || d.size < 0) throw new BuilderError('layout-rejected', `a ${what} descriptor has no valid size`);
    let st: fs.Stats;
    try { st = fs.lstatSync(blobPath(hex)); } catch { throw new BuilderError('layout-rejected', `the ${what} blob ${hex.slice(0, 12)} is missing`); }
    if (!st.isFile() || st.size !== d.size) throw new BuilderError('layout-rejected', `the ${what} blob ${hex.slice(0, 12)} is not ${d.size} bytes`);
    total += st.size;
    if (total > MAX_LAYOUT_BYTES) throw new BuilderError('layout-rejected', 'the exported image is larger than Orchard imports');
    if (await sha256File(blobPath(hex)) !== hex) throw new BuilderError('layout-rejected', `the ${what} blob ${hex.slice(0, 12)} does not match its digest`);
    return hex;
  };
  const mhex = await verify(md, MANIFEST_TYPES, 'manifest');
  if (md.size! > 4 * 1024 * 1024) throw new BuilderError('layout-rejected', 'the manifest is implausibly large');
  const man = readSmallJson(blobPath(mhex), 4 * 1024 * 1024) as { mediaType?: string; config?: Descriptor; layers?: Descriptor[]; manifests?: unknown };
  if (man.manifests !== undefined || !man.config || !Array.isArray(man.layers)) throw new BuilderError('layout-rejected', 'the manifest is not a single-image manifest');
  if (man.mediaType !== undefined && man.mediaType !== md.mediaType) throw new BuilderError('layout-rejected', 'the manifest media type disagrees with its descriptor');
  const chex = await verify(man.config, CONFIG_TYPES, 'config');
  const blobs = new Set([mhex, chex]);
  for (const l of man.layers) blobs.add(await verify(l, LAYER_TYPES, 'layer'));
  return { manifest: { mediaType: String(md.mediaType), digest: `sha256:${mhex}`, size: md.size! }, configDigest: `sha256:${chex}`, blobs: [...blobs] };
}

/**
 * Import a checked layout under exactly one Orchard-chosen name. Orchard
 * writes the index (and oci-layout) itself, and tars only the blobs the check
 * returned, so nothing the builder wrote can name or retag a host image.
 * Returns the image id the host store gave it.
 */
export async function importCheckedLayout(dir: string, layout: CheckedLayout, ref: string, timeoutMs: number): Promise<string> {
  const full = ref.includes('/') ? ref : `docker.io/library/${ref}`;
  const tag = ref.slice(ref.lastIndexOf(':') + 1);
  fs.writeFileSync(path.join(dir, 'oci-layout'), JSON.stringify({ imageLayoutVersion: '1.0.0' }));
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({
    schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [{ ...layout.manifest, annotations: { 'io.containerd.image.name': full, 'org.opencontainers.image.ref.name': tag } }],
  }));
  const members = ['oci-layout', 'index.json', ...layout.blobs.map((h) => `blobs/sha256/${h}`)];
  const out = await new Promise<Run>((resolve, reject) => {
    const tar = spawn('tar', ['-C', dir, '--no-recursion', '-cf', '-', ...members], { stdio: ['ignore', 'pipe', 'pipe'] });
    const load = dockerSpawn(['load'], { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcess & { stdin: Writable; stdout: Readable; stderr: Readable };
    let so = ''; let se = ''; let te = '';
    const timer = setTimeout(() => { tar.kill('SIGKILL'); load.kill('SIGKILL'); reject(new BuilderError('import-failed', 'docker load timed out')); }, timeoutMs);
    tar.stdout.pipe(load.stdin);
    tar.stderr.on('data', (d) => { te = (te + String(d)).slice(-2000); });
    load.stdout.on('data', (d) => { so = (so + String(d)).slice(-8000); });
    load.stderr.on('data', (d) => { se = (se + String(d)).slice(-8000); });
    load.stdin.on('error', () => { /* load exited early; its code says why */ });
    let tarCode = -1;
    tar.on('close', (c) => { tarCode = c ?? -1; });
    load.on('error', (e) => { clearTimeout(timer); reject(new BuilderError('import-failed', `docker load failed: ${e.message}`)); });
    load.on('close', (c) => { clearTimeout(timer); resolve({ code: c === 0 && tarCode === 0 ? 0 : (c || tarCode || -1), stdout: so, stderr: se + te }); });
  });
  const loaded = [...out.stdout.matchAll(/^Loaded image(?: ID)?: (\S+)$/gm)].map((m) => m[1]);
  if (out.code !== 0 || loaded.length !== 1 || loaded[0] !== ref) {
    throw new BuilderError('import-failed', `importing the built image failed${loaded.length ? ` (loaded: ${loaded.join(', ').slice(0, 200)})` : ''}`, sanitise(out.stderr || out.stdout).slice(-800));
  }
  const id = dockerSync(['image', 'inspect', ref, '--format', '{{.Id}}'], 20_000).stdout.trim();
  if (id !== layout.manifest.digest && id !== layout.configDigest) {
    throw new BuilderError('import-failed', `the imported image ${ref} is ${id.slice(0, 19)}, not the checked manifest ${layout.manifest.digest.slice(0, 19)}`);
  }
  return id;
}

function sanitise(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}
