#!/usr/bin/env node
/**
 * gate.mjs — THE sanctioned pre-commit safety gate (BUG-102).
 *
 *   npm run gate
 *
 * Runs the deterministic, fail-closed pre-commit gates a worker must pass
 * before committing — the same mechanical pre-steps the FEAT-050 gatekeeper
 * runs independently: the private-token leak-gate, then `typecheck` (if the
 * repo declares one). It prints its OWN short, human-readable, one-line-per-gate
 * summary and exits with the TRUE aggregate status (0 = all PASS, 1 = any FAIL).
 *
 * Why this exists (BUG-102): a shell pipeline's exit status is the LAST
 * command's, so `node scripts/leak-gate.mjs 2>&1 | tail -1` ALWAYS exits 0 —
 * even on FAIL — and any `gate && git commit` guard proceeds on a leak. That
 * happened live, twice, in one session. The fix is to make the READABLE
 * invocation and the CORRECT-EXIT invocation the SAME invocation: this wrapper
 * is already short (nobody needs to pipe it for readability) and it consumes
 * each gate's exit STATUS via spawnSync().status — never a shell pipe — so
 * status can never be masked here by construction.
 *
 * Read the exit code directly. Do NOT pipe this into tail/head/grep. If you
 * truly must pipe for some reason, use `${PIPESTATUS[0]}` or `set -o pipefail`
 * (both verified to propagate this gate's failure — see BUG-102 worker log),
 * but the whole point is that you never need to.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
// Resolve the sub-gates as SIBLINGS of this file (FEAT-106), not as ROOT/scripts.
// Identical in Orchard's own tree (HERE === <orchard>/scripts) and correct under
// a flat `.orchard/` layout where gate.mjs, leak-gate.mjs and check-nul.mjs are
// all direct children of `.orchard/`. repoRoot() below still shells `git
// rev-parse` with cwd: ROOT, which resolves at any nesting.
const LEAK_GATE = path.join(HERE, 'leak-gate.mjs');
const CHECK_NUL = path.join(HERE, 'check-nul.mjs');

/** Repo root (so the gate scans the right tree even when invoked from a subdir). */
function repoRoot() {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : ROOT;
}
const REPO = repoRoot();

const results = [];

/* 1. leak-gate — REPO mode (no path arg), --summary so a FAIL is readable here
 *    without anyone piping it. Its exit STATUS is the source of truth. */
{
  const r = spawnSync(process.execPath, [LEAK_GATE, '--summary'], {
    cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const ok = r.status === 0;
  const out = ((ok ? r.stdout : (r.stderr + r.stdout)) || '').trim();
  results.push({ name: 'leak-gate', ok, detail: out });
}

/* 2. check-nul — a raw NUL byte in a tracked TEXT file makes the Bash `grep` shim
 *    (ugrep -I) skip it SILENTLY (empty result == "no matches"), a confident false
 *    negative that cost a real investigation (BUG-103). Its exit STATUS is truth. */
{
  const r = spawnSync(process.execPath, [CHECK_NUL], {
    cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const ok = r.status === 0;
  const out = ((r.stdout || '') + (ok ? '' : (r.stderr || ''))).trim();
  results.push({ name: 'check-nul', ok, detail: out });
}

/* 3. typecheck, if the repo declares one (mirrors gatekeeper's mechanical set). */
{
  let hasTypecheck = false;
  try {
    hasTypecheck = Boolean(JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'))?.scripts?.typecheck);
  } catch { /* no/bad package.json */ }
  if (hasTypecheck) {
    const r = spawnSync('npm', ['run', '--silent', 'typecheck'], {
      cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    const ok = r.status === 0;
    results.push({ name: 'typecheck', ok, detail: ok ? 'clean' : `exit ${r.status}\n${(r.stdout + r.stderr).trim()}` });
  } else {
    results.push({ name: 'typecheck', ok: true, detail: 'SKIPPED — repo declares no `typecheck` script' });
  }
}

/* ---- summary + true aggregate exit status ---- */
const failed = results.filter((x) => !x.ok);
console.log('=== npm run gate — pre-commit safety gate (BUG-102) ===');
for (const x of results) {
  console.log(`  ${x.ok ? 'PASS' : 'FAIL'}  ${x.name}`);
  if (!x.ok || x.detail.startsWith('SKIPPED')) {
    for (const line of x.detail.split('\n')) console.log(`        ${line}`);
  } else {
    // A PASS is normally silent. The ONE exception is a gate that deliberately
    // WAIVED a hit (FEAT-049's licence copyright line): a waiver that only
    // shows up when you run the underlying gate by hand is a waiver nobody
    // reviews, and this gate's whole job is that publishing is irreversible.
    for (const line of x.detail.split('\n')) {
      if (/\bwaived\b/.test(line)) console.log(`        ${line.trim()}`);
    }
  }
}
if (failed.length) {
  console.log(`\nGATE: FAIL — ${failed.map((x) => x.name).join(', ')}. Do NOT commit. (exit 1)`);
  process.exit(1);
}
console.log('\nGATE: PASS — safe to commit. (exit 0)');
process.exit(0);
