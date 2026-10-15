#!/usr/bin/env node
/**
 * BUG-254 r7 — P3: the SHIPPED re-login credential write must be ATOMIC against a concurrent reader.
 *
 * No docker. A pure-filesystem race: a child process reads a credential file in a tight loop while
 * this process rewrites it. The crux of the r7 P3 decision is that CLI 2.1.296 reloads its credential
 * cache ONLY on an mtime change, so a torn read cached against the write's FINAL mtime has no further
 * trigger to reload — it strands the running CLI. The fix must therefore make a torn read IMPOSSIBLE,
 * not merely rare.
 *
 *   SHIPPED  login.applyCredentialReplace (write a sibling temp + fsync + rename over the target):
 *            a reader sees the whole OLD or the whole NEW file — 0 torn, 0 parse failures.
 *   BASELINE the REMOVED r4 same-inode in-place write (open r+, write-from-0, ftruncate): a ~1 KB
 *            write is NOT atomic against a reader — it tears. This is the must-FAIL baseline that
 *            justifies the atomic replace (reverted inline here; NOT git-show of a moving ref).
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..');
const login = await import(path.join(REPO, 'src/server/claude-login.ts'));

let pass = 0, fail = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; failures.push(name); console.log(`FAIL  ${name}: ${e.message}`); }
}
const show = (label, v) => console.log(`      ${label}: ${JSON.stringify(v)}`);

const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug254-atom-'));
const dest = path.join(tdir, '.credentials.json');
const srcDir = path.join(tdir, 'src');
fs.mkdirSync(srcDir);

// Two self-describing docs: `fill` is ALL one letter, so any A+B byte-mix (a torn read) is detectable
// even when the two are the same length and the mix still parses as JSON.
const docOf = (letter, n) => `${JSON.stringify({ doc: letter, fill: letter.repeat(n) })}\n`;
const DA = docOf('A', 1100), DB = docOf('B', 1100);

const readerSrc = `
import * as fs from 'node:fs';
const F = process.argv[2], N = Number(process.argv[3]);
let torn = 0, parseFail = 0, reads = 0;
for (let i = 0; i < N; i++) {
  let buf; try { buf = fs.readFileSync(F); } catch { continue; }
  reads++; if (buf.length === 0) { torn++; continue; }
  let o; try { o = JSON.parse(buf.toString('utf8')); } catch { parseFail++; continue; }
  if ((o.doc !== 'A' && o.doc !== 'B') || typeof o.fill !== 'string' || o.fill.length === 0 || o.fill.split('').some((c) => c !== o.doc)) torn++;
}
process.stdout.write(JSON.stringify({ reads, torn, parseFail }));
`;
const readerFile = path.join(tdir, 'torn-reader.mjs');
fs.writeFileSync(readerFile, readerSrc);

// the REMOVED r4 primitive, reproduced inline as the must-FAIL baseline
function inPlace(content) {
  const fd = fs.openSync(dest, 'r+');
  try { fs.writeSync(fd, content, 0, content.length, 0); fs.ftruncateSync(fd, content.length); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

async function race(writeOne, iters) {
  fs.writeFileSync(dest, DA, { mode: 0o600 });
  const reader = spawn(process.execPath, [readerFile, dest, '400000'], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  reader.stdout.on('data', (d) => { out += d; });
  const done = new Promise((r) => reader.on('close', r));
  for (let i = 0; i < iters; i++) writeOne(Buffer.from(i % 2 === 0 ? DB : DA));
  await done;
  return JSON.parse(out || '{"reads":0,"torn":0,"parseFail":0}');
}

try {
  const atomic = await race((content) => {
    fs.writeFileSync(path.join(srcDir, '.credentials.json'), content, { mode: 0o600 });
    login.applyCredentialReplace(srcDir, tdir); // the SHIPPED path
  }, 40000);
  show('SHIPPED atomic replace', atomic);
  check('SHIPPED applyCredentialReplace: a concurrent reader NEVER sees a torn/partial credential', () => {
    assert.ok(atomic.reads > 1000, `the reader ran (${atomic.reads} reads)`);
    assert.equal(atomic.torn, 0, `torn reads must be 0; got ${atomic.torn}`);
    assert.equal(atomic.parseFail, 0, `parse failures must be 0; got ${atomic.parseFail}`);
  });

  const torn = await race((content) => inPlace(content), 40000);
  show('BASELINE in-place (removed r4 path)', torn);
  check('MUST-FAIL BASELINE: the removed in-place write-then-ftruncate DOES tear', () => {
    assert.ok(torn.torn + torn.parseFail > 0, `the in-place write must produce >=1 torn/partial read; got ${JSON.stringify(torn)}`);
  });
} finally {
  fs.rmSync(tdir, { recursive: true, force: true });
}

console.log(`\nRESULT ${pass} PASS / ${fail} FAIL${failures.length ? `\n  failed: ${failures.join(' | ')}` : ''}`);
process.exit(fail ? 1 : 0);
