/**
 * path-env.mjs — BUG-091: make user-installed MCP tools resolve regardless of
 * how the service was started.
 *
 * WHY THIS EXISTS
 * ---------------
 * A `direct`/`sandbox` session's engine (the `claude` CLI) is spawned host-side,
 * and every MCP server it launches (e.g. serena via `uvx` in `~/.local/bin`)
 * inherits the engine's PATH. When the claude-station systemd unit is started by
 * a COLD BOOT, systemd hands it a minimal PATH (`/usr/local/bin:/usr/bin`) that
 * omits `~/.local/bin`, so `uvx` is `command not found` and the MCP server
 * silently fails to start. Proven live (BUG-091): the exact serena command with
 * `~/.local/bin` on PATH reaches "Initializing Serena MCP server"; without it,
 * command-not-found.
 *
 * THE RULE
 * --------
 * PREPEND the user's local tool dirs (`~/.local/bin`, and `~/.cargo/bin` if it
 * exists) to the inherited PATH, de-duplicated, DROPPING NO existing entries.
 * The home dir is derived from `os.homedir()` — never hard-coded (leak-gate).
 *
 * ISOLATION SCOPE
 * ---------------
 * This is HOST-ONLY. For `container` isolation the engine execs INTO the
 * container, where host `~/.local/bin` is meaningless (serena there must be in
 * the image); that path builds the in-container PATH from a fixed passthrough
 * list (container-manager.ts `execArgv`) and must NOT receive host paths.
 *
 * PRIMARY APPLICATION SITE (BUG-091 reopen): this helper is applied ONCE at
 * server boot to the server's OWN `process.env.PATH` (src/server/index.ts), so
 * every host-side descendant spawn — the survival broker (session-host.mjs),
 * codex-runtime.ts, and the Claude SDK's `claude` child — inherits the corrected
 * PATH. The original per-site call in session-host.mjs is kept as harmless
 * belt-and-suspenders (it re-augments an already-augmented, de-duped PATH).
 * Container spawns are structurally unaffected: they never forward host PATH.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * The user's local tool dirs to put in front of PATH. `~/.local/bin` is always
 * offered (pip/uv/pipx installs land there); `~/.cargo/bin` only when it exists
 * (Rust toolchains) so we never add a phantom entry on a machine without Rust.
 * Derived from `homeDir` (defaults to os.homedir()) — no hard-coded home.
 */
export function userToolDirs(homeDir = os.homedir()) {
  const dirs = [path.join(homeDir, '.local', 'bin')];
  const cargoBin = path.join(homeDir, '.cargo', 'bin');
  try {
    if (fs.statSync(cargoBin).isDirectory()) dirs.push(cargoBin);
  } catch { /* no cargo install — skip */ }
  return dirs;
}

/**
 * Return a COPY of `baseEnv` whose PATH has the user's local tool dirs prepended,
 * keeping EVERY existing PATH entry verbatim (node etc. must never be dropped —
 * and neither may POSIX empty fields). If a tool dir is already present, it is
 * not added again and its existing position is left untouched. Every other env
 * var is passed through unchanged.
 *
 * DE-DUPE SCOPE (BUG-091 reopen): only the dirs we PREPEND are de-duplicated —
 * against the inherited PATH and against each other. The inherited entries are
 * copied through UNCHANGED, including empty fields from a leading/trailing/
 * doubled `:` (POSIX "current directory"). A prior `.filter(Boolean)` silently
 * dropped those empties, violating "drop no existing entries"; e.g.
 * `"/usr/local/bin:/usr/bin:"` must keep its trailing empty entry.
 */
export function augmentedPathEnv(baseEnv, homeDir = os.homedir()) {
  const sep = path.delimiter;
  // A genuinely absent/empty PATH is NO entries (never a phantom cwd `""`); a
  // non-empty PATH is split preserving every field, empties included.
  const rawPath = baseEnv?.PATH;
  const existing = rawPath ? String(rawPath).split(sep) : [];
  const existingSet = new Set(existing);
  // Prepend only the user tool dirs not already on PATH; de-dupe the prepended
  // list against itself too. Existing entries are NEVER touched or de-duped.
  const front = [];
  const added = new Set();
  for (const d of userToolDirs(homeDir)) {
    if (existingSet.has(d) || added.has(d)) continue;
    added.add(d);
    front.push(d);
  }
  return { ...baseEnv, PATH: [...front, ...existing].join(sep) };
}
