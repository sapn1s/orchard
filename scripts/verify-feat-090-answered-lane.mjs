/**
 * FEAT-090 (steps 1-3, the board-state half) — a ticket you have answered leaves
 * the Needs-You rail, lands in a derived "answered — awaiting action" lane, and
 * surfaces in the launch snapshot as decided-but-not-dispatched; plus the
 * generalised `ticketDecision` parser and the live pre-existing detection bug.
 *
 *   node scripts/verify-feat-090-answered-lane.mjs
 *
 * Pure board-state unit checks (no server, no browser): everything drives
 * `readBoard` / `ticketDecision` / `boardSummary` / `boardStateSection` directly
 * over SCRATCH fixture projects in a tmp dir, plus the REAL docs/bugs/ARCH-003
 * file for the parser. Asserts on VALUES, never printed text.
 *
 * Contract proved:
 *   STEP 1 (both directions): a 👤 ticket whose ordinary PROSE contains the mark
 *     "via Needs-You rail" is NOT treated as answered (stays on needsYou); a
 *     genuinely answered ticket IS detected (leaves needsYou).
 *   STEP 2: a bare answer (nothing after) → answeredAwaiting, off needsYou;
 *     answer-then-agent-note clears it; an Owner→🤖 flip clears it; counts.answered
 *     matches and the needs count excludes it.
 *   STEP 3: ticketDecision parses REAL decision prose into keyed, labelled,
 *     paragraph-length options (discovered at runtime — not a named ticket that
 *     answering/overturning moves), validates the `Recommended:` token in BOTH
 *     directions on that real prose (a matching key survives, a non-option token
 *     is dropped), and never leaks heading scaffolding or fabricates a question;
 *     returns null for a no-decision ticket; refuses to invent options from prose
 *     bullets under a Decision heading; the `## Question` shape still works. The
 *     snapshot's answered section appears, is placed BEFORE needs-you, and
 *     survives tail-truncation on a deliberately overfull realistic board.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readBoard, ticketDecision, boardSummary, boardStateSection } from '../src/server/board.ts';
import { discoverRealDecisions, setRecommendation, NON_OPTION_KEY } from './lib/real-decisions.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const REAL_BUGS = path.join(ROOT, 'docs', 'bugs');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

/* ------------------------------------------------------------- fixtures */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'feat090-'));
function mkProject(name, indexRows, files) {
  const proj = path.join(TMP, name);
  const bugs = path.join(proj, 'docs', 'bugs');
  fs.mkdirSync(bugs, { recursive: true });
  fs.writeFileSync(path.join(bugs, 'INDEX.md'),
    `# Board\n\n## Open\n\n| ID | Title | Owner | Status | Sev |\n|----|-------|-------|--------|-----|\n` +
    indexRows.map((r) => `| ${r} |`).join('\n') + '\n');
  for (const [fname, body] of Object.entries(files)) fs.writeFileSync(path.join(bugs, fname), body);
  return proj;
}
const ans = (date, body) => `\n### ${date} — you (via Needs-You rail)\n- **Answer:** ${body}\n`;
const ansNew = (date, body) => `\n### ${date} — you (answered from ticket)\n- **Answer:** ${body}\n`;
const note = (date, who, body) => `\n### ${date} — ${who}\n- ${body}\n`;

const T = {
  // STEP 1 direction A: prose merely MENTIONS the mark — must NOT count as answered.
  prose: `# BUG-500 — prose mentions the phrase\n\n- **Status:** OPEN\n\n## In plain terms\nThe answer path stamps entries via Needs-You rail, which is what this ticket is about.\n\n## Activity log (APPEND-ONLY)\n${note('2026-08-18', 'orchestrator', 'filed')}`,
  // STEP 2 bare answer (legacy mark), nothing after → answeredAwaiting.
  bareLegacy: `# BUG-501 — pick a ceiling\n\n- **Status:** OPEN\n\n## Question\nWhat ceiling?\n\n## Activity log (APPEND-ONLY)\n${note('2026-08-17', 'orchestrator', 'filed')}${ans('2026-08-18', 'go with five')}`,
  // STEP 2 bare answer (NEW `you (answer…` form) → answeredAwaiting.
  bareNew: `# BUG-505 — new answer form\n\n- **Status:** OPEN\n\n## Activity log (APPEND-ONLY)\n${note('2026-08-17', 'orchestrator', 'filed')}${ansNew('2026-08-18', 'chose option B')}`,
  // STEP 2 answer THEN a dated agent note after it → cleared.
  answeredThenNote: `# BUG-502 — acted on\n\n- **Status:** OPEN\n\n## Activity log (APPEND-ONLY)\n${ans('2026-08-17', 'do it')}${note('2026-08-18', 'agent', 'started work per the answer')}`,
  // STEP 2 answered but INDEX flips owner to 🤖 → inflight, not answeredAwaiting.
  answeredButAgent: `# BUG-503 — picked up\n\n- **Status:** OPEN\n\n## Activity log (APPEND-ONLY)\n${ans('2026-08-18', 'proceed')}`,
  // STEP 3 Question shape still works (plain bullets → option labels).
  question: `# BUG-504 — retry policy\n\n- **Status:** OPEN\n\n## Question\nWhich backoff?\n- linear\n- exponential\n\n## Activity log (APPEND-ONLY)\n`,
  // STEP 3 no decision — prose only.
  noDecision: `# BUG-506 — just a status row\n\n- **Status:** OPEN — tracking only\n\n## In plain terms\nNothing to decide yet.\n`,
  // STEP 3 REFUSAL — a `## Decision` heading whose bullets are ordinary prose
  // (no bold-lead `KEY — label`). Must NOT invent options.
  proseDecision: `# BUG-507 — looks like a decision but isn't\n\n- **Status:** OPEN\n\n## Decision — how to proceed\nWe will consider:\n- first we should look at the logs\n- then maybe rewrite the parser\n- and finally ship it\n`,
};

/* ========================================================= STEP 1 ===== */
console.log('\n=== STEP 1 — anchored answer detection (both directions) ===');
{
  const proj = mkProject('step1', [
    'BUG-500 | prose mentions the phrase | 👤 | needs | med',
    'BUG-501 | pick a ceiling | 👤 | needs | med',
  ], { 'BUG-500-prose.md': T.prose, 'BUG-501-ceiling.md': T.bareLegacy });
  const b = readBoard(proj);
  check('STEP1-A a ticket whose PROSE mentions the mark STAYS on needsYou (not dropped)',
    b.needsYou.some((x) => x.id === 'BUG-500') && !b.answeredAwaiting.some((x) => x.id === 'BUG-500'),
    b.needsYou.map((x) => x.id));
  check('STEP1-B a genuinely answered ticket is detected — LEAVES needsYou',
    !b.needsYou.some((x) => x.id === 'BUG-501') && b.answeredAwaiting.some((x) => x.id === 'BUG-501'),
    { needs: b.needsYou.map((x) => x.id), answered: b.answeredAwaiting.map((x) => x.id) });
}

/* ========================================================= STEP 2 ===== */
console.log('\n=== STEP 2 — derived answered-awaiting state ===');
{
  const proj = mkProject('step2', [
    'BUG-501 | pick a ceiling | 👤 | needs | med',
    'BUG-505 | new answer form | 👤 | needs | med',
    'BUG-502 | acted on | 👤 | needs | med',
    'BUG-503 | picked up | 🤖 | in progress | med',
  ], {
    'BUG-501-ceiling.md': T.bareLegacy, 'BUG-505-new.md': T.bareNew,
    'BUG-502-acted.md': T.answeredThenNote, 'BUG-503-picked.md': T.answeredButAgent,
  });
  const b = readBoard(proj);
  const awaitingIds = b.answeredAwaiting.map((x) => x.id);
  check('a bare answer (nothing after) SETS answered-awaiting — both mark forms',
    awaitingIds.includes('BUG-501') && awaitingIds.includes('BUG-505'), awaitingIds);
  check('answer-then-agent-note CLEARS it (dropped from every lane)',
    !awaitingIds.includes('BUG-502') && !b.needsYou.some((x) => x.id === 'BUG-502') && !b.inflight.some((x) => x.id === 'BUG-502'),
    { awaiting: awaitingIds, needs: b.needsYou.map((x) => x.id), inflight: b.inflight.map((x) => x.id) });
  check('an Owner→🤖 flip CLEARS it (routes to inflight, not answered-awaiting)',
    b.inflight.some((x) => x.id === 'BUG-503') && !awaitingIds.includes('BUG-503'),
    { inflight: b.inflight.map((x) => x.id), awaiting: awaitingIds });
  check('the answered item carries its chosen answer + date (for the snapshot)',
    b.answeredAwaiting.find((x) => x.id === 'BUG-501')?.answer === 'go with five' &&
      b.answeredAwaiting.find((x) => x.id === 'BUG-501')?.answeredOn === '2026-08-18',
    b.answeredAwaiting.map((x) => ({ id: x.id, answer: x.answer, on: x.answeredOn })));

  const sum = boardSummary(b);
  check('counts.answered === answeredAwaiting.length (derived, not stored)',
    sum.counts.answered === b.answeredAwaiting.length && sum.counts.answered === 2, sum.counts);
  check('the needs count EXCLUDES answered items (still means "waiting on you")',
    sum.counts.needs === b.needsYou.length && !b.needsYou.some((x) => awaitingIds.includes(x.id)),
    { needs: sum.counts.needs, needsIds: b.needsYou.map((x) => x.id) });
}

/* ========================================================= STEP 3 ===== */
console.log('\n=== STEP 3 — ticketDecision parser (REAL decision prose, discovered + property-tested) ===');
{
  // Discover whichever real tickets carry a genuine decision block RIGHT NOW,
  // rather than pinning ARCH-003's values — which answering it / overturning its
  // premise legitimately changes (that is exactly what reddened this suite). The
  // parser is still exercised on real, paragraph-length, marked-up option prose.
  const reals = discoverRealDecisions(REAL_BUGS, ticketDecision, { minOptions: 2 });
  check('REAL board carries at least one genuine decision (≥2 keyed options) for the parser to chew on',
    reals.length >= 1, { count: reals.length, ids: reals.map((r) => r.id) });
  check('every REAL decision parses to short keyed options with non-empty labels (no invented / malformed options)',
    reals.every((r) => r.decision.options.every((o) => /^[A-Za-z0-9]{1,6}$/.test(o.key) && (o.label ?? '').trim().length > 0)),
    reals.map((r) => ({ id: r.id, keys: r.decision.options.map((o) => o.key) })));
  // Real-length fidelity: pick the discovered decision with the most option prose
  // so the recommendation legs run against genuine paragraph-length descriptions,
  // not a one-word stub.
  const proseLen = (r) => r.decision.options.reduce((n, o) => n + (o.description ?? '').length, 0);
  const real = [...reals].sort((a, b) => proseLen(b) - proseLen(a))[0];
  check('the REAL decision under test has paragraph-length option prose (genuine markdown, real length)',
    proseLen(real) > 120, { id: real.id, totalDescChars: proseLen(real), opts: real.decision.options.length });

  // Recommendation VALIDATION, both directions, driven on that real prose. We own
  // the ONE value asserted on (the token), so a live Status-line edit cannot
  // redden this while the real options stay real.
  const validKey = real.decision.options[0].key;
  check('REAL prose + a valid `Recommended:` key on the Status line → the parser surfaces exactly that key',
    ticketDecision(setRecommendation(real.body, validKey))?.recommended === validKey,
    { id: real.id, validKey, got: ticketDecision(setRecommendation(real.body, validKey))?.recommended });
  check('REAL prose + a `Recommended:` token matching NO option → dropped to null (never badge a phantom choice)',
    ticketDecision(setRecommendation(real.body, NON_OPTION_KEY))?.recommended === null,
    { id: real.id, bogus: NON_OPTION_KEY, got: ticketDecision(setRecommendation(real.body, NON_OPTION_KEY))?.recommended });

  // Question integrity as a PROPERTY over every real decision: never leak the
  // "Decision N —" heading scaffolding, and a contentless heading falls back to
  // the title FLAGGED (questionFromTitle) rather than becoming a bare "the decision".
  check('no REAL decision leaks "Decision N —" heading scaffolding into its question',
    reals.every((r) => !/^\s*decisions?\s+\d+\s*[—–-]/i.test(r.decision.question ?? '')),
    reals.map((r) => ({ id: r.id, q: (r.decision.question ?? '').slice(0, 40) })));
  check('every REAL decision has a real question OR a title-fallback flagged questionFromTitle (never a contentless "the decision")',
    reals.every((r) => {
      const q = (r.decision.question ?? '').trim();
      if (!q) return false;
      return r.decision.questionFromTitle === true || !/^(the\s+)?decisions?$/i.test(q);
    }),
    reals.map((r) => ({ id: r.id, q: r.decision.question, fromTitle: r.decision.questionFromTitle })));

  check('a status-only ticket (no Question, no Decision) → null',
    ticketDecision(T.noDecision) === null, 'null-expected');
  check('REFUSAL: a `## Decision` heading with only PROSE bullets → null (no invented options)',
    ticketDecision(T.proseDecision) === null, ticketDecision(T.proseDecision));

  const q = ticketDecision(T.question);
  check('the `## Question` shape still works — options are the plain-bullet labels',
    !!q && q.question === 'Which backoff?' && q.options.map((o) => o.label).join(',') === 'linear,exponential',
    { question: q?.question, options: q?.options?.map((o) => o.label) });
  // Anti-regression: readBoard still surfaces those options as string[] on needsYou.
  const projQ = mkProject('step3q', ['BUG-504 | retry policy | 👤 | needs | med'], { 'BUG-504-retry.md': T.question });
  const item = readBoard(projQ).needsYou.find((x) => x.id === 'BUG-504');
  check('readBoard keeps item.options as string[] (BUG-025 wire shape unchanged)',
    Array.isArray(item?.options) && item.options.join(',') === 'linear,exponential', item?.options);
}

/* ============================== STEP 3 — snapshot + truncation ========= */
console.log('\n=== STEP 3 — launch snapshot: placement + survives truncation ===');
{
  // A REALISTIC busy board: many needs / inflight / done rows AND several
  // answered-awaiting tickets — the state after a while of real use, not a
  // minimal fixture. This is the case the tail-truncation could silently eat.
  const rows = [];
  const files = {};
  for (let i = 0; i < 3; i++) {
    const id = `BUG-6${i}0`;
    rows.push(`${id} | answered decision number ${i} with a deliberately long title to eat chars | 👤 | needs | med`);
    files[`${id}-a.md`] = `# ${id} — answered decision number ${i}\n\n## Activity log (APPEND-ONLY)\n${ans('2026-08-18', `chose option ${'BCD'[i]} after weighing the tradeoffs at length`)}`;
  }
  for (let i = 0; i < 12; i++) {
    const id = `BUG-7${i.toString().padStart(2, '0')}`;
    rows.push(`${id} | open needs-you item ${i} still waiting on the user to decide something | 👤 | needs | med`);
    files[`${id}-n.md`] = `# ${id} — open needs-you item ${i}\n\n## Question\nDecide item ${i}?\n`;
  }
  for (let i = 0; i < 10; i++) rows.push(`BUG-8${i.toString().padStart(2, '0')} | in-flight work item ${i} being actively built right now | 🤖 | in progress | med`);
  const proj = mkProject('snapshot', rows, files);
  const b = readBoard(proj);
  check('realistic board parsed: 3 answered, 12 needs, 10 inflight',
    b.answeredAwaiting.length === 3 && b.needsYou.length === 12 && b.inflight.length === 10,
    { answered: b.answeredAwaiting.length, needs: b.needsYou.length, inflight: b.inflight.length });

  const full = boardStateSection(proj);
  const idxAnswered = full.indexOf('Answered — awaiting action');
  const idxNeeds = full.indexOf('Needs you (');
  check('snapshot has the answered section, placed BEFORE the needs-you list',
    idxAnswered !== -1 && idxNeeds !== -1 && idxAnswered < idxNeeds, { idxAnswered, idxNeeds });
  check('snapshot states the decided-but-not-dispatched instruction',
    /DECIDED but NOT dispatched/.test(full) && /ask before you begin/.test(full), 'instruction present');
  check('snapshot lists an answered ticket with its chosen answer + date',
    full.includes('BUG-600') && /chose: chose option B/.test(full) && full.includes('answered 2026-08-18'),
    full.slice(idxAnswered, idxAnswered + 160));

  // Deliberately OVERFULL: tiny maxChars that would slice the tail hard. The
  // answered section (top-placed, cap-protected) must survive whole; the
  // needs/inflight tail is what truncates.
  const tight = boardStateSection(proj, { maxChars: 300 });
  check('OVERFULL board (maxChars 300): answered section STILL fully present',
    tight.includes('Answered — awaiting action (3)') && /ask before you begin/.test(tight) &&
      tight.includes('BUG-600') && tight.includes('BUG-620'),
    { len: tight.length });
  check('OVERFULL board: the TAIL is what truncates (ends with the …ellipsis)',
    tight.endsWith('…') && tight.indexOf('Answered') < tight.indexOf('…'), { tail: tight.slice(-40) });

  // Control: with NO answered lane, the cap is NOT raised (maxChars honoured).
  const projNoAns = mkProject('noans', rows.filter((r) => !r.includes('answered decision')), files);
  const capped = boardStateSection(projNoAns, { maxChars: 300 });
  check('CONTROL: empty answered lane → cap NOT raised (respects maxChars 300)',
    capped.length <= 300 && !capped.includes('Answered — awaiting action'), { len: capped.length });
}

/* --------------------------------------------------------------- done */
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) console.log(`failed: ${failures.join(' | ')}`);
process.exit(fail ? 1 : 0);
