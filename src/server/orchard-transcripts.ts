/**
 * Orchard-owned transcript capture (FEAT-037 P2b).
 *
 * WHY: engines whose `capabilities.persistedTranscript` is FALSE (Codex) do not
 * write Claude's `~/.claude/projects/<encodedDir>/<sessionId>.jsonl` store —
 * the store every history feature (transcript routes, tail/forward paging,
 * session lists, live-follow, resume vetting) is built on. Rather than teaching
 * every reader a second format, the BRIDGE writes an Orchard-owned transcript
 * in the SAME entry shape (`{type:'user'|'assistant', message:{content:[…]}}`,
 * the one `jsonl.ts#toMessage` consumes), laid out the SAME way under our own
 * root:
 *
 *     dataDir()/transcripts/<provider>/<encodedDir>/<sessionId>.jsonl
 *
 * Mirroring the store layout is the whole trick: `session-history`'s functions
 * all take a `{ root }` option, so listing/resolving/live-detection reuse the
 * exact code paths the Claude store uses — one coordinate system, zero forked
 * readers. `<sessionId>` is the engine's own resume handle (the Codex thread
 * id from `system:init`), so a file's NAME is exactly what `thread/resume`
 * needs later.
 *
 * Append-only by construction: every write is an `fs.appendFileSync` of one
 * JSONL line; nothing here ever truncates or rewrites. Durable across
 * restarts because it is just a file under dataDir.
 *
 * HONEST LIMITS (documented, not hidden):
 *  - The recorder lives in the server process. If the server dies mid-turn,
 *    output produced after death is not captured — which is precisely why
 *    FEAT-015 survival stays gated OFF for persistedTranscript:false engines
 *    (see agent-bridge's survival comment): a surviving CLI would keep
 *    working with nobody recording, and the history would silently lie.
 *  - Search (`rg` over the Claude store) and rename/tag/delete target the
 *    Claude store only; Orchard transcripts are readable history + resume
 *    handles first. Extending those is additive follow-up work.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import * as hist from '../lib/session-history.ts';
import { dataDir } from '../lib/paths.ts';

/** Root of all Orchard-owned transcripts. */
export function orchardTranscriptsRoot(): string {
  return path.join(dataDir(), 'transcripts');
}

/** Provider sub-roots that exist on disk (e.g. [{provider:'openai', root:…}]). */
export function providerRoots(): { provider: string; root: string }[] {
  const root = orchardTranscriptsRoot();
  let names: string[];
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return []; // no captures yet — not an error
  }
  return names
    .filter((n) => /^[a-z0-9-]+$/.test(n))
    .map((provider) => ({ provider, root: path.join(root, provider) }));
}

/** Absolute path an Orchard transcript lives (or would live) at. */
export function orchardTranscriptFile(provider: string, encodedDir: string, sessionId: string): string {
  return path.join(orchardTranscriptsRoot(), provider, encodedDir, `${sessionId}.jsonl`);
}

/**
 * Resolve a session id to an existing Orchard transcript. Same path-safety
 * rules as the Claude store (delegates to `hist.resolveSessionFile`).
 */
export function resolveOrchardSessionFile(
  encodedDir: string,
  sessionId: string,
): { filePath: string; provider: string } | null {
  for (const { provider, root } of providerRoots()) {
    const filePath = hist.resolveSessionFile(encodedDir, sessionId, { root });
    if (filePath) return { filePath, provider };
  }
  return null;
}

export type OrchardSessionMeta = hist.SessionMeta & { provider: string };

/**
 * All Orchard-owned sessions recorded under one encoded dir, newest first —
 * `hist.listSessions` pointed at each provider root, so the metadata (title,
 * counts, timestamps, models) comes from the very same reader the Claude
 * store uses.
 */
export function listOrchardSessions(encodedDir: string): OrchardSessionMeta[] {
  const out: OrchardSessionMeta[] = [];
  for (const { provider, root } of providerRoots()) {
    let metas: hist.SessionMeta[];
    try {
      metas = hist.listSessions(encodedDir, { root });
    } catch {
      continue; // dir absent under this provider — nothing recorded there
    }
    for (const m of metas) out.push({ ...m, provider });
  }
  out.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
  return out;
}

/* ----------------------------------------------------------- the recorder */

export interface RecorderOptions {
  /** Provider key — becomes the directory name (e.g. 'openai'). */
  provider: string;
  /** The session's cwd; encoded exactly like Claude's store keys its dirs. */
  cwd: string;
  /** Non-fatal problem channel (append failure etc.) — reported ONCE. */
  onError?: (message: string) => void;
}

interface PendingEntry {
  type: 'user' | 'assistant';
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  message: Record<string, unknown>;
}

/**
 * Per-session append-only writer. Entries recorded before the engine reports
 * its session/thread id (`system:init`) are buffered and flushed the moment
 * `adoptSessionId` names the file; a session that never inits leaves no file,
 * which matches "no session happened".
 */
export class TranscriptRecorder {
  readonly provider: string;
  readonly cwd: string;
  readonly encodedDir: string;
  #sessionId: string | null = null;
  #file: string | null = null;
  #buffer: PendingEntry[] = [];
  #lastUuid: string | null = null;
  #model: string | null = null;
  #failed = false;
  #onError: (message: string) => void;

  constructor(opts: RecorderOptions) {
    this.provider = opts.provider;
    this.cwd = opts.cwd;
    this.encodedDir = hist.encodeCwd(opts.cwd);
    this.#onError = opts.onError ?? ((m) => console.warn(`[orchard-transcript] ${m}`));
  }

  get filePath(): string | null {
    return this.#file;
  }

  /** Model string for assistant entries (from `system:init` / model-observed). */
  setModel(model: string | null): void {
    if (model && !model.startsWith('<')) this.#model = model;
  }

  /**
   * Name the file. Known up-front on resume (same thread id → the SAME file
   * simply continues — append-only across sessions), or on `system:init` for
   * a fresh thread. Idempotent for the same id.
   */
  adoptSessionId(sessionId: string): void {
    if (this.#failed || !sessionId || sessionId === this.#sessionId) return;
    if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) {
      this.#fail(`refusing to record: engine session id ${JSON.stringify(sessionId)} is not filename-safe`);
      return;
    }
    this.#sessionId = sessionId;
    this.#file = orchardTranscriptFile(this.provider, this.encodedDir, sessionId);
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    } catch (err) {
      this.#fail(`cannot create transcript dir: ${(err as Error).message}`);
      return;
    }
    const pending = this.#buffer.splice(0);
    for (const e of pending) this.#write(e);
  }

  /** A prompt the user (or the autonomous nudge) sent INTO the engine. */
  recordUserPrompt(text: string): void {
    this.#push('user', { role: 'user', content: [{ type: 'text', text }] });
  }

  /**
   * An inbound RuntimeMessage (the Claude-SDK-shaped dialect `#handle`
   * consumes). Only main-thread `assistant`/`user` frames carry renderable
   * content; deltas/results are transient and deliberately not recorded, so
   * the file's population is exactly the "renderable" canonical space the
   * transcript routes count.
   */
  recordRuntimeMessage(m: Record<string, any>): void {
    if (m.type !== 'assistant' && m.type !== 'user') return;
    if (m.parent_tool_use_id != null) return; // sidechain — none expected (subagents:false)
    const content = m.message?.content;
    if (!Array.isArray(content) || content.length === 0) return;
    const message: Record<string, unknown> =
      m.type === 'assistant'
        ? { role: 'assistant', ...(this.#model ? { model: this.#model } : {}), content }
        : { role: 'user', content };
    this.#push(m.type, message);
  }

  #push(type: 'user' | 'assistant', message: Record<string, unknown>): void {
    if (this.#failed) return;
    const entry: PendingEntry = {
      type,
      uuid: randomUUID(),
      parentUuid: this.#lastUuid,
      timestamp: new Date().toISOString(),
      message,
    };
    this.#lastUuid = entry.uuid;
    if (!this.#file) {
      this.#buffer.push(entry);
      return;
    }
    this.#write(entry);
  }

  #write(e: PendingEntry): void {
    if (this.#failed || !this.#file || !this.#sessionId) return;
    // Claude-store entry shape + a self-describing `provider` field (ignored
    // by every existing reader; lets a file name its engine without relying
    // on its directory).
    const line = JSON.stringify({
      type: e.type,
      uuid: e.uuid,
      parentUuid: e.parentUuid,
      timestamp: e.timestamp,
      sessionId: this.#sessionId,
      cwd: this.cwd,
      provider: this.provider,
      message: e.message,
    });
    try {
      fs.appendFileSync(this.#file, line + '\n');
    } catch (err) {
      this.#fail(`transcript append failed at ${this.#file}: ${(err as Error).message}`);
    }
  }

  #fail(message: string): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#buffer = [];
    this.#onError(
      `Orchard-owned transcript capture stopped for this session — ${message}. ` +
        'The session keeps running; its history will be missing from the sidebar.',
    );
  }
}
