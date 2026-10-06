/**
 * FEAT-155 round 5 — a project builds its image from a Dockerfile in its OWN
 * repo (`settings.container.dockerfile`), rebuilt when it changes, keeping the
 * last good image on failure, and a run-time lockdown so the Dockerfile controls
 * image CONTENTS only.
 *
 *   node scripts/verify-feat-155-dockerfile.mjs            # everything
 *   node scripts/verify-feat-155-dockerfile.mjs --unit     # pure layer only (no docker)
 *
 * Layer 1 (pure): setting shape, the symlink/FIFO-safe reader, the OCI-layout
 * import check and builder identity (ARCH-020), rebuild key, repo naming, log sanitising.
 * Layer 2 (live): a SCRATCH Orchard server (isolated CLAUDE_STATION_DATA, free
 * port) and a synthetic but realistic project repo (a Dockerfile layered on
 * Orchard's base, the way the research project's is). Driven through the real
 * HTTP routes: build, rebuild-on-change, keep-last-good on build failure / on a
 * rejected candidate / on a refused or symlinked Dockerfile / on a container
 * that cannot start, prune, the build-log API, and the SECURITY attack image
 * (USER root, setuid bash, file capabilities, ENTRYPOINT/HEALTHCHECK/VOLUME/
 * STOPSIGNAL/LABEL tricks, a writable /etc/group). The attack is first run
 * WITHOUT the lockdown (the pre-change create args, constructed here) to prove
 * it is a real attack — the must-FAIL baseline — then under Orchard.
 * Layer 3 (in-process): the image-only-drift deferral while other sessions are
 * live, and the `-next` swap leftover cleanup.
 *
 * Synthetic fixture (stated per the conventions): no real project repo is used
 * as the build context here; the live research project is exercised separately
 * and logged in FEAT-155.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { removeScratchBuilders } from './lib/builder-cleanup.mjs';
import { ownerKeyFor, removeOwnedContainer, removeOwnedImages, pruneOwnedImages, refuseTakenName } from './lib/owned-docker.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const UNIT_ONLY = process.argv.includes('--unit');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, obs) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}\n        observed: ${String(obs).slice(0, 600)}`); ok ? pass++ : fail++; };
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 600_000, ...opts });
const docker = (...args) => sh('docker', args);

/* ------------------------------------------------------------ layer 1 */
console.log('\n[layer 1] pure authorities');
const df = await import(path.join(ROOT, 'src/server/project-dockerfile.ts'));
{
  const bad = ['/etc/passwd', '../x', 'a/../../b', 'a\0b', 'a\nb', '~/.ssh/id', 'a\\b', ''];
  const errs = bad.map((v) => df.dockerfileSettingError(v));
  check('setting shape: absolute / .. / NUL / newline / ~ / backslash / empty all refused', errs.every(Boolean), JSON.stringify(errs.map((e) => !!e)));
  check('setting shape: a relative path and null accepted', df.dockerfileSettingError('Dockerfile.orchard') === null && df.dockerfileSettingError('docker/Dockerfile') === null && df.dockerfileSettingError(null) === null, 'ok');
  check('normalise: ./ and duplicate slashes removed', df.normaliseDockerfileSetting('./docker//Dockerfile') === 'docker/Dockerfile', df.normaliseDockerfileSetting('./docker//Dockerfile'));
}
{
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'f155-read-'));
  const repo = path.join(T, 'repo');
  const outside = path.join(T, 'outside');
  fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret'), 'HOSTSECRET-f155\n');
  fs.writeFileSync(path.join(repo, 'Dockerfile'), 'FROM scratch\n');
  fs.symlinkSync(path.join(outside, 'secret'), path.join(repo, 'linkfile'));
  fs.symlinkSync(outside, path.join(repo, 'linkdir'));
  spawnSync('mkfifo', [path.join(repo, 'fifo')]);
  fs.writeFileSync(path.join(repo, 'big'), Buffer.alloc(df.DOCKERFILE_MAX_BYTES + 1, 65));
  const ok = df.readProjectDockerfile(repo, 'Dockerfile');
  check('reader: a regular file inside the repo is read', ok.ok && ok.text === 'FROM scratch\n', JSON.stringify({ ok: ok.ok }));
  const l1 = df.readProjectDockerfile(repo, 'linkfile');
  check('reader: a symlinked Dockerfile pointing at a host secret is refused, secret never returned', !l1.ok && /symlink/.test(l1.error) && !JSON.stringify(l1).includes('HOSTSECRET'), l1.error);
  const l2 = df.readProjectDockerfile(repo, 'linkdir/secret');
  check('reader: a path through a symlinked DIRECTORY is refused', !l2.ok && /symlink/.test(l2.error) && !JSON.stringify(l2).includes('HOSTSECRET'), l2.error);
  const t0 = Date.now();
  const l3 = df.readProjectDockerfile(repo, 'fifo');
  check('reader: a FIFO is refused without blocking', !l3.ok && Date.now() - t0 < 2000, `${l3.error} in ${Date.now() - t0}ms`);
  const l4 = df.readProjectDockerfile(repo, 'big');
  check('reader: a file over the size cap is refused', !l4.ok && /larger/.test(l4.error), l4.error);
  const l5 = df.readProjectDockerfile(repo, 'missing');
  check('reader: a missing file is a clear error', !l5.ok && /does not exist/.test(l5.error), l5.error);
  fs.rmSync(T, { recursive: true, force: true });
}
{
  // ARCH-020 (decision A): the text rules are GONE — isolation is the per-project builder's. These are
  // Dockerfiles FEAT-155 rounds 2–13 had to refuse; they are no longer the boundary (the live layer and
  // scripts/verify-arch-020-builder-isolation.mjs show what each one can and cannot reach).
  check('ARCH-020: no Dockerfile text rules remain (no linter, canonicaliser, flag allow-list or cache-scope injection exported)',
    ['lintDockerfile', 'canonicalDockerfile', 'scopedBuildText', 'SCOPE_CONTEXT_NAME'].every((k) => df[k] === undefined), Object.keys(df).join(','));
}
{
  // ARCH-020: the builder's exported OCI layout is untrusted. Orchard imports only a layout that passes
  // checkOciLayout — regular files at known paths, one image manifest, every blob's size AND digest.
  const pb = await import(path.join(ROOT, 'src/server/project-builder.ts'));
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'a020-layout-'));
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  const mkLayout = (name, mutate = () => {}) => {
    const d = path.join(T, name);
    fs.mkdirSync(path.join(d, 'blobs', 'sha256'), { recursive: true });
    fs.mkdirSync(path.join(d, 'ingest'));
    const put = (b) => { const h = sha(b); fs.writeFileSync(path.join(d, 'blobs', 'sha256', h), b); return { digest: `sha256:${h}`, size: b.length }; };
    const layer = put(Buffer.from('not really a tarball, the checker does not parse layers'));
    const config = put(Buffer.from(JSON.stringify({ architecture: 'amd64', os: 'linux', rootfs: { type: 'layers', diff_ids: [] } })));
    const man = { schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: { mediaType: 'application/vnd.oci.image.config.v1+json', ...config }, layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', ...layer }] };
    const ctx = { d, put, man, layer, config };
    mutate(ctx, 'pre');
    const md = put(Buffer.from(JSON.stringify(ctx.man)));
    ctx.index = { schemaVersion: 2, manifests: [{ mediaType: 'application/vnd.oci.image.manifest.v1+json', ...md, annotations: { 'io.containerd.image.name': 'docker.io/library/victim:latest' } }] };
    ctx.md = md;
    mutate(ctx, 'post');
    fs.writeFileSync(path.join(d, 'index.json'), JSON.stringify(ctx.index));
    fs.writeFileSync(path.join(d, 'oci-layout'), '{"imageLayoutVersion":"1.0.0"}');
    mutate(ctx, 'files');
    return d;
  };
  const verdict = async (d) => { try { const r = await pb.checkOciLayout(d); return { ok: true, r }; } catch (e) { return { ok: false, e: e.message }; } };
  const good = await verdict(mkLayout('good'));
  check('ARCH-020 import check: a well-formed layout passes and yields exactly its manifest, config and layer blobs', good.ok && good.r.blobs.length === 3 && /^sha256:/.test(good.r.manifest.digest), JSON.stringify(good.ok ? good.r.blobs.length : good.e));
  const bad = {
    'symlinked blob': (c, ph) => { if (ph === 'files') { const f = path.join(c.d, 'blobs', 'sha256', c.layer.digest.slice(7)); fs.rmSync(f); fs.symlinkSync('/etc/passwd', f); } },
    'extra file': (c, ph) => { if (ph === 'files') fs.writeFileSync(path.join(c.d, 'manifest.json'), '[{"RepoTags":["victim:latest"]}]'); },
    'fifo': (c, ph) => { if (ph === 'files') spawnSync('mkfifo', [path.join(c.d, 'blobs', 'sha256', 'f'.repeat(64))]); },
    'two manifests': (c, ph) => { if (ph === 'post') c.index.manifests.push({ ...c.index.manifests[0] }); },
    'nested index': (c, ph) => { if (ph === 'post') c.index.manifests[0].mediaType = 'application/vnd.oci.image.index.v1+json'; },
    'digest mismatch': (c, ph) => { if (ph === 'files') { const f = path.join(c.d, 'blobs', 'sha256', c.layer.digest.slice(7)); const b = fs.readFileSync(f); b[0] ^= 1; fs.writeFileSync(f, b); } },
    'size mismatch': (c, ph) => { if (ph === 'pre') c.man.layers[0].size += 1; },
    'foreign urls': (c, ph) => { if (ph === 'pre') c.man.layers[0].urls = ['http://127.0.0.1/x']; },
    'missing layer': (c, ph) => { if (ph === 'pre') c.man.layers.push({ mediaType: 'application/vnd.oci.image.layer.v1.tar', digest: `sha256:${'a'.repeat(64)}`, size: 1 }); },
    'unknown layer type': (c, ph) => { if (ph === 'pre') c.man.layers[0].mediaType = 'application/vnd.example.evil'; },
    'files in ingest/': (c, ph) => { if (ph === 'files') fs.writeFileSync(path.join(c.d, 'ingest', 'x'), 'x'); },
    'symlinked blobs dir': (c, ph) => { if (ph === 'files') { fs.renameSync(path.join(c.d, 'blobs'), path.join(c.d, 'real-blobs')); fs.symlinkSync(path.join(c.d, 'real-blobs'), path.join(c.d, 'blobs')); } },
  };
  const results = {};
  for (const [k, fn] of Object.entries(bad)) results[k] = (await verdict(mkLayout(k.replace(/\W+/g, '-'), fn))).ok ? 'ACCEPTED' : 'refused';
  check('ARCH-020 import check: hostile layouts refused (symlinked blob/dir, extra manifest.json naming a tag, FIFO, 2 manifests, nested index, digest/size mismatch, foreign urls, missing or unknown layer, files in ingest/)', Object.values(results).every((v) => v === 'refused'), JSON.stringify(results));
  fs.rmSync(T, { recursive: true, force: true });
  const n = pb.builderName('p1', 'r1');
  check('ARCH-020 builder identity: one builder per (data dir, project, repo); name cannot be a project container name', n.startsWith('claude-station-builder_') && n === pb.builderName('p1', 'r1') && n !== pb.builderName('p2', 'r1') && n !== pb.builderName('p1', 'r2') && pb.builderName('p1r', '1') !== pb.builderName('p1', 'r1'), n);
}
{
  // The Dockerfile is written by ANOTHER process (the in-container session) while
  // Orchard reads it: grade truncated states of a realistic file. Every partial
  // read must be handled (no throw), hash differently from the complete file, and
  // the complete file must hash to its own value once the write lands.
  const src = fs.readFileSync(process.env.F155_REAL_DOCKERFILE && fs.existsSync(process.env.F155_REAL_DOCKERFILE) ? process.env.F155_REAL_DOCKERFILE : path.join(ROOT, 'src/server/container/Dockerfile'));
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'f155-trunc-'));
  const i = { baseTag: 't', baseId: 'sha256:a', uid: 1000, gid: 1000 };
  const full = df.dockerfileHash(src, i);
  const cuts = [0, 1, Math.floor(src.length / 7), Math.floor(src.length / 3), Math.floor(src.length / 2), src.length - 1];
  const res = cuts.map((n) => {
    fs.writeFileSync(path.join(T, 'Dockerfile'), src.subarray(0, n));
    try {
      const r = df.readProjectDockerfile(T, 'Dockerfile');
      if (!r.ok) return { n, ok: false, err: r.error };
      return { n, ok: true, differs: df.dockerfileHash(r.bytes, i) !== full };
    } catch (e) { return { n, threw: String(e) }; }
  });
  fs.writeFileSync(path.join(T, 'Dockerfile'), src);
  const done = df.readProjectDockerfile(T, 'Dockerfile');
  check('truncated reads (file mid-write): each partial state is handled without throwing and hashes differently; the completed file hashes to its own value', res.every((r) => !r.threw && (r.ok ? r.differs : true)) && done.ok && df.dockerfileHash(done.bytes, i) === full, JSON.stringify(res.map((r) => (r.threw ? 'THREW' : r.ok ? (r.differs ? 'diff' : 'SAME') : 'err'))));
  fs.rmSync(T, { recursive: true, force: true });
}
{
  const b = Buffer.from('FROM x\n');
  const i = { baseTag: 't', baseId: 'sha256:a', uid: 1000, gid: 1000 };
  const h1 = df.dockerfileHash(b, i);
  check('hash: changes with the Dockerfile bytes, the base image id, the uid, the builder image and the owning data dir; fields are length-prefixed', h1 !== df.dockerfileHash(Buffer.from('FROM y\n'), i) && h1 !== df.dockerfileHash(b, { ...i, baseId: 'sha256:b' }) && h1 !== df.dockerfileHash(b, { ...i, uid: 1001 }) && h1 !== df.dockerfileHash(b, { ...i, builder: 'moby/buildkit@sha256:x' }) && h1 !== df.dockerfileHash(b, { ...i, owner: 'another-data-dir-key' }) && df.dockerfileHash(b, { ...i, baseTag: 'ab', baseId: 'c' }) !== df.dockerfileHash(b, { ...i, baseTag: 'a', baseId: 'bc' }) && /^[0-9a-f]{12}$/.test(h1), h1);
  const r1 = df.projectImageRepo('my-ml-project');
  const r2 = df.projectImageRepo('Foo');
  const r3 = df.projectImageRepo('foo');
  const r4 = df.projectImageRepo('a_b');
  const r5 = df.projectImageRepo('a-b');
  check('repo naming: a slug id is used as-is; non-slug ids get a hash suffix so ids never collide', r1 === 'claude-station-project-my-ml-project' && r2 !== r3 && r4 !== r5, `${r1} ${r2} ${r3} ${r4} ${r5}`);
  const dirty = 'ok\u001b[31mred\u001b[0m \u001b]8;;http://x\u0007link\u001b]8;;\u0007 \u0007bell\u0000nul\u009bcsi\nnext\tline';
  const clean = df.sanitiseBuildLog(dirty);
  check('log sanitiser: ANSI/OSC/C0/C1 control characters stripped, newline/tab kept', !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(clean) && clean.includes('\n') && clean.includes('\t') && clean.includes('red'), JSON.stringify(clean));
}

if (UNIT_ONLY) {
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

/* ------------------------------------------------------------ layer 2 */
console.log('\n[layer 2] live, scratch server + synthetic project repo');
async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'f155-df-data-'));
// FEAT-158: cleanup removes only what THIS scratch server owns (project names are fixed slugs).
const OWNER = await ownerKeyFor(DATA);
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'f155-df-work-'));
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), 'f155-df-outside-'));
fs.writeFileSync(path.join(OUTSIDE, 'secret.txt'), 'HOSTSECRET-f155-live\n');
fs.writeFileSync(path.join(WORK, 'README.md'), 'feat-155 dockerfile test repo\n');
fs.mkdirSync(path.join(WORK, 'pylibs'));
fs.writeFileSync(path.join(WORK, 'pylibs', 'mod.py'), 'X = 1\n');
fs.symlinkSync(path.join(OUTSIDE, 'secret.txt'), path.join(WORK, 'hostsecret'));
const DFPATH = path.join(WORK, 'Dockerfile.orchard');
const writeDf = (body) => fs.writeFileSync(DFPATH, `ARG ORCHARD_BASE_IMAGE\nFROM \${ORCHARD_BASE_IMAGE}\n${body}\n`);

const api = async (p, method = 'GET', body) => {
  const r = await fetch(BASE + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
const server = spawn(process.execPath, [path.join(ROOT, 'src/server/index.ts')], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA, F155_HOST_ENV_SENTINEL: 'HOSTENV-f155-sentinel' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => { if (/unhandled|TypeError|ReferenceError/i.test(String(d))) process.stderr.write(`  [server!] ${d}`); });

let pid = null, cname = null, repo = null, histPreexisted = true;
// FEAT-158 round 5: per-run unique — a fixed name let two runs (or anyone) lose this container to our `rm -f`.
const attackNoLock = `f155-attack-nolockdown-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
let attackNoLockId = '';
const madeIds = new Set(); // project ids this run's server created (their container names are then ours)
const cid = () => docker('inspect', cname, '--format', '{{.Id}}').stdout.trim();
const cimage = () => docker('inspect', cname, '--format', '{{.Config.Image}}').stdout.trim();
const execIn = (...a) => docker('exec', cname, ...a);
const status = async () => (await api(`/api/projects/${pid}/container/status`)).body;
const start = async () => api(`/api/projects/${pid}/container/start`, 'POST', {});
const tagsOf = () => docker('images', repo, '--format', '{{.Tag}}').stdout.split('\n').filter(Boolean);

try {
  for (let i = 0; i < 160; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await sleep(250); }
  const created = await api('/api/projects', 'POST', { hostPath: WORK, name: 'F155 Dockerfile', isolation: 'container' });
  if (created.status !== 201) throw new Error(`project create failed: ${JSON.stringify(created.body)}`);
  pid = created.body.project.id;
  histPreexisted = fs.existsSync(path.join(os.homedir(), '.claude', 'projects', `-workspace-${pid}`));
  cname = `claude-station-${pid}`;
  refuseTakenName(cname); madeIds.add(pid); // FEAT-158: never adopt another instance's same-named container
  repo = df.projectImageRepo(pid);

  // --- validation at the API
  const badPatch = await api(`/api/projects/${pid}`, 'PATCH', { settings: { container: { dockerfile: '../../etc/passwd' } } });
  check('API: a dockerfile path escaping the repo is refused at save', badPatch.status === 400, JSON.stringify(badPatch.body));

  // --- 1. first build + run
  writeDf('USER root\nRUN echo v1 > /opt/marker && env | sort > /opt/build-env\nCOPY pylibs /opt/pylibs\nUSER claude');
  const p1 = await api(`/api/projects/${pid}`, 'PATCH', { settings: { container: { image: 'ubuntu:24.04', dockerfile: './Dockerfile.orchard', gpu: 'off' } } });
  check('API: dockerfile saved normalised (and wins over a set image)', p1.status === 200 && p1.body.project?.settings?.container?.dockerfile === 'Dockerfile.orchard', JSON.stringify(p1.body.project?.settings?.container));
  const s1 = await start();
  const img1 = cimage();
  check('build 1: container runs on claude-station-project-<id>:df-<hash> (the Dockerfile wins over image)', s1.status === 200 && s1.body.state === 'running' && new RegExp(`^${repo}:df-[0-9a-f]{12}$`).test(img1), `${s1.status} ${s1.body?.state} ${img1} ${s1.body?.error ?? ''}`);
  check('build 1: the image content is the Dockerfile\'s (marker v1, COPY from the repo)', execIn('cat', '/opt/marker').stdout.trim() === 'v1' && execIn('cat', '/opt/pylibs/mod.py').stdout.includes('X = 1'), execIn('cat', '/opt/marker').stdout.trim());
  const benv = execIn('cat', '/opt/build-env').stdout;
  check('build: no host env reaches the build (server-env sentinel absent from RUN env)', !benv.includes('HOSTENV-f155') && benv.length > 0, `${benv.split('\n').length} lines`);
  const st1 = await status();
  check('status: dockerfile block says built, not fallen back', st1.dockerfile?.built === true && st1.dockerfile?.fellBack === false && st1.dockerfile?.effectiveImage === img1 && !st1.drifted, JSON.stringify(st1.dockerfile));
  const bl1 = await api(`/api/projects/${pid}/container/build`);
  check('API: GET /container/build returns state + the build log', bl1.status === 200 && bl1.body.build?.state === 'succeeded' && /#\d+ \[/.test(bl1.body.log ?? '') && /validated and tagged/.test(bl1.body.log), `${bl1.status} ${bl1.body?.build?.state} logBytes=${(bl1.body?.log ?? '').length}`);
  const noDf = await api(`/api/projects/${pid}/container/build`.replace(pid, 'nope-no-such'));
  check('API: /container/build 404s for an unknown project', noDf.status === 404, noDf.status);

  // --- 2. edit → rebuild on the next launch
  writeDf('USER root\nRUN echo v2 > /opt/marker\nUSER claude');
  await sleep(1700); // past the status cache TTL (1.5 s)
  const st2a = await status();
  check('change detected: status shows drift + not built before any launch', st2a.drifted === true && st2a.dockerfile?.built === false && (st2a.driftReasons ?? []).some((r) => r.startsWith('image ')), JSON.stringify(st2a.driftReasons));
  const s2 = await start();
  const img2 = cimage();
  check('rebuild on change: the next ensure builds and the container runs v2', s2.status === 200 && img2 !== img1 && execIn('cat', '/opt/marker').stdout.trim() === 'v2', `${img1} -> ${img2}`);
  check('prune: the superseded df image tag is reclaimed', !tagsOf().includes(img1.split(':')[1]) && tagsOf().includes(img2.split(':')[1]), JSON.stringify(tagsOf()));
  const good = img2;
  const goodId = cid();

  // --- 3. keep-last-good: a failing build
  writeDf('USER root\nRUN echo about to fail && exit 7\nUSER claude');
  const s3 = await start();
  const st3 = await status();
  check('failed build: ensure still answers running, SAME container (not recreated), still on the last good image', s3.status === 200 && s3.body.state === 'running' && cid() === goodId && cimage() === good, `${s3.status} ${s3.body?.state} same=${cid() === goodId} ${cimage()}`);
  check('failed build: status says fellBack, carries the error, not drifted', st3.dockerfile?.fellBack === true && /exit|failed|code/i.test(st3.dockerfile?.problem ?? '') && !st3.drifted && st3.dockerfile?.build?.state === 'failed', JSON.stringify(st3.dockerfile));
  const bl3 = await api(`/api/projects/${pid}/container/build`);
  check('failed build: the log shows the failing step', /about to fail/.test(bl3.body.log ?? '') && /exit code: 7|exit 7|did not complete successfully/i.test(bl3.body.log ?? ''), (bl3.body.log ?? '').split('\n').filter((l) => /ERROR|exit/i.test(l)).slice(-2).join(' | '));
  const startedAt3 = st3.dockerfile?.build?.startedAt;
  await start();
  const st3b = await status();
  check('failed build: a second launch does NOT retry the same failing Dockerfile', st3b.dockerfile?.build?.startedAt === startedAt3 && cid() === goodId, `${startedAt3} vs ${st3b.dockerfile?.build?.startedAt}`);
  const rb3 = await api(`/api/projects/${pid}/container/rebuild`, 'POST', {});
  check('Rebuild with a failing Dockerfile: error returned, container untouched and running', rb3.status >= 400 && /build/i.test(rb3.body?.error ?? '') && cid() === goodId && docker('inspect', cname, '--format', '{{.State.Running}}').stdout.trim() === 'true', `${rb3.status} ${String(rb3.body?.error).split('\n')[0]}`);

  // --- 4. a candidate that builds but breaks the CLI is rejected, never promoted
  writeDf('USER root\nRUN rm -f /home/claude/.local/bin/claude /usr/local/bin/claude /usr/bin/claude\nUSER claude');
  const s4 = await start();
  const st4 = await status();
  check('validation: an image without a working Claude CLI is rejected; container unchanged', s4.body.state === 'running' && cid() === goodId && st4.dockerfile?.fellBack === true && /Claude CLI/.test(st4.dockerfile?.problem ?? '') && !tagsOf().includes(`df-${st4.dockerfile?.hash}`), `${st4.dockerfile?.problem} tags=${JSON.stringify(tagsOf())}`);

  // --- 5. reserved env baked into the image is rejected
  writeDf('ENV CLAUDE_CONFIG_DIR=/tmp/elsewhere');
  await start();
  const st5 = await status();
  check('validation: an image ENV setting a reserved key (CLAUDE_CONFIG_DIR) is rejected', st5.dockerfile?.fellBack === true && /CLAUDE_CONFIG_DIR/.test(st5.dockerfile?.problem ?? '') && cid() === goodId, st5.dockerfile?.problem);

  // --- 6. ARCH-020: ADD is no longer refused by text; a URL on 127.0.0.1 is the BUILDER's own loopback, not
  // the host's, so Orchard's own API (on the host loopback) is unreachable from a build.
  writeDf(`ADD http://127.0.0.1:${PORT}/api/projects /tmp/leak.json`);
  await start();
  const st6 = await status();
  const bl6 = await api(`/api/projects/${pid}/container/build`);
  check('ADD http://127.0.0.1:<orchard port> (the host loopback) cannot reach the host from the builder: build fails, nothing leaked; still last good', st6.dockerfile?.fellBack === true && !/F155 Dockerfile/.test(bl6.body?.log ?? '') && cid() === goodId && /connection refused|dial tcp|failed/i.test(bl6.body?.log ?? ''), `${st6.dockerfile?.problem}`);

  // --- 7. symlinked Dockerfile → host secret
  const pSym = await api(`/api/projects/${pid}`, 'PATCH', { settings: { container: { dockerfile: 'hostsecret' } } });
  const s7 = await start();
  const st7 = await status();
  const bl7 = await api(`/api/projects/${pid}/container/build`);
  const leaked = JSON.stringify(st7).includes('HOSTSECRET') || JSON.stringify(bl7.body).includes('HOSTSECRET') || JSON.stringify(s7.body).includes('HOSTSECRET');
  check('symlink: a Dockerfile symlinked to a host file is refused; its content appears nowhere (status, log, ensure)', pSym.status === 200 && st7.dockerfile?.fellBack === true && /symlink/.test(st7.dockerfile?.problem ?? '') && !leaked && cid() === goodId, st7.dockerfile?.problem);
  await api(`/api/projects/${pid}`, 'PATCH', { settings: { container: { dockerfile: 'Dockerfile.orchard' } } });

  // --- 8. COPY of an in-repo symlink pointing outside: build fails, secret not in image or log
  writeDf('COPY hostsecret /tmp/hostsecret');
  await start();
  const st8 = await status();
  const bl8 = await api(`/api/projects/${pid}/container/build`);
  check('context: COPY of a repo symlink to a host file fails the build (context is the repo only); secret nowhere; still last good', st8.dockerfile?.fellBack === true && !JSON.stringify(bl8.body).includes('HOSTSECRET') && cid() === goodId, st8.dockerfile?.problem);

  // --- 9a. an image that cannot even start (its WORKDIR is a file) is rejected at validation
  writeDf('USER root\nRUN rm -rf /workspace && touch /workspace\nUSER claude');
  const s9a = await start();
  const st9a = await status();
  check('validation: an image that will not start is rejected; container unchanged', s9a.body.state === 'running' && cid() === goodId && st9a.dockerfile?.fellBack === true && /will not start|exits immediately/.test(st9a.dockerfile?.problem ?? ''), st9a.dockerfile?.problem);
  // --- 9b. passes validation (no binds there) but the REAL container cannot start: swap fails, old stays
  writeDf(`USER root\nRUN mkdir -p /workspace && touch /workspace/${pid}\nUSER claude`);
  const s9 = await start();
  const st9 = await status();
  check('swap failure: validated, but the real container cannot start (the repo bind target /workspace/<id> is a FILE in the image) — old container kept, same id, running; no -next left', s9.body.state === 'running' && cid() === goodId && st9.dockerfile?.fellBack === true && /would not run|not running|could not/i.test(st9.dockerfile?.problem ?? '') && docker('inspect', `${cname}-next`).status !== 0, `${s9.status} ${st9.dockerfile?.problem}`);

  // --- 10. SECURITY: the attack image
  writeDf([
    'USER root',
    'RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends libcap2-bin >/dev/null && rm -rf /var/lib/apt/lists/*',
    'RUN cp /bin/bash /opt/rootbash && chmod 4755 /opt/rootbash',
    'RUN cp "$(readlink -f /usr/bin/python3)" /opt/capy && setcap cap_setuid,cap_dac_override+ep /opt/capy',
    'RUN usermod -aG root,adm claude && chmod 666 /etc/group /etc/passwd',
    'RUN printf "#!/bin/sh\\ntouch /tmp/entry-ran\\nexec sleep infinity\\n" > /opt/entry && chmod 755 /opt/entry',
    'VOLUME /data',
    'LABEL claude-station.env-keys=SPOOF claude-station.project=someone-else',
    'STOPSIGNAL SIGKILL',
    'HEALTHCHECK --interval=2s CMD touch /tmp/hc-ran',
    'ENTRYPOINT ["/opt/entry"]',
    'CMD []',
    'USER root',
  ].join('\n'));
  const s10 = await start();
  const img10 = cimage();
  check('attack image builds and is promoted (all of it is legal image CONTENT)', s10.body.state === 'running' && img10 !== good && new RegExp(`${repo}:df-`).test(img10), `${img10} ${(await status()).dockerfile?.problem ?? ''}`);

  // must-FAIL baseline: the same image under the PRE-change create args (no --user/--entrypoint/--cap-drop ALL/--no-healthcheck)
  const base = docker('run', '-d', '--name', attackNoLock, '--init', '--security-opt', 'no-new-privileges:true', '--cap-drop', 'SYS_ADMIN', '--label', 'claude-station=0', img10);
  attackNoLockId = base.status === 0 ? base.stdout.trim() : ''; // FEAT-158: remove by the id this run created
  await sleep(3500);
  const blPid = docker('inspect', attackNoLock, '--format', '{{.State.Pid}}').stdout.trim();
  const blStatus = fs.existsSync(`/proc/${blPid}/status`) ? fs.readFileSync(`/proc/${blPid}/status`, 'utf8') : '';
  const blUid = /^Uid:\s*(\d+)/m.exec(blStatus)?.[1];
  const blEntry = docker('exec', attackNoLock, 'ls', '/tmp/entry-ran').status === 0;
  const blHc = docker('exec', attackNoLock, 'ls', '/tmp/hc-ran').status === 0;
  const blLabel = docker('inspect', attackNoLock, '--format', '{{index .Config.Labels "claude-station.env-keys"}}').stdout.trim();
  check('MUST-FAIL baseline: without the lockdown the attack works (PID1 uid 0, image ENTRYPOINT ran, HEALTHCHECK ran, env-keys label spoofed)', base.status === 0 && blUid === '0' && blEntry && blHc && blLabel === 'SPOOF', `uid=${blUid} entry=${blEntry} hc=${blHc} label=${blLabel}`);
  if (attackNoLockId) docker('rm', '-f', '-v', attackNoLockId);

  // under Orchard
  await sleep(3500); // > the image's 2s HEALTHCHECK interval, had it been kept
  const ins = JSON.parse(docker('inspect', cname).stdout)[0];
  const hostPid = ins.State.Pid;
  const pst = fs.readFileSync(`/proc/${hostPid}/status`, 'utf8');
  const f = (k) => (new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(pst)?.[1] ?? '').trim();
  const uid = String(os.userInfo().uid), gid = String(os.userInfo().gid);
  check('lockdown: container config pins user/entry/cmd/healthcheck/stop-signal/caps and our labels', ins.Config.User === `${uid}:${gid}` && JSON.stringify(ins.Config.Entrypoint) === '["sleep"]' && JSON.stringify(ins.Config.Cmd) === '["infinity"]' && JSON.stringify(ins.Config.Healthcheck?.Test) === '["NONE"]' && ins.Config.StopSignal === 'SIGTERM' && ins.HostConfig.CapDrop.includes('ALL') && ins.Config.Labels['claude-station.env-keys'] === '' && ins.Config.Labels['claude-station.project'] === pid, JSON.stringify({ u: ins.Config.User, e: ins.Config.Entrypoint, c: ins.Config.Cmd, h: ins.Config.Healthcheck, s: ins.Config.StopSignal, cd: ins.HostConfig.CapDrop, l: ins.Config.Labels['claude-station.env-keys'] }));
  check('lockdown (host /proc): PID1 runs as the host uid/gid, no supplementary groups, zero effective AND bounding capabilities', f('Uid').split(/\s+/).every((x) => x === uid) && f('Gid').split(/\s+/).every((x) => x === gid) && f('Groups').split(/\s+/).filter(Boolean).every((x) => x === gid) && /^0+$/.test(f('CapEff')) && /^0+$/.test(f('CapBnd')), `Uid=${f('Uid')} Gid=${f('Gid')} Groups=${f('Groups')} CapEff=${f('CapEff')} CapBnd=${f('CapBnd')}`);
  const top = docker('top', cname, '-o', 'pid,uid,args').stdout.trim().split('\n').slice(1);
  check('lockdown: no process in the container runs as root', top.length > 0 && top.every((l) => l.trim().split(/\s+/)[1] === uid), JSON.stringify(top));
  check('lockdown: the image ENTRYPOINT never ran, the HEALTHCHECK never ran', execIn('ls', '/tmp/entry-ran').status !== 0 && execIn('ls', '/tmp/hc-ran').status !== 0, 'absent');
  const rb = execIn('/opt/rootbash', '-p', '-c', 'id -u; cat /proc/self/status | grep ^CapEff');
  check('lockdown: a setuid-root bash does not give euid 0 (no-new-privileges)', rb.stdout.trim().startsWith(uid), rb.stdout.trim().replace(/\n/g, ' '));
  const cap = execIn('/opt/capy', '-c', 'import os\ntry:\n  os.setuid(0); print("ESCALATED", os.getuid())\nexcept Exception as e:\n  print("denied", type(e).__name__)');
  // Either the kernel refuses to exec a file-capability binary at all (empty bounding set + NNP → EPERM), or it runs without the capability.
  check('lockdown: a file-capability (cap_setuid) python cannot setuid(0)', !/ESCALATED/.test(cap.stdout) && (/denied/.test(cap.stdout) || /operation not permitted/i.test(cap.stderr + cap.stdout)), (cap.stdout + cap.stderr).trim().slice(0, 200));
  execIn('sh', '-c', 'echo "wheel2:x:0:claude" >> /etc/group; sed -i "s/^root:x:0:.*/root:x:0:claude/" /etc/group');
  const idg = docker('exec', '--user', `${uid}:${gid}`, cname, 'id', '-G').stdout.trim();
  const idgDefault = execIn('id', '-G').stdout.trim();
  check('lockdown: an /etc/group the session can write grants no group to a new exec (session exec and helper exec)', idg === gid && idgDefault === gid, `session-exec=${idg} helper-exec=${idgDefault}`);
  execIn('touch', '/workspace/' + pid + '/owned-by-whom');
  const wsFile = fs.readdirSync(WORK).includes('owned-by-whom') ? path.join(WORK, 'owned-by-whom') : null;
  check('lockdown: a file the container writes into the repo is owned by the host user, not root', !!wsFile && String(fs.statSync(wsFile).uid) === uid, wsFile ? fs.statSync(wsFile).uid : 'not found');
  const volBefore = docker('volume', 'ls', '-q', '--filter', 'dangling=true').stdout.split('\n').filter(Boolean).length;

  // --- 11. back to a good Dockerfile: the attack container is swapped out; its VOLUME is reclaimed
  writeDf('USER root\nRUN echo v3 > /opt/marker\nUSER claude');
  const s11 = await start();
  const volAfter = docker('volume', 'ls', '-q', '--filter', 'dangling=true').stdout.split('\n').filter(Boolean).length;
  check('recovery: a good Dockerfile again → swapped to v3; the attack container\'s anonymous VOLUME is not leaked', s11.body.state === 'running' && execIn('cat', '/opt/marker').stdout.trim() === 'v3' && volAfter <= volBefore, `vols ${volBefore} -> ${volAfter}`);

  // --- 12. build record persists across a restart
  const recFiles = fs.readdirSync(path.join(DATA, 'container-builds'));
  check('persistence: the build record (last good image, state) is on disk under the data dir', recFiles.length === 1 && JSON.parse(fs.readFileSync(path.join(DATA, 'container-builds', recFiles[0]), 'utf8')).lastGoodImage === cimage(), recFiles.join(','));

  // --- 13. Orchard's own build config holds no credentials
  const cfgDir = path.join(DATA, 'docker-build-config');
  check('build isolation: builds use an Orchard-owned EMPTY docker client config (no registry credentials)', fs.existsSync(cfgDir) && !fs.existsSync(path.join(cfgDir, 'config.json')), fs.existsSync(cfgDir) ? fs.readdirSync(cfgDir).join(',') || '(empty)' : 'missing');

  // --- 14. clean-room round 1 finding 2 (live): another project's image cannot be read
  writeDf(`COPY --from=${cimage()} /opt/marker /opt/stolen`);
  await start();
  const st14 = await status();
  check('cross-project: COPY --from=<another project\'s LOCAL image> fails structurally (the builder has no host image store); still last good', st14.dockerfile?.fellBack === true && /pull access denied|failed to resolve|not found|insufficient_scope/i.test(`${st14.dockerfile?.problem} ${(await api(`/api/projects/${pid}/container/build`)).body?.log ?? ''}`) && execIn('ls', '/opt/stolen').status !== 0, st14.dockerfile?.problem);
  writeDf('USER root\nRUN echo v3 > /opt/marker\nUSER claude');
  await start();

  // --- 14a. ARCH-020: the file's exact bytes are built (no canonicaliser) — an awkwardly formatted
  // Dockerfile (continuations, a blank line and a comment inside one, trailing comments) builds as BuildKit reads it.
  writeDf('USER root\nRUN echo a \\\n\n  # comment inside a continuation\n    && echo b > /opt/marker2\n\n# trailing comment\nCOPY README.md /opt/readme\nUSER claude');
  await start();
  check('raw bytes built: an awkwardly formatted Dockerfile builds (marker2 = b)', execIn('cat', '/opt/marker2').stdout.trim() === 'b', execIn('cat', '/opt/marker2').stdout.trim());

  // --- 14b. a heredoc (no longer refused) that also tries to read a local image: the local image cannot be read.
  writeDf(`RUN <<'#X'\necho hi \\\n#X\nCOPY --from=${cimage()} /opt/marker /opt/stolen`);
  await start();
  const st14b = await status();
  check('heredoc allowed, but its COPY --from=<local image> still cannot resolve; still last good', st14b.dockerfile?.fellBack === true && execIn('ls', '/opt/stolen').status !== 0, st14b.dockerfile?.problem);
  writeDf('USER root\nRUN echo v3b > /opt/marker\nUSER claude');
  await start();
  const bl14 = (await api(`/api/projects/${pid}/container/build`)).body?.log ?? '';
  check('structural: Orchard\'s build takes its base from the named OCI context, not the local image store', /\[context orchard-base\]|orchard-base/.test(bl14) && execIn('cat', '/opt/marker').stdout.trim() === 'v3b', bl14.split('\n').filter((l) => /orchard-base|oci-layout/.test(l)).slice(0, 2).join(' | '));
  {
    // ARCH-020: this project's builder exists, is stopped between builds, is not privileged, publishes
    // nothing, and mounts exactly its own state volume.
    const names = docker('ps', '-a', '--filter', `label=claude-station.builder-project=${pid}`, '--format', '{{.Names}}').stdout.split('\n').filter(Boolean);
    const bi = names.length === 1 ? JSON.parse(docker('inspect', names[0]).stdout)[0] : null;
    check('ARCH-020 builder: exactly one per project, stopped after the build, unprivileged, no ports, only its own volume', !!bi && bi.State.Running === false && bi.HostConfig.Privileged === false && !Object.keys(bi.HostConfig.PortBindings ?? {}).length && bi.Mounts.length === 1 && bi.Mounts[0].Name === names[0] && bi.Config.User === '1000:1000', JSON.stringify(bi && { n: names, run: bi.State.Running, priv: bi.HostConfig.Privileged, m: bi.Mounts.map((m) => m.Name) }));
  }

  // --- 15. clean-room round 1 finding 1 (live): a project deleted and re-created with the SAME name on a
  // DIFFERENT repo must not inherit the old project's images / record / log.
  {
    const RA = fs.mkdtempSync(path.join(os.tmpdir(), 'f155-df-ra-'));
    const RB = fs.mkdtempSync(path.join(os.tmpdir(), 'f155-df-rb-'));
    const dfBody = 'ARG ORCHARD_BASE_IMAGE\nFROM ${ORCHARD_BASE_IMAGE}\nCOPY canary.txt /opt/canary.txt\n';
    fs.writeFileSync(path.join(RA, 'canary.txt'), 'CANARY-OLD-REPO\n'); fs.writeFileSync(path.join(RA, 'Dockerfile'), dfBody);
    fs.writeFileSync(path.join(RB, 'canary.txt'), 'CANARY-NEW-REPO\n'); fs.writeFileSync(path.join(RB, 'Dockerfile'), dfBody);
    const mk = async (dir) => {
      const c = await api('/api/projects', 'POST', { hostPath: dir, name: 'F155 Reuse', isolation: 'container' });
      const id = c.body.project.id;
      if (!madeIds.has(id)) { refuseTakenName(`claude-station-${id}`); madeIds.add(id); } // FEAT-158
      await api(`/api/projects/${id}`, 'PATCH', { settings: { container: { dockerfile: 'Dockerfile', gpu: 'off' } } });
      return id;
    };
    const idA = await mk(RA);
    const hpA = fs.existsSync(path.join(os.homedir(), '.claude', 'projects', `-workspace-${idA}`));
    const sA = await api(`/api/projects/${idA}/container/start`, 'POST', {});
    const canA = docker('exec', `claude-station-${idA}`, 'cat', '/opt/canary.txt').stdout.trim();
    await api(`/api/projects/${idA}/container/remove`, 'POST', {});
    const del = await api(`/api/projects/${idA}?confirm=${idA}`, 'DELETE');
    const idB = await mk(RB);
    const sB = await api(`/api/projects/${idB}/container/start`, 'POST', {});
    const canB = docker('exec', `claude-station-${idB}`, 'cat', '/opt/canary.txt').stdout.trim();
    const bl = await api(`/api/projects/${idB}/container/build`);
    check('id reuse: a same-name project on a different repo builds its OWN image (its own canary), not the deleted project\'s', sA.body?.state === 'running' && canA === 'CANARY-OLD-REPO' && idB === idA && sB.body?.state === 'running' && canB === 'CANARY-NEW-REPO' && !/CANARY-OLD/.test(bl.body?.log ?? ''), `A=${idA} ${canA} del=${del.status} B=${idB} ${canB}`);
    fs.writeFileSync(path.join(RB, 'Dockerfile'), dfBody + 'RUN exit 7\n');
    await api(`/api/projects/${idB}/container/remove`, 'POST', {});
    const sB2 = await api(`/api/projects/${idB}/container/start`, 'POST', {});
    const canB2 = sB2.body?.state === 'running' ? docker('exec', `claude-station-${idB}`, 'cat', '/opt/canary.txt').stdout.trim() : '(no container)';
    check('id reuse: when the new project\'s build fails, keep-last-good never falls back onto the deleted project\'s image', canB2 !== 'CANARY-OLD-REPO', `${sB2.status} ${sB2.body?.state ?? ''} canary=${canB2} ${String(sB2.body?.error ?? '').split('\n')[0]}`);
    removeOwnedContainer(`claude-station-${idB}`, OWNER, { volumes: true });
    removeOwnedImages(df.projectImageRepo(idB), OWNER);
    await api(`/api/projects/${idB}?confirm=${idB}`, 'DELETE');
    if (!hpA) { try { fs.rmSync(path.join(os.homedir(), '.claude', 'projects', `-workspace-${idA}`), { recursive: true, force: true }); } catch {} }
    for (const d of [RA, RB]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  }

  // --- 16. verify round 10 (run 143c1a3a): the build cache is per project. Two projects on different repos
  // with the same Dockerfile must NOT share a RUN layer (a random nonce written at build time differs), while a
  // project's own rebuild still hits its own cache (the nonce survives an appended step).
  {
    const tagU = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // Round 11 (run ac8ddf26) shape: the RUN is in an intermediate stage that sets ENV ORCHARD_BUILD_SCOPE (which
    // shadowed round 10's ARG-based scope), and the nonce is copied into a clean final stage.
    // Round 12 (run a329d179) shape too: a COPY of IDENTICAL bytes with a different mtime per repo, and a WORKDIR.
    const body = `ARG ORCHARD_BASE_IMAGE\nFROM \${ORCHARD_BASE_IMAGE} AS gen\nENV ORCHARD_BUILD_SCOPE=f155-shadow\nUSER root\nRUN echo ${tagU}; head -c16 /dev/urandom | od -An -tx1 | tr -d ' \\n' > /opt/nonce\nFROM \${ORCHARD_BASE_IMAGE}\nCOPY same-${tagU}.txt /opt/same.txt\nWORKDIR /opt/w-${tagU}\nCOPY --from=gen /opt/nonce /opt/nonce\n`;
    const dirs = [fs.mkdtempSync(path.join(os.tmpdir(), 'f155-df-ca-')), fs.mkdtempSync(path.join(os.tmpdir(), 'f155-df-cb-'))];
    const ids = [];
    const hp = [];
    try {
      for (const [i, d] of dirs.entries()) {
        fs.writeFileSync(path.join(d, 'Dockerfile'), body);
        fs.writeFileSync(path.join(d, `same-${tagU}.txt`), 'identical bytes\n');
        fs.utimesSync(path.join(d, `same-${tagU}.txt`), 1111111111 + i * 111111111, 1111111111 + i * 111111111);
        const c = await api('/api/projects', 'POST', { hostPath: d, name: `F155 Cache ${i ? 'B' : 'A'}`, isolation: 'container' });
        ids.push(c.body.project.id);
        if (!madeIds.has(c.body.project.id)) { refuseTakenName(`claude-station-${c.body.project.id}`); madeIds.add(c.body.project.id); } // FEAT-158
        hp.push(fs.existsSync(path.join(os.homedir(), '.claude', 'projects', `-workspace-${c.body.project.id}`)));
        await api(`/api/projects/${c.body.project.id}`, 'PATCH', { settings: { container: { dockerfile: 'Dockerfile', gpu: 'off' } } });
      }
      const nonce = (id) => docker('exec', `claude-station-${id}`, 'cat', '/opt/nonce').stdout.trim();
      const sa = await api(`/api/projects/${ids[0]}/container/start`, 'POST', {});
      const sb = await api(`/api/projects/${ids[1]}/container/start`, 'POST', {});
      const na = nonce(ids[0]); const nb = nonce(ids[1]);
      const logB = (await api(`/api/projects/${ids[1]}/container/build`)).body?.log ?? '';
      const mt = (id) => docker('exec', `claude-station-${id}`, 'stat', '-c', '%Y', '/opt/same.txt').stdout.trim();
      const mta = mt(ids[0]); const mtb = mt(ids[1]);
      const anyCachedB = /#\d+ \[[^\]]*\] (?:COPY same-|WORKDIR|RUN echo)[^\n]*\n#\d+ CACHED/.test(logB);
      check('cache scope: identical COPY bytes in two projects are NOT served from the other project\'s layer (each image keeps its OWN file mtime; no COPY/WORKDIR/RUN step CACHED)', mta === '1111111111' && mtb === '1222222222' && !anyCachedB, `A=${mta} B=${mtb} B-anyCached=${anyCachedB}`);
      const nonceStepCachedB = new RegExp(`RUN echo ${tagU}[^\\n]*\\n#\\d+ CACHED`).test(logB);
      check('cache scope: two projects with the same Dockerfile (both shadowing ORCHARD_BUILD_SCOPE via ENV in a stage) do NOT share a built RUN layer (different build-time nonces, no CACHED step)', sa.body?.state === 'running' && sb.body?.state === 'running' && /^[0-9a-f]{32}$/.test(na) && /^[0-9a-f]{32}$/.test(nb) && na !== nb && !nonceStepCachedB, `A=${na} B=${nb} B-cached=${nonceStepCachedB}`);
      fs.writeFileSync(path.join(dirs[0], 'Dockerfile'), `${body}RUN true\n`);
      const sa2 = await api(`/api/projects/${ids[0]}/container/start`, 'POST', {});
      const na2 = nonce(ids[0]);
      const logA2 = (await api(`/api/projects/${ids[0]}/container/build`)).body?.log ?? '';
      const recA = JSON.parse(fs.readFileSync(path.join(DATA, 'container-builds', `${crypto.createHash('sha256').update(ids[0]).digest('hex').slice(0, 24)}.json`), 'utf8'));
      const envA = docker('image', 'inspect', docker('inspect', `claude-station-${ids[0]}`, '--format', '{{.Config.Image}}').stdout.trim(), '--format', '{{json .Config.Env}}').stdout;
      const stub = docker('exec', `claude-station-${ids[0]}`, 'ls', '-A', '/run').stdout;
      check('own cache: a project\'s own rebuild still reuses its own builder\'s cache (nonce unchanged after an appended step); no scope marker is injected any more', sa2.body?.state === 'running' && na2 === na && docker('exec', `claude-station-${ids[0]}`, 'ls', '/.orchard-build-scope').status !== 0 && !envA.includes('ORCHARD_BUILD_SCOPE') && typeof recA === 'object', `A2=${na2} logCached=${/CACHED/.test(logA2)} run=[${stub.trim().split('\n').join(',')}]`);
    } finally {
      for (const [i, id] of ids.entries()) {
        removeOwnedContainer(`claude-station-${id}`, OWNER, { volumes: true });
        removeOwnedImages(df.projectImageRepo(id), OWNER);
        pruneOwnedImages(OWNER, [`claude-station.dockerfile-project=${id}`]);
        await api(`/api/projects/${id}?confirm=${id}`, 'DELETE');
        if (!hp[i]) { try { fs.rmSync(path.join(os.homedir(), '.claude', 'projects', `-workspace-${id}`), { recursive: true, force: true }); } catch {} }
      }
      for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
    }
  }

  /* -------------------------------------------------------- layer 3 */
  console.log('\n[layer 3] in-process: deferral under live sessions; -next leftover');
  server.kill('SIGKILL');
  await sleep(500);
  process.env.CLAUDE_STATION_DATA = DATA;
  const cm = await import(path.join(ROOT, 'src/server/container-manager.ts'));
  const reg = JSON.parse(fs.readFileSync(path.join(DATA, 'registry.json'), 'utf8'));
  const project = reg.projects.find((p) => p.id === pid);
  /*
   * ARCH-022: "other sessions are live" is a LEASE the lifecycle authority granted when a session was
   * admitted — so a session is admitted first (the container is current), then the Dockerfile changes,
   * then a second launch arrives. On a pre-ARCH-022 tree the old liveness flag stands in for it.
   */
  const { bootAuthority } = await import('./lib/lifecycle-harness.mjs');
  const H = await bootAuthority(ROOT);
  const liveTag = `f155df-${Date.now().toString(36)}`;
  if (H.lc) { await cm.admitContainer(project, liveTag, {}); H.lc.attachLease(liveTag, 'f155df-session'); }
  const idBefore = cid();
  writeDf('USER root\nRUN echo v4 > /opt/marker\nUSER claude');
  const logs = [];
  const d1 = H.lc
    ? await cm.admitContainer(project, `${liveTag}-2`, { onLog: (s) => logs.push(s) })
    : await cm.ensureContainer(project, { deferImageSwap: true, onLog: (s) => logs.push(s) });
  if (H.lc) {
    for (const t of [liveTag, `${liveTag}-2`]) H.lc.drainLease(t);
    for (let i = 0; i < 60 && H.lc.leasesOf(pid).length; i++) await sleep(500);
  }
  check('deferral: with other sessions live, a new image is BUILT but the container is NOT recreated under them', d1.state === 'running' && cid() === idBefore && execIn('cat', '/opt/marker').stdout.trim() === 'v3b' && tagsOf().includes(`df-${cm.resolveProjectDockerfile(project).hash}`) && logs.some((l) => /other sessions are live/.test(l)), logs.filter((l) => /live|build/.test(l)).join(' | ').slice(0, 300));
  docker('create', '--name', `${cname}-next`, '--label', 'claude-station=1', '--label', `claude-station.project=${pid}`, '--label', `claude-station.owner=${OWNER}`, cimage()); // owner: FEAT-158 cleanup removes only owned
  const d2 = await cm.ensureContainer(project, { onLog: () => {} });
  check('no live sessions: the deferred image is applied (v4); a stale -next from an interrupted swap is cleared', d2.state === 'running' && execIn('cat', '/opt/marker').stdout.trim() === 'v4' && docker('inspect', `${cname}-next`).status !== 0, cimage());
  const argv = cm.execArgv(project, { command: '/home/claude/.local/bin/claude', args: [], env: {}, execId: 'x1' });
  check('anti-regression: session exec still pins --user host uid:gid and HOME', argv.includes('--user') && argv[argv.indexOf('--user') + 1] === `${uid}:${gid}` && argv.includes(`HOME=/home/claude`), argv.join(' '));
} catch (err) {
  check('no exception during the live run', false, String(err?.stack || err));
} finally {
  try { server.kill('SIGKILL'); } catch {}
  if (cname) { removeOwnedContainer(cname, OWNER, { volumes: true }); removeOwnedContainer(`${cname}-next`, OWNER, { volumes: true }); }
  if (attackNoLockId) docker('rm', '-f', '-v', attackNoLockId);
  if (repo) removeOwnedImages(repo, OWNER);
  if (repo) pruneOwnedImages(OWNER, [`claude-station.dockerfile-project=${pid}`]);
  // ARCH-020: this data dir's builders (containers + cache volumes) — only ours, by the data-dir label.
  try { await removeScratchBuilders(DATA); } catch {}
  for (const d of [DATA, WORK, OUTSIDE]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  if (pid && !histPreexisted) { try { fs.rmSync(path.join(os.homedir(), '.claude', 'projects', `-workspace-${pid}`), { recursive: true, force: true }); } catch {} }
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
