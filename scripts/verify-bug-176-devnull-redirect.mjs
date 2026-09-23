/**
 * verify-bug-176-devnull-redirect.mjs — BUG-176.
 *
 * FEAT-129's file-lock hook refused READ-ONLY Bash commands purely because they
 * carried a redirect to `/dev/null` (`ls 2>/dev/null`, `head … 2>/dev/null`),
 * claiming the redirect would drop another lane's work. A `/dev/null` (or other
 * std-stream / char-device) target destroys nobody's work and must never lock.
 *
 * Graded, both directions, on the REAL module + a REAL scratch lock dir:
 *   1. must-FAIL→PASS: a read-only command with `2>/dev/null` is ALLOWED.
 *   2. NON-REGRESSION (matters most): a redirect to a REAL file another live lane
 *      holds is still REFUSED — the protection is intact.
 *   3. adversarial: `> /dev/null`, `2>/dev/null`, `&>/dev/null`, `2>&1`, and a
 *      regular file whose path CONTAINS `/dev/null` (still locked).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateFileLock, scanBashMutation } from './lib/file-lock.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug176-locks-'));
const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bug176-repo-'));
const evalBash = (command, owner) => evaluateFileLock({ toolName: 'Bash', toolInput: { command }, lockDir, repoRoot, owner, ownerPid: process.pid });

// ── 1. The reported bug: read-only commands with a /dev/null redirect ─────────
for (const cmd of ['ls 2>/dev/null', 'head -5 README.md 2>/dev/null', 'grep -r foo src 2>/dev/null']) {
  const r = evalBash(cmd, 'laneA');
  ok(`read-only + 2>/dev/null ALLOWED :: ${cmd}`, r.allow === true, JSON.stringify({ allow: r.allow, busy: r.busy }));
}

// ── 2. NON-REGRESSION — a redirect to a REAL file a live foreign lane holds is REFUSED
{
  const target = 'src/shared.ts';
  // laneHolder claims the file first (a plain Write claim).
  const claim = evaluateFileLock({ toolName: 'Write', toolInput: { file_path: path.join(repoRoot, target) }, lockDir, repoRoot, owner: 'laneHolder', ownerPid: process.pid });
  ok('non-regression setup: holder claims src/shared.ts', claim.allow === true);
  // laneB tries to CLOBBER it with a truncating redirect (real file, not /dev/null).
  const rB = evalBash(`node gen.mjs > ${target}`, 'laneB');
  ok('non-regression: redirect to a HELD real file is REFUSED (busy, names holder)',
    rB.allow === false && rB.busy === true && rB.holder && rB.holder.owner === 'laneHolder',
    JSON.stringify({ allow: rB.allow, holder: rB.holder && rB.holder.owner }));
  // And the same command with 2>/dev/null tacked on must STILL be refused for shared.ts.
  const rB2 = evalBash(`node gen.mjs > ${target} 2>/dev/null`, 'laneB');
  ok('non-regression: real-file clobber still REFUSED even with 2>/dev/null present',
    rB2.allow === false && rB2.busy === true, JSON.stringify({ allow: rB2.allow }));
}

// ── 3. Adversarial redirect spellings (classifier-level, no lock state needed) ─
const mut = (c) => !!scanBashMutation(c).mutates;
ok('> /dev/null                     → not a mutation', mut('cmd > /dev/null') === false);
ok('2>/dev/null                     → not a mutation', mut('cmd 2>/dev/null') === false);
ok('&>/dev/null                     → not a mutation', mut('cmd &>/dev/null') === false);
ok('2>&1 (dup, not a file)          → not a mutation', mut('cmd 2>&1') === false);
ok('1>/dev/stdout 2>/dev/stderr     → not a mutation', mut('cmd 1>/dev/stdout 2>/dev/stderr') === false);
ok('/dev//null (normalized)         → not a mutation', mut('cmd >/dev//null') === false);
// The trap: a REGULAR file whose path merely CONTAINS the substring /dev/null MUST stay locked.
ok('./tmp/dev/null-notes.txt (regular file, substring) → STILL a mutation', mut('echo x > ./tmp/dev/null-notes.txt') === true);
ok('/dev/null-notes.txt (regular file, substring)      → STILL a mutation', mut('echo x > /dev/null-notes.txt') === true);
// A real file still locked even when a /dev/null redirect coexists in the same command.
{
  const r = scanBashMutation('node gen.mjs > real.txt 2>/dev/null');
  ok('real.txt still captured while /dev/null dropped', r.mutates === true && r.paths.length === 1 && r.paths[0] === 'real.txt', JSON.stringify(r));
}

try { fs.rmSync(lockDir, { recursive: true, force: true }); fs.rmSync(repoRoot, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
