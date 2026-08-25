/** BUG-141: real Codex-rollout search, identity/locate, and partial-read proof. */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRATCH = process.env.BUG141_SCRATCH ?? path.join(os.homedir(), 'scratch', 'bug-141');
const CODEX_ROOT = process.env.BUG141_CODEX_ROOT ?? path.join(os.homedir(), '.codex', 'sessions');
const ENC = os.homedir().replace(/[/.]/g, '-'); // encoded cwd of these rollouts, derived (never hardcode a home path)
const CLAUDE_NEEDLE = process.env.BUG141_CLAUDE_NEEDLE ?? 'available only to approved organizations through Project Glasswing';

/*
 * FEAT-049 (privacy). This suite must run against REAL Codex rollouts — that is
 * the whole point of it, and a fixture would not have caught the defect. But the
 * rollouts it used to name were TWO SPECIFIC FILES on one machine, and the
 * search needles were literal phrases lifted out of their bodies: a client's
 * name, a product line, a German trade term. That put a stranger's-eyes-only
 * copy of someone's private work into a file headed for a public repository,
 * and no token-list gate could have seen it, because nobody knew the words were
 * there to list.
 *
 * So: discover the rollouts, and derive the needles FROM the rollout that is
 * found. The suite keeps its real-artifact property and stops carrying anyone's
 * content. With no rollouts present it skips loudly instead of failing.
 */
function findRollouts(root, want) {
  const out = [];
  const rec = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) rec(abs);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        const m = /^rollout-.*?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(e.name);
        if (m) out.push({ path: abs, sessionId: m[1], mtime: fs.statSync(abs).mtimeMs, size: fs.statSync(abs).size });
      }
    }
  };
  rec(root);
  // Biggest first: a substantial rollout has prose to derive a needle from.
  return out.sort((a, b) => b.size - a.size).slice(0, want);
}

/**
 * A search term this rollout actually contains as PROSE, chosen by asking the
 * product's own judge rather than by a human reading the transcript. Rare words
 * first, so the term is discriminating; the first one the judge calls prose wins.
 */
async function deriveProseNeedle(search, target, storeRoots = []) {
  const text = fs.readFileSync(target.path, 'utf8');
  const counts = new Map();
  for (const w of text.match(/[A-Za-z][A-Za-z]{6,18}/g) ?? []) counts.set(w, (counts.get(w) ?? 0) + 1);
  const rare = [...counts.entries()].sort((a, b) => a[1] - b[1]).map(([w]) => w).slice(0, 200);
  let anyProse = null;
  for (const w of rare) {
    const r = await search.searchStore(w, [target]);
    if (!r.hits.some((h) => h.kind === 'prose')) continue;
    anyProse ??= w;
    if (!storeRoots.length) return w;
    /*
     * Rare INSIDE the file is not rare across the store: a word used once here
     * can still be in a thousand transcripts, and then the rendered result list
     * is ninety sessions deep. Prefer a word that is scarce store-wide — but
     * PREFER, never require: a rarity filter that finds nothing would make this
     * suite skip silently, which is a false green, and false greens are exactly
     * what this ticket is about.
     */
    let files = [];
    try {
      files = execFileSync('rg', ['-l', '--fixed-strings', '--ignore-case', '--no-messages', '--glob', '*.jsonl', '--', w, ...storeRoots], { encoding: 'utf8', maxBuffer: 1 << 28 })
        .split('\n').filter(Boolean);
    } catch { continue; }
    if (files.length <= 8 && files.some((f) => path.resolve(f) === path.resolve(target.path))) return w;
  }
  return anyProse;
}

let pass = 0, fail = 0;
function check(name, ok, observed) { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${JSON.stringify(observed)}`); ok ? pass++ : fail++; }
const sleep = (n) => new Promise((r) => setTimeout(r, n));
async function freePort() { const net = await import('node:net'); return new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.on('message', (d) => { const m = JSON.parse(d); const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } }); }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject })); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); return r.result?.value; }
  async waitFor(expression, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await this.eval(expression).catch(() => false)) return true; await sleep(100); } return false; }
}

let server, browser, cdp;
try {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const search = await import('../src/server/search.ts');

  // Not every rollout has prose to derive from (a tool-only one has none), so
  // walk the candidates largest-first and keep the first two that yield one.
  const STORE_ROOTS = [CODEX_ROOT, path.join(os.homedir(), '.claude', 'projects')].filter((d) => fs.existsSync(d));
  const candidates = findRollouts(CODEX_ROOT, 12);
  const usable = [];
  for (const c of candidates) {
    if (usable.length === 2) break;
    const target = { path: c.path, encodedDir: ENC, sessionId: c.sessionId, format: 'codex-rollout' };
    const needle = await deriveProseNeedle(search, target, STORE_ROOTS);
    if (needle) usable.push({ ...c, target, needle });
  }
  if (usable.length < 2) {
    console.log(`SKIP verify-bug-141: needs two real Codex rollouts with prose under ${CODEX_ROOT} (usable ${usable.length} of ${candidates.length}). Set BUG141_CODEX_ROOT to a store that has them.`);
    process.exit(0);
  }
  const [first, secondRollout] = usable;
  const ROLLOUT = first.path;
  const SID = first.sessionId;
  const firstTarget = first.target;
  const secondTarget = secondRollout.target;
  const CODEX_NEEDLE = first.needle;
  const SECOND_NEEDLE = secondRollout.needle;
  console.log(`  using rollouts ${SID} and ${secondRollout.sessionId} (discovered, largest-first)`);
  check('a prose needle is derivable from the first real rollout', typeof CODEX_NEEDLE === 'string', { derived: typeof CODEX_NEEDLE === 'string' });
  check('a prose needle is derivable from a SECOND, independent real rollout', typeof SECOND_NEEDLE === 'string' && secondRollout.sessionId !== SID, { derived: typeof SECOND_NEEDLE === 'string' });

  const full = fs.readFileSync(ROLLOUT);
  const direct = await search.searchStore(CODEX_NEEDLE, [firstTarget]);
  check('real rollout judge keeps body matches with canonical identity', direct.hits.length > 0 && direct.hits.every((h) => h.sessionId === SID && h.encodedDir === ENC), direct.hits.map((h) => ({ line: h.line, kind: h.kind })));
  const chosen = direct.hits.find((h) => h.kind === 'prose') ?? direct.hits[0];
  const located = await search.locateCodex(ROLLOUT, chosen.line);
  check('real rollout locate produces an exact canonical message index', located?.exact === true && located.index >= 0, located);
  const second = await search.searchStore(SECOND_NEEDLE, [secondTarget]);
  check('an independent term from a different real rollout is kept', second.hits.some((h) => h.kind === 'prose'), second.hits.map((h) => ({ line: h.line, kind: h.kind })));

  const cutPoints = [Math.floor(full.length * .2), Math.floor(full.length * .6), full.length - 17];
  for (const [i, cut] of cutPoints.entries()) {
    const f = path.join(SCRATCH, `partial-${i}.jsonl`); fs.writeFileSync(f, full.subarray(0, cut));
    // Any term does here: the assertion is "a truncated rollout is searchable
    // without crashing", not that this term is present.
    const r = await search.searchStore(CODEX_NEEDLE, [{ path: f, encodedDir: ENC, sessionId: SID, format: 'codex-rollout' }]);
    check(`partial rollout ${i + 1} is searchable without crashing`, Array.isArray(r.hits), { cut, hits: r.hits.length });
  }

  const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  const data = path.join(SCRATCH, 'data'); fs.rmSync(data, { recursive: true, force: true });
  server = spawn(process.execPath, ['src/server/index.ts'], { cwd: ROOT, env: { ...process.env, PORT: String(port), CLAUDE_STATION_DATA: data }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await sleep(100); }
  for (const [hostPath, name] of [[os.homedir(), 'Home'], [ROOT, 'Orchard']]) await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath, name }) });
  const api = await (await fetch(`${base}/api/search?q=${encodeURIComponent(CODEX_NEEDLE)}`)).json();
  const hit = api.hits?.find((h) => h.sessionId === SID);
  check('real all-project API returns the independent Codex body needle', !!hit && hit.encodedDir === ENC, hit);
  const scoped = await (await fetch(`${base}/api/search?q=${encodeURIComponent(CODEX_NEEDLE)}&project=orchard`)).json();
  check('single-project scope excludes a Codex session from another cwd', scoped.hits?.every((h) => h.sessionId !== SID), { hits: scoped.hits?.length });

  const profile = path.join(SCRATCH, 'brave-profile'); fs.rmSync(profile, { recursive: true, force: true });
  browser = spawn(process.env.VERIFY_ROUTING_BROWSER ?? 'brave', ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--disable-extensions', '--window-size=1440,1000', base], { stdio: ['ignore', 'ignore', 'pipe'] });
  let devPort; for (let i = 0; i < 100 && !devPort; i++) { try { devPort = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(100); } }
  const pages = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json(); const ws = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl); await new Promise((r) => ws.once('open', r)); cdp = new Cdp(ws); await cdp.send('Page.enable');
  await cdp.waitFor(`window.__station&&document.querySelector('#findInput')`);
  await cdp.eval(`findInput.value=${JSON.stringify(CODEX_NEEDLE)};findInput.dispatchEvent(new Event('input'))`);
  const shown = await cdp.waitFor(`[...document.querySelectorAll('.cs-hit mark')].some(x=>x.textContent===${JSON.stringify(CODEX_NEEDLE)})`, 40000);
  check('rendered UI shows the Codex body-only result with tools shown', shown, await cdp.eval(`document.body.innerText.includes('tool output shown')`));
  await cdp.eval(`document.querySelector('.cs-pill:last-child').click()`);
  check('tool-output-hidden mode remains usable', await cdp.waitFor(`document.body.innerText.includes('tool output hidden')`), await cdp.eval(`document.body.innerText.includes('nothing outside tool output')`));
  /*
   * Click the row that belongs to THIS rollout, not row zero. The needle is now
   * derived from the discovered transcript instead of being a UUID unique to
   * one file, so a common word legitimately matches other sessions too and row
   * zero may belong to one of them. Rows carry no session id, so the index is
   * computed from the rendered model the app itself grouped: groups in order,
   * five hits shown per group, matching app.js's renderer.
   */
  await cdp.eval(`document.querySelector('.cs-pill:last-child').click()`);
  const CLICK_IDX_JS = `(() => {
    const cs = window.__station.state.contentSearch;
    const shown = cs.result.hits
      .filter((h) => cs.showTools || h.kind === 'prose')
      .filter((h) => cs.scopedProject ? true : (cs.scope === 'all' || h.projectId === window.__station.state.current.projectId));
    const groups = []; const by = new Map();
    for (const h of shown) {
      const key = h.projectId + '\\u0000' + h.encodedDir + '\\u0000' + h.sessionId;
      let g = by.get(key); if (!g) { g = { hits: [] }; by.set(key, g); groups.push(g); }
      g.hits.push(h);
    }
    let i = 0;
    for (const g of groups.slice(0, cs.visibleGroups)) {
      for (const h of g.hits.slice(0, 5)) { if (h.sessionId === ${JSON.stringify(SID)}) return i; i++; }
    }
    return { idx: -1, groups: groups.length, visibleGroups: cs.visibleGroups, shown: shown.length,
             total: cs.result.hits.length, sidInAll: cs.result.hits.some((h) => h.sessionId === ${JSON.stringify(SID)}),
             sidInShown: shown.some((h) => h.sessionId === ${JSON.stringify(SID)}), showTools: cs.showTools, scope: cs.scope };
  })()`;
  let clickIdx = await cdp.eval(CLICK_IDX_JS);
  // A busy store can push this session past the group cap; "show more sessions"
  // is the real UI path for that, so take it rather than reaching into state.
  if (typeof clickIdx !== 'number') {
    await cdp.eval(`[...document.querySelectorAll('.cs-more')].filter((b)=>/more session/.test(b.textContent)).forEach((b)=>b.click())`);
    await sleep(300);
    clickIdx = await cdp.eval(CLICK_IDX_JS);
  }
  check('the discovered rollout has a clickable rendered row', typeof clickIdx === 'number' && clickIdx >= 0, { clickIdx });
  await cdp.eval(`document.querySelectorAll('.cs-hit')[${Number(clickIdx)}].click()`);
  const landed = await cdp.waitFor(`window.__station.state.current.sessionId===${JSON.stringify(SID)}&&document.querySelector('.search-landing')`, 40000);
  check('click lands on the matching Codex message', landed, await cdp.eval(`document.querySelector('.search-landing')?.textContent.slice(0,160)`));
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SCRATCH, 'BUG-141-codex-landing.png'), Buffer.from(shot.data, 'base64'));
  await cdp.eval(`findInput.value=${JSON.stringify(CLAUDE_NEEDLE)};findInput.dispatchEvent(new Event('input'))`);
  check('rendered UI still finds a Claude-store-only body needle', await cdp.waitFor(`[...document.querySelectorAll('.cs-hit mark')].some(x=>x.textContent.toLowerCase()===${JSON.stringify(CLAUDE_NEEDLE.toLowerCase())})`, 40000), CLAUDE_NEEDLE);
} catch (err) { console.error(`FATAL ${err.stack ?? err}`); fail++; }
finally { try { cdp?.ws.close(); } catch {} if (browser?.exitCode === null) browser.kill('SIGTERM'); if (server?.exitCode === null) server.kill('SIGTERM'); }
console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0;
