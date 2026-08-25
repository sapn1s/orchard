/**
 * Cross-OS session forking.
 *
 * THE PROBLEM
 * -----------
 * The Claude CLI resolves `--resume <id>` inside ONE directory: the store dir
 * for its own cwd (`~/.claude/projects/<cwd with every non-alphanumeric -> '-'>`).
 * This user dual-boots, so the same logical project has several store dirs:
 *
 *     C--Users-alice-Documents-GitHub-Example-App   (recorded on Windows)
 *     -home-alice-projects-Example-App              (recorded on Linux)
 *     -workspace-<project-id>                       (recorded in a container)
 *
 * Asking the SDK to fork a Windows-recorded id from a Linux cwd therefore fails:
 * the file exists, just not where the CLI looks, and the failure surfaces as a
 * bare `error_during_execution`.
 *
 * THE FIX (verified working — see the report)
 * -------------------------------------------
 * Stage a COPY of the source transcript into the target project's own store dir
 * under a fresh uuid, then fork from that. The CLI finds it, replays it, and
 * writes a brand-new session file of its own; observed empirically:
 *
 *   - the fork's file is self-contained (full history + the new turn), and
 *   - the CLI itself rewrites `cwd` and `sessionId` on every replayed entry, so
 *     the fork correctly claims the Linux path and is NOT mis-detected as a
 *     Windows session downstream.
 *
 * Because the CLI normalises the content, the staged copy is a BYTE-EXACT copy —
 * nothing in this module edits transcript content.
 *
 * THE ORIGINAL IS NEVER TOUCHED. It is only ever read (copyFileSync source side),
 * and the CLI only ever writes to the staged copy's directory. The staged copy is
 * deleted once the fork has written its own file.
 *
 * DUPLICATES
 * ----------
 * The real store contains byte-identical duplicates of the same session id under
 * several dirs. Resolution therefore NEVER guesses: it uses the `encodedDir` the
 * caller supplies. When the caller omits it we fall back to a scan, and that scan
 * refuses to pick when the candidates differ in content — it fails loudly and asks
 * for an explicit encodedDir rather than silently forking the wrong history.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as hist from '../lib/session-history.ts';
import { containerWorkdir, encodeCwdForStore } from './container-manager.ts';
import { resolveOrchardSessionFile } from './orchard-transcripts.ts';
import { pastPathsOf, type Project } from './registry.ts';

export class ForkError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ForkError';
    this.code = code;
  }
}

export interface ForkPlan {
  /** The id to hand the SDK as `resume` (with forkSession). */
  resumeSessionId: string;
  /** Absolute path of the staged copy, or null when no staging was needed. */
  stagedFile: string | null;
  /** Absolute path of the ORIGINAL, for the never-mutated assertion. */
  sourceFile: string;
  sourceEncodedDir: string;
  targetEncodedDir: string;
  bytes: number;
  /** How sourceEncodedDir was determined. */
  resolvedBy: 'caller' | 'target-dir' | 'scan';
}

/** The store dir the CLI will actually look in for this project's sessions. */
export function targetEncodedDirFor(project: Project): string {
  const cwd = project.isolation === 'container' ? containerWorkdir(project.id) : project.hostPath;
  return encodeCwdForStore(cwd);
}

function storeRoot(): string {
  return hist.defaultRoot();
}

/**
 * Find every store dir holding `<sessionId>.jsonl`. Used only when the caller did
 * not tell us where the session came from.
 */
function scanForSession(sessionId: string): { encodedDir: string; file: string; size: number; sha256: string }[] {
  const root = storeRoot();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: { encodedDir: string; file: string; size: number; sha256: string }[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const file = hist.resolveSessionFile(e.name, sessionId, { root });
    if (!file) continue;
    const buf = fs.readFileSync(file);
    out.push({
      encodedDir: e.name,
      file,
      size: buf.length,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    });
  }
  return out;
}

/**
 * Work out how to fork `resumeSessionId` into `project`, staging a copy of the
 * transcript into the project's own store dir when the source lives elsewhere.
 *
 * Throws ForkError with an actionable message rather than letting the SDK return
 * an opaque `error_during_execution`.
 */
export function planFork(
  project: Project,
  resumeSessionId: string,
  sourceEncodedDir?: string,
): ForkPlan {
  if (!/^[A-Za-z0-9._-]+$/.test(resumeSessionId)) {
    throw new ForkError('bad-session-id', `resumeSessionId ${JSON.stringify(resumeSessionId)} is not a valid session id`);
  }
  const root = storeRoot();
  const targetEncodedDir = targetEncodedDirFor(project);

  let srcDir: string | undefined = sourceEncodedDir;
  let resolvedBy: ForkPlan['resolvedBy'] = 'caller';

  if (srcDir) {
    if (!hist.resolveSessionFile(srcDir, resumeSessionId, { root })) {
      throw new ForkError(
        'source-missing',
        `fork: no session file ${resumeSessionId}.jsonl in ${path.join(root, srcDir)} (the encodedDir the client sent)`,
      );
    }
  } else if (hist.resolveSessionFile(targetEncodedDir, resumeSessionId, { root })) {
    // Already where the CLI looks — an ordinary same-OS fork.
    srcDir = targetEncodedDir;
    resolvedBy = 'target-dir';
  } else {
    const found = scanForSession(resumeSessionId);
    if (found.length === 0) {
      throw new ForkError(
        'source-missing',
        `fork: session ${resumeSessionId} is not in ${path.join(root, targetEncodedDir)} and no other store dir under ${root} has it either`,
      );
    }
    const hashes = new Set(found.map((f) => f.sha256));
    if (hashes.size > 1) {
      // Real divergence between copies. Picking one would be a coin flip on the
      // user's history, so refuse and name the candidates.
      throw new ForkError(
        'ambiguous-source',
        `fork: session ${resumeSessionId} exists in ${found.length} store dirs with DIFFERENT contents ` +
          `(${found.map((f) => `${f.encodedDir}:${f.size}B`).join(', ')}). ` +
          `Send resumeEncodedDir on the start command to say which one to fork.`,
      );
    }
    // Byte-identical duplicates across dirs are normal in this store — any copy
    // is the same history, so take the first deterministically.
    found.sort((a, b) => a.encodedDir.localeCompare(b.encodedDir));
    srcDir = found[0]!.encodedDir;
    resolvedBy = 'scan';
  }

  const sourceFile = hist.resolveSessionFile(srcDir, resumeSessionId, { root })!;
  const bytes = fs.statSync(sourceFile).size;

  if (srcDir === targetEncodedDir) {
    return { resumeSessionId, stagedFile: null, sourceFile, sourceEncodedDir: srcDir, targetEncodedDir, bytes, resolvedBy };
  }

  // Cross-dir: stage a byte-exact copy under a fresh id in the target dir.
  const targetDir = path.join(root, targetEncodedDir);
  fs.mkdirSync(targetDir, { recursive: true });
  const stagedId = crypto.randomUUID();
  const stagedFile = path.join(targetDir, `${stagedId}.jsonl`);
  // COPYFILE_EXCL: never clobber an existing transcript, even on a uuid collision.
  fs.copyFileSync(sourceFile, stagedFile, fs.constants.COPYFILE_EXCL);
  const staged = fs.statSync(stagedFile).size;
  if (staged !== bytes) {
    try {
      fs.unlinkSync(stagedFile);
    } catch {
      /* best effort */
    }
    throw new ForkError('stage-truncated', `fork: staged copy is ${staged}B but the source is ${bytes}B — refusing to fork a truncated history`);
  }

  return { resumeSessionId: stagedId, stagedFile, sourceFile, sourceEncodedDir: srcDir, targetEncodedDir, bytes, resolvedBy };
}

/**
 * BUG-090 — why a plain resume can't run, in a form the client can ACT on.
 *
 * When the id lives under a DIFFERENT (pre-isolation) store dir than this
 * project now resolves to, `fork` is populated with the machine-readable inputs
 * for a one-click fork: the source `resumeEncodedDir` (exactly the dir a
 * follow-up `planFork` will resolve) and a `cause` the UI turns into plain copy.
 * `message` is always a readable fallback. `fork` is absent when the session
 * simply doesn't exist anywhere (nothing to fork into).
 */
export interface UnresumableReason {
  message: string;
  fork?: { resumeEncodedDir: string; cause: 'isolation-changed' | 'cross-os' | 'path-changed' };
}

/**
 * Pre-flight a plain (non-fork) resume.
 *
 * The CLI resolves `--resume <id>` only inside its own cwd's store dir, so
 * resuming an id recorded elsewhere fails with a bare `error_during_execution`
 * and, one layer up, "No conversation found with session ID: …" — observed live
 * when a session selected under one project was resumed against another.
 *
 * Returns null when the resume will work. Otherwise returns a structured reason
 * that names where the session actually lives and, when recoverable, how to fork
 * it in one click (see BUG-090).
 */
export function explainUnresumable(project: Project, resumeSessionId: string): UnresumableReason | null {
  if (!/^[A-Za-z0-9._-]+$/.test(resumeSessionId)) {
    return { message: `resumeSessionId ${JSON.stringify(resumeSessionId)} is not a valid session id` };
  }
  const root = storeRoot();
  const targetEncodedDir = targetEncodedDirFor(project);
  if (hist.resolveSessionFile(targetEncodedDir, resumeSessionId, { root })) return null;
  /*
   * FEAT-037 P2b: an Orchard-owned transcript (Codex) is resumable too — not
   * via the Claude store, but via the engine's own thread/resume with this
   * very id; our file exists purely so history renders. The bridge's
   * provider-inference then routes the session to the right engine.
   */
  if (resolveOrchardSessionFile(targetEncodedDir, resumeSessionId)) return null;
  if (resolveOrchardSessionFile(hist.encodeCwd(project.hostPath), resumeSessionId)) return null;
  const found = scanForSession(resumeSessionId);
  if (!found.length) {
    return {
      message:
        `cannot resume ${resumeSessionId}: no transcript for it in ${path.join(root, targetEncodedDir)}, ` +
        `and no other store dir under ${root} has it either`,
    };
  }
  /*
   * BUG-090 — pick the source dir DETERMINISTICALLY, the same tie-break
   * planFork's scan uses, so the resumeEncodedDir we hand the client resolves to
   * exactly the file a subsequent fork will stage from.
   */
  const src = [...found].sort((a, b) => a.encodedDir.localeCompare(b.encodedDir))[0]!.encodedDir;
  /*
   * cause: the reported case is enabling the container, which changes the cwd
   * (host path → /workspace/<id>) and thus the store dir. Detect it by the
   * container encoding on either side; anything else (a Windows-origin dir on a
   * dual-boot machine, say) is cross-OS.
   */
  const containerDir = encodeCwdForStore(containerWorkdir(project.id));
  /*
   * BUG-138 — a THIRD cause, and the one that used to be mislabelled: the
   * project was repointed after its directory was renamed, so its older
   * sessions are recorded against the path it had before. That is not a
   * cross-OS copy and saying so sent the reader looking for a Windows checkout
   * that does not exist. The registry knows the old paths, so name the rename.
   */
  const pastDirs = new Set(pastPathsOf(project).map((q) => hist.encodeCwd(q)));
  const fromPast = found.some((f) => pastDirs.has(f.encodedDir));
  const cause: 'isolation-changed' | 'cross-os' | 'path-changed' =
    project.isolation === 'container' || targetEncodedDir === containerDir || found.some((f) => f.encodedDir === containerDir)
      ? 'isolation-changed'
      : fromPast
        ? 'path-changed'
        : 'cross-os';
  return {
    message:
      `cannot resume ${resumeSessionId} in project "${project.id}": the CLI only looks in ${targetEncodedDir}, ` +
      `but that session was recorded under ${found.map((f) => f.encodedDir).join(', ')}` +
      (cause === 'path-changed'
        ? ` — it ran before this project's directory was renamed to ${project.hostPath}. The transcript is intact and still listed here; the CLI just cannot continue a conversation in a directory that no longer exists under that name. `
        : '. ') +
      `Fork it instead (start with fork:true and resumeEncodedDir), which branches it into this project without touching the original.`,
    fork: { resumeEncodedDir: src, cause },
  };
}

/** Remove a staged copy. Safe to call repeatedly and after the file is gone. */
export function discardStaged(stagedFile: string | null): boolean {
  if (!stagedFile) return false;
  try {
    fs.unlinkSync(stagedFile);
    return true;
  } catch {
    return false;
  }
}
