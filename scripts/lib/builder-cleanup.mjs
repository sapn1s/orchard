/**
 * ARCH-020 — remove the per-project builders (containers + cache volumes) a
 * SCRATCH Orchard data dir created. Only builders labelled with that data dir's
 * key are touched, and the key is computed by the product's own `dataKey()`
 * (never re-derived here), so the live server's builders are out of reach.
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

export async function removeScratchBuilders(dataDir) {
  const pb = await import(path.join(ROOT, 'src/server/project-builder.ts'));
  const prev = process.env.CLAUDE_STATION_DATA;
  process.env.CLAUDE_STATION_DATA = dataDir;
  let key;
  try { key = pb.dataKey(); } finally { if (prev === undefined) delete process.env.CLAUDE_STATION_DATA; else process.env.CLAUDE_STATION_DATA = prev; }
  const d = (...a) => spawnSync('docker', a, { encoding: 'utf8', timeout: 120_000 });
  const removed = [];
  for (const l of d('ps', '-a', '--filter', `label=${pb.LABEL_BUILDER_DATA}=${key}`, '--format', '{{.ID}}\t{{.Names}}').stdout.split('\n').filter(Boolean)) {
    const [id, n = ''] = l.split('\t'); // FEAT-158: remove by the listed id, not by a name that can be re-used meanwhile
    if (n.startsWith(pb.BUILDER_NAME_PREFIX) && d('rm', '-f', id).status === 0) removed.push(n);
  }
  for (const n of d('volume', 'ls', '--filter', `label=${pb.LABEL_BUILDER_DATA}=${key}`, '--format', '{{.Name}}').stdout.split('\n').filter(Boolean)) {
    if (n.startsWith(pb.BUILDER_NAME_PREFIX) && d('volume', 'rm', '-f', n).status === 0) removed.push(`volume ${n}`);
  }
  return removed;
}
