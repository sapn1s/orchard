/**
 * BUG-168 — a "[station] While you were away…" briefing is PREPENDED to the user's
 * typed prompt and the CLI writes ONE role:user JSONL entry (briefing first, the
 * human's words last). The transcript renderer matched the '[station]' sentinel at
 * position 0 and swallowed the WHOLE entry into a collapsed notice chip, so the
 * human's own sentence was invisible on any re-read. The fix terminates the
 * injected prefix with a self-delimiting sentinel (server) and peels it (client):
 * the prefix collapses into the chip, the REMAINDER renders as the user's bubble.
 * Legacy entries (written before the sentinel existed) are split heuristically.
 *
 *   node scripts/verify-bug-168-briefing-user-words.mjs
 *
 * Like verify:bug-067 this drives a REAL browser (brave --headless=new over raw
 * CDP) against a REAL server, then renders fixtures through the app's OWN renderer
 * (both the live-follow applyAppend path AND the history renderMessages path) and
 * asserts on the resulting DOM. No CLI turn is spawned.
 *
 * The four required cases, each rendered through the real renderer:
 *   1. NEW-format entry     — briefing + TERMINATOR + user words → chip + bubble.
 *   2. LEGACY entry         — the REAL cited transcript's own two user
 *                             turns (first-turn-with-board AND follow-up), read off
 *                             disk → chip + bubble carrying the user's real words.
 *   3. BRIEFING-ONLY entry  — briefing + TERMINATOR + "" (empty remainder) → chip
 *                             ONLY, no empty bubble (requirement 4).
 *   4. MID-PROSE "[station]" — a real message whose BODY contains "[station]"
 *                             mid-sentence stays intact in its bubble, never
 *                             re-collapsed.
 *
 * Must-FAIL pre-fix: on the pre-fix client the NEW-format and LEGACY entries render
 * as a notice with NO user bubble (the user's words vanish) — the reported symptom.
 * Toggle the fix off (neuter harnessNotice's peel) and cases 1 + 2 go red; that is
 * how the must-FAIL was demonstrated (see the ticket's Activity log).
 *
 * A separate DRIFT guard asserts the server's BRIEFING_TERMINATOR literal (read
 * from src/server/agent-bridge.ts) equals the client's window.__station copy —
 * the two are duplicated by necessity (browser file cannot import a server module)
 * and MUST stay byte-identical or the peel silently stops matching.
 *
 * Process hygiene: OS-assigned free port (never 4317). Kill children by PID only,
 * never pkill.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const PORT = Number(process.env.VERIFY_BUG_168_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b168-data-'));
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b168-store-'));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-b168-chrome-'));
const BRAVE = process.env.VERIFY_BUG_168_BROWSER ?? 'brave';

// The REAL transcript the ticket cites. Derived from os.homedir() at RUNTIME
// (never a literal home path — that would be a home-path/username leak in a
// committed file). The project's location under the home dir is a neutral
// placeholder here; point it at the real project with VERIFY_BUG_168_PROJECT
// (a home-relative path), or bypass the derivation entirely with
// VERIFY_BUG_168_TRANSCRIPT. The Claude projects store encodes a project's
// hostPath by replacing '/' and '_' with '-'.
const REAL_PROJECT_REL = process.env.VERIFY_BUG_168_PROJECT ?? path.join('sample_projects', 'example-project');
const REAL_HOSTPATH = path.join(os.homedir(), REAL_PROJECT_REL);
const REAL_ENCODED_DIR = REAL_HOSTPATH.replace(/[/_]/g, '-');
const REAL_TRANSCRIPT = process.env.VERIFY_BUG_168_TRANSCRIPT
  ?? path.join(os.homedir(), '.claude', 'projects', REAL_ENCODED_DIR, 'a1a2ea7f-dd03-4140-8232-5377255f4c83.jsonl');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  ok ? pass++ : (fail++, failures.push(name));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------- server's terminator literal */
// Read the ONE authoritative literal from the server source (not re-typed here),
// so the drift guard actually compares the server's value to the client's.
function serverTerminator() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'server', 'agent-bridge.ts'), 'utf8');
  const m = /BRIEFING_TERMINATOR\s*=\s*'([^']+)'/.exec(src);
  return m ? m[1] : null;
}
const SERVER_TERM = serverTerminator();

/* ---------------------------------------------------- realistic briefing prose */
// Synthetic (the NEW format did not exist before this fix, so no real new-format
// transcript exists yet) but mirrors takeBriefing()/boardStateSection() output.
const STATION_BRIEF =
  '[station] While you were away: 3 agent/turns ended since your last turn (3 events).\n' +
  '  - local_bash (Day econ JSON with SEs) — failed: the engine reported this agent failed [2026-09-06T17:41:57.526Z]\n' +
  '  - local_bash (Fetch VPS copies and diff) — failed: the engine reported this agent failed [2026-09-06T17:49:05.001Z]\n' +
  '[station] This is a server-recorded fact, not a request — it is ADVISORY: corroborate (transcripts, commits, the rail) before abandoning or re-dispatching work on the strength of it.';

/* ------------------------------------------------------------- raw CDP client */
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
      try { if (await this.eval(expr)) return true; } catch { /* mid-navigation */ }
      await sleep(150);
    }
    console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
    return false;
  }
  close() { try { this.ws.close(); } catch { /* already gone */ } }
}

/* ------------------------------------------------------------- processes */
let server = null, browser = null;
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

/* ------------------------------------------------------------- real legacy fixtures */
// Pull the two SPECIFIC real user turns the ticket cites off the user's own
// transcript — the ground-truth user words are known, so we can assert the peel
// recovered EXACTLY them (not a hardcoded value that would break when the user
// keeps using the product). line 853 is a first-turn-with-board briefing whose
// user words are "…what was porogress today…"; line 867 a follow-up (no board)
// whose words are "how comes no good startegies…".
const LEGACY_BOARD_MARK = 'so its been another day, what was porogress today';
const LEGACY_FOLLOWUP_MARK = 'how comes no good startegies';
function realLegacyEntries() {
  let raw;
  try { raw = fs.readFileSync(REAL_TRANSCRIPT, 'utf8').split('\n').filter(Boolean); } catch { return {}; }
  const users = [];
  for (const ln of raw) {
    let o; try { o = JSON.parse(ln); } catch { continue; }
    const c = o?.message?.content;
    if (o?.type === 'user' && typeof c === 'string'
        && c.replace(/^\s+/, '').startsWith('[station]')
        && c.includes('[station] This is a server-recorded fact')) {
      users.push(c);
    }
  }
  const withBoard = users.find((c) => c.includes('# Project state (live board snapshot)') && c.includes(LEGACY_BOARD_MARK));
  const followUp = users.find((c) => !c.includes('# Project state (live board snapshot)') && c.includes(LEGACY_FOLLOWUP_MARK));
  return { withBoard, followUp };
}

async function main() {
  if (!SERVER_TERM) throw new Error('could not read BRIEFING_TERMINATOR from src/server/agent-bridge.ts');
  const legacy = realLegacyEntries();
  if (!legacy.withBoard || !legacy.followUp) {
    console.log(`  NOTE: real transcript ${REAL_TRANSCRIPT} lacks both legacy shapes; legacy case falls back to skip.`);
  }

  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('server never became healthy');

  browser = spawn(BRAVE, [
    '--headless=new', `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', '--window-size=1280,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort = 0;
  for (let i = 0; i < 60 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  if (!devPort) throw new Error('browser never wrote DevToolsActivePort');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const pageT = targets.find((t) => t.type === 'page');
  const cdp = await Cdp.connect(pageT.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  const booted = await cdp.waitFor('app boot', 'window.__station && !!window.__station.renderMessages', 30_000);
  if (!booted) throw new Error('app never booted in the page');

  /* ---- DRIFT guard: server literal === client literal ---- */
  const clientTerm = await cdp.eval('window.__station.BRIEFING_TERMINATOR');
  check('terminator literal is byte-identical server↔client', clientTerm === SERVER_TERM, { server: SERVER_TERM, client: clientTerm });

  // Build the fixtures. Body sentences are DISTINCT so we can assert each appears
  // as its own bubble. NEW-format body deliberately EMBEDS "[station]" mid-prose
  // (covers required case 4 inside the peeled remainder too).
  const NEW_BODY = 'so about the [station] briefings — what was progress today, anything nice discovered?';
  const NEW = `${STATION_BRIEF}\n\n${SERVER_TERM}\n\n${NEW_BODY}`;
  const BRIEF_ONLY = `${STATION_BRIEF}\n\n${SERVER_TERM}\n\n`;
  const MIDPROSE = 'Why does a [station] tag show up in the middle of my sentence here?';

  const fixtures = [
    { role: 'user', index: 0, blocks: [{ type: 'text', text: NEW }] },          // new-format → chip + bubble
    { role: 'user', index: 1, blocks: [{ type: 'text', text: BRIEF_ONLY }] },   // briefing-only → chip, no bubble
    { role: 'user', index: 2, blocks: [{ type: 'text', text: MIDPROSE }] },     // mid-prose → bubble
  ];
  if (legacy.withBoard) fixtures.push({ role: 'user', index: fixtures.length, blocks: [{ type: 'text', text: legacy.withBoard }] });
  if (legacy.followUp) fixtures.push({ role: 'user', index: fixtures.length, blocks: [{ type: 'text', text: legacy.followUp }] });

  const CLASSIFY = `(() => {
    const S = window.__station;
    const pane = document.createElement('section');
    pane.className = 'pane'; pane.dataset.thread = 'main';
    document.getElementById('panes').appendChild(pane);
    const th = { key: 'h', kind: 'main', paneEl: pane, claudeBody: null, stream: null, tools: new Map() };
    S.renderMessages(th, ${JSON.stringify(fixtures)});
    const kids = [...pane.children];
    const bubbles = kids.filter((k) => k.classList.contains('you'));
    const notices = kids.filter((k) => k.classList.contains('notice'));
    return {
      seq: kids.map((k) => k.classList.contains('you') ? 'bubble' : k.classList.contains('notice') ? 'notice' : k.className).filter(Boolean),
      bubbleCount: bubbles.length,
      noticeCount: notices.length,
      bubbleText: bubbles.map((b) => b.textContent.trim()),
      noticeOneLiners: notices.map((n) => n.querySelector('summary .nl')?.textContent ?? ''),
      noticeFull: notices.map((n) => n.querySelector('.notice-full')?.textContent ?? ''),
      noticeIsDetails: notices.every((n) => n.tagName === 'DETAILS'),
    };
  })()`;

  console.log('\n=== HISTORY path (renderMessages) ===');
  const c = await cdp.eval(CLASSIFY);
  runAssertions('history', c, legacy);

  // The live-follow path converges on the same renderMessages via applyAppend.
  console.log('\n=== LIVE-FOLLOW path (applyAppend -> renderMessages) ===');
  const live = await cdp.eval(`(() => {
    const S = window.__station;
    S.state.threads.delete('main');
    document.querySelectorAll('#panes .pane[data-thread="main"]').forEach((p) => p.remove());
    S.state.live = false;
    S.state.current.sessionId = 'fixture-b168';
    S.state.current.encodedDir = null;
    S.applyAppend({ sessionId: 'fixture-b168', messages: ${JSON.stringify(fixtures)} });
    const pane = document.querySelector('#panes .pane[data-thread="main"]');
    if (!pane) return { error: 'no pane' };
    const kids = [...pane.children];
    const bubbles = kids.filter((k) => k.classList.contains('you'));
    const notices = kids.filter((k) => k.classList.contains('notice'));
    return {
      seq: kids.map((k) => k.classList.contains('you') ? 'bubble' : k.classList.contains('notice') ? 'notice' : null).filter(Boolean),
      bubbleCount: bubbles.length, noticeCount: notices.length,
      bubbleText: bubbles.map((b) => b.textContent.trim()),
    };
  })()`);
  if (live.error) check('live-follow pane materialised', false, live);
  else {
    check('[live] the two render paths agree on bubble/notice split',
      JSON.stringify(live.seq) === JSON.stringify(c.seq), { live: live.seq, history: c.seq });
    check('[live] user words survive on the live path too',
      live.bubbleText.some((t) => t.includes('what was progress today')), live.bubbleText);
  }

  cdp.close();
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : 0;
}

function runAssertions(tag, c, legacy) {
  // Case 1 — NEW-format: the user's words become their own bubble (and the
  // embedded mid-prose "[station]" is preserved, not re-collapsed).
  check(`[${tag}] NEW-format user words render as a bubble`,
    c.bubbleText.some((t) => t.includes('what was progress today, anything nice discovered')), c.bubbleText);
  check(`[${tag}] NEW-format bubble keeps its mid-prose "[station]"`,
    c.bubbleText.some((t) => t.includes('[station] briefings')), c.bubbleText);
  check(`[${tag}] NEW-format prefix collapsed into a [station] notice`,
    c.noticeOneLiners.some((o) => o.startsWith('⚙') && o.includes('While you were away')), c.noticeOneLiners);
  check(`[${tag}] NEW-format notice does NOT swallow the user's words`,
    c.noticeFull.every((f) => !f.includes('what was progress today')), c.noticeFull.map((f) => f.slice(-60)));

  // Case 3 — BRIEFING-ONLY: chip, and NO empty bubble for the empty remainder.
  check(`[${tag}] BRIEFING-ONLY renders no empty bubble`,
    !c.bubbleText.some((t) => t === ''), { bubbleText: c.bubbleText });

  // Case 4 — MID-PROSE: a message merely containing "[station]" stays a bubble.
  check(`[${tag}] MID-PROSE "[station]" message stayed a user bubble`,
    c.bubbleText.some((t) => t.includes('show up in the middle of my sentence')), c.bubbleText);

  // Case 2 — LEGACY (real transcript): the user's real words are recovered.
  if (legacy.withBoard) {
    check(`[${tag}] LEGACY first-turn(+board) user words recovered`,
      c.bubbleText.some((t) => t.includes('what was porogress today, anything nice discovered')), c.bubbleText);
    check(`[${tag}] LEGACY first-turn: board snapshot did NOT leak into the bubble`,
      !c.bubbleText.some((t) => t.includes('Project state (live board snapshot)')), c.bubbleText.map((t) => t.slice(0, 40)));
  }
  if (legacy.followUp) {
    check(`[${tag}] LEGACY follow-up user words recovered`,
      c.bubbleText.some((t) => t.includes('doesnt it imply we need to improve our startegy generation')), c.bubbleText);
  }

  // Overall shape: every fixture with user words produced exactly one bubble for them,
  // and each briefing produced a collapsed notice.
  const expectedBubbles = 2 /* new + midprose */ + (legacy.withBoard ? 1 : 0) + (legacy.followUp ? 1 : 0);
  check(`[${tag}] exactly ${expectedBubbles} user bubbles (one per real message; briefing-only makes none)`,
    c.bubbleCount === expectedBubbles, { bubbleCount: c.bubbleCount });
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
}).finally(() => {
  stopByPid(browser);
  stopByPid(server);
  setTimeout(() => {
    for (const d of [DATA, STORE, PROFILE]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
    process.exit(process.exitCode ?? 0);
  }, 1500);
});
