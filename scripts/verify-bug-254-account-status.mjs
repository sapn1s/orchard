#!/usr/bin/env node
/**
 * verify-bug-254-account-status.mjs — BUG-254.
 *
 * Grades the two user-facing defects, against a FAKE `~/.claude` (with a canary)
 * and a scratch `CLAUDE_STATION_DATA`, using the FEAT-145 `claude` STUB so no
 * real OAuth and no real subscription is ever touched:
 *
 *   A) HONEST live status. The stored `state`/`lastStatus` is written ONCE at
 *      login and never re-read, so an expired/revoked credential reads "signed
 *      in" forever. `listAccountsWithHealth` must report a LIVE probe:
 *        - loggedIn:true          → health.state === 'signed-in'
 *        - clean loggedIn:false   → health.state === 'needs-relogin'
 *        - probe could not report → health.state === 'unknown'  (NEVER signed-in)
 *      The must-FAIL anchor: in the expired/unknown cases the STORED row.state is
 *      still 'ready' and lastStatus.loggedIn is still true — i.e. the pre-fix
 *      surface (which the drawer read) WOULD have shown "signed in". So the new
 *      field is doing real work, not decoration.
 *
 *   B) RE-LOGIN IN PLACE. A ready account is no longer refused; it starts a
 *      reauth (reauth:true) against the SAME dir and keeps the SAME id. The
 *      full login-relay contract is in verify-feat-145-login-flow.mjs (56/0);
 *      here we only assert the id is preserved (the thing delete+re-add broke).
 *
 * Also: the DEFAULT account (~/.claude) is NEVER probed (probing shells
 * `claude auth status` against the user's real store, which the CLI mutates) —
 * its row carries no `health`, and the fake real store stays byte-identical.
 *
 * Run: node scripts/verify-bug-254-account-status.mjs
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STUB = path.join(HERE, 'fixtures', 'feat-145', 'claude-stub.mjs');

let pass = 0, fail = 0;
const ok = (c, name, observed) => {
  console.log(`  ${c ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  c ? pass++ : fail++;
};
const section = (s) => console.log(`\n== ${s}`);

/* ── scratch layout: a FAKE ~/.claude with a canary, a scratch data dir ─────── */
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'bug254-'));
const HOME = path.join(SCRATCH, 'home');
const DATA = path.join(SCRATCH, 'data');
const REAL_CLAUDE = path.join(HOME, '.claude');
const REAL_PROJECTS = path.join(REAL_CLAUDE, 'projects');
const REAL_SETTINGS = path.join(REAL_CLAUDE, 'settings.json');
const CANARY = path.join(REAL_PROJECTS, 'CANARY-do-not-delete.txt');

fs.mkdirSync(REAL_PROJECTS, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(CANARY, 'the shared transcript store — a status read must never touch it\n');
fs.writeFileSync(REAL_SETTINGS, `${JSON.stringify({ cleanupPeriodDays: 36500 }, null, 2)}\n`);

process.env.HOME = HOME;
process.env.CLAUDE_STATION_DATA = DATA;
process.env.CLAUDE_STATION_CLAUDE_BIN = STUB;
// Keep the live-probe cache out of the way so each assertion re-probes.
process.env.CLAUDE_STATION_ACCOUNT_HEALTH_TTL_MS = '0';
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CLAUDE_PROJECTS_DIR;
delete process.env.STUB_STATUS_LOGGED_IN;
delete process.env.STUB_STATUS_GARBAGE;

process.on('exit', () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ } });

/** Snapshot the fake real store so we can prove a status read never wrote it. */
function storeFingerprint() {
  const out = {};
  const walk = (p, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(p, e.name); const r = path.join(rel, e.name);
      if (e.isDirectory()) { out[r + '/'] = 'dir'; walk(abs, r); }
      else { try { out[r] = fs.statSync(abs).size; } catch { out[r] = '?'; } }
    }
  };
  walk(REAL_CLAUDE, '');
  return JSON.stringify(out);
}

const accounts = await import(path.join(ROOT, 'src', 'server', 'claude-accounts.ts'));
const login = await import(path.join(ROOT, 'src', 'server', 'claude-login.ts'));

/** Create an account and drive it to a genuine `ready` (credential + markReady). */
function makeReady(label) {
  const row = accounts.createAccount(label); // state 'pending'
  const dir = accounts.resolveAccountDir(row.id);
  // Content is irrelevant — the stub's `auth status` is driven by env, and
  // readiness only checks the file EXISTS. A placeholder keeps the leak-gate out.
  fs.writeFileSync(path.join(dir, '.credentials.json'), '{"placeholder":"test credential — not real"}\n');
  accounts.markAccountReady(row.id, { loggedIn: true, subscriptionType: 'max', checkedAt: Date.now() });
  return row.id;
}
const findHealth = (list, id) => list.find((a) => a.id === id)?.health ?? null;
const findRow = (id) => accounts.readAccounts().find((r) => r.id === id) ?? null;

async function main() {
  const storeBefore = storeFingerprint();
  const id = makeReady('Grey Max plan');

  section('A1. a live probe reporting loggedIn:true → signed-in');
  process.env.STUB_STATUS_LOGGED_IN = '1';
  let list = await accounts.listAccountsWithHealth({ force: true });
  let h = findHealth(list, id);
  ok(h?.state === 'signed-in', 'signed-in is reported when the probe says loggedIn:true', h);

  section('A2. the credential lapses — a CLEAN loggedIn:false → needs-relogin (NOT signed-in)');
  process.env.STUB_STATUS_LOGGED_IN = '0';
  list = await accounts.listAccountsWithHealth({ force: true });
  h = findHealth(list, id);
  const rowExpired = findRow(id);
  ok(h?.state === 'needs-relogin', 'an expired/revoked credential reads needs-relogin', h);
  ok(h?.state !== 'signed-in', 'it is NEVER shown as signed-in once the probe says logged out', h);
  // The must-FAIL anchor: the STORED fields the pre-fix drawer read are STILL
  // "signed in". Without the live health field, the drawer would lie here.
  ok(rowExpired?.state === 'ready' && rowExpired?.lastStatus?.loggedIn === true,
    'must-FAIL anchor: the stored state is still ready/loggedIn:true, so the OLD surface would show "signed in"',
    { state: rowExpired?.state, lastStatus: rowExpired?.lastStatus });

  section('A3. the probe cannot report (non-JSON) → unknown (NOT signed-in)');
  delete process.env.STUB_STATUS_LOGGED_IN;
  process.env.STUB_STATUS_GARBAGE = '1';
  list = await accounts.listAccountsWithHealth({ force: true });
  h = findHealth(list, id);
  ok(h?.state === 'unknown', 'a probe failure fails toward unknown', h);
  ok(h?.state !== 'signed-in', 'a probe failure is NEVER shown as signed-in', h);
  delete process.env.STUB_STATUS_GARBAGE;

  section('A4. the stored state recovers to signed-in once the probe agrees again');
  process.env.STUB_STATUS_LOGGED_IN = '1';
  list = await accounts.listAccountsWithHealth({ force: true });
  ok(findHealth(list, id)?.state === 'signed-in', 'signed-in again after a successful re-probe', findHealth(list, id));

  section('A5. a pending (never-logged-in) account reads setup-pending, not probed as needs-relogin');
  const pend = accounts.createAccount('freshly added');
  process.env.STUB_STATUS_LOGGED_IN = '0';
  list = await accounts.listAccountsWithHealth({ force: true });
  ok(findHealth(list, pend.id)?.state === 'setup-pending', 'a pending account is setup-pending', findHealth(list, pend.id));
  accounts.deleteAccount(pend.id);

  section('A6. the DEFAULT account (~/.claude) is never probed — no health, real store untouched');
  process.env.STUB_STATUS_LOGGED_IN = '0';
  list = await accounts.listAccountsWithHealth({ force: true });
  const def = list.find((a) => a.id === 'default');
  ok(def && !('health' in def && def.health), 'the default row carries no live health', { health: def?.health ?? null });
  ok(storeFingerprint() === storeBefore, 'the fake real ~/.claude is byte-for-byte unchanged by every status read', storeFingerprint() === storeBefore);

  section('B1. a READY account re-logs-in IN PLACE — same id, reauth:true (not refused)');
  process.env.STUB_STATUS_LOGGED_IN = '1';
  process.env.STUB_MODE = 'hang';
  let begun = null, threw = null;
  try { begun = login.startClaudeLogin(id, () => {}); } catch (e) { threw = e; }
  ok(!threw && begun?.accountId === id && begun?.reauth === true,
    'startClaudeLogin on a ready account starts a reauth with the SAME id (was: refused)', { threw: threw?.message, begun });
  login.cancelClaudeLogin(id, 'test cleanup');
  // A cancelled reauth must leave the established account intact.
  const after = findRow(id);
  ok(after?.state === 'ready' && accounts.resolveAccountDir(after.id) === accounts.resolveAccountDir(id),
    'a cancelled reauth leaves the account (id + dir) unchanged', { state: after?.state });

  section(`RESULT — ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exit(1); });
