/**
 * ARCH-020 — project Dockerfile isolation is STRUCTURAL (a per-project rootless
 * BuildKit), not a rule over the Dockerfile text.
 *
 *   node scripts/verify-arch-020-builder-isolation.mjs
 *
 * Every probe is run twice with the SAME Dockerfiles and NO text rules:
 *
 *   BEFORE — the pre-ARCH-020 backend with its lint turned off: `docker build`
 *            on the host's shared dockerd BuildKit, with the flags Orchard used
 *            (--pull, the base as a named OCI-layout context, an empty client
 *            config). This is the ticket's proof bar ("with every current lint
 *            rule turned off"); these are the leaks FEAT-155 rounds 9–13 found.
 *            A BEFORE probe that LEAKS is the must-FAIL half of the proof.
 *   AFTER  — two throwaway projects built by a SCRATCH Orchard (free port,
 *            scratch data dir) through the real HTTP routes, on their own
 *            builders.
 *
 * Properties (each must hold AFTER):
 *   1. B's build cannot reach A's cached content (RUN nonce, COPY / COPY --link
 *      layers with A's mtimes, a RUN cache mount A wrote), with a warm
 *      same-project control proving the cache is really used;
 *   2. A cannot poison B (A's cache-mount write never reaches B's build);
 *   3. a build cannot reference host images (FROM / COPY --from / RUN --mount
 *      from= a local-only image, however spelled — quoted flag words too);
 *   4. lifecycle: builders are per project, stopped between builds, removed with
 *      the project; a foreign container squatting a builder name is refused and
 *      left alone; stale staging is swept; victim image tags keep their ids.
 *
 * Synthetic fixtures (stated per the conventions): the repos are throwaway
 * dirs. The real research Dockerfile is built separately (logged in ARCH-020).
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { removeScratchBuilders } from './lib/builder-cleanup.mjs';
import { ownerKeyFor, removeOwnedContainer, removeOwnedImages } from './lib/owned-docker.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
let pass = 0, fail = 0;
const check = (n, ok, obs) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}\n        observed: ${String(obs).slice(0, 700)}`); ok ? pass++ : fail++; };
const observe = (n, obs) => console.log(`  OBS   ${n}\n        observed: ${String(obs).slice(0, 700)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 900_000, maxBuffer: 64 * 1024 * 1024, ...opts });
const docker = (...a) => sh('docker', a);
const U = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'a020-data-'));
const DATA3 = fs.mkdtempSync(path.join(os.tmpdir(), 'a020-data3-')); // a second Orchard on another data dir
let server3 = null;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'a020-work-'));
const REPO = { A: path.join(TMP, 'repo-a'), B: path.join(TMP, 'repo-b') };
for (const d of Object.values(REPO)) fs.mkdirSync(d);
const hostTagsBefore = docker('images', '--format', '{{.Repository}}:{{.Tag}} {{.ID}}').stdout.split('\n').filter((l) => l && !/^(claude-station-project-a020|arch020-before|<none>)/.test(l)).sort();

/* The probes: one Dockerfile per project per probe; `read` extracts the observed value from the image. */
const LOCAL_ONLY = `arch020-before-localonly-${U}:x`;
const PROBES = {
  runNonce: {
    what: 'identical RUN in A and B (a random nonce written at build time)',
    df: () => `ARG ORCHARD_BASE_IMAGE\nFROM \${ORCHARD_BASE_IMAGE}\nUSER root\nRUN echo ${U}-nonce; head -c16 /dev/urandom | od -An -tx1 | tr -d ' \\n' > /opt/nonce\n`,
    file: '/opt/nonce',
  },
  envShadow: {
    what: 'the round-11 shape: RUN in a stage that sets ENV ORCHARD_BUILD_SCOPE',
    df: () => `ARG ORCHARD_BASE_IMAGE\nFROM \${ORCHARD_BASE_IMAGE} AS gen\nENV ORCHARD_BUILD_SCOPE=shadow\nUSER root\nRUN echo ${U}-shadow; head -c16 /dev/urandom | od -An -tx1 | tr -d ' \\n' > /opt/nonce\nFROM \${ORCHARD_BASE_IMAGE}\nCOPY --from=gen /opt/nonce /opt/nonce\n`,
    file: '/opt/nonce',
  },
  copyMtime: {
    what: 'identical COPY bytes with different mtimes (A=1111111111, B=1222222222) + WORKDIR (round 12)',
    df: () => `ARG ORCHARD_BASE_IMAGE\nFROM \${ORCHARD_BASE_IMAGE}\nWORKDIR /opt/w-${U}\nCOPY same-${U}.txt /opt/same.txt\n`,
    files: (k) => ({ [`same-${U}.txt`]: { body: 'identical bytes\n', mtime: k === 'A' ? 1111111111 : 1222222222 } }),
    cmd: ['stat', '-c', '%Y', '/opt/same.txt'],
  },
  copyLink: {
    what: 'COPY --link of identical bytes with different mtimes (round 13)',
    df: () => `ARG ORCHARD_BASE_IMAGE\nFROM \${ORCHARD_BASE_IMAGE}\nCOPY --link link-${U}.txt /opt/link.txt\n`,
    files: (k) => ({ [`link-${U}.txt`]: { body: 'identical linked bytes\n', mtime: k === 'A' ? 1111111111 : 1222222222 } }),
    cmd: ['stat', '-c', '%Y', '/opt/link.txt'],
  },
  cacheMount: {
    what: 'A writes a marker into RUN --mount=type=cache,id=shared (quoted flag word, round 9); B reads the same cache id',
    df: (k) => k === 'A'
      ? `ARG ORCHARD_BASE_IMAGE\nFROM \${ORCHARD_BASE_IMAGE}\nUSER root\nRUN --mo"u"nt=type=cache,id=shared-${U},target=/c,uid=0 sh -c 'echo A-POISON-${U} > /c/poison; echo wrote > /opt/seen'\n`
      : `ARG ORCHARD_BASE_IMAGE\nFROM \${ORCHARD_BASE_IMAGE}\nUSER root\nRUN --mount=type=cache,id=shared-${U},target=/c,uid=0 sh -c ': ${U}; (cat /c/poison 2>/dev/null || echo none) > /opt/seen'\n`,
    file: '/opt/seen',
  },
};
const IMAGE_PROBES = {
  fromLocal: `FROM ${LOCAL_ONLY}\n`,
  copyFromLocal: `ARG ORCHARD_BASE_IMAGE\nFROM \${ORCHARD_BASE_IMAGE}\nCOPY --fr"o"m=${LOCAL_ONLY} /secret /opt/secret\n`,
  mountFromLocal: `ARG ORCHARD_BASE_IMAGE\nFROM \${ORCHARD_BASE_IMAGE}\nUSER root\nRUN --mount=type=bind,from=${LOCAL_ONLY},source=/secret,target=/s cp /s /opt/secret\n`,
};

function writeRepo(k, probe) {
  const d = REPO[k];
  for (const f of fs.readdirSync(d)) fs.rmSync(path.join(d, f), { recursive: true, force: true });
  fs.writeFileSync(path.join(d, 'Dockerfile'), typeof probe === 'string' ? probe : probe.df(k));
  if (typeof probe !== 'string' && probe.files) {
    for (const [n, { body, mtime }] of Object.entries(probe.files(k))) { fs.writeFileSync(path.join(d, n), body); fs.utimesSync(path.join(d, n), mtime, mtime); }
  }
}
const readImage = (img, probe) => docker('run', '--rm', '--network', 'none', '--entrypoint', probe.cmd ? probe.cmd[0] : 'cat', img, ...(probe.cmd ? probe.cmd.slice(1) : [probe.file])).stdout.trim();

// A local-only image holding a host "secret" — what a build must never read.
{
  const d = path.join(TMP, 'localonly');
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'secret'), `HOST-LOCAL-SECRET-${U}\n`);
  fs.writeFileSync(path.join(d, 'Dockerfile'), 'FROM scratch\nCOPY secret /secret\n');
  const r = docker('build', '-q', '-t', LOCAL_ONLY, d);
  if (r.status !== 0) { console.error('could not make the local-only fixture image', r.stderr); process.exit(2); }
}

/* ------------------------------------------------------------- BEFORE */
console.log('\n[BEFORE] the shared host dockerd BuildKit, Orchard\'s pre-ARCH-020 build flags, text rules OFF');
const before = {};
let ociDir = null, ociDigest = null;
{
  // Orchard's base as an OCI layout — exported the same way the product does (once, into the scratch dir).
  const base = docker('images', 'claude-station-base', '--format', '{{.Repository}}:{{.Tag}}').stdout.split('\n').find((t) => /:u\d+-g\d+-[0-9a-f]{12}$/.test(t));
  ociDir = path.join(TMP, 'base-oci');
  fs.mkdirSync(ociDir);
  const ex = sh('sh', ['-c', 'docker image save "$0" | tar -x -C "$1"', base, ociDir]);
  ociDigest = JSON.parse(fs.readFileSync(path.join(ociDir, 'index.json'), 'utf8')).manifests[0].digest;
  if (ex.status !== 0) { console.error('base export failed', ex.stderr); process.exit(2); }
  const cfg = path.join(TMP, 'empty-docker-config');
  fs.mkdirSync(cfg);
  const oldBuild = (k, tag) => sh('docker', ['build', '--progress=plain', '--pull', '-f', path.join(REPO[k], 'Dockerfile'),
    '--build-context', `orchard-base=oci-layout://${ociDir}@${ociDigest}`, '--build-arg', 'ORCHARD_BASE_IMAGE=orchard-base', '-t', tag, REPO[k]],
  // Keep DOCKER_HOST: dropping it sent the BEFORE builds to the host daemon while every other call went to the isolated one.
  { env: { PATH: process.env.PATH, HOME: cfg, DOCKER_CONFIG: cfg, DOCKER_BUILDKIT: '1', BUILDX_NO_DEFAULT_ATTESTATIONS: '1', ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}) } });
  for (const [name, probe] of Object.entries(PROBES)) {
    const vals = {};
    for (const k of ['A', 'B']) {
      writeRepo(k, probe);
      const tag = `arch020-before-${name.toLowerCase()}-${k.toLowerCase()}-${U}:x`;
      const r = oldBuild(k, tag);
      vals[k] = r.status === 0 ? readImage(tag, probe) : `BUILD-FAILED ${(r.stderr.split('\n').filter((l) => /ERROR/.test(l)).pop() ?? '').slice(0, 120)}`;
      vals[`${k}cached`] = /#\d+ CACHED/.test(r.stderr) && k === 'B' ? (r.stderr.match(/\] (RUN|COPY|WORKDIR)[^\n]*\n#\d+ CACHED/g) ?? []).length : 0;
      docker('image', 'rm', tag);
    }
    before[name] = vals;
  }
  for (const [name, text] of Object.entries(IMAGE_PROBES)) {
    writeRepo('A', text);
    const tag = `arch020-before-${name.toLowerCase()}-${U}:x`;
    const r = oldBuild('A', tag);
    before[name] = r.status === 0 ? `READ: ${docker('run', '--rm', '--entrypoint', 'cat', tag, '/opt/secret').stdout.trim() || '(built)'}` : `refused: ${(r.stderr.split('\n').filter((l) => /ERROR/.test(l)).pop() ?? '').slice(0, 140)}`;
    docker('image', 'rm', tag);
  }
  const leak = (n, v) => observe(`BEFORE ${n}`, v);
  leak('RUN nonce (A vs B)', JSON.stringify(before.runNonce));
  leak('ENV-shadow RUN nonce', JSON.stringify(before.envShadow));
  leak('COPY mtime', JSON.stringify(before.copyMtime));
  leak('COPY --link mtime', JSON.stringify(before.copyLink));
  leak('cache mount: what B saw', JSON.stringify(before.cacheMount));
  leak('FROM <local image>', before.fromLocal);
  leak('COPY --fr"o"m=<local image>', before.copyFromLocal);
  leak('RUN --mount from=<local image>', before.mountFromLocal);
  const leaked = [
    before.runNonce.A === before.runNonce.B,
    before.envShadow.A === before.envShadow.B,
    before.copyMtime.B === '1111111111',
    before.copyLink.B === '1111111111',
    before.cacheMount.B === `A-POISON-${U}`,
  ];
  check('MUST-FAIL baseline: on the shared daemon with the text rules off, B receives A\'s build content (RUN nonce, ENV-shadowed nonce, COPY mtime, COPY --link mtime, A\'s cache-mount write) — these are the leaks the lint was holding back',
    leaked.every(Boolean), JSON.stringify(leaked));
}

// Victim tags: plausible collision targets that nothing but this suite touches.
const VICTIMS = [`a20t-victim-${U}:latest`, `a20t-victim-${U}:df-000000000000`];
for (const t of VICTIMS) docker('tag', LOCAL_ONLY, t);
const victimsBefore = VICTIMS.map((t) => `${t} ${docker('image', 'inspect', t, '--format', '{{.Id}}').stdout.trim()}`);

/* ------------------------------------------------------------- AFTER */
console.log('\n[AFTER] a scratch Orchard, two projects, each on its own builder');
async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const api = async (p, method = 'GET', body) => {
  const r = await fetch(BASE + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
const server = spawn(process.execPath, [path.join(ROOT, 'src/server/index.ts')], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA }, stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => { if (/unhandled|TypeError|ReferenceError/i.test(String(d))) process.stderr.write(`  [server!] ${d}`); });
const ids = {};
const histPre = {};
const imageOf = async (k) => (await api(`/api/projects/${ids[k]}/container/status`)).body?.dockerfile?.effectiveImage;
const buildLog = async (k) => (await api(`/api/projects/${ids[k]}/container/build`)).body?.log ?? '';
const builders = (id) => docker('ps', '-a', '--filter', `label=claude-station.builder-project=${id}`, '--format', '{{.Names}} {{.State}}').stdout.split('\n').filter(Boolean);
try {
  for (let i = 0; i < 160; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await sleep(250); }
  for (const k of ['A', 'B']) {
    writeRepo(k, PROBES.runNonce);
    const c = await api('/api/projects', 'POST', { hostPath: REPO[k], name: `a020 ${k} ${U}`, isolation: 'container' });
    if (c.status !== 201) throw new Error(`project create failed ${JSON.stringify(c.body)}`);
    ids[k] = c.body.project.id;
    histPre[k] = fs.existsSync(path.join(os.homedir(), '.claude', 'projects', `-workspace-${ids[k]}`));
    await api(`/api/projects/${ids[k]}`, 'PATCH', { settings: { container: { dockerfile: 'Dockerfile', gpu: 'off' } } });
  }
  // Rebuild = build + validate + promote without needing a live session; POST start also creates the container.
  const build = async (k) => { const r = await api(`/api/projects/${ids[k]}/container/start`, 'POST', {}); return r; };
  const after = {};
  let firstBuilderId = null;
  for (const [name, probe] of Object.entries(PROBES)) {
    const vals = {};
    for (const k of ['A', 'B']) {
      writeRepo(k, probe);
      const r = await build(k);
      const st = (await api(`/api/projects/${ids[k]}/container/status`)).body;
      vals[k] = st?.dockerfile?.fellBack || !st?.dockerfile?.built ? `NOT-BUILT ${st?.dockerfile?.problem ?? r.body?.error ?? ''}`.slice(0, 160) : readImage(await imageOf(k), probe);
      if (k === 'B') vals.Bcached = ((await buildLog('B')).match(/\] (RUN|COPY|WORKDIR)[^\n]*\n#\d+ CACHED/g) ?? []).length;
    }
    after[name] = vals;
    if (!firstBuilderId) firstBuilderId = docker('inspect', builders(ids.A)[0]?.split(' ')[0] ?? 'none', '--format', '{{.Id}}').stdout.trim();
    observe(`AFTER ${name}: ${probe.what}`, JSON.stringify(vals));
  }
  const hex = /^[0-9a-f]{32}$/;
  check('P1 no cross-project cache: identical RUN in A and B — different nonces, no CACHED step in B', hex.test(after.runNonce.A) && hex.test(after.runNonce.B) && after.runNonce.A !== after.runNonce.B && after.runNonce.Bcached === 0, JSON.stringify(after.runNonce));
  check('P1 no cross-project cache: the ENV-shadow shape (round 11) — different nonces', hex.test(after.envShadow.A) && hex.test(after.envShadow.B) && after.envShadow.A !== after.envShadow.B, JSON.stringify(after.envShadow));
  check('P1 no cross-project layer: identical COPY bytes — each image keeps its OWN mtime (A=1111111111, B=1222222222)', after.copyMtime.A === '1111111111' && after.copyMtime.B === '1222222222', JSON.stringify(after.copyMtime));
  check('P1 no cross-project layer: COPY --link (round 13, no text rule now) — each image keeps its OWN mtime', after.copyLink.A === '1111111111' && after.copyLink.B === '1222222222', JSON.stringify(after.copyLink));
  check('P2 A cannot poison B: A\'s write into a shared-id RUN cache mount (quoted flag word, round 9) never reaches B', after.cacheMount.A === 'wrote' && after.cacheMount.B === 'none', JSON.stringify(after.cacheMount));
  {
    // Warm same-project control: A rebuilds the nonce probe with a step appended — its OWN cache serves the RUN.
    writeRepo('A', PROBES.runNonce);
    await build('A');
    const n1 = readImage(await imageOf('A'), PROBES.runNonce);
    fs.appendFileSync(path.join(REPO.A, 'Dockerfile'), 'RUN true\n');
    await build('A');
    const n2 = readImage(await imageOf('A'), PROBES.runNonce);
    const cached = /RUN echo [^\n]*-nonce[^\n]*\n#\d+ CACHED/.test(await buildLog('A'));
    check('control: a project\'s own rebuild IS served from its own builder cache (nonce unchanged, step CACHED) — so the misses above are isolation, not a cold cache', hex.test(n1) && n1 === n2 && cached, `n1=${n1} n2=${n2} cached=${cached}`);
  }
  for (const [name, text] of Object.entries(IMAGE_PROBES)) {
    writeRepo('A', text);
    await build('A');
    const st = (await api(`/api/projects/${ids.A}/container/status`)).body;
    const log = await buildLog('A');
    const img = st?.dockerfile?.effectiveImage;
    const got = img ? docker('run', '--rm', '--entrypoint', 'cat', img, '/opt/secret').stdout : '';
    check(`P3 host image unreachable: ${name} (${text.split('\n').filter((l) => /FROM|COPY|mount/.test(l)).pop()}) fails to resolve; the secret is in no image or log`,
      st?.dockerfile?.fellBack === true && /pull access denied|failed to resolve|insufficient_scope|not found/i.test(log) && !got.includes('HOST-LOCAL-SECRET') && !log.includes('HOST-LOCAL-SECRET'), `${st?.dockerfile?.problem}`.slice(0, 300));
  }
  {
    // ADD from the host loopback: the builder's loopback is its own.
    writeRepo('A', `ARG ORCHARD_BASE_IMAGE\nFROM \${ORCHARD_BASE_IMAGE}\nADD http://127.0.0.1:${PORT}/api/projects /opt/leak.json\n`);
    await build('A');
    const st = (await api(`/api/projects/${ids.A}/container/status`)).body;
    const log = await buildLog('A');
    check('host loopback: ADD http://127.0.0.1:<orchard port> from a build cannot reach the host\'s Orchard (connection refused inside the builder)', st?.dockerfile?.fellBack === true && /connection refused/i.test(log) && !log.includes(`a020 B ${U}`), st?.dockerfile?.problem);
  }
  {
    // Egress observation (not a proof): a build and a session container sit on the same default bridge.
    const bn = builders(ids.A)[0]?.split(' ')[0];
    const bnet = bn ? docker('inspect', bn, '--format', '{{.HostConfig.NetworkMode}}').stdout.trim() : '';
    const snet = docker('inspect', `claude-station-${ids.A}`, '--format', '{{.HostConfig.NetworkMode}}').stdout.trim();
    observe('egress: builder vs session container network mode (a build reaches what that project\'s session reaches)', `builder=${bnet} session=${snet}`);
  }
  {
    // Lifecycle.
    const ba = builders(ids.A), bb = builders(ids.B);
    const idNow = docker('inspect', ba[0]?.split(' ')[0] ?? 'none', '--format', '{{.Id}}').stdout.trim();
    check('P4 one builder per project, stopped between builds, and ADOPTED on later builds (same container id after many builds, not recreated each time)', ba.length === 1 && bb.length === 1 && ba[0] !== bb[0] && ba.every((l) => / exited$/.test(l)) && bb.every((l) => / exited$/.test(l)) && /^[0-9a-f]{64}$/.test(idNow) && idNow === firstBuilderId, JSON.stringify({ ba, bb, first: firstBuilderId.slice(0, 12), now: idNow.slice(0, 12) }));
    const vA = docker('inspect', ba[0].split(' ')[0], '--format', '{{json .Mounts}}').stdout;
    check('P4 A\'s builder mounts only its own state volume (not B\'s, not the host)', JSON.parse(vA).length === 1 && JSON.parse(vA)[0].Name === ba[0].split(' ')[0] && JSON.parse(vA)[0].Type === 'volume', vA);
    // Stale staging from a "crash" is swept by the next build.
    const stale = path.join(DATA, 'build-staging', 'crashed-build');
    fs.mkdirSync(path.join(stale, 'out'), { recursive: true });
    fs.writeFileSync(path.join(stale, 'out', 'junk'), 'x');
    writeRepo('B', PROBES.runNonce);
    fs.appendFileSync(path.join(REPO.B, 'Dockerfile'), 'RUN echo sweep\n');
    await build('B');
    check('P4 a staging dir left by a crashed build is swept by the next build; nothing is left staged after it', !fs.existsSync(stale) && fs.readdirSync(path.join(DATA, 'build-staging')).length === 0, fs.readdirSync(path.join(DATA, 'build-staging')).join(','));
  }
  {
    // A foreign container squatting on a project's builder name is refused and left alone (fail closed).
    const c = await api('/api/projects', 'POST', { hostPath: path.join(TMP, 'localonly'), name: `a020 C ${U}`, isolation: 'container' });
    ids.C = c.body.project.id;
    histPre.C = fs.existsSync(path.join(os.homedir(), '.claude', 'projects', `-workspace-${ids.C}`));
    fs.writeFileSync(path.join(TMP, 'localonly', 'Dockerfile.c'), 'ARG ORCHARD_BASE_IMAGE\nFROM ${ORCHARD_BASE_IMAGE}\n');
    await api(`/api/projects/${ids.C}`, 'PATCH', { settings: { container: { dockerfile: 'Dockerfile.c', gpu: 'off' } } });
    const pb = await import(path.join(ROOT, 'src/server/project-builder.ts'));
    const pd = await import(path.join(ROOT, 'src/server/project-dockerfile.ts'));
    process.env.CLAUDE_STATION_DATA = DATA;
    const squat = pb.builderName(ids.C, pd.repoIdentity(fs.realpathSync(path.join(TMP, 'localonly'))));
    delete process.env.CLAUDE_STATION_DATA;
    const sqMade = docker('create', '--name', squat, '--label', 'arch020-squatter=1', 'moby/buildkit:v0.33.0-rootless');
    const sqId = sqMade.status === 0 ? sqMade.stdout.trim() : ''; // FEAT-158 round 9: the id create returned, never a name's current holder
    await api(`/api/projects/${ids.C}/container/start`, 'POST', {});
    const st = (await api(`/api/projects/${ids.C}/container/status`)).body;
    const still = docker('inspect', squat, '--format', '{{.Id}} {{index .Config.Labels "arch020-squatter"}}').stdout.trim();
    check('P4 fail closed: a container squatting on a builder name without this project\'s labels is refused and NOT removed', /not this project's builder/.test(`${st?.dockerfile?.problem ?? ''} ${(await api(`/api/projects/${ids.C}/container/build`)).body?.log ?? ''}`) && still === `${sqId} 1`, `${st?.dockerfile?.problem} | still=${still.slice(0, 20)}`);
    if (sqId) docker('rm', '-f', '-v', sqId); // FEAT-158: by the id this run created
  }
  {
    // Another Orchard (another data dir) deleting a project with the SAME id must not remove this one's images
    // or builder (a scratch server and the live one can share a project id on one host).
    const DATA2 = fs.mkdtempSync(path.join(os.tmpdir(), 'a020-data2-'));
    const imgA = await imageOf('A');
    await api(`/api/projects/${ids.A}/container/remove`, 'POST', {}); // unused image: nothing but the label check protects it
    // ARCH-022: "another Orchard" is another PROCESS on its own data dir, with its own lifecycle authority.
    const code2 = `const lc = await import(${JSON.stringify(path.join(ROOT, 'src/server/lifecycle.ts'))}).catch(() => null);
if (lc) await lc.bootForTests();
const cm = await import(${JSON.stringify(path.join(ROOT, 'src/server/container-manager.ts'))});
const P = { id: ${JSON.stringify(ids.A)}, name: 'x', hostPath: ${JSON.stringify(REPO.A)}, isolation: 'container', settings: {} };
const r = lc ? await lc.runOp(P.id, 'delete', () => cm.removeProjectBuildState(P)) : await cm.removeProjectBuildState(P);
console.log(JSON.stringify(r));`;
    let r2;
    try { r2 = JSON.parse(spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', code2], { encoding: 'utf8', env: { ...process.env, CLAUDE_STATION_DATA: DATA2 }, timeout: 120_000 }).stdout.trim().split('\n').pop()); } catch { r2 = null; }
    const kept = docker('image', 'inspect', imgA, '--format', '{{.Id}}').status === 0;
    check('P4 another data dir deleting the same project id removes none of this data dir\'s images or builder', kept && builders(ids.A).length === 1 && (r2?.removed ?? []).length === 0, JSON.stringify({ imgA, kept, removed: r2?.removed, builders: builders(ids.A) }));
    fs.rmSync(DATA2, { recursive: true, force: true });
  }
  {
    // P1/P2 across data dirs: a SECOND Orchard (another data dir) that registers the SAME project id on the SAME
    // repo must build its OWN image on its own builder — never run the first one's, whose content came from the
    // first builder's cache — and deleting the project there must leave the first one's image alone.
    writeRepo('A', PROBES.runNonce);
    await build('A'); // the first Orchard's image for the CURRENT Dockerfile exists, under the tag both would compute pre-fix
    const imgA = await imageOf('A');
    const idA1 = docker('image', 'inspect', imgA, '--format', '{{.Id}}').stdout.trim();
    const dataOf = (ref) => docker('image', 'inspect', ref, '--format', '{{index .Config.Labels "claude-station.dockerfile-data"}}').stdout.trim();
    await api(`/api/projects/${ids.A}/container/remove`, 'POST', {}); // a running container of the first would be refused (foreign owner) — remove it
    const PORT3 = await freePort();
    const B3 = `http://127.0.0.1:${PORT3}`;
    const api3 = async (p, method = 'GET', body) => {
      const r = await fetch(B3 + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
      let j = null; try { j = await r.json(); } catch {}
      return { status: r.status, body: j };
    };
    server3 = spawn(process.execPath, [path.join(ROOT, 'src/server/index.ts')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT3), CLAUDE_STATION_DATA: DATA3 }, stdio: 'ignore' });
    for (let i = 0; i < 160; i++) { try { if ((await fetch(`${B3}/api/health`)).ok) break; } catch {} await sleep(250); }
    const c3 = await api3('/api/projects', 'POST', { hostPath: REPO.A, name: `a020 A ${U}`, isolation: 'container' });
    const id3 = c3.body?.project?.id;
    await api3(`/api/projects/${id3}`, 'PATCH', { settings: { container: { dockerfile: 'Dockerfile', gpu: 'off' } } });
    const pre = (await api3(`/api/projects/${id3}/container/status`)).body?.dockerfile;
    const s3 = await api3(`/api/projects/${id3}/container/start`, 'POST', {});
    const img3 = (await api3(`/api/projects/${id3}/container/status`)).body?.dockerfile?.effectiveImage;
    const run3 = docker('inspect', `claude-station-${id3}`, '--format', '{{.Image}}').stdout.trim();
    const dA = dataOf(imgA), d3 = img3 ? dataOf(img3) : '';
    check('P1 across data dirs: a second Orchard with the SAME project id on the SAME repo builds its OWN image (its own data label) and never runs the first one\'s',
      id3 === ids.A && pre?.built === false && s3.status === 200 && !!img3 && img3 !== imgA && /^[0-9a-f]{16}$/.test(d3) && d3 !== dA && run3 !== idA1,
      JSON.stringify({ sameId: id3 === ids.A, preBuilt: pre?.built, start: s3.status, imgA, img3, dataA: dA, data3: d3, runsFirstsImage: run3 === idA1, err: s3.body?.error }));
    await api3(`/api/projects/${id3}/container/remove`, 'POST', {});
    const d3del = await api3(`/api/projects/${id3}?confirm=${id3}`, 'DELETE');
    check('P4 across data dirs: the second Orchard deleting that project leaves the first one\'s image and builder',
      d3del.status === 200 && docker('image', 'inspect', imgA, '--format', '{{.Id}}').stdout.trim() === idA1 && builders(ids.A).length === 1,
      JSON.stringify({ del: d3del.status, removed: d3del.body?.buildState, firstImageKept: docker('image', 'inspect', imgA, '--format', '{{.Id}}').stdout.trim() === idA1, builders: builders(ids.A) }));
  }
  {
    // Delete must not remove a squatter either: C's labelled builder VOLUME exists (from its failed build? no —
    // create it the way a real one would be), its container name is taken by a foreign container.
    const pb = await import(path.join(ROOT, 'src/server/project-builder.ts'));
    const pd = await import(path.join(ROOT, 'src/server/project-dockerfile.ts'));
    process.env.CLAUDE_STATION_DATA = DATA;
    const nameC = pb.builderName(ids.C, pd.repoIdentity(fs.realpathSync(path.join(TMP, 'localonly'))));
    const dk = pb.dataKey();
    delete process.env.CLAUDE_STATION_DATA;
    docker('volume', 'create', '--label', 'claude-station.builder=1', '--label', `claude-station.builder-project=${ids.C}`, '--label', `claude-station.builder-repo=${pd.repoIdentity(fs.realpathSync(path.join(TMP, 'localonly')))}`, '--label', `claude-station.builder-data=${dk}`, nameC);
    const sqMadeC = docker('create', '--name', nameC, '--label', 'arch020-squatter=1', 'moby/buildkit:v0.33.0-rootless');
    const sq = sqMadeC.status === 0 ? sqMadeC.stdout.trim() : ''; // FEAT-158 round 9: the id create returned
    await api(`/api/projects/${ids.C}/container/remove`, 'POST', {});
    const del = await api(`/api/projects/${ids.C}?confirm=${ids.C}`, 'DELETE');
    const still = docker('inspect', nameC, '--format', '{{.Id}}').stdout.trim();
    check('P4 fail closed on delete: deleting a project never removes a container squatting on its builder name (only its own labelled volume)', del.status === 200 && still === sq && docker('volume', 'inspect', nameC).status !== 0, JSON.stringify({ del: del.status, squatterKept: still === sq, buildState: del.body?.buildState }));
    if (sq) docker('rm', '-f', '-v', sq); // FEAT-158: by the id this run created
    if (docker('volume', 'inspect', nameC, '--format', `{{index .Labels "claude-station.builder-data"}}`).stdout.trim() === dk) docker('volume', 'rm', '-f', nameC); // only while it is still the one this run labelled
    ids.Cdeleted = ids.C; histPre.Cdeleted = histPre.C; delete ids.C;
  }
  {
    // Delete: builder, cache volume, images and record all go with the project.
    const bnB = builders(ids.B)[0].split(' ')[0];
    await api(`/api/projects/${ids.B}/container/remove`, 'POST', {});
    const del = await api(`/api/projects/${ids.B}?confirm=${ids.B}`, 'DELETE');
    const imgs = docker('images', `claude-station-project-${ids.B}`, '--format', '{{.Tag}}').stdout.trim();
    const vol = docker('volume', 'inspect', bnB).status;
    const rec = fs.readdirSync(path.join(DATA, 'container-builds')).length;
    check('P4 project delete removes its builder, its cache volume, its images and its build record', del.status === 200 && builders(ids.B).length === 0 && vol !== 0 && imgs === '' && rec === 1, JSON.stringify({ del: del.status, builders: builders(ids.B), vol, imgs, recs: rec, buildState: del.body?.buildState }));
    ids.Bdeleted = ids.B; histPre.Bdeleted = histPre.B; delete ids.B;
  }
  {
    // Victim tags nothing else on this host touches: their ids must be exactly what they were before AFTER.
    const now = VICTIMS.map((t) => `${t} ${docker('image', 'inspect', t, '--format', '{{.Id}}').stdout.trim()}`);
    check('P4 no build or import changed or removed another image: victim tags keep their ids', now.every((l, i) => l === victimsBefore[i]) && victimsBefore.every((l) => /sha256:/.test(l)), JSON.stringify({ before: victimsBefore, now }));
    // The whole host store is also compared, as an OBSERVATION only: other processes on this machine
    // (compose stacks, other lanes) retag their own images while this runs, so a difference here is not
    // attributable to this suite.
    const after2 = docker('images', '--format', '{{.Repository}}:{{.Tag}} {{.ID}}').stdout.split('\n').filter((l) => l && !/^(claude-station-project-a020|arch020-before|a20t-victim|<none>)/.test(l)).sort();
    observe('host image tags that differ from the start of the run (other processes included)', JSON.stringify(hostTagsBefore.filter((l) => !after2.includes(l))).slice(0, 400));
  }
} catch (err) {
  check('no exception during the AFTER run', false, String(err?.stack || err));
} finally {
  try { server.kill('SIGKILL'); } catch {}
  try { server3?.kill('SIGKILL'); } catch {}
  await sleep(500);
  // FEAT-158 round 7: only what this run's servers own (a container/image planted under a predictable id is left alone).
  const owners = [await ownerKeyFor(DATA), await ownerKeyFor(DATA3)];
  for (const k of Object.keys(ids)) {
    const id = ids[k];
    for (const o of owners) removeOwnedContainer(`claude-station-${id}`, o, { volumes: true });
    for (const o of owners) removeOwnedImages(`claude-station-project-${id}`, o);
    if (histPre[k] === false) { try { fs.rmSync(path.join(os.homedir(), '.claude', 'projects', `-workspace-${id}`), { recursive: true, force: true }); } catch {} }
  }
  try { await removeScratchBuilders(DATA); } catch {}
  try { await removeScratchBuilders(DATA3); } catch {}
  for (const t of VICTIMS) docker('image', 'rm', t);
  docker('image', 'rm', LOCAL_ONLY);
  for (const d of [DATA, DATA3, TMP]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
