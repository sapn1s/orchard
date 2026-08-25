/**
 * Claude Station — the real UI.
 *
 * Everything on screen comes from the live server: the registry, the
 * session-history index of ~/.claude/projects, and the typed StationEvent
 * stream over the WebSocket. There is no canned data in this file.
 *
 * Scale note: the session store holds ~676 files. Sessions are fetched per
 * project on first expand and rendered in pages of 40, so the sidebar never
 * builds more DOM than the user has actually opened. Search loads every
 * project's index once, then filters in memory.
 */
import { $, el, clear, svg, mmss, kilo, bytes, when, shortPath, toolArg, prose, inlineInto } from './lib/dom.js';
import * as api from './lib/api.js';
import { createDrawer } from './lib/drawer.js';
import { createSlidePanel } from './lib/slide-panel.js';
import { createGitView } from './lib/git-view.js';
import { parseQuestions, parsePlan, createQuestionCard, createPlanCard, markUnanswered } from './lib/question.js';
import { createDecideCard } from './lib/decide.js';
import { ticketView, NOT_RECORDED, WORK_STATE_LABEL, HUMAN_ACTION_LABEL, outstandingBroken, INVISIBLE_CLAIM } from './lib/ticket-record.js';
import { renderAssistantText } from './lib/digest.js';
import { parseHash, formatHash, sameRoute, parseTicketsHash, formatTicketsHash, parseGuideHash, formatGuideHash, parseGitHash, formatGitHash } from './lib/route.js';

/*
 * Sessions shown per project before the "N more" affordance.
 *
 * Deliberately small. The sidebar's job is to get you to a project first and a
 * session second; with ~28 rows one expanded project buried the other five
 * entirely. Six is roughly one screen-third, so every project stays on screen
 * at once and depth is one click away rather than a scroll away.
 */
/**
 * The settings fields the server accepts as per-session overrides. Anything
 * else (isolation, mounts, container.*) is rejected with a fatal error by
 * design — honouring it would mean rebuilding the container and leaking the
 * change into every other session on the project.
 */
/*
 * FEAT-045: 'provider' has been in the SERVER's SESSION_OVERRIDE_FIELDS since
 * FEAT-037 P3, but this client-side mirror lacked it — so an armed session-
 * scope provider (drawer or the launch control) silently never rode `start`.
 */
const SESSION_OVERRIDABLE = ['provider', 'model', 'effort', 'permissionMode', 'maxBudgetUsd', 'allowedTools', 'disallowedTools'];

const PAGE = 6;
/** How many more a click of "N more" reveals — a screenful, not a trickle. */
const PAGE_MORE = 20;
/*
 * Recorded agents shown per session before "N more". A real overnight run in
 * this store has 113 of them; dropping all 113 hairlines at the end of the
 * transcript is the same wall the sidebar had, so the same restraint applies.
 */
const RAN_PAGE = 8;
const RAN_MORE = 25;

const state = {
  projects: [],
  sessions: new Map(), // projectId -> { loading, error, list, shown }
  expanded: new Set(),
  /*
   * FEAT-070 — how the project list is ordered: 'recency' (lastActivityAt desc,
   * the default) or 'alpha' (by name). `projOrder` is the STABLE captured id
   * order the tree actually renders — recomputed only on an explicit refresh or
   * a sort flip, never on every render, so a background activity bump cannot
   * reshuffle the sidebar under the user mid-session (the reorder-churn the
   * app.js:177 rationale warned about). See resortProjects().
   */
  projSort: 'recency',
  projOrder: [],
  current: { projectId: null, encodedDir: null, sessionId: null, title: null, os: null },
  /*
   * BUG-106 — the project that OWNS the session currently open in the transcript
   * dock (its running strip, permission hairline, driving socket, running poll).
   * Distinct from current.projectId, which follows the SIDEBAR selection:
   * selectProject (a bare "look at another project" header click) moves
   * current.projectId but must NOT move this. Keeping the two apart is what lets
   * the dock's session-bound surfaces be gated on "is the open session foreign to
   * the project I am now looking at?" (dockIsForeign) — so one project's live work
   * is never attributed to another — WITHOUT discarding the open session the user
   * may switch back to. Set when a session opens (openSession) or a new one is
   * started (startNew); untouched by selectProject.
   */
  openProjectId: null,
  overrides: {}, // session-scope settings overrides (drawer owns the semantics)
  ws: null,
  live: false,
  busy: false,
  turnStartedAt: 0,
  /*
   * BUG-033 — TRUE when this tab knows a turn is running but NOT when it
   * started (an old server that does not report `turnStartedAt`, reattaching to
   * a bridge whose turn began before this tab existed). The old code stamped
   * `Date.now()` in that case and counted up from it, so the "1:08" on screen
   * was how long the TAB had believed it, not the age of the turn. An honest
   * unknown ("—") is worth more than a fabricated stopwatch.
   */
  turnStartUnknown: false,
  agents: new Map(), // agentId -> { agent, t0, settled }
  /*
   * ARCH-001 phase 2 / BUG-034 — THE SERVER'S ANSWER to "what is running right
   * now" for the open session: `{v, at, turn:{running,since,…}, running:[…],
   * ended:[…]}`. This, and only this, decides what the live strip shows.
   * `null` = the server has not answered yet (or is too old to have the route),
   * which is an honest "we do not know", NOT an excuse to fall back to guessing
   * from accumulated events — see the block above renderStrip().
   */
  snap: null,
  snapPollTimer: null,
  /*
   * BUG-083 — a monotonic token stamped on every session boundary
   * (resetTranscript). A running-set poll captures it before its await and
   * drops its answer if the token has moved on: the poll it fired belonged to
   * the session we have since LEFT, and letting it land would paint the old
   * session's agents under the new one's name (ARCH-001 dishonesty).
   */
  snapScope: 0,
  /*
   * BUG-087 — a SIBLING of snapScope for the TRANSCRIPT (message) pane. Bumped on
   * every session boundary (resetTranscript). openSession captures it after the
   * reset and before its transcript fetch await; a fetch that lands after the
   * user has switched away (its scope has moved on) is DROPPED, so the previous
   * session's transcript can never paint under the newly-opened session's header
   * (the content-pane analogue of the running-strip race BUG-083 fixed).
   */
  txScope: 0,
  /*
   * BUG-034 / §C — TRUE when the last answer can no longer be checked: the
   * socket dropped or the poll cannot reach the server. The rows are NOT
   * deleted (the work may well still be running server-side — BUG-018/020) and
   * NOT presented as current either (nothing can vouch for them). They freeze,
   * lose their ◐, and say so. Claiming and denying are both lies here.
   */
  snapStale: false,
  snapStaleAt: 0,
  /** FEAT-057 — undismissed agent deaths the server recorded (rail items). */
  outcomes: [],
  /** BUG-070 — false = recent/undismissed only; true = "show all" (old + dismissed). */
  showAllOutcomes: false,
  agentText: new Map(), // agentId -> accumulated text
  asks: new Map(),
  threads: new Map(), // 'main' | agentId -> thread (own .pane, own render cursor)
  viewing: 'main',
  caps: { subagents: null, live: null, running: null, outcomes: null }, // null = unprobed, false = route absent on this server
  effective: null,         // EffectiveConfig — what the session really runs with
  /* FEAT-051 — the LIVE session's own tool list (session-init.tools), the
     ground truth for which MCP servers actually attached: an attached server
     shows up as `mcp__<server>__…` tool names in the CLI's init report.
     Null until a session speaks; cleared with the socket. */
  liveTools: null,
  /* Per-session snapshot protection reported in the `start` ack:
     null = unreported, {protected:true} = has a restore point,
     {protected:false} = none (off, or the start snapshot failed). */
  startSnapshot: null,
  dropped: false,          // socket died mid-session; refuse to send until resolved
  budgetLocked: false,     // maxBudgetUsd hit — session refuses all further sends (BUG-013)
  budgetLockReason: '',    // the server's budget-stop message, shown in the lock banner
  liveElsewhere: '',       // BUG-149: the server's live-in-another-tab refusal, shown in a banner (not the console)
  pendingSend: null,       // { el, text } for the optimistic youBubble of an in-flight submit(),
                           // rolled back if the server rejects it (BUG-013) — cleared on any settle
  resumeOnNextSend: null,  // sdk session id to resume once the user writes again
  pendingStart: null,      // text of a `start`/resume awaiting its `ack`; non-null == turn not yet begun
  pendingStartResume: null,// the sdk session id that pending `start` was resuming (null for a fresh start)
  pendingStartEl: null,    // BUG-149: the exact optimistic bubble that `start` painted — set with pendingStart, in the same tick
  drainWaitTimer: null,    // BUG-045: slow self-retry interval while a drain-wait row is queued
  drainWaitAttempt: null,  // BUG-045: the queue row whose self-retry `start` is in flight (exactly-once guard)
  drainWaitLastTry: 0,     // BUG-045: throttle so poll + liveness-transition triggers cannot hammer the gate
  deliveryRelay: null,     // FEAT-065: the open ws is ONLY the approval relay for a turn delivered into the drain-held survivor (sdk id, or true)
  closingOnPurpose: false, // distinguishes our own close() from a real drop
  pendingAnswers: new Map(), // requestId -> answer awaiting the server's ack
  decisionsByRequest: new Map(), // requestId -> question/plan card awaiting an ack
  busyWatchdog: null,
  sdkSessionId: null,
  // FEAT-022: the STATION session id (from the `start` ack) — the key the
  // /api/sessions/:id/autonomous routes are addressed by. Null until a session
  // is actually driven from this tab.
  stationSessionId: null,
  // FEAT-022: autonomous mode mirror of the server's AutonomousState. Default
  // interactive; a session is NEVER shown autonomous unless the server says so.
  autonomous: { autonomous: false, maxTurns: null, turnsDone: 0, remaining: null, stopReason: null },
  watchWs: null,          // passive listener — see the "auto-follow" section
  watchTries: 0,
  liveIds: new Map(),  // `${dir} ${sessionId}` -> live record, for sessions being written
  following: false,    // is the server watching the open session file for us?
  liveTimer: null,
  forkFrom: null, // session id being branched from, set by the Windows fork bar
  forkEncodedDir: null, // BUG-090: the SOURCE store dir a needs-fork branch must stage from (server-supplied)
  pendingFork: null, // BUG-090: {resumeSessionId, resumeEncodedDir, cause} — a resume the server said needs a fork
  queue: [], // messages typed mid-turn: {text, el} — delivered at turn boundaries
  /*
   * BUG-129 (option A): the batch flushQueue/deliverForced has HANDED to the
   * socket but whose turn this tab has not yet seen start. It is spliced out of
   * state.queue at that moment, so without this it exists nowhere for the whole
   * send→turn-end window and a reload in that window destroys it. Cleared at
   * turn-end — the point at which the server has certainly written the prompt to
   * the transcript, i.e. the point at which it is durable somewhere else.
   * {texts: string[], at: number}
   */
  outbox: null,
  forceSend: null, // {text, composedAt} pulled out of queue, awaiting the interrupt it triggered to land at turn-end (FEAT-031 Part A)
  /*
   * BUG-083 — unsent composer text, keyed to the project/session it was typed
   * in. A switch SAVES the outgoing draft under its key and RESTORES the target
   * session's own draft (empty if none), so a draft never rides into the wrong
   * project. Survives within the tab's lifetime; not persisted to storage.
   */
  drafts: new Map(),
  // FEAT-073 — the projectId whose "New session" the user has EXPLICITLY opened
  // and not yet sent. Only this drives the derived pending-new sidebar row, so a
  // project that is merely selected (a project with no session on screen) never
  // sprouts a phantom row. Set by startNew, cleared when a real session opens.
  pendingNew: null,
  searchLoaded: false,
  contentSearch: null, // { q, scope, showTools, loading, error, result } — tier-2 search
  git: new Map(), // projectId -> { status, at, loading } — crown chip cache
  followingLive: false, // opened a session still running server-side (e.g. after reload)
  followingExternal: false, // opened a session written live by ANOTHER process (a terminal) — no bridge to drive it; a toggle only arms the takeover
  seen: new Map(), // `${dir} ${sessionId}` -> ISO of when the user last had it open
  procSummary: null, // projectId -> {count, ports, hasSelf} — ambient "running here"
  board: null,       // {hasBoard, needsYou, queued, inflight, doneToday} for the current project
  boardProjectId: null, // which project state.board belongs to
  boardBusy: false,  // a refresh is in flight
  // FEAT-040 — session-status affordance ground truth. `sessPhase` only means
  // something while `busy` is true ('thinking' until the first text-delta,
  // then 'streaming'); the others are independent flags so more than one true
  // condition can exist at once — computeSessState() below picks the single
  // most-honest label by priority.
  sessPhase: 'thinking',
  sessReconnecting: false, // a resume's connect() is in flight — transport down, work status unknown
  // BUG-153: there is no `sessDetached` flag. "Running server-side without THIS
  // tab driving it" is DERIVED — see isDriving() and computeSessState().
  sessError: null,         // last fatal/budget-stop message; cleared when a new turn starts
  // BUG-031 — the last TERMINAL provider-error event of the current turn
  // (kind/provider/detail/retryable…), so turn-end can label the ending with
  // the provider's own words instead of the SDK's misleading subtype (an API
  // error turn's subtype is literally 'success'). Cleared when a turn starts.
  provError: null,
  lastTurnPrompt: null,    // last user prompt actually sent — the retry affordance re-sends it
  // FEAT-048 — lazily-fetched /api/health survival ground truth for the
  // CURRENT session, cached briefly so repeated hovers don't re-fetch.
  // { key, entry, at } — key identifies which session `entry` describes.
  sessSurvival: { key: null, entry: null, at: 0 },
};

/* ------------------------------------------------- sidebar attention state */
/*
 * The user works ~3 projects at once. Two things must survive a reload so the
 * sidebar answers "what still needs me" without re-expanding everything:
 *  - WHICH projects are expanded (their choice, not a heuristic — auto-expand
 *    by recency was tried on paper and rejected: 4 active projects would
 *    rebuild the wall-of-sessions the cap exists to prevent);
 *  - which sessions they have SEEN, so a collapsed header can badge "2 new"
 *    for activity that happened since they last looked.
 */

const EXPANDED_KEY = 'cs-expanded';
const SEEN_KEY = 'cs-seen';

function saveExpanded() {
  try { localStorage.setItem(EXPANDED_KEY, JSON.stringify([...state.expanded])); } catch { /* private mode — volatile is fine */ }
}
function loadExpanded() {
  try { for (const id of JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '[]')) state.expanded.add(id); } catch { /* garbage — start fresh */ }
}
function loadSeen() {
  try {
    for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}'))) state.seen.set(k, v);
  } catch { /* garbage — start fresh */ }
}
let seenSaveTimer = null;
function saveSeenSoon() {
  clearTimeout(seenSaveTimer);
  seenSaveTimer = setTimeout(() => {
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(Object.fromEntries(state.seen))); } catch { /* full/private */ }
  }, 400);
}
const seenKey = (dir, sessionId) => `${dir ?? ''} ${sessionId}`;

/** Stamp the open session as seen NOW — the user is literally looking at it. */
function stampSeenCurrent() {
  const { encodedDir, sessionId } = state.current;
  if (!sessionId) return;
  state.seen.set(seenKey(encodedDir, sessionId), new Date().toISOString());
  saveSeenSoon();
}

/**
 * Sessions in this project with activity the user has not looked at since.
 * Never-seen sessions only count within a 24h baseline — without it, every
 * old session would scream "new" on the feature's first day.
 */
function unseenCount(s) {
  if (!s?.loaded) return 0;
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const cur = seenKey(state.current.encodedDir, state.current.sessionId ?? '');
  let n = 0;
  for (const x of s.list) {
    const k = seenKey(x.encodedDir, x.sessionId);
    if (k === cur) continue; // on screen right now
    const seen = state.seen.get(k) ?? dayAgo;
    if (String(x.lastActivityAt ?? '') > seen) n++;
  }
  return n;
}

/* Ambient "something is running here": one server-side /proc sweep for all
   projects, polled slowly. The header shows the listening port — the most
   recognizable fingerprint of a forgotten dev server. */
const PROC_POLL_MS = 15_000;

async function refreshProcSummary() {
  try {
    const s = await api.processSummary();
    if (s === null) return; // route not on this server yet — show nothing
    const before = JSON.stringify(state.procSummary);
    state.procSummary = s;
    if (JSON.stringify(s) !== before) { renderTree(); paintCrown(); }
  } catch { /* transient — keep the last honest answer */ }
}

function startProcPolling() {
  void refreshProcSummary();
  setInterval(() => void refreshProcSummary(), PROC_POLL_MS);
}

/** The station's own port — always shown first in the proc chip preview. */
const STATION_PORT = 4317;
/** Inline port cap for the crown proc chip; the rest collapse into "+N". */
const PROC_PORT_CAP = 3;

/**
 * BUG-082: a STABLE port order so the capped inline preview never jitters
 * between polls — :4317 (the station) always first, then the ephemeral scratch
 * ports ascending. Deduped and numeric-sorted, so re-renders are deterministic.
 */
function orderedPorts(ports) {
  const nums = [...new Set((ports ?? []).map(Number))].filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const station = nums.filter((x) => x === STATION_PORT);
  const rest = nums.filter((x) => x !== STATION_PORT);
  return [...station, ...rest];
}

/** Compact header chip text for a project's process summary, or null. */
function procChipText(p) {
  const s = state.procSummary?.[p.id];
  if (!s || !s.count) return null;
  const ports = orderedPorts(s.ports);
  if (ports.length) return `:${ports[0]}${ports.length > 1 ? ` +${ports.length - 1}` : ''}`;
  return `${s.count} proc${s.count === 1 ? '' : 's'}`;
}

function procChipTitle(p) {
  const s = state.procSummary?.[p.id];
  if (!s) return '';
  return `${s.count} process${s.count === 1 ? '' : 'es'} running from this directory`
    + `${s.ports.length ? ` · listening ${orderedPorts(s.ports).map((x) => `:${x}`).join(' ')}` : ''}`
    + `${s.hasSelf ? ' (includes this dashboard)' : ''}\nOpen project settings › Running here`;
}

/** Any session of this project being written right now (any process). */
function projectHasLive(p, s) {
  if (!state.liveIds.size) return false;
  const dirs = new Set(s?.dirs ?? []);
  for (const rec of state.liveIds.values()) {
    if (rec.dir && dirs.has(rec.dir)) return true;
    // dir-less live records: fall back to matching a listed session id
    if (!rec.dir && s?.list?.some((x) => x.sessionId === rec.sessionId)) return true;
  }
  return false;
}

const node = {
  win: $('#win'),
  tree: $('#tree'),
  projSort: $('#projSort'), // FEAT-070 — the recency/alpha sort toggle

  where: $('#where'),
  title: $('#title'),
  seal: $('#seal'),
  sessStatus: $('#sessStatus'),
  sessStatusLbl: $('#sessStatusLbl'),
  isoBtn: $('#isoBtn'),
  isoG: $('#isoG'),
  isoN: $('#isoN'),
  insBtn: $('#insBtn'),
  insN: $('#insN'),
  insPlus: $('#insPlus'),
  gitBtn: $('#gitBtn'),
  gitN: $('#gitN'),
  procBtn: $('#procBtn'),
  procN: $('#procN'),
  procPop: $('#procPop'),
  procPorts: $('#procPorts'),
  sealSep: $('#sealSep'),
  pop: $('#pop'),
  rowMenu: $('#rowMenu'),
  picker: $('#picker'),
  pickList: $('#pickList'),
  pickFilter: $('#pickFilter'),
  pickPath: $('#pickPath'),
  pickApplyMethod: $('#pickApplyMethod'),
  main: document.querySelector('.main'),
  scroll: $('#scroll'),
  jump: $('#jump'),
  panes: $('#panes'),
  asks: $('#asks'),
  strip: $('#strip'),
  stripRows: $('#stripRows'),
  stripSum: $('#stripSum'),
  stripClk: $('#stripClk'),
  box: $('#box'),
  prompt: $('#prompt'),
  go: $('#go'),
  skipBtn: $('#skipBtn'),
  planBtn: $('#planBtn'),
  modelBtn: $('#modelBtn'),
  provBtn: $('#provBtn'),
  provPop: $('#provPop'),
  provOpts: $('#provOpts'),
  modelChip: $('#modelChip'),
  modelChipName: $('#modelChipName'),
  modelPop: $('#modelPop'),
  modelOpts: $('#modelOpts'),
  effortOpts: $('#effortOpts'),
  permLine: $('#permLine'),
  frozen: $('#frozen'),
  dropped: $('#dropped'),
  droppedText: $('#droppedText'),
  historyBar: $('#history'),
  historyLatestBtn: $('#historyLatestBtn'),
  agentDone: $('#agentDone'),
  agentDoneText: $('#agentDoneText'),
  fine: $('#fine'),
  finder: $('#finder'),
  findInput: $('#findInput'),
  libCount: $('#libCount'),
  themeVal: $('#themeVal'),
  rail: $('#rail'),
  railBadge: $('#railBadge'),
  railBadgeN: $('#railBadgeN'),
  railCount: $('#railCount'),
  railBoardLink: $('#railBoardLink'), // FEAT-066 — in-context entry to the board
  boardBtn: $('#boardBtn'),           // FEAT-066 — persistent topbar board entry
  boardBtnN: $('#boardBtnN'),
  railSummary: $('#railSummary'), // FEAT-067 — server-derived top-of-rail status index
  railNeeds: $('#railNeeds'),
  railObservations: $('#railObservations'), // FEAT-079 — read-only findings lane
  railStopped: $('#railStopped'), // FEAT-057 — agents that stopped, and why
  railQueued: $('#railQueued'),   // FEAT-053 — the todo backlog, read-only
  railInflight: $('#railInflight'),
  railDone: $('#railDone'),
  integStrip: $('#integStrip'),   // FEAT-051 — attached-capability chips
  ticketModal: $('#ticketModal'),         // FEAT-053 — rail ticket modal
  ticketModalBody: $('#ticketModalBody'),
};

/*
 * BUG-013: a budget-stopped session must lock the composer, not just show a
 * transient toast — the toast scrolls away, the composer does not lie about
 * being usable again. Built here (not in index.html) so the fix stays inside
 * app.js: reuses the existing `.frozen` banner styling (see #dropped/#frozen
 * in index.html) rather than inventing new CSS. Inserted right after the
 * "connection dropped" banner, in the same composer-replacement stack.
 */
node.budgetLockedText = el('span');
node.budgetLocked = el('div', { class: 'frozen', id: 'budgetLocked', hidden: true }, node.budgetLockedText);
node.dropped.insertAdjacentElement('afterend', node.budgetLocked);

/*
 * BUG-149: the server refuses a send when another tab is already driving the
 * session, and it says exactly why in a sentence a person can act on. That
 * sentence used to reach `console.log` and nothing else, so the message simply
 * looked sent and no reply ever came. It gets a banner of its own, built the
 * same way as the budget lock above (same `.frozen` styling, no new CSS).
 *
 * Unlike the budget lock this one does NOT replace the composer: the session is
 * alive and this tab may take it over the moment the other one lets go, so
 * typing must stay possible. It stays until the next send attempt settles it.
 *
 * Placement is load-bearing and was got wrong first: mounted next to the
 * composer-replacement banners it rendered BELOW the composer, off the bottom
 * of the viewport — a screenshot caught what the DOM assertions could not (the
 * element was present, visible and correct, and the user still could not read
 * it). It belongs directly above the dock, so the three things read in the
 * order they happened: what the server said, the words it refused, the box to
 * try again from.
 */
node.liveElsewhereText = el('span');
node.liveElsewhereDismiss = el('button', { class: 'pill', text: 'Dismiss' });
node.liveElsewhere = el('div', { class: 'frozen', id: 'liveElsewhere', hidden: true },
  node.liveElsewhereText, node.liveElsewhereDismiss);
$('#queueBox').insertAdjacentElement('beforebegin', node.liveElsewhere);
node.liveElsewhereDismiss.addEventListener('click', () => {
  state.liveElsewhere = '';
  node.liveElsewhere.hidden = true;
});

/* ------------------------------------------------------------------ chrome */

/*
 * BUG-100 — the composer footer (#fine) is a PERSISTENT status affordance, not a
 * log. Two rules keep it honest:
 *
 *   1. A hard length cap. No single status item may ever overflow the strip,
 *      whatever the server sends. A caller can hand `say()` a multi-hundred-char
 *      shell command (a dispatched agent's task notification carries exactly
 *      that); it is truncated on a word/segment boundary with an ellipsis, and
 *      the FULL text rides the title so nothing is lost to a hover.
 *   2. The stable isolation/access label is the RESTING content — never
 *      permanently displaced by activity text. `restLabel()` re-asserts it once
 *      a turn settles; the raw command text lives in the running rail + title,
 *      never as the footer's resting line.
 */
const MAX_FINE = 88;

function truncFine(text) {
  const t = String(text ?? '');
  if (t.length <= MAX_FINE) return t;
  const cut = t.slice(0, MAX_FINE - 1);
  // Prefer the last word/segment boundary (space, · separator, or path slash)
  // in the back third of the budget, so we never chop mid-word.
  const b = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('·'), cut.lastIndexOf('/'));
  const head = (b > MAX_FINE * 0.6 ? cut.slice(0, b) : cut).replace(/[\s·/]+$/, '');
  return `${head}…`;
}

function say(text, isErr = false, full = null) {
  const raw = text ?? '';
  const shown = truncFine(raw);
  node.fine.textContent = shown;
  // Keep the untruncated text (or an explicit `full`, e.g. a raw command) on the
  // title so the strip is never the only place it exists.
  node.fine.title = full != null ? String(full) : (shown !== String(raw) ? String(raw) : '');
  node.fine.classList.toggle('err', !!isErr);
  node.fine.hidden = !shown;
  if (isErr) console.warn('[station]', raw);
}

/**
 * BUG-101 — the footer's two kinds of fact set apart. The isolation/access label
 * is a PERMANENT session property; the "N agents running" count is TRANSIENT
 * activity. Rendered as one flat run-on with an identical `·` they read as a
 * single string. Here the label is the stable primary content and the count
 * rides a `.fine-run` span in a quieter tone, introduced by the moss "alive" dot
 * (the app reserves moss for a running agent) instead of another `·` — structure
 * matching meaning. Cap + truncation order are preserved: the transient count is
 * dropped FIRST when the strip is tight; the label always survives (truncated on
 * its own boundary only if it alone exceeds the cap). `full` (the raw command)
 * still rides the title so nothing is lost.
 */
function sayIso(label, activity, full = null) {
  const f = node.fine;
  f.classList.remove('err');
  f.textContent = '';
  f.title = full != null ? String(full) : '';
  const lbl = String(label ?? '');
  const act = String(activity ?? '');
  // The moss-dot separator is drawn by CSS (::before), so it costs no textContent
  // budget; a single space keeps the label and count from concatenating in copy.
  const runCost = act ? act.length + 1 : 0;
  if (act && lbl.length + runCost <= MAX_FINE) {
    if (lbl) appendLabel(f, lbl);
    const run = el('span', { class: 'fine-run' }, document.createTextNode(` ${act}`));
    f.append(run);
  } else {
    // No activity, or no room for it: the stable label alone, count sacrificed.
    appendLabel(f, truncFine(lbl || act));
  }
  f.hidden = !f.textContent;
}

/**
 * BUG-101 fix2 — the label's own `·` separators are a MINOR break (inside one
 * label: `Direct · full access to this machine`), while the moss dot marks the
 * MAJOR break between two different facts. Rendered as plain text the minor
 * break inherited full label weight and out-shouted the accent — the ranking
 * read backwards. Each `·` rides a `.fine-sep` span so CSS can rank it below
 * the words it parts. textContent is byte-identical, so the BUG-100 length cap
 * and truncation contract are untouched.
 */
function appendLabel(host, text) {
  const parts = String(text ?? '').split('·');
  parts.forEach((part, i) => {
    if (i > 0) host.append(el('span', { class: 'fine-sep', text: '·' }));
    if (part) host.append(document.createTextNode(part));
  });
}

/**
 * BUG-100 — the stable isolation/access label as one string. The SINGLE source
 * for both the resting footer line (paintSeal) and its re-assertion (restLabel),
 * so the two can never disagree.
 */
function isoLabel(p) {
  if (!p) return '';
  const mounts = p.settings?.mounts ?? [];
  const n = mounts.length;
  return p.isolation === 'container'
    ? `Container · ${n} mount${n === 1 ? '' : 's'} · everything stays on this machine`
    : p.isolation === 'sandbox'
      ? 'Sandbox · writes confined to the project'
      : 'Direct · full access to this machine';
}

/** Re-assert the stable isolation label as the footer's resting content. Called
 *  whenever a turn/agent activity settles so transient text can never stick. */
function restLabel() {
  const p = currentProject();
  // sayIso with no activity = the stable label alone, rendered with its `·`
  // breaks ranked below the words (BUG-101 fix2). Same text, same cap.
  if (p && !state.busy) sayIso(isoLabel(p), '');
}

/** How many SUBAGENTS the server's running snapshot reports in flight (never the
 *  main row). Used to render a bounded "N agents running" indicator. */
function runningAgentCount() {
  const snap = state.snap;
  if (snap && Array.isArray(snap.running)) return snap.running.filter((r) => r.row !== 'main').length;
  return 0;
}

/* ------------------------------------------- per-session override memory */
/*
 * Session-scope overrides (skip-perms, plan, model, effort) are deliberate
 * per-SESSION acts: a NEW session must never inherit them. But the SAME
 * session losing its armed state on a page reload is not hygiene, it is
 * amnesia — the toggle said "enabled" and a reload silently un-said it.
 * So overrides persist keyed by the exact session, restored only when THAT
 * session is reopened. startNew still starts clean, always.
 */
const OVR_KEY = 'cs-overrides';

function ovrStore() {
  try { return JSON.parse(localStorage.getItem(OVR_KEY) ?? '{}'); } catch { return {}; }
}

function persistOverrides() {
  const { encodedDir, sessionId } = state.current;
  if (!sessionId) return; // pre-start arming persists once session-init names the id
  const all = ovrStore();
  const k = `${encodedDir ?? ''} ${sessionId}`;
  if (Object.keys(state.overrides).length) all[k] = { ...state.overrides };
  else delete all[k];
  try { localStorage.setItem(OVR_KEY, JSON.stringify(all)); } catch { /* volatile is fine */ }
}

/** Replace the in-memory overrides with what THIS session had armed, if anything. */
function restoreOverrides(encodedDir, sessionId) {
  for (const k of Object.keys(state.overrides)) delete state.overrides[k];
  const saved = ovrStore()[`${encodedDir ?? ''} ${sessionId}`];
  if (saved && typeof saved === 'object') Object.assign(state.overrides, saved);
}

/** Outstanding live permission-mode change: {requestId, next, timer}. */
let permModePending = null;

/**
 * Outstanding live MODEL change: {requestId, value, timer}. BUG-026 — picking a
 * model on a RUNNING session must go through the server's live `setModel` (the
 * SDK's `Query.setModel`), exactly like permission mode: the old code only ever
 * armed a client-side override that `effectiveModel()` correctly ignores while
 * live, so the picker reverted on reopen and the session never switched.
 */
let modelPending = null;

/*
 * FEAT-042 — the always-visible model chip's two sources of truth:
 *
 *   liveWireModel     — the wire id the RUNNING session last reported for its
 *                       main thread (`session-init.model`, then every
 *                       `model-observed` per-turn report). The most live value
 *                       there is; null until the session speaks (and reset when
 *                       a confirmed live switch makes the old report stale).
 *   expectedLiveModel — what the USER chose or launched with (session-init's
 *                       pick, updated by a server-CONFIRMED /model switch).
 *                       A live report that does not match this is, by
 *                       definition, a change the user did not initiate — the
 *                       silent provider switch the chip exists to catch.
 */
let liveWireModel = null;
let expectedLiveModel = null;

const currentProject = () => state.projects.find((p) => p.id === state.current.projectId) ?? null;

/*
 * FEAT-083: the digest-aware assistant-text renderer. A project may DISABLE the
 * structured response digest via `settings.responseDigest.enabled === false`, in
 * which case the envelope is never parsed and the message renders as plain prose
 * (the fence just shows as a normal code block). Default is enabled. Reading the
 * flag per-render (not caching) means a project settings change takes effect on
 * the next transcript render with no server restart.
 */
const digestEnabled = () => currentProject()?.settings?.responseDigest?.enabled !== false;
const assistantProse = (text) => renderAssistantText(text, {
  enabled: digestEnabled(),
  projectId: state.current.projectId ?? null,
});

let gitView;
const drawer = createDrawer({
  getProject: currentProject,
  overrides: state.overrides,
  getEffective: () => state.effective,
  // BUG-135 — the drawer needs the running session's OWN attach report to say
  // "enabled here, not in this session". Routed through the same dockLiveTools
  // gate as every other live surface so a foreign selection reads null (BUG-106)
  // rather than borrowing another project's attach.
  getLiveTools: () => dockLiveTools(),
  getStartSnapshot: () => state.startSnapshot,
  notify: say,
  openGit: () => void gitView?.open(),
  async refreshProject() {
    const p = await api.getProject(state.current.projectId);
    const i = state.projects.findIndex((x) => x.id === p.id);
    if (i >= 0) state.projects[i] = p;
    paintCrown();
  },
  onStackChanged: paintCrown,
  /*
   * BUG-138 — a repoint changes two things the sidebar is showing: whether the
   * project is flagged "dir missing", and which sessions list under it (the
   * old path's history is carried, so the list must be re-read, not kept).
   * Refreshing only the drawer would leave the sidebar asserting a state the
   * user just fixed.
   */
  async onPathChanged(id) {
    await loadProjects();
    await loadSessions(id, { force: true });
    paintCrown();
  },
});

gitView = createGitView({
  getProject: (id) => id ? (state.projects.find((p) => p.id === id) ?? null) : currentProject(),
  getProjects: () => state.projects,
  navigate: (id, options) => navGit(id, options),
  notify: say,
  onStatusChanged(status, projectId) {
    const p = state.projects.find((candidate) => candidate.id === projectId) ?? null;
    if (!p || !status) return;
    state.git.set(p.id, { status, at: Date.now(), loading: false });
    paintGitChip();
  },
});

/* ------------------------------------------------------------------- theme */

function applyTheme(t) {
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  node.themeVal.textContent = t;
  try { localStorage.setItem('cs.theme', t); } catch { /* private mode */ }
}
const THEMES = ['system', 'light', 'dark'];
let theme = (() => { try { return localStorage.getItem('cs.theme') || 'system'; } catch { return 'system'; } })();
applyTheme(THEMES.includes(theme) ? theme : 'system');
$('#themeBtn').addEventListener('click', () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  applyTheme(theme);
});

/* ----------------------------------------------------------------- sidebar */

async function loadProjects() {
  state.projects = await api.listProjects();
  resortProjects(); // FEAT-070 — an explicit refresh is a sanctioned re-sort point
  renderTree();
}

function sessionState(id) {
  if (!state.sessions.has(id)) state.sessions.set(id, { loading: false, error: null, list: [], shown: PAGE, loaded: false });
  return state.sessions.get(id);
}

async function loadSessions(id, { force = false } = {}) {
  const s = sessionState(id);
  if (s.loaded && !force) return s;
  // AWAIT an in-flight load instead of returning the still-empty state.
  // Returning early here made applyRoute() see zero sessions whenever the
  // boot preload had started the same fetch first — and a session named in
  // the URL was then declared missing and silently dropped to the project.
  if (s.loading) return s.inflight ?? s;
  s.loading = true;
  s.error = null;
  renderTree();
  s.inflight = (async () => {
    try {
      const r = await api.projectSessions(id);
      s.list = (r.sessions ?? []).slice().sort((a, b) => String(b.lastActivityAt ?? '').localeCompare(String(a.lastActivityAt ?? '')));
      s.encodedDir = r.encodedDir ?? null;
      s.dirs = r.dirs ?? [];
      s.loaded = true;
    } catch (err) {
      s.error = err.message;
    } finally {
      s.loading = false;
      s.inflight = null;
      renderTree();
    }
    return s;
  })();
  return s.inflight;
}

function projectDot(p) {
  const s = state.sessions.get(p.id);
  // BUG-106 — the live open session belongs to state.openProjectId (its OWNER),
  // not to whatever the sidebar currently has selected. Keying the run dot to the
  // selection lit up a FOREIGN project's dot (B shows 'run' while A is the live
  // session). The owner gets the live dot; every other project falls to the
  // server-truth projectHasLive() path below. Identical when not foreign.
  if (state.live && state.openProjectId === p.id) return 'run';
  // Alive is alive wherever it happens: a collapsed project whose session is
  // being written RIGHT NOW (any process) gets the same moss dot — that is
  // "Claude is still working in here" at a glance.
  if (projectHasLive(p, s)) return 'run';
  if (s?.loaded && s.list.length === 0) return 'none';
  return '';
}

/* ═══════════════════════════ FEAT-070 — project ordering ══════════════════
 * Default: most-recently-worked at the top (lastActivityAt desc). The prior
 * decision recorded at app.js:177 rejected auto-EXPAND by recency (it rebuilt
 * the wall-of-sessions the cap exists to prevent) — a different concern from
 * ORDERING, but it names the real risk of recency here too: churn/jitter as an
 * active project shuffles to the top under the user. Reconciled per the user's
 * request: recency is the default, an explicit alpha toggle is always one click
 * away, and the order is CAPTURED and held stable within a session — only an
 * explicit refresh (loadProjects) or a sort flip re-sorts. So the sidebar does
 * not reorder itself while you work; it re-sorts when you ask it to.
 */
const PROJ_SORT_KEY = 'cs.projSort';
function loadProjSort() {
  try { return localStorage.getItem(PROJ_SORT_KEY) === 'alpha' ? 'alpha' : 'recency'; } catch { return 'recency'; }
}
const projRecency = (p) => { const t = Date.parse(p.lastActivityAt ?? ''); return Number.isFinite(t) ? t : 0; };
const projName = (p) => (p.name || '').toLowerCase();
function projLess(a, b) {
  return state.projSort === 'alpha'
    ? projName(a).localeCompare(projName(b))
    : (projRecency(b) - projRecency(a)) || projName(a).localeCompare(projName(b));
}
/** Recompute the stable display order — called ONLY on refresh or a sort flip. */
function resortProjects() {
  state.projOrder = state.projects.slice().sort(projLess).map((p) => p.id);
}
/**
 * Projects in display order. The captured `projOrder` holds within a session;
 * a project that appeared SINCE the last resort (not in the capture) floats to
 * the front by the live sort, so a brand-new project is never lost at the end.
 */
function orderedProjects() {
  const idx = new Map(state.projOrder.map((id, i) => [id, i]));
  return state.projects.slice().sort((a, b) => {
    const ia = idx.has(a.id) ? idx.get(a.id) : -1;
    const ib = idx.has(b.id) ? idx.get(b.id) : -1;
    if (ia >= 0 && ib >= 0) return ia - ib;      // both captured — hold the stable order
    if (ia < 0 && ib < 0) return projLess(a, b); // both new — live sort
    return ia < 0 ? -1 : 1;                       // a new project floats above captured ones
  });
}
/** Flip recency <-> alpha: persist, re-sort (an explicit act), repaint. */
function toggleProjSort() {
  state.projSort = state.projSort === 'alpha' ? 'recency' : 'alpha';
  try { localStorage.setItem(PROJ_SORT_KEY, state.projSort); } catch { /* private mode */ }
  resortProjects();
  paintProjSort();
  renderTree();
}
function paintProjSort() {
  if (!node.projSort) return;
  const alpha = state.projSort === 'alpha';
  node.projSort.textContent = alpha ? 'A–Z' : 'Recent';
  node.projSort.title = alpha
    ? 'Projects sorted A–Z — click for most-recent first'
    : 'Projects sorted most-recent first — click for A–Z';
  node.projSort.setAttribute('aria-label', node.projSort.title);
}

function renderTree() {
  const q = node.findInput.value.trim().toLowerCase();
  stampSeenCurrent(); // whatever is on screen is, by definition, seen
  clear(node.tree);

  if (!state.projects.length) {
    node.tree.append(el('div', { class: 'hint-row' },
      el('b', { text: 'No projects yet.' }),
      document.createTextNode(' Use '),
      el('b', { text: '+ Add project' }),
      document.createTextNode(' at the bottom to pick one of your directories — any Claude history it already has shows up straight away.')));
    return;
  }

  if (q) return renderSearch(q);

  /*
   * Recency split, not a manual archive: projects quiet for 2+ weeks fold
   * into one expandable row at the bottom. Derived state only — nothing to
   * mark, and a project un-archives itself the moment it sees activity.
   * The current project and the expanded working set always stay visible,
   * however old: "my open project vanished" is not a feature.
   */
  const ordered = orderedProjects();
  const active = ordered.filter(isActiveProject);
  const inactive = ordered.filter((p) => !isActiveProject(p));
  for (const p of active) renderProjectGroup(p);
  if (inactive.length) {
    const t = el('button', { class: 'inactive-l', 'aria-expanded': String(!!state.showInactive) },
      el('span', { class: 'tw', text: state.showInactive ? '▾' : '▸' }),
      document.createTextNode(`${inactive.length} inactive project${inactive.length === 1 ? '' : 's'}`),
      el('span', { class: 'qk', text: `quiet ${INACTIVE_AFTER_DAYS}d+` }));
    t.addEventListener('click', () => { state.showInactive = !state.showInactive; renderTree(); });
    node.tree.append(t);
    if (state.showInactive) for (const p of inactive) renderProjectGroup(p);
  }
}

const INACTIVE_AFTER_DAYS = 14;

function isActiveProject(p) {
  if (state.current.projectId === p.id) return true;
  if (state.expanded.has(p.id)) return true;
  const t = Date.parse(p.lastActivityAt ?? '');
  return Number.isFinite(t) && Date.now() - t < INACTIVE_AFTER_DAYS * 24 * 3600 * 1000;
}

function renderProjectGroup(p) {
  {
    const open = state.expanded.has(p.id);
    const s = state.sessions.get(p.id);
    const head = el('button', {
      class: 'proj',
      'aria-expanded': String(open),
      title: p.hostPath,
    });
    head.append(el('span', { class: 'tw', text: '▼' }));
    head.append(el('span', { class: `dot ${projectDot(p)}`.trim() }));
    head.append(el('span', { class: 'nm', text: p.name }));
    /*
     * BUG-138 — a project whose directory is gone says so HERE, before the user
     * spends a message finding out. The reported failure was a session that
     * showed the bare word "Error" because the directory had been renamed; the
     * server now reports `pathMissing` on the list every boot already fetches,
     * so the sidebar can name it. Clicking lands on the Directory block that
     * fixes it.
     */
    if (p.pathMissing) {
      const gone = el('span', {
        class: 'pgone', role: 'button', tabindex: '0', text: 'dir missing',
        title: `${p.hostPath} no longer exists — sessions can\u2019t start here.\nClick to point this project at its new directory (its sessions come with it).`,
      });
      gone.addEventListener('click', (e) => { e.stopPropagation(); selectProject(p.id); void drawer.open('settings'); });
      head.append(gone);
    }
    // Recency on the HEADER, so "which did I work on recently" reads at a
    // glance with nothing expanded (expansion stays a deliberate click).
    if (p.lastActivityAt) head.append(el('span', { class: 'ago', text: when(p.lastActivityAt), title: `last activity ${new Date(p.lastActivityAt).toLocaleString()}` }));
    // Ambient "running here" — visible with nothing expanded, no submenu.
    const pc = procChipText(p);
    if (pc) {
      const chip = el('span', { class: 'procn', role: 'button', tabindex: '0', text: pc, title: procChipTitle(p) });
      chip.addEventListener('click', (e) => { e.stopPropagation(); selectProject(p.id); void drawer.open('settings'); });
      head.append(chip);
    }
    // "What still needs me": sessions with activity since the user last had
    // them open. THE attention signal, so it wears the one accent colour.
    // Number only — the moss pill IS the word "new"; the tooltip spells it out.
    const fresh = unseenCount(s);
    if (fresh) head.append(el('span', { class: 'unseen', text: String(fresh), title: `${fresh} session${fresh === 1 ? '' : 's'} with activity since you last opened ${fresh === 1 ? 'it' : 'them'}` }));
    head.append(el('span', { class: 'n', text: s?.loaded ? String(s.list.length) : '' }));

    const plus = el('span', { class: 'plus', role: 'button', tabindex: '0', title: 'New session', 'aria-label': `New session in ${p.name}` });
    plus.append(iconPlus());
    plus.addEventListener('click', (e) => { e.stopPropagation(); startNew(p.id); });
    head.append(plus);

    const cog = el('span', { class: 'cog', role: 'button', tabindex: '0', title: 'Project settings', 'aria-label': `Settings for ${p.name}` });
    cog.append(iconCog());
    cog.addEventListener('click', (e) => {
      e.stopPropagation();
      selectProject(p.id);
      void drawer.open('settings');
    });
    head.append(cog);

    // FEAT-038: right-click a project → a small overflow with the one-click
    // "Onboard to Orchard" action (an occasional, per-project act, so it lives
    // in an overflow rather than adding a third always-on icon to every row).
    head.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openProjectMenu(p, e.clientX, e.clientY);
    });

    head.addEventListener('click', () => {
      if (state.expanded.has(p.id)) {
        state.expanded.delete(p.id);
        // Re-expanding should start compact again, not re-dump the whole list
        // the user just paged through — reset the reveal to the first page and
        // re-arm the FEAT-070 recency window.
        const s = state.sessions.get(p.id);
        if (s) { s.shown = PAGE; s.windowed = true; }
      } else { state.expanded.add(p.id); void loadSessions(p.id); }
      saveExpanded(); // expansion is the user's working set — it survives reloads
      selectProject(p.id, { quiet: true });
      renderTree();
    });
    // Header + sessions share a group: sticky is scoped to the group box, so
    // headers cannot pile up on each other once their project scrolls away.
    const group = el('div', { class: 'pgroup' });
    group.append(head);
    node.tree.append(group);

    const kids = el('div', { class: 'kids' });
    kids.hidden = !open;
    if (open) {
      // FEAT-073: the not-yet-sent "New session" rides at the very TOP of its
      // project, above pinned and history alike — it is where you are right now.
      const pend = pendingNewFor(p.id);
      if (pend) kids.append(sessionRow(p, pend));
      if (s?.loading) kids.append(el('div', { class: 'hint-row', text: 'reading history…' }));
      else if (s?.error) kids.append(el('div', { class: 'hint-row', text: `history unavailable: ${s.error}` }));
      // A pending row already fills the group; the "no history" note would then
      // read as a contradiction under a visible session, so suppress it there.
      else if (s?.loaded && !s.list.length) { if (!pend) kids.append(emptyProjectNote(p, s)); }
      else if (s?.loaded) {
        const v = visibleSessions(s);
        v.rows.forEach((sess, i) => {
          const row = sessionRow(p, sess);
          // A hairline under the last pinned row. The pinned block needs an
          // edge, or it just reads as "the top of the list" and the pin does
          // no work at a glance.
          if (v.pinnedCount && i === v.pinnedCount - 1 && v.rows.length > v.pinnedCount) row.classList.add('pin-last');
          kids.append(row);
        });
        if (v.hidden > 0) {
          const more = el('button', { class: 'more', text: `${v.hidden} more` });
          // FEAT-070: the first "N more" lifts the recency window (reveals older
          // sessions); it and each further click grow the reveal by a screenful.
          more.addEventListener('click', () => { s.windowed = false; s.shown += PAGE_MORE; renderTree(); });
          kids.append(more);
        }
        // BUG-085: collapse-back. Once the user has paged past the default
        // capped view (window lifted or the reveal grown), offer an in-place
        // return to the ≤6 cap — no page reload (expansion used to be one-way
        // until refresh).
        if (s.windowed === false || (s.shown ?? PAGE) > PAGE) {
          const less = el('button', { class: 'more less', text: '▴ Show less' });
          less.addEventListener('click', () => { s.windowed = true; s.shown = PAGE; renderTree(); });
          kids.append(less);
        }
      }
    }
    group.append(kids);
  }
}

/**
 * A project with no sessions is ambiguous: never used, or used under a
 * different path (a container cwd, a Windows checkout) that the logical-key
 * merge — which keys on the directory basename — could not match. Say which.
 */
function emptyProjectNote(p, s) {
  const note = el('div', { class: 'hint-row' });
  if (s.dirs && s.dirs.length) {
    const win = s.dirs.filter((d) => /^[A-Za-z]--/.test(d));
    note.append(el('b', { text: 'No session logs for this project.' }));
    note.append(document.createTextNode(
      ` Claude has ${s.dirs.length === 1 ? 'a history folder that merges' : 'history folders that merge'} with this path (${s.dirs.join(', ')}), but ${s.dirs.length === 1 ? 'it holds' : 'they hold'} no .jsonl session files`
      + (win.length === s.dirs.length
        ? ` — ${win.length === 1 ? 'it was' : 'they were'} written on the Windows side, and only non-session data (project memory) came across.`
        : '.')));
    return note;
  }
  note.append(el('b', { text: 'No Claude history found for this path.' }));
  note.append(document.createTextNode(
    ` Nothing under ~/.claude/projects matches ${shortPath(p.hostPath)} (looked for ${s.encodedDir ?? 'its encoded form'}).`
    + ' Sessions this project ran under a different path — inside a container, or on the Windows side — are indexed under that path instead,'
    + ' because history is merged on the last path segment.'));
  return note;
}

/**
 * The title this session is LISTED under. `customTitle` wins when the server
 * carries a rename in its own field rather than folding it into `displayTitle`,
 * so the sidebar, the search filter, the crown and the rename verification all
 * read the same string — a rename that only some of them saw would be exactly
 * the kind of half-applied change this app refuses to show.
 */
const rowTitle = (s) =>
  (typeof s?.customTitle === 'string' && s.customTitle ? s.customTitle : (s?.displayTitle ?? ''));

/*
 * FEAT-073 — the pending "New session" row.
 *
 * Selecting "New session" opens a not-yet-sent session (state.current with a
 * projectId but no encodedDir/sessionId). There is no on-disk session yet, so
 * renderTree — which lists server-known sessions — had nothing to show and the
 * new session was invisible in the sidebar. This synthesises a single derived
 * row for it: pinned to the TOP of its project, marked current/open. It is
 * PURELY derived from state.current, so it disappears the moment the user
 * navigates away (state.current changes → the next renderTree drops it) with no
 * orphan to clean up, and it never touches the BUG-083 draft map. Once the first
 * message sends the session becomes real: state.stationSessionId (then the
 * encodedDir/sessionId) is set, this returns null, and the real row from the
 * server list renders in its place — no duplicate, because the sentinel is never
 * added to any session list.
 */
const PENDING_NEW_ID = '__pending_new__';
function pendingNewFor(pid) {
  const c = state.current;
  // Only an EXPLICITLY-opened New session (startNew) shows the row — not every
  // project that happens to have no session on screen.
  if (state.pendingNew !== pid || !c || c.projectId !== pid) return null;
  // A real session (opened from disk, or this one once its first turn started)
  // carries a sessionId/encodedDir, or at least a live station bridge.
  if (c.sessionId != null || c.encodedDir != null || state.stationSessionId) return null;
  return {
    sessionId: PENDING_NEW_ID,
    encodedDir: null,
    displayTitle: c.title || 'New session',
    os: c.os || 'linux',
    lastActivityAt: new Date().toISOString(),
    pending: true,
  };
}

/**
 * A project's rows in display order: pinned first, then the rest, each block
 * newest-first. Ordering here rather than in loadSessions() means a pin the
 * server has just confirmed re-sorts on the next render.
 */
function orderedSessions(s) {
  const rank = (x) => (api.pinnedOf(x) ? 0 : 1);
  return (s.list ?? []).slice().sort((a, b) => rank(a) - rank(b)
    || String(b.lastActivityAt ?? '').localeCompare(String(a.lastActivityAt ?? '')));
}

/*
 * FEAT-070 — the default per-project view is a RECENCY WINDOW, not a flat 6.
 * Six sessions spanning three weeks is clutter; six from this week is the
 * working set. Sessions older than the window fold under the existing "N more"
 * (clicking it lifts the window, then reveals more — see the handler in
 * renderProjectGroup). One week keeps a normal week's work visible; it is a
 * documented constant for now (exposing it as an Appearance/sidebar setting is a
 * cheap, self-contained follow-up, noted on FEAT-070).
 */
const RECENT_WINDOW_DAYS = 7;
const withinRecentWindow = (sess) => {
  const t = Date.parse(sess?.lastActivityAt ?? '');
  return Number.isFinite(t) && (Date.now() - t) < RECENT_WINDOW_DAYS * 24 * 3600 * 1000;
};
/*
 * "Attention" = activity the user has not seen since they last had the session
 * open (the same signal `unseenCount`/the row `fresh` badge use). BUG-085: this
 * NO LONGER bypasses the ≤6 cap — a day working across a dozen sessions used to
 * make every one "attention" and explode the list past the cap. Attention now
 * only wins PRIORITY within the cap (ranked first among the visible seats) and
 * stays exempt from the recency WINDOW (an old-but-active session still competes
 * for a seat rather than being folded outright). Never-seen OLD sessions are NOT
 * attention — the 24h baseline (mirroring unseenCount) keeps them out.
 */
function isAttentionSession(sess) {
  if (!sess) return false;
  if (sess.sessionId === state.current.sessionId) return false; // the open session is always-in on its own
  const k = seenKey(sess.encodedDir, sess.sessionId);
  const base = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  return String(sess.lastActivityAt ?? '') > (state.seen.get(k) ?? base);
}
/*
 * The only session that bypasses the hard cap outright is the one open on
 * screen ("my open session vanished" is not a feature). Pins are handled
 * separately in their own always-on block (an explicit user act may exceed the
 * cap). Everything else — attention included — earns a capped seat.
 */
const isAlwaysVisible = (sess) => sess?.sessionId === state.current.sessionId;

/**
 * What the row cap actually shows. A pin hidden behind "N more" is a pin that
 * does nothing, so pinned rows are always present and the cap applies to the
 * unpinned remainder only. BUG-085: the cap is a HARD ≤6 default — the open
 * session is the single bypass; 24h attention only reorders WITHIN the cap
 * (priority for a seat), it never buys extra seats. Sessions outside the recency
 * window fold under "N more" unless attention keeps them competing. `hidden` is
 * the true number of unpinned rows off screen.
 */
function visibleSessions(s) {
  const ordered = orderedSessions(s);
  const pinned = ordered.filter((x) => api.pinnedOf(x));
  const rest = ordered.filter((x) => !api.pinnedOf(x)); // recency-ordered
  const windowed = s.windowed !== false;                // "N more" sets this false
  // The open session is the one hard-cap bypass; add it back after capping.
  const openIds = new Set(rest.filter(isAlwaysVisible).map((x) => x.sessionId));
  // The pool competing for the cap budget: everything not already always-in,
  // kept if it is within the recency window OR carries unseen attention (so an
  // old-but-active session still competes rather than being folded outright).
  // When the window is lifted by "N more", everything qualifies.
  const pool = rest.filter((x) => !openIds.has(x.sessionId)
    && (!windowed || withinRecentWindow(x) || isAttentionSession(x)));
  // Attention ranks first WITHIN the pool — a stable sort preserves recency
  // order among equals — then the HARD cap is applied.
  const ranked = pool.slice().sort((a, b) =>
    (isAttentionSession(b) ? 1 : 0) - (isAttentionSession(a) ? 1 : 0));
  const capped = ranked.slice(0, Math.max(0, s.shown));
  const keep = new Set([...openIds, ...capped.map((x) => x.sessionId)]);
  // Display in recency order — attention priority decides WHICH make the cut,
  // never the order the user reads the rows in.
  const shown = rest.filter((x) => keep.has(x.sessionId));
  return { rows: [...pinned, ...shown], pinnedCount: pinned.length, hidden: rest.length - shown.length };
}

/** Multi-line tooltip. Only states what an explicit server field says is true. */
function rowTooltip(sess, pinned, renamed) {
  const bits = [rowTitle(sess)];
  if (pinned) bits.push('Pinned — held at the top of this project');
  if (renamed) {
    const auto = api.autoTitleOf(sess);
    bits.push(auto ? `Renamed by you — was “${auto}”` : 'Renamed by you');
  }
  return bits.join('\n');
}

function sessionRow(p, sess) {
  const isWin = sess.os === 'windows';
  const pendingRow = sess.pending === true; // FEAT-073 — the not-yet-sent new session
  const active = pendingRow || state.current.sessionId === sess.sessionId;
  const pinned = !pendingRow && api.pinnedOf(sess);
  const renamed = !pendingRow && api.renamedOf(sess);
  const k = seenKey(sess.encodedDir, sess.sessionId);
  const fresh = !active
    && String(sess.lastActivityAt ?? '') > (state.seen.get(k) ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  const b = el('button', {
    class: `row${isWin ? ' win' : ''}${pendingRow ? ' pending' : ''}${pinned ? ' pinned' : ''}${renamed ? ' named' : ''}${fresh ? ' fresh' : ''}`,
    'aria-current': String(active),
    title: pendingRow ? 'New session — not sent yet' : rowTooltip(sess, pinned, renamed),
  });
  b.append(el('span', { class: 'when', text: when(sess.lastActivityAt) }));
  // BUG-086: pinned rows carry an explicit pin GLYPH (reads as "pinned"), not a
  // leading-edge bar (which reads as selection/active). Only aria-current keeps
  // the active highlight; a pinned-not-open row stays clearly un-selected. A
  // pinned-AND-open row shows the active highlight AND this marker.
  if (pinned) {
    b.append(el('span', { class: 'pin-mark', title: 'Pinned', 'aria-hidden': 'true' }, svg(MENU_ICON.pin, 11)));
  }
  b.append(document.createTextNode(rowTitle(sess)));
  // FEAT-037 P2b: an Orchard-owned (non-Claude) session names its engine — the
  // same quiet `codex` voice as the crown chip. Anthropic rows render
  // byte-identical to before (no tag, no dataset).
  if (sess.provider && sess.provider !== 'anthropic') {
    b.dataset.provider = sess.provider;
    b.append(el('span', {
      class: 'prov-tag',
      text: sess.provider === 'openai' ? 'codex' : sess.provider,
      title: 'recorded by the OpenAI Codex engine — reopening resumes the same thread',
    }));
  }
  const alive = liveInfo(sess);
  if (alive) {
    // Ambient, not an alert: the same moss dot the rest of the app uses for
    // alive, with the title carrying the only words. `drivenByDashboard` is
    // the difference between "you are running this" and "something else is".
    b.append(el('span', {
      class: `alive${alive.drivenByDashboard ? ' here' : ''}`,
      title: alive.drivenByDashboard
        ? 'running now — this dashboard is driving it'
        : 'running now — another process is writing this session',
    }));
    b.dataset.live = alive.drivenByDashboard ? 'here' : 'true';
  }
  // FEAT-073: the pending-new row IS the open session already — clicking it just
  // returns focus to the composer. It has no on-disk session, so openSession /
  // the rename·pin·delete row menu (which act on a real sessionId) don't apply.
  if (pendingRow) {
    b.addEventListener('click', () => node.prompt?.focus());
    return b;
  }
  b.addEventListener('click', () => void openSession(p, sess));

  /* Our menu, not the browser's. `contextmenu` also fires for the keyboard
     Context-Menu key, which arrives with no useful pointer coordinates — so
     that case is detected and anchored to the row instead of to (0,0). */
  b.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const byKey = e.button === -1 || (e.clientX === 0 && e.clientY === 0);
    const r = b.getBoundingClientRect();
    openRowMenu(p, sess, byKey ? r.left + 26 : e.clientX, byKey ? r.bottom - 2 : e.clientY, b);
  });
  b.addEventListener('keydown', (e) => {
    // Shift+F10 is the other standard way in, and Chrome does NOT synthesise a
    // contextmenu event for it, so it needs its own handler.
    if (!(e.shiftKey && e.key === 'F10')) return;
    e.preventDefault();
    const r = b.getBoundingClientRect();
    openRowMenu(p, sess, r.left + 26, r.bottom - 2, b);
  });
  return b;
}

/*
 * Finder query grammar. Plain text filters session titles everywhere.
 * A leading "#" scopes discord-style: while the project name is being typed
 * ("#ext"), project-name suggestions render — Enter or click completes; once
 * completed ("#external-project-J ..."), everything after searches INSIDE that
 * project only. Inactive (folded) projects are findable the same way.
 */
function parseFinderQuery(raw) {
  // Left-trim only — a TRAILING space is load-bearing here: it is how
  // completeProjectScope() signals "the project name is complete, now show
  // its whole session list" (mode 'scoped' with an empty text) rather than
  // "still typing the project name" (mode 'pickProject'). A full trim()
  // would erase that signal and make the scoped-empty view unreachable
  // (BUG-009).
  const m = /^#(\S*)(?:\s(.*))?$/.exec(raw.replace(/^\s+/, ''));
  if (!m) return { mode: 'plain', text: raw.trim().toLowerCase() };
  const name = m[1].toLowerCase();
  if (m[2] === undefined) return { mode: 'pickProject', name };
  const project = state.projects.find((x) => x.name.toLowerCase() === name)
    ?? state.projects.find((x) => x.name.toLowerCase().startsWith(name));
  return { mode: 'scoped', project: project ?? null, name, text: (m[2] ?? '').trim().toLowerCase() };
}

/** Complete "#partial" to the first matching project. Returns true if it did. */
function completeProjectScope() {
  const pq = parseFinderQuery(node.findInput.value);
  if (pq.mode !== 'pickProject') return false;
  const match = state.projects.find((x) => x.name.toLowerCase().includes(pq.name));
  if (!match) return false;
  node.findInput.value = `#${match.name} `;
  renderTree();
  return true;
}

function renderSearch(raw) {
  // Parse the LIVE input value, not the fully-trimmed `raw` gate value from
  // renderTree() — a trailing space on `raw` is the scoped-empty sentinel
  // (see parseFinderQuery) and must survive into parseFinderQuery() untouched.
  const pq = parseFinderQuery(node.findInput.value.length ? node.findInput.value : raw);

  if (pq.mode === 'pickProject') {
    const matches = state.projects.filter((x) => x.name.toLowerCase().includes(pq.name));
    node.tree.append(el('div', { class: 'found-l', text: `${matches.length} project${matches.length === 1 ? '' : 's'} — Enter to scope the search` }));
    for (const p of matches) {
      const b = el('button', { class: 'row hit', title: `Search inside ${p.name}` });
      const top = el('span', { class: 'hit-top' });
      top.append(el('span', { class: 'when', text: when(p.lastActivityAt) }));
      top.append(document.createTextNode(`#${p.name}`));
      if (!isActiveProject(p)) top.append(el('span', { class: 'in', text: '  inactive' }));
      b.append(top);
      b.addEventListener('click', () => { node.findInput.value = `#${p.name} `; node.findInput.focus(); renderTree(); });
      node.tree.append(b);
    }
    if (!matches.length) node.tree.append(el('div', { class: 'hint-row', text: 'no project by that name' }));
    return;
  }

  if (pq.mode === 'scoped' && !pq.project) {
    node.tree.append(el('div', { class: 'hint-row', text: `no project named “#${pq.name}” — backspace to see the suggestions` }));
    return;
  }

  const scopeIds = pq.mode === 'scoped' ? new Set([pq.project.id]) : null;
  const text = pq.text;
  if (scopeIds && !state.sessions.get(pq.project.id)?.loaded) void loadSessions(pq.project.id);

  const hits = [];
  for (const p of state.projects) {
    if (scopeIds && !scopeIds.has(p.id)) continue;
    const s = state.sessions.get(p.id);
    if (!s?.loaded) continue;
    for (const sess of s.list) {
      // An empty scoped query ("#proj ") lists the whole project.
      if (!text || rowTitle(sess).toLowerCase().includes(text)) hits.push({ p, sess });
      if (hits.length >= 300) break;
    }
  }
  const total = [...state.sessions.values()].filter((s) => s.loaded).reduce((n, s) => n + s.list.length, 0);
  node.tree.append(el('div', { class: 'search-section', text: 'Sessions' }));
  node.tree.append(el('div', { class: 'found-l', text:
    `${hits.length} ${scopeIds ? `in #${pq.project.name}` : `of ${total} sessions`}` }));
  if (!state.searchLoaded && !scopeIds) node.tree.append(el('div', { class: 'hint-row', text: 'indexing the rest…' }));
  for (const { p, sess } of hits) {
    const row = sessionRow(p, sess); // already carries its own .when
    if (!scopeIds) row.append(el('span', { class: 'in', text: `  ${p.name}` }));
    node.tree.append(row);
  }
  if (!hits.length && (state.searchLoaded || scopeIds)) node.tree.append(el('div', { class: 'hint-row', text: 'no titles match' }));
  renderContentSearch(node.findInput.value.trim());
}

/* ---------------------- content search (tier 2: rg, debounced as you type) */
/*
 * Titles filter immediately (tier 1, in memory). CONTENTS follow after a short
 * debounce; Enter skips that wait. The previous fetch is aborted before its
 * replacement starts, which also causes the server to terminate its rg child.
 * the server runs ripgrep over every registered project's store (measured
 * fast enough that there is no index to go stale). Prose hits rank above
 * tool/thinking hits; a hit deep-links to the exact message via locate().
 */

const CONTENT_SEARCH_DEBOUNCE_MS = 225;
const CONTENT_SEARCH_MIN = 3;
let contentSearchTimer = null;
let contentSearchAbort = null;

function scheduleContentSearch() {
  clearTimeout(contentSearchTimer);
  contentSearchTimer = null;
  contentSearchAbort?.abort();
  contentSearchAbort = null;
  const raw = node.findInput.value.trim();
  const pq = parseFinderQuery(raw);
  if (pq.mode === 'pickProject' || (pq.mode === 'scoped' && !pq.project) || pq.text.length < CONTENT_SEARCH_MIN) {
    state.contentSearch = null;
    return;
  }
  contentSearchTimer = setTimeout(() => void runContentSearch(), CONTENT_SEARCH_DEBOUNCE_MS);
}

async function runContentSearch() {
  clearTimeout(contentSearchTimer);
  contentSearchTimer = null;
  contentSearchAbort?.abort();
  const raw = node.findInput.value.trim();
  const pq = parseFinderQuery(raw);
  if (pq.mode === 'pickProject') return; // Enter completes the scope instead — see keydown
  if (pq.mode === 'scoped' && !pq.project) return say(`no project named “#${pq.name}”`, true);
  const text = pq.mode === 'scoped' ? pq.text : pq.text;
  if (text.length < CONTENT_SEARCH_MIN) return say(`type at least ${CONTENT_SEARCH_MIN} characters to search message contents`, true);
  const controller = new AbortController();
  contentSearchAbort = controller;
  const cs = { q: raw, scope: 'all', showTools: true, loading: true, error: null, result: null,
    scopedProject: pq.mode === 'scoped' ? pq.project : null, visibleGroups: 10, visibleHits: new Map() };
  state.contentSearch = cs;
  renderTree();
  try {
    cs.result = await api.searchContent(text, cs.scopedProject?.id, controller.signal);
  } catch (err) {
    if (controller.signal.aborted) return;
    cs.error = err.message;
  }
  if (controller.signal.aborted) return;
  cs.loading = false;
  if (contentSearchAbort === controller) contentSearchAbort = null;
  if (state.contentSearch === cs) renderTree();
}

function renderContentSearch(q) {
  const cs = state.contentSearch;
  if (!q) return;
  if (parseFinderQuery(q).mode === 'pickProject') return; // suggestions own the pane
  if (!cs || cs.q !== q) {
    const text = parseFinderQuery(q).text;
    node.tree.append(el('div', { class: 'search-section', text: 'Messages' }));
    node.tree.append(el('div', { class: 'hint-row cs-hint', text: text.length < CONTENT_SEARCH_MIN
      ? `Type ${CONTENT_SEARCH_MIN} characters to search messages in registered projects.`
      : 'Waiting to search messages…' }));
    return;
  }
  node.tree.append(el('div', { class: 'search-section', text: 'Messages' }));
  if (cs.loading) {
    node.tree.append(el('div', { class: 'found-l', text: 'searching message contents…' }));
    return;
  }
  if (cs.error) {
    node.tree.append(el('div', { class: 'hint-row', text: `content search failed: ${cs.error}` }));
    return;
  }
  const r = cs.result;
  const shown = r.hits
    .filter((h) => cs.showTools || h.kind === 'prose')
    .filter((h) => cs.scopedProject ? true : (cs.scope === 'all' || h.projectId === state.current.projectId));
  node.tree.append(el('div', { class: 'found-l', text:
    `${shown.length} in ${cs.scopedProject ? `#${cs.scopedProject.name} contents` : 'message contents'} · ${r.tookMs} ms${r.truncated ? ' · more exist — refine the query' : ''}` }));
  const ctl = el('div', { class: 'cs-ctl' });
  if (!cs.scopedProject) {
    const scope = el('button', { class: 'cs-pill', text: cs.scope === 'all' ? 'all projects' : `only ${currentProject()?.name ?? 'current project'}` });
    scope.addEventListener('click', () => { cs.scope = cs.scope === 'all' ? 'project' : 'all'; renderTree(); });
    ctl.append(scope);
  }
  const tools = el('button', { class: 'cs-pill', text: cs.showTools ? 'tool output shown' : 'tool output hidden' });
  tools.addEventListener('click', () => { cs.showTools = !cs.showTools; renderTree(); });
  ctl.append(tools);
  node.tree.append(ctl);
  const groups = [];
  const bySession = new Map();
  for (const h of shown) {
    const key = `${h.projectId}\0${h.encodedDir}\0${h.sessionId}`;
    let g = bySession.get(key);
    if (!g) { g = { key, hits: [] }; bySession.set(key, g); groups.push(g); }
    g.hits.push(h);
  }
  for (const g of groups.slice(0, cs.visibleGroups)) node.tree.append(searchHitGroup(g, cs));
  if (groups.length > cs.visibleGroups) {
    const more = el('button', { class: 'cs-more', text: `Show ${groups.length - cs.visibleGroups} more session${groups.length - cs.visibleGroups === 1 ? '' : 's'}` });
    more.addEventListener('click', () => { cs.visibleGroups = groups.length; renderTree(); });
    node.tree.append(more);
  }
  if (r.truncated) node.tree.append(el('div', { class: 'hint-row cs-truncated', text: 'More message matches exist than the search returned — refine the query to see them.' }));
  if (!shown.length) node.tree.append(el('div', { class: 'hint-row', text: cs.showTools ? 'nothing in message contents' : 'nothing outside tool output — try showing it' }));
}

function searchHitTitle(h) {
  const s = state.sessions.get(h.projectId);
  const row = s?.list?.find((x) => x.sessionId === h.sessionId && x.encodedDir === h.encodedDir);
  return row ? rowTitle(row) : h.sessionId.slice(0, 8);
}

function searchHitGroup(g, cs) {
  const first = g.hits[0];
  const p = state.projects.find((x) => x.id === first.projectId);
  const box = el('section', { class: 'cs-group' });
  const head = el('div', { class: 'cs-group-head' });
  head.append(el('span', { class: 'cs-group-title', text: searchHitTitle(first) }));
  head.append(el('span', { class: 'in', text: p?.name ?? first.encodedDir }));
  head.append(el('span', { class: 'when', text: when(first.timestamp) }));
  head.append(el('span', { class: 'cs-count', text: `${g.hits.length} result${g.hits.length === 1 ? '' : 's'}` }));
  box.append(head);
  const cap = cs.visibleHits.get(g.key) ?? 5;
  for (const h of g.hits.slice(0, cap)) box.append(searchHitRow(h));
  if (g.hits.length > cap) {
    const more = el('button', { class: 'cs-more nested', text: `Show ${g.hits.length - cap} more` });
    more.addEventListener('click', () => { cs.visibleHits.set(g.key, g.hits.length); renderTree(); });
    box.append(more);
  }
  return box;
}

function searchHitRow(h) {
  const b = el('button', { class: `row hit cs-hit${h.os === 'windows' ? ' win' : ''}`, title: 'Open this session at the matched message' });
  const sn = el('span', { class: 'snip' });
  /*
   * The row is one clamped line, so a long lead-in silently pushes the match
   * itself out of sight — a hit that shows no highlight reads as a wrong
   * result. Keep at most a short run-up; the match always stays visible.
   */
  const LEAD = 12; // a sidebar line holds ~38 characters: any longer a run-up clips the match
  const before = h.snippet.slice(0, h.matchStart);
  let lead = before;
  if (before.length > LEAD) {
    const tail = before.slice(-LEAD);
    lead = `…${tail.includes(' ') ? tail.replace(/^\S*\s+/, '') : tail}`; // never start on half a word
  }
  sn.append(document.createTextNode(lead));
  sn.append(el('mark', { text: h.snippet.slice(h.matchStart, h.matchEnd) }));
  sn.append(document.createTextNode(h.snippet.slice(h.matchEnd)));
  if (h.kind === 'tool') sn.append(el('span', { class: 'hit-tool', text: 'tool' }));
  b.append(sn);
  b.addEventListener('click', () => void openSearchHit(h));
  return b;
}

async function openSearchHit(h) {
  const p = state.projects.find((x) => x.id === h.projectId);
  if (!p) return say(`this hit belongs to no registered project (${h.encodedDir})`, true);
  say('locating the matched message…');
  let at = null;
  let exact = true; // declared out here: the open call below needs it after the try
  try {
    const loc = await api.searchLocate(h.encodedDir, h.sessionId, h.line);
    at = loc.index;
    exact = loc.exact !== false;
    if (!exact) say('that line is not a rendered message — opening at the nearest one before it');
  } catch (err) {
    // Includes the honest 410 when the file changed since the search ran.
    return say(`could not locate the match: ${err.message}`, true);
  }
  const s = await loadSessions(p.id);
  const sess = s.list?.find((x) => x.sessionId === h.sessionId && x.encodedDir === h.encodedDir)
    ?? { sessionId: h.sessionId, encodedDir: h.encodedDir, os: h.os, displayTitle: h.sessionId.slice(0, 8) };
  await openSession(p, sess, { at, highlightAt: exact ? at : null });
}

async function loadAllSessions() {
  if (state.searchLoaded) return;
  for (const p of state.projects) await loadSessions(p.id);
  state.searchLoaded = true;
  renderTree();
}

/* ------------------------------------------- session row context menu */
/*
 * Right-click (or Context-Menu / Shift+F10) on a sidebar session row.
 *
 * The whole point of this menu is finding a discussion again next week, so the
 * two rules it is built around are about TRUST, not convenience:
 *
 *  1. NOTHING is shown as renamed, pinned or deleted until the server has been
 *     re-read and the change is actually there. Every action here writes, then
 *     re-fetches the project's session list, then checks. A 200 with an
 *     unrecognised body is not proof; neither is a hopeful local mutation.
 *  2. Every label says what the action really does. "Fork" makes a COPY with a
 *     new id and leaves the original alone, and the panel says exactly that,
 *     including the part where nothing is copied until you send a message —
 *     because that is how this app's fork actually works.
 */

const menu = {
  view: 'root',      // root | rename | fork | delete
  p: null,           // project the row was rendered under
  sess: null,        // the row's session (re-resolved from state before every write)
  origin: null,      // element to hand focus back to
  busy: null,        // label of the in-flight write, or null
  err: null,         // the last refusal, in the server's own words where possible
  note: null,        // a non-error result that belongs in the panel
  typed: '',
  force: null,       // a 409 the server offers an override for, awaiting a second click
  pinDead: false,    // this server has no working pin route: stop offering it
  delDead: false,
};

/** The freshest copy of the row's session, after any forced list reload. */
function menuSession() {
  const st = state.sessions.get(menu.p?.id);
  const fresh = st?.list?.find((x) => x.sessionId === menu.sess?.sessionId && x.encodedDir === menu.sess?.encodedDir);
  return fresh ?? menu.sess;
}

/** Re-read the project's list from the server and return this row, or null. */
async function reread(projectId, sess) {
  await loadSessions(projectId, { force: true });
  const st = state.sessions.get(projectId);
  return st?.list?.find((x) => x.sessionId === sess.sessionId && x.encodedDir === sess.encodedDir) ?? null;
}

function openRowMenu(p, sess, x, y, origin) {
  closePops();
  menu.view = 'root';
  menu.p = p;
  menu.sess = sess;
  menu.origin = origin ?? null;
  menu.busy = null;
  menu.err = null;
  menu.note = null;
  menu.force = null;
  menu.typed = '';
  paintRowMenu();
  node.rowMenu.classList.add('open');
  placeAt(node.rowMenu, x, y);
  focusInMenu();
}

function closeRowMenu() {
  if (!node.rowMenu.classList.contains('open')) return;
  const inside = node.rowMenu.contains(document.activeElement);
  node.rowMenu.classList.remove('open');
  if (inside && menu.origin?.isConnected) menu.origin.focus();
  menu.origin = null;
}

/** First interactive thing in the panel — an item in the root menu, the field elsewhere. */
function focusInMenu() {
  const first = node.rowMenu.querySelector('input, [role="menuitem"]:not([disabled]), button:not([disabled])');
  if (first) queueMicrotask(() => first.focus());
}

/**
 * Point-anchored placement that keeps the WHOLE panel on screen. Measured after
 * the panel is displayed: a `display:none` element has zero height, and
 * clamping against zero would drop the bottom edge off the viewport for any
 * right-click near the foot of the window.
 */
function placeAt(popEl, x, y) {
  const pad = 8;
  popEl.style.bottom = '';
  popEl.style.left = '-9999px';
  popEl.style.top = '0px';
  const r = popEl.getBoundingClientRect();
  const left = Math.max(pad, Math.min(x, window.innerWidth - r.width - pad));
  let top = y;
  if (top + r.height + pad > window.innerHeight) top = y - r.height; // flip above the point
  top = Math.max(pad, Math.min(top, Math.max(pad, window.innerHeight - r.height - pad)));
  popEl.style.left = `${left}px`;
  popEl.style.top = `${top}px`;
}

/*
 * Stroke icons rather than text glyphs. The obvious characters for these
 * actions (⑂ for fork, ⌫ for delete) are exactly the sort that fall back to a
 * tofu box on a machine with different fonts, and a menu whose items are
 * unreadable is worse than one with no icons at all.
 */
const MENU_ICON = {
  rename: 'M10.4 2.9 13.1 5.6 5.5 13.2 2.2 13.8l.6-3.3z',
  pin: 'M4.6 2.6h6.8v10.8L8 10.7l-3.4 2.7z',
  fork: 'M4.4 13V3.2M4.4 6.3h4.3c1.3 0 2.4 1 2.4 2.4V13',
  copy: 'M6 6h6.6v6.6H6zM3.4 10V3.4H10',
  del: 'M3.2 4.6h9.6M6.2 4.6V3.1h3.6v1.5M4.7 4.6l.6 8.3h5.4l.6-8.3',
};

function mitem(label, icon, onPick, { hint, disabled, danger } = {}) {
  const b = el('button', {
    class: `mi${danger ? ' danger' : ''}`, role: 'menuitem', type: 'button', disabled: disabled ? true : null,
  });
  b.append(el('span', { class: 'g' }, svg(MENU_ICON[icon], 12)));
  b.append(el('span', { class: 'l', text: label }));
  if (hint) b.append(el('span', { class: 'k', text: hint }));
  if (!disabled) b.addEventListener('click', (e) => { e.stopPropagation(); onPick(); });
  return b;
}

function paintRowMenu() {
  const host = clear(node.rowMenu);
  const sess = menuSession();
  if (!sess) return closeRowMenu();
  node.rowMenu.dataset.view = menu.view;
  node.rowMenu.setAttribute('role', menu.view === 'root' ? 'menu' : 'dialog');

  const head = el('div', { class: 'mhead' });
  head.append(el('div', { class: 't', text: rowTitle(sess) }));
  head.append(el('div', { class: 's', text: `${sess.sessionId.slice(0, 8)} · ${menu.p.name}${sess.os === 'windows' ? ' · windows' : ''}` }));
  host.append(head);

  if (menu.view === 'root') paintMenuRoot(host, sess);
  else if (menu.view === 'rename') paintMenuRename(host, sess);
  else if (menu.view === 'fork') paintMenuFork(host, sess);
  else if (menu.view === 'delete') paintMenuDelete(host, sess);

  if (menu.force) host.append(forceBlock());
  if (menu.note) host.append(el('div', { class: 'mnote', text: menu.note }));
  if (menu.err) host.append(el('div', { class: 'mnote err', text: menu.err }));
}

/**
 * The server refuses a rename or a pin on a session that is being written right
 * now, and offers an override. Passing its message through and stopping would
 * hand the user a query-string flag they cannot type — so the override becomes
 * a second, deliberate click, the same arm-then-confirm the docker socket uses.
 */
function forceBlock() {
  const f = menu.force;
  const box = el('div', { class: 'mnote arm' });
  box.append(el('div', { class: 'w', text: f.message }));
  const acts = el('div', { class: 'cacts' });
  const no = el('button', { class: 'mini', type: 'button', text: 'Leave it alone' });
  no.addEventListener('click', () => { menu.force = null; menu.view = 'root'; paintRowMenu(); focusInMenu(); });
  const yes = el('button', { class: 'mini danger', type: 'button', text: f.label });
  yes.addEventListener('click', () => {
    const go = menu.force;
    menu.force = null;
    if (go.kind === 'rename') void doRename(go.title, { force: true });
    else void doPin(go.pinned, { force: true });
  });
  acts.append(no, yes);
  box.append(acts);
  return box;
}

function paintMenuRoot(host, sess) {
  const pinned = api.pinnedOf(sess);
  const busy = !!menu.busy;

  host.append(mitem('Rename…', 'rename', () => {
    menu.view = 'rename'; menu.err = null; menu.note = null; menu.force = null;
    menu.typed = rowTitle(sess);
    paintRowMenu(); focusInMenu();
  }, { disabled: busy }));

  const pinItem = mitem(
    menu.busy === 'pin' ? (pinned ? 'unpinning…' : 'pinning…') : (pinned ? 'Unpin' : 'Pin to top'),
    'pin',
    () => void doPin(!pinned),
    { disabled: busy || menu.pinDead },
  );
  // Filled bookmark when it IS pinned — the state, next to the action that undoes it.
  if (pinned) pinItem.classList.add('on');
  host.append(pinItem);

  host.append(mitem('Fork to another project…', 'fork', () => { menu.view = 'fork'; menu.err = null; menu.note = null; menu.force = null; paintRowMenu(); focusInMenu(); }, { disabled: busy }));

  host.append(mitem('Copy session id', 'copy', () => void doCopyId(sess), { hint: sess.sessionId.slice(0, 8), disabled: busy }));

  host.append(el('div', { class: 'msep' }));
  host.append(mitem('Delete…', 'del', () => { menu.view = 'delete'; menu.err = null; menu.note = null; menu.force = null; menu.typed = ''; paintRowMenu(); focusInMenu(); }, { disabled: busy || menu.delDead, danger: true }));
}

/* ------------------------------------------------------------------ rename */

function paintMenuRename(host, sess) {
  const box = el('div', { class: 'mview' });
  box.append(el('div', { class: 'mp', text: 'Sets the title this session is listed under, here and in search.' }));

  const field = el('div', { class: 'cfield' });
  const input = el('input', {
    class: 'vin', type: 'text', spellcheck: 'false', autocomplete: 'off',
    'aria-label': 'Session title', maxlength: '200',
  });
  input.value = menu.typed;
  field.append(input);
  box.append(field);

  const acts = el('div', { class: 'cacts' });
  const cancel = el('button', { class: 'mini', type: 'button', text: 'Cancel' });
  cancel.addEventListener('click', () => { menu.view = 'root'; menu.err = null; menu.force = null; paintRowMenu(); focusInMenu(); });
  const save = el('button', { class: 'mini danger', type: 'button', text: menu.busy === 'rename' ? 'renaming…' : 'Rename' });
  const ok = () => input.value.trim().length > 0 && input.value.trim() !== rowTitle(sess);
  save.disabled = !ok() || !!menu.busy;
  input.addEventListener('input', () => { menu.typed = input.value; save.disabled = !ok() || !!menu.busy; });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && ok() && !menu.busy) { e.preventDefault(); void doRename(input.value.trim()); }
  });
  save.addEventListener('click', () => { if (ok()) void doRename(input.value.trim()); });
  acts.append(cancel, save);
  box.append(acts);
  host.append(box);
  queueMicrotask(() => { input.focus(); input.select(); });
}

async function doRename(title, { force = false } = {}) {
  const sess = menuSession();
  const p = menu.p;
  menu.busy = 'rename';
  menu.err = null;
  paintRowMenu();
  try {
    await api.renameSession(sess.sessionId, sess.encodedDir, title, { force });
  } catch (err) {
    menu.busy = null;
    if (err.status === 409 && !force) {
      menu.force = { kind: 'rename', title, label: 'Rename anyway', message: err.message };
      return paintRowMenu();
    }
    menu.err = err.missing
      ? 'not renamed — this server has no session-rename route yet'
      : `not renamed — ${err.message}`;
    return paintRowMenu();
  }
  // The response body is not proof. Ask the list again and read the row back.
  const row = await reread(p.id, sess);
  menu.busy = null;
  if (!row || rowTitle(row) !== title) {
    menu.err = `not renamed — the server accepted the change but still lists this session as “${row ? rowTitle(row) : 'gone from the list'}”`;
    return paintRowMenu();
  }
  closeRowMenu();
  if (state.current.sessionId === sess.sessionId && state.current.encodedDir === sess.encodedDir) {
    state.current.title = title;
    paintCrown();
  }
  renderTree();
  say(`renamed to “${title}” · confirmed by the server`);
}

/* --------------------------------------------------------------------- pin */

async function doPin(next, { force = false } = {}) {
  const sess = menuSession();
  const p = menu.p;
  menu.busy = 'pin';
  menu.err = null;
  paintRowMenu();
  try {
    await api.setPinned(sess.sessionId, sess.encodedDir, next, { force });
  } catch (err) {
    menu.busy = null;
    if (err.status === 409 && !force) {
      menu.force = { kind: 'pin', pinned: next, label: next ? 'Pin anyway' : 'Unpin anyway', message: err.message };
      return paintRowMenu();
    }
    if (err.missing) {
      menu.pinDead = true;
      menu.err = 'nothing was pinned — this server has no pin route yet';
    } else {
      menu.err = `not ${next ? 'pinned' : 'unpinned'} — ${err.message}`;
    }
    return paintRowMenu();
  }
  const row = await reread(p.id, sess);
  menu.busy = null;
  if (!row || api.pinnedOf(row) !== next) {
    menu.pinDead = true;
    menu.err = `not ${next ? 'pinned' : 'unpinned'} — the server accepted the change but still reports this session as ${api.pinnedOf(row) ? 'pinned' : 'not pinned'}`;
    return paintRowMenu();
  }
  closeRowMenu();
  renderTree();
  say(`${next ? 'pinned' : 'unpinned'} · confirmed by the server`);
}

/* ---------------------------------------------------------------- copy id */

async function doCopyId(sess) {
  const id = sess.sessionId;
  let ok = false;
  try {
    await navigator.clipboard.writeText(id);
    ok = true;
  } catch {
    // Clipboard API refused (no permission, no focus). Fall back, and only
    // claim a copy if the fallback reports one.
    try {
      const ta = el('textarea', { style: 'position:fixed;left:-9999px;top:0' });
      ta.value = id;
      document.body.append(ta);
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    } catch { ok = false; }
  }
  closeRowMenu();
  say(ok ? `session id copied · ${id}` : `could not reach the clipboard — the id is ${id}`, !ok);
}

/* -------------------------------------------------------------------- fork */

function paintMenuFork(host, sess) {
  const box = el('div', { class: 'mview' });
  box.append(el('div', { class: 'mp' },
    el('b', { text: 'Forking makes a copy.' }),
    document.createTextNode(` The copy gets a new session id and lands in the project you pick. This session stays in ${menu.p.name} exactly as it is — nothing is moved, nothing is deleted.`)));
  box.append(el('div', { class: 'mp dim', text: 'Nothing is copied until you send the first message: picking a project arms the composer, and the fork is created when you send.' }));

  const list = el('div', { class: 'mlist' });
  for (const t of state.projects) {
    const b = el('button', { class: 'prow', type: 'button', title: t.hostPath });
    b.append(el('span', { class: 'mid' },
      el('span', { class: 'nm', text: t.name }),
      el('span', { class: 'ph', text: shortPath(t.hostPath) })));
    if (t.id === menu.p.id) b.append(el('span', { class: 'tag', text: 'same project' }));
    b.addEventListener('click', (e) => { e.stopPropagation(); void armFork(t, sess); });
    list.append(b);
  }
  box.append(list);

  const acts = el('div', { class: 'cacts' });
  const cancel = el('button', { class: 'mini', type: 'button', text: 'Cancel' });
  cancel.addEventListener('click', () => { menu.view = 'root'; menu.force = null; paintRowMenu(); focusInMenu(); });
  acts.append(cancel);
  box.append(acts);
  host.append(box);
}

/**
 * Arms a fork; it does not perform one. This app's fork is a field on the WS
 * `start` command, so the copy comes into being with the first message — which
 * is precisely what the panel and this status line say.
 */
async function armFork(target, sess) {
  const src = menu.p;
  closeRowMenu();
  await openSession(src, sess); // put the history being branched on screen first
  selectProject(target.id, { quiet: true });
  state.current.projectId = target.id;
  // The source dir must survive: it is where the transcript to stage lives, and
  // the server copies it into the target project's own store dir.
  state.current.encodedDir = sess.encodedDir;
  state.current.sessionId = sess.sessionId;
  state.current.os = 'linux';
  state.forkFrom = sess.sessionId;
  node.box.hidden = false;
  node.frozen.hidden = true;
  node.agentDone.hidden = true;
  paintCrown();
  renderTree();
  node.prompt.focus();
  say(`Forking into ${target.name} — type the first message and send to create the copy.`
    + ` Nothing has been copied yet, and the original stays in ${src.name} under ${sess.sessionId.slice(0, 8)}.`);
}

/* ------------------------------------------------------------------ delete */

/** Short enough to type deliberately, long enough that it cannot be a slip. */
const delToken = (sess) => sess.sessionId.slice(0, 8);

function paintMenuDelete(host, sess) {
  const box = el('div', { class: 'mview ceremony' });
  box.append(el('div', { class: 'ch' },
    el('b', { text: 'Delete this session?' }),
    document.createTextNode(' Its transcript leaves this dashboard and stops being resumable.')));
  box.append(el('div', { class: 'cpath', text: `${sess.encodedDir}/${sess.sessionId}.jsonl` }));
  box.append(el('div', { class: 'cwhich' },
    el('span', { text: `${sess.messageCount ?? '?'} messages` }),
    el('span', { text: `${bytes(sess.fileBytes ?? 0)}` }),
    el('span', { text: `last ${when(sess.lastActivityAt) || '—'}` })));
  box.append(el('div', { class: 'cundo' },
    el('span', { text: 'The server backs the file up before removing it and reports where. If it comes back without naming a backup, this will say so plainly rather than claiming one.' })));

  const field = el('div', { class: 'cfield' });
  const lbl = el('label', { class: 'cl' });
  lbl.append(document.createTextNode('Type '));
  lbl.append(el('code', { text: delToken(sess) }));
  lbl.append(document.createTextNode(' to confirm'));
  const input = el('input', {
    class: 'vin', type: 'text', spellcheck: 'false', autocomplete: 'off',
    'aria-label': `Type ${delToken(sess)} to confirm the delete`,
  });
  input.value = menu.typed;
  field.append(lbl, input);
  box.append(field);

  const acts = el('div', { class: 'cacts' });
  const cancel = el('button', { class: 'mini', type: 'button', text: 'Cancel' });
  cancel.addEventListener('click', () => { menu.view = 'root'; menu.typed = ''; menu.err = null; menu.force = null; paintRowMenu(); focusInMenu(); });
  const go = el('button', { class: 'mini danger', type: 'button', text: menu.busy === 'delete' ? 'deleting…' : 'Delete session' });
  const ok = () => input.value.trim() === delToken(sess);
  go.disabled = !ok() || !!menu.busy;
  input.addEventListener('input', () => { menu.typed = input.value; go.disabled = !ok() || !!menu.busy; });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && ok() && !menu.busy) { e.preventDefault(); go.click(); } });
  go.addEventListener('click', () => { if (ok()) void doDelete(); });
  acts.append(cancel, go);
  box.append(acts);
  host.append(box);
}

async function doDelete() {
  const sess = menuSession();
  const p = menu.p;
  menu.busy = 'delete';
  menu.err = null;
  paintRowMenu();

  let r;
  try {
    r = await api.deleteSession(sess.sessionId, sess.encodedDir);
  } catch (err) {
    r = { problem: err.message };
  }
  menu.busy = null;
  if (r === null) {
    menu.delDead = true;
    menu.err = 'nothing was deleted — this server has no session-delete route yet';
    return paintRowMenu();
  }
  if (r.conflict) {
    menu.err = `not deleted — ${r.message}`;
    return paintRowMenu();
  }
  if (r.problem) {
    menu.err = `not deleted — ${r.problem}`;
    return paintRowMenu();
  }
  // Success is the list no longer carrying the row, not a 200.
  const still = await reread(p.id, sess);
  if (still) {
    menu.err = 'not deleted — the server reported success but still lists this session';
    return paintRowMenu();
  }
  const backup = api.backupPathOf(r.result);
  closeRowMenu();
  if (state.current.sessionId === sess.sessionId && state.current.encodedDir === sess.encodedDir) startNew(p.id);
  renderTree();
  say(backup
    ? `deleted “${rowTitle(sess)}” · the original was ${backup.verified ? 'copied and byte-verified' : 'backed up'} to ${backup.path}`
    : `deleted “${rowTitle(sess)}” · the server did not report a backup location`, !backup);
}

/* ------------------------------------------------- menu keyboard + dismiss */

node.rowMenu.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') { // a menu is not part of the page's tab order
    e.preventDefault();
    return;
  }
  const nav = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
  if (!nav.includes(e.key)) return;
  const items = [...node.rowMenu.querySelectorAll('[role="menuitem"]:not([disabled])')];
  if (!items.length) return;
  e.preventDefault();
  const i = items.indexOf(document.activeElement);
  const n = e.key === 'Home' ? 0
    : e.key === 'End' ? items.length - 1
    : e.key === 'ArrowDown' ? (i + 1) % items.length
    : (i - 1 + items.length) % items.length;
  items[n].focus();
});

function iconPlus() {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 12 12'); s.setAttribute('width', '11'); s.setAttribute('height', '11');
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.5');
  s.setAttribute('stroke-linecap', 'round');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M6 2v8M2 6h8'); s.append(p);
  return s;
}
function iconCog() {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 12 12'); s.setAttribute('width', '11'); s.setAttribute('height', '11');
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.4');
  s.setAttribute('stroke-linecap', 'round');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M1.6 3.4h8.8M1.6 8.6h8.8'); s.append(p);
  for (const [cx, cy] of [[4, 3.4], [8, 8.6]]) {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', cx); c.setAttribute('cy', cy); c.setAttribute('r', '1.3');
    c.setAttribute('fill', 'var(--rail)'); s.append(c);
  }
  return s;
}

/* -------------------------------------------------------------- the crown */

function paintCrown() {
  const p = currentProject();
  node.where.textContent = p ? p.name : '';
  // FEAT-071 — the crown name doubles as a discoverable dir tooltip: which host
  // directory this project maps to, full path on hover (the settings drawer
  // shows the shortened form inline).
  node.where.title = p?.hostPath ? `${p.name}\n${p.hostPath}` : '';
  // FEAT-059 — the global + always spawns in the scratch project, regardless
  // of what is currently selected, so its tooltip is fixed rather than
  // following `currentProject()` the way it used to (that was the bug: it
  // read "New session in <whatever's selected>" and meant it literally).
  const newLbl = 'New scratch session — throwaway, not saved under any project (Scratch — throwaway)';
  $('#newBtn').title = newLbl;
  $('#newBtn').setAttribute('aria-label', 'New scratch session');
  paintGitChip();
  paintProcChip();
  paintIntegrations(); // FEAT-051 — the attached-capability strip tracks the project too
  paintCrumbs();

  const has = !!p;
  paintModelChip(); // FEAT-042 — chip visibility tracks project selection
  node.isoBtn.hidden = !has;
  node.insBtn.hidden = !has;
  node.sealSep.hidden = !has;
  for (const m of [...node.seal.querySelectorAll('.mnt, .addm')]) m.remove();
  if (!has) return;

  const iso = ISO_META[p.isolation] ?? ISO_META.direct;
  node.isoG.textContent = iso.g;
  node.isoN.textContent = iso.n;
  for (const o of node.pop.querySelectorAll('.opt')) {
    o.setAttribute('data-sel', o.dataset.iso === p.isolation ? 'true' : 'false');
  }

  const stack = (p.settings.instructions ?? []).filter((s) => s.enabled !== false);
  if (!stack.length) {
    node.insN.textContent = 'CLAUDE.md only';
    node.insPlus.textContent = '';
  } else {
    const names = drawer.templates();
    const first = names.find((t) => t.id === stack[0].templateId)?.name ?? stack[0].templateId;
    node.insN.textContent = first;
    node.insPlus.textContent = stack.length > 1 ? `+${stack.length - 1}` : '';
  }

  const mounts = p.settings.mounts ?? [];
  // BUG-075: mounts are a CONTAINER-only concept — bind-mounting extra host
  // paths INTO the container. A direct/sandbox session already sees the whole
  // filesystem, so neither the mount pills NOR the "+ Add mount" affordance may
  // render there (they are inert-or-confusing). Ground truth is p.isolation —
  // the SAME source the Direct/Container chip (isoN, above) and the isolation
  // say() line below read, so the two can never disagree, and the strip
  // re-renders on every session switch (line 1540 clears the old .mnt/.addm).
  if (p.isolation === 'container') {
    for (const m of mounts) {
      const pill = el('span', { class: 'pill mnt', role: 'button', tabindex: '0', title: 'Mounted into the container — click for Access › Mounts' }, document.createTextNode(shortPath(m.hostPath)));
      // FEAT-054: the pill names a mount, so it lands on the Mounts group —
      // not the drawer's default top. The × keeps its own remove action.
      pill.addEventListener('click', (e) => {
        if (e.target.closest('.x')) return;
        void drawer.open('settings', { focus: 'mounts' });
      });
      pill.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void drawer.open('settings', { focus: 'mounts' }); }
      });
      if (m.readOnly) pill.append(document.createTextNode(' '), el('span', { class: 'ro', text: 'ro' }));
      const x = el('button', { class: 'x', 'aria-label': 'Remove mount', text: '×' });
      x.addEventListener('click', async () => {
        try {
          await api.patchProject(p.id, { mounts: mounts.filter((q) => q.hostPath !== m.hostPath) });
          const fresh = await api.getProject(p.id);
          state.projects[state.projects.findIndex((x2) => x2.id === p.id)] = fresh;
          drawer.repaint();
          paintCrown();
        } catch (err) { say(`could not remove mount: ${err.message}`, true); }
      });
      pill.append(x);
      node.seal.append(pill);
    }
    const add = el('button', { class: 'pill addm', text: '+ Add mount' });
    add.addEventListener('click', () => void drawer.open('settings', { focus: 'mounts' })); // FEAT-054
    node.seal.append(add);
  }

  paintPerm();

  if (!state.busy) sayIso(isoLabel(p), '');
}

const ISO_META = {
  container: { g: '▣', n: 'Container' },
  sandbox: { g: '◑', n: 'Sandbox' },
  direct: { g: '○', n: 'Direct' },
};

/* ─────────────────────────────── FEAT-051 — integrations strip (crown) ───
 *
 * One small chip per attached MCP capability, like browser-extension icons.
 * Two honest states, never conflated:
 *
 *   planned (hollow) — no live session: what WOULD attach on the next launch,
 *     predicted from the same per-project toggles the server's
 *     plannedMcpServers() consults (browser.enabled; tools.serena default ON;
 *     tools.playwright default OFF).
 *   live (filled)    — a session is running and reported its own tool list
 *     (session-init.tools): an attached server is visible as `mcp__<name>__…`
 *     tool names. That is the CLI's OWN report of the real attach — stronger
 *     than the plan. A live session whose init we never saw (reattach) keeps
 *     the planned rendering rather than inventing a live claim.
 *
 * BUG-135 — a third state, because two were not enough to be honest. The live
 * view used to render ONLY what the running session reported, so a tool the
 * user enables MID-SESSION vanished from the strip entirely: the toggle read
 * "On", the crown showed nothing, and there was no surface anywhere saying the
 * attach is fixed at launch. (Real report: Playwright enabled on a project 33
 * minutes AFTER that project's session launched — Serena chip live from the
 * launch-time plan, Playwright nowhere.) The strip renders the UNION of planned and
 * live, so an enabled-but-not-attached tool shows as `pending`: enabled for the
 * project, arriving on the next session. The inverse (attached but no longer
 * planned) stays visible as `live` for the same reason — the running session
 * really does still have it.
 *
 * Codex (provider 'openai') gets the MCP-off honesty chip instead: the bridge
 * hands that runtime no mcpServers map (capabilities.mcpConfig === false).
 * Hidden entirely when nothing is attachable. Click → drawer Integrations.
 */
const INTEG_META = {
  'stealth-browser': { g: '⌘', n: 'Browser', use: 'real profile, stays logged in, survives bot checks' },
  serena: { g: '◆', n: 'Serena', use: 'symbol-level code navigation (LSP)' },
  playwright: { g: '▷', n: 'Playwright', use: 'clean headless browser for repeatable UI tests' },
};

/** The MCP server names a live session's tool list proves attached. */
function liveAttachedServers() {
  const tools = dockLiveTools(); // BUG-106 — a foreign dock's live attach is not the selected project's
  if (!Array.isArray(tools)) return null;
  const found = new Set();
  for (const t of tools) {
    const m = /^mcp__(.+?)__/.exec(String(t));
    if (m) found.add(m[1]);
  }
  return found;
}

/** What plannedMcpServers() would attach for this project (same rules). */
function plannedServers(p) {
  const out = [];
  if (p.settings?.browser?.enabled === true) out.push('stealth-browser');
  const tools = p.settings?.tools ?? {};
  if (tools.serena !== false) out.push('serena'); // default ON (registry defaultToolSettings)
  if (tools.playwright === true) out.push('playwright');
  return out;
}

function paintIntegrations() {
  const strip = node.integStrip;
  if (!strip) return;
  const p = currentProject();
  clear(strip);
  if (!p) { strip.hidden = true; return; }

  const live = liveAttachedServers(); // null = no live report — planned view (also null when foreign, BUG-106)
  const provider = live
    ? (dockEffective()?.provider ?? 'anthropic')
    : (state.overrides.provider ?? p.settings?.provider ?? 'anthropic');
  const mcpOff = live
    ? dockEffective()?.capabilities?.mcpConfig === false
    : provider === 'openai';

  const chips = [];
  if (mcpOff) {
    // Codex honesty: no station-attached MCP tools on this engine (yet).
    chips.push(el('span', {
      class: 'ichip off',
      role: 'button', tabindex: '0',
      'data-integ': 'mcp-off',
      title: 'This engine (OpenAI Codex) gets no station-attached MCP tools yet — browser/Serena/Playwright do not attach. Click for Integrations.',
    }, el('span', { class: 'g', text: '⌬' }), el('span', { class: 'n', text: 'MCP off' })));
  } else {
    // BUG-135 — union, not just the live report, so an enabled-but-unattached
    // tool is visible as pending instead of silently missing.
    const planned = plannedServers(p);
    const names = live
      ? [...new Set([...planned, ...[...live].filter((s2) => INTEG_META[s2])])]
      : planned;
    for (const name of names) {
      const meta = INTEG_META[name];
      if (!meta) continue;
      const attached = live ? live.has(name) : null;
      const pending = live ? !attached : false;
      chips.push(el('span', {
        class: `ichip${attached ? ' live' : ''}${pending ? ' pending' : ''}`,
        role: 'button', tabindex: '0',
        'data-integ': name,
        'data-live': String(!!attached),
        'data-pending': String(pending),
        title: `${meta.n} — ${meta.use}. ${attached
          ? 'Attached to the running session'
          : pending
            ? 'Enabled for this project, but NOT in the running session — MCP tools are fixed when a session launches. Start a new session to use it'
            : 'Attaches on the next launch'} · click for Integrations.`,
      }, el('span', { class: 'g', text: meta.g }), el('span', { class: 'n', text: meta.n })));
    }
  }

  strip.hidden = chips.length === 0;
  for (const c of chips) {
    // FEAT-054: a capability chip lands on the drawer's Integrations group.
    c.addEventListener('click', () => void drawer.open('settings', { focus: 'integrations' }));
    c.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void drawer.open('settings', { focus: 'integrations' }); }
    });
    strip.append(c);
  }
}

/* ------------------------------------------------ permission mode (skip prompts) */
/*
 * The single source of truth for "does this session ask before running tools?".
 *
 * Once a session is live the SERVER'S effective-config is authoritative — its
 * `permissionModeSource` even tells us WHY bypass is on (a container defaults to
 * it; a direct session only gets it from a deliberate override). Before a
 * session is live we predict from the same rules the server uses, and label it
 * as intent; the live report then confirms or corrects it. The UI never asserts
 * a mode the server did not report once one is running.
 */
function effectivePerm() {
  const eff = dockEffective(); // BUG-106 — foreign dock ⟹ fall back to the selected project's predicted posture
  if (eff?.effective && 'permissionMode' in eff.effective) {
    return {
      mode: eff.effective.permissionMode,
      source: eff.permissionModeSource ?? 'project',
      iso: eff.isolation ?? currentProject()?.isolation ?? 'direct',
      live: true,
    };
  }
  const p = currentProject();
  const iso = p?.isolation ?? 'direct';
  if ('permissionMode' in state.overrides) return { mode: state.overrides.permissionMode, source: 'session-override', iso, live: false };
  const stored = p?.settings?.permissionMode;
  if (stored && stored !== 'default') return { mode: stored, source: 'project', iso, live: false };
  // The server defaults a container to bypass; predict that so a container
  // session reads as "skips prompts" before it is even started.
  if (iso === 'container') return { mode: 'bypassPermissions', source: 'container-default', iso, live: false };
  return { mode: 'default', source: 'project', iso, live: false };
}

/**
 * Read the start-of-session snapshot result off the `start` ack.
 *
 * Branch on `startSnapshotStatus`, NEVER on `startSnapshotId === null`. Both
 * `disabled` and `failed` carry a null id, and conflating them produces the
 * worst possible message: a project that has deliberately turned snapshots off
 * gets told its protection FAILED. Those are opposite facts —
 *   disabled → calm, expected, chosen
 *   failed   → the one case worth interrupting someone about
 *
 * `undefined` status on a server that does not report it yet stays silent
 * rather than guessing either way.
 */
function readStartSnapshot(e) {
  const status = typeof e.startSnapshotStatus === 'string'
    ? e.startSnapshotStatus
    : (typeof e.startSnapshotId === 'string' ? 'taken' : null);
  const err = typeof e.startSnapshotError === 'string' ? e.startSnapshotError : null;
  const id = typeof e.startSnapshotId === 'string' ? e.startSnapshotId : null;
  switch (status) {
    case 'taken':
      return { status, id, protected: true, line: `snapshot ${String(id ?? '').slice(0, 12)}` };
    case 'deduped':
      // Still protected — an identical earlier snapshot is the restore point.
      return { status, id, protected: true, line: 'restore point unchanged since the last snapshot' };
    case 'disabled':
      return { status, id: null, protected: false, line: 'snapshots are off for this project' };
    case 'failed':
      return { status, id: null, protected: false, line: `NO restore point — the start snapshot failed${err ? `: ${err}` : ''}`, error: err };
    default:
      return null; // unreported — say nothing
  }
}

/** Paint the tray toggles, the composer hairline, and the seal chip together. */
function paintPerm() {
  const has = !!currentProject();
  const info = has ? effectivePerm() : null;
  const skipping = info?.mode === 'bypassPermissions';
  const planning = info?.mode === 'plan';
  const calm = skipping && info.iso === 'container'; // container is the boundary
  const risky = skipping && !calm;

  // tray toggles. `plan` and `bypassPermissions` are two values of ONE setting,
  // so both buttons are painted from the same effective mode — turning one on
  // necessarily shows the other off, and they can never both look active.
  node.skipBtn.hidden = !has;
  // aria-pressed reflects the CONFIRMED mode only. While a live change is in
  // flight the button shows a pending mark and does NOT move — the whole point
  // is that it must not look switched before the session actually switched.
  node.skipBtn.setAttribute('aria-pressed', String(!!skipping));
  node.skipBtn.dataset.risk = String(!!risky);
  // Pending has TWO honest cases: a live change awaiting the server's ack,
  // and a mode ARMED on a session that is not running right now — it takes
  // effect when the next send resumes the session. (A LIVE session switches
  // in place the moment the server confirms; no restart is ever scheduled.)
  const armedPending = !info?.live && info?.source === 'session-override';
  // An EXTERNAL follow (a terminal writes this session; the dashboard has no
  // bridge to it) can only ARM the takeover — it cannot touch the mode the
  // terminal is running under right now. Say exactly that, so the toggle never
  // reads as if it took effect on the live terminal session.
  const external = !!state.followingExternal;
  const armedNote = external
    ? ' — armed; applies ONLY if you take over this session from the dashboard (your terminal session keeps its own mode until then)'
    : ' — armed; takes effect on your next send, when the session resumes';
  node.skipBtn.dataset.pending = String(permModePending?.next === 'bypassPermissions' || (armedPending && skipping));
  node.skipBtn.dataset.external = String(external && armedPending);
  node.skipBtn.title = skipping
    ? `Permissions skipped${armedPending ? armedNote : ''} — click to require approvals`
    : external
      ? 'Skip permission prompts — this session is driven by your terminal; toggling here only applies if you take it over from the dashboard'
      : planning
        ? 'Skip permission prompts for this session (replaces plan mode)'
        : 'Skip permission prompts for this session';

  /*
   * FEAT-037 P3 — capabilities-driven degradation, not a provider check: an
   * engine without a plan mode (capabilities.planMode === false; Codex) gets
   * NO plan toggle rather than a button whose press would be refused. Absent
   * capabilities (older server, no session yet) keep the full UI — the
   * degradation only ever applies on the engine's own word.
   */
  const noPlanMode = dockEffective()?.capabilities?.planMode === false;
  node.planBtn.hidden = !has || noPlanMode;
  node.planBtn.setAttribute('aria-pressed', String(!!planning));
  node.planBtn.dataset.pending = String(permModePending?.next === 'plan' || (armedPending && planning));
  node.planBtn.dataset.external = String(external && armedPending);
  node.planBtn.title = planning
    ? `Plan mode on${armedPending ? armedNote : ''} — Claude reads and explores but cannot edit files or run mutating commands. Click to let it act.`
    : external
      ? 'Plan first — this session is driven by your terminal; toggling here only applies if you take it over from the dashboard'
      : 'Plan first — Claude reads and explores but cannot edit files or run mutating commands; it proposes a plan and waits for your approval';

  // seal chip
  node.seal.querySelector(':scope > .perm')?.remove();
  if (has) {
    // Three states, not two: "asks first" is not an honest label for plan mode,
    // where Claude cannot act at all until you approve a plan.
    const pendingChip = armedPending && (skipping || planning);
    const chipNote = pendingChip ? (external ? ' · if you take over' : ' · from next send') : '';
    const chip = el('span', { class: 'perm', role: 'button', tabindex: '0', 'data-risk': String(!!risky), 'data-skip': String(!!skipping), 'data-pending': String(pendingChip), 'data-external': String(pendingChip && external) },
      el('span', { class: 'dot' }),
      el('span', { text: (skipping ? 'skips prompts' : planning ? 'plans first' : 'asks first') + chipNote }));
    // FEAT-054: the chip names the permission mode — land on Model &
    // behaviour ▸ Permission mode instead of the drawer's default top.
    chip.addEventListener('click', () => void drawer.open('settings', { focus: 'permissionMode' }));
    chip.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void drawer.open('settings', { focus: 'permissionMode' }); }
    });
    chip.title = info.live
      ? 'Permission mode, confirmed by the running session'
      : pendingChip
        ? (external
            ? 'Armed — this session is driven by your terminal, which the dashboard only follows. It applies ONLY if you take over by sending a message here; nothing running is changed now.'
            : 'Armed for this session — it takes effect when your next message resumes it. Nothing running is interrupted.')
        : 'Permission mode (applies on next launch)';
    node.sealSep.before(chip);
  }

  // composer hairline — only when prompts are being skipped
  const line = node.permLine;
  // BUG-106 — `skipping` now comes from effectivePerm()'s dockEffective(): when the
  // sidebar selection has moved to a different project the OPEN session's live
  // posture is absent and this falls back to the SELECTED project's predicted
  // posture, so a foreign dock never asserts A's "permissions skipped · container
  // is the boundary" under B — while B's OWN predicted skip (a container B) still
  // shows. Restored to A's live posture on switch-back.
  if (!skipping) { line.hidden = true; return; }
  line.hidden = false;
  line.dataset.risk = String(!!risky);
  clear(line);
  // One dense line — the FULL sentence rides in the title so it costs no
  // vertical space while nothing is lost. Chrome must not fight the reading area.
  const full = calm
    ? (info.source === 'container-default'
        ? 'Permissions skipped — the container is the boundary here, so tools run without asking. This is the default for a container project.'
        : 'Permissions skipped — the container is the boundary here, so tools run without asking.')
    : (info.live
        ? 'Permissions skipped — this session runs commands on your machine with no approval prompt.'
        : 'Permissions skipped — the next launch runs commands on your machine with no approval prompt.');
  line.title = full;
  line.append(el('span', { class: 'g', text: risky ? '⚠' : '▣' }),
    el('b', { text: 'Permissions skipped' }),
    document.createTextNode(risky ? ' · runs commands with no prompt' : ' · container is the boundary'));
}

// FEAT-054: the composer permission hairline names the permission mode — one
// persistent element, so the deep-link listener is attached once, not per paint.
node.permLine.addEventListener('click', () => void drawer.open('settings', { focus: 'permissionMode' }));

/* ------------------------------------------------- changing permission mode */
/*
 * TWO PATHS, because there are genuinely two situations:
 *
 *   no session running  → the mode rides `overrides` on the `start` payload.
 *   session running     → it must go through the SDK's
 *                         `Query.setPermissionMode()`, which only the server can
 *                         call. The UI asks and waits for an ack.
 *
 * The old code only ever did the first. During a live session it set
 * `state.overrides.permissionMode` — which `effectivePerm()` correctly ignores,
 * because once a session is live the server's effective-config is the truth. So
 * the icon never moved, approvals kept firing, and the toast still announced
 * "permissions skipped". A control that asserts an effect it did not have is
 * the worst version of this bug, so nothing here claims a mode change until the
 * server confirms one.
 */

function setPermissionMode(next, opts = {}) {
  const p = currentProject();
  if (!p) return;
  const { mode: current, iso } = effectivePerm();
  if (next === current && !opts.force) return;

  /* ---- not started yet: overrides are the honest mechanism ---- */
  if (!state.live) {
    if (next === 'default' && iso !== 'container') delete state.overrides.permissionMode;
    else state.overrides.permissionMode = next;
    persistOverrides(); // the armed state survives a reload of the SAME session
    // An external-follow has no bridge and the terminal owns the live mode, so
    // be explicit that this only arms the takeover — it does not touch the
    // running terminal session (the app's cardinal sin is claiming otherwise).
    const scope = state.followingExternal
      ? '— armed; applies only if you take over this session from the dashboard, not to your terminal session now'
      : '— applies when this session starts';
    say(`${describeMode(next, iso)} ${scope}`, next === 'bypassPermissions' && iso !== 'container');
    paintPerm();
    paintModelBtn();
    drawer.repaintLive?.();
    return;
  }

  /* ---- live: ask the server, claim nothing yet ---- */
  if (permModePending) return say('still waiting on the last permission-mode change', true);
  const requestId = `pm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  if (!send({ type: 'set-permission-mode', requestId, mode: next })) {
    return say('permission mode unchanged — no live connection, nothing was sent', true);
  }
  permModePending = { requestId, next };
  permModePending.timer = setTimeout(() => finishPermMode(requestId, false,
    'the server never confirmed — this session is still running with the old mode'), 6000);
  say(`asking the running session to switch to ${next}…`);
  paintPerm(); // paints a pending state; aria-pressed stays on the CONFIRMED mode
}

/**
 * Settle a live mode change. `ok` comes from the server's ack — never from the
 * fact that we managed to send something.
 */
function finishPermMode(requestId, ok, why) {
  if (!permModePending || permModePending.requestId !== requestId) return;
  clearTimeout(permModePending.timer);
  const { next } = permModePending;
  permModePending = null;

  if (!ok) {
    say(`permission mode NOT changed: ${why ?? 'the server refused'}`, true);
    paintPerm();
    return;
  }
  // The server confirmed, so the live effective-config is now this. An
  // `effective-config` event may also arrive and will simply agree.
  if (state.effective?.effective) state.effective.effective.permissionMode = next;
  else state.effective = { ...(state.effective ?? {}), effective: { permissionMode: next } };
  // Mirror into the session's overrides too: after a reload this session
  // RESUMES with `start.overrides`, and it must resume in the mode the
  // server just confirmed — not silently fall back to the project default.
  if (next === 'default') delete state.overrides.permissionMode;
  else state.overrides.permissionMode = next;
  persistOverrides();
  const iso = state.effective?.isolation ?? currentProject()?.isolation ?? 'direct';
  say(`${describeMode(next, iso)} · confirmed by the server — in force for this running session`,
    next === 'bypassPermissions' && iso !== 'container');
  paintPerm();
  paintModelBtn();
  drawer.repaintLive?.();
}

/**
 * Ask the RUNNING session to switch model (BUG-026). Claims nothing until the
 * server confirms — a control that asserts an effect it did not have is the
 * worst version of this bug (same rule as setPermissionMode). `value` is the
 * picker option value: a model alias (e.g. 'haiku') or null to inherit.
 */
function setModelLive(value) {
  if (modelPending) return say('still waiting on the last model change', true);
  const requestId = `md-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  if (!send({ type: 'set-model', requestId, model: value })) {
    return say('model unchanged — no live connection, nothing was sent', true);
  }
  modelPending = { requestId, value };
  modelPending.timer = setTimeout(() => finishModel(requestId, false,
    'the server never confirmed — this session is still running with the old model'), 6000);
  say(`asking the running session to switch to ${value ?? 'the project default'}…`);
  paintModelBtn();
  paintModelPop(); // paints a pending state; the current row stays on the CONFIRMED model
}

/**
 * Settle a live model change. `ok` comes from the server's ack — never from the
 * fact that we managed to send something.
 */
function finishModel(requestId, ok, why) {
  if (!modelPending || modelPending.requestId !== requestId) return;
  clearTimeout(modelPending.timer);
  const { value } = modelPending;
  modelPending = null;

  if (!ok) {
    say(`model NOT changed: ${why ?? 'the server refused'}`, true);
    paintModelBtn();
    paintModelPop();
    return;
  }
  // The server confirmed, so the live effective-config is now this. An
  // `effective-config` event also arrives and will simply agree.
  if (state.effective?.effective) state.effective.effective.model = value;
  else state.effective = { ...(state.effective ?? {}), effective: { model: value } };
  // Mirror into the session's overrides too: after a reload this session
  // RESUMES with `start.overrides`, and it must resume on the model the server
  // just confirmed — not silently fall back to the project default.
  if (value === null) delete state.overrides.model;
  else state.overrides.model = value;
  persistOverrides();
  // FEAT-042: the user CHOSE this, so it becomes the new expectation (a later
  // per-turn report matching it must never flag). The old wire report is now
  // stale — the chip shows the confirmed value until the new model speaks.
  expectedLiveModel = value;
  liveWireModel = null;
  clearModelFlag();
  paintModelChip();
  // FEAT-045: Codex takes the model per turn/start (P2c) — there is no
  // mid-turn switch, so the honest claim is "from the next turn", not "now".
  say(providerView() === 'openai'
    ? `model: ${value ?? 'project default'} · confirmed — Codex switches at turn boundaries, so it applies from the next turn`
    : `model: ${value ?? 'project default'} · confirmed by the server — in force for this running session`);
  paintModelBtn();
  paintModelPop();
  // NB: no paintCrown() here — it re-says the isolation line when idle, which
  // would immediately STOMP the confirmation above (paintPerm/paintModelBtn are
  // enough; the crown/seal shows isolation+mounts, nothing model-related).
  drawer.repaintLive?.();
}

function describeMode(mode, iso) {
  if (mode === 'bypassPermissions') {
    return iso === 'container'
      ? 'permissions skipped — the container is the boundary'
      : 'permissions skipped — this session can run anything on your machine with no approval';
  }
  if (mode === 'plan') return 'plan mode — Claude reads and proposes, but cannot edit or run mutating commands';
  return 'permission prompts restored';
}

/** Flip skip-permissions. Live sessions go through the server. */
function toggleSkip() {
  const { mode, iso } = effectivePerm();
  if (mode === 'bypassPermissions') {
    // Turning prompts back on: a container's default IS bypass, so it needs an
    // explicit 'default' rather than simply dropping the override.
    setPermissionMode('default', { force: iso === 'container' });
  } else {
    setPermissionMode('bypassPermissions');
  }
}

/**
 * Plan mode, as a SESSION override — matching the skip toggle beside it.
 *
 * It used to `patchProject` the registry, so a single click silently changed
 * that project's default for every future session. Two adjacent, visually
 * identical toggles where only one persists is a trap; both are per-session now.
 */
/**
 * Plan mode. Confirmed to share the skip toggle's scope bug: it also only set
 * `state.overrides`, so during a live session it changed nothing and the button
 * did not move. Both toggles now go through one code path.
 */
function togglePlan() {
  const { mode, iso } = effectivePerm();
  if (mode === 'plan') {
    // A container's default is bypass, so leaving plan there needs to be
    // explicit; the skip button will light up to say what you landed on.
    setPermissionMode('default', { force: iso === 'container' });
  } else {
    // Same underlying setting as skip, so this REPLACES it rather than stacking.
    setPermissionMode('plan');
  }
}

/* ------------------------------------------------------------- transcript */
/*
 * Threads. `main` plus one per subagent, each with its own .pane section that
 * stays in the DOM. Switching threads toggles `.on` — main's live stream, open
 * tool chips and scroll position all survive a round trip into an agent.
 */

function newThread(key, meta = {}) {
  const paneEl = el('section', { class: 'pane', 'data-thread': key === 'main' ? 'main' : 'agent' });
  node.panes.append(paneEl);
  const th = {
    key,
    kind: key === 'main' ? 'main' : 'agent',
    agentId: key === 'main' ? null : key,
    agentType: meta.agentType ?? '',
    description: meta.description ?? '',
    status: meta.status ?? (key === 'main' ? 'running' : 'running'),
    stats: meta.stats ?? null,
    paneEl,
    claudeBody: null,
    stream: null,
    tools: new Map(),
    loaded: key === 'main',
    loading: false,
    /* scroll state — see the "scroll" section. stick=true means "follow the
       end"; it only ever becomes false because the USER scrolled up. */
    stick: true,
    scrollTop: 0,
    unseen: false,
    page: null, // main only: reverse-pagination cursor into the transcript
  };
  state.threads.set(key, th);
  if (th.kind === 'agent') refreshLede(th);
  return th;
}

/**
 * The one-line mono header inside an agent's pane. Rebuilt rather than written
 * once, because agent-started can arrive before we know the type/description.
 */
function refreshLede(th) {
  if (th.kind !== 'agent') return;
  refreshWaiting(th);
  let lede = th.paneEl.querySelector(':scope > .lede');
  if (!lede) {
    lede = el('div', { class: 'lede' });
    th.paneEl.prepend(lede);
  }
  clear(lede);
  lede.append(el('b', { text: th.agentType || 'agent' }));
  if (th.description) lede.append(document.createTextNode(` · ${th.description}`));
  if (th.stats) lede.append(document.createTextNode(` · ${th.stats}`));
}

/**
 * An agent thread is empty between `agent-started` and its first output. Say
 * so rather than showing a blank pane that reads like "nothing happened".
 */
function refreshWaiting(th) {
  if (th.kind !== 'agent') return;
  const hasContent = th.paneEl.querySelector('.claude, .you, .hint-row:not(.waiting)');
  let wait = th.paneEl.querySelector(':scope > .waiting');
  if (hasContent || th.status !== 'running') {
    wait?.remove();
    return;
  }
  if (!wait) {
    wait = el('div', { class: 'hint-row waiting', text: 'waiting for this agent’s first output…' });
    th.paneEl.append(wait);
  }
}

const mainThread = () => state.threads.get('main') ?? newThread('main');

/** The thread an event belongs to. Unknown agent ids get a thread on the spot. */
function threadFor(agentId) {
  if (!agentId) return mainThread();
  return state.threads.get(agentId) ?? newThread(agentId, { agentType: 'agent' });
}

const viewedThread = () => state.threads.get(state.viewing) ?? mainThread();

/*
 * BUG-083 — the composer draft belongs to the project/session it was typed in.
 * A real, on-disk session keys on its dir+id; a not-yet-sent "New session" has
 * no id, so it keys on the project (each project keeps one pending-new draft).
 */
function draftKey(cur) {
  if (!cur || cur.projectId == null) return null;
  return cur.sessionId
    ? `s\x00${cur.encodedDir ?? ''}\x00${cur.sessionId}`
    : `p\x00${cur.projectId}`;
}
/** Stash whatever is in the composer under `cur`'s key (empty clears it). */
function saveDraft(cur) {
  const key = draftKey(cur);
  if (!key) return;
  const v = node.prompt.value;
  if (v) state.drafts.set(key, v); else state.drafts.delete(key);
}
/** Put `cur`'s saved draft back into the composer — empty when there is none. */
function restoreDraft(cur) {
  const key = draftKey(cur);
  node.prompt.value = (key && state.drafts.get(key)) || '';
  autosize();
}

function resetTranscript() {
  clear(node.panes);
  /*
   * BUG-129: every session boundary passes through here, and by this point
   * state.current is ALREADY the incoming session — so drop ownership of the
   * stored rows BEFORE emptying the queue. Without this the paintQueue() below
   * would mirror an empty queue over the incoming session's own stored rows and
   * destroy them (the reverse of the bug). The outgoing session's rows stay in
   * storage, untouched, and are restored when it is opened again; adoptQueue()
   * re-takes ownership once the incoming session is on screen.
   */
  queueKey = null;
  state.outbox = null; // the outgoing session's in-flight batch is not ours to retire or resend
  state.queue.length = 0; // a queue belongs to the session being left behind
  state.followingLive = false; // the followed run belongs to the session we left
  state.followingExternal = false; // …and so does any external-follow framing
  paintQueue();
  state.threads.clear();
  state.viewing = 'main';
  state.agents.clear();
  /*
   * BUG-034 — the server's running-set snapshot belongs to the session being
   * left behind. Dropping it to null (rather than keeping the last one) is what
   * stops the outgoing session's rows from being rendered under the incoming
   * session's name for the moment before the new answer lands.
   */
  state.snap = null;
  // BUG-083 — a session boundary: any running-set poll already in flight was
  // fired under the session we are leaving. Moving the scope token makes that
  // poll drop its answer when it lands, so it can never repaint the outgoing
  // session's agents under the incoming session (ARCH-001 honesty). The strip
  // clears immediately below (renderStrip over the now-null snapshot); the
  // guard only stops a late answer from un-clearing it.
  state.snapScope++;
  // BUG-087 — the transcript-pane sibling of the strip's scope bump. Any
  // transcript fetch already in flight was fired under the session being left;
  // moving this token makes openSession drop that fetch when it lands, so a slow
  // prior-session transcript can never paint under the incoming session's header.
  state.txScope++;
  state.agentText.clear();
  clear(node.asks);
  node.asks.hidden = true;
  state.asks.clear();
  state.decisionsByRequest.clear();
  newThread('main');
  showThread('main');
  renderStrip();
  node.jump.hidden = true;
}

function youBubble(th, text) {
  th.paneEl.querySelector(':scope > .waiting')?.remove();
  const w = el('div', { class: 'you' }, el('p', { text }));
  th.paneEl.append(w);
  th.claudeBody = null;
  th.stream = null;
  return w;
}

/*
 * Per-message timestamp (user request): weightless at rest, revealed to the SIDE
 * on hover so normal reading is never crowded, but a message's real time is one
 * hover away when checking history of timings. Design decisions:
 *   - ABSOLUTE time, dated only when it is not today (datedTime → "14:32",
 *     "yesterday 14:32", "Aug 10 14:32"). The ask is auditing when things
 *     happened, not "3 minutes ago", and a conversation can span days.
 *   - NO layout shift: the <time> is absolutely positioned in the gutter beside
 *     the message (has-ts is position:relative), so revealing it never nudges a
 *     single character of the text.
 *   - Accessible WITHOUT any focus or hover (BUG-106 clean-room defect B): the old
 *     shape relied on :focus-within to "reveal" the stamp for keyboard/AT users,
 *     but nothing in a message is keyboard-focusable, so that rule was dead — the
 *     affordance could never fire. Making every bubble (or every stamp) tabbable
 *     would add one Tab stop PER message: a keyboard user tabbing past hundreds of
 *     timestamps to reach the composer is a worse experience, not a better one.
 *     The correct fix needs NO focus at all: the <time> carries an `aria-label`
 *     with the FULL, unambiguous absolute datetime (the same detail the pointer
 *     `title` tooltip shows), so a screen reader announces it in the normal reading
 *     order as it passes the message — no reveal, no interaction, no extra stop.
 *     The element stays a real <time datetime=…> in the a11y tree (opacity, never
 *     display:none); the terse visible text ("14:32") is for sighted readers and
 *     the pointer hover keeps reading uncrowded. See styles.css — the dead
 *     :focus-within reveal was removed with this change.
 *   - `iso` is the message's recorded time (ISO string) or an epoch-ms number;
 *     anything unparseable yields no stamp rather than a fake "now".
 * Returns `node` for chaining at the call site.
 */
function accessibleTimeLabel(d) {
  // A full, self-describing absolute time — weekday + full date + year + clock —
  // so an AT user hears the unambiguous moment (not the terse "14:32" the sighted
  // gutter shows, and not the machine `title` string). Falls back to the ISO
  // string if the environment has no Intl.
  try {
    return `sent ${d.toLocaleString(undefined, {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })}`;
  } catch { return `sent ${d.toISOString()}`; }
}

function stampTime(node, iso) {
  if (!node) return node;
  const ms = typeof iso === 'number' ? iso : (typeof iso === 'string' ? Date.parse(iso) : NaN);
  if (!Number.isFinite(ms)) return node;
  const d = new Date(ms);
  node.classList.add('has-ts');
  const t = el('time', {
    class: 'msg-ts',
    datetime: d.toISOString(),
    title: d.toString(),
    // BUG-106 defect B — the accessible name AT users hear, no focus/hover needed.
    'aria-label': accessibleTimeLabel(d),
  });
  t.textContent = datedTime(ms);
  node.append(t);
  return node;
}

function claudeBody(th) {
  th.paneEl.querySelector(':scope > .waiting')?.remove();
  if (th.claudeBody) return th.claudeBody;
  const av = el('div', { class: 'av' }, el('i'));
  const body = el('div', { class: 'body' });
  th.paneEl.append(el('div', { class: 'claude' }, av, body));
  th.claudeBody = body;
  return body;
}

function toolsGroup(th) {
  const body = claudeBody(th);
  const last = body.lastElementChild;
  if (last && last.classList.contains('tools')) return last;
  const g = el('div', { class: 'tools' });
  body.append(g);
  return g;
}

function ranStack(th) {
  const body = claudeBody(th);
  const last = body.lastElementChild;
  if (last && last.classList.contains('ran-stack')) return last;
  const s = el('div', { class: 'ran-stack' }, el('div', { class: 'ran-lbl', text: '' }));
  body.append(s);
  return s;
}

/**
 * BUG-100 — a turn's run summary rendered where an OUTCOME belongs: a durable
 * line at the foot of the main transcript, not the one-shot footer ticker that
 * exists to hold the isolation label. The cost carries an explicit "estimate,
 * not billed" title so the ~$ figure can never be mistaken for real spend.
 */
function appendTurnOutcome(summary, costUsd) {
  const th = mainThread();
  if (!th) return;
  const body = claudeBody(th);
  const line = el('div', { class: 'ran-lbl turn-outcome', text: summary });
  if (costUsd) {
    line.title = 'The ~$ figure is an API-equivalent ESTIMATE for this turn — not money billed to you (you run on a fixed plan).';
  }
  body.append(line);
}

function toolChip(th, name, input) {
  const chip = el('details', { class: 'tool running' });
  const res = el('span', { class: 'res', text: 'running…' });
  chip.append(el('summary', {},
    el('span', { class: 'tw', text: '▶' }),
    el('span', { class: 'nm', text: name }),
    el('span', { class: 'arg', text: toolArg(name, input) }),
    res));
  const pre = el('pre', { text: '' });
  const out = el('div', { class: 'out' });
  // Live edits show WHAT changed, same as recorded ones; the pre below still
  // receives the tool's result output as it streams.
  const diff = diffElementFor(name, input);
  if (diff) out.append(diff);
  out.append(pre);
  chip.append(out);
  toolsGroup(th).append(chip);
  if (state.viewing === th.key) scrollDown();
  return { chip, res, pre };
}

/*
 * Live markdown while streaming — the HONEST variant (FEAT-016). Instead of
 * dumping the raw buffer as textContent (so `**bold**`, list markers and ```
 * fences showed as literal syntax until the turn ended), re-parse the
 * ACCUMULATED buffer through the same tolerant prose() each frame. Completed
 * markdown (earlier bold, headings, closed fences) formats live; in-progress
 * syntax stays literal until its token closes — nothing is asserted before it
 * has happened. The reparse is THROTTLED (leading edge + one trailing render)
 * so a fast token stream does not reparse synchronously on every token; prose()
 * is sub-ms on these small buffers but the throttle keeps it off the hot path.
 */
const STREAM_RENDER_MS = 70;

function renderStreamNow(th) {
  const s = th?.stream;
  if (!s) return;
  if (s.timer) { clearTimeout(s.timer); s.timer = 0; }
  s.lastRender = Date.now();
  const fresh = prose(s.text);
  // The caret rides the end of the last rendered block, not a bare line of its
  // own, so it reads as "still typing here".
  (fresh.lastElementChild ?? fresh).append(s.caret);
  s.wrap.replaceWith(fresh);
  s.wrap = fresh;
  if (state.viewing === 'main') scrollDown();
}

function scheduleStreamRender(th) {
  const s = th?.stream;
  if (!s || s.timer) return;
  s.timer = setTimeout(() => { if (th.stream === s) { s.timer = 0; renderStreamNow(th); } }, STREAM_RENDER_MS);
}

function finishStream(th) {
  if (!th?.stream) return;
  if (th.stream.timer) clearTimeout(th.stream.timer);
  const text = th.stream.text;
  th.stream.wrap.replaceWith(prose(text));
  th.stream = null;
}

/* ----------------------------------------------------------------- scroll */
/*
 * A chat opens on its newest message. Three rules, and they interact:
 *
 *  1. STICK is a remembered intent, not a measurement taken at append time.
 *     The old scrollDown() measured "am I within 240px of the bottom?" AFTER
 *     the new content was already in the DOM, so one tall tool chip could push
 *     the distance past the threshold and silently unstick a user who had never
 *     scrolled. Stickiness is now recomputed only when the USER scrolls.
 *  2. Scrolled away means scrolled away: a live turn appends but never moves
 *     the viewport. The `Latest` pill is how you come back.
 *  3. Every thread keeps its own scrollTop, because all panes share one
 *     scroller — walking into a subagent and back must not lose main's place.
 */

const NEAR_BOTTOM_PX = 64;   // within this of the end counts as "at the bottom"
const JUMP_SHOW_PX = 260;    // don't offer "Latest" for a few lines of drift
const OLDER_TRIGGER_PX = 600; // start fetching older messages this far from the top

const atBottom = () => {
  const s = node.scroll;
  return s.scrollHeight - s.scrollTop - s.clientHeight <= NEAR_BOTTOM_PX;
};

/** Jump to the end with no animation and no intermediate frame. */
function scrollToBottom(th = viewedThread()) {
  const s = node.scroll;
  s.scrollTop = s.scrollHeight;
  th.stick = true;
  th.scrollTop = s.scrollTop;
  th.unseen = false;
  paintJump();
}

/** Follow a live append — only if the user has not scrolled away. */
function scrollDown() {
  const th = viewedThread();
  if (th.stick === false) {
    th.unseen = true;
    paintJump();
    return;
  }
  const s = node.scroll;
  s.scrollTop = s.scrollHeight;
  th.scrollTop = s.scrollTop;
}

function onScroll() {
  const th = viewedThread();
  const bottom = atBottom();
  th.stick = bottom;
  th.scrollTop = node.scroll.scrollTop;
  if (bottom) th.unseen = false;
  paintJump();
  void maybeLoadOlder();
  void maybeLoadNewer();
  syncUrlSoon();
}

function paintJump() {
  const s = node.scroll;
  const th = viewedThread();
  const away = s.scrollHeight - s.scrollTop - s.clientHeight;
  // While a forward gap is outstanding, the pill is ALWAYS offered: the bottom
  // of what is rendered is not the bottom of the session, and hiding the pill
  // there would assert "you are at the end" — the exact lie to avoid.
  const gap = th.key === 'main' && !!th.gap;
  const show = away > JUMP_SHOW_PX || gap;
  node.jump.hidden = !show;
  node.jump.classList.toggle('new', show && th.unseen === true);
}

/* ------------------------------------------------- reverse pagination */
/*
 * Only the newest TAIL_PAGE messages are fetched to open a session; older ones
 * arrive as the user scrolls up. The delicate part is the scroll anchor:
 * prepending content moves everything the user is reading DOWN by exactly the
 * height that was inserted, so scrollTop must be increased by the growth in
 * scrollHeight — measured across the mutation, in one synchronous block, so no
 * frame is painted in between.
 */

const TAIL_PAGE = 200;   // messages in the first (newest) page
const OLDER_PAGE = 120;  // messages per scroll-up page

function maybeLoadOlder() {
  const th = viewedThread();
  if (!th.page || th.page.done || th.page.loading) return;
  if (node.scroll.scrollTop > OLDER_TRIGGER_PX) return;
  return loadOlder(th);
}

/*
 * Backward paging on ONE coordinate system. `p.fetch(before, beforeBytes)` asks
 * the server for the page ending just before index `before`; `beforeBytes` is
 * the previous page's `cursorBytes`, which is what keeps this flat-cost on a
 * huge file (measured <=3 MiB/page across all 41 pages of the 286 MB session,
 * vs a tail that would re-read from the end every hop). The server's own
 * `offset`/`cursorBytes`/`hasMore` drive the walk; the client does no index
 * arithmetic, because there is nothing left to reconcile.
 */
/**
 * Backward-cursor state seeded from an opening tail response. `fetch(before,
 * beforeBytes)` is the route-specific request; everything else the server
 * reports on the first page. Shared by the main transcript and subagent threads
 * because both routes now answer with the same fields.
 */
function pageCursor(fetch, first) {
  return {
    fetch,
    oldest: first.offset,          // index of the oldest message now rendered
    cursorBytes: Number.isInteger(first.cursorBytes) ? first.cursorBytes : null,
    total: first.total,
    loading: false,
    done: first.hasMore === false || first.offset <= 0,
  };
}

async function loadOlder(th) {
  const p = th.page;
  if (!p || p.done || p.loading) return;
  p.loading = true;
  const note = el('div', { class: 'hint-row older', text: 'reading older messages\u2026' });
  prependNodes(th, [note]);
  try {
    const t = await p.fetch(p.oldest, p.cursorBytes);
    const msgs = t?.messages ?? [];
    // Anchor across BOTH mutations (note removed, page inserted) at once.
    withScrollAnchor(() => {
      note.remove();
      insertRendered(th, msgs, renderOlderInto);
    });
    // The server says where we now are; trust its answer, do not recompute it.
    p.oldest = Number.isInteger(t?.offset) ? t.offset : 0;
    p.cursorBytes = Number.isInteger(t?.cursorBytes) ? t.cursorBytes : null;
    p.done = t?.hasMore === false || p.oldest <= 0 || !msgs.length;
    if (p.done) {
      withScrollAnchor(() => {
        prependNodes(th, [el('div', { class: 'hint-row older', text: 'beginning of this session' })], false);
      });
    }
  } catch (err) {
    withScrollAnchor(() => {
      note.textContent = `could not read older messages: ${err.message}`;
      note.classList.add('bad');
    });
    p.done = true; // stop hammering a route that is failing
  } finally {
    p.loading = false;
    paintJump();
  }
}

/**
 * Run a DOM mutation that changes content ABOVE the viewport and keep the
 * user's reading position pinned. Returns whatever `mutate` returns.
 */
function withScrollAnchor(mutate) {
  const s = node.scroll;
  const before = s.scrollHeight;
  const top = s.scrollTop;
  const out = mutate();
  s.scrollTop = top + (s.scrollHeight - before);
  viewedThread().scrollTop = s.scrollTop;
  return out;
}

/** Put nodes at the top of a pane, after the agent lede if there is one. */
function prependNodes(th, nodes, anchor = true) {
  const put = () => {
    const lede = th.paneEl.querySelector(':scope > .lede');
    if (lede) lede.after(...nodes);
    else th.paneEl.prepend(...nodes);
  };
  if (anchor && th.paneEl.classList.contains('on')) withScrollAnchor(put);
  else put();
}

/**
 * renderMessages() only appends. To prepend a page, render it at the end with
 * the thread's live cursors parked, then move exactly the nodes it produced to
 * the front. Parking `claudeBody`/`stream` matters: without it an older page
 * would be poured into the CURRENT streaming message.
 */
function renderOlderInto(th, messages) {
  const savedBody = th.claudeBody;
  const savedStream = th.stream;
  th.claudeBody = null;
  th.stream = null;
  const mark = el('span', { class: 'mark' });
  th.paneEl.append(mark);
  const shown = renderMessages(th, messages);
  const moved = [];
  for (let n = mark.nextSibling; n; n = n.nextSibling) moved.push(n);
  mark.remove();
  th.claudeBody = savedBody;
  th.stream = savedStream;
  return { moved, shown };
}

function insertRendered(th, messages, render) {
  const { moved, shown } = render(th, messages);
  if (moved.length) prependNodes(th, moved, false);
  return shown;
}

/**
 * If the newest page is shorter than the viewport there is nothing to scroll,
 * so scroll-up can never fire and the rest of the session becomes unreachable.
 * Pull older pages until the scroller actually overflows.
 */
async function fillViewport(th) {
  for (let i = 0; i < 6; i++) {
    if (!th.page || th.page.done || th.page.loading) return;
    if (node.scroll.scrollHeight > node.scroll.clientHeight + OLDER_TRIGGER_PX) return;
    const before = th.page.oldest;
    await loadOlder(th);
    if (th.page.oldest === before) return; // made no progress — don't spin
    if (th.stick !== false && state.viewing === th.key) scrollToBottom(th);
  }
}

/* ------------------------------------------------ scroll <-> message index */
/*
 * Rendered content carries `data-i` markers — the absolute index (the one
 * coordinate system shared by ?tail/?offset/appends) of the stored message
 * that produced it. Two jobs only: naming the message at the top of the
 * viewport so the URL can remember it, and landing back on that message when
 * a URL carries `i`.
 */

/** Index of the message at the top of the viewport, or null when unknowable. */
function topVisibleIndex(th = viewedThread()) {
  const top = node.scroll.getBoundingClientRect().top;
  let last = null;
  for (const m of th.paneEl.querySelectorAll('[data-i]')) {
    if (m.getBoundingClientRect().bottom > top + 4) return Number(m.dataset.i);
    last = m;
  }
  return last ? Number(last.dataset.i) : null;
}

/**
 * Scroll so the message at absolute index `i` — or the nearest rendered one
 * before it — sits at the top of the viewport. Returns the marker landed on.
 */
function scrollToIndex(th, i) {
  let best = null;
  for (const m of th.paneEl.querySelectorAll('[data-i]')) {
    if (Number(m.dataset.i) <= i) best = m; // markers are in index order
    else break;
  }
  if (!best) return null;
  const s = node.scroll;
  s.scrollTop = Math.max(0, best.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop - 10);
  th.stick = atBottom();
  th.scrollTop = s.scrollTop;
  th.unseen = false;
  paintJump();
  return best;
}

/** Make a search landing unmistakable, then quietly return it to normal. */
function highlightMessageAt(th, i) {
  if (!Number.isInteger(i)) return false;
  const marks = [...th.paneEl.querySelectorAll(`[data-i="${i}"]`)];
  if (!marks.length) return false;
  for (const m of marks) m.classList.add('search-landing');
  marks[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => { for (const m of marks) m.classList.remove('search-landing'); }, 2800);
  return true;
}

/* --------------------------------------------------- forward gap (restore) */
/*
 * A session restored at a deep `i` renders a window AROUND that message, not
 * the end of the file. Everything newer than the window is a debt the view
 * owes the reader — `th.gap = {next, total}` records it, scrolling toward the
 * bottom pays it off page by page, and while any of it is outstanding the
 * composer is replaced by the #history bar and live appends are refused
 * (splicing an append after a window that is not the end would fabricate
 * adjacency). When the debt reaches zero the session hands back to the normal
 * machinery: live follow on, composer back, the pill back to meaning scroll.
 */

const NEWER_TRIGGER_PX = 600; // start fetching newer pages this far from the bottom

function maybeLoadNewer() {
  const th = viewedThread();
  if (th.key !== 'main' || !th.gap || th.gapLoading) return;
  const s = node.scroll;
  if (s.scrollHeight - s.scrollTop - s.clientHeight > NEWER_TRIGGER_PX) return;
  return loadNewer(th);
}

/*
 * Newer pages are fetched through the BACKWARD selector (`tail` ending just
 * before next+page) rather than ?offset: the forward scan stops at a 128 MiB
 * budget on huge files, the backward path reaches everything.
 */
async function loadNewer(th) {
  if (!th.gap || th.gapLoading) return;
  th.gapLoading = true;
  const { encodedDir, sessionId } = state.current;
  const note = el('div', { class: 'hint-row', text: 'reading newer messages…' });
  th.paneEl.append(note);
  try {
    const want = Math.max(1, Math.min(OLDER_PAGE, th.gap.total - th.gap.next));
    const t = await api.transcript(encodedDir, sessionId, { tail: want, before: th.gap.next + want });
    note.remove();
    // The window can overlap what is rendered when `before` was clamped.
    const fresh = (t.messages ?? []).filter((m) => Number.isInteger(m?.index) && m.index >= th.gap.next);
    finishStream(th);
    th.claudeBody = null;
    renderMessages(th, fresh);
    const last = fresh[fresh.length - 1];
    if (!fresh.length || !Number.isInteger(last?.index)) {
      th.gap = null; // nothing newer actually exists — the window was the end
    } else {
      th.lastIndex = Math.max(th.lastIndex ?? -1, last.index);
      th.gap.total = Math.max(th.gap.total, Number.isInteger(t.total) ? t.total : 0);
      th.gap.next = last.index + 1;
      if (th.page && Number.isInteger(th.page.total)) th.page.total = th.gap.total;
      if (th.gap.next >= th.gap.total) th.gap = null;
    }
    if (!th.gap) {
      followCurrent();
      if (state.viewing === th.key) paintComposerFor(th);
      if (th.agentsPending) {
        th.agentsPending = false;
        void loadRecordedAgents(th, sessionId); // deferred from the restore — see openSession
      }
      say('caught up to the latest message');
    }
    paintJump();
  } catch (err) {
    note.textContent = `could not read newer messages: ${err.message}`;
    note.classList.add('bad');
    // th.gap stays set — scrolling retries rather than silently pretending
  } finally {
    th.gapLoading = false;
  }
}

/** What the pill promises while parked in history: "Latest" means the real end. */
function reopenAtLatest() {
  const p = currentProject();
  if (!p) return;
  const cur = state.current;
  const s = state.sessions.get(cur.projectId);
  const sess = s?.list?.find((x) => x.sessionId === cur.sessionId
    && (!cur.encodedDir || x.encodedDir === cur.encodedDir))
    // Deep link opened before the sidebar list loaded — rebuild the row from
    // what the open view already knows; openSession needs nothing more.
    ?? { sessionId: cur.sessionId, encodedDir: cur.encodedDir, os: cur.os, displayTitle: cur.title ?? '' };
  void openSession(p, sess);
}

/* --------------------------------------------------------- thread viewing */

function showThread(key) {
  if (!state.threads.has(key)) return;
  const prev = state.threads.get(state.viewing);
  if (prev && prev.key !== key) {
    // Capture where the outgoing thread was BEFORE the panes swap.
    prev.scrollTop = node.scroll.scrollTop;
    prev.stick = atBottom();
  }
  state.viewing = key;
  for (const th of state.threads.values()) th.paneEl.classList.toggle('on', th.key === key);
  const th = state.threads.get(key);
  node.main.dataset.viewing = th.kind === 'agent' ? 'agent' : 'main';
  paintCrumbs();
  paintComposerFor(th);
  renderStrip();
  restoreScroll(th);
  syncUrl('replace'); // thread switches move within one session — never a history entry
}

/**
 * Put a thread back where it was. A thread that has never been scrolled away
 * from the bottom (`stick !== false`) lands at the bottom — which is also the
 * first-open case for both main and a subagent.
 */
function restoreScroll(th) {
  const s = node.scroll;
  if (th.stick === false) {
    s.scrollTop = Math.max(0, Math.min(th.scrollTop ?? 0, s.scrollHeight - s.clientHeight));
  } else {
    s.scrollTop = s.scrollHeight;
    th.scrollTop = s.scrollTop;
  }
  paintJump();
}

/** Enter a subagent thread, fetching its recorded transcript if we have none. */
async function viewAgent(agentId) {
  let th = state.threads.get(agentId);
  if (!th) th = newThread(agentId, {});
  showThread(agentId);
  if (th.loaded || th.loading) return;
  // A live agent's messages arrive over the socket; only recorded ones fetch.
  if (!state.current.sessionId) { th.loaded = true; return; }
  th.loading = true;
  const wait = el('div', { class: 'hint-row', text: 'reading this agent’s transcript…' });
  th.paneEl.append(wait);
  const dir = state.current.encodedDir ?? undefined;
  try {
    const r = await api.subagentMessagesTail(state.current.sessionId, agentId, dir, { limit: TAIL_PAGE });
    wait.remove();
    if (r === null) {
      th.paneEl.append(el('div', { class: 'hint-row' },
        el('b', { text: 'Recorded agent transcripts are not available from this server yet.' }),
        document.createTextNode(' The summary above is everything this session stored for the agent.')));
    } else {
      const n = renderMessages(th, r.messages ?? []);
      if (!n) th.paneEl.append(el('div', { class: 'hint-row', text: 'This agent recorded no readable messages.' }));
      // A long agent pages backwards exactly like main does.
      th.page = pageCursor((before, beforeBytes) =>
        api.subagentMessages(state.current.sessionId, agentId, dir, { tail: OLDER_PAGE, before, beforeBytes }), r);
    }
    // The pane was empty when it was shown, so the land-at-bottom in
    // showThread had nothing to land on. Do it now that it has content.
    if (state.viewing === agentId) {
      scrollToBottom(th);
      await fillViewport(th);
    }
  } catch (err) {
    wait.remove();
    th.paneEl.append(el('div', { class: 'hint-row', text: `could not read this agent: ${err.message}` }));
  } finally {
    th.loading = false;
    th.loaded = true;
  }
}

function backToMain() {
  if (state.viewing === 'main') return false;
  showThread('main');
  return true;
}

/** `main › general-purpose · Build UI mockup artifact` */
function paintCrumbs() {
  const th = viewedThread();
  clear(node.title);
  if (th.kind !== 'agent') {
    node.title.append(document.createTextNode(state.current.title ?? (currentProject() ? 'New session' : 'Claude Station')));
    return;
  }
  const up = el('button', { class: 'up', text: 'main', title: 'Back to the main thread (Esc)' });
  up.addEventListener('click', backToMain);
  node.title.append(up, el('span', { class: 'caret', text: '›' }), el('span', { class: 'kind', text: th.agentType || 'agent' }));
  if (th.description) {
    node.title.append(el('span', { class: 'of', text: '·' }), el('span', { class: 'desc', text: th.description }));
  }
}

/**
 * Composer targeting.
 *
 * A subagent thread is READ-ONLY, running or not. This is a property of the
 * Agent SDK, not a gap in this server: nothing in the control protocol carries
 * a message to a task, so a "reply" typed here would be delivered to the MAIN
 * thread while the UI showed it inside the agent — the precise lie this app
 * exists to avoid. So we say plainly that you can watch but not steer.
 */
function paintComposerFor(th) {
  /*
   * BUG-149: the "another tab is driving this" banner is an ADDITION to
   * whatever else the composer area is showing, not one of the mutually
   * exclusive replacements below — the composer stays usable because the
   * session can become available again at any moment. Painted first (and
   * unconditionally) so no early return below can leave it stale on screen.
   */
  node.liveElsewhereText.textContent = '';
  if (state.liveElsewhere && th.kind !== 'agent') {
    // The server's messages are lowercase (they are written for the status
    // strip). Here the same words are a sentence following a bold lead, and
    // "Open in another tab. this session is…" reads as a typo — a screenshot
    // showed it before anything else did.
    const sentence = state.liveElsewhere.charAt(0).toUpperCase() + state.liveElsewhere.slice(1);
    node.liveElsewhereText.append(
      el('b', { text: 'Open in another tab.' }),
      document.createTextNode(` ${sentence}`));
    node.liveElsewhere.hidden = false;
  } else {
    node.liveElsewhere.hidden = true;
  }
  if (state.dropped) {
    node.box.hidden = true;
    node.frozen.hidden = true;
    node.agentDone.hidden = true;
    node.historyBar.hidden = true;
    node.budgetLocked.hidden = true;
    node.dropped.hidden = false;
    return;
  }
  node.dropped.hidden = true;
  // BUG-013: a budget stop outranks every other composer state on the main
  // thread — the session is still readable, but MUST NOT look sendable, and
  // must not silently un-lock just because the user switched threads or the
  // view re-painted. Only closeSocket()/a fresh connect() clears this.
  if (state.budgetLocked && th.kind !== 'agent') {
    node.agentDone.hidden = true;
    node.box.hidden = true;
    node.frozen.hidden = true;
    node.historyBar.hidden = true;
    node.budgetLockedText.textContent = '';
    node.budgetLockedText.append(
      el('b', { text: 'Budget limit reached.' }),
      document.createTextNode(` ${state.budgetLockReason || 'this session will not send any further turns.'}`));
    node.budgetLocked.hidden = false;
    return;
  }
  node.budgetLocked.hidden = true;
  // BUG-090: the same fork bar also stands in when the server refused a plain
  // resume because the session lives under a pre-isolation store dir — a
  // one-click fork recovers it (see armNeedsFork / paintFrozenBar).
  const frozenFork = !!state.pendingFork && !state.forkFrom;
  const frozenWin = state.current.os === 'windows' && !state.forkFrom;
  const frozen = frozenWin || frozenFork;
  if (th.kind !== 'agent') {
    node.agentDone.hidden = true;
    // Parked in history (restored at a deep index, newer messages unfetched):
    // the composer would visually attach a reply to the wrong place, so the
    // #history bar stands in until the gap is paid off or "latest" is taken.
    const gap = !!th.gap;
    node.box.hidden = frozen || gap;
    node.frozen.hidden = !frozen;
    node.historyBar.hidden = frozen || !gap;
    if (frozen) paintFrozenBar(frozenFork ? state.pendingFork : null);
    node.prompt.placeholder = 'Message Claude…';
    node.prompt.disabled = false;
    return;
  }
  node.frozen.hidden = true;
  node.historyBar.hidden = true;
  const running = th.status === 'running' && state.live;
  node.box.hidden = true;
  node.agentDone.hidden = false;
  clear(node.agentDoneText);
  if (running) {
    node.agentDoneText.append(
      el('b', { text: `${th.agentType || 'This agent'} is working.` }),
      document.createTextNode(' You can watch it here, but not steer it — a subagent takes no messages, so anything you wrote would reach the main thread instead. Reply on main to change course.'));
    if (th.unsupportedReason) node.agentDoneText.append(el('span', { class: 'u', text: th.unsupportedReason }));
  } else {
    node.agentDoneText.append(
      el('b', { text: `${th.agentType || 'This agent'} has finished` }),
      document.createTextNode(`${th.stats ? ` · ${th.stats}` : ''}. Its thread is read-only.`));
  }
}

/* ------------------------------------------------------- git crown chip */
/*
 * "Is my work safe?" at a glance: branch · dirty count · ahead/behind.
 * Fetched lazily with a short TTL; hidden entirely for non-repos (the drawer's
 * Git group still offers init/create there). Clicking opens that group.
 */

const GIT_TTL_MS = 15_000;

function paintGitChip() {
  const p = currentProject();
  if (!p) { node.gitBtn.hidden = true; return; }
  const g = state.git.get(p.id);
  if (!g || (Date.now() - g.at > GIT_TTL_MS && !g.loading)) { void refreshGit(p.id); }
  const s = g?.status;
  if (!s?.repo) { node.gitBtn.hidden = true; return; }
  const bits = [s.branch ?? `detached @ ${s.detachedAt ?? '?'}`];
  if (s.dirty) bits.push(`${s.dirty} dirty`);
  clear(node.gitN);
  node.gitN.append(document.createTextNode(bits.join(' · ')));
  const added = Number.isFinite(s.added);
  const removed = Number.isFinite(s.removed);
  const showLineCounts = !(added && removed && s.added === 0 && s.removed === 0);
  const partial = s.untrackedLinesIncluded === false && showLineCounts && (added || removed);
  if (showLineCounts && added) node.gitN.append(document.createTextNode(' · '), el('span', { class: 'git-chip-added', text: `+${s.added}`, title: partial ? 'Tracked text files only; untracked lines are not included' : '' }));
  if (showLineCounts && removed) node.gitN.append(document.createTextNode(' · '), el('span', { class: 'git-chip-removed', text: `−${s.removed}` }));
  if (partial) node.gitN.append(document.createTextNode(' (tracked only)'));
  if (Number.isFinite(s.ahead) && s.ahead > 0) node.gitN.append(document.createTextNode(` · ↑${s.ahead}`));
  if (Number.isFinite(s.behind) && s.behind > 0) node.gitN.append(document.createTextNode(` · ↓${s.behind}`));
  node.gitBtn.title = `git: ${s.lastCommit ?? ''}${s.upstream ? ` · tracking ${s.upstream}` : ' · no upstream'}\nOpen the Git panel`;
  node.gitBtn.hidden = false;
}

async function refreshGit(projectId) {
  const cur = state.git.get(projectId);
  if (cur?.loading) return;
  const rec = { status: cur?.status ?? null, at: Date.now(), loading: true };
  state.git.set(projectId, rec);
  try {
    rec.status = await api.gitStatus(projectId);
  } catch { /* transient — chip keeps its last honest answer */ }
  rec.loading = false;
  rec.at = Date.now();
  if (state.current.projectId === projectId) paintGitChip();
}

// FEAT-099: the chip used to deep-link to Advanced ▸ Git in the drawer. It now
// routes to the working-tree view — per-file staging and diffs — for the
// project the chip names, so browser Back returns to the full session route.
node.gitBtn.addEventListener('click', () => navGit(currentProject()?.id));

/** Crown chip: the CURRENT project's running processes, at a glance. */
function paintProcChip() {
  const p = currentProject();
  const s = p ? state.procSummary?.[p.id] : null;
  if (!p || !s || !s.count) { node.procBtn.hidden = true; if (node.procPop.classList.contains('open')) closePops(); return; }
  // SAME grammar as the sidebar chip — ports first, then the process count.
  // (":4317 +1" in the sidebar means one more PORT; the count here includes
  // every process cwd'd in the project — the session's own CLI and its tool
  // shims among them, which is why it exceeds the port count.)
  //
  // BUG-082: the port list was dumped inline and grew unbounded (6-7+ scratch
  // ports crowded the other crown chips out). Now only the first PROC_PORT_CAP
  // ports preview inline (:4317 always first, then ascending) with a "+N"
  // overflow; the full list lives in the #procPop popover this chip opens.
  const ports = orderedPorts(s.ports);
  const shown = ports.slice(0, PROC_PORT_CAP);
  const overflow = ports.length - shown.length;
  const procTxt = `${s.count} proc${s.count === 1 ? '' : 's'}`;
  node.procN.textContent = ports.length
    ? `${shown.map((x) => `:${x}`).join(' ')}${overflow > 0 ? ` +${overflow}` : ''} · ${procTxt}`
    : procTxt;
  node.procBtn.title = procChipTitle(p);
  node.procBtn.hidden = false;
  // Keep an open popover honest with the latest poll.
  if (node.procPop.classList.contains('open')) paintProcPop();
}

/**
 * BUG-082: the FULL port list, in the shared chip-popover chrome (FEAT-051 /
 * place()/closePops()). Every listening port, in the same stable :4317-first
 * order as the inline preview; a footer that jumps to the drawer's Running-here
 * list where a port can actually be acted on.
 */
function paintProcPop() {
  const p = currentProject();
  const s = p ? state.procSummary?.[p.id] : null;
  clear(node.procPorts);
  if (!s || !s.count) return;
  const ports = orderedPorts(s.ports);
  if (ports.length) {
    for (const x of ports) {
      const row = el('div', { class: 'proc-port' });
      row.append(el('span', { class: 'pn', text: `:${x}` }));
      if (x === STATION_PORT) row.append(el('span', { class: 'pt', text: 'station' }));
      node.procPorts.append(row);
    }
  } else {
    node.procPorts.append(el('div', { class: 'grp-note', text: 'No listening ports — background processes only.' }));
  }
}

node.procBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (node.procPop.classList.contains('open')) return closePops();
  closePops();
  paintProcPop();
  place(node.procPop, node.procBtn, 200);
  node.procPop.classList.add('open');
  node.procBtn.setAttribute('aria-expanded', 'true');
});
// FEAT-054: land on Advanced ▸ Running here, not the drawer's default top.
$('#procPopSettings').addEventListener('click', () => { closePops(); void drawer.open('settings', { focus: 'processes' }); });

/* ------------------------------------------------------------- rendering */

/**
 * Claude Code writes slash commands and their output into the log as XML-ish
 * wrappers. They are machinery, not conversation — a mono caption, not a bubble.
 */
const CMD_WRAPPER = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr)>/;

function commandCaption(text) {
  if (!CMD_WRAPPER.test(text)) return null;
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim();
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
  if (name) return el('div', { class: 'ran-lbl', text: `${name.startsWith('/') ? name : `/${name}`}${args ? ` ${args}` : ''}` });
  const out = /<local-command-(?:stdout|stderr)>([\s\S]*?)<\/local-command-(?:stdout|stderr)>/.exec(text)?.[1]?.trim() ?? text;
  const flat = out.replace(/\x1b?\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim();
  if (!flat) return el('div', { class: 'ran-lbl', text: '(command produced no output)' });
  return el('div', { class: 'ran-lbl', text: flat.length > 140 ? `${flat.slice(0, 140)}…` : flat });
}

/**
 * BUG-028 — honest attribution for a shutdown-cut turn. The Claude CLI writes
 * the literal "[Request interrupted by user]" (or "…for tool use]") into the
 * transcript BOTH for a real user stop AND when the CLI itself was shut down
 * mid-turn (a server restart/redeploy — the FEAT-015 event class). The entry
 * itself says which: a real user stop carries `interruptedMessageId`; a
 * shutdown-cut entry carries `interruptedByShutdown: true` (verified against
 * live transcripts — 181 user-stop vs 45 shutdown entries, zero overlap; the
 * server passes the flag through in TranscriptMessage). Rendering the shutdown
 * case as a USER bubble asserts a false cause — the user did nothing. It gets
 * a system caption naming the real cause instead; a genuine user stop (no
 * flag) still renders as the user's own bubble, so the honest case is intact.
 */
const INTERRUPT_MARKER_RX = /^\s*\[Request interrupted by user( for tool use)?\]\s*$/;
const SHUTDOWN_BREAK_TEXT = '[Turn interrupted — the server restarted or shut down mid-turn, not a user stop; the thread resumed from its saved transcript]';
function shutdownBreakCaption(m, text) {
  if (m.interruptedByShutdown !== true || !INTERRUPT_MARKER_RX.test(text)) return null;
  return el('div', { class: 'ran-lbl shutdown-break', text: SHUTDOWN_BREAK_TEXT });
}

/*
 * BUG-067 — harness-injected user-role lines are NOT the user's words. When a
 * background agent finishes, the "[station] While you were away…" briefing
 * fires (FEAT-057), or a <system-reminder>/<task-notification> is injected, the
 * CLI writes it into the transcript as a role:user entry. Rendering that as a
 * user bubble puts a wall of XML in the user's mouth (the reported symptom).
 *
 * We recognise these by their KNOWN sentinels, matched ONLY at position 0 of
 * the left-trimmed text — so a real user message that merely QUOTES
 * "<task-notification>" (or any sentinel) mid-sentence never matches and keeps
 * its bubble. Leading whitespace is tolerated (the CLI sometimes prefixes a
 * newline) because that does not change authorship; anything before the
 * sentinel means a human wrote around it, which is a real message.
 */
const HARNESS_SENTINELS = [
  '[SYSTEM NOTIFICATION - NOT USER INPUT]',
  '<task-notification>',
  '<system-reminder>',
  '[station]',
];

/** Detect a harness notice; returns { one, full } or null for a real message. */
function harnessNotice(text) {
  if (typeof text !== 'string') return null;
  const t = text.replace(/^\s+/, '');
  if (!HARNESS_SENTINELS.some((s) => t.startsWith(s))) return null;
  return { one: harnessOneLiner(t), full: text };
}

/** Best-effort one-liner for the collapsed notice; parses task-notification. */
function harnessOneLiner(t) {
  // A task-notification block (often wrapped by the SYSTEM NOTIFICATION
  // preamble) carries the interesting fields — surface summary/status when
  // present, falling back to description/id, so the collapsed row is readable.
  if (t.includes('<task-notification>')) {
    const tag = (n) => new RegExp(`<${n}>([\\s\\S]*?)</${n}>`).exec(t)?.[1]?.replace(/\s+/g, ' ').trim();
    const what = tag('summary') || tag('description') || tag('agent-name') || tag('agentType');
    const status = tag('status');
    const id = tag('task-id') || tag('agent-id');
    const label = what || (id ? `task ${id}` : 'a background agent');
    return `⚙ background agent finished — ${label}${status ? ` (${status})` : ''}`;
  }
  if (t.startsWith('[station]')) {
    const first = t.split('\n')[0].replace(/^\[station\]\s*/, '').trim();
    return `⚙ ${first || 'station briefing'}`;
  }
  if (t.startsWith('<system-reminder>')) return '⚙ system reminder';
  return '⚙ system notification';
}

/**
 * The collapsed station-style notice: a distinct, non-bubble row whose summary
 * is the one-liner and whose disclosure reveals the full injected payload. Like
 * youBubble/captions it is a user-side turn boundary, so it closes any open
 * Claude body/stream.
 */
function noticeChip(th, notice) {
  th.paneEl.querySelector(':scope > .waiting')?.remove();
  const det = el('details', { class: 'notice' });
  det.append(el('summary', {},
    el('span', { class: 'tw', text: '▶' }),
    el('span', { class: 'nl', text: notice.one })));
  det.append(el('pre', { class: 'notice-full', text: notice.full }));
  th.paneEl.append(det);
  th.claudeBody = null;
  th.stream = null;
  return det;
}

/*
 * FEAT-072 — a queued/batch-delivered user message arrives with a bracketed
 * harness metadata prefix at position 0, always in one of a few fixed shapes:
 *   [msg N/M · queued 1m46s ago, composed while the previous response was still being written]
 *   [Queued Ns ago, composed while the previous response was still being written — it predates…]
 * The bracket is boilerplate the eye has to skip every time to find the real
 * words. This is a SIBLING of BUG-067's harnessNotice: that path replaces the
 * whole bubble for a fully-injected line; here the line is a REAL user message
 * that merely wears a metadata hat, so we peel the hat off into a dim caption
 * and keep the user's actual words in a normal bubble below.
 *
 * Conservative by construction: only a bracket at position 0 (leading
 * whitespace tolerated) whose INNER content matches the known queued-metadata
 * phrasing — the strong, always-present "composed while the previous response",
 * or a "queued … ago" pair. A real message that merely opens with "[" (a
 * markdown link, a code snippet, "[queued for review]") never matches, because
 * none of those carry that phrasing.
 */
const QUEUED_META_RX = /composed while the previous response|queued\b[^\]]*\bago\b/i;
function queuedCaption(text) {
  if (typeof text !== 'string') return null;
  const m = /^\s*\[([^\]]{1,400})\]/.exec(text);
  if (!m) return null;
  if (!QUEUED_META_RX.test(m[1])) return null;
  const body = text.slice(m[0].length).replace(/^\s+/, '');
  return { caption: m[1].trim(), body };
}

/**
 * The dim queued-metadata caption: a small, right-aligned mono line that sits
 * directly above the user's bubble (they share the message index), reading as a
 * quiet timestamp the eye skips rather than as part of the message. Like
 * youBubble it is a user-side turn boundary, so it closes any open Claude body.
 */
function queuedCap(th, capText) {
  th.paneEl.querySelector(':scope > .waiting')?.remove();
  const c = el('div', { class: 'qmeta' }, el('span', { class: 'qmeta-txt', text: capText }));
  th.paneEl.append(c);
  th.claudeBody = null;
  th.stream = null;
  return c;
}

/** A collapsed hairline chip for a stored tool call or thinking block. */
function historyChip(th, name, arg, res, body, input = null) {
  const chip = el('details', { class: 'tool' });
  chip.append(el('summary', {},
    el('span', { class: 'tw', text: '▶' }),
    el('span', { class: 'nm', text: name }),
    el('span', { class: 'arg', text: arg }),
    el('span', { class: 'res', text: res })));
  const out = el('div', { class: 'out' });
  const diff = diffElementFor(name, input);
  if (diff) out.append(diff);
  else out.append(el('pre', { text: body }));
  chip.append(out);
  toolsGroup(th).append(chip);
  return chip;
}

/* ------------------------------------------------------------ edit diffs */
/*
 * Edit/Write chips expand into the CHANGE, not the raw JSON envelope — the
 * envelope buries the one thing worth reading (what changed) in escaping.
 * Palette rule holds for transcript diffs. Git surfaces explicitly use the
 * existing semantic done/high tokens for conventional green/red scanability.
 */

const DIFF_MAX_LINES = 400;

/** Trim lines common to both ends so only the changed middle renders. */
function trimmedDiff(oldStr, newStr) {
  const a = String(oldStr ?? '').split('\n');
  const b = String(newStr ?? '').split('\n');
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let post = 0;
  while (post < a.length - pre && post < b.length - pre && a[a.length - 1 - post] === b[b.length - 1 - post]) post++;
  return { del: a.slice(pre, a.length - post), add: b.slice(pre, b.length - post), context: pre + post };
}

function diffLines(box, lines, cls, sign) {
  for (const l of lines.slice(0, DIFF_MAX_LINES)) {
    box.append(el('div', { class: `dl ${cls}` }, el('span', { class: 'sg', text: sign }), document.createTextNode(l || ' ')));
  }
  if (lines.length > DIFF_MAX_LINES) {
    box.append(el('div', { class: 'dl more', text: `… ${lines.length - DIFF_MAX_LINES} more line${lines.length - DIFF_MAX_LINES === 1 ? '' : 's'}` }));
  }
}

/** A rendered change for Edit/MultiEdit/Write inputs, or null to keep raw JSON. */
function diffElementFor(name, input) {
  if (!input || typeof input !== 'object') return null;
  const box = el('div', { class: 'diff' });
  const one = (o) => {
    if (typeof o?.old_string !== 'string' || typeof o?.new_string !== 'string') return false;
    const d = trimmedDiff(o.old_string, o.new_string);
    diffLines(box, d.del, 'del', '-');
    diffLines(box, d.add, 'add', '+');
    if (o.replace_all) box.append(el('div', { class: 'dl more', text: 'applied to every occurrence (replace_all)' }));
    return true;
  };
  if (name === 'Edit') {
    if (!one(input)) return null;
  } else if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    let any = false;
    input.edits.forEach((e, i) => {
      if (i) box.append(el('div', { class: 'dl more', text: `— edit ${i + 1} —` }));
      any = one(e) || any;
    });
    if (!any) return null;
  } else if ((name === 'Write' || name === 'NotebookEdit') && typeof input.content === 'string') {
    diffLines(box, String(input.content).split('\n'), 'add', '+');
  } else if (name === 'Write' && typeof input.new_source === 'string') {
    diffLines(box, String(input.new_source).split('\n'), 'add', '+');
  } else {
    return null;
  }
  return box;
}

/**
 * Render stored messages into a thread. Blocks are emitted in their recorded
 * order so prose and tool chips interleave the way they actually happened.
 * Used for both the main transcript and a recorded subagent thread — the
 * contract says the shapes are identical, so this renderer is shared.
 */
function renderMessages(th, messages) {
  let shown = 0;
  for (const m of messages) {
    const useful = (m.blocks ?? []).filter(
      (b) => (b.type === 'text' && b.text?.trim()) || b.type === 'tool_use' || (b.type === 'thinking' && b.text?.trim()),
    );
    if (!useful.length) continue;
    shown++;
    // Marker for the scroll<->index mapping: the element(s) this stored message
    // produced carry its absolute index, so the URL can name — and later land
    // on — "the message at the top of the viewport".
    const mark = Number.isInteger(m.index)
      ? (n) => { if (n) n.dataset.i = String(m.index); return n; }
      : (n) => n;
    if (m.role === 'user') {
      for (const b of useful) {
        if (b.type !== 'text') continue;
        // BUG-028: a shutdown-cut interrupt marker is NOT the user's message —
        // caption it with its real cause instead of putting words (a stop) in
        // the user's mouth. Checked before commandCaption; both return captions.
        const cap = shutdownBreakCaption(m, b.text) ?? commandCaption(b.text);
        if (cap) { th.paneEl.append(mark(cap)); th.claudeBody = null; }
        else {
          // BUG-067: harness-injected notices (task-notification / [station] /
          // <system-reminder> / SYSTEM NOTIFICATION) are not the user's words —
          // render a collapsed system notice, not a user bubble.
          const notice = harnessNotice(b.text);
          if (notice) mark(noticeChip(th, notice));
          else {
            // FEAT-072: a real user message wearing a queued-metadata prefix —
            // peel the prefix into a dim caption, keep the words in the bubble.
            const q = queuedCaption(b.text);
            if (q) {
              mark(queuedCap(th, q.caption));
              if (q.body) stampTime(mark(youBubble(th, q.body)), m.timestamp);
            } else {
              stampTime(mark(youBubble(th, b.text)), m.timestamp);
            }
          }
        }
      }
      continue;
    }
    const body = claudeBody(th);
    for (const b of useful) {
      if (b.type === 'text') { body.append(stampTime(mark(assistantProse(b.text)), m.timestamp)); continue; }
      if (b.type === 'thinking') {
        mark(historyChip(th, 'thinking', '', `${b.text.length.toLocaleString()} chars`, b.text));
        continue;
      }
      // tool_use: `text` is the JSON-serialised input. Show the same one-line
      // summary the live path shows, with the raw input available on expand.
      let input = null;
      try { input = JSON.parse(b.text ?? 'null'); } catch { input = b.text ?? null; }
      const name = b.toolName ?? 'tool';
      let pretty = b.text ?? '';
      try { pretty = JSON.stringify(input, null, 2); } catch { /* keep raw */ }
      mark(historyChip(th, name, toolArg(name, input), b.truncated ? 'truncated' : '', pretty || 'No recorded input.', b.truncated ? null : input));
    }
  }
  return shown;
}

/* ---------------------------------------------- recorded subagent threads */

function agentStats(a) {
  const u = a.usage ?? {};
  const ms = u.duration_ms ?? (a.endedAt && a.startedAt ? Date.parse(a.endedAt) - Date.parse(a.startedAt) : 0);
  const tools = u.tool_uses ?? 0;
  return `${mmss(ms || 0)} · ${tools} tool${tools === 1 ? '' : 's'} · ${kilo(u.total_tokens ?? 0)}`;
}

/** One hairline row that both summarises an agent and opens its thread. */
function ranRow(th, { agentId, agentType, description, status, stats, body }, opts = {}) {
  const det = el('details', { class: 'ran' });
  const open = el('span', { class: 'open', text: 'open ›' });
  const summary = el('summary', {},
    el('span', { class: 'tw', text: '▶' }),
    el('span', { class: 'ty', text: agentType || 'agent' }),
    el('span', { class: 'de', text: description || '' }),
    el('span', { class: 'stats', text: stats }),
    open);
  det.append(summary);
  det.append(body);
  // The disclosure triangle expands the summary in place; the `open ›` chip and
  // the agent type switch the pane into the agent's own thread.
  const enter = (e) => {
    e.preventDefault();
    e.stopPropagation();
    void viewAgent(agentId);
  };
  open.addEventListener('click', enter);
  summary.querySelector('.ty').addEventListener('click', enter);
  ranStack(th).append(det);
  if (!opts.silent) {
    const stack = det.parentElement;
    const n = stack.querySelectorAll('.ran').length;
    stack.querySelector('.ran-lbl').textContent = `${n} agent${n === 1 ? '' : 's'} ran in this session`;
  }
  return det;
}

/** After a historical transcript loads, hang the recorded agents off the end. */
async function loadRecordedAgents(th, sessionId) {
  let list;
  try {
    list = await api.sessionSubagents(sessionId, state.current.encodedDir ?? undefined);
  } catch (err) {
    say(`agent index unavailable: ${err.message}`, true);
    return null;
  }
  if (list === null) {
    state.caps.subagents = false;
    return null; // route not on this server yet — say nothing rather than cry wolf
  }
  state.caps.subagents = true;
  const agents = Array.isArray(list) ? list : (list.subagents ?? []);
  if (!agents.length) return agents;

  // Newest last is how they ran; keep that order but reveal from the end,
  // because the agents you want after an overnight run are the recent ones.
  let shown = 0;
  const stack = ranStack(th);
  const label = stack.querySelector('.ran-lbl');
  const moreBtn = el('button', { class: 'more' });

  const renderSlice = (n) => {
    const next = agents.slice(Math.max(0, agents.length - shown - n), agents.length - shown).reverse();
    for (const a of next) {
      const agentId = a.agentId;
      const meta = {
        agentType: a.subagentType ?? a.agentType ?? 'agent',
        description: a.description ?? '',
        status: a.status ?? 'completed',
        stats: agentStats(a),
      };
      if (!state.threads.has(agentId)) newThread(agentId, meta);
      else { Object.assign(state.threads.get(agentId), meta); refreshLede(state.threads.get(agentId)); }
      const fields = el('div', { class: 'ran-out' },
        el('div', { class: 'prose' }, el('p', { text: 'Open this thread to read what the agent actually did.' })),
        el('div', { class: 'fields' },
          el('span', {}, document.createTextNode('status '), el('b', { text: meta.status })),
          el('span', {}, document.createTextNode('messages '), el('b', { text: String(a.messageCount ?? 0) })),
          el('span', {}, document.createTextNode('tool_uses '), el('b', { text: String(a.usage?.tool_uses ?? 0) })),
          el('span', {}, document.createTextNode('total_tokens '), el('b', { text: (a.usage?.total_tokens ?? 0).toLocaleString() }))));
      ranRow(th, { agentId, ...meta, body: fields }, { silent: true });
    }
    shown += next.length;
    label.textContent = `${agents.length} agent${agents.length === 1 ? '' : 's'} ran in this session`
      + (shown < agents.length ? ` · newest ${shown}` : '');
    const left = agents.length - shown;
    moreBtn.textContent = `${left} older`;
    moreBtn.hidden = left <= 0;
    stack.append(moreBtn); // keep it last
  };

  moreBtn.addEventListener('click', () => renderSlice(RAN_MORE));
  renderSlice(RAN_PAGE);
  return agents;
}

/* ---------------------------------------------------------- open a session */

async function openSession(p, sess, opts = {}) {
  // BUG-083 — keep the outgoing session's unsent draft before state.current is
  // reassigned below, so it can be restored if the user returns here.
  saveDraft(state.current);
  selectProject(p.id, { quiet: true });
  // Opening a session restores ITS OWN armed overrides (skip/plan/model) and
  // nothing else's — a reload must not silently disarm what the user enabled
  // for this session, and a DIFFERENT session must never inherit it.
  restoreOverrides(sess.encodedDir, sess.sessionId);
  state.current = {
    projectId: p.id,
    encodedDir: sess.encodedDir,
    sessionId: sess.sessionId,
    title: rowTitle(sess),
    os: sess.os,
  };
  // BUG-106 — record the project that OWNS this now-open session, distinct from
  // the sidebar selection. A later bare selectProject moves current.projectId but
  // not this, which is how the dock's surfaces know they are foreign to the view.
  state.openProjectId = p.id;
  state.pendingNew = null; // FEAT-073 — a real session is open; no pending-new row
  state.forkFrom = null;
  // FEAT-022: a different session must never inherit this one's autonomous mode
  // or station id. Cleared here; re-learned from the `start` ack + refreshAuto.
  state.stationSessionId = null;
  state.autonomous = { autonomous: false, maxTurns: null, turnsDone: 0, remaining: null, stopReason: null };
  // A newly-opened session starts from a clean status slate — none of the
  // PREVIOUS session's error/detached/reconnecting flags may leak into it.
  state.sessError = null;
  state.provError = null; // BUG-031: nor its provider-error attribution
  state.lastTurnPrompt = null;
  state.sessReconnecting = false;
  // BUG-079: the outgoing session's pending-delivery pointers (drain-wait
  // self-retry, force-send stash) and their live timers must not act on this
  // one — clear them before the switch, alongside the other "never inherit".
  clearPendingDelivery();
  // A subagent thread viewed in the PREVIOUS session must never leak into this
  // session's URL: currentRoute() reads state.viewing, and resetTranscript()
  // (which clears it back to 'main') doesn't run until below. Clear it here,
  // before the push, so a stale agent= id is never captured — see BUG-011.
  state.viewing = 'main';
  syncUrl('push'); // BEFORE resetTranscript — its repaints replace-sync the URL
  closeSocket();
  paintCrown();
  renderTree();
  resetTranscript();
  restoreDraft(state.current); // BUG-083 — this session's own saved draft (empty if none)
  // BUG-087 — capture the transcript-pane scope AFTER resetTranscript bumped it.
  // If the user opens another session before this one's transcript fetch lands,
  // that next open bumps txScope again and the awaited answer below is dropped —
  // it belongs to the session we left, and painting it would put this (prior)
  // session's messages under the newly-opened session's header (the reported bug).
  const scope = state.txScope;
  const th = mainThread();
  const wait = el('div', { class: 'hint-row', text: 'reading the transcript…' });
  th.paneEl.append(wait);
  const frozen = sess.os === 'windows';
  node.box.hidden = frozen;
  node.frozen.hidden = !frozen;
  const at = Number.isInteger(opts.at) && opts.at >= 0 ? opts.at : null;
  try {
    // The NEWEST page, not the oldest. Everything before it is fetched on
    // scroll-up by loadOlder(). Fetched even when restoring at a deep index,
    // because it carries `total` — needed to know the restore IS deep.
    const t = await api.transcriptTail(sess.encodedDir, sess.sessionId, { limit: TAIL_PAGE });
    // BUG-087 — switched away while this fetch was in flight: the pane now belongs
    // to a different session (resetTranscript already cleared it and bumped the
    // scope). Drop this answer rather than paint the prior session's transcript
    // under the current header. `wait` was detached by that reset, so leave it.
    if (scope !== state.txScope) return;
    wait.remove();
    const tailStart = Number.isInteger(t.messages?.[0]?.index) ? t.messages[0].index : (t.offset ?? 0);
    if (at != null && at < tailStart) {
      // The remembered message is OLDER than the newest page: render a window
      // around it instead, and owe the rest forward (see the gap machinery).
      await openHistoryWindow(th, sess, at, t.total ?? 0, frozen);
    } else {
      const shown = renderMessages(th, t.messages);
      if (!shown) th.paneEl.append(el('div', { class: 'hint-row', text: 'This session has no readable messages.' }));
      th.page = pageCursor((before, beforeBytes) =>
        api.transcript(sess.encodedDir, sess.sessionId, { tail: OLDER_PAGE, before, beforeBytes }), t);
      // High-water mark for external appends: a message the tail page already
      // rendered must not re-render when the watcher replays it as an append.
      const lastMsg = t.messages[t.messages.length - 1];
      th.lastIndex = Number.isInteger(lastMsg?.index) ? lastMsg.index : (t.total ? t.total - 1 : null);
      // Follow AFTER the tail is in hand and the high-water mark is set: the
      // watcher starts at the file's current end, so this order cannot duplicate
      // what was just fetched, and the index dedupe covers any millisecond overlap.
      followCurrent();
      if (at != null) scrollToIndex(th, at); else scrollToBottom(th);
      say(`${shown} of ${t.total}${t.totalIsLowerBound ? '+' : ''} messages · newest page · ${(t.tookMs ?? 0)} ms`
        + `${th.page.done ? '' : ' · scroll up for older'}`
        + `${frozen ? ' · read-only, Windows origin' : ''}`);
    }
    if (opts.highlightAt != null) highlightMessageAt(th, opts.highlightAt);
    /*
     * BUG-129: this session's undelivered messages come back here — AFTER its
     * transcript is on screen, because a handed-off batch is only judged
     * undelivered by NOT being in that transcript (transcriptHasAll). Before
     * this point the pane is empty and every restored batch would read as lost.
     */
    adoptQueue();
    // Is this session being written LIVE right now (dashboard bridge OR an
    // external terminal this tab only follows)? Decided BEFORE the agent
    // summary, because a live session must not get one dumped into its tail.
    const liveRec = await liveRecordFor(sess.sessionId);

    /*
     * The recorded-agents "N agents ran in this session" stack hangs off the
     * END of the transcript.
     *  - forward gap outstanding: the rendered end is mid-history — defer it.
     *  - session LIVE: the rendered end is the STREAMING turn, and appending a
     *    historical summary there injected an old sub-agent into the live
     *    message ("Fix stale example-app permissionMode" reading as if it
     *    just finished). The live strip already surfaces current agents, so
     *    fetch the list for agent= validation but render NO tail summary.
     *  - otherwise (idle history): render the summary as before.
     */
    let agents;
    // `liveRec` is null for a session THIS tab's own bridge owns
    // (`liveRecordFor`'s `state.live` short-circuit — "our own bridge already
    // owns the tail"), so `state.live` must be OR'd in here too: otherwise a
    // self-owned live session with an outstanding gap read as neither gapped
    // nor live or fell straight into the `else` below and got the historical
    // summary appended (BUG-017).
    if (th.gap || liveRec || state.live) {
      // Defer the summary for a closed session's outstanding gap (paid off by
      // loadNewer once the reader scrolls to the true end — see the forward-gap
      // comment above loadNewer). A LIVE session must never queue it: paying off
      // the gap would splice the historical "N agents ran" stack into the live
      // tail exactly like the direct-open case above guards against (BUG-004),
      // and `liveRec` already unions mtime-liveness with an open live bridge
      // (`liveRecordFor`), so a bridge-idle live session is correctly excluded
      // here too — see BUG-014. `state.live` (our OWN bridge) is excluded the
      // same way — see BUG-017.
      if (th.gap && !liveRec && !state.live) th.agentsPending = true;
      try {
        const l = await api.sessionSubagents(sess.sessionId, sess.encodedDir ?? undefined);
        agents = l === null ? null : (Array.isArray(l) ? l : (l.subagents ?? []));
      } catch { agents = null; }
    } else {
      agents = await loadRecordedAgents(th, sess.sessionId);
    }
    if (at == null && th.stick !== false && state.viewing === 'main') scrollToBottom(th);
    await fillViewport(th);
    if (opts.agent) {
      // Only enter a thread that is really recorded here — a bogus agent id in
      // a link must say so, not open an empty pane that looks like a thread.
      if ((agents ?? []).some((a) => (a.agentId ?? a.id) === opts.agent)) await viewAgent(opts.agent);
      else say(`this link names an agent thread not recorded in this session (${String(opts.agent).slice(0, 12)}…)`, true);
    }
    // HONESTY ON REOPEN: a still-running session must not present as finished
    // history (the content leaks in via file-follow and startles). Reflect the
    // real busy state from the record fetched above.
    if (liveRec) {
      if (liveRec.drivenByDashboard) {
        // A dashboard bridge (detached after this or another tab looked away):
        // reattachable, and busy is knowable on a new-enough server.
        /*
         * FEAT-040: genuinely "detached (running headless)" — the server-side
         * bridge is busy but THIS tab is not driving it (no `start`/resume sent
         * yet). BUG-153: this used to ALSO raise `state.sessDetached`, a second
         * flag saying the same thing that any later socket open then cleared
         * while this one survived. `followingLive` is the durable half — it is
         * cleared where it is actually resolved: by the `start` ack that makes
         * us the driver, by refreshLive when the run really ends, and at the
         * session boundary — so the status now derives from it and liveness.
         */
        state.followingLive = true;
        if (liveRec.busy !== false) {
          // BUG-033: adopt the server's REAL turn start; if it does not report
          // one (older server, or a turn whose start this process never saw),
          // mark the duration unknown instead of stamping "now" and counting
          // from when this tab happened to open the session.
          if (Number.isFinite(liveRec.turnStartedAt) && liveRec.turnStartedAt > 0) {
            state.turnStartedAt = liveRec.turnStartedAt;
            state.turnStartUnknown = false;
          } else {
            state.turnStartedAt = 0;
            state.turnStartUnknown = true;
          }
          setBusy(true);
        }
        paintSessStatus();
        say('this session is still running (it kept working after the tab looked away) — following live. Send a message to take over and steer it.');
      } else {
        // External: written by another process (your terminal). The live badge
        // and file-follow already track it; we just must not fake a summary.
        // Mark it so the permission toggles read HONESTLY — there is no bridge
        // to send `set-permission-mode` to, and the terminal owns the mode, so
        // a toggle here only ARMS the takeover, it changes nothing now.
        state.followingExternal = true;
        paintPerm();
        say('this session is being written live by another process — following along as it goes.');
      }
    }
  } catch (err) {
    // BUG-087 — a fetch that REJECTS after the user switched away is not this
    // session's error to render: resetTranscript()+the message would wipe and
    // scribble on the pane that now belongs to the newly-opened session.
    if (scope !== state.txScope) return;
    resetTranscript();
    // BUG-129: the transcript could not be read, but the session's undelivered
    // rows are still its own — restore them rather than leave them stranded.
    // With no transcript on screen a handed-off batch cannot be confirmed, so it
    // comes back as an honest "not confirmed" row, which is the truth here.
    adoptQueue();
    mainThread().paneEl.append(el('div', { class: 'hint-row', text: `could not read this session: ${err.message}` }));
    say(err.message, true);
  }
}

/**
 * Restore parked at absolute index `at`: one backward window ending a little
 * PAST `at` (so the remembered message keeps context on both sides), the
 * normal backward cursor for everything older, and a recorded forward gap for
 * everything newer. No live follow until the gap is paid off.
 */
const RESTORE_AFTER = 40; // messages of forward context fetched past `at`

async function openHistoryWindow(th, sess, at, total, frozen) {
  const before = Math.min(at + RESTORE_AFTER, total);
  const t = await api.transcript(sess.encodedDir, sess.sessionId, { tail: TAIL_PAGE, before });
  const shown = renderMessages(th, t.messages);
  if (!shown) th.paneEl.append(el('div', { class: 'hint-row', text: 'This session has no readable messages.' }));
  th.page = pageCursor((b, bb) =>
    api.transcript(sess.encodedDir, sess.sessionId, { tail: OLDER_PAGE, before: b, beforeBytes: bb }), t);
  const grandTotal = Number.isInteger(t.total) ? t.total : total;
  const lastMsg = t.messages[t.messages.length - 1];
  const lastIdx = Number.isInteger(lastMsg?.index) ? lastMsg.index : before - 1;
  th.lastIndex = lastIdx;
  if (th.page && Number.isInteger(th.page.total)) th.page.total = grandTotal;
  if (lastIdx + 1 < grandTotal) {
    th.gap = { next: lastIdx + 1, total: grandTotal };
    followCurrent(false); // the gap machinery owns the tail until caught up
  } else {
    th.gap = null;
    followCurrent();
  }
  scrollToIndex(th, at);
  if (state.viewing === 'main') paintComposerFor(th);
  say(`${shown} messages around #${at}`
    + `${th.gap ? ` · ${th.gap.total - th.gap.next} newer below` : ''}`
    + ` · ${(t.tookMs ?? 0)} ms${frozen ? ' · read-only, Windows origin' : ''}`);
}

function selectProject(id, { quiet = false } = {}) {
  if (state.current.projectId !== id) {
    state.current.projectId = id;
    for (const k of Object.keys(state.overrides)) delete state.overrides[k];
  }
  paintCrown();
  void refreshRail();
  scheduleRailPoll();
  // BUG-106 — a bare project switch (this "look at another project" header click)
  // moves the sidebar selection without touching the open session. Re-scope the
  // dock's session-bound surfaces so they follow the match in BOTH directions:
  // hide the strip / hairline / live-count while the open session is foreign, and
  // restore them from the still-present state.snap + session config on switch-back.
  // Only meaningful when a session is actually open — browsing projects with an
  // empty dock changes nothing here, and paintPerm must not fire for a mere
  // selection (it would repaint the tray/hairline for a project with no session).
  if (state.openProjectId != null) {
    renderStrip();
    if (dockIsForeign()) node.permLine.hidden = true; else paintPerm();
    renderRailSummary();
  }
}

/* ═══════════════════════════════════════════ Needs-You rail (FEAT-018) ══ */
/*
 * The right rail turns the current project's 👤 board items into interactive
 * cards, with the read-only in-flight / done-today board below. Source of truth
 * is the server's board reader over docs/bugs/; this only renders and submits.
 *
 * Scope (first cut): renders 👤 tickets that exist ON THE BOARD. A session
 * dynamically raising a decision card at runtime is a separate, later channel.
 *
 * BUG-016: the rail was optimistic on its OWN submit only and reconciled just
 * on a manual reload, so an item resolved OUT OF BAND (chat, an orchestrator
 * INDEX edit, another client, a runtime decision resolved elsewhere) lingered
 * in the panel indefinitely. The rail must be a LIVE mirror of the board — see
 * the poll loop below.
 */
async function refreshRail(force = false) {
  const pid = state.current.projectId;
  if (!pid) { state.board = null; state.boardProjectId = null; renderRail(); return; }
  if (!force && state.boardProjectId === pid && state.board) { renderRail(); return; }
  if (state.boardBusy) return;
  state.boardBusy = true;
  try {
    const b = await api.board(pid);
    // A late response for a project the user already navigated away from must
    // not overwrite the newer one.
    if (state.current.projectId !== pid) return;
    state.board = b;
    state.boardProjectId = pid;
  } catch {
    // A board read never blocks the app: on failure show the quiet empty rail.
    if (state.current.projectId === pid) { state.board = null; state.boardProjectId = pid; }
  } finally {
    state.boardBusy = false;
    renderRail();
  }
  void refreshOutcomes(); // FEAT-057 — deaths are project-scoped too
}

/* ══════════════════════════ FEAT-057 — agents that stopped, and why ═══════
 *
 * THE REQUIREMENT THIS SATISFIES, restated because it is unusual: this surface
 * must cost ZERO model tokens and must not depend on the orchestrator ever
 * having run a turn. An account-wide usage limit stops the very turn that would
 * otherwise have had to notice the deaths — so the SERVER records them as they
 * happen and this renders that record. Everything below reads
 * `/api/agent-outcomes`; nothing here is derived from events, and nothing waits
 * for a session to be open.
 *
 * Dismissal is a server write, so a cleared banner stays cleared across
 * reloads, and one the user did not clear comes back.
 */

/** Fold snapshot-carried outcomes into the rail set without a refetch. */
function mergeOutcomes(list) {
  const seen = new Set(state.outcomes.map((o) => o.id));
  let added = 0;
  for (const o of list) {
    if (!o || seen.has(o.id) || o.dismissedAt) continue;
    state.outcomes.push(o);
    seen.add(o.id);
    added++;
  }
  if (added) { state.outcomes.sort((a, b) => b.at - a.at); renderOutcomes(); }
}

/**
 * BUG-070 — the rail's DEFAULT view is recent-only (deaths in the last 48h,
 * undismissed) so a mass event days ago does not bury today's real death. The
 * client fetches the FULL bounded set (incl. dismissed) and windows it itself,
 * so "show all" flips instantly and stays reachable even when the recent view
 * is empty (dismissed/old records still exist on disk — the ledger is never
 * truncated by this). The high limit ensures "dismiss all" reaches every id of
 * even a 50-agent mass-cut swarm.
 */
const OUTCOMES_RECENT_MS = 48 * 60 * 60 * 1000;
async function refreshOutcomes() {
  if (state.caps.outcomes === false) return;
  let list;
  try { list = await api.agentOutcomes({ projectId: state.current.projectId ?? undefined, all: true, limit: 200 }); }
  catch { return; /* transient — the rail keeps its last honest answer */ }
  if (list === null) { state.caps.outcomes = false; return; } // older server
  state.caps.outcomes = true;
  state.outcomes = list;
  renderOutcomes();
}

/** BUG-070 — the recent-view predicate: within 48h and not dismissed. */
function isRecentOutcome(o) {
  return !o.dismissedAt && (Date.now() - o.at) <= OUTCOMES_RECENT_MS;
}

/**
 * BUG-070 — relative day label ("today", "yesterday", "Aug 10") for a death's
 * timestamp. Mirrors `outcomes.dayLabel()` on the server so the two surfaces
 * never date the same record differently. The reported bug was that the rail
 * dropped the date and showed time-of-day alone, so a 2-day-old fossil read as
 * "7pm today". Calendar-day boundaries, not a rolling 24h.
 */
const DAY_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dayLabel(atMs, nowMs = Date.now()) {
  if (!Number.isFinite(atMs)) return '';
  const at = new Date(atMs);
  const now = new Date(nowMs);
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${DAY_MONTHS[at.getMonth()]} ${at.getDate()}`;
}

/** BUG-070 — "today 19:08" / "yesterday 19:08" / "Aug 10 19:08" for a death. */
function datedTime(atMs) {
  const t = new Date(atMs);
  const clock = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  return `${dayLabel(atMs)} ${clock}`;
}

/** "resets 13:40" from an epoch-ms the SERVER normalised, or '' when unknown. */
function resetsAtText(pe) {
  if (!pe || !Number.isFinite(pe.resetsAt)) return '';
  const d = new Date(pe.resetsAt);
  return `resets ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * The headline. Mirrors `outcomes.headline()` on the server deliberately: two
 * surfaces wording the same facts differently is how a user learns to distrust
 * both. Never invents a cause — a death with no known reason reads
 * "reason unknown", which is the honest sentence.
 */
/**
 * BUG-041 — mirror of the server's `clustersOf`: records stamped with one
 * cluster id (or written same-session within 10ms) are ONE host-level event.
 * Only the count is needed here, for the "stopped together" headline.
 */
function clusterOutcomes(list) {
  const sorted = [...list].sort((a, b) => a.at - b.at);
  const out = [];
  const byClusterId = new Map();
  let lastImplicit = null;
  for (const o of sorted) {
    const sess = o.sdkSessionId || o.stationSessionId || '?';
    if (o.clusterId) {
      const key = `${sess}|${o.clusterId}`;
      const c = byClusterId.get(key);
      if (c) { c.push(o); continue; }
      const fresh = [o];
      byClusterId.set(key, fresh);
      out.push(fresh);
      lastImplicit = null;
      continue;
    }
    const prev = lastImplicit && lastImplicit[lastImplicit.length - 1];
    const prevSess = prev && (prev.sdkSessionId || prev.stationSessionId || '?');
    if (prev && prevSess === sess && o.at - prev.at <= 10) { lastImplicit.push(o); continue; }
    lastImplicit = [o];
    out.push(lastImplicit);
  }
  return out;
}
function outcomeClusterCount(list) {
  return clusterOutcomes(list).length;
}

function outcomesHeadline(list) {
  if (!list.length) return '';
  const n = list.length;
  // BUG-041 — one host-level event is one fact, not N independent deaths.
  if (n > 1 && outcomeClusterCount(list) === 1) {
    const pe = list.map((o) => o.providerError).find((p) => !!p);
    const kinds = [...new Set(list.map((o) => (o.kind === 'unknown' ? 'reason unknown' : o.kind)))];
    return `${n} stopped together — one event (${pe ? pe.kind : kinds.join(', ')})`;
  }
  const quota = list.find((o) => o.kind === 'provider-error' && o.providerError);
  const noun = `${n} agent${n === 1 ? '' : 's'} stopped`;
  if (quota) {
    const r = resetsAtText(quota.providerError);
    return `${noun} — ${quota.providerError.kind}${r ? `, ${r}` : ''}`;
  }
  const kinds = [...new Set(list.map((o) => (o.kind === 'unknown' ? 'reason unknown' : o.kind)))];
  return `${noun} — ${kinds.join(', ')}`;
}

function outcomeDetailLine(o) {
  const who = o.row === 'main' ? 'main turn' : (o.label || 'agent');
  // BUG-070 — dated, never bare time: an old entry must never read as today's.
  const when = datedTime(o.at);
  // BUG-041 — name the actual cause, not just its category: the reported gap
  // was "tooling-unavailable tells me nothing about what actually happened".
  const why = o.kind === 'provider-error' && o.providerError
    ? `${o.providerError.kind} (${o.providerError.provider})`
    : o.kind === 'unknown' ? 'ended, reason unknown' : o.kind;
  return `${who} · ${why} · ${when}`;
}

/** BUG-041 — the hover carries the FULL stored evidence for one death. */
function outcomeEvidence(o) {
  return [
    o.detail,
    o.providerError ? `${o.providerError.kind} (${o.providerError.provider}): ${o.providerError.detail}` : '',
    new Date(o.at).toISOString(),
  ].filter(Boolean).join('\n');
}

/** BUG-070 — persist a dismissal, optimistically (server is authoritative). */
function dismissOutcomeIds(ids) {
  if (!ids.length) return;
  const set = new Set(ids);
  const now = Date.now();
  for (const o of state.outcomes) if (set.has(o.id) && !o.dismissedAt) o.dismissedAt = now;
  renderOutcomes();
  void api.dismissOutcomes(ids).catch(() => void refreshOutcomes());
}

/**
 * BUG-070 — the rail's death list. The DEFAULT view is recent + undismissed so
 * a mass event days ago cannot bury today's real death; "show all" reveals the
 * old and the dismissed. Grouped events (BUG-041 clusters — one host-level
 * moment) collapse to a dated header with a per-cluster dismiss, so yesterday's
 * 50-agent session-limit cut is cleared with one click, not fifty. Every row is
 * DATED (today/yesterday/Aug 10), the reported core defect.
 */
function renderOutcomes() {
  const full = (state.outcomes ?? []).slice().sort((a, b) => b.at - a.at);
  const showAll = state.showAllOutcomes;
  const list = showAll ? full : full.filter(isRecentOutcome);
  clear(node.railStopped);
  node.railStopped.hidden = list.length === 0;
  // FEAT-067: keep the top-of-rail summary's "stopped" chip in lockstep with
  // this section — outcomes refresh on their own poll (refreshOutcomes), not
  // renderRail's, so repaint the derived card here too or its count goes stale.
  renderRailSummary();
  if (!list.length) { state.showAllOutcomes = false; return; }
  node.railStopped.classList.add('stopped');

  const head = el('div', { class: 'sub-h', text: outcomesHeadline(list) });
  const dismissAll = el('button', {
    type: 'button', class: 'lnk', text: 'dismiss all',
    title: 'Stop showing these. Persisted server-side — they will not come back on a reload (the ledger on disk is kept).',
  });
  dismissAll.addEventListener('click', () => dismissOutcomeIds(list.map((o) => o.id)));
  head.append(dismissAll);
  // "show all" reveals dismissed + older-than-48h; only offered when some exist.
  const hiddenCount = full.length - full.filter(isRecentOutcome).length;
  if (showAll || hiddenCount > 0) {
    const toggle = el('button', {
      type: 'button', class: 'lnk', text: showAll ? 'show recent' : `show all${hiddenCount ? ` (+${hiddenCount})` : ''}`,
      title: showAll ? 'Back to recent, undismissed deaths only.' : 'Reveal older-than-48h and dismissed deaths (still on disk).',
    });
    toggle.addEventListener('click', () => { state.showAllOutcomes = !showAll; renderOutcomes(); });
    head.append(toggle);
  }
  node.railStopped.append(head);

  const clusters = clusterOutcomes(list); // newest cluster first (list is desc → re-sort asc inside)
  clusters.sort((a, b) => b[0].at - a[0].at);
  let rendered = 0;
  for (const c of clusters) {
    if (rendered >= 12) break;
    if (c.length === 1) {
      const o = c[0];
      node.railStopped.append(el('div', { class: 'brow', title: outcomeEvidence(o) },
        el('span', { class: 'g', text: o.kind === 'provider-error' ? '⛔' : '✖' }),
        el('span', { class: 'bt', text: outcomeDetailLine(o) })));
      rendered++;
      continue;
    }
    // A grouped host-level event: one dated header + a per-cluster dismiss.
    const cause = (() => {
      const pe = c.map((o) => o.providerError).find((p) => !!p);
      if (pe) return `${pe.kind} (${pe.provider})`;
      return [...new Set(c.map((o) => (o.kind === 'unknown' ? 'reason unknown' : o.kind)))].join(', ');
    })();
    const header = el('div', { class: 'brow', title: c.map(outcomeEvidence).join('\n\n') },
      el('span', { class: 'g', text: '⛔' }),
      el('span', { class: 'bt', text: `${c.length} ended together · ${cause} · ${datedTime(c[0].at)}` }));
    const cDismiss = el('button', {
      type: 'button', class: 'lnk', text: 'dismiss',
      title: 'Dismiss this whole event (all its records) at once. Persisted server-side.',
    });
    cDismiss.addEventListener('click', () => dismissOutcomeIds(c.map((o) => o.id)));
    header.append(cDismiss);
    node.railStopped.append(header);
    rendered++;
    for (const o of c.slice(0, 4)) {
      node.railStopped.append(el('div', { class: 'brow sub', title: outcomeEvidence(o) },
        el('span', { class: 'bt', text: `· ${outcomeDetailLine(o)}` })));
    }
    if (c.length > 4) {
      node.railStopped.append(el('div', { class: 'brow sub' },
        el('span', { class: 'bt', text: `· …and ${c.length - 4} more in this event` })));
    }
  }
  if (clusters.length > rendered) {
    node.railStopped.append(el('div', { class: 'brow' },
      el('span', { class: 'bt', text: `…and ${clusters.length - rendered} more event${clusters.length - rendered === 1 ? '' : 's'}` })));
  }
}

/**
 * FEAT-053: one read-only board row. Stays a div (BUG-025: these rows answer
 * nothing), but clicking it opens the ticket MODAL — the full file the agents
 * read — so it carries button semantics for keyboard users too. Opening a
 * ticket is not answering it.
 */
function boardRow(it, glyph) {
  const row = el('div', {
    class: 'brow', role: 'button', tabindex: '0',
    'data-id': it.id,
    title: `${it.id} — open the full ticket (goal, context, activity log)`,
  },
  glyph ? el('span', { class: 'g', text: glyph }) : null,
  el('span', { class: 'bid', text: it.id }),
  el('span', { class: 'bt', text: it.title }),
  it.sev ? el('span', { class: 'bsev', text: it.sev }) : null);
  row.addEventListener('click', () => void openTicketModal(it.id));
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void openTicketModal(it.id); }
  });
  return row;
}

function renderRail() {
  const b = state.board;
  const needs = b?.needsYou ?? [];
  const queued = b?.queued ?? [];
  const inflight = b?.inflight ?? [];
  const done = b?.doneToday ?? [];

  // count chip + badge
  node.railCount.textContent = needs.length ? String(needs.length) : '';
  node.railCount.hidden = needs.length === 0;
  node.railBadgeN.textContent = String(needs.length);
  node.railBadge.classList.toggle('none', needs.length === 0);

  // FEAT-066: the persistent board entries (topbar pill + rail-head link) — a
  // board is reachable from anywhere in the UI, not just a deep link. Shown for
  // any project that HAS a board; the open-count rides along as a quiet cue.
  paintBoardEntry(b);

  // FEAT-067: the server-derived status summary card at the very top of the rail.
  renderRailSummary();

  reconcileNeeds(needs);

  // FEAT-079: OBSERVATIONS — automated, read-only findings (WA-consolidation /
  // architecture-recurrence). A distinct, lower-priority lane BELOW the asks:
  // standing attention, never a to-do. Each row is read-only + dismissible.
  const observations = b?.observations ?? [];
  clear(node.railObservations);
  node.railObservations.hidden = observations.length === 0;
  if (observations.length) {
    node.railObservations.classList.add('observations');
    node.railObservations.append(el('div', { class: 'sub-h', text: 'Observations' }));
    for (const it of observations) node.railObservations.append(observationRow(it));
  }

  // queued (owner — ) — FEAT-053: the todo backlog, read-only, absent when empty
  clear(node.railQueued);
  node.railQueued.hidden = queued.length === 0;
  if (queued.length) {
    node.railQueued.classList.add('queued');
    node.railQueued.append(el('div', { class: 'sub-h', text: 'Queued' }));
    for (const it of queued) node.railQueued.append(boardRow(it, null));
  }

  // in-flight (🤖) — read-only
  clear(node.railInflight);
  node.railInflight.hidden = inflight.length === 0;
  if (inflight.length) {
    node.railInflight.classList.add('inflight');
    node.railInflight.append(el('div', { class: 'sub-h', text: 'In flight' }));
    for (const it of inflight) node.railInflight.append(boardRow(it, '🤖'));
  }

  // done today — read-only
  clear(node.railDone);
  node.railDone.hidden = done.length === 0;
  if (done.length) {
    node.railDone.classList.add('done');
    node.railDone.append(el('div', { class: 'sub-h', text: 'Done today' }));
    for (const it of done) node.railDone.append(boardRow(it, null));
  }
}

/**
 * FEAT-067 — paint the top-of-rail status summary card: a Focus line + a counts
 * strip (done · needs · queued · running · stopped), each count a chip that
 * scrolls to its existing rail section. This is a header/INDEX over the sections
 * below, NOT a fifth list.
 *
 * HONESTY (the whole point — the BUG-041/074 "observability must not lie" class):
 * every field is DERIVED LIVE, never a stored/emitted snapshot. `focus` + the
 * done/needs/queued/running counts come from `state.board.summary`, which the
 * server recomputes from the fully-merged board on every poll; the "stopped"
 * count is read straight off the already-fetched `state.outcomes` (its default
 * recent-view, matching what railStopped renders). So a change in the board,
 * running-set, or outcomes moves the card on the next poll — it cannot drift.
 * Reads state directly (no args) so both renderRail and renderOutcomes can
 * repaint it the instant either of their inputs changes.
 */
function renderRailSummary() {
  const host = node.railSummary;
  if (!host) return;
  clear(host);
  const pid = state.current.projectId;
  const b = state.board;
  const sum = b?.summary ?? null;
  const needs = b?.needsYou ?? [];
  const inflight = b?.inflight ?? [];
  // "stopped" = live agent outcomes, in the same default recent-undismissed view
  // that railStopped renders (BUG-070) — so the chip's number matches the
  // section it jumps to, never a stale or all-time count.
  const stopped = (state.outcomes ?? []).filter(isRecentOutcome).length;
  // FEAT-067 fast-follow — "live" = the TRUE count of processes running NOW, read
  // straight off the running-set snapshot the strip already polls (state.snap,
  // GET /api/sessions/:id/running). This is DISTINCT from `inflight` (board rows
  // the INDEX marks 🤖): live processes now vs tickets tagged in-flight. HONESTY:
  // with no snapshot there is no session id in hand — omit the chip (null), never
  // fake a zero that could read as "nothing is running" when we simply don't know.
  const snap = state.snap;
  // BUG-106 — omit the live count while the open session is foreign to the
  // selected project: its running processes are not this view's to report, and a
  // number here would attribute one project's live work to another (the same
  // observability lie the strip gate closes above).
  const live = snap && Array.isArray(snap.running) && !dockIsForeign() ? snap.running.length : null;

  // The card indexes the rail's sections: show it when there's a board to
  // summarize OR deaths to point at OR a live running-set to report (any of these
  // can exist even with no docs/bugs/). None of them → nothing to index → stay
  // quietly out of view.
  if ((!b?.hasBoard || !sum) && stopped === 0 && !live) { host.hidden = true; return; }
  host.hidden = false;

  // --- Focus: the single highest-priority open item (server-picked) ---
  const focus = sum?.focus ?? null;
  const focusRow = el('div', { class: 'rs-focus' });
  focusRow.append(el('span', { class: 'rs-lbl', text: 'Focus' }));
  if (focus) {
    // A 👤 needs-you row (blocked ON the user) is the focus glyph when the focus
    // id is in needsYou; otherwise it's in-flight (🤖). Link honesty: only a
    // real ticket opens the modal — a runtime decision / finding / stall focus
    // has no ticket file, so it stays plain text (a fake "open" affordance would
    // be exactly the lie this feature exists to avoid).
    const fit = needs.find((x) => x.id === focus.id) ?? inflight.find((x) => x.id === focus.id) ?? null;
    const isNeeds = needs.some((x) => x.id === focus.id);
    const isTicket = !!fit && fit.kind !== 'decision' && fit.kind !== 'finding' && fit.kind !== 'stall';
    focusRow.append(el('span', { class: 'rs-glyph', text: isNeeds ? '👤' : '🤖' }));
    const body = [
      el('span', { class: 'rs-id', text: focus.id }),
      el('span', { class: 'rs-ft', text: focus.title }),
    ];
    if (isTicket) {
      const link = el('button', {
        type: 'button', class: 'rs-focus-open', 'data-id': focus.id,
        title: `${focus.id} — open the full ticket`,
      }, ...body);
      link.addEventListener('click', () => void openTicketModal(focus.id));
      focusRow.append(link);
    } else {
      focusRow.append(el('span', { class: 'rs-focus-open static' }, ...body));
    }
  } else {
    focusRow.append(el('span', { class: 'rs-clear', text: 'board is clear — nothing open' }));
  }
  host.append(focusRow);

  // --- counts strip: one chip per section, scrolls to it (or navigates) on click ---
  // Each chip is {label, n, target?, action?, title}: a `target` chip scrolls to a
  // rail section; an `action` chip runs a navigation (deploy → the board portal,
  // where those tickets live). `deployPending` rides the server-derived summary;
  // `live` is client-derived above (omitted when null → no snapshot in hand).
  const c = sum?.counts ?? { needs: 0, observations: 0, queued: 0, inflight: 0, doneToday: 0, deployPending: 0 };
  const deploy = c.deployPending ?? 0;
  const chips = [
    { label: 'done', n: c.doneToday, target: node.railDone, hint: 'jump to the section below' },
    { label: 'needs', n: c.needs, target: node.railNeeds, hint: 'jump to the section below' },
    // FEAT-079 — observations are a distinct read-only count, next to needs so the
    // split (asks vs standing findings) reads at a glance.
    { label: 'observations', n: c.observations ?? 0, target: node.railObservations, hint: 'jump to the section below' },
    { label: 'queued', n: c.queued, target: node.railQueued, hint: 'jump to the section below' },
    // deploy-pending is scattered across sections (needs/queued/inflight), so it
    // links to the board portal (FEAT-066) where those tickets are all listed.
    { label: 'deploy', n: deploy, action: () => { if (pid) navTickets(pid, null); }, hint: 'open the board' },
    { label: 'running', n: c.inflight, target: node.railInflight, hint: 'jump to the section below' },
    // "live" (real running processes) sits next to "running" (board 🤖 rows) so the
    // two distinct truths read side by side; it jumps to the running strip up top.
    ...(live === null ? [] : [{ label: 'live', n: live, target: node.strip, hint: 'jump to the running strip' }]),
    { label: 'stopped', n: stopped, target: node.railStopped, hint: 'jump to the section below' },
  ];
  const strip = el('div', { class: 'rs-counts' });
  for (const { label, n, target, action, hint } of chips) {
    const chip = el('button', {
      type: 'button',
      class: `rs-chip st-${label}${n ? '' : ' zero'}`,
      'data-count': String(n),
      'data-target': label,
      title: n ? `${n} ${label} — ${hint}` : `no ${label}`,
    }, el('span', { class: 'rs-n', text: String(n) }), el('span', { class: 'rs-clbl', text: label }));
    if (n && action) {
      chip.addEventListener('click', action);
    } else if (n && target) {
      chip.addEventListener('click', () => {
        if (target.hidden) return; // an empty section isn't rendered — nothing to reach
        target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    } else {
      chip.disabled = true;
    }
    strip.append(chip);
  }
  host.append(strip);
}

/**
 * FEAT-066: keep the two persistent board entries — the topbar pill and the
 * rail-head "Open board →" link — pointed at the current project and shown only
 * when it actually has a board (opt-in; no docs/bugs/ → no affordance, no dead
 * link). The open count (needs + queued + in-flight) rides on the pill as a
 * quiet cue; it stays out of the way when there's nothing open.
 */
function paintBoardEntry(b) {
  const pid = state.current.projectId;
  const has = !!(pid && b && b.hasBoard);
  const href = has ? formatTicketsHash({ projectId: pid }) : '#/tickets';
  node.boardBtn.hidden = !has;
  node.railBoardLink.hidden = !has;
  if (!has) { node.boardBtnN.textContent = ''; return; }
  node.boardBtn.setAttribute('href', href);
  node.railBoardLink.setAttribute('href', href);
  const open = (b.needsYou?.length ?? 0) + (b.queued?.length ?? 0) + (b.inflight?.length ?? 0);
  node.boardBtnN.textContent = open ? String(open) : '';
}

// The board entries navigate IN PLACE (pushState) so Back returns to the
// session view exactly as it was — the ticket route is a cover, never a teardown.
function openBoardFromChrome(e) {
  const pid = state.current.projectId;
  if (!pid) return;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // keep new-tab
  e.preventDefault();
  navTickets(pid, null);
}
node.boardBtn.addEventListener('click', openBoardFromChrome);
node.railBoardLink.addEventListener('click', openBoardFromChrome);

/**
 * BUG-016: reconcile the rendered `.needs-card`s to the fetched `needs` set
 * IN PLACE, rather than clearing + rebuilding the whole rail on every poll.
 * A card whose id is still present is moved (not recreated) so a user mid-typing
 * in its response field keeps their focus and partial text across a background
 * refresh; a card whose id has disappeared (resolved out-of-band — via chat, an
 * INDEX edit, another client, or a runtime decision answered elsewhere) is
 * dropped; a card for a newly-appeared id is freshly built.
 */
function reconcileNeeds(needs) {
  const container = node.railNeeds;
  const existing = new Map();
  for (const c of container.querySelectorAll('.needs-card')) existing.set(c.dataset.id, c);

  if (!needs.length) {
    for (const c of existing.values()) c.remove();
    if (!container.querySelector('.rail-empty')) {
      container.append(el('div', { class: 'rail-empty' },
        el('span', { class: 'ok', text: '✓' }),
        el('span', { text: 'nothing needs you' })));
    }
    return;
  }
  const emptyEl = container.querySelector('.rail-empty');
  if (emptyEl) emptyEl.remove();

  // Walk the fetched order, moving existing cards into place (a no-op DOM-wise
  // when they're already there) and inserting fresh ones for new ids. Moving a
  // node within the SAME live parent (never through a detached fragment) keeps
  // it connected the whole time, so a focused textarea does not blur.
  let cursor = container.firstChild;
  for (const it of needs) {
    const have = existing.get(it.id);
    const target = have ?? needsCard(it);
    if (have) existing.delete(it.id);
    if (target === cursor) cursor = target.nextSibling; // already in place — leave untouched
    else container.insertBefore(target, cursor); // moves/inserts; cursor is still the right anchor
  }
  // Anything left in `existing` is no longer in the board's 👤 set — resolved
  // out-of-band. This is the fix: BUG-016's lingering card is dropped here.
  for (const stale of existing.values()) stale.remove();
}

/**
 * BUG-025: a 👤 ticket with NO `question` is board STATUS ("user-owned"),
 * not an ask — it must NOT render a response box (the whole bug this fixes
 * was "a card that asks nothing but 'ok'"). Render it read-only: title +
 * an "open ticket" affordance, no textarea, nothing to submit.
 */
function needsStatusRow(it) {
  /*
   * FEAT-058: "Open ticket" now points at the ticket DASHBOARD route rather
   * than a `file://` URL. A file:// link opened a raw markdown blob (or, in
   * most browsers, nothing at all); this opens the ticket rendered, with its
   * activity log and the write actions — and, because it stays a real anchor
   * with `target=_blank`, it lands in a SECOND TAB, leaving this session tab
   * live. The tooltip still names the file on disk.
   */
  const pid = state.boardProjectId ?? state.current.projectId;
  const openLink = el('a', {
    class: 'nc-send',
    href: formatTicketsHash({ projectId: pid, ticketId: it.id }),
    target: '_blank',
    rel: 'noopener',
    text: 'Open ticket',
    title: it.file ?? 'ticket file not found on disk',
  });
  const card = el('div', { class: 'needs-card status', 'data-id': it.id, 'data-kind': 'status' },
    el('div', { class: 'nc-head' },
      el('span', { class: 'nc-id', text: it.id }),
      el('span', { class: 'nc-sev', text: it.sev || '' })),
    el('div', { class: 'nc-title', text: it.title }),
    el('div', { class: 'nc-form' },
      el('div', { class: 'nc-acts' },
        el('span', { class: 'nc-err', text: '👤 board status — no question raised' }),
        openLink)));
  wireTitleModal(card, it); // FEAT-053 — the title opens the full ticket in place
  return card;
}

/**
 * FEAT-079: a PROMOTED finding (kind:'finding' with a `question`) — a finding
 * that crossed from a bare read-only Observation into a real ASK because a
 * writer attached a concrete decision ("file ARCH-### for this class, or keep
 * patching?"). It earns a place on the DECISION rail (needsYou); a bare finding
 * without a `question` never reaches here — it renders in the Observations lane
 * via `observationRow`. The ask is shown prominently; the evidence rides under
 * it; Dismiss still acks it server-side (a promotion the user chooses not to act
 * on stays dismissed until a later pass re-raises it with a newer date).
 */
function needsFindingRow(it) {
  const pid = state.boardProjectId ?? state.current.projectId;
  const isArch = typeof it.id === 'string' && it.id.startsWith('arch-recurrence-');
  const label = isArch ? 'Architecture decision' : 'WA consolidation';
  const err = el('span', { class: 'nc-err', text: '👤 finding — a decision is asked' });
  const dismiss = el('button', {
    class: 'nc-send', type: 'button', text: 'Dismiss',
    title: 'Acknowledge — stays dismissed unless a later pass re-detects it',
  });
  const card = el('div', { class: 'needs-card finding promoted', 'data-id': it.id, 'data-kind': 'finding' },
    el('div', { class: 'nc-head' },
      el('span', { class: 'nc-id', text: label }),
      el('span', { class: 'nc-sev', text: '' })),
    el('div', { class: 'nc-title', text: it.title }),
    // The concrete ASK is the point of a promoted finding — show it first; the
    // evidence detail follows as supporting context.
    it.question ? el('div', { class: 'nc-question ask', text: it.question }) : null,
    it.detail ? el('div', { class: 'nc-detail', text: it.detail }) : null,
    el('div', { class: 'nc-form' },
      el('div', { class: 'nc-acts' }, err, dismiss)));
  dismiss.addEventListener('click', async () => {
    dismiss.disabled = true;
    // Optimistic: drop the row now; the board refresh reconciles the truth.
    card.remove();
    if (state.board) state.board.needsYou = (state.board.needsYou ?? []).filter((x) => x.id !== it.id);
    renderRail();
    try {
      await api.dismissFinding(pid, it.id);
      say(`dismissed finding ${it.id} — returns only if a later consolidation pass re-detects it`);
    } catch (e) {
      // Reconcile: the refresh re-adds the row if the ack never landed.
      say(`could not dismiss ${it.id}: ${e.message}`, true);
    }
    void refreshRail(true);
  });
  return card;
}

/**
 * BUG-046: a ⚠ stalled-work card — ADVISORY, read-only, evidence-carrying.
 * Computed fresh from the running set on every board read; the moment the row
 * recovers (or ends) the card stops being produced, so there is nothing to
 * dismiss and no action to offer. Deliberately actionless (ARCH-002): the
 * evidence asks a human to look; acting on it requires ground truth the card
 * itself does not have.
 */
/**
 * FEAT-079: an OBSERVATIONS-lane row — an automated, read-only finding
 * (WA-consolidation FEAT-047, or architecture-recurrence FEAT-056). NOT an ask:
 * it carries no question and no response field, exactly like a finding on the
 * decision rail used to, but it now lives in its own lower-priority lane so it
 * cannot dilute "needs you". The one affordance is Dismiss, which acks it
 * server-side (dismissArchFinding / dismissConsolidationFinding); the row then
 * stays gone until a LATER pass re-detects the finding with a newer date.
 */
function observationRow(it) {
  const pid = state.boardProjectId ?? state.current.projectId;
  // Arch-recurrence ids are minted `arch-recurrence-*`; everything else here is
  // a WA-consolidation finding. Label + provenance glyph follow suit.
  const isArch = typeof it.id === 'string' && it.id.startsWith('arch-recurrence-');
  const label = isArch ? 'Architecture review' : 'WA consolidation';
  const provenance = isArch ? '📐 architecture finding — read-only' : '🧭 methodology finding — read-only';
  const err = el('span', { class: 'nc-err', text: provenance });
  const dismiss = el('button', {
    class: 'nc-send', type: 'button', text: 'Dismiss',
    title: 'Acknowledge — stays dismissed unless a later pass re-detects it',
  });
  const card = el('div', { class: 'needs-card status finding observation', 'data-id': it.id, 'data-kind': 'observation' },
    el('div', { class: 'nc-head' },
      el('span', { class: 'nc-id', text: label }),
      el('span', { class: 'nc-sev', text: '' })),
    el('div', { class: 'nc-title', text: it.title }),
    it.detail ? el('div', { class: 'nc-question', text: it.detail }) : null,
    el('div', { class: 'nc-form' },
      el('div', { class: 'nc-acts' }, err, dismiss)));
  dismiss.addEventListener('click', async () => {
    dismiss.disabled = true;
    // Optimistic: drop the row now; the board refresh reconciles the truth.
    card.remove();
    if (state.board) state.board.observations = (state.board.observations ?? []).filter((x) => x.id !== it.id);
    renderRail();
    try {
      await api.dismissFinding(pid, it.id);
      say(`dismissed observation ${it.id} — returns only if a later pass re-detects it`);
    } catch (e) {
      say(`could not dismiss ${it.id}: ${e.message}`, true);
    }
    void refreshRail(true);
  });
  return card;
}

function needsStallRow(it) {
  return el('div', { class: 'needs-card status stall', 'data-id': it.id, 'data-kind': 'stall' },
    el('div', { class: 'nc-head' },
      el('span', { class: 'nc-id', text: '⚠ stalled work' }),
      el('span', { class: 'nc-sev', text: '' })),
    el('div', { class: 'nc-title', text: it.title }),
    it.detail ? el('div', { class: 'nc-question', text: it.detail }) : null,
    el('div', { class: 'nc-form' },
      el('div', { class: 'nc-acts' },
        el('span', { class: 'nc-err', text: 'advisory — clears itself if progress resumes' }))));
}

function needsCard(it) {
  // BUG-046: a stalled-work advisory is read-only and actionless — its own row.
  if (it.kind === 'stall') return needsStallRow(it);
  // FEAT-047: a consolidation finding is read-only + dismissible — its own row.
  if (it.kind === 'finding') return needsFindingRow(it);
  // BUG-025: only an item that actually carries a `question` gets a response
  // field. A bare 👤 ticket (board status, no `## Question` section) has
  // none — it is read-only, not answerable.
  if (!it.question) return needsStatusRow(it);
  const pid = state.boardProjectId ?? state.current.projectId;
  // FEAT-029: a runtime-raised decision reads as '👤 decision' rather than a
  // ticket sev, and — when it carries options — offers them as buttons.
  const isDecision = it.kind === 'decision';
  const opts = Array.isArray(it.options) ? it.options : [];
  const input = el('textarea', { class: 'nc-input', rows: '2', placeholder: 'Your response…', 'aria-label': `Response for ${it.id}` });
  const err = el('span', { class: 'nc-err' });
  const send = el('button', { class: 'nc-send', type: 'button', text: 'Respond' });
  const card = el('div', { class: `needs-card${isDecision ? ' decision' : ''}`, 'data-id': it.id, 'data-kind': it.kind || 'ticket' },
    el('div', { class: 'nc-head' },
      el('span', { class: 'nc-id', text: isDecision ? '👤 decision' : it.id }),
      el('span', { class: 'nc-sev', text: isDecision ? '' : (it.sev || '') })),
    el('div', { class: 'nc-title', text: it.title }));
  // BUG-025: a ticket's `## Question` text can differ from the ticket H1
  // title — show it explicitly so the card asks something concrete. A
  // decision's `question` already equals `title` (server sets both), so
  // this only fires for a ticket that posed its own question.
  if (!isDecision && it.question && it.question !== it.title) {
    card.append(el('div', { class: 'nc-question', text: it.question }));
  }

  // A submit that removes the card optimistically and reconciles on refresh —
  // shared by the free-text Respond button and each option button.
  const submit = async (answer) => {
    const text = (answer ?? '').trim();
    if (!text) { input.focus(); return; }
    send.disabled = true;
    err.textContent = '';
    // Optimistic: drop the card now; the board refresh reconciles the truth.
    card.classList.add('going');
    card.remove();
    // Keep in-memory board honest so a same-project reselect doesn't flash it back.
    if (state.board) state.board.needsYou = (state.board.needsYou ?? []).filter((x) => x.id !== it.id);
    renderRail();
    try {
      const r = await api.answerBoard(pid, it.id, text);
      // FEAT-090: answering a TICKET records the decision to the board and hands
      // it back via the answered-awaiting lane — it dispatches NOTHING. A live
      // session that RAISED a decision is the exception (that is a reply it asked
      // for), so only that path reports a delivery.
      const label = isDecision
        ? (r.delivered ? 'delivered to the raising session' : 'recorded (session not live)')
        : `recorded to ${it.id} — awaiting handover`;
      say(`answered ${it.id} — ${label}`);
    } catch (e) {
      // Reconcile: the refresh re-adds the card if the answer never landed.
      say(`could not record answer for ${it.id}: ${e.message}`, true);
    }
    void refreshRail(true);
  };

  if (opts.length) {
    const row = el('div', { class: 'nc-opts' });
    for (const opt of opts) {
      const b = el('button', { class: 'nc-opt', type: 'button', text: opt });
      b.addEventListener('click', () => void submit(opt));
      row.append(b);
    }
    card.append(row);
  }

  card.append(el('div', { class: 'nc-form' },
    input,
    el('div', { class: 'nc-acts' }, err, send)));

  send.addEventListener('click', () => void submit(input.value));
  input.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void submit(input.value); }
  });
  wireTitleModal(card, it); // FEAT-053 — the title opens the full ticket in place
  return card;
}

/* ─────────────────────────────── FEAT-053 — rail ticket modal ────────────
 *
 * Clicking any rail row opens the ticket's FULL markdown in a modal — the same
 * file the dispatched agents read (goal, context pack, verification bar, the
 * append-only Activity log), rendered by FEAT-058's ticketDetailNode
 * (`{compact:true}`: read-only, no write actions — opening is not answering,
 * BUG-025). No summary layer in between; a missing ticket degrades to an
 * honest message. Esc closes (top of the Esc ladder); the body scrolls with a
 * plain max-height + overflow-y and deliberately NO overscroll-behavior
 * (BUG-032: `contain` swallows wheel chaining at the scroll boundary).
 */
const TICKET_ID_RE = /^[A-Z]+-\d+$/;

function ticketModalOpen() {
  return node.ticketModal && !node.ticketModal.hidden;
}

function closeTicketModal() {
  if (!node.ticketModal) return;
  node.ticketModal.hidden = true;
  clear(node.ticketModalBody);
}

async function openTicketModal(id) {
  const pid = state.boardProjectId ?? state.current.projectId;
  if (!pid || !node.ticketModal) return;
  node.ticketModal.hidden = false;
  clear(node.ticketModalBody).append(el('div', { class: 'tv-empty', text: `loading ${id}…` }));
  try {
    const t = await api.ticket(pid, id);
    if (!ticketModalOpen()) return; // closed while loading
    clear(node.ticketModalBody).append(ticketDetailNode(t, { compact: true }));
  } catch (err) {
    if (!ticketModalOpen()) return;
    // Honest degrade: the row named a ticket the board no longer has a file
    // for (deleted, renamed, drifted INDEX). Say so; never crash the rail.
    clear(node.ticketModalBody).append(el('div', { class: 'tv-empty' },
      el('b', { text: `Cannot open ${id}.` }),
      document.createTextNode(` ${err.message} — the row may be stale; the board refreshes on its next poll.`)));
  }
}

$('#ticketModalClose').addEventListener('click', closeTicketModal);
$('#ticketModalBack').addEventListener('click', closeTicketModal);

/**
 * FEAT-053: make a needs-card's title the modal affordance (all rail row types
 * open the full ticket). Only for items that ARE tickets on this board —
 * runtime decisions and consolidation/arch findings have no ticket file, and a
 * fake affordance would be a lie.
 */
function wireTitleModal(card, it) {
  if (it.kind === 'decision' || it.kind === 'finding' || it.kind === 'stall') return;
  if (!TICKET_ID_RE.test(it.id)) return;
  const title = card.querySelector('.nc-title');
  if (!title) return;
  title.classList.add('nc-open');
  title.setAttribute('role', 'button');
  title.setAttribute('tabindex', '0');
  title.title = `${it.id} — open the full ticket (goal, context, activity log)`;
  title.addEventListener('click', () => void openTicketModal(it.id));
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void openTicketModal(it.id); }
  });
}

// Narrow viewport: the badge opens the rail as an overlay; a click outside closes it.
node.railBadge.addEventListener('click', () => {
  node.rail.classList.toggle('open');
});
document.addEventListener('click', (e) => {
  if (!node.rail.classList.contains('open')) return;
  if (node.rail.contains(e.target) || node.railBadge.contains(e.target)) return;
  node.rail.classList.remove('open');
});

/* -------------------------------------------- BUG-016: live rail poll loop */
/*
 * The rail's whole point is state honesty — its cards ARE the board's current
 * unresolved 👤 set, not a snapshot from the last submit or reload. Poll the
 * board on a modest interval so an out-of-band resolution (chat, an INDEX edit,
 * another client, a runtime decision answered elsewhere) leaves the panel
 * without the user having to reload, and a newly-raised item appears the same
 * way. `reconcileNeeds` (above) makes this safe to run in the background: it
 * moves/removes cards rather than rebuilding them, so a card the user is
 * mid-typing in is left alone as long as its item is still open.
 */
const RAIL_POLL_MS = 5000;
let railPollTimer = null;

function clearRailPoll() {
  if (railPollTimer) { clearTimeout(railPollTimer); railPollTimer = null; }
}

function scheduleRailPoll() {
  clearRailPoll();
  // Paused while the tab/rail is not visible — no point polling a background
  // tab; visibilitychange below catches up immediately on return.
  if (document.hidden || !state.current.projectId) return;
  railPollTimer = setTimeout(() => { void pollRail(); }, RAIL_POLL_MS);
}

async function pollRail() {
  if (!document.hidden && state.current.projectId) {
    await refreshRail(true);
    // FEAT-057: the death ledger rides the SAME poll — an agent that dies while
    // nothing else is happening (the whole point of the feature) must surface
    // without any other traffic to piggyback on.
    await refreshOutcomes();
  }
  scheduleRailPoll();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearRailPoll(); return; }
  // Coming back into view: refresh right away rather than waiting out a stale
  // interval — this is the server-restart-while-tab-was-away case from BUG-016.
  void refreshRail(true);
  scheduleRailPoll();
});
window.addEventListener('focus', () => { void refreshRail(true); });

function startNew(projectId) {
  saveDraft(state.current); // BUG-083 — keep the outgoing session's draft before we leave it
  selectProject(projectId, { quiet: true });
  // No override — model, effort, budget, permissionMode, allowed/disallowed
  // tools — survives into a new session, same-project or not. Each new
  // session starts honestly from the project's own default; the user
  // re-arms whatever they want per-session.
  for (const k of Object.keys(state.overrides)) delete state.overrides[k];
  state.current = { projectId, encodedDir: null, sessionId: null, title: 'New session', os: 'linux' };
  state.openProjectId = projectId; // BUG-106 — the pending-new dock is owned by this project
  state.pendingNew = projectId; // FEAT-073 — this drives the derived pending-new row
  state.forkFrom = null;
  // FEAT-073: expand the owning project so its pending-new row is actually on
  // screen (the row lives in the group's kids, hidden while collapsed). Loading
  // its history in the background lets the real row take over seamlessly once the
  // first message lands.
  state.expanded.add(projectId);
  saveExpanded();
  void loadSessions(projectId);
  clearPendingDelivery(); // BUG-079: no outgoing session's pending delivery may leak into the new one
  syncUrl('push'); // BEFORE resetTranscript, whose repaints replace-sync the URL
  followCurrent(); // no session on screen any more: drops every watch
  closeSocket();
  resetTranscript();
  restoreDraft(state.current); // BUG-083 — this project's pending-new draft (empty if none)
  adoptQueue(); // BUG-129 — and this project's pending-new undelivered rows, same key
  node.box.hidden = false;
  node.frozen.hidden = true;
  node.agentDone.hidden = true;
  paintCrown();
  paintModelBtn();
  paintModelPop();
  renderTree();
  node.prompt.focus();
}

/* ------------------------------------------------------------- live strip */


/* ═══════════════════ ARCH-001 phase 2 / BUG-034 — THE STRIP IS A RENDERER ══
 *
 * WHAT CHANGED, AND WHY IT IS A DESIGN CHANGE RATHER THAN A SIXTH PATCH.
 *
 * This strip used to DERIVE what was running: a union of `agent-*` event
 * fragments it happened to receive, `replayAgents()` on attach, `state.busy`,
 * the mtime live list, a live-bridge override and two client-side sweeps. Every
 * input is lossy, so the answer was wrong in both directions and depended on
 * when you looked — three dispatched subagents showing as none (BUG-034), and a
 * tab that lived through a server restart still counting a killed agent's
 * timers up to 0:53 while the server had no such state at all. Five patches
 * (BUG-004/017/020/030/033) treated the arithmetic; the defect was that the
 * client was answering a question it cannot answer.
 *
 * Now: THE SERVER ANSWERS, THIS RENDERS. `state.snap` is the server-authored
 * running-set snapshot (pushed on every change, fetched on attach and on a
 * poll). Rows are reconciled to it in place. Deltas still arrive and still
 * drive threads and "ran" rows — they no longer decide what is ALIVE.
 *
 * WHAT THAT BUYS, stated as the invariants it must never break:
 *  - BUG-030 (◐ only while a live process can be behind it): a row exists only
 *    while the SERVER's authority still vouches for it. Strictly stronger than
 *    the client-side sweeps, which had to infer death from silence.
 *  - BUG-034 (correct AND empty without a reload): an empty snapshot is a real
 *    answer and empties the strip. That is the whole indictment in the ticket.
 *  - BUG-004 (never resurrect finished work): nothing here reads history. A row
 *    is drawn from the current snapshot or not at all.
 *  - BUG-033 (honest clock): `startedAt`/`turn.since` are the SERVER's, and
 *    `null` renders "—". This tab never stamps a start time it did not observe.
 *  - BUG-020 (reattach shows in-flight agents): the handshake pushes a snapshot,
 *    so a reattached tab is correct immediately rather than by luck.
 *
 * THE MAIN ROW — DECIDED (BUG-034 asked for a decision, not a guess): the strip
 * KEEPS a `main` row, and it is authored by the same snapshot as every other
 * row (`turn.running` / `turn.since` straight from the authority). The crown
 * (FEAT-040 `#sessStatus`) stays the session-STATE affordance —
 * thinking/streaming/detached/reconnecting/idle — and is deliberately not
 * duplicated here. Rationale: the strip answers "what work is in flight" and
 * the orchestrator's own turn IS work in flight; removing it would leave the
 * user's original report ("should be main (you)") unanswered and make the strip
 * silent during the most common case of all (a turn with no subagents). The two
 * surfaces are kept consistent by construction — `paintSessStatus()` is called
 * on every snapshot apply, and both read the same server truth: if the snapshot
 * says no turn is running, the strip has no main row AND the crown cannot say
 * "Thinking…".
 */

/**
 * Elapsed for one row, or an honest "—".
 *
 * BUG-033's rule, now with the only start time that was ever legitimate: the
 * SERVER's. A duration may be shown only when something actually knows when the
 * work began. Reattaching to a turn that started before this tab existed used
 * to stamp `Date.now()` and count up from there, so a session wedged for three
 * days displayed a confident "1:08" — a number about the TAB presented as a
 * fact about the turn. A null/absent `startedAt` renders "—", forever if need be.
 */
function rowElapsed(startedAt, stale = false) {
  if (!Number.isFinite(startedAt) || startedAt <= 0) return '—';
  // Frozen at the moment we lost the ability to check: a clock that keeps
  // ticking while nothing can confirm the work is still running is the same
  // fabricated stopwatch in slower motion.
  const at = stale ? (state.snapStaleAt || Date.now()) : Date.now();
  return mmss(at - startedAt);
}

/**
 * Can the current answer still be vouched for? False the moment the socket
 * drops or the poll cannot reach the server — see `state.snapStale`.
 */
function snapshotIsStale() {
  return !!(state.snapStale || state.dropped);
}

/** Note that nothing can confirm the running set any more (freezes the rows). */
function markSnapshotStale() {
  if (state.snapStale) return;
  state.snapStale = true;
  state.snapStaleAt = Date.now();
  renderStrip();
}

/**
 * The rows to draw, from the SERVER's snapshot. Never from `state.agents`.
 *
 * The one case with no snapshot is a tab whose own send has been acked but
 * whose first snapshot has not landed yet (or an older server without the
 * route). It draws a `main` row from FIRST-HAND knowledge — this tab started
 * this turn — with the same honest clock rules, and nothing else. That is not
 * the old union: it never invents a row for an agent, which is the thing this
 * tab genuinely cannot know.
 */
function stripModel() {
  const snap = state.snap;
  if (snap && Array.isArray(snap.running)) {
    const stale = snapshotIsStale();
    return snap.running.map((r) => ({
      key: r.id,
      row: r.row,
      ty: r.row === 'main' ? 'main' : (r.label || 'agent'),
      de: r.row === 'main' ? (state.current.title ?? 'working') : (r.description || r.lastTool || ''),
      startedAt: r.startedAt,
      stale,
      // BUG-046 — the server's evidence state for the row. Absent (older
      // server) reads as running. A stalled row is still a member of the
      // running set — it is rendered ⚠ with its evidence, never dropped.
      stalled: r.state === 'stalled',
      stallWhy: r.stall?.checked ?? '',
    }));
  }
  if (state.busy) {
    return [{
      key: 'main',
      row: 'main',
      ty: 'main',
      de: state.current.title ?? 'working',
      startedAt: state.turnStartUnknown ? null : (state.turnStartedAt || null),
    }];
  }
  return [];
}

function renderStrip() {
  // BUG-106 — the strip describes the OPEN session's live work. When the user has
  // selected a different project in the sidebar, that work is foreign to the view:
  // present nothing (the same absent end-state resetTranscript produces) rather
  // than attribute one project's running agents to another. state.snap and the
  // socket are kept, so switching back restores the real rows immediately.
  if (dockIsForeign()) {
    clear(node.stripRows);
    node.stripSum.textContent = '';
    node.stripClk.textContent = '—';
    node.strip.hidden = true;
    return;
  }
  const model = stripModel();
  // Stays visible while inside a subagent so switching is one click and the
  // other agents remain in peripheral view.
  if (!model.length && state.viewing === 'main') {
    // BUG-033: EMPTY it, don't just hide it. Leaving the last "◐ main · 3:07"
    // row in the hidden DOM keeps a stale running claim alive in the document
    // (assertable, screenshot-able, and one CSS change away from visible) for a
    // turn that is over. Nothing may say "running" once nothing is.
    clear(node.stripRows);
    // …and the SUMMARY with it. "3 agents running · 0:07" left behind in the
    // hidden strip is the same stale claim in text form — assertable,
    // screenshot-able, and one CSS change from visible.
    node.stripSum.textContent = '';
    node.stripClk.textContent = '—';
    node.strip.hidden = true;
    return;
  }
  if (!model.length && state.viewing !== 'main') {
    node.strip.hidden = false;
    clear(node.stripRows);
    const back = el('button', { type: 'button', class: 'lag main', 'data-thread': 'main', 'aria-current': 'false', title: 'Back to the main thread' },
      el('span', { class: 'ty', text: 'main' }),
      el('span', { class: 'de', text: state.current.title ?? '' }),
      el('span', { class: 'gl', text: '·' }),
      el('span', { class: 'el', text: '—' }));
    back.addEventListener('click', () => showThread('main'));
    node.stripRows.append(back);
    for (const [key, th] of state.threads) {
      if (key === 'main') continue;
      const row = el('button', { type: 'button', class: 'lag wait', 'data-thread': key, 'aria-current': String(state.viewing === key), title: `Open ${th.agentType}'s thread` },
        el('span', { class: 'ty', text: th.agentType || 'agent' }),
        el('span', { class: 'de', text: th.description || '' }),
        el('span', { class: 'gl', text: '✓' }),
        el('span', { class: 'el', text: '—' }));
      row.addEventListener('click', () => void viewAgent(key));
      node.stripRows.append(row);
    }
    node.stripSum.textContent = 'viewing an agent thread';
    node.stripClk.textContent = '—';
    return;
  }
  node.strip.hidden = false;
  clear(node.stripRows);

  /*
   * Every row in the model is, by construction, something the SERVER says is
   * running right now — so every row gets ◐. There is no "wait" state to infer
   * any more: a row that is not running is simply absent from the snapshot.
   */
  const rows = model.map((r) => ({
    key: r.key,
    // A row whose answer cannot be checked any more keeps its place but loses
    // its running mark: ◐ is a claim, and there is nothing left to back it.
    // BUG-046: a STALLED row keeps its place too, but wears ⚠ instead of ◐ —
    // "running" is a claim the server's evidence no longer backs, and "gone"
    // would assert an end nobody proved. The reason rides the tooltip.
    cls: r.stale ? (r.row === 'main' ? 'lag main wait' : 'lag wait')
      : r.stalled ? (r.row === 'main' ? 'lag main stall' : 'lag stall')
        : (r.row === 'main' ? 'lag main run' : 'lag run'),
    ty: r.ty,
    de: r.de,
    gl: r.stale ? '·' : (r.stalled ? '⚠' : '◐'),
    el: rowElapsed(r.startedAt, r.stale),
    stallWhy: r.stalled ? (r.stallWhy || 'no progress evidence for this row') : '',
  }));
  for (const r of rows) {
    const row = el('button', {
      type: 'button',
      class: r.cls,
      'data-thread': r.key,
      'aria-current': String(state.viewing === r.key),
      title: r.stallWhy
        ? `⚠ stalled — ${r.stallWhy}`
        : (r.key === 'main' ? 'Back to the main thread' : `Open ${r.ty}'s thread`),
    },
      el('span', { class: 'ty', text: r.ty }),
      el('span', { class: 'de', text: r.de }),
      el('span', { class: 'gl', text: r.gl }),
      el('span', { class: 'el', text: r.el }));
    row.addEventListener('click', () => (r.key === 'main' ? showThread('main') : void viewAgent(r.key)));
    node.stripRows.append(row);
  }
  paintStripSummary(model);
}

/**
 * The summary line. The clock is the MAIN turn's honest age (the server's
 * `turn.since`); with no main row it is the first running row's, and "—"
 * wherever nothing actually knows — never a stopwatch this tab started.
 */
function paintStripSummary(model) {
  const main = model.find((r) => r.row === 'main');
  const agents = model.filter((r) => r.row !== 'main');
  const stale = model.some((r) => r.stale);
  const clock = main ? rowElapsed(main.startedAt, stale) : (agents.length ? rowElapsed(agents[0].startedAt, stale) : '—');
  node.stripClk.textContent = clock;
  // BUG-046: stalled rows are counted out loud — "2 agents running" over a set
  // where one has silently stopped progressing is the fleet-level lie the
  // detector exists to end.
  const stalled = agents.filter((r) => r.stalled).length;
  const stallNote = stalled ? ` · ⚠ ${stalled} stalled` : '';
  node.stripSum.textContent = stale
    // Says the true thing: this is the last answer we got, not the current one.
    ? `${agents.length} agent${agents.length === 1 ? '' : 's'} — unverified, the server is unreachable (as of ${clock})`
    : `${agents.length - stalled} agent${agents.length - stalled === 1 ? '' : 's'} running${stallNote} · ${clock}`;
}

/*
 * The one-second tick advances the CLOCKS ONLY — it can never add, remove or
 * revive a row, because the set of rows is the server's answer and this timer
 * has no opinion about it. (The previous version walked `state.agents` here,
 * which is how a tab kept a killed agent's stopwatch climbing.)
 */
setInterval(() => {
  if (node.strip.hidden) return;
  const model = stripModel();
  const rows = [...node.stripRows.children];
  if (rows.length !== model.length) { renderStrip(); return; } // set changed under us
  model.forEach((r, i) => {
    const el2 = rows[i]?.querySelector('.el');
    if (el2) el2.textContent = rowElapsed(r.startedAt);
  });
  paintStripSummary(model);
}, 1000);

/**
 * Is this snapshot about the session on screen?
 *
 * A snapshot arriving on THIS session's own socket is ours by construction and
 * is trusted (`trusted`), which matters at the very start of a turn: the server
 * publishes the running set the instant the turn begins — before this tab has
 * even been told its station session id — and that push is precisely the fix
 * for "the main row appears eventually, not at turn start". A POLLED snapshot
 * is checked, because the user may have navigated away while it was in flight.
 */
function snapshotIsForCurrent(snap) {
  const ids = [state.stationSessionId, state.sdkSessionId, state.current.sessionId].filter(Boolean);
  if (!ids.length) return true;
  return ids.includes(snap.stationSessionId) || ids.includes(snap.sdkSessionId);
}

/**
 * BUG-106 — is the session open in the transcript dock FOREIGN to the project the
 * user has now selected in the sidebar? True after a bare selectProject (a "look
 * at another project" header click) that lands on a project other than the one
 * that owns the open session. While true, the dock's session-bound surfaces — the
 * running strip, the permission hairline, the rail's live-count chip, the running
 * poll — must present nothing (the same absent end-state resetTranscript gives)
 * rather than attribute one project's live work to another. It does NOT close the
 * open session: state.snap and the socket are kept, so a switch BACK restores the
 * real strip. Not foreign when nothing is open (openProjectId null) or when the
 * selection matches the open session's owner.
 */
function dockIsForeign() {
  return state.openProjectId != null
    && state.current.projectId != null
    && state.openProjectId !== state.current.projectId;
}

/*
 * BUG-106 — the ONE place the open session's LIVE report is resolved for a VIEW
 * surface. dockIsForeign() gated the strip, the hairline, the rail live-count and
 * the poll one call site at a time; the crown model chip (and the integrations
 * strip, and the permission tray/seal) still read the open session's live fields
 * directly, so they kept leaking A's live model/provider/tools/posture under B.
 *
 * The structural fix: a surface that PAINTS the open session's live state must
 * read its live inputs through these accessors, never `state.*` directly. When
 * the dock is foreign the open session's live report is not about the thing on
 * screen, so these return ABSENT and every such surface falls back to the SELECTED
 * project's predicted/planned view — blank of A's live work BY CONSTRUCTION rather
 * than by each call site remembering to call dockIsForeign(). A newly added
 * surface that reads state.snap/live/effective/liveTools/liveWireModel directly is
 * not covered — scripts/verify-bug-106-foreign-surfaces.mjs drives a rich foreign
 * live-state and enumerates every live-reading surface so a new leak FAILs loudly.
 */
const dockSnap = () => (dockIsForeign() ? null : state.snap);
const dockLive = () => (dockIsForeign() ? false : state.live);
const dockEffective = () => (dockIsForeign() ? null : state.effective);
const dockLiveTools = () => (dockIsForeign() ? null : state.liveTools);
const dockLiveModel = () => (dockIsForeign() ? null : liveWireModel);

/**
 * RECONCILE to the server's answer. The only writer of `state.snap`.
 *
 * It corrects in both directions — rows this tab never heard about appear, rows
 * the server no longer vouches for disappear — and an EMPTY snapshot empties
 * the strip, with no page reload. That last sentence is BUG-034's entire ask.
 */
function applySnapshot(snap, { trusted = false } = {}) {
  if (!snap || snap.v !== 1 || !Array.isArray(snap.running)) return false;
  if (!trusted && !snapshotIsForCurrent(snap)) return false;
  state.snap = snap;
  state.snapStale = false; // a fresh answer — the rows can be vouched for again
  state.snapStaleAt = 0;
  if (Array.isArray(snap.ended) && snap.ended.length) mergeOutcomes(snap.ended);
  // BUG-113: this is the evidence turn-end's nominations were waiting for — and
  // it must run BEFORE the repaint below, so the strip is painted once, from the
  // reconciled state, rather than flashing the pre-judgement rows.
  settleCutAgentsAgainst(snap);
  renderStrip();
  // FEAT-040 consistency: the crown and the strip must never disagree about
  // whether work is in flight — repaint it from the same answer.
  paintSessStatus();
  // FEAT-067 fast-follow: the summary card's "live" chip reads THIS snapshot's
  // running-set, so it must repaint every time the set changes — otherwise the
  // one honesty invariant (derived live every poll, never a stored snapshot)
  // would break for that count alone.
  renderRailSummary();
  return true;
}

/* -------------------------------------------- BUG-034: the correcting poll */
/*
 * Push is not enough and never was. A frame can be dropped, a tab can be
 * backgrounded through the whole turn, a socket can die mid-flight, and a
 * server can restart under an open tab — all of which produced the reported
 * symptom in one direction or the other. This poll is the backstop that makes
 * the strip SELF-CORRECTING: whatever happened to the event stream, the tab
 * converges on the server's answer within one interval, without a reload.
 */
const SNAP_POLL_MS = 4000;

async function pollRunning() {
  if (state.caps.running === false) return; // older server — no route to ask
  const id = state.stationSessionId || state.sdkSessionId || state.current.sessionId;
  if (!id) return;
  // BUG-106 — while the open session is foreign to the sidebar selection the strip
  // is gated absent; re-fetching and re-applying its running set would only feed a
  // hidden surface and churn the network every 4s. A push on the session's own
  // socket still keeps state.snap warm for the switch-back, and the interval poll
  // resumes the instant the selection returns to the owning project.
  if (dockIsForeign()) return;
  // BUG-083 — remember which session boundary this poll belongs to. If the user
  // switches away while the request is in flight, the answer that lands is the
  // OLD session's running set; dropping it is what stops it repainting the
  // outgoing session's agents under the newly-selected one.
  const scope = state.snapScope;
  let snap;
  try {
    snap = await api.sessionRunning(id);
  } catch {
    // Unreachable, not "nothing is running": freeze the rows and say so rather
    // than either deleting work that may still be running or letting a
    // stopwatch keep climbing on an answer nobody can confirm. But only for the
    // session still on screen — a switched-away poll's failure is not ours.
    if (scope === state.snapScope) markSnapshotStale();
    return;
  }
  if (scope !== state.snapScope) return; // switched sessions mid-flight — this answer is the session we left
  if (snap === null) { state.caps.running = false; return; }
  state.caps.running = true;
  applySnapshot(snap);
}

function startRunningPolling() {
  if (state.snapPollTimer) return;
  state.snapPollTimer = setInterval(() => { if (!document.hidden) void pollRunning(); }, SNAP_POLL_MS);
  // A tab coming back to the foreground is the single most likely moment to be
  // holding a stale picture — reconcile immediately rather than up to a tick later.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void pollRunning(); });
}

$('#stripTop').addEventListener('click', function () {
  const shut = node.strip.classList.toggle('shut');
  this.setAttribute('aria-expanded', shut ? 'false' : 'true');
});

/**
 * BUG-030 — which kind of row this is. 'tool' = a single tool call the CLI
 * surfaces as its own task (task_type "local_bash"); everything else is a real
 * subagent. Falls back on the agentType for events from an older server that
 * does not send `kind`.
 */
function agentKind(a) {
  return a.kind ?? ((a.agentType || '').startsWith('local_') && a.agentType !== 'local_agent' ? 'tool' : 'agent');
}

/*
 * BUG-030 — the in-flight invariant: a card may show ◐ only while a live
 * process/turn can actually be behind it. Two ground truths enforce it:
 *  - after a turn's `result` (turn-end) NOTHING from that turn can still be
 *    running (the bridge sweeps its own #agents at `result`, so any row still
 *    `running` at client turn-end belongs to a bridge/CLI that died);
 *  - on (re)attach, everything genuinely alive is re-announced by the server's
 *    replayAgents() within the same handshake, so a pre-existing row that no
 *    frame refreshes right after the `start` ack has no live process behind it
 *    (its terminal frame died with a cut host CLI — a server restart/shutdown,
 *    the same cut BUG-028's interruptedByShutdown marks in the transcript).
 * Such a zombie is settled honestly as "cut by shutdown" instead of spinning
 * forever with a growing timer.
 */
function settleCut(cur) {
  cur.settled = true;
  cur.agent = { ...cur.agent, status: 'cut', elapsedMs: Math.max(0, Date.now() - (cur.t0 ?? Date.now())) };
  const th = state.threads.get(cur.agent.agentId);
  if (th) { th.status = 'cut'; refreshLede(th); }
  // A tool-call row settles silently (its parent agent's row carries the
  // story); a real subagent leaves the honest "ran" row with the cut caption.
  if (agentKind(cur.agent) !== 'tool') {
    finishStream(state.threads.get(cur.agent.agentId));
    settleAgent(cur);
  }
}

/*
 * BUG-113 — the turn-end half of the invariant, corrected. "After a turn's
 * `result` nothing from it can still be running" is FALSE for a background
 * agent: the server's own turn-end sweep deliberately SPARES rows belonging to
 * live background work, so they stay `running` and emit no completion, and the
 * snapshot force-pushed one frame later still lists them. The old sweep settled
 * every unsettled row right at `turn-end` with no background knowledge and
 * without consulting the server — flipping live work to `cut` and writing a
 * durable "Cut by shutdown" ledger row. The snapshot that arrived a frame later
 * repainted the strip, but the card, the thread and the ledger row never
 * re-opened: three surfaces, two answers, and the wrong one was the permanent
 * one.
 *
 * So turn-end no longer settles anything. It only NOMINATES the rows that
 * cannot be judged yet, and the judgement waits for positive evidence: the next
 * applied snapshot whose `turn.running === false` — computed at or after the
 * result, so its `running[]` is the server's answer to "what survived the
 * turn". Candidates absent from that list are settled; candidates present in it
 * are live background work and are simply released. If no qualifying snapshot
 * ever arrives, NOTHING is settled — a death may not be asserted from mere
 * absence of evidence, and an unreachable server is already surfaced as stale
 * rows by markSnapshotStale().
 *
 * BUG-030's honest case is untouched: a zombie of a cut host CLI is absent from
 * the fresh snapshot, so it still settles to "cut by shutdown".
 */
let cutCandidates = null; // Set<agentId> awaiting a qualifying snapshot, or null

/** turn-end: nominate every row that MAY be a zombie. Settles nothing. */
function nominateCutAgents() {
  const ids = new Set();
  for (const [id, cur] of state.agents) {
    if (!cur.settled && cur.agent.status === 'running') ids.add(id);
  }
  cutCandidates = ids.size ? ids : null;
  return ids.size;
}

/**
 * The judgement, against the server's own post-turn answer. The ONLY path that
 * can settle a row as cut at turn-end — there is deliberately no fallback that
 * settles without a snapshot in hand.
 */
function settleCutAgentsAgainst(snap) {
  if (!cutCandidates) return 0;
  // Positive evidence only: a snapshot computed while the turn was still
  // running says nothing about what outlived it.
  if (!snap || !snap.turn || snap.turn.running !== false) return 0;
  const alive = new Set(snap.running.map((r) => r.id).filter(Boolean));
  let n = 0;
  for (const id of cutCandidates) {
    if (alive.has(id)) continue; // the server still vouches for it — live background work
    const cur = state.agents.get(id);
    if (!cur || cur.settled || cur.agent.status !== 'running') continue;
    settleCut(cur);
    n++;
  }
  // Judged either way: rows the snapshot vouched for are released, not re-judged
  // on the next snapshot (their own completion frames will settle them).
  cutCandidates = null;
  if (n) renderStrip();
  return n;
}

/**
 * BUG-030 — reattach half of the invariant. Called on the `start` ack: rows
 * already on screen (an open tab that lived through a server/CLI cut keeps its
 * state.agents) are only alive if this attach's replayAgents() re-announces
 * them, and those frames land right behind the ack. Snapshot what exists now,
 * give the replay a beat, then settle whatever nothing refreshed.
 */
let cutSweepTimer = null;
function scheduleCutSweep() {
  const snap = new Map();
  for (const [id, cur] of state.agents) {
    if (!cur.settled && cur.agent.status === 'running') snap.set(id, cur.seenAt ?? 0);
  }
  if (!snap.size) return;
  clearTimeout(cutSweepTimer);
  cutSweepTimer = setTimeout(() => {
    let n = 0;
    for (const [id, seen] of snap) {
      const cur = state.agents.get(id);
      if (!cur || cur.settled || cur.agent.status !== 'running') continue;
      if ((cur.seenAt ?? 0) !== seen) continue; // refreshed since the ack — genuinely alive
      settleCut(cur);
      n++;
    }
    if (n) renderStrip();
  }, 1500);
}

/** A finished subagent leaves one navigable hairline row in the main thread. */
function settleAgent(entry) {
  const a = entry.agent;
  const th = mainThread();
  const stats = `${mmss(a.elapsedMs)} · ${a.toolUses} tool${a.toolUses === 1 ? '' : 's'} · ${kilo(a.totalTokens)}`;
  const agentThread = state.threads.get(a.agentId);
  if (agentThread) {
    agentThread.status = a.status;
    agentThread.stats = stats;
    agentThread.agentType = a.agentType || agentThread.agentType;
    agentThread.description = a.description || agentThread.description;
    agentThread.loaded = true; // its messages already streamed into the pane
    refreshLede(agentThread);
    if (state.viewing === a.agentId) paintComposerFor(agentThread);
  }
  const text = state.agentText.get(a.agentId);
  const body = el('div', { class: 'ran-out' },
    text ? prose(text) : el('div', { class: 'prose' }, el('p', {
      text: a.status === 'completed' ? 'No text was returned.'
        // BUG-030: the honest terminal state for a call/agent whose result
        // frame died with a cut host CLI — never "still running".
        : a.status === 'cut' ? 'Cut by shutdown — the host CLI was stopped mid-flight (server restart or shutdown) and no result was recorded.'
          : `Ended: ${a.status}.`,
    })),
    el('div', { class: 'fields' },
      el('span', {}, document.createTextNode('duration_ms '), el('b', { text: a.elapsedMs.toLocaleString() })),
      el('span', {}, document.createTextNode('tool_uses '), el('b', { text: String(a.toolUses) })),
      el('span', {}, document.createTextNode('total_tokens '), el('b', { text: a.totalTokens.toLocaleString() })),
      el('span', {}, document.createTextNode('status '), el('b', { text: a.status }))));
  ranRow(th, { agentId: a.agentId, agentType: a.agentType, description: a.description, status: a.status, stats, body });
  if (state.viewing === 'main') scrollDown();
}

/* -------------------------------------------------------------- approvals */

function renderAsk(e) {
  node.asks.hidden = false;
  const box = el('div', { class: 'ask' });
  let arg = '';
  try { arg = typeof e.input === 'string' ? e.input : JSON.stringify(e.input, null, 2); } catch { arg = '(uninspectable input)'; }
  box.append(el('div', { class: 'hd' },
    el('span', { class: 'nm', text: e.toolName }),
    el('span', { class: 'ti', text: e.title || e.description || 'wants permission to run' }),
    el('span', { class: 'who', text: e.agentId ? 'subagent' : 'main' })));
  box.append(el('div', { class: 'arg', text: arg }));

  const acts = el('div', { class: 'acts' });
  const verdict = el('span', { class: 'verdict' });
  const answer = (allow) => {
    const word = allow ? 'allowed' : 'denied';
    for (const b of acts.querySelectorAll('button')) b.disabled = true;
    verdict.textContent = `sending ${word}…`;

    const restore = (why) => {
      // Nothing landed — say so and give the decision back to the user.
      delete box.dataset.done;
      verdict.textContent = `not ${word} — ${why}`;
      for (const b of acts.querySelectorAll('button')) b.disabled = false;
    };

    if (!send({ type: 'approval-response', requestId: e.requestId, allow })) {
      return restore('no live connection, nothing was sent');
    }

    // The ack echoes requestId, so concurrent approvals match exactly.
    const pending = {
      settle: (matched) => {
        clearTimeout(pending.timer);
        if (matched === false) return restore('the server had no such pending request');
        box.dataset.done = word;
        verdict.textContent = `${word} · confirmed by the server`;
        for (const b of acts.querySelectorAll('button')) b.remove();
        state.asks.delete(e.requestId);
        setTimeout(() => {
          box.remove();
          if (!node.asks.childElementCount) node.asks.hidden = true;
        }, 2600);
      },
      fail: (why) => { clearTimeout(pending.timer); restore(why); },
    };
    pending.timer = setTimeout(() => {
      state.pendingAnswers.delete(e.requestId);
      restore('the server never confirmed');
    }, 6000);
    state.pendingAnswers.set(e.requestId, pending);
  };
  const deny = el('button', { class: 'mini', text: 'Deny' });
  deny.addEventListener('click', () => answer(false));
  const allow = el('button', { class: 'solid', text: 'Allow' });
  allow.addEventListener('click', () => answer(true));
  acts.append(verdict, el('span', { class: 'grow' }), deny, allow);
  box.append(acts);

  node.asks.append(box);
  state.asks.set(e.requestId, box);
  scrollDown();
}

/* ------------------------------------------------------- decisions (Q / plan) */
/*
 * `AskUserQuestion` and `ExitPlanMode` are moments where the model STOPS and
 * waits for a person. They render inline, at the point Claude asked, because
 * they are part of the conversation — not a modal that hides the reasoning that
 * led to the question.
 *
 * The settle discipline is the approvals one, for the same reason: an answer is
 * only real once the server acks it. `pendingAnswers` is shared with approvals
 * and keyed by requestId, so concurrent decisions match exactly.
 */

const DECISION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/** Cards live per thread so a subagent's question lands in its own transcript. */
function decisionMap(th) {
  if (!th.decisions) th.decisions = new Map();
  return th.decisions;
}

/** Returns true when the tool-call was rendered as a decision card. */
function renderDecisionCall(th, e) {
  if (!DECISION_TOOLS.has(e.name)) return false;
  if (e.name === 'AskUserQuestion') {
    const questions = parseQuestions(e.input);
    // An unparseable question must fall back to the chip rather than showing an
    // empty card — a blank card would hide the question entirely.
    if (!questions.length) return false;
    renderQuestion(th, { toolUseId: e.toolUseId, requestId: e.requestId ?? null, questions });
    return true;
  }
  const plan = parsePlan(e.input);
  if (!plan) return false;
  renderPlan(th, { toolUseId: e.toolUseId, requestId: e.requestId ?? null, plan });
  return true;
}

/**
 * Send a decision and refuse to show it as settled until the ack arrives.
 * Mirrors renderAsk()'s pending/settle/fail shape exactly.
 */
function sendDecision({ requestId, payload, ui, onMatched, word = 'answer' }) {
  ui.sending(word);
  if (!send(payload)) return ui.failed('no live connection, nothing was sent');

  const pending = {
    settle: (matched) => {
      clearTimeout(pending.timer);
      if (matched === false) return ui.failed('the server had no such pending request');
      onMatched();
    },
    fail: (why) => { clearTimeout(pending.timer); ui.failed(why); },
  };
  pending.timer = setTimeout(() => {
    state.pendingAnswers.delete(requestId);
    ui.failed('the server never confirmed');
  }, 6000);
  state.pendingAnswers.set(requestId, pending);
}

function renderQuestion(th, { toolUseId, requestId, questions }) {
  const existing = toolUseId && decisionMap(th).get(toolUseId);
  if (existing) {
    // The typed event can follow the tool-call for the same question; adopt the
    // requestId rather than drawing the card twice.
    if (requestId && !existing.requestId) upgradeAnswerable(existing, requestId);
    return existing;
  }

  const card = createQuestionCard({
    questions,
    answerable: !!requestId,
    onSubmit: (answers, ui) => {
      sendDecision({
        requestId: card.requestId,
        payload: { type: 'question-response', requestId: card.requestId, answers },
        ui,
        word: 'answer',
        onMatched: () => { card.answered = true; ui.answered(answers); },
      });
    },
  });
  card.requestId = requestId;
  card.kind = 'question';
  card.questions = questions;

  appendDecision(th, card.node);
  if (toolUseId) decisionMap(th).set(toolUseId, card);
  if (requestId) state.decisionsByRequest.set(requestId, card);
  return card;
}

function renderPlan(th, { toolUseId, requestId, plan }) {
  const existing = toolUseId && decisionMap(th).get(toolUseId);
  if (existing) {
    if (requestId && !existing.requestId) upgradeAnswerable(existing, requestId);
    return existing;
  }
  const card = createPlanCard({
    plan,
    answerable: !!requestId,
    onDecide: (approved, ui) => {
      sendDecision({
        requestId: card.requestId,
        payload: { type: 'plan-response', requestId: card.requestId, approved },
        ui,
        word: approved ? 'approval' : 'rejection',
        onMatched: () => { card.answered = true; ui.decided(approved); },
      });
    },
  });
  card.requestId = requestId;
  card.kind = 'plan';
  appendDecision(th, card.node);
  if (toolUseId) decisionMap(th).set(toolUseId, card);
  if (requestId) state.decisionsByRequest.set(requestId, card);
  return card;
}

/** A requestId arrived after the card was drawn — rebuild it as answerable. */
function upgradeAnswerable(card, requestId) {
  card.requestId = requestId;
  state.decisionsByRequest.set(requestId, card);
  // Actually add the submit / decision buttons. This previously only swapped
  // the note for a "ready" label, which left the user with a selectable
  // question and nothing to press.
  card.ui?.enable?.();
}

/**
 * Put the card in the transcript and make sure it is not missed.
 *
 * A decision is the one thing a user must not scroll past, so when they are
 * scrolled away it deliberately lights the `Latest` pill instead of yanking
 * the viewport — same rule as every other append, but flagged as unseen.
 */
function appendDecision(th, node) {
  claudeBody(th).append(node);
  if (state.viewing === th.key) {
    if (th.stick === false) { th.unseen = true; paintJump(); }
    else scrollDown();
  } else {
    th.unseen = true;
  }
}

/**
 * The tool returned. If no ack ever settled this card, the model proceeded
 * WITHOUT an answer — the exact failure that started this work.
 */
function settleDecisionFromResult(card, e) {
  if (card.answered) return;
  if (card.kind === 'plan') {
    return markUnanswered(card.node, 'No decision was sent — the session continued without your approval.');
  }
  markUnanswered(card.node, e.isError
    ? 'The question errored out — no answer was recorded.'
    : 'No answer was given — the session continued without your choice.');
}

/* -------------------------------------------------------------- websocket */

/*
 * BUG-153 — THE liveness predicate. One question, asked in one place: does this
 * tab hold a socket it can actually drive this session over, right now?
 *
 * It exists because the status the user READ and the guard that REFUSED their
 * action were computed from different things. computeSessState() decided
 * "Claude is working" from `state.busy` alone and decided "running in the
 * background" from `state.sessDetached` — an EVENT-set flag, raised on one
 * reopen path and cleared by ANY socket open, including one belonging to a
 * different session or to a `start` the server went on to refuse. Meanwhile
 * forceSend/flushQueue/the interrupt button asked the honest question
 * (`state.live && state.ws`). Two answers that could not be reconciled: a
 * session presented as attached and working, over which nothing could be sent.
 *
 * So the flag is gone, and every one of those callers now reads this. They can
 * disagree again only by someone re-deriving liveness somewhere else.
 *
 * Three clauses, each carrying its own case:
 *  - `state.live` — a socket was opened and has not closed.
 *  - `readyState === OPEN` — and it is not mid-close; `send()` already refuses
 *    a CLOSING socket, so anything gated on this predicate must too.
 *  - `!state.deliveryRelay` — FEAT-065's relay socket is open but holds NO
 *    session: it exists only to carry approvals for a turn delivered into a
 *    drain-held survivor. Sending over it earns "no session on this socket",
 *    which is precisely the refusal this predicate exists to predict.
 */
function isDriving() {
  return !!(state.live && state.ws && state.ws.readyState === WebSocket.OPEN && !state.deliveryRelay);
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    const fail = () => reject(new Error('the session socket would not open'));
    ws.addEventListener('open', () => {
      state.ws = ws;
      state.live = true;
      state.closingOnPurpose = false;
      state.dropped = false;
      state.sessReconnecting = false;
      state.budgetLocked = false;
      state.budgetLockReason = '';
      state.pendingSend = null;
      paintSessStatus();
      resolve(ws);
    });
    ws.addEventListener('error', fail);
    ws.addEventListener('close', () => {
      const wasLive = state.live;
      state.live = false;
      state.ws = null;
      state.deliveryRelay = null; // FEAT-065: the approval relay is per-socket state
      setBusy(false);
      // Our own close() is routine. A close we did not ask for, on a session
      // that had started, is a fault the user must see — and until they
      // resolve it we refuse to send, because the alternative (silently
      // starting a fresh session) throws away the conversation on screen.
      if (!state.closingOnPurpose && wasLive && state.sdkSessionId) {
        state.dropped = true;
        say('the session connection dropped — nothing on screen was lost, but the agent is no longer attached', true);
        paintComposerFor(viewedThread());
      }
      state.closingOnPurpose = false;
      paintSessStatus();
      for (const [, p] of state.pendingAnswers) p.fail('the socket closed before the server confirmed');
      state.pendingAnswers.clear();
      // An in-flight mode change dies with the socket; never leave the button
      // implying a switch that was never confirmed.
      if (permModePending) finishPermMode(permModePending.requestId, false, 'the connection dropped before the server confirmed');
      if (modelPending) finishModel(modelPending.requestId, false, 'the connection dropped before the server confirmed');
      renderTree();
    });
    ws.addEventListener('message', (ev) => {
      let e;
      try { e = JSON.parse(ev.data); } catch { return say('malformed event from the server', true); }
      onEvent(e);
    });
  });
}

/* ------------------------------------------------------- auto-follow (external) */
/*
 * A session running in another terminal is written to disk by a process this
 * dashboard did not spawn, so there is no bridge and there are no token
 * deltas. The server watches the file and pushes `session-appended` with whole
 * persisted messages, a second or two behind. That is what this consumes — it
 * is FOLLOW, not streaming, so nothing here fakes a caret or a typing effect.
 *
 * Why a second socket: `state.ws` exists only while the dashboard is driving a
 * session (openSession closes it), which is precisely when we do NOT need
 * appends. This one is passive — it never sends a command, so the server never
 * gives it a session — and it stays open for the life of the page, which is
 * when we DO need appends. The driving socket ignores `session-appended`
 * outright so a broadcast reaching both cannot be applied twice.
 */

const WATCH_BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];

function watch() {
  if (state.watchWs) return;
  let ws;
  try { ws = new WebSocket(`ws://${location.host}/ws`); } catch { return; }
  state.watchWs = ws;
  ws.addEventListener('open', () => {
    state.watchTries = 0;
    // A reconnect must re-ask: follows live on the socket that requested them.
    // Except while parked in history — the gap machinery owns the tail then.
    followCurrent(!mainThread().gap);
  });
  ws.addEventListener('message', (ev) => {
    let e;
    try { e = JSON.parse(ev.data); } catch { return; }
    if (e?.t === 'session-appended') return applyAppend(e);
    if (e?.t === 'follow-status') return onFollowStatus(e);
  });
  const retry = () => {
    if (state.watchWs !== ws) return;
    state.watchWs = null;
    const wait = WATCH_BACKOFF_MS[Math.min(state.watchTries++, WATCH_BACKOFF_MS.length - 1)];
    setTimeout(watch, wait);
  };
  ws.addEventListener('close', retry);
  ws.addEventListener('error', () => { try { ws.close(); } catch { /* already gone */ } });
}

/**
 * The watched file was truncated or rotated, so the appends that follow are not
 * a continuation of what is rendered. Reload the session from scratch.
 */
function resyncTranscript() {
  const cur = state.current;
  const p = state.projects.find((x) => x.id === cur.projectId);
  if (!p || !cur.sessionId || !cur.encodedDir) return;
  say('this session file was rewritten on disk — reloading the transcript');
  return openSession(p, { encodedDir: cur.encodedDir, sessionId: cur.sessionId, displayTitle: cur.title, os: cur.os });
}

/** Ask the server to watch whatever session is on screen. Silent no-op if it can't. */
function followCurrent(follow = true) {
  const ws = state.watchWs;
  const { sessionId, encodedDir } = state.current;
  // Dropping the watches means NOT following, immediately — waiting for the
  // server to confirm would leave `following` asserting the previous session's
  // state. It flips back to true only when a follow-status says so.
  state.following = false;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({ type: 'unfollow' }));           // no args = drop all
    // `follow=false` drops every watch and stops there — used while a restored
    // view is parked in history, where appends must not be spliced on anyway.
    if (follow && sessionId && encodedDir) ws.send(JSON.stringify({ type: 'follow', sessionId, dir: encodedDir }));
  } catch { /* the socket died between the check and the send; the reconnect re-follows */ }
}

/**
 * The server's answer to `follow`. A refusal is normal in one case — it will
 * not watch a session the dashboard's own bridge is driving — so that one is
 * silent. Any OTHER refusal means the user is looking at a session that will
 * not update, and they are told, because a stale transcript that looks live is
 * the exact bug this feature exists to remove.
 */
function onFollowStatus(e) {
  if (e.sessionId !== state.current.sessionId) return;
  state.following = e.following === true;
  if (e.following) return;
  // Expected refusal: the dashboard's own bridge is already feeding this
  // session, and watching the file too would double-emit. Not an error.
  if (isBridged(e.sessionId) || /driven by the dashboard/i.test(e.reason ?? '')) return;
  if (e.reason) say(`not following this session live: ${e.reason}`, true);
}

/** True when the dashboard itself is driving this session id over the bridge. */
function isBridged(sessionId) {
  if (!state.live) return false;
  return state.sdkSessionId === sessionId || (state.busy && state.current.sessionId === sessionId);
}

function applyAppend(e) {
  const cur = state.current;
  if (!cur.sessionId || e.sessionId !== cur.sessionId) return;      // not what is on screen
  if (e.dir && cur.encodedDir && e.dir !== cur.encodedDir) return;  // same id, other store dir
  if (isBridged(e.sessionId)) return;                               // the bridge already showed it

  // The file shrank under the watcher, so the cursor restarted: what follows is
  // NOT a continuation of what is on screen. Splicing it on would fabricate a
  // conversation that never happened — refetch instead.
  if (e.resynced === true) return void resyncTranscript();

  const msgs = Array.isArray(e.messages) ? e.messages : [];
  if (!msgs.length) return;

  const th = mainThread();
  // Parked in history with newer messages still unfetched: an append rendered
  // after the window would sit directly under a message it did not follow.
  // Refuse it — the gap machinery fetches everything in order instead.
  if (th.gap) {
    for (const m of (Array.isArray(e.messages) ? e.messages : [])) {
      if (Number.isInteger(m?.index)) th.gap.total = Math.max(th.gap.total, m.index + 1);
    }
    return;
  }
  // Appends now carry REAL sequential indices continuing from the file's end
  // (one coordinate system with the tail page), so dedupe is a plain index
  // comparison: the tail page and the first append can overlap by a message or
  // two when the file grew between the two reads — those are dropped by index.
  const fresh = msgs.filter((m) => Number.isInteger(m?.index)
    ? (th.lastIndex == null || m.index > th.lastIndex)
    : true); // an index-less message cannot be deduped, so show it
  if (!fresh.length) return;
  for (const m of fresh) if (Number.isInteger(m.index)) th.lastIndex = Math.max(th.lastIndex ?? -1, m.index);

  // A persisted message is a complete unit; end any half-open stream first so
  // it does not get appended into the previous turn's body.
  finishStream(th);
  th.claudeBody = null;
  const shown = renderMessages(th, fresh);
  if (!shown) return;
  if (th.page && Number.isInteger(th.page.total)) th.page.total += fresh.length;
  // Straight into the existing rule: follow if stuck, otherwise light the pill.
  if (state.viewing === 'main') scrollDown();
}

/* -------------------------------------------------------- live session badges */
/*
 * "Being written by something else right now." Quiet by construction: the same
 * moss dot the app already uses for alive, on the row, with a slow pulse. No
 * word, no colour that is not already in the palette. If the server does not
 * report it, nothing is drawn — an absent signal must not look like "nothing
 * is running".
 */

const LIVE_POLL_MS = 5000;
const liveKey = (dir, sessionId) => `${dir ?? ''} ${sessionId}`;

/**
 * The server's record for `sessionId` IF it is being written LIVE right now —
 * by a dashboard bridge OR an external terminal — else null.
 *
 * Liveness is the UNION of two signals, because neither alone is complete:
 *  - the mtime live list (`/api/sessions/live`, `LIVE_WINDOW_MS = 30s`) — catches
 *    an external terminal writing the jsonl, but DROPS a session that is still
 *    running yet idle >30s (thinking, between writes).
 *  - a live BRIDGE (`/api/sessions`, by `sdkSessionId`) — catches a session this
 *    server still owns regardless of file recency, which is exactly the
 *    bridge-driven-but-mtime-idle case that made reload dump the historical
 *    "N agents ran" summary into the streaming tail (BUG-004).
 * If EITHER says live, the session is live and must NOT get the summary. A
 * genuinely finished session (NO bridge AND stale file) matches neither and
 * correctly still shows the summary — the review view.
 */
async function liveRecordFor(sessionId) {
  if (!sessionId || state.live) return null; // our own bridge already owns the tail
  let list;
  try { list = await api.liveSessions(); } catch { return null; }
  const mtimeRec = (list ?? []).find((x) => x.sessionId === sessionId);
  if (mtimeRec) return mtimeRec; // authoritative: already carries drivenByDashboard/busy
  // Not in the mtime list — but a live bridge for this sdk id means the session
  // is still running server-side, just idle on disk. Treat it as live, and as
  // dashboard-driven (a bridge IS this dashboard's server owning the session).
  let bridges;
  try { bridges = await api.liveBridges(); } catch { return null; }
  const bridge = (bridges ?? []).find((b) => b.sdkSessionId === sessionId);
  // BUG-033: carry the bridge's honest turn clock through with its busy flag —
  // `undefined` on an older server, which openSession renders as an unknown
  // duration rather than a stopwatch started at reopen.
  if (bridge) return { sessionId, dir: null, drivenByDashboard: true, busy: bridge.busy, turnStartedAt: bridge.turnStartedAt };
  return null;
}

async function refreshLive() {
  if (state.caps.live === false) return;
  let list;
  try {
    list = await api.liveSessions();
  } catch {
    return; // transient; the next poll tries again
  }
  if (list === null) {
    state.caps.live = false; // route not on this server — stop asking, draw nothing
    if (state.liveIds.size) { state.liveIds.clear(); renderTree(); }
    return;
  }
  state.caps.live = true;
  /*
   * The route is now the ONLY authority. The `live` flag on the session list is
   * a snapshot from whenever that list was fetched, and merging it in kept a
   * badge burning for a session that had been finished for a minute — the exact
   * dishonesty this feature is supposed to remove. The flag is still used, but
   * only as a fallback when the route is absent (see liveInfo).
   */
  const next = new Map(list.map((x) => [liveKey(x.dir, x.sessionId), x]));
  // Following a run we don't drive (opened while it was still live): when the
  // server stops reporting it as busy, the run ended — flip honestly to idle.
  // BUT the mtime list is not the whole story: a session still owned by a live
  // BRIDGE (idle, just not writing its jsonl) has dropped out of this list yet is
  // NOT finished — tearing the follow down for it is the same mtime blindness that
  // made reload dump the agent summary (BUG-004). Only declare the run over when
  // NEITHER the mtime list (busy) NOR a live bridge still owns the session.
  if (state.followingLive && state.current.sessionId) {
    const mine = list.find((x) => x.sessionId === state.current.sessionId && x.drivenByDashboard && x.busy);
    if (!mine) {
      let bridged = false;
      // On error, keep following rather than falsely declare the run over.
      try { bridged = (await api.liveBridges() ?? []).some((b) => b.sdkSessionId === state.current.sessionId); }
      catch { bridged = true; }
      if (!bridged) {
        state.followingLive = false;
        setBusy(false);
        state.turnStartedAt = 0;
        say('the run finished');
        void refreshCurrentProjectSessions();
      }
    }
  }
  const same = next.size === state.liveIds.size && [...next.keys()].every((k) => state.liveIds.has(k));
  // A session that WAS live and no longer is = Claude finished work there.
  // Its row's lastActivityAt is stale until the list refetches, and the
  // unseen badge reads that field — so refresh the lists of the projects
  // whose live sessions just ended, or "finished" would never badge.
  const ended = [...state.liveIds.entries()].filter(([k]) => !next.has(k));
  state.liveIds = next;
  // BUG-045: a drain-wait row retries the moment its session leaves the live
  // set — that transition IS "the drain settled". The slow interval in
  // armDrainWaitRetry stays as the fallback for a transition this poll missed.
  if (ended.some(([, rec]) => state.queue.some((q) => !q.dead && q.drainWait === rec.sessionId))) {
    attemptDrainRetry({ immediate: true });
  }
  for (const [, rec] of ended) {
    for (const [projectId, s] of state.sessions) {
      if (!s.loaded) continue;
      if ((rec.dir && s.dirs?.includes(rec.dir)) || s.list.some((x) => x.sessionId === rec.sessionId)) {
        void loadSessions(projectId, { force: true });
        break;
      }
    }
  }
  if (!same) renderTree(); // only repaint when the answer actually changed
}

function startLivePolling() {
  if (state.liveTimer) return;
  const tick = () => { if (!document.hidden) void refreshLive(); };
  void refreshLive();
  state.liveTimer = setInterval(tick, LIVE_POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshLive(); });
}

/** The liveness record for a sidebar row, or null when nothing is writing it. */
function liveInfo(sess) {
  const hit = state.liveIds.get(liveKey(sess.encodedDir, sess.sessionId));
  if (hit) return hit;
  // Only trust the row's own flag while the route cannot be consulted: it is as
  // old as the list it came with, and a stale one is a badge that lies.
  if (state.caps.live !== true && sess.live === true) {
    return { sessionId: sess.sessionId, dir: sess.encodedDir, drivenByDashboard: false };
  }
  return null;
}

function closeSocket() {
  // Only claim intent when a socket actually exists — otherwise the flag
  // survives to the NEXT socket and makes a genuine drop look routine.
  state.closingOnPurpose = !!state.ws;
  if (state.ws) {
    try { state.ws.send(JSON.stringify({ type: 'close' })); state.ws.close(); } catch { /* already gone */ }
  }
  state.ws = null;
  state.live = false;
  state.dropped = false;
  state.deliveryRelay = null; // FEAT-065: the relay (if that is what this was) dies with its socket
  state.resumeOnNextSend = null;
  state.sdkSessionId = null;
  state.effective = null;
  state.liveTools = null; // FEAT-051 — the live attach report died with the socket
  paintIntegrations();    //            back to the planned (hollow) view
  state.startSnapshot = null;
  state.pendingAnswers.clear();
  // FEAT-042: the chip's live report and change-baseline belong to the socket's
  // session — a new session must start clean, never inherit a stale flag.
  liveWireModel = null;
  expectedLiveModel = null;
  clearModelFlag();
  paintModelChip();
  setBusy(false);
}

/**
 * Re-arm the dropped session. We deliberately do NOT fire a turn here: the
 * bridge can only attach by starting one, and inventing a prompt on the user's
 * behalf spends their money on a message they never wrote. Instead the next
 * message they send resumes the same SDK session, with the transcript intact.
 */
function reconnectDropped() {
  const resume = state.sdkSessionId;
  if (!resume) return say('nothing to resume — start a new session', true);
  state.dropped = false;
  state.resumeOnNextSend = resume;
  paintSessStatus();
  const th = mainThread();
  th.claudeBody = null;
  th.paneEl.append(el('div', { class: 'ran-lbl', text: `reconnected · resuming session ${resume.slice(0, 8)} on your next message` }));
  paintComposerFor(viewedThread());
  say(`ready — your next message resumes session ${resume.slice(0, 8)}`);
  node.prompt.focus();
}

/** Returns true only when the frame was actually handed to an OPEN socket. */
function send(cmd) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    say('no live session on this socket', true);
    return false;
  }
  try {
    state.ws.send(JSON.stringify(cmd));
    return true;
  } catch (err) {
    say(`could not send: ${err.message}`, true);
    return false;
  }
}

/**
 * True for the ONE error that means "this session will never send again":
 * either the server's authoritative `budgetStopped:true` flag (the initial
 * budget-stop notice, fired independent of any send), or — belt and braces,
 * since the flag only travels on that one event — the exact rejection
 * message `AgentSession.send()` throws for a budget-stopped session
 * (agent-bridge.ts `session stopped: budget exceeded`), which reaches the
 * client through the generic ws catch with no flag attached. Matched on the
 * literal string, not a substring, so an unrelated error never mis-fires this.
 */
function isBudgetStop(e) {
  return e.budgetStopped === true || e.message === 'session stopped: budget exceeded';
}

/**
 * Undo the optimistic "you" bubble `submit()` paints before the server has
 * confirmed delivery. Mirrors what the mid-turn queue already does for a
 * message that never reached Claude (see queueMessage/failQueue) — a bubble
 * must never claim delivery for a turn the agent never saw (BUG-013).
 */
function rollBackPendingSend() {
  const pending = state.pendingSend;
  state.pendingSend = null;
  if (!pending) return;
  pending.el.remove();
  // Give the text back to the composer rather than dropping it — the user
  // should not have to retype a message that silently failed to send.
  if (!node.prompt.value) node.prompt.value = pending.text;
  autosize();
}

/**
 * BUG-029: a `start`/resume the server refused BEFORE it acked — i.e. the turn
 * never began. The prime case is BUG-022's guard, which refuses to resume while
 * a prior server's FEAT-015 survivor broker is still draining the SAME
 * transcript ("still finishing its previous turn after a server restart…"). That
 * refusal is RETRYABLE, but the old path left the optimistic bubble on screen,
 * dropped the typed text (it lives nowhere on disk — a reload loses it), and
 * armed a 4s watchdog whose "composer released" flip-flopped the status banner.
 * Undo it honestly instead: pull the phantom bubble, hand the text back to the
 * composer, tear down the half-open socket (it has no server-side session, so it
 * could only answer a retry with "no session on this socket"), and arm the next
 * Enter to re-attempt the SAME resume so one keystroke retries cleanly.
 */
function rollBackPendingStart() {
  const text = state.pendingStart;
  const resume = state.pendingStartResume;
  // BUG-132: a self-retry's text belongs to its queue row, not to the composer —
  // returning it here overwrote the user's in-progress typing every 7s.
  const keepComposer = state.pendingStartKeepComposer;
  state.pendingStart = null;
  state.pendingStartResume = null;
  state.pendingStartKeepComposer = false;
  // The optimistic bubble startTurn painted is the last top-level `.you` in main
  // (same idiom the reattach path uses to reclaim it into the queue).
  const bs = mainThread().paneEl.querySelectorAll(':scope > .you');
  bs[bs.length - 1]?.remove();
  if (text && !keepComposer && !node.prompt.value) { node.prompt.value = text; autosize(); }
  // Close the socket we opened for this refused start; without a server-side
  // session a retry over it only earns "no session on this socket".
  if (state.ws) { state.closingOnPurpose = true; try { state.ws.close(); } catch { /* already gone */ } }
  if (resume) state.resumeOnNextSend = resume; // next Enter re-attempts the same resume
  setBusy(false);
  state.turnStartedAt = 0;
  state.sessReconnecting = false;
  paintSessStatus();
}

/**
 * BUG-149 — the server refused this send because ANOTHER TAB is driving the
 * session (`code: 'live-elsewhere'`). Two things went wrong before, and the
 * second is the one that cost the user their words:
 *
 *  1. The refusal arrived as a `fatal` error frame, so it fell into the generic
 *     fatal branch below: `say()` put it in the transient footer strip and
 *     `console.warn`, which is where the user eventually found it — after
 *     waiting for a reply that could never come. That branch also latched
 *     `sessError` and marked every OTHER queued row dead ("the session hit a
 *     fatal error"), which is simply false: the session is alive and well, in
 *     the other tab.
 *  2. The fatal branch RETURNS before the BUG-029 pre-ack hand-back, so
 *     `state.pendingStart` — the only copy of the typed text anywhere — was
 *     never reclaimed. Nothing persisted it and a reload destroyed it. That is
 *     exactly the loss BUG-129 shipped storage durability to end; this route
 *     never reached the code that stores.
 *
 * The invariant restored here, in the user's words: keep it in browser storage
 * unless the server acknowledged it. The text becomes an ordinary dock row —
 * durable through persistQueue, saying plainly that it was NOT delivered, and
 * recoverable into the composer in one click — and never a bubble claiming a
 * delivery the server explicitly refused. It is deliberately NOT auto-resent
 * when the other tab lets go: sending a person's message on their behalf,
 * minutes later, into a conversation that has moved on is a different harm
 * (the same reason BUG-129's restored rows come back dead).
 */
function handleLiveElsewhere(message) {
  const fromStart = state.pendingStart != null;
  const text = fromStart ? state.pendingStart : (state.pendingSend?.text ?? null);
  const resume = state.pendingStartResume;
  state.pendingStart = null;
  state.pendingStartResume = null;
  state.pendingStartKeepComposer = false;
  // Reclaim the optimistic bubble — the turn never began, so nothing was said.
  // Which bubble depends on which path painted it, and guessing wrong would
  // delete an innocent message: `pendingSend` knows its own element, while a
  // refused `start` is the last top-level `.you` (rollBackPendingStart's idiom).
  if (fromStart) {
    // The exact element, recorded when the start painted it. The old "last
    // top-level .you" idiom is a guess, and in a two-tab session it guesses
    // wrong: the transcript follower appends the OTHER tab's real messages
    // while this one waits for its ack. Falling back to it only when there is
    // no recorded element keeps the older paths' behaviour unchanged.
    if (state.pendingStartEl) state.pendingStartEl.remove();
    else {
      const bs = mainThread().paneEl.querySelectorAll(':scope > .you');
      bs[bs.length - 1]?.remove();
    }
  }
  state.pendingStartEl = null;
  if (state.pendingSend) { state.pendingSend.el.remove(); state.pendingSend = null; }
  // Close the half-open socket this refused start opened: it has no server-side
  // session, so a retry over it could only earn "no session on this socket".
  if (state.ws) {
    state.closingOnPurpose = true;
    try { state.ws.close(); } catch { /* already gone */ }
    // Mark it dead NOW rather than at its close event — setBusy(false) below
    // schedules a flush, and a still-"live" closing socket would push rows into
    // a session-less socket (the window queueRetryableRefusal guards the same way).
    state.ws = null;
    state.live = false;
  }
  if (resume) state.resumeOnNextSend = resume; // one Enter re-attempts the same resume
  setBusy(false);
  state.turnStartedAt = 0;
  state.sessReconnecting = false;
  if (text && text.trim()) {
    const storable = queueTargetKey() != null;
    state.queue.push({
      text,
      dead: 'another tab is driving this session',
      composedAt: Date.now(),
    });
    // paintQueue mirrors the row into storage (BUG-129: every mutation repaints,
    // and that repaint IS the write path).
    paintQueue();
    if (!storable) {
      // Storage is unavailable / this view owns no session key: the row is on
      // screen but WILL NOT survive a reload. Say so rather than imply durability.
      say('your message is in the dock but could not be saved for a reload — copy it out before reloading', true);
    }
  }
  state.liveElsewhere = message;
  say(message, true);
  paintSessStatus();
  paintComposerFor(viewedThread());
}

/*
 * BUG-090 — the server refused a plain resume ONLY because the session was
 * recorded under a pre-isolation store dir (classically: before the container
 * was enabled, when the cwd — and so the encoded store dir — was different).
 * Roll the optimistic start back, then arm a one-click fork bar with plain,
 * context-aware copy. ONE CLICK, never a silent auto-fork: forking mints a new
 * session id, so branching is always the user's explicit act.
 */
function armNeedsFork(nf) {
  // The turn never began (pendingStart still set): reclaim the phantom bubble
  // and the typed text and close the refused socket. rollBack re-arms a plain
  // resume, but pendingFork/forkFrom win in submit(), so the next send forks.
  if (state.pendingStart != null) rollBackPendingStart();
  else setBusy(false);
  state.resumeOnNextSend = null; // a plain resume cannot work here — the fork replaces it
  state.sessError = null;        // not a dead end; the fork bar is the way forward
  state.pendingFork = { resumeSessionId: nf.resumeSessionId, resumeEncodedDir: nf.resumeEncodedDir, cause: nf.cause };
  say(nf.cause === 'isolation-changed'
    ? 'This session was recorded before you enabled the container — resuming it here can’t reach that history. Fork it into the container to continue; the original stays on the host.'
    : nf.cause === 'path-changed'
      // BUG-138: the project's directory was renamed and the project repointed.
      // The transcript is intact and still listed — the CLI just cannot continue
      // a conversation in a directory that no longer exists under that name.
      ? 'This session ran before this project’s directory was renamed — the history is intact, but it can’t resume against the old path. Fork it to continue here; the original stays untouched.'
      : 'This session was recorded on another machine — it can’t resume here. Fork it into a session on this machine; the original stays untouched.');
  paintComposerFor(viewedThread());
}

/*
 * BUG-090 — the fork bar (#frozen) is shared by two "can't resume here, fork
 * it" cases, so its copy and the #forkBtn label are context-aware. `ctx` null =
 * the Windows-origin default (client-detected, os==='windows'); a pendingFork
 * object = the server's needs-fork signal (container vs cross-OS).
 */
function paintFrozenBar(ctx) {
  const span = node.frozen.querySelector('span');
  const btn = $('#forkBtn');
  if (!span || !btn) return;
  clear(span);
  if (ctx && ctx.cause === 'isolation-changed') {
    span.append(
      el('b', { text: 'Recorded before the container.' }),
      document.createTextNode(' This session was recorded before you enabled the container. Fork it into the container? The original stays on the host.'));
    btn.textContent = 'Fork into the container';
  } else if (ctx && ctx.cause === 'path-changed') {
    // BUG-138 — naming the rename, because "recorded on another machine" sent
    // the reader looking for a Windows checkout that was never involved.
    span.append(
      el('b', { text: 'Recorded before the rename.' }),
      document.createTextNode(' This session ran under this project’s previous directory name. The history reads here; it can’t resume against a path that is gone. Fork it to continue? The original stays untouched.'));
    btn.textContent = 'Fork to continue here';
  } else if (ctx) {
    span.append(
      el('b', { text: 'Recorded on another machine.' }),
      document.createTextNode(' The history reads here; it can’t resume on this machine. Fork it into a session here? The original stays untouched.'));
    btn.textContent = 'Fork to a session here';
  } else {
    span.append(
      el('b', { text: 'Started on Windows.' }),
      document.createTextNode(' The history reads here; it can’t resume on this machine.'));
    btn.textContent = 'Fork to a Linux session';
  }
}

/* ============== BUG-045: retryable refusal queues + retries itself ==========
 * BUG-029 stopped the refusal LOSING the message; this stops it stranding the
 * user. A `retryable:true` pre-ack refusal (the BUG-022 survivor-drain guard,
 * BUG-033's frameless drop) means "this will work soon" — so the text becomes
 * a row in the SAME queue the busy path uses (visible, editable, discardable)
 * marked drain-wait, and the client re-attempts the SAME resume itself:
 * immediately when the live poll sees the draining session leave the live set
 * (the drain settled — see refreshLive), and on a slow interval as fallback.
 * Every retry is a full `start` the server's gate re-judges — nothing here
 * weakens BUG-033's liveness gate or races a second CLI (BUG-022); it only
 * automates the Enter the old message told the user to press.
 * ------------------------------------------------------------------------- */

const DRAIN_RETRY_MS = 7000;      // slow-poll fallback while a drain-wait row exists
const DRAIN_RETRY_MIN_GAP = 4500; // transition + interval triggers must not compound into a hammer

function queueRetryableRefusal(drain) {
  const text = state.pendingStart;
  const resume = state.pendingStartResume;
  const retried = state.drainWaitAttempt; // a self-retry that was re-refused — its row is still queued
  state.drainWaitAttempt = null;
  // FEAT-064: the server's refusal now says WHAT holds the drain (background
  // task count/ids + how long the broker has been holding). Keep it on the row
  // — refreshed on every re-refusal — so the chip states the reason and an
  // elapsed that stays honest between retries.
  if (retried && drain) { retried.drain = drain; retried.drainAt = Date.now(); }
  state.pendingStart = null;
  state.pendingStartResume = null;
  state.pendingStartKeepComposer = false; // BUG-132: this start is settled either way
  // Same rollback as rollBackPendingStart, minus the composer hand-back — the
  // text's home is its queue row now (created below on the first refusal).
  const bs = mainThread().paneEl.querySelectorAll(':scope > .you');
  bs[bs.length - 1]?.remove();
  if (state.ws) {
    state.closingOnPurpose = true;
    try { state.ws.close(); } catch { /* already gone */ }
    // Mark the socket dead NOW, not when its close event lands: setBusy(false)
    // below schedules flushQueue, and a still-"live" closing socket would let
    // it push the drain-wait row into a session-less socket — the exact
    // double-delivery window settleDrainWaitDelivery exists to prevent.
    state.ws = null;
    state.live = false;
  }
  if (resume) state.resumeOnNextSend = resume; // a manual Enter still re-attempts the same resume
  setBusy(false);
  state.turnStartedAt = 0;
  state.sessReconnecting = false;
  paintSessStatus();
  if (!retried && text) {
    state.queue.push({
      text, dead: null, composedAt: Date.now(),
      drainWait: resume ?? true,                // which session the retry must resume
      drainProject: state.current.projectId,    // retries only run while this project is current
      drain: drain ?? null, drainAt: Date.now(), // FEAT-064: what holds the drain, per the server
    });
    say('message queued — waiting for the previous turn to finish draining; it will send itself');
  }
  armDrainWaitRetry();
  paintQueue();
}

/** The oldest live drain-wait row whose retry is legal right now, or null. */
function drainWaitItem() {
  return state.queue.find((q) => !q.dead && q.drainWait && q.text.trim()
    && (!q.drainProject || q.drainProject === state.current.projectId)) ?? null;
}

function armDrainWaitRetry() {
  if (state.drainWaitTimer) return;
  state.drainWaitTimer = setInterval(() => attemptDrainRetry(), DRAIN_RETRY_MS);
}

function disarmDrainWaitRetry() {
  clearInterval(state.drainWaitTimer);
  state.drainWaitTimer = null;
}

/**
 * One self-retry of the next drain-wait row: a full startTurn over the SAME
 * resume, judged by the same server gate. Exactly-once by construction: the
 * row leaves the queue ONLY on this start's `ack` (settleDrainWaitDelivery),
 * a re-refusal keeps it queued (queueRetryableRefusal's `retried` branch),
 * and while an attempt is in flight flushQueue skips the row, so a busy
 * transition can never deliver the same text a second time.
 */
function attemptDrainRetry({ immediate = false } = {}) {
  // An attempt whose socket died with neither an ack nor a refusal reaching us
  // would guard a ghost forever — release it once it is clearly not in flight.
  if (state.drainWaitAttempt && !state.busy && state.pendingStart == null
    && Date.now() - (state.drainWaitLastTry || 0) > 15000) state.drainWaitAttempt = null;
  if (state.drainWaitAttempt || state.busy || state.pendingStart != null || state.live) return;
  const item = drainWaitItem();
  if (!item) { if (!state.queue.some((q) => !q.dead && q.drainWait)) disarmDrainWaitRetry(); return; }
  const now = Date.now();
  if (!immediate && now - (state.drainWaitLastTry || 0) < DRAIN_RETRY_MIN_GAP) return;
  state.drainWaitLastTry = now;
  state.drainWaitAttempt = item;
  /*
   * BUG-132: the composer is NOT this retry's channel — `keepComposer` makes
   * startTurn (and the refusal rollback behind it) leave the box alone entirely.
   * The previous save-and-restore-around-the-promise could not work: startTurn
   * blanked the box synchronously and the restore only ran a server round-trip
   * later, guarded on the box still being empty — and the refusal in between had
   * already filled it with the QUEUED row's text, so the guard declined and the
   * user's typing was gone. Never save/restore across an await what you can
   * simply not touch.
   */
  Promise.resolve(startTurn(item.text, {
    resumeSessionId: typeof item.drainWait === 'string' ? item.drainWait : undefined,
    keepComposer: true,
  })).catch(() => { state.drainWaitAttempt = null; });
}

/** The retry's `start` was ACKED with its prompt delivered — retire the row, exactly once. */
function settleDrainWaitDelivery({ quiet = false } = {}) {
  const item = state.drainWaitAttempt;
  if (!item) return;
  state.drainWaitAttempt = null;
  const idx = state.queue.indexOf(item);
  if (idx !== -1) state.queue.splice(idx, 1);
  if (!drainWaitItem()) disarmDrainWaitRetry();
  paintQueue();
  // FEAT-065: a survivor delivery says its own (more accurate) line — the
  // drain did NOT finish, the message was injected into it.
  if (!quiet) say('the previous turn finished draining — delivered your queued message');
}

/**
 * A self-retry refused NON-terminally keeps its row, marked dead, so the text
 * stays recoverable.
 *
 * BUG-132: this used to RETIRE the row whenever the composer was empty, because
 * the rollback right after would deposit the text there instead (BUG-029's
 * composer-return). A retry no longer touches the composer at all — it never
 * took the text from there — so retiring the row now would be the one thing
 * neither side holds it: always keep it. The row is the durable copy (BUG-129
 * mirrors it to storage on the repaint below).
 */
function failDrainWaitAttempt(why) {
  const item = state.drainWaitAttempt;
  if (!item) return;
  state.drainWaitAttempt = null;
  item.dead = why;
  if (!drainWaitItem()) disarmDrainWaitRetry();
  paintQueue();
}

/* ======================= BUG-031: provider/API error relay ==================
 * The runtime maps its provider's native failures into a provider-agnostic
 * shape; the bridge relays it as `provider-error`. Here it renders ATTRIBUTED
 * — provider + failure class + the provider's own detail text verbatim — as a
 * transcript card (durable, unlike the one-line #fine ticker), with the status
 * page linked when one exists and a Retry affordance when retrying can work.
 * ------------------------------------------------------------------------- */

const PROVIDER_ERROR_LABELS = {
  'overloaded': 'servers overloaded',
  'rate-limited': 'rate limited',
  'quota-window': 'usage limit reached',
  'auth-expired': 'authentication expired',
  'network': 'network failure',
  'model-unavailable': 'model unavailable',
  // BUG-035: an attached MCP tool server that never started. Not a turn
  // failure — the turn runs fine, just without those tools — so it is worded
  // as the capability loss it is.
  'tooling-unavailable': 'tools missing — an MCP server failed to start',
  'internal': 'provider error',
};

function provErrorLabel(e) {
  return PROVIDER_ERROR_LABELS[e.kind] ?? 'provider error';
}

/** One-line attribution used for the session-status hint and the ticker. */
function provErrorLine(e) {
  return `${e.provider} — ${provErrorLabel(e)}: ${e.detail || '(no detail given)'}`;
}

function retryLastTurn() {
  if (state.busy) return say('a turn is already running — wait for it or interrupt first', true);
  if (state.budgetLocked) return say(state.budgetLockReason || 'this session hit its budget limit', true);
  const text = node.prompt.value.trim() || state.lastTurnPrompt || '';
  if (!text) return say('nothing to retry — type the message again', true);
  node.prompt.value = text;
  autosize();
  void submit();
}

function renderProviderError(e) {
  const body = claudeBody(mainThread());
  const card = el('div', { class: 'provider-error', 'data-kind': e.kind, 'data-provider': e.provider },
    el('div', { class: 'pe-head', text: `${e.provider} — ${provErrorLabel(e)}` }),
    el('div', { class: 'pe-detail', text: e.detail || '(the provider gave no detail)' }),
  );
  const foot = el('div', { class: 'pe-foot' });
  if (typeof e.resetsAt === 'number' && e.resetsAt > 0) {
    // The wire carries epoch seconds; tolerate ms defensively.
    const ms = e.resetsAt < 1e12 ? e.resetsAt * 1000 : e.resetsAt;
    foot.append(el('span', { class: 'pe-reset', text: `resets ${new Date(ms).toLocaleString()}` }));
  }
  if (e.statusUrl) {
    foot.append(el('a', {
      class: 'pe-status', href: e.statusUrl, target: '_blank', rel: 'noopener',
      text: e.statusUrl.replace(/^https?:\/\//, ''),
    }));
  }
  if (e.retryable) {
    foot.append(el('button', { class: 'pe-retry', type: 'button', text: 'Retry', onclick: retryLastTurn }));
  }
  if (foot.childElementCount) card.append(foot);
  body.append(card);
  card.scrollIntoView?.({ block: 'nearest' });
}

/**
 * A turn is "busy" until `turn-end`. If the server reports an error instead,
 * the turn may or may not still be alive — so we arm a short watchdog rather
 * than guessing. Any further event cancels it; silence releases the composer.
 */
function armBusyWatchdog(why) {
  clearTimeout(state.busyWatchdog);
  state.busyWatchdog = setTimeout(() => {
    if (!state.busy) return;
    setBusy(false);
    state.turnStartedAt = 0;
    state.pendingSend = null; // ambiguous outcome (see comment above) — stop tracking it either way
    cancelForceSend(`${why} — no turn is running`);
    say(`${why} — no turn is running, composer released`, true);
  }, 4000);
}

/*
 * FEAT-040 — session-state legibility. One computed, ALWAYS-painted label so a
 * transitional state (reconnecting, running detached, mid-thought before any
 * text) never reads as indistinguishable from "broken". Priority order below
 * is deliberate: a down transport outranks everything (we cannot vouch for
 * what is happening behind it), an explicit error outranks routine busy-ness,
 * and only true silence — nothing running, nothing pending — reads as idle.
 *
 * BUG-153 added the rule that was missing under all of that: NO label may
 * promise something this tab cannot do. "Thinking…"/"Responding…" describe a
 * turn the user can interrupt, queue into and force-send over, so they are
 * gated on actually holding the socket those three act on (isDriving()). Work
 * that is running where we cannot reach it gets the label that says so, and
 * says what to do about it.
 */
const SESS_STATUS_META = {
  thinking: { label: 'Thinking…', hint: 'Claude is working — no reply text yet.' },
  streaming: { label: 'Responding…', hint: 'Claude is streaming its reply.' },
  detached: { label: 'Running in background', hint: 'This turn is continuing server-side without this tab attached — send a message to take it over.' },
  reconnecting: { label: 'Reconnecting…', hint: 'Reattaching to the session — resuming shortly.' },
  error: { label: 'Error', hint: '' }, // hint filled from state.sessError at paint time
  idle: { label: 'Idle', hint: 'Nothing is running.' },
};

function computeSessState() {
  if (state.sessReconnecting || state.dropped) return 'reconnecting';
  if (state.sessError) return 'error';
  /*
   * BUG-153 — detachment is DERIVED, never remembered. A tab that holds no
   * driving socket is not steering this session, whatever flags a past event
   * left behind, so it may never say "Claude is working": that label promises
   * a turn this tab can interrupt, queue into and force-send over, and the
   * guards on all three refuse in exactly this state. Either something IS
   * running out there (`busy` from the reopen path, `followingLive` from a run
   * we only watch) — and then "running in the background · send to take it
   * over" is both true and the way out — or nothing is, and it is idle.
   *
   * `state.sessDetached` used to gate this line and was cleared by any socket
   * open; the honest state then silently downgraded to "Claude is working"
   * while force-send answered "no live session". See isDriving().
   */
  if (!isDriving()) return (state.busy || state.followingLive) ? 'detached' : 'idle';
  if (state.busy) return state.sessPhase === 'streaming' ? 'streaming' : 'thinking';
  return 'idle';
}

/*
 * FEAT-048 — survival ground truth (FEAT-040's machine half, BUG-027's
 * adopted/scoped fields) surfaced on the SAME affordance the human half
 * already reads. `state.sessSurvival` identifies the CURRENT session by
 * `state.stationSessionId` (this tab's live bridge) falling back to
 * `state.sdkSessionId` (still matches a `surviving-unadopted` broker entry,
 * which carries no stationSessionId of its own — see the health route's
 * `sdkSessionId ?? h.resumeHint` fallback in src/server/index.ts).
 */
function sessSurvivalKey() {
  return state.stationSessionId || state.sdkSessionId || null;
}

/** Renders the ground-truth line from a /api/health `sessions[]` entry (or
 * null when nothing has been fetched yet / no session is open). Mirrors
 * scripts/station-doctor.mjs's vocabulary so the human and machine halves
 * never disagree about what "protected" means. */
function survivalHintLine(entry) {
  if (!entry) return '';
  if (entry.adopted === false) {
    const brokerState = entry.broker?.state ?? 'unknown';
    return `Survived a restart — broker alive (${brokerState}), not yet adopted by this server; resume to continue the thread.`;
  }
  if (!entry.survivalConfigured) return 'Not protected — survival is not configured for this session.';
  if (entry.survivalScoped === true) return 'Protected — survives a server restart.';
  if (entry.survivalScoped === false) return '⚠ survival configured but NOT scoped — not actually protected against a restart right now.';
  return ''; // survivalScoped null (no broker to check) with nothing else to say
}

function paintSessStatus() {
  if (!node.sessStatus) return;
  const s = computeSessState();
  const meta = SESS_STATUS_META[s];
  node.sessStatus.dataset.state = s;
  node.sessStatusLbl.textContent = meta.label;
  const base = (s === 'error' && state.sessError) ? state.sessError : meta.hint;
  const key = sessSurvivalKey();
  const survival = (key && state.sessSurvival.key === key) ? survivalHintLine(state.sessSurvival.entry) : '';
  node.sessStatus.title = survival ? `${base}\n${survival}` : base;
  paintAuto();
}

/*
 * FEAT-048 — fetch /api/health lazily, ONLY on hover/focus of #sessStatus
 * (never a hot poll: this data changes at most once per restart/spawn, so
 * polling it on a timer would burn a request cycle for information that is
 * almost always unchanged — a hover is the actual moment the user wants it).
 * A short cache absorbs repeated hovers/mouse jitter without re-fetching.
 */
const SESS_SURVIVAL_CACHE_MS = 15_000;
let sessSurvivalInFlight = null;
function refreshSessSurvival() {
  const key = sessSurvivalKey();
  if (!key) return; // no session open yet — nothing to look up
  const fresh = state.sessSurvival.key === key && (Date.now() - state.sessSurvival.at) < SESS_SURVIVAL_CACHE_MS;
  if (fresh || sessSurvivalInFlight) return;
  sessSurvivalInFlight = api.health().then((health) => {
    const sessions = Array.isArray(health?.sessions) ? health.sessions : [];
    const entry = sessions.find((s) => s.stationSessionId === key || s.sdkSessionId === key) ?? null;
    state.sessSurvival = { key, entry, at: Date.now() };
    paintSessStatus();
  }).catch(() => { /* route absent/unreachable — title just stays without the survival line */
  }).finally(() => { sessSurvivalInFlight = null; });
}

// Hover OR keyboard focus (title attrs are mouse-only otherwise, and this
// affordance is a button) triggers the lazy fetch above.
if (node.sessStatus) {
  node.sessStatus.addEventListener('mouseenter', refreshSessSurvival);
  node.sessStatus.addEventListener('focus', refreshSessSurvival);
}

/* ============================ FEAT-022: autonomous mode =====================
 * An EXPLICITLY chosen keep-going-until-a-stop-condition loop (WA §M), distinct
 * from the interactive NEEDS-YOU default. The affordance lives in the crown next
 * to #sessStatus: a toggle that arms autonomous with a bounded stop condition
 * ("stop after N turns"), an UNMISTAKABLE running badge showing progress, and a
 * prominent Stop that returns to interactive. All control goes through the
 * /api/sessions/:id/autonomous routes; the server owns the loop and the halt.
 * ------------------------------------------------------------------------- */

// One-time injected style: the running badge must be impossible to miss (this
// is an unattended mode). styles.css is out of this ticket's scope, so the few
// rules the badge needs are injected here rather than added there.
function ensureAutoStyle() {
  if (document.getElementById('autoStyle')) return;
  const st = document.createElement('style');
  st.id = 'autoStyle';
  st.textContent = `
@keyframes csAutoPulse { 0%,100%{opacity:1} 50%{opacity:.55} }
/* An author display rule beats the UA [hidden]{display:none}; restore it so the
   hidden attribute actually hides these (else the badge shows when it must not). */
.auto-wrap[hidden],.auto-badge[hidden],.auto-form[hidden]{display:none!important}
.auto-wrap{position:relative;display:inline-flex;align-items:center;gap:6px;margin-left:10px;font:inherit}
.auto-badge{display:inline-flex;align-items:center;gap:6px;font:700 11px/1 ui-monospace,monospace;letter-spacing:.06em;
  color:#fff;background:#b45309;border:1px solid #f59e0b;padding:3px 8px;border-radius:6px;
  box-shadow:0 0 0 2px rgba(245,158,11,.25);animation:csAutoPulse 1.2s ease-in-out infinite}
.auto-badge .d{width:7px;height:7px;border-radius:50%;background:#fde68a}
.auto-btn{font:600 11px/1 inherit;padding:3px 9px;border-radius:6px;cursor:pointer;
  border:1px solid var(--line,#333);background:transparent;color:inherit}
.auto-btn[data-mode="stop"]{border-color:#f59e0b;color:#fbbf24}
.auto-form{position:absolute;top:100%;left:0;margin-top:6px;z-index:60;white-space:nowrap;
  display:flex;align-items:center;gap:6px;padding:8px 10px;border-radius:8px;
  background:var(--panel,#17171b);border:1px solid var(--line,#333);box-shadow:0 8px 24px rgba(0,0,0,.4)}
.auto-form input{width:52px;font:inherit;padding:2px 4px}
.auto-form .dim{opacity:.7;font-size:11px}
body[data-autonomous="1"]::before{content:"";position:fixed;inset:0 0 auto 0;height:3px;z-index:9999;
  background:linear-gradient(90deg,#b45309,#f59e0b,#b45309);animation:csAutoPulse 1.2s ease-in-out infinite;pointer-events:none}`;
  document.head.append(st);
}

// Build the crown affordance once and cache its nodes on `node`.
function ensureAutoUI() {
  if (node.autoWrap) return;
  ensureAutoStyle();
  const wrap = el('div', { class: 'auto-wrap' });
  const badge = el('span', { class: 'auto-badge' }, el('span', { class: 'd' }), el('span', { class: 'txt' }));
  badge.hidden = true;
  const btn = el('button', { class: 'auto-btn', id: 'autoBtn', type: 'button' });
  const form = el('div', { class: 'auto-form' });
  form.hidden = true;
  const input = el('input', { id: 'autoTurns', type: 'number', min: '1', max: '50', value: '5' });
  const go = el('button', { id: 'autoStart', class: 'auto-btn', type: 'button', text: 'Start' });
  form.append(el('span', { class: 'dim', text: 'Stop after' }), input, el('span', { class: 'dim', text: 'turns' }), go);
  btn.addEventListener('click', () => {
    if (state.autonomous.autonomous) void stopAutonomous();
    else { form.hidden = !form.hidden; if (!form.hidden) input.focus(); }
  });
  go.addEventListener('click', () => void startAutonomous(Number(input.value)));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') void startAutonomous(Number(input.value)); });
  wrap.append(badge, btn, form);
  node.sessStatus.after(wrap);
  Object.assign(node, { autoWrap: wrap, autoBadge: badge, autoBadgeTxt: badge.querySelector('.txt'), autoBtn: btn, autoForm: form, autoTurns: input });
}

// Reflect state.autonomous into the crown. Hidden until a session is actually
// driven from this tab (no station id ⇒ no route to address).
function paintAuto() {
  if (!node.sessStatus) return;
  ensureAutoUI();
  const a = state.autonomous;
  const canControl = !!(state.live && state.stationSessionId);
  node.autoWrap.hidden = !canControl;
  document.body.dataset.autonomous = a.autonomous ? '1' : '0';
  if (!canControl) { node.autoForm.hidden = true; return; }
  if (a.autonomous) {
    node.autoBadge.hidden = false;
    node.autoForm.hidden = true;
    node.autoBadgeTxt.textContent = `AUTONOMOUS ${a.turnsDone}/${a.maxTurns ?? '?'}`;
    node.autoBadge.title = `Running unattended — auto-continuing up to ${a.maxTurns} turns, then stopping. Working only the agreed scope.`;
    node.autoBtn.textContent = 'Stop';
    node.autoBtn.dataset.mode = 'stop';
    node.autoBtn.title = 'Stop autonomous mode — return to interactive';
  } else {
    node.autoBadge.hidden = true;
    node.autoBtn.textContent = 'Autonomous';
    node.autoBtn.dataset.mode = 'idle';
    node.autoBtn.title = 'Interactive (default). Enable a bounded auto-continue loop.';
  }
}

async function startAutonomous(maxTurns) {
  const id = state.stationSessionId;
  if (!id) { say('no live session to make autonomous', true); return; }
  try {
    const r = await api.api(`/api/sessions/${encodeURIComponent(id)}/autonomous`, {
      method: 'POST', body: JSON.stringify({ action: 'start', maxTurns }),
    });
    state.autonomous = r.autonomous;
    say(`autonomous ON — will auto-continue up to ${state.autonomous.maxTurns} turns, then stop. Working the current scope only; send a turn (or let the one in flight finish) to run the loop.`);
  } catch (err) {
    say(`could not enable autonomous: ${err.message}`, true);
  }
  paintAuto();
}

async function stopAutonomous() {
  const id = state.stationSessionId;
  if (!id) return;
  try {
    const r = await api.api(`/api/sessions/${encodeURIComponent(id)}/autonomous`, {
      method: 'POST', body: JSON.stringify({ action: 'stop' }),
    });
    state.autonomous = r.autonomous;
    say('autonomous stopped — back to interactive. A turn already in flight finishes; nothing new is auto-continued.');
  } catch (err) {
    say(`could not stop autonomous: ${err.message}`, true);
  }
  paintAuto();
}

// Re-read the server's authoritative mode. Called after a session goes live
// (reflects a mode that persisted across a reload) and at every turn boundary
// while autonomous (advances the counter, and catches the halt at the stop
// condition — the server, not the client, decides when the loop ends).
async function refreshAuto() {
  const id = state.stationSessionId;
  if (!id) return;
  try {
    const r = await api.optional(`/api/sessions/${encodeURIComponent(id)}/autonomous`);
    if (!r) return;
    const wasOn = state.autonomous.autonomous;
    state.autonomous = r;
    if (wasOn && !r.autonomous) {
      say(`autonomous complete — stopped (${r.stopReason ?? 'done'}) after ${r.turnsDone} turns; back to interactive.`);
    }
    paintAuto();
  } catch { /* transient — the next boundary re-reads it */ }
}

function setBusy(busy) {
  if (!busy) clearTimeout(state.busyWatchdog);
  state.busy = busy;
  node.go.dataset.mode = busy ? 'stop' : 'send';
  node.go.setAttribute('aria-label', busy ? 'Interrupt' : 'Send message');
  node.go.title = busy ? 'Interrupt' : 'Send';
  clear(node.go).append(busy ? iconStop() : iconSend());
  if (!busy) state.turnStartUnknown = false; // BUG-033: no turn, nothing unknown about it
  if (busy) {
    // BUG-033: never invent a start time. A caller that knows one sets
    // `turnStartedAt` before calling; a caller that does NOT sets
    // `turnStartUnknown`, and the clock renders "—" instead of a fake age.
    if (!state.turnStartUnknown) state.turnStartedAt = state.turnStartedAt || Date.now();
    // A fresh turn starts in "thinking" (no reply text yet) and clears any
    // stale error from a PRIOR turn — the new activity is the honest truth now.
    state.sessPhase = 'thinking';
    state.sessError = null;
    state.provError = null; // BUG-031: a new turn owns its own provider-error state
  }
  renderStrip();
  paintSessStatus();
  /*
   * The queue flushes on the busy TRANSITION, not on one lucky event. It was
   * wired to turn-end only, and busy also drops through interrupt acks,
   * watchdogs and error paths — a queued message then waited forever
   * (observed live: an interrupted turn stranded a queued message). The
   * microtask lets the caller finish first (a fatal handler marks the queue
   * failed before the flush would try a dead socket).
   */
  if (!busy) queueMicrotask(flushQueue);
  paintQueue();
  paintTitle();
}

function iconSend() {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('width', '14'); s.setAttribute('height', '14');
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.7');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M8 12.8V3.4M4 7.4 8 3.4l4 4'); s.append(p);
  return s;
}
function iconStop() {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('width', '14'); s.setAttribute('height', '14');
  const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  r.setAttribute('x', '4.5'); r.setAttribute('y', '4.5'); r.setAttribute('width', '7'); r.setAttribute('height', '7');
  r.setAttribute('rx', '1.4'); r.setAttribute('fill', 'currentColor'); s.append(r);
  return s;
}

const LIVE_ACTIVITY = new Set(['text', 'text-delta', 'tool-call', 'tool-result', 'tool-progress',
  'agent-started', 'agent-progress', 'agent-completed', 'thinking-tokens', 'session-init']);

function onEvent(e) {
  if (state.busy && LIVE_ACTIVITY.has(e.t)) clearTimeout(state.busyWatchdog);
  switch (e.t) {
    case 'session-appended':
      // Handled by the passive watch socket only. If the server broadcasts to
      // every socket, the driving one must drop it or the message lands twice.
      return;

    case 'subagent-send-unsupported': {
      // Authoritative refusal from the server. Fall back to the read-only
      // state and quote its reason rather than paraphrasing it.
      const th = state.threads.get(e.targetAgentId);
      if (th) {
        th.unsupportedReason = e.reason;
        if (e.agentStatus) th.status = e.agentStatus;
        if (state.viewing === e.targetAgentId) paintComposerFor(th);
      }
      setBusy(false);
      say(e.reason, true);
      return;
    }

    case 'effective-config':
      // Authoritative: what the SDK was actually spawned with. The drawer
      // reconciles its `overridden` tags against this rather than against
      // what the UI believes it sent.
      state.effective = e;
      drawer.repaintLive();
      paintPerm(); // reflect what the server ACTUALLY applied, not our guess
      paintIntegrations(); // FEAT-051 — provider/capabilities honesty (codex: MCP off)
      paintModelBtn();
      paintModelChip(); // FEAT-042 — the chip tracks the same authoritative value
      if (e.ignoredOverrides?.length) {
        say(`ignored: ${e.ignoredOverrides.map((i) => `${i.field} (${i.reason})`).join('; ')}`, true);
      }
      return;

    case 'ack':
      if (e.of === 'set-permission-mode') {
        // `ok` is the server's word for "the SDK accepted it". `matched` keeps
        // the same meaning as the approval acks.
        const good = e.ok === true || (e.ok === undefined && e.matched !== false && !e.error);
        finishPermMode(e.requestId, good, e.error || e.reason || 'the server declined the change');
        return;
      }
      if (e.of === 'set-model') {
        const good = e.ok === true || (e.ok === undefined && e.matched !== false && !e.error);
        finishModel(e.requestId, good, e.error || e.reason || 'the server declined the change');
        return;
      }
      if (e.of === 'question-response' || e.of === 'plan-response') {
        const pending = state.pendingAnswers.get(e.requestId);
        if (pending) {
          state.pendingAnswers.delete(e.requestId);
          pending.settle(e.matched);
        }
        return;
      }
      if (e.of === 'approval-response') {
        const pending = state.pendingAnswers.get(e.requestId);
        if (pending) {
          state.pendingAnswers.delete(e.requestId);
          pending.settle(e.matched);
        }
        return;
      }
      if (e.of === 'send' && e.delivered === false) {
        setBusy(false);
        return; // subagent-send-unsupported carries the explanation
      }
      if (e.of === 'start') {
        if (e.deliveredVia === 'survivor') {
          /*
           * FEAT-065: the server wrote this start's prompt straight into the
           * drain-held survivor's stdin — a normal turn in the SAME CLI pid.
           * There is NO live bridge: this socket stays open only to relay any
           * approval the injected turn raises (approval-request/-response),
           * and closes on the turn's `survivor-delivery` notice. The turn
           * itself — including the user message — renders from the transcript
           * file-follow, so the optimistic bubble startTurn painted must come
           * out (the follow re-renders it, and doubling it would lie).
           */
          settleDrainWaitDelivery({ quiet: true }); // BUG-045 exactly-once: the retried row is delivered
          state.pendingStart = null;
          state.pendingStartResume = null;
          state.deliveryRelay = e.sdkSessionId ?? true;
          state.sdkSessionId = null; // no bridge — closing this relay later is routine, never a "drop"
          state.turnStartedAt = 0;
          state.sessReconnecting = false;
          setBusy(false); // flushQueue is relay-guarded; other queued rows wait for the retry loop
          const dbs = mainThread().paneEl.querySelectorAll(':scope > .you');
          dbs[dbs.length - 1]?.remove();
          followCurrent(true); // the watch socket streams the injected turn in from the transcript
          paintSessStatus();
          paintQueue();
          say('delivered into the still-draining session — it runs there now; the reply streams in from the transcript');
          return;
        }
        state.followingLive = false; // we now DRIVE this session — no longer a passive follow
        state.followingExternal = false; // …and we took over from the external writer
        // BUG-030: rows this attach does not re-announce (replayAgents frames
        // land right behind this ack) have no live process behind them — an
        // open tab that lived through a server/CLI cut keeps stale ◐ rows
        // that nothing else would ever settle. Sweep them after the replay.
        scheduleCutSweep();
        // FEAT-022: the station session id — the key the autonomous routes are
        // addressed by — arrives on this ack (fresh AND reattach). Capture it,
        // then re-read the mode: a session made autonomous before a reload still
        // is, and this is where we learn it.
        if (e.stationSessionId) {
          state.stationSessionId = e.stationSessionId;
          void refreshAuto();
        }
        // Driving it now (this socket sent `start` and got acked) — whatever
        // detached/reconnecting state applied before this is resolved.
        // (`followingLive` is cleared just above, for the same reason.)
        state.sessReconnecting = false;
        paintSessStatus();
        if (e.effective) {
          state.effective = {
            ...(state.effective ?? {}),
            effective: e.effective,
            overridden: e.overridden ?? [],
            permissionModeSource: e.permissionModeSource ?? state.effective?.permissionModeSource,
            isolation: e.isolation ?? state.effective?.isolation,
            // FEAT-037 P3: the engine's honesty flags + resolved provider ride
            // the ack too, so a reattach knows what to gray out immediately.
            capabilities: e.capabilities ?? state.effective?.capabilities,
            provider: e.effective?.provider ?? state.effective?.provider,
          };
          drawer.repaintLive();
          paintPerm();
          paintModelBtn();
          paintModelChip(); // FEAT-037 P3: the crown's provider mark tracks the ack too
        }
        /*
         * SNAPSHOT PROTECTION, stated per session.
         *
         * `startSnapshotId` is null when this session has NO restore point —
         * either snapshots are off for the project, or the snapshot FAILED (a
         * non-fatal error carried the reason and the session started anyway).
         * That failure is invisible otherwise: the session looks completely
         * normal, so the user would assume protection they do not have.
         *
         * `undefined` means this server does not report it — say nothing rather
         * than guess, since both "protected" and "not protected" would be a
         * claim we cannot support.
         */
        if ('startSnapshotStatus' in e || 'startSnapshotId' in e) {
          state.startSnapshot = readStartSnapshot(e);
          drawer.repaint();
        }
        /*
         * RE-ATTACHED to a session that kept running while no tab was driving
         * it. If a turn is in flight, the prompt this start carried was NOT
         * delivered — the bubble startTurn painted must come back out of the
         * transcript and into the queue, where it delivers at the boundary.
         */
        if (e.reattached) {
          if (e.busy) {
            // BUG-033: the server's honest turn clock, or an honest unknown —
            // never a fresh stamp (see turnClock()).
            if (Number.isFinite(e.turnStartedAt) && e.turnStartedAt > 0) {
              state.turnStartedAt = e.turnStartedAt;
              state.turnStartUnknown = false;
            } else if (!state.turnStartedAt) {
              state.turnStartUnknown = true;
            }
            setBusy(true);
            const t = state.pendingStart;
            if (t) {
              const bs = mainThread().paneEl.querySelectorAll(':scope > .you');
              bs[bs.length - 1]?.remove();
              if (state.drainWaitAttempt) {
                // BUG-045: this text ALREADY sits in the queue as its drain-wait
                // row — re-queueing would double it. The bridge is live now, so
                // the normal boundary flush owns delivery from here.
                state.drainWaitAttempt.drainWait = null;
                state.drainWaitAttempt = null;
                if (!drainWaitItem()) disarmDrainWaitRetry();
                paintQueue();
              } else queueMessage(t);
            }
            say('re-attached — this session was still working; your message is queued for the next pause');
          } else {
            // Idle reattach: the server delivered this start's prompt as a new
            // turn — a drain-wait retry's row is settled (BUG-045), exactly once.
            settleDrainWaitDelivery();
            say('re-attached to the running session');
          }
          state.pendingStart = null;
          state.pendingStartResume = null;
          return;
        }
        state.pendingStart = null;
        state.pendingStartResume = null;
        // BUG-045: a fresh ack means the start (and its prompt) was accepted —
        // if it was a drain-wait self-retry, its queue row is delivered.
        settleDrainWaitDelivery();
        const ovr = (e.overridden ?? []).length ? ` · overrides applied: ${e.overridden.join(', ')}` : '';
        const forked = e.fork?.forked ? ` · forked from ${String(e.fork.from ?? '').slice(0, 8)}` : '';
        const ss = state.startSnapshot;
        say(`session started · instructions: ${e.instructionMode}${(e.appliedTemplates || []).length ? ` [${e.appliedTemplates.join(', ')}]` : ''}${ovr}${forked}${ss?.line ? ` · ${ss.line}` : ''}`,
          ss?.status === 'failed');
      }
      return;

    case 'session-init':
      state.sdkSessionId = e.sessionId;
      state.current.sessionId = e.sessionId;
      // FEAT-051: the CLI's own tool report is the ground truth for which MCP
      // servers ACTUALLY attached (mcp__<name>__… tools) — repaint the strip.
      state.liveTools = Array.isArray(e.tools) ? e.tools : null;
      paintIntegrations();
      // The "new session" now has a real id — the URL picks it up (replace,
      // not push: this is the same place, not a navigation), so a reload
      // lands back IN this session instead of another blank one.
      if (!state.current.encodedDir) state.current.encodedDir = state.sessions.get(state.current.projectId)?.encodedDir ?? null;
      persistOverrides(); // a pre-start armed toggle now has a session id to belong to
      /*
       * BUG-129: the same move for undelivered rows. Until this frame the queue
       * was stored under the pending-new PROJECT key; from here the session has
       * a real id and a reload lands in the SESSION, which is where the rows
       * must be found. Doing it here rather than lazily at the next queue
       * mutation is not a refinement — a message queued during this very first
       * turn is mutated once and never again, so a lazy migration would leave it
       * stored under a key nothing reads and the reload would lose it exactly as
       * before. (Caught by the browser leg, which is why it is driven there.)
       */
      retargetQueue();
      persistQueue();
      if (Array.isArray(e.slashCommands) && e.slashCommands.length) {
        state.slashCommands = e.slashCommands;
        try { localStorage.setItem('cs-slash', JSON.stringify(e.slashCommands)); } catch { /* volatile is fine */ }
      }
      /*
       * BUG-021: name the model actually chosen. The pre-spawn `effective-config`
       * can only echo the project's raw setting — often null, "let the CLI
       * decide" — so it can never resolve a truly-unset default to a concrete
       * name. `session-init` is the CLI's OWN report of the wire id it picked
       * (see the normModelId comment above resolveCurrentModelOpt), the only
       * source that can. Fold it into state.effective so the picker's
       * "Project default" readout and the model button tooltip show it instead
       * of the vague placeholder.
       */
      if (e.model) {
        state.effective = { ...(state.effective ?? {}), effective: { ...(state.effective?.effective ?? {}), model: e.model } };
        paintModelBtn();
        // FEAT-042: the CLI's own launch report is both the chip's first live
        // value AND the baseline "what the user launched with" that a later
        // unrequested change is judged against.
        liveWireModel = e.model;
        expectedLiveModel = e.model;
        paintModelChip();
      }
      syncUrl('replace');
      say(`${shortPath(e.cwd)} · ${e.model} · ${e.tools.length} tools · ${e.sessionId.slice(0, 8)}`);
      return;

    case 'text-delta': {
      // stream_event.parent_tool_use_id is always null — deltas are main-thread.
      const th = mainThread();
      if (!th.stream) {
        const body = claudeBody(th);
        const wrap = el('div', { class: 'prose' });
        body.append(wrap);
        th.stream = { wrap, text: '', caret: el('span', { class: 'caret' }), timer: 0, lastRender: 0 };
      }
      th.stream.text += e.text;
      // Leading-edge throttle: render the first token immediately (caret shows
      // at once), then coalesce bursts and always flush the tail via schedule.
      if (Date.now() - (th.stream.lastRender || 0) >= STREAM_RENDER_MS) renderStreamNow(th);
      else scheduleStreamRender(th);
      if (state.sessPhase !== 'streaming') { state.sessPhase = 'streaming'; paintSessStatus(); }
      if (state.viewing === 'main') scrollDown();
      return;
    }

    case 'text': {
      const th = threadFor(e.agentId);
      if (e.agentId) {
        // keep the summary text for the settled row AND show it in the thread
        state.agentText.set(e.agentId, (state.agentText.get(e.agentId) ?? '') + e.text);
        if (e.agentType && !th.agentType) th.agentType = e.agentType;
        claudeBody(th).append(prose(e.text));
        if (state.viewing === e.agentId) scrollDown();
        return;
      }
      if (th.stream) {
        if (th.stream.timer) clearTimeout(th.stream.timer);
        // FEAT-083: on turn-end, the settled main-thread message re-renders
        // through the digest-aware renderer so a leading orchard-digest envelope
        // becomes the structured list (and the raw JSON is hidden).
        th.stream.wrap.replaceWith(assistantProse(e.text || th.stream.text));
        th.stream = null;
      } else {
        claudeBody(th).append(assistantProse(e.text));
      }
      if (state.viewing === 'main') scrollDown();
      return;
    }

    case 'thinking-tokens':
      return; // the log carries no readable thinking text; the strip already shows work is happening

    case 'tool-call': {
      // Subagent tool calls now land in that agent's own thread rather than
      // being dropped — that thread is a real, viewable transcript.
      const th = threadFor(e.agentId);
      if (e.agentId && e.agentType && !th.agentType) { th.agentType = e.agentType; refreshLede(th); }
      finishStream(th);
      // A question or a plan is a decision, not a tool call. Rendering it as a
      // chip is the bug: it looks like something that already happened.
      if (renderDecisionCall(th, e)) return;
      th.tools.set(e.toolUseId, toolChip(th, e.name, e.input));
      return;
    }

    case 'tool-result': {
      const th = threadFor(e.agentId);
      const card = th.decisions?.get(e.toolUseId);
      if (card) {
        // The tool came back, so the model is moving on. If we never got an ack
        // for an answer, it moved on WITHOUT one — say that, never imply a pick.
        settleDecisionFromResult(card, e);
        return;
      }
      const t = th.tools.get(e.toolUseId);
      if (!t) return;
      t.chip.classList.remove('running');
      t.res.textContent = e.isError ? 'error' : `${e.preview.split('\n').length} lines`;
      t.pre.textContent = e.preview || '(no output)';
      if (e.isError) t.chip.open = true;
      return;
    }

    /*
     * Typed decision events. The server workstream is landing these; until they
     * arrive the cards still render off `tool-call` above, just without an
     * answer channel. Both spellings are accepted so whichever name lands works.
     */
    case 'question-request':
    case 'ask-user-question': {
      const th = threadFor(e.agentId);
      finishStream(th);
      renderQuestion(th, {
        toolUseId: e.toolUseId ?? null,
        requestId: e.requestId ?? null,
        questions: parseQuestions(e.input ?? e),
      });
      return;
    }
    case 'plan-request':
    case 'exit-plan-mode': {
      const th = threadFor(e.agentId);
      finishStream(th);
      renderPlan(th, {
        toolUseId: e.toolUseId ?? null,
        requestId: e.requestId ?? null,
        plan: parsePlan(e.input ?? e),
      });
      return;
    }

    case 'tool-progress': {
      const t = threadFor(e.agentId).tools.get(e.toolUseId);
      if (t) t.res.textContent = `${Math.round(e.elapsedSeconds)}s…`;
      return;
    }

    /*
     * ARCH-001 phase 2 / BUG-034 — the server's running-set snapshot, pushed
     * whenever the answer changes (turn start, agent start/end, turn end, a
     * reap, the reattach handshake). Trusted: it arrived on this session's own
     * socket. This is the event the strip renders; the `agent-*` events below
     * keep doing what only they can (threads, "ran" rows, transcript settling).
     */
    case 'running-snapshot':
      applySnapshot(e.snapshot, { trusted: true });
      return;

    case 'agent-started': {
      state.agents.set(e.agent.agentId, { agent: e.agent, t0: Date.now() - (e.agent.elapsedMs || 0), settled: false, seenAt: Date.now() });
      // Give it a thread immediately so the row is clickable the moment it appears.
      const th = state.threads.get(e.agent.agentId) ?? newThread(e.agent.agentId, {});
      th.agentType = e.agent.agentType;
      th.description = e.agent.description;
      th.status = 'running';
      th.loaded = true;
      refreshLede(th);
      renderStrip();
      return;
    }
    case 'agent-progress': {
      const cur = state.agents.get(e.agent.agentId);
      if (cur) { cur.agent = e.agent; cur.t0 = Date.now() - (e.agent.elapsedMs || 0); cur.seenAt = Date.now(); }
      else state.agents.set(e.agent.agentId, { agent: e.agent, t0: Date.now() - (e.agent.elapsedMs || 0), settled: false, seenAt: Date.now() });
      const t = state.threads.get(e.agent.agentId);
      if (t) { t.agentType = e.agent.agentType; t.description = e.agent.description; t.status = e.agent.status; refreshLede(t); }
      renderStrip();
      return;
    }
    case 'agent-completed': {
      const cur = state.agents.get(e.agent.agentId) ?? { settled: false };
      cur.agent = e.agent;
      cur.seenAt = Date.now();
      state.agents.set(e.agent.agentId, cur);
      if (!cur.settled) {
        cur.settled = true;
        // BUG-030: a tool-call task (kind 'tool' — e.g. a subagent's Bash call
        // the CLI surfaces as task_type "local_bash") is not a subagent: it
        // must not finish the main stream or leave a "ran" row. Settling just
        // retires its ◐ strip row and marks its thread done.
        if (agentKind(e.agent) === 'tool') {
          const t = state.threads.get(e.agent.agentId);
          if (t) { t.status = e.agent.status; refreshLede(t); }
        } else {
          finishStream(mainThread());
          finishStream(state.threads.get(e.agent.agentId));
          settleAgent(cur);
        }
      }
      renderStrip();
      return;
    }

    case 'approval-request':
      renderAsk(e);
      return;

    case 'permission-denied':
      say(`permission denied: ${e.toolName}${e.reason ? ` — ${e.reason}` : ''}`, true);
      return;

    /*
     * FEAT-065: the turn delivered into the drain-held survivor ended. The
     * relay socket has nothing left to relay — close it deliberately (routine,
     * never a "drop") so the drain-wait retry loop resumes for anything still
     * queued; the turn's output already rendered via the transcript follow.
     */
    case 'survivor-delivery':
      if (e.phase === 'turn-done') {
        if (state.deliveryRelay) closeSocket();
        say('the delivered turn finished — the session keeps draining its background work; your next message goes through the normal gate');
      }
      return;

    case 'status': {
      // BUG-100: this event carries anything the server wants to surface —
      // including a dispatched agent's task notification, which for shell work
      // is the RAW running command (a multi-hundred-char heredoc in the report).
      // The footer is not a log: it must never adopt raw command text as its
      // resting content, and it must never displace the isolation label. The
      // running rail (#strip) is the home for what's in flight; here we keep the
      // stable label and, when agents are running, append only a COMPACT bounded
      // indicator. The raw text rides the title so it stays reachable on hover.
      if (state.busy) return; // a live main turn owns the footer; nothing to add
      const raw = String(e.status ?? '');
      const agents = runningAgentCount();
      const commandish = raw.length > 48 || /[\n]/.test(raw);
      if (agents > 0 || commandish) {
        const label = isoLabel(currentProject());
        const activity = agents > 0 ? `${agents} agent${agents === 1 ? '' : 's'} running` : 'working…';
        // BUG-101: structured render — the transient count is set apart from the
        // permanent isolation label (quieter tone + moss dot), never a run-on.
        sayIso(label, activity, raw || null);
      } else {
        // A genuinely short human notice (fork removed, browser starting, a
        // memory warning): show it, still capped by say().
        say(raw);
      }
      return;
    }

    case 'compact-boundary':
      claudeBody(mainThread()).append(el('div', { class: 'ran-lbl', text: `context compacted (${e.trigger || 'auto'})` }));
      return;

    /*
     * FEAT-042 — the per-turn ground truth: the wire model that actually
     * produced the latest main-thread assistant message. Matching the
     * expectation (what the user launched with / last confirmed) just keeps
     * the chip current; NOT matching it is a change the user did not initiate
     * — flag it. A pending user switch (modelPending) or a null expectation
     * (e.g. reattach where session-init never re-fired, or an inherit whose
     * resolution is by definition the CLI's to make) adopts without flagging:
     * claiming "silent switch!" without a baseline would be a false alarm.
     *
     * BUG-084 — the baseline that matters is what the USER SELECTED, not the
     * configured default the CLI reports at `session-init`. When the user has an
     * explicit /model override (`state.overrides.model`), the per-turn report
     * that matches THAT is the user's own choice answering — never a silent
     * switch — even though the init-seeded `expectedLiveModel` (the settings.json
     * default, e.g. Fable) disagrees. Without this, every resume re-seeds the
     * stale default and then flags the user's own opus turn as "Fable → opus"
     * ("per-turn report") on repeat. Matching the choice quietly REALIGNS the
     * baseline so a later GENUINE deviation (live ≠ selection AND ≠ last) still
     * surfaces, exactly as FEAT-042 intends.
     */
    case 'model-observed': {
      const prev = liveWireModel ?? expectedLiveModel;
      const chosen = state.overrides?.model ?? null; // the user's explicit /model
      const matchesChoice = chosen != null && sameModel(chosen, e.model);
      const silent = !modelPending && !matchesChoice
        && expectedLiveModel != null && !sameModel(expectedLiveModel, e.model);
      liveWireModel = e.model;
      if (matchesChoice) expectedLiveModel = e.model; // realign the stale baseline, quietly
      if (silent) {
        expectedLiveModel = e.model; // flag ONCE; this is the new reality
        flagModelChange(prev, e.model, 'per-turn report');
      }
      paintModelChip();
      return;
    }

    /*
     * FEAT-042 — the SDK's one DEDICATED switch signal: a safeguard refusal
     * made the CLI retry on a fallback model, persistently. By definition not
     * user-initiated — always flag. The server also folds it into the
     * effective config (an `effective-config` re-emit follows and will agree).
     */
    case 'model-changed': {
      const from = e.from ?? liveWireModel ?? expectedLiveModel;
      liveWireModel = e.to;
      expectedLiveModel = e.to;
      flagModelChange(from, e.to, `refusal fallback${e.category ? ` · ${e.category}` : ''}`);
      paintModelChip();
      return;
    }

    case 'rate-limit':
      // `allowed` is the normal steady state — only speak up when it isn't.
      // (status 'rejected' ALSO arrives as an attributed `provider-error`
      // quota-window card — this line stays as the lightweight ticker.)
      if (/^(allowed|ok)$/i.test(e.status)) return;
      say(`rate limit: ${e.status}${e.utilization != null ? ` · ${Math.round(e.utilization * 100)}%` : ''}`, true);
      return;

    /*
     * BUG-031 — a provider/API failure, normalized by the runtime (kind,
     * retryable, provider, detail — the provider's own words). Two shapes:
     *  - `retrying` present: the ENGINE is retrying it itself; the turn is
     *    still alive, so only the ticker speaks (no card per attempt — a long
     *    outage emits many of these) and busy stays true honestly.
     *  - terminal: attributed transcript card + ticker + the session status
     *    turns to this error. Busy resolution is the following `turn-end`'s
     *    job (the CLI always emits its result frame after the error carrier);
     *    the watchdog below is the belt-and-braces guarantee that the
     *    composer can NEVER stay stuck if that result never comes.
     */
    case 'provider-error': {
      if (e.retrying) {
        const wait = e.retrying.delayMs >= 1000 ? `${Math.round(e.retrying.delayMs / 1000)}s` : `${e.retrying.delayMs}ms`;
        say(`${e.provider} — ${provErrorLabel(e)}${e.statusCode != null ? ` (HTTP ${e.statusCode})` : ''} · retry ${e.retrying.attempt}/${e.retrying.maxRetries} in ${wait}`, true);
        return;
      }
      /*
       * BUG-035: a missing TOOL server is honest news, but it is not this
       * turn's failure — the turn is alive and will end normally. So it gets
       * the same attributed, durable card + ticker line, and deliberately does
       * NOT become state.provError (which labels the turn-end / session status)
       * and does NOT arm the busy watchdog (the turn still owes us a result).
       */
      if (e.kind === 'tooling-unavailable') {
        // Still starting (the CLI does not block turn one on its MCP servers):
        // an honest one-line "attaching…" notice, no failure card.
        if (e.pending) {
          say(`${e.provider} — ${e.detail}`, true);
          return;
        }
        renderProviderError(e);
        say(provErrorLine(e), true);
        return;
      }
      state.provError = e;
      renderProviderError(e);
      say(provErrorLine(e), true);
      if (state.busy) armBusyWatchdog(`${e.provider} ${provErrorLabel(e)}`);
      paintSessStatus();
      return;
    }

    case 'turn-end': {
      /*
       * BUG-030's invariant, as corrected by BUG-113: anything still `running`
       * here MAY be a zombie from a cut host CLI — or it may be a background
       * agent the server's own turn-end sweep deliberately spared, which
       * outlives this turn by design. This tab cannot tell them apart, so it
       * nominates them and lets the server's next post-turn snapshot answer.
       * Nothing is settled here.
       */
      nominateCutAgents();
      finishStream(mainThread());
      setBusy(false);
      state.turnStartedAt = 0;
      // The turn that just ended is exactly the one submit() painted the
      // pending bubble for — it reached the agent, so there is nothing left
      // to roll back (see rollBackPendingSend / BUG-013).
      state.pendingSend = null;
      /*
       * BUG-129: a turn ENDED, so the prompt that started it is in the server's
       * transcript — the handed-off batch is durable somewhere other than this
       * tab and the outbox copy can go. This is the only place that retires it:
       * an ack does not, because the server acks `delivered: true`
       * unconditionally without knowing whether the bridge took the text.
       * Cleared BEFORE the force-send / flush dispatch below, which sets a new one.
       */
      state.outbox = null;
      persistQueue();
      // BUG-031: an API-error turn reports subtype 'success' with is_error:
      // true (terminal_reason 'api_error') — labelling it by subtype would
      // literally print "success" as the error. Prefer the attributed
      // provider-error this turn produced, then the engine's terminal reason,
      // then the subtype.
      /*
       * BUG-136: an error turn carries the engine's OWN sentence about why in
       * `result` — the server has forwarded it as `resultText` all along and
       * nothing has ever read it. So a container whose credentials mount had
       * gone stale ended `subtype:'success'`, `is_error:true`, terminal reason
       * 'completed', and the UI latched a badge that said "Error" over a hint
       * that said "success", while the one line that named the fault — "Not
       * logged in · Please run /login" — was dropped on the floor. Used only
       * where the label would otherwise be the bare subtype, i.e. exactly the
       * case where the alternative is a word that contradicts the badge.
       */
      const engineReason = (e.isError && typeof e.resultText === 'string')
        ? e.resultText.trim().replace(/\s+/g, ' ').slice(0, 200)
        : '';
      const endLabel = e.interrupted ? 'interrupted'
        : (e.isError && state.provError) ? `${state.provError.provider} ${provErrorLabel(state.provError)}`
          : (e.isError && e.terminalReason === 'api_error') ? 'api error'
            : engineReason ? engineReason
              : e.subtype;
      const bits = [endLabel];
      if (e.durationMs) bits.push(`${(e.durationMs / 1000).toFixed(1)}s`);
      // BUG-100: this dollar figure is an API-EQUIVALENT ESTIMATE, not money the
      // user is billed (they run on a fixed plan). Label it so a glance can never
      // read it as real spend — the user was briefly alarmed by an unlabelled
      // "$65.5067" here.
      if (e.costUsd) bits.push(`~$${e.costUsd.toFixed(4)} est.`);
      if (e.numTurns) bits.push(`${e.numTurns} turns`);
      const summary = bits.join(' · ');
      // BUG-100: the run summary is an OUTCOME, not the resting status. It must
      // not be what replaces the isolation label. An ERROR still speaks up in the
      // footer ticker (that IS a transient alert, worded and marked as one); a
      // clean/interrupted outcome goes to the transcript's durable outcome rail
      // and the footer returns to its stable label.
      if (e.isError && !e.interrupted) {
        say(summary, true);
      } else {
        appendTurnOutcome(summary, e.costUsd);
        restLabel();
      }
      // A turn that ended in error (not a deliberate interrupt) is the
      // "Error / stopped — explicit" state; a clean end is honestly idle.
      // With a provider-error on record, the state carries ITS attributed
      // line (provider + kind + the provider's own detail), not the subtype.
      state.sessError = (e.isError && !e.interrupted)
        ? (state.provError ? provErrorLine(state.provError) : summary)
        : null;
      paintSessStatus();
      renderStrip();
      void refreshCurrentProjectSessions();
      // FEAT-022: a turn boundary is exactly when the autonomous loop either
      // advances (server auto-continues) or halts at the stop condition. Re-read
      // the authoritative mode so the badge counter and the halt are both shown.
      if (state.autonomous.autonomous) void refreshAuto();
      // FEAT-031 Part A: a force-send's interrupt lands here as an
      // `interrupted:true` turn-end — this is the ONLY reliable signal that
      // the aborted turn has actually stopped, so deliver the forced item
      // right now, ahead of (and instead of) the normal queue flush this
      // cycle. Whatever else is still queued flushes next time around.
      if (state.forceSend) {
        const item = state.forceSend;
        state.forceSend = null;
        deliverForced(item);
      } else {
        flushQueue(); // the boundary the queue was waiting for
      }
      return;
    }

    case 'error':
      // BUG-090: a resume refused ONLY because the session lives under a
      // pre-isolation store dir isn't a dead end — offer a one-click fork
      // instead of the raw fork:true/resumeEncodedDir prose. Handled before the
      // generic fatal path so it never latches sessError / fails the queue.
      if (e.needsFork && e.needsFork.resumeSessionId && e.needsFork.resumeEncodedDir) {
        armNeedsFork(e.needsFork);
        return;
      }
      /*
       * BUG-149: `fatal` on this frame does not mean the session is dead — it
       * means it is not available to THIS tab. Handled before the generic fatal
       * path, like needsFork above, so it never latches sessError, never marks
       * the other queued rows dead, and — the actual bug — never returns before
       * the un-acked text has been reclaimed into durable storage.
       */
      if (e.code === 'live-elsewhere') {
        handleLiveElsewhere(e.message);
        return;
      }
      say(e.message, true);
      if (e.fatal) {
        state.sessError = e.message; // set BEFORE setBusy(false) so its repaint sees it
        setBusy(false);
        state.turnStartedAt = 0;
        cancelForceSend('the session hit a fatal error');
        failQueue('the session hit a fatal error');
      }
      else if (isBudgetStop(e)) {
        // BUG-013: lock the composer for good (until a fresh connect), and if
        // this is the rejection of an in-flight send — not just the initial
        // budget-stop notice — undo the optimistic "you" bubble so the
        // transcript never claims Claude received a message it never got.
        state.budgetLocked = true;
        state.budgetLockReason = e.message;
        state.sessError = e.message;
        rollBackPendingSend();
        setBusy(false);
        state.turnStartedAt = 0;
        cancelForceSend('the session hit its budget limit');
        failQueue('the session hit its budget limit');
        paintComposerFor(viewedThread());
      } else if (state.pendingStart != null) {
        // BUG-029: a `start`/resume refused before its `ack` — the turn never
        // began (e.g. the retryable survivor-drain guard). BUG-045: when the
        // SERVER says the refusal is retryable (a drain that WILL end), the
        // message becomes a queue row that retries itself — bouncing it to the
        // composer left the user mashing Enter for the length of the drain. A
        // non-retryable refusal keeps BUG-029's composer hand-back exactly.
        if (e.retryable) queueRetryableRefusal(e.drain);
        else {
          failDrainWaitAttempt(e.message);
          rollBackPendingStart();
        }
      } else if (state.busy) armBusyWatchdog(e.message);
      return;

    case 'session-closed':
      say(`session closed (${e.reason})`);
      // BUG-153: the run is over, so nothing is "running in the background"
      // either — this is the third place `sessDetached` was cleared, and the
      // follow flag now carries that meaning on its own.
      state.followingLive = false;
      setBusy(false);
      state.turnStartedAt = 0;
      state.pendingSend = null;
      cancelForceSend(`the session closed (${e.reason})`);
      failQueue(`the session closed (${e.reason})`);
      return;

    default:
      return;
  }
}

async function refreshCurrentProjectSessions() {
  const id = state.current.projectId;
  if (!id) return;
  await loadSessions(id, { force: true });
}

/* --------------------------------------------------------------- composer */

/* --------------------------------------------------- mid-turn send queue */

/* ------------------------------------------------- BUG-129: a queue that
 * survives the tab (option A — the CONTAINED half of the fix)
 *
 * The defect: durability was attached to DELIVERY, not to acceptance. The only
 * durable copy of a typed message was the one the server writes AFTER a
 * successful handoff, so everything between "the composer accepted it" and
 * "the CLI took it" lived in one tab's heap: a reload, a tab close, a crash or
 * a session switch destroyed it silently, and no store on either side had a
 * copy to notice the loss against (see the ticket's Evidence — the lost message
 * was in no file anywhere).
 *
 * What this closes: the reload / close / switch half. Every mutation of
 * state.queue mirrors the rows into localStorage under the SAME session key the
 * composer draft uses (draftKey — BUG-083), and openSession/startNew read them
 * back for the session they belong to.
 *
 * What this deliberately does NOT close (do not read the dock as claiming
 * otherwise — they are option B's, and each is named in the ticket):
 *   - a refusal that arrives AFTER the socket accepted the frame: the server
 *     acks delivery unconditionally, so the optimistic bubble still stands and
 *     the transcript still lies about that one;
 *   - the mid-reply re-attach that deletes a painted bubble (its text lands in
 *     this queue, so it is now at least durable — but the bubble still vanishes);
 *   - the composer box itself, which is still volatile (state.drafts is a Map).
 *
 * Two rules this file keeps deliberately:
 *   - A row is cleared from storage when the USER clears it (discard / edit to
 *     empty) or when it becomes durable somewhere else — never merely because
 *     it was optimistically painted or handed to a socket. That is why
 *     state.outbox exists.
 *   - A row that comes back from storage is marked `restored` and SAYS it was
 *     not delivered. Making the unsent state visible is worth more than making
 *     the loss rarer (and an outbox row comes back `dead`, never auto-resent —
 *     redelivering a message the user already sent is a different harm, and the
 *     ticket's Risks section names it).
 */
const QUEUE_KEY = 'cs.queue.v1';
const QUEUE_MAX_SESSIONS = 20;      // newest N sessions keep rows; older entries are dropped
const QUEUE_MAX_BYTES = 400_000;    // well under the ~5 MB origin quota, with the other keys in mind

/*
 * The storage key state.queue currently mirrors — null means "these rows belong
 * to no session yet / a boundary just happened", and nothing is written. It is
 * nulled by resetTranscript (every session boundary passes through it) BEFORE
 * the rows are dropped, so a boundary can never write the outgoing session's
 * empty queue over the INCOMING session's stored rows, nor the reverse.
 */
let queueKey = null;

function readQueueStore() {
  try {
    const o = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '{}');
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch { return {}; } // garbage / private mode — start fresh rather than throw in a paint
}

function writeQueueStore(store) {
  // Newest-first by `at`, capped by count and then by bytes. Age alone never
  // evicts: dropping a person's undelivered words because they are old is the
  // very failure this exists to stop.
  let keys = Object.keys(store).sort((a, b) => (store[b]?.at ?? 0) - (store[a]?.at ?? 0));
  for (const k of keys.slice(QUEUE_MAX_SESSIONS)) delete store[k];
  keys = keys.slice(0, QUEUE_MAX_SESSIONS);
  let body = JSON.stringify(store);
  while (body.length > QUEUE_MAX_BYTES && keys.length > 1) {
    delete store[keys.pop()];
    body = JSON.stringify(store);
  }
  try { localStorage.setItem(QUEUE_KEY, body); return true; }
  catch {
    // Quota (or private mode): shed everything but this session and try once.
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queueKey && store[queueKey] ? { [queueKey]: store[queueKey] } : {})); }
    catch { /* storage is unavailable — volatile, exactly as before this change */ }
    return false;
  }
}

/**
 * The key to write under, or null to write nothing. STRICT: only the key the
 * rows were adopted under, and only while state.current still agrees with it.
 *
 * It is deliberately not clever about mismatches. A mismatch means a boundary
 * this code has not been told about, and the tempting repair — "assume the key
 * moved, carry the entry over" — destroyed a session's stored rows in testing:
 * mid-`openSession` the key had already become the incoming session's while the
 * queue was momentarily empty, so the "migration" retargeted onto that
 * session's key and the empty-queue write then deleted its rows. Writing
 * NOTHING on a mismatch cannot lose anything; the one real retarget (a
 * pending-new session acquiring its id) is done explicitly by retargetQueue().
 */
function queueTargetKey() {
  const k = draftKey(state.current);
  return queueKey && k && k === queueKey ? k : null;
}

/**
 * The pending-new session just acquired a real id: its rows were stored under
 * `p\0<project>` and a reload now lands in `s\0<dir>\0<id>`, so carry them.
 * Called ONLY from the session-init frame — never inferred from a key mismatch,
 * for the reason above. Refuses to overwrite an existing destination entry:
 * those are another session's undelivered words.
 */
function retargetQueue() {
  const k = draftKey(state.current);
  if (!queueKey || !k || k === queueKey || !queueKey.startsWith('p\x00') || !k.startsWith('s\x00')) return;
  const store = readQueueStore();
  if (store[queueKey] && !store[k]) { store[k] = store[queueKey]; delete store[queueKey]; writeQueueStore(store); }
  queueKey = k;
}

/** Mirror state.queue (+ the in-flight outbox) into storage. Never throws. */
function persistQueue() {
  const k = queueTargetKey();
  if (!k) return;
  const rows = state.queue
    .filter((q) => typeof q.text === 'string' && q.text.trim())
    .map((q) => ({ text: q.text, composedAt: q.composedAt ?? Date.now(), dead: q.dead ?? null }));
  // A force-send waiting for its interrupt to land is out of state.queue and not
  // yet handed over (FEAT-031 Part A) — a third volatile spot, mirrored as an
  // ordinary undelivered row. cancelForceSend puts the live copy back itself.
  if (state.forceSend?.text?.trim()) {
    rows.push({ text: state.forceSend.text, composedAt: state.forceSend.composedAt ?? Date.now(), dead: null });
  }
  const store = readQueueStore();
  if (!rows.length && !state.outbox) delete store[k];
  else store[k] = { at: Date.now(), rows, outbox: state.outbox ?? null };
  writeQueueStore(store);
}

/**
 * Is every text of a handed-off batch already in the transcript ON SCREEN? If
 * so the server DID take it and it is durable — the row must not come back
 * (crying "undelivered" over a message that plainly arrived trains the user to
 * ignore the one time it is true). Matched against `.you` bubbles only, never
 * the whole pane: the assistant quotes the user constantly.
 */
function transcriptHasAll(texts) {
  const said = [...mainThread().paneEl.querySelectorAll('.you')].map((n) => n.textContent ?? '');
  return texts.every((t) => {
    const needle = t.trim();
    return needle ? said.some((s) => s.includes(needle)) : true;
  });
}

/**
 * The same question asked of the STORE rather than the screen. What is on
 * screen is not the whole transcript: reopening at a remembered position
 * renders a WINDOW around that position (openHistoryWindow), so a message that
 * was delivered perfectly well can be absent from the pane — and raising "this
 * may never have arrived" over it is the crying-wolf failure above, in the case
 * the reader is least able to check. (Observed: a delivered message read as
 * unconfirmed purely because the reload landed at a deep index.) Read-only,
 * over the transcript endpoint the session view already uses; a failure to
 * answer means "not confirmed", which errs toward keeping the text.
 */
async function outboxDelivered(texts) {
  if (transcriptHasAll(texts)) return true;
  const cur = state.current;
  if (!cur?.sessionId) return false;
  try {
    const t = await api.transcriptTail(cur.encodedDir, cur.sessionId, { limit: 60 });
    const said = (t.messages ?? [])
      .filter((m) => m.role === 'user')
      .flatMap((m) => (m.blocks ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? ''));
    return texts.every((x) => said.some((s) => s.includes(x.trim())));
  } catch { return false; }
}

/**
 * Take ownership of the current session's stored rows and put them back on
 * screen. Called after a session's transcript is on screen (openSession) and
 * for a pending-new session (startNew) — i.e. at the point state.current is
 * settled and resetTranscript has already emptied the queue.
 */
function adoptQueue() {
  queueKey = draftKey(state.current);
  if (!queueKey) return;
  const entry = readQueueStore()[queueKey];
  if (!entry) return;
  let restored = 0;
  for (const r of (Array.isArray(entry.rows) ? entry.rows : [])) {
    if (typeof r?.text !== 'string' || !r.text.trim()) continue;
    state.queue.push({
      text: r.text,
      dead: typeof r.dead === 'string' ? r.dead : null,
      composedAt: Number.isFinite(r.composedAt) ? r.composedAt : Date.now(),
      restored: true,
    });
    restored++;
  }
  const ob = entry.outbox;
  const obTexts = ob && Array.isArray(ob.texts) ? ob.texts.filter((t) => typeof t === 'string' && t.trim()) : [];
  state.outbox = null;
  if (restored) {
    paintQueue();
    say(`${restored} undelivered message${restored === 1 ? '' : 's'} restored from before the reload — in the dock, still unsent`);
  } else if (!obTexts.length) {
    persistQueue(); // an entry with nothing left in it — retire it
    return;
  }
  // The handed-off batch is judged against the transcript, which may need a
  // fetch — so it settles after the rows above rather than holding them up.
  // `mine` pins the session this answer belongs to: a switch while the fetch is
  // in flight must not drop the outgoing session's row into the incoming one
  // (the BUG-079 class — a late answer acting on the wrong session).
  if (!obTexts.length) return;
  const mine = queueKey;
  void outboxDelivered(obTexts).then((delivered) => {
    if (queueKey !== mine) return;
    if (delivered) { persistQueue(); return; } // confirmed on disk — retire the stored copy
    // Handed to the socket, and no turn was ever seen carrying it. It may have
    // arrived; it may have been refused after the ack (that refusal is option
    // B's to fix). It comes back DEAD — readable, copyable, editable, and never
    // resent behind the user's back.
    for (const t of obTexts) {
      state.queue.push({
        text: t,
        dead: 'sent, but this tab never saw its turn start — check the transcript before sending it again',
        composedAt: Number.isFinite(ob.at) ? ob.at : Date.now(),
        restored: true,
      });
    }
    paintQueue();
    say(`${obTexts.length} message${obTexts.length === 1 ? '' : 's'} sent before the reload cannot be confirmed as delivered — kept in the dock`, true);
  });
}

function queueMessage(text) {
  state.queue.push({ text, dead: null, composedAt: Date.now() });
  paintQueue();
  say(`message queued — ${state.queue.length} waiting; expand it in the dock to edit before it sends`);
}

/** "2m11s" / "43s" — coarse enough for a factual note, not a stopwatch. */
function fmtElapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${String(rem).padStart(2, '0')}s`;
}

/*
 * Every item that reaches this queue was queued because `state.busy` was true
 * (queueMessage is only ever called mid-turn — see submit() and the
 * re-attach path) and it only DELIVERS once `state.busy` flips back to false
 * (flushQueue runs off that transition). So anything in state.queue crossed
 * at least one turn boundary between compose and delivery, by construction —
 * unlike a normal submit(), which bubbles and sends in the same tick. That is
 * exactly the "meaningful" case FEAT-002 wants a note for; a directly-typed
 * message never goes through this function at all, so it never gets one.
 *
 * FEAT-031 Part B — PER-ITEM note, not one per batch: FEAT-002 originally
 * gave the whole delivered batch ONE note framed on the earliest item. Live
 * use (FEAT-031, user-confirmed) showed that flattens distinct messages —
 * three texts composed minutes apart at different points in the turn read
 * as ONE message with one timestamp, losing exactly the context the note
 * was meant to preserve. Each item now gets its OWN bracketed header
 * immediately above its OWN text (`[msg 2/3 · queued 1m10s ago]`) so the
 * model can still tell them apart even though they still arrive together
 * in a single combined turn (see flushQueue below — delivery is still one
 * turn, just no longer one undifferentiated blob).
 */
function queueItemNote(item, index, total) {
  const elapsed = fmtElapsed(Date.now() - item.composedAt);
  if (total === 1) {
    return `[Queued ${elapsed} ago, composed while the previous response was still being written — it predates that response.]`;
  }
  return `[msg ${index + 1}/${total} · queued ${elapsed} ago, composed while the previous response was still being written]`;
}

/**
 * The queue lives in the DOCK, not the transcript: a bubble at a transcript
 * position would claim the message was said there — it was not said at all
 * yet. Rows collapse to a preview and expand to an EDITABLE textarea; the
 * text sent is whatever the row holds at delivery time.
 */
function paintQueue() {
  const box = $('#queueBox');
  const pending = state.queue.filter((q) => !q.dead);
  // BUG-129: storage mirrors the queue at EVERY mutation, and every mutation
  // repaints — so this one call is the whole write path. It runs before the
  // early return too: emptying the queue (discarding the last row) must clear
  // the stored copy, or a discarded message would come back from the dead.
  persistQueue();
  if (!state.queue.length) { box.hidden = true; clear(box); return; }
  clear(box);
  /*
   * BUG-134 — this chip said three things, and all three were wrong.
   * (Filed as BUG-135 in commit e9efb92; renumbered when another lane minted the
   * same id minutes earlier.)
   *
   * FEAT-064 rendered the server's refusal payload verbatim: an elapsed, a
   * count of background agents and their ids. Read live, it said "held 45m59s
   * by 2 background agents (a3d3e1022ec985f4e, a3ba9374904af5e4d)". Against the
   * broker's own record at that moment:
   *
   *  - The 45m59s was `drainHeldSince` — the epoch of the FIRST decline this
   *    broker ever made, deliberately never reset (session-host.mjs: "an epoch,
   *    not a ticker"). The user's message had been queued for a fraction of it.
   *    Presenting a broker-lifetime statistic in a sentence about the user's
   *    message reads as "your message has been ignored for 46 minutes".
   *  - The ids were captured at ONE refusal and never refreshed; the broker's
   *    level frames reported 4, 5 and 6 lanes with different ids over two
   *    minutes of sampling. Opaque, and stale besides.
   *  - The attribution was false. Background agents do NOT hold delivery:
   *    FEAT-065 delivers into a drain-held survivor precisely while they run,
   *    and the journal shows it doing so 13 times in the hour this was
   *    displayed. What delays a message is the FOREGROUND turn (`midTurn`),
   *    which opens and closes continuously.
   *
   * So: report the user's OWN wait, from the row this tab has held all along,
   * and name the condition that actually resolves it. No ids — nothing the user
   * can act on was ever in them.
   */
  const heldRow = pending.find((q) => q.drainWait && q.drain);
  const heldWhy = (row) => {
    // A row restored from storage may predate composedAt — then say nothing
    // about elapsed rather than render a NaN.
    const waited = Number.isFinite(row.composedAt) ? ` · queued ${fmtElapsed(Date.now() - row.composedAt)} ago` : '';
    return `waiting on drain — the session is mid-reply; this retries every few seconds and goes in at its next pause${waited} — edit or discard below`;
  };
  /*
   * BUG-129: rows can now outlive the tab, so for the first time the dock can
   * hold pending text while this tab is NOT driving the session (a reload
   * mid-reply follows the live session but does not take it over until the user
   * sends). Nothing flushes in that state — so the ordinary "delivers at the
   * next pause" would be a promise the client cannot keep, which is the same
   * class of lie as the transcript claiming a refused message was delivered.
   * Say what is actually true and name the action that resolves it.
   */
  /*
   * BUG-149 widened this from `restored rows only` to the actual condition, and
   * moved it below the branches that are MORE specific about the same state.
   *
   * The test was `some(restored) && !live`, but nothing about a restored row is
   * what stops delivery — flushQueue's own first line is `!state.live ||
   * !state.ws`, so ANY pending row in a tab that holds no socket is going
   * nowhere. Observed in a screenshot of the two-tab refusal: a message queued
   * in a read-only tab sat under "1 queued message · delivering…" while nothing
   * was delivering or could. Same class of lie as the transcript claiming a
   * refused message was delivered, in the one place the user looks for the
   * truth about undelivered text.
   *
   * The drain-wait rows are the exception and are handled ABOVE: those DO have
   * a self-retry loop that reconnects, so "not driving" would understate them.
   */
  const notDriving = !isDriving(); // BUG-153: the same predicate the chip and the guards read
  const why = !pending.length
    // BUG-149: name the affordance that now exists, instead of asking the user
    // to select text out of a textarea by hand.
    ? 'never delivered — put it back in the composer, or discard'
    : heldRow
      ? heldWhy(heldRow)
      : pending.some((q) => q.drainWait)
      // BUG-045: the visible "why is this waiting" chip for a retryable refusal.
      ? 'waiting for the previous turn to finish draining — retries itself; edit or discard below'
      : state.dropped
        ? 'connection dropped — reconnect, then these deliver at the next pause'
        : notDriving
        // BUG-153: name the way out. The row now carries "To composer" in this
        // state, and a way out nobody can see is the dead end this fixes — the
        // user's account of it was "id need to remove msg from queue and send
        // again", which is what a person does when the affordance is invisible.
        ? 'this tab is not driving the session — send a message (or reconnect) and these go with the next turn, or put one back in the composer'
        : state.busy
          /*
           * BUG-130: this said "one per turn", which is what the queue did
           * before FEAT-002/FEAT-031 and has not been true since — flushQueue
           * delivers the WHOLE pending batch as a single turn (segmented, one
           * `[msg i/N …]` header per item). The label was the only thing still
           * describing the old behaviour, and a user read it and reported the
           * old bug. Say what actually happens, and say it in the plural only
           * when there IS a batch.
           */
          ? (pending.length > 1
              ? 'Claude is working — these deliver together at the next pause, as one turn'
              : 'Claude is working — delivers at the next pause')
          : 'delivering…';
  /*
   * BUG-129: say it whatever else the dock is saying. A restored row is text
   * that outlived the tab and is STILL UNSENT; if that fact only appeared in
   * the branches where nothing else was happening, the one state where it
   * matters most — reattached mid-reply, where the label is busy explaining the
   * running turn — would be exactly the one that hid it.
   */
  const restoredNote = pending.some((q) => q.restored)
    ? ' · restored after a reload, still unsent' : '';
  const n = pending.length || state.queue.length;
  box.append(el('div', { class: 'q-l', text: `${n} ${pending.length ? 'queued' : 'undelivered'} message${n === 1 ? '' : 's'} · ${why}${restoredNote}` }));
  state.queue.forEach((item, i) => {
    // BUG-129: `restored` is its own visual state — a row that outlived the tab
    // and is still unsent must not look like one on its way out.
    const det = el('details', { class: `qrow${item.dead ? ' dead' : ''}${!item.dead && item.drainWait ? ' drain-wait' : ''}${item.restored ? ' restored' : ''}` });
    const preview = item.text.replace(/\s+/g, ' ').slice(0, 72);
    det.append(el('summary', {},
      el('span', { class: 'tw', text: '▶' }),
      el('span', { class: 'qp', text: preview + (item.text.length > 72 ? '…' : '') }),
      el('span', {
        class: 'qs',
        text: item.dead ? `NOT delivered — ${item.dead}`
          : item.drainWait ? 'waiting on drain'
            : item.restored ? `unsent · restored${i === 0 ? ' · next' : ` · #${i + 1}`}`
              : (i === 0 ? 'next' : `#${i + 1}`),
      })));
    const ta = el('textarea', { class: 'qedit', 'aria-label': 'Edit queued message' });
    ta.value = item.text;
    // BUG-129: an edit is a mutation of the only copy — mirror it as it is typed,
    // not at some later repaint that may never come.
    ta.addEventListener('input', () => { item.text = ta.value; persistQueue(); });
    const acts = el('div', { class: 'cacts' });
    /*
     * BUG-153 — force-send is offered only where it can actually run. It is
     * gated on the SAME predicate forceSend() itself refuses on, because the
     * button that answers "no live session to force-send over" is a button that
     * should not have been there: the only action it can perform in that state
     * is to tell the user it cannot act.
     */
    if (!item.dead && isDriving() && !state.dropped) {
      // FEAT-031 Part A — unmistakably distinct from the normal queue (which
      // waits): this INTERRUPTS whatever is running and delivers NOW. Reuses
      // the existing `.mini.danger` treatment (the app's one destructive-
      // action style — see rename/delete-session confirms) rather than
      // inventing a second "this is serious" visual language. Only offered
      // on live rows — a dead row has nothing left to interrupt over.
      const force = el('button', { class: 'mini danger force-send', text: 'Force send' });
      force.title = 'Interrupt in-flight work and deliver this message right now';
      force.addEventListener('click', () => forceSend(item));
      acts.append(force);
    }
    /*
     * BUG-149 — a dead row was a dead end: the only ways out were selecting
     * the textarea by hand or Discard, so "recoverable" meant "retypeable in
     * practice". One click puts the text back in the composer where the next
     * Enter sends it. Explicit by design — the app never re-sends a refused
     * message on the user's behalf (see handleLiveElsewhere).
     *
     * BUG-153 widened it from dead rows to EVERY row, because the state the
     * user actually got stuck in produces a live one. Reload a tab that is not
     * driving a still-running session and the queued text comes back as
     * `restored` — not dead, so no way back — offering only a Force send that
     * refuses. Reported verbatim: "if i reload page it still shows the message
     * in queue instead of input field, then id need to remove msg from queue
     * and send again". Deleting and retyping IS losing the message, just
     * slowly, so the way back out is unconditional now: a row is the user's
     * own words, and reclaiming your own words needs no precondition.
     */
    const back = el('button', { class: 'mini', text: 'To composer' });
    back.title = 'Put this text back in the composer to send it again';
    back.addEventListener('click', () => {
      node.prompt.value = node.prompt.value ? `${node.prompt.value}\n\n${item.text}` : item.text;
      state.queue.splice(state.queue.indexOf(item), 1);
      // BUG-153: this row may be the drain-wait retry's in-flight attempt — the
      // text is leaving the queue, so the attempt must not keep pointing at it
      // (a stale pointer makes the next refusal read as "already retried" and
      // drop it — BUG-079's Finding A, in miniature).
      if (state.drainWaitAttempt === item) state.drainWaitAttempt = null;
      if (!drainWaitItem()) disarmDrainWaitRetry();
      paintQueue();
      autosize();
      node.prompt.focus();
      say('put back in the composer — press Enter to send it');
    });
    acts.append(back);
    const drop = el('button', { class: 'mini x', text: 'Discard' });
    drop.addEventListener('click', () => {
      state.queue.splice(state.queue.indexOf(item), 1);
      paintQueue();
    });
    acts.append(drop);
    det.append(ta, acts);
    box.append(det);
  });
  box.hidden = false;
}

/** Boundary: deliver the WHOLE pending batch as one turn — see the note below. */
let flushBackoff = false; // breaks the send-failed → setBusy(false) → flush loop
/*
 * Deliver ALL pending queued messages as ONE turn, not one-per-turn. Messages
 * queued during a single work period are a batch of context for the next
 * opportunity — fragmenting them into separate turns loses the connection
 * between them and burns turns. They join as blank-line-separated SEGMENTS,
 * each with its own `queueItemNote` header (FEAT-031 Part B — see that
 * comment for why per-item, not per-batch), in their real order — which is
 * also exactly how the transcript persists them, so a live render and a
 * reload agree.
 */
function flushQueue() {
  if (flushBackoff) return;
  // FEAT-065: a delivery-relay socket has no session behind it — flushing into
  // it would bounce every row. Queued rows wait for the drain-wait retry loop
  // (or a real bridge) instead.
  // BUG-153: one predicate — `isDriving()` already excludes the relay socket.
  if (!isDriving() || state.busy || state.dropped) { paintQueue(); return; }
  // BUG-045: a drain-wait row whose self-retry is IN FLIGHT is that retry's to
  // deliver (or put back) — flushing it too would send the same text twice.
  const items = state.queue.filter((q) => !q.dead && q.text.trim() && q !== state.drainWaitAttempt);
  /*
   * BUG-129: hand the batch to the OUTBOX before it leaves state.queue, not
   * after. Between the splice below and turn-end these rows are in no store
   * anywhere — that window is exactly where a reload used to destroy them, and
   * it is why the outbox is set first: any paint in between must already see it.
   */
  if (items.length) state.outbox = { texts: items.map((q) => q.text.trim()), at: Date.now() };
  // Drop empties (edited to nothing) but keep any dead rows for their notice.
  state.queue = state.queue.filter((q) => q.dead || q === state.drainWaitAttempt);
  if (!items.length) { paintQueue(); return; }
  const text = items.map((q, i) => `${queueItemNote(q, i, items.length)}\n${q.text.trim()}`).join('\n\n');
  // One bubble for the combined turn — it IS one turn now, and this matches
  // what the store writes, so reopening the session shows the same thing.
  youBubble(mainThread(), text);
  if (state.viewing === 'main') scrollDown();
  state.turnStartedAt = Date.now();
  state.turnStartUnknown = false; // BUG-033: this tab started this turn — the clock is real
  setBusy(true);
  if (!send({ type: 'send', prompt: text })) {
    // The socket died between the boundary and this send — put them ALL back.
    for (let i = items.length - 1; i >= 0; i--) state.queue.unshift(items[i]);
    state.outbox = null; // nothing was handed over: the rows themselves are the record again
    flushBackoff = true;
    setTimeout(() => { flushBackoff = false; }, 1500);
    setBusy(false);
    paintQueue();
    return;
  }
  say(items.length === 1 ? 'delivered the queued message' : `delivered ${items.length} queued messages together`);
  paintQueue();
}

/*
 * FEAT-031 Part A — force-send: interrupt in-flight work and deliver a
 * queued message NOW instead of waiting for the natural turn boundary
 * flushQueue() waits for. Deliberately destructive — the user accepts
 * losing whatever the current turn was mid-producing — and unmistakably
 * distinct from the normal queue row, which only ever waits.
 *
 * Reuses the SAME interrupt path the composer's stop button already drives
 * (`send({ type: 'interrupt' })` -> `AgentSession.interrupt()` in
 * agent-bridge.ts, see the `#go` click handler) rather than inventing a
 * second abort channel. The item is pulled out of state.queue immediately
 * so the eventual flushQueue() for whatever else is still queued does not
 * also redeliver it, and stashed in state.forceSend so the turn-end handler
 * (which is the ONLY place that reliably knows the interrupted turn has
 * actually stopped) can deliver it the moment that happens.
 */
function forceSend(item) {
  const idx = state.queue.indexOf(item);
  if (idx !== -1) state.queue.splice(idx, 1);
  if (!isDriving() || state.dropped) {
    // No socket to interrupt over — same honesty rule as the detached-run
    // guard on the stop button, and BUG-153: the same predicate, so the chip
    // beside the composer cannot claim a turn this refusal denies exists.
    if (idx !== -1) state.queue.splice(idx, 0, item); else state.queue.push(item);
    paintQueue();
    return say('no live session to force-send over — reattach first, then force-send again', true);
  }
  if (!state.busy) {
    // Nothing running to interrupt — this degrades to an immediate send.
    paintQueue();
    return deliverForced(item);
  }
  state.forceSend = item;
  paintQueue();
  send({ type: 'interrupt' });
  say('force-sending — interrupting current work…');
}

/** Deliver one force-sent item as its own turn, right now (not batched). */
function deliverForced(item) {
  const elapsed = fmtElapsed(Date.now() - item.composedAt);
  const text = `[Force-sent ${elapsed} after being queued — in-flight work was interrupted to deliver this immediately.]\n${item.text.trim()}`;
  // BUG-129: forceSend already pulled this row OUT of state.queue, so from here
  // to turn-end the outbox is its only record (same window as flushQueue's).
  state.outbox = { texts: [item.text.trim()], at: Date.now() };
  youBubble(mainThread(), text);
  if (state.viewing === 'main') scrollDown();
  state.turnStartedAt = Date.now();
  state.turnStartUnknown = false; // BUG-033: this tab started this turn — the clock is real
  setBusy(true);
  if (!send({ type: 'send', prompt: text })) {
    // The socket died between the interrupt landing and this send — keep the
    // text recoverable rather than silently dropping it.
    item.dead = 'the socket dropped before the force-send could go out';
    state.queue.unshift(item);
    state.outbox = null; // back in the queue, which is itself persisted (BUG-129)
    setBusy(false);
  } else {
    say('force-sent — delivered immediately');
  }
  paintQueue();
}

/** A pending force-send whose turn will never end cleanly — put it back, marked dead. */
function cancelForceSend(why) {
  const item = state.forceSend;
  if (!item) return;
  state.forceSend = null;
  item.dead = why;
  state.queue.unshift(item);
  paintQueue();
}

/*
 * BUG-079: a session-boundary transition (openSession / startNew / a route that
 * resolves to no session) abandons the OUTGOING session. resetTranscript zeroes
 * state.queue, but two pending-delivery pointers survive it and then act on the
 * WRONG session — this clears them (and their live timers) at every boundary:
 *
 *   - drainWaitAttempt + the drain-wait self-retry interval (Finding A / LOSS):
 *     a stale attempt makes queueRetryableRefusal read `retried` truthy and DROP
 *     the incoming session's next retryable refusal instead of queuing it.
 *   - forceSend + the force-send watchdog (Finding B / WRONG-TARGET): a stale
 *     stash makes the incoming session's next turn-end deliver the OUTGOING
 *     session's text into it.
 *   - pendingStart/pendingStartResume + pendingSend (audited siblings, same
 *     class): the outgoing session's in-flight `start` text / optimistic bubble.
 *     `resumeOnNextSend`, `deliveryRelay`, and `pendingAnswers` are the other
 *     members of this class and are ALREADY cleared by closeSocket().
 *
 * Deliberately NOT called from resetTranscript()/closeSocket(): both are
 * re-entered WITHIN a single session — the BUG-045 drain-retry runs
 * attemptDrainRetry -> startTurn -> resetTranscript with drainWaitAttempt
 * already set, and the FEAT-065 relay close runs closeSocket while the drain-
 * wait loop must keep running — so clearing there would break those same-
 * session behaviors. Only the true boundary entry points call this.
 */
function clearPendingDelivery() {
  state.drainWaitAttempt = null;
  state.drainWaitLastTry = 0;
  disarmDrainWaitRetry();           // the drain-wait ghost-release self-retry interval
  state.forceSend = null;
  clearTimeout(state.busyWatchdog); // the force-send watchdog (armBusyWatchdog -> cancelForceSend)
  state.busyWatchdog = null;
  state.pendingStart = null;
  state.pendingStartResume = null;
  state.pendingStartEl = null;
  state.pendingSend = null;
  state.liveElsewhere = ''; // BUG-149: a banner about the OUTGOING session must not follow the user
}

/** The session is gone — queued rows say so and keep the text recoverable. */
function failQueue(why) {
  let changed = false;
  for (const item of state.queue) if (!item.dead) { item.dead = why; changed = true; }
  if (changed) paintQueue();
}

async function submit() {
  const p = currentProject();
  if (!p) return say('pick a project first — or add one from the sidebar foot', true);
  const text = node.prompt.value.trim();
  if (!text) return;

  // Bare /model: the CLI's interactive picker is terminal chrome the SDK
  // cannot ship, and burning a turn to print usage text helps no one — the
  // app's own model popover IS that selection UI. With an argument
  // ("/model haiku") it still travels to the CLI, which applies it.
  if (text === '/model') {
    node.prompt.value = '';
    autosize();
    node.modelBtn.click();
    return say('the model picker is this session’s /model — "/model <name>" sends straight to the CLI');
  }

  if (state.dropped) return say('the connection dropped — reconnect and resume before sending', true);
  // BUG-013: refuse at the source, before anything is painted. The composer
  // is already visually locked by paintComposerFor when this is true, so
  // reaching submit() here would only happen via a stale keyboard shortcut —
  // still worth a hard stop rather than an optimistic bubble the server will
  // reject.
  if (state.budgetLocked) return say(state.budgetLockReason || 'this session hit its budget limit and will not send further turns', true);
  const th = viewedThread();
  if (th.kind === 'agent') {
    // Structurally impossible — see paintComposerFor. Never even attempt it.
    return say('a subagent takes no messages — return to main to steer the run', true);
  }

  /*
   * FEAT-065: the open socket is only the delivered turn's approval relay —
   * it has no session, so a raw 'send' would be refused. Close it (routine,
   * on purpose) and let this message go through the ordinary start gate,
   * which re-judges the survivor (deliver again, or queue-and-wait).
   */
  if (state.deliveryRelay) closeSocket();

  if (state.live && state.ws) {
    /*
     * MID-TURN SENDS QUEUE — they do not pretend. The server refuses a send
     * while a turn runs, and the old code painted the bubble anyway: the
     * message sat in the transcript looking delivered while Claude never saw
     * it (observed in production — the user had to re-paste a lost message).
     * Now it queues like the CLI queues: visibly marked, delivered one per
     * turn boundary, and marked NOT delivered if the session dies first.
     */
    if (state.busy) {
      queueMessage(text);
      node.prompt.value = '';
      autosize();
      return;
    }
    const bubbleEl = youBubble(mainThread(), text);
    // Tracked so a rejection (budget stop raced the click — see isBudgetStop
    // in onEvent) can roll this exact bubble back instead of leaving it
    // looking delivered for a turn Claude never received.
    state.pendingSend = { el: bubbleEl, text };
    state.lastTurnPrompt = text; // BUG-031: what the provider-error Retry re-sends
    node.prompt.value = '';
    autosize();
    state.turnStartedAt = Date.now();
    state.turnStartUnknown = false; // BUG-033: this tab started this turn — the clock is real
    setBusy(true);
    send({ type: 'send', prompt: text });
    return;
  }

  // A pending fork wins: branch from the Windows-origin history instead of
  // resuming it (which this machine cannot do).
  if (state.forkFrom) {
    const from = state.forkFrom;
    const dir = state.forkEncodedDir; // BUG-090: server-supplied SOURCE dir for a needs-fork branch
    state.forkFrom = null;
    state.forkEncodedDir = null;
    return startTurn(text, { resumeSessionId: from, fork: true, resumeEncodedDir: dir ?? undefined });
  }

  // A re-armed session wins: resume the exact SDK session that dropped.
  if (state.resumeOnNextSend) {
    const resume = state.resumeOnNextSend;
    state.resumeOnNextSend = null;
    return startTurn(text, { resumeSessionId: resume });
  }
  const resume = state.current.sessionId && state.current.os !== 'windows' && !state.sdkSessionId
    ? state.current.sessionId
    : undefined;
  await startTurn(text, { resumeSessionId: resume });
}

/*
 * BUG-132: `keepComposer` — this start's text did NOT come from the composer, so
 * the composer must not be touched by it. The self-retry of a drain-wait row
 * (attemptDrainRetry, every 7s for as long as the drain is held) re-sends text
 * that lives in the QUEUE; clearing the box here — and, on the refusal that
 * follows, writing the queued row's text back INTO it — destroyed whatever the
 * user was typing, on a 7s cadence, for the whole life of the hold. Observed
 * live: a 46-minute hold made the composer unusable ("it reloads deleting my
 * entered message"). The flag rides on state so the refusal path (which runs
 * later, from the socket) can honour it without re-deriving who started the turn.
 */
async function startTurn(text, { resumeSessionId, fork, resumeEncodedDir, keepComposer } = {}) {
  const p = currentProject();
  if (!p) return;
  // BUG-149: a fresh attempt is under way — the previous "another tab has it"
  // banner is about to be re-answered by the server either way, so it must not
  // linger and describe a refusal that may no longer be true.
  state.liveElsewhere = '';
  if (!resumeSessionId) {
    // Guard the one path that can destroy visible history: starting fresh
    // while an SDK session is already represented on screen. That has to be
    // an explicit act (the pencil / + button), never a side effect of Enter.
    if (state.sdkSessionId && mainThread().paneEl.childElementCount > 0) {
      return say('this session is no longer attached — use Reconnect, or start a new session with + in the sidebar', true);
    }
    resetTranscript();
    // BUG-129: resetTranscript dropped ownership of the stored rows (it cannot
    // tell a boundary from a fresh start). This IS the session those rows were
    // typed under, so take it straight back — otherwise nothing queued in this
    // new session would be persisted at all.
    adoptQueue();
    state.current.title = titleFrom(text);
  }
  /*
   * BUG-149: keep the ELEMENT, not just the intention to find it again. The
   * rollback paths locate this bubble as "the last top-level `.you` in main",
   * which is only true while nothing else appends — and the transcript follower
   * does append, asynchronously, whatever the session's real driver writes. In
   * a two-tab run that race showed up twice over: the refused bubble survived
   * (still claiming a delivery that never happened) and the OTHER tab's real,
   * delivered message was the one removed. Both are the transcript lying, which
   * is the failure this whole area exists to prevent.
   */
  const startedBubble = youBubble(mainThread(), text);
  if (!keepComposer) { node.prompt.value = ''; autosize(); }
  node.box.hidden = false;
  node.frozen.hidden = true;
  node.agentDone.hidden = true;
  paintCrown();
  // A resume's connect() is exactly the "reconnecting / reattaching" window
  // FEAT-040 names — transport down, before the live stream resumes. A brand
  // new session's connect() is near-instant and never a resume, so it is not
  // labelled reconnecting (nothing to reattach to).
  if (resumeSessionId) { state.sessReconnecting = true; paintSessStatus(); }
  try {
    await connect();
  } catch (err) {
    state.sessReconnecting = false;
    paintSessStatus();
    return say(err.message, true);
  }
  state.sessReconnecting = false;
  state.turnStartedAt = Date.now();
  state.turnStartUnknown = false; // BUG-033: this tab started this turn — the clock is real
  setBusy(true);
  state.lastTurnPrompt = text; // BUG-031: what the provider-error Retry re-sends
  state.pendingStart = text; // reclaimed into the queue if this re-attaches mid-turn
  // Set in the SAME tick as pendingStart, so a non-null pendingStart always
  // means this element belongs to THAT start (see handleLiveElsewhere).
  state.pendingStartEl = startedBubble ?? null;
  state.pendingStartResume = resumeSessionId ?? null; // so a pre-turn refusal (BUG-029) can re-arm the SAME resume
  state.pendingStartKeepComposer = !!keepComposer; // BUG-132: this text is not the composer's — the rollback must not put it there
  const templateIds = drawer.startTemplateIds();
  send({
    type: 'start',
    projectId: p.id,
    prompt: text,
    resumeSessionId,
    // Without this the server falls back to a scan that refuses to guess
    // between diverged copies of the same session id — which is exactly the
    // case for a Windows-origin session on this dual-boot machine. BUG-090: a
    // needs-fork branch passes the SOURCE dir the server named explicitly (the
    // project's own encodedDir is where the id is missing).
    resumeEncodedDir: resumeSessionId ? (resumeEncodedDir ?? state.current.encodedDir ?? undefined) : undefined,
    fork,
    templateIds,
    overrides: sessionOverrides(),
  });
  renderTree();
}

/** The session-scope overrides that are legal to send with `start`. */
function sessionOverrides() {
  const out = {};
  for (const field of SESSION_OVERRIDABLE) {
    if (field in state.overrides) out[field] = state.overrides[field];
  }
  return Object.keys(out).length ? out : undefined;
}

/** Provisional session title until the store writes a real ai-title. */
function titleFrom(text) {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= 64) return one;
  const cut = one.slice(0, 64);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > 32 ? cut.slice(0, sp) : cut).replace(/[,.;:—-]$/, '')}…`;
}

function autosize() {
  node.prompt.style.height = 'auto';
  node.prompt.style.height = `${Math.min(node.prompt.scrollHeight, 170)}px`;
}

node.prompt.addEventListener('input', autosize);

/* -------------------------------------------------- "/" command palette */
/*
 * Typing "/" offers the commands the session's CLI listed in its init
 * message (session-init.slashCommands). Between sessions the last-seen list
 * serves as the hint — commands are near-global, and a hint beats nothing.
 * Picking only fills the composer; the command still travels as an ordinary
 * prompt, which the CLI executes itself (verified: "/model" answers with
 * its usage text).
 */

const SLASH_KEY = 'cs-slash';
const slash = { open: false, items: [], sel: 0 };
try { state.slashCommands = JSON.parse(localStorage.getItem(SLASH_KEY) ?? '[]'); } catch { state.slashCommands = []; }

function slashPopEl() { return $('#slashPop'); }

function updateSlashPop() {
  const v = node.prompt.value;
  const m = /^\/([A-Za-z0-9:_-]*)$/.exec(v); // only while typing the command word
  const cmds = state.slashCommands ?? [];
  if (!m || !cmds.length) return hideSlashPop();
  const q = m[1].toLowerCase();
  const items = cmds.filter((c) => c.toLowerCase().startsWith(q)).slice(0, 12);
  if (!items.length) return hideSlashPop();
  slash.open = true;
  slash.items = items;
  slash.sel = Math.min(slash.sel, items.length - 1);
  const pop = slashPopEl();
  clear(pop);
  items.forEach((c, i) => {
    const b = el('button', { class: `sl${i === slash.sel ? ' on' : ''}`, text: `/${c}` });
    b.addEventListener('mousedown', (e) => { e.preventDefault(); pickSlash(c); });
    pop.append(b);
  });
  pop.hidden = false;
}

function hideSlashPop() {
  slash.open = false;
  slashPopEl().hidden = true;
}

function pickSlash(c) {
  node.prompt.value = `/${c} `;
  hideSlashPop();
  node.prompt.focus();
  autosize();
}

node.prompt.addEventListener('input', updateSlashPop);
node.prompt.addEventListener('blur', () => setTimeout(hideSlashPop, 120));

node.prompt.addEventListener('keydown', (e) => {
  if (slash.open) {
    if (e.key === 'ArrowDown') { e.preventDefault(); slash.sel = (slash.sel + 1) % slash.items.length; return updateSlashPop(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); slash.sel = (slash.sel - 1 + slash.items.length) % slash.items.length; return updateSlashPop(); }
    if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); return pickSlash(slash.items[slash.sel]); }
    if (e.key === 'Escape') { e.preventDefault(); return hideSlashPop(); }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); }
});
node.go.addEventListener('click', () => {
  /*
   * BUG-153: the refusal belongs to the STOP half of this button only. It used
   * to be the first line, tested on `followingLive && !state.live`, so a
   * detached run that was NOT busy refused to send the message it was in the
   * same breath asking for — the button read "Send", the click answered "send
   * a message to reattach". Now: interrupting needs a socket to interrupt
   * over (the same predicate the chip and force-send read); sending never did,
   * because sending is what creates one.
   */
  if (state.busy) {
    if (!isDriving()) {
      return say('this run is detached — send a message to reattach, then you can steer or interrupt it', true);
    }
    send({ type: 'interrupt' });
    say('interrupting…');
    return;
  }
  void submit();
});
$('#forkBtn').addEventListener('click', () => {
  // BUG-090: a needs-fork signal wins — fork from the SOURCE store dir the
  // server named (the target dir this project resolves to is exactly where the
  // id is missing), not the client-detected Windows path.
  const pf = state.pendingFork;
  const sid = pf ? pf.resumeSessionId : state.current.sessionId;
  if (!sid) return;
  state.forkFrom = sid;
  if (pf) {
    state.forkEncodedDir = pf.resumeEncodedDir;
    state.pendingFork = null;
  } else {
    state.current.os = 'linux';
  }
  node.box.hidden = false;
  node.frozen.hidden = true;
  node.prompt.focus();
  say(pf && pf.cause === 'isolation-changed'
    ? 'Forking into the container — type the first message and send; it branches this history into a new session in the container. The original stays on the host.'
    : pf && pf.cause === 'path-changed'
      ? 'Forking — type the first message and send; it branches this history into a new session under the project’s current directory. The original stays untouched.'
      : 'Forking — type the first message and send; it branches from this history into a new session on this machine. The original stays untouched.');
});

node.planBtn.addEventListener('click', togglePlan);
node.skipBtn.addEventListener('click', toggleSkip);
$('#cogBtn').addEventListener('click', () => void drawer.open('settings'));

/* ------------------------------------------------------- model picker */
/*
 * `#modelBtn` used to be wired to `drawer.open('settings')` — byte-identical to
 * `#cogBtn` beside it — while its tooltip promised "Choose a model". It now
 * actually chooses one.
 *
 * Everything here is a SESSION override, like the skip/plan toggles: the common
 * case is "just this once, use a bigger model", and that must not rewrite the
 * project default. The project default is one click away in the drawer.
 */
/*
 * The fallback list exists only for a server that has never seen a session:
 * it cannot name VERSIONS truthfully, so it does not try. The real list —
 * the CLI's own display names and descriptions, versions included — replaces
 * it via /api/models (see boot), exactly like the slash-command list.
 */
/*
 * The null row's `d` here is a LAST-RESORT fallback only: paintModelPop
 * overwrites it at render time with the concrete model inheriting actually
 * resolves to (BUG-021 — see resolveInheritedModelLabel). It only ever
 * surfaces when that resolution comes up empty: no project default set AND no
 * session has run yet to report what the CLI picked.
 */
let MODEL_OPTS = [
  { v: null, n: 'Project default', d: 'Not decided yet — resolves once a session runs' },
  { v: 'opus', n: 'Opus', d: 'Deepest reasoning, slowest, priciest' },
  { v: 'sonnet', n: 'Sonnet', d: 'The balanced default for most work' },
  { v: 'haiku', n: 'Haiku', d: 'Fastest and cheapest; fine for small edits' },
];

function adoptModelList(models) {
  if (!Array.isArray(models) || !models.length) return;
  MODEL_OPTS = [
    { v: null, n: 'Project default', d: 'Not decided yet — resolves once a session runs' },
    ...models.map((m) => ({ v: m.value, n: m.displayName || m.value, d: m.description || '', r: m.resolvedModel || null })),
  ];
}

/* ------------------------------------- provider at launch (FEAT-045) */
/*
 * Which ENGINE the picker (and the crown chip) should speak for: the live
 * session's resolved provider wins, then an armed per-launch override, then
 * the project setting. Same resolution paintModelChip used inline pre-045.
 */
function providerView() {
  // BUG-106 — a foreign dock's live provider is not about the selected project;
  // dockEffective() blanks it so the crown chip / integrations / launch control
  // fall back to the selected project's own provider rather than A's live engine.
  return dockEffective()?.provider
    ?? ('provider' in state.overrides ? state.overrides.provider : null)
    ?? currentProject()?.settings?.provider ?? 'anthropic';
}

/*
 * The Codex catalog is a SEPARATE list, never merged into MODEL_OPTS: the
 * engines' catalogs must not poison each other (the pre-045 server kept ONE
 * global list, so a codex session's model/list overwrote the Claude rows).
 * null = never fetched; fetched lazily the first time an OpenAI view needs
 * it, and refreshed on every picker open (the server relearns it from each
 * codex session's own model/list).
 */
let CODEX_MODEL_OPTS = null;

function adoptCodexModelList(models) {
  if (!Array.isArray(models) || !models.length) return;
  CODEX_MODEL_OPTS = [
    { v: null, n: 'Project default', d: 'Not decided yet — resolves once a session runs' },
    ...models.map((m) => ({ v: m.value, n: m.displayName || m.value, d: m.description || '', r: m.resolvedModel || null })),
  ];
}

/** The catalog for the CURRENT provider view. Anthropic = MODEL_OPTS, byte-identical to pre-045. */
function activeModelOpts() {
  if (providerView() !== 'openai') return MODEL_OPTS;
  return CODEX_MODEL_OPTS ?? [MODEL_OPTS.find((o) => o.v == null) ?? { v: null, n: 'Project default', d: '' }];
}

let codexModelsInflight = null;
let codexModelsFetchedOnce = false; // ambient repaints probe once; a picker OPEN always re-asks
let codexModelsJson = null; // repaint only on CHANGE — paintModelPop itself refetches, so an unconditional repaint would loop
function refreshCodexModels(opts = {}) {
  if (codexModelsInflight) return codexModelsInflight;
  if (codexModelsFetchedOnce && !opts.force) return Promise.resolve();
  codexModelsInflight = api.models('openai').then((models) => {
    codexModelsInflight = null;
    codexModelsFetchedOnce = true;
    if (!Array.isArray(models) || !models.length) return;
    const j = JSON.stringify(models);
    if (j === codexModelsJson) return;
    codexModelsJson = j;
    adoptCodexModelList(models);
    if (node.modelPop.classList.contains('open')) paintModelPop();
    paintModelBtn();
    paintModelChip();
  }).catch(() => { codexModelsInflight = null; });
  return codexModelsInflight;
}

/*
 * The launch-surface provider control. Everything it sets is the per-launch
 * override the server has validated since FEAT-037 P3 (`overrides.provider`)
 * — never a registry write; the project default is one click away in the
 * drawer. The popover mirrors the drawer's honesty: the OpenAI row carries
 * the LIVE detectCodex() verdict from /api/providers, and picking OpenAI
 * while not connected is allowed but warns with the actionable hint (the
 * launch then fails fast with the same hint — agent-bridge P3).
 */
const PROVIDER_OPTS = [
  { v: 'anthropic', n: 'Claude', d: 'Anthropic — the default engine' },
  { v: 'openai', n: 'OpenAI Codex', d: 'Bills to your ChatGPT subscription' },
];

let provVerdicts; // undefined = unfetched, null = route absent
let provVerdictsInflight = null;
function refreshProvVerdicts() {
  if (provVerdictsInflight) return provVerdictsInflight;
  provVerdictsInflight = api.providers().then((p) => {
    provVerdictsInflight = null;
    provVerdicts = p; // null when the route is absent
    if (node.provPop.classList.contains('open')) paintProvPop();
    paintProvBtn();
  }).catch(() => { provVerdictsInflight = null; });
  return provVerdictsInflight;
}

function paintProvBtn() {
  // Hidden while a session is LIVE: the engine cannot change mid-session
  // (the FEAT-042 crown chip names the running engine); this control is for
  // the launch surface, where overrides are armed pre-start.
  const show = !!currentProject() && !dockLive(); // BUG-106 — A's live session must not hide B's launch control
  node.provBtn.hidden = !show;
  if (!show) return;
  const cur = providerView();
  const opt = PROVIDER_OPTS.find((o) => o.v === cur);
  node.provBtn.dataset.provider = cur;
  node.provBtn.dataset.set = String('provider' in state.overrides);
  const inherited = 'provider' in state.overrides ? ' (this session only)' : ' (project default)';
  node.provBtn.title = `Provider: ${opt?.n ?? cur}${inherited} — applies when the next session starts. Click to change`;
}

function openaiVerdict() {
  return provVerdicts?.openai ?? null;
}

function paintProvPop() {
  clear(node.provOpts);
  const cur = providerView();
  for (const o of PROVIDER_OPTS) {
    const isCur = o.v === cur;
    const b = el('button', { class: 'opt', role: 'menuitem', 'aria-pressed': String(isCur) });
    b.append(el('span', { class: 'g', text: isCur ? '●' : '○' }));
    const mid = el('span');
    mid.append(el('span', { class: 'n', text: o.n }));
    if (o.d) mid.append(el('span', { class: 'd', text: o.d }));
    if (isCur && !('provider' in state.overrides)) mid.append(el('span', { class: 'tag', text: 'project default' }));
    b.append(mid);
    b.addEventListener('click', () => pickProvider(o.v));
    node.provOpts.append(b);
  }
  // The live detection verdict, in the drawer's own voice (.prov-state).
  const oai = openaiVerdict();
  if (provVerdicts === undefined) {
    node.provOpts.append(el('div', { class: 'prov-state', 'data-status': 'unknown' },
      el('span', { class: 'dot' }), document.createTextNode('OpenAI Codex — checking availability…')));
  } else if (provVerdicts === null) {
    node.provOpts.append(el('div', { class: 'prov-state', 'data-status': 'unknown' },
      el('span', { class: 'dot' }), document.createTextNode('OpenAI Codex — state unknown (no /api/providers route)')));
  } else {
    node.provOpts.append(el('div', { class: 'prov-state', 'data-status': oai?.status ?? 'unknown' },
      el('span', { class: 'dot' }), document.createTextNode(oai?.label ?? 'OpenAI Codex — state unknown')));
    if (oai && oai.status !== 'connected' && oai.hint) {
      node.provOpts.append(el('div', { class: 'grp-note', text: oai.hint }));
    }
    if (cur === 'openai' && oai && oai.status !== 'connected') {
      const warn = el('div', { class: 'grp-note', text: 'Selected, but not connected — launching will fail with the hint above until Codex is usable (docs/PROVIDERS.md).' });
      warn.dataset.warn = 'true';
      node.provOpts.append(warn);
    }
  }
}

function pickProvider(next) {
  // BUG-106 — dockLive(): a foreign dock's live session belongs to another project;
  // the selected project's launch provider is still freely armable (its provBtn is
  // shown for the same reason). Only a live session IN VIEW fixes the engine.
  if (dockLive()) return say('the engine is fixed for a running session — start a new session to switch', true);
  const before = providerView();
  const projectDefault = currentProject()?.settings?.provider ?? 'anthropic';
  // Picking the project's own default is "no override" — clear rather than
  // storing an override equal to the default (same rule as the drawer).
  if (next === projectDefault) delete state.overrides.provider;
  else state.overrides.provider = next;
  // A model/effort armed for the OTHER engine's catalog would ride the start
  // payload into an engine that cannot honour it — drop them loudly, never
  // silently carry them across.
  let dropped = '';
  if (before !== next && ('model' in state.overrides || 'effort' in state.overrides)) {
    delete state.overrides.model;
    delete state.overrides.effort;
    dropped = ' · the armed model/effort override was cleared (it named the other engine’s catalog — repick from /model)';
  }
  persistOverrides();
  const opt = PROVIDER_OPTS.find((o) => o.v === next);
  const oai = openaiVerdict();
  if (next === 'openai' && provVerdicts && oai && oai.status !== 'connected') {
    say(`provider: ${opt?.n ?? next} — armed, but Codex is ${oai.status === 'not-installed' ? 'not installed' : 'not signed in'}: launching will fail until it is usable. ${oai.hint ?? 'See docs/PROVIDERS.md.'}${dropped}`, true);
  } else {
    say(`provider: ${opt?.n ?? next} — applies when the next session starts${dropped}`);
  }
  paintProvBtn();
  paintProvPop();
  paintModelBtn();
  paintModelChip();
  drawer.repaintLive?.();
}

node.provBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (node.provPop.classList.contains('open')) return closePops();
  closePops();
  void refreshProvVerdicts(); // live truth on every open, like the drawer
  paintProvPop();
  place(node.provPop, node.provBtn, 292);
  node.provPop.classList.add('open');
  node.provBtn.setAttribute('aria-expanded', 'true');
});
$('#provPopSettings').addEventListener('click', () => { closePops(); void drawer.open('settings'); });

/*
 * Matching the picker's current row against the effective model is not a
 * straight string compare: after `session-init` the server reports the
 * CLI's full wire id (e.g. 'claude-haiku-4-5-20251001'), which never equals
 * an alias row's `v` (e.g. 'haiku'). Each row also carries `r` —
 * `resolvedModel`, the wire id that alias covers — so a row is "current"
 * when the effective value matches EITHER its own value OR its resolved id.
 * Compared case-insensitively and with a trailing '[1m]' stripped, since the
 * 1M-context variants of a model share the same underlying wire id.
 */
function normModelId(s) {
  return String(s ?? '').replace(/\[1m\]$/i, '').toLowerCase();
}

function resolveCurrentModelOpt(opts, current) {
  if (current == null) return opts.find((o) => o.v == null) ?? null;
  const cur = normModelId(current);
  return opts.find((o) => o.v != null && normModelId(o.v) === cur)
    ?? opts.find((o) => o.r && normModelId(o.r) === cur)
    ?? null;
}

/*
 * BUG-021: what model results when THIS session carries no 'model' override —
 * i.e. what "Project default" actually resolves to, named concretely instead
 * of left as the opaque phrase. Never guesses: the project's own configured
 * default (registry `settings.model`) is authoritative when set; failing
 * that, only a session that has ACTUALLY RUN with no override tells the
 * truth, via the live wire id `session-init` reported (folded into
 * state.effective there). Returns null when nothing has told us yet, so
 * callers fall back to honest "not decided yet" copy rather than fabricate a
 * model name.
 */
function resolveInheritedModelLabel() {
  const projectDefault = currentProject()?.settings?.model ?? null;
  if (projectDefault != null) {
    const opt = resolveCurrentModelOpt(activeModelOpts(), projectDefault);
    return opt?.v != null ? opt.n : String(projectDefault);
  }
  // No project default either — only a session that has actually run tells
  // the truth, via the live wire id session-init reported. But NOT if the
  // live session's own effective-config says 'model' was itself overridden
  // (state.effective.overridden) — then the live value is that override's
  // resolution, not the inherited default's, and claiming otherwise would be
  // a lie. A freshly-armed, not-yet-applied client override (state.overrides)
  // does not disqualify it: it only takes effect on the NEXT session (see the
  // popover's own "applies to the NEXT session" messaging), so the CURRENT
  // live session's effective model is still the true default's resolution.
  const eff = dockEffective(); // BUG-106 — a foreign dock's live model is not the selected project's inherited default
  if (eff?.overridden?.includes('model')) return null;
  const raw = eff?.effective?.model ?? null;
  if (raw == null) return null;
  const opt = resolveCurrentModelOpt(activeModelOpts(), raw);
  return opt?.v != null ? opt.n : String(raw);
}
const EFFORT_OPTS = [
  { v: null, n: 'Project default' },
  { v: 'low', n: 'low' }, { v: 'medium', n: 'medium' }, { v: 'high', n: 'high' },
  { v: 'xhigh', n: 'xhigh' }, { v: 'max', n: 'max' },
];

/**
 * What the session is REALLY running with. Once live, the server's
 * effective-config wins over anything the UI believes it requested — same rule
 * the permission chip follows.
 */
function effectiveModel(field) {
  const eff = dockEffective(); // BUG-106 — foreign dock ⟹ the selected project's launch value, not A's live effective
  if (eff?.effective && field in eff.effective) return { value: eff.effective[field], live: true };
  if (field in state.overrides) return { value: state.overrides[field], live: false };
  return { value: currentProject()?.settings?.[field] ?? null, live: false };
}

function paintModelBtn() {
  const has = !!currentProject();
  node.modelBtn.hidden = !has;
  if (!has) return;
  const m = effectiveModel('model');
  const e = effectiveModel('effort');
  const overridden = 'model' in state.overrides;
  // BUG-021: name the concrete model, not the vague "project default" phrase,
  // whenever it can be resolved — see resolveInheritedModelLabel.
  let name;
  if (m.value) {
    const opt = resolveCurrentModelOpt(activeModelOpts(), m.value);
    name = opt?.v != null ? opt.n : String(m.value);
  } else {
    name = resolveInheritedModelLabel() ?? 'project default';
  }
  const inherited = !overridden ? ' (project default)' : '';
  node.modelBtn.dataset.set = String('model' in state.overrides || 'effort' in state.overrides);
  node.modelBtn.title = `Model: ${name}${inherited}${e.value ? ` · effort ${e.value}` : ''}${m.live ? ' (from the running session)' : ' (applies on next launch)'} — click to change for this session`;
  // FEAT-045: the provider control lives beside this button and repaints on
  // exactly the same beats (project switch, launch, override churn).
  paintProvBtn();
}

/* ------------------------------------------- live model chip (FEAT-042) */
/*
 * The provider can switch the model WITHOUT user action (safeguard refusal
 * fallbacks, downgrades) — and until now the only place the model showed at
 * all was inside the /model picker. The chip makes the LIVE resolved model
 * permanently visible in the crown, and flags any change the user did not
 * initiate (pulse + a transcript "model changed: X → Y" line).
 *
 * Detection boundary, stated honestly: the ONE dedicated push signal the SDK
 * has is `model_refusal_fallback` (surfaced as `model-changed`); every other
 * provider-side switch is only observable per-turn, via the wire id stamped on
 * each main-thread assistant message (surfaced as `model-observed`, deduped).
 * So a silent switch becomes visible the moment the new model first SPEAKS —
 * never earlier, and a turn that produces no main-thread assistant message
 * cannot reveal one. Subagent messages are excluded on the server: subagents
 * legitimately run different models.
 */

/** Compact display form: a known picker row's name, else the wire id minus its ceremony. */
function shortModelName(id) {
  if (id == null) return 'default';
  const opt = resolveCurrentModelOpt(activeModelOpts(), id);
  if (opt?.v != null) return opt.n;
  return String(id).replace(/^claude-/i, '').replace(/-\d{8}$/, '');
}

/*
 * "Is this the same model?" across the three spellings in play: a picker alias
 * ('sonnet'), a canonical id ('claude-sonnet-5'), and a dated wire id
 * ('claude-sonnet-5-20250929'). A false "different" here would flag the user's
 * OWN confirmed switch as a silent provider change — the one false alarm this
 * feature must never raise — so alias⊂wire containment is accepted when no
 * picker row joins them.
 */
function sameModel(a, b) {
  if (a == null || b == null) return a == null && b == null;
  const na = normModelId(a);
  const nb = normModelId(b);
  if (na === nb) return true;
  const ra = resolveCurrentModelOpt(activeModelOpts(), a);
  const rb = resolveCurrentModelOpt(activeModelOpts(), b);
  if (ra && rb) return ra === rb;
  return na.includes(nb) || nb.includes(na);
}

function paintModelChip() {
  if (!node.modelChip) return;
  const has = !!currentProject();
  node.modelChip.hidden = !has;
  if (!has) return;
  // The running session's own report wins; the effective config is next; the
  // resolved inherited default covers the pre-launch view. Never fabricates.
  const eff = dockLiveModel() ?? effectiveModel('model').value ?? null; // BUG-106 — foreign dock ⟹ no live model
  /*
   * FEAT-037 P3 — the crown names the ENGINE too, not just the model. Live
   * session: the server's resolved provider (effective-config/ack). Pre-launch:
   * an armed session override, else the project setting. Anthropic — the
   * default — stays UNMARKED, exactly the pre-P3 render; a non-default engine
   * gets a quiet lowercase prefix in the same greyscale chip.
   */
  const provider = providerView(); // FEAT-045: same resolution, now shared with the launch control
  // FEAT-045: name codex models by the engine's own displayName once known
  // (one lazy probe; a picker open re-asks the server regardless).
  if (provider === 'openai' && CODEX_MODEL_OPTS == null) void refreshCodexModels();
  node.modelChip.dataset.provider = provider;
  const provMark = provider === 'openai' ? 'codex · ' : '';
  node.modelChipName.textContent = provMark + (eff != null ? shortModelName(eff) : (resolveInheritedModelLabel() ?? '—'));
  node.modelChip.dataset.live = String(!!(dockLive() && eff != null)); // BUG-106
  const src = dockLiveModel()
    ? ' (reported by the running session)'
    : dockLive() ? ' (effective config)' : ' (resolves at launch)';
  node.modelChip.title = `Provider: ${provider === 'openai' ? 'OpenAI Codex' : 'Claude (Anthropic)'} · Model: ${eff != null ? String(eff) : 'not resolved yet'}${src} — click to change`;
}

/**
 * A model change the user did NOT initiate: transcript system line + status
 * line + a pulse on the chip. The tinted flag STAYS until the chip is clicked,
 * so the change is catchable even when the pulse itself was missed — that is
 * the entire point of this feature.
 */
/*
 * BUG-081: a provider-side model switch is HIGH signal — the model answering you
 * silently changed, and why — but it used to render as a plain body-coloured line
 * that blended into the conversation. Build it as a distinct centred hairline
 * chip with an amber accent (--st-needs): a fallback/degradation reads as
 * "needs-you" per FEAT-066's restrained palette, and the pill is unmistakably
 * station chrome — not a chat bubble, not prose. `from → to` stays inline; the
 * reason rides alongside when short, collapses to "fallback" when long, and the
 * FULL line is always the chip's `title` so the complete detail is one hover away.
 * This is a LIVE-only marker (there is no persisted transcript block to replay),
 * so the one render site below covers every path that reaches it.
 */
function modelChangeMark(from, to, why) {
  const line = `model changed: ${shortModelName(from)} → ${shortModelName(to)}${why ? ` (${why})` : ''}`;
  const wrap = el('div', { class: 'ran-lbl model-change' });
  const chip = el('span', { class: 'mc-chip', title: line });
  chip.append(el('span', { class: 'mc-ico', 'aria-hidden': 'true', text: '◇' }));
  chip.append(el('span', { class: 'mc-txt', text: `model changed: ${shortModelName(from)} → ${shortModelName(to)}` }));
  if (why) chip.append(el('span', { class: 'mc-why', text: why.length <= 34 ? why : 'fallback' }));
  wrap.append(chip);
  return wrap;
}

function flagModelChange(from, to, why) {
  const line = `model changed: ${shortModelName(from)} → ${shortModelName(to)}${why ? ` (${why})` : ''}`;
  claudeBody(mainThread()).append(modelChangeMark(from, to, why));
  if (state.viewing === 'main') scrollDown();
  say(line, true);
  if (node.modelChip) {
    node.modelChip.dataset.flag = 'true';
    // Restart the pulse when a second change lands while already flagged.
    node.modelChip.style.animation = 'none';
    void node.modelChip.offsetWidth;
    node.modelChip.style.animation = '';
  }
}

function clearModelFlag() {
  if (node.modelChip) delete node.modelChip.dataset.flag;
}

function paintModelPop() {
  /*
   * FEAT-045: the catalog follows the PROVIDER view. An OpenAI session (live
   * or armed) lists the real Codex catalog — the engine's own model/list,
   * remembered per provider by the server — never the static Claude aliases.
   * The Claude path reads MODEL_OPTS through activeModelOpts() unchanged.
   */
  const POPTS = activeModelOpts();
  if (providerView() === 'openai') void refreshCodexModels({ force: true });
  const cur = effectiveModel('model').value ?? null;
  const curE = effectiveModel('effort').value ?? null;
  /*
   * BUG-021 (part 2): a value match is tried first (unchanged — it correctly
   * lights up e.g. the "Opus" row when the project default names 'opus'
   * directly). Only when NOTHING matches AND this session carries no
   * override do we fall back to the null "Project default" row: a live,
   * inherited session reports a real CLI wire id via session-init that this
   * browser's MODEL_OPTS may not carry a matching alias/`r` for (e.g. an
   * unseen version) — without this fallback NO row would light up at all,
   * even though the field is plainly inherited, not overridden.
   */
  const curModelOpt = resolveCurrentModelOpt(POPTS, cur)
    ?? (('model' in state.overrides) ? null : (POPTS.find((o) => o.v == null) ?? null));
  const fill = (host, opts, current, field, currentOpt) => {
    clear(host);
    for (const o of opts) {
      const isCur = currentOpt !== undefined ? o === currentOpt : o.v === current;
      const b = el('button', { class: 'opt', role: 'menuitem', 'aria-pressed': String(isCur) });
      b.append(el('span', { class: 'g', text: isCur ? '●' : '○' }));
      const mid = el('span');
      mid.append(el('span', { class: 'n', text: o.n }));
      // BUG-021: the "Project default" row's description used to be a static
      // placeholder describing the BEHAVIOUR ("whatever the project is set
      // to"), never the model it actually resolves to. Show the concrete name
      // whenever it can be resolved (see resolveInheritedModelLabel) — for
      // both the currently-inherited row (the readout) and the idle option
      // (so picking it back shows what you'd get). The static `d` on MODEL_OPTS
      // remains only as the honest last-resort fallback (never resolvable yet).
      const resolvedInherited = (field === 'model' && o.v === null) ? resolveInheritedModelLabel() : null;
      const d = resolvedInherited ?? o.d;
      if (d) mid.append(el('span', { class: 'd', text: d }));
      if (resolvedInherited && isCur) mid.append(el('span', { class: 'tag', text: 'inherited' }));
      b.append(mid);
      b.addEventListener('click', () => {
        // BUG-026: the MODEL on a RUNNING session goes through the server's live
        // setModel (like permission mode) — arming a client override does not
        // switch the session and reverts on reopen, because effectiveModel()
        // rightly lets the live value win. effort (no live SDK setter) and any
        // pre-start change stay an arm-for-next-session override.
        if (field === 'model' && dockLive()) return setModelLive(o.v); // BUG-106 — only a live session IN VIEW takes a live model change
        // null = "inherit": drop the override rather than storing a null.
        if (o.v === null) delete state.overrides[field];
        else state.overrides[field] = o.v;
        persistOverrides();
        const live = dockEffective()?.effective;
        say(live
          ? `${field}: ${o.v ?? 'project default'} — applies to the NEXT session; the one running keeps ${live[field] ?? 'its current value'}`
          : `${field}: ${o.v ?? 'project default'} for this session`);
        paintModelBtn();
        paintModelPop();
        paintCrown();
        drawer.repaintLive?.();
      });
      host.append(b);
    }
  };
  fill(node.modelOpts, POPTS, cur, 'model', curModelOpt);
  // FEAT-045: an OpenAI view whose catalog has not been learned yet shows the
  // honest gap — the codex engine reports its own catalog per session.
  if (providerView() === 'openai' && CODEX_MODEL_OPTS == null) {
    node.modelOpts.append(el('div', {
      class: 'grp-note',
      text: 'The Codex catalog is reported by the engine itself — it fills in when a Codex session runs.',
    }));
  }
  fill(node.effortOpts, EFFORT_OPTS, curE, 'effort');
}

node.modelBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (node.modelPop.classList.contains('open')) return closePops();
  closePops();
  paintModelPop();
  place(node.modelPop, node.modelBtn, 292);
  node.modelPop.classList.add('open');
  node.modelBtn.setAttribute('aria-expanded', 'true');
});
$('#modelPopSettings').addEventListener('click', () => { closePops(); void drawer.open('settings'); });

// FEAT-042: the crown chip opens the SAME picker (no new surface), anchored at
// the chip itself. Clicking also acknowledges a flagged silent change.
node.modelChip.addEventListener('click', (e) => {
  e.stopPropagation();
  clearModelFlag();
  paintModelChip();
  if (node.modelPop.classList.contains('open')) return closePops();
  closePops();
  paintModelPop();
  place(node.modelPop, node.modelChip, 292);
  node.modelPop.classList.add('open');
  node.modelBtn.setAttribute('aria-expanded', 'true');
});

async function reloadProject(id) {
  const fresh = await api.getProject(id);
  const i = state.projects.findIndex((x) => x.id === id);
  if (i >= 0) state.projects[i] = fresh;
  drawer.repaint();
  paintCrown();
}

/* ------------------------------------------------------------- popovers */

function place(popEl, anchor, width) {
  const r = anchor.getBoundingClientRect();
  popEl.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - width - 12))}px`;
  const top = r.bottom + 6;
  popEl.style.top = `${Math.min(top, window.innerHeight - 80)}px`;
  if (r.top > window.innerHeight / 2) {
    popEl.style.top = '';
    popEl.style.bottom = `${window.innerHeight - r.top + 6}px`;
  } else popEl.style.bottom = '';
}

/* ---- per-project overflow (FEAT-038: onboard to Orchard) ---- */
/*
 * Built in JS (not index.html) so it stays entirely within app.js. Reuses the
 * shared `.pop.rowmenu`/`.mi` chrome so it looks native and is positioned by the
 * same `placeAt` the session row menu uses.
 */
const projMenu = el('div', { class: 'pop rowmenu', id: 'projMenu', role: 'menu', 'aria-label': 'Project actions' });
document.body.append(projMenu);

function openProjectMenu(p, x, y) {
  closePops();
  clear(projMenu);
  const onboard = el('button', { class: 'mi', role: 'menuitem', 'aria-label': `Onboard ${p.name} to Orchard` },
    el('span', { class: 'l', text: 'Onboard to Orchard' }));
  onboard.addEventListener('click', (e) => { e.stopPropagation(); closePops(); void onboardProject(p); });
  projMenu.append(onboard);
  projMenu.classList.add('open');
  placeAt(projMenu, x, y);
  onboard.focus();
}

/*
 * One click = the same idempotent onboarding the CLI runs (POST .../onboard →
 * scripts/onboard.mjs's core). Feedback is honest: a first run reports how many
 * artifacts were created; a re-run reports "already onboarded" rather than
 * pretending it did work; a bad target (hostPath gone) surfaces the server's
 * 400 message instead of a silent success. After onboarding, the project has a
 * board, so refresh the Needs-You rail for it.
 */
async function onboardProject(p) {
  say(`onboarding ${p.name} to Orchard…`);
  try {
    const r = await api.api(`/api/projects/${encodeURIComponent(p.id)}/onboard`, { method: 'POST', body: '{}' });
    // If this is the open project, its (now-scaffolded) board should light up
    // the Needs-You rail. refreshRail repaints WITHOUT touching the status line,
    // so the success message below stays the last word (selectProject's own
    // isolation blurb would otherwise clobber it).
    if (state.current.projectId === p.id) await refreshRail(true);
    if (r.alreadyOnboarded) {
      say(`${p.name} is already onboarded to Orchard — nothing to do`);
    } else {
      say(`onboarded ${p.name} to Orchard · ${r.createdCount} artifact${r.createdCount === 1 ? '' : 's'} created`);
    }
  } catch (err) {
    say(`could not onboard ${p.name}: ${err.message}`, true);
  }
}

function closePops() {
  closeRowMenu();
  node.pop.classList.remove('open');
  node.picker.classList.remove('open');
  node.modelPop.classList.remove('open');
  node.provPop.classList.remove('open');
  node.procPop.classList.remove('open');
  projMenu.classList.remove('open');
  $('#treeMenu').classList.remove('open');
  node.isoBtn.setAttribute('aria-expanded', 'false');
  node.modelBtn.setAttribute('aria-expanded', 'false');
  node.provBtn.setAttribute('aria-expanded', 'false');
  node.procBtn.setAttribute('aria-expanded', 'false');
}

node.isoBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (node.pop.classList.contains('open')) return closePops();
  closePops();
  place(node.pop, node.isoBtn, 292);
  node.pop.classList.add('open');
  node.isoBtn.setAttribute('aria-expanded', 'true');
});
node.pop.addEventListener('click', async (e) => {
  const opt = e.target.closest('.opt');
  if (!opt) return;
  closePops();
  const p = currentProject();
  if (!p) return;
  try {
    await api.patchProject(p.id, { isolation: opt.dataset.iso });
    await reloadProject(p.id);
  } catch (err) { say(err.message, true); }
});
// FEAT-054: the isolation popover's settings footer names isolation — land there.
$('#popSettings').addEventListener('click', () => { closePops(); void drawer.open('settings', { focus: 'iso' }); });
node.insBtn.addEventListener('click', () => void drawer.open('instructions', 'settings'));
$('#libBtn').addEventListener('click', () => void drawer.open('library', 'instructions'));

/* ------------------------------------------------------------ add project */

/*
 * The picker has two modes. `scan` lists likely project dirs (the fast path);
 * `browse` is a real directory walker for everything the scan roots miss —
 * typing a path from memory stays available but stops being the only escape.
 */
const pick = { mode: 'scan', path: null, hi: -1 };

function openPicker() {
  closePops();
  pick.mode = 'scan';
  node.pickFilter.value = '';
  place(node.picker, $('#addProjBtn'), 360);
  node.picker.classList.add('open');
  // FEAT-069: the filter is the primary way in — land the caret there on open
  // so the user can type-to-narrow immediately (Esc still closes via the ladder).
  node.pickFilter.focus();
  void paintPicker();
}

/* ---- FEAT-069: live filter + keyboard nav over the picker rows ----
 * Every actionable candidate row carries a data-filter string (name + path,
 * lowercased). The nav/here/".." rows deliberately have none, so they always
 * stay visible. Filtering hides non-matches; highlight walks the visible set. */
function pickFilterableRows() {
  return [...node.pickList.querySelectorAll('.prow[data-filter]')];
}
function pickVisibleRows() {
  return pickFilterableRows().filter((r) => !r.hidden && !r.disabled);
}
function setPickHi(i) {
  const rows = pickVisibleRows();
  for (const r of pickFilterableRows()) r.classList.remove('hi');
  if (!rows.length) { pick.hi = -1; return; }
  pick.hi = ((i % rows.length) + rows.length) % rows.length;
  const r = rows[pick.hi];
  r.classList.add('hi');
  r.scrollIntoView({ block: 'nearest' });
}
function applyPickFilter() {
  const q = node.pickFilter.value.trim().toLowerCase();
  const rows = pickFilterableRows();
  let shown = 0;
  for (const r of rows) {
    const match = !q || r.dataset.filter.includes(q);
    r.hidden = !match;
    if (match) shown++;
  }
  const oldHint = node.pickList.querySelector('.pick-nomatch');
  if (oldHint) oldHint.remove();
  if (q && shown === 0 && rows.length) {
    node.pickList.append(el('div', { class: 'hint-row pick-nomatch', text: 'no match — clear the filter or type a path below.' }));
  }
  // A single match is pre-highlighted so Enter adds it without an arrow press.
  setPickHi(0);
}
node.pickFilter.addEventListener('input', applyPickFilter);
node.pickFilter.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); return setPickHi(pick.hi + 1); }
  if (e.key === 'ArrowUp') { e.preventDefault(); return setPickHi(pick.hi - 1); }
  if (e.key === 'Enter') {
    const rows = pickVisibleRows();
    const target = (pick.hi >= 0 && rows[pick.hi]) || (rows.length === 1 ? rows[0] : null);
    if (target) { e.preventDefault(); target.click(); }
    return;
  }
  // Esc falls through to the document-level Esc ladder, which closes the picker.
});

$('#addProjBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  if (node.picker.classList.contains('open')) return closePops();
  openPicker();
});

$('#pickMode').addEventListener('click', (e) => {
  e.stopPropagation();
  pick.mode = pick.mode === 'scan' ? 'browse' : 'scan';
  node.pickFilter.value = ''; // FEAT-069: flipping surfaces starts from the full list
  node.pickFilter.focus();
  void paintPicker();
});

async function paintPicker() {
  $('#pickMode').textContent = pick.mode === 'scan' ? 'browse folders ›' : '‹ suggestions';
  if (pick.mode === 'scan') return paintPickerScan();
  return paintPickerBrowse(pick.path);
}

async function paintPickerScan() {
  clear(node.pickList).append(el('div', { class: 'hint-row', text: 'looking for directories…' }));
  try {
    const found = await api.scanProjects();
    if (pick.mode !== 'scan') return; // the user flipped modes mid-fetch
    clear(node.pickList);
    if (!found.length) node.pickList.append(el('div', { class: 'hint-row', text: 'nothing found under ~/projects or ~/random_projects — browse or type a path below.' }));
    for (const s of found) {
      const b = el('button', { class: 'prow', title: s.hostPath });
      b.dataset.filter = `${s.name} ${s.hostPath}`.toLowerCase();
      b.append(el('span', { class: 'mid' },
        el('span', { class: 'nm', text: s.name }),
        el('span', { class: 'ph', text: shortPath(s.hostPath) })));
      if (s.alreadyRegistered) {
        b.disabled = true;
        b.append(el('span', { class: 'tag', text: 'added' }));
      } else if (s.hasGit) {
        b.append(el('span', { class: 'tag', text: 'git' }));
      }
      b.addEventListener('click', () => void addProject(s.hostPath, s.name));
      node.pickList.append(b);
    }
    applyPickFilter(); // FEAT-069: honour a filter typed before the scan resolved
  } catch (err) {
    clear(node.pickList).append(el('div', { class: 'hint-row', text: `scan failed: ${err.message}` }));
  }
}

async function paintPickerBrowse(startPath) {
  clear(node.pickList).append(el('div', { class: 'hint-row', text: 'reading…' }));
  let r;
  try {
    r = await api.listDirs(startPath ?? undefined);
  } catch (err) {
    clear(node.pickList).append(el('div', { class: 'hint-row', text: err.message }));
    return;
  }
  if (pick.mode !== 'browse') return;
  pick.path = r.path;
  node.pickPath.value = r.path; // Enter still means "add what the field says"
  clear(node.pickList);

  const here = el('button', { class: 'prow here', title: r.path });
  here.append(el('span', { class: 'mid' },
    el('span', { class: 'nm', text: r.alreadyRegistered ? 'This directory is already a project' : '+ Add this directory' }),
    el('span', { class: 'ph', text: shortPath(r.path) })));
  if (r.alreadyRegistered) here.disabled = true;
  else here.addEventListener('click', () => void addProject(r.path));
  node.pickList.append(here);

  if (r.parent) {
    const up = el('button', { class: 'prow dir', title: r.parent });
    up.append(el('span', { class: 'mid' }, el('span', { class: 'nm', text: '‹ ..' })));
    up.addEventListener('click', (e) => { e.stopPropagation(); node.pickFilter.value = ''; void paintPickerBrowse(r.parent); });
    node.pickList.append(up);
  }
  if (!r.dirs.length) node.pickList.append(el('div', { class: 'hint-row', text: 'no subdirectories here' }));
  for (const d of r.dirs) {
    const b = el('button', { class: 'prow dir', title: `${d.path} — click to open` });
    b.dataset.filter = `${d.name} ${d.path}`.toLowerCase();
    b.append(el('span', { class: 'mid' }, el('span', { class: 'nm', text: `${d.name} ›` })));
    if (d.alreadyRegistered) b.append(el('span', { class: 'tag', text: 'added' }));
    else if (d.hasGit) b.append(el('span', { class: 'tag', text: 'git' }));
    b.addEventListener('click', (e) => { e.stopPropagation(); node.pickFilter.value = ''; void paintPickerBrowse(d.path); });
    node.pickList.append(b);
  }
  applyPickFilter(); // FEAT-069: keep the filter applied across mode/dir changes
}

/* ---- context menu on the project list's empty space ---- */

function openTreeMenu(x, y) {
  closePops();
  const tm = $('#treeMenu');
  tm.classList.add('open');
  placeAt(tm, x, y);
}
node.tree.addEventListener('contextmenu', (e) => {
  // Rows and headers own their own menus — only true whitespace answers here.
  if (e.target.closest('button')) return;
  e.preventDefault();
  openTreeMenu(e.clientX, e.clientY);
});
/* Deliberately NO left-click trigger: the menu is an extra way in, and a
   stray click on empty space must keep doing what it always did — nothing. */
$('#tmAdd').addEventListener('click', (e) => {
  e.stopPropagation();
  openPicker();
});
$('#tmCollapse').addEventListener('click', (e) => {
  e.stopPropagation();
  state.expanded.clear();
  saveExpanded();
  renderTree();
  closePops();
});

node.pickPath.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const v = node.pickPath.value.trim();
  if (v) void addProject(v);
});

async function addProject(hostPath, name) {
  closePops();
  try {
    // FEAT-089: the picker's "Apply the Orchard method" checkbox (default on)
    // is a reachable opt-out AT ADD TIME — unchecking adds the project without
    // writing anything into the target repo.
    const applyMethod = node.pickApplyMethod ? node.pickApplyMethod.checked : true;
    const { project: p, method } = await api.createProject(hostPath, name, { applyMethod });
    node.pickPath.value = '';
    await loadProjects(); // resets state.projects + resortProjects (an explicit sort point)
    // FEAT-074 (B) — SURFACE the just-added project. A brand-new project has no
    // recorded activity, so the recency sort would sink it to the bottom (and the
    // alpha sort scatters it) — the user then has to hunt for what they just added.
    // Float it to the TOP of the stable captured order as temporarily-most-recent;
    // it relaxes to its natural sort on the next explicit resort (loadProjects /
    // sort toggle), per the ticket — no lie stamped onto lastActivityAt.
    state.projOrder = [p.id, ...state.projOrder.filter((id) => id !== p.id)];
    // FEAT-074 (A) — open a fresh NEW session (the FEAT-073 pending-new active row),
    // NOT an auto-opened detected old session. The detected sessions stay listed in
    // the sidebar to open explicitly; landing on one was the BUG-087 stale-content
    // confusion this design avoids. startNew handles the whole boundary — draft
    // save, socket/watch drop, resetTranscript (header/content agree), pendingNew,
    // composer focus — and renders the pending row aria-current at the project top.
    startNew(p.id);
    // Bring the opened (pending) session into view so the user sees where they
    // landed even in a long sidebar. The pending row is derived + rendered
    // synchronously by startNew's renderTree, so it is present now.
    (node.tree?.querySelector('button.row.pending')
      ?? node.tree?.querySelector('[aria-current="true"]'))?.scrollIntoView?.({ block: 'nearest' });
    const n = state.sessions.get(p.id)?.list.length ?? 0;
    // FEAT-089: SURFACE the method side effect — never let the user discover it.
    let methodNote = '';
    if (method?.declined) {
      methodNote = ' · method not applied (repo untouched)';
    } else if (method?.error) {
      methodNote = ` · method apply failed: ${method.error}`;
    } else if (method?.applied) {
      const createdCount = (method.reports ?? []).filter(
        (r) => /^(created|added|merged)/.test(r.status),
      ).length;
      methodNote = createdCount
        ? ` · method applied (${createdCount} file${createdCount === 1 ? '' : 's'} scaffolded, Working Agreement attached)`
        : ' · method already present (nothing scaffolded)';
    }
    say(`added ${p.name} · new session · ${n} session${n === 1 ? '' : 's'} of history listed${methodNote}`);
  } catch (err) {
    say(`could not add ${hostPath}: ${err.message}`, true);
  }
}

/* -------------------------------------------------------------- chrome bits */

$('#fold').addEventListener('click', () => node.win.classList.toggle('collapsed'));
// FEAT-070 — restore the saved sort and wire the toggle.
state.projSort = loadProjSort();
paintProjSort();
node.projSort?.addEventListener('click', toggleProjSort);
$('#findBtn').addEventListener('click', () => {
  node.finder.classList.toggle('on');
  if (node.finder.classList.contains('on')) { node.findInput.focus(); void loadAllSessions(); }
  else { node.findInput.value = ''; renderTree(); }
});
/*
 * FEAT-059 — the global New button is NOT "new session in whatever project
 * is currently selected" (that used to silently pollute the selected
 * project's session list with a throwaway question). It always opens a
 * session in the Orchard-owned scratch project instead; the per-project "+"
 * next to each project name (renderProjectGroup, above) is the affordance
 * for "a session in THIS project" and is unchanged.
 */
$('#newBtn').addEventListener('click', () => { void startScratch(); });

async function startScratch() {
  let p;
  try {
    p = await api.ensureScratchProject();
  } catch (err) {
    return say(`could not start a scratch session: ${err.message}`, true);
  }
  const idx = state.projects.findIndex((x) => x.id === p.id);
  if (idx < 0) state.projects.push(p);
  else state.projects[idx] = p;
  state.expanded.add(p.id);
  startNew(p.id);
}
node.findInput.addEventListener('focus', () => void loadAllSessions());
node.findInput.addEventListener('input', () => { scheduleContentSearch(); renderTree(); });
node.findInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  // "#partial" + Enter completes the project scope; a completed query searches.
  if (completeProjectScope()) return;
  void runContentSearch();
});

document.addEventListener('click', (e) => {
  if (e.target.closest('#pop') || e.target.closest('#picker') || e.target.closest('#rowMenu')
    || e.target.closest('#projMenu')
    || e.target.closest('#isoBtn') || e.target.closest('#addProjBtn') || e.target.closest('#treeMenu')) return;
  closePops();
});
/* A right-click anywhere else dismisses the row menu too — otherwise the
   browser's own menu would open on top of ours and both would be on screen. */
document.addEventListener('contextmenu', (e) => {
  if (e.target.closest('#rowMenu') || e.target.closest('#projMenu') || e.target.closest('.row') || e.target.closest('.proj')) return;
  closeRowMenu();
  projMenu.classList.remove('open');
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // FEAT-090: the reply sheet is the topmost layer of all — Esc closes it first.
  if (tvSheetOpen()) {
    e.preventDefault();
    closeTvSheet();
    return;
  }
  // FEAT-053: the rail's ticket modal is the topmost layer — Esc closes it
  // FIRST and stops; the drawer/popovers/subagent walk stays untouched below.
  if (ticketModalOpen()) {
    e.preventDefault();
    closeTicketModal();
    return;
  }
  // FEAT-099: Git is a sibling route too; Esc follows its sessions link so the
  // URL and browser history stay in step with the visible surface.
  if (gitView?.isOpen()) {
    e.preventDefault();
    gitView.home.click();
    return;
  }
  // FEAT-075: Esc leaves the guide reader, returning to the session view (via
  // the home link's href so the URL stops saying #/guide).
  if (gv.open) {
    e.preventDefault();
    gv.home.click();
    return;
  }
  // FEAT-058: inside the ticket dashboard, Esc walks OUT of a ticket to the
  // list first — it must not fall through to the session Esc ladder (which
  // would leave a detail view open while acting on the hidden session pane).
  if (tv.open) {
    e.preventDefault();
    if (tv.ticketId) navTickets(tv.projectId, null);
    return;
  }
  const hadPop = document.querySelector('.pop.open');
  closePops();
  if (hadPop) return;
  if (drawer.isOpen()) return drawer.close();
  backToMain(); // last: Esc walks out of a subagent thread
});
$('#backToMain').addEventListener('click', backToMain);
$('#reconnectBtn').addEventListener('click', () => void reconnectDropped());

node.scroll.addEventListener('scroll', onScroll, { passive: true });
node.jump.addEventListener('click', () => {
  const th = viewedThread();
  if (th.key === 'main' && th.gap) return void reopenAtLatest();
  scrollToBottom();
});
node.historyLatestBtn.addEventListener('click', () => reopenAtLatest());
// The viewport height is part of "am I at the bottom" — a resize that shortens
// the scroller must not silently strand a stuck thread above the end.
window.addEventListener('resize', () => {
  const th = viewedThread();
  if (th.stick !== false) scrollToBottom(th);
  else paintJump();
});

/* ═══════════════════════════════════ in-app guide reader (FEAT-075) ═══════
 *
 * `#/guide` (index → README) and `#/guide/<page>` (a specific page) — a ROUTE,
 * a sibling of the ticket dashboard, so the session view underneath stays live.
 *
 * Content is the app's OWN docs/guide/*.md, served read-only by /api/guide. The
 * markdown is rendered by the SAME prose() the transcript and ticket views use;
 * the only special case is a ```mermaid fenced block, which prose() would flatten
 * to a code box (it drops the language) — so mermaid blocks are split OUT here,
 * rendered offline by the vendored mermaid bundle, and everything between them
 * goes through prose() untouched. No network: the bundle is a local static file.
 */
const gv = {
  root: $('#guideView'),
  home: $('#gvHome'),
  sub: $('#gvSub'),
  nav: $('#gvNav'),
  doc: $('#gvDoc'),
  open: false,
  page: null,
  pages: null,     // cached page list (null = not yet loaded)
  seq: 0,          // guards a late fetch from painting over a newer one
  // BUG-094: the hash to send "← sessions" back to — the session that was open
  // when the reader was entered, captured before its pane is hidden. A bare
  // `#/project/<id>` (the old behaviour) is read by the session router as "no
  // session → start a new one", which dropped the user onto a blank session.
  returnHash: '#/',
};
const guideSlide = createSlidePanel(gv.root, { settledClass: 'guide-open' });

/** Keep synchronous panel content work out of a newly displayed slide transition. */
async function waitForEnteringSlide(entering, panel) {
  if (!entering || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  await new Promise((resolve) => {
    let timer;
    const done = (event) => {
      if (event && (event.target !== panel || event.propertyName !== 'transform')) return;
      panel.removeEventListener('transitionend', done);
      clearTimeout(timer);
      resolve();
    };
    panel.addEventListener('transitionend', done);
    timer = setTimeout(done, 300);
  });
}

let mermaidPromise = null;
/** Lazy-load the vendored mermaid bundle (offline; only when a diagram appears). */
function loadMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (mermaidPromise) return mermaidPromise;
  mermaidPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/mermaid.min.js';
    s.onload = () => (window.mermaid ? resolve(window.mermaid) : reject(new Error('mermaid missing after load')));
    s.onerror = () => reject(new Error('mermaid vendor failed to load'));
    document.head.append(s);
  });
  return mermaidPromise;
}

const GUIDE_MERMAID = /```mermaid[^\n]*\n([\s\S]*?)```/g;

/**
 * Render a guide page's markdown: prose() for everything, mermaid fences pulled
 * out into their own holders. Returns the article node plus the pending mermaid
 * blocks to render once the (lazy) engine is up. The holder pre-fills with a
 * labelled source listing, which stays visible as the fallback if the engine is
 * unavailable — the diagram content is never dropped.
 */
async function renderGuideDoc(markdown, seq = gv.seq) {
  const wrap = el('article', { class: 'gv-doc-body prose' });
  const pending = [];
  const md = String(markdown ?? '');
  let last = 0;
  let idx = 0;
  GUIDE_MERMAID.lastIndex = 0;
  let m;
  while ((m = GUIDE_MERMAID.exec(md))) {
    const before = md.slice(last, m.index);
    if (before.trim()) await appendGuideMarkdown(wrap, before, seq);
    if (seq !== gv.seq || !gv.open) return null;
    const holder = el('div', { class: 'gv-mermaid' },
      el('div', { class: 'gv-cap', text: 'diagram · mermaid' }),
      el('pre', { class: 'gv-mermaid-src', text: m[1].replace(/\n+$/, '') }));
    wrap.append(holder);
    pending.push({ holder, src: m[1], id: `gvm-${gv.seq}-${idx += 1}` });
    last = m.index + m[0].length;
  }
  const rest = md.slice(last);
  if (rest.trim()) await appendGuideMarkdown(wrap, rest, seq);
  if (seq !== gv.seq || !gv.open) return null;
  // prose() is tuned for headings INSIDE a message, so it renders `#` as h3 to
  // sit under the page chrome. A guide page IS the page, so promote two levels
  // (h3→h1 …) — the parser is still prose(), only the document altitude shifts.
  for (const h of [...wrap.querySelectorAll('h3, h4, h5, h6')]) {
    const lvl = Math.max(1, Number(h.tagName[1]) - 2);
    const n = el(`h${lvl}`, { class: h.className || null });
    while (h.firstChild) n.append(h.firstChild);
    h.replaceWith(n);
  }
  return { wrap, pending };
}

/**
 * Keep guide markdown out of any single long task. Top-level sections retain
 * their markdown context (tables/lists stay whole), while yielding a painted
 * frame between prose() calls. Closing or navigating invalidates the work.
 */
async function appendGuideMarkdown(wrap, markdown, seq) {
  const chunks = String(markdown).split(/(?=^#{1,2}\s)/m).filter((part) => part.trim());
  for (const chunk of chunks) {
    if (seq !== gv.seq || !gv.open) return;
    wrap.append(...prose(chunk).childNodes);
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}

/** Render any queued mermaid blocks offline; leave the labelled fallback on failure. */
async function renderGuideMermaids(pending, seq) {
  if (!pending.length) return;
  let mermaid;
  try { mermaid = await loadMermaid(); } catch { return; } // fallback listings stand
  if (seq !== gv.seq) return; // navigated away while the bundle loaded
  const dark = document.documentElement.dataset.theme === 'dark'
    || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  try {
    mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'neutral', securityLevel: 'strict', fontFamily: 'inherit' });
  } catch { /* re-init across pages is fine; ignore a duplicate-config throw */ }
  for (const p of pending) {
    if (seq !== gv.seq) return;
    try {
      const { svg } = await mermaid.render(p.id, p.src);
      if (seq !== gv.seq) return;
      clear(p.holder);
      // Trusted content: the app's own committed guide docs, rendered under
      // mermaid securityLevel 'strict'. Same trust tier as ticket/transcript md.
      p.holder.innerHTML = svg;
      p.holder.classList.add('rendered');
    } catch {
      p.holder.classList.add('gv-failed'); // the labelled source stays visible
    }
  }
}

/** Mermaid is deliberately below the slide's critical path, including cached bundles. */
async function renderGuideMermaidsAfterSlide(pending, seq) {
  if (!pending.length) return;
  if (!document.documentElement.classList.contains('guide-open')) {
    await new Promise((resolve) => {
      let timer;
      const done = (event) => {
        if (event && (event.target !== gv.root || event.propertyName !== 'transform')) return;
        gv.root.removeEventListener('transitionend', done);
        clearTimeout(timer);
        resolve();
      };
      gv.root.addEventListener('transitionend', done);
      timer = setTimeout(done, 300);
    });
  }
  if (seq !== gv.seq || !gv.open) return;
  // Loading/parsing the large vendored bundle and Mermaid's own layout are
  // synchronous. Give the settled reader a quiet interval first, so a prompt
  // close wins and cancels this enhancement before either task begins.
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (seq !== gv.seq || !gv.open) return;
  await renderGuideMermaids(pending, seq);
}

/** Paint the left-hand page list, marking the current page. */
function renderGuideNav() {
  clear(gv.nav);
  const pages = gv.pages ?? [];
  if (!pages.length) {
    gv.nav.append(el('div', { class: 'gv-empty', text: 'No guide pages are available.' }));
    return;
  }
  for (const p of pages) {
    const a = el('a', {
      href: formatGuideHash({ page: p.page }),
      class: p.page === gv.page ? 'on' : null,
      text: p.title || p.page,
    });
    a.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.button !== 0) return;
      e.preventDefault();
      navGuide(p.page);
    });
    gv.nav.append(a);
  }
}

/** Show the reader for a route, loading the page list and the named page. */
async function showGuide(route) {
  const seq = (gv.seq += 1);
  const entering = !gv.open;
  const pagesRequest = !gv.pages ? api.guidePages().catch(() => []) : null;
  if (entering) {
    // Capture where "← sessions" returns to BEFORE the session pane is hidden —
    // the FULL open-session route (id, dir, scroll), not a bare project hash
    // (BUG-094). currentRoute() is null only when no project is open at all.
    const back = currentRoute();
    gv.returnHash = back ? formatHash(back) : '#/';
    gv.open = true;
    guideSlide.open();
  }
  const slideReady = waitForEnteringSlide(entering, gv.root);
  gv.home.setAttribute('href', gv.returnHash);
  // Page list: fetched once, then cached for the session.
  if (pagesRequest) {
    gv.pages = await pagesRequest;
    if (seq !== gv.seq) return;
  }
  // No explicit page → the index (README if present, else the first page).
  let page = route.page;
  if (!page) page = gv.pages.some((p) => p.page === 'README') ? 'README' : (gv.pages[0]?.page ?? null);
  const pageRequest = page ? api.guidePage(page).catch(() => null) : null;
  await slideReady;
  if (seq !== gv.seq || !gv.open) return;
  gv.page = page;
  renderGuideNav();
  document.title = page ? `${page} — Guide` : 'Guide — Orchard';
  gv.sub.textContent = gv.pages.find((p) => p.page === page)?.title ?? '';

  if (!page) {
    clear(gv.doc).append(el('div', { class: 'gv-msg', text: 'This build has no guide pages (docs/guide is absent).' }));
    return;
  }
  clear(gv.doc).append(el('div', { class: 'gv-loading', text: 'Loading…' }));
  const data = await pageRequest;
  if (seq !== gv.seq) return;
  if (!data) {
    clear(gv.doc).append(el('div', { class: 'gv-msg' },
      el('b', { text: 'That guide page was not found.' }),
      document.createTextNode(` (${page})`)));
    return;
  }
  const rendered = await renderGuideDoc(data.markdown, seq);
  if (!rendered || seq !== gv.seq || !gv.open) return;
  const { wrap, pending } = rendered;
  clear(gv.doc).append(wrap);
  gv.doc.scrollTop = 0;
  gv.sub.textContent = data.title || gv.sub.textContent;
  void renderGuideMermaidsAfterSlide(pending, seq);
}

function hideGuide() {
  if (!gv.open) return;
  gv.open = false;
  guideSlide.close();
  paintTitle();
}

/** Navigate WITHIN the reader (pushes history, so Back works as expected). */
function navGuide(page, { replace = false } = {}) {
  const href = formatGuideHash({ page });
  if (replace) window.history.replaceState(null, '', href);
  else window.history.pushState(null, '', href);
  void showGuide({ page });
}

gv.home.addEventListener('click', () => { hideGuide(); });

/* ═══════════════════════════════════ ticket dashboard (FEAT-058) ══════════
 *
 * `#/tickets` (list) and `#/tickets/<ID>` (detail) — a ROUTE, deliberately not a
 * modal, so it can live in a SECOND browser tab while the session tab stays live
 * and the user can ask the orchestrator about a ticket while reading it.
 *
 * The rail (FEAT-018) stays the "what needs you NOW" surface; this is the full
 * archive: every ticket, its real file markdown, full-text search over the
 * BODIES (the Activity logs are where the content is), and the writes that let a
 * human keep the board honest — append a note, reopen a Done ticket, flag 👤,
 * file a new ticket.
 *
 * Everything here is files on disk, so a change made in this tab is visible to
 * the NEXT session with no extra plumbing: the board snapshot injected into a
 * launched session's prompt (src/server/board.ts `boardStateSection`) and the
 * rail both read the same INDEX.md + ticket files this writes.
 */
const tv = {
  root: $('#ticketsView'),
  home: $('#tvHome'),
  project: $('#tvProject'),
  search: $('#tvSearch'),
  filters: $('#tvFilters'),
  status: $('#tvStatus'),
  owner: $('#tvOwner'),
  sev: $('#tvSev'),
  count: $('#tvCount'),
  newBtn: $('#tvNew'),
  allBtn: $('#tvAll'),      // FEAT-082 — the persistent "All tickets" control
  digest: $('#tvDigest'),   // FEAT-082 — the landing digest container
  list: $('#tvList'),
  detail: $('#tvDetail'),
  /* state */
  open: false,
  projectId: null,
  ticketId: null,
  // FEAT-082 — which of the three shapes is showing: 'digest' (the landing),
  // 'all' (the full table), 'detail' (one ticket). Drives showTickets + which
  // pane is visible; kept in sync with the URL by parseTicketsHash.
  view: 'digest',
  board: null,       // the last board payload for the digest (lanes + counts)
  q: '',
  rows: [],
  // FEAT-082 — which project `rows` were loaded for. The digest updates
  // `projectId` but leaves the full-list `rows` untouched, so a digest→all
  // hop could otherwise render another project's stale rows. The 'all'/'detail'
  // paths reload whenever this no longer matches `projectId`.
  rowsProjectId: null,
  hasBoard: true,
  current: null,     // the loaded detail
  searchTimer: null,
  seq: 0,            // guards a late fetch from overwriting a newer one
  /* FEAT-063 — tracker bones: sorting lives on the column headers, and the
     list is keyboard-first (↑/↓ move a cursor row, Enter opens it). */
  sortBy: 'activity',
  sortAsc: false,
  cursor: -1,
  // BUG-094: where "← sessions" returns to — the open session captured when the
  // dashboard was entered, not a bare `#/project/<id>` the router reads as "new
  // session". The board can view a DIFFERENT project than the open session; the
  // back link is about the user's session, so it follows state.current, not tv.
  returnHash: '#/',
};
const ticketsSlide = createSlidePanel(tv.root, { settledClass: 'tickets-open' });

const SEV_RANK = { high: 0, med: 1, medium: 1, low: 2 };

function ticketsHref(projectId, ticketId = null, view = null) {
  return formatTicketsHash({ projectId, ticketId, view });
}
/** The full-list ('all') hash for a project. */
function allTicketsHref(projectId) {
  return formatTicketsHash({ projectId, view: 'all' });
}

/**
 * Show the dashboard for a route, loading whatever it names. FEAT-082 — three
 * shapes, resolved once here into `tv.view`:
 *   digest  — bare `#/tickets`: the landing (what awaits you). Fetches board +
 *             tickets in parallel and renders the digest.
 *   all     — `#/tickets/all`: the full sortable/searchable/keyboard table (the
 *             former landing state, moved wholesale, behaviour unchanged).
 *   detail  — `#/tickets/<ID>`: one ticket, unchanged.
 */
async function showTickets(route) {
  const pid = route.projectId || tv.projectId || state.current.projectId
    || (state.projects[0]?.id ?? null);
  const changedProject = pid !== tv.projectId;
  tv.projectId = pid;
  const view = route.view === 'all' ? 'all' : (route.ticketId ? 'detail' : 'digest');
  tv.view = view;
  tv.ticketId = view === 'detail' ? (route.ticketId ?? null) : null;
  if (!tv.open) {
    // BUG-094: capture the open-session route BEFORE hiding its pane — "←
    // sessions" returns HERE, not to a bare project hash that starts a new one.
    const back = currentRoute();
    tv.returnHash = back ? formatHash(back) : '#/';
    tv.open = true;
    ticketsSlide.open();
    void loadBoardProjects();
  } else if (changedProject) {
    // Refresh the project switcher so its selected option (and counts) tracks the
    // project actually on screen — otherwise a URL hop to another project's board
    // leaves the dropdown labelling the wrong one.
    void loadBoardProjects();
  }
  document.title = tv.ticketId
    ? `${tv.ticketId} — Board`
    : (view === 'all' ? 'All tickets — Board' : 'Board — Orchard');
  tv.home.setAttribute('href', tv.returnHash);
  // The "All tickets" control points at /all and hides itself while that IS the
  // view (nothing to escape to).
  tv.allBtn.setAttribute('href', allTicketsHref(pid));
  tv.allBtn.classList.toggle('on', view === 'all');

  if (view === 'digest') {
    await showDigest(changedProject);
    return;
  }
  // 'all' and 'detail' both need the ticket rows (the table, and the back-to-list
  // continuity behind a detail). Reload if the project changed, we have none, or
  // the cached rows belong to a different project (a digest hop can leave them so).
  if (changedProject || !tv.rows.length || tv.rowsProjectId !== pid) await loadTicketRows();
  else renderTicketRows();
  if (view === 'detail') await loadTicketDetail(tv.ticketId);
  else showTicketList();
}

function hideTickets() {
  if (!tv.open) return;
  tv.open = false;
  ticketsSlide.close();
  paintTitle();
}

/* ═══════════════════════════════════ the digest (FEAT-082) ════════════════
 *
 * The landing state for `#/tickets`. The premise (user's words): opening the
 * board should show WHAT AWAITS YOUR INPUT, not the corpus. So this is not a
 * table — it is, top to bottom: a thin counts strip, the Awaiting-you block
 * (Decide / Look at), Answered-awaiting, In flight, Recently-updated (7d, ≤10),
 * and Observations (collapsed). The full table still exists, one click away at
 * `#/tickets/all`. Built from BOTH /board (lanes, counts, observations) and
 * /tickets (recently-updated), fetched in parallel; on partial failure it
 * renders what loaded and says plainly what did not.
 */

/** The ticket TYPE from its id prefix (FEAT / BUG / ARCH / DEPLOY / …). */
function ticketType(id) {
  const m = /^([A-Z]+)-\d+$/.exec(String(id || ''));
  return m ? m[1] : '';
}

/**
 * A small type badge. ARCH gets a deliberately DISTINCT treatment (an outlined
 * ◆ chip) rather than a fourth colour in the same family — there are only four
 * ARCH tickets and half of them are open decisions, so they should read apart.
 */
function typeBadge(id) {
  const t = ticketType(id);
  const cls = `dg-tb tt-${t.toLowerCase() || 'na'}`;
  if (t === 'ARCH') {
    return el('span', { class: `${cls} arch`, title: 'Architecture' },
      el('span', { class: 'dg-tb-glyph', text: '◆' }),
      el('span', { text: 'ARCH' }));
  }
  return el('span', { class: cls, title: t || 'ticket', text: t || '—' });
}

/** Whole days between a `YYYY-MM-DD` and today (UTC), or null if unparseable. */
function daysAgo(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return null;
  const then = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((today - then) / 86_400_000);
}

/** A compact relative-day label for a `YYYY-MM-DD` (falls back to the raw string). */
function relDay(dateStr) {
  const d = daysAgo(dateStr);
  if (d === null) return String(dateStr || '');
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d}d ago`;
  if (d < 14) return '1w ago';
  if (d < 60) return `${Math.floor(d / 7)}w ago`;
  return String(dateStr);
}

/** One-line clamp helper for a title/question shown inline. */
function clampText(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

/**
 * Enter the digest: hide the other panes, fetch board + tickets in parallel, and
 * render. `api.board` degrades a no-board project to {hasBoard:false} rather than
 * throwing, so a genuine transport failure is the only rejection — allSettled
 * lets each lane fail independently (partial-failure honesty).
 */
async function showDigest() {
  tv.detail.hidden = true;
  tv.list.hidden = true;
  tv.filters.hidden = true;
  tv.digest.hidden = false;
  tv.current = null;
  const pid = tv.projectId;
  const seq = ++tv.seq;
  clear(tv.digest).append(el('div', { class: 'dg-loading', text: 'reading the board…' }));
  if (!pid) { renderDigest({ status: 'rejected' }, { status: 'rejected' }); return; }
  const [boardRes, listRes] = await Promise.allSettled([api.board(pid), api.ticketList(pid, '')]);
  if (seq !== tv.seq || pid !== tv.projectId || tv.view !== 'digest') return; // superseded
  // The digest already fetched this project's UNFILTERED ticket list — keep it as
  // the full-list cache so a digest→all hop needs no second round-trip and can
  // never render another project's stale rows (tv.rowsProjectId is the guard).
  if (listRes.status === 'fulfilled' && Array.isArray(listRes.value?.tickets)) {
    tv.rows = listRes.value.tickets;
    tv.hasBoard = listRes.value.hasBoard !== false;
    tv.rowsProjectId = pid;
    tv.q = '';
  }
  tv.board = boardRes.status === 'fulfilled' ? boardRes.value : null;
  renderDigest(boardRes, listRes);
}

/** Set the full-list filters + query, then navigate to `/all` pre-filtered. The
 *  full-text body search is server-side, so clear the cached rows to force a
 *  re-fetch under the new query (filters alone are client-side and need none,
 *  but clearing unconditionally keeps the landing state honest). */
function openAllFiltered({ status = 'all', owner = 'all', sev = 'all', q = '' } = {}) {
  tv.q = q;
  tv.search.value = q;
  tv.status.value = status;
  tv.owner.value = owner;
  tv.sev.value = sev;
  tv.rows = [];
  navTickets(tv.projectId, null, { view: 'all' });
}

/**
 * FEAT-082 (visual review) — the digest search placeholder, SHORTENED at narrow
 * widths instead of being clipped. The full phrase ends "…↵ opens the full list";
 * at 480px the field cut it mid-phrase ("↵ opens the full"), which loses the word
 * that made the sentence mean anything. A placeholder cannot be picked in CSS, so
 * the width test lives here — one module-level media query, one listener, so a
 * re-render never stacks another.
 */
const dgNarrow = window.matchMedia('(max-width: 560px)');
const digestSearchPlaceholder = () =>
  (dgNarrow.matches ? 'Search every ticket…' : 'Search every ticket body… ↵ opens the full list');
dgNarrow.addEventListener('change', () => {
  const s = document.querySelector('.dg-search');
  if (s) s.placeholder = digestSearchPlaceholder();
});

/** A counts chip: scrolls to a digest section when present, else navigates. */
function digestChip({ label, n, onClick }) {
  const chip = el('button', {
    type: 'button', class: `dg-chip st-${label.replace(/\s+/g, '')}${n ? '' : ' zero'}`,
    title: n ? `${n} ${label}` : `no ${label}`,
  }, el('span', { class: 'dg-cn', text: String(n) }), el('span', { class: 'dg-cl', text: label }));
  if (n && onClick) chip.addEventListener('click', onClick);
  else chip.disabled = true;
  return chip;
}

/** One Awaiting-you row (kind 'decide' | 'look'). */
function digestAwaitRow(it, kind, actMap) {
  const when = relDay(actMap.get(it.id)?.lastActivity);
  const a = el('a', {
    class: `dg-item dg-${kind}`, 'data-id': it.id, href: ticketsHref(tv.projectId, it.id),
  });
  a.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navTickets(tv.projectId, it.id);
  });
  const head = el('div', { class: 'dg-item-head' },
    typeBadge(it.id),
    el('span', { class: 'dg-id', text: it.id }),
    el('span', { class: 'dg-title', text: it.title, title: it.title }),
    it.sev ? el('span', { class: `dg-sev sev-${it.sev.toLowerCase().slice(0, 3)}`, text: it.sev }) : null,
    when ? el('span', { class: 'dg-when', text: when }) : null);
  a.append(head);
  if (kind === 'decide') {
    const nOpts = it.options?.length ?? 0;
    const meta = el('div', { class: 'dg-decide-meta' },
      el('span', { class: 'dg-optc', text: nOpts ? `${nOpts} options` : 'decision' }));
    if (it.recommended) meta.append(el('span', { class: 'dg-rec', text: `recommends ${it.recommended}` }));
    const body = el('div', { class: 'dg-item-body' });
    // FEAT-082 (visual review): when the ticket's decision heading carried no
    // content of its own, the server falls back to the ticket TITLE as the
    // question (board.ts questionFromTitle) — and the title is already the head
    // of this row. Printing it again, or printing the scaffolding heading ("The
    // decision"), would put a contentless line where the thing to decide goes;
    // the option count + the title carry the row instead.
    if (it.question && !it.questionFromTitle) body.append(el('span', { class: 'dg-q', text: clampText(it.question, 120) }));
    body.append(meta);
    a.append(body);
  } else {
    // The INDEX status blurb, VERBATIM (clamped to two lines by CSS). This
    // sentence is the triage recommendation — what makes "look at" possible
    // without opening the ticket.
    const blurb = String(it.status || '').trim();
    a.append(el('div', { class: 'dg-item-body' },
      el('span', { class: 'dg-blurb', text: blurb || 'no status recorded on the board row' })));
  }
  return a;
}

/**
 * Build the whole digest from the (settled) board + tickets fetches. Renders
 * what loaded; a failed lane becomes an honest inline notice, not a blank.
 */
function renderDigest(boardRes, listRes) {
  const board = boardRes.status === 'fulfilled' ? boardRes.value : null;
  const boardOk = !!board;
  const rows = listRes.status === 'fulfilled' ? (listRes.value?.tickets ?? []) : null;
  const listOk = Array.isArray(rows);
  // Join lastActivity/mtime onto the board items (the board payload carries
  // neither — the tickets list does).
  const actMap = new Map((rows ?? []).map((r) => [r.id, r]));

  const needs = board?.needsYou ?? [];
  const answered = board?.answeredAwaiting ?? [];
  const inflight = board?.inflight ?? [];
  const observations = board?.observations ?? [];
  const counts = board?.summary?.counts ?? null;

  const wrap = el('div', { class: 'dg-wrap' });

  if (!boardOk && !listOk) {
    clear(tv.digest).append(el('div', { class: 'dg-wrap' },
      el('div', { class: 'dg-fail' },
        el('b', { text: 'The board could not be read.' }),
        document.createTextNode(' Neither the board nor the ticket list answered. '),
        el('a', { class: 'dg-inline-link', href: allTicketsHref(tv.projectId), text: 'Try the full list →' }))));
    return;
  }
  if (boardOk && !board.hasBoard) {
    clear(tv.digest).append(el('div', { class: 'dg-wrap' },
      el('div', { class: 'dg-empty-board' },
        el('b', { text: 'This project has no board.' }),
        document.createTextNode(' There is no docs/bugs/ directory here — onboard the project to start one.'))));
    return;
  }

  /* ── counts strip ── */
  if (counts) {
    const openTotal = (counts.needs ?? 0) + (counts.answered ?? 0) + (counts.inflight ?? 0) + (counts.queued ?? 0);
    const scrollTo = (sel) => () => {
      const t = tv.digest.querySelector(sel);
      if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    const strip = el('div', { class: 'dg-counts' },
      digestChip({ label: 'needs', n: counts.needs ?? 0, onClick: scrollTo('#dg-awaiting') }),
      digestChip({ label: 'answered', n: counts.answered ?? 0, onClick: scrollTo('#dg-answered') }),
      digestChip({ label: 'in flight', n: counts.inflight ?? 0, onClick: scrollTo('#dg-inflight') }),
      digestChip({ label: 'queued', n: counts.queued ?? 0, onClick: () => openAllFiltered({ status: 'open', owner: 'none' }) }),
      digestChip({ label: 'observations', n: counts.observations ?? 0, onClick: scrollTo('#dg-observations') }),
      digestChip({ label: 'open', n: openTotal, onClick: () => openAllFiltered({ status: 'open' }) }),
      digestChip({ label: 'done', n: counts.doneToday ?? 0, onClick: () => openAllFiltered({ status: 'done' }) }));
    wrap.append(strip);
  } else if (!boardOk) {
    wrap.append(el('div', { class: 'dg-note', text: 'The board lanes and counts could not be loaded — showing recent activity only.' }));
  }

  /* ── a digest search: Enter launches the full body-search list ── */
  const search = el('input', {
    class: 'dg-search', type: 'search', autocomplete: 'off', spellcheck: 'false',
    placeholder: digestSearchPlaceholder(), 'aria-label': 'Search tickets',
  });
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    openAllFiltered({ q: search.value.trim() });
  });
  wrap.append(el('div', { class: 'dg-searchrow' }, search,
    el('a', { class: 'dg-inline-link', href: allTicketsHref(tv.projectId), text: 'All tickets →' })));

  /* ── Awaiting you — the largest block ── */
  const awaiting = el('section', { class: 'dg-sec dg-awaiting', id: 'dg-awaiting' });
  awaiting.append(el('h2', { class: 'dg-h', text: 'Awaiting you' }));
  if (!boardOk) {
    awaiting.append(el('div', { class: 'dg-fail-inline', text: 'The board lanes could not be loaded — the full list is still available above.' }));
  } else if (!needs.length) {
    // Inbox zero: collapse to a plain line, and let Recently-updated be the body.
    awaiting.append(el('div', { class: 'dg-zero' },
      el('span', { class: 'dg-zero-tick', text: '✓' }),
      el('span', { text: 'Nothing needs you.' })));
  } else {
    const decide = needs.filter((it) => it.question);
    const look = needs.filter((it) => !it.question);
    if (decide.length) {
      awaiting.append(el('div', { class: 'dg-subh dg-subh-decide' },
        el('span', { text: 'Decide' }), el('span', { class: 'dg-subn', text: String(decide.length) })));
      const g = el('div', { class: 'dg-group' });
      for (const it of decide) g.append(digestAwaitRow(it, 'decide', actMap));
      awaiting.append(g);
    }
    if (decide.length && look.length) awaiting.append(el('div', { class: 'dg-divider' }));
    if (look.length) {
      awaiting.append(el('div', { class: 'dg-subh dg-subh-look' },
        el('span', { text: 'Look at' }), el('span', { class: 'dg-subn', text: String(look.length) })));
      const g = el('div', { class: 'dg-group' });
      for (const it of look) g.append(digestAwaitRow(it, 'look', actMap));
      awaiting.append(g);
    }
  }
  wrap.append(awaiting);

  /* ── Answered — awaiting action (hidden when empty) ── */
  if (answered.length) {
    const sec = el('section', { class: 'dg-sec dg-answered', id: 'dg-answered' });
    sec.append(el('h2', { class: 'dg-h', text: 'Answered — awaiting action' }));
    const g = el('div', { class: 'dg-group' });
    for (const it of answered) {
      const a = el('a', { class: 'dg-item dg-answered-item', 'data-id': it.id, href: ticketsHref(tv.projectId, it.id) });
      a.addEventListener('click', (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navTickets(tv.projectId, it.id);
      });
      a.append(el('div', { class: 'dg-item-head' },
        typeBadge(it.id),
        el('span', { class: 'dg-id', text: it.id }),
        el('span', { class: 'dg-title', text: it.title, title: it.title })));
      a.append(el('div', { class: 'dg-item-body' },
        el('span', { class: 'dg-answer', text: `you chose “${clampText(it.answer, 80)}”${it.answeredOn ? ` on ${it.answeredOn}` : ''}` }),
        el('span', { class: 'dg-nodispatch', text: 'nothing dispatched yet' })));
      g.append(a);
    }
    sec.append(g);
    wrap.append(sec);
  }

  /* ── In flight (hidden when empty) — one read-only line each ── */
  if (inflight.length) {
    const sec = el('section', { class: 'dg-sec dg-inflight', id: 'dg-inflight' });
    sec.append(el('h2', { class: 'dg-h', text: 'In flight' }));
    const g = el('div', { class: 'dg-group' });
    for (const it of inflight) {
      const a = el('a', { class: 'dg-item dg-flight-item', 'data-id': it.id, href: ticketsHref(tv.projectId, it.id) });
      a.addEventListener('click', (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navTickets(tv.projectId, it.id);
      });
      a.append(el('div', { class: 'dg-item-head' },
        typeBadge(it.id),
        el('span', { class: 'dg-id', text: it.id }),
        el('span', { class: 'dg-title', text: it.title, title: it.title }),
        el('span', { class: 'dg-flight-glyph', text: '🤖', title: 'an agent is on it' }),
        relDay(actMap.get(it.id)?.lastActivity) ? el('span', { class: 'dg-when', text: relDay(actMap.get(it.id)?.lastActivity) }) : null));
      g.append(a);
    }
    sec.append(g);
    wrap.append(sec);
  }

  /* ── Recently updated — 7-day window, capped 10, grouped by day ── */
  const rec = el('section', { class: 'dg-sec dg-recent', id: 'dg-recent' });
  const recCount = el('span', { class: 'dg-count-note' });
  rec.append(el('div', { class: 'dg-h-row' },
    el('h2', { class: 'dg-h', text: 'Recently updated' }),
    recCount,
    el('a', { class: 'dg-inline-link', href: allTicketsHref(tv.projectId),
      title: 'The full list, newest activity first', text: 'see all →' })));
  if (!listOk) {
    rec.append(el('div', { class: 'dg-fail-inline', text: 'The ticket list could not be loaded, so recent activity is unavailable.' }));
  } else {
    // Last 7 days by the ticket's newest Activity date; capped at 10 (87 of the
    // real board's 166 files were touched in the last 7 days — unbounded here
    // just recreates the corpus the digest exists to avoid). No change summary:
    // the data model only knows lastActivity, and inventing "what changed" would
    // be a lie.
    //
    // FEAT-082 (visual review): a ticket already shown ABOVE (Awaiting you,
    // Answered, In flight) is not repeated down here — on a screen whose whole
    // premise is compression, the same three tickets appearing twice reads as a
    // dump, not a digest. The lanes above always carry more context than a
    // recent-activity line, so the row above wins.
    const shownAbove = new Set([...needs, ...answered, ...inflight].map((it) => it.id));
    const inWindow = rows
      .filter((r) => { const d = daysAgo(r.lastActivity); return d !== null && d >= 0 && d <= 6; })
      .sort((a, b) => (a.lastActivity === b.lastActivity ? b.mtimeMs - a.mtimeMs : (a.lastActivity < b.lastActivity ? 1 : -1)))
      .filter((r) => !shownAbove.has(r.id));
    const recent = inWindow.slice(0, 10);
    // Name the window: "10 of 63" reads as curation; a bare 10 reads as a
    // truncation the screen is hiding from you.
    if (inWindow.length) recCount.textContent = `${recent.length} of ${inWindow.length}`;
    if (!recent.length) {
      rec.append(el('div', { class: 'dg-quiet', text: 'No tickets were touched in the last 7 days.' }));
    } else {
      let day = null;
      let group = null;
      for (const r of recent) {
        if (r.lastActivity !== day) {
          day = r.lastActivity;
          rec.append(el('div', { class: 'dg-dayh', text: relDay(day) }));
          group = el('div', { class: 'dg-group' });
          rec.append(group);
        }
        const a = el('a', { class: 'dg-item dg-recent-item', 'data-id': r.id, href: ticketsHref(tv.projectId, r.id) });
        a.addEventListener('click', (e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          navTickets(tv.projectId, r.id);
        });
        const kind = ticketStatusKind(r);
        a.append(el('div', { class: 'dg-item-head' },
          typeBadge(r.id),
          el('span', { class: 'dg-id', text: r.id }),
          el('span', { class: 'dg-title', text: r.title, title: r.title }),
          // No date on the row: every row here sits under a day heading that
          // already states it, and ten rows repeating one date is ten rows of
          // nothing. The state pill carries what differs.
          // ARCH-004: the digest is the LANDING screen, so an unreadable state
          // must not draw a confident "Open" here either. Only the ERROR level
          // reaches the digest — a half-edited-but-unambiguous file is not
          // worth a mark on a screen whose whole premise is compression, and
          // its warning is waiting one click away in the detail pane.
          digestStatePill(r, kind)));
        group.append(a);
      }
    }
  }
  wrap.append(rec);

  /* ── Observations — bottom, collapsed to a count, expandable ── */
  if (observations.length) {
    const sec = el('section', { class: 'dg-sec dg-observations', id: 'dg-observations' });
    const body = el('div', { class: 'dg-obs-body', hidden: true });
    for (const it of observations) body.append(observationRow(it));
    const toggle = el('button', { type: 'button', class: 'dg-obs-toggle', 'aria-expanded': 'false' },
      el('span', { class: 'dg-obs-caret', text: '▸' }),
      el('span', { text: `Observations` }),
      el('span', { class: 'dg-obs-n', text: String(observations.length) }));
    toggle.addEventListener('click', () => {
      const open = body.hidden;
      body.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      toggle.querySelector('.dg-obs-caret').textContent = open ? '▾' : '▸';
    });
    sec.append(toggle, body);
    wrap.append(sec);
  }

  clear(tv.digest).append(wrap);
}

/** Navigate WITHIN the dashboard (pushes history, so Back works as expected).
 *  FEAT-082 — `view` selects the digest / full-list / detail shape; when it is
 *  'all' the ticketId is ignored (the full list names no single ticket). */
function navTickets(projectId, ticketId, { replace = false, view = null } = {}) {
  const resolved = view === 'all' ? 'all' : (ticketId ? 'detail' : 'digest');
  const href = formatTicketsHash({ projectId, ticketId: resolved === 'detail' ? ticketId : null, view: resolved });
  if (replace) window.history.replaceState(null, '', href);
  else window.history.pushState(null, '', href);
  void showTickets({ projectId, ticketId: resolved === 'detail' ? ticketId : null, view: resolved });
}

/** The project switcher: every registered project that HAS a board. */
async function loadBoardProjects() {
  let boards = [];
  try { boards = await api.boards(); } catch { /* the switcher is a nicety */ }
  clear(tv.project);
  const known = new Set();
  for (const b of boards) {
    known.add(b.id);
    tv.project.append(el('option', {
      value: b.id,
      text: `${b.name} — ${b.open} open${b.needsYou ? ` · ${b.needsYou}👤` : ''}`,
    }));
  }
  // The selected project may have no board at all — say so rather than
  // silently switching the user to somebody else's board.
  if (tv.projectId && !known.has(tv.projectId)) {
    const p = state.projects.find((x) => x.id === tv.projectId);
    tv.project.append(el('option', { value: tv.projectId, text: `${p?.name ?? tv.projectId} — no board` }));
  }
  tv.project.value = tv.projectId ?? '';
}

async function loadTicketRows() {
  const pid = tv.projectId;
  const seq = ++tv.seq;
  if (!pid) { tv.rows = []; tv.rowsProjectId = null; renderTicketRows(); return; }
  tv.list.setAttribute('aria-busy', 'true');
  try {
    const r = await api.ticketList(pid, tv.q);
    if (seq !== tv.seq || pid !== tv.projectId) return; // a newer request won
    tv.rows = r.tickets ?? [];
    tv.hasBoard = r.hasBoard !== false;
    tv.rowsProjectId = pid;
  } catch (err) {
    if (seq !== tv.seq) return;
    tv.rows = [];
    tv.rowsProjectId = null;
    tv.hasBoard = false;
    say(`could not read the board: ${err.message}`, true);
  } finally {
    tv.list.removeAttribute('aria-busy');
  }
  renderTicketRows();
}

function filteredRows() {
  const st = tv.status.value;
  const ow = tv.owner.value;
  const sv = tv.sev.value;
  let rows = tv.rows.filter((t) => {
    if (st !== 'all' && t.section !== st) return false;
    if (ow === 'you' && !t.needsYou) return false;
    if (ow === 'agent' && !String(t.owner).includes('🤖')) return false;
    if (ow === 'none' && (t.needsYou || String(t.owner).includes('🤖'))) return false;
    if (sv !== 'all' && (t.sev || '').toLowerCase().slice(0, 3) !== sv.slice(0, 3)) return false;
    return true;
  });
  // FEAT-063: header-driven sorting. `cmp` is always ASCENDING; `sortAsc`
  // is the direction sign. (Clicking "Activity" defaults to descending —
  // newest first — every other column to ascending; see sortByColumn.)
  const by = tv.sortBy;
  const cmp = (a, b) => {
    if (by === 'id') return a.id.localeCompare(b.id, undefined, { numeric: true });
    if (by === 'title') return a.title.localeCompare(b.title);
    if (by === 'owner') return ownerGlyph(a).localeCompare(ownerGlyph(b));
    if (by === 'status') {
      const s = (t) => (t.section === 'done' ? 'Done' : (t.boardStatus || t.status || 'open'));
      return s(a).localeCompare(s(b));
    }
    if (by === 'sev') {
      const r = (SEV_RANK[(b.sev || '').toLowerCase()] ?? 3) - (SEV_RANK[(a.sev || '').toLowerCase()] ?? 3);
      if (r) return r; // ascending severity = low → high
      return a.id.localeCompare(b.id, undefined, { numeric: true });
    }
    // activity, ascending = oldest first; ties break on mtime
    return a.lastActivity === b.lastActivity ? a.mtimeMs - b.mtimeMs : (a.lastActivity < b.lastActivity ? -1 : 1);
  };
  const sign = tv.sortAsc ? 1 : -1;
  return rows.slice().sort((a, b) => sign * cmp(a, b));
}

/** A header click: same column toggles direction, a new column gets its
 *  intuitive default (activity newest-first, everything else ascending). */
function sortByColumn(col) {
  if (tv.sortBy === col) tv.sortAsc = !tv.sortAsc;
  else { tv.sortBy = col; tv.sortAsc = col !== 'activity'; }
  renderTicketRows();
}

function ownerGlyph(t) {
  if (t.needsYou) return '👤';
  if (String(t.owner).includes('🤖')) return '🤖';
  return '—';
}

/**
 * FEAT-066: the small STATUS color language. Derives a stable kind from the
 * ticket's own facts — the tags/badges get tinted, never the page. Kinds map to
 * the palette-derived tint tokens in styles.css (open=neutral, in-progress=blue,
 * needs-you=amber, done/verified=green; dark-theme aware, one source of truth):
 *   done  — closed/verified (section === done)
 *   needs — 👤 waiting on the user
 *   prog  — 🤖 in flight, or a "building/in-progress" status
 *   open  — everything else (the neutral default; no tint added)
 */
function ticketStatusKind(t) {
  if (t.section === 'done') return 'done';
  if (t.needsYou) return 'needs';
  const status = String(t.boardStatus || t.status || '').toLowerCase();
  if (String(t.owner || '').includes('🤖') || /progress|building|in.?flight|wip|review/.test(status)) return 'prog';
  return 'open';
}

/**
 * ARCH-004 — THE TICKET'S OWN REPORT ABOUT ITS STATE, ON SCREEN.
 *
 * The schema (scripts/lib/ticket-schema.mjs) enumerates every way a ticket can
 * fail to declare exactly one interpretable state — absent, empty,
 * unrecognised, duplicated-and-disagreeing, duplicated-and-agreeing, declared
 * below the header, or written with near-miss punctuation — and the server
 * carries the verdict on every summary as `statusError` / `statusWarning`.
 * Three rounds of work made the parser loud; until this renderer read those two
 * fields, the loudness stopped at the API and a ticket whose state is
 * contradictory drew an ordinary row showing its raw prose. The whole point of
 * a loud parser is that a PERSON sees it, so both fields are rendered here.
 *
 * The two levels are deliberately NOT one appearance:
 *   · ERROR   — no tool can answer done-or-open for this ticket. The row's
 *               status tag stops claiming a state at all: it is REPLACED by the
 *               server's own headline, tinted brick, and the row takes a brick
 *               edge so it is findable while scanning.
 *   · WARNING — the answer is not in doubt, the file is just half-edited. The
 *               status stays exactly as it was and picks up one small amber
 *               mark; nothing is recoloured, because nothing is wrong with the
 *               answer.
 * Both carry the SERVER'S sentence verbatim — as the tag's `title`, as
 * screen-reader text inside the row (a colour-only or hover-only signal is the
 * same invisibility this fixes), and in full in the detail pane.
 */
function statusFlaw(t) {
  const err = String(t?.statusError ?? '').trim();
  const warn = String(t?.statusWarning ?? '').trim();
  if (err) return { level: 'error', message: err, headline: flawHeadline(err) };
  if (warn) return { level: 'warn', message: warn, headline: flawHeadline(warn) };
  return null;
}

/**
 * The first clause of the server's message — `MISSING STATUS FIELD`,
 * `DUPLICATE STATUS FIELD`, `UNMAPPABLE STATUS`… — which is already written as
 * a short headline before the `: <file> — <detail>` that follows. Taking the
 * server's own words keeps the table honest with the detail pane and with
 * `board:check`; the UI never invents a second vocabulary for the same defect.
 */
function flawHeadline(msg) {
  const i = msg.indexOf(':');
  const head = (i > 0 && i <= 34 ? msg.slice(0, i) : msg).trim();
  return head.length <= 34 ? head : `${head.slice(0, 33)}…`;
}

/** The Status cell for one row — the flawed shapes included (see statusFlaw). */
function ticketStatusCell(t, flaw) {
  const text = t.section === 'done' ? 'Done' : (t.boardStatus || t.status || 'open');
  if (!flaw) return el('span', { class: `c-status st-${ticketStatusKind(t)}`, text });
  if (flaw.level === 'error') {
    // The state is NOT rendered: there is no state to render, and printing the
    // raw prose next to the error would re-assert the very claim that failed.
    return el('span', { class: 'c-status st-flaw-err', title: flaw.message },
      document.createTextNode(flaw.headline),
      el('span', { class: 'sr-only', text: ` — status error: ${flaw.message}` }));
  }
  return el('span', { class: `c-status st-${ticketStatusKind(t)} has-flaw-warn`, title: flaw.message },
    document.createTextNode(text),
    el('span', { class: 'c-flawmark', 'aria-hidden': 'true', text: WARN_MARK }),
    el('span', { class: 'sr-only', text: ` — status warning: ${flaw.message}` }));
}

/** U+FE0E pins the text presentation: a colour-emoji triangle would shout. */
const WARN_MARK = '⚠︎';

/**
 * The detail pane's notes — zero, one or two hairline blocks carrying the
 * server's sentences verbatim. `statusWarning` is the joined form of a LIST
 * (' | ' between entries, built by the schema), so it is split back into one
 * line per defect: two independent complaints run together read as one
 * confusing sentence.
 */
/** The digest recent-lane state pill — brick + the server's headline when the state cannot be read. */
function digestStatePill(r, kind) {
  const err = String(r?.statusError ?? '').trim();
  if (!err) return el('span', { class: `dg-state st-${kind}`, text: r.section === 'done' ? 'Done' : 'Open' });
  return el('span', { class: 'dg-state st-flaw-err', title: err },
    document.createTextNode(flawHeadline(err)),
    el('span', { class: 'sr-only', text: ` — status error: ${err}` }));
}

function statusFlawNotes(t) {
  const out = [];
  const err = String(t?.statusError ?? '').trim();
  const warn = String(t?.statusWarning ?? '').trim();
  if (err) out.push(flawNote('error', 'status error', [err]));
  if (warn) out.push(flawNote('warn', 'status warning', warn.split(' | ').map((s) => s.trim()).filter(Boolean)));
  return out;
}

function flawNote(level, label, lines) {
  const box = el('div', {
    class: `tv-flaw ${level === 'error' ? 'err' : 'warn'}`,
    role: 'note', 'aria-label': label,
  }, el('span', { class: 'tvf-k', text: label }));
  const body = el('div', { class: 'tvf-body' });
  for (const line of lines) body.append(el('p', { class: 'tvf-m', text: line }));
  box.append(body);
  return box;
}

function renderTicketRows() {
  const rows = filteredRows();
  clear(tv.list);
  tv.count.textContent = tv.q
    ? `${rows.length} matching · ${tv.rows.length} scanned`
    : `${rows.length} of ${tv.rows.length}`;

  if (!tv.hasBoard) {
    tv.list.append(el('div', { class: 'tv-empty' },
      el('b', { text: 'This project has no board.' }),
      document.createTextNode(' There is no docs/bugs/ directory here — onboard the project to start one.')));
    return;
  }
  if (!rows.length) {
    tv.list.append(el('div', { class: 'tv-empty' },
      el('b', { text: tv.q ? 'No ticket matches that.' : 'No tickets match these filters.' }),
      document.createTextNode(tv.q ? ' The search covers ids, titles and every line of every ticket body.' : '')));
    return;
  }
  // FEAT-063: sortable headers — the table is the sort control now.
  const hcell = (cls, col, label) => {
    const active = tv.sortBy === col;
    const c = el('span', {
      class: `${cls} hsort${active ? (tv.sortAsc ? ' asc' : ' desc') : ''}`,
      role: 'button', tabindex: '0',
      'aria-sort': active ? (tv.sortAsc ? 'ascending' : 'descending') : 'none',
      title: `Sort by ${label.toLowerCase()}`,
      text: label,
    });
    c.addEventListener('click', () => sortByColumn(col));
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sortByColumn(col); } });
    return c;
  };
  const head = el('div', { class: 'tv-row tv-head' },
    hcell('c-id', 'id', 'ID'),
    hcell('c-title', 'title', 'Title'),
    hcell('c-own', 'owner', 'Owner'),
    hcell('c-status', 'status', 'Status'),
    hcell('c-sev', 'sev', 'Sev'),
    hcell('c-when', 'activity', 'Activity'));
  tv.list.append(head);
  tv.cursor = Math.min(tv.cursor, rows.length - 1);
  for (const [i, t] of rows.entries()) {
    const flaw = statusFlaw(t);
    const row = el('a', {
      class: `tv-row${t.section === 'done' ? ' done' : ''}${i === tv.cursor ? ' kb' : ''}`
        + (flaw ? ` tv-flawed flaw-${flaw.level === 'error' ? 'err' : 'warn'}` : ''),
      'data-id': t.id,
      href: ticketsHref(tv.projectId, t.id),
    },
      el('span', { class: 'c-id', text: t.id }),
      el('span', { class: 'c-title', text: t.title, title: t.title }),
      el('span', { class: 'c-own', text: ownerGlyph(t) }),
      ticketStatusCell(t, flaw),
      // BUG-126 — the cell is clamped to one line in CSS, so the full recorded
      // severity is carried on the title attribute the way .c-title does it.
      el('span', {
        class: `c-sev sev-${(t.sev || '').toLowerCase().slice(0, 3)}`,
        text: t.sev || '',
        title: t.sev || '',
      }),
      el('span', { class: 'c-when', text: t.lastActivity }));
    // Plain-left-click navigates in place; ctrl/cmd-click keeps the browser's
    // own "open in a new tab", which is the whole point of a real href.
    row.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      navTickets(tv.projectId, t.id);
    });
    if (t.matches?.length) {
      const hits = el('div', { class: 'tv-hits' });
      for (const mt of t.matches) {
        hits.append(el('div', { class: `tv-hit${mt.inActivityLog ? ' log' : ''}` },
          el('span', { class: 'ln', text: `:${mt.line}` }),
          el('span', { class: 'tx', text: mt.text })));
      }
      if (t.matchCount > t.matches.length) {
        hits.append(el('div', { class: 'tv-hit more', text: `+${t.matchCount - t.matches.length} more line(s) in this ticket` }));
      }
      tv.list.append(el('div', { class: 'tv-rowwrap' }, row, hits));
    } else {
      tv.list.append(row);
    }
  }
}

function showTicketList() {
  tv.digest.hidden = true;
  tv.detail.hidden = true;
  tv.list.hidden = false;
  tv.filters.hidden = false;
  // Keep the search box honest with the query the rows were actually loaded under
  // (a digest hop resets tv.q to ''), so it never shows text it is not applying.
  if (tv.search.value !== tv.q) tv.search.value = tv.q;
  clear(tv.detail);
  tv.current = null;
  const active = tv.list.querySelector('.tv-row.active');
  if (active) active.classList.remove('active');
}

/* FEAT-063 — tracker keyboard: ↑/↓ move a cursor row, Enter opens it. Only on
 * the LIST (never over the detail document, the modal, or any form control). */
function moveTicketCursor(delta) {
  const rows = [...tv.list.querySelectorAll('a.tv-row')];
  if (!rows.length) return;
  tv.cursor = tv.cursor < 0
    ? (delta > 0 ? 0 : rows.length - 1)
    : Math.max(0, Math.min(rows.length - 1, tv.cursor + delta));
  for (const [i, r] of rows.entries()) r.classList.toggle('kb', i === tv.cursor);
  rows[tv.cursor].scrollIntoView({ block: 'nearest' });
}
document.addEventListener('keydown', (e) => {
  if (!tv.open || tv.list.hidden || ticketModalOpen()) return;
  const t = e.target;
  const tag = t?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return;
  if (t?.classList?.contains('hsort')) return; // header cells sort on their own Enter
  if (e.key === 'ArrowDown') { e.preventDefault(); moveTicketCursor(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveTicketCursor(-1); }
  else if (e.key === 'Enter' && tv.cursor >= 0) {
    const row = tv.list.querySelectorAll('a.tv-row')[tv.cursor];
    if (row?.dataset.id) { e.preventDefault(); navTickets(tv.projectId, row.dataset.id); }
  }
});

async function loadTicketDetail(id) {
  tv.digest.hidden = true;
  tv.list.hidden = true;
  tv.filters.hidden = true;
  tv.detail.hidden = false;
  clear(tv.detail).append(el('div', { class: 'tv-empty', text: `loading ${id}…` }));
  const seq = ++tv.seq;
  try {
    const t = await api.ticket(tv.projectId, id);
    if (seq !== tv.seq) return;
    tv.current = t;
    clear(tv.detail).append(ticketDetailNode(t));
  } catch (err) {
    if (seq !== tv.seq) return;
    clear(tv.detail).append(el('div', { class: 'tv-empty' },
      el('b', { text: `Cannot open ${id}.` }), document.createTextNode(` ${err.message}`)));
  }
}

/**
 * THE REUSABLE DETAIL RENDERER. Returns a detached node for one ticket: header
 * facts, the write actions, and the ticket's REAL markdown rendered with the
 * same `prose()` renderer the transcript uses.
 *
 * Deliberately a standalone function taking a ticket payload — FEAT-053's rail
 * ticket modal is meant to call THIS rather than grow a second renderer that
 * drifts from it. `opts.compact` drops the actions for a read-only embed.
 */
function ticketDetailNode(t, opts = {}) {
  // ONE view model for both ticket formats (public/lib/ticket-record.js): a
  // migrated ticket's human layer comes off its record verbatim; a legacy one
  // carries what genuinely exists and says "Not recorded" for the rest.
  const v = ticketView(t);
  const wrap = el('div', {
    class: `tv-doc tv-banded${v.migrated ? ' is-migrated' : ' is-legacy'}`,
    'data-id': t.id, 'data-rev': t.rev,
    'data-format': v.migrated ? 'record' : 'legacy',
  });
  // Header fields that live only in the FILE (the list payload doesn't carry
  // them) — read straight out of the markdown, never invented.
  const mdField = (name) => (new RegExp(`^- \\*\\*${name}:\\*\\*\\s*(.*)$`, 'mi')
    .exec(t.markdown || '')?.[1] ?? '').trim();

  // ── top line: back link + (non-compact) the action toolbar, right-aligned ──
  const acts = opts.compact ? null : ticketActions(t, wrap);
  const top = el('div', { class: 'tv-dtop' });
  if (!opts.compact) {
    // FEAT-082 — the list moved to /all, so "all tickets" lands there (the
    // browser Back button still returns to wherever you came from — digest or list).
    const back = el('a', { class: 'tv-back', href: allTicketsHref(tv.projectId), text: '← all tickets' });
    back.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.button !== 0) return;
      e.preventDefault();
      navTickets(tv.projectId, null, { view: 'all' });
    });
    top.append(back, acts.tools);
  }
  wrap.append(top);

  // ── BAND 1: the hero — type · id, the title, and the state PILLS ─────────
  // The pills are the orthogonal state fields (work state, what it needs from a
  // human, whether it is proved) as separate values, never one prose sentence.
  // The status COLOUR language. A legacy ticket's kind is derived from the board
  // row as it always was; a migrated ticket's comes from its own enums, because
  // the server still reads the legacy prose header and a migrated ticket does not
  // have one — deriving "open" from a missing field would be inventing a state.
  const kind = v.migrated ? recordStatusKind(v) : ticketStatusKind(t);
  const flawed = !v.migrated && !!String(t.statusError ?? '').trim();
  const hero = el('div', { class: 'tv-hero' });
  hero.append(el('h1', { class: 'tv-dtitle' },
    el('span', { class: 'd-id', text: `${v.typeLabel} · ${t.id}` }),
    document.createTextNode(' '),
    // A legacy title routinely carries backticked paths; rendering the raw
    // markers in the one line a reader always reads is noise, not fidelity.
    // `v.title` only: falling through to the raw payload title is what printed a
    // fence marker as a headline. The view model has already decided what the
    // title is, including when the honest answer is that there isn't one.
    inlineInto(el('span', { class: 'd-t' }), v.title || (v.recordUnreadable ? '' : (t.title || '')))));
  hero.append(heroPills(t, v, kind));
  wrap.append(hero);

  // ── ARCH-004's notes (see below) sit here, between the hero and the human
  // band: under the facts they contradict, above everything derived from them.
  //
  // They are LEGACY-ONLY, and deliberately so. `statusError` is the verdict of
  // the server's prose-header parser, and a migrated ticket has no prose header
  // to parse — every migrated ticket would otherwise draw a permanent "MISSING
  // STATUS FIELD" error about a field the format deleted on purpose. A migrated
  // ticket's state is its `work_state` enum, which cannot be unreadable; the
  // board tools keep their own opinion about the file either way.
  //
  // …and a BROKEN RECORD is treated like a migrated ticket here, not a legacy
  // one. `statusError` is the prose-header parser's verdict, and a migrated file
  // HAS no prose header — so a corrupt-record ticket was drawing a permanent
  // "MISSING STATUS FIELD: …" error about a field its own format deleted on
  // purpose, on top of the real record error, naming the wrong defect first. The
  // record error is the true and complete explanation; this one is an artifact of
  // parsing a file the parser was never meant to read.
  const notes = (v.migrated || v.recordUnreadable) ? [] : statusFlawNotes(t);
  if (notes.length) wrap.append(el('div', { class: 'tv-flaws' }, ...notes));
  // A BROKEN record — and the note must describe what actually happened, not the
  // reassuring version. The earlier wording ("the original markdown is shown in
  // full") was false: readTicketRecord stripped the fenced block before handing
  // the body over, so the ONE text a reader needs in order to repair the file was
  // the one text the page could not show. The block's bytes now travel in
  // `v.body` verbatim and render as the first code block of the deep band, so the
  // note says where they went and how to reach them.
  if (v.parseError) {
    wrap.classList.add('is-record-error');
    wrap.append(el('div', { class: 'tv-flaws' },
      flawNote('error', 'ticket record error', [
        `${v.parseError}`,
        // A CLAIM ABOUT THE FILE, NOT ABOUT ITS HISTORY. The earlier wording said
        // "This ticket HAS been migrated", which the view cannot know: all it can
        // see is that the file BEGINS with an orchard-ticket block. A hand-written
        // ticket that opens with an example block — a ticket about the format
        // itself would — is indistinguishable, and would have been told a fact
        // about its own past that is false. So the sentence states what was
        // observed and names the one reading it cannot rule out.
        'This file BEGINS with an orchard-ticket record block, so it is read as a migrated ticket whose record is broken — not as one that was never migrated. None of the human layer below could be filled in from it. (The view can only see the file, not its history: a hand-written file that opens with an example block looks the same.)',
        'Nothing has been dropped: the file is rendered below exactly as it is on disk. The unreadable orchard-ticket block is the first code block below, under the caption that names it — verbatim, fences included.',
        // …and the one thing "verbatim" still cannot promise — stated PER CLASS.
        // The text node holds the file's bytes; what a reader cannot do is read
        // some of them correctly off the screen. An earlier round said the whole
        // flagged set "can make the order you SEE differ", which is true of a bidi
        // control and false of a NUL, a zero-width space and a line separator — it
        // pointed a reader at display order and away from the real hazard, a byte
        // they cannot see at all. So each class present gets the sentence that is
        // true of IT, and a class that is absent contributes no sentence.
        ...invisibleClaims(v.rawRecordInvisibles),
      ])));
  }

  // ── BAND 2: the human layer — what is happening, what it needs, what waiting
  // costs, and the plain facts. Always visible; never behind an expander. ─────
  //
  // NEVER RENDER A FIELD WHOSE ONLY CONTENT IS ITS OWN ABSENCE. This band used to
  // render unconditionally, so an un-migrated ticket — 182 of the 190 on the real
  // board — opened with a full-width card reading "What's happening / Not
  // recorded / What this ticket needs / Not recorded", an empty impact card
  // beside it, and a paragraph apologising for all three. That is ~45 words of
  // scaffolding occupying the most valuable space on the screen, pushing the
  // ticket's actual first sentence below the fold to say nothing. An empty band
  // is worse than no band: "Not recorded" earns its place in the dense facts
  // grid below, where a label and an empty value share one line and the reader is
  // scanning, and nowhere that costs a heading and a full-width row.
  //
  // So both cards are built conditionally and the ticket's own prose takes the
  // space. The grid's `human` and `impact` areas collapse to zero height when
  // nothing is placed in them, so the layout needs no legacy special case.
  const human = humanNarrative(v);
  if (human) wrap.append(human);
  const impact = impactCard(v);
  if (impact) wrap.append(impact);

  // The facts card. `state` + `status` stay here for a LEGACY ticket because the
  // raw board sentence is real information the pills cannot carry (and ARCH-004's
  // unreadable-state treatment lands on it). A MIGRATED ticket's state is already
  // three enum pills in the hero, so repeating it here would be exactly the
  // duplicate metadata dump this redesign exists to remove.
  const meta = el('div', { class: 'tv-dmeta' });
  const kv = (k, val, { always = false } = {}) => {
    if (!val && !always) return;
    meta.append(el('span', { class: 'kv' }, el('span', { class: 'k', text: k }),
      typeof val === 'string' || val === null || val === undefined
        ? el('span', { class: `v${val ? '' : ' v-none'}`, text: val || NOT_RECORDED })
        : val));
  };
  meta.append(el('div', { class: 'tv-facts-h', text: 'Facts' }));
  // …and NOT for a broken record: `state` here is the board index's guess and
  // `status` is the prose-header parse of a file that has no prose header. The
  // hero already stopped claiming a state for exactly that reason; repeating the
  // claim in the facts grid would put it back, in smaller type.
  if (!v.migrated && !v.recordUnreadable) {
    kv('state', el('span', { class: `v d-badge ${t.section} st-${kind}`, text: t.section === 'done' ? 'Done' : 'Open' }));
    kv('status', el('span', { class: `v d-status st-${kind}${flawed ? ' st-flaw-err' : ''}`, text: t.status || '—' }));
  }
  kv('area', v.area, { always: true });
  kv('reported', v.reported ? `${v.reported}${v.reportedBy ? ` · ${v.reportedBy}` : ''}` : null, { always: true });
  kv('owner', el('span', { class: 'v d-own' },
    el('span', { class: 'd-own-g', text: ownerGlyph(t) }),
    el('span', { class: 'd-own-t', text: v.owner ? ` ${v.owner}` : ' unassigned' })));
  kv('severity', v.severity && v.severity !== 'not_recorded'
    ? el('span', { class: `v d-sev sev-${v.severity.slice(0, 3)}`, text: v.severity })
    : null, { always: true });
  kv('updated', v.updated, { always: true });
  if (!v.migrated) kv('verified-by', mdField('Verified-by') || mdField('Verified by'));
  kv('file', el('span', { class: 'v mono', text: t.relPath || t.file }));
  wrap.append(meta);

  // ── BAND 3: the deep layer — diagnosis, evidence, proof, related code and the
  // activity log, each its own expander (never one collapsed markdown blob), and
  // ALWAYS in the DOM: the API returns the whole record regardless, so an agent
  // reading this ticket is never given the collapsed version.
  //
  // The prose is the ticket's real markdown MINUS its record block (`v.body`):
  // rendering the JSON header as a code block would put the machine layer back at
  // the top of the human's screen, which is the defect, inverted.
  //
  // THE UNPARSEABLE BLOCK IS PRINTED, NOT PARSED. An earlier round fed the WHOLE
  // file to prose() and let it draw the block as a code block. It got the bytes
  // into the model but not onto the page: prose() splits on every ``` run
  // anywhere in the text (`public/lib/dom.js`, BUG-111's char-run fence model),
  // so a record whose own human-layer text quotes an inline ``` — which a ticket
  // ABOUT fenced code legitimately does, and at least six real ones do —
  // terminated the <pre> mid-value and the info-string strip ate the next line.
  // A clean-room round measured 16 of 49 record lines still unreachable, with
  // `work_state` among them, under a note promising "verbatim, fences included".
  //
  // So the block never meets the markdown parser at all. `v.rawRecordFence` is
  // the matched region byte-for-byte, fences included, inserted as a TEXT node
  // into a real <pre>: nothing can split it, strip it or reinterpret it, and the
  // promise the note makes is one the renderer can actually keep. Only
  // `v.proseBody` — the markdown AFTER the block — goes to prose().
  const doc = prose(v.recordUnreadable ? v.proseBody : v.body, 'prose');
  if (v.recordUnreadable && v.rawRecordFence) {
    doc.prepend(el('div', { class: 'out tv-rawrec' }, el('pre', { text: v.rawRecordFence })));
    // Named in the DOM, not by a CSS ::before — a caption a screen reader cannot
    // reach is not a caption.
    doc.prepend(el('p', { class: 'tv-rawrec-cap',
      text: 'The ticket’s orchard-ticket record block, verbatim and whole — this is the text that could not be parsed.' }));
  }
  // The file's own H1 repeats the header above verbatim — mark it so the
  // stylesheet can fold it away (the bytes are still in the DOM, untouched).
  // Matched on the ID PREFIX, not on the whole line: a title carrying inline
  // markdown (BUG-104's `docs/prompts`) renders WITHOUT its backticks, so an
  // equality test against the payload's raw title silently stopped folding
  // exactly the titles most likely to be long.
  //
  // AND FOLDING IS NOW EARNED, NOT ASSUMED. `.tv-dup-title` is `display: none` —
  // the strongest elision on this page, invisible AND out of the accessibility
  // tree — and it used to fire on the ID PREFIX alone, i.e. on the strength of
  // `BUG-104 — ` matching. Everything after that dash was DISCARDED UNREAD on the
  // assumption it repeated the header. When it does not (a file whose H1 was
  // edited without the board index following, a migrated record whose `title`
  // differs from the prose H1 it was authored from) the page silently deleted a
  // line of the file while claiming to show the body whole. So the remainder is
  // now compared against the title actually printed in the hero, and only an
  // exact match is folded: a heading that says something different stays on
  // screen, because that difference is information.
  const first = doc.firstElementChild;
  const heroTitle = (wrap.querySelector('.tv-hero .d-t')?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const headText = (first && /^H\d$/.test(first.tagName))
    ? first.textContent.replace(/\s+/g, ' ').trim() : null;
  const idRe = String(t.id ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headRest = headText && idRe
    ? (new RegExp(`^${idRe}\\s*[—–-]\\s*(.*)$`).exec(headText)?.[1] ?? null) : null;
  if (headRest !== null) {
    // Compared on rendered TEXT both sides: the hero title and this heading are
    // both built through `inlineInto`, so backticks and `**` are already gone
    // from each — the comparison BUG-104 got wrong when it tested raw markdown.
    if (headRest === heroTitle) first.classList.add('tv-dup-title');
    // …and the header-fields bullet list right under it renders compact either
    // way: compacting is styling, not hiding, so it needs no such proof.
    if (first.nextElementSibling?.tagName === 'UL') first.nextElementSibling.classList.add('tv-filemeta');
  }
  sectionActivityLog(doc);
  // Each `##` section becomes its own expander, in place. A MIGRATED ticket's
  // deep prose starts collapsed (the human layer above already answered the
  // question a reader came with); a LEGACY ticket's does not, because for a
  // legacy ticket this prose IS the ticket and collapsing it would hide the only
  // content there is. The activity log is collapsed either way — it is the
  // archaeology, it is most of the bytes, and its summary states how much.
  const slots = sectionDeepSlots(doc, { openByDefault: !v.migrated });
  const md = el('div', { class: 'tv-md' });
  // The eyebrow is a DIVIDER between the human layer and the archaeology under
  // it, and it only means something when there is a human layer above it to
  // divide from. On an un-migrated ticket this prose IS the ticket, and labelling
  // it "Context for deeper review & agents" both mislabels it and re-adds the
  // scaffolding the empty band just lost — one more row between the reader and
  // the first real sentence. So it is drawn only when something precedes it.
  if (v.migrated) {
    md.append(el('div', { class: 'tv-deep-h' },
      el('span', { class: 'tv-deep-eyebrow', text: 'Context for deeper review & agents' }),
      el('span', { class: 'tv-deep-note', text: slots ? `${slots} sections` : 'no sections' })));
  }
  for (const card of deepRecordCards(v)) md.append(card);
  md.append(doc);
  wrap.append(md);

  // ── the write half, a plain FORM under the document — not a composer ──
  if (!opts.compact) wrap.append(acts.form);

  // ── FEAT-090: reply where you read it. Only on the full route detail (never
  // the compact/read-only modal — opening is not answering, BUG-025), and only
  // when the ticket actually carries a decision. "Add a note" (above) and
  // "Decide" (here) are different acts and stay separate controls. ──
  // A MIGRATED ticket carries its decision in the record, where the server's
  // prose parse cannot see it — so the live decision is "either source", and the
  // card is fed both (the record wins where they overlap).
  if (!opts.compact && (t.decision || v.decision)) {
    wrap.classList.add('has-decide');
    mountDecide(wrap, t, v);
  }
  // Historical decisions must not read as active: they are a collapsed, visibly
  // inactive record at the foot of the deep band, never beside the live one.
  if (v.decisionHistory.length) wrap.querySelector('.tv-md')?.append(decisionHistoryCard(v));
  return wrap;
}

/* ══════════════════════════ the redesigned ticket bands ═══════════════════
 *
 * docs/analysis/ticket-board-redesign-plan.md §2.7. The measured complaint the
 * redesign answers: a reader currently walks 348–1,039 words of invariant
 * statement, design archaeology and failed-patch history before being told what
 * they are being asked. The bands put that in a fixed order —
 *
 *   hero (type · id, title, state pills)
 *   human layer (what's happening / what it needs / impact of waiting / facts)
 *   the decision
 *   the deep layer, collapsed, per-section
 *
 * — so the reader can stop at the first band and an agent still receives all of
 * it. Nothing here summarises: every field is authored, quoted-with-its-source,
 * or the literal words "Not recorded".
 */

/** FEAT-066's colour language, derived from a migrated ticket's OWN enums. */
function recordStatusKind(v) {
  if (v.workState === 'done' || v.workState === 'verified') return 'done';
  if (v.humanAction && v.humanAction !== 'none') return 'needs';
  if (v.workState === 'in_progress' || v.workState === 'in_verification') return 'prog';
  return 'open';
}

/** The hero's pill row: the orthogonal state fields, one pill each. */
function heroPills(t, v, kind) {
  const pills = el('div', { class: 'tv-pills' });
  const pill = (cls, text, title) => pills.append(el('span', { class: `tv-pill ${cls}`, title: title || text, text }));

  const action = HUMAN_ACTION_LABEL[v.humanAction] ?? null;
  if (action) pill('tp-action', action, `this ticket is waiting on you: ${action.toLowerCase()}`);

  if (v.migrated) {
    const ws = WORK_STATE_LABEL[v.workState] ?? v.workState ?? NOT_RECORDED;
    pill(`tp-state st-${kind}${v.workState === 'blocked' ? ' tp-blocked' : ''}`, ws);
    // PROOF IS NEVER IMPLIED, AND NOW IT IS NEVER DERIVED EITHER (ARCH-009).
    //
    // Four pills used to be drawn here, one per value of a computed
    // `verification_state`: "Verified — holds", "Verification pending", "Proof
    // not recorded", "Verification BROKEN". Three of the four restated what the
    // work-state pill beside them already says, and the fourth — the one that
    // matters — was wrong on real tickets, because the state was folded off the
    // LAST of a set of regex-scraped verdicts. `FEAT-061` and `FEAT-062` are
    // both closed VERIFIED over an unresolved BROKEN and both painted the green
    // "Verified — holds" pill.
    //
    // So the hero draws ONE proof pill and only the loud one, from the record's
    // own attributed `verification[]` via the single rule that owns this
    // question. Everything else about proof is in the "Proof" card below, which
    // prints every verdict with its provider, run id and date — nothing is
    // hidden by dropping the badges, and nothing is claimed that a scraper
    // decided. Silence here means "no unresolved defect is recorded", which is
    // a fact about the array, not an opinion about the ticket.
    if (outstandingBroken(v.verification)) {
      pill('tp-proof tp-proof-broken', 'Verification BROKEN',
        'a recorded verification came back BROKEN and no later verdict resolved it');
    }
  } else {
    // ARCH-004's rule, carried into the hero: when the schema could not read this
    // ticket's state, the pill STOPS CLAIMING ONE. It is replaced by the server's
    // own headline, tinted brick — printing "Open" beside an error note that says
    // the state is unreadable would re-assert the very claim that failed.
    // A broken record's state genuinely cannot be read, and `t.section` is the
    // board index's opinion, not the file's — so no state pill is drawn at all
    // rather than one that says "Open" about a ticket nothing could parse. That
    // is ARCH-004's own rule: when the state is unreadable, stop claiming one.
    //
    // THIS IS LOAD-BEARING ON THE BLOCK BEING BYTE-EXACT. Declining to state a
    // work state is only honest while the reader can still READ one — and the
    // sole surviving copy of `work_state` is inside the raw record block. When
    // that block was routed through prose() it truncated at a quoted ``` run
    // before reaching `work_state`, and the page then neither stated the state
    // nor showed it: silence about a fact it had also hidden. The <pre> above is
    // a text node for this reason, and verify-ticket-view-redesign asserts
    // `work_state` is reachable on all 32 corruption variants.
    const flaw = v.recordUnreadable ? null : statusFlaw(t);
    if (v.recordUnreadable) {
      /* the "Record unreadable" pill below carries this */
    } else if (flaw?.level === 'error') {
      pills.append(el('span', { class: 'tv-pill tp-state tp-flaw-err', title: flaw.message },
        document.createTextNode(flaw.headline),
        el('span', { class: 'sr-only', text: ` — status error: ${flaw.message}` })));
    } else {
      pill(`tp-state st-${kind}${flaw ? ' has-flaw-warn' : ''}`, t.section === 'done' ? 'Done' : 'Open',
        flaw ? flaw.message : undefined);
    }
    // Same distinction as the narrative note: "Not migrated" is a claim about the
    // FILE, and it is false for a migrated ticket whose record is corrupt.
    if (v.recordUnreadable) {
      pill('tp-legacy tp-record-err', 'Record unreadable',
        'this ticket carries a structured record, but it could not be parsed — the file is shown whole below, block included');
    } else {
      pill('tp-legacy', 'Not migrated', 'this ticket predates the structured format — its human layer is derived from its prose sections');
    }
  }
  if (v.severity && v.severity !== 'not_recorded') pill(`tp-sev sev-${v.severity.slice(0, 3)}`, `${v.severity} severity`);
  else pill('tp-sev tp-none', 'Severity not recorded');
  return pills;
}

/**
 * One sentence per hazard class actually present in the raw record block, plus a
 * single closing line. Never a sentence over the union of classes: that is how a
 * NUL came to be described as something that reorders text.
 */
function invisibleClaims(runs) {
  if (!runs.length) return [];
  const byKind = new Map();
  for (const r of runs) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r]);
  const name = {
    bidi: 'bidirectional format control', separator: 'line or paragraph separator',
    zeroWidth: 'zero-width character', control: 'non-printing control character',
  };
  const out = [];
  for (const [kind, list] of byKind) {
    const n = list.reduce((a, r) => a + r.n, 0);
    out.push(`That block contains ${n} ${name[kind]}${n === 1 ? '' : 's'} — `
      + `${list.map((r) => `${r.cp}${r.n > 1 ? ` \u00d7${r.n}` : ''}`).join(', ')}. `
      + `Characters like these ${INVISIBLE_CLAIM[kind]}.`);
  }
  out.push('The text shown is byte-for-byte what is in the file; check against the file itself '
    + 'before concluding what it says.');
  return out;
}

/**
 * BAND 2 left: what's happening + what this ticket needs — or NOTHING.
 *
 * Returns null when neither field is authored, and omits either heading whose
 * own field is missing. A heading over "Not recorded" is not information; it is
 * a receipt for a field that does not exist, and it costs the reader the top of
 * their screen. The absence stays checkable elsewhere, where it is cheap: the
 * hero carries a "Not migrated" / "Record unreadable" pill, and the facts grid
 * states its own gaps one line at a time.
 *
 * The un-migrated ticket's explanatory paragraph is gone with the empty band it
 * explained. It existed to tell the reader where the content actually was; with
 * no band in the way, the content is the next thing on the page.
 */
function humanNarrative(v) {
  const hasSummary = !!(typeof v.summary === 'string' ? v.summary : v.summary?.text);
  const hasNeed = !!v.need;
  if (!hasSummary && !hasNeed) return null;
  const card = el('div', { class: 'tv-human' });
  if (hasSummary) {
    card.append(el('h2', { class: 'th-h', text: 'What\u2019s happening' }));
    card.append(fieldPara(v.summary, 'th-summary'));
  }
  if (hasNeed) {
    card.append(el('h3', { class: `th-sub${hasSummary ? '' : ' th-sub-first'}`, text: 'What this ticket needs' }));
    card.append(fieldPara(v.need, 'th-need'));
  }
  return card;
}

/**
 * One human-layer paragraph. TWO honest outcomes and no third: an authored field,
 * printed verbatim and whole, or the literal words "Not recorded". There is no
 * eliding branch here on purpose — a field that looks authored but is a machine
 * cut is the same failure this redesign exists to remove, because it teaches the
 * reader to distrust the layout.
 */
function fieldPara(field, cls) {
  const value = typeof field === 'string' ? { text: field, from: null } : field;
  if (!value?.text) return el('p', { class: `${cls} th-none`, text: NOT_RECORDED });
  // Authored prose, so it may carry inline markdown — a quoted legacy section
  // routinely does (`independent-verify.mjs`, **only**). Rendered through the
  // shared safe inline renderer, which builds DOM nodes and inserts text AS
  // TEXT, so the reader never meets a raw `*marker*` and no file content can
  // inject markup.
  return inlineInto(el('p', { class: cls }), value.text);
}

/** BAND 2 right, top: the cost of doing nothing — including its BOUND. */
function impactCard(v) {
  // …or null. A tinted, bordered card whose whole body is the words "Not
  // recorded" is a box drawn around nothing; same rule as the narrative band.
  if (!v.impact) return null;
  const card = el('div', { class: 'tv-impact' });
  card.append(el('div', { class: 'ti-h', text: 'Impact if we wait' }));
  card.append(fieldPara(v.impact, 'ti-body'));
  return card;
}

/**
 * FEAT-090 — attach the Decide affordances to a rendered ticket detail:
 *   - WIDE (≥900px): a sticky "Decide" card in the right column (grid-area decide).
 *   - NARROW (≤900px): a pinned bottom action bar; tapping opens a bottom sheet.
 * Both drive the SAME reply submit. Once answered, the card flips in place to a
 * server-confirmed read-only reading (createDecideCard's renderChosen discipline).
 */
function mountDecide(wrap, t, v = null) {
  const pid = tv.projectId;
  // The card is driven by the RECORD when the ticket has one (option cards, mode,
  // recommendation reason, prerequisite, stages) and by the server's prose parse
  // otherwise. A migrated ticket may have no prose `## Question` at all, so the
  // legacy shape is synthesised from the record rather than left null — the
  // answered-state reading and the reply pipeline both read it.
  const rich = v?.decision ?? null;
  const decision = t.decision ?? (rich && {
    question: rich.question ?? '',
    options: rich.options.map((o) => ({ key: o.key, label: o.label, description: o.what_changes ?? '' })),
    recommended: rich.recommendation ?? null,
  }) ?? null;
  // Any server-confirmed reply flips the card to its read-only reading (question.js
  // renderChosen discipline — a chosen state is shown ONLY from the server).
  const answered = t.answer || null;

  // The reply submit — rev-gated, reloads the detail on success, preserves the
  // draft on a 409 (a concurrent agent wrote the ticket while you were deciding).
  const submit = async (reply, ui) => {
    ui.sending();
    try {
      await api.ticketAnswer(pid, t.id, reply, wrap.dataset.rev);
      closeTvSheet();
      await loadTicketRows();
      const fresh = await api.ticket(pid, t.id);
      tv.current = fresh;
      clear(tv.detail).append(ticketDetailNode(fresh));
      say(reply.followup
        ? `added a follow-up to ${t.id} — still awaiting handover (no agent started)`
        : reply.kind === 'decision'
          ? `recorded to ${t.id} — awaiting handover (no agent started)`
          : `sent to ${t.id} — ownership passed to the agent`);
    } catch (err) {
      if (err.status === 409) {
        // Re-read, re-render, and restore what the user was typing/choosing.
        const fresh = await api.ticket(pid, t.id);
        tv.current = fresh;
        const node = ticketDetailNode(fresh);
        clear(tv.detail).append(node);
        const noteEl = node.querySelector('.tv-decide .dc-note');
        if (noteEl) noteEl.value = reply.note || '';
        if (reply.chose) {
          const radio = node.querySelector(`.tv-decide .dc-opt input[value="${reply.chose.key}"]`);
          if (radio) { radio.checked = true; radio.dispatchEvent(new Event('change')); }
        }
        say(`${t.id} changed on disk while you were deciding (an agent may be writing to it) — nothing was written; your draft is kept, re-read and retry.`, true);
      } else {
        ui.failed(err.message);
        say(`could not record your reply to ${t.id}: ${err.message}`, true);
      }
    }
  };

  // The card lives in the right column on wide screens (grid-area decide).
  const wideWrap = el('div', { class: 'tv-decide-wrap' });
  wideWrap.append(createDecideCard({ decision, rich, answered, onSubmit: submit }).node);
  // READING ORDER, not just grid position. The wide layout puts this card in the
  // right column either way, but the DOM order is what a narrow screen, a screen
  // reader and Tab all follow — and it is the thing the redesign is measured on:
  // "how many words does a reader pass before they are told what they are being
  // asked". Behind the deep band that number is the whole ticket. So the card is
  // INSERTED directly after the narrative and the impact card, ahead of both the
  // facts card and the deep band — the facts are reference material a reader
  // consults, never a queue they have to clear to reach the question.
  const anchor = wrap.querySelector(':scope > .tv-dmeta') ?? wrap.querySelector(':scope > .tv-md');
  if (anchor) anchor.before(wideWrap); else wrap.append(wideWrap);

  // The narrow pinned bar — only while the decision is UNANSWERED (an answered
  // ticket has nothing to reply to at every scroll position). Tapping opens a
  // bottom sheet holding a fresh Decide card over the SAME submit.
  if (!answered) {
    const rec = (rich?.recommendation ?? decision?.recommended)
      ? `Recommends ${rich?.recommendation ?? decision.recommended}`
      : 'Decision needed';
    const bar = el('div', { class: 'tv-decide-bar' },
      el('span', { class: 'tdb-rec', text: rec }),
      el('button', { class: 'tdb-open solid', type: 'button', text: 'Answer' }));
    bar.querySelector('.tdb-open').addEventListener('click', () => openTvSheet({ ...t, decision }, submit, rich));
    wrap.append(bar);
  }
}

/* ── FEAT-090 — the narrow-screen reply sheet (a .tmodal variant: same Esc
   ladder, same backdrop, rounded top, body scrolls). ── */
let tvSheetEl = null;
function tvSheetOpen() { return !!tvSheetEl; }
function closeTvSheet() {
  if (!tvSheetEl) return;
  tvSheetEl.remove();
  tvSheetEl = null;
}
function openTvSheet(t, submit, rich = null) {
  closeTvSheet();
  const card = createDecideCard({ decision: t.decision, rich, answered: null, onSubmit: submit }).node;
  const box = el('div', { class: 'tv-sheet-box' },
    el('button', { class: 'ic tv-sheet-x', type: 'button', 'aria-label': 'Close', text: '✕' }),
    el('div', { class: 'tv-sheet-body' }, card));
  const back = el('div', { class: 'tv-sheet-back' });
  tvSheetEl = el('div', { class: 'tv-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Answer decision' }, back, box);
  back.addEventListener('click', closeTvSheet);
  box.querySelector('.tv-sheet-x').addEventListener('click', closeTvSheet);
  document.body.append(tvSheetEl);
}

/**
 * FEAT-063: the Activity log renders SECTIONED — each dated entry becomes a
 * bordered block whose date-heading is the block header. Pure DOM re-parenting
 * of prose() output: every node survives verbatim, nothing is rewritten.
 */
function sectionActivityLog(doc) {
  const heads = [...doc.querySelectorAll('h3, h4, h5, h6')];
  const logHead = heads.find((h) => /^activity log/i.test(h.textContent.trim()));
  if (!logHead) return;
  logHead.classList.add('tv-log-h');
  const logLevel = Number(logHead.tagName[1]);
  const entryLevel = logLevel + 1; // "### date — author" renders one level below
  const section = el('div', { class: 'tv-log' });
  logHead.after(section);
  let entry = null;
  while (section.nextSibling) {
    const n = section.nextSibling;
    const lvl = /^H\d$/.test(n.tagName ?? '') ? Number(n.tagName[1]) : 99;
    if (lvl <= logLevel) break; // a new top-level section ends the log
    if (lvl === entryLevel) {
      entry = el('div', { class: 'tv-logent' });
      section.append(entry);
      n.classList.add('tv-logent-h');
    }
    (entry ?? section).append(n); // append() MOVES the live node
  }
}

/**
 * Turn every `##` section of the rendered ticket body into its own expander, IN
 * PLACE. Pure DOM re-parenting of prose() output, exactly like sectionActivityLog:
 * every node survives verbatim, nothing is rewritten, and the section's own
 * heading element is MOVED INTO the <summary> rather than replaced — so it stays
 * a real heading in the accessibility tree and in every `.tv-md .prose h4` query.
 *
 * (prose() renders `#`→h3, `##`→h4, `###`→h5, so a ticket's top-level sections
 * are h4 here. sectionActivityLog must run first: it has already folded the log's
 * dated entries into .tv-log, which then travels into the log's own expander.)
 */
function sectionDeepSlots(doc, { openByDefault = false } = {}) {
  const groups = [];
  let cur = null;
  for (const n of [...doc.children]) {
    if (n.tagName === 'H4') { cur = { head: n, nodes: [] }; groups.push(cur); }
    else if (cur) cur.nodes.push(n);
  }
  for (const g of groups) {
    const title = g.head.textContent.trim();
    const isLog = /^activity log/i.test(title);
    const box = el('details', { class: `tv-slot${isLog ? ' tv-slot-log' : ''}` });
    if (openByDefault && !isLog) box.open = true;
    const entries = isLog
      ? g.nodes.reduce((n, x) => n + (x.classList?.contains('tv-log') ? x.querySelectorAll('.tv-logent').length : 0), 0)
      : 0;
    const sum = el('summary', { class: 'tv-slot-h' });
    g.head.replaceWith(box);          // the details takes the heading's place…
    g.head.classList.add('tv-slot-t');
    sum.append(g.head);               // …and the heading moves inside its summary
    if (isLog) sum.append(el('span', { class: 'tv-slot-n', text: entries ? `${entries} entries` : 'appended' }));
    box.append(sum);
    const body = el('div', { class: 'tv-slot-b' });
    for (const n of g.nodes) body.append(n);   // append() MOVES the live node
    box.append(body);
  }
  return groups.length;
}

/**
 * The MIGRATED record's structured deep fields, as their own expanders. These do
 * not exist in the markdown body at all — an agent reads them off the API, and
 * this is where a human can too. Every one of them prints "Not recorded" rather
 * than rendering nothing, because a claim of absence is checkable and silence is
 * not (the plan's §2.7 rule, and the reason `verification[]` exists).
 *
 * An EMPTY slot is that claim and nothing else, so it is drawn as one flat row —
 * the label and the words "Not recorded" on a single line, the dense-grid form
 * the rule allows — and NOT as a disclosure. A triangle that opens onto a
 * paragraph restating the summary line is the empty-band defect in miniature: it
 * advertises content to the reader, to Tab and to a screen reader, and delivers
 * a second copy of the absence.
 */
function deepRecordCards(v) {
  if (!v.migrated) return [];
  const out = [];
  const slot = (title, n, build, { empty = false } = {}) => {
    const head = [el('h4', { class: 'tv-slot-t ph', text: title }),
      el('span', { class: 'tv-slot-n', text: n })];
    if (empty) {
      out.push(el('div', { class: 'tv-slot tv-slot-rec tv-slot-flat' },
        el('div', { class: 'tv-slot-h' }, ...head)));
      return;
    }
    const box = el('details', { class: 'tv-slot tv-slot-rec' });
    box.append(el('summary', { class: 'tv-slot-h' }, ...head),
      el('div', { class: 'tv-slot-b' }, build()));
    out.push(box);
  };

  slot('Proof', v.verification.length ? `${v.verification.length} recorded` : NOT_RECORDED, () => {
    const b = el('div', { class: 'tvr-proof' });
    for (const e of v.verification) {
      b.append(el('div', { class: `tvr-run verdict-${String(e?.verdict || '').toLowerCase()}` },
        el('span', { class: 'tvr-verdict', text: String(e?.verdict || NOT_RECORDED).toUpperCase() }),
        el('span', { class: 'tvr-prov', text: `${e?.provider ?? NOT_RECORDED}${e?.model ? ` · ${e.model}` : ''}` }),
        el('span', { class: 'tvr-run-id mono', text: e?.run_id ?? NOT_RECORDED }),
        e?.verdict_on ? el('span', { class: 'tvr-on', text: e.verdict_on }) : null,
        e?.commit ? el('span', { class: 'tvr-commit mono', text: e.commit }) : null));
    }
    return b;
  }, { empty: !v.verification.length });

  // The schema's DEFAULT for success_criteria is the one-item list `["Not
  // recorded"]`, so an unfilled field arrives wearing a count of 1 and rendered
  // as a bullet reading "Not recorded". That is the same absence, disguised as
  // content — it is filtered here rather than counted.
  const criteria = v.successCriteria.filter((c) => String(c ?? '').trim()
    && String(c).trim().toLowerCase() !== NOT_RECORDED.toLowerCase());
  slot('Success criteria', criteria.length ? `${criteria.length}` : NOT_RECORDED, () => {
    const ul = el('ul', { class: 'tvr-list' });
    for (const c of criteria) ul.append(el('li', { text: String(c) }));
    return ul;
  }, { empty: !criteria.length });

  slot('Related code', v.codeRefs.length ? `${v.codeRefs.length} paths` : NOT_RECORDED, () => {
    const ul = el('ul', { class: 'tvr-list tvr-refs' });
    for (const c of v.codeRefs) {
      ul.append(el('li', {},
        el('span', { class: 'mono', text: String(c?.path ?? '') }),
        c?.symbol ? el('span', { class: 'tvr-sym mono', text: ` ${c.symbol}` }) : null,
        c?.note ? el('span', { class: 'tvr-note', text: ` — ${c.note}` }) : null));
    }
    return ul;
  }, { empty: !v.codeRefs.length });

  const relCount = v.related.length + v.recurrence.length;
  slot('Related tickets', relCount ? `${relCount}` : NOT_RECORDED, () => {
    const ul = el('ul', { class: 'tvr-list' });
    for (const r of v.related) {
      ul.append(el('li', {},
        el('span', { class: 'tvr-rel', text: String(r?.relation ?? '') }),
        el('a', { class: 'tvr-id', href: ticketsHref(tv.projectId, r?.id), text: String(r?.id ?? '') })));
    }
    for (const id of v.recurrence) {
      ul.append(el('li', {},
        el('span', { class: 'tvr-rel', text: 'recurrence evidence' }),
        el('a', { class: 'tvr-id', href: ticketsHref(tv.projectId, id), text: String(id) })));
    }
    return ul;
  }, { empty: !relCount });

  if (v.source && (v.source.confirmation || v.source.archived_path || (v.source.dropped ?? []).length)) {
    slot('Provenance', v.source.archived_path ? 'archived original' : 'migration record', () => {
      const b = el('div', { class: 'tvr-src' });
      if (v.source.original_title) b.append(el('p', {}, el('b', { text: 'Original title: ' }), document.createTextNode(v.source.original_title)));
      if (v.source.archived_path) b.append(el('p', {}, el('b', { text: 'Archived at: ' }), el('span', { class: 'mono', text: v.source.archived_path })));
      if (v.source.sha256) b.append(el('p', {}, el('b', { text: 'sha256: ' }), el('span', { class: 'mono', text: String(v.source.sha256) })));
      b.append(el('p', {}, el('b', { text: 'The migration’s own statement: ' }),
        document.createTextNode(v.source.confirmation || NOT_RECORDED)));
      const dropped = Array.isArray(v.source.dropped) ? v.source.dropped : [];
      b.append(el('p', {}, el('b', { text: 'Deliberately left behind: ' }),
        document.createTextNode(dropped.length ? dropped.join('; ') : 'nothing')));
      return b;
    });
  }
  return out;
}

/**
 * Past decisions, collapsed and visibly INACTIVE. This is the direct fix for the
 * failure mode where an answered older design question still reads as open next
 * to a log full of implementation: a ticket has at most one live decision, and
 * everything else is history, drawn like history.
 */
function decisionHistoryCard(v) {
  const box = el('details', { class: 'tv-slot tv-slot-hist' });
  box.append(el('summary', { class: 'tv-slot-h' },
    el('h4', { class: 'tv-slot-t ph', text: 'Decisions already made' }),
    el('span', { class: 'tv-slot-n', text: `${v.decisionHistory.length} · settled` })));
  const body = el('div', { class: 'tv-slot-b' });
  for (const h of v.decisionHistory) {
    const item = el('div', { class: 'tvh-item' });
    item.append(el('div', { class: 'tvh-q', text: String(h?.question ?? NOT_RECORDED) }));
    item.append(el('div', { class: 'tvh-a' },
      el('span', { class: 'tvh-chosen', text: h?.chosen ? `chose ${h.chosen}` : 'no option recorded' }),
      el('span', { class: 'tvh-when', text: h?.chosen_on ? `on ${h.chosen_on}` : (h?.asked_on ? `asked ${h.asked_on}` : NOT_RECORDED) }),
      h?.chosen_by ? el('span', { class: 'tvh-by', text: `by ${h.chosen_by}` }) : null));
    if (h?.note) item.append(el('div', { class: 'tvh-note', text: String(h.note) }));
    body.append(item);
  }
  box.append(body);
  return box;
}

/**
 * The write half: note, reopen, 👤 flag. Every one of them is append-only or
 * logged. FEAT-063 split the PRESENTATION in two — `tools` (reopen + 👤 flag)
 * is a small right-aligned toolbar in the document header, `form` (the note
 * field + Append) is a plain form under the Activity log, deliberately NOT
 * shaped like the session composer. Both carry .tv-acts so the compact/modal
 * embed excludes every write control at once.
 */
function ticketActions(t, wrap) {
  const pid = tv.projectId;
  const msg = el('div', { class: 'tv-msg', hidden: true });

  const noteInput = el('textarea', {
    class: 'tv-note', rows: '3', 'aria-label': `Add a note to ${t.id}`,
    placeholder: `Add a note — appended to the Activity log, dated and attributed to you. Agents read this.`,
  });
  const noteBtn = el('button', { class: 'tv-btn solid', id: 'tvNoteBtn', type: 'button', text: 'Append note' });
  const reopenBtn = el('button', { class: 'tv-btn', id: 'tvReopenBtn', type: 'button', text: 'Reopen' });
  const flagBtn = el('button', {
    class: 'tv-btn', id: 'tvFlagBtn', type: 'button',
    text: t.needsYou ? 'Clear 👤' : 'Mark 👤',
    title: t.needsYou ? 'Clear needs-you (drops it off the rail)' : 'Mark needs-you (surfaces it on the rail)',
  });

  const show = (text, kind) => {
    msg.hidden = false;
    msg.className = `tv-msg ${kind}`;
    msg.textContent = text;
  };
  /* A write that lands, or a conflict that is stated rather than swallowed. */
  const afterWrite = async (r, what) => {
    if (r.board && r.board.fails?.length) {
      show(`${what}, but the board is now in drift: ${r.board.fails.join(' | ')}`, 'err');
    } else if (r.board && r.board.error) {
      show(`${what}, but INDEX.md could not be reconciled: ${r.board.error}`, 'err');
    } else {
      show(`${what} — board reconciled, board:check green.`, 'ok');
    }
    await loadTicketRows();
    const fresh = await api.ticket(pid, t.id);
    tv.current = fresh;
    const node = ticketDetailNode(fresh);
    node.querySelector('.tv-msg')?.replaceWith(msg);
    clear(tv.detail).append(node);
  };
  const onConflict = async (err, draft) => {
    if (err.status !== 409) { show(err.message, 'err'); return; }
    show('This ticket changed on disk while you were typing (an agent may be writing to it) — '
      + 'nothing was written. It has been reloaded below; your text is kept, re-read and retry.', 'err');
    const fresh = await api.ticket(pid, t.id);
    tv.current = fresh;
    const node = ticketDetailNode(fresh);
    node.querySelector('.tv-note').value = draft;
    clear(tv.detail).append(node);
    node.querySelector('.tv-msg')?.replaceWith(msg);
    node.querySelector('.tv-note').focus();
  };

  noteBtn.addEventListener('click', async () => {
    const text = noteInput.value.trim();
    if (!text) { noteInput.focus(); return; }
    noteBtn.disabled = true;
    try {
      const r = await api.ticketNote(pid, t.id, text, wrap.dataset.rev);
      await afterWrite(r, `note appended to ${t.id}`);
    } catch (err) {
      await onConflict(err, text);
    } finally { noteBtn.disabled = false; }
  });

  reopenBtn.disabled = t.section !== 'done';
  reopenBtn.title = t.section === 'done'
    ? 'Flip the Status header back to OPEN, log why, and let the board tool move the row'
    : 'This ticket is already open';
  reopenBtn.addEventListener('click', async () => {
    const reason = noteInput.value.trim();
    if (!reason) {
      show('Reopening records WHY in the ticket — write the reason in the note field first.', 'err');
      noteInput.focus();
      return;
    }
    reopenBtn.disabled = true;
    try {
      const r = await api.ticketReopen(pid, t.id, reason, wrap.dataset.rev);
      await afterWrite(r, `${t.id} reopened`);
    } catch (err) {
      await onConflict(err, reason);
    } finally { reopenBtn.disabled = false; }
  });

  flagBtn.addEventListener('click', async () => {
    flagBtn.disabled = true;
    try {
      const r = await api.ticketOwner(pid, t.id, !t.needsYou);
      await afterWrite(r, r.owner === '👤' ? `${t.id} marked 👤 — it is on the rail now` : `${t.id} unflagged`);
    } catch (err) {
      show(err.message, 'err');
    } finally { flagBtn.disabled = false; }
  });

  const tools = el('div', { class: 'tv-acts tv-tools' }, reopenBtn, flagBtn);
  const form = el('div', { class: 'tv-acts tv-noteform' },
    el('div', { class: 'tv-form-h', text: 'Add to the Activity log' }),
    noteInput,
    el('div', { class: 'tv-actrow' }, msg, noteBtn));
  return { tools, form };
}

/* ------------------------------------------------------------ file a ticket */

function openNewTicketForm() {
  tv.digest.hidden = true;
  tv.list.hidden = true;
  tv.filters.hidden = true;
  tv.detail.hidden = false;
  const prefix = el('select', { class: 'tv-sel' },
    ...['BUG', 'FEAT', 'ARCH', 'DEPLOY'].map((p) => el('option', { value: p, text: p })));
  const title = el('input', { class: 'tv-in', type: 'text', placeholder: 'Short title', 'aria-label': 'Ticket title' });
  const sev = el('select', { class: 'tv-sel' },
    ...['med', 'high', 'low'].map((s) => el('option', { value: s, text: s })));
  const area = el('input', { class: 'tv-in', type: 'text', placeholder: 'Area (server / UI / …)', 'aria-label': 'Area' });
  const summary = el('textarea', { class: 'tv-note', rows: '4', placeholder: 'What you saw / what you want. Verbatim is best.', 'aria-label': 'Summary' });
  const flag = el('input', { type: 'checkbox', id: 'tvNewFlag' });
  const msg = el('div', { class: 'tv-msg', hidden: true });
  const file = el('button', { class: 'tv-btn solid', id: 'tvFileBtn', type: 'button', text: 'File it' });
  const cancel = el('button', { class: 'tv-btn', type: 'button', text: 'Cancel' });
  cancel.addEventListener('click', () => navTickets(tv.projectId, null));
  file.addEventListener('click', async () => {
    if (!title.value.trim()) { title.focus(); return; }
    file.disabled = true;
    try {
      const r = await api.ticketCreate(tv.projectId, {
        prefix: prefix.value, title: title.value.trim(), severity: sev.value,
        area: area.value.trim(), summary: summary.value.trim(), needsYou: flag.checked,
      });
      await loadTicketRows();
      navTickets(tv.projectId, r.id);
      say(`filed ${r.id}`);
    } catch (err) {
      msg.hidden = false;
      msg.className = 'tv-msg err';
      msg.textContent = err.message;
      file.disabled = false;
    }
  });
  clear(tv.detail).append(el('div', { class: 'tv-doc tv-new' },
    el('h1', { class: 'tv-dtitle', text: 'File a ticket' }),
    el('p', { class: 'tv-dsub', text: 'Written from this project’s TEMPLATE.md (TEMPLATE-ARCH.md for ARCH). The id is allocated by the board tool’s rule — max existing + 1, never reused.' }),
    el('div', { class: 'tv-newrow' }, prefix, title),
    el('div', { class: 'tv-newrow' }, sev, area),
    summary,
    el('label', { class: 'tv-check' }, flag, el('span', { text: ' mark 👤 needs-you (surfaces it on the rail)' })),
    el('div', { class: 'tv-actrow' }, file, cancel),
    msg));
}

/* --------------------------------------------------------------- wiring */

// A project switch stays in the current view (the full list stays the full list,
// the digest stays the digest) rather than always dumping the user on the digest.
tv.project.addEventListener('change', () => navTickets(tv.project.value, null, { view: tv.view === 'all' ? 'all' : 'digest' }));
// FEAT-082 — the persistent "All tickets" control: in-place nav to the full list.
tv.allBtn.addEventListener('click', (e) => {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navTickets(tv.projectId, null, { view: 'all' });
});
tv.search.addEventListener('input', () => {
  clearTimeout(tv.searchTimer);
  tv.searchTimer = setTimeout(() => {
    tv.q = tv.search.value.trim();
    void loadTicketRows().then(() => { if (!tv.ticketId) showTicketList(); });
  }, 180);
});
tv.search.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  clearTimeout(tv.searchTimer);
  tv.q = tv.search.value.trim();
  if (tv.ticketId) navTickets(tv.projectId, null);
  else void loadTicketRows();
});
for (const sel of [tv.status, tv.owner, tv.sev]) sel.addEventListener('change', renderTicketRows);
tv.newBtn.addEventListener('click', openNewTicketForm);
tv.home.addEventListener('click', () => { hideTickets(); });

let gitReturnHash = '#/';

async function showGit(route) {
  const entering = !gitView.isOpen();
  if (entering) {
    const back = currentRoute();
    gitReturnHash = back ? formatHash(back) : '#/';
  }
  const projectId = route.projectId || state.current.projectId || state.projects[0]?.id || null;
  document.title = 'Git — Orchard';
  await gitView.open({ projectId, view: route.view || 'changes' }, gitReturnHash);
}

function hideGit() {
  if (!gitView.isOpen()) return;
  gitView.close();
  paintTitle();
}

function navGit(projectId, { replace = false, view = 'changes' } = {}) {
  if (!projectId) return;
  const href = formatGitHash({ projectId, view });
  if (replace) window.history.replaceState(null, '', href);
  else window.history.pushState(null, '', href);
  void showGit({ projectId, view });
}

/**
 * A hash typed by hand, a link opened in a second tab, or Back/Forward — all
 * three land here. `popstate` alone would miss the first two.
 */
function onHashRoute() {
  // Guide, tickets and Git are mutually exclusive sibling overlays. Resolve
  // each before the session parser and always drop the other two.
  const g = parseGuideHash(location.hash);
  if (g) { hideTickets(); hideGit(); void showGuide(g); return true; }
  hideGuide();
  const t = parseTicketsHash(location.hash);
  if (t) { hideGit(); void showTickets(t); return true; }
  hideTickets();
  const git = parseGitHash(location.hash);
  if (git) { void showGit(git); return true; }
  hideGit();
  return false;
}
window.addEventListener('hashchange', onHashRoute);

/* ------------------------------------------------------------------- boot */

/* -------------------------------------------------------------- url state */
/*
 * The URL is a mirror of {project, session, dir, top-visible message, agent
 * thread}, and the ONLY navigation state that survives a reload. Discipline:
 * push when opening a different session or project (a place Back should
 * return to), replace for scroll drift and thread switches (which must not
 * spam history). See lib/route.js for why hash and what the fields mean.
 */

const nav = { applying: false, scrollTimer: null };

function currentRoute() {
  const { projectId, sessionId, encodedDir } = state.current;
  if (!projectId) return null;
  if (!sessionId) return { projectId };
  const th = mainThread();
  const agent = state.viewing !== 'main' ? state.viewing : null;
  // At the bottom, the URL says nothing about position: a reload should land
  // where a fresh open lands — the newest page. Parked anywhere else (scrolled
  // up, or a restore still owing newer messages), remember the top message.
  // While an agent pane covers the main pane its geometry is unreadable, so
  // the last written `i` is carried forward instead of recomputed.
  let i = null;
  if (state.viewing === 'main') {
    if (th.stick === false || th.gap) i = topVisibleIndex(th);
  } else {
    const prev = parseHash(location.hash);
    if (prev?.sessionId === sessionId) i = prev.i;
  }
  return { projectId, sessionId, dir: encodedDir ?? null, i, agent };
}

function syncUrl(mode = 'replace') {
  if (nav.applying) return; // navigation is being driven BY the URL right now
  const r = currentRoute();
  if (!r) return;
  const prev = parseHash(location.hash);
  if (sameRoute(prev, r)) return;
  const hash = formatHash(r);
  const newPlace = !prev || prev.projectId !== r.projectId || prev.sessionId !== (r.sessionId ?? null);
  if (mode === 'push' && newPlace) window.history.pushState(null, '', hash);
  else window.history.replaceState(null, '', hash);
  paintTitle();
}

/**
 * The tab title is the multi-tab dashboard's cheapest signal: which session
 * this is, and — via the leading dot — whether Claude is working in it right
 * now, readable from a squeezed tab strip without switching.
 */
function paintTitle() {
  const name = state.current.title;
  document.title = `${state.busy ? '● ' : ''}${name ? `${name} — Claude Station` : 'Claude Station'}`;
}

/** Trailing-debounced replace — scroll fires far too often to write through. */
function syncUrlSoon() {
  clearTimeout(nav.scrollTimer);
  nav.scrollTimer = setTimeout(() => syncUrl('replace'), 400);
}

/**
 * Drive the view to what a route names. Returns false ONLY when the project
 * id is unknown (caller falls back to the default view); every other outcome
 * — including a session that is not there — leaves a deliberate, honest view
 * behind and returns true. A missing session must NOT silently become a new
 * session: that silence was the original bug.
 */
async function applyRoute(route) {
  if (!route) return false;
  const p = state.projects.find((x) => x.id === route.projectId);
  if (!p) return false;
  nav.applying = true;
  try {
    state.expanded.add(p.id);
    saveExpanded();
    if (!route.sessionId) {
      startNew(p.id);
      return true;
    }
    const s = await loadSessions(p.id);
    const matches = (s.list ?? []).filter((x) => x.sessionId === route.sessionId);
    const sess = route.dir
      ? matches.find((x) => x.encodedDir === route.dir)
      : (matches.length === 1 ? matches[0] : null);
    if (!sess) {
      selectProject(p.id, { quiet: true });
      state.current = { projectId: p.id, encodedDir: null, sessionId: null, title: null, os: null };
      followCurrent(false);
      clearPendingDelivery(); // BUG-079: a link that resolves to no session is still a boundary
      closeSocket();
      resetTranscript();
      renderTree();
      const why = matches.length > 1
        ? ` The id ${route.sessionId.slice(0, 8)}… exists in ${matches.length} history folders and the link does not say which (no dir=) — open it from the sidebar instead.`
        : ` No session ${route.sessionId.slice(0, 8)}… under “${p.name}”. It may have been deleted, or the link may be wrong.`;
      mainThread().paneEl.append(el('div', { class: 'hint-row' },
        el('b', { text: 'This link points to a session that is not here.' }),
        document.createTextNode(why)));
      say('session in the URL not found', true);
      window.history.replaceState(null, '', formatHash({ projectId: p.id }));
      return true;
    }
    await openSession(p, sess, { at: route.i, agent: route.agent });
    return true;
  } finally {
    nav.applying = false;
  }
}

window.addEventListener('popstate', () => {
  // FEAT-058: the ticket dashboard is a sibling route — Back/Forward across it
  // must be handled BEFORE the session route parser, which would read a
  // `#/tickets…` hash as "no route" and leave the overlay stranded.
  // FEAT-075: the guide overlay is a sibling route — handle Back/Forward across
  // it before the session parser, which would read `#/guide…` as "no route".
  if (location.hash.startsWith('#/guide')) {
    hideTickets();
    hideGit();
    void showGuide(parseGuideHash(location.hash) ?? {});
    return;
  }
  hideGuide();
  if (location.hash.startsWith('#/tickets')) {
    hideGit();
    void showTickets(parseTicketsHash(location.hash) ?? {});
    return;
  }
  hideTickets();
  if (location.hash.startsWith('#/git')) {
    void showGit(parseGitHash(location.hash) ?? {});
    return;
  }
  hideGit();
  const r = parseHash(location.hash);
  if (!r) return;
  const cur = currentRoute();
  // Within the same session only position/thread changed — move in place
  // rather than re-opening (a re-open would reset scroll AND cost a fetch).
  if (cur && r.projectId === cur.projectId && r.sessionId && r.sessionId === cur.sessionId) {
    nav.applying = true;
    try {
      const th = mainThread();
      if ((r.agent ?? null) !== (cur.agent ?? null)) {
        if (r.agent && state.threads.has(r.agent)) void viewAgent(r.agent);
        else if (!r.agent) backToMain();
      } else if (Number.isInteger(r.i)) {
        scrollToIndex(th, r.i);
      } else if (!th.gap) {
        scrollToBottom(th);
      }
    } finally { nav.applying = false; }
    return;
  }
  void applyRoute(r);
});

async function boot() {
  try {
    await loadProjects();
  } catch (err) {
    node.tree.append(el('div', { class: 'hint-row', text: `the server is not answering: ${err.message}` }));
    return say(err.message, true);
  }
  renderRail(); // paint the quiet empty rail immediately; refreshRail fills it per project
  await drawer.ensureTemplates();
  node.libCount.textContent = String(drawer.templates().length);
  loadExpanded(); // the user's working set of open projects survives reloads
  loadSeen();
  // A project restored as expanded must get its list NOW — without this its
  // kids sit empty until the background sweep happens to reach it.
  for (const id of state.expanded) if (state.projects.some((p) => p.id === id)) void loadSessions(id);
  if (state.projects.length) {
    // The URL is the first authority on what to show: a reload or a shared
    // link lands back on ITS session, not on a fresh default view.
    const route = parseHash(location.hash);
    const restored = route ? await applyRoute(route) : false;
    if (!restored) {
      const first = state.projects[0];
      state.expanded.add(first.id);
      selectProject(first.id, { quiet: true });
      state.current.title = null;
      paintCrown();
      renderTree();
      await loadSessions(first.id);
      if (route) {
        // A route existed but named a project this registry does not have —
        // say so instead of quietly showing something else.
        mainThread().paneEl.append(el('div', { class: 'hint-row' },
          el('b', { text: 'This link points to a project that is not registered here' }),
          document.createTextNode(` (${route.projectId}). Showing your projects instead.`)));
        say('project in the URL not found', true);
        window.history.replaceState(null, '', location.pathname);
      }
    }
  } else {
    renderTree();
    say('No projects registered yet.');
  }
  // Follow sessions other processes are writing, and mark them in the sidebar.
  // Both degrade to nothing if the server half is not there: the watch socket
  // simply never receives `session-appended`, and the live route 404s once and
  // is never asked again.
  watch();
  startLivePolling();
  startProcPolling();
  // BUG-034: the strip's correcting poll, and FEAT-057's death ledger — both
  // are server-authored and both must be right on a FRESH LOAD with no socket
  // and no orchestrator turn, so they are fetched at boot, not on first event.
  startRunningPolling();
  void pollRunning();
  void refreshOutcomes();
  // The server remembers the last slash-command list any session reported —
  // so "/" works in a fresh browser profile, before this browser's first
  // session-init. localStorage stays as the offline fallback.
  void api.slashCommands().then((cmds) => {
    if (Array.isArray(cmds) && cmds.length) {
      state.slashCommands = cmds;
      try { localStorage.setItem('cs-slash', JSON.stringify(cmds)); } catch { /* volatile */ }
    }
  }).catch(() => { /* route absent or transient — cache already loaded */ });
  // Same for models: the CLI's names carry the versions the picker must show.
  void api.models().then(adoptModelList).catch(() => { /* fallback list stands */ });
  // Background-load every project's session list: the unseen badges and
  // per-project live dots need the lists to say anything about COLLAPSED
  // projects, and the search index warms for free. Fire-and-forget — the
  // first paint above never waits on it.
  void loadAllSessions();
  paintSessStatus();
  // FEAT-058: a tab opened straight on `#/tickets…` (a second tab, a bookmark,
  // a link the orchestrator handed over) shows the dashboard over the normal
  // boot — the session view underneath stays fully alive, which is what makes
  // the "read a ticket in one tab, talk to the orchestrator in the other"
  // workflow work.
  if (location.hash.startsWith('#/tickets') || location.hash.startsWith('#/guide') || location.hash.startsWith('#/git')) onHashRoute();
  window.__station = {
    state, drawer, api, loadSessions, renderTree, onEvent, startTurn, viewAgent, showThread,
    // BUG-100: footer (#fine) internals, so a verify script can drive the real
    // status/turn-end paths and assert the isolation label is never displaced by
    // raw command text and that every item stays within the hard length cap.
    isoLabel, restLabel, runningAgentCount, truncFine, MAX_FINE, currentProject,
    backToMain, applyAppend, refreshLive, menu, visibleSessions, rowTitle,
    // FEAT-070: project ordering + session recency-window internals, so a verify
    // script can drive the sort/toggle and the window without re-deriving them.
    orderedProjects, resortProjects, toggleProjSort, paintProjSort,
    withinRecentWindow, isAlwaysVisible, isAttentionSession, RECENT_WINDOW_DAYS,
    // BUG-067: the transcript renderer + its main-thread accessor, exposed so a
    // verify script can render a fixture transcript and assert on which entries
    // become user bubbles vs collapsed system notices.
    renderMessages, mainThread, harnessNotice, stampTime,
    // FEAT-083: the structured response-digest renderer + its enable check, so a
    // verify script can render the four fixtures (well-formed / none / malformed
    // / disabled) through the real render path and assert on the resulting DOM.
    assistantProse, digestEnabled,
    // FEAT-072: the queued-metadata detector, exposed so a verify script can
    // assert the prefix/body split (and non-matching brackets) directly.
    queuedCaption,
    // BUG-081: the model-change/refusal-fallback notice render site + its live
    // SSE entry point, exposed so a verify script can drive the authentic
    // dispatch and assert the notice renders as a distinct accented chip.
    flagModelChange, modelChangeMark,
    // Override-lifecycle internals, exposed read-only-in-spirit for verify scripts
    // (e.g. scripts/verify-new-session-overrides.mjs) to arm/inspect session
    // overrides the same way the model popover and skip-perms toggle do.
    persistOverrides, paintModelBtn, paintModelPop, sessionOverrides,
    refreshRail, renderRail,
    // BUG-139: the crown git chip's painter, so a verify script can assert the
    // EXACT rendered text for status payloads the live server cannot easily be
    // made to produce — chiefly a STALE server whose response predates the
    // added/removed fields entirely, which is what rendered "+undefined".
    paintGitChip,
    // FEAT-058: the ticket dashboard's internals, so a verify script can drive
    // the route and assert on what it rendered without re-deriving the rules.
    // `ticketDetailNode` is the REUSABLE renderer FEAT-053's modal should call.
    tv, showTickets, navTickets, loadTicketRows, ticketDetailNode,
    // The redesign (docs/analysis/ticket-board-redesign-plan.md): the view model
    // that normalises a migrated record and a legacy prose ticket into one shape,
    // exposed so a verify script can assert what the BANDS were built from
    // without re-deriving the format rules from the markdown itself.
    ticketView,
    // FEAT-082: the digest landing internals, so a verify script can assert on
    // what awaits the user without racing the parallel board+tickets fetch.
    showDigest, renderDigest, ticketType,
    // FEAT-075: the in-app guide reader's internals, so a verify script can
    // drive the route and assert on the rendered page + mermaid without racing.
    gv, showGuide, navGuide, hideGuide, renderGuideDoc,
    // FEAT-053: the rail ticket modal, FEAT-051: the integrations strip —
    // exposed so verify scripts drive them without re-deriving the rules.
    openTicketModal, closeTicketModal, ticketModalOpen,
    paintIntegrations, plannedServers, liveAttachedServers,
    // BUG-016: expose the poll loop internals so verify scripts can force an
    // immediate cycle instead of sleeping out the full RAIL_POLL_MS.
    pollRail, RAIL_POLL_MS,
    /*
     * ARCH-001 phase 2 / BUG-034 + FEAT-057: the renderer's whole surface, so a
     * verify script can force a reconciliation cycle (instead of sleeping out
     * SNAP_POLL_MS) and can compare what the STRIP shows against what the
     * SERVER said — which is the only assertion that actually proves this fix.
     */
    pollRunning, applySnapshot, stripModel, renderStrip, SNAP_POLL_MS,
    // BUG-106 — the selectProject boundary + the dock's session-bound surfaces and
    // the foreign-view predicate, so a verify script can drive a real sidebar
    // project switch and assert the strip / hairline / live-count re-scope (and
    // that switching back restores them) without re-deriving the rules.
    selectProject, dockIsForeign, paintPerm, renderRailSummary,
    refreshOutcomes, renderOutcomes, outcomesHeadline,
    // BUG-017: openSession() runs synchronously up to its first `await`
    // (closeSocket() included) before returning its promise — exposing it lets
    // a verify script set `state.live = true` right after calling it, landing
    // deterministically DURING the pending fetches, the same window a real
    // concurrent connect() would race into. Without this hook there is no way
    // to construct the exact "state.live true while liveRecordFor runs" case
    // from outside the module.
    openSession,
    // BUG-083: the new-session boundary + the per-project/session draft
    // machinery, so a verify script can drive a real switch and assert that a
    // draft is saved under its own key and restored on return (never carried).
    startNew, draftKey, saveDraft, restoreDraft,
    // BUG-087 / FEAT-074: the add-project open path, so a verify script can drive
    // a real add-project switch and assert the transcript pane + sidebar surface.
    addProject,
    // FEAT-040: session-status ground truth, for verify scripts to assert
    // against without re-deriving the priority rules themselves.
    // BUG-153: `isDriving` alongside them, so a script can assert the CHIP and
    // the GUARDS agree — the property whose absence was the bug — rather than
    // testing each half against its own idea of liveness.
    computeSessState, paintSessStatus, isDriving,
    // BUG-075: the crown/seal renderer, so a verify script can drive it against
    // a container vs direct project and assert the "+ Add mount" chip is gated
    // on isolation (same ground truth as the Direct/Container chip beside it).
    paintCrown,
    // BUG-082: the proc chip's capped-preview + full-port popover internals,
    // so a verify script can inject N>cap ports and assert the inline cap/+N,
    // the :4317-first stable order, and the popover's full list.
    paintProcChip, paintProcPop, orderedPorts, closePops,
    // FEAT-048: survival ground truth on the hover — exposed so a verify
    // script can await the lazy fetch deterministically instead of racing a
    // real mouseenter.
    refreshSessSurvival, survivalHintLine,
    // FEAT-022: autonomous-mode controls + mirror, for verify scripts.
    startAutonomous, stopAutonomous, refreshAuto, paintAuto,
    // FEAT-042: model-chip internals, so the spec can assert the live report /
    // expectation without re-deriving them from the DOM.
    paintModelChip,
    modelChipInfo: () => ({
      wire: liveWireModel,
      expected: expectedLiveModel,
      flagged: node.modelChip?.dataset.flag === 'true',
    }),
    // BUG-106 clean-room — the full set of surfaces that read the open session's
    // LIVE state, exposed so scripts/verify-bug-106-crossproject-strip.mjs can
    // enumerate every one of them and prove none leaks A's live work under a
    // foreign selection B. dockSnap/dockLive/dockEffective/dockLiveTools/
    // dockLiveModel are the SINGLE gate the paint surfaces route through.
    providerView, paintProvBtn, projectDot, effectivePerm,
    dockSnap, dockLive, dockEffective, dockLiveTools, dockLiveModel,
    // BUG-129: the queue's durability surface — so a verify script can drive
    // the REAL accept/persist/restore path (rather than re-deriving the storage
    // shape from the outside) and read back the exact key it writes under.
    queueMessage, paintQueue, adoptQueue, persistQueue, flushQueue, QUEUE_KEY,
    queueOwnerKey: () => queueKey, // which session's rows state.queue currently mirrors (null = none)
  };
}

await boot();
