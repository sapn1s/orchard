#!/usr/bin/env node
/**
 * verify-release-no-verdicts.mjs — 2026-10-13 (defaults lane, FEAT-164 follow-up): a project in
 * SOFT-RELEASE mode (commit granted, blank scope note) whose board has NO typed verdicts can
 * never release — eligibility needs a typed HOLDS — and used to say nothing. Now:
 *   · planRelease reports `verdictSource` {ok:false, code, reason} (scripts/lib/release.mjs
 *     boardVerdictSource — the one place that decides it);
 *   · releaseAlarm returns a "releases can never happen: …" alarm FIRST, and the station's
 *     release tick raises ONE Needs-You card for it (not one per tick; not again for a week
 *     after the user answers it);
 *   · Settings → Agent git shows a warning with a choice (write a scope note / turn agent
 *     commits off / keep soft releases). The MODE IS NEVER CHANGED automatically.
 *
 *   node scripts/verify-release-no-verdicts.mjs            # A (lib) + B (scratch server) + C (browser)
 *   node scripts/verify-release-no-verdicts.mjs --no-ui    # skip C
 *
 * FIXTURES: throwaway git repos under the scratch root whose boards hold COPIES OF REAL
 * Orchard ticket files, chosen at runtime by property (a ticket with no typed entry; a ticket
 * whose record carries typed verification[]) — fails loudly if the real board has none.
 * The repos are built with the REAL git binary (the agent shim refuses `git init`); only
 * fixture setup bypasses the shim, never the product (same as verify-feat-164-settings-ui).
 *
 * MUST-FAIL (constructed, not HEAD-anchored): A5 loads the release lib with the new
 * releaseAlarm branch removed — it must stay silent (null) on the very repo the fixed lib
 * alarms on. B6 boots the station from a mutant tree with that same lib — no card may appear.
 *
 * Exit 0 = all PASS, 1 = a FAIL, 2 = could not run here.
 */
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { pathToFileURL } from 'node:url';
import { isolatedServerEnv } from './lib/station-boot.mjs';
import { mkdtempScratch } from './lib/scratch.mjs';
import { buildMutantTree } from './lib/mutant-tree.mjs';
import * as VS from './lib/verification-source.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const NO_UI = process.argv.includes('--no-ui');
const KEEP = process.argv.includes('--keep');
const OUTDIR = process.env.NOVERDICT_SHOTS ?? path.join(ROOT, 'docs', 'bugs', 'assets');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0; let fail = 0; const failures = [];
function check(name, ok, observed) {
  const line = observed === undefined ? '' : `\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed).slice(0, 700)}`;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${line}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
const dirs = [];

/** The REAL git binary — the first on PATH that is not the agent shim (fixture setup only). */
function realGit() {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir || dir.includes('shim')) continue;
    const g = path.join(dir, 'git');
    try { if (fs.statSync(g).isFile()) return g; } catch { /* next */ }
  }
  return '/usr/bin/git';
}
const GIT = realGit();
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'verify', GIT_AUTHOR_EMAIL: 'verify@example.invalid', GIT_COMMITTER_NAME: 'verify', GIT_COMMITTER_EMAIL: 'verify@example.invalid' };

/* ── real ticket artifacts, picked by property ── */
const BOARD = path.join(ROOT, 'docs', 'bugs');
const realTickets = fs.readdirSync(BOARD).filter((n) => /^[A-Z]+-\d+-.*\.md$/.test(n)).map((n) => {
  const id = n.match(/^([A-Z]+-\d+)-/)[1];
  const markdown = fs.readFileSync(path.join(BOARD, n), 'utf8');
  return { n, id, markdown, v: VS.ticketVerifications(BOARD, { id, markdown }) };
});
const untyped = realTickets.filter((t) => t.v.entries.length === 0).slice(0, 3);
const typed = realTickets.find((t) => t.v.source === 'record' && t.v.entries.length > 0);
if (untyped.length < 2 || !typed) {
  console.log(`COULD NOT RUN: the real board has ${untyped.length} untyped and ${typed ? 1 : 0} typed-record tickets — need ≥2 and 1.`);
  process.exit(2);
}
console.log(`fixtures: real untyped tickets ${untyped.map((t) => t.id).join(', ')}; real typed-record ticket ${typed.id}`);

function fixtureRepo(label, { board }) {
  const repo = mkdtempScratch(`noverdict-${label}-`); dirs.push(repo);
  execFileSync(GIT, ['init', '-q', '-b', 'main', repo], { env: gitEnv });
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture (scratch)\n');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'fixture', private: true, scripts: { gate: 'true' } }, null, 2));
  if (board) {
    fs.mkdirSync(path.join(repo, 'docs', 'bugs'), { recursive: true });
    for (const t of board) fs.writeFileSync(path.join(repo, 'docs', 'bugs', t.n), t.markdown);
  }
  execFileSync(GIT, ['-C', repo, 'add', '-A'], { env: gitEnv });
  execFileSync(GIT, ['-C', repo, 'commit', '-q', '-m', 'initial'], { env: gitEnv });
  return repo;
}

/** The constructed pre-fix release lib: the new releaseAlarm branch removed (asserted present). */
const NEVER_BRANCH = "  if (pol.mode === 'release') {\n    const vs = await boardVerdictSource(repo);\n    if (!vs.ok) return `${NEVER_RELEASES_PREFIX}${vs.reason}`;\n  }\n";
/** …and the CLI's own `auto` early-out (scripts/release.mjs), removed for the mutant station. */
const CLI_AUTO_BRANCH = "    if (vs && !vs.ok) { out({ released: false, reason: vs.reason, alarm: `${NEVER_RELEASES_PREFIX}${vs.reason}` }, `No release: ${vs.reason}`); return 0; }\n";

const R = await import(pathToFileURL(path.join(ROOT, 'scripts/lib/release.mjs')).href);
const P = await import(pathToFileURL(path.join(ROOT, 'scripts/lib/agent-git-policy.mjs')).href);
const REL = P.normalizeGitWrite({ commit: true, push: false, scope: null });
const SCOPED = P.normalizeGitWrite({ commit: true, push: false, scope: 'commit directly' });

try {
  /* ───────────────────────── A: the lib, on real artifacts */
  console.log('A  the release lib');
  const repoNone = fixtureRepo('untyped', { board: untyped });
  const repoTyped = fixtureRepo('typed', { board: [...untyped, typed] });
  const repoNoBoard = fixtureRepo('noboard', { board: null });
  const vReal = await R.boardVerdictSource(ROOT);
  check('A1 the REAL Orchard board has typed verdicts → ok', vReal.ok === true && vReal.code === null, vReal);
  const vNone = await R.boardVerdictSource(repoNone);
  const vTyped = await R.boardVerdictSource(repoTyped);
  const vNoBoard = await R.boardVerdictSource(repoNoBoard);
  check('A2 a board of real untyped tickets → no-typed-verdicts, with a reason naming board-tool verified', vNone.ok === false && vNone.code === 'no-typed-verdicts' && /board-tool verified/.test(vNone.reason), vNone);
  check('A3 adding ONE real ticket whose record carries typed verification[] → ok; no board at all → no-board', vTyped.ok === true && vNoBoard.ok === false && vNoBoard.code === 'no-board', { vTyped, vNoBoard });
  const plan = await R.planRelease({ repo: repoNone, policy: REL });
  check('A4 planRelease carries verdictSource (what the Settings route serves)', plan.verdictSource?.ok === false && plan.verdictSource.code === 'no-typed-verdicts', plan.verdictSource);
  // A5: before/after on the alarm.
  const preDir = mkdtempScratch('noverdict-prelib-'); dirs.push(preDir);
  let src = fs.readFileSync(path.join(ROOT, 'scripts/lib/release.mjs'), 'utf8');
  if (src.split(NEVER_BRANCH).length !== 2) throw new Error('A5: the never-releases branch is not present exactly once — the constructed baseline would be vacuous');
  src = src.replace(NEVER_BRANCH, '');
  src = src.replace(/from '\.\/([^']+)'/g, (_m, f) => `from '${pathToFileURL(path.join(ROOT, 'scripts/lib', f)).href}'`);
  src = src.replace("const HERE = path.dirname(fileURLToPath(import.meta.url));", `const HERE = ${JSON.stringify(path.join(ROOT, 'scripts/lib'))};`);
  fs.writeFileSync(path.join(preDir, 'release-pre.mjs'), src);
  const PRE = await import(pathToFileURL(path.join(preDir, 'release-pre.mjs')).href);
  const before = await PRE.releaseAlarm({ repo: repoNone, policy: REL });
  const after = await R.releaseAlarm({ repo: repoNone, policy: REL });
  check('A5 BEFORE (constructed pre-fix lib) the alarm is SILENT on a release-mode repo with no typed verdicts [must-FAIL]', before === null, before);
  check('A5 AFTER the alarm says releases can never happen, and why', typeof after === 'string' && after.startsWith(P.NEVER_RELEASES_PREFIX) && /no typed verification verdicts/.test(after), after);
  const scopedAlarm = await R.releaseAlarm({ repo: repoNone, policy: SCOPED });
  const typedAlarm = await R.releaseAlarm({ repo: repoTyped, policy: REL });
  check('A6 no such alarm in scoped mode (agents commit directly; releases are not the path) nor on a board with typed verdicts', scopedAlarm === null && typedAlarm === null, { scopedAlarm, typedAlarm });

  // A7 (verify b0587b41 finding 1): a ledger entry the reader does NOT read (a record-format
  // ticket's id, or an id not on the board) must not make an untyped board "ok".
  const repoLedger = fixtureRepo('ledger', { board: untyped });
  const recordId = untyped.find((t) => /```orchard-ticket/.test(t.markdown))?.id ?? untyped[0].id;
  fs.writeFileSync(path.join(repoLedger, 'docs/bugs', VS.LEDGER_FILE), JSON.stringify({ schema: VS.LEDGER_SCHEMA, entries: [
    { id: recordId, provider: 'anthropic', model: 'm', run_id: 'run-000001', verdict: 'holds', author: 'x', recorded_at: '2026-10-01T00:00:00Z' },
    { id: 'BUG-99999', provider: 'anthropic', model: 'm', run_id: 'run-000002', verdict: 'holds', author: 'x', recorded_at: '2026-10-01T00:00:00Z' },
  ] }, null, 2));
  const vLedger = await R.boardVerdictSource(repoLedger);
  check('A7 a ledger whose entries the reader does not read (a record ticket\'s id, an id not on the board) leaves the board untyped', vLedger.ok === false && vLedger.code === 'no-typed-verdicts', { recordId, vLedger });
  // A8 (finding 2): a release-mode repo with NO base commit, and a dir that is not a repo at all.
  const repoNoCommit = mkdtempScratch('noverdict-nocommit-'); dirs.push(repoNoCommit);
  execFileSync(GIT, ['init', '-q', '-b', 'main', repoNoCommit], { env: gitEnv });
  fs.mkdirSync(path.join(repoNoCommit, 'docs/bugs'), { recursive: true });
  for (const t of untyped) fs.writeFileSync(path.join(repoNoCommit, 'docs/bugs', t.n), t.markdown);
  const notRepo = mkdtempScratch('noverdict-notrepo-'); dirs.push(notRepo);
  const a8a = await R.releaseAlarm({ repo: repoNoCommit, policy: REL }).catch((e) => `THREW ${e.message}`);
  const a8b = await R.releaseAlarm({ repo: notRepo, policy: REL }).catch((e) => `THREW ${e.message}`);
  check('A8 no base commit → the never-alarm (not a throw); not a git repo, no board → the no-board never-alarm', String(a8a).startsWith(P.NEVER_RELEASES_PREFIX) && /no typed/.test(a8a) && String(a8b).startsWith(P.NEVER_RELEASES_PREFIX) && /no ticket board/.test(a8b), { a8a, a8b });

  /* ───────────────────────── B (+C): an isolated scratch station */
  async function freePort() { return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }
  async function boot(root, label) {
    const PORT = await freePort();
    const DATA = fs.mkdtempSync(path.join(os.tmpdir(), `noverdict-${label}-data-`)); dirs.push(DATA);
    const env = isolatedServerEnv({ PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_STATION_NO_WA_CONSOLIDATE: '1', ORCHARD_RELEASE_TICK_MS: '2000' });
    const log = [];
    const child = spawn(process.execPath, [path.join(root, 'src/server/index.ts')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => log.push(String(d))); child.stderr.on('data', (d) => log.push(String(d)));
    const BASE = `http://127.0.0.1:${PORT}`;
    for (let i = 0; i < 200; i++) { try { const r = await fetch(`${BASE}/api/projects`); if (r.ok) break; } catch { /* booting */ } await sleep(150); }
    const j = async (m, u, body) => { const r = await fetch(BASE + u, { method: m, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined }); let d; try { d = await r.json(); } catch { d = null; } return { status: r.status, d }; };
    const add = async (hostPath) => { const r = await j('POST', '/api/projects', { hostPath, isolation: 'direct', applyMethod: false }); const id = r.d?.project?.id ?? r.d?.id; if (!id) throw new Error(`register ${hostPath}: ${r.status} ${JSON.stringify(r.d)}`); return id; };
    const stop = async () => { try { process.kill(child.pid, 'SIGTERM'); } catch { /* */ } await sleep(2500); try { process.kill(child.pid, 'SIGKILL'); } catch { /* */ } if (KEEP) fs.writeFileSync(path.join(DATA, 'server.log'), log.join('')); };
    return { BASE, PORT, DATA, j, add, stop, log };
  }
  const neverCards = async (S, pid) => ((await S.j('GET', `/api/projects/${pid}/board`)).d?.needsYou ?? []).filter((n) => n.kind === 'decision' && /^Soft releases can never happen/.test(n.title ?? ''));
  const waitFor = async (fn, ms) => { const t = Date.now(); let v; while (Date.now() - t < ms) { v = await fn(); if (v) return v; await sleep(500); } return v; };

  /** Re-verify 4f107ae8: card open + warning shown; then a typed verdict appears → do BOTH clear? */
  async function flipCase(S, label) {
    const repo = fixtureRepo(`flip-${label}`, { board: untyped });
    const pid = await S.add(repo);
    await S.j('PUT', `/api/projects/${pid}/git-write-policy`, { commit: true, push: false, scope: null });
    const cardBefore = await waitFor(async () => (await neverCards(S, pid))[0], 30_000);
    const warnBefore = (await S.j('GET', `/api/projects/${pid}/git-write-policy`)).d?.release?.verdictSource?.ok === false;
    fs.writeFileSync(path.join(repo, 'docs', 'bugs', typed.n), typed.markdown); // a typed verdict appears
    const t0 = Date.now(); let warnAfter = true; let cardsAfter = [];
    while (Date.now() - t0 < 20_000) {
      warnAfter = (await S.j('GET', `/api/projects/${pid}/git-write-policy`)).d?.release?.verdictSource?.ok === false;
      cardsAfter = await neverCards(S, pid);
      if (!warnAfter && !cardsAfter.length) break;
      await sleep(1000);
    }
    await sleep(5000); // ≥ 2 ticks: it must not be re-raised either
    const cardsLater = await neverCards(S, pid);
    return { cardBefore: !!cardBefore, warnBefore, warnAfter, cardsAfter: cardsAfter.length, cardsLater: cardsLater.length };
  }

  console.log('B  a scratch station (release tick every 2 s)');
  const S = await boot(ROOT, 'b');
  let pidNone; let pidTyped;
  try {
    pidNone = await S.add(repoNone);
    pidTyped = await S.add(repoTyped);
    const putN = await S.j('PUT', `/api/projects/${pidNone}/git-write-policy`, { commit: true, push: false, scope: null });
    const putT = await S.j('PUT', `/api/projects/${pidTyped}/git-write-policy`, { commit: true, push: false, scope: null });
    check('B0 PRECONDITION: both projects are in soft-release mode', putN.d?.policy?.mode === 'release' && putT.d?.policy?.mode === 'release', { none: putN.status, typed: putT.status, err: putN.d?.error });
    const card = await waitFor(async () => (await neverCards(S, pidNone))[0], 40_000);
    check('B1 the tick raises a Needs-You card for the no-verdict project, naming the cause and the three choices', !!card && /no typed verification verdicts/.test(card.title) && /scope note/.test(card.title) && /turn agent commits off/.test(card.title) && /Nothing changes until you do/.test(card.title), card?.title ?? S.log.join('').slice(-800));
    await S.j('PATCH', `/api/projects/${pidNone}`, { name: 'renamed-noverdict' });
    await sleep(7000); // ≥ 3 more ticks, across a rename
    const cardsAfter = await neverCards(S, pidNone);
    check('B2 one card, not one per tick — after ≥ 3 more ticks AND a project rename there is still exactly one', cardsAfter.length === 1, cardsAfter.map((c) => c.id));
    const pol = (await S.j('GET', `/api/projects/${pidNone}/git-write-policy`)).d;
    check('B3 the mode is NOT changed automatically (still release, commit still granted)', pol?.policy?.mode === 'release' && pol?.policy?.commit === true, pol?.policy);
    check('B4 the Settings route serves the warning\'s source: release.verdictSource {ok:false, code:no-typed-verdicts}', pol?.release?.verdictSource?.ok === false && pol.release.verdictSource.code === 'no-typed-verdicts', pol?.release?.verdictSource);
    check('B5 no such card for the release-mode project whose board HAS typed verdicts', (await neverCards(S, pidTyped)).length === 0);
    const F = await flipCase(S, 'b');
    check('B8 a typed verdict appears → the Settings warning AND the Needs-You card both clear, and the card is not re-raised (re-verify 4f107ae8)',
      F.cardBefore && F.warnBefore && !F.warnAfter && F.cardsAfter === 0 && F.cardsLater === 0, F);
    const pidNC = await S.add(repoNoCommit);
    const putNC = await S.j('PUT', `/api/projects/${pidNC}/git-write-policy`, { commit: true, push: false, scope: null });
    const cardNC = await waitFor(async () => (await neverCards(S, pidNC))[0], 30_000);
    const polNC = (await S.j('GET', `/api/projects/${pidNC}/git-write-policy`)).d;
    check('B7 a release-mode repo with NO base commit still gets the card and the Settings source (verify b0587b41)', putNC.d?.policy?.mode === 'release' && !!cardNC && polNC?.release?.verdictSource?.ok === false, { put: putNC.status, mode: putNC.d?.policy?.mode, card: !!cardNC, release: polNC?.release });
    if (card) {
      const ans = await S.j('POST', `/api/projects/${pidNone}/board/answer`, { id: card.id, answer: 'Seen' });
      await sleep(7000);
      const again = await neverCards(S, pidNone);
      check('B5b once the user answers it, the standing condition is not re-raised every tick (≥ 3 ticks later: none open)', ans.status === 200 && again.length === 0, { answer: ans.status, again: again.map((c) => c.id) });
    }

    /* ── C: the Settings warning in a real headless browser ── */
    if (!NO_UI) {
      console.log('C  Settings → Agent git, real headless Chromium');
      const { chromium } = await import('playwright');
      const base = path.join(os.homedir(), '.cache', 'ms-playwright');
      const exe = (fs.existsSync(base) ? fs.readdirSync(base).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse() : [])
        .map((d) => path.join(base, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell')).find((p) => fs.existsSync(p));
      const browser = await chromium.launch({ executablePath: exe });
      try {
        const page = await (await browser.newContext({ viewport: { width: 1440, height: 980 } })).newPage();
        const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
        const openAgit = async (pid) => {
          await page.goto(`${S.BASE}/#/git?project=${encodeURIComponent(pid)}`);
          await page.waitForFunction(() => document.querySelector('.git-view.open .gt-gw-settings'), null, { timeout: 30_000 });
          await page.click('.gt-gw-settings');
          await page.waitForFunction(() => !document.querySelector('#smodal').hidden && document.querySelector('[data-focus="agentGit"] .agit-summary'), null, { timeout: 20_000 });
          await sleep(500);
        };
        const state = () => page.evaluate(() => {
          const g = document.querySelector('[data-focus="agentGit"]');
          const w = g?.querySelector('.agit-never');
          return {
            warning: !!w, text: w?.textContent ?? '', buttons: [...(w?.querySelectorAll('button') ?? [])].map((b) => b.textContent),
            role: w?.getAttribute('role') ?? null, mode: g?.querySelector('.agit-status')?.dataset.mode ?? null,
            msg: g?.querySelector('.agit-rel-msg')?.textContent ?? '', focusIsScope: document.activeElement?.classList?.contains('agit-scope-in') ?? false,
            firstAfterStatus: w ? w.previousElementSibling?.classList?.contains('agit-status') ?? false : false,
          };
        });
        const shot = async (name) => {
          const clip = await page.evaluate(() => { const g = document.querySelector('[data-focus="agentGit"]'); g.scrollIntoView({ block: 'start' }); const b = g.getBoundingClientRect(); return { x: Math.max(0, b.x - 12), y: Math.max(0, b.y - 12), width: Math.min(1440, b.width + 24), height: Math.min(980, b.height + 24) }; });
          await sleep(150); fs.mkdirSync(OUTDIR, { recursive: true }); await page.screenshot({ path: path.join(OUTDIR, name), clip });
        };
        await openAgit(pidNone);
        const s1 = await state();
        check('C1 the warning shows in release mode, right under the status line, as an alert, with the three choices',
          s1.warning && s1.role === 'alert' && s1.firstAfterStatus && /can never happen/.test(s1.text) && s1.buttons.join('|') === 'Write a scope note (agents commit directly)|Turn agent commits off|Keep soft releases', s1);
        for (const theme of ['light', 'dark']) { await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme); await shot(`noverdict-agentgit-warning-${theme}.png`); }
        await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
        await page.click('.agit-never-keep');
        await sleep(400);
        const s2 = await state();
        const p2 = (await S.j('GET', `/api/projects/${pidNone}/git-write-policy`)).d?.policy;
        check('C2 "Keep soft releases" changes nothing on the server and says how a ticket becomes releasable', p2?.mode === 'release' && /board-tool verified/.test(s2.msg), { mode: p2?.mode, msg: s2.msg });
        await page.click('.agit-never-scope');
        const immediate = await page.evaluate(() => document.activeElement?.className ?? null);
        await sleep(600);
        const s3 = { immediate, active: await page.evaluate(() => document.activeElement?.className ?? null), ...(await state()) };
        check('C3 "Write a scope note" moves focus into the scope note (the user writes it; nothing is saved for them)', s3.focusIsScope && (await S.j('GET', `/api/projects/${pidNone}/git-write-policy`)).d?.policy?.mode === 'release', s3);
        await page.click('.agit-never-off');
        const p4 = await waitFor(async () => { const d = (await S.j('GET', `/api/projects/${pidNone}/git-write-policy`)).d?.policy; return d?.mode === 'none' ? d : null; }, 12_000);
        await sleep(800);
        const s4 = await state();
        check('C4 "Turn agent commits off" — the user\'s explicit choice — sets mode none and the warning goes away', p4?.mode === 'none' && !s4.warning, { mode: p4?.mode, warning: s4.warning });
        await page.goto('about:blank');
        await openAgit(pidTyped);
        check('C5 no warning for a release-mode project whose board has typed verdicts', !(await state()).warning);
        check('C6 no page errors', errors.length === 0, errors);
      } finally { await browser.close(); }
    }
  } finally { await S.stop(); }

  /* ── B6: must-FAIL — the station from a mutant tree whose release lib lacks the branch ── */
  console.log('B6 MUST-FAIL: the same station from a constructed mutant tree (release lib without the never-releases branch)');
  const mroot = buildMutantTree({ prefix: 'noverdict-mutant-', copy: ['src', 'scripts'], edits: [{ file: 'scripts/lib/release.mjs', from: NEVER_BRANCH, to: '' }, { file: 'scripts/release.mjs', from: CLI_AUTO_BRANCH, to: '' }] });
  dirs.push(mroot);
  const M = await boot(mroot, 'm');
  try {
    const pid = await M.add(repoNone);
    const put = await M.j('PUT', `/api/projects/${pid}/git-write-policy`, { commit: true, push: false, scope: null });
    await sleep(12_000); // ≥ 5 ticks
    const cards = await neverCards(M, pid);
    check('B6 on the mutant: release mode, no typed verdicts, ≥ 5 ticks — and NO card (the pre-fix silence the suite exists to catch)', put.d?.policy?.mode === 'release' && cards.length === 0, { mode: put.d?.policy?.mode, cards: cards.length });
  } finally { await M.stop(); }

  console.log('B9 MUST-FAIL: the same flip on a constructed mutant whose card is never reconciled with the predicate');
  const mroot2 = buildMutantTree({ prefix: 'noverdict-mutant2-', copy: ['src'], edits: [{ file: 'src/server/index.ts', from: '  if (!open.length || await neverReleasesNow(p)) return;\n', to: '  return;\n' }] });
  dirs.push(mroot2);
  const M2 = await boot(mroot2, 'm2');
  try {
    const F2 = await flipCase(M2, 'm2');
    const holds = F2.cardBefore && F2.warnBefore && !F2.warnAfter && F2.cardsAfter === 0 && F2.cardsLater === 0;
    check('B9 on the mutant the warning clears but the card STAYS OPEN — the B8 property fails there (non-vacuous)', F2.cardBefore && !F2.warnAfter && F2.cardsAfter === 1 && !holds, F2);
  } finally { await M2.stop(); }
} catch (e) {
  check(`suite threw: ${e.stack?.split('\n').slice(0, 3).join(' | ') ?? e}`, false);
} finally {
  if (!KEEP) for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  else console.log(`kept: ${dirs.join(' ')}`);
}
console.log(`\nTOTAL: ${pass} passed, ${fail} failed${failures.length ? `\nFAILED:\n  - ${failures.join('\n  - ')}` : ''}`);
process.exit(fail ? 1 : 0);
