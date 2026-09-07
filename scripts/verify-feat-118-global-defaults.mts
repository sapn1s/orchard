/**
 * FEAT-118 — the global-default resolution authority.
 *
 * Proves the ONE merge that decides what a project inherits: global default is
 * applied UNDER a project's own value, an explicit project value overrides it,
 * and the store reads/writes/validates honestly. Points CLAUDE_STATION_DATA at
 * a throwaway dir so the real user's settings.json is never touched.
 *
 *   node scripts/verify-feat-118-global-defaults.mts
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-feat118-'));
process.env.CLAUDE_STATION_DATA = DATA;
const SETTINGS = path.join(DATA, 'settings.json');

const { applyGlobalDefaults, readGlobalDefaults, patchGlobalDefaults, GLOBAL_DEFAULTS } = await import('../src/server/global-settings.ts');

let pass = 0, fail = 0;
function check(name: string, ok: boolean, observed: unknown): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${JSON.stringify(observed)}`);
  ok ? pass++ : fail++;
}
function writeSettings(obj: unknown): void { fs.writeFileSync(SETTINGS, JSON.stringify(obj)); }
function rmSettings(): void { try { fs.rmSync(SETTINGS); } catch { /* absent is fine */ } }
// FEAT-139 widened GlobalDefaults past {model, effort} to seven fields, so the
// "no settings / corrupt settings" cases must assert the shape-AGNOSTIC invariant
// — read resolves to the OWNER-DECLARED defaults (GLOBAL_DEFAULTS), nothing thrown
// — instead of pinning a fixed JSON string that legitimate feature growth reddens.
// Comparing to GLOBAL_DEFAULTS also correctly tolerates fields whose documented
// default is NOT null (theme='system'), which a blanket "every field null" check
// wrongly reddened once theme landed. Adding an 8th field never re-breaks this.
function sortedJson(o: unknown): string {
  const r = o as Record<string, unknown>;
  return JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k]]));
}
function matchesDefaults(o: Record<string, unknown>): boolean {
  return Object.keys(o).length > 0 && sortedJson(o) === sortedJson(GLOBAL_DEFAULTS);
}

// 1. No global file → defaults, and a project keeps its own values unchanged.
rmSettings();
check('no settings file → read resolves to the owner-declared defaults', matchesDefaults(readGlobalDefaults() as Record<string, unknown>), readGlobalDefaults());
check('no global → project model=null stays null (engine picks, unchanged behaviour)',
  applyGlobalDefaults({ model: null, effort: null }).model === null, applyGlobalDefaults({ model: null, effort: null }));

// 2. Global default applies to a project with an UNSET model.
writeSettings({ model: 'haiku', effort: null });
check('global model=haiku applies to project model=null', applyGlobalDefaults({ model: null, effort: null }).model === 'haiku',
  applyGlobalDefaults({ model: null, effort: null }));

// 3. An explicit project model OVERRIDES the global default.
check('project model=opus overrides global haiku', applyGlobalDefaults({ model: 'opus', effort: null }).model === 'opus',
  applyGlobalDefaults({ model: 'opus', effort: null }));

// 4. Effort inherits independently of model.
writeSettings({ model: 'haiku', effort: 'low' });
const merged = applyGlobalDefaults({ model: 'sonnet', effort: null });
check('project model=sonnet wins, effort inherits global low', merged.model === 'sonnet' && merged.effort === 'low', merged);

// 5. A corrupt settings file resolves to defaults rather than throwing.
fs.writeFileSync(SETTINGS, '{ this is not json');
let corruptThrew = false; let corruptResult: unknown = null;
try { corruptResult = readGlobalDefaults(); } catch { corruptThrew = true; }
check('corrupt settings → read resolves to the owner-declared defaults, no throw',
  !corruptThrew && matchesDefaults(corruptResult as Record<string, unknown>), { corruptThrew, corruptResult });

// 6. An unknown/garbage field is ignored on read.
writeSettings({ model: 'opus', effort: 'nope', junk: 1 });
const r6 = readGlobalDefaults();
check('unknown effort value dropped, model kept', r6.model === 'opus' && r6.effort === null, r6);

// 6b. FEAT-139 — theme resolves to its concrete built-in ('system'), never null,
// and a garbage stored theme falls back to 'system' (a corrupt file can never
// leave the UI themeless). A valid theme round-trips through patch → read.
writeSettings({ theme: 'chartreuse' });
check('garbage theme value → resolves to built-in system (never themeless)', readGlobalDefaults().theme === 'system', readGlobalDefaults().theme);
const pt = patchGlobalDefaults({ theme: 'dark' });
check('patch theme=dark ok and persists', pt.ok && readGlobalDefaults().theme === 'dark', { ok: pt.ok, read: readGlobalDefaults().theme });
const ptBad = patchGlobalDefaults({ theme: 'neon' });
check('patch invalid theme rejected (strict)', !ptBad.ok, ptBad);
check('rejected theme patch wrote nothing (still dark)', readGlobalDefaults().theme === 'dark', readGlobalDefaults().theme);

// 7. patchGlobalDefaults: valid write, partial merge, clear, and rejections.
rmSettings();
const p1 = patchGlobalDefaults({ model: 'haiku' });
check('patch model=haiku ok', p1.ok && p1.value.model === 'haiku' && p1.value.effort === null, p1);
const p2 = patchGlobalDefaults({ effort: 'high' });
check('patch effort=high leaves model=haiku (partial merge)', p2.ok && p2.value.model === 'haiku' && p2.value.effort === 'high', p2);
const p3 = patchGlobalDefaults({ model: null });
check('patch model=null clears model, keeps effort', p3.ok && p3.value.model === null && p3.value.effort === 'high', p3);
const p4 = patchGlobalDefaults({ model: 'bad model!!' });
check('patch invalid model rejected', !p4.ok, p4);
const p5 = patchGlobalDefaults({ nope: 1 });
check('patch unknown field rejected', !p5.ok, p5);
const p6 = patchGlobalDefaults('not an object');
check('patch non-object rejected', !p6.ok, p6);

// 8. The written file round-trips through readGlobalDefaults.
patchGlobalDefaults({ model: 'sonnet', effort: 'medium' });
const disk = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
check('written file round-trips', disk.model === 'sonnet' && disk.effort === 'medium', disk);

try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
