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
 * Fail closed: a loopback caller whose process cannot be found is refused. A non-loopback
 * caller (the server bound to a LAN address, a human on another machine) is not a local
 * agent process and is treated as the user.
 *
 * RESIDUALS (named on the decision card; same class as ARCH-021's host residual): a
 * same-uid agent that deliberately escapes its scope (`systemd-run --user --scope …`) or
 * relays through a process outside it classifies as the user. A terminal the SERVER spawned
 * (git panel "open terminal") is a server descendant, so a grant typed there is refused
 * (fails closed; grant from the dashboard instead).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { hostsDir } from './survival.ts';

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

/** Classify one local process. The server process itself (an in-process caller) is not an agent. */
function classifyPid(pid: number): { agent: boolean; why: string } {
  if (pid === process.pid) return { agent: false, why: 'the server process itself' };
  const key = inOwnSessionScope(pid);
  if (key) return { agent: true, why: `pid ${pid} runs in this server's session scope claude-station-host-${key}` };
  // A server run as a systemd SERVICE keeps everything it launched in its own cgroup, even
  // a process that backgrounded itself (setsid/nohup reparents to init). Nothing of the
  // user's (browser, terminal) lives in that service cgroup.
  const own = cgroupOf(process.pid);
  if (own && /\.service$/.test(own) && cgroupOf(pid) === own) {
    return { agent: true, why: `pid ${pid} shares the server's service cgroup ${own}` };
  }
  let p: number | null = parentOf(pid);
  for (let hops = 0; p && p > 1 && hops < 256; hops++) {
    if (p === process.pid) return { agent: true, why: `pid ${pid} descends from the server process (a session or command the server launched)` };
    p = parentOf(p);
  }
  return { agent: false, why: `pid ${pid} is outside this server's sessions` };
}

export function classifyCaller(req: IncomingMessage): CallerVerdict {
  const sock = req.socket;
  const remote = String(sock.remoteAddress ?? '');
  const local = String(sock.localAddress ?? '');
  const isLocal = LOOPBACK.test(remote) || (remote !== '' && remote === local);
  if (!isLocal) return { kind: 'user', pids: [], why: `remote caller ${remote}` };
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
   */
  opts?: { code?: string; agentError?: string },
): { status: 403; body: Record<string, unknown> } | null {
  let v: CallerVerdict;
  try { v = classifyCaller(req); } catch (err) { v = { kind: 'unknown', pids: [], why: `caller check threw: ${(err as Error).message}` }; }
  if (v.kind === 'user') return null;
  if (opts) {
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
