/**
 * answer-source.mjs — the STORES behind a ticket's user answer (FEAT-166 round 3).
 *
 * WHY. "Was this ticket answered?" used to be reconstructed from Activity-log prose
 * (`### DATE — you (answer · via …)` headings). Three clean-room rounds broke it by
 * three different prose paths (a follow-up resurrecting an old answer, a fenced
 * declaration example, an agent-written forged heading). Guarding a prose reader is
 * enumeration (WA §N). So — on the BUG-225 pattern (verification-source.mjs) — a
 * user's answer is a TYPED ENTRY, written by ONE writer (the server's answer route,
 * `recordAnswer` in src/server/board.ts) and read by ONE function (`boundAnswers`,
 * same file). The Activity-log heading the writer also appends is DISPLAY ONLY.
 *
 *   { answer_id, kind: decision|question|counter, followup, chose, note, question,
 *     by: 'user', via, on, recorded_at, recorded_by: 'server', decision_key,
 *     log_k, heading_sha }
 *
 * WHERE IT LIVES — one place per ticket:
 *   - a record ticket with a live record `decision`: `decision.answers[]` — bound to
 *     that decision by CONTAINMENT (board-tool decide builds a fresh decision, so a
 *     re-declaration starts with no answers) and by `decision_key`;
 *   - anything else (a legacy prose ticket, or a record whose decision is null): the
 *     board ledger `<board>/answer-ledger.json`, bound by `decision_key`;
 *   - answers given BEFORE round 3 (prose only): the FROZEN snapshot
 *     `<board>/answers-legacy.frozen.json` — the round-2 prose reader's output,
 *     captured once and pinned by hash here. Prose typed after the freeze counts in
 *     no spelling; `board:check` FAILs a user-reply-shaped heading it cannot account
 *     for.
 *
 * WHO WRITES: the server answer route only (tickets.answerTicket, board.appendAnswer
 * → board.recordAnswer). `scripts/board-tool.mjs` has no verb or flag that writes an
 * answer. OUT OF SCOPE: a same-uid process deliberately editing the typed JSON (the
 * FEAT-164 self-grant class) — the goal here is that no PROSE counts.
 *
 * PORTABLE: plain JS, no server imports, so board.mjs (board:check) can use it.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ANSWER_LEDGER_FILE = 'answer-ledger.json';
export const ANSWER_FROZEN_FILE = 'answers-legacy.frozen.json';
export const ANSWER_LEDGER_SCHEMA = 'orchard-answer-ledger/1';
export const ANSWER_FROZEN_SCHEMA = 'orchard-answers-legacy-freeze/1';
export const ANSWER_KINDS = ['decision', 'question', 'counter'];

/**
 * sha256 (hex) of every frozen answer snapshot this code accepts. Written once;
 * re-freezing (to bless newer prose) is a deliberate code edit here, visible in
 * review. An unpinned or edited snapshot counts for nothing.
 */
export const ANSWER_FROZEN_PINS = [
  // Orchard's own board, frozen 2026-10-05 (FEAT-166 round 3) from the round-2 reader.
  '09bdd81f3b9665da60bee699f6ff589144e8e2632a8ee3021483ae788663656b',
];

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** Deterministic JSON (sorted object keys) — the input to a decision key. */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/* ─────────────────────────────────── the Activity-log heading scan (display) */

const ENTRY_HEADING_RE = /^###\s+(\d{4}-\d\d-\d\d)\s+—\s+(.*)$/;
const FENCE_RE = /^(?:```|~~~)/;
/** A user-reply-shaped author: what the answer writer composes, in any kind. */
export const USER_REPLY_AUTHOR_RE = /^you\s+\((?:answer|follow-?up|question|counter|via Needs-You rail)/i;

/**
 * Every Activity-log entry heading, in order, skipping fenced examples. Used for
 * DISPLAY and the "has an agent acted since" count only — never to decide whether
 * a ticket was answered.
 */
export function activityHeadings(text, { includeFenced = false } = {}) {
  const lines = String(text ?? '').split('\n');
  const out = [];
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (FENCE_RE.test(t)) { fenced = !fenced; continue; }
    if (fenced && !includeFenced) continue;
    const m = t.match(ENTRY_HEADING_RE);
    if (!m) continue;
    out.push({ date: m[1], author: m[2].trim(), line: i, k: out.length, sha: sha256(t) });
  }
  return out;
}

/* ─────────────────────────────────────────────────────────────── the stores */

const cache = new Map();
function readJsonCached(file) {
  let st;
  try { st = fs.statSync(file); } catch { return { present: false }; }
  const key = `${file}|${st.mtimeMs}|${st.size}`;
  if (cache.has(key)) return cache.get(key);
  const bytes = fs.readFileSync(file);
  let data = null, error = null;
  try { data = JSON.parse(bytes.toString('utf8')); } catch (e) { error = e.message; }
  const out = { present: true, data, error, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  cache.set(key, out);
  return out;
}

/** The frozen pre-round-3 answers: `{ present, pinned, sha256, error, tickets }`. */
export function loadAnswerFrozen(boardDir) {
  const r = readJsonCached(path.join(boardDir, ANSWER_FROZEN_FILE));
  if (!r.present) return { present: false, pinned: false, sha256: null, error: null, tickets: {} };
  const ok = r.data && r.data.schema === ANSWER_FROZEN_SCHEMA && r.data.tickets && typeof r.data.tickets === 'object';
  return {
    present: true,
    pinned: ANSWER_FROZEN_PINS.includes(r.sha256),
    sha256: r.sha256,
    error: r.error ?? (ok ? null : `not a ${ANSWER_FROZEN_SCHEMA} document`),
    tickets: ok ? r.data.tickets : {},
  };
}

/** One ticket's frozen record — only from a pinned, readable snapshot. */
export function frozenAnswerFor(boardDir, id) {
  const f = loadAnswerFrozen(boardDir);
  if (!f.present || !f.pinned || f.error) return null;
  return f.tickets[id] ?? null;
}

/** The ledger: `{ present, error, entries }`. */
export function loadAnswerLedger(boardDir) {
  const r = readJsonCached(path.join(boardDir, ANSWER_LEDGER_FILE));
  if (!r.present) return { present: false, error: null, entries: [] };
  const ok = r.data && r.data.schema === ANSWER_LEDGER_SCHEMA && Array.isArray(r.data.entries);
  return { present: true, error: r.error ?? (ok ? null : `not a ${ANSWER_LEDGER_SCHEMA} document`), entries: ok ? r.data.entries : [] };
}

export function ledgerAnswersFor(boardDir, id) {
  return loadAnswerLedger(boardDir).entries.filter((e) => e && e.id === id);
}

/**
 * Append one typed answer to the ledger (write-temp + rename, so a concurrent
 * reader never sees half a file). Called ONLY by board.ts `recordAnswer`.
 */
export function appendLedgerAnswer(boardDir, id, typed) {
  const file = path.join(boardDir, ANSWER_LEDGER_FILE);
  const cur = loadAnswerLedger(boardDir);
  if (cur.error) throw new Error(`${ANSWER_LEDGER_FILE} is unreadable (${cur.error}) — refusing to overwrite it`);
  const doc = {
    schema: ANSWER_LEDGER_SCHEMA,
    note: 'Typed user answers for tickets with no record decision (FEAT-166). Written only by the server answer route; read by boundAnswers in src/server/board.ts.',
    entries: [...cur.entries, { id, ...typed }],
  };
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** Every typed answer a ticket record carries, current or superseded (for heading accounting). */
export function recordTypedAnswers(record) {
  const out = [];
  const d = record?.decision;
  if (d && typeof d === 'object' && Array.isArray(d.answers)) out.push(...d.answers);
  for (const h of Array.isArray(record?.decision_history) ? record.decision_history : []) {
    if (h && Array.isArray(h.answers)) out.push(...h.answers);
  }
  return out.filter((a) => a && typeof a === 'object');
}

/**
 * board:check — user-reply-shaped Activity headings that NO typed answer and no
 * frozen record accounts for (by line sha, with multiplicity). Such a heading was
 * typed after the freeze by something other than the answer writer: it counts for
 * nothing, and is reported so the mistake (or the imitation) is loud.
 */
export function unaccountedAnswerHeadings(boardDir, id, text, record) {
  const budget = new Map();
  const add = (sha) => { if (sha) budget.set(sha, (budget.get(sha) ?? 0) + 1); };
  const frozen = frozenAnswerFor(boardDir, id);
  for (const s of Array.isArray(frozen?.heading_shas) ? frozen.heading_shas : []) add(s);
  for (const a of recordTypedAnswers(record)) add(a.heading_sha);
  for (const a of ledgerAnswersFor(boardDir, id)) add(a.heading_sha);
  const out = [];
  // FEAT-166 r4 — scan INCLUDING fenced lines. A user-reply-shaped heading is never
  // legitimately inside a code fence; fencing a forged `you (answer … decision …)`
  // heading hid it from this advisory WARN while `boundAnswers` still (correctly)
  // counted it for nothing. board:check now warns on the imitation regardless of
  // fencing — it is a warning about prose that imitates an answer, not an
  // answered-state decision (that stays typed-only and unaffected).
  for (const h of activityHeadings(text, { includeFenced: true })) {
    if (!USER_REPLY_AUTHOR_RE.test(h.author)) continue;
    const n = budget.get(h.sha) ?? 0;
    if (n > 0) { budget.set(h.sha, n - 1); continue; }
    out.push({ line: h.line + 1, date: h.date, author: h.author });
  }
  return out;
}
