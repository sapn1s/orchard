/**
 * BUG-308 — the "N agents ran in this session" summary must be COLLAPSED by
 * default (one count row + a disclosure), not a flood of one hairline row per
 * agent. In an agent-heavy session (the user hit 187) the expanded list buried
 * the conversation.
 *
 * This drives the REAL page against a REAL agent-heavy transcript discovered at
 * runtime in the user's own store (the heaviest orchard session with ≥ MIN_AGENTS
 * recorded sub-agents — not a hand-built fixture, and not pinned to one id that
 * could be pruned). It asserts the USER-OBSERVABLE outcome:
 *
 *   - collapsed by default: the stack is a <details>, closed, with ZERO per-agent
 *     rows visible and a disclosure control;
 *   - the collapsed row carries the agent COUNT (and any failed/running tally);
 *   - expanding (a real click on the summary) reveals the agents;
 *   - each `open ›` still opens that agent's thread (agent= on the URL);
 *   - the expanded choice survives scroll paging ("more" older);
 *   - the summary is NOT spliced mid-conversation — it is the last content in the
 *     pane (guards BUG-004 / BUG-014 / BUG-017).
 *
 * MUST-FAIL (not anchored to HEAD): the collapse predicate is also run against a
 * SYNTHESIZED pre-change stack — a plain div.ran-stack with visible rows, exactly
 * what the old code rendered — and must REJECT it. So a regression that un-collapses
 * the stack reddens this test.
 *
 *   node scripts/verify-bug-308-agent-summary-collapse.mjs
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';
import { isolatedServerEnv } from './lib/station-boot.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MIN_AGENTS = 50;          // "agent-heavy" floor; the reported case had 187
// The real agent-heavy transcripts live under this very checkout's own project
// (this repo IS an agent-heavy project), so derive the host path and its encoded
// store key from ROOT rather than hardcoding a home path (portable + leak-free).
const ORCHARD_HOST = ROOT;
const ENCODED = ROOT.replace(/[/.]/g, '-');

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const PORT = Number(process.env.VERIFY_BUG308_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug308-data-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bug308-chrome-'));
const BRAVE = process.env.VERIFY_ROUTING_BROWSER ?? 'brave';

let pass = 0, fail = 0;
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : fail++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const c = new Cdp(ws);
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.id && c.waiting.has(m.id)) {
        const { res, rej } = c.waiting.get(m.id);
        c.waiting.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.waiting.set(id, { res, rej }));
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  }
  async waitFor(label, expr, timeoutMs = 30_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (await this.eval(expr)) return true; } catch { /* nav */ }
      await sleep(150);
    }
    console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
    return false;
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

let server = null, browser = null;
const cleanupDirs = [DATA, PROFILE];
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

/**
 * Agent-heavy orchard sessions in the REAL store, by recorded-subagent count,
 * heaviest first. The first is used for the flood/collapse assertions; the
 * second is the "other session" for the per-session-persistence (A→B→A) case.
 */
function discoverAgentHeavySessions() {
  const store = path.join(process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects'), ENCODED);
  if (!fs.existsSync(store)) throw new Error(`no orchard store at ${store} — cannot test the real artifact`);
  const rows = [];
  for (const name of fs.readdirSync(store)) {
    const subDir = path.join(store, name, 'subagents');
    if (!fs.existsSync(subDir)) continue;
    let n = 0;
    for (const f of fs.readdirSync(subDir)) if (f.endsWith('.meta.json')) n++;
    if (n >= MIN_AGENTS) rows.push({ sid: name, n });
  }
  rows.sort((a, b) => b.n - a.n);
  if (!rows.length) {
    throw new Error(`no agent-heavy orchard session (≥ ${MIN_AGENTS} subagents) in the real store. Cannot reproduce the flood.`);
  }
  return rows;
}
function discoverAgentHeavySession() { return discoverAgentHeavySessions()[0]; }

async function main() {
  const heavies = discoverAgentHeavySessions();
  const heavy = heavies[0];
  const other = heavies[1] ?? null; // the "other session" for the A→B→A case
  console.log(`real agent-heavy session: ${heavy.sid} (${heavy.n} recorded subagents)`);
  if (other) console.log(`other agent-heavy session (for A→B→A): ${other.sid} (${other.n} recorded subagents)`);

  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: isolatedServerEnv({ PORT: String(PORT), CLAUDE_STATION_DATA: DATA }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  const reg = await (await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: ORCHARD_HOST, name: 'bug308-verify' }),
  })).json();
  const pid = reg.project?.id;
  if (!pid) throw new Error(`register failed: ${JSON.stringify(reg)}`);

  const subs = await (await fetch(`${BASE}/api/sessions/${heavy.sid}/subagents?dir=${encodeURIComponent(ENCODED)}`)).json();
  const apiAgents = Array.isArray(subs) ? subs : (subs.subagents ?? []);
  if (apiAgents.length < MIN_AGENTS) throw new Error(`API returned only ${apiAgents.length} subagents for ${heavy.sid}`);

  browser = spawn(BRAVE, ['--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 80 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const cdp = await Cdp.connect(targets.find((x) => x.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');

  // The collapse predicate is defined ONCE, in the page, and reused for the real
  // stack and the synthesized pre-change stack, so the must-FAIL exercises the
  // same judgement the real assertion uses.
  const PREDICATE = `
    window.__bug308_collapsedByDefault = function (stack) {
      if (!stack) return { pass:false, why:'no stack' };
      const rows = [...stack.querySelectorAll('.ran')];
      const visibleRows = rows.filter(r => r.checkVisibility && r.checkVisibility()).length;
      const isDetails = stack.tagName === 'DETAILS';
      const collapsed = isDetails && stack.open === false;
      const hasDisclosure = !!stack.querySelector('summary');
      return {
        pass: visibleRows === 0 && collapsed && hasDisclosure,
        visibleRows, rowsRendered: rows.length, isDetails, open: !!stack.open, hasDisclosure,
      };
    };`;

  const openAt = (sid) => cdp.send('Page.navigate', { url: `${BASE}/#/project/${pid}/session/${sid}?dir=${encodeURIComponent(ENCODED)}` });
  const HERE = `document.querySelector('#panes .pane.on .you, #panes .pane.on .claude') !== null`;

  console.log('\n=== real agent-heavy session: summary COLLAPSED by default ===');
  await openAt(heavy.sid);
  await cdp.waitFor('transcript', HERE, 40_000);
  await cdp.waitFor('ran-stack present', `document.querySelector('#panes .pane.on .ran-stack') !== null`, 15_000);
  await sleep(600);
  await cdp.eval(PREDICATE);

  const def = await cdp.eval(`(() => {
    const stack = document.querySelector('#panes .pane.on .ran-stack');
    const r = window.__bug308_collapsedByDefault(stack);
    r.label = stack?.querySelector('.rlbl-text')?.textContent ?? null;
    r.stackHeight = stack ? Math.round(stack.getBoundingClientRect().height) : null;
    return r;
  })()`);
  check('the summary is COLLAPSED by default — a <details>, closed, with NO per-agent rows visible',
    def.pass, def);
  check('the collapsed row carries the agent count ("N agents ran in this session")',
    /\bagents? ran in this session\b/.test(def.label ?? '') && new RegExp(`^${apiAgents.length}\\b`).test(def.label ?? ''),
    def.label);

  // MUST-FAIL: the same predicate rejects the OLD (pre-change) rendering.
  const mustFail = await cdp.eval(`(() => {
    // Rebuild the pre-change structure: a plain div.ran-stack with a label div and
    // visible per-agent rows (no <details>/<summary>). Exactly the old flood.
    const old = document.createElement('div');
    old.className = 'ran-stack';
    const lbl = document.createElement('div'); lbl.className = 'ran-lbl';
    lbl.textContent = '188 agents ran in this session · newest 8';
    old.appendChild(lbl);
    for (let i = 0; i < 8; i++) {
      const row = document.createElement('div'); row.className = 'ran';
      row.textContent = 'agent ' + i;
      old.appendChild(row);
    }
    document.body.appendChild(old);
    const r = window.__bug308_collapsedByDefault(old);
    old.remove();
    return r;
  })()`);
  check('MUST-FAIL — the predicate REJECTS the synthesized pre-change flood (visible rows, no <details>)',
    mustFail.pass === false && mustFail.visibleRows > 0, mustFail);

  console.log('\n=== expanding reveals the agents; each open › opens its thread ===');
  const expanded = await cdp.eval(`(() => {
    const stack = document.querySelector('#panes .pane.on .ran-stack');
    stack.querySelector('summary.ran-lbl').click();
    const rows = [...stack.querySelectorAll('.ran')];
    return { open: !!stack.open, visibleRows: rows.filter(r => r.checkVisibility()).length };
  })()`);
  check('clicking the summary EXPANDS the list — agent rows become visible',
    expanded.open === true && expanded.visibleRows > 0, expanded);

  const opened = await cdp.eval(`(async () => {
    const row = document.querySelector('#panes .pane.on .ran-stack .ran');
    row.querySelector('.open').click();
    await new Promise(r => setTimeout(r, 1500));
    return { hash: location.hash, viewing: window.__station?.state?.viewing ?? null };
  })()`);
  check('each "open ›" still opens that agent thread (agent= on the URL, state.viewing moved)',
    /agent=[0-9a-f]+/.test(opened.hash) && !!opened.viewing, opened);

  console.log('\n=== state survives scroll paging ("more" older) ===');
  // Force a FRESH document load (the prior test navigated via hash, which is a
  // same-document route that PRESERVES the <details> open state — itself proof
  // the choice survives, but here we want a clean collapsed start). Expand once,
  // then page older and assert the open choice survives the row append.
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await sleep(300);
  await openAt(heavy.sid);
  await cdp.waitFor('transcript again', HERE, 40_000);
  await cdp.waitFor('ran-stack again', `document.querySelector('#panes .pane.on .ran-stack') !== null`, 20_000);
  await sleep(600);
  const paged = await cdp.eval(`(() => {
    const stack = document.querySelector('#panes .pane.on .ran-stack');
    const startedCollapsed = stack.open === false;
    stack.querySelector('summary.ran-lbl').click();      // expand from collapsed
    const openedByClick = stack.open === true;
    const before = stack.querySelectorAll('.ran').length;
    const more = stack.querySelector('.more');
    const labelBefore = stack.querySelector('.rlbl-text').textContent;
    if (more && !more.hidden) more.click();               // page older
    const after = stack.querySelectorAll('.ran').length;
    return { startedCollapsed, openedByClick, openAfterPaging: !!stack.open, before, after,
      labelStable: stack.querySelector('.rlbl-text').textContent === labelBefore };
  })()`);
  check('the expanded choice SURVIVES scroll paging — "more" reveals older rows and the stack stays open',
    paged.startedCollapsed && paged.openedByClick && paged.openAfterPaging === true
      && paged.after > paged.before && paged.labelStable, paged);

  console.log('\n=== not spliced mid-conversation (BUG-004/014/017) ===');
  const splice = await cdp.eval(`(() => {
    const pane = document.querySelector('#panes .pane.on');
    const stack = pane.querySelector('.ran-stack');
    // Walk forward siblings up the tree to the pane: is any conversation node AFTER the stack?
    let convoAfter = 0, node = stack;
    while (node && node !== pane) {
      let sib = node.nextElementSibling;
      while (sib) {
        if (sib.matches('.you') || sib.querySelector?.('.you, .claude-prose, .assistant')) convoAfter++;
        sib = sib.nextElementSibling;
      }
      node = node.parentElement;
    }
    return { convoAfter };
  })()`);
  check('the summary is the LAST content — no conversation rendered after it (no mid-conversation splice)',
    splice.convoAfter === 0, splice);

  console.log('\n=== a live agent appended to the already-paged recorded stack KEEPS the true total + tally ===');
  // The r1 defect (independent verify run 92653dfd): ranRow's non-silent (live)
  // branch recomputed the collapsed label from stack.querySelectorAll('.ran')
  // — only the ~8 paged DOM rows — so the first live agent appended into a
  // trailing recorded stack of 187 rewrote "187 agents … · 1 failed" into
  // "9 agents ran in this session", dropping the authoritative total AND the
  // failure tally. The fix carries the count/tally as a DECLARED fact on the
  // stack (ranStackTally) and only ADVANCES it on append. Synthesized: we drive
  // the real exposed ranRow against the real paged recorded stack; not anchored
  // to HEAD. MUST-FAIL vs r1: there the label collapses to the DOM-row count.
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await sleep(300);
  await openAt(heavy.sid);
  await cdp.waitFor('transcript (live-append)', HERE, 40_000);
  await cdp.waitFor('ran-stack (live-append)', `document.querySelector('#panes .pane.on .ran-stack') !== null`, 20_000);
  await sleep(600);
  const liveAppend = await cdp.eval(`(() => {
    const S = window.__station;
    const stack = document.querySelector('#panes .pane.on .ran-stack');
    if (!S || typeof S.ranRow !== 'function' || typeof S.mainThread !== 'function') {
      return { hook: false };
    }
    const th = S.mainThread();
    const read = () => ({
      label: stack.querySelector('.rlbl-text').textContent,
      total: Number(stack.dataset.ranTotal || 0),
      failed: Number(stack.dataset.ranFailed || 0),
    });
    const mkBody = () => { const d = document.createElement('div'); d.className = 'ran-out'; return d; };
    const before = { ...read(), domRows: stack.querySelectorAll('.ran').length };
    // a live agent completes and settles into the already-paged recorded stack
    S.ranRow(th, { agentId: 'bug308-live-A', agentType: 'worker', description: 'live completed', status: 'completed', stats: '1s · 0 tools · 0', body: mkBody() });
    const afterA = read();
    // a live agent that FAILED settles into the SAME stack
    S.ranRow(th, { agentId: 'bug308-live-B', agentType: 'worker', description: 'live failed', status: 'failed', stats: '1s · 0 tools · 0', body: mkBody() });
    const afterB = read();
    const m = afterB.label.match(/^(\\d+) agents? ran in this session(?:.*· (\\d+) failed)?/);
    return { hook: true, before, afterA, afterB,
      parsedTotal: m ? Number(m[1]) : null,
      parsedFailed: m && m[2] ? Number(m[2]) : 0 };
  })()`);
  const la = liveAppend;
  check('ran internals are exposed for the live-append drive (pre-fix build has no such hook)',
    la.hook === true, la);
  check('the declared total ADVANCES by one per live append — it is not recomputed from the ~8 paged DOM rows',
    la.hook && la.afterA.total === la.before.total + 1 && la.afterB.total === la.before.total + 2
      && la.before.total === apiAgents.length,
    la.hook ? { beforeTotal: la.before.total, afterA: la.afterA.total, afterB: la.afterB.total, apiAgents: apiAgents.length, domRowsBefore: la.before.domRows } : la);
  check('the failure tally SURVIVES a live append and advances only for a failed agent',
    la.hook && la.afterA.failed === la.before.failed && la.afterB.failed === la.before.failed + 1,
    la.hook ? { beforeFailed: la.before.failed, afterA: la.afterA.failed, afterB: la.afterB.failed } : la);
  check('the COLLAPSED LABEL shows the true (declared) total + tally, not the DOM-row count ("9 agents …")',
    la.hook && la.parsedTotal === la.before.total + 2 && la.parsedTotal !== la.before.domRows + 2
      && la.parsedFailed === la.before.failed + 1,
    la.hook ? { parsedTotal: la.parsedTotal, parsedFailed: la.parsedFailed, label: la.afterB.label, wouldBeDomCount: la.before.domRows + 2 } : la);

  console.log('\n=== the expand/collapse choice is REMEMBERED per session (A → B → A) ===');
  // BUG-308 verify r2, P3c: native <details>.open is per-DOM state. An SPA
  // session switch tears the transcript down and rebuilds it, so A's ran-stack
  // came back COLLAPSED after A → B → A and the user lost the expansion. The fix
  // keys the open choice by session id in one in-memory Map, read when the stack
  // is built and written on toggle. Synthesized (drives the REAL same-document
  // openSession the sidebar click calls — a hash-only nav would NOT switch
  // sessions, onHashRoute handles only overlays), not anchored to HEAD.
  // MUST-FAIL vs r2: A rebuilds collapsed, so the back-to-A assertion is false.
  if (!other) {
    check('a second agent-heavy session exists to test A→B→A persistence', false,
      'only one ≥50-subagent session in the store — cannot drive a real session switch');
  } else {
    const A = heavy.sid, B = other.sid;
    // Fresh document load clears the in-memory open-state Map, giving a clean
    // collapsed-by-default start (the persistence is in-memory; it need not —
    // and must not — survive a full page reload).
    await cdp.send('Page.navigate', { url: 'about:blank' });
    await sleep(300);
    // A: load, confirm collapsed by default, then EXPAND via a real summary click.
    await openAt(A);
    await cdp.waitFor('A transcript', HERE, 40_000);
    await cdp.waitFor('A ran-stack', `document.querySelector('#panes .pane.on .ran-stack') !== null`, 20_000);
    await sleep(600);
    const aStart = await cdp.eval(`(() => {
      const stack = document.querySelector('#panes .pane.on .ran-stack');
      const collapsed = stack.open === false;
      stack.querySelector('summary.ran-lbl').click();       // user expands A
      return { collapsed, openAfterClick: !!stack.open };
    })()`);
    // The SPA session switch is a SAME-DOCUMENT navigation. A sidebar-row click
    // goes straight through openSession (the hash router's onHashRoute handles
    // only overlays, not sessions), so drive the REAL openSession: the transcript
    // is genuinely torn down and rebuilt in place while the in-memory open-state
    // Map survives — exactly the A→B→A the user does.
    const switchTo = async (sid, label) => {
      const hook = await cdp.eval(`(async () => {
        const S = window.__station;
        if (!S || typeof S.openSession !== 'function' || typeof S.currentProject !== 'function') return false;
        await S.openSession(S.currentProject(), { sessionId: ${JSON.stringify(sid)}, encodedDir: ${JSON.stringify(ENCODED)} });
        return true;
      })()`);
      if (!hook) throw new Error('openSession/currentProject not exposed on __station');
      await cdp.waitFor(label + ' current',
        `window.__station?.state?.current?.sessionId === ${JSON.stringify(sid)}`, 40_000);
      await cdp.waitFor(label + ' ran-stack',
        `document.querySelector('#panes .pane.on .ran-stack') !== null`, 25_000);
      await sleep(700);
    };
    // B: switch to the other session (real same-document openSession).
    await switchTo(B, 'B');
    const bState = await cdp.eval(`(() => {
      const stack = document.querySelector('#panes .pane.on .ran-stack');
      return { open: !!stack.open, total: Number(stack.dataset.ranTotal || 0),
        viewing: window.__station?.state?.current?.sessionId ?? null };
    })()`);
    // A again: the SPA rebuilds A's transcript — the open choice must return.
    await switchTo(A, 'A-again');
    const aBack = await cdp.eval(`(() => {
      const stack = document.querySelector('#panes .pane.on .ran-stack');
      return { open: !!stack.open, total: Number(stack.dataset.ranTotal || 0),
        viewing: window.__station?.state?.current?.sessionId ?? null };
    })()`);
    check('A starts COLLAPSED by default, and a click expands it',
      aStart.collapsed === true && aStart.openAfterClick === true, aStart);
    check('switching to session B shows B COLLAPSED — the expansion does NOT leak across sessions',
      bState.open === false && bState.viewing === B, bState);
    check('switching BACK to A restores A’s EXPANDED state after the SPA rebuild (was lost in r2 — P3c)',
      aBack.open === true && aBack.viewing === A, aBack);
  }

  cdp.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exitCode = 1;
}).finally(() => {
  stopByPid(browser);
  stopByPid(server);
  setTimeout(() => {
    for (const d of cleanupDirs) fs.rmSync(d, { recursive: true, force: true });
    process.exit(process.exitCode ?? 0);
  }, 2500);
});
