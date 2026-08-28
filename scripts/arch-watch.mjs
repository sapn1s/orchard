#!/usr/bin/env node
/**
 * arch-watch.mjs — FEAT-056: the recurrence detector of the architecture-review loop.
 *
 * WHY THIS EXISTS
 * A ticket board optimises for CLOSING tickets. Every agent is scoped to one
 * ticket, so every fix is local by construction, and nothing in the loop ever
 * asks "should this subsystem exist in this shape at all?". WA §N already says a
 * symptom fixed 2–3× means the design is wrong — but it only fires when a human
 * HAPPENS to remember the pattern. Memory does not survive compaction, session
 * boundaries, or a different project. This script is the mechanical half: it
 * re-derives the pattern from the board itself, every pass, forever.
 *
 * WHAT IT IS NOT
 * - No LLM. Pure computation over ticket files (+ git as corroboration only).
 * - It NEVER refactors, never edits a ticket, never files an ARCH ticket. It
 *   RAISES a question ("this subsystem has been patched N times — is the design
 *   wrong?") as a needs-human finding. A human/orchestrator decides; if they
 *   decide to redesign, the resulting work lives in an ARCH-### ticket
 *   (docs/bugs/TEMPLATE-ARCH.md). See docs/ARCHITECTURE-REVIEW.md.
 *
 * ── THE SIGNAL (and why this one) ──────────────────────────────────────────
 * Clustering is on each ticket's DECLARED text: the `- **Area:**` line plus the
 * H1 title, tokenised, with tokens that are too rare (< 2 tickets) or too common
 * (> MAX_DF_FRAC of the board) discarded — a token present in a third of all
 * tickets ("server", "ui", "session") carries no subsystem information, and the
 * document-frequency band drops those mechanically instead of by a hand-tuned
 * blocklist. Plus one narrow curated edge: ticket ids CITED IN THE AREA LINE
 * ("(BUG-020 sibling)", "(BUG-030/BUG-033 family)") are a human explicitly
 * declaring subsystem kinship, and count as a similarity bonus — that edge is
 * what catches the one lexical outlier of the real agent-strip cluster.
 *
 * Tickets are then partitioned by AVERAGE-LINK agglomerative clustering over
 * that similarity (Jaccard of salient tokens + kinship bonus), merging while the
 * best pair is above `--similarity`. Two rejected alternatives, both measured on
 * this repo's real board: one-cluster-per-shared-token produced 91 overlapping
 * "clusters" (every ticket in a dozen of them — pure noise); SINGLE-link
 * chaining collapsed half the board into one 19-ticket blob with no coherent
 * label. Average-link gives a partition — each ticket in exactly one subsystem,
 * a bounded number of clusters, and no subset explosion.
 *
 * Git-touched files were the ticket's first suggestion; measured on this repo
 * they are NOT reliably derivable as the primary key, so they are used only as
 * corroborating EVIDENCE:
 *   - ticket→commit attribution is by `git log --grep=<ID>`, and board/triage
 *     commits routinely name 3–8 ids at once, so files bleed between unrelated
 *     tickets (BUG-030's grep-derived file list is dominated by FEAT-037's
 *     codex-runtime files, from one shared commit);
 *   - hub files destroy the partition: public/app.js is touched by ~30 of 83
 *     tickets, so a file-keyed cluster is one giant meaningless blob — the exact
 *     "do not become noise" failure the ticket forbids;
 *   - open tickets and never-committed work have no commits at all (BUG-034, the
 *     6th member of the class this must find, has zero code commits).
 * The Area line, by contrast, is present in 81/83 tickets, is written per ticket
 * by the filer, and is the ticket format's own declaration of subsystem.
 *
 * Files are still computed (best-effort, failure-tolerant) and reported as
 * "shared files" evidence when ≥2 members of a cluster touched the same file —
 * corroboration a human can check in seconds, without letting an unreliable
 * signal drive the partition.
 *
 * ── THRESHOLDS (configurable) ──────────────────────────────────────────────
 *   --min-tickets=N     (default 3)  a cluster is flagged at N CLOSED tickets
 *   --window-days=N     (default 30) recency window
 *   --min-in-window=N   (default 2)  …or N closed tickets inside that window
 *   --max-df=F          (default 0.25) token document-frequency ceiling
 *   --similarity=F      (default 0.16) average-link merge threshold
 *   --max-findings=N    (default 5)  cap on findings put on the rail (the CLI
 *                                    always reports every flagged cluster)
 *   --stopwords=a,b     extra per-project stopword seeds (BUG-093)
 *   --no-project-stopwords          disable the derived product-name seed
 * Env equivalents: ARCH_MIN_TICKETS, ARCH_WINDOW_DAYS, ARCH_MIN_IN_WINDOW,
 * ARCH_MAX_DF, ARCH_SIMILARITY, ARCH_MAX_FINDINGS, ARCH_STOPWORDS,
 * ARCH_NO_PROJECT_STOPWORDS.
 *
 * ── OUTPUT ─────────────────────────────────────────────────────────────────
 *   node scripts/arch-watch.mjs [--dir=docs/bugs]            human-readable report
 *   node scripts/arch-watch.mjs --json                       machine-readable
 *   node scripts/arch-watch.mjs --persist                    write findings for the
 *                                                            project's Needs-You rail
 * Findings persist to <dir>/.arch/findings.json (per PROJECT — a cluster found in
 * project B belongs on project B's rail, not on claude-station's). Dismissals are
 * acked in <dir>/.arch/acks.json by the server; the finding id is a hash of the
 * cluster label + its MEMBER SET, so a dismissal holds while the cluster is
 * unchanged and re-raises the moment a NEW ticket joins it.
 *
 * Exit codes: 0 = no cluster over threshold, 1 = ≥1 flagged cluster, 2 = usage/IO
 * error. Nothing here ever throws out of `archWatch()` on a malformed board — a
 * detector that breaks the consolidation pass or server boot would be worse than
 * a detector that finds nothing (FEAT-019 failure-tolerance contract).
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
// ONE definition of the ticket format (plan §3 / §8 step 2). arch-watch used to
// carry its own `isDone` — VERIFIED or a DONE token — which had drifted from
// board.mjs's and disagreed with it on 12 real tickets (every FIXED / RE-FIXED /
// RESOLVED one). It now asks ticket-schema.mjs, like everything else does.
import {
  parseTicket,
  TICKET_FILE_RE,
  TICKET_ID_IN_TEXT_RE as ID_IN_TEXT_RE,
} from './lib/ticket-schema.mjs';
// FEAT-106 — default board dir resolved (docs/bugs legacy / .orchard/bugs flat)
// rather than hard-coded; an explicit --dir still wins. Copied sibling import.
import { resolveBoardDir } from './lib/board-path.mjs';

export const DEFAULTS = {
  minTickets: 3,
  windowDays: 30,
  minInWindow: 2,
  maxDf: 0.25,
  similarity: 0.16,
  maxFindings: 5,
  /** A declared "(BUG-020 sibling)" in the Area line is worth this much similarity. */
  kinBonus: 0.3,
};

/**
 * BUG-093 — the PRODUCT NAME is not a subsystem.
 *
 * The document-frequency ceiling drops hub words mechanically, but it cannot
 * drop the product name: on a ~142-ticket board `claude`+`station` appeared in
 * ~12 Area lines (≈8%), far under `maxDf` 0.25, so it survived as a "salient"
 * token and average-link happily glued together every ticket whose filer had
 * written the product's name into a generically-worded `- **Area:**` line. The
 * result was a 12-ticket `[claude+station]` pseudo-cluster with NO shared files,
 * unrelated fixes (a CSS line, a model write-path, a branding SVG, methodology
 * docs) and no re-patch cadence — a lexical catch-all, the exact "do not become
 * noise" failure FEAT-056 forbids.
 *
 * Why a stopword seed and NOT a tighter maxDf: the product name is a CONSTANT of
 * the board, not a frequent word — it can appear in 3 tickets or 40 and it still
 * carries zero subsystem information, so no frequency band is the right tool.
 * Tightening `maxDf` enough to catch it (≈0.05 here) would also gag genuine
 * subsystem vocabulary ("agent", "session") that legitimately spans 10–20
 * tickets, and does nothing at all below SMALL_BOARD where the ceiling is off by
 * design. A seed is exact, costs one derivation, and is self-configuring per
 * project — arch-watch is copied verbatim into other repos by fleet-sync, so the
 * seed is DERIVED (repo dir name + package.json name), never hardcoded.
 *
 * Escape hatches: `--stopwords=a,b` / ARCH_STOPWORDS add more (a service's
 * marketing name, an org prefix); `--no-project-stopwords` turns the derivation
 * off (used by the verifier to prove, must-FAIL style, that the catch-all DOES
 * form without this fix).
 */
function deriveProjectStopwords(dir, { extra = [], enabled = true } = {}) {
  const seeds = [];
  if (enabled) {
    try {
      const repoRoot = path.resolve(dir, '..', '..');
      seeds.push(path.basename(repoRoot));
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
        if (typeof pkg?.name === 'string') seeds.push(pkg.name.replace(/^@/, '').replace('/', '-'));
      } catch {
        /* no package.json — the dir name alone is a fine seed */
      }
    } catch {
      /* un-resolvable path: no seed, detector unchanged */
    }
  }
  seeds.push(...(Array.isArray(extra) ? extra : String(extra || '').split(',')));
  const out = new Set();
  for (const seed of seeds) {
    for (const raw of String(seed || '').toLowerCase().split(/[^a-z0-9]+/)) {
      if (raw.length < 3 || /^\d+$/.test(raw)) continue;
      out.add(raw);
      out.add(stem(raw));
    }
  }
  return out;
}

/** Plain English stopwords only — subsystem vocabulary is filtered by document frequency, not by hand. */
const STOP = new Set(
  ('a an the and or but if then else for to of in on at by with without into onto from as is are was were be been ' +
    'it its this that these those not no do does did done doing so than when where which who whom whose while ' +
    'you your we our they their them he she his her i me my will would can could should shall may might must ' +
    'one two three more most less least each every any all some such only just very own here there over under up ' +
    'down out off about above below between per via still yet also too rather instead vs versus after before ' +
    'again never always new old first last next').split(/\s+/),
);

/** Crude, deterministic suffix stemmer: liveness→live, agents→agent, rendering→render. */
function stem(w) {
  for (const suf of ['ness', 'ings', 'ing', 'ers', 'ies', 'ed', 'es', 's']) {
    if (w.length > suf.length + 2 && w.endsWith(suf)) {
      let base = w.slice(0, -suf.length);
      if (suf === 'ies') base += 'y';
      return base;
    }
  }
  return w;
}

const NO_EXTRA_STOP = new Set();

function tokenize(text, extraStop = NO_EXTRA_STOP) {
  const out = new Set();
  for (const raw of String(text || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (STOP.has(raw) || extraStop.has(raw)) continue;
    if (/^\d+$/.test(raw)) continue;
    const t = stem(raw);
    if (t.length < 3 || STOP.has(t) || extraStop.has(t)) continue;
    out.add(t);
  }
  return out;
}


/**
 * Read every ticket in a board dir. Never throws: an unreadable/malformed ticket
 * is skipped, a missing dir yields an empty list (opt-in board contract).
 */
export function readTicketsForArch(dir, extraStop = NO_EXTRA_STOP) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => TICKET_FILE_RE.test(f));
  } catch {
    return [];
  }
  const tickets = [];
  for (const file of names) {
    const id = file.match(TICKET_FILE_RE).slice(1, 3).join('-');
    let text;
    try {
      text = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch {
      continue;
    }
    // BOTH formats, read by the shared parser (BUG-122): `mode: 'auto'` takes a
    // promoted ticket's fields off its leading ```orchard-ticket record and an
    // unpromoted one off its prose header, and `.summary` is the one-shape view
    // (for a legacy file, the identical object `.record` used to be).
    // arch-watch stays TOLERANT of a malformed ticket — it must never throw
    // (FEAT-019 failure-tolerance) — but TOLERANT IS NOT SILENT. It used to
    // take `.record` and drop the parser's errors, so a ticket whose state the
    // schema cannot interpret came back here as an ordinary open ticket
    // (`done: false`) with no classification field and no error channel, while
    // board:check exited 1 on the very same file. `statusMatched`/`statusError`
    // ride on the record precisely so this call site cannot drop them, and
    // archWatch() below reports them as `unclassified`.
    const t = parseTicket(text, { file, mode: 'auto' }).summary;
    const title = t.title ?? '';
    const area = t.area;
    const statusRaw = t.statusRaw;
    const reported = t.reported;
    // Kinship: ticket ids cited IN THE AREA LINE only (a deliberate, narrow
    // signal — "(BUG-020 sibling)"). Body-wide id mentions are far too dense to
    // mean "same subsystem".
    const kin = [...new Set(area.match(ID_IN_TEXT_RE) ?? [])].filter((k) => k !== id);
    tickets.push({
      id,
      file,
      title,
      area,
      statusRaw,
      done: t.done,
      // `done: false` here means "not in the Done set", the SAME thing it means
      // to board.mjs and to the ticket API — it is a placement, not a claim
      // that the state was understood. `statusMatched` is what says whether it
      // was understood, and it must be read before `done` is trusted.
      workState: t.work_state,
      statusMatched: t.statusMatched,
      statusError: t.statusError,
      // The warning channel gets the same treatment the error channel got, for
      // the same reason: a report that only one of three consumers carries is a
      // report that reaches nobody on the other two. See board.mjs's note.
      statusWarning: t.statusWarning,
      statusWarnings: t.statusWarnings,
      reported,
      kin,
      tokens: tokenize(`${title} ${area}`, extraStop),
    });
  }
  tickets.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return tickets;
}

/**
 * Best-effort git corroboration: which non-doc files each ticket's commits
 * touched. Commits naming >2 ticket ids are board/triage commits and are
 * skipped (their file lists belong to no single ticket). Any git failure →
 * empty map; this is evidence, never the partition.
 */
function filesByTicket(repoRoot, ids) {
  const map = new Map();
  const git = (args) =>
    execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    git(['rev-parse', '--is-inside-work-tree']);
  } catch {
    return map;
  }
  for (const id of ids) {
    const files = new Set();
    try {
      const shas = git(['log', '--all', '--format=%H', `--grep=${id}`]).trim().split('\n').filter(Boolean);
      for (const sha of shas.slice(0, 40)) {
        const subject = git(['show', '-s', '--format=%s', sha]).trim();
        const named = new Set(subject.match(ID_IN_TEXT_RE) ?? []);
        if (named.size > 2) continue; // board/triage commit — attribution is meaningless
        for (const f of git(['show', '--name-only', '--format=', sha]).trim().split('\n')) {
          if (!f) continue;
          if (f.startsWith('docs/') || f === 'package.json' || f === 'package-lock.json') continue;
          files.add(f);
        }
      }
    } catch {
      /* one ticket's history is unreadable — the rest still counts */
    }
    map.set(id, files);
  }
  return map;
}

function daysBetween(a, b) {
  return Math.abs(a - b) / 86400000;
}

/**
 * The detector. Returns { tickets, clusters, flagged, config } and NEVER throws.
 * A cluster is `{ label, tokens, members, closed, open, flagged, reasons, files }`.
 */
export function archWatch(dir, opts = {}) {
  const cfg = {
    minTickets: Number(opts.minTickets ?? process.env.ARCH_MIN_TICKETS ?? DEFAULTS.minTickets),
    windowDays: Number(opts.windowDays ?? process.env.ARCH_WINDOW_DAYS ?? DEFAULTS.windowDays),
    minInWindow: Number(opts.minInWindow ?? process.env.ARCH_MIN_IN_WINDOW ?? DEFAULTS.minInWindow),
    maxDf: Number(opts.maxDf ?? process.env.ARCH_MAX_DF ?? DEFAULTS.maxDf),
    similarity: Number(opts.similarity ?? process.env.ARCH_SIMILARITY ?? DEFAULTS.similarity),
    maxFindings: Number(opts.maxFindings ?? process.env.ARCH_MAX_FINDINGS ?? DEFAULTS.maxFindings),
  };
  // BUG-093: the product name is a constant of the board, never a subsystem.
  const projectStop = deriveProjectStopwords(dir, {
    extra: opts.stopwords ?? process.env.ARCH_STOPWORDS ?? [],
    enabled: opts.projectStopwords ?? (process.env.ARCH_NO_PROJECT_STOPWORDS ? false : true),
  });
  cfg.stopwords = [...projectStop].sort();
  const tickets = readTicketsForArch(dir, projectStop);
  const byId = new Map(tickets.map((t) => [t.id, t]));
  /**
   * THE ERROR CHANNEL THIS DETECTOR DID NOT HAVE.
   *
   * arch-watch has no exit code to spend — 0/1 already mean "no cluster / a
   * cluster over threshold", and overloading that would make a malformed
   * status look like a recurrence finding to every caller — and it may not
   * throw. So an uninterpretable state is a REPORTED ENTRY the caller must
   * handle: `result.unclassified` (also in `--json`), plus a stderr line from
   * the CLI that `--quiet` does NOT suppress, because a board defect is not
   * report output. What it is never again is `done: false` with no comment.
   */
  const unclassified = tickets
    .filter((t) => t.statusMatched === false)
    .map((t) => ({ id: t.id, file: t.file, statusRaw: t.statusRaw, reason: t.statusError }));
  /**
   * THE ADVISORY CHANNEL, WHICH DID NOT EXIST HERE AT ALL.
   *
   * `unclassified` reports states that may not be answered about. A state that
   * IS answerable but whose declaration is untidy — duplicated-in-agreement, a
   * status-like line that agrees, a `DONE` token doing the classifying — was
   * computed by the shared parser, carried on the record, and then dropped on
   * the floor by this function, which exposed no field for it. Same shape as
   * `unclassified`, same `--json`, same stderr; a WARN prefix instead of a
   * defect sentence, and still no effect on the exit code.
   */
  const statusWarnings = tickets
    .filter((t) => (t.statusWarnings?.length ?? 0) > 0)
    .map((t) => ({ id: t.id, file: t.file, statusRaw: t.statusRaw, warnings: t.statusWarnings.slice() }));
  const result = { dir, config: cfg, ticketCount: tickets.length, unclassified, statusWarnings, clusters: [], flagged: [] };
  if (tickets.length === 0) return result;

  // --- document frequency band -------------------------------------------
  const df = new Map();
  for (const t of tickets) for (const tok of t.tokens) df.set(tok, (df.get(tok) ?? 0) + 1);
  // The document-frequency CEILING exists to drop hub words ("server", "ui")
  // that carry no subsystem information on a big board. On a SMALL board it
  // cannot do that job — a word in 4 of 5 tickets is just as likely to BE the
  // class as to be a hub word — and applying it there gags the very vocabulary
  // a 3-ticket cluster is made of. So below SMALL_BOARD the ceiling is off; the
  // min-df ≥ 2 rule still drops one-off vocabulary.
  const SMALL_BOARD = 20;
  const dfCeil =
    tickets.length < SMALL_BOARD ? tickets.length : Math.max(3, Math.floor(tickets.length * cfg.maxDf));
  const salient = new Set(
    [...df.entries()].filter(([, n]) => n >= 2 && n <= dfCeil).map(([tok]) => tok),
  );
  for (const t of tickets) t.salient = new Set([...t.tokens].filter((x) => salient.has(x)));

  // --- pairwise similarity -------------------------------------------------
  const jac = (a, b) => {
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    const union = a.size + b.size - inter;
    return union ? inter / union : 0;
  };
  const sim = (a, b) => {
    let s = jac(a.salient, b.salient);
    if (a.kin.includes(b.id) || b.kin.includes(a.id)) s += DEFAULTS.kinBonus;
    return s;
  };

  // --- average-link agglomerative clustering -------------------------------
  let groups = tickets.map((t) => [t]);
  const linkage = (A, B) => {
    let s = 0;
    for (const a of A) for (const b of B) s += sim(a, b);
    return s / (A.length * B.length);
  };
  for (;;) {
    let best = null;
    let bestScore = cfg.similarity;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const s = linkage(groups[i], groups[j]);
        if (s > bestScore) { bestScore = s; best = [i, j]; }
      }
    }
    if (!best) break;
    const [i, j] = best;
    groups[i] = [...groups[i], ...groups[j]];
    groups.splice(j, 1);
  }
  const candidates = groups
    .filter((g) => g.length >= 2)
    .map((g) => {
      // Label = the salient tokens shared by at least half the members.
      const count = new Map();
      for (const t of g) for (const tok of t.salient) count.set(tok, (count.get(tok) ?? 0) + 1);
      const tokens = [...count.entries()]
        .filter(([, n]) => n >= Math.max(2, Math.ceil(g.length / 2)))
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, 3)
        .map(([tok]) => tok);
      return { tokens, members: new Set(g.map((t) => t.id)), group: g };
    });

  // --- score + threshold ---------------------------------------------------
  const repoRoot = path.resolve(dir, '..', '..');
  const flaggedIds = new Set();
  const scored = candidates.map((c) => {
    const members = [...c.members].sort();
    // THREE-WAY, not two. A member whose state did not classify is in NEITHER
    // half: counting it as open would understate `closed` (and so silently
    // weaken the recurrence threshold this detector exists to apply), and
    // counting it as closed would invent a fix that may not exist. It is
    // listed as unclassified so the reader sees the cluster is incomplete.
    const known = members.filter((id) => byId.get(id)?.statusMatched !== false);
    const unknown = members.filter((id) => byId.get(id)?.statusMatched === false);
    const closed = known.filter((id) => byId.get(id)?.done);
    const open = known.filter((id) => !byId.get(id)?.done);
    const dates = closed
      .map((id) => byId.get(id)?.reported)
      .filter(Boolean)
      .map((d) => Date.parse(`${d}T00:00:00Z`))
      .filter((n) => !Number.isNaN(n))
      .sort((a, b) => a - b);
    let inWindow = 0;
    for (let i = 0; i < dates.length; i++) {
      let n = 1;
      for (let j = i + 1; j < dates.length; j++) if (daysBetween(dates[i], dates[j]) <= cfg.windowDays) n++;
      inWindow = Math.max(inWindow, n);
    }
    const reasons = [];
    if (closed.length >= cfg.minTickets) reasons.push(`${closed.length} closed tickets in this cluster (≥ ${cfg.minTickets})`);
    if (inWindow >= cfg.minInWindow && closed.length >= cfg.minInWindow) {
      reasons.push(`${inWindow} of them filed within ${cfg.windowDays} days of each other (≥ ${cfg.minInWindow})`);
    }
    const label = (c.tokens.length ? c.tokens : ['unlabelled']).join('+');
    return {
      label, tokens: c.tokens.slice(), members, closed, open, unclassified: unknown, inWindow, reasons,
      flagged: reasons.length > 0, group: c.group,
    };
  });

  // --- adjacency ------------------------------------------------------------
  // A partition draws a hard line where the data has a gradient: two clusters
  // just under the merge threshold are very often ONE design class caught at two
  // moments (on this repo, the reload-summary cluster and the agent-strip
  // liveness cluster are exactly that). Reporting the nearest neighbour keeps the
  // partition honest without letting single-link chaining blob the whole board.
  for (const c of scored) {
    let nearest = null;
    for (const o of scored) {
      if (o === c) continue;
      const s = linkage(c.group, o.group);
      if (!nearest || s > nearest.score) nearest = { label: o.label, members: o.members, score: Number(s.toFixed(3)) };
    }
    c.nearest = nearest && nearest.score >= cfg.similarity * 0.6 ? nearest : null;
  }
  for (const c of scored) delete c.group;
  scored.sort(
    (a, b) => b.closed.length - a.closed.length || b.members.length - a.members.length || (a.label < b.label ? -1 : 1),
  );
  result.clusters = scored;
  for (const c of scored) if (c.flagged) for (const id of c.members) flaggedIds.add(id);

  // --- git corroboration, for FLAGGED clusters only (cheap + evidence-only) -
  let fileMap = new Map();
  try {
    fileMap = filesByTicket(repoRoot, [...flaggedIds]);
  } catch {
    fileMap = new Map();
  }
  for (const c of scored) {
    const counts = new Map();
    for (const id of c.members) for (const f of fileMap.get(id) ?? []) counts.set(f, (counts.get(f) ?? 0) + 1);
    c.files = [...counts.entries()]
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 5)
      .map(([f, n]) => `${f} (${n} tickets)`);
  }

  result.flagged = scored.filter((c) => c.flagged);
  return result;
}

/**
 * Flagged clusters as needs-human findings, shaped exactly like the FEAT-047
 * findings the Needs-You rail already renders ({id,type,summary,date}).
 * The id hashes the label + member set: dismissal holds while the cluster is
 * unchanged, and a NEW ticket joining re-raises it. Never throws.
 */
export function archFindings(dir, opts = {}) {
  let res;
  try {
    res = archWatch(dir, opts);
  } catch {
    return [];
  }
  // The rail gets the STRONGEST clusters only (sorted by closed-ticket count);
  // the CLI report always lists every flagged cluster. A rail with 20 standing
  // findings is the "do not become noise" failure the ticket forbids.
  return res.flagged.slice(0, Math.max(1, res.config.maxFindings)).map((c) => {
    const evidence =
      `${c.members.length} tickets (${c.closed.length} closed${c.open.length ? `, ${c.open.length} open` : ''}) ` +
      `in the "${c.label}" subsystem: ${c.members.join(', ')}` +
      (c.files.length ? ` — shared files: ${c.files.join(', ')}` : '') +
      (c.nearest ? ` — adjacent cluster [${c.nearest.label}]: ${c.nearest.members.join(', ')}` : '') +
      ` — ${c.reasons.join('; ')}`;
    const id = `arch-recurrence-${crypto
      .createHash('sha1')
      .update(`${c.label}|${c.members.join(',')}`)
      .digest('hex')
      .slice(0, 8)}`;
    return {
      id,
      type: 'arch-recurrence',
      where: `${c.label} (declared Area/title cluster)`,
      evidence,
      why:
        'WA §N: a symptom fixed 2–3× means the DESIGN is wrong. Decide: redesign the subsystem ' +
        '(open an ARCH-### ticket from docs/bugs/TEMPLATE-ARCH.md — invariant, options, migration, ' +
        'proof bar) or state explicitly why another local patch is right. Never auto-refactored.',
      summary: `recurring patches in "${c.label}" — ${evidence}`.slice(0, 280),
    };
  });
}

/** findings.json / acks.json live under the board dir, per project. */
export function archFindingsFile(dir) {
  return path.join(dir, '.arch', 'findings.json');
}

/**
 * Persist findings for the project's Needs-You rail. Overwrites (a cluster that
 * stops crossing the threshold disappears) but carries each finding's `date`
 * forward, so a dismissal stays effective while the finding merely persists —
 * the same contract as FEAT-047's needs-human.json. Never throws.
 */
export function persistArchFindings(dir, findings) {
  const file = archFindingsFile(dir);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Derived state, never committed: a self-ignoring dir keeps it out of git
    // without editing the project's .gitignore.
    const ignore = path.join(path.dirname(file), '.gitignore');
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
    const prevDates = new Map();
    try {
      const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const f of prev.findings ?? []) if (f?.id && f?.date) prevDates.set(f.id, f.date);
    } catch {
      /* first pass */
    }
    const now = new Date().toISOString();
    fs.writeFileSync(
      file,
      `${JSON.stringify(
        {
          generatedAt: now,
          source: 'arch-watch',
          findings: findings.map((f) => ({
            id: f.id,
            type: f.type,
            summary: f.summary,
            date: prevDates.get(f.id) ?? now,
          })),
        },
        null,
        2,
      )}\n`,
    );
    return file;
  } catch {
    return null; // persistence failure never breaks a pass
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Unrecognised arguments are rejected, not ignored — `arch-watch.mjs <dir>`
 * used to scan `docs/bugs` and report confidently about a board the caller
 * never named. Same principle as an unmappable status: no confident wrong
 * answer. (Exit 2 = usage error, already this script's documented code.)
 */
function parseArgs(argv) {
  const out = { dir: null, json: false, persist: false, quiet: false, unknown: [], opts: {} };
  for (const a of argv) {
    let m;
    if ((m = /^--dir=(.*)$/.exec(a))) out.dir = m[1];
    else if ((m = /^--min-tickets=(\d+)$/.exec(a))) out.opts.minTickets = Number(m[1]);
    else if ((m = /^--window-days=(\d+)$/.exec(a))) out.opts.windowDays = Number(m[1]);
    else if ((m = /^--min-in-window=(\d+)$/.exec(a))) out.opts.minInWindow = Number(m[1]);
    else if ((m = /^--max-df=([\d.]+)$/.exec(a))) out.opts.maxDf = Number(m[1]);
    else if ((m = /^--similarity=([\d.]+)$/.exec(a))) out.opts.similarity = Number(m[1]);
    else if ((m = /^--max-findings=(\d+)$/.exec(a))) out.opts.maxFindings = Number(m[1]);
    else if ((m = /^--stopwords=(.*)$/.exec(a))) out.opts.stopwords = m[1].split(',');
    else if (a === '--no-project-stopwords') out.opts.projectStopwords = false;
    else if (a === '--json') out.json = true;
    else if (a === '--persist') out.persist = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--all') out.all = true;
    else out.unknown.push(a);
  }
  return out;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.unknown.length) {
    console.error(`arch-watch.mjs: unrecognised argument(s): ${a.unknown.join(' ')}`);
    console.error('usage: node scripts/arch-watch.mjs [--dir=<board>] [--json] [--quiet] [--all] [--persist]  (default --dir resolves docs/bugs or .orchard/bugs)');
    process.exit(2);
  }
  const dir = a.dir === null ? resolveBoardDir(process.cwd()) : path.resolve(a.dir);
  const res = archWatch(dir, a.opts);
  const findings = archFindings(dir, a.opts);
  if (a.persist) persistArchFindings(dir, findings);

  // A board defect is not report output: it goes to stderr on EVERY invocation,
  // including --quiet and --json (whose stdout must stay parseable). The exit
  // code is deliberately unchanged — see archWatch()'s note.
  for (const u of res.unclassified) {
    process.stderr.write(
      `arch-watch — ${u.reason ?? `UNMAPPABLE STATUS: ${u.file}`}\n` +
      `  ${u.id}: this ticket is counted in NEITHER the closed nor the open half of its cluster. ` +
      `Fix the ticket's \`- **Status:**\` line (\`npm run board:check\` names it too).\n`,
    );
  }
  // Advisory, same channel and same never-suppressed rule, but plainly marked
  // as not-a-defect so a caller can tell the two apart without parsing prose.
  for (const w of res.statusWarnings ?? []) {
    for (const line of w.warnings) process.stderr.write(`arch-watch WARN — ${line}\n`);
  }

  if (a.json) {
    console.log(JSON.stringify({ ...res, findings }, null, 2));
  } else if (!a.quiet) {
    console.log(
      `arch-watch — ${res.ticketCount} ticket(s) in ${dir}; thresholds: ≥${res.config.minTickets} closed ` +
        `per subsystem, or ≥${res.config.minInWindow} within ${res.config.windowDays}d (max-df ${res.config.maxDf})` +
        (res.config.stopwords?.length ? `; project stopwords: ${res.config.stopwords.join(', ')}` : ''),
    );
    if (a.all) {
      for (const c of res.clusters) {
        console.log(`  ${c.flagged ? 'FLAG' : '    '} [${c.label}] ${c.members.length}: ${c.members.join(', ')}`);
      }
    }
    if (res.flagged.length === 0) {
      console.log('OK — no subsystem over the recurrence threshold.');
    } else {
      console.log(`RECURRENCE — ${res.flagged.length} cluster(s) over threshold:`);
      for (const c of res.flagged) {
        console.log(`  [${c.label}] ${c.members.length} tickets (${c.closed.length} closed)`);
        console.log(`      tickets: ${c.members.join(', ')}`);
        if (c.files.length) console.log(`      shared files: ${c.files.join(', ')}`);
        if (c.nearest) console.log(`      adjacent cluster (may be ONE class): [${c.nearest.label}] ${c.nearest.members.join(', ')} (link ${c.nearest.score})`);
        console.log(`      why: ${c.reasons.join('; ')}`);
      }
      console.log(
        'These are QUESTIONS, not verdicts: decide redesign (ARCH-### from docs/bugs/TEMPLATE-ARCH.md) ' +
          'or state why another local patch is right. See docs/ARCHITECTURE-REVIEW.md.',
      );
    }
  }
  process.exit(res.flagged.length ? 1 : 0);
}

const isMain = process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) main();
