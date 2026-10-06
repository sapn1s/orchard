/**
 * BUG-217 round 9 — the data dir is moved away and a copy put back WHILE the outbox is saving `sending`.
 *
 * Run as its own process (a lost claim is sticky for the life of a process, as it must be):
 *
 *   node drift-child.mjs holder [<tree>]   — a world with one queued row; the dir is moved and copied back at the
 *        exact moment the outbox opens the journal to save `sending` (after its first ownership check, before the
 *        line is written). Prints JSON: what reached the CLI from here, and the row's state in the moved dir and
 *        in the copy now at the path. `<tree>` (a synthesized older tree) swaps in that tree's outbox + lanes.
 *   node drift-child.mjs copy <data> <sid> <text> [<tree>] — a second process serving the copy: takes the lock,
 *        loads the outbox, lets it deliver. Prints how many prompts carried the text.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as H from './outbox-harness.mjs';

const [mode, ...args] = process.argv.slice(2);
const rowsOf = (file, text) => {
  const out = new Map();
  try { for (const l of fs.readFileSync(file, 'utf8').split('\n')) { try { for (const r of JSON.parse(l).rows ?? []) if (r.text === text) out.set(r.id, r.state); } catch { /* torn */ } } } catch { /* none */ }
  return [...out.values()];
};
const treeLanes = (tree) => import(pathToFileURL(path.join(tree, 'src', 'server', 'lanes.ts')).href);
const outboxFile = (tree) => (tree ? path.join(tree, 'src', 'server', 'outbox.ts') : H.LIVE_OUTBOX);

if (mode === 'holder') {
  const tree = args[0] || null;
  const w = new H.World(outboxFile(tree), 'drift');
  process.env.CLAUDE_STATION_DATA = w.data;
  // An older tree's outbox imports THAT tree's lanes: it must hold that module's claim (the harness takes today's).
  if (tree) { const c = await (await treeLanes(tree)).claimWriter(); if (!c.ok) throw new Error(`tree claim: ${c.reason}`); }
  await w.start();
  const lanes = tree ? await treeLanes(tree) : await H.lanesModule();
  w.create('a');
  await H.settle();
  const text = w.msg('a').text;
  const moved = `${w.data}-moved`;
  let armed = true;
  let fired = false;
  const orig = fs.openSync;
  fs.openSync = function (p, flags, ...rest) {
    if (armed && flags === 'a+' && String(p).endsWith(`${w.sid}.jsonl`)) {
      armed = false;
      fired = true;
      fs.renameSync(w.data, moved);
      execFileSync('cp', ['-a', moved, w.data]);
    }
    return orig.call(this, p, flags, ...rest);
  };
  syncBuiltinESMExports();
  const errs = [];
  const saved = console.error;
  console.error = (...a) => { errs.push(a.join(' ')); };
  try { await w.deliver(); await H.settle(); } finally { console.error = saved; fs.openSync = orig; syncBuiltinESMExports(); }
  const out = {
    fired,
    holderPrompts: w.ctl.prompts.filter((p) => p.includes(text)).length,
    lost: lanes.writerLostReason ? lanes.writerLostReason() : null,
    movedRows: rowsOf(path.join(moved, 'outbox', `${w.sid}.jsonl`), text),
    copyRows: rowsOf(path.join(w.data, 'outbox', `${w.sid}.jsonl`), text),
    loggedLost: errs.some((l) => /DATA DIR LOST/.test(l)),
    loggedNothingHanded: errs.some((l) => /nothing handed over/.test(l)),
    data: w.data, moved, sid: w.sid, text,
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(0);
} else if (mode === 'copy') {
  const [data, sid, text, tree] = args;
  process.env.CLAUDE_STATION_DATA = data;
  const lanes = tree ? await treeLanes(tree) : await H.lanesModule();
  const c = await lanes.claimWriter();
  if (tree) { const c2 = await (await H.lanesModule()).claimWriter(); void c2; }
  const m = await H.loadOutbox(outboxFile(tree || null));
  const ctl = H.makeCtl();
  ctl.go = true;
  const saved = console.error;
  console.error = () => {};
  try { m.startOutbox(ctl.wiring); await H.settle(); await new Promise((r) => setTimeout(r, 300)); await H.settle(); } finally { console.error = saved; }
  m.stopOutbox();
  process.stdout.write(`${JSON.stringify({ claim: c.ok, copyPrompts: ctl.prompts.filter((p) => p.includes(text)).length, rows: rowsOf(path.join(data, 'outbox', `${sid}.jsonl`), text) })}\n`);
  process.exit(0);
}
