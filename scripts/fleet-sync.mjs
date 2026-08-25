#!/usr/bin/env node
/**
 * fleet-sync.mjs — FEAT-044 follow-up #2: fleet board-tool re-sync sweep.
 *
 * Motivation (from FEAT-044's "Multi-consumer WA observations"): the ONLY
 * per-repo artifact `onboard.mjs` copies (rather than reads through at boot
 * time) is `scripts/board.mjs` — by design (see onboard.mjs's own header),
 * re-syncable via `--force-board-tool`. With N onboarded projects, "re-run
 * onboard --force-board-tool across registered projects" becomes worth
 * having as a sweep instead of a hand-kept list. This script is that sweep.
 *
 * Source of truth for "which projects": the live dashboard's project
 * registry, read via `GET /api/projects` on 127.0.0.1:4317 — READ-ONLY,
 * never writes any :4317 state. `--registry-file <path>` substitutes a JSON
 * fixture (either `{ projects: [...] }` or a bare array) for testing without
 * a running server.
 *
 * A project is swept only if it HAS `docs/bugs` on disk (i.e. it was
 * actually onboarded — a project that never ran onboard has no copied
 * board.mjs to drift, so it is reported `skip (not onboarded)`, not synced).
 *
 * Hands-off projects (declared via STATION_HANDS_OFF env or the gitignored
 * `.station-hands-off` file) are excluded BY DEFAULT — `--exclude <id>` adds
 * more exclusions on top; there is no flag to un-exclude a hands-off project.
 *
 * Dry-run by default (computes + reports what WOULD happen, writes nothing).
 * Pass --apply to actually run onboard's --force-board-tool re-sync.
 *
 * Usage:
 *   node scripts/fleet-sync.mjs [--apply] [--exclude <id>]... [--base <url>] [--registry-file <path>]
 *
 * Exit code: 0 always on a successful sweep (a stale/updated project is not
 * a failure — that's the sweep doing its job); non-zero only on a hard error
 * (can't reach the registry source at all).
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { onboard } from './onboard.mjs';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
/**
 * The copied per-repo tools this sweep keeps current. FEAT-056 added
 * arch-watch.mjs (the recurrence detector) on exactly the same terms as
 * board.mjs — copied by onboard, therefore able to drift, therefore swept here.
 * Kept in sync with onboard.mjs's COPIED_TOOLS.
 *
 * The two `lib/` modules are here because they were COPIED but never SWEPT:
 * onboard.mjs put verdict-contract.mjs into every repo and nothing ever
 * updated it again, so the copies were free to rot behind this repo's version
 * while the tools that import them were kept current — the worst combination.
 * ticket-schema.mjs is added with its sweep on day one rather than later.
 * scripts/verify-fleet-sync.mjs asserts SYNCED_TOOLS ⊇ COPIED_TOOLS so this
 * gap cannot reopen silently.
 */
/*
 * BUG-118 adds the response-format Stop hook to the sweep, for the same reason
 * verdict-contract.mjs was added: it was COPIED into every onboarded repo and
 * never swept, so a hook fix could not reach the copies where the bug lived.
 * It is the only METHOD_FILE eligible — see onboard.mjs's RESYNCABLE_HOOK for
 * why the rest of that list must never be overwritten in a target repo.
 *
 * ROUND 4: this sweep is no longer the only way the hook lands. A sweep is a
 * thing somebody has to remember to run, and the copies that mattered were in
 * projects nobody swept — so ordinary onboarding now re-syncs the hook too, and
 * the launcher repairs it at session start (claude-runtime.ts's
 * ensureCurrentStopHook). `forceHook` below is retained as a no-op alias; it is
 * kept in the call because dropping it would read as a deliberate opt-out.
 *
 * STILL SWEEP-ONLY, and still able to go stale in a target: board.mjs,
 * arch-watch.mjs and the two lib/ modules. Their staleness is LOUD (a human runs
 * them and reads the output), which is why they were not moved onto the
 * always-current path with the hook — see the BUG-118 round-4 note.
 */
const SYNCED_TOOLS = ['board.mjs', 'arch-watch.mjs', 'lib/verdict-contract.mjs', 'lib/ticket-schema.mjs', 'hooks/response-format-gate.mjs'];
const boardSourcePath = path.join(repoRoot, 'scripts', 'board.mjs');

export const DEFAULT_BASE = 'http://127.0.0.1:4317';
// Hands-off: projects the user has declared off-limits — never write into
// them from an automated sweep. Not overridable by CLI flag on purpose.
// Sources (merged): STATION_HANDS_OFF env (comma-separated ids) and the
// gitignored `.station-hands-off` file at the repo root (one id per line).
function readHandsOff() {
  const ids = (process.env.STATION_HANDS_OFF ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const f = path.join(repoRoot, '.station-hands-off');
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const id = line.trim();
      if (id && !id.startsWith('#')) ids.push(id);
    }
  }
  return [...new Set(ids)];
}
export const HANDS_OFF_DEFAULT_EXCLUDE = readHandsOff();

/** GET-only fetch of the project list; never mutates :4317 state. */
export async function fetchProjects({ base = DEFAULT_BASE, registryFile = null } = {}) {
  if (registryFile) {
    const data = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    return Array.isArray(data) ? data : (data.projects ?? []);
  }
  const res = await fetch(`${base}/api/projects`);
  if (!res.ok) throw new Error(`GET ${base}/api/projects failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.projects ?? [];
}

/** Decide, per project, whether it's in scope for the sweep — no I/O writes here. */
export function planSweep(projects, { exclude = new Set() } = {}) {
  const plan = [];
  for (const p of projects) {
    const id = p.id;
    const hostPath = p.hostPath;
    if (!hostPath) {
      plan.push({ id, hostPath: hostPath ?? null, action: 'skip', reason: 'no hostPath on registry entry' });
      continue;
    }
    if (exclude.has(id)) {
      plan.push({ id, hostPath, action: 'skip', reason: 'excluded (hands-off)' });
      continue;
    }
    const bugsDir = path.join(hostPath, 'docs', 'bugs');
    if (!fs.existsSync(bugsDir)) {
      plan.push({ id, hostPath, action: 'skip', reason: 'no docs/bugs (not onboarded)' });
      continue;
    }
    plan.push({ id, hostPath, action: 'sync' });
  }
  return plan;
}

/**
 * Execute (or, without `apply`, just PREDICT) the sweep. Dry-run reads the
 * target's copied board.mjs (if any) and compares bytes against this repo's
 * source, without writing anything. `apply` runs the real
 * `onboard(hostPath, { forceBoardTool: true })` core — the SAME idempotent
 * path the CLI/UI onboard action uses, so this sweep does not reimplement
 * the copy/compare logic a second time for the write path.
 */
export function runSweep(plan, { apply = false } = {}) {
  const sources = new Map(
    SYNCED_TOOLS.map((t) => [t, fs.readFileSync(path.join(repoRoot, 'scripts', t), 'utf8')]),
  );
  const results = [];
  for (const item of plan) {
    if (item.action === 'skip') {
      results.push({ ...item, outcome: 'skipped', detail: item.reason });
      continue;
    }
    if (!apply) {
      // Per-tool prediction; the project's headline outcome is the "worst"
      // state across the tools (a stale arch-watch is as much drift as a stale
      // board.mjs), with the per-tool detail kept for the report.
      const per = SYNCED_TOOLS.map((tool) => {
        const destPath = path.join(item.hostPath, 'scripts', tool);
        if (!fs.existsSync(destPath)) return { tool, outcome: 'would-create' };
        return {
          tool,
          outcome: fs.readFileSync(destPath, 'utf8') === sources.get(tool) ? 'identical' : 'would-update',
        };
      });
      const rank = { 'would-create': 2, 'would-update': 1, identical: 0 };
      const outcome = per.slice().sort((a, b) => rank[b.outcome] - rank[a.outcome])[0].outcome;
      results.push({
        ...item,
        outcome,
        tools: per,
        detail: `dry-run — no write (${per.map((p) => `${p.tool}: ${p.outcome}`).join(', ')})`,
      });
      continue;
    }
    const reports = onboard(item.hostPath, { forceBoardTool: true, forceHook: true });
    const per = SYNCED_TOOLS.map((tool) => ({
      tool,
      outcome: reports.find((r) => r.label === `scripts/${tool}`)?.status ?? 'unknown',
    }));
    const boardReport = reports.find((r) => r.label === 'scripts/board.mjs');
    results.push({
      ...item,
      outcome: boardReport ? boardReport.status : 'unknown',
      tools: per,
      detail: `applied (${per.map((p) => `${p.tool}: ${p.outcome}`).join(', ')})`,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { apply: false, exclude: new Set(HANDS_OFF_DEFAULT_EXCLUDE), base: DEFAULT_BASE, registryFile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--exclude') out.exclude.add(argv[++i]);
    else if (a === '--base') out.base = argv[++i];
    else if (a === '--registry-file') out.registryFile = argv[++i];
  }
  return out;
}

async function main() {
  const { apply, exclude, base, registryFile } = parseArgs(process.argv.slice(2));

  console.log(`fleet-sync — source: ${registryFile ? `file ${registryFile}` : `GET ${base}/api/projects (read-only)`}`);
  console.log(`  mode: ${apply ? 'APPLY (will write)' : 'DRY-RUN (no writes — pass --apply to write)'}`);
  console.log(`  excluded: [${[...exclude].join(', ')}]  (hands-off projects are excluded by default and cannot be un-excluded)`);
  console.log('');

  let projects;
  try {
    projects = await fetchProjects({ base, registryFile });
  } catch (e) {
    console.error(`fleet-sync: could not read project registry: ${e.message}`);
    process.exit(1);
  }

  const plan = planSweep(projects, { exclude });
  const results = runSweep(plan, { apply });

  for (const r of results) {
    const tag =
      r.outcome === 'skipped' ? 'SKIP   ' :
      r.outcome === 'identical' || r.outcome === 'exists (identical)' ? 'IDENT  ' :
      r.outcome === 'would-update' ? 'STALE  ' :
      r.outcome === 'would-create' ? 'MISSING' :
      r.outcome.startsWith('re-synced') ? 'UPDATED' :
      r.outcome.startsWith('created') ? 'UPDATED' :
      'REPORT ';
    console.log(`  ${tag}  ${String(r.id).padEnd(20)} ${r.outcome}${r.detail ? ` (${r.detail})` : ''}`);
  }

  const synced = results.filter((r) => r.action === 'sync').length;
  const skipped = results.length - synced;
  console.log(`\n${results.length} project(s) considered — ${synced} in scope, ${skipped} skipped.`);
  if (!apply && synced > 0) console.log('Dry-run only — re-run with --apply to actually re-sync.');
  process.exit(0);
}

const isMain = process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) main();
