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
import { defaultRoot } from '../lib/session-history.ts';

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
  for (const d of encodedDirs) {
    const dir = memDirOf(d);
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
