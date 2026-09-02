/**
 * FEAT-112 — per-project service sidecars.
 *
 * A project declares the services it needs (Redis, Mongo, …). Claude Station
 * brings each up as a container on a per-project user-defined Docker NETWORK and
 * attaches the session container to that network, so code inside the session
 * reaches a service by `name` over Docker's embedded DNS. This is the standard
 * dev-container model — no elevated capability, isolation boundary intact
 * (contrast the docker-socket toggle, which is host-root-equivalent).
 *
 * WHY A SEPARATE MODULE (not container-manager.ts): the service lifecycle is
 * orthogonal to the single per-project session container. Keeping it here means
 * the (contended) container-manager create path is untouched — the session
 * container is joined to the network POST-HOC with `docker network connect`
 * rather than by rewriting its `docker create` args or its drift logic. A small
 * docker-spawn helper is duplicated here on purpose so there is no import cycle.
 *
 * LIFECYCLE (the decision): services are PROJECT-scoped, mirroring the session
 * container, which is itself per-project and long-lived. They come up lazily at
 * session start (`ensureServices`, called from agent-bridge before the session
 * container is ensured) and are torn down together with the session container —
 * on Stop/Remove/Rebuild of the container, on project delete, and by the orphan
 * sweep. Nothing is left running that the existing container teardown points do
 * not also remove, which is the no-orphans guarantee.
 *
 * DATA: a service that declares `dataPath` gets a per-project named Docker VOLUME
 * mounted there. It lives in Docker storage, never the user's repo, and SURVIVES
 * a container rebuild (only project-delete / orphan-reap / an explicit purge
 * removes it). Ephemeral services (no dataPath) lose their data on removal.
 *
 * FAILURE: a declared service that will not start FAILS the session start loudly
 * and specifically (`ServiceError` names the service + image + docker's stderr) —
 * an agent silently getting no Redis is worse than a clear refusal. An image pull
 * is bounded by a timeout so an unreachable registry cannot hang session start.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Project, ServiceSpec } from './registry.ts';
import { servicesOf } from './registry.ts';

const DOCKER = process.env.CLAUDE_STATION_DOCKER ?? 'docker';
const PREFIX = 'claude-station-';
/**
 * An image pull may be slow but must never hang session start. Overridable via
 * env so a test can prove the bounded-abort path against an unreachable registry
 * without waiting the full two minutes.
 */
const PULL_TIMEOUT_MS = (() => {
  const v = Number(process.env.CLAUDE_STATION_SERVICE_PULL_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 120_000;
})();

export class ServiceError extends Error {
  code: string;
  detail?: string;
  constructor(code: string, message: string, detail?: string) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.detail = detail;
  }
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

function dockerSync(args: string[], timeoutMs = 30_000): RunResult {
  const r = spawnSync(DOCKER, args, { encoding: 'utf8', timeout: timeoutMs });
  return {
    code: typeof r.status === 'number' ? r.status : 1,
    stdout: r.stdout ?? '',
    stderr: (r.stderr ?? '') + (r.error ? String(r.error.message) : ''),
  };
}

/** Async so a slow pull can be bounded and killed by process group on timeout. */
function dockerAsync(args: string[], timeoutMs: number, onLine?: (s: string) => void): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(DOCKER, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        // Kill the whole process group so a docker CLI that forked a pull worker
        // does not survive as an orphan.
        if (child.pid) process.kill(child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.stdout?.on('data', (d) => {
      const s = String(d);
      stdout += s;
      onLine?.(s);
    });
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: stderr + String(err.message), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr, timedOut });
    });
  });
}

/* ----------------------------------------------------------------- names */

export function networkName(projectId: string): string {
  return `${PREFIX}net-${projectId}`;
}
/**
 * A disambiguating tag over the (projectId, serviceName) PAIR.
 *
 * WHY: both `projectId` (slugify → `[a-z0-9-]`, no leading/trailing/double `-`)
 * and `serviceName` (`[a-z][a-z0-9-]{0,30}`) may themselves contain `-`, so a
 * plain `${projectId}-${serviceName}` is NOT an injective encoding of the pair —
 * ("web-api","db") and ("web","api-db") both flatten to `web-api-db` and two
 * unrelated projects then share a container/volume name (cross-project data
 * disclosure, FEAT-112 clean-room round 1, defect 1).
 *
 * The NUL byte `\0` cannot occur in either field (both are restricted to the
 * charsets above), so `projectId + '\0' + serviceName` IS injective over the
 * pair: distinct pairs give distinct hash inputs, hence distinct digests
 * (a truncated-SHA1 collision on top of that is ~2^-48 and would require an
 * attacker to also control both a project name and a service name). Appending
 * this tag to the readable name makes the full derived name unique per pair by
 * construction — the readable prefix may still collide, the tag never does.
 */
function pairTag(projectId: string, serviceName: string): string {
  return createHash('sha1').update(`${projectId}\u0000${serviceName}`).digest('hex').slice(0, 12);
}
export function serviceContainerName(projectId: string, serviceName: string): string {
  return `${PREFIX}svc-${projectId}-${serviceName}-${pairTag(projectId, serviceName)}`;
}
export function volumeName(projectId: string, serviceName: string): string {
  return `${PREFIX}vol-${projectId}-${serviceName}-${pairTag(projectId, serviceName)}`;
}
/** The session container name, mirrored from container-manager's convention. */
function sessionContainerName(projectId: string): string {
  return `${PREFIX}${projectId}`;
}

/**
 * Everything that decides whether a running service container matches its spec.
 * A change to any of these is drift and forces a recreate — the same "a live
 * container keeps its config until rebuilt" rule the session container follows.
 */
function specHash(spec: ServiceSpec): string {
  const canonical = JSON.stringify({
    image: spec.image,
    env: [...(spec.env ?? [])].map((e) => [e.key, e.value]).sort(),
    dataPath: spec.dataPath ?? null,
    alias: spec.name,
  });
  return createHash('sha1').update(canonical).digest('hex').slice(0, 12);
}

/* ---------------------------------------------------------------- inspect */

interface LiveService {
  name: string;
  service: string;
  hash: string;
  running: boolean;
}

/** Service containers Claude Station owns for one project (any state). */
export function listProjectServiceContainers(projectId: string): LiveService[] {
  const r = dockerSync([
    'ps', '-a',
    '--filter', 'label=claude-station.role=service',
    '--filter', `label=claude-station.project=${projectId}`,
    '--format', '{{.Names}}\t{{.State}}\t{{.Label "claude-station.service"}}\t{{.Label "claude-station.service-hash"}}',
  ]);
  if (r.code !== 0) return [];
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name = '', state = '', service = '', hash = ''] = l.split('\t');
      return { name, service, hash, running: state === 'running' };
    });
}

function networkExists(projectId: string): boolean {
  return dockerSync(['network', 'inspect', networkName(projectId)]).code === 0;
}

/* --------------------------------------------------------------- ensure */

function ensureNetwork(projectId: string, onLog?: (s: string) => void): void {
  if (networkExists(projectId)) return;
  const name = networkName(projectId);
  const r = dockerSync([
    'network', 'create',
    '--label', 'claude-station=1',
    '--label', `claude-station.project=${projectId}`,
    '--label', 'claude-station.role=network',
    name,
  ]);
  // A racing session start may have created it between our check and create.
  if (r.code !== 0 && !/already exists/i.test(r.stderr)) {
    throw new ServiceError('network-create-failed', `could not create service network ${name}`, r.stderr.trim().slice(0, 600));
  }
  onLog?.(`[services] network ${name} ready\n`);
}

function imagePresent(image: string): boolean {
  return dockerSync(['image', 'inspect', image]).code === 0;
}

async function ensureImage(spec: ServiceSpec, onLog?: (s: string) => void): Promise<void> {
  if (imagePresent(spec.image)) return;
  onLog?.(`[services] pulling ${spec.image} for service "${spec.name}" (bounded ${Math.round(PULL_TIMEOUT_MS / 1000)}s)…\n`);
  const r = await dockerAsync(['pull', spec.image], PULL_TIMEOUT_MS, (s) => onLog?.(`[services] ${s}`));
  if (r.timedOut) {
    throw new ServiceError(
      'pull-timeout',
      `service "${spec.name}": pulling image ${spec.image} exceeded ${Math.round(PULL_TIMEOUT_MS / 1000)}s and was aborted — the registry is unreachable or the image does not exist. The session start was NOT allowed to hang on it.`,
      r.stderr.trim().slice(-600),
    );
  }
  if (r.code !== 0) {
    throw new ServiceError(
      'pull-failed',
      `service "${spec.name}": could not pull image ${spec.image}`,
      (r.stderr || r.stdout).trim().slice(-600),
    );
  }
}

function ensureVolume(projectId: string, spec: ServiceSpec): string {
  const vol = volumeName(projectId, spec.name);
  /*
   * FEAT-112 defect 1 (second half): `docker volume create` SUCCEEDS on an
   * existing name and ignores a label mismatch, so — independently of the naming
   * scheme — a volume must never be silently ADOPTED. If one already exists under
   * this name, only reuse it when its labels confirm it is ours (this project,
   * this service); otherwise refuse loudly rather than serve another owner's data.
   * The tagged names above already make a cross-project name clash impossible; this
   * is defence in depth (e.g. a stray user-created volume, or a pre-tag leftover).
   */
  const insp = dockerSync([
    'volume', 'inspect', vol,
    '--format', '{{index .Labels "claude-station.project"}}\t{{index .Labels "claude-station.service"}}',
  ]);
  if (insp.code === 0) {
    const [owner = '', ownerSvc = ''] = insp.stdout.trim().split('\t');
    if (owner === projectId && ownerSvc === spec.name) return vol; // ours — reuse its data
    throw new ServiceError(
      'volume-conflict',
      `service "${spec.name}": a Docker volume named ${vol} already exists but its labels say it belongs to project "${owner || '(none)'}" service "${ownerSvc || '(none)'}" — refusing to adopt another owner's data`,
      insp.stdout.trim().slice(0, 300),
    );
  }
  const r = dockerSync([
    'volume', 'create',
    '--label', 'claude-station=1',
    '--label', `claude-station.project=${projectId}`,
    '--label', 'claude-station.role=service',
    '--label', `claude-station.service=${spec.name}`,
    vol,
  ]);
  if (r.code !== 0) {
    throw new ServiceError('volume-create-failed', `service "${spec.name}": could not create data volume ${vol}`, r.stderr.trim().slice(0, 600));
  }
  return vol;
}

async function createAndStartService(project: Project, spec: ServiceSpec, onLog?: (s: string) => void): Promise<void> {
  const projectId = project.id;
  const name = serviceContainerName(projectId, spec.name);
  await ensureImage(spec, onLog);

  const args = [
    'create',
    '--name', name,
    '--label', 'claude-station=1',
    '--label', `claude-station.project=${projectId}`,
    '--label', 'claude-station.role=service',
    '--label', `claude-station.service=${spec.name}`,
    '--label', `claude-station.service-hash=${specHash(spec)}`,
    '--network', networkName(projectId),
    '--network-alias', spec.name,
    // Sidecars must never keep themselves alive past a teardown; we own restart.
    '--restart', 'no',
  ];
  for (const e of spec.env ?? []) args.push('-e', `${e.key}=${e.value}`);
  if (spec.dataPath) {
    const vol = ensureVolume(projectId, spec);
    args.push('-v', `${vol}:${spec.dataPath}`);
  }
  args.push(spec.image);

  const created = dockerSync(args, 60_000);
  if (created.code !== 0) {
    /*
     * FEAT-112 defect 3: two session starts racing `ensureServices` on one
     * project both see no container and both `docker create` the same name; the
     * loser gets a "name already in use" and used to spuriously fail the session.
     * The name is unique to THIS (project, service) pair (tagged above), so a
     * name clash can only be our own concurrent starter having already created it.
     * Tolerate it exactly as the network-create path tolerates "already exists":
     * fall through to start + assert-running on the peer's container.
     */
    const out = (created.stderr || created.stdout);
    if (!/already in use|already exists|Conflict/i.test(out)) {
      throw new ServiceError('create-failed', `service "${spec.name}": could not create container from ${spec.image}`, out.trim().slice(0, 800));
    }
    onLog?.(`[services] service "${spec.name}" already created by a concurrent session start — reusing it\n`);
  }
  const started = dockerSync(['start', name], 60_000);
  if (started.code !== 0) {
    throw new ServiceError('start-failed', `service "${spec.name}": created but would not start`, (started.stderr || started.stdout).trim().slice(0, 800));
  }
  assertServiceRunning(name, spec);
  onLog?.(`[services] service "${spec.name}" (${spec.image}) running as ${name}, reachable at hostname "${spec.name}"\n`);
}

/**
 * Read the live state back after a start — `docker start` exits 0 for a container
 * that dies immediately, so the exit code alone is not proof of a running service
 * (FEAT-112 defect 2). THROWS `not-running` (with the tail of the container's own
 * logs) if the container is not actually running, keeping the refusal loud and
 * sticky across repeated session starts rather than passing silently the 2nd time.
 */
function assertServiceRunning(name: string, spec: ServiceSpec): void {
  const insp = dockerSync(['inspect', name, '--format', '{{.State.Running}}']);
  if (insp.stdout.trim() === 'true') return;
  const logs = dockerSync(['logs', '--tail', '40', name]);
  throw new ServiceError(
    'not-running',
    `service "${spec.name}" exited immediately after start — the image ${spec.image} likely needs configuration (e.g. a required env var)`,
    (logs.stdout + logs.stderr).trim().slice(-1000),
  );
}

/**
 * Reconcile the project's running services to its declared spec. Creates the
 * network on first need, (re)creates drifted/absent service containers, restarts
 * stopped ones, and removes containers whose row was deleted. If no services are
 * declared it reconciles to empty and removes the network. THROWS `ServiceError`
 * loudly if any declared service cannot be brought up.
 */
export async function ensureServices(project: Project, onLog?: (s: string) => void): Promise<void> {
  const projectId = project.id;
  const specs = servicesOf(project);
  const wanted = new Map(specs.map((s) => [s.name, s]));
  const existing = listProjectServiceContainers(projectId);

  // Remove any container whose service was deleted, or whose config drifted.
  for (const c of existing) {
    const spec = wanted.get(c.service);
    if (!spec || c.hash !== specHash(spec)) {
      removeContainerForce(c.name);
    }
  }

  if (specs.length === 0) {
    // Nothing wanted — tear the network down too so a project reverts cleanly.
    removeNetwork(projectId, onLog);
    return;
  }

  ensureNetwork(projectId, onLog);

  const stillThere = new Map(listProjectServiceContainers(projectId).map((c) => [c.service, c]));
  for (const spec of specs) {
    const live = stillThere.get(spec.name);
    if (live && live.hash === specHash(spec)) {
      if (!live.running) {
        const r = dockerSync(['start', live.name], 60_000);
        if (r.code !== 0) throw new ServiceError('start-failed', `service "${spec.name}": could not restart existing container`, r.stderr.trim().slice(0, 600));
        // FEAT-112 defect 2: `docker start` exits 0 even when the container dies
        // immediately, so re-check state here too — otherwise a service that
        // exited would pass silently on the next session start.
        assertServiceRunning(live.name, spec);
      }
      continue;
    }
    await createAndStartService(project, spec, onLog);
  }
}

/**
 * Join the session container to the project's service network so its code can
 * resolve service hostnames. Idempotent — a second connect is a no-op. Safe to
 * call every session start. No-op when the project declares no services.
 */
export function connectSessionToServices(projectId: string, onLog?: (s: string) => void): void {
  if (!networkExists(projectId)) return; // no services declared
  const sess = sessionContainerName(projectId);
  const r = dockerSync(['network', 'connect', networkName(projectId), sess]);
  if (r.code === 0) {
    onLog?.(`[services] session container joined ${networkName(projectId)}\n`);
    return;
  }
  if (/already exists in network|already connected/i.test(r.stderr)) return; // idempotent
  throw new ServiceError('connect-failed', `could not join the session container to the service network`, r.stderr.trim().slice(0, 600));
}

/* -------------------------------------------------------------- teardown */

function removeContainerForce(name: string): void {
  const r = dockerSync(['rm', '-f', name]);
  if (r.code !== 0 && !/No such container/i.test(r.stderr)) {
    // Teardown must be best-effort and never throw into a stop/delete path; the
    // orphan sweep is the backstop. Surface via return value where callers care.
  }
}

function removeNetwork(projectId: string, onLog?: (s: string) => void): void {
  if (!networkExists(projectId)) return;
  const net = networkName(projectId);
  // A `network rm` fails while any endpoint is still attached, so force-disconnect
  // the session container first (service containers are removed before this call).
  dockerSync(['network', 'disconnect', '-f', net, sessionContainerName(projectId)]);
  const r = dockerSync(['network', 'rm', net]);
  if (r.code === 0) onLog?.(`[services] removed network ${net}\n`);
}

/**
 * Tear down all of a project's services. Called wherever the session container
 * itself is torn down. `removeVolumes` is true only when the data should go too
 * (project delete / orphan reap / explicit purge) — a Stop/Remove keeps volumes
 * so a service's data survives to the next session.
 */
export function teardownServices(projectId: string, opts: { removeVolumes?: boolean } = {}, onLog?: (s: string) => void): void {
  for (const c of listProjectServiceContainers(projectId)) removeContainerForce(c.name);
  removeNetwork(projectId, onLog);
  if (opts.removeVolumes) removeProjectVolumes(projectId, onLog);
}

function listProjectVolumes(projectId: string): string[] {
  const r = dockerSync([
    'volume', 'ls',
    '--filter', 'label=claude-station.role=service',
    '--filter', `label=claude-station.project=${projectId}`,
    '--format', '{{.Name}}',
  ]);
  if (r.code !== 0) return [];
  return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

function removeProjectVolumes(projectId: string, onLog?: (s: string) => void): void {
  for (const v of listProjectVolumes(projectId)) {
    const r = dockerSync(['volume', 'rm', v]);
    if (r.code === 0) onLog?.(`[services] removed volume ${v}\n`);
  }
}

/* ------------------------------------------------------------- orphans */

interface OwnedInfra {
  networks: string[];
  volumes: string[];
}

/** All service networks/volumes Claude Station owns, keyed by project id. */
function listOwnedInfra(): Map<string, OwnedInfra> {
  const out = new Map<string, OwnedInfra>();
  const nets = dockerSync(['network', 'ls', '--filter', 'label=claude-station.role=network', '--format', '{{.Name}}\t{{.Label "claude-station.project"}}']);
  for (const l of nets.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
    const [name = '', pid = ''] = l.split('\t');
    if (!pid) continue;
    const e = out.get(pid) ?? { networks: [], volumes: [] };
    e.networks.push(name);
    out.set(pid, e);
  }
  const vols = dockerSync(['volume', 'ls', '--filter', 'label=claude-station.role=service', '--format', '{{.Name}}\t{{.Label "claude-station.project"}}']);
  for (const l of vols.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
    const [name = '', pid = ''] = l.split('\t');
    if (!pid) continue;
    const e = out.get(pid) ?? { networks: [], volumes: [] };
    e.volumes.push(name);
    out.set(pid, e);
  }
  return out;
}

/**
 * Remove service networks and volumes whose project is no longer in the registry
 * — the infra analogue of `findOrphanContainers`. Orphan SERVICE CONTAINERS are
 * already swept by the container orphan route (they carry `claude-station=1`), so
 * this only needs to reap the network + volumes they leave behind.
 */
export function reapOrphanServiceInfra(knownProjectIds: Set<string>): { networks: string[]; volumes: string[] } {
  const removed = { networks: [] as string[], volumes: [] as string[] };
  for (const [pid, infra] of listOwnedInfra()) {
    if (knownProjectIds.has(pid)) continue;
    // Remove any lingering service containers on this orphan first so the network
    // has no endpoints, then the network and its volumes.
    for (const c of listProjectServiceContainers(pid)) removeContainerForce(c.name);
    for (const net of infra.networks) {
      if (dockerSync(['network', 'rm', net]).code === 0) removed.networks.push(net);
    }
    for (const vol of infra.volumes) {
      if (dockerSync(['volume', 'rm', vol]).code === 0) removed.volumes.push(vol);
    }
  }
  return removed;
}
