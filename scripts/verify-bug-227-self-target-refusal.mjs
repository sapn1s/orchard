#!/usr/bin/env node
/**
 * verify-bug-227-self-target-refusal.mjs — proves BUG-227's self-target guard.
 *
 * The 2026-09-30 incident: a suite sweep ran onboard against the LIVE checkout
 * (an empty/cwd-defaulted target, or a ROOT/repoRoot mix-up). It created
 * `.orchard/` in the repo root, repointed 5 package.json script VALUES
 * (gate, check:nul, board:check, board:gen, arch:watch) and the
 * `.claude/settings.json` Stop-hook command. onboard.mjs had NO guard that
 * refuses its own source repo.
 *
 * This test reproduces the incident ENTIRELY IN SCRATCH — never against the real
 * repo — by building a reflink copy of the repo's source tree into a scratch dir
 * and running onboard FROM that copy POINTED AT ITSELF (target === that copy's
 * own repoRoot === the self-target condition). It then proves:
 *
 *   (M) MUST-FAIL baseline: a SYNTHESIZED PRE-FIX onboard (today's onboard with
 *       the `BUG-227-GUARD-START..END` block stripped — synthesized by text, NOT
 *       anchored to any git SHA) reproduces the incident: it WRITES `.orchard/`,
 *       repoints the 5 package.json scripts and rewrites the Stop hook when run
 *       against its own repo. This proves the test is non-vacuous and the bug is
 *       real without the guard.
 *   (G) The FIXED onboard refuses the same self-target: exits nonzero, names the
 *       path, and leaves package.json + .claude/settings.json BYTE-IDENTICAL with
 *       NO `.orchard/` created.
 *   (U) onboard.selfTargetReason() identifies the repo root and returns null for
 *       an unrelated scratch dir.
 *   (R) Anti-regression: the real onboard STILL onboards a legitimate (non-self)
 *       scratch target normally — the guard does not over-refuse.
 *   (E) The --allow-self-target escape hatch lets an explicit caller through.
 *   (B1/B2) r3 regression cases: string-override bypass, bind-mount alias.
 *   (H) r4 regression case: a DISTINCT directory whose scripts/onboard.mjs is a
 *       hardlink of the running file (a `cp -al` copy) is FALSELY refused by the
 *       r3 two-signal guard (must-FAIL, r3 synthesized) and correctly ACCEPTED by
 *       the r4 directory-identity-only guard.
 *
 * Run: node scripts/verify-bug-227-self-target-refusal.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdtempScratch } from './lib/scratch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const realOnboard = path.join(repoRoot, 'scripts', 'onboard.mjs');

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { console.log(`PASS: ${label}`); pass++; }
  else { console.log(`FAIL: ${label}${detail ? ` — ${detail}` : ''}`); fail++; }
}

const cleanups = [];
function scratchDir(prefix) {
  const d = mkdtempScratch(prefix);
  cleanups.push(d);
  return d;
}

/**
 * Build a reflink copy of the repo's source tree into a fresh scratch dir that
 * FUNCTIONS as its own Orchard checkout: onboard run from `<copy>/scripts/` has
 * repoRoot === `<copy>`, so pointing it at `<copy>` is the self-target case.
 * Copies only what onboard reads as a source (scripts/, public/, the board
 * templates) plus a real package.json + .claude/settings.json so the
 * "byte-identical after refusal" / "repointed by pre-fix" assertions are
 * meaningful against real content.
 */
function makeOwnRepoCopy(prefix) {
  const dst = scratchDir(prefix);
  const cp = (rel) => {
    const src = path.join(repoRoot, rel);
    const dest = path.join(dst, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // reflink where possible (btrfs/xfs); cp -a falls back to a real copy.
    execFileSync('cp', ['-a', '--reflink=auto', src, dest]);
  };
  cp('scripts');        // onboard.mjs + board.mjs + lib/ + hooks/ + gate/check-nul/...
  cp('public');         // public/lib/*.js (hook deps copied into targets)
  cp('package.json');   // the 5 repointable script VALUES
  cp('.claude');        // settings.json Stop hook
  // onboard reads docs/bugs/TEMPLATE-ARCH.md for the arch template scaffold.
  const archTpl = path.join(repoRoot, 'docs', 'bugs', 'TEMPLATE-ARCH.md');
  if (fs.existsSync(archTpl)) {
    fs.mkdirSync(path.join(dst, 'docs', 'bugs'), { recursive: true });
    fs.copyFileSync(archTpl, path.join(dst, 'docs', 'bugs', 'TEMPLATE-ARCH.md'));
  }
  return dst;
}

/** Synthesize the PRE-FIX onboard: strip the guard block by its markers. */
function writePrefixOnboard(copyRoot) {
  const onboardPath = path.join(copyRoot, 'scripts', 'onboard.mjs');
  const text = fs.readFileSync(onboardPath, 'utf8');
  const stripped = text.replace(
    /\n[ \t]*\/\/ BUG-227-GUARD-START[\s\S]*?\/\/ BUG-227-GUARD-END\n/,
    '\n'
  );
  if (stripped === text) {
    throw new Error('could not strip BUG-227 guard markers — markers missing from onboard.mjs');
  }
  const prefixPath = path.join(copyRoot, 'scripts', 'onboard-prefix.mjs');
  fs.writeFileSync(prefixPath, stripped);
  return prefixPath;
}

/**
 * Synthesize the R2 guard IN PLACE (over the copy's own scripts/onboard.mjs), by
 * reverting the two r3 changes textually (NOT anchored to any git SHA):
 *   (1) the strict override `if (allowSelfTarget !== true)` back to the r2
 *       truthiness test `if (!allowSelfTarget)` — reintroduces B1;
 *   (2) the inode-identity `selfTargetReason` body back to the r2 realpath-string
 *       comparison — reintroduces B2 (realpath does not collapse a bind mount).
 * Each replacement self-checks (throws if its anchor is missing) so the test can
 * never silently go vacuous. Leaves repoRoot = copyRoot (runs AS its own checkout).
 */
const R2_REASON_BODY = `
  const canon = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const targetReal = canon(resolved);
  const repoReal = canon(repoRoot);
  if (targetReal === repoReal) {
    return \`target realpath (\${targetReal}) is this tool's own source repo root (\${repoReal})\`;
  }
  try {
    const thisFile = fs.realpathSync(url.fileURLToPath(import.meta.url));
    const targetOnboard = fs.realpathSync(path.join(resolved, 'scripts', 'onboard.mjs'));
    if (targetOnboard === thisFile) {
      return \`target's scripts/onboard.mjs (\${targetOnboard}) is this very running file\`;
    }
  } catch { /* no scripts/onboard.mjs in target */ }
  return null;
`;
function writeR2Guard(copyRoot) {
  const onboardPath = path.join(copyRoot, 'scripts', 'onboard.mjs');
  let text = fs.readFileSync(onboardPath, 'utf8');
  // (1) revert strict override
  const afterOverride = text.replace('if (allowSelfTarget !== true) {', 'if (!allowSelfTarget) {');
  if (afterOverride === text) throw new Error('writeR2Guard: strict-override anchor missing from onboard.mjs');
  text = afterOverride;
  // (2) revert selfTargetReason body
  const afterBody = text.replace(
    /\/\/ BUG-227-SELFTARGET-REASON-START[\s\S]*?\/\/ BUG-227-SELFTARGET-REASON-END/,
    `// BUG-227-SELFTARGET-REASON-START (r2 synthesized)${R2_REASON_BODY}  // BUG-227-SELFTARGET-REASON-END`
  );
  if (afterBody === text) throw new Error('writeR2Guard: selfTargetReason marker region missing from onboard.mjs');
  fs.writeFileSync(onboardPath, afterBody);
}

/**
 * Synthesize the R3 guard IN PLACE (over the copy's own scripts/onboard.mjs), by
 * RE-ADDING the second file-identity signal that r4 removed — the one whose only
 * effect was a FALSE refusal of a DISTINCT directory that merely shares the
 * running onboard.mjs inode (openai run 01a126ef). Inserted right before the
 * `return null;` inside the SELFTARGET-REASON markers, textually (NOT a SHA).
 * Self-checks (throws if the anchor is missing) so the test can never go vacuous.
 */
const R3_SIGNAL2 = `  const thisFileIdent = ident(url.fileURLToPath(import.meta.url));
  const targetOnboardIdent = ident(path.join(resolved, 'scripts', 'onboard.mjs'));
  if (thisFileIdent && targetOnboardIdent && thisFileIdent === targetOnboardIdent) {
    return \`target's scripts/onboard.mjs (in \${resolved}) is this very running file (inode \${thisFileIdent})\`;
  }
`;
function writeR3Onboard(copyRoot) {
  const onboardPath = path.join(copyRoot, 'scripts', 'onboard.mjs');
  const text = fs.readFileSync(onboardPath, 'utf8');
  const anchor = /(\n[ \t]*return null;\n[ \t]*\/\/ BUG-227-SELFTARGET-REASON-END)/;
  if (!anchor.test(text)) throw new Error('writeR3Onboard: reason-end anchor missing from onboard.mjs');
  const r3 = text.replace(anchor, `\n${R3_SIGNAL2}$1`);
  if (r3 === text) throw new Error('writeR3Onboard: no change — synthesis vacuous');
  fs.writeFileSync(onboardPath, r3);
  return onboardPath;
}

/**
 * Turn `<dir>/scripts/onboard.mjs` into a HARDLINK of `linkTo`, leaving the rest
 * of `<dir>` an independent reflink copy (distinct inodes). This isolates the r3
 * signal-2 trigger — the target DIRECTORY is distinct, only its onboard.mjs
 * shares the running file's inode, exactly a `cp -al`-style copy. Same-filesystem
 * (scratch lives under $HOME, as does the repo), so link(2) succeeds.
 */
function hardlinkOnboardTo(dir, linkTo) {
  const p = path.join(dir, 'scripts', 'onboard.mjs');
  fs.rmSync(p);
  fs.linkSync(linkTo, p); // hardlink: p and linkTo now share one inode
  const a = fs.statSync(p), b = fs.statSync(linkTo);
  if (a.ino !== b.ino) throw new Error('hardlinkOnboardTo: link did not share an inode (cross-device?)');
}

/**
 * BUG-227 r5 — a WHOLE-TREE hardlink copy of `srcDir` (the `cp -al` the r5 break
 * used, adv 83ee76ee53ae): every REGULAR FILE in the copy shares its inode with
 * the corresponding file in `srcDir`, while directories are freshly recreated
 * (so the copy's ROOT is a DISTINCT directory — the guard correctly accepts it).
 * An in-place `writeFileSync` into the copy therefore truncates the SHARED inode
 * and corrupts `srcDir`. Same filesystem (both under scratch) so `cp -al` works.
 */
function hardlinkTreeCopy(srcDir, prefix) {
  const dst = scratchDir(prefix);
  execFileSync('cp', ['-al', `${srcDir}/.`, dst]); // copy CONTENTS into dst (dirs recreated, files hardlinked)
  return dst;
}

/**
 * Synthesize the PRE-r5 onboard IN PLACE (over `copyRoot`'s own
 * scripts/onboard.mjs): replace the atomic-write chokepoint body with a naive
 * in-place `fs.writeFileSync(file, data)` — the exact pre-fix write that writes
 * THROUGH a shared inode / follows a symlink. Textual (NOT a git SHA);
 * self-checks so it can never go vacuous.
 */
const PREFIX_NAIVE_WRITE = `
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, data); // PRE-r5 synthesis: in-place write-through (no temp+rename)
`;
function writePrefixAtomicWrite(copyRoot) {
  const onboardPath = path.join(copyRoot, 'scripts', 'onboard.mjs');
  const text = fs.readFileSync(onboardPath, 'utf8');
  const naive = text.replace(
    /\/\/ BUG-227-ATOMIC-WRITE-START[\s\S]*?\/\/ BUG-227-ATOMIC-WRITE-END/,
    `// BUG-227-ATOMIC-WRITE-START (pre-r5 synthesized)${PREFIX_NAIVE_WRITE}  // BUG-227-ATOMIC-WRITE-END`
  );
  if (naive === text) throw new Error('writePrefixAtomicWrite: ATOMIC-WRITE markers missing from onboard.mjs');
  fs.writeFileSync(onboardPath, naive);
  return onboardPath;
}

/** Is an unprivileged user+mount namespace with bind mounts available here? */
function bindMountAvailable() {
  try {
    execFileSync('unshare', ['-rm', 'true'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

/**
 * Run `node <onboardAbs> <aliasPath> --no-board` with <aliasPath> bind-mounted to
 * <boundTo>, inside a throwaway unprivileged user+mount namespace (the mount is
 * private and vanishes with the namespace; it never touches the real system).
 * Returns { code, out } of the onboard run. All paths are scratch.
 */
function onboardThroughBind(onboardAbs, aliasPath, boundTo, cwd) {
  const script =
    `mount --bind ${boundTo} ${aliasPath} || { echo "BIND_FAILED"; echo "ONBOARD_EXIT=250"; exit 0; }; ` +
    `node ${onboardAbs} ${aliasPath} --no-board 2>&1; code=$?; echo "ONBOARD_EXIT=$code"`;
  try {
    const out = execFileSync('unshare', ['-rm', 'bash', '-c', script], { encoding: 'utf8', cwd });
    const m = out.match(/ONBOARD_EXIT=(\d+)/);
    return { code: m ? Number(m[1]) : 0, out };
  } catch (e) {
    const out = (e.stdout ?? '') + (e.stderr ?? '');
    const m = out.match(/ONBOARD_EXIT=(\d+)/);
    return { code: m ? Number(m[1]) : (e.status ?? 1), out };
  }
}

function runNode(script, args, cwd) {
  try {
    const out = execFileSync('node', [script, ...args], { encoding: 'utf8', cwd });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

function sha(p) {
  return fs.existsSync(p) ? fs.readFileSync(p) : null;
}
function stopHookOf(settingsPath) {
  try {
    const j = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return JSON.stringify(j?.hooks?.Stop ?? null);
  } catch { return null; }
}

try {
  // ---------------------------------------------------------------
  // (U) Unit: selfTargetReason identifies the repo, null for a stranger.
  // ---------------------------------------------------------------
  const mod = await import(realOnboard);
  check('(U1) selfTargetReason(repoRoot) is non-null (names the repo)',
    typeof mod.selfTargetReason(repoRoot) === 'string' && mod.selfTargetReason(repoRoot).includes(repoRoot),
    JSON.stringify(mod.selfTargetReason(repoRoot)));
  const stranger = scratchDir('bug227-stranger-');
  check('(U2) selfTargetReason(unrelated scratch dir) is null',
    mod.selfTargetReason(stranger) === null,
    JSON.stringify(mod.selfTargetReason(stranger)));

  // ---------------------------------------------------------------
  // (M) MUST-FAIL baseline: the SYNTHESIZED PRE-FIX onboard onboards its own
  // repo (reproduces the exact incident) — proves the bug without the guard.
  // ---------------------------------------------------------------
  {
    const copy = makeOwnRepoCopy('bug227-prefix-');
    const prefix = writePrefixOnboard(copy);
    const pkgBefore = sha(path.join(copy, 'package.json'));
    const hookBefore = stopHookOf(path.join(copy, '.claude', 'settings.json'));
    const res = runNode(prefix, [copy], copy); // target === copy === its own repoRoot
    const orchardMade = fs.existsSync(path.join(copy, '.orchard'));
    const pkgAfter = sha(path.join(copy, 'package.json'));
    const hookAfter = stopHookOf(path.join(copy, '.claude', 'settings.json'));
    const pkgRepointed = pkgBefore && pkgAfter && !pkgBefore.equals(pkgAfter) &&
      pkgAfter.toString().includes('.orchard/');
    check('(M1) PRE-FIX onboard exits 0 on its own repo (no guard to stop it)', res.code === 0, `code=${res.code} ${res.out.slice(-200)}`);
    check('(M2) PRE-FIX onboard CREATED .orchard/ in its own repo root', orchardMade);
    check('(M3) PRE-FIX onboard REPOINTED package.json scripts at .orchard/', !!pkgRepointed,
      pkgBefore && pkgAfter ? `changed=${!pkgBefore.equals(pkgAfter)}` : 'pkg missing');
    check('(M4) PRE-FIX onboard changed the .claude/settings.json Stop hook', hookBefore !== null && hookBefore !== hookAfter,
      `before=${(hookBefore||'').slice(0,40)} after=${(hookAfter||'').slice(0,40)}`);
  }

  // ---------------------------------------------------------------
  // (G) The FIXED onboard refuses the identical self-target and writes nothing.
  // ---------------------------------------------------------------
  {
    const copy = makeOwnRepoCopy('bug227-fixed-');
    const pkgBefore = sha(path.join(copy, 'package.json'));
    const settingsBefore = sha(path.join(copy, '.claude', 'settings.json'));
    const res = runNode(path.join(copy, 'scripts', 'onboard.mjs'), [copy], copy); // self-target
    const pkgAfter = sha(path.join(copy, 'package.json'));
    const settingsAfter = sha(path.join(copy, '.claude', 'settings.json'));
    check('(G1) FIXED onboard exits NONZERO on its own repo', res.code !== 0, `code=${res.code}`);
    check('(G2) FIXED refusal names the self-target / mentions refusing', /refus/i.test(res.out) && res.out.includes(copy), res.out.slice(-240));
    check('(G3) FIXED created NO .orchard/ in the repo root', !fs.existsSync(path.join(copy, '.orchard')));
    check('(G4) FIXED left package.json BYTE-IDENTICAL', pkgBefore && pkgAfter && pkgBefore.equals(pkgAfter));
    check('(G5) FIXED left .claude/settings.json BYTE-IDENTICAL', !!settingsBefore && !!settingsAfter && settingsBefore.equals(settingsAfter));
    // Also exercise the imported-function path (how src/server + suites call it)
    // against the REAL repo root — safe, because the guard throws BEFORE any
    // write (proven by G3-G5 and the CLI run above). git status is unchanged.
    let threw = false, msg = '';
    try { mod.onboard(repoRoot); } catch (e) { threw = true; msg = e.message; }
    check('(G6) onboard(repoRoot) as an imported function THROWS on self-target', threw && /refus/i.test(msg), msg.slice(0, 160));
  }

  // ---------------------------------------------------------------
  // (R) Anti-regression: the guard does NOT over-refuse a legitimate target.
  // ---------------------------------------------------------------
  {
    const legit = scratchDir('bug227-legit-');
    fs.writeFileSync(path.join(legit, 'package.json'), JSON.stringify({ name: 'legit', scripts: {} }, null, 2) + '\n');
    const res = runNode(realOnboard, [legit, '--no-board'], repoRoot);
    check('(R1) real onboard STILL onboards a legitimate scratch target (exit 0)', res.code === 0, res.out.slice(-240));
    check('(R2) legitimate target got its .orchard/ (normal onboarding works)', fs.existsSync(path.join(legit, '.orchard')));
  }

  // ---------------------------------------------------------------
  // (E) --allow-self-target escape hatch lets an explicit caller through.
  // ---------------------------------------------------------------
  {
    const copy = makeOwnRepoCopy('bug227-hatch-');
    const res = runNode(path.join(copy, 'scripts', 'onboard.mjs'), [copy, '--allow-self-target'], copy);
    check('(E1) --allow-self-target overrides the guard (exit 0)', res.code === 0, `code=${res.code} ${res.out.slice(-160)}`);
    check('(E2) with the hatch, .orchard/ IS written (proves the hatch is real, not ignored)', fs.existsSync(path.join(copy, '.orchard')));
  }

  // ---------------------------------------------------------------
  // (B1) Override truthiness bypass. The r2 guard used `if (!allowSelfTarget)`,
  // so a programmatic caller passing the STRING 'false' (truthy) negated to
  // false and SKIPPED the guard. r3 uses `allowSelfTarget !== true`.
  // Must-FAIL baseline uses an r2-SYNTHESIZED onboard (text-reverted, not a SHA).
  // ---------------------------------------------------------------
  {
    // (B1-M) r2: onboard(copy, {allowSelfTarget:'false'}) WRITES its own repo.
    const copyR2 = makeOwnRepoCopy('bug227-b1-r2-');
    writeR2Guard(copyR2);
    const r2mod = await import(pathToFileURL(path.join(copyR2, 'scripts', 'onboard.mjs')).href + `?t=${Date.now()}`);
    let r2Wrote = false, r2Err = '';
    try { r2mod.onboard(copyR2, { noBoard: true, allowSelfTarget: 'false' }); r2Wrote = true; }
    catch (e) { r2Err = e.message; }
    check('(B1-M) r2 guard: {allowSelfTarget:"false"} BYPASSES the guard and onboards its own repo',
      r2Wrote && fs.existsSync(path.join(copyR2, '.orchard')), r2Err || 'did not write .orchard');

    // (B1-G) r3: the same string override is REFUSED (strict === true), no write.
    const hadOrchard = fs.existsSync(path.join(repoRoot, '.orchard'));
    let r3Threw = false, r3Msg = '';
    try { mod.onboard(repoRoot, { noBoard: true, allowSelfTarget: 'false' }); }
    catch (e) { r3Threw = true; r3Msg = e.message; }
    check('(B1-G) r3 guard: {allowSelfTarget:"false"} is REFUSED (throws, strict boolean)', r3Threw && /refus/i.test(r3Msg), r3Msg.slice(0, 160));
    check('(B1-G2) r3 wrote NOTHING to the real repo (no new .orchard/)', fs.existsSync(path.join(repoRoot, '.orchard')) === hadOrchard);
  }

  // ---------------------------------------------------------------
  // (B2) Bind-mount alias bypass. The r2 guard compared realpath STRINGS; a
  // bind-mounted alias has a different realpath but the SAME directory inode, so
  // r2 missed it. r3 compares (st_dev, st_ino), which collapses the alias.
  // Tested unprivileged via `unshare -rm` + `mount --bind`, entirely in scratch.
  // ---------------------------------------------------------------
  if (!bindMountAvailable()) {
    check('(B2) SKIPPED — unprivileged bind mounts unavailable in this environment', true,
      'unshare -rm failed; B2 cannot run here (noted, not a pass of the mechanism)');
  } else {
    // (B2-M) r2: alias (bind of its own repo) is onboarded — realpath differs.
    const copyR2 = makeOwnRepoCopy('bug227-b2-r2-');
    writeR2Guard(copyR2);
    const aliasR2 = scratchDir('bug227-b2-alias-r2-');
    const resR2 = onboardThroughBind(path.join(copyR2, 'scripts', 'onboard.mjs'), aliasR2, copyR2, copyR2);
    check('(B2-M) r2 guard: bind-mount alias BYPASSES the guard (onboard exits 0)', resR2.code === 0, resR2.out.slice(-200));
    check('(B2-M2) r2 guard: the bound source repo WAS onboarded (.orchard/ created via the alias)',
      fs.existsSync(path.join(copyR2, '.orchard')), 'no .orchard in bound repo');

    // (B2-G) r3: the same bind-mount alias is REFUSED (inode identity), no write.
    const copyR3 = makeOwnRepoCopy('bug227-b2-r3-');
    const aliasR3 = scratchDir('bug227-b2-alias-r3-');
    const resR3 = onboardThroughBind(path.join(copyR3, 'scripts', 'onboard.mjs'), aliasR3, copyR3, copyR3);
    check('(B2-G) r3 guard: bind-mount alias is REFUSED (onboard exits nonzero)', resR3.code !== 0, `code=${resR3.code} ${resR3.out.slice(-200)}`);
    check('(B2-G2) r3 guard: the bound source repo was NOT onboarded (no .orchard/)',
      !fs.existsSync(path.join(copyR3, '.orchard')));
    check('(B2-G3) r3 refusal names a same-inode self-target', /refus/i.test(resR3.out) && /inode/i.test(resR3.out), resR3.out.slice(-240));
  }

  // ---------------------------------------------------------------
  // (H) Hardlink false-refusal. The r3 guard carried a SECOND identity signal:
  // target/scripts/onboard.mjs inode === the running file's inode. That signal
  // FALSELY REFUSED a DISTINCT directory whose onboard.mjs is a hardlink of the
  // running file (a `cp -al` copy) — the dir is NOT the source repo, so onboard
  // should scaffold it normally. r4 removed the signal: directory identity
  // (st_dev,st_ino) alone IS the contract. Must-FAIL baseline uses an
  // r3-SYNTHESIZED onboard (text re-adds signal 2, NOT a SHA).
  // ---------------------------------------------------------------
  {
    // (H-M) r3: a distinct dir whose onboard.mjs hardlinks the RUNNING r3 file
    // is FALSELY REFUSED — onboard exits nonzero and writes no .orchard/, even
    // though the dir is a different directory (different root inode).
    const runnerR3 = makeOwnRepoCopy('bug227-h-r3-runner-');
    const r3Onboard = writeR3Onboard(runnerR3); // this is the file we execute
    const targetR3 = makeOwnRepoCopy('bug227-h-r3-target-'); // DISTINCT dir
    hardlinkOnboardTo(targetR3, r3Onboard);      // only onboard.mjs is shared
    const distinctDirR3 = fs.statSync(targetR3).ino !== fs.statSync(runnerR3).ino;
    const resHM = runNode(r3Onboard, [targetR3, '--no-board'], runnerR3);
    check('(H-M0) target is a DISTINCT directory from the runner (different root inode)', distinctDirR3);
    check('(H-M1) r3 guard FALSELY REFUSES the distinct hardlink-onboard.mjs copy (exits nonzero)',
      resHM.code !== 0, `code=${resHM.code} ${resHM.out.slice(-200)}`);
    check('(H-M2) r3 refusal fired on the FILE signal (names "running file"), not the directory',
      /this very running file/.test(resHM.out), resHM.out.slice(-240));
    check('(H-M3) r3 wrote NO .orchard/ into the wrongly-refused distinct dir', !fs.existsSync(path.join(targetR3, '.orchard')));

    // (H-G) r4: the SAME distinct hardlink-onboard.mjs copy is ACCEPTED and
    // onboarded normally — proving directory identity does not over-refuse it.
    const targetR4 = makeOwnRepoCopy('bug227-h-r4-target-'); // DISTINCT dir
    hardlinkOnboardTo(targetR4, realOnboard);    // onboard.mjs hardlinks the REAL running file
    const distinctDirR4 = fs.statSync(targetR4).ino !== fs.statSync(repoRoot).ino;
    const sharesInode = fs.statSync(path.join(targetR4, 'scripts', 'onboard.mjs')).ino === fs.statSync(realOnboard).ino;
    const resHG = runNode(realOnboard, [targetR4, '--no-board'], repoRoot);
    check('(H-G0) target is a DISTINCT dir yet shares the running onboard.mjs inode (the exact r3-trap shape)',
      distinctDirR4 && sharesInode, `distinctDir=${distinctDirR4} sharesInode=${sharesInode}`);
    check('(H-G1) r4 ACCEPTS the distinct hardlink copy (exit 0 — no false refusal)',
      resHG.code === 0, `code=${resHG.code} ${resHG.out.slice(-240)}`);
    check('(H-G2) r4 onboarded it normally (.orchard/ created in the distinct dir)',
      fs.existsSync(path.join(targetR4, '.orchard')));
    // And the true self-target still refuses under r4 (directory identity intact).
    check('(H-G3) r4 still refuses the genuine self-target (selfTargetReason(repoRoot) non-null)',
      typeof mod.selfTargetReason(repoRoot) === 'string');
  }

  // ---------------------------------------------------------------
  // (C) r5 write-through-hardlink. r4 CORRECTLY accepts a distinct `cp -al`
  // copy (different root inode), but a pre-r5 onboard then wrote package.json
  // and .claude/settings.json IN PLACE — and because those files hardlink the
  // source repo, the in-place write corrupted the SOURCE (adv 83ee76ee53ae).
  // The "source" here is a scratch reflink copy of the repo; we `cp -al` IT
  // (never the real repo, per charter) so corruption, if any, hits scratch.
  // Pre-r5 state is SYNTHESIZED by text (naive chokepoint), NOT a git SHA.
  // ---------------------------------------------------------------
  {
    // (C-M) PRE-r5: in-place writes corrupt the hardlinked SOURCE.
    const srcM = makeOwnRepoCopy('bug227-c-src-m-');
    writePrefixAtomicWrite(srcM);             // synthesize naive writes IN the source tool, BEFORE the cp -al
    const tgtM = hardlinkTreeCopy(srcM, 'bug227-c-tgt-m-'); // distinct dir; files hardlink srcM
    const srcPkg = path.join(srcM, 'package.json');
    const srcSettings = path.join(srcM, '.claude', 'settings.json');
    const distinctDir = fs.statSync(tgtM).ino !== fs.statSync(srcM).ino;
    const pkgShared = fs.statSync(path.join(tgtM, 'package.json')).ino === fs.statSync(srcPkg).ino;
    const settingsShared = fs.statSync(path.join(tgtM, '.claude', 'settings.json')).ino === fs.statSync(srcSettings).ino;
    const pkgBefore = sha(srcPkg);
    const settingsBefore = sha(srcSettings);
    // Tool repoRoot = srcM; target = tgtM (a DISTINCT dir) → guard accepts it.
    const resCM = runNode(path.join(srcM, 'scripts', 'onboard.mjs'), [tgtM, '--no-board'], srcM);
    const pkgAfter = sha(srcPkg);
    const settingsAfter = sha(srcSettings);
    check('(C-M0) cp -al copy is a DISTINCT dir whose package.json+settings.json hardlink the source',
      distinctDir && pkgShared && settingsShared, `distinctDir=${distinctDir} pkgShared=${pkgShared} settingsShared=${settingsShared}`);
    check('(C-M1) PRE-r5 onboard accepts the distinct cp -al copy (exit 0 — guard does not stop it)',
      resCM.code === 0, `code=${resCM.code} ${resCM.out.slice(-200)}`);
    check('(C-M2) PRE-r5 in-place write CORRUPTED the SOURCE repo package.json (write-through hardlink)',
      !!pkgBefore && !!pkgAfter && !pkgBefore.equals(pkgAfter) && pkgAfter.toString().includes('.orchard/'),
      pkgBefore && pkgAfter ? `changed=${!pkgBefore.equals(pkgAfter)}` : 'pkg missing');
    check('(C-M3) PRE-r5 in-place write CORRUPTED the SOURCE repo .claude/settings.json',
      !!settingsBefore && !!settingsAfter && !settingsBefore.equals(settingsAfter) && settingsAfter.toString().includes('.orchard/'),
      settingsBefore && settingsAfter ? `changed=${!settingsBefore.equals(settingsAfter)}` : 'settings missing');

    // (C-G) FIXED (r5): the rename chokepoint confines every write to the target.
    const srcG = makeOwnRepoCopy('bug227-c-src-g-');  // FIXED onboard (current tree), no synthesis
    const tgtG = hardlinkTreeCopy(srcG, 'bug227-c-tgt-g-');
    const srcPkgG = path.join(srcG, 'package.json');
    const srcSettingsG = path.join(srcG, '.claude', 'settings.json');
    const tgtPkgInoBefore = fs.statSync(path.join(tgtG, 'package.json')).ino;
    const pkgBeforeG = sha(srcPkgG);
    const settingsBeforeG = sha(srcSettingsG);
    const resCG = runNode(path.join(srcG, 'scripts', 'onboard.mjs'), [tgtG, '--no-board'], srcG);
    const tgtPkgInoAfter = fs.statSync(path.join(tgtG, 'package.json')).ino;
    check('(C-G1) FIXED onboard still ACCEPTS the distinct cp -al copy (exit 0 — a real distinct copy is a legit target)',
      resCG.code === 0, `code=${resCG.code} ${resCG.out.slice(-240)}`);
    check('(C-G2) FIXED left the SOURCE repo package.json BYTE-IDENTICAL (no write-through)',
      !!pkgBeforeG && pkgBeforeG.equals(sha(srcPkgG)));
    check('(C-G3) FIXED left the SOURCE repo .claude/settings.json BYTE-IDENTICAL (no write-through)',
      !!settingsBeforeG && settingsBeforeG.equals(sha(srcSettingsG)));
    check('(C-G4) FIXED onboarded the TARGET (its package.json now points at .orchard/, and got a NEW inode via rename)',
      sha(path.join(tgtG, 'package.json')).toString().includes('.orchard/') && tgtPkgInoAfter !== tgtPkgInoBefore,
      `inoBefore=${tgtPkgInoBefore} inoAfter=${tgtPkgInoAfter}`);
    void settingsBeforeG;
  }

  // ---------------------------------------------------------------
  // (S) Symlinked target file pointing OUTSIDE the target. DECISION: REPLACE the
  // link (the rename chokepoint does this for free) — a write never lands on the
  // link's outside destination. Two shapes:
  //   (S-M/S-G1/2) a DANGLING output symlink (CLAUDE.md → outside): a pre-r5
  //     existsSync-gated create FOLLOWS it and writes OUTSIDE the target; the
  //     fixed rename replaces the link in place.
  //   (S-G3) an EXISTING symlinked package.json → outside: never written through
  //     (readTargetFile lstat-refuses the symlink, so the modify path skips it).
  // ---------------------------------------------------------------
  {
    // (S-M) PRE-r5: the create follows a dangling symlink and escapes the target.
    const toolM = makeOwnRepoCopy('bug227-s-tool-m-');
    writePrefixAtomicWrite(toolM);
    const tgtSM = scratchDir('bug227-s-m-tgt-');
    fs.writeFileSync(path.join(tgtSM, 'package.json'), JSON.stringify({ name: 's-m', scripts: {} }, null, 2) + '\n');
    const outSM = scratchDir('bug227-s-m-out-');
    const escapeSM = path.join(outSM, 'ESCAPED-CLAUDE.md'); // does NOT exist → dangling link target
    fs.symlinkSync(escapeSM, path.join(tgtSM, 'CLAUDE.md'));
    runNode(path.join(toolM, 'scripts', 'onboard.mjs'), [tgtSM, '--no-board'], toolM);
    check('(S-M1) PRE-r5 create FOLLOWED the dangling symlink and wrote OUTSIDE the target (escape)',
      fs.existsSync(escapeSM));
    check('(S-M2) the escaped file is onboard\'s CLAUDE.md content (proves it was onboard\'s write)',
      fs.existsSync(escapeSM) && fs.readFileSync(escapeSM, 'utf8').includes('Orchard Working Agreement'));

    // (S-G1/2) FIXED: the dangling output symlink is replaced in place; nothing escapes.
    const tgtSG = scratchDir('bug227-s-g-tgt-');
    fs.writeFileSync(path.join(tgtSG, 'package.json'), JSON.stringify({ name: 's-g', scripts: {} }, null, 2) + '\n');
    const outSG = scratchDir('bug227-s-g-out-');
    const escapeSG = path.join(outSG, 'ESCAPED-CLAUDE.md');
    fs.symlinkSync(escapeSG, path.join(tgtSG, 'CLAUDE.md'));
    runNode(realOnboard, [tgtSG, '--no-board'], repoRoot);
    check('(S-G1) FIXED did NOT write outside the target (dangling link destination still absent)',
      !fs.existsSync(escapeSG));
    const cmLst = fs.lstatSync(path.join(tgtSG, 'CLAUDE.md'));
    check('(S-G2) FIXED replaced the link IN PLACE: target/CLAUDE.md is now a regular file with onboard content',
      cmLst.isFile() && !cmLst.isSymbolicLink() && fs.readFileSync(path.join(tgtSG, 'CLAUDE.md'), 'utf8').includes('Orchard Working Agreement'));

    // (S-G3) FIXED: an EXISTING symlinked package.json → outside is never written through.
    const tgtS3 = scratchDir('bug227-s-g3-tgt-');
    const outS3 = scratchDir('bug227-s-g3-out-');
    const outPkg = path.join(outS3, 'outside-package.json');
    fs.writeFileSync(outPkg, JSON.stringify({ name: 'outside', scripts: { gate: 'node scripts/gate.mjs' } }, null, 2) + '\n');
    const outPkgBefore = sha(outPkg);
    fs.symlinkSync(outPkg, path.join(tgtS3, 'package.json')); // target's package.json → outside file
    runNode(realOnboard, [tgtS3, '--no-board'], repoRoot);
    check('(S-G3) FIXED never wrote through a symlinked EXISTING package.json (outside file BYTE-IDENTICAL)',
      !!outPkgBefore && outPkgBefore.equals(sha(outPkg)));
    check('(S-G4) the symlinked package.json was left as a symlink (modify path read-guard-skipped it)',
      fs.lstatSync(path.join(tgtS3, 'package.json')).isSymbolicLink());
  }
} finally {
  for (const d of cleanups) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}

console.log(`\nBUG-227 self-target refusal: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
