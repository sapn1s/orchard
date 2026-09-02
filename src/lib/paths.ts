/**
 * Shared path helpers + the one canonical slug rule.
 *
 * The slug rule is deliberately identical to the Claude session-store cwd
 * encoding (`[^a-zA-Z0-9] -> -`), lowercased. Keeping one rule means a project
 * id and a session-store dir name never disagree about how a path collapses.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

/** EVERY non-alphanumeric char collapses to '-', then lowercased. */
export function slugify(input: string): string {
  const s = input.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  return s.replace(/-{2,}/g, '-').replace(/^-|-$/g, '') || 'untitled';
}

export function projectRoot(): string {
  return path.resolve(import.meta.dirname, '..', '..');
}

/** Data dir: $CLAUDE_STATION_DATA, else XDG data home, else ~/.local/share. */
export function dataDir(): string {
  const env = process.env.CLAUDE_STATION_DATA;
  if (env && env.trim()) return path.resolve(env);
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.trim() ? path.resolve(xdg) : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'claude-station');
}

/**
 * BUG-117 — HOW the data dir was resolved, so "did this process intend to be
 * isolated?" is answerable instead of guessed. `'isolated'` means an explicit
 * `CLAUDE_STATION_DATA`; anything else is the shared/production location, which
 * is where the user's live session's hosts live.
 */
export function dataDirMode(env: NodeJS.ProcessEnv = process.env): 'isolated' | 'shared' {
  const v = env.CLAUDE_STATION_DATA;
  return v && v.trim() ? 'isolated' : 'shared';
}

/**
 * BUG-117 — env vars that LOOK like the isolation knob but are not it.
 *
 * The incident: a verification lane set `STATION_DATA_DIR` (a name that exists
 * nowhere in this codebase), `dataDir()` fell back to the REAL data dir in
 * total silence, and the booting server re-adopted — and drained — the user's
 * live session host. An unrecognised isolation attempt must never be
 * indistinguishable from setting nothing.
 *
 * Rule: any variable naming both a station and data (or `CLAUDE_DATA*`) that is
 * not the one real knob. Deliberately narrow — the other station knobs
 * (`CLAUDE_STATION_TMPDIR`, `_SURVIVE`, `_TERMINAL`, `_SCRATCH_DIR`,
 * `_HOST_ABANDON_MS`) contain no "DATA" and never match.
 */
export function misspelledDataDirVars(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env).filter((k) => {
    if (k === 'CLAUDE_STATION_DATA') return false;
    const u = k.toUpperCase();
    if (!(env[k] ?? '').trim()) return false;
    return (u.includes('STATION') && u.includes('DATA')) || u.startsWith('CLAUDE_DATA');
  }).sort();
}

/**
 * BUG-117 — refuse to continue when isolation was ATTEMPTED and missed.
 *
 * If something set a data-dir-shaped variable while the one real knob is unset,
 * the caller believes it is isolated and is not: every destructive path in this
 * process (chiefly boot-time survivor adoption) is aimed at the user's real
 * data dir. That is the exact shape of the incident, so it is a hard stop, not
 * a warning. Returns the human-readable reason instead of throwing when
 * `throwOnFail` is false, so a caller can print it its own way.
 */
export function assertDataDirIntent(env: NodeJS.ProcessEnv = process.env, throwOnFail = true): string | null {
  if (dataDirMode(env) === 'isolated') return null;
  const wrong = misspelledDataDirVars(env);
  if (wrong.length === 0) return null;
  const reason =
    `isolation was attempted and MISSED: ${wrong.map((k) => `${k}=${env[k]}`).join(', ')} — ` +
    `no such variable exists here, so the data dir resolved to the SHARED default (${dataDir()}), ` +
    `where the user's live session hosts live. The isolation knob is CLAUDE_STATION_DATA. ` +
    `Refusing to continue (BUG-117).`;
  if (throwOnFail) throw new Error(reason);
  return reason;
}

/**
 * Where a spawned `claude` CLI child WRITES its transcript store.
 *
 * The CLI resolves `~/.claude` against `CLAUDE_CONFIG_DIR` when set (that is the
 * env var the Agent SDK's session-mutation APIs honour), else `$HOME/.claude`.
 * Transcripts land in `<that>/projects/<encoded-cwd>/<id>.jsonl`. NOTE this is a
 * DIFFERENT knob from `CLAUDE_PROJECTS_DIR`: that one only steers Orchard's own
 * READER (session-history.defaultRoot); it does NOT change where the CLI writes.
 * A suite that sets `CLAUDE_PROJECTS_DIR` alone believes it is isolated and is
 * not — every session it creates still writes the user's real store.
 */
export function claudeStoreDir(env: NodeJS.ProcessEnv = process.env): string {
  const cfg = env.CLAUDE_CONFIG_DIR;
  const base = cfg && cfg.trim() ? path.resolve(cfg) : path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

/** The user's REAL transcript store, ignoring any override — the one to protect. */
export function realClaudeStoreDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * The ONE process that is allowed to write real ~/.claude/projects transcripts
 * through `ClaudeRuntime`: the production station server (index.ts marks itself
 * at boot). Everything else that reaches a `ClaudeRuntime` real-store write is a
 * verification harness — the server is the only production `ClaudeRuntime` user
 * (dispatch.mjs spawns the `claude` binary directly, never through the runtime,
 * so its real agent sessions never pass this seam). A module-level flag, not an
 * env var: env inherits to children and to a spawned test server, which would
 * defeat it; a fresh `import` in a verify script's own process starts `false`.
 */
let sanctionedRealStoreWriter = false;
export function markSanctionedRealStoreWriter(): void {
  sanctionedRealStoreWriter = true;
}
export function isSanctionedRealStoreWriter(): boolean {
  return sanctionedRealStoreWriter;
}

/**
 * BUG (fixture-pollutes-reality) — refuse to spawn a session that would write a
 * throwaway transcript into the user's REAL ~/.claude/projects store.
 *
 * Two structural signals, either of which condemns a real-store write:
 *
 *  1. `CLAUDE_STATION_DATA` set (isolated data dir) — the signature of a harness
 *     that isolated its station state but forgot the CLI's transcript store
 *     (`CLAUDE_CONFIG_DIR`). Half-isolated: its own state is scratch while every
 *     probe it drives pollutes the user's history. This closes the exact trap on
 *     the board — a suite that sets the WRONG data var (e.g. STATION_DATA_DIR)
 *     or the reader-only `CLAUDE_PROJECTS_DIR` and *believes* it is isolated.
 *
 *  2. Not the sanctioned production server (marker unset). The server is the
 *     only production caller of `ClaudeRuntime`, so an unmarked process reaching
 *     a real-store write is a verification harness driving the runtime in-process
 *     (e.g. an e2e suite that isolates nothing) — a leak even though it looks
 *     production-shaped. Zero production risk: nothing but the server marks
 *     itself, and nothing but the server drives `ClaudeRuntime` in production.
 *
 * A real-store write is allowed ONLY when it is the sanctioned server running in
 * the normal shared-data-dir mode. If the store is already isolated
 * (`CLAUDE_CONFIG_DIR` points off the real store) nothing fires — that is the
 * intended fix and the common correct case.
 *
 * `childEnv` is the environment the CLI child will actually run with (the server
 * merges `process.env` with per-session overrides), so the check sees the same
 * `CLAUDE_CONFIG_DIR` the child will.
 */
export function assertSessionStoreIsolated(
  childEnv: NodeJS.ProcessEnv = process.env,
  { label }: { label?: string } = {},
): void {
  const store = claudeStoreDir(childEnv);
  if (path.resolve(store) !== path.resolve(realClaudeStoreDir(childEnv))) return; // isolated store: fine.
  // The write targets the user's REAL store. Allow ONLY the production server in
  // its normal shared-data-dir mode.
  if (sanctionedRealStoreWriter && dataDirMode(childEnv) === 'shared') return;

  const who = label ? ` (session: ${label})` : '';
  const why = dataDirMode(childEnv) === 'isolated'
    ? `this process isolated its station data dir (CLAUDE_STATION_DATA=${childEnv.CLAUDE_STATION_DATA}) but NOT the ` +
      `claude transcript store` +
      ((childEnv.CLAUDE_PROJECTS_DIR ?? '').trim()
        ? ' (CLAUDE_PROJECTS_DIR only steers Orchard\'s reader, not the CLI writer — setting it is not isolation)'
        : '')
    : `this is not the production station server (a verification harness driving ClaudeRuntime in-process)`;
  throw new Error(
    `REFUSING to create a session${who}: ${why}, so the session would write a real transcript into the ` +
    `user's store ${store}. A verification harness must set CLAUDE_CONFIG_DIR to a scratch dir (the CLI writes ` +
    `<CLAUDE_CONFIG_DIR>/projects) — see isolatedStoreEnv() in scripts/lib/station-boot.mjs. ` +
    `Refusing rather than quietly polluting ~/.claude/projects (fixture-pollutes-reality guard).`,
  );
}

export function templatesDir(): string {
  return path.join(dataDir(), 'templates');
}

/**
 * FEAT-059 — the Orchard-owned scratch project's directory. Default
 * `dataDir()/scratch` (application state, not a user repo — survives the
 * Orchard rename because `dataDir()` is keyed by a constant, not the repo
 * path). Overridable via `CLAUDE_STATION_SCRATCH_DIR` for anyone who wants
 * it elsewhere; the scratch PROJECT's `hostPath` (registry.ts) is also a
 * normal, PATCH-able project field, same as any other project's.
 *
 * Deliberately NOT created here — callers that only need the path (e.g. to
 * check whether it exists yet) must not have the side effect of creating it.
 * `registry.ensureScratchProject()` is the one place that calls `ensureDir`
 * on this, on demand, the first time a scratch session is requested.
 */
export function scratchDir(): string {
  const env = process.env.CLAUDE_STATION_SCRATCH_DIR;
  if (env && env.trim()) return path.resolve(env);
  return path.join(dataDir(), 'scratch');
}

export function registryFile(): string {
  return path.join(dataDir(), 'registry.json');
}

/**
 * App-wide (global) defaults, sibling to the per-project `registry.json`.
 * FEAT-118: the ONE place a machine-wide default (e.g. the model tier every new
 * session should start on) is written down, so a project that sets nothing
 * inherits it rather than each session re-deciding. Per-project settings still
 * live in `registry.json`; this file only holds the global fallback layer.
 */
export function globalSettingsFile(): string {
  return path.join(dataDir(), 'settings.json');
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Write atomically: temp file in the same directory, fsync, then rename.
 * A crash mid-write leaves the previous file intact rather than a truncated one.
 */
export function writeAtomic(file: string, contents: string): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, contents, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/** Backup an existing file once before it is overwritten by non-atomic means. */
export function backupOnce(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  const bak = `${file}.bak-${new Date().toISOString().replace(/[^0-9]/g, '')}`;
  fs.copyFileSync(file, bak);
  return bak;
}

/** Where deleted session transcripts are kept so a mis-click is recoverable. */
export function deletedSessionsDir(): string {
  return path.join(dataDir(), 'deleted-sessions');
}

/**
 * Copy a file into the app's own data dir before something destroys it.
 *
 * Deliberately NOT `backupOnce()`: that writes `<file>.bak-<ts>` *beside* the
 * original, which for a session transcript means dropping backup files INSIDE
 * the user's real `~/.claude/projects` store. The store is the one directory
 * this app must never litter, so the copy goes to `dataDir()/deleted-sessions`
 * instead. Returns the backup path plus both sizes so the caller can prove the
 * copy is byte-identical BEFORE deleting anything.
 */
export function backupFileTo(src: string, destDir: string, name: string): { path: string; srcBytes: number; bakBytes: number } {
  ensureDir(destDir);
  const dest = path.join(destDir, name);
  fs.copyFileSync(src, dest);
  return { path: dest, srcBytes: fs.statSync(src).size, bakBytes: fs.statSync(dest).size };
}

/** True when `child` is inside `parent` (or equal). Both are resolved first. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
