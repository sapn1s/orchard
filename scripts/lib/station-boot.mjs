/**
 * BUG-117 — the one place a script can ask "am I really isolated?" and be told
 * NO out loud.
 *
 * Every verification script here boots a server with a hand-rolled env object.
 * The knob that decides which population of session hosts that server will
 * adopt at boot is a single string: `CLAUDE_STATION_DATA`. Misspell it, drop it,
 * or inherit the wrong one and the server silently uses the REAL data dir — the
 * one holding the user's live session host. That happened; it is what BUG-117
 * records.
 *
 * Use `isolatedServerEnv()` to build the env for a scratch server. It refuses
 * rather than warns: a run that meant to isolate and did not must learn it from
 * the tool.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Isolate the spawned `claude` CLI's TRANSCRIPT store away from the user's real
 * ~/.claude/projects — the second half of isolation that `CLAUDE_STATION_DATA`
 * does NOT cover.
 *
 * The trap this exists to close: `CLAUDE_STATION_DATA` isolates the STATION's
 * own data dir, but the `claude` child still writes its `<id>.jsonl` transcript
 * to `<CLAUDE_CONFIG_DIR else ~/.claude>/projects/<encoded-cwd>/`. A suite that
 * sets only `CLAUDE_STATION_DATA` therefore looks isolated (its own state is
 * scratch) while every probe session it drives pollutes the user's real store —
 * the "fixture pollutes reality" failure. The matching runtime guard
 * (`assertSessionStoreIsolated` in src/lib/paths.ts) now REFUSES such a session,
 * so a suite that forgets this fails loudly instead of leaking.
 *
 * `CLAUDE_CONFIG_DIR` redirects the CLI's whole `~/.claude` (so its transcripts
 * land under scratch) — this alone STOPS the leak and satisfies the runtime
 * guard. OAuth still needs the real `.credentials.json` (and `settings.json`),
 * so those are SYMLINKED in — a symlink, not a copy, so no secret bytes are
 * written to scratch.
 *
 * By default Orchard's own READER is left pointed at the real store, because
 * many suites deliberately list REAL past sessions of a registered project as a
 * precondition (the CLI-write and the Orchard-read are DIFFERENT knobs, so
 * isolating the writer does not blind the reader). Pass `alsoReader: true` to
 * ALSO set `CLAUDE_PROJECTS_DIR` at the scratch store — for a fully-isolated
 * suite that reads back its OWN freshly-created sessions and wants no real data.
 *
 * `dir` must be a scratch directory the caller owns; it is created if absent.
 */
export function isolatedStoreEnv(dir, { alsoReader = false } = {}) {
  const configDir = path.resolve(dir);
  const projects = path.join(configDir, 'projects');
  fs.mkdirSync(projects, { recursive: true });
  for (const f of ['.credentials.json', 'settings.json']) {
    const real = path.join(os.homedir(), '.claude', f);
    const link = path.join(configDir, f);
    if (fs.existsSync(real) && !fs.existsSync(link)) {
      try { fs.symlinkSync(real, link); } catch { /* best-effort: absent creds surface as an auth error, not a leak */ }
    }
  }
  return alsoReader
    ? { CLAUDE_CONFIG_DIR: configDir, CLAUDE_PROJECTS_DIR: projects }
    : { CLAUDE_CONFIG_DIR: configDir };
}

/** The shared/production data dir this must never resolve to. */
export function sharedDataDir(env = process.env) {
  const xdg = env.XDG_DATA_HOME;
  const base = xdg && xdg.trim() ? path.resolve(xdg) : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'claude-station');
}

/**
 * Throw unless `env` isolates the server from the user's real state.
 * `requireStore` also demands `CLAUDE_PROJECTS_DIR` (the transcript store);
 * default false because several suites deliberately read the real store.
 */
export function assertIsolatedEnv(env, { requireStore = false } = {}) {
  const data = (env.CLAUDE_STATION_DATA ?? '').trim();
  if (!data) {
    const lookalikes = Object.keys(env).filter((k) => {
      const u = k.toUpperCase();
      return k !== 'CLAUDE_STATION_DATA' && ((u.includes('STATION') && u.includes('DATA')) || u.startsWith('CLAUDE_DATA'));
    });
    throw new Error(
      'REFUSING to boot an unisolated server: CLAUDE_STATION_DATA is not set, so the server would use ' +
      `${sharedDataDir(env)} — the REAL data dir, whose session-hosts belong to the user's live session ` +
      `(boot-time adoption would drain them).${lookalikes.length ? ` Did you mean CLAUDE_STATION_DATA? Found: ${lookalikes.join(', ')}.` : ''}`,
    );
  }
  if (path.resolve(data) === sharedDataDir(env)) {
    throw new Error(`REFUSING to boot: CLAUDE_STATION_DATA points AT the shared data dir (${data}).`);
  }
  if (requireStore && !(env.CLAUDE_PROJECTS_DIR ?? '').trim()) {
    throw new Error('REFUSING to boot: CLAUDE_PROJECTS_DIR is unset, so this server would read the user\'s real transcript store.');
  }
  return env;
}

/** Build + assert in one call: `spawn(node, [ENTRY], { env: isolatedServerEnv({ PORT, CLAUDE_STATION_DATA: DATA }) })`. */
export function isolatedServerEnv(overrides, opts) {
  return assertIsolatedEnv({ ...process.env, ...overrides }, opts);
}
