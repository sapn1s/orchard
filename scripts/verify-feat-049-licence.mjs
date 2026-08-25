#!/usr/bin/env node
/**
 * verify-feat-049-licence.mjs — the licence, and the one hole cut in the gate.
 *
 * FEAT-049 landed two things that can fail quietly and expensively:
 *
 *   1. A LICENCE CLAIM. A wrong SPDX id is worse than no id, because tooling
 *      believes it. A licence body that is not verbatim is a bespoke licence
 *      wearing a recognisable name — the exact outcome the licence was chosen
 *      to avoid. A README that contradicts the LICENSE file is a licence
 *      dispute waiting to happen.
 *   2. A DELIBERATE EXEMPTION IN THE LEAK GATE. `scripts/leak-gate.mjs` now
 *      waives one token on one line of one file, so the copyright holder can
 *      be named. That is the correct call and it is also the single most
 *      dangerous line in the gate, because publishing is irreversible. Most
 *      of this file is adversarial pressure on that exemption: every near-miss
 *      that MUST still fail. The waiver covers the HANDLE and nothing else —
 *      the notice deliberately carries no email address at all, so there is no
 *      second identity for it to cover.
 *
 * WHAT IS REAL vs SYNTHETIC HERE. The licence-claim checks (A) read the REAL
 * LICENSE, README.md and package.json at the repo root — no fixture. The gate
 * checks (B) take those REAL files, copy them into a scratch tree, and mutate
 * ONE thing per case; the gate is then run in TREE mode against that tree. The
 * mutations are synthetic by necessity (the leak must not exist in the repo to
 * be tested), but every one of them starts from the real artifact rather than
 * a minimal hand-built stand-in.
 *
 * Upstream text: the LICENSE body is compared against a cached copy of the
 * PolyForm steward's own markdown, fetched at authoring time and cross-checked
 * byte-for-byte (modulo line wrapping) against the SPDX license-list entry.
 * The cache lives beside this script so the check is OFFLINE and deterministic;
 * pass --refetch to re-verify against the network.
 *
 * Never touches :4317, the service, or any scope. Scratch under ~/scratch.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const GATE = path.join(REPO, 'scripts', 'leak-gate.mjs');
const SPDX_ID = 'PolyForm-Noncommercial-1.0.0';
const REFETCH = process.argv.includes('--refetch');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

/** Run the leak gate over a tree. Returns { code, out }. */
function runGate(tree) {
  // spawnSync, not execFileSync: both streams must be read. The waiver notice
  // is on stdout and the hit listing on stderr, so a harness that captured only
  // one of them would grade the wrong half of the gate's answer.
  const r = spawnSync(process.execPath, [GATE, tree], { encoding: 'utf8' });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const scratchRoot = fs.mkdtempSync(path.join(os.homedir(), 'scratch', 'feat049-licence-'));
const trees = [];
/**
 * Build a scratch tree from the REAL repo files, then apply `mutate` to it.
 * The tree deliberately carries the real LICENSE/README/package.json, so a
 * case only differs from reality in the one way it is testing.
 */
function tree(name, mutate) {
  const dir = path.join(scratchRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['LICENSE', 'README.md', 'package.json']) {
    fs.copyFileSync(path.join(REPO, f), path.join(dir, f));
  }
  if (mutate) mutate(dir);
  trees.push(dir);
  return dir;
}
const HANDLE = 'sa' + 'pn1s';           // split so this verifier does not trip the gate
const HOME = '/ho' + 'me/' + 'sa' + 'p';
const NOTICE_RE = /^Required Notice: Copyright \d{4} /m;

try {
  // ---------------------------------------------------------------- A. claim
  console.log('\nA. The licence claim (real files at the repo root)');

  const licPath = path.join(REPO, 'LICENSE');
  check('(A1) LICENSE exists at the repository root', fs.existsSync(licPath));
  const lic = fs.existsSync(licPath) ? fs.readFileSync(licPath, 'utf8') : '';

  const cachePath = path.join(import.meta.dirname, 'fixtures', 'polyform-noncommercial-1.0.0.md');
  let upstream = fs.existsSync(cachePath) ? fs.readFileSync(cachePath, 'utf8') : null;
  if (REFETCH) {
    const res = await fetch('https://api.github.com/repos/polyformproject/polyform-licenses/contents/PolyForm-Noncommercial-1.0.0.md');
    const j = await res.json();
    const fetched = Buffer.from(j.content, 'base64').toString('utf8');
    check('(A2r) --refetch: steward text still matches the cached copy', fetched === upstream);
    upstream = fetched;
  }
  check('(A2) cached upstream PolyForm text is present', Boolean(upstream));

  // The body is everything after the Required Notice preamble. It must be the
  // upstream licence EXACTLY — one altered word makes this a bespoke licence.
  const body = upstream && lic.endsWith(upstream) ? upstream : null;
  check('(A3) LICENSE body is the upstream PolyForm text VERBATIM (byte-for-byte)', body !== null,
    body === null ? 'LICENSE tail does not equal the steward text' : '');

  check('(A4) LICENSE carries a PolyForm-form Required Notice naming the licensor',
    NOTICE_RE.test(lic) && lic.split('\n')[0].includes(HANDLE));
  // FEAT-049 follow-up: the notice carries NO email address. The GitHub noreply address
  // that used to sit here is DELIBERATELY undeliverable (mail to it bounces
  // with "domain couldn't be found"), so a licence whose whole point is
  // "commercial use by request" published no way to make the request. The fix
  // is not a different address — a personal address in a public LICENSE is
  // permanent and scraped — it is a channel: the repository itself.
  const notice = lic.split('\n')[0];
  const EMAIL_RE = /[\w.+-]+@[\w.-]+\.\w{2,}/;
  check('(A5) the Required Notice carries NO email address at all',
    !EMAIL_RE.test(notice), `found '${notice.match(EMAIL_RE)?.[0] ?? ''}'`);
  check('(A5b) no undeliverable noreply address anywhere in LICENSE',
    !lic.includes('users.noreply.github.com'));
  check('(A5c) no personal address anywhere in LICENSE', !/sa[p]tional/.test(lic));
  check('(A5d) the notice names a REACHABLE channel (the repository URL)',
    /https:\/\/github\.com\/[\w.-]+\/[\w.-]+/.test(notice));
  check('(A5e) the notice says commercial use is by request, and how to ask',
    /commercial use/i.test(notice) && /open an issue/i.test(notice));
  check('(A6) nothing precedes the licence body except the notice',
    lic.length - (upstream?.length ?? 0) === lic.indexOf('# PolyForm'));

  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  check('(A7) package.json declares the licence', typeof pkg.license === 'string' && pkg.license.length > 0);
  check(`(A8) the id is the real SPDX id '${SPDX_ID}'`, pkg.license === SPDX_ID, `got '${pkg.license}'`);
  // The trap the ticket called out: LicenseRef- is the SPDX namespace for
  // licences that are NOT on the list. PolyForm Noncommercial IS on the list
  // (it is merely not OSI-approved, which is a different property), so a
  // LicenseRef- form would tell tooling the opposite of the truth.
  check('(A9) the id is NOT a LicenseRef- expression (this licence IS on the SPDX list)',
    !/^LicenseRef-/i.test(pkg.license ?? ''));
  check('(A10) package.json stays private:true (an app you clone, never an npm package)',
    pkg.private === true);
  // npm's own reader, not our JSON.parse — this is what tooling downstream sees.
  // (npm returns a single field unquoted and multiple fields as JSON, hence the
  // tolerant strip rather than an exact-quoted compare.)
  check('(A11) npm can read the license field back', (() => {
    const got = execFileSync('npm', ['pkg', 'get', 'license'], { cwd: REPO, encoding: 'utf8' }).trim().replace(/^"|"$/g, '');
    return got === SPDX_ID;
  })());

  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  check('(A12) README names the same licence as package.json', readme.includes(SPDX_ID));
  check('(A13) README states what a reader MAY and MAY NOT do', /may\b/i.test(readme) && /may not\b/i.test(readme));
  check('(A14) README says how to ask about commercial use', /commercial use[^.]*open an issue/i.test(readme));
  check('(A15) README links the LICENSE file', /\]\(LICENSE\)/.test(readme));
  // Two documents disagreeing about how to obtain commercial terms is worse
  // than one being terse: the README must route to the SAME channel as the
  // notice, and must not advertise an address the notice no longer carries.
  const readmeLicence = readme.slice(readme.indexOf('## Licence'));
  check('(A15b) README routes commercial enquiries to the same repository the notice names',
    (() => {
      const repo = notice.match(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)/)?.[1];
      return Boolean(repo) && /open an issue on this\s+repository/i.test(readmeLicence);
    })());
  check('(A15c) README publishes no email address for licensing either',
    !EMAIL_RE.test(readmeLicence), readmeLicence.match(EMAIL_RE)?.[0] ?? '');

  // No contradicting claim anywhere in the tracked tree.
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' }).split('\0').filter(Boolean);
  const OTHER = /\b(MIT License|Apache License, Version 2\.0|GNU General Public License|BSD 3-Clause|Mozilla Public License)\b/;
  const contradictions = [];
  for (const rel of tracked) {
    if (rel === 'package-lock.json' || rel.startsWith('node_modules/')) continue;
    const abs = path.join(REPO, rel);
    if (!fs.existsSync(abs) || !fs.lstatSync(abs).isFile()) continue;
    const buf = fs.readFileSync(abs);
    if (buf.includes(0) || buf.length > 2_000_000) continue;
    const txt = buf.toString('utf8');
    // A ticket DISCUSSING another project's licence is fine; a file CLAIMING
    // one for this project is not. Only flag files whose own text grants.
    if (OTHER.test(txt) && /\b(this (software|project|program)|Orchard) is (licensed|released|distributed) under\b/i.test(txt)) {
      contradictions.push(rel);
    }
  }
  check('(A16) no tracked file claims a different licence for this project',
    contradictions.length === 0, contradictions.join(', '));

  // ------------------------------------------------- B. the gate's exemption
  console.log('\nB. The leak-gate exemption is exactly one line of one file');

  const ctl = tree('control');
  const r0 = runGate(ctl);
  check('(B1) CONTROL: the real LICENSE passes the gate', r0.code === 0, `exit ${r0.code}`);
  check('(B2) the waiver is REPORTED, never silent', /waived LICENSE:1: \[github handle\]/.test(r0.out),
    'gate passed without announcing the exemption');
  // FEAT-049 follow-up: the waiver exists ONLY because the handle is the licensor's name
  // on that line. It must still be load-bearing, and it must waive nothing
  // beyond that: with the handle gone from the notice, the gate passes and
  // waives NOTHING. A waiver that keeps firing after its reason disappeared is
  // a hole surviving on inertia.
  check('(B2b) the waiver is load-bearing: the real notice DOES contain the waived token',
    fs.readFileSync(path.join(ctl, 'LICENSE'), 'utf8').split('\n')[0].includes(HANDLE));
  const noHandle = tree('nohandle', (d) => {
    const p = path.join(d, 'LICENSE');
    const l = fs.readFileSync(p, 'utf8').split('\n');
    l[0] = 'Required Notice: Copyright 2026 The Licensor (https://example.com)';
    fs.writeFileSync(p, l.join('\n'));
    // README names the handle only via the repo URL; strip it too so this tree
    // isolates the waiver rather than tripping on an unrelated hit.
    const rp = path.join(d, 'README.md');
    fs.writeFileSync(rp, fs.readFileSync(rp, 'utf8').split(HANDLE).join('licensor'));
  });
  const rNo = runGate(noHandle);
  check('(B2c) with no handle on the notice, the gate passes and waives NOTHING',
    rNo.code === 0 && !/waived/.test(rNo.out), `exit ${rNo.code}`);

  // Must-FAIL battery. Each mutates ONE thing off the real artifact.
  const mustFail = [
    ['(B3) the same handle on a LATER line of LICENSE still FAILS', (d) => {
      fs.appendFileSync(path.join(d, 'LICENSE'), `\nContact ${HANDLE} for commercial terms.\n`);
    }],
    ['(B4) the handle in README still FAILS', (d) => {
      fs.appendFileSync(path.join(d, 'README.md'), `\nMaintained by ${HANDLE}.\n`);
    }],
    ['(B5) a Required-Notice-SHAPED line in another file still FAILS', (d) => {
      fs.writeFileSync(path.join(d, 'NOTICE'), `Required Notice: Copyright 2026 ${HANDLE}\n`);
    }],
    ['(B6) the notice in LICENSE.md (not LICENSE) still FAILS', (d) => {
      fs.writeFileSync(path.join(d, 'LICENSE.md'), `Required Notice: Copyright 2026 ${HANDLE}\n`);
    }],
    ['(B7) a lowercase `license` file does NOT inherit the exemption', (d) => {
      fs.writeFileSync(path.join(d, 'license'), `Required Notice: Copyright 2026 ${HANDLE}\n`);
    }],
    ['(B8) a nested LICENSE deeper in the tree does NOT inherit it', (d) => {
      fs.mkdirSync(path.join(d, 'vendor'), { recursive: true });
      fs.writeFileSync(path.join(d, 'vendor', 'LICENSE'), `Required Notice: Copyright 2026 ${HANDLE}\n`);
    }],
    ['(B9) a DIFFERENT token on the waived line still FAILS (waiver is per-token)', (d) => {
      const p = path.join(d, 'LICENSE');
      const l = fs.readFileSync(p, 'utf8').split('\n');
      l[0] = `Required Notice: Copyright 2026 ${HANDLE}, ${HOME}/projects/orchard`;
      fs.writeFileSync(p, l.join('\n'));
    }],
    // The gate's `email` token is the LOCAL PART only (leak-gate.mjs: 'sa'+'ptional'),
    // so the real mail domain contributed nothing to what this check proves — it only
    // made a complete, scrapable address out of a token the gate ships split on purpose.
    // The domain is synthetic per docs/CONVENTIONS.md; a real address in a published
    // script is exactly as permanent as one in a published LICENSE.
    ['(B10) the PERSONAL email on the waived line still FAILS', (d) => {
      const p = path.join(d, 'LICENSE');
      const l = fs.readFileSync(p, 'utf8').split('\n');
      l[0] = `Required Notice: Copyright 2026 ${'sa' + 'ptional'}@example.invalid`;
      fs.writeFileSync(p, l.join('\n'));
    }],
    ['(B11) a line that only LOOKS like the notice (wrong prefix) still FAILS', (d) => {
      const p = path.join(d, 'LICENSE');
      const l = fs.readFileSync(p, 'utf8').split('\n');
      l[0] = `# Required Notice: Copyright 2026 ${HANDLE}`;
      fs.writeFileSync(p, l.join('\n'));
    }],
    ['(B12) a notice with no year (shape not matched) still FAILS', (d) => {
      const p = path.join(d, 'LICENSE');
      const l = fs.readFileSync(p, 'utf8').split('\n');
      l[0] = `Required Notice: Copyright ${HANDLE}`;
      fs.writeFileSync(p, l.join('\n'));
    }],
    ['(B13) an unrelated private token elsewhere in the tree still FAILS', (d) => {
      fs.writeFileSync(path.join(d, 'notes.md'), 'see the sa' + 'asis bot project\n');
    }],
  ];
  for (const [name, mut] of mustFail) {
    const d = tree(name.slice(1, 4).replace(/\W/g, ''), mut);
    const r = runGate(d);
    check(name, r.code === 1, `expected exit 1, got ${r.code}`);
  }

  // The gate must still be the publish script's hard stop.
  const pub = fs.readFileSync(path.join(REPO, 'scripts', 'publish-public-mirror.sh'), 'utf8');
  check('(B14) the publish script still runs leak-gate.mjs as a hard gate', /leak-gate\.mjs/.test(pub));

  // And REPO mode (what `npm run gate` uses) must agree with TREE mode.
  const repoMode = (() => {
    try { execFileSync(process.execPath, [GATE, '--summary'], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); return 0; }
    catch (e) { return e.status ?? -1; }
  })();
  check('(B15) REPO mode (npm run gate) passes with the real LICENSE present', repoMode === 0, `exit ${repoMode}`);

  // The waiver must be visible in the SANCTIONED entry point, not only when
  // someone runs leak-gate.mjs by hand. `npm run gate` prints one line per gate
  // and is otherwise silent on PASS, so a waiver could hide there — it did,
  // until this check existed.
  const gateRun = spawnSync('npm', ['run', '--silent', 'gate'], { cwd: REPO, encoding: 'utf8' });
  check('(B16) `npm run gate` SURFACES the waiver (a waiver nobody sees is nobody-reviewed)',
    gateRun.status === 0 && /waived LICENSE:1/.test(`${gateRun.stdout}${gateRun.stderr}`),
    `exit ${gateRun.status}`);

  // -------------------------------------------------- C. the rename is honest
  console.log('\nC. The rename says what it did and did not do');
  check('(C1) package.json is named orchard', pkg.name === 'orchard');
  const lock = JSON.parse(fs.readFileSync(path.join(REPO, 'package-lock.json'), 'utf8'));
  check('(C2) package-lock name matches package.json (npm ci would refuse otherwise)',
    lock.name === pkg.name && lock.packages?.['']?.name === pkg.name);
  const srcFiles = tracked.filter((f) => f.startsWith('src/') && /\.(ts|mjs|js)$/.test(f));
  const oldPrefix = srcFiles.filter((f) => fs.readFileSync(path.join(REPO, f), 'utf8').includes('[claude-station]'));
  check('(C3) no [claude-station] log prefix remains in src/', oldPrefix.length === 0, oldPrefix.join(', '));
  // The migration-side names MUST still be intact — a half-rename that moved
  // them would strand the user's registry, sessions, containers and unit.
  const paths = fs.readFileSync(path.join(REPO, 'src', 'lib', 'paths.ts'), 'utf8');
  check('(C4) the data dir basename is UNCHANGED (renaming it strands the registry)',
    /path\.join\(base, 'claude-station'\)/.test(paths));
  check('(C5) the CLAUDE_STATION_DATA knob is UNCHANGED', paths.includes('CLAUDE_STATION_DATA'));
  const surv = fs.readFileSync(path.join(REPO, 'src', 'server', 'survival.ts'), 'utf8');
  check('(C6) the systemd scope prefix is UNCHANGED (live hosts are adopted by it)',
    surv.includes('claude-station-host-'));
  const cm = fs.readFileSync(path.join(REPO, 'src', 'server', 'container-manager.ts'), 'utf8');
  check('(C7) docker image repo + label namespace UNCHANGED (existing containers stay visible)',
    cm.includes("'claude-station-base'") && cm.includes("'claude-station=1'"));
  check('(C8) deploy/ unit file still exists under its installed name',
    fs.existsSync(path.join(REPO, 'deploy', 'claude-station.service')));
  check('(C9) README explains WHY the old name survives in stored-state identifiers',
    /systemd unit[\s\S]{0,200}data directory/i.test(readme) && /Claude Station before it was called Orchard/.test(readme));

} finally {
  for (const d of trees) fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(scratchRoot, { recursive: true, force: true });
}

console.log(`\nFEAT-049 licence + gate-exemption: ${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
