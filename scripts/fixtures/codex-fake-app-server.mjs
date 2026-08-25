#!/usr/bin/env node
/**
 * FAKE `codex app-server` — a scripted stand-in for the real binary, used by
 * scripts/verify-codex-runtime.mjs and verify-provider-picker.mjs (FEAT-037).
 *
 * Speaks the JSON-RPC 2.0-over-stdio protocol (newline-delimited JSON) and
 * replays the SCHEMA-VALIDATED frames in codex-app-server.fixtures.json — see
 * that file's $provenance: shapes were checked against the REAL binary's
 * generated schema (`codex app-server generate-json-schema`, codex-cli
 * 0.146.0) in P2c, replacing the earlier documentation-derived guesses.
 *
 * It is also a protocol VALIDATOR: any client violation (request before
 * `initialize`, missing `initialized`, turn before thread, legacy key
 * spellings the real binary does not accept — `sandboxMode`,
 * `reasoningEffort` on thread/start — bad approval response shape, unknown
 * method) prints `VIOLATION: …` to stderr and exits 1. The verify script
 * asserts this process exits 0 — so a CodexRuntime that mis-speaks the
 * protocol fails the suite. In particular, the P2a-era approval response
 * {decision:'allow'|'deny'} is now a VIOLATION: execCommandApproval /
 * applyPatchApproval take a ReviewDecision — 'approved' |
 * 'approved_for_session' | {denied:{rejection}} | 'abort' | 'timed_out'.
 *
 * Turn behaviour is keyed by markers in the user input text:
 *   (none)              → the canonical simple turn (deltas → message → tokenUsage → completed)
 *   EXEC_APPROVAL       → command item + execCommandApproval server→client request
 *   PATCH_APPROVAL      → applyPatchApproval server→client request
 *   HANG                → turn/started then silence until turn/interrupt
 *   ASSERT_BYPASS       → require approvalPolicy=never + sandboxPolicy.type=dangerFullAccess
 *   ASSERT_MODEL:<id>;  → require the turn carried that model override
 *   FAIL_QUOTA          → turn/completed status:'failed' + codexErrorInfo usageLimitExceeded
 *   FAIL_MODEL          → turn/completed status:'failed' + codexErrorInfo badRequest (bad model)
 *   FAIL_OVERLOAD       → turn/completed status:'failed' + codexErrorInfo serverOverloaded
 *   FAIL_NET            → turn/completed status:'failed' + object codexErrorInfo (stream disconnect)
 *   HOLD_AGENTS:<n>[;QUOTA][;TICK:<ms>[:<afterMs>]] → hold n subagents running; QUOTA fails the
 *                         turn on the usage limit; TICK emits kind:'interacted' progress
 *                         heartbeats every <ms> (starting after <afterMs>) — BUG-046's stall suite
 *   SUBAGENT_INTERRUPT  → spawn + subAgentActivity kind:'interrupted' (agent must settle killed)
 *   SUBAGENT            → full collab scenario: spawnAgent → sub-thread thread/started
 *                         (SubAgentSource.thread_spawn; must NOT be adopted as the main thread id —
 *                         the follow-up turn/start threadId check catches that) → interacted →
 *                         depth-2 nested spawn + foreign-thread interrupted → wait completed
 *                         (agent state 'completed') → closeAgent (idempotent) → main answer.
 *                         Shapes SCHEMA-DERIVED (see fixtures $provenance) — not live-captured.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

const FIX = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'codex-app-server.fixtures.json'), 'utf8'));

const APPROVAL_POLICIES = new Set(['untrusted', 'on-request', 'never']);
const SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const SANDBOX_POLICY_TYPES = new Set(['readOnly', 'workspaceWrite', 'dangerFullAccess', 'externalSandbox']);

let initialized = false;         // saw `initialize` request
let initializedNotified = false; // saw `initialized` notification
let threadId = null;
let activeTurn = null;           // { id, hang }
/* BUG-046 — HOLD_AGENTS ;TICK progress heartbeat timers (see handleTurnStart). */
let holdTicker = null;
let holdTickerDelay = null;
function clearHoldTicker() {
  if (holdTicker) { clearInterval(holdTicker); holdTicker = null; }
  if (holdTickerDelay) { clearTimeout(holdTickerDelay); holdTickerDelay = null; }
}
let srvId = 0;                   // ids for server→client requests
const pendingApprovals = new Map(); // srv id → { method, resolve }

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function notify(frame) { send({ jsonrpc: '2.0', ...frame }); }
function respond(id, result) { send({ jsonrpc: '2.0', id, result }); }
function violation(msg) {
  process.stderr.write(`VIOLATION: ${msg}\n`);
  process.exit(1);
}
function serverRequest(method, params) {
  const id = `srv-${++srvId}`;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve) => pendingApprovals.set(id, { method, resolve }));
}

/** Validate a ReviewDecision (execCommandApproval / applyPatchApproval reply)
 *  against the REAL schema and reduce it to allow/deny for turn scripting. */
function reduceReviewDecision(result) {
  const d = result?.decision;
  if (d === 'approved' || d === 'approved_for_session') return 'allow';
  if (d === 'abort' || d === 'timed_out') return 'deny';
  if (d && typeof d === 'object' && d.denied && typeof d.denied.rejection === 'string') return 'deny';
  if (d && typeof d === 'object' && d.approved_execpolicy_amendment) return 'allow';
  violation(`approval response must be a ReviewDecision ('approved' | 'approved_for_session' | {denied:{rejection}} | 'abort' | 'timed_out'), got ${JSON.stringify(result)}`);
}

function failedTurn(id, fixture) {
  const turnId = fixture.params.turn.id;
  activeTurn = { id: turnId };
  respond(id, { turn: { id: turnId, status: 'inProgress', items: [] } });
  notify({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress', items: [] } } });
  notify({ ...fixture, params: { ...fixture.params, threadId } });
  activeTurn = null;
}

async function handleTurnStart(id, params) {
  if (!threadId) violation('turn/start before thread/start|resume|fork');
  if (params?.threadId !== threadId) violation(`turn/start threadId ${params?.threadId} !== ${threadId}`);
  if (activeTurn) violation('turn/start while a turn is active (client must serialise turns)');
  if ('sandboxMode' in (params ?? {})) violation("turn/start has no 'sandboxMode' key — the schema key is 'sandboxPolicy' (a SandboxPolicy object)");
  if (params?.approvalPolicy != null && !APPROVAL_POLICIES.has(params.approvalPolicy)) {
    violation(`turn/start approvalPolicy '${params.approvalPolicy}' is not in the AskForApproval enum (untrusted|on-request|never)`);
  }
  if (params?.sandboxPolicy != null
      && (typeof params.sandboxPolicy !== 'object' || !SANDBOX_POLICY_TYPES.has(params.sandboxPolicy.type))) {
    violation(`turn/start sandboxPolicy must be an object with type readOnly|workspaceWrite|dangerFullAccess, got ${JSON.stringify(params?.sandboxPolicy)}`);
  }
  const text = String(params?.input?.[0]?.text ?? '');
  if (params?.input?.[0]?.type !== 'text') violation('turn/start input[0] is not a text item');
  /*
   * FEAT-057 — when CODEX_FAKE_INPUT_LOG is set, append the EXACT prompt text
   * the engine received, one JSON line per turn. That is the only way to prove
   * from outside that the server's "while you were away" briefing actually
   * reached the turn (and, for a healthy session, that nothing was injected).
   */
  if (process.env.CODEX_FAKE_INPUT_LOG) {
    try { fs.appendFileSync(process.env.CODEX_FAKE_INPUT_LOG, `${JSON.stringify({ at: Date.now(), text })}\n`); }
    catch { /* logging must never break the protocol */ }
  }

  if (text.includes('ASSERT_BYPASS')
      && (params.approvalPolicy !== 'never' || params.sandboxPolicy?.type !== 'dangerFullAccess')) {
    violation(`ASSERT_BYPASS: got approvalPolicy=${params.approvalPolicy} sandboxPolicy=${JSON.stringify(params.sandboxPolicy)}`);
  }
  const mm = text.match(/ASSERT_MODEL:([^;]+);/);
  if (mm && params.model !== mm[1]) violation(`ASSERT_MODEL: got model=${params.model}, want ${mm[1]}`);

  if (text.includes('FAIL_QUOTA')) return failedTurn(id, FIX.failedTurns.quotaWindow);
  if (text.includes('FAIL_MODEL')) return failedTurn(id, FIX.failedTurns.badModel);
  if (text.includes('FAIL_OVERLOAD')) return failedTurn(id, FIX.failedTurns.overloaded);
  if (text.includes('FAIL_NET')) return failedTurn(id, FIX.failedTurns.network);

  if (text.includes('SUBAGENT_INTERRUPT')) {
    activeTurn = { id: 'turn_subint' };
    respond(id, { turn: { id: 'turn_subint', status: 'inProgress', items: [] } });
    for (const n of FIX.subagentInterruptTurn.notifications) notify(n);
    activeTurn = null;
    return;
  }

  if (text.includes('SUBAGENT')) {
    activeTurn = { id: 'turn_sub' };
    respond(id, { turn: { id: 'turn_sub', status: 'inProgress', items: [] } });
    for (const n of FIX.subagentTurn.notifications) notify(n);
    activeTurn = null;
    return;
  }

  /*
   * ARCH-001 phase 2 / BUG-034 — HOLD_AGENTS:<n>[;QUOTA]
   *
   * Spawn N subagents that STAY RUNNING and then hold the turn open, which is
   * the exact live shape the strip kept getting wrong ("three subagents were
   * genuinely in flight and the strip showed NONE of them"). Frames are the
   * same schema-derived collab shapes as `subagentTurn` above, emitted
   * programmatically so the count is a parameter.
   *
   * `;QUOTA` ends the held turn with the usage-limit failure instead of hanging
   * — FEAT-057's headline case: agents still running when the account hits its
   * limit, which must be recorded as `provider-error`, not as "completed".
   */
  const hold = text.match(/HOLD_AGENTS:(\d+)/);
  if (hold) {
    const n = Math.max(1, Math.min(8, Number(hold[1])));
    const turn = { id: 'turn_hold', status: 'inProgress', items: [] };
    activeTurn = { id: turn.id, hang: !text.includes('QUOTA') };
    respond(id, { turn });
    notify({ method: 'turn/started', params: { threadId, turn } });
    for (let i = 1; i <= n; i++) {
      const child = `thr_hold_agent_${i}`;
      const item = {
        id: `item_hold_spawn_${i}`,
        type: 'collabAgentToolCall',
        tool: 'spawnAgent',
        status: 'inProgress',
        senderThreadId: threadId,
        receiverThreadIds: [child],
        agentsStates: { [child]: { status: 'pendingInit', message: null } },
        prompt: `held worker ${i}`,
        model: null,
        reasoningEffort: null,
      };
      notify({ method: 'item/started', params: { threadId, turnId: turn.id, startedAtMs: Date.now(), item } });
      notify({
        method: 'thread/started',
        params: {
          thread: {
            id: child,
            agentRole: 'worker',
            agentNickname: `held-${i}`,
            source: { subAgent: { thread_spawn: { parent_thread_id: threadId, depth: 1, agent_role: 'worker', agent_nickname: `held-${i}`, agent_path: 'worker' } } },
          },
        },
      });
      notify({
        method: 'item/completed',
        params: {
          threadId, turnId: turn.id, completedAtMs: Date.now(),
          item: { ...item, status: 'completed', agentsStates: { [child]: { status: 'running', message: null } } },
        },
      });
    }
    if (text.includes('QUOTA')) {
      // Hold them running for a beat so an observer can see the live set first,
      // then fail the whole turn on the usage limit with the agents still open.
      setTimeout(() => {
        notify({
          method: 'turn/completed',
          params: {
            threadId,
            turn: {
              id: turn.id, status: 'failed', items: [],
              error: { message: "You've hit your usage limit. Your limit resets in 3 hours.", codexErrorInfo: 'usageLimitExceeded' },
            },
          },
        });
        activeTurn = null;
      }, Number(process.env.CODEX_FAKE_HOLD_MS ?? 3000));
    } else if (text.includes('COMPLETE')) {
      /*
       * BUG-077 — `;COMPLETE`: hold the agents RUNNING for a beat, then end the
       * turn NATURALLY (status:'completed') with those agents still running and
       * never closed. This is the exact shape a bridge-level test needs to
       * exercise the turn-end sweep's killed-vs-honest-unknown decision at a
       * NON-interrupted boundary — the case the idle-interrupt latch mislabels.
       * Purely additive: no existing marker path changes.
       */
      setTimeout(() => {
        notify({ method: 'turn/completed', params: { threadId, turn: { id: turn.id, status: 'completed', items: [] } } });
        activeTurn = null;
      }, Number(process.env.CODEX_FAKE_HOLD_MS ?? 3000));
    }
    /*
     * BUG-046 — `;TICK:<intervalMs>[:<startAfterMs>]` — emit a subAgentActivity
     * kind:'interacted' heartbeat for every held child on an interval (the shape
     * the runtime maps to task_progress). This is how the stall suite drives:
     *   - CHATTY work (ticks from t=0): silent windows never occur → never ⚠;
     *   - RECOVERY (ticks starting after a delay > the stall window): the rows
     *     genuinely stall first, then progress RESUMES and the ⚠ must clear.
     */
    const tick = text.match(/TICK:(\d+)(?::(\d+))?/);
    if (tick && !text.includes('QUOTA')) {
      const intervalMs = Math.max(50, Number(tick[1]));
      const startAfterMs = Number(tick[2] ?? 0);
      const beat = () => {
        for (let i = 1; i <= n; i++) {
          notify({
            method: 'item/started',
            params: {
              threadId, turnId: turn.id, startedAtMs: Date.now(),
              item: { id: `item_hold_tick_${i}_${Date.now()}`, type: 'subAgentActivity', agentThreadId: `thr_hold_agent_${i}`, agentPath: 'worker', kind: 'interacted' },
            },
          });
        }
      };
      holdTickerDelay = setTimeout(() => { holdTickerDelay = null; holdTicker = setInterval(beat, intervalMs); }, startAfterMs);
    }
    return; // otherwise: silence until turn/interrupt or the client goes away
  }

  if (text.includes('HANG')) {
    activeTurn = { id: 'turn_hang', hang: true };
    respond(id, { turn: { id: 'turn_hang', status: 'inProgress', items: [] } });
    notify({ method: 'turn/started', params: { threadId, turn: { id: 'turn_hang', status: 'inProgress', items: [] } } });
    return; // silence until turn/interrupt
  }

  if (text.includes('EXEC_APPROVAL')) {
    const F = FIX.execApprovalTurn;
    activeTurn = { id: 'turn_exec' };
    respond(id, { turn: { id: 'turn_exec', status: 'inProgress', items: [] } });
    notify({ method: 'turn/started', params: { threadId, turn: { id: 'turn_exec', status: 'inProgress', items: [] } } });
    notify(F.commandItemStarted);
    const decision = await serverRequest(F.approvalRequest.method, F.approvalRequest.params);
    notify(decision === 'allow' ? F.allowedItemCompleted : F.deniedItemCompleted);
    notify({ method: 'thread/tokenUsage/updated', params: { threadId, turnId: 'turn_exec', tokenUsage: { last: { inputTokens: 5, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0, totalTokens: 7 }, total: { inputTokens: 5, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0, totalTokens: 7 } } } });
    notify({ method: 'turn/completed', params: { threadId, turn: { id: 'turn_exec', status: 'completed', items: [] } } });
    activeTurn = null;
    return;
  }

  if (text.includes('PATCH_APPROVAL')) {
    activeTurn = { id: 'turn_patch' };
    respond(id, { turn: { id: 'turn_patch', status: 'inProgress', items: [] } });
    notify({ method: 'turn/started', params: { threadId, turn: { id: 'turn_patch', status: 'inProgress', items: [] } } });
    const decision = await serverRequest(FIX.patchApprovalRequest.method, FIX.patchApprovalRequest.params);
    notify({ method: 'item/completed', params: { threadId, turnId: 'turn_patch', completedAtMs: Date.now(), item: { id: 'item_patch_msg', type: 'agentMessage', text: `patch-decision: ${decision}` } } });
    notify({ method: 'thread/tokenUsage/updated', params: { threadId, turnId: 'turn_patch', tokenUsage: { last: { inputTokens: 4, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 5 }, total: { inputTokens: 4, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 5 } } } });
    notify({ method: 'turn/completed', params: { threadId, turn: { id: 'turn_patch', status: 'completed', items: [] } } });
    activeTurn = null;
    return;
  }

  // canonical simple turn
  activeTurn = { id: 'turn_0001' };
  respond(id, { turn: { id: 'turn_0001', status: 'inProgress', items: [] } });
  for (const n of FIX.simpleTurn.notifications) notify(n);
  activeTurn = null;
}

function validateThreadParams(method, params) {
  // The real binary's ThreadStartParams/ThreadResumeParams have `sandbox`
  // (SandboxMode string) and NO reasoning-effort key: the P2a-era spellings
  // are protocol violations now, which makes reverting the drift fixes fail.
  if ('sandboxMode' in (params ?? {})) violation(`${method} has no 'sandboxMode' key — the schema key is 'sandbox' (a SandboxMode string)`);
  if ('reasoningEffort' in (params ?? {})) violation(`${method} has no 'reasoningEffort' key — effort lives on turn/start as 'effort'`);
  if (params?.sandbox != null && !SANDBOX_MODES.has(params.sandbox)) {
    violation(`${method} sandbox '${params.sandbox}' is not in the SandboxMode enum (read-only|workspace-write|danger-full-access)`);
  }
  if (params?.approvalPolicy != null && !APPROVAL_POLICIES.has(params.approvalPolicy)) {
    violation(`${method} approvalPolicy '${params.approvalPolicy}' is not in the AskForApproval enum (untrusted|on-request|never)`);
  }
}

function handleFrame(frame) {
  // ---- responses to OUR server→client requests (approvals) ----
  if (frame.id != null && frame.method == null && pendingApprovals.has(frame.id)) {
    const waiter = pendingApprovals.get(frame.id);
    pendingApprovals.delete(frame.id);
    waiter.resolve(reduceReviewDecision(frame.result));
    return;
  }
  if (frame.id != null && frame.method == null) {
    violation(`response to unknown server request id ${frame.id}`);
  }

  const { id, method, params } = frame;
  if (method !== 'initialize' && !initialized) violation(`'${method}' before initialize`);

  switch (method) {
    case 'initialize':
      if (initialized) violation('duplicate initialize');
      if (!params?.clientInfo?.name || !params?.clientInfo?.version) violation('initialize clientInfo requires name AND version');
      initialized = true;
      respond(id, FIX.initialize.result);
      return;
    case 'initialized': // notification
      initializedNotified = true;
      return;
    case 'thread/start':
      if (!initializedNotified) violation('thread/start before initialized notification');
      if (typeof params?.cwd !== 'string' || !params.cwd) violation('thread/start missing cwd');
      validateThreadParams('thread/start', params);
      threadId = FIX.thread.startResult.thread.id;
      respond(id, FIX.thread.startResult);
      notify(FIX.thread.startedNotification);
      return;
    case 'thread/resume': {
      if (!initializedNotified) violation('thread/resume before initialized notification');
      // FEAT-037 P2b wire assertion: CODEX_FAKE_EXPECT_RESUME pins the ONE
      // thread id a resume may carry (the verify script sets it to the id the
      // first session minted) — resuming anything else is a violation, so a
      // bridge that "resumes" into a fresh thread fails the suite loudly.
      const expectResume = process.env.CODEX_FAKE_EXPECT_RESUME || FIX.thread.resumeThreadId;
      if (params?.threadId !== expectResume) violation(`thread/resume threadId ${params?.threadId}, want ${expectResume}`);
      validateThreadParams('thread/resume', params);
      threadId = params.threadId;
      respond(id, { ...FIX.thread.startResult, thread: { id: threadId } });
      notify({ method: 'thread/started', params: { thread: { id: threadId } } });
      return;
    }
    case 'thread/fork':
      if (params?.threadId !== FIX.thread.resumeThreadId) violation(`thread/fork threadId ${params?.threadId}, want ${FIX.thread.resumeThreadId}`);
      validateThreadParams('thread/fork', params);
      threadId = FIX.thread.forkResult.thread.id;
      respond(id, FIX.thread.forkResult);
      notify({ method: 'thread/started', params: { thread: { id: threadId } } });
      return;
    case 'model/list':
      respond(id, FIX.modelList.result);
      return;
    case 'turn/start':
      void handleTurnStart(id, params);
      return;
    case 'turn/interrupt':
      if (!activeTurn) violation('turn/interrupt with no active turn');
      if (params?.threadId !== threadId) violation(`turn/interrupt threadId ${params?.threadId} !== ${threadId}`);
      if (params?.turnId !== activeTurn.id) violation(`turn/interrupt turnId ${params?.turnId} !== ${activeTurn.id}`);
      respond(id, {});
      clearHoldTicker(); // BUG-046: a heartbeat must not outlive its turn
      notify({ ...FIX.interruptedTurnCompleted, params: { ...FIX.interruptedTurnCompleted.params, threadId } });
      activeTurn = null;
      return;
    default:
      violation(`unknown method '${method}'`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  let frame;
  try { frame = JSON.parse(t); } catch { violation(`non-JSON frame: ${t.slice(0, 120)}`); return; }
  handleFrame(frame);
});
rl.on('close', () => {
  // clean shutdown: stdin ended by the client's close(); exit 0 = no violations
  process.exit(0);
});
