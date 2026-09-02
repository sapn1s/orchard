/**
 * FEAT-113 — the system prompt must be byte-stable across a session's resumes.
 *
 *   node scripts/verify-feat-113-system-prompt-stable.mjs
 *
 * The cost finding (FEAT-113 activity log) measured ~$318/month of full-prefix
 * cache rebuilds attributed by the provider to `cache_miss_reason:system_changed`
 * — the system prompt's bytes differing between requests on the real long-lived
 * orchestrator session. The suspect: the LIVE board snapshot
 * (boardStateSection) was folded INTO the system prompt at every launch/resume.
 * A board changes every time a ticket is filed or a status flips, so the system
 * block was rewritten on every resume, busting the entire cached prefix (the
 * Anthropic prompt cache keys the whole system block as one prefix segment).
 *
 * This reproduces the launch-time assembly with the REAL compose layer over a
 * REALISTIC busy board, then mutates the board the way a real mid-session hour
 * does (file a ticket, flip a status, answer a needs-you) and re-assembles —
 * modelling two consecutive resumes of the same session.
 *
 *   PART A (must-FAIL / the bug): the OLD assembly = board folded INTO the
 *   system prompt. System bytes DIFFER between the two board states.
 *
 *   PART B (the fix): the NEW assembly = board kept OUT of the system prompt and
 *   folded into the FIRST TURN instead. System bytes are IDENTICAL across the
 *   two board states, AND the board snapshot is still present in the first turn
 *   both times AND reflects the live change (nothing lost, still current).
 *
 * No server, no port 4317: pure in-process compose against throwaway temp dirs,
 * mirroring scripts/verify-boot-aware.mjs.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f113-data-'));
const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f113-proj-'));
process.env.CLAUDE_STATION_DATA = DATA;

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
const appendOf = (sp) => (typeof sp === 'string' ? sp : sp && typeof sp === 'object' ? sp.append : '');

// Write a realistic, BUSY board (many open items, mixed states) — not the
// minimal 2-row fixture. INDEX.md is what readBoard()/boardStateSection() read.
function writeBoard(rows) {
  const bugs = path.join(PROJ, 'docs', 'bugs');
  fs.mkdirSync(bugs, { recursive: true });
  const open = rows.map((r) => `| ${r.id} | ${r.title} | ${r.owner} | ${r.status} | ${r.sev} |`).join('\n');
  fs.writeFileSync(path.join(bugs, 'INDEX.md'),
    `# Board\n\n## Open\n\n` +
    `| ID | Title | Owner | Status | Sev |\n` +
    `|----|-------|-------|--------|-----|\n${open}\n\n` +
    `## Done (committed)\n\n| ID | Title | Commit |\n|----|-------|--------|\n`);
  for (const r of rows) {
    fs.writeFileSync(path.join(bugs, `${r.id}-x.md`), `# ${r.id} — ${r.title}\n\n- **Status:** OPEN\n`);
  }
}

// The launch-time first-turn assembly, copied faithfully from agent-bridge.ts
// (FEAT-113): board snapshot leads the turn, then the user's prompt.
function assembleFirstTurn(boardSnapshot, userPrompt) {
  return [boardSnapshot, userPrompt]
    .filter((s) => !!s && !!s.trim())
    .join('\n\n---\n\n');
}

async function main() {
  const { boardStateSection } = await import(path.join(ROOT, 'src', 'server', 'board.ts'));
  const { composeInstructions, appendToSystemPrompt, seedTemplates } =
    await import(path.join(ROOT, 'src', 'server', 'templates.ts'));

  seedTemplates();
  // The full launch stack: WA + routing + response-format — exactly what the
  // agent-bridge launch composes (minus the per-project local conventions doc,
  // absent here). This is the stable base whose bytes must not move.
  const composed = composeInstructions(
    [{ templateId: 'working-agreement-v2' }],
    { routing: true, responseFormat: true },
  );
  const baseSystem = appendToSystemPrompt(composed.systemPrompt, undefined); // == composed.systemPrompt
  check('PRECONDITION: composed system prompt is non-trivial (WA + folds)',
    appendOf(baseSystem).length > 400, `${appendOf(baseSystem).length} bytes`);

  // ---- STATE 1: a busy board at the start of a resumed turn ----
  writeBoard([
    { id: 'BUG-801', title: 'importer halts on malformed rows', owner: '👤', status: 'needs decision', sev: 'high' },
    { id: 'FEAT-802', title: 'wire export button to new endpoint', owner: '👤', status: 'needs decision', sev: 'med' },
    { id: 'BUG-803', title: 'flaky retry loop under load', owner: '🤖', status: 'building', sev: 'med' },
    { id: 'FEAT-804', title: 'per-project service sidecars', owner: '🤖', status: 'building', sev: 'med' },
    { id: 'BUG-805', title: 'git sync control stuck on working', owner: '🤖', status: 'building', sev: 'low' },
  ]);
  const board1 = boardStateSection(PROJ);
  check('board snapshot is produced for state 1', typeof board1 === 'string' && board1.length > 0, typeof board1);

  // ---- STATE 2: one real mid-session hour later — a ticket filed, a status
  // flipped, a needs-you answered. THE BOARD CHANGED, as it always does. ----
  writeBoard([
    { id: 'BUG-801', title: 'importer halts on malformed rows', owner: '🤖', status: 'building', sev: 'high' }, // answered → dispatched
    { id: 'FEAT-802', title: 'wire export button to new endpoint', owner: '👤', status: 'needs decision', sev: 'med' },
    { id: 'BUG-803', title: 'flaky retry loop under load', owner: '🤖', status: 'building', sev: 'med' },
    { id: 'FEAT-804', title: 'per-project service sidecars', owner: '🤖', status: 'building', sev: 'med' },
    { id: 'BUG-805', title: 'git sync control stuck on working', owner: '🤖', status: 'building', sev: 'low' },
    { id: 'BUG-806', title: 'NEW: sole-tab reads not driving after reload', owner: '👤', status: 'needs decision', sev: 'high' }, // filed mid-session
  ]);
  const board2 = boardStateSection(PROJ);
  check('board snapshot changed between the two states (realistic churn)',
    board1 !== board2, board1 === board2 ? 'IDENTICAL (fixture did not model churn!)' : 'differ as expected');

  // ================= PART A — the OLD assembly (the bug) =================
  // Board folded INTO the system prompt, as agent-bridge did before FEAT-113.
  const oldSys1 = appendOf(appendToSystemPrompt(baseSystem, board1));
  const oldSys2 = appendOf(appendToSystemPrompt(baseSystem, board2));
  check('PART A (bug reproduced): OLD system prompt DIFFERS across resumes → cache_miss system_changed',
    oldSys1 !== oldSys2,
    oldSys1 === oldSys2 ? 'identical (bug NOT reproduced)' : `differ by ${Math.abs(oldSys1.length - oldSys2.length)}+ bytes`);

  // ================= PART B — the NEW assembly (the fix) =================
  // Board kept OUT of the system prompt; system == the stable base both times.
  const newSys1 = appendOf(baseSystem);
  const newSys2 = appendOf(baseSystem);
  check('PART B (fixed): NEW system prompt is BYTE-IDENTICAL across resumes → cached prefix survives',
    newSys1 === newSys2 && newSys1.length > 400,
    `identical=${newSys1 === newSys2}, bytes=${newSys1.length}`);
  check('PART B: the NEW system prompt contains NO board snapshot (volatile content evicted)',
    !newSys1.includes('Project state (live board snapshot)'),
    newSys1.includes('Project state (live board snapshot)') ? 'STILL in system (leak!)' : 'clean');

  // Nothing lost: the board still reaches the session, in the FIRST TURN, and it
  // is the LIVE snapshot both times.
  const turn1 = assembleFirstTurn(board1, 'orchestrator: continue');
  const turn2 = assembleFirstTurn(board2, 'orchestrator: continue');
  check('PART B: first turn 1 CARRIES the live board snapshot (nothing lost)',
    turn1.includes('Project state (live board snapshot)') && turn1.includes('BUG-801'), 'snapshot present in turn 1');
  check('PART B: first turn 2 CARRIES the UPDATED board (newly-filed BUG-806 reaches the session)',
    turn2.includes('BUG-806') && /Needs you \(2\)/.test(turn2), 'updated snapshot present in turn 2');
  check('PART B: the live board CHURN now lives in the (uncached) first turn, not the system prefix',
    turn1 !== turn2 && newSys1 === newSys2, 'churn moved off the cached prefix');

  // A board-less project must still assemble a valid (board-free) first turn.
  const none = boardStateSection(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f113-noboard-')));
  check('a board-less project injects NO snapshot (opt-in preserved)', none === null, none);
  check('board-less first turn == just the user prompt (no empty separators)',
    assembleFirstTurn(none, 'hello') === 'hello', assembleFirstTurn(none, 'hello'));

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(() => {
  for (const d of [DATA, PROJ]) fs.rmSync(d, { recursive: true, force: true });
});
