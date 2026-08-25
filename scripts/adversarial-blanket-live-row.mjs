#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';

const source = new URL('./verify-bug-105-foreground-subagent-of-live-owner.mjs', import.meta.url);
const generated = new URL('./.adversarial-blanket-live-row.generated.mjs', import.meta.url);
let code = readFileSync(source, 'utf8');

code = code.replace(
  "TU('fgSub3', 'failed');                                     // a GENUINE agent death",
  "TN('fgSub3', 'stopped');                                  // blanket teardown notice while row exists",
);
code = code.replace(
  "endedForId(fg, 'fgSub3').some((o) => o.kind === 'failed'),",
  "endedForId(fg, 'fgSub3').length === 0 && rowsById(fg, 'fgSub3').length === 1,",
);
code = code.replace(
  "{ fgSub3Ended: endedForId(fg, 'fgSub3').map((o) => o.kind), allEnded: allEnded(fg) });",
  "{ fgSub3Ended: endedForId(fg, 'fgSub3').map((o) => o.kind), fgSub3Rows: rowsById(fg, 'fgSub3').length, provenance: 'SCRIPTED FAKE CLI through real server and real bridge; no real CLI' });",
);
code = code.replace(
  /async function main\(\) \{[\s\S]*?\n\}\n\nlet fatal = false;/,
  `async function main() {
  const fg = await runScenario('fgsub', 'blanket stopped notice lands on an existing live row under a live owner', 2);
  check('blanket stopped notice never becomes a per-task verdict when the row already exists',
    endedForId(fg, 'fgSub3').length === 0 && rowsById(fg, 'fgSub3').length === 1,
    { ended: endedForId(fg, 'fgSub3').map((o) => o.kind), rows: rowsById(fg, 'fgSub3').length,
      provenance: 'SCRIPTED FAKE CLI through real server and real bridge; no real CLI' });
}

let fatal = false;`,
);

writeFileSync(generated, code);
const result = spawnSync(process.execPath, [generated.pathname], { stdio: 'inherit' });
rmSync(generated, { force: true });
process.exit(result.status ?? 1);
