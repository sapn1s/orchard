#!/usr/bin/env node
/**
 * FEAT-157 — the server side, through a REAL scratch server on the FEAT-158
 * sandbox daemon: the one-time migration at boot (legacy pins, no recreate, no
 * history lost, crash-resume, recovery), the derived rail card, the answer
 * routes (stale revision, concurrent answers, security skip refused, settings
 * PATCH refused, forged decision records), the agent's dispatch-socket op (its
 * own project only), and the rail card in a real headless browser (both themes).
 *
 *   npm run sandbox:docker -- up && eval "$(npm run -s sandbox:docker -- env)"
 *   node scripts/verify-feat-157-server.mjs [--tree <dir>] [--shots <dir>]
 *
 * The registry is SYNTHETIC but shaped like this machine's (labelled so): several
 * container projects on legacy bases (5 base-direct + 1 Dockerfile on the real
 * machine), one with no container, one on a prebuilt image, plus direct projects.
 * Docker objects live in per-run scratch repos behind a shim (as in
 * verify-feat-157-lifecycle.mjs); only the SERVER child gets the shim.
 */
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { assertIsolatedDocker } from './lib/docker-sandbox.mjs';
import { isolatedServerEnv } from './lib/station-boot.mjs';
import { shotLedger } from './lib/shot-luma.mjs';

const { target: TARGET } = assertIsolatedDocker('verify-feat-157-server');

const REPO = path.resolve(import.meta.dirname, '..');
const ti = process.argv.indexOf('--tree');
const SRC_TREE = ti > 0 ? path.resolve(process.argv[ti + 1]) : REPO;
const si = process.argv.indexOf('--shots');
const SHOTS = si > 0 ? path.resolve(process.argv[si + 1]) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (n, ok, obs) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}\n        observed: ${obs}`); ok ? pass++ : fail++; };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'feat157-srv-'));
const TREE = path.join(TMP, 'tree');
const DATA = path.join(TMP, 'data');
fs.mkdirSync(TREE, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });
for (const d of ['src', 'public']) fs.cpSync(path.join(SRC_TREE, d), path.join(TREE, d), { recursive: true });
// The server imports some scripts/*.mjs and reads docs/prompts; copy them whole (the tree under test's own).
fs.cpSync(path.join(SRC_TREE, 'scripts'), path.join(TREE, 'scripts'), { recursive: true, filter: (p) => !/\/scripts\/fixtures(\/|$)/.test(p) });
fs.mkdirSync(path.join(TREE, 'docs'), { recursive: true });
if (fs.existsSync(path.join(REPO, 'docs', 'prompts'))) fs.cpSync(path.join(REPO, 'docs', 'prompts'), path.join(TREE, 'docs', 'prompts'), { recursive: true });
fs.copyFileSync(path.join(SRC_TREE, 'package.json'), path.join(TREE, 'package.json'));
fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(TREE, 'node_modules'));

const RUN_ID = `${process.pid}${Date.now() % 100000}`;
const SCRATCH_BASE = `claude-station-f157sb-${RUN_ID}`;
const SCRATCH_RT = `claude-station-f157sr-${RUN_ID}`;
const dk = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const dkTry = (args) => { const r = spawnSync('docker', args, { encoding: 'utf8' }); return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }; };
const seedLine = dk(['images', '--format', '{{.Repository}}:{{.Tag}} {{.ID}}']).split('\n').find((l) => /^claude-station-base:u\d+-g\d+-[0-9a-f]{12} /.test(l));
if (!seedLine) { console.error('no hashed claude-station-base image in the sandbox (npm run sandbox:docker -- up)'); process.exit(2); }
const SEED = seedLine.split(/\s+/)[1];
const SEED_HASH = dk(['image', 'inspect', SEED, '--format', '{{index .Config.Labels "claude-station.provision-hash"}}']);

const SHIM = path.join(TMP, 'docker-shim');
fs.writeFileSync(SHIM, `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const MAP = [['claude-station-base', ${JSON.stringify(SCRATCH_BASE)}], ['claude-station-rt', ${JSON.stringify(SCRATCH_RT)}]];
const fwd = (a) => MAP.reduce((s, [r, x]) => s.split(r + ':').join(x + ':').replace(new RegExp('^' + r + '$'), x), a);
const argv = process.argv.slice(2).map(fwd);
const child = spawn('docker', argv, { stdio: ['inherit', 'pipe', 'pipe'] });
const back = (s) => MAP.reduce((t, [r, x]) => t.split(x).join(r), s);
child.stdout.on('data', (d) => process.stdout.write(argv[0] === 'cp' ? d : back(String(d)))); // FEAT-157: docker cp to stdout is a binary tar stream
child.stderr.on('data', (d) => process.stderr.write(back(String(d))));
process.stdout.on('error', () => process.exit(1)); // a closed reader (EPIPE) must end the shim, never hang it
child.on('close', (c) => process.stdout.write('', () => process.exit(c ?? 1))); // flush a piped stdout before exiting
`);
fs.chmodSync(SHIM, 0o755);
const HOME = path.join(TMP, 'home');
fs.mkdirSync(path.join(HOME, '.claude', 'projects'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.claude', '.credentials.json'), '{}\n');

const uid = os.userInfo().uid, gid = os.userInfo().gid;
const LEGACY_A = `u${uid}-g${gid}-${crypto.randomBytes(6).toString('hex')}`;
const LEGACY_B = `u${uid}-g${gid}-${SEED_HASH}`;
dk(['tag', SEED, `${SCRATCH_BASE}:${LEGACY_A}`]);
dk(['tag', SEED, `${SCRATCH_BASE}:${LEGACY_B}`]);
const DF_IMAGE = `claude-station-project-f157df-${RUN_ID}:df-${crypto.randomBytes(6).toString('hex')}`;
{
  const c = dk(['create', SEED, 'true']);
  try { dk(['commit', '--change', 'LABEL claude-station.dockerfile-project=df', c, DF_IMAGE]); } finally { dkTry(['rm', '-f', c]); }
}

const createdContainers = [];
const servers = [];
function cleanup() {
  for (const s of servers) { try { process.kill(-s.pid, 'SIGKILL'); } catch { /* gone */ } }
  for (const n of createdContainers) dkTry(['rm', '-f', '-v', n]);
  for (const repo of [SCRATCH_BASE, SCRATCH_RT]) {
    for (const ref of dkTry(['images', repo, '--format', '{{.Repository}}:{{.Tag}}']).out.split('\n').filter((r) => r && !r.endsWith(':<none>'))) dkTry(['rmi', ref]);
  }
  dkTry(['rmi', DF_IMAGE]); dkTry(['rmi', `${DF_IMAGE}-spoof`]);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
}

async function freePort() { return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }
let base = '';
let serverLog = '';
async function boot() {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(TREE, 'src', 'server', 'index.ts')], {
    cwd: TREE, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: isolatedServerEnv({ PORT: String(port), CLAUDE_STATION_DATA: DATA, DOCKER_HOST: TARGET, CLAUDE_STATION_DOCKER: SHIM, HOME, CLAUDE_PROJECTS_DIR: path.join(HOME, '.claude', 'projects'), ORCHARD_DISPATCH_SOCK: '' }),
  });
  child.stdout.on('data', (x) => { serverLog = (serverLog + x).slice(-20000); });
  child.stderr.on('data', (x) => { serverLog = (serverLog + x).slice(-20000); });
  servers.push(child);
  base = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let i = 0; i < 160 && !healthy; i++) { try { await fetch(`${base}/api/health`); healthy = true; } catch { await sleep(250); } }
  if (!healthy) throw new Error(`server never became healthy: ${serverLog.slice(0, 2500)}`);
  // ARCH-022: the boot migration runs as lifecycle operations queued behind recovery; wait for its completion line.
  for (let i = 0; i < 240 && !/base-pin migration (done|skipped)/.test(serverLog); i++) await sleep(250);
}
async function api(p, method = 'GET', body, headers = {}) {
  const r = await fetch(base + p, { method, headers: body ? { 'content-type': 'application/json', ...headers } : headers, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* */ }
  return { status: r.status, body: j };
}
const cid = (name) => dkTry(['inspect', name, '--format', '{{.Id}}']).out || null;

/* ------------------------------------------------------ the rail, rendered */
const ledger = shotLedger();
const shotFiles = [];
async function shoot(list, last) {
  console.log(`--- the rail card in a real headless browser (both themes; synthetic busy fixture): ${list.map(([l]) => l).join(', ')}`);
  fs.mkdirSync(SHOTS, { recursive: true });
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.QA_BRAVE_PATH ?? '/usr/bin/brave' });
  try {
    // warm-up: the first page after a server restart (this suite restarts it for the socket step) is thrown away
    { const w = await browser.newPage(); await w.goto(`${base}/`, { waitUntil: 'load' }).catch(() => undefined); await new Promise((r) => setTimeout(r, 3000)); await w.close(); }
    for (const theme of ['light', 'dark']) {
      for (const [label, p] of list) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: theme });
        await page.addInitScript((t) => { try { localStorage.setItem('cs.theme', t); } catch { /* */ } }, theme);
        await page.goto(`${base}/#/project/${encodeURIComponent(p.id)}`, { waitUntil: 'load' }); // the dashboard keeps a live connection: never 'networkidle'
        // wait for the app to have loaded this project (a just-restarted server answers its first board read late: reload once)
        try { await page.getByText(p.id).first().waitFor({ state: 'visible', timeout: 30000 }); } catch { /* reported below */ }
        if (await page.getByText('server unreachable').count()) { await page.reload({ waitUntil: 'load' }); try { await page.getByText(p.id).first().waitFor({ state: 'visible', timeout: 30000 }); } catch { /* */ } }
        // The board grid shows the notice as a tile; clicking it mounts the answer card (the user's real path).
        const tile = page.locator(`.tc[data-id="base:${p.id}"]`);
        try { await tile.waitFor({ state: 'visible', timeout: 15000 }); await tile.click(); } catch { /* reported below */ }
        const card = page.locator(`.needs-card[data-id="base:${p.id}"]`);
        let visible = false;
        try { await card.waitFor({ state: 'visible', timeout: 15000 }); visible = true; } catch { /* reported */ }
        if (visible && await card.evaluate((c) => c.classList.contains('collapsed'))) await card.locator('.nc-chev').click();
        if (visible) await card.scrollIntoViewIfNeeded();
        const f = path.join(SHOTS, `feat157-${label}-${theme}.png`);
        await page.screenshot({ path: f, fullPage: false });
        const tileText = await tile.textContent().catch(() => null);
        const focusText = await page.locator('.rs-focus').textContent().catch(() => null);
        const info = visible ? await card.evaluate((c) => ({ kind: c.querySelector('.nc-kind')?.textContent, state: c.dataset.state, buttons: [...c.querySelectorAll('.nc-opt')].map((b) => b.textContent), entries: c.querySelectorAll('.bu-entry').length, collapsed: c.classList.contains('collapsed'), w: Math.round(c.getBoundingClientRect().width), overflowX: c.scrollWidth > c.clientWidth + 1 })) : null;
        check(`U ${label} (${theme}): tile and focus read "Orchard base" (no internal id); clicking opens the BASE card; nothing overflows`,
          visible && info?.kind === 'BASE' && !info.collapsed && !info.overflowX && /Orchard base/.test(tileText ?? '') && !/base:/.test(`${tileText}${focusText}`),
          `${JSON.stringify({ ...info, tile: tileText?.slice(0, 60), focus: focusText?.slice(0, 60) })} shot=${f}`);
        shotFiles.push({ f, theme });
        await page.close();
      }
    }
    if (last) {
      const graded = shotFiles.map((x) => ({ f: path.basename(x.f), ...ledger.record(x.f, x.theme) }));
      check('U every capture is distinct and its luminance matches its theme', graded.every((g) => g.ok), JSON.stringify(graded.map((g) => `${g.f}: ${g.why}`)));
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(`${base}/#/project/${encodeURIComponent(P_SECURITY)}`, { waitUntil: 'load' });
      try { await page.getByText(P_SECURITY).first().waitFor({ state: 'visible', timeout: 30000 }); } catch { /* reported below */ }
      await page.locator(`.tc[data-id="base:${P_SECURITY}"]`).click().catch(() => {});
      await sleep(1500);
      const secBtns = await page.locator(`.needs-card[data-id="base:${P_SECURITY}"] .nc-opt`).allTextContents().catch(() => []);
      check('U the security card offers no Skip in the rendered DOM', secBtns.length > 0 && !secBtns.some((t) => /skip/i.test(t)), JSON.stringify(secBtns));
      await page.close();
    }
  } finally { await browser.close(); }
}
let P_SECURITY = '';

console.log(`FEAT-157 server\n  tree under test: ${SRC_TREE}\n  scratch repos: ${SCRATCH_BASE}\n`);
try {
  /* -------------------------------------------- the pre-FEAT-157 world */
  process.env.CLAUDE_STATION_DATA = DATA;
  process.env.CLAUDE_STATION_DOCKER = SHIM; // in-process module use only (the guard already ran)
  process.env.HOME = HOME;
  const cm = await import(path.join(TREE, 'src/server/container-manager.ts'));
  const reg = await import(path.join(TREE, 'src/server/registry.ts'));
  const work = (n) => { const w = path.join(TMP, 'work', n); fs.mkdirSync(w, { recursive: true }); fs.writeFileSync(path.join(w, 'README.md'), `${n}\n`); return w; };
  const mk = (name, iso, container = {}) => reg.createProject({ hostPath: work(name), name: `${name}-${RUN_ID}`, isolation: iso, settings: { container: { gpu: 'off', ...container }, tools: { serena: false, playwright: false, openaiDispatch: false } } });
  const P = {
    legacyA: mk('legacy-a', 'container'), legacyA2: mk('legacy-a2', 'container'), df: mk('df', 'container', { dockerfile: 'Dockerfile.orchard' }),
    fresh: mk('no-container', 'container'), custom: mk('prebuilt', 'container', { image: 'busybox:latest' }),
    resumed: mk('resumed', 'container'), lostPin: mk('lost-pin', 'container'), direct1: mk('direct-a', 'direct'), direct2: mk('direct-b', 'direct'),
    dfNext: mk('df-next', 'container', { dockerfile: 'Dockerfile.orchard' }), dfSpoof: mk('df-spoof', 'container', { dockerfile: 'Dockerfile.orchard' }),
  };
  for (const k of ['dfNext', 'dfSpoof']) fs.writeFileSync(path.join(P[k].hostPath, 'Dockerfile.orchard'), 'ARG ORCHARD_BASE_IMAGE\nFROM ${ORCHARD_BASE_IMAGE}\n');
  fs.writeFileSync(path.join(P.df.hostPath, 'Dockerfile.orchard'), 'ARG ORCHARD_BASE_IMAGE\nFROM ${ORCHARD_BASE_IMAGE}\n');
  // Pre-FEAT-157 rows carry no pin: strip what creation now writes (synthetic, labelled).
  const regFile = path.join(DATA, 'registry.json');
  const r0 = JSON.parse(fs.readFileSync(regFile, 'utf8'));
  for (const p of r0.projects) if (p.settings?.container) delete p.settings.container.base;
  // Crash-resume: `resumed` was migrated by an earlier (crashed) boot: journal + pin exist.
  const resumedPin = { pinned: `legacy:${LEGACY_A}`, skipped: [], deferred: null };
  r0.projects.find((p) => p.id === P.resumed.id).settings.container.base = resumedPin;
  fs.writeFileSync(regFile, JSON.stringify(r0, null, 2));
  fs.writeFileSync(path.join(DATA, 'base-migration.json'), JSON.stringify({ version: 1, migrated: {
    [P.resumed.id]: { at: '2026-09-30T00:00:00Z', pin: resumedPin, observed: null },
    [P.lostPin.id]: { at: '2026-09-30T00:00:00Z', pin: { pinned: 1 }, observed: null }, // its pin was later lost by hand
  } }, null, 2));
  const regBefore = fs.readFileSync(regFile, 'utf8');
  // Their containers, created the way a pre-FEAT-157 Orchard created them (the product's own argv).
  const startOn = (p, image) => {
    const name = cm.containerName(p.id);
    createdContainers.push(name);
    const argv = cm.createArgs(p, name, image, {}).map((a) => a.replace('claude-station-base:', `${SCRATCH_BASE}:`));
    dk(argv); dk(['start', name]);
    return cid(name);
  };
  for (const b of cm.desiredBinds(P.legacyA)) if (b.why === 'session history') fs.mkdirSync(b.hostPath, { recursive: true });
  const ids = {
    legacyA: startOn(P.legacyA, `claude-station-base:${LEGACY_A}`),
    legacyA2: startOn(P.legacyA2, `claude-station-base:${LEGACY_B}`),
    df: startOn(P.df, DF_IMAGE),
    resumed: startOn(P.resumed, `claude-station-base:${LEGACY_A}`),
    lostPin: startOn(P.lostPin, `claude-station-base:${LEGACY_A}`),
  };
  // A Dockerfile project whose swap a crash interrupted: only `<name>.next` exists (attack round 1, e).
  {
    const nm = `${cm.containerName(P.dfNext.id)}.next`;
    createdContainers.push(nm);
    dk(cm.createArgs(P.dfNext, nm, DF_IMAGE, {})); dk(['start', nm]);
    ids.dfNextSwap = cid(nm);
  }
  // A pre-FEAT-157 Dockerfile image whose Dockerfile set its own base-ref LABEL (the old builder did not override it).
  const SPOOF_IMAGE = `${DF_IMAGE}-spoof`;
  { const c = dk(['create', SEED, 'true']); try { dk(['commit', '--change', 'LABEL claude-station.base-ref=v1-u1000-g1000-0123456789ab', c, SPOOF_IMAGE]); } finally { dkTry(['rm', '-f', c]); } }
  ids.dfSpoof = startOn(P.dfSpoof, SPOOF_IMAGE);
  // History the migration must not touch: a transcript in legacyA's session-history bind.
  const hist = cm.desiredBinds(P.legacyA).find((b) => b.why === 'session history').hostPath;
  fs.mkdirSync(hist, { recursive: true });
  const histFile = path.join(hist, 'session-before-migration.jsonl');
  fs.writeFileSync(histFile, `${JSON.stringify({ type: 'user', message: 'written before FEAT-157' })}\n`);
  const histBefore = { bytes: fs.readFileSync(histFile, 'utf8'), mtime: fs.statSync(histFile).mtimeMs };
  delete process.env.CLAUDE_STATION_DOCKER;

  /* --------------------------------------------------------------- boot */
  console.log('--- (e) the one-time migration at boot');
  // ARCH-022: these fixtures are a LIVE server's pre-identity containers (labelled with the old path-derived key). The
  // user declares that data dir live (the one-time step), and only then does its new identity keep owning them.
  if (fs.existsSync(path.join(TREE, 'scripts', 'orchard-live-instance.mjs'))) {
    execFileSync(process.execPath, ['--no-warnings', path.join(TREE, 'scripts', 'orchard-live-instance.mjs'), 'declare', '--data-dir', DATA], { cwd: TREE, stdio: 'pipe' });
  }
  await boot();
  const regAfter = JSON.parse(fs.readFileSync(regFile, 'utf8'));
  const pinOf = (p) => regAfter.projects.find((x) => x.id === p.id)?.settings?.container?.base ?? null;
  check('E1 legacy containers are pinned to EXACTLY the base they run (legacy:<tag>), a Dockerfile project to the base its image was built on',
    pinOf(P.legacyA)?.pinned === `legacy:${LEGACY_A}` && pinOf(P.legacyA2)?.pinned === `legacy:${LEGACY_B}` && pinOf(P.df)?.pinned === `legacy:${LEGACY_B}`,
    `A=${pinOf(P.legacyA)?.pinned} A2=${pinOf(P.legacyA2)?.pinned} df=${pinOf(P.df)?.pinned}`);
  check('E2 a container project with NO container is left pending at boot (the daemon reached may not be the right one; its first launch decides); a prebuilt-image project gets no pin; direct projects untouched',
    pinOf(P.fresh) === null && pinOf(P.custom) === null && pinOf(P.direct1) === null, `fresh=${JSON.stringify(pinOf(P.fresh))} custom=${JSON.stringify(pinOf(P.custom))} direct=${JSON.stringify(pinOf(P.direct1))}`);
  check('E2b an interrupted Dockerfile swap (only <name>.next) and an old image claiming base-ref=v1 by its own LABEL are both pinned to the LEGACY base they really run',
    pinOf(P.dfNext)?.pinned === `legacy:${LEGACY_B}` && pinOf(P.dfSpoof)?.pinned === `legacy:${LEGACY_B}`, `dfNext=${pinOf(P.dfNext)?.pinned} dfSpoof=${pinOf(P.dfSpoof)?.pinned}`);
  const same = Object.entries(ids).map(([k, v]) => [k, v === cid(k === 'dfNextSwap' ? `${cm.containerName(P.dfNext.id)}.next` : cm.containerName(P[k].id))]);
  check('E3 NO container was recreated by the migration (every container id unchanged)', same.every(([, ok]) => ok), JSON.stringify(same));
  const backups = fs.readdirSync(DATA).filter((f) => f.startsWith('registry.json.pre-feat157-'));
  check('E4 the registry was backed up before the first write, byte for byte', backups.length === 1 && fs.readFileSync(path.join(DATA, backups[0]), 'utf8') === regBefore, `backups=${JSON.stringify(backups)}`);
  check('E5 session history is untouched (bytes and mtime)', fs.readFileSync(histFile, 'utf8') === histBefore.bytes && fs.statSync(histFile).mtimeMs === histBefore.mtime, `mtime same=${fs.statSync(histFile).mtimeMs === histBefore.mtime}`);
  check('E6 crash-resume: a project the journal already holds is not re-migrated; a journalled project whose pin was lost stays pin-less (recovery), never re-guessed',
    JSON.stringify(pinOf(P.resumed)) === JSON.stringify(resumedPin) && pinOf(P.lostPin) === null, `resumed=${JSON.stringify(pinOf(P.resumed))} lostPin=${JSON.stringify(pinOf(P.lostPin))}`);
  const journal = JSON.parse(fs.readFileSync(path.join(DATA, 'base-migration.json'), 'utf8')).migrated;
  check('E7 the journal records every container project handled (and no direct one)',
    [P.legacyA, P.legacyA2, P.df, P.custom, P.resumed, P.lostPin].every((p) => p.id in journal) && !(P.fresh.id in journal) && !(P.direct1.id in journal), `journal=${Object.keys(journal).length}`);

  {
    // A torn journal must not be rewritten nor make journalled projects be re-guessed (attack round 1, e).
    const jf = path.join(DATA, 'base-migration.json');
    const jraw = fs.readFileSync(jf, 'utf8');
    fs.writeFileSync(jf, jraw.slice(0, 40));
    const regBeforeT = fs.readFileSync(regFile, 'utf8');
    // ARCH-022: the migration runs only in the server that holds this data dir (one server per data dir), so the torn
    // journal is met by a RESTARTED server: stop this one, tear the journal, boot again, let its boot migration run.
    const cur = servers[servers.length - 1];
    try { process.kill(-cur.pid, 'SIGTERM'); } catch { /* */ }
    for (let i = 0; i < 40 && cur.exitCode === null && cur.signalCode === null; i++) await sleep(250);
    fs.writeFileSync(jf, jraw.slice(0, 40));
    serverLog = '';
    await boot();
    const same = fs.readFileSync(regFile, 'utf8') === regBeforeT && fs.readFileSync(jf, 'utf8') === jraw.slice(0, 40);
    const migratedNow = /base-pin migration done: migrated [1-9]/.test(serverLog);
    fs.writeFileSync(jf, jraw);
    check('E8 a torn migration journal met by a restarted server: nothing is re-migrated, the registry and the torn journal are left exactly as they are', same && !migratedNow, `migratedNow=${migratedNow} unchanged=${same} log=${(serverLog.match(/\[orchard\] base-pin migration[^\n]*/) ?? ['(no migration line)'])[0]}`);
  }

  /* ------------------------------------------------------------- the rail */
  console.log('--- the rail card (derived)');
  const boardOf = async (p) => (await api(`/api/projects/${p.id}/board`)).body;
  const cardOf = async (p) => (await boardOf(p))?.needsYou?.find((x) => x.id === `base:${p.id}`) ?? null;
  const cA = await cardOf(P.legacyA);
  check('R1 a legacy project shows a BASE card offering v1 (Adopt/Defer/Skip), with the v1 entry and its adjust text',
    cA?.baseUpdate?.state === 'offer' && cA.baseUpdate.to === 1 && JSON.stringify(cA.baseUpdate.actions) === '["adopt","defer","skip"]' && cA.baseUpdate.entries?.[0]?.adjust?.length > 0,
    `state=${cA?.baseUpdate?.state} to=${cA?.baseUpdate?.to} actions=${cA?.baseUpdate?.actions} entries=${cA?.baseUpdate?.entries?.length}`);
  const cL = await cardOf(P.lostPin), cC = await cardOf(P.custom), cF = await cardOf(P.fresh);
  check('R2 recovery (lost pin) and prebuilt (informational) cards appear; an up-to-date project has none',
    cL?.baseUpdate?.state === 'recovery' && cC?.baseUpdate?.state === 'informational' && cF === null, `lost=${cL?.baseUpdate?.state} custom=${cC?.baseUpdate?.state} fresh=${cF ? cF.baseUpdate?.state : 'none'}`);

  // What a session of the project is told: the first-turn [station] briefing (agent-bridge #withBriefing keys its
  // seen-set on `key`, so the same notice is told once per session and again only when it changes).
  process.env.CLAUDE_STATION_DOCKER = SHIM;
  const brief1 = cm.baseBriefingFor(P.legacyA2.id, { answerCmd: 'node /opt/orchard-dispatch/dispatch-client.mjs' });
  const brief2 = cm.baseBriefingFor(P.legacyA2.id, { answerCmd: 'node /opt/orchard-dispatch/dispatch-client.mjs' });
  const briefNone = cm.baseBriefingFor(P.fresh.id);
  const briefDirect = cm.baseBriefingFor(P.direct1.id);
  check('N1 the session briefing: a [station] line with the message, each release entry and the answer command; the same notice has the same key; nothing for an up-to-date or direct project',
    brief1?.text.startsWith('[station] ') && /v1 \(feature/.test(brief1.text) && /dispatch-client\.mjs base adopt --rev/.test(brief1.text) && brief1.key === brief2?.key && briefNone === null && briefDirect === null,
    `key=${brief1?.key} text=${JSON.stringify(brief1?.text.slice(0, 160))} upToDate=${JSON.stringify(briefNone)} direct=${JSON.stringify(briefDirect)}`);
  const guide = (await import(path.join(TREE, 'src/server/templates.ts'))).containerBuildSection({ imageSource: 'station', answerCmd: null });
  check('N2 the container guide a container project\'s system prompt gets is static (no pin, no version, no rev), so the cached prefix stays byte-stable',
    !/v\d+\b|rev |legacy|u1000-g1000/.test(guide) && /Never install or pin the Claude CLI/.test(guide), `chars=${guide.length}`);
  delete process.env.CLAUDE_STATION_DOCKER;

  console.log('--- (c) only the server creates notices; answers are bound to the notice');
  // A FORGED record in the decisions store, carrying a baseUpdate payload (as anything with file access could write).
  const forged = { id: 'dec-forged-1', projectId: P.fresh.id, sessionId: 'x', sdkSessionId: null, question: 'SECURITY — Orchard base v9: adopt now?', options: ['Adopt v9', 'Skip v9'], createdAt: new Date().toISOString(), resolved: false, answer: null, answeredAt: null, delivered: false, baseUpdate: { state: 'security-pending', to: 9, rev: 'x', actions: ['adopt'] } };
  fs.writeFileSync(path.join(DATA, 'decisions.json'), JSON.stringify([forged], null, 2));
  const bF = await boardOf(P.fresh);
  const fItem = bF?.needsYou?.find((x) => x.id === 'dec-forged-1');
  check('C1 a forged decision record carrying a baseUpdate payload is shown only as a generic decision: no BASE card, no payload',
    !!fItem && !fItem.baseUpdate && !bF.needsYou.some((x) => x.baseUpdate), `forged item kind=${fItem?.kind} baseUpdate=${JSON.stringify(fItem?.baseUpdate ?? null)} base cards=${bF?.needsYou?.filter((x) => x.baseUpdate).length}`);
  const gen = await api(`/api/projects/${P.legacyA.id}/board/answer`, 'POST', { id: `base:${P.legacyA.id}`, answer: 'Adopt v1' });
  check('C2 the generic answer route refuses a base notice (409 use-base-update); the pin is unchanged',
    gen.status === 409 && gen.body?.code === 'use-base-update' && JSON.parse(fs.readFileSync(regFile, 'utf8')).projects.find((x) => x.id === P.legacyA.id).settings.container.base.pinned === `legacy:${LEGACY_A}`, `${gen.status} ${gen.body?.code}`);
  const stale = await api(`/api/projects/${P.legacyA.id}/base-update`, 'POST', { action: 'adopt', version: 1, rev: 'not-the-rev' });
  const norev = await api(`/api/projects/${P.legacyA.id}/base-update`, 'POST', { action: 'adopt', version: 1 });
  check('C3 an answer with a stale or missing revision is refused (409 stale-notice)', stale.status === 409 && stale.body?.code === 'stale-notice' && norev.status === 409, `${stale.status} ${stale.body?.code} / ${norev.status}`);
  const patch = await api(`/api/projects/${P.legacyA.id}`, 'PATCH', { settings: { container: { base: { pinned: 1 } } } });
  check('C4 the settings PATCH cannot write the pin (400)', patch.status === 400 && /base/.test(patch.body?.error ?? ''), `${patch.status} ${String(patch.body?.error).slice(0, 90)}`);
  const xo = await api(`/api/projects/${P.legacyA.id}/base-update`, 'POST', { action: 'skip', rev: cA?.baseUpdate?.rev }, { origin: 'http://evil.example' });
  check('C5 a cross-origin answer is refused (403)', xo.status === 403, `${xo.status}`);
  // Concurrent answers against the same revision: exactly one wins.
  const [a1, a2] = await Promise.all([
    api(`/api/projects/${P.legacyA2.id}/base-update`, 'POST', { action: 'defer', version: 1, rev: (await cardOf(P.legacyA2))?.baseUpdate?.rev }),
    api(`/api/projects/${P.legacyA2.id}/base-update`, 'POST', { action: 'skip', version: 1, rev: (await cardOf(P.legacyA2))?.baseUpdate?.rev }),
  ]);
  check('C6 two answers sent together against one revision: exactly one is applied, the other is refused as stale',
    [a1.status, a2.status].sort().join(',') === '200,409', `${a1.status} ${a1.body?.code ?? a1.body?.action} / ${a2.status} ${a2.body?.code ?? a2.body?.action}`);
  const sess = await api('/api/sessions/no-such-session/base-update', 'POST', { action: 'adopt', rev: 'x' });
  check('C7 the agent session route acts only for a live session (none → 400), never a named project', sess.status === 400, `${sess.status} ${sess.body?.error}`);

  /* ----------------------------------------------- the agent's socket op */
  console.log('--- (c) the agent answers only its own project over its dispatch socket');
  {
    // ARCH-022: the dispatch socket's answer runs as a lifecycle operation of the ONE server holding this data dir.
    // The socket is served in THIS process, so this process becomes that server for the step: the scratch server
    // stops, this process takes the data dir (bootForTests), and the scratch server boots again afterwards.
    const otherRev = (await cardOf(P.legacyA2))?.baseUpdate?.rev ?? 'none';
    const cur = servers[servers.length - 1];
    try { process.kill(-cur.pid, 'SIGTERM'); } catch { /* */ }
    for (let i = 0; i < 40 && cur.exitCode === null && cur.signalCode === null; i++) await sleep(250);
    const prevData = process.env.CLAUDE_STATION_DATA;
    process.env.CLAUDE_STATION_DATA = DATA;
    const H = await (await import('./lib/lifecycle-harness.mjs')).bootAuthority(TREE);
    const bu = await import(path.join(TREE, 'src/server/base-updates.ts'));
    const broker = await import(path.join(TREE, 'src/server/dispatch-broker.ts'));
    bu.registerBaseOp();
    const sock = await broker.start(P.legacyA);
    const ask = (req) => new Promise((resolve) => {
      const c = net.createConnection(sock); let out = '';
      c.on('connect', () => c.write(`${JSON.stringify(req)}\n`));
      c.on('data', (d) => { out += String(d); });
      c.on('end', () => { try { resolve(JSON.parse(out)); } catch { resolve({ raw: out }); } });
      c.on('error', (e) => resolve({ error: e.message }));
    });
    const st = await ask({ op: 'base', action: 'status' });
    const named = await ask({ op: 'base', action: 'adopt', rev: st?.notice?.rev, project: P.fresh.id });
    const cross = await ask({ op: 'base', action: 'adopt', rev: otherRev });
    check('S1 the socket\'s status is ITS project\'s; naming another project is refused; another project\'s revision does not act',
      st?.projectId === P.legacyA.id && named?.ok === false && /not allowed/.test(named.error ?? '') && cross?.ok === false && cross.code === 'stale-notice',
      `status.projectId=${st?.projectId} named=${named?.error?.slice(0, 60)} cross=${cross?.code}`);
    const pinsBefore = Object.fromEntries(JSON.parse(fs.readFileSync(regFile, 'utf8')).projects.map((p) => [p.id, JSON.stringify(p.settings?.container?.base ?? null)]));
    const ok = await ask({ op: 'base', action: 'adopt', rev: st?.notice?.rev });
    const pinsAfter = Object.fromEntries(JSON.parse(fs.readFileSync(regFile, 'utf8')).projects.map((p) => [p.id, JSON.stringify(p.settings?.container?.base ?? null)]));
    const changed = Object.keys(pinsAfter).filter((k) => pinsAfter[k] !== pinsBefore[k]);
    check('S2 an agent adopt over the socket pins ITS project only (actor agent), and the container is not touched', ok?.ok === true && ok.actor === 'agent' && JSON.stringify(changed) === JSON.stringify([P.legacyA.id]) && cid(cm.containerName(P.legacyA.id)) === ids.legacyA,
      `ok=${ok?.ok} actor=${ok?.actor} changed=${JSON.stringify(changed)}`);
    await broker.stop(P.legacyA);
    H.dispose();
    if (prevData === undefined) delete process.env.CLAUDE_STATION_DATA; else process.env.CLAUDE_STATION_DATA = prevData;
    serverLog = '';
    await boot();
  }

  // ARCH-022 step (iv): the image plan of a Dockerfile project once recursed through its own Dockerfile hash (a status
  // read took 104 s and blocked the server). Every dashboard read of it must answer promptly.
  {
    const t0 = Date.now();
    const st = await api(`/api/projects/${encodeURIComponent(P.df.id)}/container/status`);
    const t1 = Date.now();
    const bd = await api(`/api/projects/${encodeURIComponent(P.df.id)}/board`);
    const t2 = Date.now();
    check('P1 a Dockerfile project\'s container status and board answer promptly (under 5 s each; the plan does not recurse)', st.status === 200 && bd.status === 200 && t1 - t0 < 5000 && t2 - t1 < 5000, `status ${t1 - t0} ms, board ${t2 - t1} ms`);
  }
  if (SHOTS) await shoot([['offer', P.df], ['adopted-pending', P.legacyA], ['recovery', P.lostPin], ['prebuilt', P.custom]], false);

  /* ------------------------------------------------------------ security */
  console.log('--- (b) a security release cannot be skipped');
  {
    const r = spawnSync(process.execPath, [path.join(TREE, 'scripts', 'base-release.mjs'), '--class=security', '--summary=synthetic security fix for the suite', '--adjust=Nothing to change.', '--verify=bash:5.0'], { encoding: 'utf8' });
    const cS = await cardOf(P.legacyA2);
    const skip = await api(`/api/projects/${P.legacyA2.id}/base-update`, 'POST', { action: 'skip', version: 2, rev: cS?.baseUpdate?.rev });
    const skipOld = await api(`/api/projects/${P.legacyA2.id}/base-update`, 'POST', { action: 'skip', version: 2, rev: 'stale' });
    check('B1 a security release: the card offers no Skip and says it is applied automatically; Skip is refused (409) even with the right revision',
      r.status === 0 && cS?.baseUpdate?.security && !cS.baseUpdate.actions.includes('skip') && skip.status === 409 && /security/.test(skip.body?.code ?? '') && skipOld.status === 409,
      `release=${r.status} card=${cS?.baseUpdate?.state} actions=${cS?.baseUpdate?.actions} skip=${skip.status} ${skip.body?.code}`);
    process.env.CLAUDE_STATION_DOCKER = SHIM;
    const briefSec = cm.baseBriefingFor(P.legacyA2.id);
    delete process.env.CLAUDE_STATION_DOCKER;
    const cS2 = await cardOf(P.legacyA2);
    const adopt = await api(`/api/projects/${P.legacyA2.id}/base-update`, 'POST', { action: 'adopt', version: 2, rev: cS2?.baseUpdate?.rev });
    check('B2 Adopt of the security release is accepted', adopt.status === 200 && adopt.body?.pin?.pinned === 2, `${adopt.status} ${JSON.stringify(adopt.body?.pin)}`);
    check('B3 a new (security) release changes the briefing key, so an open session is told again, and says it cannot be skipped',
      !!briefSec && briefSec.key !== brief1?.key && /SECURITY/.test(briefSec.text) && /cannot be skipped/.test(briefSec.text), `key ${brief1?.key} -> ${briefSec?.key} ${JSON.stringify(briefSec?.text.slice(0, 140))}`);
  }

  P_SECURITY = P.legacyA.id;
  if (SHOTS) await shoot([['security', P.legacyA]], true);
} catch (e) {
  console.log(`  FAIL  suite crashed: ${e.stack ?? e}\n  server log tail: ${serverLog.slice(-1200)}`);
  fail++;
} finally {
  cleanup();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
