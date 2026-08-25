/**
 * DOM + formatting helpers. No framework, no build step.
 * Everything that touches model- or file-provided text goes through here so
 * that untrusted text can never reach innerHTML.
 */
import { fenceSegments } from './response-blocks.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** el('span', {class:'x', text:'hi'}, ...children) */
export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') n.textContent = String(v);
    else if (k === 'html') n.innerHTML = v; // only ever called with literal markup
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.append(kid);
  }
  return n;
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

/** Inline SVG from a literal path string. Safe: never fed user text. */
export function svg(paths, size = 12, extra = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  s.setAttribute('width', size);
  s.setAttribute('height', size);
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.3');
  s.setAttribute('stroke-linecap', 'round');
  if (extra) s.setAttribute('class', extra);
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', paths);
  s.append(p);
  return s;
}

/* ------------------------------------------------------------- formatting */

export function mmss(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 900 -> "900" ; 38417 -> "38.4k" ; 11325700 -> "11.3M" */
export function kilo(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 999_500) return `${(n / 1000).toFixed(1)}k`;
  if (n < 999_500_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

/**
 * Byte sizes for the mono slot. A reflink snapshot is legitimately ~0 bytes
 * until files diverge, so 0 renders as "0 B" and never as an empty cell that
 * would read as "unknown".
 */
export function bytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${Math.round(n)} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

/** Absolute, unambiguous timestamp — used where the user must read what they are overwriting. */
export function stamp(iso) {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return 'an unknown time';
  return new Date(t).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

/** Sidebar timestamps: "now", "12m", "2h", "3d", then "Jul 24". */
export function when(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = Date.now() - t;
  if (d < 60_000) return 'now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`;
  if (d < 7 * 86_400_000) return `${Math.floor(d / 86_400_000)}d`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function shortPath(p) {
  if (!p) return '';
  const m = /^(\/home\/[^/]+|\/Users\/[^/]+|[A-Z]:[\\/]Users[\\/][^\\/]+)(?=\/)/.exec(p);
  return m ? `~${p.slice(m[1].length)}` : p;
}

/** One-line summary of a tool call's input, in the mockup's `.arg` slot. */
export function toolArg(name, input) {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return input;
  const o = input;
  const pick = (...keys) => {
    for (const k of keys) if (typeof o[k] === 'string' && o[k]) return o[k];
    return null;
  };
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return shortPath(pick('file_path', 'path', 'notebook_path') ?? '');
    case 'Bash':
      return pick('command') ?? '';
    case 'Grep':
      return [pick('pattern'), pick('path') ? `— ${shortPath(o.path)}` : ''].filter(Boolean).join(' ');
    case 'Glob':
      return pick('pattern') ?? '';
    case 'Task':
      return pick('description') ?? '';
    case 'WebFetch':
    case 'WebSearch':
      return pick('url', 'query') ?? '';
    default: {
      const s = pick('description', 'command', 'pattern', 'file_path', 'path', 'query', 'prompt');
      if (s) return s;
      try {
        return JSON.stringify(o);
      } catch {
        return '';
      }
    }
  }
}

/* ---------------------------------------------------------------- prose */

const INLINE = /(`[^`\n]+`)|(\[[^\]\n]+\]\([^)\n]+\))|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)/g;

/**
 * Decide how a link href may be used, or refuse it.
 *
 * This renderer displays UNTRUSTED model/file text, so a link is only ever a
 * navigable `<a>` when its target is provably inert:
 *   - a `#…` hash target       -> an in-app route (the whole app is hash-routed,
 *                                 so the browser navigates it with no network);
 *   - an http(s):// URL         -> external, opened in a new tab with
 *                                 rel="noopener noreferrer";
 *   - a scheme-less relative    -> same-origin, treated as in-app.
 * Anything carrying a non-http(s) scheme (javascript:, data:, vbscript:, file:,
 * mailto:, …) is REFUSED — the caller renders the raw `[text](url)` as inert
 * text instead, so nothing is hidden and no live element is injected.
 *
 * @returns {null | { href: string, external: boolean }}
 */
export function safeHref(raw) {
  const href = String(raw ?? '').trim();
  if (!href) return null;
  if (href.startsWith('#')) return { href, external: false };
  // A scheme is only real when its ':' precedes any '/', '?' or '#'.
  const colon = href.indexOf(':');
  if (colon !== -1) {
    const bound = href.search(/[/?#]/);
    if ((bound === -1 || colon < bound) && /^[a-zA-Z][a-zA-Z0-9+.-]*$/.test(href.slice(0, colon))) {
      const scheme = href.slice(0, colon).toLowerCase();
      if (scheme === 'http' || scheme === 'https') return { href, external: true };
      return null; // any other scheme is refused
    }
  }
  // No scheme -> a relative / root-relative same-origin target.
  return { href, external: false };
}

/** A `[text](url)` token -> an `<a>` (text inserted as TEXT), or inert text if the href is refused. */
function linkNode(tok) {
  const mm = /^\[([^\]\n]+)\]\(([^)\n]+)\)$/.exec(tok);
  if (!mm) return document.createTextNode(tok);
  const [, text, url] = mm;
  const safe = safeHref(url);
  if (!safe) return document.createTextNode(tok); // refused scheme -> raw markdown, inert
  const attrs = { class: 'md-link', text, href: safe.href };
  if (safe.external) { attrs.target = '_blank'; attrs.rel = 'noopener noreferrer'; }
  return el('a', attrs);
}

export function inlineInto(node, text) {
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) node.append(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('`')) node.append(el('code', { text: tok.slice(1, -1) }));
    else if (tok.startsWith('[')) node.append(linkNode(tok));
    else if (tok.startsWith('**')) node.append(el('strong', { text: tok.slice(2, -2) }));
    else if (tok.startsWith('*')) node.append(el('em', { text: tok.slice(1, -1) }));
    else node.append(el('em', { text: tok.slice(1, -1) }));
    last = m.index + tok.length;
  }
  if (last < text.length) node.append(text.slice(last));
  return node;
}

/* ----------------------------------------------------------- GFM tables */

/** Split one table row into trimmed cells, honouring `\|` as an escaped pipe. */
function tableCells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i += 1; continue; }
    if (s[i] === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

/** A separator cell -> its alignment, or null. Also the validity test for the row. */
function cellAlign(cell) {
  const c = cell.trim();
  if (!/^:?-+:?$/.test(c)) return undefined; // not a valid separator cell
  const l = c.startsWith(':');
  const r = c.endsWith(':');
  if (l && r) return 'center';
  if (r) return 'right';
  if (l) return 'left';
  return null; // valid, no explicit alignment
}

/**
 * If a block is a GFM pipe table (a header row, then a `|---|` separator row),
 * build a real <table>; otherwise return null so the caller renders it as text.
 * Deliberately strict on the SEPARATOR only — a missing/garbled separator means
 * "not a table", so a partial/malformed table degrades to plain text and its
 * content is never swallowed.
 */
function tryTable(lines) {
  if (lines.length < 2 || !lines[0].includes('|')) return null;
  const sep = tableCells(lines[1]);
  if (!sep.length) return null;
  const aligns = sep.map(cellAlign);
  if (aligns.some((a) => a === undefined)) return null; // a non-separator cell -> not a table

  const header = tableCells(lines[0]);
  const bodyLines = lines.slice(2);
  const bodyRows = bodyLines.map(tableCells);
  // Size the table to the WIDEST row, not just the header. GFM would discard a
  // body cell past the header's column count, but this renderer's guarantee is
  // absolute — no reader-visible content is ever lost — and an over-wide body
  // row is exactly the shape a model emits when a summary cell itself contains a
  // pipe. So the surplus cell must land in a real <td>: we widen every row to
  // the widest row, pad the header with empty <th> for the unlabelled overflow
  // column, and pad short body rows with empty <td> (a body row with FEWER cells
  // than the header was already safe — its missing cells render empty, losing
  // nothing). Degradation only ever moves content toward visible.
  const cols = Math.max(header.length, ...bodyRows.map((c) => c.length));
  const table = el('table', { class: 'md-table' });
  const htr = el('tr');
  for (let i = 0; i < cols; i += 1) {
    const th = el('th');
    if (aligns[i]) th.style.textAlign = aligns[i];
    inlineInto(th, header[i] ?? '');
    htr.append(th);
  }
  table.append(el('thead', {}, htr));

  if (bodyRows.length) {
    const tbody = el('tbody');
    for (const cells of bodyRows) {
      const tr = el('tr');
      for (let i = 0; i < cols; i += 1) {
        const td = el('td');
        if (aligns[i]) td.style.textAlign = aligns[i];
        inlineInto(td, cells[i] ?? '');
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(tbody);
  }
  return el('div', { class: 'md-table-wrap' }, table);
}

const BULLET = /^\s*([-*+]|\d+\.)\s+/;

/**
 * Minimal, deliberately conservative markdown: headings, paragraphs, fenced
 * code, bullet/numbered lists, inline code/emphasis, GFM pipe tables, and
 * `[text](url)` links (FEAT-081). Everything is built with DOM nodes and all
 * link text / table cells are inserted as TEXT, so no model- or file-provided
 * output can inject markup, and a refused link scheme (javascript:, data:, …)
 * renders as inert text rather than a live element.
 *
 * Two things were added when plan cards started using this renderer, because a
 * plan is the one output a user has to READ carefully before approving:
 *
 *  - ATX headings. `## What I'll change` used to render as a literal paragraph
 *    with the hashes still in it.
 *  - Wrapped list items. The old test required EVERY line in the block to start
 *    with a marker, so a numbered list whose items ran onto a second line was
 *    not a list at all and collapsed into one run-on paragraph.
 */
export function prose(text, cls = 'prose') {
  const wrap = el('div', { class: cls });
  // Normalise ALL three CommonMark line endings to LF up front — CRLF *and* a
  // lone CR — BEFORE any line-shaped rule runs. Every rule below assumes a line
  // break is `\n`: the fence split, the info-string strip (`^[^\n]*\n`), the
  // paragraph split (`\n{2,}`) and `b.split('\n')`. A lone CR left in the text
  // is invisible to all of them, so a `\r` right after a fence run made the
  // info-string strip eat the entire following region (BUG-109). Doing it here,
  // rather than at each caller, means no caller can forget it and no downstream
  // rule can be blind to a line break. (Matches digest.js's boundary normalise;
  // `\r\n?` collapses CRLF and lone CR without touching an existing LF.)
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  // THE FENCE SPLIT IS NOT OURS TO MODEL (BUG-111). This used to be
  // `src.split(/```/)` with an info-string strip — a character-run splitter that
  // called every other chunk code. It had no notion of a line, so it could not
  // see a `~~~` opener at all (a tilde block's `#` became a real heading and its
  // `|` row a real table) and could not strip an enclosing `>` or list indent out
  // of the `<pre>`. Those rules — both fence characters, a closer at least as
  // long as its opener, info strings, 0-3 columns of indent, container
  // continuation — already exist, implemented once and differential-tested, in
  // response-blocks.js. So the renderer now READS that scan's verdict. Two
  // implementations of one grammar is the defect, not the fix; there is no second
  // fence model here to drift from it.
  for (const seg of fenceSegments(src)) {
    if (seg.type === 'code') {
      wrap.append(el('div', { class: 'out' }, el('pre', { text: seg.text })));
      continue;
    }
    for (const block of seg.text.split(/\n{2,}/)) {
      const b = block.trim();
      if (!b) continue;
      const lines = b.split('\n');

      const h = /^(#{1,6})\s+(.*)$/.exec(lines[0]);
      if (h) {
        // h1/h2 in model prose are section headings inside a message, so they
        // start at h3 to stay under the page's real heading structure.
        wrap.append(inlineInto(el(`h${Math.min(6, h[1].length + 2)}`, { class: 'ph' }), h[2]));
        const rest = lines.slice(1).join('\n').trim();
        if (rest) wrap.append(...prose(rest, cls).childNodes);
        continue;
      }

      const table = tryTable(lines);
      if (table) { wrap.append(table); continue; }

      if (BULLET.test(lines[0])) {
        /* Fold continuation lines into the item they belong to, so a wrapped
           bullet stays one bullet instead of breaking the whole list. */
        const items = [];
        for (const l of lines) {
          if (BULLET.test(l)) items.push(l.replace(BULLET, ''));
          else if (items.length) items[items.length - 1] += ` ${l.trim()}`;
          else items.push(l.trim());
        }
        const list = el(/^\s*\d/.test(lines[0]) ? 'ol' : 'ul');
        for (const it of items) list.append(inlineInto(el('li'), it));
        wrap.append(list);
        continue;
      }
      wrap.append(inlineInto(el('p'), lines.join(' ')));
    }
  }
  if (!wrap.childElementCount) wrap.append(el('p', { text: '' }));
  return wrap;
}
