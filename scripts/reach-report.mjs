#!/usr/bin/env node
/**
 * reach-report.mjs — FEAT-208 (advisory only): count the verifier's per-finding reach tags per
 * ticket, for the 2026-12-04 read. Reads the log independent-verify appends to
 * (scripts/lib/reach-tags.mjs reachLogPath()); writes nothing.
 *
 *   node scripts/reach-report.mjs [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--ticket ID]
 *                                 [--repo <path>] [--log <file>] [--json]
 *
 * Per ticket: verdict runs, HOLDS/BROKEN, findings, REACHABLE / UNREACHABLE / untagged, and the
 * unreachable share of tagged findings. The tags never changed any of those verdicts; this only
 * measures whether they would predict anything.
 */
import path from 'node:path';
import { readReachLog, reachLogPath } from './lib/reach-tags.mjs';

const argv = process.argv.slice(2);
const opt = { json: false, since: null, until: null, ticket: null, repo: null, log: null };
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  const take = () => { const v = argv[++i]; if (v === undefined) { console.error(`${a} needs a value`); process.exit(2); } return v; };
  if (a === '--json') opt.json = true;
  else if (a === '--since') opt.since = take();
  else if (a === '--until') opt.until = take();
  else if (a === '--ticket') opt.ticket = take();
  else if (a === '--repo') opt.repo = path.resolve(take());
  else if (a === '--log') opt.log = path.resolve(take());
  else { console.error(`unknown argument ${a}`); process.exit(2); }
}
for (const k of ['since', 'until']) if (opt[k] && !/^\d{4}-\d{2}-\d{2}$/.test(opt[k])) { console.error(`--${k} must be YYYY-MM-DD`); process.exit(2); }

const log = readReachLog(opt.log ?? reachLogPath());
const day = (r) => String(r.recorded_at ?? '').slice(0, 10);
const picked = log.records.filter((r) => (!opt.since || day(r) >= opt.since) && (!opt.until || day(r) <= opt.until)
  && (!opt.ticket || r.ticket === opt.ticket) && (!opt.repo || r.repo === opt.repo));

const blank = () => ({ runs: 0, holds: 0, broken: 0, findings: 0, reachable: 0, unreachable: 0, untagged: 0 });
const byTicket = new Map();
const total = blank();
for (const r of picked) {
  const key = r.ticket ?? '(no ticket)';
  if (!byTicket.has(key)) byTicket.set(key, blank());
  for (const t of [byTicket.get(key), total]) {
    t.runs += 1;
    if (r.verdict === 'HOLDS') t.holds += 1; else t.broken += 1;
    for (const f of r.findings) {
      t.findings += 1;
      if (f.reach === 'REACHABLE') t.reachable += 1;
      else if (f.reach === 'UNREACHABLE') t.unreachable += 1;
      else t.untagged += 1;
    }
  }
}
const share = (t) => (t.reachable + t.unreachable ? +(t.unreachable / (t.reachable + t.unreachable)).toFixed(3) : null);
const tickets = [...byTicket.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([ticket, t]) => ({ ticket, ...t, unreachable_share: share(t) }));
const out = { log: log.file, log_missing: log.missing, skipped_lines: log.skipped, filters: { since: opt.since, until: opt.until, ticket: opt.ticket, repo: opt.repo }, total: { ...total, unreachable_share: share(total) }, tickets };

if (opt.json) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
console.log(`reach tags (advisory) — ${log.file}${log.missing ? ' (no log yet)' : ''}${log.skipped ? `; ${log.skipped} unreadable line(s) skipped` : ''}`);
console.log('ticket        runs  HOLDS BROKEN  findings  REACH  UNREACH  untagged  unreach-share');
const row = (name, t) => console.log(`${name.padEnd(12)} ${String(t.runs).padStart(5)} ${String(t.holds).padStart(6)} ${String(t.broken).padStart(6)} ${String(t.findings).padStart(9)} ${String(t.reachable).padStart(6)} ${String(t.unreachable).padStart(8)} ${String(t.untagged).padStart(9)}  ${t.unreachable_share ?? '—'}`);
for (const t of tickets) row(t.ticket, t);
row('TOTAL', out.total);
