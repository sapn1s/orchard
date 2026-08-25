#!/usr/bin/env node
/**
 * board.mjs — reconcile/generate docs/bugs/INDEX.md from the ticket files.
 *
 * Problem this solves (FEAT-032 item #5): the board (INDEX.md) is hand-maintained
 * prose/tables. A scripted string-replace edit once silently dropped 6 rows —
 * real drift nobody's tooling caught. Tickets (docs/bugs/{BUG,FEAT,DEPLOY}-NNN-*.md)
 * are the durable source of truth (accumulating-context discipline, see
 * docs/bugs/README.md); the board should be reconcilable/generable FROM them.
 *
 * Derivable from a ticket file: ID (filename + H1 must agree), Title (H1),
 * Severity (`- **Severity:**` line), the Open-table Status text, and
 * DONE-vs-OPEN (from `- **Status:**`: VERIFIED / FIXED / a `DONE` token ⇒ done;
 * everything else — OPEN, IN-PROGRESS, BLOCKED, NOT-A-BUG — stays in the Open
 * table since it still needs eyes).
 *
 * FEAT-068: the Open-table Status column is now DERIVED from the ticket's
 * `**Status:**` header on every `gen` — the ticket is the single source of
 * truth, so a header that changed (fixed/verified/deployed) can no longer leave
 * a stale curated blurb on the board indefinitely. (It USED to be preserved by
 * id from the current INDEX — `statusMap` — which is exactly how the board drifted:
 * a row kept saying "in progress" long after its ticket reached done.) Keep the
 * ticket Status headers concise for this reason.
 *
 * NOT derivable from a ticket (curated, orchestrator-owned state that lives
 * only on the board): the Open table's Owner (🤖/👤/—) and the Done table's
 * Commit column. `gen` PRESERVES these by ID from the current INDEX.md rather
 * than inventing them — that's what makes a regenerate non-destructive. Title,
 * Severity and Status, in contrast, ARE derived (ticket wins) even though the
 * real board's hand-written titles are often paraphrased/shortened — that
 * divergence is exactly the kind of drift this tool exists to surface (see
 * `check`).
 *
 * Usage:
 *   node scripts/board.mjs check [--dir=docs/bugs]   # exit 0 clean, 1 = drift found
 *   node scripts/board.mjs gen   [--dir=docs/bugs]   # rewrite INDEX.md tables in place
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { parseVerifiedBy } from './lib/verdict-contract.mjs';
// The ONE definition of the ticket format (plan §3 / §8 step 2). board.mjs used
// to carry its own `isDoneStatus`, its own TICKET_FILE_RE, its own H1 regex and
// its own row splitter; src/server/tickets.ts and scripts/arch-watch.mjs
// carried near-copies that had drifted. They now all import this module, so
// there is exactly one answer to "is this ticket done".
import {
  parseTicket,
  isDoneStatus,
  EM_DASH,
  TICKET_FILE_RE,
  indexRowCells,
  WORK_STATE_STATUS_WORD,
} from './lib/ticket-schema.mjs';

/**
 * BUG-073 — git merge conflict markers are non-table junk that `readIndex`
 * sweeps into the Open-table `trailer` (any non-empty line after the separator),
 * which `gen` then re-emits VERBATIM every regen while `check` never inspects it
 * — so an unresolved-merge artifact survives silently across many regenerations.
 * `check` FAILs on any such marker anywhere in INDEX.md; `gen` strips it from the
 * verbatim-preserved regions (preamble / Open trailer / Shipped blob) and warns
 * loudly on stderr rather than laundering it into the next board.
 */
const CONFLICT_MARKER_RE = /^(?:<{7,}|={7,}|>{7,}|\|{7,})(?:\s.*)?$/;

function dropConflictMarkers(lines, where) {
  const out = [];
  for (const line of lines) {
    if (CONFLICT_MARKER_RE.test(line)) {
      process.stderr.write(
        `board:gen WARNING — dropped a git conflict marker from ${where}: ${JSON.stringify(line)}\n`
      );
      continue;
    }
    out.push(line);
  }
  return out;
}

/**
 * FEAT-061 — independent-verification signal.
 *
 * A ticket may not reach VERIFIED on the FIXER's own report: the agent that
 * wrote the fix also wrote the fixture, so a blind spot that shaped the fixture
 * survives even the non-vacuity rule. The proof is a clean-room verification
 * DISPATCH, cited on the ticket as `Verified-by: dispatch <provider> run <id>`.
 * Citing a run id is what makes this architectural rather than polite — an
 * in-process Task subagent has no run id to name.
 *
 * Advisory (a WARN, not a FAIL) because the threshold is a judgment the board
 * cannot make for you: `trivial` and docs-only tickets are exempt and say so
 * with a `Verification-class:` line. Effective from the date below — earlier
 * tickets predate the rule, and retro-flagging 74 of them would be noise, which
 * is how a real signal gets ignored.
 */
const VERIFY_RULE_EFFECTIVE = '2026-08-11';
const VERIFY_EXEMPT_RE = /^\s*(?:[-*]\s*)?(?:\*\*)?Verification-class:?(?:\*\*)?:?\s*(?:trivial|docs-only|exempt)\b/im;

/** Date of the newest `### YYYY-MM-DD …` Activity-log heading, or null. */
function lastActivityDate(text) {
  const dates = [...text.matchAll(/^###\s+(\d{4}-\d{2}-\d{2})/gm)].map((m) => m[1]).sort();
  return dates.length ? dates[dates.length - 1] : null;
}

/**
 * BUG-071 — the date a ticket ACTUALLY reached VERIFIED/DONE, for the
 * predates-the-rule exemption below. Evidence of WHEN it was closed, in
 * priority: (1) the first `YYYY-MM-DD` embedded in the Status header line —
 * the established convention is `VERIFIED <date> — …` / `DONE (<date>) …`, so
 * the leading date IS the close date; (2) if the status line carries no date,
 * fall back to the newest activity-log heading. Keying the exemption here
 * (rather than on the newest log heading alone) stops a ticket verified ON/after
 * the rule from silently bypassing the warning just because its activity log was
 * never refreshed at closure — and, symmetrically, stops a ticket verified
 * BEFORE the rule from being nagged just because a later note bumped its newest
 * log heading past the effective date.
 *
 * Documented residual: a done ticket that carries NEITHER a dated status header
 * NOR any dated log heading presents no on-ticket evidence of its close date; it
 * is treated as pre-rule (exempt). The remedy is the convention this keys on —
 * date the VERIFIED/DONE status line.
 */
function verifiedDate(statusRaw, text) {
  const inStatus = /(\d{4}-\d{2}-\d{2})/.exec(statusRaw || '');
  return inStatus ? inStatus[1] : lastActivityDate(text);
}

// ---------------------------------------------------------------------------
// Ticket parsing
// ---------------------------------------------------------------------------

/**
 * ARCH (FEAT-056) is a first-class ticket prefix: the OUTPUT CONTAINER for a
 * re-architecture decision (docs/bugs/TEMPLATE-ARCH.md), filed by a human after
 * arch-watch raises a recurrence question. It reconciles exactly like any other
 * ticket — Open/Done tables, status/severity drift, orphan rows — so an ARCH
 * ticket cannot quietly fall off the board.
 *
 * The pattern itself is `TICKET_FILE_RE`, imported from ticket-schema.mjs — one
 * definition, shared with tickets.ts and arch-watch.mjs.
 */

function naturalKey(id) {
  const m = /^([A-Z]+)-(\d+)$/.exec(id);
  if (!m) return [id, 0];
  return [m[1], Number(m[2])];
}

function compareIds(a, b) {
  const [pa, na] = naturalKey(a);
  const [pb, nb] = naturalKey(b);
  if (pa !== pb) return pa < pb ? -1 : 1;
  return na - nb;
}

function normalizeSeverity(raw) {
  if (!raw) return null;
  // Strip parenthetical rationale, take the first `|`-separated token
  // (TEMPLATE.md literally says "low | medium | high" as a placeholder).
  let s = raw.split('(')[0].split('|')[0].trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith('med')) return 'med';
  if (s.startsWith('hig')) return 'high';
  if (s.startsWith('low')) return 'low';
  return s;
}

/**
 * DONE-vs-OPEN for board PLACEMENT is now decided by scripts/lib/ticket-schema.mjs
 * (`isDoneStatus` / `classifyLegacyStatus`), imported above. The rule that lived
 * here — VERIFIED / (RE-)FIXED / RESOLVED leading, or a DONE token anywhere —
 * moved there VERBATIM and unchanged, and it is now the rule the ticket API and
 * arch-watch use too. It was previously duplicated in src/server/tickets.ts and
 * scripts/arch-watch.mjs, both of which had missed FEAT-068's broadening, so
 * `- **Status:** FIXED` was Done here and Open there (12 real tickets on
 * 2026-08-19). The policy notes that justified this rule now live at the top of
 * ticket-schema.mjs, next to the code that implements it.
 */

/**
 * FEAT-068 item #1 — the Open-table Status cell, derived from the ticket's
 * `**Status:**` header (the single source of truth). The header is already
 * captured single-line, so collapse stray whitespace and escape any `|` (which
 * would otherwise split the markdown row). Empty header → "OPEN".
 */
function boardStatusFromHeader(statusRaw) {
  const s = (statusRaw || '').replace(/\s+/g, ' ').trim();
  if (!s) return 'OPEN';
  return s.replace(/\|/g, '\\|');
}

/** One markdown table cell: single line, `|` escaped so it cannot split the row. */
function asCell(s) {
  return String(s).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
}

/**
 * BUG-123 — the Open-table Status cell for a PROMOTED ticket, composed from its
 * record.
 *
 * WHAT WENT WRONG. The cell above is re-derived from the ticket's own prose
 * `- **Status:**` header on every `gen` (FEAT-068 item #1). A promoted ticket has
 * no such header, so it derived to the bare word `OPEN` — and the first real
 * `board:gen` after ARCH-005 was promoted rewrote a cell that had said which
 * decision was waiting, what was recommended and why, and what delay costs, down
 * to four characters that say none of it. That cell is what a reader scans on the
 * board landing page, so the board stopped answering the question it exists to
 * answer. One ticket today; 191 in one silent pass at cutover.
 *
 * THE RULE, chosen deliberately rather than by default:
 *
 *   · a ticket with a prose Status header keeps that header, verbatim — it is a
 *     human's curated sentence and regenerating must not paraphrase it. Byte for
 *     byte unchanged, and asserted as such.
 *   · a ticket with a RECORD has no such sentence to respect, so the cell is
 *     composed from the record's own authored fields.
 *
 * No curated prose can be lost, because the branch fires only where the source of
 * the legacy cell does not exist.
 *
 * It composes, it does not scrape: every part is a field the record already
 * carries, read through the one shared reader. Nothing is truncated (the record's
 * own word caps bound `recommendation_reason` at 40 words and
 * `impact_if_we_wait` at 50, so the cell is bounded by construction) — this
 * project does not elide with an ellipsis, it collapses whole or states absence.
 *
 * The "no build starts" clause is gated on `type === 'architecture'` because that
 * is where it is TRUE: WA §N makes an ARCH ticket a question, not a licence to
 * rewrite working code. A bug or feature awaiting a decision gets the rest of the
 * cell without a rule that does not apply to it.
 */
const DECISION_ACTIONS = ['decide', 'staged_decision', 'multi_select_decision'];

function boardStatusFromRecord(record) {
  const rec = record && typeof record === 'object' ? record : {};
  const word = WORK_STATE_STATUS_WORD[rec.work_state] ?? 'OPEN';
  const parts = [];
  const d = rec.decision && typeof rec.decision === 'object' && !Array.isArray(rec.decision) ? rec.decision : null;
  const options = d && Array.isArray(d.options) ? d.options : [];
  const asksAChoice = DECISION_ACTIONS.indexOf(rec.human_action) !== -1 || options.length >= 2;

  if (asksAChoice) {
    parts.push(options.length >= 2
      ? `${word} — NEEDS A HUMAN DECISION (${options.length} options).`
      : `${word} — NEEDS A HUMAN DECISION.`);
    if (rec.type === 'architecture') parts.push('No build starts until an option is chosen.');
    const key = d && typeof d.recommendation === 'string' ? d.recommendation.trim() : '';
    // Validated against the real option keys, for the same reason `ticketDecision`
    // validates it: a recommendation pointing at no option must never be badged.
    if (key && options.some((o) => o && String(o.key).trim() === key)) {
      const why = d && typeof d.recommendation_reason === 'string' ? d.recommendation_reason.trim() : '';
      parts.push(why ? `Recommended: ${key} — ${why.replace(/\.?$/, '.')}` : `Recommended: ${key}.`);
    }
  } else if (rec.human_action === 'answer_question') {
    parts.push(`${word} — awaiting your answer`);
  } else if (rec.human_action === 'review') {
    parts.push(`${word} — awaiting your review`);
  } else {
    parts.push(word);
    // Nothing is being asked of a human, so the useful thing is what the ticket
    // itself says it needs next.
    if (typeof rec.current_need === 'string' && rec.current_need.trim()) parts.push(rec.current_need.trim());
  }
  if (typeof rec.impact_if_we_wait === 'string' && rec.impact_if_we_wait.trim()) {
    parts.push(`If we wait: ${rec.impact_if_we_wait.trim()}`);
  }
  return asCell(parts.join(' '));
}

function readTickets(dir) {
  const tickets = new Map(); // id -> {id, file, title, severity, done, statusRaw, idMismatch}
  const errors = [];
  const warnings = [];
  const entries = fs.readdirSync(dir).filter((f) => TICKET_FILE_RE.test(f));
  for (const file of entries) {
    const full = path.join(dir, file);
    const text = fs.readFileSync(full, 'utf8');
    // ONE parser, BOTH formats (BUG-122). `mode: 'auto'` reads the leading
    // ```orchard-ticket record when a ticket has been promoted and falls back to
    // the prose path when it has not, so the board stays correct through a
    // migration that runs ticket-by-ticket. `.summary` is the one-shape consumer
    // view — for a legacy file it is the identical object `.record` used to be,
    // so nothing about an unpromoted ticket changes.
    // `requireEmDash` keeps the board's stricter H1 convention on that legacy
    // path; MALFORMED H1 / MISSING STATUS FIELD / UNMAPPABLE STATUS all still
    // come back as errors, byte-identical in wording.
    const parsed = parseTicket(text, { file, mode: 'auto', requireEmDash: true });
    const t = parsed.summary;
    errors.push(...parsed.errors);
    // A status whose leading word this board cannot classify is a BOARD DEFECT,
    // reported by name, never guessed at. `t.done` is false for it, so the
    // ticket stays in Open where a human sees it (see ticket-schema.mjs).
    warnings.push(...parsed.warnings);

    const id = t.id;
    tickets.set(id, {
      id,
      file,
      title: t.title ?? '(unparseable title)',
      severity: t.severityRaw ? normalizeSeverity(t.severityRaw) : null,
      done: t.done,
      statusRaw: t.statusRaw,
      // BUG-123 — the Open-table Status cell, composed from the record when there
      // is one and `null` when there is not. `null` means "this ticket's cell
      // comes from its prose header", which is what `gen` falls back to, so a
      // legacy row is produced by exactly the code that produced it before.
      boardStatus: parsed.format === 'block' && parsed.record
        ? boardStatusFromRecord(parsed.record)
        : null,
      workState: t.work_state,
      // Carried per-ticket as well as in `errors`, so every consumer of this
      // map has the same channel arch-watch and the ticket API now have.
      statusMatched: t.statusMatched,
      statusError: t.statusError,
      // A REPORT MUST REACH EVERY CONSUMER THROUGH A CHANNEL ITS CALLERS SEE.
      // `statusError` learned that; `statusWarning` had not. It was pushed into
      // this function's top-level `warnings` (which only `board:check`'s CLI
      // prints) and dropped from the per-ticket record, so a library caller of
      // `readTickets` — every other consumer of this map — could not see that a
      // ticket's state declaration was untidy at all. Same field, same name, as
      // the ticket API and arch-watch.
      statusWarning: t.statusWarning,
      statusWarnings: t.statusWarnings,
      statusAmbiguous: t.statusAmbiguous,
      idMismatch: t.idMismatch,
      verifiedBy: parseVerifiedBy(text),
      lastEntryDate: lastActivityDate(text),
      verifiedDate: verifiedDate(t.statusRaw, text),
      exemptFromVerify: VERIFY_EXEMPT_RE.test(text),
    });
  }
  return { tickets, errors, warnings };
}

// ---------------------------------------------------------------------------
// INDEX.md parsing
// ---------------------------------------------------------------------------

/**
 * `gen` REWRITES the tables, so it uses the strict row form (a row must open
 * AND close with `|`) — a ragged line must not be mistaken for a row and
 * re-emitted as one. The splitter itself is shared (ticket-schema.mjs
 * `indexRowCells`); the strictness is this caller's, declared here.
 */
function splitRow(line) {
  const cells = indexRowCells(line, { requireClosingPipe: true });
  return cells.length ? cells : null;
}

function readIndex(indexPath) {
  const text = fs.readFileSync(indexPath, 'utf8');
  const lines = text.split('\n');

  const openHeaderIdx = lines.findIndex((l) => l.trim() === '## Open');
  const doneHeaderIdx = lines.findIndex((l) => l.trim().startsWith('## Done'));
  const shippedHeaderIdx = lines.findIndex((l) => l.trim().startsWith('## Shipped'));

  if (openHeaderIdx === -1 || doneHeaderIdx === -1 || shippedHeaderIdx === -1) {
    throw new Error(
      `INDEX.md missing an expected section (## Open / ## Done / ## Shipped); found open=${openHeaderIdx} done=${doneHeaderIdx} shipped=${shippedHeaderIdx}`
    );
  }

  const preamble = lines.slice(0, openHeaderIdx);
  const betweenOpenAndDone = lines.slice(openHeaderIdx, doneHeaderIdx);
  const betweenDoneAndShipped = lines.slice(doneHeaderIdx, shippedHeaderIdx);
  const shippedBlob = lines.slice(shippedHeaderIdx);

  // Any non-table prose that trails the Open table (e.g. the "FE = ... SV = ..."
  // legend line) — keep it, emitted after the Open table.
  function parseTable(sectionLines, expectedCols) {
    const rows = [];
    let sawSeparator = false;
    let trailer = [];
    for (const line of sectionLines) {
      const cells = splitRow(line);
      if (!cells) {
        if (sawSeparator && line.trim() !== '') trailer.push(line);
        continue;
      }
      if (cells.every((c) => /^:?-+:?$/.test(c))) {
        sawSeparator = true;
        continue;
      }
      if (!sawSeparator) continue; // header row, before separator
      rows.push(cells);
    }
    return { rows, trailer };
  }

  const openParsed = parseTable(betweenOpenAndDone, 5);
  const doneParsed = parseTable(betweenDoneAndShipped, 3);

  const openRows = new Map(); // id -> {title, owner, status, sev}
  const openOrder = [];
  for (const cells of openParsed.rows) {
    const [id, title, owner, status, sev] = cells;
    openOrder.push(id);
    openRows.set(id, { title, owner, status, sev });
  }

  const doneRows = new Map(); // id -> {title, commit}
  const doneOrder = [];
  for (const cells of doneParsed.rows) {
    const [id, title, commit] = cells;
    doneOrder.push(id);
    doneRows.set(id, { title, commit });
  }

  return {
    rawLines: lines,
    preamble,
    openOrder,
    openRows,
    openTrailer: openParsed.trailer,
    doneOrder,
    doneRows,
    shippedBlob,
  };
}

// ---------------------------------------------------------------------------
// Title similarity (advisory only — the board's titles are legitimately
// paraphrased/shortened vs. the ticket H1, e.g. DEPLOY-003's board title is
// even tense-flipped once resolved. Exact match would be permanently noisy.)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'to', 'and', 'in', 'on', 'for', 'with', 'is', 'as',
  'by', 'or', 'at', 'from', 'this', 'that', 'be', 'not', 'so', 'it',
]);

function titleWords(t) {
  return new Set(
    t
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  );
}

function jaccard(a, b) {
  const wa = titleWords(a);
  const wb = titleWords(b);
  if (wa.size === 0 || wb.size === 0) return 1; // nothing to compare, don't flag
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  const union = wa.size + wb.size - inter;
  return union === 0 ? 1 : inter / union;
}

const TITLE_WARN_THRESHOLD = 0.12;

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

function checkBoard(dir) {
  const indexPath = path.join(dir, 'INDEX.md');
  const { tickets, errors: parseErrors, warnings: parseWarnings } = readTickets(dir);
  const idx = readIndex(indexPath);

  const fails = [...parseErrors];
  // ARCH-004's one recorded blind spot, now visible: a ticket placed in Done by
  // an incidental `DONE` token rather than by its leading state word. Advisory,
  // because the placement itself is long-standing and deliberate — the point is
  // that it can no longer happen unobserved.
  const warns = [...parseWarnings];

  for (const t of tickets.values()) {
    if (t.idMismatch) {
      fails.push(`ID MISMATCH: ${t.file} — filename says ${t.id}, H1 says ${t.idMismatch}`);
    }
    const inOpen = idx.openRows.has(t.id);
    const inDone = idx.doneRows.has(t.id);

    if (!inOpen && !inDone) {
      fails.push(`MISSING FROM BOARD: ${t.id} has a ticket file (${t.file}) but no INDEX.md row in Open or Done`);
      continue;
    }
    if (inOpen && inDone) {
      fails.push(`DUPLICATE: ${t.id} appears in BOTH the Open and Done tables`);
    }

    const expectSection = t.done ? 'Done' : 'Open';
    const actualSection = inDone ? 'Done' : 'Open';
    if (!(inOpen && inDone) && actualSection !== expectSection) {
      fails.push(
        `STATUS MISMATCH: ${t.id} ticket Status is "${t.statusRaw}" (⇒ ${expectSection}) but board lists it in ${actualSection}`
      );
    }

    // FEAT-068 item #3 — stale-👤 guard. A resolved ticket (VERIFIED/FIXED/DONE)
    // must not keep the 👤 needs-you owner: that inflates the needs-you count
    // with work that has no pending user question (BUG-070 did exactly this
    // after it was fixed+deployed). `gen` drops the owner by moving the row to
    // the ownerless Done table; `check` names it loudly so the drift can't sit
    // silently in the transient pre-gen state. Distinct from STATUS MISMATCH
    // (which is about table placement) — this points at the needs-you inflation.
    // A genuinely-open ticket (OPEN/IN-PROGRESS/BLOCKED) keeps its 👤.
    if (t.done && inOpen) {
      const owner = (idx.openRows.get(t.id).owner || '').trim();
      if (owner.includes('👤')) {
        fails.push(
          `STALE OWNER: ${t.id} ticket Status is "${t.statusRaw}" (resolved) but its Open row still ` +
          `shows the 👤 needs-you owner — a resolved ticket has no pending user question. ` +
          'Run `board:gen` (moves it to Done, dropping the owner) or clear the 👤 by hand.'
        );
      }
    }

    if (actualSection === 'Open' && t.severity) {
      const boardSev = normalizeSeverity(idx.openRows.get(t.id).sev);
      if (boardSev && boardSev !== t.severity) {
        fails.push(
          `SEVERITY MISMATCH: ${t.id} ticket says "${t.severity}", board Open row says "${idx.openRows.get(t.id).sev}"`
        );
      }
    }

    // FEAT-061: closed on whose word? A done ticket with no clean-room
    // verification dispatch cited was verified by the agent that wrote the fix.
    // BUG-071: anchor the predates-the-rule exemption to when the ticket
    // actually reached VERIFIED/DONE (verifiedDate: status-header date, else
    // newest log heading), NOT the newest log heading alone — else a ticket
    // verified today with a stale log silently bypasses the nudge.
    if (t.done && !t.verifiedBy && !t.exemptFromVerify &&
        t.verifiedDate && t.verifiedDate >= VERIFY_RULE_EFFECTIVE) {
      warns.push(
        `NO INDEPENDENT VERIFICATION (advisory): ${t.id} is ${t.statusRaw} but carries no ` +
        '`Verified-by: dispatch <provider> run <id>` line — it was verified by whoever fixed it. ' +
        'Run `node scripts/independent-verify.mjs` and paste the line it prints, or mark the ticket ' +
        '`Verification-class: trivial` (or `docs-only`) if the threshold genuinely does not apply.'
      );
    }

    const boardRow = inOpen ? idx.openRows.get(t.id) : inDone ? idx.doneRows.get(t.id) : null;
    if (boardRow) {
      const sim = jaccard(t.title, boardRow.title);
      if (sim < TITLE_WARN_THRESHOLD) {
        warns.push(
          `TITLE DIVERGENCE (advisory): ${t.id} ticket H1 "${t.title}" vs board "${boardRow.title}" (word overlap ${sim.toFixed(2)})`
        );
      }
    }
  }

  // BUG-073: a merge conflict marker anywhere in INDEX.md is drift `gen` would
  // otherwise re-emit silently. FAIL loudly with its line number.
  idx.rawLines.forEach((line, i) => {
    if (CONFLICT_MARKER_RE.test(line)) {
      fails.push(
        `GIT CONFLICT MARKER: INDEX.md line ${i + 1} is an unresolved merge marker (${JSON.stringify(line)}) — ` +
        'board:gen would silently preserve it; remove it (or run `board:gen`, which now strips it and warns)'
      );
    }
  });

  const ticketIds = new Set(tickets.keys());
  for (const id of idx.openOrder) {
    if (!ticketIds.has(id)) fails.push(`ORPHAN INDEX ROW (Open): ${id} has a board row but no ticket file docs/bugs/${id}-*.md`);
  }
  for (const id of idx.doneOrder) {
    if (!ticketIds.has(id)) fails.push(`ORPHAN INDEX ROW (Done): ${id} has a board row but no ticket file docs/bugs/${id}-*.md`);
  }

  return { fails, warns, ticketCount: tickets.size };
}

// ---------------------------------------------------------------------------
// gen
// ---------------------------------------------------------------------------

function genBoard(dir) {
  const indexPath = path.join(dir, 'INDEX.md');
  const { tickets } = readTickets(dir);
  const idx = readIndex(indexPath);

  // Owner + severity-fallback are preserved by id from the current INDEX; the
  // Status column is NOT preserved — it is re-derived from the ticket header
  // each gen (FEAT-068 item #1), so a stale blurb can't linger on the board.
  const ownerMap = new Map();
  const openSevFallback = new Map();
  for (const [id, row] of idx.openRows) {
    ownerMap.set(id, row.owner);
    openSevFallback.set(id, row.sev);
  }
  const commitMap = new Map();
  for (const [id, row] of idx.doneRows) commitMap.set(id, row.commit);

  const finalOpenOrder = [];
  const finalDoneOrder = [];
  const seenOpen = new Set();
  const seenDone = new Set();

  for (const id of idx.openOrder) {
    const t = tickets.get(id);
    if (!t) {
      finalOpenOrder.push(id); // orphan row — no ticket to derive from; keep verbatim
      seenOpen.add(id);
    } else if (!t.done) {
      finalOpenOrder.push(id);
      seenOpen.add(id);
    }
    // t.done === true: falls through, moves to Done below
  }
  for (const id of idx.doneOrder) {
    const t = tickets.get(id);
    if (!t) {
      finalDoneOrder.push(id); // orphan row
      seenDone.add(id);
    } else if (t.done) {
      finalDoneOrder.push(id);
      seenDone.add(id);
    }
    // t.done === false: falls through, moves to Open below
  }

  const sortedIds = [...tickets.keys()].sort(compareIds);
  for (const id of sortedIds) {
    const t = tickets.get(id);
    if (t.done && !seenDone.has(id)) {
      finalDoneOrder.push(id);
      seenDone.add(id);
    } else if (!t.done && !seenOpen.has(id)) {
      finalOpenOrder.push(id);
      seenOpen.add(id);
    }
  }

  const openLines = ['| ID | Title | Owner | Status | Sev |', '|----|-------|-------|--------|-----|'];
  for (const id of finalOpenOrder) {
    const t = tickets.get(id);
    if (!t) {
      // orphan: reuse the row verbatim from the current INDEX (nothing to derive)
      const row = idx.openRows.get(id);
      openLines.push(`| ${id} | ${row.title} | ${row.owner} | ${row.status} | ${row.sev} |`);
      continue;
    }
    const owner = ownerMap.get(id) ?? '—';
    // BUG-123: composed from the record when the ticket has one; otherwise the
    // human's own prose Status header, verbatim, exactly as before.
    const status = t.boardStatus ?? boardStatusFromHeader(t.statusRaw);
    const sev = t.severity ?? normalizeSeverity(openSevFallback.get(id)) ?? 'med';
    openLines.push(`| ${id} | ${t.title} | ${owner} | ${status} | ${sev} |`);
  }

  const doneLines = ['| ID | Title | Commit |', '|----|-------|--------|'];
  for (const id of finalDoneOrder) {
    const t = tickets.get(id);
    if (!t) {
      const row = idx.doneRows.get(id);
      doneLines.push(`| ${id} | ${row.title} | ${row.commit} |`);
      continue;
    }
    const commit = commitMap.get(id) ?? '(uncommitted)';
    doneLines.push(`| ${id} | ${t.title} | ${commit} |`);
  }

  // BUG-073: never launder git conflict markers back into the board. Strip them
  // from every region emitted verbatim (preamble / Open trailer / Shipped blob).
  const preamble = dropConflictMarkers(idx.preamble, 'the preamble');
  const openTrailer = dropConflictMarkers(idx.openTrailer, 'the Open-table trailer');
  const shippedBlob = dropConflictMarkers(idx.shippedBlob, 'the Shipped section');

  const out = [];
  out.push(...preamble);
  out.push('## Open', '');
  out.push(...openLines);
  if (openTrailer.length) out.push('', ...openTrailer);
  out.push('');
  out.push('## Done (committed)', '');
  out.push(...doneLines);
  out.push('');
  out.push(...shippedBlob);

  const text = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n');
  fs.writeFileSync(indexPath, text);
  return text;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * An argument this tool does not understand is REJECTED, for the same reason a
 * status word it does not understand is: the alternative is a confident wrong
 * answer. `board.mjs check <some/other/board>` used to silently check
 * `docs/bugs` instead and print `OK — no drift` about a board the caller never
 * asked about. The board dir is `--dir=`, and nothing else is accepted.
 */
function parseArgs(argv) {
  const cmd = argv[0];
  let dir = 'docs/bugs';
  let strict = false;
  const unknown = [];
  for (const a of argv.slice(1)) {
    const m = /^--dir=(.*)$/.exec(a);
    if (m) dir = m[1];
    else if (a === '--strict') strict = true;
    else unknown.push(a);
  }
  return { cmd, dir: path.resolve(dir), strict, unknown };
}

/**
 * FEAT-075 Phase 2b — docs-freshness ride-along. board:check also surfaces guide
 * docs that may have drifted from their source files (docs:fresh), on the same
 * advisory terms as the arch-watch ride-along: WARN lines only, never a FAIL,
 * so board:check's own exit is unchanged UNLESS `--strict` is passed.
 *
 * DEFENSIVE by contract: board.mjs is COPIED into other repos by onboard.mjs
 * (COPIED_TOOLS), where scripts/check-docs-fresh.mjs and docs/guide/ do not
 * exist. So the checker is loaded by guarded dynamic import — if it's absent, or
 * there is no guide dir, or it throws, the ride-along degrades to silence and
 * board:check behaves exactly as before (BUG-071/073 behavior intact).
 * Returns the count of stale references (0 if unavailable/none).
 */
async function docsFreshRideAlong(strict) {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const checkerPath = path.join(here, 'check-docs-fresh.mjs');
  const guideDir = path.resolve(here, '..', 'docs', 'guide');
  if (!fs.existsSync(checkerPath) || !fs.existsSync(guideDir)) return 0;
  try {
    const mod = await import(url.pathToFileURL(checkerPath).href);
    if (typeof mod.checkDocsFresh !== 'function') return 0;
    const { stale, warnings } = mod.checkDocsFresh({ guideDir });
    if (warnings.length) {
      console.log(`docs:fresh (advisory${strict ? ', --strict' : ''}) — ${stale.length} possibly-stale source reference(s):`);
      for (const w of warnings) console.log(`  WARN  ${w}`);
    }
    return stale.length;
  } catch (err) {
    process.stderr.write(`board:check — docs:fresh ride-along skipped: ${err?.message ?? err}\n`);
    return 0;
  }
}

/**
 * ARCH-004 option C — the REACHABILITY check (FEAT-082 precondition).
 *
 * The drift guard (checkBoard) only proves the INDEX and the ticket files AGREE.
 * It has been silent through three separate incidents where a ticket agreed with
 * itself and was still invisible to a human — because nothing verified the missing
 * property: that every OPEN ticket surfaces on at least one lane a person actually
 * looks at (needs-you / answered-awaiting / in-flight / queued / recently-updated).
 * The upcoming board redesign shows LESS than the full table, so a ticket that
 * falls off every lane stops being merely buried and becomes truly unreachable.
 *
 * This computes the lanes from the LIVE rail (`readBoard` in src/server/board.ts —
 * the exact surface the human reads, including its drop rules, e.g. an answered-
 * and-acted 👤 ticket the rail removes entirely), so the check tests the user's
 * reality rather than an approximation of it. "Open" is the ticket's own Status
 * header via `isDoneStatus` — the same determination the board uses for placement
 * (option C leaves the prose model alone; the residual it cannot catch is a ticket
 * mis-classified DONE by an incidental word in its header — that needs option B's
 * canonical state, and is called out on ARCH-004).
 *
 * DEFENSIVE by the same contract as the docs:fresh ride-along: board.mjs is COPIED
 * into onboarded repos (COPIED_TOOLS) where src/server/board.ts does not exist and
 * the rail does not run — there the human reads INDEX.md directly (MISSING FROM
 * BOARD already covers that), so reachability degrades to silence rather than
 * erroring. Returns FAIL lines (unreachable tickets are real drift, not advisory).
 */
const REACH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

async function reachabilityFails(dir) {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const boardTs = path.resolve(here, '..', 'src', 'server', 'board.ts');
  if (!fs.existsSync(boardTs)) return []; // copied repo — no rail; degrade to silence
  let readBoard;
  try {
    ({ readBoard } = await import(url.pathToFileURL(boardTs).href));
    if (typeof readBoard !== 'function') return [];
  } catch (err) {
    process.stderr.write(`board:check — reachability ride-along skipped: ${err?.message ?? err}\n`);
    return [];
  }

  const hostPath = path.resolve(dir, '..', '..'); // dir === <host>/docs/bugs
  let board;
  try { board = readBoard(hostPath); } catch (err) {
    process.stderr.write(`board:check — reachability ride-along skipped: ${err?.message ?? err}\n`);
    return [];
  }

  // Every id the human can reach from a rail lane. doneToday is the rail's
  // recently-touched surface; the mtime/activity window below extends it so a
  // recently-updated OPEN ticket counts as reachable even when it is on no lane.
  const reachable = new Set();
  for (const it of [
    ...(board.needsYou ?? []), ...(board.answeredAwaiting ?? []),
    ...(board.inflight ?? []), ...(board.queued ?? []), ...(board.doneToday ?? []),
  ]) reachable.add(it.id);

  const { tickets } = readTickets(dir);
  let idx;
  try { idx = readIndex(path.join(dir, 'INDEX.md')); } catch { idx = null; }

  const recentThreshold = new Date(Date.now() - REACH_WINDOW_MS).toISOString().slice(0, 10);
  const fails = [];
  for (const t of tickets.values()) {
    if (t.done) continue;              // a resolved ticket living in Done is fine
    if (reachable.has(t.id)) continue; // on a rail lane — a human sees it

    // "recently-updated (7d)" lane: newest activity-log date OR file mtime.
    let mtimeRecent = false;
    try { mtimeRecent = Date.now() - fs.statSync(path.join(dir, t.file)).mtimeMs <= REACH_WINDOW_MS; } catch { /* gone */ }
    const activityRecent = !!t.lastEntryDate && t.lastEntryDate >= recentThreshold;
    if (mtimeRecent || activityRecent) continue;

    // Unreachable: open by its own header, on no lane, and gone quiet. Say why,
    // pointing at the placement so someone can act.
    const inOpen = !!idx && idx.openRows.has(t.id);
    const inDone = !!idx && idx.doneRows.has(t.id);
    const last = t.lastEntryDate ? `last updated ${t.lastEntryDate}` : 'no dated activity';
    let where;
    if (inDone) {
      where = 'it sits in the Done table though its Status header reads open — run `board:gen` (moves it back to Open) or fix the header';
    } else if (inOpen) {
      const owner = (idx.openRows.get(t.id).owner || '—').trim();
      where = `its Open row Owner is "${owner}" but the rail surfaces it on no lane (e.g. answered-and-already-acted, which the rail drops) — flip the Owner in INDEX or resolve the ticket`;
    } else {
      where = 'it has no INDEX.md row at all';
    }
    fails.push(
      `UNREACHABLE TICKET: ${t.id} — ${t.title} — open per its Status ("${t.statusRaw}") but findable from ` +
      `NO lane a human looks at (needs-you/answered/in-flight/queued/recently-updated); ${last} (>7d ago); ${where}.`
    );
  }
  return fails;
}

/**
 * ARCH-005 (the ticket that exposed it) — the DECISION-SHAPE check.
 *
 * The defect this exists for is a SILENT MISS, not a wrong render. A ticket can
 * say, in its Status header and its prose, "no build starts until a human picks
 * an option", argue four options at length, and still reach the user as nothing:
 * `ticketDecision` (src/server/board.ts) only recognises options written as
 * bold-lead bullets, so options argued as numbered prose parse to null, no
 * Decide card renders, and the ticket sits waiting on a person who is never
 * asked. Nothing failed. That silence is the bug; ARCH-005 was just the instance
 * (FEAT-082, BUG-104 and FEAT-092 were in the same state when this landed).
 *
 * Design rules, both deliberate:
 *
 *  1. ONE PARSER. The verdict "does this parse?" is always `ticketDecision`
 *     itself, imported from the SAME module the UI rail calls — never a copy of
 *     its grammar. Two parsers is how a checker and a renderer come to disagree
 *     about what a ticket says, which would recreate this bug one level up.
 *
 *  2. The TRIGGER (which tickets get checked) is intentionally NOT the parser's
 *     grammar, and is allowed to be a loose superset: a Status header that
 *     declares a decision is needed, or — for a ticket already owned by 👤 — an
 *     H2 that offers options. Drift in the trigger can only change WHICH tickets
 *     are inspected; it can never change the pass/fail answer, because that
 *     answer comes from rule 1. The asymmetry is the point.
 *
 * NOT flagged, on purpose: a bare 👤 ticket with no decision/options section and
 * no decision language ("recommend keeping this parked until you prioritise").
 * BUG-025 settled that those are legitimate read-only attention rows, not broken
 * decisions — failing them would be a seven-row false-positive storm on today's
 * board and would train people to ignore this check.
 *
 * DEFENSIVE like the other ride-alongs: board.mjs is copied into onboarded repos
 * (COPIED_TOOLS) with no src/server/board.ts. There, the parser does not exist,
 * so neither does the property — degrade to silence rather than erroring.
 */

/**
 * The Status header declares that a human must choose. Anchored on the NEED, not
 * on the word "decision" alone: "decision made:", "won't-do by user decision",
 * "the Decide card" are all reports of a decision, not requests for one, and a
 * done ticket is skipped outright by the caller.
 */
const DECISION_DECLARED_RE =
  /\b(?:needs?|need|needed|awaiting|await|pending|requires?|required|wants?)\b[^.;]{0,60}?\bdecisions?\b|\bdecisions?\b[^.;]{0,40}?\b(?:needed|required|pending|outstanding)\b/i;

/** An H2 that offers a set of choices — the "it looks like a decision" trigger. */
const OPTIONS_HEADING_RE = /^##\s+(?:.*\bdecisions?\b.*|options\b.*|.*\boptions\b.*)$/i;

/** The exact shape the parser accepts, quoted in every failure message. */
const OPTION_SHAPE_HELP = [
  'FIX: give the ticket an H2 whose text contains the word "Decision" (or a `## Question`',
  'section), and write each option as a BOLD-LEAD bullet — this exact shape, at least TWO of them:',
  '',
  '    ## Decision — <the question, in the reader\'s words>',
  '',
  '    - **A — short label.** What it costs and what it buys.',
  '    - **B — short label.** The alternative, and its trade-off.',
  '',
  'The key is a short token (A, B, 1, 2 — up to 6 chars), an em/en-dash or hyphen separates it',
  'from the label, and `KEY — label` sits inside ONE bold run; the rest of the bullet is the',
  'description (it may wrap onto indented continuation lines). Numbered prose paragraphs, plain',
  'bullets and bold text elsewhere in the sentence do NOT parse — that strictness is deliberate',
  '(BUG-025: never fabricate choice buttons out of ordinary prose). Keep the argument prose you',
  'already wrote; this is a formatting requirement, not a rewrite. See docs/bugs/README.md',
  '("Tickets that need a human decision") and docs/bugs/TEMPLATE-ARCH.md.',
].join('\n      ');

async function decisionShapeFails(dir) {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const boardTs = path.resolve(here, '..', 'src', 'server', 'board.ts');
  if (!fs.existsSync(boardTs)) return []; // copied repo — no parser, no property
  let ticketDecision;
  try {
    ({ ticketDecision } = await import(url.pathToFileURL(boardTs).href));
    if (typeof ticketDecision !== 'function') return [];
  } catch (err) {
    process.stderr.write(`board:check — decision-shape ride-along skipped: ${err?.message ?? err}\n`);
    return [];
  }

  const { tickets } = readTickets(dir);
  let idx;
  try { idx = readIndex(path.join(dir, 'INDEX.md')); } catch { idx = null; }

  const fails = [];
  for (const t of tickets.values()) {
    if (t.done) continue; // a decided/closed ticket asks nothing of anyone

    let md = '';
    try { md = fs.readFileSync(path.join(dir, t.file), 'utf8'); } catch { continue; }

    const row = idx?.openRows.get(t.id) ?? null;
    const hasRow = !!row || !!idx?.doneRows.has(t.id);
    const isNeedsYou = !!row && (row.owner || '').includes('👤');

    const declaresInStatus = DECISION_DECLARED_RE.test(t.statusRaw || '');
    const offersOptionsHeading = md.split('\n').some((l) => OPTIONS_HEADING_RE.test(l.trim()));
    /**
     * BUG-122 — the third trigger, and the reason this check needed one.
     *
     * Both triggers above read PROSE that promotion removes: the `- **Status:**`
     * header is gone, and the options move out of an H2 into JSON. So the moment
     * ARCH-005 was promoted this guard stopped inspecting it — silently, which is
     * the same silence it was built to end. A promoted ticket declares the same
     * two things as DATA, so they are read as data, off the one shared reader.
     * Per design rule 2 the trigger is allowed to be a loose superset; the
     * pass/fail answer still comes only from `ticketDecision` below.
     */
    let declaresInRecord = false;
    const rec = parseTicket(md, { file: t.file, mode: 'auto' });
    if (rec.format === 'block' && rec.record) {
      const r = rec.record;
      declaresInRecord = (r.decision !== null && typeof r.decision === 'object')
        || ['decide', 'staged_decision', 'multi_select_decision'].indexOf(r.human_action) !== -1;
    }
    // Trigger (superset, per design rule 2): it SAYS a decision is needed — in
    // prose or in its record — or it is already parked on the user AND lays out
    // options.
    if (!declaresInStatus && !declaresInRecord && !(isNeedsYou && offersOptionsHeading)) continue;

    // Verdict (design rule 1): the real parser, the same one the rail calls.
    const parsed = ticketDecision(md);
    const why = declaresInStatus
      ? `its Status header declares a decision is needed ("${(t.statusRaw || '').slice(0, 80)}…")`
      : declaresInRecord
        ? 'its ticket record carries a `decision` / a `human_action` that asks a human to choose'
        : 'its Open row is owned by 👤 (awaiting you) and it lays out options under a heading';

    if (!parsed || parsed.options.length < 2) {
      const got = !parsed
        ? 'the parser finds no decision at all'
        : `the parser finds only ${parsed.options.length} option(s) (a choice needs at least 2)`;
      fails.push(
        `UNPARSEABLE DECISION: ${t.id} — ${t.title} — ${why}, but ${got}, so NO Decide card renders ` +
        `and the question never reaches the user. The ticket is blocked on a person who is never asked.\n      ${OPTION_SHAPE_HELP}`
      );
      continue;
    }

    // The inverse arm: it parses, but nothing routes it to the human. Skipped
    // when the ticket has no INDEX row at all — MISSING FROM BOARD already says
    // that, and two failures for one cause is noise.
    if (hasRow && !isNeedsYou) {
      const owner = (row?.owner || '—').trim() || '—';
      fails.push(
        `DECISION NOT ROUTED: ${t.id} — ${t.title} — it exposes ${parsed.options.length} parseable options and ` +
        `${why}, but its Open row Owner is "${owner}", not 👤 — the Needs-You rail only reads 👤 rows, so the ` +
        'Decide card is never shown. Set the Owner cell to 👤 in docs/bugs/INDEX.md (the orchestrator owns that ' +
        'file; `board:gen` preserves the Owner it finds), or drop the decision language from the Status header.'
      );
    }
  }
  return fails;
}

async function main() {
  const { cmd, dir, strict, unknown } = parseArgs(process.argv.slice(2));
  if (unknown.length) {
    console.error(`board.mjs: unrecognised argument(s): ${unknown.join(' ')}`);
    console.error('The board directory is passed as --dir=<path>; a bare path is NOT accepted, because');
    console.error('accepting it silently would report on docs/bugs while naming another directory.');
    console.error('usage: node scripts/board.mjs <check|gen> [--dir=docs/bugs] [--strict]');
    process.exit(2);
  }
  if (cmd === 'check') {
    const { fails, warns, ticketCount } = checkBoard(dir);
    fails.push(...(await reachabilityFails(dir)));
    fails.push(...(await decisionShapeFails(dir)));
    console.log(`board:check — ${ticketCount} ticket file(s) scanned in ${dir}`);
    for (const w of warns) console.log(`  WARN  ${w}`);
    for (const f of fails) console.log(`  FAIL  ${f}`);
    const staleDocs = await docsFreshRideAlong(strict);
    if (fails.length === 0 && !(strict && staleDocs > 0)) {
      console.log(`OK — no drift (${warns.length} advisory warning(s)${staleDocs ? `, ${staleDocs} stale doc ref(s)` : ''})`);
      process.exit(0);
    } else if (fails.length === 0) {
      // --strict: docs staleness is the only reason we fail.
      console.log(`STALE DOCS — ${staleDocs} possibly-stale source reference(s) (--strict)`);
      process.exit(1);
    } else {
      console.log(`DRIFT — ${fails.length} problem(s) found`);
      process.exit(1);
    }
  } else if (cmd === 'gen') {
    genBoard(dir);
    console.log(`board:gen — rewrote ${path.join(dir, 'INDEX.md')}`);
    process.exit(0);
  } else {
    console.error('usage: node scripts/board.mjs <check|gen> [--dir=docs/bugs]');
    process.exit(2);
  }
}

const isMain = process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) main();

// NOTE: the `gen` branch remains synchronous; only `check` awaits the advisory
// docs:fresh ride-along. main() is async but each branch still calls process.exit,
// so control never falls through past the awaited work.

export {
  readTickets, readIndex, checkBoard, genBoard, normalizeSeverity, isDoneStatus,
  // Both ride-along checks, exported for the same reason `decisionShapeFails`
  // already was: `board:check`'s verdict is checkBoard PLUS these two, and a
  // second caller that ran only checkBoard would call a board clean that
  // `npm run board:check` calls broken. scripts/board-tool.mjs runs all three.
  decisionShapeFails, reachabilityFails, DECISION_DECLARED_RE, OPTIONS_HEADING_RE,
  // BUG-123 — the two Status-cell composers, exported so the suite can assert the
  // legacy one is what a legacy row still gets (the pre-change state, synthesized
  // rather than read from a moving revision) and drive the record one directly.
  boardStatusFromHeader, boardStatusFromRecord,
};
