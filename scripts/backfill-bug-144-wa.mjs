#!/usr/bin/env node
/**
 * BUG-144 — backfill the coherent Working-Agreement stack onto projects created
 * before the FEAT-089 auto-attach, and stamp the method decision so a re-run is
 * a no-op and a deliberate opt-out is never overridden.
 *
 * Option B (see the ticket): a project row carries `settings.methodVersion`
 * (`methodVersionOf`). 0/absent = the decision was never recorded (predates the
 * auto-attach) → a backfill candidate. Any positive stamp = the decision was
 * made (applied OR declined) → left untouched. So:
 *   - un-backfilled legacy rows        → get the coherent stack + a stamp
 *   - already-coherent legacy rows     → keep their stack, just get a stamp
 *   - a deliberate opt-out (stamped)   → skipped entirely (instructions: [] kept)
 *
 * The mutation is the SINGLE shared source `coherentWaStack()` (wiring.ts) routed
 * through the one validation dialect `validateProjectPatch()` — never a
 * hand-rolled registry write. Idempotent by construction: the second run sees
 * every row stamped and changes nothing.
 *
 * SAFETY: dry-run by default. `--apply` mutates. Before any mutation it writes a
 * timestamped backup beside the registry AND a human-readable per-project record
 * (which DOES name projects) next to that backup — both live under the data dir,
 * NOT in git. Respects CLAUDE_STATION_DATA, so it runs against a scratch registry
 * exactly the way it runs against the real one.
 */
import fs from 'node:fs';
import path from 'node:path';

import { registryFile } from '../src/lib/paths.ts';
import * as reg from '../src/server/registry.ts';
import { coherentWaStack, waRefState } from '../src/server/wiring.ts';
import { validateProjectPatch } from '../src/server/validate.ts';

const APPLY = process.argv.includes('--apply');
const file = registryFile();

if (!fs.existsSync(file)) {
  console.error(`no registry at ${file} (set CLAUDE_STATION_DATA?)`);
  process.exit(2);
}

const projects = reg.listProjects();
const plan = [];
for (const p of projects) {
  const stamp = reg.methodVersionOf(p);
  const before = waRefState(p);
  if (stamp >= reg.CURRENT_METHOD_VERSION) {
    plan.push({ id: p.id, action: 'skip-stamped', stamp, before });
    continue;
  }
  // Every un-stamped row runs through coherentWaStack — it is idempotent on an
  // already-base-first stack and ALSO repairs a v2-then-v1 ordering that
  // waRefState still calls "coherent" (hasBase) but injects in the wrong order
  // (BUG-099). The action label is only for the report.
  const action = before.extensionOnly ? 'repair-extensionOnly'
    : !before.coherent ? 'attach-wa'
    : before.enabledIds[0] !== 'working-agreement' ? 'repair-order'
    : 'stamp+normalize';
  plan.push({ id: p.id, action, stamp, before });
}

const willChange = plan.filter((e) => e.action !== 'skip-stamped');
console.log(`registry: ${file}`);
console.log(`${projects.length} projects · ${willChange.length} to change · ${plan.length - willChange.length} already stamped\n`);
for (const e of plan) {
  const b = e.before;
  console.log(
    `[${e.action.padEnd(20)}] idx-by-id=${e.id.padEnd(24)} stamp=${e.stamp} ` +
    `waBefore=[${b.enabledIds.join(',')}] coherent=${b.coherent} extOnly=${b.extensionOnly}`,
  );
}

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to mutate (a backup is taken first).');
  process.exit(0);
}

if (willChange.length === 0) {
  // Nothing to do — every row already has its decision stamped. Don't take a
  // backup or write; a true no-op keeps the backfill idempotent without spam.
  console.log('\nNothing to change — every row is already stamped. No backup taken, no write.');
  process.exit(0);
}

// Backup the registry + a human-readable record BEFORE mutating. Both under the
// data dir (not git). The record names projects on purpose — it is the reversal
// aid — which is why it lives here and not in any tracked file.
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const backup = `${file}.bug-144-backup-${ts}`;
fs.copyFileSync(file, backup);
const recordLines = [
  `BUG-144 backfill — ${new Date().toISOString()}`,
  `registry: ${file}`,
  `backup:   ${backup}`,
  '',
];
for (const e of plan) {
  const p = reg.getProject(e.id);
  recordLines.push(`${e.action}\t${e.id}\t${p?.name ?? ''}\t${p?.hostPath ?? ''}\twaBefore=[${e.before.enabledIds.join(',')}]`);
}
const recordFile = `${backup}.record.txt`;
fs.writeFileSync(recordFile, recordLines.join('\n') + '\n');
console.log(`\nbackup:  ${backup}`);
console.log(`record:  ${recordFile}\n`);

let changed = 0;
for (const e of plan) {
  if (e.action === 'skip-stamped') continue;
  const p = reg.getProject(e.id);
  if (!p) continue;
  const settings = { methodVersion: reg.CURRENT_METHOD_VERSION, instructions: coherentWaStack(p) };
  const patch = validateProjectPatch({ settings });
  const after = reg.updateProject(e.id, patch);
  const wa = waRefState(after);
  console.log(`applied [${e.action}] ${e.id} → wa=[${wa.enabledIds.join(',')}] coherent=${wa.coherent} stamp=${reg.methodVersionOf(after)}`);
  changed += 1;
}
console.log(`\ndone — ${changed} rows changed.`);
