/**
 * ARCH-004 option C — REACHABILITY check + FEAT-082 parser-defect verification.
 *
 *   node scripts/verify-reachability.mjs
 *
 * Two things are proven here, both against REAL tickets wherever a real instance
 * exists (docs/CONVENTIONS.md — test the artifact, not a mental model):
 *
 * A. THE PARSER DEFECTS (real decision prose, DISCOVERED at runtime — not a named
 *    ticket whose values answering/overturning legitimately changes):
 *    - the widened `## …decision…` heading parses real decision blocks (the old
 *      `/^##\s+Decision/i` required the heading to START with "Decision" and so
 *      dropped `## The decision` silently) — keyed, labelled options.
 *    - a contentless heading falls back to the title, flagged questionFromTitle.
 *    - the `Recommended:` token is validated against the option keys in BOTH
 *      directions, driven on real prose: a matching key survives, a non-option
 *      token (like ARCH-004's "one …") is dropped to null. (This is the assertion
 *      that reddened when the user answered ARCH-003 and its `Recommended: B` went
 *      away — it now owns the token instead of pinning ARCH-003's value.)
 *    - strictness holds: an OWNED prose-bullet decision fixture (the shape
 *      FEAT-082 used to carry, now held constant here rather than pinned to a
 *      live ticket) and BUG-101 (no decision) still parse to null — no fake buttons.
 *
 * B. THE REACHABILITY CHECK (must-FAIL both directions + a run on the REAL board):
 *    The unreachable/healthy fixtures are SYNTHETIC by necessity — the real board
 *    currently has no unreachable ticket (that is itself the run-on-real result).
 *    The two fixtures are the SAME rail-dropped shape (an answered-and-already-
 *    acted 👤 ticket that `readBoard` removes from every lane) differing ONLY in
 *    recency, so the pair proves the property in both directions with one
 *    mechanism. Fixture ticket files are BACKDATED with utimes so the mtime half
 *    of the "recently-updated" lane is exercised honestly, not defeated by the
 *    fresh mtime a just-written fixture would carry.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ticketDecision } from '../src/server/board.ts';
import { discoverRealDecisions, setRecommendation, NON_OPTION_KEY } from './lib/real-decisions.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const BOARD_MJS = path.join(ROOT, 'scripts', 'board.mjs');
const REAL_BUGS = path.join(ROOT, 'docs', 'bugs');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

const readReal = (prefix) => {
  const name = fs.readdirSync(REAL_BUGS).find((n) => n.startsWith(prefix) && n.endsWith('.md'));
  if (!name) throw new Error(`no real ticket file for ${prefix}`);
  return fs.readFileSync(path.join(REAL_BUGS, name), 'utf8');
};

/* ============================ A — parser defects (REAL tickets) ============ */
// PROPERTY, not value (docs/CONVENTIONS.md). The old suite named ARCH-003 and
// pinned `Recommended: B` + ARCH-004's exact question; answering ARCH-003 and
// overturning its premise dropped that token and reddened the suite though the
// parser was fine. We now DISCOVER whichever real tickets carry a decision block
// and assert the parser's INVARIANTS against that real prose — including the
// widened-heading and recommendation-validation defects the original guarded —
// while OWNING the one value each assertion turns on.
console.log('\n=== A. Parser defects — real decision prose (discovered) + real null cases ===');
{
  const reals = discoverRealDecisions(REAL_BUGS, ticketDecision, { minOptions: 2 });
  check('DEFECT-1 the widened `## …decision…` heading parses REAL decision blocks (≥1 found; the old /^##\\s+Decision/i dropped `## The decision`)',
    reals.length >= 1, { count: reals.length, ids: reals.map((r) => r.id) });
  check('DEFECT-1 every discovered decision yields exactly its bold-lead option keys with non-empty labels',
    reals.every((r) => r.decision.options.length >= 2 && r.decision.options.every((o) => /^[A-Za-z0-9]{1,6}$/.test(o.key) && (o.label ?? '').trim())),
    reals.map((r) => ({ id: r.id, keys: r.decision.options.map((o) => o.key) })));
  // A contentless heading (e.g. ARCH-004's `## The decision`) must fall back to
  // the title, flagged — never become a bare "the decision" shown as the ask.
  check('DEFECT-1 a contentless heading never becomes the question — it falls back to the title, flagged questionFromTitle',
    reals.every((r) => {
      const q = (r.decision.question ?? '').trim();
      return q && (r.decision.questionFromTitle === true || !/^(the\s+)?decisions?$/i.test(q));
    }),
    reals.map((r) => ({ id: r.id, q: r.decision.question, fromTitle: r.decision.questionFromTitle })));

  // DEFECT-2 recommendation validation, BOTH directions, on real option prose —
  // driving the token so the live Status line changing cannot redden it.
  const real = reals[0];
  const validKey = real.decision.options[0].key;
  check('DEFECT-2 a valid `Recommended:` key on REAL prose SURVIVES validation (resolves to that option)',
    ticketDecision(setRecommendation(real.body, validKey))?.recommended === validKey,
    { id: real.id, validKey, got: ticketDecision(setRecommendation(real.body, validKey))?.recommended });
  check('DEFECT-2 a `Recommended:` token matching NO option (like ARCH-004\'s "one …") is DROPPED to null',
    ticketDecision(setRecommendation(real.body, NON_OPTION_KEY))?.recommended === null,
    { id: real.id, bogus: NON_OPTION_KEY, got: ticketDecision(setRecommendation(real.body, NON_OPTION_KEY))?.recommended });

  // Strictness holds: a decision-ish heading whose options are numbered/prose
  // bullets must still parse to null — no fake buttons (BUG-025).
  //
  // This USED to pin FEAT-082, whose `## Open decision (user)` section happened
  // to be written that way. That was a live-board value dressed as a property:
  // the moment FEAT-082's options were rewritten into the parseable shape (which
  // is a FIX — the ticket was blocked on a human and rendering as nothing), the
  // suite reddened even though the parser was untouched. The comment here even
  // predicted the flip. So the shape is now OWNED by the suite: the fixture below
  // is the exact prose FEAT-082 carried, held constant on purpose.
  const PROSE_DECISION = [
    '# FEAT-999 — a decision heading whose options are prose',
    '', '- **Status:** OPEN', '',
    '## Open decision (user)',
    '1. Approve Option A (facets + proof card, no lanes)?',
    '2. Proof capture: **best-effort regex now** (zero workflow change) vs',
    '   **structured template fields** going forward — or both.',
  ].join('\n');
  check('REGRESS a `## …decision…` heading with numbered/prose bullets still → null (no fake buttons)',
    ticketDecision(PROSE_DECISION) === null, ticketDecision(PROSE_DECISION));
  check('REGRESS BUG-101 (no decision at all) still → null',
    ticketDecision(readReal('BUG-101')) === null, 'null expected');
}

/* ============================ B — reachability fixtures ==================== */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-'));
const DAY = 86400e3;
const fmt = (d) => new Date(d).toISOString().slice(0, 10);
const OLD = Date.now() - 40 * DAY;      // well outside the 7-day window
const RECENT = Date.now() - 2 * DAY;    // inside the 7-day window

// An answered-AND-already-acted 👤 ticket: the rail (readBoard) removes it from
// EVERY lane. Reachability then hinges purely on recency.
const railDropped = (id, title, day) =>
  `# ${id} — ${title}\n\n- **Status:** OPEN\n- **Severity:** med\n\n` +
  `## Activity log (APPEND-ONLY)\n` +
  `\n### ${fmt(day)} — you (via Needs-You rail)\n- **Answer:** proceed\n` +
  `\n### ${fmt(day + DAY)} — agent\n- started the work per the answer\n`;
const simple = (id, title, status) =>
  `# ${id} — ${title}\n\n- **Status:** ${status}\n- **Severity:** med\n\n` +
  `## Activity log (APPEND-ONLY)\n\n### ${fmt(OLD)} — orchestrator\n- filed\n`;

function mkBoard(name, openRows, doneRows, files, backdate = {}) {
  const bugs = path.join(TMP, name, 'docs', 'bugs');
  fs.mkdirSync(bugs, { recursive: true });
  const index =
    `# Board\n\n## Open\n\n| ID | Title | Owner | Status | Sev |\n|----|-------|-------|--------|-----|\n` +
    openRows.map((r) => `| ${r} |`).join('\n') +
    `\n\n## Done (committed)\n\n| ID | Title | Commit |\n|----|-------|--------|\n` +
    doneRows.map((r) => `| ${r} |`).join('\n') +
    `\n\n## Shipped\n\n(none)\n`;
  fs.writeFileSync(path.join(bugs, 'INDEX.md'), index);
  for (const [fname, body] of Object.entries(files)) {
    const full = path.join(bugs, fname);
    fs.writeFileSync(full, body);
    if (backdate[fname]) fs.utimesSync(full, new Date(backdate[fname]), new Date(backdate[fname]));
  }
  return bugs;
}

function runCheck(bugsDir) {
  const r = spawnSync('node', [BOARD_MJS, 'check', `--dir=${bugsDir}`], { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}
const unreachableIds = (out) =>
  out.split('\n').filter((l) => l.includes('UNREACHABLE TICKET:'))
    .map((l) => (l.match(/UNREACHABLE TICKET:\s*([A-Z]+-\d+)/) || [])[1]).filter(Boolean);

/* ---- B1. must-FAIL: an open ticket reachable from NO lane is reported ---- */
console.log('\n=== B1. must-FAIL — unreachable ticket is reported ===');
{
  const bugs = mkBoard('unreach',
    ['BUG-900 | quietly answered and acted | 👤 | OPEN | med',
     'BUG-901 | active and visible | 👤 | OPEN | med'],
    ['BUG-902 | genuinely finished | abc1234'],
    {
      'BUG-900-quiet.md': railDropped('BUG-900', 'quietly answered and acted', OLD),
      'BUG-901-active.md': simple('BUG-901', 'active and visible', 'OPEN'),
      'BUG-902-done.md': simple('BUG-902', 'genuinely finished', 'VERIFIED — done'),
    },
    { 'BUG-900-quiet.md': OLD + DAY });
  const { status, out } = runCheck(bugs);
  const ids = unreachableIds(out);
  check('B1 reports BUG-900 (rail-dropped + gone quiet) as UNREACHABLE', ids.includes('BUG-900'), ids);
  check('B1 does NOT flag BUG-901 (on the needs-you lane)', !ids.includes('BUG-901'), ids);
  check('B1 does NOT flag BUG-902 (resolved, lives quietly in Done)', !ids.includes('BUG-902'), ids);
  check('B1 board:check exits non-zero (drift) when a ticket is unreachable', status === 1, status);
  // Non-redundancy: reachability is the ONLY check that catches BUG-900 — it
  // agrees with itself (👤 / OPEN / Open-section), so nothing else fires on it.
  const otherOnBug900 = out.split('\n').some((l) =>
    l.includes('BUG-900') && /(STATUS MISMATCH|STALE OWNER|MISSING FROM BOARD|DUPLICATE)/.test(l));
  check('B1 non-redundant — no STATUS/STALE/MISSING check fires on BUG-900 (only reachability)',
    !otherOnBug900, otherOnBug900 ? 'another check also named BUG-900' : 'reachability alone');
}

/* ---- B2. must-FAIL other direction: a healthy board reports NONE ---- */
console.log('\n=== B2. healthy board — same shape but recent → reports none ===');
{
  const bugs = mkBoard('healthy',
    ['FEAT-810 | answered but freshly acted | 👤 | OPEN | med',
     'FEAT-811 | needs the user | 👤 | OPEN | med',
     'FEAT-812 | agent is on it | 🤖 | in progress | med',
     'FEAT-813 | filed for later | — | OPEN | med'],
    ['FEAT-814 | shipped | def5678'],
    {
      // Same rail-dropped shape as BUG-900, but RECENT → reachable via the
      // recently-updated lane (the both-directions pair, one mechanism).
      'FEAT-810-fresh.md': railDropped('FEAT-810', 'answered but freshly acted', RECENT),
      'FEAT-811-needs.md': simple('FEAT-811', 'needs the user', 'OPEN'),
      'FEAT-812-agent.md': simple('FEAT-812', 'agent is on it', 'IN-PROGRESS'),
      'FEAT-813-later.md': simple('FEAT-813', 'filed for later', 'OPEN'),
      'FEAT-814-done.md': simple('FEAT-814', 'shipped', 'VERIFIED — done'),
    });
  const { status, out } = runCheck(bugs);
  const ids = unreachableIds(out);
  check('B2 a healthy board reports ZERO unreachable tickets', ids.length === 0, ids);
  check('B2 the rail-dropped-but-RECENT ticket (FEAT-810) is NOT flagged', !ids.includes('FEAT-810'), ids);
  check('B2 board:check exits 0 on the healthy board', status === 0, status);
}

/* ---- B3. run on the REAL board — report what it finds (a genuine discovery) ---- */
console.log('\n=== B3. real board — genuine-discovery run ===');
{
  const { out } = runCheck(REAL_BUGS);
  const ids = unreachableIds(out);
  console.log(`  REAL BOARD: ${ids.length} unreachable ticket(s)${ids.length ? ': ' + ids.join(', ') : ''}`);
  // Not a pass/fail assertion on count — any count is a real result, not a test
  // failure. We only assert the ride-along RAN (did not silently degrade) by
  // confirming board:check produced its summary line.
  check('B3 reachability ride-along ran on the real board (board:check completed)',
    /board:check —/.test(out), out.split('\n').find((l) => l.includes('board:check —')) ?? '(no summary)');
}

/* ================================ summary ================================= */
console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} passed, ${fail} failed`);
if (fail) { console.log('failed:', failures.join('; ')); process.exit(1); }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
