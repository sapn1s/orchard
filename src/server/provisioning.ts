/**
 * BUG-107 — provisioning: install third-party tooling ONCE, from a pin, and
 * never at session start.
 *
 * THE POLICY THIS ENCODES (the user's, verbatim): "we need serena ideally
 * downloaded only once, then reuse it … but auto-fetching files yes is too much
 * supply chain risk." So:
 *
 *   - the version lives in `container/provision.json`, not in a command string;
 *   - it is a REGISTRY package + exact version, never a mutable git ref, so what
 *     gets installed on two different days is the same bytes;
 *   - installation happens at PROVISION time into a durable location, and a
 *     session only ever EXECUTES the already-installed binary;
 *   - a version bump marks the install stale. It never installs itself. The
 *     update is a thing the user asks for.
 *
 * WHY THE MANIFEST IS HASHED. `provisionHash()` is consumed by
 * container-manager's `imageNameFor()`, which puts it in the image tag. Without
 * that, editing this manifest changed nothing observable — the built image kept
 * its old name, the drift check compared names, saw a match, and every container
 * went on running the old artifact. A pin is only real if changing it changes
 * the identity of the thing built from it.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { dataDir, ensureDir, projectRoot, writeAtomic } from '../lib/paths.ts';

/* --------------------------------------------------------------- manifest */

export type Installer = 'uv-tool' | 'npm-global';

export interface ToolPin {
  package: string;
  version: string;
  entrypoint: string;
  installer: Installer;
  index?: string;
  source?: string;
  publisher?: string;
  license?: string;
  sha256?: Record<string, string>;
  integrity?: string;
}

export interface ProvisionManifest {
  manifestVersion: number;
  tools: Record<string, ToolPin>;
}

/** The build context holds it: the Dockerfile COPYs it, so the image records its own pins. */
export function provisionManifestPath(): string {
  return path.join(projectRoot(), 'src', 'server', 'container', 'provision.json');
}

export function dockerfilePath(): string {
  return path.join(projectRoot(), 'src', 'server', 'container', 'Dockerfile');
}

export function readProvisionManifest(): ProvisionManifest {
  const raw = fs.readFileSync(provisionManifestPath(), 'utf8');
  const j = JSON.parse(raw) as ProvisionManifest;
  if (!j || typeof j !== 'object' || !j.tools) {
    throw new Error(`${provisionManifestPath()} is not a provisioning manifest (no "tools")`);
  }
  return j;
}

/** Every tool the manifest pins, in a stable order (used by provisioning + status). */
export function manifestTools(): { name: string; pin: ToolPin }[] {
  const tools = readProvisionManifest().tools;
  return Object.keys(tools).sort().map((name) => ({ name, pin: tools[name]! }));
}

export function pinFor(tool: string): ToolPin {
  const pin = readProvisionManifest().tools[tool];
  if (!pin?.package || !pin?.version) throw new Error(`${provisionManifestPath()}: tools.${tool} must pin a package and version`);
  return pin;
}

export function serenaPin(): ToolPin {
  return pinFor('serena');
}

export function playwrightPin(): ToolPin {
  return pinFor('playwright');
}

/* ------------------------------------------------------------------- hash */

/*
 * Hash the CONTENT, every call. An earlier version memoised on (mtime, size) as
 * a cheap proxy for "did the inputs change" — but that proxy is unsound, and the
 * failure is precisely the bug this whole module exists to prevent: a Dockerfile
 * edit that preserves both byte-count and mtime (e.g. a `git checkout` between
 * branches, or any same-length token swap with a restored timestamp) returns the
 * OLD hash, so the old image tag is reused and a genuinely changed definition
 * never rebuilds. An independent clean-room pass reproduced exactly that (same
 * size, restored mtime, identical hash for changed bytes). The only key that
 * cannot go stale is the content itself — and computing a content key already
 * requires reading the content, so a content-keyed cache saves nothing over just
 * hashing. Two small files per call is negligible even under a polling UI; the
 * unsound cache is gone rather than made "less wrong".
 */

/** Short content hash of everything that defines the built artifact. */
export function provisionHash(): string {
  const files = [dockerfilePath(), provisionManifestPath()];
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(path.basename(f));
    h.update('\0');
    h.update(fs.readFileSync(f));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 12);
}

/* -------------------------------------------------------- host provision */

/**
 * Where a HOST (isolation: "direct") install lives. Under the station's data
 * dir on purpose: it is station-managed state, it survives a repo move, and it
 * is not on the user's PATH — so nothing outside a planned session can pick it
 * up by accident.
 */
export function hostProvisionDir(): string {
  return path.join(dataDir(), 'provision');
}

export function hostBinDir(): string {
  return path.join(hostProvisionDir(), 'bin');
}

/** Absolute path of a provisioned tool's entrypoint on the host. */
export function hostBinFor(tool: string): string {
  return path.join(hostBinDir(), pinFor(tool).entrypoint);
}

export function hostSerenaBin(): string {
  return hostBinFor('serena');
}

export function hostPlaywrightBin(): string {
  return hostBinFor('playwright');
}

/**
 * FEAT-133 — the single owner of the fact "is the host Playwright MCP binary
 * actually present?" (ARCH-010). Read by two callers that must not re-derive it:
 * the creation-time tool preflight (registry.ts `resolveNewProjectToolSettings`,
 * which will not default Playwright ON when it would launch a dead server) and
 * the attach gate (tools.ts `playwrightUnavailableReason`, which keeps a session
 * whose binary is missing from being handed a Playwright server that cannot
 * start). Host-only: a `container` session runs the baked image binary, which
 * this host cannot stat, so callers treat the container case separately.
 */
export function hostPlaywrightBinExists(): boolean {
  try {
    return fs.existsSync(hostPlaywrightBin());
  } catch {
    return false;
  }
}

function installedRecordFile(): string {
  return path.join(hostProvisionDir(), 'installed.json');
}

export type ProvisionState = 'provisioned' | 'stale' | 'missing';

export interface HostProvisionStatus {
  tool: string;
  state: ProvisionState;
  /** Version the manifest pins right now. */
  wantedVersion: string;
  /** Version actually installed, or null when nothing is installed. */
  installedVersion: string | null;
  installedAt: string | null;
  package: string;
  bin: string;
  /**
   * When the state was checked against the ARTIFACT (verify: true), the version
   * the on-disk binary actually reported. null when only the record was read
   * (the cheap default) — a remembered claim, not a verified fact.
   */
  verifiedVersion: string | null;
  /** Plain-words reason, safe to render. */
  detail: string;
}

interface InstalledRecord {
  tools?: Record<string, { package: string; version: string; installedAt: string; bin: string; verifiedVersion?: string }>;
}

/**
 * Ask the installed entrypoint what it ACTUALLY is, by running `--version`.
 *
 * WHY THIS EXISTS. `installed.json` is a remembered CLAIM written at provision
 * time; the reason for provisioning is that "what is recorded IS what runs", and
 * a record nobody re-checks against the artifact can drift from it. The realistic
 * driver is not an attacker — for a single-user local tool, local filesystem
 * tampering is a low-likelihood case — but DRIFT: a partial or interrupted
 * install, a dependency upgraded underneath the tree, a `npm -g`/`uv tool`
 * mutation elsewhere, or a package swapped by hand. This asks the binary itself
 * instead of trusting the note we left ourselves.
 *
 * COST & PLACEMENT. It spawns the entrypoint (~0.2s node, ~0.6s python), so it
 * is deliberately NOT on the hot status-poll path: `hostProvisionStateFor` is
 * record+existence by default. Verification runs where it is both affordable and
 * decisive — (a) after every install, before a record is written, so a record is
 * never born a lie; (b) at the provision idempotence gate, so re-provisioning a
 * drifted install actually re-installs instead of trusting the stale record; and
 * (c) on demand via `{ verify: true }`, which the `provision-tools.mjs` status
 * command (and a panel refresh) call. It is synchronous on purpose: the record's
 * read-modify-write stays a single un-awaited block, so concurrent provisions of
 * two tools cannot clobber each other's entry.
 */
export interface VersionProbe { ran: boolean; reported: string | null; raw: string; }
export function probeInstalledVersion(bin: string): VersionProbe {
  if (!fs.existsSync(bin)) return { ran: false, reported: null, raw: '' };
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 60_000 });
  const raw = (String(r.stdout ?? '') + String(r.stderr ?? '')).trim();
  if (r.error || r.status !== 0) return { ran: false, reported: null, raw };
  const m = raw.match(/(\d+\.\d+\.\d+[-.\w]*)/);
  return { ran: true, reported: m ? m[1] : null, raw };
}

/** True when the on-disk binary genuinely reports the pinned version. */
function probeMatchesPin(probe: VersionProbe, wanted: string): boolean {
  return probe.ran && (probe.reported === wanted || probe.raw.includes(wanted));
}

function readInstalled(): InstalledRecord {
  try { return JSON.parse(fs.readFileSync(installedRecordFile(), 'utf8')) as InstalledRecord; }
  catch { return {}; }
}

/**
 * What is installed on the host vs what the manifest pins. This is the state a
 * pre-flight panel renders, and the reason a session never has to ask the
 * network anything.
 */
export function hostProvisionStateFor(tool: string, opts: { verify?: boolean } = {}): HostProvisionStatus {
  const pin = pinFor(tool);
  const bin = hostBinFor(tool);
  const rec = readInstalled().tools?.[tool] ?? null;
  const base = { tool, wantedVersion: pin.version, package: pin.package, bin };
  if (!rec || !fs.existsSync(bin)) {
    return { ...base, state: 'missing', installedVersion: null, installedAt: null, verifiedVersion: null,
      detail: `${pin.package} is not installed for host (direct-isolation) sessions. Provision it once; sessions never fetch it themselves.` };
  }
  if (rec.version !== pin.version) {
    return { ...base, state: 'stale', installedVersion: rec.version, installedAt: rec.installedAt ?? null, verifiedVersion: null,
      detail: `${pin.package} ${rec.version} is installed but the manifest now pins ${pin.version}. Updating is deliberate — nothing will fetch it for you.` };
  }
  // The record CLAIMS the pinned version is installed. Cheap default: trust it
  // (record + existence). When asked to verify, ask the artifact itself — a
  // record is only a remembered claim, and it can drift from what actually runs.
  if (opts.verify) {
    const probe = probeInstalledVersion(bin);
    if (!probe.ran) {
      return { ...base, state: 'missing', installedVersion: null, installedAt: rec.installedAt ?? null, verifiedVersion: null,
        detail: `${pin.package} is recorded as installed at ${bin}, but the binary there does not run or report a version — a partial, interrupted, or corrupted install. Re-provision it.` };
    }
    if (!probeMatchesPin(probe, pin.version)) {
      const actual = probe.reported ?? probe.raw.slice(0, 80);
      return { ...base, state: 'stale', installedVersion: actual, installedAt: rec.installedAt ?? null, verifiedVersion: actual,
        detail: `${pin.package} on disk reports ${actual}, but the manifest pins ${pin.version} and the record claims it — the install drifted from the pin (an upgraded dependency, a manual change, or a swapped binary). Re-provision to restore the pinned version.` };
    }
    return { ...base, state: 'provisioned', installedVersion: rec.version, installedAt: rec.installedAt ?? null, verifiedVersion: probe.reported ?? pin.version,
      detail: `${pin.package} ${rec.version} installed at ${bin} (verified: the binary reports ${probe.reported ?? pin.version}).` };
  }
  return { ...base, state: 'provisioned', installedVersion: rec.version, installedAt: rec.installedAt ?? null, verifiedVersion: null,
    detail: `${pin.package} ${rec.version} installed at ${bin}.` };
}

/** Back-compat: the serena view (BUG-107's original single-tool export). */
export function hostProvisionState(opts: { verify?: boolean } = {}): HostProvisionStatus {
  return hostProvisionStateFor('serena', opts);
}

/** Every pinned tool's host state — what a pre-flight MCP panel renders. */
export function hostProvisionStates(opts: { verify?: boolean } = {}): HostProvisionStatus[] {
  return manifestTools().map(({ name }) => hostProvisionStateFor(name, opts));
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number, onLog?: (s: string) => void): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${cmd} ${args[0]} timed out after ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
    const take = (d: unknown) => { out += String(d); onLog?.(String(d)); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, out }); });
  });
}

export interface ProvisionResult {
  changed: boolean;
  reason: string;
  status: HostProvisionStatus;
}

/**
 * Install (or update to) the pinned version on the host. THE ONLY PLACE THAT
 * REACHES THE NETWORK, and it is never called from a session path — a caller is
 * a user action (the CLI below, or the MCP panel's Provision/Update button).
 *
 * Idempotent by state, not by luck: already at the pinned version → returns
 * without spawning anything, which is what makes "downloaded once, then reused"
 * observable rather than hoped for.
 */
export async function provisionToolOnHost(tool: string, opts: { force?: boolean; onLog?: (s: string) => void } = {}): Promise<ProvisionResult> {
  const pin = pinFor(tool);
  // Verify against the ARTIFACT, not the record: a drifted install (swapped
  // binary, upgraded dependency, partial install) must NOT short-circuit as
  // "already installed" — that is exactly the no-op that let a tampered/drifted
  // binary persist. Verifying here re-installs it instead.
  const before = hostProvisionStateFor(tool, { verify: true });
  if (!opts.force && before.state === 'provisioned') {
    return { changed: false, reason: `${pin.package} ${pin.version} is already installed`, status: before };
  }
  ensureDir(hostBinDir());
  const bin = hostBinFor(tool);

  if (pin.installer === 'uv-tool') {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      UV_TOOL_DIR: path.join(hostProvisionDir(), 'uv-tools'),
      UV_TOOL_BIN_DIR: hostBinDir(),
    };
    const spec = `${pin.package}==${pin.version}`;
    opts.onLog?.(`[provision] uv tool install ${spec}\n`);
    let r: { code: number; out: string };
    try {
      r = await run('uv', ['tool', 'install', '--force', spec], env, 10 * 60_000, opts.onLog);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        throw new Error('`uv` is not on PATH. Install uv (https://astral.sh/uv) and provision again — Claude Station will not silently fetch an installer for you.');
      }
      throw err;
    }
    if (r.code !== 0) throw new Error(`uv tool install ${spec} failed (exit ${r.code})\n${r.out.trim().slice(-2000)}`);
  } else if (pin.installer === 'npm-global') {
    // A global npm install into the STATION's prefix (not the user's global
    // prefix): `--prefix <dir>` puts the entrypoint at <dir>/bin/<entrypoint>
    // and the package tree at <dir>/lib/node_modules, exactly parallel to the
    // uv `bin/` layout. Pinned exact version, no `@latest`, no `-y`.
    const spec = `${pin.package}@${pin.version}`;
    opts.onLog?.(`[provision] npm install -g --prefix ${hostProvisionDir()} ${spec}\n`);
    let r: { code: number; out: string };
    try {
      r = await run('npm', ['install', '-g', '--prefix', hostProvisionDir(), spec], { ...process.env }, 10 * 60_000, opts.onLog);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        throw new Error('`npm` is not on PATH. Install Node.js/npm and provision again — Claude Station will not silently fetch an installer for you.');
      }
      throw err;
    }
    if (r.code !== 0) throw new Error(`npm install ${spec} failed (exit ${r.code})\n${r.out.trim().slice(-2000)}`);
  } else {
    throw new Error(`unknown installer "${String((pin as ToolPin).installer)}" for tool ${tool}`);
  }

  if (!fs.existsSync(bin)) {
    // Distrust the exit code: assert the artifact, same rule as the image build.
    throw new Error(`${pin.installer} reported success but ${bin} does not exist`);
  }
  // Distrust it further: assert the artifact's IDENTITY before recording it, so
  // the record is never born a lie (a partial install can leave a binary that
  // does not run, or one that reports a different version). Synchronous, so the
  // read-modify-write of the record below stays one un-awaited block.
  const probe = probeInstalledVersion(bin);
  if (!probe.ran) {
    throw new Error(`${pin.package} installed to ${bin} but it does not run / report a version — a partial or corrupted install`);
  }
  if (!probeMatchesPin(probe, pin.version)) {
    throw new Error(`${pin.package} installed to ${bin} reports ${probe.reported ?? probe.raw.slice(0, 80)}, not the pinned ${pin.version}`);
  }
  const rec = readInstalled();
  rec.tools = { ...(rec.tools ?? {}), [tool]: { package: pin.package, version: pin.version, installedAt: new Date().toISOString(), bin, verifiedVersion: probe.reported ?? pin.version } };
  writeAtomic(installedRecordFile(), JSON.stringify(rec, null, 2) + '\n');
  return { changed: true, reason: `installed ${pin.package}@${pin.version}`, status: hostProvisionStateFor(tool, { verify: true }) };
}

/**
 * BACK-COMPAT single-tool entry (serena). BUG-107 shipped this signature and its
 * suites assert on it (idempotent second call, serena-shaped status); it stays
 * serena-only and unchanged so those anti-regressions keep passing verbatim.
 */
export async function provisionHost(opts: { force?: boolean; onLog?: (s: string) => void } = {}): Promise<ProvisionResult> {
  return provisionToolOnHost('serena', opts);
}

/** Provision EVERY pinned tool on the host — the "Provision all" the CLI/panel runs. */
export async function provisionAllHost(opts: { force?: boolean; onLog?: (s: string) => void } = {}): Promise<ProvisionResult[]> {
  const out: ProvisionResult[] = [];
  for (const { name } of manifestTools()) {
    out.push(await provisionToolOnHost(name, opts));
  }
  return out;
}
