#!/usr/bin/env node
/**
 * test-runner.mjs — `npm test` (FEAT-033).
 *
 * THE runner nobody had: runs the verify suites, by tier, with bounded
 * parallelism, a per-suite timeout, captured logs, a summary table, and a
 * TRUE aggregate exit status (0 = all pass/skip, 1 = any fail/timeout).
 *
 * It reads the tier of each suite from scripts/test-manifest.json (the ONE owner
 * of that fact, ARCH-010 — regenerate with gen-test-manifest.mjs). It never
 * re-derives a tier, and it FAILS LOUDLY if a `verify*` npm script exists that the
 * manifest does not classify (a new suite nobody tiered).
 *
 * Tiers and defaults:
 *   default run           = pure + scratch-server   (local-safe, no browser/docker/live)
 *   --tier a,b,c          = run exactly these tiers
 *   --all                 = pure,scratch-server,browser,docker-sandbox (NOT host-live)
 *   --include-host-live   = also run host-live (refused otherwise; touches the live service)
 *   --concurrency=N       = max parallel suites (default = min(cpus, 8))
 *   --timeout=SEC         = per-suite timeout (default 240)
 *   --only=substr         = restrict to suites whose name contains substr
 *   --list                = print the plan and exit
 *
 * docker-sandbox suites are ALWAYS serialized (concurrency 1) because the sandbox
 * holds an exclusive daemon lock; two at once would deadlock on the lock wait.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempScratch } from './lib/scratch.mjs';

/**
 * Is this process in a git-write-restricted context (a dispatched Orchard lane,
 * FEAT-135 backstop)? Probe with a throwaway `git init` in a scratch dir: if the
 * shim refuses it, suites that write a scratch/fixture git repo (needsGit) cannot
 * pass here — that is a property of the LANE, not a product regression — so we
 * SKIP them with a reason rather than counting a lane artifact as a failure.
 */
function gitWriteBlocked() {
  if (process.argv.includes('--run-needs-git')) return false;
  let tmp;
  try {
    tmp = mkdtempScratch('feat-033-gitprobe-');
    const r = spawnSync('git', ['init', '-q'], { cwd: tmp, encoding: 'utf8' });
    return r.status !== 0 || /git write|disabled for agent|do NOT write git|refused/i.test(`${r.stdout}${r.stderr}`);
  } catch {
    return true;
  } finally {
    if (tmp) try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const val = (name, def) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};

const manifest = JSON.parse(fs.readFileSync(path.join(HERE, 'test-manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// Loud guard: any verify* npm script the manifest does not classify (and is not an
// intentional skip in the generator) is an unclassified suite — refuse to pretend coverage.
const classified = new Set(Object.keys(manifest.suites));
const INTENTIONAL_SKIP = new Set(['qa:sweep']);
const unclassified = Object.keys(pkg.scripts)
  .filter((n) => /^verify([:-]|$)/.test(n))
  .filter((n) => !classified.has(n) && !INTENTIONAL_SKIP.has(n));
if (unclassified.length) {
  console.error(`\nUNCLASSIFIED verify suites (${unclassified.length}) — regenerate the manifest:`);
  for (const n of unclassified) console.error(`  ${n}`);
  console.error('Run: node scripts/gen-test-manifest.mjs\n');
  process.exit(2);
}

let tiers;
if (flag('all')) tiers = ['pure', 'scratch-server', 'browser', 'docker-sandbox'];
else if (val('tier')) tiers = val('tier').split(',').map((s) => s.trim()).filter(Boolean);
else tiers = ['pure', 'scratch-server'];
if (flag('include-host-live') && !tiers.includes('host-live')) tiers.push('host-live');
if (tiers.includes('host-live') && !flag('include-host-live')) {
  console.error('Refusing to run host-live suites without --include-host-live (they touch the live service).');
  process.exit(2);
}

const only = val('only');
const concurrency = Math.max(1, Number(val('concurrency', String(Math.min(os.cpus().length, 8)))));
const timeoutSec = Math.max(1, Number(val('timeout', '240')));

let plan = Object.entries(manifest.suites)
  .filter(([, v]) => tiers.includes(v.tier))
  .filter(([name]) => !only || name.includes(only))
  .map(([name, v]) => ({ name, tier: v.tier, timeoutSec: v.timeoutSec }));

if (plan.some((p) => p.tier === 'broken')) {
  // broken suites are reported but not executed
}

// Attach needsGit from the manifest, and decide git-skips once.
for (const p of plan) p.needsGit = !!manifest.suites[p.name]?.needsGit;
const gitBlocked = plan.some((p) => p.needsGit) && gitWriteBlocked();
const gitSkips = gitBlocked ? plan.filter((p) => p.needsGit) : [];
if (gitBlocked) plan = plan.filter((p) => !p.needsGit);

if (flag('list')) {
  console.log(`Plan: ${plan.length} suites across tiers [${tiers.join(', ')}], concurrency ${concurrency}, timeout ${timeoutSec}s`);
  if (gitSkips.length) console.log(`(skipping ${gitSkips.length} needsGit suites — git writes are blocked in this lane; use --run-needs-git to force)`);
  for (const p of plan) console.log(`  ${p.tier.padEnd(16)} ${p.name}${p.timeoutSec ? `  (timeout ${Math.max(timeoutSec, p.timeoutSec)}s)` : ''}`);
  process.exit(0);
}
if (gitSkips.length) console.log(`note: ${gitSkips.length} needsGit suites skipped — git writes blocked in this lane (--run-needs-git to force)\n`);

const LOGS = mkdtempScratch('feat-033-testrun-');
console.log(`test-runner: ${plan.length} suites | tiers [${tiers.join(', ')}] | concurrency ${concurrency} | timeout ${timeoutSec}s`);
console.log(`logs: ${LOGS}\n`);

const results = [];
function runOne(suite) {
  return new Promise((resolve) => {
    const started = Date.now();
    const logPath = path.join(LOGS, `${suite.name.replace(/[:/]/g, '_')}.log`);
    const out = fs.createWriteStream(logPath);
    const child = spawn('npm', ['run', '-s', suite.name], {
      cwd: ROOT, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(out);
    child.stderr.pipe(out);
    let timedOut = false;
    // A suite may declare its own timeout in the manifest (`timeoutSec`) when it is
    // legitimately longer than the global default (e.g. a boot-probe suite that
    // spawns many serial child processes). The global --timeout is the floor:
    // a per-suite value only ever RAISES the budget, never lowers it below the
    // operator's chosen default.
    const suiteTimeoutSec = Math.max(timeoutSec, Number(suite.timeoutSec) || 0);
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }, suiteTimeoutSec * 1000);
    child.on('close', (code) => {
      clearTimeout(timer);
      out.end();
      const ms = Date.now() - started;
      const status = timedOut ? 'TIMEOUT' : code === 0 ? 'PASS' : 'FAIL';
      results.push({ ...suite, status, code, ms, logPath });
      const tag = status === 'PASS' ? 'ok ' : status === 'FAIL' ? 'FAIL' : 'TIME';
      console.log(`  [${tag}] ${suite.name.padEnd(42)} ${(ms / 1000).toFixed(1)}s`);
      resolve();
    });
    child.on('error', (e) => {
      clearTimeout(timer); out.end();
      results.push({ ...suite, status: 'FAIL', code: -1, ms: Date.now() - started, logPath, err: String(e) });
      console.log(`  [FAIL] ${suite.name.padEnd(42)} spawn error`);
      resolve();
    });
  });
}

// Run a pool with bounded concurrency; docker-sandbox entries are forced serial.
async function runPool(items, limit) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (i < items.length) { const item = items[i++]; await runOne(item); }
  });
  await Promise.all(workers);
}

const broken = plan.filter((p) => p.tier === 'broken');
const docker = plan.filter((p) => p.tier === 'docker-sandbox');
const parallel = plan.filter((p) => p.tier !== 'docker-sandbox' && p.tier !== 'broken');

const t0 = Date.now();
await runPool(parallel, concurrency);
if (docker.length) { console.log('\n-- docker-sandbox (serialized) --'); await runPool(docker, 1); }
for (const b of broken) results.push({ ...b, status: 'SKIP', code: null, ms: 0, logPath: null });
for (const g of gitSkips) results.push({ ...g, status: 'SKIP', code: null, ms: 0, logPath: null, skipReason: 'git-blocked lane' });

// Summary
const byTier = {};
for (const r of results) {
  const b = (byTier[r.tier] ??= { pass: 0, fail: 0, timeout: 0, skip: 0, ms: 0 });
  if (r.status === 'PASS') b.pass++;
  else if (r.status === 'FAIL') b.fail++;
  else if (r.status === 'TIMEOUT') b.timeout++;
  else b.skip++;
  b.ms += r.ms;
}
console.log(`\n${'='.repeat(60)}\nSUMMARY (${((Date.now() - t0) / 1000).toFixed(1)}s wall)`);
console.log(`${'tier'.padEnd(16)} ${'pass'.padStart(5)} ${'fail'.padStart(5)} ${'time'.padStart(5)} ${'skip'.padStart(5)}`);
for (const [t, b] of Object.entries(byTier))
  console.log(`${t.padEnd(16)} ${String(b.pass).padStart(5)} ${String(b.fail).padStart(5)} ${String(b.timeout).padStart(5)} ${String(b.skip).padStart(5)}`);

const failed = results.filter((r) => r.status === 'FAIL' || r.status === 'TIMEOUT');
if (failed.length) {
  console.log(`\nFAILURES (${failed.length}):`);
  for (const f of failed) console.log(`  ${f.status.padEnd(7)} ${f.name}  -> ${f.logPath}`);
}
const totPass = results.filter((r) => r.status === 'PASS').length;
console.log(`\nTOTAL: ${totPass} pass, ${failed.length} fail/timeout, ${results.filter((r) => r.status === 'SKIP').length} skip, of ${results.length} suites`);
process.exit(failed.length ? 1 : 0);
