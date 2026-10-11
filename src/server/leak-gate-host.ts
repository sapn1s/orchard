/**
 * FEAT-156 — the host side of the leak gate: which gate runs, for which project.
 *
 * Both commit-blocking host paths (the dashboard commit in git.ts and the agent
 * git-write guard `runLeakGateForRepo`, which also serves the git-shim decide
 * route) run ORCHARD's `scripts/leak-gate.mjs` against a target repo. This module
 * is the one place that:
 *
 *  1. names that gate (so a refusal can say which copy ran — the target repo's
 *     own onboarded `scripts/leak-gate.mjs` is a stale local preflight), and
 *  2. resolves the target repo to its registered project(s) via the REGISTRY —
 *     the owner of project identity (ARCH-010) — and hands the registered
 *     name(s) to the gate as `--own-project=<name>`. The gate then waives only a
 *     PROJECT-kind token that matches both that name and the repo directory
 *     (scripts/lib/leak-tokens.mjs ownProjectTokens). No association between a
 *     private project and a token is written anywhere in Orchard's tracked
 *     files: it is the join of the user's registry (user state) and the list.
 *
 * Fail-safe direction: any failure to resolve (registry unreadable, repo not a
 * git repo, no registered project at exactly this path, or MORE than one
 * registered project on it) yields NO names — i.e. no exemption, never a wider
 * one. It can only ever make the gate stricter.
 */
import { execFileSync, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listProjects } from './registry.ts';

const ORCHARD_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Absolute path of the gate the host runs — always Orchard's, never the target's copy. */
export function hostLeakGatePath(): string {
  return path.join(ORCHARD_ROOT, 'scripts', 'leak-gate.mjs');
}

function realOrNull(p: string): string | null {
  try { return fs.realpathSync(p); } catch { return null; }
}

/**
 * The registered name(s) of the ONE project whose hostPath is exactly this
 * repo's git toplevel (both realpath'd). Returns [] on any doubt.
 */
export function ownProjectNamesFor(repoPath: string | null | undefined): string[] {
  if (!repoPath) return [];
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: repoPath, encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const realTop = top ? realOrNull(top) : null;
    if (!realTop) return [];
    const owners = listProjects().filter((p) => p.hostPath && realOrNull(p.hostPath) === realTop);
    // Two registered projects on one real directory is ambiguous (e.g. a
    // symlink alias registered beside the real one) — grant nothing.
    if (owners.length !== 1) return [];
    return owners[0].name ? [owners[0].name] : [];
  } catch {
    return [];
  }
}

/** The `--own-project=` args for a repo (empty when it has no unambiguous owner). */
export function ownProjectArgs(repoPath: string | null | undefined): string[] {
  return ownProjectNamesFor(repoPath).map((n) => `--own-project=${n}`);
}

/**
 * BUG-249 r2 — `git`, async. A promisified `execFile` that optionally writes `input` to the
 * child's stdin, so every git read on the git-write decide/hook hot path (fingerprint +
 * own-project resolution) runs OFF the event loop, exactly as the leak-gate scan now does.
 * Same cwd / timeout / maxBuffer as the synchronous `git` in `repoContentFingerprint`.
 */
function gitAsync(repoPath: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const cp = execFile('git', args, {
      cwd: repoPath, encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024 * 1024,
    }, (err, stdout) => { if (err) reject(err); else resolve(stdout as string); });
    // End stdin either way: feed `hash-object --stdin-paths`, and keep a git that ignores
    // stdin from ever waiting on an open pipe.
    try { cp.stdin?.end(input === undefined ? '' : input); } catch { /* child already gone */ }
  });
}

/** BUG-249 r2 — async twin of `ownProjectNamesFor`: the single `git rev-parse` runs
 * off-loop. The registry/realpath lookups are O(1), fs-metadata only (not tree-size
 * dependent), so they stay synchronous. Same [] -on-any-doubt fail-safe. */
export async function ownProjectNamesForAsync(repoPath: string | null | undefined): Promise<string[]> {
  if (!repoPath) return [];
  try {
    const top = (await gitAsync(repoPath, ['rev-parse', '--show-toplevel'])).trim();
    const realTop = top ? realOrNull(top) : null;
    if (!realTop) return [];
    const owners = listProjects().filter((p) => p.hostPath && realOrNull(p.hostPath) === realTop);
    if (owners.length !== 1) return [];
    return owners[0].name ? [owners[0].name] : [];
  } catch {
    return [];
  }
}

/** BUG-249 r2 — async twin of `ownProjectArgs`. */
export async function ownProjectArgsAsync(repoPath: string | null | undefined): Promise<string[]> {
  return (await ownProjectNamesForAsync(repoPath)).map((n) => `--own-project=${n}`);
}

/**
 * Prefix for every host-side gate refusal: which gate ran, and that it — not
 * the repo's own copy — is the authoritative one for this commit.
 */
export function hostGateBanner(): string {
  return `Orchard host leak gate (${hostLeakGatePath()}) — authoritative for this commit; a repo-local scripts/leak-gate.mjs is only a preflight.`;
}

/**
 * Cap gate output for a refusal/response WITHOUT losing its tail: the tail
 * carries the "how to resolve" footer and the FAIL summary, which a head-only
 * slice cut off.
 */
export function capGateOutput(out: string, max = 2400): string {
  if (out.length <= max) return out;
  const head = Math.floor(max * 0.55);
  const tail = max - head;
  return `${out.slice(0, head)}\n… (${out.length - max} chars elided) …\n${out.slice(-tail)}`;
}

/**
 * The gate's stdout on a PASS: the ran-line, own-project/allowlist notes, every
 * waived hit and the PASS summary. Surfaced by the callers so a waiver is never
 * silent on the host paths (it used to be dropped with the rest of stdout).
 */
export function passReport(stdout: string): string {
  return stdout.trim();
}

/**
 * BUG-231 — what the host leak gate scans in a repo, as a fingerprint:
 * `{ head, entries }`, where entries are `path:blob` for every index entry and for
 * every working-tree file that differs from the index or is untracked (not ignored),
 * hashed WITHOUT writing objects (`git hash-object` without -w). The PreToolUse hook
 * records it after a passing gate; the shim skips its write-time re-gate only when the
 * content then is the same HEAD and a subset of these entries, because a token-scan
 * gate cannot newly fail on content it already passed. Read-only; any failure → null
 * (the shim then simply gates again).
 */
/**
 * BUG-231 r7 — a hash of the gate-verdict inputs that are NOT part of the repo content
 * fingerprint, so the shim's content-fingerprint skip (below / git-grant.mjs
 * fingerprintCovered) cannot run an ungated commit after the gate's verdict changed for
 * byte-identical content. The leak gate's verdict is a pure function of the committed
 * content PLUS: the gate script bytes (scripts/leak-gate.mjs), the token-list module bytes
 * (scripts/lib/leak-tokens.mjs — it has no further imports, so this is its full config
 * closure), and the resolved `--own-project` names (registry state). The per-repo
 * `.leakgate-allow` waiver file is deliberately NOT hashed here: the gate reads it from the
 * git INDEX, which the content fingerprint already captures as an index entry. ANY read
 * failure → null, which forces the shim to re-gate (fail toward running the gate). The
 * own-project resolution (ownProjectArgs) never throws (it returns [] on any doubt). Never
 * throws.
 */
export function gateVerdictKey(repoPath: string | null | undefined): string | null {
  try {
    const h = createHash('sha256');
    h.update('gate\0');
    h.update(fs.readFileSync(hostLeakGatePath()));
    h.update('\0list\0');
    h.update(fs.readFileSync(path.join(ORCHARD_ROOT, 'scripts', 'lib', 'leak-tokens.mjs')));
    h.update('\0own\0');
    for (const a of ownProjectArgs(repoPath)) { h.update(a); h.update('\0'); }
    return h.digest('hex');
  } catch {
    return null;
  }
}

export function repoContentFingerprint(repoPath: string | null | undefined): { head: string; entries: string[]; gateKey: string | null } | null {
  if (!repoPath) return null;
  const git = (args: string[], input?: string): string => execFileSync('git', args, {
    cwd: repoPath, encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024 * 1024,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'], ...(input === undefined ? {} : { input }),
  });
  try {
    let head = '';
    try { head = git(['rev-parse', '-q', '--verify', 'HEAD']).trim(); } catch { head = ''; }
    const entries: string[] = [];
    for (const line of git(['ls-files', '-s', '-z']).split('\0')) {
      const m = /^\d+ ([0-9a-f]+) \d+\t(.*)$/s.exec(line);
      if (m) entries.push(`${m[2]}:${m[1]}`);
    }
    const changed = [
      ...git(['diff', '--name-only', '-z']).split('\0'),
      ...git(['ls-files', '-o', '--exclude-standard', '-z']).split('\0'),
    ].filter((p) => p && fs.existsSync(path.join(repoPath, p)) && fs.lstatSync(path.join(repoPath, p)).isFile());
    if (changed.length) {
      const hashes = git(['hash-object', '--stdin-paths'], `${changed.join('\n')}\n`).trim().split('\n');
      if (hashes.length !== changed.length) return null;
      changed.forEach((p, k) => entries.push(`${p}:${hashes[k]}`));
    }
    // BUG-231 r7 — carry the gate-verdict config key alongside the content, so the shim's
    // skip is gated on BOTH being unchanged since the hook gated (git-grant.mjs
    // fingerprintCovered). A null key forces a re-gate.
    return { head, entries, gateKey: gateVerdictKey(repoPath) };
  } catch {
    return null;
  }
}

/**
 * BUG-249 r2 — async twin of `gateVerdictKey`. Byte-for-byte the SAME digest as the sync
 * version for the same state (same inputs, same order), so a fingerprint captured on the
 * async path compares equal to one captured on the sync path. The two small config-file
 * reads and the own-project `git rev-parse` all run off the event loop.
 */
export async function gateVerdictKeyAsync(repoPath: string | null | undefined): Promise<string | null> {
  try {
    const h = createHash('sha256');
    h.update('gate\0');
    h.update(await fs.promises.readFile(hostLeakGatePath()));
    h.update('\0list\0');
    h.update(await fs.promises.readFile(path.join(ORCHARD_ROOT, 'scripts', 'lib', 'leak-tokens.mjs')));
    h.update('\0own\0');
    for (const a of await ownProjectArgsAsync(repoPath)) { h.update(a); h.update('\0'); }
    return h.digest('hex');
  } catch {
    return null;
  }
}

/**
 * BUG-249 r2 — async twin of `repoContentFingerprint`, the heavy read on the git-write
 * decide/hook hot path. The original ran `git ls-files -s`, `git diff`, `git ls-files -o`
 * and `git hash-object --stdin-paths` (hashing every changed/untracked file) PLUS an
 * `fs.*Sync` stat per candidate — all synchronously, so on a large repo it froze the single
 * process ~930ms PER CAPTURE, and the hook/shim capture it pre- AND post-gate (BUG-249 r1
 * break: the scan went async but this did not). This twin produces the IDENTICAL
 * `{ head, entries, gateKey }` with every git read via `gitAsync` and every stat via
 * `fs.promises.lstat` (candidates stat'd in parallel, order preserved so the hash-object
 * zip stays consistent), so none of it blocks the loop. Read-only; any failure → null.
 */
export async function repoContentFingerprintAsync(repoPath: string | null | undefined): Promise<{ head: string; entries: string[]; gateKey: string | null } | null> {
  if (!repoPath) return null;
  try {
    let head = '';
    try { head = (await gitAsync(repoPath, ['rev-parse', '-q', '--verify', 'HEAD'])).trim(); } catch { head = ''; }
    const entries: string[] = [];
    for (const line of (await gitAsync(repoPath, ['ls-files', '-s', '-z'])).split('\0')) {
      const m = /^\d+ ([0-9a-f]+) \d+\t(.*)$/s.exec(line);
      if (m) entries.push(`${m[2]}:${m[1]}`);
    }
    const candidates = [
      ...(await gitAsync(repoPath, ['diff', '--name-only', '-z'])).split('\0'),
      ...(await gitAsync(repoPath, ['ls-files', '-o', '--exclude-standard', '-z'])).split('\0'),
    ].filter((p) => p);
    const isFile = await Promise.all(candidates.map(async (p) => {
      try { return (await fs.promises.lstat(path.join(repoPath, p))).isFile(); } catch { return false; }
    }));
    const changed = candidates.filter((_, k) => isFile[k]);
    if (changed.length) {
      const hashes = (await gitAsync(repoPath, ['hash-object', '--stdin-paths'], `${changed.join('\n')}\n`)).trim().split('\n');
      if (hashes.length !== changed.length) return null;
      changed.forEach((p, k) => entries.push(`${p}:${hashes[k]}`));
    }
    return { head, entries, gateKey: await gateVerdictKeyAsync(repoPath) };
  } catch {
    return null;
  }
}
