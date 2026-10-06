/**
 * BUG-217 round 4 — serve a SYNTHESIZED ledger to a scratch server.
 *
 * `NODE_OPTIONS=--import=<this file>` plus `BUG217_LEDGER_SWAPS` (a JSON array of
 * [from, to] pairs) rewrites src/server/queue-ledger.ts as the server loads it.
 * The verify suite uses it to put the round-3 behaviour back (absence reads as
 * "never delivered", one ledger for every session, a 7-day TTL) from the CURRENT
 * file — never `git show HEAD`, so committing the fix cannot turn the must-fail
 * proof into decoration. Every `from` must match exactly once, or the server
 * refuses to boot: a transform that silently stopped applying would prove nothing.
 */
import { register } from 'node:module';

register(`data:text/javascript,${encodeURIComponent(`
const swaps = JSON.parse(process.env.BUG217_LEDGER_SWAPS || '[]');
export async function load(url, context, next) {
  const r = await next(url, context);
  if (!url.endsWith('/src/server/queue-ledger.ts') || !swaps.length) return r;
  let src = String(r.source);
  for (const [from, to] of swaps) {
    const n = src.split(from).length - 1;
    if (n !== 1) throw new Error('BUG-217 ledger transform: anchor matches ' + n + ' times, not once — the fix changed shape; update the synthesized baseline: ' + from);
    src = src.replace(from, () => to);
  }
  return { ...r, source: src };
}
`)}`);
