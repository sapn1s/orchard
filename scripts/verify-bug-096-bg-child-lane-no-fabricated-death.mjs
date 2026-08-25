#!/usr/bin/env node
/**
 * BUG-096 — THE TURN-END SWEEP MUST NOT FABRICATE A DEATH FOR THE FOREGROUND
 * CHILD LANE OF A BACKGROUND AGENT.
 *
 * THE DEFECT (proven from two transcripts). An async (background) worker agent is
 * spared by the turn-end `result` sweep (`#backgroundTasks` ∪ `#bgBornTasks`).
 * But a FOREGROUND `local_bash` that worker spawns is a SEPARATE task id, a
 * `kind:'tool'` row, and it is NEVER tagged background — `task_started` /
 * `task_progress` carry NO parent linkage (probed: SDK sdk.d.ts:4476-4520 has
 * `task_id`/`tool_use_id`/`subagent_type`/`task_type` only, no `parent_task_id`).
 * So when the MAIN turn ends while that child bash is mid-flight, the sweep sees
 * an orphan-looking foreground bash and writes a fabricated `unknown` DEATH for a
 * step that then SUCCEEDS (incident: death written 3.2s before the successful
 * tool_result). That false death is briefed to the orchestrator (BUG-037 harm:
 * distrust / re-dispatch of live work).
 *
 * THE FIX UNDER TEST (agent-bridge.ts, honest fallback). At the sweep, if any
 * background lane is still live, a `kind:'tool'` row is SETTLED (BUG-030: nothing
 * spins past `result`) but its outcome is NOT recorded — it may be that live
 * background lane's foreground child and the frames carry no parentage to prove
 * otherwise. Under-reporting a possible death is the honest side (outcomes.ts
 * 19-25); fabricating one is not.
 *
 * ENGINE: a scripted fake `claude` injected via CLAUDE_STATION_CLAUDE_BIN — real
 * server, real bridge, real ClaudeRuntime + SDK, only the model process scripted,
 * so the exact adversarial frame ordering is reproducible with no API cost.
 *
 * §C BAR:
 *   BGCHILD scenario — REALISTIC BUSY STATE: TWO background workers, each with a
 *   FOREGROUND child bash in flight when the main turn ends (mirrors a real busy
 *   day of async dispatch, not a minimal one-lane case).
 *     (1) NO FABRICATED DEATH — after `result`, ZERO `unknown` local_bash records
 *         for the still-running child lanes (FAILS pre-fix: two are written).
 *     (2) BACKGROUND WORKERS SPARED — both worker agent rows remain in /running
 *         (the fix did not stop sparing real background agents).
 *     (3) CHILD LANES SETTLED (not immortal) — the foreground child bash rows are
 *         REMOVED from /running at turn end (we suppressed the DEATH, not the
 *         settle; BUG-030 / the BUG-068 anti-over-spare bar preserved).
 *     (4) LATE SUCCESS, STILL HONEST — the child tool_results arrive successful
 *         AFTER the sweep and the ledger still holds no fabricated death.
 *   FGORPHAN scenario — CONTROL / ANTI-OVER-SUPPRESS: a plain FOREGROUND
 *   local_bash orphaned at turn end with NO background lane live STILL records an
 *   honest `unknown` death (BUG-030 preserved — we only hold the write when a
 *   background AGENT could be the parent).
 *   BGBASH scenario — ADVERSARIAL (independent verify's BROKEN case, run
 *     6b47aed7, adversarial run d816aaaa564f): the ONLY live background lane is a
 *     `run_in_background` BASH (a `kind:'tool'` local_bash tagged #bgBornTasks —
 *     the BUG-068 shape), with NO background AGENT at all. A background bash is a
 *     sibling LEAF, never a parent of another bash, so a genuinely orphaned
 *     FOREGROUND local_bash MUST still record its honest `unknown` death. FAILS
 *     against the pre-narrow guard (which suppressed on ANY live background lane),
 *     which silently swallowed the real death (orphanDeaths []).
 *   RETIRED scenario — ADVERSARIAL (verifier's second case): a background AGENT
 *     retired via its terminal frame BEFORE the sweep must not keep suppressing a
 *     foreground bash orphaned later in the same turn (a non-running agent cannot
 *     own the child).
 *
 * SAFETY: free port, scratch dataDir + scratch store + scratch project cwd; every
 * process killed BY PID. :4317 / the real service / scopes not ours are untouched.
 *
 * Usage: node scripts/verify-bug-096-bg-child-lane-no-fabricated-death.mjs
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bg096-data-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bg096-work-'));
const WORK_FG = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bg096-workfg-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bg096-store-'));
const FAKE = path.join(WORK, 'fake-claude.mjs');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${line}`);
  ok ? pass++ : (fail++, failures.push(name));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

/*
 * The scripted fake `claude`.
 *   SCENARIO=bgchild — the adversarial incident shape: dispatch TWO background
 *     Task workers (run_in_background:true → tagged #bgBornTasks via the
 *     dispatch tool_use_id), each announces a FOREGROUND child local_bash lane
 *     (a separate task id, NO run_in_background), then the assistant text and
 *     `result` fire while all four lanes are live. The child bash tool_results
 *     (success) arrive CHILD_DELAY_MS AFTER `result`, exactly as in the incident.
 *     The workers stay alive; a flag file drives their terminal frames.
 *   SCENARIO=fgorphan — CONTROL: one plain FOREGROUND local_bash, no background
 *     dispatch at all, no tool_result — orphaned at turn end. Must STILL be
 *     recorded as an honest `unknown` death (BUG-030 preserved).
 */
fs.writeFileSync(FAKE, `
import * as readline from 'node:readline';
import * as fs from 'node:fs';
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const SCENARIO = process.env.SCENARIO || 'bgchild';
const CHILD_DELAY_MS = Number(process.env.CHILD_DELAY_MS || 800);
const TERMINAL_FLAG = process.env.TERMINAL_FLAG || '';
const rl = readline.createInterface({ input: process.stdin });
let started = false;
let awaitingInterrupt = false; // INTERRUPTED scenario: emit the result only once the dashboard interrupt arrives
rl.on('line', (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.type === 'control_request') {
    say({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
    // The interrupt is a control_request that arrives AFTER setup — that is the
    // signal to end the turn as an interrupted one (#interruptRequested is set
    // server-side by session.interrupt()). The SDK reports it as error_during_execution.
    if (awaitingInterrupt) { awaitingInterrupt = false; say({ type: 'result', subtype: 'error_during_execution', total_cost_usd: 0 }); }
    return;
  }
  if (m.type !== 'user' || started) return;
  started = true;
  say({ type: 'system', subtype: 'init', session_id: 'fakesdk-' + process.pid, cwd: process.cwd(), model: 'haiku', tools: [], slash_commands: [] });

  if (SCENARIO === 'bgchild') {
    // Dispatch two BACKGROUND workers (run_in_background:true).
    say({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [
      { type: 'tool_use', id: 'task_tu_A', name: 'Task', input: { subagent_type: 'worker', description: 'bg worker A', run_in_background: true } },
      { type: 'tool_use', id: 'task_tu_B', name: 'Task', input: { subagent_type: 'worker', description: 'bg worker B', run_in_background: true } },
    ] } });
    // Their task_started (echo the dispatch tool_use_id → tagged #bgBornTasks).
    say({ type: 'system', subtype: 'task_started', task_id: 'workerA', tool_use_id: 'task_tu_A', subagent_type: 'worker', description: 'bg worker A' });
    say({ type: 'system', subtype: 'task_started', task_id: 'workerB', tool_use_id: 'task_tu_B', subagent_type: 'worker', description: 'bg worker B' });
    // Each worker spawns a FOREGROUND child local_bash — a SEPARATE task id, NO
    // run_in_background context. ARCH-003 (confirmed on real CLI 2.1.220 frames):
    // the child's tool_use rides an assistant frame carrying the OWNING worker's
    // parent_tool_use_id, emitted BEFORE the child's task_started (which echoes the
    // same tool_use id). That is the parentage the sweep now reads.
    say({ type: 'assistant', parent_tool_use_id: 'task_tu_A', message: { model: 'claude-haiku-4-5', content: [ { type: 'tool_use', id: 'bash_tu_A', name: 'Bash', input: { command: 'npm run verify:ui' } } ] } });
    say({ type: 'assistant', parent_tool_use_id: 'task_tu_B', message: { model: 'claude-haiku-4-5', content: [ { type: 'tool_use', id: 'bash_tu_B', name: 'Bash', input: { command: 'npm run typecheck' } } ] } });
    say({ type: 'system', subtype: 'task_started', task_id: 'childbashA', tool_use_id: 'bash_tu_A', task_type: 'local_bash', description: 'npm run verify:ui' });
    say({ type: 'system', subtype: 'task_started', task_id: 'childbashB', tool_use_id: 'bash_tu_B', task_type: 'local_bash', description: 'npm run typecheck' });
    // The MAIN turn ends while all four lanes are live.
    say({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [ { type: 'text', text: 'DISPATCHED 2 background workers' } ] } });
    say({ type: 'result', subtype: 'success', total_cost_usd: 0 });
    // The child bash results arrive LATE (successful) — as in the incident.
    setTimeout(() => {
      say({ type: 'user', message: { content: [ { type: 'tool_result', tool_use_id: 'bash_tu_A', is_error: false, content: 'PASS 14/14' } ] } });
      say({ type: 'user', message: { content: [ { type: 'tool_result', tool_use_id: 'bash_tu_B', is_error: false, content: 'typecheck ok' } ] } });
    }, CHILD_DELAY_MS);
    // The authoritative background level (post-result, for realism) + terminal.
    setTimeout(() => { say({ type: 'system', subtype: 'background_tasks_changed', tasks: [ { task_id: 'workerA', task_type: 'local_agent', description: 'bg worker A' }, { task_id: 'workerB', task_type: 'local_agent', description: 'bg worker B' } ] }); }, CHILD_DELAY_MS + 200);
    if (TERMINAL_FLAG) {
      const iv = setInterval(() => { if (fs.existsSync(TERMINAL_FLAG)) { clearInterval(iv);
        say({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
        say({ type: 'system', subtype: 'task_notification', task_id: 'workerA', status: 'completed', message: 'worker A finished' });
        say({ type: 'system', subtype: 'task_notification', task_id: 'workerB', status: 'completed', message: 'worker B finished' });
      } }, 200); iv.unref?.();
    }
    return;
  }

  if (SCENARIO === 'bgbash') {
    // ADVERSARIAL (independent verify's BROKEN case): the ONLY live background
    // lane is a run_in_background BASH — a kind:'tool' local_bash tagged
    // #bgBornTasks (the BUG-068 shape). NO background AGENT exists. Alongside it,
    // a SEPARATE genuinely orphaned FOREGROUND local_bash. A background bash is a
    // sibling LEAF, never a parent, so it must NOT suppress the orphan's honest
    // death. Pre-narrow (any live background lane suppresses) this FAILS: the
    // orphan's death is silently swallowed.
    say({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [
      { type: 'tool_use', id: 'bgbash_tu', name: 'Bash', input: { command: 'tail -f build.log', run_in_background: true } },
      { type: 'tool_use', id: 'fgorphan_tu', name: 'Bash', input: { command: 'sleep 300' } },
    ] } });
    // The background bash lane (tagged #bgBornTasks via its dispatch tool_use_id).
    say({ type: 'system', subtype: 'task_started', task_id: 'bgbashlane', tool_use_id: 'bgbash_tu', task_type: 'local_bash', description: 'tail -f build.log' });
    // A genuinely ORPHANED foreground bash — separate task id, NO run_in_background.
    say({ type: 'system', subtype: 'task_started', task_id: 'fgorphanbash', tool_use_id: 'fgorphan_tu', task_type: 'local_bash', description: 'sleep 300' });
    say({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [ { type: 'text', text: 'RAN' } ] } });
    say({ type: 'result', subtype: 'success', total_cost_usd: 0 });
    return;
  }

  if (SCENARIO === 'retired') {
    // ADVERSARIAL (independent verify's second case): a background AGENT is
    // RETIRED (terminal frame) BEFORE the sweep, then a foreground bash is
    // orphaned in the same turn. Stale #bgBornTasks/#backgroundTasks membership
    // must not keep suppressing the honest death: the retired agent is no longer
    // running, so it cannot own the child.
    say({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [
      { type: 'tool_use', id: 'task_tu_R', name: 'Task', input: { subagent_type: 'worker', description: 'bg worker R', run_in_background: true } },
    ] } });
    say({ type: 'system', subtype: 'task_started', task_id: 'workerR', tool_use_id: 'task_tu_R', subagent_type: 'worker', description: 'bg worker R' });
    // Retire the worker via its terminal frame BEFORE the turn ends.
    say({ type: 'system', subtype: 'task_updated', task_id: 'workerR', patch: { status: 'completed' } });
    // Now a genuinely orphaned FOREGROUND bash, same turn.
    say({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [
      { type: 'tool_use', id: 'fgorphan_tu', name: 'Bash', input: { command: 'sleep 300' } },
    ] } });
    say({ type: 'system', subtype: 'task_started', task_id: 'fgorphanbash', tool_use_id: 'fgorphan_tu', task_type: 'local_bash', description: 'sleep 300' });
    say({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [ { type: 'text', text: 'RAN' } ] } });
    say({ type: 'result', subtype: 'success', total_cost_usd: 0 });
    return;
  }

  if (SCENARIO === 'levelframe') {
    // ADVERSARIAL (independent verify's run 082916a8 BROKEN case #1 — the
    // resume/re-attach shape): a background AGENT is live per the engine's
    // authoritative background_tasks_changed LEVEL FRAME but NO task_started ever
    // created an #agents row for it. Alongside it, a genuinely orphaned FOREGROUND
    // child local_bash. The old #agents-join predicate could not see the level-only
    // agent, so it fabricated a death for the child bash. The level frame is
    // present at sweep time (a resume delivers it on re-attach, before the turn ends).
    // ARCH-003 re-attach DEGRADE: the child's assistant frame carries the resumed
    // agent's parent_tool_use_id, but we never saw that agent's task_started, so the
    // owner resolves to a raw tool_use id tracked nowhere — the non-null owner still
    // proves it is a subagent's child (never a main-thread orphan), so it is spared.
    say({ type: 'assistant', parent_tool_use_id: 'resumed_agent_tu', message: { model: 'claude-haiku-4-5', content: [ { type: 'tool_use', id: 'bash_tu_LF', name: 'Bash', input: { command: 'npm run verify:ui' } } ] } });
    say({ type: 'system', subtype: 'task_started', task_id: 'childbashLF', tool_use_id: 'bash_tu_LF', task_type: 'local_bash', description: 'npm run verify:ui' });
    say({ type: 'system', subtype: 'background_tasks_changed', tasks: [ { task_id: 'resumedAgent', task_type: 'local_agent', description: 'resumed background worker (no task_started row)' } ] });
    say({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [ { type: 'text', text: 'RAN' } ] } });
    say({ type: 'result', subtype: 'success', total_cost_usd: 0 });
    return;
  }

  if (SCENARIO === 'skiptrans') {
    // ADVERSARIAL (independent verify's run 082916a8 BROKEN case #2 — the
    // skip_transcript shape): a normally dispatched run_in_background Task whose
    // task_started carries skip_transcript:true, so the handler returns BEFORE
    // creating the #agents row — invisible to the old #agents-join predicate — yet
    // it IS listed live by the level frame. Alongside it, an orphaned FOREGROUND
    // child local_bash whose death must be suppressed.
    say({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [
      { type: 'tool_use', id: 'task_tu_S', name: 'Task', input: { subagent_type: 'worker', description: 'bg worker S', run_in_background: true } },
    ] } });
    // skip_transcript:true → task_started returns early; no #agents row, not born-tagged,
    // and no tool_use->agent mapping. ARCH-003: the child's assistant frame carries the
    // skip_transcript agent's parent_tool_use_id, which therefore resolves to a raw
    // tool_use id tracked nowhere → the re-attach DEGRADE spares it (non-null owner).
    say({ type: 'system', subtype: 'task_started', task_id: 'skipAgent', tool_use_id: 'task_tu_S', subagent_type: 'worker', description: 'bg worker S', skip_transcript: true });
    // A separate FOREGROUND child local_bash of the skip_transcript agent.
    say({ type: 'assistant', parent_tool_use_id: 'task_tu_S', message: { model: 'claude-haiku-4-5', content: [ { type: 'tool_use', id: 'bash_tu_ST', name: 'Bash', input: { command: 'npm run typecheck' } } ] } });
    say({ type: 'system', subtype: 'task_started', task_id: 'childbashST', tool_use_id: 'bash_tu_ST', task_type: 'local_bash', description: 'npm run typecheck' });
    // The authoritative level lists the skip_transcript agent as live (local_agent).
    say({ type: 'system', subtype: 'background_tasks_changed', tasks: [ { task_id: 'skipAgent', task_type: 'local_agent', description: 'bg worker S' } ] });
    say({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [ { type: 'text', text: 'RAN' } ] } });
    say({ type: 'result', subtype: 'success', total_cost_usd: 0 });
    return;
  }

  if (SCENARIO === 'interrupted') {
    // UNTESTED-LIST case: the sweep under interrupted:true with a live background
    // AGENT. Every prior scenario ended result subtype:success; this ends via a
    // dashboard interrupt. The suppression must still hold — a foreground child
    // bash under a live background agent must NOT be fabricated as a killed
    // death. Setup, then WAIT for the interrupt control_request (see the top).
    say({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [
      { type: 'tool_use', id: 'task_tu_I', name: 'Task', input: { subagent_type: 'worker', description: 'bg worker I', run_in_background: true } },
    ] } });
    say({ type: 'system', subtype: 'task_started', task_id: 'workerI', tool_use_id: 'task_tu_I', subagent_type: 'worker', description: 'bg worker I' });
    // ARCH-003: the child rides worker I's parent_tool_use_id (owner resolves to the
    // live background agent workerI) before its own local_bash task_started.
    say({ type: 'assistant', parent_tool_use_id: 'task_tu_I', message: { model: 'claude-haiku-4-5', content: [ { type: 'tool_use', id: 'bash_tu_I', name: 'Bash', input: { command: 'npm run verify:ui' } } ] } });
    say({ type: 'system', subtype: 'task_started', task_id: 'childbashI', tool_use_id: 'bash_tu_I', task_type: 'local_bash', description: 'npm run verify:ui' });
    say({ type: 'system', subtype: 'background_tasks_changed', tasks: [ { task_id: 'workerI', task_type: 'local_agent', description: 'bg worker I' } ] });
    say({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [ { type: 'text', text: 'DISPATCHED, now working…' } ] } });
    awaitingInterrupt = true; // the turn ends only when the dashboard interrupt lands
    return;
  }

  // fgorphan CONTROL — a plain FOREGROUND local_bash, no background lane, no
  // tool_result: orphaned at turn end. BUG-030: this MUST record an unknown death.
  say({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [
    { type: 'tool_use', id: 'fg_tu', name: 'Bash', input: { command: 'sleep 300' } },
  ] } });
  say({ type: 'system', subtype: 'task_started', task_id: 'fgorphanbash', tool_use_id: 'fg_tu', task_type: 'local_bash', description: 'sleep 300' });
  say({ type: 'assistant', message: { model: 'claude-haiku-4-5', content: [ { type: 'text', text: 'RAN' } ] } });
  say({ type: 'result', subtype: 'success', total_cost_usd: 0 });
});
process.stdin.resume();
`);

const servers = new Set();
function spawnServer(port, env, onLog) {
  const s = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE,
      CLAUDE_STATION_CLAUDE_BIN: FAKE, CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  s.stdout?.on('data', (d) => onLog?.(String(d))); s.stderr?.on('data', (d) => onLog?.(String(d)));
  servers.add(s);
  return s;
}
async function waitHealth(port) { for (let i = 0; i < 160; i++) { try { await fetch(`http://127.0.0.1:${port}/api/health`); return true; } catch { await sleep(250); } } return false; }
function openWs(port) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); const events = [];
    ws.on('message', (raw) => { try { events.push(JSON.parse(String(raw))); } catch {} });
    ws.once('open', () => res({ ws, events, send: (o) => ws.send(JSON.stringify(o)) }));
    ws.once('error', rej); ws.on('error', () => {});
  });
}
const waitEv = async (events, pred, ms = 60_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const h = events.find(pred); if (h) return h; await sleep(120); } return null; };
const getRunning = async (port, id) => (await (await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/running`)).json()).snapshot;
const rowsByLabel = (snap, label) => (snap?.running ?? []).filter((r) => r.label === label);
const rowsById = (snap, id) => (snap?.running ?? []).filter((r) => r.id === id);
const unknownLbDeaths = (snap) => (snap?.ended ?? []).filter((o) => o.label === 'local_bash' && o.kind === 'unknown');
const deathsForId = (snap, id) => (snap?.ended ?? []).filter((o) => o.agentId === id && o.kind === 'unknown');
// Any recorded death for an id, whatever the kind (the interrupted sweep records `killed`, not `unknown`).
const endedForId = (snap, id) => (snap?.ended ?? []).filter((o) => o.agentId === id);

async function startSession(port, projectId, prompt) {
  const c = await openWs(port);
  c.send({ type: 'start', projectId, overrides: { model: 'haiku', permissionMode: 'bypassPermissions' }, prompt });
  const ack = await waitEv(c.events, (e) => e.t === 'ack' && e.of === 'start');
  if (!ack) throw new Error('no start ack');
  return { c, stationId: ack.stationSessionId };
}
async function register(port, cwd, name) {
  const r = await (await fetch(`http://127.0.0.1:${port}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: cwd, name }) })).json();
  if (!r.project?.id) throw new Error(`register(${name}) failed ` + JSON.stringify(r));
  return r.project.id;
}

async function main() {
  // ---- Server A: BGCHILD (adversarial, realistic busy state). ----
  const portBg = await freePort();
  const flag = path.join(WORK, 'terminal.flag');
  spawnServer(portBg, { SCENARIO: 'bgchild', CHILD_DELAY_MS: '900', TERMINAL_FLAG: flag });
  if (!(await waitHealth(portBg))) throw new Error('bgchild server never healthy');
  const pidBg = await register(portBg, WORK, 'bg096-bgchild');
  const { c, stationId } = await startSession(portBg, pidBg, 'dispatch two async workers, each running a foreground verify bash');
  await waitEv(c.events, (e) => e.t === 'agent-started', 30_000);
  const end = await waitEv(c.events, (e) => e.t === 'turn-end', 30_000);
  if (!end) throw new Error('bgchild turn never ended');

  // Poll immediately after `result`, BEFORE the child tool_results arrive — this
  // is the exact fabrication window.
  const preSnap = await getRunning(portBg, stationId);
  check('(1) NO FABRICATED DEATH: after `result` with two foreground child bashes still in flight, ZERO `unknown` local_bash outcomes were recorded (FAILS pre-fix: the sweep writes one per child)',
    unknownLbDeaths(preSnap).length === 0,
    { unknownLocalBashDeaths: unknownLbDeaths(preSnap).map((o) => `${o.id}:${o.detail?.slice(0, 48)}`), count: unknownLbDeaths(preSnap).length });

  const workerRows = rowsByLabel(preSnap, 'worker');
  check('(2) BACKGROUND WORKERS SPARED: both background worker agent rows remain in /running past the turn boundary (real background agents are still spared)',
    workerRows.length === 2 && preSnap.turn.running === false,
    { workerRows: workerRows.map((r) => `${r.row}:${r.id}:${r.state}`), turnRunning: preSnap?.turn?.running });

  check('(3) CHILD LANES SETTLED (not immortal): the foreground child local_bash rows are REMOVED from /running at turn end — the DEATH is suppressed, not the settle (BUG-030 / BUG-068 anti-over-spare preserved)',
    rowsByLabel(preSnap, 'local_bash').length === 0,
    { localBashRows: rowsByLabel(preSnap, 'local_bash').map((r) => `${r.id}:${r.state}`) });

  // Let the late (successful) child tool_results land — the ledger must stay honest.
  await sleep(1800);
  const lateSnap = await getRunning(portBg, stationId);
  check('(4) LATE SUCCESS, STILL HONEST: the child bash tool_results arrived successful AFTER the sweep and the ledger holds NO fabricated local_bash death',
    unknownLbDeaths(lateSnap).length === 0,
    { unknownLocalBashDeaths: unknownLbDeaths(lateSnap).length });

  // Terminal frames retire the workers — sanity that nothing wedges.
  fs.writeFileSync(flag, '1');
  await sleep(1200);
  try { c.ws.close(); } catch {}

  // ---- Server B: FGORPHAN control — a real foreground bash death must survive. ----
  const portFg = await freePort();
  spawnServer(portFg, { SCENARIO: 'fgorphan' });
  if (!(await waitHealth(portFg))) throw new Error('fgorphan server never healthy');
  const pidFg = await register(portFg, WORK_FG, 'bg096-fgorphan');
  const fg = await startSession(portFg, pidFg, 'run a plain foreground bash');
  await waitEv(fg.c.events, (e) => e.t === 'agent-started', 30_000);
  const fgEnd = await waitEv(fg.c.events, (e) => e.t === 'turn-end', 30_000);
  if (!fgEnd) throw new Error('fgorphan turn never ended');
  await sleep(600);
  const fgSnap = await getRunning(portFg, fg.stationId);
  check('(5) CONTROL / ANTI-OVER-SUPPRESS: a plain FOREGROUND local_bash orphaned at turn end with NO background lane live STILL records an honest `unknown` death (BUG-030 preserved — the fix only holds the write when a background parent could exist)',
    unknownLbDeaths(fgSnap).length === 1 && rowsByLabel(fgSnap, 'local_bash').length === 0,
    { unknownLocalBashDeaths: unknownLbDeaths(fgSnap).map((o) => `${o.id}:${o.detail?.slice(0, 48)}`), localBashRowsStillRunning: rowsByLabel(fgSnap, 'local_bash').length });
  try { fg.c.ws.close(); } catch {}

  // ---- Server C: BGBASH adversarial (independent verify's BROKEN case). ----
  // The only live background lane is a run_in_background BASH (a kind:'tool'
  // #bgBornTasks lane), NO background AGENT — a genuinely orphaned foreground
  // bash MUST still record an honest death. FAILS against the pre-narrow guard.
  const portBb = await freePort();
  const WORK_BB = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bg096-workbb-'));
  spawnServer(portBb, { SCENARIO: 'bgbash' });
  if (!(await waitHealth(portBb))) throw new Error('bgbash server never healthy');
  const pidBb = await register(portBb, WORK_BB, 'bg096-bgbash');
  const bb = await startSession(portBb, pidBb, 'run a background bash and a separate foreground bash');
  await waitEv(bb.c.events, (e) => e.t === 'agent-started', 30_000);
  const bbEnd = await waitEv(bb.c.events, (e) => e.t === 'turn-end', 30_000);
  if (!bbEnd) throw new Error('bgbash turn never ended');
  await sleep(600);
  const bbSnap = await getRunning(portBb, bb.stationId);
  const bgBashRow = rowsById(bbSnap, 'bgbashlane');
  const workerRowsBb = rowsByLabel(bbSnap, 'worker');
  check('(6) BGBASH SETUP: the background BASH lane is live/spared at turn end and NO background AGENT exists (every lane here is a local_bash tool row)',
    bgBashRow.length === 1 && workerRowsBb.length === 0,
    { bgRow: bgBashRow.map((r) => `${r.id}:${r.state}`), workerRows: workerRowsBb.length });
  check('(7) BGBASH ANTI-OVER-SUPPRESS: with NO background AGENT live, the genuinely orphaned FOREGROUND local_bash records an honest `unknown` death at turn end (FAILS pre-narrow: a background bash suppressed it, orphanDeaths [])',
    deathsForId(bbSnap, 'fgorphanbash').length === 1,
    { orphanDeaths: deathsForId(bbSnap, 'fgorphanbash').map((o) => `${o.agentId}:${o.detail?.slice(0, 40)}`), allEnded: (bbSnap?.ended ?? []).map((o) => `${o.agentId}:${o.kind}`) });
  check('(8) BGBASH SETTLED: the orphaned foreground local_bash row is removed from /running at turn end (BUG-030), the background bash stays live',
    rowsById(bbSnap, 'fgorphanbash').length === 0 && bgBashRow.length === 1,
    { orphanStillRunning: rowsById(bbSnap, 'fgorphanbash').length });
  try { bb.c.ws.close(); } catch {}

  // ---- Server D: RETIRED adversarial (independent verify's second case). ----
  // A background AGENT retired via its terminal frame BEFORE the sweep must not
  // keep suppressing a foreground bash orphaned later in the same turn.
  const portRt = await freePort();
  const WORK_RT = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bg096-workrt-'));
  spawnServer(portRt, { SCENARIO: 'retired' });
  if (!(await waitHealth(portRt))) throw new Error('retired server never healthy');
  const pidRt = await register(portRt, WORK_RT, 'bg096-retired');
  const rt = await startSession(portRt, pidRt, 'retire a background worker then orphan a foreground bash');
  await waitEv(rt.c.events, (e) => e.t === 'agent-started', 30_000);
  const rtEnd = await waitEv(rt.c.events, (e) => e.t === 'turn-end', 30_000);
  if (!rtEnd) throw new Error('retired turn never ended');
  await sleep(600);
  const rtSnap = await getRunning(portRt, rt.stationId);
  check('(9) RETIRED SETUP: the background worker agent was retired (terminal frame) BEFORE the sweep — no worker lane is live at the boundary',
    rowsByLabel(rtSnap, 'worker').length === 0,
    { workerRows: rowsByLabel(rtSnap, 'worker').map((r) => `${r.id}:${r.state}`) });
  check('(10) RETIRED ANTI-OVER-SUPPRESS: a retired background agent must not suppress the honest `unknown` death of the orphaned foreground local_bash',
    deathsForId(rtSnap, 'fgorphanbash').length === 1,
    { orphanDeaths: deathsForId(rtSnap, 'fgorphanbash').map((o) => `${o.agentId}:${o.detail?.slice(0, 40)}`), allEnded: (rtSnap?.ended ?? []).map((o) => `${o.agentId}:${o.kind}`) });
  check('(11) RETIRED SETTLED: the orphaned foreground local_bash row is removed from /running at turn end (BUG-030)',
    rowsById(rtSnap, 'fgorphanbash').length === 0,
    { orphanStillRunning: rowsById(rtSnap, 'fgorphanbash').length });
  try { rt.c.ws.close(); } catch {}

  // ---- Server E: LEVELFRAME adversarial (082916a8 BROKEN case #1, resume shape). ----
  // A background AGENT live per the level frame with NO #agents row must suppress
  // the fabricated death of its possible foreground child bash. FAILS pre-fix
  // (the #agents-join predicate cannot see a level-only agent).
  const portLf = await freePort();
  const WORK_LF = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bg096-worklf-'));
  spawnServer(portLf, { SCENARIO: 'levelframe' });
  if (!(await waitHealth(portLf))) throw new Error('levelframe server never healthy');
  const pidLf = await register(portLf, WORK_LF, 'bg096-levelframe');
  const lf = await startSession(portLf, pidLf, 'resume-shape: a background agent listed only by the level frame, plus a foreground child bash');
  await waitEv(lf.c.events, (e) => e.t === 'agent-started', 30_000);
  const lfEnd = await waitEv(lf.c.events, (e) => e.t === 'turn-end', 30_000);
  if (!lfEnd) throw new Error('levelframe turn never ended');
  await sleep(600);
  const lfSnap = await getRunning(portLf, lf.stationId);
  check('(12) LEVELFRAME-ONLY AGENT: a background AGENT live per the background_tasks_changed LEVEL FRAME with NO task_started/#agents row (resume/re-attach shape) suppresses the fabricated death of its possible foreground child bash (FAILS pre-fix: the #agents-join predicate cannot see a level-only agent, so it writes an `unknown` death for childbashLF)',
    deathsForId(lfSnap, 'childbashLF').length === 0 && unknownLbDeaths(lfSnap).length === 0,
    { childDeaths: deathsForId(lfSnap, 'childbashLF').map((o) => `${o.agentId}:${o.detail?.slice(0, 40)}`), unknownLocalBash: unknownLbDeaths(lfSnap).length });
  check('(13) LEVELFRAME SETTLED: the foreground child local_bash row is removed from /running at turn end (BUG-030 — the death is suppressed, not the settle)',
    rowsById(lfSnap, 'childbashLF').length === 0,
    { childStillRunning: rowsById(lfSnap, 'childbashLF').length });
  try { lf.c.ws.close(); } catch {}

  // ---- Server F: SKIPTRANS adversarial (082916a8 BROKEN case #2, skip_transcript). ----
  // A run_in_background Task whose task_started carried skip_transcript:true (no
  // #agents row) but which the level frame lists live must suppress its possible
  // foreground child bash's death. FAILS pre-fix for the same reason.
  const portSt = await freePort();
  const WORK_ST = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bg096-workst-'));
  spawnServer(portSt, { SCENARIO: 'skiptrans' });
  if (!(await waitHealth(portSt))) throw new Error('skiptrans server never healthy');
  const pidSt = await register(portSt, WORK_ST, 'bg096-skiptrans');
  const st = await startSession(portSt, pidSt, 'skip_transcript background agent listed by the level frame, plus a foreground child bash');
  await waitEv(st.c.events, (e) => e.t === 'agent-started', 30_000);
  const stEnd = await waitEv(st.c.events, (e) => e.t === 'turn-end', 30_000);
  if (!stEnd) throw new Error('skiptrans turn never ended');
  await sleep(600);
  const stSnap = await getRunning(portSt, st.stationId);
  check('(14) SKIP_TRANSCRIPT AGENT: a run_in_background Task whose task_started returned early on skip_transcript:true (no #agents row) but which the level frame lists live suppresses the fabricated death of its possible foreground child bash (FAILS pre-fix: invisible to the #agents-join predicate → `unknown` death for childbashST)',
    deathsForId(stSnap, 'childbashST').length === 0 && unknownLbDeaths(stSnap).length === 0,
    { childDeaths: deathsForId(stSnap, 'childbashST').map((o) => `${o.agentId}:${o.detail?.slice(0, 40)}`), unknownLocalBash: unknownLbDeaths(stSnap).length });
  check('(15) SKIP_TRANSCRIPT SETTLED: the foreground child local_bash row is removed from /running at turn end (BUG-030)',
    rowsById(stSnap, 'childbashST').length === 0,
    { childStillRunning: rowsById(stSnap, 'childbashST').length });
  try { st.c.ws.close(); } catch {}

  // ---- Server G: INTERRUPTED (UNTESTED-list path — interrupted:true at the sweep). ----
  // The turn ends via a dashboard interrupt while a background AGENT is live and a
  // foreground child bash is mid-flight: the child must NOT be fabricated as a
  // `killed` death (the suppression is independent of how the turn ended).
  const portIn = await freePort();
  const WORK_IN = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bg096-workin-'));
  spawnServer(portIn, { SCENARIO: 'interrupted' });
  if (!(await waitHealth(portIn))) throw new Error('interrupted server never healthy');
  const pidIn = await register(portIn, WORK_IN, 'bg096-interrupted');
  const inn = await startSession(portIn, pidIn, 'dispatch a background worker with a live foreground child bash, then interrupt the turn');
  // Wait until the child bash lane is up. The fake emits worker + child
  // task_started + the level frame in one synchronous burst, so once the first
  // agent-started lands a short settle guarantees all three are processed.
  await waitEv(inn.c.events, (e) => e.t === 'agent-started' && e.agent?.agentId === 'childbashI', 30_000)
    ?? await waitEv(inn.c.events, (e) => e.t === 'agent-started', 30_000);
  await sleep(400);
  inn.c.send({ type: 'interrupt' });
  const inEnd = await waitEv(inn.c.events, (e) => e.t === 'turn-end', 30_000);
  if (!inEnd) throw new Error('interrupted turn never ended');
  await sleep(600);
  const inSnap = await getRunning(portIn, inn.stationId);
  check('(16) INTERRUPTED SWEEP: with a live background AGENT, an interrupt at turn end records NO death (neither `killed` nor `unknown`) for the foreground child bash (the suppression is independent of interrupted; every prior scenario ended success)',
    endedForId(inSnap, 'childbashI').length === 0,
    { childEnded: endedForId(inSnap, 'childbashI').map((o) => `${o.agentId}:${o.kind}`), turnState: inSnap?.turn?.state });
  check('(17) INTERRUPTED SETTLED: the foreground child local_bash row is removed from /running at the interrupted turn end (BUG-030), and the background worker is still spared',
    rowsById(inSnap, 'childbashI').length === 0 && rowsByLabel(inSnap, 'worker').length === 1,
    { childStillRunning: rowsById(inSnap, 'childbashI').length, workerRows: rowsByLabel(inSnap, 'worker').length });
  try { inn.c.ws.close(); } catch {}

  for (const d of [WORK_BB, WORK_RT, WORK_LF, WORK_ST, WORK_IN]) fs.rmSync(d, { recursive: true, force: true });
}

let fatal = false;
main().catch((e) => { console.error('FATAL', e.stack ?? e.message); fatal = true; process.exitCode = 1; }).finally(async () => {
  await sleep(400);
  try { for (const f of fs.readdirSync(path.join(DATA, 'session-hosts'))) { try { const h = JSON.parse(fs.readFileSync(path.join(DATA, 'session-hosts', f), 'utf8')); for (const p of [h.claudePid, h.hostPid]) if (p && pidAlive(p)) try { process.kill(p, 'SIGKILL'); } catch {} } catch {} } } catch {}
  for (const s of servers) { if (s?.pid) { try { process.kill(s.pid, 'SIGTERM'); } catch {} setTimeout(() => { try { process.kill(s.pid, 'SIGKILL'); } catch {} }, 2000).unref(); } }
  setTimeout(() => {
    console.log(`\n${pass}/${pass + fail} checks passed${fatal ? ' (FATAL — the run aborted before completing)' : ''}`);
    if (fail) console.log(`failed: ${failures.join(' | ')}`);
    for (const d of [DATA, WORK, WORK_FG, STORE]) fs.rmSync(d, { recursive: true, force: true });
    // A FATAL abort must not be reported as success: a run that verified nothing
    // (e.g. the server never booted → 0/0) exits non-zero, never a green 0.
    process.exit((fail || fatal || pass + fail === 0) ? 1 : 0);
  }, 1500);
});
