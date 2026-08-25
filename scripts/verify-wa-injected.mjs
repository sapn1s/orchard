/**
 * Regression guard — the shared Working Agreement really is injected into this
 * project's sessions.
 *
 *   node scripts/verify-wa-injected.mjs        (npm run verify:wa-injected)
 *
 * WHY THIS EXISTS
 * ---------------
 * This repo's own registry row had `settings.instructions: []` for weeks while
 * everyone assumed the WA was loaded. Nothing failed — the gap was SILENT,
 * because "no instructions attached" is a perfectly valid config. This script
 * makes that state loud: it reads the REAL registry row for this checkout and
 * runs the REAL composition path the session launcher uses
 * (`composeInstructions(refs, { hostPath, routing: true })` +
 * `appendToSystemPrompt(sp, boardStateSection(hostPath))`, exactly as
 * src/server/agent-bridge.ts does), then asserts distinctive WA body text is
 * actually present in the composed system prompt.
 *
 * Both WA templates are required, and in that order:
 *   working-agreement      (v1) — the stable base: definition of done, evidence
 *                                 over narrative, autonomy limits, final report
 *   working-agreement-v2   (v2) — the living extension; it literally opens with
 *                                 "Everything in v1, plus:" and shares no
 *                                 sections with v1, so v2 alone injects a
 *                                 document that references a base that is never
 *                                 loaded.
 *
 * MUST-FAIL CONTROL: the same markers are asserted ABSENT when the instruction
 * stack is empty. Without that, a marker string that happened to live in
 * docs/CONVENTIONS.md or the routing mirror would make this script pass while
 * proving nothing.
 *
 * Read-only: opens no server, writes no files, mutates no registry.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/** Body text unique to each WA template — absent from every other injected section. */
const MARKERS = [
  { tpl: 'working-agreement', text: 'build it to production confidence' },
  { tpl: 'working-agreement', text: '### 2. Evidence over narrative' },
  { tpl: 'working-agreement-v2', text: '### C. Make verification fail loudly' },
  { tpl: 'working-agreement-v2', text: 'Everything in v1, plus:' },
];
const REQUIRED_TEMPLATES = ['working-agreement', 'working-agreement-v2'];

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, observed) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        observed: ${observed}`);
  if (ok) pass++;
  else {
    fail++;
    failures.push(name);
  }
}
const appendOf = (sp) => (typeof sp === 'string' ? sp : sp && typeof sp === 'object' ? sp.append : '');

async function main() {
  const { registryFile } = await import(path.join(ROOT, 'src', 'lib', 'paths.ts'));
  const { composeInstructions, appendToSystemPrompt } = await import(path.join(ROOT, 'src', 'server', 'templates.ts'));
  const { boardStateSection } = await import(path.join(ROOT, 'src', 'server', 'board.ts'));
  const { wiringStatus } = await import(path.join(ROOT, 'src', 'server', 'wiring.ts'));

  const regFile = registryFile();
  if (!fs.existsSync(regFile)) {
    // A checkout with no local station data (CI, fresh clone) has no project
    // row to guard. Say so loudly and exit 0 — failing here would mean this
    // script cries wolf everywhere except the one machine it protects.
    console.log(`SKIP: no registry at ${regFile} — nothing to guard on this host.`);
    return;
  }
  const registry = JSON.parse(fs.readFileSync(regFile, 'utf8'));
  const projects = registry.projects ?? [];
  // Resolve by hostPath, not by id: this repo's id ('claude-station') predates
  // the rename to orchard, and a future re-register must not silently skip.
  const project = projects.find((p) => path.resolve(p.hostPath ?? '') === ROOT);

  console.log(`\n=== Working Agreement injection guard — ${ROOT} ===`);
  check('this checkout is a registered project', !!project, project ? `id=${project.id} name=${project.name}` : `no project with hostPath ${ROOT}`);
  if (!project) {
    report();
    return;
  }

  const refs = project.settings?.instructions ?? [];
  const enabled = refs.filter((r) => r.enabled !== false).map((r) => r.templateId);
  for (const tpl of REQUIRED_TEMPLATES) {
    check(`instruction stack has an ENABLED ref to ${tpl}`, enabled.includes(tpl), `enabled refs: [${enabled.join(', ')}]`);
  }
  check(
    'v1 (base) is ordered before v2 (extension)',
    enabled.indexOf('working-agreement') >= 0 && enabled.indexOf('working-agreement') < enabled.indexOf('working-agreement-v2'),
    `order: [${enabled.join(', ')}]`,
  );

  /* The real launch composition — mirrors agent-bridge.ts. */
  const composed = composeInstructions(refs, { hostPath: project.hostPath, routing: true });
  const live = appendOf(appendToSystemPrompt(composed.systemPrompt, boardStateSection(project.hostPath)));

  /* Must-fail control: the same fold with an EMPTY stack must not contain the markers. */
  const emptyComposed = composeInstructions([], { hostPath: project.hostPath, routing: true });
  const control = appendOf(appendToSystemPrompt(emptyComposed.systemPrompt, boardStateSection(project.hostPath)));

  for (const { tpl, text } of MARKERS) {
    check(`composed system prompt contains ${tpl} marker ${JSON.stringify(text)}`, live.includes(text), `present=${live.includes(text)}`);
    check(`CONTROL: marker ${JSON.stringify(text)} absent with an empty instruction stack`, !control.includes(text), `present-in-control=${control.includes(text)}`);
  }

  check('composed mode is append (WA layers onto the Claude Code preset, not replacing it)', composed.mode === 'append', `mode=${composed.mode}`);
  check('no instruction template failed to resolve', composed.missingIds.length === 0, `missingIds=[${composed.missingIds.join(', ')}]`);

  const wa = wiringStatus(project).checks.find((c) => c.key === 'working-agreement');
  check('wiring panel reports the Working Agreement check as ok', wa?.state === 'ok', `state=${wa?.state} apply=${wa?.apply}`);

  console.log(
    `\n  injected system-prompt append: ${live.length} chars (~${Math.round(live.length / 4)} tokens); ` +
      `without the WA it would be ${control.length} chars (~${Math.round(control.length / 4)} tokens) — ` +
      `WA adds ${live.length - control.length} chars (~${Math.round((live.length - control.length) / 4)} tokens) per session.` +
      `\n  applied sections: ${composed.appliedIds.join(', ')}`,
  );
  report();
}

function report() {
  console.log(`\n${fail === 0 ? 'VERDICT: PASS' : 'VERDICT: FAIL'} — ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('failed checks:\n  - ' + failures.join('\n  - '));
    console.log(
      '\nFIX: attach both WA templates through the validated path (do NOT hand-edit registry.json):\n' +
        `  curl -X PATCH localhost:4317/api/projects/<id> -H 'content-type: application/json' \\\n` +
        `    -d '{"settings":{"instructions":[{"templateId":"working-agreement","enabled":true},{"templateId":"working-agreement-v2","enabled":true}]}}'`,
    );
    process.exitCode = 1;
  }
}

await main();
