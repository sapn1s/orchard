/**
 * BUG-089 — the client's save echo-check (public/lib/api.js `patchProject` /
 * `echoed()` / `covers()`) is SUBSET-aware: a partial settings patch verifies as
 * persisted when every field the client SENT is present-and-equal in the server's
 * echo, EVEN THOUGH the server default-fills extra sibling keys the client never
 * sent. A server that echoes a DIFFERENT value for a SENT field must still report
 * failure (no false success).
 *
 *   node scripts/verify-bug-089-echo-subset.mjs
 *
 * Boots a REAL station server on a free ephemeral port with a scratch dataDir
 * (never :4317, never the user's registry) and drives the ACTUAL client in
 * public/lib/api.js `patchProject` — the exact echo-checked save the drawer
 * calls — against a REALISTIC older-project fixture whose stored settings have
 * NO `tools` and only a PARTIAL `browser`/`snapshots` (the state of any project
 * predating FEAT-025). This is the state the reporting user was in; a fresh
 * project stores full settings objects and would never exercise the bug.
 *
 * MUST-FAIL pre-fix: with the strict key-count `same()` echo-check (the pre-089
 * code), the partial sends throw "settings did not persist" because the server's
 * defaults-filled echo is a superset. That is proven by cases A1/A2/A3 below,
 * which pass ONLY once `covers()` (subset-aware) is in place.
 *
 * The wrong-value guard (B1) uses a monkeypatched fetch that rewrites the echoed
 * value for a SENT field, proving covers() still reports failure on a genuine
 * disagreement — so the subset fix did not turn into "accept anything".
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';

const ROOT = path.resolve(import.meta.dirname, '..');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug089-data-'));
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug089-scratch-'));
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug089-proj-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  const srv = spawn('node', ['src/server/index.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      CLAUDE_STATION_DATA: dataDir,
      CLAUDE_STATION_SCRATCH_DIR: scratchDir,
      CLAUDE_STATION_NO_WA_CONSOLIDATE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvErr = '';
  srv.stderr.on('data', (d) => { srvErr += d; });

  const realFetch = globalThis.fetch;
  // The client module speaks browser-relative paths ("/api/..."); node's fetch
  // needs an absolute URL. Rewrite relative paths onto this scratch server so the
  // REAL api.js runs unmodified.
  globalThis.fetch = (input, init) =>
    realFetch(typeof input === 'string' && input.startsWith('/') ? base + input : input, init);

  const cleanup = () => {
    globalThis.fetch = realFetch;
    try { srv.kill('SIGTERM'); } catch { /* already gone */ }
  };

  try {
    let up = false;
    for (let i = 0; i < 150; i++) {
      try { const r = await realFetch(base + '/api/projects'); if (r.ok) { up = true; break; } } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!up) throw new Error(`server did not come up on ${base}\n${srvErr}`);

    const regFile = path.join(dataDir, 'registry.json');
    const j = async (method, url, body) => {
      const r = await realFetch(base + url, {
        method, headers: { 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    // Rewrite the stored registry to model a REAL older project: no `tools` key,
    // a PARTIAL browser (only `enabled`, no defaults), a PARTIAL snapshots (only
    // `keep`, no `exclude`). The server default-fills the rest on echo.
    const makeOlderProject = (id) => {
      const reg = JSON.parse(fs.readFileSync(regFile, 'utf8'));
      const p = reg.projects.find((x) => x.id === id);
      delete p.settings.tools;
      p.settings.browser = { enabled: false };
      p.settings.snapshots = { keep: 3 };
      fs.writeFileSync(regFile, `${JSON.stringify(reg, null, 2)}\n`);
    };

    const api = await import(path.join(ROOT, 'public', 'lib', 'api.js'));

    const created = await j('POST', '/api/projects', { hostPath: projDir, name: 'BUG089' });
    const id = created.body.project.id;
    makeOlderProject(id);

    const stored = await j('GET', `/api/projects/${id}`);
    check('(F0) realistic older-project fixture: no tools, partial browser (only enabled), partial snapshots (only keep)',
      stored.body.project.settings.tools === undefined
        && stored.body.project.settings.browser && !('devtools' in stored.body.project.settings.browser)
        && stored.body.project.settings.snapshots && !('exclude' in stored.body.project.settings.snapshots),
      { tools: stored.body.project.settings.tools, browser: stored.body.project.settings.browser, snapshots: stored.body.project.settings.snapshots });

    // (A1) partial TOOLS patch: client sends {playwright:true} on a no-tools
    // project; the server echoes the defaults-filled superset {serena,playwright}.
    // Subset-aware → SUCCESS. (Pre-fix strict key-count → throws "did not persist".)
    let a1ok = null, a1err = null;
    try { a1ok = await api.patchProject(id, { tools: { playwright: true } }); }
    catch (err) { a1err = err.message; }
    check('(A1) MUST-FAIL-pre-fix: partial {tools:{playwright:true}} on a no-tools project reports SUCCESS (subset match, server default-fill ignored)',
      a1err === null && a1ok?.settings?.tools?.playwright === true && a1ok?.settings?.tools?.serena === true,
      a1err ?? a1ok?.settings?.tools);

    makeOlderProject(id);
    // (A2) partial BROWSER patch: send {enabled:true}; server echoes the
    // defaults-filled browser object (extra sibling keys). Subset-aware → SUCCESS.
    let a2ok = null, a2err = null;
    try { a2ok = await api.patchProject(id, { browser: { enabled: true } }); }
    catch (err) { a2err = err.message; }
    check('(A2) MUST-FAIL-pre-fix: partial {browser:{enabled:true}} reports SUCCESS (server-added browser defaults ignored)',
      a2err === null && a2ok?.settings?.browser?.enabled === true,
      a2err ?? a2ok?.settings?.browser);

    makeOlderProject(id);
    // (A3) partial SNAPSHOTS patch: send {keep:9}; server echoes keep + the
    // default `exclude` array. Subset-aware → SUCCESS; exclude ignored.
    let a3ok = null, a3err = null;
    try { a3ok = await api.patchProject(id, { snapshots: { keep: 9 } }); }
    catch (err) { a3err = err.message; }
    check('(A3) MUST-FAIL-pre-fix: partial {snapshots:{keep:9}} reports SUCCESS (server default `exclude` sibling ignored)',
      a3err === null && a3ok?.settings?.snapshots?.keep === 9 && Array.isArray(a3ok?.settings?.snapshots?.exclude),
      a3err ?? a3ok?.settings?.snapshots);

    // (A4) a genuine echo superset the OTHER direction — top-level name change on
    // the same project — still verifies (sanity that non-settings paths untouched).
    let a4ok = null, a4err = null;
    try { a4ok = await api.patchProject(id, { name: 'BUG089-renamed' }); }
    catch (err) { a4err = err.message; }
    check('(A4) top-level {name} still verifies through covers() (non-settings path unaffected)',
      a4err === null && a4ok?.name === 'BUG089-renamed', a4err ?? a4ok?.name);

    // ---- (B1) WRONG-VALUE guard: the server echoes a DIFFERENT value for a SENT
    // field. covers() must STILL report failure (no false success from subset). We
    // monkeypatch fetch to corrupt the echoed PATCH response for this one call.
    makeOlderProject(id);
    const patchedFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const r = await patchedFetch(input, init);
      const url = typeof input === 'string' ? input : input?.url ?? '';
      if ((init?.method === 'PATCH') && url.includes(`/api/projects/${id}`)) {
        const data = await r.clone().json().catch(() => null);
        if (data?.project?.settings?.tools) {
          // Client SENT playwright:true; make the server "echo" playwright:false —
          // a genuine did-not-persist that subset semantics must NOT excuse.
          data.project.settings.tools.playwright = false;
          return new Response(JSON.stringify(data), { status: r.status, headers: { 'content-type': 'application/json' } });
        }
      }
      return r;
    };
    let b1threw = null, b1ret = null;
    try { b1ret = await api.patchProject(id, { tools: { playwright: true } }); }
    catch (err) { b1threw = err.message; }
    globalThis.fetch = patchedFetch;
    check('(B1) wrong-value guard: server echoing playwright:false for a SENT playwright:true STILL reports failure (no false success)',
      typeof b1threw === 'string' && /did not persist/.test(b1threw) && b1ret === null,
      b1threw ?? `unexpected success: ${JSON.stringify(b1ret?.settings?.tools)}`);

    console.log(`\n${pass}/${pass + fail} checks passed`);
    if (fail) console.log(`failed: ${failures.join(' | ')}`);
    process.exitCode = fail ? 1 : 0;
  } finally {
    cleanup();
  }
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.stack ?? err.message}`);
  process.exitCode = 1;
});
