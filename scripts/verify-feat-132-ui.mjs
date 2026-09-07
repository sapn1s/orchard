/**
 * FEAT-132 (UI) — LIVE VISUAL PROOF of the "Session configuration" card.
 *
 *   node scripts/verify-feat-132-ui.mjs
 *
 * The card is a collapsed section pinned above the first turn of a session
 * transcript, showing what was injected into that session's context at launch
 * (session-config.ts writes the record; public/app.js#mountSessionConfigCard
 * renders it). This script boots the REAL server against throwaway data/config
 * dirs, seeds ONE rich session (with a TRUNCATED source carrying droppedChars,
 * a MISSING source, and a spread of applied/best-effort sources) plus ONE
 * session with a transcript but NO config record (to prove the partial card),
 * drives brave --headless=new over raw CDP, and captures both themes.
 *
 * Theme is CDP Emulation.setEmulatedMedia prefers-color-scheme. Ports are
 * OS-assigned; :4317 is never touched. Every process is one this script
 * spawned and is stopped by PID. No product code is modified; screenshots land
 * in the repo root as feat132-*.png.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const BRAVE = process.env.VERIFY_BROWSER ?? 'brave';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

const RICH_ID = 'feat132-sess-rich-0001';
const PARTIAL_ID = 'feat132-sess-partial-0002';
// R2 (design-critic defect 1): a session whose ONLY warned source is TRUNCATED
// (no missing) must show an AMBER head marker, distinct from the rich session's
// BRICK marker (which carries a missing source). The two collapsed heads side by
// side are the visual proof that missing != truncated at a glance.
const TRUNC_ID = 'feat132-sess-trunc-0003';

const encodeCwd = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

const WA_BODY = [
  '# Working Agreement (v2)', '',
  ...Array.from({ length: 40 }, (_, i) => `- Rule ${i + 1}: verify the user's reality, not just the mechanism; prove a must-FAIL before the fix; keep honest counts.`),
].join('\n');
const TRUNCATED_BODY = [
  '⚠ TRUNCATED — this source was cut to fit its cap (BUG-146). 7210 characters',
  'of docs/CONVENTIONS.md were NOT injected into this session. What follows is',
  'only the head that fit:', '',
  '## Conventions (head)', '',
  ...Array.from({ length: 12 }, (_, i) => `- Convention ${i + 1}: file-only needs a real reason; board tickets are append-only.`),
].join('\n');

const RICH_RECORD = {
  projectId: null, // filled after project registration
  mode: 'append',
  model: 'claude-opus-4-8',
  provider: 'anthropic',
  isolation: 'container',
  sources: [
    { id: 'wa', label: 'Working Agreement', status: 'applied', chars: WA_BODY.length, body: WA_BODY },
    { id: 'conv', label: 'Conventions', status: 'applied', chars: 2400, body: '# docs/CONVENTIONS.md\n\n- Project-specific rules that are not universal.\n- Delegate; digest-first replies.' },
    { id: 'routing', label: 'Routing', status: 'applied', chars: 1600, body: '# ROUTING\n\nProvider routing: anthropic default; openai via vrun harness-side.' },
    { id: 'respfmt', label: 'Response format', status: 'applied', chars: 900, body: '# Response format\n\nNo emojis. Digest + <=120 words. Every sentence earns its place.' },
    { id: 'conv-extra', label: 'Conventions (extended)', status: 'truncated', chars: 4000, droppedChars: 7210, body: TRUNCATED_BODY },
    { id: 'skills-doc', label: 'Skills catalog', status: 'missing', chars: 0, body: '', note: 'referenced but could not be read at launch' },
    { id: 'board', label: 'Board snapshot', status: 'applied', chars: 3100, body: '# Board snapshot\n\nOpen: FEAT-132, BUG-146.\nDone: FEAT-127, BUG-163.' },
    { id: 'mcp', label: 'MCP servers', status: 'applied', chars: 200, body: 'serena — symbol tools + memories.' },
    { id: 'claudemd', label: 'CLAUDE.md', status: 'best-effort', chars: 0, body: '', note: 'injected by the CLI; Orchard does not own its content' },
  ],
  tools: ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'Task', 'WebFetch'],
  mcpServers: ['serena'],
};

// Truncated-only: no missing source, so the collapsed marker must be AMBER.
const TRUNC_RECORD = {
  projectId: null,
  mode: 'append',
  model: 'claude-opus-4-8',
  provider: 'anthropic',
  isolation: 'container',
  sources: [
    { id: 'wa', label: 'Working Agreement', status: 'applied', chars: WA_BODY.length, body: WA_BODY },
    { id: 'conv-extra', label: 'Conventions (extended)', status: 'truncated', chars: 4000, droppedChars: 7210, body: TRUNCATED_BODY },
    { id: 'claudemd', label: 'CLAUDE.md', status: 'best-effort', chars: 0, body: '', note: 'injected by the CLI; Orchard does not own its content' },
  ],
  tools: ['Bash', 'Read', 'Edit'],
  mcpServers: ['serena'],
};

/* ── transcript seeding ── */
function writeTranscript(storeRoot, encodedDir, sessionId, firstUser) {
  const dir = path.join(storeRoot, encodedDir);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    { type: 'user', message: { role: 'user', content: firstUser } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'On it — reading the importer now.' }] } },
    { type: 'user', message: { role: 'user', content: 'Thanks. Make sure the truncation is visible.' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done. The card marks the truncated and missing sources.' }] } },
  ];
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

/* ── infra ── */
const procs = [];
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}
async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const c = new Cdp(ws);
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.id && c.waiting.has(m.id)) { const { res, rej } = c.waiting.get(m.id); c.waiting.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    });
    return c;
  }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.waiting.set(id, { res, rej })); }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  }
  async waitFor(label, expr, timeoutMs = 30000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) { try { if (await this.eval(expr)) return true; } catch { /* mid-nav */ } await sleep(150); }
    console.log(`        (timed out waiting for ${label})`);
    return false;
  }
  async theme(tone) { await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: tone }] }); }
  async viewport(width, height) { await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

let cdp = null, browser = null, server = null;
const shots = [];

async function shot(name, minKb = 8) {
  const file = path.join(ROOT, name);
  await cdp.shot(file);
  const kb = fs.statSync(file).size / 1024;
  check(`  capture ${name} (non-blank, > ${minKb}KB)`, kb > minKb, `${kb.toFixed(1)} KB → ${file}`);
  shots.push(file);
  return file;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feat132-verify-'));
  const DATA = path.join(tmp, 'data');
  const CFG = path.join(tmp, 'cfg');
  const STORE = path.join(CFG, 'projects');
  const PROJ = path.join(tmp, 'proj');
  for (const d of [DATA, CFG, STORE, PROJ]) fs.mkdirSync(d, { recursive: true });

  // ── boot the real server ──
  const port = await freePort();
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_STATION_DATA: DATA, CLAUDE_CONFIG_DIR: CFG, CLAUDE_PROJECTS_DIR: STORE },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  procs.push(server);
  server.stderr?.on('data', (d) => { const s = String(d); if (/error|Error/.test(s)) process.stderr.write(`  [srv!] ${s}`); });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 160 && !up; i++) { try { await fetch(`${base}/api/health`); up = true; } catch { await sleep(250); } }
  check('the real server booted and answers /api/health', up, base);
  if (!up) throw new Error('server never became healthy');

  // ── register the project ──
  const reg = await (await fetch(`${base}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostPath: PROJ, name: 'FEAT-132 verify' }),
  })).json();
  const projectId = reg.project?.id;
  check('the scratch project registered', !!projectId, projectId ?? JSON.stringify(reg).slice(0, 160));
  if (!projectId) throw new Error('project registration failed');

  const encodedDir = encodeCwd(PROJ);

  // ── seed transcripts ──
  writeTranscript(STORE, encodedDir, RICH_ID, 'Fix the importer');
  writeTranscript(STORE, encodedDir, PARTIAL_ID, 'This one predates the feature');
  writeTranscript(STORE, encodedDir, TRUNC_ID, 'Truncated conventions only');

  // ── write the rich config record (same DATA dir the server reads) ──
  process.env.CLAUDE_STATION_DATA = DATA;
  const { recordSessionConfig } = await import(path.join(ROOT, 'src', 'server', 'session-config.ts'));
  const wrote = recordSessionConfig(RICH_ID, { ...RICH_RECORD, projectId });
  check('recordSessionConfig wrote the rich record', wrote === true, `wrote=${wrote}`);
  const wroteTrunc = recordSessionConfig(TRUNC_ID, { ...TRUNC_RECORD, projectId });
  check('recordSessionConfig wrote the truncated-only record', wroteTrunc === true, `wrote=${wroteTrunc}`);

  // ── the API carries the record for the rich session, 404 for the partial one ──
  const apiRich = await fetch(`${base}/api/session-config/${RICH_ID}`);
  const recBack = apiRich.ok ? await apiRich.json() : null;
  check('GET /api/session-config/<rich> returns 200 with the record',
    apiRich.status === 200 && recBack?.sessionId === RICH_ID
      && recBack.sources.some((s) => s.status === 'truncated' && s.droppedChars === 7210)
      && recBack.sources.some((s) => s.status === 'missing'),
    JSON.stringify({ status: apiRich.status, sources: recBack?.sources?.length, statuses: recBack?.sources?.map((s) => s.status) }));
  const apiPartial = await fetch(`${base}/api/session-config/${PARTIAL_ID}`);
  check('GET /api/session-config/<partial> returns 404 (no record)', apiPartial.status === 404, `status=${apiPartial.status}`);

  // ── browser ──
  const profile = path.join(tmp, 'chrome');
  fs.mkdirSync(profile, { recursive: true });
  browser = spawn(BRAVE, [
    '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--no-first-run', '--disable-extensions', '--window-size=1400,1000', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  procs.push(browser);
  let devPort = 0;
  for (let i = 0; i < 120 && !devPort; i++) {
    try { devPort = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(250); }
  }
  if (!devPort) throw new Error('browser never wrote DevToolsActivePort');
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  cdp = await Cdp.connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.viewport(1400, 1000);

  const richUrl = `${base}/#/project/${encodeURIComponent(projectId)}/session/${encodeURIComponent(RICH_ID)}?dir=${encodedDir}`;
  const partialUrl = `${base}/#/project/${encodeURIComponent(projectId)}/session/${encodeURIComponent(PARTIAL_ID)}?dir=${encodedDir}`;
  const truncUrl = `${base}/#/project/${encodeURIComponent(projectId)}/session/${encodeURIComponent(TRUNC_ID)}?dir=${encodedDir}`;

  // Probe helper: computed color of a live element vs the two board tints, so a
  // check can assert the marker took the RIGHT token (brick vs amber), not just
  // that it is coloured. Resolves the CSS vars against a throwaway probe node.
  const warnSevProbe = (sel) => `(() => {
    const w = document.querySelector(${JSON.stringify(sel)});
    if (!w) return null;
    const probe = document.createElement('span');
    document.body.appendChild(probe);
    probe.style.color = 'var(--st-high)'; const brick = getComputedStyle(probe).color;
    probe.style.color = 'var(--st-needs)'; const amber = getComputedStyle(probe).color;
    probe.remove();
    const actual = getComputedStyle(w).color;
    return { sev: w.getAttribute('data-sev'), actual, brick, amber,
      isBrick: actual === brick, isAmber: actual === amber };
  })()`;

  /* ══════════ RICH SESSION ══════════ */
  console.log('\n=== RICH session: the card is present, collapsed by default ===');
  await cdp.theme('dark');
  await cdp.send('Page.navigate', { url: richUrl });
  const cardUp = await cdp.waitFor('.sesscfg', `!!document.querySelector('.sesscfg')`);
  check('the .sesscfg card is present on the rich session', cardUp, `${cardUp}`);

  const collapsed = await cdp.eval(`(() => {
    const c = document.querySelector('.sesscfg');
    const body = c && c.querySelector('.sc-body');
    return { dataOpen: c?.getAttribute('data-open'), bodyHidden: body ? body.hidden : null,
      hasHead: !!c?.querySelector('.sc-head'), aria: c?.querySelector('.sc-head')?.getAttribute('aria-expanded') };
  })()`);
  check('collapsed by default: data-open="false", .sc-body hidden, head aria-expanded="false"',
    collapsed.dataOpen === 'false' && collapsed.bodyHidden === true && collapsed.hasHead && collapsed.aria === 'false',
    JSON.stringify(collapsed));

  // the warn marker is in the head (2 sources truncated/missing)
  const warn = await cdp.eval(`(() => { const w = document.querySelector('.sesscfg .sc-head .sc-warn'); return w ? w.textContent : null; })()`);
  check('the .sc-warn marker is present in the head (truncated/missing sources)', typeof warn === 'string' && warn.includes('⚠'), JSON.stringify(warn));

  // DEFECT 1 regression: the rich session carries a MISSING source, so the head
  // marker must take the BRICK tint (--st-high), NOT amber (--st-needs). Before
  // the fix .sc-warn was unconditionally amber → this check must FAIL pre-fix.
  const richSev = await cdp.eval(warnSevProbe('.sesscfg .sc-head .sc-warn'));
  check('rich head marker uses the BRICK tint (a source is MISSING), not amber',
    !!richSev && richSev.sev === 'missing' && richSev.isBrick && !richSev.isAmber, JSON.stringify(richSev));

  await shot('feat132-r2-collapsed-missing-dark.png');
  await cdp.theme('light');
  await sleep(200);
  await shot('feat132-r2-collapsed-missing-light.png');

  /* ── expand ── */
  console.log('\n=== RICH session: expand the card, chips visible ===');
  await cdp.eval(`document.querySelector('.sesscfg .sc-head').click()`);
  await cdp.waitFor('expanded', `document.querySelector('.sesscfg')?.getAttribute('data-open') === 'true'`);
  const chipInfo = await cdp.eval(`(() => {
    const c = document.querySelector('.sesscfg');
    const body = c.querySelector('.sc-body');
    const chips = [...c.querySelectorAll('.sc-chip')].map((ch) => ({
      status: ch.getAttribute('data-status'),
      label: ch.querySelector('.sc-lbl')?.textContent ?? null,
      bad: ch.querySelector('.sc-bad')?.textContent ?? null,
    }));
    return { bodyHidden: body.hidden, count: chips.length, chips };
  })()`);
  check('after clicking head: .sc-body shown and .sc-chips populated', chipInfo.bodyHidden === false && chipInfo.count > 0, JSON.stringify({ bodyHidden: chipInfo.bodyHidden, count: chipInfo.count }));
  const truncChip = chipInfo.chips.find((c) => c.status === 'truncated');
  check('a chip with [data-status="truncated"] exists and its .sc-bad text contains "truncated"',
    !!truncChip && String(truncChip.bad).toLowerCase().includes('truncated'), JSON.stringify(truncChip));
  const missChip = chipInfo.chips.find((c) => c.status === 'missing');
  check('a chip with [data-status="missing"] exists', !!missChip, JSON.stringify(missChip));

  // DEFECT 2 regression: the best-effort badge must read as a QUALIFIER word, not
  // a bare '?' (which reads like a help affordance next to CLAUDE.md).
  const beChip = chipInfo.chips.find((c) => c.status === 'best-effort');
  check('the best-effort badge is a qualifier word, not a bare "?"',
    !!beChip && beChip.bad != null && beChip.bad !== '?' && /[a-z]/i.test(String(beChip.bad)),
    JSON.stringify(beChip));

  await cdp.theme('light');
  await sleep(200);
  await shot('feat132-r2-expanded-light.png');
  await cdp.theme('dark');
  await sleep(200);
  await shot('feat132-r2-expanded-dark.png');

  /* ── click the truncated chip → body shows in .sc-src ── */
  console.log('\n=== RICH session: click the TRUNCATED chip, body shows in .sc-src ===');
  await cdp.eval(`(() => {
    const chip = [...document.querySelectorAll('.sesscfg .sc-chip')].find((c) => c.getAttribute('data-status') === 'truncated');
    chip.scrollIntoView({ block: 'center' }); chip.click();
  })()`);
  await cdp.waitFor('.sc-src filled', `(() => { const s = document.querySelector('.sesscfg .sc-src'); return s && !s.hidden && /TRUNCATED/.test(s.textContent); })()`);
  const srcText = await cdp.eval(`(() => { const s = document.querySelector('.sesscfg .sc-src'); return { hidden: s?.hidden, text: s?.textContent ?? '' }; })()`);
  check('clicking the truncated chip fills .sc-src with text containing "TRUNCATED"',
    srcText.hidden === false && /TRUNCATED/.test(srcText.text), JSON.stringify({ hidden: srcText.hidden, head: srcText.text.slice(0, 70) }));
  // both marked chips still visibly marked
  const stillMarked = await cdp.eval(`(() => {
    const t = document.querySelector('.sesscfg .sc-chip[data-status="truncated"] .sc-bad');
    const m = document.querySelector('.sesscfg .sc-chip[data-status="missing"] .sc-bad');
    return { trunc: t?.textContent ?? null, miss: m?.textContent ?? null };
  })()`);
  check('the truncated + missing chips remain visibly marked while the body shows',
    String(stillMarked.trunc).toLowerCase().includes('truncated') && !!stillMarked.miss, JSON.stringify(stillMarked));

  await cdp.theme('light');
  await sleep(200);
  await shot('feat132-r2-truncated-light.png');

  /* ══════════ TRUNCATED-ONLY SESSION (amber head, contrast to brick) ══════════ */
  console.log('\n=== TRUNCATED-only session: head marker is AMBER, distinct from brick ===');
  await cdp.theme('dark');
  await cdp.send('Page.navigate', { url: truncUrl });
  await cdp.waitFor('trunc .sesscfg', `!!document.querySelector('.sesscfg .sc-head .sc-warn')`);
  const truncSev = await cdp.eval(warnSevProbe('.sesscfg .sc-head .sc-warn'));
  check('truncated-only head marker uses the AMBER tint (no missing source), not brick',
    !!truncSev && truncSev.sev === 'truncated' && truncSev.isAmber && !truncSev.isBrick, JSON.stringify(truncSev));
  check('the two heads take DIFFERENT tints (missing brick != truncated amber)',
    !!richSev && !!truncSev && richSev.actual !== truncSev.actual,
    JSON.stringify({ missing: richSev?.actual, truncated: truncSev?.actual }));

  await shot('feat132-r2-collapsed-truncated-dark.png');
  await cdp.theme('light');
  await sleep(200);
  await shot('feat132-r2-collapsed-truncated-light.png');

  /* ══════════ PARTIAL SESSION ══════════ */
  console.log('\n=== PARTIAL session (no record): the labelled partial card ===');
  await cdp.send('Page.navigate', { url: partialUrl });
  await cdp.waitFor('partial .sesscfg', `!!document.querySelector('.sesscfg')`);
  // give the fire-and-forget fetch time to resolve to the no-record branch
  await cdp.waitFor('partial note', `!!document.querySelector('.sesscfg .sc-note') || document.querySelectorAll('.sesscfg .sc-chip').length > 0`, 15000);
  const partial = await cdp.eval(`(() => {
    const c = document.querySelector('.sesscfg');
    return {
      present: !!c,
      note: c?.querySelector('.sc-note') ? c.querySelector('.sc-note').textContent.slice(0, 60) : null,
      sub: c?.querySelector('.sc-sub')?.textContent ?? null,
      chips: c ? c.querySelectorAll('.sc-chip').length : -1,
    };
  })()`);
  check('partial: .sesscfg present with a .sc-note and NO chips', partial.present && !!partial.note && partial.chips === 0, JSON.stringify(partial));
  check('partial: the head sub-label reads "not recorded"', partial.sub === 'not recorded', JSON.stringify(partial.sub));

  await cdp.theme('light');
  await sleep(200);
  await shot('feat132-r2-partial-light.png');

  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} passed, ${fail} failed`);
  if (fail) console.log(failures.map((f) => `  · ${f}`).join('\n'));
  console.log('\nscreenshots:');
  for (const s of shots) console.log(`  ${s}`);
}

try {
  await main();
} catch (err) {
  console.error(`\nHARNESS ERROR: ${err.stack || err.message}`);
  fail++;
} finally {
  cdp?.close();
  for (const p of procs) stopByPid(p);
  await sleep(400);
  process.exit(fail ? 1 : 0);
}
