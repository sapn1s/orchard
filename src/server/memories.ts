/**
 * Agent memories — list, read, delete. Deliberately NOT an editor: memories
 * are markdown files a real editor handles better; the missing capability is
 * SEEING what has accumulated and pruning it. Memories are what Claude
 * concluded (vs CLAUDE.md — what the user said), auto-loaded into every
 * session, and they drift silently; one real project here carries 42 of them.
 *
 * Location: <store root>/<encodedDir>/memory/*.md with a MEMORY.md index.
 * Windows-origin dirs have memory dirs too and are included.
 *
 * ONE MEMORY DIR PER PROJECT, ACROSS ISOLATION MODES (BUG-215 r3, ARCH-010).
 * A project's session-store dir NAME is a function of the CLI's cwd, which is
 * the host path when the project runs `direct` (`-home-…-proj`) but
 * `/workspace/<id>` when it runs in a `container` (`-workspace-<id>`). Memory is
 * scoped to that dir, so switching isolation (or forking across it) used to
 * strand the accumulated memory in the other encoding's dir — the user saw a
 * forked container→direct session start "without my notes". The fix declares a
 * SINGLE canonical memory dir per project (`canonicalMemoryDir`, anchored on the
 * container store dir because the containerised CLI can only write there — its
 * store is bind-mounted from `containerHistoryDir`, a constraint that cannot
 * change without recreating every container) and makes the host/direct
 * encoding's `memory` a SYMLINK to it (`ensureUnifiedMemoryDir`, run at session
 * start). One physical dir; no second place able to hold a different answer.
 *
 * Deletion runs under the same discipline as session delete: byte-verified
 * backup into the app's own data dir FIRST (never littering ~/.claude), then
 * unlink; the MEMORY.md index line pointing at the file is removed too (a
 * dangling pointer would mislead every future session), with MEMORY.md itself
 * backed up before the edit.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dataDir, backupFileTo } from '../lib/paths.ts';
import { defaultRoot, encodeCwd } from '../lib/session-history.ts';
import { containerStoreDirName } from './container-manager.ts';
import type { Project } from './registry.ts';

export interface MemoryFile {
  dir: string;          // encodedDir the memory belongs to
  name: string;         // basename, e.g. "user-prefers-tabs.md"
  bytes: number;
  mtimeMs: number;
  /** From frontmatter when present — the recall hook. */
  description: string | null;
  type: string | null;  // user | feedback | project | reference | null
  isIndex: boolean;     // true for MEMORY.md
}

export class MemoryError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function memDirOf(encodedDir: string): string {
  return path.join(defaultRoot(), encodedDir, 'memory');
}

/**
 * ARCH-010 owner of the fact "where project P's agent memory lives" — declared
 * here, in one place, read everywhere else. Anchored on the CONTAINER store dir
 * (`-workspace-<id>/memory`), NOT on the current isolation mode, so it is stable
 * across an isolation change: the containerised CLI can only write memory into
 * its store dir (bind-mounted from `containerHistoryDir`), and that host side of
 * the bind cannot move without recreating every container — so this is the one
 * dir both modes can share. The host/`direct` encoding's `memory` is a symlink
 * to it (see `ensureUnifiedMemoryDir`). Routed through `defaultRoot()` so it
 * honours `CLAUDE_PROJECTS_DIR` (tests, alternate stores).
 */
export function canonicalMemoryDir(project: Pick<Project, 'id'>): string {
  return path.join(defaultRoot(), containerStoreDirName(project), 'memory');
}

export interface MemoryUnifyReport {
  /** The single physical dir memory now lives in. */
  canonical: string;
  /** The host/direct-encoded memory path now symlinked to `canonical`, or null when it already was (or is) the canonical dir. */
  linkedFrom: string | null;
  /** Files moved from the host-encoded dir into `canonical` on first unification. */
  merged: string[];
  /** Name clashes where BOTH copies were kept (host copy renamed) — never a loss. */
  conflicts: { name: string; keptAs: string }[];
  /** True when the host-encoded dir was already the canonical symlink — a no-op. */
  alreadyLinked: boolean;
}

const sha256File = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/**
 * Make the project's host/`direct`-encoded `memory` dir a symlink to the single
 * canonical dir, merging any files it already holds into the canonical dir
 * first. NEVER loses a file: an identical duplicate is dropped (same bytes), a
 * true name clash keeps BOTH (the host copy is renamed and reported). Idempotent
 * and safe to call on every session start, in any isolation mode.
 *
 * Does nothing when the host encoding already IS the canonical dir (e.g. a
 * project whose host path encodes to the container store name), or when the
 * symlink is already in place.
 */
export function ensureUnifiedMemoryDir(project: Pick<Project, 'id'> & { hostPath: string }): MemoryUnifyReport {
  const canonical = canonicalMemoryDir(project);
  const hostEnc = memDirOf(encodeCwd(project.hostPath));
  const report: MemoryUnifyReport = { canonical, linkedFrom: null, merged: [], conflicts: [], alreadyLinked: false };

  // The two encodings coincide (host path already encodes to the container store
  // dir) — there is only ever one dir; nothing to link.
  if (path.resolve(hostEnc) === path.resolve(canonical)) return report;

  let hostStat: fs.Stats | null = null;
  try { hostStat = fs.lstatSync(hostEnc); } catch { hostStat = null; }

  // Already our symlink pointing at the canonical dir → no-op.
  if (hostStat?.isSymbolicLink()) {
    let target: string | null = null;
    try { target = fs.realpathSync(hostEnc); } catch { target = null; }
    let canonReal: string | null = null;
    try { canonReal = fs.realpathSync(canonical); } catch { canonReal = null; }
    if (target && canonReal && target === canonReal) {
      report.alreadyLinked = true;
      return report;
    }
    // A symlink pointing somewhere else: merge whatever it resolves to, then
    // repoint. (Not expected in practice; handled so we never strand memory.)
    fs.mkdirSync(canonical, { recursive: true });
    if (target) mergeInto(target, canonical, encodeCwd(project.hostPath), report);
    fs.rmSync(hostEnc, { force: true });
    fs.symlinkSync(canonical, hostEnc);
    report.linkedFrom = hostEnc;
    return report;
  }

  fs.mkdirSync(canonical, { recursive: true });

  if (hostStat?.isDirectory()) {
    mergeInto(hostEnc, canonical, encodeCwd(project.hostPath), report);
    // The dir is now empty of the files we could move; remove it so we can put a
    // symlink in its place. If anything unexpected remains (a subdir we did not
    // move), leave the dir untouched rather than risk a loss, and do NOT link.
    let remaining: string[] = [];
    try { remaining = fs.readdirSync(hostEnc); } catch { remaining = []; }
    if (remaining.length > 0) return report;
    fs.rmdirSync(hostEnc);
  }

  fs.symlinkSync(canonical, hostEnc);
  report.linkedFrom = hostEnc;
  return report;
}

/** Move every file from `src` into `dst`, never overwriting: exact dups are dropped, true clashes keep both. */
function mergeInto(src: string, dst: string, srcEncoding: string, report: MemoryUnifyReport): void {
  let names: string[] = [];
  try { names = fs.readdirSync(src); } catch { return; }
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '');
  for (const name of names) {
    const from = path.join(src, name);
    let st: fs.Stats;
    try { st = fs.lstatSync(from); } catch { continue; }
    if (!st.isFile()) continue; // only flat *.md files; leave anything odd in place
    const to = path.join(dst, name);
    if (!fs.existsSync(to)) {
      fs.renameSync(from, to);
      report.merged.push(name);
      continue;
    }
    // Destination exists. Identical bytes → the same memory, drop the dup.
    let same = false;
    try { same = sha256File(from) === sha256File(to); } catch { same = false; }
    if (same) { fs.rmSync(from, { force: true }); continue; }
    // True clash: keep BOTH. Rename the host copy so nothing is lost.
    const ext = path.extname(name);
    const base = name.slice(0, name.length - ext.length);
    const keptAs = `${base}.from-${srcEncoding}-${stamp}${ext}`;
    fs.renameSync(from, path.join(dst, keptAs));
    report.conflicts.push({ name, keptAs });
    report.merged.push(keptAs);
  }
}

/** Resolve + validate a memory file path. Throws 400/404 — never escapes. */
function resolveMemory(encodedDir: string, name: string): string {
  if (!name.endsWith('.md') || name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new MemoryError(400, `memories: invalid file name ${JSON.stringify(name)}`);
  }
  const dir = memDirOf(encodedDir);
  const file = path.join(dir, name);
  if (path.dirname(file) !== dir) throw new MemoryError(400, 'memories: name escapes the memory dir');
  if (!fs.existsSync(file)) throw new MemoryError(404, `memories: no ${name} under ${encodedDir}`);
  return file;
}

function frontmatterOf(file: string): { description: string | null; type: string | null } {
  let head = '';
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(2048);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    head = buf.toString('utf8', 0, n);
  } catch {
    return { description: null, type: null };
  }
  if (!head.startsWith('---')) return { description: null, type: null };
  const description = /^description:\s*(.+)$/m.exec(head)?.[1]?.trim() ?? null;
  const type = /^\s*type:\s*(\S+)/m.exec(head)?.[1] ?? null;
  return { description, type };
}

/** Every memory file across the given store dirs. Missing dirs are simply empty. */
export function listMemories(encodedDirs: string[]): MemoryFile[] {
  const out: MemoryFile[] = [];
  // BUG-215 r3 — after unification the host-encoded and container-store encodings
  // resolve to the SAME physical dir (one is a symlink to the other). Read each
  // physical dir once, keyed by its realpath, so a project's memory is not listed
  // twice. Distinct dirs (Windows origins, un-unified projects) still each show.
  const seenReal = new Set<string>();
  for (const d of encodedDirs) {
    const dir = memDirOf(d);
    let real: string;
    try { real = fs.realpathSync(dir); } catch { continue; }
    if (seenReal.has(real)) continue;
    seenReal.add(real);
    let names: string[] = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.md')); } catch { continue; }
    for (const name of names.sort()) {
      let st: fs.Stats;
      try { st = fs.statSync(path.join(dir, name)); } catch { continue; }
      if (!st.isFile()) continue;
      out.push({
        dir: d, name, bytes: st.size, mtimeMs: st.mtimeMs,
        ...frontmatterOf(path.join(dir, name)),
        isIndex: name === 'MEMORY.md',
      });
    }
  }
  // Index first per dir, then newest first — pruning starts from what changed last.
  out.sort((a, b) => a.dir.localeCompare(b.dir) || Number(b.isIndex) - Number(a.isIndex) || b.mtimeMs - a.mtimeMs);
  return out;
}

export function readMemory(encodedDir: string, name: string): { content: string; bytes: number } {
  const file = resolveMemory(encodedDir, name);
  const content = fs.readFileSync(file, 'utf8');
  return { content, bytes: Buffer.byteLength(content) };
}

const sha256 = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

export interface MemoryDeleteReport {
  deleted: string;
  backup: { path: string; bytes: number; verified: true };
  /** Set when a MEMORY.md line pointing at the file was removed as well. */
  indexEdited: { path: string; removedLines: number; backup: string } | null;
}

export function deleteMemory(encodedDir: string, name: string): MemoryDeleteReport {
  if (name === 'MEMORY.md') {
    // The index is regenerated/maintained by Claude; deleting it while entries
    // remain would orphan every memory. Refuse with the reason.
    throw new MemoryError(400, 'memories: MEMORY.md is the index — delete the individual memories instead');
  }
  const file = resolveMemory(encodedDir, name);
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '');
  const destDir = path.join(dataDir(), 'deleted-memories', encodedDir);
  const srcHash = sha256(file);
  const bak = backupFileTo(file, destDir, `${stamp}-${name}`);
  if (sha256(bak.path) !== srcHash || bak.bakBytes !== bak.srcBytes) {
    throw new MemoryError(500, `memories: refusing to delete ${name} — backup at ${bak.path} is not byte-identical`);
  }
  fs.unlinkSync(file);

  // Drop the index pointer, if MEMORY.md exists and references the file.
  let indexEdited: MemoryDeleteReport['indexEdited'] = null;
  const indexPath = path.join(memDirOf(encodedDir), 'MEMORY.md');
  try {
    const idx = fs.readFileSync(indexPath, 'utf8');
    const lines = idx.split('\n');
    const kept = lines.filter((l) => !l.includes(`(${name})`) && !l.includes(`(./${name})`));
    if (kept.length !== lines.length) {
      const idxBak = backupFileTo(indexPath, destDir, `${stamp}-MEMORY.md`);
      fs.writeFileSync(indexPath, kept.join('\n'));
      indexEdited = { path: indexPath, removedLines: lines.length - kept.length, backup: idxBak.path };
    }
  } catch { /* no index — nothing to edit */ }

  return { deleted: file, backup: { path: bak.path, bytes: bak.bakBytes, verified: true }, indexEdited };
}
