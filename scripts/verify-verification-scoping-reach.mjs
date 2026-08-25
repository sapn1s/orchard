/**
 * Regression guard — the verification-SCOPING rule reaches every registered
 * project, and the rule it replaced is gone.
 *
 *   node scripts/verify-verification-scoping-reach.mjs
 *
 * WHY THIS EXISTS
 * ---------------
 * A trivial landing-page fix on another project bought a full independent
 * verification round, because the Working Agreement that project receives at
 * launch said every `fix` gets one. The measured rule — rounds are spent by
 * HARM CLASS, and a contained render/CSS change gets zero — existed only in
 * docs/analysis/counterfactual-2026-08-20-minimum-path.md, which no prompt,
 * script or hook cites. The rule was live in practice and dead in instruction.
 *
 * Delivery was checked BEFORE any text was written, and delivery is not the
 * problem: `composeInstructions` reads docs/prompts/WORKING_AGREEMENT.v2.md
 * fresh from THIS checkout on every launch, for every project, so one edit
 * reaches the whole fleet with no re-seed and no per-project action. That is
 * exactly what this script asserts, against the REAL registry rather than a
 * fixture — for every project, not just this one.
 *
 * WHAT IT CHECKS, per registered project with an enabled WA stack:
 *   1. Each scoping marker is present in the composed system prompt — the real
 *      launch fold (composeInstructions + board snapshot), as agent-bridge does.
 *   2. CONTROL: the same fold with an EMPTY instruction stack does NOT contain
 *      them. Without this a marker that happened to live in a project's
 *      CONVENTIONS.md or the board snapshot would pass while proving nothing.
 *   3. The WA's LAST line lands too — the v2 template is read uncapped, but
 *      routing/response-format/conventions are capped, so "the tail survives"
 *      is the check that a future cap on the WA would redden.
 *   4. The SUPERSEDED sentence is absent. Two contradictory thresholds shipping
 *      together is worse than either alone.
 *
 * Read-only: opens no server, writes no files, mutates no registry.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const WA_V2 = path.join(ROOT, 'docs', 'prompts', 'WORKING_AGREEMENT.v2.md');

/**
 * Distinctive body text of each rule this lane promoted out of the analysis doc.
 * Each must be unique to the WA — the CONTROL check below is what proves it.
 */
const MARKERS = [
  ['harm-class threshold', 'rounds are spent by HARM CLASS'],
  ['contained-render row (zero rounds)', 'Contained render / one cell / CSS / copy'],
  ['stopping rule', 'the round NUMBER is not the test'],
  ['two-cosmetic-rounds stop', 'wording-or-cosmetics-only'],
  ['fixer demonstrates / verifier attacks', 'the fixer DEMONSTRATES, the verifier ATTACKS'],
  ['handoff list is a work queue', 'a work queue, not a disclosure'],
];

/** The sentence the harm-class table replaces. Shipping both is the failure. */
const SUPERSEDED = 'required for `fix`, `plan+review`\nand `arch`. NOT required for `trivial`';

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

  const regFile = registryFile();
  if (!fs.existsSync(regFile)) {
    console.log(`SKIP: no registry at ${regFile} — nothing to guard on this host.`);
    return;
  }
  const projects = JSON.parse(fs.readFileSync(regFile, 'utf8')).projects ?? [];

  console.log(`\n=== verification-scoping reach — ${projects.length} registered projects ===\n`);

  /* --- 0. The source of truth, and the canonical/mirror pair. ------------- */
  const waText = fs.readFileSync(WA_V2, 'utf8');
  for (const [label, text] of MARKERS) {
    check(`WA v2 source carries the ${label}`, waText.includes(text), `present=${waText.includes(text)}`);
  }
  check(
    'the superseded dispatch-class threshold is GONE from the WA source',
    !waText.includes(SUPERSEDED),
    `present=${waText.includes(SUPERSEDED)}`,
  );

  const methodologyDir = process.env.METHODOLOGY_DIR ?? path.join(process.env.HOME ?? '', 'projects', 'methodology');
  const canonical = path.join(methodologyDir, 'WORKING_AGREEMENT.v2.md');
  if (fs.existsSync(canonical)) {
    check(
      'canonical methodology copy is byte-identical to the injected mirror (sync:methodology was run)',
      fs.readFileSync(canonical, 'utf8') === waText,
      `${canonical} vs ${WA_V2}`,
    );
  } else {
    console.log(`  NOTE  no canonical methodology checkout at ${canonical} — mirror is authoritative here.`);
  }

  /* The WA's last non-empty line: proves the whole template lands, uncapped. */
  const tail = waText.trimEnd().split('\n').filter((l) => l.trim()).pop().trim();

  /* --- 1. Every project, through the REAL launch composition path. -------- */
  const reached = [];
  const skipped = [];
  for (const project of projects) {
    const refs = project.settings?.instructions ?? [];
    const enabled = refs.filter((r) => r.enabled !== false).map((r) => r.templateId);
    const label = `${project.id} (${project.hostPath})`;

    if (!enabled.includes('working-agreement-v2')) {
      skipped.push(`${label} — no enabled working-agreement-v2 ref (stack: [${enabled.join(', ')}])`);
      continue;
    }
    if (!project.hostPath || !fs.existsSync(project.hostPath)) {
      skipped.push(`${label} — hostPath does not exist on disk (dead registry row)`);
      continue;
    }

    let live;
    let control;
    try {
      const composed = composeInstructions(refs, { hostPath: project.hostPath, routing: true });
      live = appendOf(appendToSystemPrompt(composed.systemPrompt, boardStateSection(project.hostPath)));
      const emptyComposed = composeInstructions([], { hostPath: project.hostPath, routing: true });
      control = appendOf(appendToSystemPrompt(emptyComposed.systemPrompt, boardStateSection(project.hostPath)));
    } catch (err) {
      check(`${label}: composition succeeds`, false, String(err && err.message));
      continue;
    }

    for (const [markerLabel, text] of MARKERS) {
      check(`${project.id}: launch bundle carries the ${markerLabel}`, live.includes(text), `present=${live.includes(text)}`);
      check(
        `${project.id}: CONTROL — ${markerLabel} absent with an empty instruction stack`,
        !control.includes(text),
        `present-in-control=${control.includes(text)}`,
      );
    }
    check(
      `${project.id}: the WA's LAST line survives the fold (nothing truncates v2)`,
      live.includes(tail),
      `tail=${JSON.stringify(tail.slice(0, 48))}… present=${live.includes(tail)}`,
    );
    check(
      `${project.id}: the superseded threshold is not also shipping`,
      !live.includes(SUPERSEDED),
      `present=${live.includes(SUPERSEDED)}`,
    );
    reached.push(`${project.id} — ${live.length} chars composed`);
  }

  console.log(`\n  REACHED (${reached.length}):`);
  for (const r of reached) console.log(`    - ${r}`);
  console.log(`\n  NOT REACHED (${skipped.length}) — each is a real gap, not a pass:`);
  for (const s of skipped) console.log(`    - ${s}`);

  console.log(`\n${fail === 0 ? 'VERDICT: PASS' : 'VERDICT: FAIL'} — ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('failed checks:\n  - ' + failures.join('\n  - '));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
