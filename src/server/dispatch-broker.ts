/** Host-side OpenAI dispatch broker. Credentials and Codex never cross into a project. */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

import { dataDir, ensureDir, projectRoot } from '../lib/paths.ts';
import type { Project } from './registry.ts';

export const CONTAINER_DISPATCH_DIR = '/opt/orchard-dispatch';
export const CONTAINER_DISPATCH_CLIENT = `${CONTAINER_DISPATCH_DIR}/dispatch-client.mjs`;
export const CONTAINER_DISPATCH_SOCKET_DIR = '/run/orchard-dispatch';
export const CONTAINER_DISPATCH_SOCKET = `${CONTAINER_DISPATCH_SOCKET_DIR}/dispatch.sock`;
export const DISPATCH_COMMAND = `node ${CONTAINER_DISPATCH_CLIENT}`;
export const PROJECT_CAP = 2;
export const GLOBAL_CAP = 6;
export const MAX_TIMEOUT_MIN = 60;

const PHASES = new Set(['finding', 'fixing', 'verifying']);
const CLASSES = new Set(['trivial', 'fix', 'explore', 'plan+review', 'arch', 'verify']);
const SANDBOXES = new Set(['read-only', 'workspace-write']);
const REQUEST_KEYS = new Set(['op', 'provider', 'model', 'prompt', 'sandbox', 'timeoutMin', 'ticket', 'phase', 'round', 'class']);
const daemons = new Map<string, { server: net.Server; socket: string }>();
const activeByProject = new Map<string, number>();
let activeGlobal = 0;

export class DispatchBrokerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'DispatchBrokerError'; this.code = code; }
}

function projectSegment(project: Project): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(project.id) || project.id.includes('..')) {
    throw new DispatchBrokerError('bad-project-id', `project id ${JSON.stringify(project.id)} is not safe`);
  }
  return project.id;
}

export function dispatchSocketPath(project: Project): string {
  return path.join(dispatchProjectDir(project), 'dispatch.sock');
}
export function dispatchStateHome(): string { return path.join(dataDir(), 'dispatch'); }
export function dispatchProjectDir(project: Project): string { return path.join(dispatchStateHome(), projectSegment(project)); }
export function dispatchClientPath(): string { return path.join(import.meta.dirname, 'dispatch-client.mjs'); }
export function dispatchBinds(project: Project) {
  return [
    /* connect(2) requires write permission on the socket INODE, supplied by its
     * 0600 mode and matching uid; it does not require changing the directory.
     * A :ro bind preserves those inode mode bits while preventing the container
     * from adding/unlinking entries. Binding the directory still exposes a
     * replacement socket inode after broker restart. */
    { hostPath: dispatchProjectDir(project), containerPath: CONTAINER_DISPATCH_SOCKET_DIR, readOnly: true, why: 'OpenAI dispatch socket directory' },
    { hostPath: dispatchClientPath(), containerPath: CONTAINER_DISPATCH_CLIENT, readOnly: true, why: 'OpenAI dispatch client' },
  ];
}
export function dispatchContainerEnv() { return { ORCHARD_DISPATCH_SOCK: CONTAINER_DISPATCH_SOCKET, ORCHARD_DISPATCH_CMD: DISPATCH_COMMAND }; }

type Terminal = { op: 'result'; ok: boolean; text: string; exitCode: number; failureKind: string | null; sessionId: string | null; meta: Record<string, unknown> };
function terminal(socket: net.Socket, frame: Terminal) {
  if (!socket.destroyed) socket.end(`${JSON.stringify(frame)}\n`);
}
function refusal(socket: net.Socket, kind: string, text: string, meta: Record<string, unknown> = {}) {
  terminal(socket, { op: 'result', ok: false, text, exitCode: 2, failureKind: kind, sessionId: null, meta });
}

function validate(raw: unknown): { ok: true; r: Record<string, unknown> } | { ok: false; kind: string; text: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, kind: 'invalid-request', text: 'request must be a JSON object' };
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!REQUEST_KEYS.has(k)) return { ok: false, kind: 'unknown-field', text: `request field ${JSON.stringify(k)} is not allowed` };
  if (r.op === 'capabilities') return Object.keys(r).length === 1 ? { ok: true, r } : { ok: false, kind: 'invalid-request', text: 'capabilities accepts no other fields' };
  if (r.op !== 'dispatch') return { ok: false, kind: 'invalid-operation', text: 'op must be capabilities or dispatch' };
  if (r.provider !== 'openai') return { ok: false, kind: 'invalid-provider', text: 'provider must be openai' };
  if (typeof r.prompt !== 'string' || !r.prompt.trim()) return { ok: false, kind: 'invalid-prompt', text: 'prompt must be a non-empty string' };
  if (r.model != null && (typeof r.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(r.model))) return { ok: false, kind: 'invalid-model', text: 'model contains forbidden characters' };
  if (r.sandbox != null && !SANDBOXES.has(String(r.sandbox))) return { ok: false, kind: 'invalid-sandbox', text: 'sandbox must be read-only or workspace-write' };
  if (r.timeoutMin != null && (typeof r.timeoutMin !== 'number' || !Number.isFinite(r.timeoutMin) || r.timeoutMin <= 0)) return { ok: false, kind: 'invalid-timeout', text: 'timeoutMin must be a positive number' };
  if (r.phase != null && (typeof r.phase !== 'string' || !PHASES.has(r.phase))) return { ok: false, kind: 'invalid-phase', text: 'phase is not allowed' };
  if (r.class != null && (typeof r.class !== 'string' || !CLASSES.has(r.class))) return { ok: false, kind: 'invalid-class', text: 'class is not allowed' };
  if (r.ticket != null && (typeof r.ticket !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._,-]{0,199}$/.test(r.ticket))) return { ok: false, kind: 'invalid-ticket', text: 'ticket contains forbidden characters' };
  if (r.round != null && (typeof r.round !== 'string' && typeof r.round !== 'number' || !/^[1-9][0-9]{0,5}$/.test(String(r.round)))) return { ok: false, kind: 'invalid-round', text: 'round must be a positive integer' };
  return { ok: true, r };
}

function runDispatch(project: Project, socket: net.Socket, r: Record<string, unknown>) {
  const own = activeByProject.get(project.id) ?? 0;
  if (own >= PROJECT_CAP) return refusal(socket, 'project-concurrency-cap', `dispatch refused: project concurrency cap ${PROJECT_CAP} reached`, { cap: PROJECT_CAP });
  if (activeGlobal >= GLOBAL_CAP) return refusal(socket, 'global-concurrency-cap', `dispatch refused: global concurrency cap ${GLOBAL_CAP} reached`, { cap: GLOBAL_CAP });
  activeByProject.set(project.id, own + 1); activeGlobal++;
  const timeoutMin = Math.min(Number(r.timeoutMin ?? 15), MAX_TIMEOUT_MIN);
  const scratch = path.join(dataDir(), 'dispatch', 'scratch'); ensureDir(scratch);
  const metaPath = path.join(scratch, `${project.id}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const script = process.env.ORCHARD_DISPATCH_SCRIPT || path.join(projectRoot(), 'scripts', 'dispatch.mjs');
  const args = [script, '--provider', 'openai', '--cwd', project.hostPath, '--sandbox', String(r.sandbox ?? 'read-only'), '--timeout-min', String(timeoutMin), '--meta-out', metaPath, '--prompt-stdin'];
  for (const [field, flag] of [['model', '--model'], ['ticket', '--ticket'], ['phase', '--phase'], ['round', '--round'], ['class', '--class']] as const) if (r[field] != null) args.push(flag, String(r[field]));
  let child: ChildProcess;
  let stderr = '';
  let stdout = '';
  let settled = false;
  const finish = (exitCode: number, kind: string | null, internalText = '') => {
    if (settled) return; settled = true; clearTimeout(killTimer);
    activeByProject.set(project.id, Math.max(0, (activeByProject.get(project.id) ?? 1) - 1)); activeGlobal = Math.max(0, activeGlobal - 1);
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { /* child may fail before metadata */ }
    try { fs.unlinkSync(metaPath); } catch { /* short-lived scratch */ }
    const failureKind = kind ?? (typeof meta.failureKind === 'string' ? meta.failureKind : exitCode === 0 ? null : 'child-exit');
    terminal(socket, { op: 'result', ok: exitCode === 0, text: internalText || stdout, exitCode, failureKind, sessionId: typeof meta.sessionId === 'string' ? meta.sessionId : null, meta: { ...meta, timeoutMin, cwdForced: project.hostPath, stderr: exitCode === 0 ? undefined : stderr.slice(-4000) } });
  };
  const timeoutGraceMs = Number(process.env.ORCHARD_DISPATCH_TIMEOUT_GRACE_MS ?? 10_000);
  const killTimer = setTimeout(() => { child?.kill('SIGTERM'); finish(1, 'broker-timeout', `dispatch timed out after ${timeoutMin} minute(s)`); }, timeoutMin * 60_000 + timeoutGraceMs);
  try {
    child = spawn(process.env.ORCHARD_DISPATCH_NODE || process.execPath, args, { cwd: project.hostPath, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });
  } catch (e) { return finish(1, 'spawn-failed', `could not spawn dispatch: ${(e as Error).message}`); }
  child.stdout!.on('data', (b) => { stdout += b.toString(); });
  child.stderr!.on('data', (b) => { const text = b.toString(); stderr += text; if (!socket.destroyed) socket.write(`${JSON.stringify({ op: 'progress', text })}\n`); });
  child.on('error', (e) => finish(1, 'spawn-failed', `could not spawn dispatch: ${e.message}`));
  child.on('close', (code) => finish(code ?? 1, null));
  child.stdin!.on('error', () => {}); child.stdin!.end(String(r.prompt));
}

function connection(project: Project, socket: net.Socket) {
  let input = ''; let handled = false;
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    if (handled) return;
    input += chunk;
    if (input.length > 8 * 1024 * 1024) { handled = true; return refusal(socket, 'request-too-large', 'request exceeds 8 MiB'); }
    const nl = input.indexOf('\n'); if (nl < 0) return;
    handled = true;
    if (input.slice(nl + 1).trim()) return refusal(socket, 'multiple-requests', 'one request per connection');
    let raw: unknown; try { raw = JSON.parse(input.slice(0, nl)); } catch { return refusal(socket, 'invalid-json', 'request is not valid JSON'); }
    const v = validate(raw); if (!v.ok) return refusal(socket, v.kind, v.text);
    if (v.r.op === 'capabilities') return socket.end(`${JSON.stringify({ ok: true, providers: ['openai'], models: { openai: ['default'] }, project: project.id, entitled: true, dispatchCmd: DISPATCH_COMMAND })}\n`);
    runDispatch(project, socket, v.r);
  });
  socket.on('end', () => { if (!handled) { handled = true; refusal(socket, 'partial-frame', 'connection ended before a complete NDJSON frame'); } });
  socket.on('error', () => {});
}

export async function start(project: Project): Promise<string> {
  const id = projectSegment(project); const existing = daemons.get(id); if (existing) return existing.socket;
  const dir = dispatchProjectDir(project); const sock = dispatchSocketPath(project); ensureDir(dir); fs.chmodSync(dir, 0o700);
  const unexpected = fs.readdirSync(dir).filter((entry) => entry !== 'dispatch.sock');
  if (unexpected.length) throw new DispatchBrokerError('unclean-project-dir', `dispatch directory contains unexpected entries: ${unexpected.join(', ')}`);
  try { fs.unlinkSync(sock); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const server = net.createServer((s) => connection(project, s));
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(sock, () => { server.off('error', reject); resolve(); }); });
  server.on('error', () => { /* accepted connections still receive their own terminal frames */ });
  fs.chmodSync(sock, 0o600); daemons.set(id, { server, socket: sock }); return sock;
}
export async function stop(project: Project): Promise<void> {
  const d = daemons.get(projectSegment(project)); if (!d) return;
  await new Promise<void>((resolve) => d.server.close(() => resolve())); daemons.delete(project.id);
  try { fs.unlinkSync(d.socket); } catch { /* already gone */ }
}
