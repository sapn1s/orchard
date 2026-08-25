/**
 * verify-orchestrator-profile-registry.mts — FEAT-096 phase 2.
 *
 * The per-project switch, exercised through the REAL registry and the REAL
 * validator, in an ISOLATED data dir (`CLAUDE_STATION_DATA`) so the live
 * registry and the running service are never touched.
 *
 * The properties here are the ones that make this safe to try on one project:
 * default-off, per-project, reversible by a one-key patch, and incapable of
 * widening a tool surface from configuration.
 *
 * Run: npm run verify:orchestrator-profile-registry
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orchard-profile-rt-'));
process.env.CLAUDE_STATION_DATA = path.join(base, 'data');
fs.mkdirSync(path.join(base, 'demo'), { recursive: true });
fs.mkdirSync(path.join(base, 'other'), { recursive: true });

let bad = 0;
const reg = await import('../src/server/registry.ts');
const { validateProjectPatch } = await import('../src/server/validate.ts');
const p = reg.createProject({ name: 'rt-demo', hostPath: path.join(base, 'demo') } as never);
const say = (n: string, c: boolean) => { if (!c) bad++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}`); };
say('default is OFF (opt-in, not opt-out)', reg.orchestratorProfileOf(p).enabled === false);
reg.updateProject(p.id, validateProjectPatch({ orchestratorProfile: { enabled: true } }) as never);
say('turning it on for ONE project persists', reg.orchestratorProfileOf(reg.getProject(p.id)!).enabled === true);
const other = reg.createProject({ name: 'rt-other', hostPath: path.join(base, 'other') } as never);
say('a sibling project is unaffected (per-project, not fleet-wide)', reg.orchestratorProfileOf(reg.getProject(other.id)!).enabled === false);
reg.updateProject(p.id, validateProjectPatch({ orchestratorProfile: { enabled: false } }) as never);
say('REVERSIBLE by a one-key patch', reg.orchestratorProfileOf(reg.getProject(p.id)!).enabled === false);
const snap = () => JSON.stringify(reg.getProject(p.id)!.settings.allowedTools) + JSON.stringify(reg.getProject(p.id)!.settings.instructions) + JSON.stringify(reg.getProject(p.id)!.settings.permissionMode);
const before = snap();
reg.updateProject(p.id, validateProjectPatch({ orchestratorProfile: { enabled: true } }) as never);
say('flipping it rewrites nothing else', before === snap());
let threw = false; try { validateProjectPatch({ orchestratorProfile: { enabled: 'yes' } }); } catch { threw = true; }
say('a non-boolean is rejected', threw);
let threw2 = false; try { validateProjectPatch({ orchestratorProfile: { allowedTools: ['Bash'] } }); } catch { threw2 = true; }
say('a registry edit cannot invent a tool surface (policy is code, not config)', threw2);

fs.rmSync(base, { recursive: true, force: true });
console.log(`\n${bad === 0 ? 'PASS' : 'FAIL'} — orchestrator profile registry round-trip`);
process.exit(bad === 0 ? 0 : 1);
