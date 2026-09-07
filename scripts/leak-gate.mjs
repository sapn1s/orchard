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
import { scanLine, scanIdentity, scanKeyShapes, scanBinary, allowedHitFor } from './lib/leak-tokens.mjs';

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
// FEAT-130 — also scan the commit itself, not just working-tree files:
//   --identity            scan `git config user.name`/`user.email` in the repo
//   --commit-msg=<path>   scan the pending commit message file
const SCAN_IDENTITY = rawArgs.includes('--identity');
// FEAT-130 round 2 — the ENFORCEMENT flag. `git commit` records the STAGED
// INDEX, not the working tree, so the round-1 working-tree scan could be
// bypassed by staging a secret and then cleaning/deleting the worktree copy: the
// gate read the clean/absent worktree, passed, and the commit captured the
// staged secret. With --staged, REPO mode scans the exact bytes that will be
// committed — each staged blob read from the index (`git show :<path>`) — for the
// files `git diff --cached` reports. The COMMIT-BLOCKING paths (git.ts commit(),
// the pre-commit hook, the agent git-write gate) pass this; `npm run gate` does
// NOT — it stays a working-tree "am I about to be safe" preflight.
const STAGED = rawArgs.includes('--staged');
const COMMIT_MSG_PATH = (rawArgs.find((a) => a.startsWith('--commit-msg=')) ?? '').split('=').slice(1).join('=') || null;
const argPath = rawArgs.find((a) => !a.startsWith('--'));
const TREE_MODE = Boolean(argPath);

let scanRoot;
let files;
// In --staged mode the file bytes come from the index, not the worktree; readBuf
// is set to a git-show-of-the-blob reader so the scan loop is source-agnostic.
let readBuf = (abs) => fs.readFileSync(abs);
if (TREE_MODE) {
  scanRoot = path.resolve(argPath);
  if (!fs.existsSync(scanRoot) || !fs.statSync(scanRoot).isDirectory()) {
    console.error(`LEAK GATE: ABORT — '${argPath}' is not a directory to scan.`);
    process.exit(2);
  }
  files = walkTree(scanRoot);
} else {
  scanRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  if (STAGED) {
    // ENFORCEMENT: the bytes to be committed are the STAGED INDEX. Enumerate the
    // paths git will record (Added/Copied/Modified/Renamed — a Deletion carries
    // no content to leak) and read each blob straight from the index. This is
    // immune to any index≠worktree divergence: it never touches the worktree.
    // Only REGULAR-FILE blobs (mode 100644/100755) are scanned — symlinks
    // (120000) and gitlinks/submodules (160000) are skipped, matching worktree
    // mode's `isFile()` skip; `git show :<symlink>` would otherwise scan the raw
    // link TARGET path (a scratch symlink to this repo would false-positive on
    // the home path in its target), not committed file content.
    const staged = execFileSync('git', ['ls-files', '-s', '-z'],
      { cwd: scanRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
    const modeOf = new Map();
    for (const rec of staged) {
      const m = rec.match(/^(\d{6}) [0-9a-f]+ \d\t(.*)$/s);
      if (m) modeOf.set(m[2], m[1]);
    }
    // --diff-filter=ACMRT: Added/Copied/Modified/Renamed AND Type-changed. The
    // round-2 enumeration dropped T, so changing a tracked symlink/gitlink INTO a
    // regular file whose blob carried a secret was never read — the blob is in the
    // index, `git diff --cached` (T) reports it, but the ACMR filter excluded it
    // (round-2 verifier CRITICAL). A Deletion (D) still carries no content to leak.
    files = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMRT', '-z'],
      { cwd: scanRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\0').filter(Boolean)
      .filter((rel) => { const m = modeOf.get(rel); return m === '100644' || m === '100755'; });
    readBuf = (_abs, rel) => execFileSync('git', ['show', `:${rel}`],
      { cwd: scanRoot, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  } else {
    // -co --exclude-standard: tracked PLUS untracked-but-not-ignored files, so a
    // new file headed for the public tree is gated before it is ever `git add`ed.
    files = execFileSync('git', ['ls-files', '-z', '-co', '--exclude-standard'], { cwd: scanRoot, encoding: 'utf8' })
      .split('\0').filter(Boolean);
  }
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
  // In --staged mode the content is read from the INDEX (`git show :path`), so
  // the worktree copy being clean, modified, or absent is irrelevant — that
  // divergence was the exact round-1 bypass. In worktree/tree mode, skip
  // deleted/renamed-away paths and non-files (a nested worktree's `path/` dir).
  if (!STAGED) {
    if (!fs.existsSync(abs)) continue; // deleted/renamed in working tree but still in index
    // `ls-files -co` can emit DIRECTORY entries (a nested agent worktree with its
    // own .git shows up as `path/`); reading one is EISDIR and killed the gate.
    if (!fs.lstatSync(abs).isFile()) continue;
  }

  if (IMG_RE.test(rel)) {
    // TREE mode: a non-allowlisted image IS a leak (pixels can carry private
    // data the text scan cannot). REPO mode: raster images are fine in the
    // private working repo — skip them (no regression for the gatekeeper).
    if (TREE_MODE && !isAllowedImage(rel)) {
      hits++; imgHits++;
      perFile.set(rel, (perFile.get(rel) ?? 0) + 1);
      emitHit(`${rel}:0: [private image — not on public allowlist] binary image would ship in the public tree`);
    }
    // FEAT-130 r3: an SVG is XML TEXT and can embed a credential in bytes the
    // pixel/allowlist rule never sees (round-2 verifier HIGH: a github_pat_ inside
    // a text .svg — and SVGs live under the very public/ + docs/assets/ dirs the
    // TREE allowlist waives without content-scanning — shipped end to end).
    // Content-scan SVGs for the high-signal KEY/assignment shapes in EVERY mode.
    // Raster images are NOT text-scanned (huge false-positive risk over random
    // pixel bytes; their pixel-leak risk is the TREE allowlist's job).
    if (/\.svg$/i.test(rel)) {
      let sbuf;
      try { sbuf = readBuf(abs, rel); }
      catch (e) {
        console.error(`LEAK GATE: ABORT — cannot read ${STAGED ? 'staged blob' : 'file'} '${rel}': ${e.message}`);
        process.exit(2);
      }
      for (const { token, match } of scanBinary(sbuf.toString('latin1'))) {
        hits++;
        perFile.set(rel, (perFile.get(rel) ?? 0) + 1);
        emitHit(`${rel}:0: [${token}] embedded in svg: ${String(match).slice(0, 80)}`);
      }
    }
    continue;
  }
  let buf;
  try { buf = readBuf(abs, rel); }
  catch (e) {
    // Fail-closed: a staged blob we cannot read is not a blob we can clear.
    console.error(`LEAK GATE: ABORT — cannot read ${STAGED ? 'staged blob' : 'file'} '${rel}': ${e.message}`);
    process.exit(2);
  }
  // FEAT-130 — binary / skipped files were a blind spot: a secret embedded in a
  // font/pdf/zip or any NUL-containing blob was never scanned. We do not run the
  // full text scan (email/assignment classes flood on binary noise), but we DO
  // look for the high-signal KEY/PEM shapes, which have negligible false-positive
  // risk. Images are excluded — their pixels are handled by TREE-mode allowlist.
  if (BIN_SKIP_RE.test(rel) || buf.includes(0)) {
    // FEAT-130 r3: scanBinary (not scanKeyShapes) so the assignment /
    // connection-string classes are scanned too — round-2 verifier HIGH: a
    // staged `apikey=<body>` + one trailing NUL downgraded the WHOLE blob to
    // KEY/PEM-only and slipped. Email is still excluded (floods on binary noise).
    for (const { token, match } of scanBinary(buf.toString('latin1'))) {
      hits++;
      perFile.set(rel, (perFile.get(rel) ?? 0) + 1);
      emitHit(`${rel}:0: [${token}] embedded in binary/skipped file: ${String(match).slice(0, 80)}`);
    }
    continue;
  }
  const lines = buf.toString('utf8').split('\n');
  lines.forEach((line, i) => {
    for (const { token } of scanLine(line)) {
      const allowed = allowedHitFor(rel, token, line);
      if (allowed) {
        allowedHits.push(`${rel}:${i + 1}: [${token}] ALLOWED — ${allowed.why}`);
        continue;
      }
      hits++;
      perFile.set(rel, (perFile.get(rel) ?? 0) + 1);
      emitHit(`${rel}:${i + 1}: [${token}] ${line.trim().slice(0, 160)}`);
    }
  });
}

// FEAT-130 — scan the commit itself: the message and the committer identity.
// These carry the SAME token set as file content (a personal email in a commit
// message, or a personal address as `git config user.email`, is just as public
// once pushed). Fail-closed: if the identity cannot be read, that is a refusal.
if (COMMIT_MSG_PATH) {
  let msg = '';
  try { msg = fs.readFileSync(path.resolve(COMMIT_MSG_PATH), 'utf8'); }
  catch (e) {
    console.error(`LEAK GATE: ABORT — cannot read commit-msg file '${COMMIT_MSG_PATH}': ${e.message}`);
    process.exit(2);
  }
  msg.split('\n').forEach((line, i) => {
    for (const { token } of scanLine(line)) {
      hits++;
      perFile.set('COMMIT_MSG', (perFile.get('COMMIT_MSG') ?? 0) + 1);
      emitHit(`COMMIT_MSG:${i + 1}: [${token}] ${line.trim().slice(0, 160)}`);
    }
  });
}
if (SCAN_IDENTITY) {
  let name = '';
  let email = '';
  try {
    name = execFileSync('git', ['config', 'user.name'], { cwd: scanRoot, encoding: 'utf8' }).trim();
  } catch { /* unset name is allowed; email is what matters */ }
  try {
    email = execFileSync('git', ['config', 'user.email'], { cwd: scanRoot, encoding: 'utf8' }).trim();
  } catch {
    console.error('LEAK GATE: ABORT — committer email is unset; refusing to commit without a verifiable identity.');
    process.exit(2);
  }
  for (const { token, match } of scanIdentity(name, email)) {
    hits++;
    perFile.set('IDENTITY', (perFile.get('IDENTITY') ?? 0) + 1);
    emitHit(`IDENTITY: [${token}] ${String(match).slice(0, 160)}`);
  }
}

const mode = TREE_MODE ? `TREE ${scanRoot}` : STAGED ? 'REPO (staged index)' : 'REPO (git-tracked)';
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
