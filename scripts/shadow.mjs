#!/usr/bin/env node
/**
 * shadow.mjs — FEAT-170 shadow-repo pilot. Agents get their own git repo per ticket;
 * the shared working tree changes only through an explicit `land`; the real repo
 * changes only through the user's `candidate.mjs commit`.
 *
 *   node scripts/shadow.mjs lane-new <T> [--repo P] [--deps node_modules]   make the ticket's lane (fresh base)
 *   node scripts/shadow.mjs run <T> [--repo P] -- <git args>                 git in the lane (commit, reset, branch, rebase, …)
 *   node scripts/shadow.mjs status <T> [--repo P]                            lane state
 *   node scripts/shadow.mjs sync <T> [--repo P]                              merge the current shared tree into the lane
 *   node scripts/shadow.mjs land <T> [--repo P] [--allow-revert F]...        land the lane's commits (refuses overlaps; exit 3)
 *   node scripts/shadow.mjs unland <T> [--repo P]                            UNDO the last landing (all-or-nothing)
 *   node scripts/shadow.mjs freeze <T> [--repo P] [--check CMD]... [--accept-foreign F]... [--depends-on T2,...]
 *                                                                            FEAT-170 candidate of exactly the landed bytes
 *   node scripts/shadow.mjs recover [--repo P]                               undo a landing interrupted by a crash
 *   node scripts/shadow.mjs list|inventory [--repo P]                        lanes; landed-but-uncommitted work
 *   node scripts/shadow.mjs drop <T> [--repo P] [--force]                    delete a lane (refuses unlanded work)
 *   node scripts/shadow.mjs metrics [--repo P] [--days 28] [--json]          pilot metrics
 *   node scripts/shadow.mjs incident <T> --kind silent-loss|foreign-edit|other [--note …]
 *   node scripts/shadow.mjs retire [--repo P]                                archive this project's records (refuses unpromoted landings)
 *
 * The user's commands: promote = `node <orchard>/scripts/candidate.mjs commit <T> --repo <project>`;
 * undo a landing = `node <orchard>/scripts/shadow.mjs unland <T> --repo <project>`.
 * Exit codes: 0 ok · 1 error · 2 usage / unavailable here · 3 refused (overlap, changed) · 4 retry (busy, race, interrupted).
 */
import { spawnSync } from 'node:child_process';
import * as SV from './lib/shadow-vcs.mjs';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const head = sep === -1 ? argv : argv.slice(0, sep);
const tail = sep === -1 ? [] : argv.slice(sep + 1);
const verb = head[0];
const opts = { repo: process.cwd(), multi: {}, flags: new Set(), pos: [] };
const MULTI = new Set(['--deps', '--allow-revert', '--check', '--accept-foreign', '--depends-on']);
for (let i = 1; i < head.length; i++) {
  const a = head[i];
  if (a === '--repo') opts.repo = head[++i];
  else if (a === '--days') opts.days = Number(head[++i]);
  else if (a === '--kind') opts.kind = head[++i];
  else if (a === '--note') opts.note = head[++i];
  else if (MULTI.has(a)) { const v = head[++i]; (opts.multi[a] ??= []).push(...(a === '--depends-on' ? String(v).split(',') : [v])); }
  else if (a === '--json' || a === '--force') opts.flags.add(a);
  else if (a.startsWith('--')) usage(`unknown option ${a}`);
  else opts.pos.push(a);
}
function usage(m) { if (m) console.error(`shadow: ${m}`); console.error('usage: node scripts/shadow.mjs <lane-new|run|status|sync|land|unland|freeze|recover|list|inventory|drop|metrics|incident|retire> [<TICKET>] [--repo DIR] … (see the header of scripts/shadow.mjs)'); process.exit(2); }
if (!verb || verb === '-h' || verb === '--help' || verb === 'help') usage();
const id = opts.pos[0];
const needId = () => { if (!id) usage(`${verb} needs a ticket id`); return id; };
const out = (o) => { if (opts.flags.has('--json')) console.log(JSON.stringify(o, null, 2)); return o; };

const READ_ONLY = new Set(['metrics', 'list', 'inventory', 'status']);
if (!READ_ONLY.has(verb)) {
  const refusal = SV.environmentRefusal();
  if (refusal) { console.error(`shadow: ${refusal}`); process.exit(2); }
}

try {
  switch (verb) {
    case 'lane-new': {
      const r = out(SV.laneNew({ repo: opts.repo, id: needId(), deps: opts.multi['--deps'] ?? [] }));
      if (!opts.flags.has('--json')) {
        console.log(`lane ${id}: ${r.laneDir}`);
        console.log(`  seeded from the shared tree now: ${r.files} files, ${(r.bytes / 1e6).toFixed(1)} MB in ${r.ms} ms${r.depsMs ? ` (+ deps ${r.depsMs} ms)` : ''}; fs ${r.caps.fsType}${r.caps.modes ? '' : ' (no exec bits, case-folding)'}`);
        if (r.skipped.length) console.log(`  not in the lane: ${r.skipped.slice(0, 5).join('; ')}${r.skipped.length > 5 ? ` … +${r.skipped.length - 5}` : ''}`);
        console.log(`  work there; commit with: node scripts/shadow.mjs run ${id} -- commit -am "…"`);
        console.log(`  land with:   node scripts/shadow.mjs land ${id} --repo ${opts.repo}`);
      }
      break;
    }
    case 'run': {
      const meta = SV.laneStatus({ repo: opts.repo, id: needId() });
      if (!tail.length) usage('run needs git arguments after --');
      const r = spawnSync('git', tail, { cwd: meta.laneDir, stdio: 'inherit' });
      process.exit(r.error ? 127 : (r.status ?? 1));
      break;
    }
    case 'status': {
      const r = out(SV.laneStatus({ repo: opts.repo, id: needId() }));
      if (!opts.flags.has('--json')) console.log(`${id}: ${r.laneDir}\n  tip ${r.tip.slice(0, 12)}, base ${r.base.slice(0, 12)}, ${r.commitsSinceBase} commit(s) not landed${r.dirty ? ', UNCOMMITTED changes' : ''}${r.merging ? ', MERGE in progress' : ''}${r.pendingBase ? `, synced ${r.pendingBase.slice(0, 12)}` : ''}; ${r.standingLandings} standing landing(s)`);
      break;
    }
    case 'sync': {
      const r = out(SV.sync({ repo: opts.repo, id: needId() }));
      if (!opts.flags.has('--json')) console.log(r.conflict ? `${id}: the shared tree was merged into the lane WITH CONFLICTS — resolve them in the lane, commit, then land.\n${r.output}` : `${id}: the shared tree was merged into the lane cleanly; land when ready.`);
      process.exit(r.conflict ? 3 : 0);
      break;
    }
    case 'land': {
      const r = out(SV.land({ repo: opts.repo, id: needId(), allowRevert: opts.multi['--allow-revert'] ?? [] }));
      if (!opts.flags.has('--json')) {
        console.log(`LANDED ${id} (landing ${r.n ?? '-'}, lane ${r.tip.slice(0, 12)}): ${r.written.length} file(s) written${r.written.some((w) => w.merged) ? `, ${r.written.filter((w) => w.merged).length} merged with other edits` : ''}${r.unchanged ? `, ${r.unchanged} already current` : ''}`);
        for (const w of r.written) console.log(`  ${w.action === 'delete' ? 'deleted' : w.merged ? 'merged ' : 'wrote  '} ${w.path}`);
        if (r.claimNote) console.log(`  note: ${r.claimNote}`);
        if (r.joined?.length) console.log(`  shared with another ticket's work (one group commit): ${r.joined.join('; ')}`);
        console.log(`  undo: node scripts/shadow.mjs unland ${id} --repo ${opts.repo}`);
      }
      break;
    }
    case 'unland': {
      const r = out(SV.unland({ repo: opts.repo, id: needId() }));
      if (!opts.flags.has('--json')) console.log(`UNDONE landing ${r.n} of ${id}: restored ${r.restored.length} file(s): ${r.restored.join(', ')}`);
      break;
    }
    case 'freeze': {
      const r = out(SV.freeze({ repo: opts.repo, id: needId(), checks: opts.multi['--check'] ?? [], acceptForeign: opts.multi['--accept-foreign'] ?? [], dependsOn: opts.multi['--depends-on'] ?? [] }));
      if (!opts.flags.has('--json')) {
        console.log(`FROZEN ${id}: candidate ${r.hash} — exactly the landed bytes of ${r.files.length} file(s)${r.deps.length ? `, as a group with ${r.deps.join(', ')}` : ''}`);
        console.log(`  verify: node scripts/independent-verify.mjs --candidate ${id} …   then record it with board-tool verified --candidate ${r.hash}`);
        console.log(`  the user commits: node scripts/candidate.mjs commit ${id} --repo ${opts.repo}`);
      }
      break;
    }
    case 'recover': {
      const r = out(SV.recover({ repo: opts.repo }));
      if (!opts.flags.has('--json')) {
        if (!r.length) console.log('nothing to recover');
        for (const x of r) console.log(`recovered ${x.ticket} landing ${x.n}: restored ${x.restored.length}, untouched ${x.untouched.length}${x.left.length ? `, LEFT AS IS (changed since): ${x.left.join(', ')}` : ''}`);
      }
      break;
    }
    case 'list': { const r = out(SV.listLanes({ repo: opts.repo })); if (!opts.flags.has('--json')) console.log(r.join('\n') || '(no lanes)'); break; }
    case 'inventory': {
      const r = out(SV.inventory({ repo: opts.repo }));
      if (!opts.flags.has('--json')) {
        console.log(`lanes: ${r.lanes.join(', ') || '(none)'}`);
        console.log(`landed but not committed: ${r.unpromoted.map((u) => `${u.ticket}#${u.n} (${u.paths.length})`).join(', ') || '(none)'}`);
        if (r.pending.length) console.log(`INTERRUPTED: ${r.pending.join(', ')} — run recover`);
      }
      break;
    }
    case 'drop': { const r = out(SV.drop({ repo: opts.repo, id: needId(), force: opts.flags.has('--force') })); if (!opts.flags.has('--json')) console.log(`dropped ${r.dropped}`); break; }
    case 'metrics': {
      const r = SV.metrics({ repo: opts.repo, days: opts.days ?? 28 });
      if (opts.flags.has('--json')) { console.log(JSON.stringify(r, null, 2)); break; }
      const c = r.conflictRate; const s = r.setupCost; const f = r.foreignEdits; const l = r.loss; const z = r.resolution;
      console.log(`shadow pilot — ${r.project}, last ${r.days} days (${r.events} events)`);
      console.log(`  conflict rate: ${c.refusedOverlap}/${c.attempts} land attempts refused for overlap${c.rate == null ? '' : ` (${(c.rate * 100).toFixed(0)}%)`}; other refusals ${c.otherRefusals}; syncs with conflicts ${c.syncConflicts}/${c.syncs}`);
      console.log(`  resolution: ${z.resolved} refused land(s) later landed (median ${z.medianMs ?? '-'} ms, median syncs ${z.medianSyncs ?? '-'}, ${z.oneSync} with ≤1 sync); ${z.unresolved} still open`);
      console.log(`  setup cost per lane: ${s.lanes} lane(s), median ${s.medianMs ?? '-'} ms, p90 ${s.p90Ms ?? '-'} ms, median ${s.medianFiles ?? '-'} files / ${s.medianBytes == null ? '-' : (s.medianBytes / 1e6).toFixed(1)} MB, deps ${s.medianDepsMs ?? '-'} ms`);
      console.log(`  foreign-edit incidents (${f.note}): ${f.landsWithForeign} land(s) met one; ${f.mergedClean} merged cleanly, ${f.refusedOverlap} refused; ${f.revertsForeignRefused} refused for reverting foreign lines`);
      console.log(`  loss (${l.note}): merge-check refusals ${l.mergeCheckRefusals}, races detected ${l.racesDetected}, write failures ${l.writeFailures}, recoveries ${l.recovered}, reported silent losses ${l.reportedSilentLoss}`);
      console.log(`  unlands ${r.unlands}, freezes ${r.freezes}`);
      break;
    }
    case 'incident': { out(SV.recordIncident({ repo: opts.repo, id: needId(), kind: opts.kind, note: opts.note ?? null })); console.log(`recorded ${opts.kind} for ${id}`); break; }
    case 'retire': { const r = out(SV.retire({ repo: opts.repo, force: opts.flags.has('--force') })); if (!opts.flags.has('--json')) console.log(`archived: ${r.archived}`); break; }
    default: usage(`unknown verb ${verb}`);
  }
} catch (e) {
  if (e instanceof SV.ShadowError) {
    console.error(e.message);
    for (const d of e.detail || []) console.error(d);
    process.exit(e.exit ?? 1);
  }
  console.error(`shadow: ${e?.stack || e}`);
  process.exit(1);
}
