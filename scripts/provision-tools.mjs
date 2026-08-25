#!/usr/bin/env node
/**
 * BUG-107 / BUG-108 — provision the pinned dev tooling for HOST
 * (isolation: "direct") sessions. Container isolation needs nothing here: its
 * tooling is baked into the image at build time.
 *
 *   node scripts/provision-tools.mjs            # status only, changes nothing
 *   node scripts/provision-tools.mjs --install  # install/update every pin
 *   node scripts/provision-tools.mjs --force    # reinstall even if current
 *
 * This is the ONLY thing in the repo that fetches these tools, and it only runs
 * when a human runs it. A session never does. Until the MCP panel grows its
 * Provision/Update buttons (FEAT follow-up), this is that button.
 */
import { hostProvisionStates, provisionAllHost, manifestTools } from '../src/server/provisioning.ts';

const argv = process.argv.slice(2);
const install = argv.includes('--install') || argv.includes('--force');
const force = argv.includes('--force');

for (const { name, pin } of manifestTools()) {
  console.log(`${name} pin      : ${pin.package}@${pin.version}  (source ${pin.source ?? '?'}, publisher ${pin.publisher ?? '?'}, installer ${pin.installer})`);
}
console.log('');
// Verify against the artifact, not just the record: the status a human reads
// here must reflect what actually runs (a drifted/partial install shows as
// stale/missing), not a remembered claim. This is a human-run, low-frequency
// path, so the ~1s of `--version` probes is well spent (see provisioning.ts).
const states = hostProvisionStates({ verify: true });
for (const st of states) {
  console.log(`${st.tool.padEnd(12)}: ${st.state}${st.installedVersion ? ` (${st.installedVersion})` : ''}${st.verifiedVersion ? ` [verified ${st.verifiedVersion}]` : ''}  bin=${st.bin}`);
  console.log(`              ${st.detail}`);
}

if (!install) {
  const anyMissing = states.some((s) => s.state !== 'provisioned');
  if (anyMissing) {
    console.log('\nNothing was fetched. Re-run with --install to provision (a deliberate, one-time download).');
    process.exit(1);
  }
  process.exit(0);
}

try {
  const results = await provisionAllHost({ force, onLog: (s) => process.stdout.write(String(s)) });
  console.log('');
  let ok = true;
  for (const r of results) {
    console.log(`${r.changed ? 'PROVISIONED' : 'no change'}: ${r.reason} -> state=${r.status.state} installed=${r.status.installedVersion} bin=${r.status.bin}`);
    if (r.status.state !== 'provisioned') ok = false;
  }
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.error(`\nPROVISION FAILED: ${err?.message ?? err}`);
  process.exit(1);
}
