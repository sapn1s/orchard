/**
 * BUG-217 round 6 — an in-process harness for src/server/outbox.ts's lifecycle
 * under injected disk faults (./fs-fault.mjs).
 *
 * Every "process lifetime" is a FRESH instance of the module (imported under a
 * new query string), started with a fake wiring whose `handOver` is the CLI:
 * every prompt it is handed is recorded, and a message that appears in two
 * prompts reached the session twice. A restart = stop the instance, import a new
 * one on the same data dir, start it. The data dir is a scratch dir set as
 * CLAUDE_STATION_DATA (dataDir() reads the env on each call).
 *
 * For each lifecycle TRANSITION, a recording run counts the outbox's write ops
 * (mkdir, open, write, fsync, close, rename, …); then, for EVERY op k and every
 * fault mode, a fresh world fails op k during that transition, frees the disk,
 * lets the tab replay what it was not acknowledged, delivers, restarts,
 * delivers again, and grades what the CLI got and what the user can see.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { fault, install, uninstall } from './fs-fault.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
export const REPO = path.resolve(HERE, '..', '..', '..');
export const LIVE_OUTBOX = path.join(REPO, 'src', 'server', 'outbox.ts');

/** The round-5 outbox.ts, PINNED (sha256-checked) — never HEAD, so committing the fix cannot make this proof vacuous. */
export function pinnedRound5Outbox() {
  const pin = path.join(HERE, 'round5');
  const sums = Object.fromEntries(fs.readFileSync(path.join(pin, 'SHA256SUMS'), 'utf8').trim().split('\n').map((l) => { const [h, f] = l.split(/\s+/); return [f, h]; }));
  const body = zlib.gunzipSync(fs.readFileSync(path.join(pin, 'src__server__outbox.ts.gz')));
  const h = crypto.createHash('sha256').update(body).digest('hex');
  if (h !== sums['src/server/outbox.ts']) throw new Error(`pinned round-5 outbox.ts: sha256 ${h} does not match SHA256SUMS — the fixture is damaged`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b217-r5mod-'));
  const file = path.join(dir, 'outbox.ts');
  const paths = pathToFileURL(path.join(REPO, 'src', 'lib', 'paths.ts')).href;
  const src = body.toString('utf8');
  if (src.split(`from '../lib/paths.ts'`).length !== 2) throw new Error('pinned round-5 outbox.ts: the paths import anchor moved');
  fs.writeFileSync(file, src.replace(`from '../lib/paths.ts'`, `from '${paths}'`));
  return { file, dir };
}

let lanesMod = null;
/** The live lanes.ts (the data-dir lock's owner) — one instance for the whole harness process. */
export const lanesModule = async () => (lanesMod ??= await import(pathToFileURL(path.join(REPO, 'src', 'server', 'lanes.ts')).href));

let instN = 0;
export const loadOutbox = (file) => import(`${pathToFileURL(file).href}?b217i=${++instN}`);
const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function settle(n = 3) { for (let j = 0; j < n; j++) { for (let i = 0; i < 12; i++) await tick(); await sleep(3); } }

/* ------------------------------------------------------------ the fake CLI */
export function makeCtl() {
  const ctl = {
    go: false,
    /** 'delivered' | 'refused' | 'uncertain' | 'failed' | 'throws' — the next handover's outcome. */
    outcome: 'delivered',
    transcriptOn: true,
    transcript: '',
    prompts: [],
  };
  ctl.wiring = {
    probe: () => (ctl.go ? { kind: 'go', route: 'fake' } : { kind: 'wait', hold: { kind: 'busy', text: 'Claude is working' } }),
    reserve: () => () => {},
    async handOver(_sid, _go, prompt) {
      const o = ctl.outcome;
      // A refusal is one-shot: the session then looks busy until the harness says otherwise.
      if (o === 'refused') { ctl.go = false; ctl.outcome = 'delivered'; return { kind: 'refused', hold: { kind: 'busy', text: 'refused' }, retryMs: 1 }; }
      if (o === 'failed') return { kind: 'failed', reason: 'the fake said no' };
      ctl.prompts.push(prompt);
      if (ctl.transcriptOn) ctl.transcript += `${prompt}\n`;
      if (o === 'throws') throw new Error('the fake handover broke part-way');
      if (o === 'uncertain') return { kind: 'uncertain', reason: 'the fake cannot say' };
      return { kind: 'delivered', via: 'fake' };
    },
    transcriptHas: (_sid, _resume, needle) => ctl.transcript.includes(needle),
    transcriptSize: () => ctl.transcript.length,
    interrupt: () => Promise.resolve(),
    announce: () => {},
  };
  return ctl;
}

/* ------------------------------------------------------------ a world */
const RESUME = { projectId: 'p-b217', encodedDir: '-tmp-b217', overrides: null, templateIds: null };
const quiet = () => {
  const saved = { log: console.log, error: console.error, warn: console.warn };
  const logs = [];
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => logs.push(a.join(' '));
  console.warn = (...a) => logs.push(a.join(' '));
  return { logs, restore: () => Object.assign(console, saved) };
};

export class World {
  constructor(file, tag) {
    this.file = file;
    this.data = fs.mkdtempSync(path.join(os.tmpdir(), `b217-ob-${tag}-`));
    this.sid = `b217s${crypto.randomBytes(4).toString('hex')}`;
    this.ctl = makeCtl();
    this.msgs = new Map();
    this.m = null;
    this.errors = [];
  }
  get dir() { return path.join(this.data, 'outbox'); }
  get journal() { return path.join(this.dir, `${this.sid}.jsonl`); }
  get head() { return path.join(this.dir, `${this.sid}.head`); }
  env() { process.env.CLAUDE_STATION_DATA = this.data; }
  async start() {
    this.env();
    // Round 7: the outbox writes only in the process holding the data dir's lock (a server takes it at boot).
    // Taken here per world (the claim follows CLAUDE_STATION_DATA). The pinned round-5 file never asks.
    const c = await (await lanesModule()).claimWriter();
    if (!c.ok) throw new Error(`harness: could not take the data dir lock for ${this.data}: ${c.reason}`);
    this.m = await loadOutbox(this.file);
    try { this.m.startOutbox(this.ctl.wiring); } catch (err) { this.errors.push({ op: 'start', err }); }
    await settle();
  }
  async restart() {
    this.env();
    try { this.m?.stopOutbox(); } catch { /* */ }
    await this.start();
  }
  stop() { try { this.m?.stopOutbox(); } catch { /* */ } }
  msg(tag) {
    if (!this.msgs.has(tag)) {
      const nonce = `n-${tag}-${crypto.randomBytes(6).toString('hex')}`;
      this.msgs.set(tag, { tag, nonce, text: `ORIG-${nonce}`, edited: `EDIT-${nonce}`, acked: false, req: null, id: null, intent: 'deliver', noAuto: false, editAcked: false, discardAcked: false });
    }
    return this.msgs.get(tag);
  }
  /** Call the module; a throw is what the POST would have answered (the user sees it). */
  call(what, fn) {
    try { return { ok: true, v: fn() }; } catch (err) { this.errors.push({ op: what, err }); return { ok: false, err }; }
  }
  create(tag, extra = {}) {
    const g = this.msg(tag);
    g.req = { nonce: g.nonce, text: g.text, origin: 'queued', resume: RESUME, ...extra };
    if (extra.initial === 'uncertain' || extra.initial === 'failed') g.noAuto = true;
    if (extra.discard) g.intent = 'discard';
    const r = this.call(`create ${tag}`, () => this.m.createOutboxRow(this.sid, g.req));
    if (r.ok) { g.acked = true; g.id = r.v.row.id; if (extra.discard) g.discardAcked = true; }
    return r;
  }
  /** The tab's pending store replays a request the server did not acknowledge (same nonce, same payload). */
  replay() {
    for (const g of this.msgs.values()) {
      if (!g.req || g.acked) continue;
      const r = this.call(`replay ${g.tag}`, () => this.m.createOutboxRow(this.sid, g.req));
      if (r.ok) { g.acked = true; g.id = r.v.row.id; if (g.req.discard) g.discardAcked = true; }
    }
  }
  rowOf(tag) {
    const g = this.msg(tag);
    const v = this.m.outboxView(this.sid);
    return v.rows.find((r) => r.nonce === g.nonce) ?? null;
  }
  idOf(tag) { return this.rowOf(tag)?.id ?? this.msg(tag).id; }
  edit(tag) {
    const g = this.msg(tag);
    const r = this.call(`edit ${tag}`, () => this.m.editOutboxRow(this.sid, this.idOf(tag), g.edited));
    if (r.ok) g.editAcked = true;
    return r;
  }
  discard(tag) {
    const g = this.msg(tag);
    g.intent = 'discard';
    const r = this.call(`discard ${tag}`, () => this.m.discardOutboxRow(this.sid, this.idOf(tag)));
    if (r.ok) g.discardAcked = true;
    return r;
  }
  send(tag, opts = {}) {
    const g = this.msg(tag);
    g.noAuto = false; // the user asked for it to go
    return this.call(`send ${tag}`, () => this.m.sendOutboxRow(this.sid, this.idOf(tag), opts));
  }
  async deliver() {
    this.ctl.go = true;
    this.m.nudgeOutbox(this.sid);
    await settle();
  }
  /** How many prompts carried this message's words (original or edited). */
  atCli(tag) {
    const g = this.msg(tag);
    const orig = this.ctl.prompts.filter((p) => p.includes(g.text)).length;
    const ed = this.ctl.prompts.filter((p) => p.includes(g.edited)).length;
    return { orig, ed, total: orig + ed };
  }
  /** Write a journal by hand (the load-time transitions, and the duplicate-nonce journals). */
  writeJournal(lines, { head = lines.length ? lines[lines.length - 1].lsn : null } = {}) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.journal, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
    if (head != null) fs.writeFileSync(this.head, JSON.stringify({ lsn: head }));
  }
  rowRecord(tag, state, over = {}) {
    const g = this.msg(tag);
    g.id ??= `q${crypto.randomBytes(8).toString('hex')}`;
    g.req = null; g.acked = true;
    const now = Date.now();
    return {
      id: over.id ?? g.id, nonce: g.nonce, seq: over.seq ?? 1, text: g.text, origin: 'queued', state, reason: null,
      createdAt: now - 5000, updatedAt: now - 4000, forced: false, overrideExternal: false, via: null,
      confirmed: false, sentAt: null, sizeAtSend: null, resume: RESUME,
      payload: crypto.createHash('sha256').update(JSON.stringify([g.text, 'queued', 'queued', null])).digest('hex').slice(0, 24),
      ...over,
    };
  }
  cleanup() { this.stop(); try { fs.rmSync(this.data, { recursive: true, force: true }); } catch { /* */ } }
}

/* ------------------------------------------------------------ grading */
/**
 * What must hold at the end of a world (after the disk is healthy again, the
 * tab replayed, a delivery ran, the server restarted and delivered again):
 *  DUP        a message reached the CLI more than once;
 *  DUPROW     the user sees two live rows for one message;
 *  LOST       a message the user did not withdraw is neither delivered nor shown;
 *  STUCK      a row still "queued"/"sending" although the session can take it;
 *  AUTOSEND   a row that may already have arrived was sent without the user's say-so;
 *  DISCARD    a discard the server acknowledged, and the message went anyway;
 *  EDIT       an edit the server acknowledged, and the old words went;
 *  RAWERR     the user got a raw fs error instead of Orchard's own words;
 *  FALSEDAMAGE a fault that was undone (or hit after the commit) left a "damaged" notice anyway.
 */
export function grade(w, { preHanded = new Map(), expectClean = false } = {}) {
  const out = [];
  const v = w.m.outboxView(w.sid);
  // A fault that was rolled back cleanly, or that hit a step after the commit, must not leave a false alarm.
  if (expectClean && v.damaged) out.push(`FALSEDAMAGE ${v.damaged.detail.slice(0, 80)}`);
  for (const g of w.msgs.values()) {
    const cli = w.atCli(g.tag);
    const n = cli.total + (preHanded.get(g.tag) ?? 0);
    const live = v.rows.filter((r) => r.nonce === g.nonce);
    const discarded = v.recent.some((r) => r.nonce === g.nonce && r.state === 'discarded');
    if (n > 1) out.push(`DUP ${g.tag} ×${n}`);
    if (live.length > 1) out.push(`DUPROW ${g.tag} ×${live.length}`);
    if (live.some((r) => r.state === 'queued' || r.state === 'sending')) out.push(`STUCK ${g.tag} ${live.map((r) => r.state).join(',')}`);
    if (g.noAuto && cli.total > 0) out.push(`AUTOSEND ${g.tag}`);
    if (g.discardAcked && cli.total > 0) out.push(`DISCARD ${g.tag} went ×${cli.total}`);
    if (g.editAcked && cli.orig > 0) out.push(`EDIT ${g.tag} old words went`);
    const withdrawn = g.intent === 'discard' && discarded;
    if (n === 0 && live.length === 0 && !withdrawn && g.intent !== 'none') out.push(`LOST ${g.tag}`);
  }
  for (const e of w.errors) {
    if (e.err?.constructor?.name !== 'OutboxError') out.push(`RAWERR ${e.op}: ${String(e.err?.message ?? e.err).slice(0, 80)}`);
  }
  return out;
}

/* ------------------------------------------------------------ the transitions */
const edits = (w, tag, n) => { for (let i = 0; i < n; i++) w.edit(tag); };
export const TRANSITIONS = [
  { name: 'create (first row: fresh journal)', act: (w) => w.create('a') },
  { name: 'create (second row)', prep: (w) => w.create('z'), act: (w) => w.create('a') },
  { name: 'create "not confirmed"', act: (w) => w.create('a', { initial: 'uncertain', reason: 'maybe sent' }) },
  { name: 'create already discarded (unknown nonce)', act: (w) => w.create('a', { discard: true }) },
  { name: 'discard on create (known nonce)', prep: (w) => w.create('a'), act: (w) => { const g = w.msg('a'); g.intent = 'discard'; const r = w.call('discard-create a', () => w.m.createOutboxRow(w.sid, { ...g.req, discard: true })); if (r.ok) g.discardAcked = true; g.req = { ...g.req, discard: true }; } },
  { name: 'edit', prep: (w) => w.create('a'), act: (w) => w.edit('a') },
  { name: 'discard', prep: (w) => w.create('a'), act: (w) => w.discard('a') },
  { name: 'Send anyway (uncertain → queued)', prep: (w) => w.create('a', { initial: 'uncertain', reason: 'maybe' }), act: (w) => w.send('a') },
  { name: 'Send now', prep: (w) => w.create('a'), act: (w) => w.send('a', { now: true }) },
  { name: 'Interrupt & send', prep: (w) => w.create('a'), act: async (w) => { w.send('a', { interrupt: true }); await settle(); } },
  { name: 'deliver → delivered (batch of two)', prep: (w) => { w.create('a'); w.create('b'); }, act: (w) => w.deliver() },
  { name: 'deliver → refused (back to queued)', prep: (w) => { w.create('a'); w.ctl.outcome = 'refused'; }, act: (w) => w.deliver() },
  { name: 'deliver → uncertain', prep: (w) => { w.create('a'); w.ctl.outcome = 'uncertain'; }, act: (w) => w.deliver() },
  { name: 'deliver → failed', prep: (w) => { w.create('a'); w.ctl.outcome = 'failed'; }, act: (w) => w.deliver() },
  { name: 'deliver → handover throws', prep: (w) => { w.create('a'); w.ctl.outcome = 'throws'; }, act: (w) => w.deliver() },
  { name: 'deliver, the receiver keeps no record', prep: (w) => { w.create('a'); w.ctl.transcriptOn = false; }, act: (w) => w.deliver() },
  // 1 create line + 67 edits = 68 lines; the next edit makes 69 > 64 + 4·1 and compacts.
  { name: 'compaction', prep: (w) => { w.create('a'); edits(w, 'a', 67); }, act: (w) => w.edit('a') },
  { name: 'dismiss the damage notice', damages: true, prep: async (w) => {
    w.create('a', { initial: 'uncertain', reason: 'x' });
    w.stop();
    fs.appendFileSync(w.journal, '{"lsn": 9, "rows": [garbled\n');
    await w.restart();
  }, act: (w) => w.call('dismiss', () => w.m.dismissOutboxDamage(w.sid)) },
  { name: 'load: a row caught "sending" becomes not confirmed', restartAct: true, prep: (w) => {
    const r = w.rowRecord('a', 'sending', { sentAt: Date.now() - 1000, sizeAtSend: 0 });
    w.msg('a').noAuto = true;
    w.writeJournal([{ lsn: 1, rows: [{ ...r, state: 'queued' }] }, { lsn: 2, rows: [r] }]);
  } },
  { name: 'load: a damaged journal is rewritten', damages: true, restartAct: true, prep: (w) => {
    const a = w.rowRecord('a', 'queued', { seq: 1 });
    w.msg('a').noAuto = true;
    w.writeJournal([{ lsn: 1, rows: [a] }, '{"lsn": 2, "rows": [garb'], { head: 2 });
  } },
  { name: 'load: a duplicate nonce is settled', damages: true, restartAct: true, prep: (w) => {
    const a = w.rowRecord('a', 'queued', { seq: 1 });
    const b = { ...a, id: `q${crypto.randomBytes(8).toString('hex')}`, seq: 2, state: 'delivered', sentAt: Date.now() - 2000, confirmed: true };
    w.msg('a').noAuto = true;
    w.preHanded = new Map([['a', 1]]);
    w.writeJournal([{ lsn: 1, rows: [a] }, { lsn: 2, rows: [b] }]);
  } },
  { name: 'recover: delivered, not yet confirmed, then restarted', restartAct: true, prep: (w) => {
    const r = w.rowRecord('a', 'delivered', { sentAt: Date.now() - 2000, sizeAtSend: 0 });
    w.preHanded = new Map([['a', 1]]);
    w.ctl.transcript = `[Queued 3s ago … ref ${r.id}]\n${r.text}\n`;
    w.writeJournal([{ lsn: 1, rows: [{ ...r, state: 'sending' }] }, { lsn: 2, rows: [r] }]);
  } },
  { name: 'confirm from the transcript (tick)', slow: true, prep: async (w) => {
    w.create('a'); w.ctl.transcriptOn = false; await w.deliver();
    w.ctl.transcript += `${w.ctl.prompts.join('\n')}\n`;
  }, act: () => sleep(2300) },
];

/**
 * Run one transition with op `k` failed in `mode` (or k = 0: no fault, recording).
 * Returns { ops, trace, fired, violations }.
 */
export async function runOne(file, t, { k = 0, mode = 'once', code = 'ENOSPC' } = {}) {
  const q = quiet();
  const w = new World(file, t.name.replace(/[^a-z]/gi, '').slice(0, 10));
  try {
    await w.start();
    if (t.prep) await t.prep(w);
    await settle();
    let tr;
    if (k) fault.arm({ at: k, code, mode }); else fault.record();
    try {
      if (t.restartAct) { w.ctl.go = true; await w.restart(); } else await t.act(w);
      await settle();
    } finally { tr = fault.disarm(); }
    // The disk is healthy again. The tab replays what it was not acknowledged; the session can take a turn.
    w.ctl.outcome = 'delivered';
    w.replay();
    await w.deliver();
    await w.deliver();
    await w.restart();
    w.replay();
    await w.deliver();
    await w.deliver();
    // Only a dying disk (every op fails, the rollback included) may leave the session marked damaged.
    const violations = grade(w, { preHanded: w.preHanded, expectClean: !!k && mode !== 'sticky' && mode !== 'shortdie' && !t.damages });
    return { ops: tr.n, trace: tr.trace, fired: tr.fired, violations, logs: q.logs };
  } finally {
    q.restore();
    w.cleanup();
  }
}

export const MODES = [
  { mode: 'once', code: 'ENOSPC' },
  { mode: 'once', code: 'EIO' },
  { mode: 'sticky', code: 'EIO' },
  { mode: 'short', code: 'ENOSPC' },
  { mode: 'shortdie', code: 'EIO' },
  { mode: 'after', code: 'EIO' },
];

/** Every transition × every write op in it × every fault mode. */
export async function runMatrix(file, { transitions = TRANSITIONS, modes = MODES, onResult } = {}) {
  install();
  const results = [];
  try {
    for (const t of transitions) {
      const rec = await runOne(file, t);
      results.push({ t: t.name, k: 0, mode: 'none', ops: rec.ops, trace: rec.trace, violations: rec.violations });
      onResult?.(results[results.length - 1]);
      for (let k = 1; k <= rec.ops; k++) {
        for (const md of modes) {
          const r = await runOne(file, t, { k, ...md });
          const res = { t: t.name, k, op: rec.trace[k - 1], mode: `${md.mode}:${md.code}`, fired: r.fired, violations: r.violations };
          results.push(res);
          onResult?.(res);
        }
      }
    }
  } finally { uninstall(); }
  return results;
}

/* ------------------------------------------------------------ the round-5 attack, in-process */
/**
 * The clean-room verifier's round-5 break: the create's journal line is
 * fsync'd, then the `.head` rename fails ENOSPC. The tab replays the nonce;
 * the server delivers; it restarts and delivers again. Returns what the CLI got.
 */
export async function round5Attack(file) {
  install();
  const q = quiet();
  const w = new World(file, 'r5attack');
  try {
    // Where is the head rename in a first create? (recorded, not assumed)
    const probe = new World(file, 'r5probe');
    await probe.start();
    fault.record();
    probe.create('a');
    const tr = fault.disarm();
    probe.cleanup();
    const k = tr.trace.findIndex((op) => /^renameSync .*\.head$/.test(op)) + 1;
    if (!k) throw new Error(`no .head rename in a create's write path: ${tr.trace.join(' | ')}`);
    await w.start();
    fault.arm({ at: k, code: 'ENOSPC', mode: 'once' });
    const first = w.create('a');
    const fired = fault.disarm().fired;
    const g = w.msg('a');
    const firstId = first.ok ? first.v.row.id : null;
    const rep = w.call('replay', () => w.m.createOutboxRow(w.sid, g.req));
    await w.deliver();
    const beforeRestart = w.atCli('a').total;
    await w.restart();
    await w.deliver();
    const after = w.atCli('a').total;
    const v = w.m.outboxView(w.sid);
    return {
      fired, firstOk: first.ok, firstErr: first.ok ? null : String(first.err?.message ?? first.err),
      replayCreated: rep.ok ? rep.v.created : null, sameRow: rep.ok && firstId != null && rep.v.row.id === firstId,
      beforeRestart, after, damaged: v.damaged, live: v.rows.length,
    };
  } finally { q.restore(); w.cleanup(); uninstall(); }
}

/* ------------------------------------------------------------ journals already holding one nonce twice */
/**
 * `shape`: the states of the rows sharing ONE nonce, oldest first; `prior` how
 * many times that message already reached the CLI (a delivered copy). An
 * unrelated queued row 'c' rides along: it must still be delivered, once.
 * Loads twice (the settled journal must load clean the second time).
 */
export async function dupJournal(file, shape, { prior = shape.some((s) => s === 'delivered') ? 1 : 0 } = {}) {
  const q = quiet();
  const w = new World(file, 'dupnonce');
  try {
    w.env();
    const now = Date.now();
    const base = w.rowRecord('a', 'queued', { seq: 1 });
    const recs = shape.map((st, i) => ({ ...base, id: i === 0 ? base.id : `q${crypto.randomBytes(8).toString('hex')}`, seq: i + 1, state: st, ...(st === 'delivered' || st === 'sending' || st === 'uncertain' ? { sentAt: now - 2000, confirmed: st === 'delivered' } : {}) }));
    const c = w.rowRecord('c', 'queued', { seq: shape.length + 1 });
    const lines = [...recs.map((r, i) => ({ lsn: i + 1, rows: [r] })), { lsn: recs.length + 1, rows: [c] }];
    w.writeJournal(lines);
    // The receiver's record holds the delivered copies' refs (the transcript says what arrived).
    w.ctl.transcript = recs.filter((r) => r.state === 'delivered').map((r) => `[… ref ${r.id}]\n${r.text}`).join('\n');
    w.ctl.go = true;
    await w.start();
    await w.deliver();
    const v1 = w.m.outboxView(w.sid);
    const newA = w.atCli('a').total;
    const cAt = w.atCli('c').total;
    const logs1 = q.logs.slice();
    await w.restart();
    await w.deliver();
    const v2 = w.m.outboxView(w.sid);
    return {
      shape: shape.join('+'), prior, newA, totalA: prior + w.atCli('a').total, cAt: w.atCli('c').total, cAtFirst: cAt, newAFirst: newA,
      damaged: v1.damaged?.detail ?? null, loud: logs1.some((l) => /duplicate/i.test(l)),
      liveA1: v1.rows.filter((r) => r.nonce === w.msg('a').nonce).map((r) => r.state),
      liveA2: v2.rows.filter((r) => r.nonce === w.msg('a').nonce).map((r) => r.state),
      logs2: q.logs.slice(logs1.length).filter((l) => /duplicate|DAMAGED/i.test(l)),
    };
  } finally { q.restore(); w.cleanup(); }
}
