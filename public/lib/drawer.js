/**
 * The right slide-in drawer: Runtime / Access / Model / Permissions /
 * Instructions, plus the template library and its editor.
 *
 * Non-modal by design — it overlaps the transcript rather than squeezing it,
 * and the transcript stays live behind it.
 *
 * Scope: "Project default" writes straight through to the registry.
 * "This session" holds an override locally. Instruction overrides are real —
 * they ride the `start` command's templateIds. The other session-scope
 * overrides have nowhere to go on the wire yet (see README of the report);
 * the drawer says so rather than pretending.
 */
import { $, el, clear, shortPath, bytes, stamp, when } from './dom.js';
import * as api from './api.js';
import { createSlidePanel } from './slide-panel.js';

const MODEL_CYCLE = [null, 'opus', 'sonnet', 'haiku'];
const EFFORT_CYCLE = [null, 'low', 'medium', 'high', 'xhigh', 'max'];
const BUDGET_CYCLE = [null, 10, 25, 40];
const PERM_CYCLE = ['default', 'plan', 'acceptEdits', 'bypassPermissions'];
const ISO = {
  container: { g: '▣', n: 'Container' },
  sandbox: { g: '◑', n: 'Sandbox' },
  direct: { g: '○', n: 'Direct' },
};
const DOCKER_SOCK = '/var/run/docker.sock';

/** Build artefacts and caches: cheap to regenerate, ruinous to reflink-copy. */
const DEFAULT_EXCLUDE = ['node_modules', '.venv', 'venv', '__pycache__', 'target', 'dist', 'build', '.next', '.cache'];
const KEEP_CYCLE = [3, 5, 10, 20, 50];
const REASON_TEXT = {
  'session-start': 'taken when a session started',
  manual: 'taken by hand',
  'pre-restore': 'taken automatically before a restore',
};

/**
 * Fields a session may genuinely override — the wire carries all of these now.
 *
 * The exclusions are deliberate, not a gap: isolation, mounts and container.*
 * are rejected server-side with a fatal error, because honouring them per
 * session would mean rebuilding the container and leaking the change into
 * every other session on the project. So session scope must not offer them.
 */
const WIRED_IN_SESSION = new Set(['instructions', 'model', 'effort', 'permissionMode',
  'maxBudgetUsd', 'allowedTools', 'disallowedTools', 'provider']);
const PROJECT_ONLY = new Set(['isolation', 'mounts', 'container']);

export function createDrawer(ctx) {
  /* ctx: { getProject(), refreshProject(), overrides, notify(msg,isErr), onStackChanged() } */
  const d = {
    view: 'settings',
    back: null,
    scope: 'project',
    editing: null,
    templates: [],
    container: undefined, // undefined = not fetched, null = route missing
    composed: null,
    addingMount: false,
    armSocket: false,
    browser: undefined, // undefined = unfetched, null = route absent
    providers: undefined, // FEAT-037 P3: /api/providers verdicts (undefined = unfetched, null = route absent)
    snaps: undefined,   // undefined = unfetched, null = route absent
    /** The restore ceremony in progress: {id, typed, conflict, busy}. */
    restore: null,
    confirmDelete: null,
    git: undefined,      // undefined = unfetched, null = route absent, {…} = status
    procs: undefined,    // undefined = unfetched, null = route absent, [] = answer
    procConfirm: null,   // pid with an armed stop
    gitArm: null,        // 'push' | 'create' | 'init' — armed confirm
    gitMsg: '',          // commit message survives repaints
    gitBusy: false,
    memories: undefined, // undefined = unfetched, null = route absent, {…} = answer
    memOpen: null,       // `${dir}/${name}` currently expanded for reading
    memBody: new Map(),  // `${dir}/${name}` -> fetched content
    memConfirm: null,    // `${dir}/${name}` with an armed delete
    /* FEAT-076 wiring panel: undefined = unfetched, null = route absent, {…} = status */
    wiring: undefined,
    wiringBusy: null,    // check key currently applying
    wiringArm: null,     // check key with an armed "scaffold into <project>" confirm
    /* BUG-138 — the repoint panel: null = closed; {offer, arm, manual, busy,
       result}. `offer` undefined = fetching, null = route absent. Opening it
       writes nothing; only the armed confirm does. */
    repoint: null,
    wiringReport: null,  // { key, text } — the last Apply's exists-vs-created summary
    /** Section ids the user closed by hand — survives repaint, not reload
     *  (progressive disclosure should remember a choice within the visit,
     *  not fight the defaults that decide what's "advanced" every time). */
    sectClosed: new Set(),
    /**
     * FEAT-054 — the deep-link target a crown chip named: {key, applied}.
     * Every paint() re-applies the EXPANSION (async fetches repaint the view,
     * which would otherwise re-collapse the section under the user's eyes);
     * the scroll + one-shot highlight fire once. Cleared on close and on any
     * open() without a focus, so a plain cog open lands at the default top
     * and the user's own collapse choices (`sectClosed`) are never rewritten.
     */
    focus: null,
  };

  const node = {
    drawer: $('#drawer'),
    body: $('#dBody'),
    scope: $('#dScope'),
    hint: $('#dHint'),
    title: $('#dTitle'),
    eyebrow: $('#dEyebrow'),
    back: $('#dBack'),
    views: {
      settings: $('#vSettings'),
      globals: $('#vGlobals'),
      instructions: $('#vInstructions'),
      library: $('#vLibrary'),
      snapshots: $('#vSnapshots'),
      memories: $('#vMemories'),
    },
    editor: $('#vEditor'),
    edMeta: $('#edMeta'),
    edText: $('#edText'),
    edFoot: $('#edFoot'),
    edSave: $('#edSave'),
    edUse: $('#edUse'),
  };
  const slide = createSlidePanel(node.drawer, { useHidden: false });

  /* ---------------------------------------------------------- value model */

  const project = () => ctx.getProject();
  const settings = () => project()?.settings ?? {};

  function base(field) {
    if (field === 'isolation') return project()?.isolation ?? 'direct';
    return settings()[field];
  }

  /** EffectiveConfig from the live session, or null when nothing is running. */
  const live = () => ctx.getEffective?.() ?? null;

  /**
   * Is this field overridden *in reality*? A local edit not yet reflected by
   * the server (ctx.overrides) always wins for display — that is what governs
   * the NEXT session, and it is the thing the user just touched. Only once
   * there is no pending local edit do we fall back to the server's own report
   * of what the CURRENT live session is running with.
   */
  function overriddenNow(field) {
    if (d.scope !== 'session') return false;
    if (field in ctx.overrides) return true;
    const l = live();
    return l?.overridden ? l.overridden.includes(field) : false;
  }
  /**
   * ctx.overrides (the pending, not-yet-applied local edits) layered OVER
   * live.effective (the raw server-reported effective config) layered OVER
   * the project base. A just-made local edit must be visible immediately,
   * even while a session is live and its own effective config still reports
   * the old value.
   */
  function val(field) {
    if (d.scope === 'session' && field in ctx.overrides) return ctx.overrides[field];
    const l = live();
    if (d.scope === 'session' && l?.effective && field in l.effective) return l.effective[field];
    return base(field);
  }
  const isOvr = (field) => overriddenNow(field);

  async function put(field, value) {
    if (d.scope === 'session') {
      if (JSON.stringify(value) === JSON.stringify(base(field))) delete ctx.overrides[field];
      else ctx.overrides[field] = value;
      ctx.onStackChanged?.();
      paint();
      return;
    }
    try {
      await api.patchProject(project().id, { [field]: value });
      await ctx.refreshProject();
      ctx.onStackChanged?.();
      d.composed = null;
      paint();
    } catch (err) {
      ctx.notify(`could not save ${field}: ${err.message}`, true);
      paint();
    }
  }

  function cycle(field, list) {
    const cur = val(field);
    const i = list.findIndex((x) => JSON.stringify(x) === JSON.stringify(cur));
    void put(field, list[(i + 1) % list.length]);
  }

  const show = (v) =>
    v === null || v === undefined || v === '' ? 'inherit' : Array.isArray(v) ? (v.length ? v.join(', ') : 'none') : String(v);

  /* ------------------------------------------------------------- rows */

  function row(field, label, flag, opts = {}) {
    const cycleList = opts.cycle;
    const tag = cycleList ? 'button' : 'div';
    const n = el(tag, { class: 'set' });
    if (cycleList) {
      n.title = 'Click to change';
      n.addEventListener('click', () => cycle(field, cycleList));
    }
    n.append(el('span', { class: 'l', text: label }, flag ? el('span', { class: 'f', text: flag }) : null));
    const v = el('span', { class: `v${opts.dim ? ' dim' : ''}` });
    if (isOvr(field)) v.append(el('span', { class: 'ovr', text: 'overridden' }));
    else if (d.scope === 'session' && cycleList) v.append(el('span', { class: 'inh', text: 'inherited' }));
    v.append(document.createTextNode(opts.text ?? show(val(field))));
    if (isOvr(field)) {
      const rev = el('span', {
        class: 'rev',
        role: 'button',
        tabindex: '0',
        'aria-label': 'Revert to project default',
        title: `Revert to the project default (${show(base(field))})`,
        text: '↩',
      });
      rev.addEventListener('click', (e) => {
        e.stopPropagation();
        delete ctx.overrides[field];
        ctx.onStackChanged?.();
        paint();
      });
      v.append(rev);
    }
    n.append(v);
    return n;
  }

  function listRow(field, label, flag) {
    const n = el('div', { class: 'set' });
    n.append(el('span', { class: 'l', text: label }, el('span', { class: 'f', text: flag })));
    const cur = val(field) ?? [];
    const input = el('input', {
      class: 'vin',
      type: 'text',
      spellcheck: 'false',
      placeholder: 'none',
      'aria-label': label,
    });
    input.value = Array.isArray(cur) ? cur.join(', ') : '';
    const commit = () => {
      const next = input.value.split(',').map((s) => s.trim()).filter(Boolean);
      if (JSON.stringify(next) === JSON.stringify(cur)) return;
      void put(field, next);
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      }
    });
    n.append(input);
    return n;
  }

  const groupLabel = (t) => el('div', { class: 'grp-l', text: t });
  const note = (t) => el('div', { class: 'grp-note', text: t });

  /**
   * A themed section of the settings view: a native <details> so expand/
   * collapse needs no state of its own and is free for screen readers and
   * keyboard users alike. `opened` sets the default state on first paint —
   * every repaint rebuilds the DOM, so a section the user closed by hand
   * would spring back open on the next paint; `d.sectClosed` remembers which
   * ones a user explicitly closed so a later paint (e.g. after a setting
   * changes) does not re-open them under the user's fingers.
   */
  function section(id, label, opened, kids) {
    const present = kids.filter(Boolean);
    if (!present.length) return null;
    const s = el('details', { class: 'sect', 'data-sect': id });
    s.open = d.sectClosed.has(id) ? false : opened;
    s.addEventListener('toggle', () => {
      // FEAT-054: a deep-link expansion is for THIS visit only — it must not
      // rewrite the user's remembered collapse choice. The flag is one-shot:
      // the very next (i.e. user-driven) toggle records normally again.
      if (s.dataset.ephemeralOpen === '1') { delete s.dataset.ephemeralOpen; return; }
      if (s.open) d.sectClosed.delete(id);
      else d.sectClosed.add(id);
    });
    const sum = el('summary', { class: 'sect-l' },
      el('span', { class: 'sect-car', 'aria-hidden': 'true' }),
      el('span', { text: label }));
    s.append(sum);
    for (const k of present) s.append(k);
    return s;
  }

  /* ------------------------------------- BUG-138: the working directory */

  /**
   * Which host directory this project maps to — and, when that directory is
   * gone, the way back from where the user is standing.
   *
   * The reported failure was a session that showed the bare word "Error"
   * because the project's directory had been renamed. Two things were missing,
   * not one: the failure never named the path, and even once named there was no
   * way to follow the rename except hand-editing registry.json.
   *
   * The rules this block enforces, because they are the ones that can lose
   * something:
   *  - NOTHING IS WRITTEN until the user confirms a specific directory. Opening
   *    this, listing candidates, even Orchard being certain, writes nothing.
   *  - A candidate is a MATCH only against the project's recorded identity.
   *    Name resemblance is never enough — see registry.repointCandidates.
   *  - Repointing CARRIES THE SESSIONS (the server records the old path and
   *    keeps listing its store dir), and the result line says so with a count,
   *    because "did I just lose my history" is the actual worry.
   *  - It is reversible: rename the directory back, or repoint again, and
   *    nothing is stranded. No file is moved either way.
   */
  function directoryBlock(p) {
    const missing = p.pathMissing === true;
    const box = el('div', { class: 'proj-dir-box', 'data-missing': missing ? 'true' : 'false' });

    const dir = el('div', { class: 'proj-dir', title: p.hostPath });
    dir.append(el('span', { class: 'k', text: 'Directory' }));
    dir.append(el('code', { class: 'v', text: shortPath(p.hostPath) }));
    if (d.scope !== 'session') {
      const change = el('button', { class: 'addrow dir-change', text: d.repoint ? 'Close' : (missing ? 'Fix…' : 'Change…') });
      change.addEventListener('click', () => {
        if (d.repoint) { d.repoint = null; paint(); return; }
        openRepoint(p);
      });
      dir.append(change);
    }
    box.append(dir);

    if (missing) {
      const warn = el('div', { class: 'dir-gone' });
      warn.append(el('b', { text: 'This directory is gone.' }));
      warn.append(document.createTextNode(
        ` Orchard still has “${p.name}” recorded at ${p.hostPath}, and nothing is there now — sessions can’t start.`
        + ' Nothing has been changed on your side: restore or rename the directory back and it simply works again.'
        + ' Or point this project at its new location — its existing sessions come with it.'));
      box.append(warn);
    }
    if (!missing && (p.pastPaths ?? []).length) {
      const prev = el('div', { class: 'grp-note' });
      prev.append(document.createTextNode('Previously at '));
      prev.append(el('code', { text: (p.pastPaths ?? []).map(shortPath).join(', ') }));
      prev.append(document.createTextNode(' — sessions recorded there are still listed under this project.'));
      box.append(prev);
    }
    if (d.repoint) box.append(repointPanel(p));
    return box;
  }

  function openRepoint(p) {
    d.repoint = { offer: undefined, arm: null, manual: '', busy: false, result: null };
    paint();
    api.repointCandidates(p.id)
      .then((offer) => { if (d.repoint) d.repoint.offer = offer; paint(); })
      .catch(() => { if (d.repoint) d.repoint.offer = null; paint(); });
  }

  function repointPanel(p) {
    const r = d.repoint;
    const panel = el('div', { class: 'repoint' });

    if (r.result) {
      const ok = el('div', { class: 'grp-note' });
      ok.dataset.ok = 'true';
      ok.textContent = r.result;
      panel.append(ok);
      return panel;
    }
    if (r.offer === undefined) {
      panel.append(note('Looking for where it might have gone…'));
      return panel;
    }

    /* Say plainly how much the offer below is worth, BEFORE listing it. */
    if (r.offer && r.offer.cannotDecide) {
      panel.append(note(`Orchard can’t tell which directory this is: ${r.offer.cannotDecide}`));
    } else if (r.offer && r.offer.unambiguous) {
      panel.append(note(`One directory matches this project’s recorded identity (git origin ${r.offer.identity.remoteUrl}). It still needs your confirmation — Orchard never repoints on its own.`));
    }

    for (const c of (r.offer?.candidates ?? []).slice(0, 12)) {
      const armed = r.arm === c.hostPath;
      const row = el('div', { class: 'cand', 'data-conf': c.confidence });
      const top = el('div', { class: 'top' },
        el('code', { class: 'p', text: shortPath(c.hostPath), title: c.hostPath }));
      if (c.confidence === 'match') top.append(el('span', { class: 'badge', text: 'matches this project' }));
      if (!armed) {
        const pick = el('button', { class: 'addrow', text: 'Point here…' });
        pick.addEventListener('click', () => { d.repoint.arm = c.hostPath; paint(); });
        top.append(pick);
      }
      row.append(top);
      if (c.remoteUrl) row.append(el('div', { class: 'why', text: `git origin ${c.remoteUrl}` }));
      else row.append(el('div', { class: 'why', text: 'not a git repository — nothing to match on' }));
      if (armed) row.append(confirmRepoint(p, c.hostPath));
      panel.append(row);
    }

    /* Always a manual path: the right directory may be nowhere near the old one. */
    const manual = el('div', { class: 'cand', 'data-conf': 'manual' });
    const mrow = el('div', { class: 'top' });
    const input = el('input', { class: 'dir-input', type: 'text', placeholder: '/path/to/the/directory', value: r.manual });
    input.addEventListener('input', () => { d.repoint.manual = input.value; });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim()) { d.repoint.manual = input.value; d.repoint.arm = input.value.trim(); paint(); }
    });
    const go = el('button', { class: 'addrow', text: 'Point here…' });
    go.addEventListener('click', () => {
      const v = (d.repoint.manual || '').trim();
      if (v) { d.repoint.arm = v; paint(); }
    });
    mrow.append(input, go);
    manual.append(mrow);
    if (r.arm && !(r.offer?.candidates ?? []).some((c) => c.hostPath === r.arm)) manual.append(confirmRepoint(p, r.arm));
    panel.append(manual);
    return panel;
  }

  /** The armed confirm. This is the only thing here that writes anything. */
  function confirmRepoint(p, hostPath) {
    const wrap = el('div', { class: 'wiring-confirm' });
    wrap.append(note(
      `Point “${p.name}” at ${hostPath}. Nothing inside either directory is touched, and the sessions recorded under `
      + `${shortPath(p.hostPath)} stay listed under this project — Orchard remembers the old path instead of moving any files. `
      + 'Reversible: repoint again, or rename the directory back, and nothing is stranded.'));
    const no = el('button', { class: 'addrow', text: 'Cancel' });
    no.addEventListener('click', () => { d.repoint.arm = null; paint(); });
    const yes = el('button', { class: 'addrow wiring-go', text: d.repoint.busy ? 'Working…' : 'Point it here' });
    if (d.repoint.busy) yes.disabled = true;
    yes.addEventListener('click', () => void applyRepoint(p, hostPath));
    wrap.append(no, yes);
    return wrap;
  }

  async function applyRepoint(p, hostPath) {
    d.repoint.busy = true;
    paint();
    try {
      const out = await api.repointProject(p.id, hostPath);
      const pc = out.pathChange;
      d.repoint.busy = false;
      d.repoint.arm = null;
      d.repoint.result = pc
        ? `“${p.name}” now points at ${pc.to}. ${pc.carriedSessions} session${pc.carriedSessions === 1 ? '' : 's'} still listed here, including everything recorded under ${pc.from} — no files were moved.`
        : `“${p.name}” already points at ${hostPath}.`;
      await ctx.refreshProject();
      await ctx.onPathChanged?.(p.id);
      ctx.onStackChanged?.();
      paint();
    } catch (err) {
      d.repoint.busy = false;
      d.repoint.arm = null;
      ctx.notify(`could not repoint: ${err.message}`, true);
      paint();
    }
  }

  /* ------------------------------------------------------- settings view */

  function settingsView() {
    const p = project();
    const wrap = document.createDocumentFragment();
    if (!p) {
      wrap.append(el('div', { class: 'grp' }, note('No project selected.')));
      return wrap;
    }
    const iso = project()?.isolation ?? 'direct';
    const sessionScope = d.scope === 'session';
    const isContainer = iso === 'container';

    /* FEAT-071 — which host directory this project maps to. After a rename or a
       relocation the display name and the path can diverge (name "orchard", path
       elsewhere), so a quiet reference line at the top of the settings drawer
       says which directory is actually in play. shortPath for display, full path
       on hover (title) — leak-hygiene and discoverability in one line. */
    if (p.hostPath) wrap.append(directoryBlock(p));

    /* ---- Model & behaviour: the settings almost every session touches ---- */
    // FEAT-118: pull the machine-wide defaults so the Model row can say what an
    // unset value actually inherits, instead of the bare word "inherit".
    ensureGlobals();
    const gModel = d.globals?.model ?? null;
    const model = el('div', { class: 'grp' }, groupLabel('Model'));
    const modelInheritsGlobal = !sessionScope && val('model') == null && gModel;
    // FEAT-118: cycle over the SAME derived catalog the header popover and the
    // global-defaults picker use (d.modelCatalog, filled by ensureGlobals from
    // the CLI's own supportedModels) — so a versioned model the CLI reports is
    // reachable here too, not just the three hand-written aliases. Until that
    // list is learned (first session), fall back to the alias cycle so the row
    // is never dead. Labels come from modelLabel, so a raw value like
    // 'claude-fable-5[1m]' still shows its friendly name.
    const mCatalog = d.modelCatalog ?? [];
    const modelCycle = mCatalog.length ? [null, ...mCatalog.map((m) => m.value)] : MODEL_CYCLE;
    const mVal = val('model');
    model.append(row('model', 'Model', '--model', {
      cycle: modelCycle,
      text: modelInheritsGlobal
        ? `global default · ${modelLabel(gModel)}`
        : (mVal != null ? modelLabel(mVal) : undefined),
    }));
    model.append(row('effort', 'Effort', '--effort', { cycle: EFFORT_CYCLE }));
    model.append(row('maxBudgetUsd', 'Spend cap', '--max-budget-usd', {
      cycle: BUDGET_CYCLE,
      text: val('maxBudgetUsd') == null ? 'none' : `$${Number(val('maxBudgetUsd')).toFixed(2)}`,
    }));
    if (!sessionScope) {
      const gLink = el('button', { class: 'addrow', text: gModel
        ? `Machine-wide default: ${modelLabel(gModel)} · manage ›`
        : 'Set a machine-wide default model ›' });
      gLink.addEventListener('click', () => open('globals', 'settings'));
      model.append(gLink);
    }

    const perms = el('div', { class: 'grp', 'data-focus': 'permissionMode' }, groupLabel('Permissions'));
    perms.append(row('permissionMode', 'Permission mode', '--permission-mode', { cycle: PERM_CYCLE }));
    const pn = permModeNote();
    if (pn) perms.append(pn);
    perms.append(listRow('allowedTools', 'Allowed tools', '--allowed-tools'));
    perms.append(listRow('disallowedTools', 'Disallowed tools', '--disallowed-tools'));

    wrap.append(section('model', 'Model & behaviour', true, [model, perms]));

    /* ---- Isolation & environment: the isolation tier, plus the settings
       that ONLY mean something once a container exists to hold them. Mounts
       and the docker-socket flag are rejected server-side outside a
       container, so showing them there would be a dead option — they render
       here, gated on `isContainer`, instead of always. ---- */
    const runtime = el('div', { class: 'grp', 'data-focus': 'iso' }, groupLabel('Isolation'));
    const seg = el('div', { class: 'seg' });
    for (const [key, meta] of Object.entries(ISO)) {
      const b = el('button', { 'aria-pressed': iso === key ? 'true' : 'false' },
        el('span', { class: 'g', text: meta.g }), document.createTextNode(meta.n));
      if (sessionScope) b.disabled = true;
      else b.addEventListener('click', () => put('isolation', key));
      seg.append(b);
    }
    runtime.append(seg);
    if (sessionScope) runtime.append(projectOnlyNote('Isolation'));
    if (isContainer) runtime.append(containerBlock(p, sessionScope));
    else {
      runtime.append(note(
        iso === 'sandbox'
          ? 'No container. Work happens on this machine, with writes confined to the project directory.'
          : 'No container. Work happens on this machine with nothing held back.',
      ));
    }

    /* Access — container-only. Hidden entirely (not just disabled) when
       isolation isn't container: there is nothing here that applies. */
    let access = null;
    if (isContainer) {
      access = el('div', { class: 'grp', 'data-focus': 'mounts' }, groupLabel('Access'));
      const mounts = settings().mounts ?? [];
      for (const [i, m] of mounts.entries()) {
        const r = el('div', { class: 'mrow' });
        r.append(el('span', { class: 'p' },
          document.createTextNode(shortPath(m.hostPath)),
          el('span', { class: 'to', text: ' → ' }),
          el('span', { class: 'dst', text: m.containerPath || '/workspace' })));
        r.append(el('span', { class: 'm', text: m.readOnly ? 'ro' : 'rw' }));
        if (!sessionScope) {
          const x = el('button', { class: 'x', 'aria-label': 'Remove mount', text: '×' });
          x.addEventListener('click', () => put('mounts', mounts.filter((_, j) => j !== i)));
          r.append(x);
        }
        access.append(r);
      }
      if (!sessionScope) {
        if (d.addingMount) access.append(mountForm(mounts));
        else {
          const add = el('button', { class: 'addrow', text: '+ Add mount' });
          add.addEventListener('click', () => { d.addingMount = true; paint(); });
          access.append(add);
        }
      }
      access.append(dockerSocketBlock(sessionScope));
      if (sessionScope) access.append(projectOnlyNote('Mounts and the socket flag'));
    }

    /* Snapshots sits in this section deliberately: isolation is the layer
       that PREVENTS damage, snapshots are the layer that UNDOES it, and a
       container does not undo anything because it bind-mounts the real dir. */
    wrap.append(section('iso', 'Isolation & environment', true,
      [runtime, access, servicesGroup(p, sessionScope), snapshotsGroup(p, sessionScope)]));

    /* ---- Instructions & tools: the working-agreement stack and the
       attachable integrations (browser, MCPs) a session can reach for. ---- */
    const ins = el('div', { class: 'grp', 'data-focus': 'instructions' }, groupLabel('Instructions'));
    const stack = effectiveStack();
    ins.append(stackSummaryRow('CLAUDE.md', 'file'));
    for (const s of stack.filter((x) => x.enabled)) {
      ins.append(stackSummaryRow(nameOf(s.templateId), s.mode ?? modeOf(s.templateId)));
    }
    const go = el('button', { class: 'addrow', text: 'Edit the instruction stack ›' });
    go.addEventListener('click', () => open('instructions', 'settings'));
    ins.append(go);

    wrap.append(section('instr', 'Instructions & tools', true,
      [ins, providerGroup(sessionScope), integrationsGroup(p, sessionScope), responseFormatGroup(p, sessionScope)]));

    /* ---- Wiring: is this project actually using our METHODOLOGY (WA, local
       conventions, ticket board, drift-guard) — computed live from the registry
       and files on disk, with one-click Apply for each missing layer. ---- */
    wrap.append(section('wiring', 'Wiring', true, [wiringGroup(p, sessionScope)]));

    /* ---- Advanced: project housekeeping that's rare enough to earn its
       collapse — memories, git, and stray processes. Common settings stay
       above, uncollapsed; this is the progressive-disclosure tier. ---- */
    wrap.append(section('advanced', 'Advanced', false,
      [memoriesGroup(p), gitGroup(p), processesGroup(p)]));

    if (d.scope === 'session') {
      const l = live();
      if (l?.ignoredOverrides?.length) {
        wrap.append(el('div', { class: 'grp' }, note(
          `The server accepted but could not honour: ${l.ignoredOverrides.map((i) => `${i.field} (${i.reason})`).join('; ')}.`)));
      } else if (l) {
        wrap.append(el('div', { class: 'grp' }, note(
          l.overridden?.length
            ? `Live session is running with ${l.overridden.join(', ')} overridden. These values are read back from the session, not from what was requested.`
            : 'Live session is running on the project defaults — no override changed a value.')));
      } else {
        wrap.append(el('div', { class: 'grp' }, note(
          'These apply to the next session you start from this project. They are never written to the registry.')));
      }
    }
    return wrap;
  }

  /**
   * FEAT-037 P3 — which ENGINE runs this project's sessions. A real setting
   * (settings.provider, session-overridable like model), not a dead label: the
   * AgentSession constructor picks ClaudeRuntime vs CodexRuntime from exactly
   * this value. The OpenAI row shows the LIVE detectCodex() verdict from
   * /api/providers — connected / installed-not-signed-in / not-installed —
   * and selecting it while not connected is allowed but clearly marked (the
   * launch then fails honestly with the same hint).
   */
  function providerGroup(sessionScope) {
    const grp = el('div', { class: 'grp' }, groupLabel('Provider'));
    const cur = val('provider') ?? 'anthropic';
    const seg = el('div', { class: 'seg prov-seg' });
    for (const o of [
      { key: 'anthropic', g: '✳', n: 'Claude' },
      { key: 'openai', g: '⌬', n: 'OpenAI Codex' },
    ]) {
      const b = el('button', { 'data-prov': o.key, 'aria-pressed': String(cur === o.key) },
        el('span', { class: 'g', text: o.g }), document.createTextNode(o.n));
      b.addEventListener('click', () => {
        if (cur === o.key) return;
        // Session scope: picking the project's own default is "no override" —
        // clear it rather than storing an override equal to the default
        // (base() can be undefined on registries older than this field).
        if (d.scope === 'session' && o.key === (base('provider') ?? 'anthropic')) {
          delete ctx.overrides.provider;
          ctx.onStackChanged?.();
          paint();
          return;
        }
        void put('provider', o.key);
      });
      seg.append(b);
    }
    grp.append(seg);
    if (isOvr('provider')) grp.append(note('Overridden for this session only — the next launch uses this engine; the project default is untouched.'));
    else if (sessionScope) grp.append(note('Applies to the next session launched from here.'));

    if (d.providers === undefined) {
      grp.append(note('Checking provider availability…'));
      void refreshProviders();
    } else if (d.providers === null) {
      grp.append(note('This server has no /api/providers route yet; provider state is unknown.'));
    } else {
      const oai = d.providers.openai;
      const st = el('div', { class: 'prov-state', 'data-status': oai?.status ?? 'unknown' },
        el('span', { class: 'dot' }),
        document.createTextNode(oai?.label ?? 'OpenAI Codex — state unknown'));
      grp.append(st);
      if (oai && oai.status !== 'connected' && oai.hint) grp.append(note(`${oai.hint}`));
      if (cur === 'openai' && oai && oai.status !== 'connected') {
        const warn = note('Selected, but not connected — launching a session will fail with the hint above until Codex is signed in (docs/PROVIDERS.md).');
        warn.dataset.warn = 'true';
        grp.append(warn);
      } else if (cur === 'openai') {
        grp.append(note('Codex sessions bill to your ChatGPT subscription. Honest gray-outs: no dollar cost or spend cap, no subagent panel, no plan mode, no detach-and-follow/fork, no station-attached MCP tools yet.'));
      }
    }
    return grp;
  }

  async function refreshProviders() {
    try {
      d.providers = await api.optional('/api/providers').then((r) => (r ? r.providers : null));
    } catch {
      d.providers = null;
    }
    paint();
  }

  /**
   * Attachable integrations. Same shape as the container block: a stored
   * enable flag in the registry, plus live state from a status route that may
   * not exist yet.
   */
  function integrationsGroup(p, readOnly) {
    const grp = el('div', { class: 'grp', 'data-focus': 'integrations' }, groupLabel('Integrations'));
    const on = settings().browser?.enabled === true;

    const row = el('div', { class: 'risk', 'data-on': String(on) });
    const sw = el('button', { class: 'sw', 'aria-pressed': String(on), 'aria-label': 'Toggle the project browser' }, el('i'));
    if (readOnly) sw.disabled = true;
    else sw.addEventListener('click', () => void putBrowser({ enabled: !on }));
    row.append(el('div', { class: 'top' },
      el('span', { class: 'l' }, document.createTextNode('Browser'), el('span', { class: 'f', text: '--settings › browser.enabled' })),
      sw));
    // FEAT-051 — the terse when-to-use line, same wording as the crown chip's hover.
    row.append(el('div', { class: 'use1', text: 'real profile, stays logged in, survives bot checks' }));

    const why = el('div', { class: 'why' });
    why.append(document.createTextNode(on
      ? 'On. Sessions in this project can navigate, read rendered pages, screenshot, click and type — which is how they reach pages that refuse a plain fetch. '
      : 'Off. Turning it on gives this project’s sessions a real browser, for pages that refuse a plain fetch. '));
    why.append(el('code', { text: 'browser.enabled' }));
    // The two things a user will otherwise learn the hard way.
    why.append(el('br'), document.createTextNode(
      'The browser profile persists per project, so logins and cookies carry between sessions; sites behind hard Cloudflare are not reliably reachable, and a cold profile is challenged more than a warmed one.'));
    row.append(why);
    grp.append(row);

    if (on) grp.append(browserState(p, readOnly));

    grp.append(toolToggleRow(readOnly, {
      key: 'serena',
      default: true,
      name: 'Serena (LSP)',
      use: 'symbol-level code navigation (LSP)',
      field: '--settings › tools.serena',
      code: 'tools.serena',
      onText: 'On. This project’s sessions get Serena’s symbol-level code tools (find_symbol, find_referencing_symbols, replace_symbol_body…) backed by a language server — token-efficient navigation and edits on large files. Default for this repo. ',
      offText: 'Off. Turning it on attaches Serena’s LSP-backed symbol tools, better than grep+read on large typed repos. ',
      tail: 'Language servers are auto-provisioned per project language; polyglot or throwaway projects may prefer it off to skip the cold-start.',
    }));

    grp.append(toolToggleRow(readOnly, {
      key: 'playwright',
      default: false,
      name: 'Playwright',
      use: 'clean headless browser for repeatable UI tests',
      field: '--settings › tools.playwright · UI testing',
      code: 'tools.playwright',
      onText: 'On. This project’s sessions can drive a real browser via the Playwright MCP — navigate, click, fill and assert — for building and testing UI. ',
      offText: 'Off. A UI-testing tool: turn it on for projects with a web UI so sessions can automate a browser for end-to-end checks. ',
      // BUG-135: was "Fetched on demand the first time a session uses it" — the
      // pre-BUG-108 reality. Playwright is now a pinned local install attached at
      // launch, never fetched, so "on demand" told the user to expect it to turn
      // up mid-session. It does not; that wording is part of what this bug was.
      tail: 'Attached at session launch from a pinned local install — never downloaded on demand; most non-UI projects should leave it off.',
    }));

    grp.append(toolToggleRow(readOnly, {
      key: 'openaiDispatch', default: false, name: 'OpenAI dispatch',
      use: 'dispatch work through the host without exposing Codex credentials',
      field: '--settings › tools.openaiDispatch', code: 'tools.openaiDispatch',
      onText: 'On. New sessions can dispatch OpenAI work through a project-scoped host broker. ',
      offText: 'Off. OpenAI dispatch is unavailable and the session is told which toggle enables it. ',
      tail: 'Attached at session launch; credentials and the Codex binary remain on the host.',
    }));

    // BUG-135 — the enabled-but-not-in-this-session gap. The note below only
    // ever fired in SESSION scope (readOnly), where the switches are disabled
    // anyway. In PROJECT scope the user flips Playwright on, the row says "On.
    // This project's sessions can drive a real browser", and the session they
    // are looking at still has no Playwright — with nothing anywhere saying why.
    // Name the specific tools that are enabled here and absent there.
    grp.append(...pendingAttachNote());
    // BUG-088: in session scope every switch above is disabled (readOnly). Say
    // WHY — otherwise the toggles just look broken. The browser and the
    // attachable MCP tools are baked into the mcpServers config at launch, so a
    // running session cannot attach or detach them; they are project-wide only.
    if (readOnly) grp.append(note(
      'Browser and the attachable MCP tools (Serena, Playwright) are decided when a session launches and apply to the whole project — a running session can’t attach or detach them. Switch to “Project default” to change them.'));
    return grp;
  }

  /* Human names for the attachable MCP servers, keyed by the `mcp__<name>__`
     prefix a live session's tool list exposes. Mirrors app.js INTEG_META. */
  const INTEG_NAMES = { 'stealth-browser': 'Browser', serena: 'Serena', playwright: 'Playwright' };

  /**
   * BUG-135 — "enabled for this project, missing from the session you're in".
   *
   * `mcpServers` is baked into the launch config once, in AgentSession's
   * constructor (server: tools.ts#plannedMcpServers), so flipping a toggle while
   * a session runs changes the NEXT launch and nothing about the current one.
   * That is correct behaviour and was never surfaced anywhere the user flips the
   * switch — so an enabled Playwright that never appeared read as a broken tool.
   *
   * Returns [] unless a live session actually REPORTED its tool list: with no
   * report (no session, a reattach whose init we never saw, or a foreign
   * selection — getLiveTools routes through the BUG-106 dock gate) we know
   * nothing about the real attach and must not invent a discrepancy.
   */
  function pendingAttachNote() {
    const tools = ctx.getLiveTools?.();
    if (!Array.isArray(tools)) return [];
    const attached = new Set();
    for (const t of tools) {
      const m = /^mcp__(.+?)__/.exec(String(t));
      if (m) attached.add(m[1]);
    }
    // A session that reported NO mcp tools at all is more likely a runtime with
    // MCP off (Codex) than three simultaneous discrepancies; the provider group
    // already says so. Don't double-report it here.
    if (attached.size === 0) return [];
    const t0 = effectiveTools();
    const enabled = [
      settings().browser?.enabled === true ? 'stealth-browser' : null,
      t0.serena ? 'serena' : null,
      t0.playwright ? 'playwright' : null,
    ].filter(Boolean);
    const missing = enabled.filter((k) => !attached.has(k));
    if (missing.length === 0) return [];
    const names = missing.map((k) => INTEG_NAMES[k] ?? k);
    const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    return [note(
      `${list} ${names.length === 1 ? 'is' : 'are'} enabled for this project but ${names.length === 1 ? 'is' : 'are'} NOT in the session you are looking at. `
      + 'MCP tools are attached once, when a session launches — enabling one now applies to the next session, not this one. Start a new session to use it.',
    )];
  }

  /* One attachable-tool toggle (Serena / Playwright). Same row idiom as the
     browser toggle above; writes settings.tools.<key> through putTools. */
  function toolToggleRow(readOnly, spec) {
    // Mirror the server defaults (registry.ts defaultToolSettings): a project
    // stored before `tools` existed has no key, and Serena is default-ON — so an
    // absent value must render ON, matching what a launched session gets.
    const stored = settings().tools?.[spec.key];
    const on = typeof stored === 'boolean' ? stored : spec.default;
    const row = el('div', { class: 'risk', 'data-on': String(on) });
    const sw = el('button', { class: 'sw', 'aria-pressed': String(on), 'aria-label': `Toggle ${spec.name}` }, el('i'));
    if (readOnly) sw.disabled = true;
    else sw.addEventListener('click', () => void putTools({ [spec.key]: !on }));
    row.append(el('div', { class: 'top' },
      el('span', { class: 'l' }, document.createTextNode(spec.name), el('span', { class: 'f', text: spec.field })),
      sw));
    // FEAT-051 — terse when-to-use, mirrored on the crown chip's hover.
    if (spec.use) row.append(el('div', { class: 'use1', text: spec.use }));
    const why = el('div', { class: 'why' });
    why.append(document.createTextNode(on ? spec.onText : spec.offText));
    why.append(el('code', { text: spec.code }));
    why.append(el('br'), document.createTextNode(spec.tail));
    row.append(why);
    return row;
  }

  /* Mirror registry.ts defaultToolSettings(): a project stored before `tools`
     existed (or one with only one key set) has an absent/partial stored object. */
  const TOOL_DEFAULTS = { serena: true, playwright: false, openaiDispatch: false };

  /* The full {serena, playwright} state this project would launch with, defaults
     filled — the same resolution toolToggleRow uses to render each switch. */
  function effectiveTools() {
    const t = settings().tools ?? {};
    return {
      serena: typeof t.serena === 'boolean' ? t.serena : TOOL_DEFAULTS.serena,
      playwright: typeof t.playwright === 'boolean' ? t.playwright : TOOL_DEFAULTS.playwright,
      openaiDispatch: typeof t.openaiDispatch === 'boolean' ? t.openaiDispatch : TOOL_DEFAULTS.openaiDispatch,
    };
  }

  async function putTools(patch) {
    try {
      /*
       * BUG-088: send the COMPLETE tool state, not a one-key partial.
       *
       * The server persists tools correctly (validate.ts copies + updateProject
       * merges against defaults), but api.patchProject's echo-check compares the
       * object it SENT against the object the server ECHOES key-for-key. On a
       * project whose stored `settings.tools` is absent/partial (any project
       * predating FEAT-025), sending `{playwright:true}` made the server echo the
       * defaults-filled `{serena:true, playwright:true}` — a superset — which the
       * echo-check read as "did not persist". Sending the resolved full object
       * (defaults included) makes sent === echoed, so a real save stops being
       * reported as a failure. Fresh projects already stored a full object and so
       * never hit this; only older projects did.
       */
      await api.patchProject(project().id, { tools: { ...effectiveTools(), ...patch } });
      await ctx.refreshProject();
      paint();
    } catch (err) {
      ctx.notify(`could not save tool settings: ${err.message}`, true);
      paint();
    }
  }

  /* ---------------------------------------- response format (FEAT-084) */
  /*
   * The per-project `orchard-digest` control. ONE enable flag gates BOTH the
   * transcript renderer (client-side) AND the system-prompt injection at launch
   * (server-side, templates.ts#responseFormatSection via agent-bridge) — the same
   * `responseDigest.enabled` flag on both sides, so they can never disagree and
   * strand content. When on, an optional free-text `guidance` nudge rides into
   * the injected section under a `## Project override` subhead; it steers only
   * tone/verbosity and is validated server-side (≤600 chars, control-char
   * rejected). Project-scope only — it shapes every session's system prompt, so
   * it is not a per-session override.
   */
  const GUIDANCE_MAX = 600;

  /* Full {enabled, guidance} state this project would launch with, defaults
     filled — mirrors registry.ts defaultResponseDigestSettings (enabled default
     ON). Sent whole to patchProject so the echo-check sees the sent leaves. */
  function effectiveDigest() {
    const d0 = settings().responseDigest ?? {};
    return {
      enabled: d0.enabled !== false,
      guidance: typeof d0.guidance === 'string' ? d0.guidance : null,
    };
  }

  function responseFormatGroup(p, readOnly) {
    const grp = el('div', { class: 'grp', 'data-focus': 'responseDigest' }, groupLabel('Response format'));
    const cfg = settings().responseDigest ?? {};
    const on = cfg.enabled !== false; // default ON — mirror the server default

    const row = el('div', { class: 'risk', 'data-on': String(on) });
    const sw = el('button', { class: 'sw', 'aria-pressed': String(on), 'aria-label': 'Toggle the response digest' }, el('i'));
    if (readOnly) sw.disabled = true;
    else sw.addEventListener('click', () => void putResponseDigest({ enabled: !on }));
    row.append(el('div', { class: 'top' },
      el('span', { class: 'l' }, document.createTextNode('Response digest'),
        el('span', { class: 'f', text: '--settings › responseDigest.enabled' })),
      sw));
    row.append(el('div', { class: 'use1', text: 'scannable orchard-digest summary atop substantive replies' }));
    const why = el('div', { class: 'why' });
    why.append(document.createTextNode(on
      ? 'On. Sessions here are instructed to lead substantive replies with the orchard-digest envelope, and the transcript lifts it into a scannable summary. '
      : 'Off. Neither injected nor parsed — plain prose only, and no tokens spent on the instruction. '));
    why.append(el('code', { text: 'responseDigest.enabled' }));
    row.append(why);
    grp.append(row);

    if (on) grp.append(guidanceRow(readOnly, cfg));
    if (readOnly) grp.append(note(
      'The response format is project-wide — it shapes every session’s system prompt, so a running session can’t change it. Switch to “Project default” to edit.'));
    return grp;
  }

  /* The optional per-project guidance textarea + live character count. Shown
     only when the digest is enabled. Persists on blur when the trimmed value
     actually changed (empty → cleared to null). */
  function guidanceRow(readOnly, cfg) {
    const wrap = el('div', { class: 'digest-guidance' });
    const cur = typeof cfg.guidance === 'string' ? cfg.guidance : '';
    const ta = el('textarea', {
      class: 'vin guidance-in',
      rows: '3',
      maxlength: String(GUIDANCE_MAX),
      spellcheck: 'true',
      placeholder: 'Optional per-project nudge — verbosity, detail, style, when to emit. Steers tone only; the JSON format stays fixed.',
      'aria-label': 'Response-format guidance',
    });
    ta.value = cur;
    if (readOnly) ta.disabled = true;
    const count = el('div', { class: 'grp-note guidance-count' });
    const paintCount = () => { count.textContent = `${ta.value.length} / ${GUIDANCE_MAX}`; };
    paintCount();
    ta.addEventListener('input', paintCount);
    const commit = () => {
      const next = ta.value.trim();
      if (next === cur.trim()) return;
      void putResponseDigest({ guidance: next || null });
    };
    ta.addEventListener('blur', commit);
    ta.addEventListener('keydown', (e) => {
      // Cmd/Ctrl+Enter commits without leaving the field; plain Enter is a newline.
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ta.blur(); }
    });
    wrap.append(ta, count);
    return wrap;
  }

  async function putResponseDigest(patch) {
    try {
      // Send the resolved full object (defaults filled), same reason as putTools
      // (BUG-088): patchProject's echo-check compares sent leaves against the
      // server echo, and a partial on a project with no stored responseDigest
      // would be echoed as a defaults-filled superset.
      await api.patchProject(project().id, { responseDigest: { ...effectiveDigest(), ...patch } });
      await ctx.refreshProject();
      d.composed = null;
      paint();
    } catch (err) {
      ctx.notify(`could not save response-format settings: ${err.message}`, true);
      paint();
    }
  }

  /* ------------------------------------------------------- wiring (FEAT-076) */
  /*
   * The methodology-wiring health panel. Every render reads the SERVER's live
   * computation (registry refs + files on disk) — never a cached client copy —
   * so a ✅/❌ can't drift. Each missing/partial row gets an Apply; a scaffolding
   * Apply mutates the TARGET repo's working tree, so it is gated behind an armed,
   * explicitly-labelled "Scaffold … into <project>" confirm. Attaching the WA is
   * a registry-only change (reversible in the instruction stack above) and needs
   * no arm. After any Apply the panel re-fetches so the row flips live.
   */
  const WIRING_ICON = { ok: '✅', warn: '⚠️', missing: '❌', info: 'ℹ️' };

  function wiringGroup(p, readOnly) {
    const grp = el('div', { class: 'grp wiring', 'data-focus': 'wiring' }, groupLabel('Wiring'));
    if (d.wiring === undefined) {
      grp.append(note('Checking wiring…'));
      void refreshWiring(p.id);
      return grp;
    }
    if (d.wiring === null) {
      const retry = el('button', { class: 'addrow', text: 'Check again' });
      retry.addEventListener('click', () => { d.wiring = undefined; paint(); });
      grp.append(note('This server has no wiring route yet (predates FEAT-076); wiring status is unavailable.'), retry);
      return grp;
    }
    grp.append(note('Which of our methodology layers this project actually has — computed live from the registry and the files on disk, so it can’t drift. Apply sets up a missing layer from here.'));
    if (d.wiringReport && d.wiringReport.text) {
      const r = note(d.wiringReport.text);
      r.dataset.ok = 'true';
      grp.append(r);
    }
    for (const c of d.wiring.checks) grp.append(wiringRow(p, c, readOnly));
    return grp;
  }

  function wiringRow(p, c, readOnly) {
    const row = el('div', { class: 'wiring-row', 'data-state': c.state });
    const top = el('div', { class: 'top' },
      el('span', { class: 'ic', 'aria-hidden': 'true', text: WIRING_ICON[c.state] ?? 'ℹ️' }),
      el('span', { class: 'l', text: c.label }));
    const busy = d.wiringBusy === c.key;
    if (c.apply && !readOnly && d.wiringArm !== c.key) {
      const label = c.apply === 'attach-wa' ? 'Attach' : 'Scaffold…';
      const btn = el('button', { class: 'addrow wiring-apply', text: busy ? 'Working…' : label });
      if (busy || d.wiringBusy) btn.disabled = true;
      btn.addEventListener('click', () => {
        if (c.apply === 'attach-wa') void applyWiring(p, c);   // registry-only, no arm
        else { d.wiringArm = c.key; paint(); }                  // tree-mutating, arm first
      });
      top.append(btn);
    }
    row.append(top);
    row.append(el('div', { class: 'why', text: c.detail }));

    /* Armed scaffold confirm — names the exact repo the write lands in. */
    if (c.apply === 'onboard' && d.wiringArm === c.key && !readOnly) {
      const confirm = el('div', { class: 'wiring-confirm' });
      confirm.append(note(`Scaffold the ticket board, drift-guard and conventions stub into “${p.name}” (${shortPath(p.hostPath)}). Idempotent — existing files are left untouched.`));
      const no = el('button', { class: 'addrow', text: 'Cancel' });
      no.addEventListener('click', () => { d.wiringArm = null; paint(); });
      const yes = el('button', { class: 'addrow wiring-go', text: busy ? 'Working…' : `Scaffold into ${p.name}` });
      if (busy) yes.disabled = true;
      yes.addEventListener('click', () => void applyWiring(p, c));
      confirm.append(no, yes);
      row.append(confirm);
    }
    return row;
  }

  async function refreshWiring(id) {
    try {
      d.wiring = await api.wiring(id);
    } catch {
      d.wiring = null;
    }
    paint();
  }

  async function applyWiring(p, c) {
    d.wiringBusy = c.key;
    d.wiringReport = null;
    paint();
    try {
      const r = await api.applyWiring(p.id, c.key);
      // The server echoes the freshly-recomputed status — adopt it so the row
      // flips without a second round-trip.
      if (r && r.wiring) d.wiring = r.wiring;
      d.wiringArm = null;
      if (Array.isArray(r?.reports)) {
        const created = r.reports.filter((x) => /^(created|added|appended|re-synced)/.test(x.status || '')).length;
        d.wiringReport = {
          key: c.key,
          text: created
            ? `Scaffolded ${created} artifact${created === 1 ? '' : 's'} into ${p.name}; the rest already existed.`
            : `Nothing to scaffold — ${p.name} already had every artifact.`,
        };
      } else if (r?.applied === 'working-agreement') {
        d.wiringReport = { key: c.key, text: 'Working Agreement attached to this project’s instruction stack.' };
      }
      // The registry changed (WA attach) — refresh so the stack view agrees.
      if (c.apply === 'attach-wa') { await ctx.refreshProject(); d.composed = null; }
    } catch (err) {
      ctx.notify(`could not apply ${c.label}: ${err.message}`, true);
      d.wiring = undefined; // force a clean re-read
    } finally {
      d.wiringBusy = null;
      paint();
    }
  }

  function browserState(p, readOnly) {
    const frag = document.createDocumentFragment();
    if (d.browser === undefined) {
      frag.append(note('Checking the browser…'));
      void refreshBrowser(p.id);
      return frag;
    }
    if (d.browser === null) {
      const retry = el('button', { class: 'addrow', text: 'Check again' });
      retry.addEventListener('click', () => { d.browser = undefined; paint(); });
      frag.append(note('Browser control is not available on this server yet (no /browser/status route). The setting is saved; start and stop appear once the route lands.'), retry);
      return frag;
    }
    if (d.browser.problem) {
      const retry = el('button', { class: 'addrow', text: 'Check again' });
      retry.addEventListener('click', () => { d.browser = undefined; paint(); });
      frag.append(note(d.browser.problem), retry);
      return frag;
    }
    const c = d.browser;
    if (c.available === false) {
      frag.append(note('The browser backend is not installed on this machine, so the setting has nothing to drive yet.'));
      return frag;
    }
    // The route reports `running` plus process detail; `state` is a fallback
    // for the earlier contract shape.
    const running = c.running === true || String(c.state ?? '').toLowerCase() === 'running';
    const stateRow = el('div', { class: 'state-row' });
    if (running) stateRow.append(el('span', { class: 'spark' }));
    const txt = el('span', { class: 'txt' });
    txt.append(document.createTextNode(running ? 'Running · ' : 'Stopped · '));
    txt.append(el('b', { text: running ? `pid ${c.daemon_pid ?? '?'}` : 'no daemon' }));
    if (running && c.chrome_procs_live) {
      txt.append(document.createTextNode(' · '), el('b', { text: `${c.chrome_procs_live} chrome procs` }));
    }
    if (running && c.url) txt.append(document.createTextNode(' · '), el('b', { text: String(c.url) }));
    stateRow.append(txt);
    const acts = el('span', { class: 'acts' });
    const act = (label, action) => {
      const btn = el('button', { class: 'mini', text: label });
      btn.addEventListener('click', async () => {
        btn.disabled = true; btn.textContent = '…';
        const r = await api.browserAction(p.id, action);
        if (r === null) ctx.notify(`browser ${action} is not implemented on the server yet`, true);
        else if (r.problem) ctx.notify(`browser ${action}: ${r.problem}`, true);
        else ctx.notify(`browser ${action} → ${r.running === true ? 'running' : r.running === false ? 'stopped' : (r.state ?? 'ok')}`);
        d.browser = undefined;
        paint();
      });
      return btn;
    };
    if (readOnly) acts.append(el('span', { class: 'txt', text: 'project-wide' }));
    else acts.append(running ? act('Stop', 'stop') : act('Start', 'start'));
    stateRow.append(acts);
    frag.append(stateRow);
    if (c.profile) {
      frag.append(el('div', { class: 'set' },
        el('span', { class: 'l' }, document.createTextNode('Profile'), el('span', { class: 'f', text: 'persists between sessions' })),
        el('span', { class: 'v dim', text: shortPath(c.profile) })));
    }
    return frag;
  }

  async function refreshBrowser(id) {
    d.browser = await api.browserStatus(id);
    if (d.view === 'settings') paint();
  }

  async function putBrowser(patch) {
    try {
      await api.patchProject(project().id, { browser: { ...(settings().browser ?? {}), ...patch } });
      await ctx.refreshProject();
      d.browser = undefined;
      paint();
    } catch (err) {
      ctx.notify(`could not save browser settings: ${err.message}`, true);
      paint();
    }
  }

  /* ---------------------------------------------------------- snapshots */

  /*
   * `snapshots.enabled` is a TRI-state in the registry: true, false, or null
   * meaning "auto" — which the server resolves to on for container projects and
   * off otherwise. So the resolved settings from the snapshots route win when we
   * have them; the raw registry object is only the offline fallback. Reading
   * `settings().snapshots.enabled === true` alone would show "Off" for a
   * container project that IS being snapshotted.
   */
  const resolved = () => (d.snaps && !d.snaps.problem ? d.snaps.settings : null);
  const snapCfg = () => resolved() ?? settings().snapshots ?? {};
  const snapOn = () => snapCfg().enabled === true;
  const snapSource = () => resolved()?.source ?? null;
  const keepN = () => (Number.isFinite(snapCfg().keep) ? snapCfg().keep : 10);
  const excludes = () => (Array.isArray(snapCfg().exclude) ? snapCfg().exclude : DEFAULT_EXCLUDE);

  async function putSnapshots(patch) {
    try {
      await api.patchProject(project().id, {
        snapshots: { enabled: snapOn(), keep: keepN(), exclude: excludes(), ...patch },
      });
      await ctx.refreshProject();
      d.snaps = undefined;
      paint();
    } catch (err) {
      ctx.notify(`could not save snapshot settings: ${err.message}`, true);
      paint();
    }
  }

  /**
   * The one sentence a user must not have to discover the hard way. Stated
   * wherever a restore can be reached, not once at the top of a settings page.
   */
  function exclusionTruth() {
    const n = el('div', { class: 'grp-note' });
    n.append(document.createTextNode('Excluded directories are never copied, so a restore does not touch them — they stay exactly as they are now. '));
    n.append(el('code', { text: '.git' }));
    n.append(document.createTextNode(' is always included, whatever the list says.'));
    return n;
  }

  function snapshotsGroup(p, readOnly) {
    const grp = el('div', { class: 'grp' }, groupLabel('Snapshots'));
    /* Fetch BEFORE deciding what to draw, and regardless of the stored flag:
       the stored flag can be null ("auto") and only the server knows how that
       resolves. Drawing "Off" first and correcting later would be a lie for as
       long as it was on screen. */
    if (d.snaps === undefined) void refreshSnaps(p.id);
    /*
     * Tri-state, honestly. Until the server answers we only know the STORED
     * value, and a stored `null` means "auto" — which can resolve either way.
     * Rendering "Off" in that window and flipping to "On" a moment later is a
     * brief lie about whether this project is protected, so the row says it
     * does not know yet instead.
     */
    const stored = settings().snapshots?.enabled;
    const unknown = d.snaps === undefined && typeof stored !== 'boolean';
    const on = snapOn();

    const risk = el('div', { class: 'risk', 'data-on': String(on) });
    const sw = el('button', {
      class: 'sw',
      'aria-pressed': String(on),
      'aria-label': 'Toggle project snapshots',
      'data-unknown': unknown ? '' : null,
    }, el('i'));
    if (readOnly || unknown) sw.disabled = true;
    else sw.addEventListener('click', () => void putSnapshots({ enabled: !on }));
    risk.append(el('div', { class: 'top' },
      el('span', { class: 'l' },
        document.createTextNode('Project snapshots'),
        el('span', { class: 'f', text: '--settings › snapshots.enabled' })),
      sw));

    const why = el('div', { class: 'why' });
    if (unknown) {
      why.append(document.createTextNode(
        'Checking whether this project is being snapshotted. It is set to follow the runtime, and only the server can say how that resolves.'));
    } else if (on) {
      why.append(document.createTextNode(
        'On. Every session that starts here snapshots the project directory first, so you can put it back exactly as it was. Copies are reflinks — near-instant, and about zero bytes until files change.'));
    } else {
      why.append(document.createTextNode(
        'Off. A session that starts here has no restore point. A container isolates other projects, but it bind-mounts this one — so a destructive command inside it destroys the real files on this machine.'));
    }
    /* Say when the value is inherited rather than chosen, so a container
       project does not look like someone deliberately turned this on. */
    const src = snapSource();
    if (src === 'auto-container') {
      why.append(el('span', { class: 'u', text: 'on automatically — this project runs in a container' }));
    } else if (src === 'auto-off' && !on) {
      why.append(el('span', { class: 'u', text: 'off by default — not set for this project' }));
    }
    risk.append(why);
    grp.append(risk);

    if (unknown || !on) return grp;

    const keepRow = el(readOnly ? 'div' : 'button', { class: 'set', title: readOnly ? '' : 'Click to change' });
    keepRow.append(el('span', { class: 'l' },
      document.createTextNode('Keep'),
      el('span', { class: 'f', text: '--settings › snapshots.keep' })));
    keepRow.append(el('span', { class: 'v', text: `${keepN()} newest` }));
    if (!readOnly) {
      keepRow.addEventListener('click', () => {
        const i = KEEP_CYCLE.indexOf(keepN());
        void putSnapshots({ keep: KEEP_CYCLE[(i + 1) % KEEP_CYCLE.length] });
      });
    }
    grp.append(keepRow);

    grp.append(excludeRow(readOnly));
    grp.append(exclusionTruth());
    /* Why the list exists at all — measured, not hand-waved. */
    grp.append(note('Excluding build output is what keeps this instant: a 20,600-file tree snapshots in about 23 ms with these exclusions and about 950 ms without.'));

    if (readOnly) {
      grp.append(projectOnlyNote('Snapshot settings'));
      return grp;
    }

    /* State + the way in to the list. Absent route => no list surface at all. */
    if (d.snaps === undefined) {
      grp.append(note('Checking snapshots…')); // the fetch was already started above
      return grp;
    }
    if (d.snaps === null) {
      const retry = el('button', { class: 'addrow', text: 'Check again' });
      retry.addEventListener('click', () => { d.snaps = undefined; paint(); });
      grp.append(note('Snapshot storage is not available on this server yet (no /snapshots route). The setting is saved; the list and restore appear once the route lands.'), retry);
      return grp;
    }
    if (d.snaps.problem) {
      const retry = el('button', { class: 'addrow', text: 'Check again' });
      retry.addEventListener('click', () => { d.snaps = undefined; paint(); });
      grp.append(note(d.snaps.problem), retry);
      return grp;
    }

    /* Two independent failure channels, because the server has two:
       a failed row in the list, and the running session's own report that it
       started WITHOUT a restore point. */
    /* ONLY `failed`. `disabled` also has no restore point, but that is a
       chosen state, not a fault — alarming someone about their own setting is
       the bug this note exists to avoid. */
    const ss = ctx.getStartSnapshot?.();
    if (ss?.status === 'failed') grp.append(liveFailureNote(ss.error));

    const fails = d.snaps.failures ?? [];
    if (fails.length) grp.append(failureNote(fails));

    const list = d.snaps.snapshots ?? [];
    const go = el('button', { class: 'addrow', text: `${list.length} snapshot${list.length === 1 ? '' : 's'} · open the list ›` });
    go.addEventListener('click', () => open('snapshots', 'settings'));
    grp.append(go);
    return grp;
  }

  /**
   * A failed session-start snapshot is invisible by design — the session ran
   * normally, so nothing else on screen is wrong. Said plainly and quietly:
   * the user would otherwise assume a restore point exists.
   */
  /**
   * The session on screen right now started without a restore point, even
   * though snapshots are on. Nothing else in the UI shows this — the session
   * looks entirely normal — so it is said here, plainly and without alarm.
   */
  function liveFailureNote(error) {
    const n = el('div', { class: 'risk', 'data-on': 'true' });
    const why = el('div', { class: 'why' });
    why.append(el('b', { text: 'This session has no restore point. ' }));
    why.append(document.createTextNode(
      'Its start snapshot did not complete, so nothing here can put the directory back to how it was when the session began. Taking one now protects everything from this moment on, but not what has already changed.'));
    if (error) why.append(el('span', { class: 'u', text: error }));
    n.append(why);
    return n;
  }

  function failureNote(fails) {
    const n = el('div', { class: 'risk', 'data-on': 'true' });
    const why = el('div', { class: 'why' });
    const f = fails[0];
    why.append(el('b', { text: fails.length === 1 ? 'The last snapshot failed. ' : `${fails.length} snapshots failed. ` }));
    why.append(document.createTextNode(
      'The session started anyway, so nothing looked wrong — but there is no restore point for it. '));
    why.append(el('span', { class: 'u', text: `${when(f.createdAt) || 'recently'} · ${f.error}` }));
    n.append(why);
    return n;
  }

  /**
   * Full-width rather than the usual right-aligned `.set` value: the default
   * list is nine entries and the right-hand slot clipped it to
   * "node_modules, .venv, v…". This is the row that decides what a restore
   * will not bring back — it does not get to be the truncated one.
   */
  function excludeRow(readOnly) {
    const n = el('div', { class: 'set stack' });
    n.append(el('span', { class: 'l' },
      document.createTextNode('Exclude'),
      el('span', { class: 'f', text: '--settings › snapshots.exclude' })));
    const cur = excludes();
    const input = el('input', {
      class: 'vin', type: 'text', spellcheck: 'false', placeholder: 'nothing excluded', 'aria-label': 'Excluded directories',
    });
    input.value = cur.join(', ');
    if (readOnly) input.disabled = true;
    const commit = () => {
      const next = input.value.split(',').map((s) => s.trim()).filter(Boolean);
      if (JSON.stringify(next) === JSON.stringify(cur)) return;
      void putSnapshots({ exclude: next });
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
    n.append(input);
    return n;
  }

  async function refreshSnaps(id) {
    d.snaps = await api.listSnapshots(id);
    if (d.view === 'settings' || d.view === 'snapshots') paint();
  }

  /* --------------------------------------------------------- git group */
  /*
   * Status + the four actions the TODO agreed on (commit, push, pull, create
   * repo) plus "open terminal here". Outward-facing actions (push, create)
   * arm-then-confirm; pull is --ff-only server-side so it cannot invent a
   * merge. No embedded terminal — kitty is one keypress away.
   */

  async function refreshGit(id) {
    d.git = await api.gitStatus(id);
    if (d.view === 'settings') paint();
  }

  async function gitDo(action, body, okText) {
    const p = project();
    d.gitBusy = true;
    paint();
    try {
      const r = await api.gitAction(p.id, action, body);
      ctx.notify(okText(r));
      d.git = r.status ?? undefined;
      if (action === 'commit') d.gitMsg = '';
    } catch (err) {
      ctx.notify(`git ${action}: ${err.message}`, true);
    }
    d.gitArm = null;
    d.gitBusy = false;
    if (d.git === undefined) void refreshGit(p.id);
    else paint();
  }

  function gitGroup(p) {
    const grp = el('div', { class: 'grp', 'data-focus': 'git' }, groupLabel('Git'));
    if (d.git === undefined) {
      void refreshGit(p.id);
      grp.append(note('Reading git status…'));
      return grp;
    }
    if (d.git === null) return grp.append(note('This server does not speak git yet.')), grp;
    const s = d.git;

    if (!s.repo) {
      grp.append(note('Not a git repository — this project’s only history is snapshots.'));
      if (d.gitArm === 'init') {
        const acts = el('div', { class: 'cacts' });
        const no = el('button', { class: 'mini', text: 'Not now' });
        no.addEventListener('click', () => { d.gitArm = null; paint(); });
        const yes = el('button', { class: 'mini', text: 'Init repository' });
        yes.addEventListener('click', () => void gitDo('init', {}, () => 'initialised an empty repository on branch main'));
        acts.append(el('span', { class: 'grp-note inline', text: 'Local only — nothing leaves this machine.' }), no, yes);
        grp.append(acts);
      } else {
        const init = el('button', { class: 'addrow', text: 'git init — start tracking this project ›' });
        init.addEventListener('click', () => { d.gitArm = 'init'; paint(); });
        grp.append(init);
      }
      grp.append(terminalRow(p));
      return grp;
    }

    const line = el('div', { class: 'grp-note mono-line' });
    line.append(el('b', { text: s.branch ?? `detached @ ${s.detachedAt ?? '?'}` }),
      document.createTextNode(
        ` · ${s.dirty ? `${s.dirty} dirty file${s.dirty === 1 ? '' : 's'}` : 'clean'}`
        + `${s.ahead ? ` · ${s.ahead} ahead` : ''}${s.behind ? ` · ${s.behind} behind` : ''}`
        + `${s.upstream ? ` · tracks ${s.upstream}` : s.remoteUrl ? ' · remote, no upstream' : ' · no remote'}`));
    if (s.lastCommit) line.append(el('span', { class: 'u', text: `last: ${s.lastCommit}` }));
    grp.append(line);

    const workbench = el('button', { class: 'addrow', text: s.dirty ? `Review and stage ${s.dirty} changed file${s.dirty === 1 ? '' : 's'} ›` : 'Open Git workbench ›' });
    workbench.addEventListener('click', () => ctx.openGit?.());
    grp.append(workbench);

    const acts = el('div', { class: 'cacts' });
    if (d.gitArm === 'push') {
      const no = el('button', { class: 'mini', text: 'Not now' });
      no.addEventListener('click', () => { d.gitArm = null; paint(); });
      const yes = el('button', { class: 'mini', text: s.upstream ? 'Push' : `Push -u origin ${s.branch}` });
      yes.disabled = d.gitBusy;
      yes.addEventListener('click', () => void gitDo('push', {}, (r) => `pushed · ${r.detail || 'ok'}`));
      acts.append(el('span', { class: 'grp-note inline', text: `This publishes commits to ${s.remoteUrl ?? 'the remote'}.` }), no, yes);
    } else if (d.gitArm === 'create') {
      const nameIn = el('input', { class: 'vin narrow', type: 'text', spellcheck: 'false', 'aria-label': 'Repository name' });
      nameIn.value = (p.hostPath.split('/').pop() ?? 'repo');
      const no = el('button', { class: 'mini', text: 'Not now' });
      no.addEventListener('click', () => { d.gitArm = null; paint(); });
      const yes = el('button', { class: 'mini', text: 'Create private repo' });
      yes.disabled = d.gitBusy;
      yes.addEventListener('click', () => void gitDo('create-repo', { name: nameIn.value.trim() }, (r) => `created · ${r.detail || 'ok'}`));
      acts.append(el('span', { class: 'grp-note inline', text: 'gh repo create — private, with origin set and the current branch pushed.' }), nameIn, no, yes);
    } else {
      if (s.remoteUrl) {
        const push = el('button', { class: 'mini', text: 'Push…' });
        push.disabled = d.gitBusy;
        push.addEventListener('click', () => { d.gitArm = 'push'; paint(); });
        acts.append(push);
        if (s.upstream) {
          const pull = el('button', { class: 'mini', text: 'Pull (ff-only)' });
          pull.disabled = d.gitBusy;
          pull.addEventListener('click', () => void gitDo('pull', {}, (r) => `pulled · ${r.detail || 'up to date'}`));
          acts.append(pull);
        }
      } else {
        const create = el('button', { class: 'mini', text: 'Create GitHub repo…' });
        create.disabled = d.gitBusy;
        create.addEventListener('click', () => { d.gitArm = 'create'; paint(); });
        acts.append(create);
      }
      const rf = el('button', { class: 'mini', text: '↻' , title: 'Refresh status' });
      rf.addEventListener('click', () => { d.git = undefined; paint(); });
      acts.append(rf);
    }
    grp.append(acts);
    grp.append(terminalRow(p));
    return grp;
  }

  function terminalRow(p) {
    const t = el('button', { class: 'addrow', text: 'Open a terminal here (kitty) ›', title: p.hostPath });
    t.addEventListener('click', async () => {
      try {
        const r = await api.openTerminal(p.id);
        ctx.notify(`launched ${r.launched}`);
      } catch (err) {
        ctx.notify(err.message, true);
      }
    });
    return t;
  }

  /* ---------------------------------------------------- processes group */

  async function refreshProcs(id) {
    d.procs = await api.projectProcesses(id);
    if (d.view === 'settings') paint();
  }

  function processesGroup(p) {
    const grp = el('div', { class: 'grp', 'data-focus': 'processes' }, groupLabel('Running here'));
    if (d.procs === undefined) {
      void refreshProcs(p.id);
      grp.append(note('Checking for processes…'));
      return grp;
    }
    if (d.procs === null) return grp.append(note('This server does not report processes yet.')), grp;
    if (!d.procs.length) {
      grp.append(note('Nothing is running from this directory.'));
      return grp;
    }
    const listening = d.procs.filter((x) => x.ports.length).length;
    grp.append(note(`${d.procs.length} process${d.procs.length === 1 ? '' : 'es'} with a working directory inside this project`
      + ` — ${listening || 'none'} listening on a port; the rest are things like Claude sessions and their tool shims.`
      + ' Stopping sends SIGTERM to that pid only.'));
    for (const pr of d.procs) grp.append(procRow(p, pr));
    const rf = el('button', { class: 'addrow', text: '↻ refresh' });
    rf.addEventListener('click', () => { d.procs = undefined; paint(); });
    grp.append(rf);
    return grp;
  }

  function procRow(p, pr) {
    const row = el('div', { class: 'procrow' });
    const line = el('div', { class: 'set' });
    line.append(el('span', { class: 'l' },
      document.createTextNode(pr.command.length > 64 ? `${pr.command.slice(0, 64)}…` : pr.command),
      el('span', { class: 'f', text:
        `pid ${pr.pid}${pr.ports.length ? ` · listening :${pr.ports.join(' :')}` : ''}${pr.startedAt ? ` · up since ${when(pr.startedAt)}` : ''}${pr.self ? ' · this dashboard’s own server' : ''}` })));
    const acts = el('span', { class: 'v' });
    if (pr.self) {
      acts.append(el('span', { class: 'grp-note inline', text: 'won’t stop itself' }));
    } else if (d.procConfirm === pr.pid) {
      const no = el('button', { class: 'mini', text: 'Keep' });
      no.addEventListener('click', () => { d.procConfirm = null; paint(); });
      const yes = el('button', { class: 'mini', text: 'Stop it' });
      yes.addEventListener('click', async () => {
        yes.disabled = true;
        try {
          const r = await api.killProcess(p.id, pr.pid);
          ctx.notify(`sent SIG${r.signal} to pid ${r.killed}`);
        } catch (err) {
          ctx.notify(err.message, true);
        }
        d.procConfirm = null;
        d.procs = undefined; // re-list from /proc — prove it is gone (or not)
        paint();
      });
      acts.append(no, yes);
    } else {
      const stop = el('button', { class: 'mini x', text: 'Stop…' });
      stop.addEventListener('click', () => { d.procConfirm = pr.pid; paint(); });
      acts.append(stop);
    }
    line.append(acts);
    row.append(line);
    return row;
  }

  /* ------------------------------------------------------ memories view */
  /*
   * List, read, delete — NOT an editor (memories are markdown files; a real
   * editor is better at editing). The missing capability is seeing what has
   * accumulated and pruning it, so that is all this does.
   */

  async function refreshMemories(id) {
    d.memories = await api.listMemories(id);
    d.memBody.clear();
    if (d.view === 'settings' || d.view === 'memories') paint();
  }

  function memoriesGroup(p) {
    const grp = el('div', { class: 'grp' }, groupLabel('Agent memories'));
    if (d.memories === undefined) {
      void refreshMemories(p.id);
      grp.append(note('Checking for memory files…'));
      return grp;
    }
    if (d.memories === null) return grp.append(note('This server does not list memories yet.')), grp;
    const files = (d.memories.memories ?? []).filter((f) => !f.isIndex);
    const go = el('button', { class: 'addrow', text: files.length
      ? `${files.length} memor${files.length === 1 ? 'y' : 'ies'} shaping every session here · open the list ›`
      : 'no memories recorded for this project · open ›' });
    go.addEventListener('click', () => open('memories', 'settings'));
    grp.append(go);
    return grp;
  }

  function memoriesView() {
    const p = project();
    const wrap = document.createDocumentFragment();
    if (!p) return wrap;
    const grp = el('div', { class: 'grp' }, groupLabel('Agent memories'));
    const intro = el('div', { class: 'grp-note' });
    intro.append(document.createTextNode('What Claude concluded and saved about this project — auto-loaded into every session. '),
      el('code', { text: 'CLAUDE.md' }),
      document.createTextNode(' is what you told it; these drift on their own. Read and prune here; edit in a real editor.'));
    grp.append(intro);

    if (d.memories === undefined) {
      grp.append(note('Loading…'));
      void refreshMemories(p.id);
      wrap.append(grp);
      return wrap;
    }
    if (d.memories === null) {
      grp.append(note('This server does not list memories yet.'));
      wrap.append(grp);
      return wrap;
    }
    const files = d.memories.memories ?? [];
    if (!files.length) {
      grp.append(note('No memory files exist for this project — nothing is being silently loaded into its sessions.'));
      wrap.append(grp);
      return wrap;
    }

    const multiDir = new Set(files.map((f) => f.dir)).size > 1;
    let lastDir = null;
    for (const f of files) {
      if (multiDir && f.dir !== lastDir) {
        lastDir = f.dir;
        grp.append(el('div', { class: 'grp-l sub', text: /^[A-Za-z]--/.test(f.dir) ? `${f.dir} (Windows side)` : f.dir }));
      }
      grp.append(memoryFileRow(p, f));
    }
    wrap.append(grp);
    return wrap;
  }

  function memoryFileRow(p, f) {
    const key = `${f.dir}/${f.name}`;
    const row = el('div', { class: 'memrow' });
    const head = el('button', { class: 'set', title: f.isIndex ? 'The index — lists every memory' : 'Read this memory' });
    head.append(el('span', { class: 'l' },
      document.createTextNode(f.isIndex ? 'MEMORY.md (index)' : f.name.replace(/\.md$/, '')),
      el('span', { class: 'f', text: f.description ?? `${f.bytes.toLocaleString()} bytes${f.type ? ` · ${f.type}` : ''}` })));
    head.append(el('span', { class: 'v', text: when(new Date(f.mtimeMs).toISOString()) }));
    head.addEventListener('click', () => {
      d.memOpen = d.memOpen === key ? null : key;
      d.memConfirm = null;
      paint();
    });
    row.append(head);

    if (d.memOpen === key) {
      const body = el('div', { class: 'membody' });
      if (!d.memBody.has(key)) {
        body.append(note('reading…'));
        void api.readMemory(p.id, f.dir, f.name)
          .then((r) => { d.memBody.set(key, r.content); })
          .catch((err) => { d.memBody.set(key, `could not read: ${err.message}`); })
          .then(() => { if (d.memOpen === key) paint(); });
      } else {
        body.append(el('pre', { class: 'memtext', text: d.memBody.get(key) }));
        const acts = el('div', { class: 'cacts' });
        if (!f.isIndex) {
          if (d.memConfirm === key) {
            const no = el('button', { class: 'mini', text: 'Keep' });
            no.addEventListener('click', () => { d.memConfirm = null; paint(); });
            const yes = el('button', { class: 'mini', text: 'Delete it' });
            yes.addEventListener('click', async () => {
              yes.disabled = true;
              try {
                const r = await api.deleteMemory(p.id, f.dir, f.name);
                ctx.notify(`memory deleted · backed up to ${r.backup.path}${r.indexEdited ? ' · index line removed' : ''}`);
              } catch (err) {
                ctx.notify(`delete failed: ${err.message}`, true);
              }
              d.memConfirm = null;
              d.memOpen = null;
              d.memories = undefined; // re-list from disk — prove it is gone
              paint();
            });
            acts.append(el('span', { class: 'grp-note inline', text: 'Backed up first, byte-verified. Its MEMORY.md line goes too.' }), no, yes);
          } else {
            const del = el('button', { class: 'mini x', text: 'Delete…' });
            del.addEventListener('click', () => { d.memConfirm = key; paint(); });
            acts.append(del);
          }
        }
        body.append(acts);
      }
      row.append(body);
    }
    return row;
  }

  /* ----------------------------------------------------- snapshots view */

  function snapshotsView() {
    const p = project();
    const wrap = document.createDocumentFragment();
    if (!p) return wrap;

    const grp = el('div', { class: 'grp' }, groupLabel('Snapshots'));
    const intro = el('div', { class: 'grp-note' });
    intro.append(document.createTextNode('Reflink copies of '));
    intro.append(el('code', { text: shortPath(p.hostPath) }));
    intro.append(document.createTextNode('. Restoring puts that directory back to how it was — it is the only action here that overwrites your real files.'));
    grp.append(intro);

    if (d.snaps === undefined) {
      grp.append(note('Loading…'));
      void refreshSnaps(p.id);
      wrap.append(grp);
      return wrap;
    }
    if (d.snaps === null || d.snaps.problem) {
      grp.append(note(d.snaps?.problem ?? 'Snapshot storage is not available on this server yet.'));
      wrap.append(grp);
      return wrap;
    }

    const take = el('button', { class: 'addrow', text: '+ Take one now' });
    take.addEventListener('click', async () => {
      take.disabled = true;
      take.textContent = 'taking…';
      const r = await api.takeSnapshot(p.id);
      if (r === null) ctx.notify('taking a snapshot is not implemented on the server yet', true);
      else if (r.problem) ctx.notify(`snapshot failed: ${r.problem}`, true);
      else {
        const s = r.snapshot ?? {};
        const size = `${s.fileCount ?? '?'} files · ${bytes(s.sizeBytes ?? NaN)}${s.durationMs != null ? ` · ${s.durationMs} ms` : ''}`;
        // A dedupe is NOT a new snapshot. Saying "taken" would put a success
        // message next to a list that did not grow.
        ctx.notify(r.deduped
          ? `nothing changed since the last snapshot — reused it rather than making a second identical one · ${size}`
          : `snapshot taken · ${size}${r.pruned ? ` · ${r.pruned} pruned to stay under keep` : ''}`);
      }
      d.snaps = undefined;
      paint();
    });
    grp.append(take);

    for (const f of d.snaps.failures ?? []) grp.append(failedRow(f));

    const list = d.snaps.snapshots ?? [];
    if (!list.length) grp.append(note('No snapshots yet. One is taken automatically each time a session starts on this project.'));
    for (const s of list) grp.append(snapRow(p, s));

    grp.append(exclusionTruth());
    wrap.append(grp);
    return wrap;
  }

  function failedRow(f) {
    const r = el('div', { class: 'snap failed' });
    r.append(el('span', { class: 'mid' },
      el('span', { class: 'nm', text: `${when(f.createdAt) || '—'} · snapshot failed` }),
      el('span', { class: 'sub', text: f.error })));
    r.append(el('span', { class: 'meta', text: 'no restore point' }));
    return r;
  }

  function snapRow(p, s) {
    const armed = d.restore?.id === s.id;
    // Relative time reads best in a list, but several snapshots can share one
    // ("now", "12m"). The exact moment is always one hover away, and the
    // restore confirm spells it out in full.
    const box = el('div', { class: `snap${armed ? ' armed' : ''}`, title: stamp(s.createdAt) });

    const mid = el('span', { class: 'mid' });
    mid.append(el('span', { class: 'nm', text: s.label || (when(s.createdAt) || '—') }));
    const sub = el('span', { class: 'sub' });
    sub.append(document.createTextNode(REASON_TEXT[s.reason] ?? s.reason));
    if (s.label) sub.append(document.createTextNode(` · ${when(s.createdAt) || '—'}`));
    mid.append(sub);
    box.append(mid);

    box.append(el('span', { class: 'meta' },
      el('span', { text: s.fileCount == null ? '— files' : `${s.fileCount.toLocaleString()} files` }),
      el('span', { text: bytes(s.sizeBytes ?? NaN) })));

    const acts = el('span', { class: 'acts' });
    if (!armed && s.id) {
      const rest = el('button', { class: 'mini', text: 'Restore' });
      rest.addEventListener('click', () => {
        d.restore = { id: s.id, typed: '', conflict: null, busy: false };
        d.confirmDelete = null;
        paint();
      });
      acts.append(rest);

      if (d.confirmDelete === s.id) {
        const no = el('button', { class: 'mini', text: 'Keep' });
        no.addEventListener('click', () => { d.confirmDelete = null; paint(); });
        const yes = el('button', { class: 'mini', text: 'Delete it' });
        yes.addEventListener('click', async () => {
          yes.disabled = true;
          const r = await api.deleteSnapshot(p.id, s.id);
          if (r === null) ctx.notify('deleting a snapshot is not implemented on the server yet', true);
          else if (r.problem) ctx.notify(`delete failed: ${r.problem}`, true);
          else ctx.notify('snapshot deleted');
          d.confirmDelete = null;
          d.snaps = undefined;
          paint();
        });
        acts.append(no, yes);
      } else {
        const del = el('button', { class: 'mini x', 'aria-label': 'Delete snapshot', text: '×' });
        del.addEventListener('click', () => { d.confirmDelete = s.id; paint(); });
        acts.append(del);
      }
    }
    box.append(acts);

    const frag = document.createDocumentFragment();
    frag.append(box);
    if (armed) frag.append(restoreCeremony(p, s));
    return frag;
  }

  /**
   * The heaviest confirm in the app, and deliberately so: it overwrites the
   * user's real working directory.
   *
   *  - names the project AND the snapshot's absolute timestamp, so the thing
   *    being overwritten has to be read, not just clicked past;
   *  - leads with the fact that the server takes a `pre-restore` snapshot
   *    first — that is what makes this recoverable, so it is the first thing
   *    said rather than a footnote;
   *  - states what will NOT come back, because "restore" implies totality and
   *    this restore is not total;
   *  - requires the project name to be typed. A second click is what the
   *    docker-socket toggle costs; this costs more than that on purpose.
   */
  function restoreCeremony(p, s) {
    const st = d.restore;
    const box = el('div', { class: 'ceremony' });

    const h = el('div', { class: 'ch' });
    h.append(document.createTextNode('Overwrite '));
    h.append(el('b', { text: p.name }));
    h.append(document.createTextNode(' with the snapshot from '));
    h.append(el('b', { text: stamp(s.createdAt) }));
    h.append(document.createTextNode('?'));
    box.append(h);

    box.append(el('div', { class: 'cpath', text: shortPath(p.hostPath) }));

    /* WHICH snapshot, not just when. The list is newest-first and a restore
       inserts a new `pre-restore` row at the top, so rows shift under the
       user; two snapshots seconds apart would otherwise read identically in
       this confirm. Reason, label and size make the row identifiable. */
    const which = el('div', { class: 'cwhich' });
    which.append(el('span', { text: REASON_TEXT[s.reason] ?? s.reason }));
    if (s.label) which.append(el('span', { text: `“${s.label}”` }));
    which.append(el('span', { text: s.fileCount == null ? '— files' : `${s.fileCount.toLocaleString()} files` }));
    which.append(el('span', { text: bytes(s.sizeBytes ?? NaN) }));
    box.append(which);

    /* Prominent, not buried: this is what makes a restore survivable. */
    /* Greyscale on purpose: moss means "alive" everywhere else in this app,
       and a pre-restore snapshot is not a running thing. Weight comes from
       type and rules instead. */
    const undo = el('div', { class: 'cundo' });
    undo.append(el('span', {},
      el('b', { text: 'This is undoable. ' }),
      document.createTextNode('The server snapshots the directory as it is right now, before overwriting anything — it appears in this list as '),
      el('code', { text: 'pre-restore' }),
      document.createTextNode(', so you can come straight back.')));
    box.append(undo);

    const backs = el('div', { class: 'cyes' });
    backs.append(el('div', { class: 'ct', text: 'What comes back' }));
    const bul = el('ul');
    bul.append(el('li', {}, document.createTextNode('Everything captured, byte for byte — including '),
      el('code', { text: '.git' }), document.createTextNode(', so your history and branches come with it.')));
    backs.append(bul);
    box.append(backs);

    const nots = el('div', { class: 'cnot' });
    nots.append(el('div', { class: 'ct', text: 'What will not come back' }));
    const ul = el('ul');
    ul.append(el('li', { text: `Files created after ${stamp(s.createdAt)} are removed from the directory.` }));
    /* This snapshot's OWN recorded exclusions, not the project's current
       setting — they are what a restore of this snapshot honours, and the two
       differ the moment someone edits the list after taking it. */
    const ex = s.exclusions ?? excludes();
    const li2 = el('li');
    li2.append(document.createTextNode('Excluded directories are left untouched — not restored, not removed: '));
    li2.append(el('code', { text: ex.join(', ') || 'none' }));
    if (s.exclusions && JSON.stringify(s.exclusions) !== JSON.stringify(excludes())) {
      li2.append(document.createTextNode(' — the list recorded with this snapshot, which is not the project\'s current list.'));
    }
    ul.append(li2);
    if (s.excludedFound?.length) {
      ul.append(el('li', {}, document.createTextNode('Present in the project and skipped at capture: '),
        el('code', { text: s.excludedFound.join(', ') })));
    }
    nots.append(ul);
    box.append(nots);

    if (st.conflict) {
      box.append(conflictBlock(p, s, st));
      return box;
    }

    /* Typed confirmation. The input is left uncontrolled so a repaint never
       steals focus mid-word; the button is enabled imperatively. */
    const field = el('div', { class: 'cfield' });
    const lbl = el('label', { class: 'cl', for: 'snapConfirm' });
    lbl.append(document.createTextNode('Type '));
    lbl.append(el('code', { text: p.name }));
    lbl.append(document.createTextNode(' to confirm'));
    const input = el('input', {
      id: 'snapConfirm', class: 'vin', type: 'text', spellcheck: 'false',
      autocomplete: 'off', placeholder: p.name, 'aria-label': `Type ${p.name} to confirm the restore`,
    });
    input.value = st.typed;
    field.append(lbl, input);
    box.append(field);

    const acts = el('div', { class: 'cacts' });
    const cancel = el('button', { class: 'mini', text: 'Cancel' });
    cancel.addEventListener('click', () => { d.restore = null; paint(); });
    const go = el('button', { class: 'mini danger', text: `Restore ${p.name}` });
    const ok = () => input.value.trim() === p.name;
    go.disabled = !ok();
    input.addEventListener('input', () => { st.typed = input.value; go.disabled = !ok(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && ok()) { e.preventDefault(); go.click(); } });
    go.addEventListener('click', () => { if (ok()) void doRestore(p, s, false, go); });
    acts.append(cancel, go);
    box.append(acts);
    queueMicrotask(() => input.focus());
    return box;
  }

  /**
   * 409 `live-sessions`: the server refused because work is in flight. Same
   * explicit-confirm-then-`?force=1` shape used elsewhere — and it lists what
   * would be disrupted rather than asking the user to force blind.
   */
  function conflictBlock(p, s, st) {
    const c = el('div', { class: 'cconflict' });
    c.append(el('div', { class: 'ct', text: 'Refused — sessions are running on this project' }));
    const ul = el('ul');
    if (st.conflict.sessions?.length) {
      for (const x of st.conflict.sessions) {
        const li = el('li', {}, el('code', { text: x.sessionId ? String(x.sessionId).slice(0, 8) : 'unknown session' }));
        // A mid-turn session is the sharp case — it keeps writing into the tree
        // you just restored. The server distinguishes it; so does this list.
        if (x.busy) li.append(el('b', { text: ' mid-turn' }));
        if (x.disruption) li.append(el('span', { class: 'd', text: ` ${x.disruption}` }));
        ul.append(li);
      }
    } else {
      ul.append(el('li', { text: st.conflict.message || 'The server did not name them.' }));
    }
    c.append(ul);
    c.append(el('div', { class: 'cw', text: 'Restoring now pulls the files out from under them mid-turn. Their work since the snapshot is in the pre-restore snapshot, not on disk.' }));

    const acts = el('div', { class: 'cacts' });
    const cancel = el('button', { class: 'mini', text: 'Leave them alone' });
    cancel.addEventListener('click', () => { d.restore = null; paint(); });
    const force = el('button', { class: 'mini danger', text: 'Restore anyway' });
    force.addEventListener('click', () => void doRestore(p, s, true, force));
    acts.append(cancel, force);
    c.append(acts);
    return c;
  }

  async function doRestore(p, s, force, btn) {
    btn.disabled = true;
    btn.textContent = 'restoring…';
    const r = await api.restoreSnapshot(p.id, s.id, { force });
    if (r === null) {
      ctx.notify('restore is not implemented on the server yet', true);
      d.restore = null;
    } else if (r.conflict) {
      d.restore = { ...d.restore, conflict: r, busy: false };
    } else if (r.problem) {
      ctx.notify(`restore failed: ${r.problem} — nothing was overwritten`, true);
      d.restore = null;
    } else {
      /* Report the server's actual counts, not "done". `removed` is the number
         of top-level entries that were DELETED — the user is entitled to see
         that number, and to be told where they went. */
      const res = r.result ?? {};
      const pre = res.preRestoreSnapshotId ?? res.preRestoreId ?? res.preRestore?.id ?? null;
      const n = (v) => (Array.isArray(v) ? v.length : null);
      const parts = [`${p.name} restored to ${stamp(s.createdAt)}`];
      if (n(res.restored) !== null) parts.push(`${n(res.restored)} restored`);
      if (n(res.removed)) parts.push(`${n(res.removed)} removed (in the pre-restore snapshot)`);
      if (n(res.preservedExcluded)) parts.push(`${n(res.preservedExcluded)} excluded dirs left untouched`);
      if (pre) parts.push(`undo: ${pre}`);
      ctx.notify(parts.join(' · '));
      d.restore = null;
    }
    d.snaps = undefined;
    paint();
  }

  const projectOnlyNote = (what) =>
    note(`${what} can only be set for the whole project — a session cannot change it without rebuilding the container for every other session. Switch to “Project default” to change it.`);

  function stackSummaryRow(name, mode) {
    return el('div', { class: 'set' },
      el('span', { class: 'l', text: name }),
      el('span', { class: 'v dim', text: mode }));
  }

  function mountForm(mounts) {
    const box = el('div', { class: 'mrow' });
    const input = el('input', {
      class: 'vin',
      type: 'text',
      spellcheck: 'false',
      placeholder: '~/path  or  ~/path:/container/path:ro',
      'aria-label': 'New mount',
    });
    input.style.width = '100%';
    input.style.textAlign = 'left';
    box.append(input);
    const commit = () => {
      const raw = input.value.trim();
      d.addingMount = false;
      if (!raw) return paint();
      const [hostPath, containerPath, flag] = raw.split(':');
      const host = hostPath.trim();
      const name = host.replace(/\/+$/, '').split('/').pop() || 'workspace';
      void put('mounts', [...mounts, {
        hostPath: host,
        containerPath: (containerPath || `/workspace/${name}`).trim(),
        readOnly: (flag || '').trim() === 'ro',
      }]);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { d.addingMount = false; paint(); }
    });
    input.addEventListener('blur', commit);
    queueMicrotask(() => input.focus());
    return box;
  }

  /**
   * FEAT-112 — per-project service sidecars (Redis, Mongo, …). Container-only,
   * and it mirrors the mounts section: a repeatable list of rows plus a quick-add
   * form. A service is reachable from inside the session by its `name`; declaring
   * one and starting a session brings it up on the project's own Docker network.
   * Empty by default, so a project pays nothing until it adds one.
   */
  function servicesGroup(p, sessionScope) {
    if ((p.isolation ?? project().isolation) !== 'container') return null;
    const g = el('div', { class: 'grp', 'data-focus': 'services' }, groupLabel('Services'));
    const services = settings().services ?? [];
    if (!services.length) {
      g.append(note('No service sidecars. Add one (e.g. redis  redis:7-alpine) and it comes up on a per-project network at that hostname when a session starts.'));
    }
    for (const [i, s] of services.entries()) {
      const r = el('div', { class: 'mrow' });
      r.append(el('span', { class: 'p' },
        el('span', { class: 'dst', text: s.name }),
        el('span', { class: 'to', text: '  ·  ' }),
        document.createTextNode(s.image)));
      if (s.dataPath) r.append(el('span', { class: 'm', text: 'data' }));
      if (Array.isArray(s.env) && s.env.length) r.append(el('span', { class: 'm', text: `${s.env.length} env` }));
      if (!sessionScope) {
        const x = el('button', { class: 'x', 'aria-label': 'Remove service', text: '×' });
        x.addEventListener('click', () => put('services', services.filter((_, j) => j !== i)));
        r.append(x);
      }
      g.append(r);
    }
    if (!sessionScope) {
      if (d.addingService) g.append(serviceForm(services));
      else {
        const add = el('button', { class: 'addrow', text: '+ Add service' });
        add.addEventListener('click', () => { d.addingService = true; paint(); });
        g.append(add);
      }
    } else {
      g.append(projectOnlyNote('Services'));
    }
    return g;
  }

  function serviceForm(services) {
    const box = el('div', { class: 'mrow' });
    const input = el('input', {
      class: 'vin',
      type: 'text',
      spellcheck: 'false',
      placeholder: 'name  image  [/data-path]   e.g.  redis  redis:7-alpine  /data',
      'aria-label': 'New service',
    });
    input.style.width = '100%';
    input.style.textAlign = 'left';
    box.append(input);
    const commit = () => {
      const raw = input.value.trim();
      d.addingService = false;
      if (!raw) return paint();
      const [name, image, dataPath] = raw.split(/\s+/);
      if (!name || !image) { ctx.notify('a service needs a name and an image', true); return paint(); }
      void put('services', [...services, {
        name: name.toLowerCase(),
        image,
        env: [],
        dataPath: dataPath && dataPath.startsWith('/') ? dataPath : null,
      }]);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { d.addingService = false; paint(); }
    });
    input.addEventListener('blur', commit);
    queueMicrotask(() => input.focus());
    return box;
  }

  /**
   * Docker socket is a first-class registry flag, not a mount we fake.
   *
   * The consequence is stated in BOTH states — a warning that only appears
   * once the danger is accepted is not a warning — and switching it on takes a
   * second, deliberate click rather than happening on the first.
   *
   * BUG-154 — the wording keeps two things apart that the old text ran
   * together. The GRANT is reversible: the flag is a bind, so turning it off
   * and letting the container be recreated removes the socket exactly the way
   * turning it on added it (containerManager `desiredBinds`, drift -> recreate).
   * The CONSEQUENCE is not: through a rootful daemon the session can run a
   * container of its own mounting any host path, so what it wrote or left
   * running outlives the setting. Saying "this cannot be undone" of the switch
   * itself is false, and a consent control that misstates what it is asking
   * consent for teaches the reader to discount the true half.
   *
   * "any path the daemon can reach" is deliberate: it is exact on a rootless
   * daemon too (everything that user owns — home, keys, every other project),
   * where "root on this machine" would overstate it. The rootful clause is
   * flagged as the usual case rather than asserted about a daemon the browser
   * cannot inspect. Checked on this machine 2026-08-25: rootful
   * (`docker info` Root=/var/lib/docker, socket root:docker, no name=rootless).
   */
  function dockerSocketBlock(readOnly = false) {
    const on = settings().container?.dockerSocket === true;
    const risk = el('div', { class: 'risk', 'data-on': String(on) });
    const sw = el('button', { class: 'sw', 'data-risk': '', 'aria-pressed': String(on), 'aria-label': 'Toggle docker socket access' }, el('i'));
    risk.append(el('div', { class: 'top' }, el('span', { class: 'l', text: 'Docker socket' }), sw));

    const why = el('div', { class: 'why' });
    if (on) {
      why.append(
        document.createTextNode('On. This session can start containers of its own, outside this one — the isolation you set above stops at the socket. '
          + 'Turning it off takes the socket away at the next container rebuild; it undoes nothing already done through it. '),
        el('code', { text: DOCKER_SOCK }));
    } else if (d.armSocket) {
      why.append(
        document.createTextNode('Turning this on hands the session the daemon socket: containers of its own, mounting any path the daemon can reach. '
          + 'On a rootful daemon — the usual kind — that is root on this machine, and every limit set above stops applying. '
          + 'Turning it back off removes the socket at the next container rebuild; it does not undo what was done with it — files written anywhere on the host, and containers left running, outlive it. '),
        el('code', { text: DOCKER_SOCK }));
      const acts = el('div', { class: 'state-row' });
      const cancel = el('button', { class: 'mini', text: 'Cancel' });
      cancel.addEventListener('click', () => { d.armSocket = false; paint(); });
      const go = el('button', { class: 'mini', text: 'Turn it on anyway' });
      go.addEventListener('click', () => { d.armSocket = false; void putContainer({ dockerSocket: true }); });
      acts.append(el('span', { class: 'txt', text: 'The access is reversible. What it is used for is not.' }),
        el('span', { class: 'acts' }, cancel, go));
      why.append(acts);
    } else {
      why.append(
        document.createTextNode('Off. Turning it on would let the session start containers outside this one, which defeats the isolation set above. '),
        el('code', { text: DOCKER_SOCK }));
    }
    risk.append(why);

    if (readOnly) sw.disabled = true;
    else sw.addEventListener('click', () => {
      if (on) return void putContainer({ dockerSocket: false }); // switching off is always safe
      d.armSocket = true; // arm; the confirm button commits
      paint();
    });
    if (d.armSocket && !on) risk.dataset.on = 'true'; // the armed state is visually raised too
    return risk;
  }

  /**
   * Container fields live under settings.container and the server merges them
   * partially. They are infrastructure for the whole project, so they are
   * always written at project scope — the note below says so in session scope.
   */
  async function putContainer(patch) {
    try {
      await api.patchProject(project().id, { container: { ...(settings().container ?? {}), ...patch } });
      await ctx.refreshProject();
      d.container = undefined;
      paint();
    } catch (err) {
      ctx.notify(`could not save container settings: ${err.message}`, true);
      paint();
    }
  }

  /** Base image: free text, because real images are not a short enum. */
  function imageRow(readOnly = false) {
    const cur = settings().container?.image ?? null;
    const effective = d.container && !d.container.problem ? d.container.image : null;
    const n = el('div', { class: 'set' });
    n.append(el('span', { class: 'l' }, document.createTextNode('Base image'), el('span', { class: 'f', text: '--settings › container.image' })));
    const input = el('input', { class: 'vin', type: 'text', spellcheck: 'false', 'aria-label': 'Base image', placeholder: effective ?? 'default' });
    input.value = cur ?? '';
    if (readOnly) input.disabled = true;
    const commit = () => {
      const v = input.value.trim() || null;
      if (v === cur) return;
      void putContainer({ image: v });
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
    n.append(input);
    return n;
  }

  const MEM_CYCLE = [2048, 4096, 8192, 12288];

  function memoryRow(readOnly = false) {
    const cur = settings().container?.memoryMb ?? null;
    const n = el(readOnly ? 'div' : 'button', { class: 'set', title: readOnly ? '' : 'Click to change' });
    n.append(el('span', { class: 'l' }, document.createTextNode('Memory cap'), el('span', { class: 'f', text: '--settings › container.memoryMb' })));
    n.append(el('span', { class: 'v', text: cur ? `${(cur / 1024).toFixed(0)} GB` : 'default' }));
    if (readOnly) return n;
    n.addEventListener('click', () => {
      const i = MEM_CYCLE.indexOf(cur);
      void putContainer({ memoryMb: MEM_CYCLE[(i + 1) % MEM_CYCLE.length] });
    });
    return n;
  }

  function containerBlock(p, readOnly = false) {
    const frag = document.createDocumentFragment();
    if (d.container === undefined) {
      frag.append(note('Checking the container…'));
      void refreshContainer(p.id);
      return frag;
    }
    if (d.container === null) {
      const n = note('Container control is not available on this server yet (no /container/status route). Isolation is saved; start and stop will appear once the route lands.');
      const retry = el('button', { class: 'addrow', text: 'Check again' });
      retry.addEventListener('click', () => { d.container = undefined; paint(); });
      frag.append(n, retry);
      return frag;
    }
    frag.append(imageRow(readOnly), memoryRow(readOnly));
    const c = d.container;
    if (c.problem) {
      // The route exists and said no — quote it rather than inventing a reason.
      const n = note(c.problem);
      const retry = el('button', { class: 'addrow', text: 'Check again' });
      retry.addEventListener('click', () => { d.container = undefined; paint(); });
      frag.append(n, retry);
      return frag;
    }
    const running = String(c.state ?? '').toLowerCase() === 'running';
    const stateRow = el('div', { class: 'state-row' });
    if (running) stateRow.append(el('span', { class: 'spark' }));
    const txt = el('span', { class: 'txt' });
    txt.append(document.createTextNode(running ? 'Running · ' : `${c.state ?? 'unknown'} · `));
    txt.append(el('b', { text: c.containerName ?? '—' }));
    if (running && c.startedAt) {
      const mins = Math.max(0, Math.round((Date.now() - Date.parse(c.startedAt)) / 60000));
      txt.append(document.createTextNode(' · '), el('b', { text: `${mins}m` }));
    }
    stateRow.append(txt);
    const acts = el('span', { class: 'acts' });
    const act = (label, action) => {
      const b = el('button', { class: 'mini', text: label });
      b.addEventListener('click', async () => {
        b.disabled = true;
        b.textContent = '…';
        const r = await api.containerAction(p.id, action);
        if (r === null) ctx.notify(`container ${action} is not implemented on the server yet`, true);
        else if (r.problem) ctx.notify(`container ${action}: ${r.problem}`, true);
        else ctx.notify(`container ${action} → ${r.state ?? 'ok'}`);
        d.container = undefined;
        paint();
      });
      return b;
    };
    if (readOnly) acts.append(el('span', { class: 'txt', text: 'project-wide' }));
    else if (running) acts.append(act('Stop', 'stop'), act('Rebuild', 'rebuild'));
    else acts.append(act('Start', 'start'), act('Rebuild', 'rebuild'));
    stateRow.append(acts);
    frag.append(stateRow);
    /* BUG-154 — the same precision the socket warning needed: a setting on this
       screen is a REQUEST until the container is recreated on it. The server
       already computes that (`drifted`), so say it rather than let the rows read
       as a description of what is running right now. */
    if (c.drifted === true) {
      frag.append(note('Changed since this container started. It keeps the mounts, socket flag and limits it was created with until you rebuild.'));
    }
    return frag;
  }

  async function refreshContainer(id) {
    try {
      d.container = await api.containerStatus(id);
    } catch (err) {
      d.container = null;
      ctx.notify(`container status: ${err.message}`, true);
    }
    if (d.view === 'settings') paint();
  }

  /* --------------------------------------------------- instructions view */

  const tpl = (id) => d.templates.find((t) => t.id === id);
  const nameOf = (id) => tpl(id)?.name ?? id;
  const modeOf = (id) => tpl(id)?.defaultMode ?? 'append';

  /**
   * When the effective permission mode skips approvals, say what that means
   * where the mode is set. Calm on a container (the boundary is the container),
   * risk on anything else. Reads the live effective source when a session is
   * running, so a container-default reads as a default rather than a choice.
   */
  function permModeNote() {
    if (val('permissionMode') !== 'bypassPermissions') return null;
    const l = live();
    const iso = l?.isolation ?? project()?.isolation ?? 'direct';
    const calm = iso === 'container';
    const n = el('div', { class: 'risk', 'data-on': String(!calm) });
    const why = el('div', { class: 'why' });
    if (calm) {
      why.append(document.createTextNode(l?.permissionModeSource === 'container-default'
        ? 'Approvals are skipped by default here — the container is the safety boundary, so tools run without asking.'
        : 'Approvals are skipped — the container is the safety boundary, so tools run without asking.'));
    } else {
      why.append(document.createTextNode('Approvals are skipped: the model runs commands on this machine without asking. On a direct project that is a deliberate, risky choice.'));
    }
    n.append(why);
    return n;
  }

  /** The stack in force for the current scope. */
  function effectiveStack() {
    if (d.scope === 'session' && Array.isArray(ctx.overrides.instructions)) return ctx.overrides.instructions;
    return settings().instructions ?? [];
  }

  function setStack(next) {
    return put('instructions', next);
  }

  function instructionsView() {
    const p = project();
    const wrap = document.createDocumentFragment();
    if (!p) return wrap;
    const stack = effectiveStack();

    const grp = el('div', { class: 'grp' }, groupLabel('Instruction stack'));
    const n = el('div', { class: 'grp-note' });
    n.append(
      document.createTextNode('Composed top to bottom, then sent as the system prompt. A '),
      el('code', { text: 'replace' }),
      document.createTextNode(' template clears everything above it.'),
    );
    grp.append(n, el('div', { style: 'height:6px' }));

    /* CLAUDE.md is pinned first: it is read from disk by the preset, so a
       `replace` anywhere in the stack supersedes it too. */
    const rows = [
      { pin: true, name: 'CLAUDE.md', sub: `${shortPath(p.hostPath)}/CLAUDE.md`, mode: 'file', enabled: true },
      ...stack.map((s) => ({
        id: s.templateId,
        name: nameOf(s.templateId),
        sub: tpl(s.templateId)?.description || s.templateId,
        mode: s.mode ?? modeOf(s.templateId),
        enabled: s.enabled !== false,
        missing: !tpl(s.templateId),
      })),
    ];

    let repl = -1;
    rows.forEach((r, i) => { if (!r.pin && r.enabled && r.mode === 'replace') repl = i; });

    rows.forEach((r, i) => {
      if (i === repl && repl > 0) {
        grp.append(el('div', { class: 'supersede' },
          el('span', { class: 'rule' }),
          el('span', { text: 'everything above is replaced' }),
          el('code', { text: '--system-prompt' }),
          el('span', { class: 'rule' })));
      }
      const gone = repl > -1 && i < repl;
      const t = el('div', { class: `trow${r.enabled ? '' : ' off'}${gone ? ' gone' : ''}` });
      t.append(el('span', { class: 'grip', title: 'Use the arrows to reorder', text: '⠿' }));

      const cb = el('button', { class: 'cb', 'aria-pressed': String(r.enabled), 'aria-label': `Toggle ${r.name}`, text: '✓' });
      if (r.pin) cb.disabled = true;
      else cb.addEventListener('click', () => {
        const k = i - 1;
        setStack(stack.map((s, j) => (j === k ? { ...s, enabled: s.enabled === false } : s)));
      });
      t.append(cb);

      t.append(el('span', { class: 'mid' },
        el('span', { class: 'nm', text: r.missing ? `${r.name} (missing)` : r.name }),
        el('span', { class: `sub${r.pin ? ' path' : ''}`, text: r.sub })));

      if (r.pin) t.append(el('span', { class: 'mode', title: 'Read from disk', text: 'file' }));
      else {
        const mode = el('button', { class: 'mode', 'data-mode': r.mode, title: 'Switch between append and replace', text: r.mode });
        mode.addEventListener('click', () => {
          const k = i - 1;
          setStack(stack.map((s, j) => (j === k ? { ...s, mode: r.mode === 'append' ? 'replace' : 'append' } : s)));
        });
        t.append(mode);
      }

      const arrows = el('span', { class: 'arrows' });
      const mk = (label, delta) => {
        const b = el('button', { 'aria-label': delta < 0 ? 'Move up' : 'Move down', text: label });
        b.addEventListener('click', () => move(i - 1, delta, stack));
        if (r.pin) b.disabled = true;
        return b;
      };
      arrows.append(mk('▲', -1), mk('▼', 1));
      t.append(arrows);

      if (r.pin) t.append(el('span', { style: 'width:17px' }));
      else {
        const x = el('button', { class: 'x', 'aria-label': 'Remove', text: '×' });
        x.addEventListener('click', () => setStack(stack.filter((_, j) => j !== i - 1)));
        t.append(x);
      }
      grp.append(t);
    });

    const add = el('button', { class: 'addrow', text: '+ Add template' });
    add.addEventListener('click', () => open('library', 'instructions'));
    grp.append(add);
    grp.append(composedBox(rows, repl));
    wrap.append(grp);

    const file = el('div', { class: 'grp' }, groupLabel('Project file'));
    file.append(note('CLAUDE.md is read from disk on every run. A replace template drops the Claude Code preset, and CLAUDE.md with it.'));
    wrap.append(file);
    return wrap;
  }

  function move(k, delta, stack) {
    const j = k + delta;
    if (k < 0 || j < 0 || j >= stack.length) return;
    const next = stack.slice();
    [next[k], next[j]] = [next[j], next[k]];
    setStack(next);
  }

  function composedBox(rows, repl) {
    const box = el('div', { class: 'composed' });
    const eff = rows.filter((r, i) => r.enabled && (repl < 0 || i >= repl));
    box.append(el('b', { text: 'In effect: ' }), document.createTextNode(eff.map((r) => r.name).join(' + ') || 'nothing'));
    box.append(el('br'));
    if (d.scope === 'session') {
      box.append(document.createTextNode(`${repl > -1 ? '--system-prompt' : '--append-system-prompt'} · applies at the next session start`));
      return box;
    }
    if (d.composed?.error) {
      // Never dress a failed lookup up as "preset only · 0 chars" — that reads
      // as a real, empty composition.
      box.append(document.createTextNode(`could not confirm with the server — ${d.composed.error}`));
      const retry = el('button', { class: 'addrow', text: 'Try again' });
      retry.addEventListener('click', () => { d.composed = null; paint(); });
      box.append(el('br'), retry);
    } else if (d.composed) {
      box.append(document.createTextNode(
        `${d.composed.mode === 'replace' ? '--system-prompt' : d.composed.mode === 'none' ? '(preset only)' : '--append-system-prompt'} · ${d.composed.chars.toLocaleString()} chars`,
      ));
      if (d.composed.supersededIds?.length) {
        box.append(el('br'), document.createTextNode(`superseded: ${d.composed.supersededIds.join(', ')}`));
      }
    } else {
      box.append(document.createTextNode('composing…'));
      void api.compose(project().id).then((c) => {
        d.composed = c;
        if (d.view === 'instructions') paint();
      }).catch((err) => {
        d.composed = { error: err.message };
        if (d.view === 'instructions') paint();
      });
    }
    return box;
  }

  /* ------------------------------------------------------- library view */

  /**
   * FEAT-077 — one template row. Carries the human-readable description, the
   * default mode + body size, a cheap "attached to N projects" usage signal
   * (patterns read 0 until a project opts in), and where the doc came from
   * (`source:` provenance — e.g. the methodology repo) so an opt-in add-on
   * doesn't read as coming from nowhere.
   */
  function templateRow(t) {
    const b = el('button', { class: 'lrow' });
    const nm = el('span', { class: 'nm' });
    if (t.living) nm.append(el('span', { class: 'spark' }));
    nm.append(document.createTextNode(t.name));
    const mid = el('span', { class: 'mid' }, nm, el('span', { class: 'desc', text: t.description || '—' }));
    // Provenance: only surface a real `source:` (the read-through repo file).
    if (t.source) mid.append(el('span', { class: 'src', text: `from ${t.source}` }));
    b.append(mid);
    const n = t.attachedCount ?? 0;
    b.append(el('span', { class: 'rt' },
      el('span', { class: 'mode', text: t.defaultMode }),
      el('span', { class: 'use', text: n === 0 ? 'attached to 0 projects' : `attached to ${n} project${n === 1 ? '' : 's'}` }),
      el('span', { class: 'use', text: `${(t.bodyChars ?? 0).toLocaleString()} chars` })));
    b.addEventListener('click', () => void openEditor(t.id));
    return b;
  }

  /**
   * FEAT-077 — the flat wall of six jargon rows is grouped so a human can parse
   * it at a glance:
   *   • Working Agreement — v1 (stable base) + v2 (living extension) presented
   *     as ONE unit, base first, so they read as one evolving doc rather than
   *     two competing entries. v1 is NOT retired; v2 builds on it.
   *   • Patterns (opt-in) — the four niche `pattern-*` dispatch shapes, in a
   *     collapsed section so they stop competing with the core.
   *   • Other templates — anything the user created themselves.
   */
  function libraryView() {
    const wrap = document.createDocumentFragment();

    if (!d.templates.length) {
      const empty = el('div', { class: 'grp' }, groupLabel('Templates'));
      empty.append(note('No templates on disk yet.'));
      const add0 = el('button', { class: 'addrow', text: '+ New template' });
      add0.addEventListener('click', () => openEditor(null));
      empty.append(add0);
      wrap.append(empty);
      return wrap;
    }

    const byId = (id) => d.templates.find((t) => t.id === id);
    const wa = ['working-agreement', 'working-agreement-v2'].map(byId).filter(Boolean);
    const patterns = d.templates.filter((t) => t.id.startsWith('pattern-'));
    const waIds = new Set(wa.map((t) => t.id));
    const patIds = new Set(patterns.map((t) => t.id));
    const others = d.templates.filter((t) => !waIds.has(t.id) && !patIds.has(t.id));

    // ---- Working Agreement (base + living, one unit) ----
    if (wa.length) {
      const grp = el('div', { class: 'grp', 'data-grp': 'working-agreement' }, groupLabel('Working Agreement'));
      grp.append(note('The shared house rules, injected per project (opt-in via onboarding). v1 is the stable base; v2 builds on it as the living extension — read as one evolving doc, not two rival entries.'));
      grp.append(el('div', { style: 'height:6px' }));
      // Base first (v1), then the living v2 that extends it.
      for (const t of wa) grp.append(templateRow(t));
      wrap.append(grp);
    }

    // ---- Patterns (opt-in), collapsed ----
    if (patterns.length) {
      // Wrap intro + rows in a .grp card (like the WA/Other groups) so the
      // section content gets the same horizontal inset instead of sitting
      // flush against the drawer edge. `.sect .grp:first-of-type` zeroes its
      // top margin, so it tucks directly under the summary.
      const grp = el('div', { class: 'grp' });
      grp.append(note('Reusable dispatch SHAPES from real projects. Nothing auto-injects these — a project only gets one if it explicitly opts in. Niche but proven; expand to browse.'));
      grp.append(el('div', { style: 'height:6px' }));
      for (const t of patterns) grp.append(templateRow(t));
      const sect = section('patterns', `Patterns (opt-in) · ${patterns.length}`, false, [grp]);
      if (sect) wrap.append(sect);
    }

    // ---- Other (user-created) templates ----
    if (others.length) {
      const grp = el('div', { class: 'grp', 'data-grp': 'other' }, groupLabel('Your templates'));
      grp.append(note('Reusable instruction documents you created. A template can append to what a project already says, or replace it.'));
      grp.append(el('div', { style: 'height:6px' }));
      for (const t of others) grp.append(templateRow(t));
      wrap.append(grp);
    }

    const add = el('button', { class: 'addrow', text: '+ New template' });
    add.addEventListener('click', () => openEditor(null));
    wrap.append(add);
    return wrap;
  }

  /* ------------------------------------------------------------- editor */

  async function openEditor(id) {
    let t = { id: '', name: 'Untitled template', description: '', defaultMode: 'append', living: false, body: '' };
    if (id) {
      try {
        t = await api.readTemplate(id);
      } catch (err) {
        ctx.notify(`could not read template: ${err.message}`, true);
        return;
      }
    }
    d.editing = t;
    d.back = 'library';
    d.view = 'editor';
    node.body.hidden = true;
    node.editor.classList.add('on');
    node.title.textContent = t.name;
    node.eyebrow.textContent = 'Template';
    node.scope.hidden = true;
    node.back.hidden = false;
    clear(node.edMeta);
    node.edMeta.append(document.createTextNode(t.description || 'No description.'));
    node.edMeta.append(el('span', { class: 'u', text: `${t.id || 'new'} · default mode ${t.defaultMode}${t.living ? ' · living' : ''}` }));
    node.edText.value = t.body ?? '';
    updateEdFoot();
    slide.open();
  }

  function updateEdFoot() {
    const v = node.edText.value;
    node.edFoot.textContent = `${v.split('\n').length} lines · ${v.length.toLocaleString()} chars · markdown`;
  }

  node.edText.addEventListener('input', updateEdFoot);

  node.edSave.addEventListener('click', async () => {
    if (!d.editing) return;
    const name = d.editing.name === 'Untitled template'
      ? (window.prompt('Template name', 'Untitled template') || '').trim()
      : d.editing.name;
    if (!name) return;
    try {
      const saved = await api.saveTemplate({
        id: d.editing.id || undefined,
        name,
        defaultMode: d.editing.defaultMode,
        living: d.editing.living,
        description: d.editing.description,
        body: node.edText.value,
      });
      d.editing = saved;
      d.templates = await api.listTemplates();
      ctx.notify(`saved ${saved.name} · ${saved.bytes ?? node.edText.value.length} bytes`);
      node.title.textContent = saved.name;
    } catch (err) {
      ctx.notify(`save failed: ${err.message}`, true);
    }
  });

  node.edUse.addEventListener('click', () => {
    if (!d.editing?.id || !project()) return;
    const stack = effectiveStack();
    if (!stack.some((s) => s.templateId === d.editing.id)) {
      void setStack([...stack, { templateId: d.editing.id, enabled: true }]);
    }
    d.back = 'settings';
    d.view = 'instructions';
    node.body.hidden = false;
    node.editor.classList.remove('on');
    paint();
  });

  /* --------------------------------------- FEAT-118: global defaults */
  /*
   * Machine-wide defaults every new session starts from — the lever for the
   * orchestrator's cost, which is dominated by context maintenance, so the
   * thing that pays off is dropping the DEFAULT model tier once here rather
   * than project by project. The resolution order is stated on the surface so
   * "why isn't my change taking?" has an answer without reading code:
   *
   *     global default → project override → session override
   *
   * The model list is the SAME derived catalog the header chip uses (the CLI's
   * own display names, versions included) — never a hand-written set, so a new
   * model the CLI ships appears here the first time a session reports it.
   */
  function ensureGlobals() {
    if (d.globals !== undefined || d.globalsInflight) return;
    d.globalsInflight = true;
    Promise.all([
      api.getSettings(),
      api.models('anthropic'),
      api.listProjects().catch(() => []),
    ]).then(([g, models, projects]) => {
      d.globals = g ?? { model: null, effort: null };
      d.modelCatalog = Array.isArray(models) ? models : [];
      d.globalProjects = Array.isArray(projects) ? projects : [];
    }).catch(() => {
      d.globals = { model: null, effort: null };
      d.modelCatalog = [];
      d.globalProjects = [];
    }).finally(() => {
      d.globalsInflight = false;
      if (d.view === 'globals' || d.view === 'settings') paint();
    });
  }

  async function saveGlobal(field, value) {
    try {
      const next = await api.patchSettings({ [field]: value });
      d.globals = next;
      // A project the user is looking at inherits this — refresh so the settings
      // view's "inherits global" line is truthful on the next visit.
      d.globalProjects = undefined;
      ctx.notify?.(value == null ? `global default ${field} cleared` : `global default ${field} set to ${value}`);
      // Reload the override list against the just-saved value.
      api.listProjects().then((ps) => { d.globalProjects = Array.isArray(ps) ? ps : []; if (d.view === 'globals') paint(); }).catch(() => {});
      paint();
    } catch (err) {
      ctx.notify(`could not save global ${field}: ${err.message}`, true);
    }
  }

  /** The display name for a model value in the derived catalog, or the raw value. */
  function modelLabel(value) {
    if (value == null) return null;
    const m = (d.modelCatalog ?? []).find((x) => x.value === value);
    return m ? (m.displayName || m.value) : value;
  }

  function globalsView() {
    const wrap = document.createDocumentFragment();
    if (d.globals === undefined) {
      ensureGlobals();
      wrap.append(el('div', { class: 'grp' }, note('Loading global defaults…')));
      return wrap;
    }
    const g = d.globals;
    const catalog = d.modelCatalog ?? [];

    const intro = el('div', { class: 'grp' }, groupLabel('What these are'));
    intro.append(note('The defaults every new session starts from, on this machine. A project can override any of these, and a single session can override its project — so the order that decides what runs is: global default → project → session.'));
    wrap.append(intro);

    /* ---- default model: a real picker over the derived catalog ---- */
    const mg = el('div', { class: 'grp', 'data-focus': 'globalModel' }, groupLabel('Default model'));
    // A CUSTOM sentinel value that isn't a real model id — selecting it reveals a
    // free-text field. The CLI accepts model ids it does NOT advertise in its
    // catalog (a versioned id like `claude-opus-4-8` the user pinned in the plain
    // CLI is not in supportedModels()), so the picker must not be stricter than
    // the tool it drives: the catalog is a convenience, free-text is the escape
    // hatch. The server validates the shape (global-settings MODEL_RE) and the
    // CLI validates the value itself at launch.
    const CUSTOM = '__custom__';
    const inCatalog = g.model != null && catalog.some((mm) => mm.value === g.model);
    const isCustom = g.model != null && !inCatalog;
    const sel = el('select', { class: 'gsel', id: 'gModelSel', 'aria-label': 'Global default model' });
    sel.append(el('option', { value: '', text: 'No global default — let the engine pick' }));
    for (const mopt of catalog) {
      const o = el('option', { value: mopt.value, text: mopt.displayName || mopt.value });
      if (g.model === mopt.value) o.selected = true;
      sel.append(o);
    }
    // A stored value the current catalog does not list (a versioned id typed in
    // the plain CLI, or an older cache) is shown as a real selected row so the
    // setting never silently vanishes — and editable via the custom field below.
    if (isCustom) {
      const o = el('option', { value: g.model, text: `${g.model} (custom — not in the CLI’s list)` });
      o.selected = true;
      sel.append(o);
    }
    const customOpt = el('option', { value: CUSTOM, text: 'Other model id — type it…' });
    sel.append(customOpt);

    // The free-text row: hidden until the user chooses "Other…", or shown open
    // when the current value is already a custom id so it can be edited in place.
    const customRow = el('div', { class: 'gcustom', id: 'gModelCustom' });
    const customInput = el('input', {
      type: 'text', class: 'gtext', id: 'gModelCustomInput',
      placeholder: 'e.g. claude-opus-4-8',
      'aria-label': 'Custom global default model id',
      value: isCustom ? g.model : '',
    });
    const customApply = el('button', { type: 'button', class: 'gbtn', id: 'gModelCustomApply', text: 'Set' });
    const applyCustom = () => {
      const v = customInput.value.trim();
      if (!v) { saveGlobal('model', null); return; }
      // Mirror the server's MODEL_RE so a bad shape is caught before the round trip.
      if (!/^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,79}$/.test(v)) {
        ctx.notify('model id has forbidden characters — letters, digits and . _ : - [ ] only', true);
        return;
      }
      saveGlobal('model', v);
    };
    customApply.addEventListener('click', applyCustom);
    customInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyCustom(); } });
    customRow.append(customInput, customApply);
    customRow.hidden = !isCustom;

    sel.addEventListener('change', () => {
      if (sel.value === CUSTOM) { customRow.hidden = false; customInput.focus(); return; }
      customRow.hidden = true;
      saveGlobal('model', sel.value || null);
    });
    mg.append(sel);
    mg.append(customRow);
    mg.append(note(catalog.length
      ? 'From the CLI’s own model list — versions included. Not listed? Choose “Other model id” and type it (e.g. claude-opus-4-8); the CLI accepts ids it doesn’t advertise. Setting this drops the tier for every project that hasn’t chosen its own.'
      : 'No model list learned yet — start one session and the engine’s own models fill this in, or choose “Other model id” and type one (e.g. claude-opus-4-8).'));
    wrap.append(mg);

    /* ---- default effort ---- */
    const eg = el('div', { class: 'grp' }, groupLabel('Default effort'));
    const esel = el('select', { class: 'gsel', id: 'gEffortSel', 'aria-label': 'Global default effort' });
    esel.append(el('option', { value: '', text: 'No global default' }));
    for (const ev of ['low', 'medium', 'high', 'xhigh', 'max']) {
      const o = el('option', { value: ev, text: ev });
      if (g.effort === ev) o.selected = true;
      esel.append(o);
    }
    esel.addEventListener('change', () => saveGlobal('effort', esel.value || null));
    eg.append(esel);
    wrap.append(eg);

    /* ---- which projects override the model default ---- */
    const overriders = (d.globalProjects ?? []).filter((p) => p?.settings && p.settings.model != null);
    const og = el('div', { class: 'grp' }, groupLabel('Projects that override the model'));
    if (d.globalProjects === undefined) {
      og.append(note('Checking projects…'));
    } else if (!overriders.length) {
      og.append(note('No project overrides the default model — every project inherits the global default above.'));
    } else {
      og.append(note(`${overriders.length} project${overriders.length === 1 ? '' : 's'} set${overriders.length === 1 ? 's' : ''} its own model, so the global default does not apply there:`));
      for (const p of overriders) {
        const r = el('div', { class: 'set' });
        r.append(el('span', { class: 'l', text: p.name }));
        r.append(el('span', { class: 'v', text: modelLabel(p.settings.model) ?? p.settings.model }));
        og.append(r);
      }
    }
    wrap.append(og);

    return wrap;
  }

  /* -------------------------------------------------------------- paint */

  const VIEWS = {
    settings: { el: 'settings', title: 'Project settings', build: settingsView, scope: true },
    globals: { el: 'globals', title: 'Global defaults', build: globalsView, scope: false },
    instructions: { el: 'instructions', title: 'Instructions', build: instructionsView, scope: true },
    snapshots: { el: 'snapshots', title: 'Snapshots', build: snapshotsView, scope: false },
    library: { el: 'library', title: 'Templates', build: libraryView, scope: false },
    memories: { el: 'memories', title: 'Agent memories', build: memoriesView, scope: false },
  };

  /**
   * FEAT-054 — land on the section a crown chip named. Anchors are stable:
   * `[data-focus=<key>]` on a group, else `details[data-sect=<key>]` on a
   * whole section. Expansion re-applies on EVERY paint while the focus is
   * held (async fetches repaint and would re-collapse Advanced otherwise);
   * the scroll + one-shot highlight fire only the first time. Expansion is
   * marked ephemeral so it never rewrites `d.sectClosed` (the user's own
   * collapse choices survive the visit untouched).
   */
  function applyFocus(host) {
    const f = d.focus;
    if (!f) return;
    const target = host.querySelector(`[data-focus="${f.key}"]`)
      ?? host.querySelector(`details[data-sect="${f.key}"]`);
    if (!target) return; // e.g. mounts on a non-container project — honest no-op
    for (let det = target.closest('details.sect'); det; det = det.parentElement?.closest('details.sect')) {
      if (!det.open) { det.dataset.ephemeralOpen = '1'; det.open = true; }
    }
    if (target.tagName === 'DETAILS' && !target.open) { target.dataset.ephemeralOpen = '1'; target.open = true; }
    // One-shot highlight: a brief flash (CSS animation), or — under
    // prefers-reduced-motion, via the media block in styles.css — a static
    // brief outline instead. Either way the class CLEARS; never a persistent
    // selected state. Because async fetches (git status, processes…) repaint
    // and REPLACE the flashed node mid-animation, the class is re-applied for
    // the REMAINDER of its window on each repaint — one visual flash, robust
    // to repaints, still strictly time-bounded.
    const FLASH_MS = 1400;
    const flash = (ms) => {
      target.classList.add('focus-flash');
      setTimeout(() => target.classList.remove('focus-flash'), ms);
    };
    if (f.applied) {
      const left = FLASH_MS - (Date.now() - (f.at ?? 0));
      if (left > 50) {
        flash(left);
        // The repaint REPLACED the node the smooth scroll was heading for —
        // re-land instantly (still within the one-shot window, so this can
        // never fight the user's own scrolling later).
        target.scrollIntoView({ behavior: 'auto', block: 'start' });
      }
      return;
    }
    f.applied = true;
    f.at = Date.now();
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
    target.setAttribute('tabindex', '-1');
    // Next frame: the drawer may still be sliding open; geometry settles first.
    requestAnimationFrame(() => {
      target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
      target.focus({ preventScroll: true });
      flash(FLASH_MS);
    });
  }

  function paint() {
    if (d.view === 'editor') return;
    const v = VIEWS[d.view];
    const host = node.views[v.el];
    clear(host).append(v.build());
    applyFocus(host);
    for (const [k, n] of Object.entries(node.views)) n.classList.toggle('on', k === v.el);
    node.editor.classList.remove('on');
    node.body.hidden = false;
    node.title.textContent = v.title;
    node.eyebrow.textContent = d.view === 'library' ? 'Shared across projects'
      : d.view === 'globals' ? 'Every project on this machine'
      : (project()?.name ?? '');
    node.scope.hidden = !v.scope;
    node.back.hidden = !d.back;
    node.hint.textContent = d.scope === 'project' ? 'Sessions inherit these' : 'Changes apply to this session only';
    for (const b of node.scope.querySelectorAll('[data-scope]')) {
      b.setAttribute('aria-pressed', b.dataset.scope === d.scope ? 'true' : 'false');
    }
  }

  async function ensureTemplates() {
    if (d.templates.length) return;
    try {
      d.templates = await api.listTemplates();
    } catch (err) {
      ctx.notify(`templates: ${err.message}`, true);
    }
  }

  async function open(view, from = null, opts = null) {
    // FEAT-054: `open('settings', {focus:'git'})` — the second arg may be the
    // options object (the ticket's own signature); a string stays `from`.
    if (from && typeof from === 'object') { opts = from; from = opts.from ?? null; }
    d.back = from;
    if (view !== d.view) { d.restore = null; d.confirmDelete = null; }
    d.view = view;
    // A focus is per-open: a plain open (cog button) clears any previous one
    // and lands at the default position — no sticky deep-link.
    d.focus = opts?.focus ? { key: String(opts.focus), applied: false } : null;
    /* Always refetch on open. A cached list is fine for a container's state,
       but not here: the signal that matters most is a session-start snapshot
       that FAILED, and showing a stale list would report protection the
       project no longer has. */
    d.snaps = undefined;
    d.container = view === 'settings' ? d.container : d.container;
    /* Wiring is a live true-source read (registry + files on disk); re-read on
       every drawer open so a change made outside the UI is reflected. */
    d.wiring = undefined;
    d.wiringArm = null;
    d.wiringReport = null;
    d.repoint = null; // BUG-138: a repoint panel is per-visit; never reopen armed
    slide.open();
    await ensureTemplates();
    paint();
  }

  node.back.addEventListener('click', () => {
    const to = d.back || 'settings';
    d.back = to === 'library' ? 'instructions' : null;
    d.view = to;
    node.body.hidden = false;
    node.editor.classList.remove('on');
    paint();
  });
  $('#dClose').addEventListener('click', () => { d.focus = null; slide.close(); });
  node.scope.addEventListener('click', (e) => {
    const b = e.target.closest('[data-scope]');
    if (!b) return;
    d.scope = b.dataset.scope;
    paint();
  });

  return {
    open,
    close: () => { d.focus = null; slide.close(); },
    isOpen: slide.isOpen,
    /* Note the restore reset: an armed confirm names one project and one
       snapshot. Letting it survive a project switch would leave a primed
       "Restore <old name>" button sitting under a different project. */
    repaint: () => {
      d.composed = null;
      d.container = undefined;
      d.browser = undefined;
      d.snaps = undefined;
      d.restore = null;
      d.confirmDelete = null;
      d.memories = undefined;
      d.memOpen = null;
      d.memConfirm = null;
      d.memBody.clear();
      d.git = undefined;
      d.gitArm = null;
      d.procs = undefined;
      d.procConfirm = null;
      d.wiring = undefined;
      d.wiringArm = null;
      d.wiringBusy = null;
      d.wiringReport = null;
      d.repoint = null; // BUG-138: candidates + any armed confirm belong to the project we left
      if (node.drawer.classList.contains('open')) paint();
    },
    /** The live session reported what it is actually running with — redraw. */
    repaintLive: () => { if (node.drawer.classList.contains('open') && d.view === 'settings') paint(); },
    templates: () => d.templates,
    ensureTemplates,
    effectiveStack,
    scope: () => d.scope,
    /** Template ids to send with `start`, honouring a session-scope override. */
    startTemplateIds() {
      const stack = Array.isArray(ctx.overrides.instructions) ? ctx.overrides.instructions : null;
      if (!stack) return undefined;
      return stack.filter((s) => s.enabled !== false).map((s) => s.templateId);
    },
  };
}
