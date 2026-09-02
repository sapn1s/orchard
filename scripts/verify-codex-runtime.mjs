#!/usr/bin/env node
/**
 * FEAT-037 P2a — CodexRuntime verified against a FAKE `codex app-server`
 * (scripts/fixtures/codex-fake-app-server.mjs), NO Codex install or ChatGPT
 * subscription needed.
 *
 *   node scripts/verify-codex-runtime.mjs           # must be all green
 *   node scripts/verify-codex-runtime.mjs --stub    # must FAIL (non-vacuity proof)
 *
 * PROVENANCE (P2c): the fake speaks SCHEMA-VALIDATED frames (see the fixtures
 * file's $provenance — checked against `codex app-server generate-json-schema`
 * from codex-cli 0.146.0) and VALIDATES the client's key spellings: the
 * P2a-era `sandboxMode` / thread-level `reasoningEffort` / approval
 * {decision:'allow'|'deny'} are now protocol VIOLATIONS, so reverting the P2c
 * drift fixes fails this suite.
 *
 * What it drives, end to end, through the REAL CodexRuntime class:
 *   1  handshake → thread/start → turn/start → streaming deltas → assistant
 *      text + thinking → result (usage tokens, NO total_cost_usd)
 *   2  follow-up send serialisation (second turn after the first completes)
 *   3  approval round-trip: exec ALLOW and exec DENY (tool_use/tool_result
 *      mapping incl. is_error), patch prompted deny, patch auto-allow under
 *      acceptEdits
 *   4  interrupt → turn/interrupt → result subtype 'interrupted'
 *   5  resume via thread/resume (init carries the resumed thread id) and
 *      fork via thread/fork
 *   6  model/list → RuntimeModel mapping (supportsEffort from effort options)
 *   7  bypassPermissions → approvalPolicy=never + sandboxMode=danger-full-access
 *      on the wire; setModel applies to the next turn
 *   8  honest capabilities; detection helper (connected / installed-not-signed-in
 *      / not-installed); ENOENT → honest transport error
 *   9  the fake VALIDATES the client protocol and exits 0 — a mis-speaking
 *      adapter trips a VIOLATION and fails here
 *
 * The fake child is injected through the runtime's own spawnProcess seam (the
 * same one docker-exec isolation uses), so the adapter's spawn contract
 * (command 'codex', args ['app-server']) is asserted too. Kill by pid only.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FAKE = path.join(ROOT, 'scripts', 'fixtures', 'codex-fake-app-server.mjs');
const STUB_MODE = process.argv.includes('--stub');
const WAIT_MS = STUB_MODE ? 1500 : 8000;

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mod = await import('../src/server/runtime/codex-runtime.ts');
const detectCodex = mod.detectCodex;

/** Non-vacuity: --stub swaps the real adapter for a do-nothing shell with the
 *  same interface. Every behavioural check below must then FAIL. */
class StubRuntime {
  capabilities = { approvals: false, permissionModes: false, structuredCost: false, modelList: false, subagents: false, persistedTranscript: false, fork: false, effort: false, planMode: false, mcpConfig: false };
  start() {}
  send() {}
  async interrupt() {}
  async setPermissionMode() {}
  async setModel() {}
  async supportedModels() { return []; }
  detach() {}
  close() {}
  messages() { return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }; }
}
const CodexRuntime = STUB_MODE ? StubRuntime : mod.CodexRuntime;

/* ------------------------------------------------------------- harness */

const children = [];
function makeHarness(startOverrides = {}, onApproval = async () => ({ behavior: 'allow', updatedInput: {} })) {
  const rt = new CodexRuntime();
  const msgs = [];
  let streamError = null;
  let spawnSeen = null;
  let childExit = null;
  const config = {
    cwd: '/tmp/fixture',
    firstPrompt: 'hello fixture',
    permissionMode: 'default',
    onApproval,
    spawnProcess: (req) => {
      spawnSeen = { command: req.command, args: req.args };
      const child = spawn(process.execPath, [FAKE], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
      children.push(child);
      child.once('exit', (code) => { childExit = code; });
      child.stderr.on('data', (d) => process.stderr.write(`  [fake] ${d}`));
      return child;
    },
    ...startOverrides,
  };
  const h = {
    rt, msgs, config,
    spawnSeen: () => spawnSeen,
    childExit: () => childExit,
    streamError: () => streamError,
    async waitFor(pred, ms = WAIT_MS) {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        const found = msgs.find(pred);
        if (found) return found;
        if (streamError) return null;
        await sleep(25);
      }
      return null;
    },
    start() {
      rt.start(config);
      void (async () => {
        try { for await (const m of rt.messages()) msgs.push(m); }
        catch (err) { streamError = err; }
      })();
    },
    async finish() {
      rt.close();
      // the fake exits 0 on stdin close — wait for that clean exit
      const until = Date.now() + 3000;
      while (childExit == null && Date.now() < until) await sleep(25);
    },
  };
  return h;
}

/* ------------------------------------------------------ 0. capabilities */

console.log('\n[0] capabilities are the appendix verdict, exactly');
{
  const caps = new CodexRuntime().capabilities;
  // P3 added the finer honesty flags: no plan mode, no per-session MCP config.
  // subagents:true since 2026-08-06 (ticket's subagent capability re-check —
  // codex 0.145+/0.146 multi-agent is stable + default-on and mapped below).
  // BUG-043 added `backgroundLifetime`: Codex declares 'absent' (it announces
  // subagent threads but has no "this work outlives the turn" signal), so the
  // close decision answers `unknown` while an agent row is still running and
  // `no` once every row settled (idle codex sessions close as before).
  // permissionModeMidTurn:false — Codex app-server has no mid-turn permission
  // switch (a change rides the NEXT turn/start), so the bridge/UI must not claim
  // a live toggle is in force while the running turn still prompts.
  const want = { approvals: true, permissionModes: true, permissionModeMidTurn: false, structuredCost: false, modelList: true, subagents: true, persistedTranscript: false, fork: true, effort: true, planMode: false, mcpConfig: false, backgroundLifetime: 'absent' };
  check('capabilities match appendix + 2026-08-06 subagent re-check', JSON.stringify(caps) === JSON.stringify(want), caps);
}

/* --------------------------------------------------------- 1. detection */

console.log('\n[1] detection helper (connected / not signed in / not installed)');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-codex-detect-'));
  const binDir = path.join(tmp, 'bin');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(binDir); fs.mkdirSync(home, { recursive: true });

  const none = detectCodex ? detectCodex({ PATH: binDir, HOME: home }) : null;
  check('no binary → not-installed', none?.status === 'not-installed' && !!none?.hint, none);

  fs.writeFileSync(path.join(binDir, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const noAuth = detectCodex ? detectCodex({ PATH: binDir, HOME: home }) : null;
  check('binary, no auth.json → installed-not-signed-in', noAuth?.status === 'installed-not-signed-in' && /codex login/.test(noAuth?.hint ?? ''), noAuth);

  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{}');
  const both = detectCodex ? detectCodex({ PATH: binDir, HOME: home }) : null;
  check('binary + auth.json → connected', both?.status === 'connected' && both?.binaryPath === path.join(binDir, 'codex'), both);

  const codexHome = path.join(tmp, 'elsewhere');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'auth.json'), '{}');
  const viaEnv = detectCodex ? detectCodex({ PATH: binDir, HOME: path.join(tmp, 'nohome'), CODEX_HOME: codexHome }) : null;
  check('CODEX_HOME honoured', viaEnv?.status === 'connected', viaEnv);

  // FEAT-037 P3: the systemd-service case observed live — binary installed at
  // ~/.local/bin/codex but the service's PATH does not include it. Detection
  // must still find it (PATH + well-known dirs), or the picker says
  // "not installed" while the user's terminal disagrees.
  const home2 = path.join(tmp, 'home2');
  fs.mkdirSync(path.join(home2, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home2, '.local', 'bin', 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const offPath = detectCodex ? detectCodex({ PATH: '/usr/bin-definitely-empty', HOME: home2 }) : null;
  check('binary in ~/.local/bin, stripped PATH → still detected (installed-not-signed-in)',
    offPath?.status === 'installed-not-signed-in' && offPath?.binaryPath === path.join(home2, '.local', 'bin', 'codex'), offPath);
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* -------------------------------------------- 2. start → stream → result */

console.log('\n[2] start → handshake → simple turn → result (+ follow-up serialisation)');
{
  const h = makeHarness();
  h.start();
  // P3: a bare 'codex' now resolves through detectCodex() (PATH + well-known
  // dirs) so a service PATH that misses ~/.local/bin cannot ENOENT — the
  // command is either the literal fallback or the detected absolute path.
  const spawnCmd = h.spawnSeen()?.command ?? '';
  check('spawn contract: codex app-server via the seam',
    (spawnCmd === 'codex' || /[\\/]codex$/.test(spawnCmd))
      && JSON.stringify(h.spawnSeen()?.args) === JSON.stringify(['app-server']), h.spawnSeen());

  const init = await h.waitFor((m) => m.type === 'system' && m.subtype === 'init');
  check('init carries thread id as session_id', init?.session_id === 'thr_fixture_0001' && init?.cwd === '/tmp/fixture', init);

  const delta = await h.waitFor((m) => m.type === 'stream_event');
  check('agentMessage delta → stream_event text_delta', delta?.event?.delta?.type === 'text_delta' && delta?.event?.delta?.text === 'Hello from ', delta);

  const text = await h.waitFor((m) => m.type === 'assistant' && m.message?.content?.[0]?.type === 'text');
  check('agentMessage completed → assistant text', text?.message?.content?.[0]?.text === 'Hello from fixture Codex.', text);

  const thinking = await h.waitFor((m) => m.type === 'assistant' && m.message?.content?.[0]?.type === 'thinking');
  check('reasoning item → thinking block (empty text by design)', thinking?.message?.content?.[0]?.thinking === '', thinking);

  const result = await h.waitFor((m) => m.type === 'result');
  check('turn/completed → result success, tokens only (no total_cost_usd; usage from thread/tokenUsage/updated)',
    result?.subtype === 'success' && result?.total_cost_usd === undefined && result?.usage?.outputTokens === 7, result);

  // follow-up turn (serialised — the first has completed)
  h.rt.send?.('second turn please');
  const results = async () => h.msgs.filter((m) => m.type === 'result').length;
  const second = await h.waitFor((m) => m.type === 'result' && h.msgs.filter((x) => x.type === 'result').length >= 2);
  check('follow-up send starts a second turn to completion', (await results()) >= 2 && !!second, `results=${await results()}`);

  await h.finish();
  check('fake app-server saw NO protocol violations (exit 0)', h.childExit() === 0, `exit=${h.childExit()}`);
}

/* -------------------------------------------------- 3. approvals both ways */

console.log('\n[3] approval round-trip: allow AND deny (+ patch, + acceptEdits auto-allow)');
{
  // ALLOW
  const seen = [];
  const h = makeHarness(
    { firstPrompt: 'EXEC_APPROVAL please' },
    async (req) => { seen.push(req); return { behavior: 'allow', updatedInput: { ...req.input } }; },
  );
  h.start();
  const call = await h.waitFor((m) => m.type === 'assistant' && m.message?.content?.[0]?.type === 'tool_use');
  check('command item → tool_use (Codex-native name + input)',
    call?.message?.content?.[0]?.name === 'commandExecution' && call?.message?.content?.[0]?.input?.command === 'rm -rf build', call);
  const res = await h.waitFor((m) => m.type === 'user' && m.message?.content?.[0]?.type === 'tool_result');
  check('ALLOW reached the server (fake echoes the decision into the tool_result)',
    res?.message?.content?.[0]?.content === 'decision-echo: allow' && res?.message?.content?.[0]?.is_error === false, res);
  check('onApproval got the wire params + meta', seen[0]?.toolName === 'commandExecution'
    && seen[0]?.input?.command === 'rm -rf build' && seen[0]?.meta?.toolUseID === 'call_cmd_1'
    && seen[0]?.meta?.description === 'cleans the build dir' && String(seen[0]?.meta?.requestId ?? '').startsWith('codex-'), seen[0]);
  await h.waitFor((m) => m.type === 'result');
  await h.finish();
  check('fake exit 0 after allow round-trip', h.childExit() === 0, `exit=${h.childExit()}`);

  // DENY
  const h2 = makeHarness(
    { firstPrompt: 'EXEC_APPROVAL please' },
    async () => ({ behavior: 'deny', message: 'nope' }),
  );
  h2.start();
  const res2 = await h2.waitFor((m) => m.type === 'user' && m.message?.content?.[0]?.type === 'tool_result');
  check('DENY reached the server as {denied:{rejection}} and maps status \'declined\' to an is_error tool_result',
    res2?.message?.content?.[0]?.content === 'decision-echo: deny' && res2?.message?.content?.[0]?.is_error === true, res2);
  await h2.waitFor((m) => m.type === 'result');
  await h2.finish();
  check('fake exit 0 after deny round-trip', h2.childExit() === 0, `exit=${h2.childExit()}`);

  // PATCH approval, prompted (default mode) → deny goes through the prompt
  const patchSeen = [];
  const h3 = makeHarness(
    { firstPrompt: 'PATCH_APPROVAL please' },
    async (req) => { patchSeen.push(req); return { behavior: 'deny', message: 'no edits' }; },
  );
  h3.start();
  const patchMsg = await h3.waitFor((m) => m.type === 'assistant' && /patch-decision/.test(m.message?.content?.[0]?.text ?? ''));
  check('applyPatchApproval prompted and deny delivered', patchMsg?.message?.content?.[0]?.text === 'patch-decision: deny'
    && patchSeen[0]?.toolName === 'applyPatch' && patchSeen[0]?.input?.fileChanges != null, patchMsg);
  await h3.finish();

  // PATCH approval under acceptEdits → auto-allow WITHOUT prompting
  let prompted = 0;
  const h4 = makeHarness(
    { firstPrompt: 'PATCH_APPROVAL please', permissionMode: 'acceptEdits' },
    async () => { prompted++; return { behavior: 'deny', message: 'should not be asked' }; },
  );
  h4.start();
  const auto = await h4.waitFor((m) => m.type === 'assistant' && /patch-decision/.test(m.message?.content?.[0]?.text ?? ''));
  check('acceptEdits auto-allows file-change approvals adapter-side (no prompt)',
    auto?.message?.content?.[0]?.text === 'patch-decision: allow' && prompted === 0, { text: auto?.message?.content?.[0]?.text, prompted });
  await h4.finish();
}

/* ------------------------------------------------------------ 4. interrupt */

console.log('\n[4] interrupt → turn/interrupt → result interrupted');
{
  const h = makeHarness({ firstPrompt: 'HANG until stopped' });
  h.start();
  await h.waitFor((m) => m.type === 'system' && m.subtype === 'init');
  await sleep(STUB_MODE ? 50 : 300); // let turn/started land so turnId is known
  await h.rt.interrupt?.();
  const result = await h.waitFor((m) => m.type === 'result');
  check('interrupt lands as result subtype interrupted', result?.subtype === 'interrupted', result);
  await h.finish();
  check('fake exit 0 (turn/interrupt spoken correctly)', h.childExit() === 0, `exit=${h.childExit()}`);
}

/* --------------------------------------------------------- 5. resume + fork */

console.log('\n[5] resume via thread/resume, fork via thread/fork');
{
  const h = makeHarness({ resume: 'thr_fixture_resume_77' });
  h.start();
  const init = await h.waitFor((m) => m.type === 'system' && m.subtype === 'init');
  check('resume: init carries the RESUMED thread id', init?.session_id === 'thr_fixture_resume_77', init);
  await h.waitFor((m) => m.type === 'result');
  await h.finish();
  check('fake exit 0 (thread/resume spoken correctly)', h.childExit() === 0, `exit=${h.childExit()}`);

  const h2 = makeHarness({ resume: 'thr_fixture_resume_77', forkSession: true });
  h2.start();
  const init2 = await h2.waitFor((m) => m.type === 'system' && m.subtype === 'init');
  check('fork: init carries a NEW forked thread id', init2?.session_id === 'thr_fixture_fork_0002', init2);
  await h2.waitFor((m) => m.type === 'result');
  await h2.finish();
  check('fake exit 0 (thread/fork spoken correctly)', h2.childExit() === 0, `exit=${h2.childExit()}`);
}

/* ------------------------------------------------------------ 6. model list */

console.log('\n[6] model/list → RuntimeModel mapping');
{
  const h = makeHarness();
  h.start();
  await h.waitFor((m) => m.type === 'result');
  const models = (await h.rt.supportedModels?.()) ?? [];
  check('models mapped (value/displayName/supportsEffort from effort options)',
    models.length === 2 && models[0]?.value === 'gpt-5.2-codex' && models[0]?.displayName === 'GPT-5.2 Codex'
    && models[0]?.supportsEffort === true && models[1]?.supportsEffort === false, models);
  await h.finish();
}

/* ------------------------------------- 7. mode + model overrides on the wire */

console.log('\n[7] permission-mode + model overrides reach the wire (next turn)');
{
  const h = makeHarness({ permissionMode: 'bypassPermissions', firstPrompt: 'ASSERT_BYPASS now' });
  h.start();
  const r = await h.waitFor((m) => m.type === 'result');
  await h.finish();
  check('bypassPermissions → approvalPolicy=never + danger-full-access (fake asserted, exit 0)',
    r != null && h.childExit() === 0, `result=${!!r} exit=${h.childExit()}`);

  const h2 = makeHarness();
  h2.start();
  await h2.waitFor((m) => m.type === 'result');
  await h2.rt.setModel?.('gpt-5.2');
  h2.rt.send?.('ASSERT_MODEL:gpt-5.2; second turn');
  const r2 = await h2.waitFor((m) => m.type === 'result' && h2.msgs.filter((x) => x.type === 'result').length >= 2);
  await h2.finish();
  check('setModel applies to the NEXT turn (fake asserted the model override, exit 0)',
    r2 != null && h2.childExit() === 0, `result=${!!r2} exit=${h2.childExit()}`);

  // plan mode: honestly refused, not silently ignored
  let planErr = null;
  try { await new CodexRuntime().setPermissionMode('plan'); } catch (err) { planErr = err; }
  check('plan mode is refused with an honest error', /no plan mode/.test(planErr?.message ?? ''), planErr?.message ?? '(no throw)');
}

/* ----------------------------------------------------- 8. transport honesty */

console.log('\n[8] absent binary → honest transport error (no hang, no lie)');
{
  const rt = new CodexRuntime();
  let streamErr = null;
  try {
    rt.start({
      cwd: '/tmp', firstPrompt: 'x', permissionMode: 'default',
      onApproval: async () => ({ behavior: 'deny', message: 'n/a' }),
      pathToExecutable: '/nonexistent/codex-definitely-not-here',
    });
    // race against a timeout so a stream that never settles (e.g. the --stub
    // adapter) counts as a FAIL instead of hanging the suite
    await Promise.race([
      (async () => { for await (const m of rt.messages()) void m; })(),
      sleep(WAIT_MS).then(() => { throw new Error('timeout: no transport error surfaced'); }),
    ]);
  } catch (err) { streamErr = err; }
  check('ENOENT surfaces as an honest thrown transport error',
    /not found|failed to spawn|closed|not started/i.test(streamErr?.message ?? ''), streamErr?.message ?? '(no throw)');
  rt.close?.();
}

/* --------------------------------- 9. failed turns + BUG-031 classification */

console.log('\n[9] turn/completed status:failed + codexErrorInfo → provider-error taxonomy');
{
  // NOTE: there is NO turn/failed on the real wire — these are turn/completed
  // frames with turn.status:'failed' + turn.error.codexErrorInfo, and the
  // classification keys on the STRUCTURED code, not regexes.
  async function failCase(marker) {
    const h = makeHarness({ firstPrompt: `${marker} now` });
    h.start();
    const result = await h.waitFor((m) => m.type === 'result');
    await h.finish();
    const pe = STUB_MODE || !result ? null : h.rt.classifyProviderError?.(result);
    return { result, pe, exit: h.childExit() };
  }

  const quota = await failCase('FAIL_QUOTA');
  check('failed turn → result error_during_execution + is_error (no turn/failed involved)',
    quota.result?.subtype === 'error_during_execution' && quota.result?.is_error === true
    && /usage limit/i.test(quota.result?.result ?? '') && quota.exit === 0, quota.result);
  check('codexErrorInfo usageLimitExceeded → quota-window (provider openai, not retryable, detail verbatim)',
    quota.pe?.kind === 'quota-window' && quota.pe?.provider === 'openai' && quota.pe?.retryable === false
    && quota.pe?.detail === "You've hit your usage limit. Your limit resets in 3 hours.", quota.pe);

  const model = await failCase('FAIL_MODEL');
  check("codexErrorInfo 'other' + model-not-supported text (LIVE-observed shape) → model-unavailable",
    model.pe?.kind === 'model-unavailable' && model.pe?.retryable === false && model.exit === 0, model.pe);

  const overload = await failCase('FAIL_OVERLOAD');
  check('codexErrorInfo serverOverloaded → overloaded (retryable)',
    overload.pe?.kind === 'overloaded' && overload.pe?.retryable === true && overload.exit === 0, overload.pe);

  const net = await failCase('FAIL_NET');
  check('object codexErrorInfo (responseStreamDisconnected) → network (retryable)',
    net.pe?.kind === 'network' && net.pe?.retryable === true && net.exit === 0, net.pe);

  // Non-vacuity of the classifier itself: a SUCCESS result classifies null.
  if (!STUB_MODE) {
    const rt = new CodexRuntime();
    const nul = rt.classifyProviderError?.({ type: 'result', subtype: 'success', is_error: false, usage: {} });
    check('success results classify null (no invented provider errors)', nul === null, nul);
  } else {
    check('success results classify null (no invented provider errors)', false, 'stub');
  }
}

/* --------------------------- 10. subagents → task-frame dialect (FEAT-037) */

console.log('\n[10] subagents: collab wire items → the bridge\'s task-frame dialect (BUG-030: agents SETTLE)');
{
  // NOTE the dialect contract asserted here: `subagent_type` present +
  // `task_type:'local_agent'` is exactly what agent-bridge's task_started
  // handler stamps kind:'agent' from (a LiveAgent row, not a tool-call row);
  // task_progress → agent-progress; task_updated{patch.status terminal} →
  // agent-completed. No bridge change needed — that is the point.
  const h = makeHarness({ firstPrompt: 'SUBAGENT spawn one worker' });
  h.start();

  const started = await h.waitFor((m) => m.type === 'system' && m.subtype === 'task_started' && m.task_id === 'thr_sub_agent_1');
  check('spawnAgent → system/task_started: task id = agentThreadId, description from the spawn prompt',
    !!started && /Compute 17\*23/.test(started?.description ?? ''), started);
  // The spawn item announces first (role unknown yet → generic label); the
  // sub-thread's thread/started brings agent_role and RE-announces the same
  // task_id with the honest label — the bridge overwrites its row in place.
  const relabeled = await h.waitFor((m) => m.subtype === 'task_started' && m.task_id === 'thr_sub_agent_1' && m.subagent_type === 'worker');
  check('row is a LiveAgent kind \'agent\': subagent_type from agent_role (via sub-thread thread/started) + task_type local_agent',
    relabeled?.subagent_type === 'worker' && relabeled?.task_type === 'local_agent' && relabeled?.tool_use_id === null, relabeled ?? started);

  const prog = await h.waitFor((m) => m.subtype === 'task_progress' && m.task_id === 'thr_sub_agent_1');
  check('subAgentActivity kind interacted / collab progress → task_progress (agent-progress heartbeat)', !!prog, prog);

  const nested = await h.waitFor((m) => m.subtype === 'task_started' && m.task_id === 'thr_sub_agent_2');
  check('depth-2 spawn is FLATTENED honestly: own row, parent thread noted in the description',
    nested?.subagent_type === 'helper' && /depth 2/.test(nested?.description ?? '') && /thr_sub_agent_1/.test(nested?.description ?? ''), nested);

  const settled = await h.waitFor((m) => m.subtype === 'task_updated' && m.task_id === 'thr_sub_agent_1' && m.patch?.status === 'completed');
  check('wait completed with agent state \'completed\' → terminal task_updated completed (row SETTLES)', !!settled, settled);

  const nestedKilled = await h.waitFor((m) => m.subtype === 'task_updated' && m.task_id === 'thr_sub_agent_2' && m.patch?.status === 'killed');
  check('nested agent interrupted (on the CHILD\'s stream) → task_updated killed — BUG-030: settles, never spins', !!nestedKilled, nestedKilled);

  // LIVE-SHAPED v1 agent (thr_sub_agent_3, replayed from the 2026-08-06 live
  // capture): announced ONLY by subAgentActivity started; its child thread's
  // own turn/completed streams on the same connection; the terminal `wait` has
  // EMPTY receivers/states. The ONLY honest settle left is the turn-boundary
  // sweep — and it must land BEFORE the result frame.
  const live = await h.waitFor((m) => m.subtype === 'task_started' && m.task_id === 'thr_sub_agent_3');
  check('live-shaped v1 spawn (subAgentActivity only) → task_started, label from agentPath basename',
    live?.subagent_type === 'live-shaped', live);

  const result = await h.waitFor((m) => m.type === 'result');
  check('parent turn still completes normally around the collab items (child turn/completed did NOT end it early)',
    result?.subtype === 'success' && result?.usage?.totalTokens === 41, result);
  const liveSettleIdx = h.msgs.findIndex((m) => m.subtype === 'task_updated' && m.task_id === 'thr_sub_agent_3' && m.patch?.status === 'completed');
  const resultIdx = h.msgs.findIndex((m) => m.type === 'result');
  check('live-shaped agent SETTLES via the turn-boundary sweep, before the result frame (BUG-030)',
    liveSettleIdx !== -1 && resultIdx !== -1 && liveSettleIdx < resultIdx, `settleIdx=${liveSettleIdx} resultIdx=${resultIdx}`);
  check('sub-thread deltas never leak into the MAIN transcript stream',
    !h.msgs.some((m) => m.type === 'stream_event' && /SUB-THREAD-ONLY/.test(m?.event?.delta?.text ?? ''))
    && !h.msgs.some((m) => m.type === 'assistant' && /SUB-THREAD-ONLY/.test(m?.message?.content?.[0]?.text ?? '')), 'no SUB-THREAD-ONLY text in main stream');
  const terminals = h.msgs.filter((m) => m.subtype === 'task_updated' && m.task_id === 'thr_sub_agent_1'
    && ['completed', 'failed', 'killed'].includes(m.patch?.status));
  check('settle is idempotent: exactly ONE terminal frame despite the late closeAgent', terminals.length === 1, `terminals=${terminals.length}`);

  // The sub-thread's thread/started (SubAgentSource.thread_spawn) must NOT
  // have been adopted as OUR thread id — the fake validates the follow-up
  // turn/start's threadId and would VIOLATION-exit otherwise.
  h.rt.send?.('after the subagents');
  const second = await h.waitFor((m) => m.type === 'result' && h.msgs.filter((x) => x.type === 'result').length >= 2);
  await h.finish();
  check('follow-up turn proves the child thread id was never adopted (fake exit 0)',
    !!second && h.childExit() === 0, `exit=${h.childExit()}`);

  // Interrupted-only scenario: the ONLY terminal signal is subAgentActivity
  // kind:'interrupted' — the row must settle as killed (cut), per BUG-030.
  const h2 = makeHarness({ firstPrompt: 'SUBAGENT_INTERRUPT now' });
  h2.start();
  const started2 = await h2.waitFor((m) => m.subtype === 'task_started' && m.task_id === 'thr_sub_kill_1');
  check('interrupt scenario: spawn announces the agent row', !!started2, started2);
  const killed = await h2.waitFor((m) => m.subtype === 'task_updated' && m.task_id === 'thr_sub_kill_1' && m.patch?.status === 'killed');
  check('subAgentActivity kind interrupted → task_updated killed (settled as cut, never ◐ forever)', !!killed, killed);
  await h2.waitFor((m) => m.type === 'result');
  await h2.finish();
  check('fake exit 0 after interrupt scenario', h2.childExit() === 0, `exit=${h2.childExit()}`);
}

/* ----------------------------------------------------------------- summary */

for (const c of children) { try { process.kill(c.pid, 'SIGKILL'); } catch { /* gone */ } }

console.log(`\n${STUB_MODE ? '[stub mode — this run is EXPECTED to fail]\n' : ''}TOTAL: ${pass} passed, ${fail} failed`);
if (failures.length) console.log('failing checks:\n  - ' + failures.join('\n  - '));
process.exit(fail === 0 ? 0 : 1);
