#!/usr/bin/env node
/**
 * board-status.mjs — ground truth for an ORCHESTRATOR that cannot read files.
 *
 * WHY THIS EXISTS (ARCH-018 / the measured failure it fixes)
 * ----------------------------------------------------------
 * An Orchard orchestrator runs under an enforced tool profile that removes
 * `Read`, `Grep` and `git grep`; it can run npm/node/git-status commands and
 * little else. So the one artifact the whole project cites — a ticket's durable
 * record — is the one thing it cannot look at. On 2026-09-23 an orchestrator
 * asserted ARCH-017's review history to the user FOUR times, from three lane
 * reports that gave three contradictory counts ("11 rejections", then "7", then
 * "8"), and relayed each as settled fact. The user could see on their own board
 * that the ticket was marked Done; the orchestrator could not check the ticket
 * at all, and appended a review verdict to a ticket the board presented as
 * closed.
 *
 * This command answers "what is the CURRENT state of ticket X" from the board's
 * own durable record, in a shape compact enough to paste into an orchestrator's
 * context: status / work_state, the INDEX row, whether the file is dirty in the
 * working tree, the last N Activity-log entry HEADERS (dates + one-line
 * summaries, never bodies), any `Verified-by:` lines, and the recorded commit if
 * Done. Zero args prints a whole-board open/needs-you summary. `--json` for
 * machine use.
 *
 * ARCH-010 COMPLIANCE — it does NOT introduce a second ticket parser. Every fact
 * is read through the ONE shared reader: `readTickets` / `readIndex` from
 * board.mjs (which import scripts/lib/ticket-schema.mjs), `classifyLegacyStatus`
 * from ticket-schema.mjs, and `VERIFIED_BY_RE` from verdict-contract.mjs. This
 * file composes their output; it re-derives nothing.
 *
 * Usage:
 *   node scripts/board-status.mjs                 # whole-board summary
 *   node scripts/board-status.mjs ARCH-017        # one ticket
 *   node scripts/board-status.mjs ARCH-017 --json
 *   node scripts/board-status.mjs ARCH-017 --entries=8   # last 8 log headers
 *   [--dir=docs/bugs]
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { execFileSync } from 'node:child_process';

import { readTickets, readIndex } from './board.mjs';
import { resolveBoardDir } from './lib/board-path.mjs';
import { classifyLegacyStatus, TICKET_ID_RE } from './lib/ticket-schema.mjs';
import { VERIFIED_BY_RE } from './lib/verdict-contract.mjs';

const DEFAULT_ENTRIES = 5;
const STATUS_CELL_MAX = 200; // one-line status header, truncated for pasteability

/** Normalise an id the way the board does: case-insensitive, zero-pad-insensitive. */
function normalizeId(raw) {
  const m = /^(arch|bug|feat|deploy)-0*(\d+)$/i.exec(String(raw ?? '').trim());
  return m ? `${m[1].toUpperCase()}-${m[2]}` : null;
}

/** One line, whitespace collapsed, hard-capped. Never a body — headers only. */
function oneLine(s, max = STATUS_CELL_MAX) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * The Activity-log entry HEADERS, newest first. Anchored to the `## Activity
 * log` section so design-body `### ` sub-headings above it are never counted.
 * Returns the raw heading text (`### 2026-09-23 — …`) trimmed to one line — a
 * date + one-line summary, which is exactly what the header already is. Bodies
 * are never read.
 */
function activityHeaders(text) {
  const lines = String(text ?? '').split('\n');
  const logStart = lines.findIndex((l) => /^##\s+Activity log\b/i.test(l.trim()));
  const from = logStart === -1 ? 0 : logStart + 1;
  const heads = [];
  for (let i = from; i < lines.length; i++) {
    if (/^###\s+/.test(lines[i])) heads.push(oneLine(lines[i], 160));
  }
  return heads.reverse(); // newest first
}

/** Every `Verified-by:` line in the file (the shared reader finds only the first). */
function allVerifiedBy(text) {
  const src = String(text ?? '');
  const re = new RegExp(VERIFIED_BY_RE.source, 'gim');
  const out = [];
  for (let m = re.exec(src); m; m = re.exec(src)) {
    out.push(oneLine(m[0], 160));
  }
  return out;
}

/**
 * Is the ticket file dirty in the working tree? Read from git's own porcelain
 * (never a second guess) and decoded into words an orchestrator can act on.
 */
function worktreeState(dir, file) {
  const rel = path.relative(process.cwd(), path.join(dir, file));
  let line;
  try {
    line = execFileSync('git', ['status', '--porcelain', '--', rel], { encoding: 'utf8' });
  } catch (err) {
    return { code: null, label: `unknown (git status failed: ${err?.message ?? err})`, dirty: null };
  }
  if (!line.trim()) return { code: '', label: 'clean (committed, no pending changes)', dirty: false };
  const code = line.slice(0, 2);
  const x = code[0]; // staged
  const y = code[1]; // unstaged/worktree
  const parts = [];
  if (x === 'A') parts.push('staged add');
  else if (x === 'M') parts.push('staged modification');
  else if (x === 'D') parts.push('staged delete');
  else if (x === 'R') parts.push('staged rename');
  else if (x === '?') parts.push('untracked');
  if (y === 'M') parts.push('unstaged modifications');
  else if (y === 'D') parts.push('unstaged delete');
  const label = `DIRTY (${code.trim() || code}${parts.length ? ' — ' + parts.join(' + ') : ''})`;
  return { code: code.trim(), label, dirty: true };
}

function buildTicketReport(dir, id, entries) {
  const { tickets } = readTickets(dir);
  // Match zero-pad- and case-insensitively (ARCH-17 ≡ ARCH-017) against the real
  // map key, so the id the caller typed need not match the filename's padding.
  let t = tickets.get(id);
  if (!t) for (const cand of tickets.values()) { if (normalizeId(cand.id) === id) { t = cand; break; } }
  if (!t) {
    return { ok: false, id, error: `no ticket file for ${id} in ${dir} (looked for ${id}-*.md)` };
  }
  id = t.id; // canonical id as the board records it
  const indexPath = path.join(dir, 'INDEX.md');
  let idx = null;
  try { idx = readIndex(indexPath); } catch { idx = null; }

  const inOpen = !!idx && idx.openRows.has(id);
  const inDone = !!idx && idx.doneRows.has(id);
  const openRow = inOpen ? idx.openRows.get(id) : null;
  const doneRow = inDone ? idx.doneRows.get(id) : null;

  const cls = classifyLegacyStatus(t.statusRaw);
  const text = fs.readFileSync(path.join(dir, t.file), 'utf8');
  const heads = activityHeaders(text);
  const wt = worktreeState(dir, t.file);

  return {
    ok: true,
    id,
    title: t.title,
    file: t.file,
    work_state: t.workState ?? null,
    done: t.done,
    leading_status_word: cls.token ? String(cls.token).trim() : null,
    status_ambiguous: !!cls.ambiguous,
    ambiguity_reason: cls.ambiguous ? cls.reason : null,
    status_matched: cls.matched,
    status_header: oneLine(t.statusRaw),
    severity: t.severity ?? null,
    board_placement: inOpen && inDone ? 'BOTH (duplicate)' : inDone ? 'Done (committed)' : inOpen ? 'Open' : 'NOT ON BOARD',
    board_owner: openRow ? oneLine(openRow.owner, 8) : null,
    commit: doneRow ? oneLine(doneRow.commit, 40) : null,
    index_status_cell: openRow ? oneLine(openRow.status) : null,
    worktree: wt.label,
    worktree_dirty: wt.dirty,
    verified_by: allVerifiedBy(text),
    last_entries: heads.slice(0, entries),
    total_entries: heads.length,
  };
}

function printTicketReport(r) {
  if (!r.ok) {
    process.stderr.write(`board:status — ${r.error}\n`);
    return;
  }
  const L = [];
  L.push(`${r.id} — ${r.title ?? '(no title)'}`);
  const doneMark = r.done ? 'done' : 'open';
  let ws = `  work_state:      ${r.work_state ?? '(unclassifiable)'}  [board places in: ${doneMark}]`;
  if (r.status_ambiguous) {
    ws += `\n  ⚠ AMBIGUOUS:     ${r.ambiguity_reason}`;
    ws += `\n                   → the LEADING word is "${r.leading_status_word}" (open) but the board CLASSIFIES it done. Trust the leading word, not the placement.`;
  } else if (!r.status_matched) {
    ws += `\n  ⚠ UNMAPPABLE:    the Status header has no recognised leading state word; board treats it as OPEN.`;
  }
  L.push(ws);
  L.push(`  ticket Status:   ${r.status_header}`);
  L.push(`  board placement: ${r.board_placement}` +
    (r.commit ? `   commit: ${r.commit}` : '') +
    (r.board_owner ? `   owner: ${r.board_owner}` : '') +
    (r.severity ? `   sev: ${r.severity}` : ''));
  if (r.index_status_cell) L.push(`  INDEX status:    ${r.index_status_cell}`);
  L.push(`  working tree:    ${r.worktree}`);
  L.push(`  Verified-by:     ${r.verified_by.length ? '' : 'none'}`);
  for (const v of r.verified_by) L.push(`    ${v}`);
  L.push(`  activity log:     ${r.total_entries} entr${r.total_entries === 1 ? 'y' : 'ies'}; newest ${r.last_entries.length}:`);
  for (const h of r.last_entries) L.push(`    ${h}`);
  process.stdout.write(L.join('\n') + '\n');
}

function buildBoardSummary(dir) {
  const { tickets } = readTickets(dir);
  const indexPath = path.join(dir, 'INDEX.md');
  let idx = null;
  try { idx = readIndex(indexPath); } catch { idx = null; }

  let open = 0, done = 0, needsYou = 0, ambiguous = 0, unmappable = 0, dirty = 0;
  const needsYouIds = [];
  for (const t of tickets.values()) {
    if (t.done) done++; else open++;
    if (t.statusAmbiguous) ambiguous++;
    if (t.statusMatched === false) unmappable++;
    const row = idx && idx.openRows.get(t.id);
    if (row && String(row.owner || '').includes('👤')) { needsYou++; needsYouIds.push(t.id); }
  }
  // Working-tree dirtiness across the board, from git in one call.
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--', dir], { encoding: 'utf8' });
    dirty = out.split('\n').filter((l) => /-\d+-.*\.md$/.test(l)).length;
  } catch { dirty = null; }

  return {
    ok: true,
    dir,
    total: tickets.size,
    open,
    done,
    needs_you: needsYou,
    needs_you_ids: needsYouIds.sort(),
    ambiguous_status: ambiguous,
    unmappable_status: unmappable,
    dirty_ticket_files: dirty,
  };
}

function printBoardSummary(s) {
  const L = [];
  L.push(`board:status — ${s.total} ticket(s) in ${s.dir}`);
  L.push(`  open: ${s.open}    done: ${s.done}    needs-you (👤): ${s.needs_you}`);
  if (s.needs_you_ids.length) L.push(`  awaiting you: ${s.needs_you_ids.join(', ')}`);
  L.push(`  ambiguous-DONE status: ${s.ambiguous_status}    unmappable status: ${s.unmappable_status}    dirty ticket files: ${s.dirty_ticket_files ?? 'unknown'}`);
  L.push(`  (run \`npm run board:status -- <ID>\` for one ticket's full record)`);
  process.stdout.write(L.join('\n') + '\n');
}

function parseArgs(argv) {
  let dir = null;
  let json = false;
  let entries = DEFAULT_ENTRIES;
  let id = null;
  const unknown = [];
  for (const a of argv) {
    let m;
    if ((m = /^--dir=(.*)$/.exec(a))) dir = m[1];
    else if (a === '--json') json = true;
    else if ((m = /^--entries=(\d+)$/.exec(a))) entries = Number(m[1]);
    else if (a.startsWith('--')) unknown.push(a);
    else if (id === null) id = a;
    else unknown.push(a);
  }
  const resolvedDir = dir === null ? resolveBoardDir(process.cwd()) : path.resolve(dir);
  return { dir: resolvedDir, json, entries, id, unknown };
}

function main() {
  const { dir, json, entries, id, unknown } = parseArgs(process.argv.slice(2));
  if (unknown.length) {
    process.stderr.write(`board:status: unrecognised argument(s): ${unknown.join(' ')}\n`);
    process.stderr.write('usage: node scripts/board-status.mjs [<TICKET-ID>] [--json] [--entries=N] [--dir=docs/bugs]\n');
    process.exit(2);
  }

  if (id === null) {
    const s = buildBoardSummary(dir);
    if (json) process.stdout.write(JSON.stringify(s, null, 2) + '\n');
    else printBoardSummary(s);
    process.exit(0);
  }

  const norm = normalizeId(id);
  if (!norm) {
    process.stderr.write(`board:status: "${id}" is not a ticket id (expected e.g. ARCH-017, BUG-123, FEAT-42).\n`);
    process.exit(2);
  }
  const r = buildTicketReport(dir, norm, entries);
  if (json) {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  } else {
    printTicketReport(r);
  }
  // A ticket that does not exist FAILS loudly — a missing record must never read
  // as an empty success (this command exists because a confident empty answer is
  // exactly the failure that produced it).
  process.exit(r.ok ? 0 : 3);
}

const isMain = process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) main();

export { buildTicketReport, buildBoardSummary, activityHeaders, allVerifiedBy, normalizeId };
