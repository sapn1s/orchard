#!/usr/bin/env node
/**
 * FEAT-151 — verify the on-demand Claude runtime update surface.
 *
 * Two parts:
 *   A. PURE, in-process against the live modules (no mutation of the working
 *      tree): exact-semver grammar, the container-scope applicability filter
 *      (finding #9 regression), the pin-writer's REJECTION path, the registry
 *      best-effort error, and the mutation guards' shapes.
 *   B. REAL install/rollback against an ISOLATED COPY the script builds itself
 *      (reflinked node_modules, its own projectRoot), so the live package.json /
 *      node_modules are never touched no matter where this runs: a genuine
 *      `npm install` bump 0.3.280 → 0.3.281 with the exact pin + restartPending,
 *      a failed install that ROLLS BACK, and the concurrent single-flight refusal.
 *
 * A must-FAIL note: Part A anchors its "reject" cases to constructed-bad inputs,
 * not a moving baseline. Part B proves the fix by DOING the real thing, then
 * asserting the artifact — the strongest available check.
 *
 * Run: node scripts/verify-feat-151-runtime-update.mjs
 *      FEAT151_SKIP_MUTATE=1 node scripts/…   (Part A only; fast, no npm/network)
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { mkdtempScratch } from './lib/scratch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
};

/** Build an isolated copy (reflinked node_modules + the source it imports). */
function mkIsolatedCopy(copy) {
  const cp = (args) => spawnSync('cp', args, { stdio: 'inherit' });
  cp(['-a', '--reflink=auto', path.join(ROOT, 'node_modules'), path.join(copy, 'node_modules')]);
  for (const f of ['package.json', 'package-lock.json', 'tsconfig.json']) cp([path.join(ROOT, f), path.join(copy, f)]);
  cp(['-a', path.join(ROOT, 'src'), path.join(copy, 'src')]);
  cp(['-a', path.join(ROOT, 'scripts'), path.join(copy, 'scripts')]);
}

/** The bundled platform `claude` binary inside a copy (scan, no platform arithmetic). */
function platformBinPath(copy) {
  const scope = path.join(copy, 'node_modules', '@anthropic-ai');
  for (const name of fs.readdirSync(scope)) {
    if (name === 'claude-agent-sdk' || !name.startsWith('claude-agent-sdk-')) continue;
    const bin = path.join(scope, name, 'claude');
    if (fs.existsSync(bin)) return bin;
  }
  throw new Error('no bundled platform claude binary in the copy');
}

console.log('FEAT-151 — runtime update verification\n');

/* ============================ Part A — pure ============================ */
console.log('Part A — pure assertions (no working-tree mutation)');

const rt = await import(pathToFileURL(path.join(ROOT, 'src/server/runtime/runtime-update.ts')).href);
const prov = await import(pathToFileURL(path.join(ROOT, 'src/server/provisioning.ts')).href);

// 1. exact-semver grammar (finding #3)
for (const good of ['0.3.281', '2.1.197', '1.0.0-alpha.1']) ok(`EXACT_SEMVER accepts ${good}`, rt.EXACT_SEMVER.test(good));
for (const bad of ['latest', '^0.3.0', '../evil', '0.3', 'file:./x', '0.3.281 && rm', 'v1.2.3', '@pkg@1.0.0',
  // round-2 strictness: leading zeros and empty pre-release identifiers are not
  // valid semver (and npm rejects them too) — the guard must too.
  '01.2.3', '1.2.3-01', '1.2.3-a..b'])
  ok(`EXACT_SEMVER rejects ${JSON.stringify(bad)}`, !rt.EXACT_SEMVER.test(bad));

// 2/3. FEAT-157 SUPERSEDES the container CLI pin. The Claude CLI left the base image and provision.json: a
// container runs the host SDK's own boot-proven CLI as a one-file layer (container-manager.ts
// ensureRuntimeImage), so there is no pin to keep in sync and no writer that could freeze it behind the host.
// (These replaced finding #9's "claude-code is a CONTAINER tool" and the pin-writer rejections, which would
// now pass vacuously: calling a function that no longer exists throws too.)
const hostNames = prov.manifestToolsFor('host').map((t) => t.name);
const contNames = prov.manifestToolsFor('container').map((t) => t.name);
ok('FEAT-157: claude-code is in NO provision.json scope (the container CLI follows the host SDK)', !contNames.includes('claude-code') && !hostNames.includes('claude-code'), `host=${hostNames.join(',')} container=${contNames.join(',')}`);
ok('FEAT-157: no container-CLI pin reader/writer exists', typeof prov.writeClaudeCodePin === 'undefined' && typeof prov.claudeCodePin === 'undefined', `write=${typeof prov.writeClaudeCodePin} read=${typeof prov.claudeCodePin}`);
ok('serena/playwright still apply to host', ['serena', 'playwright'].every((n) => hostNames.includes(n)));
ok('serena/playwright still apply to containers', ['serena', 'playwright'].every((n) => contNames.includes(n)));

// 4. registry read is best-effort — a fetch failure yields {error}, never throws
const realFetch = globalThis.fetch;
globalThis.fetch = () => Promise.reject(new Error('simulated offline'));
try {
  const latest = await rt.latestPublished({ force: true });
  ok('latestPublished returns error (never throws) when offline', latest.error != null && latest.sdk === null, JSON.stringify(latest));
} finally { globalThis.fetch = realFetch; }

// 5. bundled-CLI resolution — a binary is found and reports a version
ok('bundledCliPath resolves an executable', typeof rt.bundledCliPath() === 'string' && fs.existsSync(rt.bundledCliPath()));
ok('bundledCliVersion reports a semver', /^\d+\.\d+\.\d+/.test(rt.bundledCliVersion() ?? ''));

/* ===================== Part B — real install/rollback ===================== */
if (process.env.FEAT151_SKIP_MUTATE) {
  console.log('\nPart B — SKIPPED (FEAT151_SKIP_MUTATE set)');
} else {
  console.log('\nPart B — real install/rollback in an isolated copy');
  // Expensive scratch (a reflinked node_modules) belongs on the scratch root,
  // same filesystem as the repo — not /tmp (CONVENTIONS: scratch policy).
  const scratch = mkdtempScratch('feat151-verify-');
  const copy = path.join(scratch, 'copy');
  fs.mkdirSync(copy);
  try {
    // Build the copy: reflink node_modules (fast, same-fs), copy the source it needs.
    const cp = (args) => spawnSync('cp', args, { stdio: 'inherit' });
    cp(['-a', '--reflink=auto', path.join(ROOT, 'node_modules'), path.join(copy, 'node_modules')]);
    for (const f of ['package.json', 'package-lock.json', 'tsconfig.json']) cp([path.join(ROOT, f), path.join(copy, f)]);
    cp(['-a', path.join(ROOT, 'src'), path.join(copy, 'src')]);
    cp(['-a', path.join(ROOT, 'scripts'), path.join(copy, 'scripts')]);

    // Downgrade the copy's SDK so an update to 0.3.281 is a genuine bump.
    const down = spawnSync('npm', ['install', '--save-exact', '--ignore-scripts', '@anthropic-ai/claude-agent-sdk@0.3.280'],
      { cwd: copy, encoding: 'utf8' });
    if (down.status !== 0) { console.log('  (could not downgrade — network?)\n', down.stderr?.slice(-400)); throw new Error('setup-failed'); }

    const runInCopy = (code) => {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: copy, encoding: 'utf8', env: { ...process.env, CLAUDE_STATION_DATA: path.join(copy, 'station-data') } });
      if (r.status !== 0) { console.log('  child stderr:', (r.stderr || '').slice(-600)); }
      try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { _raw: r.stdout, _err: r.stderr }; }
    };
    const IMPORT = `const rt = await import('./src/server/runtime/runtime-update.ts');`;

    // A "running session" stand-in: a long-lived process that has ALREADY loaded
    // the (old) SDK JS, exactly as a live session's spawned runtime has. The
    // real update below replaces node_modules files on disk under it; the plan's
    // invariant is that this does NOT kill or disturb the already-running process
    // ("running sessions keep working while an update installs"). Spawned before
    // the install, checked alive after.
    const holder = spawn(process.execPath, ['--input-type=module', '-e',
      `await import('@anthropic-ai/claude-agent-sdk'); console.log('READY'); setInterval(() => {}, 1e9);`],
      { cwd: copy, env: { ...process.env, CLAUDE_STATION_DATA: path.join(copy, 'station-data') }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve) => {
      let seen = false;
      holder.stdout.on('data', (d) => { if (!seen && /READY/.test(String(d))) { seen = true; resolve(); } });
      setTimeout(resolve, 15000); // don't hang the suite if import is slow
    });
    const holderPidAlive = () => { try { process.kill(holder.pid, 0); return true; } catch { return false; } };
    ok('session stand-in loaded the old SDK JS and is running', holderPidAlive());

    // Success: real bump, exact pin, restartPending.
    const s = runInCopy(`${IMPORT}
      const boot = rt.BOOT_SDK_VERSION;
      const res = await rt.updateHostRuntime({ version: '0.3.281' });
      const fs = await import('node:fs');
      const pkg = JSON.parse(fs.readFileSync('./package.json','utf8'));
      console.log(JSON.stringify({ boot, ok:res.ok, installedSdk:res.installedSdk, restartRequired:res.restartRequired, pin:pkg.dependencies['@anthropic-ai/claude-agent-sdk'], pending:rt.isRuntimeUpdatePending(), block: !!rt.hostSessionBlockReason() }));`);
    ok('real update bumps 0.3.280 → 0.3.281', s.ok === true && s.installedSdk === '0.3.281', JSON.stringify(s));
    ok('package.json pinned EXACT (no range char)', s.pin === '0.3.281', `pin=${s.pin}`);
    ok('restartRequired + pending true after update', s.restartRequired === true && s.pending === true);
    ok('new HOST sessions are blocked (skew guard)', s.block === true);
    // The running-session stand-in survived the real install untouched.
    ok('a running session SURVIVES a real install (already-loaded process untouched)', holderPidAlive());
    try { holder.kill('SIGKILL'); } catch { /* */ }

    // Failure: a bad version rolls back and restores package.json.
    const f = runInCopy(`${IMPORT}
      const fs = await import('node:fs');
      const before = fs.readFileSync('./package.json','utf8');
      const res = await rt.updateHostRuntime({ version: '0.3.999999' });
      const after = fs.readFileSync('./package.json','utf8');
      console.log(JSON.stringify({ ok:res.ok, rolledBack:res.rolledBack, restored: before===after, hasRollbackCmd: !!res.rollbackCommand, pendingAfter: rt.isRuntimeUpdatePending() }));`);
    ok('failed install returns ok:false + rolledBack', f.ok === false && f.rolledBack === true, JSON.stringify(f));
    ok('failed install RESTORES package.json snapshot', f.restored === true);
    ok('failed install reports a rollback command', f.hasRollbackCmd === true);
    ok('no skew left pending after a rolled-back failure', f.pendingAfter === false);

    // Concurrent: the second call is refused synchronously (→ 409).
    const c = runInCopy(`${IMPORT}
      const p1 = rt.updateHostRuntime({ version: '0.3.281' });
      let refused=false, name='';
      try { await rt.updateHostRuntime({ version: '0.3.281' }); } catch(e){ refused=true; name=e.name; }
      await p1.catch(()=>{});
      console.log(JSON.stringify({ refused, name }));`);
    ok('concurrent update refused (single-flight)', c.refused === true && c.name === 'UpdateInProgressError', JSON.stringify(c));
  } catch (err) {
    if (err.message !== 'setup-failed') { fail++; console.log('  FAIL Part B threw —', err.message); }
    else console.log('  Part B setup failed (likely offline); pure part still counts.');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// A constructed replica of the ROUND-3 (pre-round-4) predicate — fs-only,
// SIZE-based identity, cached on the BINARY STAT ALONE, boot captured with NO
// run-proof. This is the must-FAIL baseline for all three round-4 defects: a
// fixed, constructed broken variant (not a moving ref). Injected into each
// child as source text.
const OLD_ROUND3_PREDICATE = `
  // --- round-3 pre-fix predicate (the baseline the round-4 fix must beat) ---
  const _readV = (p) => { try { const v = JSON.parse(fsm.readFileSync(p,'utf8')).version; return (typeof v==='string'&&v)?v:null; } catch { return null; } };
  let _oldCache = null;                      // keyed on the BINARY stat alone (defect #2)
  const _sdkPkg = () => pathm.join(process.cwd(),'node_modules','@anthropic-ai','claude-agent-sdk','package.json');
  const oldIdentity = () => {                // fs-only, size-based, NO run-proof (defect #1/#3)
    const bin = rt.bundledCliPath();         // enforces X_OK but never RUNS the binary
    if (!bin) return null;
    let st; try { st = fsm.statSync(bin); } catch { return null; }
    const key = st.dev+':'+st.ino+':'+st.size+':'+st.mtimeMs;
    if (_oldCache && _oldCache.key === key) return _oldCache.identity;   // stale on a pkg-only change
    const platV = _readV(pathm.join(pathm.dirname(bin),'package.json'));
    const sdkV = _readV(_sdkPkg());
    const identity = (platV!=null && sdkV!=null) ? { sdkVersion:sdkV, platVersion:platV, size:st.size } : null;
    _oldCache = { key, identity };
    return identity;
  };
  const _oldSame = (a,b) => a && b && a.sdkVersion===b.sdkVersion && a.platVersion===b.platVersion && a.size===b.size;
`;

/* ===== Part C — defect #1: a present+executable but NON-RUNNING boot binary FAILS CLOSED ===== */
// The round-3 boot identity was a plain fs read (X_OK + statSync + package.jsons)
// that NEVER ran the binary, so a binary present with its exec bit set but that
// does NOT run (garbage / exit-nonzero) was captured as a coherent BOOT_IDENTITY
// and sessions were ADMITTED (restartPending:false) — the fail-OPEN break. The
// round-4 boot PROVES the runtime runs (`--version` async) before it becomes a
// baseline; a non-running binary leaves bootState=failed / BOOT_IDENTITY=null and
// admission fails closed. The binary is broken BEFORE the child imports the
// module, so this exercises the boot-time capture. must-FAIL baseline: the
// constructed round-3 fs-only identity captures a coherent baseline and admits.
if (process.env.FEAT151_SKIP_MUTATE) {
  console.log('\nPart C — SKIPPED (FEAT151_SKIP_MUTATE set)');
} else {
  console.log('\nPart C — defect #1: a non-running binary AT BOOT BLOCKS (fail closed; a failed check is never a baseline)');
  const scratch = mkdtempScratch('feat151-brokenboot-');
  const copy = path.join(scratch, 'copy');
  fs.mkdirSync(copy);
  try {
    mkIsolatedCopy(copy);
    const bin = platformBinPath(copy);
    // Each kind is a SEPARATE child (boot re-captures), because the defect is at boot.
    const kinds = {
      garbage: `#!/bin/sh\necho garbage-not-a-version\n`,   // present + exec, runs, prints NO version
      nonzeroExit: `#!/bin/sh\nexit 7\n`,                    // present + exec, exits nonzero
    };
    for (const [kind, script] of Object.entries(kinds)) {
      fs.writeFileSync(bin, script); fs.chmodSync(bin, 0o755);
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import * as fsm from 'node:fs';
        import * as pathm from 'node:path';
        const rt = await import('./src/server/runtime/runtime-update.ts');
        await rt.whenRuntimeChecked();               // let the async boot proof settle
        ${OLD_ROUND3_PREDICATE}
        // pre-fix: boot == the broken binary, coherent → admits (skew false).
        const oldBoot = oldIdentity();
        const oldCur = oldIdentity();
        const oldAdmits = _oldSame(oldBoot, oldCur);
        // fix: boot proof failed → block, no baseline.
        console.log(JSON.stringify({
          oldAdmits,
          newBlocks: rt.isRuntimeUpdatePending() === true,
          reason: rt.hostSessionBlockReason(),
          bootIdentityNull: rt.BOOT_IDENTITY === null,
          bootCliNull: rt.BOOT_CLI_VERSION === null,
        }));
      `], { cwd: copy, encoding: 'utf8', env: { ...process.env, CLAUDE_STATION_DATA: path.join(copy, 'station-data') } });
      if (r.status !== 0) console.log('  child stderr:', (r.stderr || '').slice(-800));
      let c; try { c = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { c = { _raw: r.stdout }; }
      ok(`[must-FAIL baseline] round-3 fs-only boot captures a coherent baseline and ADMITS a ${kind} binary`, c.oldAdmits === true, JSON.stringify(c));
      ok(`FIX: a ${kind} binary at boot BLOCKS new host sessions (fail closed)`, c.newBlocks === true, JSON.stringify(c));
      ok(`FIX: a failed boot check never becomes a baseline (BOOT_IDENTITY null) for ${kind}`, c.bootIdentityNull === true, JSON.stringify(c));
      ok(`FIX: the ${kind} block reason names the runtime check`, typeof c.reason === 'string' && /runtime check/.test(c.reason), c.reason);
    }
  } catch (err) {
    fail++; console.log('  FAIL Part C threw —', err.message);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/* ===== Part D — defect #2: a package.json change with the binary UNTOUCHED forces a recompute ===== */
// The round-3 identity cache keyed on the BINARY STAT ALONE, so deleting or
// changing a package.json while the binary was untouched returned the STALE
// coherent identity and kept admitting (the half-written-install window). The
// round-4 cache key covers EVERY input — the binary AND both package.jsons — so
// any of them changing forces a recompute and (here) fails closed. must-FAIL
// baseline: the constructed round-3 binary-stat-only cache returns stale + admits.
if (process.env.FEAT151_SKIP_MUTATE) {
  console.log('\nPart D — SKIPPED (FEAT151_SKIP_MUTATE set)');
} else {
  console.log('\nPart D — defect #2: a package.json change (binary untouched) forces a recompute (stale-cache fix)');
  for (const variant of ['delete', 'change']) {
    const scratch = mkdtempScratch('feat151-stalecache-');
    const copy = path.join(scratch, 'copy');
    fs.mkdirSync(copy);
    try {
      mkIsolatedCopy(copy);
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import * as fsm from 'node:fs';
        import * as pathm from 'node:path';
        const rt = await import('./src/server/runtime/runtime-update.ts');
        await rt.whenRuntimeChecked();
        ${OLD_ROUND3_PREDICATE}
        const bin = rt.bundledCliPath();
        const platPkg = pathm.join(pathm.dirname(bin), 'package.json');
        const healthyPending = rt.isRuntimeUpdatePending();     // false (boot == disk)
        const oldBoot = oldIdentity();                          // healthy → cached on binary stat
        // Change ONLY the platform package.json; the binary (and its stat) is untouched.
        if ('${variant}' === 'delete') fsm.rmSync(platPkg);
        else { const j = JSON.parse(fsm.readFileSync(platPkg,'utf8')); j.version = '9.9.9'; fsm.writeFileSync(platPkg, JSON.stringify(j)); }
        const oldCur = oldIdentity();                           // binary stat unchanged → STALE cache hit
        const oldAdmits = _oldSame(oldBoot, oldCur);            // pre-fix: still coherent → admit
        // fix: composite key includes the package.json stat → recompute → block.
        const newPending = rt.isRuntimeUpdatePending();
        console.log(JSON.stringify({ healthyPending, oldAdmits, newPending, reason: rt.hostSessionBlockReason() }));
      `], { cwd: copy, encoding: 'utf8', env: { ...process.env, CLAUDE_STATION_DATA: path.join(copy, 'station-data') } });
      if (r.status !== 0) console.log('  child stderr:', (r.stderr || '').slice(-800));
      let c; try { c = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { c = { _raw: r.stdout }; }
      ok(`setup(${variant}): a healthy runtime admits (boot == disk)`, c.healthyPending === false, JSON.stringify(c));
      ok(`[must-FAIL baseline] round-3 binary-stat-only cache returns a STALE identity and ADMITS after a package.json ${variant}`, c.oldAdmits === true, JSON.stringify(c));
      ok(`FIX: a package.json ${variant} (binary untouched) forces a recompute and BLOCKS`, c.newPending === true, JSON.stringify(c));
    } catch (err) {
      fail++; console.log(`  FAIL Part D(${variant}) threw —`, err.message);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
}

/* ===== Part E — defect #3: a same-SIZE corrupted binary is caught by CONTENT (sha256), not size ===== */
// Round-3 compared the binary by BYTE SIZE, so a same-size corrupted/swapped
// binary matched boot and was admitted. Round-4 compares the binary's sha256
// CONTENT hash. The binary's header is overwritten IN PLACE (size preserved,
// exec bit preserved), so size is byte-identical while content differs. must-FAIL
// baseline: the constructed round-3 size comparison sees no change → admits.
if (process.env.FEAT151_SKIP_MUTATE) {
  console.log('\nPart E — SKIPPED (FEAT151_SKIP_MUTATE set)');
} else {
  console.log('\nPart E — defect #3: a same-SIZE corrupted binary BLOCKS (content hash, not size)');
  const scratch = mkdtempScratch('feat151-samesize-');
  const copy = path.join(scratch, 'copy');
  fs.mkdirSync(copy);
  try {
    mkIsolatedCopy(copy);
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import * as fsm from 'node:fs';
      import * as pathm from 'node:path';
      const rt = await import('./src/server/runtime/runtime-update.ts');
      await rt.whenRuntimeChecked();
      const bin = rt.bundledCliPath();
      const boot = rt.BOOT_IDENTITY;                 // { ..., hash }
      const sizeBefore = fsm.statSync(bin).size;
      // Corrupt the ELF header IN PLACE — same byte size, different content, still 0755.
      const fd = fsm.openSync(bin, 'r+');
      fsm.writeSync(fd, Buffer.alloc(256, 0xff), 0, 256, 0);
      fsm.closeSync(fd);
      const sizeAfter = fsm.statSync(bin).size;
      await rt.whenRuntimeSettled();                 // let the async re-hash land
      const cur = rt.currentRuntimeIdentity();
      const newPending = rt.isRuntimeUpdatePending();
      const oldAdmits = (sizeBefore === sizeAfter);  // round-3 size-only: no change seen → admit
      console.log(JSON.stringify({
        sizeBefore, sizeAfter, sameSize: sizeBefore === sizeAfter,
        bootHash: boot?.hash, curHash: cur?.hash,
        hashChanged: !!boot && !!cur && boot.hash !== cur.hash,
        oldAdmits, newPending,
      }));
    `], { cwd: copy, encoding: 'utf8', env: { ...process.env, CLAUDE_STATION_DATA: path.join(copy, 'station-data') } });
    if (r.status !== 0) console.log('  child stderr:', (r.stderr || '').slice(-800));
    let c; try { c = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { c = { _raw: r.stdout }; }
    ok('setup: boot captured a content hash and the corruption preserved the byte size', typeof c.bootHash === 'string' && c.sameSize === true, JSON.stringify(c));
    ok('[must-FAIL baseline] round-3 size-only comparison ADMITS a same-size corrupted binary', c.oldAdmits === true, JSON.stringify(c));
    ok('FIX: the content hash CHANGED for a same-size corruption', c.hashChanged === true, JSON.stringify(c));
    ok('FIX: a same-size corrupted binary BLOCKS new host sessions', c.newPending === true, JSON.stringify(c));
  } catch (err) {
    fail++; console.log('  FAIL Part E threw —', err.message);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/* ===== Part F — no hot-path spawn/hash, and an async hash never stalls the loop ===== */
// (a) A healthy admission spawns ZERO children and re-hashes NOTHING (the binary
//     stat is unchanged since boot → pure cache hit). must-FAIL baseline: the
//     round-2 per-admission spawn writes a marker on every call.
// (b) When the binary DOES change, the re-hash is async/streamed: the admission
//     call returns immediately ("checking") and a scheduled timer keeps firing
//     during the ~200 ms hash. Contrast measured against a synchronous hash of
//     the same real binary, which stalls the loop.
if (process.env.FEAT151_SKIP_MUTATE) {
  console.log('\nPart F — SKIPPED (FEAT151_SKIP_MUTATE set)');
} else {
  console.log('\nPart F — zero hot-path spawn + async hash does not stall the event loop');
  const scratch = mkdtempScratch('feat151-loop-');
  const copy = path.join(scratch, 'copy');
  fs.mkdirSync(copy);
  try {
    mkIsolatedCopy(copy);
    // (a) marker-script binary → count admission spawns. Boot runs it once (allowed).
    const marker = path.join(copy, 'spawn-marker.log');
    fs.writeFileSync(marker, '');
    const binA = platformBinPath(copy);
    fs.writeFileSync(binA, `#!/bin/sh\necho x >> "$FEAT151_MARKER"\necho "2.1.281 (Claude Code)"\n`);
    fs.chmodSync(binA, 0o755);
    const ra = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import * as fsm from 'node:fs';
      import * as cpm from 'node:child_process';
      const rt = await import('./src/server/runtime/runtime-update.ts');
      await rt.whenRuntimeChecked();
      const M = process.env.FEAT151_MARKER;
      fsm.writeFileSync(M, '');                    // clear the boot spawn
      const N = 20;
      for (let i = 0; i < N; i++) { rt.isRuntimeUpdatePending(); rt.hostSessionBlockReason(); }
      const count = (s) => s.split('\\n').filter(Boolean).length;
      const newSpawns = count(fsm.readFileSync(M, 'utf8'));
      const pending = rt.isRuntimeUpdatePending();  // healthy → false
      fsm.writeFileSync(M, '');
      const b = rt.bundledCliPath();
      for (let i = 0; i < N; i++) cpm.spawnSync(b, ['--version'], { encoding: 'utf8', timeout: 5000 });
      const oldSpawns = count(fsm.readFileSync(M, 'utf8'));
      console.log(JSON.stringify({ N, newSpawns, oldSpawns, pending }));
    `], { cwd: copy, encoding: 'utf8', env: { ...process.env, CLAUDE_STATION_DATA: path.join(copy, 'station-data'), FEAT151_MARKER: marker } });
    if (ra.status !== 0) console.log('  child stderr:', (ra.stderr || '').slice(-800));
    let a; try { a = JSON.parse(ra.stdout.trim().split('\n').pop()); } catch { a = { _raw: ra.stdout }; }
    ok('setup: boot==disk so the HEALTHY admission path is under test', a.pending === false, JSON.stringify(a));
    ok('[must-FAIL baseline] a per-admission spawn writes a marker on EVERY call', a.oldSpawns === a.N, JSON.stringify(a));
    ok('FIX: N=20 healthy admissions spawn ZERO children and re-hash NOTHING (cache hit)', a.newSpawns === 0, JSON.stringify(a));

    // (b) event-loop responsiveness during an async re-hash of the REAL 237 MB binary.
    const copyB = path.join(scratch, 'copyB');
    fs.mkdirSync(copyB);
    mkIsolatedCopy(copyB);
    const rb = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import * as fsm from 'node:fs';
      import * as cryptom from 'node:crypto';
      const rt = await import('./src/server/runtime/runtime-update.ts');
      await rt.whenRuntimeChecked();
      const bin = rt.bundledCliPath();
      // Change the binary's stat WITHOUT changing content (touch) so a re-hash fires
      // but the runtime stays coherent (content == boot).
      const t = new Date(Date.now() + 5000);
      fsm.utimesSync(bin, t, t);
      // Measure the max inter-tick gap of a 5 ms timer DURING the async re-hash.
      let asyncMaxGap = 0, last = process.hrtime.bigint();
      const iv = setInterval(() => { const now = process.hrtime.bigint(); const g = Number(now - last)/1e6; if (g > asyncMaxGap) asyncMaxGap = g; last = now; }, 5);
      const s0 = process.hrtime.bigint();
      rt.isRuntimeUpdatePending();                 // triggers ensureHash, returns "checking" immediately
      const firstCallMs = Number(process.hrtime.bigint() - s0)/1e6;
      await rt.whenRuntimeSettled();               // async hash completes
      clearInterval(iv);
      const settledPending = rt.isRuntimeUpdatePending();  // content == boot → false again
      // Baseline: a SYNCHRONOUS hash of the same file stalls the loop.
      let syncMaxGap = 0, lastS = process.hrtime.bigint();
      const ivs = setInterval(() => { const now = process.hrtime.bigint(); const g = Number(now - lastS)/1e6; if (g > syncMaxGap) syncMaxGap = g; lastS = now; }, 5);
      const h0 = process.hrtime.bigint();
      cryptom.createHash('sha256').update(fsm.readFileSync(bin)).digest('hex');
      const syncHashMs = Number(process.hrtime.bigint() - h0)/1e6;
      await new Promise((r) => setTimeout(r, 20));
      clearInterval(ivs);
      console.log(JSON.stringify({ firstCallMs, asyncMaxGap, settledPending, syncHashMs, syncMaxGap }));
    `], { cwd: copyB, encoding: 'utf8', env: { ...process.env, CLAUDE_STATION_DATA: path.join(copyB, 'station-data') } });
    if (rb.status !== 0) console.log('  child stderr:', (rb.stderr || '').slice(-800));
    let b; try { b = JSON.parse(rb.stdout.trim().split('\n').pop()); } catch { b = { _raw: rb.stdout }; }
    console.log(`  measured: firstCall=${(b.firstCallMs??0).toFixed(2)}ms asyncMaxGap=${(b.asyncMaxGap??0).toFixed(1)}ms syncHash=${(b.syncHashMs??0).toFixed(1)}ms syncMaxGap=${(b.syncMaxGap??0).toFixed(1)}ms`);
    ok('FIX: an admission during a hash-in-flight returns immediately (<50ms), not blocked on the hash', typeof b.firstCallMs === 'number' && b.firstCallMs < 50, JSON.stringify(b));
    ok('FIX: the async streamed hash does NOT stall the event loop (max 5ms-timer gap < 50ms)', typeof b.asyncMaxGap === 'number' && b.asyncMaxGap < 50, JSON.stringify(b));
    ok('baseline contrast: a synchronous hash of the real binary DOES stall the loop (gap > 100ms)', typeof b.syncMaxGap === 'number' && b.syncMaxGap > 100, JSON.stringify(b));
    ok('FIX: after the re-hash settles a touched-but-identical binary re-admits (content == boot)', b.settledPending === false, JSON.stringify(b));
  } catch (err) {
    fail++; console.log('  FAIL Part F threw —', err.message);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/* ===== Part G — revert-re-admits STAYS GREEN, proven by identical content hash ===== */
// The charter's key property: a same-version reinstall produces a BYTE-IDENTICAL
// binary (verified: sha256 equal, fresh inode), so a revert to the boot version
// hashes identically and re-admits with NO restart. Real npm: boot 0.3.280 →
// update 0.3.281 (blocked, hash changed) → revert 0.3.280 (re-admitted, hash
// restored). This is the property the round-4 hash comparison must preserve.
if (process.env.FEAT151_SKIP_MUTATE) {
  console.log('\nPart G — SKIPPED (FEAT151_SKIP_MUTATE set)');
} else {
  console.log('\nPart G — revert-before-restart RE-ADMITS (identical content hash preserved)');
  const scratch = mkdtempScratch('feat151-revert-');
  const copy = path.join(scratch, 'copy');
  fs.mkdirSync(copy);
  try {
    mkIsolatedCopy(copy);
    const down = spawnSync('npm', ['install', '--save-exact', '--ignore-scripts', '@anthropic-ai/claude-agent-sdk@0.3.280'],
      { cwd: copy, encoding: 'utf8' });
    if (down.status !== 0) { console.log('  (could not downgrade — network?)', (down.stderr || '').slice(-300)); throw new Error('setup-failed'); }
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const rt = await import('./src/server/runtime/runtime-update.ts');
      const cp = await import('node:child_process');
      await rt.whenRuntimeChecked();
      const boot = rt.BOOT_IDENTITY;                       // 0.3.280 (+ its hash) at boot
      const up = await rt.updateHostRuntime({ version: '0.3.281' });
      await rt.whenRuntimeSettled();
      const pendingAfterUpdate = rt.isRuntimeUpdatePending();   // true: hash 281 != boot 280
      const curAfterUpdate = rt.currentRuntimeIdentity();
      // Real external REVERT back to the boot version (new inode/mtime, restored bytes).
      const rev = cp.spawnSync('npm', ['install', '--save-exact', '--ignore-scripts', '@anthropic-ai/claude-agent-sdk@0.3.280'],
        { cwd: process.cwd(), encoding: 'utf8' });
      await rt.whenRuntimeSettled();
      const cur = rt.currentRuntimeIdentity();
      const pendingAfterRevert = rt.isRuntimeUpdatePending();   // FIX: false
      console.log(JSON.stringify({
        bootV: boot?.sdkVersion, bootHash: boot?.hash, upOk: up.ok, pendingAfterUpdate,
        updHash: curAfterUpdate?.hash, revStatus: rev.status, curV: cur?.sdkVersion, curHash: cur?.hash,
        pendingAfterRevert,
      }));
    `], { cwd: copy, encoding: 'utf8', env: { ...process.env, CLAUDE_STATION_DATA: path.join(copy, 'station-data') } });
    if (r.status !== 0) console.log('  child stderr:', (r.stderr || '').slice(-800));
    let c; try { c = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { c = { _raw: r.stdout }; }
    ok('setup: boot is 0.3.280 and a real update to 0.3.281 succeeded', c.bootV === '0.3.280' && c.upOk === true, JSON.stringify(c));
    ok('setup: the update BLOCKED new host sessions and CHANGED the hash', c.pendingAfterUpdate === true && c.updHash !== c.bootHash, JSON.stringify(c));
    ok('the revert restored the IDENTICAL content hash under a fresh inode', c.revStatus === 0 && c.curV === c.bootV && c.curHash === c.bootHash, JSON.stringify(c));
    ok('FIX: revert-before-restart RE-ADMITS sessions (no restart, hash matches boot)', c.pendingAfterRevert === false, JSON.stringify(c));
  } catch (err) {
    if (err.message !== 'setup-failed') { fail++; console.log('  FAIL Part G threw —', err.message); }
    else console.log('  Part G setup failed (likely offline); other parts still count.');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/* ===== Part H — round-5: the boot proof↔hash↔identity TOCTOU (swap between the ===== *
 * run-proof and the content hash). `bootChecked` proves the binary RUNS, then hashes
 * it, then seeds BOOT_IDENTITY. Round 4 resolved the binary PATH three times with no
 * consistency check, so a binary swapped in AFTER the proof but BEFORE the hash let a
 * NON-running binary's hash become the trusted baseline (fail-OPEN, round-4 verdict).
 *
 * Deterministic reproduction (both swap classes): the boot binary is a good-but-SLOW
 * script that prints a version and sleeps 3s before exit, so the async `--version`
 * proof succeeds against the GOOD (still-running, unlinked) inode; at ~800 ms — while
 * the proof is still in flight — a GARBAGE non-running binary (exit 7) is swapped over
 * the path, so the LATER hash reads the garbage bytes.
 *   - rename-over: a different inode is renamed onto the path (npm's real replace).
 *   - in-place write: the same path is truncated + overwritten (moves mtime/ctime).
 *
 * must-FAIL baseline: an inline replica of the round-4 boot (statSync → probe → hash →
 * seed identity, NO re-stat) captures bootState 'ok' with the GARBAGE hash — i.e. it
 * trusts a binary that does not run. The FIX binds proof+hash+identity to one file:
 * it re-stats after the hash, sees the identity moved, retries (the retry's proof runs
 * the garbage binary → fails), and BLOCKS with BOOT_IDENTITY null. */
if (process.env.FEAT151_SKIP_MUTATE) {
  console.log('\nPart H — SKIPPED (FEAT151_SKIP_MUTATE set)');
} else {
  console.log('\nPart H — defect (round-4 verdict): boot proof↔hash TOCTOU lets a non-running swapped binary become the baseline');
  const SLOW_GOOD = `#!/bin/sh\necho "2.1.281 (Claude Code)"\nsleep 3\nexit 0\n`;
  const GARBAGE = `#!/bin/sh\nexit 7\n`; // present + exec, but does NOT run (exit 7)
  const SWAP_DELAY = 800;                // fire mid-proof (proof sleeps 3s)

  // Shared child preamble: helpers + the swap driver, parameterised by kind.
  const CHILD_HELPERS = `
    import * as fsm from 'node:fs';
    import * as pathm from 'node:path';
    import { spawn as spawnm } from 'node:child_process';
    import { createHash as createHashm } from 'node:crypto';
    const BIN = process.env.FEAT151_BIN;
    const KIND = process.env.FEAT151_KIND;
    const SLOW_GOOD = ${JSON.stringify(SLOW_GOOD)};
    const GARBAGE = ${JSON.stringify(GARBAGE)};
    const probeRep = (bin) => new Promise((res) => {
      const c = spawnm(bin, ['--version'], { stdio: ['ignore','pipe','pipe'] });
      let out=''; c.stdout.on('data',d=>out+=d); c.stderr.on('data',d=>out+=d);
      c.on('error',()=>res(null));
      c.on('close',(code)=>{ const m=out.match(/(\\d+\\.\\d+\\.\\d+[-.\\w]*)/); res(code===0&&m?m[1]:null); });
    });
    const hashRep = (p) => new Promise((res) => {
      try { const h=createHashm('sha256'); const s=fsm.createReadStream(p);
        s.on('error',()=>res(null)); s.on('data',d=>h.update(d)); s.on('end',()=>res(h.digest('hex')));
      } catch { res(null); }
    });
    const doSwap = () => {
      try {
        if (KIND === 'rename') { const alt=BIN+'.alt'; fsm.writeFileSync(alt, GARBAGE); fsm.chmodSync(alt, 0o755); fsm.renameSync(alt, BIN); }
        else { const g=Buffer.from(GARBAGE); const fd=fsm.openSync(BIN,'r+'); fsm.ftruncateSync(fd, g.length); fsm.writeSync(fd, g, 0, g.length, 0); fsm.closeSync(fd); }
      } catch (e) { process.env._SWAP_ERR = String(e.code||e.message); }
    };
  `;

  for (const kind of ['rename', 'inplace']) {
    const scratch = mkdtempScratch(`feat151-boottoctou-${kind}-`);
    const copy = path.join(scratch, 'copy');
    fs.mkdirSync(copy);
    try {
      mkIsolatedCopy(copy);
      const bin = platformBinPath(copy);
      const childEnv = { ...process.env, CLAUDE_STATION_DATA: path.join(copy, 'station-data'), FEAT151_BIN: bin, FEAT151_KIND: kind };

      // (1) must-FAIL baseline: the round-4 boot (no re-stat) trusts the swapped binary.
      fs.writeFileSync(bin, SLOW_GOOD); fs.chmodSync(bin, 0o755);
      const rBase = spawnSync(process.execPath, ['--input-type=module', '-e', `
        ${CHILD_HELPERS}
        // schedule the swap mid-proof, then run the ROUND-4 boot replica (no re-stat).
        setTimeout(doSwap, ${SWAP_DELAY});
        let st; try { st = fsm.statSync(BIN); } catch { st = null; }
        const cliVer = st ? await probeRep(BIN) : null;       // proof: runs the GOOD inode
        const hash = cliVer != null ? await hashRep(BIN) : null; // hash: reads the SWAPPED path
        const state = (st && cliVer != null && hash != null) ? 'ok' : 'failed';
        const garbageHashNow = await hashRep(BIN);            // what is actually on disk now
        const garbageRuns = (await probeRep(BIN)) != null;    // the swapped binary does NOT run
        console.log(JSON.stringify({ state, bootHash: hash, garbageHashNow, trustsSwapped: state==='ok' && hash===garbageHashNow, garbageRuns }));
      `], { cwd: copy, encoding: 'utf8', env: childEnv });
      if (rBase.status !== 0) console.log('  child stderr:', (rBase.stderr || '').slice(-800));
      let b; try { b = JSON.parse(rBase.stdout.trim().split('\n').pop()); } catch { b = { _raw: rBase.stdout, _err: rBase.stderr }; }
      ok(`[${kind}] setup: the swapped-in binary does NOT run (exit 7)`, b.garbageRuns === false, JSON.stringify(b));
      ok(`[must-FAIL baseline / ${kind}] round-4 boot (no re-stat) trusts the SWAPPED non-running binary as the baseline`, b.trustsSwapped === true, JSON.stringify(b));

      // (2) FIX: the real module blocks — proof+hash+identity bound to one file.
      fs.writeFileSync(bin, SLOW_GOOD); fs.chmodSync(bin, 0o755);
      const rFix = spawnSync(process.execPath, ['--input-type=module', '-e', `
        ${CHILD_HELPERS}
        setTimeout(doSwap, ${SWAP_DELAY});          // swap fires mid boot-proof
        const rt = await import('./src/server/runtime/runtime-update.ts'); // boot proof spawns here
        await rt.whenRuntimeChecked();
        console.log(JSON.stringify({
          blocked: rt.isRuntimeUpdatePending() === true,
          bootIdentityNull: rt.BOOT_IDENTITY === null,
          reason: rt.hostSessionBlockReason(),
        }));
      `], { cwd: copy, encoding: 'utf8', env: childEnv });
      if (rFix.status !== 0) console.log('  child stderr:', (rFix.stderr || '').slice(-800));
      let f; try { f = JSON.parse(rFix.stdout.trim().split('\n').pop()); } catch { f = { _raw: rFix.stdout, _err: rFix.stderr }; }
      ok(`FIX [${kind}]: a swap between the boot proof and the hash BLOCKS new host sessions (fail closed)`, f.blocked === true, JSON.stringify(f));
      ok(`FIX [${kind}]: the swapped non-running binary never becomes a baseline (BOOT_IDENTITY null)`, f.bootIdentityNull === true, JSON.stringify(f));
      ok(`FIX [${kind}]: the block reason names the runtime check`, typeof f.reason === 'string' && /runtime check/.test(f.reason), f.reason);
    } catch (err) {
      fail++; console.log(`  FAIL Part H(${kind}) threw —`, err.message);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
}

/* ===== Part I — round-6: the STEADY-STATE admission cache key must include ctime ===== *
 * Round-5 added ctime to the boot/re-hash STRADDLE checks but the identity/hash CACHE
 * key stayed `statKey` = dev:ino:size:mtime (no ctime). So AFTER a clean boot, a
 * same-SIZE in-place content overwrite that RESTORES the binary's original mtime moves
 * ONLY ctime: dev:ino:size:mtime are all unchanged, the cache key matches, the stale
 * cached identity/hash is returned, and a CHANGED (non-running) binary is ADMITTED
 * (`pending:false`) — the round-5 independent-verify verdict.
 *
 * The trigger needs an exactly-restorable mtime; `utimesSync` restores a WHOLE-SECOND
 * mtime exactly (the class npm/tar/reproducible builds and `cp -p`/`rsync -t` produce),
 * so the binary's mtime is first normalised to a whole second (a re-hash of identical
 * content that re-admits) before the attack. must-FAIL baseline: a constructed
 * `statKey`-WITHOUT-ctime cache sees NO change across the mtime-restored overwrite and
 * would admit. FIX: the real module keys on dev:ino:size:mtime:ctime, so ctime moving
 * forces a re-hash, the content differs from boot, and admission fails CLOSED. */
if (process.env.FEAT151_SKIP_MUTATE) {
  console.log('\nPart I — SKIPPED (FEAT151_SKIP_MUTATE set)');
} else {
  console.log('\nPart I — defect (round-5 verdict): the steady-state cache key omits ctime → a same-size, mtime-restored in-place overwrite ADMITS a changed binary');
  const scratch = mkdtempScratch('feat151-ctimekey-');
  const copy = path.join(scratch, 'copy');
  fs.mkdirSync(copy);
  try {
    mkIsolatedCopy(copy);
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import * as fsm from 'node:fs';
      const rt = await import('./src/server/runtime/runtime-update.ts');
      await rt.whenRuntimeChecked();
      const bin = rt.bundledCliPath();
      const boot = rt.BOOT_IDENTITY;                 // { ..., hash } at boot
      // Normalise the binary's mtime to a WHOLE SECOND so utimesSync can restore it
      // EXACTLY later (sub-ms mtimes are not restorable via utimes). This is itself a
      // metadata change (re-hash of identical content) that must still admit.
      const T = new Date(1600000000000);            // 2020-09-13T12:26:40.000Z
      fsm.utimesSync(bin, T, T);
      await rt.whenRuntimeSettled();
      const pendingHealthy = rt.isRuntimeUpdatePending();   // content == boot → false
      // Snapshot dev:ino:size:mtime (NO ctime) — the round-5 cache key — before attack.
      const skNoCtime = (st) => st.dev+':'+st.ino+':'+st.size+':'+st.mtimeMs;
      const before = fsm.statSync(bin);
      const skBefore = skNoCtime(before), ctimeBefore = before.ctimeMs, sizeBefore = before.size;
      // ATTACK: same-SIZE in-place content overwrite, then RESTORE the whole-second mtime.
      const fd = fsm.openSync(bin, 'r+');
      fsm.writeSync(fd, Buffer.alloc(256, 0xfe), 0, 256, 0);   // 256 bytes, offset 0 → size unchanged
      fsm.closeSync(fd);
      fsm.utimesSync(bin, T, T);                               // restore the exact mtime
      const after = fsm.statSync(bin);
      const skAfter = skNoCtime(after), ctimeAfter = after.ctimeMs, sizeAfter = after.size;
      await rt.whenRuntimeSettled();                           // let any re-hash land
      const cur = rt.currentRuntimeIdentity();
      const newPending = rt.isRuntimeUpdatePending();
      console.log(JSON.stringify({
        pendingHealthy,
        sameSize: sizeBefore === sizeAfter,
        statKeyNoCtimeUnchanged: skBefore === skAfter,        // must-FAIL baseline: round-5 key sees NO change
        ctimeMoved: ctimeBefore !== ctimeAfter,
        oldAdmits: skBefore === skAfter,                       // a statKey-no-ctime cache → stale hit → admit
        bootHash: boot?.hash, curHash: cur?.hash,
        hashChanged: !!boot && !!cur && boot.hash !== cur.hash,
        newPending,
      }));
    `], { cwd: copy, encoding: 'utf8', env: { ...process.env, CLAUDE_STATION_DATA: path.join(copy, 'station-data') } });
    if (r.status !== 0) console.log('  child stderr:', (r.stderr || '').slice(-800));
    let c; try { c = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { c = { _raw: r.stdout }; }
    ok('setup: a healthy (mtime-normalised) runtime admits (content == boot)', c.pendingHealthy === false, JSON.stringify(c));
    ok('setup: the in-place overwrite preserved byte size and restored mtime (only ctime moved)', c.sameSize === true && c.statKeyNoCtimeUnchanged === true && c.ctimeMoved === true, JSON.stringify(c));
    ok('[must-FAIL baseline] a dev:ino:size:mtime cache key (no ctime) sees NO change and would ADMIT the changed binary', c.oldAdmits === true, JSON.stringify(c));
    ok('FIX: the ctime move forced a re-hash and the content hash CHANGED', c.hashChanged === true, JSON.stringify(c));
    ok('FIX: a same-size, mtime-restored in-place overwrite BLOCKS new host sessions (ctime in the cache key)', c.newPending === true, JSON.stringify(c));
  } catch (err) {
    fail++; console.log('  FAIL Part I threw —', err.message);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
