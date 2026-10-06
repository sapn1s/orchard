/**
 * URL state — hash routes.
 *
 * Hash, not the History API, and that is a decision, not a habit: the server
 * (src/server/index.ts) serves exact files only, so a deep path like
 * /project/x/session/y would 404 on reload unless the server grew a catch-all.
 * The hash never reaches the server, needs no route table, and for a loopback
 * single-user app gives up nothing (no SEO, no crawlers, no SSR).
 *
 * Shapes:
 *   #/project/<projectId>
 *   #/project/<projectId>/session/<sessionId>?dir=<encodedDir>&i=<index>&agent=<agentId>
 *
 * `dir` is load-bearing, not decoration: 26 session ids exist in BOTH the
 * Linux and Windows stores, and the server answers 409 `ambiguous-dir` rather
 * than guessing — so a link that omits it can be ambiguous on this machine.
 * `i` is the absolute message index (the one coordinate system shared by
 * ?tail/?offset/appends) of the message at the top of the viewport; absent
 * means "the newest page", which is also what an at-bottom reader gets.
 */

/** Parse a location.hash into a route, or null when it carries no state. */
export function parseHash(hash) {
  const raw = String(hash ?? '');
  if (!raw.startsWith('#/')) return null;
  const qAt = raw.indexOf('?');
  const path = (qAt === -1 ? raw.slice(1) : raw.slice(1, qAt)).replace(/\/+$/, '');
  const query = new URLSearchParams(qAt === -1 ? '' : raw.slice(qAt + 1));
  const parts = path.split('/').filter(Boolean).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
  if (parts[0] !== 'project' || !parts[1]) return null;
  const route = { projectId: parts[1], sessionId: null, dir: null, i: null, agent: null };
  if (parts[2] === 'session' && parts[3]) {
    route.sessionId = parts[3];
    route.dir = query.get('dir') || null;
    const i = Number.parseInt(query.get('i') ?? '', 10);
    if (Number.isInteger(i) && i >= 0) route.i = i;
    route.agent = query.get('agent') || null;
  }
  return route;
}

/** Format a route back into a hash string. Inverse of parseHash. */
export function formatHash({ projectId, sessionId = null, dir = null, i = null, agent = null }) {
  if (!projectId) return '';
  let h = `#/project/${encodeURIComponent(projectId)}`;
  if (!sessionId) return h;
  h += `/session/${encodeURIComponent(sessionId)}`;
  const q = new URLSearchParams();
  if (dir) q.set('dir', dir);
  if (Number.isInteger(i) && i >= 0) q.set('i', String(i));
  if (agent) q.set('agent', agent);
  const s = q.toString();
  return s ? `${h}?${s}` : h;
}

/* ------------------------------------------------------- tickets (FEAT-058) */
/*
 * The ticket dashboard is a SIBLING route, not a session route:
 *
 *   #/tickets?project=<projectId>            — the DIGEST (what awaits you; FEAT-082)
 *   #/tickets/all?project=<projectId>        — the full sortable/searchable table
 *   #/tickets/<TICKET-ID>?project=<projectId> — one ticket's detail
 *
 * It is parsed separately rather than folded into parseHash() on purpose —
 * parseHash's contract ("a session place, or null") is depended on by the
 * session restore path, and a tickets URL is emphatically NOT a session place.
 * `project` is optional in the URL: a link handed over without it opens on the
 * viewer's currently selected project, which is the sane default for a link the
 * orchestrator pastes into chat.
 *
 * FEAT-082 — `view` disambiguates the three shapes so the client never has to
 * re-derive them: 'digest' (bare `#/tickets`), 'all' (the `/all` segment, the
 * former landing table), 'detail' (any real `<TICKET-ID>`). `all` is a reserved
 * segment — no ticket id is `all` (ids are `^[A-Z]+-\d+$`), so it can never
 * shadow a real ticket.
 */
export function parseTicketsHash(hash) {
  const raw = String(hash ?? '');
  if (!raw.startsWith('#/tickets')) return null;
  const qAt = raw.indexOf('?');
  const path = (qAt === -1 ? raw.slice(1) : raw.slice(1, qAt)).replace(/\/+$/, '');
  const query = new URLSearchParams(qAt === -1 ? '' : raw.slice(qAt + 1));
  const parts = path.split('/').filter(Boolean).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
  if (parts[0] !== 'tickets') return null;
  const projectId = query.get('project') || null;
  const seg = parts[1] || null;
  if (seg === 'all') return { projectId, ticketId: null, view: 'all' };
  return { projectId, ticketId: seg, view: seg ? 'detail' : 'digest' };
}

/** Format a tickets route back into a hash string. Inverse of parseTicketsHash. */
export function formatTicketsHash({ projectId = null, ticketId = null, view = null } = {}) {
  const seg = view === 'all' ? 'all' : (ticketId ? encodeURIComponent(ticketId) : '');
  const h = `#/tickets${seg ? `/${seg}` : ''}`;
  return projectId ? `${h}?project=${encodeURIComponent(projectId)}` : h;
}

/* ------------------------------------------------------------ git (FEAT-099) */
/*
 * The Git workspace is a SIBLING route, like tickets and guide, rather than a
 * session place. It is parsed apart from parseHash() so the session restore
 * path can keep treating every non-session hash as null.
 *
 *   #/git?project=<projectId> — the working tree ('changes')
 *   #/git/<view>?project=<projectId> — branches/history/stashes in later slices
 */
export function parseGitHash(hash) {
  const raw = String(hash ?? '');
  if (!raw.startsWith('#/git')) return null;
  const qAt = raw.indexOf('?');
  const path = (qAt === -1 ? raw.slice(1) : raw.slice(1, qAt)).replace(/\/+$/, '');
  const query = new URLSearchParams(qAt === -1 ? '' : raw.slice(qAt + 1));
  const parts = path.split('/').filter(Boolean).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
  if (parts[0] !== 'git') return null;
  return { projectId: query.get('project') || null, view: parts[1] || 'changes' };
}

/** Format a Git route back into a hash string. Inverse of parseGitHash. */
export function formatGitHash({ projectId = null, view = 'changes' } = {}) {
  const h = `#/git${view && view !== 'changes' ? `/${encodeURIComponent(view)}` : ''}`;
  return projectId ? `${h}?project=${encodeURIComponent(projectId)}` : h;
}

/* --------------------------------------------------------- guide (FEAT-075) */
/*
 * The in-app Guide reader is a SIBLING route, like the ticket dashboard — not a
 * session place. Same reasoning: parseHash's contract ("a session place, or
 * null") is load-bearing for session restore, so a guide URL is parsed apart.
 *
 *   #/guide              — the reader, opened on the index (README)
 *   #/guide/<page>       — a specific page (the bare filename, no .md)
 */
export function parseGuideHash(hash) {
  const raw = String(hash ?? '');
  if (!raw.startsWith('#/guide')) return null;
  const qAt = raw.indexOf('?');
  const path = (qAt === -1 ? raw.slice(1) : raw.slice(1, qAt)).replace(/\/+$/, '');
  const parts = path.split('/').filter(Boolean).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
  if (parts[0] !== 'guide') return null;
  return { page: parts[1] || null };
}

/** Format a guide route back into a hash string. Inverse of parseGuideHash. */
export function formatGuideHash({ page = null } = {}) {
  return `#/guide${page ? `/${encodeURIComponent(page)}` : ''}`;
}

/** Structural equality — used to skip pushing a history entry for a no-op. */
export function sameRoute(a, b) {
  if (!a || !b) return a === b;
  return a.projectId === b.projectId && a.sessionId === b.sessionId
    && (a.dir ?? null) === (b.dir ?? null)
    && (a.i ?? null) === (b.i ?? null)
    && (a.agent ?? null) === (b.agent ?? null);
}
