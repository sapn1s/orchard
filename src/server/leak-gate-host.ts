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
import { execFileSync } from 'node:child_process';
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
