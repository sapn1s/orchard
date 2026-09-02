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

const { applyGlobalDefaults, readGlobalDefaults, patchGlobalDefaults } = await import('../src/server/global-settings.ts');

let pass = 0, fail = 0;
function check(name: string, ok: boolean, observed: unknown): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${JSON.stringify(observed)}`);
  ok ? pass++ : fail++;
}
function writeSettings(obj: unknown): void { fs.writeFileSync(SETTINGS, JSON.stringify(obj)); }
function rmSettings(): void { try { fs.rmSync(SETTINGS); } catch { /* absent is fine */ } }

// 1. No global file → defaults, and a project keeps its own values unchanged.
rmSettings();
check('no settings file → defaults null/null', JSON.stringify(readGlobalDefaults()) === '{"model":null,"effort":null}', readGlobalDefaults());
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
check('corrupt settings → defaults, no throw', JSON.stringify(readGlobalDefaults()) === '{"model":null,"effort":null}', readGlobalDefaults());

// 6. An unknown/garbage field is ignored on read.
writeSettings({ model: 'opus', effort: 'nope', junk: 1 });
const r6 = readGlobalDefaults();
check('unknown effort value dropped, model kept', r6.model === 'opus' && r6.effort === null, r6);

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
