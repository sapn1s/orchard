/**
 * board-path.mjs — FEAT-106: resolve where an onboarded project keeps the files
 * Orchard generates, so a single reader works whether that project uses the new
 * consolidated `.orchard/` layout or the legacy scattered one.
 *
 * WHY IT EXISTS. onboard.mjs is being migrated from scattering ~21 generated
 * paths across a target's root, `scripts/`, `docs/` and `public/` to putting
 * everything under one project-local `.orchard/` directory (the way `.claude/`
 * works). During and after that migration a reader — the dashboard server, the
 * board drift-guard, the arch-watcher — must not care which layout a given
 * project is on. This module is the ONE place that knows the precedence.
 *
 * PLAIN ESM, NODE BUILTINS ONLY (fs/path). Two consumers depend on that:
 *   - it is COPIED verbatim into every onboarded target (like board.mjs), so it
 *     cannot import anything that would not travel with it;
 *   - it is imported from TypeScript server code (src/server/tickets.ts already
 *     imports ../../scripts/board.mjs), so it must be importable without a build.
 *
 * THE HARD CONSTRAINT (FEAT-106). Orchard's OWN board — docs/bugs/, ~249 live
 * tickets + ~194 archived — must never move or be read from a different path.
 * Orchard's repo has no `.orchard/`, so every resolver here falls through to its
 * legacy path for Orchard by construction, not by care. The unit verify asserts
 * that explicitly against the real repo.
 *
 * SHAPE OF EVERY RESOLVER. It returns an ABSOLUTE path. Where a `.orchard`
 * candidate exists it wins; otherwise the legacy path is returned WHETHER OR NOT
 * it exists (a resolver names where a thing lives, it does not assert the thing
 * is there — callers that need existence check it themselves). The one richer
 * case is the board, which also honours an explicit declaration in config.json.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Is `p` an existing directory? Never throws. */
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Is `p` an existing file? Never throws. */
function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * FEAT-106 — THE ONE guarded reader for every file read out of a TARGET repo,
 * OWNED here (board-path.mjs is node-builtins-only, copied verbatim into targets,
 * and imported from TypeScript AND from onboard/fleet-sync — so this module, not
 * an entry script, is the right owner; onboard/fleet-sync import it from here).
 *
 * A FIFO/socket/device placed where a regular file is expected would make a plain
 * `readFileSync` BLOCK FOREVER (the round-6/7/8 hang class). This reader
 * lstat-refuses any non-regular type (symlinks are NOT followed), opens
 * O_NONBLOCK so a type that raced the lstat cannot block, fstat-refuses a raced
 * non-regular, and CAPS the bytes. Returns `{ ok, data }` or `{ ok:false,
 * reason }`. NEVER used for THIS repo's own source files (those we control).
 */
export const MAX_TARGET_READ = 8 * 1024 * 1024; // 8 MiB — far above any file onboard reads

export function readTargetFile(p, { max = MAX_TARGET_READ, encoding = 'utf8' } = {}) {
  let st;
  try { st = fs.lstatSync(p); } catch (e) { return { ok: false, reason: e.code === 'ENOENT' ? 'absent' : `unreadable (${e.code || e.message})` }; }
  if (!st.isFile()) {
    const kind = st.isDirectory() ? 'directory' : st.isSymbolicLink() ? 'symlink' : st.isFIFO() ? 'FIFO' : st.isSocket() ? 'socket' : 'special file';
    return { ok: false, reason: `not a regular file (${kind})` };
  }
  if (st.size > max) return { ok: false, reason: `too large (${st.size} > ${max} bytes)` };
  let fd;
  try { fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK); }
  catch (e) { return { ok: false, reason: `open failed (${e.code || e.message})` }; }
  try {
    const fst = fs.fstatSync(fd);
    if (!fst.isFile()) return { ok: false, reason: 'not a regular file (raced non-regular)' };
    if (fst.size > max) return { ok: false, reason: `too large (${fst.size} > ${max} bytes)` };
    const buf = Buffer.allocUnsafe(Math.min(fst.size, max) + 1);
    let total = 0;
    while (total < buf.length) {
      let n;
      try { n = fs.readSync(fd, buf, total, buf.length - total, null); }
      catch (e) { if (e.code === 'EAGAIN') break; return { ok: false, reason: `read failed (${e.code || e.message})` }; }
      if (n === 0) break;
      total += n;
    }
    if (total > max) return { ok: false, reason: `too large (exceeded ${max} bytes)` };
    const data = buf.subarray(0, total);
    return { ok: true, data: encoding ? data.toString(encoding) : Buffer.from(data) };
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/** True iff the TARGET file at `targetPath` reads back byte-identical to the repo
 *  source at `repoSrcPath`, through the guarded (capped, non-blocking) reader —
 *  a FIFO/dir/OVERSIZED file at the target can never block, mislead, or be read
 *  unbounded. The repo side is ours, so it is read directly. */
export function targetBytesEqual(targetPath, repoSrcPath) {
  const r = readTargetFile(targetPath, { encoding: null });
  if (!r.ok) return false;
  let srcBuf;
  try { srcBuf = fs.readFileSync(repoSrcPath); } catch { return false; }
  return r.data.equals(srcBuf);
}

function requireHostPath(hostPath, fn) {
  if (typeof hostPath !== 'string' || hostPath.trim() === '') {
    throw new TypeError(`${fn}: hostPath must be a non-empty string`);
  }
  return path.resolve(hostPath);
}

/** The consolidated Orchard directory for a project: `<hostPath>/.orchard`. */
export function resolveOrchardDir(hostPath) {
  return path.join(requireHostPath(hostPath, 'resolveOrchardDir'), '.orchard');
}

/** `<hostPath>/.orchard/config.json`, whether or not it exists. */
export function resolveConfigFile(hostPath) {
  return path.join(resolveOrchardDir(hostPath), 'config.json');
}

/**
 * Read+parse `.orchard/config.json`. Returns the parsed object, or null if the
 * file is absent, unreadable, or not a JSON object. Never throws — a broken
 * config must degrade to "no declaration", not wedge a reader.
 */
export function readOrchardConfig(hostPath) {
  const file = resolveConfigFile(hostPath);
  // Guarded, non-blocking, capped read — a FIFO/socket/non-regular/oversized
  // `.orchard/config.json` must degrade to "no declaration", never wedge or
  // unbounded-read onboard/fleet-sync (round-8 hang / round-9 cap).
  const r = readTargetFile(file);
  if (!r.ok) return null;
  const raw = r.data;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed;
}

/**
 * The declared board path, if config.json names one. Returns the ABSOLUTE
 * resolved directory, or null. The declaration is host-relative by contract
 * (a portable, checked-in value), so it is resolved against hostPath. An empty
 * or non-string `board` is treated as no declaration.
 */
function declaredBoardDir(hostPath, root) {
  const cfg = readOrchardConfig(hostPath);
  const board = cfg && cfg.board;
  if (typeof board !== 'string' || board.trim() === '') return null;
  return path.resolve(root, board);
}

/**
 * Where this project's board (bugs/tickets) lives. Precedence:
 *   1. DECLARED  — `.orchard/config.json` names `board` (host-relative).
 *   2. DISCOVERED — `.orchard/bugs` exists.
 *   3. LEGACY    — `docs/bugs` (returned as the fallback even if absent).
 */
export function resolveBoardDir(hostPath) {
  const root = requireHostPath(hostPath, 'resolveBoardDir');
  const declared = declaredBoardDir(root, root);
  if (declared) return declared;
  const orchardBugs = path.join(root, '.orchard', 'bugs');
  if (isDir(orchardBugs)) return orchardBugs;
  return path.join(root, 'docs', 'bugs');
}

/**
 * Which board layout a project is on — the classification the resolvers above
 * act on, exposed so a reader/onboard can report or branch on it:
 *   'declared' — config.json names a board.
 *   'orchard'  — `.orchard/bugs` exists (no declaration).
 *   'legacy'   — `docs/bugs` exists (no `.orchard/`).
 *   'none'     — none of the above; nothing scaffolded yet.
 */
export function boardLayout(hostPath) {
  const root = requireHostPath(hostPath, 'boardLayout');
  if (declaredBoardDir(root, root)) return 'declared';
  if (isDir(path.join(root, '.orchard', 'bugs'))) return 'orchard';
  if (isDir(path.join(root, 'docs', 'bugs'))) return 'legacy';
  return 'none';
}

/**
 * The generic `.orchard`-first resolver used by every non-board artifact: the
 * `.orchard` candidate if it exists, else the legacy path (returned regardless).
 * `kind` selects file-vs-dir existence so a candidate of the wrong type does not
 * shadow a real legacy path.
 */
function resolveOrchardFirst(root, candidateRel, legacyRel, kind) {
  const candidate = path.join(root, '.orchard', ...candidateRel);
  const present = kind === 'dir' ? isDir(candidate) : isFile(candidate);
  if (present) return candidate;
  return path.join(root, ...legacyRel);
}

/** The method-library dir: `.orchard/lib` if present, else legacy `scripts/lib`. */
export function resolveLibDir(hostPath) {
  const root = requireHostPath(hostPath, 'resolveLibDir');
  return resolveOrchardFirst(root, ['lib'], ['scripts', 'lib'], 'dir');
}

/** The local-conventions doc: `.orchard/CONVENTIONS.md` if present, else legacy `docs/CONVENTIONS.md`. */
export function resolveConventionsFile(hostPath) {
  const root = requireHostPath(hostPath, 'resolveConventionsFile');
  return resolveOrchardFirst(root, ['CONVENTIONS.md'], ['docs', 'CONVENTIONS.md'], 'file');
}

/** The deploy-context doc: `.orchard/DEPLOY-CONTEXT.md` if present, else legacy `docs/DEPLOY-CONTEXT.md`. */
export function resolveDeployContextFile(hostPath) {
  const root = requireHostPath(hostPath, 'resolveDeployContextFile');
  return resolveOrchardFirst(root, ['DEPLOY-CONTEXT.md'], ['docs', 'DEPLOY-CONTEXT.md'], 'file');
}

/** The response-format Stop hook: `.orchard/hooks/...` if present, else legacy `scripts/hooks/...`. */
export function resolveStopHookFile(hostPath) {
  const root = requireHostPath(hostPath, 'resolveStopHookFile');
  return resolveOrchardFirst(
    root,
    ['hooks', 'response-format-gate.mjs'],
    ['scripts', 'hooks', 'response-format-gate.mjs'],
    'file',
  );
}
