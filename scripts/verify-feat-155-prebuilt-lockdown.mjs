/**
 * FEAT-155 round 7 — the run-time lockdown applies to EVERY project container,
 * not only images built from a project's `container.dockerfile`. Otherwise it is
 * bypassed by building the same image elsewhere and pointing `container.image`
 * at it.
 *
 *   node scripts/verify-feat-155-prebuilt-lockdown.mjs
 *
 * Layer 1 (live): a SCRATCH Orchard server (isolated CLAUDE_STATION_DATA, free
 * port). A station-image project (image null) is started first — it is the
 * project kind nearly every real project is, and it must still work under the
 * lockdown (host uid, HOME, the Claude CLI runs). Then an ATTACK image (USER
 * root, a malicious ENTRYPOINT, a HEALTHCHECK, a setuid bash, a spoofed
 * env-keys LABEL, STOPSIGNAL SIGKILL) is built outside Orchard FROM Orchard's
 * base and set as a prebuilt `container.image`; the container Orchard creates
 * for it is graded from the host (/proc) and from docker inspect.
 * Layer 2 (in-process): the one-time transition. A container created with the
 * PRE-change create args (the current args minus the lockdown, i.e. exactly
 * what the old code produced for a prebuilt image) must be seen as drifted,
 * must NOT be recreated under other live sessions (deferImageSwap), and must be
 * recreated under the lockdown at the next launch with none live.
 *
 * Synthetic fixture (stated per the conventions): a scratch repo + a scratch
 * attack image; the real registered projects are surveyed separately and
 * logged in FEAT-155.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ownerKeyFor, removeOwnedContainer, refuseTakenName } from './lib/owned-docker.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, obs) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}\n        observed: ${String(obs).slice(0, 600)}`); ok ? pass++ : fail++; };
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 600_000, ...opts });
const docker = (...args) => sh('docker', args);
const uid = String(os.userInfo().uid), gid = String(os.userInfo().gid);

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'f155-pb-data-'));
// FEAT-158: cleanup removes only containers THIS scratch server owns (the names are fixed slugs).
const OWNER = await ownerKeyFor(DATA);
const WORK_S = fs.mkdtempSync(path.join(os.tmpdir(), 'f155-pb-station-'));
const WORK_A = fs.mkdtempSync(path.join(os.tmpdir(), 'f155-pb-attack-'));
fs.writeFileSync(path.join(WORK_S, 'README.md'), 'station-image project\n');
fs.writeFileSync(path.join(WORK_A, 'README.md'), 'prebuilt-image project\n');
const RUN_TAG = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`; // FEAT-158: pid alone repeats across pid namespaces
const ATTACK = `f155-prebuilt-attack:${RUN_TAG}`;
const BENIGN = `f155-prebuilt-benign:${RUN_TAG}`;
const WORK_B = fs.mkdtempSync(path.join(os.tmpdir(), 'f155-pb-benign-'));
fs.writeFileSync(path.join(WORK_B, 'README.md'), 'benign prebuilt-image project\n');

const api = async (p, method = 'GET', body) => {
  const r = await fetch(BASE + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
const server = spawn(process.execPath, [path.join(ROOT, 'src/server/index.ts')], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => { if (/unhandled|TypeError|ReferenceError/i.test(String(d))) process.stderr.write(`  [server!] ${d}`); });

const made = []; // { pid, cname, histPreexisted }
async function makeProject(work, name, container) {
  const c = await api('/api/projects', 'POST', { hostPath: work, name, isolation: 'container' });
  if (c.status !== 201) throw new Error(`project create failed: ${JSON.stringify(c.body)}`);
  const pid = c.body.project.id;
  const rec = { pid, cname: `claude-station-${pid}`, histPreexisted: fs.existsSync(path.join(os.homedir(), '.claude', 'projects', `-workspace-${pid}`)) };
  refuseTakenName(rec.cname); // FEAT-158: never adopt another instance's same-named container
  made.push(rec);
  const p = await api(`/api/projects/${pid}`, 'PATCH', { settings: { container } });
  if (p.status !== 200) throw new Error(`project patch failed: ${JSON.stringify(p.body)}`);
  return rec;
}
function grade(cname) {
  const ins = JSON.parse(docker('inspect', cname).stdout)[0];
  const pst = fs.readFileSync(`/proc/${ins.State.Pid}/status`, 'utf8');
  const f = (k) => (new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(pst)?.[1] ?? '').trim();
  const top = docker('top', cname, '-eo', 'pid,uid,comm').stdout.trim().split('\n').slice(1);
  return {
    pid1Uid: f('Uid').split(/\s+/)[0], pid1Gid: f('Gid').split(/\s+/)[0], capEff: f('CapEff'), capBnd: f('CapBnd'),
    procUids: [...new Set(top.map((l) => l.trim().split(/\s+/)[1]))].join(','),
    execUid: docker('exec', cname, 'id', '-u').stdout.trim(),
    entryRan: docker('exec', cname, 'ls', '/tmp/entry-ran').status === 0,
    hcRan: docker('exec', cname, 'ls', '/tmp/hc-ran').status === 0,
    rootbashEuid: docker('exec', cname, '/opt/rootbash', '-p', '-c', 'id -u').stdout.trim(),
    user: ins.Config.User, entry: JSON.stringify([...(ins.Config.Entrypoint ?? []), ...(ins.Config.Cmd ?? [])]),
    healthcheck: JSON.stringify(ins.Config.Healthcheck?.Test ?? null), stopSignal: ins.Config.StopSignal,
    capDrop: (ins.HostConfig.CapDrop ?? []).join(','), envKeysLabel: ins.Config.Labels?.['claude-station.env-keys'],
  };
}

let S = null, A = null, B = null;
try {
  for (let i = 0; i < 160; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await sleep(250); }

  /* ---------------------------------------------------------- layer 1 */
  console.log('\n[layer 1] live, scratch server');
  // 1. Orchard's own image (the kind nearly every real project uses) — must still work.
  S = await makeProject(WORK_S, 'F155 station', { gpu: 'off' });
  const sS = await api(`/api/projects/${S.pid}/container/start`, 'POST', {});
  const baseImage = docker('inspect', S.cname, '--format', '{{.Config.Image}}').stdout.trim();
  check('station image: the container starts', sS.status === 200 && sS.body.state === 'running' && /^claude-station-base:/.test(baseImage), `${sS.status} ${sS.body?.state} ${baseImage} ${sS.body?.error ?? ''}`);
  const gS = grade(S.cname);
  check('station image: lockdown applied (user uid:gid, entry sleep infinity, no healthcheck, SIGTERM, CapDrop ALL, env-keys label written)',
    gS.user === `${uid}:${gid}` && gS.entry === '["sleep","infinity"]' && gS.healthcheck === '["NONE"]' && gS.stopSignal === 'SIGTERM' && gS.capDrop.split(',').includes('ALL') && gS.envKeysLabel === '',
    JSON.stringify({ user: gS.user, entry: gS.entry, hc: gS.healthcheck, stop: gS.stopSignal, capDrop: gS.capDrop, label: gS.envKeysLabel }));
  const envS = docker('exec', S.cname, 'sh', '-c', 'id -u; id -g; echo "$HOME"; ls -ld "$HOME" | cut -d" " -f3');
  const cliS = docker('exec', S.cname, 'sh', '-c', '"$HOME/.local/bin/claude" --version 2>&1 || claude --version 2>&1');
  check('station image: still usable under the lockdown (exec uid/gid = host, HOME /home/claude owned by it, Claude CLI runs)',
    envS.stdout.trim().split('\n').join(' ') === `${uid} ${gid} /home/claude claude` && /\d+\.\d+\.\d+/.test(cliS.stdout),
    `${envS.stdout.trim().split('\n').join(' ')} | cli=${cliS.stdout.trim().slice(0, 60)}`);
  const stS = (await api(`/api/projects/${S.pid}/container/status`)).body;
  check('station image: a freshly created container is not drifted (no recreate loop)', stS.state === 'running' && !stS.drifted, JSON.stringify(stS.driftReasons ?? []));

  // 2. The attack image, built OUTSIDE Orchard, set as a prebuilt container.image.
  const df = [
    `FROM ${baseImage}`,
    'USER root',
    'RUN cp /bin/bash /opt/rootbash && chmod 4755 /opt/rootbash',
    'RUN printf "#!/bin/sh\\ntouch /tmp/entry-ran\\nexec sleep infinity\\n" > /opt/entry && chmod 755 /opt/entry',
    'LABEL claude-station.env-keys=SPOOF',
    'STOPSIGNAL SIGKILL',
    'HEALTHCHECK --interval=1s CMD touch /tmp/hc-ran',
    'ENTRYPOINT ["/opt/entry"]',
    'CMD []',
    'USER root',
  ].join('\n');
  const b = sh('docker', ['build', '-q', '-t', ATTACK, '-'], { input: df });
  check('attack image builds outside Orchard', b.status === 0, (b.stderr || b.stdout).trim().slice(-200));
  A = await makeProject(WORK_A, 'F155 prebuilt attack', { image: ATTACK, gpu: 'off' });
  const sA = await api(`/api/projects/${A.pid}/container/start`, 'POST', {});
  check('prebuilt attack image: Orchard runs it (the image is the user\'s choice; only what it may DO is pinned)', sA.status === 200 && sA.body.state === 'running' && docker('inspect', A.cname, '--format', '{{.Config.Image}}').stdout.trim() === ATTACK, `${sA.status} ${sA.body?.state} ${sA.body?.error ?? ''}`);
  await sleep(3500); // > the image's 1s HEALTHCHECK interval, had it been kept
  const gA = grade(A.cname);
  console.log(`        ATTACK OBSERVED: ${JSON.stringify(gA)}`);
  check('prebuilt attack: PID1 and every process run as the host uid (USER root denied)', gA.pid1Uid === uid && gA.pid1Gid === gid && gA.procUids === uid, `pid1 uid=${gA.pid1Uid} gid=${gA.pid1Gid} procUids=${gA.procUids}`);
  check('prebuilt attack: a helper `docker exec` without --user is the host uid, not root', gA.execUid === uid, gA.execUid);
  check('prebuilt attack: the image ENTRYPOINT never ran', !gA.entryRan && gA.entry === '["sleep","infinity"]', `ran=${gA.entryRan} entry=${gA.entry}`);
  check('prebuilt attack: the image HEALTHCHECK never ran', !gA.hcRan && gA.healthcheck === '["NONE"]', `ran=${gA.hcRan} hc=${gA.healthcheck}`);
  check('prebuilt attack: STOPSIGNAL overridden, CapDrop ALL, zero effective + bounding caps', gA.stopSignal === 'SIGTERM' && gA.capDrop.split(',').includes('ALL') && /^0+$/.test(gA.capEff) && /^0+$/.test(gA.capBnd), `stop=${gA.stopSignal} capDrop=${gA.capDrop} CapEff=${gA.capEff} CapBnd=${gA.capBnd}`);
  check('prebuilt attack: a setuid-root bash gives no euid 0', gA.rootbashEuid === uid, gA.rootbashEuid);
  check('prebuilt attack: the image LABEL cannot stand in for Orchard\'s env-keys label', gA.envKeysLabel === '', gA.envKeysLabel);
  const stA = (await api(`/api/projects/${A.pid}/container/status`)).body;
  check('prebuilt attack: status not drifted after create (no recreate loop)', !stA.drifted, JSON.stringify(stA.driftReasons ?? []));

  // 3. A benign prebuilt image shaped like the real research project's
  // (Orchard's base re-tagged: USER claude, CMD sleep infinity) — must just work.
  docker('tag', baseImage, BENIGN);
  B = await makeProject(WORK_B, 'F155 prebuilt benign', { image: BENIGN, gpu: 'off' });
  const sB = await api(`/api/projects/${B.pid}/container/start`, 'POST', {});
  const gB = grade(B.cname);
  const cliB = docker('exec', B.cname, 'sh', '-c', '"$HOME/.local/bin/claude" --version 2>&1');
  check('benign prebuilt image: runs under the lockdown, CLI works, not drifted', sB.body?.state === 'running' && gB.user === `${uid}:${gid}` && gB.pid1Uid === uid && /\d+\.\d+\.\d+/.test(cliB.stdout) && !(await api(`/api/projects/${B.pid}/container/status`)).body.drifted, `${sB.body?.state} ${gB.user} cli=${cliB.stdout.trim().slice(0, 40)}`);

  /* ---------------------------------------------------------- layer 2 */
  console.log('\n[layer 2] in-process: the one-time transition of a pre-change container');
  server.kill('SIGKILL');
  await sleep(500);
  process.env.CLAUDE_STATION_DATA = DATA;
  const cm = await import(path.join(ROOT, 'src/server/container-manager.ts'));
  const { runAsServerProcess } = await import('./lib/lifecycle-harness.mjs');
  const reg = JSON.parse(fs.readFileSync(path.join(DATA, 'registry.json'), 'utf8'));
  for (const R of [S, B, A]) {
    const project = reg.projects.find((p) => p.id === R.pid);
    const label = R === S ? 'station image' : R === B ? 'benign prebuilt image' : 'attack prebuilt image';
    if (typeof cm.createArgs !== 'function') { check(`${label}: transition (createArgs export missing — pre-change code)`, false, 'n/a'); continue; }
    // The PRE-change args: the current ones minus the lockdown (and the env-keys
    // label, which the old code wrote only when keys were set).
    const img = docker('inspect', R.cname, '--format', '{{.Config.Image}}').stdout.trim();
    const cur = cm.createArgs(project, R.cname, img, {});
    const old = [];
    for (let i = 0; i < cur.length; i++) {
      const a = cur[i];
      if (a === '--user' || a === '--entrypoint' || a === '--stop-signal') { i++; continue; }
      if (a === '--cap-drop' && cur[i + 1] === 'ALL') { i++; continue; }
      if (a === '--no-healthcheck') continue;
      if (a === '--label' && cur[i + 1].startsWith('claude-station.env-keys=')) { i++; continue; }
      if (i === cur.length - 1 && a === 'infinity') continue;
      old.push(a);
    }
    removeOwnedContainer(R.cname, OWNER, { volumes: true });
    const mk = docker(...old);
    docker('start', R.cname);
    const idOld = docker('inspect', R.cname, '--format', '{{.Id}}').stdout.trim();
    cm.invalidate(R.pid);
    const st0 = cm.statusOf(project);
    /*
     * ARCH-022: "other sessions are live" in a pre-change container is the state a RESTARTED server finds:
     * an old session's work still running in it. So the live session here is a real process carrying an
     * exec tag, and the launch runs as a freshly started server process (boot recovery declares that work
     * a lease) — never a liveness flag the caller passes in.
     */
    const liveTag = `f155pl-${R.pid}`;
    docker('exec', '-d', '--env', `CLAUDE_STATION_EXEC=${liveTag}`, R.cname, 'sleep', '600');
    const run = await runAsServerProcess(ROOT, `
      const { spawnSync } = await import('node:child_process');
      const idOf = () => spawnSync('docker', ['inspect', V.cname, '--format', '{{.Id}}'], { encoding: 'utf8' }).stdout.trim();
      const logs = [];
      let d1 = null, e1 = null;
      try { d1 = await (lc ? cm.ensureContainer(V.project, { onLog: (s) => logs.push(s) }) : cm.ensureContainer(V.project, { deferImageSwap: true, onLog: (s) => logs.push(s) })); } catch (e) { e1 = e.code || e.message; }
      const id1 = idOf();
      spawnSync('docker', ['exec', V.cname, 'sh', '-c', 'for p in /proc/[0-9]*; do tr "\\\\0" "\\\\n" < $p/environ 2>/dev/null | grep -qx CLAUDE_STATION_EXEC=' + V.tag + ' && kill -9 \${p#/proc/}; done; true'], { encoding: 'utf8' });
      if (lc) for (let i = 0; i < 60 && lc.leasesOf(V.project.id).length; i++) await new Promise((r) => setTimeout(r, 500));
      const d2 = await cm.ensureContainer(V.project, { onLog: () => {} });
      return { d1: d1?.state ?? null, e1, id1, logs, d2: d2.state, id2: idOf() };`, { project, cname: R.cname, tag: liveTag });
    const logs = run.logs ?? [];
    if (R === A) {
      // The attack image's LABEL spoof is NON-lockdown drift: no deferral applies. ARCH-022: with a session live
      // it is therefore REFUSED (live-sessions), never recreated under it; with none live it is recreated at once.
      check(`${label}: a pre-change container is drifted (lockdown + the spoofed label)`, mk.status === 0 && st0.drifted === true && st0.driftReasons.some((r) => r.startsWith('lockdown: user root')) && st0.driftReasons.some((r) => !r.startsWith('lockdown:')), JSON.stringify(st0.driftReasons));
      check(`${label}: with a session live, the non-lockdown drift is REFUSED and the container is not recreated under it`, run.e1 === 'live-sessions' && run.id1 === idOld, JSON.stringify({ e1: run.e1, kept: run.id1 === idOld, err: run.error }));
      const g1 = grade(R.cname);
      check(`${label}: with none live, it is recreated under the lockdown at once`, run.d2 === 'running' && run.id2 !== idOld && g1.pid1Uid === uid && !g1.entryRan, JSON.stringify({ pid1: g1.pid1Uid, entryRan: g1.entryRan }));
      continue;
    }
    check(`${label}: a pre-change container is drifted ONLY on lockdown reasons`, mk.status === 0 && st0.drifted === true && (st0.driftReasons ?? []).length > 0 && st0.driftReasons.every((r) => r.startsWith('lockdown:')), JSON.stringify(st0.driftReasons));
    // Round 8 — the deferral is on purpose, so it must be visible, not silent.
    check(`${label}: status says the lockdown is pending and when it applies (lockdownPending)`, /next launch with no live session/.test(st0.lockdownPending ?? ''), st0.lockdownPending ?? '(none)');
    check(`${label}: with other sessions live it is NOT recreated under them`, run.d1 === 'running' && run.id1 === idOld && logs.some((l) => /other sessions are live/.test(l)), `${logs.join(' | ').slice(0, 300)} ${run.error ?? ''}`);
    const g2 = grade(R.cname);
    check(`${label}: with none live, the next launch recreates it under the lockdown`, run.d2 === 'running' && run.id2 !== idOld && g2.user === `${uid}:${gid}` && g2.entry === '["sleep","infinity"]' && g2.pid1Uid === uid && !cm.statusOf(project).drifted && !cm.statusOf(project).lockdownPending, JSON.stringify({ user: g2.user, entry: g2.entry, pid1: g2.pid1Uid }));
  }
} catch (err) {
  check('no exception during the run', false, String(err?.stack || err));
} finally {
  try { server.kill('SIGKILL'); } catch {}
  for (const R of made) {
    removeOwnedContainer(R.cname, OWNER, { volumes: true }); removeOwnedContainer(`${R.cname}-next`, OWNER, { volumes: true });
    if (!R.histPreexisted) { try { fs.rmSync(path.join(os.homedir(), '.claude', 'projects', `-workspace-${R.pid}`), { recursive: true, force: true }); } catch {} }
  }
  docker('image', 'rm', ATTACK); docker('image', 'rm', BENIGN);
  for (const d of [DATA, WORK_S, WORK_A, WORK_B]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
