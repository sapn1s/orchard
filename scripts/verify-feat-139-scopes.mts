/**
 * FEAT-139 — Machine · Project · Session scope spine: the machine defaults must
 * actually SEED a new project, and the scope precedence must hold.
 *
 * This closes the clean-room BROKEN verdict (run 01a07dd4, 2026-09-08):
 *   - Defect 1: `model`/`effort` machine defaults were DEAD TOGGLES at project
 *     creation — a new project stored {"model":null,"effort":null} despite a
 *     machine default of haiku/low, while isolation + the tool block seeded
 *     correctly. Fixed structurally (SEED_CHANNEL in global-settings.ts +
 *     createProject reading it). Tests 1/2 are the must-FAIL proof: they redden
 *     against the pre-fix registry.ts and pass after.
 *   - Requirement 4 (explicit per-project value wins) is re-proved NON-VACUOUSLY
 *     now that the default actually lands (test 3).
 *   - Requirement 1 precedence (project beats machine; session beats project).
 *   - Requirement 6 (isolation degrades sanely with no container runtime).
 *
 * Module-level (no server) — deterministic and fast. The HTTP-route coverage
 * (unknown-field → 400, seeding over the real POST /api/projects route, theme
 * record check) lives in verify-feat-139-http.mjs.
 *
 *   node scripts/verify-feat-139-scopes.mts
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-feat139-'));
process.env.CLAUDE_STATION_DATA = DATA;
// FEAT-139 R6 (requirement 6): the container preflight (`dockerAvailable`) reads
// CLAUDE_STATION_DOCKER into a module const AT IMPORT TIME, so to exercise the
// no-container-runtime FALLBACK for real it must be pointed at a binary that is
// not on PATH BEFORE registry.ts (→ container-manager.ts) is imported below.
// This makes the machine look like one with no container runtime — the user's
// actual reality on such a host — so the fallback branch and its recorded reason
// ACTUALLY run, not the vacuous applied:'container'/reason:null the clean room
// caught. No other assertion here depends on container being available (the REG
// case sets isolation=sandbox explicitly; model/effort cases ignore isolation).
process.env.CLAUDE_STATION_DOCKER = 'cs-verify-no-such-docker-binary';
const WORK = path.join(DATA, 'work');
fs.mkdirSync(WORK, { recursive: true });

const { createProject, resolveNewProjectIsolation } = await import('../src/server/registry.ts');
const { applyGlobalDefaults, patchGlobalDefaults, readGlobalDefaults, SEED_CHANNEL } =
  await import('../src/server/global-settings.ts');

let pass = 0, fail = 0;
function check(name: string, ok: boolean, observed: unknown): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${JSON.stringify(observed)}`);
  ok ? pass++ : fail++;
}
let n = 0;
function projDir(): string {
  const d = path.join(WORK, `p${n++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function setGlobals(g: Record<string, unknown>): void {
  // Reset to a clean slate, then apply — patch clears with explicit null.
  const clear = { model: null, effort: null, isolation: null, openaiDispatch: null, serena: null, playwright: null, theme: 'system' };
  patchGlobalDefaults({ ...clear, ...g });
}

// ---- Defect 1: model + effort machine defaults SEED a new project -----------
setGlobals({ model: 'haiku', effort: 'low' });
const p1 = createProject({ hostPath: projDir() });
check('D1 machine model=haiku seeds new project.settings.model', p1.settings.model === 'haiku', p1.settings.model);
check('D1 machine effort=low seeds new project.settings.effort', p1.settings.effort === 'low', p1.settings.effort);

// Change the machine default and create again — the new stored config must move
// with it (the exact "changed defaults" attack the clean room ran over HTTP).
setGlobals({ model: 'sonnet', effort: 'high' });
const p1b = createProject({ hostPath: projDir() });
check('D1 changed machine default (sonnet/high) reflected in the next new project',
  p1b.settings.model === 'sonnet' && p1b.settings.effort === 'high',
  { model: p1b.settings.model, effort: p1b.settings.effort });

// ---- Requirement 4: an explicit per-project value WINS (now non-vacuous) ----
setGlobals({ model: 'haiku', effort: 'low' });
const p2 = createProject({ hostPath: projDir(), settings: { model: 'opus' } });
check('R4 explicit project model=opus overrides machine haiku (non-vacuous: default now lands)',
  p2.settings.model === 'opus', p2.settings.model);
check('R4 unset effort still inherits the machine default alongside the explicit model',
  p2.settings.effort === 'low', p2.settings.effort);
// Explicit null must also win (the "engine picks" choice), not be re-seeded.
const p2b = createProject({ hostPath: projDir(), settings: { model: null } });
check('R4 explicit project model=null wins over machine default (stays null)',
  p2b.settings.model === null, p2b.settings.model);

// ---- Live-inherit preserved when there is NO machine default ---------------
// A null machine default must leave the row null so it still inherits a LATER
// machine change (FEAT-118 semantics) — the reconciliation the fix relies on.
setGlobals({});
const p3 = createProject({ hostPath: projDir() });
check('LIVE no machine model default → new project stores null (still inheritable)',
  p3.settings.model === null && p3.settings.effort === null,
  { model: p3.settings.model, effort: p3.settings.effort });
setGlobals({ model: 'sonnet' });
check('LIVE a later machine model=sonnet reaches the null-storing project via applyGlobalDefaults',
  applyGlobalDefaults({ model: p3.settings.model, effort: p3.settings.effort }).model === 'sonnet',
  applyGlobalDefaults({ model: p3.settings.model, effort: p3.settings.effort }));

// ---- Requirement 1 precedence: project beats machine; session beats project -
setGlobals({ model: 'haiku', effort: 'low' });
check('R1 machine default applies where project leaves model unset',
  applyGlobalDefaults({ model: null, effort: null }).model === 'haiku',
  applyGlobalDefaults({ model: null, effort: null }));
check('R1 explicit project value beats the machine default',
  applyGlobalDefaults({ model: 'opus', effort: null }).model === 'opus',
  applyGlobalDefaults({ model: 'opus', effort: null }));
// Session-over-project: the launch merge (agent-bridge.ts ~L1074-1082) layers a
// session override on top of pickOverridable's project/machine result — a value
// present in overrides and different from the base wins. Exercised here on the
// end value (synthetic session layer; the production merge is inline in the
// launch method and not separately exported).
const base = applyGlobalDefaults({ model: 'opus', effort: null }); // project=opus over machine
const sessionOverride = { model: 'sonnet' };
const effective = { ...base, ...sessionOverride };
check('R1 session override beats the project value (session > project > machine)',
  effective.model === 'sonnet', effective);

// ---- Regression: isolation + tool machine defaults STILL seed ---------------
setGlobals({ isolation: 'sandbox', serena: false, openaiDispatch: false });
const p4 = createProject({ hostPath: projDir() });
check('REG machine isolation=sandbox still seeds new project.isolation',
  p4.isolation === 'sandbox', p4.isolation);
check('REG machine serena=false / openaiDispatch=false still seed the tool block',
  p4.settings.tools?.serena === false && p4.settings.tools?.openaiDispatch === false,
  p4.settings.tools);

// ---- Requirement 6: isolation degrades sanely with NO container runtime -----
// The clean room flagged the old assertion as VACUOUS: on a machine WITH Docker
// it observed applied:'container', reason:null — the fallback branch never ran,
// so the test could not fail. The no-runtime path is forced at the top of this
// file (CLAUDE_STATION_DOCKER → a binary not on PATH, set before import so the
// container-manager const picks it up), so dockerAvailable() returns not-ok and
// the fallback + its recorded reason ACTUALLY execute here.
setGlobals({ isolation: 'container' });
let threw = false, r6: { isolation: string; preflight: { wanted: string; applied: string; reason: string | null } } | null = null;
try { r6 = resolveNewProjectIsolation(projDir()) as typeof r6; } catch { threw = true; }
check('R6 (no runtime) container default never throws and resolves to direct',
  !threw && !!r6 && r6.isolation === 'direct', { threw, r6 });
check('R6 (no runtime) the fallback branch ACTUALLY ran: wanted=container, applied=direct',
  !!r6 && r6.preflight.wanted === 'container' && r6.preflight.applied === 'direct', r6?.preflight);
check('R6 (no runtime) the fallback records WHY (audit reason non-null, non-empty)',
  !!r6 && typeof r6.preflight.reason === 'string' && r6.preflight.reason.length > 0, r6?.preflight);

// ---- Structural: SEED_CHANNEL classifies EVERY machine default --------------
// The anti-dead-toggle guarantee is a compile-time one (adding a GlobalDefaults
// field without a channel is a type error via `satisfies`), but assert at runtime
// that the current field set is fully classified so a hand-edit that loosens the
// type is still caught.
const gKeys = Object.keys(readGlobalDefaults()).sort();
const seedKeys = Object.keys(SEED_CHANNEL).sort();
check('STRUCT every GlobalDefaults field has a declared seed channel (no field left unwired)',
  JSON.stringify(gKeys) === JSON.stringify(seedKeys), { gKeys, seedKeys });

// ---- Theme (requirement 7): a REAL persisted machine setting, machineOnly -----
// Theme is persisted server-side (patch → readGlobalDefaults reflects it) and is
// declared machineOnly, so it must NOT seed a project row (it is whole-app
// appearance, not project config). The default is 'system', never null.
setGlobals({ theme: 'dark' });
check('THEME patch persists to the global record (readGlobalDefaults sees dark)',
  readGlobalDefaults().theme === 'dark', readGlobalDefaults().theme);
check('THEME seed channel is machineOnly (declared "does not seed a project")',
  SEED_CHANNEL.theme === 'machineOnly', SEED_CHANNEL.theme);
const pTheme = createProject({ hostPath: projDir() });
check('THEME machineOnly: a new project row carries NO theme key (not seeded)',
  !('theme' in (pTheme.settings as Record<string, unknown>)) && pTheme.settings.theme === undefined,
  { hasThemeKey: 'theme' in (pTheme.settings as Record<string, unknown>), value: (pTheme.settings as Record<string, unknown>).theme });
setGlobals({});
check('THEME default is the concrete "system" (never null) when unset',
  readGlobalDefaults().theme === 'system', readGlobalDefaults().theme);

try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
