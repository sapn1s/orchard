/**
 * BUG-223 — which Docker daemon a LANE reaches, decided once, at the boundary
 * where the lane is launched.
 *
 * WHY. The FEAT-158 guard (`assertIsolatedDocker`) protects only a suite that
 * calls it. The suites in the BUG-223 incident never touch Docker in their own
 * code: they boot a scratch Orchard server, and that server builds images and
 * runs containers for them, on whatever daemon its environment names. With no
 * DOCKER_HOST that is the host daemon, which runs the user's live projects.
 * The guard's polarity was the defect: the suite that does not know it is a
 * container suite is exactly the one that is not protected.
 *
 * THE RULE. Which daemon a project's sessions and lanes use is a DECLARED
 * per-project setting, `settings.laneDocker: 'sandbox' | 'host'` (round 4,
 * ARCH-010), never a scan at spawn time. A session or dispatched lane launched
 * for a `sandbox` project gets `DOCKER_HOST` pointed at the standing FEAT-158
 * sandbox in its launch environment. The initial value is classified ONCE, at
 * registration (`classifyLaneDocker`: sandbox if the project holds an Orchard
 * checkout, else host) and by `scripts/classify-lane-docker.mjs` for rows that
 * predate the setting; the user flips it in Settings → Isolation. Every child inherits it: the CLI's Bash
 * tool, its in-process subagents (they share the CLI process and its env),
 * `scripts/dispatch.mjs`, `independent-verify`, a scratch Orchard server and
 * every `docker` that server shells out to. Code that never mentions Docker
 * can therefore only see the sandbox.
 *
 * DECIDED ONCE, INHERITED EVERYWHERE (round 3, ARCH-010). The decision is made by
 * its OWNER only: the top-level live server (nothing inherited) at session spawn and
 * broker dispatch, by READING the project's declared setting, or an explicit
 * `useHostDocker` opt-out. It is stamped on the launch
 * as `ORCHARD_LANE_DOCKER=<socket>|host|host-optout` beside DOCKER_HOST, and every
 * launch point below (a nested scratch server, its broker, dispatch.mjs,
 * independent-verify, the runtimes, the sandbox CLI) READS it and never re-derives it
 * from the directory layout, a state dir or a project scan. A process that inherits a
 * sandbox declaration never runs `sandbox:docker up` (that acts on the host daemon).
 * The project-shape classification below runs ONLY at registration, never at spawn.
 *
 * THE ONE WAY OUT. A suite that genuinely needs the host daemon (GPU/CDI, host
 * `/proc`) calls `useHostDocker(reason)`, which logs the opt-out (stderr and
 * `<sandbox state dir>/host-optouts.jsonl`) and marks the environment with
 * ORCHARD_DOCKER_HOST_OPTOUT so the children it starts (a scratch server and
 * the sessions THAT server launches) stay on the host too. A shell uses
 * `eval "$(npm run -s sandbox:docker -- host-env '<reason>')"`.
 *
 * NOT CHANGED. The live server's own process environment is never modified:
 * this module returns COPIES. A container session is unaffected: `docker exec`
 * is spawned with the server's env, and DOCKER_HOST is not in the container
 * exec passthrough list. Projects without the sandbox tooling are unaffected
 * (their own docker workflows keep the host daemon; see the BUG-223 log for the
 * scoping decision).
 *
 * If the sandbox is not up, the lane's docker calls FAIL ("Cannot connect to
 * the Docker daemon at unix://…/docker.sock"); there is no fallback to the
 * host. Orchard's server never starts it (ARCH-022 decision b-i): a lane spawn on a
 * sandbox-declared project checks it answers (requireSandboxUp) and fails loudly if not.
 *
 * NOT DEFENDED (explicit code, not the unknowing case this closes): a child
 * spawned with a hand-built env that drops DOCKER_HOST, `docker -H`/`--context`
 * naming the host, or a client that dials /var/run/docker.sock directly. Each
 * of those names the host daemon in its own code.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sandboxPaths, hostDockerEnv, hostSocketCandidates } from './docker-sandbox.mjs';
import { registryFile } from '../../src/lib/paths.ts';

export const OPTOUT_ENV = 'ORCHARD_DOCKER_HOST_OPTOUT';
export const LANE_MARK_ENV = 'ORCHARD_LANE_DOCKER';
/** The file whose presence marks a project tree as carrying the sandbox tooling. */
export const SANDBOX_MARKER = path.join('scripts', 'lib', 'docker-sandbox.mjs');


const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
const within = (child, parent) => { const r = path.relative(parent, child); return r === '' || (!!r && !r.startsWith('..') && !path.isAbsolute(r)); };

/**
 * REGISTRATION-TIME CLASSIFICATION ONLY (round 4). Which value a project's DECLARED
 * `settings.laneDocker` starts with: run once when the project is registered
 * (`createProject`, `ensureScratchProject`) and once, by `scripts/classify-lane-docker.mjs`,
 * for the projects registered before the setting existed. It is NEVER run at session spawn
 * or broker dispatch: `laneDockerEnv()` reads the declared setting and nothing else
 * (ARCH-010; round-3 attacker breaks 1 and 2 were this shape scan deciding at spawn time).
 *
 * A project starts as `sandbox` when it holds an Orchard checkout: its root carries the
 * sandbox tooling, an ANCESTOR does (a project rooted inside a checkout subdir), it contains
 * a known checkout (`checkouts`: the server's own tree), or a checkout sits one or two
 * directories below its root (bounded scan). An EMPTY directory and an inconclusive scan
 * (budget spent) also start as `sandbox`: the safe side. Everything else starts as `host`, so the user's other
 * projects keep their compose stacks on the host daemon. The user flips it in Settings.
 */
const hasMarker = (dir) => { try { return fs.statSync(path.join(dir, SANDBOX_MARKER)).isFile(); } catch { return false; } };
/** Directories never descended into by the shallow scan (dependency trees, VCS, caches). */
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'target', '__pycache__']);
const SCAN_DEPTH = 2;
const SCAN_BUDGET = 4000;
/** 'found' | 'none' | 'inconclusive' (budget spent before the scan finished). */
function nestedCheckout(root) {
  let budget = SCAN_BUDGET;
  let level = [root];
  for (let d = 1; d <= SCAN_DEPTH && level.length; d++) {
    const next = [];
    for (const dir of level) {
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
        const sub = path.join(dir, e.name);
        // A symlinked directory counts (round 2, attacker break B). Bounded by depth and budget.
        let isDir = e.isDirectory();
        if (!isDir && e.isSymbolicLink()) { try { isDir = fs.statSync(sub).isDirectory(); } catch { /* dangling */ } }
        if (!isDir) continue;
        if (--budget < 0) return 'inconclusive';
        if (hasMarker(sub)) return 'found';
        next.push(sub);
      }
    }
    level = next;
  }
  return 'none';
}
function ancestorCheckout(root) {
  for (let dir = path.dirname(root); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    if (hasMarker(dir)) return dir;
  }
  return null;
}

/** The initial declared value for a project at `projectPath`. Returns { value, reason }. */
export function classifyLaneDocker(projectPath, { checkouts = [] } = {}) {
  if (!projectPath) return { value: 'host', reason: 'no path' };
  if (hasMarker(projectPath)) return { value: 'sandbox', reason: `its root carries ${SANDBOX_MARKER}` };
  const root = real(projectPath);
  const up = ancestorCheckout(root);
  if (up) return { value: 'sandbox', reason: `it is inside the checkout ${up}` };
  const held = checkouts.find((c) => !!c && within(real(c), root));
  if (held) return { value: 'sandbox', reason: `it contains the checkout ${held}` };
  // An EMPTY directory (nothing but dot-entries, e.g. a fresh scratch dir or a new
  // project about to be cloned into) says nothing about what its work will need, and a
  // declared value is not re-derived when a checkout appears later (round-4 attacker
  // break 1). So it starts on the safe side.
  // Round 5 (attacker p1 break 1): a root that cannot be LISTED (e.g. mode 0333) says
  // nothing either; it used to fall through to the scan, which skipped it and said 'host'.
  let visible;
  try { visible = fs.readdirSync(root).filter((n) => !n.startsWith('.')).length; } catch (e) {
    return { value: 'sandbox', reason: `its directory cannot be listed (${e.code ?? e.message}), so the scan is inconclusive; it starts on the safe side` };
  }
  if (visible === 0) return { value: 'sandbox', reason: 'it is empty, so nothing yet says what its work needs; it starts on the safe side' };
  const nested = nestedCheckout(root);
  if (nested === 'found') return { value: 'sandbox', reason: 'it holds a checkout 1-2 levels below its root' };
  if (nested === 'inconclusive') return { value: 'sandbox', reason: `the scan stopped after ${SCAN_BUDGET} directories (inconclusive), so it starts on the safe side` };
  return { value: 'host', reason: 'it holds no Orchard checkout' };
}
/** Boolean form of the classification (kept for callers and suites). */
export function isSandboxedProject(projectPath, opts = {}) {
  return classifyLaneDocker(projectPath, opts).value === 'sandbox';
}

export const LANE_DOCKER_VALUES = Object.freeze(['sandbox', 'host']);

/**
 * THE DECLARED SETTING (round 4). A project's `settings.laneDocker` in the registry this
 * process serves (`registryFile()`), looked up by the project's hostPath, which is meant to be
 * unique per registry (createProject and PATCH refuse a second row on one path; when two rows
 * still share one, 'host' needs every one of them to declare it). Read on every call, so a flip in
 * Settings applies to the next session or lane without a restart. Returns
 * { value: 'sandbox'|'host'|null, projectId, why }. `null` means undeclared (a row that was
 * never classified, an unregistered path, an unreadable registry); the caller fails SAFE.
 */
export function declaredLaneDocker(projectPath, { file = registryFile() } = {}) {
  if (!projectPath) return { value: null, projectId: null, why: 'no project path' };
  let reg;
  try { reg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { value: null, projectId: null, why: `registry ${file} unreadable (${e.code ?? e.message})` }; }
  const rows = Array.isArray(reg?.projects) ? reg.projects : [];
  const want = path.resolve(projectPath);
  const matches = rows.filter((p) => p && typeof p.hostPath === 'string' && path.resolve(p.hostPath) === want);
  const row = matches[0];
  if (!row) return { value: null, projectId: null, why: `no registered project at ${want}` };
  // Round 5 (attacker p2 break 1): two rows can resolve to one path (the scratch repoint
  // has no clash check; legacy or hand-edited rows). A path lookup cannot tell which
  // project is asking, so 'host' needs EVERY row on the path to declare it; anything
  // else is the sandbox. First-match used to hand a 'sandbox' project another row's 'host'.
  if (matches.length > 1) {
    const ids = matches.map((p) => p.id).join(', ');
    if (matches.every((p) => p.settings?.laneDocker === 'host')) return { value: 'host', projectId: row.id, why: `declared settings.laneDocker=host by every project at this path (${ids})` };
    return { value: 'sandbox', projectId: row.id, why: `${matches.length} projects share this path (${ids}) and not all declare host; the sandbox is used (fail-safe)` };
  }
  return declarationOfRow(row);
}

/**
 * Round 6: the declaration of ONE registry row, the caller having read that row BY ID from the
 * registry authority (dispatch-broker.ts re-reads `getProject(id)` per lane). This is the same
 * interpretation declaredLaneDocker applies after its path lookup, so there is one reader of the
 * value; it simply skips the path lookup, which cannot know which project is asking. `null` row
 * (the project is no longer registered) is undeclared, so the caller fails SAFE.
 */
export function declarationOfRow(row) {
  if (!row || typeof row !== 'object') return { value: null, projectId: null, why: 'project is not registered' };
  const id = typeof row.id === 'string' ? row.id : null;
  const v = row.settings && typeof row.settings === 'object' && !Array.isArray(row.settings) && Object.prototype.hasOwnProperty.call(row.settings, 'laneDocker') ? row.settings.laneDocker : undefined;
  if (LANE_DOCKER_VALUES.includes(v)) return { value: v, projectId: id, why: `declared settings.laneDocker=${v}` };
  return { value: null, projectId: id, why: v === undefined ? 'settings.laneDocker is not declared (run npm run lane-docker:classify)' : `settings.laneDocker=${JSON.stringify(v)} is not sandbox|host` };
}

/**
 * The Docker part of a lane's launch environment. Returns { decision, inherited, env, reason }:
 *   - 'sandbox'        env = { DOCKER_HOST: <socket>, ORCHARD_LANE_DOCKER: <socket> }
 *   - 'host-optout'    env = { ORCHARD_LANE_DOCKER: 'host-optout', ... } (inherited opt-out)
 *   - 'not-applicable' env = { ORCHARD_LANE_DOCKER: 'host' } (declared host)
 *
 * An inherited declaration wins, verbatim. Otherwise (the top-level owner, i.e. the live
 * server) it READS the project's declared `settings.laneDocker` and never scans the
 * filesystem. Undeclared fails SAFE to the sandbox, loudly. `checkouts` is accepted for
 * call-site compatibility and ignored here (it feeds `classifyLaneDocker` only).
 */
export function laneDockerEnv({ projectPath, baseEnv = process.env, registry, project } = {}) {
  const decl = inheritedLaneDocker(baseEnv);
  if (decl) return fromDeclaration(decl);
  // Round 6: a caller holding the project's row, re-read BY ID, passes it as `project`
  // (pass `null` for "re-read and not registered"): the decision then comes from that row,
  // never from whichever row currently sits at some path.
  const d = project !== undefined ? declarationOfRow(project) : declaredLaneDocker(projectPath, registry ? { file: registry } : undefined);
  const who = d.projectId ?? projectPath ?? '(no path)';
  if (d.value === 'host') {
    return { decision: 'not-applicable', inherited: false, env: { [LANE_MARK_ENV]: 'host' }, reason: `project ${who}: ${d.why}` };
  }
  const sock = sandboxPaths().dockerHost;
  if (d.value !== 'sandbox') console.warn(`[orchard] BUG-223: project ${who}: ${d.why}; its lanes get the SANDBOX daemon (fail-safe) until it is declared.`);
  return { decision: 'sandbox', inherited: false, env: { DOCKER_HOST: sock, [LANE_MARK_ENV]: sock }, reason: d.value === 'sandbox' ? `project ${who}: ${d.why}` : `project ${who}: ${d.why}; fail-safe sandbox` };
}

function fromDeclaration(decl) {
  if (decl.kind === 'host-optout') {
    return { decision: 'host-optout', inherited: true, env: { [LANE_MARK_ENV]: 'host-optout', [OPTOUT_ENV]: decl.reason }, reason: `inherited ${LANE_MARK_ENV}=host-optout (${decl.reason})` };
  }
  if (decl.kind === 'host') {
    return { decision: 'not-applicable', inherited: true, env: { [LANE_MARK_ENV]: 'host' }, reason: `inherited ${LANE_MARK_ENV}=host (the owner decided this lane keeps the host daemon)` };
  }
  // 'sandbox' or 'invalid' (fail-closed: an unreachable socket, never the host).
  return {
    decision: 'sandbox', inherited: true,
    env: { DOCKER_HOST: decl.dockerHost, [LANE_MARK_ENV]: decl.dockerHost },
    reason: decl.kind === 'invalid' ? `inherited ${LANE_MARK_ENV} is unusable (${decl.why}); FAIL-CLOSED to ${decl.dockerHost}` : `inherited ${LANE_MARK_ENV}=${decl.dockerHost}`,
  };
}

/**
 * THE DECLARED VALUE (round 3, the ARCH-010 redesign). `ORCHARD_LANE_DOCKER` carries the lane's
 * daemon decision, made ONCE by its owner (the top-level live server at session spawn or broker
 * dispatch, or an explicit `useHostDocker` opt-out), down to every descendant:
 *
 *   unix:///abs/path.sock | tcp://h:p   the lane's daemon (the sandbox); DOCKER_HOST is set to it
 *   host                                the owner decided this lane keeps the host (a project
 *                                       without the sandbox tooling)
 *   host-optout                         the explicit, logged opt-out (reason in ORCHARD_DOCKER_HOST_OPTOUT)
 *   sandbox                             LEGACY (rounds 1-2): the socket is DOCKER_HOST
 *
 * Returns null when nothing is declared; ONLY then may a process derive the decision itself.
 * Anything declared but unusable (garbage, a relative path, a well-known HOST socket, legacy
 * `sandbox` without a usable DOCKER_HOST) is { kind: 'invalid' } and FAILS CLOSED to an
 * unreachable socket: a lane descendant never falls back to the host.
 */
export const FAIL_CLOSED_DOCKER_HOST = 'unix:///nonexistent/orchard-lane-docker-undeclared/docker.sock';
export function inheritedLaneDocker(env = process.env) {
  const raw = String(env[LANE_MARK_ENV] ?? '').trim();
  if (!raw) return null;
  if (raw === 'host') return { kind: 'host', raw };
  if (raw === 'host-optout') return { kind: 'host-optout', raw, reason: String(env[OPTOUT_ENV] ?? '').trim() || '(reason not recorded)' };
  const target = raw === 'sandbox' ? String(env.DOCKER_HOST ?? '').trim() : raw;
  const bad = daemonProblem(target, env);
  if (bad) return { kind: 'invalid', raw, why: raw === 'sandbox' ? `legacy "sandbox" mark with DOCKER_HOST ${target || '(unset)'}: ${bad}` : bad, dockerHost: FAIL_CLOSED_DOCKER_HOST };
  return { kind: 'sandbox', raw, dockerHost: target };
}

function daemonProblem(h, env) {
  if (!h) return 'no daemon named';
  if (h.startsWith('tcp://')) return /^tcp:\/\/[^/\s]+:\d+\/?$/.test(h) ? null : 'malformed tcp:// address';
  if (!h.startsWith('unix://')) return 'not unix:// or tcp://';
  const p = h.slice('unix://'.length);
  if (!path.isAbsolute(p)) return 'unix:// path is not absolute';
  if (hostSocketCandidates(env).some((c) => c === p || real(c) === real(p))) return 'names a well-known HOST socket';
  return null;
}

/**
 * Make THIS process obey its inherited declaration: DOCKER_HOST := the declared daemon. Run once
 * at module load, so a server or script booted inside a lane (it imports this module) applies its
 * declaration to its OWN docker calls too, even if whoever spawned it dropped DOCKER_HOST
 * (`hostDockerEnv(process.env)`, a hand-built env). A process with nothing declared (the live
 * server) is untouched.
 */
export function applyInheritedLaneDocker(env = process.env) {
  const decl = inheritedLaneDocker(env);
  if (decl && (decl.kind === 'sandbox' || decl.kind === 'invalid')) {
    env.DOCKER_HOST = decl.dockerHost;
    env[LANE_MARK_ENV] = decl.dockerHost;
  }
  return decl;
}
applyInheritedLaneDocker();

/**
 * A running process's environment cannot be changed. A CLI launched BEFORE this
 * rule existed and re-adopted after a restart keeps whatever daemon it was born
 * with (round 1, attacker break 2). This reads its real environ so the adopter
 * can SAY so. Returns null when the process already has `want`, else what it has
 * ('(unset)' / the other DOCKER_HOST / 'unreadable').
 */
export function adoptedDockerMismatch(pid, want) {
  if (!pid || !want?.DOCKER_HOST) return null;
  let raw;
  try { raw = fs.readFileSync(`/proc/${pid}/environ`, 'utf8'); } catch { return 'unreadable'; }
  const line = raw.split('\0').find((l) => l.startsWith('DOCKER_HOST='));
  const has = line ? line.slice('DOCKER_HOST='.length) : '';
  return has === want.DOCKER_HOST ? null : (has || '(unset)');
}

/** Append one opt-out record. Best-effort: a log that cannot be written never blocks the opt-out. */
function recordOptOut(rec) {
  try {
    const dir = sandboxPaths().dir;
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'host-optouts.jsonl'), JSON.stringify(rec) + '\n');
  } catch { /* stderr line below is the record of last resort */ }
}

/**
 * THE explicit opt-out. Points `env` (default: this process) at the HOST daemon
 * and marks it, so this suite's children stay on the host too. Logged.
 */
export function useHostDocker(reason, { who = path.basename(process.argv[1] ?? 'unknown'), env = process.env } = {}) {
  const why = String(reason ?? '').trim();
  if (!why) throw new Error('useHostDocker(reason): a reason is required — reaching the host daemon is the logged exception (BUG-223)');
  const host = hostDockerEnv(env);
  delete env.DOCKER_HOST;
  env.DOCKER_CONTEXT = host.DOCKER_CONTEXT;
  env[OPTOUT_ENV] = why;
  env[LANE_MARK_ENV] = 'host-optout';
  const rec = { ts: new Date().toISOString(), who, pid: process.pid, cwd: process.cwd(), reason: why };
  recordOptOut(rec);
  console.error(`HOST DOCKER OPT-OUT: ${who} reaches the HOST daemon (${why}). Logged to ${path.join(sandboxPaths().dir, 'host-optouts.jsonl')}.`);
  return env;
}

/** Shell lines for the same opt-out (`sandbox:docker -- host-env <reason>`). */
export function hostEnvShell(reason, who = 'shell') {
  const env = { ...process.env };
  useHostDocker(reason, { who, env });
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  return `unset DOCKER_HOST; export DOCKER_CONTEXT=default ${OPTOUT_ENV}=${q(env[OPTOUT_ENV])} ${LANE_MARK_ENV}=host-optout`;
}

/**
 * ARCH-022 decision (b-i): the SERVER never starts the sandbox. `sandbox:docker up` is a user / lane tool that acts on the
 * HOST daemon, outside the server's claim and its lifecycle authority, so nothing the server imports may run it. A lane
 * spawn whose project declares the sandbox and finds it down FAILS LOUDLY (requireSandboxUp) — it is never sent to the
 * host and nothing tries to start the sandbox for it.
 */
/**
 * The daemon this process's lanes use: the inherited declaration's, else (top level only) the
 * standing sandbox's derived socket. null when the inherited declaration is a host one.
 */
function laneDaemon(env) {
  const decl = inheritedLaneDocker(env);
  if (!decl) return sandboxPaths().dockerHost;
  return decl.kind === 'sandbox' || decl.kind === 'invalid' ? decl.dockerHost : null;
}

/** Does the lanes' daemon answer? (async, never blocks the caller's event loop) */
export async function sandboxAnswers(env = process.env) {
  const target = laneDaemon(env);
  if (!target) return false;
  // A read (docker info), spawned literally, so the ARCH-022 static scan can see it is one.
  return await new Promise((resolve) => {
    let out = '';
    let child;
    try { child = spawn('docker', ['info', '--format', '{{.ID}}'], { env: { ...hostDockerEnv(env), DOCKER_HOST: target }, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { resolve(false); return; }
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 15_000);
    child.stdout.on('data', (d) => { out = (out + d).slice(-400); });
    child.on('error', () => { clearTimeout(t); resolve(false); });
    child.on('close', (code) => { clearTimeout(t); resolve(code === 0 && out.trim() !== ''); });
  });
}

/** The same read, synchronously (a missing socket answers at once; a live daemon in milliseconds). */
export function sandboxAnswersSync(env = process.env) {
  const target = laneDaemon(env);
  if (!target) return false;
  const r = spawnSync('docker', ['info', '--format', '{{.ID}}'], { env: { ...hostDockerEnv(env), DOCKER_HOST: target }, encoding: 'utf8', timeout: 5_000 });
  return r.status === 0 && (r.stdout ?? '').trim() !== '';
}

/** The message a lane spawn fails with when its declared sandbox is down. */
export const SANDBOX_DOWN_MESSAGE = 'the Docker sandbox this project declares is not running: run `npm run sandbox:docker -- up` (Orchard never starts it, and never sends a lane to the host daemon instead)';
/** Throws (loudly) unless the lanes' sandbox daemon answers. Never starts it; never falls back to the host. */
export async function requireSandboxUp(env = process.env) {
  if (!(await sandboxAnswers(env))) {
    const e = new Error(SANDBOX_DOWN_MESSAGE);
    e.code = 'sandbox-down';
    throw e;
  }
}
