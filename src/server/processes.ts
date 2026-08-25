/**
 * Per-project process visibility — "is something still running from this
 * directory?" Sessions spin up dev servers and forget them; attribution to a
 * SESSION is guesswork (processes detach and re-parent), but a process whose
 * cwd sits inside the project directory is checkable truth via /proc.
 *
 * Killing is by PID only, SIGTERM by default, and the pid's cwd is
 * RE-CHECKED at kill time — a stale row must never kill whatever recycled
 * the pid. This app's own server refuses to kill itself from its own UI.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ProjectProcess {
  pid: number;
  /** argv joined — truncated for the wire. */
  command: string;
  cwd: string;
  /** TCP ports this pid is listening on (loopback or otherwise). */
  ports: number[];
  startedAt: string | null;
  /** True when this is the Orchard server itself. */
  self: boolean;
}

export class ProcessError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function cwdOf(pid: string): string | null {
  try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return null; }
}

function commandOf(pid: string): string {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim().slice(0, 300);
  } catch { return ''; }
}

function startedAtOf(pid: string): string | null {
  try {
    return fs.statSync(`/proc/${pid}`).mtime.toISOString();
  } catch { return null; }
}

/** pid -> listening TCP ports, from one `ss -tlnp` pass. */
function listeningPorts(): Map<number, number[]> {
  const out = new Map<number, number[]>();
  let text = '';
  try {
    text = execFileSync('ss', ['-tlnp'], { encoding: 'utf8', timeout: 5_000 });
  } catch { return out; }
  for (const line of text.split('\n')) {
    const port = /[\]:](\d+)\s/.exec(line)?.[1];
    for (const m of line.matchAll(/pid=(\d+)/g)) {
      const pid = Number(m[1]);
      if (!port || !Number.isInteger(pid)) continue;
      const arr = out.get(pid) ?? [];
      if (!arr.includes(Number(port))) arr.push(Number(port));
      out.set(pid, arr);
    }
  }
  return out;
}

const inside = (parent: string, child: string): boolean => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

export function listProjectProcesses(hostPath: string): ProjectProcess[] {
  const ports = listeningPorts();
  const out: ProjectProcess[] = [];
  let pids: string[] = [];
  try { pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch { return out; }
  for (const pid of pids) {
    const cwd = cwdOf(pid); // unreadable = another user's process — not ours to show
    if (!cwd || !inside(hostPath, cwd)) continue;
    const command = commandOf(pid);
    if (!command) continue; // kernel thread or gone mid-scan
    out.push({
      pid: Number(pid),
      command,
      cwd,
      ports: (ports.get(Number(pid)) ?? []).sort((a, b) => a - b),
      startedAt: startedAtOf(pid),
      self: Number(pid) === process.pid,
    });
  }
  // Listening services first (they are what the user is hunting), then newest.
  out.sort((a, b) => (b.ports.length - a.ports.length) || String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')));
  return out;
}

export interface ProcessSummary {
  count: number;
  ports: number[];
  /** True when one of them is this dashboard's own server. */
  hasSelf: boolean;
}

/**
 * One /proc sweep answering "what runs where" for EVERY registered project —
 * feeds the ambient sidebar/crown indicators without N scans. A process
 * inside nested projects attributes to the LONGEST matching hostPath.
 */
export function summarize(projects: { id: string; hostPath: string }[]): Record<string, ProcessSummary> {
  const out: Record<string, ProcessSummary> = {};
  const ports = listeningPorts();
  const sorted = [...projects].sort((a, b) => b.hostPath.length - a.hostPath.length);
  let pids: string[] = [];
  try { pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch { return out; }
  for (const pid of pids) {
    const cwd = cwdOf(pid);
    if (!cwd) continue;
    const owner = sorted.find((p) => inside(p.hostPath, cwd));
    if (!owner) continue;
    if (!commandOf(pid)) continue; // gone mid-scan
    const s = (out[owner.id] ??= { count: 0, ports: [], hasSelf: false });
    s.count++;
    for (const port of ports.get(Number(pid)) ?? []) if (!s.ports.includes(port)) s.ports.push(port);
    if (Number(pid) === process.pid) s.hasSelf = true;
  }
  for (const s of Object.values(out)) s.ports.sort((a, b) => a - b);
  return out;
}

export function killProjectProcess(hostPath: string, pid: number, signal: 'TERM' | 'KILL' = 'TERM'): { killed: number; signal: string } {
  if (!Number.isInteger(pid) || pid <= 1) throw new ProcessError(400, `refusing pid ${pid}`);
  if (pid === process.pid) {
    throw new ProcessError(400, 'that is this dashboard\'s own server — stop it from a terminal, not from inside itself');
  }
  // Re-verify NOW: the pid must still be a process running inside this project.
  const cwd = cwdOf(String(pid));
  if (!cwd) throw new ProcessError(410, `process ${pid} is already gone`);
  if (!inside(hostPath, cwd)) {
    throw new ProcessError(409, `process ${pid} no longer runs inside this project (cwd is now ${cwd}) — refusing`);
  }
  try {
    process.kill(pid, signal === 'KILL' ? 'SIGKILL' : 'SIGTERM');
  } catch (err) {
    throw new ProcessError(500, `kill ${pid} failed: ${(err as Error).message}`);
  }
  return { killed: pid, signal };
}
