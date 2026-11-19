#!/usr/bin/env node
/**
 * BUG-289 — the free-space FLOOR tells a real 0-byte reading apart from a failed one.
 *
 * Independent verify 01a1b796 (openai, BROKEN): pruneSandboxToCap's `freeNow` mapped a
 * SUCCESSFUL zero-byte free-space reading to Infinity, so on a genuinely full disk the
 * floor never fired: 1 byte free pruned, 0 bytes free kept every image.
 *
 * This drives the REAL pruneSandboxToCap end to end against a controlled Docker API (a
 * fake daemon on a scratch unix socket — synthetic, because a full host filesystem cannot
 * be produced safely here). The store is UNDER its byte cap in every case, so any delete
 * is the floor's doing. It also checks the reading's own classification (measured /
 * unknown / disabled) and that a native Promise whose `then` was stripped cannot leak an
 * unhandled rejection (the residual break of the 2026-11-07 hardening rounds).
 *
 *   node scripts/verify-bug-289-floor-zero.mjs [--lib <path to docker-sandbox.mjs>]
 *
 * `--lib` lets the must-FAIL proof point this suite at a pinned pre-fix copy
 * (e.g. `git show ef7d2c0:scripts/lib/docker-sandbox.mjs`), never at a moving HEAD.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempScratch } from './lib/scratch.mjs';

const li = process.argv.indexOf('--lib');
const libPath = li > 0 ? path.resolve(process.argv[li + 1]) : path.resolve(import.meta.dirname, 'lib/docker-sandbox.mjs');
const lib = await import(pathToFileURL(libPath).href);
const { pruneSandboxToCap } = lib;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) pass++; else fail++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${extra}`); };
const GiB = 2 ** 30;

// --- the fake daemon: three unused, old images; the store is 0.75 GiB (under any cap) ---
// It runs in a CHILD process: the guard's `docker info` is a spawnSync, which would block an
// in-process server's event loop. The parent drives it over /__reset and /__deleted.
function serve(sock) {
  let images = [];
  const deleted = [];
  const reset = () => {
    deleted.length = 0;
    images = [1, 2, 3].map((n) => ({ Id: `sha256:${String(n).repeat(64)}`, Created: 1_600_000_000 + n, RepoTags: [`old-${n}:latest`], Size: GiB / 4 }));
  };
  reset();
  const send = (res, code, body) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json', 'Content-Length': Buffer.byteLength(text), 'Api-Version': '1.43' });
    res.end(text);
  };
  const server = http.createServer((req, res) => {
    const u = req.url.replace(/^\/v1\.\d+/, '');
    if (u === '/__reset') { reset(); return send(res, 200, {}); }
    if (u === '/__deleted') return send(res, 200, deleted);
    if (u.startsWith('/_ping')) return send(res, 200, 'OK');
    if (u.startsWith('/version')) return send(res, 200, { ApiVersion: '1.43', Version: '24.0.0', MinAPIVersion: '1.12', Os: 'linux', Arch: 'amd64' });
    if (u.startsWith('/info')) return send(res, 200, { ID: FAKE_ID, Name: 'fake-b289', ServerVersion: '24.0.0', Containers: 0, Images: images.length });
    if (u.startsWith('/system/df')) return send(res, 200, { LayersSize: GiB / 4 * images.length, Images: images, BuildCache: [] });
    if (u.startsWith('/build/prune')) return send(res, 200, { SpaceReclaimed: 0 });
    if (u.startsWith('/containers/json')) return send(res, 200, []);
    if (req.method === 'GET' && u.startsWith('/images/json')) return send(res, 200, images);
    if (req.method === 'GET' && /^\/images\/[^/]+\/json/.test(u)) return send(res, 200, { Metadata: {} });
    if (req.method === 'DELETE' && u.startsWith('/images/')) {
      const id = decodeURIComponent(u.slice('/images/'.length).split('?')[0]);
      images = images.filter((i) => i.Id !== id); deleted.push(id);
      return send(res, 200, [{ Deleted: id }]);
    }
    return send(res, 404, { message: `fake daemon: no route ${req.method} ${u}` });
  });
  server.listen(sock, () => process.stdout.write('ready\n'));
  process.stdin.on('end', () => process.exit(0)); process.stdin.resume(); // dies with its parent
}
const FAKE_ID = 'FAKE:B289:FLOOR:ZERO:0000:0000:0000:0000:0000:0000:0000:0000';
const si = process.argv.indexOf('--serve');
if (si > 0) { serve(process.argv[si + 1]); await new Promise(() => {}); }

const dir = mkdtempScratch('b289-floor-');
const sock = path.join(dir, 'docker.sock');
const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--serve', sock], { stdio: ['pipe', 'pipe', 'inherit'] });
await new Promise((res, rej) => { child.stdout.once('data', res); child.once('exit', (c) => rej(new Error(`fake daemon exited ${c}`))); });
const ctl = (p) => new Promise((res, rej) => {
  const r = http.request({ socketPath: sock, path: p, method: 'GET' }, (resp) => { let b = ''; resp.on('data', (d) => { b += d; }); resp.on('end', () => res(JSON.parse(b))); });
  r.on('error', rej); r.end();
});

// A host id that is NOT the fake's, so the guard can prove the fake is not the host.
const env = { ...process.env, DOCKER_HOST: `unix://${sock}`, HOST_DOCKER_ID: process.env.HOST_DOCKER_ID || 'not-the-fake-daemon' };
delete env.CLAUDE_STATION_DOCKER;

async function run(label, freeBytes) {
  await ctl('/__reset');
  const logs = [];
  let summary = null, err = null;
  try { summary = await pruneSandboxToCap(env, { capGb: 40, floorGb: 50, freeBytes, lock: false, recencySec: 600, log: (s) => logs.push(s) }); }
  catch (e) { err = e; }
  return { label, summary, err, deleted: await ctl('/__deleted'), logs };
}

try {
  const guard = lib.checkIsolatedDocker(env);
  ok('fixture-guard-accepts-fake-daemon', guard.ok === true, guard.ok ? `id ${guard.targetId.slice(0, 14)}…` : guard.reason);

  // 1) THE BROKEN CASE: a successful 0-byte reading must fire the floor (store is under cap).
  const zero = await run('zero', () => 0);
  ok('zero-free-reading-fires-floor', !zero.err && zero.deleted.length > 0, zero.err ? `threw ${zero.err.message}` : `deleted ${zero.deleted.length}/3`);
  ok('zero-free-reading-logged-as-0', zero.logs.some((s) => /free 0\.0GB/.test(s)), JSON.stringify(zero.logs[0] ?? ''));

  // Control: 1 byte free also fires (the verifier's comparison point).
  const one = await run('one', () => 1);
  ok('one-byte-free-fires-floor', !one.err && one.deleted.length > 0, `deleted ${one.deleted.length}/3`);

  // Control: plenty free and under cap -> nothing deleted.
  const roomy = await run('roomy', () => 500 * GiB);
  ok('plenty-free-under-cap-deletes-nothing', !roomy.err && roomy.deleted.length === 0, `deleted ${roomy.deleted.length}`);

  // Floor deliberately not wired (lane / cap-only caller): cap still governs, floor off.
  const off = await run('off', null);
  ok('no-measurement-wired-deletes-nothing-under-cap', !off.err && off.deleted.length === 0, `deleted ${off.deleted.length}`);

  // 2) A FAILED reading (statfs error -> null) is UNKNOWN, not 0. Policy (BUG-289 2026-11-19,
  //    reverting the orchestrator's 2026-11-07 unknown->prune): a measurement error must never
  //    DELETE anything — the floor fails CLOSED (keeps images) and the failure is logged loudly;
  //    the byte cap, a real measurement, still applies. A real 0 still prunes (case 1).
  const unk = await run('unknown', () => null);
  ok('failed-reading-keeps-images-fail-closed', !unk.err && unk.deleted.length === 0, `deleted ${unk.deleted.length}/3`);
  ok('failed-reading-logged-loudly-as-warning', unk.logs.some((s) => /WARNING.*free space unknown.*NOT enforced/i.test(s)), JSON.stringify(unk.logs));
  ok('failed-reading-logged-as-unknown-not-0', unk.logs.some((s) => /free (unknown|UNKNOWN)/.test(s)) && !unk.logs.some((s) => /free 0\.0GB/.test(s)),
    JSON.stringify(unk.logs[0] ?? ''));
  ok('zero-reading-not-logged-as-unknown', !zero.logs.some((s) => /free (unknown|UNKNOWN)/.test(s)), 'a real 0 is a measurement, not an unknown');
  // IV round 2 (openai 01a1f45e): measurement fails mid-prune, drives a delete, then recovers.
  // The unknown readings that caused the delete must still reach the log.
  let nRead = 0;
  // Readings: precheck, locked re-measure, after build-cache prune = real 0 (prune proceeds, 1st
  // delete); after that delete = unknown (must stop deleting); then recovered.
  const flaky = await run('fails-then-recovers', () => { nRead++; return nRead <= 3 ? 0 : nRead === 4 ? null : 1e13; });
  // First reading is a REAL 0 (floor fires, prune starts); the unknown readings mid-prune must
  // not keep driving deletes on their own; a later recovered roomy reading ends the prune.
  ok('mid-prune-real-zero-starts-prune', !flaky.err && flaky.deleted.length >= 1, flaky.err ? `threw ${flaky.err.message}` : `deleted ${flaky.deleted.length}/3`);
  ok('mid-prune-unknown-stops-deleting', !flaky.err && flaky.deleted.length === 1, `deleted ${flaky.deleted.length}/3 (1 = only the real-0 step deleted)`);
  ok('mid-prune-unknown-then-recovers-is-logged', flaky.logs.some((x) => /unknown/.test(x)), JSON.stringify(flaky.logs));
  ok('mid-prune-unknown-counted-in-summary', flaky.summary?.unknownFreeReadings >= 1, JSON.stringify(flaky.summary?.unknownFreeReadings));
  const thrown = await run('throws', () => { throw new Error('EIO: statfs'); });
  ok('throwing-reading-keeps-images-fail-closed', !thrown.err && thrown.deleted.length === 0, thrown.err ? `threw ${thrown.err.message}` : `deleted ${thrown.deleted.length}/3`);
  // Over the byte CAP with an unknown free reading: the cap is a real measurement, so it still prunes.
  {
    await ctl('/__reset');
    const logs = []; let err = null;
    try { await pruneSandboxToCap(env, { capGb: 0.3, floorGb: 50, freeBytes: () => null, lock: false, recencySec: 600, log: (s) => logs.push(s) }); } catch (e) { err = e; }
    const del = await ctl('/__deleted');
    ok('unknown-free-over-cap-still-prunes-to-cap', !err && del.length === 2, err ? `threw ${err.message}` : `deleted ${del.length}/3 (0.75GB store, 0.3GB cap -> 2)`);
  }

  // 3) Classification is exported so callers/tests read it rather than re-deriving it.
  const cls = lib.classifyFreeBytes;
  ok('classifyFreeBytes-exported', typeof cls === 'function');
  if (typeof cls === 'function') {
    const c0 = cls(() => 0), cn = cls(() => null), cx = cls(null), c5 = cls(() => 5);
    ok('classify-zero-is-measured-0', c0.state === 'measured' && c0.bytes === 0, JSON.stringify(c0));
    ok('classify-null-is-unknown-floor-cannot-fire', cn.state === 'unknown' && cn.bytes === Infinity, JSON.stringify({ ...cn, bytes: String(cn.bytes) }));
    ok('classify-not-wired-is-disabled', cx.state === 'disabled' && cx.bytes === Infinity, JSON.stringify({ ...cx, bytes: String(cx.bytes) }));
    ok('classify-real-reading-passes', c5.state === 'measured' && c5.bytes === 5, JSON.stringify(c5));
  }

  // 4) Residual break of the 2026-11-07 rounds: a rejected native Promise whose `then` is
  //    stripped (undefined) or a throwing getter must not leak an unhandled rejection.
  for (const variant of ['then-undefined', 'then-throwing-getter']) {
    let leaked = false;
    const onUnh = () => { leaked = true; };
    process.on('unhandledRejection', onUnh);
    const p = Promise.reject(new Error(`stripped ${variant}`));
    if (variant === 'then-undefined') p.then = undefined;
    else Object.defineProperty(p, 'then', { get() { throw new Error('bad then getter'); } });
    let got;
    try { got = lib.resolveFreeBytes(() => p); } catch (e) { got = `threw ${e.message}`; }
    await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
    process.removeListener('unhandledRejection', onUnh);
    ok(`stripped-promise-${variant}-reads-unknown-no-floor`, got === Infinity, `got ${got}`);
    ok(`stripped-promise-${variant}-no-unhandled-rejection`, !leaked, `leaked=${leaked}`);
  }

  // 5) Independent verify (anthropic e4400899, BROKEN): a native Promise whose `constructor`
  //    getter or Symbol.species throws made the captured `then` throw synchronously, so
  //    classify threw and the prune aborted. It must stay "unknown" (no throw) and keep images.
  //    (Its own rejection may still be reported unhandled — a deliberately broken species
  //    cannot be observed safely; a listener absorbs that here. Not reachable from any caller,
  //    which are all synchronous.)
  {
    const absorb = () => {};
    process.on('unhandledRejection', absorb);
    const ctorThrows = () => { const p = Promise.reject(new Error('EIO async statfs')); Object.defineProperty(p, 'constructor', { get() { throw new Error('bad constructor'); } }); return p; };
    class BadSpecies extends Promise { static get [Symbol.species]() { throw new Error('bad species'); } }
    const speciesThrows = () => BadSpecies.reject(new Error('EIO async statfs'));
    class NotCtor extends Promise { static get [Symbol.species]() { return 42; } }
    const speciesNotCtor = () => NotCtor.reject(new Error('EIO async statfs'));
    for (const [name, fn] of [['constructor-getter-throws', ctorThrows], ['species-throws', speciesThrows], ['species-not-constructor', speciesNotCtor]]) {
      let c; try { c = lib.classifyFreeBytes(fn); } catch (e) { c = { threw: e.message }; }
      ok(`tampered-promise-${name}-is-unknown-no-throw`, c.state === 'unknown' && c.bytes === Infinity, JSON.stringify({ ...c, bytes: String(c.bytes) }));
    }
    const e2e = await run('species-e2e', speciesThrows);
    ok('tampered-promise-end-to-end-keeps-and-logs-unknown', !e2e.err && e2e.deleted.length === 0 && e2e.logs.some((x) => /free unknown/.test(x)),
      e2e.err ? `threw ${e2e.err.message}` : `deleted ${e2e.deleted.length}/3`);
    await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
    process.removeListener('unhandledRejection', absorb);
  }
  // IV round 3 (openai 01a1f460): host CLI discovery that FAILS (non-zero exit) but printed a
  // plausible root must be unknown (a function resolving to null), not a measured reading.
  {
    const shimDir = path.join(dir, 'shim');
    fs.mkdirSync(shimDir, { recursive: true });
    fs.writeFileSync(path.join(shimDir, 'docker'), '#!/bin/sh\nprintf "%s\\n" "$FAKE_DOCKER_OUT"\nexit "${FAKE_DOCKER_EXIT:-0}"\n', { mode: 0o755 });
    const cli = li > 0 ? path.join(path.dirname(libPath), '..', 'docker-sandbox.mjs') : path.resolve(import.meta.dirname, 'docker-sandbox.mjs');
    const probe = (exit, out) => {
      const e = { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, FAKE_DOCKER_EXIT: String(exit), FAKE_DOCKER_OUT: out,
        ORCHARD_DOCKER_SANDBOX_DATA_BASE: 'relative-so-volume-mode' };
      delete e.ORCHARD_LANE_DOCKER; delete e.ORCHARD_DOCKER_SANDBOX_DATA; delete e.DOCKER_HOST;
      const code = `const m = await import(${JSON.stringify(pathToFileURL(cli).href)}); const f = m.storeFreeBytesFn();
        const v = typeof f === 'function' ? f() : f; console.log(JSON.stringify({ kind: f === null ? 'null' : typeof f, v }));`;
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: e, encoding: 'utf8', timeout: 60_000 });
      try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { err: (r.stderr || r.stdout).slice(-300) }; }
    };
    const failed = probe(1, '/');
    ok('discovery-exit-1-with-stdout-is-unknown', failed.kind === 'function' && failed.v === null, JSON.stringify(failed));
    const garbage = probe(0, 'WARNING: not a path');
    ok('discovery-non-absolute-output-is-unknown', garbage.kind === 'function' && garbage.v === null, JSON.stringify(garbage));
    const good = probe(0, '/');
    ok('discovery-success-is-measured', good.kind === 'function' && typeof good.v === 'number' && good.v >= 0, JSON.stringify(good));
  }
} finally {
  child.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\nBUG-289 floor-zero: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
