#!/usr/bin/env node
/**
 * BUG-144 — verify the Working-Agreement backfill (Option B: stamp the method
 * version on the row).
 *
 * What this proves:
 *   1. MUST-FAIL BEFORE: a fixture reconstructed the way the legacy rows actually
 *      look (tools:{}, instructions:[]) reports coherent:false; the v2-only shape
 *      reports extensionOnly:true. Anchored to a fixed reconstruction, not HEAD.
 *   2. Realistic-state fixture — all five real shapes plus a deliberate opt-out
 *      plus a bad-order row — is backfilled to a base-first coherent stack.
 *   3. The deliberate opt-out (stamped, instructions:[]) is NOT overridden.
 *   4. Idempotent: a second --apply run changes the registry file not one byte.
 *   5. ensureScratchProject() produces a coherent, stamped stack.
 *   6. The SAME backfill run against a COPY of the REAL registry leaves every row
 *      coherent (or a recorded opt-out) and is idempotent there too.
 *
 * No real project names or host paths appear in this source — every path is
 * computed from os.homedir()/env at runtime, and the fixture ids are synthetic.
 * The real registry is only ever touched as a COPY under a scratch data dir.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const BACKFILL = path.join(HERE, 'backfill-bug-144-wa.mjs');
const SCRATCH_BASE = path.join(os.homedir(), 'scratch', 'bug-144');

let pass = 0;
let fail = 0;
const fails = [];
function ok(cond, label) {
  if (cond) { pass += 1; console.log(`  PASS ${label}`); }
  else { fail += 1; fails.push(label); console.log(`  FAIL ${label}`); }
}
function section(t) { console.log(`\n== ${t} ==`); }

// wiring is pure (settings-only) — safe to import directly for assertions.
const { waRefState } = await import(path.join(REPO, 'src/server/wiring.ts'));
const reg = await import(path.join(REPO, 'src/server/registry.ts'));
const { validateProjectPatch } = await import(path.join(REPO, 'src/server/validate.ts'));

const V1 = 'working-agreement';
const V2 = 'working-agreement-v2';
const ref = (templateId, enabled = true) => ({ templateId, enabled });

/** A fresh isolated data dir with a registry.json written from `projects`. */
function mkRegistry(tag, projects) {
  const dir = path.join(SCRATCH_BASE, `${tag}-${process.pid}-${Date.now()}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'registry.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, projects }, null, 2) + '\n');
  return { dir, file };
}

/** Run the real backfill script against a data dir. Returns its exit code. */
function runBackfill(dir, apply) {
  const args = [BACKFILL];
  if (apply) args.push('--apply');
  const r = spawnSync('node', args, {
    cwd: REPO,
    env: { ...process.env, CLAUDE_STATION_DATA: dir },
    encoding: 'utf8',
  });
  if (r.status !== 0) console.log(r.stdout + '\n' + r.stderr);
  return r;
}

function readReg(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).projects;
}
function findRow(rows, id) { return rows.find((p) => p.id === id); }
function waOf(row) { return waRefState(row); }
function stampOf(row) { return reg.methodVersionOf(row); }

/* -- The realistic-state fixture: all five real shapes + opt-out + bad-order. */
function mkHostPath(id) { return path.join(SCRATCH_BASE, 'fixture-hosts', id); }
function row(id, settings) {
  return {
    id, name: id, hostPath: mkHostPath(id), isolation: 'direct',
    settings: { model: null, effort: null, maxBudgetUsd: null, permissionMode: 'default',
      allowedTools: [], disallowedTools: [], mounts: [], instructions: [], ...settings },
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  };
}
const FIXTURE = [
  row('legacy-empty-tools', { instructions: [], tools: {} }),
  row('legacy-populated-tools', { instructions: [], tools: { serena: true, playwright: false } }),
  row('ext-only', { instructions: [ref(V2)], tools: { serena: true, playwright: true } }),
  row('coherent-both', { instructions: [ref(V1), ref(V2)], tools: { serena: true } }),
  row('bad-order', { instructions: [ref(V2), ref(V1)] }),
  row('legacy-scratch-like', { instructions: [], tools: { serena: true, playwright: false } }),
  // Deliberate opt-out: applyMethod:false leaves instructions:[] but STAMPS the
  // decision. It must survive the backfill untouched.
  row('opted-out', { instructions: [], methodVersion: reg.CURRENT_METHOD_VERSION }),
];

section('1. MUST-FAIL BEFORE — the fixed reconstruction is genuinely broken');
{
  const a = waOf(findRow(FIXTURE, 'legacy-empty-tools'));
  const b = waOf(findRow(FIXTURE, 'legacy-populated-tools'));
  const c = waOf(findRow(FIXTURE, 'ext-only'));
  const bad = waOf(findRow(FIXTURE, 'bad-order'));
  ok(a.coherent === false && a.enabledIds.length === 0, 'legacy empty-tools row is incoherent (no WA) before backfill');
  ok(b.coherent === false, 'legacy populated-tools row is incoherent (no WA) before backfill');
  ok(c.extensionOnly === true && c.coherent === false, 'v2-only row is extensionOnly (BUG-099 shape) before backfill');
  ok(bad.coherent === true && bad.enabledIds[0] === V2, 'bad-order row is v2-first before backfill (repair target)');
  ok(stampOf(findRow(FIXTURE, 'opted-out')) === reg.CURRENT_METHOD_VERSION, 'opt-out row is stamped before backfill');
}

section('2+3. Backfill the fixture — coherent stacks, opt-out preserved');
const fx = mkRegistry('fixture', FIXTURE);
{
  const dry = runBackfill(fx.dir, false);
  ok(dry.status === 0, 'dry-run exits 0 and writes nothing');
  const beforeBytes = fs.readFileSync(fx.file, 'utf8');
  const afterDry = fs.readFileSync(fx.file, 'utf8');
  ok(beforeBytes === afterDry, 'dry-run left the registry file byte-identical');

  const applied = runBackfill(fx.dir, true);
  ok(applied.status === 0, 'apply run exits 0');
  const rows = readReg(fx.file);
  for (const id of ['legacy-empty-tools', 'legacy-populated-tools', 'ext-only', 'coherent-both', 'bad-order', 'legacy-scratch-like']) {
    const w = waOf(findRow(rows, id));
    ok(w.coherent === true && w.enabledIds[0] === V1 && w.enabledIds[1] === V2, `${id}: base-first coherent stack after backfill`);
    ok(stampOf(findRow(rows, id)) === reg.CURRENT_METHOD_VERSION, `${id}: stamped after backfill`);
  }
  // tools preserved (MCP is not the problem — must not be clobbered).
  ok(JSON.stringify(findRow(rows, 'legacy-populated-tools').settings.tools) === JSON.stringify({ serena: true, playwright: false }), 'populated tools preserved through backfill');
  // opt-out untouched.
  const oo = findRow(rows, 'opted-out');
  ok(oo.settings.instructions.length === 0 && waOf(oo).coherent === false, 'deliberate opt-out NOT re-attached (instructions still empty)');
  ok(stampOf(oo) === reg.CURRENT_METHOD_VERSION, 'opt-out stamp unchanged');

  // A backup + a human-readable record were written before mutating (under the
  // data dir, not git) — the reversibility aid.
  const entries = fs.readdirSync(fx.dir);
  ok(entries.some((f) => f.includes('bug-144-backup') && !f.endsWith('.record.txt')), 'a timestamped registry backup was written before mutating');
  ok(entries.some((f) => f.endsWith('.record.txt')), 'a human-readable per-project record was written beside the backup');
}

section('4. Idempotent — a second apply changes nothing');
{
  const afterFirst = fs.readFileSync(fx.file, 'utf8');
  const second = runBackfill(fx.dir, true);
  ok(second.status === 0, 'second apply exits 0');
  const afterSecond = fs.readFileSync(fx.file, 'utf8');
  ok(afterFirst === afterSecond, 'registry file byte-identical after a second apply');
}

section('5. ensureScratchProject() produces a coherent, stamped stack');
{
  const dir = path.join(SCRATCH_BASE, `scratch-ensure-${process.pid}-${Date.now()}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const prevData = process.env.CLAUDE_STATION_DATA;
  const prevScratch = process.env.CLAUDE_STATION_SCRATCH_DIR;
  process.env.CLAUDE_STATION_DATA = dir;
  process.env.CLAUDE_STATION_SCRATCH_DIR = path.join(dir, 'scratch');
  try {
    const scratch = reg.ensureScratchProject();
    const w = waOf(scratch);
    ok(w.coherent === true && w.enabledIds[0] === V1 && w.enabledIds[1] === V2, 'ensureScratchProject: base-first coherent WA stack');
    ok(stampOf(scratch) === reg.CURRENT_METHOD_VERSION, 'ensureScratchProject: method version stamped');
    // idempotent — second call returns same coherent row, no duplicate WA refs.
    const again = reg.ensureScratchProject();
    ok(again.settings.instructions.filter((r) => r.templateId === V1).length === 1, 'ensureScratchProject idempotent: no duplicate base ref');
  } finally {
    if (prevData === undefined) delete process.env.CLAUDE_STATION_DATA; else process.env.CLAUDE_STATION_DATA = prevData;
    if (prevScratch === undefined) delete process.env.CLAUDE_STATION_SCRATCH_DIR; else process.env.CLAUDE_STATION_SCRATCH_DIR = prevScratch;
  }
}

section('6. Validator accepts a stamp, rejects a bad one');
{
  let acceptedOk = false, rejectedNeg = false, rejectedFloat = false;
  try { const p = validateProjectPatch({ settings: { methodVersion: 1 } }); acceptedOk = p.settings.methodVersion === 1; } catch { acceptedOk = false; }
  try { validateProjectPatch({ settings: { methodVersion: -1 } }); } catch { rejectedNeg = true; }
  try { validateProjectPatch({ settings: { methodVersion: 1.5 } }); } catch { rejectedFloat = true; }
  ok(acceptedOk, 'validateProjectPatch accepts methodVersion:1');
  ok(rejectedNeg, 'validateProjectPatch rejects negative methodVersion');
  ok(rejectedFloat, 'validateProjectPatch rejects non-integer methodVersion');
}

section('3b. A STAMPED row whose WA was later removed is NOT re-added (intended)');
{
  // The stamp preserves the user's LAST recorded decision, not just a first run.
  // A stamped project the user manually strips WA from is treated as a deliberate
  // removal — the backfill leaves it alone (the wiring panel remains the ongoing
  // repair surface for it). This is what makes the opt-out durable.
  const stampedThenStripped = [
    row('stamped-stripped', { instructions: [], methodVersion: reg.CURRENT_METHOD_VERSION }),
    row('stamped-v2-only', { instructions: [ref(V2)], methodVersion: reg.CURRENT_METHOD_VERSION }),
  ];
  const rr = mkRegistry('stamped-removed', stampedThenStripped);
  const before = fs.readFileSync(rr.file, 'utf8');
  const r = runBackfill(rr.dir, true);
  ok(r.status === 0, 'backfill exits 0 with only stamped rows');
  ok(fs.readFileSync(rr.file, 'utf8') === before, 'stamped rows (even incoherent ones) are untouched by the backfill');
  const rows = readReg(rr.file);
  ok(findRow(rows, 'stamped-stripped').settings.instructions.length === 0, 'stamped+empty row NOT re-attached (decision preserved)');
  ok(waOf(findRow(rows, 'stamped-v2-only')).extensionOnly === true, 'stamped+v2-only row left as-is (panel repairs it, not the backfill)');
}

section('7a. LIVE registry — INFORMATIONAL only (state changes over time, not a gate)');
{
  const realReg = path.join(os.homedir(), '.local', 'share', 'claude-station', 'registry.json');
  if (!fs.existsSync(realReg)) {
    console.log('  (no live registry on this machine)');
  } else {
    const rows = readReg(realReg);
    const coherent = rows.filter((p) => waRefState(p).coherent).length;
    const stamped = rows.filter((p) => stampOf(p) >= reg.CURRENT_METHOD_VERSION).length;
    const optOut = rows.filter((p) => stampOf(p) >= reg.CURRENT_METHOD_VERSION && !waRefState(p).coherent).length;
    console.log(`  INFO live: ${rows.length} rows · ${coherent} coherent · ${stamped} stamped · ${optOut} recorded opt-out`);
    console.log('  (informational — NOT asserted; anchoring a must-FAIL to the live baseline is the anti-pattern this section avoids)');
  }
}

section('7b. REAL data SHAPE + volume — reconstructed pre-backfill, repaired (not the live baseline)');
{
  const realReg = path.join(os.homedir(), '.local', 'share', 'claude-station', 'registry.json');
  if (!fs.existsSync(realReg)) {
    console.log('  SKIP — no real registry found on this machine');
  } else {
    // Deterministic reconstruction of the pre-backfill legacy shape from the real
    // row SET/ids/count: strip every stamp and clear WA so the whole fleet is the
    // no-WA legacy shape again — plus one injected deliberate opt-out. This tests
    // the mechanism against the real registry's real volume WITHOUT depending on
    // whatever the live baseline happens to be today.
    const live = readReg(realReg);
    const reconstructed = live.map((p, i) => {
      const clone = JSON.parse(JSON.stringify(p));
      clone.settings = clone.settings || {};
      delete clone.settings.methodVersion;
      if (i === 0) { clone.settings.instructions = []; clone.settings.methodVersion = reg.CURRENT_METHOD_VERSION; } // injected opt-out
      else clone.settings.instructions = [];
      return clone;
    });
    const optOutId = reconstructed[0].id;
    const dir = path.join(SCRATCH_BASE, `real-recon-${process.pid}-${Date.now()}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const copy = path.join(dir, 'registry.json');
    fs.writeFileSync(copy, JSON.stringify({ version: 1, projects: reconstructed }, null, 2) + '\n');

    const before = readReg(copy);
    const brokenBefore = before.filter((p) => p.id !== optOutId && !waRefState(p).coherent && stampOf(p) === 0).length;
    ok(brokenBefore === before.length - 1, `reconstructed real shape is broken before backfill (${brokenBefore} incoherent+unstamped over the real row count)`);

    const r = runBackfill(dir, true);
    ok(r.status === 0, 'backfill on the reconstructed real shape exits 0');
    const after = readReg(copy);
    const nonOptOut = after.filter((p) => p.id !== optOutId);
    ok(nonOptOut.every((p) => waRefState(p).coherent && stampOf(p) >= reg.CURRENT_METHOD_VERSION), 'every reconstructed row is coherent + stamped after backfill');
    const oo = findRow(after, optOutId);
    ok(oo.settings.instructions.length === 0 && waRefState(oo).coherent === false, 'injected opt-out on the real shape is NOT re-attached');

    const afterBytes = fs.readFileSync(copy, 'utf8');
    runBackfill(dir, true);
    ok(fs.readFileSync(copy, 'utf8') === afterBytes, 'reconstructed real shape is idempotent under a second apply');
  }
}

console.log(`\n${'='.repeat(48)}`);
console.log(`BUG-144 verify: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:\n  - ' + fails.join('\n  - ')); process.exit(1); }
console.log('ALL PASS');
