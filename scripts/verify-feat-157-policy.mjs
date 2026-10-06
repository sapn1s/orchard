#!/usr/bin/env node
/**
 * FEAT-157 — the base-release POLICY, without docker: the catalog parser, the one
 * target function (security floor), the derived notice, the answer rules, the
 * guide derivation, the env-table refactor, and the migration's refusal to write
 * over an unreadable registry.
 *
 * Real artifacts first: the REAL `src/server/container/base-releases.json` is
 * parsed and truncated at every 97th byte; synthetic releases are APPENDED to the
 * real v1 entry only where a property needs a value the real catalog does not
 * have yet (a security release, a v3) — labelled synthetic below.
 *
 *   node scripts/verify-feat-157-policy.mjs [--tree <dir>]
 *
 * `--tree` runs it against another tree (the pinned pre-lane snapshot) for the
 * must-FAIL run: that tree has no base-releases module, so every check fails.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const ti = process.argv.indexOf('--tree');
const TREE = ti > 0 ? path.resolve(process.argv[ti + 1]) : REPO;

let pass = 0, fail = 0;
const check = (n, ok, obs) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}\n        observed: ${obs}`); ok ? pass++ : fail++; };

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'feat157-policy-'));
process.env.CLAUDE_STATION_DATA = DATA;
const imp = async (rel) => { try { return await import(path.join(TREE, rel) + `?v=${crypto.randomUUID()}`); } catch (e) { return { __err: e }; } };

console.log(`FEAT-157 policy\n  tree under test: ${TREE}\n`);
const br = await imp('src/server/base-releases.ts');
if (br.__err || typeof br.parseCatalog !== 'function') {
  check('M0 the base-release policy module exists', false, String(br.__err?.message ?? 'no parseCatalog export').slice(0, 160));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
}

/* ---------------------------------------------------------- the catalog */
console.log('--- catalog (REAL file)');
const realRaw = fs.readFileSync(path.join(TREE, 'src/server/container/base-releases.json'), 'utf8');
const real = br.parseCatalog(realRaw);
check('C1 the real catalog parses and has ≥1 release (fails loudly if none)', real.ok && real.releases.length >= 1,
  real.ok ? `newest v${real.newest.version} (${real.newest.class}) hash ${real.newest.hash}` : real.error);
{
  const prov = await imp('src/server/provisioning.ts');
  const ok = real.ok && real.releases.every((r) => prov.recipeHash(path.join(TREE, 'src/server/container/releases', `v${r.version}`)) === r.hash);
  check('C2 every release snapshot hashes to its recorded recipe hash', ok,
    real.ok ? real.releases.map((r) => `v${r.version}:${r.hash}=${prov.recipeHash(path.join(TREE, 'src/server/container/releases', `v${r.version}`))}`).join(' ') : 'n/a');
}
{
  // Truncated reads (proof 7): every prefix of the real file must be an ERROR, never "fewer releases".
  const cuts = [];
  for (let i = 0; i < realRaw.length - 1; i += 97) cuts.push(i);
  cuts.push(realRaw.length - 2, realRaw.lastIndexOf('}') - 1);
  const bad = cuts.filter((c) => { const r = br.parseCatalog(realRaw.slice(0, c)); return r.ok; });
  check(`C3 the real catalog truncated at ${cuts.length} points never parses as a (shorter) catalog`, bad.length === 0, `ok-at-cuts=${JSON.stringify(bad)}`);
}
// Synthetic (labelled): the real v1 + appended releases.
const realJ = JSON.parse(realRaw);
const withReleases = (extra) => br.parseCatalog(JSON.stringify({ ...realJ, releases: [...realJ.releases, ...extra] }));
const v1 = realJ.releases[0];
const rel = (version, cls, extra = {}) => ({ version, date: '2026-10-01', class: cls, summary: `synthetic v${version} ${cls}`, adjust: cls === 'fix' ? '' : `adjust v${version}`, hash: v1.hash, ...(cls === 'security' ? { verify: [{ package: 'openssl', minVersion: '3.0.13-0ubuntu3.5' }] } : {}), ...extra });
{
  const noVerify = br.parseCatalog(JSON.stringify({ ...realJ, releases: [...realJ.releases, { ...rel(2, 'security'), verify: undefined }] }));
  const gap = br.parseCatalog(JSON.stringify({ ...realJ, releases: [...realJ.releases, rel(3, 'feature')] }));
  const cls = br.parseCatalog(JSON.stringify({ ...realJ, releases: [...realJ.releases, rel(2, 'urgent')] }));
  check('C4 a security release with no verify list, a version gap, an unknown class are each refused',
    !noVerify.ok && !gap.ok && !cls.ok, `${noVerify.ok ? 'OK?!' : noVerify.error.slice(0, 60)} | ${gap.ok ? 'OK?!' : gap.error.slice(0, 50)} | ${cls.ok ? 'OK?!' : cls.error.slice(0, 50)}`);
}

/* ------------------------------------------------------------- targets */
console.log('--- the one target policy (baseTarget)');
const catF = withReleases([rel(2, 'feature')]);
const catS = withReleases([rel(2, 'security'), rel(3, 'feature')]);
const catSS = withReleases([rel(2, 'security'), rel(3, 'feature'), rel(4, 'security')]);
const pin = (p, extra = {}) => ({ pinned: p, skipped: [], deferred: null, ...extra });
const T = (p, c) => br.baseTarget(br.parsePin(p), c);
{
  const t1 = T(pin(1), catF), t2 = T(pin('legacy:u1000-g1000-bcf637b5beca'), catF), t3 = T(pin('dev'), catF);
  check('T1 a feature release never moves a pin: v1 stays v1, legacy stays legacy, dev stays dev',
    t1.kind === 'version' && t1.version === 1 && !t1.raisedBySecurity && t2.kind === 'legacy' && t3.kind === 'dev', JSON.stringify([t1, t2, t3]));
}
{
  const t1 = T(pin(1), catS), tl = T(pin('legacy:u1000-g1000'), catS), t3 = T(pin(3), catS);
  check('T2 a security release raises a pin below it to the floor (v1→v2, legacy→v2) and leaves a pin above it alone (v3)',
    t1.kind === 'version' && t1.version === 2 && t1.raisedBySecurity && tl.kind === 'version' && tl.version === 2 && t3.version === 3 && !t3.raisedBySecurity,
    JSON.stringify([t1, tl, t3]));
}
{
  const t = T(pin(1), catSS);
  check('T3 the floor is the NEWEST security release above the pin (v1 with security v2 and v4 → v4)', t.kind === 'version' && t.version === 4, JSON.stringify(t));
}
{
  const miss = T(undefined, catF), bad = T({ pinned: 'latest' }, catF), gone = T(pin(9), catF), badLegacy = T(pin('legacy:../../etc'), catF);
  check('T4 missing, unreadable, unknown-version and malformed-legacy pins all enter RECOVERY (never adoption)',
    [miss, bad, gone, badLegacy].every((t) => t.kind === 'recovery'), JSON.stringify([miss, bad, gone, badLegacy].map((t) => t.why)));
}
{
  const broken = br.parseCatalog(realRaw.slice(0, 200));
  const t = T(pin(1), broken), tl = T(pin('legacy:u1000-g1000'), broken);
  // (attack round 1) a release cannot be proven without its recorded recipe hash, so a version pin goes to recovery
  // (the existing container is kept exactly as it is); a legacy pin needs no catalog and stays.
  // (round 2, b) a legacy pin too: without the catalog it is unknown whether security already moved the container.
  check('T5 an unreadable catalog never floats or builds: a version pin and a legacy pin both enter recovery (keep the container)', t.kind === 'recovery' && tl.kind === 'recovery', JSON.stringify([t, tl]));
}

{
  // (attack round 1, b) a security release outranks recovery: a lost/garbled/unknown pin is raised to the floor.
  const ts = [T(undefined, catS), T({ pinned: 'latest' }, catS)];
  const n = br.noticeFor({ projectId: 'p', imageSource: 'station', observed: { kind: 'legacy', tag: 'u1000-g1000' }, lastError: null, now: new Date('2026-10-02T12:00:00Z'), pinRaw: undefined, catalog: catS });
  check('T6 a missing or unreadable pin with a security release due is raised to the floor (not recovery), and its notice says SECURITY',
    ts.every((t) => t.kind === 'version' && t.version === 2 && t.raisedBySecurity) && n?.state === 'security-pending', `${JSON.stringify(ts.map((t) => [t.kind, t.version]))} notice=${n?.state}`);
  // (attack round 2, a) …but never DOWN: an unknown pin above the floor (a rolled-back catalog), or a container
  // already running a release at/above the floor, stays in recovery.
  const bt = (p, obs) => br.baseTarget(br.parsePin(p), catS, obs);
  const above = bt(pin(9), { kind: 'version', version: 9, hash: 'feedfeedfeed' });            // a newer checkout's v9 runs
  const runsV3 = bt(undefined, { kind: 'version', version: 3, hash: catS.releases[2].hash });   // lost pin, runs known v3
  const rolledLegacy = bt(pin('legacy:u1000-g1000'), { kind: 'version', version: 5, hash: 'aaaaaaaaaaaa' }); // security moved it to a v5 this catalog lacks
  const unknownBelow = bt(pin(9), { kind: 'version', version: 1, hash: catS.releases[0].hash }); // pin unknown, runs v1 < floor
  check('T7 the floor never moves a container DOWN or into the unknown (a release this catalog cannot place is kept; a lost pin on a container at/above the floor is kept), but an unresolvable pin on a container BELOW the floor is raised (rounds 2-3)',
    above.kind === 'recovery' && runsV3.kind === 'recovery' && rolledLegacy.kind === 'recovery' && unknownBelow.kind === 'version' && unknownBelow.version === 2,
    JSON.stringify([above.kind, runsV3.kind, rolledLegacy.kind, [unknownBelow.kind, unknownBelow.version]]));
  const adoptedFloor = bt(pin(2), { kind: 'version', version: 1, hash: catS.releases[0].hash });
  const nAdopted = br.noticeFor({ projectId: 'p', imageSource: 'station', observed: { kind: 'version', version: 1, hash: catS.releases[0].hash }, lastError: null, now: new Date('2026-10-02T12:00:00Z'), pinRaw: pin(2), catalog: catS });
  check('T9 a project that ADOPTED the security release still carries the floor (its target knows it) and its card still says SECURITY until it runs it (round 3, b)',
    adoptedFloor.kind === 'version' && adoptedFloor.floor === 2 && nAdopted?.security === true, `${JSON.stringify(adoptedFloor)} notice=${nAdopted?.state}/${nAdopted?.security}`);
  // (attack round 2, a) a release re-cut under the same number is not what the project pinned.
  const pinned = { pinned: 2, hash: '0123456789ab', skipped: [], deferred: null };
  const recut = T(pinned, catF);
  const same = T({ ...pinned, hash: catF.releases[1].hash }, catF);
  const adopted = (() => { try { return { pin: br.applyAction({ imageSource: 'station', actor: 'user', now: new Date(), action: 'adopt', version: 2, pinRaw: pin(1), catalog: catF }) }; } catch (e) { return { err: e }; } })();
  check('T8 a pin records its release recipe: the same number with another recipe is recovery (never moved); adopt writes the hash',
    recut.kind === 'recovery' && same.kind === 'version' && adopted.pin?.hash === catF.releases[1].hash, `${recut.kind} / ${same.kind} / adopt hash=${adopted.pin?.hash}`);
}

/* ------------------------------------------------------------- notices */
console.log('--- the derived notice (noticeFor)');
const NOW = new Date('2026-10-02T12:00:00Z');
const N = (o) => br.noticeFor({ projectId: 'p', imageSource: 'station', observed: null, lastError: null, now: NOW, ...o });
{
  const none = N({ pinRaw: pin(1), catalog: real.ok ? real : catF });
  const offer = N({ pinRaw: pin(1), catalog: catF, observed: { kind: 'version', version: 1 } });
  check('N1 no newer release → no notice; a newer feature release → an OFFER with Adopt/Defer/Skip',
    none === null && offer?.state === 'offer' && offer.to === 2 && JSON.stringify(offer.actions) === '["adopt","defer","skip"]', `none=${JSON.stringify(none)} offer=${offer?.state} to=${offer?.to} actions=${offer?.actions}`);
}
{
  const skipped = N({ pinRaw: pin(1, { skipped: [2] }), catalog: catF });
  const cat3 = withReleases([rel(2, 'feature'), rel(3, 'fix')]);
  const again = N({ pinRaw: pin(1, { skipped: [2] }), catalog: cat3 });
  check('N2 Skip v2: no re-notice for v2; release v3: a new notice listing BOTH v2 and v3',
    skipped === null && again?.to === 3 && JSON.stringify(again.versions) === '[2,3]', `skipped=${JSON.stringify(skipped)} again.versions=${JSON.stringify(again?.versions)}`);
}
{
  const until = new Date(NOW.getTime() + 3 * 86400000).toISOString();
  const hidden = N({ pinRaw: pin(1, { deferred: { version: 2, until } }), catalog: catF });
  const later = br.noticeFor({ projectId: 'p', imageSource: 'station', observed: null, lastError: null, now: new Date(NOW.getTime() + 4 * 86400000), pinRaw: pin(1, { deferred: { version: 2, until } }), catalog: catF });
  check('N3 Defer hides the notice until `until`, and it REOPENS by itself afterwards (no timer needed)', hidden === null && later?.state === 'offer', `hidden=${JSON.stringify(hidden)} after=${later?.state}`);
}
{
  const n = N({ pinRaw: pin(1), catalog: catS, observed: { kind: 'version', version: 1 } });
  const deferred = N({ pinRaw: pin(1, { deferred: { version: 3, until: new Date(NOW.getTime() + 86400000).toISOString() } }), catalog: catS });
  check('N4 a due security release: SECURITY notice, no Skip offered, says it is applied automatically; a Defer does not hide it',
    n?.state === 'security-pending' && n.security && !n.actions.includes('skip') && /applied automatically/.test(n.message) && deferred?.state === 'security-pending',
    `state=${n?.state} actions=${n?.actions} deferredState=${deferred?.state} msg=${n?.message.slice(0, 80)}`);
}
{
  const fresh = N({ pinRaw: pin(1), catalog: catS, now: new Date('2026-10-05T00:00:00Z') });
  const old = N({ pinRaw: pin(1), catalog: catS, now: new Date('2026-10-09T00:00:01Z') });
  check('N5 the security card escalates once due 7+ days, not before', fresh?.escalated === false && old?.escalated === true, `4d=${fresh?.escalated} 8d=${old?.escalated}`);
}
{
  const applied = N({ pinRaw: pin(1), catalog: catS, observed: { kind: 'version', version: 2 } });
  check('N6 once the container RUNS the security target, the security notice clears (the v3 offer remains)', applied?.state === 'offer' && applied.to === 3 && !applied.security,
    `state=${applied?.state} to=${applied?.to} security=${applied?.security}`);
}
{
  const failed = N({ pinRaw: pin(1), catalog: catS, lastError: 'build failed: apt' });
  check('N7 a failed security build: apply-failed, and it says new sessions are refused', failed?.state === 'apply-failed' && /refused/.test(failed.message), `${failed?.state}: ${failed?.message.slice(0, 100)}`);
}
{
  const pending = N({ pinRaw: pin(2), catalog: catF, observed: { kind: 'version', version: 1 } });
  check('N8 adopted but not yet applied: the notice stays open, desired and observed shown separately (finding 2)',
    pending?.state === 'adopted-pending' && pending.pinned === 'v2' && pending.observed === 'v1', `${pending?.state} pinned=${pending?.pinned} observed=${pending?.observed}`);
}
{
  const custom = N({ imageSource: 'custom', pinRaw: undefined, catalog: catS });
  const dismissed = N({ imageSource: 'custom', pinRaw: { skipped: [3] }, catalog: catS });
  check('N9 a prebuilt-image project gets an INFORMATIONAL notice (only Dismiss), and a dismissed one stays gone',
    custom?.state === 'informational' && JSON.stringify(custom.actions) === '["dismiss"]' && dismissed === null, `${custom?.state} ${custom?.actions} dismissed=${JSON.stringify(dismissed)}`);
}
{
  const rec = N({ pinRaw: undefined, catalog: catF });
  const cerr = N({ pinRaw: pin(1), catalog: br.parseCatalog('{') });
  check('N10 recovery and catalog-error notices are visible; catalog-error offers nothing', rec?.state === 'recovery' && cerr?.state === 'catalog-error' && cerr.actions.length === 0 && !!cerr.error,
    `${rec?.state} / ${cerr?.state} error=${cerr?.error?.slice(0, 60)}`);
}
{
  const a = N({ pinRaw: pin(1), catalog: catF });
  const b = N({ pinRaw: pin(1), catalog: withReleases([rel(2, 'feature'), rel(3, 'feature')]) });
  const c = N({ pinRaw: pin(1), catalog: catF, observed: { kind: 'legacy', tag: 'u1000-g1000' } });
  const same = N({ pinRaw: pin(1), catalog: catF });
  // (round 3, c) the same number with other content (re-cut / another checkout) is a different revision.
  const recutCat = br.parseCatalog(JSON.stringify({ ...realJ, releases: [...realJ.releases, { ...rel(2, 'feature'), summary: 'a different v2', hash: 'bbbbbbbbbbbb' }] }));
  const recut = N({ pinRaw: pin(1), catalog: recutCat });
  const other = br.noticeFor({ projectId: 'q', imageSource: 'station', observed: null, lastError: null, now: NOW, pinRaw: pin(1), catalog: catF });
  check('N11 the revision moves when what is consented to moves (a newer release, the observed base), differs per project, and is stable otherwise',
    a.rev !== b.rev && a.rev !== c.rev && a.rev === same.rev && other.rev !== a.rev && recut.rev !== a.rev, `a=${a.rev} b=${b.rev} c=${c.rev} same=${same.rev} otherProject=${other.rev} recutV2=${recut.rev}`);
}

/* ------------------------------------------------------------- actions */
console.log('--- answers (applyAction)');
const act = (o) => { try { return { pin: br.applyAction({ imageSource: 'station', actor: 'user', now: NOW, ...o }) }; } catch (e) { return { err: e }; } };
{
  const u = act({ action: 'skip', version: 2, pinRaw: pin(1), catalog: catS });
  const a = act({ action: 'skip', version: 2, pinRaw: pin(1), catalog: catS, actor: 'agent' });
  const s3 = act({ action: 'skip', version: 3, pinRaw: pin(1), catalog: catS });
  check('A1 Skip of a security release is refused for the user AND the agent (409); skipping the feature after it is allowed, the floor stays',
    u.err?.code === 'security-not-skippable' && u.err.status === 409 && a.err?.code === 'security-not-skippable' && Array.isArray(s3.pin?.skipped) && T(s3.pin, catS).version === 2,
    `user=${u.err?.code} agent=${a.err?.code} skip v3 → target ${JSON.stringify(T(s3.pin ?? pin(1), catS))}`);
}
{
  const r = act({ action: 'adopt', version: 3, pinRaw: pin(1), catalog: catSS });
  const ok = act({ action: 'adopt', version: 4, pinRaw: pin(1), catalog: catSS });
  check('A2 Adopt of an intermediate version below the security floor is refused; at the floor it pins',
    r.err?.code === 'below-security-floor' && ok.pin?.pinned === 4, `below=${r.err?.code} at=${JSON.stringify(ok.pin)}`);
}
{
  const down = act({ action: 'adopt', version: 1, pinRaw: pin(2), catalog: catF, actor: 'agent' });
  const dev = act({ action: 'pin-dev', pinRaw: pin(1), catalog: catF, actor: 'agent' });
  const udev = act({ action: 'pin-dev', pinRaw: pin(1), catalog: catF, actor: 'user' });
  check('A3 an agent cannot move a pin backwards nor to dev; the user can pick dev',
    down.err?.code === 'agent-downgrade' && dev.err?.code === 'user-only' && udev.pin?.pinned === 'dev', `down=${down.err?.code} dev=${dev.err?.code} userDev=${udev.pin?.pinned}`);
}
{
  const d = act({ action: 'defer', version: 2, pinRaw: pin(1), catalog: catF });
  const until = Date.parse(d.pin?.deferred?.until ?? '');
  check('A4 Defer records the version and a 7-day until, and does not change the pin', d.pin?.pinned === 1 && d.pin.deferred.version === 2 && Math.round((until - NOW.getTime()) / 86400000) === 7,
    JSON.stringify(d.pin));
}
{
  const c = act({ action: 'adopt', version: 2, pinRaw: undefined, catalog: catF, imageSource: 'custom' });
  const cd = act({ action: 'dismiss', version: 2, pinRaw: undefined, catalog: catF, imageSource: 'custom' });
  const sd = act({ action: 'dismiss', version: 2, pinRaw: pin(1), catalog: catF });
  const agentSec = act({ action: 'dismiss', version: 2, pinRaw: undefined, catalog: catS, imageSource: 'custom', actor: 'agent' });
  const userSec = act({ action: 'dismiss', version: 2, pinRaw: undefined, catalog: catS, imageSource: 'custom', actor: 'user' });
  check('A5 a prebuilt-image project can only Dismiss; a station project cannot Dismiss; an agent cannot dismiss a SECURITY notice (the user can)', c.err?.code === 'prebuilt-image' && JSON.stringify(cd.pin?.skipped) === '[2]' && sd.err?.code === 'not-informational' && agentSec.err?.code === 'user-only' && !!userSec.pin,
    `${c.err?.code} ${JSON.stringify(cd.pin)} ${sd.err?.code} agentSec=${agentSec.err?.code} userSec=${!!userSec.pin}`);
}
{
  const r = act({ action: 'adopt', version: 2, pinRaw: pin(1), catalog: br.parseCatalog('[') });
  check('A6 with an unreadable catalog nothing can be changed (503)', r.err?.status === 503, `${r.err?.code} ${r.err?.status}`);
}

{
  // (attack round 1, c) with the pin lost (recovery) and the container on v3, an agent could "adopt v2" — a downgrade.
  const cat3 = withReleases([rel(2, 'feature'), rel(3, 'feature')]);
  const obs3 = { kind: 'version', version: 3 };
  const lostDown = act({ action: 'adopt', version: 2, pinRaw: undefined, catalog: cat3, actor: 'agent', observed: obs3 });
  const pinDown = act({ action: 'adopt', version: 2, pinRaw: pin(1), catalog: cat3, actor: 'agent', observed: obs3 });
  const lostNewest = act({ action: 'adopt', version: 3, pinRaw: undefined, catalog: cat3, actor: 'agent', observed: obs3 });
  const userDown = act({ action: 'adopt', version: 2, pinRaw: undefined, catalog: cat3, actor: 'user', observed: obs3 });
  check('A7 an agent cannot move a project below what its container RUNS (nor pick a non-newest release for a lost pin); the user can',
    lostDown.err?.code === 'agent-downgrade' && pinDown.err?.code === 'agent-downgrade' && lostNewest.pin?.pinned === 3 && userDown.pin?.pinned === 2,
    `lost->v2=${lostDown.err?.code} pin1->v2(running v3)=${pinDown.err?.code} lost->v3=${JSON.stringify(lostNewest.pin?.pinned)} user=${userDown.pin?.pinned}`);
}

/* --------------------------------------------------------- guide derived */
console.log('--- the guide is generated from the enforcement tables');
// ONE module instance for both: templates.ts imports container-manager.ts by its plain URL, so the
// tables this test extends must be that same instance (a ?v= import would be a separate copy).
const tpl = await import(path.join(TREE, 'src/server/templates.ts'));
const cm = await import(path.join(TREE, 'src/server/container-manager.ts'));
{
  const g0 = tpl.containerBuildSection({ imageSource: 'dockerfile', answerCmd: null });
  const key = `ZZTEST_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const before = cm.reservedContainerEnvReason(key);
  cm.RESERVED_ENV_RULES.push({ exact: [key], reason: 'synthetic test rule', guide: 'synthetic guide line' });
  const g1 = tpl.containerBuildSection({ imageSource: 'dockerfile', answerCmd: null });
  const after = cm.reservedContainerEnvReason(key);
  cm.RESERVED_ENV_RULES.pop();
  check('G1 a row added to RESERVED_ENV_RULES is enforced (reservedContainerEnvReason) AND appears in the guide, with no other edit',
    before === null && after === 'synthetic test rule' && !g0.includes(key) && g1.includes(key) && g1.includes('synthetic guide line'), `before=${before} after=${after} inGuide=${g1.includes(key)}`);
}
{
  const p = { id: 'g2', name: 'g2', hostPath: DATA, isolation: 'container', settings: { mounts: [], container: { gpu: 'off' }, tools: {}, browser: { enabled: false } } };
  const flag = '--oom-score-adj';
  const a0 = cm.createArgs(p, 'n', 'img', {});
  cm.LOCKDOWN_RULES.push({ args: () => [flag, '500'], overrides: 'ZZTEST OOM', effect: 'synthetic lockdown effect' });
  const a1 = cm.createArgs(p, 'n', 'img', {});
  const g = tpl.containerBuildSection({ imageSource: 'station', answerCmd: null });
  cm.LOCKDOWN_RULES.pop();
  check('G2 a row added to LOCKDOWN_RULES reaches `docker create` (createArgs) AND the guide',
    !a0.includes(flag) && a1.includes(flag) && g.includes('ZZTEST OOM') && g.includes('synthetic lockdown effect'), `argv has flag: ${a1.includes(flag)} guide: ${g.includes('ZZTEST OOM')}`);
}
{
  cm.BUILD_RULES.push({ args: ['--zztest'], guide: 'ZZTEST build rule line' });
  const g = tpl.containerBuildSection({ imageSource: 'dockerfile', answerCmd: null });
  const spread = cm.BUILD_RULES.flatMap((r) => r.args ?? []);
  cm.BUILD_RULES.pop();
  const src = fs.readFileSync(path.join(TREE, 'src/server/container-manager.ts'), 'utf8');
  check('G3 a row added to BUILD_RULES appears in the guide and its args are what the build argv spreads (…BUILD_RULES.flatMap)',
    g.includes('ZZTEST build rule line') && spread.includes('--zztest') && /\.\.\.BUILD_RULES\.flatMap\(\(r\) => r\.args \?\? \[\]\)/.test(src) && !/'--pull',\n\s+'--build-context'/.test(src),
    `guide=${g.includes('ZZTEST build rule line')} spread=${spread.join(' ')}`);
}
{
  // The refactor of reservedContainerEnvReason must be behaviour-identical to the pre-lane `if` chain
  // (reference transcribed verbatim from the pre-lane snapshot, scratch/feat157/prelane/src/server/container-manager.ts).
  const PASS = ['ORCHARD_SESSION', 'ORCHARD_DISPATCH_ENTITLED', 'ORCHARD_DISPATCH_SOCK', 'ORCHARD_DISPATCH_CMD', 'ORCHARD_DISPATCH_UNAVAILABLE_REASON', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'ANTHROPIC_MODEL', 'DEBUG', 'DEBUG_CLAUDE_AGENT_SDK', 'MAX_THINKING_TOKENS'];
  const ref = (key) => {
    if (key === 'HOME' || key === 'CLAUDE_CONFIG_DIR' || key === 'CLAUDE_CODE_PROJECT_DIR_NAME' || key === 'CLAUDECODE' || key === 'XDG_CONFIG_HOME') return 'a';
    if (/^(ANTHROPIC_|CLAUDE_CODE_)/.test(key)) return 'b';
    if (key === 'PATH') return 'c';
    if (/^(ORCHARD_|CLAUDE_STATION_|SBMCP_)/.test(key) || PASS.includes(key)) return 'd';
    return null;
  };
  const tag = (r) => r === null ? null : /config and session history/.test(r) ? 'a' : /auth\/endpoint/.test(r) ? 'b' : /PATH/.test(r) ? 'c' : /per session/.test(r) ? 'd' : '?';
  const corpus = ['HOME', 'PATH', 'DEBUG', 'CLAUDECODE', 'CLAUDE_CODE_X', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'ORCHARD_X', 'CLAUDE_STATION_DATA', 'SBMCP_X', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'PYTHONPATH', 'LANG', 'MAX_THINKING_TOKENS', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_ENTRYPOINT', 'home', 'Path', 'ORCHARD', 'CLAUDE_', ''];
  const diff = corpus.filter((k) => ref(k) !== tag(cm.reservedContainerEnvReason(k)));
  check(`G4 the table-driven env check agrees with the pre-lane if-chain on ${corpus.length} keys`, diff.length === 0, `mismatches=${JSON.stringify(diff)}`);
}

/* ------------------------------------------------- registry truncation */
console.log('--- migration never writes over an unreadable registry');
{
  // Synthetic registry (labelled): two container projects, no pins — the pre-FEAT-157 shape.
  const reg = { version: 1, projects: [
    { id: 'mig-a', name: 'a', hostPath: DATA, isolation: 'container', settings: { container: { image: null, gpu: 'off' }, mounts: [] }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    { id: 'mig-b', name: 'b', hostPath: DATA, isolation: 'container', settings: { container: { image: 'x:y', gpu: 'off' }, mounts: [] }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  ] };
  const full = JSON.stringify(reg, null, 2);
  const cuts = [10, Math.floor(full.length / 3), Math.floor(full.length / 2), full.length - 5];
  const results = [];
  process.env.CLAUDE_STATION_DOCKER = path.join(DATA, 'no-docker'); // docker unreachable: migration must not guess either
  for (const c of cuts) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'feat157-reg-'));
    process.env.CLAUDE_STATION_DATA = d;
    fs.writeFileSync(path.join(d, 'registry.json'), full.slice(0, c));
    const cmx = await imp('src/server/container-manager.ts');
    let threw = null, res = null;
    try { res = await cmx.migrateAllBasePins(() => {}); } catch (e) { threw = e; }
    const after = fs.readFileSync(path.join(d, 'registry.json'), 'utf8');
    const extra = fs.readdirSync(d).filter((f) => f !== 'registry.json');
    results.push({ c, threw: threw?.message ?? null, migrated: res?.migrated?.length ?? null, same: after === full.slice(0, c), extra });
    fs.rmSync(d, { recursive: true, force: true });
  }
  check(`R1 a registry truncated at ${cuts.length} points: no crash, no write, no journal`, results.every((r) => !r.threw && r.same && r.migrated === 0 && !r.extra.includes('base-migration.json')), JSON.stringify(results));
  delete process.env.CLAUDE_STATION_DOCKER;
  process.env.CLAUDE_STATION_DATA = DATA;
}

fs.rmSync(DATA, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
