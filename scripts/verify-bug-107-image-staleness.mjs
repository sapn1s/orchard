#!/usr/bin/env node
/**
 * BUG-107 — the container image must track its own definition, and Serena must
 * come from a pinned registry install that is provisioned once.
 *
 *   node scripts/verify-bug-107-image-staleness.mjs [--root <tree>] [--no-docker]
 *
 * WHY IT RUNS AGAINST A COPIED TREE. The staleness proof REQUIRES mutating the
 * image definition (that is the whole bug: "a changed Dockerfile must produce a
 * different artifact"). Mutating the real `src/server/container/Dockerfile`
 * mid-run would race the other lanes working this repo, so every phase runs
 * against a throwaway copy of the tree. `--root` selects which tree is copied:
 * omit it for the working tree, or point it at a `git archive HEAD` export to
 * get the MUST-FAIL baseline. Same harness, only the code differs.
 *
 * WHY A DOCKER SHIM. `imageNameFor` produces the tag the USER's live containers
 * run on. A verification run must never build over it. `CLAUDE_STATION_DOCKER`
 * (an override the manager already supports) points at a shim that rewrites the
 * repo name to a per-run scratch repo before exec'ing the real docker — and
 * logs every docker invocation, which is what makes "did a build actually
 * happen?" an OBSERVATION rather than an inference.
 */
import { execFileSync, spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const SRC_ROOT = path.resolve(arg('--root') ?? path.resolve(import.meta.dirname, '..'));
const REPO = path.resolve(import.meta.dirname, '..');
const NO_DOCKER = argv.includes('--no-docker');

let pass = 0, fail = 0, skip = 0;
const check = (n, ok, obs) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}\n        observed: ${obs}`);
  ok ? pass++ : fail++;
};
const skipped = (n, why) => { console.log(`  SKIP  ${n}\n        ${why}`); skip++; };

/* ------------------------------------------------------------ scratch tree */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bug107-'));
const TREE = path.join(TMP, 'tree');
const DATA = path.join(TMP, 'data');
const WORK = path.join(TMP, 'work');
fs.mkdirSync(TREE, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(path.join(WORK, 'hello.ts'), 'export const hello = () => "hi";\n');
fs.cpSync(path.join(SRC_ROOT, 'src'), path.join(TREE, 'src'), { recursive: true });
fs.copyFileSync(path.join(SRC_ROOT, 'package.json'), path.join(TREE, 'package.json'));
fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(TREE, 'node_modules'));

const RUN_ID = `${process.pid}${Date.now() % 100000}`;
const SHIM_REPO = `claude-station-v107-${RUN_ID}`;
const SHIM_LOG = path.join(TMP, 'docker-calls.log');
const SHIM = path.join(TMP, 'docker-shim');
/*
 * The shim must be BIDIRECTIONAL. Rewriting only the arguments makes every
 * `docker inspect` read back the scratch repo name while `imageNameFor()`
 * returns the real one — which the manager then reports as image drift, so the
 * drift assertions would pass for a reason that has nothing to do with the fix.
 * Rewriting the child's stdout/stderr back to the real name keeps the manager
 * in a world where only the definition, never the harness, moves.
 */
fs.writeFileSync(SHIM, `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const REAL = 'claude-station-base', SCRATCH = ${JSON.stringify(SHIM_REPO)};
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(SHIM_LOG)}, argv.join(' ') + '\\n');
const child = spawn('docker', argv.map((a) => a.split(REAL).join(SCRATCH)), { stdio: ['inherit', 'pipe', 'pipe'] });
const back = (s) => s.split(SCRATCH).join(REAL);
child.stdout.on('data', (d) => process.stdout.write(back(String(d))));
child.stderr.on('data', (d) => process.stderr.write(back(String(d))));
child.on('close', (c) => process.exit(c ?? 1));
child.on('error', (e) => { process.stderr.write(String(e.message)); process.exit(127); });
`);
fs.chmodSync(SHIM, 0o755);
fs.writeFileSync(SHIM_LOG, '');

process.env.CLAUDE_STATION_DOCKER = SHIM;
process.env.CLAUDE_STATION_DATA = DATA;

const dockerCalls = () => fs.readFileSync(SHIM_LOG, 'utf8').split('\n').filter(Boolean);
const buildsSoFar = () => dockerCalls().filter((l) => l.startsWith('build ')).length;

const DOCKERFILE = path.join(TREE, 'src', 'server', 'container', 'Dockerfile');
const MANIFEST = path.join(TREE, 'src', 'server', 'container', 'provision.json');

/* --------------------------------------------------------------- fixtures */

const PROJECT_ID = `v107-${RUN_ID}`;
const project = {
  id: PROJECT_ID,
  name: 'BUG-107 scratch',
  hostPath: WORK,
  isolation: 'container',
  settings: { tools: { serena: true, playwright: false }, browser: { enabled: false }, mounts: [] },
  createdAt: new Date().toISOString(),
};
const directProject = { ...project, id: `${PROJECT_ID}-direct`, isolation: 'direct' };

const created = [];
function cleanup() {
  for (const name of created) {
    try { execFileSync('docker', ['rm', '-f', name], { stdio: 'pipe' }); } catch { /* gone */ }
  }
  try {
    const out = execFileSync('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}'], { encoding: 'utf8' });
    for (const t of out.split('\n').map((s) => s.trim()).filter((s) => s.startsWith(`${SHIM_REPO}:`))) {
      try { execFileSync('docker', ['rmi', '-f', t], { stdio: 'pipe' }); } catch { /* in use */ }
    }
  } catch { /* no docker */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
}

/* ------------------------------------------------------------ module loads */

const importIf = async (rel) => {
  try { return await import(path.join(TREE, rel) + `?v=${crypto.randomUUID()}`); }
  catch (err) { return { __err: err }; }
};

console.log(`BUG-107 verification\n  tree      : ${SRC_ROOT}\n  scratch   : ${TREE}\n  scratch repo: ${SHIM_REPO}\n`);

let exitCode = 0;
try {
  /* ========================================================= A. the tag */
  console.log('=== A. the image artifact carries its definition ===');

  const prov = await importIf('src/server/provisioning.ts');
  const cm0 = await importIf('src/server/container-manager.ts');

  if (prov.__err || typeof prov.provisionHash !== 'function') {
    check('A1 a provisioning manifest + content hash exist (src/server/provisioning.ts)', false,
      `import failed / no provisionHash: ${String(prov.__err?.message ?? 'export missing').slice(0, 160)}`);
    check('A2 provision.json pins serena to a registry package+version', fs.existsSync(MANIFEST),
      `manifest ${fs.existsSync(MANIFEST) ? 'present' : 'ABSENT'} at src/server/container/provision.json`);
  } else {
    const h0 = prov.provisionHash();
    check('A1 provisionHash() is a stable content hash of Dockerfile + manifest', /^[0-9a-f]{12}$/.test(h0) && h0 === prov.provisionHash(),
      `hash=${h0} (stable across calls: ${h0 === prov.provisionHash()})`);
    const m = prov.readProvisionManifest();
    const s = m?.tools?.serena ?? {};
    check('A2 provision.json pins serena to a registry package + exact version (no git ref)',
      s.package === 'serena-agent' && /^\d+\.\d+\.\d+$/.test(String(s.version)) && !JSON.stringify(m).includes('git+'),
      `package=${s.package} version=${s.version} entrypoint=${s.entrypoint} git+ present=${JSON.stringify(m).includes('git+')}`);
  }

  if (cm0.__err) {
    check('A3 imageNameFor() embeds the definition hash', false, `container-manager import failed: ${String(cm0.__err.message).slice(0, 200)}`);
    check('A4 a changed Dockerfile changes the image identity', false, 'container-manager did not import');
    check('A5 an UNCHANGED definition keeps the SAME image identity', false, 'container-manager did not import');
    check('A6 driftReasons/statusOf sees an image-definition change as drift', false, 'container-manager did not import');
  } else {
    const nameBefore = cm0.imageNameFor(project);
    check('A3 imageNameFor() embeds the definition hash (not just uid/gid)', /-[0-9a-f]{12}$/.test(nameBefore),
      `imageNameFor -> ${nameBefore}`);

    // Mutate the definition and re-read through a FRESH module instance.
    const dfBefore = fs.readFileSync(DOCKERFILE, 'utf8');
    fs.writeFileSync(DOCKERFILE, dfBefore + '\n# BUG-107 verification: definition changed\n');
    const cm1 = await importIf('src/server/container-manager.ts');
    const nameAfterDf = cm1.__err ? null : cm1.imageNameFor(project);
    check('A4a a changed DOCKERFILE yields a different image identity', !!nameAfterDf && nameAfterDf !== nameBefore,
      `before=${nameBefore} after=${nameAfterDf}`);

    fs.writeFileSync(DOCKERFILE, dfBefore);
    let nameAfterManifest = null;
    if (fs.existsSync(MANIFEST)) {
      const mBefore = fs.readFileSync(MANIFEST, 'utf8');
      const mj = JSON.parse(mBefore);
      mj.tools.serena.version = '9.9.9';
      fs.writeFileSync(MANIFEST, JSON.stringify(mj, null, 2) + '\n');
      const cm2 = await importIf('src/server/container-manager.ts');
      nameAfterManifest = cm2.__err ? null : cm2.imageNameFor(project);
      fs.writeFileSync(MANIFEST, mBefore);
    }
    check('A4b a changed MANIFEST (pinned version bump) yields a different image identity',
      !!nameAfterManifest && nameAfterManifest !== nameBefore,
      `before=${nameBefore} after-version-bump=${nameAfterManifest}`);

    const cm3 = await importIf('src/server/container-manager.ts');
    check('A5 restoring the definition restores the SAME identity (no rebuild churn)',
      !cm3.__err && cm3.imageNameFor(project) === nameBefore,
      `restored=${cm3.__err ? 'import failed' : cm3.imageNameFor(project)} == original=${nameBefore}`);
  }

  /* ================================================== B. real build/rebuild */
  console.log('\n=== B. REAL docker: rebuild on change, no rebuild without ===');

  let dockerOk = !NO_DOCKER;
  if (dockerOk) {
    try { execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'pipe' }); }
    catch { dockerOk = false; }
  }

  let builtImage = null;
  if (!dockerOk) {
    for (const n of ['B1', 'B2', 'B3', 'B4', 'B5']) skipped(`${n} (real docker)`, 'docker unavailable or --no-docker');
  } else {
    const cm = await importIf('src/server/container-manager.ts');
    if (cm.__err) {
      for (const n of ['B1', 'B2', 'B3', 'B4', 'B5']) check(`${n} (real docker)`, false, `container-manager import failed: ${String(cm.__err.message).slice(0, 160)}`);
    } else {
      const t0 = Date.now();
      const n0 = buildsSoFar();
      builtImage = await cm.ensureImage(project, { onLog: (s) => process.stdout.write(`    [build] ${String(s).trimEnd().split('\n').slice(-1)[0]}\n`) });
      const b1 = buildsSoFar() - n0;
      const id1 = execFileSync('docker', ['image', 'inspect', builtImage.replace('claude-station-base', SHIM_REPO), '--format', '{{.Id}}'], { encoding: 'utf8' }).trim();
      check('B1 first ensureImage builds the image', b1 === 1 && !!id1,
        `docker builds=${b1} image=${builtImage} id=${id1.slice(7, 19)} in ${Math.round((Date.now() - t0) / 1000)}s`);

      // --- no change -> NO rebuild (a fix that rebuilds every time is a different bug)
      const n1 = buildsSoFar();
      const cmSame = await importIf('src/server/container-manager.ts');
      const again = await cmSame.ensureImage(project, {});
      const id2 = execFileSync('docker', ['image', 'inspect', again.replace('claude-station-base', SHIM_REPO), '--format', '{{.Id}}'], { encoding: 'utf8' }).trim();
      check('B2 NOTHING changed -> no rebuild, same artifact',
        buildsSoFar() - n1 === 0 && again === builtImage && id2 === id1,
        `docker builds=${buildsSoFar() - n1} image=${again} id=${id2.slice(7, 19)}`);

      // --- container on that image, then change the definition
      const status0 = await cm.ensureContainer(project, {});
      created.push(cm.containerName(project.id));
      check('B3 PRECONDITION: container running on the built image', status0.state === 'running' && !status0.drifted,
        `state=${status0.state} image=${status0.image} drifted=${!!status0.drifted}`);

      const dfBefore = fs.readFileSync(DOCKERFILE, 'utf8');
      fs.writeFileSync(DOCKERFILE, dfBefore.replace('CMD ["sleep", "infinity"]', 'ENV BUG107_DEFINITION_CHANGED=1\nCMD ["sleep", "infinity"]'));

      const cmChanged = await importIf('src/server/container-manager.ts');
      const driftStatus = cmChanged.statusOf(project);
      check('B4 a changed definition makes the LIVE container read as drifted',
        driftStatus.drifted === true && (driftStatus.driftReasons ?? []).some((r) => r.startsWith('image ')),
        `drifted=${driftStatus.drifted} reasons=${JSON.stringify(driftStatus.driftReasons ?? [])}`);

      const n2 = buildsSoFar();
      const rebuiltStatus = await cmChanged.ensureContainer(project, { onLog: () => {} });
      const rebuilt = cmChanged.imageNameFor(project);
      const id3 = execFileSync('docker', ['image', 'inspect', rebuilt.replace('claude-station-base', SHIM_REPO), '--format', '{{.Id}}'], { encoding: 'utf8' }).trim();
      const envOut = execFileSync('docker', ['exec', cmChanged.containerName(project.id), 'sh', '-c', 'echo ${BUG107_DEFINITION_CHANGED:-unset}'], { encoding: 'utf8' }).trim();
      check('B5 next ensureContainer REBUILDS and the container runs the NEW definition',
        buildsSoFar() - n2 === 1 && rebuilt !== builtImage && id3 !== id1 && envOut === '1' && rebuiltStatus.state === 'running',
        `docker builds=${buildsSoFar() - n2} newImage=${rebuilt} newId=${id3.slice(7, 19)} oldId=${id1.slice(7, 19)} in-container marker=${envOut} state=${rebuiltStatus.state}`);

      // The changed definition STAYS in the scratch tree: phases C/D/F must all
      // talk about the artifact the container is actually running now.
      if (rebuilt) builtImage = rebuilt;
    }
  }

  /* =========================================== C. serena from the pinned install */
  console.log('\n=== C. serena runs from the pinned install, offline ===');

  const cmC = await importIf('src/server/container-manager.ts');
  const image = builtImage ? builtImage.replace('claude-station-base', SHIM_REPO) : null;
  if (!image) {
    for (const n of ['C1', 'C2', 'C3', 'C4']) skipped(`${n} (in-image serena)`, 'no image was built in phase B');
  } else {
    const wantVer = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).tools.serena.version : '?';
    const probe = (args) => {
      try { return execFileSync('docker', args, { encoding: 'utf8', timeout: 120000 }).trim(); }
      catch (e) { return `ERR:${String(e.stderr ?? e.message).slice(0, 200)}`; }
    };
    const where = probe(['run', '--rm', image, 'bash', '-lc', 'command -v serena || echo NO_SERENA']);
    check('C1 the serena entrypoint is baked into the image at a durable path', where.startsWith('/') && !where.includes('NO_SERENA'), `command -v serena -> ${where}`);

    const ver = probe(['run', '--rm', '--network', 'none', image, 'serena', '--version']);
    check('C2 serena runs with NO NETWORK and reports the pinned version',
      ver.includes(wantVer) && !ver.startsWith('ERR:'), `--network none: serena --version -> ${ver} (manifest pins ${wantVer})`);

    const recorded = probe(['run', '--rm', '--network', 'none', image, 'cat', '/etc/claude-station/provision.json']);
    let recOk = false, recVer = 'n/a';
    try { recVer = JSON.parse(recorded).tools.serena.version; recOk = recVer === wantVer; } catch { /* not present */ }
    check('C4 the image RECORDS what it was provisioned with ("which version is running")', recOk,
      `/etc/claude-station/provision.json serena version = ${recVer}`);

    // Real MCP handshake over stdio, offline, against a bind-mounted workspace.
    const tools = await importIf('src/server/tools.ts');
    let toolNames = [];
    let mcpErr = '';
    if (tools.__err) {
      mcpErr = `tools.ts import failed: ${tools.__err.message}`;
    } else {
      const plan = tools.serenaMcpServerFor(project);
      const argv2 = ['run', '--rm', '-i', '--network', 'none',
        '-v', `${WORK}:${cmC.containerWorkdir(project.id)}`,
        '-w', cmC.containerWorkdir(project.id),
        image, plan.command, ...plan.args];
      console.log(`    [mcp] docker ${argv2.slice(0, 8).join(' ')} … ${plan.command} ${plan.args.join(' ')}`);
      toolNames = await mcpToolList(argv2).catch((e) => { mcpErr = String(e.message).slice(0, 300); return []; });
    }
    const serenaTools = toolNames.filter((t) => /find_symbol|get_symbols_overview|replace_symbol_body|list_memories/.test(t));
    check('C3 serena STARTS in the image with no network and lists its real tools',
      toolNames.length >= 15 && serenaTools.length >= 3,
      `${toolNames.length} tools; sample=${toolNames.slice(0, 8).join(', ')}${mcpErr ? ` err=${mcpErr}` : ''}`);
  }

  /* ================================== D. no git HEAD, no session-start fetch */
  console.log('\n=== D. the launch command: pinned, local, no fetch ===');
  const tools = await importIf('src/server/tools.ts');
  if (tools.__err) {
    for (const n of ['D1', 'D2', 'D3']) check(n, false, `tools.ts import failed: ${String(tools.__err.message).slice(0, 160)}`);
  } else {
    const cs = tools.serenaMcpServerFor(project);
    const ds = tools.serenaMcpServerFor(directProject);
    const flat = (s) => [s.command, ...s.args].join(' ');
    check('D1 the container launch command no longer resolves a mutable git HEAD',
      !flat(cs).includes('git+') && !flat(cs).includes('--from') && !/uvx/.test(cs.command),
      `container: ${flat(cs)}`);
    check('D2 the direct (host) launch command points at the station-provisioned install',
      !flat(ds).includes('git+') && !flat(ds).includes('--from') && path.isAbsolute(ds.command) && ds.command.includes('provision'),
      `direct: ${flat(ds)}`);
    check('D3 the container command targets the container workdir (BUG-035 anti-regression)',
      cs.args.includes(`/workspace/${project.id}`) && ds.args.includes(WORK),
      `container --project=${cs.args[cs.args.indexOf('--project') + 1]} direct --project=${ds.args[ds.args.indexOf('--project') + 1]}`);
  }

  /* ============================================ E. host provisioning + state */
  console.log('\n=== E. host provisioning is explicit, idempotent, and reported ===');
  const prov2 = await importIf('src/server/provisioning.ts');
  if (prov2.__err || typeof prov2.hostProvisionState !== 'function') {
    for (const n of ['E1', 'E2', 'E3']) check(n, false, `provisioning.ts missing hostProvisionState: ${String(prov2.__err?.message ?? 'export missing').slice(0, 120)}`);
  } else {
    const st0 = prov2.hostProvisionState();
    check('E1 an unprovisioned host reports "missing" (it does NOT silently fetch)',
      st0.state === 'missing' && st0.wantedVersion && !fs.existsSync(st0.bin),
      `state=${st0.state} wanted=${st0.wantedVersion} installed=${st0.installedVersion} bin exists=${fs.existsSync(st0.bin)}`);

    let hasUv = true;
    try { execFileSync('uvx', ['--version'], { stdio: 'pipe' }); } catch { hasUv = false; }
    if (!hasUv) {
      skipped('E2 provisionHost() installs the pinned package', 'uv/uvx not on host PATH');
      skipped('E3 a second provisionHost() is a no-op', 'uv/uvx not on host PATH');
    } else {
      const t0 = Date.now();
      const r = await prov2.provisionHost({ onLog: () => {} });
      const st1 = prov2.hostProvisionState();
      const verOut = st1.state === 'provisioned'
        ? execFileSync(st1.bin, ['--version'], { encoding: 'utf8', timeout: 120000 }).trim() : 'n/a';
      check('E2 provisionHost() installs the pinned package into the station dir and records it',
        st1.state === 'provisioned' && st1.installedVersion === st1.wantedVersion && verOut.includes(st1.wantedVersion),
        `state=${st1.state} installed=${st1.installedVersion} bin=${st1.bin} \`serena --version\`=${verOut} in ${Math.round((Date.now() - t0) / 1000)}s (changed=${r.changed})`);

      const t1 = Date.now();
      const r2 = await prov2.provisionHost({ onLog: () => {} });
      check('E3 a second provisionHost() is a no-op (downloaded once, then reused)',
        r2.changed === false && Date.now() - t1 < 3000,
        `changed=${r2.changed} reason=${r2.reason} in ${Date.now() - t1}ms`);
    }
  }

  /* ============================================== F. superseded-image cleanup */
  console.log('\n=== F. superseded images do not accumulate forever ===');
  const cmF = await importIf('src/server/container-manager.ts');
  if (cmF.__err || typeof cmF.pruneSupersededImages !== 'function') {
    check('F1 a prune of superseded station images exists', false,
      `pruneSupersededImages missing (${String(cmF.__err?.message ?? 'export missing').slice(0, 120)})`);
    skipped('F2 the in-use image is NEVER removed', 'no prune to exercise');
  } else if (!builtImage) {
    skipped('F1 superseded tags are removed after a rebuild', 'no image built');
    skipped('F2 the in-use image is NEVER removed', 'no image built');
  } else {
    const tagsNow = execFileSync('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}'], { encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter((s) => s.startsWith(`${SHIM_REPO}:`));
    const currentTag = cmF.imageNameFor(project).replace('claude-station-base', SHIM_REPO);
    check('F1 after a definition change + rebuild, the superseded tag is gone and the current one remains',
      tagsNow.includes(currentTag) && tagsNow.length === 1,
      `${SHIM_REPO} tags present: ${JSON.stringify(tagsNow)}; current=${currentTag}`);

    // The image the live container runs must survive a prune attempt.
    const inUse = execFileSync('docker', ['inspect', cmF.containerName(project.id), '--format', '{{.Config.Image}}'], { encoding: 'utf8' }).trim();
    const res = cmF.pruneSupersededImages(cmF.imageNameFor(project));
    const stillThere = execFileSync('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}'], { encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter((s) => s.startsWith(`${SHIM_REPO}:`));
    check('F2 a prune NEVER removes an image a container is running',
      stillThere.includes(inUse.replace('claude-station-base', SHIM_REPO)) || stillThere.includes(inUse),
      `container runs ${inUse}; after prune tags=${JSON.stringify(stillThere)} removed=${JSON.stringify(res.removed)} kept=${JSON.stringify(res.kept)}`);
  }
} catch (err) {
  console.error(`\nHARNESS ERROR: ${err?.stack ?? err}`);
  exitCode = 2;
} finally {
  cleanup();
}

console.log(`\n${pass}/${pass + fail} PASS  (${fail} FAIL, ${skip} SKIP)`);
process.exit(exitCode || (fail ? 1 : 0));

/* -------------------------------------------------------- MCP stdio driver */

/** Speak real MCP over stdio to `docker <argv>` and return the tool names. */
function mcpToolList(argv) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; child.kill('SIGKILL'); reject(new Error(`MCP timeout; stderr tail: ${stderr.slice(-400)}`)); } }, 180000);
    const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1 && msg.result) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (msg.id === 2 && msg.result) {
          done = true;
          clearTimeout(timer);
          child.kill('SIGKILL');
          resolve((msg.result.tools ?? []).map((t) => t.name));
        }
      }
    });
    child.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
    child.on('close', () => { if (!done) { done = true; clearTimeout(timer); reject(new Error(`MCP server exited before tools/list; stderr tail: ${stderr.slice(-400)}`)); } });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bug107-verify', version: '1' } } });
  });
}
