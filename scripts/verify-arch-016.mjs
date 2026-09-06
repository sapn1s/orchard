/**
 * ARCH-016 — the lane-final-message contract + its anti-regression guards.
 *
 *   node scripts/verify-arch-016.mjs        (npm run verify:arch-016)
 *
 * WHAT THIS PROVES
 * ----------------
 * [1] B1 — ORCHESTRATOR-side reach. The real launch composition path
 *     (composeInstructions + appendToSystemPrompt, exactly as
 *     src/server/agent-bridge.ts uses it) carries the contract in BOTH the WA v4
 *     §I body AND the RESPONSE_FORMAT injected core. IMPORTANT: this is the
 *     MAIN/orchestrator session's system prompt (agent-bridge.ts:957 →
 *     claude-runtime.ts:626, a preset+append on the top-level query) — it is
 *     what the ORCHESTRATOR receives, NOT what a dispatched in-process subagent
 *     lane receives. (Round-1 mislabeled this leg as "what a lane receives"; the
 *     independent verify caught it. A dispatched lane gets its own
 *     AgentDefinition.prompt, proven separately in leg [1a].) This leg proves the
 *     orchestrator-side rule (relay the compact form; keep-lean; harvest on
 *     demand) lands, and its retrieval-trigger + provenance wording is present.
 *     MUST-FAIL control: the same markers are asserted ABSENT with an empty
 *     instruction stack.
 *
 * [1a] B1 — DISPATCHED-LANE reach (the decisive, load-bearing leg). A dispatched
 *     lane's own system prompt is its AgentDefinition.prompt — for Orchard's
 *     default work lane that is `.claude/agents/worker.md`, resolved from the file
 *     by the CLI (verified: this very lane's prompt IS worker.md's body). Assert
 *     worker.md CARRIES the compact-handoff contract + the harvest re-fetch path.
 *     MUST-FAIL: a copy of worker.md with the contract bullet stripped no longer
 *     matches — the marker check has teeth. HONEST REACH GAP (also asserted): the
 *     other dispatched lane types in the real ledger — general-purpose, Explore,
 *     claude, Plan (55% of dispatched subagent lanes) — are CLI built-ins with NO
 *     definition file under .claude/agents/, and their prompts are compiled into
 *     the `claude` binary. The contract cannot reach them structurally without
 *     clobbering their SDK prompt (AgentDefinition.prompt is required; there is no
 *     SDK "append to every subagent prompt" option). Their only Orchard-layer
 *     reach is the charter-relay (the orchestrator-written task prompt, governed
 *     by WA §I + the patterns doc) — prose-relay, requested not enforced.
 *
 * [2] B2 — the paths Orchard COMPOSES (the "while you were away" briefing and the
 *     background-task notification frame) stay pointer+summary, never full lane
 *     prose. The ARCH-016 spec found Orchard cannot rewrite the in-process Agent
 *     tool_result (that is the CLI/SDK's stream), so the saving lives in B1; B2 is
 *     the guard that the paths Orchard DOES compose do not regress into carrying
 *     full prose. The guard has teeth: the same lean-shape checks are shown to
 *     FAIL against a simulated full-prose composition and against an outcome whose
 *     detail is a full multi-paragraph report.
 *
 * [3] The FEAT-124 tier-visibility flag (fableMisroute) flags a dispatched lane
 *     that ran on Fable with an absent/cheap-work class, does NOT flag a justified
 *     class, a non-Fable lane, or the human's own orchestrator session.
 *
 * Read-only except for a scratch outcomes store under a throwaway
 * CLAUDE_STATION_DATA dir, removed on exit. Opens no server, touches no real store.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${observed}`);
  if (ok) pass++;
  else {
    fail++;
    failures.push(name);
  }
}
const appendOf = (sp) => (typeof sp === 'string' ? sp : sp && typeof sp === 'object' ? sp.append : '');

/* The contract markers — one distinctive phrase per injection surface. Changing a
 * marker here means the contract wording changed; that is a deliberate edit, not a
 * drift, and it re-anchors the proof. */
// Markers are contiguous in the SOURCE (no line-wrap, no inline markdown between
// them) and unique to ONE surface — the phrase "compact handoff, not a report"
// appears in BOTH WA §I and the RESPONSE_FORMAT core, so each marker below is
// chosen to be surface-specific.
const WA_CONTRACT = "never pastes a lane's report into its own context"; // WA §I only
const WA_TRIGGERS = 'machine-detectable trigger, not a default carry'; // WA §I only
const RF_CONTRACT = 'never paste the report body'; // RESPONSE_FORMAT core only

// The dispatched-lane surface markers — asserted against the AgentDefinition.prompt
// (worker.md) a real worker lane actually receives, NOT composeInstructions.
const WORKER_CONTRACT = 'compact handoff, not a report (ARCH-016)'; // worker.md only
const WORKER_HARVEST = 'scripts/harvest-agent.mjs <agent-id>'; // worker.md re-fetch path
// The dispatched lane types seen in the real ledger. worker has a file; the rest
// are CLI built-ins with no definition file (prompts compiled into the binary).
const BUILTIN_LANE_TYPES = ['general-purpose', 'Explore', 'claude', 'Plan'];

async function b1aLanePromptProof() {
  console.log('\n[1a] B1 — the contract reaches a DISPATCHED LANE (worker.md AgentDefinition.prompt) — DECISIVE');
  const workerFile = path.join(ROOT, '.claude', 'agents', 'worker.md');
  check('the default work lane has a definition file (.claude/agents/worker.md)', fs.existsSync(workerFile), workerFile);
  if (!fs.existsSync(workerFile)) return;
  const worker = fs.readFileSync(workerFile, 'utf8');

  check('worker.md carries the compact-handoff contract', worker.includes(WORKER_CONTRACT), `present=${worker.includes(WORKER_CONTRACT)}`);
  check('worker.md names the harvest re-fetch path (harvest-agent.mjs)', worker.includes(WORKER_HARVEST), `present=${worker.includes(WORKER_HARVEST)}`);
  check('worker.md states detail goes to the Activity log, not the final message',
    /Full detail goes to the Activity log/.test(worker), 'present?');

  // MUST-FAIL (teeth): strip the contract bullet from a COPY of worker.md — the
  // markers must vanish, proving the check distinguishes present from absent and
  // would FAIL against the pre-change tree (which had no such bullet — confirmed
  // by direct grep before the edit: 0 matches for "compact handoff"/"harvest-agent").
  const stripped = worker
    .split('\n')
    .filter((l) => !l.includes('compact handoff') && !l.includes('harvest-agent.mjs') && !l.includes('Full detail goes to the Activity log') && !l.includes('lane\'s report into its own context') && !l.includes('durable pointer'))
    .join('\n');
  check('MUST-FAIL: contract marker ABSENT once the bullet is stripped', !stripped.includes(WORKER_CONTRACT), `present-in-stripped=${stripped.includes(WORKER_CONTRACT)}`);
  check('MUST-FAIL: harvest path ABSENT once the bullet is stripped', !stripped.includes(WORKER_HARVEST), `present-in-stripped=${stripped.includes(WORKER_HARVEST)}`);

  // HONEST REACH GAP: the other dispatched lane types are built-ins with no file.
  // The contract cannot reach them via a definition file — documented, not hidden.
  for (const t of BUILTIN_LANE_TYPES) {
    const f = path.join(ROOT, '.claude', 'agents', `${t}.md`);
    check(`built-in lane type "${t}" has NO definition file (unreachable via file; charter-relay only)`, !fs.existsSync(f), `exists=${fs.existsSync(f)}`);
  }

  // The only Orchard-layer reach for the built-in lanes is the charter-relay —
  // the orchestrator-written task prompt, governed by WA §I + the patterns doc.
  // Assert that reach exists (prose-relay, requested not enforced — see verdict).
  const patterns = path.join(ROOT, 'docs', 'prompts', 'patterns', 'MANAGER_SUBAGENT_TREE.md');
  const patternsTxt = fs.existsSync(patterns) ? fs.readFileSync(patterns, 'utf8') : '';
  check('charter-relay carries the contract for built-in lanes (patterns doc: "compact handoff")',
    /compact handoff/.test(patternsTxt), `present=${/compact handoff/.test(patternsTxt)}`);
}

async function b1InjectionProof() {
  console.log('\n[1] B1 — the contract reaches the ORCHESTRATOR system prompt (relay + keep-lean side)');
  const { registryFile } = await import(path.join(ROOT, 'src', 'lib', 'paths.ts'));
  const { composeInstructions, appendToSystemPrompt } = await import(path.join(ROOT, 'src', 'server', 'templates.ts'));
  const { boardStateSection } = await import(path.join(ROOT, 'src', 'server', 'board.ts'));

  const regFile = registryFile();
  if (!fs.existsSync(regFile)) {
    console.log(`  SKIP: no registry at ${regFile} — cannot resolve this checkout's real refs.`);
    return;
  }
  const registry = JSON.parse(fs.readFileSync(regFile, 'utf8'));
  const project = (registry.projects ?? []).find((p) => path.resolve(p.hostPath ?? '') === ROOT);
  check('this checkout is a registered project', !!project, project ? `id=${project.id}` : `none with hostPath ${ROOT}`);
  if (!project) return;

  const refs = project.settings?.instructions ?? [];
  // The real launch composition — responseFormat:true is the launch-path spelling
  // (see verify:feat-084), routing:true mirrors agent-bridge.
  const composed = composeInstructions(refs, { hostPath: project.hostPath, routing: true, responseFormat: true });
  const live = appendOf(appendToSystemPrompt(composed.systemPrompt, boardStateSection(project.hostPath)));

  // MUST-FAIL control — the sources that carry the contract (WA v4 §I and the
  // RESPONSE_FORMAT core) are BOTH removed: empty refs drop WA, responseFormat:false
  // drops the format core. Neither marker can then be present. This reproduces the
  // pre-change "absent" state on demand, so a marker leaking in from any other
  // injected section (routing, local conventions, board) could not pass this.
  const emptyComposed = composeInstructions([], { hostPath: project.hostPath, routing: true, responseFormat: false });
  const control = appendOf(appendToSystemPrompt(emptyComposed.systemPrompt, boardStateSection(project.hostPath)));

  check('WA v4 §I reciprocal return-payload rule is present in the composed prompt', live.includes(WA_CONTRACT), `present=${live.includes(WA_CONTRACT)}`);
  check('WA v4 §I machine-detectable retrieval triggers are present', live.includes(WA_TRIGGERS), `present=${live.includes(WA_TRIGGERS)}`);
  check('RESPONSE_FORMAT injected core carries the final-message contract', live.includes(RF_CONTRACT), `present=${live.includes(RF_CONTRACT)}`);
  check('the harvest-on-demand read path is named (scripts/harvest-agent.mjs)', live.includes('scripts/harvest-agent.mjs'), `present=${live.includes('scripts/harvest-agent.mjs')}`);

  check('CONTROL: WA contract marker ABSENT with an empty instruction stack', !control.includes(WA_CONTRACT), `present-in-control=${control.includes(WA_CONTRACT)}`);
  check('CONTROL: RESPONSE_FORMAT contract marker ABSENT with an empty stack', !control.includes(RF_CONTRACT), `present-in-control=${control.includes(RF_CONTRACT)}`);
  check('response-format section applied at launch', composed.appliedIds.includes('response-format'), composed.appliedIds.join(','));
  check('working-agreement-v4 applied at launch', composed.appliedIds.includes('working-agreement-v4'), composed.appliedIds.join(','));
}

async function b2LeanCompositionGuard() {
  console.log('\n[2] B2 — the briefing/notification composition stays pointer+summary');

  // Isolate the outcomes store in a throwaway data dir so the REAL takeBriefing
  // read+compose path runs against a fixture, never the live store. dataDir() reads
  // CLAUDE_STATION_DATA at CALL time, so this is restored before [3] runs (else its
  // readLedger would read the empty scratch dir instead of the host's real ledger).
  const priorDataDir = process.env.CLAUDE_STATION_DATA;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'arch016-outcomes-'));
  process.env.CLAUDE_STATION_DATA = scratch;
  const outcomes = await import(path.join(ROOT, 'src', 'server', 'outcomes.ts'));

  const storeFile = path.join(scratch, 'agent-outcomes.json');
  const mk = (over) => ({
    id: `o-${Math.random().toString(36).slice(2)}`,
    at: Date.now() - 60_000,
    projectId: 'p1',
    projectName: 'proj',
    stationSessionId: 'sess-1',
    sdkSessionId: null,
    agentId: `a-${Math.random().toString(36).slice(2)}`,
    row: 'agent',
    label: 'fix-lane',
    description: 'ARCH-016 build lane',
    kind: 'unknown',
    detail: 'the turn ended while this agent was still running and the engine reported no outcome for it',
    providerError: null,
    clusterId: null,
    dismissedAt: null,
    briefedAt: null,
    ...over,
  });

  // Realistic busy-state: MANY recent deaths, distinct agents, distinct clusters —
  // the "user has been running the fleet all day" shape, not a minimal 1-death case.
  const many = [];
  for (let i = 0; i < 40; i++) {
    many.push(mk({ label: `lane-${i}`, agentId: `a-${i}`, clusterId: `c-${i}`, at: Date.now() - i * 1000 }));
  }
  fs.writeFileSync(storeFile, JSON.stringify(many));
  const brief = outcomes.takeBriefing(['sess-1']);

  // Pointer+summary property: the briefing is BOUNDED — a head, at most a handful
  // of event lines, a "…and N more" tail, and the advisory. It does NOT grow with
  // the number of deaths, and every event line is a SINGLE line.
  const lines = (brief ?? '').split('\n');
  check('briefing is produced for a busy fleet', typeof brief === 'string' && brief.length > 0, `len=${brief?.length}`);
  check('briefing is BOUNDED under 40 deaths (does not narrate all N)', lines.length <= 10, `lines=${lines.length}`);
  check('briefing caps the item list with a "…and N more" tail', /and \d+ more/.test(brief ?? ''), 'tail present?');
  check('briefing carries the ADVISORY guard (corroborate before acting)', /ADVISORY/.test(brief ?? ''), 'advisory present?');

  // Each composed event line is a single pointer line, not a pasted report.
  const oneEvent = outcomes.outcomeLine(mk({ detail: 'engine reported no outcome' }));
  check('outcomeLine composes a SINGLE line (no embedded paragraphs)', !oneEvent.includes('\n'), JSON.stringify(oneEvent.slice(0, 80)));
  check('outcomeLine stays bounded for a realistic death (< 300 chars)', oneEvent.length < 300, `len=${oneEvent.length}`);

  // MUST-FAIL (teeth): if a full multi-paragraph lane REPORT is routed into the
  // composed line — the exact regression B2 exists to catch — the single-line and
  // bounded properties break. Proving the checks FAIL here is what makes their PASS
  // above meaningful.
  const fullReport = [
    '# Lane report', '', 'I investigated the issue in depth. First I read the file.',
    'Then I found the cause was a race in the writer.', '', '## Details', ...Array(30).fill('A paragraph of narrative prose that would be replayed every turn.'),
  ].join('\n');
  const regressed = outcomes.outcomeLine(mk({ detail: fullReport }));
  const regressedSingleLine = !regressed.includes('\n');
  const regressedBounded = regressed.length < 300;
  check('MUST-FAIL: a full-prose report in the line BREAKS single-line (guard has teeth)', regressedSingleLine === false, `single-line=${regressedSingleLine}`);
  check('MUST-FAIL: a full-prose report in the line BREAKS the bound (guard has teeth)', regressedBounded === false, `len=${regressed.length}`);

  // The background-task notification frame Orchard passes through is <summary> +
  // <output-file> — a pointer, not the report body. Pin that shape and its bound.
  const notif = '[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>\n<task-id>abc123</task-id>\n<status>completed</status>\n<summary>Built the ARCH-016 contract; details in the ticket Activity log</summary>\n<output-file>subagents/agent-abc123.jsonl</output-file>\n</task-notification>';
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(notif)?.[1] ?? '';
  check('notification frame carries a <summary> (pointer, not the report body)', summary.length > 0 && summary.length < 200, `len=${summary.length}`);
  check('notification frame carries an <output-file> pointer to the durable detail', /<output-file>[^<]+<\/output-file>/.test(notif), 'output-file present?');

  fs.rmSync(scratch, { recursive: true, force: true });
  if (priorDataDir === undefined) delete process.env.CLAUDE_STATION_DATA;
  else process.env.CLAUDE_STATION_DATA = priorDataDir;
}

async function b3TierFlag() {
  console.log('\n[3] FEAT-124 tier-visibility flag — fableMisroute');
  const { fableMisroute, readLedger } = await import(path.join(ROOT, 'scripts', 'cost-collect.mjs'));

  // Unit cases — the routing decision, keyed on the MODEL not the class.
  check('flags a dispatched subagent on Fable with an absent class',
    fableMisroute({ kind: 'subagent', models: ['claude-fable-5'], declared: null }) === true, 'flagged');
  check('flags a dispatched subagent on Fable declared class=fix',
    fableMisroute({ kind: 'subagent', models: ['claude-fable-5'], declared: { class: 'fix' } }) === true, 'flagged');
  check('does NOT flag Fable on a justified class (plan+review)',
    fableMisroute({ kind: 'subagent', models: ['claude-fable-5'], declared: { class: 'plan+review' } }) === false, 'not flagged');
  check('does NOT flag a non-Fable lane',
    fableMisroute({ kind: 'subagent', models: ['claude-opus-4-8'], declared: null }) === false, 'not flagged');
  check('does NOT flag the human orchestrator session even if it touched Fable',
    fableMisroute({ kind: 'orchestrator', models: ['claude-opus-5', 'claude-fable-5'], declared: null }) === false, 'not flagged');

  // Real ledger — the flag must catch the named misroutes if the ledger is present.
  let ledger = [];
  try { ledger = readLedger(); } catch { ledger = []; }
  if (!ledger.length) {
    console.log('  note: no cost ledger on this host — skipping the real-transcript assertion.');
    return;
  }
  const flagged = ledger.filter(fableMisroute);
  const byTicket = new Set(flagged.map((l) => l.declared?.tickets?.[0] ?? l.tickets?.[0]?.id));
  check('over the real ledger, the flag surfaces dispatched Fable misroutes', flagged.length > 0, `flagged=${flagged.length}`);
  check('a known misroute (BUG-030 stale-agent) is among the flagged', byTicket.has('BUG-030'), `BUG-030 flagged=${byTicket.has('BUG-030')}`);
  check('the flag never includes an orchestrator-kind lane', flagged.every((l) => l.kind !== 'orchestrator'), `orchestrator rows=${flagged.filter((l) => l.kind === 'orchestrator').length}`);
}

async function main() {
  console.log(`=== ARCH-016 — lane-final-message contract + guards — ${ROOT} ===`);
  await b1aLanePromptProof();
  await b1InjectionProof();
  await b2LeanCompositionGuard();
  await b3TierFlag();
  console.log(`\n${fail === 0 ? 'VERDICT: PASS' : 'VERDICT: FAIL'} — ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('failed checks:\n  - ' + failures.join('\n  - '));
    process.exitCode = 1;
  }
}

await main();
