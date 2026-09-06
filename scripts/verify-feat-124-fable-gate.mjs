#!/usr/bin/env node
/**
 * verify-feat-124-fable-gate.mjs — FEAT-124.
 *
 * Grades the Fable-tier gate: an UNJUSTIFIED `model: fable` dispatch is rerouted
 * UP to Opus (never down), a JUSTIFIED one keeps Fable and is logged, Sonnet/Opus
 * are untouched, the documented default-inheritance blind spot is honest, and the
 * escape hatch works.
 *
 * DRIVEN, NOT ASSERTED — the same bar the FEAT-108 block met for the gate. Section
 * 2 runs the EXACT decision the runtime's PreToolUse callback runs (the real
 * `decideFableTier`, replicated in a tiny `hookDecision` mirror), and section 3
 * PINS that mirror textually to claude-runtime.ts so the replica cannot silently
 * diverge from the shipped wiring. Section 0 proves must-FAIL against the UNCHANGED
 * pre-change enforcement path (`decide()` from orchestrator-profile, still in the
 * tree), which allowed `model: fable` through untouched.
 *
 * The one thing NOT gradeable for free — "the dispatched lane's process actually
 * ran on Opus, read from a live session" — needs a real model session and lives in
 * `--live` (below), which is NOT part of the gate. The reroute object the hook
 * hands the SDK (`updatedInput: { model: 'opus' }`) IS asserted here; that the SDK
 * honours its own documented `updatedInput` contract (sdk.d.ts
 * PreToolUseHookSpecificOutput.updatedInput) is the boundary this cannot cross
 * without spending money.
 *
 * Run: node scripts/verify-feat-124-fable-gate.mjs   (free, gate-safe)
 *      node scripts/verify-feat-124-fable-gate.mjs --live   (starts a real session)
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  decideFableTier,
  fableTierGateEnabled,
  isFableModel,
  fableJustification,
  FALLBACK_MODEL,
} from './lib/fable-tier-policy.mjs';
// The PRE-FEAT-124 enforcement path, imported to PROVE non-vacuity: for an Agent
// call it ALLOWS everything (Agent is in the profile's allow list; a lane is
// exempt entirely), so `model: fable` ran ungated. That is the hole this closes.
import { decide } from './lib/orchestrator-profile.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; return; }
  fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

/* ═══ 0. NON-VACUITY — the pre-change tree let Fable through ════════════════
 * The must-FAIL proof. Before FEAT-124 the only enforcement on an `Agent` call
 * was `decide()`, and it ALLOWS Agent for the orchestrator (Agent ∈ allow list)
 * and exempts a lane entirely (agent_id present → allow). Neither looks at the
 * model at all. So an unjustified `model: fable` was allowed, unchanged, both
 * ways. These assertions FAIL the instant someone claims the gate existed before.
 */
ok('MUST-FAIL: pre-change decide() ALLOWS an orchestrator Agent+fable, model untouched',
  decide({ toolName: 'Agent', toolInput: { model: 'fable' }, agentId: null }).allow === true);
ok('MUST-FAIL: pre-change decide() ALLOWS a LANE Agent+fable too (agent_id present)',
  decide({ toolName: 'Agent', toolInput: { model: 'fable' }, agentId: 'a-lane-1' }).allow === true);
ok('MUST-FAIL: pre-change decide() carries NO model rewrite (no updatedInput concept)',
  decide({ toolName: 'Agent', toolInput: { model: 'fable' }, agentId: null }).reason == null);

/* ═══ 1. THE DECISION — every case of the single source of truth ════════════ */

// 1a. Unjustified Fable → REROUTE to Opus. The lane RUNS (action !== deny/abort).
const bare = decideFableTier({ toolName: 'Agent', toolInput: { model: 'fable', description: 'Fix BUG-030 stale cards', prompt: 'do the thing' } });
ok('unjustified `model: fable` → action=reroute', bare.action === 'reroute');
ok('reroute rewrites model to the sanctioned ceiling (opus), NEVER down', bare.updatedInput?.model === 'opus');
ok('reroute floor is Opus, asserted explicitly (never sonnet/haiku)', bare.fallbackModel === FALLBACK_MODEL && FALLBACK_MODEL === 'opus');
ok('reroute preserves the rest of the payload (prompt/description intact)',
  bare.updatedInput?.prompt === 'do the thing' && bare.updatedInput?.description === 'Fix BUG-030 stale cards');
ok('reroute surfaces the lane label for the log', bare.label === 'Fix BUG-030 stale cards');

// 1b. Justified Fable → ALLOW, keep Fable, record the reason.
const just = decideFableTier({ toolName: 'Agent', toolInput: { model: 'fable', description: 'adversarial verify', prompt: 'attack this design.\nfable-justified: frontier-hard adversarial verification of a security fix\ngo.' } });
ok('justified `model: fable` (fable-justified: <reason>) → action=allow', just.action === 'allow');
ok('justified Fable is NOT rewritten — it keeps Fable', just.updatedInput === undefined && just.requested === 'fable');
ok('the justification reason is captured for the audit log',
  just.justification === 'frontier-hard adversarial verification of a security fix');

// 1c. A BARE marker with no reason does NOT qualify (the point is a stated reason).
const empty = decideFableTier({ toolName: 'Agent', toolInput: { model: 'fable', prompt: 'fable-justified:   \nfable-justified:\ngo' } });
ok('bare `fable-justified:` with no reason does NOT justify → still rerouted', empty.action === 'reroute');
ok('fableJustification() returns null for an empty/whitespace reason', fableJustification('fable-justified:   \n') === null);

// 1d. Full model ids and the [1m] variant are all caught.
for (const m of ['claude-fable-5', 'claude-fable-5[1m]', 'CLAUDE-FABLE-5', 'fable']) {
  ok(`Fable id "${m}" is recognised as the premium tier`, isFableModel(m) === true);
  const d = decideFableTier({ toolName: 'Agent', toolInput: { model: m, prompt: 'x' } });
  ok(`Fable id "${m}" with no justification → rerouted to opus`, d.action === 'reroute' && d.updatedInput.model === 'opus');
}

// 1e. Sonnet / Opus / Haiku are UNTOUCHED (the gate is Fable-only).
for (const m of ['sonnet', 'opus', 'haiku', 'claude-opus-4-8', 'claude-sonnet-4']) {
  ok(`non-Fable model "${m}" is not a Fable tier`, isFableModel(m) === false);
  ok(`non-Fable model "${m}" → action=ignore (unaffected)`,
    decideFableTier({ toolName: 'Agent', toolInput: { model: m, prompt: 'x' } }).action === 'ignore');
}

// 1f. THE DOCUMENTED BLIND SPOT — a Fable DEFAULT inherited with no `model:` on
// the call has nothing for the gate to catch. Honest, and asserted as such.
ok('BLIND SPOT: an Agent call with NO model → action=ignore (inherited default is invisible)',
  decideFableTier({ toolName: 'Agent', toolInput: { subagent_type: 'general-purpose', prompt: 'x' } }).action === 'ignore');
ok('BLIND SPOT: model:null → ignore', decideFableTier({ toolName: 'Agent', toolInput: { model: null, prompt: 'x' } }).action === 'ignore');

// 1g. Non-Agent tools never enter the gate.
ok('a Bash call is ignored by the Fable gate', decideFableTier({ toolName: 'Bash', toolInput: { command: 'ls' } }).action === 'ignore');
ok('a Read call is ignored by the Fable gate', decideFableTier({ toolName: 'Read', toolInput: {} }).action === 'ignore');

// 1h. The escape hatch — ORCHARD_ALLOW_FABLE=1 lets Fable pass ungated, still logged.
ok('gate ON by default (no env)', fableTierGateEnabled({}) === true);
ok('gate OFF with ORCHARD_ALLOW_FABLE=1', fableTierGateEnabled({ ORCHARD_ALLOW_FABLE: '1' }) === false);
const hatch = decideFableTier({ toolName: 'Agent', toolInput: { model: 'fable', prompt: 'x' } }, { ORCHARD_ALLOW_FABLE: '1' });
ok('hatch open → Fable ALLOWED ungated (action=allow, hatch flag set)', hatch.action === 'allow' && hatch.hatch === true);
ok('hatch open → NOT rerouted', hatch.updatedInput === undefined);

/* ═══ 2. DRIVEN: the runtime's decision, replicated ═════════════════════════
 * Mirrors the PreToolUse callback in claude-runtime.ts exactly — the SAME calls,
 * in the SAME order (git block for Bash first; Fable gate for Agent; then the
 * profile decide()). The pin in §3 fails if the runtime stops calling
 * decideFableTier for Agent, so this replica cannot silently diverge.
 */
function hookDecision(payload, env = process.env) {
  const i = payload;
  // (git-write block for Bash omitted — different tool, tested in FEAT-108)
  if (i.tool_name === 'Agent') {
    const ft = decideFableTier({ toolName: i.tool_name, toolInput: i.tool_input }, env);
    if (ft.action === 'reroute') {
      return { allow: true, updatedInput: ft.updatedInput };
    }
    // action==='allow' (justified or hatch) → fall through unchanged; action==='ignore' → nothing.
  }
  return {};
}
const hookBare = hookDecision({ tool_name: 'Agent', tool_input: { model: 'fable', prompt: 'no justification here' } });
ok('DRIVEN: an unjustified Agent+fable is ALLOWED with model rewritten to opus',
  hookBare.updatedInput?.model === 'opus');
ok('DRIVEN: a LANE (agent_id present) unjustified Agent+fable is rerouted too — fleet-wide',
  hookDecision({ tool_name: 'Agent', tool_input: { model: 'fable', prompt: 'x' }, agent_id: 'a-lane-2' }).updatedInput?.model === 'opus');
ok('DRIVEN: a justified Agent+fable passes through unchanged (no updatedInput)',
  hookDecision({ tool_name: 'Agent', tool_input: { model: 'fable', prompt: 'fable-justified: deep security attack\ngo' } }).updatedInput === undefined);
ok('DRIVEN: an Agent+opus passes through unchanged',
  hookDecision({ tool_name: 'Agent', tool_input: { model: 'opus', prompt: 'x' } }).updatedInput === undefined);
ok('DRIVEN: a non-Agent tool passes through unchanged',
  hookDecision({ tool_name: 'Bash', tool_input: { command: 'ls' } }).updatedInput === undefined);

/* ═══ 3. PIN: the shipped wiring matches the replica ════════════════════════ */
const runtimeSrc = fs.readFileSync(path.join(REPO, 'src/server/runtime/claude-runtime.ts'), 'utf8');
ok('PIN: the runtime wires decideFableTier for the Agent tool', /decideFableTier\(/.test(runtimeSrc));
ok('PIN: the runtime returns updatedInput on reroute (allow + rewrite, not deny)',
  /action === 'reroute'/.test(runtimeSrc) && /updatedInput: ft\.updatedInput/.test(runtimeSrc));
ok('PIN: the reroute uses permissionDecision allow, NOT deny (the lane runs)',
  /ft\.action === 'reroute'[\s\S]{0,300}permissionDecision: 'allow'/.test(runtimeSrc));
ok('PIN: the Fable gate is fleet-wide, not gated behind config.orchestratorProfile alone',
  /gitBlockOn \|\| config\.orchestratorProfile \|\| fableGateOn/.test(runtimeSrc));
ok('PIN: the Fable gate runs BEFORE the profile decide()',
  runtimeSrc.indexOf('decideFableTier(') < runtimeSrc.indexOf('const d = decide('));
ok('PIN: the open hatch is announced (never a silent bypass)',
  /Fable-tier gate DISABLED via ORCHARD_ALLOW_FABLE/.test(runtimeSrc));
ok('PIN: both a reroute and an override are logged (announceFableTier)',
  /announceFableTier\('rerouted'/.test(runtimeSrc) && /announceFableTier\(ft\.hatch \? 'hatch' : 'justified'/.test(runtimeSrc));

/* ═══ SUMMARY ═══════════════════════════════════════════════════════════════ */
for (const f of failures) console.log(`  FAIL  ${f}`);
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail} checks (Fable-tier gate, FEAT-124)`);

/* ═══ 4. --live: the END-TO-END property, on a REAL session (costs money) ═══
 * Proves the reroute is not an abort: a real orchestrator session dispatches an
 * Agent with `model: fable` and NO justification, and the lane RUNS and returns
 * (rather than the dispatch failing), while the runtime logs "REROUTED to opus".
 * Reading the lane's resolved model id from the stream is not reliably exposed by
 * the SDK, so this asserts the OBSERVABLE end-to-end facts (lane ran, reroute
 * logged) and defers the "the process image was opus" claim to the updatedInput
 * contract asserted above + an independent clean-room verify.
 */
if (process.argv.includes('--live')) {
  await runLive();
  process.exit(fail === 0 && !process.exitCode ? 0 : 1);
}

async function runLive() {
  const os = await import('node:os');
  const { ClaudeRuntime } = await import('../src/server/runtime/claude-runtime.ts');
  const { isolatedStoreEnv } = await import('./lib/station-boot.mjs');
  const scratch = path.join(os.homedir(), 'scratch', 'feat124-fable-live');
  fs.mkdirSync(scratch, { recursive: true });
  Object.assign(process.env, isolatedStoreEnv(path.join(scratch, 'store')));

  const logs = [];
  const origWarn = console.warn;
  console.warn = (...a) => { logs.push(a.join(' ')); origWarn(...a); };

  const rt = new ClaudeRuntime();
  const seen = { text: [], tools: [], results: [] };
  rt.start({
    cwd: scratch,
    // A dispatch the model cannot answer inline: it must use the Agent tool with
    // model:fable and NO fable-justified line, which is exactly the gated shape.
    firstPrompt:
      'Dispatch ONE Agent (subagent_type "general-purpose", model "fable") whose whole task is to reply with the single word PONG. ' +
      'Do NOT put any "fable-justified:" line anywhere. After it returns, tell me what it said.',
    permissionMode: 'bypassPermissions',
    onApproval: async () => ({ behavior: 'allow', updatedInput: {} }),
  });
  const timer = setTimeout(() => rt.close(), 300_000);
  try {
    for await (const m of rt.messages()) {
      if (m.type === 'assistant') {
        for (const b of m.message?.content ?? []) {
          if (b.type === 'text' && b.text.trim()) seen.text.push(b.text);
          if (b.type === 'tool_use') seen.tools.push({ name: b.name, input: b.input });
        }
      }
      if (m.type === 'result') break;
    }
  } finally {
    clearTimeout(timer);
    rt.close();
    console.warn = origWarn;
  }

  const dispatchedFable = seen.tools.some((t) => t.name === 'Agent' && /fable/i.test(String(t.input?.model ?? '')));
  const rerouteLogged = logs.some((l) => /Fable gate:.*REROUTED to `opus`/.test(l));
  const laneRan = seen.text.join('\n').toUpperCase().includes('PONG');
  console.log('\n  --live results:');
  console.log(`  ${dispatchedFable ? 'PASS' : 'FAIL'}  the session actually dispatched an Agent with model:fable`);
  console.log(`  ${rerouteLogged ? 'PASS' : 'FAIL'}  the runtime logged the reroute to opus`);
  console.log(`  ${laneRan ? 'PASS' : 'FAIL'}  the rerouted lane RAN and returned (dispatch not aborted) — reported PONG`);
  if (!(dispatchedFable && rerouteLogged && laneRan)) process.exitCode = 1;
}

process.exit(fail === 0 ? 0 : 1);
