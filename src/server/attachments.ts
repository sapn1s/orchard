/**
 * FEAT-177 — THE ONE OWNER OF THE ATTACHMENT FACT.
 *
 * Every fact a reader has to act on about an attachment — what types are
 * allowed, how big it may be, where its bytes live, what its media type is,
 * and how it becomes a provider content block — is declared HERE and read
 * everywhere else (ARCH-010). No other module sniffs a media type, derives a
 * storage path, or inflates base64; they call this file.
 *
 * TRANSPORT (plan + OpenAI review 01a134fe). Bytes are uploaded once over HTTP
 * (`POST /api/uploads`), stored in a content-addressed blob store keyed by the
 * sha256 of the bytes, and from then on only a REFERENCE (`AttachmentRef`)
 * rides the WS send/start frame, the durable outbox row, and the transcript.
 * The raw bytes are re-inflated to a base64 content block at ONE place —
 * `contentBlocksFor`, called at CLI-delivery time. base64 never enters the
 * durable ledger or Orchard's own transcript store.
 *
 * SECURITY (review findings #1, #7, #8 — all accepted):
 *  - The server OWNS the media type, byte count and storage location. The
 *    client `AttachmentRef` carries a display `name` and nothing authoritative;
 *    every read re-derives media type and size from the stored bytes and
 *    verifies the bytes hash to the id (`loadBlob`), so a tampered or crossed
 *    reference fails closed rather than delivering the wrong bytes.
 *  - The storage path has NO client-controlled component: `<dataDir>/uploads/
 *    <projectId>/<sha256>` — projectId is validated against a strict id grammar,
 *    the id is 64 lowercase hex, there is no extension, and every resolved path
 *    is checked to sit inside the uploads root (no `..`, no symlink escape).
 *  - Media type is decided by sniffing the bytes (magic numbers / UTF-8 text
 *    probe), NOT by the client's `Content-Type` or filename, so an HTML file
 *    cannot masquerade as a PNG.
 *  - Size caps are enforced on the decoded bytes, server-side, before the blob
 *    is committed. The HTTP route caps the request body before buffering it.
 *
 * SINGLE USER (index.ts header): Orchard is 127.0.0.1-only with no auth tier.
 * "Ownership" here is PROJECT scoping: a session's project id is read from
 * authoritative server state and the blob is resolved only within THAT
 * project's store, so a `send` frame cannot reference another project's bytes.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dataDir } from '../lib/paths.ts';

export type AttachmentKind = 'image' | 'document' | 'text';

/** The durable reference. Only `uploadId`/`projectId` are load-bearing; the rest is display metadata re-derived on read. */
export interface AttachmentRef {
  /** The sha256 of the bytes, lowercase hex. Doubles as the storage filename. */
  uploadId: string;
  /** The project whose store holds the bytes. */
  projectId: string;
  /** Server-sniffed media type (display + render hint; re-derived authoritatively on every read). */
  mediaType: string;
  kind: AttachmentKind;
  /** Client-supplied display name. Sanitised; NEVER used to build a path. */
  name: string;
  /** Server-measured byte count. */
  bytes: number;
}

export class AttachmentError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

/** Raised when a message carries an attachment a target provider cannot receive. Loud, never a silent drop. */
export class AttachmentUnsupportedError extends AttachmentError {
  constructor(message: string) { super(message, 415); }
}

/* --------------------------------------------------------------- limits */

/** Per-item decoded-byte cap. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** Per-message aggregate decoded-byte cap (bounds inflation memory: review #7). */
export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
/** Per-message attachment count cap. */
export const MAX_ATTACHMENTS = 20;

/* ------------------------------------------------------------- allowlist */

/** Claude-supported image media types (the only image set delivered as vision input). */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** Document media types delivered as a `document` block (Claude only). */
const DOC_TYPES = new Set(['application/pdf']);

/** Sniff the authoritative media type from the bytes. Returns null for anything not on the allowlist. */
export function sniffMediaType(bytes: Buffer): { mediaType: string; kind: AttachmentKind } | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return { mediaType: 'image/png', kind: 'image' };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mediaType: 'image/jpeg', kind: 'image' };
  }
  if (bytes.length >= 6 && (bytes.toString('ascii', 0, 6) === 'GIF87a' || bytes.toString('ascii', 0, 6) === 'GIF89a')) {
    return { mediaType: 'image/gif', kind: 'image' };
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return { mediaType: 'image/webp', kind: 'image' };
  }
  if (bytes.length >= 5 && bytes.toString('ascii', 0, 5) === '%PDF-') {
    return { mediaType: 'application/pdf', kind: 'document' };
  }
  if (looksLikeText(bytes)) return { mediaType: 'text/plain', kind: 'text' };
  return null;
}

/** A conservative UTF-8 text probe: no NUL bytes and valid UTF-8 (review #8 — validate bytes, not File.type). */
function looksLikeText(bytes: Buffer): boolean {
  if (bytes.length === 0) return false;
  // A single NUL is enough to call it binary.
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0) return false;
  // Round-trip through strict UTF-8 decode; a replacement char means it was not valid UTF-8.
  try {
    const dec = new TextDecoder('utf-8', { fatal: true });
    dec.decode(bytes);
    return true;
  } catch { return false; }
}

export function mediaTypeAllowed(mediaType: string): boolean {
  return IMAGE_TYPES.has(mediaType) || DOC_TYPES.has(mediaType) || mediaType === 'text/plain';
}

/* ------------------------------------------------------------ id / paths */

const PROJECT_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export function validProjectId(id: unknown): id is string {
  return typeof id === 'string' && PROJECT_ID_RE.test(id) && !id.includes('..');
}
export function validUploadId(id: unknown): id is string {
  return typeof id === 'string' && SHA256_RE.test(id);
}

function uploadsRoot(): string { return path.join(dataDir(), 'uploads'); }
function projectDir(projectId: string): string { return path.join(uploadsRoot(), projectId); }

/** Resolve a blob path and PROVE it sits inside the uploads root (review #8 — no path escape). */
function blobPath(projectId: string, uploadId: string): string {
  if (!validProjectId(projectId)) throw new AttachmentError('bad project id for attachment', 400);
  if (!validUploadId(uploadId)) throw new AttachmentError('bad attachment id', 400);
  const dir = projectDir(projectId);
  const file = path.join(dir, uploadId);
  const root = path.resolve(uploadsRoot());
  const resolved = path.resolve(file);
  if (resolved !== path.join(path.resolve(dir), uploadId) || !(resolved + '').startsWith(root + path.sep)) {
    throw new AttachmentError('attachment path escapes the uploads store', 400);
  }
  return resolved;
}

function fsyncDir(dir: string): void {
  let fd: number | null = null;
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); } catch { /* not every fs allows a dir fsync */ } finally { if (fd != null) { try { fs.closeSync(fd); } catch { /* ignore */ } } }
}

/** Sanitise a client filename down to a display-only string (never a path component). */
function displayName(name: unknown): string {
  if (typeof name !== 'string' || !name) return 'attachment';
  // Strip any path separators and control chars; keep the basename.
  const base = name.replace(/[/\\]/g, '_').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return base.slice(0, 200) || 'attachment';
}

/* ------------------------------------------------------------- storing */

/**
 * Validate and store bytes, atomically. Content-addressed: the same bytes map
 * to the same blob, so re-uploading is idempotent and removing one chip never
 * invalidates another message's reference (review #6 — no eager deletion; the
 * blob is shared and retained). Throws `AttachmentError` for oversize /
 * unsupported — the caller surfaces it loudly.
 */
export function storeUpload(projectId: string, bytes: Buffer, opts: { name?: string } = {}): AttachmentRef {
  if (!validProjectId(projectId)) throw new AttachmentError('bad project id for attachment', 400);
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new AttachmentError('empty attachment', 400);
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError(`attachment is ${(bytes.length / 1048576).toFixed(1)} MB — the limit is ${MAX_ATTACHMENT_BYTES / 1048576} MB per file`, 413);
  }
  const sniff = sniffMediaType(bytes);
  if (!sniff) throw new AttachmentError('unsupported file type — allowed: PNG, JPEG, GIF, WebP images, PDF, and UTF-8 text files', 415);
  const uploadId = crypto.createHash('sha256').update(bytes).digest('hex');
  const dir = projectDir(projectId);
  fs.mkdirSync(dir, { recursive: true });
  const file = blobPath(projectId, uploadId);
  if (!fs.existsSync(file)) {
    // Atomic commit: write a tmp in the same dir, fsync the bytes, rename into place, fsync the dir (review #6).
    const tmp = path.join(dir, `.tmp-${crypto.randomBytes(8).toString('hex')}`);
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    try {
      fs.renameSync(tmp, file);
      fsyncDir(dir);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* best effort */ }
      throw err;
    }
  }
  return { uploadId, projectId, mediaType: sniff.mediaType, kind: sniff.kind, name: displayName(opts.name), bytes: bytes.length };
}

/**
 * Read the bytes of a stored blob and re-derive its authoritative media type.
 * Fails closed if the blob is missing, does not hash to its id (corruption /
 * tamper), or no longer sniffs to an allowed type. NEVER trusts a client ref.
 */
export function loadBlob(projectId: string, uploadId: string): { bytes: Buffer; mediaType: string; kind: AttachmentKind } {
  const file = blobPath(projectId, uploadId);
  let bytes: Buffer;
  try { bytes = fs.readFileSync(file); } catch {
    throw new AttachmentError(`an attachment this message needs (${uploadId.slice(0, 12)}…) is missing from the store — it was not sent`, 410);
  }
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actual !== uploadId) throw new AttachmentError('a stored attachment does not match its content hash — refusing to send it', 500);
  const sniff = sniffMediaType(bytes);
  if (!sniff) throw new AttachmentError('a stored attachment is no longer a supported type — refusing to send it', 415);
  return { bytes, mediaType: sniff.mediaType, kind: sniff.kind };
}

/**
 * Resolve a list of client references against the store, returning NORMALISED
 * refs whose media type / kind / byte count are the server's own (not the
 * client's). Enforces the count and aggregate-size caps. Throws if any blob is
 * missing — so a message with a lost attachment fails loudly, never text-only.
 */
export function resolveRefs(projectId: string, refs: unknown): AttachmentRef[] {
  if (refs == null) return [];
  if (!Array.isArray(refs)) throw new AttachmentError('attachments must be a list', 400);
  if (refs.length === 0) return [];
  if (refs.length > MAX_ATTACHMENTS) throw new AttachmentError(`too many attachments (${refs.length}); the limit is ${MAX_ATTACHMENTS}`, 413);
  const out: AttachmentRef[] = [];
  let total = 0;
  for (const raw of refs) {
    const r = raw as Partial<AttachmentRef>;
    if (!r || !validUploadId(r.uploadId)) throw new AttachmentError('an attachment reference is malformed', 400);
    const blob = loadBlob(projectId, r.uploadId);
    total += blob.bytes.length;
    if (total > MAX_MESSAGE_BYTES) throw new AttachmentError(`the attachments total more than ${MAX_MESSAGE_BYTES / 1048576} MB`, 413);
    out.push({ uploadId: r.uploadId, projectId, mediaType: blob.mediaType, kind: blob.kind, name: displayName(r.name), bytes: blob.bytes.length });
  }
  return out;
}

/** True if any attachment can only be delivered as vision/document (an image-incapable provider must refuse the message). */
export function needsImageCapability(refs: AttachmentRef[]): boolean {
  return refs.some((r) => r.kind === 'image' || r.kind === 'document');
}

/** A stable, ordered identity for the attachment set — folded into the outbox idempotency fingerprint (review #4). */
export function attachmentManifest(refs: AttachmentRef[] | undefined): string {
  if (!refs || refs.length === 0) return '';
  return JSON.stringify(refs.map((r) => [r.uploadId, r.bytes]));
}

/* ----------------------------------------------------- delivery blocks */

/**
 * THE ONE PLACE base64 is produced. Build the provider `message.content` block
 * array for a user turn carrying attachments, re-inflating each blob from the
 * store. Returns `null` when there are no attachments, so the caller keeps the
 * byte-for-byte bare-string text path (text-only sends are unchanged).
 *
 * Throws `AttachmentUnsupportedError` if the message carries an image/document
 * and the target provider cannot receive it — the whole message is rejected,
 * never silently sent text-only (review #2).
 */
export function contentBlocksFor(
  text: string,
  refs: AttachmentRef[] | undefined,
  opts: { imageAttachments: boolean; providerLabel?: string },
): Array<Record<string, unknown>> | null {
  if (!refs || refs.length === 0) return null;
  if (needsImageCapability(refs) && !opts.imageAttachments) {
    const label = opts.providerLabel ?? 'this provider';
    throw new AttachmentUnsupportedError(
      `This session runs on ${label}, which can't receive images or PDFs yet — remove the image attachment or switch the session to a Claude provider. (Text files can be attached to any provider.)`,
    );
  }
  const blocks: Array<Record<string, unknown>> = [];
  if (text && text.trim()) blocks.push({ type: 'text', text });
  for (const r of refs) {
    const blob = loadBlob(r.projectId, r.uploadId);
    if (blob.kind === 'image') {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: blob.mediaType, data: blob.bytes.toString('base64') } });
    } else if (blob.kind === 'document') {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: blob.mediaType, data: blob.bytes.toString('base64') }, title: r.name });
    } else {
      // Text/code: inline as a text block (works for EVERY provider, Claude and codex alike).
      blocks.push({ type: 'text', text: `\n\n[attached file: ${r.name}]\n${blob.bytes.toString('utf8')}` });
    }
  }
  return blocks;
}
