/**
 * The settings modal (FEAT-146) — `.smodal`.
 *
 * It used to be a 388px right-hand drawer carrying TWO orthogonal navigation
 * axes at once: a scope tab strip (machine / project / session) and a content
 * axis of six views. Scope was never a real axis in this data model — machine
 * scope has unique content that does not exist at project level, and session
 * scope is a strict lossy subset that rendered as a screen of dead controls.
 *
 * So: CONTENT is the rail (11 categories in two groups), and SCOPE is a header
 * LENS that changes only the write target — never what is on screen. Flipping
 * the lens does not rebuild the rail, does not scroll the pane, and does not
 * make a row vanish or grey out.
 *
 * The lens still writes through `d.scope`: "This project" writes straight to
 * the registry, "This session" holds an override locally. `'machine'` stopped
 * being a lens value and became a rail GROUP.
 *
 * `createSlidePanel` is deliberately NOT used here any more (git-view.js still
 * needs it): a modal opens in place, it does not slide in from the right.
 */
import { $, el, clear, shortPath, bytes, stamp, when } from './dom.js';
import * as api from './api.js';

const MODEL_CYCLE = [null, 'opus', 'sonnet', 'haiku'];
const EFFORT_CYCLE = [null, 'low', 'medium', 'high', 'xhigh', 'max'];
const BUDGET_CYCLE = [null, 10, 25, 40];
const PERM_CYCLE = ['default', 'plan', 'acceptEdits', 'bypassPermissions'];
/* FEAT-146 round 4 — no glyphs. `▣ ◑ ○` were unreadable at 11px, arbitrary
   (nothing about a half-filled circle says "sandbox"), inconsistent with the
   provider set's `✳ ⌬`, and the stacked glyph line is what forced the segments
   to 53/54px while Appearance's glyph-less set sat at 35. The fill carries
   selection; the word carries the meaning. */
const ISO = {
  container: { n: 'Container' },
  sandbox: { n: 'Sandbox' },
  direct: { n: 'Direct' },
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
    /* FEAT-145 step 3 — the "Add account" flow, all three of its states:
       `acctAdd`   the inline label form ({label, busy})
       `acctLogin` the live login panel ({accountId, label, url, done, ws, …});
                   it holds its OWN output <pre> and code <input> nodes so a
                   repaint never wipes streamed output or what the user typed
       `acctConfirm` the account id with an armed delete (credentials go too) */
    acctAdd: null,
    acctLogin: null,
    acctConfirm: null,
    /** FEAT-146 — the selected rail category id. The rail is the content axis. */
    cat: 'model',
    /** Pane scroll offset per category, for the life of ONE open modal. */
    paneScroll: new Map(),
    /**
     * FEAT-146 phase 2b — the inline `ⓘ` disclosure.
     *
     * `whyAll` is the footer's "Show all descriptions", persisted in
     * localStorage; `whyOpen` / `whyClosed` are the per-row overrides ON TOP of
     * it, so a user who expands one row while "show all" is off — or collapses
     * one while it is on — keeps that choice across the repaints every commit
     * in this panel triggers. `whyFade` is the ONE key whose block may play its
     * .12s fade on the next paint: a repaint while a block is open must not
     * replay the animation.
     */
    whyAll: (() => { try { return localStorage.getItem('orchard.settings.descriptions') === 'all'; } catch { return false; } })(),
    whyOpen: new Set(),
    whyClosed: new Set(),
    whyFade: null,
    /** The element focus returns to on close (see closeModal). */
    returnFocus: null,
  };

  const node = {
    modal: $('#smodal'),
    back0: $('#smodalBack'),
    body: $('#dBody'),
    rail: $('#sRail'),
    scope: $('#dScope'),
    hint: $('#dHint'),
    whyAll: $('#dWhyAll'),
    liveLine: $('#dLive'),
    title: $('#dTitle'),
    eyebrow: $('#dEyebrow'),
    back: $('#dBack'),
    close: $('#dClose'),
    views: {
      settings: $('#vSettings'),
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
  /* The app root the focus trap makes `inert`. The modal is a SIBLING of it in
     index.html precisely so this works. */
  const appRoot = $('#win');

  /* ────────────────────────── FEAT-146: the rail ──────────────────────────
     Eleven categories in two groups, ordered by reach frequency rather than by
     how the code happens to be organised. `view` names the existing builder
     each category renders in THIS phase — several categories still render more
     than they eventually will; re-homing the content is a separate step, and
     doing it here would have meant rebuilding navigation and content in one
     unreviewable change. */
  const RAIL = [
    { group: 'project', id: 'model', label: 'Model & spend', view: 'settings' },
    { group: 'project', id: 'permissions', label: 'Permissions & tools', view: 'settings' },
    { group: 'project', id: 'instructions', label: 'Instructions', view: 'settings' },
    { group: 'project', id: 'isolation', label: 'Isolation & environment', view: 'settings' },
    { group: 'project', id: 'snapshots', label: 'Snapshots', view: 'snapshots' },
    { group: 'project', id: 'workspace', label: 'Workspace', view: 'settings' },
    { group: 'project', id: 'advanced', label: 'Advanced', view: 'settings' },
    { group: 'machine', id: 'accounts', label: 'Accounts', view: 'machine' },
    { group: 'machine', id: 'appearance', label: 'Appearance', view: 'machine' },
    { group: 'machine', id: 'defaults', label: 'New-project defaults', view: 'machine' },
    { group: 'machine', id: 'templates', label: 'Templates', view: 'library' },
  ];
  const GROUP_LABEL = { project: 'This project', machine: 'This machine' };
  const catOf = (id) => RAIL.find((c) => c.id === id) ?? RAIL[0];

  /**
   * Every `data-focus` / `data-sect` anchor key → the rail category that now
   * CONTAINS it. `open(view, {focus})` selects the category first, paints, and
   * only then hands the key to the untouched applyFocus(). Without this map a
   * deep link would land on whatever category happened to be selected and
   * silently no-op — which is the one regression this redesign could not
   * afford, since 18 call sites in app.js point here.
   */
  const FOCUS_CATEGORY = {
    /* the 14 data-focus keys */
    permissionMode: 'permissions',
    integrations: 'permissions',
    iso: 'isolation',
    mounts: 'isolation',
    services: 'isolation',
    git: 'workspace',
    processes: 'workspace',
    instructions: 'instructions',
    responseDigest: 'instructions',
    wiring: 'advanced',
    globalModel: 'defaults',
    newProjectDefaults: 'defaults',
    globalAccount: 'accounts',
    appearance: 'appearance',
    /* The 6 data-sect (whole-section) keys. Phase 2 retired four of the
       `<details class="sect">` sections they named — the rail replaces them —
       so `model`, `caps`, `instr` and `isoSection` are carried by the CATEGORY
       WRAPPER's own `data-focus` instead (see `catWrap` below). applyFocus
       resolves `[data-focus]` first, so every one of them still lands; its
       internals were not touched. `advanced` and `patterns` are still real
       <details>, because those two lists are genuinely long. */
    model: 'model',
    caps: 'permissions',
    instr: 'instructions',
    advanced: 'advanced',
    patterns: 'templates',
    isoSection: 'isolation',
    /* anchors this ticket ADDS — eight groups had none at all, so any future
       deep link at them would have silently no-op'd */
    projectModel: 'model',
    /* Phase 2 re-homings. `provider` moved to Model & spend (which engine runs
       this project is the same decision as which model and what it costs), and
       the snapshot settings card moved out of Isolation into Snapshots, where
       the list it configures already lives. `globalTemplates` now lands on the
       Templates category itself rather than on a link to it. */
    provider: 'model',
    projectAccount: 'model',
    snapshots: 'snapshots',
    snapshotsGroup: 'snapshots',
    memories: 'advanced',
    globalEffort: 'defaults',
    globalTemplates: 'templates',
    modelOverrides: 'defaults',
    accounts: 'accounts',
  };

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

  /* ───────── FEAT-146 phase 2b — provenance, the gutter, the disclosure ─────
   *
   * Before this phase a row said where its value came from in FOUR different
   * idioms: a "Built-in" button in machine scope, a ''-valued "No global
   * default" select option, the bare word `inherit` printed in a cycle row's
   * value, and a `.inh` tag that only existed on mouse hover. One chip, in its
   * own column, replaces the three DISPLAY idioms (the other two are controls,
   * and stay).
   *
   * The chip is a display of the DATA LAYER, never a second copy of it: it is
   * derived on every paint from the same `base()` / `overriddenNow()` /
   * `d.globals` this panel already reads, so there is nothing here that can
   * hold a different answer than the value beside it.
   */
  const isSet = (v) => !(v === null || v === undefined || v === ''
    || (Array.isArray(v) && v.length === 0));
  /** The only two fields that genuinely have a machine-wide default to inherit. */
  const MACHINE_DEFAULTED = new Set(['model', 'effort']);
  const machineValue = (field) => (MACHINE_DEFAULTED.has(field) ? (d.globals?.[field] ?? null) : null);
  /**
   * What a reset WRITES. Most fields unset with null; `permissionMode` has no
   * null (the server rejects it — 'default' IS its built-in), and the two list
   * fields must stay arrays.
   */
  const RESET_VALUE = { permissionMode: 'default', allowedTools: [], disallowedTools: [] };
  const resetValueOf = (field) => (field in RESET_VALUE ? RESET_VALUE[field] : null);

  /**
   * Which LEVEL the value on screen comes from, and whether that level is the
   * lens's current write target. `null` means built-in — no chip at all.
   *
   * hollow (filled:false) = inherited from a level above the current lens;
   * filled (filled:true)  = set HERE, at the current write target.
   */
  function provOf(spec) {
    const target = spec.target ?? (d.scope === 'session' ? 'session' : 'project');
    // A field a session may not override at all is a different fact from
    // "inherited", and saying so is what stops the user hunting for a control
    // that cannot exist here.
    if (spec.projectOnly && d.scope === 'session') return { level: 'project-only', filled: false };
    const level = spec.session ? 'session' : spec.project ? 'project' : spec.machine ? 'machine' : null;
    if (!level) return null;
    return { level, filled: level === target };
  }
  const fieldProv = (field) => provOf({
    session: overriddenNow(field),
    project: isSet(base(field)),
    machine: isSet(machineValue(field)),
    projectOnly: PROJECT_ONLY.has(field),
  });
  const provChip = (p) => (p ? el('span', {
    class: 'prov', 'data-level': p.level, 'data-fill': p.filled ? 'true' : 'false', text: p.level,
  }) : null);

  /** The level a reset falls back TO, and the value that would then apply. */
  function resetTarget(field) {
    if (overriddenNow(field) && isSet(base(field))) return { level: 'project', text: show(base(field)) };
    if (isSet(machineValue(field))) return { level: 'machine', text: show(machineValue(field)) };
    const t = show(resetValueOf(field));
    return { level: 'built-in', text: t === 'inherit' ? 'built-in default' : t };
  }

  /** Undo whatever the filled chip reports: the override, or the project value. */
  function resetField(field) {
    if (d.scope === 'session' && overriddenNow(field)) {
      delete ctx.overrides[field];
      ctx.onStackChanged?.();
      paint();
      return;
    }
    void put(field, resetValueOf(field));
  }

  /* ── the descriptions that may live behind an `ⓘ` ─────────────────────────
   *
   * THE HAZARD RULE, which is the safety-critical part of this ticket:
   * *if removing the sentence could cause the user to take an irreversible,
   * costly, or security-widening action they would otherwise not take, it
   * stays inline.*
   *
   * So only definitional / how-it-works prose about a REVERSIBLE choice
   * between SAFE options is allowed in this map. Everything on the other side
   * of that line renders in flow with NO `ⓘ` at all — the icon's absence is
   * itself the signal — and there is deliberately no entry here for
   * `permissionMode` (security posture), `maxBudgetUsd` (cost), the two tool
   * lists (what a session may reach), `isolation`, the docker socket, the
   * account pickers (which subscription is billed), snapshot retention or any
   * destructive ceremony. Adding one for any of those is the regression
   * `scripts/verify-feat-146-settings-rows.mjs` exists to catch.
   */
  const WHY = {
    model: 'Which Claude model a new session in this project starts with. '
      + 'Sessions already running keep the model they started with. Left unset, the machine-wide '
      + 'default applies; unset that too and Orchard uses the CLI’s own default.',
    effort: 'How much reasoning the model is asked to spend before it answers. Higher settings think '
      + 'longer and cost more per turn; they do not change what a session is allowed to do, and the '
      + 'setting can be changed again at any time.',
    'container.image': 'The Docker image sessions in this project run inside. Left empty, Orchard uses its own '
      + 'image. A changed image takes effect the next time the container is built, not on a session '
      + 'already running.',
    serena: 'Serena attaches a language server, so a session can look code up by symbol — find a definition, '
      + 'list references — instead of reading whole files. Off means sessions read files the ordinary way.',
    playwright: 'Playwright gives a session a headless browser it can drive, which is how it tests a UI it just '
      + 'changed. It only attaches on a machine where the binary is provisioned, so On here means “try it”, '
      + 'not “force it”.',
  };

  const whyIsOpen = (key) => (d.whyClosed.has(key) ? false : (d.whyAll || d.whyOpen.has(key)));
  function toggleWhy(key) {
    if (whyIsOpen(key)) { d.whyOpen.delete(key); d.whyClosed.add(key); }
    else { d.whyClosed.delete(key); d.whyOpen.add(key); }
    d.whyFade = key;
    paint();
    // paint() rebuilt the row, so the button the user just pressed is a new
    // node: put focus back on its replacement, or a keyboard user is dropped
    // at the top of the pane every time they open a description.
    document.getElementById(`whyb-${cssId(key)}`)?.focus();
  }
  function setWhyAll(on) {
    d.whyAll = on;
    // The footer toggle is the master switch: it clears the per-row overrides
    // rather than fighting them.
    d.whyOpen.clear();
    d.whyClosed.clear();
    try { localStorage.setItem('orchard.settings.descriptions', on ? 'all' : 'auto'); } catch { /* private mode */ }
    paint();
  }
  /** A field name like `container.image` is not a valid bare id fragment. */
  const cssId = (key) => String(key).replace(/[^A-Za-z0-9_-]/g, '-');

  /**
   * Column 4 — ALWAYS rendered, always 46px, whatever the row's state, so a
   * row's geometry is byte-identical with and without a reset button.
   *
   * Right to left: the reset `.rev`, rendered only when the chip is FILLED
   * (there is nothing to undo at this level otherwise), and the info `.why`,
   * rendered whenever the row has a description. Both are real <button>s in
   * tab order after the row's own control, both render persistently at
   * --ink-4 — the deleted `.inh` hover-reveal was information a touch or
   * keyboard user could never get at.
   */
  function gutter(row, opts) {
    const g = el('span', { class: 'sgut' });
    const key = opts.key ? cssId(opts.key) : null;
    if (opts.why && key) {
      const open = whyIsOpen(opts.key);
      const b = el('button', {
        type: 'button', class: 'why', id: `whyb-${key}`, 'data-why': opts.key,
        'aria-expanded': String(open), 'aria-controls': `why-${key}`,
        'aria-label': `${open ? 'Hide' : 'Show'} what “${opts.label}” does`,
        title: `What “${opts.label}” does`,
        text: 'i',
      });
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggleWhy(opts.key); });
      g.append(b);
      // `.set-why` is the SURFACE (round 4 made it the only explanatory block in
      // the modal); `.disclosure` marks the subset that is toggled by an ⓘ, which
      // is the set the hazard rule governs — a load-bearing sentence may sit in a
      // `.set-why`, it may never sit in a `.set-why.disclosure`.
      const block = el('div', { class: 'set-why disclosure', id: `why-${key}`, text: opts.why });
      // Selecting the prose must never be read as a click on the row.
      block.addEventListener('click', (e) => e.stopPropagation());
      if (!open) block.hidden = true;
      else if (d.whyFade === opts.key) { block.classList.add('in'); d.whyFade = null; }
      row.append(block);
      // A screen-reader user landing on the CONTROL hears the explanation —
      // but only while it is actually on screen.
      if (open && opts.control) opts.control.setAttribute('aria-describedby', `why-${key}`);
    }
    if (opts.prov?.filled && opts.onReset) {
      const t = opts.resetTo ?? { level: 'built-in', text: 'built-in default' };
      const r = el('button', {
        type: 'button', class: 'rev',
        'aria-label': `Reset ${opts.label} to the ${t.level} value (${t.text})`,
        title: `Reset to the ${t.level} value (${t.text})`,
        text: '↩',
      });
      const go = (e) => { e.preventDefault(); e.stopPropagation(); opts.onReset(); };
      r.addEventListener('click', go);
      // A real <button> activates on Enter/Space natively. The explicit keydown
      // is for SYNTHETIC KeyboardEvents, which never fire a default action —
      // and it stands down for a trusted event so a real key press can never
      // fire the reset twice.
      r.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
        if (e.isTrusted) return;
        go(e);
      });
      g.append(r);
    }
    return g;
  }

  /* ------------------------------------------------------------- rows */

  function row(field, label, flag, opts = {}) {
    const cycleList = opts.cycle;
    const p = fieldProv(field);
    // The bare word "inherit" was the third of the four "where did this come
    // from" idioms, and it was the least informative: it named the mechanism
    // and hid the answer. The chip names the LEVEL now, so the value column is
    // free to say what actually applies — the machine default when that is what
    // is in force, and "built-in" when nothing is set anywhere.
    const valueText = opts.text
      ?? (p === null ? 'built-in'
        : p.level === 'machine' ? show(machineValue(field))
        : show(val(field)));
    const n = el('div', { class: 'set' });
    const lab = el('span', { class: 'l', text: label }, flag ? el('span', { class: 'f', text: flag }) : null);
    const chip = provChip(p);
    const v = el('span', { class: `v${opts.dim || !p ? ' dim' : ''}` });
    v.append(document.createTextNode(valueText));

    let control = null;
    if (cycleList) {
      n.dataset.cycle = 'true';
      n.title = 'Click to change';
      // The mono flag text pollutes the computed name ("Effort --effort low"),
      // so the row says what it is and what activating it does.
      control = el('button', {
        type: 'button', class: 'set-main',
        'aria-label': `${label}: ${valueText}. Activate to change.`,
      }, lab, chip, v);
      n.append(control);
      n.addEventListener('click', () => cycle(field, cycleList));
    } else {
      n.append(lab);
      if (chip) n.append(chip);
      n.append(v);
    }
    n.append(gutter(n, {
      key: field, label, prov: p, why: WHY[field], control,
      resetTo: resetTarget(field), onReset: () => resetField(field),
    }));
    return n;
  }

  function listRow(field, label, flag) {
    const n = el('div', { class: 'set' });
    n.append(el('span', { class: 'l', text: label }, el('span', { class: 'f', text: flag })));
    const p = fieldProv(field);
    const chip = provChip(p);
    if (chip) n.append(chip);
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
    // No `why`: what a session may or may not reach is security posture, and
    // the hazard rule keeps that kind of prose in flow, never behind an icon.
    n.append(gutter(n, {
      key: field, label, prov: p, control: input,
      resetTo: resetTarget(field), onReset: () => resetField(field),
    }));
    return n;
  }

  const groupLabel = (t) => el('div', { class: 'grp-l', text: t });
  const note = (t) => el('div', { class: 'grp-note', text: t });

  /**
   * FEAT-146 phase 2 — one category's cards, in one wrapper.
   *
   * `anchor` is the key the `<details class="sect">` section this category
   * REPLACED used to answer (`model`, `caps`, `instr`, `isoSection`). Carrying
   * it here is what keeps those four deep links landing on a real node now that
   * the sections are gone: applyFocus tries `[data-focus=key]` before
   * `details[data-sect=key]`, so nothing about applyFocus had to change.
   */
  function catWrap(anchor, ...kids) {
    const w = el('div', { class: 'scat', 'data-focus': anchor ?? null });
    for (const k of kids.flat()) if (k) w.append(k);
    return w;
  }

  /* ───────────── FEAT-146 — the Claude account list has ONE owner ─────────────
   *
   * ARCH-010: app.js owns it. It holds `ACCOUNTS`, `refreshAccounts`,
   * `acctPlanDesc`, `acctUsageDesc` and `accountLockedReason`, and paints the
   * launch-surface control from them. This module used to keep a SECOND list
   * (`d.claudeAccounts`, filled by its own `api.getClaudeAccounts()` call) and a
   * SECOND plan describer (`acctDesc`) — two places able to hold a different
   * answer about which subscription a session will spend, which is exactly what
   * that rule forbids. It reads the owner's copy through `ctx` now and stores
   * none of its own; the only thing it still owns is the LOGIN flow (d.acctLogin),
   * which is a drawer surface, not a fact about the account list.
   */
  /** undefined = never fetched, null = no route / unreadable, [] = only the default. */
  const accountsState = () => ctx.accounts?.();
  const accountList = () => (Array.isArray(accountsState()) ? accountsState() : []);
  /** " — max, logged in" (the owner's wording), or '' when nothing is known. */
  const acctDesc = (a) => { const s = ctx.acctPlanDesc?.(a) ?? ''; return s ? ` — ${s}` : ''; };
  /** This account's OWN remaining 5-hour window — FEAT-145's whole point. */
  const acctWindow = (id) => ctx.acctUsageDesc?.(id) ?? '';
  const acctLabel = (id) => {
    const rows = accountList();
    if (!id || id === 'default') return rows.find((a) => a && a.id === 'default')?.label ?? 'Default (~/.claude)';
    return rows.find((a) => a && a.id === id)?.label ?? id;
  };

  let acctTried = false;
  /** Ask the OWNER for the list once; it caches, so this cannot loop on paint. */
  function ensureAccounts() {
    if (accountsState() !== undefined || acctTried) return;
    acctTried = true;
    Promise.resolve(ctx.refreshAccounts?.({})).then(() => { if (isOpenNow) paint(); });
  }

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
    /* FEAT-146 round 4 — a CARD with a normal row in it. This was the only pane
       content outside the card system: a bare label, a path that wrapped
       mid-token with its continuation aligned to nothing, and a `Change…` with
       no button affordance, all floating above the first real card. The path is
       the row's VALUE now (left-aligned and breaking anywhere, because it is a
       path, not a scalar) and the action is a `.mini` like every other action
       in this category. */
    const box = el('div', { class: 'grp proj-dir-box', 'data-missing': missing ? 'true' : 'false' },
      groupLabel('Workspace'));

    /* `.set.stack`, the same full-width shape the exclusion list uses: a host
       path is 60+ characters of unbreakable token, so squeezing it into the
       200px value rail would collapse the label column instead. */
    const dir = el('div', { class: 'set stack proj-dir', title: p.hostPath });
    dir.append(el('span', { class: 'l' }, el('span', { class: 'k', text: 'Directory' })));
    dir.append(el('code', { class: 'v path', text: shortPath(p.hostPath) }));
    if (d.scope !== 'session') {
      const change = el('button', { class: 'mini dir-change', text: d.repoint ? 'Close' : (missing ? 'Fix…' : 'Change…') });
      change.addEventListener('click', () => {
        if (d.repoint) { d.repoint = null; paint(); return; }
        openRepoint(p);
      });
      dir.append(el('div', { class: 'cacts dir-acts' }, change));
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
        const pick = el('button', { class: 'mini', text: 'Point here…' });
        pick.addEventListener('click', () => { d.repoint.arm = c.hostPath; paint(); });
        top.append(pick);
      }
      row.append(top);
      if (c.remoteUrl) row.append(el('div', { class: 'cwhy', text: `git origin ${c.remoteUrl}` }));
      else row.append(el('div', { class: 'cwhy', text: 'not a git repository — nothing to match on' }));
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
    const go = el('button', { class: 'mini', text: 'Point here…' });
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
    const wrap = el('div', { class: 'wiring-confirm', 'data-armed': 'true' });
    wrap.append(note(
      `Point “${p.name}” at ${hostPath}. Nothing inside either directory is touched, and the sessions recorded under `
      + `${shortPath(p.hostPath)} stay listed under this project — Orchard remembers the old path instead of moving any files. `
      + 'Reversible: repoint again, or rename the directory back, and nothing is stranded.'));
    const no = el('button', { class: 'mini', text: 'Cancel' });
    no.addEventListener('click', () => { d.repoint.arm = null; paint(); });
    const yes = el('button', { class: 'mini wiring-go', text: d.repoint.busy ? 'Working…' : 'Point it here' });
    if (d.repoint.busy) yes.disabled = true;
    yes.addEventListener('click', () => void applyRepoint(p, hostPath));
    wrap.append(el('div', { class: 'cacts' }, no, yes));
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

  /**
   * FEAT-146 phase 2 — the rail selects AND the pane filters.
   *
   * Phase 1 shipped the rail with a deliberate seam: every project category
   * rendered the whole of this function, so selecting one moved nothing. Each
   * category now builds only the cards it owns, and no card is built by two of
   * them — that two-directional property is what the verify suite asserts.
   *
   * Nothing below CHANGES a control: every group builder is the one that was
   * here before, called from one place instead of from a single monolith.
   */
  function settingsView() {
    const p = project();
    const wrap = document.createDocumentFragment();
    if (!p) {
      wrap.append(el('div', { class: 'grp' }, note('No project selected.')));
      return wrap;
    }
    const sessionScope = d.scope === 'session';
    const isContainer = (p.isolation ?? 'direct') === 'container';
    switch (d.cat) {
      case 'permissions': wrap.append(permissionsPane(p, sessionScope)); break;
      case 'instructions': wrap.append(instructionsPane(p, sessionScope)); break;
      case 'isolation': wrap.append(isolationPane(p, sessionScope, isContainer)); break;
      case 'workspace': wrap.append(workspacePane(p)); break;
      case 'advanced': wrap.append(advancedPane(p, sessionScope)); break;
      default: wrap.append(modelPane(p, sessionScope)); break;
    }
    return wrap;
  }

  /* ---- Model & spend: which brain, which engine, which subscription, and what
     it is allowed to cost. The settings almost every session touches. ---- */
  function modelPane(p, sessionScope) {
    // FEAT-118: pull the machine-wide defaults so the Model row can say what an
    // unset value actually inherits, instead of the bare word "inherit".
    ensureGlobals();
    const gModel = d.globals?.model ?? null;
    const model = el('div', { class: 'grp', 'data-focus': 'projectModel' }, groupLabel('Model'));
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
      // FEAT-139 — the machine defaults are now the "Machine" scope of THIS panel,
      // not a separate view: switch scope rather than navigating away.
      // FEAT-146 — the machine defaults are a rail CATEGORY now, not a scope.
      gLink.addEventListener('click', () => selectCat('defaults', { focus: 'globalModel' }));
      model.append(gLink);
    }

    /* `model` carries the anchor the retired `<details data-sect="model">`
       section answered — see catWrap. */
    return catWrap('model', model, providerGroup(sessionScope), projectAccountGroup(p, sessionScope));
  }

  /* ---- Permissions & tools: what a session may DO and what it can REACH.
     (FEAT-139's "Capabilities", minus the provider — which engine runs the
     project is a spend decision and moved to Model & spend.) ---- */
  function permissionsPane(p, sessionScope) {
    const perms = el('div', { class: 'grp', 'data-focus': 'permissionMode' }, groupLabel('Permissions'));
    perms.append(row('permissionMode', 'Permission mode', '--permission-mode', { cycle: PERM_CYCLE }));
    const pn = permModeNote();
    if (pn) perms.append(pn);
    perms.append(listRow('allowedTools', 'Allowed tools', '--allowed-tools'));
    perms.append(listRow('disallowedTools', 'Disallowed tools', '--disallowed-tools'));
    return catWrap('caps', perms, integrationsGroup(p, sessionScope));
  }

  /* ---- Instructions: how the session is GUIDED — the working-agreement stack
     (edited in a pane-level takeover) and the response-format shaping. ---- */
  function instructionsPane(p, sessionScope) {
    const ins = el('div', { class: 'grp', 'data-focus': 'instructions' }, groupLabel('Instruction stack'));
    const stack = effectiveStack();
    ins.append(stackSummaryRow('CLAUDE.md', 'file'));
    for (const s of stack.filter((x) => x.enabled)) {
      ins.append(stackSummaryRow(nameOf(s.templateId), s.mode ?? modeOf(s.templateId)));
    }
    const go = el('button', { class: 'addrow', text: 'Edit the instruction stack ›' });
    go.addEventListener('click', () => open('instructions', 'settings'));
    ins.append(go);
    return catWrap('instr', ins, responseFormatGroup(p, sessionScope));
  }

  /* ---- Isolation & environment: the isolation tier, plus the settings that
     ONLY mean something once a container exists to hold them. Mounts and the
     docker-socket flag are rejected server-side outside a container, so showing
     them there would be a dead option — they render gated on `isContainer`.
     Snapshots used to sit here; they are their own category now, beside the
     list they configure. ---- */
  function isolationPane(p, sessionScope, isContainer) {
    const iso = p.isolation ?? 'direct';
    const runtime = el('div', { class: 'grp', 'data-focus': 'iso' }, groupLabel('Isolation'));
    const seg = el('div', { class: 'seg' });
    for (const [key, meta] of Object.entries(ISO)) {
      const b = el('button', { 'aria-pressed': iso === key ? 'true' : 'false', text: meta.n });
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

    return catWrap('isoSection', runtime, access, servicesGroup(p, sessionScope));
  }

  /* ---- Workspace: the directory this project maps to, its git state, and what
     is running out of it. Everything here is about the real files on disk. ---- */
  function workspacePane(p) {
    /* FEAT-071 — which host directory this project maps to. After a rename or a
       relocation the display name and the path can diverge (name "orchard", path
       elsewhere), so a quiet reference line says which directory is actually in
       play. shortPath for display, full path on hover (title) — leak-hygiene and
       discoverability in one line. */
    return catWrap(null, p.hostPath ? directoryBlock(p) : null, gitGroup(p), processesGroup(p));
  }

  /* ---- Advanced: rare maintenance that earns its collapse — methodology
     wiring and the agent memories. The memory list is the one thing left in the
     whole panel that is genuinely long enough to keep its `<details>`. ---- */
  function advancedPane(p, sessionScope) {
    return catWrap(null,
      wiringGroup(p, sessionScope),
      section('advanced', 'Agent memories', false, [memoriesGroup(p)]));
  }

  /**
   * FEAT-146 — the project-scope Claude account control, which did not exist.
   *
   * FEAT-145 shipped the machine default and the per-launch session override,
   * and the launch popover's locked message says, literally, "Change it in this
   * project's settings" — pointing at a control nobody had built. The server has
   * accepted `settings.claudeAccount` at project scope since FEAT-145 step 4
   * (global-settings.ts writeTarget, validate.ts, containerManager desiredBinds),
   * and a CONTAINER project is project-scope-only BY DESIGN, so a container
   * project had no reachable way to set its account at all.
   *
   * It lives in Model & spend because it is a billing decision: which
   * subscription this project's sessions spend. Each row carries the plan, the
   * login state and that account's OWN remaining 5-hour window, because "which
   * plan has headroom right now" is the question the control is answering.
   *
   * Under the SESSION lens on a container project it is visibly LOCKED with the
   * reason on screen — never silently absent, never offered-then-rejected — and
   * the reason is app.js's `accountLockedReason()` verbatim rather than a second
   * phrasing of the same refusal.
   */
  function projectAccountGroup(p, sessionScope) {
    const grp = el('div', { class: 'grp', 'data-focus': 'projectAccount' }, groupLabel('Claude account'));
    ensureAccounts();
    const st = accountsState();
    if (st === undefined) { grp.append(note('Checking Claude accounts…')); return grp; }
    if (st === null) {
      grp.append(note('This server does not report Claude accounts, so the subscription cannot be pinned from here.'));
      return grp;
    }
    const rows = accountList();
    const extra = rows.filter((a) => a && a.id !== 'default');
    /* The container refusal, in the owner's words. Only the SESSION lens is
       refused — pinning at PROJECT scope is exactly what a container project
       must do, and is what this control adds. */
    const locked = sessionScope ? (ctx.accountLockedReason?.() ?? '') : '';
    const armed = sessionScope && ('claudeAccount' in ctx.overrides);
    const cur = val('claudeAccount') ?? null;
    const detail = (a, id) => {
      const plan = acctDesc(a);            // " — max, logged in"
      const win = acctWindow(id);          // "38% of 5-hour · resets 14:20"
      return `${plan}${win ? `${plan ? ' · ' : ' — '}${win}` : ''}`;
    };

    if (!extra.length) {
      const only = el('div', { class: 'set' },
        el('span', { class: 'l' }, document.createTextNode('Account'),
          el('span', { class: 'f', text: '--settings › claudeAccount' })),
        el('span', { class: 'v dim', text: `${acctLabel(null)}${acctWindow('default') ? ` · ${acctWindow('default')}` : ''}` }));
      grp.append(only);
      grp.append(note('Only the default account (~/.claude) is set up, so every session here uses it. Add a second Claude subscription and this project can be pinned to it.'));
      const go = el('button', { class: 'addrow', text: 'Accounts on this machine ›' });
      go.addEventListener('click', () => selectCat('accounts', { focus: 'accounts' }));
      grp.append(go);
      return grp;
    }

    const sel = el('select', {
      class: 'gsel', id: 'pAccountSel',
      'aria-label': sessionScope ? 'Claude account for this session' : 'Claude account for this project',
      'data-locked': locked ? 'true' : null,
    });
    const opt = (value, text, on) => { const o = el('option', { value, text }); if (on) o.selected = true; sel.append(o); };
    const dflt = rows.find((a) => a && a.id === 'default');
    if (sessionScope) {
      /* Session scope mirrors the launch popover exactly: inherit, the implicit
         default, or a named account. The write goes through app.js's own
         pickAccount (below), so there is one writer for a session override. */
      opt('__inherit__', `Project default — currently ${acctLabel(cur)}`, !armed);
      opt('__default__', `${dflt?.label ?? 'Default (~/.claude)'}${detail(dflt, 'default')}`,
        armed && (ctx.overrides.claudeAccount ?? null) === null);
      for (const a of extra) opt(a.id, `${a.label}${detail(a, a.id)}`, armed && ctx.overrides.claudeAccount === a.id);
    } else {
      opt('__inherit__', `Machine default — currently ${acctLabel(d.globals?.claudeAccount ?? null)}`, cur == null);
      for (const a of extra) opt(a.id, `${a.label}${detail(a, a.id)}`, cur === a.id);
    }
    if (locked) sel.disabled = true;
    else {
      sel.addEventListener('change', () => {
        const v = sel.value;
        if (sessionScope) {
          // app.js owns the per-launch override (it persists it, tells the user,
          // and repaints the launch pill + usage badge). Never a second writer.
          ctx.pickSessionAccount?.(v === '__inherit__' ? undefined : v === '__default__' ? null : v);
          paint();
        } else {
          // Project scope: null means "inherit the machine default" — the server
          // maps the 'default' sentinel to null too, so never send it.
          void put('claudeAccount', v === '__inherit__' ? null : v);
        }
      });
    }
    grp.append(sel);

    if (locked) {
      const warn = note(locked);
      warn.dataset.warn = 'true';
      grp.append(warn);
      grp.append(note('Switch to “This project” to change it — that write is allowed, and is the only way a container project’s account can be set.'));
    } else if (sessionScope) {
      grp.append(note('Applies to the NEXT session launched from here — the project and machine defaults are untouched.'));
    } else {
      grp.append(note('Which Claude subscription this project’s sessions bill to (machine → project → session). “Machine default” follows Accounts on this machine; pinning a named account here overrides it for every session in this project. Each account is a thin overlay over ~/.claude, so the transcript history is shared — only the credential differs.'));
      if ((p.isolation ?? 'direct') === 'container') {
        grp.append(note('This project runs in a container, so the account is bound when the container is created: it can only be chosen here, never per session.'));
      }
    }
    return grp;
  }

  /**
   * FEAT-146 — the contextual live-state line. It used to be the last card at
   * the bottom of a ~2,000-word scroll, which is the one place a statement about
   * what the live session is actually running cannot do its job.
   *
   * Round 4 moved it out of the FOOTER and to the top of the pane, and deleted
   * one of its branches. In a 44px bar beside the write-target hint the two
   * strings clipped each other — the hint needed 299px and got 201, this line
   * needed 476px and got 320, two adjacent ellipses in the one place that tells
   * you where your writes are going. And the branch that was deleted ("These
   * apply to the next session you start from this project…") said the same
   * thing the hint beside it already said, so half the crowding bought nothing.
   * What is left is only what the hint cannot say: what the LIVE session is
   * really running with.
   */
  function liveStateText() {
    if (d.scope !== 'session') return '';
    if (catOf(d.cat).group !== 'project') return '';
    const l = live();
    if (l?.ignoredOverrides?.length) {
      return `The server accepted but could not honour: ${l.ignoredOverrides.map((i) => `${i.field} (${i.reason})`).join('; ')}.`;
    }
    if (l) {
      return l.overridden?.length
        ? `Live session is running with ${l.overridden.join(', ')} overridden. These values are read back from the session, not from what was requested.`
        : 'Live session is running on the project defaults — no override changed a value.';
    }
    return '';
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
    const grp = el('div', { class: 'grp', 'data-focus': 'provider' }, groupLabel('Provider'));
    const cur = val('provider') ?? 'anthropic';
    const seg = el('div', { class: 'seg prov-seg' });
    for (const o of [
      { key: 'anthropic', n: 'Claude' },
      { key: 'openai', n: 'OpenAI Codex' },
    ]) {
      const b = el('button', { 'data-prov': o.key, 'aria-pressed': String(cur === o.key), text: o.n });
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

    // FEAT-146 round 4 — no inline `browser.enabled` copy: the key is already
    // on its own line in the row's `.f` sub-label directly above, and dumping it
    // a second time mid-paragraph broke the sentence in half.
    const why = el('div', { class: 'set-why' });
    why.append(document.createTextNode(on
      ? 'On. Sessions in this project can navigate, read rendered pages, screenshot, click and type — which is how they reach pages that refuse a plain fetch. '
      : 'Off. Turning it on gives this project’s sessions a real browser, for pages that refuse a plain fetch. '));
    // The two things a user will otherwise learn the hard way.
    why.append(document.createTextNode(
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
      'Browser and the attachable MCP tools (Serena, Playwright) are decided when a session launches and apply to the whole project — a running session can’t attach or detach them. Switch to “This project” to change them.'));
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
    const why = el('div', { class: 'set-why' });
    why.append(document.createTextNode(on ? spec.onText : spec.offText));
    why.append(document.createTextNode(spec.tail));
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
    const why = el('div', { class: 'set-why' });
    why.append(document.createTextNode(on
      ? 'On. Sessions here are instructed to lead substantive replies with the orchard-digest envelope, and the transcript lifts it into a scannable summary. '
      : 'Off. Neither injected nor parsed — plain prose only, and no tokens spent on the instruction. '));
    row.append(why);
    grp.append(row);

    if (on) grp.append(guidanceRow(readOnly, cfg));
    if (readOnly) grp.append(note(
      'The response format is project-wide — it shapes every session’s system prompt, so a running session can’t change it. Switch to “This project” to edit.'));
    return grp;
  }

  /* The optional per-project guidance textarea + live character count. Shown
     only when the digest is enabled. Persists on blur when the trimmed value
     actually changed (empty → cleared to null). */
  function guidanceRow(readOnly, cfg) {
    const wrap = el('div', { class: 'digest-guidance' });
    const cur = typeof cfg.guidance === 'string' ? cfg.guidance : '';
    // FEAT-146 round 4 — `.vin` and `rows` are gone: `.vin` is the right-aligned
    // inline value input (wrong shape entirely for a paragraph), and `rows`
    // fought the CSS min-height. The field is styled in styles.css `.guidance-in`
    // — full width, 96px, vertical-only resize, real theme tokens and the app's
    // own mono stack. It rendered as a raw light-grey UA widget in dark theme.
    const ta = el('textarea', {
      class: 'guidance-in',
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
/* FEAT-146 round 4 — GREYSCALE, and a word rather than a glyph.
 *
 * These six rows used to be led by `✅ ⚠️ ❌ ℹ️` in a 13px `.ic` span, which
 * fell through to Noto Color Emoji and painted Material red 500 and a Material
 * blue — the only two hues anywhere in the product, on the least important
 * screen in the modal, shouting louder than the provenance chip that is
 * supposed to be the one loud element. The state is reported in the panel's own
 * existing greyscale idiom instead: `.prov-state`, a dot plus a word, the same
 * component the provider verdict below uses. `--live` for present, `--warn` for
 * partial, a hollow ring for missing — luminance and shape, never hue.
 */
const WIRING_STATE = {
  ok: { status: 'connected', text: 'present' },
  warn: { status: 'installed-not-signed-in', text: 'partial' },
  missing: { status: 'not-installed', text: 'missing' },
  info: { status: 'unknown', text: 'not applicable' },
};

  function wiringGroup(p, readOnly) {
    const grp = el('div', { class: 'grp wiring', 'data-focus': 'wiring' }, groupLabel('Wiring'));
    if (d.wiring === undefined) {
      grp.append(note('Checking wiring…'));
      void refreshWiring(p.id);
      return grp;
    }
    if (d.wiring === null) {
      const retry = el('button', { class: 'mini', text: 'Check again' });
      retry.addEventListener('click', () => { d.wiring = undefined; paint(); });
      grp.append(note('This server has no wiring route yet (predates FEAT-076); wiring status is unavailable.'), el('div', { class: 'cacts' }, retry));
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
    const st = WIRING_STATE[c.state] ?? WIRING_STATE.info;
    const top = el('div', { class: 'top' },
      el('span', { class: 'l', text: c.label }),
      el('span', { class: 'prov-state', 'data-status': st.status },
        el('span', { class: 'dot', 'aria-hidden': 'true' }), document.createTextNode(st.text)));
    const busy = d.wiringBusy === c.key;
    if (c.apply && !readOnly && d.wiringArm !== c.key) {
      const label = c.apply === 'attach-wa' ? 'Attach' : 'Scaffold…';
      const btn = el('button', { class: 'mini wiring-apply', text: busy ? 'Working…' : label });
      if (busy || d.wiringBusy) btn.disabled = true;
      btn.addEventListener('click', () => {
        if (c.apply === 'attach-wa') void applyWiring(p, c);   // registry-only, no arm
        else { d.wiringArm = c.key; paint(); }                  // tree-mutating, arm first
      });
      top.append(btn);
    }
    row.append(top);
    row.append(el('div', { class: 'set-why', text: c.detail }));

    /* Armed scaffold confirm — names the exact repo the write lands in. */
    if (c.apply === 'onboard' && d.wiringArm === c.key && !readOnly) {
      const confirm = el('div', { class: 'wiring-confirm', 'data-armed': 'true' });
      confirm.append(note(`Scaffold the ticket board, drift-guard and conventions stub into “${p.name}” (${shortPath(p.hostPath)}). Idempotent — existing files are left untouched.`));
      const no = el('button', { class: 'mini', text: 'Cancel' });
      no.addEventListener('click', () => { d.wiringArm = null; paint(); });
      const yes = el('button', { class: 'mini wiring-go', text: busy ? 'Working…' : `Scaffold into ${p.name}` });
      if (busy) yes.disabled = true;
      yes.addEventListener('click', () => void applyWiring(p, c));
      confirm.append(el('div', { class: 'cacts' }, no, yes));
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
    // FEAT-146 phase 2 — repaint whenever the modal is open, not only when the
    // settings pane is showing: these reads now feed the rail DOTS too, and a dot
    // on an unvisited category must land even while another one is on screen.
    if (isOpenNow) paint();
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
    const grp = el('div', { class: 'grp', 'data-focus': 'snapshotsGroup' }, groupLabel('Snapshots'));
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

    const why = el('div', { class: 'set-why' });
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

    /* FEAT-146 phase 2 — no "open the list ›" any more: the list is the rest of
       THIS category, directly below. */
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
    const why = el('div', { class: 'set-why' });
    why.append(el('b', { text: 'This session has no restore point. ' }));
    why.append(document.createTextNode(
      'Its start snapshot did not complete, so nothing here can put the directory back to how it was when the session began. Taking one now protects everything from this moment on, but not what has already changed.'));
    if (error) why.append(el('span', { class: 'u', text: error }));
    n.append(why);
    return n;
  }

  function failureNote(fails) {
    const n = el('div', { class: 'risk', 'data-on': 'true' });
    const why = el('div', { class: 'set-why' });
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
    if (isOpenNow) paint();   // FEAT-146: the rail dots read this too — see prefetchForDots
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
    if (isOpenNow) paint();   // FEAT-146: the rail dots read this too — see prefetchForDots
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
        const acts = el('div', { class: 'cacts', 'data-armed': 'true' });
        const no = el('button', { class: 'mini', text: 'Not now' });
        no.addEventListener('click', () => { d.gitArm = null; paint(); });
        const yes = el('button', { class: 'mini', text: 'Init repository' });
        yes.addEventListener('click', () => void gitDo('init', {}, () => 'initialised an empty repository on branch main'));
        acts.append(el('span', { class: 'grp-note inline', text: 'Local only — nothing leaves this machine.' }), no, yes);
        grp.append(acts);
        grp.append(el('div', { class: 'cacts' }, terminalRow(p)));
      } else {
        const init = el('button', { class: 'mini', text: 'git init' });
        init.addEventListener('click', () => { d.gitArm = 'init'; paint(); });
        grp.append(el('div', { class: 'cacts' }, init, terminalRow(p)));
      }
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

    /* FEAT-146 round 4 — ONE action idiom. This card used to stack three: a
       bare text link with a `›`, a bordered `.mini`, and a bare `↻`. Because
       only the middle one had a border, its label was optically indented 19px
       from the links above and below it. Every action in this card is a `.mini`
       in one row now. */
    const workbench = el('button', { class: 'mini', text: s.dirty ? `Review and stage ${s.dirty} changed file${s.dirty === 1 ? '' : 's'}` : 'Open Git workbench' });
    workbench.addEventListener('click', () => ctx.openGit?.());

    const acts = el('div', { class: 'cacts' });
    if (d.gitArm !== 'push' && d.gitArm !== 'create') acts.append(workbench);
    if (d.gitArm === 'push') {
      acts.dataset.armed = 'true';
      const no = el('button', { class: 'mini', text: 'Not now' });
      no.addEventListener('click', () => { d.gitArm = null; paint(); });
      const yes = el('button', { class: 'mini', text: s.upstream ? 'Push' : `Push -u origin ${s.branch}` });
      yes.disabled = d.gitBusy;
      yes.addEventListener('click', () => void gitDo('push', {}, (r) => `pushed · ${r.detail || 'ok'}`));
      acts.append(el('span', { class: 'grp-note inline', text: `This publishes commits to ${s.remoteUrl ?? 'the remote'}.` }), no, yes);
    } else if (d.gitArm === 'create') {
      acts.dataset.armed = 'true';
      const nameIn = el('input', { class: 'gtext narrow', type: 'text', spellcheck: 'false', 'aria-label': 'Repository name' });
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
      const rf = el('button', { class: 'mini', text: 'Refresh', title: 'Re-read git status' });
      rf.addEventListener('click', () => { d.git = undefined; paint(); });
      acts.append(rf, terminalRow(p));
    }
    grp.append(acts);
    return grp;
  }

  function terminalRow(p) {
    const t = el('button', { class: 'mini', text: 'Open a terminal (kitty)', title: p.hostPath });
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
    if (isOpenNow) paint();   // FEAT-146: the rail dots read this too — see prefetchForDots
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
    const rf = el('button', { class: 'mini', text: 'Refresh' });
    rf.addEventListener('click', () => { d.procs = undefined; paint(); });
    grp.append(el('div', { class: 'cacts' }, rf));
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
      acts.dataset.armed = 'true';
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
    if (isOpenNow) paint();   // FEAT-146: the rail dots read this too — see prefetchForDots
  }

  /**
   * FEAT-146 phase 2 — the memory LIST renders here, inline in Advanced, instead
   * of behind a "open the list ›" navigation into a separate view. One surface,
   * one builder: `memoriesView()` below is the same card, kept so the old
   * `open('memories')` door still resolves.
   */
  function memoriesGroup(p) {
    const grp = el('div', { class: 'grp', 'data-focus': 'memories' }, groupLabel('Agent memories'));
    const intro = el('div', { class: 'grp-note' });
    intro.append(document.createTextNode('What Claude concluded and saved about this project — auto-loaded into every session. '),
      el('code', { text: 'CLAUDE.md' }),
      document.createTextNode(' is what you told it; these drift on their own. Read and prune here; edit in a real editor.'));
    grp.append(intro);

    if (d.memories === undefined) {
      void refreshMemories(p.id);
      grp.append(note('Checking for memory files…'));
      return grp;
    }
    if (d.memories === null) return grp.append(note('This server does not list memories yet.')), grp;
    const files = d.memories.memories ?? [];
    if (!files.length) {
      grp.append(note('No memory files exist for this project — nothing is being silently loaded into its sessions.'));
      return grp;
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
    return grp;
  }

  function memoriesView() {
    const wrap = document.createDocumentFragment();
    const p = project();
    if (!p) return wrap;
    wrap.append(memoriesGroup(p));
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
            acts.dataset.armed = 'true';
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
    /* FEAT-146 phase 2 — the settings card that decides whether snapshots happen
       at all now sits directly above the list it governs, instead of in
       Isolation two categories away. */
    wrap.append(snapshotsGroup(p, d.scope === 'session'));

    /* "Taken so far", not a second card headed "Snapshots": the settings card
       directly above already carries that name, and two identical headings in
       one pane is the kind of thing the old scroll got away with. */
    const grp = el('div', { class: 'grp', 'data-focus': 'snapshots' }, groupLabel('Taken so far'));
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

    /* exclusionTruth() is NOT repeated here any more: the card above states it
       once, next to the exclude list it is about. */
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
        acts.dataset.armed = 'true';
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
    // data-armed is read by the modal's close guard (FEAT-146): a backdrop click
    // or Esc must not discard a half-finished ceremony. Marker only — nothing
    // about this ceremony's wording, styling or placement changes.
    const box = el('div', { class: 'ceremony', 'data-armed': 'true' });

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
    // FEAT-146 round 4 — NOT `Restore ${p.name}`. A 62-character project name
    // made an 830px button, and a longer one would wrap or overflow. Which
    // project is being overwritten is stated three times above this button, in
    // the heading, the path line and the field label you just typed it into.
    const go = el('button', { class: 'mini danger', text: 'Restore this project' });
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
    note(`${what} can only be set for the whole project — a session cannot change it without rebuilding the container for every other session. Switch to “This project” to change it.`);

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

    const why = el('div', { class: 'set-why' });
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
    // container.* is project-only by design (a per-session image would rebuild
    // the container under every other session), so under the session lens the
    // chip says exactly that rather than "inherited".
    const p = provOf({ project: isSet(cur), projectOnly: true });
    const chip = provChip(p);
    if (chip) n.append(chip);
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
    n.append(gutter(n, {
      key: 'container.image', label: 'Base image', prov: p, why: WHY['container.image'], control: input,
      resetTo: { level: 'built-in', text: 'Orchard’s own image' },
      onReset: readOnly ? null : () => void putContainer({ image: null }),
    }));
    return n;
  }

  const MEM_CYCLE = [2048, 4096, 8192, 12288];

  function memoryRow(readOnly = false) {
    const cur = settings().container?.memoryMb ?? null;
    const n = el('div', { class: 'set' });
    const p = provOf({ project: isSet(cur), projectOnly: true });
    const lab = el('span', { class: 'l' }, document.createTextNode('Memory cap'), el('span', { class: 'f', text: '--settings › container.memoryMb' }));
    const valueText = cur ? `${(cur / 1024).toFixed(0)} GB` : 'default';
    const v = el('span', { class: `v${p ? '' : ' dim'}`, text: valueText });
    const chip = provChip(p);
    if (readOnly) {
      n.append(lab);
      if (chip) n.append(chip);
      n.append(v);
    } else {
      n.dataset.cycle = 'true';
      n.title = 'Click to change';
      n.append(el('button', { type: 'button', class: 'set-main', 'aria-label': `Memory cap: ${valueText}. Activate to change.` },
        lab, chip, v));
      n.addEventListener('click', () => {
        const i = MEM_CYCLE.indexOf(cur);
        void putContainer({ memoryMb: MEM_CYCLE[(i + 1) % MEM_CYCLE.length] });
      });
    }
    n.append(gutter(n, {
      // No reset: the server has no "unset" for this field (validate.ts requires
      // an integer >= 512), and inventing one would mean a second write path
      // into container settings. The gutter is still reserved, so the row's
      // geometry matches every other row exactly.
      key: 'container.memoryMb', label: 'Memory cap', prov: p, onReset: null,
    }));
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
    if (isOpenNow) paint();   // FEAT-146: the rail dots read this too — see prefetchForDots
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
    const why = el('div', { class: 'set-why' });
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
      // FEAT-146 — the `⠿` drag handle is GONE. It was never draggable: it had
      // no drag listeners and its own title said "Use the arrows to reorder",
      // so it advertised an interaction the row does not support. An affordance
      // that lies is worse than no affordance; the ▲/▼ arrows are the real (and
      // keyboard-reachable) reorder control.

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
    // FEAT-146 round 4 — the marker column is RESERVED on every row. Rendering
    // it only on `living` rows put sibling titles on two left rails 25px apart.
    nm.append(el('span', { class: `spark${t.living ? '' : ' off'}`, 'aria-hidden': 'true' }));
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
    /* FEAT-146 phase 2 — carries the `globalTemplates` anchor: a deep link at
       the templates library lands on the library, not on a link to it. */
    const wrap = catWrap('globalTemplates');

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
      // FEAT-146 round 4 — the <details> goes INSIDE the card, not around it.
      // `PATTERNS (OPT-IN) · 4` was a card header with no card under it: the
      // summary sat on the pane background while every other heading in the
      // modal sits on a `.grp`.
      const kids = [note('Reusable dispatch SHAPES from real projects. Nothing auto-injects these — a project only gets one if it explicitly opts in. Niche but proven; expand to browse.')];
      for (const t of patterns) kids.push(templateRow(t));
      const sect = section('patterns', `Patterns (opt-in) · ${patterns.length}`, false, kids);
      if (sect) wrap.append(el('div', { class: 'grp' }, sect));
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
    // FEAT-146 — the editor is a pane-level takeover INSIDE the content column
    // (it keeps the ← button), never a nested modal. So the other views simply
    // switch off; the pane host itself stays put.
    for (const n of Object.values(node.views)) n.classList.remove('on');
    node.editor.classList.add('on');
    clear(node.edMeta);
    node.edMeta.append(document.createTextNode(t.description || 'No description.'));
    node.edMeta.append(el('span', { class: 'u', text: `${t.id || 'new'} · default mode ${t.defaultMode}${t.living ? ' · living' : ''}` }));
    node.edText.value = t.body ?? '';
    // paint() returns early for the editor, so the close guard's dirty-field
    // baseline is stamped here instead — unsaved template text is exactly what
    // a stray backdrop click must not be allowed to throw away.
    node.edText.dataset.base146 = node.edText.value;
    updateEdFoot();
    openModal();
    paintChrome();
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
    d.back = catOf(d.cat).view;
    d.view = 'instructions';
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
    /* FEAT-146 — the account list is NOT fetched here any more. app.js owns it
       (ARCH-010); `ensureAccounts()` asks the owner and this module keeps no
       copy of its own. */
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
      // FEAT-146 round 4 — `'machine'` was missing. FEAT-146 introduced it as
      // the view every machine-scope category renders through, and this guard
      // was never updated, so the FIRST-ever visit to Accounts / New-project
      // defaults painted "Loading machine-wide defaults…" and the resolution
      // repainted nothing: the user sat on a loading string until their next
      // click. Reported by the round-3 suite sweep, fixed here.
      if (d.view === 'globals' || d.view === 'settings' || d.view === 'machine') paint();
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

  /**
   * FEAT-139 — a machine-scope tri-state control: "Built-in" (no machine
   * default, `null`), plus one button per concrete value. Writing "Built-in"
   * clears the field so the product's own default applies again. Used for the
   * new-project isolation tier and each tool toggle. `values` is [key,label][].
   */
  function globalSeg(field, values, current) {
    const seg = el('div', { class: 'seg gseg' });
    const mk = (key, label, val) => {
      const pressed = current === val;
      const b = el('button', { 'aria-pressed': String(pressed), text: label });
      b.addEventListener('click', () => { if (!pressed) saveGlobal(field, val); });
      return b;
    };
    seg.append(mk('__none__', 'Built-in', null));
    for (const [key, label] of values) seg.append(mk(key, label, key));
    return seg;
  }

  /* ------------------------------- FEAT-145 step 3: Claude accounts + login */

  /**
   * Re-read the account list and repaint. FEAT-146: the READ belongs to app.js
   * (see the ARCH-010 note at the top of this file) — this asks the owner to
   * refresh and then repaints, rather than keeping a second list. `acctDesc`
   * (plan + login state) is the owner's `acctPlanDesc`, for the same reason.
   */
  function refreshAccounts() {
    return Promise.resolve(ctx.refreshAccounts?.({ force: true }))
      .then(() => { if (isOpenNow) paint(); });
  }

  function closeLoginSocket(L) {
    if (!L?.ws) return;
    try { L.ws.close(); } catch { /* already gone */ }
    L.ws = null;
  }

  /**
   * Drive one "Add account" login over the SAME WebSocket endpoint the rest of
   * the app uses (api.wsUrl) — a login is not a session, so it gets its own
   * connection rather than sharing the session-driving socket, exactly like
   * app.js's passive watch socket.
   *
   * The server owns the CLI: it streams output, scrapes the authorize URL,
   * takes the pasted code on stdin, and kills the whole process group on
   * cancel/close. This side only renders and relays.
   */
  function startLogin(account) {
    const L = {
      accountId: account.id,
      label: account.label,
      url: null,
      status: null,       // { message, urlFound, raw } — the degradation report
      done: null,         // the single verdict event
      sent: false,        // a code has been handed over
      ws: null,
      // Owned DOM: a repaint re-appends these nodes instead of rebuilding them,
      // so streamed output is never lost and a half-typed code survives.
      out: el('pre', { class: 'loginout', 'aria-label': 'Claude CLI output' }),
      codeInput: el('input', {
        type: 'text', class: 'gtext', id: 'gAcctCode', autocomplete: 'off', spellcheck: 'false',
        // Short on purpose: the drawer column is ~200px, and a longer
        // placeholder is truncated mid-word (measured in the real drawer).
        placeholder: 'paste the code',
        'aria-label': 'Authorization code from the Claude sign-in page',
      }),
    };
    d.acctLogin = L;
    let ws;
    try {
      ws = new WebSocket(api.wsUrl());
    } catch (err) {
      L.done = { ok: false, reason: `could not open a connection to the server: ${err.message}` };
      paint();
      return;
    }
    L.ws = ws;
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'claude-login-start', accountId: account.id }));
    });
    ws.addEventListener('message', (ev) => {
      let e;
      try { e = JSON.parse(ev.data); } catch { return; }
      if (d.acctLogin !== L) return; // a newer attempt owns the panel
      if (e.t === 'claude-login-output') {
        // Append in place — no repaint, so the user's cursor and scroll stay put.
        L.out.append(document.createTextNode(e.text));
        L.out.scrollTop = L.out.scrollHeight;
        return;
      }
      if (e.t === 'claude-login-url') { L.url = e.url; paint(); return; }
      if (e.t === 'claude-login-status') { L.status = e; paint(); return; }
      if (e.t === 'claude-login-done') {
        L.done = e;
        closeLoginSocket(L);
        if (e.ok) {
          ctx.notify(`Claude account “${L.label}” is signed in${e.subscriptionType ? ` (${e.subscriptionType})` : ''}`);
          void refreshAccounts();
        } else if (e.accountRemoved) {
          void refreshAccounts();
        }
        paint();
        return;
      }
      if (e.t === 'error') {
        L.done = { ok: false, reason: e.message };
        closeLoginSocket(L);
        void refreshAccounts();
        paint();
      }
    });
    ws.addEventListener('close', () => {
      if (d.acctLogin !== L || L.done) return;
      // The server cancels the CLI when this socket drops, so saying the
      // sign-in stopped is the truth, not a guess.
      L.done = { ok: false, reason: 'the connection to the server dropped — the sign-in was stopped' };
      void refreshAccounts();
      paint();
    });
  }

  /** The label form. A label is user-supplied because it names the user's own
   *  subscription (e.g. "work" vs "personal"); the CLI's `email` field is not
   *  reliable enough to build this on — it has been observed both null and
   *  populated for real subscription logins, so nothing branches on it. */
  function addAccountForm() {
    const box = el('div', { class: 'gcustom' });
    const input = el('input', {
      type: 'text', class: 'gtext', id: 'gAcctLabel',
      placeholder: 'e.g. Work Max plan',
      'aria-label': 'Name for the new Claude account',
      value: d.acctAdd?.label ?? '',
    });
    const go = el('button', { type: 'button', class: 'gbtn', id: 'gAcctCreate', text: 'Add' });
    const cancel = el('button', { type: 'button', class: 'mini', text: 'Cancel' });
    cancel.addEventListener('click', () => { d.acctAdd = null; paint(); });
    const submit = async () => {
      const label = input.value.trim();
      if (!label) { ctx.notify('give the account a name so you can tell the two subscriptions apart', true); return; }
      go.disabled = true;
      d.acctAdd = { label, busy: true };
      try {
        const account = await api.createClaudeAccount(label);
        d.acctAdd = null;
        await refreshAccounts();
        startLogin(account);
        paint();
      } catch (err) {
        d.acctAdd = { label, busy: false };
        ctx.notify(`could not add the account: ${err.message}`, true);
        paint();
      }
    };
    go.addEventListener('click', submit);
    input.addEventListener('input', () => { if (d.acctAdd) d.acctAdd.label = input.value; });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    if (d.acctAdd?.busy) { go.disabled = true; go.textContent = 'Adding…'; }
    box.append(input, go, cancel);
    return box;
  }

  /** The live sign-in panel: the URL (clickable AND selectable), the code
   *  field, the CLI's own output, and a cancel that really stops the CLI. */
  function loginPanel() {
    const L = d.acctLogin;
    // FEAT-146 round 4 — the heading was `SIGNING IN — <label>`, uppercase and
    // tracked at full card width, so a 76-character account label wrapped at
    // 800px. A fixed heading, with the user's own string in sentence case below
    // it where wrapping is ordinary.
    const box = el('div', { class: 'acctlogin' }, groupLabel('Signing in'));
    box.append(note(L.label));

    if (L.done) {
      box.append(note(L.done.ok
        ? `Signed in. “${L.label}” is ready to use${L.done.subscriptionType ? ` on the ${L.done.subscriptionType} plan` : ''}.`
        : `Not signed in. ${L.done.reason}`));
      if (!L.done.ok && !L.done.accountRemoved) {
        box.append(note('The account was kept as “not logged in yet” so you can try again; delete it below if you would rather start over.'));
      }
      const acts = el('div', { class: 'cacts' });
      const close = el('button', { class: 'mini', text: 'Close' });
      close.addEventListener('click', () => { d.acctLogin = null; void refreshAccounts(); paint(); });
      acts.append(close);
      box.append(L.out, acts);
      return box;
    }

    if (L.url) {
      box.append(note('Open this page, approve the sign-in, then paste the code it gives you below. It opens on THIS device only if you click it — the address is shown in full so you can open it on the machine where you are signed in to Claude.'));
      const link = el('a', { class: 'acctlink', href: L.url, target: '_blank', rel: 'noopener noreferrer', text: 'Open the Claude sign-in page ↗' });
      box.append(link);
      // FEAT-146 round 4 — `joined`: a field and the button that acts on that
      // field are one control, not two bordered boxes 15px apart.
      const urlRow = el('div', { class: 'gcustom joined' });
      const urlField = el('input', { type: 'text', class: 'gtext mono', readonly: true, value: L.url, 'aria-label': 'Claude sign-in URL' });
      urlField.addEventListener('focus', () => urlField.select());
      const copy = el('button', { type: 'button', class: 'gbtn', text: 'Copy' });
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(L.url); ctx.notify('sign-in link copied'); }
        catch { urlField.select(); ctx.notify('press ⌘/Ctrl-C to copy the selected link', true); }
      });
      urlRow.append(urlField, copy);
      box.append(urlRow);
    } else if (L.status && L.status.urlFound === false) {
      box.append(note(L.status.message));
      box.append(note('Raw output from the CLI (no sign-in link was recognised in it):'));
      box.append(el('pre', { class: 'loginout', text: L.status.raw ?? '' }));
    } else {
      box.append(note('Starting the Claude CLI and waiting for its sign-in link…'));
      if (L.status) box.append(note(L.status.message));
    }

    const codeRow = el('div', { class: 'gcustom joined' });
    const sendCode = el('button', { type: 'button', class: 'gbtn', id: 'gAcctCodeSend', text: L.sent ? 'Resend' : 'Send code' });
    const submitCode = () => {
      const code = L.codeInput.value.trim();
      if (!code) { ctx.notify('paste the code from the sign-in page first', true); return; }
      if (!L.ws || L.ws.readyState !== WebSocket.OPEN) { ctx.notify('the sign-in connection is closed — cancel and try again', true); return; }
      L.ws.send(JSON.stringify({ type: 'claude-login-code', code }));
      // Clear it immediately: the code is a credential, and it is never needed
      // again on this side (the server holds it only to redact it from output).
      L.codeInput.value = '';
      L.sent = true;
      paint();
    };
    sendCode.addEventListener('click', submitCode);
    L.codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitCode(); } });
    codeRow.append(L.codeInput, sendCode);
    box.append(codeRow);

    box.append(L.out);

    const acts = el('div', { class: 'cacts' });
    const cancel = el('button', { class: 'mini danger', id: 'gAcctCancel', text: 'Cancel sign-in' });
    cancel.addEventListener('click', () => {
      if (L.ws && L.ws.readyState === WebSocket.OPEN) L.ws.send(JSON.stringify({ type: 'claude-login-cancel' }));
      else { closeLoginSocket(L); d.acctLogin = null; void refreshAccounts(); paint(); }
    });
    acts.append(el('span', { class: 'grp-note inline', text: 'Stops the CLI and removes the half-made account.' }), cancel);
    box.append(acts);
    return box;
  }

  /** The account list + its delete ceremony + the add/login surface. */
  function accountsPanel(accounts) {
    const box = el('div', { class: 'grp acctlist', 'data-focus': 'accounts' }, el('div', { class: 'grp-l sub', text: 'Accounts on this machine' }));
    for (const a of accounts) {
      const row = el('div', { class: 'set' });
      row.append(el('span', { class: 'l' },
        document.createTextNode(a.id === 'default' ? 'Default (~/.claude)' : a.label),
        el('span', { class: 'f', text: a.id === 'default'
          ? 'the credential this machine already had'
          : `${a.state === 'ready' ? 'signed in' : 'not signed in yet'}${a.lastStatus?.subscriptionType ? ` · ${a.lastStatus.subscriptionType} plan` : ''}` })));
      if (a.id !== 'default') {
        if (d.acctConfirm === a.id) {
          row.dataset.armed = 'true';
          const no = el('button', { class: 'mini', text: 'Keep' });
          no.addEventListener('click', () => { d.acctConfirm = null; paint(); });
          const yes = el('button', { class: 'mini danger', text: `Delete “${a.label}”` });
          yes.addEventListener('click', async () => {
            yes.disabled = true;
            try {
              await api.deleteClaudeAccount(a.id);
              ctx.notify(`Claude account “${a.label}” deleted — its credential is gone`);
            } catch (err) {
              ctx.notify(`could not delete “${a.label}”: ${err.message}`, true);
            }
            d.acctConfirm = null;
            await refreshAccounts();
          });
          row.append(el('span', { class: 'v' }, no, yes));
        } else {
          const del = el('button', { class: 'mini x', text: 'Delete…' });
          del.addEventListener('click', () => { d.acctConfirm = a.id; paint(); });
          row.append(el('span', { class: 'v' }, del));
        }
      }
      /* The default row gets NO `.v` value: that column is a narrow mono slot
         (it wraps a two-word phrase one letter per line), and the only thing
         there is to say about the default is already its sub-label. It is also
         the honest choice — nothing probes ~/.claude's plan, so a "max" there
         would be invented. */
      box.append(row);
      // The confirm names the account AND what deleting it costs — this removes
      // a credential, which no other row in this drawer does.
      if (d.acctConfirm === a.id) {
        box.append(note(`Deleting “${a.label}” signs that subscription out of Orchard: its ~/.claude overlay and the credential inside it are removed (the shared transcript history is untouched). You would add it again with a fresh sign-in.`));
      }
    }

    if (d.acctLogin) {
      box.append(loginPanel());
    } else if (d.acctAdd) {
      box.append(addAccountForm());
      box.append(note('Name it however you think of it — “Work Max”, “Personal”. The Claude CLI reports no name for a subscription login, so this label is the only way to tell two plans apart.'));
    } else {
      const add = el('button', { class: 'addrow', id: 'gAcctAdd', text: '+ Add account' });
      add.addEventListener('click', () => { d.acctAdd = { label: '', busy: false }; paint(); });
      box.append(add);
      box.append(note('Signs a second Claude subscription in through the Claude CLI: Orchard shows you the sign-in link, you paste back the code, and the credential is stored in that account’s own overlay of ~/.claude. Nothing is swapped by hand and the transcript history stays shared.'));
    }
    return box;
  }

  /**
   * The Accounts CATEGORY (FEAT-146 phase 2): which subscription new sessions
   * bill to by default, then the accounts themselves — list, add, sign-in,
   * delete. It used to be one card buried three quarters of the way down the
   * machine-defaults scroll.
   *
   * ---- FEAT-145 step 4 ----
   * Inherited LIVE like model/effort (machine → project → session). Each account
   * is a thin overlay over ~/.claude that differs only in the credential, so the
   * transcript history is shared.
   */
  function accountsPane() {
    ensureAccounts();
    const ag = el('div', { class: 'grp', 'data-focus': 'globalAccount' }, groupLabel('Default Claude account'));
    const st = accountsState();
    if (st === undefined) {
      ag.append(note('Checking accounts…'));
      return catWrap(null, ag);
    }
    const rows = accountList();
    const extra = rows.filter((a) => a && a.id !== 'default');
    if (!extra.length) {
      ag.append(note('Only the default account (~/.claude) is set up, so every session uses it. Add a second Claude subscription below to switch plans without swapping credentials by hand — sessions still share one transcript history.'));
    } else {
      const g = d.globals ?? {};
      const asel = el('select', { class: 'gsel', id: 'gAccountSel', 'aria-label': 'Global default Claude account' });
      const curAccount = g.claudeAccount ?? null;
      const dfltRow = rows.find((a) => a && a.id === 'default');
      const win = (id) => { const w = acctWindow(id); return w ? ` · ${w}` : ''; };
      const o0 = el('option', { value: '', text: `Default (~/.claude)${acctDesc(dfltRow)}${win('default')}` });
      if (!curAccount) o0.selected = true;
      asel.append(o0);
      for (const a of extra) {
        const o = el('option', { value: a.id, text: `${a.label}${acctDesc(a)}${win(a.id)}` });
        if (curAccount === a.id) o.selected = true;
        asel.append(o);
      }
      asel.addEventListener('change', () => saveGlobal('claudeAccount', asel.value || null));
      ag.append(asel);
      ag.append(note('Which Claude subscription new sessions bill to (machine → project → session). Each account is a thin overlay over ~/.claude — the transcript history is shared, only the credential differs. A project can pin its own account under Model & spend.'));
    }
    return catWrap(null, ag, accountsPanel(rows));
  }

  /* FEAT-139 — appearance is a machine-wide preference, so it lives in the
     Machine scope beside the other machine defaults. localStorage stays the fast
     client read; this is the surface. ctx owns the <html>/localStorage write. */
  function appearanceGroup() {
    const grp = el('div', { class: 'grp', 'data-focus': 'appearance' }, groupLabel('Appearance'));
    const themes = ctx.themes?.() ?? ['system', 'light', 'dark'];
    const cur = ctx.getTheme?.() ?? 'system';
    const LBL = { system: 'System', light: 'Light', dark: 'Dark' };
    const seg = el('div', { class: 'seg gseg' });
    for (const t of themes) {
      const b = el('button', { 'aria-pressed': String(cur === t), text: LBL[t] ?? t });
      b.addEventListener('click', () => { ctx.setTheme?.(t); paint(); });
      seg.append(b);
    }
    grp.append(seg);
    grp.append(note(cur === 'system'
      ? 'Following the operating system’s light/dark setting. Pick Light or Dark to pin it for this browser.'
      : `Pinned to ${LBL[cur] ?? cur} in this browser. Switch back to System to follow the OS setting.`));
    return grp;
  }

  /**
   * FEAT-146 round 4 — the second thing Appearance owns.
   *
   * "Show all descriptions" is a MACHINE-level visual preference (it is stored
   * in localStorage, it applies to every project, and it changes nothing but
   * what is on screen), and until now the only way to reach it was a toggle in
   * the footer — which says what it does but not that the choice persists. It
   * belongs here, stated as a default, with the footer toggle left in place as
   * the in-context switch. One preference, one store: both read and write
   * `d.whyAll` through setWhyAll, so there is no second place holding an answer.
   */
  function descriptionsGroup() {
    const grp = el('div', { class: 'grp', 'data-focus': 'descriptions' }, groupLabel('Descriptions'));
    const seg = el('div', { class: 'seg gseg' });
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'When to show setting descriptions');
    for (const [on, label] of [[false, 'Only when asked'], [true, 'Always show']]) {
      const b = el('button', { 'aria-pressed': String(d.whyAll === on), text: label });
      b.addEventListener('click', () => { if (d.whyAll !== on) setWhyAll(on); });
      seg.append(b);
    }
    grp.append(seg);
    grp.append(note(d.whyAll
      ? 'Every ⓘ description is expanded as soon as a category opens. The same switch is in the footer of every category.'
      : 'A setting’s description stays collapsed until you press its ⓘ. Sentences about data loss, security or cost are never behind an icon — they always render in full, and the absence of an ⓘ is itself the signal.'));
    return grp;
  }

  /**
   * FEAT-146 phase 2 — the machine group filters too: Appearance, Accounts and
   * New-project defaults are three categories, not one long scroll.
   */
  function machineDefaultsView() {
    const wrap = document.createDocumentFragment();
    if (d.cat === 'appearance') {
      wrap.append(catWrap(null, appearanceGroup(), descriptionsGroup()));
      return wrap;
    }
    ensureGlobals();
    if (d.cat === 'accounts') {
      wrap.append(accountsPane());
      return wrap;
    }
    if (d.globals === undefined) {
      wrap.append(el('div', { class: 'grp' }, note('Loading machine-wide defaults…')));
      return wrap;
    }
    const g = d.globals;
    const catalog = d.modelCatalog ?? [];

    const intro = el('div', { class: 'grp' }, groupLabel('What these are'));
    intro.append(note('The defaults every new project on this machine starts from. Model and effort are inherited LIVE — change one and every project that hasn’t set its own picks it up on its next session (order: machine → project → session). The new-project defaults below (isolation, dispatch, MCP tools) SEED a project when it is created; changing them never rewrites projects that already exist.'));
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
    const eg = el('div', { class: 'grp', 'data-focus': 'globalEffort' }, groupLabel('Default effort'));
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

    /* ---- new-project defaults: isolation + the dispatch/MCP tool toggles the
       user named. These SEED a project at creation (existing projects keep their
       own stored value), so their copy says "new projects" — never "inherited",
       which would be a lie for these fields (FEAT-139). ---- */
    const np = el('div', { class: 'grp', 'data-focus': 'newProjectDefaults' }, groupLabel('New-project defaults'));
    np.append(note('What a newly-created project is set up with, unless you choose otherwise for it at creation. “Built-in” uses Orchard’s own default. Changing these does not touch projects that already exist.'));

    /* These rows are LABEL + a full-width `.seg` beneath — a scalar row and a
       block never share one row. The chip still belongs on the label row: here
       the write target IS the machine, so a stored seed reads as filled
       `machine` and an unset one carries no chip at all. */
    const isoRow = el('div', { class: 'set gset' });
    isoRow.append(el('span', { class: 'l', text: 'Isolation' }, el('span', { class: 'f', text: 'do sessions run in a container?' })));
    const isoProv = provOf({ machine: isSet(g.isolation), target: 'machine' });
    const isoChip = provChip(isoProv);
    if (isoChip) isoRow.append(isoChip);
    isoRow.append(gutter(isoRow, { key: 'global.isolation', label: 'Isolation', prov: isoProv, onReset: null }));
    np.append(isoRow);
    np.append(globalSeg('isolation', [['container', 'Container'], ['sandbox', 'Sandbox'], ['direct', 'Direct']], g.isolation));
    np.append(note(g.isolation === 'container'
      ? 'New projects try Container (isolated; falls back to Direct if this machine can’t run one). Built-in behaves the same today.'
      : g.isolation
        ? `New projects are created ${g.isolation}. Container isolation is the safer default where the machine supports it.`
        : 'Built-in: new projects try Container and fall back to Direct when the machine can’t run one.'));

    for (const spec of [
      { field: 'openaiDispatch', label: 'OpenAI dispatch', flag: 'host-brokered Codex dispatch', builtin: 'on' },
      { field: 'serena', label: 'Serena (LSP)', flag: 'symbol-level code tools', builtin: 'on' },
      { field: 'playwright', label: 'Playwright', flag: 'headless browser for UI tests', builtin: 'on where provisioned' },
    ]) {
      const r = el('div', { class: 'set gset' });
      r.append(el('span', { class: 'l', text: spec.label }, el('span', { class: 'f', text: spec.flag })));
      const prov = provOf({ machine: isSet(g[spec.field]), target: 'machine' });
      const chip = provChip(prov);
      if (chip) r.append(chip);
      const seg = globalSeg(spec.field, [[true, 'On'], [false, 'Off']], g[spec.field]);
      // The seg IS this row's control, so it is what carries aria-describedby
      // while the description is open; role="group" makes it a legal target.
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', spec.label);
      r.append(gutter(r, {
        key: `global.${spec.field}`, label: spec.label, prov, why: WHY[spec.field], control: seg, onReset: null,
      }));
      np.append(r);
      np.append(seg);
    }
    np.append(note('Playwright still only attaches on a machine where its binary is provisioned — On here means “try it”, not “force it”.'));
    wrap.append(np);

    /* FEAT-146 phase 2 — the "Instruction templates ›" link card is gone: the
       library is a rail category one click away, so a link to it from here was a
       second door to the same room. Its `globalTemplates` anchor now lands on
       the Templates category itself. */

    /* ---- which projects override the model default ---- */
    const overriders = (d.globalProjects ?? []).filter((p) => p?.settings && p.settings.model != null);
    const og = el('div', { class: 'grp', 'data-focus': 'modelOverrides' }, groupLabel('Projects that override the model'));
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
    settings: { el: 'settings', build: settingsView },
    // FEAT-146 — machine defaults are a rail GROUP now, not a scope and not a
    // separate door. They render into the same pane host; there is no state to
    // preserve between the two, so no second host earns its keep.
    machine: { el: 'settings', build: machineDefaultsView },
    instructions: { el: 'instructions', title: 'Instructions', build: instructionsView },
    snapshots: { el: 'snapshots', build: snapshotsView },
    library: { el: 'library', build: libraryView },
    memories: { el: 'memories', title: 'Agent memories', build: memoriesView },
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

  /* ─────────────────────────── FEAT-146: the rail ─────────────────────── */

  /** Build the rail ONCE per open. Never rebuilt on a lens flip or a repaint —
   *  rebuilding it would move focus out from under the keyboard user mid-browse
   *  and is exactly the page instability the lens is designed not to cause. */
  function buildRail() {
    clear(node.rail);
    let group = null;
    let list = null;
    for (const c of RAIL) {
      if (c.group !== group) {
        group = c.group;
        const h = el('h3', { id: `sRailH-${group}`, text: GROUP_LABEL[group] });
        node.rail.append(h);
        list = el('ul', { role: 'list', 'aria-labelledby': h.id });
        node.rail.append(list);
      }
      const b = el('button', {
        type: 'button',
        class: 'srail-item',
        id: `sRail-${c.id}`,
        'data-cat': c.id,
        tabindex: '-1',
      }, el('span', { class: 'n', text: c.label }), el('span', { class: 'd', 'aria-hidden': 'true' }));
      b.addEventListener('click', () => selectCat(c.id));
      list.append(el('li', {}, b));
    }
    node.rail.addEventListener('keydown', onRailKey);
    markRail();
  }

  const railItems = () => [...node.rail.querySelectorAll('.srail-item')];

  /** Is the rail the horizontal strip? (the <860px layout — see styles.css) */
  const railIsStrip = () => window.matchMedia?.('(max-width: 860px)')?.matches === true;

  /**
   * FEAT-146 round 4 — bring the SELECTED category into view.
   *
   * Below 860px the rail is a horizontal scroller measuring scrollWidth 1499
   * against clientWidth 500: five items off screen at 800px and seven at 500px,
   * and nothing ever scrolled the selected one back. Selecting a category by
   * deep link, by keyboard, or by `selectCat` from another card could leave the
   * one thing that says where you are entirely off the left edge — and at 500px
   * the pill that WAS partly visible was sliced mid-word.
   *
   * `inline: 'center'` so a selection never lands flush against the fade, and
   * `block: 'nearest'` so this can never scroll the pane or the page. Guarded on
   * the strip layout: the desktop rail is `overflow: hidden` and has nothing to
   * scroll, so calling this there could only move an ancestor.
   */
  function revealSelectedCat() {
    if (!railIsStrip()) return;
    node.rail.querySelector(`.srail-item[data-cat="${d.cat}"]`)
      ?.scrollIntoView({ inline: 'center', block: 'nearest' });
    updateRailEdges();
  }

  /**
   * FEAT-146 round 5 — the edge fades say where the strip ACTUALLY continues.
   *
   * Round 4 added a 24px mask fade at both ends of the narrow rail so "there is
   * more" is visible without a scrollbar. It was static: both ends faded even at
   * `scrollLeft: 0`, so the left edge suggested content behind it when the strip
   * was already at its start — a fade that means "more this way" is a lie in the
   * one position where there is nothing that way, and it dims the FIRST category
   * for no reason.
   *
   * The scroll position is the fact; nothing else can derive it. It is written
   * ONCE here onto `data-edge` (a token list: `start`, `end`, both, or `none`)
   * and the stylesheet reads it — no second copy, no per-rule recomputation
   * (docs/CONVENTIONS.md, ARCH-010). Cheap enough for a scroll handler: two
   * layout reads and a string compare, and the attribute is only written when
   * the token set actually changes.
   *
   * The 1px slack absorbs fractional scroll offsets (a zoomed or
   * device-pixel-ratio'd layout makes `scrollLeft` fractional, and an exact
   * `=== max` test would flicker the end fade on and off at rest).
   */
  function updateRailEdges() {
    const r = node.rail;
    if (!r) return;
    const max = r.scrollWidth - r.clientWidth;
    const atStart = r.scrollLeft <= 1;
    const atEnd = max <= 1 || r.scrollLeft >= max - 1;
    const v = [atStart ? null : 'start', atEnd ? null : 'end'].filter(Boolean).join(' ') || 'none';
    if (r.dataset.edge !== v) r.dataset.edge = v;
  }

  /** Selection state only — no DOM rebuild, so focus and scroll survive. */
  function markRail() {
    for (const b of railItems()) {
      const on = b.dataset.cat === d.cat;
      if (on) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
      b.tabIndex = on ? 0 : -1;               // roving tabindex
    }
    // The pane is labelled by whichever rail button is selected.
    node.body.setAttribute('aria-labelledby', `sRail-${d.cat}`);
    revealSelectedCat();
    // Unconditionally, not only via revealSelectedCat: at desktop width that
    // returns early, and a stale `start end` left over from a narrow layout
    // would outlive the layout it described.
    updateRailEdges();
  }

  /**
   * Live/needs-you dots, updated IN PLACE on every paint. Silence is the
   * default: a category whose state is still unfetched gets no dot rather than
   * a reassuring blank one. No counts, no badges.
   */
  function paintRailDots() {
    const dot = (id, v) => {
      const b = node.rail.querySelector(`.srail-item[data-cat="${id}"]`);
      if (!b) return;
      if (v) b.dataset.dot = v; else delete b.dataset.dot;
    };
    const p = project();
    /* FEAT-146 phase 2 — the real conditions, all read from state the panel
       already holds (prefetchForDots asks for the three that need a route, on
       open, exactly as the old all-in-one pane did). A category whose state is
       still unfetched gets NO dot: silence, never a reassuring blank one.

       --warn = something needs YOU. --live = something is running. */
    const ss = ctx.getStartSnapshot?.();
    const snapFailed = ss?.status === 'failed'
      || (!!d.snaps && !d.snaps.problem && (d.snaps.failures ?? []).length > 0);
    // A named account that was added but never signed in is dead weight the user
    // has to finish; a login IN FLIGHT is waiting on a pasted code.
    const pendingAcct = accountList().some((a) => a && a.id !== 'default' && a.state !== 'ready');
    dot('model', d.scope === 'session' && !!live() ? 'live' : null);
    dot('workspace', p?.pathMissing === true ? 'warn'
      : Array.isArray(d.procs) && d.procs.length ? 'live'
      : (d.git && d.git.repo && d.git.dirty > 0) ? 'warn' : null);
    dot('isolation', d.container && !d.container.problem && d.container.running ? 'live' : null);
    dot('snapshots', snapFailed ? 'warn' : null);
    dot('accounts', (d.acctLogin && !d.acctLogin.done) || pendingAcct ? 'warn' : null);
  }

  /**
   * FEAT-146 phase 2 — the pane renders ONE category now, so the reads that used
   * to happen merely because everything was on screen have to be asked for. Same
   * routes, same moment (modal open) as before the split; the rail DOTS are what
   * consume them, so a category the user has not visited can still say "there is
   * something running here" or "this needs you".
   */
  function prefetchForDots() {
    const p = project();
    ensureAccounts();
    if (!p) return;
    if (d.git === undefined) void refreshGit(p.id);
    if (d.procs === undefined) void refreshProcs(p.id);
    if (d.snaps === undefined) void refreshSnaps(p.id);
    if ((p.isolation ?? 'direct') === 'container' && d.container === undefined) void refreshContainer(p.id);
  }

  /**
   * Select a rail category. Deliberately does NOT rebuild the rail, so a
   * keyboard user can arrow through categories without losing focus.
   */
  function selectCat(id, opts = null) {
    const c = catOf(id);
    if (d.cat !== c.id) d.paneScroll.set(d.cat, node.body.scrollTop);
    d.cat = c.id;
    d.view = c.view;
    d.back = null;
    d.focus = opts?.focus ? { key: String(opts.focus), applied: false } : null;
    markRail();
    paint();
    if (!d.focus) node.body.scrollTop = d.paneScroll.get(c.id) ?? 0;
  }

  function onRailKey(e) {
    const items = railItems();
    const i = items.indexOf(e.target.closest('.srail-item'));
    if (i < 0) return;
    // Below 860px the rail is a horizontal strip, so the axis flips with it.
    const horizontal = window.matchMedia?.('(max-width: 860px)')?.matches === true;
    const prev = horizontal ? 'ArrowLeft' : 'ArrowUp';
    const next = horizontal ? 'ArrowRight' : 'ArrowDown';
    let j = -1;
    if (e.key === next) j = Math.min(items.length - 1, i + 1);       // crosses the group boundary
    else if (e.key === prev) j = Math.max(0, i - 1);
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = items.length - 1;
    else if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      // Only Enter/Space moves focus INTO the pane. Arrows browse.
      e.preventDefault();
      selectCat(items[i].dataset.cat);
      node.body.focus();
      return;
    } else return;
    e.preventDefault();
    selectCat(items[j].dataset.cat);
    items[j].focus();   // arrow navigation keeps focus in the rail
  }

  /* ─────────────────────── FEAT-146: paint ─────────────────────── */

  /** Baseline for "is this free-text field dirty?" — see closeGuard. Stamped
   *  after every paint, because every commit in this panel triggers one. */
  function stampBaselines() {
    for (const n of node.body.querySelectorAll('input[type="text"], input[type="search"], input:not([type]), textarea')) {
      if (n.readOnly || n.disabled) { delete n.dataset.base146; continue; }
      n.dataset.base146 = n.value;
    }
  }

  function paint() {
    if (d.view === 'editor') { paintChrome(); return; }
    const v = VIEWS[d.view] ?? VIEWS.settings;
    const host = node.views[v.el];
    // Hold the pane still across a rebuild. Async fetches (git, processes,
    // wiring…) repaint constantly, and a lens flip repaints too — none of them
    // is a navigation, so none of them may move the page under the reader.
    const keep = node.body.scrollTop;
    clear(host).append(v.build());
    for (const [k, n] of Object.entries(node.views)) n.classList.toggle('on', k === v.el);
    node.editor.classList.remove('on');
    node.body.scrollTop = keep;
    applyFocus(host);
    stampBaselines();
    paintChrome();
  }

  /** Header, lens, footer, rail dots — everything outside the pane body. */
  function paintChrome() {
    const c = catOf(d.cat);
    const machine = c.group === 'machine';
    const takeover = d.view === 'editor' ? (d.editing?.name ?? 'Template')
      : d.back ? (VIEWS[d.view]?.title ?? null) : null;
    node.title.textContent = takeover ?? c.label;
    node.eyebrow.textContent = d.view === 'editor' ? 'Template'
      : d.view === 'library' ? 'Shared across projects'
      : machine ? 'Every project on this machine'
      : (project()?.name ?? 'No project selected');
    node.back.hidden = !d.back && d.view !== 'editor';
    node.body.classList.toggle('editing', d.view === 'editor');

    /* The lens is a WRITE TARGET, not navigation: absent where there is
       nothing to write to. */
    node.scope.hidden = machine || d.view === 'editor';
    const sessionOk = !!project();
    for (const b of node.scope.querySelectorAll('[data-scope]')) {
      b.setAttribute('aria-pressed', b.dataset.scope === d.scope ? 'true' : 'false');
      if (b.dataset.scope === 'session') {
        b.disabled = !sessionOk;
        b.title = sessionOk ? '' : 'No project selected, so there is no session to override.';
      }
    }
    node.hint.textContent = machine ? 'Applies to every project on this machine'
      : !sessionOk ? 'No project selected — nothing to write to'
      : d.scope === 'project' ? 'Writing to this project · sessions inherit these'
      : 'Writing to this session only · the project default is untouched';
    // Round 4 — the live-state line is a note at the TOP OF THE PANE, not a
    // second footer string. It is a static child of the scroll host, so paint()
    // (which only clears the `.view` hosts) never rebuilds it.
    const liveText = liveStateText();
    node.liveLine.textContent = liveText;
    node.liveLine.hidden = !liveText || d.view === 'editor';
    node.hint.title = node.hint.textContent;
    node.whyAll?.setAttribute('aria-pressed', String(d.whyAll));
    paintRailDots();
  }

  async function ensureTemplates() {
    if (d.templates.length) return;
    try {
      d.templates = await api.listTemplates();
    } catch (err) {
      ctx.notify(`templates: ${err.message}`, true);
    }
  }

  /* ─────────── FEAT-146: the modal shell, focus trap and close guard ─────── */

  let isOpenNow = false;
  const isOpen = () => isOpenNow;

  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]),'
    + ' textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  /** Recomputed on EVERY keypress: paint() rebuilds the pane underneath, so a
   *  list captured at open time is stale by the second Tab. Visibility is
   *  checked properly (a collapsed <details>, a `hidden` header control, a
   *  `visibility:hidden` row) — an unfocusable member of this list is a hole in
   *  the trap, because Tab would skip it natively and land outside. */
  const canFocus = (n) => {
    if (n === document.activeElement) return true;
    if (typeof n.checkVisibility === 'function') return n.checkVisibility({ checkVisibilityCSS: true });
    return n.offsetParent !== null;
  };
  const focusables = () => [...node.modal.querySelectorAll(FOCUSABLE)].filter(canFocus);

  function onModalKey(e) {
    if (e.key === 'Tab') {
      const list = focusables();
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      const here = document.activeElement;
      if (e.shiftKey && (here === first || !node.modal.contains(here))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (here === last || !node.modal.contains(here))) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  function openModal() {
    if (isOpenNow) return;
    isOpenNow = true;
    d.returnFocus = document.activeElement;
    d.paneScroll.clear();
    node.modal.hidden = false;
    appRoot?.setAttribute('inert', '');
    node.modal.addEventListener('keydown', onModalKey);
    buildRail();
  }

  function closeModal() {
    if (!isOpenNow) return;
    isOpenNow = false;
    d.focus = null;
    node.modal.hidden = true;
    node.modal.removeEventListener('keydown', onModalKey);
    appRoot?.removeAttribute('inert');
    // Restore focus to whatever opened us; fall back to the cog when that node
    // was repainted away (rail rows and chips are rebuilt constantly).
    const back = d.returnFocus;
    d.returnFocus = null;
    const ok = back && back.isConnected && typeof back.focus === 'function';
    (ok ? back : $('#cogBtn'))?.focus?.();
  }

  /** The element whose loss a stray click/Esc would be unacceptable, or null. */
  function armedNode() {
    if (d.acctLogin && !d.acctLogin.done) return node.body.querySelector('#gAcctCancel') ?? node.body.querySelector('.acctlogin');
    const armed = node.body.querySelector('[data-armed="true"]');
    if (armed) return armed;
    for (const n of node.body.querySelectorAll('input, textarea')) {
      if (n.dataset.base146 !== undefined && n.value !== n.dataset.base146) return n;
    }
    return null;
  }

  function flashArmed(n) {
    n.scrollIntoView({ behavior: 'auto', block: 'center' });
    n.classList.add('focus-flash');
    setTimeout(() => n.classList.remove('focus-flash'), 1400);
  }

  /**
   * FEAT-146 phase 2b — Esc inside an expanded description collapses it and
   * puts focus back on its `ⓘ`. Returns true when it handled the key, so the
   * caller stops before the close ladder.
   */
  function collapseWhyAtFocus() {
    const here = document.activeElement;
    if (!here || !node.body.contains(here)) return false;
    const row = here.closest('.set');
    if (!row) return false;
    const btn = row.querySelector('button.why[data-why][aria-expanded="true"]');
    if (!btn) return false;
    toggleWhy(btn.dataset.why);
    return true;
  }

  /** Disarm the innermost armed ceremony. Returns true if one was disarmed. */
  function disarmOne() {
    if (d.acctConfirm) { d.acctConfirm = null; paint(); return true; }
    if (d.restore) { d.restore = null; paint(); return true; }
    if (d.confirmDelete) { d.confirmDelete = null; paint(); return true; }
    if (d.memConfirm) { d.memConfirm = null; paint(); return true; }
    if (d.procConfirm) { d.procConfirm = null; paint(); return true; }
    if (d.gitArm) { d.gitArm = null; paint(); return true; }
    if (d.wiringArm) { d.wiringArm = null; paint(); return true; }
    if (d.repoint?.arm) { d.repoint.arm = null; paint(); return true; }
    return false;
  }

  /**
   * Esc: innermost first — an armed ceremony DISARMS and the modal stays open;
   * a second Esc closes. Never closes during a live sign-in, and never while a
   * free-text field holds an uncommitted edit: losing a half-finished login to
   * a stray keypress is not an acceptable cost for a convenience shortcut.
   */
  function escape() {
    if (d.acctLogin && !d.acctLogin.done) {
      const n = armedNode();
      if (n) flashArmed(n);
      return;
    }
    // FEAT-146 phase 2b — an open `.set-why` is the innermost thing Esc can
    // close, but ONLY when the focus is actually inside its row: Esc anywhere
    // else in the modal must still reach the ceremony ladder below. Collapsing
    // returns focus to the `ⓘ` that opened it and never closes the modal.
    if (collapseWhyAtFocus()) return;
    if (disarmOne()) return;
    const n = armedNode();          // a dirty free-text field
    if (n) { flashArmed(n); return; }
    closeModal();
  }

  /** Backdrop click: same refusals, but it does NOT disarm — a click that lands
   *  outside is far likelier to be a slip than an intent to abandon. */
  function backdropClose() {
    const n = armedNode();
    if (n) { flashArmed(n); return; }
    closeModal();
  }

  async function open(view, from = null, opts = null) {
    // FEAT-054: `open('settings', {focus:'git'})` — the second arg may be the
    // options object (the ticket's own signature); a string stays `from`.
    if (from && typeof from === 'object') { opts = from; from = opts.from ?? null; }
    if (view !== d.view) { d.restore = null; d.confirmDelete = null; }
    /* Always refetch on open. A cached list is fine for a container's state,
       but not here: the signal that matters most is a session-start snapshot
       that FAILED, and showing a stale list would report protection the
       project no longer has. */
    d.snaps = undefined;
    /* Wiring is a live true-source read (registry + files on disk); re-read on
       every open so a change made outside the UI is reflected. */
    d.wiring = undefined;
    d.wiringArm = null;
    d.wiringReport = null;
    d.repoint = null; // BUG-138: a repoint panel is per-visit; never reopen armed

    /* FEAT-146 — resolve the CATEGORY first, then the view.
       `{scope:'machine'}` was the sidebar-foot door into the machine panel;
       machine is a rail group now, so it maps to the Accounts category. */
    const machineAsked = opts?.scope === 'machine' || view === 'globals';
    if (opts?.scope === 'project' || opts?.scope === 'session') d.scope = opts.scope;
    const focusKey = opts?.focus ? String(opts.focus) : null;
    let cat = machineAsked ? 'accounts'
      : focusKey ? (FOCUS_CATEGORY[focusKey] ?? null)
      : null;

    openModal();
    await ensureTemplates();

    if (view === 'settings' || view === 'globals' || !VIEWS[view]) {
      d.cat = cat ?? (catOf(d.cat).group === 'machine' && !machineAsked ? 'model' : d.cat);
      if (machineAsked) d.cat = 'accounts';
      d.view = catOf(d.cat).view;
      d.back = null;
    } else {
      // A named sub-application (instructions / library / snapshots / memories).
      // Keep it a takeover when an opener said where it came FROM; otherwise
      // land on its own rail category if it has one.
      const own = RAIL.find((c) => c.view === view);
      if (from) { d.view = view; d.back = from; }
      else if (own) { d.cat = own.id; d.view = view; d.back = null; }
      else { d.view = view; d.back = 'settings'; }
      if (cat) d.cat = cat;
    }
    // A focus is per-open: a plain open (cog button) clears any previous one
    // and lands at the default position — no sticky deep-link.
    d.focus = focusKey ? { key: focusKey, applied: false } : null;
    markRail();
    prefetchForDots();
    paint();
    if (!d.focus) node.body.scrollTop = 0;
    // Focus lands on the selected rail item, never on the first control in the
    // pane — a settings modal that opens with a cycle button focused invites an
    // accidental Space. preventScroll, then an explicit `nearest`: a plain
    // focus() in the narrow HORIZONTAL rail scrolls the item flush to the left
    // edge and takes its group heading off screen with it, which is the one
    // piece of structure that strip has.
    const seat = node.rail.querySelector(`.srail-item[data-cat="${d.cat}"]`);
    if (seat) {
      seat.focus({ preventScroll: true });
      // preventScroll, then an explicit reveal: a plain focus() in the narrow
      // horizontal rail scrolls the item flush to the scrollport start.
      revealSelectedCat();
    } else node.body.focus();
  }

  node.back.addEventListener('click', () => {
    const to = d.back || catOf(d.cat).view;
    d.back = to === 'library' ? 'instructions' : null;
    d.view = to;
    node.editor.classList.remove('on');
    paint();
  });
  /* The two events that can change which ends of the strip have more behind
     them. Registered ONCE on the persistent nodes (never inside buildRail,
     which runs on every open), and passive — this handler only reads. */
  node.rail.addEventListener('scroll', () => updateRailEdges(), { passive: true });
  window.addEventListener('resize', () => { if (isOpenNow) updateRailEdges(); }, { passive: true });
  node.close.addEventListener('click', () => closeModal());
  node.whyAll?.addEventListener('click', () => setWhyAll(!d.whyAll));
  node.back0.addEventListener('click', () => backdropClose());
  node.scope.addEventListener('click', (e) => {
    const b = e.target.closest('[data-scope]');
    if (!b || b.disabled) return;
    d.scope = b.dataset.scope;
    // Lens only: the rail is NOT rebuilt and the pane is NOT scrolled. paint()
    // restores scrollTop byte-for-byte across the rebuild.
    paint();
  });

  return {
    open,
    close: () => escape(),
    isOpen,
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
      if (isOpenNow) paint();
    },
    /** The live session reported what it is actually running with — redraw. */
    repaintLive: () => { if (isOpenNow && d.view === 'settings') paint(); },
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
