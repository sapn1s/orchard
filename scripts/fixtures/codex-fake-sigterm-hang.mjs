#!/usr/bin/env node
/**
 * BUG-189 round 3, finding 1 — a fake codex whose `sandbox` subcommand IGNORES
 * SIGTERM (and SIGINT) and then hangs forever. It stands in for a wedged bwrap
 * that will not die on the polite signal `execFile`'s timeout sends. The
 * preflight must still bound its wait and reap this via SIGKILL-on-the-group.
 *   --version   → a version line, exit 0 (fast, so the probe reaches `sandbox`).
 *   sandbox …   → trap SIGTERM/SIGINT, then never exit (only SIGKILL stops it).
 */
const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('codex-cli sigterm-hang-fake\n');
  process.exit(0);
}
if (argv.includes('sandbox')) {
  process.on('SIGTERM', () => { /* deliberately ignored */ });
  process.on('SIGINT', () => { /* deliberately ignored */ });
  // Keep the event loop alive indefinitely; SIGKILL is the only way out.
  setInterval(() => {}, 1_000_000);
} else {
  process.exit(0);
}
