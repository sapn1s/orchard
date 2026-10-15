#!/usr/bin/env node
/**
 * check-unicode-separators.mjs — fail if any tracked TEXT source file contains a
 * raw U+2028 (LINE SEPARATOR) or U+2029 (PARAGRAPH SEPARATOR) character (BUG-260).
 *
 *   npm run check:unicode-seps   # or wired into `npm run gate`
 *
 * WHY THIS EXISTS — U+2028/U+2029 are valid JS whitespace almost everywhere (they
 * are legal, often invisible, inside string/template literals and as ordinary
 * source whitespace), so pasting one causes no complaint from an editor and no
 * diff review catches it by eye. But a regex LITERAL cannot contain a raw
 * LineTerminator (which these two code points are, per the ECMAScript grammar):
 * V8 treats the character as ending the regex body early and throws
 * `SyntaxError: Invalid regular expression: missing /` — a hard crash at parse
 * time, before any of the surrounding code (including try/catch) ever runs.
 *
 * This happened for real: src/server/board.ts:1833 pasted literal U+2028/U+2029
 * bytes inside a `.replace(/[\r\n<raw>]+/g, ...)` character class (FEAT-184 r2
 * work), which broke board.ts and everything that statically imports it
 * (tickets.ts, scripts/board-tool.mjs's file/verified/decide verbs) for every
 * caller, with no caller-input dependence — see BUG-260.
 *
 * SCOPE — this gate flags a raw U+2028/U+2029 ANYWHERE in a tracked text file,
 * not only inside regex literals: distinguishing "inside a regex literal" from
 * "inside a string/template literal, where it is legal" requires a real
 * tokenizer, and the actual defect is the PASTE itself — a raw copy of these
 * invisible characters into source is never intentional, legal uses write the
 * escape (`\u2028` / `\u2029`) instead, same convention as check-nul.mjs's
 * `\x00` rule for raw NUL. Legitimate fixture files that intentionally exercise
 * these characters as DATA (e.g. a test corpus of "look like a line break but
 * are not" characters) are allowlisted by path below, same pattern as
 * check-nul.mjs's KNOWN_NUL_ALLOW.
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

/** Legitimate binary asset extensions — never text-searched for source. */
const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'ico', 'webp', 'bmp', 'tif', 'tiff', 'avif', 'heic',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar',
  'mp3', 'mp4', 'mov', 'avi', 'webm', 'ogg', 'oga', 'wav', 'flac', 'm4a',
  'wasm', 'node', 'so', 'dylib', 'dll', 'exe', 'bin', 'o', 'a', 'class', 'jar',
  'pack', 'idx', 'keystore', 'jks', 'p12', 'der', 'crt', 'db', 'sqlite',
]);

/** Pre-existing files that deliberately contain raw U+2028/U+2029 as DATA inside
 *  string literals (test fixtures exercising "looks like a line break but is
 *  not" characters), not inside a regex literal — legal, reviewed, allowlisted
 *  with a reason, and printed as a WARNING every run so it stays visible. */
const KNOWN_SEP_ALLOW = new Map([
  ['scripts/lib/feat-091-fold-corpus.mjs', 'CommonMark fold-corpus fixture: U+2028/U+2029 as corpus DATA inside a string-literal array, not a regex literal (BUG-260 sweep)'],
  ['scripts/verify-bug-236-code-value-precision.mjs', 'invisible-character fixture: U+2028/U+2029 as test DATA inside string-literal pad() calls, not a regex literal (BUG-260 sweep)'],
  // A ticket-log PROSE instance, not code: BUG-257's own log describes this exact
  // BUG-260 defect ("escape to `\u2028\u2029`") and the literal escape text was
  // itself pasted as the raw character while being typed, same failure mode this
  // guard exists to catch. docs/bugs' Activity log is APPEND-ONLY — this lane may
  // not edit a prior entry it does not own — so this is DEFERRED, not fixed, same
  // as check-nul.mjs's KNOWN_NUL_ALLOW convention: allowlisting does not make the
  // raw character safe, it only keeps the gate green while the owning lane fixes
  // it. Discovered during BUG-260's gate-wiring (adding untracked files to this
  // guard's scan, since BUG-260 itself started as uncommitted work).
  ['docs/bugs/BUG-257-answering-a-decision-card-did-not-start-the-work.md', 'ticket-log prose describing the BUG-260 defect, itself hit by the same raw-paste failure mode; append-only, deferred to BUG-257\'s own lane (BUG-260 sweep)'],
]);

function extOf(rel) {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function lineOfIndex(text, idx) {
  let line = 1;
  for (let i = 0; i < idx; i++) if (text[i] === '\n') line++;
  return line;
}

// BOTH tracked AND untracked-but-not-ignored files (`--others --exclude-standard`),
// not tracked-only. BUG-260 itself was in an UNCOMMITTED working-tree file (agents
// here never commit; docs/bugs/ tickets routinely sit uncommitted for a long
// time) — a guard that only sees `git ls-files`' tracked set would have missed
// the exact file that caused this bug, and in fact missed this very ticket's own
// Activity log entry the first time this guard was run against the real tree.
const list = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
  cwd: REPO, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024,
});
if (list.status !== 0) {
  console.error('check-unicode-separators: `git ls-files` failed — not a git repo?');
  process.exit(2);
}
const files = [...new Set(list.stdout.toString('utf8').split('\0').filter(Boolean))];

const SEP_RE = /[\u2028\u2029]/;

const failures = [];
const warnings = [];
for (const rel of files) {
  if (BINARY_EXT.has(extOf(rel))) continue;
  const abs = path.join(REPO, rel);
  let text;
  try {
    const st = fs.lstatSync(abs);
    if (!st.isFile()) continue;
    text = fs.readFileSync(abs, 'utf8');
  } catch { continue; }
  const m = SEP_RE.exec(text);
  if (!m) continue;
  const cp = text.codePointAt(m.index) === 0x2028 ? 'U+2028 LINE SEPARATOR' : 'U+2029 PARAGRAPH SEPARATOR';
  const line = lineOfIndex(text, m.index);
  if (KNOWN_SEP_ALLOW.has(rel)) {
    warnings.push({ rel, line, cp, reason: KNOWN_SEP_ALLOW.get(rel) });
    continue;
  }
  failures.push({ rel, line, cp });
}

console.log('=== check-unicode-separators — no raw U+2028/U+2029 in tracked source files (BUG-260) ===');
console.log(`  scanned ${files.length} tracked files`);

for (const w of warnings) {
  console.log(`  WARN  ${w.rel}:${w.line} — raw ${w.cp}; allowlisted: ${w.reason}`);
}

if (failures.length) {
  console.log('');
  for (const f of failures) {
    console.log(`  FAIL  ${f.rel}:${f.line} — raw ${f.cp}`);
  }
  console.log('');
  console.log('CONSEQUENCE: these characters are legal, often-invisible JS whitespace almost');
  console.log('everywhere, so an editor and a diff review will not flag the paste — but inside a');
  console.log('regex LITERAL they are an unescaped LineTerminator, which V8 treats as ending the');
  console.log('literal early: `SyntaxError: Invalid regular expression: missing /`, a hard crash');
  console.log('at parse time that breaks every static importer, unconditionally (BUG-260).');
  console.log('');
  console.log('FIX: replace the raw character with its escape (`\\u2028` / `\\u2029`). If the file');
  console.log('is a fixture that legitimately needs the raw character as DATA inside a string/');
  console.log('template literal (not a regex literal), allowlist its path in KNOWN_SEP_ALLOW in');
  console.log('scripts/check-unicode-separators.mjs with a reason.');
  console.log(`\nCHECK-UNICODE-SEPARATORS: FAIL — ${failures.length} tracked file(s) contain a raw U+2028/U+2029. (exit 1)`);
  process.exit(1);
}

console.log(`\nCHECK-UNICODE-SEPARATORS: PASS — no unexpected raw U+2028/U+2029.${warnings.length ? ` (${warnings.length} allowlisted; see WARN above)` : ''} (exit 0)`);
process.exit(0);
