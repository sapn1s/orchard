#!/usr/bin/env node
/**
 * verify-board-tool.mjs — proves scripts/board.mjs actually catches board
 * drift, in a TEMP copy of docs/bugs (never touches the real board, never
 * touches the live systemd service on 4317 — this test spawns no server).
 *
 * (a) `check` passes (exit 0) on a consistent temp board.
 * (b) delete a row from the temp INDEX.md → `check` FAILS (exit 1) and names
 *     the dropped ID — this is the exact bug that bit this session (a scripted
 *     edit silently dropped 6 rows and only the user caught it).
 * (c) `gen` on the temp board restores that row, deriving title/severity/
 *     section from the ticket file while preserving Owner (Open) / Commit
 *     (Done) for every row that was NOT dropped.
 * (d) running `gen` again produces byte-identical output (idempotent).
 * (e) BUG-073: git conflict markers FAIL check + are stripped by gen (not laundered).
 * (f) BUG-071: the NO-INDEPENDENT-VERIFICATION exemption keys on the verify date.
 * (g) FEAT-068 item #2: a FIXED-deployed ticket → gen moves it to the Done table
 *     (must FAIL pre-fix: "FIXED" was not a recognized done token → stays Open).
 * (h) FEAT-068 item #1: the Open-row Status is RE-DERIVED from the ticket header
 *     each gen, not preserved from a stale INDEX blurb (must FAIL pre-fix).
 * (i) FEAT-068 item #3: a resolved (FIXED) ticket that keeps a 👤 needs-you owner
 *     in Open is FLAGGED by check (must FAIL pre-fix: silent needs-you inflation).
 *
 * Run: node scripts/verify-board-tool.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const boardScript = path.join(repoRoot, 'scripts', 'board.mjs');
const realBugsDir = path.join(repoRoot, 'docs', 'bugs');

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) {
    console.log(`PASS: ${label}`);
    pass++;
  } else {
    console.log(`FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
    fail++;
  }
}

function runBoard(cmd, dir) {
  // spawnSync (not execFileSync) so we capture BOTH stdout and stderr on success
  // too — gen's conflict-marker warnings go to stderr (BUG-073 check (e)).
  const r = spawnSync('node', [boardScript, cmd, `--dir=${dir}`], {
    encoding: 'utf8',
    cwd: repoRoot,
  });
  return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-verify-'));
try {
  // Seed a temp copy of the real docs/bugs (tickets + INDEX.md) so this is a
  // realistic, non-vacuous board, not a hand-crafted toy.
  for (const f of fs.readdirSync(realBugsDir)) {
    const full = path.join(realBugsDir, f);
    if (fs.statSync(full).isFile()) fs.copyFileSync(full, path.join(tmpDir, f));
  }

  // --- (a) check passes on a board that's already known-consistent for
  // presence (real board currently has 0 missing/orphan rows, only 4
  // pre-existing status-mismatch entries — see below). To get a *clean*
  // baseline for step (a), run `gen` once first so ticket-derived fields
  // and table placement agree with what `check` expects, THEN assert check
  // is clean.
  runBoard('gen', tmpDir);
  const baseline = runBoard('check', tmpDir);
  check(
    '(a) check passes (exit 0) on a consistent temp board',
    baseline.code === 0 && /DRIFT/.test(baseline.out) === false,
    baseline.out
  );

  // --- (b) delete a row from the temp INDEX.md; check must FAIL and name it.
  const indexPath = path.join(tmpDir, 'INDEX.md');
  const before = fs.readFileSync(indexPath, 'utf8');
  const lines = before.split('\n');
  const droppedLineIdx = lines.findIndex((l) => /^\| BUG-016 \|/.test(l));
  check('(b0) setup: found BUG-016 row to drop', droppedLineIdx !== -1, 'BUG-016 row not found in generated INDEX');
  const droppedLine = lines[droppedLineIdx];
  lines.splice(droppedLineIdx, 1);
  fs.writeFileSync(indexPath, lines.join('\n'));

  const afterDrop = runBoard('check', tmpDir);
  check(
    '(b) check FAILS (exit 1) after silently dropping BUG-016\'s row',
    afterDrop.code === 1,
    `exit code was ${afterDrop.code}`
  );
  check(
    '(b) check output names the dropped ID (BUG-016)',
    /MISSING FROM BOARD: BUG-016\b/.test(afterDrop.out),
    afterDrop.out
  );

  // --- (c) gen restores the row: derives title/severity/section from the
  // ticket, and preserves Owner/Commit for rows that were never touched.
  const genResult = runBoard('gen', tmpDir);
  check('(c0) gen exits 0', genResult.code === 0, genResult.out);

  const afterGen = fs.readFileSync(indexPath, 'utf8');
  const restoredLine = afterGen.split('\n').find((l) => /^\| BUG-016 \|/.test(l));
  check('(c) gen restored a BUG-016 row', !!restoredLine, 'no BUG-016 row found after gen');
  if (restoredLine) {
    const ticketText = fs.readFileSync(path.join(tmpDir, 'BUG-016-needs-you-rail-desync.md'), 'utf8');
    const h1 = /^#\s+\S+\s+—\s+(.*)$/m.exec(ticketText.split('\n')[0]);
    const derivedTitle = h1 ? h1[1].trim() : null;
    check(
      '(c) restored row\'s title is DERIVED from the ticket H1',
      derivedTitle !== null && restoredLine.includes(derivedTitle),
      `restored row: ${restoredLine}`
    );
    check(
      '(c) restored row lands in the Done table (ticket Status: VERIFIED)',
      afterGen.split('## Done')[1]?.includes(restoredLine) ?? false,
      'expected the restored row under "## Done (committed)"'
    );
  }

  // Prove the row DROP-and-RESTORE round trip didn't corrupt any OTHER row's
  // Owner (Open) / Commit (Done) — i.e. gen is non-destructive to
  // orchestrator-only columns it didn't need to touch.
  // Use FEAT-032 (Owner = 👤 in the real board), not a "—" row — preserving a
  // NON-default owner proves the preserve-from-current-INDEX path actually
  // ran, rather than accidentally matching the "—" fallback default.
  const untouchedOpenSample = 'FEAT-032';
  const beforeSampleLine = before.split('\n').find((l) => l.startsWith(`| ${untouchedOpenSample} |`));
  const afterSampleLine = afterGen.split('\n').find((l) => l.startsWith(`| ${untouchedOpenSample} |`));
  const beforeOwner = beforeSampleLine?.split('|')[3]?.trim();
  const afterOwner = afterSampleLine?.split('|')[3]?.trim();
  check(
    `(c) an untouched row's Owner column is PRESERVED (${untouchedOpenSample}: "${beforeOwner}")`,
    beforeOwner !== undefined && beforeOwner === afterOwner,
    `before="${beforeOwner}" after="${afterOwner}"`
  );

  const untouchedDoneSample = 'BUG-004';
  const beforeDoneLine = before.split('\n').find((l) => l.startsWith(`| ${untouchedDoneSample} |`));
  const afterDoneLine = afterGen.split('\n').find((l) => l.startsWith(`| ${untouchedDoneSample} |`));
  const beforeCommit = beforeDoneLine?.split('|')[3]?.trim();
  const afterCommit = afterDoneLine?.split('|')[3]?.trim();
  check(
    `(c) an untouched row's Commit column is PRESERVED (${untouchedDoneSample}: "${beforeCommit}")`,
    beforeCommit !== undefined && beforeCommit === afterCommit,
    `before="${beforeCommit}" after="${afterCommit}"`
  );

  const checkAfterGen = runBoard('check', tmpDir);
  check('(c) check is clean again after gen restored the row', checkAfterGen.code === 0, checkAfterGen.out);

  // --- (d) idempotent: a second gen produces byte-identical INDEX.md.
  const secondGen = runBoard('gen', tmpDir);
  check('(d0) second gen exits 0', secondGen.code === 0, secondGen.out);
  const afterSecondGen = fs.readFileSync(indexPath, 'utf8');
  check(
    '(d) gen is idempotent — second run produces byte-identical INDEX.md',
    afterSecondGen === afterGen,
    afterSecondGen === afterGen ? '' : 'diff between first and second gen output'
  );

  // --- (e) BUG-073: git conflict markers are non-table junk that readIndex
  // sweeps into the Open-table trailer; gen used to re-emit them verbatim every
  // regen while check never inspected them (they survived silently in the real
  // board across many regenerations). check must FAIL on them; gen must STRIP
  // them (and warn), not launder them into the next board.
  const cleanIndex = fs.readFileSync(indexPath, 'utf8');
  const cleanCheck = runBoard('check', tmpDir);
  check('(e0) baseline: clean generated board passes check', cleanCheck.code === 0, cleanCheck.out);

  // Inject markers exactly where they landed in the real INDEX.md: right after
  // the Open table, before the trailing legend line / "## Done".
  const withMarkers = cleanIndex.replace(
    /\n## Done/,
    '\n<<<<<<< HEAD\n=======\n>>>>>>> worktree-agent-deadbeef\n## Done'
  );
  check('(e0) setup: injected conflict markers into temp INDEX', withMarkers !== cleanIndex, 'replace did not alter INDEX');
  fs.writeFileSync(indexPath, withMarkers);

  const markerCheck = runBoard('check', tmpDir);
  check(
    '(e) check FAILS (exit 1) when INDEX.md carries git conflict markers',
    markerCheck.code === 1,
    `exit code was ${markerCheck.code}: ${markerCheck.out}`
  );
  check(
    '(e) check names the conflict marker (GIT CONFLICT MARKER)',
    /GIT CONFLICT MARKER/.test(markerCheck.out),
    markerCheck.out
  );

  const markerGen = runBoard('gen', tmpDir);
  check('(e) gen exits 0 on a marker-laden board', markerGen.code === 0, markerGen.out);
  check(
    '(e) gen WARNS loudly about the dropped marker(s)',
    /conflict marker/i.test(markerGen.out),
    markerGen.out
  );
  const afterMarkerGen = fs.readFileSync(indexPath, 'utf8');
  check(
    '(e) gen STRIPPED the conflict markers (none remain in INDEX.md)',
    !/^(?:<{7,}|={7,}|>{7,}|\|{7,})/m.test(afterMarkerGen),
    'a conflict marker survived gen'
  );
  check(
    '(e) gen preserved the real trailing legend line (not over-stripped)',
    afterMarkerGen.includes('FE = frontend'),
    'the Open-table legend line was lost'
  );
  const afterMarkerCheck = runBoard('check', tmpDir);
  check('(e) check is clean again after gen stripped the markers', afterMarkerCheck.code === 0, afterMarkerCheck.out);

  // --- (f) BUG-071: the NO INDEPENDENT VERIFICATION advisory used to exempt a
  // done ticket whenever its NEWEST activity-log heading predated the rule
  // (2026-08-11) — regardless of when it actually reached VERIFIED. So a ticket
  // VERIFIED today (status header dated on/after the rule) but whose activity
  // log was never refreshed at closure (stale heading) silently bypassed the
  // nudge. The exemption is now anchored to verifiedDate (status-header date,
  // else newest log heading). must-FAIL shape: pre-fix this warning is SILENT
  // (old board keys on the stale log heading and exempts); post-fix it is LOUD.
  const staleLog = '\n## Activity log\n\n### 2026-08-01 — someone\n- old note, never refreshed at closure.\n';
  const mkTicket = (id, statusLine) =>
    `# ${id} ${'—'} today-verified ticket with a stale-only activity log\n\n` +
    `- **Status:** ${statusLine}\n- **Severity:** low\n- **Area:** tooling\n${staleLog}`;

  // The bypass case: VERIFIED with a status-header date ON/AFTER the rule, no
  // Verified-by line, no Verification-class exemption, only a pre-rule log
  // heading. gen first so the ticket gets an INDEX row (else check flags a
  // missing row and we cannot isolate the advisory), then check.
  const bypassId = 'BUG-901';
  fs.writeFileSync(path.join(tmpDir, `${bypassId}-today-verified-stale-log.md`),
    mkTicket(bypassId, 'VERIFIED 2026-08-12 — fixed + self-verified; awaiting independent verification'));
  runBoard('gen', tmpDir);
  const bypassCheck = runBoard('check', tmpDir);
  const warnRe = new RegExp(`NO INDEPENDENT VERIFICATION[^\\n]*${bypassId}|${bypassId}[^\\n]*NO INDEPENDENT`);
  check(
    '(f) BUG-071: a ticket VERIFIED on/after the rule with a STALE-only log still WARNs (no longer bypassed by the last-activity-date key)',
    warnRe.test(bypassCheck.out) || new RegExp(`${bypassId} is VERIFIED[^\\n]*carries no`).test(bypassCheck.out),
    bypassCheck.out.split('\n').filter((l) => /NO INDEPENDENT|BUG-901/.test(l)).join(' | ') || '(no NO-INDEPENDENT-VERIFICATION warning naming BUG-901 — the pre-fix silent bypass)'
  );
  check(
    '(f) BUG-071: the advisory stays WARN-only — check still exits 0 (it does not gate)',
    bypassCheck.code === 0,
    `exit code was ${bypassCheck.code}`
  );

  // The CONTROL: same stale-only log, but VERIFIED BEFORE the rule (status date
  // < 2026-08-11) — a genuinely pre-rule close. It must remain EXEMPT, or the
  // fix would flood the 70+ legitimately pre-rule tickets. Proves the warning
  // keys on the verify date, not merely "is it done + stale".
  const preRuleId = 'BUG-902';
  fs.writeFileSync(path.join(tmpDir, `${preRuleId}-pre-rule-verified-stale-log.md`),
    mkTicket(preRuleId, 'VERIFIED 2026-08-05 — closed before the independent-verification rule took effect'));
  runBoard('gen', tmpDir);
  const controlCheck = runBoard('check', tmpDir);
  check(
    '(f) BUG-071 CONTROL: a ticket VERIFIED BEFORE the rule stays EXEMPT (no warning) — the fix does not flood legitimately pre-rule tickets',
    !new RegExp(`${preRuleId}[^\\n]*carries no|NO INDEPENDENT VERIFICATION[^\\n]*${preRuleId}`).test(controlCheck.out),
    controlCheck.out.split('\n').filter((l) => /BUG-902/.test(l)).join(' | ') || 'BUG-902 correctly not warned'
  );

  // --- (g) FEAT-068 item #2: broaden done-detection to include a LEADING FIXED
  // (incl. "FIXED — deployed"). A completed-and-deployed ticket must leave the
  // Open table on gen WITHOUT a manual VERIFIED/DONE keyword nudge — BUG-068/
  // 076/077/078 lingered in Open/queued precisely because "FIXED" was not
  // recognized. must-FAIL shape: against the pre-fix board, isDoneStatus("FIXED…")
  // is false, so gen leaves the row in the OPEN table.
  const fixedId = 'BUG-903';
  fs.writeFileSync(path.join(tmpDir, `${fixedId}-fixed-deployed.md`),
    `# ${fixedId} ${'—'} a fixed-and-deployed ticket\n\n` +
    `- **Status:** FIXED 2026-08-13 — deployed; pid runs the latest code\n` +
    `- **Severity:** med\n- **Area:** server\n`);
  runBoard('gen', tmpDir);
  const fixedIndex = fs.readFileSync(indexPath, 'utf8');
  const fixedRow = fixedIndex.split('\n').find((l) => new RegExp(`^\\| ${fixedId} \\|`).test(l)) || '';
  check('(g0) FEAT-068: a FIXED-deployed ticket gets a board row after gen', !!fixedRow, 'no BUG-903 row after gen');
  const fixedDoneBlob = fixedIndex.split('## Done')[1] ?? '';
  check(
    '(g) FEAT-068 item #2: a FIXED-deployed ticket lands in the Done table (FIXED = done for placement)',
    fixedRow !== '' && fixedDoneBlob.includes(fixedRow),
    `BUG-903 row: "${fixedRow}" — pre-fix it stays in Open because "FIXED" was not a recognized done token`
  );
  const genAfterFixed = runBoard('gen', tmpDir);
  check('(g) gen still exits 0 with the FIXED ticket present', genAfterFixed.code === 0, genAfterFixed.out);
  const checkAfterFixed = runBoard('check', tmpDir);
  check('(g) check is clean with the FIXED ticket correctly in Done', checkAfterFixed.code === 0, checkAfterFixed.out);

  // --- (h) FEAT-068 item #1: the Open-row Status is RE-DERIVED from the ticket
  // header on every gen (single source of truth). Pre-fix, gen PRESERVED the
  // Status blurb from the current INDEX by id (statusMap) — so a header that
  // changed left a stale blurb lying on the board indefinitely. must-FAIL shape:
  // inject a stale blurb into the INDEX row, gen, then assert the row's Status
  // is the ticket header, not the stale blurb.
  const driftId = 'BUG-904';
  const headerStatus = 'IN PROGRESS — phase 2 underway, not yet fixed';
  fs.writeFileSync(path.join(tmpDir, `${driftId}-header-derived-status.md`),
    `# ${driftId} ${'—'} header-derived status fixture\n\n` +
    `- **Status:** ${headerStatus}\n- **Severity:** low\n- **Area:** tooling\n`);
  runBoard('gen', tmpDir); // give it an Open row (status derived from header)
  // Simulate DRIFT: hand-edit that row's Status cell to a stale blurb.
  let driftLines = fs.readFileSync(indexPath, 'utf8').split('\n');
  const driftRowIdx = driftLines.findIndex((l) => new RegExp(`^\\| ${driftId} \\|`).test(l));
  check('(h0) setup: found the BUG-904 Open row to drift', driftRowIdx !== -1, 'BUG-904 row not found');
  if (driftRowIdx !== -1) {
    const cells = driftLines[driftRowIdx].split('|'); // ['',' ID ',' Title ',' Owner ',' Status ',' Sev ','']
    cells[4] = ' STALE BLURB — resolved ages ago ';
    driftLines[driftRowIdx] = cells.join('|');
    fs.writeFileSync(indexPath, driftLines.join('\n'));
  }
  runBoard('gen', tmpDir); // pre-fix: preserves "STALE BLURB…"; post-fix: re-derives.
  const afterDeriveGen = fs.readFileSync(indexPath, 'utf8');
  const derivedRow = afterDeriveGen.split('\n').find((l) => new RegExp(`^\\| ${driftId} \\|`).test(l)) || '';
  check(
    '(h) FEAT-068 item #1: Open-row Status is RE-DERIVED from the ticket header, not the stale INDEX blurb',
    derivedRow.includes(headerStatus) && !derivedRow.includes('STALE BLURB'),
    `row after gen: "${derivedRow}" — pre-fix the old gen preserved "STALE BLURB…" from the INDEX (statusMap)`
  );

  // --- (i) FEAT-068 item #3: a resolved ticket must not keep the 👤 needs-you
  // owner. Build a FIXED ticket, hand-place its row in Open WITH a 👤 owner (the
  // drift a regen fixes), and assert `check` FLAGS it (STALE OWNER, exit 1).
  // must-FAIL shape: pre-fix "FIXED" is not a done token, so the row sits in Open
  // with 👤 and check says NOTHING (no STATUS MISMATCH, no STALE OWNER) — the
  // silent needs-you inflation BUG-070 suffered.
  const staleOwnerId = 'BUG-905';
  fs.writeFileSync(path.join(tmpDir, `${staleOwnerId}-stale-owner.md`),
    `# ${staleOwnerId} ${'—'} resolved ticket with a lingering 👤 owner\n\n` +
    `- **Status:** FIXED 2026-08-13 — deployed\n- **Severity:** low\n- **Area:** server\n`);
  let ownLines = fs.readFileSync(indexPath, 'utf8').split('\n');
  const openHdrIdx = ownLines.findIndex((l) => l.trim() === '## Open');
  const openSepIdx = ownLines.findIndex((l, i) => i > openHdrIdx && /^\|----/.test(l.trim()));
  check('(i0) setup: found the Open-table separator to inject under', openSepIdx !== -1, 'Open separator not found');
  ownLines.splice(openSepIdx + 1, 0,
    `| ${staleOwnerId} | resolved ticket with a lingering 👤 owner | 👤 | needs you | low |`);
  fs.writeFileSync(indexPath, ownLines.join('\n'));
  const staleOwnerCheck = runBoard('check', tmpDir);
  check(
    '(i) FEAT-068 item #3: check FLAGS a resolved (FIXED) ticket still showing the 👤 needs-you owner in Open (STALE OWNER)',
    new RegExp(`STALE OWNER[^\\n]*${staleOwnerId}`).test(staleOwnerCheck.out),
    staleOwnerCheck.out.split('\n').filter((l) => /BUG-905|STALE OWNER/.test(l)).join(' | ') ||
      '(silent — pre-fix "FIXED" was not a done token, so no STALE OWNER/STATUS MISMATCH fired)'
  );
  check(
    '(i) FEAT-068 item #3: that check FAILS (exit 1) — a stale needs-you owner is drift, not advisory',
    staleOwnerCheck.code === 1,
    `exit code was ${staleOwnerCheck.code}`
  );
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
