/**
 * Per-project Docker isolation.
 *
 * WHY THE DOCKER CLI AND NOT DOCKERODE
 * ------------------------------------
 * 1. No new dependency. This project ships `ws` + the Agent SDK and nothing
 *    else; a Docker API client is a large surface to take on for `create`,
 *    `start`, `inspect`, `exec`.
 * 2. `docker exec -i` gives us clean, already-demuxed stdin/stdout pipes, which
 *    is exactly the shape the Agent SDK's process transport wants. Dockerode's
 *    exec stream is a single multiplexed stream that would have to be
 *    de-framed by hand before the SDK could read stream-json off it.
 * 3. `docker inspect --format '{{json .}}'` returns the same structures the API
 *    would, so drift detection loses nothing.
 *
 * The cost is process spawns per operation; these are user-initiated and rare,
 * and inspect results are cached (see `statusOf`).
 *
 * SAFETY MODEL
 * ------------
 * A container gets exactly: its own project directory, the Claude credentials
 * file, this project's own session-history directory, and whatever extra mounts
 * the project explicitly declares. Not the host home, not other projects, not
 * the docker socket (unless the project opts in — which hands it root on the
 * host, and says so in the UI-visible warning below).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { dockerBin, dockerSpawn, dockerSpawnSync, dockerSpawnSyncBuffer } from './docker-exec.ts';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { projectRoot, ensureDir, dataDir } from '../lib/paths.ts';
import type { Project, Mount, ContainerSettings } from './registry.ts';
import { containerSettingsOf, browserSettingsOf, toolSettingsOf } from './registry.ts';
// FEAT-145 step 6 — the account layer. `applyGlobalDefaults` is the shared
// machine→project merge (agent-bridge's `pickOverridable` is the other caller);
// `resolveAccountDir` is the sole id→dir authority (ARCH-010) and
// `resolveLaunchAccountDir` the sole "may a launch use this account" gate.
import { applyGlobalDefaults } from './global-settings.ts';
import { AccountError, DEFAULT_ACCOUNT_ID, resolveAccountDir, resolveLaunchAccountDir } from './claude-accounts.ts';
import { provisionHash, recipeHash, serenaPin, type ProvisionState } from './provisioning.ts';
// FEAT-157 — the release catalog, the pin and the ONE target policy (security floor included).
import * as baseRel from './base-releases.ts';
import { listProjects, updateProject } from './registry.ts';
// FEAT-157 — the CLI a container needs is the host SDK's own boot-proven bundled binary.
import * as rtUpdate from './runtime/runtime-update.ts';
import {
  readProjectDockerfile, dockerfileHash, projectImageRepo, buildRecord, updateBuildRecord,
  appendBuildLog, sanitiseBuildLog, DF_TAG_RE, CAND_TAG_RE, LABEL_DF_PROJECT, LABEL_DF_HASH,
  LABEL_DF_REPO, LABEL_DF_DATA, repoIdentity, resetBuildRecord, forgetBuildRecord, type BuildRecord,
} from './project-dockerfile.ts';
import {
  BUILDER_IMAGE, BuilderError, dataKey, ensureBuilder, stopBuilder, withProjectLock, withBuildSlot, newStagingDir, releaseStagingDir,
  diskPreflight, checkOciLayout, importCheckedLayout, removeProjectBuilders, findOrphanBuilders,
} from './project-builder.ts';
import * as lifecycle from './lifecycle.ts';
import { ensureServices, connectSessionToServices, teardownServices, orphanServiceProjects, reapProjectServiceInfra } from './service-manager.ts';
import { LABEL_OWNER, ownerKey, ownerLabelArgs, ownershipOf, mayActOn, type Ownership } from './instance-owner.ts';
import { available as browserAvailable, browserBinds, containerEnv as browserContainerEnv, socketPath as browserSocketPath, stateHome as browserStateHome, CONTAINER_MCP_DIR } from './browser.ts';
import { dispatchBinds, dispatchSocketPath, dispatchStateHome, CONTAINER_DISPATCH_DIR, CONTAINER_DISPATCH_SOCKET_DIR } from './dispatch-broker.ts';

/* --------------------------------------------------------------- constants */

/** Path the CLI is invoked at INSIDE the container. Must match the Dockerfile. */
export const CONTAINER_CLAUDE_BIN = '/home/claude/.local/bin/claude';
/** $HOME inside the container. Must match the Dockerfile's `claude` user. */
export const CONTAINER_HOME = '/home/claude';
/** Parent of every project's container working dir. */
export const CONTAINER_WORKSPACE = '/workspace';

const IMAGE_REPO = 'claude-station-base';
const NAME_PREFIX = lifecycle.SESSION_NAME_PREFIX;
/** FEAT-157 — the one-file Claude CLI layer Orchard adds on top of what a project runs on. */
const RUNTIME_REPO = 'claude-station-rt';
/** FEAT-157 — labels Orchard stamps (and a project image cannot spoof: CLI/create labels win). */
const LABEL_BASE_REF = 'claude-station.base-ref';
const LABEL_BASE_VERSION = 'claude-station.base-version';
const LABEL_RUNTIME = 'claude-station.runtime';
const LABEL_CLI_VERSION = 'claude-station.cli-version';
const LABEL_CLI_SHA = 'claude-station.cli-sha256';
const LABEL_RUNTIME_PARENT = 'claude-station.runtime-parent';
/** The CLI version baked into a LEGACY base (FEAT-151 era); v1+ bases carry none. */
const LABEL_LEGACY_CLI = 'claude-station.claude-version';
/** How long an inspect result may be reused before we re-check liveness. */
const STATUS_TTL_MS = 1500;

const CAP_DROP = [
  'SYS_ADMIN',
  'NET_ADMIN',
  'NET_RAW',
  'SYS_PTRACE',
  'MKNOD',
  'AUDIT_WRITE',
  'SETFCAP',
];

/* ------------------------------------------------------------------- errors */

/**
 * Thrown for every container failure. Carries a stable `code` so the HTTP layer
 * and the session layer can render something better than a raw docker string —
 * and so a failure can NEVER be mistaken for "fall back to running on the host".
 */
export class ContainerError extends Error {
  readonly code: string;
  readonly detail: string;
  constructor(code: string, message: string, detail = '') {
    super(detail ? `${message}\n${detail}` : message);
    this.name = 'ContainerError';
    this.code = code;
    this.detail = detail;
  }
}

/* ---------------------------------------------------------------- docker io */

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function dockerSync(args: string[], timeoutMs = 30_000): RunResult {
  const r = dockerSpawnSync(args, { timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  if (r.error) {
    const e = r.error as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      throw new ContainerError('docker-missing', `\`${dockerBin()}\` is not on PATH — Docker is required for isolation "container".`);
    }
    throw new ContainerError('docker-failed', `docker ${args[0]} failed: ${e.message}`);
  }
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Run an arbitrary host binary (e.g. nvidia-smi) — a missing binary is a
 *  normal "not supported" answer here, not a thrown docker error. */
function hostBin(bin: string, args: string[], timeoutMs = 8_000): RunResult {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  if (r.error) {
    const e = r.error as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return { code: 127, stdout: '', stderr: `${bin} not found on PATH` };
    return { code: -1, stdout: '', stderr: e.message };
  }
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function dockerAsync(args: string[], timeoutMs: number, onLine?: (s: string) => void): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = dockerSpawn(args, { stdio: ['ignore', 'pipe', 'pipe'] }) as ChildProcess & { stdout: Readable; stderr: Readable };
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new ContainerError('docker-timeout', `docker ${args[0]} timed out after ${Math.round(timeoutMs / 1000)}s`, stderr.slice(-2000)));
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += d;
      onLine?.(String(d));
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      onLine?.(String(d));
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      const e = err as NodeJS.ErrnoException;
      reject(
        e.code === 'ENOENT'
          ? new ContainerError('docker-missing', `\`${dockerBin()}\` is not on PATH — Docker is required for isolation "container".`)
          : new ContainerError('docker-failed', `docker ${args[0]} failed: ${err.message}`),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** One-time-ish daemon reachability check. Cheap enough to not cache hard. */
export function dockerAvailable(): { ok: boolean; message: string } {
  let r: RunResult;
  try {
    r = dockerSync(['version', '--format', '{{.Server.Version}}'], 10_000);
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
  if (r.code !== 0) return { ok: false, message: `docker daemon unreachable: ${(r.stderr || r.stdout).trim().slice(0, 400)}` };
  const v = r.stdout.trim();
  if (!v) return { ok: false, message: 'docker reported an empty server version — daemon not reachable' };
  return { ok: true, message: v };
}

/**
 * Does THIS host actually support GPU passthrough into a container? The single
 * authority behind `gpu: 'auto'` (ARCH-010: one owner, every reader reads it).
 *
 * Two things must both be true, and neither implies the other:
 *  - `nvidia-smi` on the host — the driver + a visible GPU exist. (The presence
 *    of /dev/nvidia* is the kernel side; nvidia-smi proves the userspace half.)
 *  - the docker daemon can actually pass it through: either an `nvidia` runtime
 *    is registered (`docker info` Runtimes) or CDI is configured (`nvidia.com/gpu`
 *    devices). Without one of these, `--gpus all` fails at create time — a host
 *    can have a perfectly good GPU and still not be wired into docker, which is
 *    EXACTLY this machine's state until nvidia-container-toolkit is installed.
 *
 * Everything degrades to `false` on any error: 'auto' must never turn a GPU on
 * it cannot prove is passable, or every container on a mis-wired host fails to
 * create. `reason` is for the status surface so the user learns WHY auto is off.
 */
let gpuProbeCache: { at: number; result: { ok: boolean; reason: string } } | null = null;
const GPU_PROBE_TTL_MS = 60_000;

export function hostGpuAvailable(): { ok: boolean; reason: string } {
  if (gpuProbeCache && Date.now() - gpuProbeCache.at < GPU_PROBE_TTL_MS) return gpuProbeCache.result;
  const result = probeHostGpu();
  gpuProbeCache = { at: Date.now(), result };
  return result;
}

function probeHostGpu(): { ok: boolean; reason: string } {
  /*
   * The device node is the stable fact; `nvidia-smi` is a process that can take
   * seconds under heavy GPU load, and this probe runs synchronously on the
   * server's event loop. So when /dev/nvidia0 exists it is not run at all (a
   * slow probe must neither stall every request nor flip 'auto' off, which
   * would recreate a running container WITHOUT its GPU); nvidia-smi is only
   * asked, briefly, when there is no device node.
   */
  const devNode = fs.existsSync('/dev/nvidia0');
  const smi = devNode ? { code: 0, stdout: '', stderr: '' } : hostBin('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], 3_000);
  const smiOk = !devNode && smi.code === 0 && !!smi.stdout.trim();
  if (!smiOk && !devNode) {
    return { ok: false, reason: `no host GPU (no /dev/nvidia0, and nvidia-smi ${smi.code === 0 ? 'listed none' : `failed or is missing (exit ${smi.code})`})` };
  }
  // CDI spec files first: a plain file check, no daemon round-trip. Only when
  // there is none is the daemon asked for an nvidia runtime — and that call can
  // time out or find no docker at all, which must degrade to "not passable"
  // (this function's contract), never throw into statusOf / drift / ensure.
  const cdiDir = ['/etc/cdi', '/var/run/cdi'].some((d) => {
    try { return fs.readdirSync(d).some((f) => /nvidia/i.test(f)); } catch { return false; }
  });
  let hasNvidiaRuntime = false;
  if (!cdiDir) {
    try {
      const info = dockerSync(['info', '--format', '{{json .Runtimes}}'], 5_000);
      hasNvidiaRuntime = info.code === 0 && /"nvidia"/i.test(info.stdout);
    } catch (err) {
      // No ANSWER is not a "no": keep the last proven-passable verdict rather
      // than flip 'auto' off (which would recreate a container without its GPU).
      if (lastPassableGpu) return lastPassableGpu;
      return { ok: false, reason: `could not ask docker for an nvidia runtime (${(err as Error).message.slice(0, 160)})` };
    }
  }
  if (!hasNvidiaRuntime && !cdiDir) {
    return { ok: false, reason: 'host GPU present but docker has no nvidia runtime or CDI — install nvidia-container-toolkit and configure the docker runtime' };
  }
  lastPassableGpu = { ok: true, reason: `GPU passable (${smiOk ? smi.stdout.trim().split('\n')[0] : '/dev/nvidia0 present'})` };
  return lastPassableGpu;
}
let lastPassableGpu: { ok: boolean; reason: string } | null = null;

/** Whether GPU passthrough should be applied for this project right now. */
export function gpuEnabled(project: Project): boolean {
  const g = containerSettingsOf(project).gpu;
  if (g === 'off') return false;
  if (g === 'on') return true;
  return hostGpuAvailable().ok; // 'auto'
}

/* ------------------------------------------------------------------- naming */

export function containerName(projectId: string): string {
  return lifecycle.sessionContainerName(projectId); // ARCH-022: one owner of the name
}

/**
 * FEAT-155 item 3 — TWO FACTS, ONE OWNER, AND THEY ARE DELIBERATELY SEPARATE.
 *
 *  1. WHERE THE ENGINE RUNS inside the container: `containerWorkdir(project)`.
 *     `/workspace/<id>` by default; bare `/workspace` when the project opts in
 *     with `container.workspaceRoot` (scripts that hardcode `/workspace/...`).
 *  2. WHICH HOST STORE DIR HOLDS THE PROJECT'S SESSION HISTORY:
 *     `containerStoreDirName(project)`. ALWAYS `-workspace-<id>` — the
 *     byte-identical name every container project has used since per-id
 *     workdirs landed — and it never follows the cwd.
 *
 * They used to be one fact: every reader re-encoded the container cwd to find
 * the store. That only held while the cwd was unique per project. Claude Code
 * names its store from cwd, so a bare `/workspace` encodes to `-workspace` for
 * EVERY project that opts in — re-deriving would merge unrelated projects'
 * histories on the host (and orphan the existing `-workspace-<id>`). So the
 * store identity is declared here, keyed on the project id, and readers read it
 * (ARCH-010). Only the CONTAINER side of the history bind follows the cwd: host
 * `-workspace-<id>` is mounted at whatever dir name the in-container CLI will
 * write to, which is private to that container and so cannot collide.
 */
export function containerWorkdir(project: Pick<Project, 'id' | 'settings'>): string {
  return containerSettingsOf(project as Project).workspaceRoot === true ? CONTAINER_WORKSPACE : `${CONTAINER_WORKSPACE}/${project.id}`;
}

/**
 * The cwd whose store encoding IS this project's host store dir. Not where
 * anything runs any more — it is the ADDRESS the SDK's session-mutation APIs
 * (which take a `dir` and encode it) need in order to reach
 * `containerStoreDirName`.
 */
export function containerStoreAddress(project: Pick<Project, 'id'>): string {
  return `${CONTAINER_WORKSPACE}/${project.id}`;
}

/**
 * The inverse of `containerStoreDirName`: the store ADDRESS (`/workspace/<id>`)
 * of a per-project container store dir, or null when the name is not one.
 * Exact, not a guess: project ids are [a-z0-9-], which the store encoding keeps
 * verbatim, so `-workspace-<id>` maps back to exactly one address.
 */
export function containerStoreAddressOfDir(encodedDir: string): string | null {
  const m = /^-workspace-([a-z0-9][a-z0-9-]*)$/.exec(encodedDir);
  return m ? `${CONTAINER_WORKSPACE}/${m[1]}` : null;
}

/** The host store dir NAME for a containerised project's session history. See above. */
export function containerStoreDirName(project: Pick<Project, 'id'>): string {
  return encodeCwdForStore(containerStoreAddress(project));
}

/**
 * cwd -> session-store dir name. Same rule Claude Code uses: EVERY
 * non-alphanumeric collapses to '-'. Not `slugify()` from lib/paths — that one
 * also lowercases and squeezes runs, which would produce a different directory
 * than the one the CLI actually writes to.
 */
export function encodeCwdForStore(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Host dir holding a containerised project's session history. Kept (not deleted)
 * when the project is removed — it is the user's own transcript data.
 */
export function containerHistoryDir(project: Pick<Project, 'id'>): string {
  return path.join(os.homedir(), '.claude', 'projects', containerStoreDirName(project));
}

/**
 * The image tag a project SHOULD be running.
 *
 * BUG-107 — THE TAG CARRIES A HASH OF THE DEFINITION, and that is the linchpin
 * of the whole fix. The tag used to be `u{uid}-g{gid}` and nothing else, so:
 * `ensureImage` skipped the build whenever that name existed, `driftReasons`
 * compared the name and found it equal, and therefore editing the Dockerfile
 * changed NOTHING the system could see. A capability was added (BUG-035's uvx
 * line), shipped, and never reached a single user — every container went on
 * running a two-week-old image, silently missing Serena.
 *
 * Folding `provisionHash()` (Dockerfile + provision.json) into the tag makes the
 * artifact's identity follow its definition, and both existing mechanisms then
 * work unchanged: a different name means `imageExists` is false (so it builds)
 * and `live.image !== wantImage` (so the container is recreated).
 *
 * WHY THE TAG AND NOT A LABEL. A label would keep one moving tag, so superseded
 * images would auto-dangle and need no cleanup — the tag's one real cost. It was
 * still the wrong trade here: with a label, `driftReasons` and `ensureImage`
 * both need a NEW image-inspect step and new comparison logic on the exact code
 * path whose silent success caused this bug, and a REVERT (say, backing out a
 * bad pin) forces a full rebuild instead of resolving to an already-built tag.
 * The tag makes the fix subtractive — a name that already changes everything
 * downstream — and `docker images` shows at a glance which definition each
 * artifact came from. The accumulation cost is paid explicitly by
 * `pruneSupersededImages()` after every successful build.
 *
 * A user-supplied `settings.container.image` is returned untouched: not ours to
 * name, not ours to build, not ours to prune.
 */
export function imageNameFor(project: Project): string {
  return imageOfPlan(imagePlanOf(project));
}

/** The image a plan names for the container: the parent (+ the CLI layer unless it already carries the host's CLI). */
function imageOfPlan(plan: ImagePlan): string {
  if (plan.source === 'custom') return plan.parent!;
  if (!plan.parent) return plan.live?.image ?? `${IMAGE_REPO}:recovery-${plan.projectId}`; // recovery: whatever it runs
  return runtimeImageNameFor(plan.parent) ?? plan.parent;
}

/* ------------------------------------------- FEAT-157: base pin → images */

function ugTag(): string {
  const { uid, gid } = hostUidGid();
  return `u${uid}-g${gid}`;
}

/** The base image ref a target names (null in recovery). */
export function baseRefOfTarget(t: baseRel.Target): string | null {
  // FEAT-157 (attack round 1): a release's identity is its version AND its recipe hash, so two checkouts (or a
  // re-cut "v2") that froze different recipes under one number can never share an image.
  if (t.kind === 'version') return `${IMAGE_REPO}:v${t.version}-${ugTag()}-${t.hash}`;
  if (t.kind === 'dev') return `${IMAGE_REPO}:dev-${ugTag()}-${provisionHash()}`;
  if (t.kind === 'legacy') return `${IMAGE_REPO}:${t.tag}`;
  return null;
}

/**
 * ARCH-022 x FEAT-157 — THE ONE ANSWER to "which image should this project's container run".
 *
 * Computed from ONE snapshot: the stored pin (registry; the owner of the DESIRED base), the release catalog (read
 * once), and what the project's container runs (inspected once; the OBSERVED artifact). Every reader takes its
 * answer from a plan — the target and base a launch builds (`resolveImage`), the recovery branch, drift, status, the
 * notice and the agent's answer path (base-updates.ts), the prune's keep-set — so no two readers can combine a pin,
 * a catalog and an observation read at different moments (the FEAT-157 attack rounds broke exactly there: the
 * notice computed a target without the observation, recovery picked its own image, the prune named its own set).
 * Inside a lifecycle operation the plan is computed once and handed down; outside one (status, the rail) it is
 * computed for display only and decides nothing.
 */
export interface ImagePlan {
  projectId: string;
  source: 'station' | 'dockerfile' | 'custom';
  /** The stored pin, or (not migrated yet) the pin the migration WOULD write; undefined = none. */
  pinRaw: unknown;
  catalog: baseRel.Catalog;
  /** The project's own container (this instance's), or null. */
  live: Inspected | null;
  observed: baseRel.ObservedBase | null;
  /** baseRel.baseTarget over the three above; null for a prebuilt image (not Orchard's). */
  target: baseRel.Target | null;
  /** The base image the target names (a legacy base: the BYTES the container runs). null: recovery or prebuilt. */
  baseRef: string | null;
  /** The image the CLI layer goes on (the base, or the project's Dockerfile image). null: recovery. */
  parent: string | null;
}

/**
 * The plan's BASE half (pin, catalog, observation, target, base) — no parent image. A Dockerfile project's parent is
 * its built image, whose identity hashes the base (`resolveProjectDockerfile` asks `baseRefFor`), so the base half
 * must be computable without the parent: reading the whole plan there recursed (measured: a status read took 104 s).
 */
function basePlanOf(project: Project, opts: { live?: Inspected | null } = {}): Omit<ImagePlan, 'parent'> {
  const source = imageSourceOf(project);
  let live: Inspected | null = null;
  if (opts.live !== undefined) live = opts.live;
  else { try { live = inspect(containerName(project.id)); } catch { live = null; } }
  if (live && !mayActOn(live.owner)) live = null; // another instance's container says nothing about ours
  const catalog = baseRel.readCatalog();
  if (source === 'custom') return { projectId: project.id, source, pinRaw: null, catalog, live, observed: null, target: null, baseRef: null };
  const observed = live ? observedBaseOf(live.image, live.imageId) : null;
  const stored = containerSettingsOf(project).base;
  const pinRaw = stored !== undefined && stored !== null ? stored
    : baseMigration.has(project.id) ? stored // migrated, then lost: missing -> recovery (finding 9)
      : migrationPinFor(project, { live, catalog }) ?? undefined;
  const target = baseRel.baseTarget(baseRel.parsePin(pinRaw), catalog, observed);
  let baseRef = baseRefOfTarget(target);
  let tgt: baseRel.Target = target;
  /*
   * ARCH-022 (d-i): a pin resolves to an IMMUTABLE image id, never a tag (attacker d, round 3: a legacy pin under the
   * CLI layer followed its tag when an old in-place rebuild moved it). A pin bound to an id names that id; a legacy
   * id that is gone is never replaced by whatever the tag names now (the launch refuses), and a release id that is
   * gone is rebuilt from its frozen recipe and the new id recorded.
   */
  if ((target.kind === 'legacy' || target.kind === 'version') && target.imageId) {
    // a station container is created FROM the id itself; a Dockerfile build names the base by tag (FROM), which the
    // launch then proves still IS that id (resolveImage) — it never builds on bytes the tag gained since.
    if (source === 'station' && (target.kind === 'legacy' || imageExists(target.imageId))) baseRef = target.imageId;
  } else if (target.kind === 'legacy' && source === 'station' && baseRef && live?.imageId) {
    // a legacy pin from before ids were recorded: the bytes the container runs, never what the tag names now
    if (live.image === live.imageId) baseRef = live.imageId; // created by id on these legacy bytes earlier
    else if (live.image === baseRef && imageIdOf(baseRef) !== live.imageId) baseRef = live.imageId;
    else if (live.image !== baseRef) {
      // it runs a layer (the CLI layer, a Dockerfile image) on a legacy base this pin never bound to an id: what the
      // tag names NOW proves nothing about the bytes underneath (layers can match while the image differs), so it is
      // never followed — the container is kept until a release is adopted (a fresh pin binds its id at first launch).
      tgt = { kind: 'recovery', why: `the legacy pin ${target.tag} records no image id, and this container runs a layer on top of it; what that tag names now is not followed` };
      baseRef = null;
    }
  }
  return { projectId: project.id, source, pinRaw, catalog, live, observed, target: tgt, baseRef };
}

export function imagePlanOf(project: Project, opts: { live?: Inspected | null } = {}): ImagePlan {
  const b = basePlanOf(project, opts);
  if (b.source === 'custom') return { ...b, parent: containerSettingsOf(project).image!.trim() };
  let parent: string | null = b.baseRef;
  if (b.baseRef && b.source === 'dockerfile') {
    // FEAT-155 round 5 — the image the Dockerfile describes unless that build failed (then: the last good one).
    const eff = dockerfileEffectiveImage(project);
    parent = eff.image ?? eff.wanted ?? `${projectImageRepo(project.id)}:unresolved`;
  }
  return { ...b, parent };
}

/** Readers of the plan (no reader derives a target, a base or an observation on its own). */
export function basePinRawOf(project: Project): unknown { return basePlanOf(project).pinRaw; }
export function baseTargetOf(project: Project): baseRel.Target {
  return basePlanOf(project).target ?? { kind: 'recovery', why: 'a prebuilt image is not built on an Orchard base' };
}
export function baseRefFor(project: Project): string | null { return basePlanOf(project).baseRef; }

/** Image labels by ref or id ({} when absent/unreadable). Cached by resolved id: an image's labels never change. */
const labelCache = new Map<string, Record<string, string>>();
function imageLabels(ref: string): Record<string, string> {
  const hit = labelCache.get(ref);
  if (hit && ref.startsWith('sha256:')) return hit;
  let r: RunResult;
  try { r = dockerSync(['image', 'inspect', ref, '--format', '{{json .Id}}\t{{json .Config.Labels}}'], 10_000); } catch { return {}; }
  if (r.code !== 0) return {};
  try {
    const [idJ = '""', labJ = 'null'] = r.stdout.trim().split('\t');
    const labels = (JSON.parse(labJ) ?? {}) as Record<string, string>;
    const id = JSON.parse(idJ) as string;
    if (/^sha256:[0-9a-f]{64}$/.test(id)) labelCache.set(id, labels);
    return labels;
  } catch { return {}; }
}

/**
 * The Claude CLI version an image ALREADY carries, per Orchard's own labels:
 * a runtime-layer image's `cli-version`, or a legacy base's baked CLI (FEAT-151,
 * inherited by Dockerfile images built on a legacy base, and re-stamped by the
 * Dockerfile build from the base it used, so a project cannot spoof it). v1+
 * bases carry none. null = unknown / none.
 */
export function carriedCliOf(ref: string): string | null {
  const l = imageLabels(ref);
  if (l[LABEL_RUNTIME] === '1') return l[LABEL_CLI_VERSION] || null;
  return l[LABEL_LEGACY_CLI] || null;
}

/** The host's CLI as the container must carry it, or null until the host runtime's boot check has passed. */
export interface HostCli { version: string; sha256: string; path: string }
function hostCliSync(): HostCli | null {
  const test = testHostCli();
  if (test) return test;
  const v = rtUpdate.BOOT_CLI_VERSION;
  const id = rtUpdate.BOOT_IDENTITY;
  const p = rtUpdate.bundledCliPath();
  return v && id && p ? { version: v, sha256: id.hash, path: p } : null;
}
async function hostCli(): Promise<HostCli> {
  const test = testHostCli();
  if (test) return test;
  await rtUpdate.whenRuntimeChecked();
  const h = hostCliSync();
  if (!h) {
    throw new ContainerError('runtime-unavailable',
      `the host Claude runtime did not pass its boot check (${rtUpdate.hostSessionBlockReason() ?? 'no proven CLI'}), so Orchard cannot give this container the CLI the host SDK speaks to. Restart Orchard; container sessions start once the host runtime is proven.`);
  }
  return h;
}

/**
 * TEST SEAM (isolated instances only): a stand-in host CLI, so a suite can exercise
 * a CLI change without swapping the real SDK. Ignored unless CLAUDE_STATION_DATA is
 * set (a scratch server) — the live instance cannot be pointed at another binary.
 */
let testCliCache: { key: string; cli: HostCli } | null = null;
function testHostCli(): HostCli | null {
  const p = process.env.ORCHARD_TEST_CONTAINER_CLI;
  const v = process.env.ORCHARD_TEST_CONTAINER_CLI_VERSION;
  if (!p || !v || !process.env.CLAUDE_STATION_DATA) return null;
  let st: fs.Stats;
  try { st = fs.statSync(p); } catch { return null; }
  const key = `${p}:${v}:${st.size}:${st.mtimeMs}:${st.ino}`;
  if (testCliCache?.key === key) return testCliCache.cli;
  const cli = { version: v, sha256: crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'), path: p };
  testCliCache = { key, cli };
  return cli;
}

/** Runtime-layer identity: parent image id + CLI bytes + uid/gid + arch. */
function runtimeTagFor(parentId: string, cli: HostCli): string {
  const { uid, gid } = hostUidGid();
  // The owner key is part of the identity (attack round 1, d): each instance makes and uses its OWN layer, so a
  // tag another instance (or anything else) put under a predictable name is never reused.
  const key = crypto.createHash('sha256').update(`${parentId}\0${cli.sha256}\0${uid}\0${gid}\0${process.arch}\0${ownerKey()}`).digest('hex').slice(0, 16);
  return `${RUNTIME_REPO}:${cli.version}-${key}`;
}

/**
 * ARCH-022 decision (b-ii) — THE one answer to "does this image carry the host's CLI": the CLI file's BYTES, proven
 * once per immutable image id and cached by that id. Labels decide nothing (attacker b, round 3: status and the prune
 * keep-set trusted a label while the launch read the bytes, and they disagreed). Launch, status and the keep-set all
 * ask this. A proof needs an operation (a never-started container is created to stream the file out), so a reader
 * outside one gets 'unknown' until the first launch has proven it; 'unknown' is treated as "not proven to carry it".
 */
export function carriesHostCli(ref: string, opts: { prove?: boolean; cliSha?: string } = {}): 'yes' | 'no' | 'unknown' {
  const want = opts.cliSha ?? hostCliSync()?.sha256;
  if (!want) return 'unknown';
  const id = imageIdOf(ref);
  if (!id) return 'unknown';
  let sha: string | null | undefined = imageCliShaCache.has(id) ? imageCliShaCache.get(id)! : undefined;
  if (sha === undefined && opts.prove) sha = imageCliSha(id);
  if (sha === undefined) return 'unknown';
  return sha === want ? 'yes' : 'no';
}

/** The runtime image a parent needs (read-only; null = the parent is PROVEN to carry the host CLI, or it cannot be named yet). */
function runtimeImageNameFor(parent: string): string | null {
  const cli = hostCliSync();
  if (!cli) return null;
  const pid = imageIdOf(parent);
  if (!pid) return null;
  if (carriesHostCli(pid, { cliSha: cli.sha256 }) === 'yes') return null;
  return runtimeTagFor(pid, cli);
}

/**
 * FEAT-157 (attack round 1, d) — the CLI an image or a running container carries is decided by its BYTES, never by
 * a label: sha256 of `CONTAINER_CLAUDE_BIN` (symlinks followed), read offline under the run-time lockdown.
 * Image results are cached by image id (immutable); container results by (container, inode, size, ctime) — a
 * replaced file changes its ctime, which a session user cannot forge.
 */
const imageCliShaCache = new Map<string, string | null>();
/**
 * (attack round 2, d) NOTHING inside the image is run to answer this — a project image can ship a lying
 * `sha256sum`/`stat`. A never-started container is created and the file (symlinks followed) is streamed out by the
 * daemon (`docker cp -L`) and hashed on the host.
 */
function imageCliSha(ref: string): string | null {
  const id = imageIdOf(ref);
  if (!id) return null;
  if (imageCliShaCache.has(id)) return imageCliShaCache.get(id)!;
  const name = `claude-station-clisha-${crypto.randomBytes(6).toString('hex')}`;
  let sha: string | null = null;
  try {
    const c = dockerSync(['create', '--name', name, '--network', 'none', '--label', 'claude-station.smoke=1', ...ownerLabelArgs(), '--entrypoint', 'true', id], 60_000);
    if (c.code === 0) sha = cpOutSha(c.stdout.trim().split('\n').pop()!.trim());
  } catch { sha = null; } finally { try { dockerSync(['rm', '-f', '-v', name], 30_000); } catch { /* */ } }
  imageCliShaCache.set(id, sha);
  return sha;
}
/** Stream `CONTAINER_CLAUDE_BIN` (symlinks followed) out of a container through the daemon and hash it host-side. */
function cpOutSha(containerId: string): string | null {
  // ARCH-022: the daemon streams the file out (a READ: docker-exec.ts is the only docker spawner); tar unpacks it
  // in memory and the bytes are hashed here. No shell, nothing run inside the container.
  const r = dockerSpawnSyncBuffer(['cp', '-L', `${containerId}:${CONTAINER_CLAUDE_BIN}`, '-'], { timeoutMs: 180_000 });
  if (r.status !== 0 || !r.stdout?.length) return null;
  const x = spawnSync('tar', ['-xO'], { input: r.stdout, timeout: 120_000, maxBuffer: 512 * 1024 * 1024 });
  if (x.status !== 0 || !x.stdout?.length) return null;
  return crypto.createHash('sha256').update(x.stdout).digest('hex');
}
/**
 * The CLI a CONTAINER would run: the file at `CONTAINER_CLAUDE_BIN`, resolved by the DAEMON inside the container's
 * own filesystem (symlinks, replaced parent directories and mounts included) and hashed on the host — nothing
 * inside the container is asked (attack rounds 2-3, d). Returns `undefined` when it cannot be read: that is NOT a
 * mismatch (attack round 3, e: an unreadable answer must never cause a destructive recreate), the caller keeps the
 * container and says so.
 */
function containerCliSha(containerId: string): string | undefined {
  try { return cpOutSha(containerId) ?? undefined; } catch { return undefined; }
}

/**
 * FEAT-157 — what a container ACTUALLY runs, reported by its image's labels
 * (finding 2: the observed artifact, never the desired pin). Every image Orchard
 * makes carries `base-ref` (the base build, the Dockerfile build and the CLI layer
 * each stamp it with a label the image cannot override); a legacy container is
 * read from its tag or its base's recipe-hash label.
 */
export function observedBaseOf(imageRef: string, imageId?: string): baseRel.ObservedBase {
  const l = imageLabels(imageId || imageRef);
  // base-ref is trusted only on images FEAT-157 code built (they always stamp the runtime key, possibly empty):
  // an older Dockerfile image could carry a base-ref LABEL of its own choosing (attack round 1, e).
  const ref = Object.prototype.hasOwnProperty.call(l, LABEL_RUNTIME) ? l[LABEL_BASE_REF] : undefined;
  const fromTag = (tag: string): baseRel.ObservedBase | null => {
    let m = /^v(\d+)-u\d+-g\d+-([0-9a-f]{12})$/.exec(tag);
    if (m) return { kind: 'version', version: Number(m[1]), hash: m[2]! };
    m = /^dev-u\d+-g\d+-([0-9a-f]{12})$/.exec(tag);
    if (m) return { kind: 'dev', hash: m[1]! };
    if (baseRel.LEGACY_TAG_RE.test(tag)) return { kind: 'legacy', tag };
    return null;
  };
  // The container's own image REF (Orchard wrote it at create) is evidence; image LABELS are only claims.
  const i = imageRef.lastIndexOf(':');
  if (imageRef.slice(0, i) === IMAGE_REPO) { const o = fromTag(imageRef.slice(i + 1)); if (o) return { ...o, via: 'tag' } as baseRel.ObservedBase; }
  if (ref) { const o = fromTag(ref); if (o) return { ...o, via: 'label' } as baseRel.ObservedBase; }
  const h = l['claude-station.provision-hash'];
  if (h && /^[0-9a-f]{12}$/.test(h) && !l[LABEL_BASE_VERSION]) return { kind: 'legacy', tag: `${ugTag()}-${h}`, via: 'label' } as baseRel.ObservedBase;
  return { kind: 'unknown' };
}

/** The observed base of a project's container, or null when it has none. */
export function observedBaseFor(project: Project): baseRel.ObservedBase | null {
  return basePlanOf(project).observed;
}

/**
 * FEAT-157 — the base-update notice as a one-turn `[station]` briefing for a
 * project's sessions: its first turn after a launch, and once more whenever the
 * notice changes (the caller keeps a seen-set keyed by `key` = id@rev). Reads the
 * project FRESH from the registry (a session's copy predates any adopt). Never
 * starts a turn; null when nothing is pending.
 */
export function baseBriefingFor(projectId: string, opts: { answerCmd?: string | null } = {}): { key: string; text: string } | null {
  let p: Project | null = null;
  try { p = listProjects().find((x) => x.id === projectId) ?? null; } catch { return null; }
  if (!p || p.isolation !== 'container') return null;
  const cat = baseRel.readCatalog();
  const n = baseRel.noticeFor({ projectId: p.id, imageSource: imageSourceOf(p), pinRaw: basePinRawOf(p), observed: observedBaseFor(p), lastError: baseApplyErrorOf(p), now: new Date(), catalog: cat });
  if (!n) return null;
  const lines = [`[station] Orchard base notice for this project: ${n.message}`];
  if (cat.ok) {
    for (const r of cat.releases.filter((x) => n.versions.includes(x.version))) {
      lines.push(`- v${r.version} (${r.class}, ${r.date}): ${r.summary}${r.adjust ? ` Adjust: ${r.adjust}` : ''}`);
    }
  } else if (n.error) lines.push(`- ${n.error}`);
  if (n.actions.length) {
    lines.push(opts.answerCmd
      ? `The user answers this on the project's Needs-You rail (${n.actions.join(' / ')}). If they tell you to act on it: \`${opts.answerCmd} base ${n.actions[0]} --rev ${n.rev}\` (also: status, ${n.actions.filter((a) => a !== n.actions[0]).join(', ')}).`
      : `The user answers this on the project's Needs-You rail (${n.actions.join(' / ')}); tell them if it affects your work.`);
  }
  return { key: `${n.id}@${n.rev}`, text: lines.join('\n') };
}

/* ------------------------------------------- FEAT-157: one-time migration */

/**
 * The migration journal: which projects the one-time pin migration has handled.
 * Kept beside the registry (data dir), written atomically; a crash mid-migration
 * leaves the unhandled projects for the next boot/ensure (restartable).
 */
const baseMigration = {
  file(): string { return path.join(dataDir(), 'base-migration.json'); },
  /** ok:false = present but unreadable (torn/corrupt): treated as "everything handled" so nothing is re-guessed. */
  read(): { ok: boolean; migrated: Record<string, { at: string; pin: unknown; observed: string | null }> } {
    let raw: string;
    try { raw = fs.readFileSync(this.file(), 'utf8'); } catch (e) { return { ok: (e as NodeJS.ErrnoException).code === 'ENOENT', migrated: {} }; }
    try {
      const j = JSON.parse(raw) as { migrated?: Record<string, { at: string; pin: unknown; observed: string | null }> };
      return j && typeof j === 'object' && j.migrated && typeof j.migrated === 'object' && !Array.isArray(j.migrated) ? { ok: true, migrated: j.migrated } : { ok: false, migrated: {} };
    } catch { return { ok: false, migrated: {} }; }
  },
  has(id: string): boolean { const r = this.read(); return !r.ok || Object.prototype.hasOwnProperty.call(r.migrated, id); },
  add(id: string, rec: { pin: unknown; observed: string | null }): void {
    const r = this.read();
    if (!r.ok) return; // never write over an unreadable journal (it is kept as it is for a person to look at)
    const all = r.migrated;
    all[id] = { at: new Date().toISOString(), ...rec };
    // A journal that cannot be written (read-only data dir — attack round 3, e) leaves the project unjournalled; the
    // pin itself is what launches use, so this must never fail a launch.
    try {
      ensureDir(dataDir());
      const tmp = `${this.file()}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, migrated: all }, null, 2));
      fs.renameSync(tmp, this.file());
    } catch { /* retried at the next boot/launch */ }
  },
};

/**
 * The pin the one-time migration gives a container project that has none
 * (finding 9 — record what EXISTS; never adopt):
 *  - its container runs a base (directly, or a Dockerfile image built on one) →
 *    that base: `legacy:<tag>` for a pre-release base, the version for a release;
 *  - it has no container → the newest release (nothing runs, nothing to preserve);
 *  - its container's base cannot be read, or the catalog cannot → null (stays
 *    missing → recovery), never a guess.
 */
export function migrationPinFor(project: Project, opts: { atBoot?: boolean; live?: Inspected | null; catalog?: baseRel.Catalog } = {}): baseRel.BasePin | null {
  if (imageSourceOf(project) === 'custom') return null;
  let live: Inspected | null = opts.live ?? null;
  try {
    const name = containerName(project.id);
    if (opts.live === undefined) live = inspect(name);
    // A Dockerfile project's swap interrupted by a crash leaves only the replacement (attack round 1, e).
    for (const alt of [nextName(name), `${name}-next`]) {
      if (live) break;
      const nx = inspect(alt);
      if (nx && nx.project === project.id) live = nx;
    }
  } catch { return null; }
  // ARCH-022 (d-ii, attacker d round 3): a container this instance may not act on is NOT "no container" — reasoning
  // "nothing runs -> newest" over it wrote a newest pin that moved the container after the user declared live.
  // Undecidable here: nothing is written; the instance that may act on it decides.
  if (live && !mayActOn(live.owner)) return null;
  if (live) {
    const o = observedBaseOf(live.image, live.imageId) as baseRel.ObservedBase & { via?: string };
    // A base read from image LABELS (a Dockerfile image, or a CLI layer) must be PROVEN (attack round 2, a/e): the
    // claimed base image exists and its layers are a byte-identical prefix of what the container runs. Otherwise
    // nothing is written (pending → recovery keeps the container as it is).
    if (o.via === 'label') {
      const claimed = o.kind === 'legacy' ? `${IMAGE_REPO}:${o.tag}` : o.kind === 'version' ? `${IMAGE_REPO}:v${o.version}-${ugTag()}-${o.hash}` : o.kind === 'dev' ? `${IMAGE_REPO}:dev-${ugTag()}-${o.hash}` : null;
      if (!claimed || !layersArePrefix(claimed, live.imageId)) return null;
    }
    // ARCH-022 (d-i): the pin records the IMMUTABLE id of the base bytes the container runs on — the container's own
    // image when it runs the base tag itself, else the label-claimed base proven above by layer ancestry.
    const claimedRef = o.via === 'label'
      ? (o.kind === 'legacy' ? `${IMAGE_REPO}:${o.tag}` : o.kind === 'version' ? `${IMAGE_REPO}:v${o.version}-${ugTag()}-${o.hash}` : null)
      : null;
    const baseId = o.via === 'label' ? (claimedRef ? imageIdOf(claimedRef) : '') : (live.imageId ?? '');
    const iid = /^sha256:[0-9a-f]{64}$/.test(baseId) ? { imageId: baseId } : {};
    if (o.kind === 'legacy') return { pinned: `legacy:${o.tag}`, ...iid, skipped: [], deferred: null };
    if (o.kind === 'version') return { pinned: o.version, ...(o.hash ? { hash: o.hash } : {}), ...iid, skipped: [], deferred: null };
    if (o.kind === 'dev') return { pinned: 'dev', skipped: [], deferred: null };
    return null;
  }
  // No container found. At BOOT that is not proof there is nothing to preserve (the daemon reached may not be the
  // one the containers are on — attack round 1, e): leave it for the project's first launch, which creates its
  // container on the daemon it inspected.
  if (opts.atBoot) return null;
  const cat = opts.catalog ?? baseRel.readCatalog();
  return cat.ok ? { pinned: cat.newest.version, hash: cat.newest.hash, skipped: [], deferred: null } : null;
}

/** True iff `baseRef` exists and its layer digests are a prefix of `imageId`'s (structural ancestry, not a label). */
function layersArePrefix(baseRef: string, imageId: string): boolean {
  const layers = (ref: string): string[] | null => {
    const r = dockerSync(['image', 'inspect', ref, '--format', '{{json .RootFS.Layers}}'], 20_000);
    if (r.code !== 0) return null;
    try { const a = JSON.parse(r.stdout) as unknown; return Array.isArray(a) ? a.map(String) : null; } catch { return null; }
  };
  const b = layers(baseRef), i = layers(imageId);
  return !!b && !!i && b.length > 0 && b.length <= i.length && b.every((x, k) => i[k] === x);
}

/**
 * Persist the migration pin for one project (idempotent). Returns the project as
 * stored afterwards. The registry is backed up once, before the first write.
 */
export function migrateBasePin(project: Project, opts: { atBoot?: boolean } = {}): baseRel.BasePin | null {
  const m = planBaseMigration(project, opts);
  return m ? m.commit() : null;
}

/**
 * ARCH-022 (d-ii): the migration DECIDED without writing anything. `commit()` performs the write; a launch commits only
 * after its operation was admitted and succeeded, so a refused operation leaves no state behind.
 */
export function planBaseMigration(project: Project, opts: { atBoot?: boolean } = {}): { pin: baseRel.BasePin; commit: () => baseRel.BasePin | null } | null {
  if (project.isolation !== 'container' || baseMigration.has(project.id)) return null;
  let fresh: Project | undefined;
  try { fresh = listProjects().find((x) => x.id === project.id); } catch { return null; } // unreadable registry: write nothing
  if (!fresh || fresh.isolation !== 'container') return null; // a caller's own object (tests, a deleted project): judged in memory, never written
  // Decide on the STORED row, never a caller's older copy (an adopt may have landed since).
  const cs = containerSettingsOf(fresh);
  if (cs.base !== undefined && cs.base !== null) { baseMigration.add(fresh.id, { pin: cs.base, observed: null }); return null; }
  if (imageSourceOf(fresh) === 'custom') { baseMigration.add(fresh.id, { pin: null, observed: null }); return null; }
  const pin = migrationPinFor(fresh, opts);
  if (!pin) return null; // undecidable now (docker down, unreadable image/catalog, a container not ours): retried later
  const row = fresh;
  return {
    pin,
    commit: () => {
      if (baseMigration.has(row.id)) return null;
      // the stored row may have changed since the plan (an adopt landed): never overwrite a pin
      let now: Project | undefined;
      try { now = listProjects().find((x) => x.id === row.id); } catch { return null; }
      if (!now) return null;
      const ncs = containerSettingsOf(now);
      if (ncs.base !== undefined && ncs.base !== null) { baseMigration.add(row.id, { pin: ncs.base, observed: null }); return null; }
      // (attack round 2, e) a data dir that cannot take the backup (read-only) leaves the project pending — its launch
      // then uses the same pin in memory — instead of refusing every launch.
      try { backupRegistryOnce(); } catch { return null; }
      try { updateProject(row.id, { settings: { container: { base: pin } } } as unknown as Partial<Project>); } catch { return null; } // unwritable registry: pending
      let observed: string | null = null;
      try { observed = inspect(containerName(row.id))?.image ?? null; } catch { /* */ }
      baseMigration.add(row.id, { pin, observed });
      return pin;
    },
  };
}

let registryBackedUp = false;
function backupRegistryOnce(): void {
  if (registryBackedUp) return;
  const src = path.join(dataDir(), 'registry.json');
  const dst = path.join(dataDir(), `registry.json.pre-feat157-${new Date().toISOString().replace(/[^0-9]/g, '')}`);
  try { fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL); registryBackedUp = true; } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') { registryBackedUp = true; return; }
    throw new ContainerError('migration-failed', `could not back up the registry before the base-pin migration: ${(e as Error).message}`);
  }
}

/**
 * Boot: migrate every container project that has not been migrated yet — each inside its own lifecycle operation
 * (ARCH-022), so the pin it writes can never interleave with a launch of that project. Never throws.
 */
export async function migrateAllBasePins(onLog?: (s: string) => void): Promise<{ migrated: string[]; pending: string[] }> {
  const migrated: string[] = [];
  const pending: string[] = [];
  let projects: Project[] = [];
  try { projects = listProjects(); } catch { return { migrated, pending }; }
  for (const p of projects) {
    if (p.isolation !== 'container' || baseMigration.has(p.id)) continue;
    try {
      const pin = await lifecycle.runOp(p.id, 'maintain', async () => migrateBasePin(p, { atBoot: true }));
      if (baseMigration.has(p.id)) { migrated.push(p.id); onLog?.(`[container] base pin for ${p.id}: ${JSON.stringify(pin ?? containerSettingsOf(p).base ?? null)}\n`); } else pending.push(p.id);
    } catch (e) { pending.push(p.id); onLog?.(`[container] base pin migration for ${p.id} deferred: ${(e as Error).message}\n`); }
  }
  return { migrated, pending };
}

/**
 * FEAT-155 round 5 — WHERE a project's image comes from. The one place that
 * decides (ARCH-010): a project Dockerfile wins over a prebuilt `image`, which
 * wins over Orchard's own. Every reader asks this rather than re-testing the
 * settings.
 */
export function imageSourceOf(project: Project): 'dockerfile' | 'custom' | 'station' {
  const cs = containerSettingsOf(project);
  if (cs.dockerfile && cs.dockerfile.trim()) return 'dockerfile';
  if (cs.image && cs.image.trim()) return 'custom';
  return 'station';
}

/**
 * FEAT-155 — the Dockerfile image LIFECYCLE (build, keep-last-good, `-next`
 * swap, bad-image memory, Rebuild without a remove) applies only to images
 * Orchard builds from a project's `container.dockerfile`. This is NOT the
 * run-time lockdown: that applies to every container (round 7, see
 * `lockdownCreateArgs`).
 */
function keepsLastGood(project: Project): boolean {
  return imageSourceOf(project) === 'dockerfile';
}

export interface DockerfileResolution {
  ok: boolean;
  /** Relative path as configured. */
  rel: string;
  error?: string;
  hash?: string;
  /** `claude-station-project-<id>:df-<hash>` — exists only once built AND validated. */
  image?: string;
  bytes?: Buffer;
}

/** Read + check + hash the project's Dockerfile as it is on disk right now. */
export function resolveProjectDockerfile(project: Project): DockerfileResolution {
  const rel = containerSettingsOf(project).dockerfile ?? '';
  const read = readProjectDockerfile(project.hostPath, rel);
  if (!read.ok) return { ok: false, rel, error: read.error };
  const { uid, gid } = hostUidGid();
  // FEAT-157: the base this project is pinned to (or its security target); recovery builds nothing.
  const baseTag = baseRefFor(project);
  if (!baseTag) return { ok: false, rel: read.rel, error: 'this project has no usable base pin (recovery); choose a base release on the rail' };
  let baseId = '';
  try { baseId = imageIdOf(baseTag); } catch { /* docker missing — hash without it; ensure fails loudly later */ }
  const repoKey = repoKeyOf(project);
  // ARCH-020: the file's exact bytes are hashed and built — there is no text
  // rule for the build to disagree with (isolation is the builder's, see
  // project-builder.ts).
  const hash = dockerfileHash(read.bytes, { baseTag, baseId, uid, gid, repoKey: repoKey ?? '', builder: BUILDER_IMAGE, owner: dataKey() });
  return { ok: true, rel: read.rel, hash, image: `${projectImageRepo(project.id)}:df-${hash}`, bytes: read.bytes };
}

/** The repo identity of a project (null when its directory cannot be resolved). */
function repoKeyOf(project: Project): string | null {
  try { return repoIdentity(fs.realpathSync(project.hostPath)); } catch { return null; }
}

/**
 * The build record for THIS project on THIS repo. A record written for another
 * repo under the same project id (a project deleted and re-created with the
 * same name elsewhere) is reset, never adopted: its last good image and log
 * belong to someone else.
 */
function recordFor(project: Project): BuildRecord {
  const key = repoKeyOf(project);
  const rec = buildRecord(project.id);
  if (key && rec.repoKey !== key) return resetBuildRecord(project.id, key);
  return rec;
}

/** True iff `ref` is a Dockerfile image Orchard built and validated FOR THIS project. */
function isOwnProjectImage(project: Project, ref: string | null | undefined): boolean {
  if (!ref) return false;
  const repo = projectImageRepo(project.id);
  const i = ref.lastIndexOf(':');
  if (ref.slice(0, i) !== repo || !DF_TAG_RE.test(ref.slice(i + 1))) return false;
  const key = repoKeyOf(project);
  if (!key) return false;
  try {
    const r = dockerSync(['image', 'inspect', ref, '--format', `{{index .Config.Labels "${LABEL_DF_PROJECT}"}}\t{{index .Config.Labels "${LABEL_DF_REPO}"}}\t{{index .Config.Labels "${LABEL_DF_DATA}"}}`], 10_000);
    // Built for this project id AND this repo AND by this data dir's Orchard —
    // an id reused by a re-created project on another repo, or registered by
    // another Orchard on the same daemon, does not inherit that one's images.
    return r.code === 0 && r.stdout.trim() === `${project.id}\t${key}\t${dataKey()}`;
  } catch {
    return false;
  }
}

/**
 * The image a Dockerfile project should run on RIGHT NOW, and why.
 *  - the wanted image, when it has been built and validated;
 *  - else, when the wanted hash's build FAILED (or the Dockerfile cannot be
 *    read / is refused), the last good image — so a bad edit never takes the
 *    project's container down;
 *  - else the wanted image, not yet built (the next ensure builds it).
 * Read-only: never builds.
 */
export function dockerfileEffectiveImage(project: Project): {
  image: string | null;
  wanted: string | null;
  resolution: DockerfileResolution;
  fellBack: boolean;
  reason?: string;
} {
  const res = resolveProjectDockerfile(project);
  const rec = recordFor(project);
  const lastGood = isOwnProjectImage(project, rec.lastGoodImage) ? rec.lastGoodImage : null;
  if (!res.ok) {
    return { image: lastGood, wanted: null, resolution: res, fellBack: !!lastGood, reason: res.error };
  }
  // A hash marked failed stays failed even when its image exists: a validated
  // image whose real container would not start is exactly that case.
  if (rec.failedHash === res.hash) {
    return { image: lastGood, wanted: res.image!, resolution: res, fellBack: !!lastGood, reason: rec.error ?? 'the build for this Dockerfile failed' };
  }
  return { image: res.image!, wanted: res.image!, resolution: res, fellBack: false };
}

/**
 * Tags this project generates or has generated. Both the current hashed shape
 * and the pre-BUG-107 unhashed one — the legacy tag has to be reclaimable or
 * the very first upgrade strands a 1.1 GB image forever.
 */
const STATION_TAG_RE = /^(u\d+-g\d+(-[0-9a-f]{12})?|v\d+-u\d+-g\d+-[0-9a-f]{12}|dev-u\d+-g\d+-[0-9a-f]{12})$/;
/** FEAT-157 — the CLI-layer tag shape (`<cli version>-<16 hex>`). */
const RUNTIME_TAG_RE = /^\d+\.\d+\.\d+[-.\w]*-[0-9a-f]{16}$/;

function hostUidGid(): { uid: number; gid: number } {
  const u = os.userInfo();
  return { uid: u.uid, gid: u.gid };
}

/* ------------------------------------------------- FEAT-145: which account */

/**
 * FEAT-145 step 6 — the Claude account a project's CONTAINER runs as.
 *
 * PROJECT SCOPE ONLY, NEVER PER SESSION. `desiredBinds()` below is the drift
 * oracle: `ensureContainer` recreates the container on ANY bind difference. So
 * a per-session account would recreate the container out from under every OTHER
 * session already running in it, and the change would outlive the session that
 * asked for it. That is exactly why `mounts` is project-scope-only too (see the
 * rationale at `validate.ts` `SESSION_OVERRIDE_FIELDS`). Step 5 owns rejecting
 * a per-session override for a container-backed project; this file owns the
 * bind. Changing the PROJECT's account SHOULD recreate the container — that is
 * the established, correct behaviour for every other bind change.
 *
 * The value is the machine→project merge (`applyGlobalDefaults`), the SAME
 * merge `pickOverridable()` feeds a session's `CLAUDE_CONFIG_DIR` with, so a
 * container project and a direct project on the same settings resolve to the
 * same account. Reading only `project.settings.claudeAccount` here would strand
 * every inheriting container project on the old account the moment the machine
 * default moved — quota spent on the wrong plan, with no signal.
 *
 * `null` means the implicit default account (`~/.claude`).
 */
export function containerAccountId(project: Project): string | null {
  const s = (project.settings ?? {}) as Partial<Project['settings']>;
  return applyGlobalDefaults({
    model: s.model ?? null,
    effort: s.effort ?? null,
    claudeAccount: s.claudeAccount ?? null,
  }).claudeAccount;
}

/**
 * The account dir whose `.credentials.json` this project's container binds.
 *
 * FAILS LOUDLY for a named account that is missing, not logged in, or has lost
 * its credential — it never falls back to `~/.claude`, because a silent
 * fallback spends the OTHER subscription's quota with nothing to show for it.
 * `resolveLaunchAccountDir` is the one gate for "may a launch use this account"
 * (shared with the direct/non-container path in agent-bridge, so both refuse on
 * the same grounds); `resolveAccountDir` is the one id→dir authority (ARCH-010)
 * — the dir is never re-derived here.
 */
function accountDirForContainer(project: Project): string {
  const id = containerAccountId(project) ?? DEFAULT_ACCOUNT_ID;
  try {
    // Returns null for the implicit default (nothing to gate); for a named
    // account it throws unless the account exists, is ready, and has a
    // credential file. Also repairs the overlay symlinks (idempotent).
    resolveLaunchAccountDir(id);
    return resolveAccountDir(id);
  } catch (err) {
    if (err instanceof AccountError) {
      throw new ContainerError(
        'account-unavailable',
        `project ${project.id} is pinned to Claude account "${id}", which cannot be used`,
        `${err.message}\nFix or re-add the account in Machine settings, or clear this project's Claude account. ` +
          'The container is deliberately NOT started on the default account instead: that would silently ' +
          "spend the wrong subscription's quota.",
      );
    }
    throw err;
  }
}

/**
 * The host file bound at `$HOME/.claude/.credentials.json` inside the container.
 *
 * WHY ONLY THIS ONE FILE, and not the account dir wholesale: an account overlay
 * dir's `projects` and `settings.json` are SYMLINKS to host paths (`~/.claude/…`)
 * that do not exist at those paths inside the container, so bind-mounting the
 * dir would hand the CLI two broken links — a dangling `projects` is where the
 * transcripts would silently stop landing. The container keeps its own
 * `$HOME/.claude` (image-local) as its config dir, the session-history bind
 * below puts this project's transcript dir exactly where Orchard's readers
 * expect it, and the ONLY thing that varies per account is this file. That also
 * means `CLAUDE_CONFIG_DIR` must NOT cross into the container (it names a HOST
 * path) — see the note on `ENV_PASSTHROUGH`.
 */
function credentialsBind(project: Project): BindSpec {
  const id = containerAccountId(project);
  const dir = accountDirForContainer(project);
  return {
    hostPath: path.join(dir, '.credentials.json'),
    containerPath: `${CONTAINER_HOME}/.claude/.credentials.json`,
    // rw, NOT :ro — the CLI refreshes the OAuth token in place, and a read-only
    // mount silently blocks that refresh from reaching the host, which breaks
    // long-running containers hours later.
    // BUG-136: "in place" is only true of the CLI INSIDE the container. The HOST
    // copy of Claude Code replaces this file wholesale, which orphans this bind —
    // see `staleFileBinds`, which turns that into drift so the next ensure
    // re-binds the current file.
    readOnly: false,
    // Unchanged string for the default account (drift/log text stays as it was);
    // a named account says so, because "which plan is this burning" is the
    // question the whole feature exists to answer.
    why: id == null || id === DEFAULT_ACCOUNT_ID ? 'Claude credentials' : `Claude credentials (account ${id})`,
  };
}

/** The credentials path for the project's effective account. */
function credentialsFile(project: Project): string {
  return credentialsBind(project).hostPath;
}

/* ----------------------------------------------------------------- binds */

export interface BindSpec {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
  /** Human label for drift messages. */
  why: string;
}

/**
 * The full, ordered bind list for a project. This is also the drift oracle:
 * `ensureContainer` compares it against the live container's Binds and
 * recreates on any difference.
 */
export function desiredBinds(project: Project): BindSpec[] {
  const cs = containerSettingsOf(project);
  const workdir = containerWorkdir(project);
  const binds: BindSpec[] = [
    { hostPath: project.hostPath, containerPath: workdir, readOnly: false, why: 'project directory' },
    // FEAT-145 — the project's EFFECTIVE Claude account's credential file (see
    // `credentialsBind`). Same container path and same rw-ness as before; only
    // the host side moves, and only for a project on a named account. Because
    // this list is the drift oracle, changing the project's account is drift and
    // recreates the container exactly once, like any other bind change.
    credentialsBind(project),
    // This project's own session history only. Note you cannot nest a file
    // mount inside a :ro directory mount in Docker, which is one more reason
    // ~/.claude is never mounted wholesale.
    // FEAT-155: host side is the DECLARED store (never re-derived from cwd);
    // container side is wherever the in-container CLI will write, which does
    // follow the cwd. With workspaceRoot off the two coincide and this bind is
    // byte-identical to before (no drift for existing containers).
    {
      hostPath: containerHistoryDir(project),
      containerPath: `${CONTAINER_HOME}/.claude/projects/${encodeCwdForStore(workdir)}`,
      readOnly: false,
      why: 'session history',
    },
  ];
  /*
   * STEALTH BROWSER — exactly two mounts, both derived from THIS project's id by
   * browser.ts. Added before user mounts so a user mount can never be ordered so
   * as to shadow them, and validateMounts refuses those container paths outright.
   *
   * Chrome itself stays on the host. What crosses the boundary is one 0600 unix
   * socket owned by the host uid (which the container already runs as) plus a
   * read-only single-file MCP shim. There is no TCP listener anywhere, so a
   * container gets exactly one browser: its own.
   */
  /*
   * BUG-152 — an ENABLED browser whose adapter is not configured contributes no
   * binds at all, and asking for them must not throw. `browserBinds` resolves
   * the MCP shim through `requireRepoDir()`, which throws when
   * CLAUDE_STATION_SBMCP_REPO is unset — so before this guard, a project with
   * the toggle on and no adapter could not have its container ensured AT ALL:
   * `POST /container/start|rebuild` and the drift check both died on a browser
   * path, reporting an adapter error for a container operation. Session start
   * degrades past an unavailable adapter now (agent-bridge), so this is the
   * shape a real session reaches, not a corner.
   */
  if (browserSettingsOf(project).enabled && browserAvailable().ok) {
    /*
     * BUG-136 (THIRD report) — DO NOT BIND THE SOCKET WHEN IT IS NOT THERE.
     *
     * The stealth browser socket exists only while its daemon is serving.
     * Docker materialises a MISSING bind source as a ROOT-OWNED DIRECTORY, and
     * a directory at that path is not a stale socket the daemon can clear: it
     * unlinks the old socket on startup and gets EISDIR, so the daemon can
     * NEVER start again. Session start calls `browser.start()` before
     * `ensureContainer`, so on that path the socket is up and this bind is
     * present — but `POST /container/start|rebuild` ensures with no browser at
     * all, and that is how a real project got poisoned: container created
     * 13:38Z with the daemon down, root-owned dir left behind, every later
     * session start failing at the browser step BEFORE the credentials drift
     * check could run. Two prior fixes were live and correct and could not be
     * reached.
     *
     * Same self-correcting skip the user mounts below get: daemon down ->
     * desired drops the bind -> "unexpected bind" -> drift -> recreate without
     * it; daemon up -> "missing bind" -> drift -> recreate with it. A session
     * start therefore always lands on a container holding the live socket.
     */
    for (const b of browserBinds(project)) {
      // This socket-file bind retains the inode across daemon replacement.
      // ARCH-012 tracks that latent stealth-browser restart failure.
      if (!fs.existsSync(b.hostPath)) continue;
      binds.push({ hostPath: b.hostPath, containerPath: b.containerPath, readOnly: b.readOnly, why: b.why });
    }
  }
  if (toolSettingsOf(project).openaiDispatch) {
    // BUG-136 rule: Docker also turns a missing directory source into a
    // root-owned directory. Do not bind it until the broker socket is live.
    for (const b of dispatchBinds(project)) {
      if (b.why === 'OpenAI dispatch socket directory' && !fs.existsSync(dispatchSocketPath(project))) continue;
      if (!fs.existsSync(b.hostPath)) continue;
      binds.push(b);
    }
  }
  /*
   * BUG-136 (second report) — A USER MOUNT WHOSE DIRECTORY WAS DELETED MUST NOT
   * BRICK THE PROJECT.
   *
   * Observed live: a project carried a mount of a sibling project directory
   * that the user later removed from disk. From that moment `doEnsure` threw
   * `bad-mounts` on its way IN — before the drift check, before the recreate —
   * so the container could never be re-ensured at all. The credentials
   * self-heal added by the first half of this ticket was correct and fired
   * correctly when asked directly, and was simply unreachable: the project was
   * pinned to the container it already had, forever, by an unrelated mount.
   *
   * So an absent host path skips the bind instead of failing the ensure, and
   * that is self-correcting in BOTH directions, because `driftReasons` compares
   * this list against the container's actual binds:
   *   - directory gone  -> desired drops it, live still has it -> "unexpected
   *     bind" -> drift -> recreate without it;
   *   - directory back  -> desired has it, live does not -> "missing bind" ->
   *     drift -> recreate with it.
   * Nothing is written to the user's config either way, so a path that comes
   * back (an unmounted disk, a directory being moved) restores its own mount.
   *
   * The cost, stated plainly: an agent can now start in a project whose extra
   * mount is silently not there, and do work against data it expected to find.
   * That is why the skip is announced by `doEnsure` as a status line rather
   * than being passed over in silence. The alternative it replaces is worse and
   * was measured: the project could not start a session at all, and the reason
   * shown to the user named no path.
   */
  for (const m of project.settings.mounts ?? []) {
    const hp = path.resolve(expandHome(m.hostPath));
    if (!fs.existsSync(hp)) continue;
    binds.push({
      hostPath: hp,
      containerPath: m.containerPath,
      readOnly: m.readOnly !== false,
      why: 'project mount',
    });
  }
  if (cs.dockerSocket) {
    // Opt-in only. On a ROOTFUL daemon this is equivalent to giving the
    // container root on the host (it can `docker run -v /:/host`). Every other
    // hardening flag here becomes decorative once this is on.
    binds.push({ hostPath: '/var/run/docker.sock', containerPath: '/var/run/docker.sock', readOnly: false, why: 'docker socket (opted in)' });
  }
  return binds;
}

/**
 * Supplementary groups the container needs. Only ever non-empty for the
 * docker-socket opt-in: mounting the socket alone is inert, because the
 * container user (host uid, but none of the host's supplementary groups) gets
 * "permission denied" on the socket. Observed live before this was added.
 * Granting the socket's group is part of the same explicit opt-in — and it is
 * what makes that opt-in equivalent to host root on a rootful daemon.
 */
export function desiredGroupAdd(project: Project): string[] {
  if (!containerSettingsOf(project).dockerSocket) return [];
  try {
    return [String(fs.statSync('/var/run/docker.sock').gid)];
  } catch {
    return [];
  }
}

function bindString(b: BindSpec): string {
  return `${b.hostPath}:${b.containerPath}${b.readOnly ? ':ro' : ''}`;
}

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * Validate the mounts a user typed in before they reach docker. Docker happily
 * creates a root-owned directory for a missing host path, so a typo would
 * silently produce an empty mount instead of an error.
 *
 * BUG-136 (second report) — `requireHostPath` splits the two kinds of "invalid"
 * that used to be one list. Shape and security errors (mounting over /etc, over
 * the managed .claude, a relative containerPath) are ALWAYS errors: they are
 * wrong no matter what the disk looks like. "host path does not exist" is not
 * like that — it is a statement about the disk right now, and the disk changes
 * under a config that was correct when it was written.
 *
 * At WRITE time (the settings dialog) it stays an error, so a typo is caught
 * where the user can fix it. At ENSURE time it must NOT be, because a hard
 * throw there bricks the whole project: see `doEnsure`.
 */
export function validateMounts(mounts: Mount[], opts: { requireHostPath?: boolean } = {}): string[] {
  const requireHostPath = opts.requireHostPath !== false;
  const errs: string[] = [];
  const seen = new Set<string>();
  for (const [i, m] of mounts.entries()) {
    const label = `mounts[${i}]`;
    if (!m || typeof m.hostPath !== 'string' || !m.hostPath.trim()) {
      errs.push(`${label}: hostPath is required`);
      continue;
    }
    if (typeof m.containerPath !== 'string' || !m.containerPath.startsWith('/')) {
      errs.push(`${label}: containerPath must be an absolute path inside the container`);
      continue;
    }
    const hp = path.resolve(expandHome(m.hostPath));
    if (requireHostPath && !fs.existsSync(hp)) errs.push(`${label}: host path does not exist: ${hp}`);
    /*
     * NORMALISE BEFORE COMPARING. The guards below used to run on the raw
     * string, so `//home/claude/.claude` sailed past `startsWith(...)` and
     * Docker then normalised it back — verified live: an arbitrary host dir got
     * mounted over the container's managed credentials path.
     */
    const cp = path.posix.normalize(m.containerPath).replace(/\/+$/, '') || '/';
    const under = (base: string) => cp === base || cp.startsWith(`${base}/`);
    // FEAT-157 (attack round 3, d): an ANCESTOR of the home (e.g. `/home`) shadows the CLI's path just as well.
    const homeAncestors: string[] = [];
    for (let a = path.posix.dirname(CONTAINER_HOME); a !== '/'; a = path.posix.dirname(a)) homeAncestors.push(a);
    if (cp === CONTAINER_WORKSPACE || cp === '/' || cp === CONTAINER_HOME || homeAncestors.includes(cp)) {
      errs.push(`${label}: refusing to mount over ${cp}`);
    }
    if (under(`${CONTAINER_HOME}/.claude`)) {
      errs.push(`${label}: ${CONTAINER_HOME}/.claude is managed by Claude Station — pick another path`);
    }
    // The CLI's own binary and the system config live here. A mount over either
    // lets the "isolated" container run an executable of the caller's choosing.
    for (const base of [`${CONTAINER_HOME}/.local`, '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/var/run']) {
      if (under(base)) errs.push(`${label}: refusing to mount over ${base} (container system path)`);
    }
    /*
     * A browser mount is just another mount, and must not become a bypass. `/sb`
     * and `/opt/sbmcp` are managed by Claude Station and derived from the
     * project id; letting a user mount claim either would let project A point
     * `/sb/browser.sock` at project B's socket and reach B's logged-in browser.
     * Same normalise-then-compare discipline as the .claude guard above.
     */
    for (const base of ['/sb', CONTAINER_MCP_DIR, CONTAINER_DISPATCH_SOCKET_DIR, CONTAINER_DISPATCH_DIR]) {
      if (under(base)) {
        errs.push(`${label}: ${base} is managed by Claude Station — pick another path`);
      }
    }
    // Belt and braces: refuse any mount whose SOURCE is inside the browser state
    // tree, which would hand over another project's socket or Chrome profile.
    if (hp === browserStateHome() || hp.startsWith(`${browserStateHome()}${path.sep}`)) {
      errs.push(`${label}: ${hp} is inside the stealth-browser state directory — projects reach their own browser automatically; mounting another project's is refused`);
    }
    const dispatchHome = dispatchStateHome();
    if (hp === dispatchHome || hp.startsWith(`${dispatchHome}${path.sep}`)) {
      errs.push(`${label}: ${hp} is inside the OpenAI dispatch broker state directory — mounting another project's socket is refused`);
    }
    // Handing the container the whole host filesystem defeats isolation as
    // thoroughly as the docker socket, with none of its ceremony.
    if (hp === '/' || hp === os.homedir()) {
      errs.push(`${label}: refusing to mount ${hp} — that is the entire host ${hp === '/' ? 'filesystem' : 'home directory'}; mount the specific directory you need`);
    }
    if (seen.has(cp)) errs.push(`${label}: duplicate containerPath ${cp}`);
    seen.add(cp);
  }
  return errs;
}

/* ------------------------------------------------------------------ status */

export type ContainerState = 'running' | 'stopped' | 'missing' | 'building' | 'error';

export interface ContainerStatus {
  state: ContainerState;
  containerName: string;
  image?: string;
  startedAt?: string;
  /** Populated when state is 'error', or when a running container has drifted. */
  error?: string;
  /** True when the live config no longer matches the registry. */
  drifted?: boolean;
  driftReasons?: string[];
  /** GPU passthrough: the project's setting, whether it is effectively on, and
   *  why the host can or cannot pass a GPU through (for 'auto'). */
  gpu?: { setting: 'auto' | 'on' | 'off'; effective: boolean; hostReason: string };
  /** FEAT-155 — the host's total RAM in MiB, so the memory-cap control can show
   *  how much the cap is being drawn from. Read-only context; changes nothing. */
  hostMemoryMb?: number;
  /** FEAT-155 round 5 — present when the project builds its image from its own Dockerfile. */
  dockerfile?: DockerfileStatus;
  /**
   * FEAT-155 round 8 — why the image this project would run on is REFUSED (it
   * bakes in a reserved ENV key). Launch and Rebuild fail with this reason and
   * leave any existing container untouched. Absent when the image is allowed.
   */
  imageRefused?: string;
  /**
   * FEAT-155 round 8 — the running container predates Orchard's run-time
   * lockdown. It is recreated under the lockdown at the next launch with no
   * live session (or on Rebuild), never under live sessions. Absent otherwise.
   */
  lockdownPending?: string;
}

export interface DockerfileStatus {
  path: string;
  /** Hash of the Dockerfile as it is on disk now (null when it cannot be read / is refused). */
  hash: string | null;
  /** The image the Dockerfile describes now; null when it cannot be read / is refused. */
  wantedImage: string | null;
  /** The image the project runs on (wanted, or the last good one after a failure). */
  effectiveImage: string | null;
  /** Wanted image built and validated. */
  built: boolean;
  /** True when a failed build / unreadable Dockerfile left the project on its last good image. */
  fellBack: boolean;
  /** Why the wanted image is not the one in use (build error, refused Dockerfile…). */
  problem: string | null;
  lastGoodImage: string | null;
  build: { state: string; hash: string | null; startedAt: string | null; finishedAt: string | null; error: string | null };
}

interface Inspected {
  /** The container ID. Anything that acts on an inspected container acts on THIS, never the name again (BUG-216 E4c). */
  id: string;
  /** BUG-216: which Orchard instance created it, from its owner label. */
  owner: Ownership;
  /** The project id it was created for (`claude-station.project` label); '' when unlabelled. */
  project: string;
  running: boolean;
  image: string;
  /** The RESOLVED image sha the container actually runs (not the name it was created with). */
  imageId: string;
  startedAt: string;
  binds: string[];
  workdir: string;
  init: boolean;
  groupAdd: string[];
  capDrop: string[];
  memoryBytes: number;
  pidsLimit: number;
  securityOpt: string[];
  gpu: boolean;
  env: string[];
  /** FEAT-155 — the `container.env` KEYS this container was created with (label), '' when none/unlabelled. */
  envKeys: string;
  /** FEAT-155 round 5 — the run-time identity/entry pinned by the lockdown. */
  user: string;
  entrypoint: string[];
  cmd: string[];
}

function inspect(name: string): Inspected | null {
  const r = dockerSync(['inspect', name, '--format', '{{json .}}']);
  if (r.code !== 0) {
    if (/No such object|no such container/i.test(r.stderr)) return null;
    throw new ContainerError('inspect-failed', `docker inspect ${name} failed`, (r.stderr || r.stdout).trim().slice(0, 800));
  }
  const j = JSON.parse(r.stdout) as Record<string, any>;
  const hc = j.HostConfig ?? {};
  return {
    id: String(j.Id ?? ''),
    owner: ownershipOf(j.Config?.Labels?.[LABEL_OWNER]),
    project: String(j.Config?.Labels?.['claude-station.project'] ?? ''),
    running: j.State?.Running === true,
    image: String(j.Config?.Image ?? ''),
    imageId: String(j.Image ?? ''),
    startedAt: String(j.State?.StartedAt ?? ''),
    binds: (hc.Binds ?? []) as string[],
    workdir: String(j.Config?.WorkingDir ?? ''),
    init: hc.Init === true,
    groupAdd: ((hc.GroupAdd ?? []) as unknown[]).map(String),
    capDrop: (hc.CapDrop ?? []) as string[],
    memoryBytes: Number(hc.Memory ?? 0),
    pidsLimit: Number(hc.PidsLimit ?? 0),
    securityOpt: (hc.SecurityOpt ?? []) as string[],
    // `--gpus all` lands in HostConfig.DeviceRequests as a request carrying the
    // "gpu" capability. Any such request means the container was created with a
    // GPU; its absence means it was not.
    gpu: ((hc.DeviceRequests ?? []) as Array<{ Capabilities?: string[][] }>).some(
      (d) => (d.Capabilities ?? []).some((set) => set.includes('gpu')),
    ),
    env: (j.Config?.Env ?? []) as string[],
    envKeys: String(j.Config?.Labels?.[ENV_KEYS_LABEL] ?? ''),
    user: String(j.Config?.User ?? ''),
    entrypoint: ((j.Config?.Entrypoint ?? []) as unknown[]).map(String),
    cmd: ((j.Config?.Cmd ?? []) as unknown[]).map(String),
  };
}

/**
 * BUG-216 — a container another Orchard instance created (its owner label names a
 * different data dir) is never reused, recreated, stopped or removed here. Names
 * derive from the project id alone, so two instances that register the same id
 * share a container NAME; acting on the name would operate on the other
 * instance's live container (the clean-room verifier destroyed a running project
 * and its data exactly that way). Refuse loudly instead. An UNLABELLED container
 * (made before owner labels existed) is still treated as this instance's, so the
 * live server keeps working with its existing containers.
 */
function refuseForeign(name: string, ins: Inspected | null): void {
  if (ins && !mayActOn(ins.owner)) {
    throw new ContainerError(
      'foreign-owner',
      (ins.owner === 'unlabelled'
        ? `${name} has no owner label (made before owner labels existed) and this server is not the DECLARED live instance, which alone adopts such containers; this server will not reuse, recreate, stop or remove it. If this IS your live Orchard, declare it once (node scripts/orchard-live-instance.mjs declare) and restart it. `
        : `${name} belongs to another Orchard instance (a different data dir, or this dir before instance identities existed and not declared live); this server will not reuse, recreate, stop or remove it. If this IS your live Orchard, declare it once (node scripts/orchard-live-instance.mjs declare) and restart it. `) +
        'Otherwise remove it from the server that created it, or register this project under a different id.',
    );
  }
}

/**
 * Config drift: the live container's binds / workdir / image / hardening no
 * longer match what the registry says. Serving a stale container here is the
 * exact failure this catches — the user edits mounts, sees "running", and gets
 * the old mounts for the rest of the day.
 */
function driftReasons(project: Project, live: Inspected, useImage?: string): string[] {
  const out: string[] = [];
  // `useImage`: the image this ensure is actually going to run (after a build,
  // or the last good one when the build failed). Readers without one ask the
  // same authority, `imageNameFor`.
  const wantImage = useImage ?? imageNameFor(project);
  if (wantImage.startsWith('sha256:') && live.imageId === wantImage) {
    // the wanted image IS the bytes this container runs (a legacy base named by id): no image drift
  } else if (live.image !== wantImage) {
    out.push(`image ${live.image} != ${wantImage}`);
  } else {
    /*
     * BUG-107 — same NAME is not the same ARTIFACT. A custom image the user
     * re-pulled, or a station tag rebuilt in place by an older code path, keeps
     * its name while the bytes underneath change; the container goes on running
     * the sha it was created from. Comparing the resolved id catches that.
     * Silent when the tag is absent locally: that is "not built yet", which
     * `ensureImage` handles, not drift.
     */
    const wantId = imageIdOf(wantImage);
    if (wantId && live.imageId && wantId !== live.imageId) {
      out.push(`image ${wantImage} was rebuilt (running ${live.imageId.slice(7, 19)}, current ${wantId.slice(7, 19)})`);
    }
  }
  const wantWd = containerWorkdir(project);
  if (live.workdir !== wantWd) out.push(`workdir ${live.workdir} != ${wantWd}`);
  const want = desiredBinds(project).map(bindString).sort();
  const got = live.binds.slice().sort();
  if (want.length !== got.length || want.some((b, i) => b !== got[i])) {
    const missing = want.filter((b) => !got.includes(b));
    const extra = got.filter((b) => !want.includes(b));
    if (missing.length) out.push(`missing bind(s): ${missing.join(', ')}`);
    if (extra.length) out.push(`unexpected bind(s): ${extra.join(', ')}`);
    if (!missing.length && !extra.length) out.push('bind list differs');
  }
  for (const r of staleFileBinds(project, live)) out.push(r);
  const cs = containerSettingsOf(project);
  const wantMem = cs.memoryMb * 1024 * 1024;
  if (live.memoryBytes !== wantMem) out.push(`memory ${live.memoryBytes} != ${wantMem}`);
  if (live.pidsLimit !== cs.pidsLimit) out.push(`pids limit ${live.pidsLimit} != ${cs.pidsLimit}`);
  const wantGpu = gpuEnabled(project);
  if (live.gpu !== wantGpu) out.push(`gpu ${live.gpu ? 'on' : 'off'} != ${wantGpu ? 'on' : 'off'}`);
  // Subset check, not equality: Config.Env also carries the image's own defaults
  // (PATH, etc.). We only own the keys we set, so drift is "a key we set is
  // missing or has the wrong value" — never "the image added env we didn't ask for".
  for (const [k, v] of Object.entries(cs.env ?? {})) {
    if (reservedContainerEnvReason(k)) continue; // never set on create, so never drift
    if (!live.env.includes(`${k}=${v}`)) out.push(`env ${k} not set to expected value`);
  }
  // …and REMOVING a key must be drift too, or the removed variable lives on in
  // the running container forever. The keys we set are recorded in a label at
  // create time (Config.Env alone cannot tell ours from the image's own).
  if (live.envKeys !== envKeysOf(project)) out.push(`env keys ${live.envKeys || '(none)'} != ${envKeysOf(project) || '(none)'}`);
  if (!live.init) out.push('Init is not enabled');
  const wantGroups = desiredGroupAdd(project).slice().sort();
  const gotGroups = live.groupAdd.slice().sort();
  if (wantGroups.join(',') !== gotGroups.join(',')) out.push(`group-add [${gotGroups}] != [${wantGroups}]`);
  // Docker normalises `--cap-drop SYS_ADMIN` to "CAP_SYS_ADMIN" on read-back.
  // Comparing raw would flag every container as drifted forever and recreate it
  // on every ensure — which is exactly what the first live run did.
  const liveCaps = new Set(live.capDrop.map((c) => c.replace(/^CAP_/, '').toUpperCase()));
  if (!liveCaps.has('ALL')) for (const cap of CAP_DROP) if (!liveCaps.has(cap)) out.push(`CapDrop missing ${cap}`);
  if (!live.securityOpt.some((s) => s.includes('no-new-privileges'))) out.push('no-new-privileges missing');
  // FEAT-155 rounds 5+7 — EVERY image (Orchard's own, a prebuilt
  // `container.image`, a Dockerfile build) runs under Orchard's identity and
  // entry command, never its own. A container without the pin is drift.
  {
    const { uid, gid } = hostUidGid();
    if (live.user !== `${uid}:${gid}`) out.push(`lockdown: user ${live.user || '(image default)'} != ${uid}:${gid}`);
    if (live.entrypoint.join(' ') !== LOCKDOWN_ENTRYPOINT.join(' ') || live.cmd.join(' ') !== LOCKDOWN_CMD.join(' ')) {
      out.push(`lockdown: entrypoint ${JSON.stringify(live.entrypoint)} cmd ${JSON.stringify(live.cmd)} != entrypoint ${JSON.stringify(LOCKDOWN_ENTRYPOINT)} cmd ${JSON.stringify(LOCKDOWN_CMD)}`);
    }
    if (!liveCaps.has('ALL')) out.push('lockdown: CapDrop ALL missing');
  }
  return out;
}

/*
 * FEAT-155 round 5 (round 7: for EVERY image source) — THE RUN-TIME LOCKDOWN.
 * One policy for all project containers: a Dockerfile build, a prebuilt
 * `container.image` (else the lockdown is bypassed by building the same image
 * elsewhere and pointing `image` at it) and Orchard's own image (built around
 * exactly this: user uid:gid, `sleep infinity`, no ENTRYPOINT/HEALTHCHECK).
 * The image controls CONTENTS only; everything the running container may DO
 * comes from these create arguments:
 *   --user <host uid>:<host gid>  overrides `USER root` (and every helper
 *                                 `docker exec` without --user inherits it);
 *                                 numeric, so no /etc/passwd lookup decides it
 *   --entrypoint sleep + infinity overrides ENTRYPOINT/CMD — no image-chosen
 *                                 process starts with the container
 *   --cap-drop ALL                the session user needs no capabilities; with
 *                                 no-new-privileges (always set) a setuid or
 *                                 file-capability binary in the image gains none
 *   --no-healthcheck              no image-chosen command runs periodically
 *   --stop-signal SIGTERM         an image STOPSIGNAL cannot stall every stop
 * Mounts, GPU, memory, pids, network and env are the same args every project
 * gets and never come from the image. The env-keys label is always written
 * (possibly empty) so an image LABEL can never stand in for it.
 */
const LOCKDOWN_ENTRYPOINT = ['sleep'];
const LOCKDOWN_CMD = ['infinity'];

/**
 * FEAT-157 — THE run-time lockdown table. `lockdownCreateArgs` flattens it, and
 * the per-project agent's container guide is generated from it: a rule added
 * here is enforced on every container AND told to the agent, with no second edit.
 */
export interface LockdownRule {
  args: () => string[];
  /** The Dockerfile instruction(s) this makes irrelevant at run time. */
  overrides: string;
  /** What the container gets instead, as the guide says it. */
  effect: string;
}
export const LOCKDOWN_RULES: LockdownRule[] = [
  { args: () => { const { uid, gid } = hostUidGid(); return ['--user', `${uid}:${gid}`]; }, overrides: 'USER', effect: 'the container runs as your host uid:gid' },
  { args: () => ['--entrypoint', LOCKDOWN_ENTRYPOINT[0]!], overrides: 'ENTRYPOINT / CMD', effect: 'the container idles (`sleep infinity`); sessions are exec\'d in' },
  { args: () => ['--cap-drop', 'ALL'], overrides: 'file capabilities / setuid binaries', effect: 'every capability is dropped (with no-new-privileges)' },
  { args: () => ['--no-healthcheck'], overrides: 'HEALTHCHECK', effect: 'no image-chosen command runs periodically' },
  { args: () => ['--stop-signal', 'SIGTERM'], overrides: 'STOPSIGNAL', effect: 'stop always sends SIGTERM' },
];

function lockdownCreateArgs(): string[] {
  return LOCKDOWN_RULES.flatMap((r) => r.args());
}

/**
 * BUG-136 — A FILE BIND IS PINNED TO AN INODE, AND THE WRITER REPLACES THE FILE.
 *
 * `docker run -v /host/file:/ctr/file` resolves the source ONCE, at create time,
 * and the container then holds THAT INODE for its whole life. Every bind above
 * whose source is a directory is safe (a directory mount follows the path), but
 * a single-file bind is not: the moment anything on the host replaces the file
 * the ordinary safe way — write a temp file, `rename()` over the original — the
 * container is left holding an unlinked inode nobody will ever write to again.
 * There is no error anywhere. The file is still there, still readable, and
 * frozen at its contents from the instant the container was created.
 *
 * `~/.claude/.credentials.json` is exactly that file, and Claude Code rotates
 * its OAuth token by atomic replace. So a container outlives one token rotation
 * and every session in it thereafter reports `Not logged in · Please run /login`
 * — the CLI's own turn ends `is_error` with no reply text, which is what the
 * user sees as an "Error" badge and a message that goes through and is never
 * answered. `doEnsure` already guards the case this LOOKS like (host
 * credentials file absent) and could never fire, because the host file is
 * present and perfectly valid; it is the container's copy of it that is a ghost.
 * Observed live 2026-08-21 on a container two days old: host inode 10156834
 * (509 bytes, valid tokens), container inode 7965302, link count 0 — an
 * unlinked ghost whose tokens had been blanked by a refresh nothing could save.
 *
 * So compare identity, not existence: for each file bind, the inode the host
 * path resolves to now vs the inode the container actually holds. A mismatch is
 * drift, and drift already means "recreate on the next ensure" — which re-binds
 * the current file and heals the session that is about to start.
 *
 * Deliberately narrow:
 *  - only FILE binds (a directory bind cannot fail this way);
 *  - only while the container RUNS (nothing to ask otherwise — and a stopped
 *    container is about to be started or recreated by `doEnsure` anyway);
 *  - a host path that does not exist right now is NOT reported. The stealth
 *    browser's socket comes and goes with its daemon, and flagging its absence
 *    would recreate the container on a schedule set by something unrelated.
 *  - any docker/stat surprise degrades to "no drift found", never to a spurious
 *    recreate: this check may only ever add a reason it can prove.
 */
function staleFileBinds(project: Project, live: Inspected): string[] {
  if (!live.running) return [];
  const files: { hostPath: string; containerPath: string; why: string; ino: string }[] = [];
  for (const b of desiredBinds(project)) {
    let st: fs.Stats;
    try {
      st = fs.statSync(b.hostPath);
    } catch {
      continue; // absent on the host — see the note above
    }
    if (st.isDirectory()) continue;
    files.push({ hostPath: b.hostPath, containerPath: b.containerPath, why: b.why, ino: String(st.ino) });
  }
  if (!files.length) return [];
  let r: RunResult;
  try {
    r = lifecycle.withProbe(() => dockerSync(['exec', containerName(project.id), 'stat', '-c', '%i %n', ...files.map((f) => f.containerPath)], 10_000));
  } catch {
    return [];
  }
  // `stat` reports what it can and exits non-zero for the rest, so the exit code
  // is not consulted — only the lines it actually produced.
  const inside = new Map<string, string>();
  for (const line of r.stdout.split('\n')) {
    const m = /^(\d+) (.+)$/.exec(line.trim());
    if (m) inside.set(m[2]!, m[1]!);
  }
  const out: string[] = [];
  for (const f of files) {
    const got = inside.get(f.containerPath);
    if (got === undefined) continue; // could not be read inside — unproven, so not a reason
    if (got !== f.ino) {
      out.push(
        `stale file bind ${f.hostPath} (${f.why}): the host file has been replaced since this container was created, ` +
          'so the container still holds the old one',
      );
    }
  }
  return out;
}

interface CacheEntry {
  at: number;
  status: ContainerStatus;
}
const statusCache = new Map<string, CacheEntry>();
/** Projects currently being built/created — surfaced as state 'building'. */
const building = new Set<string>();

/**
 * True while an image build / container create is in flight. Deliberately NOT
 * consulted by `statusOf` — that made statusOf report our own bookkeeping
 * instead of the container, and every internal "is it up yet?" assertion read
 * back "building" and failed. Only the HTTP status route layers this on.
 */
export function isBuilding(projectId: string): boolean {
  return building.has(projectId);
}

/** Live container state. Reads docker, never internal flags. */
export function statusOf(project: Project): ContainerStatus {
  const name = containerName(project.id);
  const cached = statusCache.get(project.id);
  if (cached && Date.now() - cached.at < STATUS_TTL_MS) {
    // Cheap liveness re-check: the expensive part (drift diff) is reused, but a
    // container that died 200ms ago must not still report "running".
    // Guarded: dockerSync throws when the docker binary is missing, and this
    // function is documented to RETURN state:'error', never to throw.
    try {
      const live = dockerSync(['inspect', name, '--format', '{{.State.Running}}']);
      const running = live.code === 0 && live.stdout.trim() === 'true';
      const wasRunning = cached.status.state === 'running';
      if (live.code === 0 && running === wasRunning) return cached.status;
      if (live.code !== 0 && cached.status.state === 'missing') return cached.status;
    } catch (err) {
      return { state: 'error', containerName: name, error: (err as Error).message };
    }
  }
  let status: ContainerStatus;
  try {
    const live = inspect(name);
    if (!live) {
      status = { state: 'missing', containerName: name, image: imageNameFor(project) };
    } else {
      const reasons = driftReasons(project, live);
      status = {
        state: live.running ? 'running' : 'stopped',
        containerName: name,
        image: live.image,
        startedAt: live.startedAt || undefined,
        drifted: reasons.length > 0 || undefined,
        driftReasons: reasons.length ? reasons : undefined,
      };
      if (reasons.some((r) => r.startsWith('lockdown:'))) {
        status.lockdownPending = reasons.every((r) => r.startsWith('lockdown:'))
          ? 'This container predates Orchard\'s run-time lockdown (host uid, no image entrypoint/healthcheck, all capabilities dropped). It is recreated under it at the next launch with no live session, or on Rebuild; it is never recreated under live sessions.'
          : 'This container predates Orchard\'s run-time lockdown. It also has other changes, so the next launch recreates it under the lockdown.';
      }
    }
    // FEAT-155 round 8 — the same reserved-ENV policy ensureImage enforces,
    // reported so a refused image is visible before (and after) a launch fails.
    const refused = imageEnvProblem(imageNameFor(project));
    if (refused) status.imageRefused = refused;
  } catch (err) {
    status = { state: 'error', containerName: name, error: (err as Error).message };
  }
  // Probe the host only when the setting depends on it ('off' never does).
  const gSetting = containerSettingsOf(project).gpu;
  status.gpu = { setting: gSetting, effective: gpuEnabled(project), hostReason: gSetting === 'off' ? 'GPU off for this project' : hostGpuAvailable().reason };
  // Host total RAM as context for the memory cap — os.totalmem() is bytes.
  status.hostMemoryMb = Math.round(os.totalmem() / (1024 * 1024));
  if (imageSourceOf(project) === 'dockerfile') {
    try { status.dockerfile = dockerfileStatus(project); } catch (err) { status.dockerfile = undefined; status.error = status.error ?? (err as Error).message; }
  }
  statusCache.set(project.id, { at: Date.now(), status });
  return status;
}

/** FEAT-155 round 5 — the Dockerfile half of a project's container status (read-only). */
export function dockerfileStatus(project: Project): DockerfileStatus {
  const eff = dockerfileEffectiveImage(project);
  const rec = recordFor(project);
  const building = rec.state === 'building';
  return {
    path: eff.resolution.rel,
    hash: eff.resolution.ok ? eff.resolution.hash! : null,
    wantedImage: eff.wanted,
    effectiveImage: eff.image,
    built: !!eff.wanted && eff.image === eff.wanted && isOwnProjectImage(project, eff.wanted),
    fellBack: eff.fellBack,
    problem: eff.reason ?? null,
    lastGoodImage: rec.lastGoodImage,
    build: { state: building ? 'building' : rec.state, hash: rec.hash, startedAt: rec.startedAt, finishedAt: rec.finishedAt, error: rec.error },
  };
}

export function invalidate(projectId: string): void {
  statusCache.delete(projectId);
}

/* ------------------------------------------------------------------- image */

function imageExists(image: string): boolean {
  return dockerSync(['image', 'inspect', image, '--format', '{{.Id}}']).code === 0;
}

/** Resolved sha of a local image, or '' when it is not present locally. */
function imageIdOf(image: string): string {
  const r = dockerSync(['image', 'inspect', image, '--format', '{{.Id}}'], 10_000);
  return r.code === 0 ? r.stdout.trim() : '';
}

/**
 * BUG-107 — reclaim images superseded by a definition change.
 *
 * The hashed tag's one real cost: every edit to the Dockerfile or the
 * provisioning manifest mints a new tag and leaves the old one holding ~1 GB of
 * layers that nothing will ever reference again. Disk is finite, so the cost is
 * paid here, right after each successful build.
 *
 * Guards, because deleting images is not the kind of thing to be approximate
 * about:
 *  1. only the repo we own (`claude-station-base`) and only tags matching the
 *     shape WE generate — `u{uid}-g{gid}[-{hash}]`. A user's own image, or a
 *     project's custom `settings.container.image`, cannot match by accident;
 *  2. BUG-218 — only base images THIS instance built. Every Orchard instance and
 *     every uid on the host shares one daemon and one repo name, so "matches our
 *     tag shape" is not ownership: it removed other instances', other uids' and a
 *     concurrent lane's fresh tags. The builder declares ownership with the owner
 *     label (`instance-owner.ts`, the one authority); a foreign key is left alone,
 *     and an UNLABELLED image (built before the label existed) is never removed —
 *     it is returned in `unlabelled` so the caller can report it for a person;
 *  3. removal is by the image ID that was inspected, never by tag, so a tag moved
 *     onto another instance's image in between is not untagged or deleted;
 *  4. never `--force`, so docker itself refuses while ANY container (running or
 *     merely stopped) still references the image, or the image carries another
 *     tag. Another project mid-upgrade, or a stopped container the user means to
 *     restart, wins over tidiness;
 *  5. never the tag we were just asked to keep.
 * Failures are collected, never thrown: cleanup must not be able to fail a build.
 */
export function pruneSupersededImages(keepArg: string | Set<string>): { removed: string[]; kept: string[]; unlabelled: string[]; busy: string[] } {
  const keepSet = typeof keepArg === 'string' ? new Set([keepArg]) : keepArg;
  const keepIds = new Set([...keepSet].filter((r) => /^sha256:[0-9a-f]{64}$/.test(r)));
  const removed: string[] = [];
  const kept: string[] = [];
  const unlabelled: string[] = [];
  /** This instance's own superseded images docker refused to remove because a container still uses them. */
  const busy: string[] = [];
  let listed: RunResult;
  try {
    // FEAT-157: the base repo AND the CLI-layer repo; both are Orchard's, owner-labelled, kept by reference.
    const a = dockerSync(['images', `${IMAGE_REPO}`, '--format', '{{.Repository}}:{{.Tag}}'], 20_000);
    const b = dockerSync(['images', `${RUNTIME_REPO}`, '--format', '{{.Repository}}:{{.Tag}}'], 20_000);
    listed = { code: a.code || b.code, stdout: `${a.stdout}\n${b.stdout}`, stderr: a.stderr + b.stderr };
  } catch {
    return { removed, kept, unlabelled, busy };
  }
  if (listed.code !== 0) return { removed, kept, unlabelled, busy };
  for (const ref of listed.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
    const [repo, tag = ''] = [ref.slice(0, ref.lastIndexOf(':')), ref.slice(ref.lastIndexOf(':') + 1)];
    // Round 3: also this instance's own staging tags left by a build that died (never one in flight).
    const ownStaging = tag.startsWith(`build-${ownerKey()}-`) && !activeStaging.has(ref);
    const shape = repo === IMAGE_REPO ? STATION_TAG_RE.test(tag) : repo === RUNTIME_REPO ? RUNTIME_TAG_RE.test(tag) : false;
    if ((repo !== IMAGE_REPO && repo !== RUNTIME_REPO) || !(shape || ownStaging) || keepSet.has(ref)) { kept.push(ref); continue; }
    // ARCH-022 (d-i): a pin names its base by immutable ID; a tag of a kept id is kept too (untagging its last
    // name would delete the very bytes the pin is bound to).
    if (keepIds.size) { const rid = imageIdOf(ref); if (rid && keepIds.has(rid)) { kept.push(ref); continue; } }
    let ins: ReturnType<typeof imageOwnerOf>;
    try {
      ins = imageOwnerOf(ref);
    } catch { kept.push(ref); continue; }
    if (!ins) { kept.push(ref); continue; }
    const { id, owner: who } = ins;
    if (who === 'unlabelled') unlabelled.push(ref);
    if (who !== 'own' || !id) { kept.push(ref); continue; }
    let r: RunResult;
    try { r = dockerSync(['image', 'rm', id], 60_000); } catch { kept.push(ref); continue; }
    if (r.code === 0) removed.push(ref);
    else { kept.push(ref); if (/being used|used by|container/i.test(r.stderr) && !/must be forced|multiple/i.test(r.stderr)) busy.push(ref); }
  }
  return { removed, kept, unlabelled, busy };
}

/**
 * What a project's container isolation is provisioned WITH — the answer to
 * "which Serena version is actually running in there", without starting a
 * session. Read-only; safe to call from a status/pre-flight route.
 *
 * `state` is the pre-flight verdict a panel renders:
 *   missing     — nothing built yet;
 *   stale       — an image exists, but not the one this definition describes
 *                 (the exact condition that hid BUG-035's fix for two weeks);
 *   provisioned — the built artifact matches the current definition.
 */
export function containerProvisionState(project: Project): {
  state: ProvisionState;
  image: string;
  custom: boolean;
  wantedSerenaVersion: string;
  imageSerenaVersion: string | null;
  wantedClaudeVersion: string;
  imageClaudeVersion: string | null;
  provisionHash: string;
  imageProvisionHash: string | null;
  detail: string;
} {
  const image = imageNameFor(project);
  const src = imageSourceOf(project);
  const custom = src !== 'station';
  const pin = serenaPin();
  // FEAT-157: the recipe this project's TARGET base was made from (a release's frozen
  // hash, the working tree for dev, the legacy tag's own hash), not the working tree.
  const target = src === 'custom' ? null : baseTargetOf(project);
  const cat = baseRel.readCatalog();
  const want = target?.kind === 'version' ? baseRel.releaseOf(cat, target.version)?.hash ?? provisionHash()
    : target?.kind === 'legacy' ? (/-([0-9a-f]{12})$/.exec(target.tag)?.[1] ?? provisionHash())
      : provisionHash();
  let imageHash: string | null = null;
  let imageVer: string | null = null;
  let exists = false;
  try {
    const r = dockerSync(['image', 'inspect', image, '--format', '{{index .Config.Labels "claude-station.provision-hash"}}\t{{index .Config.Labels "claude-station.serena-version"}}'], 10_000);
    exists = r.code === 0;
    if (exists) {
      const [h = '', v = ''] = r.stdout.trim().split('\t');
      imageHash = h && h !== '<no value>' ? h : null;
      imageVer = v && v !== '<no value>' ? v : null;
    }
  } catch { /* docker unavailable — reported as missing below */ }
  // FEAT-157: the CLI a container needs is the host SDK's (never a pin in provision.json);
  // the image's is what its own labels say it carries (the CLI layer, or a legacy base's).
  const imageCcVer = exists ? carriedCliOf(image) : null;
  const cc = { wantedClaudeVersion: hostCliSync()?.version ?? 'unknown (host runtime not yet proven)', imageClaudeVersion: imageCcVer };
  if (src === 'dockerfile') {
    const df = dockerfileStatus(project);
    const state: ProvisionState = df.built ? 'provisioned' : df.effectiveImage && df.effectiveImage !== df.wantedImage ? 'stale' : 'missing';
    return { state, image, custom: true, wantedSerenaVersion: pin.version,
      imageSerenaVersion: imageVer, ...cc, provisionHash: want, imageProvisionHash: imageHash,
      detail: df.built
        ? `built from the project's ${df.path}; Orchard rebuilds it when that file changes.`
        : df.problem
          ? `${df.path}: ${df.problem}${df.effectiveImage ? ` — running the last good image ${df.effectiveImage}` : ''}`
          : `${df.path} changed since the image was built; the next session (or Rebuild) builds it.` };
  }
  if (custom) {
    return { state: exists ? 'provisioned' : 'missing', image, custom: true, wantedSerenaVersion: pin.version,
      imageSerenaVersion: imageVer, ...cc, provisionHash: want, imageProvisionHash: imageHash,
      detail: `custom image "${image}" — Claude Station does not build or provision it; its tooling is yours to manage.` };
  }
  if (!exists) {
    return { state: 'missing', image, custom: false, wantedSerenaVersion: pin.version, imageSerenaVersion: null,
      ...cc, provisionHash: want, imageProvisionHash: null,
      detail: `image ${image} has not been built yet; the next session (or Rebuild) builds it.` };
  }
  if (imageHash !== want) {
    return { state: 'stale', image, custom: false, wantedSerenaVersion: pin.version, imageSerenaVersion: imageVer,
      ...cc, provisionHash: want, imageProvisionHash: imageHash,
      detail: `the built image was made from a different definition (${imageHash ?? 'unlabelled'} vs ${want}); it will be rebuilt on the next session.` };
  }
  return { state: 'provisioned', image, custom: false, wantedSerenaVersion: pin.version, imageSerenaVersion: imageVer,
    ...cc, provisionHash: want, imageProvisionHash: imageHash,
    detail: `${pin.package} ${imageVer ?? pin.version} is baked into ${image}; sessions start it locally with no fetch.` };
}

const imageBuilds = new Map<string, Promise<string>>();

/**
 * Set by a successful build, consumed once the container has been recreated on
 * it. See the comment at the assignment for why the sweep cannot run earlier.
 */
let pruneAfterRecreate: string | null = null;

function flushPrune(onLog?: (s: string) => void): void {
  const keep = pruneAfterRecreate;
  if (!keep) return;
  pruneAfterRecreate = null;
  // FEAT-157 (finding 11): collect by artifact identity. Kept: every registered
  // container project's wanted base + CLI-layer image (a pin on an older release is
  // a reference, not garbage), the image just built, and what containers use
  // (docker refuses those anyway — never --force).
  const keepSet = imageKeepSet();
  keepSet.add(keep);
  const gc = pruneSupersededImages(keepSet);
  // Round 8: an own superseded image still in use (a container deferred its swap) is retried by a later
  // ensure instead of being forgotten — unless a newer build has armed its own sweep meanwhile.
  if (gc.busy.length && pruneAfterRecreate === null) pruneAfterRecreate = keep;
  if (gc.removed.length) onLog?.(`[container] reclaimed superseded image(s): ${gc.removed.join(', ')}\n`);
  if (gc.unlabelled.length) {
    onLog?.(
      `[container] left ${gc.unlabelled.length} unlabelled base image(s) alone: ${gc.unlabelled.join(', ')}. They predate owner labels, so Orchard ` +
        'cannot tell which instance or user they belong to; remove them by hand (docker image rm) if nothing uses them.\n',
    );
  }
  pruneBaseLayouts();
}

/** FEAT-157 — the images no prune may take: every registered container project's wanted base, parent and CLI-layer image. */
function imageKeepSet(): Set<string> {
  const keep = new Set<string>();
  let projects: Project[] = [];
  try { projects = listProjects(); } catch { return keep; }
  for (const p of projects) {
    if (p.isolation !== 'container') continue;
    try {
      const plan = imagePlanOf(p);
      if (plan.baseRef) keep.add(plan.baseRef);
      if (plan.parent) keep.add(plan.parent);
      keep.add(imageOfPlan(plan));
      // (b-ii) not yet proven either way: keep both the parent and its CLI layer, whichever the launch will use
      if (plan.parent) { const rt = runtimeImageNameFor(plan.parent); if (rt) keep.add(rt); }
      if (imageSourceOf(p) === 'dockerfile') { const lg = recordFor(p).lastGoodImage; if (lg) keep.add(lg); }
    } catch { /* a project we cannot resolve keeps nothing extra; docker still refuses in-use images */ }
  }
  for (const b of imageBuilds.keys()) keep.add(b);
  return keep;
}

/**
 * Build the image if missing. Deduped by image name so ten projects starting at
 * once produce one build, not ten.
 */
export async function ensureImage(project: Project, opts: { force?: boolean; onLog?: (s: string) => void } = {}): Promise<string> {
  return (await ensureImageFull(project, opts)).image;
}

/** FEAT-157 — what an ensure runs: the final image, the image the CLI layer went on, and the base. */
interface Resolved {
  image: string;
  /** The Dockerfile image (or base) under the CLI layer; for FEAT-155's last-good bookkeeping. */
  parent: string;
  base: string | null;
  target: baseRel.Target | null;
}

async function ensureImageFull(project: Project, opts: { force?: boolean; onLog?: (s: string) => void; plan?: ImagePlan }): Promise<Resolved> {
  const r = await resolveImage(project, opts.plan ?? imagePlanOf(project), opts);
  // FEAT-155 round 8 — one reserved-ENV policy for every image source, checked
  // here because container create (doEnsure) and Rebuild both come through
  // this, BEFORE either touches the existing container.
  assertImageEnvAllowed(project, r.image);
  return r;
}

/** FEAT-157 — the last apply failure per project for its current target (in memory; the rail reads it). */
const baseApplyErrors = new Map<string, { target: string; error: string }>();
export function baseApplyErrorOf(project: Project): string | null {
  const e = baseApplyErrors.get(project.id);
  if (!e) return null;
  return e.target === JSON.stringify(baseTargetOf(project)) ? e.error : null;
}

/** ARCH-022 (d-i): per project, the immutable id the pinned base resolved to in the running operation. */
const resolvedPinImage = new Map<string, { imageId: string; target: baseRel.Target }>();
/** Record that id on the stored pin (only the pin the target came from; a moved or re-adopted pin is left alone). */
function recordPinImage(projectId: string): void {
  const r = resolvedPinImage.get(projectId);
  resolvedPinImage.delete(projectId);
  if (!r) return;
  let row: Project | undefined;
  try { row = listProjects().find((x) => x.id === projectId); } catch { return; }
  if (!row) return;
  const pin = baseRel.basePinRecord(containerSettingsOf(row).base);
  if (!pin || pin.imageId === r.imageId) return;
  const p = baseRel.parsePin(pin);
  const same = (r.target.kind === 'legacy' && p.kind === 'legacy' && p.tag === r.target.tag)
    || (r.target.kind === 'version' && p.kind === 'version' && p.version === r.target.version);
  if (!same) return;
  try { updateProject(projectId, { settings: { container: { base: { ...pin, imageId: r.imageId } } } } as unknown as Partial<Project>); } catch { /* unwritable: recorded next time */ }
}

async function resolveImage(project: Project, plan: ImagePlan, opts: { force?: boolean; onLog?: (s: string) => void }): Promise<Resolved> {
  const src = plan.source;
  if (src === 'custom') {
    const image = plan.parent!;
    // A user-supplied image is not ours to build (and not ours to layer: FEAT-157 leaves it as is).
    if (!imageExists(image)) {
      throw new ContainerError('image-missing', `image "${image}" is not present locally and Claude Station will not build a custom image for you. \`docker pull\` it first, or clear settings.container.image.`);
    }
    return { image, parent: image, base: null, target: null };
  }
  const target = plan.target!;
  if (target.kind === 'recovery') {
    throw new ContainerError('base-pin-invalid',
      `this project has no usable base pin (${target.why}), so Orchard will not pick a base for it. Choose a base release on the project's Needs-You rail (Adopt); an existing container keeps running until then.`);
  }
  const tkey = JSON.stringify(target);
  try {
    let base: string;
    if ((target.kind === 'legacy' || target.kind === 'version') && plan.baseRef?.startsWith('sha256:')) {
      if (!imageExists(plan.baseRef)) {
        throw new ContainerError('base-image-missing', `the base this project is pinned to (${target.kind === 'legacy' ? `legacy ${target.tag}` : `v${target.version}`}, image ${plan.baseRef.slice(7, 19)}) is no longer on this daemon, and Orchard never substitutes whatever its tag names now. Choose a base release on the project's Needs-You rail (Adopt).`);
      }
      base = plan.baseRef;
    } else base = await ensureBaseImage(target, { force: opts.force && src === 'station', onLog: opts.onLog });
    // (d-i) what the pinned base resolved to — the authority records it on the pin when this operation succeeds
    if (target.kind === 'legacy' || (target.kind === 'version' && !target.raisedBySecurity)) {
      const bid = base.startsWith('sha256:') ? base : imageIdOf(base);
      if (bid) resolvedPinImage.set(project.id, { imageId: bid, target });
    }
    let parent = base;
    if (src === 'dockerfile' && (target.kind === 'legacy' || target.kind === 'version') && target.imageId && !base.startsWith('sha256:')) {
      const now = imageIdOf(base);
      if (now !== target.imageId && (target.kind === 'legacy' || imageExists(target.imageId))) {
        throw new ContainerError('base-image-moved', `the base tag ${base} no longer names the image this project is pinned to (${target.imageId.slice(7, 19)}; it names ${now ? now.slice(7, 19) : 'nothing'}). Orchard never builds on bytes a tag gained since the pin; choose a base release on the project's Needs-You rail (Adopt).`);
      }
    }
    if (src === 'dockerfile') {
      parent = await ensureDockerfileImage(project, { ...opts, baseRef: base });
      // A security target must actually be what runs: a Dockerfile build that fell back to its
      // last good image (built on the vulnerable base) does not satisfy it (decision: block new launches).
      // (attack round 3, b) whenever a security floor is in force — raised to it OR adopted at/above it.
      if (target.kind === 'version' && target.floor) {
        const want = resolveProjectDockerfile(project);
        const fb = observedBaseOf(parent);
        const fbOk = fb.kind === 'version' && fb.via === 'label' && fb.version >= target.floor && baseRel.releaseOf(plan.catalog, fb.version)?.hash === fb.hash;
        if ((!want.ok || parent !== want.image) && !fbOk) {
          throw new ContainerError('security-update-failed',
            `security base v${target.version} is due, but this project's Dockerfile could not be built on it (${want.ok ? recordFor(project).error ?? 'build failed' : want.error}); its last good image is on the older base. New sessions are refused until the Dockerfile builds on v${target.version}; sessions already running are not touched.`);
        }
      }
    }
    const cli = await hostCli();
    // The parent is used as is ONLY when its own bytes are the host's CLI (a legacy base still matching the host);
    // otherwise the one-file layer goes on top. Labels decide nothing here (attack round 1, d).
    // (d-i) a base named by its id: the layer records the base the PIN names (the id has no tag of its own to read)
    const baseRefLabel = parent === base && base.startsWith('sha256:')
      ? (target.kind === 'legacy' ? target.tag : target.kind === 'version' ? `v${target.version}-${ugTag()}-${target.hash}` : undefined)
      : undefined;
    const image = carriesHostCli(parent, { prove: true, cliSha: cli.sha256 }) === 'yes' ? parent : await ensureRuntimeImage(parent, cli, { force: opts.force, onLog: opts.onLog, baseRefLabel });
    baseApplyErrors.delete(project.id);
    return { image, parent, base, target };
  } catch (err) {
    const e = err as Error;
    baseApplyErrors.set(project.id, { target: tkey, error: e.message.split('\n')[0]!.slice(0, 400) });
    if (target.kind === 'version' && target.floor && !(err instanceof ContainerError && err.code === 'security-update-failed')) {
      throw new ContainerError('security-update-failed',
        `security base v${target.version} is due for this project and could not be built: ${e.message.split('\n')[0]}. New sessions are refused until it builds; sessions already running are not touched.`,
        err instanceof ContainerError ? err.detail : '');
    }
    throw err;
  }
}

/**
 * Id + owner of the image a ref names right now; null ONLY when the daemon says the ref names nothing.
 * The config is read as JSON: `.Config.Labels` fails outright on an image with no labels at all, and
 * reading that failure as "absent" let a build re-point the tag over it (BUG-218 round 2). Any other
 * failure reads as "someone else's" (id ''), so it can only make a caller hold back.
 */
function imageOwnerOf(ref: string): { id: string; owner: Ownership } | null {
  const r = dockerSync(['image', 'inspect', ref, '--format', '{{json .Id}}\t{{json .Config}}'], 10_000);
  if (r.code !== 0) return /no such image/i.test(r.stderr + r.stdout) ? null : { id: '', owner: 'foreign' };
  try {
    const [idJ = '', configJ = 'null'] = r.stdout.trim().split('\t');
    const id = JSON.parse(idJ) as string;
    const labels = ((JSON.parse(configJ) as { Labels?: Record<string, string> } | null)?.Labels ?? {}) as Record<string, string>;
    return { id: /^sha256:[0-9a-f]{64}$/.test(id) ? id : '', owner: ownershipOf(labels[LABEL_OWNER]) };
  } catch { return { id: '', owner: 'foreign' }; }
}

/**
 * BUG-218 round 2 — the shared base tag is re-pointed under a daemon-wide mutex, so two instances whose
 * builds finish together (BuildKit merges identical builds, so they usually do) cannot both read "free"
 * and both tag. The mutex is a never-started container with a fixed name derived from the tag: docker
 * refuses a second create with the same name, atomically, whoever asks. It references the image just
 * built, which also holds that image while the tag moves. A holder that died leaves it behind; one older
 * than two minutes is stale (the section it guards is two inspects and a tag) and is removed by its id.
 */
async function withBaseTagLock<T>(image: string, holdImage: string, fn: () => T): Promise<T> {
  const lockName = `orchard-basetag-lock-${crypto.createHash('sha256').update(image).digest('hex').slice(0, 16)}`;
  const deadline = Date.now() + 150_000;
  let mine = '';
  for (;;) {
    const c = dockerSync(['create', '--name', lockName, '--network', 'none', '--label', 'orchard.basetag-lock=1', ...ownerLabelArgs(), holdImage, 'true'], 30_000);
    if (c.code === 0) { mine = c.stdout.trim().split('\n').pop()?.trim() ?? ''; break; }
    if (!/already in use|conflict/i.test(c.stderr)) {
      throw new ContainerError('build-failed', `could not take the base-tag lock for ${image}`, c.stderr.trim().slice(0, 600));
    }
    const ins = dockerSync(['inspect', lockName, '--format', '{{.Id}}\t{{.Created}}\t{{index .Config.Labels "orchard.basetag-lock"}}'], 10_000);
    const [lid = '', created = '', isLock = ''] = ins.stdout.trim().split('\t');
    // Age by the DAEMON's clock (round 3): a client clock ahead of the daemon's must not make a fresh lock look stale.
    const now = Date.parse(dockerSync(['info', '--format', '{{json .SystemTime}}'], 10_000).stdout.trim().replace(/^"|"$/g, ''));
    if (ins.code === 0 && isLock === '1' && Number.isFinite(now) && now - Date.parse(created) > 120_000) {
      dockerSync(['rm', '-f', lid], 30_000); // a dead holder's lock (by id: a fresh one taken meanwhile is not hit)
      continue;
    }
    if (Date.now() > deadline) throw new ContainerError('build-failed', `timed out waiting for the base-tag lock ${lockName} (another Orchard instance is tagging ${image})`);
    await new Promise((res) => setTimeout(res, 250));
  }
  try { return fn(); } finally { if (mine) dockerSync(['rm', '-f', mine], 30_000); }
}

function refuseForeignBase(image: string, owner: Ownership): never {
  throw new ContainerError(
    'foreign-owner',
    owner === 'unlabelled'
      ? `the base image ${image} has no owner label and this server is not the declared live instance; rebuilding would replace it under whoever uses it. If this IS your live Orchard, declare it once (node scripts/orchard-live-instance.mjs declare) and restart it. Otherwise remove it by hand (docker image rm ${image}) if nothing needs it, then Rebuild.`
      : `the base image ${image} was built by another Orchard instance (a different data dir); rebuilding would replace it under that instance. Rebuild from the instance that built it, or remove it there.`,
  );
}

/**
 * FEAT-157 — the base image a target names, built if missing (or when forced).
 *
 *  - `vN`: built ONCE per machine from its frozen snapshot `releases/vN/` and then
 *    kept; the recipe must still hash to the catalog's entry. A security release
 *    builds with --no-cache --pull and must prove its `verify` packages moved.
 *    A rebuild (the image was removed, or a forced Rebuild) is recorded as "same
 *    recipe, not same bytes" (`base-artifacts.json`).
 *  - `dev`: the working-tree recipe (only projects pinned to dev see it).
 *  - `legacy`: predates releases, cannot be rebuilt: present or an honest error.
 */
async function ensureBaseImage(t: baseRel.Target, opts: { force?: boolean; onLog?: (s: string) => void } = {}): Promise<string> {
  const image = baseRefOfTarget(t);
  if (!image) throw new ContainerError('base-pin-invalid', 'no base for a project in recovery');
  if (t.kind === 'legacy') {
    if (imageExists(image)) {
      if (opts.force) opts.onLog?.(`[container] ${image} is a legacy base (it predates numbered releases) and cannot be rebuilt; Rebuild keeps it. Adopt a release on the rail to move off it.\n`);
      return image;
    }
    throw new ContainerError('base-legacy-missing',
      `this project is pinned to the legacy base ${image}, which is no longer present and cannot be rebuilt (it predates numbered releases). Adopt a base release on the project's Needs-You rail; nothing was changed.`);
  }
  if (t.kind === 'dev') {
    return buildBaseImage({ image, ctx: baseRel.containerDir(), recipe: provisionHash(), labels: [], opts });
  }
  if (t.kind !== 'version') throw new ContainerError('base-pin-invalid', 'no base for this target');
  const cat = baseRel.readCatalog();
  const rel = baseRel.releaseOf(cat, t.version);
  if (!rel || rel.hash !== t.hash) throw new ContainerError('base-pin-invalid', `base v${t.version} (${t.hash}) is not in the release catalog as read now; nothing was built`);
  const dir = baseRel.releaseDir(t.version);
  if (!opts.force && imageExists(image)) {
    // The tag names version + recipe; the image under it must say the same (a tag re-pointed by hand is not trusted).
    const l = imageLabels(image);
    if (l[LABEL_BASE_VERSION] === String(t.version) && l['claude-station.provision-hash'] === t.hash) {
      // A security release must PROVE its packages on the image actually used, not only when this instance built
      // it (another instance's, or a planted, image under the tag never ran our check). Cached per image id.
      if (rel.class === 'security' && rel.verify?.length) {
        const id = imageIdOf(image);
        if (!verifiedImages.has(id)) { verifyPackages(image, rel.verify, opts.onLog); verifiedImages.add(id); }
      }
      return image;
    }
    const cur = imageOwnerOf(image);
    if (!cur || !mayActOn(cur.owner)) {
      throw new ContainerError('base-image-mismatch', `${image} does not carry base v${t.version}'s recipe (${t.hash}) and is not this instance's to rebuild; remove it by hand if nothing uses it. Nothing was changed.`);
    }
    opts = { ...opts, force: true }; // our own tag holding the wrong bytes: rebuild it from the frozen snapshot
  }
  if (!fs.existsSync(path.join(dir, 'Dockerfile')) || !fs.existsSync(path.join(dir, 'provision.json'))) {
    throw new ContainerError('base-snapshot-missing',
      `base v${t.version} is not present and its recipe snapshot (${dir}) is missing, so it cannot be rebuilt. Orchard will not move this project to another base on its own; restore the snapshot, or choose another release on the rail.`);
  }
  const recipe = recipeHash(dir);
  if (rel.hash !== recipe) {
    throw new ContainerError('base-snapshot-mismatch',
      `the recipe snapshot for base v${t.version} (${dir}) hashes to ${recipe}, not the ${rel.hash} the release recorded; it was edited after the release was cut. Refusing to build it.`);
  }
  const security = rel.class === 'security';
  return buildBaseImage({
    image, ctx: dir, recipe,
    labels: ['--label', `${LABEL_BASE_VERSION}=${t.version}`],
    extraArgs: security ? ['--no-cache', '--pull'] : [],
    verify: security ? rel.verify ?? [] : [],
    record: true,
    opts,
  });
}

/**
 * Build one base image (release, or dev) to a private staging tag and point the
 * shared tag at it only if the tag is free or ours.
 *
 * BUG-218 — the tag is the same for every instance of this uid, so it is a cache
 * they share: an existing image under it is USED whoever built it. What an
 * instance may not do is re-point that tag away from an image another instance
 * built (or, for an isolated instance, an unlabelled one): docker then untags it
 * — and with the containerd image store deletes it, even under a running
 * container. A concurrent build that got there first wins and ours is discarded.
 * A Rebuild over a tag that is not ours refuses before building.
 */
async function buildBaseImage(b: {
  image: string; ctx: string; recipe: string; labels: string[]; extraArgs?: string[]; verify?: baseRel.VerifyPkg[]; record?: boolean;
  opts: { force?: boolean; onLog?: (s: string) => void };
}): Promise<string> {
  const { image, opts } = b;
  if (!opts.force && imageExists(image)) return image;
  const existing = imageBuilds.get(image);
  if (existing) return existing;
  let rebuiltOver: string | null = null;
  if (opts.force) {
    const cur = imageOwnerOf(image);
    if (cur && !mayActOn(cur.owner)) refuseForeignBase(image, cur.owner);
    rebuiltOver = cur?.id ?? null;
  }
  const tagPart = image.slice(image.lastIndexOf(':') + 1);
  // Per-build nonce: another instance cannot pre-plant an image under a name it cannot predict (round 2).
  const staging = `${IMAGE_REPO}:build-${ownerKey()}-${tagPart}-${crypto.randomBytes(4).toString('hex')}`;
  activeStaging.add(staging);
  if (!fs.existsSync(path.join(b.ctx, 'Dockerfile'))) {
    activeStaging.delete(staging);
    throw new ContainerError('dockerfile-missing', `container Dockerfile not found at ${b.ctx}/Dockerfile`);
  }
  const { uid, gid } = hostUidGid();
  let serena = { version: '', package: '' };
  try { const j = JSON.parse(fs.readFileSync(path.join(b.ctx, 'provision.json'), 'utf8')) as { tools?: Record<string, { version?: string; package?: string }> }; serena = { version: j.tools?.serena?.version ?? '', package: j.tools?.serena?.package ?? '' }; } catch { /* labels only */ }
  const p = (async () => {
    const args = [
      'build',
      ...(b.extraArgs ?? []),
      '--build-arg', `HOST_UID=${uid}`,
      '--build-arg', `HOST_GID=${gid}`,
      // BUG-107 — stamp the artifact with what it was made from, machine-readably.
      '--label', 'claude-station.image=1',
      // BUG-218 — the base belongs to the instance (data dir) that built it; the
      // post-build prune removes only base images carrying this instance's key.
      ...ownerLabelArgs(),
      '--label', `claude-station.provision-hash=${b.recipe}`,
      '--label', `claude-station.serena-version=${serena.version}`,
      '--label', `claude-station.serena-package=${serena.package}`,
      // FEAT-157 — which base this is (the observed-artifact label every derived image carries),
      // and NO baked CLI: an inherited legacy CLI label is cleared so nothing believes one is there.
      '--label', `${LABEL_BASE_REF}=${tagPart}`,
      '--label', `${LABEL_LEGACY_CLI}=`,
      '--label', `${LABEL_RUNTIME}=`, '--label', `${LABEL_CLI_VERSION}=`, '--label', `${LABEL_CLI_SHA}=`, '--label', `${LABEL_RUNTIME_PARENT}=`,
      ...b.labels,
      '-t', staging,
      '-f', path.join(b.ctx, 'Dockerfile'),
      b.ctx,
    ];
    const r = await dockerAsync(args, 20 * 60_000, opts.onLog);
    if (r.code !== 0) {
      throw new ContainerError('build-failed', `image build failed for ${image}`, (r.stderr || r.stdout).trim().slice(-3000));
    }
    const built = imageOwnerOf(staging);
    if (!built || built.owner !== 'own') {
      // Distrust the exit code: assert the artifact actually exists, and is the one we built.
      throw new ContainerError('build-failed', `docker build reported success but image ${staging} is not present`);
    }
    // FEAT-157 finding 1 — a security release must PROVE its packages moved.
    if (b.verify?.length) {
      try { verifyPackages(staging, b.verify, opts.onLog); verifiedImages.add(built.id); } catch (e) { dockerSync(['image', 'rm', staging], 60_000); throw e; }
    }
    // Point the shared tag at it only if the tag is free or ours (re-read now: a build takes minutes),
    // under the daemon-wide tag lock so a concurrent builder cannot read "free" at the same time.
    const outcome = await withBaseTagLock(image, built.id, () => {
      const cur = imageOwnerOf(image);
      if (cur && cur.id !== built.id && (opts.force ? !mayActOn(cur.owner) : cur.owner !== 'own')) return cur;
      if (!cur || cur.id !== built.id) {
        const t = dockerSync(['tag', built.id, image], 30_000);
        if (t.code !== 0) throw new ContainerError('build-failed', `could not tag the built base as ${image}`, (t.stderr || t.stdout).trim().slice(0, 600));
      }
      return null;
    });
    if (outcome) {
      dockerSync(['image', 'rm', staging], 60_000); // untags our staging name; deletes our image if nothing else holds it
      if (opts.force) refuseForeignBase(image, outcome.owner);
      opts.onLog?.(`[container] ${image} was built by another instance while this one built; using that image\n`);
      return image;
    }
    dockerSync(['image', 'rm', staging], 60_000); // our staging name only; the image stays under `image`
    if (!imageExists(image)) {
      throw new ContainerError('build-failed', `docker build reported success but image ${image} is not present`);
    }
    if (b.record) recordBaseArtifact(image, built.id, rebuiltOver, opts.onLog);
    /*
     * Do NOT prune here. At this instant the superseded image is still the one
     * the live container runs, so docker refuses every removal and the sweep
     * reclaims nothing — measured, not assumed (BUG-107 verification F1 failed
     * exactly this way). The sweep is armed here and fired by `doEnsure` after the
     * container is confirmed running.
     */
    pruneAfterRecreate = image;
    return image;
  })().finally(() => { imageBuilds.delete(image); activeStaging.delete(staging); });
  imageBuilds.set(image, p);
  return p;
}

/** FEAT-157 — security base images whose package proof passed in this process (by image id). */
const verifiedImages = new Set<string>();

/** Staging tags of base builds in flight in THIS process (the prune never reclaims those). */
const activeStaging = new Set<string>();

/**
 * FEAT-157 — prove each `verify` package in a freshly built security base reached
 * its minimum version (`dpkg --compare-versions`, inside the image, offline, as an
 * unprivileged throwaway container). Throws on any shortfall or unreadable result.
 */
function verifyPackages(image: string, verify: baseRel.VerifyPkg[], onLog?: (s: string) => void): void {
  const script = verify.map((v, i) => `v${i}=$(dpkg-query -W -f='\${Version}' '${v.package}' 2>/dev/null) || { echo "MISSING ${v.package}"; exit 3; }; ` +
    `echo "HAVE ${v.package} $v${i}"; dpkg --compare-versions "$v${i}" ge '${v.minVersion}' || { echo "LOW ${v.package} $v${i} < ${v.minVersion}"; exit 4; }`).join('; ');
  const name = `claude-station-verify-${crypto.randomBytes(6).toString('hex')}`;
  try {
    const r = dockerSync(['run', '--rm', '--name', name, '--network', 'none', '--label', 'claude-station.smoke=1', ...ownerLabelArgs(),
      '--user', '65534:65534', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--entrypoint', 'sh', image, '-c', script], 120_000);
    const out = (r.stdout + r.stderr).trim();
    onLog?.(`[container] security package check: ${out.split('\n').join('; ')}\n`);
    if (r.code !== 0) throw new ContainerError('security-verify-failed', `the security base did not prove its package versions: ${out.split('\n').pop() ?? `exit ${r.code}`}`, out.slice(0, 1200));
  } finally {
    try { dockerSync(['rm', '-f', name], 30_000); } catch { /* --rm already */ }
  }
}

/** FEAT-157 — the first image id each release tag was built as on this machine, and every rebuild since. */
function baseArtifactsFile(): string { return path.join(dataDir(), 'base-artifacts.json'); }
export function baseArtifacts(): Record<string, { firstId: string; firstAt: string; rebuilds: { id: string; at: string; over: string | null }[] }> {
  try { const j = JSON.parse(fs.readFileSync(baseArtifactsFile(), 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch { return {}; }
}
function recordBaseArtifact(image: string, id: string, over: string | null, onLog?: (s: string) => void): void {
  try {
    const all = baseArtifacts();
    const cur = all[image];
    const at = new Date().toISOString();
    if (!cur) all[image] = { firstId: id, firstAt: at, rebuilds: [] };
    else if (cur.firstId !== id) {
      cur.rebuilds.push({ id, at, over });
      onLog?.(`[container] ${image} was rebuilt from its release snapshot: same recipe, not the same bytes as first built on ${cur.firstAt.slice(0, 10)}\n`);
    }
    ensureDir(dataDir());
    const tmp = `${baseArtifactsFile()}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
    fs.renameSync(tmp, baseArtifactsFile());
  } catch { /* a record, never a reason to fail a build */ }
}

/* ------------------------------------------- FEAT-157: the CLI runtime layer */

/**
 * The host's CLI as a one-file layer on top of `parent`, built if missing.
 *
 * STRUCTURAL, NO BUILD STEP: `docker create` (never started) + `docker cp` of a
 * one-entry tar + `docker commit`. Nothing from the parent runs — no ONBUILD, no
 * RUN, no shell, no network — so a project image cannot act during it, and USER,
 * PATH, SHELL and ENV are the parent's by construction. The parent's layers are a
 * byte-identical prefix of the result.
 *
 * The bytes are the host SDK's own bundled binary, and their sha256 must equal the
 * boot-proven identity, so the container runs exactly the CLI the loaded SDK JS
 * speaks to. While the host runtime is skewed (updated on disk, restart pending)
 * no new layer is built. Validated by a real stream-json handshake before the
 * final tag exists.
 */
async function ensureRuntimeImage(parent: string, cli: HostCli, opts: { force?: boolean; onLog?: (s: string) => void; baseRefLabel?: string } = {}): Promise<string> {
  const parentId = imageIdOf(parent);
  if (!parentId) throw new ContainerError('image-missing', `cannot add the Claude CLI layer: ${parent} is not present`);
  const tag = runtimeTagFor(parentId, cli);
  const cur = imageOwnerOf(tag);
  if (cur && !opts.force) {
    // Usable only if it IS the layer this key names: the runtime marker, this exact CLI (sha256) and
    // this exact parent. Another instance's identical layer qualifies; anything else under the tag does not.
    const l = cur.id ? imageLabels(cur.id) : {};
    const matches = l[LABEL_RUNTIME] === '1' && l[LABEL_CLI_SHA] === cli.sha256 && l[LABEL_RUNTIME_PARENT] === parentId && l[LABEL_CLI_VERSION] === cli.version;
    if (matches) return tag;
    if (!mayActOn(cur.owner)) {
      throw new ContainerError('runtime-conflict', `${tag} exists but is not the Claude CLI layer it names (another instance's, or a tampered image); Orchard will not run it or replace it. Remove it by hand if nothing uses it.`);
    }
  }
  const inflight = imageBuilds.get(tag);
  if (inflight) return inflight;
  const p = (async () => {
    if (!testHostCli()) {
      const block = rtUpdate.hostSessionBlockReason();
      if (block) throw new ContainerError('runtime-unavailable', `cannot add the Claude CLI layer right now: ${block}`);
    }
    const nonce = crypto.randomBytes(6).toString('hex');
    const stageDir = path.join(dataDir(), 'runtime-stage', nonce);
    ensureDir(stageDir);
    const file = path.join(stageDir, 'claude');
    const staging = `${RUNTIME_REPO}:build-${ownerKey()}-${nonce}`;
    const name = `claude-station-rtbuild-${nonce}`;
    activeStaging.add(staging);
    let cid = '';
    try {
      const cp = spawnSync('cp', ['--reflink=auto', cli.path, file], { encoding: 'utf8', timeout: 5 * 60_000 });
      if (cp.status !== 0) throw new ContainerError('runtime-build-failed', `could not stage the host CLI (${cli.path})`, (cp.stderr ?? '').trim().slice(0, 300));
      const got = await sha256File(file);
      if (got !== cli.sha256) {
        throw new ContainerError('runtime-changed', `the host CLI on disk (${cli.path}) is not the one this Orchard proved at boot (sha256 ${got.slice(0, 12)} vs ${cli.sha256.slice(0, 12)}); restart Orchard to adopt it`);
      }
      opts.onLog?.(`[container] adding Claude CLI ${cli.version} as a layer on ${parent}\n`);
      const parentBase = imageLabels(parentId)[LABEL_BASE_REF] ?? '';
      // Created with NO --entrypoint and no command when the parent has one, so the committed
      // image keeps the parent's ENTRYPOINT/CMD exactly (`docker commit --change 'ENTRYPOINT []'`
      // cannot clear one — measured). A parent with neither gets a placeholder `true` command.
      const pc = dockerSync(['image', 'inspect', parentId, '--format', '{{json .Config.Entrypoint}}\t{{json .Config.Cmd}}'], 20_000);
      const [epJ = 'null', cmdJ = 'null'] = pc.stdout.trim().split('\t');
      let hasEntry = false;
      try { hasEntry = (JSON.parse(epJ) ?? []).length > 0 || (JSON.parse(cmdJ) ?? []).length > 0; } catch { hasEntry = false; }
      const c = dockerSync(['create', '--name', name, '--network', 'none',
        '--label', `${LABEL_RUNTIME}=1`, '--label', `${LABEL_CLI_VERSION}=${cli.version}`, '--label', `${LABEL_CLI_SHA}=${cli.sha256}`,
        '--label', `${LABEL_RUNTIME_PARENT}=${parentId}`, '--label', `${LABEL_BASE_REF}=${parentBase || opts.baseRefLabel || observedTagOf(parent, parentId)}`,
        '--label', `${LABEL_LEGACY_CLI}=`, '--label', 'claude-station.rtbuild=1', ...ownerLabelArgs(), parentId, ...(hasEntry ? [] : ['true'])], 60_000);
      if (c.code !== 0) throw new ContainerError('runtime-build-failed', `could not prepare the CLI layer on ${parent}`, (c.stderr || c.stdout).trim().slice(0, 600));
      cid = c.stdout.trim().split('\n').pop()!.trim();
      const put = await dockerCpFile(cid, CONTAINER_CLAUDE_BIN.replace(/^\//, ''), file, 0o755);
      if (put.code !== 0) throw new ContainerError('runtime-build-failed', `could not copy the CLI into the layer on ${parent}`, put.stderr.trim().slice(0, 600));
      // The build container's own role label must not reach the image (every container made from it would inherit it).
      const cm = dockerSync(['commit', '--change', 'LABEL claude-station.rtbuild=', ...(hasEntry ? [] : ['--change', 'CMD []']), cid, staging], 5 * 60_000);
      if (cm.code !== 0) throw new ContainerError('runtime-build-failed', `could not commit the CLI layer on ${parent}`, (cm.stderr || cm.stdout).trim().slice(0, 600));
      dockerSync(['rm', '-f', '-v', cid], 60_000);
      cid = '';
      const built = imageOwnerOf(staging);
      if (!built || built.owner !== 'own') throw new ContainerError('runtime-build-failed', `the CLI layer ${staging} is not present after commit`);
      await validateRuntimeImage(built.id, cli);
      const outcome = await withBaseTagLock(tag, built.id, () => {
        const now = imageOwnerOf(tag);
        if (now && now.id !== built.id && !opts.force) return now; // an identical layer won the race: use it
        if (now && now.id !== built.id && !mayActOn(now.owner)) return now;
        if (!now || now.id !== built.id) {
          const t = dockerSync(['tag', built.id, tag], 30_000);
          if (t.code !== 0) throw new ContainerError('runtime-build-failed', `could not tag the CLI layer as ${tag}`, (t.stderr || t.stdout).trim().slice(0, 600));
        }
        return null;
      });
      dockerSync(['image', 'rm', staging], 60_000);
      if (outcome) opts.onLog?.(`[container] ${tag} was made by another build meanwhile; using it\n`);
      opts.onLog?.(`[container] Claude CLI ${cli.version} layer ready: ${tag}\n`);
      pruneAfterRecreate = pruneAfterRecreate ?? tag;
      return tag;
    } catch (err) {
      try { dockerSync(['image', 'rm', staging], 60_000); } catch { /* */ }
      throw err;
    } finally {
      if (cid) { try { dockerSync(['rm', '-f', '-v', cid], 60_000); } catch { /* */ } }
      fs.rmSync(stageDir, { recursive: true, force: true });
      activeStaging.delete(staging);
    }
  })().finally(() => imageBuilds.delete(tag));
  imageBuilds.set(tag, p);
  return p;
}

/** A legacy parent's base tag, for the layer's base-ref label (so the observed base survives the layer). */
function observedTagOf(ref: string, id: string): string {
  const o = observedBaseOf(ref, id);
  if (o.kind === 'version') return `v${o.version}-${ugTag()}-${o.hash ?? ''}`;
  if (o.kind === 'legacy') return o.tag;
  if (o.kind === 'dev') return `dev-${ugTag()}-${o.hash}`;
  return '';
}

function sha256File(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('error', reject).on('data', (d) => h.update(d as Buffer)).on('end', () => resolve(h.digest('hex')));
  });
}

/** `docker cp -` of a ONE-entry tar (a regular file, root-owned, `mode`) to `rel` inside container `cid`. */
function dockerCpFile(cid: string, rel: string, file: string, mode: number): Promise<RunResult> {
  const size = fs.statSync(file).size;
  const h = Buffer.alloc(512);
  if (Buffer.byteLength(rel) > 99) throw new ContainerError('runtime-build-failed', `layer path too long: ${rel}`);
  h.write(rel, 0, 100, 'utf8');
  h.write(`${mode.toString(8).padStart(7, '0')}\0`, 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136);
  h.write('        ', 148);
  h.write('0', 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return new Promise((resolve) => {
    const child = dockerSpawn(['cp', '-', `${cid}:/`], { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcess & { stdin: Writable; stdout: Readable; stderr: Readable };
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + String(d)).slice(-4000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10 * 60_000);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout: '', stderr: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout: '', stderr }); });
    child.stdin.on('error', () => { /* reported via close */ });
    child.stdin.write(h);
    const rs = fs.createReadStream(file);
    rs.on('error', () => child.kill('SIGKILL'));
    rs.on('end', () => { child.stdin.end(Buffer.concat([Buffer.alloc((512 - (size % 512)) % 512), Buffer.alloc(1024)])); });
    rs.pipe(child.stdin, { end: false });
  });
}

/**
 * FEAT-157 finding 5 — a real stream-json session handshake in the new image,
 * offline, under the run-time lockdown: the first `system/init` frame must report
 * exactly the host's CLI version. `--version` alone is not accepted.
 */
export async function validateRuntimeImage(image: string, cli: { version: string }): Promise<void> {
  const name = `claude-station-smoke-${crypto.randomBytes(6).toString('hex')}`;
  const args = ['run', '--rm', '-i', '--name', name, '--network', 'none', '--memory', '1g', '--pids-limit', '256',
    '--security-opt', 'no-new-privileges:true', '--label', 'claude-station=1', '--label', 'claude-station.smoke=1', ...ownerLabelArgs(),
    ...lockdownCreateArgs().filter((x, i, a) => !(x === '--entrypoint' || a[i - 1] === '--entrypoint')),
    '--env', `HOME=${CONTAINER_HOME}`, '--entrypoint', CONTAINER_CLAUDE_BIN, image,
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
  const init = await new Promise<{ ok: boolean; version: string | null; out: string }>((resolve) => {
    const child = dockerSpawn(args, { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcess & { stdin: Writable; stdout: Readable; stderr: Readable };
    let out = '';
    let done = false;
    const finish = (v: { ok: boolean; version: string | null; out: string }) => { if (done) return; done = true; clearTimeout(timer); try { child.kill('SIGKILL'); } catch { /* */ } resolve(v); };
    const timer = setTimeout(() => finish({ ok: false, version: null, out: `${out}\n(timed out after 90s)` }), 90_000);
    child.stdout.on('data', (d) => {
      out += String(d);
      for (const line of out.split('\n')) {
        let j: { type?: string; subtype?: string; claude_code_version?: string } | null = null;
        try { j = JSON.parse(line); } catch { continue; }
        if (j?.type === 'system' && j.subtype === 'init') return finish({ ok: true, version: j.claude_code_version ?? null, out });
      }
      if (out.length > 1 << 20) finish({ ok: false, version: null, out: out.slice(0, 2000) });
    });
    child.stderr.on('data', (d) => { out += String(d); });
    child.on('error', (e) => finish({ ok: false, version: null, out: e.message }));
    child.on('close', () => finish({ ok: false, version: null, out }));
    child.stdin.on('error', () => { /* */ });
    child.stdin.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content: 'orchard runtime handshake' } })}\n`);
  });
  try { dockerSync(['rm', '-f', name], 30_000); } catch { /* --rm */ }
  if (!init.ok) {
    throw new ContainerError('runtime-rejected', 'the Claude CLI layer did not complete a stream-json handshake in the image (no system/init frame)', sanitiseBuildLog(init.out).slice(0, 800));
  }
  if (init.version !== cli.version) {
    throw new ContainerError('runtime-rejected', `the Claude CLI in the layer reports ${init.version ?? 'no version'} in its handshake, not the host's ${cli.version}`);
  }
}

/* ------------------------------------------ FEAT-155 r5: project Dockerfile */

/** How long a project image build may run before it is killed. */
const DF_BUILD_TIMEOUT_MS = 60 * 60_000;

/**
 * Build (if needed) the image a project's own Dockerfile describes, and return
 * the image the project should run on.
 *
 * KEEP-LAST-GOOD. A build failure, a refused Dockerfile or a candidate that
 * fails validation never throws on the launch path while a last good image
 * exists: it is recorded (UI + API show it, with the log), and the last good
 * image is returned, so the running container is left alone. A failed hash is
 * not rebuilt on every launch; a Dockerfile change or Rebuild tries again.
 * `force` (Rebuild) builds even when the image exists and THROWS on failure —
 * the caller has not touched the container yet, so it stays as it was.
 */
async function ensureDockerfileImage(project: Project, opts: { force?: boolean; onLog?: (s: string) => void; baseRef: string }): Promise<string> {
  const log = opts.onLog;
  // The base first (FEAT-157: the one this project is pinned to — the caller built it):
  // its id is part of the identity hash, and it is what a `FROM ${ORCHARD_BASE_IMAGE}`
  // Dockerfile builds on.
  if (!imageExists(opts.baseRef)) throw new ContainerError('base-missing', `the base ${opts.baseRef} this project builds on is not present`);
  const res = resolveProjectDockerfile(project);
  const rec = recordFor(project);
  const lastGood = isOwnProjectImage(project, rec.lastGoodImage) ? rec.lastGoodImage : null;
  const fallback = (why: string, detail: string): string => {
    if (!opts.force && lastGood) {
      log?.(`[container] ${why} — keeping the last good image ${lastGood}\n`);
      return lastGood;
    }
    throw new ContainerError('build-failed', why, detail);
  };
  if (!res.ok) {
    updateBuildRecord(project.id, { state: 'failed', hash: null, image: null, error: res.error ?? 'unusable Dockerfile', finishedAt: new Date().toISOString(), failedHash: null, log: '' });
    return fallback(`project Dockerfile not built: ${res.error}`, '');
  }
  const image = res.image!;
  if (!opts.force && rec.failedHash === res.hash) {
    return fallback(`${res.rel} (${res.hash}) failed earlier and has not changed since (${rec.error ?? 'build failed'}); press Rebuild to try again`, rec.error ?? '');
  }
  // Only an image THIS Orchard built for this project counts as built (ARCH-020).
  if (!opts.force && isOwnProjectImage(project, image)) return image;
  const inflight = imageBuilds.get(image);
  if (inflight) return inflight;
  const p = (async () => {
    try {
      await buildAndPromote(project, res, opts.baseRef, log);
      return image;
    } catch (err) {
      const e = err as ContainerError;
      updateBuildRecord(project.id, {
        state: 'failed', failedHash: res.hash!, finishedAt: new Date().toISOString(),
        error: `${e.message.split('\n')[0]}`,
      });
      return fallback(`the build of ${res.rel} failed: ${e.message.split('\n')[0]}`, e instanceof ContainerError ? e.detail : '');
    }
  })().finally(() => imageBuilds.delete(image));
  imageBuilds.set(image, p);
  return p;
}

/** An Orchard-owned, EMPTY docker client config dir for project builds (no registry credentials, no builder/context selection). */
function isolatedDockerConfigDir(): string {
  const d = path.join(dataDir(), 'docker-build-config');
  ensureDir(d);
  return d;
}

/**
 * The environment a project build's `docker` client runs with: nothing of the
 * server's own environment except what locates the binary and the daemon. In
 * particular DOCKER_CONFIG points at an empty Orchard-owned dir, so the user's
 * registry credentials (~/.docker/config.json) can never answer a pull for a
 * project Dockerfile, and no builder the user configured can receive the repo.
 * (ARCH-020: the only buildx builders registered in it are Orchard's own
 * per-project builders, see project-builder.ts.)
 */
function isolatedBuildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: isolatedDockerConfigDir(),
    DOCKER_CONFIG: isolatedDockerConfigDir(),
    DOCKER_BUILDKIT: '1',
    BUILDX_NO_DEFAULT_ATTESTATIONS: '1',
  };
  if (process.env.DOCKER_HOST) env.DOCKER_HOST = process.env.DOCKER_HOST;
  return env;
}

/** Run docker with `input` on stdin and a given env, streaming output. */
function dockerWithInput(args: string[], input: Buffer, env: NodeJS.ProcessEnv, timeoutMs: number, onChunk?: (s: string) => void): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = dockerSpawn(args, { stdio: ['pipe', 'pipe', 'pipe'], env }) as ChildProcess & { stdin: Writable; stdout: Readable; stderr: Readable };
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new ContainerError('docker-timeout', `docker ${args[0]} timed out after ${Math.round(timeoutMs / 1000)}s`, sanitiseBuildLog(stderr.slice(-2000))));
    }, timeoutMs);
    child.stdout.on('data', (d) => { const t = String(d); stdout = (stdout + t).slice(-BUILD_OUTPUT_KEEP); onChunk?.(t); });
    child.stderr.on('data', (d) => { const t = String(d); stderr = (stderr + t).slice(-BUILD_OUTPUT_KEEP); onChunk?.(t); });
    child.stdin.on('error', () => { /* docker exited before reading stdin; the exit code says why */ });
    child.on('error', (err) => {
      clearTimeout(timer);
      const e = err as NodeJS.ErrnoException;
      reject(e.code === 'ENOENT'
        ? new ContainerError('docker-missing', `\`${dockerBin()}\` is not on PATH — Docker is required for isolation "container".`)
        : new ContainerError('docker-failed', `docker ${args[0]} failed: ${err.message}`));
    });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
    child.stdin.end(input);
  });
}
const BUILD_OUTPUT_KEEP = 64 * 1024;

/**
 * build (on this project's OWN builder) → check → import → validate → promote.
 * Only a candidate that passes validation is tagged `df-<hash>`, so that tag
 * existing MEANS "built and validated". Serialised per project (build, delete
 * and reset share the lock) and bounded server-wide (MAX_CONCURRENT_BUILDS).
 */
async function buildAndPromote(project: Project, res: DockerfileResolution, baseRef: string, log?: (s: string) => void): Promise<void> {
  const repoKey = repoKeyOf(project);
  if (!repoKey) throw new ContainerError('build-failed', 'the project directory cannot be resolved');
  return withProjectLock(project.id, () => withBuildSlot(() => buildAndPromoteLocked(project, res, repoKey, baseRef, log)));
}

async function buildAndPromoteLocked(project: Project, res: DockerfileResolution, repoKey: string, baseRef: string, log?: (s: string) => void): Promise<void> {
  const repo = projectImageRepo(project.id);
  const cand = `${repo}:cand-${res.hash}-${crypto.randomBytes(4).toString('hex')}`;
  const final = `${repo}:df-${res.hash}`;
  const { uid, gid } = hostUidGid();
  const repoReal = fs.realpathSync(project.hostPath);
  const generation = recordFor(project).generation;
  const stillOurs = () => recordFor(project).generation === generation && repoKeyOf(project) === repoKey;
  updateBuildRecord(project.id, {
    state: 'building', hash: res.hash!, image: final, startedAt: new Date().toISOString(), finishedAt: null, error: null,
    log: `$ docker buildx build on this project's own builder -f ${res.rel} (context: the project repo) -> ${final}\n`,
  });
  log?.(`[container] building this project's image from ${res.rel} (${res.hash}) — full log: container build log in project settings\n`);
  const env = isolatedBuildEnv();
  const note = (l: string) => { appendBuildLog(project.id, l); log?.(l); };
  // A project id re-created on ANOTHER repo never inherits the old builder's cache.
  try {
    const gone = removeProjectBuilders(project.id, env, { keepRepo: repoKey });
    if (gone.length) note(`[container] removed the builder of this project id's previous repo (${gone.join(', ')})\n`);
  } catch { /* the builder name differs per repo anyway; this is disk hygiene */ }
  // Pre-ARCH-020 leftover: the per-project cache-scope contexts are obsolete.
  fs.rmSync(path.join(dataDir(), 'build-scope-ctx'), { recursive: true, force: true });
  const staging = newStagingDir();
  let builder: string | null = null;
  let iid = '';
  try {
    diskPreflight(staging);
    const shared = await baseOciLayout(baseRef, log);
    // ARCH-020: each build gets its OWN copy of the base layout (a reflink on
    // btrfs/xfs, so ~free), removed with the staging dir. The buildx client
    // serves a named OCI context as a writable content store, so a shared
    // layout would be one object every project's build session could touch.
    const oci = { dir: path.join(staging, 'base'), digest: shared.digest };
    const cp = spawnSync('cp', ['-a', '--reflink=auto', shared.dir, oci.dir], { encoding: 'utf8', timeout: 15 * 60_000 });
    if (cp.status !== 0) throw new ContainerError('base-export-failed', 'could not stage Orchard\'s base image for this build', (cp.stderr ?? '').trim().slice(0, 300));
    builder = await ensureBuilder(project.id, repoKey, env, note);
    const out = path.join(staging, 'out');
    const args = [
      'buildx', 'build', '--builder', builder, '-f', '-', '--progress=plain',
      /*
       * THE BUILD CANNOT READ ANOTHER PROJECT OR THE HOST (ARCH-020). It runs on
       * this project's own rootless BuildKit: no host image store (a local-only
       * image cannot be resolved at all), no other project's cache. Its client
       * inputs are the repo, the Dockerfile on stdin and Orchard's base as an
       * OCI layout; no --ssh, --secret or --allow is ever passed.
       */
      ...BUILD_RULES.flatMap((r) => r.args ?? []),
      '--build-context', `${BASE_CONTEXT_NAME}=oci-layout://${oci.dir}@${oci.digest}`,
      '--build-arg', `ORCHARD_BASE_IMAGE=${BASE_CONTEXT_NAME}`,
      '--build-arg', `HOST_UID=${uid}`,
      '--build-arg', `HOST_GID=${gid}`,
      // CLI labels override any LABEL the Dockerfile sets (verified), so these
      // cannot be spoofed by the file they describe.
      '--label', `${LABEL_DF_PROJECT}=${project.id}`,
      '--label', `${LABEL_DF_HASH}=${res.hash}`,
      '--label', `${LABEL_DF_REPO}=${repoKey}`,
      // Which Orchard data dir built it: project delete removes only its own.
      '--label', `${LABEL_DF_DATA}=${dataKey()}`,
      // FEAT-157: which base this image was built on (the observed artifact), and the CLI the base
      // carries (a legacy base's baked one, or none) — set here so the Dockerfile cannot claim either.
      '--label', `${LABEL_BASE_REF}=${imageLabels(baseRef)[LABEL_BASE_REF] || baseRef.slice(baseRef.lastIndexOf(':') + 1)}`,
      '--label', `${LABEL_LEGACY_CLI}=${imageLabels(baseRef)[LABEL_LEGACY_CLI] ?? ''}`,
      // …and a Dockerfile can never pass itself off as Orchard's CLI layer (which would skip the layer).
      '--label', `${LABEL_RUNTIME}=`, '--label', `${LABEL_CLI_VERSION}=`, '--label', `${LABEL_CLI_SHA}=`, '--label', `${LABEL_RUNTIME_PARENT}=`,
      // The builder names nothing on the host: it exports a layout that Orchard
      // checks and imports under a name Orchard chooses (importCheckedLayout).
      '--output', `type=oci,dest=${out},tar=false`,
      repoReal,
    ];
    let r: RunResult;
    try {
      r = await dockerWithInput(args, res.bytes!, env, DF_BUILD_TIMEOUT_MS, (chunk) => {
        appendBuildLog(project.id, chunk);
        // The launch status line gets the step headers only; the whole log is in the record.
        for (const line of chunk.split('\n')) if (/^#\d+ \[/.test(line)) log?.(`[build] ${sanitiseBuildLog(line).slice(0, 200)}\n`);
      });
    } finally {
      updateBuildRecord(project.id, {}); // persist the log so far
    }
    if (r.code !== 0) {
      const tail = sanitiseBuildLog((r.stderr || r.stdout).trim()).slice(-3000);
      // One short, readable reason for the status line; the whole log is in the record.
      const exit = /did not complete successfully: exit code: (\d+)/.exec(tail);
      const step = [...tail.matchAll(/^#\d+ \[[^\]]*\] (.+)$/gm)].pop()?.[1] ?? '';
      const last = tail.split('\n').reverse().find((l) => /^ERROR|error:/i.test(l.trim())) ?? tail.split('\n').pop() ?? '';
      const why = exit
        ? `a build step exited with code ${exit[1]}${step ? ` (${step.length > 80 ? `${step.slice(0, 77)}…` : step})` : ''}`
        : last.replace(/^ERROR:\s*(failed to build:\s*)?/i, '').slice(0, 200);
      throw new ContainerError('build-failed', `docker build failed for ${res.rel}${why ? `: ${why}` : ''} — see the build log`, tail);
    }
    const layout = await checkOciLayout(out);
    if (!stillOurs()) throw new ContainerError('build-failed', 'the project changed while it was building (deleted, or re-pointed at another repo); this build was discarded');
    iid = await importCheckedLayout(out, layout, cand, 30 * 60_000);
  } catch (err) {
    untag(cand);
    if (err instanceof BuilderError) {
      appendBuildLog(project.id, `\n[orchard] ${err.message}${err.detail ? `\n${sanitiseBuildLog(err.detail)}` : ''}\n`);
      throw new ContainerError('build-failed', err.message, err.detail);
    }
    throw err;
  } finally {
    if (builder) stopBuilder(builder);
    releaseStagingDir(staging);
  }
  try {
    validateCandidate(project, iid);
  } catch (err) {
    untag(cand);
    appendBuildLog(project.id, `\n[orchard] candidate image REJECTED: ${(err as Error).message}\n`);
    throw err;
  }
  if (!stillOurs()) {
    untag(cand);
    throw new ContainerError('build-failed', 'the project changed while it was building (deleted, or re-pointed at another repo); this build was discarded');
  }
  const t = dockerSync(['tag', iid, final], 30_000);
  untag(cand);
  if (t.code !== 0) throw new ContainerError('build-failed', `could not tag the validated image as ${final}`, t.stderr.trim().slice(0, 400));
  appendBuildLog(project.id, `\n[orchard] validated and tagged ${final}\n`);
  updateBuildRecord(project.id, { state: 'succeeded', failedHash: null, error: null, finishedAt: new Date().toISOString() });
  log?.(`[container] built ${final}\n`);
}

/**
 * ARCH-020 — everything a project's Dockerfile builds leave behind: its
 * builder(s) (container, state volume, buildx registration), its df-/cand-
 * images and its build record. Called when the project is deleted; waits for a
 * running build of that project to finish first (same lock).
 */
export async function removeProjectBuildState(project: Project): Promise<{ removed: string[] }> {
  return withProjectLock(project.id, async () => {
    const removed = removeProjectBuilders(project.id, isolatedBuildEnv());
    // Only images THIS data dir built for this project id: another Orchard
    // (a scratch server, or the live one) may use the same id on this host.
    try {
      const listed = dockerSync(['images', '--filter', `label=${LABEL_DF_PROJECT}=${project.id}`, '--filter', `label=${LABEL_DF_DATA}=${dataKey()}`,
        '--format', '{{.Repository}}:{{.Tag}}'], 20_000);
      const repo = projectImageRepo(project.id);
      for (const ref of listed.stdout.split('\n').map((x) => x.trim()).filter((x) => x.startsWith(`${repo}:`))) {
        const tag = ref.slice(repo.length + 1);
        if ((DF_TAG_RE.test(tag) || CAND_TAG_RE.test(tag)) && dockerSync(['image', 'rm', ref], 60_000).code === 0) removed.push(ref);
      }
    } catch { /* images in use stay */ }
    forgetBuildRecord(project.id);
    return { removed };
  });
}

/** Builders of this data dir whose project is gone from the registry (the orphan sweep). */
export function findOrphanProjectBuilders(known: Set<string>): { name: string; projectId: string }[] {
  return findOrphanBuilders(known);
}

/**
 * FEAT-157 — THE Dockerfile-build rule table. The build argv spreads each rule's
 * `args` (so a rule with args is enforced by being passed), and the per-project
 * agent's container guide is generated from every rule's `guide` line: a rule
 * added here reaches the build and the guide with no second edit. Rules with no
 * `args` state a structural fact of how `buildAndPromoteLocked` builds.
 */
export interface BuildRule { args?: string[]; guide: string }
export const BUILD_RULES: BuildRule[] = [
  { guide: 'Start with `ARG ORCHARD_BASE_IMAGE` and `FROM ${ORCHARD_BASE_IMAGE}`: that is this project\'s pinned Orchard base release, handed to the build directly (not pulled). Multi-stage builds may name other stages.' },
  { args: ['--pull'], guide: 'Any other `FROM` image is pulled fresh from its registry: there is no host image store to build from.' },
  { guide: 'The build runs on this project\'s own rootless BuildKit, with the repo as its context: it cannot read another project, the host, or their build caches.' },
  { guide: 'No `--ssh`, `--secret` or `--allow` entitlements are passed: `RUN --mount=type=ssh|secret` gets nothing, and a step that needs an entitlement (`--network=host`, `--security=insecure`) is not granted one.' },
];

/** The build-context name Orchard's base is passed in as (`FROM ${ORCHARD_BASE_IMAGE}` resolves to it). */
const BASE_CONTEXT_NAME = 'orchard-base';

/**
 * Orchard's base image exported as an OCI layout under the data dir, once per
 * base image id (a few seconds; the layout of a superseded base is removed).
 * This is what a project build gets as its base, so the build never needs the
 * daemon's local image store.
 */
async function baseOciLayout(baseTag: string, log?: (s: string) => void): Promise<{ dir: string; digest: string }> {
  const id = imageIdOf(baseTag);
  if (!id) throw new ContainerError('base-missing', `Orchard's base image ${baseTag} is not present`);
  const root = path.join(dataDir(), 'base-oci');
  const dir = path.join(root, id.replace(/^sha256:/, '').slice(0, 24));
  const indexFile = path.join(dir, 'index.json');
  if (!fs.existsSync(indexFile)) {
    log?.(`[container] exporting Orchard's base image ${baseTag} for project builds (once per base)\n`);
    ensureDir(root);
    const tmp = `${dir}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    ensureDir(tmp);
    const r = await new Promise<{ code: number; err: string }>((resolve) => {
      // ARCH-022: docker save streamed into tar directly (no `sh -c` wrapper; docker-exec.ts is the only docker spawner).
      const save = dockerSpawn(['image', 'save', baseTag], { stdio: ['ignore', 'pipe', 'pipe'] }) as ChildProcess & { stdout: Readable; stderr: Readable };
      const tar = spawn('tar', ['-x', '-C', tmp], { stdio: ['pipe', 'ignore', 'pipe'] });
      let err = '';
      let pending = 2;
      let saveCode = -1;
      let tarCode = -1;
      save.stderr.on('data', (d) => { err = (err + String(d)).slice(-2000); });
      tar.stderr!.on('data', (d) => { err = (err + String(d)).slice(-2000); });
      save.stdout.pipe(tar.stdin!);
      tar.stdin!.on('error', () => { /* tar exited early; its code says why */ });
      const timer = setTimeout(() => { save.kill('SIGKILL'); tar.kill('SIGKILL'); }, 10 * 60_000);
      const done = () => { if (--pending === 0) { clearTimeout(timer); resolve({ code: saveCode !== 0 ? saveCode : tarCode, err }); } };
      let saveDone = false;
      let tarDone = false;
      const endSave = (code: number) => { if (saveDone) return; saveDone = true; saveCode = code; if (code !== 0) tar.stdin!.destroy(); done(); };
      const endTar = (code: number) => { if (tarDone) return; tarDone = true; tarCode = code; done(); };
      save.on('close', (code) => endSave(code ?? -1));
      tar.on('close', (code) => endTar(code ?? -1));
      save.on('error', (e) => { err = e.message; endSave(-1); });
      tar.on('error', (e) => { err = e.message; endTar(-1); });
    });
    if (r.code !== 0 || !fs.existsSync(path.join(tmp, 'index.json'))) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw new ContainerError('base-export-failed', `could not export ${baseTag} for the project build`, r.err.trim().slice(0, 600));
    }
    // Published atomically (rename), keyed by the base IMAGE ID (finding 11): several pinned
    // versions keep their own exports side by side; one is removed only with its base image
    // (`pruneBaseLayouts`), never because another project built on a different base.
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
  }
  const idx = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as { manifests?: { digest?: string }[] };
  const digest = idx.manifests?.[0]?.digest ?? '';
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new ContainerError('base-export-failed', `the exported base layout at ${dir} has no usable index`);
  return { dir, digest };
}

/** FEAT-157 — remove base OCI exports whose base image no longer exists (never one a build is using: exports are copied per build). */
function pruneBaseLayouts(): void {
  const root = path.join(dataDir(), 'base-oci');
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(root); } catch { return; }
  let ids: Set<string>;
  try {
    const r = dockerSync(['images', '--no-trunc', '--format', '{{.ID}}'], 20_000);
    if (r.code !== 0) return;
    ids = new Set(r.stdout.split('\n').map((x) => x.trim().replace(/^sha256:/, '').slice(0, 24)).filter(Boolean));
  } catch { return; }
  for (const d of dirs) {
    if (d.includes('.tmp-')) continue;
    if (/^[0-9a-f]{24}$/.test(d) && !ids.has(d)) fs.rmSync(path.join(root, d), { recursive: true, force: true });
  }
}

function untag(ref: string): void {
  try { dockerSync(['image', 'rm', ref], 30_000); } catch { /* best effort */ }
}

/**
 * Env keys an IMAGE may not bake in: the ones Orchard refuses in
 * `container.env` because they move the session's config/history, re-route its
 * auth, or spoof an Orchard marker. PATH and HOME are exempt — an image sets its
 * own PATH legitimately, and Orchard passes HOME on every session exec.
 */
function reservedImageEnvKeys(env: string[]): string[] {
  return env.map((kv) => kv.split('=')[0] ?? '').filter((k) => k && !IMAGE_ENV_ALLOWED.includes(k) && reservedContainerEnvReason(k));
}

/** Reserved keys an IMAGE may still set with ENV (its own PATH; HOME is re-passed on every exec). Read by the guide too. */
export const IMAGE_ENV_ALLOWED: readonly string[] = ['PATH', 'HOME'];

/**
 * FEAT-155 round 8 — THE reserved-ENV policy for every image a project runs on
 * (ARCH-010: one definition). Pure over an image's `Config.Env`; null = allowed.
 * Called by build-time promotion (`validateCandidate`) and by `ensureImage`,
 * which every container create and Rebuild goes through, whatever the image's
 * source (project Dockerfile, prebuilt `container.image`, Orchard's own).
 */
export function reservedImageEnvProblem(env: string[]): string | null {
  const bad = reservedImageEnvKeys(env);
  if (!bad.length) return null;
  // Short on purpose: it is shown in the drawer and in a failed session's
  // error. The per-key reasons are `reservedContainerEnvReason`'s.
  return `the image sets environment variable(s) Orchard reserves: ${bad.join(', ')}. Baked into the image they would reach every session, moving the CLI's config/history or re-routing its account. Remove those ENV lines from the image`;
}

/** The reserved-ENV problem of an image by reference, read from `docker image inspect`. null = allowed, or not inspectable (absence is `ensureImage`'s error). */
export function imageEnvProblem(image: string): string | null {
  const r = dockerSync(['image', 'inspect', image, '--format', '{{json .Config.Env}}'], 20_000);
  if (r.code !== 0) return null;
  let env: unknown;
  try { env = JSON.parse(r.stdout); } catch { return 'the image config could not be read (unparseable Env)'; }
  return reservedImageEnvProblem(Array.isArray(env) ? env.filter((x): x is string => typeof x === 'string') : []);
}

/** Refuse (throw) before any container is touched when the image breaks the reserved-ENV policy. */
function assertImageEnvAllowed(project: Project, image: string): void {
  const problem = imageEnvProblem(image);
  if (problem) {
    throw new ContainerError('image-rejected',
      `refusing to run ${containerName(project.id)} on ${image}: ${problem}. The existing container (if any) was left untouched.`);
  }
}

/**
 * Validate a freshly built candidate before it may be promoted. Everything is
 * read HOST-SIDE (image config via inspect; the process identity from the
 * host's /proc) except one exec of the CLI's `--version`, whose only output
 * that matters is its exit status. The smoke container runs under the same
 * lockdown as the real one plus `--network none` and small limits.
 */
function validateCandidate(project: Project, iid: string): void {
  const ins = dockerSync(['image', 'inspect', iid, '--format', '{{json .Config}}'], 20_000);
  if (ins.code !== 0) throw new ContainerError('build-rejected', 'cannot inspect the built image', ins.stderr.trim().slice(0, 300));
  const cfg = JSON.parse(ins.stdout) as { Env?: string[]; Labels?: Record<string, string> };
  if ((cfg.Labels ?? {})[LABEL_DF_PROJECT] !== project.id || (cfg.Labels ?? {})[LABEL_DF_REPO] !== repoKeyOf(project)) throw new ContainerError('build-rejected', 'the built image does not carry this project\'s labels');
  const envProblem = reservedImageEnvProblem(cfg.Env ?? []);
  if (envProblem) throw new ContainerError('build-rejected', envProblem);
  const { uid, gid } = hostUidGid();
  const name = `claude-station-smoke-${crypto.randomBytes(6).toString('hex')}`;
  let cid = ''; // FEAT-158 round 8: act on the container this call made (by id), never on whatever holds the name
  try {
    const run = dockerSync([
      'run', '-d', '--name', name, '--init', '--network', 'none', '--memory', '1g', '--pids-limit', '256',
      '--security-opt', 'no-new-privileges:true', '--label', 'claude-station=1', '--label', 'claude-station.smoke=1',
      ...ownerLabelArgs(), ...lockdownCreateArgs(), iid, '120',
    ], 60_000);
    if (run.code !== 0) throw new ContainerError('build-rejected', 'the image will not start under Orchard\'s run-time settings', run.stderr.trim().slice(0, 600));
    cid = run.stdout.trim();
    const pidR = dockerSync(['inspect', cid, '--format', '{{.State.Pid}} {{.State.Running}}'], 10_000);
    const [pidS = '0', running = 'false'] = pidR.stdout.trim().split(' ');
    if (running !== 'true') throw new ContainerError('build-rejected', 'the image exits immediately under Orchard\'s run-time settings (is `sleep` on its PATH?)');
    // The identity the container's processes actually got, from the host's /proc.
    let st = '';
    try { st = fs.readFileSync(`/proc/${Number(pidS)}/status`, 'utf8'); } catch { /* checked below */ }
    const field = (k: string) => (new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(st)?.[1] ?? '').trim().split(/\s+/).filter(Boolean);
    const uids = field('Uid');
    const gids = field('Gid');
    const groups = field('Groups');
    if (!uids.length || uids.some((u) => u !== String(uid)) || gids.some((g) => g !== String(gid)) || groups.some((g) => g !== String(gid))) {
      throw new ContainerError('build-rejected', `the image's processes did not run as exactly ${uid}:${gid} (Uid ${uids.join(' ')}; Gid ${gids.join(' ')}; Groups ${groups.join(' ') || '-'})`);
    }
    // FEAT-157: a v1+ base carries no CLI — Orchard adds the host's as a layer on top and
    // proves it with a handshake. Only an image built on a LEGACY base (which baked one, and
    // which the image may still be relying on) is asked to run it here, as before.
    if ((cfg.Labels ?? {})[LABEL_LEGACY_CLI]) {
      const ver = dockerSync(['exec', cid, CONTAINER_CLAUDE_BIN, '--version'], 60_000);
      if (ver.code !== 0) {
        throw new ContainerError('build-rejected',
          `the Claude CLI does not run in the image (${CONTAINER_CLAUDE_BIN} --version exited ${ver.code}). Build FROM \${ORCHARD_BASE_IMAGE} (declare "ARG ORCHARD_BASE_IMAGE" before FROM) so the base's CLI is included.`,
          sanitiseBuildLog((ver.stderr || ver.stdout).trim()).slice(0, 400));
      }
    }
  } finally {
    if (cid) { try { dockerSync(['rm', '-f', '-v', cid], 30_000); } catch { /* */ } }
  }
}

/**
 * Reclaim this project's superseded Dockerfile images. Same guards as
 * `pruneSupersededImages`: only this project's repository and our own tag
 * shapes, never --force (docker refuses while any container uses one), never the
 * one to keep. Also clears dangling layers labelled for this project.
 */
function pruneProjectImages(project: Project, keep: string): string[] {
  const repo = projectImageRepo(project.id);
  const removed: string[] = [];
  let listed: RunResult;
  // Only images THIS data dir built (another Orchard may use the same project id on this daemon).
  try { listed = dockerSync(['images', repo, '--filter', `label=${LABEL_DF_DATA}=${dataKey()}`, '--format', '{{.Repository}}:{{.Tag}}'], 20_000); } catch { return removed; }
  if (listed.code !== 0) return removed;
  for (const ref of listed.stdout.split('\n').map((x) => x.trim()).filter(Boolean)) {
    const i = ref.lastIndexOf(':');
    const tag = ref.slice(i + 1);
    if (ref.slice(0, i) !== repo || ref === keep || !(DF_TAG_RE.test(tag) || CAND_TAG_RE.test(tag))) continue;
    try { if (dockerSync(['image', 'rm', ref], 60_000).code === 0) removed.push(ref); } catch { /* */ }
  }
  try { dockerSync(['image', 'prune', '-f', '--filter', `label=${LABEL_DF_PROJECT}=${project.id}`, '--filter', `label=${LABEL_DF_DATA}=${dataKey()}`], 120_000); } catch { /* */ }
  return removed;
}

/** `df-<hash>` → hash, for a project image ref; null otherwise. */
function dfHashOf(ref: string): string | null {
  const m = /:df-([0-9a-f]{12})$/.exec(ref);
  return m ? m[1]! : null;
}

/* --------------------------------------------------------------- container */

/**
 * ARCH-022 — every lifecycle entry point is an OPERATION in the project's FIFO slot (`lifecycle.ts`).
 * Operations never join one another (a Rebuild never rides a launch's ensure, BUG-222) and never nest.
 * Whether a session is live is the lease set the authority holds — declared at admission, never
 * sampled from the session map — and it can only shrink while an operation holds the slot.
 */
export interface EnsureOptions {
  onLog?: (s: string) => void;
  /** Recreate even without drift (Rebuild). */
  forceRecreate?: boolean;
}

/** What a lifecycle request carries in. */
export interface OpRequest {
  onLog?: (s: string) => void;
  /**
   * Re-read the project under the slot (routes pass the registry read). A project deleted, or deleted
   * and re-created under the same id, before the operation ran fails `project-gone` and changes nothing.
   */
  current?: () => Project | null | undefined;
  /**
   * `?force=1`: the lease ids live at REQUEST time, whose sessions the caller has closed. The operation
   * reaps and waits for exactly those; a session admitted later is still protected.
   */
  forceOver?: string[];
}

function asContainerError(e: unknown): unknown {
  if (e instanceof lifecycle.LifecycleError) return new ContainerError(e.code, e.message.split('\n')[0]!, e.detail);
  return e;
}

function generationOf(p: Project): string | null {
  return (p as { createdAt?: string }).createdAt ?? null;
}

function inOp<T>(project: Project, kind: lifecycle.OpKind, req: OpRequest, fn: (op: lifecycle.Op, p: Project) => Promise<T>): Promise<T> {
  return lifecycle.runOp(project.id, kind, async (op) => {
    const p = req.current ? req.current() : project;
    if (!p) throw new ContainerError('project-gone', `project ${project.id} was deleted before this ${kind} ran; nothing was done`);
    return fn(op, p);
  }, req.current ? { current: req.current as () => { createdAt?: string } | null | undefined, expectGeneration: generationOf(project) } : {})
    .catch((e) => { throw asContainerError(e); });
}

/** Leases still holding the project: forced ones are reaped and waited for; anything else refuses. */
async function clearForDestroy(op: lifecycle.Op, req: OpRequest, what: string): Promise<void> {
  if (req.forceOver) {
    const ok = await lifecycle.forceDrain(op, req.forceOver);
    if (!ok) throw new ContainerError('live-sessions', `refusing to ${what} ${containerName(op.projectId)}: the forced sessions' processes are still running after the reap deadline; nothing was destroyed`);
  }
  const ls = lifecycle.leasesOf(op.projectId);
  if (ls.length) {
    throw new ContainerError('live-sessions',
      `refusing to ${what} ${containerName(op.projectId)}: ${ls.length} session(s) hold it (${ls.map((l) => `${l.id}:${l.state}`).join(', ')}); ` +
      'this would destroy the work running in it. Close them first, or retry with ?force=1.');
  }
}

/** Ensure inside an operation; the base prune is scheduled after it unless the swap was deferred. */
async function ensureInOp(op: lifecycle.Op, project: Project, opts: EnsureOptions): Promise<ContainerStatus> {
  const deferred = { swap: false };
  try {
    return await doEnsure(op, project, opts, deferred);
  } finally {
    building.delete(project.id);
    invalidate(project.id);
    // The container is settled now, so an image a build here superseded is free to reclaim — unless this
    // ensure DEFERRED the swap (BUG-214): the old image is still in use, and the prune stays armed.
    if (!deferred.swap) lifecycle.scheduleImagesOp(() => flushPrune(opts.onLog));
  }
}

/** A manual Start (the container route): ensure it, and rejoin the service network. */
export function ensureContainer(project: Project, opts: EnsureOptions & OpRequest = {}): Promise<ContainerStatus> {
  return inOp(project, 'start', opts, async (op, p) => {
    const st = await ensureInOp(op, p, { onLog: opts.onLog, forceRecreate: opts.forceRecreate });
    // FEAT-112 defect 4: a recreate drops the container off the service network; rejoin (no-op without one).
    try { connectSessionToServices(p.id, opts.onLog); } catch (err) { (st as { serviceRejoin?: string }).serviceRejoin = (err as Error).message; }
    return st;
  });
}

/**
 * ADMISSION — the only way a session gets a container. Services, the container and the network join
 * happen in the project's slot, and the LEASE for `execTag` is granted before the slot is released,
 * so no other operation can run between "the container is ready" and "a session holds it".
 */
export function admitContainer(project: Project, execTag: string, req: OpRequest = {}): Promise<ContainerStatus> {
  return inOp(project, 'admit', req, async (op, p) => {
    if (p.isolation !== 'container') throw new ContainerError('not-container', `project ${p.id} has isolation "${p.isolation}", not "container"`);
    await ensureServices(p, req.onLog);
    const st = await ensureInOp(op, p, { onLog: req.onLog });
    if (st.state !== 'running') throw new ContainerError('not-running', `container ${st.containerName} is "${st.state}" — refusing to start a session on the host instead`);
    connectSessionToServices(p.id, req.onLog);
    lifecycle.grantLease(op, execTag);
    return st;
  });
}

async function doEnsure(op: lifecycle.Op, project: Project, opts: EnsureOptions, deferred: { swap: boolean }): Promise<ContainerStatus> {
  if (project.isolation !== 'container') {
    throw new ContainerError('not-container', `project ${project.id} has isolation "${project.isolation}", not "container"`);
  }
  const avail = dockerAvailable();
  if (!avail.ok) throw new ContainerError('docker-unavailable', avail.message);
  /*
   * ARCH-022 (d-ii): WHOSE container this is is the operation's first question — before anything is decided or
   * written — and a refused operation writes no state. The FEAT-157 migration of a project the one-time pass has not
   * reached yet is PLANNED here (what it runs; never a newer base) and used in memory; it is committed to the registry
   * only when this operation completes.
   */
  {
    const nm = containerName(project.id);
    refuseForeign(nm, inspect(nm));
    for (const alt of [nextName(nm), `${nm}-next`]) { const nx = inspect(alt); if (nx && nx.project === project.id) refuseForeign(alt, nx); }
  }
  const mig = planBaseMigration(project);
  if (mig) project = { ...project, settings: { ...project.settings, container: { ...containerSettingsOf(project), base: mig.pin } } };
  resolvedPinImage.delete(project.id);
  let st: ContainerStatus;
  try { st = await doEnsureAdmitted(op, project, opts, deferred); } catch (e) { resolvedPinImage.delete(project.id); throw e; }
  mig?.commit();
  recordPinImage(project.id);
  return st;
}

async function doEnsureAdmitted(op: lifecycle.Op, project: Project, opts: EnsureOptions, deferred: { swap: boolean }): Promise<ContainerStatus> {

  if (!fs.existsSync(project.hostPath) || !fs.statSync(project.hostPath).isDirectory()) {
    throw new ContainerError('hostpath-missing', `project directory does not exist: ${project.hostPath}`);
  }
  /*
   * FEAT-145 — this resolves the project's EFFECTIVE account and throws
   * `account-unavailable` (never falls back to ~/.claude) when a named account
   * is missing / not logged in / has no credential. For a NAMED account
   * `resolveLaunchAccountDir` has already proven the credential file exists, so
   * the check below is the default account's own guard — kept exactly as it was.
   */
  const cred = credentialsFile(project);
  if (!fs.existsSync(cred)) {
    // Without this the container reaches the API and gets
    // "Not logged in · Please run /login" — a confusing failure two layers down.
    throw new ContainerError(
      'credentials-missing',
      `${cred} not found. Claude Station mounts this file into the container; without it the CLI inside has no auth. Run \`claude\` on the host and log in first.`,
    );
  }
  /*
   * Shape and security errors still refuse the ensure. An absent host path does
   * not (see `desiredBinds`) — it is skipped and said out loud, so the user
   * learns the mount is not there from the session that is starting rather than
   * from work done against a directory that was quietly missing.
   */
  const mountErrs = validateMounts(project.settings.mounts ?? [], { requireHostPath: false });
  if (mountErrs.length) throw new ContainerError('bad-mounts', 'project mounts are invalid', mountErrs.join('\n'));
  const rootWs = containerSettingsOf(project).workspaceRoot === true;
  for (const m of project.settings.mounts ?? []) {
    const hp = path.resolve(expandHome(m.hostPath));
    /*
     * FEAT-155 — with workspaceRoot on, the REPO is `/workspace`, so a user
     * mount under `/workspace/x` nests inside it: docker shadows the repo's own
     * `x/`, or creates an empty root-owned `x/` in the repo on the host if it has
     * none. That can be exactly what the user wants (a data dir kept outside the
     * repo), so it is said out loud, not refused.
     */
    const cpN = path.posix.normalize(m.containerPath).replace(/\/+$/, '');
    if (rootWs && cpN.startsWith(`${CONTAINER_WORKSPACE}/`) && fs.existsSync(hp)) {
      const rel = cpN.slice(CONTAINER_WORKSPACE.length + 1);
      const inRepo = path.join(project.hostPath, rel);
      // A directory over a repo FILE (or a file over a repo dir) cannot be
      // mounted; say which mount and why instead of docker's runc error.
      try {
        const there = fs.lstatSync(inRepo);
        if (!there.isSymbolicLink() && there.isDirectory() !== fs.statSync(hp).isDirectory()) {
          throw new ContainerError('bad-mounts', 'project mounts are invalid',
            `mount ${hp} -> ${m.containerPath}: with workspaceRoot the repo is ${CONTAINER_WORKSPACE}, and the repo already has a ${there.isDirectory() ? 'directory' : 'file'} at ${rel} — a ${there.isDirectory() ? 'file' : 'directory'} cannot be mounted over it. Pick another containerPath.`);
        }
      } catch (e) { if (e instanceof ContainerError) throw e; }
      // Docker would create a missing mountpoint ROOT-owned inside the user's
      // repo; pre-create it as the host user instead (same reason the history
      // dir is pre-created below), and say so.
      let made = false;
      // Never through a symlink: an in-repo link (even a dangling one) would make
      // this create the mountpoint OUTSIDE the repo.
      const viaLink = rel.split('/').some((_, i, parts) => {
        try { return fs.lstatSync(path.join(project.hostPath, ...parts.slice(0, i + 1))).isSymbolicLink(); } catch { return false; }
      });
      if (!viaLink && !fs.existsSync(inRepo) && path.resolve(inRepo).startsWith(`${path.resolve(project.hostPath)}${path.sep}`)) {
        try {
          if (fs.statSync(hp).isDirectory()) fs.mkdirSync(inRepo, { recursive: true });
          else { fs.mkdirSync(path.dirname(inRepo), { recursive: true }); fs.writeFileSync(inRepo, ''); }
          made = true;
        } catch { /* docker will create it; the note below still says what happens */ }
      }
      opts.onLog?.(
        `[container] note: mount ${hp} -> ${m.containerPath} sits INSIDE the repo (workspaceRoot puts the repo at ${CONTAINER_WORKSPACE}); ` +
          (made ? `created an empty ${rel} in the repo as its mountpoint.\n` : `it hides the repo's own ${rel} while mounted.\n`),
      );
    }
    if (!fs.existsSync(hp)) {
      opts.onLog?.(
        `[container] skipping project mount ${hp} -> ${m.containerPath}: that host path does not exist. ` +
          'The session is starting WITHOUT it; restore the directory or remove the mount in project settings.\n',
      );
    }
  }

  /*
   * BUG-136 (third report) — clear the residue of the bug above. A container
   * created while the browser daemon was down left a root-owned EMPTY directory
   * where the socket belongs, and the daemon dies on EISDIR trying to unlink it
   * forever after. `desiredBinds` no longer creates these; this removes the ones
   * already on disk so an affected project heals on its next ensure instead of
   * needing a manual rmdir. Deliberately narrow: only an EMPTY directory, only
   * at the socket path this project owns, and any failure is reported and
   * ignored rather than failing the ensure.
   */
  /*
   * BUG-152 — this reads the socket path DIRECTLY rather than filtering
   * `browserBinds()` for it. Same path, but `browserBinds` also resolves the MCP
   * shim through `requireRepoDir()`, so asking it for the socket threw the whole
   * ensure when CLAUDE_STATION_SBMCP_REPO was unset — and that is precisely the
   * state in which this heal matters most, since an unconfigured adapter is one
   * of the ways the daemon ends up down while a container is created. Guarding
   * this block on `available()` instead would have disabled the repair exactly
   * when it is needed. `socketPath` derives from the state dir and the project
   * id; it needs no adapter checkout.
   */
  if (browserSettingsOf(project).enabled) {
    const sock = browserSocketPath(project);
    let st: fs.Stats | null = null;
    try { st = fs.lstatSync(sock); } catch { st = null; }
    if (st?.isDirectory()) {
      try {
        fs.rmdirSync(sock); // fails loudly if non-empty — never recursive
        opts.onLog?.(
          `[container] removed a directory left at the stealth browser socket path ${sock}. ` +
            'Docker created it from a missing mount source and it was blocking the browser daemon from ever starting.\n',
        );
      } catch (err) {
        opts.onLog?.(`[container] could not clear ${sock} (${(err as Error).message}) — the stealth browser will not start until it is removed.\n`);
      }
    }
  }
  building.add(project.id);
  invalidate(project.id);

  const name = containerName(project.id);
  /*
   * FEAT-157 — RECOVERY: no usable pin (missing after migration, unreadable, or
   * naming a release the catalog does not have). Orchard never picks a base for
   * such a project: an existing container is used exactly as it is (started if
   * stopped, never recreated), and with none the launch is refused with the
   * reason. The rail offers the choice.
   */
  /*
   * ARCH-022 x FEAT-157 — the ONE image plan for this operation: the pin, the catalog and what the container runs,
   * read once here. Everything below (recovery, the build, the drift decision) uses this plan and nothing re-derives.
   */
  const plan = imagePlanOf(project);
  if (plan.source !== 'custom') {
    const tgt = plan.target!;
    if (tgt.kind === 'recovery') {
      const lv = inspect(name);
      refuseForeign(name, lv);
      if (!lv) {
        throw new ContainerError('base-pin-invalid',
          `this project has no usable base pin (${tgt.why}) and no container to keep running, so Orchard will not pick a base for it. Choose a base release on the project's Needs-You rail (Adopt).`);
      }
      opts.onLog?.(`[container] base pin needs a choice (${tgt.why}); keeping ${name} exactly as it is until a release is adopted on the rail\n`);
      // (attack round 3, d) recovery keeps the BASE, not a mismatched CLI: the CLI is still checked by its bytes.
      // Under a live session a mismatch refuses the launch; idle, the host's CLI is layered onto the very image the
      // container runs (the base is unchanged) and the container is recreated on it.
      const wantCli = await hostCli();
      const haveCli = containerCliSha(lv.id);
      if (haveCli !== undefined && haveCli !== wantCli.sha256) {
        if (lv.running && lifecycle.hasLeases(op.projectId)) {
          throw new ContainerError('cli-mismatch-live', `${name} does not run this host's exact Claude CLI binary (the host's SDK needs ${wantCli.version}); it is not recreated under the session(s) running there now. Close them, then start again.`);
        }
        const img = await ensureRuntimeImage(lv.imageId, wantCli, { onLog: opts.onLog });
        opts.onLog?.(`[container] recovery: giving ${name} the host's Claude CLI on the image it already runs\n`);
        await removeContainer(name);
        createAndStart(project, name, img, opts);
        invalidate(project.id);
        const st0 = assertRunning(project);
        assertCliResolves(project, name, img);
        return st0;
      }
      if (!lv.running) {
        const r = dockerSync(['start', lv.id], 60_000);
        if (r.code !== 0) throw new ContainerError('start-failed', `could not start ${name}`, (r.stderr || r.stdout).trim().slice(0, 800));
      }
      invalidate(project.id);
      return assertRunning(project);
    }
  }
  const resolved = await ensureImageFull(project, { onLog: opts.onLog, plan });
  const image = resolved.image;

  // Pre-create the host-side session-history dir so the bind mount is owned by
  // the host user; if docker creates it, it lands root-owned and the container
  // silently cannot write history.
  for (const b of desiredBinds(project)) {
    if (b.why === 'session history') ensureDir(b.hostPath);
  }

  const locked = keepsLastGood(project);
  if (locked) {
    // A swap interrupted by a restart. If it died AFTER the old container was
    // removed, `-next` is the only container and is running: finish the swap
    // (rename it into place) rather than delete it. Otherwise it is a
    // half-made replacement, always safe to delete.
    /*
     * BUG-214 round 6 — `<name>-next` is ALSO the container name of a project whose id is `<id>-next`
     * (ids are slugs), so treating whatever holds it as our half-made swap removed or renamed another
     * project's live container. The swap name is now `<name>.next` (a slug has no '.'), and a candidate
     * — new or legacy — is ours only if it carries THIS project's label.
     */
    for (const next of [nextName(name), `${name}-next`]) {
      const nx = inspect(next);
      if (!nx || nx.project !== project.id) continue;
      refuseForeign(next, nx);
      if (!inspect(name) && nx.running && dockerSync(['rename', nx.id, name], 30_000).code === 0) {
        opts.onLog?.(`[container] finished an interrupted swap: ${next} renamed to ${name}\n`);
      } else if (!nx.running || inspect(name)) {
        const r = await dockerAsync(['rm', '-f', '-v', nx.id], 60_000);
        if (r.code !== 0 && !/No such container/i.test(r.stderr)) throw new ContainerError('remove-failed', `could not remove ${next}`, (r.stderr || r.stdout).trim().slice(0, 800));
      }
    }
  }
  const live = inspect(name);
  refuseForeign(name, live);
  if (live) {
    const reasons = driftReasons(project, live, image);
    // FEAT-157 (attack round 1, d): the CLI inside a RUNNING container can be replaced from inside it (the session
    // user owns ~/.local/bin). Its bytes are checked at every launch; a mismatch is image-class drift: recreated at
    // an idle launch, and under a live session the new launch is refused (never started on a foreign CLI).
    // (attack round 2, d) a STOPPED container is checked too: its writable layer survives a stop/start.
    if (imageSourceOf(project) !== 'custom' && !reasons.some((r) => r.startsWith('image '))) {
      const want = hostCliSync();
      const have = want ? containerCliSha(live.id) : undefined;
      if (want && have === undefined) opts.onLog?.(`[container] could not read the Claude CLI inside ${name} to compare it with the host's; keeping the container as it is\n`);
      else if (want && have !== want.sha256) reasons.push(`image ${live.image}: the Claude CLI inside the container is not this host's (replaced from inside, or never matched)`);
    }
    if (reasons.length || opts.forceRecreate) {
      /*
       * BUG-214 — an image swap (a new or rebuilt image of ANY source) and the
       * one-time lockdown upgrade (FEAT-155 round 7) never remove the container
       * under live sessions; they apply at the next launch with none live, or on
       * Rebuild. The `locked &&` this used to carry limited the image half to
       * Dockerfile projects, so a base-direct container was recreated under its
       * live session on every base change. Both kinds together defer too. Any
       * other reason (a settings change, a stale credential bind) is not an image
       * swap: with a lease held it is refused, never recreated.
       *
       * ARCH-022: "sessions are live" is the authority's lease set, and this runs inside the project's
       * slot, where no new lease can appear. The authority's gate re-checks it at the docker call itself.
       */
      const deferrable = reasons.every((r) => r.startsWith('image ') || r.startsWith('lockdown:'));
      const held = lifecycle.hasLeases(op.projectId);
      if (deferrable && live.running && held) {
        /*
         * FEAT-157 finding 4 — NEVER LAUNCH MISMATCHED. Deferring means this launch
         * starts on the container that is running now. If the swap being deferred is
         * (also) a Claude CLI change, that container's CLI is not the one this host's
         * SDK speaks to, so the new session is refused instead — with the versions and
         * what to do. The live sessions are not touched.
         */
        if (reasons.some((r) => r.startsWith('image ')) && imageSourceOf(project) !== 'custom') {
          const want = hostCliSync();
          const have = want ? containerCliSha(live.id) : undefined;
          if (want && have !== undefined && have !== want.sha256) {
            throw new ContainerError('cli-mismatch-live',
              `${name} does not run this host's exact Claude CLI binary (the host's SDK needs ${want.version}, sha256 ${want.sha256.slice(0, 12)}). The container gets the host's CLI at the next launch with no live session in it; it is not recreated under the session(s) running there now. Close the live session(s) in this project, then start again.`);
          }
        }
        deferred.swap = true;
        if (!reasons.length) {
          opts.onLog?.(`[container] rebuilt, but sessions hold ${name}; the rebuilt image applies at the next launch with no live session (or press Rebuild again).\n`);
          invalidate(project.id);
          return statusOf(project);
        }
        const img = reasons.some((r) => r.startsWith('image '));
        const lock = reasons.some((r) => r.startsWith('lockdown:'));
        opts.onLog?.(
          (img
            ? `[container] a new image (${image}) is ready, but other sessions are live in ${name}; this session starts on the current image ` +
              'and the new one applies at the next launch with no live session (or press Rebuild).\n'
            : '') +
          (lock
            ? `[container] ${name} predates the run-time lockdown, but other sessions are live in it; it is recreated under the lockdown ` +
              'at the next launch with no live session (or press Rebuild).\n'
            : ''),
        );
        invalidate(project.id);
        return statusOf(project);
      }
      if (live.running && held) {
        throw new ContainerError('live-sessions',
          `refusing to recreate ${name} (${reasons.join('; ') || 'rebuild requested'}): sessions are live in it and this would destroy the container underneath them. Close them first, or retry with ?force=1.`);
      }
      if (locked) return swapContainer(project, name, image, live, reasons.length ? reasons : ['rebuild requested'], opts, resolved.parent);
      opts.onLog?.(`[container] recreating ${name}: ${reasons.join('; ') || 'rebuild requested'}\n`);
      await removeContainer(name);
    } else if (live.running) {
      invalidate(project.id);
      if (locked) noteRunningOn(project, resolved.parent);
      return statusOf(project);
    } else {
      const r = dockerSync(['start', name], 60_000);
      if (r.code !== 0) throw new ContainerError('start-failed', `could not start ${name}`, (r.stderr || r.stdout).trim().slice(0, 800));
      invalidate(project.id);
      const st = assertRunning(project);
      if (locked) noteRunningOn(project, resolved.parent);
      return st;
    }
  }

  try {
    createAndStart(project, name, image, opts);
  } catch (err) {
    // Nothing was running to keep. Remember a new image that cannot run so the
    // next launch falls back to the last good one instead of retrying it.
    if (locked) markImageBad(project, resolved.parent, err as Error);
    throw err;
  }
  invalidate(project.id);
  const st = assertRunning(project);
  assertCliResolves(project, name, image);
  if (locked) noteRunningOn(project, resolved.parent);
  return st;
}

/**
 * (attack round 3, d) After a container is created, the CLI path must resolve — through the image's own symlinks,
 * VOLUMEs and the project's mounts — to the host's bytes. An image that redirects it (a symlinked or volume-backed
 * `~/.local/bin`) is refused before any session starts, rather than recreated in a loop.
 */
function assertCliResolves(project: Project, name: string, image: string): void {
  if (imageSourceOf(project) === 'custom') return;
  const want = hostCliSync();
  const ins = inspect(name);
  if (!want || !ins) return;
  const have = containerCliSha(ins.id);
  if (have !== undefined && have !== want.sha256) {
    throw new ContainerError('cli-redirected',
      `${name} was created on ${image}, but inside it ${CONTAINER_CLAUDE_BIN} does not resolve to this host's Claude CLI (the image or a mount redirects that path — a VOLUME or a symlink over ~/.local/bin). No session was started; change the image so that path is a plain directory.`);
  }
}

function nextName(name: string): string {
  return `${name}.next`; // BUG-214 round 6: never a possible project container name (slugs have no '.')
}

/** The full `docker create` argv for this project's container on `image`. Exported for the verify suites. */
export function createArgs(project: Project, name: string, image: string, opts: EnsureOptions): string[] {
  const cs = containerSettingsOf(project);
  const args = [
    'create',
    '--name', name,
    '--init',
    '--security-opt', 'no-new-privileges:true',
    '--memory', `${cs.memoryMb}m`,
    '--pids-limit', String(cs.pidsLimit),
    '--workdir', containerWorkdir(project),
    '--label', 'claude-station=1',
    '--label', `claude-station.project=${project.id}`,
    // BUG-214 round 8: labels are inherited from the IMAGE unless set here. An image (a custom one, or the
    // project's own Dockerfile) carrying `claude-station.role=service` made the session container look like a
    // stray sidecar, and `ensureServices` removed it under its live session. Declare the role.
    '--label', 'claude-station.role=session',
    // BUG-216: the creator declares which instance owns this container; only that instance's sweep may remove it.
    ...ownerLabelArgs(),
    '--add-host', 'host.docker.internal:host-gateway',
  ];
  for (const cap of CAP_DROP) args.push('--cap-drop', cap);
  args.push(...lockdownCreateArgs());
  for (const g of desiredGroupAdd(project)) args.push('--group-add', g);
  if (gpuEnabled(project)) args.push('--gpus', 'all');
  for (const [k, v] of Object.entries(cs.env ?? {})) {
    // Write-time validation refuses these; a hand-edited registry must not get
    // them past create either (see reservedContainerEnvReason).
    const why = reservedContainerEnvReason(k);
    if (why) { opts.onLog?.(`[container] ignoring container.env ${k}: ${why}\n`); continue; }
    args.push('--env', `${k}=${v}`);
  }
  // Always written (possibly empty), so an image LABEL can never stand in for it.
  args.push('--label', `${ENV_KEYS_LABEL}=${envKeysOf(project)}`);
  for (const b of desiredBinds(project)) args.push('-v', bindString(b));
  args.push(image);
  args.push(...LOCKDOWN_CMD);
  return args;
}

function createAndStart(project: Project, name: string, image: string, opts: EnsureOptions): void {
  const created = dockerSync(createArgs(project, name, image, opts), 60_000);
  if (created.code !== 0) {
    throw new ContainerError('create-failed', `could not create ${name}`, (created.stderr || created.stdout).trim().slice(0, 1200));
  }
  // BUG-216: start the container this call created (its ID), not whatever holds the name by now.
  const id = created.stdout.trim().split('\n').pop()?.trim() || name;
  const started = dockerSync(['start', id], 60_000);
  if (started.code !== 0) {
    throw new ContainerError('start-failed', `created ${name} but it would not start`, (started.stderr || started.stdout).trim().slice(0, 1200));
  }
}

/**
 * FEAT-155 round 5 — recreate a Dockerfile project's container WITHOUT a window
 * where it is broken or absent: the replacement is created and started as
 * `<name>-next` while the current one is untouched; only once it is proven
 * running is the current one removed and the replacement renamed into place.
 * If the replacement cannot run, it is removed and the current container stays
 * exactly as it was (restarted if it was stopped) — the last good image keeps
 * running. A `-next` left by a restart mid-swap is always safe to delete, and
 * `doEnsure` does so first.
 */
async function swapContainer(project: Project, name: string, image: string, live: Inspected, reasons: string[], opts: EnsureOptions, parent: string = image): Promise<ContainerStatus> {
  const next = nextName(name);
  opts.onLog?.(`[container] recreating ${name} on ${image}: ${reasons.join('; ')} — the current container stays until the new one is running\n`);
  try {
    createAndStart(project, next, image, opts);
    const n = inspect(next);
    if (!n?.running) {
      const logs = dockerSync(['logs', '--tail', '40', next]);
      throw new ContainerError('not-running', `the new container on ${image} is not running after start`, (logs.stdout + logs.stderr).trim().slice(-1500));
    }
  } catch (err) {
    await removeContainer(next).catch(() => undefined);
    markImageBad(project, parent, err as Error);
    opts.onLog?.(`[container] could not start a container on ${image} (${(err as Error).message.split('\n')[0]}); keeping ${name} on ${live.image}\n`);
    if (!live.running) {
      const r = dockerSync(['start', name], 60_000);
      if (r.code !== 0) throw new ContainerError('start-failed', `could not start ${name}`, (r.stderr || r.stdout).trim().slice(0, 800));
    }
    invalidate(project.id);
    return assertRunning(project);
  }
  await removeContainer(name);
  const rn = dockerSync(['rename', next, name], 30_000);
  if (rn.code !== 0) throw new ContainerError('rename-failed', `could not rename ${next} to ${name}`, (rn.stderr || rn.stdout).trim().slice(0, 600));
  invalidate(project.id);
  const st = assertRunning(project);
  assertCliResolves(project, name, image);
  noteRunningOn(project, parent);
  return st;
}

/** A container is running on `image`: that is the project's last good image now; reclaim the superseded ones. */
function noteRunningOn(project: Project, image: string): void {
  if (!isOwnProjectImage(project, image)) return;
  const rec = recordFor(project);
  if (rec.lastGoodImage !== image) {
    updateBuildRecord(project.id, { lastGoodImage: image });
    try { pruneProjectImages(project, image); } catch { /* cleanup must never fail an ensure */ }
  }
}

/** A validated image that still could not run a container: do not retry it on every launch. */
function markImageBad(project: Project, image: string, err: Error): void {
  const h = dfHashOf(image);
  if (!h || recordFor(project).lastGoodImage === image) return;
  updateBuildRecord(project.id, { state: 'failed', failedHash: h, error: `a container on ${image} would not run: ${err.message.split('\n')[0]}`, finishedAt: new Date().toISOString() });
}

/** Never report success off an exit code alone — read the live state back. */
function assertRunning(project: Project): ContainerStatus {
  invalidate(project.id);
  const s = statusOf(project);
  if (s.state !== 'running') {
    const logs = dockerSync(['logs', '--tail', '40', containerName(project.id)]);
    throw new ContainerError(
      'not-running',
      `container ${s.containerName} is "${s.state}" after start`,
      (logs.stdout + logs.stderr).trim().slice(-1500),
    );
  }
  return s;
}

async function removeContainer(name: string): Promise<void> {
  // BUG-216: read the owner first, refuse another instance's container, and remove
  // by the inspected ID so a same-named container created in between is never hit.
  const ins = inspect(name);
  if (!ins) return;
  refuseForeign(name, ins);
  // -v: an image VOLUME leaves an anonymous volume per container; reclaim it.
  const r = await dockerAsync(['rm', '-f', '-v', ins.id], 60_000);
  if (r.code !== 0 && !/No such container/i.test(r.stderr)) {
    throw new ContainerError('remove-failed', `could not remove ${name}`, (r.stderr || r.stdout).trim().slice(0, 800));
  }
}

/** Stop: an operation; refused while any lease holds the project (unless forced over request-time ones). */
export function stopContainer(project: Project, req: OpRequest = {}): Promise<ContainerStatus> {
  return inOp(project, 'stop', req, async (op, p) => {
    await clearForDestroy(op, req, 'stop');
    const st = await stopContainerNow(p);
    // FEAT-112: services live and die with the session container. Keep their data volumes (a Stop is not a
    // purge). BUG-221: this runs in the same slot, so a launch queued behind it brings them up again after.
    teardownServices(p.id, { removeVolumes: false }, req.onLog);
    return st;
  });
}

async function stopContainerNow(project: Project): Promise<ContainerStatus> {
  const name = containerName(project.id);
  const ins = inspect(name);
  refuseForeign(name, ins); // BUG-216
  if (!ins) { invalidate(project.id); return statusOf(project); }
  const r = await dockerAsync(['stop', '-t', '10', ins.id], 90_000);
  if (r.code !== 0 && !/No such container/i.test(r.stderr)) {
    throw new ContainerError('stop-failed', `could not stop ${name}`, (r.stderr || r.stdout).trim().slice(0, 800));
  }
  invalidate(project.id);
  return statusOf(project);
}

/** Remove the container (and stop its services, keeping their data). Same rules as Stop. */
export function removeProjectContainer(project: Project, req: OpRequest = {}): Promise<ContainerStatus> {
  return inOp(project, 'remove', req, async (op, p) => {
    await clearForDestroy(op, req, 'remove');
    await removeContainer(containerName(p.id));
    invalidate(p.id);
    teardownServices(p.id, { removeVolumes: false }, req.onLog);
    return statusOf(p);
  });
}

/**
 * Rebuild the image from scratch and recreate the container on it — its own operation, never a join
 * onto a launch's ensure (BUG-222). Build FIRST (FEAT-155 round 5): a failed build leaves the container
 * untouched. When sessions hold the project, the rebuilt image is NOT applied under them: the result says
 * `deferred`, and the image applies at the next launch with no live session (drift: the image changed).
 */
export function rebuildContainer(project: Project, req: OpRequest = {}): Promise<ContainerStatus & { deferred?: boolean }> {
  return inOp(project, 'rebuild', req, async (op, p) => {
    if (req.forceOver) await clearForDestroy(op, req, 'rebuild');
    building.add(p.id);
    invalidate(p.id);
    try {
      await ensureImage(p, { force: true, onLog: req.onLog });
    } finally {
      building.delete(p.id);
      invalidate(p.id);
    }
    // Settings may have changed during the build (they are not written through the slot): re-read.
    const now = req.current ? req.current() : p;
    if (!now) throw new ContainerError('project-gone', `project ${p.id} was deleted while its Rebuild ran; nothing was recreated`);
    if (lifecycle.hasLeases(p.id)) {
      req.onLog?.(`[container] rebuilt, but sessions hold ${containerName(p.id)}; the rebuilt image applies at the next launch with no live session (or press Rebuild again).\n`);
      return { ...statusOf(now), deferred: true };
    }
    const st = await ensureInOp(op, now, { onLog: req.onLog, forceRecreate: true });
    try { connectSessionToServices(now.id, req.onLog); } catch (err) { (st as { serviceRejoin?: string }).serviceRejoin = (err as Error).message; }
    return st;
  });
}

/**
 * Project DELETE, as one operation: its container, its services (data included), its build state, and —
 * last, inside the same slot — the registry row (`commit`), so a launch queued behind it finds no project.
 */
export function deleteProjectResources(project: Project, req: OpRequest & { commit: () => void; container: boolean }): Promise<{ container: unknown; buildState: unknown }> {
  return inOp(project, 'delete', req, async (op, p) => {
    await clearForDestroy(op, req, 'delete');
    let container: unknown = null;
    let buildState: unknown = null;
    const docker = dockerAvailable().ok;
    if (req.container && docker) {
      try { await removeContainer(containerName(p.id)); invalidate(p.id); container = statusOf(p); }
      catch (err) { if (err instanceof ContainerError && err.code === 'live-sessions') throw err; container = { error: (err as Error).message }; }
      // FEAT-112: the project is gone, so its sidecars, network AND data volumes go with it.
      try { teardownServices(p.id, { removeVolumes: true }, req.onLog); } catch { /* best effort; the sweep is the backstop */ }
    }
    // ARCH-020: its builder, Dockerfile images and build record go too, whatever its isolation is now.
    if (docker) {
      try { buildState = await removeProjectBuildState(p); } catch (err) { buildState = { error: (err as Error).message }; }
    }
    req.commit();
    return { container, buildState };
  });
}

/**
 * The orphan sweep: one operation PER orphan project, each re-checking under that project's slot that the
 * project is still unknown, so a project created meanwhile (and its first session) is never swept.
 */
export async function sweepOrphans(isKnown: (projectId: string) => boolean): Promise<{ removed: ReturnType<typeof removeContainerByName>[]; builders: string[]; infra: { networks: string[]; volumes: string[] } }> {
  const known = new Set<string>();
  const unknown = (id: string) => { if (isKnown(id)) { known.add(id); return false; } return true; };
  const pids = new Set<string>();
  for (const c of listStationContainers()) if (c.owner === 'own' && c.projectId && unknown(c.projectId)) pids.add(c.projectId);
  for (const b of findOrphanBuilders(known)) if (unknown(b.projectId)) pids.add(b.projectId);
  for (const pid of orphanServiceProjects(known)) if (unknown(pid)) pids.add(pid);
  const out = { removed: [] as ReturnType<typeof removeContainerByName>[], builders: [] as string[], infra: { networks: [] as string[], volumes: [] as string[] } };
  for (const pid of pids) {
    try {
      await lifecycle.runOp(pid, 'sweep', async () => {
        if (isKnown(pid)) return; // registered meanwhile: not an orphan any more
        for (const c of listStationContainers()) if (c.owner === 'own' && c.projectId === pid) out.removed.push(removeContainerByName(c.name));
        out.builders.push(...removeProjectBuilders(pid, isolatedBuildEnv()));
        const r = reapProjectServiceInfra(pid);
        out.infra.networks.push(...r.networks);
        out.infra.volumes.push(...r.volumes);
      });
    } catch (err) {
      out.removed.push({ name: containerName(pid), removed: false, detail: (asContainerError(err) as Error).message.slice(0, 300) });
    }
  }
  return out;
}

/* ----------------------------------------------------------------- memory */
/*
 * OOM honesty. When the kernel kills the CLI inside a container, the SDK
 * surfaces a baffling "exited with code 137". Two sources of truth:
 *  - docker inspect State.OOMKilled — set only when the container's INIT was
 *    the victim, which our exec-based sessions usually are not;
 *  - the cgroup's memory.events oom_kill counter — increments for EVERY kill
 *    inside the container's cgroup, execs included. That is the reliable one.
 * A session records the counter at start; a transport death with the counter
 * advanced IS an OOM kill, and gets said in plain words with the limit.
 */

export interface MemoryStatus {
  currentBytes: number | null;
  limitBytes: number | null;
  /** Cumulative kernel OOM kills inside this container's cgroup. */
  oomKills: number | null;
}

export function memoryStatus(project: Project): MemoryStatus {
  const out: MemoryStatus = { currentBytes: null, limitBytes: null, oomKills: null };
  let r: RunResult;
  try { r = lifecycle.withProbe(() => dockerSync(['exec', containerName(project.id), 'sh', '-c', lifecycle.MEMORY_PROBE_SCRIPT], 5_000)); } catch { return out; }
  if (r.code !== 0) return out;
  for (const line of r.stdout.split('\n')) {
    const v = line.slice(2).trim();
    if (line.startsWith('C:') && /^\d+$/.test(v)) out.currentBytes = Number(v);
    else if (line.startsWith('M:') && /^\d+$/.test(v)) out.limitBytes = Number(v); // 'max' = unlimited → null
    else if (line.startsWith('K:') && /^\d+$/.test(v)) out.oomKills = Number(v);
  }
  return out;
}

/**
 * Why did the session's process die — was it the memory limit? Returns the
 * plain-words explanation, or null when there is no evidence of an OOM kill.
 * `baselineOomKills` is the counter at session start (null = unknown, treat
 * any kill as evidence).
 */
export function oomExplanation(project: Project, baselineOomKills: number | null): string | null {
  const cs = containerSettingsOf(project);
  let inspectSaysOom = false;
  try {
    inspectSaysOom = dockerSync(['inspect', containerName(project.id), '--format', '{{.State.OOMKilled}}'], 5_000)
      .stdout.trim() === 'true';
  } catch { /* container gone — the cgroup check below also fails, fine */ }
  let counterAdvanced = false;
  try {
    const now = memoryStatus(project).oomKills;
    counterAdvanced = now !== null && now > (baselineOomKills ?? 0);
  } catch { /* unreadable */ }
  if (!inspectSaysOom && !counterAdvanced) return null;
  return `the container hit its ${cs.memoryMb} MB memory limit and the kernel killed the session's process (OOM). ` +
    `Raise container.memoryMb in this project's settings, or lower the session's memory use.`;
}

/* ------------------------------------------------------------------- exec */

/**
 * Env vars worth carrying from the SDK's spawn env into the container.
 *
 * FEAT-145 — `CLAUDE_CONFIG_DIR` is deliberately NOT on this list and must
 * never be added. agent-bridge sets it to the account's overlay dir on the
 * HOST (`<data>/claude-accounts/<id>`), a path that does not exist inside the
 * container; forwarding it would point the CLI at an empty config dir it would
 * then create fresh — no credential, no settings.json (so `cleanupPeriodDays`
 * back to 30), and transcripts written somewhere no Orchard reader looks. The
 * container's account identity travels as a BIND instead (`credentialsBind`),
 * which is also what makes it drift-detectable.
 */
const ENV_PASSTHROUGH = [
  // BUG-118: the launch-provenance marker — the session id this launch declared
  // (round 2; a bare flag was inherited by nested hand-started sessions). A
  // containerised session runs the response-format Stop hook INSIDE the
  // container, against the mounted repo's own .claude/settings.json, so the
  // marker has to cross the `docker exec` boundary or every containerised
  // session looks hand-started and goes ungraded. The value is opaque here —
  // this list forwards whatever the SDK spawn env holds, so the id travels
  // unchanged and the hook inside can compare it with its own Stop payload.
  'ORCHARD_SESSION',
  'ORCHARD_DISPATCH_ENTITLED',
  'ORCHARD_DISPATCH_SOCK',
  'ORCHARD_DISPATCH_CMD',
  'ORCHARD_DISPATCH_UNAVAILABLE_REASON',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'ANTHROPIC_MODEL',
  'DEBUG',
  'DEBUG_CLAUDE_AGENT_SDK',
  'MAX_THINKING_TOKENS',
];

export interface ExecSpec {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
  /**
   * Unique tag stamped into the exec's environment so `reapExec` can find
   * exactly this process later. See reapExec for why this is needed.
   */
  execId: string;
}

/** Env var carrying the exec tag. Read back out of /proc/<pid>/environ. */
export const EXEC_TAG_VAR = lifecycle.EXEC_TAG_VAR; // ARCH-022: owned by the authority

/**
 * FEAT-155 — `container.env` keys a project may NOT set, and why. Declared here,
 * next to the exec env Orchard itself controls, and read by both write-time
 * validation and container create. A container-level value for any of these
 * either redirects where the CLI keeps history/config (so transcripts land
 * where no Orchard reader looks and vanish on recreate), bypasses the
 * project's declared account (auth), or spoofs an Orchard-owned marker that
 * `docker exec` only overrides when it has a value of its own.
 */
export function reservedContainerEnvReason(key: string): string | null {
  for (const rule of RESERVED_ENV_RULES) {
    if ((rule.exact ?? []).includes(key) || (rule.prefixes ?? []).some((p) => key.startsWith(p))) return rule.reason;
  }
  return null;
}

/**
 * FEAT-157 — THE reserved-env table. `reservedContainerEnvReason` above is a loop
 * over it (so is the image-ENV policy, via that function), and the per-project
 * agent's container guide is generated from it (`containerGuideFacts`): adding a
 * rule here changes the enforcement AND what the agent is told, with no second
 * edit. Order matters only for which reason a key reports; the first match wins,
 * exactly as the `if` chain this replaced.
 */
export interface ReservedEnvRule {
  exact?: readonly string[];
  prefixes?: readonly string[];
  reason: string;
  /** How the guide names the rule. */
  guide: string;
}
export const RESERVED_ENV_RULES: ReservedEnvRule[] = [
  {
    exact: ['HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PROJECT_DIR_NAME', 'CLAUDECODE', 'XDG_CONFIG_HOME'],
    reason: 'it moves where the CLI keeps its config and session history, away from the store Orchard binds and reads',
    guide: 'moves the CLI\'s config and session history away from what Orchard binds',
  },
  {
    prefixes: ['ANTHROPIC_', 'CLAUDE_CODE_'],
    reason: "it is Claude Code's own auth/endpoint/behaviour surface (e.g. ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, CLAUDE_CODE_USE_BEDROCK), which would route the session away from the project's declared account — Orchard sets these per session",
    guide: 'Claude Code\'s auth/endpoint surface; Orchard sets these per session',
  },
  {
    exact: ['PATH'],
    reason: "a container-level PATH replaces the image's entire PATH (docker does not expand $PATH) and can stop the container starting — set it in the image (Dockerfile ENV) instead",
    guide: 'as container.env it replaces the image PATH wholesale; set PATH with ENV in the Dockerfile instead',
  },
  {
    prefixes: ['ORCHARD_', 'CLAUDE_STATION_', 'SBMCP_'],
    get exact() { return ENV_PASSTHROUGH; },
    reason: 'Orchard sets it per session',
    guide: 'Orchard sets these per session',
  },
];

/** Sorted, comma-joined `container.env` keys Orchard sets on create (recorded as a label for drift). */
function envKeysOf(project: Project): string {
  return Object.keys(containerSettingsOf(project).env ?? {}).filter((k) => !reservedContainerEnvReason(k)).sort().join(',');
}
const ENV_KEYS_LABEL = 'claude-station.env-keys';

/**
 * Build the `docker exec` argv that runs the CLI inside the project's
 * container. Split out from `execInContainer` so tests can assert the argv
 * without spawning anything.
 */
export function execArgv(project: Project, spec: ExecSpec): string[] {
  const argv = ['exec', '-i', '--workdir', containerWorkdir(project), '--user', `${hostUidGid().uid}:${hostUidGid().gid}`];
  for (const k of ENV_PASSTHROUGH) {
    const v = spec.env[k];
    if (v !== undefined && v !== '') argv.push('--env', `${k}=${v}`);
  }
  argv.push('--env', `HOME=${CONTAINER_HOME}`);
  argv.push('--env', `${EXEC_TAG_VAR}=${spec.execId}`);
  /*
   * The MCP shim is spawned by the CLI *inside* this exec, so it inherits this
   * env. SBMCP_AUTOSTART=0 is the important one: a container must never try to
   * launch Chrome — it would be the wrong, detectable Chrome, and the whole
   * point is that the real one runs on the host.
   */
  if (browserSettingsOf(project).enabled) {
    for (const [k, v] of Object.entries(browserContainerEnv())) argv.push('--env', `${k}=${v}`);
  }
  argv.push(containerName(project.id), spec.command, ...spec.args);
  return argv;
}

/**
 * Kill a tagged exec that is still alive inside the container.
 *
 * WHY THIS EXISTS: a `docker exec` process is NOT a child of the container's
 * PID 1 (observed: PPID 0, i.e. reparented to the containerd shim), and killing
 * the host-side `docker exec` client does NOT signal the process inside. In the
 * normal path the CLI sees stdin EOF and exits on its own — but only after any
 * in-flight tool call returns, so a tool that never returns would strand a
 * `claude` process holding memory in the container forever. That is exactly the
 * orphaned-exec leak this project has been bitten by before.
 *
 * Matching is by the unique env tag rather than by process name, so a session
 * teardown can never kill a *sibling* session sharing the same container.
 * Returns the number of processes signalled.
 */
export function reapExec(project: Project, execId: string, signal: 'TERM' | 'KILL' = 'TERM'): number {
  if (!/^[A-Za-z0-9_-]+$/.test(execId)) throw new ContainerError('bad-exec-id', `refusing to reap unsafe exec id ${JSON.stringify(execId)}`);
  const script =
    `n=0; for p in /proc/[0-9]*; do ` +
    `if grep -qz "${EXEC_TAG_VAR}=${execId}" "$p/environ" 2>/dev/null; then ` +
    `kill -${signal} "\${p#/proc/}" 2>/dev/null && n=$((n+1)); fi; done; echo "$n"`;
  // ARCH-022: under the session's own lease (it may only signal its own tag). A released lease = nothing to reap.
  let r: RunResult;
  try { r = lifecycle.withLease(execId, () => dockerSync(['exec', containerName(project.id), 'sh', '-c', script], 15_000)); } catch { return 0; }
  if (r.code !== 0) return 0;
  return Number(r.stdout.trim()) || 0;
}

/**
 * BUG-157 (round 4) — GROUND TRUTH for a container session's liveness, keyed by
 * the same `CLAUDE_STATION_EXEC` tag `reapExec` kills by. A container session has
 * no host-side broker, so `processProbe()` was permanently `'unknown'` and the
 * close decision had to guess from frame timing — which reintroduced data loss on
 * a long silent tool call (a subagent's 7-minute Bash call emits no frame for the
 * whole call, so a frame-staleness bound reaped genuinely-live work). The process
 * itself is the truth the frames could not carry: while a tool call runs there is
 * a `/bin/bash -c …` (or its descendants) inside the container; when the CLI is
 * idle waiting for input there is only the CLI (node) and its long-lived MCP
 * servers / language servers (also node/python), never a `sh -c` tool shell.
 *
 * One process record per tagged pid: pid, ppid, and the space-joined cmdline.
 * Root inside the container reads every environ, so this sees siblings too.
 */
export interface TaggedProc {
  pid: number;
  ppid: number;
  cmd: string;
}

export function listTaggedProcs(project: Project, execId: string): TaggedProc[] {
  if (!/^[A-Za-z0-9_-]+$/.test(execId)) throw new ContainerError('bad-exec-id', `refusing to probe unsafe exec id ${JSON.stringify(execId)}`);
  // Same tag match as reapExec (grep -qz over /proc/<pid>/environ), then emit the
  // pid/ppid/cmdline the host-side classifier needs. NUL separators in environ +
  // cmdline are translated to spaces/newlines so a single tab-delimited line per
  // process survives the round trip.
  const script =
    `for p in /proc/[0-9]*; do ` +
    `if grep -qz "${EXEC_TAG_VAR}=${execId}" "$p/environ" 2>/dev/null; then ` +
    `pid=\${p#/proc/}; ` +
    `ppid=$(awk '/^PPid:/{print $2; exit}' "$p/status" 2>/dev/null); ` +
    `cmd=$(tr '\\0' ' ' < "$p/cmdline" 2>/dev/null); ` +
    `printf '%s\\t%s\\t%s\\n' "$pid" "$ppid" "$cmd"; fi; done`;
  let r: RunResult;
  try { r = lifecycle.withLease(execId, () => dockerSync(['exec', containerName(project.id), 'sh', '-c', script], 15_000)); } catch { return []; }
  if (r.code !== 0) return [];
  const out: TaggedProc[] = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [pidS = '', ppidS = '', ...rest] = line.split('\t');
    const pid = Number(pidS);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    out.push({ pid, ppid: Number(ppidS) || 0, cmd: rest.join('\t').trim() });
  }
  return out;
}

/**
 * Is this process a SHELL invoked to run a command — the Bash tool's
 * `/bin/bash -c source …snapshot… && eval '<command>' …`? The CLI (node), its
 * MCP servers and language servers are never a `-c` shell, so this cleanly picks
 * out tool work and its descendants without a per-image process allow-list.
 */
export function isShellToolProc(cmd: string): boolean {
  const toks = cmd.trim().split(/\s+/).filter(Boolean);
  if (toks.length === 0) return false;
  const base = (toks[0].split('/').pop() ?? '').toLowerCase();
  const isShell = base === 'sh' || base === 'bash' || base === 'dash' || base === 'ash' || base === 'zsh' || base === 'ksh';
  return isShell && toks.includes('-c');
}

export interface ContainerLiveness {
  /** Any tagged process at all — the CLI (and everything it spawned) is alive. */
  cliAlive: boolean;
  /** A live tool shell (or a descendant of one) — a tool call is genuinely running. */
  workAlive: boolean;
  procCount: number;
}

/**
 * PURE classifier over a tagged-process list (unit-testable with no container).
 * `cliAlive` is "is anything tagged still running"; `workAlive` is "is the CLI
 * actively running a tool shell" — the signal that distinguishes a live
 * background subagent mid-Bash-call from an idle CLI whose row is merely stuck.
 *
 * A tool shell counts as live work ONLY while its parent is ALSO tagged — i.e.
 * the CLI (or a tagged tool) is still its parent and is waiting on it. A process
 * the agent BACKGROUNDED (`&` / `setsid` / `nohup`) reparents to init (a ppid
 * outside the tagged set): the CLI's turn is no longer blocked on it, so it is a
 * reap-able orphan, not live work to hold the session open for — otherwise one
 * lingering daemon would pin a container session open forever (a leak by another
 * name). Descendants of a live tool shell (its `sleep`, a build's `node`/`cc`)
 * are work too, by the ppid fixed-point.
 */
export function classifyContainerLiveness(procs: TaggedProc[]): ContainerLiveness {
  if (procs.length === 0) return { cliAlive: false, workAlive: false, procCount: 0 };
  const tagged = new Set<number>(procs.map((p) => p.pid));
  const work = new Set<number>(
    procs.filter((p) => isShellToolProc(p.cmd) && tagged.has(p.ppid)).map((p) => p.pid),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of procs) {
      if (!work.has(p.pid) && work.has(p.ppid)) { work.add(p.pid); changed = true; }
    }
  }
  return { cliAlive: true, workAlive: work.size > 0, procCount: procs.length };
}

/** Convenience: probe + classify in one call for the bridge's close/reap paths. */
export function probeContainerLiveness(project: Project, execId: string): ContainerLiveness {
  return classifyContainerLiveness(listTaggedProcs(project, execId));
}

/**
 * Spawn the CLI inside the container. The returned ChildProcess already
 * satisfies the SDK's `SpawnedProcess` interface (stdin/stdout/kill/on/off).
 *
 * The container MUST already be running — callers go through
 * `ensureContainer` first, and a failure there must propagate rather than
 * degrade to host execution.
 */
export function execInContainer(
  project: Project,
  spec: ExecSpec,
): ChildProcess & { stdin: Writable; stdout: Readable } {
  // ARCH-022: a session exec runs only under the lease its admission granted for this exec tag.
  const child = lifecycle.withLease(spec.execId, () => dockerSpawn(execArgv(project, spec), { stdio: ['pipe', 'pipe', 'pipe'] }));
  if (!child.stdin || !child.stdout) {
    // Cannot happen with stdio 'pipe', but the SDK's SpawnedProcess contract
    // requires non-null streams and a null here would fail far from the cause.
    child.kill('SIGKILL');
    throw new ContainerError('exec-no-stdio', `docker exec for ${containerName(project.id)} produced no stdio pipes`);
  }
  return child as ChildProcess & { stdin: Writable; stdout: Readable };
}

/* ------------------------------------------------------------------ sweep */

export interface StationContainer { name: string; state: string; image: string; projectId: string; owner: Ownership }

/**
 * Every container labelled `claude-station=1` on this daemon — made by ANY Orchard
 * instance, not only this one. `owner` says whose (BUG-216): read from the label its
 * creator wrote, never inferred from this instance's registry.
 */
export function listStationContainers(): StationContainer[] {
  const r = dockerSync(['ps', '-a', '--filter', 'label=claude-station=1', '--format', `{{.Names}}\t{{.State}}\t{{.Image}}\t{{.Label "claude-station.project"}}\t{{.Label "${LABEL_OWNER}"}}`]);
  if (r.code !== 0) return [];
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name = '', state = '', image = '', projectId = '', owner = ''] = l.split('\t');
      return { name, state, image, projectId, owner: ownershipOf(owner) };
    });
}

/**
 * Containers THIS instance created whose project is no longer in its registry.
 * These used to be unreachable: every /container route 404s on an unknown
 * project, so an orphan kept running with the OAuth credentials bind-mounted rw
 * and no API could stop it.
 *
 * BUG-216: "not in my registry" is NOT ownership. On a shared daemon every other
 * Orchard server's containers are also absent from this registry, and a scratch
 * server's sweep once removed 44 of them, live projects included. Only a container
 * whose owner label equals this instance's key is a candidate.
 */
export function findOrphanContainers(knownProjectIds: Set<string>): StationContainer[] {
  return listStationContainers().filter((c) => c.owner === 'own' && c.projectId && !knownProjectIds.has(c.projectId));
}

/**
 * Containers with NO owner label whose project this registry does not know —
 * created before the label existed, by this or any other instance. Nobody can
 * tell which, so they are REPORTED and never removed automatically.
 */
export function findUnownedContainers(knownProjectIds: Set<string>): StationContainer[] {
  return listStationContainers().filter((c) => c.owner === 'unlabelled' && !(c.projectId && knownProjectIds.has(c.projectId)));
}

/**
 * Force-remove an orphan by container name. Refuses unless the container's OWN
 * owner label (read at removal time, not from the list) says this instance made it.
 */
export function removeContainerByName(name: string): { name: string; removed: boolean; detail: string } {
  if (!name.startsWith(NAME_PREFIX)) {
    throw new ContainerError('not-ours', `refusing to remove ${name}: not a Claude Station container`);
  }
  const ins = dockerSync(['inspect', name, '--format', `{{.Id}}\t{{index .Config.Labels "${LABEL_OWNER}"}}`]);
  if (ins.code !== 0) return { name, removed: false, detail: (ins.stderr || ins.stdout).trim().slice(0, 300) };
  const [id = '', label = ''] = ins.stdout.trim().split('\t');
  const who = ownershipOf(label);
  if (who !== 'own') return { name, removed: false, detail: `refused: owner label is ${who === 'unlabelled' ? 'missing' : 'another Orchard instance'}` };
  // By the inspected ID, never the name again: a container that took this name after the check is not the one checked.
  const r = dockerSync(['rm', '-f', id]);
  // `rm -f` exits 0 for a container that is already gone; that is not a removal.
  return { name, removed: r.code === 0 && !/No such container/i.test(r.stderr), detail: (r.stderr || r.stdout).trim().slice(0, 300) };
}

export type { ContainerSettings };

/** FEAT-157 — the prune keep-set, exposed for the GC verification suite only. */
export const __imageKeepSetForTests = (): Set<string> => imageKeepSet();
