/**
 * mutant-tree.mjs — build an EXPLICITLY CONSTRUCTED broken variant of this checkout for a
 * must-FAIL proof that cannot drift with HEAD (docs/CONVENTIONS.md "A must-FAIL proof must
 * not be anchored to a moving baseline").
 *
 *   const root = buildMutantTree({ copy: ['src'], edits: [{ file: 'src/server/x.ts', from: '…', to: '…' }] });
 *   // boot `node <root>/src/server/index.ts` — projectRoot() resolves to <root>
 *
 * Every top-level entry of the checkout is SYMLINKED into a scratch dir except the ones in
 * `copy`, which are copied so the edits never touch the real tree. Each edit's `from` must
 * occur in the file exactly `count` times (default 1) — a mutant whose edit no longer
 * applies throws instead of silently booting the fixed code (a vacuous baseline).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempScratch } from './scratch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function buildMutantTree({ copy = ['src'], edits = [], prefix = 'mutant-tree-' } = {}) {
  const dir = mkdtempScratch(prefix);
  for (const name of fs.readdirSync(ROOT)) {
    if (name === '.git') continue;
    const src = path.join(ROOT, name);
    const dst = path.join(dir, name);
    if (copy.includes(name)) fs.cpSync(src, dst, { recursive: true });
    else fs.symlinkSync(src, dst);
  }
  for (const e of edits) {
    const top = e.file.split('/')[0];
    if (!copy.includes(top)) throw new Error(`mutant edit ${e.file}: its top-level dir "${top}" is symlinked, not copied — add it to copy`);
    const f = path.join(dir, e.file);
    const s = fs.readFileSync(f, 'utf8');
    const n = s.split(e.from).length - 1;
    const want = e.count ?? 1;
    if (n !== want) throw new Error(`mutant edit ${e.file}: expected ${want} occurrence(s) of ${JSON.stringify(e.from.slice(0, 80))}, found ${n} — the mutant would be vacuous`);
    fs.writeFileSync(f, s.split(e.from).join(e.to));
  }
  return dir;
}
