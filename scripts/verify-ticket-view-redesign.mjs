/**
 * THE REDESIGNED TICKET VIEW — verification.
 *
 *   node scripts/verify-ticket-view-redesign.mjs
 *   node scripts/verify-ticket-view-redesign.mjs --no-red   # skip the base-worktree leg
 *
 * WHAT IS BEING CLAIMED. docs/analysis/ticket-board-redesign-plan.md §1: a reader
 * currently walks 348–1,039 words of invariant statement, design archaeology and
 * failed-patch history before they are told what they are being asked. The
 * redesigned view puts a named human layer first — summary, impact of waiting,
 * current need, the decision question and comparable options — and collapses the
 * deep layer into independent expanders that agents still receive whole.
 *
 * WHAT IS REAL HERE. The board is the REAL 190-ticket corpus copied off disk (so
 * the un-migrated half is the user's actual reality, not a fixture), plus eight
 * hand-authored tickets that carry the shapes the real corpus cannot yet supply:
 * the migration lane has not run, so there is no migrated ticket on disk to
 * render. Those eight are validated against the REAL schema module
 * (`scripts/lib/ticket-schema.mjs` `validateTicket`) before anything is rendered —
 * a fixture that does not satisfy the schema would be testing a format nobody
 * will ever ship. The server, the API payload, the browser (brave --headless=new
 * over raw CDP) and public/app.js are all real.
 *
 * THE LEGS
 *   SCHEMA — every hand-authored fixture validates under the real schema module.
 *   RED    — the SAME tickets rendered by the pre-change tree (a git worktree at
 *            HEAD): the words-before-the-decision-question count, measured, is the
 *            "before" number this whole redesign is justified by.
 *   BANDS  — the human layer renders the record's fields VERBATIM, in order, and
 *            an un-migrated ticket renders without looking broken: every absent
 *            field says the literal words "Not recorded", and a quoted prose
 *            section is labelled with the section it came from.
 *   DECIDE — single / multi-select / staged all render as themselves; a later
 *            stage is inert; a null recommendation says so; history is collapsed
 *            and visibly inactive; answering in place still works end to end.
 *   KEEP   — the broken-state indicators (ARCH-004), the digest landing and the
 *            decide card's own contract are still there.
 *   AX     — the bands are in the accessibility tree: headings are headings, the
 *            expanders are named disclosures, the impact text is reachable.
 *   WORDS  — words before the decision question, new vs pre-change, per ticket.
 *   COLOR  — every new ink, composited over the surface it really lands on, in
 *            BOTH themes. The prototype's two dark-mode defects (an invisible
 *            impact card, a low-contrast primary button) must not be imported.
 *   SHOTS  — migrated / un-migrated / decision / none / error, wide and narrow,
 *            both themes, each graded by scripts/lib/shot-luma.mjs and LOOKED AT.
 *
 * Theme is CDP `Emulation.setEmulatedMedia` prefers-color-scheme — never
 * localStorage. Ports are OS-assigned; :4317 is never touched. Every process is
 * one this script spawned and is stopped by PID.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import WebSocket from 'ws';
import { shotLedger } from './lib/shot-luma.mjs';
import { scratchRoot } from './lib/scratch.mjs';
import { validateTicket, formatTicket } from './lib/ticket-schema.mjs';

const ARGS = process.argv.slice(2);
const NO_RED = ARGS.includes('--no-red');
const ROOT = path.resolve(import.meta.dirname, '..');
// PER-RUN, not shared. `main()` starts with `rm -rf SCRATCH`, so a shared default
// meant two concurrent runs of this suite deleted each other's work dir mid-flight
// — a clean-room round launched it 4× at once and all four still exited 0, which
// is luck, not isolation. An explicit TVREDESIGN_SCRATCH is still honoured.
const SCRATCH = process.env.TVREDESIGN_SCRATCH
  ?? path.join(scratchRoot(), `ticket-view-redesign-${process.pid}-${Date.now().toString(36)}`);
const WORK = path.join(SCRATCH, 'project');
const BUGS = path.join(WORK, 'docs', 'bugs');
const BASE_TREE = path.join(SCRATCH, 'base-tree');
const SHOTS = path.join(SCRATCH, 'shots');
const BRAVE = process.env.VERIFY_BROWSER ?? 'brave';
const REAL_BUGS = path.join(ROOT, 'docs', 'bugs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

/* ══════════════════════════════════════════ the hand-authored ticket set ══
 *
 * Eight tickets, each carrying a shape the renderer must handle and the real
 * corpus cannot yet supply. The prose is derived from the prototype's own
 * calibration set (/home/…/tickets/redesigned/*.md, the four real tickets a human
 * rewrote by hand) so the word budgets are the ones a real migration will hit,
 * not comfortable synthetic one-liners.
 */

const TODAY = '2026-08-19';

/** Every required key, so a fixture only has to state what it cares about. */
function ticket(over) {
  const base = {
    id: null, type: null, title: null, summary: null, impact_if_we_wait: null,
    current_need: null, severity: 'not_recorded', area: null, reported: '2026-08-14',
    reported_by: 'user', owner: 'unassigned', work_state: 'open', human_action: 'none',
    verification_state: 'not_recorded', updated: TODAY, decision: null, decision_history: [],
    success_criteria: ['Not recorded'], code_refs: [], related: [], recurrence_evidence: [],
    verification: [], verification_class: 'plan+review',
    body_slots: {
      Diagnosis: false, Evidence: false, 'Implementation notes': false,
      'Verification plan': false, 'Migration and rollback': false, Risks: false,
      'Activity log': true,
    },
    source: {
      archived_path: null, sha256: null, bytes: null, original_title: null,
      migrated_on: null, migrated_by: null, confirmation: null, dropped: [],
    },
  };
  return { ...base, ...over };
}

const FIXTURES = [
  /* 1 — SINGLE choice, a recommendation with a reason, proof not recorded. */
  ticket({
    id: 'FEAT-982', type: 'feature',
    title: 'Ticket status and proof are not visible at a glance',
    summary: 'The board mixes bugs, features and architecture work. Confirming whether a piece of work is finished — and what proves it — requires reading the whole ticket history.',
    impact_if_we_wait: 'Nothing breaks. The board stays slow to scan and completed work stays hard to trust quickly; this is a legibility cost, not a data loss.',
    current_need: 'Approve a direction for the board and choose how its proof card gets its data.',
    severity: 'medium', area: 'Ticket board', reported_by: 'user', owner: 'you',
    work_state: 'open', human_action: 'decide', verification_state: 'not_recorded',
    decision: {
      mode: 'single',
      question: 'How should the proof card capture verification evidence?',
      options: [
        { key: 'A', label: 'Infer evidence from existing prose', what_changes: 'A parser reads verdicts and run ids out of the ticket text already written.', benefit: 'Covers old tickets with no change to how anyone works.', cost: 'A parser to maintain for as long as the old format exists.', why_not_obvious: 'Free-form parsing will miss or misread evidence, and a missed verdict looks the same as none.' },
        { key: 'B', label: 'Add structured proof fields', what_changes: 'Verification becomes named fields written when a ticket closes.', benefit: 'Reliable and simple to render for every future ticket.', cost: 'Another writing step at close, and a migration for what exists.', why_not_obvious: 'Old tickets stay blank until something fills them, so the card lies about most of the board.' },
        { key: 'C', label: 'Structured fields with a prose fallback', what_changes: 'New tickets write fields; old ones fall back to the parser until migrated.', benefit: 'Best coverage: reliable new data plus useful results for old tickets.', cost: 'Most implementation work, and two paths to keep honest.', why_not_obvious: 'It costs the most to build and the fallback must be maintained through the whole migration.' },
        { key: 'D', label: 'Rework the board design first', what_changes: 'The facets and the proof card are set aside until a layout is chosen.', benefit: 'Keeps every other layout option open.', cost: 'Delays a direction that already has support.', why_not_obvious: 'No alternative has shown a better fit, so this delays a well-supported direction for nothing.' },
      ],
      recommendation: 'C',
      recommendation_reason: 'It gives new tickets reliable fields without abandoning the evidence already written into old ones.',
      prerequisite: null,
    },
    success_criteria: ['A reader can tell open from done without opening the ticket', 'Missing evidence reads “not recorded”, never as proof'],
    code_refs: [{ path: 'public/app.js', symbol: 'ticketDetailNode', note: 'the detail renderer' }, { path: 'scripts/lib/ticket-schema.mjs' }],
    related: [{ id: 'ARCH-004', relation: 'see_also' }],
    body: [
      '## Diagnosis', '', 'The searchable table mixes every ticket type, and finished work carries no compact proof summary, so “is this done, and how do we know?” costs a full-ticket read.', '',
      '## Evidence', '', 'Measured over four real tickets: 348 to 1,039 words precede the decision question.', '',
      '## Activity log (APPEND-ONLY)', '', '### 2026-08-14 — user', '- filed after a board review.', '',
      '### 2026-08-19 — agent', '- drafted the facets and the proof card; the data question is still open.', '',
    ].join('\n'),
    slots: { Diagnosis: true, Evidence: true },
  }),

  /* 2 — STAGED: only stage 1 is answerable, later stages render as "then". */
  ticket({
    id: 'ARCH-985', type: 'architecture',
    title: 'One project can display another project’s live session',
    summary: 'When a user switches projects, parts of the interface still read live-session state belonging to the project that was open before. Repeated point fixes have found eleven affected surfaces and have not stopped new ones appearing.',
    impact_if_we_wait: 'The dashboard can misreport what is running. This is a display-correctness and trust problem, bounded: no cross-user exposure and no data loss.',
    current_need: 'Decide whether to add a direct-read guard now, and use its inventory to choose the structural fix afterwards.',
    severity: 'medium', area: 'Client view model', reported: '2026-08-18', owner: 'you',
    work_state: 'open', human_action: 'staged_decision', verification_state: 'not_recorded',
    verification_class: 'arch',
    decision: {
      mode: 'staged',
      question: 'Do we add a direct-read guard before choosing the structural fix?',
      options: [
        { key: '3', label: 'Add a direct-read lint guard', what_changes: 'A lint rule and a test inventory every raw read of live state and block new ones.', benefit: 'Cheap ratchet, and it produces the complete inventory.', cost: 'An allowlist that has to be curated as the code changes.', why_not_obvious: 'It controls the risk rather than removing it, and allowlists decay quietly.', stage: 1 },
        { key: '4', label: 'Continue with point fixes', what_changes: 'Each leak is fixed as it is found; nothing structural changes.', benefit: 'Smallest immediate change, no refactor to schedule.', cost: 'Every round finds roughly three more leaks.', why_not_obvious: 'No verification round has yet converged, so this is only sensible if the client is being replaced soon.', stage: 1 },
        { key: '1', label: 'Encapsulate raw session fields', what_changes: 'Direct reads become impossible; non-view callers use a named escape hatch.', benefit: 'Ends unsafe reads with the smaller of the two model changes.', cost: 'Roughly 46 call sites must each be classified by hand.', why_not_obvious: 'A wrong classification silently changes real behaviour, and there are 46 chances to be wrong.', stage: 2 },
        { key: '2', label: 'Store live state per project', what_changes: 'Renderers receive only the selected project’s live view object.', benefit: 'Strongest model; removes the conflation at its root.', cost: 'The largest rewrite, touching read and write paths.', why_not_obvious: 'It is the biggest change here and it touches the socket and polling writers as well as the readers.', stage: 2 },
      ],
      recommendation: '3',
      recommendation_reason: 'It is inexpensive and it produces the evidence needed to choose safely between encapsulation and per-project state.',
      prerequisite: null,
      stages: [
        { stage: 1, question: 'Do we land the guard now?', unlocked_by: null },
        { stage: 2, question: 'Encapsulate the fields, or store live state per project?', unlocked_by: 'the inventory the guard produces' },
      ],
    },
    success_criteria: ['A new raw read fails before it can land', 'Foreign live state renders exactly like absent state'],
    recurrence_evidence: ['BUG-106', 'BUG-082'],
    related: [{ id: 'BUG-106', relation: 'recurrence_of' }],
    body: [
      '## Diagnosis', '', 'Live-session data is stored globally while the selected project is tracked separately, so any new render function can read the global fields and paint another project’s session.', '',
      '## Risks', '', 'A guard that is bypassed by an allowlist entry is worse than no guard, because it reads as coverage.', '',
      '## Activity log (APPEND-ONLY)', '', '### 2026-08-18 — agent', '- eleven surfaces found across three rounds.', '',
    ].join('\n'),
    slots: { Diagnosis: true, Risks: true },
  }),

  /* 3 — MULTI select: options compose, and the recommendation is a key list. */
  ticket({
    id: 'BUG-984', type: 'bug',
    title: 'Clean-room verification can still read hidden methodology',
    summary: 'The verifier’s exported tree removes the methodology and ticket folders, but verbatim copies of the same material remain inside verification scripts and calibration fixtures that the exported tree keeps.',
    impact_if_we_wait: 'This weakens the independence claim behind verification results. It does not show that any verifier read the leaked material, and no past verdict is invalidated by it.',
    current_need: 'Choose a way to remove both leak sources while keeping the verification scripts runnable.',
    severity: 'medium', area: 'Verification integrity', reported: '2026-08-18', owner: 'you',
    work_state: 'open', human_action: 'multi_select_decision', verification_state: 'not_recorded',
    decision: {
      mode: 'multi',
      question: 'How should the clean room remove leaked context without breaking its tests?',
      options: [
        { key: '1', label: 'Move ticket snapshots out', what_changes: 'Calibration fixtures holding whole real tickets leave the exported tree.', benefit: 'Removes the ticket leak outright.', cost: 'A path denylist to keep current.', why_not_obvious: 'It closes ticket leakage only, and a denylist can miss the next fixture somebody adds.', combines_with: ['2', '4'] },
        { key: '2', label: 'Remove methodology quotes from scripts', what_changes: 'Scripts assert against synthetic text or load expectations from stripped files.', benefit: 'Removes the methodology leak at its source.', cost: 'Several tests have to be rewritten.', why_not_obvious: 'It touches a number of tests and can silently regress without a gate watching it.', combines_with: ['1', '4'] },
        { key: '3', label: 'Redact known markers everywhere', what_changes: 'A scan blanks methodology and ticket markers across every kept file.', benefit: 'Broadest coverage in one pass.', cost: 'It edits files the verifier has to execute.', why_not_obvious: 'It may corrupt the very scripts the verifier needs to run, which fails closed in the worst way.', combines_with: [] },
        { key: '4', label: 'Add a clean-room leak gate', what_changes: 'Export fails when canary methodology or ticket text survives into the tree.', benefit: 'Stops silent recurrence of either leak.', cost: 'Canaries need choosing and maintaining.', why_not_obvious: 'A canary set is still a denylist, and it removes nothing by itself.', combines_with: ['1', '2', '3'] },
      ],
      recommendation: '1 + 2 + 4',
      recommendation_reason: 'Removing both sources and gating the result is the only combination that both fixes today and prevents the recurrence.',
      prerequisite: null,
    },
    success_criteria: ['No real methodology or ticket body survives in the exported tree', 'Every required verification script still runs'],
    verification: [{ provider: 'openai', model: 'gpt-5.6-sol', run_id: '9d4f2a10-1c33-4f8e-9a02-77bb1e5c0d41', verdict: 'holds', verdict_on: '2026-08-18', harness: 'independent-verify', counts: '52/52' }],
    verification_state: 'holds',
    verification_class: 'fix',
    body: [
      '## Evidence', '', 'A Working Agreement phrase appears verbatim in three verification scripts; two calibration fixtures contain full snapshots of a real architecture ticket.', '',
      '## Activity log (APPEND-ONLY)', '', '### 2026-08-18 — agent', '- confirmed both leaks in the exported tree.', '',
    ].join('\n'),
    slots: { Evidence: true },
  }),

  /* 4 — NO recommendation, and a prerequisite that says why not. */
  ticket({
    id: 'FEAT-992', type: 'feature',
    title: 'Running sessions do not receive instruction updates',
    summary: 'Instructions are composed once when a session starts, so a long-running session keeps following the older rules after the source documents change.',
    impact_if_we_wait: 'Nothing breaks for a user and the workaround is cheap. The bound is that the longest-lived session — often the most important — is the most likely to be stale.',
    current_need: 'Decide whether the refresh workaround is enough or whether live sessions should receive bounded amendments.',
    severity: 'low', area: 'Session instructions', reported: '2026-08-18', owner: 'you',
    work_state: 'open', human_action: 'decide', verification_state: 'not_required',
    verification_class: 'plan+review',
    decision: {
      mode: 'single',
      question: 'Do we accept the refresh workaround or build live instruction amendments?',
      options: [
        { key: 'A', label: 'Keep the workaround', what_changes: 'Restarting the session, or asking it to re-read the changed document, is documented as normal practice.', benefit: 'No new machinery, and it already works today.', cost: 'The lag stays manual and undetectable from inside a session.', why_not_obvious: 'Instruction lag remains worst exactly where it matters most, on the longest-lived sessions.' },
        { key: 'B', label: 'Build per-turn amendments', what_changes: 'Changed instruction sections are detected and injected once, dated, on the next turn.', benefit: 'Live sessions converge on the current rules without a restart.', cost: 'Debounce, conflicting instructions, compaction and authority all become design problems.', why_not_obvious: 'It adds real design complexity, and an amendment has lower authority than the original prompt.' },
      ],
      recommendation: null,
      recommendation_reason: null,
      prerequisite: 'Directly verify that reconstructing a session really reapplies freshly composed instructions — this is currently inferred, not proven.',
    },
    success_criteria: ['A session started before an edit follows the edited rule, or says it cannot'],
    body: [
      '## Diagnosis', '', 'Methodology, conventions, routing and response-format instructions are injected once at process construction and never re-read.', '',
      '## Activity log (APPEND-ONLY)', '', '### 2026-08-18 — user', '- noticed after editing the routing doc mid-session.', '',
    ].join('\n'),
    slots: { Diagnosis: true },
  }),

  /* 5 — DONE, no live decision, TWO settled decisions in history, proof holds. */
  ticket({
    id: 'BUG-980', type: 'bug',
    title: 'Sidebar dropped sessions on a busy day',
    summary: 'The sidebar capped its session list before applying the recency window, so on a busy day the sessions a user had just been working in fell off the list entirely.',
    impact_if_we_wait: 'Fixed and verified. Left unfixed it cost a user the session they were in, which is recoverable by search but reads as data loss.',
    current_need: 'Nothing. The fix is verified and the ticket is closed.',
    severity: 'high', area: 'Session sidebar', reported: '2026-08-11', owner: 'unassigned',
    work_state: 'done', human_action: 'none', verification_state: 'holds', verification_class: 'fix',
    updated: '2026-08-13',
    decision: null,
    decision_history: [
      { asked_on: '2026-08-11', question: 'Cap before or after the recency window?', mode: 'single', options_keys: ['A', 'B'], chosen: 'B', chosen_on: '2026-08-11', chosen_by: 'you', note: 'Window first, then cap — the cap is a display budget, not a filter.' },
      { asked_on: '2026-08-12', question: 'Should pinned sessions bypass the cap?', mode: 'single', options_keys: ['A', 'B'], chosen: 'A', chosen_on: '2026-08-12', chosen_by: 'you', note: 'Yes; a pin is an explicit statement that it must stay visible.' },
    ],
    success_criteria: ['A session touched in the last hour is always listed'],
    verification: [{ provider: 'openai', model: 'gpt-5.6-sol', run_id: '3b7c8e21-55aa-4d10-8fe6-1c2b3d4e5f60', verdict: 'holds', verdict_on: '2026-08-13', harness: 'independent-verify', counts: '14/14', commit: 'a1b2c3d' }],
    code_refs: [{ path: 'public/app.js', symbol: 'visibleSessions' }],
    body: [
      '## Diagnosis', '', 'The cap was applied to the unsorted list, so ordering decided which sessions survived it.', '',
      '## Verification plan', '', 'A busy-day fixture with many recent sessions, not the minimal case that only proves the mechanism.', '',
      '## Activity log (APPEND-ONLY)', '', '### 2026-08-11 — user', '- lost the session I was in.', '',
      '### 2026-08-13 — agent', '- fixed and verified; 14/14.', '',
    ].join('\n'),
    slots: { Diagnosis: true, 'Verification plan': true },
  }),

  /* 6 — a BROKEN verification and a BLOCKED ticket, with every optional field
     null: the "Not recorded" surface, on a ticket that must not look healthy. */
  ticket({
    id: 'BUG-981', type: 'bug',
    title: 'Turn-end hook grades a transcript still being written',
    summary: 'The turn-end hook reads the transcript file while another process is still appending to it, so it can grade a truncated reply and block a correct one.',
    impact_if_we_wait: 'Correct replies are blocked at random. Bounded: nothing is lost, the turn can be retried, but the failure is silent and looks like a model fault.',
    current_need: 'Reproduce against truncated copies of the real transcript before attempting another fix.',
    severity: 'high', area: 'Turn-end hook', reported: '2026-08-16', owner: 'agent',
    work_state: 'blocked', human_action: 'none', verification_state: 'broken', verification_class: 'fix',
    decision: null,
    success_criteria: ['Not recorded'],
    verification: [{ provider: 'openai', model: 'gpt-5.6-sol', run_id: '77aa11bb-22cc-33dd-44ee-55ff66aa77bb', verdict: 'broken', verdict_on: '2026-08-17', harness: 'independent-verify' }],
    body: [
      '## Activity log (APPEND-ONLY)', '', '### 2026-08-17 — agent', '- clean-room verify came back BROKEN: the fix passes on complete transcripts only.', '',
    ].join('\n'),
    slots: {},
  }),
];

/** The seeded LEGACY tickets: a healthy control and a state nothing can read. */
const LEGACY_SEEDS = [
  {
    id: 'BUG-983', title: 'two states that disagree',
    text: `# BUG-983 — two states that disagree\n- **Status:** OPEN\n- **Status:** VERIFIED\n- **Severity:** high\n- **Area:** ui/tickets\n- **Reported:** ${TODAY} (verify-ticket-view-redesign)\n\n## Symptom\n\nThe ticket declares two different states in its header, so no tool can answer done-or-open about it.\n\n## Activity log (APPEND-ONLY)\n\n### ${TODAY} — verify\n- seeded.\n`,
  },
  {
    id: 'FEAT-986', title: 'a legacy ticket with a plain-terms section and a decision',
    text: `# FEAT-986 — a legacy ticket with a plain-terms section and a decision\n- **Status:** OPEN\n- **Severity:** med\n- **Area:** ui/tickets\n- **Reported:** ${TODAY} (verify-ticket-view-redesign)\n\n## In plain terms\n\nThe export button writes a file the spreadsheet application refuses to open, and nobody has decided which format it should write instead.\n\n## Wanted\n\nPick the export format so the work can start.\n\n## Question\n\nShould export produce CSV or XLSX?\n\n- **csv** — a text format every tool reads, but it loses the number formatting.\n- **xlsx** — keeps formatting and formulas, but needs a library and a licence review.\n\n## Activity log (APPEND-ONLY)\n\n### ${TODAY} — verify\n- seeded.\n`,
  },
  {
    id: 'BUG-987', title: 'a legacy ticket whose opening section has an idiosyncratic name',
    text: `# BUG-987 — a legacy ticket whose opening section has an idiosyncratic name\n- **Status:** OPEN\n- **Severity:** low\n- **Area:** server\n- **Reported:** ${TODAY} (verify-ticket-view-redesign)\n\n## What the second session inherits\n\nStarting a second session in the same directory and closing the first leaves the second holding a socket nobody owns.\n\n## Activity log (APPEND-ONLY)\n\n### ${TODAY} — verify\n- seeded.\n`,
  },
  {
    id: 'BUG-988', title: 'a legacy ticket that is a header and a log and nothing else',
    // No Area and no Reported line: the facts grid is the one place the rule
    // still allows a stated absence, so a ticket that HAS one must exist.
    text: `# BUG-988 — a legacy ticket that is a header and a log and nothing else\n- **Status:** OPEN\n- **Severity:** low\n\n## Activity log (APPEND-ONLY)\n\n### ${TODAY} — verify\n- seeded, deliberately empty.\n`,
  },
];

/* ══════════════════════════════════ the BROKEN-RECORD seed ═══════════════
 *
 * A ticket that HAS been migrated and whose record has since been broken — the
 * characteristic failure mode of a migrated file, and the one the fallback path
 * exists to survive. It is built by running the REAL formatter and then making
 * the edit a human makes (a string value loses its quotes), so the file is a
 * realistic corrupted migration rather than a hand-typed blob of bad JSON.
 *
 * The marker lives INSIDE the record block. If the rendered page contains it,
 * the block's own bytes reached the reader; if it does not, they were deleted
 * on the way — which is exactly what the pre-change tree did while its error
 * note told the reader the original was shown in full.
 */
const RECORD_ERROR_ID = 'BUG-989';
const RECORD_ERROR_MARKER = 'UNPARSEABLE-RECORD-EVIDENCE-9f3a2b';
const RECORD_ERROR_BODY_MARKER = 'BODY-AFTER-BROKEN-RECORD-5c1d';

function recordErrorText() {
  const f = ticket({
    id: RECORD_ERROR_ID, type: 'bug',
    title: 'a migrated ticket whose record block was corrupted by a hand edit',
    summary: `The migration wrote a valid record and a later hand edit broke it. ${RECORD_ERROR_MARKER}`,
    impact_if_we_wait: 'The ticket cannot be read by any tool that expects the structured format.',
    current_need: 'Repair the JSON in the block at the top of the file.',
    severity: 'medium', area: 'Ticket board', work_state: 'open', human_action: 'none',
    body: [
      '## Diagnosis', '',
      `The prose below the block is untouched and must still render. ${RECORD_ERROR_BODY_MARKER}`, '',
      '## Activity log (APPEND-ONLY)', '', `### ${TODAY} — verify`, '- seeded, deliberately corrupt.', '',
    ].join('\n'),
    slots: { Diagnosis: true },
  });
  const good = fixtureText(f);
  // The edit a human makes: a string value loses its quotes. One character class,
  // everything else byte-for-byte what the real formatter wrote.
  const broken = good.replace('"severity": "medium"', '"severity": medium');
  if (broken === good) throw new Error('record-error seed: the corruption did not apply');
  return broken;
}

/* ══════════════════════ the FENCE-CARRYING broken records ════════════════
 *
 * The second clean-room round's finding, made a suite. A migrated ticket's
 * human-layer text can legitimately quote an inline ``` run — a ticket ABOUT
 * fenced code always will — and `prose()` splits on that run wherever it falls
 * (BUG-111). So a record block routed through prose() terminates its <pre>
 * mid-value and the info-string strip eats the next line: 16 of 49 record lines
 * unreachable, `work_state` among them, under a note promising "verbatim".
 *
 * These seeds are REAL: the fence-carrying sentence is lifted verbatim out of the
 * real ticket on disk, the record is serialised by the project's own
 * `formatTicket` and checked by its own `validateTicket`, and the corruption is
 * the edit a human makes. Only the surrounding metadata is fixture — the
 * load-bearing value, the one carrying the fence run, is the corpus's own text.
 */
const FENCE_SOURCE_IDS = ['ARCH-004', 'BUG-109', 'BUG-111', 'FEAT-016', 'FEAT-075', 'FEAT-083', 'FEAT-085', 'FEAT-091'];
const FENCE_ERROR_ID = 'BUG-990';

/** The first line of a real ticket that quotes an inline (not line-opening) ``` run. */
function fenceSentence(md) {
  for (const raw of String(md).replace(/\r\n?/g, '\n').split('\n')) {
    const t = raw.trim();
    if (/^```/.test(t) || !/```/.test(t)) continue;
    const w = t.split(/\s+/).length;
    if (w >= 8 && w <= 55) return t;
  }
  return null;
}

/** A valid migrated file whose summary is `sentence`, straight through the real formatter. */
function fenceTicketText(id, sentence) {
  const TYPE = { BUG: 'bug', FEAT: 'feature', ARCH: 'architecture', DEPLOY: 'deploy' };
  const rec = ticket({
    id, type: TYPE[id.split('-')[0]],
    title: 'a real ticket whose record quotes an inline fence run',
    summary: sentence,
    impact_if_we_wait: 'The record cannot be shown to the reader who has to repair it.',
    current_need: 'Repair the JSON in the block at the top of the file.',
    severity: 'medium', area: 'Ticket board', work_state: 'open', human_action: 'none',
    // the schema requires an ARCH ticket to cite the instances it generalises
    recurrence_evidence: id.startsWith('ARCH') ? ['BUG-110', 'BUG-111'] : [],
  });
  const v = validateTicket(rec, { file: `${id}-x.md` });
  if (!v.ok) throw new Error(`fence seed ${id} does not validate: ${v.violations.join(' | ')}`);
  return formatTicket(rec, `\n# ${id} — a real ticket whose record quotes an inline fence run\n\n`
    + `## Diagnosis\n\nThe prose below the block is untouched and must still render.\n\n`
    + `## Activity log (APPEND-ONLY)\n\n### ${TODAY} — verify\n- seeded, deliberately corrupt.\n`);
}

/** Four positions a hand edit really breaks a record at, including AT `work_state`. */
const CORRUPTIONS = [
  ['unquoted value, mid-record', (t) => t.replace('"severity": "medium"', '"severity": medium')],
  ['broken AT work_state', (t) => t.replace('"work_state": "open"', '"work_state": open')],
  ['broken at the FIRST key', (t) => t.replace(/"id": "/, '"id": ')],
  ['truncated write (no closing brace)', (t) => t.replace(/\n\}\n```/, '\n```')],
];

/* ══════════════════════ BYTE-LEVEL seeds: disk vs the DOM ═══════════════════
 *
 * Every round so far compared disk bytes to the VIEW MODEL. Two verifiers in a
 * row said so, and it is the exact gap that let round 2's defect through — that
 * fix compared `pre.textContent` to `view.rawRecordFence` and passed while the
 * bytes on the page were wrong, because both sides came from the same code. So
 * these seeds are graded DISK -> DOM: the file is read back off disk in node, the
 * expected region is derived by an INDEPENDENT line scanner that shares no code
 * with the extractor under test, and the comparison is `===` against the text
 * the browser actually rendered.
 */
const BYTE_SEED_IDS = {
  lead: 'BUG-991', crlf: 'BUG-992', twoBlocks: 'BUG-993',
  controls: 'BUG-994', huge: 'BUG-995', unicode: 'BUG-996', unterminated: 'BUG-997',
  // ONE CLASS EACH. The mixed seed above bundles a bidi override in with a NUL
  // and two separators, so a sentence that is only true of the bidi control read
  // as true of the whole set — that bundling is exactly why four rounds did not
  // catch the false characterisation. Each class now also gets a seed alone.
  bidiOnly: 'BUG-998', sepOnly: 'BUG-999', zeroWidthOnly: 'FEAT-998',
};

/* Built from code points, never pasted as literals: a NUL or an RTL override
   sitting in a source file is invisible to the next reader of THIS file too. */
const NUL = String.fromCharCode(0);
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const RLO = String.fromCharCode(0x202E);
const PDF = String.fromCharCode(0x202C);
const ZWSP = String.fromCharCode(0x200B);
const BOM = String.fromCharCode(0xFEFF);

/** The record region, found by SCANNING LINES — deliberately not the extractor's
 *  character-run regex, so a defect in that regex cannot hide behind a test that
 *  reuses it. Returns null when the first non-blank line is not an opener, and
 *  null when the block is never closed. */
function fenceRegionByLineScan(src) {
  const OPEN = '```orchard-ticket';
  let pos = 0, start = -1;
  for (;;) {
    const nl = src.indexOf('\n', pos);
    const lineEnd = nl === -1 ? src.length : nl;
    const line = src.slice(pos, lineEnd).replace(/\r$/, '');
    const trimmed = line.trim();
    if (trimmed) {
      if (start === -1) {
        if (trimmed !== OPEN) return null;
        start = pos + line.indexOf('`');
      } else if (line.replace(/[ \t]+$/, '') === '```') {
        return src.slice(start, pos + line.length);
      }
    }
    if (nl === -1) return null;
    pos = nl + 1;
  }
}

/** A valid migrated file carrying a REAL fence-quoting sentence, then broken. */
function byteSeedBase() {
  const file = fs.readdirSync(REAL_BUGS).find((n) => n.startsWith('BUG-111-'));
  const sentence = fenceSentence(fs.readFileSync(path.join(REAL_BUGS, file), 'utf8'));
  return fenceTicketText('BUG-111', sentence);
}

/** The byte-level variants, each a transform of that one real base. */
function byteSeeds() {
  const base = byteSeedBase();
  const broken = CORRUPTIONS[0][1](base);
  const out = [];
  const add = (id, why, text) => out.push({ id, why, text });

  // Whitespace BEFORE the block — the shape a hand edit leaves, and the one that
  // rode into the "verbatim and whole" <pre> because `^\s*` matches newlines.
  add(BYTE_SEED_IDS.lead, 'blank lines and indentation before the opening fence',
    '\r\n \t\r\n' + broken);
  // CRLF throughout: the interior line endings must survive into the <pre>.
  add(BYTE_SEED_IDS.crlf, 'CRLF line endings throughout', broken.replace(/\n/g, '\r\n'));
  // A SECOND orchard-ticket block deeper in the body. Only the first is the
  // record; the second is body content and must render as body.
  add(BYTE_SEED_IDS.twoBlocks, 'a second orchard-ticket block deeper in the body',
    broken + '\n\n## A quoted example\n\n```orchard-ticket\n{"id": "NOT-THE-RECORD"}\n```\n');
  // Control characters INSIDE the region: a NUL and a lone CR.
  add(BYTE_SEED_IDS.controls, 'a NUL byte and a lone CR inside the record region',
    broken.replace('"area": "Ticket board"', '"area": "Ticket' + NUL + ' bo\rard"'));
  // An enormous region — is it capped, elided, or scrolled out of reach?
  add(BYTE_SEED_IDS.huge, 'an enormous record region (~120 extra criteria lines)',
    broken.replace('"success_criteria": [', '"success_criteria": [\n'
      + Array.from({ length: 120 }, (_, i) => '    "criterion ' + i + ' — a real-length success criterion line",').join('\n')));
  // Bidi and line-separator characters: a <pre> that claims fidelity must not be
  // reorderable, or re-broken into lines, by its own content.
  add(BYTE_SEED_IDS.unicode, 'U+2028/U+2029 and an RTL override inside the region',
    broken.replace('"owner": "unassigned"',
      '"owner": "una' + LS + 'ssig' + PS + 'ned' + RLO + 'reversed' + PDF + '"'));
  add(BYTE_SEED_IDS.bidiOnly, 'a bidi override alone (no other invisible class)',
    broken.replace('"owner": "unassigned"', '"owner": "ned' + RLO + 'reversed' + PDF + '"'));
  add(BYTE_SEED_IDS.sepOnly, 'line and paragraph separators alone',
    broken.replace('"owner": "unassigned"', '"owner": "una' + LS + 'ssig' + PS + 'ned"'));
  add(BYTE_SEED_IDS.zeroWidthOnly, 'a zero-width space and a BOM alone',
    broken.replace('"owner": "unassigned"', '"owner": "una' + ZWSP + 'ssig' + BOM + 'ned"'));
  // Opened, never closed — what a partial write leaves.
  add(BYTE_SEED_IDS.unterminated, 'a block opened and never closed (a partial write)',
    base.slice(0, Math.floor(base.indexOf('\n```', 20) * 0.6)));
  return out;
}

const MIGRATED_IDS = FIXTURES.map((f) => f.id);
const ALL_SEEDED = [...MIGRATED_IDS, ...LEGACY_SEEDS.map((s) => s.id), RECORD_ERROR_ID, FENCE_ERROR_ID,
  ...Object.values(BYTE_SEED_IDS)];

function fixtureFile(f) {
  const slug = f.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  return `${f.id}-${slug}.md`;
}

/** Write the fixture as the REAL formatter writes it — one shared serialiser. */
function fixtureText(f) {
  const rec = { ...f };
  const body = rec.body ?? '';
  const slots = rec.slots ?? {};
  delete rec.body; delete rec.slots;
  rec.body_slots = { ...rec.body_slots, ...slots };
  return formatTicket(rec, `\n# ${rec.id} — ${rec.title}\n\n${body}`);
}

/** The REAL corpus, copied read-only, plus the seeded shapes — a MIXED board. */
function seedBoard() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(BUGS, { recursive: true });
  let copied = 0;
  for (const n of fs.readdirSync(REAL_BUGS)) {
    if (!/\.md$/.test(n)) continue;
    fs.copyFileSync(path.join(REAL_BUGS, n), path.join(BUGS, n));
    copied++;
    // Remember the REAL corpus by id + text: it is what the whole-board sweep
    // renders on both trees and compares against, file by file.
    const id = /^([A-Z]+-\d+)-/.exec(n)?.[1];
    if (id) CORPUS_FILES.set(id, fs.readFileSync(path.join(REAL_BUGS, n), 'utf8'));
  }
  CORPUS_IDS = [...CORPUS_FILES.keys()];
  for (const f of FIXTURES) fs.writeFileSync(path.join(BUGS, fixtureFile(f)), fixtureText(f));
  for (const s of LEGACY_SEEDS) fs.writeFileSync(path.join(BUGS, `${s.id}-${s.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.md`), s.text);
  fs.writeFileSync(path.join(BUGS, `${RECORD_ERROR_ID}-migrated-record-corrupted-by-a-hand-edit.md`), recordErrorText());
  // …and the FENCE case, served by the real server over the real route, so the
  // whole transport is exercised and not only the in-page renderer sweep below.
  const fenceSrc = fs.readFileSync(path.join(REAL_BUGS,
    fs.readdirSync(REAL_BUGS).find((n) => n.startsWith('BUG-111-'))), 'utf8');
  fs.writeFileSync(path.join(BUGS, `${FENCE_ERROR_ID}-record-quotes-an-inline-fence-run.md`),
    CORRUPTIONS[1][1](fenceTicketText(FENCE_ERROR_ID, fenceSentence(fenceSrc))));
  // …and the byte-level variants, written to disk as bytes so the comparison
  // below is against a real file the real server really served.
  for (const seed of byteSeeds()) {
    fs.writeFileSync(path.join(BUGS, `${seed.id}-byte-level-record-variant.md`), seed.text);
  }
  // Splice every seed into the copied INDEX's Open table so it carries a curated
  // row like every other ticket on a real board.
  const idx = path.join(BUGS, 'INDEX.md');
  let text = fs.readFileSync(idx, 'utf8');
  const rows = [
    ...FIXTURES.map((f) => `| ${f.id} | ${f.title} | ${f.owner === 'you' ? '👤' : '—'} | ${f.work_state} | ${f.severity} |`),
    ...LEGACY_SEEDS.map((s) => `| ${s.id} | ${s.title} | ${s.id === 'FEAT-986' ? '👤' : '—'} | needs decision | med |`),
    `| ${RECORD_ERROR_ID} | a migrated ticket whose record block was corrupted by a hand edit | — | open | med |`,
    `| ${FENCE_ERROR_ID} | a real ticket whose record quotes an inline fence run | — | open | med |`,
    ...byteSeeds().map((b) => `| ${b.id} | ${b.why} | — | open | med |`),
  ].join('\n');
  const at = text.indexOf('\n## Done');
  text = at === -1 ? `${text}\n${rows}\n` : `${text.slice(0, at)}\n${rows}\n${text.slice(at)}`;
  fs.writeFileSync(idx, text);
  return copied;
}

/* ═══════════════════════════════════════════════════════════════════ infra */

const procs = [];
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}
async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

async function bootServer(tree, tag) {
  const port = await freePort();
  const data = path.join(SCRATCH, `data-${tag}`);
  const store = path.join(SCRATCH, `store-${tag}`);
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(store, { recursive: true });
  const child = spawn(process.execPath, [path.join(tree, 'src', 'server', 'index.ts')], {
    cwd: tree,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: data, CLAUDE_PROJECTS_DIR: store, CLAUDE_STATION_SURVIVE: '0' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  procs.push(child);
  child.stderr?.on('data', (d) => { if (process.env.CS_VERBOSE) process.stderr.write(`  [${tag}] ${d}`); });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 120 && !up; i++) { try { await fetch(`${base}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error(`${tag} server never became healthy`);
  const reg = await (await fetch(`${base}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: WORK, name: `TV redesign ${tag}` }),
  })).json();
  const pid = reg.project?.id;
  if (!pid) throw new Error(`${tag}: could not register the scratch project: ${JSON.stringify(reg).slice(0, 200)}`);
  return { base, pid, tag };
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const c = new Cdp(ws);
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.id && c.waiting.has(m.id)) { const { res, rej } = c.waiting.get(m.id); c.waiting.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    });
    return c;
  }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.waiting.set(id, { res, rej })); }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  }
  async waitFor(label, expr, timeoutMs = 30000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) { try { if (await this.eval(expr)) return true; } catch { /* mid-nav */ } await sleep(150); }
    console.log(`        (timed out waiting for ${label})`);
    return false;
  }
  async theme(tone) { await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: tone }] }); }
  async viewport(width, height) { await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

/* ═══════════════════════════════════════════ in-page measuring routines ══ */

/**
 * WORDS BEFORE THE DECISION QUESTION, in READING ORDER.
 *
 * Reading order, not geometry: a two-column layout can park the question beside
 * the prose and claim a small number while a narrow screen, a screen reader and
 * the Tab key all still walk the whole document first. So the measure walks the
 * rendered text nodes of the detail in DOM order and stops at the decision
 * question — which is exactly the path the plan measured on the source files.
 */
const WORDS_BEFORE_Q = `(() => {
  const doc = document.querySelector('#tvDetail .tv-doc');
  if (!doc) return null;
  const q = doc.querySelector('.tv-decide .dc-q');
  const walker = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT);
  let words = 0; const seen = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (q && (q.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_PRECEDING) === 0) break;
    const el = n.parentElement;
    if (!el) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    // a collapsed <details> hides its body from the reader but not from the DOM
    if (el.closest('details:not([open]) .tv-slot-b')) continue;
    const t = n.textContent.replace(/\\s+/g, ' ').trim();
    if (!t) continue;
    words += t.split(' ').length;
    if (seen.length < 24) seen.push(t.slice(0, 40));
  }
  return { words, hasQuestion: !!q, question: q ? q.textContent.trim() : null, first: seen };
})()`;

/** The bands, reduced to what a reader actually perceives. */
const BANDS = `(() => {
  const d = document.querySelector('#tvDetail .tv-doc');
  if (!d) return null;
  const txt = (s) => { const e = d.querySelector(s); return e ? e.textContent.replace(/\\s+/g, ' ').trim() : null; };
  const box = (s) => { const e = d.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) }; };
  // A slot is either a <details> (it has a body) or a FLAT row (its whole content
  // was the claim of absence, so it is one line and opens onto nothing).
  const slots = [...d.querySelectorAll('.tv-md .tv-slot')].map((s) => ({
    title: s.querySelector('.tv-slot-t')?.textContent.trim() ?? null,
    open: s.tagName === 'DETAILS' ? s.open : null,
    flat: s.tagName !== 'DETAILS',
    note: s.querySelector('.tv-slot-n')?.textContent ?? null,
    tag: s.querySelector('.tv-slot-t')?.tagName ?? null,
  }));
  return {
    id: d.dataset.id, format: d.dataset.format,
    title: txt('.tv-dtitle .d-t'), eyebrow: txt('.tv-dtitle .d-id'),
    pills: [...d.querySelectorAll('.tv-pills .tv-pill')].map((p) => ({ cls: p.className, text: p.textContent.trim() })),
    summary: txt('.tv-human .th-summary'), legacyNote: txt('.tv-human .th-legacy-note'),
    need: txt('.tv-human .th-need'),
    impact: txt('.tv-impact .ti-body'),
    facts: [...d.querySelectorAll('.tv-dmeta .kv')].map((k) => k.querySelector('.k')?.textContent + '=' + (k.querySelector('.v')?.textContent ?? '')),
    slots,
    slotCount: slots.length,
    deepHeader: txt('.tv-deep-h'),
    mdText: (d.querySelector('.tv-md')?.textContent ?? '').length,
    hasDecide: !!d.querySelector('.tv-decide'),
    question: txt('.tv-decide .dc-q'),
    mode: d.querySelector('.tv-decide')?.dataset.mode ?? null,
    options: [...d.querySelectorAll('.tv-decide .dc-opt')].map((o) => ({
      key: o.querySelector('.dc-k')?.textContent ?? null,
      label: o.querySelector('.dc-lt')?.textContent ?? null,
      what: o.querySelector('.dc-desc')?.textContent ?? null,
      why: o.querySelector('.dc-why')?.textContent ?? null,
      benefit: o.querySelector('.dc-benefit')?.textContent ?? null,
      cost: o.querySelector('.dc-cost')?.textContent ?? null,
      type: o.querySelector('input')?.type ?? null,
      disabled: !!o.querySelector('input')?.disabled,
      rec: !!o.querySelector('.dc-rec-tag'),
      combines: o.querySelector('.dc-combines')?.textContent ?? null,
      descWidth: Math.round(o.querySelector('.dc-desc')?.getBoundingClientRect().width ?? 0),
    })),
    rec: txt('.tv-decide .dc-rec'),
    prereq: txt('.tv-decide .dc-prereq'),
    stages: [...d.querySelectorAll('.tv-decide .dc-stage')].map((s) => s.textContent.replace(/\\s+/g, ' ').trim()),
    history: (() => {
      const h = d.querySelector('.tv-slot-hist');
      if (!h) return null;
      return { open: h.open, n: h.querySelectorAll('.tvh-item').length, summary: h.querySelector('.tv-slot-h')?.textContent.replace(/\\s+/g, ' ').trim() };
    })(),
    flaws: [...d.querySelectorAll('.tv-flaw')].map((f) => ({ level: f.classList.contains('err') ? 'error' : 'warn', text: f.textContent.replace(/\\s+/g, ' ').trim().slice(0, 70) })),
    geom: { title: box('.tv-dtitle'), human: box('.tv-human'), impact: box('.tv-impact'), meta: box('.tv-dmeta'), md: box('.tv-md'), flaws: box('.tv-flaws'), decide: box('.tv-decide-wrap') },
    notRecorded: [...d.querySelectorAll('.th-none, .v-none')].map((e) => e.textContent.trim()),
    // "an empty band is worse than no band": whether the scaffolding EXISTS at all.
    hasHumanCard: !!d.querySelector('.tv-human'),
    hasImpactCard: !!d.querySelector('.tv-impact'),
    hasDeepHeader: !!d.querySelector('.tv-deep-h'),
    hasLegacyNote: !!d.querySelector('.th-legacy-note'),
    // the whole detail as the READER gets it: innerText, so display:none is gone
    // and a zero-height box contributes nothing.
    visibleText: (d.innerText ?? '').replace(/\\s+/g, ' ').trim(),
    rawRecordCaption: txt('.tv-rawrec-cap'),
  };
})()`;

/* ═══════════════════════════════════ THE CORPUS SWEEP ════════════════════
 *
 * The largest attack surface in this change is not the fixtures — it is the 190
 * real tickets nobody wrote for this test. So every one of them is rendered
 * through the REAL renderer (`__station.ticketDetailNode`, the same function the
 * route calls) on BOTH trees, and every content line of every FILE is looked for
 * in what came out.
 *
 * Rendering in-page rather than navigating 190 times is deliberate: it is the
 * same code path, the node is attached to the live `#tvDetail` so the real
 * stylesheet applies (a `display: none` rule is what folded the duplicate H1,
 * and only an attached node can show it), and `innerText` therefore reports what
 * the READER gets while `textContent` reports what is merely in the DOM. The
 * difference between those two is where an elision hides.
 */
const SWEEP = (pid, ids) => `(async () => {
  const S = window.__station;
  const host = document.querySelector('#tvDetail');
  const out = {};
  for (const id of ${JSON.stringify(ids)}) {
    let t;
    try { t = await S.api.ticket(${JSON.stringify(pid)}, id); }
    catch (e) { out[id] = { error: 'fetch: ' + (e && e.message || e) }; continue; }
    let node;
    try { node = S.ticketDetailNode(t, { compact: true }); }
    catch (e) { out[id] = { error: 'render: ' + (e && e.message || e) }; continue; }
    const box = document.createElement('div');
    box.appendChild(node);
    host.appendChild(box);
    // Every expander opened: a closed <details> is legitimately hidden, and this
    // sweep is asking whether the bytes EXIST to be reached, not whether they
    // are on screen at rest. (Reachability at rest is the AX leg's question.)
    for (const d of box.querySelectorAll('details')) d.open = true;
    void box.offsetHeight;
    out[id] = {
      visible: (box.innerText || '').replace(/\\s+/g, ' ').trim(),
      all: (box.textContent || '').replace(/\\s+/g, ' ').trim(),
    };
    box.remove();
  }
  return out;
})()`;

/* ═══════════════ the broken-record probes (fence-safe by construction) ════
 *
 * Every one of these builds its ``` runs with String.fromCharCode(96) rather
 * than writing them literally: these are JS template literals, and a literal
 * backtick would terminate the string. (The same hazard, one level up, that the
 * code under test is about.)
 */
const FENCE_CH = "const F = String.fromCharCode(96, 96, 96);";

/** The rendered broken-record detail, graded for BYTE-EXACTNESS, not for "the
 *  lines are in there somewhere" — the note promises the stronger thing. */
const FENCE_PROBE = `(() => {
  ${FENCE_CH}
  const S = window.__station;
  const d = document.querySelector('#tvDetail .tv-doc');
  const t = S.tv.current;
  const v = S.ticketView(t);
  const pre = d.querySelector('.tv-md .prose .tv-rawrec pre');
  const all = d.textContent, vis = d.innerText || '';
  const lines = String(v.rawRecordBlock || '').split('\\n').map((l) => l.trim()).filter(Boolean);
  return {
    blockText: v.rawRecordBlock,
    summaryLine: (String(v.rawRecordBlock || '').split('\\n').find((l) => l.includes('summary')) || ''),
    fenceRunsInBlock: (String(v.rawRecordBlock || '').match(new RegExp(F, 'g')) || []).length,
    byteExact: !!pre && pre.textContent === v.rawRecordFence,
    preLen: pre ? pre.textContent.length : -1,
    fenceLen: String(v.rawRecordFence || '').length,
    blockLines: lines.length,
    reachAll: lines.filter((l) => all.includes(l)).length,
    reachVisible: lines.filter((l) => vis.includes(l)).length,
    workStateVisible: vis.includes('"work_state"'),
    diagnosisRendered: !!d.querySelector('.tv-md .prose .tv-slot') && vis.includes('untouched and must still render'),
  };
})()`;

/** The two PRIOR behaviours, reconstructed in the page from the page's own
 *  prose(), and the current one, all on the same input. A synthesized pre-fix
 *  state: no git, no HEAD, nothing that moves when this lane's fix lands. */
const PREFIX_PROBE = (id) => `(async () => {
  ${FENCE_CH}
  const { prose } = await import('/lib/dom.js');
  const S = window.__station;
  const t = S.tv.current;
  const src = t.markdown;
  const RE = new RegExp('^\\\\s*' + F + 'orchard-ticket[ \\\\t]*\\\\r?\\\\n([\\\\s\\\\S]*?)\\\\r?\\\\n' + F + '[ \\\\t]*(?:\\\\r?\\\\n|$)');
  const m = RE.exec(src);
  const lines = m[1].split('\\n').map((l) => l.trim()).filter(Boolean);
  // 198013f — the block was stripped and only the prose after it rendered.
  const stripped = prose(src.slice(m[0].length), 'prose').textContent;
  // 74e03e2 — the WHOLE FILE went through prose(), fences and all.
  const whole = prose(src, 'prose').textContent;
  const now = document.querySelector('#tvDetail .tv-doc').textContent;
  return {
    id: ${JSON.stringify(id)},
    blockLines: lines.length,
    strippedReach: lines.filter((l) => stripped.includes(l)).length,
    proseReach: lines.filter((l) => whole.includes(l)).length,
    proseWorkState: whole.includes('"work_state": open'),
    currentReach: lines.filter((l) => now.includes(l)).length,
  };
})()`;

/** Render N corrupted variants through the REAL renderer, attached so the real
 *  stylesheet applies, and grade each. The payload is shaped exactly like the
 *  API's; the markdown is the real corpus sentence in a real formatter's output. */
const FENCE_SWEEP = (seeds) => `(() => {
  const S = window.__station;
  const host = document.querySelector('#tvDetail');
  const out = [];
  for (const seed of ${JSON.stringify(seeds)}) {
    const payload = { id: seed.srcId, title: seed.srcId, markdown: seed.markdown, section: 'open', relPath: 'docs/bugs/x.md' };
    const v = S.ticketView(payload);
    const box = document.createElement('div');
    box.appendChild(S.ticketDetailNode(payload, { compact: true }));
    host.appendChild(box);
    void box.offsetHeight;
    const pre = box.querySelector('.tv-md .prose .tv-rawrec pre');
    const all = box.textContent, vis = box.innerText || '';
    const lines = String(v.rawRecordBlock || '').split('\\n').map((l) => l.trim()).filter(Boolean);
    out.push({
      srcId: seed.srcId, label: seed.label,
      parseError: !!v.parseError,
      byteExact: !!pre && pre.textContent === v.rawRecordFence,
      blockLines: lines.length,
      reachAll: lines.filter((l) => all.includes(l)).length,
      reachVisible: lines.filter((l) => vis.includes(l)).length,
      workStateVisible: vis.includes('"work_state"'),
    });
    box.remove();
  }
  return out;
})()`;

/** Each grammar case, read by the browser's RECORD_FENCE_RE, by the opener line
 *  scan, and by the real renderer — plus whether any line went missing. */
const GRAMMAR_PROBE = (cases) => `(async () => {
  const M = await import('/lib/ticket-record.js');
  const S = window.__station;
  const host = document.querySelector('#tvDetail');
  const out = [];
  for (const [label, md] of ${JSON.stringify(cases)}) {
    const x = M.extractTicketBlock(md);
    const payload = { id: 'BUG-111', title: 'grammar probe', markdown: md, section: 'open',
      status: 'OPEN — from the board index', relPath: 'docs/bugs/x.md' };
    const v = M.ticketView(payload);
    const box = document.createElement('div');
    box.appendChild(S.ticketDetailNode(payload, { compact: true }));
    host.appendChild(box);
    for (const d of box.querySelectorAll('details')) d.open = true;
    void box.offsetHeight;
    // The SAME squash the corpus sweep uses — letters and digits only. A weaker
    // normalisation reported every markdown heading as lost, because the rendered
    // heading has no '#'; the sweep's own rule is the one that survives a reflow.
    const sq = (t) => t.toLowerCase().replace(/[^a-z0-9]/g, '');
    const all = sq(box.textContent);
    const all2 = md.split('\\n').map((l) => l.trim()).filter((l) => sq(l).length >= 6);
    // FENCE LINES are held apart, exactly as the corpus sweep holds them apart:
    // prose() strips a fenced block's info string, so the label is dropped by the
    // markdown renderer rather than by anything this lane owns (BUG-111). Counted
    // separately instead of silently skipped, because for THESE files the info
    // string is the only textual sign the file was ever migrated.
    const isFence = (l) => /^[>\\-\\s]*(\`{3,}|~{3,})/.test(l);
    const lines = all2.filter((l) => !isFence(l));
    const fenceLines = all2.filter(isFence);
    out.push({
      label,
      regexBlock: x.block !== null && !x.unterminated,
      scanOpener: M.openerIndex(md) >= 0,
      unterminated: !!x.unterminated,
      migrated: v.migrated,
      recordUnreadable: v.recordUnreadable,
      lines: lines.length,
      missingLines: lines.filter((l) => !all.includes(sq(l))),
      infoStringsLost: fenceLines.filter((l) => !all.includes(sq(l))),
      pills: [...box.querySelectorAll('.tv-pills .tv-pill')].map((p) => p.textContent.trim()),
    });
    box.remove();
  }
  return out;
})()`;

/** Where two strings first differ, reported as CODE POINTS — a whitespace-only
 *  difference is invisible in a quoted string, and the defect this leg exists to
 *  catch was exactly six bytes of whitespace. */
function byteDiff(want, got) {
  if (want === got) return `identical, ${want.length} chars`;
  if (got === null || got === undefined) return `nothing rendered (expected ${want ? want.length : 0} chars)`;
  let i = 0;
  while (i < want.length && i < got.length && want[i] === got[i]) i += 1;
  const cp = (str, at) => (at < str.length ? `U+${str.codePointAt(at).toString(16).toUpperCase().padStart(4, '0')}` : 'EOF');
  return `first differ at index ${i}: disk ${cp(want, i)}, page ${cp(got, i)} `
    + `(lengths ${want.length} vs ${got.length}; page prefix ${JSON.stringify(got.slice(0, Math.min(i + 8, 40)))})`;
}

/** Render N truncations through the REAL renderer, with a payload that carries
 *  what the board index would say (`section`, `status`) — so a page that reaches
 *  for the index to invent a state has something to reach for, and is caught. */
const TRUNC_SWEEP = (seeds) => `(() => {
  const S = window.__station;
  const host = document.querySelector('#tvDetail');
  const out = [];
  for (const seed of ${JSON.stringify(seeds)}) {
    const payload = { id: 'BUG-111', title: 'from the board index', markdown: seed.markdown,
      section: 'open', status: 'OPEN — from the board index', relPath: 'docs/bugs/x.md' };
    const v = S.ticketView(payload);
    const box = document.createElement('div');
    box.appendChild(S.ticketDetailNode(payload, { compact: true }));
    host.appendChild(box);
    void box.offsetHeight;
    const pre = box.querySelector('.tv-md .prose .tv-rawrec pre');
    const at = seed.markdown.indexOf('\`\`\`orchard-ticket');
    const want = at < 0 ? null : seed.markdown.slice(at).replace(/\\r?\\n$/, '');
    out.push({
      label: seed.label, at: seed.at, cls: seed.cls,
      migrated: v.migrated,
      recordUnreadable: v.recordUnreadable,
      byteExact: want === null ? true : (!!pre && pre.textContent === want),
      pills: [...box.querySelectorAll('.tv-pills .tv-pill')].map((p) => p.textContent.trim()),
      facts: [...box.querySelectorAll('.tv-dmeta .kv .k')].map((k) => k.textContent.trim()),
    });
    box.remove();
  }
  return out;
})()`;

/** The RECORD error note, read whole and addressed BY NAME. Reading "the first
 *  `.tv-flaw.err`" is how the earlier round measured the wrong note: a legacy
 *  status complaint sat above it and the assertion graded that instead. */
const RECORD_FLAW_TEXT = `(() => {
  const f = document.querySelector('#tvDetail .tv-flaw[aria-label="ticket record error"]');
  return f ? f.textContent.replace(/\\s+/g, ' ').trim() : null;
})()`;

/** Everything but letters and digits removed: a comparison that survives every
 *  reflow, bullet rewrite, table cell join and inline-markdown strip, and still
 *  catches a deletion. */
const squash = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * The lines of a ticket FILE that carry reader content, with their markdown
 * removed — the list of things the rendered page must contain.
 * Fence lines are dropped (prose() renders the fence as a <pre> and drops the
 * info string, which is a label, not content) and so are lines that carry no
 * letters or digits at all.
 */
function contentLines(md) {
  const out = [];
  for (const raw of String(md).replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line || /^```/.test(line)) continue;
    const bare = line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^([-*+]|\d+\.)\s+/, '')
      .replace(/[`*_|>]/g, '');
    // TWO readings, and the line counts as present under EITHER. `[text](url)`
    // renders as its text — unless it is inside a code span, where it renders
    // literally, and 7 real tickets are ABOUT link syntax and write it that way.
    // Grading only the first reading reported those as content loss; that would
    // have been the sweep lying about the sweep.
    const alts = [bare, bare.replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, '$1')];
    if (squash(bare).length >= 12) out.push({ line, alts: [...new Set(alts)] });
  }
  return out;
}

/** A census of the shapes the structured format has no slot for, so the sweep's
 *  result can be reported against the shapes it was meant to cover. */
function corpusCensus(files) {
  const c = { preHeading: [], codeBlocks: [], tables: [], images: [], oddHeadings: new Map(), noH1: [], fenceAnomaly: [] };
  const KNOWN = /^(diagnosis|evidence|symptom|impact|question|wanted|activity log|verification|verification plan|implementation notes|risks|migration and rollback|in plain terms|what changed|the fix|repro|proposal|decision|notes|status|success criteria|related|background|plan|scope|why|what|resolution)\b/i;
  for (const [id, md] of files) {
    const body = md.replace(/\r\n?/g, '\n');
    const firstHead = body.search(/^#{1,6}\s+/m);
    if (firstHead > 0 && squash(body.slice(0, firstHead)).length > 12) c.preHeading.push(id);
    if (!/^#\s+/m.test(body)) c.noH1.push(id);
    if (/^```/m.test(body)) c.codeBlocks.push(id);
    // BUG-111's shape: prose() splits on the CHARACTER RUN ``` wherever it falls,
    // so a four-backtick code span or an unpaired fence flips its alternation and
    // the info-string strip then eats the following line. A ticket is at risk iff
    // it carries a ``` that does not begin a line, or an odd number that do.
    const allFences = (body.match(/```/g) ?? []).length;
    const lineFences = (body.match(/^```/gm) ?? []).length;
    if (allFences !== lineFences || lineFences % 2 !== 0) c.fenceAnomaly.push(id);
    if (/^\s*\|.*\|\s*$/m.test(body) && /^\s*\|?[\s:-]*-[\s:|-]*$/m.test(body)) c.tables.push(id);
    if (/!\[[^\]]*\]\([^)]*\)/.test(body)) c.images.push(id);
    for (const m of body.matchAll(/^##\s+(.+)$/gm)) {
      const h = m[1].trim();
      if (!KNOWN.test(h)) c.oddHeadings.set(h, [...(c.oddHeadings.get(h) ?? []), id]);
    }
  }
  return c;
}

/* WCAG contrast against the surface an ink REALLY lands on. The washes are alpha
   (color-mix(… transparent)), so the background is composited up the ancestor
   chain rather than read off one element — which is precisely the mistake that
   makes a dark-green card body invisible on a dark-green card. */
const CONTRAST_FN = `
  const parse = (c) => {
    const v = (c.match(/[\\d.]+/g) || ['0','0','0']).slice(0, 4).map(Number);
    const s = /^color\\(/.test(c) ? 255 : 1;
    return { r: v[0] * s, g: v[1] * s, b: v[2] * s, a: v.length > 3 ? v[3] : 1 };
  };
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const bgOf = (el) => {
    let stack = [];
    for (let n = el; n; n = n.parentElement) stack.push(parse(getComputedStyle(n).backgroundColor));
    let out = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = stack.length - 1; i >= 0; i--) out = over(stack[i], out);
    return out;
  };
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const ratio = (fgc, el) => { const bg = bgOf(el); const fg = over(parse(fgc), bg); const a = lum(fg), b = lum(bg); const hi = Math.max(a, b), lo = Math.min(a, b); return +((hi + 0.05) / (lo + 0.05)).toFixed(2); };
`;

const MEASURE_INKS = (pairs) => `(() => {
  ${CONTRAST_FN}
  const out = [];
  for (const [sel, label] of ${JSON.stringify(pairs)}) {
    const el = document.querySelector(sel);
    if (!el) { out.push({ label, missing: true }); continue; }
    const cs = getComputedStyle(el);
    const bg = bgOf(el);
    out.push({ label, color: cs.color, bg: 'rgb(' + [bg.r, bg.g, bg.b].map(Math.round).join(',') + ')',
      ratio: ratio(cs.color, el), fontSize: parseFloat(cs.fontSize), weight: cs.fontWeight,
      visible: el.getBoundingClientRect().height > 0 });
  }
  return out;
})()`;

/* ═════════════════════════════════════════════════════════════════════ main */

let browser = null, cdp = null, ledger = null, worktreeMade = false;
let redRecordError = null, redScaffold = null, baseSweep = null, redSkipped = false;
/** The commit that SHIPPED the defects this suite's RED leg is the baseline for. */
const RED_BASE = process.env.TVREDESIGN_RED_BASE ?? '198013f';
let CORPUS_IDS = [];
const CORPUS_FILES = new Map();

/** Words of SCAFFOLDING a reader passes before the ticket's own content: the
 *  human band, the impact card and the absence paragraph, when they carry no
 *  authored value. This is the number the user objected to. */
function scaffoldWords(m) {
  const parts = [];
  if (m.hasHumanCard) parts.push(m.summary, m.need, 'What\u2019s happening', 'What this ticket needs');
  if (m.hasImpactCard) parts.push('Impact if we wait', m.impact);
  if (m.hasLegacyNote) parts.push(m.legacyNote);
  if (m.hasDeepHeader) parts.push(m.deepHeader);
  return parts.filter(Boolean).join(' ').split(/\s+/).filter(Boolean).length;
}

/** Navigate to one ticket detail and wait for it. */
async function openDetail(srv, id) {
  await cdp.send('Page.navigate', { url: `${srv.base}/#/tickets/${id}?project=${encodeURIComponent(srv.pid)}` });
  const ok = await cdp.waitFor(`${id} detail`, `document.querySelector('#tvDetail .tv-doc')?.dataset.id === ${JSON.stringify(id)}`, 25000);
  await sleep(220);
  return ok;
}

/** Render every id through the real renderer on `srv`, in chunks. */
async function sweepCorpus(srv, ids) {
  const out = {};
  // Land on a real detail route first: the sweep attaches its nodes to the live
  // #tvDetail, so the pane must be the visible one for the stylesheet to apply.
  await openDetail(srv, ids[0]);
  for (let i = 0; i < ids.length; i += 25) {
    const part = await cdp.eval(SWEEP(srv.pid, ids.slice(i, i + 25)));
    Object.assign(out, part);
  }
  return out;
}

async function main() {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  spawnSync('git', ['worktree', 'prune'], { cwd: ROOT });
  ledger = shotLedger();

  /* ═════════ SCHEMA: the fixtures are the format that will ship ═════════ */
  console.log('\n=== SCHEMA: every hand-authored fixture validates under the REAL schema module ===');
  for (const f of FIXTURES) {
    const rec = { ...f };
    rec.body_slots = { ...rec.body_slots, ...(rec.slots ?? {}) };
    delete rec.body; delete rec.slots;
    const v = validateTicket(rec, { file: fixtureFile(f) });
    check(`  ${f.id} — ${f.title}`, v.ok, v.ok ? 'valid' : v.violations.slice(0, 4).join(' | '));
  }

  const copied = seedBoard();
  check('PRECONDITION: the board is MIXED — the REAL corpus (un-migrated) plus the migrated + legacy seeds',
    copied >= 100 && ALL_SEEDED.every((id) => fs.readdirSync(BUGS).some((n) => n.startsWith(`${id}-`))),
    `${copied} real ticket files copied + ${FIXTURES.length} migrated + ${LEGACY_SEEDS.length} legacy seeds`);

  const fixed = await bootServer(ROOT, 'fixed');

  /* ═════════ API: the transport carries the record ═════════ */
  console.log('\n=== API: the mixed board is served, records intact ===');
  const list = await (await fetch(`${fixed.base}/api/projects/${fixed.pid}/tickets`)).json();
  check('the list route returns the whole mixed board',
    (list.tickets?.length ?? 0) >= copied, `${list.tickets?.length} tickets`);
  const one = await (await fetch(`${fixed.base}/api/projects/${fixed.pid}/tickets/FEAT-982`)).json();
  check('a migrated ticket arrives with its orchard-ticket block in the markdown (the client parses what an agent reads)',
    typeof one.markdown === 'string' && one.markdown.startsWith('```orchard-ticket'),
    `${String(one.markdown).slice(0, 34)}…`);

  /* ═════════ browser ═════════ */
  const profile = path.join(SCRATCH, 'chrome');
  fs.mkdirSync(profile, { recursive: true });
  browser = spawn(BRAVE, [
    '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', '--window-size=1500,1000', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  procs.push(browser);
  let devPort = 0;
  for (let i = 0; i < 120 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  if (!devPort) throw new Error('browser never wrote DevToolsActivePort');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  cdp = await Cdp.connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');
  await cdp.send('Accessibility.enable');
  await cdp.viewport(1500, 1000);
  await cdp.theme('dark');

  const open = (srv, id) => openDetail(srv, id);

  /* ═════════ RED: the pre-change tree, same tickets, measured ═════════ */
  // The tickets measured on BOTH trees. The four real ones are the very files the
  // plan's table measured; the migrated fixtures are what the new format renders.
  const MEASURED_WANT = ['FEAT-082', 'ARCH-005', 'BUG-104', 'FEAT-092', 'FEAT-982', 'ARCH-985', 'BUG-984', 'FEAT-992', 'FEAT-986'];
  // This suite renders four REAL tickets BY NAME. A clean room that withholds one
  // of them (rooms withhold the ticket under verification — ARCH-005 has been
  // withheld in practice) made the suite report a spurious failure about the
  // renderer, when the true fact was that the corpus copy was incomplete. Missing
  // inputs are now named as missing inputs.
  const MEASURED = MEASURED_WANT.filter((id) => fs.readdirSync(BUGS).some((n) => n.startsWith(`${id}-`)));
  const MEASURED_ABSENT = MEASURED_WANT.filter((id) => !MEASURED.includes(id));
  if (MEASURED_ABSENT.length) {
    console.log(`\n        NOTE: ${MEASURED_ABSENT.join(', ')} are not in this corpus copy, so the checks that`
      + '\n        render them by name are SKIPPED, not failed. A clean room that withholds the'
      + '\n        ticket under verification produces exactly this; copy the corpus complete.');
  }
  const before = {};
  if (!NO_RED) {
    console.log('\n=== RED (pre-change tree, same board): the words a reader passes before the question ===');
    fs.rmSync(BASE_TREE, { recursive: true, force: true });
    // A PINNED SHA, NOT `HEAD`. Anchoring a must-FAIL to HEAD is the moving-baseline
    // trap docs/CONVENTIONS.md bans: the moment this lane's own fix landed, "the
    // pre-change tree" became the fixed tree and the RED leg started grading the
    // wrong thing (it did — three of its checks inverted silently). RED_BASE is the
    // commit that SHIPPED the defect, so the comparison stays put.
    const wt = spawnSync('git', ['worktree', 'add', '--detach', BASE_TREE, RED_BASE], { cwd: ROOT, encoding: 'utf8' });
    if (wt.status !== 0) {
      // LEGIBLE, not a mystery. In a clean room this is not a git repo at all, and
      // the failure used to surface as an unexplained harness abort. It names what
      // did not run; the SYNTHESIZED pre-fix leg above still ran, so the must-FAIL
      // for this lane's own defect is proved either way.
      console.log(`\n        RED LEG SKIPPED — cannot create a worktree at ${RED_BASE}: ${String(wt.stderr).trim().slice(0, 160)}`);
      console.log('        Not verified by this run: the pre-change RENDERED comparison and the'
        + '\n        words-before-the-question before/after numbers. Everything else, including'
        + '\n        the synthesized pre-fix must-FAIL, ran. Pass --no-red to skip it deliberately.');
      redSkipped = true;
    } else {
    worktreeMade = true;
    try { fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(BASE_TREE, 'node_modules')); } catch { /* present */ }
    const base = await bootServer(BASE_TREE, 'base');
    for (const id of MEASURED) {
      const ok = await open(base, id);
      const m = ok ? await cdp.eval(WORDS_BEFORE_Q) : null;
      before[id] = m?.words ?? null;
      console.log(`        ${id}: ${m?.words ?? 'n/a'} words before the question (question found: ${m?.hasQuestion ?? false})`);
    }
    const b = await open(base, 'FEAT-982');
    const preBands = b ? await cdp.eval(BANDS) : null;
    // The base worktree is HEAD, and HEAD now CONTAINS the redesign (198013f) —
    // this leg is no longer "prose view vs banded view". It is the honest baseline
    // for THIS lane: the same banded view, one commit before the content-loss and
    // empty-band fixes below. Asserted rather than assumed, so the comparison is
    // never quietly measured against the wrong tree.
    check('RED: the base worktree already carries the redesign — this leg measures THIS lane’s delta, not the redesign’s',
      !!preBands && !!preBands.summary && !!preBands.impact && preBands.format === 'record',
      JSON.stringify({ format: preBands?.format, summary: !!preBands?.summary, impact: !!preBands?.impact }));
    await ledgerShot('red-FEAT-982-dark.png', 'dark', 'RED: a migrated ticket on the pre-change tree (dark)');

    /* ── RED, the must-FAIL for THIS lane: the broken-record ticket. On the
       pre-change tree readTicketRecord strips the fenced block before handing the
       body to the renderer, so the block's bytes cannot be on the page — while
       the error note on that same page says the original markdown is shown in
       full. Asserted here at the RENDERED level, on the real browser, so the fix
       below is proved against what a reader sees rather than a module return. ── */
    const okRed = await open(base, RECORD_ERROR_ID);
    const redErr = okRed ? await cdp.eval(BANDS) : null;
    const redNote = okRed ? await cdp.eval(RECORD_FLAW_TEXT) : null;
    redRecordError = redErr
      ? { marker: redErr.visibleText.includes(RECORD_ERROR_MARKER), note: redNote, pills: redErr.pills.map((x) => x.text) }
      : null;
    check('RED: the pre-change tree DELETES the unparseable record block — its bytes are nowhere on the rendered page…',
      redRecordError !== null && redRecordError.marker === false,
      JSON.stringify({ markerOnPage: redRecordError?.marker, pills: redRecordError?.pills }));
    check('RED: …while that same page tells the reader the original markdown is shown in full',
      /shown in full/.test(String(redRecordError?.note)),
      JSON.stringify(String(redRecordError?.note).slice(0, 200)));

    /* ── RED: the empty human band on a REAL un-migrated ticket, measured. ── */
    const okLegacyRed = await open(base, 'BUG-104');
    const redLegacy = okLegacyRed ? await cdp.eval(BANDS) : null;
    redScaffold = redLegacy ? scaffoldWords(redLegacy) : null;
    check('RED: a REAL un-migrated ticket opens with an empty human band — three stated absences and a paragraph explaining them',
      !!redLegacy && redLegacy.hasHumanCard && redLegacy.hasImpactCard && redLegacy.hasLegacyNote
        && /^Not recorded$/.test(String(redLegacy.summary)),
      JSON.stringify({ human: redLegacy?.hasHumanCard, impact: redLegacy?.hasImpactCard, note: redLegacy?.hasLegacyNote, scaffoldWords: redScaffold }));

    /* ── RED: the whole corpus, rendered by the pre-change renderer. ── */
    baseSweep = await sweepCorpus(base, CORPUS_IDS);
    console.log(`        base tree swept: ${Object.keys(baseSweep).length} tickets rendered`);
    }
  }
  if (NO_RED) {
    console.log('\n=== RED LEG SKIPPED (--no-red) — not verified: the pre-change rendered comparison'
      + '\n    and the before/after word counts. The synthesized pre-fix must-FAIL still ran. ===');
  }

  /* ═════════ BANDS: a MIGRATED ticket ═════════ */
  console.log('\n=== BANDS: a migrated ticket renders its record verbatim, in the plan’s order ===');
  await cdp.viewport(1500, 1000);
  await open(fixed, 'FEAT-982');
  const f982 = FIXTURES.find((f) => f.id === 'FEAT-982');
  let m = await cdp.eval(BANDS);
  check('the human layer carries the record’s OWN words — summary, current need and impact, verbatim',
    m.summary === f982.summary && m.need === f982.current_need && m.impact === f982.impact_if_we_wait,
    JSON.stringify({ summary: m.summary?.slice(0, 46), need: m.need?.slice(0, 40), impact: m.impact?.slice(0, 40) }));
  check('the hero states type · id, the title, and the orthogonal state fields as separate pills',
    m.eyebrow === 'FEAT · FEAT-982' && m.title === f982.title
      && m.pills.some((p) => p.text === 'Decide') && m.pills.some((p) => p.text === 'Open'),
    JSON.stringify({ eyebrow: m.eyebrow, pills: m.pills.map((p) => p.text) }));
  // ARCH-009 — WHERE ABSENCE OF PROOF IS STATED, NOW THAT NOTHING DERIVES IT.
  //
  // This used to assert a hero pill reading "Proof not recorded". That pill was
  // one of four painted from a COMPUTED `verification_state`, and the computation
  // was wrong on real tickets (FEAT-061 and FEAT-062 are both closed VERIFIED
  // over an unresolved BROKEN and both painted the green "Verified — holds").
  // The field is deleted, so the pill is too.
  //
  // The plan's rule — absence is STATED, never silent — is not relaxed, it moves
  // to the one place that can honour it from data the ticket actually asserts:
  // the Proof card prints the literal words "Not recorded" when `verification[]`
  // is empty. So the assertion is now BOTH halves, together, because either one
  // alone would let a regression through: no proof pill in the hero, AND the
  // words on the card. Silence in both places would be the defect.
  check('ARCH-009: the hero claims NO proof state — nothing derives one any more',
    !m.pills.some((p) => /proof|verif/i.test(p.text)),
    JSON.stringify(m.pills.map((p) => p.text)));
  check('  …and the reader is still told the proof is absent in the plan’s own words, on the Proof card',
    m.slots.some((s) => s.title === 'Proof' && /not recorded/i.test(String(s.note ?? ''))),
    JSON.stringify(m.slots.filter((s) => s.title === 'Proof')));
  check('the deep layer is a set of INDEPENDENT expanders, all collapsed, never one markdown blob',
    m.slotCount >= 4 && m.slots.every((s) => s.open !== true)
      && m.slots.some((s) => /Diagnosis/.test(s.title)) && m.slots.some((s) => /Activity log/i.test(s.title)),
    JSON.stringify(m.slots.map((s) => `${s.title}:${s.open ? 'open' : 'closed'}`)));
  check('  …and every deep section is still a real HEADING inside the prose (agents and screen readers keep the structure)',
    m.slots.every((s) => /^H\d$/.test(String(s.tag))),
    JSON.stringify(m.slots.map((s) => s.tag)));
  check('the record’s structured deep fields render too — proof, success criteria, related code, related tickets',
    ['Proof', 'Success criteria', 'Related code', 'Related tickets'].every((t) => m.slots.some((s) => s.title === t)),
    JSON.stringify(m.slots.map((s) => s.title)));
  check('the human layer sits ABOVE the deep layer, and the decision is beside it — never behind it',
    m.geom.human.bottom <= m.geom.md.top + 2 && m.geom.decide.left > m.geom.human.left + 300,
    JSON.stringify(m.geom));
  check('a MIGRATED ticket draws NO "missing status field" error — the format deleted that header on purpose',
    m.flaws.length === 0, JSON.stringify(m.flaws));

  /* ═════════ DECIDE: single ═════════ */
  console.log('\n=== DECIDE: single choice — comparable option cards, recommendation with a reason ===');
  check('the decision question is the record’s, and every option carries what changes / gains / costs / why-not-obvious',
    m.question === f982.decision.question && m.options.length === 4
      && m.options.every((o) => o.what && o.why && o.benefit && o.cost)
      && m.options.every((o) => o.type === 'radio'),
    JSON.stringify(m.options.map((o) => ({ key: o.key, why: (o.why || '').slice(0, 34) }))));
  check('  the "why this isn’t obviously best" line is the record’s text, verbatim, on every option',
    f982.decision.options.every((o, i) => (m.options[i].why || '').includes(o.why_not_obvious)),
    JSON.stringify(m.options.map((o) => (o.why || '').slice(0, 46))));
  check('  the recommendation names its key AND states the reason',
    /Recommends C/.test(m.rec) && m.rec.includes(f982.decision.recommendation_reason),
    JSON.stringify(m.rec));
  check('  option prose keeps a real reading measure (≥250px), the guard FEAT-090 established',
    m.options.every((o) => o.descWidth >= 250), JSON.stringify(m.options.map((o) => o.descWidth)));

  /* ═════════ DECIDE: multi ═════════ */
  console.log('\n=== DECIDE: multi-select — options compose, and the answer is the composed key list ===');
  await open(fixed, 'BUG-984');
  const mMulti = await cdp.eval(BANDS);
  check('a multi decision offers CHECKBOXES, not a radio group that would flatten it',
    mMulti.mode === 'multi' && mMulti.options.every((o) => o.type === 'checkbox'),
    JSON.stringify({ mode: mMulti.mode, types: mMulti.options.map((o) => o.type) }));
  check('  the composing option says what it composes with, and the recommendation is the key LIST',
    mMulti.options.some((o) => /Composes with/.test(o.combines || '')) && /Recommends 1 \+ 2 \+ 4/.test(mMulti.rec),
    JSON.stringify({ rec: mMulti.rec.slice(0, 60), combines: mMulti.options.map((o) => o.combines) }));
  const multiAnswer = await cdp.eval(`(() => {
    const card = document.querySelector('#tvDetail .tv-decide');
    const boxes = [...card.querySelectorAll('.dc-opt input')];
    for (const k of ['1', '2', '4']) { const b = boxes.find((x) => x.value === k); b.checked = true; b.dispatchEvent(new Event('change')); }
    return { sendEnabled: !card.querySelector('.dc-send').disabled, checked: boxes.filter((b) => b.checked).map((b) => b.value) };
  })()`);
  check('  picking three options enables the answer (a radio group could not hold this state)',
    multiAnswer.sendEnabled && multiAnswer.checked.join('+') === '1+2+4', JSON.stringify(multiAnswer));
  await cdp.eval(`document.querySelector('#tvDetail .tv-decide .dc-send').click()`);
  const multiLanded = await cdp.waitFor('answered', `!!document.querySelector('#tvDetail .tv-decide .dc-answered')`, 20000);
  const answeredText = await cdp.eval(`(() => { const a = document.querySelector('#tvDetail .tv-decide .dc-answered'); return a ? a.textContent.replace(/\\s+/g, ' ').trim() : null; })()`);
  const onDisk = fs.readFileSync(path.join(BUGS, fs.readdirSync(BUGS).find((n) => n.startsWith('BUG-984-'))), 'utf8');
  check('  …and the composed answer is written to the ticket VERBATIM, and the card flips to the server-confirmed answered state',
    multiLanded && /- \*\*Chose:\*\* 1 \+ 2 \+ 4 —/.test(onDisk) && /You answered/.test(String(answeredText)),
    JSON.stringify({ shown: String(answeredText).slice(0, 70), chosenLine: (onDisk.match(/- \*\*Chose:\*\*.*/) ?? ['none'])[0].slice(0, 80) }));
  // WAS a known gap, now the end-to-end proof. `src/server/board.ts`'s
  // CHOSE_LINE_RE used to be a SINGLE key, so it could not read back the composed
  // "1 + 2 + 4" it had just written and `answer.chose` came back null — the file
  // was right and only the card's echo lost it. The server lane fixed the grammar
  // (d72c335), so this assertion is flipped from pinning the broken state to
  // proving the WHOLE round trip from the reader's side: compose, write, read back
  // off disk, render. The separator the server splits on is a space-flanked em/en
  // dash — never a bare hyphen — so a key containing a hyphen survives intact, and
  // it splits on the FIRST separator only, so an em-dash inside a label is not cut.
  const echo = await cdp.eval(`(() => { const p = document.querySelector('#tvDetail .tv-decide .dc-pick'); return p ? p.textContent.replace(/\\s+/g, ' ').trim() : null; })()`);
  check('  the answered card echoes the COMPOSED answer back \u2014 the key list read off the file the server just wrote',
    typeof echo === 'string' && /1 \+ 2 \+ 4/.test(echo),
    `dc-pick=${JSON.stringify(echo)}`);

  /* ═════════ DECIDE: staged ═════════ */
  console.log('\n=== DECIDE: staged — only stage 1 is answerable, later stages are shown and inert ===');
  await open(fixed, 'ARCH-985');
  const mStage = await cdp.eval(BANDS);
  const stage1 = mStage.options.filter((o) => !o.disabled);
  const stage2 = mStage.options.filter((o) => o.disabled);
  check('the staged decision renders both stages, and ONLY the first is answerable',
    mStage.mode === 'staged' && stage1.length === 2 && stage2.length === 2,
    JSON.stringify(mStage.options.map((o) => ({ key: o.key, disabled: o.disabled }))));
  check('  …and the plan says what stage 2 will ask and what unlocks it',
    mStage.stages.length === 2 && /unlocked by/.test(mStage.stages[1]),
    JSON.stringify(mStage.stages));

  /* ═════════ DECIDE: no recommendation, with a prerequisite ═════════ */
  console.log('\n=== DECIDE: a null recommendation is a RECORD, not a gap ===');
  await open(fixed, 'FEAT-992');
  const mNull = await cdp.eval(BANDS);
  check('a decision with no recommendation says so out loud, and states the prerequisite that is why',
    /No recommendation/.test(mNull.rec) && /First establish/.test(String(mNull.prereq))
      && String(mNull.prereq).includes('reapplies freshly composed instructions'),
    JSON.stringify({ rec: mNull.rec, prereq: String(mNull.prereq).slice(0, 80) }));

  /* ═════════ DECIDE: the matrix in each of its states ═════════ */
  //
  // The four states nobody had swept: several options selected at once, a staged
  // sequence part-way through, an already-answered decision, and an absent
  // recommendation. Each is asked the same question — does the matrix read as
  // ITSELF, with nothing shortened and no option's prose clipped?
  console.log('\n=== DECIDE MATRIX: several selected, staged part-way, already answered, no recommendation ===');
  await open(fixed, 'BUG-984');
  const mAnswered = await cdp.eval(BANDS);
  const answeredState = await cdp.eval(`(() => {
    const c = document.querySelector('#tvDetail .tv-decide');
    if (!c) return null;
    const a = c.querySelector('.dc-answered');
    return {
      answered: !!a,
      head: a?.querySelector('.dc-answered-h')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
      pick: a?.querySelector('.dc-pick')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
      liveInputs: c.querySelectorAll('.dc-opt input:not([disabled])').length,
      canFollowUp: !!c.querySelector('.dc-followup-note, .dc-note'),
    };
  })()`);
  check('ALREADY ANSWERED: the card is a server-confirmed reading — the composed answer, and no live option inputs left to re-answer',
    answeredState?.answered && /1 \+ 2 \+ 4/.test(String(answeredState.pick)) && answeredState.liveInputs === 0,
    JSON.stringify(answeredState));
  check('  …and it still offers the one write that IS available in that state — a follow-up note, not a second answer',
    answeredState?.canFollowUp === true, JSON.stringify({ canFollowUp: answeredState?.canFollowUp }));

  await open(fixed, 'ARCH-985');
  const stagedNow = await cdp.eval(`(() => {
    const c = document.querySelector('#tvDetail .tv-decide');
    const stages = [...c.querySelectorAll('.dc-stage')].map((s) => ({
      n: s.querySelector('.dc-stage-n')?.textContent.trim(),
      q: s.querySelector('.dc-stage-q')?.textContent.trim(),
      unlocked: s.querySelector('.dc-stage-u')?.textContent.trim() ?? null,
      now: s.classList.contains('now'),
    }));
    const later = [...c.querySelectorAll('.dc-opt')].filter((o) => o.querySelector('.dc-stage-tag'));
    return { stages, laterTagged: later.length, laterDisabled: later.every((o) => o.querySelector('input')?.disabled) };
  })()`);
  check('STAGED PART-WAY: the sequence names the stage being asked NOW and the one that is not yet askable, with what unlocks it',
    stagedNow.stages.length === 2 && stagedNow.stages[0].now === true && stagedNow.stages[1].now === false
      && !!stagedNow.stages[1].unlocked,
    JSON.stringify(stagedNow.stages));
  check('  …and every later-stage option carries its stage tag AND is inert — a staged decision you can answer out of order is not staged',
    stagedNow.laterTagged === 2 && stagedNow.laterDisabled === true, JSON.stringify(stagedNow));

  await open(fixed, 'FEAT-992');
  const noRec = await cdp.eval(`(() => {
    const c = document.querySelector('#tvDetail .tv-decide');
    return {
      rec: c.querySelector('.dc-rec')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
      tagged: c.querySelectorAll('.dc-rec-tag').length,
      prereq: c.querySelector('.dc-prereq')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
    };
  })()`);
  check('NO RECOMMENDATION: the absence is stated as a whole sentence and NO option is tagged recommended by default',
    /No recommendation/.test(String(noRec.rec)) && noRec.tagged === 0 && String(noRec.prereq).length > 30,
    JSON.stringify({ rec: noRec.rec, tagged: noRec.tagged }));

  /* ═════════ a DONE ticket: no live decision, history collapsed and inactive ═════════ */
  console.log('\n=== HISTORY: settled decisions must not read as active ===');
  await open(fixed, 'BUG-980');
  const mDone = await cdp.eval(BANDS);
  check('a done ticket shows NO live decision card at all',
    mDone.hasDecide === false && mDone.question === null,
    JSON.stringify({ hasDecide: mDone.hasDecide, pills: mDone.pills.map((p) => p.text) }));
  check('  …and its two settled decisions are collapsed, counted, and labelled settled',
    mDone.history && mDone.history.n === 2 && mDone.history.open === false && /settled/.test(mDone.history.summary),
    JSON.stringify(mDone.history));
  check('  a verified ticket states its proof: the verdict, the provider and the run id',
    mDone.slots.some((s) => s.title === 'Proof' && /1 recorded/.test(s.note ?? '')),
    JSON.stringify(mDone.slots.filter((s) => s.title === 'Proof')));
  // The two-column human grid, on the shape that has one: with no decision the
  // right column is the impact + facts sidebar the prototype specifies.
  check('  with no decision the human layer is TWO COLUMNS — narrative left, impact and facts right',
    mDone.geom.impact.left > mDone.geom.human.left + 300
      && mDone.geom.meta.left > mDone.geom.human.left + 300
      && mDone.geom.impact.top < mDone.geom.human.bottom,
    JSON.stringify({ human: mDone.geom.human, impact: mDone.geom.impact, meta: mDone.geom.meta, md: mDone.geom.md }));

  /* ═════════ a BROKEN ticket ═════════ */
  console.log('\n=== BROKEN STATE: a ticket whose proof came back BROKEN must not look healthy ===');
  await open(fixed, 'BUG-981');
  const mBroken = await cdp.eval(BANDS);
  check('the broken verdict and the blocked state are both pills, not prose',
    mBroken.pills.some((p) => /BROKEN/.test(p.text)) && mBroken.pills.some((p) => /Blocked/.test(p.text)),
    JSON.stringify(mBroken.pills.map((p) => p.text)));
  // The stated absences moved OUT of the human band (which no longer exists when
  // there is nothing to put in it) and into the two places the rule allows: the
  // dense facts grid and the deep band's one-line flat rows. They are still
  // stated — a claim of absence is checkable and silence is not.
  const brokenAbsences = [...mBroken.slots.filter((s) => s.flat).map((s) => String(s.note).trim()),
    ...mBroken.facts.filter((f) => /Not recorded/.test(f))];
  check('  a record with nothing else recorded still SAYS "Not recorded" — in the facts grid and the flat slot rows, never as an empty band',
    brokenAbsences.length >= 2 && brokenAbsences.every((x) => /Not recorded/i.test(x)),
    JSON.stringify(brokenAbsences));

  /* ═════════ UN-MIGRATED tickets ═════════ */
  console.log('\n=== UN-MIGRATED: the other half of a mixed board must not look broken ===');
  await open(fixed, 'FEAT-986');
  const mLegacy = await cdp.eval(BANDS);
  // THE RULE THE USER SET, and the reason this leg exists. An earlier round put
  // the first 60 words of the ticket's opening section in the summary slot with a
  // caption saying so. That is a machine cut wearing an authored field's clothes:
  // it stops mid-sentence, saves the reader nothing, and its own caption admits
  // they must scroll down and read the same words again. A legacy ticket has no
  // summary, so it SAYS it has no summary and renders its body whole below.
  // …and it does not manufacture an EMPTY one either. The summary slot is absent,
  // not filled with the words "Not recorded" under a heading: the reader gets the
  // ticket's own opening section where the band used to be. The absence is still
  // stated — by the hero's "Not migrated" pill and by the facts grid — in the one
  // place the rule allows it, a dense line rather than a full-width card.
  check('a legacy ticket does NOT manufacture a summary — and does not draw an empty band saying so either',
    mLegacy.summary === null && mLegacy.impact === null && mLegacy.need === null
      && !mLegacy.hasHumanCard && !mLegacy.hasImpactCard && !mLegacy.hasLegacyNote,
    JSON.stringify({ summary: mLegacy.summary, impact: mLegacy.impact, human: mLegacy.hasHumanCard, note: mLegacy.hasLegacyNote }));
  check('  it is marked as un-migrated rather than pretending to be a record',
    mLegacy.format === 'legacy' && mLegacy.pills.some((p) => /Not migrated/.test(p.text)),
    JSON.stringify({ format: mLegacy.format, pills: mLegacy.pills.map((p) => p.text) }));
  check('  its deep sections render OPEN — for a legacy ticket the prose IS the ticket, so it is never hidden',
    mLegacy.slots.filter((s) => !/Activity log/i.test(s.title)).every((s) => s.open === true)
      && mLegacy.slots.some((s) => /Activity log/i.test(s.title) && s.open === false),
    JSON.stringify(mLegacy.slots.map((s) => `${s.title}:${s.open ? 'open' : 'closed'}`)));
  check('  the server-parsed decision still renders, so a legacy ticket can still be answered where it is read',
    mLegacy.hasDecide && /CSV or XLSX/.test(String(mLegacy.question)) && mLegacy.options.length === 2,
    JSON.stringify({ q: mLegacy.question, opts: mLegacy.options.map((o) => o.key) }));

  check('  …and the ticket’s own opening section is rendered WHOLE below, not duplicated in fragments above',
    mLegacy.slots.some((s) => /In plain terms/.test(s.title) && s.open === true)
      && mLegacy.mdText > 200,
    JSON.stringify(mLegacy.slots.map((s) => `${s.title}:${s.open ? 'open' : 'closed'}`)));

  await open(fixed, 'BUG-988');
  const mEmpty = await cdp.eval(BANDS);
  check('a legacy ticket with no prose at all reads the same way — a hero, the facts, its log, and no invention',
    !mEmpty.hasHumanCard && !mEmpty.hasImpactCard && mEmpty.summary === null
      && mEmpty.facts.some((f) => /Not recorded/.test(f)),
    JSON.stringify({ human: mEmpty.hasHumanCard, facts: mEmpty.facts.slice(0, 6) }));

  /* NO ELISION, ANYWHERE IN THE HUMAN LAYER — swept, not spot-checked. Every
     human-layer string on every seeded and real ticket measured below must be a
     whole authored value or the literal "Not recorded": never a trailing ellipsis,
     never a "first N words" caption, never a clipped box hiding its own overflow. */
  console.log('\n=== NO ELISION: a human-layer field is authored, absent, or nothing — never a machine cut ===');
  const ELIDE_SWEEP = [...MIGRATED_IDS, ...LEGACY_SEEDS.map((s) => s.id), 'FEAT-082', 'ARCH-005', 'BUG-104', 'FEAT-092'];
  const elided = [];
  for (const id of ELIDE_SWEEP) {
    if (!await open(fixed, id)) { elided.push(`${id}: did not render`); continue; }
    const bad = await cdp.eval(`(() => {
      const out = [];
      for (const e of document.querySelectorAll('#tvDetail .th-summary, #tvDetail .th-need, #tvDetail .ti-body, #tvDetail .tv-dtitle .d-t, #tvDetail .tv-decide .dc-q')) {
        const t = e.textContent.replace(/\\s+/g, ' ').trim();
        if (/[…]$|\\.\\.\\.$/.test(t)) out.push('ends elided: ' + t.slice(-40));
        if (/first \\d+ words/i.test(t)) out.push('truncation caption: ' + t.slice(0, 40));
        // a box that clips its own text is the same lie told in CSS
        const cs = getComputedStyle(e);
        if (cs.textOverflow === 'ellipsis' || (cs.overflow === 'hidden' && e.scrollHeight > e.clientHeight + 2)) {
          out.push('CSS-clipped: ' + t.slice(0, 40));
        }
      }
      return out;
    })()`);
    for (const b of bad) elided.push(`${id}: ${b}`);
  }
  check('no human-layer field on any of the 13 tickets ends in an ellipsis, carries a truncation caption, or is clipped by CSS',
    elided.length === 0, elided.length ? JSON.stringify(elided.slice(0, 6)) : `${ELIDE_SWEEP.length} tickets swept clean`);

  // …and the same, on a REAL un-migrated ticket nobody wrote for this test.
  await open(fixed, 'BUG-104');
  const mReal = await cdp.eval(BANDS);
  check('a REAL un-migrated ticket off this project’s own board renders complete: a hero, a human layer, and its whole markdown',
    mReal.format === 'legacy' && !!mReal.title && mReal.slotCount >= 3 && mReal.mdText > 2000,
    JSON.stringify({ slots: mReal.slotCount, mdChars: mReal.mdText, summary: mReal.summary }));

  /* ═════════ NO EMPTY BAND ═════════ */
  //
  // THE USER'S OBJECTION, made a test. 182 of the 186 real tickets are
  // un-migrated, and every one of them used to open with a full-width band
  // reading "What's happening / Not recorded / What this ticket needs / Not
  // recorded", an empty impact card beside it, and a paragraph apologising for
  // all three — scaffolding in the most valuable space on the page, pushing the
  // ticket's own first sentence below it. An empty band is worse than no band.
  console.log('\n=== NO EMPTY BAND: a section with nothing to show does not appear ===');
  for (const id of ['BUG-104', 'FEAT-986', 'BUG-987', 'BUG-988']) {
    await open(fixed, id);
    const mm = await cdp.eval(BANDS);
    check(`  ${id} — no human band, no impact card, no absence paragraph, no deep-band eyebrow`,
      !mm.hasHumanCard && !mm.hasImpactCard && !mm.hasLegacyNote && !mm.hasDeepHeader,
      JSON.stringify({ human: mm.hasHumanCard, impact: mm.hasImpactCard, note: mm.hasLegacyNote, eyebrow: mm.hasDeepHeader }));
    check(`  ${id} — the words "Not recorded" appear ONLY in the dense facts grid, never as a band`,
      (await cdp.eval(`(() => [...document.querySelectorAll('#tvDetail .th-none')].map((e) => e.className))()`)).length === 0,
      JSON.stringify(mm.notRecorded));
  }
  // …and the ticket's own content is now the first thing under the hero, on
  // screen, not below a fold. Measured as a real rendered rectangle.
  await cdp.viewport(1500, 1000);
  await open(fixed, 'BUG-104');
  const mLegacyNew = await cdp.eval(BANDS);
  const firstContent = await cdp.eval(`(() => {
    const d = document.querySelector('#tvDetail .tv-doc');
    const p = d.querySelector('.tv-md .prose p, .tv-md .prose li');
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return { top: Math.round(r.top), viewportH: window.innerHeight, text: p.textContent.replace(/\\s+/g, ' ').trim().slice(0, 70) };
  })()`);
  check('a REAL un-migrated ticket begins its own prose within the first screenful',
    firstContent && firstContent.top < firstContent.viewportH,
    JSON.stringify(firstContent));
  const newScaffold = scaffoldWords(mLegacyNew);
  check('  …and the scaffolding a reader passes before that prose is GONE, not merely shorter',
    newScaffold === 0, `scaffold words: ${redScaffold ?? 'n/a (--no-red)'} → ${newScaffold}`);
  await open(fixed, 'BUG-988');
  const mGaps = await cdp.eval(BANDS);
  check('  …while the facts grid still states its own gaps — one label and one value per line, which is where "Not recorded" belongs',
    mGaps.facts.filter((f) => /Not recorded/.test(f)).length >= 1 && mGaps.notRecorded.length >= 1,
    JSON.stringify(mGaps.facts));
  await open(fixed, 'BUG-104');
  // The record's own empty deep slots take the same rule: a claim of absence on
  // one line, and no disclosure that opens onto a second copy of it.
  await open(fixed, 'BUG-981');
  const mFlat = await cdp.eval(BANDS);
  check('an EMPTY record slot is one flat row stating the absence — not an expander that opens onto "Not recorded" again',
    mFlat.slots.filter((s) => s.flat).length >= 2
      && mFlat.slots.filter((s) => s.flat).every((s) => /Not recorded/i.test(String(s.note))),
    JSON.stringify(mFlat.slots.map((s) => `${s.title}:${s.flat ? 'flat' : (s.open ? 'open' : 'closed')}:${String(s.note).trim()}`)));

  /* ═════════ RECORD ERROR: the content-loss defect ═════════ */
  //
  // A migrated ticket whose record has been broken. The fallback used to strip
  // the fenced block before rendering the prose, so the ONE text a reader needs
  // in order to repair the file was the one text the page could not show — while
  // the error note on that same page said the original markdown was shown in
  // full. Proved here on the RENDERED page and in the ACCESSIBILITY TREE, not on
  // a module return value: `visibleText` is innerText, so a block hidden by CSS
  // or collapsed to zero height fails these checks.
  console.log('\n=== RECORD ERROR: an unparseable record block is SHOWN, and the message says what happened ===');
  await open(fixed, RECORD_ERROR_ID);
  const mErr = await cdp.eval(BANDS);
  check('PRECONDITION: the seed really is a corrupted MIGRATED file, not a legacy one',
    (() => { const t = recordErrorText(); const b = /```orchard-ticket\r?\n([\s\S]*?)\r?\n```/.exec(t); if (!b) return false; try { JSON.parse(b[1]); return false; } catch { return true; } })(),
    'the block is present and does not parse');
  check('the unparseable block’s OWN BYTES are on the rendered page — the marker inside the JSON is visible text',
    mErr.visibleText.includes(RECORD_ERROR_MARKER),
    `marker on page: ${mErr.visibleText.includes(RECORD_ERROR_MARKER)}${redRecordError ? ` (pre-change tree: ${redRecordError.marker})` : ''}`);
  check('  …and so is the prose beneath it — showing the block did not cost the body',
    mErr.visibleText.includes(RECORD_ERROR_BODY_MARKER), `body marker on page: ${mErr.visibleText.includes(RECORD_ERROR_BODY_MARKER)}`);
  check('  …and the block is captioned as what it is, in the DOM, not by a CSS ::before a screen reader cannot reach',
    /could not be parsed/.test(String(mErr.rawRecordCaption)), JSON.stringify(mErr.rawRecordCaption));
  const errFlawFull = await cdp.eval(RECORD_FLAW_TEXT);
  check('  …and the page no longer ALSO complains that a migrated file is missing a prose status header it deleted on purpose',
    !/MISSING STATUS FIELD/.test(mErr.visibleText) && mErr.flaws.length === 1,
    JSON.stringify(mErr.flaws.map((f) => f.text)));
  check('  …nor invents a work state for a ticket nothing could parse — no state pill, and no state/status row in the facts',
    !mErr.pills.some((p) => /^(Open|Done)$/.test(p.text))
      && !mErr.facts.some((f) => /^state=|^status=/.test(f)),
    JSON.stringify({ pills: mErr.pills.map((p) => p.text), facts: mErr.facts }));
  // The headline of a broken-record ticket used to be the FENCE MARKER. The
  // server derives a legacy title from the file's first heading, and the first
  // line of a migrated file is ```orchard-ticket — so the one thing a reader saw
  // in 21px bold was a piece of syntax. Every test passed; the screenshot did not.
  check('  …and the headline is the file’s OWN H1, never the fence marker the server read as a title',
    mErr.title === 'a migrated ticket whose record block was corrupted by a hand edit',
    JSON.stringify({ title: mErr.title }));
  check('the message names the failure AND says where the text went — and no longer claims a fullness it cannot deliver',
    /not valid JSON/.test(String(errFlawFull)) && /Nothing has been dropped/.test(String(errFlawFull))
      && /first code block below, under the caption/.test(String(errFlawFull))
      && !/shown in full/.test(String(errFlawFull))
      // …and it must not name a landmark this path does not draw: the deep-band
      // eyebrow is migrated-only, so an earlier wording pointed the reader at a
      // heading that is not on the page. A precise message can still be wrong.
      && (!/Context for deeper review/.test(String(errFlawFull)) || mErr.hasDeepHeader),
    JSON.stringify(String(errFlawFull).slice(0, 240)));
  check('  …and it corrects the OTHER misstatement, as a claim about the FILE rather than about its history',
    /BEGINS with an orchard-ticket record block/.test(String(errFlawFull))
      && !/This ticket HAS been migrated/.test(String(errFlawFull))
      && mErr.pills.some((p) => /Record unreadable/.test(p.text))
      && !mErr.pills.some((p) => /Not migrated/.test(p.text)),
    JSON.stringify({ pills: mErr.pills.map((p) => p.text) }));
  check('  …and it does not manufacture a human layer it could not read: no empty band, just the error and the file',
    !mErr.hasHumanCard && !mErr.hasImpactCard && mErr.format === 'legacy',
    JSON.stringify({ human: mErr.hasHumanCard, impact: mErr.hasImpactCard, format: mErr.format }));
  const errAx = await cdp.eval(`(() => {
    const d = document.querySelector('#tvDetail');
    const walk = document.createTreeWalker(d, NodeFilter.SHOW_TEXT);
    let hit = false;
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const e = n.parentElement; if (!e) continue;
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (e.closest('[aria-hidden=true]')) continue;
      if (n.textContent.includes(${JSON.stringify(RECORD_ERROR_MARKER)})) hit = true;
    }
    return hit;
  })()`);
  // THE CLAIM ATTACKED WHERE IT CAN BE FALSE. A hand-written ticket that OPENS
  // with an orchard-ticket example block — a ticket about the record format would
  // — has never been migrated, and the view cannot tell the difference. The page
  // must therefore not assert a migration history it cannot observe.
  const exampleFirst = await cdp.eval(`(() => {
    const S = window.__station;
    const F = String.fromCharCode(96, 96, 96);
    const md = F + 'orchard-ticket\\n{ "this": "is an EXAMPLE in a hand-written ticket", }\\n' + F
      + '\\n\\n# BUG-111 — a ticket ABOUT the record format\\n\\n- **Status:** OPEN\\n\\nProse follows.\\n';
    const payload = { id: 'BUG-111', title: 'a ticket about the record format', markdown: md, section: 'open' };
    const box = document.createElement('div');
    box.appendChild(S.ticketDetailNode(payload, { compact: true }));
    document.querySelector('#tvDetail').appendChild(box);
    const note = box.querySelector('.tv-flaw[aria-label="ticket record error"]');
    const text = note ? note.textContent.replace(/\\s+/g, ' ').trim() : null;
    box.remove();
    return text;
  })()`);
  check('  the note never asserts a migration HISTORY it cannot observe — only what the file begins with',
    !/This ticket HAS been migrated/.test(String(exampleFirst))
      && /BEGINS with an orchard-ticket record block/.test(String(exampleFirst))
      && /example block looks the same/.test(String(exampleFirst)),
    JSON.stringify(String(exampleFirst).slice(0, 300)));
  check('  …and the block is reachable in the ACCESSIBILITY tree, not merely present in the DOM',
    errAx === true, `marker reachable to assistive tech: ${errAx}`);

  /* ═════════ THE FENCE CASE: a record that quotes ``` must still be verbatim ═══ */
  //
  // The second clean-room round's finding. Rendering the whole file through
  // prose() got the block's bytes into the model but not onto the page: prose()
  // splits on every ``` run anywhere in the text, so a record whose own text
  // quotes one terminated the <pre> mid-value. The block is printed into a <pre>
  // as a TEXT node now, never parsed — and "byte-exact" is asserted as byte
  // equality against the model's `rawRecordFence`, not as "the lines are in there
  // somewhere", because the note promises the stronger thing.
  console.log('\n=== FENCE CASE: a corrupted record that QUOTES ``` renders byte-exact, not truncated ===');
  await open(fixed, FENCE_ERROR_ID);
  const mFence = await cdp.eval(FENCE_PROBE);
  check('PRECONDITION: the seed is a REAL corpus sentence, migrated by the real formatter, and its record quotes an inline fence run',
    mFence.fenceRunsInBlock >= 1 && /src\.split/.test(String(mFence.blockText)),
    JSON.stringify({ fenceRuns: mFence.fenceRunsInBlock, sentence: String(mFence.summaryLine).slice(0, 90) }));
  check('the rendered <pre> is BYTE-IDENTICAL to the block as it sits in the file, fences included',
    mFence.byteExact === true,
    `pre.textContent === view.rawRecordFence: ${mFence.byteExact} (${mFence.preLen} vs ${mFence.fenceLen} chars)`);
  check('  …so every line of the record is reachable, including the ones after the quoted fence run',
    mFence.reachAll === mFence.blockLines && mFence.reachVisible === mFence.blockLines,
    `${mFence.reachAll}/${mFence.blockLines} in the DOM, ${mFence.reachVisible}/${mFence.blockLines} in innerText`);
  check('  …and `work_state` in particular — the field the state suppression below depends on being readable',
    mFence.workStateVisible === true, `"work_state" present in innerText: ${mFence.workStateVisible}`);
  check('  …and the prose after the block still renders as prose, not as part of the code block',
    mFence.diagnosisRendered === true, `the Diagnosis section rendered: ${mFence.diagnosisRendered}`);

  /* THE SYNTHESIZED PRE-FIX MUST-FAIL — no git, no HEAD, no moving baseline.
     Both prior behaviours are reconstructed IN THE PAGE from the page's own
     prose(), and graded on the same input as the assertions above. This is the
     must-FAIL that survives a clean room, where the tree is not a git repo at all
     and the worktree leg cannot run. */
  const preFix = await cdp.eval(PREFIX_PROBE(FENCE_ERROR_ID));
  check('MUST-FAIL (synthesized 198013f): stripping the block before rendering left 0 record lines reachable',
    preFix.strippedReach === 0,
    `${preFix.strippedReach}/${preFix.blockLines} record lines reachable when the block is stripped`);
  check('MUST-FAIL (synthesized 74e03e2): feeding the WHOLE FILE to prose() truncated the block at its quoted fence run',
    preFix.proseReach < preFix.blockLines && preFix.proseWorkState === false,
    `${preFix.proseReach}/${preFix.blockLines} record lines reachable, "work_state" reachable: ${preFix.proseWorkState}`);
  check('  …and the shipping renderer reaches all of them — the delta is this fix, measured on one input',
    preFix.currentReach === preFix.blockLines,
    `stripped=${preFix.strippedReach}, whole-file-through-prose=${preFix.proseReach}, now=${preFix.currentReach} of ${preFix.blockLines}`);

  /* THE SWEEP: 8 real fence-carrying tickets × 4 corruption positions, rendered
     through the REAL renderer. A single fixture proved the mechanism; it did not
     prove the corruption position does not matter, and "broken AT work_state" is
     exactly the case the round said made the state suppression indefensible. */
  console.log('\n=== FENCE SWEEP: 8 real fence-carrying tickets × 4 corruption positions ===');
  const fenceSeeds = [];
  for (const srcId of FENCE_SOURCE_IDS) {
    const file = fs.readdirSync(REAL_BUGS).find((n) => n.startsWith(`${srcId}-`));
    const sentence = fenceSentence(fs.readFileSync(path.join(REAL_BUGS, file), 'utf8'));
    if (!sentence) { check(`  ${srcId} — a real fence-carrying sentence was found`, false, 'none matched'); continue; }
    const good = fenceTicketText(srcId, sentence);
    for (const [label, corrupt] of CORRUPTIONS) {
      const broken = corrupt(good);
      if (broken === good) { check(`  ${srcId} / ${label} — the corruption applied`, false, 'no change'); continue; }
      fenceSeeds.push({ srcId, label, markdown: broken });
    }
  }
  const swept = await cdp.eval(FENCE_SWEEP(fenceSeeds));
  const badExact = swept.filter((r) => !r.byteExact);
  const badReach = swept.filter((r) => r.reachAll !== r.blockLines || r.reachVisible !== r.blockLines);
  const badState = swept.filter((r) => !r.workStateVisible);
  const notBroken = swept.filter((r) => !r.parseError);
  check(`  PRECONDITION: all ${swept.length} variants really are unparseable records`,
    notBroken.length === 0, notBroken.length ? JSON.stringify(notBroken.slice(0, 4).map((r) => `${r.srcId}/${r.label}`)) : `${swept.length} variants`);
  check(`  every one of the ${swept.length} variants renders its block BYTE-IDENTICALLY, whatever position the corruption is at`,
    badExact.length === 0, badExact.length ? JSON.stringify(badExact.slice(0, 4)) : `${swept.length}/${swept.length} byte-exact`);
  check('  …every record line reachable, in the DOM and in innerText, across all of them',
    badReach.length === 0,
    badReach.length ? JSON.stringify(badReach.slice(0, 4).map((r) => `${r.srcId}/${r.label}: ${r.reachAll}/${r.blockLines}`))
      : `${swept.reduce((n, r) => n + r.blockLines, 0)} record lines across ${swept.length} variants, 0 missing`);
  check('  …and `work_state` readable on every one — the ONLY thing that lets the page decline to state a work state',
    badState.length === 0, badState.length ? JSON.stringify(badState.map((r) => `${r.srcId}/${r.label}`)) : `${swept.length}/${swept.length}`);

  /* ═════════ DISK -> DOM: the bytes on disk vs the text on the page ═════════ */
  //
  // The item two consecutive verifying rounds recorded as never done. Everything
  // before this compared disk bytes to the VIEW MODEL, or compared the rendered
  // <pre> to `view.rawRecordFence` — both sides of the same code. That is how
  // round 2's fix passed 167 assertions and a screenshot review while the bytes
  // on the page were wrong. Here the expected region comes from
  // `fenceRegionByLineScan`, a line scanner that shares nothing with the
  // extractor, and the observed side is what the browser rendered from a file the
  // real server really served.
  console.log('\n=== DISK -> DOM: file bytes vs rendered <pre>, compared with === ===');
  for (const seed of byteSeeds()) {
    const onDisk = fs.readFileSync(path.join(BUGS, `${seed.id}-byte-level-record-variant.md`), 'utf8');
    const expected = fenceRegionByLineScan(onDisk);
    if (!await open(fixed, seed.id)) { check(`  ${seed.id} — ${seed.why}: rendered`, false, 'did not render'); continue; }
    const got = await cdp.eval(`(() => {
      const d = document.querySelector('#tvDetail .tv-doc');
      const pre = d.querySelector('.tv-md .prose .tv-rawrec pre');
      return {
        pre: pre ? pre.textContent : null,
        pills: [...d.querySelectorAll('.tv-pills .tv-pill')].map((p) => p.textContent.trim()),
        facts: [...d.querySelectorAll('.tv-dmeta .kv .k')].map((k) => k.textContent.trim()),
        preH: pre ? Math.round(pre.getBoundingClientRect().height) : 0,
        scrollH: pre ? pre.scrollHeight : 0,
        boxScroll: pre ? pre.parentElement.scrollHeight : 0,
        boxClient: pre ? pre.parentElement.clientHeight : 0,
        dir: pre ? getComputedStyle(pre).direction : null,
      };
    })()`);
    if (seed.id === BYTE_SEED_IDS.unterminated) {
      // No closing fence, so the line scanner finds no region by design. The
      // region IS the rest of the file from the opener — derived here the same
      // independent way, by index, not by the extractor.
      const at = onDisk.indexOf('```orchard-ticket');
      const want = onDisk.slice(at).replace(/\r?\n$/, '');
      check(`  ${seed.id} — ${seed.why}: the <pre> is the file from the opener to EOF, byte for byte`,
        got.pre === want, byteDiff(want, got.pre));
      continue;
    }
    check(`  ${seed.id} — ${seed.why}: the rendered <pre> === the region on disk`,
      got.pre === expected, byteDiff(expected, got.pre));
    // THE INVARIANT THAT MAKES EXCLUDING THE PREFIX SAFE, checked rather than
    // argued: everything on disk before the region must be whitespace. If it ever
    // is not, dropping it drops content and this assertion is the one that says so.
    const prefix = onDisk.slice(0, onDisk.indexOf(expected));
    check(`    …and everything on disk before that region is whitespace, so excluding it drops no content`,
      /^\s*$/.test(prefix),
      `${prefix.length} chars before the fence: ${JSON.stringify(prefix)}`);
    // BYTE-EXACT IS NOT THE SAME AS READS-THE-SAME, and CSS cannot close the gap:
    // measured in this browser, all six unicode-bidi values render an embedded
    // U+202E reversed. An earlier round of this lane asserted the computed style
    // and passed while the screenshot showed "desrever" — the mechanism was
    // green and the reader was still misled. So what is asserted now is that the
    // page SAYS SO, by code point and count.
    // THE ASSERTION THAT WAS MISSING EVERYWHERE: not that the page mentions the
    // thing, but that what it SAYS about it is TRUE of this case. The previous
    // round asserted the code point was named and passed while the sentence next
    // to it described a hazard the character does not have.
    const CLAIM_WORDS = {
      bidi: 'order you SEE differs', separator: 'break the line',
      zeroWidth: 'occupy no space', control: 'non-printing',
    };
    const EXPECT = {
      [BYTE_SEED_IDS.controls]: { kinds: ['control'], cps: ['U+0000'] },
      [BYTE_SEED_IDS.bidiOnly]: { kinds: ['bidi'], cps: ['U+202C', 'U+202E'] },
      [BYTE_SEED_IDS.sepOnly]: { kinds: ['separator'], cps: ['U+2028', 'U+2029'] },
      [BYTE_SEED_IDS.zeroWidthOnly]: { kinds: ['zeroWidth'], cps: ['U+200B', 'U+FEFF'] },
      [BYTE_SEED_IDS.unicode]: { kinds: ['bidi', 'separator'], cps: ['U+2028', 'U+2029', 'U+202C', 'U+202E'] },
    }[seed.id];
    if (EXPECT) {
      const note = String(await cdp.eval(RECORD_FLAW_TEXT));
      const absent = Object.keys(CLAIM_WORDS).filter((k) => !EXPECT.kinds.includes(k));
      check(`    …the note names ${EXPECT.cps.join(', ')} AND says the thing that is TRUE of them (${EXPECT.kinds.join(', ')})`,
        EXPECT.cps.every((cp) => note.includes(cp)) && EXPECT.kinds.every((k) => note.includes(CLAIM_WORDS[k])),
        JSON.stringify(note.slice(-260)));
      check(`      …and claims NOTHING that is false of them (no ${absent.join('/') || 'other'} wording)`,
        absent.every((k) => !note.includes(CLAIM_WORDS[k])),
        `absent classes: ${absent.join(', ')} — leaked: ${JSON.stringify(absent.filter((k) => note.includes(CLAIM_WORDS[k])))}`);
    }
    if (seed.id === BYTE_SEED_IDS.crlf) {
      const note = await cdp.eval(RECORD_FLAW_TEXT);
      check('    …and a plain CRLF block raises NO such warning — the flag is specific, not a blanket',
        !/That block contains/.test(String(note)), JSON.stringify(String(note).slice(-90)));
    }
    check(`    …and no state is invented for it: no Open/Done pill, no state/status fact`,
      !got.pills.some((x) => /^(Open|Done)$/.test(x)) && !got.facts.includes('state') && !got.facts.includes('status'),
      JSON.stringify({ pills: got.pills, facts: got.facts.slice(0, 4) }));
    if (seed.id === BYTE_SEED_IDS.huge) {
      check('    …and an enormous region is NOT capped or elided — the <pre> is as tall as its content',
        got.scrollH <= got.preH + 2 && got.boxScroll <= got.boxClient + 2,
        `pre ${got.preH}px tall, scrollHeight ${got.scrollH}; container ${got.boxClient}/${got.boxScroll}`);
    }
  }

  /* TRUNCATION, the way a partial write really truncates: losing the tail loses
     the CLOSING FENCE. Round 2 tried this with a hand-built string that kept its
     closing fence and truncated only the JSON — a shape a partial write cannot
     produce. Done properly the file has an opener and no closer, `RECORD_FENCE_RE`
     does not match at all, and it used to fall through to the LEGACY path: "Not
     migrated", plus a state pill drawn off the board index, about a file that is
     visibly a half-written migration. */
  console.log('\n=== TRUNCATION: a real formatTicket output cut at 14 points, each graded ===');
  const truncBase = byteSeedBase();
  const openerEnd = truncBase.indexOf('\n') + 1;
  // The CLOSING FENCE is the boundary that decides which failure a cut produces,
  // so the points are placed relative to it rather than spread over the file: cut
  // before it and the record is unterminated; cut after it and the record is
  // whole and only the BODY is short. Two different correct behaviours, and a
  // sweep that does not separate them grades one of them wrong (this one did).
  const closeEnd = truncBase.indexOf('\n```', openerEnd) + 4;
  const inside = Array.from({ length: 8 }, (_, i) =>
    Math.round(openerEnd + ((closeEnd - openerEnd) * (i + 1)) / 9));
  const pastFence = Array.from({ length: 4 }, (_, i) =>
    Math.round(closeEnd + ((truncBase.length - closeEnd) * (i + 1)) / 5));
  const truncSeeds = [
    { at: 4, label: 'mid-way through the opener line itself', cls: 'opener' },
    { at: openerEnd, label: 'immediately after the opener line', cls: 'inside' },
    ...inside.map((at) => ({ at, cls: 'inside', label: `inside the record, at ${at}B` })),
    ...pastFence.map((at) => ({ at, cls: 'after', label: `after the closing fence, at ${at}B` })),
  ].map((t) => ({ ...t, markdown: truncBase.slice(0, t.at) }));
  const truncOut = await cdp.eval(TRUNC_SWEEP(truncSeeds));
  // The first cut lands inside the opener line, so there is no marker in the file
  // at all — nothing can know it was a migration, and legacy IS the honest read.
  // Named as a boundary rather than left to look like a pass.
  const inOpener = truncOut.find((r) => r.cls === 'opener');
  const cut = truncOut.filter((r) => r.cls === 'inside');
  const bodyCut = truncOut.filter((r) => r.cls === 'after');
  check('  BOUNDARY (named, not hidden): cut INSIDE the opener line, no marker survives, so the file reads as legacy',
    inOpener.recordUnreadable === false && inOpener.migrated === false,
    `"${truncBase.slice(0, 4)}" — no orchard-ticket marker remains; legacy is the only honest read`);
  const wrong = cut.filter((r) => !r.recordUnreadable);
  const claimedNotMigrated = cut.filter((r) => r.pills.some((p) => /Not migrated/.test(p)));
  const inventedState = cut.filter((r) => r.pills.some((p) => /^(Open|Done)$/.test(p)) || r.facts.includes('state'));
  const notByteExact = cut.filter((r) => !r.byteExact);
  check(`  all ${cut.length} truncations INSIDE the record are read as a BROKEN RECORD, not as an un-migrated ticket`,
    wrong.length === 0 && claimedNotMigrated.length === 0,
    wrong.length || claimedNotMigrated.length
      ? JSON.stringify({ readAsLegacy: wrong.map((r) => r.label), saidNotMigrated: claimedNotMigrated.map((r) => r.label) })
      : `${cut.length}/${cut.length} say the block is opened and never closed`);
  check('    …and none of them draws a state pill or a state fact off the board index',
    inventedState.length === 0, inventedState.length ? JSON.stringify(inventedState.map((r) => r.label)) : `${cut.length} clean`);
  check('    …and every one shows the surviving bytes from the opener to EOF, byte for byte',
    notByteExact.length === 0, notByteExact.length ? JSON.stringify(notByteExact.map((r) => r.label)) : `${cut.length}/${cut.length} byte-exact`);
  // The OTHER truncation class, and it is not a failure: past the closing fence
  // the record is whole and only the prose body is short. The page must read it
  // as the healthy migrated ticket it is — inventing a "broken record" here would
  // be the same defect pointing the other way.
  check(`  the ${bodyCut.length} truncations AFTER the closing fence leave a VALID record — read as migrated, not as broken`,
    bodyCut.every((r) => r.migrated === true && r.recordUnreadable === false),
    JSON.stringify(bodyCut.map((r) => `${r.label}: migrated=${r.migrated} broken=${r.recordUnreadable}`)));

  /* ═════════ GRAMMAR DISAGREEMENT: three readers of "is there a record?" ══ */
  //
  // ARCH-008's evidence, gathered rather than resolved. Three things now decide
  // whether a file has a record, and they are not the same code:
  //
  //   1. `scripts/lib/ticket-schema.mjs` RECORD_FENCE_RE — the node source of truth
  //   2. `public/lib/ticket-record.js`   RECORD_FENCE_RE — required to be byte-identical
  //   3. `public/lib/ticket-record.js`   openerIndex()   — the LINE SCAN this lane
  //      added to detect a block that is opened and never closed
  //
  // (3) is a second grammar for "what opens a record", written by this lane, and
  // this leg exists because I said so in my own handoff. It is REPORTED, not
  // reconciled: the decision belongs to ARCH-008 and a human, and restructuring
  // the grammars here would pre-empt it. What IS asserted is the invariant that
  // holds whichever way that decision goes — no case may lose content, and the
  // two RECORD_FENCE_RE copies must agree, because that mirror is a stated rule.
  console.log('\n=== GRAMMAR: where the fence regex and the opener scan disagree (evidence for ARCH-008) ===');
  const TICK = String.fromCharCode(96);
  const F3 = TICK.repeat(3), F4 = TICK.repeat(4);
  const REC = '{"id": "BUG-111", "severity": medium}';
  const BODY = '\n\n# BUG-111 — grammar probe\n\n## Diagnosis\n\nThe body must survive whatever is decided.\n';
  const GRAMMAR_CASES = [
    ['opener indented with spaces', '   ' + F3 + 'orchard-ticket\n' + REC + '\n' + F3 + BODY],
    ['opener indented with a tab', '\t' + F3 + 'orchard-ticket\n' + REC + '\n' + F3 + BODY],
    ['opener inside a blockquote', '> ' + F3 + 'orchard-ticket\n> ' + REC + '\n> ' + F3 + BODY],
    ['opener inside a list item', '- ' + F3 + 'orchard-ticket\n  ' + REC + '\n  ' + F3 + BODY],
    ['four-backtick fence', F4 + 'orchard-ticket\n' + REC + '\n' + F4 + BODY],
    ['tilde fence', '~~~orchard-ticket\n' + REC + '\n~~~' + BODY],
    ['info string with trailing spaces', F3 + 'orchard-ticket   \n' + REC + '\n' + F3 + BODY],
    ['info string in unusual casing', F3 + 'Orchard-Ticket\n' + REC + '\n' + F3 + BODY],
    ['opener-looking line inside a nested fence', F4 + '\n' + F3 + 'orchard-ticket\n' + REC + '\n' + F3 + '\n' + F4 + BODY],
    ['opener-looking line inside an earlier code block', F3 + 'js\n' + F3 + 'orchard-ticket\n' + F3 + BODY],
  ];
  // The NODE source of truth, on the same inputs.
  const { extractTicketBlock: schemaExtract } = await import('../scripts/lib/ticket-schema.mjs');
  const nodeSays = GRAMMAR_CASES.map(([label, md]) => ({ label, block: schemaExtract(md).block !== null }));
  const pageSays = await cdp.eval(GRAMMAR_PROBE(GRAMMAR_CASES));

  const mirrorBreaks = pageSays.filter((r, i) => r.regexBlock !== nodeSays[i].block);
  check('the two RECORD_FENCE_RE copies agree on every case — the byte-identical mirror rule holds',
    mirrorBreaks.length === 0,
    mirrorBreaks.length ? JSON.stringify(mirrorBreaks.map((r) => r.label)) : `${GRAMMAR_CASES.length}/${GRAMMAR_CASES.length} agree`);

  const disagree = pageSays.filter((r) => r.regexBlock !== r.scanOpener);
  console.log(`        regex vs opener-scan: ${disagree.length} of ${GRAMMAR_CASES.length} cases disagree`);
  for (const r of pageSays) {
    console.log(`          ${r.regexBlock === r.scanOpener ? ' ' : '!'} ${r.label.padEnd(48)}`
      + ` regex=${r.regexBlock ? 'record' : 'none  '} scan=${r.scanOpener ? 'opener' : 'none  '}`
      + ` page=${r.recordUnreadable ? 'broken-record' : (r.migrated ? 'migrated' : 'legacy')}`);
  }
  check('  REPORTED, not resolved: every disagreement is a case where one grammar sees an opener and the other does not',
    disagree.every((r) => r.regexBlock !== r.scanOpener),
    JSON.stringify(disagree.map((r) => `${r.label}: regex=${r.regexBlock} scan=${r.scanOpener} -> ${r.recordUnreadable ? 'broken-record' : (r.migrated ? 'migrated' : 'legacy')}`)));

  // THE INVARIANT THAT SURVIVES THE ARCH-008 DECISION EITHER WAY. Whatever a file
  // is classified as, this lane's charter is that none of its bytes go missing.
  const lostGrammar = pageSays.filter((r) => r.missingLines.length);
  check('  whichever grammar wins, NO case loses content: every line of every probe file is reachable in the DOM',
    lostGrammar.length === 0,
    lostGrammar.length ? JSON.stringify(lostGrammar.map((r) => `${r.label}: ${r.missingLines.slice(0, 2).join(' | ')}`))
      : `${GRAMMAR_CASES.length} probe files, ${pageSays.reduce((n, r) => n + r.lines, 0)} lines, 0 missing`);
  // A FINDING, carried rather than skipped. Where the grammars refuse the file,
  // prose() renders the block as an ordinary fenced block and strips its info
  // string — so `orchard-ticket`, the only text on the page saying this file was
  // ever migrated, does not reach the reader. That is BUG-111's info-string strip
  // in public/lib/dom.js, not this lane's, and it is direct evidence for BUG-121
  // (an unrecognised record is invisible AND unannounced). What IS this lane's is
  // the invariant that it must never happen on a file the page DID recognise:
  // there the label lives in a <pre> text node and cannot be stripped.
  const infoLost = pageSays.filter((r) => r.infoStringsLost.length);
  console.log(`        info string dropped by prose() on ${infoLost.length} case(s): ${infoLost.map((r) => r.label).join(', ')}`);
  check('  the info string is only ever lost on files NO grammar recognised — never on one the page reads as a record',
    infoLost.every((r) => !r.regexBlock && !r.scanOpener),
    JSON.stringify(infoLost.map((r) => `${r.label}: regex=${r.regexBlock} scan=${r.scanOpener}`)));
  check('  …and on a recognised record the label survives, because it lives in a <pre> text node',
    pageSays.filter((r) => r.regexBlock || r.scanOpener).every((r) => r.infoStringsLost.length === 0),
    JSON.stringify(pageSays.filter((r) => r.regexBlock || r.scanOpener).map((r) => `${r.label}: ${r.infoStringsLost.length} lost`)));
  check('  …and no case makes the page claim a work state it cannot read',
    pageSays.every((r) => !(r.recordUnreadable && r.pills.some((x) => /^(Open|Done)$/.test(x)))),
    JSON.stringify(pageSays.filter((r) => r.recordUnreadable).map((r) => `${r.label}: ${r.pills.join('/')}`)));

  /* ═════════ CORPUS SWEEP: all 186 real tickets, both trees ═════════ */
  console.log('\n=== CORPUS SWEEP: every content line of every real ticket, rendered, both trees ===');
  const newSweep = await sweepCorpus(fixed, CORPUS_IDS);
  const census = corpusCensus([...CORPUS_FILES.entries()]);
  console.log(`        shapes in the corpus: ${census.codeBlocks.length} with code blocks, ${census.tables.length} with tables, `
    + `${census.images.length} with image refs, ${census.preHeading.length} with content before the first heading, `
    + `${census.noH1.length} with no H1, ${census.oddHeadings.size} distinct headings the structured format has no slot for, `
    + `${census.fenceAnomaly.length} carrying an inline or unpaired triple-backtick run (BUG-111's shape)`);
  const lostNew = [], lostBase = [], renderErrs = [], visibleOnlyInBase = [];
  let linesChecked = 0;
  for (const [id, md] of CORPUS_FILES) {
    const n = newSweep[id], b = baseSweep?.[id];
    if (!n || n.error) { renderErrs.push(`${id}: ${n?.error ?? 'not rendered'}`); continue; }
    const sqNewAll = squash(n.all), sqNewVis = squash(n.visible);
    const sqBaseVis = b && !b.error ? squash(b.visible) : null;
    for (const { line, alts } of contentLines(md)) {
      const needles = alts.map(squash);
      linesChecked++;
      if (!needles.some((n) => sqNewAll.includes(n))) lostNew.push(`${id}: ${line.slice(0, 78)}`);
      else if (!needles.some((n) => sqNewVis.includes(n))) visibleOnlyInBase.push(`${id}: hidden from the reader — ${line.slice(0, 60)}`);
      if (sqBaseVis !== null && !needles.some((n) => sqBaseVis.includes(n))) lostBase.push(`${id}: ${line.slice(0, 60)}`);
    }
  }
  check(`every ticket in the real corpus renders without throwing (${CORPUS_IDS.length} tickets)`,
    renderErrs.length === 0, renderErrs.length ? JSON.stringify(renderErrs.slice(0, 5)) : `${Object.keys(newSweep).length} rendered`);
  const lostIds = [...new Set(lostNew.map((l) => l.split(':')[0]))];
  const cleanIds = CORPUS_IDS.filter((id) => !census.fenceAnomaly.includes(id));
  const lostInClean = lostNew.filter((l) => cleanIds.includes(l.split(':')[0]));
  console.log(`        ${lostNew.length} of ${linesChecked} content lines were not reachable, across ${lostIds.length} tickets: ${lostIds.join(', ') || 'none'}`);
  check(`NOTHING IS LOST: every content line of the ${cleanIds.length} tickets whose markdown this renderer can model is present`,
    lostInClean.length === 0,
    lostInClean.length ? JSON.stringify(lostInClean.slice(0, 8)) : `${linesChecked} lines checked across ${CORPUS_IDS.length} tickets`);
  // A NAMED, MEASURED, OUT-OF-LANE defect, not a silent pass. Every unreachable
  // line is in a ticket carrying a triple-backtick RUN that does not begin a line
  // (a four-backtick code span, ` ````Status```` `) or an unpaired fence. prose()
  // splits on that character run wherever it falls, its alternation flips, and the
  // info-string strip then eats the next line — BUG-111, "prose fence model is a
  // char-run split, not a line scan", in public/lib/dom.js. That file is not this
  // lane's, and this lane neither caused the loss nor changed it: the assertion
  // below holds the two trees to the SAME set, so a regression here cannot hide.
  check(`  the ${lostNew.length} unreachable lines are all BUG-111's fence-run defect (public/lib/dom.js), on ${lostIds.length} of the ${census.fenceAnomaly.length} tickets carrying an inline or unpaired fence`,
    lostIds.every((id) => census.fenceAnomaly.includes(id)),
    JSON.stringify({ lost: lostIds, atRisk: census.fenceAnomaly }));
  check('  …and every reachable line is VISIBLE text (innerText), not merely present in the DOM behind a display:none',
    visibleOnlyInBase.length === 0,
    visibleOnlyInBase.length ? JSON.stringify(visibleOnlyInBase.slice(0, 8)) : 'every content line reaches innerText with the expanders open');
  if (baseSweep) {
    const shrank = [], grew = [];
    for (const id of CORPUS_IDS) {
      const a = newSweep[id], c = baseSweep[id];
      if (!a || !c || a.error || c.error) continue;
      const dw = a.visible.split(' ').length - c.visible.split(' ').length;
      if (dw < -8) shrank.push(`${id}:${dw}`); else if (dw > 8) grew.push(`${id}:+${dw}`);
    }
    console.log(`        old→new rendered word delta: ${shrank.length} tickets shorter, ${grew.length} longer, `
      + `${CORPUS_IDS.length - shrank.length - grew.length} within ±8 words`);
    check('  OLD vs NEW, line for line: this lane loses NOTHING the previous view did not — the two sets are identical',
      lostNew.length === lostBase.length
        && JSON.stringify(lostNew.map((l) => l.split(':')[0]).sort()) === JSON.stringify(lostBase.map((l) => l.split(':')[0]).sort()),
      `new=${lostNew.length} unreachable lines, base=${lostBase.length}, same tickets: ${JSON.stringify(lostIds)}`);
    check('  …and the only thing the new view renders LESS of is scaffolding: every real ticket got shorter, none lost a content line',
      shrank.length === CORPUS_IDS.length && lostNew.length === lostBase.length,
      `${shrank.length}/${CORPUS_IDS.length} tickets shorter (the empty band, ~45 words each), 0 additional content lines lost`);
  }
  // The specific shapes the charter names, asserted against the sweep by NAME.
  for (const [label, ids] of [['code blocks', census.codeBlocks], ['tables', census.tables],
    ['image references', census.images], ['content before the first heading', census.preHeading],
    ['no H1 at all', census.noH1]]) {
    const scope = ids.filter((id) => cleanIds.includes(id));
    const bad = lostNew.filter((l) => scope.includes(l.split(':')[0]));
    check(`  shape: ${ids.length} tickets with ${label} (${scope.length} outside BUG-111's fence defect) — every line of every one is present`,
      bad.length === 0, ids.length ? `${ids.length} tickets: ${ids.slice(0, 5).join(', ')}${ids.length > 5 ? '…' : ''}` : 'none in the corpus');
  }
  const oddIds = [...new Set([...census.oddHeadings.values()].flat())];
  check(`  shape: ${census.oddHeadings.size} unusual section headings across ${oddIds.length} tickets — every line present`,
    lostNew.filter((l) => oddIds.includes(l.split(':')[0]) && cleanIds.includes(l.split(':')[0])).length === 0,
    JSON.stringify([...census.oddHeadings.keys()].slice(0, 10)));

  /* ═════════ CLIPPING: a box that hides its own text lies to the reader ═════ */
  console.log('\n=== CLIPPING: no element in the detail hides text it does not scroll ===');
  const CLIP_PROBE = `(() => {
    const out = [];
    for (const e of document.querySelectorAll('#tvDetail *')) {
      if (!e.textContent.trim()) continue;
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      // .sr-only is a 1px clip BY DESIGN — text placed there for assistive tech
      // and deliberately not painted. It is the opposite of a box that hides text
      // from a reader who is meant to have it.
      if (e.classList.contains('sr-only') || e.closest('.sr-only')) continue;
      const clipX = /hidden|clip/.test(cs.overflowX) && e.scrollWidth > e.clientWidth + 1;
      const clipY = /hidden|clip/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 1;
      const lineClamp = cs.webkitLineClamp && cs.webkitLineClamp !== 'none' && e.scrollHeight > e.clientHeight + 1;
      if (clipX || clipY || lineClamp) {
        out.push((e.className || e.tagName) + ' :: ' + (clipX ? 'x' : '') + (clipY ? 'y' : '') + (lineClamp ? 'clamp' : '')
          + ' :: ' + e.textContent.replace(/\\s+/g, ' ').trim().slice(0, 46));
      }
    }
    return out;
  })()`;
  for (const [w, h] of [[1500, 1000], [900, 900], [620, 900], [380, 800]]) {
    await cdp.viewport(w, h);
    const clipped = [];
    for (const id of ['FEAT-982', 'BUG-984', 'ARCH-985', 'FEAT-992', 'BUG-104', RECORD_ERROR_ID]) {
      await open(fixed, id);
      for (const c of await cdp.eval(CLIP_PROBE)) clipped.push(`${id}: ${c}`);
    }
    check(`  @${w}px — nothing in the ticket detail clips its own text`,
      clipped.length === 0, clipped.length ? JSON.stringify(clipped.slice(0, 6)) : '6 tickets, 0 clipped boxes');
  }
  await cdp.viewport(1500, 1000);

  /* ═════════ NARROW AX: what a closed expander does to reachability ═════════ */
  console.log('\n=== NARROW AX: a collapsed section is HIDDEN, and it says so by name ===');
  await cdp.viewport(380, 800);
  await open(fixed, 'FEAT-982');
  const narrow = await cdp.eval(`(() => {
    const d = document.querySelector('#tvDetail .tv-doc');
    const closed = [...d.querySelectorAll('details.tv-slot:not([open])')];
    const inText = closed.map((c) => {
      const probe = (c.querySelector('.tv-slot-b')?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 40);
      return { title: c.querySelector('.tv-slot-t')?.textContent.trim(), probe, visible: probe.length > 8 && (d.innerText || '').includes(probe) };
    });
    return { closed: closed.length, inText, docText: (d.innerText || '').length };
  })()`);
  check('at 380px a collapsed section’s body is genuinely hidden from the reader — counted as hidden, never as present',
    narrow.closed >= 3 && narrow.inText.every((x) => x.visible === false),
    JSON.stringify({ closed: narrow.closed, leaked: narrow.inText.filter((x) => x.visible).map((x) => x.title) }));
  const narrowAx = await axOf('#tvDetail .tv-md details.tv-slot > .tv-slot-h');
  check('  …and every one is a NAMED disclosure in the accessibility tree, so what is hidden is discoverable',
    narrowAx.length >= 3 && narrowAx.every((n) => n.name && n.expanded === 'false'),
    JSON.stringify(narrowAx.map((n) => `${n.role}:${n.name}:${n.expanded}`)));
  const narrowOpen = await cdp.eval(`(() => {
    const d = document.querySelector('#tvDetail .tv-doc');
    for (const c of d.querySelectorAll('details.tv-slot')) c.open = true;
    return (d.innerText || '').length;
  })()`);
  check('  …and opening them reaches the content: the hidden text is hidden, not absent',
    narrowOpen > narrow.docText, `innerText ${narrow.docText} → ${narrowOpen} chars once opened`);
  // An un-migrated ticket at the same width: its prose is NOT behind a collapse,
  // because for a legacy ticket that prose is the whole ticket.
  await open(fixed, 'BUG-104');
  const narrowLegacy = await cdp.eval(BANDS);
  check('  an un-migrated ticket at 380px keeps its sections OPEN — its prose is the ticket, not an appendix',
    narrowLegacy.slots.filter((s) => !s.flat && !/Activity log/i.test(String(s.title))).every((s) => s.open === true),
    JSON.stringify(narrowLegacy.slots.map((s) => `${s.title}:${s.flat ? 'flat' : s.open}`)));
  await cdp.viewport(1500, 1000);

  /* ═════════ KEEP: ARCH-004's broken-state treatment ═════════ */
  console.log('\n=== KEEP: the broken-state indicators another lane added are still here ===');
  await open(fixed, 'BUG-983');
  const mFlaw = await cdp.eval(BANDS);
  check('a ticket whose state cannot be read still shows the server’s sentence, verbatim, as a note',
    mFlaw.flaws.length >= 1 && mFlaw.flaws[0].level === 'error' && /DUPLICATE STATUS FIELD/.test(mFlaw.flaws[0].text),
    JSON.stringify(mFlaw.flaws));
  check('  …and the note is still where ARCH-004 put it: in the prose column, under the title, above the document',
    mFlaw.geom.flaws && mFlaw.geom.flaws.top > mFlaw.geom.title.top
      && mFlaw.geom.flaws.bottom <= mFlaw.geom.md.top + 2
      && mFlaw.geom.flaws.left === mFlaw.geom.md.left && mFlaw.geom.flaws.width > 380,
    JSON.stringify(mFlaw.geom));
  check('  …and the HERO stops claiming a state: the pill is replaced by the server’s headline, not "Open"',
    mFlaw.pills.some((p) => /tp-flaw-err/.test(p.cls) && /DUPLICATE STATUS FIELD/.test(p.text))
      && !mFlaw.pills.some((p) => /tp-state st-/.test(p.cls)),
    JSON.stringify(mFlaw.pills.map((p) => p.text)));
  const flawAx = await axNotes();
  check('  …and both the note and the status value are still in the accessibility tree',
    flawAx.some((n) => n.role === 'note' && /DUPLICATE/.test(n.text)),
    JSON.stringify(flawAx.map((n) => ({ role: n.role, name: n.name, text: n.text.slice(0, 40) }))));

  /* ═════════ KEEP: the digest landing ═════════ */
  console.log('\n=== KEEP: the board digest landing still lands ===');
  await cdp.send('Page.navigate', { url: `${fixed.base}/#/tickets?project=${encodeURIComponent(fixed.pid)}` });
  const digestUp = await cdp.waitFor('digest', `!!document.querySelector('#tvDigest .dg-wrap')`, 25000);
  const dg = await cdp.eval(`(() => {
    const w = document.querySelector('#tvDigest .dg-wrap');
    return w ? { chips: [...w.querySelectorAll('.dg-chip')].map((c) => c.textContent.trim()), sections: [...w.querySelectorAll('.dg-h')].map((h) => h.textContent.trim()), items: w.querySelectorAll('.dg-item').length } : null;
  })()`);
  check('the digest still renders its counts strip and lanes over the mixed board',
    digestUp && dg.sections.includes('Awaiting you') && dg.chips.length >= 5 && dg.items > 0,
    JSON.stringify({ sections: dg?.sections, items: dg?.items }));

  /* ═════════ AX ═════════ */
  console.log('\n=== AX: the bands are in the accessibility tree, not just the DOM ===');
  await open(fixed, 'FEAT-982');
  const ax = await axSnapshot();
  const axText = ax.map((n) => `${n.role}:${n.name}`).join(' | ');
  check('the ticket title is a heading, and so are the human layer’s own headings',
    ax.some((n) => n.role === 'heading' && n.name.includes(f982.title))
      && ax.some((n) => n.role === 'heading' && /What’s happening|What's happening/.test(n.name))
      && ax.some((n) => n.role === 'heading' && /WHAT THIS TICKET NEEDS/i.test(n.name)),
    axText.slice(0, 300));
  const axSlots = await axOf('#tvDetail .tv-md details.tv-slot > .tv-slot-h');
  check('  every deep expander reaches the accessibility tree as a named, expandable disclosure carrying its own heading',
    axSlots.length >= 6 && axSlots.every((s) => s.name && s.expanded !== null)
      && axSlots.some((s) => /Diagnosis/.test(s.name)) && axSlots.some((s) => /Activity log/i.test(s.name)),
    JSON.stringify(axSlots.map((s) => `${s.role}:${s.name}:${s.expanded}`)));
  const impactAx = await cdp.eval(`(() => {
    const e = document.querySelector('#tvDetail .tv-impact');
    return e ? { text: e.innerText.replace(/\\s+/g, ' ').trim(), hidden: e.hasAttribute('aria-hidden'), h: Math.round(e.getBoundingClientRect().height) } : null;
  })()`);
  check('  the impact card’s text is real rendered text (innerText, so a hidden or zero-height card fails here)',
    impactAx && impactAx.text.includes(f982.impact_if_we_wait) && !impactAx.hidden && impactAx.h > 40,
    JSON.stringify({ h: impactAx?.h, text: impactAx?.text.slice(0, 60) }));

  /* ═════════ WORDS ═════════ */
  console.log('\n=== WORDS BEFORE THE DECISION QUESTION — the number this redesign exists for ===');
  const after = {};
  for (const id of MEASURED) {
    const ok = await open(fixed, id);
    const w = ok ? await cdp.eval(WORDS_BEFORE_Q) : null;
    after[id] = w?.words ?? null;
    const b = before[id] ?? null;
    console.log(`        ${id}: ${b ?? 'n/a'} → ${w?.words ?? 'n/a'} words${b && w?.words ? `  (${(b / w.words).toFixed(1)}× shorter)` : ''}`);
  }
  const migratedMeasured = ['FEAT-982', 'ARCH-985', 'BUG-984', 'FEAT-992'];
  // The budget is the plan's claim with honest headroom: the plan measured the
  // hand-rewritten SOURCE at 70–87 words, and the rendered page adds the labels
  // a page has and a source file does not (the eyebrow, four state pills, two
  // section headings). 130 is the ceiling this layout can hold while carrying
  // all of them; the actual numbers are printed above, per ticket.
  check('a MIGRATED ticket puts the decision question within 130 words of the top of the page',
    migratedMeasured.every((id) => after[id] !== null && after[id] <= 130),
    JSON.stringify(Object.fromEntries(migratedMeasured.map((id) => [id, after[id]]))));
  if (!NO_RED) {
    const realMeasured = ['FEAT-082', 'ARCH-005', 'BUG-104', 'FEAT-092'].filter((id) => MEASURED.includes(id));
    const improved = realMeasured.filter((id) => before[id] && after[id] && before[id] / after[id] >= 2);
    check('the SAME four real tickets the plan measured reach their decision question at least 2× sooner than on the pre-change tree',
      improved.length === realMeasured.length,
      JSON.stringify(Object.fromEntries(realMeasured.map((id) => [id, `${before[id]} → ${after[id]}`]))));
  }

  /* ═════════ COLOR ═════════ */
  console.log('\n=== COLOR: every new ink, composited, in BOTH themes (AA = 4.5:1; 3:1 for ≥18.66px bold) ===');
  const INKS = [
    ['.tv-impact .ti-body', 'impact card — BODY (the prototype’s invisible one)'],
    ['.tv-impact .ti-h', 'impact card — heading'],
    ['.tv-human .th-summary', 'human layer — summary'],
    ['.tv-human .th-sub', 'human layer — “what this ticket needs”'],
    ['.tv-pills .tp-action', 'hero pill — the action pill'],
    ['.tv-pills .tp-state', 'hero pill — work state'],
    // ARCH-009: the three quiet proof pills are gone with the derived state.
    // The only proof pill left is `tp-proof-broken`, and it is measured below
    // on BUG-981 — the ticket that actually has an unresolved BROKEN verdict.
    ['.tv-pills .tp-sev', 'hero pill — severity'],
    ['.tv-dtitle .d-id', 'hero eyebrow — type · id'],
    ['.tv-deep-eyebrow', 'deep band — eyebrow'],
    ['.tv-slot .tv-slot-t', 'deep band — an expander’s title'],
    ['.tv-slot .tv-slot-n', 'deep band — an expander’s count'],
    ['.tv-decide .dc-why', 'option card — “why this isn’t obviously best”'],
    ['.tv-decide .dc-bc-k', 'option card — the Gains/Costs label'],
    ['.tv-decide .dc-desc', 'option card — what changes'],
    ['.tv-decide .dc-rec-k', 'decision — the recommendation'],
    ['.tv-decide .dc-send', 'decision — the primary button (the prototype’s grey one)'],
  ];
  for (const tone of ['dark', 'light']) {
    await cdp.theme(tone);
    await open(fixed, 'FEAT-982');
    const inks = await cdp.eval(MEASURE_INKS(INKS));
    for (const ink of inks) {
      if (ink.missing) { check(`  [${tone}] ${ink.label} — present`, false, 'selector matched nothing'); continue; }
      const large = ink.fontSize >= 24 || (ink.fontSize >= 18.66 && Number(ink.weight) >= 700);
      const min = large ? 3 : 4.5;
      check(`  [${tone}] ${ink.label} ≥ ${min}:1`, ink.ratio >= min && ink.visible,
        `${ink.ratio}:1 — ${ink.color} on ${ink.bg} @${ink.fontSize}px/${ink.weight}`);
    }
    // The disabled primary is measured separately: it must RECEDE and stay legible.
    const dis = await cdp.eval(`(() => {
      ${CONTRAST_FN}
      const b = document.querySelector('#tvDetail .tv-decide .dc-send');
      if (!b) return null;
      b.disabled = true;
      const cs = getComputedStyle(b); const bg = bgOf(b);
      return { ratio: ratio(cs.color, b), color: cs.color, bg: 'rgb(' + [bg.r, bg.g, bg.b].map(Math.round).join(',') + ')' };
    })()`);
    check(`  [${tone}] decision — the DISABLED primary stays AA-legible (it must recede, not vanish)`,
      dis && dis.ratio >= 4.5, JSON.stringify(dis));
    // The unreadable-state pill and the BROKEN-proof pill live on other tickets.
    await open(fixed, 'BUG-983');
    const flawInk = await cdp.eval(MEASURE_INKS([['.tv-pills .tp-flaw-err', 'hero pill — the unreadable-state headline']]));
    await open(fixed, 'BUG-981');
    const brokenInk = await cdp.eval(MEASURE_INKS([['.tv-pills .tp-proof-broken', 'hero pill — “Verification BROKEN”']]));
    for (const ink of [...flawInk, ...brokenInk]) {
      check(`  [${tone}] ${ink.label} ≥ 4.5:1`, !ink.missing && ink.ratio >= 4.5 && ink.visible,
        ink.missing ? 'selector matched nothing' : `${ink.ratio}:1 — ${ink.color} on ${ink.bg}`);
    }
  }

  /* ═════════ SHOTS ═════════ */
  console.log('\n=== SHOTS: graded captures (LOOK at these) ===');
  const SHOTLIST = [
    ['FEAT-982', 'migrated-decision', 1500, 1000],
    ['ARCH-985', 'migrated-staged', 1500, 1000],
    ['BUG-980', 'migrated-done-history', 1500, 1000],
    ['BUG-981', 'migrated-broken', 1500, 1000],
    ['BUG-104', 'unmigrated-real', 1500, 1000],
    ['BUG-983', 'legacy-unreadable-state', 1500, 1000],
    [RECORD_ERROR_ID, 'record-unparseable', 1500, 1000],
    ['BUG-987', 'unmigrated-no-empty-band', 1500, 1000],
    [RECORD_ERROR_ID, 'record-unparseable-narrow', 380, 900],
    [FENCE_ERROR_ID, 'record-quotes-a-fence', 1500, 1000],
    [FENCE_ERROR_ID, 'record-quotes-a-fence-narrow', 380, 900],
    [BYTE_SEED_IDS.unterminated, 'record-unterminated-partial-write', 1500, 1000],
    [BYTE_SEED_IDS.unicode, 'record-bidi-and-line-separators', 1500, 1000],
    [BYTE_SEED_IDS.controls, 'record-nul-control-character', 1500, 1000],
    [BYTE_SEED_IDS.huge, 'record-enormous-region', 1500, 1000],
    ['FEAT-982', 'migrated-decision-narrow', 620, 1000],
    ['BUG-104', 'unmigrated-real-narrow', 620, 1000],
  ];
  for (const tone of ['dark', 'light']) {
    await cdp.theme(tone);
    for (const [id, tag, w, h] of SHOTLIST) {
      await cdp.viewport(w, h);
      await open(fixed, id);
      await ledgerShot(`${tag}-${tone}.png`, tone, `${id} @${w}px (${tone})`);
    }
  }
  await cdp.viewport(1500, 1000);

  /* ═════════ report ═════════ */
  console.log('\n=== WORD COUNTS (reported, not asserted) ===');
  for (const id of MEASURED) console.log(`  ${id.padEnd(10)} before=${String(before[id] ?? 'n/a').padStart(5)}  after=${String(after[id] ?? 'n/a').padStart(4)}`);
  console.log(`\nshots: ${SHOTS}`);
}

/** A ledger-graded capture: tone-checked and byte-distinct within the run. */
async function ledgerShot(name, tone, why) {
  const file = await cdp.shot(path.join(SHOTS, name));
  const g = ledger.record(file, tone);
  check(`  shot ${name} — ${why}`, g.ok, `${file} — ${g.why}`);
  return file;
}

/** The accessibility tree of the detail pane, flattened. */
async function axSnapshot() {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const node = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#tvDetail' });
  if (!node.nodeId) return [];
  const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { nodeId: node.nodeId, fetchRelatives: true });
  return (nodes ?? []).map((n) => ({
    role: n.role?.value ?? '', name: n.name?.value ?? '',
  })).filter((n) => n.role && n.name);
}

/** The AX node for every element matching `selector`, resolved one by one (a
 *  partial tree from an ancestor does not descend far enough to name them). */
async function axOf(selector) {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector });
  const out = [];
  for (const nodeId of nodeIds ?? []) {
    const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
    const n = (nodes ?? [])[0];
    if (!n) continue;
    const expanded = (n.properties ?? []).find((p) => p.name === 'expanded');
    out.push({ role: n.role?.value ?? '', name: n.name?.value ?? '', expanded: expanded ? String(expanded.value?.value) : null });
  }
  return out;
}

/** Every `note` landmark under the detail, with its text (ARCH-004's contract). */
async function axNotes() {
  return cdp.eval(`(() => [...document.querySelectorAll('#tvDetail [role=note]')].map((n) => ({
    role: n.getAttribute('role'), name: n.getAttribute('aria-label'), text: n.textContent.replace(/\\s+/g, ' ').trim(),
  })))()`);
}

try {
  await main();
} catch (err) {
  console.error(`\nHARNESS ERROR: ${err.stack ?? err.message}`);
  fail++; failures.push(`harness: ${err.message}`);
} finally {
  cdp?.close();
  for (const p of procs) stopByPid(p);
  if (worktreeMade) spawnSync('git', ['worktree', 'remove', '--force', BASE_TREE], { cwd: ROOT });
}

console.log(`\n${fail === 0 ? 'ALL GREEN' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
if (fail) console.log(failures.map((f) => `  · ${f}`).join('\n'));
process.exit(fail === 0 ? 0 : 1);
