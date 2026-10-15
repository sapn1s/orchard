#!/usr/bin/env node
/**
 * FEAT-176 — lane snapshots CLI. See scripts/lib/lane-snapshot.mjs for the design.
 *
 *   node scripts/lane-snapshot.mjs check   --repo <dir> [--path <f>]… [--staged] [--json] [--verbose] [--warn]
 *        best-effort: exit 0 no differences, 1 differences, 3 unavailable; --warn: stderr block, exit 0 always
 *   node scripts/lane-snapshot.mjs restore <snapshot-id | lane-id | TICKET> --repo <dir>
 *                                          [--file <f>]… [--dry-run] [--force] [--json]
 *        exact files (replayed from the transcript) restore by default; UNVERIFIED lane-end
 *        copies only with --force and are labelled so
 *        backs up whatever it overwrites first; prints the undo command
 *   node scripts/lane-snapshot.mjs list    --repo <dir> [--ticket T] [--json]
 *   node scripts/lane-snapshot.mjs show    <snapshot-id | lane-id> --repo <dir>
 *   node scripts/lane-snapshot.mjs prune   --repo <dir> [--json]
 *   node scripts/lane-snapshot.mjs stats   [--repo <dir>] [--json]
 *   node scripts/lane-snapshot.mjs take    --spec <base64 json> | --spec-file <f>   (internal: the server/dispatch trigger)
 *
 * `--repo` defaults to the current directory.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as LS from './lib/lane-snapshot.mjs';

const argv = process.argv.slice(2);
const verb = argv[0];
const flags = { path: [], file: [] };
const pos = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--json' || a === '--dry-run' || a === '--force' || a === '--verbose' || a === '--staged' || a === '--warn') flags[a.slice(2)] = true;
  else if (a === '--path' || a === '--file') flags[a.slice(2)].push(argv[++i]);
  else if (a.startsWith('--')) { const k = a.slice(2); flags[k] = argv[++i]; }
  else pos.push(a);
}
const top = path.resolve(flags.repo || process.cwd());
const out = (o) => process.stdout.write(typeof o === 'string' ? o : JSON.stringify(o, null, 1) + '\n');
const fmtTime = (ms) => (ms ? new Date(ms).toISOString() : '—');

async function main() {
  switch (verb) {
    case 'take': {
      let spec;
      try {
        spec = flags.spec ? JSON.parse(Buffer.from(flags.spec, 'base64').toString('utf8'))
          : JSON.parse(fs.readFileSync(flags['spec-file'], 'utf8'));
      } catch (e) { LS.logError(process.env, 'take-args', e); return 0; }
      const r = await LS.takeSnapshot(spec);
      if (process.env.ORCHARD_LANE_SNAPSHOT_ECHO === '1') out(r);
      return 0; // failures are logged, never surfaced as an exit status
    }
    case 'check': {
      let paths = flags.path;
      if (flags.staged) {
        // the pre-commit hook: only what this commit records
        const r = spawnSync('git', ['-C', top, 'diff', '--cached', '--name-only', '-z'], { encoding: 'utf8' });
        paths = String(r.stdout || '').split('\0').filter(Boolean);
        if (!paths.length) return 0;
      }
      if (flags.warn) {
        // warning mode for hooks and tools: the loud block on stderr, exit 0 always
        const res = LS.checkRepo({ top, paths });
        const s = LS.formatCheck(res);
        if (s) process.stderr.write(s);
        return 0;
      }
      const res = LS.checkRepo({ top, paths });
      if (flags.json) out(res); else out(LS.formatCheck(res, { verbose: true }));
      return res.unavailable ? 3 : res.findings.length ? 1 : 0;
    }
    case 'restore': {
      const sel = pos[0];
      if (!sel) { process.stderr.write('restore: give a snapshot id, lane id or ticket\n'); return 2; }
      const r = await LS.restore({ top, selector: sel, files: flags.file, dryRun: !!flags['dry-run'], force: !!flags.force });
      if (flags.json) { out(r); return r.ok ? 0 : 1; }
      if (r.error) { out(`restore refused: ${r.error}\n${(r.candidates || []).map((c) => `  ${c}`).join('\n')}${r.candidates ? '\n' : ''}`); return 1; }
      const lines = [];
      for (const p of r.plan) lines.push(`${p.result ? (p.result === 'restored' ? (p.verified ? 'RESTORED (exact, from the transcript)' : 'RESTORED (UNVERIFIED lane-end copy)') : 'FAILED  ') : r.dryRun && p.action === 'write' ? 'WOULD   ' : p.action === 'refuse' ? 'REFUSED ' : p.action === 'unrecoverable' ? 'UNRECOVERABLE' : 'skip    '} ${p.path}${p.why ? `  (${p.why})` : ''}${p.result && p.result !== 'restored' ? `  ${p.result}` : ''}`);
      if (r.backup) lines.push(`backup of the overwritten files: ${r.backup}`, `undo: ${r.undo}`);
      if (!r.plan.length) lines.push('nothing to restore');
      out(lines.join('\n') + '\n');
      return r.ok ? 0 : 1;
    }
    case 'list': {
      const dir = LS.storeDirFor(top);
      let ms = LS.readManifests(dir);
      if (flags.ticket) ms = ms.filter((m) => (m.ticket || []).includes(flags.ticket));
      if (flags.json) { out(ms.map(({ _file, ...m }) => ({ id: m.id, laneId: m.laneId, source: m.source, ticket: m.ticket, endedAt: m.endedAt, files: (m.files || []).length, transcriptMissing: !!m.transcriptMissing }))); return 0; }
      if (ms.damaged?.length) process.stderr.write(`warning: ${ms.damaged.length} damaged manifest(s): ${ms.damaged.map((d) => `${d.file} (${d.error})`).join(', ')}\n`);
      if (!ms.length) { out(`no lane snapshots for ${top} (${dir})\n`); return 0; }
      out(ms.map((m) => `${m.id}  ${fmtTime(m.endedAt)}  ${m.source}  ${(m.ticket || []).join(',') || '—'}  ${(m.files || []).length} file(s)${m.transcriptMissing ? '  TRANSCRIPT NOT FOUND' : ''}`).join('\n') + '\n');
      return 0;
    }
    case 'show': {
      const dir = LS.storeDirFor(top);
      const sel = LS.selectEntries(dir, pos[0] || '');
      if (sel.kind !== 'snapshot') { out(`show: ${sel.kind === 'ambiguous' ? `ambiguous: ${sel.candidates.join(', ')}` : 'no such snapshot'}\n`); return 1; }
      const m = sel.entries[0]?.m ?? LS.readManifests(dir).find((x) => x.id === sel.manifests[0]);
      const { _file, ...rest } = m || {};
      out(rest);
      return 0;
    }
    case 'prune': {
      const r = await LS.prune(LS.storeDirFor(top));
      out(flags.json ? r : `pruned ${r.manifests} manifest(s), ${r.objects} object(s), ${r.bytes} bytes\n`);
      return 0;
    }
    case 'stats': {
      const root = LS.storeRoot();
      const dirs = flags.repo ? [LS.storeDirFor(top)] : (fs.existsSync(root) ? fs.readdirSync(root).map((n) => path.join(root, n)).filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } }) : []);
      const s = dirs.map((d) => LS.stats(d));
      out(flags.json ? s : s.map((x) => `${x.store}: ${x.manifests} snapshot(s), ${x.fileEntries} file entries, ${x.objects} object(s), ${(x.bytes / 1048576).toFixed(1)} MB, ${fmtTime(x.oldest)} .. ${fmtTime(x.newest)}`).join('\n') + (s.length ? '\n' : 'no lane snapshots\n'));
      return 0;
    }
    default:
      process.stderr.write('usage: lane-snapshot.mjs check|restore|list|show|prune|stats|take … (see the header of scripts/lane-snapshot.mjs)\n');
      return 2;
  }
}
main().then((c) => process.exit(c), (e) => { if (verb === 'take') { LS.logError(process.env, 'take-main', e); process.exit(0); } process.stderr.write(`lane-snapshot: ${e.stack || e.message}\n`); process.exit(3); });
