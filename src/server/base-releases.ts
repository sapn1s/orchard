/**
 * FEAT-157 — Orchard's numbered base releases, a project's pin, and the ONE
 * policy that turns the two into what a launch builds and what the user is told.
 *
 * WHO OWNS WHAT (ARCH-010):
 *   - the releases (version, class, changelog, `adjust`, recipe hash, security
 *     package checks) are declared once, in `container/base-releases.json`, with
 *     each release's recipe snapshotted in `container/releases/v{N}/`;
 *   - a project's DESIRED base is declared once, in its registry settings
 *     (`settings.container.base`), and written only by the base-update routes,
 *     project creation and the one-time migration — never by the settings PATCH;
 *   - what a container actually RUNS (the observed artifact) is reported by the
 *     container runtime (image labels), read by container-manager.ts;
 *   - the security floor and the target a launch builds are computed HERE and
 *     nowhere else (`baseTarget`), so the settings, answer and launch paths
 *     cannot disagree about whether a security release is due.
 *
 * Everything in this file is PURE over its inputs (the catalog read is the only
 * I/O), so every rule below is testable without docker.
 *
 * A NOTICE IS DERIVED, NEVER STORED. `noticeFor` computes it on read from (the
 * catalog, the pin, the observed artifact, now). There is no store to tear, no
 * create route to forge through, no stale copy to linger, and an expired
 * deferral reopens by itself.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { projectRoot } from '../lib/paths.ts';

/* ----------------------------------------------------------------- catalog */

export type ReleaseClass = 'security' | 'fix' | 'feature';
export interface VerifyPkg { package: string; minVersion: string }
export interface BaseRelease {
  version: number;
  date: string;
  class: ReleaseClass;
  summary: string;
  adjust: string;
  /** recipeHash() of `releases/v{version}/` (provisioning.ts). */
  hash: string;
  /** Security releases only: packages the build must prove reached a minimum version. */
  verify?: VerifyPkg[];
}
export type Catalog =
  | { ok: true; releases: BaseRelease[]; newest: BaseRelease }
  | { ok: false; error: string };

export const RELEASE_CLASSES: readonly ReleaseClass[] = ['security', 'fix', 'feature'];
const PKG_RE = /^[a-z0-9][a-z0-9+.-]{0,127}$/;
const DEB_VERSION_RE = /^[A-Za-z0-9.+:~-]{1,128}$/;

/** `src/server/container` — the working-tree base recipe and the release catalog live here. */
export function containerDir(): string {
  return path.join(projectRoot(), 'src', 'server', 'container');
}
export function catalogPath(): string {
  return path.join(containerDir(), 'base-releases.json');
}
/** The frozen recipe of release `v`. */
export function releaseDir(v: number): string {
  return path.join(containerDir(), 'releases', `v${v}`);
}

/**
 * Parse and validate the catalog. STRICT: any problem is an error, never "fewer
 * releases" — a truncated file must not read as "no newer release" (which would
 * hide a security release) nor as a shorter list (which would re-point pins).
 */
export function parseCatalog(raw: string): Catalog {
  let j: unknown;
  try { j = JSON.parse(raw); } catch (e) { return { ok: false, error: `base-releases.json is not valid JSON (${(e as Error).message})` }; }
  const o = j as { schema?: unknown; releases?: unknown };
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { ok: false, error: 'base-releases.json is not an object' };
  if (o.schema !== 1) return { ok: false, error: `base-releases.json has schema ${JSON.stringify(o.schema)}; this Orchard reads schema 1` };
  if (!Array.isArray(o.releases) || o.releases.length === 0) return { ok: false, error: 'base-releases.json lists no releases' };
  const out: BaseRelease[] = [];
  for (const [i, r0] of (o.releases as unknown[]).entries()) {
    const r = r0 as Record<string, unknown>;
    const where = `base-releases.json releases[${i}]`;
    if (!r || typeof r !== 'object') return { ok: false, error: `${where} is not an object` };
    if (r.version !== i + 1) return { ok: false, error: `${where}.version is ${JSON.stringify(r.version)}; versions must run 1, 2, 3… with no gaps` };
    if (typeof r.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || Number.isNaN(Date.parse(r.date))) return { ok: false, error: `${where}.date must be YYYY-MM-DD` };
    if (!RELEASE_CLASSES.includes(r.class as ReleaseClass)) return { ok: false, error: `${where}.class must be one of ${RELEASE_CLASSES.join(', ')}` };
    if (typeof r.summary !== 'string' || !r.summary.trim()) return { ok: false, error: `${where}.summary is required` };
    if (typeof r.adjust !== 'string') return { ok: false, error: `${where}.adjust must be a string` };
    if (typeof r.hash !== 'string' || !/^[0-9a-f]{12}$/.test(r.hash)) return { ok: false, error: `${where}.hash must be a 12-hex recipe hash` };
    let verify: VerifyPkg[] | undefined;
    if (r.verify !== undefined) {
      if (!Array.isArray(r.verify)) return { ok: false, error: `${where}.verify must be an array` };
      verify = [];
      for (const v of r.verify as Record<string, unknown>[]) {
        if (!v || typeof v.package !== 'string' || !PKG_RE.test(v.package) || typeof v.minVersion !== 'string' || !DEB_VERSION_RE.test(v.minVersion)) {
          return { ok: false, error: `${where}.verify entries must be { package, minVersion } (a Debian package name and version)` };
        }
        verify.push({ package: v.package, minVersion: v.minVersion });
      }
    }
    if (r.class === 'security' && !(verify && verify.length)) return { ok: false, error: `${where} is a security release with no verify list; it must name the packages it moves` };
    out.push({ version: i + 1, date: r.date, class: r.class as ReleaseClass, summary: r.summary.trim(), adjust: r.adjust.trim(), hash: r.hash, ...(verify ? { verify } : {}) });
  }
  return { ok: true, releases: out, newest: out[out.length - 1]! };
}

/** Read the catalog from disk. A missing or unreadable file is an error, never "no releases". */
export function readCatalog(): Catalog {
  let raw: string;
  try { raw = fs.readFileSync(catalogPath(), 'utf8'); } catch (e) {
    return { ok: false, error: `cannot read ${catalogPath()}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}` };
  }
  return parseCatalog(raw);
}

export function releaseOf(cat: Catalog, v: number): BaseRelease | null {
  return cat.ok ? cat.releases.find((r) => r.version === v) ?? null : null;
}

/* --------------------------------------------------------------------- pin */

/** A legacy base tag — built before releases existed (BUG-107 hashed, or the older unhashed shape). */
export const LEGACY_TAG_RE = /^u\d+-g\d+(-[0-9a-f]{12})?$/;

export type PinValue = number | 'dev' | string; // `legacy:<tag>`
export interface BasePin {
  pinned: PinValue;
  /** A release pin also records the recipe hash it pinned (attack round 2, a): a release re-cut under the same
   *  number, or a checkout that froze another recipe as that number, is then "not what was pinned" (recovery). */
  hash?: string;
  /** ARCH-022 (d-i): the IMMUTABLE image id the pinned base resolved to (recorded by the authority at the first
   *  launch that resolves it, and for a legacy pin at migration). A tag that moves later changes nothing. */
  imageId?: string;
  skipped: number[];
  deferred: { version: number; until: string } | null;
}
const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/;
export type ParsedPin =
  | { kind: 'version'; version: number; hash?: string; imageId?: string }
  | { kind: 'dev' }
  | { kind: 'legacy'; tag: string; imageId?: string }
  | { kind: 'missing' }
  | { kind: 'invalid'; why: string };

/** The stored pin object, or null when it is absent or not an object. Shape only; `parsePin` judges the value. */
export function basePinRecord(raw: unknown): BasePin | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const skipped = Array.isArray(r.skipped) ? (r.skipped as unknown[]).filter((n): n is number => Number.isInteger(n) && (n as number) > 0) : [];
  const d = r.deferred as Record<string, unknown> | null | undefined;
  const deferred = d && Number.isInteger(d.version) && typeof d.until === 'string' && !Number.isNaN(Date.parse(d.until))
    ? { version: d.version as number, until: d.until }
    : null;
  return { pinned: r.pinned as PinValue, skipped, deferred, ...(typeof r.hash === 'string' && /^[0-9a-f]{12}$/.test(r.hash) ? { hash: r.hash } : {}), ...(typeof r.imageId === 'string' && IMAGE_ID_RE.test(r.imageId) ? { imageId: r.imageId } : {}) };
}

export function parsePin(raw: unknown): ParsedPin {
  const rec = basePinRecord(raw);
  if (!rec) return raw === undefined || raw === null ? { kind: 'missing' } : { kind: 'invalid', why: 'container.base is not an object' };
  const p = rec.pinned;
  if (p === 'dev') return { kind: 'dev' };
  const iid = rec.imageId ? { imageId: rec.imageId } : {};
  if (typeof p === 'number') return Number.isInteger(p) && p > 0 ? { kind: 'version', version: p, ...(rec.hash ? { hash: rec.hash } : {}), ...iid } : { kind: 'invalid', why: `pinned ${p} is not a release number` };
  if (typeof p === 'string' && p.startsWith('legacy:')) {
    const tag = p.slice('legacy:'.length);
    return LEGACY_TAG_RE.test(tag) ? { kind: 'legacy', tag, ...iid } : { kind: 'invalid', why: `legacy pin ${JSON.stringify(p)} does not name a legacy base tag` };
  }
  if (p === undefined || p === null) return { kind: 'missing' };
  return { kind: 'invalid', why: `pinned ${JSON.stringify(p)} is not a version, "dev" or "legacy:<tag>"` };
}

export function pinLabel(p: ParsedPin): string {
  switch (p.kind) {
    case 'version': return `v${p.version}`;
    case 'dev': return 'dev (working tree)';
    case 'legacy': return `legacy base ${p.tag}`;
    case 'missing': return 'no pin';
    default: return 'an unreadable pin';
  }
}

/* ------------------------------------------------------------------ policy */

/**
 * The newest SECURITY release above `from` (0 = below every release, i.e. a
 * legacy base), or null. A release range that contains a security fix counts as
 * security even when it skips intermediate versions, and the floor is the NEWEST
 * such release: a project must reach it, because every older security release
 * is missing that one's fix.
 */
export function securityFloor(cat: Catalog, from: number): number | null {
  if (!cat.ok) return null;
  let floor: number | null = null;
  for (const r of cat.releases) if (r.version > from && r.class === 'security') floor = r.version;
  return floor;
}

export type Target =
  | { kind: 'version'; version: number; raisedBySecurity: boolean; pinned: number | null; hash: string; floor?: number | null; imageId?: string }
  | { kind: 'dev' }
  | { kind: 'legacy'; tag: string; imageId?: string }
  | { kind: 'recovery'; why: string };

/**
 * THE one policy function: what base a launch of this project must build and
 * run. Every settings, answer and launch path reads this (finding 6).
 *   - a version pin: the pin, raised to the security floor when one is due;
 *   - a legacy pin: the legacy tag, unless a security release exists (then the
 *     floor — a legacy base predates every release);
 *   - dev: the working tree (Orchard's own dogfooding; no floor, stated);
 *   - missing / unreadable pin: recovery (never adoption, finding 9);
 *   - an unreadable catalog: keep the pin, never float (proof 7).
 */
export function baseTarget(pin: ParsedPin, cat: Catalog, observed: ObservedBase | null = null): Target {
  /*
   * ONE rule set (attack rounds 1-3 kept breaking enumerated special cases, so this reads the desired pin and the
   * observed artifact together):
   *  - dev tracks the tree; without a readable catalog nothing is provable -> recovery (keep the container);
   *  - the desired pin is used when this catalog proves it (a release it lists WITH the recipe the pin recorded, or
   *    a legacy tag) and it is at or above the newest security release (the floor);
   *  - otherwise the floor is due, EXCEPT it never moves a container DOWN or sideways into the unknown: a container
   *    running a release this catalog cannot place (a newer checkout's, or another recipe) is kept (recovery), and a
   *    lost/unresolvable pin whose container already runs a release at or above the floor is kept (recovery).
   */
  if (pin.kind === 'dev') return { kind: 'dev' };
  if (!cat.ok) return { kind: 'recovery', why: `the base release list cannot be read (${cat.error}); the current container is kept as it is` };
  const floor = securityFloor(cat, 0);
  const obsRel = observed?.kind === 'version' ? releaseOf(cat, observed.version) : null;
  const obsKnown = !!obsRel && observed?.kind === 'version' && (!observed.hash || observed.hash === obsRel.hash);
  const obsForeign = observed?.kind === 'version' && !obsKnown;
  let desired: Target | null = null;
  let why = '';
  if (pin.kind === 'version') {
    const rel = releaseOf(cat, pin.version);
    if (!rel) why = `pinned v${pin.version} is not in the release catalog (newest is v${cat.newest.version})`;
    else if (pin.hash && rel.hash !== pin.hash) why = `release v${pin.version} in this catalog is recipe ${rel.hash}, not the ${pin.hash} this project pinned (re-cut, or another checkout)`;
    else desired = { kind: 'version', version: pin.version, raisedBySecurity: false, pinned: pin.version, hash: rel.hash, floor, ...(pin.imageId ? { imageId: pin.imageId } : {}) };
  } else if (pin.kind === 'legacy') desired = { kind: 'legacy', tag: pin.tag, ...(pin.imageId ? { imageId: pin.imageId } : {}) };
  else why = pin.kind === 'missing' ? 'this container project has no base pin' : pin.why;
  const level = desired ? (desired.kind === 'version' ? desired.version : 0) : null;
  if (desired && (floor === null || (level ?? 0) >= floor)) return desired;
  if (floor === null) return { kind: 'recovery', why };
  if (obsForeign) return { kind: 'recovery', why: `this container runs v${(observed as { version: number }).version}, which this release list cannot place; it is kept as it is${why ? ` (${why})` : ''}` };
  if (!desired && obsKnown && (observed as { version: number }).version >= floor) return { kind: 'recovery', why };
  return { kind: 'version', version: floor, raisedBySecurity: true, pinned: desired?.kind === 'version' ? desired.version : null, hash: releaseOf(cat, floor)!.hash, floor };
}

/** The version a pin/target sits at for range arithmetic (legacy = 0: below every release). */
function levelOf(t: Target): number | null {
  if (t.kind === 'version') return t.version;
  if (t.kind === 'legacy') return 0;
  return null;
}

/* ------------------------------------------------------------------ notice */

/** What the container runtime reports the project's container runs (read from image labels). */
export type ObservedBase = (
  | { kind: 'version'; version: number; hash?: string }
  | { kind: 'dev'; hash: string }
  | { kind: 'legacy'; tag: string }
  | { kind: 'unknown' }
) & {
  /** Where it was read: the container's own image REF (Orchard wrote it) or image LABELS (a claim to be proven). */
  via?: 'tag' | 'label';
};

export type NoticeState =
  | 'offer'              // newer release(s); nothing chosen yet
  | 'adopted-pending'    // desired moved; applies at the next launch with no live session
  | 'security-pending'   // a security release is due; applied automatically at the next idle launch
  | 'apply-failed'       // the target's build/apply failed (security: new launches are refused)
  | 'recovery'           // no/unreadable pin: nothing moves until someone chooses
  | 'catalog-error'      // the catalog cannot be read: the current pin is kept
  | 'informational';     // prebuilt image: Orchard cannot apply releases

export type NoticeAction = 'adopt' | 'defer' | 'skip' | 'dismiss';

export interface BaseNotice {
  id: string;
  projectId: string;
  /** Changes whenever anything the user is consenting to changes (finding 8). */
  rev: string;
  state: NoticeState;
  /** The desired pin, as a label. */
  pinned: string;
  /** What the container runs now, as a label (null: no container). */
  observed: string | null;
  /** The release the offer/apply is about (null for recovery / catalog error). */
  to: number | null;
  /** Release versions between the effective base and `to`, by reference (the card reads the catalog). */
  versions: number[];
  security: boolean;
  /** ISO time the security apply has been due since (the release date), when security. */
  securityDueSince: string | null;
  /** True when a security release has been due 7+ days without being applied. */
  escalated: boolean;
  actions: NoticeAction[];
  /** One plain sentence: what happens next and when. */
  message: string;
  error: string | null;
}

export const DEFER_DAYS = 7;
export const ESCALATE_DAYS = 7;
const DAY_MS = 86_400_000;

export interface NoticeInput {
  projectId: string;
  imageSource: 'station' | 'dockerfile' | 'custom';
  pinRaw: unknown;
  observed: ObservedBase | null;
  /** The last apply/build failure for the current target (container-manager), if any. */
  lastError: string | null;
  now: Date;
  catalog: Catalog;
}

function observedLabel(o: ObservedBase | null): string | null {
  if (!o) return null;
  if (o.kind === 'version') return `v${o.version}`;
  if (o.kind === 'dev') return `dev (${o.hash})`;
  if (o.kind === 'legacy') return `legacy base ${o.tag}`;
  return 'an unlabelled image';
}

function observedMatches(o: ObservedBase | null, t: Target): boolean {
  if (!o) return false;
  // A release is its version AND its recipe: the same number built from another recipe is not it.
  if (t.kind === 'version') return o.kind === 'version' && o.version === t.version && (!o.hash || o.hash === t.hash);
  if (t.kind === 'legacy') return o.kind === 'legacy' && o.tag === t.tag;
  if (t.kind === 'dev') return o.kind === 'dev';
  return false;
}

function revOf(parts: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 12);
}

/**
 * The notice a project's rail and sessions should show right now, or null.
 * Derived on every read; see the file header.
 */
export function noticeFor(inp: NoticeInput): BaseNotice | null {
  const { projectId, catalog: cat, now } = inp;
  const id = `base:${projectId}`;
  const pinRec = basePinRecord(inp.pinRaw);
  const pin = parsePin(inp.pinRaw);
  const obsLabel = observedLabel(inp.observed);
  const mk = (n: Omit<BaseNotice, 'id' | 'projectId' | 'rev' | 'pinned' | 'observed'>): BaseNotice => {
    const pinned = pinLabel(pin);
    // (attack round 3, c) the revision covers everything the answer consents to, including each referenced release's
    // content (recipe hash, class, date, summary, adjust): a re-cut or another checkout's vN is a NEW notice.
    const content = cat.ok ? cat.releases.filter((r) => n.versions.includes(r.version) || r.version === n.to).map((r) => [r.version, r.hash, r.class, r.date, r.summary, r.adjust]) : [];
    return { id, projectId, pinned, observed: obsLabel, ...n, rev: revOf([projectId, n.state, pinned, obsLabel, n.to, n.versions, n.security, n.actions, pinRec?.deferred ?? null, pinRec?.hash ?? null, n.error, content]) };
  };
  if (!cat.ok) {
    if (inp.imageSource === 'custom') return null;
    return mk({ state: 'catalog-error', to: null, versions: [], security: false, securityDueSince: null, escalated: false, actions: [],
      message: `Orchard cannot read its base release list, so this project stays on ${pinLabel(pin)} and nothing is applied until it can.`, error: cat.error });
  }
  const newest = cat.newest.version;
  const skipped = new Set(pinRec?.skipped ?? []);
  if (inp.imageSource === 'custom') {
    if (skipped.has(newest)) return null;
    const sec = cat.releases.some((r) => r.class === 'security');
    return mk({ state: 'informational', to: newest, versions: [newest], security: cat.newest.class === 'security', securityDueSince: null, escalated: false, actions: ['dismiss'],
      message: `Orchard base v${newest} is available. This project runs a prebuilt image (container.image) that Orchard does not build, so Orchard cannot apply it${sec ? '; rebuild your image on a current base yourself' : ''}.`, error: null });
  }
  if (pin.kind === 'dev') return null; // dev tracks the working tree; nothing to offer
  const target = baseTarget(pin, cat, inp.observed);
  if (target.kind === 'recovery') {
    return mk({ state: 'recovery', to: newest, versions: [newest], security: false, securityDueSince: null, escalated: false, actions: ['adopt'],
      message: `This project's base pin needs a choice (${target.why}). It keeps running its current container and launches only into it; nothing is rebuilt until you adopt a release.`, error: null });
  }
  const level = levelOf(target)!;
  // 1. A security release is due and not yet running.
  // A security floor is in force and what runs is not proven at/above it (raised to the floor, or adopted at it).
  const obsAtFloor = inp.observed?.kind === 'version' && target.kind === 'version' && !!target.floor && inp.observed.version >= target.floor
    && releaseOf(cat, inp.observed.version)?.hash === (inp.observed.hash ?? releaseOf(cat, inp.observed.version)?.hash);
  if (target.kind === 'version' && (target.raisedBySecurity || (!!target.floor && !obsAtFloor)) && !observedMatches(inp.observed, target)) {
    const sec = releaseOf(cat, target.version)!;
    const since = new Date(`${sec.date}T00:00:00Z`);
    const escalated = now.getTime() - since.getTime() >= ESCALATE_DAYS * DAY_MS;
    const from = pin.kind === 'version' ? pin.version : 0;
    const versions = cat.releases.filter((r) => r.version > from && r.version <= newest).map((r) => r.version);
    return mk({
      state: inp.lastError ? 'apply-failed' : 'security-pending', to: target.version, versions, security: true,
      securityDueSince: since.toISOString(), escalated, actions: ['adopt', 'defer'],
      message: inp.lastError
        ? `SECURITY — v${target.version} could not be built (${inp.lastError}). New sessions in this project are refused until it builds; sessions already running are not touched.`
        : `SECURITY — v${target.version} is applied automatically at this project's next launch with no live session. It cannot be skipped${escalated ? `; it has been due since ${sec.date}` : ''}.`,
      error: inp.lastError,
    });
  }
  // 2. The desired pin moved (adopted) but the container does not run it yet.
  if (target.kind === 'version' && inp.observed && !observedMatches(inp.observed, target) && pin.kind === 'version') {
    return mk({ state: inp.lastError ? 'apply-failed' : 'adopted-pending', to: target.version, versions: [target.version], security: false, securityDueSince: null, escalated: false, actions: [],
      message: inp.lastError
        ? `Adopted v${target.version}, but applying it failed: ${inp.lastError}. The project keeps running ${obsLabel}.`
        : `Adopted v${target.version}. It applies at this project's next launch with no live session (or on Rebuild); until then the container stays on ${obsLabel}.`,
      error: inp.lastError });
  }
  // 3. Newer releases to offer.
  if (newest <= level) return null;
  if (skipped.has(newest)) return null;
  const d = pinRec?.deferred;
  if (d && d.version === newest && Date.parse(d.until) > now.getTime()) return null;
  const versions = cat.releases.filter((r) => r.version > level).map((r) => r.version);
  return mk({ state: 'offer', to: newest, versions, security: false, securityDueSince: null, escalated: false, actions: ['adopt', 'defer', 'skip'],
    message: `Orchard base v${newest} is available — this project is on ${pinLabel(pin)}. Adopt applies it at the next launch with no live session; Defer asks again in ${DEFER_DAYS} days; Skip ignores v${newest} (a later release asks again).`,
    error: null });
}

/* ----------------------------------------------------------------- actions */

export class BasePolicyError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 409) { super(message); this.name = 'BasePolicyError'; this.code = code; this.status = status; }
}

export interface ActionInput {
  action: NoticeAction | 'pin-dev';
  version?: number;
  actor: 'user' | 'agent';
  pinRaw: unknown;
  imageSource: 'station' | 'dockerfile' | 'custom';
  now: Date;
  catalog: Catalog;
  /** What the container runs now (attack round 1, c): an agent may not move below THAT either. */
  observed?: ObservedBase | null;
}

/**
 * Apply one base-update action to a pin and return the NEW pin to store, or
 * throw a BasePolicyError. Pure. The routes check the notice `rev` first; this
 * enforces the security floor and who may do what (finding 6):
 *   - Skip of a security release is refused for everyone;
 *   - Adopt below the security floor is refused;
 *   - an agent may not move a pin backwards, nor to `dev`;
 *   - `dismiss` exists only for prebuilt-image projects (informational notices).
 */
export function applyAction(inp: ActionInput): BasePin {
  const cat = inp.catalog;
  if (!cat.ok) throw new BasePolicyError('catalog-error', `the base release list cannot be read (${cat.error}); nothing can be changed until it can`, 503);
  const cur = basePinRecord(inp.pinRaw) ?? { pinned: undefined as unknown as PinValue, skipped: [], deferred: null };
  const pin = parsePin(inp.pinRaw);
  const newest = cat.newest.version;
  const v = inp.version ?? newest;
  if (!Number.isInteger(v) || !releaseOf(cat, v)) throw new BasePolicyError('unknown-version', `there is no base release v${inp.version}`, 400);
  const rel = releaseOf(cat, v)!;
  if (inp.imageSource === 'custom' && inp.action !== 'dismiss') {
    throw new BasePolicyError('prebuilt-image', 'this project runs a prebuilt image (container.image) that Orchard does not build; a base release cannot be adopted, deferred or skipped for it');
  }
  const floorFrom = pin.kind === 'version' ? pin.version : 0;
  const floor = pin.kind === 'dev' ? null : securityFloor(cat, floorFrom);
  switch (inp.action) {
    case 'dismiss': {
      if (inp.imageSource !== 'custom') throw new BasePolicyError('not-informational', 'only a prebuilt-image project\'s informational notice can be dismissed');
      // (attack round 2, c) the only notice telling the user to rebuild a prebuilt image on a security base is theirs to hide.
      if (inp.actor === 'agent' && cat.releases.some((r) => r.class === 'security' && r.version <= v && !cur.skipped.includes(r.version))) {
        throw new BasePolicyError('user-only', 'this notice includes a security release; only the user can dismiss it', 403);
      }
      return { ...cur, skipped: [...new Set([...cur.skipped, v])].sort((a, b) => a - b) };
    }
    case 'pin-dev': {
      if (inp.actor !== 'user') throw new BasePolicyError('user-only', 'only the user can move a project to the dev base (the working tree)', 403);
      return { pinned: 'dev', skipped: cur.skipped, deferred: null };
    }
    case 'adopt': {
      if (floor && v < floor) throw new BasePolicyError('below-security-floor', `v${v} is below security release v${floor}; adopt v${floor} or later`);
      if (inp.actor === 'agent' && pin.kind === 'version' && v < pin.version) throw new BasePolicyError('agent-downgrade', `an agent cannot move this project back from v${pin.version} to v${v}; ask the user`, 403);
      if (inp.actor === 'agent' && inp.observed?.kind === 'version' && v < inp.observed.version) throw new BasePolicyError('agent-downgrade', `this project's container runs v${inp.observed.version}; an agent cannot move it back to v${v}; ask the user`, 403);
      if (inp.actor === 'agent' && (pin.kind === 'missing' || pin.kind === 'invalid') && v !== newest) throw new BasePolicyError('agent-downgrade', `this project's pin needs a choice; an agent may only adopt the newest release (v${newest}); ask the user for another`, 403);
      if (inp.actor === 'agent' && pin.kind === 'dev') throw new BasePolicyError('user-only', 'this project tracks the dev base; only the user can move it', 403);
      return { pinned: v, hash: rel.hash, skipped: cur.skipped.filter((s) => s > v), deferred: null };
    }
    case 'defer': {
      const until = new Date(inp.now.getTime() + DEFER_DAYS * DAY_MS).toISOString();
      return { ...cur, deferred: { version: v, until } };
    }
    case 'skip': {
      if (rel.class === 'security') throw new BasePolicyError('security-not-skippable', `v${v} is a security release; it cannot be skipped. It is applied at this project's next launch with no live session`);
      if (floor && v <= floor) throw new BasePolicyError('security-not-skippable', `security release v${floor} is due; it cannot be skipped`);
      if (pin.kind === 'version' && v <= pin.version) throw new BasePolicyError('not-newer', `v${v} is not newer than this project's pin (v${pin.version})`);
      return { ...cur, skipped: [...new Set([...cur.skipped, v])].sort((a, b) => a - b), deferred: cur.deferred && cur.deferred.version === v ? null : cur.deferred };
    }
  }
  throw new BasePolicyError('unknown-action', `unknown base action ${JSON.stringify(inp.action)}`, 400);
}
