/**
 * FEAT-077 — templates management remake verification.
 *
 *   node scripts/verify-feat-077.mjs
 *
 * Three concerns, all against REAL code (no mocks):
 *
 *   A. Seed source (fresh temp data dir): seedTemplates() + readTemplate() carry
 *      the NEW human-first pattern descriptions, and the OLD jargon is gone.
 *   B. Live default data-dir files: the four already-seeded
 *      <data>/templates/pattern-*.md frontmatter `description:` lines are
 *      refreshed to the new strings (seedTemplates skips existing files, so this
 *      is the in-place migration the ticket calls for). Old jargon absent.
 *   C. UI (happy-dom + real public/app.js + a real server over a busy fixture):
 *      the library view groups templates into a "Working Agreement" unit (v1+v2),
 *      a COLLAPSED "Patterns (opt-in)" section for the four pattern-*, and a
 *      "Your templates" group; each row shows an "attached to N projects" usage
 *      count (WA-v2 attached → 1; unattached pattern → 0) and `source:` provenance.
 *
 * Section B is the must-FAIL seam: run this BEFORE refreshing the data-dir files
 * and B fails (old jargon still on disk); after the refresh it passes.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Window } from 'happy-dom';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

/** Exact new descriptions from the ticket (§1). */
const NEW_DESC = {
  'pattern-go-no-go-preflight':
    'A short yes/no checklist an agent must fully pass before it starts — any failed item stops it cold. Use when starting in the wrong state (wrong branch, a job already done, a resource still in use) is costly to unwind and the things to check are a clear finite list.',
  'pattern-index-table-router':
    'Keep a growing pile of docs manageable: the root file is just a table of links to per-topic files, so it never bloats and readers load only the topic they need. Use when notes/playbooks keep piling up and one flat doc would get too big to read.',
  'pattern-manager-subagent-tree':
    "For big jobs that split into a few distinct areas (security, performance, docs…): put one manager agent over each area, let it run its own helpers, and the top orchestrator reads only each manager's summary. Use when the work has several domains too complex to fan out flat.",
  'pattern-raw-curated-memory-split':
    'Keep two notes per topic: an append-only raw log of everything as it happens, plus a short summary you rewrite as understanding changes. Readers use the summary; the raw log is insurance if the summary is ever wrong. Use when observations pile up faster than you can digest them.',
};
/** A fragment of each OLD jargon string that must be gone everywhere. */
const OLD_FRAGMENT = {
  'pattern-go-no-go-preflight': 'A numbered eligibility checklist',
  'pattern-index-table-router': 'A small root doc that is only a table pointing',
  'pattern-manager-subagent-tree': 'Recursive 2-level fan-out',
  'pattern-raw-curated-memory-split': 'Append-only raw observation log kept separate',
};
const PATTERN_IDS = Object.keys(NEW_DESC);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(label, fn, timeoutMs = 20_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (fn()) return true; await sleep(120); }
  console.log(`        (timed out waiting for ${label} after ${timeoutMs}ms)`);
  return false;
}
async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

// ---------------------------------------------------------------- A. seed source
async function sectionA() {
  console.log('\n=== A. seed source (fresh temp data dir) ===');
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-feat077-seed-'));
  const prevEnv = process.env.CLAUDE_STATION_DATA;
  process.env.CLAUDE_STATION_DATA = DATA;
  try {
    const { seedTemplates, readTemplate } = await import(path.join(ROOT, 'src', 'server', 'templates.ts'));
    seedTemplates();
    for (const id of PATTERN_IDS) {
      const t = readTemplate(id);
      check(`[A] ${id} seed description === new human string`, t?.description === NEW_DESC[id], t?.description);
      check(`[A] ${id} seed description no longer carries old jargon`,
        !!t && !t.description.includes(OLD_FRAGMENT[id]) && !t.description.startsWith('Opt-in.'), t?.description?.slice(0, 40));
    }
  } finally {
    if (prevEnv === undefined) delete process.env.CLAUDE_STATION_DATA; else process.env.CLAUDE_STATION_DATA = prevEnv;
    fs.rmSync(DATA, { recursive: true, force: true });
  }
}

// -------------------------------------------------- B. live default data-dir files
function liveTemplatesDir() {
  // Mirror src/lib/paths.ts dataDir()/templatesDir() default resolution, with NO
  // CLAUDE_STATION_DATA override (we want the user's real seeded files).
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.trim() ? path.resolve(xdg) : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'claude-station', 'templates');
}
function frontmatterDesc(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return null;
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    if (line.slice(0, i).trim() === 'description') return line.slice(i + 1).trim();
  }
  return null;
}
function sectionB() {
  console.log('\n=== B. live default data-dir pattern files ===');
  const dir = liveTemplatesDir();
  for (const id of PATTERN_IDS) {
    const file = path.join(dir, `${id}.md`);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch { check(`[B] ${id}.md exists in live data dir`, false, file); continue; }
    const desc = frontmatterDesc(raw);
    check(`[B] ${id}.md frontmatter description === new human string`, desc === NEW_DESC[id], desc);
    check(`[B] ${id}.md no longer carries old jargon`,
      typeof desc === 'string' && !desc.includes(OLD_FRAGMENT[id]) && !desc.startsWith('Opt-in.'), desc?.slice(0, 40));
  }
}

// --------------------------------------------------------------- C. UI over server
async function sectionC() {
  console.log('\n=== C. UI: grouped library render over a busy fixture ===');
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-feat077-ui-'));
  let server = null;
  const openSockets = [];
  const prev = {};
  try {
    server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
      cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
      stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); }
    }
    if (!up) throw new Error('server never became healthy');

    // --- Busy fixture: a project that opts into WA-v2, plus a user-made template.
    const mk = async (p) => {
      const r = await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p) });
      if (!r.ok) throw new Error(`register ${p.hostPath}: ${await r.text()}`);
      return (await r.json()).project;
    };
    const proj = await mk({ hostPath: ROOT, name: 'Orchard' });
    // Attach WA-v2 to this project → its usage count must read 1; patterns stay 0.
    const patch = await fetch(`${BASE}/api/projects/${proj.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { instructions: [{ templateId: 'working-agreement-v2', enabled: true }] } }),
    });
    if (!patch.ok) throw new Error(`attach WA-v2: ${await patch.text()}`);
    // A user-created template so the "Your templates" group renders (busy state).
    const mine = await fetch(`${BASE}/api/templates`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'My House Style', description: 'Personal notes', body: 'Be concise.' }),
    });
    if (!mine.ok) throw new Error(`create user template: ${await mine.text()}`);

    // Cross-check the API surface directly (independent of the DOM).
    const apiTemplates = (await (await fetch(`${BASE}/api/templates`)).json()).templates;
    const waRow = apiTemplates.find((t) => t.id === 'working-agreement-v2');
    const patRow = apiTemplates.find((t) => t.id.startsWith('pattern-'));
    check('[C-api] /api/templates reports attachedCount=1 for the attached WA-v2', waRow?.attachedCount === 1, waRow?.attachedCount);
    check('[C-api] /api/templates reports attachedCount=0 for an unattached pattern', patRow?.attachedCount === 0, `${patRow?.id}=${patRow?.attachedCount}`);
    check('[C-api] a pattern still carries its source: provenance', typeof patRow?.source === 'string' && patRow.source.includes('docs/prompts/patterns/'), patRow?.source);

    // --- Real markup + real app.js.
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const win = new Window({ url: `${BASE}/` });
    const doc = win.document;
    doc.write(html.replace(/<link[^>]*>/g, '').replace(/<script[^>]*><\/script>/g, ''));
    doc.close();

    const g = win;
    const realFetch = globalThis.fetch;
    g.fetch = (async (input, init) => realFetch(input.startsWith('http') ? input : BASE + input, init));
    class TrackedWebSocket extends WebSocket { constructor(...a) { super(...a); openSockets.push(this); } }
    g.WebSocket = TrackedWebSocket;
    win.location.host = `127.0.0.1:${PORT}`;

    prev.document = globalThis.document; prev.window = globalThis.window;
    prev.WebSocket = globalThis.WebSocket; prev.fetch = globalThis.fetch; prev.location = globalThis.location;
    globalThis.document = doc; globalThis.window = win; globalThis.WebSocket = g.WebSocket;
    globalThis.location = win.location; globalThis.fetch = g.fetch;

    await import(`${path.join(ROOT, 'public', 'app.js')}?f077=${Date.now()}`);
    const q = (s) => doc.querySelector(s);
    const qa = (s) => [...doc.querySelectorAll(s)];

    const booted = await waitFor('project list', () => qa('#tree button.proj').length > 0);
    if (!booted) throw new Error('app.js never rendered the project list');

    // Open the templates library exactly as a user does. FEAT-139 removed the
    // standalone #libBtn door; FEAT-146 made "Templates" a rail category one
    // click away inside the settings modal (`#cogBtn` → `#sRail-templates`) —
    // see docs/bugs/FEAT-146-settings-is-two-navigation-axes-fighting-each-other.md.
    const cogBtn = q('#cogBtn');
    if (!cogBtn) throw new Error('precondition: #cogBtn missing');
    cogBtn.click();
    const railReady = await waitFor('settings rail', () => qa('#sRail .srail-item').length > 0);
    if (!railReady) throw new Error('precondition: settings rail never rendered');
    const templatesTab = q('#sRail-templates');
    if (!templatesTab) throw new Error('precondition: #sRail-templates missing');
    templatesTab.click();
    const rendered = await waitFor('library rows', () => qa('#vLibrary .lrow').length >= 6);
    check('[C] library rendered all templates (6+ rows: 2 WA + 4 patterns + user)', rendered, qa('#vLibrary .lrow').length);

    // Group 1 — Working Agreement as ONE unit (v1 base + v2 living).
    const waGrp = q('#vLibrary [data-grp="working-agreement"]');
    const waNames = waGrp ? [...waGrp.querySelectorAll('.lrow .nm')].map((n) => n.textContent.trim()) : [];
    check('[C] a "Working Agreement" group exists', !!waGrp, !!waGrp);
    check('[C] the WA group presents BOTH v1 and v2 as one unit',
      waNames.some((n) => n === 'Working Agreement') && waNames.some((n) => n.includes('v2')), waNames);

    // Group 2 — Patterns (opt-in), a COLLAPSED <details>.
    const patSect = q('#vLibrary details[data-sect="patterns"]');
    check('[C] a collapsible "Patterns (opt-in)" section exists', !!patSect, patSect?.querySelector('summary')?.textContent?.trim());
    check('[C] the Patterns section is COLLAPSED by default', !!patSect && patSect.open === false, patSect?.open);
    const patRows = patSect ? [...patSect.querySelectorAll('.lrow')] : [];
    check('[C] the Patterns section holds all four pattern-* rows', patRows.length === 4, patRows.length);

    // Group 3 — user template lands in its own group, not among patterns/WA.
    const otherGrp = q('#vLibrary [data-grp="other"]');
    check('[C] a "Your templates" group holds the user-created template',
      !!otherGrp && [...otherGrp.querySelectorAll('.lrow .nm')].some((n) => n.textContent.includes('My House Style')),
      otherGrp ? [...otherGrp.querySelectorAll('.lrow .nm')].map((n) => n.textContent.trim()) : null);

    // Usage counts on the real rows.
    const rowFor = (needle) => qa('#vLibrary .lrow').find((r) => r.querySelector('.nm')?.textContent?.includes(needle));
    const waV2Use = rowFor('v2') ? [...rowFor('v2').querySelectorAll('.use')].map((u) => u.textContent).join(' ') : '';
    check('[C] WA-v2 row shows "attached to 1 project"', /attached to 1 project\b/.test(waV2Use), waV2Use);
    const goRow = patRows.find((r) => r.querySelector('.nm')?.textContent?.includes('Go/No-go'));
    const goUse = goRow ? [...goRow.querySelectorAll('.use')].map((u) => u.textContent).join(' ') : '';
    check('[C] an unattached pattern row shows "attached to 0 projects"', /attached to 0 projects/.test(goUse), goUse);

    // Provenance + the NEW human description are on the real pattern row.
    const goSrc = goRow?.querySelector('.src')?.textContent ?? '';
    check('[C] a pattern row surfaces its source provenance', goSrc.includes('docs/prompts/patterns/'), goSrc);
    const goDesc = goRow?.querySelector('.desc')?.textContent ?? '';
    check('[C] the pattern row shows the NEW human description (old jargon gone)',
      goDesc.includes('yes/no checklist') && !goDesc.includes('numbered eligibility') && !goDesc.startsWith('Opt-in.'), goDesc.slice(0, 60));
  } finally {
    // BUG-175-adjacent: a socket still in CONNECTING state when the test tears
    // down closes with an ASYNC 'error' event ("WebSocket was closed before
    // the connection was established") that fires on a later tick — after
    // this loop's own try/catch has already returned, so a synchronous catch
    // here cannot see it. `removeAllListeners()` before `close()` made it
    // worse: it strips the listener the async event needs, so Node treats the
    // unhandled 'error' as fatal and crashes the whole script AFTER every
    // check above has already printed PASS. A permanent no-op 'error'
    // listener (added before close, never removed) gives that later event
    // somewhere harmless to land instead.
    for (const s of openSockets) { try { s.on('error', () => {}); s.close(); } catch { /* */ } }
    await sleep(200);
    if (prev.document !== undefined) {
      globalThis.document = prev.document; globalThis.window = prev.window;
      globalThis.WebSocket = prev.WebSocket; globalThis.fetch = prev.fetch; globalThis.location = prev.location;
    }
    if (server?.pid) {
      try { process.kill(-server.pid, 'SIGTERM'); } catch { /* */ }
      await sleep(600);
      try { process.kill(-server.pid, 'SIGKILL'); } catch { /* */ }
    }
    fs.rmSync(DATA, { recursive: true, force: true });
  }
}

async function main() {
  await sectionA();
  sectionB();
  await sectionC();
  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exit(fail ? 1 : 0);
}
main().catch((err) => { console.error(`\nFATAL: ${err.stack ?? err.message}`); process.exit(1); });
