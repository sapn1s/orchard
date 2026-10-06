/**
 * ARCH-022 — the ONE module that runs the docker binary.
 *
 * Every Docker call Orchard makes (container-manager, service-manager, project-builder) goes
 * through here. Nothing else in src/ may spawn the docker CLI, reference `CLAUDE_STATION_DOCKER`,
 * or reach docker through a shell wrapper: `scripts/verify-arch-022-authority.mjs` fails the build
 * if anything does. That is what lets the lifecycle authority (`lifecycle.ts`) be the only place a
 * destructive call can come from: a door that does not pass through this module cannot reach the
 * daemon at all.
 *
 * Two kinds of call:
 *  - READ calls — a fixed allowlist of verbs that cannot change daemon state (`isReadArgv`).
 *    Anyone may make them.
 *  - Everything else is a MUTATION, and is spawned only after the lifecycle authority's decision
 *    function grants it (it throws otherwise). There is exactly one such function: `lifecycle.ts`
 *    installs it at import through `sealAuthority()`, and a second call throws. With none installed,
 *    every mutation is refused. The read allowlist is fail-closed: a verb it does not know mutates.
 *
 * The docker binary is read from `CLAUDE_STATION_DOCKER` per call (a test shim may be set between
 * imports, exactly as each manager module used to read it at its own load).
 */
import { spawn, spawnSync, type ChildProcess, type SpawnOptions, type SpawnSyncReturns } from 'node:child_process';

export function dockerBin(): string {
  return process.env.CLAUDE_STATION_DOCKER ?? 'docker';
}

/* ------------------------------------------------------------ classification */

/** Verbs (after any global options) that only READ daemon state. Anything else mutates. */
const READ_VERBS = new Set(['inspect', 'ps', 'images', 'logs', 'info', 'version', 'diff', 'events', 'top', 'port', 'history']);
/** `docker <object> <sub>` forms that only read. */
const READ_SUBS: Record<string, Set<string>> = {
  container: new Set(['inspect', 'ls', 'list', 'ps', 'logs', 'diff', 'top', 'port']),
  image: new Set(['inspect', 'ls', 'list', 'history', 'save']),
  network: new Set(['inspect', 'ls', 'list']),
  volume: new Set(['inspect', 'ls', 'list']),
  buildx: new Set(['inspect', 'ls', 'version', 'du']),
  system: new Set(['info', 'df']),
  context: new Set(['inspect', 'ls', 'show']),
};
/** `docker save` streams an image out; it changes nothing. */
READ_VERBS.add('save');

/** Global options that take a value (so the verb is found after them). */
const GLOBAL_WITH_VALUE = new Set(['-H', '--host', '--context', '-c', '--config', '--log-level', '-l', '--tlscacert', '--tlscert', '--tlskey']);

function verbIndex(args: readonly string[]): number {
  let i = 0;
  while (i < args.length && args[i]!.startsWith('-')) {
    const a = args[i]!;
    i += GLOBAL_WITH_VALUE.has(a) && !a.includes('=') ? 2 : 1;
  }
  return i;
}

/** The index of the docker verb in argv (after global options). */
export function verbAt(args: readonly string[]): number { return verbIndex(args); }

/** Is this argv a read-only docker call? Fail-closed: unknown means "mutation". */
export function isReadArgv(args: readonly string[]): boolean {
  const i = verbIndex(args);
  const verb = args[i];
  if (!verb) return true; // `docker` with no verb prints help
  if (args.includes('--bootstrap')) return false; // `buildx inspect --bootstrap` starts a builder
  if (READ_VERBS.has(verb)) return true;
  // `docker cp <container>:<path> <dest>` streams OUT of a container: a read. Into a container it mutates.
  if (verb === 'cp') {
    const pos = args.slice(i + 1).filter((a) => a === '-' || !a.startsWith('-')); // `-` is stdin/stdout, a positional
    return pos.length === 2 && pos[0]!.includes(':') && !pos[1]!.includes(':');
  }
  const subs = READ_SUBS[verb];
  if (subs) {
    const sub = args[i + 1];
    return !!sub && subs.has(sub);
  }
  return false;
}

/* --------------------------------------------------------------- the seal */

/** What the authority decides for one mutation: allowed (with a completion callback) or it throws. */
export interface MutationGrant {
  /** The authority's record id for this grant; the docker child sees it as ORCHARD_DOCKER_GRANT (the runtime proof). */
  id: string;
  /** Called once the docker process has exited. `uncertain`: it was killed or timed out, so the daemon may
   *  still be acting on the request. */
  settled(uncertain: boolean): void;
}
/** The authority's decision function, installed exactly once by `lifecycle.ts`. */
export type MutationHook = (args: readonly string[]) => MutationGrant;

/** The mutation capability: spawn docker WITHOUT going through the hook (the authority's own probes and reaps). */
export interface Mutator {
  spawnSync(args: string[], opts: { timeoutMs: number; maxBuffer?: number; env?: NodeJS.ProcessEnv; input?: string }, grantId: string): SpawnSyncReturns<string>;
}

let hook: MutationHook | null = null;
/**
 * Called by `lifecycle.ts` at import: installs its decision function and receives the raw capability.
 * Throws for any later caller, so no other module can install a second (permissive) decision function
 * or obtain the raw capability. This is architectural enforcement over Orchard's own code (the static
 * check proves only lifecycle.ts calls it), not access control against arbitrary code in this process.
 */
export function sealAuthority(h: MutationHook): Mutator {
  if (hook) throw new Error('docker-exec: the mutation capability has already been taken by the lifecycle authority');
  hook = h;
  return { spawnSync: (args, opts, grantId) => rawSpawnSync(args, opts, grantId) };
}

export class DockerAuthorityError extends Error {
  readonly code = 'not-authority';
  constructor(args: readonly string[], why = 'no lifecycle authority is installed in this process') {
    super(`refusing docker ${args.slice(0, 3).join(' ')}: ${why} (ARCH-022)`);
    this.name = 'DockerAuthorityError';
  }
}

/** Every call passes here. Reads go through; a mutation needs the authority's grant, or it throws. */
function gate(args: readonly string[]): MutationGrant | null {
  if (isReadArgv(args)) return null;
  if (!hook) throw new DockerAuthorityError(args); // fail-closed: no authority loaded, no mutation
  return hook(args);
}

/* ------------------------------------------------------------- spawning */

/** A mutation's child carries its grant id; a read carries none. (The docker CLI ignores the variable.) */
function withGrant(env: NodeJS.ProcessEnv | undefined, grantId: string | null): NodeJS.ProcessEnv | undefined {
  if (!grantId) return env;
  return { ...(env ?? process.env), ORCHARD_DOCKER_GRANT: grantId };
}

function rawSpawnSync(args: readonly string[], opts: { timeoutMs: number; maxBuffer?: number; env?: NodeJS.ProcessEnv; input?: string }, grantId: string | null = null): SpawnSyncReturns<string> {
  const env = withGrant(opts.env, grantId);
  return spawnSync(dockerBin(), [...args], {
    encoding: 'utf8',
    timeout: opts.timeoutMs,
    maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024,
    ...(env ? { env } : {}),
    ...(opts.input !== undefined ? { input: opts.input } : {}),
  });
}

function rawSpawn(args: readonly string[], opts: SpawnOptions, grantId: string | null = null): ChildProcess {
  const env = withGrant(opts.env, grantId);
  return spawn(dockerBin(), [...args], env ? { ...opts, env } : opts);
}

/** Run docker synchronously. Read calls always; mutations per the authority rule above. */
export function dockerSpawnSync(args: string[], opts: { timeoutMs: number; maxBuffer?: number; env?: NodeJS.ProcessEnv; input?: string }): SpawnSyncReturns<string> {
  const grant = gate(args);
  let r: SpawnSyncReturns<string>;
  try { r = rawSpawnSync(args, opts, grant?.id ?? null); } catch (e) { grant?.settled(true); throw e; }
  // A spawnSync that hit its timeout was killed: the daemon may still be acting on the request.
  grant?.settled(!!r.signal || (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT');
  return r;
}

/** As dockerSpawnSync, with stdout/stderr as Buffers (binary output: `docker cp … -`). Same rule. */
export function dockerSpawnSyncBuffer(args: string[], opts: { timeoutMs: number; maxBuffer?: number }): SpawnSyncReturns<Buffer> {
  const grant = gate(args);
  let r: SpawnSyncReturns<Buffer>;
  try {
    r = spawnSync(dockerBin(), [...args], { timeout: opts.timeoutMs, maxBuffer: opts.maxBuffer ?? 512 * 1024 * 1024, ...(grant ? { env: withGrant(undefined, grant.id) } : {}) });
  } catch (e) { grant?.settled(true); throw e; }
  grant?.settled(!!r.signal || (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT');
  return r;
}

/** Start docker as a child (streams: build, load, save, exec). Same rule. */
export function dockerSpawn(args: string[], opts: SpawnOptions): ChildProcess {
  const grant = gate(args);
  let child: ChildProcess;
  try { child = rawSpawn(args, opts, grant?.id ?? null); } catch (e) { grant?.settled(true); throw e; }
  if (grant) {
    let done = false;
    const end = (uncertain: boolean) => { if (!done) { done = true; grant.settled(uncertain); } };
    // Killed by a caller's timeout (a signal) = uncertain; a spawn error = nothing reached the daemon.
    child.once('close', (_code, signal) => end(!!signal));
    child.once('error', () => end(false));
  }
  return child;
}
