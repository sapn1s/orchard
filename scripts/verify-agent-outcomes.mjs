#!/usr/bin/env node
/**
 * FEAT-057 — AGENT DEATHS ARE RECORDED AND VISIBLE WITHOUT THE ORCHESTRATOR.
 *
 * The reported gap: "agents run into usage limit and stop; you wouldn't get a
 * notification because that'd require usage for you to find out". So the load-
 * bearing property is not "the UI can show a death" — it is that the death is
 * recorded, persisted and rendered with NO model turn anywhere in between, and
 * that the reason survives (a subagent that hit a quota wall must not settle as
 * a generic "failed").
 *
 * Everything below is real: the real `outcomes` module against a scratch data
 * dir (part A), then a real server + real bridge + the schema-validated fake
 * `codex app-server` fixture + a real browser (part B). No API cost — the
 * fixture's `usageLimitExceeded` failure is the same frame shape the real
 * binary emits (see the fixtures' $provenance) and the runtime classifies it
 * through the SAME BUG-031 taxonomy as a live one.
 *
 * Usage: node scripts/verify-agent-outcomes.mjs
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'server', 'index.ts');
const FAKE = path.join(ROOT, 'scripts', 'fixtures', 'codex-fake-app-server.mjs');
const BRAVE = process.env.QA_BRAVE_PATH ?? '/usr/bin/brave';

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  const line = typeof observed === 'string' ? observed : JSON.stringify(observed);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${line}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpDirs = new Set();
function mkTmp(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `cs-f57-${tag}-`));
  tmpDirs.add(d);
  return d;
}
async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const servers = new Set();
function startServer(port, dataDir, env = {}) {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: dataDir, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (d) => { if (process.env.CS_VERBOSE) process.stderr.write(`  [srv] ${d}`); });
  servers.add(child);
  return child;
}
function stopByPid(pid) {
  if (!pid) return;
  try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }, 2500).unref();
}
async function waitHealth(port, ms = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return true; } catch { /* not up */ }
    await sleep(200);
  }
  return false;
}
const getJson = async (port, p) => (await (await fetch(`http://127.0.0.1:${port}${p}`)).json());
async function registerProject(port, workDir, name, settings) {
  const reg = await (await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: workDir, name }),
  })).json();
  if (!reg.project?.id) throw new Error(`register failed: ${JSON.stringify(reg)}`);
  await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(reg.project.id)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings }),
  });
  return reg.project.id;
}

/* =================================================== A — the record itself */

async function partA() {
  console.log('\n===== A — the outcome record: honest kinds, bounded store, one-shot briefing =====');
  const DATA = mkTmp('a-data');
  process.env.CLAUDE_STATION_DATA = DATA;
  let out = null;
  try { out = await import(path.join(ROOT, 'src', 'server', 'outcomes.ts')); } catch { out = null; }
  // Stated rather than crashed, so this script is runnable against a tree that
  // predates the feature — which is how its pre-change failure was recorded.
  check('A0 the server-side outcome record exists at all', !!out, out ? 'src/server/outcomes.ts' : 'MISSING — nothing records what died');
  if (!out) return;

  // resetsAt normalisation — the "resets 13:40" number must not be off by decades.
  const secs = Math.floor(Date.now() / 1000) + 3600;
  check('A1 resetsAt in epoch SECONDS is normalised to ms', out.resetsAtMs(secs) === secs * 1000, { in: secs, out: out.resetsAtMs(secs) });
  check('A1 resetsAt already in ms is left alone', out.resetsAtMs(secs * 1000) === secs * 1000, out.resetsAtMs(secs * 1000));
  check('A1 an absent resetsAt stays absent (unknown is not invented)', out.resetsAtMs(null) === null && out.resetsAtMs(undefined) === null, 'null/undefined → null');

  // A `completed` is not an outcome anybody needs told; a death is.
  check('A2 a completed end is NOT stored (deaths only)',
    out.record({ agentId: 'a-ok', row: 'agent', label: 'w', kind: 'completed', detail: 'fine', sdkSessionId: 's1' }) === null,
    out.list({ sessionIds: ['s1'] }).length);
  const pe = { kind: 'quota-window', provider: 'openai', detail: 'usage limit reached', resetsAt: out.resetsAtMs(secs) };
  // `at` values spaced >10ms apart on purpose: these are INDEPENDENT deaths and
  // must not be folded into one BUG-041 cluster by the same-instant heuristic.
  out.record({ agentId: 'a-1', row: 'agent', label: 'worker', kind: 'provider-error', detail: 'died on the wall', providerError: pe, sdkSessionId: 's1', projectId: 'p1', at: Date.now() - 60000 });
  out.record({ agentId: 'a-2', row: 'agent', label: 'worker', kind: 'unknown', detail: 'the engine reported no outcome for it', sdkSessionId: 's1', projectId: 'p1', at: Date.now() - 30000 });
  const l1 = out.list({ sessionIds: ['s1'] });
  check('A2 two deaths recorded, newest first, reasons intact', l1.length === 2 && l1.some((o) => o.kind === 'provider-error') && l1.some((o) => o.kind === 'unknown'),
    l1.map((o) => `${o.agentId}:${o.kind}`));
  check('A2 FIRST observation wins — a later vaguer sweep cannot overwrite a named cause',
    out.record({ agentId: 'a-1', row: 'agent', label: 'worker', kind: 'unknown', detail: 'vague', sdkSessionId: 's1' }) === null
      && out.list({ sessionIds: ['s1'] }).find((o) => o.agentId === 'a-1').kind === 'provider-error',
    out.list({ sessionIds: ['s1'] }).find((o) => o.agentId === 'a-1')?.kind);
  check('A3 the headline names the quota wall and its reset time',
    /2 agents stopped — quota-window, resets \d\d:\d\d/.test(out.headline(l1)), out.headline(l1));
  check('A3 "ended, reason unknown" is the honest line for a death with no known cause',
    /ended, reason unknown/.test(out.outcomeLine(l1.find((o) => o.kind === 'unknown'))), out.outcomeLine(l1.find((o) => o.kind === 'unknown')));

  const brief1 = out.takeBriefing(['s1']);
  check('A4 the briefing names the deaths', !!brief1 && /While you were away/.test(brief1) && /quota-window/.test(brief1) && /reason unknown/.test(brief1), brief1?.split('\n')[0]);
  check('A4 the SAME deaths are never briefed twice', out.takeBriefing(['s1']) === null, 'second call → null');
  check('A4 a healthy session gets NO briefing at all', out.takeBriefing(['s-healthy']) === null, 'null');
  out.record({ agentId: 'a-3', row: 'agent', label: 'w', kind: 'killed', detail: 'k', sdkSessionId: 's1' });
  check('A4 a NEW death after a briefing is briefed once, on its own', /1 agent\/turn ended/.test(out.takeBriefing(['s1']) ?? ''), 'third death briefed');

  check('A5 dismissal is persisted and removes it from the list',
    out.dismiss(l1.map((o) => o.id)) === 2 && out.list({ sessionIds: ['s1'] }).every((o) => o.agentId === 'a-3'),
    out.list({ sessionIds: ['s1'] }).map((o) => o.agentId));

  /* ============ BUG-041 — the ledger must be HONEST about what it knows ============ */
  console.log('\n----- BUG-041 additions: notices are not causes, completions are not deaths, clusters are one event -----');

  // A6 — an ADVISORY classification (BUG-035's non-fatal pending-MCP notice)
  // may never be named as a cause of death. This is the exact live shape:
  // `tooling-unavailable (anthropic): MCP tool server still starting: serena`.
  const pendingPe = { kind: 'tooling-unavailable', provider: 'anthropic', detail: 'MCP tool server still starting: serena', pending: true };
  check('A6 isTerminalCause: pending and retrying classifications are NOT causes; a terminal one is',
    typeof out.isTerminalCause === 'function'
      && out.isTerminalCause(pendingPe) === false
      && out.isTerminalCause({ kind: 'overloaded', provider: 'anthropic', detail: 'x', retrying: { attempt: 1, maxRetries: 3, delayMs: 100 } }) === false
      && out.isTerminalCause(pe) === true,
    typeof out.isTerminalCause === 'function' ? 'pending→false, retrying→false, quota-window→true' : 'isTerminalCause MISSING (pre-fix)');
  check('A6 attachProviderError REFUSES to promote an advisory notice onto existing deaths',
    out.attachProviderError(['s1'], 0, pendingPe) === 0
      && out.list({ sessionIds: ['s1'], includeDismissed: true }).every((o) => o.providerError?.kind !== 'tooling-unavailable'),
    out.list({ sessionIds: ['s1'], includeDismissed: true }).map((o) => `${o.agentId}:${o.providerError?.kind ?? '-'}`));
  const demoted = out.record({ agentId: 'a-adv', row: 'agent', label: 'worker', kind: 'provider-error', detail: 'the turn ended while this agent was still running', providerError: pendingPe, sdkSessionId: 's-adv', at: Date.now() - 45000 });
  check('A6 record() demotes an advisory "cause" to unknown, keeping the notice as marked context',
    demoted?.kind === 'unknown' && demoted?.providerError === null
      && /context, not cause/.test(demoted?.detail ?? '') && /MCP tool server still starting: serena/.test(demoted?.detail ?? ''),
    demoted ? `${demoted.kind}; ${demoted.detail.slice(0, 140)}` : 'record() returned null / threw (pre-fix)');
  check('A6 the demoted record renders as "ended, reason unknown", never as tooling-unavailable',
    /ended, reason unknown/.test(out.outcomeLine(demoted ?? { kind: 'unknown', at: 0, row: 'agent', label: '', description: '', detail: '' }))
      && !/^.*— tooling-unavailable/.test(out.outcomeLine(demoted ?? { kind: 'unknown', at: 0, row: 'agent', label: '', description: '', detail: '' })),
    demoted ? out.outcomeLine(demoted).slice(0, 140) : 'no record');

  // A7 — a same-instant cluster is ONE host-level event, not N independent deaths.
  const clusterAt = Date.now() - 20000;
  out.record({ agentId: 'main', row: 'main', label: 'main', kind: 'cut', detail: 'the session was cut while work was in flight', sdkSessionId: 's-cl', clusterId: 'cl-1', at: clusterAt });
  out.record({ agentId: 'c-1', row: 'agent', label: 'builder', kind: 'cut', detail: 'the session was cut while work was in flight', sdkSessionId: 's-cl', clusterId: 'cl-1', at: clusterAt });
  out.record({ agentId: 'c-2', row: 'agent', label: 'tester', kind: 'cut', detail: 'the session was cut while work was in flight', sdkSessionId: 's-cl', clusterId: 'cl-1', at: clusterAt + 3 });
  const clRecords = out.list({ sessionIds: ['s-cl'] });
  const clusters = typeof out.clustersOf === 'function' ? out.clustersOf.bind(out) : () => [];
  check('A7 clustersOf groups an explicit writer-stamped cluster into ONE event',
    typeof out.clustersOf === 'function' && clusters(clRecords).length === 1 && clusters(clRecords)[0].length === 3,
    typeof out.clustersOf === 'function' ? clusters(clRecords).map((c) => c.length) : 'clustersOf MISSING (pre-fix)');
  check('A7 the headline calls one cluster ONE event, not three deaths',
    /3 stopped together — one event \(cut\)/.test(out.headline(clRecords)), out.headline(clRecords));
  const clBrief = out.takeBriefing(['s-cl']);
  check('A7 the briefing reports the cluster as one host-level event with its evidence (who, span)',
    !!clBrief && /\(1 event\)/.test(clBrief) && /host-level event: 3 ended together/.test(clBrief)
      && /the main turn \+ builder \+ tester/.test(clBrief) && /not 3 independent failures/.test(clBrief),
    clBrief?.split('\n').slice(0, 2).join(' | '));
  // …and UNSTAMPED same-millisecond records from one session cluster by evidence.
  const implicitAt = Date.now() - 10000;
  out.record({ agentId: 'i-1', row: 'main', label: 'main', kind: 'unknown', detail: 'x', sdkSessionId: 's-impl', at: implicitAt });
  out.record({ agentId: 'i-2', row: 'agent', label: 'worker', kind: 'unknown', detail: 'x', sdkSessionId: 's-impl', at: implicitAt + 3 });
  const implicit = clusters(out.list({ sessionIds: ['s-impl'] }));
  check('A7 records 3ms apart in one session (the live BUG-041 shape, no clusterId) are one event by evidence',
    implicit.length === 1 && implicit[0].length === 2, implicit.map((c) => c.length));

  // A8 — the turn-boundary decision itself: a delivered result IS a completion.
  const teo = out.turnEndOutcome;
  check('A8 turnEndOutcome exists (the sweep\'s decision is a single testable function)',
    typeof teo === 'function', typeof teo === 'function' ? 'function' : 'MISSING (pre-fix: the sweep decides inline, wrongly)');
  if (typeof teo === 'function') {
    check('A8 an agent whose Task tool_result was delivered is NOT recorded as a death',
      teo({ interrupted: false, resultDelivered: true, lastProviderError: null }) === null
        && teo({ interrupted: true, resultDelivered: true, lastProviderError: pe }) === null,
      'resultDelivered → null (nothing recorded), even with an interrupt/error latched');
    check('A8 a user interrupt is recorded as killed — we did that and can say so',
      teo({ interrupted: true, resultDelivered: false, lastProviderError: null })?.kind === 'killed',
      teo({ interrupted: true, resultDelivered: false, lastProviderError: null }));
    const withPe = teo({ interrupted: false, resultDelivered: false, lastProviderError: pe });
    check('A8 a REAL terminal provider error still records with the honest cause, verbatim',
      withPe?.kind === 'provider-error' && withPe?.providerError === pe && /usage limit reached/.test(withPe?.detail ?? ''),
      withPe?.detail);
    const noEvidence = teo({ interrupted: false, resultDelivered: false, lastProviderError: null, advisoryNotice: 'tooling-unavailable (anthropic) notice was active' });
    check('A8 no evidence → unknown, with any advisory notice quoted as CONTEXT, never as cause',
      noEvidence?.kind === 'unknown' && noEvidence?.providerError === null && /context, not cause/.test(noEvidence?.detail ?? ''),
      noEvidence?.detail);
  }

  // A9 — CONFORMANCE: the bridge's live call sites actually consult these
  // decisions (a correct function nobody calls would make A6–A8 vacuous).
  const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src', 'server', 'agent-bridge.ts'), 'utf8');
  check('A9 the turn-boundary sweep delegates to outcomes.turnEndOutcome',
    /outcomes\.turnEndOutcome\(/.test(bridgeSrc), 'agent-bridge.ts result sweep');
  check('A9 the provider-error latch admits only terminal causes (isTerminalCause) and never latches pending',
    /outcomes\.isTerminalCause\(pe\)/.test(bridgeSrc) && /pe\.pending/.test(bridgeSrc), 'agent-bridge.ts #handle latch');
  check('A9 delivered Task tool_results feed the completion-evidence set the sweep consults',
    /#resultDelivered/.test(bridgeSrc) && /tool_result/.test(bridgeSrc) && /resultDelivered: this\.#resultDelivered\.has\(/.test(bridgeSrc),
    'agent-bridge.ts user-frame handler + sweep');
  check('A9 a session cut stamps ONE shared cluster id on every row it takes down',
    /session-end-/.test(bridgeSrc) && /clusterId,\s*\n\s*at,/.test(bridgeSrc), 'agent-bridge.ts #recordSessionEnd');
}

/* ====================================== B — end to end, with no model turn */

const READ_RAIL = () => ({
  hidden: document.querySelector('#railStopped')?.hidden !== false,
  head: document.querySelector('#railStopped .sub-h')?.textContent ?? '',
  rows: [...document.querySelectorAll('#railStopped .brow')].map((r) => r.textContent),
});

async function openTab(browser, port, projectId, sessionId) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const hash = sessionId
    ? `#/project/${encodeURIComponent(projectId)}/session/${encodeURIComponent(sessionId)}`
    : `#/project/${encodeURIComponent(projectId)}`;
  await page.goto(`http://127.0.0.1:${port}/${hash}`);
  await page.waitForFunction(() => window.__station && document.querySelector('#prompt'), undefined, { timeout: 30000 });
  return page;
}

async function pollFor(page, fn, pred, ms) {
  const t0 = Date.now();
  let v = null;
  while (Date.now() - t0 < ms) {
    try { v = await page.evaluate(fn); } catch { /* mid-navigation */ }
    if (v && pred(v)) return { ok: true, v };
    await sleep(400);
  }
  return { ok: false, v };
}

async function partB(browser) {
  console.log('\n===== B — a real turn dies on a usage limit; nothing model-shaped runs afterwards =====');
  const port = await freePort();
  const DATA = mkTmp('b-data');
  const WORK = mkTmp('b-work');
  const INPUT_LOG = path.join(mkTmp('b-log'), 'inputs.jsonl');
  const srv = startServer(port, DATA, {
    CLAUDE_STATION_CODEX_BIN: FAKE, CLAUDE_STATION_SURVIVE: '0', CODEX_FAKE_INPUT_LOG: INPUT_LOG, CODEX_FAKE_HOLD_MS: '2500',
  });
  if (!(await waitHealth(port))) throw new Error('scratch server never became healthy');
  const projectId = await registerProject(port, WORK, 'f57-quota', { provider: 'openai', model: null, permissionMode: 'bypassPermissions' });

  const page = await openTab(browser, port, projectId);
  await page.fill('#prompt', 'HOLD_AGENTS:3;QUOTA — three workers, then the account hits its limit');
  await page.focus('#prompt');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !!(window.__station.state.stationSessionId || window.__station.state.sdkSessionId), undefined, { timeout: 30000 });
  const id = await page.evaluate(() => window.__station.state.stationSessionId || window.__station.state.sdkSessionId);
  const sdk = await page.evaluate(() => window.__station.state.sdkSessionId);

  // The deaths are recorded by the SERVER, from frames it already receives.
  const recorded = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      const r = await getJson(port, `/api/agent-outcomes?projectId=${encodeURIComponent(projectId)}`);
      if ((r.outcomes ?? []).length >= 4) return r;
      await sleep(400);
    }
    return await getJson(port, `/api/agent-outcomes?projectId=${encodeURIComponent(projectId)}`);
  })();
  const agents = (recorded.outcomes ?? []).filter((o) => o.row === 'agent');
  const main = (recorded.outcomes ?? []).find((o) => o.row === 'main');
  check('B1 all three subagents AND the main turn are recorded as provider-error (the reason is not lost)',
    agents.length === 3 && agents.every((o) => o.kind === 'provider-error') && main?.kind === 'provider-error',
    (recorded.outcomes ?? []).map((o) => `${o.row}:${o.agentId}:${o.kind}`));
  check('B1 the record carries BUG-031\'s taxonomy verbatim (quota-window, provider, the provider\'s own words)',
    agents.length === 3 && agents.every((o) => o.providerError?.kind === 'quota-window' && o.providerError?.provider === 'openai'
      && /usage limit/i.test(o.providerError?.detail ?? '')),
    agents[0]?.providerError);
  check('B1 the server writes the one-line headline the UI shows',
    /agents stopped — quota-window/.test(recorded.headline ?? ''), recorded.headline);

  /* B2 — a FRESH page load, with no orchestrator turn anywhere in between. */
  const fresh = await openTab(browser, port, projectId);
  const rail = await pollFor(fresh, READ_RAIL, (r) => r.hidden === false, 20000);
  check('B2 a FRESH page load shows the rail item — no orchestrator turn ran after the deaths',
    rail.ok && /agents stopped — quota-window/.test(rail.v.head), rail.v);
  check('B2 the rail names each death with its honest reason', (rail.v?.rows ?? []).length >= 3, rail.v?.rows);

  /* B3 — dismissal is a server write, so it survives a reload. */
  await fresh.evaluate(() => document.querySelector('#railStopped .lnk')?.click());
  await sleep(800);
  await fresh.reload();
  await fresh.waitForFunction(() => window.__station && document.querySelector('#prompt'), undefined, { timeout: 30000 });
  await sleep(2500);
  const after = await fresh.evaluate(READ_RAIL);
  check('B3 dismissal persists across a reload (a cleared banner stays cleared)', after.hidden === true, after);
  await fresh.close();

  /* B4 — the briefing, at the orchestrator's NEXT turn start. */
  const before = fs.existsSync(INPUT_LOG) ? fs.readFileSync(INPUT_LOG, 'utf8').trim().split('\n').length : 0;
  await page.fill('#prompt', 'status?');
  await page.focus('#prompt');
  await page.keyboard.press('Enter');
  const briefed = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      const lines = fs.existsSync(INPUT_LOG) ? fs.readFileSync(INPUT_LOG, 'utf8').trim().split('\n').filter(Boolean) : [];
      if (lines.length > before) return JSON.parse(lines[lines.length - 1]).text;
      await sleep(300);
    }
    return null;
  })();
  check('B4 the next turn\'s prompt carries the "while you were away" briefing, naming what died and why',
    !!briefed && /^\[station\] While you were away/.test(briefed) && /quota-window/.test(briefed) && /status\?$/.test(briefed.trim()),
    briefed?.slice(0, 180));

  // …and only once: a second turn on a healthy session injects NOTHING.
  await sleep(1500);
  const before2 = fs.readFileSync(INPUT_LOG, 'utf8').trim().split('\n').filter(Boolean).length;
  await page.fill('#prompt', 'again?');
  await page.focus('#prompt');
  await page.keyboard.press('Enter');
  const second = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      const lines = fs.readFileSync(INPUT_LOG, 'utf8').trim().split('\n').filter(Boolean);
      if (lines.length > before2) return JSON.parse(lines[lines.length - 1]).text;
      await sleep(300);
    }
    return null;
  })();
  check('B4 a healthy turn gets NO briefing — nothing died since, so nothing is injected',
    second === 'again?', second);
  await page.close();
  stopByPid(srv.pid);
  return { id, sdk };
}

/* ================= C — a killed agent, surviving with no orchestrator turn */

async function partC(browser) {
  console.log('\n===== C — the engine is KILLED mid-flight: the deaths outlive the session =====');
  const port = await freePort();
  const DATA = mkTmp('c-data');
  const WORK = mkTmp('c-work');
  const srv = startServer(port, DATA, { CLAUDE_STATION_CODEX_BIN: FAKE, CLAUDE_STATION_SURVIVE: '0' });
  if (!(await waitHealth(port))) throw new Error('scratch server never became healthy');
  const projectId = await registerProject(port, WORK, 'f57-kill', { provider: 'openai', model: null, permissionMode: 'bypassPermissions' });
  const page = await openTab(browser, port, projectId);
  await page.fill('#prompt', 'HOLD_AGENTS:2 — hold two workers open');
  await page.focus('#prompt');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => (window.__station.state.snap?.running ?? []).length >= 3, undefined, { timeout: 30000 }).catch(() => {});

  // The kill: the engine process behind the turn, SIGKILLed — the shape of a
  // container kill / a crashed CLI, where no terminal frame is ever emitted.
  const ps = spawn('pgrep', ['-f', 'codex-fake-app-server.mjs'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  ps.stdout.on('data', (d) => { out += String(d); });
  await new Promise((r) => ps.on('close', r));
  const killed = [];
  for (const pid of out.trim().split('\n').filter(Boolean).map(Number)) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (ppid === srv.pid) { killed.push(pid); process.kill(pid, 'SIGKILL'); }
    } catch { /* raced */ }
  }
  check('C0 PRECONDITION: the engine behind the running agents was killed outright', killed.length > 0, { killed });

  const recorded = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      const r = await getJson(port, `/api/agent-outcomes?projectId=${encodeURIComponent(projectId)}`);
      if ((r.outcomes ?? []).length >= 3) return r;
      await sleep(400);
    }
    return await getJson(port, `/api/agent-outcomes?projectId=${encodeURIComponent(projectId)}`);
  })();
  check('C1 the killed agents AND the main turn are recorded as `cut` — never as "completed"',
    (recorded.outcomes ?? []).length >= 3 && (recorded.outcomes ?? []).every((o) => o.kind === 'cut'),
    (recorded.outcomes ?? []).map((o) => `${o.row}:${o.kind}`));
  check('C1 each record says what actually happened, in plain words',
    (recorded.outcomes ?? []).every((o) => /while work was in flight/.test(o.detail) && !/completed/.test(o.kind)),
    recorded.outcomes?.[0]?.detail);
  /*
   * BUG-041 — one dead engine is ONE host-level event. Every row it took down
   * must carry the same writer-stamped cluster id, and the reporting surfaces
   * must present them as one fact, not three same-millisecond deaths.
   */
  const clusterIds = [...new Set((recorded.outcomes ?? []).map((o) => o.clusterId))];
  check('C1 BUG-041: main + agents killed by one cut share ONE writer-stamped cluster id',
    (recorded.outcomes ?? []).length >= 3 && clusterIds.length === 1 && !!clusterIds[0],
    clusterIds);
  check('C1 BUG-041: the headline reports the cut as one event, not N independent deaths',
    /stopped together — one event \(cut\)/.test(recorded.headline ?? ''), recorded.headline);
  await page.close();

  // A FRESH tab, no socket to that session, no model turn: still visible.
  const fresh = await openTab(browser, port, projectId);
  const rail = await pollFor(fresh, READ_RAIL, (r) => r.hidden === false, 20000);
  check('C2 a fresh page load shows the killed agents on the rail, with no orchestrator turn in between',
    rail.ok && /stopped/.test(rail.v.head), rail.v);
  await fresh.close();
  stopByPid(srv.pid);
}

/* ------------------------------------------------------------------- main */

let browser = null;
try {
  await partA();
  if (!fs.existsSync(BRAVE)) {
    check('a browser is available for the end-to-end halves', false, BRAVE);
  } else {
    browser = await chromium.launch({ headless: true, executablePath: BRAVE });
    await partB(browser);
    await partC(browser);
  }
} catch (err) {
  check('the suite ran to completion', false, String(err?.stack ?? err));
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const s of servers) stopByPid(s.pid);
  await sleep(600);
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
}

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) { console.log(`FAILED: ${failures.join(' | ')}`); process.exitCode = 1; }
