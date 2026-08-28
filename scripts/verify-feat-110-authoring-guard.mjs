#!/usr/bin/env node
/**
 * verify-feat-110-authoring-guard.mjs — FEAT-110 round 2.
 *
 * Proves the authoring-PATH-INDEPENDENT ticket-leak guard
 * (scripts/hooks/ticket-leak-gate.mjs): a changed ticket carrying a private
 * token cannot end a turn, NO MATTER which tool wrote it, while a clean ticket
 * and a ticket that legitimately DISCUSSES a token shape are not blocked.
 *
 * The hook operates on a git working tree (it scans `git status`-changed ticket
 * files under the board dir), so this suite drives it exactly as Claude Code
 * would: a real scratch git repo, a real committed-clean board, a real dirty
 * ticket authored through each path, and the hook binary invoked with a crafted
 * Stop payload on stdin. Nothing here touches the real board, the live service,
 * port 4317, or /tmp — scratch lives under ~/scratch and is torn down at the end.
 *
 * The private token literals are BUILT AT RUNTIME by concatenation (never pasted)
 * so THIS file does not trip the leak gate it exists to exercise — the same
 * self-immunity convention leak-tokens.mjs uses on itself.
 *
 * Contract asserted (verified against FEAT-085's Stop-hook suite):
 *   BLOCK = exit 0 AND stdout is {"decision":"block","reason":…} naming the hit.
 *   ALLOW = exit 0 AND stdout is empty (no re-prompt).
 *
 * Run: node scripts/verify-feat-110-authoring-guard.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(HERE, '..');
const HOOK = path.join(repoRoot, 'scripts', 'hooks', 'ticket-leak-gate.mjs');
const RESPONSE_HOOK = path.join(repoRoot, 'scripts', 'hooks', 'response-format-gate.mjs');

// Private-token literals, assembled so this source carries none of them verbatim.
const HOME = '/home/' + 'sa' + 'p';                 // [home path] + [username (bare word)]
const USER = 'sa' + 'p';                            // [username (bare word)]
const PROJ = 'saa' + 'sis';                         // [private project A]

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`PASS: ${label}`); }
  else { fail++; console.log(`FAIL: ${label}${detail ? ` — ${detail}` : ''}`); }
}

const scratchBase = path.join(os.homedir(), 'scratch');
fs.mkdirSync(scratchBase, { recursive: true });
const root = fs.mkdtempSync(path.join(scratchBase, 'feat110-guard-'));

function git(args, opts = {}) {
  return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', ...opts });
}

/** Drive the hook with a Stop payload; return {blocked, reason, status, stdout}. */
function runHook(hookPath, { stopHookActive = false, env = {} } = {}) {
  const payload = JSON.stringify({
    session_id: '0feat110-0000-4000-8000-000000000110',
    transcript_path: path.join(root, 'transcript.jsonl'),
    cwd: root,
    hook_event_name: 'Stop',
    stop_hook_active: stopHookActive,
  });
  const r = spawnSync('node', [hookPath], {
    input: payload,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  let decision = null, reason = null;
  const out = (r.stdout || '').trim();
  if (out) { try { const j = JSON.parse(out); decision = j.decision; reason = j.reason; } catch { /* non-JSON */ } }
  return { blocked: decision === 'block', reason: reason || '', status: r.status, stdout: out };
}

const boardDir = path.join(root, 'docs', 'bugs');
const ticketPath = (id) => path.join(boardDir, `${id}.md`);
function writeTicket(id, body) { fs.writeFileSync(ticketPath(id), body); }

/** A minimal, realistic ticket body with a Verification-artifacts bullet slot. */
function ticketBody(id, artifactLine) {
  return [
    `# ${id} — a scratch ticket for the leak-guard suite`,
    '',
    '- **Status:** OPEN — synthetic fixture.',
    '',
    '## Activity log (APPEND-ONLY — never edit or delete a prior entry)',
    '',
    '### 2026-08-27 — worker',
    `- **Verification artifacts:** ${artifactLine}`,
    '',
  ].join('\n');
}

try {
  // ── seed a real, committed-clean board ──────────────────────────────────────
  fs.mkdirSync(boardDir, { recursive: true });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'leak-guard test']);
  fs.writeFileSync(path.join(boardDir, 'INDEX.md'), '# Board\n\n(placeholder)\n');
  writeTicket('BUG-900', ticketBody('BUG-900', 'scripts/verify-x.mjs — clean baseline, repo-relative.'));
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'seed clean board']);

  // A committed-clean tree must not block (nothing changed this turn).
  {
    const r = runHook(HOOK);
    check('clean committed tree → ALLOW (no changed tickets)', !r.blocked && r.status === 0, r.stdout);
  }

  // ── AUTHORING PATH A — plain Write (fs.writeFileSync). THE BUG-157 PATH. ─────
  // Leaking: an absolute home path in the artifacts bullet.
  writeTicket('BUG-901', ticketBody('BUG-901', `\`${HOME}/projects/orchard/scripts/verify-bug-901.mjs\` (6/6 fixed).`));
  {
    const r = runHook(HOOK);
    check('path A (Write) leaking home path → BLOCK', r.blocked, r.stdout);
    check('path A block names the file + a token class + the line',
      r.reason.includes('BUG-901') && /\[(home path|username \(bare word\))\]/.test(r.reason) && r.reason.includes('verify-bug-901'),
      r.reason.slice(0, 200));
  }
  // Redacted (repo-relative) → the identical write, clean → ALLOW.
  writeTicket('BUG-901', ticketBody('BUG-901', '`scripts/verify-bug-901.mjs` (6/6 fixed).'));
  {
    const r = runHook(HOOK);
    check('path A (Write) redacted to repo-relative → ALLOW', !r.blocked, r.stdout);
  }
  // Legitimate DISCUSSION of the token shapes (describes the class, splits/omits
  // the literal) → must NOT be blocked.
  writeTicket('BUG-901', [
    '# BUG-901 — the leak gate mentions token shapes',
    '',
    '- **Status:** OPEN.',
    '',
    'This ticket is ABOUT the leak gate. It matches the `home path` class',
    '(a `/home/<user>` prefix) and the `username (bare word)` and',
    '`private project` classes. Describing the shape, never pasting a value.',
    '',
    '## Activity log (APPEND-ONLY — never edit or delete a prior entry)',
    '### 2026-08-27 — worker',
    '- Discusses the classes by name only.',
    '',
  ].join('\n'));
  {
    const r = runHook(HOOK);
    check('path A (Write) discusses token SHAPES/CLASSES only → ALLOW', !r.blocked, r.stdout);
  }
  // reset BUG-901 out of the way (delete + commit) so later cases are isolated
  fs.rmSync(ticketPath('BUG-901'));

  // ── AUTHORING PATH B — Edit (modify a committed-clean file in place). ────────
  writeTicket('BUG-902', ticketBody('BUG-902', '`scripts/verify-bug-902.mjs` (clean).'));
  git(['add', '-A']); git(['commit', '-q', '-m', 'add clean BUG-902']);
  {
    const r = runHook(HOOK);
    check('committed-clean after BUG-902 → ALLOW', !r.blocked, r.stdout);
  }
  // Edit introduces a private project name.
  const b902 = fs.readFileSync(ticketPath('BUG-902'), 'utf8')
    .replace('clean).', `clean, ran against the ${PROJ} bot project).`);
  fs.writeFileSync(ticketPath('BUG-902'), b902);
  {
    const r = runHook(HOOK);
    check('path B (Edit) introduces a private project name → BLOCK',
      r.blocked && r.reason.includes('BUG-902') && /private project/i.test(r.reason), r.reason.slice(0, 200));
  }
  git(['checkout', '-q', '--', ticketPath('BUG-902')]); // restore clean for isolation

  // ── AUTHORING PATH C — Bash heredoc (a real shell write). ────────────────────
  const c903 = ticketPath('BUG-903');
  const heredoc = `cat > ${JSON.stringify(c903)} <<EOF
# BUG-903 — authored by a shell heredoc
- Scratch dir kept: ${HOME}/scratch/bug-903/
EOF`;
  const shw = spawnSync('bash', ['-c', heredoc], { encoding: 'utf8' });
  check('path C setup: bash heredoc wrote the file', shw.status === 0 && fs.existsSync(c903), shw.stderr);
  {
    const r = runHook(HOOK);
    check('path C (Bash heredoc) leaking home path → BLOCK',
      r.blocked && r.reason.includes('BUG-903') && r.reason.includes('scratch/bug-903'), r.reason.slice(0, 200));
  }
  fs.rmSync(c903);

  // ── AUTHORING PATH D — board-tool (round-1 write-time guard). ────────────────
  // A leaking board-tool `file` write is refused AT WRITE TIME by the round-1
  // guard, so the file is never created; the hook then has nothing to block. This
  // proves the board-tool path is covered by its own guard and the two layers
  // agree. board-tool loads src/server/tickets.ts from the REAL tree, so point it
  // at a scratch BOARD via ORCHARD_BOARD_TOOL_ROOT (a scratch copy of the repo's
  // own docs/bugs in a scratch git repo — mirrors verify-board-tool.mjs).
  {
    const btRoot = fs.mkdtempSync(path.join(scratchBase, 'feat110-bt-'));
    const btBugs = path.join(btRoot, 'docs', 'bugs');
    fs.mkdirSync(btBugs, { recursive: true });
    const realBugs = path.join(repoRoot, 'docs', 'bugs');
    for (const f of fs.readdirSync(realBugs)) {
      const full = path.join(realBugs, f);
      if (fs.statSync(full).isFile()) fs.copyFileSync(full, path.join(btBugs, f));
    }
    spawnSync('git', ['-C', btRoot, 'init', '-q']);
    spawnSync('git', ['-C', btRoot, 'config', 'user.email', 't@e.invalid']);
    spawnSync('git', ['-C', btRoot, 'config', 'user.name', 't']);
    spawnSync('git', ['-C', btRoot, 'add', '-A']);
    spawnSync('git', ['-C', btRoot, 'commit', '-q', '-m', 'seed']);

    const leakBody = `Repro kept under ${HOME}/scratch/x/ — see it.`;
    const runBT = (json) => {
      const r = spawnSync('node', [path.join(repoRoot, 'scripts', 'board-tool.mjs'), 'file', `--json=${json}`],
        { encoding: 'utf8', env: { ...process.env, ORCHARD_BOARD_TOOL_ROOT: btRoot } });
      let out = {}; try { out = JSON.parse(r.stdout || '{}'); } catch { /* ignore */ }
      return out;
    };
    const validRecord = {
      type: 'bug', severity: 'low', area: 'test', summary: 'x',
      impact_if_we_wait: 'x', current_need: 'x', success_criteria: ['x'],
      verification_class: 'fix',
    };
    const leaked = runBT(JSON.stringify({
      ...validRecord, title: 'a leaking board-tool write', body: leakBody,
    }));
    check('path D (board-tool) leaking write → REFUSED at write time (round-1 guard)',
      leaked.ok === false && leaked.refusal?.code === 'private-token-leak', JSON.stringify(leaked.refusal || leaked).slice(0, 200));

    const clean = runBT(JSON.stringify({
      ...validRecord, title: 'a clean board-tool write',
      body: 'Repro kept under ~/scratch/x/ — repo-relative, clean.',
    }));
    check('path D (board-tool) clean write → written',
      clean.ok === true && typeof clean.id === 'string', JSON.stringify(clean.refusal || {}).slice(0, 200));
    fs.rmSync(btRoot, { recursive: true, force: true });
  }

  // ── MUST-FAIL against the PRE-CHANGE turn-end surface ────────────────────────
  // Before this hook existed, the ONLY Stop hook was the ADVISORY, FAIL-OPEN
  // response-format-gate, which never looks at tickets. Reconstruct the exact
  // leaking-ticket tree state and drive THAT hook: it must NOT block — proving the
  // identical write got through turn-end pre-change (the gap BUG-157 fell into).
  writeTicket('BUG-904', ticketBody('BUG-904', `\`${HOME}/projects/orchard/scripts/verify-bug-904.mjs\`.`));
  {
    // A compliant transcript so response-format-gate has no format reason to
    // block; ORCHARD_SESSION set to the payload's own id so its launcher gate
    // treats the turn as gradable (otherwise it is silent for a different reason).
    const digest = '```orchard-digest\n{"items":[{"text":"done","kind":"done","importance":"low"}]}\n```';
    fs.writeFileSync(path.join(root, 'transcript.jsonl'),
      JSON.stringify({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: digest }] } }) + '\n');
    const r = runHook(RESPONSE_HOOK, { env: { ORCHARD_SESSION: '0feat110-0000-4000-8000-000000000110' } });
    check('MUST-FAIL: pre-change turn-end surface (response-format-gate) does NOT block the leaking ticket',
      !r.blocked, r.stdout);
    // And the NEW hook, on the identical tree, DOES block — the differential proof.
    const rn = runHook(HOOK);
    check('MUST-FAIL differential: the NEW hook DOES block the identical leaking tree', rn.blocked, rn.stdout);
    fs.rmSync(ticketPath('BUG-904'));
  }

  // ── FAIL-SAFE: detector unavailable → REFUSE, not pass ───────────────────────
  writeTicket('BUG-905', ticketBody('BUG-905', '`scripts/verify-bug-905.mjs` (clean, but detector is gone).'));
  {
    const missing = path.join(root, 'no-such-leak-tokens.mjs');
    const r = runHook(HOOK, { env: { ORCHARD_LEAK_TOKENS: missing } });
    check('fail-safe: detector unavailable → BLOCK (refuse, not silent pass)',
      r.blocked && /detector|could not be loaded|leak-tokens/i.test(r.reason), r.reason.slice(0, 160));
    // The one bounded concession: on the LATCHED retry it allows, so a session is
    // never wedged forever (the commit gate stays the hard backstop).
    const r2 = runHook(HOOK, { stopHookActive: true, env: { ORCHARD_LEAK_TOKENS: missing } });
    check('fail-safe latch: detector unavailable + stop_hook_active → ALLOW (no wedge)',
      !r2.blocked, r2.stdout);
    fs.rmSync(ticketPath('BUG-905'));
  }

  // ── LATCH on the leak path too: one firm correction, then defer to the gate ──
  writeTicket('BUG-906', ticketBody('BUG-906', `\`${HOME}/x.mjs\`.`));
  {
    const r1 = runHook(HOOK);
    check('leak + first Stop → BLOCK', r1.blocked, r1.stdout);
    const r2 = runHook(HOOK, { stopHookActive: true });
    check('leak + stop_hook_active (already corrected once) → ALLOW (commit gate is the backstop)', !r2.blocked, r2.stdout);
    fs.rmSync(ticketPath('BUG-906'));
  }

} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\nFEAT-110 authoring-guard: ${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
