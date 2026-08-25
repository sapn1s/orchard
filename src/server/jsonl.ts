/**
 * Shared JSONL -> TranscriptMessage conversion.
 *
 * The main transcript route gets its messages from `session-history.readSession`
 * (carried-over, not modifiable). The tail reader and the subagent reader build
 * the same shape themselves, so that shape lives HERE rather than being written
 * twice and drifting — the UI renders all three with one renderer.
 */
import type { TranscriptBlock, TranscriptMessage } from '../lib/session-history.ts';

export interface BuildOptions {
  maxTextChars?: number;
  includeToolResults?: boolean;
}

/** Entry types that become messages. Mirrors readSession's own filter. */
export function isMessageEntry(e: Record<string, any>): boolean {
  return e?.type === 'user' || e?.type === 'assistant';
}

/**
 * readSession excludes sidechain (subagent) and meta entries from a main
 * transcript by default. Anything counting or tailing a MAIN transcript has to
 * apply the same rule or its totals will not agree with the paginated route.
 */
export function isMainThreadEntry(e: Record<string, any>, includeMeta = false): boolean {
  if (!isMessageEntry(e)) return false;
  if (includeMeta) return true;
  return e.isSidechain !== true && e.isMeta !== true;
}

function flatten(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (typeof c === 'string' ? c : c?.type === 'text' ? String(c.text ?? '') : `[${c?.type ?? 'block'}]`))
      .join('\n');
  }
  return JSON.stringify(content ?? null);
}

/** Serialize a tool input to a string the UI can JSON.parse. Never throws. */
function jsonString(input: unknown): string {
  if (input === undefined || input === null) return 'null';
  try {
    return JSON.stringify(input);
  } catch {
    // Circular / unserialisable input — still give the chip a name to show.
    return JSON.stringify(String(input));
  }
}

/** Blocks for one entry, or [] when nothing renderable survives the filters. */
export function blocksOf(e: Record<string, any>, opts: BuildOptions = {}): TranscriptBlock[] {
  const maxTextChars = Math.max(0, Math.floor(opts.maxTextChars ?? 4000));
  const includeToolResults = opts.includeToolResults === true;
  const clip = (s: string): { text: string; truncated?: boolean } =>
    s.length > maxTextChars ? { text: s.slice(0, maxTextChars), truncated: true } : { text: s };

  const blocks: TranscriptBlock[] = [];
  const content = e.message?.content;
  if (typeof content === 'string') {
    if (content.length) blocks.push({ type: 'text', ...clip(content) });
    return blocks;
  }
  if (!Array.isArray(content)) return blocks;
  for (const b of content as Record<string, any>[]) {
    if (b?.type === 'text') blocks.push({ type: 'text', ...clip(String(b.text ?? '')) });
    else if (b?.type === 'thinking' || b?.type === 'redacted_thinking') blocks.push({ type: 'thinking', ...clip(String(b.thinking ?? '')) });
    else if (b?.type === 'tool_use') {
      /*
       * `text` carries the JSON-serialised tool input. The UI parses it
       * (public/app.js: `JSON.parse(b.text)` → toolArg) to render the chip's
       * argument — "Bash: npm test", "Read ~/foo.ts". Without it every chip is
       * blank, which is the reported bug. One place, so tail / forward /
       * subagent / live-append all get it.
       */
      const serialized = jsonString(b.input);
      // A separate, LARGER cap than prose: an input clipped mid-JSON is
      // unparseable and the chip goes blank — worse than the wall of text the
      // maxTextChars prose cap guards against. 16 KiB holds any realistic Bash
      // command or file path whole; only pathological inputs (a huge inline
      // file body in Write) get truncated, and those are marked so.
      const cap = Math.max(maxTextChars, 16384);
      const t: TranscriptBlock = { type: 'tool_use', toolName: String(b.name ?? ''), toolUseId: String(b.id ?? '') };
      if (serialized.length > cap) {
        t.text = serialized.slice(0, cap);
        t.truncated = true;
      } else {
        t.text = serialized;
      }
      blocks.push(t);
    }
    else if (b?.type === 'tool_result') {
      if (!includeToolResults) continue;
      blocks.push({ type: 'tool_result', toolUseId: String(b.tool_use_id ?? ''), isError: b.is_error === true, ...clip(flatten(b.content)) });
    } else if (b?.type) blocks.push({ type: String(b.type) });
  }
  return blocks;
}

/** One entry as a TranscriptMessage. `index` is assigned by the caller. */
export function toMessage(e: Record<string, any>, index: number, blocks: TranscriptBlock[]): TranscriptMessage {
  return {
    index,
    uuid: typeof e.uuid === 'string' ? e.uuid : null,
    parentUuid: typeof e.parentUuid === 'string' ? e.parentUuid : null,
    role: e.type === 'assistant' ? 'assistant' : 'user',
    timestamp: typeof e.timestamp === 'string' ? e.timestamp : null,
    model: typeof e.message?.model === 'string' ? e.message.model : null,
    isMeta: e.isMeta === true,
    isCompactSummary: e.isCompactSummary === true,
    // BUG-028: only present when true, so the wire shape is unchanged for every
    // ordinary message. See TranscriptMessage's doc for what this flag proves.
    ...(e.interruptedByShutdown === true ? { interruptedByShutdown: true } : {}),
    blocks,
  };
}
