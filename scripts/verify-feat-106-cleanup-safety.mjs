#!/usr/bin/env node
/**
 * verify-feat-106-cleanup-safety.mjs — FEAT-106 round 2. Proves the GUARDED
 * cleanup honours its data-loss invariant after the cross-provider verify
 * (openai run 01a0ec00) found two holes:
 *   FINDING 1 — cleanup FOLLOWED a `public` symlink and deleted OUTSIDE the repo.
 *   FINDING 2 — copy-then-delete had a TOCTOU window that lost a concurrent edit.
 *
 * THE INVARIANT under test: cleanup only ever removes a REGULAR FILE that lies
 * INSIDE the target repo (realpath-checked; symlinks never followed or
 * traversed), whose bytes AT THE MOMENT OF REMOVAL equal the bytes backed up and
 * hash-matched as Orchard-written.
 *
 * Every fixture is a throwaway temp repo under the OS temp root, plus a
 * throwaway "operator-outside" dir. NEVER run against a real repo.
 *
 * Each hazard is proven NON-VACUOUS (the fixture genuinely traps a naive
 * implementation) and then CLOSED (the real cleanup refuses / preserves):
 *   S1 symlinked `public` → outside dir (verifier repro 1)
 *   S2 symlinked dir at depth ≥2, and a symlinked `scripts/lib` (generalisation)
 *   S3 symlinked FILE — a tool path and a public file (generalisation)
 *   T1 edit between hash-check and removal (verifier repro 2): naive loses it,
 *      the atomic rename+reverify design preserves it
 *   X1 hardlinked file — content survives at the other link (named attack)
 *   X2 the target dir is itself a symlink — cleanup stays confined
 *   X3 permission-denied mid-cleanup — no partial state, file left intact
 *
 * Run: node scripts/verify-feat-106-cleanup-safety.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { safeRemovable, atomicRemoveVerified, resolveRootReal, noClobberMove, readTargetFile } from './onboard.mjs';
import { readOrchardConfig } from './lib/board-path.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const onboardScript = path.join(repoRoot, 'scripts', 'onboard.mjs');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { console.log(`PASS: ${label}`); pass++; }
  else { console.log(`FAIL: ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); fail++; }
}

function migrate(target) {
  try { return { code: 0, out: execFileSync('node', [onboardScript, target, '--migrate'], { encoding: 'utf8', cwd: repoRoot }) }; }
  catch (e) { return { code: e.status ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') }; }
}

/** A minimal legacy target: one matching tool copy + a matching public/lib. */
function legacyTarget(root, name) {
  const P = path.join(root, name);
  fs.mkdirSync(path.join(P, 'docs', 'bugs'), { recursive: true });
  fs.mkdirSync(path.join(P, 'scripts', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(P, 'docs', 'bugs', 'INDEX.md'), '# Board\n## Open\n## Done\n');
  fs.writeFileSync(path.join(P, 'package.json'), JSON.stringify({ name, version: '0', scripts: {} }, null, 2) + '\n');
  fs.copyFileSync(path.join(repoRoot, 'scripts', 'board.mjs'), path.join(P, 'scripts', 'board.mjs'));
  return P;
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'feat106-cleanup-safety-'));

try {
  // =====================================================================
  // S1. A symlinked `public` → an operator-outside dir. Cleanup must NOT
  //     follow it. (verifier FINDING 1)
  // =====================================================================
  {
    const P = legacyTarget(tmpRoot, 's1');
    const outside = path.join(tmpRoot, 's1-operator-home');
    fs.mkdirSync(path.join(outside, 'lib'), { recursive: true });
    // A sentinel that MUST survive, plus a file named exactly like an Orchard
    // one (dom.js) to bait a byte-match delete.
    fs.writeFileSync(path.join(outside, 'victim.txt'), 'operator data — must survive\n');
    fs.copyFileSync(path.join(repoRoot, 'public', 'lib', 'dom.js'), path.join(outside, 'lib', 'dom.js'));
    fs.symlinkSync(outside, path.join(P, 'public'), 'dir');

    // NON-VACUITY: a naive scanner that followed the link WOULD reach the outside
    // files (proving the fixture is a real trap) — we only LIST, never delete.
    const naiveReach = fs.readdirSync(path.join(P, 'public'), { withFileTypes: true }).map((d) => d.name);
    check('S1 non-vacuity: a link-following scan reaches the OUTSIDE dir (real trap)', naiveReach.includes('victim.txt') && naiveReach.includes('lib'), naiveReach);

    const r = migrate(P);
    check('S1 --migrate exits 0', r.code === 0, r.out.slice(-200));
    check('S1 operator sentinel OUTSIDE the repo SURVIVES', fs.existsSync(path.join(outside, 'victim.txt')));
    check('S1 the baited outside lib/dom.js SURVIVES (link not followed)', fs.existsSync(path.join(outside, 'lib', 'dom.js')));
    check('S1 the public symlink itself is KEPT + reported as a symlink', fs.existsSync(path.join(P, 'public')) && /public\/[\s\S]*SYMLINK|SYMLINK/.test(r.out) && /KEPT/.test(r.out), r.out.split('\n').find((l) => /public/.test(l)));
  }

  // =====================================================================
  // S2. Symlinked dir at depth ≥2, and a symlinked scripts/lib.
  // =====================================================================
  {
    const P = legacyTarget(tmpRoot, 's2');
    const outside = path.join(tmpRoot, 's2-outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'must survive\n');
    // depth-≥2 symlinked dir inside a REAL public/
    fs.mkdirSync(path.join(P, 'public', 'lib'), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, 'public', 'lib', 'dom.js'), path.join(P, 'public', 'lib', 'dom.js'));
    fs.symlinkSync(outside, path.join(P, 'public', 'sub'), 'dir'); // public/sub -> outside
    // a symlinked scripts/lib holding a name that would otherwise match
    const outsideLib = path.join(tmpRoot, 's2-scriptslib');
    fs.mkdirSync(outsideLib, { recursive: true });
    fs.writeFileSync(path.join(outsideLib, 'ticket-schema.mjs'), 'operator lib — must survive\n');
    fs.rmSync(path.join(P, 'scripts', 'lib'), { recursive: true, force: true });
    fs.symlinkSync(outsideLib, path.join(P, 'scripts', 'lib'), 'dir');

    const r = migrate(P);
    check('S2 --migrate exits 0', r.code === 0, r.out.slice(-200));
    check('S2 outside dir behind public/sub SURVIVES', fs.existsSync(path.join(outside, 'keep.txt')));
    check('S2 public/ KEPT WHOLE (symlinked subdir present, not traversed)', /public\//.test(r.out) && /KEPT WHOLE/.test(r.out), r.out.split('\n').find((l) => /public/.test(l)));
    check('S2 outside behind symlinked scripts/lib SURVIVES', fs.existsSync(path.join(outsideLib, 'ticket-schema.mjs')));
    check('S2 scripts/lib symlink not traversed (its files reported KEPT as symlink component)', /symlink component 'scripts\/lib'/.test(r.out), r.out.split('\n').filter((l) => /scripts\/lib/.test(l)).slice(0, 2));
  }

  // =====================================================================
  // S3. A symlinked FILE — a tool path and a public file.
  // =====================================================================
  {
    const P = legacyTarget(tmpRoot, 's3');
    const outside = path.join(tmpRoot, 's3-outside');
    fs.mkdirSync(outside, { recursive: true });
    // board.mjs is a symlink to an outside file that has the SAME bytes as source
    // (so a leaf-symlink that a byte-check alone would greenlight).
    fs.copyFileSync(path.join(repoRoot, 'scripts', 'board.mjs'), path.join(outside, 'board.mjs'));
    fs.rmSync(path.join(P, 'scripts', 'board.mjs'));
    fs.symlinkSync(path.join(outside, 'board.mjs'), path.join(P, 'scripts', 'board.mjs'), 'file');
    // a public file that is a symlink out
    fs.mkdirSync(path.join(P, 'public', 'lib'), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, 'public', 'lib', 'dom.js'), path.join(outside, 'dom.js'));
    fs.symlinkSync(path.join(outside, 'dom.js'), path.join(P, 'public', 'lib', 'dom.js'), 'file');

    const r = migrate(P);
    check('S3 --migrate exits 0', r.code === 0, r.out.slice(-200));
    check('S3 outside board.mjs (symlink leaf target) SURVIVES', fs.existsSync(path.join(outside, 'board.mjs')));
    check('S3 the scripts/board.mjs symlink is KEPT, not removed/followed', fs.lstatSync(path.join(P, 'scripts', 'board.mjs')).isSymbolicLink() && /scripts\/board\.mjs[\s\S]*KEPT|KEPT[\s\S]*not a regular file|not a regular file/.test(r.out), r.out.split('\n').find((l) => /board\.mjs/.test(l)));
    check('S3 outside dom.js (public symlink leaf) SURVIVES', fs.existsSync(path.join(outside, 'dom.js')));
    check('S3 public/ KEPT WHOLE (symlinked file present)', /public\//.test(r.out) && /KEPT WHOLE/.test(r.out), r.out.split('\n').find((l) => /public/.test(l)));
  }

  // =====================================================================
  // T1. Edit between hash-check and removal (verifier FINDING 2).
  //     Non-vacuity: the naive copy-then-delete LOSES the edit; the atomic
  //     rename+reverify preserves it.
  // =====================================================================
  {
    const src = path.join(repoRoot, 'scripts', 'board.mjs'); // the "Orchard-written" bytes

    // (a) NON-VACUITY — model the round-1 defect. copy-then-delete with an edit
    //     landing in the window loses the edit: backup holds the OLD bytes and
    //     the original is deleted, so the edited content survives NOWHERE.
    const naiveDir = fs.mkdtempSync(path.join(tmpRoot, 'toctou-naive-'));
    const naiveFile = path.join(naiveDir, 'board.mjs');
    const naiveBackup = path.join(naiveDir, 'backup', 'board.mjs');
    fs.copyFileSync(src, naiveFile); // matches Orchard bytes at "hash check"
    const naiveRemove = (abs, backup, onWindow) => {
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.copyFileSync(abs, backup);        // backup = current (Orchard) bytes
      onWindow();                          // <-- concurrent user edit lands here
      fs.rmSync(abs);                      // original deleted
    };
    const EDIT = '// USER EDIT that must not be lost\n';
    naiveRemove(naiveFile, naiveBackup, () => fs.appendFileSync(naiveFile, EDIT));
    const naiveBackupHasEdit = fs.existsSync(naiveBackup) && fs.readFileSync(naiveBackup, 'utf8').includes(EDIT);
    const naiveOriginalGone = !fs.existsSync(naiveFile);
    check('T1 non-vacuity: naive copy-then-delete LOSES the windowed edit (backup=old, original gone)', naiveOriginalGone && !naiveBackupHasEdit, { naiveOriginalGone, naiveBackupHasEdit });

    // (b) PASS-AFTER — atomicRemoveVerified, handed a file whose bytes DIFFER
    //     from the Orchard source (models "the edit is already present at the
    //     moment of removal"): it must RESTORE the file, never delete it.
    const realDir = fs.mkdtempSync(path.join(tmpRoot, 'toctou-real-'));
    const realFile = path.join(realDir, 'board.mjs');
    const realBackup = path.join(realDir, 'backup');
    fs.copyFileSync(src, realFile);
    fs.appendFileSync(realFile, EDIT); // current bytes now != Orchard src
    const before = fs.readFileSync(realFile, 'utf8');
    const res = atomicRemoveVerified(realFile, 'board.mjs', src, realBackup);
    check('T1 atomicRemoveVerified REFUSES to remove a file whose bytes != Orchard src', res.removed === false, res);
    check('T1 …and the file is RESTORED intact with its edited bytes (no loss)', fs.existsSync(realFile) && fs.readFileSync(realFile, 'utf8') === before);

    // (c) happy path — matching bytes are removed atomically + backed up.
    const okDir = fs.mkdtempSync(path.join(tmpRoot, 'toctou-ok-'));
    const okFile = path.join(okDir, 'board.mjs');
    const okBackup = path.join(okDir, 'backup');
    fs.copyFileSync(src, okFile);
    const okRes = atomicRemoveVerified(okFile, 'board.mjs', src, okBackup);
    check('T1 a matching file IS removed atomically and lands in the backup', okRes.removed === true && !fs.existsSync(okFile) && fs.existsSync(path.join(okBackup, 'board.mjs')), okRes);
  }

  // =====================================================================
  // X1. Hardlinked file — removing our entry leaves the content at the other
  //     link. No operator data loss.
  // =====================================================================
  {
    const P = legacyTarget(tmpRoot, 'x1');
    const outside = path.join(tmpRoot, 'x1-outside');
    fs.mkdirSync(outside, { recursive: true });
    const outsideBoard = path.join(outside, 'board.mjs');
    // Make target/scripts/board.mjs and an outside file the SAME inode (hardlink),
    // with the Orchard bytes (so it byte-matches and is eligible for removal).
    fs.rmSync(path.join(P, 'scripts', 'board.mjs'));
    fs.copyFileSync(path.join(repoRoot, 'scripts', 'board.mjs'), outsideBoard);
    fs.linkSync(outsideBoard, path.join(P, 'scripts', 'board.mjs'));
    const r = migrate(P);
    check('X1 --migrate exits 0', r.code === 0, r.out.slice(-200));
    check('X1 the other hardlink (operator content) SURVIVES with its bytes', fs.existsSync(outsideBoard) && fs.readFileSync(outsideBoard).equals(fs.readFileSync(path.join(repoRoot, 'scripts', 'board.mjs'))));
    check('X1 our own link was removed (only the entry, not the data)', !fs.existsSync(path.join(P, 'scripts', 'board.mjs')));
  }

  // =====================================================================
  // X2. The target dir is ITSELF a symlink — cleanup stays confined to the
  //     real repo and does not escape.
  // =====================================================================
  {
    const real = legacyTarget(tmpRoot, 'x2-real');
    const link = path.join(tmpRoot, 'x2-link');
    fs.symlinkSync(real, link, 'dir');
    const r = migrate(link); // onboard the SYMLINK path
    check('X2 --migrate on a symlinked target exits 0', r.code === 0, r.out.slice(-200));
    check('X2 the matching board.mjs inside the real target was removed', !fs.existsSync(path.join(real, 'scripts', 'board.mjs')));
    check('X2 removal happened INSIDE the resolved repo (backup dir under the real target)', fs.existsSync(real) && fs.readdirSync(path.join(real, '.orchard')).some((n) => n.startsWith('.legacy-backup-')));
  }

  // =====================================================================
  // X3. Permission-denied mid-cleanup — no partial state; the file is left
  //     intact, not half-moved. (Skipped if running as root: perms don't bind.)
  // =====================================================================
  {
    const P = legacyTarget(tmpRoot, 'x3');
    const abs = path.join(P, 'scripts', 'board.mjs');
    const before = fs.readFileSync(abs);
    // Make the parent dir read+exec but not writable → rename OUT of it fails.
    fs.chmodSync(path.join(P, 'scripts'), 0o555);
    const backup = path.join(P, '.orchard', 'x3-backup');
    const res = atomicRemoveVerified(abs, 'scripts/board.mjs', path.join(repoRoot, 'scripts', 'board.mjs'), backup);
    fs.chmodSync(path.join(P, 'scripts'), 0o755);
    if (process.getuid && process.getuid() === 0) {
      check('X3 permission-denied [SKIPPED — running as root, perms do not bind]', true);
    } else {
      check('X3 a rename that cannot complete leaves the file INTACT (no partial state)', res.removed === false && fs.existsSync(abs) && fs.readFileSync(abs).equals(before), res);
      check('X3 nothing was left in the backup for the failed move', !fs.existsSync(path.join(backup, 'scripts', 'board.mjs')));
    }
  }

  // =====================================================================
  // Guard-unit spot checks (safeRemovable direct).
  // =====================================================================
  {
    const P = legacyTarget(tmpRoot, 'unit');
    const rootReal = resolveRootReal(P);
    check('U1 safeRemovable accepts a plain regular file inside the repo', safeRemovable(rootReal, 'scripts/board.mjs').ok === true);
    const outside = path.join(tmpRoot, 'unit-outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'x'), 'x');
    fs.symlinkSync(outside, path.join(P, 'linkdir'), 'dir');
    check('U2 safeRemovable refuses a path through a symlinked dir', safeRemovable(rootReal, 'linkdir/x').ok === false);
    fs.symlinkSync(path.join(outside, 'x'), path.join(P, 'linkfile'), 'file');
    check('U3 safeRemovable refuses a symlinked leaf file', safeRemovable(rootReal, 'linkfile').ok === false);
    check('U4 safeRemovable refuses a directory (only regular files)', safeRemovable(rootReal, 'scripts').ok === false);
  }

  // =====================================================================
  // F1. Backup-destination collision (round-3 FINDING 1). A move into the
  //     backup must NEVER overwrite a pre-existing backup entry.
  // =====================================================================
  {
    const src = path.join(repoRoot, 'scripts', 'board.mjs');
    // NON-VACUITY: a naive rename into a pre-populated dest CLOBBERS prior bytes.
    const nv = fs.mkdtempSync(path.join(tmpRoot, 'f1-naive-'));
    const nvAbs = path.join(nv, 'board.mjs'); fs.copyFileSync(src, nvAbs);
    const nvBackup = path.join(nv, 'backup'); fs.mkdirSync(nvBackup);
    const nvDest = path.join(nvBackup, 'board.mjs'); fs.writeFileSync(nvDest, 'PRIOR BACKUP BYTES — must survive\n');
    fs.renameSync(nvAbs, nvDest); // naive: overwrites the prior backup
    check('F1 non-vacuity: a naive rename INTO the backup destroys prior backup bytes', !fs.readFileSync(nvDest, 'utf8').includes('PRIOR BACKUP'), fs.readFileSync(nvDest, 'utf8').slice(0, 30));

    // PASS-AFTER: atomicRemoveVerified REFUSES when the backup dest already exists.
    const rd = fs.mkdtempSync(path.join(tmpRoot, 'f1-real-'));
    const rdAbs = path.join(rd, 'board.mjs'); fs.copyFileSync(src, rdAbs);
    const rdBackup = path.join(rd, 'backup'); fs.mkdirSync(path.join(rdBackup));
    const rdDest = path.join(rdBackup, 'board.mjs'); fs.writeFileSync(rdDest, 'PRIOR BACKUP BYTES — must survive\n');
    const res = atomicRemoveVerified(rdAbs, 'board.mjs', src, rdBackup);
    check('F1 atomicRemoveVerified REFUSES a move onto an existing backup entry (no clobber)', res.removed === false, res);
    check('F1 …the prior backup bytes SURVIVE', fs.readFileSync(rdDest, 'utf8').includes('PRIOR BACKUP'));
    check('F1 …and the source file is left intact (not removed)', fs.existsSync(rdAbs) && fs.readFileSync(rdAbs).equals(fs.readFileSync(src)));

    // Generalisation: a fresh per-run backup dir (mkdtemp) means two --migrate
    // runs never share a backup dir, so the first run's backup cannot be clobbered.
    const P = legacyTarget(tmpRoot, 'f1-e2e');
    const r1 = migrate(P);
    const backups1 = fs.readdirSync(path.join(P, '.orchard')).filter((n) => n.startsWith('.legacy-backup-'));
    const r2 = migrate(P); // second run removes nothing new (idempotent)
    const backups2 = fs.readdirSync(path.join(P, '.orchard')).filter((n) => n.startsWith('.legacy-backup-'));
    check('F1 each --migrate run uses a UNIQUE mkdtemp backup dir; the first survives', r1.code === 0 && r2.code === 0 && backups1.length === 1 && backups2.length === 1 && fs.existsSync(path.join(P, '.orchard', backups1[0], 'scripts', 'board.mjs')), { backups1, backups2 });
  }

  // =====================================================================
  // F2. Restore-collision (round-3 FINDING 2). A move-BACK must never overwrite
  //     a NEW file that has taken the original path.
  // =====================================================================
  {
    // NON-VACUITY: a naive rename-back overwrites the occupant.
    const nv = fs.mkdtempSync(path.join(tmpRoot, 'f2-naive-'));
    const nvBackup = path.join(nv, 'b'); fs.mkdirSync(nvBackup);
    const nvDest = path.join(nvBackup, 'board.mjs'); fs.writeFileSync(nvDest, 'removed bytes\n');
    const nvAbs = path.join(nv, 'board.mjs'); fs.writeFileSync(nvAbs, 'NEW USER FILE — must survive\n');
    fs.renameSync(nvDest, nvAbs); // naive restore: clobbers the new user file
    check('F2 non-vacuity: a naive rename-back DESTROYS a new user file at the original path', !fs.readFileSync(nvAbs, 'utf8').includes('NEW USER FILE'), fs.readFileSync(nvAbs, 'utf8').slice(0, 30));

    // PASS-AFTER: noClobberMove (the restore primitive) REFUSES to overwrite it.
    const rd = fs.mkdtempSync(path.join(tmpRoot, 'f2-real-'));
    const rdBackup = path.join(rd, 'b'); fs.mkdirSync(rdBackup);
    const rdDest = path.join(rdBackup, 'board.mjs'); fs.writeFileSync(rdDest, 'removed bytes\n');
    const rdAbs = path.join(rd, 'board.mjs'); fs.writeFileSync(rdAbs, 'NEW USER FILE — must survive\n');
    let threw = null;
    try { noClobberMove(rdDest, rdAbs); } catch (e) { threw = e.code || e.message; }
    check('F2 the restore primitive REFUSES (EEXIST) to overwrite an occupied original path', threw === 'EEXIST', threw);
    check('F2 …the NEW user file at the original path SURVIVES untouched', fs.readFileSync(rdAbs, 'utf8').includes('NEW USER FILE'));
    check('F2 …and the removed bytes stay safe in the backup (nothing destroyed)', fs.existsSync(rdDest) && fs.readFileSync(rdDest, 'utf8') === 'removed bytes\n');

    // Generalisation: the occupant is a DIRECTORY (still no clobber).
    const rd2 = fs.mkdtempSync(path.join(tmpRoot, 'f2-dir-'));
    const b2 = path.join(rd2, 'b'); fs.mkdirSync(b2);
    const d2 = path.join(b2, 'x'); fs.writeFileSync(d2, 'removed\n');
    const a2 = path.join(rd2, 'x'); fs.mkdirSync(a2); fs.writeFileSync(path.join(a2, 'inner.txt'), 'user dir content\n');
    let threw2 = null;
    try { noClobberMove(d2, a2); } catch (e) { threw2 = e.code || e.message; }
    check('F2 restore refuses when a DIRECTORY occupies the original path', threw2 !== null && fs.existsSync(path.join(a2, 'inner.txt')), threw2);
  }

  // =====================================================================
  // AS. Concurrent editor ATOMIC-SAVE race (round-4a FINDING). An editor saves
  //     by writing a temp file and rename()-ing it OVER the original — swapping
  //     the INODE under the path. The round-4 link()+unlink() forward move
  //     destroyed that new inode if the save landed between the two calls. The
  //     round-5 forward is a SINGLE rename that captures the inode, so no
  //     un-captured path is ever unlinked. Injected deterministically via the
  //     afterCapture/beforePutBack test hooks.
  // =====================================================================
  {
    const src = path.join(repoRoot, 'scripts', 'board.mjs');
    // An editor's atomic save: write a sibling temp, then rename it onto `p`.
    const atomicSave = (p, bytes) => {
      const tmp = p + '.editor-tmp';
      fs.writeFileSync(tmp, bytes);
      fs.renameSync(tmp, p); // inode swap under the path
    };

    // NON-VACUITY: the round-4 link+unlink forward, with an atomic save in the
    // window, DESTROYS the user's new inode (survives neither at path nor backup).
    {
      const d = fs.mkdtempSync(path.join(tmpRoot, 'as-naive-'));
      const abs = path.join(d, 'board.mjs'); fs.copyFileSync(src, abs);
      const backup = path.join(d, 'b'); fs.mkdirSync(backup);
      const dest = path.join(backup, 'board.mjs');
      // model noClobberMove(abs,dest) with a save injected between link and unlink
      fs.linkSync(abs, dest);
      atomicSave(abs, 'USER NEW SAVE — must survive\n'); // lands in the window
      fs.unlinkSync(abs); // round-4 hole: removes the user's NEW inode by path
      const lostEverywhere = !(fs.existsSync(abs)) && !fs.readFileSync(dest, 'utf8').includes('USER NEW SAVE');
      check('AS non-vacuity: round-4 link+unlink forward LOSES an atomic save in the window', lostEverywhere, { absExists: fs.existsSync(abs), backupHasSave: fs.readFileSync(dest, 'utf8').includes('USER NEW SAVE') });
    }

    // AS1 — save AFTER capture, captured bytes ARE Orchard's → removed:true, and
    // the user's NEW file survives at the original path (the round-4a failure).
    {
      const d = fs.mkdtempSync(path.join(tmpRoot, 'as1-'));
      const abs = path.join(d, 'board.mjs'); fs.copyFileSync(src, abs);
      const backup = path.join(d, 'b');
      const res = atomicRemoveVerified(abs, 'board.mjs', src, backup, {
        afterCapture: () => atomicSave(abs, 'USER NEW SAVE\n'),
      });
      check('AS1 removed:true (the captured Orchard inode was legitimately removed)', res.removed === true, res);
      check('AS1 the user\'s NEW save SURVIVES at the original path (round-4a hole closed)', fs.existsSync(abs) && fs.readFileSync(abs, 'utf8') === 'USER NEW SAVE\n', fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '(gone)');
      check('AS1 the captured Orchard bytes survive in the backup (byte conservation)', fs.existsSync(path.join(backup, 'board.mjs')) && fs.readFileSync(path.join(backup, 'board.mjs')).equals(fs.readFileSync(src)));
    }

    // AS2 — save AFTER capture, captured bytes are NOT Orchard's (force put-back).
    // The put-back finds the path re-occupied → KEPT-in-backup, new file survives.
    {
      const d = fs.mkdtempSync(path.join(tmpRoot, 'as2-'));
      const abs = path.join(d, 'board.mjs'); fs.writeFileSync(abs, 'diverged pre-save bytes\n');
      const backup = path.join(d, 'b');
      const res = atomicRemoveVerified(abs, 'board.mjs', src /* != captured */, backup, {
        afterCapture: () => atomicSave(abs, 'USER NEW SAVE 2\n'),
      });
      check('AS2 removed:false and reported KEPT-in-backup (path re-occupied)', res.removed === false && /KEPT-in-backup/.test(res.reason), res);
      check('AS2 the user\'s NEW save SURVIVES at the original path', fs.readFileSync(abs, 'utf8') === 'USER NEW SAVE 2\n');
      check('AS2 the captured (pre-save) bytes survive in the backup', fs.existsSync(path.join(backup, 'board.mjs')) && fs.readFileSync(path.join(backup, 'board.mjs'), 'utf8') === 'diverged pre-save bytes\n');
    }

    // AS3 — save DURING the put-back step (beforePutBack): same guarantee.
    {
      const d = fs.mkdtempSync(path.join(tmpRoot, 'as3-'));
      const abs = path.join(d, 'board.mjs'); fs.writeFileSync(abs, 'diverged bytes\n');
      const backup = path.join(d, 'b');
      const res = atomicRemoveVerified(abs, 'board.mjs', src, backup, {
        beforePutBack: () => atomicSave(abs, 'SAVE DURING PUTBACK\n'),
      });
      check('AS3 a save during put-back → KEPT-in-backup, new file untouched', res.removed === false && fs.readFileSync(abs, 'utf8') === 'SAVE DURING PUTBACK\n' && fs.existsSync(path.join(backup, 'board.mjs')), res);
    }

    // AS4 — REPEATED saves after capture: still no loss, always a valid outcome.
    {
      const d = fs.mkdtempSync(path.join(tmpRoot, 'as4-'));
      const abs = path.join(d, 'board.mjs'); fs.copyFileSync(src, abs);
      const backup = path.join(d, 'b');
      let n = 0;
      const res = atomicRemoveVerified(abs, 'board.mjs', src, backup, {
        afterCapture: () => { atomicSave(abs, `save-${++n}\n`); atomicSave(abs, `save-${++n}\n`); atomicSave(abs, `save-${++n}\n`); },
      });
      // Captured Orchard bytes → removed:true; the final user save survives at abs.
      check('AS4 repeated saves after capture: removed:true, final save survives at path, Orchard bytes in backup', res.removed === true && fs.readFileSync(abs, 'utf8') === 'save-3\n' && fs.readFileSync(path.join(backup, 'board.mjs')).equals(fs.readFileSync(src)), { res, abs: fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '(gone)' });
    }
  }

  // =====================================================================
  // LS. Leaf swapped to a NON-REGULAR type at capture (round-5 FINDINGS 2 & 3).
  //     A FIFO/dir/symlink appearing where a regular Orchard file stood must be
  //     REFUSED IN PLACE — never captured (no blocking read → no hang; no emptied
  //     original path). The residual pre-check→rename gap is accepted (adversarial).
  // =====================================================================
  {
    const src = path.join(repoRoot, 'scripts', 'board.mjs');

    // NON-VACUITY (FINDING 3): a naive capture (rename a dir into backup) empties
    // the original path, and put-back can't link a dir → the path is LOST.
    {
      const d = fs.mkdtempSync(path.join(tmpRoot, 'ls-naive-'));
      const absDir = path.join(d, 'board.mjs'); fs.mkdirSync(absDir); fs.writeFileSync(path.join(absDir, 'inner'), 'user dir content\n');
      const backup = path.join(d, 'b'); fs.mkdirSync(backup);
      const dest = path.join(backup, 'board.mjs');
      fs.renameSync(absDir, dest);            // naive capture moves the dir away
      let putBackFailed = false;
      try { fs.linkSync(dest, absDir); } catch { putBackFailed = true; } // can't link a dir
      check('LS non-vacuity: a naive capture of a directory EMPTIES the original path (put-back cannot link a dir)', putBackFailed && !fs.existsSync(absDir), { putBackFailed, absExists: fs.existsSync(absDir) });
    }

    // LS-FIFO (FINDING 2 fix): a FIFO at the leaf is refused in place; no hang.
    {
      const d = fs.mkdtempSync(path.join(tmpRoot, 'ls-fifo-'));
      const abs = path.join(d, 'board.mjs');
      execFileSync('mkfifo', [abs]);
      const backup = path.join(d, 'b');
      const res = atomicRemoveVerified(abs, 'board.mjs', src, backup); // must NOT hang / read the FIFO
      check('LS-FIFO refused in place (removed:false, named as a FIFO)', res.removed === false && /FIFO/.test(res.reason), res);
      check('LS-FIFO the FIFO is left where it stood, nothing captured', fs.lstatSync(abs).isFIFO() && !fs.existsSync(path.join(backup, 'board.mjs')));
    }

    // LS-DIR (FINDING 3 fix): a directory at the leaf is refused in place.
    {
      const d = fs.mkdtempSync(path.join(tmpRoot, 'ls-dir-'));
      const abs = path.join(d, 'board.mjs'); fs.mkdirSync(abs); fs.writeFileSync(path.join(abs, 'inner'), 'user content\n');
      const backup = path.join(d, 'b');
      const res = atomicRemoveVerified(abs, 'board.mjs', src, backup);
      check('LS-DIR refused in place (removed:false, named as a directory)', res.removed === false && /directory/.test(res.reason), res);
      check('LS-DIR the directory + its content are left where they stood', fs.statSync(abs).isDirectory() && fs.readFileSync(path.join(abs, 'inner'), 'utf8') === 'user content\n' && !fs.existsSync(path.join(backup, 'board.mjs')));
    }

    // LS-SYMLINK (generalisation): a symlink leaf is refused in place.
    {
      const d = fs.mkdtempSync(path.join(tmpRoot, 'ls-sym-'));
      const outside = path.join(d, 'outside'); fs.writeFileSync(outside, 'outside bytes\n');
      const abs = path.join(d, 'board.mjs'); fs.symlinkSync(outside, abs, 'file');
      const backup = path.join(d, 'b');
      const res = atomicRemoveVerified(abs, 'board.mjs', src, backup);
      check('LS-SYMLINK refused in place; the symlink and its target survive', res.removed === false && /symlink/.test(res.reason) && fs.lstatSync(abs).isSymbolicLink() && fs.existsSync(outside), res);
    }

    // F1-boundary (round-5 FINDING 1 ACCEPTED): the dest-exists guard refuses a
    // pre-existing backup dest (benign leftover) — the residual microsecond
    // check→rename gap requires an attacker racing our private mkdtemp dir and is
    // documented as out of the threat model.
    {
      const d = fs.mkdtempSync(path.join(tmpRoot, 'f1b-'));
      const abs = path.join(d, 'board.mjs'); fs.copyFileSync(src, abs);
      const backup = path.join(d, 'b'); fs.mkdirSync(backup);
      fs.writeFileSync(path.join(backup, 'board.mjs'), 'PRIOR\n');
      const res = atomicRemoveVerified(abs, 'board.mjs', src, backup);
      check('F1-boundary: a pre-existing backup dest is refused (guard holds); source intact', res.removed === false && fs.existsSync(abs) && fs.readFileSync(path.join(backup, 'board.mjs'), 'utf8') === 'PRIOR\n', res);
    }
  }

  // =====================================================================
  // TR. Guarded target-repo reads (round-7): EVERY read onboard/fleet-sync make
  //     of a target file goes through readTargetFile, which refuses a
  //     FIFO/dir/socket/oversized file instead of blocking forever. Proven at the
  //     helper AND end-to-end at docs/CONVENTIONS.md and a second migrated path.
  //     The whole suite runs under a 120s wrapper — a hang would fail it.
  // =====================================================================
  {
    // Unit: a regular file reads back; non-regular / oversized are refused.
    const d = fs.mkdtempSync(path.join(tmpRoot, 'tr-unit-'));
    const reg = path.join(d, 'reg'); fs.writeFileSync(reg, 'hello\n');
    check('TR readTargetFile reads a regular file', readTargetFile(reg).ok === true && readTargetFile(reg).data === 'hello\n');
    const fifo = path.join(d, 'fifo'); execFileSync('mkfifo', [fifo]);
    const rf = readTargetFile(fifo);
    check('TR readTargetFile REFUSES a FIFO (no block)', rf.ok === false && /FIFO/.test(rf.reason), rf);
    const dir = path.join(d, 'dir'); fs.mkdirSync(dir);
    check('TR readTargetFile REFUSES a directory', readTargetFile(dir).ok === false && /directory/.test(readTargetFile(dir).reason));
    check('TR readTargetFile CAPS an oversized file (small max)', readTargetFile(reg, { max: 3 }).ok === false && /too large/.test(readTargetFile(reg, { max: 3 }).reason));
    // Socket (if feasible).
    const sockPath = path.join(d, 'sock');
    const srv = net.createServer();
    let sockOk = false;
    try { await new Promise((res, rej) => { srv.once('error', rej); srv.listen(sockPath, res); }); sockOk = true; } catch { sockOk = false; }
    if (sockOk) {
      const rs = readTargetFile(sockPath);
      check('TR readTargetFile REFUSES a unix socket', rs.ok === false && /socket/.test(rs.reason), rs);
      await new Promise((res) => srv.close(res));
    } else {
      check('TR unix socket [SKIPPED — could not bind a socket here]', true);
    }

    // NON-VACUITY: readTargetFile discriminates — it returns content for a regular
    // file at the same path where it refuses a FIFO (so "refuse" is not blanket).
    check('TR non-vacuity: the same helper returns data for a regular file, refuses a FIFO', readTargetFile(reg).ok === true && readTargetFile(fifo).ok === false);
  }
  {
    // END-TO-END #1 — a FIFO at docs/CONVENTIONS.md: onboard must NOT hang; the
    // .orchard/CONVENTIONS.md falls back to the stub, the FIFO is reported.
    const P = path.join(tmpRoot, 'tr-e2e-fifo'); fs.mkdirSync(path.join(P, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(P, 'package.json'), JSON.stringify({ name: 'p', version: '0', scripts: {} }, null, 2) + '\n');
    execFileSync('mkfifo', [path.join(P, 'docs', 'CONVENTIONS.md')]);
    let out = '', code = 0, timedOut = false;
    try { out = execFileSync('node', [onboardScript, P], { encoding: 'utf8', cwd: repoRoot, timeout: 30000 }); }
    catch (e) { code = e.status ?? 1; out = (e.stdout ?? '') + (e.stderr ?? ''); if (e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM') timedOut = true; }
    check('TR-E2E onboard with a FIFO at docs/CONVENTIONS.md does NOT hang', !timedOut, { timedOut, code });
    check('TR-E2E .orchard/CONVENTIONS.md fell back to the stub (FIFO not migrated)', fs.existsSync(path.join(P, '.orchard', 'CONVENTIONS.md')) && fs.readFileSync(path.join(P, '.orchard', 'CONVENTIONS.md'), 'utf8').includes('Project Conventions (local)'));
    check('TR-E2E the run reports the non-regular legacy doc', /not migrated: not a regular file/.test(out), out.split('\n').filter((l) => /CONVENTIONS/.test(l)).slice(0, 2));
    check('TR-E2E the FIFO at docs/CONVENTIONS.md is left in place', fs.lstatSync(path.join(P, 'docs', 'CONVENTIONS.md')).isFIFO());
  }
  {
    // END-TO-END #2 — an OVERSIZED docs/CONVENTIONS.md (> the 8 MiB cap) and a
    // FIFO at a SECOND migrated path (package.json): onboard must not hang.
    const P = path.join(tmpRoot, 'tr-e2e-2'); fs.mkdirSync(path.join(P, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(P, 'docs', 'CONVENTIONS.md'), Buffer.alloc(9 * 1024 * 1024, 0x61)); // 9 MiB of 'a'
    execFileSync('mkfifo', [path.join(P, 'package.json')]); // FIFO at the other read path
    let code = 0, timedOut = false, out = '';
    try { out = execFileSync('node', [onboardScript, P], { encoding: 'utf8', cwd: repoRoot, timeout: 30000 }); }
    catch (e) { code = e.status ?? 1; out = (e.stdout ?? '') + (e.stderr ?? ''); if (e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM') timedOut = true; }
    check('TR-E2E onboard with an OVERSIZED CONVENTIONS.md + a FIFO package.json does NOT hang', !timedOut, { timedOut, code });
    check('TR-E2E oversized CONVENTIONS.md was not migrated (stub written instead)', fs.existsSync(path.join(P, '.orchard', 'CONVENTIONS.md')) && fs.statSync(path.join(P, '.orchard', 'CONVENTIONS.md')).size < 9 * 1024 * 1024);
    check('TR-E2E the FIFO package.json is left in place (never read into JSON.parse)', fs.lstatSync(path.join(P, 'package.json')).isFIFO());
  }

  // =====================================================================
  // CFG. The board-path helper `readOrchardConfig` is reached by onboard AND
  //      fleet-sync, so its read of the target's `.orchard/config.json` must be
  //      guarded too (round-8: a FIFO there hung onboard/fleet-sync — the same
  //      hang class surviving via the imported helper).
  // =====================================================================
  {
    // Unit: a regular config parses; a FIFO/symlink/oversized config → null, no block.
    const good = fs.mkdtempSync(path.join(tmpRoot, 'cfg-ok-'));
    fs.mkdirSync(path.join(good, '.orchard'));
    fs.writeFileSync(path.join(good, '.orchard', 'config.json'), JSON.stringify({ layoutVersion: 1, board: 'docs/bugs' }));
    check('CFG readOrchardConfig parses a regular config.json', readOrchardConfig(good)?.board === 'docs/bugs');

    const fifoCfg = fs.mkdtempSync(path.join(tmpRoot, 'cfg-fifo-'));
    fs.mkdirSync(path.join(fifoCfg, '.orchard'));
    execFileSync('mkfifo', [path.join(fifoCfg, '.orchard', 'config.json')]);
    check('CFG readOrchardConfig returns null for a FIFO config (no block)', readOrchardConfig(fifoCfg) === null);

    const symCfg = fs.mkdtempSync(path.join(tmpRoot, 'cfg-sym-'));
    fs.mkdirSync(path.join(symCfg, '.orchard'));
    const outsideCfg = path.join(symCfg, 'outside.json'); fs.writeFileSync(outsideCfg, JSON.stringify({ board: 'ESCAPED' }));
    fs.symlinkSync(outsideCfg, path.join(symCfg, '.orchard', 'config.json'), 'file');
    check('CFG readOrchardConfig refuses a SYMLINK config (not followed → null)', readOrchardConfig(symCfg) === null);

    const bigCfg = fs.mkdtempSync(path.join(tmpRoot, 'cfg-big-'));
    fs.mkdirSync(path.join(bigCfg, '.orchard'));
    fs.writeFileSync(path.join(bigCfg, '.orchard', 'config.json'), Buffer.alloc(2 * 1024 * 1024, 0x61)); // 2 MiB > 1 MiB cap
    check('CFG readOrchardConfig caps an oversized config → null', readOrchardConfig(bigCfg) === null);

    // E2E: a FIFO at .orchard/config.json must NOT hang onboard (the round-8 bug).
    const P = path.join(tmpRoot, 'cfg-e2e'); fs.mkdirSync(path.join(P, '.orchard'), { recursive: true });
    fs.mkdirSync(path.join(P, 'docs', 'bugs'), { recursive: true }); fs.writeFileSync(path.join(P, 'docs', 'bugs', 'INDEX.md'), '# b\n');
    fs.writeFileSync(path.join(P, 'package.json'), JSON.stringify({ name: 'p', version: '0', scripts: {} }, null, 2) + '\n');
    execFileSync('mkfifo', [path.join(P, '.orchard', 'config.json')]);
    let timedOut = false, code = 0;
    try { execFileSync('node', [onboardScript, P], { encoding: 'utf8', cwd: repoRoot, timeout: 30000 }); }
    catch (e) { code = e.status ?? 1; if (e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM') timedOut = true; }
    check('CFG-E2E onboard with a FIFO at .orchard/config.json does NOT hang', !timedOut, { timedOut, code });
    check('CFG-E2E the FIFO config is left in place', fs.lstatSync(path.join(P, '.orchard', 'config.json')).isFIFO());
  }

  // =====================================================================
  // CAP. Unbounded cleanup read (round-8 finding). A legacy file grown past the
  //      8 MiB cap between classification and capture must be BOUNDED, not read
  //      whole, and (being oversized) judged "not Orchard" → put back.
  // =====================================================================
  {
    const src = path.join(repoRoot, 'scripts', 'board.mjs'); // small Orchard source
    // PASS-AFTER: a >8 MiB captured file → targetBytesEqual caps the read →
    // atomicRemoveVerified judges it not-Orchard and restores it (removed:false).
    const d = fs.mkdtempSync(path.join(tmpRoot, 'cap-'));
    const abs = path.join(d, 'board.mjs'); fs.writeFileSync(abs, Buffer.alloc(16 * 1024 * 1024, 0x62)); // 16 MiB
    const backup = path.join(d, 'b');
    const res = atomicRemoveVerified(abs, 'board.mjs', src, backup);
    check('CAP a >8 MiB captured file is bounded (not Orchard) → removed:false, restored', res.removed === false && fs.existsSync(abs) && fs.statSync(abs).size === 16 * 1024 * 1024, res);
    // The capped reader refuses the oversized file rather than reading it whole.
    const rr = readTargetFile(abs, { encoding: null });
    check('CAP readTargetFile REFUSES the 16 MiB file (too large), never reads it whole', rr.ok === false && /too large/.test(rr.reason), rr);
    // NON-VACUITY: a ≤8 MiB file that matches Orchard IS removed (discrimination).
    const d2 = fs.mkdtempSync(path.join(tmpRoot, 'cap-ok-'));
    const abs2 = path.join(d2, 'board.mjs'); fs.copyFileSync(src, abs2);
    const res2 = atomicRemoveVerified(abs2, 'board.mjs', src, path.join(d2, 'b'));
    check('CAP non-vacuity: a small matching file IS removed (the cap is not blanket-refusing)', res2.removed === true);
  }

  // =====================================================================
  // NB. No-bypass: EVERY target-repo read in the two entry scripts + board-path
  //     goes through the guarded helper. A raw fs.readFileSync/createReadStream in
  //     those files is allowed ONLY on a repo-side / CLI-fixture argument; a read
  //     of a TARGET path would be a bypass of the round-6..9 hang/cap guarding.
  // =====================================================================
  {
    const files = ['scripts/onboard.mjs', 'scripts/fleet-sync.mjs', 'scripts/lib/board-path.mjs'];
    // Repo-side / CLI-fixture argument heads that are NOT target-repo reads.
    const ALLOWED = [/^repoSrcPath\b/, /^f\b/, /^registryFile\b/, /^entry\.src\b/, /^src\b/, /^path\.join\(\s*repoRoot\b/];
    const offenders = [];
    for (const rel of files) {
      const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      const re = /fs\.(?:readFileSync|createReadStream)\(\s*([^,)]+)/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const arg = m[1].trim();
        if (!ALLOWED.some((p) => p.test(arg))) offenders.push(`${rel}: fs.read…(${arg})`);
      }
    }
    check('NB every raw fs.read in onboard/fleet-sync/board-path is a repo-side/CLI arg (no target read bypasses readTargetFile)', offenders.length === 0, offenders);
    // Non-vacuity: the allow-list actually matched the known repo-side reads (so
    // the check is not vacuously green on zero matches).
    const anyMatched = files.some((rel) => /fs\.(?:readFileSync|createReadStream)\(/.test(fs.readFileSync(path.join(repoRoot, rel), 'utf8')));
    check('NB non-vacuity: the scan found real fs.read sites to classify', anyMatched);
  }

  // =====================================================================
  // F3. Ancestor-swap detection (round-3 FINDING 3, ACCEPTED adversarial race —
  //     narrowed by re-validating the parent realpath immediately before each
  //     move). This tests the abort TRIGGER deterministically: safeRemovable
  //     reports a stable parentReal, and swapping an ancestor for an
  //     outside-pointing symlink makes the very next check fail — the signal the
  //     apply loop halts on. The mid-move race itself is out of the threat model.
  // =====================================================================
  {
    const P = legacyTarget(tmpRoot, 'f3');
    const rootReal = resolveRootReal(P);
    const before = safeRemovable(rootReal, 'scripts/board.mjs');
    check('F3 safeRemovable captures a parentReal inside the repo', before.ok === true && typeof before.parentReal === 'string' && before.parentReal.startsWith(rootReal), before.parentReal);
    // Swap the `scripts` ancestor for a symlink to an outside dir.
    const outside = path.join(tmpRoot, 'f3-outside'); fs.mkdirSync(outside, { recursive: true });
    fs.copyFileSync(path.join(repoRoot, 'scripts', 'board.mjs'), path.join(outside, 'board.mjs'));
    fs.rmSync(path.join(P, 'scripts'), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(P, 'scripts'), 'dir');
    const after = safeRemovable(rootReal, 'scripts/board.mjs');
    check('F3 after an ancestor symlink-swap, the re-check DETECTS it (would halt the cleanup)', after.ok === false && /symlink component 'scripts'/.test(after.reason), after);
    check('F3 the outside file behind the swapped ancestor is never reached', fs.existsSync(path.join(outside, 'board.mjs')));
  }

  // =====================================================================
  // E1. The no-clobber primitive across FILESYSTEMS (EXDEV) — /tmp (btrfs) vs
  //     /dev/shm (tmpfs). Must refuse, never silently copy across.
  // =====================================================================
  {
    const shmOk = (() => { try { return fs.statSync('/dev/shm').isDirectory(); } catch { return false; } })();
    if (!shmOk) {
      check('E1 EXDEV across filesystems [SKIPPED — /dev/shm unavailable]', true);
    } else {
      const srcDir = fs.mkdtempSync(path.join(tmpRoot, 'exdev-src-')); // under tmpRoot (btrfs)
      const src = path.join(srcDir, 'board.mjs'); fs.copyFileSync(path.join(repoRoot, 'scripts', 'board.mjs'), src);
      let shmDir = null;
      try { shmDir = fs.mkdtempSync('/dev/shm/feat106-exdev-'); } catch { shmDir = null; }
      if (!shmDir) {
        check('E1 EXDEV across filesystems [SKIPPED — cannot mkdtemp under /dev/shm]', true);
      } else {
        try {
          let threw = null;
          try { noClobberMove(src, path.join(shmDir, 'board.mjs')); } catch (e) { threw = e.code || e.message; }
          // If /tmp and /dev/shm happened to be one fs, link would succeed — treat as skip.
          if (threw === null) {
            check('E1 EXDEV [SKIPPED — /dev/shm and the scratch root share one filesystem here]', true);
          } else {
            check('E1 a cross-filesystem no-clobber move REFUSES (EXDEV), never silently copies', threw === 'EXDEV', threw);
            check('E1 …and the source file is left INTACT after the refusal', fs.existsSync(src));
          }
        } finally { fs.rmSync(shmDir, { recursive: true, force: true }); }
      }
    }
  }

  // =====================================================================
  // E2. A read-only backup dir — the move refuses, the file is left intact.
  // =====================================================================
  {
    if (process.getuid && process.getuid() === 0) {
      check('E2 read-only backup dir [SKIPPED — running as root, perms do not bind]', true);
    } else {
      const rd = fs.mkdtempSync(path.join(tmpRoot, 'e2-ro-'));
      const abs = path.join(rd, 'board.mjs'); fs.copyFileSync(path.join(repoRoot, 'scripts', 'board.mjs'), abs);
      const backup = path.join(rd, 'backup'); fs.mkdirSync(backup); fs.chmodSync(backup, 0o555);
      const res = atomicRemoveVerified(abs, 'board.mjs', path.join(repoRoot, 'scripts', 'board.mjs'), backup);
      fs.chmodSync(backup, 0o755);
      check('E2 a move into a read-only backup dir REFUSES (no partial state)', res.removed === false, res);
      check('E2 …the source file is left INTACT', fs.existsSync(abs) && fs.readFileSync(abs).equals(fs.readFileSync(path.join(repoRoot, 'scripts', 'board.mjs'))));
      check('E2 …nothing was left in the backup', !fs.existsSync(path.join(backup, 'board.mjs')));
    }
  }
} finally {
  // chmod anything back so cleanup can remove it
  try { execFileSync('chmod', ['-R', 'u+rwX', tmpRoot]); } catch { /* ignore */ }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
