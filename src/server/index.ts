/**
 * Claude Station server: static UI + JSON API + one WebSocket per live session.
 * Binds 127.0.0.1 only. Single user, no auth tier — deliberately out of scope.
 */
import * as http from 'node:http';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';

import { projectRoot, dataDir, dataDirMode, assertDataDirIntent, ensureDir, isInside, markSanctionedRealStoreWriter } from '../lib/paths.ts';
import * as hist from '../lib/session-history.ts';
import { loadProvenanceMap, resolveStartedBy, foldsFromDefaultList } from '../lib/session-provenance.mjs';
import * as reg from './registry.ts';
import * as tpl from './templates.ts';
import { readSessionConfig } from './session-config.ts';
import { wiringStatus, coherentWaStack, hasEnabledWaRef } from './wiring.ts';
import * as cm from './container-manager.ts';
import * as svc from './service-manager.ts';
import * as lifecycle from './lifecycle.ts';
import { boundInstance } from './instance-owner.ts';
import * as sub from './subagents.ts';
import * as browser from './browser.ts';
import * as tx from './transcript.ts';
import * as watcher from './watcher.ts';
import * as ot from './orchard-transcripts.ts';
import * as cn from './codex-native.ts';
import * as snaps from './snapshots.ts';
import * as smut from './session-mutations.ts';
import * as sessionClosed from './session-closed.ts'; // FEAT-168 — the Orchard-owned CLOSED record + its one derived read (never the transcript tag)
import * as search from './search.ts';
import * as mem from './memories.ts';
import * as gitcli from './git.ts';
// FEAT-108 round 2 — the runtime, per-project git-write grant store. Host-memory
// only (see git-grant-store.mjs): the ONLY mutator is these user-driven routes,
// so an agent cannot plant a grant by writing config or exporting an env var.
import { grantGitWrite, revokeGitWrite, grantView, listGitWrites, setGitWriteAuditSink, confirmGitWrite, setPermanentGrantSource, permanentGrantOf } from '../../scripts/lib/git-grant-store.mjs';
// FEAT-164 — the PERMANENT grant is a declared project setting; the store reads it
// from the registry (its one owner) at call time, for the hook and the shim alike.
// Wired at import so it is in force before the first request or adopted session.
setPermanentGrantSource(reg.gitWritePermanentOf);
// BUG-173 — the invocation-layer shim consults the SAME grant authority as the
// FEAT-108 hook, over loopback, at call time. `evaluateGitWrite` is that one
// authority; `runLeakGateForRepo` is the one leak gate a granted publish must pass.
import { redeemGitWrite } from '../../scripts/lib/git-grant.mjs';
// BUG-173 round 3 — the decide route authenticates the shim caller with a
// host-minted per-process secret, so it is not an open localhost endpoint.
import { isShimSecretValid } from '../../scripts/lib/git-shim-secret.mjs';
import { runLeakGateForRepo } from './runtime/claude-runtime.ts';
import { repoContentFingerprint } from './leak-gate-host.ts';
import * as rt from './runtime/runtime-update.ts';
// FEAT-157 — base releases + the one target/notice policy (the container CLI pin left provision.json).
import { applyBaseUpdate, baseRailItem, baseStatusOf, registerBaseOp } from './base-updates.ts';
import * as procs from './processes.ts';
import * as board from './board.ts';
// FEAT-058 — the ticket dashboard's read/write layer over the SAME docs/bugs/
// files the rail reads. All board-file logic (append-only discipline, the
// freshness check, the board-tool reconciliation) lives there; the routes below
// are a thin HTTP skin over it.
import * as tickets from './tickets.ts';
import * as decisions from './decisions.ts';
/*
 * FEAT-057 — the server's own record of what ended and why, and the shared
 * empty-snapshot builder (ARCH-001 phase 2). Both exist so the answer a client
 * renders is authored HERE, not assembled from whatever events it caught.
 */
import * as outcomes from './outcomes.ts';
import * as laneDrain from './lane-drain.ts';
import * as lanes from './lanes.ts';
import * as requests from './requests.ts';
import { emptySnapshot, snapshotOfSurvivor } from './running-set.ts';
import { validateProjectPatch, validateCreateProject, validateSessionOverrides, validateSessionPatch, intParam, validateServices } from './validate.ts';
import { buildRecord } from './project-dockerfile.ts'; // FEAT-155 round 5
import { startSession, getSession, closeAllSessions, liveSessions, liveSessionsForProject, bridgeForSession, knownSlashCommands, knownModels, startZombieReaper, adoptSession, resumeDirCandidates, type AgentSession } from './agent-bridge.ts'; // BUG-196 round 3: resumeDirCandidates
import { readGlobalDefaults, patchGlobalDefaults, applyGlobalDefaults } from './global-settings.ts';
import { listAccounts, createAccount, deleteAccount, resolveLaunchAccountDir, AccountError } from './claude-accounts.ts';
// FEAT-145 step 3 — the "Add account" login relay (one attempt at a time, over
// the WebSocket below). It owns the CLI child and its process group.
import { startClaudeLogin, submitClaudeLoginCode, cancelClaudeLogin, type LoginEvent } from './claude-login.ts';
import { adoptSurvivingHosts, attachSurvivable, reapHost, survivingHostForSdkSession, survivingHostForSession, scanSurvivingHosts, dropDeadSurvivorHost, type HostStatus } from './survival.ts';
import { activeDeliveryFor, deliverIntoSurvivor, deliveryEvidenceFor, survivorAdmits, type SurvivorDelivery } from './survivor-delivery.ts';
/*
 * ARCH-001 — every "is it alive / mid-turn" answer this file publishes or acts
 * on comes from the one authority. No route re-derives it.
 */
import { livenessOfSurvivor, livenessWire, livenessWindowsSummary, sessionStateLabel, survivorWork } from './liveness.ts';
// BUG-046 — the stall escalation threshold, for the advisory rail card.
import { stallEscalated } from './stalls.ts';
import { detectCodex } from './runtime/codex-runtime.ts';
// FEAT-116 — provider rate-limit window usage (dispatch-now-vs-park); a cached,
// bounded, fail-quiet reader that never blocks the request path.
import * as providerUsage from './provider-usage.ts';
import type { ClaudeLoginCommand, ClientCommand, StationEvent } from './events.ts';
import {
  startOutbox, stopOutbox, outboxView, outboxExists, createOutboxRow, editOutboxRow, discardOutboxRow, sendOutboxRow, dismissOutboxDamage,
  outboxHasPending, validSessionId, OutboxError, type ResumeSettings, type OutboxWiring, type Probe, type HandOutcome,
} from './outbox.ts';
import { setSessionAccount, getSessionAccount, dropBoundAccountOverride } from './session-accounts.ts'; // FEAT-160 — the switch writes the server-owned session→account binding before it reaps; resumes/enqueues of a bound session drop the client's stale account (it is the server's fact).
// FEAT-038 UI action: the server route reuses the SAME onboarding core the CLI
// runs (`node scripts/onboard.mjs`) — imported, not reimplemented, so the button
// and the command can never diverge. The CLI entry (main()) only runs when the
// file is invoked directly, so importing it here has no side effects.
import { onboard as onboardProject } from '../../scripts/onboard.mjs';
import { augmentedPathEnv } from './path-env.mjs';

/*
 * BUG-091 (root fix, §N) — augment THIS server process's own PATH ONCE, as
 * early as practical, so EVERY descendant host-side engine spawn inherits the
 * user's local tool dirs (`~/.local/bin`, `~/.cargo/bin`). A cold-booted
 * systemd unit hands the service a minimal PATH (`/usr/local/bin:/usr/bin`) that
 * omits `~/.local/bin`, and the engine is spawned host-side by SEVERAL sites,
 * each inheriting `process.env`:
 *   - the survival broker (session-host.mjs, when survival is ON),
 *   - codex-runtime.ts (`{ ...process.env }`, when the engine is codex),
 *   - claude-runtime.ts via the SDK `query()` child (which sets no env).
 * The first BUG-091 fix patched only session-host.mjs and MISSED the two runtime
 * sites (proven by the clean-room verifier: survival-off / codex host spawns
 * still got a PATH with no `~/.local/bin`). Augmenting `process.env.PATH` HERE
 * fixes the DESIGN, not one more site: every current and future descendant spawn
 * inherits the corrected PATH. Container isolation is unaffected — its
 * in-container PATH is built from a fixed passthrough list (container-manager
 * `execArgv`), never from host `process.env`.
 */
process.env.PATH = augmentedPathEnv(process.env).PATH;

/**
 * FEAT-047: the canonical methodology repo — the ONE resolution rule shared
 * with scripts/wa-consolidate.mjs (env METHODOLOGY_DIR, else ~/projects/
 * methodology), so the board route reads the exact needs-human.json the boot /
 * post-capture consolidation passes write.
 */
function methodologyDir(): string {
  const env = process.env.METHODOLOGY_DIR;
  return env && env.trim() ? path.resolve(env) : path.join(os.homedir(), 'projects', 'methodology');
}

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 4317);
const PUBLIC = path.join(projectRoot(), 'public');

/* ------------------------------------------------------------------- utils */

/** An error that already knows its HTTP status. */
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/**
 * FEAT-040 machine-facing ground truth: is a survival broker's process
 * ACTUALLY sitting in a cgroup distinct from this server's own — the correct
 * indicator that it escaped a `systemctl restart` control-group kill.
 *
 * A hand-check that used PPID instead falsely declared FEAT-015 broken and
 * alarmed the user (see FEAT-040's Activity log) — PPID is not the same
 * question `systemd-run --user --scope` answers (a scope's process is
 * reparented but that says nothing about which CGROUP it landed in; a
 * `--scope` child's PPID can even still be this process's while its cgroup
 * is a completely separate one under app.slice/user.slice). Reading
 * `/proc/<pid>/cgroup` (cgroup v2 unified hierarchy: a single `0::/path`
 * line) and comparing the PATH is the actual mechanism `survival.ts` relies
 * on, so it is the only honest way to verify it after the fact.
 */
function cgroupPathOf(pid: number): string | null {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim();
    if (!raw) return null;
    const lines = raw.split('\n');
    // Prefer the cgroup v2 unified entry ("0::/path…"); fall back to the last
    // line for a v1 host (each line is "hierarchy-id:controller-list:path").
    const line = lines.find((l) => l.startsWith('0::')) ?? lines[lines.length - 1];
    const path2 = line.slice(line.indexOf(':', line.indexOf(':') + 1) + 1);
    return path2 || null;
  } catch {
    return null; // pid gone, or no /proc (non-Linux) — fail closed, not "protected"
  }
}

/** This server process's own cgroup — computed once; it never moves cgroups mid-run. */
const SELF_CGROUP = cgroupPathOf(process.pid);

/**
 * GROUND TRUTH: does this survival broker's cgroup differ from the server's
 * own? That is exactly what `systemd-run --user --scope` is FOR (see
 * survival.ts's header) — a real escape lands the broker (and the CLI under
 * it) in a distinct cgroup under app.slice/user.slice, immune to a
 * control-group kill of THIS service. Unreadable cgroups (process just
 * exited, no /proc) report `false` rather than guessing "protected".
 */
function isCgroupScoped(pid: number): boolean {
  const hostCgroup = cgroupPathOf(pid);
  if (!hostCgroup || !SELF_CGROUP) return false;
  return hostCgroup !== SELF_CGROUP;
}

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body, null, 2));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
}

async function readBody(req: http.IncomingMessage, limit = 2 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, `request body too large (limit ${limit} bytes)`);
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serveStatic(res: http.ServerResponse, urlPath: string): boolean {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!isInside(PUBLIC, file)) return false;
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  // FEAT-139 — inject the persisted machine theme onto <html> for index.html, so
  // the FIRST paint matches the server (the source of truth for appearance) even
  // when the client's localStorage cache is cold or was just cleared: no flash of
  // the wrong theme. 'system' injects nothing (the CSS default), matching the
  // client's applyTheme. The client still reads/writes localStorage as a fast
  // cache and reconciles against GET /api/settings.
  if (rel === 'index.html') {
    let html = fs.readFileSync(file, 'utf8');
    const theme = readGlobalDefaults().theme;
    if (theme === 'light' || theme === 'dark') {
      html = html.replace(/<html((?:\s[^>]*)?)>/i, (_m, attrs) => `<html${attrs} data-theme="${theme}">`);
    }
    const buf = Buffer.from(html, 'utf8');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': buf.length,
      'cache-control': 'no-store',
    });
    res.end(buf);
    return true;
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'content-length': st.size,
    'cache-control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
  return true;
}

/* ------------------------------------------------------------------ guide */
/*
 * FEAT-075 Phase 3 — the in-app Guide reader reads docs/guide/*.md from THIS
 * server's own repo dir (projectRoot()), because the guide SHIPS WITH THE APP;
 * it is not per-project content. Onboarded repos that never copied docs/ simply
 * have no guide dir — every read degrades to empty/404, never a throw.
 */
const GUIDE_DIR = path.join(projectRoot(), 'docs', 'guide');

/** Split a guide page into its title (first `# heading`) and frontmatter-free body. */
function readGuidePage(file: string, name: string): { title: string; body: string } {
  const raw = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  // Drop a leading YAML frontmatter block (the `sources:` pin) so the reader
  // shows prose, not the machine-readable header the freshness checker uses.
  const fm = /^---\n[\s\S]*?\n---\n?/.exec(raw);
  const body = fm ? raw.slice(fm[0].length) : raw;
  const h = /^#\s+(.+?)\s*$/m.exec(body);
  return { title: h ? h[1].trim() : name.replace(/\.md$/, ''), body };
}

/**
 * Sessions on disk for a registered project, merged across OS copies.
 *
 * A containerised project writes its history under `-workspace-<project.id>`,
 * whose internal cwd (`/workspace/<id>`) only groups with the host path when
 * `project.id` happens to equal `logicalKeyForCwd(hostPath)`. They diverge as
 * soon as the project name differs from the directory basename, or a duplicate
 * id picked up a `-2` suffix — and the container's whole history then went
 * silently missing from the list. So the container dir is looked up EXPLICITLY
 * and merged in, de-duplicated by sessionId.
 */
/**
 * FEAT-155 — the store-dir -> address lookup the session-mutation guard reads.
 * A per-project container store dir (`-workspace-<id>`) has exactly one
 * address, `/workspace/<id>`, declared by container-manager
 * (`containerStoreAddressOfDir`, the exact inverse of `containerStoreDirName`),
 * whether or not the project that wrote it is still registered — a deleted
 * project's kept history is listed by basename like any other and must stay
 * renamable/deletable. A session in it may have run at that address or at bare
 * `/workspace` (workspaceRoot); handing the SDK the address reaches this very dir.
 */
const declaredContainerStore: smut.DeclaredStoreLookup = (encodedDir) => {
  const address = cm.containerStoreAddressOfDir(encodedDir);
  return address ? { address, recordedCwds: [address, cm.CONTAINER_WORKSPACE] } : null;
};

function sessionsForProject(p: reg.Project) {
  const encoded = hist.encodeCwd(p.hostPath);
  /*
   * FEAT-155 — a container store whose newest session ran at BARE `/workspace`
   * records a cwd that names no project; grouped on it, every such store (and
   * the legacy shared `-workspace`) would land in one "workspace" group. So a
   * per-project store is grouped on its own ADDRESS (`/workspace/<id>`, the
   * owner's declaration via `containerStoreAddressOfDir`) — exactly the key it
   * had before it ever ran at the bare root, so moving, re-registering or
   * toggling behaves as it always did.
   */
  const projects = hist.groupByLogicalProject(hist.listProjectDirs().map((d) => {
    if ((d.cwd ?? d.cwdGuess) !== cm.CONTAINER_WORKSPACE) return d;
    const address = cm.containerStoreAddressOfDir(d.encodedDir);
    return address ? { ...d, cwd: address } : d;
  }));
  const logical =
    projects.find((lp) => lp.dirs.some((d) => d.encodedDir === encoded)) ??
    projects.find((lp) => lp.key === hist.logicalKeyForCwd(p.hostPath));

  /*
   * FEAT-155 — one exclusion from basename grouping: the legacy shared
   * `-workspace` dir (bare-root runs from before per-project stores) names no
   * project and joins none. Everything else groups exactly as before. (An
   * extra "another live project's store never joins" filter was tried and
   * refuted: after an id is reused, it hid a re-registered owner's history.)
   */
  const containerDir = cm.containerStoreDirName(p);
  const sharedBareDir = cm.encodeCwdForStore(cm.CONTAINER_WORKSPACE);
  const groupDirs = logical ? logical.dirs.filter((d) => d.encodedDir !== sharedBareDir || d.encodedDir === encoded) : [];
  const sessions = logical ? hist.listLogicalProjectSessions({ ...logical, dirs: groupDirs }) : [];
  const dirs = groupDirs.map((d) => d.encodedDir);

  for (const storeDir of [containerDir]) {
    if (dirs.includes(storeDir)) continue;
    let extra: ReturnType<typeof hist.listSessions> = [];
    try {
      extra = hist.listSessions(storeDir);
    } catch {
      extra = []; // dir absent — the project has simply never run in a container
    }
    if (extra.length) {
      const seen = new Set(sessions.map((s) => s.sessionId));
      for (const s of extra) if (!seen.has(s.sessionId)) sessions.push(s);
      dirs.push(storeDir);
      sessions.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
    }
  }
  /*
   * BUG-138 — THE PATHS THIS PROJECT USED TO LIVE AT.
   *
   * History is indexed by the working directory and grouped on that path's
   * BASENAME, so renaming a directory (not merely moving it) puts every past
   * session under a key the current path no longer reaches. The files are never
   * deleted — they are stranded. `pastPaths` is the registry's record of where
   * this project used to be, and merging those store dirs here is what makes a
   * repoint carry its sessions instead of losing them. De-duplicated by
   * sessionId like every other merge above, so renaming BACK cannot double-list
   * anything.
   */
  const pastDirs = reg.pastPathsOf(p).map((q) => hist.encodeCwd(q));
  for (const d of pastDirs) {
    if (dirs.includes(d)) continue;
    let extra: ReturnType<typeof hist.listSessions> = [];
    try {
      extra = hist.listSessions(d);
    } catch {
      extra = []; // the old store dir is gone too — nothing to carry
    }
    if (!extra.length) continue;
    const seen = new Set(sessions.map((s) => s.sessionId));
    for (const s of extra) if (!seen.has(s.sessionId)) sessions.push(s);
    dirs.push(d);
    sessions.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
  }
  /*
   * FEAT-037 P2b — Orchard-owned transcripts (engines with no store of their
   * own, e.g. Codex). Same layout under dataDir()/transcripts/<provider>/, so
   * the SAME encoded dirs apply; each recovered session carries its `provider`
   * so the sidebar can name the engine and the resume path can pick it.
   */
  {
    const seen = new Set(sessions.map((s) => s.sessionId));
    let merged = false;
    for (const d of new Set([...dirs, encoded, containerDir, ...pastDirs])) {
      for (const s of ot.listOrchardSessions(d)) {
        if (seen.has(s.sessionId)) continue;
        seen.add(s.sessionId);
        sessions.push(s);
        merged = true;
        if (!dirs.includes(d)) dirs.push(d);
      }
    }
    if (merged) sessions.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
  }
  /*
   * FEAT-078 — NATIVE (external) codex sessions. Scanned head-only from codex's
   * own store ($CODEX_HOME/sessions), matched by `session_meta.cwd` to this
   * project's hostPath, tagged provider:'openai' so the sidebar badges them
   * exactly like Orchard-run codex rows. De-duplicated against everything
   * above by sessionId: a session already imported into the Orchard transcript
   * store (on a prior open/resume) is an 'openai' row up there already, so its
   * native twin is skipped and no duplicate appears.
   */
  {
    const seen = new Set(sessions.map((s) => s.sessionId));
    let added = false;
    // BUG-138: past paths count here too — a native codex session recorded
    // against the pre-rename cwd belongs to this project just as much.
    for (const cwd of [p.hostPath, ...reg.pastPathsOf(p)]) {
      for (const s of cn.listNativeCodexSessions(cwd)) {
        if (seen.has(s.sessionId)) continue;
        seen.add(s.sessionId);
        sessions.push(s);
        added = true;
        if (!dirs.includes(s.encodedDir)) dirs.push(s.encodedDir);
      }
    }
    if (added) sessions.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
  }
  return { sessions, dirs };
}

/* --------------------------------------------------------------- API routes */

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const m = req.method ?? 'GET';
  const rest = seg.slice(1);

  if (rest[0] === 'runtime' && rest.length <= 2) {
    return await handleRuntimeRoute(req, res, rest[1], m);
  }

  if (rest[0] === 'health' && m === 'GET') {
    /*
     * FEAT-040: the machine half of session-state legibility. Per LIVE
     * session, report GROUND TRUTH — not what was configured, not a guess —
     * so nobody has to hand-improvise a PPID/`ps` check again (that is
     * precisely the mistake that alarmed the user in FEAT-040's Activity
     * log). `survival.ts` is read ONLY through its existing exports
     * (`scanSurvivingHosts`); this file never touches its internals.
     */
    const hosts = scanSurvivingHosts();
    const hostBySession = new Map<string, HostStatus>();
    for (const h of hosts) if (h.stationSessionId) hostBySession.set(h.stationSessionId, h);
    const brokerOf = (host: HostStatus) => ({
      hostPid: host.hostPid,
      claudePid: host.claudePid,
      state: host.state,
      sock: host.sock,
      updatedAt: host.updatedAt ?? null,
      // FEAT-064 drain truth surface — what the broker's own heartbeats say is
      // holding it (null = a status file written by an older broker).
      backgroundLive: host.backgroundLive ?? null,
      backgroundTaskIds: host.backgroundTaskIds ?? null,
      backgroundLifetime: host.backgroundLifetime ?? null,
      drainHeldSince: host.drainHeldSince ?? null,
      // FEAT-065 — the delivery gate's foreground-idle evidence.
      midTurn: host.midTurn ?? null,
    });
    const live = liveSessions().map((s) => {
      const host = hostBySession.get(s.id) ?? null;
      // Coarse, HONEST state — only what a live AgentSession truthfully knows
      // server-side. Finer distinctions (thinking vs streaming, reconnecting)
      // are per-socket transport facts the client observes directly off the
      // StationEvent stream (see public/app.js's paintSessStatus) — reporting
      // them here would mean guessing, which this endpoint exists to replace.
      // ARCH-001: the label is DERIVED FROM THE VERDICT, never from the raw
      // `busy` flag. Before this, a zombie bridge reported `state:'busy'` in
      // the same payload whose own `liveness.live` said false — /api/health,
      // the one endpoint that exists so nobody has to guess, contradicting
      // itself. `busy` below is deliberately still the RAW in-memory claim:
      // this endpoint is the diagnostic self-report, and showing the claim
      // beside the verdict is what made BUG-033 diagnosable at all. Every
      // OTHER route publishes only the verdict.
      const v = s.livenessVerdict();
      const state = sessionStateLabel(s, v);
      return {
        stationSessionId: s.id,
        sdkSessionId: s.sdkSessionId,
        projectId: s.project.id,
        isolation: s.project.isolation,
        busy: s.busy,
        detached: s.detached,
        state,
        // BUG-033 ground truth behind `busy`/`state`.
        turnStartedAt: s.turnStartedAt,
        lastFrameAt: s.lastFrameAt || null,
        processAlive: s.processProbe().state, // 'alive' | 'dead' | 'unknown' — never guessed
        liveness: livenessWire(v), // the authority's verdict, with its evidence
        busyClaimed: s.busy, // the raw in-memory flag, named as the claim it is
        // This entry is a live in-memory AgentSession this server is driving.
        adopted: true,
        // BUG-187 — how this server came to hold it: `none` = it spawned the CLI;
        // `adopted` / `responder-only` / `pending` = re-attached to a surviving broker.
        adoptState: s.adoptState,
        // FEAT-108 round 2 — is a runtime git-write grant currently ACTIVE for
        // this session's project? Surfaced so the session can show that agent
        // git writes are permitted; a grant must never be invisible.
        gitWriteGrant: grantView(s.project.id),
        // Was survival even ATTEMPTED for this session (isolation "direct" +
        // survival enabled at spawn time)? A claim, not a verified fact.
        survivalConfigured: s.survivable,
        // GROUND TRUTH: is the broker actually sitting in a cgroup distinct
        // from this server's own, verified by reading /proc right now? null
        // when there is no broker to check at all (not configured, or its
        // status file/pid is already gone).
        survivalScoped: host ? isCgroupScoped(host.hostPid) : null,
        broker: host ? brokerOf(host) : null,
      };
    });
    /*
     * BUG-027: survivors that are NOT (yet) an in-memory session. After a
     * restart, a FEAT-015 broker + CLI can be alive in their own scope while
     * this server holds no AgentSession for them (boot's adoptSurvivingHosts
     * SIGTERMs the broker but the in-flight turn can drain for minutes, and
     * no live bridge exists until a client resumes). The old health payload
     * was a left-join on liveSessions(), so exactly after the event this
     * endpoint exists to illuminate — a restart — it reported `sessions: []`
     * while the survivor was alive on disk, and doctor said "No live
     * sessions" (the inverse false signal of BUG-024). Surface every scanned
     * survivor not consumed by the live join, explicitly `adopted: false`,
     * with its broker/CLI pids + state, so the self-report can never claim
     * "nothing" while a scoped survivor exists.
     */
    const liveIds = new Set(live.map((s) => s.stationSessionId));
    const survivors = hosts
      .filter((h) => !(h.stationSessionId && liveIds.has(h.stationSessionId)))
      .map((h) => {
        /*
         * ARCH-001: `scanSurvivingHosts()` above now only returns records the
         * authority has NOT proven dead (a corpse is swept there), so this
         * `surviving-unadopted` row can no longer be the lie it used to be —
         * doctor printed "SURVIVED a restart … turn draining" for a broker
         * whose CLI had already exited. The verdict rides along so the reader
         * never has to take the row's existence as the evidence.
         */
        const hv = livenessOfSurvivor(h);
        /*
         * BUG-072: `busy: null` was true of the SERVER's knowledge and false
         * about the world — while FEAT-065 delivers turns into this survivor,
         * the session runs turns all day and this row (the only row it has)
         * said nothing was known. The authority answers it now from the
         * broker's own declarations plus this server's delivery-relay
         * evidence: `busy` is the turn claim (null stays null ONLY when an
         * older broker never published boundaries — unknown, never coerced),
         * and `work` names the main turn + the background lanes so doctor and
         * /api/health cannot report "nothing" while a delivered turn runs.
         */
        const sdkId = h.sdkSessionId ?? h.resumeHint ?? null;
        const delivery = deliveryEvidenceFor(sdkId);
        const work = survivorWork(h, delivery);
        return {
          stationSessionId: h.stationSessionId ?? null,
          sdkSessionId: sdkId,
          projectId: null, // the broker status file does not record the project; unknown, not guessed
          isolation: 'direct' as const, // survival brokers exist only for direct sessions
          busy: work.turnRunning,
          detached: null,
          // The delivered turn's honest start (null = not knowable), and this
          // server's own relay state: `true` means WE wrote the frame that is
          // running — the closest thing to ownership that exists without
          // spawning a second CLI (which BUG-022 forbids).
          turnStartedAt: work.turnSince,
          deliveryActive: !!delivery,
          work: { turnRunning: work.turnRunning, turnSince: work.turnSince, reason: work.reason, lanes: work.lanes },
          state: 'surviving-unadopted' as const,
          adopted: false,
          liveness: livenessWire(hv),
          processAlive: hv.state,
          survivalConfigured: true, // a broker exists at all only because survival was on
          survivalScoped: isCgroupScoped(h.hostPid),
          broker: brokerOf(h),
        };
      });
    const sessions = [...live, ...survivors];
    // `watches` is here so a leaked fs.watch is assertable from outside.
    sendJson(res, 200, {
      ok: true, dataDir: dataDir(), pid: process.pid, watches: watcher.activeWatchCount(),
      liveBridges: live.length, sessions,
    });
    return true;
  }

  /*
   * FEAT-058: which registered projects have a board at all, with their ticket
   * counts — the ticket dashboard's project switcher. Separate from
   * /api/projects so the sidebar's payload (which every boot fetches) does not
   * grow a per-project directory scan it has no use for.
   */
  if (rest[0] === 'boards' && rest.length === 1 && m === 'GET') {
    sendJson(res, 200, {
      boards: reg.listProjects().map((p) => {
        const l = tickets.listTickets(p.hostPath);
        return {
          id: p.id,
          name: p.name,
          hostPath: p.hostPath,
          hasBoard: l.hasBoard,
          total: l.tickets.length,
          open: l.tickets.filter((t) => t.section === 'open').length,
          needsYou: l.tickets.filter((t) => t.needsYou).length,
        };
      }).filter((b) => b.hasBoard),
    });
    return true;
  }

  /*
   * FEAT-075 — the in-app Guide reader. Read-only, no writes, no per-project
   * scope: it serves the app's OWN docs/guide/*.md.
   *   GET /api/guide            → { pages: [{ page, title }] }  (README first)
   *   GET /api/guide/:page      → { page, title, markdown }     (frontmatter stripped)
   * Path safety: a page id is one bare filename segment (letters/digits/._-),
   * `.md` is appended HERE (never accepted from the client), and the resolved
   * path is asserted INSIDE the guide dir — so `..`, absolute paths, and nested
   * traversal all resolve to a 404, not a file outside docs/guide.
   */
  if (rest[0] === 'guide') {
    if (rest.length === 1 && m === 'GET') {
      let pages: { page: string; title: string }[] = [];
      try {
        pages = fs.readdirSync(GUIDE_DIR)
          .filter((f) => f.endsWith('.md'))
          .map((f) => ({ page: f.slice(0, -3), title: readGuidePage(path.join(GUIDE_DIR, f), f).title }))
          .sort((a, b) =>
            a.page === 'README' ? -1 : b.page === 'README' ? 1 : a.page.localeCompare(b.page));
      } catch {
        pages = []; // docs/guide absent (onboarded repo) → empty list, not a 500
      }
      sendJson(res, 200, { pages });
      return true;
    }
    if (rest.length === 2 && m === 'GET') {
      const page = rest[1];
      if (!/^[A-Za-z0-9._-]+$/.test(page) || page.includes('..')) {
        return notFound(res, `guide: bad page ${JSON.stringify(page)}`);
      }
      const file = path.join(GUIDE_DIR, `${page}.md`);
      if (!isInside(GUIDE_DIR, file) || !file.endsWith('.md')) {
        return notFound(res, `guide: bad page ${JSON.stringify(page)}`);
      }
      try {
        if (!fs.statSync(file).isFile()) return notFound(res, `guide: no page ${JSON.stringify(page)}`);
      } catch {
        return notFound(res, `guide: no page ${JSON.stringify(page)}`);
      }
      const { title, body } = readGuidePage(file, `${page}.md`);
      sendJson(res, 200, { page, title, markdown: body });
      return true;
    }
    return notFound(res, `guide: no route ${m} ${url.pathname}`);
  }

  /* projects */
  if (rest[0] === 'projects') {
    if (rest.length === 1 && m === 'GET') {
      // `lastActivityAt` rides along from the session index (cached per scan)
      // so the sidebar can show recency WITHOUT loading any session list —
      // recency must never trigger the expensive operation (expansion).
      sendJson(res, 200, {
        projects: reg.listProjects().map((p) => {
          let lastActivityAt: string | null = null;
          try {
            lastActivityAt = sessionsForProject(p).sessions[0]?.lastActivityAt ?? null;
          } catch { /* store unreadable — recency is a nicety, the list is not */ }
          // BUG-138: whether the project's directory is still there. One stat,
          // on the payload every boot already fetches, so the UI can say "this
          // project's directory is gone" instead of the user finding out when a
          // session dies with a bare "Error".
          return { ...p, lastActivityAt, pathMissing: reg.hostPathMissing(p) };
        }),
      });
      return true;
    }
    if (rest.length === 1 && m === 'POST') {
      const body = await readBody(req);
      let input: reg.CreateProjectInput;
      try {
        // Same validator as PATCH. Without this, `isolation:"Container"` created a
        // project that ran on the HOST while reporting itself as containerised.
        input = validateCreateProject(body);
      } catch (err) {
        sendJson(res, 400, { error: (err as Error).message });
        return true;
      }
      const created = reg.createProject(input);
      /*
       * FEAT-089 — adding a project to Orchard applies the full METHOD
       * automatically, not opt-in. `applyMethod` is a request-level directive
       * (stripped by validateCreateProject before it reaches the settings
       * validator): DEFAULT true; a client adds a project purely to browse
       * history by sending `applyMethod:false`, which leaves the target
       * repository byte-for-byte untouched and attaches nothing.
       *
       * When applied, in order:
       *   1. onboard() — the idempotent file scaffold (board, drift-guard,
       *      conventions stub, format Stop hook + its closure, gate wrapper).
       *      Runs FIRST so the machinery the WA assumes (a board, the gate)
       *      actually exists before the WA is attached.
       *   2. The COHERENT Working-Agreement stack (v1 base first, then v2), via
       *      the SAME validated PATCH path the wiring panel uses (BUG-099) —
       *      never a hand-rolled registry write.
       *   3. The response format is ENABLED by default already
       *      (defaultResponseDigestSettings), so injection (FEAT-084, gated on
       *      that same flag) is on by construction; we surface its state rather
       *      than re-set it.
       * Every write is idempotent and never clobbers; the reports are returned
       * so the UI can show exactly what was created, never leaving the user to
       * discover the side effect. A scaffold failure is reported, NOT fatal —
       * the project is already registered and usable.
       */
      const applyMethod = !(body && typeof body === 'object' && (body as Record<string, unknown>).applyMethod === false);
      let method: {
        applied: boolean;
        declined: boolean;
        reports?: import('../../scripts/onboard.mjs').OnboardReport[];
        waAttached?: boolean;
        responseFormatEnabled?: boolean;
        wiring?: ReturnType<typeof wiringStatus>;
        error?: string;
      };
      if (!applyMethod) {
        // BUG-144 — a deliberate opt-out is a RECORDED decision, not an absence.
        // Stamp the method version (with instructions left empty) so a later
        // backfill sees the decision was made and never silently re-attaches the
        // WA to a project where the user declined it.
        const declinedPatch = validateProjectPatch({ settings: { methodVersion: reg.CURRENT_METHOD_VERSION } });
        const declined = reg.updateProject(created.id, declinedPatch);
        method = { applied: false, declined: true };
        sendJson(res, 201, { project: declined, method });
        return true;
      }
      try {
        const reports = onboardProject(created.hostPath);
        // Attach the coherent WA stack through the validated PATCH path (shared
        // helper — same code as the wiring "Apply"), and stamp the method version
        // (BUG-144) so the applied decision is recorded on the row.
        const waPatch = validateProjectPatch({ settings: { instructions: coherentWaStack(created), methodVersion: reg.CURRENT_METHOD_VERSION } });
        const withWa = reg.updateProject(created.id, waPatch);
        const wiring = wiringStatus(withWa);
        method = {
          applied: true,
          declined: false,
          reports,
          waAttached: hasEnabledWaRef(withWa),
          responseFormatEnabled: reg.responseDigestOf(withWa).enabled,
          wiring,
        };
        sendJson(res, 201, { project: withWa, method });
      } catch (err) {
        // The project is already created; the method-apply failed. Surface it
        // (repairable later via the wiring panel) instead of failing the add.
        method = { applied: false, declined: false, error: `method apply failed: ${(err as Error).message}` };
        sendJson(res, 201, { project: reg.getProject(created.id) ?? created, method });
      }
      return true;
    }
    if (rest[1] === 'scan' && m === 'GET') {
      sendJson(res, 200, { suggestions: reg.scanForProjects() });
      return true;
    }
    /*
     * FEAT-059 — get-or-create the Orchard-owned scratch project. Called by
     * the sidebar's global "New session" button (never by the per-project
     * ones, which already know their project id). Idempotent: creates the
     * scratch dir + registry row on first call only, so a fresh install has
     * neither until a user actually clicks the global New button once.
     */
    if (rest[1] === 'scratch' && rest[2] === 'ensure' && rest.length === 3 && m === 'POST') {
      sendJson(res, 200, { project: reg.ensureScratchProject() });
      return true;
    }
    const id = rest[1];
    if (id && rest.length === 2 && m === 'GET') {
      const p = reg.getProject(id);
      if (!p) return notFound(res, `no project ${id}`);
      sendJson(res, 200, { project: { ...p, pathMissing: reg.hostPathMissing(p) } });
      return true;
    }
    if (id && rest.length === 2 && (m === 'PATCH' || m === 'PUT')) {
      const before = reg.getProject(id);
      if (!before) return notFound(res, `no project ${id}`);
      const body = await readBody(req);
      let patch: Partial<reg.Project>;
      try {
        patch = validateProjectPatch(body);
      } catch (err) {
        sendJson(res, 400, { error: (err as Error).message });
        return true;
      }
      /*
       * BUG-138 — a repoint is the one PATCH field that can lose something, so
       * it is the one with real preconditions. Resolve `~` and relatives the
       * same way createProject does, refuse a path that is not an existing
       * directory (a typo must not become the recorded truth), and refuse one
       * another project already owns (two rows on one directory would merge
       * their histories). The reply REPORTS the carry — how many sessions still
       * list under this project afterwards, and from which store dirs — so the
       * user is told the history survived instead of having to go and check.
       */
      let pathChange: {
        from: string; to: string; carriedSessions: number; carriedFrom: string[]; pastPaths: string[];
      } | null = null;
      if (patch.hostPath !== undefined) {
        const to = path.resolve(patch.hostPath.startsWith('~')
          ? path.join(os.homedir(), patch.hostPath.slice(1))
          : patch.hostPath);
        let isDir = false;
        try { isDir = fs.statSync(to).isDirectory(); } catch { isDir = false; }
        if (!isDir) {
          sendJson(res, 400, { error: `cannot repoint "${before.name}": ${to} is not an existing directory` });
          return true;
        }
        const clash = reg.listProjects().find((q) => q.id !== id && q.hostPath === to);
        if (clash) {
          sendJson(res, 400, { error: `cannot repoint "${before.name}": project "${clash.name}" already points at ${to}` });
          return true;
        }
        patch.hostPath = to;
        pathChange = { from: before.hostPath, to, carriedSessions: 0, carriedFrom: [], pastPaths: [] };
      }
      // updateProject writes through writeAtomic(), so a crash mid-write leaves
      // the previous registry intact rather than a truncated file.
      const project = reg.updateProject(id, patch);
      // FEAT-155 — a settings change can change the container's drift verdict;
      // the status cache must not report the pre-PATCH answer for its TTL.
      cm.invalidate(id);
      if (pathChange && pathChange.from !== pathChange.to) {
        try {
          const after = sessionsForProject(project);
          pathChange.carriedSessions = after.sessions.length;
          pathChange.carriedFrom = after.dirs;
        } catch { /* the count is a courtesy; the repoint itself already landed */ }
        pathChange.pastPaths = reg.pastPathsOf(project);
      }
      sendJson(res, 200, { project, pathChange: pathChange && pathChange.from !== pathChange.to ? pathChange : null });
      return true;
    }
    /*
     * BUG-138 — where might this project have gone? Read-only: it writes
     * nothing, decides nothing, and is explicit about how much its offer is
     * worth (see registry.repointCandidates — a `match` is only ever against
     * the project's own recorded identity, never a name resemblance).
     */
    if (id && rest[2] === 'repoint-candidates' && rest.length === 3 && m === 'GET') {
      const p = reg.getProject(id);
      if (!p) return notFound(res, `no project ${id}`);
      sendJson(res, 200, reg.repointCandidates(p));
      return true;
    }
    /*
     * FEAT-038 — "Onboard this project to Orchard" as a one-click UI action.
     * Runs the SAME idempotent core the CLI does (scripts/onboard.mjs), against
     * the project's own hostPath. Re-running is safe: onboard() reports each
     * artifact as `created` vs. already-present, never double-scaffolds, and we
     * surface `alreadyOnboarded` so the UI can say so honestly instead of
     * pretending it did work. A bad target dir (hostPath gone / not a dir) or
     * an I/O failure becomes a clean 400 with the core's own message — never a
     * 500 stack leak.
     */
    if (id && rest[2] === 'onboard' && rest.length === 3 && m === 'POST') {
      const p = reg.getProject(id);
      if (!p) return notFound(res, `onboard: no project ${JSON.stringify(id)}`);
      let reports;
      try {
        reports = onboardProject(p.hostPath);
      } catch (err) {
        sendJson(res, 400, { error: `onboard: ${(err as Error).message}` });
        return true;
      }
      const createdCount = reports.filter(
        (r) => r.status.startsWith('created') || r.status.startsWith('added'),
      ).length;
      sendJson(res, 200, {
        ok: true,
        projectId: p.id,
        hostPath: p.hostPath,
        alreadyOnboarded: createdCount === 0,
        createdCount,
        reports,
      });
      return true;
    }
    /*
     * FEAT-076 — per-project "Wiring" health panel.
     *
     *   GET  /api/projects/:id/wiring         → { wiring }  (pure read, no side effects)
     *   POST /api/projects/:id/wiring/apply   → { wiring, reports? }  (one Apply)
     *
     * The GET recomputes from true sources every call (registry refs + fs under
     * the project's OWN hostPath) — see wiring.ts. It writes NOTHING and, in
     * particular, never runs onboard: scaffolding a tree merely because a panel
     * was opened would be a real, unasked-for side effect on that repo.
     *
     * The POST is the ONLY thing that mutates, and only for the check the user
     * clicked. hostPath is read from the registry here too, never from the body.
     * Two Apply kinds:
     *   - 'onboard'   → shell-free call into the SAME idempotent core the CLI /
     *     FEAT-038 button use (onboardProject), against p.hostPath ONLY. Never
     *     against the station's own cwd.
     *   - 'attach-wa' → attach the COHERENT Working-Agreement stack — the stable
     *     base (working-agreement / v1) FIRST, then the living extension
     *     (working-agreement-v2 / v2) — both enabled, through the validated
     *     project-PATCH path (validateProjectPatch + updateProject), never a
     *     hand-rolled registry write. Idempotent: existing (possibly disabled) WA
     *     refs are enabled in place rather than duplicated. Repairs a v2-only
     *     stack by inserting v1 immediately before v2 (base first) without
     *     disturbing other refs. See BUG-099.
     * Either way the response carries the freshly-recomputed wiring so the client
     * re-render flips the row to ✅ without a second round-trip.
     */
    if (id && rest[2] === 'wiring' && rest.length <= 4) {
      const p = reg.getProject(id);
      if (!p) return notFound(res, `wiring: no project ${JSON.stringify(id)}`);
      if (rest.length === 3 && m === 'GET') {
        sendJson(res, 200, { wiring: wiringStatus(p) });
        return true;
      }
      if (rest[3] === 'apply' && rest.length === 4 && m === 'POST') {
        const body = (await readBody(req)) as Record<string, unknown>;
        const check = typeof body.check === 'string' ? body.check : '';
        try {
          if (check === 'working-agreement' || check === 'attach-wa') {
            // Attach the COHERENT WA stack (v1 base FIRST, then v2 extension) via
            // the validated PATCH path. The full new stack is sent because
            // updateProject replaces `instructions` wholesale. This is idempotent
            // and repairs a v2-only stack in place (BUG-099). The stack itself is
            // built by the single shared helper (wiring.coherentWaStack), reused by
            // the FEAT-089 add-project auto-apply so both take the identical path.
            const stack = coherentWaStack(p);
            const patch = validateProjectPatch({ settings: { instructions: stack } });
            const updated = reg.updateProject(id, patch);
            sendJson(res, 200, { ok: true, applied: 'working-agreement', wiring: wiringStatus(updated) });
            return true;
          }
          if (check === 'conventions' || check === 'board' || check === 'drift-guard') {
            // Scaffolding checks all share the idempotent onboard core, run
            // against the project's OWN hostPath — never the station's cwd.
            let reports;
            try {
              reports = onboardProject(p.hostPath);
            } catch (err) {
              sendJson(res, 400, { error: `wiring: onboard failed: ${(err as Error).message}` });
              return true;
            }
            const fresh = reg.getProject(id) ?? p;
            sendJson(res, 200, { ok: true, applied: check, reports, wiring: wiringStatus(fresh) });
            return true;
          }
          sendJson(res, 400, { error: `wiring: nothing to apply for check ${JSON.stringify(check)}` });
          return true;
        } catch (err) {
          sendJson(res, 400, { error: `wiring: ${(err as Error).message}` });
          return true;
        }
      }
      return notFound(res, `wiring: no route ${m} ${url.pathname}`);
    }
    if (id && rest[2] === 'container' && rest.length <= 4) {
      return await handleContainerRoute(res, id, rest[3], m, url);
    }
    if (id && rest[2] === 'browser' && rest.length <= 4) {
      return handleBrowserRoute(res, id, rest[3], m, url);
    }
    if (id && rest[2] === 'snapshots' && rest.length <= 5) {
      return await handleSnapshotsRoute(req, res, id, rest[3], rest[4], m, url);
    }
    /* git: status + actions via the git/gh CLIs — see git.ts */
    if (id && rest[2] === 'git' && rest.length <= 4) {
      const p = reg.getProject(id);
      if (!p) return notFound(res, `git: no project ${JSON.stringify(id)}`);
      const action = rest[3];
      try {
        if (m === 'GET' && (!action || action === 'status')) {
          sendJson(res, 200, { status: await gitcli.statusOf(p.hostPath) });
          return true;
        }
        if (m === 'GET' && action === 'changes') {
          sendJson(res, 200, await gitcli.changes(p.hostPath));
          return true;
        }
        if (m === 'GET' && action === 'branches') {
          // Carry an authoritative live-session count so the panel can WARN
          // before a switch changes the ground under a running agent (the
          // user's "sessions keep working on some branch" hazard). The count is
          // the liveness authority's, not a client re-derivation.
          sendJson(res, 200, { ...(await gitcli.branches(p.hostPath)), liveSessions: liveSessionsForProject(id).length });
          return true;
        }
        if (m === 'GET' && action === 'stashes') { sendJson(res, 200, await gitcli.stashList(p.hostPath)); return true; }
        if (m === 'GET' && action === 'stash-show') {
          sendJson(res, 200, await gitcli.stashShow(p.hostPath, url.searchParams.get('ref'), url.searchParams.has('path') ? url.searchParams.get('path') : undefined));
          return true;
        }
        if (m === 'GET' && action === 'log') {
          sendJson(res, 200, await gitcli.log(p.hostPath, { limit: url.searchParams.get('limit'), before: url.searchParams.get('before') ?? undefined, cursor: url.searchParams.get('cursor') ?? undefined }));
          return true;
        }
        if (m === 'GET' && action === 'commit-files') { sendJson(res, 200, await gitcli.commitFiles(p.hostPath, url.searchParams.get('sha'))); return true; }
        if (m === 'GET' && action === 'commit-diff') { sendJson(res, 200, await gitcli.commitDiff(p.hostPath, url.searchParams.get('sha'), url.searchParams.get('path'))); return true; }
        if (m === 'POST' && action) {
          const body = (await readBody(req)) as Record<string, unknown>;
          switch (action) {
            case 'init': sendJson(res, 200, { status: await gitcli.init(p.hostPath) }); return true;
            case 'stage': sendJson(res, 200, await gitcli.stage(p.hostPath, body.paths ?? body.path, body.staged === true)); return true;
            case 'diff': sendJson(res, 200, await gitcli.diff(p.hostPath, body.path)); return true;
            case 'commit': sendJson(res, 200, await gitcli.commit(p.hostPath, body)); return true;
            case 'push': sendJson(res, 200, await gitcli.push(p.hostPath)); return true;
            case 'pull': sendJson(res, 200, await gitcli.pull(p.hostPath)); return true;
            case 'fetch': sendJson(res, 200, await gitcli.fetch(p.hostPath)); return true;
            case 'switch-branch': sendJson(res, 200, await gitcli.switchBranch(p.hostPath, body.name)); return true;
            case 'create-branch': sendJson(res, 200, await gitcli.createBranch(p.hostPath, body.name)); return true;
            case 'checkout-remote': sendJson(res, 200, await gitcli.checkoutRemote(p.hostPath, body.name)); return true;
            case 'create-repo':
              sendJson(res, 200, await gitcli.createRepo(p.hostPath, String(body.name ?? path.basename(p.hostPath)), { public: body.public === true }));
              return true;
          }
        }
        return notFound(res, `git: no route ${m} .../git/${action ?? ''}`);
      } catch (err) {
        const status = err instanceof gitcli.GitError ? err.status : 500;
        sendJson(res, status, { error: (err as Error).message, ...(err instanceof gitcli.GitError && err.gitStatus ? { status: err.gitStatus } : {}) });
        return true;
      }
    }
    if (id && rest[2] === 'terminal' && rest.length === 3 && m === 'POST') {
      const p = reg.getProject(id);
      if (!p) return notFound(res, `terminal: no project ${JSON.stringify(id)}`);
      try {
        sendJson(res, 200, await gitcli.openTerminal(p.hostPath));
      } catch (err) {
        sendJson(res, err instanceof gitcli.GitError ? err.status : 500, { error: (err as Error).message });
      }
      return true;
    }

    /*
     * FEAT-108 round 2 — the runtime git-write grant, per project.
     *   GET    /api/projects/:id/git-write-grant  → { grant, recentWrites }
     *   POST   /api/projects/:id/git-write-grant  → grant one occasion or a window
     *          body: { scope:'once'|'duration'|'permanent', minutes? }  (default: once)
     *          'permanent' (FEAT-164) writes the declared project setting instead
     *          of the memory map; it survives restarts until revoked.
     *   DELETE /api/projects/:id/git-write-grant  → revoke (timed AND permanent)
     * This is a USER action surface: the grant lives only in this host process's
     * memory (git-grant-store.mjs) and is consulted by the runtime's PreToolUse
     * git-write decision, so it lifts the block for a LIVE session with no
     * relaunch. It never lifts the mandatory leak gate (a granted commit/push is
     * still refused on a leak — see claude-runtime.ts / git-grant.mjs).
     */
    if (id && rest[2] === 'git-write-grant' && rest.length === 3) {
      const p = reg.getProject(id);
      if (!p) return notFound(res, `git-write-grant: no project ${JSON.stringify(id)}`);
      if (m === 'GET') {
        sendJson(res, 200, { projectId: p.id, grant: grantView(p.id), recentWrites: listGitWrites(p.id, 50) });
        return true;
      }
      if (m === 'POST') {
        const body = (await readBody(req)) as Record<string, unknown>;
        if (body.scope === 'permanent') {
          // FEAT-164 — an explicit, per-project, PERMANENT opt-in. Written once, to
          // the registry (the one owner); the store reads it per decision. Still
          // never lifts the leak gate. Only this user route writes it.
          reg.setGitWritePermanent(p.id, true, { via: 'dashboard' });
          const grant = grantView(p.id);
          console.warn(`[orchard] git-write PERMANENT grant SET for project ${p.id} (${p.name}) — no expiry until revoked; the leak gate still runs on every granted commit/push (FEAT-164).`);
          sendJson(res, 200, { ok: true, projectId: p.id, grant });
          return true;
        }
        const scope = body.scope === 'duration' ? 'duration' : 'once';
        const minutes = Number(body.minutes);
        const ttlMs = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60_000) : undefined;
        const grant = grantGitWrite(p.id, {
          scope,
          ttlMs,
          grantedVia: 'dashboard',
          note: typeof body.note === 'string' ? body.note : '',
        });
        // Visible, never silent: the server log records who was granted what.
        console.warn(`[orchard] git-write GRANTED for project ${p.id} (${p.name}) — scope=${grant.scope}, expires ${grant.expiresAt} (FEAT-108).`);
        sendJson(res, 200, { ok: true, projectId: p.id, grant });
        return true;
      }
      if (m === 'DELETE') {
        // One control revokes everything: the timed/single-use grant in memory AND
        // the permanent project setting (FEAT-164). Clearing the setting takes
        // effect on a running session's very next git write — nothing caches it.
        const hadPermanent = !!permanentGrantOf(p.id);
        if (hadPermanent) reg.setGitWritePermanent(p.id, false, { via: 'dashboard' });
        const hadTimed = revokeGitWrite(p.id);
        const had = hadPermanent || hadTimed;
        console.warn(`[orchard] git-write grant REVOKED for project ${p.id} (${p.name}) — ${had ? `was active (${[hadPermanent && 'permanent', hadTimed && 'timed'].filter(Boolean).join(' + ')})` : 'none active'} (FEAT-108/FEAT-164).`);
        sendJson(res, 200, { ok: true, projectId: p.id, revoked: had, grant: grantView(p.id) });
        return true;
      }
      return notFound(res, `git-write-grant: no route ${m} ${url.pathname}`);
    }

    /* processes: what is running FROM this project's directory */
    if (id && rest[2] === 'processes' && rest.length <= 4) {
      const p = reg.getProject(id);
      if (!p) return notFound(res, `processes: no project ${JSON.stringify(id)}`);
      try {
        if (m === 'GET' && rest.length === 3) {
          sendJson(res, 200, { processes: procs.listProjectProcesses(p.hostPath) });
          return true;
        }
        if (m === 'POST' && rest.length === 4) {
          const pid = Number(rest[3]);
          const body = (await readBody(req)) as Record<string, unknown>;
          sendJson(res, 200, procs.killProjectProcess(p.hostPath, pid, body.signal === 'KILL' ? 'KILL' : 'TERM'));
          return true;
        }
      } catch (err) {
        sendJson(res, err instanceof procs.ProcessError ? err.status : 500, { error: (err as Error).message });
        return true;
      }
    }

    /* memories: list / read / delete — see memories.ts for the discipline */
    if (id && rest[2] === 'memories' && rest.length <= 3) {
      const p = reg.getProject(id);
      if (!p) return notFound(res, `memories: no project ${JSON.stringify(id)}`);
      const { dirs } = sessionsForProject(p);
      // The project's own encoded dir always counts, even with no sessions yet:
      // memory can exist before any transcript does.
      const own = hist.encodeCwd(p.hostPath);
      if (!dirs.includes(own)) dirs.push(own);
      // FEAT-155 — likewise the project's own DECLARED container store: its
      // `memory/` exists independently of transcripts (e.g. after every session
      // was deleted), and sessionsForProject only adds the dir when it lists one.
      const ownStore = cm.containerStoreDirName(p);
      if (!dirs.includes(ownStore)) dirs.push(ownStore);
      try {
        if (m === 'GET' && !url.searchParams.get('name')) {
          sendJson(res, 200, { dirs, memories: mem.listMemories(dirs) });
          return true;
        }
        const dir = url.searchParams.get('dir') ?? '';
        const name = url.searchParams.get('name') ?? '';
        if (!dirs.includes(dir)) {
          sendJson(res, 400, { error: `memories: dir ${JSON.stringify(dir)} does not belong to this project` });
          return true;
        }
        if (m === 'GET') {
          sendJson(res, 200, { dir, name, ...mem.readMemory(dir, name) });
          return true;
        }
        if (m === 'DELETE') {
          sendJson(res, 200, mem.deleteMemory(dir, name));
          return true;
        }
      } catch (err) {
        const status = err instanceof mem.MemoryError ? err.status : 500;
        sendJson(res, status, { error: (err as Error).message });
        return true;
      }
    }
    /*
     * FEAT-157 — Orchard base releases for one project.
     *   GET  /api/projects/:id/base          → { notice, pin, target, observed, releases }
     *   POST /api/projects/:id/base-update   { action: adopt|defer|skip|dismiss|pin-dev, version?, rev }
     * The POST is the rail's (the user's). It names the notice revision it was
     * shown and is refused (409) when that is stale; the security floor and who
     * may do what are `base-releases.ts` `applyAction`'s. The pin it writes is the
     * DESIRED base; the container moves at its next launch with no live session.
     */
    if (id && rest[2] === 'base' && rest.length === 3 && m === 'GET') {
      const p = reg.getProject(id);
      if (!p) return notFound(res, `base: no project ${JSON.stringify(id)}`);
      sendJson(res, 200, baseStatusOf(p));
      return true;
    }
    if (id && rest[2] === 'base-update' && rest.length === 3 && m === 'POST') {
      const p = reg.getProject(id);
      if (!p) return notFound(res, `base-update: no project ${JSON.stringify(id)}`);
      return handleBaseUpdate(req, res, p, 'user');
    }
    /* board: the opt-in per-project docs/bugs/ surface, read for the Needs-You
       rail. A project without docs/bugs/ returns an empty board, never a 404 —
       "no board" is a valid state, not an error (FEAT-018). */
    if (id && rest[2] === 'board' && rest.length <= 4) {
      const p = reg.getProject(id);
      if (!p) return notFound(res, `board: no project ${JSON.stringify(id)}`);
      const action = rest[3];
      try {
        if (m === 'GET' && !action) {
          const b = board.readBoard(p.hostPath);
          // FEAT-029: runtime-raised decision records are the OTHER source of
          // Needs-You cards. Merge the project's open decisions in FRONT of the
          // board 👤 tickets — a live session waiting on the user outranks a
          // standing board item — so both flow through the one rail. A project
          // with no docs/bugs/ still surfaces its decisions (hasBoard flips true
          // the moment there is anything the user must answer).
          const open = decisions.listOpenForProject(id).map((d): board.BoardItem => ({
            id: d.id,
            title: d.question,
            owner: '\u{1F464}',
            status: 'open',
            sev: '',
            kind: 'decision',
            question: d.question,
            options: d.options,
            // FEAT-108 r3 — a git-write permission request rides the same rail;
            // the marker tells the client to render Allow/Decline in context.
            gitWrite: d.gitWrite ?? null,
            // FEAT-112 — a service-sidecar proposal rides the same rail too.
            services: d.services
              ? { services: d.services.services.map((s) => ({ name: s.name, image: s.image })), reason: d.services.reason }
              : null,
          }));
          if (open.length) {
            b.needsYou = [...open, ...b.needsYou];
            b.hasBoard = true;
          }
          // FEAT-157 — Orchard's base-update notice, DERIVED here from the release
          // catalog + this project's pin + what its container runs (never stored,
          // never raised by a session). Leads the rail: it is Orchard asking.
          const baseItem = baseRailItem(p);
          if (baseItem) {
            b.needsYou = [baseItem, ...b.needsYou];
            b.hasBoard = true;
          }
          // FEAT-047/079: WA consolidation needs-human findings (boot +
          // post-capture passes persist them to
          // $METHODOLOGY_DIR/.station/needs-human.json) surface as read-only
          // rows — but ONLY on the methodology's HOME project (this repo: the
          // consolidation tooling and the docs/prompts mirror live here), so they
          // don't spam every project's rail. FEAT-079: they are standing
          // attention, NOT asks — so they land in the read-only OBSERVATIONS lane,
          // never the decision rail (WA §H). The lone exception is a finding that
          // carries a concrete ask (`findingIsAsk` — the promotion seam): that one
          // is a real decision and rejoins `needsYou`.
          b.observations = b.observations ?? [];
          if (path.resolve(p.hostPath) === projectRoot()) {
            const findings = board.consolidationFindings(methodologyDir());
            if (findings.length) {
              for (const f of findings) (board.findingIsAsk(f) ? b.needsYou : b.observations).push(f);
              b.hasBoard = true;
            }
          }
          // FEAT-056/079: architecture-recurrence findings are PER PROJECT (a
          // cluster in project B belongs on project B's rail), so — unlike the
          // methodology findings above — every project surfaces its own, read
          // from its own docs/bugs/.arch/findings.json. Same split: a bare
          // recurrence count is an Observation; only a promoted decision is a
          // needsYou ask.
          const archFindings = board.archRecurrenceFindings(p.hostPath);
          if (archFindings.length) {
            for (const f of archFindings) (board.findingIsAsk(f) ? b.needsYou : b.observations).push(f);
            b.hasBoard = true;
          }
          /*
           * BUG-046 — a work row stalled past the SECOND window (stalls.ts
           * STALL_ESCALATE_MS) surfaces as an advisory Needs-You card. Computed
           * fresh from each live session's running snapshot on every read:
           * nothing is persisted, so a row that recovers (or ends) simply stops
           * producing the card — no residue, nothing to dismiss. ARCH-002:
           * evidence-carrying and ADVISORY — the card asks a human to look; the
           * server never kills, settles or re-dispatches anything from it.
           */
          try {
            const stallCards: board.BoardItem[] = [];
            for (const s of liveSessionsForProject(id)) {
              if (s.closed) continue;
              const snap = s.runningSnapshot();
              for (const r of snap.running) {
                if (r.state !== 'stalled' || !r.stall || !stallEscalated(r.stall)) continue;
                stallCards.push({
                  id: `stall-${s.id}-${r.id}`,
                  title: `⚠ stalled: ${r.label}${r.description ? ` — ${r.description}` : ''} `
                    + `(no progress for ${Math.round(r.stall.stalledForMs / 60000)}m)`,
                  owner: '⚠',
                  status: 'stalled',
                  sev: '',
                  kind: 'stall',
                  detail: `${r.stall.checked} — advisory: the station never kills work on this evidence; check the process yourself before acting.`,
                });
              }
            }
            if (stallCards.length) {
              b.needsYou = [...b.needsYou, ...stallCards];
              b.hasBoard = true;
            }
          } catch { /* the stall surface must never break the board read */ }
          // FEAT-067: attach the rail's status summary LAST — after every merge
          // above — so its `focus` and counts reflect the exact lists the rail
          // will render (needsYou = decisions/asks/stalls; observations =
          // read-only findings, FEAT-079). Pure
          // + derived on every GET: the card is an index over live sections, so
          // it cannot drift from them (BUG-041/074 — an observability surface
          // must not lie). Nothing is stored; the next poll recomputes it.
          // FEAT-157 (attack round 1, c): the id base:<project> is Orchard's derived notice alone; no other row may carry it.
          b.needsYou = b.needsYou.filter((x) => !String(x.id).startsWith('base:') || !!x.baseUpdate);
          if (b.observations) b.observations = b.observations.filter((x) => !String(x.id).startsWith('base:'));
          b.summary = board.boardSummary(b);
          sendJson(res, 200, b);
          return true;
        }
        if (m === 'POST' && action === 'dismiss') {
          // FEAT-047: acknowledge a consolidation finding. Records {id → the
          // finding's current date} beside the findings JSON, so the row stays
          // gone (across reloads and while the finding merely persists) until a
          // LATER pass re-detects it with a newer date. Only meaningful on the
          // methodology-home project — same scoping as the rows themselves.
          const body = (await readBody(req)) as Record<string, unknown>;
          const findingId = String(body.id ?? '').trim();
          if (!findingId) { sendJson(res, 400, { error: 'dismiss requires a finding id' }); return true; }
          // FEAT-056: an architecture-recurrence finding is the PROJECT's own —
          // dismiss it against that project's board, on any project. Everything
          // else is a methodology (FEAT-047) finding and stays home-scoped.
          if (board.isArchFindingId(findingId)) {
            board.dismissArchFinding(p.hostPath, findingId);
            sendJson(res, 200, { ok: true, id: findingId });
            return true;
          }
          if (path.resolve(p.hostPath) !== projectRoot()) {
            sendJson(res, 400, { error: 'dismiss: consolidation findings only surface on the methodology-home project' });
            return true;
          }
          board.dismissConsolidationFinding(methodologyDir(), findingId);
          sendJson(res, 200, { ok: true, id: findingId });
          return true;
        }
        if (m === 'POST' && action === 'answer') {
          const body = (await readBody(req)) as Record<string, unknown>;
          const ticketId = String(body.id ?? '').trim();
          const answer = String(body.answer ?? '');
          if (!ticketId) { sendJson(res, 400, { error: 'answer requires a ticket id' }); return true; }
          if (!answer.trim()) { sendJson(res, 400, { error: 'answer text is empty' }); return true; }
          // FEAT-157 — a base-update notice is answered ONLY through its own route, which
          // names the notice revision and enforces the security floor. Never through here.
          if (ticketId.startsWith('base:')) {
            sendJson(res, 409, { error: 'a base-update notice is answered with POST /api/projects/:id/base-update { action, version, rev } (the rail\'s Adopt / Defer / Skip), not the generic answer route', code: 'use-base-update' });
            return true;
          }
          // FEAT-029: a runtime-raised decision record answers differently from a
          // board ticket — deliver the answer back to the SPECIFIC session that
          // raised it (never a ticket file), then resolve the record so it leaves
          // the rail. If that session is gone, the answer is still recorded.
          const rec = decisions.get(ticketId);
          if (rec && rec.projectId === id) {
            // FEAT-164 r2 — an approval that MINTS authority (a git-write grant, a
            // services write) is answered once. Re-answering a resolved record used
            // to re-run the mint, so replaying one past "Allow" re-issued a grant
            // the user had since revoked or spent. Refuse, and change nothing.
            if (rec.resolved && (rec.gitWrite || rec.services)) {
              sendJson(res, 409, { error: `decision ${ticketId} was already answered; an approval is honoured once`, code: 'already-answered' });
              return true;
            }
            // FEAT-108 r3 — a git-write REQUEST is a decision that carries a
            // gitWrite payload. Approving it (answer begins "Allow") is the ONE
            // user action that mints a runtime grant: the request route that
            // created this record minted nothing, so an agent that raised the
            // request cannot grant itself — it can only produce inert pending
            // records until a human acts HERE. (An agent curling this route is
            // the same pre-existing no-auth residual that already lets it curl
            // the grant route directly; folding the mint in here does not add a
            // new class of exposure. Declining, or any non-"Allow" answer, mints
            // nothing.) The mandatory leak gate on a permitted commit/push is
            // untouched — a grant never lifts it (git-grant.mjs).
            if (rec.gitWrite) {
              if (/^allow\b/i.test(answer.trim())) {
                const mins = rec.gitWrite.minutes;
                const ttlMs = typeof mins === 'number' && mins > 0 ? Math.round(mins * 60_000) : undefined;
                const grant = grantGitWrite(id, {
                  scope: rec.gitWrite.scope,
                  ttlMs,
                  grantedVia: 'request-approval',
                  note: rec.gitWrite.reason,
                });
                console.warn(`[orchard] git-write GRANTED via request approval for project ${id} — scope=${grant.scope}, expires ${grant.expiresAt} (FEAT-108).`);
              } else {
                console.warn(`[orchard] git-write request ${ticketId} DECLINED for project ${id} — no grant minted (FEAT-108).`);
              }
            }
            // FEAT-112 — a services PROPOSAL. Approving it (answer begins "Allow")
            // is the ONE action that writes the proposed services into the
            // project; the request route wrote nothing, so a proposing agent
            // cannot apply its own proposal. The services take effect on the next
            // session start / container ensure (consistent with the drift model:
            // a live container keeps its config until rebuilt). Declining writes
            // nothing.
            if (rec.services) {
              if (/^allow\b/i.test(answer.trim())) {
                try {
                  const patch = validateProjectPatch({ settings: { services: rec.services.services } });
                  reg.updateProject(id, patch);
                  console.warn(`[orchard] services APPLIED via proposal approval for project ${id} — ${rec.services.services.map((s) => s.name).join(', ')} (FEAT-112). Effective next session start.`);
                } catch (err) {
                  console.warn(`[orchard] services proposal ${ticketId} approved but could not be applied: ${(err as Error).message}`);
                }
              } else {
                console.warn(`[orchard] services proposal ${ticketId} DECLINED for project ${id} — no settings written (FEAT-112).`);
              }
            }
            const target =
              (getSession(rec.sessionId) && !getSession(rec.sessionId)!.closed ? getSession(rec.sessionId) : null) ??
              liveSessions().find((s) => !s.closed && s.sdkSessionId && s.sdkSessionId === rec.sdkSessionId) ??
              null;
            let delivered = false;
            let deliverError: string | null = null;
            if (target) {
              try { target.send(answer); delivered = true; }
              catch (err) { deliverError = (err as Error).message; }
            }
            decisions.resolve(ticketId, answer, delivered);
            sendJson(res, 200, { ok: true, id: ticketId, kind: 'decision', delivered, deliverError });
            return true;
          }
          // FEAT-090: answering a TICKET records the decision and hands it back
          // to an agent via the BOARD (the answered-awaiting lane + the launch
          // snapshot / the open-session briefing) — it never dispatches. The old
          // "find an idle live session and send the raw answer into it" auto-start
          // was removed (the user explicitly ruled it out): recording a decision is
          // not the same act as starting work, and work begins only when the user
          // says go. (A live session genuinely BLOCKED on a reply it asked for is
          // the kind:'decision' branch above — that is a reply, not a dispatch.)
          // FEAT-166 r3 — the rail carries no rev, so it names the decision it was
          // SHOWN (BoardItem.decisionKey). Missing or changed → 409: an answer
          // composed for an earlier decision never binds to a newer one.
          const shown = typeof body.decisionKey === 'string' ? body.decisionKey : null;
          if (!shown) {
            sendJson(res, 409, { error: 'this answer does not name the decision it answers — reload the board and answer the current question' });
            return true;
          }
          let file: string;
          try {
            file = board.appendAnswer(p.hostPath, ticketId, answer, shown);
          } catch (err) {
            if (err instanceof board.StaleAnswerError) { sendJson(res, 409, { error: err.message }); return true; }
            throw err;
          }
          sendJson(res, 200, { ok: true, id: ticketId, file, dispatched: false });
          return true;
        }
        return notFound(res, `board: no route ${m} .../board/${action ?? ''}`);
      } catch (err) {
        sendJson(res, 400, { error: (err as Error).message });
        return true;
      }
    }
    /* ═══════════════ FEAT-058 — ticket dashboard (#/tickets, second tab) ═══
     *
     * The rail answers "what needs you NOW"; these routes are the FULL ARCHIVE
     * behind it — list, full-text search over ticket BODIES, the real file
     * markdown, and the four writes (note / reopen / 👤 flag / file new).
     *
     * Read routes mutate nothing. Every WRITE goes through src/server/tickets.ts,
     * which owns the append-only discipline, the `rev` freshness check (409 on a
     * concurrent agent edit — never a silent clobber) and the board tool's own
     * reconciliation, and reports `board.fails` so a write that would leave
     * `npm run board:check` red says so in its own response.
     */
    if (id && rest[2] === 'tickets' && rest.length <= 5) {
      const p = reg.getProject(id);
      if (!p) return notFound(res, `tickets: no project ${JSON.stringify(id)}`);
      const ticketId = rest[3];
      const action = rest[4];
      try {
        if (m === 'GET' && !ticketId) {
          const q = (url.searchParams.get('q') ?? '').trim();
          if (q) {
            const r = tickets.searchTickets(p.hostPath, q);
            sendJson(res, 200, { hasBoard: r.hasBoard, q, tickets: r.hits });
            return true;
          }
          sendJson(res, 200, tickets.listTickets(p.hostPath));
          return true;
        }
        if (m === 'POST' && !ticketId) {
          const body = (await readBody(req)) as Record<string, unknown>;
          sendJson(res, 200, tickets.createTicket(p.hostPath, {
            prefix: String(body.prefix ?? 'BUG'),
            title: String(body.title ?? ''),
            severity: body.severity === undefined ? undefined : String(body.severity),
            area: body.area === undefined ? undefined : String(body.area),
            summary: body.summary === undefined ? undefined : String(body.summary),
            needsYou: body.needsYou === true,
          }));
          return true;
        }
        if (m === 'GET' && ticketId && !action) {
          sendJson(res, 200, tickets.readTicket(p.hostPath, ticketId));
          return true;
        }
        if (m === 'POST' && ticketId && action) {
          const body = (await readBody(req)) as Record<string, unknown>;
          const rev = body.rev === undefined ? undefined : String(body.rev);
          if (action === 'note') {
            sendJson(res, 200, tickets.appendNote(p.hostPath, ticketId, String(body.text ?? ''), rev));
            return true;
          }
          if (action === 'reopen') {
            sendJson(res, 200, tickets.reopenTicket(p.hostPath, ticketId, String(body.reason ?? ''), rev));
            return true;
          }
          if (action === 'owner') {
            sendJson(res, 200, tickets.setNeedsYou(p.hostPath, ticketId, body.needsYou === true));
            return true;
          }
          if (action === 'answer') {
            // FEAT-090 — a user REPLY through the ticket view. Routed through the
            // tickets write layer (rev freshness gate + board reconciliation),
            // NOT board.appendAnswer. NO session code here: answering a ticket
            // records a decision (or hands ownership to the agent for a question/
            // counter) and starts nothing.
            const choseRaw = body.chose && typeof body.chose === 'object' ? body.chose as Record<string, unknown> : null;
            sendJson(res, 200, tickets.answerTicket(p.hostPath, ticketId, {
              kind: String(body.kind ?? 'decision') as tickets.ReplyKind,
              question: body.question === undefined ? null : String(body.question ?? ''),
              chose: choseRaw && choseRaw.key ? { key: String(choseRaw.key), label: String(choseRaw.label ?? '') } : null,
              note: body.note === undefined ? '' : String(body.note ?? ''),
              followup: body.followup === true,
            }, rev));
            return true;
          }
        }
        return notFound(res, `tickets: no route ${m} .../tickets/${[ticketId, action].filter(Boolean).join('/')}`);
      } catch (err) {
        // A freshness conflict must arrive as its own status with the current
        // rev attached — the client re-reads and shows what changed, instead of
        // being told "400" and guessing.
        const status = err instanceof tickets.TicketError ? err.status : 500;
        const rev = err instanceof tickets.TicketError ? err.rev : null;
        sendJson(res, status, { error: (err as Error).message, ...(rev ? { rev } : {}) });
        return true;
      }
    }
    if (id && rest.length === 2 && m === 'DELETE') {
      // Deleting only the registry row used to ORPHAN the project's container:
      // it stayed `Up` with the OAuth credentials bind-mounted rw, and because
      // every /container route 404s on an unknown project there was no API left
      // to stop it. Tear it down here, and refuse while sessions are live.
      const p = reg.getProject(id);
      if (!p) return notFound(res, `no project ${id}`);
      /*
       * ARCH-022: whether sessions hold the project is the lifecycle authority's lease set, decided inside
       * the delete OPERATION (the project's slot), which also deletes the registry row — so a launch queued
       * behind it finds no project, and one admitted before it is protected. No guard here decides anything.
       * ?force=1 = the leases live NOW (captured before their sessions are closed); later ones stay protected.
       */
      const force = url.searchParams.get('force') === '1';
      const forceOver = force ? lifecycle.leasesOf(id).map((l) => l.id) : undefined;
      const closed: string[] = [];
      if (force) {
        for (const s of liveSessionsForProject(id)) {
          closed.push(s.id);
          void s.close('project deleted').catch(() => {});
        }
      }
      // Same reasoning as the container: leaving a Chrome running for a project
      // that no longer exists is an orphan holding a logged-in profile.
      let browserStop: unknown = null;
      if (reg.browserSettingsOf(p).enabled && browser.available().ok) {
        try {
          browserStop = browser.stop(p);
        } catch (err) {
          browserStop = { error: (err as Error).message };
        }
      }
      let container: unknown = null;
      let buildState: unknown = null;
      let deleted = false;
      try {
        const r = await cm.deleteProjectResources(p, {
          container: p.isolation === 'container',
          current: () => reg.getProject(id),
          forceOver,
          commit: () => { deleted = reg.deleteProject(id); },
        });
        container = r.container;
        buildState = r.buildState;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'live-sessions' || code === 'project-gone' || code === 'lifecycle-uncertain') {
          sendJson(res, code === 'project-gone' ? 404 : 409, {
            error: (err as Error).message, code, deleted: false, closedSessions: closed, browser: browserStop, holders: lifecycle.describe(id).leases,
          });
          return true;
        }
        throw err;
      }
      // The session history under ~/.claude/projects/-workspace-<id> is the
      // user's own transcript data and is deliberately KEPT — reported, not deleted.
      sendJson(res, 200, {
        deleted,
        closedSessions: closed,
        container,
        buildState,
        browser: browserStop,
        keptSessionHistory: p.isolation === 'container' ? cm.containerHistoryDir(p) : null,
        // Same reasoning as the session history: these are restore points for a
        // directory that still exists on disk. Deleting the registry row is not
        // consent to destroy the user's only undo for it. Reported, not deleted.
        keptSnapshots: (() => {
          const u = snaps.usage(p.id);
          return u.count ? { ...u, dir: snaps.projectSnapshotDir(p.id) } : null;
        })(),
      });
      return true;
    }
    if (id && rest[2] === 'sessions' && m === 'GET') {
      const p = reg.getProject(id);
      if (!p) return notFound(res, `no project ${id}`);
      const { sessions, dirs } = sessionsForProject(p);
      // One stat per file, reusing the same window as /api/sessions/live so a
      // badge rendered from either source cannot disagree. Orchard-owned
      // (codex) transcripts are part of the same window (FEAT-037 P2b).
      const liveNow = new Set(
        [...watcher.liveSessions(), ...watcher.orchardLiveSessions()].map((s) => `${s.dir}\0${s.sessionId}`),
      );
      // Session provenance (who STARTED each row) for the picker's fold. Loaded
      // ONCE per request (not a read per row — BUG-158 keeps listing cheap); a
      // row with no record falls back to the conservative declaration-line test,
      // then to 'user'. Presentation only: the row, its transcript and its URL
      // are unaffected — the client just folds 'agent' rows out of the default view.
      const provenance = loadProvenanceMap();
      const isClosed = sessionClosed.closedReader(); // FEAT-168 — one store read per list; the ONE closed read (r6: derived, never written on reopen)
      sendJson(res, 200, {
        projectId: p.id,
        encodedDir: hist.encodeCwd(p.hostPath),
        dirs,
        sessions: sessions.map((s) => {
        /*
         * Custom title + pin come from the SAME read, so the sidebar can sort
         * pinned-first and badge "renamed" without a second request.
         *
         * `displayTitle` is overridden by the custom title when there is one:
         * session-history builds it from the model-generated `ai-title` only
         * (it predates renaming and is carried-over verified code, so it is not
         * modified here). `autoTitle` keeps the original summary alongside, so
         * the UI can show both and a rename never destroys what it replaced.
         */
        const tm = smut.readTitleMeta(s.filePath);
        return {
          live: liveNow.has(`${s.encodedDir}\0${s.sessionId}`),
          sessionId: s.sessionId,
          encodedDir: s.encodedDir,
          // Who started this session: 'user' or 'agent'. Explicit record wins;
          // else the conservative pre-existing fallback; else 'user'. The picker
          // folds non-live 'agent' rows by default (still reachable via "N more"/URL).
          startedBy: resolveStartedBy({
            sessionId: s.sessionId,
            firstUserMessage: s.firstUserMessage,
            record: provenance.get(s.sessionId),
          }),
          // Whether this row folds out of the DEFAULT nav list (server-owned, so
          // the client never re-derives it — ARCH-010). True for Orchard dispatch
          // lanes AND external programmatic sessions Orchard never launched (an
          // `sdk-cli`/`sdk-ts` transcript with no provenance record); false for
          // interactive `cli`, legacy no-entrypoint rows, and dashboard sessions
          // the user launched through Orchard. Presentation only — the transcript
          // and its URL are untouched, so a folded row still opens on a deep link.
          foldByDefault: foldsFromDefaultList({
            sessionId: s.sessionId,
            entrypoint: (s as { entrypoint?: string | null }).entrypoint ?? null,
            firstUserMessage: s.firstUserMessage,
            record: provenance.get(s.sessionId),
          }),
          // FEAT-037 P2b: which engine recorded this session. 'anthropic' for
          // the Claude store; Orchard-owned rows carry their provider dir.
          provider: (s as { provider?: string }).provider ?? 'anthropic',
          displayTitle: tm.customTitle ?? s.displayTitle,
          customTitle: tm.customTitle,
          autoTitle: tm.autoTitle ?? s.title,
          titleSource: smut.titleSourceOf(tm),
          // true = only the file's head+tail were scanned, so `titleSource`
          // 'unknown' means "not found in the window", not "not present".
          titleMetaSampled: tm.sampled,
          pinned: tm.pinned,
          closed: isClosed(s.sessionId, s.filePath), // FEAT-168 — closed iff this file's latest input prompt is the one recorded at close (session-closed.ts)
          tag: tm.tag,
          messageCount: s.messageCount,
          statsExact: s.statsExact,
          lastActivityAt: s.lastActivityAt,
          // The recency signal the sidebar ORDERS by: the last HUMAN submit,
          // not transcript mtime (which moves on agent output too). Null for
          // rows where no human prompt was found — the client falls back to
          // lastActivityAt.
          lastUserMessageAt: s.lastUserMessageAt,
          startedAt: s.startedAt,
          gitBranch: s.gitBranch,
          os: s.os,
          models: s.models,
          fileBytes: s.fileBytes,
        };
        }),
      });
      return true;
    }
  }

  /* processes summary: what runs where, for the ambient indicators */
  if (rest[0] === 'processes' && rest[1] === 'summary' && rest.length === 2 && m === 'GET') {
    sendJson(res, 200, { byProject: procs.summarize(reg.listProjects().map((p) => ({ id: p.id, hostPath: p.hostPath }))) });
    return true;
  }

  /* slash commands: the last list any session's CLI reported (persisted) */
  if (rest[0] === 'slash-commands' && rest.length === 1 && m === 'GET') {
    sendJson(res, 200, { commands: knownSlashCommands() });
    return true;
  }
  /* FEAT-116: provider rate-limit window usage, for the dispatch-now-vs-park
   * decision. Serves the CACHED per-provider snapshots and never awaits the
   * network — `getUsageSnapshots` revalidates in the background, so this route
   * cannot block a UI control (each snapshot carries its own `asOf`). */
  if (rest[0] === 'usage' && rest.length === 1 && m === 'GET') {
    sendJson(res, 200, { providers: providerUsage.getUsageSnapshots(), at: Date.now() });
    return true;
  }
  /* models: the CLI's own names/descriptions — versions included.
   * FEAT-045: per-provider — `?provider=openai` serves the Codex catalog
   * (`model/list`, remembered from that engine's sessions); no query keeps the
   * pre-045 contract byte-identical (the Claude list). */
  if (rest[0] === 'models' && rest.length === 1 && m === 'GET') {
    const provider = url.searchParams.get('provider') ?? 'anthropic';
    if (provider !== 'anthropic' && provider !== 'openai') {
      sendJson(res, 400, { error: `unknown provider ${JSON.stringify(provider)} — one of: anthropic, openai` });
      return true;
    }
    sendJson(res, 200, { models: knownModels(provider) });
    return true;
  }

  /*
   * FEAT-037 P3: provider availability, polled by the settings drawer when it
   * opens. Anthropic is the engine this server is built on (always offered);
   * OpenAI reports the LIVE detectCodex() verdict — connected / installed but
   * not signed in (hint: `codex login`) / not installed (hint: install, see
   * docs/PROVIDERS.md) — so the picker can mark an unusable choice honestly
   * instead of letting the launch be the first place the user learns.
   */
  if (rest[0] === 'providers' && rest.length === 1 && m === 'GET') {
    sendJson(res, 200, {
      providers: {
        anthropic: { status: 'connected', label: 'Claude (Anthropic) — default engine' },
        openai: detectCodex(),
      },
    });
    return true;
  }

  /*
   * FEAT-118 — app-wide (global) defaults. The GET is what the settings surface
   * reads to show the current global default and to seed its picker; the PATCH
   * writes a partial change (a field absent is left as-is, an explicit null
   * clears it). The merge under each project happens in pickOverridable, not
   * here — this route only owns the global layer itself.
   */
  if (rest[0] === 'settings' && rest.length === 1 && m === 'GET') {
    sendJson(res, 200, { settings: readGlobalDefaults() });
    return true;
  }
  if (rest[0] === 'settings' && rest.length === 1 && m === 'PATCH') {
    const body = await readBody(req);
    const result = patchGlobalDefaults(body);
    if (!result.ok) {
      sendJson(res, 400, { error: result.error });
      return true;
    }
    sendJson(res, 200, { settings: result.value });
    return true;
  }

  /*
   * FEAT-145 step 2 — the Claude account registry. The GET lists accounts with
   * the implicit default FIRST (synthesised, never a row on disk); the POST
   * takes a free-text `label`, mints an opaque id, materialises the overlay dir
   * (symlinks `projects`/`settings.json` into ~/.claude) and returns the new
   * row as `state:'pending'` (login is a later step); the DELETE removes a row
   * and moves its dir aside, refusing the default. `resolveAccountDir` is the
   * one id→dir authority (ARCH-010); this route never derives a dir itself.
   */
  if (rest[0] === 'claude-accounts' && rest.length === 1 && m === 'GET') {
    sendJson(res, 200, { accounts: listAccounts() });
    return true;
  }
  if (rest[0] === 'claude-accounts' && rest.length === 1 && m === 'POST') {
    const body = await readBody(req);
    const label = body && typeof body === 'object' ? (body as Record<string, unknown>).label : undefined;
    try {
      const row = createAccount(label);
      sendJson(res, 201, { account: row });
    } catch (err) {
      const status = err instanceof AccountError ? err.status : 500;
      sendJson(res, status, { error: (err as Error).message });
    }
    return true;
  }
  if (rest[0] === 'claude-accounts' && rest.length === 2 && m === 'DELETE') {
    try {
      const result = deleteAccount(rest[1]);
      sendJson(res, 200, result);
    } catch (err) {
      const status = err instanceof AccountError ? err.status : 500;
      sendJson(res, status, { error: (err as Error).message });
    }
    return true;
  }

  /* filesystem: directory listing for the add-project browser */
  if (rest[0] === 'fs' && rest[1] === 'dirs' && rest.length === 2 && m === 'GET') {
    let p = url.searchParams.get('path')?.trim() || os.homedir();
    if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
    p = path.resolve(p);
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      return notFound(res, `fs/dirs: ${JSON.stringify(p)} does not exist`);
    }
    if (!st.isDirectory()) {
      sendJson(res, 400, { error: `fs/dirs: ${JSON.stringify(p)} is not a directory` });
      return true;
    }
    const registered = new Set(reg.listProjects().map((x) => x.hostPath));
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch (err) {
      sendJson(res, 403, { error: `fs/dirs: cannot read ${JSON.stringify(p)}: ${(err as Error).message}` });
      return true;
    }
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 500)
      .map((e) => {
        const full = path.join(p, e.name);
        let hasGit = false;
        try { hasGit = fs.existsSync(path.join(full, '.git')); } catch { /* unreadable child */ }
        return { name: e.name, path: full, hasGit, alreadyRegistered: registered.has(full) };
      });
    const parent = path.dirname(p);
    sendJson(res, 200, { path: p, parent: parent !== p ? parent : null, dirs, alreadyRegistered: registered.has(p) });
    return true;
  }

  /* search */
  if (rest[0] === 'search' && rest.length === 1 && m === 'GET') {
    const q = (url.searchParams.get('q') ?? '').trim();
    if (q.length < 2) {
      sendJson(res, 400, { error: 'search: q must be at least 2 characters' });
      return true;
    }
    const projectId = url.searchParams.get('project');
    let projects = reg.listProjects();
    if (projectId) {
      const p = projects.find((x) => x.id === projectId);
      if (!p) return notFound(res, `search: no project ${JSON.stringify(projectId)}`);
      projects = [p];
    }
    const searchAbort = new AbortController();
    const abandonSearch = () => searchAbort.abort();
    req.once('aborted', abandonSearch);
    res.once('close', abandonSearch);
    /*
     * Debounced typing sends a request per pause and abandons the one before
     * it. The store walk below is SYNCHRONOUS and, on a large store, costs far
     * more than the rg scan itself — so a superseded request that pays for it
     * anyway blocks the loop and pushes the live query seconds into the future.
     * Yield to the poll phase first (a timer, not setImmediate — setImmediate
     * runs before the socket reads that carry the disconnect): an abandoned
     * request then learns it is abandoned and walks nothing. Measured on a
     * 993-session store, this took a slow typist's wait from 9.6s to 2.4s.
     */
    await new Promise<void>((r) => setTimeout(r, 0));
    if (searchAbort.signal.aborted || res.destroyed) {
      req.off('aborted', abandonSearch);
      res.off('close', abandonSearch);
      return true;
    }
    // Every store dir belonging to a registered project, deduped, with an
    // owner map so each hit can name the project it belongs to.
    const searchTargets: search.SearchTarget[] = [];
    const hitOwner = new Map<string, string>();
    const seenSearchFiles = new Set<string>();
    for (const p of projects) {
      const listed = sessionsForProject(p);
      for (const s of listed.sessions) {
        if (!s.filePath) continue;
        const resolved = path.resolve(s.filePath);
        if (!seenSearchFiles.has(resolved)) {
          seenSearchFiles.add(resolved);
          searchTargets.push({ path: resolved, encodedDir: s.encodedDir, sessionId: s.sessionId, format: (s as any).native ? 'codex-rollout' : 'claude' });
        }
        hitOwner.set(`${s.encodedDir}\0${s.sessionId}`, p.id);
      }
    }
    try {
      const r = await search.searchStore(q, searchTargets, { signal: searchAbort.signal });
      if (searchAbort.signal.aborted || res.destroyed) return true;
      sendJson(res, 200, {
        ...r,
        hits: r.hits.map((h) => ({
          ...h,
          projectId: hitOwner.get(`${h.encodedDir}\0${h.sessionId}`) ?? null,
          os: /^[A-Za-z]--/.test(h.encodedDir) ? 'windows' : 'linux',
        })),
      });
    } catch (err) {
      // rg missing is an environment fact the UI must state, not an empty list.
      sendJson(res, 500, { error: `search failed: ${(err as Error).message}` });
    } finally {
      req.off('aborted', abandonSearch);
      res.off('close', abandonSearch);
    }
    return true;
  }
  if (rest[0] === 'search' && rest[1] === 'locate' && rest.length === 2 && m === 'GET') {
    const dir = url.searchParams.get('dir') ?? '';
    const sessionId = url.searchParams.get('sessionId') ?? '';
    // intParam THROWS on a non-numeric ?line (e.g. "abc") — must be inside this
    // try/catch, mirroring the transcript route below, so a malformed client
    // param yields a clean 400 rather than falling through to the top-level
    // handler's 500 (BUG-012).
    let line: number;
    try {
      line = intParam(url.searchParams.get('line'), 0, 1, Number.MAX_SAFE_INTEGER);
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message });
      return true;
    }
    if (!dir || !sessionId || !line) {
      sendJson(res, 400, { error: 'search/locate: dir, sessionId and line are required' });
      return true;
    }
    const file = hist.resolveSessionFile(dir, sessionId) ?? ot.resolveOrchardSessionFile(dir, sessionId)?.filePath ?? null;
    const native = file ? null : cn.findRolloutBySessionId(sessionId);
    if (!file && !native) return notFound(res, `search/locate: no session file for ${JSON.stringify(dir)}/${JSON.stringify(sessionId)}`);
    if (native && cn.readRolloutHead(native).cwd && hist.encodeCwd(cn.readRolloutHead(native).cwd as string) !== dir) {
      return notFound(res, `search/locate: no session file for ${JSON.stringify(dir)}/${JSON.stringify(sessionId)}`);
    }
    const loc = native ? await search.locateCodex(native, line) : await search.locate(file as string, line);
    if (!loc) {
      // The file shrank since the search ran — an honest 410, not a guess.
      sendJson(res, 410, { error: 'search/locate: the matched line no longer exists in this file' });
      return true;
    }
    sendJson(res, 200, loc);
    return true;
  }

  /* transcripts */
  /*
   * FEAT-132 — GET /api/session-config/<sessionId>
   *
   * The session-configuration record persisted at launch (session-config.ts):
   * which docs were injected, which were TRUNCATED (BUG-146) or missing, the
   * composition mode, model, tools and MCP set. Keyed by the engine's session id
   * (the same id the transcript route uses), so the transcript view reads it for
   * ANY session — live or long finished — not just one this server still holds
   * in memory (the live effective-config route below is memory-only). A 404 is a
   * KNOWN state: the session predates this feature, and the UI shows a
   * clearly-labelled partial card rather than one implying full knowledge.
   */
  if (rest[0] === 'session-config' && rest.length === 2 && m === 'GET') {
    const rec = readSessionConfig(rest[1]!);
    if (!rec) return notFound(res, `no configuration record for session ${JSON.stringify(rest[1])}`);
    sendJson(res, 200, rec);
    return true;
  }

  if (rest[0] === 'transcript' && rest.length === 3 && m === 'GET') {
    const [, encodedDir, sessionId] = rest as [string, string, string];
    try {
      // Claude store first, then the Orchard-owned transcript store (FEAT-037
      // P2b — engines with persistedTranscript:false). Same entry shapes, so
      // tail/forward/count below serve both identically.
      const claudeFile = hist.resolveSessionFile(encodedDir, sessionId);
      /*
       * FEAT-144 — opportunistically mirror the live Claude store into Orchard's
       * durable copy on read, so a session viewed after a server restart (whose
       * final turn the turn-end hook missed) or one predating this feature is
       * captured before the CLI prunes it. Idempotent + stat-gated inside
       * mirrorClaudeStore, and only while the authoritative CLI file still exists;
       * a read must never fail because the mirror did.
       */
      if (claudeFile) {
        try { ot.mirrorClaudeStore(encodedDir, sessionId); } catch { /* mirror is best-effort */ }
      }
      let file = claudeFile ?? ot.resolveOrchardSessionFile(encodedDir, sessionId)?.filePath;
      /*
       * FEAT-078 — a NATIVE codex session has no file in either store until it
       * is opened. Backfill it into the Orchard transcript store now (bounded to
       * this encodedDir so a mismatched id cannot write elsewhere); every read
       * below then serves it identically to an Orchard-run codex session.
       */
      if (!file) {
        const imported = cn.importNativeCodexSession(sessionId, { expectedEncodedDir: encodedDir });
        if (imported) file = imported.filePath;
      }
      if (!file) return notFound(res, `session-history: no session file for ${JSON.stringify(encodedDir)}/${JSON.stringify(sessionId)}`);
      const includeToolResults = url.searchParams.get('tools') === '1';
      const tailParam = url.searchParams.get('tail');

      /*
       * ?tail=N — the last N messages, by scanning BACKWARD from EOF.
       *
       * This is the fix for the 286 MB session whose newest month of history was
       * unreachable at any ?offset: readSession scans forward from byte 0 and
       * gives up at 128 MiB. A backward scan is O(N) in messages and never
       * touches the bytes it does not need.
       */
      if (tailParam !== null) {
        const n = intParam(tailParam, 100, 1, 2000);
        const t0 = Date.now();
        // CANONICAL SPACE = renderable-filtered (requireRenderable defaults true),
        // shared by tail, forward and count so an index means the same message
        // in all three. Historical note: this briefly used requireRenderable:false
        // to match readSession's 916-entry space — which made the main route
        // disagree with the subagent route about what "a message" is and listed
        // empty bubbles. Renderable is what the client actually shows.
        const counted = tx.countMessages(file, { includeToolResults });
        /*
         * ?before=K — page BACKWARD: the N messages ending just before absolute
         * index K. This is scroll-up on files ?offset cannot reach: skip the
         * (total-K) newest messages, then collect N, all in one backward scan.
         * Absent, ?tail is the plain newest-N.
         */
        /*
         * Two ways to page up, both in canonical space:
         *  - ?beforeBytes=C&before=K  — EFFICIENT: resume the backward scan at
         *    the byte cursor `cursorBytes` a previous page returned, O(page size)
         *    at any depth. `before` (K) is that page's `offset`, so the new block
         *    indexes as [K - len, K).
         *  - ?before=K alone          — skip (total-K) from EOF; correct but
         *    re-reads from the end, so bytes grow with depth. Use it only for the
         *    first jump when no cursor is held.
         */
        const beforeParam = url.searchParams.get('before');
        const beforeBytesParam = url.searchParams.get('beforeBytes');
        // BUG-190: clamp to the real end. The block is labelled [before - len, before), so an
        // unclamped `before` past the end relabelled the newest messages with indices that do
        // not exist (before=123 on a 3-message file answered 120..122). Only when the count is
        // exact — a lower-bound total on a huge file cannot say where the end is.
        const before = beforeParam !== null ? intParam(beforeParam, counted.total, 0, counted.isLowerBound ? Number.MAX_SAFE_INTEGER : counted.total) : counted.total;
        const maxTextChars = intParam(url.searchParams.get('maxTextChars'), 4000, 0, 200_000);
        const r = beforeBytesParam !== null
          ? tx.tailMessages(file, { limit: n, startByte: intParam(beforeBytesParam, fs.statSync(file).size, 0, Number.MAX_SAFE_INTEGER), includeToolResults, maxTextChars })
          : tx.tailMessages(file, { limit: n, skip: Math.max(0, counted.total - before), includeToolResults, maxTextChars });
        // The collected block sits at [before - len, before) in canonical space.
        const base = Math.max(0, before - r.messages.length);
        r.messages.forEach((m, i) => { m.index = base + i; });
        sendJson(res, 200, {
          sessionId, encodedDir, filePath: file,
          messages: r.messages,
          mode: 'tail',
          // BUG-196 — the engine this session's next turn WILL resume on, from the
          // single owner of that fact (resumeProviderOf, the exact resolver
          // agent-bridge P2b applies). The UI reads this so its per-session
          // provider indicator shows the real engine and the selector can refuse a
          // switch the resume would silently ignore — never re-deriving it from the
          // project setting or a stale per-session override (ARCH-010).
          lockedProvider: ot.resumeProviderOf([encodedDir], sessionId),
          offset: base,
          before,
          cursorBytes: r.blockStartByte, // feed back as ?beforeBytes for the next page
          total: counted.total,
          totalIsLowerBound: counted.isLowerBound,
          hasMore: base > 0, // older history still exists before this block
          scannedMessages: counted.total,
          bytesRead: r.bytesRead,
          fileBytes: r.fileBytes,
          budgetExhausted: r.budgetExhausted,
          malformedLines: r.malformedLines,
          // Failed quality gates (hook_non_blocking_error) rolled up over the
          // WHOLE session by the same count scan — a gate that never ran is
          // otherwise invisible on every turn (BUG-177).
          hookErrors: counted.hookErrors,
          warnings: r.budgetExhausted ? [`tail scan stopped at its byte ceiling before collecting ${n} messages`] : [],
          tookMs: Date.now() - t0,
        });
        return true;
      }

      /*
       * Forward page in the SAME canonical (renderable) space as ?tail — via our
       * own reader, not readSession, which counted a different population. Parsed
       * with intParam (NaN used to slip past the clamp and dump the whole file).
       */
      const offset = intParam(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
      const limit = intParam(url.searchParams.get('limit'), 300, 1, 1000);
      const t = tx.readForward(file, { offset, limit, includeToolResults, maxTextChars: intParam(url.searchParams.get('maxTextChars'), 4000, 0, 200_000) });
      const counted = tx.countMessages(file, { includeToolResults });
      // The forward budget caps how far into a huge file paging can reach; the
      // count does a full pass, so total is exact and larger. Say exactly how
      // many newest messages are ONLY reachable via ?tail — never imply the page
      // reached the end when it hit the budget.
      const reachable = t.budgetExhausted ? t.scannedMessages : counted.total;
      sendJson(res, 200, {
        sessionId, encodedDir, filePath: file,
        messages: t.messages,
        mode: 'page',
        // BUG-196 — see the tail branch: the transcript-owned resume engine, so
        // every page of a session carries the same locked-provider fact.
        lockedProvider: ot.resumeProviderOf([encodedDir], sessionId),
        offset: t.offset,
        total: counted.total,
        totalIsLowerBound: counted.isLowerBound,
        scannedMessages: t.scannedMessages,
        hasMore: t.offset + t.messages.length < reachable,
        budgetExhausted: t.budgetExhausted,
        bytesRead: t.bytesRead,
        fileBytes: t.fileBytes,
        malformedLines: t.malformedLines,
        warnings: t.budgetExhausted ? [`forward scan stopped at its 128 MiB budget; the newest ${Math.max(0, counted.total - reachable)} messages are reachable only via ?tail`] : [],
        forwardReachableMessages: reachable,
        unreachableForward: t.budgetExhausted ? Math.max(0, counted.total - reachable) : 0,
        // Session-wide failed-gate roll-up (BUG-177), same as the tail branch.
        hookErrors: counted.hookErrors,
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.startsWith('expected an integer')) {
        sendJson(res, 400, { error: msg });
        return true;
      }
      return notFound(res, msg);
    }
    return true;
  }

  /*
   * Live session introspection. `stationSessionId` comes back on the `start` ack.
   * This is the same object the `effective-config` event carries — served over
   * HTTP too so the drawer can re-read it without replaying the event stream.
   */
  /*
   * GET /api/sessions/live[?windowMs=]
   *
   * Sessions being written RIGHT NOW, anywhere in the store. Cheap enough to
   * poll (one readdir per store dir + one stat per .jsonl) and it is the same
   * signal the `live` field on the project-sessions response uses, so a badge
   * from either source agrees.
   */
  /*
   * BUG-217 round 5 — THE SESSION OUTBOX (src/server/outbox.ts). A queued
   * message is a row the server mints and persists; a tab only renders it and
   * asks for edit / discard / send by the server's id.
   *
   *   GET  /api/outbox?session=<id>                        → { sessionId, rows, hold, damaged }
   *   POST /api/outbox { session, dir, project, nonce, text, origin?, initial?, reason?, overrides?, templateIds?, legacyId? }
   *   POST /api/outbox/edit    { session, id, text }
   *   POST /api/outbox/discard { session, id }
   *   POST /api/outbox/send    { session, id, interrupt?, now? }
   *   POST /api/outbox/dismiss-damage { session }
   *
   * A create names a session that must EXIST (a live bridge, or a transcript
   * under the project's dirs), so a client cannot mint journals for made-up ids.
   */
  if (rest[0] === 'outbox') {
    const outboxFail = (err: unknown): boolean => {
      if (err instanceof OutboxError) { sendJson(res, err.status, { error: err.message, ...err.extra }); return true; }
      sendJson(res, 500, { error: (err as Error).message });
      return true;
    };
    if (rest.length === 1 && m === 'GET') {
      const sid = url.searchParams.get('session') ?? '';
      if (!validSessionId(sid)) { sendJson(res, 400, { error: 'a valid session id is required' }); return true; }
      if (!outboxExists(sid)) { sendJson(res, 200, { sessionId: sid, rows: [], hold: null, damaged: null }); return true; }
      try { sendJson(res, 200, outboxView(sid)); } catch (err) { return outboxFail(err); }
      return true;
    }
    if (m !== 'POST' || rest.length > 2) return notFound(res, 'outbox: unknown route');
    // Same mutation guard as the provisioning route: no foreign Origin, JSON only.
    const origin = req.headers.origin as string | undefined;
    if (origin !== undefined && !originAllowed(origin)) { sendJson(res, 403, { error: `forbidden: Origin "${origin}" not allowed` }); return true; }
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) { sendJson(res, 415, { error: 'application/json required' }); return true; }
    let body: Record<string, unknown>;
    try { body = ((await readBody(req, 512 * 1024)) ?? {}) as Record<string, unknown>; } catch (err) { sendJson(res, 400, { error: `invalid JSON body: ${(err as Error).message}` }); return true; }
    const sid = typeof body.session === 'string' ? body.session : '';
    if (!validSessionId(sid)) { sendJson(res, 400, { error: 'a valid session id is required' }); return true; }
    try {
      if (rest.length === 1) {
        const projectId = typeof body.project === 'string' ? body.project : '';
        const project = reg.getProject(projectId);
        if (!project) return notFound(res, `outbox: no project ${projectId}`);
        const dir = typeof body.dir === 'string' && body.dir ? body.dir : null;
        const dirs = [...new Set([...(dir ? [dir] : []), ...resumeDirCandidates(project, dir ?? undefined)])];
        const exists = liveSessions().some((x) => x.sdkSessionId === sid)
          || dirs.some((d) => !!(hist.resolveSessionFile(d, sid) ?? ot.resolveOrchardSessionFile(d, sid)));
        if (!exists) return notFound(res, `outbox: no session ${sid}`);
        // The tab's session settings, used only if the SERVER must resume the session to deliver. Validated
        // now, by the same validator a start uses; a resume's engine is the transcript's, so provider is dropped (BUG-196).
        let overrides: Record<string, unknown> | null = null;
        if (body.overrides && typeof body.overrides === 'object' && !Array.isArray(body.overrides)) {
          const { provider: _dropped, ...rest2 } = body.overrides as Record<string, unknown>;
          // FEAT-160 round 4 — like the resume paths, a bound session's account is
          // the server's fact: drop a stale client `claudeAccount` here too, so a
          // tab still naming a DELETED account cannot 400 the enqueue of a session
          // the server already decides the account for.
          const stripped = dropBoundAccountOverride(sid, rest2);
          if (stripped && Object.keys(stripped).length) {
            try { validateSessionOverrides(stripped, { isolation: project.isolation }); } catch (err) { sendJson(res, 400, { error: `overrides rejected: ${(err as Error).message}` }); return true; }
            overrides = stripped;
          }
        }
        const templateIds = Array.isArray(body.templateIds) ? body.templateIds.filter((x): x is string => typeof x === 'string').slice(0, 64) : null;
        let initial = body.initial === 'uncertain' || body.initial === 'failed' ? body.initial : 'queued';
        let reason = typeof body.reason === 'string' ? body.reason : null;
        /*
         * A row an OLDER client kept in the browser. The round-4 ledger's record is
         * read (read-only, once) so a row it knew was delivered or withdrawn is not
         * brought back; anything else arrives `uncertain` — it may have gone.
         */
        if (typeof body.legacyId === 'string') {
          let was: unknown = null;
          try {
            const f = path.join(dataDir(), 'queue-ledger', `s_${sid}.json`);
            was = (JSON.parse(fs.readFileSync(f, 'utf8'))?.entries ?? {})[body.legacyId]?.s ?? null;
          } catch { /* no ledger record */ }
          if (was === 'delivered' || was === 'discarded') { sendJson(res, 200, { skipped: was, view: outboxExists(sid) ? outboxView(sid) : null }); return true; }
          initial = 'uncertain';
          reason = 'kept from before an Orchard update, which cannot tell whether it was already sent — check the conversation, then Send anyway or Discard';
        }
        const resume: ResumeSettings = { projectId: project.id, encodedDir: dir, overrides, templateIds };
        const r = createOutboxRow(sid, {
          nonce: String(body.nonce ?? ''), text: String(body.text ?? ''),
          origin: body.origin === 'direct' ? 'direct' : 'queued',
          initial: initial as 'queued' | 'uncertain' | 'failed', reason, resume,
          discard: body.discard === true,
        });
        sendJson(res, r.created ? 201 : 200, r);
        return true;
      }
      if (!outboxExists(sid)) return notFound(res, `outbox: session ${sid} has no queued messages`);
      const id = typeof body.id === 'string' ? body.id : '';
      if (rest[1] === 'edit') { sendJson(res, 200, editOutboxRow(sid, id, body.text)); return true; }
      if (rest[1] === 'discard') { sendJson(res, 200, discardOutboxRow(sid, id)); return true; }
      if (rest[1] === 'send') { sendJson(res, 200, sendOutboxRow(sid, id, { interrupt: body.interrupt === true, now: body.now === true })); return true; }
      if (rest[1] === 'dismiss-damage') { sendJson(res, 200, dismissOutboxDamage(sid)); return true; }
      return notFound(res, 'outbox: unknown route');
    } catch (err) {
      return outboxFail(err);
    }
  }

  if (rest[0] === 'sessions' && rest[1] === 'live' && m === 'GET') {
    const windowMs = intParam(url.searchParams.get('windowMs'), watcher.LIVE_WINDOW_MS, 1000, 10 * 60 * 1000);
    const t0 = Date.now();
    // Claude store + Orchard-owned (codex) transcripts — one liveness signal.
    const live = [...watcher.liveSessions(windowMs), ...watcher.orchardLiveSessions(windowMs)];
    // Per driven session: is it busy (a turn in flight) and detached (its tab
    // went away)? A reloaded tab needs this to reflect the REAL state instead
    // of presenting a still-running session as finished history.
    const bridges = new Map(liveSessions().map((s) => [s.sdkSessionId, s]).filter(([k]) => !!k) as [string, AgentSession][]);
    /*
     * ARCH-001 — TWO corrections, both the same mistake in different
     * directions:
     *
     *  1. `busy` used to be the bridge's RAW in-memory flag, so a zombie
     *     bridge kept this route reporting a running turn for as long as it
     *     took the reaper's next sweep to notice. It is now the authority's
     *     verdict, and the verdict rides along so nobody has to infer it.
     *  2. the list used to be the mtime window ALONE, so a session that was
     *     genuinely running but quiet on disk (thinking, or inside a long tool
     *     call — BUG-033's 10-minute case) was simply ABSENT from the "what is
     *     live" route. Absence read as "not running". Every bridge the
     *     authority still vouches for is unioned in, with its real file facts
     *     where they exist. This is the server-side half of BUG-034; the
     *     client's own union (app.js `liveRecordFor`) becomes redundant rather
     *     than load-bearing.
     */
    /*
     * BUG-072 — the same union, one rung out: a restart survivor this server
     * does NOT drive can still be running turns (FEAT-065 delivers into it), so
     * a row whose only claim was `busy:false, liveness:null` told a tab that
     * nothing was happening while the model was mid-answer. Survivors are
     * consulted here exactly as bridges are: the authority's verdict, and the
     * broker's own turn declaration (plus this server's delivery relay) as
     * `busy`. `drivenByDashboard` stays FALSE — the honest statement is "alive
     * and running, but this server holds no bridge for it".
     */
    const survivorRows = scanSurvivingHosts().map((h) => {
      const sdkId = h.sdkSessionId ?? h.resumeHint ?? null;
      return { h, sdkId, v: livenessOfSurvivor(h), work: survivorWork(h, deliveryEvidenceFor(sdkId)) };
    }).filter((r) => r.sdkId && r.v.live);
    const survivorBySdk = new Map(survivorRows.map((r) => [r.sdkId as string, r]));
    const rows = live.map((s) => {
      const b = bridges.get(s.sessionId);
      const v = b?.livenessVerdict() ?? null;
      const sv = b ? null : survivorBySdk.get(s.sessionId) ?? null;
      if (sv) {
        return {
          ...s,
          drivenByDashboard: false,
          survivingUnadopted: true,
          busy: sv.work.turnRunning === true,
          detached: false,
          turnStartedAt: sv.work.turnSince,
          liveness: livenessWire(sv.v),
        };
      }
      // BUG-033 `turnStartedAt`: the honest age of the in-flight turn, so a
      // tab reopening a live session shows the turn's real duration instead of
      // starting a fresh stopwatch (null = no turn / not knowable → the client
      // must render an unknown, not a timer).
      return {
        ...s,
        drivenByDashboard: !!b,
        busy: !!b?.busy && !!v?.live,
        detached: b?.detached ?? false,
        turnStartedAt: b?.turnStartedAt ?? null,
        liveness: v ? livenessWire(v) : null,
      };
    });
    const seen = new Set(rows.map((r) => r.sessionId));
    /*
     * BUG-072 — and the survivor half of the SAME correction the bridge union
     * below makes: a session running a delivered turn can be silent on disk for
     * minutes (thinking, long tool call), so the mtime scan misses it and its
     * absence reads as "not running". Union in every survivor the authority
     * vouches for, with its real file facts where the transcript can be found.
     */
    for (const r of survivorRows) {
      const sdkId = r.sdkId as string;
      if (seen.has(sdkId) || bridges.has(sdkId)) continue;
      seen.add(sdkId);
      /*
       * No store-wide search for this row's file facts: the broker records no
       * cwd, so finding the transcript would mean scanning every project dir —
       * on EVERY poll of a route every open tab polls (measured: it pushed
       * verify:resume-refusal's 37 planted survivors past its 3s refusal
       * window). A row that reached this union is by definition one the mtime
       * scan did NOT find, so its file facts are stale anyway; `dir:''` +
       * `ageMs:0` say "not knowable from here", and the broker's own heartbeat
       * time is the honest recency signal. Rows the mtime scan DID find keep
       * their real facts in the branch above.
       */
      rows.push({
        sessionId: sdkId,
        dir: '',
        lastWriteAt: r.h.updatedAt ?? new Date().toISOString(),
        ageMs: 0,
        fileBytes: 0,
        drivenByDashboard: false,
        survivingUnadopted: true,
        busy: r.work.turnRunning === true,
        detached: false,
        turnStartedAt: r.work.turnSince,
        liveness: livenessWire(r.v),
      });
    }
    for (const [sdkId, b] of bridges) {
      if (seen.has(sdkId)) continue;
      const v = b.livenessVerdict();
      if (!v.live) continue; // a bridge the authority no longer vouches for is not "live"
      const f = watcher.sessionFileFacts(b.storeEncodedDir, sdkId);
      rows.push({
        sessionId: sdkId,
        dir: f?.dir ?? '',
        lastWriteAt: f?.lastWriteAt ?? new Date(b.turnStartedAt ?? Date.now()).toISOString(),
        ageMs: f?.ageMs ?? 0,
        fileBytes: f?.fileBytes ?? 0,
        drivenByDashboard: true,
        busy: b.busy && v.live,
        detached: b.detached,
        turnStartedAt: b.turnStartedAt ?? null,
        liveness: livenessWire(v),
      });
    }
    sendJson(res, 200, { windowMs, tookMs: Date.now() - t0, sessions: rows });
    return true;
  }

  /*
   * FEAT-057 — GET /api/agent-outcomes[?projectId=&sessionId=&all=1]
   *            POST /api/agent-outcomes/dismiss  {ids:[…] | all:true}
   *
   * WHAT DIED AND WHY, readable with NO model in the loop and NO live session:
   * the records are on disk, written at the moment of death, so a fresh page
   * load surfaces them even though the orchestrator never ran a turn — which is
   * the entire point of this ticket (an account-wide usage limit stops the very
   * turn that would otherwise have had to notice).
   *
   * Dismissal is PERSISTED, not client-side: a banner the user cleared must not
   * come back on the next reload, and one they did not clear must.
   */
  /*
   * ARCH-017 step 2 — the `#railPending` surface.
   *
   *   GET  /api/lanes/pending[?projectId=]      what is waiting, drain-shaped
   *   POST /api/lanes/process  {ids:[…]|all}    collect — stamps the handoff,
   *                                             returns the bundle + a receipt
   *   POST /api/lanes/ack      {laneIds,receipt} the consumer's half
   *   POST /api/lanes/dismiss  {ids:[…]|all}    discard without collecting
   *
   * WHY A NEW RAIL SECTION AND NOT AN EXISTING SURFACE. The Needs-You rail is
   * hardwired to board tickets — a held lane result is not a ticket and cannot
   * be rendered there without lying about what it is. Agent cards are
   * ephemeral: they vanish with the session, and the entire point here is a
   * durable actionable item that survives a restart and a fresh page load with
   * no model in the loop. Modelled on FEAT-057's outcomes rail because that is
   * the one surface already built for exactly that property.
   *
   * 503, NOT 500, when the ledger is unreadable: a corrupt ledger is refused
   * whole (round 7's deliberate choice — a partial read would let the next
   * write delete the records it could not parse), and the rail must say so in
   * the store's own words rather than render an empty list that reads as
   * "nothing is waiting for you".
   */
  if (rest[0] === 'lanes' && rest[1] === 'pending' && rest.length === 2 && m === 'GET') {
    try {
      const items = laneDrain.pending({ projectId: url.searchParams.get('projectId') });
      sendJson(res, 200, { pending: items, capacity: lanes.capacity() });
    } catch (err) {
      sendJson(res, 503, { error: (err as Error).message, pending: null });
    }
    return true;
  }
  if (rest[0] === 'lanes' && (rest[1] === 'process' || rest[1] === 'dismiss' || rest[1] === 'ack') && rest.length === 2 && m === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = ((await readBody(req)) ?? {}) as Record<string, unknown>;
    } catch (err) {
      sendJson(res, err instanceof HttpError ? err.status : 400, { error: (err as Error).message });
      return true;
    }
    const projectId = body.projectId == null ? null : String(body.projectId);
    try {
      if (rest[1] === 'ack') {
        const laneIds = Array.isArray(body.laneIds) ? body.laneIds.map(String) : [];
        // `{bytes, digest, nonce, channel}` — the drain enforces all four.
        const receipt = (body.receipt ?? {}) as { bytes: number; digest: string; nonce?: string; channel?: string };
        if (!laneIds.length) { sendJson(res, 400, { error: 'ack: pass {laneIds:[…], receipt:{bytes,digest}}' }); return true; }
        sendJson(res, 200, laneDrain.acknowledge(laneIds, receipt, 'user'));
        return true;
      }
      // `all:true` means every item the rail would currently SHOW — which for
      // `process` is deliberately only the READY ones. "Process all" must never
      // silently pull a result out of a group that is still filling; the early
      // pull is a per-item choice the user makes explicitly.
      const items = laneDrain.pending({ projectId });
      const ids = body.all === true
        ? items.filter((i) => rest[1] === 'dismiss' || i.ready).map((i) => i.id)
        : (Array.isArray(body.ids) ? body.ids.map(String) : []);
      if (!ids.length) { sendJson(res, 400, { error: `${rest[1]}: pass {ids:[…]} or {all:true} — nothing matched`, ids: [] }); return true; }
      if (rest[1] === 'dismiss') {
        const laneIds = items.filter((i) => ids.includes(i.id)).flatMap((i) => i.laneIds);
        sendJson(res, 200, { dismissed: lanes.dismiss(laneIds), laneIds });
        return true;
      }
      const bundle = laneDrain.process(ids, { projectId });
      /*
       * A DRAIN THAT HANDED OVER NOTHING IS NOT A SUCCESS.
       *
       * Reproduced by an independent verifier: a server that lost the writer
       * claim at boot (a restart overlap on the same data dir) answered HTTP
       * 200 with the full `bundle`, `lanes: []` and the real reason buried in
       * `skipped[]`. The client ignored `skipped`, removed the row
       * optimistically, and the row silently came back — the user was told
       * nothing at all, which is the worst available behaviour for a surface
       * whose entire job is "these results are waiting for you". 503 with the
       * store's OWN words, because the recovery path is in them.
       */
      if (bundle.skipped.length && !bundle.lanes.length) {
        /*
         * ONE REASON, NOT ONE PER LANE.
         *
         * Every lane in a refused drain fails for the SAME cause — the store
         * refused the whole write — so joining `skipped.map(s => s.why)`
         * emitted the identical ~545-character writer-claim message once per
         * lane. Measured by a verifier on the primary button: `process all`
         * over 18 lanes produced a **9,820-character, ~335-line** body of which
         * 17 of the 18 copies were pure repetition, and the rail could show
         * 2.4% of it. Two rounds of work making that row readable were wasted
         * on text that was 18 copies of one sentence. De-duplicating puts the
         * message back UNDER the row's height cap.
         *
         * `lanes` is still carried per-lane: which lanes were skipped is real
         * information. Only the REASON is collapsed, and only when identical.
         */
        const reasons = [...new Set(bundle.skipped.map((s) => s.why))];
        const lanesWord = bundle.skipped.length === 1 ? 'result' : 'results';
        sendJson(res, 503, {
          error: `nothing could be handed over (${bundle.skipped.length} ${lanesWord} still held): ${reasons.join('; ')}`,
          reasons,
          skipped: bundle.skipped,
        });
        return true;
      }
      sendJson(res, 200, bundle);
    } catch (err) {
      sendJson(res, 503, { error: (err as Error).message });
    }
    return true;
  }
  if (rest[0] === 'agent-outcomes' && rest.length === 1 && m === 'GET') {
    const list = outcomes.list({
      projectId: url.searchParams.get('projectId'),
      sessionIds: url.searchParams.getAll('sessionId'),
      includeDismissed: url.searchParams.get('all') === '1',
      limit: intParam(url.searchParams.get('limit'), 50, 1, 200),
    });
    sendJson(res, 200, { outcomes: list, headline: outcomes.headline(list) });
    return true;
  }
  if (rest[0] === 'agent-outcomes' && rest[1] === 'dismiss' && rest.length === 2 && m === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = ((await readBody(req)) ?? {}) as Record<string, unknown>;
    } catch (err) {
      sendJson(res, err instanceof HttpError ? err.status : 400, { error: (err as Error).message });
      return true;
    }
    const ids = body.all === true ? '*' as const : (Array.isArray(body.ids) ? body.ids.map(String) : []);
    if (ids !== '*' && !ids.length) {
      sendJson(res, 400, { error: 'dismiss: pass {ids:[…]} or {all:true}' });
      return true;
    }
    sendJson(res, 200, { dismissed: outcomes.dismiss(ids) });
    return true;
  }

  /*
   * ARCH-001 phase 2 / BUG-034 — GET /api/sessions/:sessionId/running
   *
   * THE POLLABLE HALF of the running-set snapshot: the same structure the
   * `running-snapshot` event pushes, fetched on demand. It exists because push
   * alone cannot be trusted to have arrived — a dropped frame, a tab that was
   * in the background, a socket that died mid-turn, or a server that restarted
   * under an open tab all produce a client whose picture the server denies.
   * This route is how that client is CORRECTED.
   *
   * `:sessionId` accepts a station id OR an SDK id (same dual lookup as the
   * subagents route). An id this server is not driving is NOT an error: it
   * answers with an EMPTY snapshot, which is the honest answer "nothing is
   * running here" and is exactly what empties a stale strip. The 404 case is
   * reserved for a malformed request, never for "no session" — a client that
   * cannot tell those apart is how phantom rows survive.
   */
  if (rest[0] === 'sessions' && rest[1] && rest[2] === 'running' && rest.length === 3 && m === 'GET') {
    const sid = rest[1];
    const s = getSession(sid) ?? liveSessions().find((x) => x.sdkSessionId === sid) ?? null;
    const ended = outcomes.list({ sessionIds: [sid, s?.id, s?.sdkSessionId], limit: 20 });
    /*
     * BUG-072 — the third answer this route needs. "No bridge" used to collapse
     * straight to the empty snapshot, which is why a session whose restart
     * survivor was running a FEAT-065-delivered turn rendered `rows:[]` for a
     * whole day: the server does not OWN the session, but it knows exactly what
     * is running in it (the broker's declarations + its own delivery relay).
     * Answering "nothing" there is the ARCH-001 violation, not the honest
     * default. A survivor the authority has proven dead is swept by the scan
     * and never reaches here, so this cannot resurrect a corpse.
     */
    const survivor = s && !s.closed ? null : survivingHostForSession(sid);
    sendJson(res, 200, {
      snapshot: s && !s.closed
        ? s.runningSnapshot()
        : survivor
          ? snapshotOfSurvivor(survivor, {
            ended,
            delivery: deliveryEvidenceFor(survivor.sdkSessionId ?? survivor.resumeHint ?? sid),
          })
          : emptySnapshot(
            { stationSessionId: s?.id ?? null, sdkSessionId: s?.sdkSessionId ?? sid },
            'this server is not driving a live session for that id — nothing is running',
            ended,
          ),
    });
    return true;
  }

  /*
   * FEAT-154 (round 7) — STOP ONE running task, addressed by (session, task).
   *
   * Routed server-side to whichever bridge OWNS the session — the same dual
   * lookup (station id or SDK id) as the running-set GET above — whether or not
   * any socket is attached to it. Round 6 put this on the websocket, where it
   * could only reach the socket's own attached session: a stop from a tab that
   * VIEWS a session (the strip is filled by the HTTP poll) but does not drive it —
   * exactly the adopted-after-restart 7f7e39a1 case — was refused with "no
   * session on this socket" and never reached the engine.
   *
   * Answers are explicit, never a silent no-op: 200 {ok:true} once the engine
   * accepted `stop_task` (the row leaves when its terminal frame lands); 404
   * {reason:'no-bridge'} when this server drives no live session for that id
   * (the bridge is gone); 409 {reason:'not-running'} when the session does not
   * list that task; 501 when the engine cannot stop one task. Destructive, so the
   * Origin + JSON content-type guard applies (a foreign page cannot text/plain
   * POST a stop).
   */
  if (rest[0] === 'sessions' && rest[1] && rest[2] === 'running' && rest[3] && rest[4] === 'stop' && rest.length === 5 && m === 'POST') {
    const origin = req.headers.origin as string | undefined;
    if (origin !== undefined && !originAllowed(origin)) {
      sendJson(res, 403, { ok: false, error: `forbidden: Origin "${origin}" not allowed` });
      return true;
    }
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) {
      sendJson(res, 415, { ok: false, error: 'content-type must be application/json' });
      return true;
    }
    const sid = rest[1];
    const taskId = rest[3];
    const s = getSession(sid) ?? liveSessions().find((x) => x.sdkSessionId === sid) ?? null;
    if (!s || s.closed) {
      sendJson(res, 404, {
        ok: false, reason: 'no-bridge', sessionId: sid, taskId,
        error: 'this server is not driving that session any more, so there is nothing to stop the command through — it may already have ended; reload to refresh the list',
      });
      return true;
    }
    try {
      await s.stopTask(taskId);
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      const notRunning = /not running in this session/.test(msg);
      const cannot = /cannot stop a single task/.test(msg);
      sendJson(res, notRunning ? 409 : cannot ? 501 : 502, {
        ok: false, reason: notRunning ? 'not-running' : cannot ? 'unsupported' : 'engine-error', sessionId: sid, taskId, error: msg,
      });
      return true;
    }
    s.pushRunningSnapshot(true);
    sendJson(res, 200, { ok: true, sessionId: sid, taskId, stationSessionId: s.id, sdkSessionId: s.sdkSessionId });
    return true;
  }

  // FEAT-126 — the DECLARED request bindings for a session. Server-owned store,
  // NO status (every status is joined live client-side from board/snapshot). An
  // id this server is not driving is not a 404 — it is an honest empty list.
  if (rest[0] === 'sessions' && rest[1] && rest[2] === 'requests' && rest.length === 3 && m === 'GET') {
    const sid = rest[1];
    const s = getSession(sid) ?? liveSessions().find((x) => x.sdkSessionId === sid) ?? null;
    const ids = [sid, s?.id, s?.sdkSessionId].filter((x): x is string => !!x);
    const seen = new Set<string>();
    const list = ids.flatMap((id) => (seen.has(id) ? [] : (seen.add(id), requests.listForSession(id))));
    sendJson(res, 200, { requests: list });
    return true;
  }

  if (rest[0] === 'sessions' && rest.length === 1 && m === 'GET') {
    sendJson(res, 200, {
      sessions: liveSessions().map((s) => {
        // ARCH-001: `busy` is the VERDICT, not the raw flag — a bridge whose
        // process is gone must not read as running here either, however few
        // seconds remain until the reaper's next sweep.
        const v = s.livenessVerdict();
        return {
          stationSessionId: s.id,
          projectId: s.project.id,
          sdkSessionId: s.sdkSessionId,
          isolation: s.project.isolation,
          containerName: s.containerName,
          busy: s.busy && v.live,
          liveness: livenessWire(v),
          // FEAT-154 — WAITING ON YOU, published by the OWNER of pending
          // questions/permissions (the bridge's `#approvals`, BUG-166's server
          // side). True while a `can_use_tool` / AskUserQuestion / ExitPlanMode
          // request is outstanding for this session. The session list reads THIS
          // (per ARCH-010) so a non-open row can show the amber waiting state;
          // the client never re-derives it from busy flags.
          awaitingUser: s.approvalsSnapshot().requestIds.length > 0,
          // BUG-033 — the honest turn clock + the evidence behind `busy`.
          turnStartedAt: s.turnStartedAt,
          lastFrameAt: s.lastFrameAt || null,
          totalCostUsd: s.totalCostUsd,
          overridden: s.overriddenFields,
        };
      }),
    });
    return true;
  }
  /*
   * SUBAGENT HISTORY.
   *
   * `:sessionId` accepts EITHER a station session id (from the start ack) or a
   * real SDK session id — the UI has the former for a live session and the
   * latter for one picked out of the sidebar, and both must work.
   *
   * `?dir=` names the encoded store dir. When omitted we look it up; if the same
   * session id exists under several dirs (normal on this dual-boot machine) we
   * refuse to guess and list the candidates, exactly like the fork resolver.
   */
  if (rest[0] === 'sessions' && rest[1] && rest[2] === 'subagents' && m === 'GET') {
    return handleSubagentRoute(res, url, rest[1], rest[3], rest[4]);
  }

  /*
   * FEAT-029 — a RUNNING session raises a decision the user must answer.
   *
   *   POST /api/sessions/:sid/needs-you  {question, options?}
   *
   * `:sid` is the raising session — accepted as EITHER the station session id
   * or the SDK session id (a session knows one or the other), mirroring the
   * subagent route's dual lookup. Persists a lightweight decision record tagged
   * with that session + its project; the record surfaces as a Needs-You rail
   * card via the board feed and is answered back to THIS session. 400 on an
   * empty question or an unknown/dead session.
   */
  /*
   * FEAT-157 — the AGENT's base-update surface (`npm run base -- …`).
   *   GET  /api/sessions/:sid/base          → the session's OWN project's notice
   *   POST /api/sessions/:sid/base-update   { action, version?, rev }
   * The project is the live session's project — never a parameter — so an agent
   * acts only on its own project's notice. `applyAction` refuses what an agent may
   * not do (skip a security release, move the pin back, move to dev).
   */
  if (rest[0] === 'sessions' && rest[1] && (rest[2] === 'base' || rest[2] === 'base-update') && rest.length === 3) {
    const sid = rest[1];
    const target = getSession(sid) ?? liveSessions().find((s) => s.sdkSessionId === sid) ?? null;
    if (!target || target.closed) {
      sendJson(res, 400, { error: `base: no live session ${JSON.stringify(sid)}` });
      return true;
    }
    const p = reg.getProject(target.project.id);
    if (!p) return notFound(res, `base: the session's project ${target.project.id} is no longer registered`);
    if (rest[2] === 'base' && m === 'GET') { sendJson(res, 200, baseStatusOf(p)); return true; }
    if (rest[2] === 'base-update' && m === 'POST') return handleBaseUpdate(req, res, p, 'agent');
    sendJson(res, 405, { error: `method ${m} not allowed here` });
    return true;
  }

  if (rest[0] === 'sessions' && rest[1] && rest[2] === 'needs-you' && rest.length === 3 && m === 'POST') {
    const sid = rest[1];
    const target =
      getSession(sid) ??
      liveSessions().find((s) => s.sdkSessionId === sid) ??
      null;
    if (!target || target.closed) {
      sendJson(res, 400, { error: `needs-you: no live session ${JSON.stringify(sid)} to raise a decision from` });
      return true;
    }
    let body: Record<string, unknown>;
    try {
      body = ((await readBody(req)) ?? {}) as Record<string, unknown>;
    } catch (err) {
      sendJson(res, err instanceof HttpError ? err.status : 400, { error: (err as Error).message });
      return true;
    }
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question) { sendJson(res, 400, { error: 'needs-you: question is required and must be a non-empty string' }); return true; }
    if (body.options !== undefined && !Array.isArray(body.options)) {
      sendJson(res, 400, { error: 'needs-you: options must be an array of strings when provided' });
      return true;
    }
    const rec = decisions.raise({
      projectId: target.project.id,
      sessionId: target.id,
      sdkSessionId: target.sdkSessionId,
      question,
      options: body.options,
    });
    sendJson(res, 201, {
      id: rec.id,
      projectId: rec.projectId,
      sessionId: rec.sessionId,
      question: rec.question,
      options: rec.options,
      createdAt: rec.createdAt,
    });
    return true;
  }

  /*
   * BUG-173 — the invocation-layer git shim's CALL-TIME grant consult.
   *
   *   POST /api/git-shim/decide  { grantKey, argv:[...], sessionLabel? }
   *     → { allow, reason?, offender? }
   *
   * The FEAT-135 PATH shim (scripts/lib/git-shim.mjs) runs in the SESSION
   * subprocess and cannot read the host-memory grant (git-grant-store.mjs). For a
   * classified WRITE it asks here, and this runs the SAME `evaluateGitWrite` the
   * FEAT-108 hook runs — ONE grant authority (ARCH-010): the store, asked at the write (claimGrant→useClaim, FEAT-164 r4) + leak gate on a
   * publish + single-use consume. So the shim and the hook can never disagree, an
   * expired/revoked grant re-blocks on the next invocation, and a granted publish
   * still cannot leak. The shim FAILS CLOSED on any non-allow, so a malformed or
   * partial request here simply denies. `grantKey` is the project id the shim
   * baked at launch, so a grant for another project can never unblock this call.
   */
  if (rest[0] === 'git-shim' && rest[1] === 'decide' && rest.length === 2 && m === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = ((await readBody(req)) ?? {}) as Record<string, unknown>;
    } catch {
      sendJson(res, 200, { allow: false, reason: 'git-shim decide: unreadable body — failing closed' });
      return true;
    }
    const grantKey = typeof body.grantKey === 'string' && body.grantKey ? body.grantKey : null;
    const argv = Array.isArray(body.argv) ? body.argv.filter((a): a is string => typeof a === 'string') : null;
    const sessionLabel = typeof body.sessionLabel === 'string' ? body.sessionLabel : null;
    // BUG-173 round 3 — authenticate the caller as an Orchard-launched shim with
    // the host-minted secret baked into that shim at launch. A caller without the
    // current secret (any non-session localhost process, or a stale secret from a
    // previous host boot) is refused — fail closed. This does NOT stop a same-uid
    // agent that reads the secret out of its own shim file, but possessing it only
    // lets it call THIS route (which still runs the full grant + leak gate), never
    // mint a grant; see git-shim-secret.mjs for the residual note.
    const shimAuth = typeof body.shimAuth === 'string' ? body.shimAuth : null;
    if (!grantKey || !argv) {
      sendJson(res, 200, { allow: false, reason: 'git-shim decide: grantKey and argv[] required — failing closed' });
      return true;
    }
    if (!isShimSecretValid(shimAuth)) {
      sendJson(res, 200, { allow: false, reason: 'git-shim decide: missing or invalid shim secret — failing closed' });
      return true;
    }
    const p = reg.getProject(grantKey);
    const repoPath = p?.hostPath ?? null;
    // BUG-231 — `windowKey` is the session's binding, baked into its shim. Inside a Bash
    // call the PreToolUse hook already decided, this invocation REDEEMS that decision
    // (no second claim, a publish gated once, at the write). Without a key, or with no
    // live window for this verb, it decides independently exactly as before.
    const windowKey = typeof body.windowKey === 'string' && body.windowKey ? body.windowKey : null;
    const decision = redeemGitWrite({
      binding: windowKey,
      argv,
      projectKey: grantKey,
      sessionLabel,
      runLeakGate: () => runLeakGateForRepo(repoPath),
      repoFingerprint: () => repoContentFingerprint(repoPath),
    });
    if (decision.allow && decision.granted) {
      console.warn(`[orchard] git-write PERMITTED via invocation shim (subprocess) for project ${grantKey}: \`${decision.offender}\` — grant honoured (BUG-173, recorded PENDING; the shim confirms the real git outcome, BUG-184).`);
    }
    // BUG-184 — hand the ledger record id AND its single-use capability token back
    // so the shim can CONFIRM the real git exit after it execs. The token is minted
    // per-record and returned ONLY here to this executor (round 3): a same-uid peer
    // cannot guess it, so it cannot forge another write's outcome. The record is
    // 'permitted' (pending) until confirmed, never a false 'executed'.
    sendJson(res, 200, {
      allow: !!decision.allow, reason: decision.reason ?? null, offender: decision.offender ?? null,
      recordId: decision.record?.id ?? null,
      confirmToken: decision.allow && decision.granted ? (decision.record?.confirmToken ?? null) : null,
    });
    return true;
  }

  /*
   * BUG-184 — the shim reports the OBSERVED git exit after it execs, so the ledger
   * records what HAPPENED, not just what the host DECIDED.
   *
   *   POST /api/git-shim/confirm  { recordId, status, token, projectKey, shimAuth }
   *     → { ok, outcome, reason }
   *
   * The host recorded a decide-time PERMIT ('permitted') on /decide; only the shim
   * (running in the session subprocess) observes whether git actually ran and with
   * what status (ARCH-010: the executor owns the fact). `status === 0` → 'executed'
   * (the write landed); anything else → 'failed'. A permit whose shim aborts (the
   * BUG-173 timeout residual) or is never confirmed stays 'permitted' — honest, and
   * never mistakable for a landed commit.
   *
   * ROUND 3 — a same-uid peer must not be able to forge another write's outcome
   * (attacks A1/A2). The shim-secret gate keeps NON-session localhost callers off
   * the route, but the shim secret is extractable host-wide, so it is NOT the
   * binding. The binding is the per-record single-use capability `token` (minted at
   * decide, returned only to that write's executor) plus the owner `projectKey`;
   * `confirmGitWrite` verifies both and records any mismatch as an anomaly. So even
   * a caller holding the shim secret cannot confirm a record it does not own.
   */
  if (rest[0] === 'git-shim' && rest[1] === 'confirm' && rest.length === 2 && m === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = ((await readBody(req)) ?? {}) as Record<string, unknown>;
    } catch {
      sendJson(res, 200, { ok: false, reason: 'git-shim confirm: unreadable body' });
      return true;
    }
    const recordId = typeof body.recordId === 'string' && body.recordId ? body.recordId : null;
    const status = typeof body.status === 'number' ? body.status : (body.status === null ? null : Number.NaN);
    const token = typeof body.token === 'string' ? body.token : null;
    const projectKey = typeof body.projectKey === 'string' ? body.projectKey : null;
    const shimAuth = typeof body.shimAuth === 'string' ? body.shimAuth : null;
    if (!isShimSecretValid(shimAuth)) {
      sendJson(res, 200, { ok: false, reason: 'git-shim confirm: missing or invalid shim secret' });
      return true;
    }
    if (!recordId || Number.isNaN(status)) {
      sendJson(res, 200, { ok: false, reason: 'git-shim confirm: recordId and numeric status required' });
      return true;
    }
    const result = confirmGitWrite(recordId, { token, projectKey, exitStatus: status });
    if (!result.ok && result.reason === 'unauthorized-confirm') {
      console.warn(`[orchard] git-write confirm REJECTED (unauthorized) for record ${recordId} project ${projectKey ?? '?'} — recorded as an anomaly (BUG-184 r3).`);
    }
    sendJson(res, 200, { ok: result.ok, outcome: result.record?.outcome ?? null, reason: result.reason });
    return true;
  }

  /*
   * FEAT-108 round 3 — an agent REQUESTS permission to run git writes.
   *
   *   POST /api/sessions/:sid/git-write-request  { reason, scope?, minutes? }
   *
   * This raises a git-write permission card on the SAME Needs-You rail the user
   * already uses (FEAT-029 reuse — no second approval surface). It creates an
   * INERT pending request and NOTHING ELSE: no grant, ever, no matter how many
   * times an agent calls it. Only the user answering the card with "Allow" (the
   * board/answer route) mints the grant, so an agent cannot approve its own
   * request — that is the self-grant defence, structural, not a check. Requires
   * a LIVE raising session so the Allow/Decline is delivered back to it (the
   * agent learns the outcome, then does the git work the user approved). The
   * grant that an Allow eventually mints still runs the mandatory leak gate on
   * every commit/push (git-grant.mjs) — this path never lifts it.
   */
  if (rest[0] === 'sessions' && rest[1] && rest[2] === 'git-write-request' && rest.length === 3 && m === 'POST') {
    const sid = rest[1];
    const target =
      getSession(sid) ??
      liveSessions().find((s) => s.sdkSessionId === sid) ??
      null;
    if (!target || target.closed) {
      sendJson(res, 400, { error: `git-write-request: no live session ${JSON.stringify(sid)} to raise a request from` });
      return true;
    }
    let body: Record<string, unknown>;
    try {
      body = ((await readBody(req)) ?? {}) as Record<string, unknown>;
    } catch (err) {
      sendJson(res, err instanceof HttpError ? err.status : 400, { error: (err as Error).message });
      return true;
    }
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason) { sendJson(res, 400, { error: 'git-write-request: a reason is required and must be a non-empty string' }); return true; }
    const scope: 'once' | 'duration' = body.scope === 'duration' ? 'duration' : 'once';
    const minsRaw = Number(body.minutes);
    const minutes = scope === 'duration' && Number.isFinite(minsRaw) && minsRaw > 0 ? Math.round(minsRaw) : null;
    const scopeLabel = scope === 'duration' ? `${minutes ?? 30}-minute window` : 'one write';
    const rec = decisions.raise({
      projectId: target.project.id,
      sessionId: target.id,
      sdkSessionId: target.sdkSessionId,
      question: `Allow git writes (commit/push) for “${target.project.name}”? ${reason} — grant: ${scopeLabel}.`,
      options: ['Allow', 'Decline'],
      gitWrite: { scope, minutes, reason },
    });
    // Visible, never silent — and explicitly NOT a grant: the request is inert.
    console.warn(`[orchard] git-write REQUEST raised by session ${target.id} for project ${target.project.id} (${target.project.name}) — scope=${scope}, reason=${JSON.stringify(reason)}. INERT until the user approves (FEAT-108).`);
    sendJson(res, 201, {
      id: rec.id,
      projectId: rec.projectId,
      sessionId: rec.sessionId,
      question: rec.question,
      gitWrite: rec.gitWrite,
      pending: true,
      granted: false,
      createdAt: rec.createdAt,
    });
    return true;
  }

  /*
   * FEAT-112 — an agent PROPOSES a set of service sidecars; the user approves in
   * one click on the Needs-You rail. Mirrors git-write-request exactly: this
   * route validates the proposal and raises an INERT decision — it writes NO
   * project settings and brings up NO container. Only the user answering "Allow"
   * on the answer route writes the services into the project (an agent proposing
   * is never an agent applying). The verdict is delivered back to the raising
   * session so the agent learns whether to expect the services next start.
   */
  if (rest[0] === 'sessions' && rest[1] && rest[2] === 'services-request' && rest.length === 3 && m === 'POST') {
    const sid = rest[1];
    const target =
      getSession(sid) ??
      liveSessions().find((s) => s.sdkSessionId === sid) ??
      null;
    if (!target || target.closed) {
      sendJson(res, 400, { error: `services-request: no live session ${JSON.stringify(sid)} to raise a request from` });
      return true;
    }
    let body: Record<string, unknown>;
    try {
      body = ((await readBody(req)) ?? {}) as Record<string, unknown>;
    } catch (err) {
      sendJson(res, err instanceof HttpError ? err.status : 400, { error: (err as Error).message });
      return true;
    }
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason) { sendJson(res, 400, { error: 'services-request: a reason is required and must be a non-empty string' }); return true; }
    let services;
    try {
      services = validateServices(body.services);
    } catch (err) {
      sendJson(res, 400, { error: `services-request: ${(err as Error).message}` });
      return true;
    }
    if (services.length === 0) { sendJson(res, 400, { error: 'services-request: propose at least one service' }); return true; }
    const names = services.map((s) => `${s.name} (${s.image})`).join(', ');
    const rec = decisions.raise({
      projectId: target.project.id,
      sessionId: target.id,
      sdkSessionId: target.sdkSessionId,
      question: `Add service sidecars to “${target.project.name}”? ${reason} — proposed: ${names}.`,
      options: ['Allow', 'Decline'],
      services: { services, reason },
    });
    // Visible, never silent — and explicitly NOT applied: the proposal is inert.
    console.warn(`[orchard] services PROPOSAL raised by session ${target.id} for project ${target.project.id} (${target.project.name}) — ${names}. INERT until the user approves (FEAT-112); no settings written, no container touched.`);
    sendJson(res, 201, {
      id: rec.id,
      projectId: rec.projectId,
      sessionId: rec.sessionId,
      question: rec.question,
      services: rec.services,
      pending: true,
      applied: false,
      createdAt: rec.createdAt,
    });
    return true;
  }

  /*
   * SESSION MUTATION — rename, pin, delete. `live` is a route, not a session id.
   */
  if (rest[0] === 'sessions' && rest[1] && rest[1] !== 'live' && (m === 'PATCH' || m === 'DELETE' || m === 'POST')) {
    if (rest.length === 2 && (m === 'PATCH' || m === 'DELETE')) {
      return await handleSessionMutation(req, res, url, rest[1], m);
    }
    if (rest[2] === 'pin' && rest.length === 3 && (m === 'POST' || m === 'DELETE')) {
      return await handleSessionPin(req, res, url, rest[1], m === 'POST');
    }
    if (rest[2] === 'close' && rest.length === 3 && (m === 'POST' || m === 'DELETE')) {
      return await handleSessionClose(req, res, url, rest[1], m === 'POST');
    }
  }

  if (rest[0] === 'sessions' && rest[1] && m === 'GET') {
    const s = getSession(rest[1]);
    if (!s) return notFound(res, `no live session ${rest[1]}`);
    // FEAT-022: the autonomous mode + its stop condition, on its own so the UI
    // can poll it cheaply (e.g. at every turn boundary) without the whole config.
    if (rest[2] === 'autonomous' && rest.length === 3) {
      sendJson(res, 200, s.autonomousState());
      return true;
    }
    if (rest[2] === 'effective-config' || rest.length === 2) {
      sendJson(res, 200, {
        stationSessionId: s.id,
        sdkSessionId: s.sdkSessionId,
        cwd: s.cwd,
        containerName: s.containerName,
        closed: s.closed,
        totalCostUsd: s.totalCostUsd,
        budgetStopped: s.budgetStopped,
        // FEAT-022: default interactive; a live session reports its real mode.
        autonomous: s.autonomousState(),
        fork: s.forkInfo(),
        ...s.effectiveConfig(),
      });
      return true;
    }
  }

  /*
   * FEAT-022 — set the session's mode. POST {action:'start', maxTurns:N} arms
   * autonomous with a bounded stop condition; {action:'stop'} returns it to
   * interactive. Never a registry write — the mode lives on the live session
   * object exactly as long as it does (survives a browser reload, which just
   * re-reads it; a server restart legitimately drops back to interactive).
   */
  if (rest[0] === 'sessions' && rest[1] && rest[2] === 'autonomous' && rest.length === 3 && m === 'POST') {
    const s = getSession(rest[1]);
    if (!s) return notFound(res, `no live session ${rest[1]}`);
    const body = ((await readBody(req)) ?? {}) as Record<string, unknown>;
    try {
      if (body.action === 'stop') {
        sendJson(res, 200, { ok: true, autonomous: s.stopAutonomous('manual') });
        return true;
      }
      if (body.action === 'start') {
        sendJson(res, 200, { ok: true, autonomous: s.enableAutonomous(Number(body.maxTurns)) });
        return true;
      }
      sendJson(res, 400, { ok: false, error: "action must be 'start' or 'stop'" });
      return true;
    } catch (err) {
      sendJson(res, 400, { ok: false, error: (err as Error).message });
      return true;
    }
  }

  /*
   * Orphan sweep: containers THIS instance created whose project is gone from
   * its registry. GET lists, POST removes. Without this an orphan keeps the OAuth
   * credentials bind-mounted rw with no route able to reach it.
   *
   * BUG-216: ownership is the owner label the creator wrote (`instance-owner.ts`),
   * never "absent from my registry" — every other Orchard server's projects are
   * absent from this registry too, and a scratch server's POST here once removed
   * 44 containers across the host, live projects included. Containers and service
   * infra with NO owner label (made before it existed) come back as `unowned`:
   * listed for a person to judge, never removed by this route.
   */
  if (rest[0] === 'containers' && rest[1] === 'orphans') {
    const known = new Set(reg.listProjects().map((p) => p.id));
    // BUG-214 round 7: a container with a live session is never an orphan, even if its project row is
    // gone (a session that started while its project was being deleted).
    for (const s of liveSessions()) known.add(s.project.id);
    let orphans: ReturnType<typeof cm.findOrphanContainers>;
    let unowned: ReturnType<typeof cm.findUnownedContainers>;
    try {
      orphans = cm.findOrphanContainers(known);
      unowned = cm.findUnownedContainers(known);
    } catch (err) {
      sendJson(res, 503, { error: `docker unavailable: ${(err as Error).message}` });
      return true;
    }
    // ARCH-020: a project's own builder (and its cache volume) is an orphan
    // too once the project is gone; it carries no claude-station=1 label, and is
    // scoped by the same owner key (`dataKey()` reads `ownerKey()`).
    if (m === 'GET') {
      sendJson(res, 200, { orphans, unowned, builders: cm.findOrphanProjectBuilders(known) });
      return true;
    }
    if (m === 'POST') {
      // ARCH-022: one lifecycle operation PER orphan project, each re-checking under that project's slot
      // that the registry still does not know it (a project registered meanwhile is never swept). Its
      // containers, builders and service infra (FEAT-112: network + data volumes) go in that operation.
      const swept = await cm.sweepOrphans((pid) => !!reg.getProject(pid));
      sendJson(res, 200, { removed: swept.removed, unowned, builders: swept.builders, serviceInfra: { ...swept.infra, unowned: svc.unownedServiceInfra(known) } });
      return true;
    }
  }

  /* templates */
  if (rest[0] === 'templates') {
    if (rest.length === 1 && m === 'GET') {
      // FEAT-077: cheap usage signal — how many registered projects attach each
      // template (any ref for that id in settings.instructions, enabled or not).
      // Makes never-used templates (the opt-in patterns show 0) obvious at a
      // glance. Pure read over the registry; no injection semantics touched.
      const projects = reg.listProjects();
      const attachedCount = (id: string) =>
        projects.filter((p) => (p.settings.instructions ?? []).some((r) => r.templateId === id)).length;
      sendJson(res, 200, {
        templates: tpl
          .listTemplates()
          .map(({ body, ...meta }) => ({ ...meta, bodyChars: body.length, attachedCount: attachedCount(meta.id) })),
      });
      return true;
    }
    if (rest.length === 1 && m === 'POST') {
      const raw = (await readBody(req)) as Record<string, unknown>;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        sendJson(res, 400, { error: 'body must be a JSON object' });
        return true;
      }
      if (typeof raw.name !== 'string' || !raw.name.trim()) {
        sendJson(res, 400, { error: 'name must be a non-empty string' });
        return true;
      }
      if (typeof raw.body !== 'string') {
        sendJson(res, 400, { error: 'body must be a string' });
        return true;
      }
      if (raw.defaultMode !== undefined && raw.defaultMode !== 'append' && raw.defaultMode !== 'replace') {
        sendJson(res, 400, { error: 'defaultMode must be "append" or "replace"' });
        return true;
      }
      try {
        sendJson(res, 200, { template: tpl.saveTemplate(raw as unknown as tpl.SaveTemplateInput) });
      } catch (err) {
        if (err instanceof tpl.TemplateConflictError) {
          sendJson(res, 409, { error: err.message, code: 'template-exists', id: err.id });
          return true;
        }
        throw err;
      }
      return true;
    }
    const id = rest[1];
    if (id && rest.length === 2 && m === 'GET') {
      const t = tpl.readTemplate(id);
      if (!t) return notFound(res, `no template ${id}`);
      sendJson(res, 200, { template: t });
      return true;
    }
    if (id && rest.length === 2 && m === 'DELETE') {
      sendJson(res, 200, { deleted: tpl.deleteTemplate(id) });
      return true;
    }
  }

  /* preview the composed system prompt for a project — makes the stack auditable */
  if (rest[0] === 'compose' && rest[1] && m === 'GET') {
    const p = reg.getProject(rest[1]);
    if (!p) return notFound(res, `no project ${rest[1]}`);
    const c = tpl.composeInstructions(p.settings.instructions);
    sendJson(res, 200, {
      mode: c.mode,
      appliedIds: c.appliedIds,
      supersededIds: c.supersededIds,
      missingIds: c.missingIds,
      chars: typeof c.systemPrompt === 'string' ? c.systemPrompt.length : (c.systemPrompt?.append.length ?? 0),
      preview:
        typeof c.systemPrompt === 'string'
          ? c.systemPrompt.slice(0, 800)
          : (c.systemPrompt?.append.slice(0, 800) ?? ''),
    });
    return true;
  }

  return false;
}

function notFound(res: http.ServerResponse, message: string): boolean {
  sendJson(res, 404, { error: message });
  return true;
}

/* --------------------------------------------------------- subagent history */

/**
 * GET /api/sessions/:sessionId/subagents            [?dir=<encodedDir>]
 * GET /api/sessions/:sessionId/subagents/:agentId/messages
 *       [?dir=&limit=&offset=&tools=1&maxTextChars=]
 *
 * Same `intParam` discipline as the main transcript route: `?limit=abc` is a
 * 400, never a silent full dump.
 */
function handleSubagentRoute(
  res: http.ServerResponse,
  url: URL,
  sessionRef: string,
  agentId: string | undefined,
  tail: string | undefined,
): boolean {
  // Station session id -> the SDK session id its transcript is filed under.
  const live = getSession(sessionRef);
  const sessionId = live?.sdkSessionId ?? sessionRef;
  if (live && !live.sdkSessionId) {
    sendJson(res, 409, { error: `session ${sessionRef} has not reported an SDK session id yet — no transcript exists on disk to read` });
    return true;
  }

  let encodedDir = url.searchParams.get('dir') ?? undefined;
  if (!encodedDir) {
    const dirs = sub.findDirsForSession(sessionId);
    if (dirs.length === 0) {
      // An honest empty list, not a 404: a session that spawned no subagents is
      // a normal state and the UI should render "none", not an error.
      if (!agentId) {
        sendJson(res, 200, { sessionId, encodedDir: null, dirs: [], subagents: [] });
        return true;
      }
      return notFound(res, `no subagent transcripts on disk for session ${sessionId}`);
    }
    if (dirs.length > 1) {
      sendJson(res, 409, {
        error: `session ${sessionId} has subagent transcripts under ${dirs.length} store dirs (${dirs.join(', ')}) — pass ?dir= to say which`,
        dirs,
      });
      return true;
    }
    encodedDir = dirs[0]!;
  }

  try {
    if (!agentId) {
      const subagents = sub.listSubagents(encodedDir, sessionId);
      // Live sessions know better than the disk does: an agent still running has
      // no parent tool_result yet, so it would otherwise read 'unknown'.
      if (live) {
        const byId = new Map(live.liveAgents().map((a) => [a.agentId, a]));
        for (const s of subagents) {
          const a = byId.get(s.agentId);
          if (!a) continue;
          s.status = a.status === 'running' ? 'running' : a.status === 'failed' || a.status === 'killed' ? 'failed' : 'completed';
          if (s.usage.total_tokens === null && a.totalTokens) s.usage.total_tokens = a.totalTokens;
          if (!s.usage.tool_uses && a.toolUses) s.usage.tool_uses = a.toolUses;
          if (s.usage.duration_ms === null && a.elapsedMs) s.usage.duration_ms = a.elapsedMs;
        }
      }
      sendJson(res, 200, { sessionId, encodedDir, subagents });
      return true;
    }
    if (tail !== 'messages') return notFound(res, `no route GET /api/sessions/:id/subagents/${agentId}/${tail ?? ''}`);
    // Same ?tail=N contract as the main transcript route.
    const tailParam = url.searchParams.get('tail');
    if (tailParam !== null) {
      const dir = sub.subagentsDir(encodedDir, sessionId);
      const file = dir ? path.join(dir, `agent-${agentId}.jsonl`) : null;
      if (!file || !fs.existsSync(file)) return notFound(res, `no subagent ${agentId} for session ${sessionId}`);
      const n = intParam(tailParam, 100, 1, 2000);
      const t0 = Date.now();
      const tools = url.searchParams.get('tools') === '1';
      const counted = tx.countMessages(file, { entryFilter: tx.subagentEntryFilter, cacheKeySuffix: 'sub', includeToolResults: tools });
      const beforeParam = url.searchParams.get('before');
      // BUG-190: clamp to the real end. The block is labelled [before - len, before), so an
      // unclamped `before` past the end relabelled the newest messages with indices that do
      // not exist (before=123 on a 3-message file answered 120..122). Only when the count is
      // exact — a lower-bound total on a huge file cannot say where the end is.
      const before = beforeParam !== null ? intParam(beforeParam, counted.total, 0, counted.isLowerBound ? Number.MAX_SAFE_INTEGER : counted.total) : counted.total;
      const skip = Math.max(0, counted.total - before);
      const r = tx.tailMessages(file, {
        limit: n,
        skip,
        includeToolResults: tools,
        maxTextChars: intParam(url.searchParams.get('maxTextChars'), 4000, 0, 200_000),
        entryFilter: tx.subagentEntryFilter,
      });
      const base = Math.max(0, before - r.messages.length);
      r.messages.forEach((m, i) => { m.index = base + i; });
      sendJson(res, 200, {
        sessionId, encodedDir, agentId, filePath: file,
        messages: r.messages, mode: 'tail', offset: base, before,
        total: counted.total, totalIsLowerBound: counted.isLowerBound,
        scannedMessages: counted.total, hasMore: base > 0,
        bytesRead: r.bytesRead, fileBytes: r.fileBytes,
        budgetExhausted: r.budgetExhausted, malformedLines: r.malformedLines,
        warnings: [], tookMs: Date.now() - t0,
      });
      return true;
    }
    const t = sub.getSubagentMessages(encodedDir, sessionId, agentId, {
      limit: intParam(url.searchParams.get('limit'), 300, 1, 2000),
      offset: intParam(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER),
      maxTextChars: intParam(url.searchParams.get('maxTextChars'), 4000, 0, 200_000),
      includeToolResults: url.searchParams.get('tools') === '1',
    });
    sendJson(res, 200, { ...t, mode: 'page', total: t.scannedMessages, totalIsLowerBound: t.budgetExhausted });
    return true;
  } catch (err) {
    const msg = (err as Error).message;
    if (err instanceof sub.SubagentError) {
      sendJson(res, err.status, { error: msg });
      return true;
    }
    if (msg.startsWith('expected an integer')) {
      sendJson(res, 400, { error: msg });
      return true;
    }
    sendJson(res, 500, { error: msg });
    return true;
  }
}

/* ------------------------------------------------------ session mutation API */

/**
 * Is this session being written to right now — by the CLI, or by us?
 *
 * Two independent signals, because either alone lies: the file-mtime window
 * misses a session that is idle mid-conversation but still owned by a live
 * bridge, and the bridge list misses a `claude` process the dashboard did not
 * start. Renaming under a live writer is merely racy; DELETING under one
 * destroys a transcript that is still being appended to.
 *
 * `ignoreMetadataWrite` is passed ONLY by the append-only mutations: a rename
 * bumps the mtime itself, and without this the pin that follows it 409s. Delete
 * never sets it — for the one irreversible route the strict mtime window is
 * exactly the caution wanted, and waiting out the 30s window costs nothing next
 * to destroying a transcript that is still being written.
 */
function liveHoldersOf(target: smut.ResolvedSession, ignoreMetadataWrite = false): { fileLive: boolean; bridges: { stationSessionId: string; busy: boolean }[] } {
  const bridges = liveSessions()
    .filter((s) => s.sdkSessionId === target.sessionId)
    .map((s) => ({ stationSessionId: s.id, busy: s.busy }));
  const fileLive =
    watcher.isSessionLive(target.encodedDir, target.sessionId) &&
    !(ignoreMetadataWrite && smut.lastWriteWasMetadata(target.filePath));
  return { fileLive, bridges };
}

function sessionMutationFail(res: http.ServerResponse, err: unknown): boolean {
  if (err instanceof smut.SessionMutationError) {
    sendJson(res, err.status, { error: err.message, code: err.code, ...err.detail });
    return true;
  }
  if (err instanceof sessionClosed.SessionCloseError) { // FEAT-168 r6 — a close never stores a guessed watermark
    sendJson(res, err.status, { error: err.message, code: err.code });
    return true;
  }
  sendJson(res, 500, { error: (err as Error).message, code: 'unknown' });
  return true;
}

/** The shape the UI re-renders a row from after any mutation. */
function sessionStateOf(t: smut.ResolvedSession, meta: smut.TitleMeta) {
  const hm = hist.readSessionMeta(t.filePath, t.encodedDir);
  return {
    sessionId: t.sessionId,
    encodedDir: t.encodedDir,
    cwd: t.cwd,
    displayTitle: meta.customTitle ?? hm?.displayTitle ?? '(untitled session)',
    customTitle: meta.customTitle,
    autoTitle: meta.autoTitle ?? hm?.title ?? null,
    titleSource: smut.titleSourceOf(meta),
    titleMetaSampled: meta.sampled,
    pinned: meta.pinned,
    closed: sessionClosed.isSessionClosed(t.sessionId, t.filePath), // FEAT-168 — the same derived read the list uses
    tag: meta.tag,
  };
}

/**
 * PATCH  /api/sessions/:sessionId   {title?, pinned?, dir?}
 * DELETE /api/sessions/:sessionId   ?dir=&confirm=<sessionId>
 *
 * `dir` is the ENCODED store dir the sidebar already holds. It is optional only
 * while exactly one store dir holds the id; otherwise the resolver 409s with
 * the candidates rather than guessing (this machine dual-boots, so the same
 * transcript routinely exists under two dirs).
 */
async function handleSessionMutation(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  sessionId: string,
  method: 'PATCH' | 'DELETE',
): Promise<boolean> {
  let body: Record<string, unknown>;
  try {
    body = ((await readBody(req)) ?? {}) as Record<string, unknown>;
  } catch (err) {
    sendJson(res, err instanceof HttpError ? err.status : 400, { error: (err as Error).message });
    return true;
  }

  if (method === 'DELETE') {
    /*
     * CONFIRMATION IS THE ECHOED SESSION ID, not a boolean.
     *
     * A bare `DELETE /api/sessions/:id` — the request a mis-wired button or a
     * retried fetch would send — does nothing. `?confirm=1` is not enough
     * either: the caller has to name the exact session it means, so a confirm
     * token copied onto the wrong row cannot fire.
     */
    const confirm = url.searchParams.get('confirm') ?? (typeof body.confirm === 'string' ? body.confirm : null);
    if (confirm !== sessionId) {
      sendJson(res, 400, {
        error:
          `refusing to delete session ${sessionId}: this route destroys real transcript history, so it requires the session id echoed back as confirmation ` +
          `(?confirm=${sessionId}, or {"confirm":"${sessionId}"} in the body). Received ${JSON.stringify(confirm)}.`,
        code: 'confirmation-required',
        deleted: false,
        sessionId,
      });
      return true;
    }
    let target: smut.ResolvedSession;
    try {
      target = smut.resolveSession(sessionId, url.searchParams.get('dir') ?? (typeof body.dir === 'string' ? body.dir : null), declaredContainerStore);
    } catch (err) {
      return sessionMutationFail(res, err);
    }
    const live = liveHoldersOf(target);
    if (live.fileLive || live.bridges.length) {
      // Deliberately NOT overridable by ?force=1: unlike stopping a container,
      // there is no recovery path worth offering for deleting a transcript that
      // is still being appended to. Close the session first.
      sendJson(res, 409, {
        error:
          `refusing to delete session ${sessionId}: it is LIVE (${live.fileLive ? 'its file was written to within the live window' : 'no recent write'}` +
          `${live.bridges.length ? `, ${live.bridges.length} dashboard bridge(s) attached` : ''}). ` +
          `Close the session and let it settle, then retry. There is no force flag for this.`,
        code: 'live-session',
        deleted: false,
        sessionId,
        encodedDir: target.encodedDir,
        fileLive: live.fileLive,
        liveSessions: live.bridges,
      });
      return true;
    }
    try {
      const report = await smut.destroy(target);
      sendJson(res, 200, { deleted: true, ...report });
    } catch (err) {
      return sessionMutationFail(res, err);
    }
    return true;
  }

  /* ---- PATCH ---- */
  let patch;
  try {
    patch = validateSessionPatch(body);
  } catch (err) {
    sendJson(res, 400, { error: (err as Error).message });
    return true;
  }
  let target: smut.ResolvedSession;
  try {
    target = smut.resolveSession(sessionId, patch.dir ?? url.searchParams.get('dir'), declaredContainerStore);
  } catch (err) {
    return sessionMutationFail(res, err);
  }
  /*
   * A rename or a pin only APPENDS a metadata entry, so it cannot corrupt a
   * transcript the way a delete can — but a live CLI holds its own view of the
   * title and would keep writing under it. Refuse unless forced, and say so.
   */
  // FEAT-168: `closed` is Orchard's own label (session-closed.ts) and never
  // touches the transcript, so it is independent of pin/title. A close-only PATCH has the /close route's contract: closing is a LABEL, so a
  // live session may be closed (no live refusal). Title/pin keep the live guard.
  const closeOnly = patch.closed !== undefined && patch.title === undefined && patch.pinned === undefined;
  const live = liveHoldersOf(target, true);
  if (!closeOnly && (live.fileLive || live.bridges.length) && url.searchParams.get('force') !== '1') {
    sendJson(res, 409, {
      error:
        `session ${sessionId} is live — a rename/pin appends to the file it is currently writing, and the running CLI will not notice the change. ` +
        `Close it first, or retry with ?force=1.`,
      code: 'live-session',
      sessionId,
      encodedDir: target.encodedDir,
      fileLive: live.fileLive,
      liveSessions: live.bridges,
    });
    return true;
  }
  try {
    let meta = smut.readTitleMeta(target.filePath);
    if (patch.title !== undefined) meta = await smut.rename(target, patch.title);
    if (patch.pinned !== undefined) meta = await smut.setPinned(target, patch.pinned, url.searchParams.get('force') === '1');
    // FEAT-168: Orchard's own store; the transcript is only READ (the close watermark), never written.
    if (patch.closed !== undefined) sessionClosed.setSessionClosed(target, patch.closed);
    sendJson(res, 200, { session: sessionStateOf(target, meta) });
  } catch (err) {
    return sessionMutationFail(res, err);
  }
  return true;
}

/**
 * POST   /api/sessions/:sessionId/pin  [?dir=&force=1]
 * DELETE /api/sessions/:sessionId/pin  [?dir=&force=1]
 *
 * The same operation PATCH {pinned} performs, given its own verb because the
 * context menu fires a pin toggle on its own and a POST/DELETE pair is the
 * honest shape for "add/remove this one flag" — no body to get wrong, and it
 * cannot accidentally carry a title along with it. PATCH stays the rename path.
 */
async function handleSessionPin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  sessionId: string,
  pinned: boolean,
): Promise<boolean> {
  let body: Record<string, unknown> = {};
  try {
    body = ((await readBody(req)) ?? {}) as Record<string, unknown>;
  } catch {
    body = {};
  }
  let target: smut.ResolvedSession;
  try {
    target = smut.resolveSession(sessionId, url.searchParams.get('dir') ?? (typeof body.dir === 'string' ? body.dir : null), declaredContainerStore);
  } catch (err) {
    return sessionMutationFail(res, err);
  }
  const live = liveHoldersOf(target, true);
  if ((live.fileLive || live.bridges.length) && url.searchParams.get('force') !== '1') {
    sendJson(res, 409, {
      error: `session ${sessionId} is live — pinning appends to the file it is currently writing. Close it first, or retry with ?force=1.`,
      code: 'live-session',
      sessionId,
      encodedDir: target.encodedDir,
      fileLive: live.fileLive,
      liveSessions: live.bridges,
    });
    return true;
  }
  try {
    const meta = await smut.setPinned(target, pinned, url.searchParams.get('force') === '1');
    sendJson(res, 200, { session: sessionStateOf(target, meta) });
  } catch (err) {
    return sessionMutationFail(res, err);
  }
  return true;
}

/**
 * POST   /api/sessions/:sessionId/close  [?dir=]   — mark CLOSED (done)
 * DELETE /api/sessions/:sessionId/close  [?dir=]   — reopen
 *
 * FEAT-168. Shaped like the pin route, but the label is Orchard's OWN fact
 * (session-closed.ts in the data dir), so the transcript is never written (a
 * close only READS its latest input prompt as the watermark; 503 if it cannot):
 * there is no tag to collide with, no force, and no live-session
 * refusal (closing is a label — "nothing pending" — not a lifecycle action, so a
 * running session may be closed). The session must exist (resolveSession), so a
 * label is never minted for an id with no transcript.
 */
async function handleSessionClose(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  sessionId: string,
  closed: boolean,
): Promise<boolean> {
  let body: Record<string, unknown> = {};
  try {
    body = ((await readBody(req)) ?? {}) as Record<string, unknown>;
  } catch {
    body = {};
  }
  let target: smut.ResolvedSession;
  try {
    target = smut.resolveSession(sessionId, url.searchParams.get('dir') ?? (typeof body.dir === 'string' ? body.dir : null), declaredContainerStore);
  } catch (err) {
    return sessionMutationFail(res, err);
  }
  try {
    sessionClosed.setSessionClosed(target, closed);
    sendJson(res, 200, { session: sessionStateOf(target, smut.readTitleMeta(target.filePath)) });
  } catch (err) {
    return sessionMutationFail(res, err);
  }
  return true;
}

/* ------------------------------------------------------------- browser API */

/**
 * GET  /api/projects/:id/browser/status
 * POST /api/projects/:id/browser/start | /stop | /reap
 *
 * Mirrors the container routes: real errors with the adapter's own output
 * attached, and a 409 when a destructive action would pull the browser out from
 * under live sessions.
 */
function handleBrowserRoute(
  res: http.ServerResponse,
  projectId: string,
  action: string | undefined,
  method: string,
  url: URL,
): boolean {
  const project = reg.getProject(projectId);
  if (!project) return notFound(res, `no project ${projectId}`);

  const avail = browser.available();
  const settings = reg.browserSettingsOf(project);

  const fail = (err: unknown) => {
    const e = err as Error;
    const be = err instanceof browser.BrowserError ? err : null;
    sendJson(res, be?.code === 'adapter-missing' ? 503 : 500, {
      error: e.message,
      code: be?.code ?? 'unknown',
      detail: be?.detail || undefined,
      running: false,
      projectId,
    });
    return true;
  };

  try {
    if ((action === 'status' || action === undefined) && method === 'GET') {
      // Status answers even when the adapter is missing or the browser is off —
      // the UI needs to render *why* it cannot be used, not a bare error.
      if (!avail.ok) {
        sendJson(res, 200, {
          projectId, enabled: settings.enabled, available: false, reason: avail.message,
          running: false, socket: null, repo: browser.repoDir(),
        });
        return true;
      }
      const st = browser.status(project);
      sendJson(res, 200, {
        projectId,
        enabled: settings.enabled,
        idleMs: settings.idleMs,
        available: true,
        repo: browser.repoDir(),
        ...st,
        // Mounted into the container only when isolation is container.
        containerMounts: project.isolation === 'container' ? browser.browserBinds(project) : [],
      });
      return true;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { error: `method ${method} not allowed on /browser/${action ?? ''}` });
      return true;
    }
    if (!avail.ok) return fail(new browser.BrowserError('adapter-missing', avail.message));

    switch (action) {
      case 'start': {
        if (!settings.enabled && url.searchParams.get('force') !== '1') {
          sendJson(res, 409, {
            error: `project ${projectId} does not have the stealth browser enabled — turn on settings.browser.enabled first, or retry with ?force=1`,
            code: 'not-enabled',
            enabled: false,
          });
          return true;
        }
        sendJson(res, 200, { projectId, ...browser.start(project, settings.idleMs ?? undefined) });
        return true;
      }
      case 'stop': {
        /*
         * Live sessions have the MCP shim connected to this socket. Stopping the
         * browser under them makes every later browser tool call fail with a
         * connection error the model cannot explain, so it needs the same
         * explicit force as the container routes.
         */
        const live = liveSessionsForProject(projectId).filter((s) => s.browserAttached);
        if (live.length && url.searchParams.get('force') !== '1') {
          sendJson(res, 409, {
            error: `refusing to stop the browser: ${live.length} live session(s) have it attached and their browser tools would start failing. Close them first, or retry with ?force=1.`,
            code: 'live-sessions',
            liveSessions: live.map((s) => ({ stationSessionId: s.id, sdkSessionId: s.sdkSessionId })),
          });
          return true;
        }
        const r = browser.stop(project);
        sendJson(res, 200, { projectId, ...r, forcedOverLiveSessions: live.map((s) => s.id) });
        return true;
      }
      case 'reap':
        sendJson(res, 200, browser.reap());
        return true;
      default:
        return notFound(res, `no browser action "${action}"`);
    }
  } catch (err) {
    return fail(err);
  }
}

/* ---------------------------------------------------------- snapshots API */

/**
 * GET    /api/projects/:id/snapshots
 * POST   /api/projects/:id/snapshots                  {label?}
 * POST   /api/projects/:id/snapshots/:snapId/restore  [?force=1]
 * DELETE /api/projects/:id/snapshots/:snapId
 *
 * Failure discipline is the container route's: a reflink that could not happen
 * is a real error carrying the real reason, never a cheerful 200. In particular
 * nothing here EVER falls back to a byte-for-byte copy.
 */
async function handleSnapshotsRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  projectId: string,
  snapId: string | undefined,
  tail: string | undefined,
  method: string,
  url: URL,
): Promise<boolean> {
  const project = reg.getProject(projectId);
  if (!project) return notFound(res, `no project ${projectId}`);

  const fail = (err: unknown) => {
    const e = err as Error;
    const se = err instanceof snaps.SnapshotError ? err : null;
    // 409 for "this machine/layout cannot do it" (a conflict with reality the
    // user can fix), 500 for anything genuinely unexpected.
    const status = se && ['cross-filesystem', 'reflink-unsupported', 'store-inside-project', 'no-project-dir'].includes(se.code)
      ? 409
      : se?.code === 'no-snapshot'
        ? 404
        : 500;
    sendJson(res, status, { error: e.message, code: se?.code ?? 'unknown', detail: se?.detail ?? null, projectId });
    return true;
  };

  try {
    /* ---- collection ---- */
    if (snapId === undefined) {
      if (method === 'GET') {
        const cfg = reg.snapshotSettingsOf(project);
        sendJson(res, 200, {
          projectId,
          // Resolved, so the UI never has to re-implement the `enabled: null`
          // auto rule and disagree with the server about it.
          settings: cfg,
          store: snaps.projectSnapshotDir(projectId),
          fsType: snaps.fsTypeOf(project.hostPath),
          snapshots: snaps.list(projectId).map(snaps.toSummary),
        });
        return true;
      }
      if (method === 'POST') {
        const body = (await readBody(req)) as { label?: unknown };
        if (body.label !== undefined && body.label !== null && typeof body.label !== 'string') {
          sendJson(res, 400, { error: 'label must be a string or null' });
          return true;
        }
        const r = snaps.create(project, { reason: 'manual', label: (body.label as string | null) ?? null });
        sendJson(res, r.deduped ? 200 : 201, {
          snapshot: snaps.toSummary(r.meta),
          // Truthful: a dedupe is NOT a new snapshot, and the UI must not append
          // a second row for it.
          deduped: r.deduped,
          pruned: r.pruned,
        });
        return true;
      }
      sendJson(res, 405, { error: `method ${method} not allowed on /snapshots` });
      return true;
    }

    /* ---- one snapshot ---- */
    if (tail === undefined && method === 'DELETE') {
      const existed = snaps.remove(projectId, snapId);
      if (!existed) return notFound(res, `no snapshot ${snapId} for project ${projectId}`);
      sendJson(res, 200, { deleted: snapId, remaining: snaps.list(projectId).length });
      return true;
    }
    if (tail === undefined && method === 'GET') {
      const m = snaps.get(projectId, snapId);
      if (!m) return notFound(res, `no snapshot ${snapId} for project ${projectId}`);
      sendJson(res, 200, { snapshot: m });
      return true;
    }

    if (tail === 'restore') {
      if (method !== 'POST') {
        sendJson(res, 405, { error: `method ${method} not allowed on /snapshots/${snapId}/restore` });
        return true;
      }
      /*
       * LIVE-SESSION GUARD. Same shape as the container route.
       *
       * Restoring under a live session swaps the working tree out from beneath
       * an agent that is mid-edit: its next write lands in a tree it never read,
       * and the transcript stops describing reality. Refuse, and on ?force=1 say
       * exactly who gets disrupted rather than reporting a bare success.
       */
      const live = liveSessionsForProject(projectId);
      const forced = url.searchParams.get('force') === '1';
      if (live.length && !forced) {
        sendJson(res, 409, {
          error:
            `refusing to restore snapshot ${snapId} into ${project.hostPath}: ${live.length} session(s) are LIVE on this project. ` +
            `A restore replaces the working tree underneath them — an agent mid-edit would continue against a tree it never read, ` +
            `and any file it writes next could resurrect the state you are trying to undo. ` +
            `Close them first, or retry with ?force=1.`,
          code: 'live-sessions',
          liveSessions: live.map((s) => ({
            stationSessionId: s.id,
            sdkSessionId: s.sdkSessionId,
            busy: s.busy,
            // "busy" is the sharp end: a busy session is actively mid-turn.
            disruption: s.busy
              ? 'MID-TURN: the agent is running right now and will keep writing into the restored tree'
              : 'idle but attached: its next turn starts from a tree it has not read',
          })),
          containerName: project.isolation === 'container' ? cm.containerName(projectId) : null,
        });
        return true;
      }
      const report = snaps.restore(project, snapId, { forced: forced && live.length > 0 });
      sendJson(res, 200, {
        ...report,
        // Anything forced over a live session says so in the success payload too,
        // so "it worked" is never mistaken for "nothing was disrupted".
        forcedOverLiveSessions: forced ? live.map((s) => ({ stationSessionId: s.id, sdkSessionId: s.sdkSessionId, busy: s.busy })) : [],
        note:
          `Restored the tree as of ${report.snapshotCreatedAt}. ` +
          `Excluded directories were NOT captured and were left exactly as they are: ` +
          `${report.preservedExcluded.length ? report.preservedExcluded.join(', ') : 'none present'} ` +
          `(exclusions: ${report.exclusions.join(', ') || 'none'}). ` +
          `${report.removed.length ? `Removed ${report.removed.length} top-level entr(y/ies) that did not exist in the snapshot: ${report.removed.join(', ')}. ` : 'Nothing extra needed removing. '}` +
          `Undo this with snapshot ${report.preRestoreSnapshotId}.`,
      });
      return true;
    }

    return notFound(res, `no route ${method} ${url.pathname}`);
  } catch (err) {
    return fail(err);
  }
}

/* ---------------------------------------------------------- container API */

/**
 * GET  /api/projects/:id/container/status
 * POST /api/projects/:id/container/start | /stop | /rebuild
 *
 * Every failure here is reported as a real error with the docker detail
 * attached. Nothing in this file may answer "ok" for a container that isn't
 * actually running.
 */
/**
 * FEAT-151 — the runtime version + on-demand host-SDK update surface.
 *
 * A dedicated sub-handler mirroring handleContainerRoute, reusing sendJson /
 * readBody. Two runtimes are surfaced (host SDK-bundled CLI, container baked
 * CLI); only the HOST one updates in place here — the container update WRITES the
 * provision.json pin (finding #5) and leaves the rebuild to each project's own
 * schedule (never force-restarting a live container).
 */
async function handleRuntimeRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  action: string | undefined,
  method: string,
): Promise<boolean> {
  // GET /api/runtime/version — versions + update-available. Best-effort registry;
  // never 500 on a network error (the payload carries latest.error instead).
  if ((action === 'version' || action === undefined) && method === 'GET') {
    const base = await rt.runtimeVersionPayload();
    // Container is PER-PROJECT (finding #8): the machine-level facts are the
    // desired pin and the target it must track (the host SDK's bundled CLI),
    // plus each container project's ACTUAL baked image CLI. Nothing is inferred
    // "up to date" from an unknown; a missing label reads as null.
    // FEAT-157: containers no longer carry a pinned CLI. Each gets the host SDK's own
    // boot-proven binary as a layer, so "desired" IS the host's; nothing can lag it.
    const targetCli = rt.bundledCliVersion(); // the CLI the host SDK bundles (disk)
    const desiredCli = rt.BOOT_CLI_VERSION ?? targetCli ?? 'unknown';
    const pinBehindTarget = false;
    const projects = reg.listProjects()
      .filter((p) => p.isolation === 'container')
      .map((p) => {
        try {
          const st = cm.containerProvisionState(p);
          return { id: p.id, name: p.name, state: st.state, custom: st.custom, imageClaudeVersion: st.imageClaudeVersion };
        } catch (err) {
          return { id: p.id, name: p.name, state: 'unknown', custom: false, imageClaudeVersion: null, error: (err as Error).message };
        }
      });
    sendJson(res, 200, {
      ...base,
      container: {
        desiredCli,
        targetCli,
        latestCli: base.latest.cli,
        pinBehindTarget,
        projects,
      },
    });
    return true;
  }

  if (method !== 'POST') {
    sendJson(res, 405, { error: `method ${method} not allowed on /runtime/${action ?? ''}` });
    return true;
  }

  /*
   * finding #2 — ORIGIN + CONTENT-TYPE GUARD on the mutation. The global Host
   * check runs already; readBody parses any content-type, and the WS Origin
   * allowlist does not cover HTTP. So a foreign page could text/plain-POST valid
   * JSON to localhost. Reject cross-origin/null-listed origins and any non-JSON
   * content type BEFORE spawning npm or touching provision.json. A browser always
   * sends Origin on a cross-site fetch; a missing Origin is a non-browser client
   * (CLI/curl) and is allowed, exactly like the WS handshake rule.
   */
  const origin = req.headers.origin as string | undefined;
  if (origin !== undefined && !originAllowed(origin)) {
    sendJson(res, 403, { error: `forbidden: Origin "${origin}" not allowed` });
    return true;
  }
  const ctype = String(req.headers['content-type'] ?? '');
  if (!/^application\/json\b/i.test(ctype)) {
    sendJson(res, 415, { error: `unsupported content-type ${JSON.stringify(ctype || '(none)')}; application/json required` });
    return true;
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await readBody(req)) as Record<string, unknown>;
  } catch (err) {
    sendJson(res, 400, { error: `invalid JSON body: ${(err as Error).message}` });
    return true;
  }

  // POST /api/runtime/update { target:'host', version? } — install & pin the SDK.
  if (action === 'update') {
    const target = body.target ?? 'host';
    if (target !== 'host') {
      sendJson(res, 400, { error: `target ${JSON.stringify(target)} is not updatable in place; use the container pin route`, code: 'bad-target' });
      return true;
    }
    const version = body.version === undefined ? undefined : String(body.version);
    try {
      const result = await rt.updateHostRuntime({ version });
      if (!result.ok) {
        sendJson(res, 500, result);
        return true;
      }
      sendJson(res, 200, result);
      return true;
    } catch (err) {
      if (err instanceof rt.UpdateInProgressError) {
        sendJson(res, 409, { ok: false, error: err.message, code: 'update-in-progress' });
        return true;
      }
      sendJson(res, 500, { ok: false, error: (err as Error).message });
      return true;
    }
  }

  // POST /api/runtime/container-pin — RETIRED by FEAT-157. The container CLI is no
  // longer a pin in provision.json: every container gets the host SDK's own
  // boot-proven CLI as a thin layer, so there is nothing to update by hand. 410 with
  // the reason, rather than a silent success that changes nothing.
  if (action === 'container-pin') {
    sendJson(res, 410, {
      ok: false,
      code: 'container-cli-follows-host',
      error: 'The container Claude CLI now follows the host SDK automatically (FEAT-157): each container gets the host\'s CLI as a thin layer at its next launch with no live session. There is no container pin to update.',
      version: rt.BOOT_CLI_VERSION,
    });
    return true;
  }

  return notFound(res, `no runtime action "${action ?? ''}"`);
}

async function handleContainerRoute(
  res: http.ServerResponse,
  projectId: string,
  action: string | undefined,
  method: string,
  url: URL,
): Promise<boolean> {
  const project = reg.getProject(projectId);
  if (!project) return notFound(res, `no project ${projectId}`);

  if (project.isolation === 'sandbox') {
    sendJson(res, 501, {
      error: 'isolation "sandbox" (bubblewrap) is modelled but not implemented',
      isolation: 'sandbox',
      projectId,
    });
    return true;
  }
  if (project.isolation !== 'container') {
    sendJson(res, 409, {
      error: `project ${projectId} has isolation "${project.isolation}" — set it to "container" first`,
      isolation: project.isolation,
    });
    return true;
  }

  const fail = (err: unknown) => {
    const e = err as Error;
    const ce = err instanceof cm.ContainerError ? err : null;
    sendJson(res, ce?.code === 'docker-missing' || ce?.code === 'docker-unavailable' ? 503 : ce?.code === 'live-sessions' ? 409 : 500, {
      error: e.message,
      code: ce?.code ?? 'unknown',
      state: 'error',
      containerName: cm.containerName(projectId),
    });
    return true;
  };

  /*
   * ARCH-022 — no guard here. Whether start/stop/rebuild/remove may destroy anything is decided by the
   * container lifecycle authority INSIDE the operation (the project's FIFO slot), from the lease set it
   * holds, and enforced again at the docker call itself. A refusal comes back as `live-sessions` (409).
   * The per-route cached-status guard that used to stand here was one of the enumerated doors (BUG-214).
   */

  try {
    if ((action === 'status' || action === undefined) && method === 'GET') {
      if (cm.isBuilding(project.id)) {
        sendJson(res, 200, {
          state: 'building', containerName: cm.containerName(project.id), image: cm.imageNameFor(project),
          ...(cm.imageSourceOf(project) === 'dockerfile' ? { dockerfile: cm.dockerfileStatus(project) } : {}),
        });
        return true;
      }
      sendJson(res, 200, cm.statusOf(project));
      return true;
    }
    /*
     * FEAT-155 round 5 — GET /api/projects/:id/container/build: the project
     * Dockerfile build — state, error, the last good image, and the (sanitised)
     * log tail. Read-only; 404 when the project does not build from a Dockerfile.
     */
    if (action === 'build' && method === 'GET') {
      if (cm.imageSourceOf(project) !== 'dockerfile') {
        sendJson(res, 404, { error: `project ${projectId} does not build its image from a Dockerfile (set container.dockerfile)` });
        return true;
      }
      const rec = buildRecord(project.id);
      sendJson(res, 200, { ...cm.dockerfileStatus(project), log: rec.log });
      return true;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { error: `method ${method} not allowed on /container/${action ?? ''}` });
      return true;
    }
    /*
     * ?force=1 is consent for the sessions holding the project AT REQUEST TIME only: their leases are
     * captured now, their sessions closed, and the operation reaps and waits for exactly those. A session
     * admitted after this request is protected.
     */
    const force = url.searchParams.get('force') === '1';
    const forceOver = force && action !== 'start' ? lifecycle.leasesOf(projectId).map((l) => l.id) : undefined;
    const forcedSessions = force && action !== 'start' ? liveSessionsForProject(projectId).map((s) => s.id) : [];
    if (forceOver) for (const s of liveSessionsForProject(projectId)) void s.close(`container ${action} (forced)`).catch(() => {});
    const withCasualties = (status: unknown) =>
      forcedSessions.length ? { ...(status as object), forcedOverLiveSessions: forcedSessions } : status;
    const current = () => reg.getProject(projectId);
    switch (action) {
      case 'start': {
        // An image-only change defers under held leases; any other drift refuses (409) — never recreates.
        sendJson(res, 200, await cm.ensureContainer(project, { current }));
        return true;
      }
      case 'stop': {
        sendJson(res, 200, withCasualties(await cm.stopContainer(project, { current, forceOver })));
        return true;
      }
      case 'rebuild': {
        sendJson(res, 200, withCasualties(await cm.rebuildContainer(project, { current, forceOver })));
        return true;
      }
      case 'remove': {
        sendJson(res, 200, withCasualties(await cm.removeProjectContainer(project, { current, forceOver })));
        return true;
      }
      default:
        return notFound(res, `no container action "${action}"`);
    }
  } catch (err) {
    return fail(err);
  }
}

/* ------------------------------------------------------------------- server */

/**
 * BUG-076 — the browser same-origin policy does NOT gate WebSocket *connection
 * establishment*: a cross-origin attacker page can open `ws://127.0.0.1:PORT/ws`
 * and send a `start` (incl. `bypassPermissions`) unless the SERVER checks the
 * Origin header it is required to send. The 127.0.0.1 binding is not, on its
 * own, the boundary the README implied. Two proportionate checks close it:
 *
 *  - Origin allowlist on the WS upgrade: a browser ALWAYS attaches `Origin` to a
 *    cross-site handshake, so a foreign origin is rejected — while a MISSING
 *    Origin (the CLI, dispatch runner, any non-browser client) is allowed, and
 *    the same-origin dashboard's `http://127.0.0.1:PORT` matches.
 *  - Host allowlist on both HTTP and WS: blunts DNS-rebinding, where a stable
 *    attacker domain resolves to 127.0.0.1 so the page is "same-origin" to
 *    itself — the Host header then carries the attacker domain, not
 *    127.0.0.1/localhost, and the request is rejected before any handler runs.
 *
 * Both allowlists are env-overridable (comma-separated, ADDED to the localhost
 * defaults) for legitimate reverse-proxy setups.
 */
const ALLOWED_ORIGINS = new Set<string>([
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
  ...(process.env.CLAUDE_STATION_ALLOWED_ORIGINS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean),
]);
const ALLOWED_HOSTS = new Set<string>([
  `127.0.0.1:${PORT}`,
  `localhost:${PORT}`,
  ...(process.env.CLAUDE_STATION_ALLOWED_HOSTS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean),
]);
/* ═══════════════ FEAT-157 — base-update answers over HTTP (logic: base-updates.ts) ═══ */

async function handleBaseUpdate(req: http.IncomingMessage, res: http.ServerResponse, p: reg.Project, actor: 'user' | 'agent'): Promise<boolean> {
  const origin = req.headers.origin as string | undefined;
  if (origin !== undefined && !originAllowed(origin)) { sendJson(res, 403, { error: `forbidden: Origin "${origin}" not allowed` }); return true; }
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) {
    sendJson(res, 415, { error: 'application/json required' });
    return true;
  }
  let body: Record<string, unknown>;
  try { body = ((await readBody(req)) ?? {}) as Record<string, unknown>; } catch (err) { sendJson(res, 400, { error: (err as Error).message }); return true; }
  const out = await applyBaseUpdate(p.id, actor, body);
  sendJson(res, out.status, out.body);
  return true;
}

// FEAT-157 — a container project's agent answers its OWN project's notice over its dispatch socket.
registerBaseOp();

/**
 * No `Origin` header = a non-browser client (CLI / dispatch / curl): browsers
 * always attach one to a cross-site WS handshake, so absence means the same-
 * origin policy is simply not in play. Present ⇒ must be on the allowlist.
 */
function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  return ALLOWED_ORIGINS.has(origin);
}
/** HTTP/1.1 requires Host; a foreign/absent Host is a rebinding signal → reject. */
function hostAllowed(host: string | undefined): boolean {
  return host !== undefined && ALLOWED_HOSTS.has(host);
}

const server = http.createServer((req, res) => {
  if (!hostAllowed(req.headers.host)) {
    // BUG-076: DNS-rebinding guard — a foreign Host means the request did not
    // arrive via the localhost boundary. Reject before routing.
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'forbidden: Host not allowed' }));
    return;
  }
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  void (async () => {
    try {
      if (url.pathname.startsWith('/api/')) {
        if (await handleApi(req, res, url)) return;
        sendJson(res, 404, { error: `no route ${req.method} ${url.pathname}` });
        return;
      }
      if (serveStatic(res, url.pathname)) return;
      sendJson(res, 404, { error: `not found: ${url.pathname}` });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      sendJson(res, status, { error: (err as Error).message });
    }
  })();
});

/**
 * BUG-043 — THE ONE PLACE that decides what a dropped driving socket does to a
 * session. Both ways a socket goes away route here: the client's explicit
 * `{type:'close'}` (sent by `closeSocket()` on EVERY session switch / New /
 * navigation / reopen) and a raw `ws.on('close')`.
 *
 * The decision used to be `busy ? detach() : close()`, and `busy` is TURN-scoped:
 * it goes false at `result` while background subagents keep working. So a
 * session with live background agents looked idle, got CLOSED, and `close()`
 * reaps the broker — whose unconditional SIGTERM at 150s then killed the agents
 * (measured 3/3 at 150.1/149.2/150.0s). The close decision therefore has to ask
 * BOTH questions: is a turn in flight (BUG-018's detach, unchanged), and does
 * live work exist that OUTLIVES the turn (ARCH-002's question, answered by
 * `workLifetime()` from the engine's own declaration).
 *
 * THE `unknown` BIAS, stated rather than silently chosen: `unknown` DETACHES.
 * A wrong `close` destroys in-flight work silently and unrecoverably (the whole
 * cost of this bug); a wrong `detach` leaves one idle CLI alive, visible in the
 * registry, closable by hand — and BOUNDED: the detach-close fuse rechecks the
 * lifetime on a loop and closes the moment it resolves to `no` or the process
 * probe (the liveness authority's rung) says the CLI is gone. The costs are not
 * symmetric, so the tie goes to keeping the work. `unknown` is reachable two
 * ways, both transient by construction: (1) a `reported` runtime inside the
 * pre-signal window (a background dispatch was observed but the engine's level
 * frame has not landed yet — resolved by the frame, or by a bounded expiry);
 * (2) an `absent` runtime (Codex) with an agent row still running — resolved
 * when the row settles (and every row settles at `result` on such a runtime,
 * so its idle sessions answer `no` and close exactly as before this fix).
 */
/**
 * BUG-187 I1 — which registered project a surviving broker belongs to. A
 * broker spawned since BUG-187 records `projectId` in its meta; an older one
 * does not, so its CLI's working directory (the project's hostPath, which is
 * the cwd every direct session is spawned in) is matched against the registry.
 */
function projectForSurvivor(st: HostStatus): ReturnType<typeof reg.getProject> {
  if (st.projectId) {
    const p = reg.getProject(st.projectId);
    if (p) return p;
  }
  for (const pid of [st.claudePid, st.hostPid]) {
    if (!pid) continue;
    let cwd: string | null = null;
    try { cwd = fs.realpathSync(`/proc/${pid}/cwd`); } catch { cwd = null; }
    if (!cwd) continue;
    for (const p of reg.listProjects()) {
      if (p.isolation !== 'direct') continue;
      let hp = p.hostPath;
      try { hp = fs.realpathSync(p.hostPath); } catch { /* keep as-is */ }
      if (hp === cwd) return p;
    }
  }
  return null;
}

function releaseSocketSession(session: AgentSession | null, reason: string): void {
  if (!session || session.closed) return;
  // BUG-018: a busy session detaches — an open approval card and the running
  // turn must survive an ordinary "I'm looking at something else now".
  // BUG-157 (round 4): `detach()` now ARMS the close-on-detach fuse on every path
  // (it used to rely on a later `result` or an empty level frame, neither of which
  // arrives on these post-turn detaches — the real CLI emits no level at all, and
  // the turn has already ended — so the session leaked). The fuse re-checks and
  // closes once the work is actually done; for a container that verdict is a
  // process probe, not a timeout.
  if (session.busy) { session.detach(); return; }
  /*
   * BUG-187 B4/I2 — a BROKERED session's close reads the BROKER's lifetime (the
   * one close gate shared with the detached fuse and shutdown). Detach first —
   * nothing is closed on the bridge's own filtered view — then close only if
   * the broker itself says no work outlives the turn. The fuse `detach()` arms
   * is the same gate, so a `yes`/`unknown` is simply re-checked later.
   */
  if (session.survivable) {
    session.detach();
    void session.closeLifetime().then((cl) => {
      if (session.closed || !session.detached || session.busy) return;
      if (cl.lifetime === 'no') {
        console.log(`[orchard] ${reason}: closing idle session ${session.id} — the broker's lifetime is no (${cl.source})`);
        void session.close(reason).catch(() => {});
        return;
      }
      console.log(
        `[orchard] ${reason}: session ${session.id} detached instead of closed — ` +
        `work outlives the turn (${cl.lifetime}: per its broker — ${cl.source})`,
      );
    }, () => { /* unknown: stay detached — the fuse re-checks */ });
    return;
  }
  const lifetime = session.workLifetime();
  if (lifetime.outlivesTurn !== 'no') {
    console.log(
      `[orchard] ${reason}: session ${session.id} detached instead of closed — ` +
      `work outlives the turn (${lifetime.outlivesTurn}: ${lifetime.detail})`,
    );
    session.detach();
    return;
  }
  // BUG-157: a container session has no host-side broker, so an empty level (or a
  // `no` lifetime) is not enough to reap it in the same instant — a still-running
  // tool call the level never carried would be destroyed. DETACH instead and let
  // the fuse's container ground-truth probe decide the real close. `detach()` arms
  // the fuse, so this is bounded (a genuinely-idle container closes within seconds).
  if (session.containerName != null) {
    console.log(
      `[orchard] ${reason}: container session ${session.id} detached instead of closed — ` +
      'deferring the close to the container-ground-truth fuse (process probe, not a timeout)',
    );
    session.detach();
    return;
  }
  void session.close(reason).catch(() => {});
}

/**
 * BUG-191 — one confirmed delivery at a time per session. A gated delivery
 * (`AgentSession.sendGated`, the broker's correlated `deliver_ack`) awaits the
 * broker; for that window the session is RESERVED here, keyed by its SDK
 * session id and owned by the socket that started it. Acquired synchronously
 * before the await, released in `finally` when the delivery settles — never
 * by a socket close (a delivery in flight is still in flight). Every resume
 * route checks it first, so a second tab can neither take the driving socket
 * nor race a second delivery into the same moment.
 */
const deliveryInFlight = new Map<string, symbol>();
/** BUG-217 round 3 — sessions a prompt-bearing resume `start` is spawning right now (see the start handler). */
const resumeStarting = new Set<string>();

/* ====================== BUG-217 round 5: the outbox's hands ================
 * src/server/outbox.ts owns queued rows and decides nothing about bridges; this
 * is the wiring it calls. `probe` is synchronous: the answer and the handover
 * happen in one tick, under the session's delivery reservation (the same
 * `deliveryInFlight` map every socket path checks), so nothing can slip a
 * second prompt into the session in between.
 * ------------------------------------------------------------------------- */
/** Sessions whose reservation is held by the outbox (so a socket's refusal can say so). */
const outboxReserved = new Set<string>();
const OUTBOX_PENDING_MESSAGE = 'queued messages for this session go first — yours joins them and is sent in order';
/** Queued rows exist, or the outbox is mid-delivery: a typed prompt must join the queue, not jump it. */
function outboxBlocks(sid: string | null | undefined): boolean {
  return !!sid && (outboxReserved.has(sid) || outboxHasPending(sid));
}
/** When a bridge of THIS server last held each session — its own writes are not "another program". */
const ownBridgeSeen = new Map<string, number>();
setInterval(() => { const t = Date.now(); for (const s of liveSessions()) { const k = s.sdkSessionId ?? s.resumeOf; if (k) ownBridgeSeen.set(k, t); } }, 1000).unref();
/** Consecutive failed resumes per session — a non-transient one becomes `failed` after a few. */
const outboxResumeFailures = new Map<string, number>();

function outboxTranscriptFile(sid: string, resume: ResumeSettings): string | null {
  const project = reg.getProject(resume.projectId);
  const dirs = [...new Set([...(resume.encodedDir ? [resume.encodedDir] : []), ...(project ? resumeDirCandidates(project, resume.encodedDir ?? undefined) : [])])];
  for (const d of dirs) {
    const f = hist.resolveSessionFile(d, sid) ?? ot.resolveOrchardSessionFile(d, sid)?.filePath ?? null;
    if (f) return f;
  }
  return null;
}

const outboxWiring: OutboxWiring = {
  probe(sid, resume, { overrideExternal }): Probe {
    const wait = (kind: string, text: string, retryMs = 0, drain?: unknown): Probe => ({ kind: 'wait', hold: { kind, text, ...(drain ? { drain } : {}) }, retryMs });
    if (deliveryInFlight.has(sid)) return wait('reserved', 'another delivery into this session is finishing first');
    if (resumeStarting.has(sid)) return wait('starting', 'the session is starting');
    let running = bridgeForSession(sid);
    if (running) {
      const v = running.livenessVerdict();
      if (!v.live) {
        // BUG-033: a frameless bridge may still be running — wait for it; a proven-dead one is dropped.
        if (v.kind === 'frameless') return wait('silent', `the session went quiet (${v.reason}) — waiting for it to answer or end`, 2000);
        running.reapAsZombie(v);
        running = undefined;
      } else if (v.state === 'dead' && !running.busy) {
        // The bridge's own verdict: its process is gone and no turn runs (e.g. a retired older
        // host, BUG-191 B5). An empty shell can take nothing; close it and resume from the transcript.
        console.log(`[orchard] BUG-217: outbox closing the idle bridge of session ${sid} — ${v.evidence?.probeDetail ?? v.reason}`);
        void running.close('its process is gone (idle) — the outbox resumes the session').catch(() => {});
        running = undefined;
      }
    }
    if (running) {
      if (running.budgetStopped) return { kind: 'go', route: 'bridge', ctx: running }; // handOver reports the budget stop
      // Owner declarations only: the bridge's own send gate (BUG-187/191), decided before any strand shortcut.
      const gate = running.sendGate();
      if (!gate.ok) return wait('adopting', gate.message, 3000, gate.drain);
      if (running.adoptGated) return { kind: 'go', route: 'gated', ctx: running };
      if (running.busy) {
        // BUG-159: the bridge's own snapshot declares its main turn is NOT running (a stuck
        // `busy` behind background lanes): the runtime holds the message for the next boundary.
        let snap: ReturnType<AgentSession['runningSnapshot']> | null = null;
        try { snap = running.runningSnapshot(); } catch { snap = null; }
        if (snap && snap.turn.running === false && snap.running.some((r) => r.row !== 'main')) return { kind: 'go', route: 'strand', ctx: running };
        return wait('busy', 'sends when Claude pauses');
      }
      return { kind: 'go', route: 'bridge', ctx: running };
    }
    const survivor = survivingHostForSdkSession(sid);
    if (survivor) {
      const probe = livenessOfSurvivor(survivor);
      if (probe.state === 'alive') {
        if (survivorAdmits(survivor) && !activeDeliveryFor(sid)) return { kind: 'go', route: 'survivor', ctx: survivor };
        return wait('draining', 'the session is still finishing earlier work after a restart — it sends when that is done', 3000, {
          backgroundLive: typeof survivor.backgroundLive === 'number' ? survivor.backgroundLive : 0,
          backgroundTaskIds: Array.isArray(survivor.backgroundTaskIds) ? survivor.backgroundTaskIds : [],
          backgroundLifetime: survivor.backgroundLifetime ?? null,
          brokerState: survivor.state,
        });
      }
      dropDeadSurvivorHost(survivor);
    }
    /*
     * HEURISTIC, and it can only DELAY: a transcript written in the last live
     * window, by nothing this server holds, is taken to mean another program (a
     * terminal) is using the session; resuming would put a second CLI on one
     * transcript. The user's Send now (`overrideExternal`) goes past it.
     */
    if (!overrideExternal) {
      const f = outboxTranscriptFile(sid, resume);
      let mtime = 0;
      try { if (f) mtime = fs.statSync(f).mtimeMs; } catch { /* unreadable: not evidence of a writer */ }
      const own = ownBridgeSeen.get(sid) ?? 0;
      if (mtime && Date.now() - mtime < watcher.LIVE_WINDOW_MS && mtime > own + 2000) {
        return wait('external', 'another program is writing this session — it sends once that stops, or press Send now', 2000);
      }
    }
    return { kind: 'go', route: 'resume' };
  },

  reserve(sid) {
    const token = Symbol('outbox');
    deliveryInFlight.set(sid, token);
    outboxReserved.add(sid);
    return () => {
      if (deliveryInFlight.get(sid) === token) deliveryInFlight.delete(sid);
      outboxReserved.delete(sid);
    };
  },

  async handOver(sid, go, prompt, resume): Promise<HandOutcome> {
    if (go.route === 'bridge' || go.route === 'strand') {
      const live = go.ctx as AgentSession;
      try { live.send(prompt); } catch (err) {
        const e = err as Error & { retryable?: boolean };
        if (e.retryable) return { kind: 'refused', hold: { kind: 'adopting', text: e.message }, retryMs: 3000 };
        if (live.closed) return { kind: 'refused', hold: { kind: 'closing', text: 'the session just ended — resuming it' }, retryMs: 300 };
        return { kind: 'failed', reason: `the session would not take it (${e.message})` };
      }
      return { kind: 'delivered', via: go.route };
    }
    if (go.route === 'gated') {
      const r = await (go.ctx as AgentSession).sendGated(prompt);
      if (r.outcome === 'delivered') return { kind: 'delivered', via: 'gated' };
      if (r.outcome === 'refused') return { kind: 'refused', hold: { kind: 'adopting', text: r.message, ...(r.drain ? { drain: r.drain } : {}) }, retryMs: 3000 };
      return { kind: 'uncertain', reason: `${r.message}` };
    }
    if (go.route === 'survivor') {
      const handle = await deliverIntoSurvivor({ survivor: go.ctx as HostStatus, sdkSessionId: sid, prompt, client: null });
      if (!handle) return { kind: 'refused', hold: { kind: 'draining', text: 'the session is still finishing earlier work after a restart — it sends when that is done' }, retryMs: 3000 };
      if (handle === 'uncertain') return { kind: 'uncertain', reason: 'the surviving session did not confirm it in time — it may or may not have arrived. Check the conversation, then Send anyway or Discard' };
      // No tab owns this turn: an approval it raises is denied at once, the existing FEAT-065 posture for a gone tab.
      handle.attachClient(null);
      console.log(`[orchard] BUG-217: outbox delivered into the drain-held survivor of session ${sid}`);
      return { kind: 'delivered', via: 'survivor' };
    }
    // Resume from the transcript, with no socket: the bridge runs detached and closes itself after the turn.
    const project = reg.getProject(resume.projectId);
    if (!project) return { kind: 'failed', reason: 'its project is no longer registered' };
    resumeStarting.add(sid);
    let lastError: { message?: string; code?: string; needsFork?: unknown } | null = null;
    try {
      const enc = resume.encodedDir ?? hist.encodeCwd(project.hostPath);
      if (!(hist.resolveSessionFile(enc, sid) ?? ot.resolveOrchardSessionFile(enc, sid)?.filePath)) {
        try { cn.importNativeCodexSession(sid, { expectedEncodedDir: enc }); } catch { /* the resume vetting reports it */ }
      }
      const instructions = resume.templateIds ? resume.templateIds.map((templateId) => ({ templateId, enabled: true })) : undefined;
      let overrides;
      // FEAT-160 round 4 — the pump resumes from a row frozen at enqueue; if the
      // server owns this session's account, drop the row's stale `claudeAccount`
      // before validation (the binding decides at the spawn chokepoint), so a row
      // carrying an account since DELETED is not stranded `failed`.
      const resumeOverrides = dropBoundAccountOverride(sid, resume.overrides as Record<string, unknown> | null | undefined);
      if (resumeOverrides) {
        try { overrides = validateSessionOverrides(resumeOverrides, { isolation: project.isolation }); }
        catch (err) { return { kind: 'failed', reason: `this session's saved settings are no longer valid (${(err as Error).message}) — open it and Send again` }; }
      }
      const s = await startSession({
        project,
        firstPrompt: prompt,
        resumeSessionId: sid,
        resumeEncodedDir: resume.encodedDir ?? undefined,
        instructions,
        overrides,
        onEvent: (e) => { if (e.t === 'error') lastError = e as typeof lastError; },
      });
      s.detach();
      outboxResumeFailures.delete(sid);
      console.log(`[orchard] BUG-217: outbox resumed session ${sid} (no tab driving) to deliver queued messages`);
      return { kind: 'delivered', via: 'resume' };
    } catch (err) {
      if ((err as { mayHaveSpawned?: boolean }).mayHaveSpawned) {
        return { kind: 'uncertain', reason: `starting the session failed after it may have taken the message (${(err as Error).message}) — check the conversation, then Send anyway or Discard` };
      }
      const le = lastError as { message?: string; code?: string; needsFork?: unknown } | null;
      const msg = le?.message ?? (err as Error).message;
      if (le?.needsFork) return { kind: 'failed', reason: 'this session has to be forked before it can continue — open it, use the fork bar, then Send again' };
      if (le?.code === 'runtime-check-pending') return { kind: 'refused', hold: { kind: 'starting', text: 'Orchard is still checking its runtime — it sends in a moment' }, retryMs: 1500 };
      const n = (outboxResumeFailures.get(sid) ?? 0) + 1;
      outboxResumeFailures.set(sid, n);
      if (n >= 3) { outboxResumeFailures.delete(sid); return { kind: 'failed', reason: `the session could not be resumed (${msg})` }; }
      return { kind: 'refused', hold: { kind: 'retry', text: `the session could not be resumed (${msg}) — trying again` } };
    } finally {
      resumeStarting.delete(sid);
    }
  },

  transcriptHas(sid, resume, needle, from) {
    const f = outboxTranscriptFile(sid, resume);
    if (!f) return null;
    try {
      const size = fs.statSync(f).size;
      const start = from > 0 && from <= size ? from : Math.max(0, size - 64 * 1024 * 1024);
      const fd = fs.openSync(f, 'r');
      try {
        const buf = Buffer.alloc(size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        return buf.includes(needle);
      } finally { fs.closeSync(fd); }
    } catch { return null; }
  },

  transcriptSize(sid, resume) {
    const f = outboxTranscriptFile(sid, resume);
    try { return f ? fs.statSync(f).size : null; } catch { return null; }
  },

  interrupt(sid) {
    const running = bridgeForSession(sid);
    if (!running || !running.busy) return null;
    return running.interrupt();
  },

  announce(sid, e) {
    const running = bridgeForSession(sid);
    running?.announce(e);
  },
};

const wss = new WebSocketServer({
  server,
  path: '/ws',
  // BUG-076: reject a browser page on a foreign Origin, and any foreign Host,
  // at the handshake — before a socket (and its `start` surface) exists.
  verifyClient: (info: { origin?: string; req: http.IncomingMessage }) => {
    const host = info.req.headers.host;
    if (!hostAllowed(host)) {
      console.warn(`[orchard] WS handshake rejected: Host "${host ?? '(none)'}" not allowed`);
      return false;
    }
    const origin = info.origin ?? (info.req.headers.origin as string | undefined);
    if (!originAllowed(origin)) {
      console.warn(`[orchard] WS handshake rejected: Origin "${origin}" not allowed`);
      return false;
    }
    return true;
  },
});

wss.on('connection', (ws: WebSocket) => {
  let session: AgentSession | null = null;
  let starting = false;
  let closedEarly = false;
  /**
   * FEAT-065 — the survivor-delivery relay this socket's `start` established
   * (no AgentSession exists for it). Kept so `approval-response` can answer a
   * `can_use_tool` the injected turn raised; detached on socket close (the
   * delivery then falls back to its bounded deny for anything still pending).
   */
  let delivery: SurvivorDelivery | null = null;
  /** File-follow subscriptions owned by THIS socket, so close() releases them all. */
  const follows = new Map<string, watcher.WatchHandle>();

  const send = (e: StationEvent | { t: 'ack'; [k: string]: unknown }) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e));
  };

  /*
   * FEAT-145 step 3 — the "Add account" login relay rides THIS socket: the same
   * transport every other server→client event uses, not a second channel. A
   * login is not a session, so these commands are handled ahead of the session
   * switch below and share none of its state; the client opens its own
   * connection for them the way app.js's passive watch socket does.
   *
   * `loginAccountId` is what makes cleanup honest: the attempt is OWNED by the
   * socket that started it, so a closed tab kills the CLI's process GROUP and
   * removes the half-made account instead of leaving both behind.
   *
   * The frames are `ClientCommand` / `StationEvent` members (events.ts), like
   * every other frame on this socket. The runtime `typeof` checks below stay:
   * the union describes the WIRE CONTRACT, and the bytes arriving here are
   * untrusted JSON that has merely been cast to it.
   */
  let loginAccountId: string | null = null;
  const sendLogin = (e: LoginEvent) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e));
  };
  const handleLoginCommand = (c: ClientCommand): c is ClaudeLoginCommand => {
    if (c.type !== 'claude-login-start' && c.type !== 'claude-login-code' && c.type !== 'claude-login-cancel') {
      return false;
    }
    try {
      if (c.type === 'claude-login-start') {
        if (typeof c.accountId !== 'string') throw new AccountError('claude-login-start requires an accountId', 400);
        const begun = startClaudeLogin(c.accountId, sendLogin);
        loginAccountId = begun.accountId;
        send({ t: 'ack', of: 'claude-login-start', accountId: begun.accountId, label: begun.label });
      } else if (c.type === 'claude-login-code') {
        if (typeof loginAccountId !== 'string') throw new AccountError('this socket has no login in progress', 409);
        // The code is never logged and never echoed back: it goes to the child's
        // stdin, and is kept only to redact it out of the relayed output.
        submitClaudeLoginCode(loginAccountId, c.code);
        send({ t: 'ack', of: 'claude-login-code' });
      } else {
        const stopped = cancelClaudeLogin(loginAccountId ?? undefined, 'cancelled from the dashboard');
        loginAccountId = null;
        send({ t: 'ack', of: 'claude-login-cancel', stopped });
      }
    } catch (err) {
      // `error.code` is a closed union of session-reattach codes, so the HTTP-ish
      // status goes in the MESSAGE (which is what the panel shows) rather than
      // widening that union from here — the refusals are all human-readable.
      const status = err instanceof AccountError ? err.status : 500;
      send({ t: 'error', message: `${c.type} refused (${status}): ${(err as Error).message}`, fatal: false });
    }
    return true;
  };

  ws.on('message', (raw) => {
    let cmd: ClientCommand;
    try {
      cmd = JSON.parse(String(raw));
    } catch {
      return send({ t: 'error', message: 'malformed command JSON', fatal: false });
    }
    /*
     * BUG-217 round 5 — a tab still running the round-3/4 client sends its
     * queued rows with `queueIds` and expects the (deleted) ledger to arbitrate.
     * Nothing arbitrates that any more, so it is refused, never delivered: the
     * tab keeps the row, and a reload hands it to the server's outbox.
     */
    if ((cmd?.type === 'start' || cmd?.type === 'send') && Array.isArray((cmd as { queueIds?: unknown }).queueIds)) {
      return send({
        t: 'error', fatal: false, code: 'client-outdated', of: cmd.type,
        sendId: typeof (cmd as { sendId?: unknown }).sendId === 'string' ? (cmd as { sendId: string }).sendId : undefined,
        message: 'this tab is running an older version of Orchard — reload it. This message was NOT sent; it is still in the dock, and after the reload Orchard asks before sending it.',
      });
    }
    try {
      // FEAT-145 — the login frames are not session commands; they are handled
      // (and answered) here, ahead of the session switch.
      if (handleLoginCommand(cmd)) return;
      switch (cmd.type) {
        case 'start': {
          if (session || starting || (delivery && !delivery.done)) return send({ t: 'error', message: 'this socket already has a session', fatal: false });
          const project = reg.getProject(cmd.projectId);
          if (!project) return send({ t: 'error', message: `no project ${cmd.projectId}`, fatal: true });
          const instructions = cmd.templateIds
            ? cmd.templateIds.map((templateId) => ({ templateId, enabled: true }))
            : undefined;
          // Per-session overrides: validated by the SAME code the registry PATCH
          // uses, and reported as a fatal start error rather than silently
          // dropped — a drawer showing `overridden` while the agent ignores it is
          // exactly the failure this replaces.
          let overrides;
          /*
           * BUG-196 round 6 — ON A RESUME THE CLIENT'S PROVIDER IS DROPPED BEFORE
           * ANY VALIDATION. The engine of an existing id is the server's alone (see
           * below), so the client's `provider` is not a request here and must never
           * be able to kill the resume: round 5 dropped it only AFTER
           * validateSessionOverrides, which FATALLY rejected "gemini", null or
           * "OpenAI" first. Whatever it is — valid, stale, garbage — it is taken off
           * the raw frame here, remembered only to announce it once the pinned engine
           * is known, and the rest of the overrides are validated as usual.
           */
          let resumeClientProvider: { value: unknown } | null = null;
          let rawOverrides: unknown = cmd.overrides;
          if (cmd.resumeSessionId && rawOverrides && typeof rawOverrides === 'object' && !Array.isArray(rawOverrides)
            && 'provider' in rawOverrides) {
            const { provider: dropped, ...rest } = rawOverrides as Record<string, unknown>;
            resumeClientProvider = { value: dropped };
            rawOverrides = Object.keys(rest).length ? rest : undefined;
          }
          /*
           * FEAT-160 round 4 — ON A RESUME OF A SESSION THE SERVER OWNS THE ACCOUNT FOR,
           * the client's `claudeAccount` is dropped BEFORE validation, exactly like
           * `provider` above. The account of a switched session is a server-owned fact
           * (session-accounts.ts, read at the one spawn chokepoint), so a stale tab still
           * carrying an account that has since been DELETED must not FATAL the resume
           * ("claudeAccount must be null or the id of an existing account") when the server
           * already decides the account for that id. An UNBOUND session keeps its override
           * (the legitimate FEAT-145 launch account), validated as before.
           */
          if (cmd.resumeSessionId && rawOverrides && typeof rawOverrides === 'object' && !Array.isArray(rawOverrides)) {
            rawOverrides = dropBoundAccountOverride(cmd.resumeSessionId, rawOverrides as Record<string, unknown>);
          }
          if (rawOverrides !== undefined) {
            try {
              // FEAT-145 step 5: the project's isolation is part of the dialect —
              // `claudeAccount` is a legal per-session override for a `direct`
              // project and refused for a container one (the credential is a
              // container bind). The parameter is required, so a new start path
              // cannot skip that refusal by omission.
              overrides = validateSessionOverrides(rawOverrides, { isolation: project.isolation }); // BUG-196 round 6: a resume's provider is already off
            } catch (err) {
              return send({ t: 'error', message: `start.overrides rejected: ${(err as Error).message}`, fatal: true });
            }
          }
          /*
           * BUG-196 round 4 — ON A RESUME THE SERVER ALONE DECIDES THE ENGINE.
           * A session id is meaningful only to the engine that minted it, so the
           * engine a resume runs on is a fact about the id, owned by the stores
           * the resume reads — never by a client value. Round 3 judged the
           * client's `overrides.provider` at this door and REJECTED a mismatch
           * (fatal), which (a) missed a NATIVE Codex rollout not yet imported
           * (its only store is $CODEX_HOME, which the door never read) and (b)
           * killed the resume of a session the user never switched whenever a
           * stale client override rode the frame.
           *
           * Now: bring every store the resume can read into the one the resolver
           * reads FIRST (the FEAT-078 native-Codex backfill, moved up from just
           * before startSession so nothing below judges the id before it exists),
           * then resolve the engine with the SAME resolver over the SAME dir list
           * agent-bridge P2b uses (resumeProviderOf ∘ resumeDirCandidates), and
           * DROP the client's provider for this start. A stale value is ignored,
           * announced, never fatal; the engine the session actually runs on is
           * declared back on `session-init.lockedProvider`. A provider override
           * is a fresh-session concept only.
           */
          if (cmd.resumeSessionId) {
            const enc = cmd.resumeEncodedDir ?? hist.encodeCwd(project.hostPath);
            const already =
              hist.resolveSessionFile(enc, cmd.resumeSessionId) ??
              ot.resolveOrchardSessionFile(enc, cmd.resumeSessionId)?.filePath;
            if (!already) {
              try {
                cn.importNativeCodexSession(cmd.resumeSessionId, { expectedEncodedDir: enc });
              } catch {
                /* import is best-effort — if it fails, the normal resume vetting reports honestly */
              }
            }
            // BUG-196 round 6 — the client's provider was taken off the RAW frame
            // before validation (above); here it is only announced, now that the
            // pinned engine is known. Nothing it held can reach the validator.
            if (resumeClientProvider) {
              const locked = ot.resumeProviderOf(resumeDirCandidates(project, cmd.resumeEncodedDir), cmd.resumeSessionId);
              if (resumeClientProvider.value !== locked) {
                const runs = locked === 'openai' ? 'OpenAI Codex' : 'Claude';
                const shown = typeof resumeClientProvider.value === 'string'
                  ? resumeClientProvider.value
                  : JSON.stringify(resumeClientProvider.value) ?? String(resumeClientProvider.value);
                send({
                  t: 'status',
                  status: `ignored a stale provider choice (${shown.slice(0, 60)}) — this session's transcript pins it to ${runs}, so it resumes on ${runs}`,
                });
              }
            }
          }
          /*
           * RE-ATTACH before spawn. If the resume target is STILL RUNNING in
           * this server (detached when its tab looked away), spawning a second
           * CLI onto the same transcript file would be a disaster — take over
           * the running session's event stream instead. An attached-elsewhere
           * session is refused: two tabs must not both believe they drive it.
           */
          if (cmd.resumeSessionId) {
            /*
             * BUG-191 — another socket is mid-way through a confirmed delivery
             * into this session. A message is refused RETRYABLY (the tab queues
             * it and retries in a few seconds); a promptless reattach is told the
             * session is being driven elsewhere, exactly as BUG-149 does.
             */
            if (deliveryInFlight.has(cmd.resumeSessionId)) {
              if (typeof cmd.prompt === 'string' && cmd.prompt.trim()) {
                return send({
                  t: 'error', fatal: false, retryable: true,
                  ...(outboxReserved.has(cmd.resumeSessionId) ? { code: 'outbox-pending' as const } : {}),
                  message: outboxReserved.has(cmd.resumeSessionId)
                    ? OUTBOX_PENDING_MESSAGE
                    : 'another tab is delivering a message into this session right now — your message is queued and sends itself in a moment',
                });
              }
              return send({
                t: 'error', code: 'live-elsewhere', fatal: true,
                message: 'this session is being driven in another tab — a session streams to one tab at a time. Close it there (or send from there) to take it over here; until then you can watch it here read-only.',
              });
            }
            /*
             * BUG-217 round 5 — queued messages for this session go first: the
             * server's outbox says so (it owns the order), and this prompt joins
             * them. Unless another tab drives the session: then BUG-149's refusal
             * below answers, exactly as before.
             */
            if (typeof cmd.prompt === 'string' && cmd.prompt.trim() && outboxHasPending(cmd.resumeSessionId)) {
              const holder = bridgeForSession(cmd.resumeSessionId);
              if (!holder || holder.detached) {
                return send({ t: 'error', fatal: false, retryable: true, code: 'outbox-pending', message: OUTBOX_PENDING_MESSAGE });
              }
            }
            /*
             * BUG-033 — LIVENESS GATE, before the bridge is treated as live.
             * A bridge in the registry used to be proof enough that the session
             * was running; it is not. A CLI killed mid-turn leaves the bridge
             * behind, `busy: true`, with nothing behind it — reattaching to it
             * hands the user a session that can never answer and silently eats
             * every message. Re-check the claim against ground truth (the CLI's
             * pid / the frameless backstop) and, if it fails, DROP the corpse
             * here and fall through to the ordinary resume-from-disk path — the
             * user's prompt then starts a real turn instead of vanishing.
             * `reapAsZombie` deletes it from the registry synchronously, so the
             * `liveSessions()` re-read below cannot see it again.
             */
            // BUG-217 round 5: the owner's declaration — including a resume whose CLI has not reported its id yet.
            let running = bridgeForSession(cmd.resumeSessionId);
            if (running) {
              const v = running.livenessVerdict();
              if (!v.live) {
                running.reapAsZombie(v); // synchronous registry removal — see reapAsZombie
                running = undefined;
                /*
                 * How the corpse is disposed of depends on how sure we are, and
                 * the two cases are NOT the same:
                 *
                 *  - 'dead-process': the CLI is PROVEN gone (its pid is not
                 *    there / its broker deleted its status file). Nothing can be
                 *    racing us, so fall through to the ordinary
                 *    resume-from-disk below — the user's prompt starts a real
                 *    turn instead of vanishing into a queue.
                 *  - 'frameless': the timer backstop fired where no pid could be
                 *    checked. Silence is evidence, not proof. Spawning a second
                 *    `claude --resume` onto a transcript a maybe-alive CLI is
                 *    still writing is the BUG-022 disaster, so REFUSE the prompt
                 *    retryably instead: the client rolls the un-acked start back
                 *    and hands the text back to the composer (BUG-029), the
                 *    stale bridge is gone either way, and the next Enter resumes
                 *    cleanly. Refusing is never silent; swallowing was.
                 */
                if (v.kind === 'frameless' && cmd.prompt) {
                  return send({
                    t: 'error',
                    fatal: false,
                    retryable: true,
                    message:
                      `this session went silent — ${v.reason}. The server cannot confirm its turn is still running, ` +
                      'so your message was NOT delivered rather than queued behind a turn that may never end. ' +
                      'The stale bridge has been dropped; press Enter again to resume the session from its transcript and send it.',
                  });
                }
                send({ t: 'status', status: `the previous bridge for this session was dead (${v.reason}) — dropped it and resuming from the transcript` });
              }
            }
            if (running) {
              if (!running.detached) {
                /*
                 * BUG-149 — one driver at a time is STRUCTURAL, not policy, and
                 * the client's copy has to be able to say so truthfully: the
                 * bridge holds a SINGLE `#emit` sink and `attach()` REPLACES it
                 * (see agent-bridge.ts). A second socket taking over would not
                 * "share" the session — it would silently blind the first tab
                 * mid-turn, redirecting its reply and its still-open approval
                 * cards to a window whose user never asked for them. Two drivers
                 * pushing prompts into one CLI stream is the BUG-022 shape on top
                 * of that. Reading is unaffected: the transcript on disk is the
                 * record, so the refused tab genuinely can watch read-only.
                 *
                 * `fatal` stays true (an older client's behaviour is unchanged),
                 * but `code` lets a current client tell this recoverable refusal
                 * from a dead session and KEEP the user's typed text — before
                 * BUG-149 this frame reached only console.log and the message
                 * was dropped on the floor.
                 */
                return send({
                  t: 'error',
                  code: 'live-elsewhere',
                  fatal: true,
                  message: 'this session is being driven in another tab — a session streams to one tab at a time. Close it there (or send from there) to take it over here; until then you can watch it here read-only.',
                });
              }
              /*
               * BUG-033 — everything below this line is now reached ONLY for a
               * bridge whose liveness was just re-verified by the gate above.
               * That is what makes the mid-turn "deliver at the next pause"
               * branch further down honest: it is an accepted delay behind a
               * turn known to be running, not a silent swallow behind a claim.
               */
              const resumeId: string = cmd.resumeSessionId;
              const reattach = (live: AgentSession, ackExtra: Record<string, unknown> = {}) => {
                live.attach(send);
                session = live;
                send({
                  t: 'ack', of: 'start', reattached: true, busy: live.busy, ...ackExtra,
                  // BUG-033: the REAL start of the in-flight turn (null when none).
                  // The client must not stamp "now" — a timer counting from when
                  // the tab found out is a fabricated duration.
                  turnStartedAt: live.turnStartedAt,
                  stationSessionId: live.id, isolation: project.isolation,
                  containerName: live.containerName,
                  instructionMode: live.composed.mode, appliedTemplates: live.composed.appliedIds,
                  overridden: live.overriddenFields, effective: live.effective,
                  capabilities: live.capabilities, // FEAT-037 P3: engine honesty flags
                  permissionModeSource: live.permissionModeSource,
                  fork: live.forkInfo(),
                  startSnapshotId: live.startSnapshotId,
                  startSnapshotStatus: live.startSnapshotStatus,
                  startSnapshotError: live.startSnapshotError,
                });
                send({
                  t: 'session-init', sessionId: live.sdkSessionId ?? resumeId, cwd: live.cwd,
                  model: String(live.effective?.model ?? 'unknown'), tools: [],
                  permissionMode: live.effective?.permissionMode,
                  // BUG-196 — declare the reattached session's dispatch engine too, so
                  // a reattach (no transcript refetch) still locks the provider surfaces.
                  lockedProvider: String(live.effective?.provider ?? 'anthropic'),
                  slashCommands: knownSlashCommands(),
                });
                /*
                 * BUG-008: a card (permission/question/plan) that was open when the
                 * old socket died is still pending in this session, unanswered and
                 * invisible — it lives only in memory, never in the transcript, so
                 * file-follow can't surface it. Replay it to THIS socket now (after
                 * the handshake) so the user can answer the still-open turn instead
                 * of watching a "still working" session that is blocked forever.
                 */
                live.replayPending();
                /*
                 * BUG-187 I4 — then the AUTHORITATIVE list of what is still
                 * pending, so a card this tab kept from before a restart (or that
                 * was answered elsewhere) settles as expired instead of re-arming
                 * into nothing. `complete:false` while an adoption is recovering.
                 */
                live.emitApprovalsSnapshot();
                /*
                 * BUG-020: `replayPending()` only covers open approval/question/
                 * plan cards. A sub-agent (Task tool) keeps running server-side
                 * across a detach (BUG-018 lineage) but the reattaching client's
                 * live "agents running" strip was seeded ONLY by future events —
                 * an already-completed sub-agent was never mentioned at all.
                 * Replay the session's current agent snapshot so the strip shows
                 * ground truth immediately, not by luck.
                 */
                live.replayAgents();
                /*
                 * ARCH-001 phase 2 / BUG-034 — and the CORRECTING answer right
                 * behind the replay: the server's own running-set snapshot. The
                 * replay above re-emits per-agent deltas (BUG-020, still needed
                 * for threads and "ran" rows); THIS says what is running, as one
                 * authoritative list, so a tab that lived through a cut and is
                 * holding rows the server does not believe in is corrected — and
                 * EMPTIED if that is the truth — without a page reload.
                 */
                live.pushRunningSnapshot(true);
              };
              const prompt = typeof cmd.prompt === 'string' && cmd.prompt.trim() ? cmd.prompt : null;
              /*
               * BUG-191 — an ADOPT-GATED session (BUG-187 B2: adoption `pending`,
               * or settled `responder-only`) does not own its CLI. Its message is
               * decided BEFORE anything is acknowledged:
               *  - the gate refuses → a retryable refusal with the `drain` payload,
               *    no attach, no ack — the tab's BUG-045 queue keeps the text;
               *  - the gate passes → the message goes in through the broker's
               *    correlated acceptance (`sendGated`), and the tab is acked only
               *    once the broker has WRITTEN it (`promptDelivered:true`), or
               *    refused retryably if it did not, or told `uncertain` (never a
               *    blind resend) if the broker did not answer.
               * Before this, the ack went out first and the refusal after it, so
               * the tab retired a message that was never delivered.
               */
              /*
               * BUG-191 round 2 (B5) — the gate is decided for EVERY prompt-bearing
               * reattach, not only an adopt-gated one: a session held by an older
               * broker (protocol < 2) that settled `adopted` cannot confirm a
               * delivery either, and must be refused here, before the ack.
               */
              const gate = prompt ? running.sendGate() : null;
              if (gate && !gate.ok) {
                return send({ t: 'error', fatal: false, retryable: true, message: gate.message, drain: gate.drain });
              }
              if (prompt && running.adoptGated) {
                const sid = resumeId;
                const token = Symbol('delivery');
                deliveryInFlight.set(sid, token);
                starting = true;
                const live = running;
                void live.sendGated(prompt)
                  .then((r) => {
                    if (r.outcome === 'refused') return send({ t: 'error', fatal: false, retryable: true, message: r.message, drain: r.drain });
                    if (r.outcome === 'uncertain') return send({ t: 'error', fatal: false, uncertain: true, message: r.message });
                    // Delivered. A closed socket has nobody to tell — its tab
                    // treats the silent attempt as unconfirmed (never resent).
                    if (closedEarly) return;
                    if (live.closed) return send({ t: 'error', fatal: false, uncertain: true, message: 'the message was handed to the session, which then ended before this tab could re-attach — it is not resent automatically; check the transcript before sending it again' });
                    reattach(live, { promptDelivered: true });
                  })
                  .catch((err) => { send({ t: 'error', fatal: false, uncertain: true, message: `the delivery could not be confirmed (${(err as Error).message}) — it is not resent automatically; check the transcript before sending it again` }); })
                  .finally(() => {
                    starting = false;
                    if (deliveryInFlight.get(sid) === token) deliveryInFlight.delete(sid);
                  });
                return;
              }
              reattach(running);
              if (prompt) {
                if (running.busy) {
                  // Verified mid-flight (see the refusal belt above) — the honest
                  // "later", now with the evidence that backs it named out loud.
                  send({
                    t: 'status',
                    status: `re-attached mid-turn — the running work continues (${running.livenessVerdict().reason}); deliver your message at the next pause`,
                  });
                } else {
                  try { running.send(prompt); } catch (err) { send({ t: 'error', message: (err as Error).message, fatal: false }); }
                }
              }
              return;
            }
            /*
             * BUG-160 — a PROMPTLESS resume is a request to re-take the driving
             * socket of a bridge this server still holds (a sole tab that
             * reloaded; see reattachDriving in public/app.js). If we reached here
             * the bridge is gone (never held, or just reaped as a zombie above),
             * so there is nothing to reattach to. Refuse rather than fall through
             * and spawn a `claude --resume` with no prompt — an empty turn. This
             * is inert for every existing caller: the client always sends a
             * non-empty prompt with `start`, so only reattachDriving hits it.
             */
            if (!(typeof cmd.prompt === 'string' && cmd.prompt.trim().length > 0)) {
              return send({
                t: 'error',
                code: 'nothing-to-reattach',
                fatal: false,
                message: 'this session is no longer running here — send a message to resume it.',
              });
            }
            /*
             * BUG-022: the in-memory check above only sees sessions driven by
             * THIS process. Right after a restart that map is empty, but a
             * prior server's FEAT-015 survivor broker may still be alive and
             * draining the SAME sdkSessionId's turn (boot's `adoptSurvivingHosts`
             * SIGTERMs it but does NOT await the drain). Spawning a fresh
             * `claude --resume` now would put a SECOND CLI onto the same
             * transcript file — the two turns interleave and the in-flight
             * turn's final reply + marker are lost. Consult on-disk survivor
             * state and refuse until that broker has fully drained + been reaped
             * (at which point it drops out of the scan and the normal
             * resume-from-disk path proceeds). Retryable, not fatal.
             *
             * BUG-038: a `HostStatus` record on disk used to be treated as proof
             * enough by itself — exactly the bug BUG-033 fixed for in-memory
             * bridges (a corpse blocking resumes/sends). A survivor whose turn
             * had ALREADY finished (broker + CLI both exited) but whose status
             * file had not yet been swept refused every send with "still
             * finishing its previous turn" even though nothing was running —
             * observed live right after a restart. Probe ground truth
             * (ARCH-001's authority: the broker's own recorded verdict, then
             * live-pid checks) before refusing: alive → refuse (now naming the
             * evidence); dead → drop the corpse's files and fall through to the
             * ordinary resume-from-disk path below, same disposition as
             * BUG-033's `dead-process` case for in-memory bridges.
             */
            const survivor = survivingHostForSdkSession(cmd.resumeSessionId);
            if (survivor) {
              const probe = livenessOfSurvivor(survivor);
              if (probe.state === 'alive') {
                /*
                 * FEAT-064: say WHAT holds the drain, not just that it drains.
                 * The broker's own heartbeats carry the background task count,
                 * the sniffed ids and when the hold began (see HostStatus);
                 * surface them in the message AND as a structured `drain`
                 * payload the BUG-045 chip renders. A status file from an
                 * older broker lacks the fields — the payload then reports
                 * zero/null and the message keeps its bare shape.
                 */
                const refuseDrainHeld = () => {
                  const bgCount = typeof survivor.backgroundLive === 'number' ? survivor.backgroundLive : 0;
                  const heldSinceMs = survivor.drainHeldSince ? Date.parse(survivor.drainHeldSince) : NaN;
                  const heldForMs = Number.isFinite(heldSinceMs) ? Math.max(0, Date.now() - heldSinceMs) : null;
                  const taskIds = Array.isArray(survivor.backgroundTaskIds) ? survivor.backgroundTaskIds : [];
                  const heldNote = bgCount > 0
                    ? ` — the drain is held${heldForMs != null ? ` ${Math.round(heldForMs / 1000)}s so far` : ''} by ${bgCount} background agent${bgCount === 1 ? '' : 's'}${taskIds.length ? ` (${taskIds.join(', ')})` : ''} still working; your message retries itself when they settle`
                    : '';
                  send({
                    t: 'error',
                    message: `this session is still finishing its previous turn after a server restart (${probe.reason})${heldNote} — try resuming again in a few seconds`,
                    fatal: false,
                    // BUG-029: the turn never began — the client keeps the typed
                    // message and re-arms the next Enter rather than losing it.
                    retryable: true,
                    drain: {
                      backgroundLive: bgCount,
                      backgroundTaskIds: taskIds,
                      backgroundLifetime: survivor.backgroundLifetime ?? null,
                      drainHeldSince: survivor.drainHeldSince ?? null,
                      heldForMs,
                      brokerState: survivor.state,
                    },
                  });
                };
                /*
                 * FEAT-065 (BUG-048 (c+)) — DELIVER instead of refusing, when
                 * every probe-backed condition holds:
                 *  - the broker is actually holding a drain (`draining`), its
                 *    FOREGROUND is provably idle (`midTurn === false`, live
                 *    boundary-refreshed evidence — an older broker without the
                 *    field is never injected), and
                 *  - the hold is for DECLARED live background work
                 *    (`backgroundLifetime === 'yes'`). `unknown` deliberately
                 *    keeps the queue-and-wait: an unknown-held drain can
                 *    commit at any moment (empty level frame / window expiry),
                 *    so an injected turn would race the stdin-EOF decision —
                 *    ARCH-002's posture is to wait, and the unknown window is
                 *    short (bounded) anyway. A mid-foreground-drain survivor
                 *    (turn still running) also keeps queue-and-wait.
                 * The write rides THIS start and is acked to it (probe 5:
                 * exactly-once via BUG-045's retry loop — never out-of-band);
                 * on any establishment failure it falls back to the ordinary
                 * retryable refusal above, so the message stays queued.
                 */
                /*
                 * BUG-074: reconcile delivery with the broker's bounded-trust
                 * downgrade. A level that has gone UNCORROBORATED past
                 * BG_STALE_MS is reported as `unknown` while still non-empty
                 * (`backgroundLive > 0`) — the drain is genuinely still held (no
                 * EOF races the injection), so this stale/quiet 'yes' must not
                 * strand the user's message; deliver into it exactly as a fresh
                 * 'yes'. The dispatch-observed `unknown` (backgroundLive === 0, a
                 * level frame imminent — the commit could fire at any moment)
                 * still keeps FEAT-065's queue-and-wait.
                 */
                // The conditions live in ONE place, the delivery route's owner
                // (survivor-delivery.ts `survivorAdmits`), read here and by the outbox.
                const deliverable = typeof cmd.prompt === 'string' && cmd.prompt.trim().length > 0
                  && survivorAdmits(survivor)
                  && !activeDeliveryFor(cmd.resumeSessionId);
                if (deliverable) {
                  starting = true; // hold this socket's session slot while the injection settles
                  const resumeId = cmd.resumeSessionId;
                  void deliverIntoSurvivor({ survivor, sdkSessionId: resumeId, prompt: cmd.prompt, client: send })
                    .then((handle) => {
                      starting = false;
                      if (!handle) return refuseDrainHeld();
                      // BUG-191: the envelope went out and the broker never
                      // answered — it may have arrived. Never a blind retry.
                      if (handle === 'uncertain') {
                        return send({
                          t: 'error', fatal: false, uncertain: true,
                          message: 'the surviving session did not confirm the delivery in time — your message may or may not have reached it. It is not resent automatically; check the transcript before sending it again.',
                        });
                      }
                      if (closedEarly) { handle.attachClient(null); return; }
                      delivery = handle;
                      console.log(
                        `[orchard] FEAT-065: delivered the message into the drain-held survivor ` +
                        `(broker pid ${survivor.hostPid}, CLI pid ${survivor.claudePid ?? '?'}) as a normal turn — session ${resumeId}`,
                      );
                      // The distinct ack the client renders as "delivered — the
                      // reply arrives from the transcript"; it retires the
                      // BUG-045 drain-wait row exactly once.
                      send({ t: 'ack', of: 'start', deliveredVia: 'survivor', sdkSessionId: resumeId });
                      /*
                       * BUG-072 — and immediately, the answer to "what is
                       * running": the client's ack handler clears its own
                       * optimistic busy state, so without this the strip is
                       * EMPTY for up to a poll interval while the turn we just
                       * injected runs. Same snapshot structure, same authority
                       * (the broker's declarations + this delivery's first-hand
                       * evidence); the 4s poll keeps it corrected afterwards.
                       */
                      const fresh = survivingHostForSession(resumeId) ?? survivor;
                      send({
                        t: 'running-snapshot',
                        snapshot: snapshotOfSurvivor(fresh, {
                          delivery: deliveryEvidenceFor(resumeId),
                          ended: outcomes.list({ sessionIds: [resumeId, fresh.stationSessionId], limit: 20 }),
                        }),
                      });
                    });
                  return;
                }
                return refuseDrainHeld();
              }
              // probe.state === 'dead' — the survivor is a corpse; do not block
              // the send behind a turn that is not actually running.
              dropDeadSurvivorHost(survivor);
              send({ t: 'status', status: `the previous survivor for this session was already finished (${probe.reason}) — dropped it and resuming from the transcript` });
            }
          }
          // Starting is async now: isolation "container" must have a live
          // container before the SDK spawns. `starting` holds the slot so a
          // second 'start' racing on the same socket can't open two sessions.
          /*
           * BUG-217 round 3 (plan review #6) — one prompt-bearing resume of a
           * session at a time, across sockets AND the outbox: two starts of one
           * session would put two CLIs onto one transcript (the BUG-022 shape).
           * `starting` is per socket, so it cannot say this. Retryable: the tab
           * hands the text to the session's outbox, which delivers it once the
           * first start is a live bridge.
           */
          const resumeOne = cmd.resumeSessionId && typeof cmd.prompt === 'string' && cmd.prompt.trim() ? cmd.resumeSessionId : null;
          if (resumeOne && resumeStarting.has(resumeOne)) {
            return send({
              t: 'error', fatal: false, retryable: true,
              message: 'another tab is starting this session right now — your message is queued and sends itself in a moment',
            });
          }
          if (resumeOne) resumeStarting.add(resumeOne);
          starting = true;
          // FEAT-078 native-Codex backfill: now done at the door (BUG-196 round 4), before the engine is resolved.
          send({ t: 'status', status: project.isolation === 'container' ? 'preparing container…' : 'starting…' });
          void startSession({
            project,
            firstPrompt: cmd.prompt,
            resumeSessionId: cmd.resumeSessionId,
            fork: cmd.fork,
            resumeEncodedDir: cmd.resumeEncodedDir,
            instructions,
            overrides,
            onEvent: send,
          })
            .then((s) => {
              starting = false;
              if (closedEarly) {
                void s.close('socket closed during start').catch(() => {});
                return;
              }
              session = s;
              send({
                t: 'ack',
                of: 'start',
                stationSessionId: s.id,
                isolation: project.isolation,
                containerName: s.containerName,
                instructionMode: s.composed.mode,
                appliedTemplates: s.composed.appliedIds,
                overridden: s.overriddenFields,
                effective: s.effective,
                capabilities: s.capabilities, // FEAT-037 P3: engine honesty flags
                permissionModeSource: s.permissionModeSource,
                fork: s.forkInfo(),
                // null = this session has NO restore point. Branch on
                // startSnapshotStatus, NOT on this being null: 'disabled' is a
                // setting, 'failed' is a problem, and they must not read alike.
                startSnapshotId: s.startSnapshotId,
                startSnapshotStatus: s.startSnapshotStatus,
                startSnapshotError: s.startSnapshotError,
              });
              // BUG-034: the client resets its view on the ack, so the running
              // set is re-published AFTER it — the first turn's `main` row must
              // not depend on the client having kept a frame that arrived
              // before it knew which session it was looking at.
              s.pushRunningSnapshot(true);
            })
            .catch(() => {
              // startSession already emitted a fatal 'error' event with the
              // real reason; re-emitting here would double-report it.
              starting = false;
            })
            .finally(() => { if (resumeOne) resumeStarting.delete(resumeOne); });
          return;
        }
        case 'send': {
          if (!session) return send({ t: 'error', message: 'no session on this socket', fatal: false });
          /*
           * FEAT-168 r6 — there is deliberately NO auto-reopen call here (or in
           * any other delivery path). CLOSED is derived: a session reads closed
           * only while its transcript's latest input prompt is the one recorded
           * at close (session-closed.ts), so this message reopens it the moment
           * the CLI records it — as does every other route, listed or not.
           */
          /*
           * Agent-targeted turns: refused, not faked. The SDK exposes no way to
           * deliver a message into a live subagent — pushing it would just run it
           * on the main thread while the UI showed it inside the agent's pane,
           * which is exactly the kind of lie this project exists to avoid.
           */
          if (cmd.targetAgentId) {
            const agent = session.liveAgents().find((a) => a.agentId === cmd.targetAgentId);
            send({
              t: 'subagent-send-unsupported',
              targetAgentId: cmd.targetAgentId,
              agentStatus: agent?.status ?? null,
              reason:
                'The Claude Agent SDK has no channel for sending a message into a running subagent. ' +
                'Its Query interface exposes no send-to-task method, and the only inbound task operations in the ' +
                'control protocol are stop_task and background_tasks — neither carries a message payload. ' +
                'Subagent transcripts are readable, but the conversation is one-way. ' +
                'Steer the main thread instead, or start a new turn describing what you want changed.',
            });
            return send({ t: 'ack', of: 'send', delivered: false, targetAgentId: cmd.targetAgentId });
          }
          // BUG-159 — send() no longer throws when a turn is in flight; it HOLDS
          // the message in the runtime input queue and reports `queued:true`. The
          // ack carries that through so the tab can caption it honestly ("queued
          // behind background work") instead of the old bare marker or a refusal.
          /*
           * BUG-191 — an ADOPT-GATED session takes a message only with the
           * broker's correlated acceptance, so this ack is sent only once the
           * broker has WRITTEN it. A refusal goes back retryable, tagged
           * `of:'send'` + the client's `sendId`, so the tab recovers exactly that
           * attempt's rows into its queue; an unanswered delivery is `uncertain`
           * (never a blind resend). Before this, the gate's throw reached the
           * socket catch-all below, which dropped `retryable`, and the tab kept a
           * bubble for a message that was never delivered.
           */
          const sendId = typeof cmd.sendId === 'string' ? cmd.sendId : undefined;
          // BUG-217 round 5: queued messages go first, and the outbox's own delivery is never raced.
          if (outboxBlocks(session.sdkSessionId)) {
            return send({ t: 'error', fatal: false, retryable: true, code: 'outbox-pending', of: 'send', sendId, message: OUTBOX_PENDING_MESSAGE });
          }
          if (session.adoptGated) {
            const sid = session.sdkSessionId;
            if (sid && deliveryInFlight.has(sid)) {
              return send({ t: 'error', fatal: false, retryable: true, of: 'send', sendId, message: 'another delivery into this session is in flight — your message is queued and sends itself in a moment' });
            }
            const token = Symbol('delivery');
            if (sid) deliveryInFlight.set(sid, token);
            void session.sendGated(cmd.prompt)
              .then((r) => {
                if (r.outcome === 'delivered') return send({ t: 'ack', of: 'send', delivered: true, queued: false, sendId });
                if (r.outcome === 'refused') return send({ t: 'error', fatal: false, retryable: true, of: 'send', sendId, message: r.message, drain: r.drain });
                return send({ t: 'error', fatal: false, uncertain: true, of: 'send', sendId, message: r.message });
              })
              .catch((err) => { send({ t: 'error', fatal: false, uncertain: true, of: 'send', sendId, message: `the delivery could not be confirmed (${(err as Error).message}) — it is not resent automatically; check the transcript before sending it again` }); })
              .finally(() => { if (sid && deliveryInFlight.get(sid) === token) deliveryInFlight.delete(sid); });
            return;
          }
          let sent: { delivered: boolean; queued: boolean };
          try {
            sent = session.send(cmd.prompt);
          } catch (err) {
            const e = err as Error & { retryable?: boolean; drain?: unknown };
            if (e.retryable) return send({ t: 'error', fatal: false, retryable: true, of: 'send', sendId, message: e.message, drain: e.drain as never });
            throw err;
          }
          return send({ t: 'ack', of: 'send', delivered: sent.delivered, queued: sent.queued, sendId });
        }
        case 'interrupt':
          if (!session) return send({ t: 'error', message: 'no session on this socket', fatal: false });
          void session.interrupt();
          return send({ t: 'ack', of: 'interrupt' });
        case 'approval-response': {
          /*
           * FEAT-065: a turn delivered into a drain-held survivor has no
           * AgentSession — its `can_use_tool` was relayed by the delivery
           * handle, and the answer goes back the same way (same ack shape, so
           * the client's approval card settles identically).
           */
          if (!session && delivery) {
            const ok = delivery.answerApproval(cmd.requestId, cmd.allow, cmd.message);
            return send({ t: 'ack', of: 'approval-response', requestId: cmd.requestId, matched: ok, allow: cmd.allow });
          }
          if (!session) return send({ t: 'error', message: 'no session on this socket', fatal: false });
          // Echo the request id: with concurrent approvals in flight the UI
          // cannot match a bare {matched} ack positionally without guessing.
          const ok = session.answerApproval(cmd.requestId, cmd.allow, cmd.message);
          return send({ t: 'ack', of: 'approval-response', requestId: cmd.requestId, matched: ok, allow: cmd.allow });
        }
        case 'question-response': {
          if (!session) return send({ t: 'error', message: 'no session on this socket', fatal: false });
          /*
           * Matched by requestId, never by order: two questions can be pending
           * at once, and a stale answer for one that already resolved must come
           * back `matched:false` rather than settle its neighbour.
           *
           * `answered` distinguishes a real answer from the deliberate "carry on
           * without me" pass — the UI must not show "answered" for the latter.
           */
          const r = session.answerQuestion(cmd.requestId, cmd.answers);
          return send({
            t: 'ack',
            of: 'question-response',
            requestId: cmd.requestId,
            matched: r.matched,
            answered: r.answered,
          });
        }
        case 'plan-response': {
          if (!session) return send({ t: 'error', message: 'no session on this socket', fatal: false });
          const ok = session.answerPlan(cmd.requestId, cmd.approved, cmd.message);
          return send({
            t: 'ack',
            of: 'plan-response',
            requestId: cmd.requestId,
            matched: ok,
            approved: cmd.approved,
          });
        }
        case 'set-permission-mode': {
          if (!session) {
            // Honest and specific: nothing to change, and the caller should use
            // start.overrides instead of assuming this silently queued.
            return send({
              t: 'ack', of: 'set-permission-mode', requestId: cmd.requestId, mode: cmd.mode, ok: false,
              error: 'no live session on this socket — set permissionMode in start.overrides instead',
            });
          }
          void session
            .setPermissionMode(cmd.mode)
            .then((r) =>
              send({ t: 'ack', of: 'set-permission-mode', requestId: cmd.requestId, mode: r.mode, ok: r.ok, error: r.error, appliesFrom: r.appliesFrom }),
            )
            .catch((err: Error) =>
              send({ t: 'ack', of: 'set-permission-mode', requestId: cmd.requestId, mode: cmd.mode, ok: false, error: err.message }),
            );
          return;
        }
        case 'set-model': {
          if (!session) {
            // Honest and specific: nothing to change on this socket, and the
            // caller should use start.overrides.model for a not-yet-started one.
            return send({
              t: 'ack', of: 'set-model', requestId: cmd.requestId, model: cmd.model, ok: false,
              error: 'no live session on this socket — set model in start.overrides instead',
            });
          }
          void session
            .setModel(cmd.model ?? null)
            .then((r) =>
              send({ t: 'ack', of: 'set-model', requestId: cmd.requestId, model: r.model, ok: r.ok, error: r.error }),
            )
            .catch((err: Error) =>
              send({ t: 'ack', of: 'set-model', requestId: cmd.requestId, model: cmd.model, ok: false, error: err.message }),
            );
          return;
        }
        case 'switch-account': {
          /*
           * FEAT-160 — switch the Claude account of a RUNNING session. The account
           * is a spawn-time env var (CLAUDE_CONFIG_DIR), so unlike set-model/
           * set-permission-mode it cannot be changed in place: this reaps the idle
           * CLI under the old account and the client re-resumes the SAME session id
           * under the new account via the ordinary start{resumeSessionId,
           * overrides:{claudeAccount}} path (BUG-022 survivor guard included).
           */
          const requestId = cmd.requestId;
          const ackFail = (error: string) => send({ t: 'ack', of: 'switch-account', requestId, ok: false, error });
          if (!session) {
            return ackFail('no live session on this socket — set the account with start.overrides.claudeAccount when you start one');
          }
          const proj = session.project;
          /*
           * Validate BEFORE touching the running session: existence + normalization
           * + the container refusal (validateSessionOverrides), then the loud
           * ready/credential gate (resolveLaunchAccountDir). A missing, container,
           * logged-out or credential-less account therefore fails here with the OLD
           * session still running and untouched — never silently spends the wrong
           * (or default) plan's quota.
           */
          let normalized: string | null;
          try {
            /*
             * FEAT-160 round 4 — resolve an "inherit / Project default" pick HERE, the
             * same way a FRESH session resolves its account: the project setting UNDER the
             * machine-wide default (`applyGlobalDefaults`). The client used to resolve it
             * as `project.settings.claudeAccount ?? null`, which omits the machine-default
             * layer that lives only on the server — so on a session billing the machine
             * default M, picking "Project default" bound `{account:null}` (~/.claude) and,
             * because the binding is authoritative, that mis-bind could not be corrected by
             * re-picking M. The client now sends the RAW choice (`inherit`) and the server
             * owns the full chain, so the binding gets the concrete account a new session
             * on this project would run on.
             */
            const requested = cmd.inherit === true
              ? applyGlobalDefaults({ model: null, effort: null, claudeAccount: proj.settings.claudeAccount ?? null }).claudeAccount
              : cmd.account;
            const v = validateSessionOverrides({ claudeAccount: requested }, { isolation: proj.isolation });
            normalized = (v.claudeAccount ?? null) as string | null;
            resolveLaunchAccountDir(normalized); // throws (AccountError) if not ready / no credential
          } catch (err) {
            return ackFail((err as Error).message);
          }
          /*
           * A turn in flight (a pending permission/question/plan card also keeps the
           * session busy) must finish first: reaping mid-turn truncates it and the
           * new CLI cannot pick up a half-delivered turn. Do NOT auto-interrupt.
           */
          if (session.busy) {
            return ackFail('finish or interrupt the current turn before switching accounts — the account applies to the next turn, which cannot start until this one ends');
          }
          const live = session;
          const sessionId = live.sdkSessionId ?? live.resumeOf ?? null;
          /*
           * FEAT-160 round 3 (plan review refuted the owed-work-gate plan) — the
           * account a session runs on is now a SERVER-OWNED fact (session-accounts.ts),
           * written HERE before the reap and read at the one spawn chokepoint (the
           * AgentSession constructor). So billing-correctness is no longer this gate's
           * job: whoever resumes this session next — this tab, another tab with a stale
           * override, the outbox pump replaying a queued row, a boot re-pump — reads the
           * bound account and cannot run it on the old one. A queued outbox row is
           * therefore SAFE to carry across the switch (it resumes under the NEW bound
           * account — "switch and continue", not a silent per-tab move), so it is NOT a
           * reason to refuse.
           *
           * This gate's ONLY remaining job is not to TRUNCATE live work by reaping it:
           *   - a turn in flight (checked above, and re-checked after the await);
           *   - work that OUTLIVES the turn — `closeLifetime()`, the SAME authority
           *     `releaseSocketSession`/`closeAllSessions` read (ARCH-002/ARCH-010), a
           *     background lane/subagent/Bash or a draining broker; anything but a
           *     settled `no` refuses (a lifetime-query error refuses too — biased to
           *     NOT reaping live work);
           *   - an ACTIVE delivery into the CLI right now (`deliveryInFlight` — which
           *     the outbox pump's reserve also sets — or a `resumeStarting` spawn):
           *     reaping mid-delivery truncates it, so refuse RETRYABLE.
           */
          if (!sessionId) {
            return ackFail('the session has not reported its id yet — wait a moment and switch again');
          }
          if (deliveryInFlight.has(sessionId) || resumeStarting.has(sessionId)) {
            return send({ t: 'ack', of: 'switch-account', requestId, ok: false, retryable: true, error: 'a message is being delivered into this session right now — try the switch again in a moment' });
          }
          // Hold the session's delivery reservation (the SAME map the outbox pump's
          // probe and the send path respect) across the whole reap, so no pump
          // delivery or second switch can interleave the close. Released in `finally`.
          const switchToken = Symbol('switch-account');
          deliveryInFlight.set(sessionId, switchToken);
          const releaseSwitch = () => { if (deliveryInFlight.get(sessionId) === switchToken) deliveryInFlight.delete(sessionId); };
          void (async () => {
            try {
              let cl: { lifetime: 'yes' | 'unknown' | 'no'; source: string };
              try { cl = await live.closeLifetime(); }
              catch (err) { return ackFail(`could not determine whether background work is still running under the current account (${(err as Error)?.message ?? err}) — not switching, so no in-flight work is reaped or mis-billed`); }
              if (live.closed) return ackFail('the session ended before the account could be switched — reopen it and switch before starting a turn');
              if (live.busy) return ackFail('finish or interrupt the current turn before switching accounts — the account applies to the next turn, which cannot start until this one ends');
              if (resumeStarting.has(sessionId)) return send({ t: 'ack', of: 'switch-account', requestId, ok: false, retryable: true, error: 'a resume of this session started while switching — try the switch again in a moment' });
              if (cl.lifetime !== 'no') {
                return ackFail(
                  `background work is still running under the current account (${cl.source}) — ` +
                  'wait for it to finish or stop it before switching, so the next turn does not bill the old account',
                );
              }
              /*
               * Commit: record the server-owned binding DURABLY before the reap. A
               * crash between here and the client's re-resume still resumes on the new
               * account, because every resume reads this binding. Only after it is
               * written do we reap.
               */
              try { setSessionAccount(sessionId, normalized); }
              catch (err) { return ackFail(`could not record the account switch (${(err as Error).message}) — not switching, so the session keeps its current account`); }
              // Detach this socket and reap the old CLI. close() sends a graceful
              // stdin-EOF, drains, removes the bridge — so the next resume takes the
              // clean resume path and reads the new bound account. Ack only AFTER the
              // reap, so the client never races a still-draining broker when it re-resumes.
              if (session === live) {
                if (delivery) { delivery.attachClient(null); delivery = null; }
                session = null;
              }
              try { await live.close('account switch (FEAT-160)'); }
              catch (err) { return send({ t: 'ack', of: 'switch-account', requestId, ok: false, error: `could not stop the current session to switch accounts: ${(err as Error).message}` }); }
              return send({ t: 'ack', of: 'switch-account', requestId, ok: true, account: normalized, sessionId });
            } finally {
              releaseSwitch();
            }
          })();
          return;
        }
        case 'follow': {
          if (!cmd.sessionId || !cmd.dir) return send({ t: 'error', message: 'follow requires sessionId and dir', fatal: false });
          const fkey = `${cmd.dir}\0${cmd.sessionId}`;
          if (follows.has(fkey)) return send({ t: 'ack', of: 'follow', already: true });
          /*
           * NEVER double-emit. If any live bridge is driving this SDK session,
           * that bridge already streams its messages; adding a file watch would
           * deliver every message twice.
           */
          // A DETACHED bridge streams to nobody — the file is then the only
          // truthful window into the running work, so watching it is right.
          const drivenHere = liveSessions().some((s) => s.sdkSessionId === cmd.sessionId && !s.detached);
          if (drivenHere) {
            send({
              t: 'follow-status', sessionId: cmd.sessionId, dir: cmd.dir, following: false,
              live: true,
              reason: 'this session is being driven by the dashboard — its live bridge is already the source of truth, so the file is not watched as well',
            });
            return send({ t: 'ack', of: 'follow', following: false });
          }
          const h = watcher.watchSession(cmd.dir, cmd.sessionId, (batch) => {
            send({
              t: 'session-appended',
              sessionId: batch.sessionId, dir: batch.dir,
              messages: batch.messages, bytesRead: batch.bytesRead,
              fileBytes: batch.fileBytes, resynced: batch.resynced,
            });
          });
          if (!h) {
            send({ t: 'follow-status', sessionId: cmd.sessionId, dir: cmd.dir, following: false, live: false, reason: 'no session file on disk for that dir/sessionId' });
            return send({ t: 'ack', of: 'follow', following: false });
          }
          follows.set(fkey, h);
          send({ t: 'follow-status', sessionId: cmd.sessionId, dir: cmd.dir, following: true, live: watcher.isSessionLive(cmd.dir, cmd.sessionId) });
          return send({ t: 'ack', of: 'follow', following: true, startCursor: h.startCursor });
        }
        case 'unfollow': {
          // No args = stop following everything on this socket (navigating away).
          const keys = cmd.sessionId && cmd.dir ? [`${cmd.dir}\0${cmd.sessionId}`] : [...follows.keys()];
          let n = 0;
          for (const k of keys) {
            const h = follows.get(k);
            if (!h) continue;
            h.close();
            follows.delete(k);
            n++;
          }
          return send({ t: 'ack', of: 'unfollow', stopped: n });
        }
        case 'close':
          // BUG-018: the client sends this EXPLICIT close on every session
          // switch/reopen (closeSocket() at the top of openSession()), not just
          // on a deliberate shutdown. It must be no more destructive than a raw
          // socket drop: a BUSY session with an open (unanswered) permission/
          // plan/question card must DETACH — preserving it in the live registry
          // and KEEPING its #approvals for reattach/replay (BUG-008) — NOT
          // close+auto-deny+vacate. This mirrors the ws.on('close') path below;
          // an IDLE session with no work outliving its turn still closes
          // normally (BUG-043 added the second half of that test).
          // FEAT-065: an explicit close detaches the delivery relay too — the
          // injected turn keeps running in the survivor; any later approval it
          // raises takes the bounded deny (nobody is attached to answer).
          if (delivery) { delivery.attachClient(null); delivery = null; }
          releaseSocketSession(session, 'client closed');
          session = null;
          return send({ t: 'ack', of: 'close' });
        default:
          return send({ t: 'error', message: `unknown command ${(cmd as { type: string }).type}`, fatal: false });
      }
    } catch (err) {
      send({ t: 'error', message: (err as Error).message, fatal: false });
    }
  });

  ws.on('close', () => {
    closedEarly = true;
    /*
     * FEAT-145 — a login belongs to the socket that started it. A closed tab is
     * an abandoned attempt: kill the CLI's whole process group and remove the
     * half-made account, rather than leaving a blocked-on-stdin CLI and a
     * pending row behind with nothing able to finish either.
     */
    if (loginAccountId) {
      cancelClaudeLogin(loginAccountId, 'the dashboard connection closed');
      loginAccountId = null;
    }
    // A leaked fs.watch is a real leak: release every follow this socket held.
    for (const h of follows.values()) h.close();
    follows.clear();
    // FEAT-065: the delivery relay's client is gone — detach it. The injected
    // turn keeps running in the survivor; pending/future approvals take the
    // bounded deny path instead of waiting on a dead socket.
    if (delivery) { delivery.attachClient(null); delivery = null; }
    // A BUSY session must not die because its tab looked away — detach it and
    // let the work finish (it self-closes at the turn boundary, or a returning
    // socket re-attaches). An idle session closes as before: resume recreates
    // it cheaply, and keeping idle CLIs alive would just leak processes —
    // UNLESS live background work outlives the turn (BUG-043).
    releaseSocketSession(session, 'socket closed');
    session = null;
  });
});

/* ------------------------------------------------------------------ startup */

/*
 * A local dashboard must not lose every other live session because one session's
 * transport misbehaved. The Agent SDK rejects its internal pending control
 * responses during cleanup ("Query closed before response received") with no
 * catcher, which killed the whole server — observed while closing a session
 * mid-request. Log loudly, keep serving. Nothing is swallowed silently.
 */
process.on('unhandledRejection', (reason) => {
  const e = reason as Error;
  console.error(`[orchard] UNHANDLED REJECTION (server kept running): ${e?.stack ?? String(reason)}`);
});
process.on('uncaughtException', (err) => {
  console.error(`[orchard] UNCAUGHT EXCEPTION (server kept running): ${err?.stack ?? String(err)}`);
});

/*
 * BUG-117 — a boot that MEANT to be isolated and missed must find out here, not
 * from the user's session ending. `assertDataDirIntent` throws when a
 * data-dir-shaped variable is set while the one real knob (`CLAUDE_STATION_DATA`)
 * is not: that combination means the caller believes it is pointed at a scratch
 * tree while every destructive path in this process — chiefly the survivor
 * re-adopt below — is aimed at the real one.
 */
try {
  assertDataDirIntent();
} catch (err) {
  console.error(`[orchard] REFUSING TO START — ${(err as Error).message}`);
  process.exit(78); // EX_CONFIG
}

// This process IS the production station server — the one sanctioned writer of
// real ~/.claude/projects transcripts through ClaudeRuntime. Mark it so the
// fixture-pollutes-reality guard (assertSessionStoreIsolated) lets the user's
// real sessions through while still refusing an in-process verification harness
// that reaches a real-store write. A spawned TEST server also runs this line,
// but such suites isolate CLAUDE_STATION_DATA, which the guard's other arm
// catches independently.
markSanctionedRealStoreWriter();

ensureDir(dataDir());
/*
 * BUG-217 rounds 7–9 (and BUG-220) — ONE SERVER PER DATA DIR, enforced by the
 * kernel. Two servers on one CLAUDE_STATION_DATA each loaded the outbox into
 * their own memory and both handed the same queued message to the CLI (CLI ×2);
 * they also race the registry, the session hosts, the containers and the lane
 * ledger. The lock (`lanes.claimDataDir`) is an exclusive flock on the data
 * DIRECTORY's own inode: a symlink, a bind mount (a container volume), another
 * namespace or a rename all reach the same lock, there is no lock file to
 * delete or replace, and the kernel frees it when the holder dies, even by
 * kill -9. If the path later names a different directory (moved and copied
 * back), the holder stops and exits — see `onWriterLost` below. It
 * is taken HERE, before anything below reads or writes the data dir. A restart
 * that overlaps its predecessor waits for it, bounded; a holder still there
 * after that is another server, and this one refuses to start.
 */
{
  const waitMs = (() => { const v = Number(process.env.CLAUDE_STATION_DATA_LOCK_WAIT_MS); return Number.isFinite(v) && v >= 0 ? v : 30_000; })();
  const lock = await lanes.claimDataDir({
    port: PORT,
    waitMs,
    onWait: (h) => console.log(`[orchard] data dir ${dataDir()} is held by another Orchard server (${lanes.describeHolder(h)}) — waiting up to ${Math.round(waitMs / 1000)}s for it to exit (a restart overlap)`),
  });
  if (!lock.ok && lock.reason === 'held') {
    console.error(
      `[orchard] REFUSING TO START — another Orchard server is using the data dir ${dataDir()} (${lanes.describeHolder(lock.holder)}; it holds the lock on the directory ${lock.name}), ` +
      `and it was still there after ${Math.round(lock.waitedMs / 1000)}s. One data dir has exactly one server: two would each send the same queued ` +
      'message and race the registry, the session hosts and the containers. Stop that server, or point CLAUDE_STATION_DATA at another directory.',
    );
    process.exit(78); // EX_CONFIG, the same refusal as a mis-set data dir above
  }
  if (!lock.ok) {
    console.error(`[orchard] REFUSING TO START — cannot lock the data dir ${dataDir()}, so nothing guarantees it has one server: ${lock.reason}`);
    process.exit(78);
  }
  if (lock.waitedMs >= 200) console.log(`[orchard] data dir lock taken after waiting ${(lock.waitedMs / 1000).toFixed(1)}s for the previous server to exit`);
}
/*
 * ARCH-022 — container lifecycle RECOVERY, right after the data-dir claim and before anything can admit a
 * session (the outbox below can start one): persisted leases and every session exec still running in a
 * container become draining leases, so a crashed or restarted server's work is protected. Every
 * lifecycle operation waits for this to finish; none can run before it.
 */
void lifecycle.recover().then(() => {
  // ARCH-022 / BUG-219: who this instance IS, as declared in its data dir (never inferred from a path or env).
  const b = boundInstance();
  if (b) {
    console.log(`[orchard] instance ${b.identity.id} (declared in ${b.dir}/orchard-instance.json)${b.identity.legacyKey ? `, also owning its pre-identity objects (key ${b.identity.legacyKey})` : ''}; ` +
      (b.liveDeclared ? 'LIVE instance (declared by the user): adopts pre-label objects'
        : 'NOT declared live: adopts no unlabelled or pre-identity object (refuses and reports them). If this is your live Orchard: node scripts/orchard-live-instance.mjs declare, then restart'));
  }
}).catch((err) => console.error(`[orchard] container lifecycle recovery FAILED — no container operation will run: ${(err as Error).message}`));
/*
 * FEAT-157 — the one-time base-pin migration: every container project without a pin is pinned to exactly the base
 * its container runs (`legacy:<tag>` for a pre-release base); nothing is rebuilt or recreated. One lifecycle
 * operation per project (ARCH-022), queued behind recovery.
 */
void (async () => {
  try {
    const mig = await cm.migrateAllBasePins((l) => console.log(l.trimEnd()));
    console.log(`[orchard] base-pin migration done: migrated ${mig.migrated.length}, pending ${mig.pending.length}${mig.pending.length ? ` (${mig.pending.join(', ')}: decided at their next launch)` : ''}`);
  } catch (err) { console.warn(`[orchard] base-pin migration skipped: ${(err as Error).message}`); }
})();
// BUG-217 round 5: load every session's outbox and start delivering — a row
// queued before this boot goes by itself, whether or not any tab ever opens.
startOutbox(outboxWiring);
/*
 * BUG-217 round 9: the data dir this server locked is no longer the one at its path (moved away, a copy put
 * back). The outbox has already stopped and marked its in-flight rows "not confirmed" in the dir it holds
 * (it registered first); this server must not carry on as a writer of a path it does not own, so it exits.
 * Exit 75 (EX_TEMPFAIL): systemd's Restart=on-failure starts a fresh server, which locks whatever directory
 * the path names now — or refuses, if another server already holds that one.
 */
lanes.onWriterLost((why) => {
  console.error(`[orchard] EXITING — ${why}. Nothing more is sent from this process. Start Orchard again to serve the directory now at ${dataDir()}; the moved directory's unsent messages are kept there, marked "not confirmed".`);
  process.exit(75);
});
const seedResult = tpl.seedTemplates();

server.listen(PORT, HOST, () => {
  console.log(`[orchard] http://${HOST}:${PORT}`);
  console.log(`[orchard] data dir: ${dataDir()} (${dataDirMode() === 'isolated' ? 'ISOLATED — explicit CLAUDE_STATION_DATA' : 'SHARED default — this is the real data dir, session hosts here may be the user\'s'})`);
  console.log(`[orchard] templates seeded: ${JSON.stringify(seedResult)}`);
  console.log(`[orchard] projects registered: ${reg.listProjects().length}`);
  /*
   * FEAT-015 re-adopt. A prior server may have been restarted while driving
   * `direct` sessions whose CLI was launched to survive (its own systemd scope +
   * broker). Those brokers are still running with the in-flight turn draining;
   * re-adopt them so the turn completes and they are reaped cleanly rather than
   * left idling. The thread then continues by normal resume-from-disk. A boot
   * with no survivors is a no-op.
   */
  try {
    /*
     * BUG-187 I1 — a survivor holding live work (lanes, a turn, pending
     * requests) is ADOPTED: a responder is re-attached to its running CLI
     * (attach facade → the SDK's initialize becomes the CLI's repeated
     * initialize). Idle survivors are reaped as before. Each broker's
     * disposition is logged by the session once its adoption settles.
     */
    const adopted = adoptSurvivingHosts((m) => console.log(m), (st, why) => {
      const project = projectForSurvivor(st);
      if (!project) {
        /*
         * Nothing to adopt it INTO: fall back to the pre-BUG-187 disposition —
         * the graceful reap, whose drain HOLDS while its lanes are live (no EOF,
         * BUG-044) and keeps FEAT-065 delivery possible (it gates on
         * `draining`). A protocol-2 broker's request floor then bounds any lane
         * that cannot get an answer.
         */
        console.warn(
          `[orchard] BUG-187: cannot adopt broker pid ${st.hostPid} (${why}) — no registered project matches it ` +
          `(record projectId ${st.projectId ?? 'absent'}). Falling back to the graceful reap (its drain holds while its lanes live).`,
        );
        reapHost(st.status);
        return;
      }
      const facade = attachSurvivable(st);
      adoptSession(st, facade, project);
    });
    if (adopted) console.log(`[orchard] re-adopted ${adopted} surviving session host(s) from a prior run`);
  } catch (err) {
    console.warn(`[orchard] survivor re-adopt scan failed: ${(err as Error).message}`);
  }
  /*
   * BUG-033 — the zombie reaper. `busy` used to be a claim nothing ever
   * re-checked: a CLI killed mid-turn leaves the stream half-dead with no
   * terminal frame, so the bridge sat `busy: true` for the server's whole
   * lifetime, the UI rendered "Running ◐" over nothing, and every message the
   * user typed was accepted-and-queued into a queue that could never drain.
   * The sweep re-checks the claim against ground truth (the CLI's pid) and
   * drops any bridge that cannot still be running, announcing it.
   */
  startZombieReaper();
  console.log(`[orchard] zombie reaper armed (${livenessWindowsSummary()})`);
  /*
   * ARCH-017 step 1 — a `running` lane record is a CLAIM, not a fact. The
   * settle write lives in this process; a server restart mid-lane would leave
   * the record `running` forever (and, from step 2 on, silently freeze every
   * already-settled sibling in its group). Re-check each claim against ground
   * truth — the child's pid AND a lane-id token in its argv — and resolve it
   * honestly. Records owned by another LIVE server are left alone. Never fatal:
   * the ledger is write-only in this step and nothing reads it yet.
   */
  void (async () => {
    try {
      /*
       * The ledger has ONE writer, arbitrated by the kernel (see `claimWriter`).
       * Taking it is an awaited startup act: a second Orchard server against the
       * same data dir is refused here and writes nothing, rather than quietly
       * interleaving writes and losing records.
       */
      // Already held since boot (the data-dir lock above); this re-confirms it, and cannot fail while this process lives.
      const claim = await lanes.claimWriter();
      if (!claim.ok) {
        console.warn(`[orchard] lane ledger: another process holds the writer claim for ${dataDir()} (${claim.reason}) — this server will not write or reconcile lane records`);
        return;
      }
      const laneRecon = lanes.reconcileBoot();
      if (laneRecon.checked || laneRecon.groupsClosedByDeadline) {
        // STEP 2 added two outcomes to this pass; a boot that adopts a live
        // fan-out or closes a forgotten group must SAY so, or the two most
        // consequential things reconciliation now does are invisible.
        console.log(`[orchard] lane ledger reconciled: ${laneRecon.checked} non-terminal record(s) — ${laneRecon.adopted} adopted, ${laneRecon.cut} cut, ${laneRecon.leftRunning} left to a live owner; ${laneRecon.groupsClosedByDeadline} group(s) closed by a passed deadline`);
        for (const d of laneRecon.details) console.log(`[orchard]   ${d}`);
      }
    } catch (err) {
      console.warn(`[orchard] lane ledger reconciliation failed (server unaffected): ${(err as Error).message}`);
    }
  })();
  /*
   * FEAT-108 round 2 — durable trail of PERMITTED agent git writes. The store's
   * ledger is memory-only (cleared on restart, fail-closed); this appends each
   * record to a host-side log under the data dir so the user can see, after the
   * fact, exactly which grants let which git writes through. dataDir() is host-
   * only, never the project repo, so nothing is written into a public-bound tree.
   */
  try {
    const auditFile = path.join(dataDir(), 'git-write-audit.jsonl');
    setGitWriteAuditSink((rec) => {
      try { fs.appendFileSync(auditFile, JSON.stringify(rec) + '\n'); } catch { /* audit must never break a decision */ }
    });
    console.log(`[orchard] git-write audit log: ${auditFile} (FEAT-108)`);
  } catch (err) {
    console.warn(`[orchard] could not arm git-write audit log: ${(err as Error).message}`);
  }
  /*
   * FEAT-019 (2026-08-05, user decision): automatic Working-Agreement consolidation.
   * Every project captures into the same canonical methodology repo, so drift
   * accumulates from anywhere; a boot-time safe-class pass (`wa-consolidate --apply`:
   * relocate project-specific leaks / merge near-dups / mechanical cleanup — each
   * pass one revertable git commit + CHANGELOG entry) catches it. NON-BLOCKING and
   * FAILURE-TOLERANT by contract: a broken/missing methodology repo must NEVER
   * affect server startup — log honestly and keep serving. Contradictions are never
   * auto-applied; the pass lists them as needs-human. Opt out (e.g. test fleets
   * booting many servers) with CLAUDE_STATION_NO_WA_CONSOLIDATE=1.
   */
  if (!process.env.CLAUDE_STATION_NO_WA_CONSOLIDATE) {
    try {
      /*
       * BUG-040 — the pass acts on the SERVER'S configured world, never on a
       * module-relative path. Bare `--apply` used to let wa-consolidate default
       * its conventions/board dir to the repo the SCRIPT lives in, so ANY boot
       * (scratch verify servers included) mutated the real repo's
       * docs/bugs/.arch/findings.json and could append to its CONVENTIONS.md.
       * Now: the project-side half targets the methodology-home project ONLY if
       * THIS server's registry contains it (same hostPath === projectRoot()
       * rule the board route uses); a server whose world does not include this
       * repo runs with --no-arch and points conventions inside its own dataDir,
       * so it cannot touch a repo it was never configured with. The WA half is
       * already env-scoped (METHODOLOGY_DIR).
       */
      const home = reg
        .listProjects()
        .map((p) => path.resolve(p.hostPath))
        .find((h) => h === projectRoot());
      const passArgs = [path.join(projectRoot(), 'scripts', 'wa-consolidate.mjs'), '--apply'];
      if (home) passArgs.push('--conventions-dir', home);
      else passArgs.push('--no-arch', '--conventions-dir', path.join(dataDir(), 'consolidation'));
      const child = spawn(process.execPath, passArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => (out += String(d)));
      child.stderr.on('data', (d) => (out += String(d)));
      child.on('error', (err) => {
        console.warn(`[orchard] WA consolidation pass could not start (server unaffected): ${err.message}`);
      });
      child.on('close', (code) => {
        const tail = out.trim().split('\n').slice(-4).join(' | ');
        if (code === 0) console.log(`[orchard] WA consolidation pass ok: ${tail || '(no output)'}`);
        else console.warn(`[orchard] WA consolidation pass failed (exit ${code}) — server unaffected: ${tail}`);
      });
      child.unref();
    } catch (err) {
      console.warn(`[orchard] WA consolidation pass skipped (server unaffected): ${(err as Error).message}`);
    }
  }
});

/*
 * Periodic orphan sweep for stealth browsers.
 *
 * `sbmcp reap` only touches projects whose socket is DEAD, so it can never kill
 * a live browser — it cleans up after a daemon that was SIGKILLed and left
 * Chrome behind. Deliberately NOT a stop-everything timer: shutting a browser
 * down on idle is the adapter's own job (SBMCP_IDLE_MS) and reimplementing it
 * here would fight it.
 */
const BROWSER_REAP_MS = 5 * 60 * 1000;
const browserReaper = setInterval(() => {
  if (!browser.available().ok) return;
  try {
    const r = browser.reap();
    if (r.output && !/no orphans found/.test(r.output)) console.log(`[orchard] browser reap: ${r.output}`);
  } catch (err) {
    console.warn(`[orchard] browser reap failed: ${(err as Error).message}`);
  }
}, BROWSER_REAP_MS);
browserReaper.unref();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  stopOutbox(); // BUG-217 round 5: hand nothing more over while going down — queued rows wait on disk for the next boot
  clearInterval(browserReaper);
  console.log(`[orchard] ${signal} — closing sessions`);
  /*
   * HAND OFF, don't kill (FEAT-015). Survivable "direct" sessions keep their
   * broker + CLI running in their own scope across this restart, so an in-flight
   * turn (and its in-process sub-agents) is not reaped with the server; the next
   * server re-adopts them. Container / non-survivable sessions still close
   * normally so no exec is stranded. NB: under KillMode=control-group the
   * survivors are spared only because they live in a SEPARATE cgroup — this
   * handoff just makes the server not close them itself.
   */
  await closeAllSessions(signal, { handoff: true });
  /*
   * Browsers are deliberately LEFT RUNNING on shutdown. They are per-project
   * host daemons with their own idle timeout, independent of this server's
   * lifetime — killing a logged-in browser because the dashboard restarted
   * would lose the user's sessions. `reap` sweeps genuinely broken ones.
   */
  try {
    if (browser.available().ok) {
      const live = reg
        .listProjects()
        .filter((p) => reg.browserSettingsOf(p).enabled)
        .map((p) => {
          try {
            return browser.status(p);
          } catch {
            return null;
          }
        })
        .filter((s): s is browser.BrowserStatus => !!s && s.running);
      if (live.length) {
        console.log(
          `[orchard] leaving ${live.length} stealth browser(s) running (idle timeout owns them): ` +
            live.map((s) => `${s.project}@${s.socket}`).join(', '),
        );
      }
    }
  } catch {
    /* best effort — never block shutdown on this */
  }
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

export { server, getSession };
