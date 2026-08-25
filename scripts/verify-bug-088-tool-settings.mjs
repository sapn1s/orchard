/**
 * BUG-088 — tool settings (Serena / Playwright), browser and snapshots persist
 * through the project PATCH route, and the drawer's save no longer misreports a
 * real save as "settings did not persist: tools".
 *
 *   node scripts/verify-bug-088-tool-settings.mjs
 *
 * Boots a REAL station server on a free ephemeral port with a scratch dataDir
 * (never :4317, never the user's registry) and exercises:
 *
 *   - the live HTTP PATCH/GET route (server-side persistence + validation), and
 *   - the ACTUAL client in public/lib/api.js `patchProject` — the exact
 *     echo-checked save the drawer calls — against the browser-relative fetch
 *     paths, so the client's persist verdict is tested end to end.
 *
 * WHAT THE TICKET GOT WRONG (documented honestly by this suite): the ticket's
 * "confirmed" root cause was a MISSING server copy block for `tools`. There is
 * no such gap — validate.ts already validates+copies tools/browser/snapshots and
 * updateProject merges them against defaults, so cases (S1..S4) PASS on the code
 * as-shipped; they are kept as anti-regression guards, not as the fix's proof.
 *
 * THE REAL BUG (reproduced by case C1, cured by C2 + the drawer wiring W1/W2):
 * api.patchProject's echo-check compares the object it SENT key-for-key against
 * the object the server ECHOES. On a project whose stored `settings.tools` is
 * ABSENT or PARTIAL (any project predating FEAT-025 — i.e. a real, older
 * project, NOT a freshly-created one), the drawer used to send a one-key partial
 * `{playwright:true}`; the server correctly echoes the defaults-filled
 * `{serena:true, playwright:true}` (a superset), which the echo-check read as
 * "did not persist" and surfaced to the user as
 *   "could not save tool settings: settings did not persist: tools".
 * The fix makes the drawer send the resolved FULL tool object, so sent===echoed.
 *
 * REALISTIC-STATE FIXTURE (per the worker rules): the decisive case runs against
 * a project with NO stored `tools` key — the state the reporting user was in — and
 * with BOTH tools resolved, not a one-field stub. A fresh project stores a full
 * tools object and so never hits this; testing only that would have missed it.
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug088-data-'));
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug088-scratch-'));
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug088-proj-'));
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
    // Wait for the server to answer.
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
    const stripToolsKey = (id) => {
      const reg = JSON.parse(fs.readFileSync(regFile, 'utf8'));
      const p = reg.projects.find((x) => x.id === id);
      delete p.settings.tools;
      fs.writeFileSync(regFile, `${JSON.stringify(reg, null, 2)}\n`);
    };

    const api = await import(path.join(ROOT, 'public', 'lib', 'api.js'));

    // ---- Fixture A: a REALISTIC project with BOTH tools already set ----------
    const created = await j('POST', '/api/projects', { hostPath: projDir, name: 'BUG088' });
    const id = created.body.project.id;
    // Seed the realistic state: serena OFF, playwright OFF (both explicitly set).
    await j('PATCH', `/api/projects/${id}`, { settings: { tools: { serena: false, playwright: false } } });

    // (S1) server persists a tools flip
    const s1 = await j('PATCH', `/api/projects/${id}`, { settings: { tools: { playwright: true } } });
    const s1get = await j('GET', `/api/projects/${id}`);
    check('(S1) PATCH tools.playwright=true persists through GET',
      s1.body.project?.settings?.tools?.playwright === true && s1get.body.project.settings.tools.playwright === true,
      s1get.body.project.settings.tools);

    // (S2) a PARTIAL tools patch does NOT wipe the sibling tool
    check('(S2) partial {playwright:true} preserves serena:false (sibling not clobbered)',
      s1get.body.project.settings.tools.serena === false,
      s1get.body.project.settings.tools);

    // (S3) browser + snapshots persist through the same route
    const br = await j('PATCH', `/api/projects/${id}`, { settings: { browser: { enabled: true } } });
    check('(S3a) browser.enabled persists', br.body.project?.settings?.browser?.enabled === true, br.body.project?.settings?.browser);
    const sn = await j('PATCH', `/api/projects/${id}`, { settings: { snapshots: { keep: 42 } } });
    check('(S3b) snapshots.keep persists AND exclude default is preserved (partial merge)',
      sn.body.project?.settings?.snapshots?.keep === 42 && Array.isArray(sn.body.project?.settings?.snapshots?.exclude) && sn.body.project.settings.snapshots.exclude.length > 0,
      sn.body.project?.settings?.snapshots);

    // (S4) an unknown tools key is rejected with a clear message
    const bad = await j('PATCH', `/api/projects/${id}`, { settings: { tools: { foo: true } } });
    check('(S4) unknown tools key {foo:true} rejected 400 with a legible error',
      bad.status === 400 && /unknown tools field "foo"/.test(bad.body?.error ?? ''),
      { status: bad.status, error: bad.body?.error });

    // ---- Fixture B: the REPORTING USER'S state — an OLDER project with NO -----
    // ---- stored `tools` key at all. Driven through the REAL client. ----------
    stripToolsKey(id);
    const bStored = await j('GET', `/api/projects/${id}`);
    check('(B0) realistic older-project fixture really has NO stored tools key',
      bStored.body.project.settings.tools === undefined, bStored.body.project.settings.tools);

    // (C1) OLD drawer behaviour: send the one-key partial the drawer used to send
    // when settings().tools was absent → `{...(undefined ?? {}), playwright:true}`.
    // Through the REAL api.patchProject this USED to throw the user's exact error
    // even though the server DID persist the value (that was the reproduced bug).
    //
    // UPDATED for BUG-089 (2026-08-13): api.js `echoed()` is now SUBSET-aware
    // (`covers()`), so the partial send is correctly read as persisted and NO
    // LONGER throws — the fault this case reproduced is fixed at the client layer.
    // The historical repro is preserved in scripts/verify-bug-089-echo-subset.mjs
    // (case A1, which MUST-FAILs when the subset-aware check is reverted). Here we
    // now assert the CURED behaviour so this suite stays honest post-089.
    let c1threw = null, c1ret = null;
    try {
      c1ret = await api.patchProject(id, { tools: { playwright: true } });
    } catch (err) { c1threw = err.message; }
    check('(C1) post-BUG-089: partial {tools:{playwright:true}} send is no longer misreported — real client echo-check is subset-aware',
      c1threw === null && c1ret?.settings?.tools?.playwright === true, c1threw ?? c1ret?.settings?.tools);
    // ...and prove the server persisted it (unchanged — was always true):
    const c1get = await j('GET', `/api/projects/${id}`);
    check('(C1b) the server DID persist the partial patch (server-side was always correct; the fault was the client echo-check)',
      c1get.body.project.settings.tools.playwright === true, c1get.body.project.settings.tools);

    // Reset the fixture back to the no-tools state for the cure test.
    stripToolsKey(id);

    // (C2) NEW drawer behaviour: send the RESOLVED FULL object (defaults filled:
    // serena default true, playwright true). Through the real client this saves
    // cleanly and reports success — the cure.
    let c2ok = null, c2err = null;
    try {
      c2ok = await api.patchProject(id, { tools: { serena: true, playwright: true } });
    } catch (err) { c2err = err.message; }
    check('(C2) CURE: full resolved tool object saves without a false "did not persist" (real client)',
      c2err === null && c2ok?.settings?.tools?.playwright === true && c2ok?.settings?.tools?.serena === true,
      c2err ?? c2ok?.settings?.tools);

    // ---- Wiring: gate the cure on the ACTUAL drawer edits (MUST FAIL pre-fix) -
    const drawer = fs.readFileSync(path.join(ROOT, 'public', 'lib', 'drawer.js'), 'utf8');
    check('(W1) drawer.putTools sends the resolved FULL tool object (effectiveTools), not a bare partial',
      /effectiveTools\(\)/.test(drawer) && /\{\s*\.\.\.effectiveTools\(\),\s*\.\.\.patch\s*\}/.test(drawer),
      'effectiveTools merge present in putTools');
    check('(W2) integrationsGroup explains WHY its toggles are greyed in session scope (readOnly note)',
      /if\s*\(readOnly\)\s*grp\.append\(note\(/.test(drawer),
      'readOnly project-scope note present in integrationsGroup');

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
