#!/usr/bin/env node
/**
 * FEAT-206 — the SDK/CLI pair a tree bundles, driven through the REAL Orchard
 * production path, graded on OBSERVABLE outcomes (files a child writes, what a
 * denied tool did not do, what the server tells the UI), not on frame text.
 *
 *   node scripts/verify-feat-206-cli-lifecycle.mjs [--root <tree>] [--out <dir>] [--only A,B,…]
 *
 * --root picks the tree whose server + node_modules run (default: this tree), so
 * the SAME arms run on the bumped pair and on the rollback pair.
 *
 * What is real: a scratch Orchard server (src/server/index.ts of --root, isolated
 * CLAUDE_STATION_DATA + CLAUDE_CONFIG_DIR, survival ON as in production), its
 * AgentSession / ClaudeRuntime / hooks (FEAT-096 PreToolUse, BUG-239 park-guard
 * SubagentStop, approval + question callbacks), the SDK in --root/node_modules
 * and the CLI that SDK resolves by default (host `direct` path: no
 * pathToClaudeCodeExecutable), the project's own .claude/agents/worker.md (the
 * real file from --root, optionally with the FEAT-206 autoCompactWindow line).
 * What is scripted: ONLY the model (scripts/lib/fake-messages-api.mjs, reached
 * via ANTHROPIC_BASE_URL with a fake key) — so every run is deterministic and
 * free, and each tool call the CLI makes is real.
 *
 * Arms:
 *   B  binary provenance: the CLI process the server's session spawned resolves to
 *      --root's bundled binary; its --version and sha256 are recorded.
 *   L  a worker lane launches a background shell, a timed-out-to-background shell,
 *      a Monitor, a background Agent and a `Task`-named Agent; the real park-guard
 *      holds the lane until its children finish (independent proof: each child's
 *      completion file exists), the real scanTranscript recognises every launch the
 *      CLI made, and every completion notice in the lane transcript.
 *   P  FEAT-096: the orchestrator's `cat` is refused (no file), the lane's runs
 *      (file) — agent_id attribution on the live pair; then permission cards:
 *      allow (file), deny (no file, refusal reaches the model), AskUserQuestion
 *      answer travels back as updatedInput.
 *   X  cancel: an interrupt mid-stream ends the turn interrupted, the session stays
 *      usable; an API error ends a turn as an error, next turn works; busy=false.
 *   R  resume: a fresh start with resumeSessionId continues the conversation (the
 *      model receives the earlier turns), and FEAT-096 still refuses the main thread.
 *   C  compaction through the real worker-loading path: a worker lane whose
 *      reported context passes ~180k compacts (compact_boundary in ITS transcript)
 *      when worker.md carries autoCompactWindow: 200000, and after compaction its
 *      tools are still lane-attributed (FEAT-096 lets it write) and park-guard
 *      still holds it for its background child.
 *
 * Captured transcripts + wire facts are written to --out as replay material.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { isolatedServerEnv } from './lib/station-boot.mjs';
import { waitRuntimeReady } from './lib/host-admission.mjs';
import { startFakeApi, textOf, lastUser, lastToolResult, toolResultsIn } from './lib/fake-messages-api.mjs';
import { mkdtempScratch } from './lib/scratch.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const HERE_ROOT = path.resolve(import.meta.dirname, '..');
const ROOT = path.resolve(opt('--root', HERE_ROOT));
const ONLY = (opt('--only', '') || '').split(',').filter(Boolean);
const want = (a) => !ONLY.length || ONLY.includes(a);
const COMPACT_LINE = !args.includes('--no-compact-line');
// On a CLI without per-agent autoCompactWindow (2.1.281) the line must be INERT: the agent still
// loads and runs, and nothing compacts. `--expect-compaction no` grades that instead.
const EXPECT_COMPACTION = COMPACT_LINE && opt('--expect-compaction', 'yes') !== 'no';
// A real model takes seconds per reply; an instant fake lets a lane hand back before the CLI's
// transcript writer has flushed its last records (measured: the park-guard then reads a stale
// file). The default is a conservative-but-real latency; --latency-ms 0 reproduces the race.
const LATENCY = Number(opt('--latency-ms', '600'));
const OUT = path.resolve(opt('--out', mkdtempScratch('feat206-lifecycle-out-')));
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0; const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BIN = fs.realpathSync(path.join(ROOT, 'node_modules', '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`, 'claude'));
const SDKV = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')).version;
const BINV = (spawnSync(BIN, ['--version'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/nonexistent' } }).stdout.match(/\d+\.\d+\.\d+/) || [])[0];
console.log(`tree under test: ${ROOT}  (model latency ${LATENCY} ms)\n  SDK ${SDKV}, bundled CLI ${BIN} --version ${BINV}\n  worker.md autoCompactWindow line: ${COMPACT_LINE ? 'ADDED (200000)' : 'absent'}\n  out: ${OUT}`);

/* ------------------------------------------------------------ the scripted model */
// --work / --store let a SECOND run (another tree, e.g. the rollback pair) resume sessions the first
// one wrote: same project dir (transcripts are keyed by it), same transcript store.
const W = opt('--work') ? path.resolve(opt('--work')) : mkdtempScratch('feat206-lifecycle-work-');     // the project dir (child files land here)
const STORE = opt('--store') ? path.resolve(opt('--store')) : null;
const RESUME = (opt('--resume', '') || '').split(',').filter(Boolean);   // arm D: session ids to resume on THIS tree
const sessionsOut = {};
const seen = { compactRequests: [], laneModels: new Set(), resumeSawHistory: false, mainDenied: [], errors: [] };
const firstText = (req) => textOf((req.messages ?? [])[0]);
// the CLI's own compaction prompt (present verbatim in 2.1.281 and 2.1.328)
const isSummaryReq = (req) => /Your task is to create a detailed summary of the/.test(textOf(lastUser(req)));
const tailOf = (p) => `timeout ${p} tail -f /dev/null; true`;

function laneScript(req, marker) {
  const tr = toolResultsIn(req);
  const lu = lastUser(req);
  const lastIsResult = !!lastToolResult(req);
  seen.laneModels.add(`${marker}:${req.model}`);
  const usage = (n) => ({ usageInput: n });
  if (marker === 'LANE-L') {
    const steps = [
      { name: 'Bash', input: { command: `${tailOf(8)}; echo SHELL-DONE > ${W}/shell-done.txt`, description: 'bg shell', run_in_background: true } },
      { name: 'Bash', input: { command: `${tailOf(10)}; echo TO-DONE > ${W}/to-done.txt`, description: 'slow shell', timeout: 2500 } },
      { name: 'Monitor', input: { description: 'ticks', timeout_ms: 60000, command: `for i in 1 2 3; do echo tick $i; ${tailOf(2)}; done; echo MON-DONE > ${W}/mon-done.txt` } },
      { name: 'Agent', input: { subagent_type: 'general-purpose', description: 'nested one', prompt: 'NESTED-1 reply done', run_in_background: true } },
      { name: 'Task', input: { subagent_type: 'general-purpose', description: 'nested two', prompt: 'NESTED-2 reply done', run_in_background: true } },
      { name: 'Bash', input: { command: `cat /etc/hostname > ${W}/lane-cat.txt`, description: 'lane read' } },
    ];
    if (tr < steps.length) return { tool: steps[tr] };
    if (lastIsResult) return { text: 'LANE-L final report' };
    return { tool: { name: 'Bash', input: { command: tailOf(3), description: 'wait for children', timeout: 600000 } } };
  }
  if (marker === 'LANE-P') {
    if (tr === 0) return { tool: { name: 'Bash', input: { command: `cat /etc/hostname > ${W}/lane-p-cat.txt`, description: 'lane read' } } };
    return { text: 'LANE-P done' };
  }
  if (marker === 'LANE-C') {
    const compacted = /COMPACTED-SUMMARY/.test(JSON.stringify(req.messages ?? []).slice(0, 20000));
    if (!compacted) {
      const grow = [60_000, 120_000, 165_000, 192_000];
      const k = Math.min(tr, grow.length - 1);
      if (tr < 6) return { tool: { name: 'Bash', input: { command: `echo step-${tr}`, description: 'step' } }, ...usage(grow[k]) };
    }
    // after compaction (or, on a CLI that never compacts, after the growth steps)
    // the CLI keeps the last tool exchange across a compaction, so count only post-growth results
    let after = 0;
    for (const m of req.messages ?? []) if (m.role === 'user' && Array.isArray(m.content)) for (const c of m.content) if (c?.type === 'tool_result' && !/^step-\d+$/.test(textOf({ content: [c] }).trim())) after++;
    const steps = [
      { name: 'Bash', input: { command: `cat /etc/hostname > ${W}/lane-c-after.txt`, description: 'post-compaction lane read' } },
      { name: 'Bash', input: { command: `${tailOf(6)}; echo C-BG-DONE > ${W}/c-bg.txt`, description: 'bg after compaction', run_in_background: true } },
    ];
    if (after < steps.length) return { tool: steps[after], ...usage(compacted ? 30_000 : 192_000) };
    if (lastIsResult) return { text: 'LANE-C final', ...usage(compacted ? 30_000 : 192_000) };
    return { tool: { name: 'Bash', input: { command: tailOf(3), description: 'wait', timeout: 600000 } }, ...usage(compacted ? 30_000 : 192_000) };
  }
  return { text: `${marker} ok` };
}

function mainScript(req) {
  const first = firstText(req);
  const tr = toolResultsIn(req);
  const lt = textOf(lastUser(req));
  const lastIsResult = !!lastToolResult(req);
  if (/SCEN-LANES/.test(first)) {
    if (tr === 0) return { tool: { name: 'Agent', input: { subagent_type: 'worker', description: 'launch lane', prompt: 'LANE-L do the launch steps', run_in_background: false } } };
    return { text: 'MAIN-LANES-DONE' };
  }
  if (/SCEN-COMPACT/.test(first)) {
    if (/RESUME-PROBE/.test(lt)) { if (/MAIN-COMPACT-DONE/.test(JSON.stringify(req.messages))) seen.resumeSawHistory = true; return { text: 'RESUMED-OK' }; }
    if (tr === 0) return { tool: { name: 'Agent', input: { subagent_type: 'worker', description: 'compaction lane', prompt: 'LANE-C grow then continue', run_in_background: false } } };
    return { text: 'MAIN-COMPACT-DONE' };
  }
  if (/SCEN-096/.test(first)) {
    if (/RESUME-PROBE/.test(lt)) {
      seen.resumeSawHistory = /SCEN-096/.test(JSON.stringify(req.messages)) && /MAIN-096-DONE/.test(JSON.stringify(req.messages));
      if (!lastIsResult) return { tool: { name: 'Bash', input: { command: `cat /etc/hostname > ${W}/main-cat-resumed.txt`, description: 'main read after resume' } } };
      return { text: 'RESUMED-OK' };
    }
    if (tr === 0) return { tool: { name: 'Bash', input: { command: `cat /etc/hostname > ${W}/main-cat.txt`, description: 'main read' } } };
    if (tr === 1) return { tool: { name: 'Agent', input: { subagent_type: 'worker', description: 'perm lane', prompt: 'LANE-P read one file', run_in_background: false } } };
    return { text: 'MAIN-096-DONE' };
  }
  if (/SCEN-CARDS/.test(first)) {
    if (tr === 0) return { tool: { name: 'Write', input: { file_path: `${W}/allowed.txt`, content: 'ALLOWED\n' } } };
    if (tr === 1) return { tool: { name: 'Write', input: { file_path: `${W}/denied.txt`, content: 'DENIED\n' } } };
    if (tr === 2) return { tool: { name: 'AskUserQuestion', input: { questions: [{ question: 'Pick one?', header: 'Pick', multiSelect: false, options: [{ label: 'Alpha', description: 'first' }, { label: 'Beta', description: 'second' }] }] } } };
    if (tr === 3) { seen.questionResult = textOf(lastUser(req)); seen.denyResult = JSON.stringify(req.messages.slice(-4)).slice(0, 4000); return { text: 'MAIN-CARDS-DONE' }; }
    return { text: 'ok' };
  }
  if (/SCEN-CANCEL/.test(first)) {
    // the CLI folds an errored turn's user text into the next request, so the newest marker wins
    const marks = [...lt.matchAll(/AFTER-\w+|ERR-PLEASE/g)].map((m) => m[0]);
    const newest = marks[marks.length - 1];
    if (newest === 'ERR-PLEASE') return { status: 500, error: { type: 'api_error', message: 'Internal server error' }, headers: { 'x-should-retry': 'false' } };
    if (newest) return { text: `ack ${newest}` };
    return { text: 'a very slow streamed answer that the user cancels part way through', delayMs: 9000, chunks: 12 };
  }
  return { text: 'ok' };
}

async function script(req) {
  if (LATENCY) await sleep(LATENCY);
  const tools = (req.tools ?? []).length;
  if (isSummaryReq(req)) {
    seen.compactRequests.push({ at: Date.now(), model: req.model, nMessages: (req.messages ?? []).length });
    const lane = /LANE-C/.test(JSON.stringify(req.messages ?? []));
    return { text: `<summary>COMPACTED-SUMMARY ${lane ? 'LANE-C' : ''}: the task so far was growth steps; continue with the post-compaction steps.</summary>` };
  }
  if (!tools) return { text: 'ok' };
  const first = firstText(req);
  const m = first.match(/\b(LANE-[A-Z]|NESTED-\d)\b/) || (/COMPACTED-SUMMARY LANE-C/.test(first) ? [null, 'LANE-C'] : null);
  if (m) {
    if (m[1].startsWith('NESTED')) return { text: `${m[1]} done`, delayMs: 2500, chunks: 2 };
    return laneScript(req, m[1]);
  }
  return mainScript(req);
}

/* ------------------------------------------------------------ server plumbing */
async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
const servers = [];
async function bootServer(api) {
  const PORT = await freePort();
  // short: the broker's unix socket lives under DATA and sun_path is capped at 108 bytes
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'f206-d-'));
  const CFG = STORE ?? mkdtempScratch('feat206-lifecycle-cfg-');
  fs.mkdirSync(path.join(CFG, 'projects'), { recursive: true });
  const env = isolatedServerEnv({ PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_CONFIG_DIR: CFG, CLAUDE_PROJECTS_DIR: path.join(CFG, 'projects'), ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'sk-ant-api03-feat206-fake-key-not-real', CLAUDE_CODE_MAX_RETRIES: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' }, { requireStore: true });
  // A parent Claude session's own wiring must not reach the scratch server's CLIs.
  for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_(SESSION_ID|MESSAGING_|CHILD_SESSION|ENTRYPOINT|EXECPATH|SESSION_ATTENDED|EMIT_SESSION_STATE_EVENTS)|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_VERSION|CLAUDE_CODE_OAUTH_TOKEN)/.test(k)) delete env[k];
  const log = [];
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  const BASE = `http://127.0.0.1:${PORT}`;
  let up = false;
  for (let k = 0; k < 160 && !up; k++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error(`server never became healthy:\n${log.join('').slice(-3000)}`);
  if (!(await waitRuntimeReady(PORT, { ms: 120_000 }))) throw new Error('boot runtime check never admitted host sessions');
  const s = { PORT, BASE, DATA, CFG, child, log };
  servers.push(s);
  return s;
}
const conns = [];
function openWs(PORT) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const events = [];
    conns.push(events);
    ws.on('message', (raw) => { try { events.push({ ...JSON.parse(String(raw)), _at: Date.now() }); } catch { /* ignore */ } });
    ws.once('open', () => res({ ws, events, send: (o) => ws.send(JSON.stringify(o)) }));
    ws.once('error', rej);
  });
}
const waitEv = async (events, pred, ms, from = 0) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const hit = events.slice(from).find(pred); if (hit) return hit; await sleep(150); }
  return null;
};
async function registerProject(s, name, { permissionMode = 'bypassPermissions', orchestrator = true, dir = W } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const body = { hostPath: dir, name, isolation: 'direct', ...(orchestrator ? {} : { settings: { orchestratorProfile: { enabled: false } } }) };
  const reg = await (await fetch(`${s.BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  const pid = reg.project?.id;
  if (!pid) throw new Error(`register failed: ${JSON.stringify(reg).slice(0, 500)}`);
  const pr = await (await fetch(`${s.BASE}/api/projects/${pid}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-haiku-4-5', permissionMode }) })).json();
  return { pid, project: pr.project ?? reg.project };
}
async function health(s) { try { return await (await fetch(`${s.BASE}/api/health`)).json(); } catch { return null; } }
const turnEnds = (c) => c.events.filter((e) => e.t === 'turn-end');
async function waitTurnEnd(c, n, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (turnEnds(c).length >= n) return turnEnds(c)[n - 1]; await sleep(200); } return null; }
function transcripts(s) {
  const out = [];
  const walk = (d) => { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.jsonl')) out.push(p); } };
  walk(path.join(s.CFG, 'projects'));
  return out;
}
const readJsonl = (p) => fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
function laneFile(s, marker) {
  for (const p of transcripts(s)) {
    if (!/agent-.*\.jsonl$/.test(path.basename(p))) continue;
    const t = fs.readFileSync(p, 'utf8');
    if (t.includes(marker)) return p;
  }
  return null;
}
function save(name, file) { if (file && fs.existsSync(file)) fs.copyFileSync(file, path.join(OUT, name)); }

/** Every CLI process whose environ points at THIS fake API: exe, version, sha256. */
function cliProcsFor(api) {
  const out = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    let env; try { env = fs.readFileSync(`/proc/${d}/environ`, 'utf8'); } catch { continue; }
    if (!env.includes(`ANTHROPIC_BASE_URL=${api.url}`)) continue;
    let exe; try { exe = fs.readlinkSync(`/proc/${d}/exe`); } catch { continue; }
    if (/node$/.test(exe)) continue;
    out.push({ pid: Number(d), exe });
  }
  return out;
}

function cleanup() {
  for (const s of servers) {
    // brokers + CLIs this server started (its own session-hosts records), then the server
    try {
      for (const f of fs.readdirSync(path.join(s.DATA, 'session-hosts'))) {
        if (!f.endsWith('.json')) continue;
        try { const r = JSON.parse(fs.readFileSync(path.join(s.DATA, 'session-hosts', f), 'utf8')); for (const p of [r.claudePid, r.hostPid]) if (Number(p) > 1) { try { process.kill(Number(p), 'SIGTERM'); } catch { /* gone */ } } } catch { /* torn */ }
      }
    } catch { /* none */ }
    try { process.kill(s.child.pid, 'SIGTERM'); } catch { /* gone */ }
  }
}
process.on('exit', cleanup);

/* ------------------------------------------------------------------- the arms */
const pg = await import(pathToFileURL(path.join(ROOT, 'src/server/park-guard.ts')).href);

async function main() {
  // the project dir: a git-less scratch project carrying the REAL worker.md of --root
  fs.mkdirSync(path.join(W, '.claude', 'agents'), { recursive: true });
  let worker = fs.readFileSync(path.join(ROOT, '.claude', 'agents', 'worker.md'), 'utf8');
  if (COMPACT_LINE && !/^autoCompactWindow:/m.test(worker)) worker = worker.replace(/^(model: .*)$/m, '$1\nautoCompactWindow: 200000');
  fs.writeFileSync(path.join(W, '.claude', 'agents', 'worker.md'), worker);
  const api = await startFakeApi({ script });
  const s = await bootServer(api);
  const P1 = await registerProject(s, 'feat206-orch', { permissionMode: 'bypassPermissions', orchestrator: true });
  const P2 = await registerProject(s, 'feat206-cards', { permissionMode: 'default', orchestrator: false, dir: path.join(W, 'cards-project') });

  /* ---- L (+B) */
  if (want('L') || want('B')) {
    console.log('\n=== B + L. lane launches, park-guard hold, child survival (real server, real CLI) ===');
    const c = await openWs(s.PORT);
    c.send({ type: 'start', projectId: P1.pid, prompt: 'SCEN-LANES run the lane' });
    const init = await waitEv(c.events, (e) => e.t === 'session-init', 90_000);
    let procs = [];
    for (let k = 0; k < 40 && !procs.length; k++) { procs = cliProcsFor(api); if (!procs.length) await sleep(250); }
    const exe = procs[0]?.exe ?? null;
    const ver = exe ? (spawnSync(exe, ['--version'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/nonexistent' } }).stdout || '').trim() : null;
    const sha = exe ? spawnSync('sha256sum', [exe], { encoding: 'utf8' }).stdout.split(' ')[0] : null;
    check('B1 the session initialised on the real path', !!init, init && { model: init.model, nTools: init.tools?.length });
    check('B2 the CLI the server spawned is --root\'s SDK-bundled binary (host direct path, SDK default resolution)', exe === BIN, { spawned: procs, expected: BIN });
    check(`B3 that process's binary executes as --version ${BINV}`, !!ver && ver.includes(BINV), { ver, sha256: sha });
    fs.writeFileSync(path.join(OUT, 'provenance.json'), JSON.stringify({ root: ROOT, sdk: SDKV, bin: BIN, spawned: procs, version: ver, sha256: sha }, null, 2));
    const end = await waitTurnEnd(c, 1, 240_000);
    check('L0 the orchestrator turn ended normally', !!end && !end.isError, end && { subtype: end.subtype, interrupted: end.interrupted, resultText: end.resultText });
    const lf = laneFile(s, 'LANE-L');
    check('L1 the worker lane ran (its own subagent transcript exists)', !!lf, lf);
    const files = Object.fromEntries(['shell-done', 'to-done', 'mon-done', 'lane-cat'].map((n) => [n, fs.existsSync(path.join(W, `${n}.txt`))]));
    if (lf) {
      save('lane-L.jsonl', lf);
      const text = fs.readFileSync(lf, 'utf8');
      const recs = readJsonl(lf);
      const scan = pg.scanTranscript(text);
      const kinds = [...scan.launched.values()];
      // raw announcements as the CLI wrote them, per tool, for the record
      const toolOf = new Map(); const ann = [];
      for (const r of recs) for (const b of (Array.isArray(r.message?.content) ? r.message.content : [])) {
        if (r.type === 'assistant' && b.type === 'tool_use') toolOf.set(b.id, b.name);
        if (r.type === 'user' && b.type === 'tool_result') ann.push({ tool: toolOf.get(b.tool_use_id), is_error: !!b.is_error, contentType: typeof b.content === 'string' ? 'string' : Array.isArray(b.content) ? 'blocks' : typeof b.content, head: (typeof b.content === 'string' ? b.content : (b.content ?? []).map((x) => x.text ?? '').join('')).slice(0, 160) });
      }
      fs.writeFileSync(path.join(OUT, 'lane-L-announcements.json'), JSON.stringify(ann, null, 2));
      const notices = recs.filter((r) => r.type === 'attachment').map((r) => ({ type: r.attachment?.type, prompt: String(r.attachment?.prompt ?? '').slice(0, 200) }));
      fs.writeFileSync(path.join(OUT, 'lane-L-notices.json'), JSON.stringify(notices, null, 2));
      const blocks = recs.filter((r) => JSON.stringify(r).includes('Orchard: you cannot end your turn yet.')).length;
      console.log(`        info: tool results: ${ann.map((a) => `${a.tool}${a.is_error ? '(err)' : ''}: ${a.head.slice(0, 70).replace(/\n/g, ' ')}`).join(' | ')}`);
      check('L2 shell launch (run_in_background) recognised by the real scanTranscript', kinds.filter((k) => k === 'shell').length >= 1, Object.fromEntries(scan.launched));
      const toAnn = ann.find((a) => a.tool === 'Bash' && /timeout|moved to the background/i.test(a.head));
      check('L3 timeout-to-background shell: announced by the CLI AND recognised (or the CLI did not background it: recorded)', toAnn ? kinds.filter((k) => k === 'shell').length >= 2 : true, toAnn ? toAnn.head : 'CLI ran the timed-out command without moving it to the background (see announcements)');
      check('L4 Monitor launch recognised', kinds.includes('monitor'), ann.filter((a) => a.tool === 'Monitor'));
      check('L5 background Agent launch recognised', kinds.filter((k) => k === 'subagent').length >= 1, ann.filter((a) => a.tool === 'Agent'));
      const taskAnn = ann.find((a) => a.tool === 'Task');
      check('L6 a `Task`-named call: recognised as a subagent launch if the CLI accepted it, else refused by the CLI (no launch to miss)', taskAnn ? (taskAnn.is_error || kinds.filter((k) => k === 'subagent').length >= 2) : true, taskAnn ?? 'no Task call reached a result');
      check('L7 every live-child launch the CLI announced was recognised (no announcement unrecognised)', ann.filter((a) => /^(Command running in background|Command did not complete within|Monitor started|Async agent launched)/.test(a.head.trimStart())).length <= scan.launched.size, { announced: ann.filter((a) => /^(Command running in background|Command did not complete within|Monitor started|Async agent launched)/.test(a.head.trimStart())).length, recognised: scan.launched.size });
      check('L8 completion notices reach the lane transcript as the shape scanTranscript reads (attachment queued_command, or user text)', scan.referenced.size >= 1, { referenced: [...scan.referenced], noticeTypes: [...new Set(notices.map((n) => n.type))] });
      check('L9 the real park-guard HELD the lane at least once (block reason in its transcript)', blocks >= 1, { blocks });
      check('L10 CHILD SURVIVAL: every background child finished its work (independent: completion files)', files['shell-done'] && files['mon-done'] && (files['to-done'] || !toAnn), files);
    } else check('L2-L10 lane transcript available', false, transcripts(s));
    check('L11 FEAT-096: the LANE\'s cat ran (agent_id present on the lane\'s PreToolUse)', files['lane-cat'], files);
    const h = await health(s);
    const mine = (h?.sessions ?? []).find((x) => x.sdkSessionId === init?.sessionId || x.sessionId === init?.sessionId);
    check('L12 the session is not left busy', !mine || mine.busy === false, mine ? { busy: mine.busy } : 'session row not found (closed)');
    fs.writeFileSync(path.join(OUT, 'events-L.json'), JSON.stringify(c.events.map(({ _at, ...e }) => e)).slice(0, 2_000_000));
    c.ws.close();
  }

  /* ---- P (FEAT-096) + R (resume) */
  let sid096 = null;
  if (want('P') || want('R')) {
    console.log('\n=== P. FEAT-096 agent_id enforcement on the live pair ===');
    const c = await openWs(s.PORT);
    c.send({ type: 'start', projectId: P1.pid, prompt: 'SCEN-096 go' });
    const init = await waitEv(c.events, (e) => e.t === 'session-init', 90_000);
    sid096 = init?.sessionId ?? null;
    sessionsOut.s096 = sid096;
    const end = await waitTurnEnd(c, 1, 180_000);
    const mainRes = c.events.find((e) => e.t === 'tool-result' && !e.agentId && c.events.some((x) => x.t === 'tool-call' && x.toolUseId === e.toolUseId && x.name === 'Bash'));
    check('P1 the orchestrator\'s `cat` was REFUSED (tool result is an error) …', !!mainRes && mainRes.isError, mainRes && { isError: mainRes.isError, preview: String(mainRes.preview).slice(0, 200) });
    check('P2 … and did not run (no file)', !fs.existsSync(path.join(W, 'main-cat.txt')), fs.existsSync(path.join(W, 'main-cat.txt')));
    check('P3 the lane\'s identical `cat` RAN (subagent attribution reached the hook)', fs.existsSync(path.join(W, 'lane-p-cat.txt')), fs.existsSync(path.join(W, 'lane-p-cat.txt')));
    const laneCall = c.events.find((e) => e.t === 'tool-call' && e.name === 'Bash' && e.agentId);
    check('P4 the lane\'s tool call is attributed to a subagent on the UI stream (agentId set)', !!laneCall, laneCall && { agentId: laneCall.agentId, agentType: laneCall.agentType });
    check('P5 turn ended normally', !!end && !end.isError, end && { subtype: end.subtype });
    save('main-096.jsonl', transcripts(s).find((p) => sid096 && p.endsWith(`${sid096}.jsonl`)));
    c.ws.close();
    await sleep(1500);
  }
  if (want('R') && sid096) {
    console.log('\n=== R. resume continues the conversation; enforcement survives resume ===');
    const c = await openWs(s.PORT);
    c.send({ type: 'start', projectId: P1.pid, resumeSessionId: sid096, prompt: 'RESUME-PROBE are you there' });
    const end = await waitTurnEnd(c, 1, 180_000);
    check('R1 resumed turn ended normally', !!end && !end.isError, end && { subtype: end.subtype, resultText: end.resultText });
    check('R2 the model received the earlier turns (history carried across the resume)', seen.resumeSawHistory, seen.resumeSawHistory);
    check('R3 FEAT-096 still refuses the main thread after resume (no file)', !fs.existsSync(path.join(W, 'main-cat-resumed.txt')), fs.existsSync(path.join(W, 'main-cat-resumed.txt')));
    c.ws.close();
  }

  /* ---- cards */
  if (want('P')) {
    console.log('\n=== P (cards). allow / deny / AskUserQuestion through canUseTool on the live pair ===');
    const c = await openWs(s.PORT);
    c.send({ type: 'start', projectId: P2.pid, prompt: 'SCEN-CARDS go' });
    const answered = new Set();
    const t0 = Date.now();
    while (Date.now() - t0 < 120_000 && turnEnds(c).length < 1) {
      for (const e of c.events) {
        if (answered.has(e.requestId)) continue;
        if (e.t === 'approval-request') {
          answered.add(e.requestId);
          const allow = String(e.input?.file_path ?? '').endsWith('allowed.txt');
          c.send({ type: 'approval-response', requestId: e.requestId, allow, message: allow ? undefined : 'FEAT206 test denies this write' });
        } else if (e.t === 'question-request') {
          answered.add(e.requestId);
          c.send({ type: 'question-response', requestId: e.requestId, answers: [{ question: 'Pick one?', selected: ['Beta'] }] });
        }
      }
      await sleep(150);
    }
    const end = turnEnds(c)[0];
    const reqs = c.events.filter((e) => e.t === 'approval-request' || e.t === 'question-request').map((e) => e.t + ':' + (e.toolName ?? 'question'));
    check('P6 permission cards reached the UI for both writes and the question', reqs.filter((r) => r.startsWith('approval')).length === 2 && reqs.some((r) => r.startsWith('question')), reqs);
    check('P7 ALLOW: the allowed write happened', fs.existsSync(path.join(W, 'allowed.txt')), fs.existsSync(path.join(W, 'allowed.txt')));
    check('P8 DENY: the denied write did not happen', !fs.existsSync(path.join(W, 'denied.txt')), fs.existsSync(path.join(W, 'denied.txt')));
    check('P9 DENY: the refusal text reached the model', /FEAT206 test denies this write/.test(seen.denyResult ?? ''), (seen.denyResult ?? '').slice(0, 300));
    check('P10 QUESTION: the answer travelled back to the model (updatedInput)', /Beta/.test(seen.questionResult ?? ''), (seen.questionResult ?? '').slice(0, 300));
    check('P11 turn ended normally', !!end && !end.isError, end && { subtype: end.subtype });
    c.ws.close();
  }

  /* ---- X */
  if (want('X')) {
    console.log('\n=== X. cancel mid-stream, API error, recovery; busy settles ===');
    const c = await openWs(s.PORT);
    c.send({ type: 'start', projectId: P2.pid, prompt: 'SCEN-CANCEL stream slowly' });
    const firstText = await waitEv(c.events, (e) => e.t === 'text' || e.t === 'text-delta' || e.t === 'stream', 60_000);
    await sleep(1500);
    c.send({ type: 'interrupt' });
    const e1 = await waitTurnEnd(c, 1, 60_000);
    check('X1 the interrupt ended the streaming turn as interrupted', !!e1 && (e1.interrupted === true || /error_during_execution/.test(e1.subtype)), e1 && { subtype: e1.subtype, interrupted: e1.interrupted, sawText: !!firstText });
    c.send({ type: 'send', prompt: 'AFTER-CANCEL hello' });
    const e2 = await waitTurnEnd(c, 2, 60_000);
    check('X2 the next turn after a cancel runs and ends normally', !!e2 && !e2.isError && /AFTER-CANCEL/.test(e2.resultText ?? ''), e2 && { subtype: e2.subtype, resultText: e2.resultText });
    c.send({ type: 'send', prompt: 'ERR-PLEASE fail this one' });
    const e3 = await waitTurnEnd(c, 3, 60_000);
    check('X3 an API error ends the turn as an error (not hung)', !!e3 && e3.isError === true, e3 && { subtype: e3.subtype, isError: e3.isError });
    c.send({ type: 'send', prompt: 'AFTER-ERROR hello' });
    const e4 = await waitTurnEnd(c, 4, 60_000);
    check('X4 the session recovers after the error', !!e4 && !e4.isError && /AFTER-ERROR/.test(e4.resultText ?? ''), e4 && { subtype: e4.subtype, resultText: e4.resultText });
    await sleep(1500);
    const h = await health(s);
    const busy = (h?.sessions ?? []).filter((x) => x.projectId === P2.pid).map((x) => x.busy);
    check('X5 /api/health shows the session NOT busy after the last turn', busy.length > 0 && busy.every((b) => b === false), busy);
    c.ws.close();
  }

  /* ---- C */
  if (want('C')) {
    console.log(`\n=== C. worker compaction through the real worker-loading path (worker.md ${COMPACT_LINE ? 'WITH' : 'WITHOUT'} autoCompactWindow: 200000) ===`);
    const c = await openWs(s.PORT);
    c.send({ type: 'start', projectId: P1.pid, prompt: 'SCEN-COMPACT go' });
    waitEv(c.events, (e) => e.t === 'session-init', 90_000).then((x) => { sessionsOut.compact = x?.sessionId ?? null; });
    const end = await waitTurnEnd(c, 1, 300_000);
    const lf = laneFile(s, 'LANE-C');
    const recs = lf ? readJsonl(lf) : [];
    const cb = recs.filter((r) => r.type === 'system' && r.subtype === 'compact_boundary').map((r) => ({ trigger: r.compactMetadata?.trigger ?? r.compact_metadata?.trigger, preTokens: r.compactMetadata?.preTokens ?? r.compact_metadata?.pre_tokens }));
    save(`lane-C-${COMPACT_LINE ? 'line' : 'noline'}.jsonl`, lf);
    console.log(`        info: lane models seen: ${[...seen.laneModels].join(', ')}; summary requests: ${seen.compactRequests.length}`);
    check('C0 the worker lane ran on worker.md\'s model (the agent file was loaded)', [...seen.laneModels].some((m) => m.startsWith('LANE-C:') && /opus-4-8/.test(m)), [...seen.laneModels]);
    if (EXPECT_COMPACTION) {
      check('C1 the LANE compacted automatically (compact_boundary in its own transcript)', cb.length >= 1, cb);
      check('C2 it compacted near the 200k window (preTokens between 150k and 200k), not at ~1M', cb.some((x) => Number(x.preTokens) >= 150_000 && Number(x.preTokens) <= 200_000), cb);
    } else {
      check(`C1' ${COMPACT_LINE ? 'the line is INERT on this CLI' : 'WITHOUT the line'}: the lane did NOT compact at the same context (and still ran: C0)`, cb.length === 0, cb);
    }
    check('C3 after compaction the lane is still lane-attributed (FEAT-096 lets its cat run)', fs.existsSync(path.join(W, 'lane-c-after.txt')), fs.existsSync(path.join(W, 'lane-c-after.txt')));
    const blocks = recs.filter((r) => JSON.stringify(r).includes('Orchard: you cannot end your turn yet.')).length;
    check('C4 park-guard still holds the lane for its post-compaction background child', blocks >= 1, { blocks });
    check('C5 that child finished (completion file)', fs.existsSync(path.join(W, 'c-bg.txt')), fs.existsSync(path.join(W, 'c-bg.txt')));
    check('C6 the orchestrator turn ended normally', !!end && !end.isError, end && { subtype: end.subtype });
    c.ws.close();
  }

  /* ---- D: resume, on THIS tree, sessions another tree wrote (rollback / upgrade compatibility) */
  if (RESUME.length) {
    console.log(`\n=== D. resume on THIS pair (CLI ${BINV}) sessions written by another pair: ${RESUME.join(', ')} ===`);
    for (const sid of RESUME) {
      const before = seen.resumeSawHistory; seen.resumeSawHistory = false;
      const c = await openWs(s.PORT);
      c.send({ type: 'start', projectId: P1.pid, resumeSessionId: sid, prompt: 'RESUME-PROBE are you there' });
      const end = await waitTurnEnd(c, 1, 180_000);
      const hist = api.requests.filter((r) => /RESUME-PROBE/.test(r.last)).length > 0;
      check(`D1 [${sid.slice(0, 8)}] the resumed turn ended normally on CLI ${BINV}`, !!end && !end.isError, end && { subtype: end.subtype, resultText: String(end.resultText ?? '').slice(0, 160) });
      check(`D2 [${sid.slice(0, 8)}] the model received the conversation written by the other CLI`, seen.resumeSawHistory || seen.resumeSawCompactHistory === sid, { sawHistory: seen.resumeSawHistory, reachedModel: hist });
      c.ws.close();
      seen.resumeSawHistory = before;
      await sleep(1000);
    }
  }
  fs.writeFileSync(path.join(OUT, 'sessions.json'), JSON.stringify({ work: W, store: path.join(servers[0]?.CFG ?? '', ''), ...sessionsOut }, null, 2));
  conns.forEach((ev, i) => fs.writeFileSync(path.join(OUT, `events-${i}.json`), JSON.stringify(ev.map(({ _at, ...e }) => e)).slice(0, 2_000_000)));
  fs.writeFileSync(path.join(OUT, 'fake-api-requests.json'), JSON.stringify(api.requests.map(({ at, model, nTools, nMessages, last, plan }) => ({ at, model, nTools, nMessages, plan, last: last.slice(0, 120) })), null, 1));
  fs.writeFileSync(path.join(OUT, 'server.log'), servers.map((x) => x.log.join('')).join('\n----\n'));
  await api.close();
}

try { await main(); } catch (e) { check('harness ran to completion', false, String(e?.stack ?? e).slice(0, 1500)); }
cleanup();
console.log(`\n${pass} passed, ${fail} failed${fail ? `\nfailed: ${failures.join(' | ')}` : ''}\nout: ${OUT}`);
process.exitCode = fail ? 1 : 0;
setTimeout(() => process.exit(process.exitCode), 2000).unref();
