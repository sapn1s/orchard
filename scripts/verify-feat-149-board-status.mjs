#!/usr/bin/env node
/**
 * verify-feat-149-board-status.mjs — the `board:status` ground-truth command.
 *
 * FEAT-149: an orchestrator under the enforced tool profile cannot Read/Grep the
 * board, so it relayed lane claims as fact. `npm run board:status -- <ID>` gives
 * it the durable record under its profile. This suite is the anti-regression for
 * that command, run against the REAL board (docs/bugs), per docs/CONVENTIONS.md
 * ("test against the real artifact"):
 *
 *   1. non-vacuity — a Done ticket's report DIFFERS from an open ticket's, so the
 *      success branch reads the real record and cannot fire on a constant;
 *   2. control — a nonexistent (well-formed) id FAILS loudly (exit 3, ok:false),
 *      never an empty success; a malformed id is rejected (exit 2);
 *   3. the load-bearing signal — an AMBIGUOUS-DONE ticket (leading word open,
 *      classified done by an incidental token) is surfaced as such, which is the
 *      exact case that produced the measured failure.
 *
 * It anchors to PROPERTIES discovered at runtime, not to today's values (a
 * ticket's state changes as the product is used): it finds a done ticket and an
 * open ticket from the live board and asserts the invariant, and fails loudly if
 * the board contains no qualifying artifact at all.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import url from 'node:url';
import { readTickets } from './board.mjs';
import { buildTicketReport } from './board-status.mjs';
import { resolveBoardDir } from './lib/board-path.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIR = resolveBoardDir(ROOT);
const CLI = path.join(HERE, 'board-status.mjs');

let pass = 0, fail = 0;
const fails = [];
function check(name, ok, observed) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; fails.push(name); console.log(`  FAIL  ${name}\n        observed: ${observed}`); }
}

/** Run the CLI, capturing stdout + exit code (execFileSync throws on non-zero). */
function run(args) {
  try {
    const out = execFileSync('node', [CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

// Discover a done ticket and an open ticket from the LIVE board (properties, not
// pinned ids). Fail loudly if the board has neither — that itself is worth knowing.
const { tickets } = readTickets(DIR);
let doneId = null, openId = null;
for (const t of tickets.values()) {
  if (t.done && !doneId) doneId = t.id;
  if (!t.done && !openId) openId = t.id;
  if (doneId && openId) break;
}
check('board has both a done and an open ticket to compare', !!doneId && !!openId, `done=${doneId} open=${openId}`);

// (1) non-vacuity: the two reports differ.
if (doneId && openId) {
  const a = run([doneId]);
  const b = run([openId]);
  check('done vs open reports DIFFER (success branch is not a constant)',
    a.out !== b.out && a.code === 0 && b.code === 0, `equal=${a.out === b.out}`);
  check('a done ticket reports work_state done (verified/done)',
    /\[board places in: done\]/.test(a.out), a.out.split('\n')[1]);
  check('an open ticket reports work_state open',
    /\[board places in: open\]/.test(b.out), b.out.split('\n')[1]);
}

// (2) control: a well-formed but nonexistent id fails LOUDLY, not empty-success.
const missing = run(['ARCH-99999']);
check('nonexistent id exits 3 (not an empty success)', missing.code === 3, `code=${missing.code}`);
check('nonexistent id names the miss on stderr', /no ticket file/.test(missing.out), missing.out.trim());
const missingJson = run(['ARCH-99999', '--json']);
check('nonexistent id --json is ok:false', /"ok":\s*false/.test(missingJson.out) && missingJson.code === 3, `code=${missingJson.code}`);
const malformed = run(['not-a-ticket']);
check('malformed id is rejected (exit 2)', malformed.code === 2, `code=${malformed.code}`);

// (3) the load-bearing signal: if the board carries an ambiguous-DONE ticket
// (leading word not done, classified done by an incidental token), board:status
// must SURFACE it — this is the exact case that produced the measured failure.
let ambigId = null;
for (const t of tickets.values()) { if (t.statusAmbiguous) { ambigId = t.id; break; } }
if (ambigId) {
  const r = buildTicketReport(DIR, ambigId, 3);
  check(`ambiguous-DONE ticket (${ambigId}) is flagged status_ambiguous`, r.ok && r.status_ambiguous === true, `ambiguous=${r.status_ambiguous}`);
  const cli = run([ambigId]);
  check(`ambiguous-DONE ticket (${ambigId}) prints the AMBIGUOUS warning`,
    /AMBIGUOUS/.test(cli.out) && /Trust the leading word/.test(cli.out), cli.out.split('\n').slice(1, 4).join(' / '));
} else {
  console.log('  SKIP  no ambiguous-DONE ticket on the board today (nothing to assert)');
}

// zero-arg whole-board summary works and reports counts.
const summary = run([]);
check('zero-arg summary reports open/done/needs-you counts',
  /open: \d+\s+done: \d+\s+needs-you/.test(summary.out) && summary.code === 0, summary.out.split('\n')[1]);

console.log(`\nTOTAL: ${pass} passed, ${fail} failed`);
if (fail) { console.log('failing:\n  - ' + fails.join('\n  - ')); process.exit(1); }
process.exit(0);
