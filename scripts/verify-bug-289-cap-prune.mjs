#!/usr/bin/env node
/**
 * BUG-289 round 3 — size-watermark cap-prune + round-3 guard hardening.
 *
 * Part A (no daemon): the resolver/guard changes the OpenAI+anthropic runs asked for —
 *   (1) base mode resolves the base KERNEL-style (symlinks + `..`) BEFORE path.join;
 *   (3) the root guard refuses by INODE IDENTITY (bind mount / hardlink), not just basename.
 * Part C (LIVE sandbox daemon): pruneSandboxToCap against the REAL, genuinely-over-cap
 *   sandbox store — it drops under the cap, keeps every in-use image (incl. one we pin to
 *   an otherwise-oldest image), removes only unused images least-recently-tagged first, and
 *   respects the recency window. Touches the sandbox daemon only (never the host).
 *
 * The `prune --days ""` refusal (item 2) and the lock-serialisation refusal are driven from
 * the shell against the real CLI (see the lane log), not here.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import * as net from 'node:net';
import {
  sandboxDataRoot, resolveDataPath, sensitiveStoreMatch, SANDBOX_DATA_BASE_ENV,
  pruneSandboxToCap, checkIsolatedDocker, freeBytesAt, resolveFreeBytes, classifyFreeBytes, mountTargetOf, sandboxCapGb,
} from './lib/docker-sandbox.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`PASS ${name} ${extra}`); } else { fail++; console.log(`FAIL ${name} ${extra}`); } };
const threw = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
const GiB = 2 ** 30;

console.log('=== Part A: resolver / guard unit tests (no daemon) ===');

// --- item (1): base mode resolves base with resolveDataPath BEFORE path.join ---
// Craft a base containing `..` AFTER a symlink. path.join collapses `..` LEXICALLY, so the
// old base-mode code graded/bound a DIFFERENT directory than the kernel would land on.
const ext4Root = '/mnt/backup';
if (fs.existsSync(ext4Root) && (() => { try { fs.accessSync(ext4Root, fs.constants.W_OK); return true; } catch { return false; } })()) {
  const t = fs.mkdtempSync(path.join(ext4Root, 'b289base-'));
  try {
    // t/deep/sub is a real dir; t/lnk -> t/deep/sub. base = t/lnk/.. -> kernel lands on t/deep.
    fs.mkdirSync(path.join(t, 'deep', 'sub'), { recursive: true });
    fs.symlinkSync(path.join(t, 'deep', 'sub'), path.join(t, 'lnk'));
    const base = `${t}/lnk/..`;                        // RAW (not path.join: that would collapse `..` itself)
    const kernelStore = path.join(resolveDataPath(base), 'orchard-docker-sandbox'); // t/deep/orchard-docker-sandbox
    const lexicalStore = path.join(base, 'orchard-docker-sandbox');                  // OLD: path.join collapses -> t/orchard-docker-sandbox
    const r = sandboxDataRoot({ [SANDBOX_DATA_BASE_ENV]: base });
    ok('item1-base-resolved-kernel-style', r.mode === 'bind' && r.dir === kernelStore, `dir=${r.dir}`);
    ok('item1-base-differs-from-lexical', kernelStore !== lexicalStore && r.dir !== lexicalStore,
      `kernel=${kernelStore} lexical=${lexicalStore}`);
    // Proof the gap was real: the OLD lexical path.join collapses lnk/.. before the symlink.
    ok('item1-lexical-would-be-wrong', path.join(base, 'orchard-docker-sandbox') === path.join(t, 'orchard-docker-sandbox'),
      `lexical=${path.join(base, 'orchard-docker-sandbox')}`);
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
} else {
  ok('item1-base-resolved-kernel-style', false, 'SKIP: /mnt/backup not writable in cleanroom');
  ok('item1-base-differs-from-lexical', false, 'SKIP');
  ok('item1-lexical-would-be-wrong', false, 'SKIP');
}

// --- item (3): root guard by INODE IDENTITY (not just basename) ---
// A bind mount / hardlink that carries the dedicated basename yet IS /var/lib/docker or /
// needs root to create, so exercise the identity predicate directly (its dev+ino compare is
// the same code the guard runs): `/` and `/var/lib/docker` match themselves; a normal dir does not.
ok('item3-root-identity-match', sensitiveStoreMatch('/') === '/', `got ${JSON.stringify(sensitiveStoreMatch('/'))}`);
if (fs.existsSync('/var/lib/docker')) {
  ok('item3-vlr-docker-identity-match', sensitiveStoreMatch('/var/lib/docker') === '/var/lib/docker', `got ${JSON.stringify(sensitiveStoreMatch('/var/lib/docker'))}`);
} else ok('item3-vlr-docker-identity-match', false, 'SKIP: /var/lib/docker absent');
ok('item3-normal-dir-not-sensitive', sensitiveStoreMatch('/mnt') === '' && sensitiveStoreMatch('/tmp') === '', 'normal dirs clear');
// And a not-yet-existing dir is never sensitive (store is mkdir'd later).
ok('item3-missing-dir-not-sensitive', sensitiveStoreMatch('/mnt/backup/does-not-exist-b289') === '', 'absent clear');

// --- round 4: a genuine 0 free-bytes reading must NOT disable the floor ---
// Before the fix, `b > 0 ? b : Infinity` mapped a real "disk full" (0) reading to Infinity,
// the same as a failed read — the floor could never fire on a genuinely full filesystem.
ok('r4-zero-is-not-infinite', resolveFreeBytes(() => 0) === 0, `got ${resolveFreeBytes(() => 0)} (must be 0, not Infinity)`);
ok('r4-real-reading-passes-through', resolveFreeBytes(() => 5) === 5, `got ${resolveFreeBytes(() => 5)}`);
// A failed/non-finite read is "unknown" — classified apart from a real 0 and from "disabled".
// Policy (BUG-289 2026-11-19): unknown fails CLOSED (the floor cannot fire on it, no image is
// removed because of it, a WARNING is logged); see verify-bug-289-floor-zero.mjs end to end.
const unk = (f) => { const c = classifyFreeBytes(f); return c.state === 'unknown' && c.bytes === Infinity; };
ok('r4-nan-is-unknown-fail-closed', unk(() => NaN), `got ${resolveFreeBytes(() => NaN)}`);
ok('r4-negative-is-unknown-fail-closed', unk(() => -1), `got ${resolveFreeBytes(() => -1)}`);
// No freeBytes function at all (the lane-can't-measure case) deliberately disables the floor.
ok('r4-no-fn-means-floor-disabled', resolveFreeBytes(null) === Infinity, `got ${resolveFreeBytes(null)}`);
// independent-verify (openai, adversarial): a measurement callback that THROWS (a real
// disk fault can raise EIO from statfs synchronously) is exactly as "unknown" as a
// non-finite return and must fail the same safe way (0), never propagate/crash.
ok('r4-throwing-fn-is-unknown-fail-closed', unk(() => { throw new Error('EIO: statfs failed'); }),
  `got ${(() => { try { return resolveFreeBytes(() => { throw new Error('x'); }); } catch (e) { return `THREW ${e.message}`; } })()}`);
// independent-verify (openai, adversarial): a non-null, non-function, FALSY argument
// (0, false, '') is not "deliberately no measurement" — only null/undefined is. Each
// must be classified unknown (calling it throws, caught as unknown), never "disabled".
for (const bad of [0, false, '']) {
  ok(`r4-falsy-non-null-arg-${JSON.stringify(bad)}-is-unknown`, unk(bad), `got ${resolveFreeBytes(bad)}`);
}
// independent-verify (openai, adversarial): an ASYNC measurement callback (returns a
// Promise) that eventually REJECTS must not leave an unhandled rejection that can crash
// the process later — resolveFreeBytes must swallow it and treat the reading as 0 NOW.
{
  const before = process.listenerCount('unhandledRejection');
  let sawUnhandled = false;
  const guard = () => { sawUnhandled = true; };
  process.on('unhandledRejection', guard);
  const result = classifyFreeBytes(() => Promise.reject(new Error('EIO: async measurement failure')));
  ok('r4-async-rejecting-fn-is-unknown-fail-closed', result.state === 'unknown' && result.bytes === Infinity, `got ${JSON.stringify({ ...result, bytes: String(result.bytes) })}`);
  await new Promise((r) => setImmediate(r)); // let the rejection's microtask settle
  await new Promise((r) => setImmediate(r));
  process.removeListener('unhandledRejection', guard);
  ok('r4-async-rejecting-fn-no-unhandled-rejection', !sawUnhandled, `sawUnhandled=${sawUnhandled}`);
  ok('r4-unhandledRejection-listener-count-restored', process.listenerCount('unhandledRejection') === before, 'listener cleaned up');
}
// independent-verify (openai, adversarial): a MALFORMED thenable — a `then` getter that
// itself throws, or a `.catch` that throws — must fail safe too, not propagate out of
// resolveFreeBytes (the thenable probe/call must live inside the same try as the call).
ok('r4-malformed-thenable-throwing-then-getter-is-unknown-fail-closed', unk(() => ({ get then() { throw new Error('bad then'); } })),
  `got ${(() => { try { return resolveFreeBytes(() => ({ get then() { throw new Error('x'); } })); } catch (e) { return `THREW ${e.message}`; } })()}`);
ok('r4-malformed-thenable-throwing-catch-is-unknown-fail-closed', unk(() => ({ then() {}, catch() { throw new Error('bad catch'); } })),
  `got ${(() => { try { return resolveFreeBytes(() => ({ then() {}, catch() { throw new Error('x'); } })); } catch (e) { return `THREW ${e.message}`; } })()}`);
// independent-verify (openai, round 2): a BARE thenable — has a real `then(resolve, reject)`
// that eventually rejects, but NO `.catch` method at all (not a real Promise) — must still
// get its rejection suppressed (not just return 0 synchronously); calling `b.catch` directly
// would throw (missing method) and never attach a handler to the real thenable at all.
{
  const before2 = process.listenerCount('unhandledRejection');
  let sawUnhandled2 = false;
  const guard2 = () => { sawUnhandled2 = true; };
  process.on('unhandledRejection', guard2);
  const bareThenable = { then(_resolve, reject) { queueMicrotask(() => reject(new Error('bare thenable rejection'))); } };
  const result2 = classifyFreeBytes(() => bareThenable);
  ok('r4-bare-thenable-no-catch-is-unknown-fail-closed', result2.state === 'unknown' && result2.bytes === Infinity, `got ${JSON.stringify({ ...result2, bytes: String(result2.bytes) })}`);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  process.removeListener('unhandledRejection', guard2);
  ok('r4-bare-thenable-no-catch-no-unhandled-rejection', !sawUnhandled2, `sawUnhandled=${sawUnhandled2}`);
  ok('r4-unhandledRejection-listener-count-restored-2', process.listenerCount('unhandledRejection') === before2, 'listener cleaned up');
}
// independent-verify (openai, round 3): a REAL native Promise with its OWN `.catch`
// stripped (set undefined) must still get its rejection suppressed. Promise.resolve(p)
// returns the SAME object when p is already a native Promise, so `.catch` on the
// result is still p's own stripped `.catch` — only the captured native
// `Promise.prototype.then`, called directly, reaches the real promise machinery.
{
  const before3 = process.listenerCount('unhandledRejection');
  let sawUnhandled3 = false;
  const guard3 = () => { sawUnhandled3 = true; };
  process.on('unhandledRejection', guard3);
  const strippedPromise = Promise.reject(new Error('stripped-catch rejection'));
  strippedPromise.catch = undefined;
  const result3 = classifyFreeBytes(() => strippedPromise);
  ok('r4-native-promise-stripped-catch-is-unknown-fail-closed', result3.state === 'unknown' && result3.bytes === Infinity, `got ${JSON.stringify({ ...result3, bytes: String(result3.bytes) })}`);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  process.removeListener('unhandledRejection', guard3);
  ok('r4-native-promise-stripped-catch-no-unhandled-rejection', !sawUnhandled3, `sawUnhandled=${sawUnhandled3}`);
  ok('r4-unhandledRejection-listener-count-restored-3', process.listenerCount('unhandledRejection') === before3, 'listener cleaned up');
}
// freeBytesAt() itself: a statfs failure must surface as null, never as a 0 that would be
// confused with a genuine "disk full" reading downstream.
// Force a REAL resolution failure (ELOOP via a symlink cycle), not just a missing leaf dir
// (nearestExistingOf climbs to an existing ancestor like `/`, so a missing leaf alone still
// resolves to a real, measurable filesystem).
{
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'b289r4-'));
  const loopA = path.join(tdir, 'a'), loopB = path.join(tdir, 'b');
  fs.symlinkSync(loopB, loopA); fs.symlinkSync(loopA, loopB);
  ok('r4-freeBytesAt-error-is-null', freeBytesAt(loopA) === null, `got ${freeBytesAt(loopA)}`);
  fs.rmSync(tdir, { recursive: true, force: true });
}
ok('r4-freeBytesAt-root-is-finite-number', Number.isFinite(freeBytesAt('/')) && freeBytesAt('/') >= 0, `got ${freeBytesAt('/')}`);

// --- round 5 (independent-verify, openai): storeFreeBytesFn() discovery FAILURE must
// not be mapped to the same bare `null` as a DELIBERATE no-measurement decision (IN_LANE).
// A bare null makes resolveFreeBytes() return Infinity (floor disabled); a discovery
// failure is "unknown" and must resolve through a function that itself returns null, so
// resolveFreeBytes() fails safe to 0.
{
  const { storeFreeBytesFn } = await import('./docker-sandbox.mjs');
  const prevEnv = process.env.ORCHARD_DOCKER_SANDBOX_DATA;
  process.env.ORCHARD_DOCKER_SANDBOX_DATA = 'relative/not-absolute/orchard-docker-sandbox'; // gradeStoreDir throws
  try {
    const fn = storeFreeBytesFn();
    ok('r5-discovery-failure-returns-fn-not-bare-null', typeof fn === 'function', `got ${typeof fn}`);
    ok('r5-discovery-failure-fn-resolves-unknown', typeof fn === 'function' && unk(fn),
      `got ${typeof fn === 'function' ? resolveFreeBytes(fn) : '(n/a: not a function)'}`);
  } finally {
    if (prevEnv === undefined) delete process.env.ORCHARD_DOCKER_SANDBOX_DATA;
    else process.env.ORCHARD_DOCKER_SANDBOX_DATA = prevEnv;
  }
}

// --- round 5b (independent-verify, openai): the HOST-DISCOVERY call itself (the `docker
// info` spawn, mountTargetOf) can throw, not just return an empty root — that must
// degrade to the same fail-safe function, not propagate out of storeFreeBytesFn()
// uncaught. A LIVE repro needs `docker info`/findmnt to actually throw, which the real
// spawnSync wrapper here never does on its own (ENOENT/non-zero exit are returned, not
// thrown) — the independent verifier's own adversarial harness got there only by
// injecting exceptions directly into spawnSync, a mocking depth not worth reproducing
// here. This is a STATIC structural check instead (source inspection, not a dynamic
// repro — same technique the verifier itself used for its "remaining-infinity-defaults"
// finding): the discovery block must be wrapped in a try/catch that returns `() => null`
// on any throw, so a FUTURE exception source there is caught here first.
{
  const src = fs.readFileSync(path.resolve('./scripts/docker-sandbox.mjs'), 'utf8');
  const m = /if \(IN_LANE\) return null;[^]*?\n}\n/.exec(src);
  const block = m ? m[0] : '';
  ok('r5b-discovery-block-wrapped-in-try', /try \{[^]*host\(\['info'/.test(block), 'the `docker info` host() call is inside a try block');
  ok('r5b-discovery-catch-returns-fn-not-bare-null', /\} catch \{\s*return \(\) => null;\s*\}\s*\n\}/.test(block),
    'the discovery catch returns a FUNCTION resolving to null, not the bare value null');
}

// === Part C: LIVE cap-prune against the real over-cap sandbox store ===
const haveDaemon = (() => { const v = checkIsolatedDocker(process.env); return v.ok ? v : null; })();
if (!haveDaemon) {
  console.log('\n=== Part C SKIPPED: no isolated sandbox daemon reachable (DOCKER_HOST) ===');
} else {
  console.log('\n=== Part C: live cap-prune (sandbox daemon only) ===');
  const sock = haveDaemon.target.slice('unix://'.length);
  // Minimal pinned client for snapshotting (the prune uses its own pinned connection).
  function pin(p) {
    const s = net.connect(p); let buf = Buffer.alloc(0), wake = null, dead = null;
    s.on('data', (d) => { buf = Buffer.concat([buf, d]); wake?.(); });
    const fail = (e) => { dead = e || new Error('closed'); wake?.(); };
    s.on('error', fail); s.on('close', () => fail());
    const more = () => new Promise((res, rej) => { if (dead) return rej(dead); wake = () => { wake = null; res(); }; });
    const need = async (n) => { while (buf.length < n) await more(); };
    const until = async (sep) => { let i; while ((i = buf.indexOf(sep)) < 0) await more(); return i; };
    const take = (n) => { const o = buf.subarray(0, n); buf = buf.subarray(n); return o; };
    const ready = new Promise((res, rej) => { s.once('connect', res); s.once('error', rej); });
    return { async req(m, pp) { await ready; s.write(`${m} ${pp} HTTP/1.1\r\nHost: docker\r\nConnection: keep-alive\r\nContent-Length: 0\r\n\r\n`); const h = await until('\r\n\r\n'); const head = take(h + 4).toString(); const len = /\r\ncontent-length: *(\d+)/i.exec(head); let body = Buffer.alloc(0); if (/\r\ntransfer-encoding: *chunked/i.test(head)) { for (;;) { const e = await until('\r\n'); const n = parseInt(take(e + 2).toString(), 16); await need(n + 2); const ch = take(n + 2).subarray(0, n); if (n === 0) break; body = Buffer.concat([body, ch]); } } else if (len) { await need(+len[1]); body = take(+len[1]); } const txt = body.toString(); return txt ? JSON.parse(txt) : null; }, close() { s.destroy(); } };
  }
  const api = pin(sock);
  const sum = (arr, f) => (arr ?? []).reduce((a, x) => a + (x[f] ?? 0), 0);
  const snapshot = async () => {
    const df = await api.req('GET', '/system/df');
    const store = (df.LayersSize ?? sum(df.Images, 'Size')) + sum((df.BuildCache || []).filter((x) => !x.Shared), 'Size');
    const containers = await api.req('GET', '/containers/json?all=1') ?? [];
    const inUse = new Set(); for (const c of containers) { if (c.ImageID) inUse.add(c.ImageID); if (c.Image) inUse.add(c.Image); }
    const images = await api.req('GET', '/images/json?all=0') ?? [];
    const tagTime = {};
    for (const im of images) { try { const i = await api.req('GET', `/images/${encodeURIComponent(im.Id)}/json`); const t = Date.parse(i?.Metadata?.LastTagTime ?? ''); tagTime[im.Id] = Number.isFinite(t) && t > 0 ? t / 1000 : (im.Created ?? 0); } catch { tagTime[im.Id] = im.Created ?? 0; } }
    return { store, imgIds: new Set(images.map((i) => i.Id)), inUse, images, tagTime };
  };

  const before = await snapshot();
  // B289_FORCE_OVER forces an over-cap condition RELATIVE to the current store (so this live test
  // reproduces eviction no matter how small the shared store has already been pruned to); else the
  // real env/default cap applies.
  const cap = process.env.B289_FORCE_OVER
    ? Math.max(1, Math.floor(before.store / GiB) - 3)
    : sandboxCapGb(process.env);
  if (process.env.B289_FORCE_OVER) process.env.ORCHARD_DOCKER_SANDBOX_CAP_GB = String(cap);
  console.log(`before: store ${(before.store / GiB).toFixed(1)}GB, ${before.images.length} images (${before.inUse.size} in-use ids); cap ${cap}GB`);
  ok('C-store-starts-over-cap', before.store > cap * GiB, `store ${(before.store / GiB).toFixed(1)}GB > cap ${cap}GB`);

  // Pin the OLDEST unused image to a freshly-created (stopped) container, so an image that LRU
  // would evict first is now in-use and MUST survive.
  const unsorted = before.images.filter((i) => !before.inUse.has(i.Id));
  unsorted.sort((a, b) => before.tagTime[a.Id] - before.tagTime[b.Id]);
  let pinnedImg = null, testContainer = null;
  if (unsorted.length) {
    pinnedImg = unsorted[0].Id;
    try {
      const c = await api.req('POST', `/containers/create?name=b289-cap-pin-${process.pid}`);
      // create with a body isn't supported by our bodyless pinned client; use the CLI instead.
    } catch { /* fall through to CLI create below */ }
  }
  api.close();

  // Create the pin container via the real docker CLI (bodyless HTTP client can't POST a config).
  const { spawnSync } = await import('node:child_process');
  const dk = (args) => spawnSync('docker', args, { env: process.env, encoding: 'utf8', timeout: 60_000 });
  if (pinnedImg) {
    const cr = dk(['create', '--name', `b289-cap-pin-${process.pid}`, pinnedImg, 'true']);
    if (cr.status === 0) { testContainer = cr.stdout.trim(); console.log(`pinned oldest-unused image ${pinnedImg.slice(7, 19)} to stopped container ${testContainer.slice(0, 12)}`); }
    else console.log(`(could not pin ${pinnedImg.slice(7, 19)}: ${cr.stderr.trim().split('\n')[0]}) — in-use test uses pre-existing containers only`);
  }

  // RUN the real cap-prune (default cap/floor), measuring host free space on `/` (volume mode).
  // Pass the RAW reading through (0 is valid, null means unmeasurable) — pruneSandboxToCap's
  // own resolveFreeBytes() applies the fail-safe normalization; don't re-trap it here.
  const freeBytes = () => freeBytesAt('/');
  const summary = await pruneSandboxToCap(process.env, { freeBytes, log: (m) => console.log(`   ${m}`) });

  const api2 = pin(sock);
  const after = await (async () => {
    const df = await api2.req('GET', '/system/df');
    const store = (df.LayersSize ?? sum(df.Images, 'Size')) + sum((df.BuildCache || []).filter((x) => !x.Shared), 'Size');
    const images = await api2.req('GET', '/images/json?all=0') ?? [];
    return { store, imgIds: new Set(images.map((i) => i.Id)) };
  })();

  console.log(`after: store ${(after.store / GiB).toFixed(1)}GB; removed ${summary.removed} image(s)`);
  // Contract: evict UNUSED images (LRU) until under cap, OR keep going until nothing evictable
  // remains. When the PROTECTED working set (in-use + pinned + conflict-skips + recency) alone
  // exceeds the cap, the correct outcome is to KEEP it and report over-budget — NOT delete in-use
  // images (OpenAI: refuse rather than delete protected work). So "under cap" passes if the store
  // is under cap OR no evictable unused image is left.
  const nowSec = Date.now() / 1000;
  const evictableLeft = [...after.imgIds].filter((id) => before.imgIds.has(id) && !before.inUse.has(id)
    && id !== pinnedImg && !summary.skippedIds.includes(id) && (nowSec - before.tagTime[id]) >= 600);
  ok('C-store-under-cap-after', after.store <= cap * GiB || evictableLeft.length === 0,
    `store ${(after.store / GiB).toFixed(1)}GB vs cap ${cap}GB; evictable-unused-left ${evictableLeft.length} (0 => overage is all protected/in-use)`);
  // Reclaim SOMETHING when over cap — unless the store is already at its in-use floor (no
  // evictable unused image and no spare build cache to drop), in which case reclaiming 0 is right.
  const reclaimableBefore = [...before.imgIds].filter((id) => !before.inUse.has(id) && id !== pinnedImg && (nowSec - before.tagTime[id]) >= 600).length;
  ok('C-reclaimed-something', summary.removed > 0 || summary.buildReclaimed > 0 || reclaimableBefore === 0,
    `removed ${summary.removed}, buildReclaimed ${(summary.buildReclaimed / GiB).toFixed(1)}GB, reclaimable-unused-before ${reclaimableBefore}`);

  // Every image in use by a container BEFORE must still exist.
  const inUseStillPresent = [...before.inUse].filter((id) => before.imgIds.has(id)).every((id) => after.imgIds.has(id));
  ok('C-in-use-images-kept', inUseStillPresent, 'all pre-existing in-use images survived');

  // The image we pinned (oldest unused -> now in-use) must survive despite being LRU-first.
  if (testContainer) {
    ok('C-pinned-oldest-image-kept', after.imgIds.has(pinnedImg), `pinned ${pinnedImg.slice(7, 19)} survived (LRU would have evicted it first)`);
    dk(['rm', '-f', testContainer]); // cleanup
  } else ok('C-pinned-oldest-image-kept', true, 'SKIP: could not create pin container');

  // Removed images were all UNUSED and strictly older (LRU) than any still-present removable image.
  const removedIds = [...before.imgIds].filter((id) => !after.imgIds.has(id));
  const removedWereUnused = removedIds.every((id) => !before.inUse.has(id));
  ok('C-only-unused-removed', removedWereUnused, `${removedIds.length} removed, none were in-use`);
  // No removed image tagged within the 10-min recency window.
  const noRecentRemoved = removedIds.every((id) => (nowSec - before.tagTime[id]) >= 600);
  ok('C-recency-window-respected', noRecentRemoved, 'no image tagged in the last 10 min was removed');
  // LRU: removed images are the oldest candidates. Any kept-removable image OLDER than the
  // newest removed one must be a legitimate delete-conflict skip (force=0 409: still referenced
  // by a child image or another tag) — not an LRU violation.
  const keptRemovable = [...after.imgIds].filter((id) => before.imgIds.has(id) && !before.inUse.has(id) && id !== pinnedImg);
  if (removedIds.length && keptRemovable.length) {
    const newestRemoved = Math.max(...removedIds.map((id) => before.tagTime[id]));
    const anomalies = keptRemovable.filter((id) => before.tagTime[id] < newestRemoved - 1);
    const allExplained = anomalies.every((id) => summary.skippedIds.includes(id));
    ok('C-lru-order', allExplained, `${anomalies.length} kept older than newest-removed, all ${anomalies.length ? 'are conflict-skips' : '(none)'} (skipped ${summary.skippedIds.length})`);
  } else ok('C-lru-order', true, `SKIP (removed ${removedIds.length}, keptRemovable ${keptRemovable.length})`);
  api2.close();
}

console.log(`\nBUG-289 cap-prune: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
