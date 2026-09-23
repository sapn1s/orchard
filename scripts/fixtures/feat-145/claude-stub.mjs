#!/usr/bin/env node
/**
 * FEAT-145 step 3 — a stand-in for the `claude` binary, used by
 * `scripts/verify-feat-145-login-flow.mjs`.
 *
 * It exists because an automated test must NEVER complete a real OAuth login:
 * that needs a human at a browser and would burn a real subscription's session.
 * So the CLI's OBSERVED behaviour is replayed instead — and the output it
 * replays in `real` mode is the RECORDED REAL OUTPUT of claude 2.1.273 on plain
 * pipes (FEAT-145 step 1), not an invention:
 *
 *     Opening browser to sign in…
 *     https://claude.com/cai/oauth/authorize?code=true&client_id=…&state=…
 *     Paste code here if prompted >
 *
 * including the two traps that break naive implementations: the authorize host
 * is `claude.com/cai/…` (not `claude.ai/oauth/…`), and `auth status --json`
 * EXITS 1 WHEN LOGGED OUT while still printing valid JSON.
 *
 * Mode comes from $STUB_MODE. No secret is ever written to the config dir.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

const MODE = process.env.STUB_MODE || 'real';
const CFG = process.env.CLAUDE_CONFIG_DIR || '';
const CREDS = CFG ? path.join(CFG, '.credentials.json') : '';
const argv = process.argv.slice(2);

/* The authorize URL shape, verbatim from the recorded real run apart from the
   opaque values (which are per-attempt random in the real CLI too). */
const URL_REAL =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e'
  + '&response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback'
  + '&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference'
  + '&code_challenge=C8kM2wAIGXcsE9nQmA1t3aW7lQ0XH-r2Yb5vN6pKfUo&code_challenge_method=S256'
  + '&state=9SxT1nQ0bZ-4hVLmKpWcYr7dEaJgUu2Fi3XoRnAvBlM';

function writeCreds(token = 'stub-oauth-token-not-a-real-credential') {
  if (!CREDS) return;
  fs.writeFileSync(CREDS, `${JSON.stringify({ claudeAiOauth: { accessToken: token, subscriptionType: 'max' } }, null, 2)}\n`);
}

/* ─────────────────────────────────────────────── auth status --json ─────── */
if (argv[0] === 'auth' && argv[1] === 'status') {
  const loggedIn = process.env.STUB_STATUS_LOGGED_IN === '1'
    || (process.env.STUB_STATUS_LOGGED_IN !== '0' && !!CREDS && fs.existsSync(CREDS));
  if (process.env.STUB_STATUS_GARBAGE === '1') {
    process.stdout.write('not json at all\n');
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({
    loggedIn,
    authMethod: loggedIn ? 'claude.ai' : 'none',
    subscriptionType: loggedIn ? 'max' : null,
    email: null,
    configDirectory: CFG || null,
    projectsDirectory: CFG ? path.join(CFG, 'projects') : null,
  })}\n`);
  // THE TRAP: logged out exits 1, and the JSON above is still valid.
  process.exit(loggedIn ? 0 : 1);
}

/* ───────────────────────────────────────── auth login --claudeai ────────── */
if (argv[0] === 'auth' && argv[1] === 'login') {
  // Proof the server stripped the desktop from the child env (the CLI must not
  // pop a browser on the SERVER's screen — the user may be on another machine).
  if (process.env.STUB_ENV_OUT) {
    fs.writeFileSync(process.env.STUB_ENV_OUT, `${JSON.stringify({
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null,
      BROWSER: process.env.BROWSER ?? null,
      DISPLAY: process.env.DISPLAY ?? null,
      WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ?? null,
      pid: process.pid,
      // Node has no getpgid(); /proc/self/stat field 5 (pgrp) is the ground
      // truth. Fields after the comm — which may itself contain spaces and
      // parens — start past the LAST ')'.
      pgid: (() => {
        try {
          const stat = fs.readFileSync('/proc/self/stat', 'utf8');
          const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
          return Number(rest[2]); // state, ppid, pgrp
        } catch { return null; }
      })(),
    })}\n`);
  }

  if (MODE === 'exit-immediately') {
    process.stdout.write('Opening browser to sign in…\n');
    process.stdout.write(`${URL_REAL}\n`);
    // Exits SUCCESSFULLY without ever writing a credential — the case where a
    // 0 exit code would wrongly be read as "signed in".
    process.exit(0);
  }

  if (MODE === 'exit-nonzero-but-logged-in') {
    process.stdout.write('Opening browser to sign in…\n');
    process.stdout.write(`${URL_REAL}\n`);
    writeCreds();
    // The inverse trap: a NON-ZERO exit while the credential is genuinely there.
    process.exit(3);
  }

  if (MODE === 'no-url') {
    process.stdout.write('Starting sign-in flow (this CLI prints no link any more)\n');
    process.stdout.write('Paste code here if prompted > ');
    setTimeout(() => {}, 60_000); // block, exactly as the real CLI does
  } else if (MODE === 'hang') {
    process.stdout.write('Opening browser to sign in…\n');
    process.stdout.write(`${URL_REAL}\n`);
    // A CHILD of this process, in the SAME process group. A kill aimed at the
    // leader's pid alone leaves it running; a group kill takes it too. Its pid
    // is recorded so the test can grade both outcomes.
    const kid = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)'], { stdio: 'ignore' });
    if (process.env.STUB_CHILD_PID_OUT) fs.writeFileSync(process.env.STUB_CHILD_PID_OUT, String(kid.pid));
    setTimeout(() => {}, 600_000);
  } else if (MODE === 'silent') {
    // Neither a link nor the paste prompt: the case where ONLY the grace timer
    // can rescue the user from an indefinite wait.
    process.stdout.write('working…\n');
    setTimeout(() => {}, 600_000);
  } else if (MODE === 'split-url') {
    // The URL arrives in TWO reads, split mid-query-string. A scraper that
    // matches per chunk emits a truncated, dead link.
    const cut = Math.floor(URL_REAL.length * 0.6);
    process.stdout.write(`Opening browser to sign in…\n${URL_REAL.slice(0, cut)}`);
    setTimeout(() => {
      process.stdout.write(`${URL_REAL.slice(cut)}\nPaste code here if prompted > `);
    }, 250);
  } else {
    process.stdout.write('Opening browser to sign in…\n');
    process.stdout.write(`${URL_REAL}\n`);
    process.stdout.write('Paste code here if prompted > ');
  }

  // Read the pasted code off stdin, exactly as the real CLI does.
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    const nl = buf.indexOf('\n');
    if (nl < 0) return;
    const code = buf.slice(0, nl).trim();
    if (process.env.STUB_CODE_OUT) fs.writeFileSync(process.env.STUB_CODE_OUT, code);
    if (process.env.STUB_ECHO_CODE === '1') {
      // The worst case a relay must survive: the CLI echoes the code back.
      process.stdout.write(`\nreceived code ${code}\n`);
    }
    if (MODE === 'no-url' || MODE === 'bad-code') {
      process.stdout.write('Invalid code.\n');
      process.exit(1);
    }
    writeCreds();
    process.stdout.write('Login successful.\n');
    process.exit(0);
  });
  // Keep the event loop alive while waiting for stdin.
  setInterval(() => {}, 1 << 30);
} else if (argv[0] === '--version') {
  process.stdout.write('0.0.0-stub\n');
} else {
  process.stderr.write(`stub: unsupported argv ${JSON.stringify(argv)}\n`);
  process.exit(64);
}
