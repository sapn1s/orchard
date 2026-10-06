/**
 * scorers.mjs — mechanical, deterministic PASS/FAIL scorers for the FEAT-162
 * text-replayable prompt-competition eval set (track A).
 *
 * Each scorer takes (params, key, reply) where `reply` is the model's raw text,
 * and returns { pass: boolean, observed: <values the scorer actually read> }.
 * NOTHING here calls a model or an LLM judge — every check is a regex / numeric
 * / parser comparison against a frozen answer key. The `observed` field is what
 * the non-vacuity proof prints, so a human can see the real values graded.
 *
 * Output-contract convention: cases instruct the model to end its reply with
 * one or more keyed lines (e.g. `DECISION: GO-LIVE-SMALL`). The scorers read
 * those keyed lines case-insensitively and tolerate surrounding markdown
 * (**bold**, backticks, trailing punctuation).
 */
import { ticketDecision } from '../../src/server/board.ts';

/** Last keyed line `KEY: value` (case-insensitive), markdown stripped. */
export function keyedValue(reply, keyName) {
  const re = new RegExp(`^[\\s>*_\`-]*${keyName}\\s*[:=]\\s*(.+?)\\s*$`, 'im');
  // take the LAST occurrence (models sometimes restate the contract first)
  let m, last = null;
  const g = new RegExp(re.source, 'gim');
  while ((m = g.exec(reply)) !== null) last = m[1];
  if (last == null) return null;
  return last.replace(/[*_`]/g, '').replace(/[.。]+$/, '').trim();
}

/** Parse a money/quantity token into a number of base units. Handles k / m / million / bn and commas. */
export function parseQuantity(s) {
  if (s == null) return null;
  const txt = String(s).toLowerCase();
  // find first number with optional magnitude suffix / word
  const re = /(-?\d[\d,]*(?:\.\d+)?)\s*(k|thousand|m|mm|million|millions|bn|billion)?/i;
  const m = txt.match(re);
  if (!m) return null;
  let n = parseFloat(m[1].replace(/,/g, ''));
  if (Number.isNaN(n)) return null;
  const suf = (m[2] || '').toLowerCase();
  if (suf === 'k' || suf === 'thousand') n *= 1e3;
  else if (suf === 'm' || suf === 'mm' || suf.startsWith('million')) n *= 1e6;
  else if (suf === 'bn' || suf.startsWith('billion')) n *= 1e9;
  return n;
}

const QUALITATIVE = /\b(millions?|very\s+liquid|a\s+lot|lots|huge|unlimited|unbounded|plenty|depends|essentially\s+unlimited|effectively\s+unlimited|not\s+a\s+constraint|n\/a)\b/i;
const VAGUE_QUANT = /\b(a\s+few|some|several|handful|low|modest|small|many)\b/i;

function within(value, target, tolFrac, loOverride, hiOverride) {
  const lo = loOverride != null ? loOverride : target * (1 - tolFrac);
  const hi = hiOverride != null ? hiOverride : target * (1 + tolFrac);
  return value >= lo && value <= hi;
}

export const SCORERS = {
  /** TV-S1: every named capacity row must carry a numeric bound within tolerance of its key. */
  numeric_capacity_cells(params, key, reply) {
    const observed = {};
    let pass = true;
    for (const row of key.rows) {
      // find the keyed line, then read ONLY the value after the label (so digits
      // inside the label like 'vol3' are never parsed as the capacity).
      const line = reply.split('\n').find((l) => l.toLowerCase().includes(row.match.toLowerCase()));
      if (!line) { observed[row.id] = '<row missing>'; pass = false; continue; }
      const idx = line.toLowerCase().indexOf(row.match.toLowerCase()) + row.match.length;
      const rest = line.slice(idx).replace(/^[\s:=|]+/, '');
      const qty = parseQuantity(rest);
      const qualitative = QUALITATIVE.test(rest) && !/\d/.test(rest);
      if (qualitative || qty == null) { observed[row.id] = qualitative ? '<qualitative>' : '<no number>'; pass = false; continue; }
      const ok = within(qty, row.target, params.tol ?? 0.3, row.lo, row.hi);
      observed[row.id] = { value: qty, target: row.target, ok };
      if (!ok) pass = false;
    }
    return { pass, observed };
  },

  /** TV-S2: a single computed numeric figure within tolerance; vague-only = FAIL. */
  computed_numeric(params, key, reply) {
    const field = params.field ? keyedValue(reply, params.field) : reply;
    const src = field != null ? field : reply;
    const qty = parseQuantity(src);
    const vagueOnly = qty == null && VAGUE_QUANT.test(src);
    if (qty == null) return { pass: false, observed: { value: null, vague: vagueOnly } };
    const ok = within(qty, key.target, params.tol ?? 0.3, key.lo, key.hi);
    return { pass: ok, observed: { value: qty, target: key.target, ok } };
  },

  /** TV-S3: keyed decision token matches, AND review date is within horizon. */
  keyed_decision_and_date(params, key, reply) {
    const dec = (keyedValue(reply, params.decisionField) || '').toUpperCase().replace(/\s+/g, '-');
    const rev = keyedValue(reply, params.dateField) || '';
    const dm = rev.match(/(\d{4})-(\d{2})-(\d{2})/);
    const decOk = dec === key.decision;
    let dateOk = false, days = null;
    if (dm) {
      const d = Date.parse(`${dm[1]}-${dm[2]}-${dm[3]}T00:00:00Z`);
      const base = Date.parse(`${key.today}T00:00:00Z`);
      days = Math.round((d - base) / 86400000);
      dateOk = days >= 0 && days <= key.maxDays;
    }
    return { pass: decOk && dateOk, observed: { decision: dec, decisionOk: decOk, review: rev, days, dateOk } };
  },

  /** TV-S4 / OR-S1: keyed id must be in the eligible/qualifying set; optional required pairing. */
  id_from_menu(params, key, reply) {
    const id = (keyedValue(reply, params.idField) || '').toUpperCase();
    let pass = key.eligible.map((x) => x.toUpperCase()).includes(id);
    const observed = { id, eligible: key.eligible };
    if (pass && params.pairField && key.pairing) {
      const pair = (keyedValue(reply, params.pairField) || '').toUpperCase();
      const want = (key.pairing[id] || '').toUpperCase();
      observed.pair = pair; observed.pairWant = want;
      pass = pair === want;
    }
    return { pass, observed };
  },

  /** TV-C2: two boolean flags must match key (YES/NO). */
  flags(params, key, reply) {
    const observed = {}; let pass = true;
    for (const f of params.fields) {
      const v = (keyedValue(reply, f.name) || '').toUpperCase();
      const yes = /^Y(ES)?\b/.test(v) || v === 'TRUE';
      const no = /^N(O)?\b/.test(v) || v === 'FALSE';
      const val = yes ? 'YES' : no ? 'NO' : '<none>';
      observed[f.name] = val;
      if (val !== key[f.name]) pass = false;
    }
    return { pass, observed };
  },

  /** TV-PC1: a proposed position size must be positive AND keep the floor under worst-case dd. */
  floor_sizing(params, key, reply) {
    const s = parseQuantity(keyedValue(reply, params.sizeField));
    if (s == null) return { pass: false, observed: { size: null } };
    const worst = key.equity - key.dd * s;
    const pass = s > 0 && worst >= key.floor;
    return { pass, observed: { size: s, worstCaseEquity: Math.round(worst), floor: key.floor, positive: s > 0 } };
  },

  /** BD-M2: the set of cited line-ids must equal the key set (or NONE).
   *  The field MUST be present — an absent field is non-compliant and FAILS
   *  (a reply that never answers must not pass as the empty set). */
  line_id_set(params, key, reply) {
    const raw = keyedValue(reply, params.field);
    if (raw == null) return { pass: false, observed: { got: '<field absent>', want: key.lines || [] } };
    let got;
    if (/^none$/i.test(raw.trim()) || raw.trim() === '') got = [];
    else got = [...raw.matchAll(/\d+/g)].map((m) => Number(m[0]));
    const want = key.lines || [];
    const setEq = got.length === want.length && got.every((x) => want.includes(x)) && want.every((x) => got.includes(x));
    return { pass: setEq, observed: { got, want } };
  },

  /** BD-D1: ticketDecision() must parse the reply into all required option keys with prescribed content. */
  decide_card(params, key, reply) {
    let dec = null;
    try { dec = ticketDecision(reply); } catch (e) { return { pass: false, observed: { error: String(e) } }; }
    if (!dec || !Array.isArray(dec.options)) return { pass: false, observed: { parsed: null } };
    const keys = dec.options.map((o) => (o.key || '').toUpperCase());
    const missing = key.requiredKeys.filter((k) => !keys.includes(k.toUpperCase()));
    let contentOk = true; const contentMiss = [];
    for (const [k, sub] of Object.entries(key.content || {})) {
      const opt = dec.options.find((o) => (o.key || '').toUpperCase() === k.toUpperCase());
      const hay = ((opt?.label || '') + ' ' + (opt?.description || '')).toLowerCase();
      if (!opt || !hay.includes(sub.toLowerCase())) { contentOk = false; contentMiss.push(k); }
    }
    const pass = missing.length === 0 && contentOk;
    return { pass, observed: { keys, missing, contentMiss } };
  },

  /** forbidden_chars: the keyed field (or whole reply) must contain none of the banned
   *  chars, be at least minLen long, and include every required substring. */
  forbidden_chars(params, key, reply) {
    const raw = params.field ? keyedValue(reply, params.field) : reply;
    if (raw == null) return { pass: false, observed: { bannedFound: '<field absent>' } };
    const field = raw;
    const banned = (key.banned || []).filter((ch) => field.includes(ch));
    const len = field.replace(/\s+/g, ' ').trim().length;
    const missing = (key.requireSubstr || []).filter((s) => !field.toLowerCase().includes(s.toLowerCase()));
    // anti-degenerate: reject low-diversity filler (e.g. "ts ts ts ts ts") that
    // technically honours the char constraint without being a real answer.
    const toks = field.toLowerCase().split(/\s+/).filter(Boolean);
    const distinct = new Set(toks).size;
    const ratio = toks.length ? distinct / toks.length : 0;
    const diverse = ratio >= (key.minDistinctRatio || 0);
    const pass = banned.length === 0 && len >= (key.minLen || 0) && missing.length === 0 && diverse;
    return { pass, observed: { bannedFound: banned, len, missingRequired: missing, distinctRatio: Number(ratio.toFixed(2)) } };
  },

  /** keyed_equals: each named field's value must equal its expected token (case-insensitive). */
  keyed_equals(params, key, reply) {
    const observed = {}; let pass = true;
    for (const f of params.fields) {
      const v = (keyedValue(reply, f) || '').toUpperCase().replace(/\s+/g, '-');
      const want = String(key[f]).toUpperCase().replace(/\s+/g, '-');
      observed[f] = v;
      if (v !== want) pass = false;
    }
    return { pass, observed };
  },

  /** OR-A2: single classification token must match key. */
  classification(params, key, reply) {
    const v = (keyedValue(reply, params.field) || '').toUpperCase();
    return { pass: v === key.expect, observed: { value: v, expect: key.expect } };
  },
};

export function scoreCase(c, reply) {
  const fn = SCORERS[c.scorer.type];
  if (!fn) throw new Error(`unknown scorer ${c.scorer.type} for ${c.id}`);
  const r = fn(c.scorer.params || {}, c.scorer.key || {}, reply);
  return { id: c.id, pass: r.pass, observed: r.observed, positiveControl: !!c.is_positive_control };
}
