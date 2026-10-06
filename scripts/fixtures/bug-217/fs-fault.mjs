/**
 * BUG-217 round 6 — disk-fault injection for the server outbox's WRITE path.
 *
 * Wraps every node:fs call that changes a file (mkdir, open, write, fsync,
 * ftruncate, close, rename, copy, unlink) and counts the ones aimed at
 * `$CLAUDE_STATION_DATA/outbox` (by path, or by an fd opened on such a path).
 * Reads are never faulted. `syncBuiltinESMExports()` makes the wrappers visible
 * to `import * as fs from 'node:fs'` in the module under test.
 *
 * Two ways to drive it:
 *  - in-process: `import { fault } from '.../fs-fault.mjs'` and
 *      fault.record()                 — count + trace the outbox ops, fail none
 *      fault.arm({ at, code, mode })  — fail the `at`-th outbox op from now:
 *          mode 'once'   that op only;
 *          mode 'sticky' that op and every outbox op after it (a dying disk);
 *          mode 'shortdie' the disk dies mid-write: a write stores half its
 *                        bytes, and every op after it fails (the rollback too);
 *          mode 'after'  the op takes effect, THEN reports the error;
 *          mode 'short'  the disk fills at that op: a write stores HALF its
 *                        bytes and reports it (a short write), any other op
 *                        still works, and every later write fails ENOSPC
 *                        (truncate/rename/close still work);
 *      fault.disarm()                 — the disk is healthy again; returns the trace
 *  - as a preload (`NODE_OPTIONS=--import=<this file>`) for a real server:
 *      B217_FAULT_MARKER=<file> whose JSON is { op, suffix, code } — the next
 *      outbox `op` whose target ends with `suffix` fails once, and the marker is
 *      removed (the round-5 clean-room attack: ENOSPC on the `.head` rename).
 */
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const orig = {};
const wrapped = {};
const WRITES = new Set(['writeSync', 'writeFileSync', 'appendFileSync']);
const fds = new Set();
const st = { on: false, at: 0, code: 'ENOSPC', mode: 'once', n: 0, fired: false, full: null, trace: [] };

function scopeRoot() {
  const d = process.env.CLAUDE_STATION_DATA;
  return d && d.trim() ? path.join(path.resolve(d), 'outbox') : null;
}
function inScope(p) {
  if (typeof p !== 'string' && !(p instanceof URL) && !Buffer.isBuffer(p)) return false;
  const r = scopeRoot();
  if (!r) return false;
  const s = unproc(path.resolve(String(p instanceof URL ? p.pathname : p)));
  return s === r || s.startsWith(r + path.sep);
}
/**
 * Round 9: the server writes its outbox THROUGH the data dir it holds locked, `/proc/self/fd/<n>/outbox/…`, so the
 * writes follow the directory it owns even if the dir is moved. Such a path is the dir the fd names.
 */
function unproc(s) {
  const m = /^\/proc\/self\/fd\/(\d+)(\/.*)?$/.exec(s);
  if (!m) return s;
  try { return fs.readlinkSync(`/proc/self/fd/${m[1]}`) + (m[2] ?? ''); } catch { return s; }
}
function mkErr(code, op, target) {
  const e = new Error(`${code}: ${code === 'ENOSPC' ? 'no space left on device' : 'i/o error'} (injected), ${op.replace(/Sync$/, '')} '${target}'`);
  e.code = code; e.errno = code === 'ENOSPC' ? -28 : -5; e.syscall = op.replace(/Sync$/, '');
  return e;
}
function markerFault(op, target) {
  const m = process.env.B217_FAULT_MARKER;
  if (!m || !orig.existsSync(m)) return null;
  let spec = null;
  try { spec = JSON.parse(orig.readFileSync(m, 'utf8')); } catch { return null; }
  if (spec.op !== op || !String(target).endsWith(spec.suffix ?? '')) return null;
  try { orig.unlinkSync(m); } catch { /* raced */ }
  console.error(`[b217-fault] injected ${spec.code ?? 'ENOSPC'} on ${op} ${target}`);
  return { code: spec.code ?? 'ENOSPC', short: false };
}
/** Decide the fate of one in-scope op: null = let it through. */
function decide(op, target) {
  if (!active) return null;
  st.n++;
  st.trace.push(`${op} ${path.basename(String(target))}`);
  const mk = markerFault(op, target);
  if (mk) return mk;
  if (st.full === 'all') return { code: st.code, short: false };
  if (st.full === 'writes') return WRITES.has(op) ? { code: 'ENOSPC', short: false } : null;
  if (!st.on || st.fired || st.n !== st.at) return null;
  st.fired = true;
  if (st.mode === 'sticky') st.full = 'all';
  // The disk dies mid-write: half the bytes land, and every op after it fails — the rollback too.
  if (st.mode === 'shortdie') { st.full = 'all'; return { code: st.code, short: WRITES.has(op) }; }
  // The op took effect, and then reported an error anyway.
  if (st.mode === 'after') return { code: st.code, short: false, after: true };
  if (st.mode === 'short') {
    // The disk fills AT this op: a write stores half its bytes; any other op still works; every later write fails.
    st.full = 'writes';
    return WRITES.has(op) ? { code: 'ENOSPC', short: true } : null;
  }
  return { code: st.code, short: false };
}
const fdTarget = (fd) => `fd:${fd}`;

function wrapPath(name, argIdx) {
  orig[name] = fs[name];
  fs[name] = function (...a) {
    const t = a[argIdx];
    if (inScope(t)) { const f = decide(name, t); if (f) { if (f.after) orig[name].apply(this, a); throw mkErr(f.code, name, t); } }
    return orig[name].apply(this, a);
  };
}
function wrapFd(name) {
  orig[name] = fs[name];
  fs[name] = function (...a) {
    const fd = a[0];
    if (typeof fd === 'number' && fds.has(fd)) {
      const f = decide(name, fdTarget(fd));
      if (name === 'closeSync') fds.delete(fd);
      if (f) {
        if (name === 'closeSync') orig.closeSync(fd); // the fd is gone either way; the error is what the caller sees
        else if (f.after) orig[name].apply(this, a);
        throw mkErr(f.code, name, fdTarget(fd));
      }
    }
    return orig[name].apply(this, a);
  };
}

let active = false;
export function install() {
  if (active) return;
  active = true;
  if (orig.openSync) { for (const [k, v] of Object.entries(wrapped)) fs[k] = v; syncBuiltinESMExports(); return; }
  orig.existsSync = fs.existsSync;
  orig.readFileSync = fs.readFileSync;
  orig.unlinkSync = fs.unlinkSync;
  // open: counted, and an fd opened on an outbox path is tracked for the fd ops.
  orig.openSync = fs.openSync;
  fs.openSync = function (p, ...rest) {
    const scoped = inScope(p);
    if (scoped) { const f = decide('openSync', p); if (f) { if (f.after) orig.openSync.call(this, p, ...rest); throw mkErr(f.code, 'openSync', p); } }
    const fd = orig.openSync.call(this, p, ...rest);
    if (scoped) fds.add(fd);
    return fd;
  };
  // write: may be SHORT — store half the bytes and report it, like a filling disk.
  orig.writeSync = fs.writeSync;
  fs.writeSync = function (fd, data, ...rest) {
    if (typeof fd === 'number' && fds.has(fd)) {
      const f = decide('writeSync', fdTarget(fd));
      if (f && f.short) {
        let buf; let off = 0; let len;
        if (typeof data === 'string') { buf = Buffer.from(data, typeof rest[1] === 'string' ? rest[1] : 'utf8'); len = buf.length; }
        else { buf = data; off = typeof rest[0] === 'number' ? rest[0] : 0; len = typeof rest[1] === 'number' ? rest[1] : buf.length - off; }
        const half = Math.max(1, Math.floor(len / 2));
        return orig.writeSync.call(this, fd, buf, off, half);
      }
      if (f) { if (f.after) orig.writeSync.call(this, fd, data, ...rest); throw mkErr(f.code, 'writeSync', fdTarget(fd)); }
    }
    return orig.writeSync.call(this, fd, data, ...rest);
  };
  orig.writeFileSync = fs.writeFileSync;
  fs.writeFileSync = function (target, data, ...rest) {
    const scoped = typeof target === 'number' ? fds.has(target) : inScope(target);
    if (scoped) {
      const f = decide('writeFileSync', typeof target === 'number' ? fdTarget(target) : target);
      if (f && f.short) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
        orig.writeFileSync.call(this, target, buf.subarray(0, Math.max(1, Math.floor(buf.length / 2))));
        throw mkErr(f.code, 'writeFileSync', target);
      }
      if (f) { if (f.after) orig.writeFileSync.call(this, target, data, ...rest); throw mkErr(f.code, 'writeFileSync', target); }
    }
    return orig.writeFileSync.call(this, target, data, ...rest);
  };
  wrapPath('appendFileSync', 0);
  wrapPath('mkdirSync', 0);
  wrapPath('unlinkSync', 0);
  wrapPath('copyFileSync', 1);
  orig.renameSync = fs.renameSync;
  fs.renameSync = function (from, to) {
    if (inScope(to) || inScope(from)) { const f = decide('renameSync', to); if (f) { if (f.after) orig.renameSync.call(this, from, to); throw mkErr(f.code, 'renameSync', to); } }
    return orig.renameSync.call(this, from, to);
  };
  wrapFd('fsyncSync');
  wrapFd('fdatasyncSync');
  wrapFd('ftruncateSync');
  wrapFd('closeSync');
  for (const k of Object.keys(orig)) if (fs[k] !== orig[k]) wrapped[k] = fs[k];
  syncBuiltinESMExports();
}

/** Put node:fs back. A wrapper something captured meanwhile (stdout's stream does) stays a pass-through. */
export function uninstall() {
  if (!active) return;
  active = false;
  for (const [k, v] of Object.entries(orig)) fs[k] = v;
  syncBuiltinESMExports();
}

export const fault = {
  record() { Object.assign(st, { on: false, at: 0, n: 0, fired: false, full: null, trace: [] }); },
  arm({ at, code = 'ENOSPC', mode = 'once' }) { Object.assign(st, { on: true, at, code, mode, n: 0, fired: false, full: null, trace: [] }); },
  disarm() { const t = { n: st.n, fired: st.fired, trace: st.trace.slice() }; Object.assign(st, { on: false, full: null }); return t; },
  get fired() { return st.fired; },
};

// As a preload for a real server, install at once (the marker decides what fails).
if (process.env.B217_FAULT_MARKER) install();
