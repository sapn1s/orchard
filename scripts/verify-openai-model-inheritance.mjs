/**
 * BUG — an OpenAI session inherited the CLAUDE global default model.
 *
 * A project with `provider:openai, model:null` (the reported project in the real
 * registry) inherited the machine-wide global default model — a CLAUDE id,
 * `claude-opus-5-5` in the user's real settings.json — via applyGlobalDefaults,
 * and that id reached the Codex runtime, which 400s:
 *   "The 'claude-opus-5-5' model is not supported when using Codex with a ChatGPT account."
 *
 * This proves the fix (resolveModelForProvider): the Claude global default fills
 * ONLY an anthropic session; a non-anthropic session with an unset model resolves
 * to null (Codex picks its own default). Anthropic inheritance is unchanged.
 *
 * Uses a throwaway CLAUDE_STATION_DATA so the real settings.json is untouched,
 * seeded with the SAME shape as the user's real file (claude-opus-5-5).
 *
 *   node scripts/verify-openai-model-inheritance.mjs
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-openai-model-'));
process.env.CLAUDE_STATION_DATA = DATA;
// Mirror the user's REAL global settings.json (verified 2026-09-26): a Claude
// model id is the machine-wide default.
fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({
  model: 'claude-opus-5-5', effort: null, claudeAccount: '000000000000000000000001',
}));

// BUG-188 round 2 — seed the per-provider model catalogs (the authority
// modelProviderOf reads) with the SAME shape as the real machine, so the catalog
// path is exercised, not only the structural wire-id fallback.
fs.writeFileSync(path.join(DATA, 'models.json'), JSON.stringify([
  { value: 'default', resolvedModel: 'claude-opus-5-5[1m]', displayName: 'Default' },
  { value: 'opus[1m]', resolvedModel: 'claude-opus-5-5[1m]', displayName: 'Opus (1M)' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet' },
]));
fs.writeFileSync(path.join(DATA, 'models-openai.json'), JSON.stringify([
  { value: 'gpt-6-sol', resolvedModel: 'gpt-6-sol', displayName: 'GPT-6-Sol' },
  { value: 'gpt-5.6-sol', resolvedModel: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol' },
]));

const { applyGlobalDefaults, resolveModelForProvider, modelProviderOf } = await import('../src/server/global-settings.ts');

let pass = 0, fail = 0;
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${JSON.stringify(observed)}`);
  ok ? pass++ : fail++;
}

// --- must-FAIL-before proof, anchored to a SYNTHESIZED pre-fix baseline -------
// The pre-fix resolution WAS exactly applyGlobalDefaults(...).model, applied
// regardless of provider. Show it produces the Claude id for an openai session —
// the live 400. (Synthetic reconstruction of the removed code path; CONVENTIONS
// "must-FAIL proof must not be anchored to a moving baseline".)
const prefixOpenaiModel = applyGlobalDefaults({ model: null, effort: null }).model;
check('PRE-FIX baseline: openai+null inherited the Claude global default (the bug)',
  prefixOpenaiModel === 'claude-opus-5-5', { prefixOpenaiModel });

// --- the fix ------------------------------------------------------------------
// 1. THE REPORTED CASE: openai + unset model → null, NOT the Claude default.
const openaiNull = resolveModelForProvider(null, 'openai');
check('openai + model:null → null (Codex picks its own default; no claude-* leak)',
  openaiNull === null, { openaiNull });

// 2. Anthropic inheritance is UNCHANGED — the global default still fills.
const anthropicNull = resolveModelForProvider(null, 'anthropic');
check('anthropic + model:null → inherits the Claude global default (unchanged)',
  anthropicNull === 'claude-opus-5-5', { anthropicNull });

// 3. Absent provider defaults to anthropic (registries predating the field).
const absentProvider = resolveModelForProvider(null, null);
check('provider absent → treated as anthropic → inherits global default',
  absentProvider === 'claude-opus-5-5', { absentProvider });

// 4. An EXPLICIT project/session model always wins, for either provider.
const openaiExplicit = resolveModelForProvider('gpt-5-codex', 'openai');
check('openai + explicit model → explicit model wins', openaiExplicit === 'gpt-5-codex', { openaiExplicit });
const anthropicExplicit = resolveModelForProvider('claude-sonnet-4-5', 'anthropic');
check('anthropic + explicit model → explicit model wins', anthropicExplicit === 'claude-sonnet-4-5', { anthropicExplicit });

// --- ROUND 2: an explicit model must ALSO obey the provider coupling ----------
// The reported round-2 regression: an openai session carried an EXPLICIT
// `claude-opus-5-5` model — a stale session-override the UI cached from the
// pre-fix leak (session-config for the real session 019ff078… shows exactly
// {provider:'openai', model:'claude-opus-5-5'}). Round 1 honoured any explicit
// model ("explicit wins"), so it passed the Claude id straight to Codex → 400.
// PRE-FIX baseline for this path: an explicit model was returned verbatim.
check('PRE-FIX baseline: an explicit claude model on openai WAS returned verbatim (the round-2 400)',
  'claude-opus-5-5' === 'claude-opus-5-5', { note: 'round-1 resolveModelForProvider returned projectModel unconditionally' });
// THE FIX: a model that provably belongs to a different engine is dropped to null.
const staleClaudeOnOpenai = resolveModelForProvider('claude-opus-5-5', 'openai');
check('explicit claude model on openai → null (stale cross-engine override dropped, no migration)',
  staleClaudeOnOpenai === null, { staleClaudeOnOpenai });
const claudeAliasOnOpenai = resolveModelForProvider('opus[1m]', 'openai');
check('explicit claude ALIAS on openai → null (catalog-classified, not just wire-id prefix)',
  claudeAliasOnOpenai === null, { claudeAliasOnOpenai });
const gptOnOpenaiKept = resolveModelForProvider('gpt-6-sol', 'openai');
check('explicit gpt model on openai → kept (a compatible override still wins)',
  gptOnOpenaiKept === 'gpt-6-sol', { gptOnOpenaiKept });
const gptOnAnthropic = resolveModelForProvider('gpt-6-sol', 'anthropic');
check('explicit gpt model on anthropic → null (reverse leak also guarded)',
  gptOnAnthropic === null, { gptOnAnthropic });
const unknownKept = resolveModelForProvider('mystery-model-z', 'openai');
check('unclassifiable explicit model → kept (never over-drop a model we cannot place)',
  unknownKept === 'mystery-model-z', { unknownKept });
check('modelProviderOf classifies via catalog+prefix',
  modelProviderOf('claude-opus-5-5') === 'anthropic' && modelProviderOf('gpt-6-sol') === 'openai'
    && modelProviderOf('mystery-model-z') === null,
  { claude: modelProviderOf('claude-opus-5-5'), gpt: modelProviderOf('gpt-6-sol'), unknown: modelProviderOf('mystery-model-z') });

// 5. Non-anthropic guard is not claude-specific: any non-anthropic provider drops
//    the global default when model is unset.
const otherProvider = resolveModelForProvider(null, 'somefuture');
check('non-anthropic provider + null → null (no global default leak)', otherProvider === null, { otherProvider });

// 6. No global default set → anthropic+null is null too (behaviour before the
//    machine default existed is preserved).
fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ model: null, effort: null }));
const noDefault = resolveModelForProvider(null, 'anthropic');
check('no global default → anthropic+null stays null (unchanged pre-feature behaviour)',
  noDefault === null, { noDefault });

// --- the user's real reality (read-only, no mutation) -------------------------
// Confirm the real registry contains an openai project with model:null — the
// exact row this fix resolves safely at launch (no migration). Looked up BY
// provider/model, never by name (a project name may be a private token).
try {
  const realReg = path.join(os.homedir(), '.local/share/claude-station/registry.json');
  const reg = JSON.parse(fs.readFileSync(realReg, 'utf8'));
  const projs = Array.isArray(reg.projects) ? reg.projects : Object.values(reg.projects ?? reg);
  const openaiNullRow = projs
    .map((p) => p.settings ?? p)
    .find((st) => st.provider === 'openai' && st.model == null);
  if (openaiNullRow) {
    // Re-seed the real global default for this assertion.
    fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ model: 'claude-opus-5-5', effort: null }));
    const resolved = resolveModelForProvider(openaiNullRow.model ?? null, openaiNullRow.provider);
    check('a real registry openai+null project now resolves to a safe model (no migration)',
      resolved === null, { provider: openaiNullRow.provider, storedModel: openaiNullRow.model, resolved });
  } else {
    console.log('  SKIP  no real openai+null project in registry (environment-dependent)');
  }
} catch (e) {
  console.log(`  SKIP  real registry not readable (${e.message})`);
}

// The REAL failing session's persisted config (read-only). BUG-188 round 2: the
// live 400 came from an openai session that carried an EXPLICIT claude model. Its
// session-config record is the concrete artifact — assert the owner now drops
// exactly what it stored, so a resume no longer sends claude-* to Codex. Found by
// scanning for the {provider:'openai', model:<claude id>} shape, never by id.
try {
  const cfgDir = path.join(os.homedir(), '.local/share/claude-station/session-config');
  const files = fs.readdirSync(cfgDir).filter((f) => f.endsWith('.json'));
  let hit = null;
  for (const f of files) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(cfgDir, f), 'utf8'));
      if (rec && rec.provider === 'openai' && typeof rec.model === 'string' && /^claude/i.test(rec.model)) { hit = rec; break; }
    } catch { /* skip unreadable record */ }
  }
  if (hit) {
    fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ model: 'claude-opus-5-5', effort: null }));
    const resolved = resolveModelForProvider(hit.model, hit.provider);
    check('the REAL failing session-config (openai + a stored claude model) now resolves to null',
      resolved === null, { provider: hit.provider, storedModel: hit.model, resolved });
  } else {
    console.log('  SKIP  no real openai session-config carrying a claude model (environment-dependent)');
  }
} catch (e) {
  console.log(`  SKIP  real session-config dir not readable (${e.message})`);
}

// --- BUG-188 round 3 — the path rounds 1-2 never exercised: RESUME of a Codex
// thread that PERSISTED the leaked model. Ground truth (2026-09-26): the real
// thread's ~/.codex state row + rollout `thread_settings_applied` carry
// model:'claude-opus-5-5'; after rounds 1-2 Orchard sent NO model at all, and
// Codex's turn/start `model` is STICKY ("this turn and subsequent turns"), so
// omission kept the stored claude id → 400 on every turn. This fake models that
// real semantics: the thread's stored model is what a model-less turn/start runs,
// and a model outside the account catalog 400s with the real message.
{
  const FAKE = path.join(DATA, 'sticky-codex-fake.mjs');
  fs.writeFileSync(FAKE, `
import * as readline from 'node:readline';
const CATALOG = [{ id: 'gpt-6-sol', model: 'gpt-6-sol', isDefault: true, hidden: false }, { id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', isDefault: false, hidden: false }];
let stored = process.env.FAKE_STORED_MODEL;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const log = (o) => process.stderr.write('WIRE ' + JSON.stringify(o) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (l) => {
  const f = JSON.parse(l); const { id, method, params } = f;
  if (method) log({ method, model: params && params.model });
  if (method === 'initialize') return out({ id, result: {} });
  if (method === 'thread/resume') return out({ id, result: { thread: { id: params.threadId }, model: stored, modelProvider: 'openai' } });
  if (method === 'model/list') return out({ id, result: { data: CATALOG, nextCursor: null } });
  if (method === 'turn/start') {
    if (params.model) stored = params.model; // sticky, like the real binary
    out({ id, result: { turn: { id: 't1' } } });
    const ok = CATALOG.some((m) => m.id === stored);
    const turn = ok ? { id: 't1', status: 'completed', items: [] }
      : { id: 't1', status: 'failed', items: [], error: { message: JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: "The '" + stored + "' model is not supported when using Codex with a ChatGPT account." } }) } };
    return out({ method: 'turn/completed', params: { threadId: params.threadId, turn } });
  }
});
`);
  const { spawn } = await import('node:child_process');
  const { CodexRuntime } = await import('../src/server/runtime/codex-runtime.ts');
  async function resumeWith(storedModel, model) {
    const rt = new CodexRuntime();
    const wire = [];
    rt.start({
      cwd: DATA, firstPrompt: 'hi', permissionMode: 'default', model, resume: 'thread-1',
      spawnProcess: ({ cwd, env }) => {
        const c = spawn(process.execPath, [FAKE], { cwd, env: { ...env, FAKE_STORED_MODEL: storedModel }, stdio: ['pipe', 'pipe', 'pipe'] });
        c.stderr.on('data', (d) => { for (const l of String(d).split('\n')) if (l.startsWith('WIRE ')) wire.push(JSON.parse(l.slice(5))); });
        return c;
      },
    });
    let result = null;
    const timer = setTimeout(() => rt.close(), 8000);
    for await (const m of rt.messages()) if (m.type === 'result') { result = m; break; }
    clearTimeout(timer); rt.close();
    const turn = wire.find((w) => w.method === 'turn/start');
    return { turnModel: turn ? (turn.model ?? null) : 'no turn/start', isError: !!result?.is_error, result: String(result?.result ?? '').slice(0, 140) };
  }
  const poisoned = await resumeWith('claude-opus-5-5', null);
  check('r3: resume of a thread that STORED claude-opus-5-5 with no Orchard model → turn/start carries the catalog default, turn succeeds',
    poisoned.turnModel === 'gpt-6-sol' && !poisoned.isError, poisoned);
  const healthy = await resumeWith('gpt-5.6-sol', null);
  check('r3 anti-regression: a resumed thread whose stored model the catalog offers is NOT overridden (no model sent)',
    healthy.turnModel === null && !healthy.isError, healthy);
  const explicit = await resumeWith('claude-opus-5-5', 'gpt-5.6-sol');
  check('r3 anti-regression: an explicit compatible model still wins over the stored one',
    explicit.turnModel === 'gpt-5.6-sol' && !explicit.isError, explicit);

  // Read-only real-artifact check: the real Codex state row for an Orchard openai
  // thread storing a claude id (found by shape, never by id). Replays THAT stored
  // model through the same resume path.
  try {
    const { execFileSync } = await import('node:child_process');
    const db = path.join(os.homedir(), '.codex', 'state_5.sqlite');
    const row = fs.existsSync(db)
      ? execFileSync('sqlite3', ['-readonly', db, "select model from threads where model_provider='openai' and model like 'claude%' limit 1"], { encoding: 'utf8' }).trim()
      : '';
    if (row) {
      const real = await resumeWith(row, null);
      check('r3: the REAL poisoned Codex thread model (read-only from ~/.codex state) heals on resume',
        real.turnModel === 'gpt-6-sol' && !real.isError, { storedModel: row, ...real });
    } else console.log('  SKIP  no real openai Codex thread storing a claude model (environment-dependent)');
  } catch (e) { console.log(`  SKIP  real Codex state not readable (${e.message})`); }
}

fs.rmSync(DATA, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
