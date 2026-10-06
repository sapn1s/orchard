/**
 * verification-source.mjs — THE ONE SOURCE of a ticket's independent-verification
 * evidence (BUG-225 round 3, ARCH-009, ARCH-010).
 *
 * WHY. Proof of verification used to be regex-parsed out of free prose
 * (`Verified-by: dispatch <provider>/<model> run <id> … VERDICT: X`). Two rounds of
 * clean-room attack found the next spelling each time — backticks, fences, NBSP,
 * links, table cells, `(TODO) run 7f3a…` placeholders — and found the count was
 * verdict-blind (a BROKEN-only ticket counted as verified). Widening or narrowing
 * a regex is enumeration by construction (WA §N). So proof is now a TYPED ENTRY:
 *
 *   { provider, model, run_id, verdict: holds|broken|invalid, verdict_on,
 *     recorded_at, author, recorded_by: "board-tool", harness, note? }
 *
 * WHERE IT LIVES — exactly one place per ticket, read by one function:
 *   - a record-format ticket: its record's `verification[]` (ARCH-009);
 *   - a legacy prose ticket (no record block, which must not be migrated without
 *     asking): the board-level ledger `<board>/verification-ledger.json`;
 *   - if neither holds an entry: the FROZEN legacy snapshot
 *     `<board>/verification-legacy.frozen.json` — the round-2 prose reader's
 *     output over the board, captured ONCE and pinned by hash in this file. Prose
 *     is never parsed at read time to decide proof, so a line typed after the
 *     freeze counts in NO spelling.
 *
 * WHO WRITES: `node scripts/board-tool.mjs verified` (record or ledger) and
 * `node scripts/board.mjs freeze-verifications` (the snapshot, once). A human-
 * readable "Verification recorded:" echo goes in the Activity log; no reader
 * treats it as proof.
 *
 * THE RULE over the entries is `isIndependentlyVerified` (holds present, no
 * outstanding broken) in public/lib/ticket-record.js, next to `outstandingBroken`.
 *
 * PORTABILITY: copied into onboarded targets with board.mjs (flat `.orchard/lib/`),
 * so the rule module is imported by candidate path, never a fixed layout.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { extractVerifiedBy, verifiedByNearMisses } from './verdict-contract.mjs';
import { extractTicketBlock, VERDICTS, TICKET_ID_RE } from './ticket-schema.mjs';

async function loadRule() {
  let lastErr = null;
  for (const rel of ['../../public/lib/ticket-record.js', './ticket-record.js']) {
    try {
      const m = await import(new URL(rel, import.meta.url).href);
      if (typeof m.isIndependentlyVerified === 'function') return m;
    } catch (e) { lastErr = e; }
  }
  throw new Error(`verification-source: cannot load the proof rule (ticket-record.js): ${lastErr?.message ?? 'not found'}`);
}
const RULE = await loadRule();
export const isIndependentlyVerified = RULE.isIndependentlyVerified;
export const outstandingBroken = RULE.outstandingBroken;

export const FROZEN_FILE = 'verification-legacy.frozen.json';
export const LEDGER_FILE = 'verification-ledger.json';
export const FROZEN_SCHEMA = 'orchard-verification-legacy-freeze/1';
export const LEDGER_SCHEMA = 'orchard-verification-ledger/1';

/**
 * sha256 (hex) of every frozen snapshot this code accepts. The snapshot is
 * written once; changing it (or deleting and re-freezing to bless newer prose)
 * is a deliberate code edit here, visible in review — board:check FAILs an
 * unpinned snapshot. A new board that freezes adds its own hash.
 */
export const FROZEN_LEGACY_PINS = [
  // Orchard's own board, frozen 2026-09-30 (BUG-225 round 3: 767b3380…), then
  // RE-DERIVED in round 4 with the fixed legacy reader over only the lines the
  // round-3 snapshot already knew — 8 tickets' records changed, each hand-reviewed;
  // ARCH-020, BUG-216 and FEAT-144 regain a real standing HOLDS the round-3
  // snapshot had mis-graded. The round-3 hash is deliberately NOT kept.
  '3760b72269c8c386c38cb52b33bf5cb6169c605c86f6cee94428c07833ec9c79',
];

export const PROVIDERS = ['anthropic', 'openai'];
/** A run id carries a digit and is one token (BUG-225 r1). */
export const RUN_ID_RE = /^(?=[A-Za-z._:-]*[0-9])[A-Za-z0-9][A-Za-z0-9._:-]{5,}$/;
/** A model is one token: no whitespace, backtick or parenthesis. */
export const MODEL_RE = /^[^\s`()]+$/;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
/** The identity of a prose line: its trimmed physical text. */
export const lineSha = (line) => sha256(String(line ?? '').trim());

/* ─────────────────────────────────────── the frozen legacy prose reader */

/**
 * THE LEGACY COMPATIBILITY READER — the round-2 prose reader, frozen. It is used
 * for exactly three things, none of which is a live proof decision:
 *   1. building the frozen snapshot (`buildFrozenSnapshot`);
 *   2. migrate-tickets / provenance-check, which transcribe and grade ARCHIVED
 *      prose originals (and migration refuses any record the snapshot lacks);
 *   3. board:check's loud "prose verification not counted" nudge.
 * `verdict` is the record's `VERDICT: X` token mapped into the closed enum (no
 * token, or a word outside it, is `invalid` — the mapping migrate-tickets has
 * always used); `raw_verdict` keeps the token itself (or null).
 */
export function legacyProseVerifications(text) {
  const lines = String(text ?? '').split('\n');
  const headingAt = [];
  let heading = null;
  for (let i = 0; i < lines.length; i++) {
    const h = /^###\s+(\d{4}-\d{2}-\d{2})/.exec(lines[i]);
    if (h) heading = h[1];
    headingAt.push(heading);
  }
  // BUG-225 round 4 (audit of the 41 verified→unverified flips): the round-2 reader
  // silently lost three REAL standing HOLDS — ARCH-020 and BUG-216 wrote the verdict
  // inside the run's parenthetical (`run <id> (clean-room round 5, HOLDS, …)`, no
  // `VERDICT:` token), and FEAT-144 wrote `**Verified-by (round 2, weakened):**
  // dispatch **anthropic** … VERDICT: **HOLDS**` (emphasis + a label annotation).
  // Its output decides proof ONLY through the frozen snapshot (whose records were
  // reviewed one by one at the round-4 re-derivation); over live prose it feeds
  // only the advisory/drift checks and migration's sequence comparison, so a
  // post-freeze line it parses as HOLDS still counts for nothing. Emphasis markers are stripped within a line (the
  // line count is unchanged, so line identity/sha is still the ORIGINAL line).
  const norm = lines.map((l) => (/Verified-by|VERDICT:/i.test(l) || /^[ \t]+\S/.test(l)
    ? l.replace(/\*\*/g, '').replace(/(Verified-by)[ \t]*\([^)\n]*\)[ \t]*:/i, '$1:')
    : l)).join('\n');
  return extractVerifiedBy(norm).map((r) => {
    const vm = /VERDICT:\s*[*_`]*([A-Za-z]+)/i.exec(r.record);
    let raw = vm ? vm[1].toLowerCase() : null;
    if (!vm) {
      // No VERDICT token: accept ONE unambiguous upper-case verdict word written
      // inside the parenthetical that immediately follows the run id.
      const pm = /\brun[ \t]+`?[A-Za-z0-9._:-]+`?[ \t]*\(([^)]*)\)/.exec(r.record);
      const words = pm ? [...new Set([...pm[1].matchAll(/\b(HOLDS|BROKEN|INVALID)\b/g)].map((m) => m[1]))] : [];
      if (words.length === 1) raw = words[0].toLowerCase();
    }
    const harness = /\(([^)]*?)`([^`]+)`/.exec(r.record);
    return {
      provider: r.provider,
      model: r.model ?? null,
      run_id: r.runId,
      verdict: VERDICTS.includes(raw) ? raw : 'invalid',
      raw_verdict: raw,
      verdict_on: headingAt[r.index] ?? null,
      harness: harness ? harness[2] : null,
      line_sha256: lineSha(lines[r.index]),
      lineNo: r.lineNo,
    };
  });
}

/** Any physical line naming the Verified-by field, in any spelling a human types. */
const VERIFIED_BY_ANY_RE = /verified[\W_]{0,6}by/i;
const DISPATCHISH_RE = /\b(?:dispatch|anthropic|openai|codex|claude)\b/i;
const RUNISH_RE = /[0-9a-f]{6,}|\brun\b[^\n]{0,12}[0-9]/i;

/* ─────────────────────────────────────────────────────────── the stores */

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

/** The frozen snapshot: `{ present, pinned, sha256, error, tickets }`. */
export function loadFrozen(boardDir) {
  const r = readJsonCached(path.join(boardDir, FROZEN_FILE));
  if (!r.present) return { present: false, pinned: false, sha256: null, error: null, tickets: {} };
  const ok = r.data && r.data.schema === FROZEN_SCHEMA && r.data.tickets && typeof r.data.tickets === 'object';
  return {
    present: true,
    pinned: FROZEN_LEGACY_PINS.includes(r.sha256),
    sha256: r.sha256,
    error: r.error ?? (ok ? null : `not a ${FROZEN_SCHEMA} document`),
    tickets: ok ? r.data.tickets : {},
  };
}

/** The ledger (legacy prose tickets' typed entries): `{ present, error, entries }`. */
export function loadLedger(boardDir) {
  const r = readJsonCached(path.join(boardDir, LEDGER_FILE));
  if (!r.present) return { present: false, error: null, entries: [] };
  const ok = r.data && r.data.schema === LEDGER_SCHEMA && Array.isArray(r.data.entries);
  return { present: true, error: r.error ?? (ok ? null : `not a ${LEDGER_SCHEMA} document`), entries: ok ? r.data.entries : [] };
}

/** Frozen records for one ticket — only when the snapshot is pinned. */
export function frozenEntriesFor(boardDir, id) {
  const f = loadFrozen(boardDir);
  if (!f.present || !f.pinned || f.error) return [];
  const t = f.tickets[id];
  return Array.isArray(t?.records) ? t.records.map((e) => ({ ...e, origin: 'legacy-prose-freeze' })) : [];
}

export function ledgerEntriesFor(boardDir, id) {
  return loadLedger(boardDir).entries.filter((e) => e && e.id === id);
}

function recordOf(markdown) {
  const { block } = extractTicketBlock(String(markdown ?? ''));
  if (block === null) return null;
  try { const r = JSON.parse(block); return r && typeof r === 'object' && !Array.isArray(r) ? r : null; } catch { return null; }
}

/**
 * THE ONE READER. Every consumer (board.mjs → board:check and its advisory,
 * board-status, migrate-tickets, board-tool) calls this and nothing else.
 *
 * @returns {{ source: 'record'|'ledger'|'legacy-frozen'|'none', entries: object[], verified: boolean }}
 */
export function ticketVerifications(boardDir, { id, markdown }) {
  const record = recordOf(markdown);
  const structured = record && Array.isArray(record.verification) ? record.verification : [];
  let source = 'none';
  let entries = [];
  if (structured.length) { source = 'record'; entries = structured; }
  else {
    // The ledger holds entries for LEGACY prose tickets only; a record-format
    // ticket's one structured place is its own `verification[]` (r3 verify note,
    // run 61ffb863 — a ledger entry must not stand in for a record ticket).
    const led = record ? [] : ledgerEntriesFor(boardDir, id);
    if (led.length) { source = 'ledger'; entries = led; }
    else {
      const fr = frozenEntriesFor(boardDir, id);
      if (fr.length) { source = 'legacy-frozen'; entries = fr; }
    }
  }
  return { source, entries, verified: isIndependentlyVerified(entries) };
}

/* ───────────────────────────────────────────────────────── the writer side */

/**
 * Validate one typed entry. Returns a list of problems (empty = valid). Used by
 * board-tool before writing and by board:check over the ledger.
 */
export function entryProblems(e) {
  const p = [];
  if (!e || typeof e !== 'object' || Array.isArray(e)) return ['entry is not an object'];
  if (!PROVIDERS.includes(e.provider)) p.push(`provider ${JSON.stringify(e.provider)} not in ${PROVIDERS.join('|')}`);
  if (e.model !== null && e.model !== undefined && (typeof e.model !== 'string' || !MODEL_RE.test(e.model))) p.push(`model ${JSON.stringify(e.model)} is not one token`);
  if (typeof e.run_id !== 'string' || !RUN_ID_RE.test(e.run_id)) p.push(`run_id ${JSON.stringify(e.run_id)} is not a run id`);
  if (!VERDICTS.includes(e.verdict)) p.push(`verdict ${JSON.stringify(e.verdict)} not in ${VERDICTS.join('|')}`);
  for (const k of ['author', 'note', 'harness', 'recorded_at', 'verdict_on']) {
    if (e[k] !== undefined && e[k] !== null && (typeof e[k] !== 'string' || /[\r\n\u2028\u2029]/.test(e[k]))) p.push(`${k} must be a single-line string`);
  }
  return p;
}

/** Append entries to the ledger (atomic tmp+rename). Creates the file. */
export function appendLedger(boardDir, newEntries) {
  const file = path.join(boardDir, LEDGER_FILE);
  const cur = loadLedger(boardDir);
  if (cur.error) throw new Error(`${LEDGER_FILE} is unreadable (${cur.error}) — refusing to overwrite it`);
  const doc = { schema: LEDGER_SCHEMA, note: 'Typed independent-verification entries for LEGACY prose tickets. Written only by `board-tool verified`; read only through scripts/lib/verification-source.mjs.', entries: [...cur.entries, ...newEntries] };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/* ───────────────────────────────────────────────────────── the freeze */

/**
 * Build the frozen snapshot over every ticket file in `boardDir` using the frozen
 * legacy reader. `ticketFiles` is `[{ id, file }]`.
 */
export function buildFrozenSnapshot(boardDir, ticketFiles, { today }) {
  const tickets = {};
  for (const { id, file } of ticketFiles) {
    const text = fs.readFileSync(path.join(boardDir, file), 'utf8');
    const records = legacyProseVerifications(text).map(({ lineNo, ...e }) => e);
    const proseLines = [...new Set(text.split('\n').filter((l) => VERIFIED_BY_ANY_RE.test(l)).map(lineSha))];
    if (records.length || proseLines.length) tickets[id] = { records, prose_lines: proseLines };
  }
  return {
    schema: FROZEN_SCHEMA,
    frozen_on: today,
    note: 'Frozen output of the legacy `Verified-by:` prose reader (BUG-225). Read-only: pinned by sha256 in scripts/lib/verification-source.mjs. New verifications are typed entries written by `board-tool verified`.',
    tickets,
  };
}

/* ─────────────────────────────────────────────────────── the loud checks */

/**
 * `Verified-by` prose lines added AFTER the freeze that look like a dispatch
 * verification. They are never counted; board:check names them so a lane that
 * hand-typed one learns to use `board-tool verified`. A gap in this detector
 * costs a missed nudge, never a false accept.
 */
export function unfrozenProseVerifications(boardDir, id, text) {
  const f = loadFrozen(boardDir);
  const known = new Set(f.present && f.pinned ? (f.tickets[id]?.prose_lines ?? []) : []);
  const lines = String(text ?? '').split('\n');
  // A prose line that restates a TYPED entry of this ticket (same run id and
  // verdict) is an echo, and the remedy the FAIL asks for has been applied — so
  // it is not flagged. It still counts for nothing: proof is read from the typed
  // entries only, and migration never transcribes prose that is not frozen.
  // A "typed" entry here is one NOT carried from the frozen snapshot. Carried
  // entries are marked `origin: 'legacy-prose-freeze'` by board-tool, but records
  // migrated earlier carry them UNMARKED — so subtract the frozen records (as a
  // multiset) too; otherwise every copy of a frozen line on such a record ticket
  // read as an "echo" and was never counted (r4 re-verify run 35dd5b0b, ARCH-003).
  const frozenKeys = new Map();
  for (const r of (f.present && f.pinned ? (f.tickets[id]?.records ?? []) : [])) {
    const k = `${r.run_id}|${r.verdict}`;
    frozenKeys.set(k, (frozenKeys.get(k) ?? 0) + 1);
  }
  const typed = new Set();
  for (const e of ticketVerifications(boardDir, { id, markdown: text }).entries) {
    if (e.origin === 'legacy-prose-freeze') continue;
    const k = `${e.run_id}|${e.verdict}`;
    const n = frozenKeys.get(k) ?? 0;
    if (n > 0) { frozenKeys.set(k, n - 1); continue; }
    typed.add(k);
  }
  const echoAt = new Set(legacyProseVerifications(text)
    .filter((r) => typed.has(`${r.run_id}|${r.verdict}`)).map((r) => r.lineNo - 1));
  // Record lines as EITHER reader sees them: the frozen records were built by
  // legacyProseVerifications, which also reads emphasis/annotated-label spellings
  // the shared reader does not (round 4). Counting copies over the shared reader
  // alone left such a frozen line's COPY unnamed (r4 verify run 63ecbf9a, F1).
  const parsedAt = new Set([
    ...extractVerifiedBy(text).map((r) => r.index),
    ...legacyProseVerifications(text).map((r) => r.lineNo - 1),
  ]);
  const nearAt = new Set(verifiedByNearMisses(text).map((n) => n.lineNo - 1));
  // A frozen line is known by its text — but only as many times as it was frozen.
  // A COPY of a frozen record line (same text, a second occurrence) is new prose
  // (r3 verify, run 66eb2134: a frozen HOLDS copied below a later BROKEN was
  // silent on a ticket whose migration reads the ledger).
  const frozenCount = new Map();
  for (const r of (f.present && f.pinned ? (f.tickets[id]?.records ?? []) : [])) {
    frozenCount.set(r.line_sha256, (frozenCount.get(r.line_sha256) ?? 0) + 1);
  }
  const seen = new Map();
  const excessAt = new Set();
  for (const i of [...parsedAt].sort((a, b) => a - b)) {
    const sha = lineSha(lines[i]);
    if (!frozenCount.has(sha) || echoAt.has(i)) continue;
    const n = (seen.get(sha) ?? 0) + 1;
    seen.set(sha, n);
    if (n > frozenCount.get(sha)) excessAt.add(i);
  }
  const out = [];
  lines.forEach((line, i) => {
    if (!VERIFIED_BY_ANY_RE.test(line)) return;
    if ((known.has(lineSha(line)) && !excessAt.has(i)) || echoAt.has(i)) return;
    if (parsedAt.has(i) || nearAt.has(i) || (DISPATCHISH_RE.test(line) && RUNISH_RE.test(line))) {
      out.push({ lineNo: i + 1, line: line.trim() });
    }
  });
  return out;
}

/**
 * Frozen records the ticket no longer carries as frozen (append-only breach):
 * the head line is gone (`reason: 'missing'`), or it is present but no record on
 * it reads the frozen run + verdict any more (`reason: 'changed'`) — a
 * continuation line edited, or the head line moved under a new continuation.
 * Only the head line is hashed, so without the second test a frozen BROKEN could
 * be re-told as HOLDS in prose silently (r4 verify run 63ecbf9a, F2). Proof never
 * read that prose; this keeps the record honest and loud.
 */
export function frozenDrift(boardDir, id, text) {
  const f = loadFrozen(boardDir);
  const recs = f.present ? (f.tickets[id]?.records ?? []) : [];
  if (!recs.length) return [];
  const have = new Set(String(text ?? '').split('\n').map(lineSha));
  const key = (r) => `${r.line_sha256}|${r.run_id}|${r.verdict}`;
  const avail = new Map();
  for (const r of legacyProseVerifications(text)) avail.set(key(r), (avail.get(key(r)) ?? 0) + 1);
  const out = [];
  for (const r of recs) {
    if (!have.has(r.line_sha256)) { out.push({ ...r, reason: 'missing' }); continue; }
    const n = avail.get(key(r)) ?? 0;
    if (n > 0) avail.set(key(r), n - 1);
    else out.push({ ...r, reason: 'changed' });
  }
  return out;
}

export function isTicketId(id) { return TICKET_ID_RE.test(String(id ?? '')); }
