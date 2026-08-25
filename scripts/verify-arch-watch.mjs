/**
 * FEAT-056 — the architecture-review loop: recurrence detector + ARCH ticket
 * class + consolidation hook + per-project rail surfacing.
 *
 *   node scripts/verify-arch-watch.mjs
 *
 * Everything is real and everything is SCRATCH: scratch board fixtures in
 * tmpdir, a scratch METHODOLOGY_DIR (so no pass ever touches the real
 * methodology repo), a scratch server on an OS-assigned free port (never 4317),
 * processes killed by PID. The one thing deliberately touched in the real repo
 * is `scripts/arch-watch.mjs` — section 6 REPLACES it with a syntactically
 * broken file to prove a broken detector cannot break server boot, and restores
 * it in a `finally` (plus on SIGINT/SIGTERM).
 *
 * Proves:
 *   1. a 3-ticket subsystem cluster raises a finding that NAMES its evidence;
 *      a 1-ticket subsystem stays silent (non-vacuity: the same run parses both);
 *   2. finding ids are stable across re-runs and CHANGE when a new ticket joins
 *      the cluster (the dismissal contract);
 *   3. ARCH-### ids round-trip through board.mjs check/gen with no drift, and
 *      real drift on an ARCH ticket is still caught;
 *   4. the consolidation pass runs the arch pass (--check-arch standalone too)
 *      and is failure-tolerant on a broken/absent board;
 *   5. through a REAL server: the finding surfaces on THAT project's Needs-You
 *      rail (and not on another project's), Dismiss sticks across a re-run, and
 *      a NEW ticket joining the cluster re-raises it;
 *   6. a deliberately broken arch-watch.mjs never breaks server boot.
 *   7. ACCEPTANCE: run against THIS repo's REAL board and rediscover the
 *      agent-strip liveness class (BUG-004/017/020/030/033/034) unprompted.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ARCH_WATCH = path.join(ROOT, 'scripts', 'arch-watch.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const INDEX_HEAD = '# Board\n\n## Open\n\n| ID | Title | Owner | Status | Sev |\n|----|-------|-------|--------|-----|\n';

function writeIndex(bugs, openRows, doneRows) {
  fs.writeFileSync(
    path.join(bugs, 'INDEX.md'),
    `${INDEX_HEAD}${openRows.join('\n')}${openRows.length ? '\n' : ''}\n` +
      `## Done (committed)\n\n| ID | Title | Commit |\n|----|-------|--------|\n${doneRows.join('\n')}${doneRows.length ? '\n' : ''}\n` +
      '## Shipped earlier (pre-tracker)\nNothing.\n',
  );
}

function ticket(bugs, { id, slug, title, area, status, reported }) {
  fs.writeFileSync(
    path.join(bugs, `${id}-${slug}.md`),
    `# ${id} — ${title}\n\n- **Status:** ${status}\n- **Severity:** med\n- **Area:** ${area}\n` +
      `- **Reported:** ${reported} by verify\n\n## Symptom\nx\n\n## Activity log (APPEND-ONLY)\n`,
  );
}

/**
 * A board with ONE genuine recurrence class (three closed tickets whose declared
 * Area + title share "widget cache invalidation" vocabulary) and ONE unrelated
 * singleton. Deliberately NOT a copy of the real board's wording — the detector
 * must find the class from the fixture's own text.
 */
function seedBoard(dir) {
  const bugs = path.join(dir, 'docs', 'bugs');
  fs.mkdirSync(bugs, { recursive: true });
  const cluster = [
    ['BUG-901', 'widget-cache-stale-after-write', 'widget cache serves a stale widget after a write', 'widget cache invalidation', '2026-07-02'],
    ['BUG-902', 'widget-cache-miss-on-rename', 'widget cache invalidation misses a renamed widget', 'widget cache invalidation / rename path', '2026-07-11'],
    ['BUG-903', 'widget-cache-warm-race', 'widget cache warm races an invalidation and resurrects a stale widget', 'widget cache invalidation / warm race', '2026-07-19'],
  ];
  for (const [id, slug, title, area, reported] of cluster) {
    ticket(bugs, { id, slug, title, area, status: 'VERIFIED', reported });
  }
  ticket(bugs, {
    id: 'BUG-950', slug: 'invoice-pdf-margins', title: 'invoice PDF renders with wrong margins',
    area: 'billing / invoice PDF layout', status: 'VERIFIED', reported: '2026-07-05',
  });
  writeIndex(bugs, [], [
    ...cluster.map(([id, , title]) => `| ${id} | ${title} | abc123 |`),
    '| BUG-950 | invoice PDF renders with wrong margins | abc123 |',
  ]);
  return bugs;
}

function runArch(bugs, extra = []) {
  const r = spawnSync(process.execPath, [ARCH_WATCH, `--dir=${bugs}`, '--json', ...extra], { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* reported by the caller */ }
  return { r, json };
}

// ---------------------------------------------------------------------------

let server = null;
let archBackup = null;
function restoreArchWatch() {
  if (archBackup === null) return;
  fs.writeFileSync(ARCH_WATCH, archBackup);
  archBackup = null;
  console.log('        (restored scripts/arch-watch.mjs)');
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { restoreArchWatch(); stopByPid(server); process.exit(130); });
}

async function main() {
  const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-arch-'));
  const PROJ = path.join(SCRATCH, 'projA');
  const OTHER = path.join(SCRATCH, 'projB');
  const bugs = seedBoard(PROJ);
  const otherBugs = seedBoard(OTHER);
  // Project B keeps only the singleton — it must never show project A's cluster.
  for (const f of fs.readdirSync(otherBugs)) if (/^BUG-90[123]-/.test(f)) fs.rmSync(path.join(otherBugs, f));

  console.log('\n=== 1. a 3-ticket cluster raises a finding WITH evidence; a 1-ticket subsystem is silent ===');
  const { r: r1, json: j1 } = runArch(bugs);
  check('detector ran and parsed the whole fixture board (non-vacuity: 4 tickets, not 0)',
    !!j1 && j1.ticketCount === 4, j1 ? `ticketCount=${j1.ticketCount} exit=${r1.status}` : `no JSON; exit=${r1.status} ${r1.stderr}`);
  if (!j1) throw new Error('detector produced no JSON — nothing downstream can pass');
  check('exactly ONE cluster is flagged', j1.flagged.length === 1, j1.flagged.map((c) => `${c.label}:${c.members}`));
  const cl = j1.flagged[0] ?? { members: [] };
  check('the flagged cluster is exactly the three widget-cache tickets',
    cl.members.join(',') === 'BUG-901,BUG-902,BUG-903', cl.members);
  check('the singleton (BUG-950, a different subsystem) is in NO flagged cluster',
    !j1.flagged.some((c) => c.members.includes('BUG-950')), j1.flagged.map((c) => c.members));
  const f1 = j1.findings ?? [];
  check('one finding is emitted, of type arch-recurrence',
    f1.length === 1 && f1[0].type === 'arch-recurrence', f1.map((f) => f.type));
  check('the finding NAMES its evidence: every member ticket id + the threshold it crossed',
    !!f1[0] && ['BUG-901', 'BUG-902', 'BUG-903'].every((id) => f1[0].summary.includes(id)) &&
      /3 closed tickets/.test(f1[0].summary),
    f1[0]?.summary);
  check('exit code 1 signals "recurrence found"', r1.status === 1, r1.status);

  console.log('\n=== 1b. a board BELOW threshold stays silent (the guard is not vacuous) ===');
  const quiet = path.join(SCRATCH, 'quiet');
  const quietBugs = seedBoard(quiet);
  for (const f of fs.readdirSync(quietBugs)) if (/^BUG-90[23]-/.test(f)) fs.rmSync(path.join(quietBugs, f));
  const { r: rq, json: jq } = runArch(quietBugs);
  check('a board whose largest subsystem has 1 closed ticket raises NOTHING (exit 0)',
    rq.status === 0 && jq.flagged.length === 0 && (jq.findings ?? []).length === 0,
    `exit=${rq.status} flagged=${JSON.stringify(jq?.flagged?.map((c) => c.members))}`);

  console.log('\n=== 1c. BUG-093: the PRODUCT NAME never forms a cluster (must-FAIL control: without the fix, it does) ===');
  // A board shaped exactly like the false `[claude+station]` finding: five
  // tickets whose ONLY common vocabulary is the product name, written into
  // generically-worded Area lines, over five unrelated parts of the system —
  // plus the genuine widget-cache class, which must survive untouched.
  const PRODUCT = path.join(SCRATCH, 'acme-portal');
  const productBugs = seedBoard(PRODUCT);
  fs.writeFileSync(path.join(PRODUCT, 'package.json'), JSON.stringify({ name: 'acme-portal' }));
  const decoys = [
    ['BUG-960', 'topbar-crown-padding', 'crown badge is 2px off in the topbar', 'acme portal / topbar CSS', '2026-07-03'],
    ['BUG-961', 'model-write-path-drops-override', 'model override is dropped on write', 'acme portal / model write path', '2026-07-06'],
    ['FEAT-960', 'brand-svg-refresh', 'refresh the brand mark', 'acme portal / branding SVG', '2026-07-09'],
    ['FEAT-961', 'methodology-doc-links', 'link the methodology docs from the readme', 'acme portal / methodology documentation', '2026-07-13'],
    ['FEAT-962', 'deploy-script-flag', 'add a dry-run flag to the deploy script', 'acme portal / deploy script', '2026-07-16'],
  ];
  for (const [id, slug, title, area, reported] of decoys) {
    ticket(productBugs, { id, slug, title, area, status: 'VERIFIED', reported });
  }
  const isProductCluster = (c) => c.tokens.some((t) => ['acme', 'portal'].includes(t));
  const { json: jCtl } = runArch(productBugs, ['--no-project-stopwords']);
  const ctlProduct = (jCtl?.flagged ?? []).filter(isProductCluster);
  check('MUST-FAIL CONTROL — without the stopword seed the product name DOES form a flagged catch-all cluster',
    ctlProduct.length === 1 && decoys.every(([id]) => ctlProduct[0].members.includes(id)),
    ctlProduct.map((c) => `[${c.label}] ${c.members.join(',')}`).join(' | ') || 'no product cluster (fixture is vacuous!)');
  const { json: jFix } = runArch(productBugs);
  check('the derived seed contains the product-name tokens (from the repo dir + package.json name)',
    ['acme', 'portal'].every((t) => (jFix?.config?.stopwords ?? []).includes(t)), jFix?.config?.stopwords);
  check('BUG-093 FIX — with the seed on, NO cluster forms on the product-name tokens',
    (jFix?.flagged ?? []).filter(isProductCluster).length === 0 &&
      !(jFix?.clusters ?? []).some(isProductCluster),
    (jFix?.clusters ?? []).map((c) => `[${c.label}] ${c.members.length}`).join(' '));
  check('none of the five unrelated product-name tickets is glued into ANY flagged cluster',
    decoys.every(([id]) => !(jFix?.flagged ?? []).some((c) => c.members.includes(id))),
    (jFix?.flagged ?? []).map((c) => `[${c.label}] ${c.members.join(',')}`).join(' | '));
  check('NOT over-suppressed: the genuine widget-cache class still forms, intact, on the same board',
    (jFix?.flagged ?? []).some((c) => c.members.join(',') === 'BUG-901,BUG-902,BUG-903'),
    (jFix?.flagged ?? []).map((c) => `[${c.label}] ${c.members.join(',')}`).join(' | '));
  check('an explicit --stopwords= seed is additive (a service alias can be suppressed too)',
    !runArch(productBugs, ['--stopwords=widget']).json.flagged.some((c) => c.tokens.includes('widget')),
    runArch(productBugs, ['--stopwords=widget']).json.flagged.map((c) => c.label));

  console.log('\n=== 2. finding id: stable across re-runs, CHANGES when a new ticket joins the cluster ===');
  const { json: j2 } = runArch(bugs);
  check('re-running the detector on an unchanged board yields the SAME finding id (a dismissal can hold)',
    j2.findings[0].id === f1[0].id, `${f1[0].id} → ${j2.findings[0].id}`);
  ticket(bugs, {
    id: 'BUG-904', slug: 'widget-cache-invalidate-on-delete',
    title: 'widget cache invalidation skips a deleted widget', area: 'widget cache invalidation / delete path',
    status: 'VERIFIED', reported: '2026-07-25',
  });
  const { json: j3 } = runArch(bugs);
  check('a NEW ticket joining the cluster changes the finding id (the question is re-raised)',
    j3.findings[0].id !== f1[0].id && j3.flagged[0].members.includes('BUG-904'),
    `${f1[0].id} → ${j3.findings[0].id}; members=${j3.flagged[0].members}`);
  fs.rmSync(path.join(bugs, 'BUG-904-widget-cache-invalidate-on-delete.md'));

  console.log('\n=== 3. ARCH-### ids round-trip through board.mjs check/gen with no drift ===');
  const boardMjs = path.join(ROOT, 'scripts', 'board.mjs');
  const runBoard = (cmd) => spawnSync(process.execPath, [boardMjs, cmd, `--dir=${bugs}`], { encoding: 'utf8' });
  ticket(bugs, {
    id: 'ARCH-001', slug: 'widget-cache-ownership',
    title: 'widget cache invalidation has no single owner', area: 'widget cache invalidation',
    status: 'OPEN', reported: '2026-07-26',
  });
  const beforeGen = runBoard('check');
  check('an ARCH ticket missing from INDEX.md is CAUGHT as drift (the tool knows the prefix)',
    beforeGen.status === 1 && /MISSING FROM BOARD: ARCH-001/.test(beforeGen.stdout), beforeGen.stdout.trim().split('\n').slice(-2).join(' | '));
  runBoard('gen');
  const afterGen = runBoard('check');
  check('after board:gen the ARCH ticket is on the board and check is CLEAN (no drift)',
    afterGen.status === 0 && /ARCH-001/.test(fs.readFileSync(path.join(bugs, 'INDEX.md'), 'utf8')),
    afterGen.stdout.trim().split('\n').slice(-1)[0]);
  const idxOpen = fs.readFileSync(path.join(bugs, 'INDEX.md'), 'utf8');
  check('the ARCH row landed in the OPEN table (status OPEN)',
    idxOpen.split('## Done')[0].includes('| ARCH-001 |'), idxOpen.split('\n').filter((l) => l.includes('ARCH-001')).join(' | '));
  const archFile = path.join(bugs, 'ARCH-001-widget-cache-ownership.md');
  fs.writeFileSync(archFile, fs.readFileSync(archFile, 'utf8').replace('- **Status:** OPEN', '- **Status:** VERIFIED'));
  const drift = runBoard('check');
  check('status drift on an ARCH ticket is caught like any other ticket',
    drift.status === 1 && /STATUS MISMATCH: ARCH-001/.test(drift.stdout), drift.stdout.match(/.*ARCH-001.*/)?.[0]);
  runBoard('gen');
  const settled = runBoard('check');
  const idxDone = fs.readFileSync(path.join(bugs, 'INDEX.md'), 'utf8');
  check('board:gen moves the closed ARCH ticket to Done and check goes clean again (round-trip, no drift)',
    settled.status === 0 && idxDone.split('## Done')[1].includes('| ARCH-001 |'),
    settled.stdout.trim().split('\n').slice(-1)[0]);
  fs.rmSync(archFile);
  runBoard('gen');

  console.log('\n=== 4. consolidation integration + failure tolerance ===');
  const METH = path.join(SCRATCH, 'meth');
  fs.mkdirSync(METH, { recursive: true });
  fs.writeFileSync(path.join(METH, 'WORKING_AGREEMENT.v2.md'), '# WA (scratch)\n\n## T\n\n### A. Rule\n\n- Prefer small diffs, because review is cheaper.\n');
  for (const a of [['init', '-q'], ['config', 'user.email', 'a@b.c'], ['config', 'user.name', 'v'], ['add', '-A'], ['commit', '-q', '-m', 'x']]) {
    spawnSync('git', ['-C', METH, ...a], { encoding: 'utf8' });
  }
  const wa = (args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'wa-consolidate.mjs'), ...args], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, METHODOLOGY_DIR: METH },
  });
  const chk = wa(['--check-arch', '--board-dir', bugs]);
  check('`--check-arch` runs standalone against any board and exits 1 when a cluster is over threshold',
    chk.status === 1 && /arch-watch — 1 recurrence finding/.test(chk.stdout), chk.stdout.trim().split('\n')[0]);
  check('`--check-arch` persisted findings into the PROJECT board dir (.arch/findings.json)',
    fs.existsSync(path.join(bugs, '.arch', 'findings.json')) &&
      JSON.parse(fs.readFileSync(path.join(bugs, '.arch', 'findings.json'), 'utf8')).findings.length === 1,
    path.join(bugs, '.arch', 'findings.json'));
  check('.arch/ ships a self-ignoring .gitignore (derived state is never committed)',
    fs.readFileSync(path.join(bugs, '.arch', '.gitignore'), 'utf8').trim() === '*', 'docs/bugs/.arch/.gitignore');
  const missing = wa(['--check-arch', '--board-dir', path.join(SCRATCH, 'no-such-board')]);
  check('an ABSENT board is an honest skip, not a crash (exit 0)',
    missing.status === 0 && /skipped/.test(missing.stdout), missing.stdout.trim());
  const brokenBoard = path.join(SCRATCH, 'brokenboard', 'docs', 'bugs');
  fs.mkdirSync(brokenBoard, { recursive: true });
  fs.writeFileSync(path.join(brokenBoard, 'BUG-001-garbage.md'), '\0\0not markdown at all');
  const brk = wa(['--check-arch', '--board-dir', brokenBoard]);
  check('a MALFORMED board never crashes the pass (exit 0, honest zero findings)',
    brk.status === 0 && /0 recurrence finding/.test(brk.stdout), brk.stdout.trim());
  const full = wa(['--conventions-dir', PROJ]);
  check('a FULL consolidation pass (the boot/post-capture path) runs the arch pass on the owning project board',
    /arch-watch — 1 recurrence finding\(s\) for .*projA/.test(full.stdout), full.stdout.match(/.*arch-watch.*/)?.[0]);
  check('the WA half of that pass is unaffected by the arch pass (invariant line still printed)',
    /invariant OK: WA unchanged/.test(full.stdout), full.stdout.match(/.*invariant OK.*/)?.[0]);

  console.log('\n=== 5. REAL server: the finding surfaces on THAT project rail, dismiss sticks, new ticket re-raises ===');
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-arch-data-'));
  const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-arch-store-'));
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE, METHODOLOGY_DIR: METH },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let serverLog = '';
  server.stderr?.on('data', (d) => { serverLog += String(d); });
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(250); }
  }
  if (!up) throw new Error('scratch server never became healthy');
  const register = async (base, hostPath, name) => {
    const j = await (await fetch(`${base}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath, name }),
    })).json();
    if (j.project?.id) return j.project.id;
    // Already registered (the scratch data dir is shared with the section-6
    // server) — find it instead of failing.
    const all = await (await fetch(`${base}/api/projects`)).json();
    return (all.projects ?? []).find((p) => path.resolve(p.hostPath) === path.resolve(hostPath))?.id ?? null;
  };
  const boardOf = async (id) => (await fetch(`${BASE}/api/projects/${id}/board`)).json();
  const idA = await register(BASE, PROJ, 'Proj A');
  const idB = await register(BASE, OTHER, 'Proj B');
  const bA = await boardOf(idA);
  // FEAT-079: a bare arch-recurrence COUNT is a read-only OBSERVATION, not an
  // ask — it lands in board.observations, never board.needsYou.
  const rowsA = (bA.observations ?? []).filter((x) => x.kind === 'finding');
  check('project A rail carries the arch finding as a READ-ONLY OBSERVATION (no question) with its evidence',
    rowsA.length === 1 && rowsA[0].question === undefined && /Architecture review/.test(rowsA[0].title) &&
      /BUG-901/.test(rowsA[0].detail ?? ''),
    JSON.stringify(rowsA.map((x) => ({ id: x.id, title: x.title, q: x.question }))));
  check('FEAT-079: the bare arch finding is NOT on the decision rail (needsYou has no finding)',
    (bA.needsYou ?? []).filter((x) => x.kind === 'finding').length === 0,
    JSON.stringify((bA.needsYou ?? []).map((x) => ({ id: x.id, kind: x.kind }))));
  const bB = await boardOf(idB);
  check('project B rail carries NONE of project A\'s findings (per-project scoping)',
    (bB.observations ?? []).filter((x) => x.kind === 'finding').length === 0 &&
      (bB.needsYou ?? []).filter((x) => x.kind === 'finding').length === 0,
    JSON.stringify((bB.observations ?? []).map((x) => x.id)));
  const dismiss = await fetch(`${BASE}/api/projects/${idA}/board/dismiss`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: rowsA[0].id }),
  });
  check('dismiss is accepted for a project finding on a NON-methodology-home project',
    dismiss.status === 200, `${dismiss.status}`);
  check('the dismissed row leaves the observations lane',
    ((await boardOf(idA)).observations ?? []).filter((x) => x.kind === 'finding').length === 0, 'rail after dismiss');
  wa(['--check-arch', '--board-dir', bugs]);
  check('dismissal STICKS across a re-run that re-detects the same cluster',
    ((await boardOf(idA)).observations ?? []).filter((x) => x.kind === 'finding').length === 0, 'rail after re-run');
  ticket(bugs, {
    id: 'BUG-905', slug: 'widget-cache-invalidate-on-move',
    title: 'widget cache invalidation misses a moved widget', area: 'widget cache invalidation / move path',
    status: 'VERIFIED', reported: '2026-07-28',
  });
  wa(['--check-arch', '--board-dir', bugs]);
  const reRaised = ((await boardOf(idA)).observations ?? []).filter((x) => x.kind === 'finding');
  check('a NEW ticket joining the cluster RE-RAISES the finding despite the earlier dismissal',
    reRaised.length === 1 && /BUG-905/.test(reRaised[0].detail ?? ''), reRaised[0]?.detail?.slice(0, 120));
  stopByPid(server);
  server = null;
  await sleep(500);

  console.log('\n=== 6. a deliberately BROKEN arch-watch.mjs never breaks server boot ===');
  const PORT2 = await freePort();
  const BASE2 = `http://127.0.0.1:${PORT2}`;
  let bootLog = '';
  try {
    archBackup = fs.readFileSync(ARCH_WATCH, 'utf8');
    fs.writeFileSync(ARCH_WATCH, 'this is not ( valid javascript ===== {{{\n');
    const broken = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'wa-consolidate.mjs'), '--check-arch', '--board-dir', bugs], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, METHODOLOGY_DIR: METH },
    });
    check('a broken arch-watch degrades the standalone pass to a warning (exit 0, never a crash)',
      broken.status === 0 && /arch-watch pass failed/.test(broken.stdout + broken.stderr),
      (broken.stdout + broken.stderr).trim().split('\n').slice(-1)[0]);
    server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT2), CLAUDE_STATION_DATA: DATA, CLAUDE_PROJECTS_DIR: STORE, METHODOLOGY_DIR: METH },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.on('data', (d) => { bootLog += String(d); });
    server.stderr?.on('data', (d) => { bootLog += String(d); });
    let up2 = false;
    for (let i = 0; i < 80 && !up2; i++) {
      try { await fetch(`${BASE2}/api/health`); up2 = true; } catch { await sleep(250); }
    }
    check('the server BOOTED and SERVES with a broken arch-watch on disk', up2, `${BASE2}/api/health`);
    const idA2 = up2 ? await register(BASE2, PROJ, 'Proj A2').catch(() => null) : null;
    check('the board route still answers with a broken detector (rail degrades, never 500s)',
      !!idA2 && Array.isArray((await (await fetch(`${BASE2}/api/projects/${idA2}/board`)).json()).needsYou),
      idA2 ? 'board route OK' : 'no project');
    // The boot consolidation pass must still COMPLETE (the server logs its
    // outcome) — the honest per-failure warning text is asserted on the
    // standalone run above; here the point is that boot is unaffected.
    for (let i = 0; i < 40 && !/WA consolidation pass/.test(bootLog); i++) await sleep(250);
    check('the boot consolidation pass still ran to completion and reported its outcome',
      /WA consolidation pass/.test(bootLog), bootLog.split('\n').filter((l) => /consolidation/.test(l)).slice(-1)[0] ?? '(no consolidation line)');
  } finally {
    stopByPid(server);
    server = null;
    restoreArchWatch();
  }

  console.log('\n=== 7. ACCEPTANCE — the REAL board, unprompted: does it rediscover the liveness class? ===');
  const { json: real } = runArch(path.join(ROOT, 'docs', 'bugs'));
  check('the real board is actually being read (non-vacuity: 70+ tickets)',
    !!real && real.ticketCount >= 70, `ticketCount=${real?.ticketCount}`);
  const TARGET = ['BUG-004', 'BUG-017', 'BUG-020', 'BUG-030', 'BUG-033', 'BUG-034'];
  const covering = real.flagged.filter((c) => c.members.some((m) => TARGET.includes(m)));
  const covered = new Set(covering.flatMap((c) => c.members.filter((m) => TARGET.includes(m))));
  console.log(`        clusters touching the class:\n${covering.map((c) => `          [${c.label}] ${c.members.join(', ')}`).join('\n')}`);
  check('EVERY member of the agent-strip liveness class lands in a FLAGGED cluster (found without being told)',
    TARGET.every((id) => covered.has(id)), `covered: ${[...covered].sort().join(', ')}`);
  check('the class is found in at most 2 adjacent clusters, not smeared across the board',
    covering.length <= 2, `${covering.length} cluster(s)`);
  const stripCluster = real.flagged.find((c) => ['BUG-020', 'BUG-030', 'BUG-033', 'BUG-034'].every((id) => c.members.includes(id)));
  check('the agent-strip cluster proper (BUG-020/030/033/034 — the 5-patch class BUG-034 escalated) is one flagged cluster',
    !!stripCluster, stripCluster ? `[${stripCluster.label}] ${stripCluster.members.join(', ')}` : 'not found');
  // Git corroboration is EVIDENCE, not the partition (see arch-watch's header),
  // and it is only derivable while the commits that named those ids are still in
  // this repo's history — the 2026-08-13 relocation to `orchard` re-based the repo
  // onto a fresh history, so `git log --grep=BUG-020` now matches nothing and the
  // class's file evidence is unrecoverable HERE. Assert what the detector controls:
  // when git DOES attribute commits to a flagged cluster, the shared files must be
  // reported. Non-vacuity is guaranteed by requiring at least one flagged cluster
  // on the real board to carry file evidence.
  const withFiles = real.flagged.filter((c) => c.files.length);
  check('shared-file evidence IS reported for flagged clusters whose ids are still attributable in git history',
    withFiles.length >= 1,
    `${withFiles.length} flagged cluster(s) with files, e.g. [${withFiles[0]?.label}] ${withFiles[0]?.files.join(', ')}`);
  check('the agent-strip cluster carries file evidence, or git has no commits naming its ids at all (fresh-history repo)',
    !!stripCluster &&
      (stripCluster.files.some((f) => /agent-bridge/.test(f)) ||
        spawnSync('git', ['-C', ROOT, 'log', '--all', '--format=%H', '--grep=BUG-020'], { encoding: 'utf8' }).stdout.trim() === ''),
    stripCluster?.files.length ? stripCluster.files : 'files=[] and 0 commits name BUG-020 (history was rebuilt)');
  // BUG-093 on the REAL board: the `[claude+station]` catch-all (12 tickets, no
  // shared files, unrelated fixes) must not exist, while the coherent classes the
  // grounded triage confirmed as real — the agent adopt/restart liveness class and
  // the sidebar/rendertree class, both with shared files — must still form.
  const PRODUCT_TOKENS = ['claude', 'station', 'orchard'];
  check('BUG-093 — no flagged cluster on this repo is labelled with a PRODUCT-NAME token',
    !real.flagged.some((c) => c.tokens.some((t) => PRODUCT_TOKENS.includes(t))),
    real.flagged.filter((c) => c.tokens.some((t) => PRODUCT_TOKENS.includes(t))).map((c) => `[${c.label}] ${c.members.join(',')}`).join(' | ') || 'none');
  check('BUG-093 — the 12-ticket false cluster (BUG-026+FEAT-017/020/022/023/024/030/032/034/035/036) is gone',
    !real.flagged.some((c) => ['BUG-026', 'FEAT-017', 'FEAT-022', 'FEAT-035'].every((id) => c.members.includes(id))),
    real.flagged.filter((c) => c.members.includes('FEAT-017')).map((c) => `[${c.label}] ${c.members.join(',')}`).join(' | ') || 'FEAT-017 in no flagged cluster');
  check('BUG-093 — not over-suppressed: the coherent adopt/drain/restart liveness class still forms',
    real.flagged.some((c) => ['BUG-022', 'BUG-044', 'BUG-048', 'BUG-072'].every((id) => c.members.includes(id))),
    real.flagged.filter((c) => c.members.includes('BUG-044')).map((c) => `[${c.label}] ${c.members.join(',')} files=${c.files.length}`).join(' | '));
  check('BUG-093 — not over-suppressed: the app/sidebar/rendertree class still forms with shared-file evidence',
    real.flagged.some((c) => ['BUG-085', 'FEAT-070', 'FEAT-073', 'FEAT-074'].every((id) => c.members.includes(id)) && c.files.length > 0),
    real.flagged.filter((c) => c.members.includes('FEAT-073')).map((c) => `[${c.label}] ${c.members.join(',')} files=${c.files.length}`).join(' | '));

  const other = real.flagged.filter((c) => !covering.includes(c));
  console.log(`        other flagged clusters (${other.length}) — for the human, not asserted:\n${other.map((c) => `          [${c.label}] (${c.closed.length} closed) ${c.members.join(', ')}`).join('\n')}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log(`FAILURES:\n${failures.map((f) => `  - ${f}`).join('\n')}`); process.exit(1); }
}

main().catch((e) => {
  console.error(`\nFATAL: ${e.stack || e.message}`);
  restoreArchWatch();
  stopByPid(server);
  process.exit(1);
});
