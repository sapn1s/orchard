/* BUG-252 fixture — the deferred re-resolve as it stood at the two-break stop (IV run d215bd11), verbatim from public/app.js (applyRoute .. its visibilitychange listener). The verify script splices it back into the live app.js to build the must-FAIL ROUND-2 / ROUND-1 clients. Not loaded by the app. */
async function applyRoute(route) {
  if (!route) return false;
  const p = state.projects.find((x) => x.id === route.projectId);
  if (!p) return false;
  // BUG-252 — a later navigation (another route, an opened or new session)
  // supersedes this one: every await below re-checks before touching the view.
  const gen = ++nav.routeGen;
  disarmRouteRetry();
  nav.applying = (Number(nav.applying) || 0) + 1;
  try {
    state.expanded.add(p.id);
    saveExpanded();
    if (!route.sessionId) {
      startNew(p.id);
      return true;
    }
    const res = await resolveRouteSession(p, route);
    if (gen !== nav.routeGen) return true; // superseded while resolving — leave the newer view alone
    if (res.kind === 'open') {
      const sess = res.sess;
      await openSession(p, sess, { at: route.i, agent: route.agent });
      // The URL names where the session really is (a stale dir corrected). Only
      // if this open still owns the view — the user may have moved on meanwhile.
      if (state.current.sessionId === sess.sessionId && state.current.encodedDir === sess.encodedDir) {
        // Rewritten only over the link itself or the bare-project hash an
        // unresolved view left behind (a deferred re-resolve) — never over an
        // overlay route (#/tickets…) or a different session's URL.
        const want = formatHash({ ...route, dir: sess.encodedDir });
        const here = parseHash(location.hash);
        if (location.hash !== want && here?.projectId === p.id && (!here.sessionId || here.sessionId === sess.sessionId)) {
          window.history.replaceState(null, '', want);
          paintTitle();
        }
      }
      return true;
    }
    renderUnresolvedRoute(p, route, res);
    return true;
  } finally {
    nav.applying = Math.max(0, (Number(nav.applying) || 0) - 1);
  }
}

/**
 * BUG-252 — the ONE answer to "which session does this link name". Outcomes:
 *  - open      — a session to open (`sess`), from the history list or, for a
 *                live session the list does not show yet, from its bridge;
 *  - starting  — a live bridge owns the id but no transcript is readable yet;
 *  - ambiguous — the id is in several history folders and the link's dir
 *                names none of them;
 *  - unknown   — the history list could not be read: absence is NOT proven;
 *  - missing   — neither the history list nor a live bridge knows the id.
 */
async function resolveRouteSession(p, route, { force = false } = {}) {
  const id = route.sessionId;
  const st = sessionState(p.id);
  const cached = st.loaded && !st.loading;
  let s = await loadSessions(p.id, { force });
  const find = () => (s.list ?? []).filter((x) => x.sessionId === id);
  let matches = find();
  // A list served from cache predates anything created since: ask once more
  // before concluding the id is absent.
  if (!matches.length && cached && !force) { s = await loadSessions(p.id, { force: true }); matches = find(); }
  if (route.dir) {
    const exact = matches.find((x) => x.encodedDir === route.dir);
    if (exact) return { kind: 'open', sess: exact };
  }
  if (matches.length === 1) {
    const row = matches[0];
    // The server lists ONE copy per id. When the link names a different dir,
    // that dir may still hold the copy the link meant (a duplicate the list
    // folded away) — honour the link if its file is really there.
    if (route.dir && route.dir !== row.encodedDir && await transcriptReadable(route.dir, id)) {
      return { kind: 'open', sess: { ...row, encodedDir: route.dir } };
    }
    return { kind: 'open', sess: row };
  }
  if (matches.length > 1) return { kind: 'ambiguous', n: matches.length };
  // Not on disk as far as the list knows — ask the live registry (the bridge
  // owns where its transcript lands, FEAT-155; never re-derived from a cwd).
  let bridges = null;
  try { bridges = await api.liveBridges(); } catch { bridges = null; }
  const b = (bridges ?? []).find((x) => x.sdkSessionId === id && x.projectId === p.id);
  if (b) {
    const dir = b.storeEncodedDir;
    if (dir && await transcriptReadable(dir, id)) {
      return { kind: 'open', sess: { sessionId: id, encodedDir: dir, os: 'linux', displayTitle: id.slice(0, 8) } };
    }
    return { kind: 'starting', dir };
  }
  if (s.error) return { kind: 'unknown', error: s.error };
  return { kind: 'missing' };
}

/** BUG-252 — is `dir/id`'s transcript readable right now? One small request. */
async function transcriptReadable(dir, id) {
  try { await api.transcriptTail(dir, id, { limit: 1 }); return true; } catch { return false; }
}

/**
 * BUG-252 — the view for a link that did not resolve to an openable session.
 * The session view is left owning nothing (as before); the notice says which
 * of the honest outcomes this is, and every outcome but "ambiguous" keeps
 * asking, so a session that comes into existence opens by itself.
 */
function renderUnresolvedRoute(p, route, res) {
  selectProject(p.id, { quiet: true });
  resetOverrides(OVR_NONE); // BUG-198 round 2 — no session here: owns nothing, never adopted (selectProject no longer clears)
  state.current = { projectId: p.id, encodedDir: null, sessionId: null, title: null, os: null };
  followCurrent(false);
  clearPendingDelivery(); // BUG-079: a link that resolves to no session is still a boundary
  closeSocket();
  resetTranscript();
  renderTree();
  const short = `${route.sessionId.slice(0, 8)}…`;
  let head, why;
  if (res.kind === 'starting') {
    head = 'This session is starting.';
    why = ` Session ${short} is running under “${p.name}” but has not written its transcript yet — it opens here as soon as it does.`;
  } else if (res.kind === 'unknown') {
    head = 'Could not check this link yet.';
    why = ` The session list for “${p.name}” did not load (${res.error}). Trying again.`;
  } else if (res.kind === 'ambiguous') {
    head = 'This link points to a session that is not here.';
    why = ` The id ${short} exists in ${res.n} history folders and the link does not say which — open it from the sidebar instead.`;
  } else {
    head = 'This link points to a session that is not here.';
    why = ` No session ${short} under “${p.name}”. It may have been deleted, or the link may be wrong.`;
  }
  mainThread().paneEl.append(el('div', { class: 'hint-row route-unresolved', 'data-route-outcome': res.kind },
    el('b', { text: head }),
    document.createTextNode(why)));
  if (res.kind === 'missing' || res.kind === 'ambiguous') {
    say('session in the URL not found', true);
    window.history.replaceState(null, '', formatHash({ projectId: p.id }));
  } else {
    say(res.kind === 'starting' ? 'waiting for the session in the URL to write its transcript' : `session list unavailable: ${res.error}`, res.kind === 'unknown');
  }
  if (res.kind !== 'ambiguous') armRouteRetry(route);
}

/*
 * BUG-252 — re-resolve an unresolved link until it opens, the user navigates
 * away, or ROUTE_RETRY_FOR_MS passes. Driven three ways, so no single missed
 * signal leaves it dead: its own backoff timer (independent of liveness — a
 * hidden tab, a bridge that already exited), the live poll seeing the id
 * (`refreshLive`), and the tab becoming visible again.
 */
const ROUTE_RETRY_MS = [1000, 2000, 5000, 10_000, 30_000, 60_000];
const ROUTE_RETRY_FOR_MS = 15 * 60_000;

function armRouteRetry(route) {
  disarmRouteRetry();
  const t = { route, hash: location.hash, gen: nav.routeGen, started: Date.now(), tries: 0, timer: null, busy: false };
  nav.retry = t;
  scheduleRouteRetry(t);
}

function disarmRouteRetry() {
  if (nav.retry) clearTimeout(nav.retry.timer);
  nav.retry = null;
}

function scheduleRouteRetry(t) {
  if (nav.retry !== t) return;
  if (Date.now() - t.started > ROUTE_RETRY_FOR_MS) { disarmRouteRetry(); return; }
  clearTimeout(t.timer);
  t.timer = setTimeout(() => void retryRoute(t), ROUTE_RETRY_MS[Math.min(t.tries++, ROUTE_RETRY_MS.length - 1)]);
}

/** Still the unresolved view this retry was armed for (nothing navigated since)? */
function routeRetryCurrent(t) {
  return nav.retry === t && nav.routeGen === t.gen && location.hash === t.hash
    && !state.current.sessionId && state.current.projectId === t.route.projectId
    // nothing begun in this view: no start in flight, no live bridge of its own
    && state.pendingStart == null && !state.live;
}

async function retryRoute(t) {
  if (!routeRetryCurrent(t)) { if (nav.retry === t) disarmRouteRetry(); return; }
  if (t.busy) return;
  // The user is typing in this view — do not swap the page under them; ask
  // again on the next tick (sending disarms this for good, via startTurn).
  if ((node.prompt?.value ?? '').trim()) { scheduleRouteRetry(t); return; }
  t.busy = true;
  let res = null;
  try {
    const p = state.projects.find((x) => x.id === t.route.projectId);
    if (p) res = await resolveRouteSession(p, t.route, { force: true });
  } catch { res = null; } finally { t.busy = false; }
  if (!routeRetryCurrent(t)) { if (nav.retry === t) disarmRouteRetry(); return; }
  if (res?.kind === 'open') { void applyRoute(t.route); return; }
  scheduleRouteRetry(t);
}

/** Called by the live poll: the id an unresolved link names just showed up. */
function nudgeRouteRetry(liveList) {
  const t = nav.retry;
  if (t && (liveList ?? []).some((x) => x.sessionId === t.route.sessionId)) void retryRoute(t);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && nav.retry) void retryRoute(nav.retry); });
