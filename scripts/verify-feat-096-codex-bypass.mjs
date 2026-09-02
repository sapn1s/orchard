#!/usr/bin/env node
/**
 * verify-feat-096-codex-bypass.mjs — FEAT-096 round 2.
 *
 * The orchestrator tool profile is enforced by a `ClaudeRuntime` PreToolUse
 * callback keyed on `agent_id`. This suite proves the ONE launch path that
 * silently escapes it — the OpenAI/Codex provider — and that round 2 makes that
 * escape VISIBLE instead of silent.
 *
 * Two facts establish the bypass at the source, which is stronger than a live
 * demo (a live Codex read simply succeeds, at real API cost, showing what these
 * two facts already prove):
 *
 *   1. `CodexRuntime` never reads `orchestratorProfile` — the field is inert on
 *      that provider, so a profile-enabled project gets NO enforcement.
 *   2. Codex's approval channel gates ONLY command execution and file changes
 *      (EXEC/PATCH_APPROVAL_METHODS). File reads never enter it, so even wiring
 *      a deny there could not remove the orchestrator's inline reads — the
 *      profile's whole purpose. Enforcement here would be a half-build; round 2
 *      does not attempt it.
 *
 * Non-vacuity / must-FAIL: the visibility warning is ABSENT at HEAD and PRESENT
 * in the working tree, guarded on exactly `provider === 'openai'` and the
 * project's `orchestratorProfile.enabled`.
 *
 * Run: node scripts/verify-feat-096-codex-bypass.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const atHead = (p) => {
  try { return execFileSync('git', ['show', `HEAD:${p}`], { cwd: ROOT, encoding: 'utf8' }); }
  catch { return ''; }
};

let pass = 0, fail = 0;
const fails = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (observed !== undefined) console.log(`        observed: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`);
  if (ok) pass++; else { fail++; fails.push(name); }
}

const codex = rd('src/server/runtime/codex-runtime.ts');
const claude = rd('src/server/runtime/claude-runtime.ts');
const bridge = rd('src/server/agent-bridge.ts');
const bridgeHead = atHead('src/server/agent-bridge.ts');

console.log('\n─── the bypass is structural: CodexRuntime cannot enforce the profile ───');

// 1. CodexRuntime never references the profile field — it is inert there.
{
  const n = (codex.match(/orchestratorProfile/g) ?? []).length;
  check('CodexRuntime never reads orchestratorProfile (0 refs = inert)', n === 0, `${n} refs`);
}
// contrast: ClaudeRuntime DOES read it (this is the enforcing runtime).
{
  const n = (claude.match(/orchestratorProfile/g) ?? []).length;
  check('ClaudeRuntime does read orchestratorProfile (the enforcing runtime)', n > 0, `${n} refs`);
}
// 2. Codex's approval channel gates exec + patch only, never reads.
{
  const hasExec = /EXEC_APPROVAL_METHODS\s*=/.test(codex);
  const hasPatch = /PATCH_APPROVAL_METHODS\s*=/.test(codex);
  // No read/inspect approval method set exists.
  const hasReadApproval = /READ_APPROVAL_METHODS|fileRead.*Approval|read.*requestApproval/i.test(codex);
  check('Codex approval channel covers exec + patch', hasExec && hasPatch, { hasExec, hasPatch });
  check('Codex approval channel has NO read gate (reads bypass any deny)', !hasReadApproval, `hasReadApproval=${hasReadApproval}`);
}

console.log('\n─── round 2 makes the silent bypass VISIBLE (must-FAIL vs HEAD) ───');

const warnRe = /orchestrator profile NOT enforced[\s\S]*?OpenAI Codex/;
// must-FAIL: the warning does not exist at HEAD.
check('non-vacuity: the visibility warning is ABSENT at HEAD', !warnRe.test(bridgeHead));
// present now.
check('the visibility warning is PRESENT in the working tree', warnRe.test(bridge));
// guarded on provider===openai AND the project profile flag, inside the openai branch.
{
  const openaiBranch = bridge.slice(bridge.indexOf("if (provider === 'openai')"));
  const guarded = /if \(orchestratorProfileOf\(opts\.project\)\.enabled\)/.test(openaiBranch)
    && openaiBranch.indexOf('NOT enforced') > openaiBranch.indexOf('orchestratorProfileOf(opts.project).enabled');
  check('warning is guarded on the project orchestratorProfile.enabled flag', guarded);
}
// it is a non-fatal status (does not break the session — the escape valve stays honest).
{
  const idx = bridge.indexOf('NOT enforced');
  const region = bridge.slice(Math.max(0, idx - 200), idx); // the emit that carries the warning
  const isStatus = /t: 'status'/.test(region) && !/fatal: true/.test(region);
  check('the warning is a non-fatal status (Codex still starts; nothing is blocked)', isStatus);
}

console.log(`\nFEAT-096 codex-bypass — ${pass}/${pass + fail}${fail ? ` (FAIL: ${fails.join(', ')})` : ''}`);
process.exit(fail ? 1 : 0);
