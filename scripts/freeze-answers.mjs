#!/usr/bin/env node
/**
 * freeze-answers.mjs — FEAT-166 r3: write a board's ONE-TIME frozen snapshot of the
 * user answers its Activity-log prose carried before answers became typed entries.
 *
 * For every ticket with a user-reply heading, records the round-2 prose reader's
 * output (src/server/board.ts legacyProseAnswerFreeze): the decision_key it was
 * bound to, the ticket-detail answer state, the answered-lane text/date, and the
 * sha of every user-reply heading (board:check accounting). Read-only afterwards:
 * pin the printed sha256 in ANSWER_FROZEN_PINS (scripts/lib/answer-source.mjs).
 *
 * Refuses to overwrite an existing snapshot — re-freezing would bless prose typed
 * since, which is exactly what the freeze exists to prevent.
 *
 *   node scripts/freeze-answers.mjs [--board <dir>] [--out <file>]
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';
import { ANSWER_FROZEN_FILE, ANSWER_FROZEN_SCHEMA } from './lib/answer-source.mjs';
import { TICKET_FILE_RE, idFromFilename } from './lib/ticket-schema.mjs';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(`--${k}`); return i === -1 ? null : args[i + 1]; };
const dir = path.resolve(opt('board') ?? path.join(HERE, '..', 'docs', 'bugs'));
const out = path.resolve(opt('out') ?? path.join(dir, ANSWER_FROZEN_FILE));
if (fs.existsSync(out)) {
  console.error(`freeze-answers: ${out} already exists — the snapshot is written ONCE. Refusing.`);
  process.exit(1);
}
const { legacyProseAnswerFreeze } = await import(url.pathToFileURL(path.join(HERE, '..', 'src', 'server', 'board.ts')).href);
const tickets = {};
for (const f of fs.readdirSync(dir).filter((n) => TICKET_FILE_RE.test(n)).sort()) {
  const id = idFromFilename(f);
  const rec = legacyProseAnswerFreeze(fs.readFileSync(path.join(dir, f), 'utf8'));
  if (id && rec) tickets[id] = rec;
}
const doc = {
  schema: ANSWER_FROZEN_SCHEMA,
  frozen_on: new Date().toISOString().slice(0, 10),
  note: 'Frozen output of the round-2 Activity-log prose answer reader (FEAT-166 r3). Read-only: pinned by sha256 in scripts/lib/answer-source.mjs. New answers are typed entries written by the server answer route.',
  tickets,
};
const bytes = `${JSON.stringify(doc, null, 2)}\n`;
fs.writeFileSync(out, bytes);
console.log(`wrote ${out} — ${Object.keys(tickets).length} ticket(s)`);
console.log(`PIN IT: add '${crypto.createHash('sha256').update(bytes).digest('hex')}' to ANSWER_FROZEN_PINS in scripts/lib/answer-source.mjs — until then none of it counts.`);
