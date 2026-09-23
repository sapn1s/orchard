#!/usr/bin/env node
/**
 * verify-feat-multi-account-store-guard.mjs — symlink-aware real-store guard.
 *
 * THE BUG (pre-existing, latent, data-loss class). `assertSessionStoreIsolated`
 * (src/lib/paths.ts) decides "would this session write the user's REAL
 * ~/.claude/projects store?" by comparing the CLI's store dir against
 * `realClaudeStoreDir`. The pre-fix compare was purely LEXICAL
 * (`path.resolve(store) !== path.resolve(real)`): so a store that is a SYMLINK
 * resolving TO the real store differs as a string, the guard returns silently,
 * and a non-sanctioned writer pollutes the real store UNREPORTED. Multi-account
 * support introduces exactly that shape — an account config dir holds
 * `projects -> ~/.claude/projects`.
 *
 * DRIVEN, NOT ASSERTED. Section 1 builds a REAL symlink on disk (scratch fake
 * home) and drives the ACTUAL guard through it. The must-FAIL baseline is the
 * pre-fix LEXICAL predicate, synthesized INLINE here (never checked out from an
 * old revision, so it stays a real proof after the fix commits — CONVENTIONS:
 * "a must-FAIL proof must not be anchored to a moving baseline").
 *
 * Every check prints the OBSERVED value, and asserts its own precondition first
 * so nothing can pass vacuously (WA §C). Uses only a scratch fake home under a
 * mkdtemp dir — NEVER the real ~/.claude/projects.
 *
 * Run: node scripts/verify-feat-multi-account-store-guard.mjs   (free, gate-safe)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  claudeStoreDir, realClaudeStoreDir, assertSessionStoreIsolated,
  markSanctionedRealStoreWriter, isSanctionedRealStoreWriter,
} from '../src/lib/paths.ts';

let pass = 0, fail = 0;
const ok = (name, cond, observed = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${observed ? `  [${observed}]` : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${observed ? `  [${observed}]` : ''}`); }
};
const section = (s) => console.log(`\n== ${s}`);
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

// A scratch fake home. We CANNOT redirect realClaudeStoreDir (it reads the true
// os.homedir()), so instead we build a store dir that IS a symlink pointing at a
// fake "real store", and drive the guard with an env whose CLAUDE_CONFIG_DIR is
// that symlinked account dir. The lexical strings differ; the realpaths match.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-multi-acct-'));
process.on('exit', () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {} });

// CRITICAL: point HOME at a scratch fake home. Node's os.homedir() honours $HOME
// on POSIX (verified), and realClaudeStoreDir()/claudeStoreDir() both read it, so
// the guard's OWN notion of "the real store" now lives under scratch — we never
// touch, symlink to, or read the machine's true ~/.claude/projects.
process.env.HOME = path.join(SCRATCH, 'home');

// The stand-in for the user's REAL store (== realClaudeStoreDir() now that HOME
// points here) — a directory that exists on disk.
const FAKE_REAL_STORE = path.join(SCRATCH, 'home', '.claude', 'projects');
fs.mkdirSync(FAKE_REAL_STORE, { recursive: true });
if (path.resolve(realClaudeStoreDir({})) !== path.resolve(FAKE_REAL_STORE)) {
  console.error(`SETUP FAILED: realClaudeStoreDir=${realClaudeStoreDir({})} != ${FAKE_REAL_STORE} (HOME override did not take)`);
  process.exit(2);
}

// The pre-fix predicate, synthesized INLINE. Returns true when the guard would
// early-return ("isolated store: fine") — i.e. the write is considered safe.
// This is the LEXICAL compare the buggy guard used, verbatim in spirit.
const preFixConsideredIsolated = (env) =>
  path.resolve(claudeStoreDir(env)) !== path.resolve(realClaudeStoreDir(env));

/* ─────────────────── 1. THE BUG: symlinked store, must-FAIL → must-PASS */
section('1. store is a SYMLINK to the real store — pre-fix disarms, post-fix throws');
{
  // Account config dir with `projects -> <FAKE_REAL_STORE>`, the multi-account shape.
  const acctDir = path.join(SCRATCH, 'accounts', 'acme');
  fs.mkdirSync(acctDir, { recursive: true });
  const link = path.join(acctDir, 'projects');
  fs.symlinkSync(FAKE_REAL_STORE, link);

  // Precondition: the symlink really exists and really resolves to the fake real store.
  ok('precondition: projects symlink exists and resolves to the fake real store',
    fs.lstatSync(link).isSymbolicLink() && fs.realpathSync.native(link) === fs.realpathSync.native(FAKE_REAL_STORE),
    `${link} -> ${fs.realpathSync.native(link)}`);

  // Drive the guard as a NON-sanctioned, half-isolated harness (isolated station
  // data dir + this symlinked store). CLAUDE_CONFIG_DIR = acctDir, so
  // claudeStoreDir(env) = acctDir/projects (the symlink).
  const env = { CLAUDE_STATION_DATA: path.join(SCRATCH, 'data'), CLAUDE_CONFIG_DIR: acctDir };

  // Precondition: the lexical strings DO differ (else the test proves nothing) —
  // this is why the pre-fix compare was fooled.
  const storeStr = path.resolve(claudeStoreDir(env));
  const realStr = path.resolve(realClaudeStoreDir(env));
  ok('precondition: the two store strings DIFFER lexically (the disarming condition)',
    storeStr !== realStr, `store=${storeStr} real=${realStr}`);

  // must-FAIL (pre-fix): the lexical predicate treats the symlinked store as
  // isolated → the guard would early-return → NO throw → the real store is polluted.
  const preIsolated = preFixConsideredIsolated(env);
  ok('CONTROL (pre-fix lexical): symlinked store is (wrongly) treated as ISOLATED — guard would NOT throw',
    preIsolated === true, `preFixConsideredIsolated=${preIsolated}`);

  // must-PASS (post-fix): the shipped guard resolves the symlink, sees the real
  // store, and — being an unsanctioned harness — THROWS.
  const msg = throws(() => assertSessionStoreIsolated(env, { label: 'acme-account' }));
  ok('POST: shipped guard THROWS on the symlinked-onto-real store (bug fixed)',
    !!msg && /REFUSING/.test(msg), msg ? msg.slice(0, 90) : 'no throw');
}

/* ─────────────────── 2. REGRESSION: a genuinely separate account still returns silently */
section('2. a genuinely separate (non-symlinked) account store — no spurious throw');
{
  // A real, materialised account store that is NOT a symlink onto the real store.
  const acctDir = path.join(SCRATCH, 'accounts', 'other');
  const realProjects = path.join(acctDir, 'projects');
  fs.mkdirSync(realProjects, { recursive: true });
  ok('precondition: the separate account store exists and is NOT a symlink',
    fs.existsSync(realProjects) && !fs.lstatSync(realProjects).isSymbolicLink(), realProjects);

  const env = { CLAUDE_STATION_DATA: path.join(SCRATCH, 'data'), CLAUDE_CONFIG_DIR: acctDir };
  ok('precondition: its canonical path differs from the real store',
    fs.realpathSync.native(realProjects) !== fs.realpathSync.native(FAKE_REAL_STORE),
    `${fs.realpathSync.native(realProjects)} vs ${fs.realpathSync.native(FAKE_REAL_STORE)}`);

  const msg = throws(() => assertSessionStoreIsolated(env, { label: 'other-account' }));
  ok('a separate account store does NOT throw (multi-account would break otherwise)',
    msg === null, msg ? msg.slice(0, 90) : 'no throw (correct)');
}

/* ─────────────────── 3. real-store semantics preserved (sanctioned vs not) */
section('3. real-store path unchanged — sanctioned+shared passes, unsanctioned throws');
{
  // No CLAUDE_CONFIG_DIR → claudeStoreDir === realClaudeStoreDir (the true real store).
  const env = {}; // shared data dir (no CLAUDE_STATION_DATA), no config override.
  ok('precondition: with no override, store lexically IS the real store',
    path.resolve(claudeStoreDir(env)) === path.resolve(realClaudeStoreDir(env)),
    path.resolve(claudeStoreDir(env)));

  // Unsanctioned (marker not yet set): must throw.
  ok('precondition: this process is not yet the sanctioned server', isSanctionedRealStoreWriter() === false);
  const unsancMsg = throws(() => assertSessionStoreIsolated(env, { label: 'unsanctioned' }));
  ok('unsanctioned writer to the real store THROWS',
    !!unsancMsg && /not the production station server/.test(unsancMsg),
    unsancMsg ? unsancMsg.slice(0, 90) : 'no throw');

  // Sanctioned + shared data dir: must pass.
  markSanctionedRealStoreWriter();
  ok('precondition: process is now the sanctioned server', isSanctionedRealStoreWriter() === true);
  const sancMsg = throws(() => assertSessionStoreIsolated(env, { label: 'sanctioned' }));
  ok('sanctioned server in shared-data mode is ALLOWED (no throw)',
    sancMsg === null, sancMsg ? sancMsg.slice(0, 90) : 'no throw (correct)');

  // Even sanctioned, an isolated DATA dir writing the real store is STILL refused
  // (semantics preserved: dataDirMode must be shared).
  const isoMsg = throws(() => assertSessionStoreIsolated(
    { CLAUDE_STATION_DATA: path.join(SCRATCH, 'data') }, { label: 'sanctioned-but-isolated-data' }));
  ok('sanctioned marker does NOT excuse isolated-DATA real-store write (semantics preserved)',
    !!isoMsg && /REFUSING/.test(isoMsg), isoMsg ? isoMsg.slice(0, 90) : 'no throw');
}

/* ─────────────────── 4. non-existent CLAUDE_CONFIG_DIR must not crash */
section('4. CLAUDE_CONFIG_DIR pointing at a non-existent path — guard does not crash');
{
  const missing = path.join(SCRATCH, 'no', 'such', 'account-dir-xyz');
  ok('precondition: the config dir genuinely does not exist', !fs.existsSync(missing), missing);

  // Sanctioned or not, the store is isolated (a scratch path) → the guard must
  // simply return, and above all must NOT throw an ENOENT from realpath.
  const env = { CLAUDE_STATION_DATA: path.join(SCRATCH, 'data'), CLAUDE_CONFIG_DIR: missing };
  let threw = false, crashedNonRefusal = false;
  try { assertSessionStoreIsolated(env, { label: 'missing-cfg' }); }
  catch (e) { threw = true; crashedNonRefusal = !/REFUSING/.test(e.message); }
  ok('a non-existent CLAUDE_CONFIG_DIR does NOT crash the guard (no ENOENT, no throw)',
    !threw, threw ? (crashedNonRefusal ? 'CRASHED (non-refusal)' : 'threw REFUSING (wrong)') : 'returned cleanly');
}

/* ═══════════════════════════════════════════════════════════════════════════
 * ROUND 2 — the DANGLING-symlink hole the round-1 fix left open.
 *
 * Round 1 replaced the lexical compare with a `realpathSync.native` +
 * nearest-existing-ancestor canonicaliser. `realpathSync` throws ENOENT on a
 * DANGLING symlink exactly as it does on an absent plain file, so the fallback
 * re-appended the LINK'S OWN NAME lexically and never read its TARGET: a
 * `projects -> ~/.claude/projects` link created before the real store exists
 * (fresh machine, or the TOCTOU window before the CLI creates the target)
 * canonicalised to `<acct>/projects`, the guard concluded "isolated", and the
 * CLI — which resolves the link on write — wrote the user's real store. An
 * ENOENT DISARMED the guard, the inverse of the fix's own invariant.
 *
 * The must-FAIL baseline below is ROUND 1's canonicaliser, synthesized INLINE
 * (never `git show`n from a revision, which would stop failing the moment this
 * fix commits — CONVENTIONS: "a must-FAIL proof must not be anchored to a
 * moving baseline").
 * ═══════════════════════════════════════════════════════════════════════════ */

// ROUND 1's canonicalNearest, verbatim in behaviour. Synthesized here, on purpose.
const round1CanonicalNearest = (p) => {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return tail.length ? path.join(real, ...tail) : real;
    } catch (err) {
      if (err.code !== 'ENOENT') return path.resolve(p);
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
};
// True when ROUND 1 would take the `return // isolated store: fine` branch.
const round1ConsideredIsolated = (env) =>
  round1CanonicalNearest(claudeStoreDir(env)) !== round1CanonicalNearest(realClaudeStoreDir(env));

const DATA = path.join(SCRATCH, 'data'); // isolated station data dir => never sanctioned-exempt
const rmRealStore = () => { fs.rmSync(path.join(SCRATCH, 'home', '.claude'), { recursive: true, force: true }); };
const mkRealStore = () => { fs.mkdirSync(FAKE_REAL_STORE, { recursive: true }); };
// Precondition helper: the account's `projects` entry is a symlink whose target
// (read WITHOUT following it) is the real store, while the real store is absent.
const linkTarget = (l) => fs.readlinkSync(l);

/* ─────────────────── 5. THE ROUND-2 BUG: DANGLING projects -> real store */
section('5. DANGLING `projects -> <real store>` (real store absent) — round 1 disarms, round 2 throws');
{
  rmRealStore();
  const acctDir = path.join(SCRATCH, 'accounts', 'dangling');
  fs.mkdirSync(acctDir, { recursive: true });
  const link = path.join(acctDir, 'projects');
  fs.symlinkSync(FAKE_REAL_STORE, link);
  const env = { CLAUDE_STATION_DATA: DATA, CLAUDE_CONFIG_DIR: acctDir };

  ok('precondition: the real store genuinely does NOT exist (fresh-machine / TOCTOU window)',
    !fs.existsSync(FAKE_REAL_STORE) && !fs.existsSync(path.dirname(FAKE_REAL_STORE)),
    `absent: ${FAKE_REAL_STORE}`);
  ok('precondition: `projects` IS a symlink and its target IS realClaudeStoreDir (dangling)',
    fs.lstatSync(link).isSymbolicLink()
      && path.resolve(linkTarget(link)) === path.resolve(realClaudeStoreDir(env))
      && !fs.existsSync(link),
    `${link} -> ${linkTarget(link)} (dangling: ${!fs.existsSync(link)})`);
  ok('precondition: realpathSync.native THROWS ENOENT on the dangling leaf (why round 1 fell back)',
    (() => { try { fs.realpathSync.native(link); return false; } catch (e) { return e.code === 'ENOENT'; } })(),
    'ENOENT on the link leaf');

  // must-FAIL: round 1's canonicaliser re-appends the leaf lexically and calls it isolated.
  const r1Store = round1CanonicalNearest(claudeStoreDir(env));
  const r1Real = round1CanonicalNearest(realClaudeStoreDir(env));
  const r1Isolated = round1ConsideredIsolated(env);
  ok('CONTROL (round-1 canonicalNearest): dangling store is (wrongly) ISOLATED — guard would NOT throw',
    r1Isolated === true, `round1(store)=${r1Store} round1(real)=${r1Real} -> isolated=${r1Isolated}`);

  // must-PASS: the shipped guard reads the dangling link's TARGET and refuses.
  const msg = throws(() => assertSessionStoreIsolated(env, { label: 'dangling-account' }));
  ok('POST: shipped guard THROWS on the DANGLING symlink onto the real store',
    !!msg && /REFUSING/.test(msg), msg ? msg.slice(0, 110) : 'NO THROW (guard disarmed)');
  rmRealStore();
}

/* ─────────────────── 6. dangling link whose target's PARENT is also missing */
section("6. dangling link whose target's PARENT also does not exist");
{
  rmRealStore();
  const acctDir = path.join(SCRATCH, 'accounts', 'dangling-deep');
  fs.mkdirSync(acctDir, { recursive: true });
  const link = path.join(acctDir, 'projects');
  fs.symlinkSync(FAKE_REAL_STORE, link);
  const env = { CLAUDE_STATION_DATA: DATA, CLAUDE_CONFIG_DIR: acctDir };

  ok("precondition: neither the real store NOR its parent (~/.claude) exists",
    !fs.existsSync(FAKE_REAL_STORE) && !fs.existsSync(path.join(SCRATCH, 'home', '.claude')),
    `absent: ${path.join(SCRATCH, 'home', '.claude')} and ${FAKE_REAL_STORE}`);
  ok('CONTROL (round-1): still (wrongly) ISOLATED',
    round1ConsideredIsolated(env) === true, `round1(store)=${round1CanonicalNearest(claudeStoreDir(env))}`);

  const msg = throws(() => assertSessionStoreIsolated(env, { label: 'dangling-deep' }));
  ok('shipped guard THROWS (two-level-absent target is still the real store)',
    !!msg && /REFUSING/.test(msg), msg ? msg.slice(0, 110) : 'NO THROW (guard disarmed)');
}

/* ─────────────────── 7. symlink CHAIN, dangling at the second hop */
section('7. symlink chain projects -> hopB -> <real store>, dangling at the SECOND hop');
{
  rmRealStore();
  const acctDir = path.join(SCRATCH, 'accounts', 'chain');
  fs.mkdirSync(acctDir, { recursive: true });
  const hopB = path.join(acctDir, 'hop-b');
  const link = path.join(acctDir, 'projects');
  fs.symlinkSync(FAKE_REAL_STORE, hopB);   // hop 2 -> real store (absent)
  fs.symlinkSync(hopB, link);              // hop 1 -> hop 2 (exists, as a link)
  const env = { CLAUDE_STATION_DATA: DATA, CLAUDE_CONFIG_DIR: acctDir };

  ok('precondition: two-hop chain, first hop exists as a LINK, final target absent',
    fs.lstatSync(link).isSymbolicLink() && linkTarget(link) === hopB
      && fs.lstatSync(hopB).isSymbolicLink() && linkTarget(hopB) === FAKE_REAL_STORE
      && !fs.existsSync(FAKE_REAL_STORE),
    `${link} -> ${linkTarget(link)} -> ${linkTarget(hopB)} (absent)`);
  ok('CONTROL (round-1): chain dangling at hop 2 is (wrongly) ISOLATED',
    round1ConsideredIsolated(env) === true, `round1(store)=${round1CanonicalNearest(claudeStoreDir(env))}`);

  const msg = throws(() => assertSessionStoreIsolated(env, { label: 'chain-account' }));
  ok('shipped guard follows the whole chain and THROWS',
    !!msg && /REFUSING/.test(msg), msg ? msg.slice(0, 110) : 'NO THROW (guard disarmed)');
}

/* ─────────────────── 8. RELATIVE symlink target */
section('8. RELATIVE symlink target — resolved against the link\'s own directory');
{
  rmRealStore();
  const acctDir = path.join(SCRATCH, 'accounts', 'relative');
  fs.mkdirSync(acctDir, { recursive: true });
  const link = path.join(acctDir, 'projects');
  // acctDir is <SCRATCH>/accounts/relative, the real store <SCRATCH>/home/.claude/projects.
  const rel = path.relative(acctDir, FAKE_REAL_STORE); // e.g. ../../home/.claude/projects
  fs.symlinkSync(rel, link);
  const env = { CLAUDE_STATION_DATA: DATA, CLAUDE_CONFIG_DIR: acctDir };

  ok('precondition: the stored target is RELATIVE (not absolute) and points at the real store',
    !path.isAbsolute(rel) && path.resolve(acctDir, rel) === path.resolve(FAKE_REAL_STORE),
    `${link} -> ${rel}`);

  // (a) dangling + relative
  ok('precondition (a): real store absent', !fs.existsSync(FAKE_REAL_STORE), FAKE_REAL_STORE);
  ok('CONTROL (round-1): dangling RELATIVE link is (wrongly) ISOLATED',
    round1ConsideredIsolated(env) === true, `round1(store)=${round1CanonicalNearest(claudeStoreDir(env))}`);
  const msgDangling = throws(() => assertSessionStoreIsolated(env, { label: 'relative-dangling' }));
  ok('shipped guard resolves the RELATIVE dangling target and THROWS',
    !!msgDangling && /REFUSING/.test(msgDangling), msgDangling ? msgDangling.slice(0, 110) : 'NO THROW (guard disarmed)');

  // (b) same link once the target exists — must still throw (no behaviour flip)
  mkRealStore();
  ok('precondition (b): real store now exists and the link resolves onto it',
    fs.realpathSync.native(link) === fs.realpathSync.native(FAKE_REAL_STORE),
    `${link} => ${fs.realpathSync.native(link)}`);
  const msgLive = throws(() => assertSessionStoreIsolated(env, { label: 'relative-live' }));
  ok('same RELATIVE link with the target present also THROWS (decision is hop-state-independent)',
    !!msgLive && /REFUSING/.test(msgLive), msgLive ? msgLive.slice(0, 110) : 'NO THROW');
  rmRealStore();
}

/* ─────────────────── 9. symlink CYCLE — terminates, arms the guard */
section('9. symlink CYCLE — must terminate (no hang, no stack overflow) and ARM the guard');
{
  mkRealStore(); // irrelevant to the cycle; keeps the real-store side resolvable
  const acctDir = path.join(SCRATCH, 'accounts', 'cycle');
  fs.mkdirSync(acctDir, { recursive: true });
  const a = path.join(acctDir, 'projects');
  const b = path.join(acctDir, 'loop-b');
  fs.symlinkSync(b, a);
  fs.symlinkSync(a, b);
  const env = { CLAUDE_STATION_DATA: DATA, CLAUDE_CONFIG_DIR: acctDir };

  ok('precondition: projects -> loop-b -> projects is a genuine cycle',
    linkTarget(a) === b && linkTarget(b) === a, `${a} -> ${b} -> ${linkTarget(b)}`);
  ok('precondition: the kernel itself answers ELOOP here',
    (() => { try { fs.realpathSync.native(a); return false; } catch (e) { return e.code === 'ELOOP'; } })(),
    'realpathSync => ELOOP');

  const t0 = Date.now();
  let crashed = null, msg = null;
  try { assertSessionStoreIsolated(env, { label: 'cycle-account' }); }
  catch (e) { msg = e.message; if (e instanceof RangeError) crashed = 'RangeError (stack overflow)'; }
  const ms = Date.now() - t0;
  ok('the cycle TERMINATES quickly (no hang, no stack overflow)',
    crashed === null && ms < 5000, `${ms}ms, crashed=${crashed ?? 'no'}`);
  ok('a cycle ARMS the guard (unresolvable => refuse, never "isolated")',
    !!msg && /REFUSING/.test(msg) && /could not be canonicalised/.test(msg),
    msg ? msg.slice(0, 140) : 'NO THROW (guard disarmed)');
  // Round 1 returned path.resolve(p) on the non-ENOENT (ELOOP) error => "isolated".
  ok('CONTROL (round-1): the cycle was (wrongly) treated as ISOLATED',
    round1ConsideredIsolated(env) === true, `round1(store)=${round1CanonicalNearest(claudeStoreDir(env))}`);
}

/* ─────────────────── 10. TOCTOU — target created AFTER the guard ran */
section('10. TOCTOU — the decision taken while the target was absent must already be the safe one');
{
  rmRealStore();
  const acctDir = path.join(SCRATCH, 'accounts', 'toctou');
  fs.mkdirSync(acctDir, { recursive: true });
  const link = path.join(acctDir, 'projects');
  fs.symlinkSync(FAKE_REAL_STORE, link);
  const env = { CLAUDE_STATION_DATA: DATA, CLAUDE_CONFIG_DIR: acctDir };

  ok('precondition: at guard time the real store does NOT exist', !fs.existsSync(FAKE_REAL_STORE), FAKE_REAL_STORE);
  const decisionAtGuardTime = throws(() => assertSessionStoreIsolated(env, { label: 'toctou' }));
  // Only NOW does the CLI (or anything else) materialise the target.
  mkRealStore();
  ok('precondition: the target was created only AFTER the guard returned',
    fs.existsSync(FAKE_REAL_STORE) && fs.realpathSync.native(link) === fs.realpathSync.native(FAKE_REAL_STORE),
    `${link} => ${fs.realpathSync.native(link)}`);
  ok('the decision ALREADY taken (while absent) was to REFUSE — the window is closed',
    !!decisionAtGuardTime && /REFUSING/.test(decisionAtGuardTime),
    decisionAtGuardTime ? decisionAtGuardTime.slice(0, 110) : 'NO THROW at guard time (window open)');
  rmRealStore();
}

/* ─────────────────── 11. INVERSE — no spurious throws (multi-account must still work) */
section('11. INVERSE: genuinely separate stores still return SILENTLY (no spurious throw)');
{
  mkRealStore();
  const cases = [];

  // (a) a plain, separate, existing store
  const plain = path.join(SCRATCH, 'accounts', 'sep-plain');
  fs.mkdirSync(path.join(plain, 'projects'), { recursive: true });
  cases.push(['separate real directory', plain]);

  // (b) a symlink onto a genuinely separate store (must NOT collapse onto the real store)
  const symOwner = path.join(SCRATCH, 'accounts', 'sep-sym');
  const symTarget = path.join(SCRATCH, 'elsewhere', 'store-b');
  fs.mkdirSync(symOwner, { recursive: true });
  fs.mkdirSync(symTarget, { recursive: true });
  fs.symlinkSync(symTarget, path.join(symOwner, 'projects'));
  cases.push(['symlink onto a SEPARATE store', symOwner]);

  // (c) a DANGLING symlink onto a genuinely separate (absent) store
  const dangOwner = path.join(SCRATCH, 'accounts', 'sep-dangling');
  const dangTarget = path.join(SCRATCH, 'elsewhere', 'store-c-absent');
  fs.mkdirSync(dangOwner, { recursive: true });
  fs.symlinkSync(dangTarget, path.join(dangOwner, 'projects'));
  cases.push(['DANGLING symlink onto a SEPARATE store', dangOwner]);

  // (d) a not-yet-created account dir under a symlinked parent
  const parentReal = path.join(SCRATCH, 'elsewhere', 'accounts-real');
  const parentLink = path.join(SCRATCH, 'accounts-link');
  fs.mkdirSync(parentReal, { recursive: true });
  if (!fs.existsSync(parentLink)) fs.symlinkSync(parentReal, parentLink);
  cases.push(['unmaterialised dir under a SYMLINKED parent', path.join(parentLink, 'not-yet')]);

  // (e) a RELATIVE symlink onto a separate store
  const relOwner = path.join(SCRATCH, 'accounts', 'sep-rel');
  fs.mkdirSync(relOwner, { recursive: true });
  fs.symlinkSync(path.relative(relOwner, symTarget), path.join(relOwner, 'projects'));
  cases.push(['RELATIVE symlink onto a SEPARATE store', relOwner]);

  ok('precondition: the real store exists, so a wrong collapse onto it WOULD be detected',
    fs.existsSync(FAKE_REAL_STORE), FAKE_REAL_STORE);
  ok('precondition: this process IS the sanctioned marker but data dir is ISOLATED (so a real-store verdict WOULD throw)',
    isSanctionedRealStoreWriter() === true, 'sanctioned=true, CLAUDE_STATION_DATA set per-case');

  for (const [name, cfgDir] of cases) {
    const env = { CLAUDE_STATION_DATA: DATA, CLAUDE_CONFIG_DIR: cfgDir };
    const msg = throws(() => assertSessionStoreIsolated(env, { label: `inverse-${name}` }));
    ok(`no spurious throw: ${name}`, msg === null, msg ? msg.slice(0, 110) : `no throw (correct) — store=${claudeStoreDir(env)}`);
  }
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
