#!/usr/bin/env node
/**
 * BUG-231 — one Bash git write is decided ONCE, not once by the PreToolUse hook and
 * again by the git shim.
 *
 *   node scripts/verify-bug-231-one-decision.mjs [--root=<tree>] [--only=e2e|unit]
 *
 * E2E (the user's reality): a REAL scratch server (isolatedServerEnv, throwaway repo
 * only) launches a direct session whose fake CLI (scripts/fixtures/bug-231/fake-cli.mjs)
 * behaves like the real CLI's Bash tool: the runtime's REAL PreToolUse hook, then
 * `bash -c <command>` with the session's env (its git shim first on PATH, so every
 * bare `git` goes through /api/git-shim/decide), then PostToolUse / PostToolUseFailure.
 * Real leak-gate runs are counted by a NODE_OPTIONS preload
 * (scripts/fixtures/bug-231/gate-trace.mjs).
 *
 * `--root=<tree>` boots the server from another tree: the pinned pre-change snapshot
 * (must-FAIL) or a mutated copy (orphan must-FAIL). Default: this checkout.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtempScratch } from './lib/scratch.mjs';
import { isolatedServerEnv, isolatedStoreEnv } from './lib/station-boot.mjs';

const HERE = path.resolve(import.meta.dirname, '..');
const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null;
const ROOT = path.resolve(arg('root') ?? HERE);
const ONLY = arg('only');
const FIX = path.join(HERE, 'scripts', 'fixtures', 'bug-231');
const FAKE_CLI = path.join(FIX, 'fake-cli.mjs');
const GATE_TRACE_MODULE = path.join(FIX, 'gate-trace.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── never touch the invoking session's shim; never inherit a grant hatch ────── */
const INVOKER_SHIM = process.env.ORCHARD_GIT_SHIM_DIR;
process.env.PATH = String(process.env.PATH ?? '').split(path.delimiter)
  .filter((p) => p && p !== INVOKER_SHIM && !path.basename(p).startsWith('orchard-git-shim-'))
  .join(path.delimiter);
delete process.env.ORCHARD_GIT_SHIM_DIR;
delete process.env.ORCHARD_ALLOW_GIT_WRITE;
const REAL_GIT = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

const RUN = mkdtempScratch('bug231-');
const spawned = [];
const readJsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
async function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
}
/** Real git on a SCRATCH repo only, with the invoker's shim stripped. */
function scratchGit(dir, ...a) {
  const env = { ...process.env };
  delete env.GIT_INDEX_FILE; // unset, not '': an empty value makes git use a stray index file
  return spawnSync(REAL_GIT, a, { cwd: dir, encoding: 'utf8', env });
}
function throwawayRepo(tag) {
  const dir = fs.mkdtempSync(path.join(RUN, `repo-${tag}-`));
  scratchGit(dir, 'init', '-q'); scratchGit(dir, 'config', 'user.email', 'b231@example.com'); scratchGit(dir, 'config', 'user.name', 'b231');
  fs.writeFileSync(path.join(dir, 'README.md'), 'bug-231 throwaway\n');
  scratchGit(dir, 'add', 'README.md'); scratchGit(dir, 'commit', '-q', '-m', 'base');
  return { dir, head: () => scratchGit(dir, 'rev-parse', 'HEAD').stdout.trim(), count: () => Number(scratchGit(dir, 'rev-list', '--count', 'HEAD').stdout.trim()) };
}

/* ═══════════════════════════════ E2E ═══════════════════════════════════════ */
async function e2e() {
  console.log(`\n===== E2E — a REAL scratch server (tree: ${ROOT === HERE ? 'this checkout' : ROOT}) and a direct session =====`);
  const repo = throwawayRepo('e2e');
  const out = path.join(RUN, 'fake-start.jsonl');
  const results = path.join(RUN, 'fake-results.jsonl');
  const trace = path.join(RUN, 'gate-trace.jsonl');
  const PORT = await freePort();
  const DATA = fs.mkdtempSync(path.join(RUN, 'data-'));
  const STORE = fs.mkdtempSync(path.join(RUN, 'store-'));
  const env = isolatedServerEnv({
    PORT: String(PORT), CLAUDE_STATION_DATA: DATA, ...isolatedStoreEnv(STORE, { alsoReader: true }),
    CLAUDE_STATION_CLAUDE_BIN: FAKE_CLI, CLAUDE_STATION_MCP_READY_TIMEOUT_MS: '0',
    CLAUDE_STATION_SURVIVE: '0', // the CLI stays the server's child, so killing the server by pid reaps it
    FAKE_OUT: out, FAKE_RESULTS: results, FAKE_REPO: repo.dir,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(GATE_TRACE_MODULE).href}`.trim(),
    B231_GATE_TRACE: trace,
  });
  const srv = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.ts')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  spawned.push(srv);
  let log = ''; srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  const BASE = `http://127.0.0.1:${PORT}`;
  let ws = null;
  try {
    let up = false;
    for (let i = 0; i < 200 && !up; i++) { try { up = (await fetch(`${BASE}/api/projects`)).ok; } catch { /* booting */ } if (!up) await sleep(150); }
    if (!up) { check('E2E: scratch server booted', false, log.slice(-800)); return; }
    const reg = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hostPath: repo.dir, name: 'b231-throwaway', isolation: 'direct', applyMethod: false }) })).json();
    const projectId = reg.project?.id;
    if (!projectId) { check('E2E: throwaway project registered', false, reg); return; }
    const grantUrl = `${BASE}/api/projects/${encodeURIComponent(projectId)}/git-write-grant`;
    const grant = async (scope, minutes) => (await fetch(grantUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope, ...(minutes ? { minutes } : {}) }) })).json();
    const revoke = async () => (await fetch(grantUrl, { method: 'DELETE' })).json();
    const grantState = async () => (await (await fetch(grantUrl)).json());
    ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const events = [];
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (e) => { try { events.push(JSON.parse(String(e.data))); } catch { /* ignore */ } };
    for (let t = 0; t < 40 && readJsonl(out).length === 0; t++) {
      const seen = events.length;
      ws.send(JSON.stringify({ type: 'start', projectId, overrides: { model: 'haiku', permissionMode: 'bypassPermissions' }, prompt: 'hi' }));
      let pending = false;
      for (let i = 0; i < 30; i++) {
        await sleep(100);
        if (events.slice(seen).some((e) => e.code === 'runtime-check-pending')) { pending = true; break; }
        if (readJsonl(out).length) break;
      }
      if (!pending) break;
      await sleep(1500);
    }
    for (let i = 0; i < 100 && readJsonl(out).length === 0; i++) await sleep(100);
    const started = readJsonl(out)[0];
    check('E2E non-vacuity: the session got its own git shim, first on PATH', !!started?.shimDir && started.pathHead === started.shimDir, started ?? { events: events.slice(-4), log: log.slice(-600) });
    if (!started?.shimDir) return;
    for (let i = 0; i < 50 && !events.some((e) => e.t === 'result' || e.type === 'result' || /result/.test(String(e.t ?? ''))); i++) await sleep(100);

    async function bash(spec) {
      const before = readJsonl(results).length;
      ws.send(JSON.stringify({ type: 'send', prompt: `[[bash]]${JSON.stringify(spec)}` }));
      for (let i = 0; i < 600 && readJsonl(results).length <= before; i++) await sleep(100);
      await sleep(400); // let the turn end and any post-turn settlement land
      return readJsonl(results)[before] ?? { error: 'no result (timeout)' };
    }
    const gateRuns = () => readJsonl(trace).filter((t) => !t.args.includes('--staged')).length;
    const ledgerSince = async (n0) => { const all = (await grantState()).recentWrites ?? []; return all.slice(0, Math.max(0, all.length - n0)).reverse(); };
    const ledgerLen = async () => ((await grantState()).recentWrites ?? []).length;
    const decisionIds = (recs) => new Set(recs.map((r) => r.decision ?? null));

    /* S1 — once-grant, the FIRST git write of the session: add && commit ─────── */
    console.log('\n  -- S1: once-grant, `git add && git commit` in one Bash call');
    await grant('once');
    let n0 = await ledgerLen(), g0 = gateRuns(), c0 = repo.count();
    const s1 = await bash({ tag: 's1', command: 'printf one > one.txt && git add one.txt && git commit -q -m s1' });
    let recs = await ledgerSince(n0);
    check('S1: a once-grant lets the one Bash git write through (exit 0, exactly one new commit)', s1.ran && s1.exit === 0 && repo.count() === c0 + 1, { pre: s1.pre, exit: s1.exit, stderr: s1.stderr?.slice(0, 300), commits: repo.count() - c0 });
    check('S1: the once-grant is spent afterwards', (await grantState()).grant === null, (await grantState()).grant);
    check('S1: no record is left pending/unconfirmed (no phantom hook record)', recs.length > 0 && recs.every((r) => r.outcome !== 'permitted'), recs.map((r) => [r.offender, r.outcome]));
    check('S1: every record of this Bash call names ONE decision', recs.length > 0 && decisionIds(recs).size === 1 && !decisionIds(recs).has(null), recs.map((r) => [r.offender, r.decision ?? null]));
    console.log(`        (info) S1 gate runs: ${gateRuns() - g0}`);

    /* S2 — duration grant: the leak gate runs once for the one commit ─────────── */
    console.log('\n  -- S2: duration grant, `git add && git commit` in one Bash call');
    await grant('duration', 10);
    n0 = await ledgerLen(); g0 = gateRuns(); c0 = repo.count();
    // The usual shape: the agent wrote the file with its Write/Edit tool, then commits it.
    // (Content the command itself creates is re-gated at the write — S4.)
    fs.writeFileSync(path.join(repo.dir, 'two.txt'), 'two\n');
    const s2 = await bash({ tag: 's2', command: 'git add two.txt && git commit -q -m s2' });
    recs = await ledgerSince(n0);
    check('S2: the write lands (exit 0, one commit)', s2.exit === 0 && repo.count() === c0 + 1, { exit: s2.exit, stderr: s2.stderr?.slice(0, 300) });
    check('S2: the leak gate ran EXACTLY once for the one commit', gateRuns() - g0 === 1, { gateRuns: gateRuns() - g0 });
    check('S2: no record is left pending/unconfirmed', recs.length > 0 && recs.every((r) => r.outcome !== 'permitted'), recs.map((r) => [r.offender, r.outcome]));
    check('S2: one decision for the Bash call; the commit record carries the gate pass', decisionIds(recs).size === 1 && !decisionIds(recs).has(null) && recs.some((r) => r.offender === 'git commit' && r.gatePassed === true && r.outcome === 'executed'), recs.map((r) => [r.offender, r.outcome, r.gatePassed, r.decision ?? null]));

    /* S3 — absolute-path git: the shim cannot see it, the hook still gates ────── */
    console.log('\n  -- S3: duration grant, absolute-path git (the shim never sees it)');
    g0 = gateRuns(); c0 = repo.count();
    const s3 = await bash({ tag: 's3', command: `printf three > three.txt && ${REAL_GIT} add three.txt && ${REAL_GIT} commit -q -m s3` });
    check('S3: the absolute-path commit lands', s3.exit === 0 && repo.count() === c0 + 1, { exit: s3.exit, stderr: s3.stderr?.slice(0, 300) });
    check('S3: the leak gate still ran for it (at least once)', gateRuns() - g0 >= 1, { gateRuns: gateRuns() - g0 });

    /* S4 — a leak created INSIDE the command is still caught at commit time ───── */
    console.log('\n  -- S4: duration grant, the command itself writes a leaking file, then commits it');
    c0 = repo.count();
    const leak = `${os.homedir()}/b231-leak-probe`; // a home path: the leak gate's identity token
    const s4 = await bash({ tag: 's4', command: `printf '%s\\n' '${leak}' > leak.txt && git add leak.txt && git commit -q -m s4` });
    check('S4: the leaking commit is REFUSED (gate at commit time), HEAD unchanged', s4.exit !== 0 && repo.count() === c0, { exit: s4.exit, stderr: s4.stderr?.slice(0, 300) });
    scratchGit(repo.dir, 'reset', '-q'); fs.rmSync(path.join(repo.dir, 'leak.txt'), { force: true });

    /* S5 — once-grant, the permission layer denies the call: nothing is spent ─── */
    console.log('\n  -- S5: once-grant; the first call is denied by the permission layer, the second must still pass');
    await revoke(); await grant('once');
    c0 = repo.count();
    const s5a = await bash({ tag: 's5a', command: 'git commit --allow-empty -q -m s5a', permissionDeny: true });
    const s5b = await bash({ tag: 's5b', command: 'git commit --allow-empty -q -m s5b' });
    check('S5: a call that never ran spends nothing — the next call uses the once-grant', !s5a.ran && s5b.exit === 0 && repo.count() === c0 + 1, { s5a: { pre: s5a.pre, ran: s5a.ran }, s5b: { pre: s5b.pre, exit: s5b.exit, stderr: s5b.stderr?.slice(0, 200) } });

    /* S6 — orphan: a used window never closed by its tool call grants nothing later */
    console.log('\n  -- S6: once-grant; a tool call that never reports its end (orphan) must not grant a later write');
    await revoke(); await grant('once');
    c0 = repo.count();
    const s6 = await bash({ tag: 's6', command: 'git commit --allow-empty -q -m s6', skipPost: true });
    const shimGit = path.join(started.shimDir, 'git');
    const later = spawnSync(shimGit, ['commit', '--allow-empty', '-q', '-m', 's6-later'], { cwd: repo.dir, encoding: 'utf8', env: { ...process.env, PATH: `${started.shimDir}${path.delimiter}${process.env.PATH}` } });
    check('S6 control: the orphaned call itself wrote once', s6.exit === 0 && repo.count() >= c0 + 1, { exit: s6.exit, stderr: s6.stderr?.slice(0, 200) });
    check('S6: a later git write from outside that call is REFUSED (the spent once-grant is not re-granted by the orphan)', later.status !== 0 && repo.count() === c0 + 1, { status: later.status, stderr: String(later.stderr).slice(0, 200), commits: repo.count() - c0 });

    /* S6b — orphan with an UNUSED write slot: the decision covered two commits, one ran */
    console.log('\n  -- S6b: once-grant; an orphaned call whose decision still had an unused commit slot must not grant a later write');
    await revoke(); await grant('once');
    c0 = repo.count();
    const s6b = await bash({ tag: 's6b', command: 'git commit --allow-empty -q -m s6b-1 || git commit --allow-empty -q -m s6b-2', skipPost: true });
    const later2 = spawnSync(shimGit, ['commit', '--allow-empty', '-q', '-m', 's6b-later'], { cwd: repo.dir, encoding: 'utf8', env: { ...process.env, PATH: `${started.shimDir}${path.delimiter}${process.env.PATH}` } });
    check('S6b control: the orphaned call wrote its first commit', s6b.exit === 0 && repo.count() >= c0 + 1, { exit: s6b.exit, stderr: s6b.stderr?.slice(0, 200) });
    check('S6b: a later git write from outside that call is REFUSED (the orphan\'s unused slot grants nothing after the call)', later2.status !== 0 && repo.count() === c0 + 1, { status: later2.status, stderr: String(later2.stderr).slice(0, 160), commits: repo.count() - c0 });

    /* S8 — a verb the command did not write out decides on its own ─────────────── */
    console.log('\n  -- S8: once-grant; `git add` written out, a `git commit` hidden in a node subprocess');
    await revoke(); await grant('once');
    c0 = repo.count();
    // A script FILE (the scratch project runs the orchestrator profile, which refuses `node -e`).
    const hiddenJs = path.join(RUN, 'hidden-commit.cjs');
    fs.writeFileSync(hiddenJs, "require('child_process').execFileSync('git', process.argv.slice(2), { stdio: 'inherit' });\n");
    const hidden = `node ${hiddenJs} commit -q -m s8`;
    const s8 = await bash({ tag: 's8', command: `printf eight > eight.txt && git add eight.txt && ${hidden}` });
    const staged8 = scratchGit(repo.dir, 'diff', '--cached', '--name-only').stdout.trim();
    check('S8: the once-grant covers only the writes written in the command — the hidden commit is refused, the add ran', s8.exit !== 0 && repo.count() === c0 && staged8 === 'eight.txt', { exit: s8.exit, staged: staged8, commits: repo.count() - c0, stderr: s8.stderr?.slice(0, 160) });
    scratchGit(repo.dir, 'reset', '-q'); fs.rmSync(path.join(repo.dir, 'eight.txt'), { force: true });

    /* S9 — a subprocess git with no git text still decides independently (BUG-173) */
    console.log('\n  -- S9: duration grant; a git commit hidden in a node subprocess, no git text at all');
    await revoke(); await grant('duration', 10);
    n0 = await ledgerLen(); g0 = gateRuns(); c0 = repo.count();
    const s9 = await bash({ tag: 's9', command: `node ${hiddenJs} commit --allow-empty -q -m s9` });
    recs = await ledgerSince(n0);
    check('S9: the hidden commit is permitted by its own decision, gated once, and confirmed', s9.exit === 0 && repo.count() === c0 + 1 && gateRuns() - g0 === 1 && recs.length === 1 && recs[0].outcome === 'executed' && !!recs[0].decision, { exit: s9.exit, gateRuns: gateRuns() - g0, recs: recs.map((r) => [r.offender, r.outcome, r.decision ?? null]) });

    /* S10 — a LATER stage of the same hook denies the call: the git decision is released */
    console.log('\n  -- S10: once-grant; the git block reserves, then the orchestrator profile (a later hook stage) denies the call');
    await revoke(); await grant('once');
    const s10 = await bash({ tag: 's10', command: 'git add ten.txt && node -e 1' });
    const st10 = (await grantState()).grant;
    check('S10: a call denied by a later stage of the hook spends nothing (once-grant still claimable)', s10.pre?.verdict === 'deny' && !s10.ran && !!st10 && st10.remainingUses === 1 && !st10.reserved, { pre: s10.pre?.verdict, why: String(s10.pre?.text ?? '').slice(0, 60), grant: st10 });

    /* S7 — orphan with an UNUSED reservation: released, not pinned ─────────────── */
    console.log('\n  -- S7: once-grant; an orphaned call that never reached git leaves the grant claimable');
    await revoke(); await grant('once');
    await bash({ tag: 's7', command: 'false && git commit --allow-empty -q -m s7', skipPost: true });
    const st7 = (await grantState()).grant;
    check('S7: after the orphan, the once-grant is claimable again (nothing reserved, one use left)', !!st7 && st7.remainingUses === 1 && !st7.reserved, st7);
    await revoke();

    /* S11 — FEAT-164 r4: the user REVOKES (real DELETE route) in the middle of one Bash
     * call, then issues a fresh once-grant. The call's next commit must be refused — the
     * store, not the call's window, is the authority — and the fresh grant left unspent
     * (no second decision for the same call). Broken on the pre-r4 tree (run
     * 01a10ca5-0fb3-7032-a8c0-5374865424e8: the open window authorised the next commit). */
    console.log('\n  -- S11 (FEAT-164 r4): duration grant; revoke + re-grant once mid-call; the call\'s next commit must be refused');
    await grant('duration', 10);
    c0 = repo.count();
    const waitJs = path.join(RUN, 'wait-for.cjs');
    fs.writeFileSync(waitJs, "const fs=require('fs');const f=process.argv[2];const t=Date.now();(function w(){if(fs.existsSync(f))process.exit(0);if(Date.now()-t>30000)process.exit(3);setTimeout(w,50);})();\n");
    const go = path.join(RUN, 's11-go');
    const s11p = bash({ tag: 's11', command: `git commit --allow-empty -q -m s11a && node ${waitJs} ${go} && git commit --allow-empty -q -m s11b` });
    for (let i = 0; i < 300 && repo.count() < c0 + 1; i++) await sleep(50);
    const midCommits = repo.count() - c0;
    await revoke(); await grant('once');
    fs.writeFileSync(go, '');
    const s11 = await s11p;
    const st11 = (await grantState()).grant;
    check('S11: the first commit landed before the revoke (non-vacuity)', midCommits === 1, { midCommits });
    check('S11: after the mid-call revoke the SAME call\'s next commit is REFUSED', s11.exit !== 0 && repo.count() === c0 + 1, { exit: s11.exit, commits: repo.count() - c0, stderr: s11.stderr?.slice(0, 200) });
    check('S11: the once-grant issued mid-call is left unspent (the call is not decided a second time)', !!st11 && st11.scope === 'once' && st11.remainingUses === 1 && !st11.reserved, st11);
    await revoke();
  } finally {
    try { ws?.close(); } catch { /* ignore */ }
    try { process.kill(srv.pid, 'SIGTERM'); } catch { /* gone */ }
    for (let i = 0; i < 40 && srv.exitCode === null && srv.signalCode === null; i++) await sleep(150);
    try { process.kill(srv.pid, 'SIGKILL'); } catch { /* gone */ }
    if (process.env.B231_KEEP_LOG) fs.writeFileSync(path.join(RUN, 'server.log'), log);
  }
}

/* ═══════════════════════════════ UNIT ══════════════════════════════════════
 * The decision layer in-process, loaded fresh per variant from a scratch copy:
 *   pre — scripts/fixtures/bug-231/pre-git-grant{,-store}.mjs: the REAL pre-change
 *         bytes (sha256 10ed56e1… / 370adddf…), the must-FAIL baseline;
 *   cur — this checkout's scripts/lib/git-grant{,-store}.mjs;
 *   mutants of cur (lapse reap removed; slots never consumed) for the orphan and
 *   bounded-redeem properties, which the pre-change code has no window to break.
 * The hook is `evaluateGitWrite({ command, window })`; the shim is the decide route's
 * call — `redeemGitWrite` where it exists, else the pre-change `evaluateGitWrite({ argv })`.
 */
const LIB = path.join(HERE, 'scripts', 'lib');
async function loadVariant(tag, grantSrc, storeSrc) {
  const dir = fs.mkdtempSync(path.join(RUN, `unit-${tag}-`));
  fs.writeFileSync(path.join(dir, 'git-grant.mjs'), grantSrc);
  fs.writeFileSync(path.join(dir, 'git-grant-store.mjs'), storeSrc);
  fs.copyFileSync(path.join(LIB, 'git-write-policy.mjs'), path.join(dir, 'git-write-policy.mjs'));
  const grant = await import(pathToFileURL(path.join(dir, 'git-grant.mjs')).href);
  const store = await import(pathToFileURL(path.join(dir, 'git-grant-store.mjs')).href);
  return { tag, grant, store };
}
function mutate(src, from, to, label) {
  if (!src.includes(from)) throw new Error(`mutant ${label}: anchor not found — the mutant would be vacuous`);
  return src.replace(from, to);
}

const BINDING = 'b231-binding-0123456789abcdef';
const P = 'proj-b231';
/** A gate runner that counts its runs. */
function gateCounter(ok = true) { const g = { runs: 0, run: () => { g.runs++; return { ok, detail: ok ? 'pass' : 'leak' }; } }; return g; }
/** The decide route's call for one shim invocation, for whichever variant. */
/** The repo content the gate would scan (stub for the host's repoContentFingerprint).
 * BUG-231 r7 — the stub now carries a `gateKey` (the real repoContentFingerprint hashes the
 * gate script / token list / own-project names into it); the shim's skip needs it present and
 * unchanged on both sides. Keeping it constant here preserves the single-gate property (U2). */
const FP = { cur: { head: 'h0', entries: ['README.md:aaa'], gateKey: 'gk0' } };
const fpRead = () => FP.cur;
function shimDecide(v, argv, gate, { binding = BINDING, now } = {}) {
  return v.grant.redeemGitWrite
    ? v.grant.redeemGitWrite({ binding, argv, projectKey: P, env: {}, runLeakGate: gate.run, now, repoFingerprint: fpRead })
    : v.grant.evaluateGitWrite({ argv, projectKey: P, env: {}, runLeakGate: gate.run, now });
}
let callSeq = 0;
function hookDecide(v, command, gate, { shimReachesCli = true, agentKey = 'main', now } = {}) {
  const toolUseId = `tu-${++callSeq}`;
  v.grant.beginGitWriteToolCall?.({ binding: BINDING, toolUseId, agentKey, now });
  const r = v.grant.evaluateGitWrite({ command, projectKey: P, env: {}, runLeakGate: gate.run, now, repoFingerprint: fpRead, window: { binding: BINDING, toolUseId, agentKey, shimReachesCli } });
  return { ...r, toolUseId };
}
const endCall = (v, toolUseId, now) => v.grant.endGitWriteToolCall?.(BINDING, toolUseId, now);
const endAll = (v, now) => v.grant.endGitWriteToolCalls?.(BINDING, now);
function reset(v) { v.store._resetGitGrantsForTest(); v.grant._resetGitWriteWindowsForTest?.(); }
/** One Bash call `git add f && git commit -m x`, both invocations through the shim; then the call ends. */
function addCommitCall(v, gate) {
  const h = hookDecide(v, 'git add f && git commit -m x', gate);
  const a = h.allow ? shimDecide(v, ['add', 'f'], gate) : null;
  const c = h.allow && a?.allow ? shimDecide(v, ['commit', '-m', 'x'], gate) : null;
  for (const r of [a, c]) if (r?.record?.confirmToken) v.store.confirmGitWrite(r.record.id, { token: r.record.confirmToken, projectKey: P, exitStatus: 0 });
  endCall(v, h.toolUseId);
  return { h, a, c };
}

async function unit() {
  console.log('\n===== UNIT — the decision layer: pinned pre-change bytes vs this checkout vs mutants =====');
  const preGrant = fs.readFileSync(path.join(FIX, 'pre-git-grant.mjs'), 'utf8');
  const preStore = fs.readFileSync(path.join(FIX, 'pre-git-grant-store.mjs'), 'utf8');
  const curGrant = fs.readFileSync(path.join(LIB, 'git-grant.mjs'), 'utf8');
  const curStore = fs.readFileSync(path.join(LIB, 'git-grant-store.mjs'), 'utf8');
  const pre = await loadVariant('pre', preGrant, preStore);
  const cur = await loadVariant('cur', curGrant, curStore);
  // FEAT-164 r4: the store refuses a lapsed handle too (defence in depth), so the orphan
  // mutant removes BOTH the call-record lapse (BUG-231 r5: the store's sweep withdraws a
  // lapsed call) and the claim's lapse check.
  const noReap = await loadVariant('mut-noreap', curGrant,
    mutate(mutate(curStore, '  if (now - st.at >= CLAIM_MAX_MS) return false; // lapsed\n', '', 'nolapse'),
      "if (!st || st.state === 'ended' || now - st.at >= CLAIM_MAX_MS) withdraw(r);", "if (!st || st.state === 'ended') withdraw(r);", 'noreap'));
  const noSlots = await loadVariant('mut-noslots', mutate(curGrant, '  w.slots.splice(w.slots.indexOf(offender), 1);\n', '', 'noslots'), curStore);

  /* U1-U3: the three BUG-231 symptoms, as properties, on pre (must FAIL) and cur ── */
  const props = (v) => {
    const out = {};
    // once-grant, a session whose reach is already proven (an earlier duration write)
    reset(v);
    v.store.grantGitWrite(P, { scope: 'duration', ttlMs: 60_000 });
    addCommitCall(v, gateCounter());              // warm-up: proves add/commit reach the shim
    v.store.revokeGitWrite(P);
    v.store.grantGitWrite(P, { scope: 'once' });
    const g1 = gateCounter();
    const once = addCommitCall(v, g1);
    out.onceAllowed = !!(once.h.allow && once.a?.allow && once.c?.allow);
    out.onceSpent = v.store.grantView(P) === null;
    // duration: gate runs and pending records for one Bash call
    v.store.grantGitWrite(P, { scope: 'duration', ttlMs: 60_000 });
    const n0 = v.store.listGitWrites(P, 500).length;
    const g2 = gateCounter();
    const dur = addCommitCall(v, g2);
    const recs = v.store.listGitWrites(P, 500).slice(0, v.store.listGitWrites(P, 500).length - n0);
    out.durAllowed = !!(dur.h.allow && dur.a?.allow && dur.c?.allow);
    out.gateRuns = g2.runs;
    out.pending = recs.filter((r) => r.outcome === 'permitted').length;
    out.decisions = new Set(recs.map((r) => r.decision ?? null)).size;
    out.nullDecision = recs.some((r) => !r.decision);
    return out;
  };
  const p = props(pre), c = props(cur);
  check('U1 must-FAIL on the pre-change bytes: a once-grant does NOT carry one Bash `git add && git commit` through the shim', !p.onceAllowed, p);
  check('U1: a once-grant carries the whole Bash call (hook + both shim invocations allowed), and is spent', c.onceAllowed && c.onceSpent, c);
  check('U2 must-FAIL on the pre-change bytes: the leak gate runs TWICE for one granted commit', p.gateRuns === 2, p);
  check('U2: the leak gate runs exactly ONCE for one granted commit (reach proven)', c.durAllowed && c.gateRuns === 1, c);
  check('U3 must-FAIL on the pre-change bytes: a record is left pending (never confirmed)', p.pending > 0, p);
  check('U3: no record left pending; every record of the call names one decision', c.pending === 0 && c.decisions === 1 && !c.nullDecision, c);

  /* U4: first write of a session (reach unproven) — hook gates pre-exec, still one decision */
  reset(cur);
  cur.store.grantGitWrite(P, { scope: 'once' });
  const g4 = gateCounter();
  const first = addCommitCall(cur, g4);
  const recs4 = cur.store.listGitWrites(P, 50);
  check('U4: first write of a session — one decision, both invocations allowed, gate ran at the hook (reach not yet proven)', first.h.allow && !first.h.deferred && first.a?.allow && first.c?.allow && g4.runs >= 1 && new Set(recs4.map((r) => r.decision)).size === 1 && recs4.every((r) => r.outcome === 'executed'), { deferred: first.h.deferred, gateRuns: g4.runs, recs: recs4.map((r) => [r.offender, r.outcome]) });

  /* U5: slots bound what one decision can authorise (and the mutant proves the check bites) */
  const slotsProbe = (v) => {
    reset(v);
    v.store.grantGitWrite(P, { scope: 'duration', ttlMs: 60_000 }); addCommitCall(v, gateCounter()); v.store.revokeGitWrite(P);
    v.store.grantGitWrite(P, { scope: 'once' });
    const g = gateCounter();
    const h = hookDecide(v, 'git commit -m x', g);
    const r1 = shimDecide(v, ['commit', '-m', 'x'], g);
    const r2 = shimDecide(v, ['commit', '-m', 'again'], g); // a second commit the command never wrote out
    endCall(v, h.toolUseId);
    return { h: h.allow, r1: r1.allow, r2: r2.allow };
  };
  const s5 = slotsProbe(cur), s5m = slotsProbe(noSlots);
  check('U5: a once-grant decision for ONE written commit authorises exactly one commit invocation', s5.h && s5.r1 && !s5.r2, s5);
  check('U5 mutant (slots never consumed) breaks it — the check is not vacuous', s5m.h && s5m.r1 && s5m.r2, s5m);

  /* U6: orphan — a window whose call never ended lapses; the mutant without the reap grants a later write */
  const orphanProbe = (v) => {
    reset(v);
    v.store.grantGitWrite(P, { scope: 'duration', ttlMs: 60_000 }); addCommitCall(v, gateCounter()); v.store.revokeGitWrite(P);
    v.store.grantGitWrite(P, { scope: 'once', ttlMs: 60 * 60_000 });
    const t0 = Date.now();
    const g = gateCounter();
    const h = hookDecide(v, 'git commit -m a || git commit -m b', g, { now: t0 });
    const r1 = shimDecide(v, ['commit', '-m', 'a'], g, { now: t0 + 10 });
    // no Post, no turn end, no supersession: the call is orphaned; past the bound another process commits
    const late = shimDecide(v, ['commit', '-m', 'late'], g, { now: t0 + v.store.CLAIM_MAX_MS + 60_000 });
    return { h: h.allow, r1: r1.allow, late: late.allow };
  };
  const o6 = orphanProbe(cur), o6m = orphanProbe(noReap);
  check('U6: an orphaned window (call never ended) LAPSES — its unused slot does not grant a write past the bound', o6.h && o6.r1 && !o6.late, o6);
  check('U6 mutant (no lapse reap, no store lapse) — the orphan grants the later write (must-FAIL baseline for the orphan property)', o6m.h && o6m.r1 && o6m.late, o6m);

  /* U7: a reserved-but-unused window: ending it releases; lapse releases; no double spend */
  reset(cur);
  cur.store.grantGitWrite(P, { scope: 'duration', ttlMs: 60_000 }); addCommitCall(cur, gateCounter()); cur.store.revokeGitWrite(P);
  cur.store.grantGitWrite(P, { scope: 'once' });
  const h7 = hookDecide(cur, 'git commit -m x', gateCounter());
  const reservedView = cur.store.grantView(P);
  endCall(cur, h7.toolUseId); // e.g. PermissionDenied: the command never ran
  const releasedView = cur.store.grantView(P);
  check('U7: a deferred call reserves (not spends); ending it unused releases the once-grant', h7.deferred === true && reservedView?.reserved === 1 && releasedView?.remainingUses === 1 && releasedView?.reserved === 0, { deferred: h7.deferred, reservedView, releasedView });
  // BUG-231 r6 — the bound governs when an otherwise-live call lapses. Exercise BOTH
  // sides of CLAIM_MAX_MS with INJECTED time (no real sleeps), relative to the store's
  // own constant so the suite tracks the one source. r5's bound was 5 min, which denied
  // the ordinary `npm test && git commit` whose tests run longer; r6 raises it above the
  // Bash max call duration so the legitimate long call's write is still allowed.
  //
  // U7a (the r6 fix): a deferred once-call whose write arrives JUST INSIDE the bound
  // (longer than r5's 5 min — the `npm test && git commit` case) is ALLOWED and spends.
  reset(cur);
  cur.store.grantGitWrite(P, { scope: 'duration', ttlMs: 60_000 }); addCommitCall(cur, gateCounter()); cur.store.revokeGitWrite(P);
  cur.store.grantGitWrite(P, { scope: 'once' });
  const tA = Date.now();
  const hA = hookDecide(cur, 'git commit -m long', gateCounter(), { now: tA });
  const withinBound = tA + cur.store.CLAIM_MAX_MS - 60_000; // a long-but-legitimate call, inside the lapse
  const longWrite = shimDecide(cur, ['commit', '-m', 'long'], gateCounter(), { now: withinBound });
  const spentView = cur.store.grantView(P, withinBound);
  check('U7a (r6): a live call that runs almost to the bound (far longer than r5\'s 5 min) is ALLOWED and spends the once-grant', hA.deferred && longWrite.allow && spentView === null,
    { deferred: hA.deferred, longWrite: longWrite.allow, spentView });

  // U7b (changed semantics, r5): PAST the bound a deferred once-call's write is DENIED
  // (terminal lapse), its reservation returns, and a NEW call gets the once-grant once.
  reset(cur);
  cur.store.grantGitWrite(P, { scope: 'duration', ttlMs: 60_000 }); addCommitCall(cur, gateCounter()); cur.store.revokeGitWrite(P);
  cur.store.grantGitWrite(P, { scope: 'once' });
  const t7 = Date.now();
  const h7b = hookDecide(cur, 'git commit -m y', gateCounter(), { now: t7 });
  const pastBound = t7 + cur.store.CLAIM_MAX_MS + 60_000; // past the lapse
  const lateA = shimDecide(cur, ['commit', '-m', 'y'], gateCounter(), { now: pastBound });
  const lapsedView = cur.store.grantView(P, pastBound);
  const next7 = hookDecide(cur, 'git commit -m z', gateCounter(), { now: pastBound + 1 });
  const next7c = shimDecide(cur, ['commit', '-m', 'z'], gateCounter(), { now: pastBound + 2 });
  const after7 = hookDecide(cur, 'git commit -m w', gateCounter(), { now: pastBound + 3 });
  check('U7b: a lapsed reserved call (past the bound) stays denied (terminal), releases its reservation, and the once-grant goes to exactly one new call', h7b.deferred && !lateA.allow && lapsedView?.remainingUses === 1 && next7.allow && next7c.allow && !after7.allow,
    { lapsedCall: lateA.allow, lapsedView, nextCall: next7.allow, nextCommit: next7c.allow, afterCall: after7.allow });

  /* U8: supersession is per agent; turn end ends all */
  reset(cur);
  cur.store.grantGitWrite(P, { scope: 'duration', ttlMs: 60_000 });
  const hm = hookDecide(cur, 'git commit -m m', gateCounter(), { agentKey: 'main' });
  const hs = hookDecide(cur, 'git commit -m s', gateCounter(), { agentKey: 'sub-1' });
  const afterSub = cur.grant._gitWriteWindowsOf(BINDING).map((w) => w.agentKey).sort();
  cur.grant.beginGitWriteToolCall({ binding: BINDING, toolUseId: 'tu-next-main', agentKey: 'main' });
  const afterMainNext = cur.grant._gitWriteWindowsOf(BINDING).map((w) => w.agentKey);
  endAll(cur);
  check('U8: an agent\'s next tool call ends only ITS open window; turn end ends all', hm.allow && hs.allow && afterSub.join() === 'main,sub-1' && afterMainNext.join() === 'sub-1' && cur.grant._gitWriteWindowsOf(BINDING).length === 0, { afterSub, afterMainNext });

  /* U9: a gate failure at the shim keeps the slot and the reservation; the call's end releases it */
  reset(cur);
  cur.store.grantGitWrite(P, { scope: 'duration', ttlMs: 60_000 }); addCommitCall(cur, gateCounter()); cur.store.revokeGitWrite(P);
  cur.store.grantGitWrite(P, { scope: 'once' });
  const h9 = hookDecide(cur, 'git commit -m x', gateCounter());
  FP.cur = { head: 'h0', entries: ['README.md:aaa', 'leak.txt:ccc'], gateKey: 'gk0' }; // the command created a leaking file after the hook's gate
  const leak = shimDecide(cur, ['commit', '-m', 'x'], gateCounter(false));
  FP.cur = { head: 'h0', entries: ['README.md:aaa'], gateKey: 'gk0' };
  endCall(cur, h9.toolUseId);
  check('U9: a leaking commit is refused at the shim (gate at the write); nothing is spent', h9.deferred && !leak.allow && leak.gateFailed && cur.store.grantView(P)?.remainingUses === 1, { leak: { allow: leak.allow, gateFailed: leak.gateFailed }, grant: cur.store.grantView(P) });

  /* U10: container (the shim never reaches the CLI) — the hook decides, gates and spends */
  reset(cur);
  cur.store.grantGitWrite(P, { scope: 'once' });
  const g10 = gateCounter();
  const h10 = hookDecide(cur, 'git add f && git commit -m x', g10, { shimReachesCli: false });
  const h10b = hookDecide(cur, 'git commit -m again', gateCounter(), { shimReachesCli: false });
  check('U10: container session — a once-grant lets exactly one Bash git write through (hook gates and spends)', h10.allow && !h10.deferred && g10.runs === 1 && !h10b.allow && cur.store.grantView(P) === null, { first: h10.allow, deferred: h10.deferred, gateRuns: g10.runs, second: h10b.allow });

  /* U11: forged / unknown binding, wrong project → independent decision (the old path) */
  reset(cur);
  cur.store.grantGitWrite(P, { scope: 'duration', ttlMs: 60_000 }); addCommitCall(cur, gateCounter()); cur.store.revokeGitWrite(P);
  cur.store.grantGitWrite(P, { scope: 'once' });
  const h11 = hookDecide(cur, 'git commit -m x', gateCounter());
  const forged = shimDecide(cur, ['commit', '-m', 'x'], gateCounter(), { binding: 'not-a-session' });
  const other = cur.grant.redeemGitWrite({ binding: BINDING, argv: ['commit', '-m', 'x'], projectKey: 'other-proj', env: {}, runLeakGate: () => ({ ok: true }) });
  endCall(cur, h11.toolUseId);
  check('U11: an unknown binding or another project never redeems a window (independent decision: refused, the use is held by the call)', h11.deferred && !forged.allow && !forged.redeemed && !other.allow, { forged: forged.allow, other: other.allow });

  /* U12: permanent and duration grants are unchanged in effect */
  reset(cur);
  cur.store.setPermanentGrantSource((k) => (k === P ? { permanent: true } : null));
  const h12 = hookDecide(cur, 'git add f && git commit -m x', gateCounter());
  const a12 = shimDecide(cur, ['add', 'f'], gateCounter()), c12 = shimDecide(cur, ['commit', '-m', 'x'], gateCounter());
  endCall(cur, h12.toolUseId);
  const h12b = hookDecide(cur, 'git commit -m y', gateCounter());
  check('U12: a permanent grant permits every Bash call, before and after', h12.allow && a12.allow && c12.allow && h12b.allow, { h12: h12.allow, a12: a12.allow, c12: c12.allow, h12b: h12b.allow });

  /* U13 (BUG-231 r7, verify run 01a10e18 probe af310f923a95): the shim skips the re-gate
   * only when BOTH the content AND the gate-config key are unchanged since the hook gated.
   * A verdict flip for byte-identical content (allowlist / token list / gate script / own-
   * project resolution changed → a NEW gateKey) must force the gate to run again, or an
   * ungated commit lands. must-FAIL on pre-r7 bytes (fingerprintCovered ignored the key). */
  const gateConfigProbe = (v) => {
    reset(v);
    v.store.grantGitWrite(P, { scope: 'duration', ttlMs: 60_000 }); addCommitCall(v, gateCounter()); v.store.revokeGitWrite(P);
    v.store.grantGitWrite(P, { scope: 'duration', ttlMs: 60_000 });
    FP.cur = { head: 'h0', entries: ['README.md:aaa'], gateKey: 'gk0' };
    const g = gateCounter();
    const h = hookDecide(v, 'git commit -m x', g); // hook gates under gk0, records it
    const hookGateRuns = g.runs;
    // Same content, but the gate's config changed since (new key) and its verdict is now FAIL.
    FP.cur = { head: 'h0', entries: ['README.md:aaa'], gateKey: 'gk1' };
    const gb = gateCounter(false);
    const c = shimDecide(v, ['commit', '-m', 'x'], gb);
    FP.cur = { head: 'h0', entries: ['README.md:aaa'], gateKey: 'gk0' };
    endCall(v, h.toolUseId);
    return { held: h.allow && hookGateRuns === 1 && gb.runs === 1 && !c.allow && !!c.gateFailed,
      detail: { hookAllow: h.allow, hookGateRuns, regateRuns: gb.runs, commit: c.allow, gateFailed: !!c.gateFailed } };
  };
  const FIX7 = path.join(HERE, 'scripts', 'fixtures', 'bug-231-r7');
  const preR7 = await loadVariant('pre-r7', fs.readFileSync(path.join(FIX7, 'pre-git-grant.mjs'), 'utf8'), fs.readFileSync(path.join(FIX7, 'pre-git-grant-store.mjs'), 'utf8'));
  const u13pre = gateConfigProbe(preR7), u13cur = gateConfigProbe(cur);
  check('U13 must-FAIL on pre-r7 bytes: a changed gate-config key is IGNORED — the fingerprint skip runs the now-failing gate\'s commit ungated', !u13pre.held, u13pre.detail);
  check('U13 (r7): a changed gate-config key forces a re-gate on identical content; the now-failing gate refuses the commit', u13cur.held, u13cur.detail);

  /* ── review r1 (openai, BROKEN on the first build) — each finding as a property ── */
  // R1 (F1): the hook gates a publish BEFORE it runs even when it defers the spend, so a
  // shell function routing the commit around the shim cannot reach git ungated.
  reset(cur);
  cur.store.grantGitWrite(P, { scope: 'duration', ttlMs: 60_000 }); addCommitCall(cur, gateCounter()); cur.store.revokeGitWrite(P);
  cur.store.grantGitWrite(P, { scope: 'once' });
  const gR1 = gateCounter();
  const hR1 = hookDecide(cur, 'BYPASS=1 git commit -m later', gR1);
  check('R1: a deferred publish is still gated by the hook before it runs (0 runs on the first build)', hR1.allow && hR1.deferred && gR1.runs === 1, { deferred: hR1.deferred, hookGateRuns: gR1.runs });
  const unchanged = shimDecide(cur, ['commit', '-m', 'later'], gR1);
  check('R1: the shim does not re-gate content the hook already passed (one gate per write)', unchanged.allow && gR1.runs === 1, { allow: unchanged.allow, gateRuns: gR1.runs });
  endCall(cur, hR1.toolUseId);
  // R1b: content created INSIDE the command after the hook's gate is re-gated at the write.
  cur.store.grantGitWrite(P, { scope: 'duration', ttlMs: 60_000 });
  const gR1b = gateCounter();
  const hR1b = hookDecide(cur, 'printf x > leak.txt && git add leak.txt && git commit -m x', gR1b);
  FP.cur = { head: 'h0', entries: ['README.md:aaa', 'leak.txt:bbb'] }; // the command wrote a new file
  const addR1b = shimDecide(cur, ['add', 'leak.txt'], gR1b);
  const comR1b = shimDecide(cur, ['commit', '-m', 'x'], gR1b);
  check('R1b: new content after the hook\'s gate is re-gated at the commit', hR1b.allow && addR1b.allow && comR1b.allow && gR1b.runs === 2, { gateRuns: gR1b.runs });
  endCall(cur, hR1b.toolUseId);
  FP.cur = { head: 'h0', entries: ['README.md:aaa'] };
  // R2 (F2): an absolute-path write runs outside the shim and leaves NO redeemable slot.
  reset(cur);
  cur.store.grantGitWrite(P, { scope: 'once' });
  const hR2 = hookDecide(cur, '/usr/bin/git commit -m direct; sleep 10', gateCounter());
  const bg = shimDecide(cur, ['commit', '-m', 'other'], gateCounter()); // a background process during the sleep
  endCall(cur, hR2.toolUseId);
  check('R2: one absolute-path commit decision gives a shimmed background commit nothing (allowed on the first build)', hR2.allow && !bg.allow, { hook: hR2.allow, background: bg.allow });
  // R3 (F3): a subagent's window ends when the subagent stops, even with its Post lost.
  reset(cur);
  cur.store.grantGitWrite(P, { scope: 'duration', ttlMs: 60_000 }); addCommitCall(cur, gateCounter()); cur.store.revokeGitWrite(P);
  cur.store.grantGitWrite(P, { scope: 'once' });
  const hR3 = hookDecide(cur, 'git commit -m a || git commit -m b', gateCounter(), { agentKey: 'sub-7' });
  const cR3 = shimDecide(cur, ['commit', '-m', 'a'], gateCounter());
  cur.grant.beginGitWriteToolCall({ binding: BINDING, toolUseId: 'tu-main-next', agentKey: 'main' });
  cur.grant.endGitWriteAgent(BINDING, 'sub-7'); // SubagentStop
  const lateR3 = shimDecide(cur, ['commit', '-m', 'late'], gateCounter());
  check('R3: after SubagentStop, the child\'s unused slot grants no later write', hR3.allow && cR3.allow && !lateR3.allow, { child: cR3.allow, late: lateR3.allow });
  reset(cur);
}

try {
  if (ONLY !== 'unit') await e2e();
  if (ONLY !== 'e2e') await unit();
} finally {
  for (const c of spawned) { try { if (c.exitCode === null) process.kill(c.pid, 'SIGKILL'); } catch { /* gone */ } }
}
console.log(`\nBUG-231: ${pass} passed, ${fail} failed${fail ? `\n  FAILED: ${failures.join('\n          ')}` : ''}\n  scratch: ${RUN}`);
process.exit(fail ? 1 : 0);
