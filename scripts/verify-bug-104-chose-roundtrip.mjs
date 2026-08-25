/**
 * BUG-104 — the `- **Chose:**` round trip: whatever the answer path WRITES, the
 * ticket-detail read path (board.ts `ticketAnswerState`) must READ BACK, for every
 * decision mode the system supports — a single choice, a MULTI-select composed
 * answer ("1 + 2 + 4"), and a staged single.
 *
 * THE DEFECT (found by the ticket-view lane, correctly left to the server):
 * `composeAnswerEntry` writes a multi answer as `- **Chose:** <keys> — <labels>`
 * where the keys are composed with ` + ` (decide.js: `keys.join(' + ')`). The old
 * reader grammar `([A-Za-z0-9]{1,6})\s*[—–-]` captured only ONE key token and then
 * expected the dash where the ` + ` sat, so the line failed to match and
 * `answer.chose` came back null: the WRITE path and the READ path disagreed about
 * the same line. The ticket file was always correct; only the card's echo of WHICH
 * options were chosen was lost.
 *
 * This proves the round trip BY CONSTRUCTION over the REAL answer path
 * (tickets.answerTicket → composeAnswerEntry → fs.append; board.ts ticketAnswerState
 * on re-read), not by hand-writing the Chose line. Scratch board lives on the
 * sanctioned persistent path (never /tmp, never the repo).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ticketAnswerState, composeAnswerEntry } from '../src/server/board.ts';
import { answerTicket, readTicket } from '../src/server/tickets.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
// A persistent scratch root on the same filesystem as the repo, no dotted
// component — NOT /tmp (which fails the isolation contract) and NOT the repo.
// Derived from the home dir so no literal home path is committed (leak-gate).
const SCRATCH = process.env.CLAUDE_SCRATCH || path.join(os.homedir(), 'scratch');
fs.mkdirSync(SCRATCH, { recursive: true });

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

/* The OLD grammar, verbatim, so the must-FAIL proof does not depend on git state. */
const OLD_CHOSE_RE = /^[-*]\s*\*\*Chose:?\*\*\s*([A-Za-z0-9]{1,6})\s*[—–-]\s*(.*)$/i;
/** What the OLD reader would have returned for one entry's Chose line. */
function oldReadChose(md) {
  for (const raw of md.split('\n')) {
    const m = raw.trim().match(OLD_CHOSE_RE);
    if (m) return { key: m[1].trim(), label: m[2].trim() };
  }
  return null;
}

/* ─────────────────────────────────────────── a realistic multi-decision board */
function seedBoard(bugs) {
  fs.mkdirSync(bugs, { recursive: true });
  fs.writeFileSync(path.join(bugs, 'INDEX.md'),
    `# Board — scratch\n\n## Open\n\n` +
    `| ID | Title | Owner | Status | Sev |\n|----|-------|-------|--------|-----|\n` +
    `| BUG-901 | multi-select: which mitigations to ship | 👤 | needs decision | high |\n` +
    `| BUG-902 | all four, or none | 👤 | needs decision | high |\n` +
    `| BUG-903 | adjacent + prefix keys | 👤 | needs decision | med |\n` +
    `| BUG-904 | numeric prefix keys 1 and 10 | 👤 | needs decision | med |\n` +
    `| BUG-905 | single choice, the legacy shape | 👤 | needs decision | med |\n` +
    `| BUG-906 | a key that embeds a hyphen | 👤 | needs decision | low |\n` +
    `| BUG-907 | already answered before this fix (single key on disk) | 👤 | answered | med |\n\n` +
    `## Done (committed)\n\n| ID | Title | Commit |\n|----|-------|--------|\n\n` +
    `## Shipped earlier (pre-tracker)\n\n- nothing yet\n`);

  const decisionTicket = (id, title) =>
    `# ${id} — ${title}\n\n- **Status:** OPEN — DECISION NEEDED.\n- **Severity:** med\n- **Area:** server\n\n` +
    `## Decision — pick the mitigations\n` +
    `- **1 — canary probes.** Cheap, catches the common case.\n` +
    `- **2 — schema guard.** Structural, refuses the bad shape.\n` +
    `- **4 — audit sweep.** Backfills the historic gap.\n\n` +
    `## Activity log (APPEND-ONLY)\n\n### 2026-08-03 — orchestrator\n- filed, waiting on the user.\n`;

  fs.writeFileSync(path.join(bugs, `BUG-901-multi.md`), decisionTicket('BUG-901', 'multi-select: which mitigations to ship'));
  fs.writeFileSync(path.join(bugs, `BUG-902-all.md`), decisionTicket('BUG-902', 'all four, or none'));
  fs.writeFileSync(path.join(bugs, `BUG-903-adjacent.md`), decisionTicket('BUG-903', 'adjacent + prefix keys'));
  fs.writeFileSync(path.join(bugs, `BUG-904-numeric.md`), decisionTicket('BUG-904', 'numeric prefix keys 1 and 10'));
  fs.writeFileSync(path.join(bugs, `BUG-905-single.md`), decisionTicket('BUG-905', 'single choice, the legacy shape'));
  fs.writeFileSync(path.join(bugs, `BUG-906-hyphen.md`), decisionTicket('BUG-906', 'a key that embeds a hyphen'));

  // BUG-907: a ticket ALREADY answered with the OLD single-key form on disk —
  // existing tickets carry this shape and must keep reading correctly.
  const legacyAnswer = composeAnswerEntry({
    kind: 'decision', question: 'ship it?', chose: { key: 'B', label: 'ship the interim shield' },
    note: 'do B now, revisit later', via: 'ticket view',
  });
  fs.writeFileSync(path.join(bugs, `BUG-907-legacy.md`),
    `# BUG-907 — already answered before this fix (single key on disk)\n\n` +
    `- **Status:** OPEN\n- **Severity:** med\n- **Area:** server\n\n` +
    `## Question\nShip the interim shield?\n- **A — hold.** wait for the full fix.\n- **B — ship the shield.** cheap guard now.\n\n` +
    `## Activity log (APPEND-ONLY)\n\n### 2026-08-03 — orchestrator\n- filed.\n${legacyAnswer}`);

  for (const t of ['TEMPLATE.md', 'TEMPLATE-ARCH.md']) {
    try { fs.copyFileSync(path.join(ROOT, 'docs', 'bugs', t), path.join(bugs, t)); } catch { /* optional */ }
  }
}

const ticketPath = (bugs, id) => {
  const hit = fs.readdirSync(bugs).find((n) => n.startsWith(`${id}-`));
  return hit ? path.join(bugs, hit) : null;
};

/** Answer `id` through the REAL path with the given composed chose, return read-back state + on-disk md. */
function answerAndReadBack(host, bugs, id, chose, note) {
  const rev = readTicket(host, id).rev;
  answerTicket(host, id, { kind: 'decision', question: 'pick the mitigations', chose, note }, rev);
  const md = fs.readFileSync(ticketPath(bugs, id), 'utf8');
  const state = readTicket(host, id).answer; // TicketAnswerState via ticketAnswerState
  return { md, state };
}

/* ═══════════════════════════════════════════════════════════════════ RUN ══ */
const TMP = fs.mkdtempSync(path.join(SCRATCH, 'bug104-'));
try {
  const bugs = path.join(TMP, 'docs', 'bugs');
  seedBoard(bugs);
  const host = TMP;

  console.log('\n=== MUST-FAIL FIRST — the OLD grammar cannot read the composed answer it wrote ===');
  // Write a genuine multi answer through the real path, then read its on-disk
  // Chose line with the OLD regex — proving the write/read disagreement existed.
  const mf = answerAndReadBack(host, bugs, 'BUG-901',
    { key: '1 + 2 + 4', label: 'canary probes + schema guard + audit sweep' }, 'ship all three');
  const choseLine = (mf.md.match(/- \*\*Chose:\*\*.*/) ?? ['(none)'])[0];
  check('the composed answer IS written to the ticket verbatim (write path is correct)',
    /- \*\*Chose:\*\* 1 \+ 2 \+ 4 — canary probes \+ schema guard \+ audit sweep/.test(mf.md), choseLine);
  const oldEcho = oldReadChose(mf.md);
  check('MUST-FAIL: the OLD single-key grammar returns NULL for the composed line (the defect)',
    oldEcho === null, { oldEcho });

  console.log('\n=== THE FIX — the current reader round-trips the composed answer ===');
  check('multi (1+2+4): answer.chose round-trips the WHOLE composed key and label',
    mf.state?.chose?.key === '1 + 2 + 4'
      && mf.state?.chose?.label === 'canary probes + schema guard + audit sweep'
      && mf.state?.note === 'ship all three'
      && mf.state?.awaiting === true,
    mf.state?.chose);

  console.log('\n=== EVERY MODE / EDGE ===');
  // one option only
  const one = answerAndReadBack(host, bugs, 'BUG-905', { key: '2', label: 'schema guard' }, 'just the guard');
  check('single option: chose round-trips {key:"2", label:"schema guard"}',
    one.state?.chose?.key === '2' && one.state?.chose?.label === 'schema guard', one.state?.chose);

  // all options
  const all = answerAndReadBack(host, bugs, 'BUG-902',
    { key: '1 + 2 + 4', label: 'canary probes + schema guard + audit sweep' }, 'everything');
  check('all options: chose round-trips the full composed key + label',
    all.state?.chose?.key === '1 + 2 + 4'
      && all.state?.chose?.label === 'canary probes + schema guard + audit sweep', all.state?.chose);

  // adjacent + shared-prefix keys (A / AB)
  const adj = answerAndReadBack(host, bugs, 'BUG-903', { key: 'A + AB', label: 'alpha + alphabet' }, 'both');
  check('shared-prefix keys (A + AB): the reader does not truncate at the prefix',
    adj.state?.chose?.key === 'A + AB' && adj.state?.chose?.label === 'alpha + alphabet', adj.state?.chose);

  // adjacent numeric prefix (1 / 10)
  const num = answerAndReadBack(host, bugs, 'BUG-904', { key: '1 + 10', label: 'first + tenth' }, 'both');
  check('numeric prefix keys (1 + 10): "1" is not mistaken for the whole key',
    num.state?.chose?.key === '1 + 10' && num.state?.chose?.label === 'first + tenth', num.state?.chose);

  // a key that embeds a hyphen — must survive whole (the delimiter is a
  // space-flanked em/en dash, NOT a bare hyphen).
  const hy = answerAndReadBack(host, bugs, 'BUG-906', { key: 'C-1', label: 'variant one' }, 'the hyphenated key');
  check('key embedding a hyphen ("C-1"): survives whole; the em-dash delimiter is not confused with the key hyphen',
    hy.state?.chose?.key === 'C-1' && hy.state?.chose?.label === 'variant one', hy.state?.chose);

  // label CONTAINING an em-dash — the split is on the FIRST separator only.
  const emLabel = answerAndReadBack(host, bugs, 'BUG-901',
    { key: '1 + 2', label: 'canary — the cheap one + schema guard' }, 're-answer with an em-dash in the label');
  check('label containing an em-dash: split on the FIRST separator, label kept whole',
    emLabel.state?.chose?.key === '1 + 2'
      && emLabel.state?.chose?.label === 'canary — the cheap one + schema guard', emLabel.state?.chose);

  console.log('\n=== BACKWARD COMPAT — a previously-answered single-key ticket still reads ===');
  const legacy = readTicket(host, 'BUG-907').answer;
  check('legacy single-key on disk (seeded before the fix): still reads {key:"B", label:"ship the interim shield"}',
    legacy?.chose?.key === 'B' && legacy?.chose?.label === 'ship the interim shield' && legacy?.note === 'do B now, revisit later',
    legacy?.chose);

  // empty-label edge: composeAnswerEntry trimEnds a bodyless label → "Chose: X —"
  const bodyless = composeAnswerEntry({ kind: 'decision', chose: { key: 'A', label: '' }, via: 'ticket view' });
  const bl = ticketAnswerState(`# X\n## Activity log\n${bodyless}`);
  check('empty label ("Chose: A —" after trimEnd): key="A", label="" reads back without error',
    bl?.chose?.key === 'A' && bl?.chose?.label === '', bl?.chose);

} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\nBUG-104 chose round-trip: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:\n' + failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
process.exit(0);
