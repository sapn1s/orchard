/**
 * ARCH-006 (step 1 of option A) — canonicalize line endings at the FIRST two
 * clean server entry points: `bulletLines` (src/server/board.ts, via the exported
 * `composeAnswerEntry`) and `entryBody` (src/server/tickets.ts, via `appendNote`).
 * Both composed a user reply / note into a ticket's append-only Activity log while
 * normalising `\r\n` ONLY, so a bare/lone `\r` in the reply text survived into the
 * markdown record — and a lone CR is exactly the class defect ARCH-006 tracks:
 * content after it is hidden when the record is rendered (or catted in a terminal).
 *
 *   npx tsx scripts/verify-arch-006-boundary-normalise.mjs
 *
 * PART 0  must-FAIL non-vacuity (git-independent): the pre-fix normalisation
 *         (`\r\n` only) leaves a lone CR behind; the shared normaliser removes it.
 *         Anchored to a SYNTHESIZED pre-fix state, not a moving baseline.
 * PART A  the REAL write path over a COPY of the real board: appendNote (tickets.ts
 *         entryBody) and composeAnswerEntry (board.ts bulletLines) are given a
 *         realistic multi-paragraph reply whose paragraphs are separated by CRLF,
 *         lone CR, and LF. Re-read the ticket record (readTicket) and assert every
 *         paragraph survives as its own visible line with NO embedded CR. Before
 *         the fix a lone-CR-separated paragraph is swallowed; after, it is present.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { composeAnswerEntry } from '../src/server/board.ts';
import { appendNote, readTicket, currentRev } from '../src/server/tickets.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const REAL_BUGS = path.join(ROOT, 'docs', 'bugs');

let pass = 0, fail = 0;
const failures = [];
const show = (s) => JSON.stringify(String(s)).replace(/\\r/g, '<CR>').replace(/\\n/g, '<LF>');
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

// A realistic multi-paragraph reply as a user might paste it: mixed endings.
// Paragraph 2 is separated from paragraph 3 by a LONE CR — the case the pre-fix
// code does not normalise.
const P1 = 'First paragraph, ordinary LF text.';
const P2 = 'Second paragraph, arrived via CRLF (Windows paste).';
const P3 = 'Third paragraph, arrived via a LONE CR — this is the one that vanishes.';
const P4 = 'Fourth paragraph, plain LF again.';
const REPLY = `${P1}\n${P2}\r\n${P3}\r${P4}`;
const PARTS = [P1, P2, P3, P4];

/* ── PART 0 — must-FAIL non-vacuity, synthesized pre-fix state ─────────────── */
function part0() {
  console.log('\n=== PART 0 — must-FAIL: pre-fix (\\r\\n only) leaves a lone CR; the shared normaliser removes it ===');
  const prefix = (t) => String(t ?? '').replace(/\r\n/g, '\n');       // the OLD rule at both sites
  const shared = (t) => String(t ?? '').replace(/\r\n?/g, '\n');      // the ONE normaliser this step adds
  const beforeHasCR = /\r/.test(prefix(REPLY));
  const afterHasCR = /\r/.test(shared(REPLY));
  check('MUST-FAIL: the pre-fix \\r\\n-only rule leaves a lone CR embedded', beforeHasCR === true, show(prefix(REPLY)));
  check('FIXED: the shared \\r\\n? normaliser leaves no CR', afterHasCR === false, show(shared(REPLY)));
  // And it must not vacuously "pass" by mangling CRLF/LF: all 4 parts, 4 lines.
  const lines = shared(REPLY).split('\n');
  check('shared normaliser splits the reply into exactly 4 lines (CRLF+CR+LF all become LF)',
    lines.length === 4 && PARTS.every((p, i) => lines[i] === p), { lines });
}

/* ── seed: a COPY of the REAL board (test against the real artifact) ───────── */
function seedRealBoardCopy() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'arch006-'));
  const bugs = path.join(scratch, 'docs', 'bugs');
  fs.mkdirSync(bugs, { recursive: true });
  for (const n of fs.readdirSync(REAL_BUGS)) {
    const src = path.join(REAL_BUGS, n);
    if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(bugs, n));
  }
  return { hostPath: scratch, bugs };
}
const findTicketId = (bugs) => {
  // any real BUG/FEAT/ARCH ticket file to append a note to
  const hit = fs.readdirSync(bugs).find((n) => /^(BUG|FEAT|ARCH)-\d+-.+\.md$/.test(n));
  return hit ? hit.match(/^((?:BUG|FEAT|ARCH)-\d+)-/)[1] : null;
};

/* ── PART A — the REAL write path ─────────────────────────────────────────── */
function partA() {
  console.log('\n=== PART A — appendNote (tickets.ts entryBody) over a copy of the real board ===');
  const { hostPath, bugs } = seedRealBoardCopy();
  const id = findTicketId(bugs);
  if (!id) { check('a real ticket exists to append to', false, { bugs }); return; }

  // 1) tickets.ts path: appendNote → entryBody
  const detail = readTicket(hostPath, id);
  const res = appendNote(hostPath, id, REPLY, detail.rev, { author: 'ARCH-006 test', label: 'Note' });
  const appended = res.appended;
  console.log(`        appendNote appended:\n        ${show(appended)}`);
  check('[tickets.ts entryBody] appended note contains NO embedded CR', !/\r/.test(appended), { hasCR: /\r/.test(appended) });
  // Re-read the ticket record the user would see and confirm every paragraph is present on its own visible line.
  const after = readTicket(hostPath, id).markdown;
  const noteBlockLines = appended.split('\n').map((l) => l.replace(/^\s*(- \*\*Note:\*\* )?/, '').trim()).filter(Boolean);
  for (const p of PARTS) {
    const onOwnLine = noteBlockLines.includes(p);
    check(`[tickets.ts] paragraph present as its own visible line: "${p.slice(0, 32)}…"`, onOwnLine, { onOwnLine });
  }
  // The user-visible harm made concrete: a terminal/renderer applies the CR, hiding P3.
  const firstPhysicalLineWithP2 = appended.split('\n').find((l) => l.includes(P2)) ?? '';
  const collapsed = firstPhysicalLineWithP2.split('\r').pop(); // what a CR-honouring render leaves visible
  check('[tickets.ts] P3 is NOT hidden by a CR on the P2 line (collapse test)',
    !(firstPhysicalLineWithP2.includes('\r')) , { firstPhysicalLineWithP2: show(firstPhysicalLineWithP2), visibleAfterCR: collapsed });

  // 2) board.ts path: composeAnswerEntry → bulletLines (exported, the real fn)
  console.log('\n=== PART A(2) — composeAnswerEntry (board.ts bulletLines) ===');
  const entry = composeAnswerEntry({ kind: 'decision', note: REPLY, via: 'ticket view' });
  console.log(`        composeAnswerEntry produced:\n        ${show(entry)}`);
  check('[board.ts bulletLines] composed answer entry contains NO embedded CR', !/\r/.test(entry), { hasCR: /\r/.test(entry) });
  const answerLines = entry.split('\n').map((l) => l.replace(/^\s*(- \*\*Answer:\*\* )?/, '').trim()).filter(Boolean);
  for (const p of PARTS) {
    check(`[board.ts] paragraph present as its own visible line: "${p.slice(0, 32)}…"`, answerLines.includes(p), { present: answerLines.includes(p) });
  }

  fs.rmSync(hostPath, { recursive: true, force: true });
}

part0();
partA();
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
if (fail) { console.log('failed:', failures.join(' | ')); process.exit(1); }
