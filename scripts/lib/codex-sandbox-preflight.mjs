/**
 * BUG-189 — zero-token Codex sandbox preflight for the OpenAI dispatch path.
 *
 * WHY THIS EXISTS. Every `--provider openai` dispatch runs through CodexRuntime
 * with `--sandbox read-only` or `workspace-write`, both of which launch codex's
 * bwrap OS sandbox. A codex 0.157.x regression on btrfs (upstream #47968, fixed
 * only from 0.158.0-alpha; no stable release has it as of 2026-09-27) makes that
 * sandbox fail to launch at all:
 *
 *     error building bubblewrap command: cannot establish app-server socket
 *     mount isolation
 *
 * With no preflight the failure surfaces only AFTER an API turn has started —
 * BUG-187 round 5 burned ~127k tokens discovering it through real dispatches.
 * And it RECURS: `codex update` reinstalls the broken 0.157.1 as "latest" until
 * a stable 0.158 ships, so a machine that is fine today silently breaks again.
 *
 * WHAT THIS DOES. Before any API call, run `codex sandbox -c sandbox_mode=<mode>
 * -- true` — a real bwrap launch of the trivial `true`, which makes NO API call
 * and costs zero tokens. exit 0 ⇒ the sandbox is healthy, proceed. Non-zero ⇒
 * fail fast and loudly with the codex version, the codex error line, and a
 * pointer to this ticket + the revert/pin note. We NEVER fall back to
 * danger-full-access (that removes the FS write-jail the clean room relies on —
 * the user rejected it, BUG-189 log).
 *
 * ARCH-010. The "which codex binary" fact is owned by `detectCodex()` in
 * codex-runtime.ts; we import it rather than re-deriving. dispatch.mjs's openai
 * path never sets `pathToExecutable`, so the command resolved here
 * (CLAUDE_STATION_CODEX_BIN → detectCodex → bare `codex`) is byte-for-byte the
 * one CodexRuntime.start() will spawn — the preflight probes the SAME binary the
 * dispatch would use, not a guess.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

import { detectCodex } from '../../src/server/runtime/codex-runtime.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Default success cache TTL. A dispatch process is short-lived, so this mostly
 *  matters for a long-lived host (dispatch-client --check, a broker) that probes
 *  repeatedly — one healthy binary is not re-launched every time. */
export const DEFAULT_TTL_MS = 5 * 60 * 1000;
/** Probing `true` under bwrap is milliseconds of work; a slow one is a wedged
 *  sandbox, which is exactly the failure we want to surface, so keep it short. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Process-lifetime success cache: realpath\0version\0mode → { ts }. */
const successCache = new Map();

/**
 * Resolve the codex command dispatch.mjs's openai path will actually spawn.
 * Mirrors CodexRuntime.start()'s resolution MINUS pathToExecutable (the openai
 * dispatch path never sets it). The binary-existence fact stays owned by
 * detectCodex.
 */
export function resolveCodexCommand(env = process.env) {
  let command = env.CLAUDE_STATION_CODEX_BIN || 'codex';
  if (command === 'codex') command = detectCodex(env).binaryPath ?? 'codex';
  return command;
}

/** Split a resolved command into an execFile (file, baseArgs) pair, running a
 *  .mjs/.js fixture shim through the current node exactly as the runtime does. */
function invocation(command) {
  if (/\.(mjs|cjs|js)$/.test(command)) return { file: process.execPath, base: [command] };
  return { file: command, base: [] };
}

/*
 * BUG-189 round 3, finding 1 — the timeout must be enforced against a probe that
 * IGNORES SIGTERM. `execFile`'s built-in timeout signals SIGTERM to the direct
 * child only; a wedged bwrap that traps SIGTERM (and any grandchildren it spawned)
 * then survives, the callback never fires, and the "hard timeout / fail fast"
 * this helper advertises silently becomes an indefinite hang. So we own the
 * timer: spawn the probe as its OWN process group (detached) and, on expiry,
 * SIGKILL the WHOLE group — SIGKILL cannot be caught or ignored, and killing the
 * group reaps bwrap's children too.
 */
function run(file, args, { timeoutMs, env, cwd }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (e) {
      resolve({ code: 1, stdout: '', stderr: '', spawnError: e, timedOut: false });
      return;
    }
    let stdout = '', stderr = '', settled = false, timedOut = false;
    const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* already gone */ } } };
    const timer = setTimeout(() => { timedOut = true; killGroup('SIGKILL'); }, timeoutMs);
    timer.unref?.();
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.once('error', (e) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ code: 1, stdout, stderr, spawnError: e, timedOut }); // ENOENT etc.
    });
    child.once('exit', (code, signal) => {
      if (settled) return; settled = true; clearTimeout(timer);
      /*
       * BUG-189 round 4, finding 1 — reap the group on EVERY exit path, not only
       * on timeout. A probe launcher that forks a detached child (staying in this
       * group) and then exits 0 would otherwise leave that child orphaned but
       * alive. SIGKILL the group once the launcher's exit is observed; SIGKILL
       * cannot be ignored, and by-group reaps in-group children too. Residual
       * (documented in the ticket): a double-forked setsid'd GRANDCHILD gets its
       * own pgid and escapes this — prctl(PDEATHSIG)/pidfd/cgroup reaping is not
       * reachable from stock Node, so that narrow case is accepted, not covered.
       */
      killGroup('SIGKILL');
      resolve({ code: typeof code === 'number' ? code : (signal ? 1 : 0), stdout, stderr, spawnError: null, timedOut });
    });
  });
}

/** Best-effort version string, e.g. "codex-cli 0.158.0-alpha.15.2". */
async function codexVersion(file, base, ctx) {
  const r = await run(file, [...base, '--version'], ctx);
  const line = `${r.stdout}\n${r.stderr}`.split('\n').map((s) => s.trim()).find(Boolean);
  return line || 'unknown';
}

/** The last non-empty line of codex's stderr — the actual error to show. */
function lastLine(text) {
  const lines = String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

/**
 * Run the zero-token sandbox preflight for one sandbox mode.
 * @returns {Promise<{ok:boolean, version:string, binary:string, mode:string,
 *   cached?:boolean, errorLine?:string, exitCode?:number}>}
 */
export async function preflightCodexSandbox({
  sandbox,
  cwd = process.cwd(),
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  ttlMs = DEFAULT_TTL_MS,
  now = () => Date.now(),
  cache = successCache,
} = {}) {
  /*
   * BUG-189 round 4, finding 2 — reject forbidden/unknown modes instead of
   * silently collapsing them to read-only. Only the two dispatch sandbox modes
   * are probeable; anything else (danger-full-access, a typo) is a caller error,
   * returned as a non-ok result so no dispatch proceeds and nothing is mapped to
   * a weaker sandbox behind the caller's back. (dispatch.mjs/--check already
   * reject these before here; this is the helper owning its own contract.)
   */
  if (sandbox !== 'read-only' && sandbox !== 'workspace-write') {
    return {
      ok: false, version: 'unknown', binary: resolveCodexCommand(env), mode: String(sandbox), cwd,
      exitCode: 2, timedOut: false,
      errorLine: `unsupported sandbox mode ${JSON.stringify(sandbox)} — expected 'read-only' or 'workspace-write'`,
    };
  }
  const mode = sandbox;
  const command = resolveCodexCommand(env);
  const { file, base } = invocation(command);
  // BUG-189 round 3, finding 4 — probe in the SAME cwd the dispatch will run in.
  // A sandbox that fails only for a particular directory (e.g. a workspace-write
  // jail rooted at --cwd) must be probed there, not in the dispatcher's own cwd.
  const ctx = { timeoutMs, env, cwd };

  // realpath for the cache key: the same physical binary behind two symlinks
  // (e.g. ~/.local/bin/codex → …/current) shares a cache entry, and a `codex
  // update` that repoints the symlink invalidates it via the version component.
  let realBin = command;
  try { realBin = fs.realpathSync(command); } catch { /* not a resolvable path (bare name / ENOENT) — key on the string */ }

  const version = await codexVersion(file, base, ctx);
  // Cache key includes cwd (finding 4): a directory-specific sandbox result must
  // not be served from a probe run in a different directory.
  const key = `${realBin}\0${version}\0${mode}\0${cwd}`;

  const hit = cache.get(key);
  if (hit && (now() - hit.ts) < ttlMs) {
    return { ok: true, version, binary: realBin, mode, cwd, cached: true };
  }

  const r = await run(file, [...base, 'sandbox', '-c', `sandbox_mode=${mode}`, '--', 'true'], ctx);
  if (r.spawnError) {
    return {
      ok: false, version, binary: realBin, mode, cwd, exitCode: 1, timedOut: false,
      errorLine: `codex binary could not be launched (${realBin}): ${r.spawnError.message}`,
    };
  }
  if (r.code === 0 && !r.timedOut) {
    cache.set(key, { ts: now() });
    return { ok: true, version, binary: realBin, mode, cwd, cached: false };
  }
  return {
    ok: false, version, binary: realBin, mode, cwd, exitCode: r.code || 1, timedOut: r.timedOut,
    errorLine: r.timedOut
      ? `codex sandbox probe did not exit within ${timeoutMs}ms (SIGKILLed) — a wedged/ignoring sandbox`
      : (lastLine(r.stderr) || lastLine(r.stdout) || `codex sandbox exited ${r.code}`),
  };
}

/** Human-readable failure block: version, the codex error, and how to fix it. */
export function formatPreflightFailure(res) {
  return [
    `codex sandbox preflight FAILED for --sandbox ${res.mode}`,
    `  codex version: ${res.version}`,
    `  binary:        ${res.binary}`,
    `  codex error:   ${res.errorLine}`,
    '',
    "  The Codex OS sandbox (bwrap) cannot launch on this host, so no openai",
    '  dispatch can run a command. This is codex-side, not an Orchard bug.',
    '  See docs/bugs/BUG-189-codex-command-sandbox-fails-to-launch-on-this-machine.md.',
    '  0.157.x regresses this on btrfs (upstream #47968); it is fixed from',
    '  0.158.0-alpha. NOTE: `codex update` reinstalls the broken 0.157.1 as',
    '  "latest" until a stable 0.158 ships — do not run it. Pin a fixed release:',
    '    https://chatgpt.com/codex/install.sh --release 0.158.0-alpha.15.2',
    '  Verify with: codex sandbox -c sandbox_mode=read-only -- true',
    '  We do NOT fall back to danger-full-access (that removes the write-jail).',
  ].join('\n');
}

/** For tests: clear the process-lifetime cache. */
export function _clearPreflightCache() { successCache.clear(); }

export { HERE as _HERE };
