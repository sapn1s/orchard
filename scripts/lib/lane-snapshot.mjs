/**
 * FEAT-176 — lane snapshots: a finished lane's files, kept so a later foreign write
 * cannot erase them without a way back.
 *
 * THE GUARANTEE (rescoped by the independent adjudicator, verbatim):
 *   "Every Write/Edit/MultiEdit/NotebookEdit/fileChange file a lane wrote is either
 *    restorable byte-exact from its own transcript, or named unrecoverable with a reason.
 *    Restore writes only real paths inside the project, with no symlinked component,
 *    after backing up the live file."
 *
 * Per file (one manifest entry each; `recovery` says which):
 *   rebuilt        EXACT: the lane's history of the file starts with a Write (or Codex add)
 *                  and every later Edit replays; the bytes come from the transcript;
 *   unverified     no replay base; the lane-end copy is kept BEST-EFFORT (nothing proves it
 *                  is the lane's bytes): restore only with --force, labelled UNVERIFIED;
 *   deleted        the lane's last recorded operation deleted the file (restore never deletes);
 *   unrecoverable  with a reason (no replay base and no usable copy, or over a cap).
 * Files a lane touched ONLY through a shell command: shell-copy (unverified, --force) /
 * shell-gone / shell-skipped — outside the guarantee.
 *
 * DETECTION is best-effort: `check` warns when a file's live bytes differ from its
 * latest snapshot (or a deleted file is back). It never refuses anything and may
 * over-report (a legitimate later edit also differs).
 *
 * NOT A HOOK, NOT A CLAIM. The server calls `spawnLaneSnapshot()` from its own stream
 * bookkeeping, deferred, as a detached child it never awaits; dispatch.mjs from
 * process 'exit'. Nothing the CLI waits on runs this code. It never refuses, never
 * consults a lock or candidate, never deletes outside its own store; failures go to
 * `<store root>/errors.log`.
 *
 * STORE. `dataDir()/lane-snapshots/<basename>-<sha256(realpath top)[0:12]>/`
 *   objects/<sha256>  write-once 0444, re-hashed on read;  snaps/<id>.json  write-once manifests;
 *   .lock  O_EXCL store lock across a take's publish, a prune and a restore backup.
 * Retention: 14 days, 1000 manifests/project, 2 GiB, per file 8 MiB, per lane 64 MB / 400 files.
 *
 * RESIDUALS (recorded in FEAT-176): shell-only writes (313 of 1,346 Bash writes in 30 days
 * were not even attributable to a path); files over 8 MiB; a dispatch killed by SIGKILL takes
 * no snapshot; interactive Codex sessions are not lanes; warnings over-report.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SNAPSHOT_SCRIPT = path.resolve(HERE, '..', 'lane-snapshot.mjs');
export const MANIFEST_VERSION = 4;

export const DEFAULTS = Object.freeze({
  days: 14,
  maxManifests: 1000,
  maxStoreBytes: 2 * 1024 ** 3,
  maxFileBytes: 8 * 1024 ** 2,
  maxLaneBytes: 64 * 1024 ** 2,
  maxFiles: 400,
  graceMs: 60 * 60 * 1000,
  lockStaleMs: 120_000,
  lockWaitMs: 60_000,
  reparseDelayMs: 1500,
});

function num(env, key, dflt) { const v = Number(env?.[key]); return Number.isFinite(v) && v > 0 ? v : dflt; }
export function limitsFrom(env = process.env) {
  return {
    ...DEFAULTS,
    days: num(env, 'ORCHARD_LANE_SNAPSHOT_DAYS', DEFAULTS.days),
    maxManifests: num(env, 'ORCHARD_LANE_SNAPSHOT_MAX_MANIFESTS', DEFAULTS.maxManifests),
    maxStoreBytes: num(env, 'ORCHARD_LANE_SNAPSHOT_MAX_STORE_BYTES', DEFAULTS.maxStoreBytes),
    maxFileBytes: num(env, 'ORCHARD_LANE_SNAPSHOT_MAX_FILE', DEFAULTS.maxFileBytes),
    maxLaneBytes: num(env, 'ORCHARD_LANE_SNAPSHOT_MAX_LANE_BYTES', DEFAULTS.maxLaneBytes),
    maxFiles: num(env, 'ORCHARD_LANE_SNAPSHOT_MAX_FILES', DEFAULTS.maxFiles),
    graceMs: num(env, 'ORCHARD_LANE_SNAPSHOT_GRACE_MS', DEFAULTS.graceMs),
    reparseDelayMs: env?.ORCHARD_LANE_SNAPSHOT_REPARSE_MS != null && env.ORCHARD_LANE_SNAPSHOT_REPARSE_MS !== ''
      ? Math.max(0, Number(env.ORCHARD_LANE_SNAPSHOT_REPARSE_MS) || 0) : DEFAULTS.reparseDelayMs,
  };
}

export function snapshotsEnabled(env = process.env) { return String(env.ORCHARD_LANE_SNAPSHOT ?? '1') !== '0'; }

/** Same resolution as src/lib/paths.ts dataDir(). */
export function dataDir(env = process.env) {
  const e = env.CLAUDE_STATION_DATA;
  if (e && e.trim()) return path.resolve(e);
  const xdg = env.XDG_DATA_HOME;
  const base = xdg && xdg.trim() ? path.resolve(xdg) : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'claude-station');
}
export function storeRoot(env = process.env) { return path.join(dataDir(env), 'lane-snapshots'); }

function realTop(top) { try { return fs.realpathSync(top); } catch { return path.resolve(top); } }
export function projectSlug(top) {
  const rt = realTop(top);
  const base = path.basename(rt).replace(/[^A-Za-z0-9._-]/g, '_') || 'root';
  return `${base}-${createHash('sha256').update(rt).digest('hex').slice(0, 12)}`;
}
export function storeDirFor(top, env = process.env) { return path.join(storeRoot(env), projectSlug(top)); }

export function logError(env, where, err) {
  try {
    const root = storeRoot(env);
    fs.mkdirSync(root, { recursive: true });
    const f = path.join(root, 'errors.log');
    try { if (fs.statSync(f).size > 1024 * 1024) fs.renameSync(f, `${f}.1`); } catch { /* absent */ }
    fs.appendFileSync(f, `${new Date().toISOString()} [${where}] ${err?.stack || err?.message || String(err)}\n`.slice(0, 4000));
  } catch { /* logging must never throw */ }
}

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const RECOVERABLE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'fileChange']);

/* ── transcripts → what the lane wrote, and how to get it back ─────────────── */
let classifyMutationP = null;
async function classifier() {
  if (!classifyMutationP) classifyMutationP = import('./file-lock.mjs').then((m) => m.classifyMutation).catch(() => null);
  return classifyMutationP;
}

function mapAlias(abs, aliases) {
  for (const a of aliases || []) {
    if (!a || !a.from || !a.to) continue;
    const from = a.from.replace(/\/+$/, '');
    if (abs === from) return a.to;
    if (abs.startsWith(from + '/')) return path.join(a.to, abs.slice(from.length + 1));
  }
  return abs;
}

/**
 * Parse transcripts (Claude CLI jsonl, or Orchard's normalized Codex transcript) into
 * `{ found, files: Map<abs, info>, unattributed: [] }`. Only SUCCESSFUL tool calls count.
 * info = { tools:Set, ops, lastOp, recon: string|null|false, edits:[{old,new,kind}], deleted, shellAfter }
 *   recon  string = exact bytes replayed from a Write/add base; null = no base; false = replay broken
 *   edits  the recorded text-level edits since the last whole-file base (for the copy-trust rule)
 */
export async function extractWrites(transcripts, { aliases = [], defaultCwd = null } = {}) {
  const classify = await classifier();
  const uses = [];
  const errs = new Set();
  let found = false;
  for (const t of transcripts || []) {
    let text;
    try { text = fs.readFileSync(t, 'utf8'); found = true; } catch { continue; }
    let cwd = defaultCwd;
    for (const line of text.split('\n')) {
      if (!line) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (typeof j.cwd === 'string' && j.cwd) cwd = j.cwd;
      const c = j.message?.content;
      if (!Array.isArray(c)) continue;
      for (const b of c) {
        if (b?.type === 'tool_use') uses.push({ id: b.id, name: b.name, input: b.input || {}, cwd, at: j.timestamp || null });
        else if (b?.type === 'tool_result' && b.is_error) errs.add(b.tool_use_id);
      }
    }
  }
  const files = new Map();
  const unattributed = [];
  const info = (abs) => {
    let f = files.get(abs);
    if (!f) { f = { tools: new Set(), ops: 0, lastOp: null, lastAt: null, recon: null, edits: [], deleted: false, shellAfter: false }; files.set(abs, f); }
    return f;
  };
  const touch = (f, tool, at) => { f.tools.add(tool); f.ops++; f.lastOp = tool; f.lastAt = at; };
  const resolve = (p, cwd) => mapAlias(path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd || defaultCwd || '/', p), aliases);
  for (const u of uses) {
    if (u.id && errs.has(u.id)) continue;
    const ti = u.input;
    try {
      if (u.name === 'Write' && typeof ti.file_path === 'string') {
        const f = info(resolve(ti.file_path, u.cwd)); touch(f, 'Write', u.at);
        f.recon = typeof ti.content === 'string' ? ti.content : false; f.edits = []; f.deleted = false; f.shellAfter = false;
      } else if ((u.name === 'Edit' || u.name === 'MultiEdit') && typeof ti.file_path === 'string') {
        const f = info(resolve(ti.file_path, u.cwd)); touch(f, u.name, u.at); f.deleted = false;
        const edits = u.name === 'Edit' ? [ti] : (Array.isArray(ti.edits) ? ti.edits : []);
        for (const e of edits) {
          const o = String(e.old_string ?? ''); const n = String(e.new_string ?? '');
          f.edits.push({ old: o, new: n, kind: 'edit' });
          if (typeof f.recon === 'string') {
            if (!o || !f.recon.includes(o)) f.recon = false;
            else f.recon = e.replace_all ? f.recon.split(o).join(n) : f.recon.replace(o, () => n);
          }
        }
      } else if (u.name === 'NotebookEdit' && typeof ti.notebook_path === 'string') {
        const f = info(resolve(ti.notebook_path, u.cwd)); touch(f, 'NotebookEdit', u.at); f.deleted = false;
        f.recon = typeof f.recon === 'string' ? false : f.recon;
        if (typeof ti.new_source === 'string' && ti.edit_mode !== 'delete') f.edits.push({ old: '', new: ti.new_source, kind: 'notebook' });
      } else if (u.name === 'fileChange' && Array.isArray(ti.changes)) {
        for (const ch of ti.changes) {
          if (!ch || typeof ch.path !== 'string') continue;
          const f = info(resolve(ch.path, u.cwd)); touch(f, 'fileChange', u.at);
          const kind = ch.kind?.type ?? ch.kind;
          if (kind === 'add') { f.recon = typeof ch.diff === 'string' ? ch.diff : false; f.edits = []; f.deleted = false; f.shellAfter = false; }
          else if (kind === 'delete') { f.deleted = true; f.recon = null; f.edits = []; }
          else {
            f.deleted = false;
            if (typeof f.recon === 'string') f.recon = false;
            const minus = []; const plus = [];
            for (const l of String(ch.diff || '').split('\n')) {
              if (l.startsWith('---') || l.startsWith('+++') || l.startsWith('@@')) continue;
              if (l.startsWith('-')) minus.push(l.slice(1)); else if (l.startsWith('+')) plus.push(l.slice(1));
            }
            f.edits.push({ old: minus.join('\n'), new: plus.join('\n'), kind: 'patch' });
          }
        }
      } else if (u.name === 'Bash' && typeof ti.command === 'string') {
        if (!classify) { unattributed.push({ tool: 'Bash', reason: 'classifier-unavailable', cmd: ti.command.slice(0, 200) }); continue; }
        const r = classify({ toolName: 'Bash', toolInput: { command: ti.command } });
        if (!r || !r.mutates) continue;
        if (r.tree) unattributed.push({ tool: 'Bash', reason: 'tree-wide', cmd: ti.command.slice(0, 200) });
        if (Array.isArray(r.scopes) && r.scopes.length) unattributed.push({ tool: 'Bash', reason: 'unresolved-target', cmd: ti.command.slice(0, 200) });
        for (const p of r.paths || []) {
          if (typeof p !== 'string' || !p || /[$`*?]/.test(p)) { unattributed.push({ tool: 'Bash', reason: 'unresolved-target', cmd: ti.command.slice(0, 200) }); continue; }
          const f = info(resolve(p, u.cwd)); touch(f, 'Bash', u.at);
          f.deleted = false; f.shellAfter = true;
          if (typeof f.recon === 'string') f.recon = false;
        }
      }
    } catch (e) {
      unattributed.push({ tool: u.name, reason: `parse-error: ${e.message}`.slice(0, 120), cmd: '' });
    }
  }
  return { found, files, unattributed };
}

/* ── git, read-only ─────────────────────────────────────────────────────────── */
function gitObjectFormat(top) {
  const r = spawnSync('git', ['-C', top, 'rev-parse', '--show-object-format'], { encoding: 'utf8', timeout: 20_000 });
  return r.status === 0 ? (String(r.stdout).trim() === 'sha256' ? 'sha256' : 'sha1') : null;
}
function blobId(bytes, fmt) { return createHash(fmt === 'sha256' ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); }

/* ── store primitives ──────────────────────────────────────────────────────── */
function ensureStore(dir) { fs.mkdirSync(path.join(dir, 'objects'), { recursive: true }); fs.mkdirSync(path.join(dir, 'snaps'), { recursive: true }); }
function within(dir, p) { const rel = path.relative(dir, p); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); }

function publishOnce(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, data, { mode: 0o444 });
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* ours */ } throw e; }
}
export function putObject(dir, bytes) {
  const h = sha256(bytes);
  const f = path.join(dir, 'objects', h);
  if (fs.existsSync(f)) { const now = new Date(); try { fs.utimesSync(f, now, now); } catch { /* best effort */ } return h; }
  publishOnce(f, bytes);
  return h;
}
export function getObject(dir, h) {
  if (!/^[0-9a-f]{64}$/.test(String(h))) throw new Error(`bad object id ${h}`);
  const b = fs.readFileSync(path.join(dir, 'objects', h));
  if (sha256(b) !== h) throw new Error(`object ${h.slice(0, 12)} is corrupt (hash mismatch)`);
  return b;
}

export async function withStoreLock(dir, fn, { env = process.env } = {}) {
  ensureStore(dir);
  const lim = limitsFrom(env);
  const lock = path.join(dir, '.lock');
  const t0 = Date.now();
  let held = false;
  while (!held) {
    try { fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() }), { flag: 'wx' }); held = true; break; }
    catch (e) {
      if (e.code !== 'EEXIST') break;
      let stale = false;
      try {
        const st = fs.statSync(lock); const j = JSON.parse(fs.readFileSync(lock, 'utf8'));
        if (Date.now() - st.mtimeMs > lim.lockStaleMs) stale = true;
        else if (j.host === os.hostname() && j.pid && !pidAlive(j.pid)) stale = true;
      } catch { stale = true; }
      if (stale) { const claim = `${lock}.stale-${process.pid}-${randomBytes(3).toString('hex')}`; try { fs.renameSync(lock, claim); fs.unlinkSync(claim); } catch { /* lost the race */ } continue; }
      if (Date.now() - t0 > lim.lockWaitMs) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!held) logError(env, 'lock', new Error(`store lock not acquired in ${lim.lockWaitMs} ms; proceeding (prune grace still protects objects)`));
  const touch = () => { if (held) { const n = new Date(); try { fs.utimesSync(lock, n, n); } catch { /* */ } } };
  try { return await fn(touch); } finally { if (held) { try { fs.unlinkSync(lock); } catch { /* */ } } }
}
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

/** Every manifest, sorted by end time. An absent snaps/ is "none"; any other read error throws; bad manifests are listed in `.damaged`. */
export function readManifests(dir) {
  const out = []; out.damaged = [];
  let names = [];
  try { names = fs.readdirSync(path.join(dir, 'snaps')); }
  catch (e) { if (e.code === 'ENOENT') return out; throw new Error(`cannot read the snapshot store ${path.join(dir, 'snaps')}: ${e.code || e.message}`); }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    let raw;
    try { raw = fs.readFileSync(path.join(dir, 'snaps', n)); } catch (e) { out.damaged.push({ file: n, error: `unreadable (${e.code || e.message})` }); continue; }
    try { const m = JSON.parse(raw.toString('utf8')); if (!m || typeof m.id !== 'string' || !Array.isArray(m.files)) throw new Error('not a snapshot manifest'); m._file = n; out.push(m); }
    catch (e) { out.damaged.push({ file: n, error: `unparseable (${e.message.slice(0, 80)})` }); }
  }
  out.sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0) || String(a.id).localeCompare(String(b.id)));
  return out;
}

function stamp(ms) { return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); }
function safeId(s) { return String(s || 'lane').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80); }

/* ── take ──────────────────────────────────────────────────────────────────── */
/** Never throws; returns a per-lane summary. */
export async function takeSnapshot(spec, { env = process.env, now = () => Date.now() } = {}) {
  const results = [];
  try {
    if (!snapshotsEnabled(env)) return [{ skipped: 'disabled' }];
    if (env.ORCHARD_LANE_SNAPSHOT_FAULT === 'throw') throw new Error('injected fault (ORCHARD_LANE_SNAPSHOT_FAULT=throw)');
    if (env.ORCHARD_LANE_SNAPSHOT_FAULT === 'hang') await new Promise((r) => setTimeout(r, Number(env.ORCHARD_LANE_SNAPSHOT_FAULT_MS) || 30_000));
    if (!spec || typeof spec.top !== 'string' || !Array.isArray(spec.lanes)) throw new Error('bad spec');
    const top = realTop(spec.top);
    const dir = storeDirFor(top, env);
    const lim = limitsFrom(env);
    const fmt = gitObjectFormat(top);
    for (const lane of spec.lanes) {
      try { results.push(await takeOne({ spec, lane, top, dir, lim, fmt, env, now })); }
      catch (e) { logError(env, `take ${lane?.laneId}`, e); results.push({ laneId: lane?.laneId, error: e.message }); }
    }
    try { await prune(dir, { env, now: now() }); } catch (e) { logError(env, 'prune', e); }
    try { await pruneRoot({ env, now: now(), except: dir }); } catch (e) { logError(env, 'prune-root', e); }
  } catch (e) { logError(env, 'take', e); results.push({ error: e.message }); }
  return results;
}

function readLive(abs) {
  let st;
  try { st = fs.lstatSync(abs); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { state: 'absent' }; return { state: 'unreadable', reason: e.code || e.message }; }
  if (st.isSymbolicLink()) return { state: 'skipped', reason: 'symlink' };
  if (!st.isFile()) return { state: 'skipped', reason: 'not-a-regular-file' };
  return { state: 'present', st };
}

async function takeOne({ spec, lane, top, dir, lim, fmt, env, now }) {
  const transcripts = (lane.transcripts || []).filter((t) => typeof t === 'string' && t);
  if (typeof lane.subagentsDir === 'string' && lane.subagentsDir) {
    try { for (const n of fs.readdirSync(lane.subagentsDir)) if (/^agent-[A-Za-z0-9_-]+\.jsonl$/.test(n)) transcripts.push(path.join(lane.subagentsDir, n)); } catch { /* none */ }
  }
  const opts = { aliases: spec.aliases || [], defaultCwd: lane.cwd || spec.cwd || top };
  const first = await extractWrites(transcripts, opts);
  const endedAt = Number(lane.endedAt) || now();
  const id = `${stamp(endedAt)}-${safeId(lane.laneId)}`;
  const base = {
    v: MANIFEST_VERSION, id, laneId: String(lane.laneId || ''), source: lane.source || 'unknown',
    ticket: Array.isArray(lane.ticket) ? lane.ticket.filter((x) => typeof x === 'string') : [],
    status: lane.status || null, stationSession: spec.stationSession || null, sdkSession: spec.sdkSession || null,
    startedAt: Number(lane.startedAt) || null, endedAt, top, transcripts,
  };
  if (!first.found && lane.optional) return { laneId: base.laneId, skipped: 'no transcript (optional lane: a terminal frame with no row here)' };
  if (!first.found) {
    await withStoreLock(dir, async () => {
      const f = path.join(dir, 'snaps', `${id}.json`);
      if (!fs.existsSync(f)) publishOnce(f, JSON.stringify({ ...base, takenAt: now(), transcriptMissing: true, files: [], unattributed: [] }, null, 1));
    }, { env });
    return { laneId: base.laneId, id, transcriptMissing: true };
  }
  const outside = new Set();
  const inTop = (abs) => {
    let real = abs;
    try { real = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs)); } catch { /* parent missing */ }
    if (!within(top, abs) || !(within(top, real) || path.dirname(real) === top)) { outside.add(abs); return null; }
    return path.relative(top, abs).split(path.sep).join('/');
  };
  const entries = new Map();
  let laneBytes = 0;
  let stored = 0;
  const keep = (entry, bytes, mode, touch) => {
    if (bytes.length > lim.maxFileBytes) return `over the ${lim.maxFileBytes}-byte file cap`;
    if (laneBytes + bytes.length > lim.maxLaneBytes) return `over the ${lim.maxLaneBytes}-byte lane budget`;
    if (stored >= lim.maxFiles) return `over the ${lim.maxFiles}-file lane cap`;
    laneBytes += bytes.length; stored++;
    entry.sha256 = putObject(dir, bytes); touch();
    entry.size = bytes.length; entry.mode = mode;
    if (fmt) entry.blob = blobId(bytes, fmt);
    return null;
  };
  const build = (abs, finfo, touch) => {
    const rel = inTop(abs);
    if (!rel) return;
    const recoverable = [...finfo.tools].some((t) => RECOVERABLE_TOOLS.has(t));
    const entry = { path: rel, tools: [...finfo.tools], ops: finfo.ops, lastOp: finfo.lastOp, lastOpAt: finfo.lastAt };
    entries.set(rel, entry);
    const copy = readLive(abs);
    entry.copyState = copy.state;
    if (finfo.deleted) { entry.recovery = 'deleted'; return; }
    const mode = copy.state === 'present' ? (copy.st.mode & 0o777) : 0o644;
    if (typeof finfo.recon === 'string') {
      const bytes = Buffer.from(finfo.recon, 'utf8');
      const why = keep(entry, bytes, mode, touch);
      if (why) { entry.recovery = 'unrecoverable'; entry.reason = why; return; }
      entry.recovery = 'rebuilt';
      entry.copyMatches = copy.state === 'present' && copy.st.size === bytes.length && (() => { try { return sha256(fs.readFileSync(abs)) === entry.sha256; } catch { return false; } })();
      return;
    }
    if (copy.state !== 'present') {
      entry.recovery = recoverable ? 'unrecoverable' : 'shell-gone';
      entry.reason = copy.state === 'absent' ? 'no replay base (no Write) and the file was gone when the lane ended' : `the lane-end copy is ${copy.state}${copy.reason ? ` (${copy.reason})` : ''}`;
      return;
    }
    if (copy.st.size > lim.maxFileBytes) { entry.recovery = recoverable ? 'unrecoverable' : 'shell-skipped'; entry.reason = `over the ${lim.maxFileBytes}-byte file cap (${copy.st.size} bytes)`; return; }
    let bytes;
    try { bytes = fs.readFileSync(abs); } catch (e) { entry.recovery = recoverable ? 'unrecoverable' : 'shell-skipped'; entry.reason = `the lane-end copy could not be read (${e.code || e.message})`; return; }
    if (!recoverable) {
      const why = keep(entry, bytes, mode, touch);
      entry.recovery = why ? 'shell-skipped' : 'shell-copy';
      if (why) entry.reason = why; else entry.reason = 'written only by a shell command: the lane-end copy is kept best-effort (outside the guarantee)';
      return;
    }
    // No replay base: the lane-end copy is kept BEST-EFFORT. Nothing proves these are the
    // lane's bytes (a foreign write may have landed first), so it is 'unverified'.
    const why = keep(entry, bytes, mode, touch);
    if (why) { entry.recovery = 'unrecoverable'; entry.reason = `no replay base (no Write) and the lane-end copy is ${why}`; return; }
    entry.recovery = 'unverified';
    entry.reason = finfo.recon === false ? 'the replay broke (a shell command or an unmatched edit), so only the lane-end copy is kept: UNVERIFIED' : 'no replay base (the lane never wrote the whole file), so only the lane-end copy is kept: UNVERIFIED';
  };
  let unattributed = first.unattributed;
  await withStoreLock(dir, async (touch) => {
    for (const [abs, finfo] of first.files) build(abs, finfo, touch);
    if (lim.reparseDelayMs > 0) await new Promise((r) => setTimeout(r, lim.reparseDelayMs));
    const second = await extractWrites(transcripts, opts);
    for (const [abs, finfo] of second.files) {
      const rel = inTop(abs); if (!rel) continue;
      const e = entries.get(rel);
      if (!e || finfo.ops > (e.ops || 0)) { if (e?.size) { laneBytes -= e.size; stored--; } build(abs, finfo, touch); }
    }
    if (second.unattributed.length > unattributed.length) unattributed = second.unattributed;
    if (!entries.size && !unattributed.length && !outside.size) return;
    const m = { ...base, takenAt: now(), files: [...entries.values()], outsideProject: outside.size, unattributed: unattributed.slice(0, 200), unattributedCount: unattributed.length };
    const f = path.join(dir, 'snaps', `${id}.json`);
    if (!fs.existsSync(f)) publishOnce(f, JSON.stringify(m, null, 1));
  }, { env });
  return { laneId: base.laneId, id, files: entries.size, unattributed: unattributed.length };
}

/* ── prune ─────────────────────────────────────────────────────────────────── */
export async function prune(dir, { env = process.env, now = Date.now() } = {}) {
  const lim = limitsFrom(env);
  const removed = { manifests: 0, objects: 0, bytes: 0 };
  if (!fs.existsSync(dir)) return removed;
  await withStoreLock(dir, async () => {
    const all = readManifests(dir);
    const cutoff = now - lim.days * 864e5;
    const keepM = []; const drop = [];
    for (const m of all) ((m.endedAt || 0) < cutoff ? drop : keepM).push(m);
    while (keepM.length > lim.maxManifests) drop.push(keepM.shift());
    const sizeOf = (h) => { try { return fs.statSync(path.join(dir, 'objects', h)).size; } catch { return 0; } };
    const refBytes = () => { const s = new Set(); for (const m of keepM) for (const f of m.files || []) if (f.sha256) s.add(f.sha256); let b = 0; for (const h of s) b += sizeOf(h); return b; };
    while (keepM.length && refBytes() > lim.maxStoreBytes) drop.push(keepM.shift());
    for (const m of drop) {
      const f = path.join(dir, 'snaps', m._file);
      if (!within(dir, f)) continue;
      try { if (fs.lstatSync(f).isFile()) { fs.unlinkSync(f); removed.manifests++; } } catch { /* gone */ }
    }
    // a damaged manifest's references are unknown: past retention it goes, inside it blocks object GC
    let gcBlocked = false;
    for (const d of all.damaged) {
      const p = path.join(dir, 'snaps', d.file);
      let st; try { st = fs.lstatSync(p); } catch { continue; }
      if (st.isFile() && st.mtimeMs < cutoff && within(dir, p)) { try { fs.unlinkSync(p); removed.manifests++; } catch { gcBlocked = true; } } else gcBlocked = true;
    }
    if (gcBlocked) { removed.gcBlocked = true; return; }
    const referenced = new Set();
    for (const m of keepM) for (const f of m.files || []) if (f.sha256) referenced.add(f.sha256);
    let names = [];
    try { names = fs.readdirSync(path.join(dir, 'objects')); } catch { /* none */ }
    for (const n of names) {
      const f = path.join(dir, 'objects', n);
      if (!within(dir, f)) continue;
      let st; try { st = fs.lstatSync(f); } catch { continue; }
      if (!st.isFile()) continue;
      if (/^[0-9a-f]{64}$/.test(n) && referenced.has(n)) continue;
      if (now - st.mtimeMs < lim.graceMs) continue; // a concurrent take may be about to reference it
      try { fs.unlinkSync(f); removed.objects++; removed.bytes += st.size; } catch { /* */ }
    }
  }, { env });
  return removed;
}

/** Prune every project's store under the root (at most hourly) and remove store dirs left empty. */
export async function pruneRoot({ env = process.env, now = Date.now(), except = null, force = false } = {}) {
  const root = storeRoot(env);
  const mark = path.join(root, '.last-root-prune');
  try { if (!force && now - fs.statSync(mark).mtimeMs < 3600_000) return { skipped: 'recent' }; } catch { /* first run */ }
  try { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(mark, String(now)); } catch { /* */ }
  let n = 0;
  for (const name of fs.readdirSync(root)) {
    const d = path.join(root, name);
    if (d === except || !within(root, d)) continue;
    let st; try { st = fs.lstatSync(d); } catch { continue; }
    if (!st.isDirectory() || !fs.existsSync(path.join(d, 'snaps'))) continue;
    try { await prune(d, { env, now }); n++; } catch (e) { logError(env, `prune ${name}`, e); continue; }
    try {
      const left = fs.readdirSync(path.join(d, 'snaps')).length + fs.readdirSync(path.join(d, 'objects')).length;
      if (!left) { fs.rmdirSync(path.join(d, 'snaps')); fs.rmdirSync(path.join(d, 'objects')); fs.rmdirSync(d); }
    } catch { /* not empty or busy: keep */ }
  }
  return { pruned: n };
}

export function stats(dir) {
  const ms = readManifests(dir);
  let objects = 0, bytes = 0;
  try { for (const n of fs.readdirSync(path.join(dir, 'objects'))) { try { const st = fs.statSync(path.join(dir, 'objects', n)); if (st.isFile()) { objects++; bytes += st.size; } } catch { /* */ } } } catch { /* */ }
  const recovery = {};
  for (const m of ms) for (const f of m.files || []) recovery[f.recovery || 'other'] = (recovery[f.recovery || 'other'] || 0) + 1;
  return { store: dir, manifests: ms.length, fileEntries: Object.values(recovery).reduce((a, b) => a + b, 0), recovery, objects, bytes, oldest: ms[0]?.endedAt ?? null, newest: ms.at(-1)?.endedAt ?? null };
}

/* ── check (best-effort warnings) ──────────────────────────────────────────── */
function cmdQuote(s) { return /^[A-Za-z0-9_./:@=+-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`; }
export function restoreCommand(top, sel, rel, extra = '') {
  return `node ${cmdQuote(SNAPSHOT_SCRIPT)} restore ${cmdQuote(sel)} --repo ${cmdQuote(top)}${rel ? ` --file ${cmdQuote(rel)}` : ''}${extra}`;
}
function storePathState(p) { try { fs.lstatSync(p); return 'ok'; } catch (e) { if (e.code === 'ENOENT') return 'absent'; throw new Error(`cannot read ${p}: ${e.code || e.message}`); } }
const EXACT = new Set(['rebuilt', 'backup']); // backup = the exact live bytes a restore overwrote
const UNVERIFIED = new Set(['unverified', 'shell-copy']);
const RESTORABLE = new Set([...EXACT, ...UNVERIFIED]);

/**
 * For every path, its LATEST snapshot entry (by lane end) against the live file. A warning
 * when the live bytes differ from the kept bytes, or a file the lane deleted is back.
 * `account:true` lists every entry with its recovery class (the accounting proof).
 * Never throws; an unreadable store → { unavailable }.
 */
export function checkRepo({ top, paths = null, env = process.env, account = false } = {}) {
  try {
    const rt = realTop(top);
    const dir = storeDirFor(rt, env);
    const out = { top: rt, store: dir, findings: [], notices: [], checked: 0 };
    if (account) out.entries = [];
    if (storePathState(storeRoot(env)) === 'absent' || storePathState(dir) === 'absent' || storePathState(path.join(dir, 'snaps')) === 'absent') return out;
    const all = readManifests(dir);
    for (const d of all.damaged) out.findings.push({ path: `(store) snaps/${d.file}`, laneId: '?', snapshot: d.file, ticket: [], endedAt: null, kind: 'manifest-damaged', detail: `a snapshot manifest is ${d.error}; what it kept cannot be read`, restore: `inspect ${path.join(dir, 'snaps', d.file)}` });
    const ms = all.filter((m) => m.source !== 'restore-backup');
    const want = paths && paths.length ? new Set(paths.map((p) => path.relative(rt, path.resolve(rt, p)).split(path.sep).join('/'))) : null;
    const latest = new Map();
    for (const m of ms) {
      if (m.transcriptMissing) { out.notices.push(`lane ${m.laneId}${m.ticket?.length ? ` (${m.ticket.join(',')})` : ''} ended ${new Date(m.endedAt).toISOString()} but its transcript was not found, so nothing it wrote was snapshotted`); continue; }
      for (const f of m.files || []) {
        if (out.entries) out.entries.push({ snapshot: m.id, laneId: m.laneId, path: f.path, recovery: f.recovery || null, reason: f.reason || null });
        latest.set(f.path, { m, f });
      }
    }
    const unrecoverable = [];
    for (const [rel, { m, f }] of latest) {
      if (want && !want.has(rel)) continue;
      out.checked++;
      const base = { path: rel, laneId: m.laneId, snapshot: m.id, ticket: m.ticket || [], endedAt: m.endedAt };
      const L = readLive(path.join(rt, rel));
      if (f.recovery === 'deleted') {
        if (L.state !== 'absent') out.findings.push({ ...base, kind: 'file-recreated', detail: 'the lane deleted this file and it is back (restore never deletes)', restore: 'none: delete it by hand if the deletion was right' });
        continue;
      }
      if (!RESTORABLE.has(f.recovery)) { unrecoverable.push(`${rel} (lane ${m.laneId}: ${f.reason || f.recovery})`); continue; }
      let liveSha = null;
      if (L.state === 'present') { try { liveSha = sha256(fs.readFileSync(path.join(rt, rel))); } catch { liveSha = null; } }
      if (liveSha === f.sha256) continue;
      out.findings.push({ ...base, kind: L.state === 'present' ? 'differs' : 'file-gone', snapSize: f.size, liveSize: L.st?.size ?? null,
        detail: L.state === 'present' ? `the live file differs from what this lane left (${f.recovery}); it may be a later legitimate edit` : 'the file this lane left is gone',
        restore: restoreCommand(rt, m.id, rel) });
    }
    if (unrecoverable.length) out.notices.push(`${unrecoverable.length} lane file(s) could not be kept and cannot be restored: ${unrecoverable.slice(0, 5).join('; ')}${unrecoverable.length > 5 ? '; …' : ''}`);
    out.unrecoverable = unrecoverable.length;
    return out;
  } catch (e) {
    return { unavailable: e.message, findings: [], notices: [] };
  }
}

export function formatCheck(res, { verbose = false } = {}) {
  if (res.unavailable) return `lane-snapshot check unavailable: ${res.unavailable}\n`;
  const lines = [];
  if (res.findings.length) {
    const bar = '!'.repeat(78);
    lines.push(bar, `!! LANE WORK CHANGED? ${res.findings.length} file(s) differ from what a finished lane left (FEAT-176; may over-report)`, bar);
    for (const f of res.findings) {
      lines.push(`- ${f.path}  [${f.kind}]`,
        f.endedAt ? `    lane ${f.laneId}${f.ticket.length ? ` (${f.ticket.join(', ')})` : ''}, ended ${new Date(f.endedAt).toISOString()}` : '    (snapshot store)',
        `    ${f.detail}${f.liveSize != null && f.snapSize != null ? `; live ${f.liveSize} B vs kept ${f.snapSize} B` : ''}`,
        `    restore: ${f.restore}`);
    }
    lines.push(bar);
  }
  if (verbose || res.findings.length) for (const n of res.notices) lines.push(`note: ${n}`);
  if (!res.findings.length && verbose) lines.push(`lane-snapshot check: no differences (${res.checked} lane file(s) checked in ${res.store})`);
  return lines.length ? lines.join('\n') + '\n' : '';
}

/** Warning for verify/commit tools: prints to stderr when there is anything to say; never throws, never changes an exit code. */
export function warnIfLaneWorkLost({ top, paths = null, env = process.env, write = (s) => process.stderr.write(s), timeoutMs = 10_000 } = {}) {
  try {
    if (env.ORCHARD_LANE_SNAPSHOT_CHECK === '0') return null;
    const args = [SNAPSHOT_SCRIPT, 'check', '--repo', top, '--json'];
    for (const p of paths || []) args.push('--path', p);
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: timeoutMs, env, maxBuffer: 32 * 1024 * 1024 });
    if (r.error || (r.status !== 0 && r.status !== 1)) {
      let why = r.error ? r.error.message : '';
      if (!why) { try { why = JSON.parse(r.stdout).unavailable || ''; } catch { /* */ } }
      write(`lane-snapshot check unavailable: ${why || (r.stderr || `exit ${r.status}`).trim().slice(0, 300)}\n`);
      return null;
    }
    const res = JSON.parse(r.stdout);
    const s = formatCheck(res);
    if (s) write(s);
    return res;
  } catch (e) {
    try { write(`lane-snapshot check unavailable: ${e.message}\n`); } catch { /* */ }
    return null;
  }
}

/* ── restore ───────────────────────────────────────────────────────────────── */
const TICKET_RE = /^(BUG|FEAT|ARCH|DEPLOY)-\d+$/;

export function selectEntries(dir, selector) {
  const ms = readManifests(dir);
  if (TICKET_RE.test(selector)) {
    const per = new Map();
    for (const m of ms) if (m.source !== 'restore-backup' && (m.ticket || []).includes(selector)) for (const f of m.files || []) per.set(f.path, { m, f });
    return { kind: 'ticket', entries: [...per.values()], manifests: [...new Set([...per.values()].map((x) => x.m.id))] };
  }
  const hits = ms.filter((m) => m.id === selector || m.laneId === selector || m.id.startsWith(selector) || m.laneId.startsWith(selector) || m.id.endsWith(`-${selector}`));
  const byId = [...new Map(hits.map((m) => [m.id, m])).values()];
  if (byId.length > 1) {
    const exact = byId.filter((m) => m.id === selector);
    if (exact.length === 1) return { kind: 'snapshot', entries: (exact[0].files || []).map((f) => ({ m: exact[0], f })), manifests: [exact[0].id] };
    // a lane id with several snapshots (a revived lane): the latest entry per file
    const sameLane = byId.every((m) => m.laneId === byId[0].laneId);
    if (sameLane) { const per = new Map(); for (const m of byId) for (const f of m.files || []) per.set(f.path, { m, f }); return { kind: 'snapshot', entries: [...per.values()], manifests: byId.map((m) => m.id) }; }
    return { kind: 'ambiguous', candidates: byId.map((m) => m.id) };
  }
  if (!byId.length) return { kind: 'none' };
  return { kind: 'snapshot', entries: (byId[0].files || []).map((f) => ({ m: byId[0], f })), manifests: [byId[0].id] };
}

/**
 * Write a lane's (or a ticket's latest) kept bytes back. Every live file it will overwrite
 * is backed up first into a `restore-backup` manifest (abort if that fails), so the printed
 * undo restores those bytes exactly. Never deletes; refuses symlinks and escaping paths;
 * names every file it cannot restore with the reason.
 */
/**
 * Path confinement: walk every component of `rel` under the project root with lstat.
 * Any existing component that is a symlink (or not a directory, for a parent) refuses;
 * a missing component means every deeper one is missing too and will be created as a
 * real directory by restore. The root itself must be the realpath of the project.
 */
export function confinedTarget(rt, rel) {
  if (!rel || typeof rel !== 'string' || path.isAbsolute(rel) || rel.split('/').some((c) => c === '..' || c === '.' || c === '')) return { ok: false, why: 'the path is not a plain project-relative path' };
  let realRoot;
  try { realRoot = fs.realpathSync(rt); } catch (e) { return { ok: false, why: `the project root cannot be resolved (${e.code || e.message})` }; }
  if (realRoot !== rt) return { ok: false, why: 'the project root is itself reached through a symlink' };
  const parts = rel.split('/');
  let cur = rt;
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]);
    let st;
    try { st = fs.lstatSync(cur); } catch (e) { if (e.code === 'ENOENT') return { ok: true, abs: path.join(rt, rel), missingFrom: i }; return { ok: false, why: `cannot inspect ${parts.slice(0, i + 1).join('/')} (${e.code || e.message})` }; }
    if (st.isSymbolicLink()) return { ok: false, why: `${parts.slice(0, i + 1).join('/')} is a symlink; restore writes only real paths` };
    if (i < parts.length - 1 && !st.isDirectory()) return { ok: false, why: `${parts.slice(0, i + 1).join('/')} is not a directory` };
    if (i === parts.length - 1 && !st.isFile()) return { ok: false, why: `${rel} exists and is not a regular file` };
  }
  return { ok: true, abs: path.join(rt, rel), missingFrom: -1 };
}

export async function restore({ top, selector, files = null, dryRun = false, force = false, env = process.env, now = () => Date.now() } = {}) {
  const rt = realTop(top);
  const dir = storeDirFor(rt, env);
  let sel;
  try { sel = selectEntries(dir, String(selector || '')); } catch (e) { return { ok: false, error: e.message }; }
  if (sel.kind === 'none' || (sel.kind === 'ticket' && !sel.entries.length)) return { ok: false, error: `no snapshot matches "${selector}" in ${dir}` };
  if (sel.kind === 'ambiguous') return { ok: false, error: `"${selector}" matches several snapshots; give one id`, candidates: sel.candidates };
  const want = files && files.length ? new Set(files.map((p) => path.relative(rt, path.resolve(rt, p)).split(path.sep).join('/'))) : null;
  const plan = [];
  for (const { m, f } of sel.entries) {
    if (want && !want.has(f.path)) continue;
    const item = { path: f.path, snapshot: m.id, laneId: m.laneId, recovery: f.recovery };
    if (f.recovery === 'deleted') { plan.push({ ...item, action: 'skip', why: 'the lane deleted this file; restore never deletes' }); continue; }
    if (!RESTORABLE.has(f.recovery) || !f.sha256) { plan.push({ ...item, action: 'unrecoverable', why: f.reason || 'no bytes were kept' }); continue; }
    item.verified = EXACT.has(f.recovery);
    if (!item.verified && !force) { plan.push({ ...item, action: 'refuse', why: `UNVERIFIED lane-end copy (${f.reason || f.recovery}); re-run with --force to write it anyway` }); continue; }
    const rel = f.path;
    const ct = confinedTarget(rt, rel);
    if (!ct.ok) { plan.push({ ...item, action: 'refuse', why: ct.why }); continue; }
    const abs = ct.abs;
    const L = readLive(abs);
    if (L.state === 'skipped' || L.state === 'unreadable') { plan.push({ ...item, action: 'refuse', why: `the live path is ${L.reason || L.state}; not touching it` }); continue; }
    let bytes;
    try { bytes = getObject(dir, f.sha256); } catch (e) { plan.push({ ...item, action: 'refuse', why: e.message }); continue; }
    if (L.state === 'present' && sha256(fs.readFileSync(abs)) === f.sha256) { plan.push({ ...item, action: 'skip', why: 'already current' }); continue; }
    plan.push({ ...item, action: 'write', abs, rel, bytes, mode: f.mode ?? 0o644, sha: f.sha256, liveState: L.state });
  }
  const writes = plan.filter((p) => p.action === 'write');
  const strip = (p) => { const { bytes, abs, rel, ...rest } = p; return rest; };
  const blocked = plan.some((p) => p.action === 'refuse' || p.action === 'unrecoverable');
  if (dryRun || !writes.length) return { ok: !blocked, dryRun, plan: plan.map(strip), backup: null };
  const backupId = `${stamp(now())}-restore-${randomBytes(3).toString('hex')}`;
  try {
    await withStoreLock(dir, async (touch) => {
      const bfiles = [];
      for (const w of writes) {
        if (w.liveState !== 'present') continue;
        const b = fs.readFileSync(w.abs);
        const st = fs.statSync(w.abs);
        bfiles.push({ path: w.path, recovery: 'backup', sha256: putObject(dir, b), size: b.length, mode: st.mode & 0o777 });
        touch();
      }
      if (!bfiles.length) return;
      publishOnce(path.join(dir, 'snaps', `${backupId}.json`), JSON.stringify({ v: MANIFEST_VERSION, id: backupId, laneId: backupId, source: 'restore-backup', ticket: [], restoredFrom: sel.manifests, endedAt: now(), takenAt: now(), top: rt, files: bfiles, unattributed: [] }, null, 1));
    }, { env });
  } catch (e) {
    return { ok: false, error: `backup of the live files failed, nothing was restored: ${e.message}`, plan: plan.map(strip) };
  }
  for (const w of writes) {
    const d = path.dirname(w.abs);
    const tmp = path.join(d, `.${path.basename(w.abs)}.orchard-restore-${randomBytes(4).toString('hex')}`);
    try {
      const again = confinedTarget(rt, w.rel);
      if (!again.ok) throw new Error(`refused at write time: ${again.why}`);
      let cur = rt;
      for (const c of w.rel.split('/').slice(0, -1)) { cur = path.join(cur, c); try { fs.mkdirSync(cur); } catch (e) { if (e.code !== 'EEXIST') throw e; } const st = fs.lstatSync(cur); if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${path.relative(rt, cur)} became a symlink or non-directory`); }
      fs.writeFileSync(tmp, w.bytes, { mode: w.mode, flag: 'wx' });
      fs.chmodSync(tmp, w.mode);
      fs.renameSync(tmp, w.abs);
      const back = sha256(fs.readFileSync(w.abs));
      w.result = back === w.sha ? 'restored' : `WRITTEN BUT RE-READ DIFFERS (${back.slice(0, 12)})`;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* our own temp file */ }
      w.result = `failed: ${e.message}`;
    }
  }
  const hadBackup = fs.existsSync(path.join(dir, 'snaps', `${backupId}.json`));
  return { ok: writes.every((w) => w.result === 'restored') && !blocked, plan: plan.map(strip), backup: hadBackup ? backupId : null, undo: hadBackup ? restoreCommand(rt, backupId, null) : null };
}

/* ── the server/dispatch-side trigger ──────────────────────────────────────── */
/** Launch `lane-snapshot.mjs take` detached and return at once. No file I/O, never awaits, never throws. */
export function spawnLaneSnapshot(spec, { env = process.env, warn = (m) => { try { console.warn(m); } catch { /* */ } } } = {}) {
  try {
    if (!snapshotsEnabled(env)) return false;
    if (!spec || !Array.isArray(spec.lanes) || !spec.lanes.length) return false;
    const exe = env.ORCHARD_LANE_SNAPSHOT_NODE || process.execPath;
    const arg = Buffer.from(JSON.stringify(spec)).toString('base64');
    const child = spawn(exe, [SNAPSHOT_SCRIPT, 'take', '--spec', arg], { detached: true, stdio: 'ignore', env, windowsHide: true });
    child.on('error', (e) => warn(`[orchard] lane snapshot could not start (FEAT-176, ignored): ${e.message}`));
    child.unref();
    return true;
  } catch (e) {
    warn(`[orchard] lane snapshot could not start (FEAT-176, ignored): ${e.message}`);
    return false;
  }
}
