#!/usr/bin/env node
/**
 * FEAT-196 — the device-pairing credential and the remote-caller gate, as UNITS.
 *
 * What this proves directly against the REAL modules (src/server/device-pairing.ts and
 * src/server/caller-provenance.ts), each over a fresh scratch data dir:
 *  - a pairing's raw token never reaches disk — the store keeps only sha256 + an HMAC seal;
 *  - a valid token validates; a wrong token, the stored HASH presented as a token, and a
 *    random 64-hex string all fail;
 *  - an agent that WRITES its own pairing record (same uid, the data dir is not OS-protected)
 *    cannot forge the seal, so the server ignores it — the FEAT-164 bar, no new casual path;
 *  - tampering a legit record's tokenHash breaks its seal and voids it;
 *  - peerUidFromProc reads the CLIENT socket's owner uid from a real /proc/net/tcp row
 *    (uid 0 for a root proxy row, the server's own uid for a same-uid agent row, null when
 *    no row matches);
 *  - requireUserCaller(allowPaired) ALLOWS only (peer uid 0 AND valid token), and REFUSES
 *    (uid 0 + no/invalid token) and (valid token + non-root peer) — the root-proxy happy path
 *    exercised through the real gate via the test-only peer-uid seam, since a uid-1000 test
 *    cannot create a root-owned peer. (The live root-proxy transport itself is covered by the
 *    integration suite's refusals + the machine evidence that tailscaled is root.)
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`); }
};
const freshDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'feat196-'));
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

const dp = await import(path.join(ROOT, 'src/server/device-pairing.ts'));
const cp = await import(path.join(ROOT, 'src/server/caller-provenance.ts'));

/* ── device-pairing store ─────────────────────────────────────────────────── */
{
  const DIR = freshDir();
  const r = dp.enrollPairing('my phone', DIR);
  check('enroll returns a 256-bit (64-hex) token once', !r.error && /^[0-9a-f]{64}$/.test(r.token), r);
  check('validate accepts the enrolled token', dp.validatePairingToken(r.token, DIR) === r.id, { got: dp.validatePairingToken(r.token, DIR), want: r.id });

  const raw = fs.readFileSync(path.join(DIR, 'device-pairings.json'), 'utf8');
  check('the RAW token is never written to disk', !raw.includes(r.token), 'raw token found in store file');
  check('the store holds sha256(token), not the token', raw.includes(sha256(r.token)));
  const stored = JSON.parse(raw)[0];
  check('each record carries an HMAC seal', typeof stored.seal === 'string' && /^[0-9a-f]{64}$/.test(stored.seal), stored.seal);

  check('a wrong (but well-formed) token is refused', dp.validatePairingToken('a'.repeat(64), DIR) === null);
  check('presenting the stored HASH as a token is refused', dp.validatePairingToken(stored.tokenHash, DIR) === null);
  check('a malformed token is refused', dp.validatePairingToken('not-a-token', DIR) === null);

  check('listPairings exposes metadata but neither token nor hash', (() => {
    const v = dp.listPairings(DIR);
    return v.length === 1 && v[0].id === r.id && !('tokenHash' in v[0]) && !('token' in v[0]) && !('seal' in v[0]);
  })());

  const revoked = dp.revokePairing(r.id, DIR);
  check('revoke removes the pairing and the token stops working', revoked && dp.validatePairingToken(r.token, DIR) === null);
}

/* ── capacity: enrolment must refuse before the store can exceed its read cap ── */
{
  const DIR = freshDir();
  let lastOk = null, refusedAt = null;
  for (let i = 0; i < 200 && refusedAt === null; i++) {
    const r = dp.enrollPairing('d'.repeat(120), DIR); // worst-case label length
    if (r.error) refusedAt = i; else lastOk = r.token;
  }
  check('enrolment refuses past a bounded device limit (never grows the store unreadable)', refusedAt !== null && refusedAt < 200, { refusedAt });
  const bytes = fs.statSync(path.join(DIR, 'device-pairings.json')).size;
  check('the capped store stays well under the 256 KiB read limit', bytes < 256 * 1024, bytes);
  check('every token issued before the cap still validates (nothing invalidated)', !!lastOk && dp.validatePairingToken(lastOk, DIR) !== null);
}

/* ── AGENT INJECTION: write a record with your own hash but no valid seal ───── */
{
  const DIR = freshDir();
  // The agent cannot forge the seal (needs the seal key — the FEAT-164 residual). So it
  // writes a record with the hash of a token IT chose, hoping the server honours it.
  dp.enrollPairing('seed so the key exists', DIR); // make the seal key exist, like a real deployment
  const attackerToken = 'f'.repeat(64);
  const forged = [{ id: 'dp-attacker', label: 'evil', tokenHash: sha256(attackerToken), createdAt: new Date().toISOString(), lastUsedAt: null, seal: '0'.repeat(64) }];
  const store = JSON.parse(fs.readFileSync(path.join(DIR, 'device-pairings.json'), 'utf8'));
  fs.writeFileSync(path.join(DIR, 'device-pairings.json'), JSON.stringify([...store, ...forged], null, 2));
  check('an agent-written UNSEALED pairing never validates (seal required)', dp.validatePairingToken(attackerToken, DIR) === null);
  // and an agent writing a plausible seal value it computed WITHOUT the key still fails
  const forged2 = { ...forged[0], seal: sha256('guessing the seal') };
  fs.writeFileSync(path.join(DIR, 'device-pairings.json'), JSON.stringify([...store, forged2], null, 2));
  check('an agent-guessed seal (no key) never validates', dp.validatePairingToken(attackerToken, DIR) === null);
}

/* ── tamper a legit record ──────────────────────────────────────────────────── */
{
  const DIR = freshDir();
  const r = dp.enrollPairing('phone', DIR);
  const store = JSON.parse(fs.readFileSync(path.join(DIR, 'device-pairings.json'), 'utf8'));
  // Flip one hex nibble of the stored hash — the seal no longer matches the body.
  store[0].tokenHash = store[0].tokenHash.replace(/^./, (c) => (c === '0' ? '1' : '0'));
  fs.writeFileSync(path.join(DIR, 'device-pairings.json'), JSON.stringify(store, null, 2));
  check('tampering a record voids its seal → the pairing is ignored', dp.validatePairingToken(r.token, DIR) === null);
}

/* ── peerUidFromProc parsing (real /proc/net/tcp row shapes) ───────────────── */
{
  // columns: sl local_address rem_address st tx:rx tr:when retrnsmt uid timeout inode ...
  const header = 'sl local rem st q q t r uid to inode';
  // CLIENT row of a ROOT proxy: local 0100007F:04D2 (port 1234), remote 0100007F:10E5 (4325), uid 0.
  const rootRow = `${header}\n 1: 0100007F:04D2 0100007F:10E5 01 00000000:00000000 00:00000000 00000000 0 0 42 2 0`;
  check('peerUidFromProc reads uid 0 from a root client row', cp.peerUidFromProc(rootRow, 0x04D2, 0x10E5) === 0);
  const userRow = `${header}\n 7: 0100007F:04D2 0100007F:10E5 01 00000000:00000000 00:00000000 00000000 1000 0 99 2 0`;
  check('peerUidFromProc reads the agent uid 1000 from a same-uid client row', cp.peerUidFromProc(userRow, 0x04D2, 0x10E5) === 1000);
  check('peerUidFromProc returns null when no row matches the connection tuple', cp.peerUidFromProc(rootRow, 0x1111, 0x2222) === null);
  // a listen socket row (inode 0) must not be mistaken for the client end
  const listenOnly = `${header}\n 0: 0100007F:10E5 00000000:0000 0A 0:0 0:0 0 1000 0 0 2 0`;
  check('a listen row (inode 0 / no remote) is not matched', cp.peerUidFromProc(listenOnly, 0x04D2, 0x10E5) === null);
}

/* ── the real gate: requireUserCaller(allowPaired) composition ─────────────── */
{
  const DIR = freshDir();
  process.env.CLAUDE_STATION_DATA = DIR; // device-pairing default dir for validatePairingToken inside the gate
  const r = dp.enrollPairing('phone', DIR);
  const reqWith = (tok) => ({ headers: tok ? { 'x-orchard-pairing': tok } : {}, socket: { remoteAddress: '127.0.0.1', remotePort: 54321, localPort: 4317 } });

  // Force the classifier to 'unknown'/non-user by making the socket loopback with no resolvable pid;
  // classifyCaller will return unknown (no /proc row for 54321→4317), so we are in the remote branch.
  cp.__setPeerUidResolverForTest(() => 0); // simulate the root tailscaled proxy
  check('ALLOW: root-proxy peer (uid 0) + valid token', cp.requireUserCaller(reqWith(r.token), 'grant', { allowPaired: true }) === null);
  check('REFUSE: root-proxy peer (uid 0) + NO token', cp.requireUserCaller(reqWith(null), 'grant', { allowPaired: true }) !== null);
  check('REFUSE: root-proxy peer (uid 0) + WRONG token', cp.requireUserCaller(reqWith('b'.repeat(64)), 'grant', { allowPaired: true }) !== null);

  cp.__setPeerUidResolverForTest(() => 1000); // a same-uid agent, even with a leaked token
  check('REFUSE: same-uid peer (uid 1000) + valid token (leaked token inert off the proxy)', cp.requireUserCaller(reqWith(r.token), 'grant', { allowPaired: true }) !== null);

  cp.__setPeerUidResolverForTest(() => 0);
  check('REFUSE: a route that does NOT opt in (no allowPaired) ignores the token entirely', cp.requireUserCaller(reqWith(r.token), 'grant') !== null);
  cp.__setPeerUidResolverForTest(null);
}

console.log(`\nFEAT-196 pairing-store units: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
