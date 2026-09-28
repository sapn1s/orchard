#!/usr/bin/env node
/**
 * BUG-189 round 4, finding 1 — a fake codex whose `sandbox` launcher forks a
 * SIGTERM-ignoring child that stays in the launcher's process group, then exits 0
 * IMMEDIATELY (the success path). This is the verifier's `launcher-exits-child-hangs`
 * attack: without reaping the group on the exit path, the child is orphaned but
 * alive after the probe returns ok. The child's pid is written to
 * CODEX_FAKE_ORPHAN_PIDFILE so a test can check survival.
 *   --version → version line, exit 0 (fast; the probe reaches `sandbox`).
 *   sandbox … → fork the in-group SIGTERM-ignoring child, record its pid, exit 0.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('codex-cli orphan-launcher-fake\n');
  process.exit(0);
}
if (argv.includes('sandbox')) {
  // detached:false → the child INHERITS this launcher's process group (no setsid),
  // so a group-wide SIGKILL from the parent preflight reaps it. It ignores
  // SIGTERM and hangs, so only SIGKILL stops it.
  const child = spawn(process.execPath,
    ['-e', 'process.on("SIGTERM",()=>{});process.on("SIGINT",()=>{});setInterval(()=>{},1000000)'],
    { detached: false, stdio: 'ignore' });
  if (process.env.CODEX_FAKE_ORPHAN_PIDFILE) {
    try { fs.writeFileSync(process.env.CODEX_FAKE_ORPHAN_PIDFILE, String(child.pid)); } catch { /* best effort */ }
  }
  child.unref();
  process.exit(0); // launcher succeeds immediately, leaving the child behind
}
process.exit(0);
