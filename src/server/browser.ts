/**
 * Per-project stealth browser, attached to sessions as an MCP integration.
 *
 * Thin wrapper over the adapter's CLI at `stealth-browser-mcp`. Everything this
 * file knows about the adapter was read off its actual source, not a spec:
 *
 *   node src/cli.mjs start <project> [--idle-ms N]   idempotent; exit 0 = socket answers
 *   node src/cli.mjs stop <project>                  exit 1 + "ORPHANS REMAIN" if Chrome survived
 *   node src/cli.mjs status [project]                prints a JSON ARRAY (always exit 0)
 *   node src/cli.mjs reap                            kills daemons whose socket is dead
 *   node src/cli.mjs mcp-config <project>            prints {mcpServers:{…}}
 *
 * WHY THE BROWSER RUNS ON THE HOST
 * --------------------------------
 * Chrome inside a container leaks the very fingerprints these sites detect, so
 * the daemon and Chrome always live on the host. A containerised session reaches
 * it through ONE bind-mounted unix socket. The daemon binds no TCP port at all,
 * so there is no network path to a browser even from a container on the host
 * network — and `--network none` containers still work.
 *
 * ISOLATION INVARIANT
 * -------------------
 * Every path here is derived from `project.id` alone and is re-derived at each
 * call — never passed in from a request, never cached across projects. A
 * project id that is not a safe path segment is rejected before it can reach
 * `path.join`, so `../` cannot walk from project A's state dir into B's.
 * `browserBinds()` is the single source of the container mounts, and the
 * container manager already treats any bind difference as drift.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Project } from './registry.ts';

/** Container-side paths. Fixed, and refused as user mount targets — see validateMounts. */
export const CONTAINER_SOCKET = '/sb/browser.sock';
export const CONTAINER_MCP_DIR = '/opt/sbmcp';
export const CONTAINER_MCP_STDIO = `${CONTAINER_MCP_DIR}/mcp-stdio.mjs`;
/** The MCP server name the adapter uses; tools arrive as `mcp__stealth-browser__*`. */
export const MCP_SERVER_NAME = 'stealth-browser';

export class BrowserError extends Error {
  readonly code: string;
  readonly detail: string;
  constructor(code: string, message: string, detail = '') {
    super(message);
    this.name = 'BrowserError';
    this.code = code;
    this.detail = detail;
  }
}

/** The environment variable that points at the adapter checkout. */
export const REPO_DIR_ENV = 'CLAUDE_STATION_SBMCP_REPO';

/**
 * The message every unconfigured path reports. The adapter is a SEPARATE
 * project that Orchard neither bundles nor publishes, so there is no location
 * it could sensibly default to: any baked-in path is one machine's layout
 * wearing the costume of a default. Unconfigured therefore means the feature
 * is off with a message that says exactly what to set — not a silent lookup in
 * a directory that happens to exist on the author's machine (FEAT-049).
 */
export const REPO_UNSET_MESSAGE =
  `no browser adapter configured — set ${REPO_DIR_ENV} to a checkout of the adapter project. `
  + 'Orchard does not bundle it and does not guess where it lives (README → Optional integrations).';

/**
 * The adapter checkout, or `null` when unconfigured. Callers that need a path
 * must go through `available()` first; the path helpers below throw the same
 * message rather than fabricating a directory.
 */
export function repoDir(): string | null {
  const env = process.env[REPO_DIR_ENV];
  return env && env.trim() ? path.resolve(env) : null;
}

function requireRepoDir(): string {
  const dir = repoDir();
  if (dir === null) throw new BrowserError('adapter-not-configured', REPO_UNSET_MESSAGE);
  return dir;
}

export function stateHome(): string {
  const env = process.env.SBMCP_STATE_DIR;
  return env && env.trim() ? path.resolve(env) : path.join(os.homedir(), '.stealth-browser-mcp');
}

const cliPath = () => path.join(requireRepoDir(), 'src', 'cli.mjs');
export const mcpStdioPath = () => path.join(requireRepoDir(), 'src', 'mcp-stdio.mjs');
/** The adapter's tool table. Imported by its daemon; required for a complete checkout. */
export const toolsModulePath = () => path.join(requireRepoDir(), 'src', 'tools.mjs');
const packageJsonPath = () => path.join(requireRepoDir(), 'package.json');

/** Adapter capability version the station requires. Bump when the contract changes. */
export const REQUIRED_LAZY_START = 1;

export interface LazyCapability {
  ok: boolean;
  version: number | null;
  message: string;
}

/**
 * Does this adapter start Chrome LAZILY? (ARCH-007, option A.)
 *
 * Read off the adapter's `package.json`, on purpose: the whole defect this
 * gates is that asking about the browser used to be what created it. A probe
 * that ran the adapter — or worse, pinged its daemon — to find out would be the
 * same bug wearing a different hat. This costs one file read and starts nothing.
 *
 * The adapter's daemon reports the same number over its `capabilities` op once
 * it is serving; that is the runtime confirmation, not the gate.
 *
 * An adapter that cannot declare this is the older eager kind, which launches a
 * real headful Chrome window at daemon boot. The station refuses to attach it
 * rather than silently popping a browser the user did not ask for.
 */
export function lazyStartCapability(): LazyCapability {
  const pkg = packageJsonPath();
  let raw: string;
  try {
    raw = fs.readFileSync(pkg, 'utf8');
  } catch {
    return { ok: false, version: null, message: `stealth-browser-mcp has no readable package.json at ${pkg}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, version: null, message: `stealth-browser-mcp package.json at ${pkg} is not valid JSON` };
  }
  const declared = (parsed as { sbmcp?: { capabilities?: { lazyStart?: unknown } } })?.sbmcp?.capabilities?.lazyStart;
  if (typeof declared !== 'number' || !Number.isInteger(declared) || declared < 1) {
    return {
      ok: false,
      version: null,
      message:
        `the browser adapter at ${path.dirname(pkg)} does not declare lazy browser startup ` +
        `(package.json needs sbmcp.capabilities.lazyStart >= ${REQUIRED_LAZY_START}). ` +
        'That adapter launches a Chrome window the moment a session starts, whether or not anything uses it, ' +
        'so Orchard will not attach it. Update the adapter.',
    };
  }
  if (declared < REQUIRED_LAZY_START) {
    return {
      ok: false,
      version: declared,
      message:
        `the browser adapter at ${path.dirname(pkg)} declares lazyStart=${declared} but this station needs ` +
        `at least ${REQUIRED_LAZY_START}. Update the adapter.`,
    };
  }
  return { ok: true, version: declared, message: `lazyStart=${declared}` };
}

/**
 * The adapter's project id. Claude Station ids are already slugified to
 * `[a-z0-9-]`, but this is the boundary where an id becomes a filesystem path,
 * so it is checked here rather than assumed.
 */
export function sbmcpProjectId(project: Project): string {
  const id = project.id;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id.includes('..')) {
    throw new BrowserError('bad-project-id', `project id ${JSON.stringify(id)} is not usable as a browser state directory name`);
  }
  return id;
}

export function socketPath(project: Project): string {
  return path.join(stateHome(), 'projects', sbmcpProjectId(project), 'browser.sock');
}

export function profileDir(project: Project): string {
  return path.join(stateHome(), 'projects', sbmcpProjectId(project), 'chrome-data');
}

/** Is the adapter installed, runnable, and lazy? Checked before every operation. */
export function available(): { ok: boolean; message: string } {
  const repo = repoDir();
  if (repo === null) return { ok: false, message: REPO_UNSET_MESSAGE };
  if (!fs.existsSync(repo)) return { ok: false, message: `browser adapter not found at ${repo} (${REPO_DIR_ENV} points there)` };
  // tools.mjs joins the list because the daemon imports it — an adapter missing
  // it cannot serve a tool list at all.
  for (const f of [cliPath(), mcpStdioPath(), toolsModulePath()]) {
    if (!fs.existsSync(f)) return { ok: false, message: `stealth-browser-mcp is incomplete: ${f} is missing` };
  }
  if (!fs.existsSync(path.join(repo, 'node_modules'))) {
    return { ok: false, message: `stealth-browser-mcp at ${repo} has no node_modules — run \`npm install\` there` };
  }
  // ARCH-007: laziness is the capability's to own, so the station must be able
  // to tell a lazy adapter from an eager one BEFORE it attaches either.
  const lazy = lazyStartCapability();
  if (!lazy.ok) return { ok: false, message: lazy.message };
  return { ok: true, message: repo };
}

function assertAvailable(): void {
  const a = available();
  if (!a.ok) throw new BrowserError('adapter-missing', a.message);
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], timeoutMs: number): CliResult {
  assertAvailable();
  const r = spawnSync(process.execPath, [cliPath(), ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    // Inherit SBMCP_STATE_DIR so tests can redirect the whole state tree.
    env: { ...process.env },
  });
  if (r.error) {
    throw new BrowserError('cli-spawn-failed', `could not run sbmcp ${args.join(' ')}: ${r.error.message}`);
  }
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export interface BrowserStatus {
  project: string;
  /** Chrome itself is up. NOT the same as the daemon answering — see `daemon_running`. */
  running: boolean;
  /** The daemon's socket answers. True for an armed-but-unused browser. */
  daemon_running?: boolean;
  /** The daemon declared lazy start over the wire. */
  lazy_start?: boolean;
  /** A launch is in flight right now. */
  chrome_starting?: boolean;
  daemon_pid: number | null;
  daemon_alive: boolean;
  chrome_pid: number | null;
  chrome_procs_live: number;
  profile: string;
  socket: string;
  url: string | null;
  idle_for_ms: number | null;
}

/**
 * Live status. The CLI prints an ARRAY even for one project and always exits 0,
 * so "the browser is up" is read off the parsed object, never off the exit code.
 */
export function status(project: Project): BrowserStatus {
  const id = sbmcpProjectId(project);
  const r = runCli(['status', id], 30_000);
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout.trim() || '[]');
  } catch {
    // "no projects" is the CLI's plain-text answer for an empty state dir.
    if (/no projects/.test(r.stdout)) {
      return {
        project: id, running: false, daemon_pid: null, daemon_alive: false, chrome_pid: null,
        chrome_procs_live: 0, profile: profileDir(project), socket: socketPath(project), url: null, idle_for_ms: null,
      };
    }
    throw new BrowserError('bad-status-output', `sbmcp status ${id} produced unparseable output`, `${r.stdout}\n${r.stderr}`.slice(0, 800));
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const found = (arr as BrowserStatus[]).find((s) => s?.project === id);
  if (!found) {
    return {
      project: id, running: false, daemon_pid: null, daemon_alive: false, chrome_pid: null,
      chrome_procs_live: 0, profile: profileDir(project), socket: socketPath(project), url: null, idle_for_ms: null,
    };
  }
  return found;
}

/**
 * Bring the DAEMON up — not Chrome. Idempotent (the CLI returns "already running").
 *
 * Since ARCH-007 this returns as soon as the adapter's socket answers, and the
 * adapter has launched nothing. That is the useful unit of work: a container
 * bind-mounts the socket FILE and cannot create it itself, so the socket has to
 * exist before the container starts — but the browser does not. Chrome is
 * launched by the first page-dependent tool call, wherever that call comes from.
 *
 * The returned status therefore normally has `running: false` (no Chrome) and
 * `daemon_running: true`. Callers wanting "is there a browser" must read
 * `running`, never the mere fact that this call succeeded.
 *
 * NOTE: `--idle-ms` only takes effect on a real daemon start. A daemon already
 * running keeps the idle timeout it was started with; that is the adapter's
 * behaviour and is reported rather than worked around.
 */
export function start(project: Project, idleMs?: number): BrowserStatus {
  const id = sbmcpProjectId(project);
  const args = ['start', id];
  if (idleMs != null) args.push('--idle-ms', String(Math.floor(idleMs)));
  // Chrome cold-start on a fresh profile is slow; the CLI itself waits up to 90s.
  const r = runCli(args, 120_000);
  if (r.code !== 0) {
    throw new BrowserError('start-failed', `stealth browser failed to start for project ${id}`, `${r.stdout}\n${r.stderr}`.slice(0, 1500));
  }
  return status(project);
}

/**
 * Shut the browser down and PROVE it is gone.
 *
 * The CLI exits non-zero and prints `ORPHANS REMAIN: <pids>` when Chrome
 * survived, so both are checked — an orphaned Chrome holding a logged-in profile
 * is precisely what must not be reported as "stopped".
 */
export function stop(project: Project): { stopped: boolean; orphans: string | null; output: string } {
  const id = sbmcpProjectId(project);
  const r = runCli(['stop', id], 60_000);
  const combined = `${r.stdout}\n${r.stderr}`;
  const m = /ORPHANS REMAIN:\s*([0-9,\s]+)/.exec(combined);
  if (m || r.code !== 0) {
    throw new BrowserError(
      m ? 'orphans-remain' : 'stop-failed',
      m
        ? `stealth browser for ${id} reported ORPHANS REMAIN (pids ${m[1]!.trim()}) — Chrome is still running`
        : `sbmcp stop ${id} exited ${r.code}`,
      combined.slice(0, 1500),
    );
  }
  return { stopped: true, orphans: null, output: combined.trim().slice(0, 800) };
}

/** Sweep daemons whose socket is dead. Safe: only touches already-broken projects. */
export function reap(): { output: string; code: number } {
  const r = runCli(['reap'], 60_000);
  return { output: `${r.stdout}${r.stderr}`.trim().slice(0, 800), code: r.code };
}

/* ------------------------------------------------------------ MCP wiring */

export interface McpStdioServer {
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * The MCP server definition handed to the SDK for one session.
 *
 * Two shapes, because the MCP server is spawned by the CLI — which runs on the
 * host for `direct` and INSIDE the container for `container`:
 *
 *  direct     -> host paths, host socket, autostart allowed
 *  container  -> the bind-mounted paths, and SBMCP_AUTOSTART=0 so a container can
 *                never try to spawn Chrome (it would be the wrong, detectable
 *                Chrome, and it would not be able to anyway).
 *
 * BOTH SHAPES NOW INVOKE THE ADAPTER'S OWN ENTRY POINT (ARCH-007, option A).
 *
 * The station used to interpose a 648-line stdio relay on the direct path, for
 * one reason: the adapter launched Chrome at daemon boot, so merely listing the
 * tools opened a browser window, and the only way to stop that from out here was
 * to answer discovery locally and forward the rest. That made the station the
 * owner of framing, correlation, liveness, backpressure and shutdown for a
 * protocol it does not implement — to change one piece of startup timing.
 *
 * The adapter is lazy now (`sbmcp.capabilities.lazyStart`, gated in
 * `available()`): its daemon serves before Chrome exists, and Chrome is launched
 * by the first page-dependent tool call. So discovery no longer needs
 * intercepting, the relay has nothing left to do, and it is gone.
 *
 * SBMCP_IDLE_MS ON THE DIRECT SHAPE — the project setting must survive a lazy
 * start. The daemon is not launched at session start; the adapter's shim
 * autostarts it on the first browser tool call, and that spawn passes no
 * `--idle-ms`. It does pass its own env through, and the daemon reads
 * `SBMCP_IDLE_MS`, so setting it here is what keeps a project-configured idle
 * timeout in force on the path that actually starts Chrome. Without it every
 * lazily-started daemon would silently fall back to the adapter's 15-minute
 * default.
 */
export function mcpServerFor(project: Project, idleMs?: number | null): McpStdioServer {
  const id = sbmcpProjectId(project);
  if (project.isolation === 'container') {
    return {
      type: 'stdio',
      command: 'node',
      args: [CONTAINER_MCP_STDIO],
      env: { SBMCP_PROJECT: id, SBMCP_SOCKET: CONTAINER_SOCKET, SBMCP_AUTOSTART: '0' },
    };
  }
  return {
    type: 'stdio',
    command: process.execPath,
    args: [mcpStdioPath()],
    env: {
      SBMCP_PROJECT: id,
      SBMCP_SOCKET: socketPath(project),
      ...(idleMs != null ? { SBMCP_IDLE_MS: String(Math.floor(idleMs)) } : {}),
    },
  };
}

export interface BrowserBind {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
  why: string;
}

/**
 * The container mounts for a browser-enabled project — exactly two, both derived
 * from this project's id. This is the isolation boundary: there is no code path
 * by which project A's bind list can contain project B's socket.
 */
export function browserBinds(project: Project): BrowserBind[] {
  return [
    // rw: a unix socket needs write access to be connected to.
    { hostPath: socketPath(project), containerPath: CONTAINER_SOCKET, readOnly: false, why: 'stealth browser socket' },
    { hostPath: mcpStdioPath(), containerPath: CONTAINER_MCP_STDIO, readOnly: true, why: 'stealth browser MCP shim' },
  ];
}

/** Env the container needs so the shim finds the socket and never spawns Chrome. */
export function containerEnv(): Record<string, string> {
  return { SBMCP_SOCKET: CONTAINER_SOCKET, SBMCP_AUTOSTART: '0' };
}
