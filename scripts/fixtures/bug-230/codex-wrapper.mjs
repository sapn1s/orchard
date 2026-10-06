#!/usr/bin/env node
/**
 * BUG-230 — records the env the codex app-server child was launched with
 * (proves CodexRuntime really installed its own nested shim), then becomes the
 * shared fake app-server (scripts/fixtures/codex-fake-app-server.mjs).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

if (process.env.FAKE_OUT) {
  try {
    fs.appendFileSync(process.env.FAKE_OUT, `${JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), shimDir: process.env.ORCHARD_GIT_SHIM_DIR || null, pathHead: String(process.env.PATH || '').split(path.delimiter)[0] })}\n`);
  } catch { /* best effort */ }
}
await import(path.join(import.meta.dirname, '..', 'codex-fake-app-server.mjs'));
