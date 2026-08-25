/**
 * FEAT-083 — INDEPENDENT ADVERSARIAL data-loss / XSS verification.
 *
 *   npm run verify:feat-083-adversarial
 *
 * This suite was written by a DIFFERENT agent than the builder, WITHOUT reading
 * the builder's verify script, with an explicitly hostile goal: BREAK the
 * "content is never swallowed" contract of public/lib/digest.js, not confirm it.
 *
 * It imports digest.js directly and drives renderAssistantText / renderDigest /
 * parseDigest under happy-dom (no real browser, no server). For every hostile
 * input it asserts that the message CONTENT survives into the rendered
 * textContent, and that model/user text can never inject live markup (XSS).
 *
 * Why marker tokens instead of byte-for-byte equality:
 *   The fallback path is prose(text), which is a real (conservative) markdown
 *   renderer — it legitimately strips `**`/`*`/`` ` `` markers and the info line
 *   of a code fence. So "every byte survives" is false for legit markdown and
 *   would be a bogus assertion. The CONTRACT that matters is that no MESSAGE
 *   CONTENT is lost or hidden. We therefore embed distinctive, transform-proof
 *   marker tokens (ZZ...ZZ, plain letters/digits, no markdown metachars) inside
 *   the JSON payload AND the prose, then assert those markers land in
 *   textContent. A swallowed block would drop its marker.
 *
 * No emojis, OS-agnostic, no network, no ports.
 */
import { Window } from 'happy-dom';

/* happy-dom globals BEFORE importing digest.js's DOM helpers touch document. */
const win = new Window({ url: 'https://local.test/' });
globalThis.window = win;
globalThis.document = win.document;

const { parseDigest, renderDigest, renderAssistantText } = await import(
  new URL('../public/lib/digest.js', import.meta.url).href
);

/* --------------------------------------------------------------- harness */
let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Render an assistant message and hand back the node + its textContent. */
function render(text, opts) {
  const node = renderAssistantText(text, opts);
  return { node, txt: node.textContent ?? '' };
}

/** Assert a marker survives into the visible text. */
function survives(name, text, marker, opts) {
  const { txt } = render(text, opts);
  check(name, txt.includes(marker), `marker ${JSON.stringify(marker)} LOST from output`);
}

/** Assert NO live element of `tag` was injected (XSS guard). */
function noLiveTag(name, node, tag) {
  const found = node.querySelector(tag);
  check(name, found === null, `a live <${tag}> element was injected`);
}

const fence = (json) => '```orchard-digest\n' + json + '\n```';

console.log('FEAT-083 adversarial — hammering parseDigest for content loss / XSS\n');

/* =====================================================================
 * GROUP A — malformed JSON: every one must fall back to full prose.
 * The JSON payload text (its marker) MUST survive as a code block.
 * ===================================================================== */
{
  const cases = {
    'truncated JSON': '{"items":[{"text":"ZZAZZ"',
    'trailing comma': '{"items":[{"text":"ZZAZZ"},]}',
    'unclosed brace': '{"items":[{"text":"ZZAZZ"}]',
    'single quotes (invalid JSON)': "{'items':[{'text':'ZZAZZ'}]}",
    'bare word': 'ZZAZZ-not-json',
    'root is array': '["ZZAZZ"]',
    'root is number': '42 ZZAZZ',
    'root is string': '"ZZAZZ just a string"',
    'root is null literal': 'null /*ZZAZZ*/',
    'root is bool': 'true ZZAZZ',
    'items not an array (object)': '{"items":{"text":"ZZAZZ"}}',
    'items not an array (string)': '{"items":"ZZAZZ"}',
    'items is number': '{"items":123, "note":"ZZAZZ"}',
    'no items key': '{"foo":"ZZAZZ"}',
    'items empty array': '{"items":[]}\n\nZZAZZ prose below',
    'items: all null': '{"items":[null,null], "x":"ZZAZZ"}',
    'items: non-object entries': '{"items":["ZZAZZ", 5, true]}',
    'items: empty text': '{"items":[{"text":""}], "x":"ZZAZZ"}',
    'items: whitespace text': '{"items":[{"text":"   \\t  "}], "x":"ZZAZZ"}',
    'items: non-string text': '{"items":[{"text":123}], "x":"ZZAZZ"}',
    'items: null text': '{"items":[{"text":null}], "x":"ZZAZZ"}',
  };
  for (const [label, json] of Object.entries(cases)) {
    const text = fence(json) + '\n\nZZPROSEZZ tail line.';
    // parseDigest MUST reject (null) so the caller renders full prose.
    check(`A/parse-null: ${label}`, parseDigest(text) === null, 'parseDigest returned non-null for malformed input');
    // The JSON payload marker survives (as a rendered code block).
    survives(`A/json-survives: ${label}`, text, 'ZZAZZ');
    // The prose below survives too.
    survives(`A/prose-survives: ${label}`, text, 'ZZPROSEZZ');
    // And no live <digest> structure was built.
    const { node } = render(text);
    check(`A/no-digest: ${label}`, node.querySelector('.digest') === null, 'a .digest was built from malformed input');
  }
}

/* =====================================================================
 * GROUP B — fence placement / framing hostility.
 * ===================================================================== */
{
  // Fence NOT at the start: real prose precedes it -> not a leading digest.
  const b1 = 'ZZLEADZZ real words first.\n\n' + fence('{"items":[{"text":"ZZBODYZZ"}]}') + '\n\nZZTAILZZ';
  check('B/preceded-by-prose: parse-null', parseDigest(b1) === null, 'matched a non-leading fence');
  survives('B/preceded-by-prose: lead survives', b1, 'ZZLEADZZ');
  survives('B/preceded-by-prose: json survives', b1, 'ZZBODYZZ');
  survives('B/preceded-by-prose: tail survives', b1, 'ZZTAILZZ');

  // Trailing garbage on the info line -> not a valid orchard-digest fence.
  const b2 = '```orchard-digest EXTRA-ZZINFOZZ\n{"items":[{"text":"ZZBODYZZ"}]}\n```\n\nZZTAILZZ';
  check('B/info-trailing: parse-null', parseDigest(b2) === null, 'matched fence with trailing info chars');
  survives('B/info-trailing: json survives', b2, 'ZZBODYZZ');
  survives('B/info-trailing: tail survives', b2, 'ZZTAILZZ');

  // Fence never closed -> no match -> whole thing prose.
  const b3 = '```orchard-digest\n{"items":[{"text":"ZZBODYZZ"}]}\n\nZZTAILZZ never closed';
  check('B/never-closed: parse-null', parseDigest(b3) === null, 'matched an unclosed fence');
  survives('B/never-closed: json survives', b3, 'ZZBODYZZ');
  survives('B/never-closed: tail survives', b3, 'ZZTAILZZ');

  // Closing backticks with trailing non-space chars are NOT a close.
  const b4 = '```orchard-digest\n{"items":[{"text":"ZZBODYZZ"}]}\n```garbage\n\nZZTAILZZ';
  check('B/bad-close-line: parse-null', parseDigest(b4) === null, 'matched fence closed by ```garbage');
  survives('B/bad-close-line: json survives', b4, 'ZZBODYZZ');
  survives('B/bad-close-line: tail survives', b4, 'ZZTAILZZ');

  // Multiple orchard-digest blocks: the leading valid one is lifted; the SECOND
  // block must still survive as prose below (its content is not swallowed).
  const b5 =
    fence('{"items":[{"text":"ZZFIRSTZZ"}]}') +
    '\n\nmiddle words\n\n' +
    fence('{"items":[{"text":"ZZSECONDZZ"}]}') +
    '\n\nZZTAILZZ';
  const p5 = parseDigest(b5);
  check('B/multi-block: first is valid', p5 && p5.items.length === 1 && p5.items[0].text === 'ZZFIRSTZZ',
    'leading block did not parse to the first item');
  const r5 = render(b5);
  check('B/multi-block: digest built', r5.node.querySelector('.digest') !== null, 'no .digest for leading block');
  survives('B/multi-block: first item shown', b5, 'ZZFIRSTZZ');
  survives('B/multi-block: second block survives in prose', b5, 'ZZSECONDZZ');
  survives('B/multi-block: tail survives', b5, 'ZZTAILZZ');

  // Adjacent fences (a plain ``` code block immediately after the digest).
  const b6 = fence('{"items":[{"text":"ZZFIRSTZZ"}]}') + '\n\n```\nZZCODEZZ raw\n```';
  survives('B/adjacent-fence: item shown', b6, 'ZZFIRSTZZ');
  survives('B/adjacent-fence: code survives', b6, 'ZZCODEZZ');

  // Leading whitespace / blank lines before the fence are allowed (no content).
  const b7 = '\n\n   ' + fence('{"items":[{"text":"ZZONLYZZ"}]}');
  check('B/leading-ws: parses', parseDigest(b7) !== null, 'leading whitespace defeated the fence');
  survives('B/leading-ws: item shown', b7, 'ZZONLYZZ');

  // 4+ backtick fences.
  const b8 = '````orchard-digest\n{"items":[{"text":"ZZFOURZZ"}]}\n````\n\nZZTAILZZ';
  check('B/four-ticks: parses', parseDigest(b8) !== null, 'four-backtick fence not accepted');
  survives('B/four-ticks: item shown', b8, 'ZZFOURZZ');
  survives('B/four-ticks: tail survives', b8, 'ZZTAILZZ');
}

/* =====================================================================
 * GROUP C — XSS / injection: hostile text must be TEXT, never live markup.
 * ===================================================================== */
{
  const XSS = '<script>ZZSCRIPTZZ()</script><img src=x onerror="ZZIMGZZ()">';

  // In prose (fallback path, malformed digest).
  const c1 = fence('{ broken ' + '<b>ZZJSONHTMLZZ</b>') + '\n\n' + XSS + ' ZZPROSEZZ';
  const r1 = render(c1);
  check('C/prose-xss: parse-null', parseDigest(c1) === null);
  check('C/prose-xss: script text present', r1.txt.includes('ZZSCRIPTZZ'), 'script text lost');
  check('C/prose-xss: img text present', r1.txt.includes('ZZIMGZZ'), 'img text lost');
  survives('C/prose-xss: prose marker survives', c1, 'ZZPROSEZZ');
  noLiveTag('C/prose-xss: no live <script>', r1.node, 'script');
  noLiveTag('C/prose-xss: no live <img>', r1.node, 'img');
  noLiveTag('C/prose-xss: no live <b> from json', r1.node, 'b');

  // In a WELL-FORMED item text (structured render path via renderDigest).
  const c2 = fence(JSON.stringify({
    items: [{ text: XSS + ' ZZITEMZZ', kind: 'decision', ref: '<i>ZZREFZZ</i>' }],
  })) + '\n\n' + XSS + ' ZZPROSEZZ';
  const r2 = render(c2);
  check('C/item-xss: digest built', r2.node.querySelector('.digest') !== null, 'no digest for well-formed hostile item');
  check('C/item-xss: item text present as text', r2.txt.includes('ZZITEMZZ'), 'item text lost');
  check('C/item-xss: script text present', r2.txt.includes('ZZSCRIPTZZ'), 'script text lost from item');
  noLiveTag('C/item-xss: no live <script>', r2.node, 'script');
  noLiveTag('C/item-xss: no live <img>', r2.node, 'img');
  noLiveTag('C/item-xss: no live <i> from ref', r2.node, 'i');
  survives('C/item-xss: prose marker survives', c2, 'ZZPROSEZZ');

  // renderDigest directly with hostile items.
  const dnode = renderDigest(
    [{ text: XSS + ' ZZDIRECTZZ', kind: 'fyi', importance: 'high', ref: '<script>ZZR2ZZ</script>' }],
    {},
  );
  check('C/renderDigest: text present', (dnode.textContent ?? '').includes('ZZDIRECTZZ'), 'direct item text lost');
  noLiveTag('C/renderDigest: no live <script>', dnode, 'script');
}

/* =====================================================================
 * GROUP D — unicode / RTL / emoji / huge input.
 * ===================================================================== */
{
  const uni = 'café — 日本語 — مرحبا (RTL) — 🌳🚀 — ZZUNIZZ';

  // Malformed digest with unicode prose.
  const d1 = fence('{bad ' + uni + '}') + '\n\n' + uni;
  check('D/unicode: parse-null', parseDigest(d1) === null);
  survives('D/unicode: prose survives', d1, 'ZZUNIZZ');
  survives('D/unicode: emoji survives', d1, '🌳🚀');
  survives('D/unicode: RTL survives', d1, 'مرحبا');

  // Well-formed digest with unicode item + unicode prose below.
  const d2 = fence(JSON.stringify({ items: [{ text: uni, kind: 'done' }] })) + '\n\ntail ' + uni;
  const r2 = render(d2);
  check('D/unicode-item: digest built', r2.node.querySelector('.digest') !== null);
  survives('D/unicode-item: item text survives', d2, 'ZZUNIZZ');
  survives('D/unicode-item: emoji survives', d2, '🚀');

  // HUGE input: ~1MB of prose below a well-formed digest.
  const bigMid = 'lorem ipsum dolor sit amet '.repeat(40000); // ~1.08 MB
  const d3 = fence(JSON.stringify({ items: [{ text: 'ZZBIGITEMZZ', kind: 'decision' }] })) +
    '\n\nZZBIGHEADZZ ' + bigMid + ' ZZBIGTAILZZ';
  const t0 = Date.now();
  const r3 = render(d3);
  const dt = Date.now() - t0;
  check('D/huge: digest built', r3.node.querySelector('.digest') !== null);
  survives('D/huge: item survives', d3, 'ZZBIGITEMZZ');
  survives('D/huge: prose head survives', d3, 'ZZBIGHEADZZ');
  survives('D/huge: prose tail survives', d3, 'ZZBIGTAILZZ');
  check('D/huge: completes < 5s', dt < 5000, `render took ${dt}ms`);
}

/* =====================================================================
 * GROUP E — "only a malformed block, no prose" and digest-only messages.
 * ===================================================================== */
{
  // ONLY a malformed block, nothing else. Content must still show.
  const e1 = fence('{"items":[ZZLONEZZ broken');
  check('E/lone-malformed: parse-null', parseDigest(e1) === null);
  const r1 = render(e1);
  survives('E/lone-malformed: payload survives', e1, 'ZZLONEZZ');
  check('E/lone-malformed: output non-empty', (r1.txt ?? '').trim().length > 0, 'rendered nothing');

  // Digest-ONLY well-formed message (no prose below). Item must show; no crash.
  const e2 = fence(JSON.stringify({ items: [{ text: 'ZZDIGONLYZZ', kind: 'decision' }] }));
  const r2 = render(e2);
  check('E/digest-only: digest built', r2.node.querySelector('.digest') !== null);
  survives('E/digest-only: item survives', e2, 'ZZDIGONLYZZ');

  // Empty string / nullish inputs must not throw and must not fabricate content.
  for (const [label, v] of [['empty', ''], ['null', null], ['undefined', undefined]]) {
    let threw = false;
    try {
      const n = renderAssistantText(v);
      check(`E/nullish ${label}: returns node`, !!n && typeof n.textContent === 'string');
    } catch (err) {
      threw = true;
    }
    check(`E/nullish ${label}: no throw`, !threw, 'renderAssistantText threw');
    check(`E/nullish ${label}: parseDigest null`, parseDigest(v) === null);
  }
}

/* =====================================================================
 * GROUP F — WELL-FORMED contract: raw JSON HIDDEN, prose-below fully survives.
 * ===================================================================== */
{
  const prose = 'ZZPHEADZZ decision rationale.\n\n- ZZBULLETZZ one\n- bullet two\n\nZZPTAILZZ final word.';
  const json = JSON.stringify({
    items: [
      { text: 'Chose approach A', kind: 'decision', importance: 'high', ref: 'FEAT-083' },
      { text: 'Merged the branch', kind: 'done', importance: 'low' },
      { text: 'Server still building', kind: 'in-flight' },
      { text: 'Note for later', kind: 'fyi', ref: 'not-a-ticket-label' },
    ],
  });
  const text = fence(json) + '\n\n' + prose;
  const { node, txt } = render(text, { enabled: true, projectId: 'p1' });

  check('F/wellformed: .digest built', node.querySelector('.digest') !== null);
  check('F/wellformed: 4 items rendered', node.querySelectorAll('.digest-item').length === 4,
    `got ${node.querySelectorAll('.digest-item').length} items`);
  // Item texts survive.
  for (const marker of ['Chose approach A', 'Merged the branch', 'Server still building', 'Note for later']) {
    check(`F/wellformed: item "${marker}" shown`, txt.includes(marker));
  }
  // EVERY char of prose-below survives (markers chosen to be markdown-safe).
  for (const marker of ['ZZPHEADZZ', 'ZZBULLETZZ', 'ZZPTAILZZ']) {
    check(`F/wellformed: prose ${marker} survives`, txt.includes(marker));
  }
  // Raw JSON is HIDDEN: no structural JSON syntax leaks into the visible text.
  check('F/wellformed: no "items" key visible', !txt.includes('"items"'), 'raw JSON key leaked into output');
  check('F/wellformed: no "importance" key visible', !txt.includes('"importance"'), 'raw JSON key leaked');
  check('F/wellformed: no "kind" key visible', !txt.includes('"kind"'), 'raw JSON key leaked');
  // Ticket ref becomes a deep link; non-ticket ref becomes an inert label.
  const link = node.querySelector('a.digest-ref-link');
  check('F/wellformed: ticket ref is a link', !!link && link.getAttribute('href')?.includes('FEAT-083'),
    'ticket ref did not become a deep link');
  check('F/wellformed: non-ticket ref is inert label',
    node.querySelector('span.digest-ref-label')?.textContent === 'not-a-ticket-label',
    'non-ticket ref not rendered as inert label');
  // No emoji leaked into the structured render (design rule).
  check('F/wellformed: no emoji in digest', !/\p{Emoji_Presentation}/u.test(node.querySelector('.digest').textContent ?? ''),
    'emoji found in structured digest');
}

/* =====================================================================
 * GROUP G — DISABLED path: identical well-formed input must show raw JSON,
 * build no digest, lose nothing.
 * ===================================================================== */
{
  const json = JSON.stringify({ items: [{ text: 'ZZDISITEMZZ', kind: 'decision', importance: 'high' }] });
  const text = fence(json) + '\n\nZZDISPROSEZZ below.';
  const { node, txt } = render(text, { enabled: false, projectId: 'p1' });
  check('G/disabled: NO .digest built', node.querySelector('.digest') === null, 'digest built while disabled');
  check('G/disabled: raw item text shown (JSON visible)', txt.includes('ZZDISITEMZZ'), 'item text lost while disabled');
  check('G/disabled: raw JSON key visible', txt.includes('items'), 'raw JSON not shown while disabled');
  survives('G/disabled: prose survives', text, 'ZZDISPROSEZZ', { enabled: false });
}

/* --------------------------------------------------------------- report */
console.log(`\n${'='.repeat(60)}`);
console.log(`PASS ${pass}   FAIL ${fail}`);
if (fail) {
  console.log('\nContent-loss / XSS findings:');
  for (const f of failures) console.log(`  - ${f}`);
  console.log('\nVERDICT: contract BROKEN');
  process.exit(1);
} else {
  console.log('VERDICT: contract HOLDS — no input lost, hid, or mangled message content; no markup injected.');
}
