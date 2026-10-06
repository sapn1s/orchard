#!/usr/bin/env node
/**
 * check-nul.mjs — fail if any tracked TEXT file contains a raw NUL byte (BUG-103).
 *
 *   npm run check:nul      # or wired into `npm run gate`
 *
 * WHY THIS EXISTS — the failure mode is INVISIBLE by construction. A single raw
 * NUL byte anywhere in a source file flips it to "binary" for content classifiers.
 * The Bash tool's `grep` is a `ugrep -I` shim ("skip binary files"): on a
 * NUL-containing file it SKIPS THE FILE ENTIRELY and prints NOTHING, exiting
 * cleanly with no "Binary file matches" line and no warning to stderr. A search
 * over that file then returns an EMPTY result that is indistinguishable from a
 * genuine "no matches" — a CONFIDENT FALSE NEGATIVE.
 *
 * This already cost a real investigation: one NUL in `src/server/agent-bridge.ts`
 * (offset 153630, inside a `/<NUL>/g` regex literal) hid the `parent_tool_use_id`
 * linkage — an investigation grepped it, got nothing, concluded "there is no
 * parentage linkage in src/server/," and THREE fixes were built on that false
 * premise (BUG-103 / ARCH-003). `/usr/bin/grep -a` and `rg` read the file fine;
 * only the silent shim lied. Without a guard the next stray NUL costs the same.
 *
 * SCOPE — genuinely binary tracked assets (images, fonts, archives, …) legitimately
 * contain NULs and are never text-searched for source; those are exempted by
 * extension (BINARY_EXT). Every other tracked file is checked. Two pre-existing
 * NUL-bearing TEXT files that live outside the BUG-103 lane are allowlisted by
 * path (KNOWN_NUL_ALLOW) so this gate can go green today without editing another
 * lane's files — an allowlist entry DEFERS the fix, it does not make the NUL safe;
 * each is reported as a WARNING on every run so it cannot be forgotten.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function repoRoot() {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : ROOT;
}
const REPO = repoRoot();

/** Legitimate binary asset extensions — a NUL is expected and searching them for
 *  source text is meaningless. Add to this set if a repo tracks another binary
 *  format (a font, an archive, a compiled artifact). */
const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'ico', 'webp', 'bmp', 'tif', 'tiff', 'avif', 'heic',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar',
  'mp3', 'mp4', 'mov', 'avi', 'webm', 'ogg', 'oga', 'wav', 'flac', 'm4a',
  'wasm', 'node', 'so', 'dylib', 'dll', 'exe', 'bin', 'o', 'a', 'class', 'jar',
  'pack', 'idx', 'keystore', 'jks', 'p12', 'der', 'crt', 'db', 'sqlite',
]);

/** Pre-existing NUL-bearing TEXT files OUTSIDE the BUG-103 lane, allowlisted with a
 *  reason. Adding a path here does NOT make its NUL safe — it just keeps the gate
 *  green while the owning lane fixes it. Each is printed as a WARNING every run. */
const KNOWN_NUL_ALLOW = new Map([
  // Emptied by FEAT-049 (second pass). The one entry — a deliberate raw NUL in
  // verify-arch-watch.mjs's corrupt-board fixture — was rewritten as a `\0`
  // escape, which produces identical bytes at runtime and makes the source file
  // plain text again. It mattered more than "unsearchable": the LEAK GATE skips
  // any file whose bytes contain a NUL, so that script was the one tracked text
  // file heading for the public mirror that no privacy scan ever read.
]);

function extOf(rel) {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function lineOfOffset(buf, off) {
  let line = 1;
  for (let i = 0; i < off; i++) if (buf[i] === 0x0a) line++;
  return line;
}

const list = spawnSync('git', ['ls-files', '-z'], {
  cwd: REPO, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024,
});
if (list.status !== 0) {
  console.error('check-nul: `git ls-files` failed — not a git repo?');
  process.exit(2);
}
const files = list.stdout.toString('utf8').split('\0').filter(Boolean);

const failures = [];
const warnings = [];
for (const rel of files) {
  if (BINARY_EXT.has(extOf(rel))) continue; // legitimate binary asset
  const abs = path.join(REPO, rel);
  let buf;
  try {
    const st = fs.lstatSync(abs);
    if (!st.isFile()) continue; // submodule / symlink / gone
    buf = fs.readFileSync(abs);
  } catch { continue; }
  const off = buf.indexOf(0);
  if (off === -1) continue;
  if (KNOWN_NUL_ALLOW.has(rel)) {
    warnings.push({ rel, off, line: lineOfOffset(buf, off), reason: KNOWN_NUL_ALLOW.get(rel) });
    continue;
  }
  failures.push({ rel, off, line: lineOfOffset(buf, off) });
}

console.log('=== check-nul — no raw NUL bytes in tracked text files (BUG-103) ===');
console.log(`  scanned ${files.length} tracked files`);

for (const w of warnings) {
  console.log(`  WARN  ${w.rel} — NUL at byte ${w.off} (line ${w.line}); allowlisted: ${w.reason}`);
}

if (failures.length) {
  console.log('');
  for (const f of failures) {
    console.log(`  FAIL  ${f.rel} — raw NUL byte at offset ${f.off} (line ${f.line})`);
  }
  console.log('');
  console.log('CONSEQUENCE: the Bash tool\'s `grep` (a `ugrep -I` shim) classifies any file');
  console.log('containing a NUL as "binary" and SKIPS IT SILENTLY — it prints NOTHING and exits');
  console.log('cleanly, with no warning. A search over the file above therefore returns an EMPTY');
  console.log('result INDISTINGUISHABLE from "no matches" — a confident false negative. (This is');
  console.log('exactly what hid parent_tool_use_id in agent-bridge.ts and drove three failed');
  console.log('fixes; BUG-103.) `/usr/bin/grep -a` and `rg` are unaffected — only the shim lies.');
  console.log('');
  console.log('FIX: remove the NUL. In a regex, write it as an escape (`/\\x00/g`), never a raw');
  console.log('literal NUL. If the file is genuinely a binary asset, add its extension to');
  console.log('BINARY_EXT in scripts/check-nul.mjs so it is exempted for the right reason.');
  console.log(`\nCHECK-NUL: FAIL — ${failures.length} tracked text file(s) contain a NUL. (exit 1)`);
  process.exit(1);
}

console.log(`\nCHECK-NUL: PASS — no unexpected NUL bytes in tracked text files.${warnings.length ? ` (${warnings.length} allowlisted; see WARN above)` : ''} (exit 0)`);
process.exit(0);
