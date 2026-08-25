/**
 * FEAT-055 — a session's FIRST turn must have its configured MCP servers, or
 * the turn must WAIT (bounded) and then say honestly that it started without
 * them. Never a silently tool-less turn one; never an unbounded wait; zero
 * added latency for sessions with no MCP servers configured.
 *
 *   node scripts/verify-mcp-ready.mjs
 *
 * Probed ground truth this is built on (live, claude CLI + SDK 0.3.220):
 *  - streaming-input mode answers the `mcpServerStatus` control request from
 *    ~0.6s, BEFORE any turn, and transitions pending→connected on its own;
 *  - `system:init` is emitted at first-TURN start (not CLI boot), so a held
 *    first prompt yields an init that truthfully reports `connected`;
 *  - `claude -p` (the one-shot dispatch path) DOES wait for MCP servers
 *    before its single turn — part D pins that as a contract so a CLI
 *    regression is caught, and corrects FEAT-055's filed claim that one-shots
 *    "never" get MCP tools (true only of streaming mode).
 *
 * Parts (real ClaudeRuntime, real CLI, scratch dirs; nothing on :4317):
 *  A. FIRST TURN HAS THE TOOLS — a deliberately slow-starting MCP server
 *     (6s initialize) must still be attached for turn one: the FIRST init
 *     frame reports it connected, the turn CALLS the tool, and no false
 *     "still starting" notice fires. Pre-fix: all three FAIL.
 *  E. nothing can overtake the held first prompt: the bridge's busy-guard
 *     (production) + the runtime's held-send buffer (defense-in-depth).
 *  B. BOUNDED + HONEST — server slower (15s) than the budget (3s): the turn
 *     starts anyway (no unbounded wait), the init frame shows `pending`, and
 *     the BUG-035 notice now also says how long the turn was held. Pre-fix:
 *     the honesty augmentation FAILs.
 *  C. NO-MCP LATENCY — with a huge budget armed (45s) but NO MCP servers
 *     configured, the first init must arrive fast: the gate must not even be
 *     entered.
 *  D. ONE-SHOT CONTRACT — scripts/dispatch.mjs --provider anthropic against a
 *     project whose .mcp.json carries the slow server: the single turn gets
 *     the tool (stdout is the tool's answer).
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MODEL = 'haiku';
const cleanupDirs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

/* ------------------------------------------------ the slow MCP fixture */

const SLOW_SERVER = `#!/usr/bin/env node
// MCP stdio server that SLEEPS before answering initialize, then serves one
// tool ping -> "pong-055". SLEEP_MS controls the delay.
import * as readline from 'node:readline';
const SLEEP = Number(process.env.SLEEP_MS ?? '5000');
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
rl.on('line', async (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') {
    await sleep(SLEEP);
    send({ jsonrpc: '2.0', id: m.id, result: {
      protocolVersion: m.params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} }, serverInfo: { name: 'slow', version: '0.0.1' } } });
  } else if (m.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'ping',
      description: 'returns pong-055',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] } });
  } else if (m.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'pong-055' }] } });
  } else if (typeof m.id !== 'undefined') {
    send({ jsonrpc: '2.0', id: m.id, result: {} });
  }
});
`;

function scratchDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

const fixtures = scratchDir('cs-mcpready-');
const serverPath = path.join(fixtures, 'slow-mcp.mjs');
fs.writeFileSync(serverPath, SLOW_SERVER);
const slowServer = (sleepMs) => ({
  type: 'stdio', command: process.execPath, args: [serverPath], env: { SLEEP_MS: String(sleepMs) },
});
const PROMPT_PING = 'Call the mcp__slow__ping tool and reply with exactly its output.';

/**
 * Drive the REAL ClaudeRuntime for `prompts` (first via start(), rest via an
 * immediate send() — deliberately racing the FEAT-055 hold) and collect what
 * the bridge would see: init frames, per-message classifications, assistant
 * text per turn, result frames, and the wall-clock time of the first init.
 */
async function runTurns({ mcpServers, budgetMs, prompts, timeoutMs = 240_000 }) {
  const { ClaudeRuntime } = await import(path.join(ROOT, 'src', 'server', 'runtime', 'claude-runtime.ts'));
  const rt = new ClaudeRuntime();
  const cwd = scratchDir('cs-mcpready-cwd-');
  const out = { inits: [], classified: [], turnTexts: [], results: [], firstInitAtMs: null, sessionId: null, cwd };

  const prevBudget = process.env.CLAUDE_STATION_MCP_READY_TIMEOUT_MS;
  if (budgetMs != null) process.env.CLAUDE_STATION_MCP_READY_TIMEOUT_MS = String(budgetMs);
  const t0 = Date.now();
  try {
    rt.start({
      cwd,
      firstPrompt: prompts[0],
      permissionMode: 'bypassPermissions',
      model: MODEL,
      onApproval: async () => ({ behavior: 'allow', updatedInput: {} }),
      ...(mcpServers ? { mcpServers, strictMcpConfig: true } : {}),
    });
  } finally {
    if (budgetMs != null) {
      if (prevBudget === undefined) delete process.env.CLAUDE_STATION_MCP_READY_TIMEOUT_MS;
      else process.env.CLAUDE_STATION_MCP_READY_TIMEOUT_MS = prevBudget;
    }
  }
  // The race is the point: these must queue BEHIND the held first prompt.
  for (const p of prompts.slice(1)) rt.send(p);

  let text = '';
  const deadline = Date.now() + timeoutMs;
  const pump = (async () => {
    for await (const m of rt.messages()) {
      const pe = rt.classifyProviderError?.(m);
      if (pe) out.classified.push(pe);
      if (m.type === 'system' && m.subtype === 'init') {
        if (out.firstInitAtMs == null) out.firstInitAtMs = Date.now() - t0;
        out.sessionId = String(m.session_id ?? out.sessionId ?? '');
        out.inits.push({ mcp_servers: m.mcp_servers ?? [], tools: m.tools ?? [] });
      } else if (m.type === 'assistant') {
        text += (m.message?.content ?? [])
          .filter((b) => b?.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text).join('');
      } else if (m.type === 'result') {
        out.results.push({ subtype: m.subtype, is_error: m.is_error === true });
        out.turnTexts.push(text.trim());
        text = '';
        if (out.results.length >= prompts.length) break;
      }
      if (Date.now() > deadline) break;
    }
  })();
  await Promise.race([pump, sleep(timeoutMs)]);
  rt.close();
  // Clean up the scratch cwd's transcript-store dir alongside the cwd itself.
  cleanupDirs.push(path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-')));
  return out;
}

/* ================== A: the first turn has its MCP tools ================== */

async function partA() {
  console.log('\n=== A. a slow (6s) MCP server is STILL attached for turn one ===');
  const r = await runTurns({
    mcpServers: { slow: slowServer(6_000) },
    prompts: [PROMPT_PING],
  });
  const first = r.inits[0] ?? { mcp_servers: [], tools: [] };
  check('(A1) the FIRST init frame reports the server connected with its tools listed (the turn was held until ready)',
    first.mcp_servers.some((s) => s.name === 'slow' && s.status === 'connected')
      && first.tools.includes('mcp__slow__ping'),
    { mcp_servers: first.mcp_servers, slowTools: first.tools.filter((t) => String(t).startsWith('mcp__slow')) });
  check('(A2) turn ONE actually CALLED the MCP tool (its answer is in the reply)',
    /pong-055/.test(r.turnTexts[0] ?? ''), r.turnTexts[0] ?? '(no turn text)');
  check('(A3) no false "still starting" notice fired — the gate made the old turn-one gap not exist',
    !r.classified.some((pe) => pe.kind === 'tooling-unavailable'),
    r.classified.map((pe) => pe.detail).join(' | ') || '(no tooling-unavailable classifications)');
}

/* ========= E: nothing can overtake the held first prompt (contract) ========= */

async function partE() {
  console.log('\n=== E. nothing can overtake the held first prompt ===');
  /*
   * Two layers, honestly separated:
   *  - PRODUCTION layer: the bridge marks the session `busy` BEFORE
   *    runtime.start() and refuses send() while busy — so during the FEAT-055
   *    hold no caller can reach the runtime at all. That guard is the real
   *    ordering protection and must still exist.
   *  - DEFENSE layer: if some future caller bypassed the bridge, the runtime
   *    buffers send()s while holding and flushes them AFTER the first prompt.
   *    This path is production-unreachable (probed: pushing a user message
   *    into the CLI mid-turn is a path the engine handles poorly, so no test
   *    drives it end-to-end — the assertion is on the code contract).
   */
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'server', 'agent-bridge.ts'), 'utf8');
  check('(E1) the bridge still refuses send() while a turn is running — nothing can reach the runtime during the hold',
    /if \(this\.busy\) throw new Error\('a turn is already running/.test(bridge),
    'agent-bridge.ts send() busy-guard present');
  const rtSrc = fs.readFileSync(path.join(ROOT, 'src', 'server', 'runtime', 'claude-runtime.ts'), 'utf8');
  const releaseBody = rtSrc.slice(rtSrc.indexOf('#releaseWhenMcpReady'), rtSrc.indexOf('send(text: string)'));
  check('(E2) defense-in-depth: the runtime buffers send()s while holding and releases them only AFTER the first prompt',
    /if \(this\.#holding\) \{ this\.#heldSends\.push\(text\); return; \}/.test(rtSrc)
      && releaseBody.indexOf('push(userMessage(firstPrompt))') !== -1
      && releaseBody.indexOf('push(userMessage(firstPrompt))') < releaseBody.indexOf('#heldSends.splice(0)'),
    'held-send buffer present; first prompt pushed before the buffer flushes');
}

/* ==================== B: bounded, and honest when exceeded ==================== */

async function partB() {
  console.log('\n=== B. server slower (15s) than the budget (3s): bounded release + honest notice ===');
  const r = await runTurns({
    mcpServers: { slow: slowServer(15_000) },
    budgetMs: 3_000,
    prompts: ['Reply with exactly the word: ok'],
  });
  check('(B1) the turn started anyway — bounded wait, not a stall behind the server',
    r.results.length === 1 && r.firstInitAtMs != null && r.firstInitAtMs < 12_000,
    { firstInitAtMs: r.firstInitAtMs, results: r.results });
  const pe = r.classified.find((e) => e.kind === 'tooling-unavailable' && e.pending === true);
  check('(B2) the notice says the turn was HELD and for how long (budget named) — an honest report, not a mystery',
    !!pe && /held \d+s/i.test(String(pe.detail)) && /CLAUDE_STATION_MCP_READY_TIMEOUT_MS/.test(String(pe.detail)),
    pe?.detail ?? '(no pending tooling-unavailable notice)');
  check('(B3) ground truth behind the notice: the init frame really shows the server still pending',
    (r.inits[0]?.mcp_servers ?? []).some((s) => s.name === 'slow' && s.status === 'pending'),
    r.inits[0]?.mcp_servers ?? '(no init frame)');
}

/* ================= C: no MCP configured => the gate never runs ================= */

async function partC() {
  console.log('\n=== C. NO MCP servers: a huge armed budget (45s) must add ZERO latency ===');
  const r = await runTurns({
    budgetMs: 45_000,
    prompts: ['Reply with exactly the word: ok'],
  });
  check('(C1) the first init arrived fast — the readiness gate was never entered',
    r.results.length === 1 && r.firstInitAtMs != null && r.firstInitAtMs < 10_000,
    { firstInitAtMs: r.firstInitAtMs, results: r.results });
}

/* ============== D: the one-shot dispatch path gets its MCP tools ============== */

function partD() {
  console.log('\n=== D. one-shot dispatch (scripts/dispatch.mjs, claude -p): the single turn HAS the tool ===');
  const proj = scratchDir('cs-mcpready-proj-');
  fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({
    mcpServers: { slow: { type: 'stdio', command: process.execPath, args: [serverPath], env: { SLEEP_MS: '6000' } } },
  }, null, 2));
  fs.writeFileSync(path.join(proj, 'package.json'), '{"name":"feat055-fixture","private":true}\n');
  const r = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'dispatch.mjs'),
    '--provider', 'anthropic', '--model', MODEL,
    '--cwd', proj, '--sandbox', 'workspace-write',
    '--allow-tools', 'mcp__slow__ping',
    '--timeout-min', '5',
    PROMPT_PING,
  ], { encoding: 'utf8', timeout: 360_000 });
  check('(D1) the dispatched one-shot really used the MCP tool — its answer IS the stdout contract',
    r.status === 0 && /pong-055/.test(String(r.stdout ?? '')),
    { status: r.status, stdout: String(r.stdout ?? '').trim().slice(0, 120), stderrTail: String(r.stderr ?? '').trim().split('\n').slice(-2).join(' / ') });
}

/* =================================== main =================================== */

async function main() {
  await partA();
  await partE();
  await partB();
  await partC();
  partD();

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : 0;
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => {
    for (const d of cleanupDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  });
