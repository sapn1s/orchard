/**
 * FEAT-090 — the ticket "Decide" widget: answer a decision where you read it.
 *
 * WHY A DEDICATED WIDGET (and not the rail's nc-card or a raw form)
 * ----------------------------------------------------------------
 * This mirrors public/lib/question.js's discipline — option rows, a free-text
 * field, and the renderChosen rule — but for the TICKET, where three things
 * differ from an AskUserQuestion card:
 *
 *   1. Options AND free text TOGETHER. question.js makes them mutually exclusive
 *      (picking an option clears the text). A ticket decision needs both: "B, but
 *      ship D first" is option B PLUS a note, which is exactly what ARCH-003
 *      recommends. So here a chosen option and a note coexist.
 *   2. A reply is not always a decision. A DECISION is answered → awaiting an
 *      agent. A QUESTION or COUNTER hands ownership to the AGENT. The kind is
 *      chosen explicitly (the segmented control), never inferred.
 *   3. renderChosen discipline (question.js rule #1): the card shows a chosen
 *      state ONLY from a server-confirmed answer. This module renders read-only
 *      from `answered` (the server's TicketAnswerState) — it never fakes it from
 *      local intent; the caller re-reads the ticket after a write and re-renders.
 */
import { el, inlineInto } from './dom.js';
import { recommendedKeys, activeStage } from './ticket-record.js';

/**
 * THE OPTION CARD (the redesign's one real invention).
 *
 * A migrated ticket's option carries four separately-named facts — what changes,
 * the benefit, the cost, and WHY THIS ISN'T OBVIOUSLY BEST — instead of one prose
 * blob. That last line is what makes four options comparable at a glance rather
 * than four paragraphs to be held in the head at once, so it is rendered as its
 * own annotated line and never folded into the description.
 *
 * `.dc-desc` keeps its name and keeps carrying the "what changes" sentence: it is
 * the element `verify:decide-readability` measures for reading width and line
 * count, and that guard must keep measuring the option's main prose.
 */
function richOptionBody(mid, opt) {
  if (opt.what_changes) mid.append(inlineInto(el('span', { class: 'dc-desc' }), opt.what_changes));
  const bc = el('span', { class: 'dc-bc' });
  if (opt.benefit) bc.append(el('span', { class: 'dc-benefit' },
    el('span', { class: 'dc-bc-k', text: 'Gains' }), inlineInto(el('span', { class: 'dc-bc-v' }), opt.benefit)));
  if (opt.cost) bc.append(el('span', { class: 'dc-cost' },
    el('span', { class: 'dc-bc-k', text: 'Costs' }), inlineInto(el('span', { class: 'dc-bc-v' }), opt.cost)));
  if (bc.childNodes.length) mid.append(bc);
  if (opt.why_not_obvious) {
    mid.append(inlineInto(
      el('span', { class: 'dc-why' }, el('span', { class: 'dc-why-k', text: 'Why this isn’t obviously best: ' })),
      opt.why_not_obvious));
  }
}

/**
 * The recommendation, as a LAST-RESORT line — rendered only when no option row
 * will carry it (a decision with a recommendation but no option list, or an
 * options list that does not contain the recommended key).
 *
 * WHY NOT ALWAYS (visual review, FEAT-090 round 2): as a chip above the options
 * it was the FOURTH restatement of one fact inside the top 200px (the amber
 * status line, the Status row in the body, the chip, and the annotated option
 * row) — and the only text on the card that clipped mid-phrase, because a
 * one-line pill cannot hold a full-sentence label in a 300px column. The
 * recommendation now lives on the option row it refers to, where it is also
 * ACTIONABLE. When it does render here it WRAPS; it never truncates.
 */
function recLine(decision, options) {
  const key = decision?.recommended;
  if (!key) return null;
  const opt = options.find((o) => o.key === key);
  if (opt) return null;   // the row carries it — see optRow's dc-rec-tag
  return el('div', { class: 'dc-rec' },
    el('span', { class: 'dc-rec-k', text: `Recommends ${key}` }));
}

/**
 * The read-only "you answered …" state — only ever from a server-confirmed reply.
 * After the answer it offers a FOLLOW-UP composer: a decision is often followed by
 * a clarification or a change of mind, and the answer log is append-only, so a
 * follow-up lands as its OWN dated entry (never an edit of the original) and
 * re-flags the ticket as awaiting agent action. `onSubmit` is the same reply
 * pipeline the form uses; null in the compact/read-only surface, where no writes
 * are allowed and the composer is omitted.
 */
function renderAnswered(decision, a, onSubmit) {
  const box = el('div', { class: 'dc-answered' });
  const verb = a.kind === 'question' ? 'asked a question'
    : a.kind === 'counter' ? 'countered'
    : `answered${a.chose ? ` ${a.chose.key}` : ''}`;
  const tail = a.kind === 'decision'
    ? (a.awaiting ? 'awaiting an agent' : 'an agent has since acted')
    : 'waiting on the agent';
  box.append(el('div', { class: 'dc-answered-h' },
    el('span', { class: 'dc-tick', text: '✓' }),
    el('span', { text: `You ${verb} on ${a.on} — ${tail}` })));
  if (a.chose) {
    const opt = (decision?.options ?? []).find((o) => o.key === a.chose.key);
    // The chosen label is authored prose (option labels may carry inline markdown);
    // render it through the SAME safe inline renderer as the option rows.
    box.append(el('div', { class: 'dc-pick' },
      el('span', { class: 'dc-k', text: a.chose.key }),
      inlineInto(el('span', { class: 'dc-pl' }), a.chose.label || opt?.label || '')));
  }
  // The answer note is free text the user wrote — render its emphasis too, so a
  // `**word**` reads the same here as anywhere else (the user's `**` complaint).
  if (a.note) box.append(inlineInto(el('div', { class: 'dc-note-ro' }), a.note));

  // Follow-ups already on the record, each its own dated appended note.
  const followups = Array.isArray(a.followups) ? a.followups.filter((f) => f && f.note) : [];
  for (const f of followups) {
    const fu = el('div', { class: 'dc-followup' });
    fu.append(el('div', { class: 'dc-followup-h', text: `Follow-up · ${f.on}` }));
    fu.append(inlineInto(el('div', { class: 'dc-note-ro' }), f.note));
    box.append(fu);
  }

  // The follow-up composer — "I have more to add". Absent on read-only surfaces.
  if (onSubmit) box.append(renderFollowupForm(decision, onSubmit));
  return box;
}

/**
 * "Add a follow-up" — a small composer under the answered state. It reuses the
 * reply pipeline with a `followup` flag: the server appends a NEW dated entry and
 * keeps the ticket answered-awaiting (owner 👤). The caller re-reads and re-renders
 * on success, so there is no local "sent" state to fake (renderChosen discipline).
 */
function renderFollowupForm(decision, onSubmit) {
  const wrap = el('div', { class: 'dc-followup-form' });
  wrap.append(el('div', { class: 'dc-followup-lbl', text: 'Add a follow-up' }));
  const note = el('textarea', {
    class: 'dc-note dc-followup-note', rows: '2',
    placeholder: 'More context, a caveat, or a change of mind…',
    'aria-label': 'Follow-up note',
  });
  const err = el('div', { class: 'dc-err', hidden: true });
  const btn = el('button', { class: 'dc-send dc-followup-send solid', type: 'button', text: 'Add follow-up note' });
  const foot = el('div', { class: 'dc-foot', text: 'Appended as a new dated entry — the ticket stays awaiting an agent. Your original answer is never changed.' });

  const refresh = () => { btn.disabled = !note.value.trim(); };
  note.addEventListener('input', refresh);
  note.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !btn.disabled) { e.preventDefault(); btn.click(); }
  });
  refresh();

  const ui = {
    sending() { btn.disabled = true; err.hidden = true; btn.textContent = 'Adding…'; },
    failed(why) { btn.disabled = false; err.hidden = false; err.textContent = why || 'not added'; btn.textContent = 'Add follow-up note'; },
  };
  btn.addEventListener('click', () => {
    const text = note.value.trim();
    if (!text) return;
    onSubmit({ kind: 'decision', followup: true, question: decision?.question ?? '', chose: null, note: text }, ui);
  });

  wrap.append(note, err, btn, foot);
  return wrap;
}

/**
 * @param {object}   o
 * @param {object}   o.decision  { question, options:[{key,label,description}], recommended }
 * @param {object?}  o.rich      the MIGRATED ticket's decision record (mode, option
 *   cards, recommendation_reason, prerequisite, stages) — null on a legacy ticket,
 *   where the server's prose parse above is all there is. When present it drives
 *   the option cards and the answer MODE; when absent every behaviour below is
 *   exactly what it was, byte for byte.
 * @param {object?}  o.answered  server TicketAnswerState, or null when unanswered
 * @param {Function} o.onSubmit  (reply, ui) => void; reply = { kind, question, chose, note }
 */
export function createDecideCard({ decision, rich = null, answered, onSubmit }) {
  // The rich record is authoritative about the options when it exists: it carries
  // the same option keys plus the comparison fields the prose parse cannot see.
  const richOpts = rich && Array.isArray(rich.options) && rich.options.length ? rich.options : null;
  const options = richOpts ?? (Array.isArray(decision?.options) ? decision.options : []);
  const mode = richOpts ? (rich.mode || 'single') : 'single';
  const stageNow = richOpts ? activeStage(rich) : null;
  const answerable = (opt) => !(mode === 'staged' && Number.isInteger(opt.stage) && Number.isInteger(stageNow) && opt.stage > stageNow);
  const recKeys = recommendedKeys(rich ?? decision);
  const card = el('div', { class: `tv-decide${richOpts ? ' dc-rich' : ''}`, 'data-state': answered ? 'answered' : 'pending', 'data-mode': mode });

  card.append(el('div', { class: 'dc-eyebrow' },
    el('span', { class: 'dc-dot' }),
    el('span', { text: mode === 'multi' ? 'Decision needed — choose any that apply'
      : mode === 'staged' ? 'Decision needed — first stage only' : 'Decision needed' })));
  // The question is authored prose and may carry inline markdown (`**bold**`,
  // `*emphasis*`) — render it through the shared safe inline renderer, never as a
  // raw string, so the user never reads a bare `*marker*` in the heading.
  const question = (rich?.question) || decision?.question || '';
  if (question) card.append(inlineInto(el('div', { class: 'dc-q' }), question));
  // A prerequisite is a fact that must be established before this decision is
  // SAFE to make. It is not a caveat on an option, so it sits above the options
  // where it is read before one is picked.
  if (rich?.prerequisite) {
    card.append(inlineInto(
      el('div', { class: 'dc-prereq' }, el('span', { class: 'dc-prereq-k', text: 'First establish: ' })),
      rich.prerequisite));
  }

  // Already answered → flip to the read-only reading of what the server recorded,
  // plus a follow-up composer (a decision is often followed by more context). The
  // follow-up rides the SAME onSubmit pipeline as the form.
  // (No recommendation echo here: the question now is "what did I answer", and a
  // "Recommends B" beside "You answered C" reads as an argument, not a record.)
  if (answered) { card.append(renderAnswered(decision, answered, onSubmit)); return { node: card }; }

  if (rich) {
    // A migrated decision states its recommendation AND the reason, or states
    // honestly that there is none — `recommendation: null` is a correct record
    // (a prerequisite is unproven), not a missing field, so it is said out loud
    // rather than left as an absence the reader has to notice.
    card.append(recKeys.length
      ? el('div', { class: 'dc-rec' },
        el('span', { class: 'dc-rec-k', text: `Recommends ${recKeys.join(' + ')}` }),
        rich.recommendation_reason
          ? inlineInto(el('span', { class: 'dc-rec-why' }), rich.recommendation_reason) : null)
      : el('div', { class: 'dc-rec none' },
        el('span', { class: 'dc-rec-k', text: 'No recommendation' }),
        el('span', { class: 'dc-rec-why', text: 'This ticket does not recommend an option.' })));
  } else {
    const rec = recLine(decision, options);
    if (rec) card.append(rec);
  }

  /* ---- the reply form -------------------------------------------------- */
  let kind = 'decision';
  const seg = el('div', { class: 'dc-seg', role: 'tablist', 'aria-label': 'Reply kind' });
  const segBtns = new Map();
  for (const [k, label] of [['decision', 'Decide'], ['question', 'Ask a question'], ['counter', 'Counter']]) {
    const b = el('button', { class: 'dc-seg-b', type: 'button', text: label });
    b.addEventListener('click', () => setKind(k));
    seg.append(b);
    segBtns.set(k, b);
  }
  card.append(seg);

  // `single`/`staged` pick ONE key; `multi` accumulates a set, because BUG-104's
  // real answer was "1 + 2 + 4" and a radio group cannot say that.
  let picked = null;
  const pickedSet = new Set();
  const optsHead = el('div', { class: 'dc-opts-h' });
  const list = el('div', { class: `dc-opts${richOpts ? ' dc-opts-cards' : ''}` });
  const name = `dc-${Math.random().toString(36).slice(2, 8)}`;
  for (const opt of options) {
    const isRec = recKeys.includes(opt.key);
    const later = !answerable(opt);
    const row = el('label', {
      class: `dc-opt${isRec ? ' is-rec' : ''}${richOpts ? ' dc-optcard' : ''}${later ? ' is-later' : ''}`,
    });
    const input = el('input', {
      type: mode === 'multi' ? 'checkbox' : 'radio',
      name: mode === 'multi' ? `${name}-${opt.key}` : name,
      value: opt.key,
    });
    if (later) {
      // A later stage is NOT answerable — that is what staging means. It is shown
      // (so the reader can see where this is going) and it is inert.
      input.disabled = true;
      row.setAttribute('aria-disabled', 'true');
    }
    input.addEventListener('change', () => {
      if (mode === 'multi') {
        if (input.checked) pickedSet.add(opt.key); else pickedSet.delete(opt.key);
      } else if (input.checked) picked = opt.key;
      refresh();
    });
    row.append(input);
    const mid = el('span', { class: 'dc-mid' });
    // RECOMMENDED is an annotation — a word, above the label. It must never be
    // drawn as a raised/tinted row: a first-time reader read that as ALREADY
    // CHOSEN (visual review, FEAT-090 round 2). Only :checked changes the row.
    if (isRec) mid.append(el('span', { class: 'dc-rec-tag', text: 'Recommended' }));
    if (later) mid.append(el('span', { class: 'dc-stage-tag', text: `Then — stage ${opt.stage}` }));
    mid.append(el('span', { class: 'dc-label' },
      el('span', { class: 'dc-k', text: opt.key }),
      el('span', { class: 'dc-lt', text: opt.label })));
    // The description is authored prose and may carry inline markdown (ARCH-004's
    // `*Cost:*` / `**bold**`, ARCH-003 D's `*briefing*`). Render the emphasis via
    // the shared safe inline renderer (DOM nodes, text inserted as TEXT — never
    // innerHTML) so the user never reads a raw `*marker*`.
    if (richOpts) richOptionBody(mid, opt);
    else if (opt.description) mid.append(inlineInto(el('span', { class: 'dc-desc' }), opt.description));
    if (richOpts && mode === 'multi' && opt.combines_with?.length) {
      mid.append(el('span', { class: 'dc-combines', text: `Composes with ${opt.combines_with.join(', ')}` }));
    }
    row.append(mid);
    list.append(row);
  }
  if (options.length) card.append(optsHead, list);
  // The staged plan, stated: what stage 1 answers, and what it unlocks. Without
  // it "you may only answer the first question" is a restriction with no reason.
  if (rich?.mode === 'staged' && rich.stages?.length) {
    const plan = el('div', { class: 'dc-stages' });
    for (const st of rich.stages) {
      if (!st || typeof st !== 'object') continue;
      const now = st.stage === stageNow;
      plan.append(el('div', { class: `dc-stage${now ? ' now' : ''}` },
        el('span', { class: 'dc-stage-n', text: now ? `Stage ${st.stage} — now` : `Stage ${st.stage} — later` }),
        el('span', { class: 'dc-stage-q', text: st.question || '' }),
        st.unlocked_by ? el('span', { class: 'dc-stage-u', text: `unlocked by ${st.unlocked_by}` }) : null));
    }
    if (plan.childNodes.length) card.append(plan);
  }

  const note = el('textarea', {
    class: 'dc-note', rows: '2',
    placeholder: options.length ? 'Add a note (optional) — e.g. “B, but ship D first”' : 'Your answer…',
    'aria-label': 'Reply note',
  });
  note.addEventListener('input', refresh);
  note.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !btn.disabled) { e.preventDefault(); btn.click(); }
  });
  card.append(note);

  const err = el('div', { class: 'dc-err', hidden: true });
  const btn = el('button', { class: 'dc-send solid', type: 'button', text: 'Record answer' });
  const foot = el('div', { class: 'dc-foot' });
  // The action row is ONE grouped block so the wide sticky card can pin it to the
  // bottom of its own scroll region — a tall multi-option decision scrolls behind
  // it and the primary action is never stranded below the fold (BUG-107).
  const actions = el('div', { class: 'dc-actions' }, err, btn, foot);
  card.append(actions);

  function setKind(k) {
    kind = k;
    for (const [kk, b] of segBtns) b.classList.toggle('on', kk === k);
    optsHead.textContent = k === 'decision'
      ? (mode === 'multi' ? 'Your choices — options compose' : mode === 'staged' ? 'Your choice — stage 1' : 'Your choice')
      : 'Referencing an option (optional)';
    btn.textContent = k === 'decision' ? 'Record answer' : k === 'question' ? 'Send question' : 'Send counter';
    foot.textContent = k === 'decision'
      ? 'Recorded to the ticket. No agent starts work until you say go.'
      : 'Sent to the ticket — ownership passes to the agent to reply. No work starts here.';
    refresh();
  }

  const chosenKeys = () => (mode === 'multi' ? [...pickedSet] : (picked ? [picked] : []));
  const complete = () => (kind === 'decision' ? (!!chosenKeys().length || !!note.value.trim()) : !!note.value.trim());
  function refresh() {
    if (card.dataset.state !== 'pending') return;
    btn.disabled = !complete();
  }

  const ui = {
    sending() { card.dataset.state = 'sending'; btn.disabled = true; err.hidden = true; btn.textContent = 'Recording…'; },
    failed(why) { card.dataset.state = 'pending'; err.hidden = false; err.textContent = why || 'not recorded'; setKind(kind); },
  };

  btn.addEventListener('click', () => {
    if (!complete()) return;
    // A multi answer is recorded as the KEY LIST the ticket's own recommendation
    // uses ("1 + 2 + 4") with the labels joined the same way — so what is written
    // to the ticket reads as the composed answer it is, not as one arbitrary key.
    const keys = chosenKeys();
    const chose = keys.length
      ? {
        key: keys.join(' + '),
        label: keys.map((k) => options.find((o) => o.key === k)?.label ?? '').filter(Boolean).join(' + '),
      }
      : null;
    onSubmit({ kind, question, chose, note: note.value.trim() }, ui);
  });

  setKind('decision');
  return { node: card };
}
