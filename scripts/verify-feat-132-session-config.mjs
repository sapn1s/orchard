/**
 * FEAT-132 — session-configuration record: server-side proof.
 *
 *   node scripts/verify-feat-132-session-config.mjs
 *
 * Exercises the REAL compose + persistence layer (no server on 4317, all state
 * in throwaway temp dirs):
 *   - composeInstructions() now emits ComposedPrompt.sources with per-source
 *     bodies AND a truncation flag (BUG-146), detected from each section
 *     builder's own output.
 *   - a REAL over-cap docs/CONVENTIONS.md must produce a `truncated` source with
 *     the right droppedChars (must-FAIL if truncation goes unrecorded).
 *   - recordSessionConfig()/readSessionConfig() round-trip write-once, and a
 *     TRUNCATED sidecar read (another process mid-write) degrades to null, not a
 *     throw.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f132-data-'));
const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-f132-proj-'));
process.env.CLAUDE_STATION_DATA = DATA;

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; failures.push(name); }
}

async function main() {
  const { composeInstructions, seedTemplates } =
    await import(path.join(ROOT, 'src', 'server', 'templates.ts'));
  const { recordSessionConfig, readSessionConfig, sessionConfigDir } =
    await import(path.join(ROOT, 'src', 'server', 'session-config.ts'));
  seedTemplates();

  // --- (1) an over-cap docs/CONVENTIONS.md is recorded as TRUNCATED ---
  fs.mkdirSync(path.join(PROJ, 'docs'), { recursive: true });
  // Build a conventions doc well past the 6000-char cap, on markdown boundaries.
  const block = (n) => `## Rule ${n}\n\n${'x'.repeat(300)}\n`;
  let conv = '# Project conventions\n\n';
  for (let i = 0; i < 40; i++) conv += `${block(i)}\n`;
  fs.writeFileSync(path.join(PROJ, 'docs', 'CONVENTIONS.md'), conv);

  const composed = composeInstructions([{ templateId: 'working-agreement-v2' }], {
    hostPath: PROJ, routing: true, responseFormat: true,
  });

  check('composeInstructions now returns a sources[] breakdown',
    Array.isArray(composed.sources) && composed.sources.length > 0, `len=${composed.sources?.length}`);

  const byId = Object.fromEntries(composed.sources.map((s) => [s.id, s]));
  check('the Working Agreement is an applied source with a body',
    byId['working-agreement-v2']?.status === 'applied' && byId['working-agreement-v2'].body.length > 200,
    `status=${byId['working-agreement-v2']?.status} bytes=${byId['working-agreement-v2']?.body.length}`);
  check('routing + response-format applied as their own sources',
    byId['provider-routing'] && byId['response-format'],
    `${!!byId['provider-routing']}/${!!byId['response-format']}`);

  const lc = byId['local-conventions'];
  // THE must-FAIL: without truncation detection this would be 'applied' and the
  // silent cut would be invisible — the exact BUG-146 failure this card exposes.
  check('an over-cap docs/CONVENTIONS.md is recorded as TRUNCATED, not applied',
    lc?.status === 'truncated', `status=${lc?.status}`);
  check('truncated source records droppedChars > 0',
    typeof lc?.droppedChars === 'number' && lc.droppedChars > 0, `droppedChars=${lc?.droppedChars}`);
  check('truncated source body carries the loud TRUNCATED notice',
    typeof lc?.body === 'string' && lc.body.includes('TRUNCATED'), lc?.body?.slice(-120));

  // --- (2) a doc that FITS is recorded as applied (non-vacuity of the flag) ---
  fs.writeFileSync(path.join(PROJ, 'docs', 'CONVENTIONS.md'), '# Conventions\n\nJust one short rule.\n');
  const composed2 = composeInstructions([{ templateId: 'working-agreement-v2' }], {
    hostPath: PROJ, routing: true, responseFormat: true,
  });
  const lc2 = composed2.sources.find((s) => s.id === 'local-conventions');
  check('a conventions doc that FITS is recorded as applied (not falsely truncated)',
    lc2?.status === 'applied' && lc2.droppedChars == null, `status=${lc2?.status} dropped=${lc2?.droppedChars}`);

  // --- (3) a MISSING template id lands as a missing source ---
  const composed3 = composeInstructions([{ templateId: 'no-such-template-xyz' }], { hostPath: PROJ });
  const miss = composed3.sources.find((s) => s.id === 'no-such-template-xyz');
  check('a missing template id is recorded as a missing source',
    miss?.status === 'missing' && composed3.missingIds.includes('no-such-template-xyz'), `status=${miss?.status}`);

  // --- (4) persistence round-trips write-once ---
  const sid = 'feat132-abc-0000-1111';
  const rec = {
    projectId: 'p1', mode: composed.mode, model: 'claude-opus-4-8', provider: 'anthropic',
    isolation: 'direct', sources: composed.sources, tools: ['Bash', 'Read'], mcpServers: ['serena'],
  };
  check('recordSessionConfig writes a fresh record (true)', recordSessionConfig(sid, rec) === true, 'wrote');
  check('recordSessionConfig is write-once (second call false)', recordSessionConfig(sid, rec) === false, 'no-op');
  const read = readSessionConfig(sid);
  check('readSessionConfig round-trips the record', read?.sessionId === sid && read.v === 1, `v=${read?.v}`);
  check('the persisted record preserves the truncated source',
    read?.sources.some((s) => s.id === 'local-conventions' && s.status === 'truncated'),
    read?.sources.find((s) => s.id === 'local-conventions')?.status);

  // --- (5) a TRUNCATED sidecar (concurrent mid-write) reads as null, never throws ---
  const file = path.join(sessionConfigDir(), `${sid}-partial.json`);
  const full = fs.readFileSync(path.join(sessionConfigDir(), `${sid}.json`), 'utf8');
  let threw = false, gotNull = false;
  for (const cut of [10, Math.floor(full.length / 3), Math.floor(full.length / 2), full.length - 5]) {
    fs.writeFileSync(file, full.slice(0, cut));
    try {
      const r = readSessionConfig(`${sid}-partial`);
      if (r === null) gotNull = true; else { gotNull = false; break; }
    } catch { threw = true; break; }
  }
  check('a partially-written sidecar reads as null, never throws', !threw && gotNull, `threw=${threw} null=${gotNull}`);

  check('an unknown session id reads as null (pre-feature session)',
    readSessionConfig('never-recorded-9999') === null, 'null');

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) console.log(`failed: ${failures.join(' | ')}`);
  process.exitCode = fail ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
