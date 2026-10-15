/**
 * delegation-source.mjs — the user's STANDING DELEGATIONS and the agent ADOPTIONS
 * made under them (FEAT-184).
 *
 * WHY. "Do whatever you recommend" is a real user decision, but the board only had
 * one way to clear a Decide card: a user answer. Twice an agent wrote that answer
 * through the API and the board recorded it `by: user` (FEAT-164, FEAT-170). This
 * module is the honest path: a DELEGATION is a recorded user statement with an
 * explicit scope, an expiry and a revocation; an ADOPTION is an agent choosing the
 * decision's own recommendation under one, recorded as itself, never as the user.
 *
 * WHO WRITES. The server only (src/server/delegations.ts):
 *   - `record` / `revoke`: the user-only routes (requireUserCaller — an agent caller
 *     is refused before anything is read);
 *   - `adoption`: the adopt route, after it has checked a live delegation.
 * The seal key is used to SIGN only by server code. board-tool and board:check read
 * it to VERIFY. Nothing here is written from the board directory, so a `git
 * checkout` of the board cannot restore an older authority.
 *
 * WHERE. `<dataDir>/delegations/<sha256(realpath(boardDir))>.jsonl`, one JSON entry
 * per line, append-only, plus a sealed `.head`. Every entry carries
 *   { seq, prev, board, kind, ..., seal }
 * `prev` is the sha256 of the previous line ("genesis" for the first), `board` is the
 * realpath of the board directory it is for, `seal` is an HMAC over the canonical
 * entry. The head is { seq, hash, board, seal } of the last line.
 *
 * FAIL CLOSED. `loadStore` verifies every seal, the chain, the board binding and the
 * head. ANY mismatch — an unsealed or re-sealed line, a removed revoke line, a file
 * rolled back to an older copy (shorter than the head), an entry copied from another
 * board's store — marks the whole store DAMAGED, and a damaged store authorises
 * nothing: no delegation is live and no adoption counts. A file exactly ONE validly
 * chained line ahead of its head is a crash between the line's fsync and the head's
 * rename, and is accepted.
 *
 * RESIDUALS (same-uid, the FEAT-164 class, stated rather than hidden): a process that
 * deliberately reads the key can forge seals; restoring BOTH the file and its head to
 * an older pair replays an older state (git-write-seal.mjs documents the same).
 *
 * PORTABLE: plain JS, no server imports, so board-tool and board.mjs can verify.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

export const DELEGATION_DIR = 'delegations';
export const DELEGATION_KEY_FILE = 'delegation-seal.key';
const DOMAIN = 'orchard-feat184-delegation-v1';
export const MAX_SCOPE_TICKETS = 20;
export const MAX_DAYS = 90;
export const DEFAULT_DAYS = 30;
export const MAX_STATEMENT = 500;
/** What a delegation lets an agent do. Only one thing: adopt the decision's own recommendation. */
export const PERMITS = 'recommended';
const TICKET_ID = /^[A-Z]+-\d+$/;

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** Same resolution as src/lib/paths.ts dataDir() — kept identical; see that file. */
export function defaultDataDir(env = process.env) {
  const v = env.CLAUDE_STATION_DATA;
  if (v && v.trim()) return path.resolve(v);
  const xdg = env.XDG_DATA_HOME;
  const base = xdg && xdg.trim() ? path.resolve(xdg) : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'claude-station');
}

/* ─────────────────────────────────────────────────────────────────── the key */

export function delegationKeyPath(dataDir) { return path.join(dataDir, DELEGATION_KEY_FILE); }

/** The key, or null (absent / unreadable / malformed). Never creates it. */
export function readDelegationKey(dataDir) {
  try {
    const hex = fs.readFileSync(delegationKeyPath(dataDir), 'utf8').trim();
    return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
  } catch { return null; }
}

/** Server only: create the key if absent (exclusive create; a racing creator reads the winner's). */
export function ensureDelegationKey(dataDir) {
  const existing = readDelegationKey(dataDir);
  if (existing) return existing;
  fs.mkdirSync(dataDir, { recursive: true });
  try {
    fs.writeFileSync(delegationKeyPath(dataDir), `${crypto.randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
  } catch (err) { if (err.code !== 'EEXIST') throw err; }
  const key = readDelegationKey(dataDir);
  if (!key) throw new Error(`delegation seal key at ${delegationKeyPath(dataDir)} is unreadable or malformed`);
  return key;
}

/* ───────────────────────────────────────────────────────────────── the store */

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}
function mac(key, body) {
  return crypto.createHmac('sha256', Buffer.from(key, 'hex')).update(`${DOMAIN}\0${canonical(body)}`).digest('hex');
}
function sealed(key, obj) {
  const { seal: _drop, ...body } = obj;
  return { ...body, seal: mac(key, body) };
}
function sealOk(key, obj) {
  if (!obj || typeof obj !== 'object' || typeof obj.seal !== 'string') return false;
  const { seal, ...body } = obj;
  const want = mac(key, body);
  return seal.length === want.length && crypto.timingSafeEqual(Buffer.from(seal), Buffer.from(want));
}

/** The board's identity a seal is bound to: its real path (a copied entry names another board). */
export function boardBinding(boardDir) {
  try { return fs.realpathSync(boardDir); } catch { return path.resolve(boardDir); }
}
export function storeFiles(dataDir, boardDir) {
  const base = path.join(dataDir, DELEGATION_DIR, sha256(boardBinding(boardDir)));
  return { file: `${base}.jsonl`, head: `${base}.head` };
}

const cache = new Map();
function statSig(f) { try { const s = fs.statSync(f); return `${s.mtimeMs}|${s.size}|${s.ino}`; } catch { return 'absent'; } }

/**
 * Load and VERIFY the store for one board. Returns
 *   { ok, damaged: string|null, entries: [], headSeq, board }
 * `ok` is false (and `entries` empty) whenever anything does not verify.
 */
export function loadStore(dataDir, boardDir, key = readDelegationKey(dataDir)) {
  const board = boardBinding(boardDir);
  const { file, head } = storeFiles(dataDir, boardDir);
  const sig = `${file}|${statSig(file)}|${statSig(head)}|${key ? sha256(key) : 'nokey'}`;
  if (cache.has(sig)) return cache.get(sig);
  const out = verify();
  cache.set(sig, out);
  return out;

  function verify() {
    const bad = (why) => ({ ok: false, damaged: why, entries: [], headSeq: 0, board });
    let text = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch { /* absent */ }
    let headText = null;
    try { headText = fs.readFileSync(head, 'utf8'); } catch { /* absent */ }
    if (text === null && headText === null) return { ok: true, damaged: null, entries: [], headSeq: 0, board };
    if (!key) return bad('the delegation seal key is missing, so the store cannot be verified');
    if (text === null) return bad('the store file is missing but its head exists (deleted or moved)');
    const lines = text.split('\n');
    if (lines[lines.length - 1] !== '') return bad('the store ends in a partial line (torn write)');
    lines.pop();
    const entries = [];
    let prev = 'genesis';
    for (let i = 0; i < lines.length; i++) {
      let e;
      try { e = JSON.parse(lines[i]); } catch { return bad(`line ${i + 1} is not JSON`); }
      if (!sealOk(key, e)) return bad(`line ${i + 1} has no valid seal (written outside the server)`);
      if (e.seq !== i + 1) return bad(`line ${i + 1} carries seq ${e.seq} (lines removed or reordered)`);
      if (e.prev !== prev) return bad(`line ${i + 1} does not chain to the line before it`);
      if (e.board !== board) return bad(`line ${i + 1} is bound to another board (${e.board})`);
      entries.push(e);
      prev = sha256(lines[i]);
    }
    let h = null;
    try { h = headText === null ? null : JSON.parse(headText); } catch { return bad('the head is not JSON'); }
    // A crash after the FIRST line's fsync, before its head was written: one validly
    // sealed line and no head is the same crash window as "one line ahead".
    if (!h && entries.length === 1) return { ok: true, damaged: null, entries, headSeq: 0, board };
    if (!h) return bad('the store has lines but no head');
    if (!sealOk(key, h) || h.board !== board) return bad('the head has no valid seal for this board');
    const last = entries.length;
    const hashAt = (n) => (n === 0 ? 'genesis' : sha256(lines[n - 1]));
    if (h.seq === last && h.hash === hashAt(last)) return { ok: true, damaged: null, entries, headSeq: h.seq, board };
    // One validly chained line beyond the head: a crash between the line and the head.
    if (h.seq === last - 1 && h.hash === hashAt(last - 1)) return { ok: true, damaged: null, entries, headSeq: h.seq, board };
    if (h.seq > last) return bad(`the head records ${h.seq} entries but the file holds ${last} (rolled back to an older copy)`);
    return bad(`the head (seq ${h.seq}) does not match the file (seq ${last})`);
  }
}

/**
 * SERVER ONLY. Append one entry (record | revoke | adoption) to a store that has
 * just verified. Synchronous from the caller's check to here — the server runs one
 * request at a time through this, so checks and writes do not interleave.
 */
export function appendEntry(dataDir, boardDir, key, entry) {
  const st = loadStore(dataDir, boardDir, key);
  if (!st.ok) throw Object.assign(new Error(`the delegation store is damaged: ${st.damaged}`), { code: 'delegation-store-damaged' });
  const { file, head } = storeFiles(dataDir, boardDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let prevLine = null;
  if (st.entries.length) {
    const text = fs.readFileSync(file, 'utf8').split('\n');
    prevLine = text[st.entries.length - 1];
  }
  const full = sealed(key, { ...entry, seq: st.entries.length + 1, prev: prevLine === null ? 'genesis' : sha256(prevLine), board: st.board });
  const line = JSON.stringify(full);
  const fd = fs.openSync(file, 'a', 0o600);
  try { fs.writeSync(fd, `${line}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const h = sealed(key, { seq: full.seq, hash: sha256(line), board: st.board });
  const tmp = `${head}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(h)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, head);
  return full;
}

/* ─────────────────────────────────────────────────────────── the questions */

/** Validate the user's delegation request. Returns { ok, errors, value }. */
export function validateDelegationInput(input, now = new Date()) {
  const errors = [];
  const statement = String(input?.statement ?? '').replace(/\s+/g, ' ').trim();
  if (!statement) errors.push('statement: your words are required (what you told the agents)');
  if (statement.length > MAX_STATEMENT) errors.push(`statement: at most ${MAX_STATEMENT} characters`);
  const raw = Array.isArray(input?.tickets) ? input.tickets : [];
  const tickets = [...new Set(raw.map((t) => String(t ?? '').trim().toUpperCase()))];
  if (!tickets.length) errors.push('tickets: name at least one ticket id — a delegation is always scoped');
  if (tickets.length > MAX_SCOPE_TICKETS) errors.push(`tickets: at most ${MAX_SCOPE_TICKETS} explicit ids`);
  const badIds = tickets.filter((t) => !TICKET_ID.test(t));
  if (badIds.length) errors.push(`tickets: ${badIds.join(', ')} ${badIds.length === 1 ? 'is' : 'are'} not ticket id(s) — explicit ids only, no wildcards`);
  const days = input?.days === undefined || input?.days === null || input?.days === '' ? DEFAULT_DAYS : Number(input.days);
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) errors.push(`days: a whole number from 1 to ${MAX_DAYS}`);
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors,
    value: { statement, scope: { tickets }, permits: PERMITS, expires_at: new Date(now.getTime() + days * 86400_000).toISOString() },
  };
}

/** Every record with its live state, for the GET route and the ticket view. */
export function listDelegations(store, now = new Date()) {
  const revoked = new Map(store.entries.filter((e) => e.kind === 'revoke').map((e) => [e.delegation_id, e.recorded_at]));
  return store.entries.filter((e) => e.kind === 'record').map((e) => {
    const { seal: _s, prev: _p, board: _b, ...rest } = e;
    const state = revoked.has(e.delegation_id) ? 'revoked' : Date.parse(e.expires_at) <= now.getTime() ? 'expired' : 'live';
    return { ...rest, state, revoked_at: revoked.get(e.delegation_id) ?? null };
  });
}

/**
 * Is delegation `id` live for `ticketId` at `now`? Returns
 *   { ok: true, delegation } | { ok: false, code, why }
 */
export function liveDelegation(boardDirOrStore, id, ticketId, { dataDir = defaultDataDir(), key, now = new Date() } = {}) {
  const store = typeof boardDirOrStore === 'string'
    ? loadStore(dataDir, boardDirOrStore, key === undefined ? readDelegationKey(dataDir) : key)
    : boardDirOrStore;
  if (!store.ok) return { ok: false, code: 'delegation-store-damaged', why: `the delegation store cannot be trusted: ${store.damaged}` };
  const rec = store.entries.find((e) => e.kind === 'record' && e.delegation_id === id);
  if (!rec) return { ok: false, code: 'delegation-not-found', why: `no delegation ${id} was recorded by the user for this board` };
  if (!rec.scope?.tickets?.includes(ticketId)) {
    return { ok: false, code: 'out-of-scope', why: `delegation ${id} covers ${rec.scope?.tickets?.join(', ') || 'nothing'}, not ${ticketId}` };
  }
  const rv = store.entries.find((e) => e.kind === 'revoke' && e.delegation_id === id);
  if (rv) return { ok: false, code: 'delegation-revoked', why: `the user revoked delegation ${id} on ${String(rv.recorded_at).slice(0, 10)}` };
  if (!(Date.parse(rec.expires_at) > now.getTime())) {
    return { ok: false, code: 'delegation-expired', why: `delegation ${id} expired on ${String(rec.expires_at).slice(0, 10)}` };
  }
  return { ok: true, delegation: rec };
}

/** The store's sealed adoption entry matching a ticket's typed adoption, or null. */
export function adoptionReceipt(store, ticketId, a) {
  if (!store?.ok || !a) return null;
  const digest = typedAnswerDigest(a);
  return store.entries.find((e) => e.kind === 'adoption'
    && e.answer_id === a.answer_id && e.ticket === ticketId && e.decision_key === a.decision_key
    && e.delegation_id === a.delegation_id && e.digest === digest) ?? null;
}

/* ─────────────────────────────────────── user-answer receipts (round-2 review) */

/**
 * FEAT-184 r2 — a USER answer is authenticated the same way as an adoption: the
 * server's answer writer (board.ts recordAnswer) appends a sealed `answer` receipt
 * before it writes the ticket, so an agent that edits a ticket's typed JSON —
 * flipping an adoption to `by: 'user'`, or fabricating a user answer — produces an
 * entry no reader counts.
 *
 * TRUST MODES, per board (`userAnswerTrust`):
 *   'legacy'   no key on this machine, or this board has no store yet: typed user
 *              answers count as they did before FEAT-184 (nothing to verify against).
 *              The first server write for the board migrates every existing typed
 *              user answer into a receipt (`ensureBoardStore`), and from then on —
 *   'receipts' only a user answer with a matching sealed receipt counts;
 *   'damaged'  the store does not verify: no user answer and no adoption counts
 *              (fail closed; board:check says why).
 * RESIDUAL (same-uid, stated): deleting BOTH store files returns a board to
 * 'legacy' until the next server write re-migrates — deliberate tampering with the
 * data dir, the same class as reading the seal key.
 */
export function userAnswerTrust(store, storePresent) {
  if (!storePresent) return 'legacy';
  if (!store.ok) return 'damaged';
  // A migration interrupted by a crash has no `migrated` marker yet: until the next
  // server write resumes it, user answers read as they did before FEAT-184.
  return storeMigrated(store) ? 'receipts' : 'legacy';
}
export function storePresent(dataDir, boardDir) {
  const { file, head } = storeFiles(dataDir, boardDir);
  return fs.existsSync(file) || fs.existsSync(head);
}
/**
 * The digest a receipt binds: EVERY field a reader shows or acts on (plan review
 * round 3 — binding only the identity let an agent change A to B, or the note, on
 * an authenticated answer). Only bookkeeping that is recomputed or display-only
 * (`log_k`, `heading_sha`) is left out.
 */
export function typedAnswerDigest(a) {
  // `id` is the ticket id the answer ledger prefixes; the receipt binds the ticket itself.
  const { log_k: _k, heading_sha: _h, id: _id, ...payload } = a ?? {};
  return sha256(canonical(payload));
}
/** The sealed receipt for one typed USER answer, or null. */
export function answerReceipt(store, ticketId, a) {
  if (!store?.ok || !a) return null;
  const digest = typedAnswerDigest(a);
  return store.entries.find((e) => e.kind === 'answer' && e.answer_id === a.answer_id && e.ticket === ticketId && e.digest === digest) ?? null;
}
/** The receipt fields for one typed user answer. */
export function answerReceiptEntry(ticketId, a, legacy = false) {
  return { kind: 'answer', answer_id: a.answer_id, ticket: ticketId, digest: typedAnswerDigest(a), recorded_at: a.recorded_at ?? new Date().toISOString(), ...(legacy ? { legacy: true } : {}) };
}
/** Has this board's one-time migration of pre-existing user answers completed? */
export function storeMigrated(store) {
  return !!store?.ok && store.entries.some((e) => e.kind === 'migrated');
}
/**
 * SERVER ONLY. Make sure this board has a store; if it has none, create it by
 * sealing a receipt for every typed user answer already on the board (`legacy()`
 * returns [{ ticket, answer }]). Returns the key.
 */
export function ensureBoardStore(dataDir, boardDir, legacy, { hasAdoptions } = {}) {
  const key = ensureDelegationKey(dataDir);
  const present = storePresent(dataDir, boardDir);
  // FEAT-184 r2 (fixing r2) — FAIL LOUD on an accidental (or deliberate) deletion.
  // An adoption on a board can ONLY exist because the server's adopt route once
  // wrote its sealed receipt here. So if the store is GONE but the board still
  // carries adoptions, the store was deleted — and re-migrating would silently seal
  // a fresh "legacy" store, laundering any agent-fabricated by:user answer into a
  // trusted receipt (the store-delete laundering break). Refuse; the operator must
  // restore the store files, not let a server write recreate them.
  if (!present && typeof hasAdoptions === 'function' && hasAdoptions()) {
    throw Object.assign(
      new Error('the delegation store for this board is missing, but the board carries adoptions recorded under it — refusing to recreate it. The store was deleted or moved; restore <dataDir>/delegations/<hash>.jsonl and its .head rather than re-migrating (an accidental delete is in scope; see FEAT-184).'),
      { code: 'delegation-store-deleted' },
    );
  }
  const st = present ? loadStore(dataDir, boardDir, key) : null;
  if (st && !st.ok) throw Object.assign(new Error(`the delegation store is damaged: ${st.damaged}`), { code: 'delegation-store-damaged' });
  if (st && storeMigrated(st)) return key;
  // Fresh, or a migration a crash interrupted: (re)seal a receipt for every typed user
  // answer that has none yet, then the marker. Resumable: already-sealed ones are skipped.
  const done = new Set((st?.entries ?? []).filter((e) => e.kind === 'answer').map((e) => `${e.ticket}\0${e.answer_id}`));
  for (const { ticket, answer } of legacy()) {
    if (done.has(`${ticket}\0${answer.answer_id}`)) continue;
    appendEntry(dataDir, boardDir, key, answerReceiptEntry(ticket, answer, true));
  }
  appendEntry(dataDir, boardDir, key, { kind: 'migrated', recorded_at: new Date().toISOString() });
  return key;
}

/* ──────────────────────────────────────── one writer at a time per ticket file */

/**
 * FEAT-184 r3 — a cross-process critical section around a ticket file's
 * read-check-write (the server's answer/adopt writers and board-tool's record
 * writers). It is a KERNEL lock: `flock(1)` takes an exclusive flock(2) on a lock
 * file keyed by the ticket's real path and holds it in a tiny child for exactly as
 * long as `fn` runs. The kernel releases it when the holder exits — no stale-lock
 * reclaim, so no reclaim race and no eviction of a slow live holder (plan review
 * round 3). The child also exits if this process dies (it watches our pid).
 * Synchronous on purpose: the server's handlers stay synchronous between their
 * checks and their writes. Waits up to `waitMs`, then refuses (409 ticket-locked).
 */
let FLOCK_OK = null;
function flockAvailable() {
  if (FLOCK_OK === null) {
    try { FLOCK_OK = spawnSync('flock', ['--version'], { stdio: 'ignore' }).status === 0; } catch { FLOCK_OK = false; }
  }
  return FLOCK_OK;
}
const HOLD_SCRIPT = 'printf held > "$1"; while [ ! -e "$2" ] && kill -0 "$3" 2>/dev/null; do sleep 0.01; done; rm -f "$1" "$2"';

export function withTicketLock(file, fn, { waitMs = 5000 } = {}) {
  if (!flockAvailable()) {
    throw Object.assign(new Error('the ticket write lock needs flock(1) (util-linux), which is not installed — refusing to write without it'), { code: 'ticket-lock-unavailable', status: 500 });
  }
  const dir = path.join(os.tmpdir(), 'orchard-ticket-locks');
  fs.mkdirSync(dir, { recursive: true });
  let real; try { real = fs.realpathSync(file); } catch { real = path.resolve(file); }
  const lock = path.join(dir, `${sha256(real)}.lock`);
  const tag = `${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  const held = `${lock}.${tag}.held`;
  const release = `${lock}.${tag}.rel`;
  const child = spawn('flock', ['-x', '-w', String(Math.max(1, Math.ceil(waitMs / 1000))), lock, 'sh', '-c', HOLD_SCRIPT, 'sh', held, release, String(process.pid)], { stdio: 'ignore' });
  child.on('error', () => { /* surfaced as a timeout below */ });
  child.unref();
  const nap = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + waitMs + 1500;
  while (!fs.existsSync(held)) {
    if (Date.now() > deadline) {
      try { fs.writeFileSync(release, ''); } catch { /* best effort */ }
      throw Object.assign(new Error(`another writer holds ${path.basename(file)} — retry`), { code: 'ticket-locked', status: 409 });
    }
    Atomics.wait(nap, 0, 0, 3);
  }
  try { return fn(); } finally { try { fs.writeFileSync(release, ''); } catch { /* the child also exits with us */ } }
}

/**
 * A WRITE-TIME LINT ONLY (FEAT-184 fixing r2): does this plain-ASCII text read as the
 * user? The routes reject such an author early as a courtesy, but this is NOT the
 * protection — it is defeated by Unicode/quote lookalikes (U+200B"you", Cyrillic
 * "уou", quoted "you"). WHO decided is instead rendered solely from the typed entry
 * KIND (composeAdoptionEntry's fixed "an agent" heading, renderAdopted's fixed
 * subject), where agent-supplied text can never read as the user. See FEAT-184.
 */
export const READS_AS_USER = /^\s*(you|user|the user)\b/i;
