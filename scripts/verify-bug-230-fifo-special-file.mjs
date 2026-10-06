#!/usr/bin/env node
/**
 * BUG-230 r2 (cross-provider openai clean-room, run 01a10ddf): `ensureGitShim`'s
 * `intact()` did `fs.readFileSync(shimPath,'utf8')` with no file-type guard. When
 * the shim `git` path is a FIFO (or socket), opening it O_RDONLY blocks until a
 * writer appears, so `ensure()` HANGS forever — a third outcome the fail-closed
 * contract ("restore, or refuse ok:false") forbids.
 *
 * This suite drives ensure() against a FIFO and a unix socket planted at the shim
 * path, each INSIDE A WATCHDOG, and asserts ensure() RETURNS (never hangs) and the
 * shim ends as a real executable regular file whose bytes equal the installed
 * source. It also runs the SAME scenarios against a pre-change COPY of the module
 * (the lstat guard stripped) to prove the must-FAIL: those time out.
 *
 * No git is ever invoked; no real repo touched. Scratch dirs under os.tmpdir().
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_MODULE = path.join(HERE, 'lib', 'git-shim.mjs');
const WATCHDOG_MS = 4000;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log(`  FAIL: ${msg}`); } };

/**
 * Run ensure() against `modulePath` after mutating the shim `git` into a special
 * file of `kind` ('fifo' | 'socket'), in a CHILD process guarded by a hard
 * timeout. Returns { timedOut, result } — result is the ensure() return (or null).
 */
function runEnsureWithSpecialFile(modulePath, kind) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bug230-fifo-driver-'));
  const outFile = path.join(work, 'out.json');
  const driver = path.join(work, 'driver.mjs');
  fs.writeFileSync(driver, `
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installGitShim } from ${JSON.stringify(modulePath)};

const h = installGitShim(process.env, { baseDir: os.tmpdir() });
const shimPath = path.join(h.shimDir, 'git');
fs.rmSync(shimPath, { force: true });
let srv = null;
if (${JSON.stringify(kind)} === 'fifo') {
  const r = spawnSync('mkfifo', ['-m', '755', shimPath]);
  if (r.status !== 0) { fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ skip: 'mkfifo unavailable' })); process.exit(0); }
} else {
  srv = net.createServer();
  await new Promise((res) => srv.listen(shimPath, res));
  fs.chmodSync(shimPath, 0o755);
}
const result = h.ensure();
const st = fs.lstatSync(shimPath);
const bytes = st.isFile() ? fs.readFileSync(shimPath, 'utf8') : null;
if (srv) srv.close();
fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({
  result,
  isFile: st.isFile(),
  execBit: !!(st.mode & 0o100),
  bytesStartShebang: typeof bytes === 'string' && bytes.startsWith('#!/usr/bin/env node'),
}));
`);
  const r = spawnSync(process.execPath, [driver], { timeout: WATCHDOG_MS, encoding: 'utf8' });
  const timedOut = r.error && (r.error.code === 'ETIMEDOUT' || r.signal === 'SIGTERM');
  let result = null;
  try { result = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch { /* none written → hung */ }
  try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
  return { timedOut: !!timedOut, out: result };
}

/** A pre-change copy of git-shim.mjs with the lstat type-guard removed. */
function preChangeCopy() {
  const src = fs.readFileSync(REAL_MODULE, 'utf8');
  const stripped = src.replace(
    /\s*\/\/ BUG-230 r2 — lstat BEFORE[\s\S]*?if \(!fs\.lstatSync\(shimPath\)\.isFile\(\)\) return false;\n/,
    '\n',
  );
  if (stripped === src) throw new Error('could not strip the lstat guard — pre-change copy not built');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug230-prechange-'));
  const p = path.join(dir, 'git-shim.mjs');
  // the module imports siblings by relative path; copy the lib/ dir and overwrite.
  const libDir = path.join(dir, 'lib');
  fs.mkdirSync(libDir);
  for (const f of fs.readdirSync(path.join(HERE, 'lib'))) {
    fs.copyFileSync(path.join(HERE, 'lib', f), path.join(libDir, f));
  }
  fs.writeFileSync(path.join(libDir, 'git-shim.mjs'), stripped);
  return path.join(libDir, 'git-shim.mjs');
}

console.log('BUG-230 — FIFO/socket shim path must not hang ensure()');

// ── must-FAIL proof ───────────────────────────────────────────────────────────
// A FIFO is the genuine hang vector: open() O_RDONLY blocks until a writer appears,
// so pre-change readFileSync(shimPath) never returns → ensure() hangs. A unix
// SOCKET does NOT hang pre-change (open() returns ENXIO, which throws and falls to
// restore); it is accidentally-safe there, not deterministically. The structural
// lstat guard makes BOTH deterministic, but only the FIFO proves the live hang.
const preModule = preChangeCopy();
{
  const { timedOut, out } = runEnsureWithSpecialFile(preModule, 'fifo');
  if (out && out.skip) { console.log(`  (skip pre-change fifo: ${out.skip})`); }
  else ok(timedOut, `PRE-CHANGE must hang on a FIFO (must-FAIL proof); got ${JSON.stringify(out)}`);
}
{
  const { timedOut, out } = runEnsureWithSpecialFile(preModule, 'socket');
  ok(!timedOut, `PRE-CHANGE socket errors (ENXIO) rather than hanging — documents the asymmetry; got ${JSON.stringify(out)}`);
}

// ── fixed code: ensure() RETURNS and restores a real executable shim ──────────
for (const kind of ['fifo', 'socket']) {
  const { timedOut, out } = runEnsureWithSpecialFile(REAL_MODULE, kind);
  if (out && out.skip) { console.log(`  (skip ${kind}: ${out.skip})`); continue; }
  ok(!timedOut, `FIXED must NOT hang on a ${kind}`);
  ok(out && out.result && out.result.ok === true, `FIXED ${kind}: ensure() ok:true (restored); got ${JSON.stringify(out && out.result)}`);
  ok(out && out.result && out.result.restored === true, `FIXED ${kind}: restored:true`);
  ok(out && out.isFile, `FIXED ${kind}: shim path is a regular file afterwards`);
  ok(out && out.execBit, `FIXED ${kind}: restored shim is executable`);
  ok(out && out.bytesStartShebang, `FIXED ${kind}: restored shim has the shim source`);
}

try { fs.rmSync(path.dirname(path.dirname(preModule)), { recursive: true, force: true }); } catch {}

console.log(`\n${fail === 0 ? 'OK' : 'FAIL'} — ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
