#!/usr/bin/env node
/**
 * FEAT-100 — the four facts a dispatch declares, and the report that uses them.
 *
 *   node scripts/verify-feat-100-declared-dispatch.mjs
 *
 * WHAT IS BEING PROVEN, AND WHAT WOULD MAKE IT FALSE
 * --------------------------------------------------
 * The claim is not "a parser parses". It is:
 *
 *   1. A fact the DISPATCHER declared reaches the report unchanged, on both
 *      dispatch paths (`scripts/dispatch.mjs` and an in-process charter).
 *   2. A fact NOT declared is reported as ABSENT — never inferred, never filled
 *      in from the tool-derived phase map, never guessed from a prose mention.
 *   3. Where a declaration and an inference DISAGREE, the declaration wins and
 *      the inference is still visible beside it, so the disagreement is
 *      measurable rather than silently resolved.
 *   4. The per-ticket phase split's parts sum to the ticket's whole.
 *
 * REAL ARTIFACTS AND WHAT IS SYNTHETIC — stated plainly:
 * the end-to-end proof over a REAL dispatch (a real `claude -p` run and a real
 * in-process subagent, both declaring, both read back out of the agent CLI's own
 * transcripts) was run by hand and its session ids are recorded on the FEAT-100
 * ticket. It cannot live in a suite: the CLI prunes transcripts at ~30 days, so
 * a suite pinned to those ids would rot into a false red. The transcripts BELOW
 * are therefore SYNTHETIC, and are deliberately shaped like a busy real window —
 * many lanes, mixed declared/undeclared, a lane whose prose names a different
 * ticket than it declares, a quoted example inside a fence, two contradicting
 * declarations, and a schema-1 ledger with no declaration field at all.
 *
 * TRUNCATION IS TESTED, NOT ASSUMED. The collector reads transcripts that
 * another process is actively writing, so a charter can arrive half-written. A
 * complete fixture cannot prove that safe. Case 19 truncates a
 * declaration-bearing transcript at EVERY byte offset and requires that each
 * read yield either the exact declaration or nothing — a wrong value at any
 * offset is a failure.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseDispatchDeclaration,
  formatDispatchDeclaration,
  resolveLaneAttribution,
  DECLARED_PHASES,
  DISPATCH_CLASSES,
} from './lib/cost-model.mjs';
import { collect, rollUp, encodeProjectDir } from './cost-collect.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let pass = 0;
const fails = [];
function T(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('T() is synchronous; use TA()');
    pass++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    fails.push(name);
    console.log(`  FAIL ${name}\n       ${err?.message ?? err}`);
  }
}
async function TA(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    fails.push(name);
    console.log(`  FAIL ${name}\n       ${err?.message ?? err}`);
  }
}

/* ------------------------------------------------------------------ scratch */

const SCRATCH = path.join(os.homedir(), 'scratch', `feat-100-verify-${process.pid}`);
fs.mkdirSync(SCRATCH, { recursive: true });
process.on('exit', () => {
  try {
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/* --------------------------------------------------- synthetic transcripts */

const T0 = Date.parse('2026-08-21T10:00:00.000Z');
let msgSeq = 0;

/** One assistant turn with a real-shaped usage object and one tool call. */
function assistantTurn(atMs, { tool = null, model = 'claude-opus-5' } = {}) {
  const content = [{ type: 'text', text: 'working' }];
  if (tool) content.push({ type: 'tool_use', id: `tu-${++msgSeq}`, name: tool.name, input: tool.input });
  return {
    type: 'assistant',
    timestamp: new Date(atMs).toISOString(),
    message: {
      id: `msg-${++msgSeq}`,
      model,
      content,
      usage: {
        input_tokens: 10,
        output_tokens: 500,
        cache_read_input_tokens: 20000,
        cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 0 },
        service_tier: 'standard',
      },
    },
  };
}

function userTurn(atMs, text) {
  return { type: 'user', timestamp: new Date(atMs).toISOString(), message: { role: 'user', content: text } };
}

/**
 * A lane: a charter, then N turns 30 s apart (inside the 5-minute idle cut, so
 * the time is charged to phases rather than dropped as an idle gap).
 */
function laneLines(charter, startMs, turns, opts = {}) {
  const out = [userTurn(startMs, charter)];
  for (let i = 0; i < turns; i++) out.push(assistantTurn(startMs + (i + 1) * 30_000, opts));
  if (opts.finalText) {
    out.push({
      type: 'assistant',
      timestamp: new Date(startMs + (turns + 1) * 30_000).toISOString(),
      message: { id: `msg-${++msgSeq}`, model: opts.model ?? 'claude-opus-5', content: [{ type: 'text', text: opts.finalText }], usage: { input_tokens: 1, output_tokens: 1, service_tier: 'standard' } },
    });
  }
  return out.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

/**
 * A REALISTIC-STATE tree, not a minimal one: 12 lanes across 4 tickets, mixed
 * declared and undeclared, with every adversarial charter shape in it.
 */
function buildTree(root, projectPath) {
  const dir = path.join(root, encodeProjectDir(projectPath));
  const sessionId = 'sess-0001';
  const subs = path.join(dir, sessionId, 'subagents');
  fs.mkdirSync(subs, { recursive: true });

  const lanes = [
    // Declared, straightforward. Three phases of one ticket.
    ['find-1', 'Dispatch: ticket=BUG-900 phase=finding round=1 class=explore\n\nFind why the thing.', 6, { tool: { name: 'Grep', input: { pattern: 'src/x.ts' } } }],
    ['fix-1', 'Dispatch: ticket=BUG-900 phase=fixing round=2 class=fix\n\nFix it.', 10, { tool: { name: 'Edit', input: { file_path: 'src/x.ts' } } }],
    ['ver-1', 'Dispatch: ticket=BUG-900 phase=verifying round=3 class=verify\n\nBreak it.', 4, { tool: { name: 'Bash', input: { command: 'npm run gate' } }, finalText: 'Verdict: BROKEN — the guard misses one case.' }],
    ['fix-2', 'Dispatch: ticket=BUG-900 phase=fixing round=4 class=fix\n\nAnswer the verdict.', 8, { tool: { name: 'Edit', input: { file_path: 'src/x.ts' } } }],
    // THE KEY CASE: the charter's PROSE names BUG-901 first and at length, but
    // the dispatcher declared BUG-902. The old reader would attribute the whole
    // lane to BUG-901.
    ['cross-1', 'Dispatch: ticket=BUG-902 phase=fixing round=1 class=fix\n\nBUG-901 BUG-901 BUG-901 is the ticket this is NOT. See BUG-901 for background.', 5, { tool: { name: 'Edit', input: { file_path: 'src/y.ts' } } }],
    // A quoted example inside a fence must not be read as a declaration.
    ['fenced-1', 'Work on BUG-903. The grammar is:\n\n```\nDispatch: ticket=BUG-999 phase=verifying round=9 class=arch\n```\n\nDocument it.', 5, { tool: { name: 'Write', input: { file_path: 'docs/x.md' } } }],
    // Two declarations that disagree: nothing may be guessed.
    ['conflict-1', 'Dispatch: ticket=BUG-904 phase=fixing round=1 class=fix\nDispatch: ticket=BUG-905 phase=verifying round=2 class=verify\n\nWhich is it?', 3, { tool: { name: 'Read', input: { file_path: 'src/z.ts' } } }],
    // Bad values: recorded as rejected, fields absent.
    ['bad-1', 'Dispatch: ticket=BUG-906 phase=deploying round=zero class=frobnicate stage=late bare\n\nGo.', 3, { tool: { name: 'Read', input: { file_path: 'src/z.ts' } } }],
    // Multi-ticket declared lane.
    ['multi-1', 'Dispatch: ticket=BUG-907,BUG-908 phase=fixing round=1 class=fix\n\nBoth.', 4, { tool: { name: 'Edit', input: { file_path: 'src/w.ts' } } }],
    // Undeclared, but its prose names a ticket: inference still works and is
    // LABELLED as inference.
    ['legacy-1', 'Please fix BUG-909, the thing is broken.', 7, { tool: { name: 'Edit', input: { file_path: 'src/v.ts' } } }],
    // Undeclared and testing-heavy: proves the tool-derived phase is NEVER
    // promoted into the lifecycle phase.
    ['legacy-2', 'Run every suite for BUG-909 and report.', 9, { tool: { name: 'Bash', input: { command: 'node scripts/verify-x.mjs' } } }],
    // Undeclared and nameless.
    ['legacy-3', 'Have a look around and tell me what you see.', 4, { tool: { name: 'Read', input: { file_path: 'README.md' } } }],
  ];

  let t = T0;
  for (const [id, charter, turns, opts] of lanes) {
    fs.writeFileSync(path.join(subs, `agent-${id}.jsonl`), laneLines(charter, t, turns, opts ?? {}));
    t += 60 * 60 * 1000; // one hour apart, so round-by-start-time is deterministic
  }
  // The parent session file itself, so the dir is shaped like a real one.
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), laneLines('orchestrating', T0 - 60_000, 2, {}));
  return dir;
}

/* ------------------------------------------------------------- grammar cases */

console.log('\nFEAT-100 — declared dispatch: ticket, phase, round, class\n');
console.log('  ── the grammar (shared by the writer and the reader) ──');

T('1. the canonical line yields all four fields', () => {
  const d = parseDispatchDeclaration('Dispatch: ticket=BUG-900 phase=fixing round=2 class=fix\n\nbody');
  assert.deepEqual(d.tickets, ['BUG-900']);
  assert.equal(d.phase, 'fixing');
  assert.equal(d.round, 2);
  assert.equal(d.class, 'fix');
  assert.equal(d.present, true);
  assert.equal(d.conflict, false);
});

T('2. no declaration means ABSENT, not a default', () => {
  const d = parseDispatchDeclaration('Fix BUG-900 please. It is a verify job, round 3.');
  assert.equal(d.present, false);
  for (const k of ['tickets', 'phase', 'round', 'class']) assert.equal(d[k], null, `${k} must be null`);
});

T('3. a declaration quoted inside a fence is NOT a declaration', () => {
  const d = parseDispatchDeclaration('Doc this:\n\n```\nDispatch: ticket=BUG-999 phase=verifying round=9 class=arch\n```\n\nthanks');
  assert.equal(d.present, false);
  assert.equal(d.lines_in_fence, 1);
  assert.equal(d.tickets, null);
});

T('4. two declarations that DISAGREE yield null, not a pick', () => {
  const d = parseDispatchDeclaration('Dispatch: ticket=BUG-904 phase=fixing round=1 class=fix\nDispatch: ticket=BUG-905 phase=verifying round=2 class=verify');
  assert.equal(d.conflict, true);
  for (const k of ['tickets', 'phase', 'round', 'class']) assert.equal(d[k], null, `${k} must be null under conflict`);
});

T('5. identical repeats are not a conflict', () => {
  const d = parseDispatchDeclaration('Dispatch: ticket=BUG-904 phase=fixing\n\nrestated below\n\nDispatch: ticket=BUG-904 phase=fixing');
  assert.equal(d.conflict, false);
  assert.deepEqual(d.tickets, ['BUG-904']);
  assert.equal(d.lines_seen, 2);
});

T('6. an out-of-vocabulary value is REJECTED and named, not coerced', () => {
  const d = parseDispatchDeclaration('Dispatch: ticket=BUG-9 phase=deploying round=zero class=frobnicate');
  for (const k of ['tickets', 'phase', 'round', 'class']) assert.equal(d[k], null);
  assert.equal(d.rejected.length, 4, `expected 4 rejections, got ${JSON.stringify(d.rejected)}`);
  assert.ok(d.rejected.some((r) => r.startsWith('phase=deploying')));
});

T('7. unknown keys and bare tokens are recorded, not silently dropped', () => {
  const d = parseDispatchDeclaration('Dispatch: ticket=BUG-900 stage=late bare');
  assert.deepEqual(d.unknown_keys, ['stage']);
  assert.deepEqual(d.malformed, ['bare']);
  assert.deepEqual(d.tickets, ['BUG-900']);
});

T('8. a multi-ticket lane declares a LIST, not a first-wins scalar', () => {
  const d = parseDispatchDeclaration('Dispatch: ticket=BUG-907,BUG-908 phase=fixing');
  assert.deepEqual(d.tickets, ['BUG-907', 'BUG-908']);
});

T('9. writer and reader round-trip for every phase x class', () => {
  for (const phase of DECLARED_PHASES) {
    for (const cls of DISPATCH_CLASSES) {
      const line = formatDispatchDeclaration({ ticket: 'FEAT-100', phase, round: 3, class: cls });
      const d = parseDispatchDeclaration(line);
      assert.deepEqual(d.tickets, ['FEAT-100'], line);
      assert.equal(d.phase, phase, line);
      assert.equal(d.round, 3, line);
      assert.equal(d.class, cls, `${line} -> ${d.class}`);
      assert.equal(d.rejected.length + d.malformed.length + d.unknown_keys.length, 0, line);
    }
  }
});

T('10. a partial declaration declares only what it says', () => {
  const d = parseDispatchDeclaration('Dispatch: ticket=BUG-900');
  assert.deepEqual(d.tickets, ['BUG-900']);
  assert.equal(d.phase, null);
  assert.equal(d.round, null);
  assert.equal(d.class, null);
  assert.equal(d.present, true);
});

/* ------------------------------------------------------- collector over a tree */

console.log('\n  ── the collector, over a busy-window transcript tree ──');

const treeRoot = path.join(SCRATCH, 'transcripts');
const projectPath = path.join(SCRATCH, 'proj-feat099');
fs.mkdirSync(treeRoot, { recursive: true });
buildTree(treeRoot, projectPath);

process.env.CLAUDE_TRANSCRIPT_ROOT = treeRoot;
const collected = await collect({ project: projectPath, all: true, since: null });
const laneBy = new Map(collected.lanes.map((l) => [l.lane_id, l]));
const roll = rollUp(collected.lanes);

await TA('11. every fixture lane was collected', async () => {
  for (const id of ['find-1', 'fix-1', 'ver-1', 'fix-2', 'cross-1', 'fenced-1', 'conflict-1', 'bad-1', 'multi-1', 'legacy-1', 'legacy-2', 'legacy-3']) {
    assert.ok(laneBy.has(id), `lane ${id} missing`);
  }
});

T('12. a declared lane resolves every field FROM THE DECLARATION', () => {
  const l = laneBy.get('ver-1');
  assert.equal(l.primary_ticket, 'BUG-900');
  assert.equal(l.ticket_source, 'declared');
  assert.equal(l.lifecycle_phase, 'verifying');
  assert.equal(l.lifecycle_phase_source, 'declared');
  assert.equal(l.round, 3);
  assert.equal(l.round_source, 'declared');
  assert.equal(l.dispatch_class, 'verify');
  assert.equal(l.dispatch_class_source, 'declared');
});

T('13. THE KEY CASE: the declaration beats the prose, and the prose stays visible', () => {
  const l = laneBy.get('cross-1');
  assert.equal(l.primary_ticket, 'BUG-902', 'declared ticket must win over the prose mention');
  assert.equal(l.ticket_source, 'declared');
  assert.equal(l.ticket_inferred, 'BUG-901', 'the inference must still be recorded, so the disagreement is measurable');
});

T('14. an UNDECLARED lane has NO lifecycle phase — ever', () => {
  for (const id of ['legacy-1', 'legacy-2', 'legacy-3', 'fenced-1']) {
    const l = laneBy.get(id);
    assert.equal(l.lifecycle_phase, null, `${id} must have no lifecycle phase`);
    assert.equal(l.lifecycle_phase_source, null, `${id} must have no phase source`);
  }
});

T('15. the tool-derived phase is NOT promoted into the lifecycle phase', () => {
  // legacy-2 does nothing but run suites: its tool-derived phase is `testing`,
  // which a lazy implementation would map to `verifying`. It declared nothing.
  const l = laneBy.get('legacy-2');
  assert.ok((l.phases.testing ?? 0) > 0, 'fixture precondition: this lane must have testing time');
  assert.equal(l.lifecycle_phase, null, 'a testing-heavy lane that declared nothing is NOT "verifying"');
});

T('16. an undeclared lane still gets an INFERRED ticket, labelled as such', () => {
  const l = laneBy.get('legacy-1');
  assert.equal(l.primary_ticket, 'BUG-909');
  assert.equal(l.ticket_source, 'inferred');
  assert.equal(l.round_source, 'inferred');
});

T('17. a self-contradicting dispatch attributes NOTHING, and says so', () => {
  const l = laneBy.get('conflict-1');
  assert.equal(l.declared.conflict, true);
  // Both ids appear ONLY on the two declaration lines, which are stripped before
  // inference — so there is nothing left to infer from either. The lane ends up
  // wholly unattributed and its cost lands in `(no ticket named)` / `undeclared`.
  // That is the intended outcome: a dispatcher that said two different things
  // has told us nothing, and picking one of them would be a fabrication.
  assert.equal(l.lifecycle_phase, null);
  assert.equal(l.ticket_source, null);
  assert.equal(l.round_source, null);
  assert.equal(l.primary_ticket, null);
  assert.equal(roll.declared_coverage.conflicts, 1, 'the conflict must be COUNTED, not merely dropped');
  const nameless = roll.byTicket.find((t) => t.ticket === '(no ticket named)');
  assert.ok(nameless && nameless.phase.undeclared.lanes > 0, 'its cost must still be visible somewhere');
});

T('18. rejected values surface in the roll-up rather than looking like silence', () => {
  const l = laneBy.get('bad-1');
  // `ticket=BUG-906` is well-formed and survives; the other three do not. A
  // declaration is validated FIELD BY FIELD — one bad value must not discard
  // the good ones beside it.
  assert.deepEqual(l.declared.tickets, ['BUG-906']);
  assert.equal(l.declared.rejected.length, 3, JSON.stringify(l.declared));
  assert.ok(roll.declared_coverage.complaints.some((c) => c.startsWith('phase=deploying')), JSON.stringify(roll.declared_coverage.complaints));
  assert.ok(roll.declared_coverage.complaints.some((c) => c === 'unknown key stage'));
});

T('19. a multi-ticket declaration keeps the whole list', () => {
  const l = laneBy.get('multi-1');
  assert.deepEqual(l.declared_tickets, ['BUG-907', 'BUG-908']);
  assert.equal(l.primary_ticket, 'BUG-907');
});

/* ------------------------------------------------------------- the roll-up */

console.log('\n  ── the report ──');

T('20. per-ticket phase parts sum to the ticket whole', () => {
  for (const t of roll.byTicket) {
    const lanes = Object.values(t.phase).reduce((a, g) => a + g.lanes, 0);
    const cost = Object.values(t.phase).reduce((a, g) => a + g.cost, 0);
    const ms = Object.values(t.phase).reduce((a, g) => a + g.accounted_ms, 0);
    assert.equal(lanes, t.lanes, `${t.ticket}: lane parts ${lanes} != whole ${t.lanes}`);
    assert.equal(ms, t.accounted_ms, `${t.ticket}: ms parts != whole`);
    assert.ok(Math.abs(cost - t.cost) < 1e-9, `${t.ticket}: cost parts ${cost} != whole ${t.cost}`);
  }
});

T('21. BUG-900 shows a real finding/fixing/verifying split', () => {
  const t = roll.byTicket.find((x) => x.ticket === 'BUG-900');
  assert.ok(t, 'BUG-900 missing from the per-ticket table');
  assert.equal(t.phase.finding.lanes, 1);
  assert.equal(t.phase.fixing.lanes, 2);
  assert.equal(t.phase.verifying.lanes, 1);
  assert.equal(t.phase.undeclared.lanes, 0);
  assert.ok(t.phase.fixing.cost > t.phase.verifying.cost, 'fixture precondition: the two fix lanes cost more than the one verify lane');
});

T('22. coverage counts what was declared, and only that', () => {
  const c = roll.declared_coverage;
  assert.equal(c.lanes, collected.lanes.length);
  // Declared a valid ticket: find-1, fix-1, ver-1, fix-2, cross-1, multi-1 AND
  // bad-1 (whose ticket is fine; its other three fields are not) = 7.
  assert.equal(c.ticket, 7, `ticket coverage was ${c.ticket}`);
  // Declared a valid PHASE: the same six minus bad-1 = 6. The two counts differ
  // on purpose — coverage is per FIELD, because partial declarations are real.
  assert.equal(c.phase, 6, `phase coverage was ${c.phase}`);
  assert.equal(c.conflicts, 1);
  assert.ok(c.lanes > c.ticket, 'the fixture must contain undeclared lanes too');
});

T('23. the undeclared bucket carries the undeclared lanes, with no fabricated split', () => {
  const u = roll.byLifecycle.undeclared;
  const declaredLanes = DECLARED_PHASES.reduce((a, p) => a + roll.byLifecycle[p].lanes, 0);
  assert.equal(u.lanes + declaredLanes, collected.lanes.length);
  assert.ok(u.cost > 0, 'the undeclared lanes cost real money and must be shown, not dropped');
});

T('24. the class table counts only DECLARED classes', () => {
  const total = roll.byClass.reduce((a, g) => a + g.lanes, 0);
  assert.equal(total, roll.declared_coverage.class);
  // fix-1, fix-2, cross-1, multi-1 all declared class=fix and phase=fixing.
  const fix = roll.byClass.find((g) => g.class === 'fix');
  assert.deepEqual(fix.phases, { fixing: 4 }, JSON.stringify(fix?.phases));
});

T('25. a schema-1 ledger record (no declaration field at all) still rolls up', () => {
  const old = collected.lanes.map((l) => {
    const c = { ...l, schema: 1 };
    delete c.declared;
    delete c.lifecycle_phase;
    delete c.lifecycle_phase_source;
    delete c.ticket_source;
    delete c.dispatch_class_source;
    delete c.round_source;
    return c;
  });
  const r = rollUp(old);
  assert.equal(r.declared_coverage.pre_feature, old.length);
  assert.equal(r.declared_coverage.phase, 0);
  assert.equal(r.byLifecycle.undeclared.lanes, old.length);
  assert.ok(r.byLifecycle.undeclared.cost > 0);
});

/* ------------------------------------------------------------- truncation */

console.log('\n  ── truncation: another process is writing this file ──');

await TA('26. a torn charter yields the RIGHT declaration or NOTHING, never a wrong one', async () => {
  const tRoot = path.join(SCRATCH, 'trunc');
  const proj = path.join(SCRATCH, 'proj-trunc');
  const dir = path.join(tRoot, encodeProjectDir(proj), 'sess-t', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const full = laneLines('Dispatch: ticket=BUG-910 phase=verifying round=4 class=verify\n\nBreak the claim about BUG-911.', T0, 5, {
    tool: { name: 'Bash', input: { command: 'npm run gate' } },
  });
  const file = path.join(dir, 'agent-trunc.jsonl');
  process.env.CLAUDE_TRANSCRIPT_ROOT = tRoot;

  const bytes = Buffer.from(full, 'utf8');
  let sawGood = 0;
  let sawAbsent = 0;
  // Every offset from the first newline onward: below that there is no complete
  // JSON line at all and the collector correctly finds no lane.
  for (let cut = 1; cut <= bytes.length; cut++) {
    fs.writeFileSync(file, bytes.subarray(0, cut));
    const res = await collect({ project: proj, all: true, since: null });
    const lane = res.lanes.find((l) => l.lane_id === 'trunc');
    if (!lane) continue;
    const d = lane.declared;
    if (d.tickets == null && d.phase == null && d.round == null && d.class == null) {
      sawAbsent++;
      continue;
    }
    // If ANY field came back, every field that came back must be the true one.
    assert.deepEqual(d.tickets, ['BUG-910'], `cut ${cut}: wrong ticket ${JSON.stringify(d.tickets)}`);
    assert.equal(d.phase, 'verifying', `cut ${cut}: wrong phase ${d.phase}`);
    assert.equal(d.round, 4, `cut ${cut}: wrong round ${d.round}`);
    assert.equal(d.class, 'verify', `cut ${cut}: wrong class ${d.class}`);
    assert.equal(lane.primary_ticket, 'BUG-910', `cut ${cut}: wrong attribution`);
    sawGood++;
  }
  assert.ok(sawGood > 0, 'no truncation produced a readable declaration — the fixture proves nothing');
  console.log(`       (${bytes.length} offsets: ${sawGood} read the declaration, ${sawAbsent} read it as absent, 0 read it wrong)`);
});

/* ------------------------------------------- the writer: scripts/dispatch.mjs */

console.log('\n  ── the writer path (scripts/dispatch.mjs) ──');

function runDispatch(args, env = {}) {
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dispatch.mjs'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
}

T('27. an out-of-vocabulary --phase is refused before anything spawns', () => {
  const r = runDispatch(['--provider', 'anthropic', '--phase', 'deploying', 'x']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--phase must be one of finding \| fixing \| verifying/);
});

T('28. an out-of-vocabulary --class is refused', () => {
  const r = runDispatch(['--provider', 'anthropic', '--class', 'frobnicate', 'x']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--class must be one of/);
});

T('29. a --ticket that is not a ticket id is refused (it would not round-trip)', () => {
  const r = runDispatch(['--provider', 'anthropic', '--ticket', 'nonsense', 'x']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /did not round-trip/);
});

T('30. valid flags emit the exact canonical line the reader parses', () => {
  // PATH is emptied so `claude` cannot be found: the run dies at transport,
  // AFTER the declaration has been composed and announced. No model is called.
  const meta = path.join(SCRATCH, 'meta-30.json');
  const r = runDispatch(
    ['--provider', 'anthropic', '--ticket', 'FEAT-100', '--phase', 'fixing', '--round', '2', '--class', 'fix', '--meta-out', meta, 'x'],
    { PATH: path.join(SCRATCH, 'no-such-bin') },
  );
  assert.notEqual(r.status, 0, 'expected the transport failure, which is the point of the empty PATH');
  const line = 'Dispatch: ticket=FEAT-100 phase=fixing round=2 class=fix';
  assert.ok(r.stderr.includes(line), `stderr did not carry the declaration:\n${r.stderr}`);
  const d = parseDispatchDeclaration(line);
  assert.deepEqual(d.tickets, ['FEAT-100']);
  assert.equal(d.phase, 'fixing');
  assert.equal(d.round, 2);
  assert.equal(d.class, 'fix');
});

T('31. no flags means no declaration line and an explicit null in the meta record', () => {
  const meta = path.join(SCRATCH, 'meta-31.json');
  const r = runDispatch(['--provider', 'anthropic', '--meta-out', meta, 'x'], { PATH: path.join(SCRATCH, 'no-such-bin') });
  assert.ok(!/^\[dispatch\] Dispatch:/m.test(r.stderr), 'a dispatch that declared nothing must not emit a declaration');
  assert.ok(fs.existsSync(meta), 'meta is written on failure too');
  const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
  assert.equal(m.dispatch, null, 'absent must be recorded as null, not omitted');
});

/* ------------------------------------------------------------------ summary */

console.log(`\n  ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(`  failing: ${fails.join(', ')}`);
  process.exit(1);
}
process.exit(0);
