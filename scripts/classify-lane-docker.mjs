#!/usr/bin/env node
/**
 * BUG-223 round 4 — the ONE-TIME classification of `settings.laneDocker` for projects
 * registered before the setting existed.
 *
 * Which Docker daemon a project's direct sessions and dispatched lanes reach is a
 * DECLARED per-project setting (ARCH-010), read by `laneDockerEnv()` and never derived at
 * spawn. A row with no value is undeclared, and the reader fails safe to the sandbox. This
 * script writes the initial value for every such row, by the same classification a new
 * project gets at registration (`classifyLaneDocker`: sandbox iff the project holds an
 * Orchard checkout, else host), and prints each project and value.
 *
 *   node scripts/classify-lane-docker.mjs            # classify undeclared rows, write
 *   node scripts/classify-lane-docker.mjs --dry-run  # print only
 *
 * Idempotent: a row that already declares a value is never touched (the user may have
 * flipped it). Before writing it copies the registry to
 * `<registry>.bak-bug223-<timestamp>`; restoring that file reverts the change. The
 * registry is re-read immediately before the write and only `settings.laneDocker` is set
 * on that fresh copy, so a concurrent edit by the live server is kept. Honours
 * CLAUDE_STATION_DATA (a scratch registry).
 */
import * as fs from 'node:fs';
import { registryFile, writeAtomic, projectRoot } from '../src/lib/paths.ts';
import { classifyLaneDocker, LANE_DOCKER_VALUES } from './lib/lane-docker.mjs';

const dry = process.argv.includes('--dry-run');
const file = registryFile();
const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));

let reg;
try { reg = read(); } catch (e) { console.error(`classify-lane-docker: cannot read ${file}: ${e.message}`); process.exit(2); }
if (!Array.isArray(reg?.projects)) { console.error(`classify-lane-docker: ${file} has no projects array`); process.exit(2); }

const checkouts = [projectRoot()];
const plan = new Map();
const rows = [];
for (const p of reg.projects) {
  const cur = p?.settings?.laneDocker;
  if (LANE_DOCKER_VALUES.includes(cur)) { rows.push([p.id, cur, 'kept', 'already declared']); continue; }
  const t0 = process.hrtime.bigint();
  const c = classifyLaneDocker(p.hostPath, { checkouts });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  plan.set(p.id, c.value);
  rows.push([p.id, c.value, dry ? 'would write' : 'written', `${c.reason} (${ms.toFixed(1)} ms)`]);
}

const w = [0, 0, 0].map((_, i) => Math.max(...rows.map((r) => r[i].length), ['project', 'laneDocker', 'action'][i].length));
const line = (r) => `${r[0].padEnd(w[0])}  ${r[1].padEnd(w[1])}  ${r[2].padEnd(w[2])}  ${r[3]}`;
console.log(`registry: ${file}`);
console.log(line(['project', 'laneDocker', 'action', 'reason']));
for (const r of rows) console.log(line(r));

if (dry || !plan.size) {
  console.log(dry ? `dry run: ${plan.size} row(s) would be declared; nothing written.` : 'every project already declares laneDocker; nothing written.');
  process.exit(0);
}
const backup = `${file}.bak-bug223-${new Date().toISOString().replace(/[:.]/g, '-')}`;
fs.copyFileSync(file, backup);
const fresh = read();
let n = 0;
for (const p of fresh.projects ?? []) {
  if (!plan.has(p.id) || LANE_DOCKER_VALUES.includes(p?.settings?.laneDocker)) continue;
  p.settings = { ...(p.settings ?? {}), laneDocker: plan.get(p.id) };
  n++;
}
writeAtomic(file, `${JSON.stringify(fresh, null, 2)}\n`);
console.log(`declared laneDocker on ${n} project(s). Backup: ${backup} (restore it to revert).`);
