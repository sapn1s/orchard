#!/usr/bin/env node
/**
 * ticket-leak-gate.mjs — FEAT-110 round 2. The authoring-PATH-INDEPENDENT half
 * of the private-token defence: a Stop / SubagentStop hook that refuses to let a
 * turn END while a changed ticket file carries a private token.
 *
 * WHY THIS EXISTS (the gap this closes). FEAT-110 round 1 put the leak refusal on
 * scripts/board-tool.mjs's `file`/`update` write path — but that only covers a
 * ticket authored THROUGH the board tool. A ticket written with the plain Write
 * tool (or an Edit, or a `cat > docs/bugs/…` heredoc) bypasses that guard
 * entirely and is caught only at commit. BUG-155, BUG-156 and BUG-157 were all
 * authored that way; each turned `npm run gate` red for every other lane, on a
 * PUBLIC-bound repo whose only recovery from an actually-pushed leak is a history
 * rewrite. Round 1 named this gap and deferred it; BUG-157 is the failure it
 * predicted, so this hook closes it.
 *
 * WHY A STOP HOOK, KEYED ON THE FILE — NOT A PostToolUse-on-Write HOOK. The
 * requirement is an OUTCOME, not a tool: "a ticket carrying a private token must
 * not survive to the point where a human is asked to commit it — no matter which
 * tool wrote it." Keying on the CHANGED FILE (via `git status` over the board
 * dir) is what makes this authoring-path-independent: it catches a Write, an
 * Edit, a Bash heredoc and a board-tool write alike, because all four leave the
 * same dirty file in the tree. A PostToolUse-on-Write hook would miss the heredoc
 * path. Turn-end is "the moment of authorship": the agent that wrote the ticket
 * THIS turn is still in context and is told the exact line + token class, versus
 * a commit that may happen many turns / lanes / days later under a different
 * agent who never had the context to fix it.
 *
 * WHY A SEPARATE FILE (not folded into response-format-gate.mjs). The existing
 * Stop hook is deliberately ADVISORY and FAIL-OPEN — its whole hard-won design is
 * "never wedge a turn, never cost a turn on a false positive" (FEAT-085, BUG-118).
 * This guard's contract is the OPPOSITE: it must BLOCK, and it must FAIL SAFE
 * (refuse, not allow) when it cannot scan. Mixing two opposite philosophies into
 * one file is exactly how a regression-prone shared hook surface gets more
 * fragile. So this is its own entry in .claude/settings.json's `Stop` /
 * `SubagentStop` arrays; response-format-gate.mjs is not touched.
 *
 * THE DETECTOR IS SHARED, NEVER A SECOND MATCHER. It imports `findLeaks` from
 * scripts/lib/leak-tokens.mjs — the SAME token list the commit-time leak-gate
 * (scripts/leak-gate.mjs) and the board-tool write-guard both use. Anything this
 * refuses the commit gate would also refuse; anything that passes here passes
 * there. Legitimate DISCUSSION of a token shape is not blocked: the matcher looks
 * at literal values, and the convention (used by leak-tokens.mjs on itself) is to
 * describe the shape or split the literal, never paste the value.
 *
 * FAIL SAFE, NOT FAIL OPEN. If the detector cannot load, or the tree cannot be
 * read, this REFUSES the stop (blocks) rather than letting an unscanned ticket
 * through — the one thing round 1 warned a hook must never do is silently pass.
 * The single concession to not wedging a session forever is `stop_hook_active`:
 * once this hook has already blocked a turn, a second Stop is ALLOWED (Claude
 * Code's one-correction latch), because the commit-time gate remains the hard
 * backstop that a human can never commit past. So the property "a leak never
 * reaches a human-approved commit" is enforced by the gate; this hook's job is to
 * make it LOUD and ACTIONABLE at authorship, which one firm correction achieves.
 *
 * Stop / SubagentStop contract (Claude Code, verified against FEAT-085's suite):
 *   stdin  : { session_id, transcript_path, cwd, hook_event_name, stop_hook_active }
 *   BLOCK  : print {"decision":"block","reason":"…"} to stdout, exit 0 — Claude
 *            Code feeds `reason` back as a just-in-time correction.
 *   ALLOW  : print nothing, exit 0.
 */

import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));

// The one-correction latch, mirrored at module scope so even the outermost
// catch (an error before main() reads the payload) can honour it and never wedge
// a session across retries. Set the instant the payload is parsed.
let LATCHED = false;

/* ── the two terminal actions ──────────────────────────────────────────────── */

function allow() {
  // Silence = let the turn end with zero re-prompt. The clean-ticket path.
  process.exit(0);
}

/** Block the stop with a corrective reason Claude Code feeds back to the author. */
function block(reason) {
  try {
    process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  } catch {
    // If we somehow cannot emit the block, exiting non-zero still signals a
    // hook failure to Claude Code rather than a clean allow.
    process.exitCode = 1;
  }
  process.exit(0);
}

/* ── stdin ─────────────────────────────────────────────────────────────────── */

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { data += c; });
      process.stdin.on('end', () => resolve(data));
      process.stdin.on('error', () => resolve(data));
    } catch {
      resolve('');
    }
  });
}

/* ── main ──────────────────────────────────────────────────────────────────── */

async function main() {
  const stdin = await readStdin();
  let payload = {};
  try { payload = JSON.parse(stdin) || {}; } catch { payload = {}; }
  if (!payload || typeof payload !== 'object') payload = {};

  // The one-correction latch. Once THIS hook has blocked a turn, a second Stop is
  // allowed so a session can never be wedged; the commit-time gate is the hard
  // backstop past which nothing can be committed. Captured up front so the
  // watchdog below can honour it too.
  const stopHookActive = payload.stop_hook_active === true;
  LATCHED = stopHookActive;

  // FAIL SAFE, bounded: on any refusal we block on the FIRST stop and allow on the
  // latched retry. This is the only place "refuse" turns into "allow", and only to
  // avoid an unbreakable wedge — never to pass an unscanned ticket the first time.
  const refuse = (reason) => (stopHookActive ? allow() : block(reason));

  // Never let the hook hang a turn. Fires well before any configured timeout; a
  // hang is treated as "could not scan" → refuse (bounded by the latch).
  const watchdog = setTimeout(() => {
    refuse('ticket-leak-gate: the private-token scan did not complete in time, so this turn is being held rather than allowed to end with tickets that were never scanned. Retry to proceed; the commit-time leak gate remains the hard backstop.');
  }, 8000);
  watchdog.unref?.();

  // 1. THE DETECTOR — the shared token list, never a second matcher. An env
  //    override exists ONLY for the verify suite, which points it at a missing
  //    file to prove the fail-safe; a real run always resolves the co-located
  //    module (same relative path in Orchard's tree and in the onboarded flat
  //    `.orchard/` layout).
  let findLeaks;
  try {
    const spec = process.env.ORCHARD_LEAK_TOKENS
      ? path.resolve(process.env.ORCHARD_LEAK_TOKENS)
      : path.join(HERE, '..', 'lib', 'leak-tokens.mjs');
    if (!fs.existsSync(spec)) throw new Error(`leak-tokens module not found at ${spec}`);
    ({ findLeaks } = await import(url.pathToFileURL(spec).href));
  } catch (err) {
    return refuse(
      'ticket-leak-gate: the private-token detector (scripts/lib/leak-tokens.mjs) could not be loaded, so no ticket in this turn was scanned. Refusing to end the turn unscanned rather than risk a private token reaching this PUBLIC repo. Restore the detector and retry. (' + String(err?.message ?? err).slice(0, 200) + ')',
    );
  }
  if (typeof findLeaks !== 'function') {
    return refuse('ticket-leak-gate: leak-tokens.mjs loaded but does not export findLeaks(); refusing to end the turn with tickets that were never scanned.');
  }

  // 2. THE BOARD DIR — layout-independent (FEAT-106). Falls back to docs/bugs if
  //    the resolver is unavailable; a missing resolver must not silently skip the
  //    scan.
  const cwd = (typeof payload.cwd === 'string' && payload.cwd.trim())
    ? payload.cwd
    : (process.env.CLAUDE_PROJECT_DIR || process.cwd());

  const top = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (top.status !== 0 || !top.stdout.trim()) {
    // Not a git repo / git unavailable → we cannot tell what changed → refuse.
    return refuse('ticket-leak-gate: could not resolve the git working tree to scan changed tickets; refusing to end the turn unscanned. (' + String(top.stderr || '').trim().slice(0, 160) + ')');
  }
  const root = top.stdout.trim();

  let boardDir;
  try {
    const { resolveBoardDir } = await import(url.pathToFileURL(path.join(HERE, '..', 'lib', 'board-path.mjs')).href);
    boardDir = resolveBoardDir(root);
  } catch {
    boardDir = path.join(root, 'docs', 'bugs');
  }
  if (!fs.existsSync(boardDir)) return allow(); // no board here → nothing to guard

  // 3. THE CHANGED TICKETS — every dirty or untracked file under the board dir,
  //    regardless of which tool wrote it. `--porcelain` parsing mirrors
  //    board-tool.mjs's proven commit-path parser (path starts at column 3; a
  //    rename reads `R  old -> new`, and only the destination is a written path).
  const st = spawnSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all', '--', boardDir], { encoding: 'utf8' });
  if (st.status !== 0) {
    return refuse('ticket-leak-gate: `git status` over the board dir failed, so changed tickets could not be enumerated; refusing to end the turn unscanned. (' + String(st.stderr || '').trim().slice(0, 160) + ')');
  }
  const rels = st.stdout.split('\n')
    .filter((l) => l.length > 3)
    .map((l) => l.slice(3).replace(/^.* -> /, '').trim().replace(/^"|"$/g, ''))
    .filter((p) => p.endsWith('.md'));

  const boardAbs = path.resolve(boardDir);
  const hits = [];
  for (const relPath of rels) {
    const abs = path.resolve(root, relPath);
    // Stay inside the board dir; a file outside it is not this guard's business.
    if (abs !== boardAbs && !abs.startsWith(boardAbs + path.sep)) continue;
    let content;
    try {
      if (!fs.statSync(abs).isFile()) continue;
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      continue; // deleted/renamed away in the tree — nothing to scan
    }
    for (const h of findLeaks(content)) {
      hits.push({ file: relPath, lineNo: h.lineNo, token: h.token, line: h.line });
    }
  }

  clearTimeout(watchdog);

  if (!hits.length) return allow(); // clean → silence, no re-prompt

  // 4. THE REFUSAL — loud, and actionable while the author still has the context.
  //    Each hit names the file, the line and the token CLASS (never inventing a
  //    value); the offending line is shown so the author can find and redact it.
  const lines = hits.slice(0, 20).map(
    (h) => `  ${h.file}:${h.lineNo}  [${h.token}]  ${h.line.trim().slice(0, 140)}`,
  );
  const more = hits.length > 20 ? `\n  … (+${hits.length - 20} more hit(s))` : '';
  const reason = [
    `PRIVATE-TOKEN LEAK in ${hits.length === 1 ? 'a ticket' : 'tickets'} changed this turn — this repo is PUBLIC, the commit-time leak gate will reject this, and the only recovery from an actually-pushed leak is a history rewrite. Fix it NOW, while you still have the context:`,
    '',
    lines.join('\n') + more,
    '',
    'Redact before ending the turn — keep every fact, count and file reference, change only the identifying token: a home path becomes `~` or a repo-relative path; a private project name becomes a neutral description; a username/handle/email is removed.',
    'Detection is scripts/lib/leak-tokens.mjs — the same list the commit gate uses. To legitimately DISCUSS a token shape in a ticket, describe the shape or split the literal; never paste the value.',
  ].join('\n');

  return refuse(reason);
}

// Any unexpected error is a scan that did not complete → refuse (bounded by the
// latch), never a silent allow. This is the deliberate inverse of the advisory
// response-format hook's fail-open posture.
main().catch((err) => {
  const reason = 'ticket-leak-gate: an unexpected error prevented the private-token scan (' + String(err?.message ?? err).slice(0, 200) + '); refusing to end the turn unscanned.';
  if (LATCHED) { process.exit(0); }
  try { process.stdout.write(JSON.stringify({ decision: 'block', reason })); } catch { /* ignore */ }
  process.exit(0);
});
