/**
 * FEAT-196 — a per-device pairing credential so the USER can act (grant agent git-write)
 * from a trusted REMOTE device (their phone, over `tailscale serve`) while no agent can.
 *
 * WHY a token and not Tailscale identity. `tailscale serve` injects only the tailnet USER
 * identity (`Tailscale-User-Login`/`-Name`), which is identical for the phone and for a
 * same-host agent that curls `https://<host>.ts.net/…` (both resolve to the same tailnet
 * user). So the injected header cannot tell the phone from a same-host agent (verified live
 * 2026-10-26 on this machine: `tailscale whois` of the desktop's OWN node returns the user,
 * and a same-host request to the tailnet name is served). Identity alone is refuted; a
 * bearer secret the agent cannot obtain is the mechanism that holds.
 *
 * THE INVARIANT (same bar as FEAT-164's sealed standing grant): no agent-reachable path may
 * mint a pairing or lift a usable token out of state.
 *   - The raw token is 256-bit random, returned exactly ONCE at enrolment, and NEVER stored:
 *     the store keeps only `sha256(token)`. An agent that reads every file under the data dir
 *     finds only an irreversible hash, not the token.
 *   - Each record is HMAC-sealed with the FEAT-164 seal key (scripts/lib/git-write-seal.mjs).
 *     An agent that WRITES its own pairing (same uid, data dir is not OS-protected) cannot
 *     forge a valid seal, so the server ignores the record. Forging a seal needs the seal
 *     key — the one residual FEAT-164 already accepts (a same-uid agent that deliberately
 *     reads the key file). This design adds NO new casual path; it sits at the existing bar.
 *   - Enrolment is gated to a LOCALHOST user (requireUserCaller without allowPaired), so the
 *     FIRST pairing is created at the desktop and a paired phone cannot mint more pairings.
 *   - A presented token is only honoured on a connection proven to come THROUGH tailscaled's
 *     root proxy (peer socket owner uid 0 — see caller-provenance.ts), so even a leaked token
 *     is inert on a same-uid agent's direct loopback curl.
 */
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { dataDir, ensureDir, writeAtomic } from '../lib/paths.ts';
import { readCapped } from './store-io.ts';
import { ensureSealKey, readSealKey } from '../../scripts/lib/git-write-seal.mjs';

const STORE_FILE = 'device-pairings.json';
const MAX_STORE_BYTES = 256 * 1024;
// A worst-case record (120-char label + the fixed fields + JSON overhead) is well under 700 B,
// so this cap keeps the store an order of magnitude below MAX_STORE_BYTES — enrolment can never
// grow it past the read cap and silently invalidate every token (independent-verify 01a17efc).
const MAX_PAIRINGS = 128;
const SEAL_DOMAIN = 'orchard-feat196-device-pairing-v1';

export interface DevicePairing {
  id: string;
  label: string;
  /** sha256(rawToken) in hex — the raw token is never stored. */
  tokenHash: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** HMAC-SHA256 over the record under the FEAT-164 seal key; an unsealed record never counts. */
  seal: string;
}

/** Public metadata only — never the hash or the token. */
export interface DevicePairingView {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

function storeFile(dir: string = dataDir()): string {
  return path.join(dir, STORE_FILE);
}

function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/** The bytes a seal is bound to: every field except the seal itself, in a fixed order. */
function sealBody(r: Omit<DevicePairing, 'seal'>): string {
  return `${SEAL_DOMAIN}\0${r.id}\0${r.tokenHash}\0${r.label}\0${r.createdAt}`;
}

function macOf(key: Buffer, r: Omit<DevicePairing, 'seal'>): string {
  return crypto.createHmac('sha256', key).update(sealBody(r)).digest('hex');
}

function sealRecord(key: Buffer, r: Omit<DevicePairing, 'seal'>): DevicePairing {
  return { ...r, seal: macOf(key, r) };
}

/** True only when the record's seal verifies under the data dir's key (else it is ignored). */
function verified(dir: string, r: DevicePairing): boolean {
  if (!r || typeof r !== 'object') return false;
  if (typeof r.seal !== 'string' || !/^[0-9a-f]{64}$/.test(r.seal)) return false;
  if (typeof r.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(r.tokenHash)) return false;
  const key = readSealKey(dir);
  if (!key) return false;
  const { seal, ...body } = r;
  const want = Buffer.from(macOf(key, body as Omit<DevicePairing, 'seal'>), 'hex');
  const got = Buffer.from(seal, 'hex');
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

/** Read the store. Returns `null` (never an empty list) when it is present but unreadable —
 * the caller must fail closed on a raise/validate rather than overwrite a store it can't read. */
function readStore(dir: string = dataDir()): DevicePairing[] | null {
  const res = readCapped(storeFile(dir), MAX_STORE_BYTES);
  if (res.kind === 'absent') return [];
  if (res.kind !== 'ok') return null;
  try {
    const parsed = JSON.parse(res.data);
    return Array.isArray(parsed) ? (parsed as DevicePairing[]) : null;
  } catch {
    return null;
  }
}

function writeStore(records: DevicePairing[], dir: string = dataDir()): void {
  ensureDir(dir);
  writeAtomic(storeFile(dir), JSON.stringify(records, null, 2));
}

function newId(): string {
  return `dp-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Enrol a new device. Generates a 256-bit token, stores ONLY its sha256 (sealed), and returns
 * the raw token ONCE. The caller (a localhost-user route) shows it to the user to carry to the
 * phone; it is never retrievable again.
 */
export function enrollPairing(label: string, dir: string = dataDir()): { id: string; label: string; token: string } | { error: string } {
  const records = readStore(dir);
  if (records === null) return { error: 'the device-pairing store is present but unreadable; refusing to overwrite it' };
  if (records.length >= MAX_PAIRINGS) return { error: `the device-pairing limit (${MAX_PAIRINGS}) is reached; revoke an old device before pairing a new one` };
  const key = ensureSealKey(dir).key;
  const token = crypto.randomBytes(32).toString('hex');
  const rec = sealRecord(key, {
    id: newId(),
    label: (label || 'device').slice(0, 120),
    tokenHash: sha256Hex(token),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  });
  writeStore([...records, rec], dir);
  return { id: rec.id, label: rec.label, token };
}

export function listPairings(dir: string = dataDir()): DevicePairingView[] {
  const records = readStore(dir);
  if (!records) return [];
  return records.filter((r) => verified(dir, r)).map((r) => ({ id: r.id, label: r.label, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt }));
}

export function revokePairing(id: string, dir: string = dataDir()): boolean {
  const records = readStore(dir);
  if (!records) return false;
  const kept = records.filter((r) => r.id !== id);
  if (kept.length === records.length) return false;
  writeStore(kept, dir);
  return true;
}

/**
 * Validate a presented token against the sealed store in constant time over the hash compare.
 * A record whose seal does not verify is ignored (an agent-injected record never validates).
 * On a match, best-effort stamps lastUsedAt. Returns the matched pairing id, else null.
 */
export function validatePairingToken(token: string | null | undefined, dir: string = dataDir()): string | null {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
  const records = readStore(dir);
  if (!records) return null;
  const presentedHash = Buffer.from(sha256Hex(token), 'hex');
  let matched: DevicePairing | null = null;
  for (const r of records) {
    if (!verified(dir, r)) continue;
    const stored = Buffer.from(r.tokenHash, 'hex');
    // timingSafeEqual needs equal length; both are sha256 so always 32 bytes.
    if (stored.length === presentedHash.length && crypto.timingSafeEqual(stored, presentedHash)) matched = r;
  }
  if (!matched) return null;
  try {
    matched.lastUsedAt = new Date().toISOString();
    writeStore(records, dir);
  } catch { /* best-effort stamp */ }
  return matched.id;
}
