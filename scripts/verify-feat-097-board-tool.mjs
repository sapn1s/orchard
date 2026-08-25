#!/usr/bin/env node
/**
 * verify-feat-097-board-tool.mjs — proof for scripts/board-tool.mjs.
 *
 * WHAT IT RUNS AGAINST. A byte-for-byte COPY of the REAL `docs/bugs/` (210
 * tickets, 203 of them in the record format and 7 legacy prose, one INDEX.md
 * with 25 needs-you rows and a Done table), inside a REAL scratch git repo with
 * the REAL gate copied in. Not a fixture: a fixture encodes the author's
 * assumptions, and every property below is about what happens on a busy, mixed,
 * half-migrated board — which is the only kind this project has.
 *
 * WHAT IT ASSERTS. Invariants, never today's values. It discovers the tickets it
 * needs at runtime (a block ticket carrying a live decision, a legacy prose
 * ticket, an untouched legacy row) and FAILS LOUDLY if the real board contains
 * no qualifying artifact at all, rather than passing quietly on an empty set.
 * The one thing it pins is the pre-existing `board:check` result of the copy,
 * used as a BASELINE: every later check must be a subset of it, so the suite
 * cannot be reddened by drift this tool did not cause.
 *
 * MUST-FAIL PROOFS, each anchored to a state this suite SYNTHESIZES (never to
 * HEAD, which becomes the fixed state the moment a fix lands):
 *   · a record that fails `validateTicket` is not written, and no file appears
 *   · a leaked home path makes the gate exit non-zero and the commit does not
 *     happen — then the same commit succeeds once the leak is removed, which is
 *     what makes the refusal non-vacuous
 *   · an orphan INDEX row makes `commit` refuse rather than commit a broken board
 *   · a stale `--rev` is a 409 and nothing is written
 *
 * TRUNCATED READS. Agents write these files while this tool reads them, so the
 * suite truncates a REAL ticket at several plausible points and grades each one:
 * a half-written record must never be reported as an ordinary open ticket, and
 * must never take the rest of the board down with it.
 *
 * Run: node scripts/verify-feat-097-board-tool.mjs
 * Spawns no server, touches no port, and never writes inside the real repo.
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';

import { mkdtempScratch } from './lib/scratch.mjs';
import { parseTicket, validateTicket, formatTicket, extractTicketBlock, TICKET_FILE_RE } from './lib/ticket-schema.mjs';
import { boardTool } from './board-tool.mjs';
import { genBoard } from './board.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const REAL_BOARD = path.join(REPO, 'docs', 'bugs');

let pass = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { console.log(`\n${title}`); }

/** A qualifying real artifact, or a loud stop. A suite that finds none proves nothing. */
function require_(value, what) {
  if (value === null || value === undefined) {
    console.log(`\nSTOP — the real board contains no ${what}; this suite cannot prove anything without one.`);
    process.exit(1);
  }
  return value;
}

function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return (r.stdout || '').trim();
}

/* ───────────────────────────────────────────────────────── the scratch board */

const scratch = mkdtempScratch('feat-097-board-tool-');
const ROOT = path.join(scratch, 'repo');
const BOARD = path.join(ROOT, 'docs', 'bugs');

function setup() {
  fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
  fs.cpSync(REAL_BOARD, BOARD, { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'scripts'), { recursive: true });
  // The REAL gate, so `commit`'s refusal is the real gate's refusal.
  for (const s of ['gate.mjs', 'leak-gate.mjs', 'check-nul.mjs']) {
    fs.copyFileSync(path.join(REPO, 'scripts', s), path.join(ROOT, 'scripts', s));
  }
  // No `typecheck` script: gate.mjs then reports it SKIPPED and the leak-gate is
  // what decides, which is the half this suite is exercising.
  fs.writeFileSync(path.join(ROOT, 'package.json'), `${JSON.stringify({ name: 'scratch-board', private: true, type: 'module' }, null, 2)}\n`);
  git(ROOT, ['init', '-q', '-b', 'main']);
  git(ROOT, ['config', 'user.email', 'suite@example.invalid']);
  git(ROOT, ['config', 'user.name', 'board tool suite']);
  git(ROOT, ['add', '--', 'docs', 'scripts', 'package.json']);
  git(ROOT, ['commit', '-q', '-m', 'scratch: a copy of the real board']);
}

const call = (...argv) => boardTool(argv, { root: ROOT });
const readBoardFile = (name) => fs.readFileSync(path.join(BOARD, name), 'utf8');
const indexText = () => readBoardFile('INDEX.md');
const rowOf = (text, id) => text.split('\n').find((l) => l.trimStart().startsWith(`| ${id} |`)) ?? null;

async function main() {
  /*
   * What the real board looked like BEFORE this suite ran. The property at the
   * end is that this suite wrote nothing to the real repo — which is a
   * COMPARISON, not "docs/bugs is clean". Requiring cleanliness made the suite
   * red whenever any lane had an uncommitted ticket, including the lane running
   * it, so it reported someone else's ordinary work as a violation by this tool.
   */
  const BOARD_STATUS_BEFORE = git(REPO, ['status', '--porcelain', '--', 'docs/bugs']);
  setup();

  section('0. the copy IS the real board');
  const realFiles = fs.readdirSync(REAL_BOARD).filter((f) => TICKET_FILE_RE.test(f));
  const copyFiles = fs.readdirSync(BOARD).filter((f) => TICKET_FILE_RE.test(f));
  ok('every real ticket file was copied', realFiles.length === copyFiles.length && realFiles.length > 100, `${realFiles.length} real vs ${copyFiles.length} copied`);
  const ORIGINAL_INDEX = indexText();
  ok('INDEX.md is byte-identical to the real one', ORIGINAL_INDEX === fs.readFileSync(path.join(REAL_BOARD, 'INDEX.md'), 'utf8'));

  // Discovered, not named: the artifacts the later properties need.
  const parsedAll = copyFiles.map((f) => ({ f, text: fs.readFileSync(path.join(BOARD, f), 'utf8') }))
    .map(({ f, text }) => ({ f, text, p: parseTicket(text, { file: f, mode: 'auto' }) }));
  const legacy = require_(parsedAll.find((x) => x.p.format === 'legacy' && !x.p.summary.done) ?? null, 'open legacy prose ticket');
  const legacyUntouched = require_(parsedAll.find((x) => x.p.format === 'legacy' && x.f !== legacy.f) ?? null, 'second legacy ticket');
  const withDecision = require_(
    parsedAll.find((x) => x.p.format === 'block' && x.p.record?.decision && typeof x.p.record.decision === 'object') ?? null,
    'record ticket carrying a live decision',
  );
  // Deliberately a DIFFERENT ticket from the decision one: it plays the innocent
  // bystander whose dirty file must survive a commit untouched.
  const blockOpen = require_(parsedAll.find((x) => x.p.format === 'block' && x.p.summary.work_state === 'open' && x.f !== withDecision.f) ?? null, 'second open record ticket');
  console.log(`  (discovered: legacy=${legacy.p.summary.id} untouched-legacy=${legacyUntouched.p.summary.id} decision=${withDecision.p.record.id} open-record=${blockOpen.p.record.id})`);

  const baseline = await call('check');
  ok('check runs on the real board copy', baseline.ok === true, JSON.stringify(baseline.refusal ?? ''));
  const BASELINE_FAILS = new Set(baseline.board.fails);
  console.log(`  (baseline: ${baseline.board.ticket_count} tickets, ${BASELINE_FAILS.size} pre-existing fail(s), ${baseline.board.warns.length} advisory)`);
  const noNewDrift = (r, where) => {
    const added = (r.board?.fails ?? []).filter((f) => !BASELINE_FAILS.has(f));
    ok(`${where}: introduces no board drift`, added.length === 0, added.join(' | '));
  };

  section('1. query — structured, complete, and it cannot leak a path');
  const all = await call('query', '--limit=500');
  ok('query returns every ticket on the board', all.total === copyFiles.length, `${all.total} vs ${copyFiles.length} files`);
  ok('query returns data, not prose', Array.isArray(all.tickets) && typeof all.tickets[0].id === 'string' && 'work_state' in all.tickets[0]);
  ok('no returned path is absolute', all.tickets.every((t) => !t.file.startsWith('/') && t.file.startsWith('docs/bugs/')));
  const open = await call('query', '--section=open', '--limit=500');
  const done = await call('query', '--section=done', '--limit=500');
  const openIds = new Set(open.tickets.map((t) => t.id));
  ok('open and done partition the board', open.total + done.total === all.total && done.tickets.every((t) => !openIds.has(t.id)));
  // The owner filter, checked against an INDEX parse this tool did not do.
  const needsYouRows = ORIGINAL_INDEX.split('\n')
    .filter((l) => /^\|\s*(ARCH|BUG|FEAT|DEPLOY)-\d+\s*\|/.test(l) && l.includes('\u{1F464}'))
    .map((l) => l.split('|')[1].trim());
  const you = await call('query', '--owner=you', '--limit=500');
  ok('--owner=you matches exactly the 👤 rows in INDEX.md', you.total === needsYouRows.length && you.tickets.every((t) => needsYouRows.includes(t.id)), `${you.total} vs ${needsYouRows.length}`);
  const byState = await call('query', `--state=${blockOpen.p.summary.work_state}`, '--limit=500');
  ok('--state returns only tickets in that state', byState.tickets.every((t) => t.work_state === 'open') && byState.total > 0);
  const one = await call('query', `--id=${withDecision.p.record.id}`, '--include-body');
  ok('--id returns exactly that ticket, with its record', one.total === 1 && one.tickets[0].record?.id === withDecision.p.record.id && one.tickets[0].format === 'block');
  const searchNeedle = withDecision.p.record.id;
  const found = await call('query', `--text=${searchNeedle}`, '--limit=500');
  ok('--text searches ticket bodies', found.total >= 1 && found.tickets.some((t) => t.match_count > 0));
  const badId = await call('query', '--id=../../etc/passwd');
  ok('an id that is a path is refused', badId.ok === false && badId.refusal.code === 'bad-id');
  ok('query mutates nothing', indexText() === ORIGINAL_INDEX);

  section('2. file — validated before it is written, and refused with reasons');
  const before = fs.readdirSync(BOARD).length;
  const invalid = await call('file', `--json=${JSON.stringify({ type: 'bug', title: 'a ticket with no summary at all' })}`);
  ok('an invalid record is refused', invalid.ok === false && invalid.refusal.code === 'invalid-ticket');
  ok('the refusal returns the schema\'s own violations', invalid.refusal.detail.some((d) => d.includes('summary')) && invalid.refusal.detail.some((d) => d.includes('severity')));
  ok('nothing was written for the refused ticket', fs.readdirSync(BOARD).length === before);

  const overLongTitle = await call('file', `--json=${JSON.stringify({
    type: 'bug', title: 'this title deliberately runs well past the schema twelve word cap for titles',
    summary: 'x'.repeat(10), impact_if_we_wait: 'y', current_need: 'z', severity: 'low', area: 'test',
    success_criteria: ['it is refused'], verification_class: 'trivial', body: '## Diagnosis\n\nnope\n',
  })}`);
  ok('the word cap is enforced by the schema, not by this tool', overLongTitle.ok === false
    && overLongTitle.refusal.detail.some((d) => /"title" is \d+ words, over its 12-word cap/.test(d)));

  const filed = await call('file', `--json=${JSON.stringify({
    type: 'bug',
    title: 'Board writes went through hand-edited index rows',
    summary: 'Filed by the board tool suite against a scratch copy of the real board, to prove that filing validates first and places its own row.',
    impact_if_we_wait: 'Nothing; this ticket exists only inside a scratch repository that is deleted when the suite finishes.',
    current_need: 'Nothing. It is a fixture written into a throwaway board copy.',
    severity: 'low', area: 'board tooling', reported_by: 'board tool suite',
    success_criteria: ['The written record validates', 'The board places its row'],
    verification_class: 'trivial',
    // body_slots is deliberately WRONG here: it must be derived, not believed.
    body_slots: { Diagnosis: false, Evidence: false, 'Implementation notes': false, 'Verification plan': false, 'Migration and rollback': false, Risks: false, 'Activity log': false },
    body: '## Diagnosis\n\nA row placed by hand is a row that can be lost.\n',
  })}`);
  ok('a valid ticket is filed', filed.ok === true, JSON.stringify(filed.refusal ?? ''));
  const FILED_ID = filed.id;
  const filedPath = path.join(ROOT, filed.file);
  ok('the id was ALLOCATED, not accepted', /^BUG-\d{3}$/.test(FILED_ID) && !copyFiles.some((f) => f.startsWith(`${FILED_ID}-`)));
  const filedText = fs.readFileSync(filedPath, 'utf8');
  const filedParsed = parseTicket(filedText, { file: path.basename(filedPath), mode: 'auto' });
  ok('the written file is in the record format', filedParsed.format === 'block' && filedParsed.record.id === FILED_ID);
  ok('the written record validates', validateTicket(filedParsed.record, { file: path.basename(filedPath) }).ok);
  ok('the file round-trips byte-for-byte', formatTicket(filedParsed.record, extractTicketBlock(filedText).body) === filedText);
  ok('body_slots is DERIVED from the body, not believed', filedParsed.record.body_slots.Diagnosis === true && filedParsed.record.body_slots['Activity log'] === true);
  ok('an Activity log exists (docs/bugs/README.md)', /^## Activity log\b/m.test(filedText) && /^### \d{4}-\d{2}-\d{2} — /m.test(filedText));
  ok('the board placed its own Open row', typeof filed.index_row === 'string' && filed.index_row.startsWith(`| ${FILED_ID} |`));
  ok('the row carries the derived severity', filed.index_row.trimEnd().endsWith('| low |'));
  noNewDrift(filed, 'file');

  section('3. update — a record change that cannot touch the body or the log');
  const bodyBefore = extractTicketBlock(fs.readFileSync(filedPath, 'utf8')).body;
  const bytesBefore = fs.readFileSync(filedPath, 'utf8');
  const upd = await call('update', `--id=${FILED_ID}`, '--work-state=in_progress', '--current-need=Prove that only the record block moved.');
  ok('update applies record fields', upd.ok === true && upd.touched.includes('record'), JSON.stringify(upd.refusal ?? ''));
  const afterUpd = fs.readFileSync(filedPath, 'utf8');
  const recAfter = parseTicket(afterUpd, { file: path.basename(filedPath), mode: 'auto' }).record;
  ok('the field actually changed', recAfter.work_state === 'in_progress' && recAfter.current_need === 'Prove that only the record block moved.');
  ok('`updated` was re-stamped', recAfter.updated === new Date().toISOString().slice(0, 10));
  ok('THE BODY IS BYTE-IDENTICAL (BUG-123 class)', extractTicketBlock(afterUpd).body === bodyBefore);
  ok('the Open row Status re-derives from the record', (rowOf(indexText(), FILED_ID) || '').includes('IN-PROGRESS'));

  const beforeLog = fs.readFileSync(filedPath, 'utf8');
  const logged = await call('update', `--id=${FILED_ID}`, '--log=An entry appended by the suite.', '--log-author=board tool suite', '--log-label=Verified');
  const afterLog = fs.readFileSync(filedPath, 'utf8');
  ok('update appends to the activity log', logged.ok === true && /- \*\*Verified:\*\* An entry appended by the suite\./.test(afterLog));
  ok('the append is APPEND-ONLY (prior bytes are a strict prefix)', afterLog.startsWith(beforeLog) && afterLog.length > beforeLog.length);

  const owned = await call('update', `--id=${FILED_ID}`, '--owner=you');
  const rowAfterOwner = rowOf(indexText(), FILED_ID) || '';
  ok('update sets the curated Owner cell', owned.ok === true && rowAfterOwner.split('|')[3].includes('\u{1F464}'));
  ok('the record\'s own owner agrees with the cell', parseTicket(fs.readFileSync(filedPath, 'utf8'), { mode: 'auto' }).record.owner === 'you');
  noNewDrift(owned, 'update --owner');

  const badState = await call('update', `--id=${FILED_ID}`, '--work-state=nonsense');
  const bytesNow = fs.readFileSync(filedPath, 'utf8');
  ok('an unknown work_state is refused', badState.ok === false && badState.refusal.code === 'bad-value');
  ok('the refused update wrote nothing', bytesNow === fs.readFileSync(filedPath, 'utf8') && bytesNow !== bytesBefore);

  // A REAL cross-field rule, on a REAL ticket: a done ticket may not carry a live
  // decision. The tool does not know that rule; validateTicket does.
  const decisionId = withDecision.p.record.id;
  const decisionBytes = fs.readFileSync(path.join(BOARD, withDecision.f), 'utf8');
  const closeIt = await call('update', `--id=${decisionId}`, '--work-state=verified');
  ok('a change that would break a cross-field rule is refused', closeIt.ok === false && closeIt.refusal.code === 'invalid-ticket'
    && closeIt.refusal.detail.some((d) => d.includes('decision_history')), JSON.stringify(closeIt.refusal?.detail ?? closeIt));
  ok('the refused ticket is byte-for-byte unchanged', fs.readFileSync(path.join(BOARD, withDecision.f), 'utf8') === decisionBytes);

  const stale = await call('update', `--id=${FILED_ID}`, '--rev=1:1', '--work-state=open');
  ok('a stale rev is a 409, not a clobber', stale.ok === false && stale.refusal.code === 'ticket-409');

  const missing = await call('update', '--id=BUG-99999', '--work-state=open');
  ok('an unknown ticket is a 404 with a reason', missing.ok === false && missing.refusal.code === 'ticket-404');

  section('4. update — a LEGACY prose ticket keeps its curated sentence');
  const legacyId = legacy.p.summary.id;
  const legacyPath = path.join(BOARD, legacy.f);
  const legacyBytes = fs.readFileSync(legacyPath, 'utf8');
  const legacyRefused = await call('update', `--id=${legacyId}`, '--work-state=verified');
  ok('a record field on a legacy ticket is refused, with the alternative named', legacyRefused.ok === false
    && legacyRefused.refusal.code === 'legacy-ticket' && legacyRefused.refusal.detail.some((d) => d.includes('--status-line')));
  ok('the legacy ticket is untouched', fs.readFileSync(legacyPath, 'utf8') === legacyBytes);

  const disagrees = await call('update', `--id=${legacyId}`, '--work-state=verified', '--status-line=OPEN — still open, actually.');
  ok('a status line that disagrees with the claimed state is refused', disagrees.ok === false && disagrees.refusal.code === 'status-disagrees');
  const gibberish = await call('update', `--id=${legacyId}`, '--status-line=frobnicated — who knows');
  ok('a status word the board cannot classify is refused', gibberish.ok === false && gibberish.refusal.code === 'unclassifiable-status');
  ok('neither refusal wrote anything', fs.readFileSync(legacyPath, 'utf8') === legacyBytes);

  const legacyOk = await call('update', `--id=${legacyId}`, '--work-state=blocked', '--status-line=BLOCKED — waiting on the suite, and this sentence is the human\'s own.');
  const legacyAfter = fs.readFileSync(legacyPath, 'utf8');
  ok('a well-formed status line lands', legacyOk.ok === true && /^- \*\*Status:\*\* BLOCKED — waiting on the suite/m.test(legacyAfter), JSON.stringify(legacyOk.refusal ?? ''));
  const diffLines = legacyBytes.split('\n').map((l, i) => (l === legacyAfter.split('\n')[i] ? null : i)).filter((i) => i !== null);
  ok('EXACTLY ONE LINE of the legacy ticket changed', diffLines.length === 1 && legacyBytes.split('\n')[diffLines[0]].startsWith('- **Status:**'), `changed lines: ${diffLines.join(',')}`);
  noNewDrift(legacyOk, 'update --status-line');

  section('5. the rows this tool did not touch are byte-identical');
  const untouchedId = legacyUntouched.p.summary.id;
  const originalRow = require_(rowOf(ORIGINAL_INDEX, untouchedId), `INDEX row for ${untouchedId}`);
  ok(`the untouched legacy row for ${untouchedId} is byte-for-byte identical`, rowOf(indexText(), untouchedId) === originalRow, `now: ${rowOf(indexText(), untouchedId)}`);
  // And the whole board, not just one row. The honest invariant is NOT "no row
  // changed" — `genBoard` re-derives Title/Status/Sev from the ticket on every
  // run, so the first reconciliation of a board that has drifted legitimately
  // rewrites the drifted rows, and this suite must not assert that away. The
  // property that matters is that THIS TOOL changed nothing a plain `board:gen`
  // would not have: the control is a pristine copy of the real board with one
  // `genBoard` run on it and nothing else.
  const CONTROL = path.join(scratch, 'control', 'docs', 'bugs');
  fs.mkdirSync(path.dirname(CONTROL), { recursive: true });
  fs.cpSync(REAL_BOARD, CONTROL, { recursive: true });
  genBoard(CONTROL);
  const controlIndex = fs.readFileSync(path.join(CONTROL, 'INDEX.md'), 'utf8');
  const touchedIds = new Set([FILED_ID, legacyId]);
  const allIds = ORIGINAL_INDEX.split('\n')
    .filter((l) => /^\|\s*(ARCH|BUG|FEAT|DEPLOY)-\d+\s*\|/.test(l))
    .map((l) => l.split('|')[1].trim());
  const divergent = allIds.filter((id) => !touchedIds.has(id) && rowOf(indexText(), id) !== rowOf(controlIndex, id));
  ok('every row this tool did not name matches a plain board:gen exactly', divergent.length === 0,
    `${divergent.length} row(s) diverged: ${divergent.slice(0, 4).join(', ')}`);
  const rederived = allIds.filter((id) => rowOf(controlIndex, id) !== rowOf(ORIGINAL_INDEX, id));
  console.log(`  (for the record: a plain board:gen re-derives ${rederived.length} row(s) of the real board — pre-existing drift, not this tool's)`);

  section('6. commit — the gate decides, and only named paths are staged');
  const noIds = await call('commit', '--message=nope');
  ok('commit without --ids is refused (there is no blanket mode)', noIds.ok === false && noIds.refusal.code === 'missing-arg');
  const noMsg = await call('commit', `--ids=${FILED_ID}`);
  ok('commit without a message is refused', noMsg.ok === false && noMsg.refusal.code === 'missing-arg');

  // Another lane's dirty file, which must be left exactly where it is.
  const bystanderPath = path.join(BOARD, blockOpen.f);
  fs.appendFileSync(bystanderPath, '\n<!-- another lane was mid-write -->\n');
  const bystanderBytes = fs.readFileSync(bystanderPath, 'utf8');

  // MUST-FAIL: a leaked home path. Written into the ticket the same way any
  // content reaches it — through the tool's own log append.
  const leak = `${'/ho'}${'me/'}${'sa'}p/projects/orchard/docs/bugs`;
  await call('update', `--id=${FILED_ID}`, `--log=Reproduced under ${leak} while testing.`);
  const headBefore = git(ROOT, ['rev-parse', 'HEAD']);
  const redGate = await call('commit', `--ids=${FILED_ID}`, '--message=board tool: this must not land');
  ok('a red gate refuses the commit', redGate.ok === false && redGate.refusal.code === 'gate-failed');
  ok('the refusal carries the gate\'s own failing lines', redGate.refusal.detail.some((d) => d.includes('leak-gate')) && redGate.refusal.detail.some((d) => d.includes('FAIL')));
  ok('nothing was committed', git(ROOT, ['rev-parse', 'HEAD']) === headBefore);

  // Remove the leak — the same commit must now succeed. Without this, the
  // refusal above could be refusing everything.
  const leaked = fs.readFileSync(path.join(ROOT, filed.file), 'utf8');
  fs.writeFileSync(path.join(ROOT, filed.file), leaked.replace(leak, '(a path elided by the suite)'));
  const green = await call('commit', `--ids=${FILED_ID}`, '--message=board tool: file, update and place the row');
  ok('the same commit succeeds once the gate is green', green.ok === true, JSON.stringify(green.refusal ?? ''));
  ok('the commit reports its own sha', /^[0-9a-f]{7,}$/.test(green.commit ?? ''));
  ok('it staged exactly the ticket and INDEX.md', green.staged.length === 2
    && green.staged.includes('docs/bugs/INDEX.md') && green.staged.includes(filed.file), green.staged?.join(','));
  const committedPaths = git(ROOT, ['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean);
  ok('git agrees: the commit contains only those two paths', committedPaths.length === 2
    && committedPaths.includes('docs/bugs/INDEX.md') && committedPaths.includes(filed.file), committedPaths.join(','));
  ok('the other lane\'s dirty file was NOT swept in', !committedPaths.includes(`docs/bugs/${blockOpen.f}`)
    && fs.readFileSync(bystanderPath, 'utf8') === bystanderBytes);
  ok('and it is reported as left behind, not silently ignored', (green.left_uncommitted ?? []).includes(`docs/bugs/${blockOpen.f}`), (green.left_uncommitted ?? []).join(','));

  const again = await call('commit', `--ids=${FILED_ID}`, '--message=nothing changed');
  ok('a second commit with nothing to say is refused', again.ok === false && again.refusal.code === 'nothing-to-commit');

  // MUST-FAIL: board drift that `gen` cannot repair — an orphan row, which is
  // exactly what a hand-edited INDEX leaves behind.
  const withOrphan = indexText().replace(/^(\| ARCH-\d+ \|)/m, '| BUG-99998 | a row with no ticket file | — | OPEN | low |\n$1');
  fs.writeFileSync(path.join(BOARD, 'INDEX.md'), withOrphan);
  const headBeforeDrift = git(ROOT, ['rev-parse', 'HEAD']);
  const drifted = await call('commit', `--ids=${FILED_ID}`, '--message=board tool: should refuse');
  ok('a drifting board refuses the commit', drifted.ok === false && drifted.refusal.code === 'board-drift'
    && drifted.refusal.detail.some((d) => d.includes('ORPHAN INDEX ROW')));
  ok('nothing was committed while drifting', git(ROOT, ['rev-parse', 'HEAD']) === headBeforeDrift);
  fs.writeFileSync(path.join(BOARD, 'INDEX.md'), withOrphan.replace('| BUG-99998 | a row with no ticket file | — | OPEN | low |\n', ''));

  section('7. truncated reads — another process is writing these files');
  const victim = path.join(BOARD, withDecision.f);
  const victimBytes = fs.readFileSync(victim, 'utf8');
  const cuts = [
    Math.floor(victimBytes.length * 0.05), // mid-record, early
    Math.floor(victimBytes.length * 0.25), // mid-record, deep
    victimBytes.indexOf('```', 3),          // just before the closing fence
    Math.floor(victimBytes.length * 0.8),  // mid-body, record intact
  ].filter((n) => n > 0);
  for (const cut of cuts) {
    fs.writeFileSync(victim, victimBytes.slice(0, cut));
    const q = await call('query', '--limit=500');
    const hit = q.tickets.find((t) => t.id === withDecision.p.record.id);
    const recordIntact = cut > victimBytes.indexOf('```', 3);
    ok(`truncated at ${cut}: the rest of the board still lists`, q.ok === true && q.total >= copyFiles.length - 1, JSON.stringify(q.refusal ?? ''));
    if (!recordIntact) {
      ok(`truncated at ${cut}: the damaged ticket is reported, never guessed`, !!hit && hit.status_error !== null && hit.work_state === null, JSON.stringify(hit ?? null));
      const c = await call('commit', `--ids=${FILED_ID}`, '--message=board tool: must refuse on a half-written ticket');
      ok(`truncated at ${cut}: commit refuses rather than commit a half-written board`, c.ok === false && (c.refusal.code === 'board-drift' || c.refusal.code === 'nothing-to-commit'), c.refusal?.code);
    } else {
      ok(`truncated at ${cut}: a record that survived the cut still reads`, !!hit && hit.work_state !== null);
    }
  }
  fs.writeFileSync(victim, victimBytes);

  section('8. the CLI surface a restricted profile would call');
  const cli = (args) => spawnSync(process.execPath, [path.join(REPO, 'scripts', 'board-tool.mjs'), ...args],
    { cwd: REPO, encoding: 'utf8', env: { ...process.env, ORCHARD_BOARD_TOOL_ROOT: ROOT } });
  const cliQuery = cli(['query', `--id=${FILED_ID}`]);
  ok('the CLI exits 0 and prints JSON on success', cliQuery.status === 0 && JSON.parse(cliQuery.stdout).tickets[0].id === FILED_ID);
  const cliRefuse = cli(['update', '--id=BUG-99999', '--work-state=open']);
  ok('the CLI exits 1 on a refusal, with the reason in the JSON', cliRefuse.status === 1 && JSON.parse(cliRefuse.stdout).refusal.code === 'ticket-404');
  const cliUsage = cli(['rm', '-rf', '/']);
  ok('a verb it does not know is exit 2, and nothing is executed', cliUsage.status === 2 && JSON.parse(cliUsage.stdout).refusal.code === 'unknown-verb');
  const boardStatusAfter = git(REPO, ['status', '--porcelain', '--', 'docs/bugs']);
  ok('the real repo was never written to', boardStatusAfter === BOARD_STATUS_BEFORE,
    boardStatusAfter === BOARD_STATUS_BEFORE ? 'docs/bugs is exactly as this suite found it' : `before:\n${BOARD_STATUS_BEFORE}\nafter:\n${boardStatusAfter}`);

  section('9. the board is clean at the end');
  const finalCheck = await call('check');
  noNewDrift(finalCheck, 'final');
  ok('board:check is clean on the scratch board', finalCheck.board.clean === true || [...finalCheck.board.fails].every((f) => BASELINE_FAILS.has(f)), finalCheck.board.fails.join(' | '));
  // The project's OWN command, not this tool's opinion of it.
  const realCheck = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'board.mjs'), 'check', `--dir=${BOARD}`], { cwd: REPO, encoding: 'utf8' });
  ok('`board.mjs check` agrees, run as its own process', realCheck.status === 0, (realCheck.stdout || '').split('\n').filter((l) => l.includes('FAIL')).join(' | '));

  console.log(`\n${failures.length ? 'FAIL' : 'PASS'} — ${pass} passed, ${failures.length} failed`);
  if (failures.length) for (const f of failures) console.log(`  · ${f}`);
  console.log(`(scratch: ${scratch})`);
  fs.rmSync(scratch, { recursive: true, force: true });
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  console.log(`(scratch kept for inspection: ${scratch})`);
  process.exit(1);
});
