#!/usr/bin/env node
/**
 * ARCH-022 / BUG-219 — DECLARE which Orchard data dir is the LIVE instance (the one that may adopt Docker objects
 * created before owner labels existed). The declaration is a marker file written INTO the data dir and bound to
 * that directory's inode: a copy of the directory, or another directory at the same path in another namespace,
 * is not declared. Nothing writes it implicitly — this command is the user's declaration.
 *
 *   node scripts/orchard-live-instance.mjs status            # what this data dir is, and whether it is declared
 *   node scripts/orchard-live-instance.mjs declare           # declare it live (then restart Orchard)
 *   node scripts/orchard-live-instance.mjs revoke            # withdraw the declaration (then restart Orchard)
 *   node scripts/orchard-live-instance.mjs rebind            # REPAIR: this dir IS the instance its identity names (moved disk /
 *                                                            # restored / filesystem changed) — rebind identity + marker here
 *   node scripts/orchard-live-instance.mjs reidentify        # REPAIR: this dir is a COPY — fresh identity, no legacy ownership
 *
 * The data dir is the server's: `CLAUDE_STATION_DATA` if set, else the default (~/.local/share/claude-station).
 * `--data-dir <dir>` names another one explicitly.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const io = await import(path.join(REPO, 'src/server/instance-owner.ts'));
const { dataDir } = await import(path.join(REPO, 'src/lib/paths.ts'));

const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith('-')) ?? 'status';
const di = args.indexOf('--data-dir');
const dir = path.resolve(di >= 0 ? args[di + 1] : dataDir());

function describe() {
  const st = (() => { try { return fs.statSync(dir); } catch { return null; } })();
  let id = null; let idError = null;
  try { id = io.identityOf(dir); } catch (e) { idError = e.message; }
  const marker = io.liveMarkerOf(dir);
  return {
    dataDir: dir,
    exists: !!st?.isDirectory(),
    identity: idError ? { MISMATCH: idError } : id ? { id: id.id, createdAt: id.createdAt, ownsPreIdentityObjects: !!id.legacyKey, place: { ino: id.ino, fs: id.fs } } : '(none yet: written at the next server boot)',
    declaredLive: marker ? { declaredAt: marker.declaredAt, by: marker.declaredBy } : false,
    accountDefault: io.isAccountDefaultDataDir(dir),
  };
}

if (cmd === 'status') {
  console.log(JSON.stringify(describe(), null, 2));
  process.exit(0);
}
if (cmd === 'declare') {
  const st = (() => { try { return fs.statSync(dir); } catch { return null; } })();
  if (!st?.isDirectory()) { console.error(`refusing: ${dir} is not a directory (is this the data dir your Orchard server uses?)`); process.exit(2); }
  const place = io.placeOf(dir);
  const marker = { schema: 2, ino: place.ino, fs: place.fs, dev: place.dev, declaredAt: new Date().toISOString(), declaredBy: `${os.userInfo().username} via scripts/orchard-live-instance.mjs` };
  const file = path.join(dir, io.LIVE_MARKER_FILE);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  console.log(`declared ${dir} the LIVE Orchard instance (${file}). Restart Orchard for it to take effect.`);
  console.log(JSON.stringify(describe(), null, 2));
  process.exit(0);
}
if (cmd === 'revoke') {
  try { fs.unlinkSync(path.join(dir, io.LIVE_MARKER_FILE)); console.log(`withdrew the live declaration of ${dir}. Restart Orchard for it to take effect.`); }
  catch (e) { console.log(`no declaration to withdraw in ${dir} (${e.code ?? e.message})`); }
  process.exit(0);
}
if (cmd === 'rebind' || cmd === 'reidentify') {
  try {
    const id = cmd === 'rebind' ? io.rebindIdentity(dir) : io.reidentify(dir);
    console.log(cmd === 'rebind'
      ? `rebound ${dir}: it keeps identity ${id.id}${id.legacyKey ? ' and its pre-identity objects' : ''} at its new place. Restart Orchard.`
      : `${dir} is now a SEPARATE instance ${id.id} (no legacy ownership, not declared live). Restart Orchard.`);
    console.log(JSON.stringify(describe(), null, 2));
    process.exit(0);
  } catch (e) { console.error(`refusing: ${e.message}`); process.exit(2); }
}
console.error('usage: node scripts/orchard-live-instance.mjs status|declare|revoke|rebind|reidentify [--data-dir <dir>]');
process.exit(2);
