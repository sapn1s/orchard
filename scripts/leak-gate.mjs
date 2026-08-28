#!/usr/bin/env node
/**
 * leak-gate.mjs — private-artifact gate for public release (FEAT-049).
 *
 * Scans for private tokens (project names, home paths, usernames, email).
 * Exits 1 with a file:line listing on any hit; exits 0 clean.
 *
 * TWO MODES (BUG-080):
 *   - REPO MODE (no path arg): scan every git-TRACKED-or-new text file in the
 *     repo at the current directory (git ls-files -co). This is what the
 *     FEAT-050 gatekeeper invokes (cwd = target repo, no arg). Images are
 *     SKIPPED here — the PRIVATE working repo legitimately holds raw dashboard
 *     captures under docs/bugs/assets, and gating them would block every commit.
 *   - TREE MODE (a directory path arg): scan the built mirror TREE the publish
 *     pipeline hands us — literally every file destined for public release,
 *     walked off the filesystem (the tree is not yet a git repo). Here images
 *     ARE gated: any image NOT on the public allowlist (public/, docs/assets/)
 *     is a HARD leak, because dashboard PNGs carry private paths / usernames /
 *     session titles in their pixels that the text scan can never see.
 *
 * Pre-BUG-080 the path arg was ignored entirely: `node leak-gate.mjs <tree>`
 * still scanned the source repo (via `git rev-parse --show-toplevel` from cwd),
 * so the publish pipeline's "final gate" never looked at the tree it shipped.
 *
 * CONFIG — the token list. Each entry is { name, re }. NOTE: the literal
 * private strings are deliberately split ('saa'+'sis') so this file does not
 * trip its own gate when it ships in the public mirror.
 *
 * OUTPUT MODES (BUG-102):
 *   - default: on FAIL, print every hit line + the per-file breakdown (this is
 *     what the FEAT-050 gatekeeper captures verbatim; unchanged, do not touch).
 *   - --summary / --quiet: on FAIL, print only a CAPPED hit list + the summary
 *     line. This exists so a human/agent can READ the result without piping it
 *     into `tail` — which was the BUG-102 defect: a pipeline's exit status is
 *     the LAST command's, so `node leak-gate.mjs | tail -1` exits 0 even on
 *     FAIL and any `gate && git commit` guard proceeds on a leak. The readable
 *     invocation must BE the correct-exit invocation. The sanctioned entry
 *     point is `npm run gate` (scripts/gate.mjs), which never pipes.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The token list + the sanctioned LICENSE exemption now live in ONE shared
// module so the commit-time gate (this file) and the authoring-time ticket-write
// guard (scripts/board-tool.mjs) match against the SAME definitions — two
// detectors that disagree would be a worse bug than the leak. The literals are
// still split ('saa'+'sis') at their new home, so nothing here or there trips
// its own gate. See scripts/lib/leak-tokens.mjs.
import { TOKENS, allowedHitFor } from './lib/leak-tokens.mjs';

/** Image assets. In TREE mode these are allowlist-gated; in repo mode skipped. */
const IMG_RE = /\.(png|jpe?g|gif|ico|webp|bmp|tiff?|svg)$/i;
/** Non-image binaries — no scannable text, no pixel-leak risk; always skipped. */
const BIN_SKIP_RE = /\.(woff2?|ttf|eot|pdf|zip)$/i;
/**
 * Public image allowlist (BUG-080): path prefixes whose images are CURATED for
 * public release — the app-served assets (public/) and the screenshots the
 * README embeds (docs/assets/, hand-picked in FEAT-049). Every other image
 * (notably docs/bugs/assets/*.png — raw dashboard captures) is a leak.
 * Configurable via LEAK_GATE_IMG_ALLOW (comma-separated path prefixes).
 */
const IMG_ALLOW = (process.env.LEAK_GATE_IMG_ALLOW ?? 'public/,docs/assets/')
  .split(',').map((s) => s.trim()).filter(Boolean);
const isAllowedImage = (rel) => IMG_ALLOW.some((p) => rel.startsWith(p));

/** Recursively list every file under `root` (posix rel paths), skipping .git. */
function walkTree(root) {
  const out = [];
  (function rec(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === '.git') continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) rec(abs);
      else if (ent.isFile() || ent.isSymbolicLink()) out.push(path.relative(root, abs).split(path.sep).join('/'));
    }
  })(root);
  return out;
}

// Mode selection: a directory path arg → TREE mode (scan the built mirror);
// otherwise REPO mode (scan the git repo at cwd, as the gatekeeper invokes it).
// Flags (--summary/--quiet) are filtered out so they are never mistaken for the
// tree path arg (BUG-102).
const rawArgs = process.argv.slice(2);
const SUMMARY = rawArgs.includes('--summary') || rawArgs.includes('--quiet');
const argPath = rawArgs.find((a) => !a.startsWith('--'));
const TREE_MODE = Boolean(argPath);

let scanRoot;
let files;
if (TREE_MODE) {
  scanRoot = path.resolve(argPath);
  if (!fs.existsSync(scanRoot) || !fs.statSync(scanRoot).isDirectory()) {
    console.error(`LEAK GATE: ABORT — '${argPath}' is not a directory to scan.`);
    process.exit(2);
  }
  files = walkTree(scanRoot);
} else {
  scanRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  // -co --exclude-standard: tracked PLUS untracked-but-not-ignored files, so a
  // new file headed for the public tree is gated before it is ever `git add`ed.
  files = execFileSync('git', ['ls-files', '-z', '-co', '--exclude-standard'], { cwd: scanRoot, encoding: 'utf8' })
    .split('\0').filter(Boolean);
}

let hits = 0;
let imgHits = 0;
const perFile = new Map();
// Collect every hit line. In default mode we print each immediately (preserving
// the exact verbatim output the gatekeeper/verify-gatekeeper depend on). In
// --summary mode we defer and print a capped list at the end (BUG-102).
const hitLines = [];
/** Hits waived by ALLOWED_HITS. Always reported, so the waiver is never silent. */
const allowedHits = [];
const emitHit = (s) => { hitLines.push(s); if (!SUMMARY) console.error(s); };
for (const rel of files) {
  const abs = path.join(scanRoot, rel);
  if (!fs.existsSync(abs)) continue; // deleted/renamed in working tree but still in index
  // `ls-files -co` can emit DIRECTORY entries (a nested agent worktree with its
  // own .git shows up as `path/`); reading one is EISDIR and killed the gate.
  if (!fs.lstatSync(abs).isFile()) continue;

  if (IMG_RE.test(rel)) {
    // TREE mode: a non-allowlisted image IS a leak (pixels can carry private
    // data the text scan cannot). REPO mode: images are fine in the private
    // working repo — skip them (no regression for the gatekeeper).
    if (TREE_MODE && !isAllowedImage(rel)) {
      hits++; imgHits++;
      perFile.set(rel, (perFile.get(rel) ?? 0) + 1);
      emitHit(`${rel}:0: [private image — not on public allowlist] binary image would ship in the public tree`);
    }
    continue;
  }
  if (BIN_SKIP_RE.test(rel)) continue;

  const buf = fs.readFileSync(abs);
  if (buf.includes(0)) continue; // binary
  const lines = buf.toString('utf8').split('\n');
  lines.forEach((line, i) => {
    for (const t of TOKENS) {
      if (t.re.test(line)) {
        const allowed = allowedHitFor(rel, t.name, line);
        if (allowed) {
          allowedHits.push(`${rel}:${i + 1}: [${t.name}] ALLOWED — ${allowed.why}`);
          continue;
        }
        hits++;
        perFile.set(rel, (perFile.get(rel) ?? 0) + 1);
        emitHit(`${rel}:${i + 1}: [${t.name}] ${line.trim().slice(0, 160)}`);
      }
    }
  });
}

const mode = TREE_MODE ? `TREE ${scanRoot}` : 'REPO (git-tracked)';
// Report the sanctioned waivers on EVERY run, pass or fail. A gate that quietly
// stops looking at something is how the next leak ships.
// stdout, not stderr: on a PASS this is the only trace of the exemption, and it
// must survive anyone reading the sanctioned output or dropping stderr. The
// FAIL listing on stderr is untouched (verify-gatekeeper depends on it verbatim).
for (const l of allowedHits) console.log(`LEAK GATE: waived ${l}`);
if (hits > 0) {
  if (SUMMARY) {
    // Capped, readable-without-piping FAIL output (BUG-102). The hit lines were
    // NOT streamed during the scan in this mode, so print a capped sample here.
    const CAP = 10;
    for (const l of hitLines.slice(0, CAP)) console.error(l);
    if (hitLines.length > CAP) {
      console.error(`… (+${hitLines.length - CAP} more hit line(s) — run 'node scripts/leak-gate.mjs' unpiped for the full listing)`);
    }
  } else {
    console.error('\n--- hits per file ---');
    for (const [f, n] of [...perFile.entries()].sort((a, b) => b[1] - a[1])) console.error(`${String(n).padStart(4)}  ${f}`);
  }
  const imgNote = imgHits > 0 ? ` (incl. ${imgHits} non-allowlisted image(s))` : '';
  console.error(`\nLEAK GATE: FAIL — ${hits} hit(s)${imgNote} in ${perFile.size} file(s) across ${files.length} files [${mode}].`);
  process.exit(1);
}
console.log(`LEAK GATE: PASS — 0 hits across ${files.length} files [${mode}].`);
