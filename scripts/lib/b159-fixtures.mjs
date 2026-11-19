/**
 * FEAT-206 — which REAL-CLI capture the BUG-159 suites grade.
 *
 * The suites were pinned to CLI 2.1.281 captures. A CLI bump must be proven on
 * the NEW CLI's own frames too, so the version is a knob:
 *   B159_CLI_FIXTURE=<cli version>   (default 2.1.281 — the committed baseline)
 *   B159_FIXTURE_DIR=<dir>           (default scripts/fixtures/bug-159)
 * Files are `real-cli-<version>-<name>.json`, written by scripts/capture-cli-wire.mjs.
 */
import * as path from 'node:path';

export const B159_CLI_VERSION = process.env.B159_CLI_FIXTURE || '2.1.281';
export const B159_FIXTURE_DIR = process.env.B159_FIXTURE_DIR || path.join(import.meta.dirname, '..', 'fixtures', 'bug-159');
export function b159Fixture(name) {
  return path.join(B159_FIXTURE_DIR, `real-cli-${B159_CLI_VERSION}-${name}.json`);
}
