/**
 * Question and plan cards — the inline decision moments in a transcript.
 *
 * WHY THIS EXISTS
 * ---------------
 * `AskUserQuestion` used to render as an ordinary tool chip: Claude asked, the
 * chip sat there inert, and the model carried on with "No answer, so I'll plan
 * the conservative path…". The user was never given a way to answer, and
 * nothing on screen said a decision was outstanding.
 *
 * So the two hard rules here are about honesty, not looks:
 *
 *  1. A card NEVER shows a chosen state the server has not confirmed. Selecting
 *     an option is local intent; `answered` is only reachable through an ack.
 *  2. "Answered" and "never answered" must be impossible to confuse. A question
 *     the session moved past without an answer says exactly that. It must never
 *     imply a choice was made, and it must not be quietly styled to look
 *     complete.
 *
 * This module is pure presentation: it takes normalised data and callbacks and
 * returns DOM. All wire handling (send, ack, timeout) lives in app.js next to
 * the approval flow it mirrors.
 */
import { el, clear, prose } from './dom.js';

/* ----------------------------------------------------------------- parsing */

/**
 * Normalise `AskUserQuestion` input into a stable shape.
 *
 * The tool nests questions under `questions[]`, but a single-question form and
 * a couple of key spellings show up too, so every plausible shape is accepted
 * rather than rendering an empty card and losing the question entirely.
 */
export function parseQuestions(input) {
  if (!input || typeof input !== 'object') return [];
  const raw = Array.isArray(input.questions) ? input.questions
    : Array.isArray(input.question) ? input.question
    : (input.question || input.options) ? [input]
    : [];
  return raw.map((q) => {
    const opts = Array.isArray(q?.options) ? q.options : [];
    return {
      question: str(q?.question ?? q?.prompt ?? q?.text ?? ''),
      header: str(q?.header ?? q?.title ?? ''),
      multiSelect: q?.multiSelect === true || q?.multiselect === true || q?.multi === true,
      options: opts.map((o) => (typeof o === 'string'
        ? { label: o, description: '' }
        : { label: str(o?.label ?? o?.name ?? o?.value ?? ''), description: str(o?.description ?? o?.detail ?? '') }))
        .filter((o) => o.label),
    };
  }).filter((q) => q.question || q.options.length);
}

/** `ExitPlanMode` carries the plan as markdown under a few possible keys. */
export function parsePlan(input) {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return '';
  return str(input.plan ?? input.markdown ?? input.text ?? input.content ?? '');
}

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/* ------------------------------------------------------------ question card */

/**
 * @param {object}   o
 * @param {Array}    o.questions   normalised questions
 * @param {boolean}  o.answerable  false when this server has no answer channel
 * @param {Function} o.onSubmit    (answers, ui) => void — ui.sending/answered/failed
 */
export function createQuestionCard({ questions, answerable, onSubmit }) {
  const card = el('div', { class: 'qcard', 'data-state': 'pending' });
  /** Selected labels per question index; a Set even for single-select. */
  const picked = questions.map(() => new Set());
  const others = questions.map(() => '');

  card.append(el('div', { class: 'qeyebrow' },
    el('span', { class: 'qdot' }),
    el('span', { text: questions.length > 1 ? `Claude is asking ${questions.length} questions` : 'Claude is asking' })));

  const body = el('div', { class: 'qbody' });
  const submit = el('button', { class: 'solid', text: 'Send answer' });

  questions.forEach((q, qi) => {
    const block = el('div', { class: 'qblock' });
    if (q.header) block.append(el('div', { class: 'qhdr', text: q.header }));
    if (q.question) block.append(el('div', { class: 'qtext', text: q.question }));
    if (q.multiSelect) block.append(el('div', { class: 'qhint', text: 'Choose any number' }));

    const list = el('div', { class: 'qopts' });
    const name = `q${qi}-${Math.random().toString(36).slice(2, 8)}`;

    for (const opt of q.options) {
      const row = el('label', { class: 'qopt' });
      const input = el('input', {
        type: q.multiSelect ? 'checkbox' : 'radio',
        name: q.multiSelect ? `${name}-${opt.label}` : name,
      });
      input.addEventListener('change', () => {
        if (!q.multiSelect) picked[qi].clear();
        if (input.checked) picked[qi].add(opt.label);
        else picked[qi].delete(opt.label);
        // Picking a listed option retires the free-text answer for this question.
        if (input.checked && !q.multiSelect) {
          others[qi] = '';
          const ot = block.querySelector('.qother input');
          if (ot) ot.value = '';
        }
        refresh();
      });
      row.append(input);
      const mid = el('span', { class: 'qmid' });
      mid.append(el('span', { class: 'qlabel', text: opt.label }));
      // The descriptions carry the trade-offs — they are the reason to render a
      // card at all, so they wrap in full and are never clamped.
      if (opt.description) mid.append(el('span', { class: 'qdesc', text: opt.description }));
      row.append(mid);
      list.append(row);
    }
    block.append(list);

    /* "Other" is always offered — the CLI has it and people rely on it. */
    const other = el('div', { class: 'qother' });
    const oi = el('input', {
      type: 'text', spellcheck: 'false', placeholder: 'Other — type your own answer',
      'aria-label': `Your own answer to: ${q.question || q.header || 'the question'}`,
    });
    oi.addEventListener('input', () => {
      others[qi] = oi.value;
      if (oi.value.trim() && !q.multiSelect) {
        // A typed answer replaces a radio choice; say so by clearing it.
        picked[qi].clear();
        for (const r of list.querySelectorAll('input')) r.checked = false;
      }
      refresh();
    });
    oi.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !submit.disabled) { e.preventDefault(); submit.click(); }
    });
    other.append(oi);
    block.append(other);
    body.append(block);
  });
  card.append(body);

  const acts = el('div', { class: 'qacts' });
  const verdict = el('span', { class: 'qverdict' });
  acts.append(verdict, el('span', { class: 'grow' }));

  const answersNow = () => questions.map((q, qi) => ({
    question: q.question,
    header: q.header,
    selected: [...picked[qi]],
    other: others[qi].trim() || null,
  }));

  const complete = () => answersNow().every((a) => a.selected.length > 0 || a.other);

  function refresh() {
    if (card.dataset.state !== 'pending') return;
    submit.disabled = !complete();
    const n = answersNow().filter((a) => a.selected.length || a.other).length;
    verdict.textContent = questions.length > 1 ? `${n} of ${questions.length} answered` : '';
  }

  const ui = {
    sending() {
      card.dataset.state = 'sending';
      submit.disabled = true;
      verdict.textContent = 'sending…';
      for (const i of card.querySelectorAll('input')) i.disabled = true;
    },
    /** Only ever called from a server ack. */
    answered(answers) {
      card.dataset.state = 'answered';
      renderChosen(card, body, questions, answers ?? answersNow());
      clear(acts).append(el('span', { class: 'qverdict', text: 'answered · confirmed by the server' }));
    },
    /** Nothing landed — hand the decision back rather than faking a result. */
    failed(why) {
      card.dataset.state = 'pending';
      for (const i of card.querySelectorAll('input')) i.disabled = false;
      verdict.textContent = `not sent — ${why}`;
      submit.disabled = !complete();
    },
    /*
     * A requestId arrived after the card was drawn, so this build CAN deliver
     * an answer after all. Swap the explanatory note for the real button.
     *
     * This must actually add the button: relabelling alone left a question
     * whose options were selectable with nothing to press — the card claimed
     * to be ready while offering no way to submit.
     */
    enable() {
      if (acts.contains(submit)) return;
      acts.querySelector('.qnote')?.remove();
      acts.append(submit);
      refresh();
    },
  };

  submit.addEventListener('click', () => onSubmit(answersNow(), ui));

  if (answerable) {
    acts.append(submit);
  } else {
    /* The question is real and outstanding; this build just cannot deliver an
       answer yet. Say that plainly instead of showing a dead button. */
    acts.append(el('span', { class: 'qnote', text: 'This server cannot deliver an answer yet — reply in the message box below and say which option you want.' }));
  }
  card.append(acts);
  refresh();

  return { node: card, ui, answersNow };
}

/** Replace the inputs with a plain reading of what was chosen. */
function renderChosen(card, body, questions, answers) {
  clear(body);
  questions.forEach((q, qi) => {
    const a = answers[qi] ?? { selected: [], other: null };
    const block = el('div', { class: 'qblock' });
    if (q.header) block.append(el('div', { class: 'qhdr', text: q.header }));
    if (q.question) block.append(el('div', { class: 'qtext', text: q.question }));
    const chosen = el('div', { class: 'qchosen' });
    for (const label of a.selected) {
      const opt = q.options.find((o) => o.label === label);
      const row = el('div', { class: 'qpick' });
      row.append(el('span', { class: 'qtick', text: '✓' }));
      const mid = el('span', { class: 'qmid' });
      mid.append(el('span', { class: 'qlabel', text: label }));
      if (opt?.description) mid.append(el('span', { class: 'qdesc', text: opt.description }));
      row.append(mid);
      chosen.append(row);
    }
    if (a.other) {
      const row = el('div', { class: 'qpick' });
      row.append(el('span', { class: 'qtick', text: '✓' }));
      row.append(el('span', { class: 'qmid' },
        el('span', { class: 'qlabel', text: a.other }),
        el('span', { class: 'qdesc', text: 'typed as a free-text answer' })));
      chosen.append(row);
    }
    block.append(chosen);
    body.append(block);
  });
  card.querySelector('.qeyebrow')?.replaceChildren(
    el('span', { text: 'You answered' }));
}

/**
 * The session moved past this question without an answer.
 *
 * This is the state the original bug produced, and the one most likely to be
 * misread, so it is spelled out rather than implied: no tick, no chosen option,
 * and an explicit sentence that no answer was given.
 */
export function markUnanswered(card, why) {
  if (!card || card.dataset.state === 'answered') return;
  card.dataset.state = 'unanswered';
  for (const i of card.querySelectorAll('input')) i.disabled = true;
  card.querySelector('.qeyebrow')?.replaceChildren(el('span', { text: 'Not answered' }));
  const acts = card.querySelector('.qacts');
  if (acts) {
    clear(acts).append(el('span', { class: 'qverdict warn', text: why || 'No answer was given — the session continued without your choice.' }));
  }
}

/* ---------------------------------------------------------------- plan card */

/**
 * `ExitPlanMode`: Claude presents a plan and waits. The plan is markdown, so it
 * goes through the prose renderer — a mono blob would make the thing the user
 * is being asked to read the hardest thing on screen.
 */
export function createPlanCard({ plan, answerable, onDecide }) {
  const card = el('div', { class: 'qcard plan', 'data-state': 'pending' });
  card.append(el('div', { class: 'qeyebrow' },
    el('span', { class: 'qdot' }),
    el('span', { text: 'Claude has a plan and is waiting for you' })));

  const body = el('div', { class: 'qbody' });
  body.append(prose(plan || '_(the plan came through empty)_', 'prose plan-prose'));
  card.append(body);

  const acts = el('div', { class: 'qacts' });
  const verdict = el('span', { class: 'qverdict' });
  const reject = el('button', { class: 'mini', text: 'Keep planning' });
  const approve = el('button', { class: 'solid', text: 'Approve and run' });
  acts.append(verdict, el('span', { class: 'grow' }));

  const ui = {
    sending(word) {
      card.dataset.state = 'sending';
      reject.disabled = true;
      approve.disabled = true;
      verdict.textContent = `sending ${word}…`;
    },
    decided(approved) {
      card.dataset.state = 'answered';
      card.dataset.verdict = approved ? 'approved' : 'rejected';
      card.querySelector('.qeyebrow')?.replaceChildren(
        el('span', { text: approved ? 'You approved this plan' : 'You asked for more planning' }));
      clear(acts).append(el('span', { class: 'qverdict', text: `${approved ? 'approved' : 'rejected'} · confirmed by the server` }));
    },
    failed(why) {
      card.dataset.state = 'pending';
      reject.disabled = false;
      approve.disabled = false;
      verdict.textContent = `not sent — ${why}`;
    },
    /* See the question card's enable(): the decision buttons must actually be
       added when a requestId turns up late, not merely announced. */
    enable() {
      if (acts.contains(approve)) return;
      acts.querySelector('.qnote')?.remove();
      acts.append(reject, approve);
    },
  };

  reject.addEventListener('click', () => onDecide(false, ui));
  approve.addEventListener('click', () => onDecide(true, ui));

  if (answerable) acts.append(reject, approve);
  else acts.append(el('span', { class: 'qnote', text: 'This server cannot deliver a decision yet — reply in the message box below to approve or redirect.' }));
  card.append(acts);

  return { node: card, ui };
}
