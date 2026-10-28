/**
 * FEAT-164 option A (user decision 2026-10-12), part O1 — WHO is calling a grant route.
 *
 * Agents, the server and the user's browser are one uid, and the HTTP API has no auth, so
 * before this an agent session could POST the git-write grant route, set the agent git
 * policy, or answer its own git-write request "Allow". The one thing a same-uid agent does
 * not choose is WHERE its process sits: an Orchard session runs in this server's
 * `claude-station-host-<key>.scope` (survival on) or as a descendant of the server process
 * (survival off), and so does every command its Bash runs. This module maps the request's
 * loopback peer to the owning process(es) through the OS (/proc/net/tcp{,6} → socket inode
 * → /proc/<pid>/fd) and classifies it.
 *
 * `requireUserCaller` is THE gate every route that mints or raises git-write authority calls
 * before it writes, and every mutating action of the user's git panel (which runs git in
 * the server, outside the shim and the grant). Revoking is not gated (giving up access is never a self-grant).
 *
 * Fail closed: a loopback caller whose process cannot be found is refused. A NON-loopback peer
 * is ALSO refused (kind 'unknown') — the server binds 127.0.0.1 only, so a legitimate caller is
 * always loopback (the phone arrives through tailscaled's loopback proxy; see acceptPairedCaller /
 * device-pairing.ts). A same-uid agent can otherwise bind its client socket to a local
 * non-loopback source and connect to 127.0.0.1 to look "remote" and self-grant (FEAT-196,
 * independent-verify BROKEN). The remote user grants via a PAIRING TOKEN, not by looking remote.
 *
 * FEAT-164 r8: a process in ANY `claude-station-host-*.scope` (a dead session's too) is an
 * agent — agent-owned browsers outlive their session in its scope (classifyPid rule 5).
 *
 * RESIDUALS (named on the decision card; same class as ARCH-021's host residual): a
 * same-uid agent that deliberately escapes its scope (`systemd-run --user --scope …`) or
 * relays through a process outside it classifies as the user; so does an agent that
 * puppets the USER'S OWN browser (CDP attach to a browser the user started) — only a
 * human-presence check (option B) tells those apart. Rule 5 rests on systemd keeping a
 * survivor in its scope's cgroup after the session's main process exits (systemd 258+
 * observed). A browser an agent STARTED for the user (xdg-open with none running) lives in
 * the session scope, so the user's grants from it are refused until it restarts (closed). A terminal the SERVER spawned
 * (git panel "open terminal") is a server descendant, so a grant typed there is refused
 * (fails closed; grant from the dashboard instead).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { hostsDir } from './survival.ts';
import { validatePairingToken } from './device-pairing.ts';

export type CallerKind = 'user' | 'agent' | 'unknown';
export interface CallerVerdict { kind: CallerKind; pids: number[]; why: string }

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;

function socketInodes(peerPort: number, serverPort: number): string[] {
  const out: string[] = [];
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c.length < 10) continue;
      const lp = parseInt(c[1].split(':').pop() ?? '', 16);
      const rp = parseInt(c[2].split(':').pop() ?? '', 16);
      // The CLIENT end of the connection: its local port is the peer port we saw.
      if (lp === peerPort && rp === serverPort && c[9] !== '0') out.push(c[9]);
    }
  }
  return out;
}

/**
 * FEAT-196 — the OWNER UID of the CLIENT end of the loopback connection, read from
 * /proc/net/tcp{,6} column 7 (world-readable, unlike /proc/<pid>/fd). This is how a
 * user-run server can tell "the request came through root-owned tailscaled's proxy
 * connection" (uid 0) apart from "a same-uid agent curled 127.0.0.1 directly" (uid ==
 * the server's own uid) WITHOUT needing to read the root process's fds (the EACCES that
 * made classifyCaller fail closed for the `tailscale serve` path). Pure over the proc
 * text so it is unit-testable with a crafted root row. Returns null when no matching
 * row is found (fail closed: a token is then not honoured).
 */
export function peerUidFromProc(procText: string, peerPort: number, serverPort: number): number | null {
  for (const line of procText.split('\n').slice(1)) {
    const c = line.trim().split(/\s+/);
    if (c.length < 10) continue;
    const lp = parseInt(c[1].split(':').pop() ?? '', 16);
    const rp = parseInt(c[2].split(':').pop() ?? '', 16);
    // The CLIENT end: its local port is the peer port we saw, its remote port is ours.
    if (lp === peerPort && rp === serverPort && c[9] !== '0') {
      const uid = Number(c[7]);
      if (Number.isInteger(uid)) return uid;
    }
  }
  return null;
}

function peerUid(peerPort: number, serverPort: number): number | null {
  let out: number | null = null;
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const uid = peerUidFromProc(text, peerPort, serverPort);
    if (uid !== null) { out = uid; break; }
  }
  return out;
}

function pidsHoldingSockets(inodes: string[]): number[] {
  const want = new Set(inodes.map((i) => `socket:[${i}]`));
  const pids: number[] = [];
  let entries: string[] = [];
  try { entries = fs.readdirSync('/proc'); } catch { return pids; }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    let fds: string[];
    try { fds = fs.readdirSync(`/proc/${e}/fd`); } catch { continue; }
    for (const fd of fds) {
      let link: string;
      try { link = fs.readlinkSync(`/proc/${e}/fd/${fd}`); } catch { continue; }
      if (want.has(link)) { pids.push(Number(e)); break; }
    }
  }
  return pids;
}

function parentOf(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = Number(rest[1]);
    return Number.isFinite(ppid) && ppid > 0 ? ppid : null;
  } catch { return null; }
}

function cgroupOf(pid: number): string | null {
  try {
    const line = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8').split('\n').find((l) => l.startsWith('0::'));
    return line ? line.slice(3).trim() : null;
  } catch { return null; }
}

/** Is `pid` inside one of THIS server's session-host scopes? (Its hosts dir names them.) */
function inOwnSessionScope(pid: number): string | null {
  let cg = '';
  try { cg = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8'); } catch { return null; }
  const m = /claude-station-host-([A-Za-z0-9_-]+)\.scope/.exec(cg);
  if (!m) return null;
  const key = m[1];
  const dir = hostsDir();
  for (const suffix of ['.json', '.ctl.json', '.sock']) {
    if (fs.existsSync(path.join(dir, `${key}${suffix}`))) return key;
  }
  return null;
}

/** Any Orchard session-host scope, of ANY server, live or dead (FEAT-164 r8). */
const ANY_SESSION_SCOPE = /claude-station-host-[A-Za-z0-9_-]+\.scope/;

/**
 * FEAT-164 r8 — the cgroup of the process that LAUNCHED this server, read once at boot.
 * Whoever launches a server already controls it completely (its env, its data dir, its
 * code), so that process's own cgroup is the user for it. For the live service that is
 * systemd --user (init.scope), where no agent runs. For a scratch server it is the test
 * runner — usually an agent in its OWN live session scope — so a suite's own fetch or
 * browser stays the user of the scratch server it booted, while rule 5 below still makes
 * every OTHER session scope an agent. Honoured only as an exact match on a LEAF `.scope`
 * cgroup (never a slice, a service, or the root), so it cannot widen to a shared parent.
 */
const launcherCgroup: string | null = (() => {
  try {
    const cg = cgroupOf(process.ppid);
    return cg && /\/[^/]+\.scope$/.test(cg) ? cg : null;
  } catch { return null; }
})();

/**
 * Classify one local process. Order is load-bearing:
 *  1. the server process itself (an in-process caller) is not an agent;
 *  2. a process in one of THIS server's session scopes is an agent;
 *  3. a process descending from the server (a survive=0 session, a command it ran) is an agent
 *     — before 4, because such a session shares its launcher's cgroup;
 *  4. a process in the cgroup of the process that launched this server is the user;
 *  5. FEAT-164 r8: a process in ANY claude-station-host-*.scope is an agent, whether or not
 *     this server's hosts dir still names it. Agent-owned browsers outlive their session and
 *     stay in that dead session's scope, reparented to systemd --user (observed live
 *     2026-10-20: a headless Brave render-check browser and the shared stealth-browser MCP
 *     daemon). Under rules 1–3 alone they read as the user, so an agent driving one could
 *     click "Allow" on the live dashboard. The user's own browser and terminal live in
 *     app-*.scope / session-*.scope, never in a session-host scope;
 *  6. a process sharing the server's .service cgroup is an agent;
 *  7. otherwise the user.
 */
function classifyPid(pid: number): { agent: boolean; why: string } {
  if (pid === process.pid) return { agent: false, why: 'the server process itself' };
  const key = inOwnSessionScope(pid);
  if (key) return { agent: true, why: `pid ${pid} runs in this server's session scope claude-station-host-${key}` };
  let p: number | null = parentOf(pid);
  for (let hops = 0; p && p > 1 && hops < 256; hops++) {
    if (p === process.pid) return { agent: true, why: `pid ${pid} descends from the server process (a session or command the server launched)` };
    p = parentOf(p);
  }
  const cg = cgroupOf(pid);
  if (launcherCgroup && cg === launcherCgroup) return { agent: false, why: `pid ${pid} is in the cgroup of the process that launched this server` };
  const foreign = cg ? ANY_SESSION_SCOPE.exec(cg) : null;
  if (foreign) return { agent: true, why: `pid ${pid} runs in an Orchard session scope (${foreign[0]}) — an agent's process, even after its session ended` };
  // A server run as a systemd SERVICE keeps everything it launched in its own cgroup, even
  // a process that backgrounded itself (setsid/nohup reparents to init). Nothing of the
  // user's (browser, terminal) lives in that service cgroup.
  const own = cgroupOf(process.pid);
  if (own && /\.service$/.test(own) && cg === own) {
    return { agent: true, why: `pid ${pid} shares the server's service cgroup ${own}` };
  }
  return { agent: false, why: `pid ${pid} is outside this server's sessions` };
}

export function classifyCaller(req: IncomingMessage): CallerVerdict {
  const sock = req.socket;
  const remote = String(sock.remoteAddress ?? '');
  const local = String(sock.localAddress ?? '');
  const isLocal = LOOPBACK.test(remote) || (remote !== '' && remote === local);
  // FEAT-196 (independent-verify run 01a17ef5, BROKEN) — fail CLOSED on a non-loopback peer,
  // never 'user'. The server binds 127.0.0.1 only, so a legitimate caller is ALWAYS loopback
  // (the phone reaches it through tailscaled's loopback proxy — see acceptPairedCaller). But a
  // same-uid agent can make its OWN connection look non-loopback by binding its client socket's
  // source to a local non-loopback address (100.x/192.168.x/…) while still connecting to
  // 127.0.0.1; the kernel accepts it and req.socket.remoteAddress is then that non-loopback
  // address. The prior code trusted that as a "remote human = user" and MINTED a grant for the
  // agent (verified: a real agent session got HTTP 200 + a permanent grant, and enrolled its own
  // pairing). This is the latent L175 shortcut FEAT-196's diagnosis explicitly warned about. A
  // non-loopback peer is now 'unknown' → every requireUserCaller route (grant, pairing, …)
  // refuses it. regressed-from: FEAT-164 (the shortcut shipped with the provenance gate).
  if (!isLocal) return { kind: 'unknown', pids: [], why: `non-loopback peer ${remote} to a loopback-only server — cannot be the user (FEAT-196, fails closed)` };
  const peerPort = Number(sock.remotePort), serverPort = Number(sock.localPort);
  const inodes = socketInodes(peerPort, serverPort);
  const pids = inodes.length ? pidsHoldingSockets(inodes) : [];
  if (!pids.length) return { kind: 'unknown', pids, why: `no local process found for ${remote}:${peerPort}` };
  for (const pid of pids) {
    const c = classifyPid(pid);
    if (c.agent) return { kind: 'agent', pids, why: c.why };
  }
  return { kind: 'user', pids, why: classifyPid(pids[0]).why };
}

/**
 * FEAT-196 — a request from the USER's paired REMOTE device (their phone over
 * `tailscale serve`). Accepted ONLY when BOTH hold, so no agent can reach it:
 *  1. the connection came THROUGH tailscaled's root proxy — the loopback peer socket is
 *     owned by uid 0, which a same-uid agent (its own direct curl of 127.0.0.1) can never
 *     be, and which a user-run server CAN read (unlike the root process's fds); and
 *  2. the request carries a pairing token that validates against the sealed, hashed store.
 * A same-uid agent's direct loopback curl fails (1) even with a leaked token; a forged
 * header with no valid token fails (2). Only routes that opt in (allowPaired) consult this.
 */
/**
 * Test-only seam (same safe pattern as git-grant-store._setXForTest): overrides how the peer
 * uid is read, so an in-process test can exercise the root-proxy branch that a uid-1000 test
 * cannot create for real. ONLY ever set from within the test process; the server never sets
 * it, and an agent is a SEPARATE process that cannot reach this module's state. Null = real.
 */
let peerUidResolverForTest: ((req: IncomingMessage) => number | null) | null = null;
export function __setPeerUidResolverForTest(fn: ((req: IncomingMessage) => number | null) | null): void {
  peerUidResolverForTest = typeof fn === 'function' ? fn : null;
}

function acceptPairedCaller(req: IncomingMessage): string | null {
  const token = req.headers['x-orchard-pairing'];
  const tok = Array.isArray(token) ? token[0] : token;
  if (!tok) return null;
  const sock = req.socket;
  const remote = String(sock.remoteAddress ?? '');
  if (!LOOPBACK.test(remote)) return null; // the serve proxy connects over loopback
  const uid = peerUidResolverForTest ? peerUidResolverForTest(req) : peerUid(Number(sock.remotePort), Number(sock.localPort));
  if (uid !== 0) return null; // (1) root proxy only — a same-uid agent's direct curl never qualifies
  return validatePairingToken(tok); // (2) valid token → the pairing id, else null
}

/**
 * THE gate. Returns null when the caller is the user; otherwise a 403 body the route sends
 * unchanged (nothing written). `what` names the action for the refusal and the log.
 */
export function requireUserCaller(
  req: IncomingMessage,
  what: string,
  /**
   * FEAT-184 — a user-only action that is not a grant (a ticket answer, a
   * delegation) names its own refusal: `agentError` replaces the grant-specific
   * text and `code` the 'agent-self-grant' code. Omitted means the FEAT-164 text.
   *
   * FEAT-196 — `allowPaired` lets a route also accept the user's paired REMOTE device
   * (phone over Tailscale); only the git-write grant opts in. Enrolment routes do NOT,
   * so a paired phone grants git but cannot mint further pairings.
   */
  opts?: { code?: string; agentError?: string; allowPaired?: boolean },
): { status: 403; body: Record<string, unknown> } | null {
  let v: CallerVerdict;
  try { v = classifyCaller(req); } catch (err) { v = { kind: 'unknown', pids: [], why: `caller check threw: ${(err as Error).message}` }; }
  if (v.kind === 'user') return null;
  if (opts?.allowPaired) {
    const pairingId = acceptPairedCaller(req);
    if (pairingId) {
      console.warn(`[orchard] ${what}: accepted a paired remote device (${pairingId}) over the Tailscale proxy (FEAT-196).`);
      return null;
    }
  }
  if (opts?.code || opts?.agentError) {
    console.warn(`[orchard] REFUSED ${what}: ${v.kind === 'agent' ? 'the caller is an agent session' : 'the caller could not be identified'} (${v.why}) — a user-only action (FEAT-184).`);
    return {
      status: 403,
      body: {
        error: v.kind === 'agent'
          ? `${what} refused: ${opts.agentError ?? 'this is a user-only action and the caller is an agent session.'}`
          : `${what} refused: Orchard could not identify the calling process, so it cannot tell the user from an agent (fails closed).`,
        code: v.kind === 'agent' ? (opts.code ?? 'agent-not-user') : 'caller-unknown',
      },
    };
  }
  const code = v.kind === 'agent' ? 'agent-self-grant' : 'caller-unknown';
  console.warn(`[orchard] REFUSED ${what}: ${v.kind === 'agent' ? 'the caller is an agent session' : 'the caller could not be identified'} (${v.why}) — only the user can grant agent git writes (FEAT-164 option A).`);
  return {
    status: 403,
    body: {
      error: v.kind === 'agent'
        ? `${what} refused: this is a user-only action and the caller is an agent session (an agent cannot grant itself git-write access or write git outside the shim). Ask the user (raise a git-write request; the user approves it on the Needs-You rail).`
        : `${what} refused: Orchard could not identify the calling process, so it cannot tell the user from an agent (fails closed).`,
      code,
    },
  };
}
