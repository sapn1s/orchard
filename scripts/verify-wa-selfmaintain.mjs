#!/usr/bin/env node
/**
 * FEAT-019 verification — the living-doc self-maintenance loop
 * (capture + AUTOMATIC consolidation, per the 2026-08-05 user decision).
 *
 * Non-vacuous, prints observed values, and NEVER mutates the real canonical
 * methodology repo: all capture/consolidate runs target a SCRATCH git repo copied
 * from $METHODOLOGY_DIR. The one place the real committed mirror is touched (the
 * sync contract, which is what production capture/consolidate does) is snapshotted
 * and byte-restored inside a guarded block, so the working tree is left exactly as
 * found.
 *
 * Proves:
 *   T1  capture APPENDS a qualifying (standing) rule to canonical (scratch).
 *   T2  SYNC CONTRACT: after the append, sync makes the mirror == canonical and
 *       `sync-methodology.mjs --check` exits 0. (Real mirror snapshot+restored.)
 *   T3  capture REFUSES a one-off (exit 3) and leaves canonical unchanged.
 *   T4  MUST-FAIL: capture --no-append on a QUALIFYING rule leaves canonical
 *       unchanged (proves the append is what mutates — the check is not vacuous).
 *   T5  propose mode still writes a report artifact WITHOUT modifying the WA.
 *   T7  `--apply` AUTO-APPLIES the safe classes in scratch (BUG-042 contract):
 *       a WHOLE unambiguously project-specific section relocates into the owning
 *       project's docs/CONVENTIONS.md (created, appended — content preserved,
 *       pointer stub left) and the CHANGELOG names each moved rule; a UNIVERSAL
 *       bullet that cites a product name only as an EXAMPLE survives verbatim
 *       (the BUG-042 incident class); the REAL "separate agent PROCESS, never
 *       one of your own subagents" specimen survives verbatim; a PARTIAL
 *       project-specific block is NOT relocated — it surfaces as a needs-human
 *       relocation-candidate (demotion, BUG-042 point 2); applied relocations
 *       also land on the needs-human rail JSON (point 3). Merges still apply;
 *       a planted CONTRADICTION is NOT auto-applied — both bullets survive.
 *   T8  a second `--apply` pass is an honest no-op: no new commit, WA unchanged.
 *   T9  capture triggers the consolidation mini-pass automatically after
 *       capture+sync, and TOLERATES a failing mini-pass (non-git methodology dir:
 *       consolidate refuses, capture still exits 0).
 *   T10 BOOT SEAM: the real server boots and serves with a BROKEN methodology
 *       dir — the consolidation pass fails, is logged honestly, and startup is
 *       unaffected. (Free port, never :4317; killed by pid.)
 *   T6  the real canonical repo is provably untouched (git porcelain + bytes).
 */
import { spawnSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const HERE = import.meta.dirname;
const REPO_ROOT = path.resolve(HERE, '..');
const REAL_METH = process.env.METHODOLOGY_DIR || path.join(os.homedir(), 'projects', 'methodology');
const V2 = 'WORKING_AGREEMENT.v2.md';

let pass = 0,
  fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++;
  else {
    fail++;
    failures.push(name);
  }
}
function run(script, argv, env = {}) {
  const r = spawnSync(process.execPath, [path.join(HERE, script), ...argv], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function bytes(p) {
  return fs.statSync(p).size;
}
function git(dir, argv) {
  return spawnSync('git', ['-C', dir, ...argv], { encoding: 'utf8' });
}
function indent(s) {
  return (s || '').trimEnd().split('\n').map((l) => '    | ' + l).join('\n');
}
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}
async function httpGet(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.status;
  } catch {
    return 0;
  }
}

// --- scratch canonical (git repo copied from the real one; real never targeted) ---
if (!fs.existsSync(REAL_METH)) {
  console.error(`FATAL: real methodology repo missing at ${REAL_METH}; cannot build scratch copy.`);
  process.exit(1);
}
function makeScratch(withGit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-wa-meth-'));
  for (const f of fs.readdirSync(REAL_METH)) {
    if (f === '.git') continue;
    const src = path.join(REAL_METH, f);
    if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(dir, f));
  }
  if (withGit) {
    git(dir, ['init', '-q']);
    git(dir, ['config', 'user.email', 'verify@test']);
    git(dir, ['config', 'user.name', 'verify']);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'scratch baseline']);
  }
  return dir;
}
const SCRATCH = makeScratch(true);
const scratchV2 = path.join(SCRATCH, V2);
const realV2 = path.join(REAL_METH, V2);
const METH = { METHODOLOGY_DIR: SCRATCH };
const CONVPROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-wa-conv-'));
const conventionsFile = path.join(CONVPROJ, 'docs', 'CONVENTIONS.md');

// record real-repo invariants up front
const realBytesBefore = bytes(realV2);
const realGitBefore = git(REAL_METH, ['status', '--porcelain']).stdout;

let mirrorSnapshot = null;
const mirrorPath = path.join(REPO_ROOT, 'docs', 'prompts', V2);

async function main() {
  try {
    console.log('\n=== T1: capture APPENDS a qualifying (standing) rule to canonical (scratch) ===');
    const b1 = bytes(scratchV2);
    const RULE = 'Always re-run the full relevant verify suite before declaring a fix done, from now on.';
    const r1 = run('wa-capture.mjs', ['--rule', RULE, '--section', 'C', '--no-sync'], METH);
    console.log(indent(r1.out));
    const afterBody = fs.readFileSync(scratchV2, 'utf8');
    check('T1a capture exited 0', r1.code === 0, `exit=${r1.code}`);
    check('T1b canonical (scratch) grew', bytes(scratchV2) > b1, `${b1} -> ${bytes(scratchV2)} bytes`);
    check('T1c the rule text is now present in canonical', afterBody.includes(RULE.slice(0, 40)), 'rule bullet found');
    check(
      'T1d it landed under §C (appears after the "### C." heading, before "### D.")',
      afterBody.indexOf(RULE.slice(0, 40)) > afterBody.indexOf('### C.') &&
        afterBody.indexOf(RULE.slice(0, 40)) < afterBody.indexOf('### D.'),
      `idx rule=${afterBody.indexOf(RULE.slice(0, 40))}, C=${afterBody.indexOf('### C.')}, D=${afterBody.indexOf('### D.')}`,
    );

    console.log('\n=== T2: SYNC CONTRACT — sync makes mirror == canonical; --check exits 0 ===');
    mirrorSnapshot = fs.readFileSync(mirrorPath); // Buffer; restored in finally regardless
    const rSync = run('sync-methodology.mjs', [], METH);
    console.log(indent(rSync.out));
    const rCheck = run('sync-methodology.mjs', ['--check'], METH);
    console.log(indent(rCheck.out));
    check('T2a sync exited 0', rSync.code === 0, `exit=${rSync.code}`);
    check('T2b sync-methodology --check reports OK (mirror == canonical)', rCheck.code === 0, `exit=${rCheck.code}`);
    check(
      'T2c the mirror now contains the just-captured rule (proves canonical->mirror flow)',
      fs.readFileSync(mirrorPath, 'utf8').includes(RULE.slice(0, 40)),
      'mirror contains captured rule',
    );

    console.log('\n=== T3: capture REFUSES a one-off and leaves canonical unchanged ===');
    const b3 = bytes(scratchV2);
    const ONEOFF = 'Rename the parser temp buffer to reuse the pool for this task.';
    const r3 = run('wa-capture.mjs', ['--rule', ONEOFF, '--section', 'B', '--no-sync'], METH);
    console.log(indent(r3.out));
    check('T3a capture exited 3 (REFUSED/parked)', r3.code === 3, `exit=${r3.code}`);
    check('T3b output says REFUSED/PARKED', /REFUSED|PARKED/i.test(r3.out), 'refusal message present');
    check('T3c canonical unchanged after refusal', bytes(scratchV2) === b3, `${b3} == ${bytes(scratchV2)} bytes`);

    console.log('\n=== T4: MUST-FAIL — capture --no-append on a QUALIFYING rule leaves canonical unchanged ===');
    const b4 = bytes(scratchV2);
    const r4 = run(
      'wa-capture.mjs',
      ['--rule', 'Never git add -A while agents hold uncommitted work.', '--section', 'J', '--no-append', '--no-sync'],
      METH,
    );
    console.log(indent(r4.out));
    check('T4a capture --no-append exited 0 (qualified, but write disabled)', r4.code === 0, `exit=${r4.code}`);
    check('T4b it reports the rule QUALIFIES (bar not the reason for no-write)', /qualifies: YES/i.test(r4.out), 'qualifies: YES');
    check('T4c canonical byte-for-byte UNCHANGED (the append is what mutates)', bytes(scratchV2) === b4, `${b4} == ${bytes(scratchV2)} bytes`);

    console.log('\n=== T5: propose mode reports ≥1 tension WITHOUT modifying the WA ===');
    const b5 = bytes(scratchV2);
    const r5 = run('wa-consolidate.mjs', [], METH);
    console.log(indent(r5.out));
    const proposalPath = path.join(SCRATCH, 'CONSOLIDATION-PROPOSAL.md');
    const proposalExists = fs.existsSync(proposalPath);
    const proposal = proposalExists ? fs.readFileSync(proposalPath, 'utf8') : '';
    const tensionCount = (proposal.match(/^## \d+\. \[/gm) || []).length;
    check('T5a consolidate (propose) exited 0', r5.code === 0, `exit=${r5.code}`);
    check('T5b proposal artifact written', proposalExists, proposalPath);
    check('T5c proposal lists ≥1 real tension (with a named section location)', tensionCount >= 1, `tensions=${tensionCount}`);
    check(
      'T5d proposal states this run did NOT auto-apply / did not modify the WA',
      /NOT AUTO-APPLIED/i.test(proposal) && /not modified/i.test(proposal),
      'propose-only banner present',
    );
    check('T5e WA byte length UNCHANGED by the propose run', bytes(scratchV2) === b5, `${b5} == ${bytes(scratchV2)} bytes`);

    console.log('\n=== T7: --apply — BUG-042 relocation contract; contradiction is NOT applied ===');
    // Plant, UNCOMMITTED (so the pre-consolidation snapshot commit is exercised):
    //   - a WHOLE unambiguously project-specific section (### W — every bullet has
    //     project markers in its normative clause) => the ONE auto-relocated class;
    //   - a UNIVERSAL bullet in §B citing a product name ("Orchard") purely as a
    //     parenthetical e.g.-example => must survive verbatim (BUG-042 incident class);
    //   - a genuinely project-flavored PARTIAL block in §B (btrfs) => needs-human
    //     relocation-candidate, NEVER auto-moved (BUG-042 demotion);
    //   - a contradiction pair (§C "Always …" vs §E "Never …" on the same ground);
    //   - a near-duplicate section pair (### Y richer / ### Z poorer, Jaccard ≥ .5).
    const EXAMPLE_UNIV =
      '- **Name the failure a rule prevents when you write it down.** A bare imperative reads as a platitude (e.g. the Orchard incident, where a universal bullet was nearly lost for naming one product).';
    const RELOC_CAND =
      '- On this machine, check the automatic btrfs snapshots under /home before designing new recovery machinery.';
    const WHOLE_SECTION =
      '### W. Station-local tooling defaults\n' +
      '- Use Serena symbol tools on claude-station server files instead of grepping whole files.\n' +
      '- Hunt claude-station regressions with ast-grep patterns before any mechanical refactor.\n';
    const CONTRA_A = '- Always run the flaky-suite quarantine gate before merging release branches.';
    const CONTRA_B = '- Never run the flaky-suite quarantine gate before merging release branches.';
    const DUP_RICH =
      '### Y. Keep verification scripts deterministic and hermetic\n' +
      '- Verification scripts stay deterministic and hermetic; seed scratch fixtures, print observed values, and clean temp dirs so a rerun gives identical results.\n' +
      '- Extra richer-only nuance; flaky wall-clock assertions are rewritten against logical events.\n';
    const DUP_POOR =
      '### Z. Keep verification scripts deterministic\n' +
      '- Verification scripts stay deterministic and hermetic; seed scratch fixtures, print observed values, and clean temp dirs.\n';
    let wa = fs.readFileSync(scratchV2, 'utf8');
    wa = wa.replace(/^(### B\. .*)$/m, `$1\n${EXAMPLE_UNIV}\n${RELOC_CAND}`);
    wa = wa.replace(/^(### C\. .*)$/m, `$1\n${CONTRA_A}`);
    wa = wa.replace(/^(### E\. .*)$/m, `$1\n${CONTRA_B}`);
    wa = wa.replace(/^## Boundaries$/m, `${WHOLE_SECTION}\n${DUP_RICH}\n${DUP_POOR}\n## Boundaries`);
    fs.writeFileSync(scratchV2, wa);
    // The REAL specimen from the BUG-042 incident, extracted from the WA itself so
    // the assertion tracks the canonical wording: the whole "separate agent
    // PROCESS, never one of your own subagents" block must survive VERBATIM.
    const specStart = wa.indexOf('- **A separate agent PROCESS');
    const specEnd = wa.indexOf('- **Clean room', specStart);
    const SPECIMEN = specStart >= 0 && specEnd > specStart ? wa.slice(specStart, specEnd).trimEnd() : null;

    const commitsBefore = Number(git(SCRATCH, ['rev-list', '--count', 'HEAD']).stdout.trim());
    const r7 = run('wa-consolidate.mjs', ['--apply', '--conventions-dir', CONVPROJ], METH);
    console.log(indent(r7.out));
    const wa7 = fs.readFileSync(scratchV2, 'utf8');
    const commitsAfter = Number(git(SCRATCH, ['rev-list', '--count', 'HEAD']).stdout.trim());
    const changelogPath = path.join(SCRATCH, 'CHANGELOG.md');
    const clog = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : '';
    const conv = fs.existsSync(conventionsFile) ? fs.readFileSync(conventionsFile, 'utf8') : '';
    let rail = { findings: [] };
    try { rail = JSON.parse(fs.readFileSync(path.join(SCRATCH, '.station', 'needs-human.json'), 'utf8')); } catch { /* asserted below */ }
    const railTypes = (rail.findings || []).map((f) => f.type);

    check('T7a --apply exited 0', r7.code === 0, `exit=${r7.code}`);
    check(
      'T7b RELOCATE: WHOLE unambiguous section §W moved into owning project docs/CONVENTIONS.md',
      /Station-local tooling defaults/.test(conv) && /Serena symbol tools/.test(conv) && /ast-grep/.test(conv),
      `${conventionsFile} has title=${/Station-local tooling defaults/.test(conv)} Serena=${/Serena symbol tools/.test(conv)} ast-grep=${/ast-grep/.test(conv)}`,
    );
    check(
      'T7c RELOCATE: §W body gone from the WA; heading kept with a pointer stub (§letter stays resolvable)',
      !/Serena symbol tools/.test(wa7) && /### W\./.test(wa7) && /Relocated to .*CONVENTIONS\.md/.test(wa7),
      `wa Serena=${/Serena symbol tools/.test(wa7)} §W heading=${/### W\./.test(wa7)} stub=${/Relocated to .*CONVENTIONS\.md/.test(wa7)}`,
    );
    check(
      'T7d BUG-042: universal bullet citing a product as an e.g.-EXAMPLE survives VERBATIM (not relocated)',
      wa7.includes(EXAMPLE_UNIV) && !/Orchard/.test(conv),
      `inWA=${wa7.includes(EXAMPLE_UNIV)} inConv=${/Orchard/.test(conv)}`,
    );
    check(
      'T7e BUG-042: the REAL "separate agent PROCESS, never one of your own subagents" specimen survives VERBATIM',
      SPECIMEN !== null && wa7.includes(SPECIMEN),
      SPECIMEN ? `specimen ${SPECIMEN.length} chars, present=${wa7.includes(SPECIMEN)}` : 'SPECIMEN NOT FOUND in scratch WA — extraction failed',
    );
    check(
      'T7f DEMOTION: partial project-flavored block NOT relocated — surfaced as needs-human relocation-candidate',
      wa7.includes(RELOC_CAND) && !/btrfs/.test(conv) && /relocation-candidate/.test(r7.out) && /btrfs/.test(r7.out),
      `stillInWA=${wa7.includes(RELOC_CAND)} inConv=${/btrfs/.test(conv)} surfaced=${/relocation-candidate/.test(r7.out)}`,
    );
    check(
      'T7g MERGE: poorer §Z now a pointer to richer §Y; richer §Y wording kept',
      /Merged into §Y/.test(wa7) && /identical results/.test(wa7),
      `pointer=${/Merged into §Y/.test(wa7)} richer-kept=${/identical results/.test(wa7)}`,
    );
    check(
      'T7h CONTRADICTION NOT auto-applied: BOTH opposing bullets still in the WA',
      wa7.includes(CONTRA_A) && wa7.includes(CONTRA_B),
      `alwaysPresent=${wa7.includes(CONTRA_A)} neverPresent=${wa7.includes(CONTRA_B)}`,
    );
    check(
      'T7i contradiction listed as needs-human in the run output',
      /NEEDS HUMAN/i.test(r7.out) && /contradiction/i.test(r7.out) && /flaky-suite/.test(r7.out),
      'needs-human contradiction reported',
    );
    check(
      'T7j CHANGELOG NAMES each relocated rule explicitly + needs-human section (BUG-042 point 3)',
      /automated consolidation pass/.test(clog) && /relocate: §W/.test(clog) &&
        /Use Serena symbol tools/.test(clog) && /Needs human/.test(clog),
      `pass entry=${/automated consolidation pass/.test(clog)} names rule=${/Use Serena symbol tools/.test(clog)}`,
    );
    check(
      'T7k RAIL: applied relocation AND the candidate both land in needs-human.json (relocation-applied + relocation-candidate)',
      railTypes.includes('relocation-applied') && railTypes.includes('relocation-candidate'),
      `rail types=${JSON.stringify([...new Set(railTypes)])}`,
    );
    check(
      'T7l git: snapshot commit + ONE apply commit (rollback is one revert); tree clean for WA+CHANGELOG',
      commitsAfter === commitsBefore + 2 &&
        git(SCRATCH, ['status', '--porcelain', '--', V2, 'CHANGELOG.md']).stdout.trim() === '',
      `commits ${commitsBefore} -> ${commitsAfter}; porcelain(WA,CHANGELOG)="${git(SCRATCH, ['status', '--porcelain', '--', V2, 'CHANGELOG.md']).stdout.trim()}"`,
    );
    check(
      'T7m apply commit message summarizes the pass',
      /WA consolidation \(auto\)/.test(git(SCRATCH, ['log', '-1', '--format=%s']).stdout),
      git(SCRATCH, ['log', '-1', '--format=%s']).stdout.trim(),
    );
    check(
      'T7n mirror synced after apply (mirror == consolidated scratch canonical)',
      fs.readFileSync(mirrorPath, 'utf8') === wa7,
      `mirror ${bytes(mirrorPath)}B == canonical ${bytes(scratchV2)}B: ${fs.readFileSync(mirrorPath, 'utf8') === wa7}`,
    );

    console.log('\n=== T8: a second --apply pass is an honest NO-OP (idempotent; boot-safe) ===');
    const b8 = bytes(scratchV2);
    const r8 = run('wa-consolidate.mjs', ['--apply', '--conventions-dir', CONVPROJ, '--no-sync'], METH);
    console.log(indent(r8.out));
    const commits8 = Number(git(SCRATCH, ['rev-list', '--count', 'HEAD']).stdout.trim());
    check('T8a second apply exited 0', r8.code === 0, `exit=${r8.code}`);
    check(
      'T8b reports nothing auto-applicable; WA unchanged; NO new commit',
      /Nothing auto-applicable/i.test(r8.out) && bytes(scratchV2) === b8 && commits8 === commitsAfter,
      `bytes ${b8}==${bytes(scratchV2)}, commits ${commitsAfter}==${commits8}`,
    );

    console.log('\n=== T9: capture AUTO-TRIGGERS the mini-pass; a failing mini-pass never fails capture ===');
    const r9 = run(
      'wa-capture.mjs',
      ['--rule', 'Always state the observed value next to every PASS/FAIL line.', '--section', 'C'],
      METH,
    );
    console.log(indent(r9.out));
    check('T9a capture (with sync) exited 0', r9.code === 0, `exit=${r9.code}`);
    check(
      'T9b consolidation mini-pass ran automatically after capture+sync',
      /consolidation mini-pass/i.test(r9.out) && /wa-consolidate --apply/.test(r9.out),
      'mini-pass banner present in capture output',
    );
    // failure tolerance: a NON-GIT methodology dir makes --apply refuse (exit 2);
    // capture must still succeed.
    const SCRATCH2 = makeScratch(false);
    const r9b = run(
      'wa-capture.mjs',
      ['--rule', 'Never leave a spawned test server running after the suite ends.', '--section', 'C'],
      { METHODOLOGY_DIR: SCRATCH2 },
    );
    console.log(indent(r9b.out));
    check(
      'T9c mini-pass FAILED (non-git methodology dir refused) yet capture exited 0',
      r9b.code === 0 && /refusing --apply/.test(r9b.out) && /mini-pass exited 2/.test(r9b.out),
      `exit=${r9b.code}; refuse=${/refusing --apply/.test(r9b.out)}; tolerated=${/mini-pass exited 2/.test(r9b.out)}`,
    );
    fs.rmSync(SCRATCH2, { recursive: true, force: true });
  } finally {
    // Restore the real mirror (T2/T7/T9 legitimately wrote it, exactly as production would).
    if (mirrorSnapshot) fs.writeFileSync(mirrorPath, mirrorSnapshot);
  }

  console.log('\n=== T10: BOOT SEAM — a failed consolidation NEVER affects server startup ===');
  const port = await freePort();
  const bootData = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-wa-boot-'));
  const bogusMeth = path.join(bootData, 'no-such-methodology-dir');
  let bootOut = '';
  const server = spawn(process.execPath, [path.join(REPO_ROOT, 'src', 'server', 'index.ts')], {
    env: {
      ...process.env,
      PORT: String(port),
      CLAUDE_STATION_DATA: bootData,
      METHODOLOGY_DIR: bogusMeth, // consolidation pass MUST fail (exit 2)
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (bootOut += String(d)));
  server.stderr.on('data', (d) => (bootOut += String(d)));
  let status = 0;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    status = await httpGet(`http://127.0.0.1:${port}/`);
    if (status === 200) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  // give the (failing) consolidation child a moment to be reported
  const logDeadline = Date.now() + 10000;
  while (Date.now() < logDeadline && !/WA consolidation pass/.test(bootOut)) {
    await new Promise((r) => setTimeout(r, 300));
  }
  const statusAfter = await httpGet(`http://127.0.0.1:${port}/`);
  check('T10a server booted and serves HTTP 200 on a free port (never :4317)', status === 200, `GET / -> ${status} on :${port}`);
  check(
    'T10b consolidation failure logged honestly (exit 2, "server unaffected")',
    /WA consolidation pass failed \(exit 2\)/.test(bootOut),
    (bootOut.match(/\[claude-station\] WA consolidation pass[^\n]*/) || ['(no consolidation log line)'])[0],
  );
  check('T10c server STILL serving after the failed pass', statusAfter === 200, `GET / -> ${statusAfter}`);
  // kill by pid (§ constraints) and wait for exit
  server.kill('SIGTERM');
  await new Promise((resolve) => {
    const t = setTimeout(() => {
      server.kill('SIGKILL');
      resolve();
    }, 5000);
    server.on('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
  fs.rmSync(bootData, { recursive: true, force: true });

  console.log('\n=== T6: the REAL canonical repo is provably untouched ===');
  const realGitAfter = git(REAL_METH, ['status', '--porcelain']).stdout;
  check('T6a real canonical WA byte length unchanged', bytes(realV2) === realBytesBefore, `${realBytesBefore} == ${bytes(realV2)} bytes`);
  check('T6b real methodology git status unchanged (clean vs. baseline)', realGitAfter === realGitBefore, `porcelain len before=${realGitBefore.length} after=${realGitAfter.length}`);
  check('T6c real mirror restored to its original bytes', mirrorSnapshot ? Buffer.compare(fs.readFileSync(mirrorPath), mirrorSnapshot) === 0 : true, 'mirror restored');

  // cleanup scratch
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.rmSync(CONVPROJ, { recursive: true, force: true });

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) {
    console.log(`FAILED: ${failures.join(' | ')}`);
    process.exit(1);
  }
  console.log('ALL PASS — FEAT-019 capture + automatic consolidation verified (real canonical repo untouched).');
  process.exit(0);
}

main().catch((err) => {
  if (mirrorSnapshot) fs.writeFileSync(mirrorPath, mirrorSnapshot);
  console.error('FATAL:', err);
  process.exit(1);
});
