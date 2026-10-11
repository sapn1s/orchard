#!/usr/bin/env node
/**
 * candidate.mjs — FEAT-170 CLI over scripts/lib/candidate-store.mjs.
 *
 *   claim   --id T --files a b …                 at lane start: own these files, record their pre-lane bytes
 *   freeze  --id T --files a b … [--check "<cmd>"]… [--depends-on U]… [--accept-foreign f]… [--round n] [--note s]
 *                                                 at fix-handoff: the immutable, hashed candidate
 *   integrate <T|H>… | --all                      after HEAD moved: run the recorded checks on the EXACT tree each commit would make
 *   status  [--id T | --candidate H]              CURRENT / CHANGED / REVERTED / STALE-BASE per file (only CURRENT keeps a verdict)
 *   ready                                         every open candidate: READY or why not, and the command
 *   commit  <T|H> [--message s]                    THE USER'S command: commit the frozen bytes (code only; the board is committed after, with board-tool commit)
 *   release --id T [--why s]                      abandon a ticket's claim/candidate
 *   show    <T|H>                                 the manifest
 *   foreign-report [--days n] [--json]            revisit trigger: committed foreign lines whose owner later broke/changed them (30 days)
 *   foreign-found --id T --file f --owner U --line "<text>"… [--note s]   record U's lines found in T's candidate
 *
 * Every verb takes [--repo <dir>] (default: cwd). Exit: 0 ok, 1 refusal/not ready, 2 usage, 3 claim overlap.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  claimFiles, freezeCandidate, candidateStatus, readiness, commitCandidate, releaseTicket,
  loadCandidate, repoInfo, allTicketStates, resolveRef, CandidateError, TICKET_RE,
  integrateCandidate, reconcileCommitted, membersOf, foreignReport, recordForeignFound,
} from './lib/candidate-store.mjs';

const argv = process.argv.slice(2);
const verb = argv[0];
const flags = { files: [], dependsOn: [], acceptForeign: [], checks: [], lines: [], positional: [] };
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  const take = () => { if (i + 1 >= argv.length) usage(`${a} needs a value`); return argv[++i]; };
  if (a === '--repo') flags.repo = take();
  else if (a === '--id') flags.id = take();
  else if (a === '--candidate') flags.candidate = take();
  else if (a === '--files') { while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags.files.push(argv[++i]); }
  else if (a === '--depends-on') flags.dependsOn.push(take());
  else if (a === '--accept-foreign') flags.acceptForeign.push(take());
  else if (a === '--check') flags.checks.push(take());
  else if (a === '--all') flags.all = true;
  else if (a === '--round') flags.round = Number(take());
  else if (a === '--note') flags.note = take();
  else if (a === '--why') flags.why = take();
  else if (a === '--message') flags.message = take();
  else if (a === '--json') flags.json = true;
  else if (a === '--days') flags.days = Number(take());
  else if (a === '--file') flags.file = take();
  else if (a === '--line') flags.lines.push(take());
  else if (a === '--owner') flags.owner = take();
  else if (a.startsWith('--')) usage(`unknown flag ${a}`);
  else flags.positional.push(a);
}
const repo = path.resolve(flags.repo || process.cwd());

function usage(msg) {
  process.stderr.write(`candidate: ${msg}\n${fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(2, 16).map((l) => l.replace(/^ \* ?/, '')).join('\n')}\n`);
  process.exit(2);
}
const short = (h) => (h ? h.slice(0, 12) : '—');
async function main() {
  switch (verb) {
    case 'claim': {
      if (!flags.id) usage('claim needs --id');
      const r = claimFiles({ repo, id: flags.id, files: flags.files });
      console.log(`${flags.id} claims ${r.files.length} file(s): ${r.files.join(', ')}`);
      if (r.conflicts.length) {
        console.log(`\nOWNERSHIP CONFLICT — ${r.conflicts.length} file(s) already belong to another open ticket:`);
        for (const c of r.conflicts) console.log(`  ${c.path}  owned by ${c.owner} (${c.via})`);
        console.log('Coordinate before editing: these tickets will have to be frozen as one group (--depends-on) or serialized.');
        process.exit(3);
      }
      return;
    }
    case 'freeze': {
      if (!flags.id) usage('freeze needs --id');
      const m = freezeCandidate({ repo, id: flags.id, files: flags.files, dependsOn: flags.dependsOn, acceptForeign: flags.acceptForeign, checks: flags.checks, round: Number.isFinite(flags.round) ? flags.round : null, note: flags.note ?? null });
      if (flags.json) { console.log(JSON.stringify(m, null, 2)); return; }
      console.log(`FROZEN ${m.ticket} candidate ${m.hash}`);
      console.log(`  base ${short(m.base)}  tree ${short(m.tree)}  ${m.files.length} file(s)${m.deps.length ? `  group with ${m.deps.join(', ')}` : ''}`);
      for (const f of m.files) console.log(`  ${f.deleted ? 'deleted ' : ''}${f.path}${f.owner !== m.ticket ? `  (from ${f.owner})` : ''}`);
      for (const [p, a] of Object.entries(m.meta.attribution)) if (a !== 'claimed while clean') console.log(`  attribution ${p}: ${a}`);
      if (m.deps.length) console.log(`  GROUP: ${membersOf(m).join(' + ')} are verified and committed together; each needs a HOLDS bound to this hash`);
      if (!m.checks.length) console.log('  note: no --check recorded, so this candidate cannot be integration-checked if HEAD moves before it is committed');
      if (m.meta.unchangedFiles.length) console.log(`  note: identical to HEAD: ${m.meta.unchangedFiles.join(', ')}`);
      console.log(`\nVerify exactly this: node scripts/independent-verify.mjs --candidate ${m.hash} --requirement … --run …`);
      return;
    }
    case 'status': {
      const info = repoInfo(repo);
      const refs = flags.candidate ? [flags.candidate] : flags.id ? [flags.id] : allTicketStates(info.store).filter((s) => s.open).map((s) => s.open);
      if (!refs.length) { console.log('no open candidates'); return; }
      let bad = false;
      for (const ref of refs) {
        const s = candidateStatus(repo, ref);
        console.log(`${s.manifest.ticket} ${short(s.manifest.hash)} (base ${short(s.manifest.base)}, HEAD ${short(s.head)})`);
        for (const f of s.files) {
          if (f.state !== 'CURRENT' || f.staleBase) bad = true;
          console.log(`  ${f.state.padEnd(10)} ${f.staleBase ? 'STALE-BASE ' : ''}${f.path}${f.detail ? `  — ${f.detail}` : ''}`);
        }
      }
      process.exit(bad ? 1 : 0);
      return;
    }
    case 'ready': {
      const info = repoInfo(repo);
      for (const f of reconcileCommitted(repo)) console.log(`(reconciled: ${f.ticket} was already committed as ${short(f.commit)})`);
      const open = allTicketStates(info.store).filter((s) => s.open);
      if (!open.length) { console.log('No open candidates — nothing is waiting to be committed.'); return; }
      const rows = [];
      for (const s of open) rows.push(await readiness(repo, s.open));
      const ready = rows.filter((r) => r.ready);
      console.log(`READY TO COMMIT (${ready.length}):`);
      for (const r of ready) {
        console.log(`  ${r.members.join(' + ')}  candidate ${short(r.hash)}  → node scripts/candidate.mjs commit ${r.ticket}`);
        for (const n of r.notes) console.log(`      note: ${n}`);
      }
      const not = rows.filter((r) => !r.ready);
      console.log(`\nNOT READY (${not.length}):`);
      for (const r of not) {
        console.log(`  ${r.members.join(' + ')}  candidate ${short(r.hash)}`);
        for (const b of r.blocking) console.log(`      - ${b}`);
      }
      return;
    }
    case 'commit': {
      const ref = flags.positional[0] || flags.id || flags.candidate;
      if (!ref) usage('commit needs a ticket id or candidate hash');
      const r = await commitCandidate({ repo, ref, message: flags.message ?? null });
      console.log(`COMMITTED ${r.members.join(' + ')} as ${r.commit.slice(0, 12)} (${r.paths.length} file(s): ${r.paths.join(', ')})`);
      for (const n of r.notes) console.log(`  note: ${n}`);
      if (r.stillDirty.length) console.log(`  still uncommitted in those files (other tickets' later edits): ${r.stillDirty.join(', ')}`);
      console.log(`  parent ${short(r.parent)} (the HEAD it read; published atomically)`);
      return;
    }
    case 'integrate': {
      const info = repoInfo(repo);
      let refs = flags.positional;
      if (flags.all) {
        // Every open candidate, in freeze order, CHAINED: each is checked on the tree the
        // previous ones leave, so the user can commit them in this order with no agent in between.
        const open = allTicketStates(info.store).filter((s) => s.open).map((s) => loadCandidate(info.store, s.open))
          .sort((a, b) => String(a.meta?.frozenAt).localeCompare(String(b.meta?.frozenAt)));
        refs = open.map((m) => m.hash);
      }
      if (!refs.length) usage('integrate needs a ticket id / candidate hash, or --all');
      const after = []; let bad = false;
      for (const ref of refs) {
        let rec;
        try { rec = await integrateCandidate({ repo, ref, after: flags.all ? [...after] : [] }); }
        catch (e) { if (!(e instanceof CandidateError)) throw e; console.log(`  ${ref}: REFUSED (${e.code}) — ${e.message}`); bad = true; continue; }
        console.log(`${rec.ok ? 'PASS' : 'FAIL'} ${rec.ticket} ${short(rec.hash)} → tree ${short(rec.resultTree)}${rec.after.length ? ` (after ${rec.after.length} earlier candidate(s))` : ''}`);
        for (const c of rec.checks) console.log(`  exit ${c.exit}  ${c.cmd}${c.exit ? `\n${c.tail.split('\n').slice(-8).map((l) => `      ${l}`).join('\n')}` : ''}`);
        if (rec.ok) after.push(rec.hash); else bad = true;
      }
      process.exit(bad ? 1 : 0);
      return;
    }
    case 'release': {
      if (!flags.id) usage('release needs --id');
      releaseTicket({ repo, id: flags.id, why: flags.why ?? null });
      console.log(`${flags.id}: claim and open candidate released (the frozen bytes stay in the store)`);
      return;
    }
    case 'show': {
      const ref = flags.positional[0] || flags.id || flags.candidate;
      if (!ref) usage('show needs a ticket id or candidate hash');
      const info = repoInfo(repo);
      console.log(JSON.stringify(loadCandidate(info.store, TICKET_RE.test(ref) ? resolveRef(repo, ref) : ref), null, 2));
      return;
    }
    case 'foreign-report': {
      const days = Number.isFinite(flags.days) && flags.days > 0 ? flags.days : 30;
      const r = await foreignReport({ repo, days });
      if (flags.json) { console.log(JSON.stringify(r, null, 2)); return; }
      console.log(`Foreign-line HARM, last ${days} day(s) (since ${r.since.slice(0, 10)}): committed foreign lines whose owning ticket later broke or changed them`);
      for (const h of r.harms) console.log(`  ${h.kind.padEnd(13)} ${h.file} shipped in ${h.ticket}${h.commit ? ` ${h.commit.slice(0, 12)}` : ''}, owned by ${h.owner}${h.run ? ` (run ${h.run})` : ''}: ${JSON.stringify(h.line.trim()).slice(0, 100)}`);
      console.log(`HARM ${r.harm}  (committed foreign lines ${r.committedForeign}, of which with no known owner ${r.unowned} — record one with foreign-found --owner)`);
      console.log(`informational, not the trigger: accepted ${r.informational.accepted}, unattributed ${r.informational.unattributed}, reported ${r.informational.reported}`);
      console.log(r.triggered
        ? 'REVISIT TRIGGER REACHED (harm >= 1): reopen FEAT-170\'s ownership redesign options (B mutation ledger, C sealed copy).'
        : 'revisit trigger not reached (needs harm >= 1).');
      return;
    }
    case 'foreign-found': {
      if (!flags.id || !flags.file || !flags.owner) usage('foreign-found needs --id, --file, --owner and at least one --line');
      const rec = recordForeignFound({ repo, id: flags.id, file: flags.file, owner: flags.owner, lines: flags.lines, note: flags.note ?? null, by: process.env.USER ?? null });
      console.log(`recorded: ${rec.lines.length} foreign line(s) of ${rec.owner} in ${rec.ticket}'s ${rec.file}`);
      return;
    }
    default: usage(verb ? `unknown verb ${verb}` : 'no verb');
  }
}

try { await main(); }
catch (e) {
  if (e instanceof CandidateError) {
    console.error(`candidate: REFUSED (${e.code}) — ${e.message}`);
    for (const d of e.detail || []) console.error(`  ${d}`);
    process.exit(1);
  }
  throw e;
}
