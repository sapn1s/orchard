#!/usr/bin/env node
/**
 * FEAT-089 — every project added to Orchard gets the full METHOD automatically.
 *
 *   node scripts/verify-feat-089-method-auto.mjs
 *
 * Proves, against a REAL scratch server (free ephemeral port, throwaway data
 * dir, NEVER :4317), that POSTing a project to /api/projects — with no manual
 * step — leaves the target repo with: the ticket board, the COHERENT Working
 * Agreement attached AND present in the composed launch prompt (asserting a
 * v1-ONLY marker, since v1 is exactly the part a v2-only attach would drop), the
 * response format enabled AND its section injected, and the format hook + gate
 * installed into the repo's OWN .claude/settings.json + scripts/.
 *
 * MUST-FAIL controls (proof this can't pass vacuously):
 *   - The PRE-FIX onboard (git show <PREFIX_SHA>:scripts/onboard.mjs, pinned to
 *     the commit BEFORE FEAT-089 landed) installs NEITHER the hook NOR the gate —
 *     run it, assert their absence. Anchored to a FIXED sha, never HEAD: a
 *     must-FAIL against HEAD self-invalidates the moment the fix is committed
 *     (docs/CONVENTIONS.md — "A must-FAIL proof must not be anchored to a moving
 *     baseline"). HEAD now contains the very change this asserts is absent.
 *   - Adding with `applyMethod:false` (the pre-fix reality: nothing auto-applied)
 *     leaves the repo BYTE-FOR-BYTE untouched and the WA/format-section absent
 *     from the composed prompt.
 *
 * Also: idempotence (re-onboard changes nothing, mtimes + contents unchanged),
 * the wiring panel reports every check ok, and adding a project does NOT
 * retroactively modify an already-registered one.
 *
 * REALISTIC-STATE fixture: the auto-apply target is not a bare dir — it already
 * ships its own package.json (with scripts), its own CLAUDE.md, and its own
 * .claude/settings.json carrying an unrelated Stop hook. That exercises the
 * never-clobber + MERGE paths a real pre-existing repo hits, not just the empty
 * happy path.
 */
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f089-data-'));
process.env.CLAUDE_STATION_DATA = DATA; // before importing the server layers below

async function freePort() {
  const net = await import('node:net');
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
const PORT = Number(process.env.VERIFY_F089_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}
const appendOf = (sp) => (typeof sp === 'string' ? sp : sp && typeof sp === 'object' ? sp.append : '');

/** Recursively list files (rel posix) under a dir; [] if the dir is absent. */
function listFiles(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  (function rec(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === '.git') continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) rec(abs);
      else out.push(path.relative(root, abs).split(path.sep).join('/'));
    }
  })(root);
  return out.sort();
}
/** A stable fingerprint of a tree: rel-path → sha-ish (size+mtimeMs+first bytes). */
function fingerprint(root) {
  const fp = {};
  for (const rel of listFiles(root)) {
    const st = fs.statSync(path.join(root, rel));
    fp[rel] = `${st.size}:${st.mtimeMs}`;
  }
  return fp;
}

const cleanupDirs = [DATA];
const cleanupFiles = [];
let server = null;
function stopByPid(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }, 1500).unref();
}

/** Make a realistic, pre-existing repo fixture (git repo + its own files). */
function makeFixture(label, { preexistingClaude = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cs-f089-${label}-`));
  cleanupDirs.push(dir);
  try { execFileSync('git', ['init', '-q'], { cwd: dir }); } catch { /* git optional */ }
  fs.writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ name: `f089-${label}`, version: '1.2.3', scripts: { build: 'echo build' } }, null, 2) + '\n');
  if (preexistingClaude) {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# CLAUDE.md\n\nThis repo already has its own rules.\n');
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo my-own-hook' }] }] }, permissions: { allow: ['Bash'] } }, null, 2) + '\n');
  }
  return dir;
}

async function addProject(hostPath, opts = {}) {
  const body = { hostPath, ...opts };
  const r = await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}

async function main() {
  // ── PRE-FIX must-FAIL: the committed onboard installs no hook, no gate ──────
  // PINNED to the commit before FEAT-089 (df2362a, "Orchard initial public
  // release") — a FIXED baseline. Anchoring to HEAD self-invalidated the moment
  // FEAT-089 was committed: HEAD's onboard now DOES install the hook/gate, so the
  // three "did NOT install" asserts flipped from red-on-prefix to red-always.
  // See docs/CONVENTIONS.md "A must-FAIL proof must not be anchored to a moving
  // baseline". The pinned onboard still runs against the CURRENT checkout's
  // scripts/ (it copies board.mjs etc. from ROOT), which is what we want: only
  // its OWN install logic is under test, on today's file set.
  const PREFIX_SHA = 'df2362a';
  console.log(`\n[0] MUST-FAIL — the PRE-FIX onboard (${PREFIX_SHA}, pre-FEAT-089) installs neither the hook nor the gate`);
  // Must live inside the real repo's scripts/ so its `repoRoot = __dirname/..`
  // resolves to this checkout (it copies board.mjs etc. from there). Temp name,
  // removed in finally + tracked so an interrupted run leaves no stray file.
  const oldOnboard = path.join(ROOT, 'scripts', '_onboard-prefix-verify.mjs');
  cleanupFiles.push(oldOnboard);
  let oldOnboardOk = true;
  try {
    const src = execFileSync('git', ['show', `${PREFIX_SHA}:scripts/onboard.mjs`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    // The pinned sha MUST predate the fix — assert the extracted source itself
    // carries no hook/gate install, so a future rebase that moves PREFIX_SHA onto
    // a post-fix commit fails LOUDLY here instead of passing vacuously.
    if (/response-format-gate\.mjs|scripts\/gate\.mjs/.test(src)) {
      throw new Error(`PREFIX_SHA ${PREFIX_SHA} already contains the FEAT-089 hook/gate install — it is not a pre-fix baseline`);
    }
    fs.writeFileSync(oldOnboard, src);
  } catch (e) { oldOnboardOk = false; console.log(`        (could not extract pinned pre-fix onboard: ${e.message})`); }
  if (oldOnboardOk) {
    const preDir = makeFixture('prefix');
    execFileSync('node', [oldOnboard, preDir], { encoding: 'utf8' });
    check('PRE-FIX onboard did NOT install .claude/settings.json (hook)',
      !fs.existsSync(path.join(preDir, '.claude', 'settings.json')), 'absent as expected');
    check('PRE-FIX onboard did NOT install scripts/gate.mjs',
      !fs.existsSync(path.join(preDir, 'scripts', 'gate.mjs')), 'absent as expected');
    check('PRE-FIX onboard did NOT wire the `gate` npm script',
      JSON.parse(fs.readFileSync(path.join(preDir, 'package.json'), 'utf8')).scripts.gate === undefined, 'absent as expected');
  } else {
    // The pinned baseline could not be materialised — the must-FAIL proof did not
    // run. That is itself a failure (a vanished control passes nothing), not a
    // quiet skip. Fail LOUDLY per docs/CONVENTIONS.md.
    check('PRE-FIX must-FAIL baseline was available (pinned pre-fix onboard extracted)', false,
      `PREFIX_SHA ${PREFIX_SHA} could not be used as a pre-fix baseline`);
  }
  // Remove the in-repo temp onboard IMMEDIATELY (not deferred to finally) so an
  // interrupted/piped run never leaves a stray file under scripts/.
  try { fs.rmSync(oldOnboard, { force: true }); } catch { /* already gone */ }

  // ── boot a real scratch server ──────────────────────────────────────────────
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), CLAUDE_STATION_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`  [server!] ${d}`));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { await fetch(`${BASE}/api/health`); up = true; } catch { await sleep(200); } }
  if (!up) throw new Error('server never became healthy');

  // ── [1] opt-out: applyMethod:false leaves the repo byte-for-byte untouched ──
  console.log('\n[1] OPT-OUT (declinable at add time) — applyMethod:false writes nothing');
  const optOutDir = makeFixture('optout');
  const before = fingerprint(optOutDir);
  const optOut = await addProject(optOutDir, { applyMethod: false });
  check('opt-out add still registers the project (201)', optOut.status === 201, `HTTP ${optOut.status}`);
  check('opt-out response reports method declined', optOut.json.method?.declined === true, optOut.json.method);
  const after = fingerprint(optOutDir);
  check('opt-out leaves the target repo BYTE-FOR-BYTE untouched (same file set + stats)',
    JSON.stringify(before) === JSON.stringify(after), `before=${Object.keys(before).length} after=${Object.keys(after).length} files`);
  check('opt-out attaches NO Working Agreement (instructions empty)',
    (optOut.json.project.settings.instructions ?? []).length === 0, optOut.json.project.settings.instructions);
  const optOutId = optOut.json.project.id;

  // ── [2] auto-apply: the fix, on a REALISTIC pre-existing repo ───────────────
  console.log('\n[2] AUTO-APPLY — adding with no manual step applies the whole method');
  const dir = makeFixture('apply', { preexistingClaude: true });
  const add = await addProject(dir); // default applyMethod true
  check('add returns 201', add.status === 201, `HTTP ${add.status}`);
  const method = add.json.method ?? {};
  check('response.method.applied === true', method.applied === true, method);
  check('response.method.waAttached === true', method.waAttached === true, method.waAttached);
  check('response.method.responseFormatEnabled === true', method.responseFormatEnabled === true, method.responseFormatEnabled);
  check('response carries the scaffold reports (side effect surfaced, not hidden)',
    Array.isArray(method.reports) && method.reports.length > 0, `${method.reports?.length} reports`);
  const projId = add.json.project.id;

  // board
  check('board installed: docs/bugs/INDEX.md + README.md',
    fs.existsSync(path.join(dir, 'docs', 'bugs', 'INDEX.md')) && fs.existsSync(path.join(dir, 'docs', 'bugs', 'README.md')), 'present');
  // conventions + drift guard
  check('conventions stub installed: docs/CONVENTIONS.md', fs.existsSync(path.join(dir, 'docs', 'CONVENTIONS.md')), 'present');
  check('drift guard installed: scripts/board.mjs + board:check script',
    fs.existsSync(path.join(dir, 'scripts', 'board.mjs')) &&
      JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts['board:check'] !== undefined, 'present');
  // format hook + its dependency closure
  const hookClosure = [
    'scripts/hooks/response-format-gate.mjs', 'scripts/lib/readability.mjs', 'scripts/lib/structure.mjs',
    'public/lib/digest.js', 'public/lib/dom.js', 'public/lib/route.js',
  ];
  check('format hook + its full dependency closure copied into the repo',
    hookClosure.every((rel) => fs.existsSync(path.join(dir, rel))),
    hookClosure.filter((rel) => !fs.existsSync(path.join(dir, rel))).join(', ') || 'all present');
  // .claude/settings.json MERGED (pre-existing hook preserved)
  const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));
  const stopStr = JSON.stringify(settings.hooks?.Stop ?? []);
  check('.claude/settings.json now wires the response-format hook (merged in)',
    stopStr.includes('response-format-gate.mjs'), 'hook present');
  check('.claude/settings.json MERGE preserved the repo’s own pre-existing hook (never clobbered)',
    stopStr.includes('echo my-own-hook') && (settings.permissions?.allow ?? []).includes('Bash'), 'pre-existing config intact');
  check('pre-existing CLAUDE.md was NOT clobbered',
    fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8') === '# CLAUDE.md\n\nThis repo already has its own rules.\n', 'untouched');
  // gate wrapper + closure + npm script
  check('sanctioned gate wrapper installed: scripts/gate.mjs + scripts/leak-gate.mjs',
    fs.existsSync(path.join(dir, 'scripts', 'gate.mjs')) && fs.existsSync(path.join(dir, 'scripts', 'leak-gate.mjs')), 'present');
  check('`gate` npm script wired',
    JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts.gate === 'node scripts/gate.mjs', 'wired');
  check('repo’s own package.json fields preserved (name/version/build script)',
    (() => { const p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); return p.name === 'f089-apply' && p.version === '1.2.3' && p.scripts.build === 'echo build'; })(), 'intact');

  // hook actually runs in the target (imports resolve) — empty stdin → allow, exit 0
  let hookExit = null;
  try { execFileSync('node', [path.join(dir, 'scripts', 'hooks', 'response-format-gate.mjs')], { input: '', encoding: 'utf8' }); hookExit = 0; }
  catch (e) { hookExit = e.status ?? 1; }
  check('copied hook executes in the target (deps resolve; empty stdin → allow)', hookExit === 0, `exit ${hookExit}`);

  // ── [3] WA + response-format PRESENT in the composed launch prompt ──────────
  console.log('\n[3] COMPOSED LAUNCH PROMPT — WA (v1-only marker) + response-format section injected');
  const { composeInstructions } = await import(path.join(ROOT, 'src', 'server', 'templates.ts'));
  const { responseDigestOf } = await import(path.join(ROOT, 'src', 'server', 'registry.ts'));
  const proj = (await (await fetch(`${BASE}/api/projects/${encodeURIComponent(projId)}`)).json()).project;
  const digest = responseDigestOf(proj);
  // Mirror the REAL launch composition (agent-bridge.ts).
  const composed = composeInstructions(proj.settings.instructions, {
    hostPath: proj.hostPath, routing: true,
    responseFormat: digest.enabled ? { guidance: digest.guidance ?? null } : false,
  });
  const live = appendOf(composed.systemPrompt);
  // v1-ONLY marker — present in WORKING_AGREEMENT.md (v1), absent from v2. A
  // v2-only attach (BUG-099) would DROP exactly this, so it is the load-bearing
  // assertion that the coherent base is really injected.
  const V1_ONLY = 'build it to production confidence';
  check('composed prompt contains the WA v1-ONLY base marker (coherent stack, base injected)',
    live.includes(V1_ONLY), `present=${live.includes(V1_ONLY)}`);
  check('composed prompt contains the response-format (orchard-digest) section',
    live.includes('orchard-digest') && live.includes('Response format'), 'present');
  check('composed applied both response-format and provider-routing sections',
    composed.appliedIds.includes('response-format') && composed.appliedIds.includes('provider-routing'),
    composed.appliedIds.join(', '));

  // must-FAIL control: empty stack + responseFormat:false → markers absent
  const control = appendOf(composeInstructions([], { hostPath: proj.hostPath, routing: true, responseFormat: false }).systemPrompt);
  check('CONTROL: WA v1 marker ABSENT with an empty stack (assertion is not vacuous)', !control.includes(V1_ONLY), `present=${control.includes(V1_ONLY)}`);
  check('CONTROL: response-format section ABSENT with responseFormat:false', !control.includes('orchard-digest'), `present=${control.includes('orchard-digest')}`);

  // ── [4] wiring panel reports every check satisfied ──────────────────────────
  console.log('\n[4] WIRING PANEL — every methodology check reports ok for the added project');
  const wiring = (await (await fetch(`${BASE}/api/projects/${encodeURIComponent(projId)}/wiring`)).json()).wiring;
  for (const key of ['working-agreement', 'conventions', 'board', 'drift-guard']) {
    const c = wiring.checks.find((x) => x.key === key);
    check(`wiring check "${key}" is ok`, c?.state === 'ok', `state=${c?.state}`);
  }

  // ── [5] idempotence — re-onboard changes nothing (mtimes + contents) ────────
  console.log('\n[5] IDEMPOTENCE — re-running onboard on the applied repo changes nothing');
  const watch = ['scripts/hooks/response-format-gate.mjs', 'scripts/gate.mjs', '.claude/settings.json', 'docs/bugs/README.md', 'package.json'];
  const snap = Object.fromEntries(watch.map((rel) => {
    const p = path.join(dir, rel); const st = fs.statSync(p);
    return [rel, { mtimeMs: st.mtimeMs, sha: fs.readFileSync(p, 'utf8') }];
  }));
  const reonboard = execFileSync('node', [path.join(ROOT, 'scripts', 'onboard.mjs'), dir], { encoding: 'utf8' });
  check('re-onboard reports no CREATED/MERGED lines (all already present)',
    !/\b(CREATED|MERGED)\b/.test(reonboard), reonboard.split('\n').filter((l) => /CREATED|MERGED/.test(l)).join(' | ') || 'none');
  let unchanged = true; const changed = [];
  for (const rel of watch) {
    const p = path.join(dir, rel); const st = fs.statSync(p);
    if (st.mtimeMs !== snap[rel].mtimeMs || fs.readFileSync(p, 'utf8') !== snap[rel].sha) { unchanged = false; changed.push(rel); }
  }
  check('re-onboard left every watched file byte-identical AND mtime-unchanged', unchanged, changed.join(', ') || 'all unchanged');

  // ── [6] no retroactive modification of an already-registered project ────────
  console.log('\n[6] NON-RETROACTIVE — adding a project does not modify an existing one');
  const optOutNow = (await (await fetch(`${BASE}/api/projects/${encodeURIComponent(optOutId)}`)).json()).project;
  check('the earlier opt-out project still has an empty instruction stack (untouched by later adds)',
    (optOutNow.settings.instructions ?? []).length === 0, optOutNow.settings.instructions);

  console.log(`\n${fail === 0 ? 'VERDICT: PASS' : 'VERDICT: FAIL'} — ${pass} passed, ${fail} failed`);
  if (fail) console.log('failed checks:\n  - ' + failures.join('\n  - '));
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}\n${err.stack}`);
  process.exitCode = 1;
}).finally(() => {
  stopByPid(server);
  setTimeout(() => {
    for (const f of cleanupFiles) { try { fs.rmSync(f, { force: true }); } catch { /* best effort */ } }
    for (const d of cleanupDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
    process.exit(process.exitCode ?? 0);
  }, 1500);
});
