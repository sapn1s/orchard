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
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { projectRoot, ensureDir } from '../lib/paths.ts';
import type { Project, Mount, ContainerSettings } from './registry.ts';
import { containerSettingsOf, browserSettingsOf, toolSettingsOf } from './registry.ts';
// FEAT-145 step 6 — the account layer. `applyGlobalDefaults` is the shared
// machine→project merge (agent-bridge's `pickOverridable` is the other caller);
// `resolveAccountDir` is the sole id→dir authority (ARCH-010) and
// `resolveLaunchAccountDir` the sole "may a launch use this account" gate.
import { applyGlobalDefaults } from './global-settings.ts';
import { AccountError, DEFAULT_ACCOUNT_ID, resolveAccountDir, resolveLaunchAccountDir } from './claude-accounts.ts';
import { provisionHash, serenaPin, type ProvisionState } from './provisioning.ts';
import { available as browserAvailable, browserBinds, containerEnv as browserContainerEnv, socketPath as browserSocketPath, stateHome as browserStateHome, CONTAINER_MCP_DIR } from './browser.ts';
import { dispatchBinds, dispatchSocketPath, dispatchStateHome, CONTAINER_DISPATCH_DIR, CONTAINER_DISPATCH_SOCKET_DIR } from './dispatch-broker.ts';

/* --------------------------------------------------------------- constants */

/** Path the CLI is invoked at INSIDE the container. Must match the Dockerfile. */
export const CONTAINER_CLAUDE_BIN = '/home/claude/.local/bin/claude';
/** $HOME inside the container. Must match the Dockerfile's `claude` user. */
export const CONTAINER_HOME = '/home/claude';
/** Parent of every project's container working dir. */
export const CONTAINER_WORKSPACE = '/workspace';

const DOCKER = process.env.CLAUDE_STATION_DOCKER ?? 'docker';
const IMAGE_REPO = 'claude-station-base';
const NAME_PREFIX = 'claude-station-';
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
  const r = spawnSync(DOCKER, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  if (r.error) {
    const e = r.error as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      throw new ContainerError('docker-missing', `\`${DOCKER}\` is not on PATH — Docker is required for isolation "container".`);
    }
    throw new ContainerError('docker-failed', `docker ${args[0]} failed: ${e.message}`);
  }
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function dockerAsync(args: string[], timeoutMs: number, onLine?: (s: string) => void): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(DOCKER, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
          ? new ContainerError('docker-missing', `\`${DOCKER}\` is not on PATH — Docker is required for isolation "container".`)
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

/* ------------------------------------------------------------------- naming */

export function containerName(projectId: string): string {
  return `${NAME_PREFIX}${projectId}`;
}

/**
 * The container working dir for a project. DISTINCT PER PROJECT ON PURPOSE:
 * Claude encodes cwd into the session-store dir name, so every container using
 * a bare `/workspace` collapses into one host `~/.claude/projects/-workspace`
 * and silently merges unrelated projects' histories.
 */
export function containerWorkdir(projectId: string): string {
  return `${CONTAINER_WORKSPACE}/${projectId}`;
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
export function containerHistoryDir(project: Project): string {
  return path.join(os.homedir(), '.claude', 'projects', encodeCwdForStore(containerWorkdir(project.id)));
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
  const custom = containerSettingsOf(project).image;
  if (custom && custom.trim()) return custom.trim();
  return `${IMAGE_REPO}:${stationImageTag()}`;
}

function stationImageTag(): string {
  return `u${os.userInfo().uid}-g${os.userInfo().gid}-${provisionHash()}`;
}

/**
 * Tags this project generates or has generated. Both the current hashed shape
 * and the pre-BUG-107 unhashed one — the legacy tag has to be reclaimable or
 * the very first upgrade strands a 1.1 GB image forever.
 */
const STATION_TAG_RE = /^u\d+-g\d+(-[0-9a-f]{12})?$/;

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
  const workdir = containerWorkdir(project.id);
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
    {
      hostPath: path.join(os.homedir(), '.claude', 'projects', encodeCwdForStore(workdir)),
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
    if (cp === CONTAINER_WORKSPACE || cp === '/' || cp === CONTAINER_HOME) {
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
}

interface Inspected {
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
  };
}

/**
 * Config drift: the live container's binds / workdir / image / hardening no
 * longer match what the registry says. Serving a stale container here is the
 * exact failure this catches — the user edits mounts, sees "running", and gets
 * the old mounts for the rest of the day.
 */
function driftReasons(project: Project, live: Inspected): string[] {
  const out: string[] = [];
  const wantImage = imageNameFor(project);
  if (live.image !== wantImage) {
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
  const wantWd = containerWorkdir(project.id);
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
  if (!live.init) out.push('Init is not enabled');
  const wantGroups = desiredGroupAdd(project).slice().sort();
  const gotGroups = live.groupAdd.slice().sort();
  if (wantGroups.join(',') !== gotGroups.join(',')) out.push(`group-add [${gotGroups}] != [${wantGroups}]`);
  // Docker normalises `--cap-drop SYS_ADMIN` to "CAP_SYS_ADMIN" on read-back.
  // Comparing raw would flag every container as drifted forever and recreate it
  // on every ensure — which is exactly what the first live run did.
  const liveCaps = new Set(live.capDrop.map((c) => c.replace(/^CAP_/, '').toUpperCase()));
  for (const cap of CAP_DROP) if (!liveCaps.has(cap)) out.push(`CapDrop missing ${cap}`);
  if (!live.securityOpt.some((s) => s.includes('no-new-privileges'))) out.push('no-new-privileges missing');
  return out;
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
    r = dockerSync(['exec', containerName(project.id), 'stat', '-c', '%i %n', ...files.map((f) => f.containerPath)], 10_000);
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
    }
  } catch (err) {
    status = { state: 'error', containerName: name, error: (err as Error).message };
  }
  statusCache.set(project.id, { at: Date.now(), status });
  return status;
}

function invalidate(projectId: string): void {
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
 * Three guards, because deleting images is not the kind of thing to be
 * approximate about:
 *  1. only the repo we own (`claude-station-base`) and only tags matching the
 *     shape WE generate — `u{uid}-g{gid}[-{hash}]`. A user's own image, or a
 *     project's custom `settings.container.image`, cannot match by accident;
 *  2. never `--force`, so docker itself refuses while ANY container (running or
 *     merely stopped) still references the image. Another project mid-upgrade,
 *     or a stopped container the user means to restart, wins over tidiness;
 *  3. never the tag we were just asked to keep.
 * Failures are collected, never thrown: cleanup must not be able to fail a build.
 */
export function pruneSupersededImages(keep: string): { removed: string[]; kept: string[] } {
  const removed: string[] = [];
  const kept: string[] = [];
  let listed: RunResult;
  try {
    listed = dockerSync(['images', `${IMAGE_REPO}`, '--format', '{{.Repository}}:{{.Tag}}'], 20_000);
  } catch {
    return { removed, kept };
  }
  if (listed.code !== 0) return { removed, kept };
  for (const ref of listed.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
    const [repo, tag = ''] = [ref.slice(0, ref.lastIndexOf(':')), ref.slice(ref.lastIndexOf(':') + 1)];
    if (repo !== IMAGE_REPO || !STATION_TAG_RE.test(tag) || ref === keep) { kept.push(ref); continue; }
    let r: RunResult;
    try { r = dockerSync(['image', 'rm', ref], 60_000); } catch { kept.push(ref); continue; }
    if (r.code === 0) removed.push(ref); else kept.push(ref);
  }
  return { removed, kept };
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
  provisionHash: string;
  imageProvisionHash: string | null;
  detail: string;
} {
  const image = imageNameFor(project);
  const custom = !!containerSettingsOf(project).image?.trim();
  const pin = serenaPin();
  const want = provisionHash();
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
  if (custom) {
    return { state: exists ? 'provisioned' : 'missing', image, custom: true, wantedSerenaVersion: pin.version,
      imageSerenaVersion: imageVer, provisionHash: want, imageProvisionHash: imageHash,
      detail: `custom image "${image}" — Claude Station does not build or provision it; its tooling is yours to manage.` };
  }
  if (!exists) {
    return { state: 'missing', image, custom: false, wantedSerenaVersion: pin.version, imageSerenaVersion: null,
      provisionHash: want, imageProvisionHash: null,
      detail: `image ${image} has not been built yet; the next session (or Rebuild) builds it.` };
  }
  if (imageHash !== want) {
    return { state: 'stale', image, custom: false, wantedSerenaVersion: pin.version, imageSerenaVersion: imageVer,
      provisionHash: want, imageProvisionHash: imageHash,
      detail: `the built image was made from a different definition (${imageHash ?? 'unlabelled'} vs ${want}); it will be rebuilt on the next session.` };
  }
  return { state: 'provisioned', image, custom: false, wantedSerenaVersion: pin.version, imageSerenaVersion: imageVer,
    provisionHash: want, imageProvisionHash: imageHash,
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
  const gc = pruneSupersededImages(keep);
  if (gc.removed.length) onLog?.(`[container] reclaimed superseded image(s): ${gc.removed.join(', ')}\n`);
}

/**
 * Build the image if missing. Deduped by image name so ten projects starting at
 * once produce one build, not ten.
 */
export async function ensureImage(project: Project, opts: { force?: boolean; onLog?: (s: string) => void } = {}): Promise<string> {
  const image = imageNameFor(project);
  const custom = containerSettingsOf(project).image;
  if (custom && custom.trim()) {
    // A user-supplied image is not ours to build.
    if (!imageExists(image)) {
      throw new ContainerError('image-missing', `image "${image}" is not present locally and Claude Station will not build a custom image for you. \`docker pull\` it first, or clear settings.container.image.`);
    }
    return image;
  }
  if (!opts.force && imageExists(image)) return image;
  const existing = imageBuilds.get(image);
  if (existing) return existing;
  const ctx = path.join(projectRoot(), 'src', 'server', 'container');
  if (!fs.existsSync(path.join(ctx, 'Dockerfile'))) {
    throw new ContainerError('dockerfile-missing', `container Dockerfile not found at ${ctx}/Dockerfile`);
  }
  const { uid, gid } = hostUidGid();
  const p = (async () => {
    const args = [
      'build',
      '--build-arg', `HOST_UID=${uid}`,
      '--build-arg', `HOST_GID=${gid}`,
      // BUG-107 — stamp the artifact with what it was made from. The tag already
      // carries the hash, but a label is machine-readable without parsing a tag
      // and survives a re-tag, so "which serena is in this image?" is answerable
      // by inspecting the image rather than by trusting its name.
      '--label', 'claude-station.image=1',
      '--label', `claude-station.provision-hash=${provisionHash()}`,
      '--label', `claude-station.serena-version=${serenaPin().version}`,
      '--label', `claude-station.serena-package=${serenaPin().package}`,
      '-t', image,
      '-f', path.join(ctx, 'Dockerfile'),
      ctx,
    ];
    const r = await dockerAsync(args, 20 * 60_000, opts.onLog);
    if (r.code !== 0) {
      throw new ContainerError('build-failed', `image build failed for ${image}`, (r.stderr || r.stdout).trim().slice(-3000));
    }
    if (!imageExists(image)) {
      // Distrust the exit code: assert the artifact actually exists.
      throw new ContainerError('build-failed', `docker build reported success but image ${image} is not present`);
    }
    /*
     * Do NOT prune here. At this instant the superseded image is still the one
     * the live container runs, so docker refuses every removal and the sweep
     * reclaims nothing — measured, not assumed (BUG-107 verification F1 failed
     * exactly this way). The old artifact only becomes free once the container
     * has been recreated on the new one, so the sweep is armed here and fired by
     * `doEnsure` after the container is confirmed running.
     */
    pruneAfterRecreate = image;
    return image;
  })().finally(() => imageBuilds.delete(image));
  imageBuilds.set(image, p);
  return p;
}

/* --------------------------------------------------------------- container */

const ensures = new Map<string, Promise<ContainerStatus>>();

/**
 * Create+start the container if needed; recreate it if the live config has
 * drifted from the registry. Concurrent calls for the same project share one
 * in-flight operation.
 */
export function ensureContainer(project: Project, opts: { onLog?: (s: string) => void } = {}): Promise<ContainerStatus> {
  const inflight = ensures.get(project.id);
  if (inflight) return inflight;
  const p = doEnsure(project, opts).finally(() => {
    ensures.delete(project.id);
    building.delete(project.id);
    invalidate(project.id);
    // The container is settled now (recreated, or the attempt is over), so any
    // image a build in this call superseded is finally free to reclaim.
    try { flushPrune(opts.onLog); } catch { /* cleanup must never fail an ensure */ }
  });
  ensures.set(project.id, p);
  return p;
}

async function doEnsure(project: Project, opts: { onLog?: (s: string) => void }): Promise<ContainerStatus> {
  if (project.isolation !== 'container') {
    throw new ContainerError('not-container', `project ${project.id} has isolation "${project.isolation}", not "container"`);
  }
  const avail = dockerAvailable();
  if (!avail.ok) throw new ContainerError('docker-unavailable', avail.message);

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
  for (const m of project.settings.mounts ?? []) {
    const hp = path.resolve(expandHome(m.hostPath));
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

  const image = await ensureImage(project, { onLog: opts.onLog });
  const name = containerName(project.id);

  // Pre-create the host-side session-history dir so the bind mount is owned by
  // the host user; if docker creates it, it lands root-owned and the container
  // silently cannot write history.
  for (const b of desiredBinds(project)) {
    if (b.why === 'session history') ensureDir(b.hostPath);
  }

  const live = inspect(name);
  if (live) {
    const reasons = driftReasons(project, live);
    if (reasons.length) {
      opts.onLog?.(`[container] recreating ${name}: ${reasons.join('; ')}\n`);
      await removeContainer(name);
    } else if (live.running) {
      invalidate(project.id);
      return statusOf(project);
    } else {
      const r = dockerSync(['start', name], 60_000);
      if (r.code !== 0) throw new ContainerError('start-failed', `could not start ${name}`, (r.stderr || r.stdout).trim().slice(0, 800));
      invalidate(project.id);
      return assertRunning(project);
    }
  }

  const cs = containerSettingsOf(project);
  const args = [
    'create',
    '--name', name,
    '--init',
    '--security-opt', 'no-new-privileges:true',
    '--memory', `${cs.memoryMb}m`,
    '--pids-limit', String(cs.pidsLimit),
    '--workdir', containerWorkdir(project.id),
    '--label', 'claude-station=1',
    '--label', `claude-station.project=${project.id}`,
    '--add-host', 'host.docker.internal:host-gateway',
  ];
  for (const cap of CAP_DROP) args.push('--cap-drop', cap);
  for (const g of desiredGroupAdd(project)) args.push('--group-add', g);
  for (const b of desiredBinds(project)) args.push('-v', bindString(b));
  args.push(image);

  const created = dockerSync(args, 60_000);
  if (created.code !== 0) {
    throw new ContainerError('create-failed', `could not create ${name}`, (created.stderr || created.stdout).trim().slice(0, 1200));
  }
  const started = dockerSync(['start', name], 60_000);
  if (started.code !== 0) {
    throw new ContainerError('start-failed', `created ${name} but it would not start`, (started.stderr || started.stdout).trim().slice(0, 1200));
  }
  invalidate(project.id);
  return assertRunning(project);
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
  const r = await dockerAsync(['rm', '-f', name], 60_000);
  if (r.code !== 0 && !/No such container/i.test(r.stderr)) {
    throw new ContainerError('remove-failed', `could not remove ${name}`, (r.stderr || r.stdout).trim().slice(0, 800));
  }
}

export async function stopContainer(project: Project): Promise<ContainerStatus> {
  const name = containerName(project.id);
  const r = await dockerAsync(['stop', '-t', '10', name], 90_000);
  if (r.code !== 0 && !/No such container/i.test(r.stderr)) {
    throw new ContainerError('stop-failed', `could not stop ${name}`, (r.stderr || r.stdout).trim().slice(0, 800));
  }
  invalidate(project.id);
  return statusOf(project);
}

export async function removeProjectContainer(project: Project): Promise<ContainerStatus> {
  await removeContainer(containerName(project.id));
  invalidate(project.id);
  return statusOf(project);
}

/** Rebuild the image from scratch and recreate the container on top of it. */
export async function rebuildContainer(project: Project, opts: { onLog?: (s: string) => void } = {}): Promise<ContainerStatus> {
  building.add(project.id);
  invalidate(project.id);
  try {
    await removeContainer(containerName(project.id));
    await ensureImage(project, { force: true, onLog: opts.onLog });
  } finally {
    building.delete(project.id);
    invalidate(project.id);
  }
  return ensureContainer(project, opts);
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
  const r = dockerSync(['exec', containerName(project.id), 'sh', '-c',
    'echo C:$(cat /sys/fs/cgroup/memory.current 2>/dev/null); ' +
    'echo M:$(cat /sys/fs/cgroup/memory.max 2>/dev/null); ' +
    "echo K:$(awk '/^oom_kill /{print $2}' /sys/fs/cgroup/memory.events 2>/dev/null)"], 5_000);
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
export const EXEC_TAG_VAR = 'CLAUDE_STATION_EXEC';

/**
 * Build the `docker exec` argv that runs the CLI inside the project's
 * container. Split out from `execInContainer` so tests can assert the argv
 * without spawning anything.
 */
export function execArgv(project: Project, spec: ExecSpec): string[] {
  const argv = ['exec', '-i', '--workdir', containerWorkdir(project.id), '--user', `${hostUidGid().uid}:${hostUidGid().gid}`];
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
  const r = dockerSync(['exec', containerName(project.id), 'sh', '-c', script], 15_000);
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
  const r = dockerSync(['exec', containerName(project.id), 'sh', '-c', script], 15_000);
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
  const child = spawn(DOCKER, execArgv(project, spec), { stdio: ['pipe', 'pipe', 'pipe'] });
  if (!child.stdin || !child.stdout) {
    // Cannot happen with stdio 'pipe', but the SDK's SpawnedProcess contract
    // requires non-null streams and a null here would fail far from the cause.
    child.kill('SIGKILL');
    throw new ContainerError('exec-no-stdio', `docker exec for ${containerName(project.id)} produced no stdio pipes`);
  }
  return child as ChildProcess & { stdin: Writable; stdout: Readable };
}

/* ------------------------------------------------------------------ sweep */

/** Names of every container Claude Station owns, live or stopped. */
export function listStationContainers(): { name: string; state: string; image: string; projectId: string }[] {
  const r = dockerSync(['ps', '-a', '--filter', 'label=claude-station=1', '--format', '{{.Names}}\t{{.State}}\t{{.Image}}\t{{.Label "claude-station.project"}}']);
  if (r.code !== 0) return [];
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name = '', state = '', image = '', projectId = ''] = l.split('\t');
      return { name, state, image, projectId };
    });
}

/**
 * Containers Claude Station owns whose project is no longer in the registry.
 * These used to be unreachable: every /container route 404s on an unknown
 * project, so an orphan kept running with the OAuth credentials bind-mounted rw
 * and no API could stop it.
 */
export function findOrphanContainers(knownProjectIds: Set<string>): { name: string; state: string; image: string; projectId: string }[] {
  return listStationContainers().filter((c) => c.projectId && !knownProjectIds.has(c.projectId));
}

/** Force-remove an orphan by container name. Only ever called for a name we own. */
export function removeContainerByName(name: string): { name: string; removed: boolean; detail: string } {
  if (!name.startsWith(NAME_PREFIX)) {
    throw new ContainerError('not-ours', `refusing to remove ${name}: not a Claude Station container`);
  }
  const r = dockerSync(['rm', '-f', name]);
  return { name, removed: r.code === 0, detail: (r.stderr || r.stdout).trim().slice(0, 300) };
}

export type { ContainerSettings };
