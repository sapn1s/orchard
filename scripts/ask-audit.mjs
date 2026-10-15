#!/usr/bin/env node
/**
 * ask-audit — re-measure how often orchestrator sessions stop to ask the user (BUG-256).
 *
 *   node scripts/ask-audit.mjs [--since YYYY-MM-DD] [--dir <encoded project dir>] [--json] [--sample N]
 *
 * Reads top-level orchestrator transcripts from the Claude Code store
 * (CLAUDE_PROJECTS_DIR, default ~/.claude/projects; the dir defaults to this
 * checkout's encoded cwd). A turn "asks" when its FINAL text (after any Stop-hook
 * re-send) carries an `orchard-ask` block, it called AskUserQuestion, or its last
 * lines put a question to the user in prose. For each ask it records the decider
 * token, whether that token is a hard stop (scripts/lib/format-metrics.mjs), and
 * whether the user's next message just delegated ("yes", "do what you recommend").
 *
 * It does NOT decide which asks were unnecessary — that is a judgement. `--sample N`
 * prints N random asks for a human or an independent reviewer to classify, which is
 * how docs/research/unnecessary-asks-2026-10-14.md measured the baseline (~45% of
 * 282). Re-run after a change and compare. Read-only; never writes.
 *
 * BUG-256 r2 — the turn-end check validates the ask's DECLARATION (a hard-stop code
 * first, then a consequence); it cannot tell a true `money` from an agent-effort ask
 * relabelled `money`. That residual is MEASURED here, not claimed prevented:
 * `byStop` gives, per leading decider code, how many asks were replied to, how many
 * replies were a plain affirmative ("yes", "go") and how many explicitly DELEGATED
 * the call back ("do what you recommend", "up to you"). A code whose asks are mostly
 * delegated back is a REVIEW SIGNAL — a candidate relabel — never a relabel rate:
 * "yes" legitimately authorises a real purchase or restart. `--stop <code>` restricts
 * the sample to one code so a reviewer can adjudicate. Attribution is turn-level and
 * reads the FIRST orchard-ask of a turn; `multiAskTurns` reports the coverage gap.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deciderOf, HARD_STOPS } from './lib/format-metrics.mjs';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i === -1 ? null : args[i + 1]; };
const since = opt('--since');
const sampleN = Number(opt('--sample') ?? 0);
const stopFilter = opt('--stop');
const json = args.includes('--json');
const store = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
const enc = opt('--dir') ?? path.resolve(import.meta.dirname, '..').replace(/[^A-Za-z0-9]/g, '-');
const dir = path.join(store, enc);

const ASK_RE = /`{3,4}orchard-ask[^\n]*\n([\s\S]*?)\n`{3,4}/g;
const PROSE_Q = /(want me to|shall i|should i|do you want|would you like|your call|ok to|go ahead\?|proceed\?|say the word)/i;
// A plain affirmative ("yes", "go") — authorisation, which a REAL stop also gets.
const AFFIRM = /^\s*(y|yes|yep|yeah|ye|ok|okay|sure|go+|go ahead|do it|proceed|continue|finish)\b/i;
// The call handed BACK to the agent — the stronger "this was never mine" signal.
const DELEGATE = /whatever (u|you)|do what (u|you)|(u|you) rec+om+|stop asking|autonomous|you decide|up to you|your call|pick (the )?best/i;
// "yes, but …" / "ok but not on main" / "yes — but not on main" is a qualified
// answer, neither of the above. r3: any punctuation (comma, em/en dash, hyphen,
// colon, semicolon, ellipsis…) may sit between the first word and the qualifier.
const QUALIFIED = /^\s*\S+?[\s\p{P}]*\s(but|except|only|unless|not)\b|^\s*\S+?[\p{P}]+(but|except|only|unless|not)\b/iu;
// r3: ONE class per reply, so the split never overlaps — qualified excludes both;
// a delegation wins over an affirmative lead ("yes, do what you recommend" is
// delegated, not also affirmative).
function replyClass(reply) {
  const r = String(reply ?? '').slice(0, 300);
  if (!r.trim()) return 'none';
  if (QUALIFIED.test(r)) return 'qualified';
  if (DELEGATE.test(r)) return 'delegated';
  if (AFFIRM.test(r)) return 'affirmative';
  return 'other';
}

const textOf = (c) => (typeof c === 'string' ? c
  : (Array.isArray(c) ? c.filter((p) => p && p.type === 'text').map((p) => p.text ?? '').join('\n') : ''));
function realUser(o) {
  if (o.type !== 'user' || o.isMeta || o.isSidechain) return null;
  const c = o.message?.content;
  if (Array.isArray(c) && c.some((p) => p && p.type === 'tool_result')) return null;
  const t = textOf(c);
  if (!t.trim() || /^(Stop hook feedback|<command-|<local-command|\[Request interrupted|<task-notification|<system-reminder)/.test(t)) return null;
  return t.includes('⟦STATION-BRIEFING-END⟧') ? t.split('⟦STATION-BRIEFING-END⟧').pop() : t;
}

function asksIn(file) {
  const turns = [];
  let cur = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    const u = realUser(o);
    if (u !== null) { cur = { user: u, ts: o.timestamp ?? '', texts: [], auq: 0 }; turns.push(cur); continue; }
    if (!cur) continue;
    if (o.type === 'user' && /^Stop hook feedback/.test(textOf(o.message?.content))) { cur.texts = []; continue; }
    if (o.type === 'assistant' && !o.isSidechain) {
      for (const p of o.message?.content ?? []) {
        if (p?.type === 'text') cur.texts.push(p.text ?? '');
        else if (p?.type === 'tool_use' && p.name === 'AskUserQuestion') cur.auq++;
      }
    }
  }
  const out = [];
  turns.forEach((t, i) => {
    const final = t.texts.at(-1) ?? '';
    const blocks = [...final.matchAll(ASK_RE)].map((m) => m[1]);
    const kind = blocks.length ? 'orchard-ask' : t.auq ? 'AskUserQuestion'
      : (/\?/.test(final.trim().slice(-500)) && PROSE_Q.test(final.trim().slice(-500)) ? 'prose' : null);
    if (!kind) return;
    const d = blocks.length ? deciderOf(blocks[0]) : null;
    const reply = turns[i + 1]?.user ?? '';
    out.push({
      session: path.basename(file, '.jsonl'), ts: t.ts, kind,
      decider: d ? d.lead.slice(0, 40) : null, hardStop: d ? d.hardStop : null, askBlocks: blocks.length,
      ask: (blocks[0] ?? final.slice(-600)).slice(0, 600),
      reply: reply.slice(0, 300), replied: !!reply.trim(),
      replyClass: replyClass(reply),
      replyAffirmative: replyClass(reply) === 'affirmative',
      replyDelegated: replyClass(reply) === 'delegated',
    });
  });
  return out;
}

if (!fs.existsSync(dir)) { console.error(`ask-audit: no transcript dir ${dir}`); process.exit(2); }
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f));
let asks = files.flatMap((f) => { try { return asksIn(f); } catch { return []; } });
if (since) asks = asks.filter((a) => a.ts >= since);
const sessions = new Set(asks.map((a) => a.session));
const count = (pred) => asks.filter(pred).length;
const summary = {
  dir, since: since ?? null, sessions: sessions.size, asks: asks.length,
  byKind: Object.fromEntries(['orchard-ask', 'AskUserQuestion', 'prose'].map((k) => [k, count((a) => a.kind === k)])),
  withDecider: count((a) => a.decider !== null),
  hardStop: count((a) => a.hardStop),
  notHardStop: count((a) => a.decider !== null && !a.hardStop),
  replyDelegated: count((a) => a.replyDelegated),
  replyAffirmative: count((a) => a.replyAffirmative),
  multiAskTurns: count((a) => (a.askBlocks ?? 0) > 1),
  deciders: asks.reduce((m, a) => { if (a.decider !== null) m[a.decider || '(empty)'] = (m[a.decider || '(empty)'] ?? 0) + 1; return m; }, {}),
  // BUG-256 r2 — the relabel REVIEW SIGNAL, per leading hard-stop code (see header).
  byStop: asks.reduce((m, a) => {
    if (!a.hardStop) return m;
    const r = (m[a.hardStop] ??= { asks: 0, replied: 0, affirmative: 0, delegated: 0 });
    r.asks++; if (a.replied) r.replied++; if (a.replyAffirmative) r.affirmative++; if (a.replyDelegated) r.delegated++;
    return m;
  }, {}),
  hardStops: HARD_STOPS,
};
if (json) {
  process.stdout.write(JSON.stringify({ summary, asks }, null, 1) + '\n');
} else {
  console.log(`ask-audit: ${summary.asks} asks in ${summary.sessions} sessions${since ? ` since ${since}` : ''} (${dir})`);
  console.log(`  by kind: ${JSON.stringify(summary.byKind)}`);
  console.log(`  decider named: ${summary.withDecider} — hard stop ${summary.hardStop}, not a hard stop ${summary.notHardStop}`);
  console.log(`  deciders: ${JSON.stringify(summary.deciders)}`);
  console.log(`  next user reply: plain affirmative ${summary.replyAffirmative}, delegated the call back ${summary.replyDelegated}, of ${summary.asks}`);
  console.log(`  by stop (review signal, not a relabel rate): ${Object.entries(summary.byStop).map(([k, r]) => `${k} ${r.delegated} delegated + ${r.affirmative} affirmative / ${r.replied} replied / ${r.asks}`).join('; ') || '(none)'}`);
  if (summary.multiAskTurns) console.log(`  coverage: ${summary.multiAskTurns} turn(s) carried >1 orchard-ask; only the first is attributed`);
  if (sampleN > 0) {
    const pool = stopFilter ? asks.filter((a) => a.hardStop === stopFilter || a.decider === stopFilter) : [...asks];
    for (let i = 0; i < Math.min(sampleN, pool.length); i++) {
      const j = i + Math.floor(Math.random() * (pool.length - i));
      [pool[i], pool[j]] = [pool[j], pool[i]];
      const a = pool[i];
      console.log(`\n#${i + 1} ${a.ts.slice(0, 10)} ${a.session.slice(0, 8)} [${a.kind}] decider=${a.decider ?? '-'}\nASK: ${a.ask.replace(/\n/g, ' / ')}\nREPLY: ${a.reply.replace(/\n/g, ' ')}`);
    }
  }
}
