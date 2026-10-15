/**
 * FEAT-164 option A (user decision 2026-10-12), part S1 — the SEALED standing grant.
 *
 * `settings.gitWrite` lives in registry.json, which any same-uid process can edit. Before
 * this, an agent session could write `{ permanent: true }` (or copy one project's grant
 * onto another, or touch a field of a user grant) and get a live grant. Now the ONE writer
 * (registry.setGitWritePolicy) stamps an HMAC over (projectId, value) with a key kept in
 * its own 0600 file in the data dir, and every reader passes the stored value through
 * `verifiedGitWrite` first: a missing, wrong or copied seal reads as NO grant (fail closed).
 *
 * Residuals this does NOT close (named on the decision card, same class as ARCH-021's host
 * residual): a same-uid process that deliberately reads the key file can forge a seal, and
 * replaying a previously sealed value for the same project after a revoke still verifies.
 * The point is that the casual paths (edit the JSON, copy a row) no longer grant.
 *
 * MIGRATION: grants written before sealing existed are sealed once, at the moment the key
 * is first created (`sealLegacyOnKeyCreation`), so a user's existing grant keeps working
 * across the upgrade. Once the key exists, an unsealed value never grants.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { grantBindingOf } from './repo-identity.mjs';

const KEY_FILE = 'git-write-seal.key';
const DOMAIN = 'orchard-feat164-gitwrite-seal-v1';

export function sealKeyPath(dataDir) { return path.join(dataDir, KEY_FILE); }

/** The key, or null if it does not exist / is unreadable / malformed. Never creates it. */
export function readSealKey(dataDir) {
  try {
    const hex = fs.readFileSync(sealKeyPath(dataDir), 'utf8').trim();
    return /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : null;
  } catch { return null; }
}

/** Create the key if absent. Returns { key, created }. Exclusive create: a concurrent
 * creator loses the race and reads the winner's key. */
export function ensureSealKey(dataDir) {
  const existing = readSealKey(dataDir);
  if (existing) return { key: existing, created: false };
  fs.mkdirSync(dataDir, { recursive: true });
  try {
    fs.writeFileSync(sealKeyPath(dataDir), crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  }
  const key = readSealKey(dataDir);
  if (!key) throw new Error(`git-write seal key at ${sealKeyPath(dataDir)} is unreadable or malformed`);
  return { key, created: true };
}

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * What a seal is bound to: the project's id AND its hostPath (the repo the grant is FOR).
 * Binding the id alone let an agent keep a user's sealed grant and repoint the row's
 * unsealed hostPath at any repo (independent verify 9bd8c5d3). A legitimate relocation
 * therefore drops the grant (fail closed; the user re-grants). `project` is a registry
 * row ({ id, hostPath }); a bare id string binds an empty hostPath.
 */
function bindingOf(project) {
  if (typeof project === 'string') return `${project}\0`;
  return `${String(project?.id ?? '')}\0${String(project?.hostPath ?? '')}`;
}

function mac(key, project, value) {
  const { seal: _drop, ...body } = value;
  return crypto.createHmac('sha256', key).update(`${DOMAIN}\0${bindingOf(project)}\0${canonical(body)}`).digest('hex');
}

/** Return `value` with its seal (any old seal replaced), bound to `project` ({ id, hostPath }). */
export function sealGitWrite(key, project, value) {
  const { seal: _drop, ...body } = value;
  return { ...body, seal: mac(key, project, body) };
}

/**
 * THE check every reader applies before normalising. Returns the stored value when its
 * seal is valid for THIS project (id + hostPath) under the data dir's key, else null (= no grant).
 * `null`/absent passes through as null.
 */
export function verifiedGitWrite(dataDir, project, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.seal !== 'string' || !/^[0-9a-f]{64}$/.test(raw.seal)) return null;
  const key = readSealKey(dataDir);
  if (!key) return null;
  const want = Buffer.from(mac(key, project, raw), 'hex');
  const got = Buffer.from(raw.seal, 'hex');
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? raw : null;
}

/**
 * One-time migration at key creation. `projects` is the registry's project array; returns
 * the ids whose unsealed gitWrite was sealed in place (the caller persists the registry).
 * Does nothing when the key already existed.
 */
export function sealLegacyOnKeyCreation(dataDir, projects) {
  const { key, created } = ensureSealKey(dataDir);
  if (!created) return [];
  const sealed = [];
  for (const p of Array.isArray(projects) ? projects : []) {
    const gw = p?.settings?.gitWrite;
    if (!gw || typeof gw !== 'object' || Array.isArray(gw)) continue;
    // Bind the pre-existing grant to the repo its project points at NOW (the grant binding).
    const bound = gw.repo && typeof gw.repo === 'object' ? gw : { ...gw, repo: grantBindingOf(p.hostPath) };
    p.settings.gitWrite = sealGitWrite(key, p, bound);
    sealed.push(p.id);
  }
  return sealed;
}
