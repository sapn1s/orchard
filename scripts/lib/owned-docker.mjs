/**
 * FEAT-158 round 2 — cleanup that removes only what THIS run's scratch server made.
 *
 * WHY. Many container suites start a scratch Orchard server and, in `finally`,
 * `docker rm -f claude-station-<slug>`. The slug comes from a fixed project name
 * (e.g. `CTest` → `claude-station-ctest`), so on a daemon where some other
 * Orchard instance owns a container of that name, the suite removed a container
 * it did not create (clean-room attacker, FEAT-158 round 2, reproduced on a
 * decoy host). Those suites cannot all move into the sandbox (GPU/CDI, host
 * /proc), so they stay runnable on the host and stop being able to remove
 * anything foreign instead.
 *
 * THE RULE is BUG-216's, from the one authority (`src/server/instance-owner.ts`):
 * an object is ours iff its `claude-station.owner` label equals the owner key of
 * OUR scratch data dir. Unlabelled or foreign objects are left alone and named.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const LABEL_OWNER = 'claude-station.owner';
export const LABEL_DF_DATA = 'claude-station.dockerfile-data';

/**
 * The owner key a server on `dataDir` stamps on everything it creates. ARCH-022: that key is the identity
 * DECLARED in the data dir (`orchard-instance.json`, written once); this declares it now if the dir has none yet
 * (the server then reads the same one). A tree without identities (a pinned pre-ARCH-022 snapshot) uses its old
 * path-derived key.
 */
export async function ownerKeyFor(dataDir) {
  const m = await import(path.join(REPO, 'src/server/instance-owner.ts'));
  if (typeof m.identityOf === 'function') {
    require_dir(dataDir);
    const id = m.identityOf(dataDir, { create: true });
    if (id) return id.id;
  }
  const prev = process.env.CLAUDE_STATION_DATA;
  process.env.CLAUDE_STATION_DATA = dataDir;
  try { return m.ownerKey(); } finally {
    if (prev === undefined) delete process.env.CLAUDE_STATION_DATA; else process.env.CLAUDE_STATION_DATA = prev;
  }
}
function require_dir(d) { try { fs.mkdirSync(d, { recursive: true }); } catch { /* the identity call reports it */ } }

function dk(args) {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000 });
  return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

/**
 * Remove container `name` only if its owner label is `ownerKey`. Removes by the
 * ID it inspected, so a same-named container swapped in meanwhile is not hit.
 * Returns 'removed' | 'absent' | 'not-ours'.
 */
export function removeOwnedContainer(name, ownerKey, { volumes = false } = {}) {
  if (!name) return 'absent';
  const ins = dk(['inspect', '--type', 'container', '--format', `{{.Id}}\t{{index .Config.Labels "${LABEL_OWNER}"}}`, name]);
  if (ins.code !== 0) return 'absent';
  const [id, owner] = ins.out.split('\t');
  if (!/^[0-9a-f]{16}$/.test(ownerKey ?? '') || owner !== ownerKey) { // a real owner key only (round 9: '<no value>' matched unlabelled)
    console.error(`  (left ${name} alone: owner label ${owner && owner !== '<no value>' ? owner : 'absent'} is not this run's ${ownerKey})`);
    return 'not-ours';
  }
  dk(['rm', '-f', ...(volumes ? ['-v'] : []), id]);
  return 'removed';
}

/** Remove images of `repo` (optionally also matching `labelFilters`) that carry this run's data label. */
export function removeOwnedImages(repo, ownerKey, labelFilters = []) {
  if (!ownerKey) return 0;
  const filters = ['--filter', `reference=${repo}`, '--filter', `label=${LABEL_DF_DATA}=${ownerKey}`, ...labelFilters.flatMap((l) => ['--filter', `label=${l}`])];
  const tags = dk(['images', ...filters, '--format', '{{.Repository}}:{{.Tag}}']).out.split('\n').filter((t) => t && !t.endsWith(':<none>'));
  for (const t of tags) dk(['image', 'rm', t]);
  return tags.length;
}

/** `image prune` restricted to this run's data label (plus `labelFilters`). */
export function pruneOwnedImages(ownerKey, labelFilters = []) {
  if (!ownerKey) return;
  dk(['image', 'prune', '-f', '--filter', `label=${LABEL_DF_DATA}=${ownerKey}`, ...labelFilters.flatMap((l) => ['--filter', `label=${l}`])]);
}

/**
 * FEAT-158 round 5 — call right after the project id is known, BEFORE the scratch server
 * creates or starts its container. The server treats an UNLABELLED same-named container as
 * its own (legacy adoption, `refuseForeign` in container-manager.ts), so a host-side suite on a
 * fixed project name would recreate or remove an older Orchard's container of that name
 * (clean-room attacker d, round 5). A fresh scratch data dir cannot have made one yet, so any
 * container already holding the name (or its `-next` rebuild name) is someone else's: stop.
 * Throws (not exit) so the suite's own `finally` still stops its scratch server.
 */
export function refuseTakenName(cname) {
  for (const n of [cname, `${cname}-next`]) {
    const ins = dk(['inspect', '--type', 'container', '--format', `{{.Id}}\t{{index .Config.Labels "${LABEL_OWNER}"}}`, n]);
    if (ins.code === 0) {
      const [id, owner] = ins.out.split('\t');
      throw new Error(`REFUSED: a container named ${n} (${id.slice(0, 12)}, owner ${owner && owner !== '<no value>' ? owner : 'unlabelled'}) already exists on this daemon and is not this run's. ` +
        'This suite would recreate or remove it. Run it in the sandbox (npm run sandbox:docker -- up) or on a daemon without that name.');
    }
  }
}
