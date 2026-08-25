#!/usr/bin/env node
/**
 * verify-decision-shape.mjs — the ARCH-005 enforcement guard: a ticket that says
 * a human must choose MUST expose options the real parser can read, and MUST be
 * routed to that human.
 *
 * WHAT IT IS PROVING, and why the shape of this suite is what it is:
 *
 * The defect was a SILENT MISS. ARCH-005 declared "NEEDS A HUMAN DECISION",
 * argued four options in numbered prose, and rendered as nothing — no Decide
 * card, no question, no error. So the property under test is not "the checker
 * runs"; it is "the checker cannot be satisfied by a ticket that looks right and
 * parses to nothing", and equally "it does not fire on tickets that are fine".
 * A guard that only ever says FAIL is as useless as one that only says PASS, so
 * every case below is paired: a violating ticket AND its near-miss twin that must
 * stay silent.
 *
 * The fixture is a SYNTHETIC board (no real board is small enough to enumerate
 * cases on, and pinning today's real tickets would make this suite redden every
 * time someone files one). It is deliberately a REALISTIC MIX, not the minimum:
 * it carries the four states the real board actually contained when this landed —
 * a prose-options decision, a correct one, a bare 👤 attention row, and a done
 * ticket whose status merely MENTIONS a decision — plus the routing cases. The
 * real board is then run through the same function and its violation count is
 * REPORTED (not asserted), so this suite measures the mechanism and `board:check`
 * measures the board.
 *
 * Usage: node scripts/verify-decision-shape.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { decisionShapeFails } from './board.mjs';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const REAL_BUGS = path.resolve(here, '..', 'docs', 'bugs');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

// --------------------------------------------------------------------------
// Fixture board — a realistic mix, one file per case.
// --------------------------------------------------------------------------

const GOOD_OPTIONS = [
  '- **A — encapsulate the fields.** Move them behind accessors so a direct read is impossible;',
  '  costs a classification pass over ~46 call sites.',
  '- **B — add a lint guard.** Cheaper, catches the next surface at commit time, but the allowlist rots.',
  '- **C — keep patching.** Priced honestly: ~3 fixes per adversarial round, indefinitely.',
].join('\n');

const PROSE_OPTIONS = [
  '1. **Encapsulate the fields.** Move them behind accessors so a direct read is impossible;',
  '   costs a classification pass over ~46 call sites.',
  '',
  '2. **Add a lint guard.** Cheaper, catches the next surface at commit time, but the allowlist rots.',
  '',
  '3. **Keep patching.** Priced honestly: ~3 fixes per adversarial round, indefinitely.',
].join('\n');

const CASES = [
  // id, filename slug, status header, body, INDEX row owner (null = no row / 'done' = Done table)
  {
    id: 'ARCH-901', slug: 'prose-options-decision', owner: '👤',
    status: 'OPEN — NEEDS A HUMAN DECISION. No build starts until an option below is chosen.',
    body: `## Options\n\n${PROSE_OPTIONS}\n`,
    expect: 'UNPARSEABLE DECISION',
    why: 'declares a decision, argues options as numbered prose — the exact ARCH-005 state',
  },
  {
    id: 'ARCH-902', slug: 'correct-decision', owner: '👤',
    status: 'OPEN — NEEDS A HUMAN DECISION (3 options below). Recommended: B',
    body: `## Decision — encapsulate, guard, or keep patching?\n\n${GOOD_OPTIONS}\n`,
    expect: null,
    why: 'declares a decision AND exposes parseable options AND is owned by 👤',
  },
  {
    id: 'ARCH-903', slug: 'parseable-but-unrouted', owner: '—',
    status: 'OPEN — NEEDS A HUMAN DECISION (3 options below).',
    body: `## Decision — encapsulate, guard, or keep patching?\n\n${GOOD_OPTIONS}\n`,
    expect: 'DECISION NOT ROUTED',
    why: 'options parse, but the Owner is not 👤 so the rail never shows the card',
  },
  {
    id: 'BUG-904', slug: 'one-bold-bullet-is-not-a-choice', owner: '👤',
    status: 'OPEN — awaiting a decision from you.',
    body: '## Decision — do the thing?\n\n- **A — do the thing.** The only option offered.\n',
    expect: 'UNPARSEABLE DECISION',
    why: 'one option is not a choice; the parser needs at least two',
  },
  {
    id: 'FEAT-905', slug: 'options-heading-prose-under-needs-you', owner: '👤',
    status: 'OPEN — explore finished; recommend a staged fix.',
    body: `## Options (trade-offs)\n\n${PROSE_OPTIONS}\n`,
    expect: 'UNPARSEABLE DECISION',
    why: 'no decision language in the Status header, but it is parked on 👤 and lays out options',
  },
  {
    id: 'FEAT-906', slug: 'bare-attention-row', owner: '👤',
    status: 'OPEN — cleanup complete; recommend keeping it open until you run the publish.',
    body: '## Wanted\nA thing, eventually. Nothing to choose between.\n',
    expect: null,
    why: 'BUG-025: a bare 👤 ticket with no options section is a legitimate read-only attention row',
  },
  {
    id: 'BUG-907', slug: 'done-ticket-mentioning-a-decision', owner: 'done',
    status: 'FIXED 2026-08-18 — decision made: do all three remedies.',
    body: `## Options\n\n${PROSE_OPTIONS}\n`,
    expect: null,
    why: 'a closed ticket REPORTS a decision; it asks nothing of anyone',
  },
  {
    id: 'FEAT-908', slug: 'status-mentions-the-decide-card', owner: '—',
    status: 'OPEN — built; pending unbiased visual review of the Decide card and narrow sheet.',
    body: '## Wanted\nA card. Built already.\n',
    expect: null,
    why: 'the words "Decide"/"decision" appearing incidentally must not trigger the check',
  },
  {
    id: 'ARCH-909', slug: 'prose-options-no-index-row', owner: null,
    status: 'OPEN — NEEDS DECISION: build it, or accept the workaround.',
    body: `## Options\n\n${PROSE_OPTIONS}\n`,
    expect: 'UNPARSEABLE DECISION',
    why: 'a ticket with no INDEX row is still checked for shape',
  },
  {
    id: 'ARCH-910', slug: 'correct-decision-no-index-row', owner: null,
    status: 'OPEN — NEEDS A HUMAN DECISION (3 options below).',
    body: `## Decision — encapsulate, guard, or keep patching?\n\n${GOOD_OPTIONS}\n`,
    expect: null,
    why: 'no INDEX row: MISSING FROM BOARD already says that — do not double-report it as unrouted',
  },
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-shape-'));
const openRows = [], doneRows = [];
for (const c of CASES) {
  fs.writeFileSync(path.join(dir, `${c.id}-${c.slug}.md`),
    `# ${c.id} — ${c.slug.replace(/-/g, ' ')}\n\n` +
    `- **Status:** ${c.status}\n- **Severity:** medium\n\n${c.body}\n` +
    '## Activity log (APPEND-ONLY)\n\n### 2026-08-18 — fixture\n- **Understood:** synthetic.\n');
  if (c.owner === 'done') doneRows.push(`| ${c.id} | ${c.slug} | abc1234 |`);
  else if (c.owner !== null) openRows.push(`| ${c.id} | ${c.slug} | ${c.owner} | ${c.status.replace(/\|/g, '\\|')} | med |`);
}
fs.writeFileSync(path.join(dir, 'INDEX.md'), [
  '# Board', '', '## Open', '',
  '| ID | Title | Owner | Status | Sev |', '|----|-------|-------|--------|-----|',
  ...openRows, '',
  '## Done (committed)', '', '| ID | Title | Commit |', '|----|-------|--------|',
  ...doneRows, '', '## Shipped', '',
].join('\n'));

// --------------------------------------------------------------------------
console.log('=== STEP 1 — every case, violating and clean, on a realistic mixed fixture ===');
const fails = await decisionShapeFails(dir);
const byId = new Map();
for (const f of fails) {
  const m = f.match(/^(UNPARSEABLE DECISION|DECISION NOT ROUTED): ([A-Z]+-\d+)/);
  if (m) byId.set(m[2], m[1]);
}
for (const c of CASES) {
  const got = byId.get(c.id) ?? null;
  ok(`${c.id} ${c.expect ? `FAILS as ${c.expect}` : 'is silent'} — ${c.why}`, got === c.expect, { expected: c.expect, got });
}
ok('no unexpected extra failures beyond the enumerated cases', fails.length === byId.size && byId.size === CASES.filter((c) => c.expect).length,
  { fails: fails.length, matched: byId.size });

console.log('\n=== STEP 2 — the check is NOT vacuous: the same ticket flips PASS↔FAIL on shape alone ===');
// Take the violating ARCH-901 verbatim and change ONLY the option formatting.
const p901 = path.join(dir, 'ARCH-901-prose-options-decision.md');
const before = fs.readFileSync(p901, 'utf8');
ok('as filed (prose options) it FAILS', (await decisionShapeFails(dir)).some((f) => f.startsWith('UNPARSEABLE DECISION: ARCH-901')));
fs.writeFileSync(p901, before.replace(`## Options\n\n${PROSE_OPTIONS}`, `## Decision — which one?\n\n${GOOD_OPTIONS}`));
const afterFails = await decisionShapeFails(dir);
ok('same ticket, same prose, options reformatted → PASSES', !afterFails.some((f) => /ARCH-901/.test(f)), afterFails.filter((f) => /ARCH-901/.test(f)));
fs.writeFileSync(p901, before);
ok('reverting the formatting brings the failure back (not an ordering artefact)',
  (await decisionShapeFails(dir)).some((f) => f.startsWith('UNPARSEABLE DECISION: ARCH-901')));

console.log('\n=== STEP 3 — the failure message tells the author how to fix it ===');
const msg = (await decisionShapeFails(dir)).find((f) => f.startsWith('UNPARSEABLE DECISION: ARCH-901')) ?? '';
for (const needle of ['- **A —', 'at least TWO', 'bold', '## Decision', 'docs/bugs/README.md', 'TEMPLATE-ARCH.md']) {
  ok(`message contains ${JSON.stringify(needle)}`, msg.includes(needle));
}
ok('message names the ticket and says what the consequence is',
  msg.includes('ARCH-901') && /never reaches the user/.test(msg));

console.log('\n=== STEP 4 — ONE parser: board.mjs must not carry its own copy of the option grammar ===');
// If the checker re-implemented the grammar, the checker and the rail could
// disagree about what a ticket says — which is this bug, one level up.
const boardMjs = fs.readFileSync(path.join(here, 'board.mjs'), 'utf8');
ok('board.mjs imports the real ticketDecision from src/server/board.ts',
  /ticketDecision\s*\}\s*=\s*await import/.test(boardMjs) || /\{\s*ticketDecision\s*\}/.test(boardMjs));
const codeOnly = boardMjs.split('\n').filter((l) => !/^\s*\*/.test(l) && !/^\s*\/\//.test(l)).join('\n');
// The parser's distinctive grammar element is the KEY—label separator class
// `[—–-]` inside a bold run. If that ever appears in board.mjs's code, someone
// has started a second parser.
ok('board.mjs defines NO KEY—label option grammar of its own',
  !codeOnly.includes('[—–-]') && !codeOnly.includes('OPTION_BULLET'),
  codeOnly.split('\n').filter((l) => l.includes('[—–-]') || l.includes('OPTION_BULLET')));
// Behavioural half: on every fixture case the checker's verdict must equal what
// the rail's own parser says, computed here independently.
const { ticketDecision } = await import(url.pathToFileURL(path.resolve(here, '..', 'src', 'server', 'board.ts')).href);
let agreed = 0;
for (const c of CASES) {
  const md = fs.readFileSync(path.join(dir, `${c.id}-${c.slug}.md`), 'utf8');
  const railSeesAChoice = !!ticketDecision(md) && ticketDecision(md).options.length >= 2;
  const checkerSaysUnparseable = byId.get(c.id) === 'UNPARSEABLE DECISION';
  if (!(checkerSaysUnparseable && railSeesAChoice)) agreed++;
  else console.log(`   disagreement on ${c.id}`);
}
ok('checker and rail agree on every fixture case (no divergence)', agreed === CASES.length, { agreed, of: CASES.length });

console.log('\n=== STEP 5 — the REAL board, reported (not asserted: filing a ticket must not redden this suite) ===');
const realFails = await decisionShapeFails(REAL_BUGS);
console.log(`  real board: ${realFails.length} decision-shape violation(s)`);
for (const f of realFails) console.log(`    · ${f.split('\n')[0]}`);
ok('the real board is readable by the check (it ran and returned a list)', Array.isArray(realFails));

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} PASS${fail ? ` — ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);
