#!/usr/bin/env node
/**
 * verify-leak-write-guard.mjs — proves the authoring-time private-token guard on
 * board-tool.mjs `file`/`update`.
 *
 * Every leaky needle in THIS file is built by concatenation at runtime
 * (the home-path and bare-username tokens are assembled from split fragments) so
 * the source never carries a literal token and never trips the very gate it
 * exercises — the same self-immunity convention leak-gate uses.
 *
 * MUST-FAIL: the identical leaky write is run against the HEAD version of
 * board-tool.mjs (extracted to a temp file), and it MUST succeed there — proving
 * the guard is the thing that changed, not the fixture.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';

import { mkdtempScratch } from './lib/scratch.mjs';
import { boardTool } from './board-tool.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const REAL_BOARD = path.join(REPO, 'docs', 'bugs');

// Needles assembled at runtime — literal never appears in this source.
const HOME = '/home/' + 'sa' + 'p';                 // home path token
const USER = 'sa' + 'p';                            // bare username token
const PROJ = 'saa' + 'sis';                         // private project A token

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (s) => console.log(`\n${s}`);
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

const scratch = mkdtempScratch('leak-write-guard-');
const ROOT = path.join(scratch, 'repo');
const BOARD = path.join(ROOT, 'docs', 'bugs');

function setup() {
  fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
  fs.cpSync(REAL_BOARD, BOARD, { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'package.json'), `${JSON.stringify({ name: 'scratch-board', private: true, type: 'module' }, null, 2)}\n`);
  git(ROOT, ['init', '-q', '-b', 'main']);
  git(ROOT, ['config', 'user.email', 'suite@example.invalid']);
  git(ROOT, ['config', 'user.name', 'leak guard suite']);
  git(ROOT, ['add', '--', 'docs', 'package.json']);
  git(ROOT, ['commit', '-q', '-m', 'scratch: a copy of the real board']);
}

const call = (...argv) => boardTool(argv, { root: ROOT });
// A fully VALID record (validation runs before the leak scan, exactly as a real
// board-tool leak — BUG-155 — was a valid ticket). The needle lives in `body`.
const fileJson = (title, body) => `--json=${JSON.stringify({
  type: 'bug', title, body,
  summary: 'A scratch-repo fixture proving the authoring-time private-token guard on the board tool.',
  impact_if_we_wait: 'Nothing; this ticket exists only inside a throwaway board copy deleted when the suite finishes.',
  current_need: 'Nothing — it is a fixture.',
  severity: 'low', area: 'test',
  success_criteria: ['A leaky ticket write is refused; a clean one lands.'], verification_class: 'exempt',
})}`;
const ticketFilesNow = () => fs.readdirSync(BOARD).filter((f) => /^(BUG|FEAT|ARCH|DEPLOY)-\d+/.test(f));

async function main() {
  setup();

  section('1. file: a home path in the body is REFUSED and nothing is written');
  const before1 = new Set(ticketFilesNow());
  const r1 = await call('file', fileJson('panel inspection', `Read the real repo at ${HOME}/projects/x — HEAD is clean.`));
  ok('refused', r1.ok === false && r1.refusal?.code === 'private-token-leak', JSON.stringify(r1.refusal ?? r1).slice(0, 200));
  ok('refusal names the offending token class', (r1.refusal?.detail ?? []).some((d) => d.includes('home path')));
  ok('no ticket file was written', ticketFilesNow().filter((f) => !before1.has(f)).length === 0);

  section('2. file: a bare username is REFUSED');
  const r2 = await call('file', fileJson('username case', `Reported by user ${USER} on the git panel.`));
  ok('refused (username)', r2.ok === false && r2.refusal?.code === 'private-token-leak', JSON.stringify(r2.refusal ?? '').slice(0, 160));
  ok('names the username token', (r2.refusal?.detail ?? []).some((d) => d.includes('username')));

  section('3. file: a private project name is REFUSED');
  const r3 = await call('file', fileJson('project case', `Committed through the panel on the ${PROJ}-bot repo.`));
  ok('refused (private project)', r3.ok === false && r3.refusal?.code === 'private-token-leak', JSON.stringify(r3.refusal ?? '').slice(0, 160));
  ok('names the private-project token', (r3.refusal?.detail ?? []).some((d) => d.toLowerCase().includes('private project')));

  section('4. file: a CLEAN ticket lands unchanged');
  const before4 = new Set(ticketFilesNow());
  const cleanBody = 'Read the real repo at `~/projects/example` — HEAD is clean, no upstream on the branch. Reported by the user.';
  const r4 = await call('file', fileJson('git panel goes quiet with no upstream', cleanBody));
  ok('clean write ok', r4.ok === true, JSON.stringify(r4.refusal ?? '').slice(0, 200));
  const added = ticketFilesNow().filter((f) => !before4.has(f));
  ok('exactly one ticket file appeared', added.length === 1, `added=${JSON.stringify(added)}`);
  if (added.length === 1) {
    const txt = fs.readFileSync(path.join(BOARD, added[0]), 'utf8');
    ok('the body survived verbatim', txt.includes(cleanBody));
  }

  section('5. file: a ticket DISCUSSING the token shapes (no literals) is NOT blocked');
  // Legitimate: it names the token CLASSES and describes the redaction, exactly
  // as a ticket about the leak gate would — without pasting any literal value.
  const metaBody = 'The guard refuses a ticket carrying a home path (redact to `~`), the bare username token, '
    + 'or a private project name (use a neutral description). Detection reuses the leak-gate token list.';
  const r5 = await call('file', fileJson('describe the leak guard behaviour', metaBody));
  ok('meta-discussion write ok', r5.ok === true, JSON.stringify(r5.refusal ?? '').slice(0, 200));

  section('6. update --log carrying a leak is REFUSED; a clean log lands');
  const target = r4.id; // the clean ticket we just filed
  const rl1 = await call('update', `--id=${target}`, `--log=Inspected ${HOME}/projects/x read-only.`, '--log-author=suite');
  ok('leaky --log refused', rl1.ok === false && rl1.refusal?.code === 'private-token-leak', JSON.stringify(rl1.refusal ?? '').slice(0, 160));
  const rl2 = await call('update', `--id=${target}`, '--log=Inspected the repo read-only; the commit had landed.', '--log-author=suite');
  ok('clean --log lands', rl2.ok === true, JSON.stringify(rl2.refusal ?? '').slice(0, 200));

  section('7. update --current-need carrying a leak is REFUSED');
  const rc = await call('update', `--id=${target}`, `--current-need=Push from ${HOME}/projects/x`);
  ok('leaky --current-need refused', rc.ok === false && rc.refusal?.code === 'private-token-leak', JSON.stringify(rc.refusal ?? '').slice(0, 160));

  section('8. MUST-FAIL: the SAME leaky file write SUCCEEDS on the HEAD board-tool');
  // Extract HEAD's board-tool.mjs beside the real scripts/ so its relative imports
  // resolve, import it, and run case-1's write. It must land (no guard existed).
  const headSrc = spawnSync('git', ['show', 'HEAD:scripts/board-tool.mjs'], { cwd: REPO, encoding: 'utf8' });
  ok('extracted HEAD board-tool.mjs', headSrc.status === 0 && headSrc.stdout.length > 1000);
  const headFile = path.join(HERE, `.verify-head-board-tool-${process.pid}.mjs`);
  let headOk = false;
  try {
    fs.writeFileSync(headFile, headSrc.stdout);
    const headMod = await import(url.pathToFileURL(headFile).href);
    const before8 = new Set(ticketFilesNow());
    const r8 = await headMod.boardTool(['file', fileJson('head leaky write', `Read the real repo at ${HOME}/projects/x.`)], { root: ROOT });
    const added8 = ticketFilesNow().filter((f) => !before8.has(f));
    headOk = r8.ok === true && added8.length === 1;
    ok('HEAD writes the leaky ticket WITHOUT complaint (guard is the change)', headOk, JSON.stringify(r8.refusal ?? `added=${added8.length}`).slice(0, 200));
    if (added8.length === 1) {
      const leaked = fs.readFileSync(path.join(BOARD, added8[0]), 'utf8');
      ok('the HEAD-written ticket actually contains the leak', leaked.includes(HOME));
    }
  } finally {
    fs.rmSync(headFile, { force: true });
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
