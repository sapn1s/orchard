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
