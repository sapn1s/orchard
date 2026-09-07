/**
 * Thin JSON client for the station server.
 *
 * Two things this file exists to absorb:
 *  - routes a parallel workstream is still landing (container control). A 404
 *    here is a *known* state, not a crash: callers get {missing:true}.
 *  - the settings PATCH shape. The registry currently takes a partial Project
 *    ({isolation, settings:{...}}); the agreed contract is a flat partial. We
 *    send nested, verify the echo, and retry flat if the echo says it didn't
 *    land — so whichever shape the server ends up speaking, the UI works.
 */

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.missing = status === 404;
    /** Parsed response body — 409s carry the candidate dirs here. */
    this.body = body ?? null;
  }
}

export async function api(path, init) {
  let res;
  try {
    res = await fetch(path, {
      headers: { 'content-type': 'application/json' },
      ...init,
    });
  } catch (err) {
    throw new ApiError(`server unreachable (${err.message})`, 0);
  }
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(`non-JSON response (HTTP ${res.status})`, res.status);
  }
  if (!res.ok) throw new ApiError(body.error || `HTTP ${res.status}`, res.status, body);
  return body;
}

/** Resolves to null instead of throwing when the route does not exist yet. */
export async function optional(path, init) {
  try {
    return await api(path, init);
  } catch (err) {
    if (err instanceof ApiError && err.missing) return null;
    throw err;
  }
}

/* ------------------------------------------------------------- projects */

export const listProjects = () => api('/api/projects').then((r) => r.projects);
export const getProject = (id) => api(`/api/projects/${encodeURIComponent(id)}`).then((r) => r.project);
export const scanProjects = () => api('/api/projects/scan').then((r) => r.suggestions);
/**
 * Create a project. FEAT-089: `applyMethod` (default true) auto-applies the
 * full method (board, Working Agreement, format hook, gate) to the target repo
 * on add; pass `false` to add it untouched (browse-history only). Returns the
 * full server payload ({ project, method }) so the caller can report exactly
 * what was scaffolded — never leave the side effect for the user to discover.
 */
export const createProject = (hostPath, name, { applyMethod = true } = {}) =>
  api('/api/projects', { method: 'POST', body: JSON.stringify({ hostPath, name, applyMethod }) });
/**
 * FEAT-059 — get-or-create the Orchard-owned scratch project (creates its
 * directory + registry row on first call, on demand). Called by the global
 * "New session" button; per-project "+" buttons never call this.
 */
export const ensureScratchProject = () =>
  api('/api/projects/scratch/ensure', { method: 'POST' }).then((r) => r.project);
export const projectSessions = (id) => api(`/api/projects/${encodeURIComponent(id)}/sessions`);
/**
 * BUG-138 — directories this project might have been renamed to. Read-only and
 * decides nothing: each candidate carries its own `confidence`, and `cannotDecide`
 * says in words why Orchard will not pick for you when it will not.
 */
export const repointCandidates = (id) => api(`/api/projects/${encodeURIComponent(id)}/repoint-candidates`);
/**
 * BUG-138 — point a project at a new directory, following a rename. Distinct
 * from `patchProject` because the reply carries `pathChange` (what the repoint
 * did, and how many sessions came with it) and that report must not be dropped:
 * "your history survived" is the whole reason the user is here.
 */
export const repointProject = (id, hostPath) =>
  api(`/api/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ hostPath }) });
/** Directory listing for the add-project browser. */
export const listDirs = (p) => api(`/api/fs/dirs${p ? `?${new URLSearchParams({ path: p })}` : ''}`);

/**
 * Patch a project. `patch` is expressed in the flat contract shape
 * ({isolation, model, mounts, ...}); we translate to the nested registry shape
 * and fall back to flat if the server does not echo the change back.
 */
const TOP_LEVEL = new Set(['name', 'isolation', 'hostPath']);

export async function patchProject(id, patch) {
  const nested = {};
  const settings = {};
  for (const [k, v] of Object.entries(patch)) {
    if (TOP_LEVEL.has(k)) nested[k] = v;
    else settings[k] = v;
  }
  if (Object.keys(settings).length) nested.settings = settings;

  const url = `/api/projects/${encodeURIComponent(id)}`;
  const first = await api(url, { method: 'PATCH', body: JSON.stringify(nested) });
  const p = first.project;
  if (echoed(p, patch)) return p;

  // The server speaks the flat contract — resend that way and verify again.
  const second = await api(url, { method: 'PATCH', body: JSON.stringify(patch) });
  const q = second.project;
  if (!echoed(q, patch)) {
    throw new ApiError(
      `settings did not persist: ${Object.keys(patch).join(', ')} — server accepted the PATCH but echoed back the old values`,
      200,
    );
  }
  return q;
}

function echoed(project, patch) {
  if (!project) return false;
  const s = project.settings ?? {};
  return Object.entries(patch).every(([k, v]) => {
    const got = TOP_LEVEL.has(k) ? project[k] : (k in s ? s[k] : project[k]);
    return covers(got, v);
  });
}

/**
 * Subset-aware persist check: is every field the client SENT present-and-equal
 * in the server's echo? The server legitimately default-fills settings, so a
 * partial patch (e.g. {playwright:true} on a project with no stored `tools`) is
 * echoed back as a defaults-filled SUPERSET ({serena:true,playwright:true}).
 * That is a SUCCESSFUL save — the sent field persisted — so extra sibling keys
 * the server ADDED (that the client never sent) must be ignored. This recurses
 * into nested settings objects (tools/browser/snapshots/container) with the same
 * rule: only the SENT leaf keys must match; server-added siblings are ignored.
 *
 * `got` is the server's echo, `sent` is what the client PUT.
 *
 * A genuinely-wrong persist — the server echoing a DIFFERENT value for a key the
 * client actually SENT — is NOT a subset match and still returns false, so real
 * "did not persist" failures are still caught. Arrays are compared exactly (a
 * sent array is a whole leaf value, not a bag with optional extras).
 */
function covers(got, sent) {
  if (same(got, sent)) return true;
  if (sent == null) return got == null;
  // A sent array must match exactly — no subset/superset semantics for arrays.
  if (Array.isArray(sent) || Array.isArray(got)) return same(got, sent);
  if (typeof sent === 'object' && typeof got === 'object' && got != null) {
    return Object.keys(sent)
      .filter((k) => sent[k] !== undefined)
      .every((k) => k in got && covers(got[k], sent[k]));
  }
  // Scalars that were not === (via same above), or a shape mismatch (sent object
  // vs echoed scalar/null) — a real disagreement on a sent field.
  return false;
}

/**
 * Structural equality, order-insensitive on object keys.
 * JSON.stringify comparison was wrong here: the server re-serialises objects
 * with its own key order, which made a perfectly applied PATCH look rejected.
 */
function same(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => same(x, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => k in b && same(a[k], b[k]));
  }
  return false;
}

/* ------------------------------------------------- session row operations */
/*
 * Rename / pin / delete for a single session, driven by the sidebar's context
 * menu. Two rules shape everything here:
 *
 *  1. NOTHING is inferred from the title text. Whether a session was renamed is
 *     read only from an explicit server field; guessing "this looks custom"
 *     would put a marker on rows the user never touched.
 *  2. The RESPONSE is never treated as proof. These routes were landing in a
 *     parallel workstream with an unsettled body shape, so the caller re-reads
 *     the session list and checks the change is really there before showing it.
 *     A 200 with an unrecognised body must not become a green checkmark.
 */

const sessPath = (id) => `/api/sessions/${encodeURIComponent(id)}`;
const withDirQ = (path, dir, extra) => {
  const q = new URLSearchParams(extra ?? {});
  if (dir) q.set('dir', dir);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
};

/** Pinned, from an explicit field only. Every plausible spelling, no guessing. */
export function pinnedOf(s) {
  if (!s || typeof s !== 'object') return false;
  return s.pinned === true || s.isPinned === true
    || (typeof s.pinnedAt === 'string' && s.pinnedAt !== '');
}

/** Title set by the user rather than generated. Explicit fields only. */
export function renamedOf(s) {
  if (!s || typeof s !== 'object') return false;
  return s.titleSource === 'custom' || s.titleSource === 'user'
    || s.titleIsCustom === true || s.renamed === true || s.hasCustomTitle === true
    || (typeof s.customTitle === 'string' && s.customTitle !== '');
}

/** The generated title a rename replaced, when the server keeps one. */
export function autoTitleOf(s) {
  for (const k of ['autoTitle', 'generatedTitle', 'originalTitle', 'defaultTitle']) {
    if (typeof s?.[k] === 'string' && s[k]) return s[k];
  }
  return null;
}

export const renameSession = (sessionId, dir, title, { force = false } = {}) =>
  api(withDirQ(sessPath(sessionId), dir, force ? { force: '1' } : {}), {
    method: 'PATCH',
    body: JSON.stringify(dir ? { title, dir } : { title }),
  });

/**
 * Pin/unpin. The server workstream offered two contracts — a dedicated
 * `/pin` sub-route or a field on the session PATCH — and had not said which
 * would ship. A 404 on the sub-route is therefore not an error: it is the
 * other contract, so we fall through to it rather than reporting failure.
 */
export async function setPinned(sessionId, dir, pinned, { force = false } = {}) {
  const extra = force ? { force: '1' } : {};
  try {
    return await api(withDirQ(`${sessPath(sessionId)}/pin`, dir, extra), {
      method: pinned ? 'POST' : 'DELETE',
      body: JSON.stringify(dir ? { dir, pinned } : { pinned }),
    });
  } catch (err) {
    if (!(err instanceof ApiError) || !err.missing) throw err;
    return api(withDirQ(sessPath(sessionId), dir, extra), {
      method: 'PATCH',
      body: JSON.stringify(dir ? { pinned, dir } : { pinned }),
    });
  }
}

/**
 * Delete. Deliberately NOT a bare DELETE: the session id is echoed back as an
 * explicit confirmation, in the query and the body, so a route that requires
 * either shape is satisfied and a route that requires neither is unharmed.
 * A 409 (the session is being written right now) is handed back intact.
 */
export async function deleteSession(sessionId, dir) {
  const url = withDirQ(sessPath(sessionId), dir, { confirm: sessionId });
  try {
    const r = await api(url, {
      method: 'DELETE',
      body: JSON.stringify({ confirm: sessionId, sessionId, ...(dir ? { dir } : {}) }),
    });
    return { ok: true, result: r ?? {} };
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    if (err.missing) return null;
    if (err.status === 409) return { conflict: true, message: err.message, body: err.body ?? {} };
    return { problem: err.message, status: err.status, body: err.body ?? {} };
  }
}

/**
 * Where the server says it put the original before removing it — or null.
 * The shipped route reports `backup` as an OBJECT ({path, bytes, sha256,
 * verified}); an earlier draft of this reader only accepted a string, which
 * would have made a real, verified backup render as "no backup was reported".
 * Both shapes are read, and `verified` is passed through because a byte-checked
 * copy is a stronger promise than a path on its own.
 */
export function backupPathOf(result) {
  const r = result ?? {};
  for (const k of ['backup', 'backupPath', 'backedUpTo', 'movedTo', 'trashPath', 'archivedTo']) {
    const v = r[k] ?? r.session?.[k];
    if (typeof v === 'string' && v) return { path: v, verified: false, bytes: null };
    if (v && typeof v === 'object' && typeof v.path === 'string' && v.path) {
      return { path: v.path, verified: v.verified === true, bytes: typeof v.bytes === 'number' ? v.bytes : null };
    }
  }
  return null;
}

/* ------------------------------------------------------------ transcripts */

/**
 * ONE coordinate system. The server numbers messages the same whether reached
 * by `?tail`, `?offset`, or `?beforeBytes/?before`, and `session-appended`
 * continues that numbering — verified on b60acf68 (`?tail=5` and forward-at-604
 * return byte-identical messages at indices 604..608). So the client just names
 * a window and renders what comes back; no index remapping, no probing.
 *
 * Window selectors (pass one):
 *   { tail }                       — the newest `tail` messages
 *   { offset }                     — a forward page from `offset`
 *   { tail, before[, beforeBytes]} — the `tail` messages ending just before
 *                                    index `before`; `beforeBytes` is the prior
 *                                    page's `cursorBytes`, which keeps a
 *                                    backward walk flat-cost on a huge file.
 */
export const transcript = (encodedDir, sessionId, opts = {}) => {
  const q = new URLSearchParams({ limit: String(opts.limit ?? 400) });
  if (opts.tail != null) q.set('tail', String(opts.tail));
  if (opts.before != null) q.set('before', String(opts.before));
  if (opts.beforeBytes != null) q.set('beforeBytes', String(opts.beforeBytes));
  if (opts.tail == null && opts.before == null) q.set('offset', String(opts.offset ?? 0));
  if (opts.tools) q.set('tools', '1');
  return api(`/api/transcript/${encodeURIComponent(encodedDir)}/${encodeURIComponent(sessionId)}?${q}`);
};

export const transcriptTail = (encodedDir, sessionId, opts = {}) =>
  transcript(encodedDir, sessionId, { tail: opts.limit ?? 200 });

/**
 * FEAT-132 — the session-configuration record (what was injected into this
 * session's context at launch). `null` (via `optional`) means NO record: either
 * the server predates the route, or the session predates the feature. The caller
 * renders a clearly-labelled partial card in that case, never a full one.
 */
export const sessionConfig = (sessionId) =>
  optional(`/api/session-config/${encodeURIComponent(sessionId)}`);

/** Last slash-command list any session's CLI reported. null = route absent. */
export const slashCommands = () => optional('/api/slash-commands').then((r) => r?.commands ?? null);

/** The CLI's own model list (display names with versions). null = absent.
 * FEAT-045: per provider — no arg keeps the pre-045 Claude list. */
export const models = (provider) =>
  optional(provider ? `/api/models?provider=${encodeURIComponent(provider)}` : '/api/models')
    .then((r) => r?.models ?? null);

/** FEAT-045: live provider availability (detectCodex verdicts). null = route absent. */
export const providers = () => optional('/api/providers').then((r) => r?.providers ?? null);

/** FEAT-118: app-wide default layer (model/effort a project inherits when unset). */
export const getSettings = () => optional('/api/settings').then((r) => r?.settings ?? null);
export const patchSettings = (patch) =>
  api('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
    .then((r) => r.settings);

/** FEAT-116: per-provider rate-limit window usage snapshots. null = route absent. */
export const usage = () => optional('/api/usage').then((r) => r?.providers ?? null);

/** FEAT-040/BUG-027 ground truth (survival scoping, broker state, adopted
 * survivors) — see src/server/index.ts's health route. null = route absent
 * or unreachable; callers must treat null as "unknown", never as "false". */
export const health = () => optional('/api/health');

/* -------------------------------------------------------------------- git */
/* Status + actions driven by the server's git/gh CLIs. null = route absent. */

const gitBase = (id) => `/api/projects/${encodeURIComponent(id)}/git`;

export const gitStatus = (id) => optional(`${gitBase(id)}/status`).then((r) => (r ? r.status : null));
export const gitChanges = (id) => api(`${gitBase(id)}/changes`);
export const gitBranches = (id) => api(`${gitBase(id)}/branches`);
export const gitStashes = (id) => api(`${gitBase(id)}/stashes`);
export const gitStashShow = (id, ref, path) => {
  const q = new URLSearchParams({ ref });
  if (path !== undefined) q.set('path', path);
  return api(`${gitBase(id)}/stash-show?${q}`);
};
export const gitLog = (id, { limit, before, cursor } = {}) => {
  const q = new URLSearchParams();
  if (limit !== undefined) q.set('limit', String(limit));
  if (before) q.set('before', before);
  if (cursor) q.set('cursor', cursor);
  const suffix = q.toString();
  return api(`${gitBase(id)}/log${suffix ? `?${suffix}` : ''}`);
};
export const gitCommitFiles = (id, sha) =>
  api(`${gitBase(id)}/commit-files?${new URLSearchParams({ sha })}`);
export const gitCommitDiff = (id, sha, path) =>
  api(`${gitBase(id)}/commit-diff?${new URLSearchParams({ sha, path })}`);
export const gitAction = (id, action, body) =>
  api(`${gitBase(id)}/${action}`, { method: 'POST', body: JSON.stringify(body ?? {}) });
export const gitFetch = (id) => gitAction(id, 'fetch');
export const gitSwitchBranch = (id, name) => gitAction(id, 'switch-branch', { name });
export const gitCreateBranch = (id, name) => gitAction(id, 'create-branch', { name });
export const gitCheckoutRemote = (id, name) => gitAction(id, 'checkout-remote', { name });
export const openTerminal = (id) =>
  api(`/api/projects/${encodeURIComponent(id)}/terminal`, { method: 'POST', body: '{}' });

/* --- FEAT-108 r3: runtime git-write grant (whether AGENT sessions in this
 * project may run git writes). The user's OWN commits through this panel go via
 * the server git CLI and are never blocked — this only governs agent Bash git.
 * null grant = agent git writes are blocked. */
const gwBase = (id) => `/api/projects/${encodeURIComponent(id)}/git-write-grant`;
export const gitWriteGrant = (id) => optional(gwBase(id));
export const grantGitWrite = (id, body) =>
  api(gwBase(id), { method: 'POST', body: JSON.stringify(body ?? {}) });
export const revokeGitWrite = (id) => api(gwBase(id), { method: 'DELETE' });

/* -------------------------------------------------------------- processes */
/* What is running FROM this project's directory. null = route absent. */

export const processSummary = () =>
  optional('/api/processes/summary').then((r) => r?.byProject ?? null);
export const projectProcesses = (id) =>
  optional(`/api/projects/${encodeURIComponent(id)}/processes`).then((r) => r?.processes ?? null);
export const killProcess = (id, pid, signal) =>
  api(`/api/projects/${encodeURIComponent(id)}/processes/${pid}`, { method: 'POST', body: JSON.stringify(signal ? { signal } : {}) });

/* --------------------------------------------------------------- memories */
/* Agent memories: list/read/delete only — deliberately not an editor. */

const memBase = (id) => `/api/projects/${encodeURIComponent(id)}/memories`;

export const listMemories = (id) => optional(memBase(id));
export const readMemory = (id, dir, name) =>
  api(`${memBase(id)}?${new URLSearchParams({ dir, name })}`);
export const deleteMemory = (id, dir, name) =>
  api(`${memBase(id)}?${new URLSearchParams({ dir, name })}`, { method: 'DELETE' });

/* ----------------------------------------------------------------- search */

/** Content search (ripgrep server-side). Throws with the server's own words. */
export const searchContent = (q, projectId, signal) => {
  const p = new URLSearchParams({ q });
  if (projectId) p.set('project', projectId);
  return api(`/api/search?${p}`, { signal });
};

/** Map a hit's file line to its canonical message index (for deep-linking). */
export const searchLocate = (dir, sessionId, line) =>
  api(`/api/search/locate?${new URLSearchParams({ dir, sessionId, line: String(line) })}`);

/* ------------------------------------------------------------------ board */
/*
 * The opt-in per-project docs/bugs/ board, read for the Needs-You rail
 * (FEAT-018). A project without a board returns {hasBoard:false} with empty
 * arrays — never a 404 — so the caller renders the quiet empty state, not an
 * error. `optional` still guards a server that predates the route entirely.
 */
export const board = (id) =>
  optional(`/api/projects/${encodeURIComponent(id)}/board`)
    .then((r) => r ?? { hasBoard: false, needsYou: [], inflight: [], doneToday: [] });

/** Answer a 👤 board item: appended to the ticket + delivered to any attached session. */
export const answerBoard = (id, ticketId, answer) =>
  api(`/api/projects/${encodeURIComponent(id)}/board/answer`, {
    method: 'POST',
    body: JSON.stringify({ id: ticketId, answer }),
  });

/**
 * Dismiss (acknowledge) a WA-consolidation finding row (FEAT-047). The ack is
 * recorded server-side beside the findings JSON; the row stays gone until a
 * LATER consolidation pass re-detects the finding with a newer date.
 */
export const dismissFinding = (id, findingId) =>
  api(`/api/projects/${encodeURIComponent(id)}/board/dismiss`, {
    method: 'POST',
    body: JSON.stringify({ id: findingId }),
  });

/* ------------------------------------------------------- tickets (FEAT-058) */
/*
 * The full board archive behind the rail. Reads never mutate. Every WRITE
 * carries the `rev` (`<mtimeMs>:<size>`) the client last read, and the server
 * answers 409 — with the CURRENT rev in `err.body.rev` — rather than clobbering
 * an agent that wrote to the same ticket in the meantime.
 */
const proj = (id) => `/api/projects/${encodeURIComponent(id)}/tickets`;

/** Every project that HAS a docs/bugs/ board, with counts. */
export const boards = () => optional('/api/boards').then((r) => r?.boards ?? []);

/* ------------------------------------------------------------------ guide */
/*
 * FEAT-075 — the in-app Guide reader. Read-only; `optional` so a server that
 * predates the route (or an onboarded repo with no docs/guide) degrades to an
 * empty reader instead of throwing.
 */
export const guidePages = () => optional('/api/guide').then((r) => r?.pages ?? []);
export const guidePage = (page) => optional(`/api/guide/${encodeURIComponent(page)}`);

/* ------------------------------------------------------------ wiring (FEAT-076) */
/*
 * The per-project "Wiring" health panel. `wiring()` recomputes from true sources
 * on the server (registry refs + files on disk) every call — never cached — so a
 * ✅/❌ can't drift. `null` (via `optional`) means the route is absent on this
 * server (predates FEAT-076): the caller hides the panel rather than inventing a
 * status. `applyWiring()` performs ONE Apply (attach WA, or run onboard) and the
 * server echoes back the freshly-recomputed status so the row flips live.
 */
export const wiring = (id) =>
  optional(`/api/projects/${encodeURIComponent(id)}/wiring`).then((r) => (r ? r.wiring : null));

export const applyWiring = (id, check) =>
  api(`/api/projects/${encodeURIComponent(id)}/wiring/apply`, {
    method: 'POST',
    body: JSON.stringify({ check }),
  });

/** List (no q) or full-text search over ticket bodies (with q). */
export const ticketList = (id, q) =>
  api(`${proj(id)}${q ? `?q=${encodeURIComponent(q)}` : ''}`);

/** One ticket, including the real file markdown. */
export const ticket = (id, ticketId) => api(`${proj(id)}/${encodeURIComponent(ticketId)}`);

/** Append a dated, attributed note. Append-only server-side. */
export const ticketNote = (id, ticketId, text, rev) =>
  api(`${proj(id)}/${encodeURIComponent(ticketId)}/note`, {
    method: 'POST', body: JSON.stringify({ text, rev }),
  });

/** Reopen a Done ticket: status header + a logged reason + board reconciliation. */
export const ticketReopen = (id, ticketId, reason, rev) =>
  api(`${proj(id)}/${encodeURIComponent(ticketId)}/reopen`, {
    method: 'POST', body: JSON.stringify({ reason, rev }),
  });

/** Flag / unflag 👤 needs-you (the curated INDEX Owner cell). */
export const ticketOwner = (id, ticketId, needsYou) =>
  api(`${proj(id)}/${encodeURIComponent(ticketId)}/owner`, {
    method: 'POST', body: JSON.stringify({ needsYou }),
  });

/** File a new ticket from TEMPLATE.md / TEMPLATE-ARCH.md (server allocates the id). */
export const ticketCreate = (id, input) =>
  api(proj(id), { method: 'POST', body: JSON.stringify(input) });

/**
 * FEAT-090 — record a REPLY to a ticket from the ticket view. Append-only,
 * rev-gated (409 on a concurrent agent write, current rev in `err.body.rev`).
 * `reply` = { kind:'decision'|'question'|'counter', question, chose:{key,label}, note }.
 * A decision records answered-awaiting (owner stays 👤); a question/counter flips
 * ownership to the agent. NOTHING is dispatched — work starts only when you say go.
 */
export const ticketAnswer = (id, ticketId, reply, rev) =>
  api(`${proj(id)}/${encodeURIComponent(ticketId)}/answer`, {
    method: 'POST', body: JSON.stringify({ ...reply, rev }),
  });

/* -------------------------------------------------------------- templates */

export const listTemplates = () => api('/api/templates').then((r) => r.templates);
export const readTemplate = (id) => api(`/api/templates/${encodeURIComponent(id)}`).then((r) => r.template);
export const saveTemplate = (input) =>
  api('/api/templates', { method: 'POST', body: JSON.stringify(input) }).then((r) => r.template);
export const compose = (projectId) => api(`/api/compose/${encodeURIComponent(projectId)}`);

/**
 * Three outcomes the caller must be able to tell apart:
 *   null            — the route does not exist yet (404)
 *   {problem: msg}  — the route exists and refused (409 "isolation is direct",
 *                     500 "docker not running", …). Show the server's own words.
 *   {state, …}      — a real status.
 */
async function containerCall(path, init) {
  try {
    return await api(path, init);
  } catch (err) {
    if (err instanceof ApiError && err.missing) return null;
    return { problem: err.message };
  }
}

/* -------------------------------------------------------------- subagents */
/*
 * Routes for the navigable-subagent feature. `null` means the route is not on
 * this server yet — the caller shows the honest "recorded agent threads aren't
 * available from this server" line rather than an empty list that reads as
 * "this session had no agents".
 */

/**
 * `dir` is the store dir the session was listed from. Without it the server
 * refuses to guess between dual-boot duplicates and answers 409 with the
 * candidate dirs — so on 409 we retry with the first candidate rather than
 * showing the user a conflict they cannot act on.
 */
async function subagentCall(path, dir, params = {}) {
  const q = new URLSearchParams(params);
  const withDir = (d) => {
    const p = new URLSearchParams(q);
    if (d) p.set('dir', d);
    const s = p.toString();
    return s ? `${path}?${s}` : path;
  };
  try {
    return await api(withDir(dir));
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    if (err.missing) return null;
    if (err.status === 409 && !dir) {
      const dirs = err.body?.dirs;
      if (Array.isArray(dirs) && dirs.length) return api(withDir(dirs[0]));
    }
    throw err;
  }
}

export const sessionSubagents = (sessionId, dir) =>
  subagentCall(`/api/sessions/${encodeURIComponent(sessionId)}/subagents`, dir);

const agentPath = (sessionId, agentId) =>
  `/api/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(agentId)}/messages`;

/** Same window selectors as `transcript`; the subagent route speaks them too. */
export const subagentMessages = (sessionId, agentId, dir, opts = {}) => {
  const params = {};
  if (opts.limit != null) params.limit = String(opts.limit);
  if (opts.tail != null) params.tail = String(opts.tail);
  if (opts.before != null) params.before = String(opts.before);
  if (opts.beforeBytes != null) params.beforeBytes = String(opts.beforeBytes);
  if (opts.tail == null && opts.before == null && opts.limit != null) params.offset = String(opts.offset ?? 0);
  return subagentCall(agentPath(sessionId, agentId), dir, params);
};

/** Newest page of a recorded agent — one request. null when the route is absent. */
export const subagentMessagesTail = (sessionId, agentId, dir, opts = {}) =>
  subagentMessages(sessionId, agentId, dir, { tail: opts.limit ?? 200 });

/* ------------------------------------------------------------------- live */
/*
 * Which sessions another process is writing right now. Two shapes are accepted
 * because the server may report it either way: a `live: true` flag on the rows
 * of the session list, and/or this route. Absent route -> null -> no badges at
 * all, which is the honest answer when nothing is telling us.
 */

export async function liveSessions() {
  const r = await optional('/api/sessions/live');
  if (r === null) return null;
  const raw = Array.isArray(r) ? r : (r.sessions ?? r.live ?? r.ids ?? []);
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => (typeof x === 'string'
      ? { sessionId: x, dir: null, drivenByDashboard: false }
      : {
          sessionId: x?.sessionId ?? x?.id ?? null,
          dir: x?.dir ?? x?.encodedDir ?? null,
          drivenByDashboard: x?.drivenByDashboard === true,
          busy: x?.busy === true,
          detached: x?.detached === true,
          // BUG-033 — see liveBridges() below: the real turn start, or null.
          turnStartedAt: Number.isFinite(x?.turnStartedAt) ? x.turnStartedAt : null,
        }))
    .filter((x) => typeof x.sessionId === 'string' && x.sessionId);
}

/*
 * The live BRIDGES this server owns, keyed by their SDK session id. Unlike
 * `/api/sessions/live` (mtime-based: a bridge idle >LIVE_WINDOW drops out), this
 * lists every open bridge regardless of file recency — so a still-running
 * session that just hasn't written its jsonl in 30s is still reported. Returns
 * [] when the route is present but empty, null when the route is absent.
 */
export async function liveBridges() {
  const r = await optional('/api/sessions');
  if (r === null) return null;
  const raw = Array.isArray(r) ? r : (r.sessions ?? []);
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => ({
      sdkSessionId: x?.sdkSessionId ?? null,
      stationSessionId: x?.stationSessionId ?? x?.id ?? null,
      busy: x?.busy === true,
      // BUG-033: the honest start of the in-flight turn (epoch ms), or null on
      // an older server / when no turn is running. Never defaulted to "now".
      turnStartedAt: Number.isFinite(x?.turnStartedAt) ? x.turnStartedAt : null,
    }))
    .filter((x) => typeof x.sdkSessionId === 'string' && x.sdkSessionId);
}

/* --------------------------------------------- the running set (ARCH-001 P2) */
/*
 * BUG-034 — THE SERVER'S ANSWER to "what is running right now", fetched on
 * demand. The same structure the `running-snapshot` socket event pushes; this
 * is the CORRECTING path for everything a socket cannot guarantee (a dropped
 * frame, a backgrounded tab, a server that restarted under an open tab).
 *
 * `null` means the route is absent (an older server) — the caller must then
 * render nothing rather than fall back to guessing, which is the habit this
 * whole redesign exists to break.
 */
export async function sessionRunning(sessionId) {
  const r = await optional(`/api/sessions/${encodeURIComponent(sessionId)}/running`);
  if (r === null) return null;
  const s = r.snapshot ?? r;
  return s && s.v === 1 ? s : null;
}

/**
 * FEAT-126 — the DECLARED user-request bindings for a session (binding + title +
 * source + tickets, NO status). `null` = the route is absent (older server) so
 * the rail renders exactly as it did before; `[]` = a session that declared
 * none, which renders the same (no empty section). Every status is joined live
 * client-side from the board / running snapshot — this fetch carries no status.
 */
export async function sessionRequests(sessionId) {
  const r = await optional(`/api/sessions/${encodeURIComponent(sessionId)}/requests`);
  if (r === null) return null;
  return Array.isArray(r.requests) ? r.requests : [];
}

/* ------------------------------------------------- agent outcomes (FEAT-057) */
/*
 * What ended and why, recorded by the server with no model in the loop, so it
 * is readable on a fresh page load even though the orchestrator never woke up.
 */
export async function agentOutcomes({ projectId, sessionIds = [], limit, all } = {}) {
  const p = new URLSearchParams();
  if (projectId) p.set('projectId', projectId);
  for (const s of sessionIds) if (s) p.append('sessionId', s);
  if (limit) p.set('limit', String(limit));
  // BUG-070 — the client windows recent-vs-all itself; `all=1` fetches the full
  // bounded set (incl. dismissed) so "show all" is instant and always reachable.
  if (all) p.set('all', '1');
  const q = p.toString();
  const r = await optional(`/api/agent-outcomes${q ? `?${q}` : ''}`);
  if (r === null) return null;
  return Array.isArray(r.outcomes) ? r.outcomes : [];
}

export const dismissOutcomes = (ids) =>
  optional('/api/agent-outcomes/dismiss', {
    method: 'POST',
    body: JSON.stringify(ids === '*' ? { all: true } : { ids }),
  });

/* ---------------------------------------------------------------- browser */
/* Per-project stealth browser. Mirrors the container routes, including the
   "route not landed yet" contract: null means absent, {problem} means refused. */

export const browserStatus = (id) => containerCall(`/api/projects/${encodeURIComponent(id)}/browser/status`);
export const browserAction = (id, action) =>
  containerCall(`/api/projects/${encodeURIComponent(id)}/browser/${action}`, { method: 'POST', body: '{}' });

/* -------------------------------------------------------------- container */
/* Routes owned by a parallel workstream. `null` means "not landed yet". */


export const containerStatus = (id) => containerCall(`/api/projects/${encodeURIComponent(id)}/container/status`);
export const containerAction = (id, action) =>
  containerCall(`/api/projects/${encodeURIComponent(id)}/container/${action}`, { method: 'POST', body: '{}' });

/* -------------------------------------------------------------- snapshots */
/*
 * Per-session btrfs reflink copies of the project directory. Routes are owned
 * by a parallel workstream, so every call here separates the three outcomes the
 * UI must render differently:
 *
 *   null            — route absent (404). The caller HIDES the surface. It must
 *                     never fall back to an empty list: "no snapshots" and "this
 *                     server can't tell you" look identical on screen and only
 *                     one of them means you are unprotected.
 *   {problem: msg}  — the route exists and refused. Show the server's own words.
 *   data            — a real answer.
 */

const snapBase = (id) => `/api/projects/${encodeURIComponent(id)}/snapshots`;

/**
 * A failed snapshot is the load-bearing case: the session ran anyway, so the
 * only signal the user gets is this flag. The server's exact shape isn't
 * settled, so accept every plausible spelling rather than silently reading a
 * failure as a success.
 */
function normaliseSnapshot(s) {
  if (!s || typeof s !== 'object') return null;
  const status = String(s.status ?? s.state ?? '').toLowerCase();
  const error = typeof s.error === 'string' && s.error ? s.error
    : typeof s.failure === 'string' && s.failure ? s.failure
    : null;
  const failed = s.failed === true || s.ok === false
    || status === 'failed' || status === 'error'
    || (error !== null && status !== 'ok');
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    id: s.id ?? s.snapshotId ?? null,
    sessionId: s.sessionId ?? s.session_id ?? null,
    createdAt: s.createdAt ?? s.created_at ?? s.at ?? null,
    reason: s.reason ?? 'manual',
    label: s.label ?? null,
    fileCount: num(s.fileCount ?? s.files),
    sizeBytes: num(s.sizeBytes ?? s.bytes ?? s.size),
    durationMs: num(s.durationMs ?? s.ms),
    /*
     * The exclusion list AS RECORDED WHEN THIS SNAPSHOT WAS TAKEN. It can
     * differ from the project's current setting, and it — not the current
     * setting — is what a restore of this snapshot will honour. Stating the
     * current list in the restore confirm would be actively misleading.
     */
    exclusions: Array.isArray(s.exclusions) ? s.exclusions : null,
    /** Of those, the ones actually present in the project at capture time. */
    excludedFound: Array.isArray(s.excludedFound) ? s.excludedFound : null,
    failed,
    error: failed ? (error ?? 'the server did not say why') : null,
  };
}

/**
 * Resolves to `{snapshots, failures}` — failures are the entries that never
 * became a snapshot, kept apart so the UI can say "unprotected" rather than
 * showing them as something restorable.
 */
export async function listSnapshots(id) {
  let r;
  try {
    r = await api(snapBase(id));
  } catch (err) {
    if (err instanceof ApiError && err.missing) return null;
    return { problem: err.message };
  }
  const raw = Array.isArray(r) ? r : (r.snapshots ?? r.items ?? r.list ?? []);
  const rows = (Array.isArray(raw) ? raw : []).map(normaliseSnapshot).filter(Boolean);
  /*
   * The server RESOLVES `enabled: null` (the "auto" rule: on for container
   * projects, off otherwise) and returns the settled settings. Prefer them over
   * the raw registry object, so the toggle cannot disagree with the server about
   * whether this project is actually being snapshotted.
   */
  const settings = r && typeof r === 'object' && r.settings && typeof r.settings === 'object' ? r.settings : null;
  // A failure may also arrive alongside the list rather than inside it.
  const extra = Array.isArray(r?.failures) ? r.failures : (r?.lastFailure ? [r.lastFailure] : []);
  for (const f of extra) {
    const n = normaliseSnapshot(f);
    if (n && !rows.some((x) => x.id && x.id === n.id)) rows.push({ ...n, failed: true, error: n.error ?? 'the server did not say why' });
  }
  rows.sort((a, b) => (Date.parse(b.createdAt ?? 0) || 0) - (Date.parse(a.createdAt ?? 0) || 0));
  return {
    snapshots: rows.filter((s) => !s.failed),
    failures: rows.filter((s) => s.failed),
    settings,
    store: r?.store ?? null,
    fsType: r?.fsType ?? null,
  };
}

/**
 * `deduped: true` means the project was byte-identical to an existing snapshot,
 * so NO new one was made. It is passed through rather than smoothed away: the
 * UI must not report "snapshot taken" for a row that does not exist.
 */
export async function takeSnapshot(id, label) {
  try {
    const r = await api(snapBase(id), { method: 'POST', body: JSON.stringify(label ? { label } : {}) });
    return {
      snapshot: normaliseSnapshot(r?.snapshot ?? r),
      deduped: r?.deduped === true,
      pruned: Array.isArray(r?.pruned) ? r.pruned.length : (typeof r?.pruned === 'number' ? r.pruned : 0),
    };
  } catch (err) {
    if (err instanceof ApiError && err.missing) return null;
    return { problem: err.message };
  }
}

export async function deleteSnapshot(id, snapId) {
  try {
    await api(`${snapBase(id)}/${encodeURIComponent(snapId)}`, { method: 'DELETE' });
    return { ok: true };
  } catch (err) {
    if (err instanceof ApiError && err.missing) return null;
    return { problem: err.message };
  }
}

/**
 * Restore. The 409 is not an error to swallow — it is the server refusing
 * because sessions are live, and it carries WHAT would be disrupted. That is
 * handed back intact so the confirm can list it before offering `?force=1`.
 */
export async function restoreSnapshot(id, snapId, opts = {}) {
  const url = `${snapBase(id)}/${encodeURIComponent(snapId)}/restore${opts.force ? '?force=1' : ''}`;
  try {
    const r = await api(url, { method: 'POST', body: '{}' });
    return { ok: true, result: r ?? {} };
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    if (err.missing) return null;
    if (err.status === 409) {
      const b = err.body ?? {};
      const raw = b.liveSessions ?? b.sessions ?? b.live ?? b.blocking ?? [];
      return {
        conflict: b.code ?? b.reason ?? 'live-sessions',
        message: err.message,
        containerName: b.containerName ?? null,
        sessions: (Array.isArray(raw) ? raw : []).map((s) => {
          if (typeof s === 'string') return { sessionId: s, busy: false, disruption: null };
          return {
            // The server names these `stationSessionId`/`sdkSessionId`; showing
            // the SDK id matches what the rest of the app displays.
            sessionId: s?.sdkSessionId ?? s?.stationSessionId ?? s?.sessionId ?? s?.id ?? null,
            busy: s?.busy === true,
            /* The server's own words for what this session loses. Far better
               than anything invented here — it distinguishes an idle session
               from one mid-turn. */
            disruption: typeof s?.disruption === 'string' ? s.disruption : (s?.title ?? null),
          };
        }),
      };
    }
    return { problem: err.message };
  }
}
