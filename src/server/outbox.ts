/**
 * BUG-217 round 5 — THE SERVER-OWNED OUTBOX.
 *
 * A message the user queues is a ROW this module minted and wrote to disk
 * before it answered the POST. Only this module moves a row, and every move is
 * on disk before it takes effect:
 *
 *   queued ──► sending ──► delivered
 *     ▲  │          └────► uncertain   (handed over, arrival not confirmed)
 *     │  ├────────────────► failed      (not handed over; the server's own reason)
 *     │  └────────────────► discarded   (the user withdrew it)
 *     └──── uncertain | failed          (the user's Send anyway / Send again — once)
 *
 * Nothing a client says is read as delivery evidence: not an absence, a
 * timestamp, a scope, or text. The one piece of evidence from outside this file
 * is the RECEIVER's own record: every prompt the outbox hands over carries the
 * row's id (`ref q-…`) in its header, so the session's transcript — written by
 * the CLI when it takes the message — can confirm an arrival. That check can
 * only move a row TOWARD delivered; it never authorises a send.
 *
 * Why (four rounds, one shape): each earlier round had a reader INFER delivery
 * from something that can lie or forget — a tab's memory, localStorage locks,
 * transcript text, an evicting ledger, client clocks. Here the owner of the row
 * declares its state (ARCH-010), and nothing is evicted.
 *
 * STORAGE. One append-only journal per session, `outbox/<session>.jsonl`, one
 * JSON line per transition (a batch's transition is ONE line), each fsync'd
 * before the caller proceeds, plus `<session>.head` recording the last line
 * number, so a file truncated at a line boundary is detected too. On load, a
 * row caught `sending` becomes `uncertain` (a crash between handover and its
 * record) unless the transcript shows it arrived. ANY damage — an unparsable
 * line, a missing or disagreeing head, a gap — fails LOUDLY: every row that
 * had not finished becomes `uncertain`, the file is copied aside, and the
 * session carries a `damaged` notice until the user dismisses it; while it is
 * set, a nonce the outbox does not know arrives `uncertain` (its record may be
 * the line that was lost). No row is ever evicted.
 *
 * THE COMMIT POINT (round 6). A journal line is the truth the moment its fsync
 * returns — ONE step. Everything after it (the row in memory and the nonce
 * index, the `.head`, a compaction) follows from it and can no longer undo it:
 * memory is updated first, and a later step that fails is logged, never thrown
 * back as "not saved" (round 5 threw after the fsync, the tab replayed its
 * nonce, and a second row was minted for one message). A write that fails
 * BEFORE the commit point is rolled back (the file is truncated to where it
 * was), so a thrown error means nothing changed; if even the rollback fails, the
 * line's number is burned and the session goes into damaged mode, so a replay
 * arrives `uncertain` and a reload finds the line or a gap — never a silent
 * second meaning. The `.head` is only a lower bound (it may lag, never lead).
 * A compaction's one step is its rename; its snapshot line keeps the sequence
 * number rising, so a head that lags it is still consistent.
 *
 * ONE ROW PER (session, nonce) is an invariant of the durable state, not only of
 * memory: `load()` keeps the first row of a nonce, marks every later one a
 * duplicate that is never delivered, and — if another copy may already have
 * gone — asks the user (`uncertain`) instead of sending the kept one.
 *
 * DELIVERY. `pumpOutbox` runs on every change and on a short tick for sessions
 * holding a queued row — whether or not any tab is open. It asks the wiring
 * (index.ts, which owns bridges/survivors/spawning) whether the session can
 * take a turn NOW (`probe`, synchronous), writes the batch `sending`, then
 * hands it over (`handOver`) and writes the outcome. The wiring holds the
 * session's delivery reservation (BUG-191's `deliveryInFlight`) across all of
 * it, so no socket path can race a second prompt in.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dataDir } from '../lib/paths.ts';
import { isWriter, holdsLock, onWriterLost, writerDataDir } from './lanes.ts';
import { attachmentManifest, type AttachmentRef } from './attachments.ts';

export type OutboxState = 'queued' | 'sending' | 'delivered' | 'uncertain' | 'failed' | 'discarded';

/** How the server would resume this session if no bridge holds it — the tab's settings when the row was made. */
export interface ResumeSettings {
  projectId: string;
  encodedDir: string | null;
  overrides: Record<string, unknown> | null;
  templateIds: string[] | null;
  /**
   * BUG-284 — the project INCARNATION (registry.ts `incarnationOf`) this row was queued for. A project id can be
   * reused (delete + re-add under the same name, scratch delete + re-ensure); an incarnation never is. Stamped by the
   * outbox itself when the row is minted (`bindResume`, the one place both minters go through) unless the caller names
   * the incarnation it means (FEAT-200: the request's own). Delivery never RESUMES or STARTS a session into a project
   * whose incarnation differs (`targetOf`). Absent on rows written before BUG-284: read by the legacy rule (the
   * project's row must predate the queue row).
   */
  projectIncarnation?: string;
}

export interface OutboxRow {
  id: string;
  nonce: string;
  /** Delivery order — assigned by the server when the row is made. */
  seq: number;
  text: string;
  /**
   * FEAT-177 — durable attachment REFERENCES (not bytes). The blob store holds
   * the bytes, content-addressed; the ledger carries only references, so a
   * message queued behind a busy session is redelivered with its attachments
   * intact. Optional + absent-defaults-to-none, so every legacy text-only row
   * loads and delivers byte-for-byte unchanged.
   */
  attachments?: AttachmentRef[];
  /** `queued`: typed while Claude was working. `direct`: a typed send the session could not take at once. */
  origin: 'queued' | 'direct';
  state: OutboxState;
  /** Plain words for the dock: why it failed / is uncertain. */
  reason: string | null;
  createdAt: number;
  updatedAt: number;
  /** Interrupt & send: goes alone, first, at the boundary. */
  forced: boolean;
  /** The user's Send now over "another program is writing this session". */
  overrideExternal: boolean;
  /** Which route handed it over. */
  via: string | null;
  /** The transcript shows it arrived. */
  confirmed: boolean;
  sentAt: number | null;
  /** Transcript size just before the handover — where to look for its ref. */
  sizeAtSend: number | null;
  resume: ResumeSettings;
  /** Hash of the create request — a replayed nonce must carry the same request. */
  payload: string;
  /** A second record of the row with this id's nonce (a write that failed part-way): kept, never delivered. */
  duplicateOf?: string;
  /** BUG-253: a START row (a new session's first message) — the sdk session id of the session it started. */
  startedAs?: string;
  /** BUG-253: a start row the user sent again (Send again / Send anyway) — its new attempt is shown while it runs. */
  retried?: boolean;
  /** BUG-253: which attempt of a start row is current (1 at mint, +1 per Send again) — an older attempt's outcome never lands on it. */
  attempt?: number;
  /** BUG-253: a session an OLDER attempt started after the row had moved on (recorded, never a state change). */
  alsoStartedAs?: string[];
}

export interface OutboxHold { kind: string; text: string; drain?: unknown }

export interface ProbeWait { kind: 'wait'; hold: OutboxHold; retryMs?: number }
/**
 * A go for some delivery route. BUG-284 / FEAT-200 r12: there is ONE incarnation chokepoint — `pump` checks every
 * row is still bound to the project registered under its id BEFORE it splits on the route, so no route can opt out.
 * (The earlier `running: true` escape hatch let a bridge/survivor route skip the check; it delivered an access
 * request's "access granted" into a still-running session of a deleted-and-re-added project. Removed: the running
 * route is now checked like every other.)
 */
export interface ProbeGo { kind: 'go'; route: string; ctx?: unknown }
export type Probe = ProbeWait | ProbeGo;
export type HandOutcome =
  | { kind: 'delivered'; via: string; startedAs?: string }
  | { kind: 'refused'; hold: OutboxHold; retryMs?: number }
  | { kind: 'uncertain'; reason: string }
  | { kind: 'failed'; reason: string };

export interface OutboxWiring {
  /** Can the session take a turn right now? Synchronous: nothing may change between this and the handover. */
  probe(sessionId: string, resume: ResumeSettings, opts: { overrideExternal: boolean; forced: boolean }): Probe;
  /** Take / release the session's delivery reservation (shared with the socket paths). */
  reserve(sessionId: string): () => void;
  /** Hand the prompt over. Must not throw synchronously before it has either handed over or refused. FEAT-177: `attachments` ride with it. */
  handOver(sessionId: string, go: ProbeGo, prompt: string, resume: ResumeSettings, attachments?: AttachmentRef[]): Promise<HandOutcome>;
  /** The receiver's record: does the session transcript contain `needle` after `from` bytes? null = unreadable. */
  transcriptHas(sessionId: string, resume: ResumeSettings, needle: string, from: number): boolean | null;
  transcriptSize(sessionId: string, resume: ResumeSettings): number | null;
  /** Interrupt a busy bridge (FEAT-031); resolves once the interrupt has been sent. */
  interrupt(sessionId: string): Promise<void> | null;
  /** Something changed that a driving tab should see at once (the outbox-turn event etc.). */
  announce(sessionId: string, e: { t: 'outbox-turn'; sessionId: string; text: string; ids: string[]; attachments?: AttachmentRef[] }): void;
  /**
   * BUG-284 — the project row registered under `projectId` NOW: its incarnation and when the row was created (ms).
   * null = no project has this id. THROWS when the registry cannot be read (then nothing is resumed or started).
   * Absent (test harnesses that never resume into a project) = rows are neither stamped nor checked.
   */
  projectIdentity?(projectId: string): { incarnation: string; createdAt: number } | null;
}

interface Box {
  sid: string;
  rows: Map<string, OutboxRow>;
  byNonce: Map<string, string>;
  seq: number;
  lsn: number;
  lines: number;
  damaged: { at: number; detail: string } | null;
  /** The damage notice is newer than the disk: the next line written carries it. */
  damagePending: boolean;
  /** Rows whose state in memory is newer than on disk (a follow-up write failed); the next line written carries them. */
  unsaved: Map<string, OutboxRow>;
  hold: OutboxHold | null;
  nextTryAt: number;
  reserved: boolean;
  /** Consecutive refusals of a resume, for backoff. */
  refusals: number;
  interrupting: Promise<void> | null;
  /** BUG-253: a finished start box whose journal was removed — dropped from memory once its `recent` window passes. */
  gcAt: number | null;
}

const SID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const NONCE_RE = /^[A-Za-z0-9._:-]{8,128}$/;
export const MAX_TEXT = 200_000;
/** A row delivered this recently and not yet seen in the transcript is checked again after a restart. */
const RECOVER_WINDOW_MS = 10 * 60_000;
/** How long an `uncertain` row keeps looking for its ref in the transcript. */
const UNCERTAIN_RECHECK_MS = 10 * 60_000;
const TICK_MS = 500;

const boxes = new Map<string, Box>();
let wiring: OutboxWiring | null = null;
let timer: NodeJS.Timeout | null = null;
/** The server is going down: hand nothing more over (a turn started now would be orphaned mid-handover). */
let stopped = false;

export class OutboxError extends Error {
  readonly status: number;
  readonly extra: Record<string, unknown>;
  constructor(message: string, status: number, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/*
 * Round 9: the outbox lives in the directory this process holds LOCKED, reached through the lock's own fd where
 * the kernel offers it (`lanes.writerDataDir()`), so a write that races the dir being moved lands in the dir this
 * server owns, never in a copy that now sits at the path.
 */
function root(): string { return path.join(writerDataDir(), 'outbox'); }
/** True only while the lost-claim cleanup writes its "not confirmed" marks into the dir this process still holds. */
let draining = false;
const mayWrite = (): boolean => isWriter() || (draining && holdsLock());

/*
 * ONE WRITER PER DATA DIR (round 7). Each process holds its journals in its own
 * memory and never re-reads them, so a second process writing the same outbox
 * would send the same row again (the round-6 clean-room: two servers, CLI ×2).
 * The server takes the data dir's kernel lock at boot (`lanes.claimDataDir`); any
 * other process that reaches this module — a script, a harness — must hold it
 * too, or nothing here writes, and a row is never marked `sending`, so it is
 * never handed over from here.
 */
function notWriter(): OutboxError {
  return new OutboxError(`this process does not hold the lock on the data dir ${dataDir()}, so it cannot change the queue — another Orchard server owns it`, 503, { notWriter: true });
}
function journalOf(sid: string): string { return path.join(root(), `${sid}.jsonl`); }
function headOf(sid: string): string { return path.join(root(), `${sid}.head`); }

export function validSessionId(sid: unknown): sid is string {
  return typeof sid === 'string' && SID_RE.test(sid) && !sid.includes('..');
}

function fsyncDir(dir: string): void {
  let fd: number | null = null;
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); } catch { /* best effort: not every fs allows a dir fsync */ } finally { if (fd != null) { try { fs.closeSync(fd); } catch { /* never after a commit (round 6) */ } } }
}

/* ------------------------------------------------------------------ loading */

function blankBox(sid: string): Box {
  return { sid, rows: new Map(), byNonce: new Map(), seq: 0, lsn: 0, lines: 0, damaged: null, damagePending: false, unsaved: new Map(), hold: null, nextTryAt: 0, reserved: false, refusals: 0, interrupting: null, gcAt: null };
}

function isRow(v: unknown): v is OutboxRow {
  const r = v as OutboxRow;
  return !!r && typeof r.id === 'string' && typeof r.nonce === 'string' && typeof r.text === 'string'
    && typeof r.seq === 'number' && typeof r.state === 'string' && !!r.resume && typeof r.resume.projectId === 'string'
    // FEAT-177: a persisted attachments field, when present, must be an array (a malformed one fails loudly via damage mode, never a silent drop).
    && (r.attachments === undefined || Array.isArray(r.attachments));
}

function load(sid: string): Box {
  const box = blankBox(sid);
  const file = journalOf(sid);
  let text: string | null = null;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Cannot read what it holds: refuse everything for this session rather than pretend it is empty.
      throw new OutboxError(`the saved queue for this session cannot be read (${(err as Error).message})`, 500);
    }
  }
  if (text === null) return box;
  const problems: string[] = [];
  let head: number | null = null;
  try { head = Number(JSON.parse(fs.readFileSync(headOf(sid), 'utf8'))?.lsn); } catch (err) {
    // The head is a lower bound written AFTER each commit (round 6): a missing one is a head write that failed
    // (or never ran) after a saved line — not damage. An unreadable one is (it is only ever renamed into place whole).
    if (text.trim() && (err as NodeJS.ErrnoException).code !== 'ENOENT') problems.push('its head record is unreadable');
  }
  const segs = text.split('\n');
  let expect = 1;
  let parsed = 0;
  /*
   * A cut-off LAST line (no newline after it) is a write whose fsync never
   * returned: the process died mid-write. That line was never the truth, and
   * nothing it described took effect — a row is handed over only after its
   * `sending` line is saved, and no request is answered before its line is. So
   * it is dropped, not read as damage: before round 7 it turned every unrelated,
   * fully saved row into "not confirmed" (the clean-room's minor finding). A
   * cut-off line anywhere ELSE, or a gap, is still damage.
   */
  let torn: string | null = null;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (!s.trim()) continue;
    let o: { lsn?: unknown; rows?: unknown; damaged?: unknown; snapshot?: unknown } | null = null;
    try { o = JSON.parse(s); } catch { /* below */ }
    if (!o || typeof o !== 'object' || typeof o.lsn !== 'number') {
      if (i === segs.length - 1) torn = s;
      else problems.push(`line ${i + 1} is unreadable`);
      continue;
    }
    // A compaction's snapshot starts the file at its own number (the sequence never goes back, so a lagging head stays consistent).
    if (o.snapshot === true) {
      if (parsed === 0) expect = o.lsn;
      else problems.push(`line ${i + 1} is a snapshot in the middle of the file`);
    }
    parsed++;
    if (o.lsn !== expect) problems.push(`line ${i + 1} is out of sequence (${o.lsn}, expected ${expect})`);
    expect = o.lsn + 1;
    box.lsn = Math.max(box.lsn, o.lsn);
    box.lines++;
    if (Array.isArray(o.rows)) {
      for (const r of o.rows) {
        if (!isRow(r)) { problems.push(`line ${i + 1} holds a malformed row`); continue; }
        box.rows.set(r.id, { ...r });
        box.seq = Math.max(box.seq, r.seq);
      }
    }
    if ('damaged' in o) box.damaged = (o.damaged as Box['damaged']) ?? null;
  }
  if (head != null && Number.isFinite(head) && head > box.lsn) problems.push(`it ends at line ${box.lsn} but was written up to line ${head} — it was truncated`);
  if (torn !== null) {
    // Cut the unsaved fragment off, so the next line does not land after it and read as a damaged line in the middle.
    // Only when nothing else is wrong: a head AHEAD of the last whole line means a SAVED line was lost (damage, and
    // the copy set aside must keep every byte), and the damage path below rewrites the journal anyway.
    let cut = false;
    if (!problems.length && isWriter()) {
      let fd: number | null = null;
      try {
        fd = fs.openSync(file, 'r+');
        // Bytes, not the decoded text: a fragment cut inside a multi-byte character decodes to a different length.
        const raw = fs.readFileSync(fd);
        const keep = raw.lastIndexOf(0x0a) + 1;
        if (raw.toString('utf8') === text && raw.subarray(keep).toString('utf8') === torn) { fs.ftruncateSync(fd, keep); fs.fsyncSync(fd); cut = true; }
      } catch { /* below */ } finally { if (fd != null) { try { fs.closeSync(fd); } catch { /* the cut is already durable or not made */ } } }
    }
    if (cut) console.error(`[orchard] BUG-217: outbox ${sid}: dropped a cut-off last line (${Buffer.byteLength(torn, 'utf8')} bytes) — a write the process died in the middle of, never saved and never acted on; every saved row is unaffected`);
    else problems.push('its last line is cut off');
  }
  const now = Date.now();
  const fixes: OutboxRow[] = [];
  /*
   * One row per (session, nonce). Two rows under one nonce are one message
   * recorded twice (a write that failed after it was already on disk, and the
   * tab's replay). The FIRST is kept; every later one is marked a duplicate and
   * is never delivered. If any copy may already have gone to Claude — or the
   * user already acted on one — the kept row is not sent by itself: it asks.
   */
  const groups = new Map<string, OutboxRow[]>();
  for (const r of [...box.rows.values()].sort((a, b) => a.seq - b.seq)) {
    if (r.duplicateOf) continue;
    const g = groups.get(r.nonce);
    if (g) g.push(r); else groups.set(r.nonce, [r]);
  }
  const live = (s: OutboxState) => s === 'queued' || s === 'sending' || s === 'uncertain' || s === 'failed';
  let dupNonces = 0;
  for (const [nonce, g] of groups) {
    const keep = g[0];
    box.byNonce.set(nonce, keep.id);
    if (g.length === 1) continue;
    dupNonces++;
    for (const d of g.slice(1)) {
      fixes.push(live(d.state)
        ? { ...d, duplicateOf: keep.id, state: 'discarded', updatedAt: now, reason: 'a second record of a message Orchard already holds — only one copy is kept' }
        : { ...d, duplicateOf: keep.id });
    }
    if (live(keep.state) && g.some((r) => r !== keep && r.state !== 'queued')) {
      fixes.push({ ...keep, state: 'uncertain', updatedAt: now, reason: 'Orchard recorded this message twice after a failed disk write, and another copy may already have gone to Claude — check the conversation, then Send anyway or Discard' });
    }
  }
  for (const r of box.rows.values()) {
    // A duplicate record is never deliverable, and the index points only at the kept row.
    if (r.duplicateOf && live(r.state) && !fixes.some((f) => f.id === r.id)) fixes.push({ ...r, state: 'discarded', updatedAt: now });
    if (r.duplicateOf && !box.byNonce.has(r.nonce)) box.byNonce.set(r.nonce, r.id);
  }
  for (const f of fixes) box.rows.set(f.id, f);
  let dupDamage = false;
  if (dupNonces) {
    const detail = `it held ${dupNonces === 1 ? 'one message' : `${dupNonces} messages`} twice (a disk write had failed part-way) — only one copy of each is kept`;
    console.error(`[orchard] BUG-217: the outbox of session ${sid} held duplicate records: ${detail}; none of the extra copies will be sent`);
    box.damaged = { at: now, detail };
    dupDamage = true;
  }
  if (problems.length) {
    const detail = problems.join('; ');
    console.error(`[orchard] BUG-217: the outbox of session ${sid} is DAMAGED (${detail}) — every message it had not finished is now marked "not confirmed"; nothing is sent from it until the user decides`);
    if (isWriter()) { try { fs.copyFileSync(file, `${file}.corrupt-${now}`); } catch { /* the rewrite below still leaves it readable */ } }
    box.damaged = { at: now, detail: box.damaged && dupDamage ? `${detail}; ${box.damaged.detail}` : detail };
    for (const r of box.rows.values()) {
      if (r.state === 'queued' || r.state === 'sending') {
        const f: OutboxRow = { ...r, state: 'uncertain', updatedAt: now, reason: 'Orchard’s saved queue for this session was damaged, so it cannot tell whether this was already sent — check the conversation, then Send anyway or Discard' };
        box.rows.set(f.id, f);
        fixes.push(f);
      }
    }
  }
  for (const r of box.rows.values()) {
    if (r.state === 'sending') {
      const f: OutboxRow = { ...r, state: 'uncertain', updatedAt: now, reason: isStartBox(sid) ? START_RESTART_REASON : 'Orchard stopped while sending this, so it may or may not have arrived — check the conversation, then Send anyway or Discard' };
      box.rows.set(f.id, f);
      fixes.push(f);
    }
  }
  /*
   * Everything above is DERIVED from the disk, so a failure to persist it
   * changes nothing: memory holds it, and the next load derives the same.
   */
  if (problems.length) {
    // Rewrite a clean journal from what survived (the damaged copy is kept beside it).
    if (!compact(box)) {
      box.damagePending = true;
      for (const f of fixes) box.unsaved.set(f.id, f);
    }
  } else if (fixes.length || dupDamage) {
    try { append(box, fixes, dupDamage ? { damaged: box.damaged } : {}); } catch (err) {
      console.error(`[orchard] BUG-217: outbox ${sid}: what loading settled could not be saved (${(err as Error).message}) — it is held in memory and saved with the next write`);
      if (dupDamage) box.damagePending = true;
      for (const f of fixes) box.unsaved.set(f.id, f);
    }
  }
  return box;
}

/** Recovery for rows a crash may have left mid-flight: the transcript is the receiver's record. */
function recover(box: Box): void {
  if (!wiring || isStartBox(box.sid)) return; // BUG-253: a start box has no transcript of its own
  const now = Date.now();
  const out: OutboxRow[] = [];
  for (const r of box.rows.values()) {
    const recent = r.sentAt != null && now - r.sentAt < RECOVER_WINDOW_MS;
    if (!recent || r.confirmed) continue;
    if (r.state !== 'delivered' && r.state !== 'uncertain') continue;
    const has = wiring.transcriptHas(box.sid, r.resume, r.id, 0);
    if (has === true) out.push({ ...r, state: 'delivered', confirmed: true, reason: null, updatedAt: now });
    else if (r.state === 'delivered') {
      out.push({ ...r, state: 'uncertain', updatedAt: now, reason: 'Orchard restarted right after handing this over, and it is not in the conversation yet — it may not have arrived. Check, then Send anyway or Discard' });
    }
  }
  if (!out.length) return;
  // Derived from the disk and the receiver's record: if it cannot be saved now, memory holds it and the next write carries it.
  try { append(box, out); } catch (err) {
    console.error(`[orchard] BUG-217: outbox ${box.sid}: the recovery check could not be saved (${(err as Error).message}) — held in memory, saved with the next write`);
    for (const r of out) { box.rows.set(r.id, r); box.unsaved.set(r.id, r); }
  }
}

function boxOf(sid: string): Box {
  const hit = boxes.get(sid);
  if (hit) return hit;
  const b = load(sid);
  boxes.set(sid, b);
  recover(b);
  return b;
}

/* ------------------------------------------------------------------ writing */

/** Test-only crash point: SIGKILL this process right after the named transition is on disk. */
function crashPoint(name: string): void {
  if (process.env.ORCHARD_TEST_OUTBOX_CRASH_AT === name && process.env.CLAUDE_STATION_DATA) {
    console.error(`[orchard] BUG-217 test crash point: ${name}`);
    process.kill(process.pid, 'SIGKILL');
  }
}

const errText = (err: unknown) => { const e = err as NodeJS.ErrnoException; return e?.code ? `${e.code}${e.code === 'ENOSPC' ? ': the disk is full' : e.code === 'EIO' ? ': a disk read/write error' : ''}` : String((err as Error)?.message ?? err); };

/** Write every byte (a filling disk may store only part of a write and say so). */
function writeAll(fd: number, buf: Buffer): void {
  let off = 0;
  while (off < buf.length) {
    const n = fs.writeSync(fd, buf, off, buf.length - off);
    if (!(n > 0)) throw Object.assign(new Error('the disk stored nothing of a write'), { code: 'ENOSPC' });
    off += n;
  }
}

/**
 * THE COMMIT POINT: append one line to the journal and fsync it — or leave the
 * file exactly as it was and throw. Returns the line's number once it is the
 * truth. Nothing else here may throw after that.
 */
function commitLine(box: Box, obj: Record<string, unknown>): number {
  const dir = root();
  const file = journalOf(box.sid);
  const lsn = box.lsn + 1;
  const notSaved = (err: unknown) => new OutboxError(`Orchard could not save this to disk (${errText(err)}), so nothing was changed — it keeps what it had; try again when the disk has room`, 500, { disk: true });
  if (!mayWrite()) throw notWriter();
  let fresh: boolean;
  let fd: number;
  try {
    fresh = !fs.existsSync(file);
    if (fresh) fs.mkdirSync(dir, { recursive: true });
    fd = fs.openSync(file, 'a+', 0o600);
  } catch (err) { throw notSaved(err); }
  let size = -1;
  try {
    size = fs.fstatSync(fd).size;
    // A line always starts on a line of its own: a torn tail left by an earlier failure stays a separate
    // (reported) line instead of swallowing this one.
    let lead = '';
    if (size > 0) { const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, size - 1); if (b[0] !== 0x0a) lead = '\n'; }
    writeAll(fd, Buffer.from(`${lead}${JSON.stringify({ lsn, ...obj })}\n`, 'utf8'));
    fs.fsyncSync(fd);
  } catch (err) {
    // Not committed. Undo whatever reached the file, so a thrown error means nothing changed.
    let undone = size < 0; // nothing was written before we knew where the file ended
    if (!undone) { try { fs.ftruncateSync(fd, size); fs.fsyncSync(fd); undone = true; } catch { /* below */ } }
    try { fs.closeSync(fd); } catch { /* the error that matters is the write's */ }
    if (!undone) {
      // Cannot tell whether the line is on disk. Burn its number (a reload finds the line, or a gap — loud), and
      // go into damaged mode, so a replayed request arrives "not confirmed" instead of becoming a second message.
      box.lsn = lsn;
      box.damaged ??= { at: Date.now(), detail: `a write to it failed part-way (${errText(err)}) and could not be undone, so Orchard cannot tell whether that change was saved` };
      box.damagePending = true;
      console.error(`[orchard] BUG-217: outbox ${box.sid}: a journal write failed (${errText(err)}) and could not be rolled back — line ${lsn} may or may not be on disk; the session is in damaged mode`);
      throw new OutboxError(`Orchard could not save this to disk (${errText(err)}) and cannot tell whether it was kept — check the queue before trying again`, 500, { disk: true, unsure: true });
    }
    throw notSaved(err);
  }
  try { fs.closeSync(fd); } catch { /* the line is already durable */ }
  if (fresh) fsyncDir(dir);
  box.lsn = lsn;
  box.lines++;
  return lsn;
}

let tmpN = 0;
/** The head is a LOWER bound on the journal's last line, written after the commit. It may lag; it never throws. */
function writeHead(box: Box, lsn: number): void {
  if (!mayWrite()) return;
  const file = headOf(box.sid);
  const tmp = `${file}.tmp-${process.pid}-${++tmpN}`;
  try {
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { writeAll(fd, Buffer.from(JSON.stringify({ lsn }))); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never made, or already renamed */ }
    console.error(`[orchard] BUG-217: outbox ${box.sid}: the head record could not be updated (${errText(err)}) — it lags the journal, which is harmless: the journal line is saved`);
  }
}

/**
 * Put rows on disk, THEN in memory. Throws only when the line was not saved
 * (and then nothing changed); once it is saved, memory and the nonce index
 * follow at once, before the head or a compaction can fail.
 */
function append(box: Box, rows: OutboxRow[], extra: { damaged?: Box['damaged'] } = {}): void {
  // Carry anything memory holds that the disk does not yet (a follow-up write that failed earlier).
  const carry = [...box.unsaved.values()].filter((u) => !rows.some((r) => r.id === u.id));
  const obj: Record<string, unknown> = { rows: [...carry, ...rows] };
  if ('damaged' in extra) obj.damaged = extra.damaged;
  else if (box.damagePending) obj.damaged = box.damaged;
  const lsn = commitLine(box, obj);
  // ── committed: from here this line is the truth ──
  box.unsaved.clear();
  if ('damaged' in obj) { box.damaged = (obj.damaged as Box['damaged']) ?? null; box.damagePending = false; }
  for (const r of [...carry, ...rows]) {
    box.rows.set(r.id, r);
    if (!r.duplicateOf) box.byNonce.set(r.nonce, r.id);
    box.seq = Math.max(box.seq, r.seq);
  }
  writeHead(box, lsn);
  if (box.lines > 64 + 4 * box.rows.size) compact(box);
}

/**
 * Rewrite the journal as ONE snapshot line of everything in memory. Its one
 * step is the rename; before it nothing changed, after it the snapshot is the
 * truth. Never throws: it is housekeeping, and a failure leaves the old journal.
 */
function compact(box: Box): boolean {
  if (!mayWrite()) return false;
  const dir = root();
  const file = journalOf(box.sid);
  const tmp = `${file}.tmp-${process.pid}-${++tmpN}`;
  const lsn = box.lsn + 1;
  const rows = [...box.rows.values()].sort((a, b) => a.seq - b.seq);
  let renamed = false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { writeAll(fd, Buffer.from(`${JSON.stringify({ lsn, snapshot: true, rows, damaged: box.damaged })}\n`, 'utf8')); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.renameSync(tmp, file); renamed = true; } catch (err) {
      // A rename either happened or did not; if the temp file is gone, it happened.
      if (fs.existsSync(tmp)) throw err;
      renamed = true;
    }
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never made */ }
    console.error(`[orchard] BUG-217: outbox ${box.sid}: compaction could not be saved (${errText(err)}) — the journal is unchanged`);
    return false;
  }
  // ── committed ──
  box.lsn = lsn;
  box.lines = 1;
  box.unsaved.clear();
  box.damagePending = false;
  fsyncDir(dir);
  writeHead(box, lsn);
  return renamed;
}

/* ------------------------------------------------------------------ reading */

export interface OutboxView {
  sessionId: string;
  rows: Array<Pick<OutboxRow, 'id' | 'nonce' | 'seq' | 'text' | 'origin' | 'state' | 'reason' | 'createdAt' | 'updatedAt' | 'forced' | 'via'>>;
  /** Rows that finished in the last two minutes — so a tab can say "sent", and follow a turn it did not start. */
  recent: Array<Pick<OutboxRow, 'id' | 'nonce' | 'state' | 'via' | 'updatedAt'>>;
  hold: OutboxHold | null;
  damaged: Box['damaged'];
}

const RECENT_MS = 120_000;
function view(box: Box): OutboxView {
  // A duplicate record is bookkeeping, never a message the user has: it is not shown at all.
  const all = [...box.rows.values()].filter((r) => !r.duplicateOf).sort((a, b) => a.seq - b.seq);
  const rows = all
    .filter((r) => r.state !== 'delivered' && r.state !== 'discarded')
    .map(({ id, nonce, seq, text, origin, state, reason, createdAt, updatedAt, forced, via }) => ({ id, nonce, seq, text, origin, state, reason, createdAt, updatedAt, forced, via }));
  const now = Date.now();
  const recent = all
    .filter((r) => (r.state === 'delivered' || r.state === 'discarded') && now - r.updatedAt < RECENT_MS)
    .map(({ id, nonce, state, via, updatedAt }) => ({ id, nonce, state, via, updatedAt }));
  return { sessionId: box.sid, rows, recent, hold: rows.some((r) => r.state === 'queued') ? box.hold : null, damaged: box.damaged };
}

export function outboxView(sid: string): OutboxView {
  if (!validSessionId(sid)) throw new OutboxError('bad session id', 400);
  return view(boxOf(sid));
}

/** Has this session ever had an outbox (in memory or on disk)? A read of an unknown id creates nothing. */
export function outboxExists(sid: string): boolean {
  return validSessionId(sid) && (boxes.has(sid) || fs.existsSync(journalOf(sid)));
}

/** Does this session hold a row still waiting to go (so a typed prompt must queue behind it)? */
export function outboxHasPending(sid: string | null | undefined): boolean {
  if (!sid || !validSessionId(sid)) return false;
  const b = boxes.get(sid);
  if (!b) {
    if (!fs.existsSync(journalOf(sid))) return false;
    try { return [...boxOf(sid).rows.values()].some((r) => r.state === 'queued' || r.state === 'sending'); } catch { return false; }
  }
  return [...b.rows.values()].some((r) => r.state === 'queued' || r.state === 'sending');
}

/** The state of one row (tests, and the delivered/discarded answer to a late edit). */
export function outboxRow(sid: string, id: string): OutboxRow | null {
  if (!validSessionId(sid)) return null;
  return boxOf(sid).rows.get(id) ?? null;
}

/* ---------------------------------------------------------------- mutations */

export interface CreateRequest {
  nonce: string;
  text: string;
  /** FEAT-177 — resolved attachment references (server-validated before enqueue). */
  attachments?: AttachmentRef[];
  origin?: 'queued' | 'direct';
  /** A client may only make a row MORE cautious: `uncertain` or `failed` rows are never sent by themselves. */
  initial?: 'queued' | 'uncertain' | 'failed';
  reason?: string | null;
  /**
   * The user discarded this row before the server acknowledged it. If the
   * nonce is known the row is discarded (when it still can be); otherwise it
   * is recorded already discarded, so it can never be delivered.
   */
  discard?: boolean;
  resume: ResumeSettings;
}

function payloadOf(req: CreateRequest): string {
  // FEAT-177 (review #4): the attachment manifest is part of the request identity,
  // so a replayed nonce with the same text but a DIFFERENT image is detected as a
  // different request (409) rather than returning the original row.
  return crypto.createHash('sha256').update(JSON.stringify([req.text, req.origin ?? 'queued', req.initial ?? 'queued', req.reason ?? null, attachmentManifest(req.attachments)])).digest('hex').slice(0, 24);
}

/**
 * BUG-284 — the ONE place a row's resume target is bound to a project INCARNATION, used by both row minters
 * (`createOutboxRow`, `mintStartRow`). A caller that names the incarnation it means keeps it (FEAT-200 passes the
 * access request's own, which may already be gone); otherwise the project's current incarnation is stamped. Nothing
 * is stamped when it cannot be known (no wiring yet, no such project, unreadable registry): the row then falls under
 * the legacy rule at delivery, which can only refuse a project created after the row.
 */
function bindResume(resume: ResumeSettings): ResumeSettings {
  const { projectIncarnation, ...rest } = resume;
  if (typeof projectIncarnation === 'string' && projectIncarnation) return { ...rest, projectIncarnation };
  let inc: string | null = null;
  try { inc = wiring?.projectIdentity?.(resume.projectId)?.incarnation ?? null; } catch { inc = null; }
  return inc ? { ...rest, projectIncarnation: inc } : rest;
}

export function createOutboxRow(sid: string, req: CreateRequest): { row: OutboxRow; created: boolean; view: OutboxView } {
  if (!validSessionId(sid)) throw new OutboxError('bad session id', 400);
  // BUG-253: a start box is minted only by the start route (mintStartRow), never by a client.
  if (isStartBox(sid)) throw new OutboxError('a new session’s first message is recorded by the start itself', 400);
  if (typeof req.nonce !== 'string' || !NONCE_RE.test(req.nonce)) throw new OutboxError('a nonce (8–128 chars of [A-Za-z0-9._:-]) is required', 400);
  // FEAT-177 (review #9): a message is valid with nonblank text OR at least one attachment.
  const hasAttachments = Array.isArray(req.attachments) && req.attachments.length > 0;
  if (typeof req.text !== 'string') throw new OutboxError('text is required', 400);
  if (!req.text.trim() && !hasAttachments) throw new OutboxError('text is required', 400);
  if (req.text.length > MAX_TEXT) throw new OutboxError(`text is longer than ${MAX_TEXT} characters`, 413);
  const box = boxOf(sid);
  const payload = payloadOf(req);
  const known = box.byNonce.get(req.nonce);
  if (known) {
    const row = box.rows.get(known)!;
    // Idempotent: the same request again is the same row. A different request under the same nonce is a bug, never a merge.
    if (row.payload !== payload) throw new OutboxError('this nonce was already used for a different message', 409, { row: { id: row.id, state: row.state } });
    if (req.discard && (row.state === 'queued' || row.state === 'uncertain' || row.state === 'failed')) {
      const gone: OutboxRow = { ...row, state: 'discarded', updatedAt: Date.now() };
      append(box, [gone]);
      return { row: gone, created: false, view: view(box) };
    }
    return { row, created: false, view: view(box) };
  }
  const now = Date.now();
  let state: OutboxState = req.discard ? 'discarded' : req.initial === 'uncertain' || req.initial === 'failed' ? req.initial : 'queued';
  let reason = state === 'queued' ? null : (typeof req.reason === 'string' && req.reason.trim() ? req.reason.trim().slice(0, 400) : null);
  if (state === 'queued' && box.damaged) {
    // A lost line could have held this nonce (already delivered): ask rather than send.
    state = 'uncertain';
    reason = 'Orchard’s saved queue for this session was damaged, so it cannot tell whether this was already sent — check the conversation, then Send anyway or Discard';
  }
  if (state === 'uncertain' && !reason) reason = 'it may already have been sent — check the conversation, then Send anyway or Discard';
  if (state === 'failed' && !reason) reason = 'it was not sent';
  const row: OutboxRow = {
    id: `q${crypto.randomBytes(8).toString('hex')}`,
    nonce: req.nonce,
    seq: box.seq + 1,
    text: req.text,
    ...(hasAttachments ? { attachments: req.attachments } : {}),
    origin: req.origin === 'direct' ? 'direct' : 'queued',
    state,
    reason,
    createdAt: now,
    updatedAt: now,
    forced: false,
    overrideExternal: false,
    via: null,
    confirmed: false,
    sentAt: null,
    sizeAtSend: null,
    resume: bindResume(req.resume),
    payload,
  };
  append(box, [row]);
  crashPoint('created');
  holdNow(box);
  kick(sid);
  return { row, created: true, view: view(box) };
}

function mutable(box: Box, id: string, verb: string, allowed: OutboxState[]): OutboxRow {
  const row = box.rows.get(id);
  if (!row) throw new OutboxError(`no queued message ${id} in this session`, 404);
  if (!allowed.includes(row.state)) {
    const why = row.state === 'sending' ? 'it is being sent right now'
      : row.state === 'delivered' ? 'it has already been sent'
        : row.state === 'discarded' ? 'it was discarded'
          : `it is ${row.state}`;
    throw new OutboxError(`cannot ${verb} this message: ${why}`, 409, { row: { id: row.id, state: row.state } });
  }
  return row;
}

export function editOutboxRow(sid: string, id: string, text: unknown): OutboxView {
  if (typeof text !== 'string' || !text.trim()) throw new OutboxError('text is required (Discard removes a message)', 400);
  if (text.length > MAX_TEXT) throw new OutboxError(`text is longer than ${MAX_TEXT} characters`, 413);
  const box = boxOf(sid);
  const row = mutable(box, id, 'edit', ['queued', 'uncertain', 'failed']);
  append(box, [{ ...row, text, updatedAt: Date.now() }]);
  crashPoint('edited');
  return view(box);
}

export function discardOutboxRow(sid: string, id: string): OutboxView {
  const box = boxOf(sid);
  const row = mutable(box, id, 'discard', ['queued', 'uncertain', 'failed']);
  append(box, [{ ...row, state: 'discarded', updatedAt: Date.now() }]);
  crashPoint('discarded');
  gcStartBox(box); // BUG-253: a discarded first message leaves nothing to keep
  kick(sid);
  return view(box);
}

/**
 * The user's Send anyway / Send again / Send now / Interrupt & send.
 *  - `anyway` (Send anyway, Send again): uncertain | failed → queued, ONCE — a
 *    second press finds it queued, sending or delivered and is refused (409);
 *  - `now` (Send now) on a queued row: it may go past "another program is
 *    writing this session" — the user's say-so over that heuristic;
 *  - `interrupt` on a queued row → FEAT-031: it goes alone, first, and a
 *    running turn is interrupted for it.
 */
export function sendOutboxRow(sid: string, id: string, { interrupt = false, now = false }: { interrupt?: boolean; now?: boolean } = {}): OutboxView {
  const box = boxOf(sid);
  const row = box.rows.get(id);
  if (isStartBox(sid)) {
    // BUG-253: Send again / Send anyway on a first message re-queues it ONCE; the pump starts a new session with it.
    // There is no running turn to interrupt and nothing to push past.
    if (row && row.state === 'queued') throw new OutboxError('this message is already waiting to start a new session', 409, { row: { id: row.id, state: row.state } });
    const r = mutable(box, id, 'send', ['uncertain', 'failed']);
    append(box, [{ ...r, state: 'queued', reason: null, forced: false, overrideExternal: true, retried: true, attempt: (r.attempt ?? 1) + 1, updatedAt: Date.now() }]);
    crashPoint('requeued');
    box.nextTryAt = 0;
    holdNow(box);
    kick(sid);
    return view(box);
  }
  if (row && row.state === 'queued') {
    if (!interrupt && !now) throw new OutboxError('this message is already waiting to be sent', 409, { row: { id: row.id, state: row.state } });
    // A second Interrupt & send for a row already forced asks nothing more: a late second
    // interrupt could land on the forced turn itself (plan review B5).
    if (interrupt && row.forced) return view(box);
    append(box, [{ ...row, forced: row.forced || interrupt, overrideExternal: true, updatedAt: Date.now() }]);
  } else {
    const r = mutable(box, id, 'send', ['uncertain', 'failed']);
    append(box, [{ ...r, state: 'queued', reason: null, forced: interrupt, overrideExternal: true, updatedAt: Date.now() }]);
    crashPoint('requeued');
  }
  if (interrupt && wiring) {
    const p = wiring.interrupt(sid);
    if (p) {
      // The forced row waits until the interrupt has been sent (a later boundary must not swallow it).
      const inter: Promise<void> = p.then(() => undefined, () => undefined);
      box.interrupting = inter;
      void inter.then(() => { if (box.interrupting === inter) box.interrupting = null; kick(sid); });
    }
  }
  box.nextTryAt = 0;
  holdNow(box);
  kick(sid);
  return view(box);
}

export function dismissOutboxDamage(sid: string): OutboxView {
  const box = boxOf(sid);
  if (box.damaged) append(box, [], { damaged: null });
  gcStartBox(box);
  return view(box);
}

/* ------------------------------------------------------- BUG-253: start boxes */

/*
 * A NEW session's first message has no session id to be filed under until the
 * engine names one at `system:init` — and before BUG-253 it lived only in
 * memory until then, so an admission failure, a closed tab, a restart or a CLI
 * that died first lost it without a trace. Each new-session start now gets its
 * own box, `start.<hex>`, holding exactly ONE row, minted `sending` and fsync'd
 * BEFORE anything is spawned (`mintStartRow`). It ends one of two ways:
 *
 *   - the session it started reaches `system:init` → `delivered` with
 *     `startedAs` = that session's id (`settleStartRow`); the box's journal is
 *     then removed — a finished start has nothing left to protect;
 *   - anything else → `failed` (it was never handed to a CLI) or `uncertain`
 *     (it was, and no init proved the session started), shown in the project's
 *     dock (`startsView`) with Send again / Send anyway / Edit / Discard. A
 *     restart reloads a `sending` row as `uncertain` like any other.
 *
 * Send again re-queues it ONCE (the existing rule); the pump then starts a new
 * session with it through the same wiring chokepoint (`route: 'new'`). Nothing
 * else ever makes a start row `queued`, so the pump never touches the original
 * attempt — one writer per attempt.
 */
const START_PREFIX = 'start.';
const START_RESTART_REASON = 'Orchard restarted before the new session for this message confirmed it had started — if no new session with this message is in the list, press Send anyway, otherwise Discard';
export function isStartBox(sid: string | null | undefined): boolean {
  return typeof sid === 'string' && sid.startsWith(START_PREFIX);
}

const TERMINAL = (s: OutboxState) => s === 'delivered' || s === 'discarded';
/**
 * Start boxes whose first attempt a live tab is still WATCHING (the socket that sent it is open, showing its own
 * "starting…"). Memory only: such a row is left out of the dock so the starting tab does not show it twice. The
 * moment that socket closes (`unwatchStartRow`) — or after a restart, when nothing watches anything — a row still
 * `sending` is listed (IV 268766ea: a tab closed while the CLI sat before init left it invisible).
 */
const watchedStarts = new Set<string>();
export function unwatchStartRow(sid: string): void { watchedStarts.delete(sid); }

/** A finished start box loses its journal (best effort); the box stays in memory for its `recent` window. True when finished. */
function gcStartBox(box: Box): boolean {
  if (!isStartBox(box.sid) || box.reserved || box.unsaved.size || box.damagePending || box.damaged) return false;
  const rows = [...box.rows.values()];
  if (rows.length && !rows.every((r) => TERMINAL(r.state))) return false;
  if (box.gcAt != null) return true;
  if (!mayWrite()) return false;
  for (const f of [journalOf(box.sid), headOf(box.sid)]) {
    try { fs.unlinkSync(f); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') { console.error(`[orchard] BUG-253: outbox ${box.sid}: could not remove a finished start's file (${errText(err)}) — harmless, retried at the next boot`); return false; } }
  }
  fsyncDir(root());
  // A later write (none is expected) would start a fresh journal at line 1.
  box.lsn = 0;
  box.lines = 0;
  box.gcAt = Date.now();
  watchedStarts.delete(box.sid);
  return true;
}

export interface StartRowRequest {
  projectId: string;
  text: string;
  attachments?: AttachmentRef[]; // FEAT-177 — first-message attachments, durable across a restart/Send-again
  overrides: Record<string, unknown> | null;
  templateIds: string[] | null;
}

/**
 * Record a new session's first message, on disk, before the start may proceed.
 * Throws (and nothing is recorded) when it cannot be saved — the caller must then
 * refuse the start: a message Orchard could not save is a message it must not run.
 */
export function mintStartRow(req: StartRowRequest, { watched = false }: { watched?: boolean } = {}): { box: string; id: string; attempt: number } {
  // FEAT-177: a first message is valid with text OR an attachment.
  if (typeof req.text !== 'string' || (!req.text.trim() && !(req.attachments && req.attachments.length))) throw new OutboxError('text is required', 400);
  if (typeof req.projectId !== 'string' || !req.projectId) throw new OutboxError('a project is required', 400);
  const sid = `${START_PREFIX}${crypto.randomBytes(8).toString('hex')}`;
  const box = blankBox(sid);
  const now = Date.now();
  const row: OutboxRow = {
    id: `q${crypto.randomBytes(8).toString('hex')}`,
    nonce: `start:${sid}`,
    seq: 1,
    text: req.text,
    ...(req.attachments && req.attachments.length ? { attachments: req.attachments } : {}),
    origin: 'direct',
    state: 'sending',
    reason: null,
    createdAt: now,
    updatedAt: now,
    forced: false,
    overrideExternal: false,
    via: 'start',
    confirmed: false,
    sentAt: now,
    sizeAtSend: null,
    resume: bindResume({ projectId: req.projectId, encodedDir: null, overrides: req.overrides ?? null, templateIds: req.templateIds ?? null }),
    payload: payloadOf({ nonce: `start:${sid}`, text: req.text, resume: { projectId: req.projectId, encodedDir: null, overrides: null, templateIds: null } }),
    attempt: 1,
  };
  try { append(box, [row]); } catch (err) {
    // Refused, so the tab keeps the words. A write that failed "unsure" may still have left the line on disk, where a
    // reboot would bring it back as a second copy — this box is brand new, so its files are removed outright.
    for (const f of [journalOf(sid), headOf(sid)]) { try { fs.unlinkSync(f); } catch { /* never made */ } }
    throw err;
  }
  boxes.set(sid, box);
  if (watched) watchedStarts.add(sid);
  crashPoint('start-minted');
  return { box: sid, id: row.id, attempt: 1 };
}

export type StartSettle =
  | { kind: 'started'; sdkSessionId: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'uncertain'; reason: string };

/**
 * The start route's outcome for its row. FIRST SETTLE WINS: it applies only to a
 * row still `sending` (a `started` may also lift an `uncertain` — only ever toward
 * delivered). Never throws: a write that fails after the decision is held in
 * memory and carried by the next write, and a restart reloads the `sending` line as
 * `uncertain` — never lost, never sent by itself.
 */
export function settleStartRow(sid: string, id: string, attempt: number, o: StartSettle): OutboxRow | null {
  const box = boxes.get(sid);
  const row = box?.rows.get(id);
  if (!box || !row) return null;
  const now = Date.now();
  if ((row.attempt ?? 1) !== attempt) {
    // An OLDER attempt reporting after the user sent it again: never a state change on the current attempt. A
    // session it started is recorded, so the user can be told two sessions may hold the message.
    if (o.kind === 'started') {
      const late: OutboxRow = { ...row, alsoStartedAs: [...(row.alsoStartedAs ?? []), o.sdkSessionId], updatedAt: now };
      try { append(box, [late]); } catch { box.rows.set(id, late); box.unsaved.set(id, late); }
      console.error(`[orchard] BUG-253: outbox ${sid}: attempt ${attempt} started session ${o.sdkSessionId} after the row moved on to attempt ${row.attempt ?? 1} — recorded, the row is unchanged`);
      return late;
    }
    return row;
  }
  if (row.state !== 'sending' && !(o.kind === 'started' && row.state === 'uncertain')) return row;
  const next: OutboxRow = o.kind === 'started'
    ? { ...row, state: 'delivered', confirmed: true, startedAs: o.sdkSessionId, reason: null, updatedAt: now }
    : { ...row, state: o.kind, reason: (o.reason || (o.kind === 'failed' ? 'the new session did not start' : 'it may or may not have started a session')).slice(0, 600), ...(o.kind === 'failed' ? { sentAt: null } : {}), updatedAt: now };
  try { append(box, [next]); } catch (err) {
    console.error(`[orchard] BUG-253: outbox ${sid}: the start's outcome (${o.kind}) could not be written (${(err as Error).message}) — held in memory; a restart before the next write shows it as not confirmed`);
    box.rows.set(id, next);
    box.unsaved.set(id, next);
  }
  crashPoint(`start-${o.kind}`);
  gcStartBox(box);
  return next;
}

export interface StartsView {
  projectId: string;
  rows: Array<OutboxView['rows'][number] & { box: string }>;
  recent: Array<OutboxView['recent'][number] & { box: string; startedAs: string | null; retried: boolean }>;
  /** Start boxes whose saved record was damaged (their row may be missing — then the project is unknown, so every project lists it). */
  damaged: Array<{ box: string; at: number; detail: string }>;
}

/** The one live row of a start box (the pump's Send again needs its id and attempt to settle a late init). */
export function startRowOf(sid: string): { id: string; attempt: number } | null {
  const box = boxes.get(sid);
  if (!box || !isStartBox(sid)) return null;
  const r = [...box.rows.values()].find((x) => !x.duplicateOf);
  return r ? { id: r.id, attempt: r.attempt ?? 1 } : null;
}

/** Every first message of this project the user must act on or watch (dock), and the ones that just finished. */
export function startsView(projectId: string): StartsView {
  const rows: StartsView['rows'] = [];
  const recent: StartsView['recent'] = [];
  const damaged: StartsView['damaged'] = [];
  const now = Date.now();
  for (const box of boxes.values()) {
    if (!isStartBox(box.sid)) continue;
    const mine = [...box.rows.values()].some((r) => r.resume.projectId === projectId);
    if (box.damaged && (mine || !box.rows.size)) damaged.push({ box: box.sid, at: box.damaged.at, detail: box.damaged.detail });
    for (const r of box.rows.values()) {
      if (r.duplicateOf || r.resume.projectId !== projectId) continue;
      const { id, nonce, seq, text, origin, state, reason, createdAt, updatedAt, forced, via } = r;
      if (state === 'queued' || state === 'uncertain' || state === 'failed' || (state === 'sending' && (r.retried || !watchedStarts.has(box.sid)))) {
        rows.push({ id, nonce, seq, text, origin, state, reason, createdAt, updatedAt, forced, via, box: box.sid });
      } else if (TERMINAL(state) && now - updatedAt < RECENT_MS) {
        recent.push({ id, nonce, state, via, updatedAt, box: box.sid, startedAs: r.startedAs ?? null, retried: !!r.retried });
      }
    }
  }
  rows.sort((a, b) => a.createdAt - b.createdAt);
  return { projectId, rows, recent, damaged };
}

/* ------------------------------------------------------------------ delivery */

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, '0')}s`;
}

/** The prompt for a batch: each row keeps its own header (FEAT-031 Part B), and every header carries the row's ref. */
export function composeOutboxPrompt(rows: OutboxRow[], now = Date.now()): string {
  if (rows.length === 1) {
    const r = rows[0];
    const ago = fmtElapsed(now - r.createdAt);
    const head = r.forced
      ? `[Force-sent ${ago} after being queued — in-flight work was interrupted to deliver this immediately. ref ${r.id}]`
      : r.origin === 'direct'
        ? `[Held ${ago} until the session could take it. ref ${r.id}]`
        : `[Queued ${ago} ago, composed while the previous response was still being written — it predates that response. ref ${r.id}]`;
    return `${head}\n${r.text.trim()}`;
  }
  return rows.map((r, i) => {
    const ago = fmtElapsed(now - r.createdAt);
    const what = r.origin === 'direct' ? `held ${ago} until the session could take it` : `queued ${ago} ago, composed while the previous response was still being written`;
    return `[msg ${i + 1}/${rows.length} · ${what} · ref ${r.id}]\n${r.text.trim()}`;
  }).join('\n\n');
}

const settingsKey = (r: OutboxRow) => JSON.stringify([r.resume.projectId, r.resume.encodedDir, r.resume.overrides ?? null, r.resume.templateIds ?? null, r.resume.projectIncarnation ?? null]);

/**
 * BUG-284 — may this row be RESUMED / STARTED into the project registered under its projectId now?
 *  - 'same'    the project the row was queued for (same incarnation; for a legacy row with no stamp, a project row
 *              created no later than the queue row — a row queued before the project existed was queued for another);
 *  - 'gone'    no such project, or another incarnation under the same id (deleted and re-added): never delivered by
 *              resuming — the row fails with the reason, and nobody is told anything it carried;
 *  - 'unknown' the registry cannot be read: wait, never guess.
 * Without the wiring's `projectIdentity` (test harnesses), every row is 'same'.
 */
function targetOf(r: OutboxRow): 'same' | 'gone' | 'unknown' {
  if (!wiring?.projectIdentity) return 'same';
  let id: { incarnation: string; createdAt: number } | null;
  try { id = wiring.projectIdentity(r.resume.projectId); } catch { return 'unknown'; }
  if (!id) return 'gone';
  const stamped = r.resume.projectIncarnation;
  if (typeof stamped === 'string' && stamped) return stamped === id.incarnation ? 'same' : 'gone';
  if (!Number.isFinite(id.createdAt)) return 'unknown';
  return id.createdAt <= r.createdAt ? 'same' : 'gone';
}
const GONE_REASON = 'not sent: the project this session belonged to was removed from Orchard (a project added later may have the same name), and Orchard never resumes a session into a different project';

const hasAttachments = (r: OutboxRow): boolean => Array.isArray(r.attachments) && r.attachments.length > 0;

/**
 * What goes next: a forced row alone; else every queued row in order, cut where
 * the resume settings change. FEAT-177 (review #5): a row carrying attachments
 * is delivered ALONE — never coalesced with another row — so the per-message
 * count/size caps and the text↔image association of each message are preserved
 * (two valid 12-image messages must not become one 24-image delivery).
 */
function nextBatch(box: Box): OutboxRow[] {
  const queued = [...box.rows.values()].filter((r) => r.state === 'queued').sort((a, b) => a.seq - b.seq);
  if (!queued.length) return [];
  const forced = queued.find((r) => r.forced);
  if (forced) return [forced];
  const first = queued[0];
  if (hasAttachments(first)) return [first];
  const key = settingsKey(first);
  const out: OutboxRow[] = [];
  for (const r of queued) { if (settingsKey(r) !== key || hasAttachments(r)) break; out.push(r); }
  return out;
}

/** Say at once why the next row waits (the answer to a create should not claim "sending" while Claude works). */
function holdNow(box: Box): void {
  if (!wiring || box.reserved) return;
  const head = nextBatch(box)[0];
  if (!head) return;
  try {
    const p = wiring.probe(box.sid, head.resume, { overrideExternal: head.overrideExternal, forced: head.forced });
    box.hold = p.kind === 'wait' ? p.hold : { kind: 'sending', text: 'sending now' };
  } catch { /* the pump decides */ }
}

function kick(sid: string): void {
  setImmediate(() => { void pump(sid); });
}

async function pump(sid: string): Promise<void> {
  if (!wiring || stopped) return;
  let box: Box;
  try { box = boxOf(sid); } catch { return; }
  if (box.reserved || box.interrupting) return;
  if (Date.now() < box.nextTryAt) return;
  // BUG-253: a start box holds one first message; it goes alone, as typed (a header would become the new session's first line).
  const start = isStartBox(sid);
  const batch = start ? nextBatch(box).slice(0, 1) : nextBatch(box);
  if (!batch.length) { box.hold = null; return; }
  const head = batch[0];
  const p = wiring.probe(sid, head.resume, { overrideExternal: batch.every((r) => r.overrideExternal), forced: head.forced });
  if (p.kind === 'wait') {
    if (box.hold?.kind !== p.hold.kind) console.log(`[orchard] BUG-217: outbox ${sid} waits (${p.hold.kind}): ${p.hold.text}`);
    box.hold = p.hold;
    box.nextTryAt = Date.now() + (p.retryMs ?? 0);
    return;
  }
  /*
   * BUG-284 / FEAT-200 r12 — THE incarnation chokepoint, and it runs BEFORE the route is used, so no delivery route
   * (bridge, survivor, strand, gated, resume or new) can bypass it. An id can be reused (delete + re-add under the
   * same name); check each row is still bound to the project registered under that id. A row of a removed incarnation
   * is FAILED with the reason — never handed to a still-running session of the old project, which would tell an agent
   * "access granted" for a project that no longer exists (r12 ran this door through the running route). The rest go
   * on the next pass. Earlier this was gated behind `if (!p.running)`: a running bridge/survivor skipped it.
   */
  {
    const verdicts = batch.map((r) => [r, targetOf(r)] as const);
    if (verdicts.some(([, v]) => v === 'unknown')) {
      box.hold = { kind: 'project-unknown', text: 'Orchard cannot read its project list right now, so it is not resuming this session yet — it tries again' };
      box.nextTryAt = Date.now() + 2000;
      return;
    }
    const gone = verdicts.filter(([, v]) => v === 'gone').map(([r]) => r);
    if (gone.length) {
      const t = Date.now();
      const next = gone.map((r) => ({ ...r, state: 'failed' as const, sentAt: null, sizeAtSend: null, reason: GONE_REASON, updatedAt: t }));
      try { append(box, next); } catch (err) {
        box.hold = { kind: 'disk', text: 'Orchard cannot write its queue to disk, so it is not sending anything yet — nothing was lost, and it tries again' };
        box.nextTryAt = Date.now() + 5000;
        console.error(`[orchard] BUG-284: outbox ${sid}: could not record ${gone.length} row(s) as not sent (project removed) — nothing handed over (${(err as Error).message})`);
        return;
      }
      console.error(`[orchard] BUG-284: outbox ${sid}: ${gone.length} row(s) NOT sent (${gone.map((r) => r.id).join(', ')}): queued for project ${head.resume.projectId} incarnation ${head.resume.projectIncarnation ?? '(legacy, by creation time)'}, which is no longer the project under that id — a session is never resumed into another project`);
      if (start) gcStartBox(box);
      kick(sid);
      return;
    }
  }
  // The reservation is taken in the same tick as the probe: no socket path can slip a prompt in between.
  box.reserved = true;
  const release = wiring.reserve(sid);
  try {
    const now = Date.now();
    const prompt = start ? head.text : composeOutboxPrompt(batch, now);
    const size = start ? null : wiring.transcriptSize(sid, head.resume);
    try {
      append(box, batch.map((r) => ({ ...r, state: 'sending' as const, sentAt: now, sizeAtSend: size, updatedAt: now })));
    } catch (err) {
      box.hold = (err as OutboxError).extra?.notWriter
        ? { kind: 'not-writer', text: (err as Error).message }
        : { kind: 'disk', text: 'Orchard cannot write its queue to disk, so it is not sending anything yet — nothing was lost, and it tries again' };
      box.nextTryAt = Date.now() + 5000;
      console.error(`[orchard] BUG-217: outbox ${sid}: the sending record could not be written — nothing handed over (${(err as Error).message})`);
      return;
    }
    crashPoint('sending');
    /*
     * Round 9: ask AGAIN, after `sending` is saved and before anything reaches the CLI. If the data dir was moved
     * or replaced between the first check (inside the save) and here, this process no longer owns what sits at
     * the path — so it hands nothing over. Losing the claim has already marked these rows "not confirmed" in the
     * dir this process holds (`abandonOnLoss`); a copy at the path holds them `queued` (copied before this save —
     * one server sends it) or `sending` (after — nobody resends it). Never twice.
     */
    if (!isWriter()) {
      for (const r of batch) { const cur = box.rows.get(r.id); if (cur && cur.state === 'sending') box.rows.set(r.id, { ...cur, state: 'uncertain', reason: LOST_REASON, updatedAt: Date.now() }); }
      box.hold = { kind: 'not-writer', text: notWriter().message };
      console.error(`[orchard] BUG-217: outbox ${sid}: this process lost its data dir after saving "sending" — nothing handed over`);
      return;
    }
    box.hold = { kind: 'sending', text: 'sending…' };
    let out: HandOutcome;
    // FEAT-177: an attachment-bearing row is delivered alone (nextBatch), so the
    // batch head carries the message's attachments.
    try { out = await wiring.handOver(sid, p, prompt, head.resume, head.attachments); }
    catch (err) { out = { kind: 'uncertain', reason: `the handover failed part-way (${(err as Error).message}) — it may or may not have arrived. Check the conversation, then Send anyway or Discard` }; }
    crashPoint('handed-over');
    const t = Date.now();
    const cur = batch.map((r) => box.rows.get(r.id)!).filter(Boolean);
    let next: OutboxRow[];
    if (out.kind === 'delivered') {
      next = cur.map((r) => ({ ...r, state: 'delivered' as const, via: out.via, reason: null, updatedAt: t, ...(start ? { confirmed: true, ...(out.startedAs ? { startedAs: out.startedAs } : {}) } : {}) }));
      box.refusals = 0;
      box.hold = null;
    } else if (out.kind === 'refused') {
      next = cur.map((r) => ({ ...r, state: 'queued' as const, sentAt: null, sizeAtSend: null, updatedAt: t }));
      box.refusals++;
      box.hold = out.hold;
      box.nextTryAt = t + (out.retryMs ?? Math.min(60_000, 2000 * 2 ** Math.min(5, box.refusals - 1)));
    } else if (out.kind === 'uncertain') {
      next = cur.map((r) => ({ ...r, state: 'uncertain' as const, reason: out.reason, updatedAt: t }));
      box.hold = null;
    } else {
      next = cur.map((r) => ({ ...r, state: 'failed' as const, sentAt: null, sizeAtSend: null, reason: out.reason, updatedAt: t }));
      box.hold = null;
    }
    try { append(box, next); } catch (err) {
      // The outcome could not be recorded; the on-disk `sending` reloads as uncertain (never resent). Memory holds the
      // outcome and the next line written carries it (a refused row's next attempt writes `sending` again first).
      console.error(`[orchard] BUG-217: outbox ${sid}: the outcome (${out.kind}) could not be written (${(err as Error).message}) — held in memory; a restart before the next write shows these as not confirmed`);
      for (const r of next) { box.rows.set(r.id, r); box.unsaved.set(r.id, r); }
    }
    if (out.kind === 'delivered') {
      crashPoint('delivered');
      try { wiring.announce(sid, { t: 'outbox-turn', sessionId: sid, text: prompt, ids: batch.map((r) => r.id), ...(head.attachments ? { attachments: head.attachments } : {}) }); } catch { /* a tab that misses it reads the transcript */ }
    }
  } finally {
    box.reserved = false;
    release();
  }
  if (start) gcStartBox(box); // BUG-253: after the reservation is released (a reserved box is never collected)
  kick(sid);
}

/** Confirm recent deliveries and settle uncertain rows from the receiver's record. Only ever moves toward delivered. */
function confirmFromTranscript(box: Box): void {
  if (!wiring || isStartBox(box.sid)) return; // BUG-253: settled at the new session's init, never from a transcript
  const now = Date.now();
  const out: OutboxRow[] = [];
  for (const r of box.rows.values()) {
    if (r.confirmed || r.sentAt == null) continue;
    if (r.state === 'delivered' && now - r.sentAt < RECOVER_WINDOW_MS) {
      if (wiring.transcriptHas(box.sid, r.resume, r.id, r.sizeAtSend ?? 0) === true) out.push({ ...r, confirmed: true, updatedAt: now });
    } else if (r.state === 'uncertain' && now - r.updatedAt < UNCERTAIN_RECHECK_MS) {
      if (wiring.transcriptHas(box.sid, r.resume, r.id, 0) === true) {
        out.push({ ...r, state: 'delivered', confirmed: true, reason: null, updatedAt: now });
      }
    }
  }
  if (out.length) { try { append(box, out); } catch { /* retried next tick */ } }
}

let tickN = 0;
function tick(): void {
  tickN++;
  const now = Date.now();
  for (const box of [...boxes.values()]) {
    if (box.gcAt != null) { if (now - box.gcAt > RECENT_MS) boxes.delete(box.sid); continue; }
    const rows = [...box.rows.values()];
    if (rows.some((r) => r.state === 'queued')) void pump(box.sid);
    // Transcript reads are cheaper than they look but not free: every 2 s is plenty for a confirmation.
    if (tickN % 4 === 0 && rows.some((r) => !r.confirmed && r.sentAt != null && (r.state === 'delivered' || r.state === 'uncertain'))) confirmFromTranscript(box);
  }
}

/**
 * Boot: wire the engine, load EVERY journal on disk and schedule delivery — a
 * row queued before a restart goes by itself, whether or not any tab ever opens.
 */
export function startOutbox(w: OutboxWiring): void {
  wiring = w;
  if (!lossHooked) { lossHooked = true; onWriterLost(abandonOnLoss); }
  let names: string[] = [];
  try { names = fs.readdirSync(root()); } catch { /* no outbox yet */ }
  for (const n of names) {
    const m = /^(.+)\.jsonl$/.exec(n);
    if (!m || !validSessionId(m[1])) continue;
    try {
      const b = boxOf(m[1]);
      // BUG-253: a start box that finished (or never held a saved row) is not carried across restarts.
      if (isStartBox(b.sid) && gcStartBox(b)) boxes.delete(b.sid);
    } catch (err) { console.error(`[orchard] BUG-217: outbox ${m[1]} could not be loaded: ${(err as Error).message}`); }
  }
  if (!timer) { timer = setInterval(tick, TICK_MS); timer.unref?.(); }
  for (const sid of boxes.keys()) kick(sid);
}

const LOST_REASON = 'Orchard lost hold of its data folder (it was moved or replaced while Orchard was running) while this was being sent, so it may or may not have arrived — check the conversation, then Send anyway or Discard';
const LOST_QUEUED_REASON = 'Orchard lost hold of its data folder (it was moved or replaced while Orchard was running) before sending this, and another Orchard may be using a copy of it — check the conversation, then Send anyway or Discard';
let lossHooked = false;
/**
 * Round 9 — the data dir this process locked is no longer the one at its path (`lanes.isWriter()` found the
 * drift). Stop delivering at once, and fail CLOSED in the dir this process still holds: every row that was
 * being sent, or was waiting to be, becomes "not confirmed" — never sent again by itself from this copy, never
 * dropped. Whatever now sits at the path is another directory, with its own server and its own rows.
 */
function abandonOnLoss(why: string): void {
  if (stopped || !wiring) return;
  stopped = true;
  if (timer) { clearInterval(timer); timer = null; }
  draining = true;
  let marked = 0;
  try {
    for (const box of boxes.values()) {
      const now = Date.now();
      const next = [...box.rows.values()].filter((r) => r.state === 'sending' || r.state === 'queued')
        .map((r) => ({ ...r, state: 'uncertain' as const, reason: r.state === 'sending' ? LOST_REASON : LOST_QUEUED_REASON, updatedAt: now }));
      if (!next.length) continue;
      try { append(box, next); marked += next.length; } catch (err) {
        for (const r of next) box.rows.set(r.id, r);
        console.error(`[orchard] BUG-217: outbox ${box.sid}: could not record ${next.length} row(s) as not confirmed after losing the data dir (${(err as Error).message}) — a saved "sending" reloads as not confirmed anyway`);
      }
    }
  } finally { draining = false; }
  console.error(`[orchard] BUG-217: outbox stopped — ${why}; ${marked} row(s) marked "not confirmed" in the directory this process held`);
}

/** Shutdown: stop delivering. Rows stay queued on disk and the next boot delivers them. */
export function stopOutbox(): void {
  stopped = true;
  if (timer) { clearInterval(timer); timer = null; }
}

/** A bridge became idle (or anything else a queued row may have been waiting for) — look now, not at the next tick. */
export function nudgeOutbox(sid: string | null | undefined): void {
  if (!sid || !boxes.has(sid)) return;
  const b = boxes.get(sid)!;
  b.nextTryAt = 0;
  kick(sid);
}
