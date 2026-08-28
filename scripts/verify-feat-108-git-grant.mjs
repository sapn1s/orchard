#!/usr/bin/env node
/**
 * verify-feat-108-git-grant.mjs — FEAT-108 round 2 (runtime, per-project,
 * revocable git-write grants + the mandatory-gate-on-a-granted-commit).
 *
 * Grades the NEW capability against the round-1 block:
 *   1. NON-VACUITY — round-1 decideGitWrite denies a commit and has NO runtime
 *      grant; the whole grant path is new, so every "after granting" assertion
 *      below would FAIL on the pre-change tree.
 *   2. THE REAL GRANT PATH — deny → grant → the SAME write succeeds → revoke /
 *      expire → deny again. Driven through evaluateGitWrite (the exact decision
 *      the runtime PreToolUse callback runs) + the store (what the route mutates).
 *   3. SELF-GRANT HOLES CLOSED — env var (host-env-read + assignment-stripped),
 *      writing config (the store never reads a file), and cross-project /
 *      subagent bleed.
 *   4. THE GATE STAYS MANDATORY — a granted commit/push whose leak gate FAILS is
 *      refused; proven with the REAL scripts/leak-gate.mjs over scratch repos
 *      (one leaking, one clean), not a stub alone.
 *   5. SINGLE-USE vs DURATION, and VISIBILITY (ledger + audit sink).
 *
 * Run: npm run verify:git-grant
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { decideGitWrite } from './lib/git-write-policy.mjs';
import { evaluateGitWrite, PUBLISHING_SUBCOMMANDS } from './lib/git-grant.mjs';
import {
  grantGitWrite, revokeGitWrite, peekGrant, grantView, listGitWrites,
  setGitWriteAuditSink, _resetGitGrantsForTest,
} from './lib/git-grant-store.mjs';

let pass = 0, fail = 0, skip = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; return; }
  fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};
const skipped = (name, why) => { skip++; console.log(`  SKIP  ${name} — ${why}`); };

const REPO = path.resolve(import.meta.dirname, '..');
const KEY = 'proj-alpha';
const OTHER = 'proj-beta';
const gateOK = () => ({ ok: true, detail: '' });
const gateFAIL = () => ({ ok: false, detail: 'LEAK GATE: FAIL — 1 hit' });

/* ═══ 1. NON-VACUITY — the pre-change tree had NO runtime grant ═════════════ */
_resetGitGrantsForTest();
ok('MUST-FAIL(pre-change): round-1 decideGitWrite denies `git commit` (host block ON)',
  decideGitWrite('git commit -m x', {}).allow === false);
ok('MUST-FAIL(pre-change): with NO grant, evaluateGitWrite denies `git commit`',
  evaluateGitWrite({ command: 'git commit -m x', projectKey: KEY, env: {}, runLeakGate: gateOK }).allow === false);
// The new capability that did not exist before: a grant flips the SAME command.
grantGitWrite(KEY, { scope: 'duration', ttlMs: 60_000 });
ok('NEW: after a user grant, the SAME `git commit` is ALLOWED (no relaunch)',
  evaluateGitWrite({ command: 'git commit -m x', projectKey: KEY, env: {}, runLeakGate: gateOK }).allow === true);
_resetGitGrantsForTest();

/* ═══ 2. THE REAL GRANT PATH — deny → grant → succeed → revoke/expire → deny ═ */
_resetGitGrantsForTest();
const cmd = 'git commit -m "work"';
ok('path: denied before any grant',
  evaluateGitWrite({ command: cmd, projectKey: KEY, env: {}, runLeakGate: gateOK }).allow === false);
grantGitWrite(KEY, { scope: 'duration', ttlMs: 10 * 60_000, grantedVia: 'dashboard' });
ok('path: the user grants → the same write succeeds',
  evaluateGitWrite({ command: cmd, projectKey: KEY, env: {}, runLeakGate: gateOK }).allow === true);
ok('path: revoke → denied again',
  (revokeGitWrite(KEY), evaluateGitWrite({ command: cmd, projectKey: KEY, env: {}, runLeakGate: gateOK }).allow) === false);
// Expiry: a duration grant lapses on its own.
const t0 = 1_000_000;
grantGitWrite(KEY, { scope: 'duration', ttlMs: 5 * 60_000, now: t0 });
ok('path: allowed within the window',
  evaluateGitWrite({ command: cmd, projectKey: KEY, env: {}, runLeakGate: gateOK, now: t0 + 60_000 }).allow === true);
ok('path: DENIED after the window expires',
  evaluateGitWrite({ command: cmd, projectKey: KEY, env: {}, runLeakGate: gateOK, now: t0 + 6 * 60_000 }).allow === false);
ok('path: peekGrant purges the expired grant (indistinguishable from none)',
  peekGrant(KEY, t0 + 6 * 60_000) === null);
_resetGitGrantsForTest();

/* ═══ 3. SELF-GRANT HOLES CLOSED ═══════════════════════════════════════════ */
_resetGitGrantsForTest();
// (a) ENV VAR. The host block is ON (host env has no hatch). An agent's Bash
//     `ORCHARD_ALLOW_GIT_WRITE=1 git commit` sets the var only for the CHILD it
//     spawns; the HOST decision reads the HOST env (still ON), and the command
//     string's leading assignment is stripped by the tokenizer → still `git
//     commit` → DENIED (no grant present).
ok('hole/env: agent Bash exporting ORCHARD_ALLOW_GIT_WRITE=1 does NOT self-grant',
  evaluateGitWrite({ command: 'ORCHARD_ALLOW_GIT_WRITE=1 git commit -m x', projectKey: KEY, env: {}, runLeakGate: gateOK }).allow === false);
ok('hole/env: even `export ...; git commit` chained does not open the host block',
  evaluateGitWrite({ command: 'export ORCHARD_ALLOW_GIT_WRITE=1; git commit -m x', projectKey: KEY, env: {}, runLeakGate: gateOK }).allow === false);
// The LAUNCH-time env hatch still works when it is set on the HOST env (req. 5).
ok('req5: the launch-time env hatch on the HOST env still allows',
  evaluateGitWrite({ command: 'git commit -m x', projectKey: KEY, env: { ORCHARD_ALLOW_GIT_WRITE: '1' }, runLeakGate: gateOK }).allow === true);

// (b) WRITING CONFIG. An agent writing a "grant" into a file (registry / any
//     on-disk config) grants nothing: the store is read from memory only. Prove
//     the store never consults a file by planting one and checking peekGrant.
const fakeRegistry = path.join(os.tmpdir(), `feat108-fakegrant-${process.pid}.json`);
fs.writeFileSync(fakeRegistry, JSON.stringify({ gitWrite: { [KEY]: { allow: true } } }));
ok('hole/config: a grant written to a file is NOT read by the store (no grant active)',
  peekGrant(KEY) === null && evaluateGitWrite({ command: 'git commit -m x', projectKey: KEY, env: {}, runLeakGate: gateOK }).allow === false);
fs.rmSync(fakeRegistry, { force: true });

// (c) CROSS-PROJECT / SUBAGENT bleed. A grant for project A must not permit a
//     write in project B (a dispatched subagent in another project), and a
//     null/absent project key is never granted.
grantGitWrite(KEY, { scope: 'duration', ttlMs: 60_000 });
ok('hole/scope: a grant for A does NOT permit a write in B',
  evaluateGitWrite({ command: 'git commit -m x', projectKey: OTHER, env: {}, runLeakGate: gateOK }).allow === false);
ok('hole/scope: a session with no project key is never granted',
  evaluateGitWrite({ command: 'git commit -m x', projectKey: null, env: {}, runLeakGate: gateOK }).allow === false);
_resetGitGrantsForTest();

/* ═══ 4. THE GATE STAYS MANDATORY ══════════════════════════════════════════ */
_resetGitGrantsForTest();
grantGitWrite(KEY, { scope: 'duration', ttlMs: 60_000 });
ok('gate: a GRANTED commit whose gate FAILS is refused',
  evaluateGitWrite({ command: 'git commit -m x', projectKey: KEY, env: {}, runLeakGate: gateFAIL }).gateFailed === true);
ok('gate: a GRANTED push whose gate FAILS is refused',
  evaluateGitWrite({ command: 'git push', projectKey: KEY, env: {}, runLeakGate: gateFAIL }).allow === false);
ok('gate: a granted commit with a PASSING gate is allowed',
  evaluateGitWrite({ command: 'git commit -m x', projectKey: KEY, env: {}, runLeakGate: gateOK }).allow === true);
ok('gate: a granted NON-publishing write (git add) does not require the gate',
  evaluateGitWrite({ command: 'git add -A', projectKey: KEY, env: {}, runLeakGate: gateFAIL }).allow === true);
ok('gate: FAIL-CLOSED — a granted commit with NO gate runner available is refused',
  evaluateGitWrite({ command: 'git commit -m x', projectKey: KEY, env: {}, runLeakGate: null }).allow === false);
ok('publishing set is exactly {commit, push}',
  PUBLISHING_SUBCOMMANDS.has('commit') && PUBLISHING_SUBCOMMANDS.has('push') && !PUBLISHING_SUBCOMMANDS.has('add'));
_resetGitGrantsForTest();

/* ── The REAL leak gate over REAL scratch repos (the user's reality) ──────── */
function realGate(repoPath) {
  try {
    execFileSync(process.execPath, [path.join(REPO, 'scripts', 'leak-gate.mjs'), '--summary'], { cwd: repoPath, stdio: 'pipe', timeout: 30_000 });
    return { ok: true, detail: '' };
  } catch (e) {
    return { ok: false, detail: `${e.stdout ?? ''}${e.stderr ?? ''}`.slice(0, 400) };
  }
}
const scratchBase = path.join(os.tmpdir(), `feat108-grant-verify-${process.pid}`);
try {
  const mkRepo = (name, fileContent) => {
    const dir = path.join(scratchBase, name);
    fs.mkdirSync(dir, { recursive: true });
    const env = { ...process.env, HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
    execFileSync('git', ['init', '-q'], { cwd: dir, env });
    fs.writeFileSync(path.join(dir, 'note.md'), fileContent);
    return dir;
  };
  // A file carrying a private home path — the exact BUG-155 class.
  const leaky = mkRepo('leaky', 'deploy target: /home/' + 'sa' + 'p' + '/projects/x\n');
  const clean = mkRepo('clean', 'a perfectly ordinary note with no private tokens\n');

  _resetGitGrantsForTest();
  grantGitWrite(KEY, { scope: 'duration', ttlMs: 60_000 });
  const leakRes = evaluateGitWrite({ command: 'git commit -m x', projectKey: KEY, env: {}, runLeakGate: () => realGate(leaky) });
  ok('REAL gate: a granted commit in a repo that LEAKS a home path is REFUSED',
    leakRes.allow === false && leakRes.gateFailed === true, JSON.stringify(leakRes).slice(0, 200));
  const cleanRes = evaluateGitWrite({ command: 'git commit -m x', projectKey: KEY, env: {}, runLeakGate: () => realGate(clean) });
  ok('REAL gate: a granted commit in a CLEAN repo is ALLOWED', cleanRes.allow === true, JSON.stringify(cleanRes).slice(0, 200));
  _resetGitGrantsForTest();
} catch (e) {
  skipped('REAL leak-gate scratch repos', `git/scratch unavailable: ${(e && e.message) || e}`);
} finally {
  fs.rmSync(scratchBase, { recursive: true, force: true });
}

/* ═══ 5. SINGLE-USE vs DURATION + VISIBILITY ═══════════════════════════════ */
_resetGitGrantsForTest();
grantGitWrite(KEY, { scope: 'once' });
ok('once: the first granted write is allowed',
  evaluateGitWrite({ command: 'git commit -m 1', projectKey: KEY, env: {}, runLeakGate: gateOK }).allow === true);
ok('once: the SECOND write is denied (single-use spent)',
  evaluateGitWrite({ command: 'git commit -m 2', projectKey: KEY, env: {}, runLeakGate: gateOK }).allow === false);
_resetGitGrantsForTest();
grantGitWrite(KEY, { scope: 'duration', ttlMs: 60_000 });
const a1 = evaluateGitWrite({ command: 'git commit -m 1', projectKey: KEY, env: {}, runLeakGate: gateOK }).allow;
const a2 = evaluateGitWrite({ command: 'git push', projectKey: KEY, env: {}, runLeakGate: gateOK }).allow;
ok('duration: multiple writes allowed within the window', a1 === true && a2 === true);

// Visibility: every permitted write is recorded, and the audit sink fires.
_resetGitGrantsForTest();
const sunk = [];
setGitWriteAuditSink((rec) => sunk.push(rec));
grantGitWrite(KEY, { scope: 'duration', ttlMs: 60_000 });
evaluateGitWrite({ command: 'git commit -m visible', projectKey: KEY, env: {}, runLeakGate: gateOK, sessionLabel: 'sess-1' });
const writes = listGitWrites(KEY);
ok('visible: the permitted write appears in the ledger', writes.length === 1 && writes[0].offender === 'git commit');
ok('visible: the ledger records the session label', writes[0].sessionLabel === 'sess-1');
ok('visible: the durable audit sink received the record', sunk.length === 1 && sunk[0].offender === 'git commit');
ok('visible: a gate-blocked write is ALSO recorded (gatePassed=false)',
  (evaluateGitWrite({ command: 'git commit -m leaky', projectKey: KEY, env: {}, runLeakGate: gateFAIL }),
    listGitWrites(KEY).some((w) => w.gatePassed === false)) === true);
setGitWriteAuditSink(null);
_resetGitGrantsForTest();

// grantView shape (the dashboard/health visibility surface).
grantGitWrite(KEY, { scope: 'duration', ttlMs: 15 * 60_000 });
const view = grantView(KEY);
ok('visible: grantView reports scope + expiry for the session surface',
  view && view.scope === 'duration' && typeof view.expiresAt === 'string' && view.expiresInMs > 0);
ok('visible: grantView is null when nothing is granted', grantView(OTHER) === null);
_resetGitGrantsForTest();

/* ═══ 6. WIRING PINS — the runtime + the routes actually use this ══════════ */
const runtimeSrc = fs.readFileSync(path.join(REPO, 'src/server/runtime/claude-runtime.ts'), 'utf8');
ok('PIN: the runtime evaluates the grant-aware decision per Bash call', /evaluateGitWrite\(/.test(runtimeSrc));
ok('PIN: the runtime injects the real leak-gate runner for granted publishes', /runLeakGateForRepo\(/.test(runtimeSrc));
ok('PIN: the runtime passes the project grant key + session label',
  /gitGrantKey/.test(runtimeSrc) && /sessionLabel/.test(runtimeSrc));
const indexSrc = fs.readFileSync(path.join(REPO, 'src/server/index.ts'), 'utf8');
ok('PIN: the route grants via the host-memory store (grantGitWrite)', /grantGitWrite\(/.test(indexSrc));
ok('PIN: the route revokes (revokeGitWrite) and reads (grantView)',
  /revokeGitWrite\(/.test(indexSrc) && /grantView\(/.test(indexSrc));
ok('PIN: the health payload surfaces gitWriteGrant per session', /gitWriteGrant:/.test(indexSrc));
ok('PIN: an audit sink persists permitted writes to a host-side log', /setGitWriteAuditSink\(/.test(indexSrc) && /git-write-audit\.jsonl/.test(indexSrc));
const bridgeSrc = fs.readFileSync(path.join(REPO, 'src/server/agent-bridge.ts'), 'utf8');
ok('PIN: agent-bridge passes the project id + hostPath + session id',
  /gitGrantKey: opts\.project\.id/.test(bridgeSrc) && /gitRepoPath: opts\.project\.hostPath/.test(bridgeSrc));

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed, ${skip} skipped`);
if (fail > 0) { console.log('\nFailures:'); for (const f of failures) console.log(`  - ${f}`); }
process.exit(fail === 0 ? 0 : 1);
